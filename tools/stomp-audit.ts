// STOMP track audit: what every track of a level's sequences drives and what it expects.
//
// Usage: npx tsx tools/stomp-audit.ts "<path to .lvl>" [--seq <name substring>] [--keys]
//                                     [--json <out.json>] [--actual <sampled.json>]
//
// For each STOMP Player of the level: its sequence, and per track the target object (class,
// template, model, how the runtime renders it: actor / puppet / camera / dynamic / logic),
// key counts by type, and the EXPECTED state at key times (pose, clip + once/loop + clip
// label, visibility, messages, control, attach). With --keys every key is printed.
//
// Indirect targets: objects a sequence reaches through its message keys via Message Relays,
// Visibility Togglers and Timers (1a "Goose": the inmates' corpse doubles and the stabbed
// inmate on his bed are shown by the "Turn All Lights On" relay). For each: the effect (shown,
// hidden, killed, destroyed) with its time, and for characters the pose they should show once
// visible (the clip of their start behaviour: idle / dormant pose or corpse death clip).
//
// --json writes the expectations ({ tracks: one row per track and sample time, indirect }) for
// a browser run (see tools/stomp-sample.mjs) that records the ACTUAL state at the same times
// through window.__stomp.probe(), and again a few seconds after each sequence ended
// (__stomp.snapshot); --actual diffs such a recording against the expectations and prints
// every discrepant track (position error, wrong / missing clip, visibility, unhandled
// messages, indirect targets in the wrong state or pose, end state not kept after the
// sequence). Game data is read at runtime; nothing of it is stored in the repo.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SrscFile } from '../src/formats/srsc';
import { readDbId, readModel } from '../src/formats/model';
import { guessClipLabel, readAnimation, sampleTrackRotation, sampleTrackTranslation, type AnimClipData } from '../src/formats/animation';
import { classByHash, messageName, parseEntities, indexEntities, type Entity, type EntityPackage } from '../src/formats/entities';
import { BehaviorLibrary, CHAR, templateProp } from '../src/game/actors/behaviors';
import { parseStompSequence, sampleTrack, keyIndexAt, rootMotionModes, TRACK_REMOVE_AT_END, XF_LINEAR, XF_SPLINE, type StompSequence, type StompTrack } from '../src/game/world/stomp';
import { dynamicObjectUids } from '../src/game/world/dynamic';
import { hasSkeleton } from '../src/formats/skeleton';
import { sequencePropCandidate } from '../src/game/sequence/props';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const lvlPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--keys'));
if (!lvlPath || !existsSync(lvlPath)) {
  console.error('usage: npx tsx tools/stomp-audit.ts "<path to .lvl>" [--seq name] [--keys] [--json out] [--actual sampled.json]');
  process.exit(1);
}

let root = dirname(lvlPath);
while (root !== dirname(root) && !existsSync(join(root, 'LEVELS'))) root = dirname(root);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.db')) out.push(p);
  }
  return out;
}
const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer) : undefined);
const packages = new Map<number, EntityPackage & { adu?: SrscFile }>();
for (const db of walk(root)) {
  const id = readDbId(readFileSync(db, 'latin1'));
  if (id === undefined || packages.has(id)) continue;
  const base = db.slice(0, -3);
  packages.set(id, { id, name: basename(base), odu: load(base + '.odu'), xdu: load(base + '.xdu'), qdu: load(base + '.qdu'), adu: load(base + '.adu'), mdu: load(base + '.mdu') });
}
const lvl = load(lvlPath)!;
const ents = parseEntities(lvl, packages);
const dynamic = dynamicObjectUids(lvl, packages);
const byUid = indexEntities(ents);
const U = 2048;

const clipCache = new Map<string, AnimClipData | null>();
const clip = (pkg: number, id: number) => {
  const k = `${pkg}:${id}`;
  if (!clipCache.has(k)) {
    const f = packages.get(pkg)?.adu;
    clipCache.set(k, (f && readAnimation(f, id)) || null);
  }
  return clipCache.get(k) ?? undefined;
};

/**
 * How the runtime presents a track's object (mirrors actors/manager.ts and the world system's
 * dynamicObjectUids): puppet (Player), camera, actor (characters, Animating Statics), dynamic
 * (posed / shown by the world system), skinned (a skinned model nobody renders: a gap), logic
 * (no model drawn: logic objects, effect emitters, editor proxies).
 */
function role(e: Entity | undefined): string {
  if (!e) return 'missing';
  if (e.className === 'Player') return 'puppet';
  if (e.className === 'Camera') return 'camera';
  if (e.family === 'Character' || e.className === 'Animating Static') return 'actor';
  if (dynamic.has(e.uid)) return 'dynamic';
  const m = e.modelRef;
  // Shown by the sequence presenter (src/game/sequence/props.ts).
  if (m && sequencePropCandidate(e.className, e.flags, m.pkg) && hasSkeleton(packages.get(m.pkg)?.mdu, m.id)) return 'skinned';
  return 'logic';
}

/** " - model p:i does not decode" when the object's static model fails to load (format gap). */
const undecodable = (uid: number) => {
  const m = byUid.get(uid)?.modelRef;
  let ok = false;
  try {
    ok = !!m && !!readModel(packages, m);
  } catch {
    ok = false;
  }
  return m && !ok && role(byUid.get(uid)) === 'dynamic' ? ` - its model ${m.pkg}:${m.id} does not decode` : '';
};

const f2 = (x: number) => x.toFixed(2);
const pos = (p: readonly number[]) => `(${p.map((x) => f2(x / U)).join(', ')})`;
/** Yaw (deg) of an object rotation: model -Z forward. */
const yaw = (q: readonly number[]) => {
  const [x, y, z, w] = q;
  const fx = -(2 * (x * z + w * y)), fz = -(1 - 2 * (x * x + y * y));
  return Math.round((Math.atan2(-fx, -fz) * 180) / Math.PI);
};
type Quat = [number, number, number, number];
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (a: Quat): Quat => [-a[0], -a[1], -a[2], a[3]];
/** Vector v turned by unit quaternion q. */
const qrot = (q: Quat, v: readonly number[]): number[] => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q));
  return [r[0], r[1], r[2]];
};
/** Tilt from upright (deg): angle between the model up axis and world up. */
const tilt = (q: readonly number[]) => {
  const [x, , z] = q;
  const uy = 1 - 2 * (x * x + z * z);
  return Math.round((Math.acos(Math.max(-1, Math.min(1, uy))) * 180) / Math.PI);
};

export interface Expectation {
  seq: string;
  track: string;
  index: number;
  uid: number;
  cls: string;
  role: string;
  t: number;
  /** Metres. */
  position?: [number, number, number];
  yaw?: number;
  tilt?: number;
  /** Channel-0 clip "pkg:id" expected playing, with its local time and whether it holds. */
  clip?: string;
  clipTime?: number;
  clipOnce?: boolean;
  visible?: boolean;
  scripted?: boolean;
  /** A Destroy key reached the object (characters are removed, props hidden). */
  destroyed?: boolean;
  /** Attached to a carrier's hardpoint (its world pose follows the carrier). */
  attachedTo?: string;
  messages: string[];
}

const DESTROY = 12;

/** The state a track's object should show at sequence time `time`. */
function expectAt(name: string, seq: StompSequence, t: StompTrack, time: number): Expectation {
  const e = byUid.get(t.uid);
  const x: Expectation = { seq: name, track: t.name, index: t.index, uid: t.uid, cls: e?.className ?? '?', role: role(e), t: time, messages: [] };
  const p = sampleTrack(t, time);
  if (p) {
    x.position = p.position.map((v) => v / U) as [number, number, number];
    x.yaw = yaw(p.quat);
    x.tilt = tilt(p.quat);
  }
  const anims0 = t.anims.filter((a) => a.channel === 0);
  if (p && x.position) {
    // Root motion extracted to the object (mode-1 axes of channel-0 keys; docs/re/animation.md
    // §4): while no transform key re-poses the object (a held / step segment) it moves by the
    // clip root translation of every key since the last transform key.
    const xi = keyIndexAt(t.transforms, time);
    const next = t.transforms[xi + 1];
    const moving = !!next && !!(next.flags & (XF_LINEAR | XF_SPLINE)) && next.time - t.transforms[xi].time >= 1e-3;
    const since = t.transforms[xi]?.time ?? -Infinity;
    // Accumulated in the object's frame at the transform key: each key's root translation is
    // turned by the rotation the earlier keys extracted (rotation mode 1), as the presenter does.
    const w = [0, 0, 0];
    let q: Quat = [p.quat[0], p.quat[1], p.quat[2], p.quat[3]];
    let turned = false;
    if (!moving) {
      anims0.forEach((ak, k) => {
        const end = Math.min(time, anims0[k + 1]?.time ?? Infinity);
        const start = Math.max(ak.time, since);
        if (ak.time > time || end <= start) return;
        const m = rootMotionModes(ak.flags);
        const c = clip(ak.clip.pkg, ak.clip.id);
        if (!c || !(m.x === 1 || m.y === 1 || m.z === 1 || m.rotation === 1)) return;
        const d = Math.max(c.duration, 1e-3), once = !!(c.flags & 1);
        const ctOf = (tt: number) => ak.offset + (tt - ak.time) * ak.speed * (c.rate || 1);
        const cum = (tt: number) => {
          const ct = ctOf(tt);
          if (once) return sampleTrackTranslation(c, Math.min(Math.max(0, ct), d));
          const n = Math.floor(ct / d), r = sampleTrackTranslation(c, ct - n * d);
          const a0 = sampleTrackTranslation(c, 0), a1 = sampleTrackTranslation(c, d);
          return r.map((w, i) => w + n * (a1[i] - a0[i]));
        };
        const rotAt = (tt: number): Quat => {
          const ct = ctOf(tt);
          if (once) return sampleTrackRotation(c, Math.min(Math.max(0, ct), d));
          const n = Math.floor(ct / d);
          let r: Quat = sampleTrackRotation(c, ct - n * d);
          const wrap = qmul(sampleTrackRotation(c, d), qinv(sampleTrackRotation(c, 0)));
          for (let i = 0; i < Math.min(Math.abs(n), 64); i++) r = qmul(n > 0 ? wrap : qinv(wrap), r);
          return r;
        };
        const a = cum(start), b = cum(end);
        const v: [number, number, number] = [m.x === 1 ? b[0] - a[0] : 0, m.y === 1 ? b[1] - a[1] : 0, m.z === 1 ? b[2] - a[2] : 0];
        const r = qrot(q, v);
        for (let i = 0; i < 3; i++) w[i] += r[i];
        if (m.rotation === 1) {
          q = qmul(q, qmul(rotAt(end), qinv(rotAt(start))));
          turned = true;
        }
      });
    }
    if (w.some(Boolean)) {
      const sc = byUid.get(t.uid)?.scale?.[0] ?? 1;
      x.position = x.position.map((pv, i) => pv + w[i] * sc) as [number, number, number];
    }
    if (turned) {
      x.yaw = yaw(q);
      x.tilt = tilt(q);
    }
  }
  const ai = keyIndexAt(anims0, time);
  if (ai >= 0) {
    const a = anims0[ai];
    const c = clip(a.clip.pkg, a.clip.id);
    x.clip = `${a.clip.pkg}:${a.clip.id}`;
    x.clipOnce = c ? !!(c.flags & 1) : undefined;
    let ct = a.offset + (time - a.time) * a.speed * (c?.rate || 1);
    if (c) ct = x.clipOnce ? Math.min(ct, c.duration) : ct % Math.max(c.duration, 1e-3);
    x.clipTime = +ct.toFixed(2);
  }
  const vi = keyIndexAt(t.visibility, time);
  if (vi >= 0) x.visible = t.visibility[vi].visible;
  const ci = keyIndexAt(t.controls, time);
  if (ci >= 0) x.scripted = !t.controls[ci].release;
  const sent = t.messages.filter((m) => m.time <= time);
  x.messages = sent.map((m) => messageName(m.message));
  x.destroyed = sent.some((m) => m.message === DESTROY);
  // Attach keys of other tracks naming this one (latest per carrier hardpoint wins).
  for (const c of seq.tracks) {
    for (const k of c.attaches) {
      if (k.time > time) continue;
      if (k.track === t.index) x.attachedTo = `${c.name}@hp${k.hardpoint}`;
      else if (!k.track && x.attachedTo === `${c.name}@hp${k.hardpoint}`) x.attachedTo = undefined;
    }
  }
  return x;
}

function expectations(name: string, seq: StompSequence): Expectation[] {
  const out: Expectation[] = [];
  for (const t of seq.tracks) {
    const times = new Set<number>();
    for (const k of [...t.transforms, ...t.anims, ...t.visibility, ...t.messages, ...t.controls, ...t.attaches]) times.add(+Math.min(k.time + 0.25, seq.duration).toFixed(2));
    times.add(+seq.duration.toFixed(2));
    for (const time of [...times].sort((a, b) => a - b)) out.push(expectAt(name, seq, t, time));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Indirect targets

export interface Indirect {
  seq: string;
  uid: number;
  cls: string;
  role: string;
  /** Sequence time of the effect. */
  t: number;
  effect: 'show' | 'hide' | 'toggle' | 'kill' | 'destroy';
  /** Message path from the track's key (for the report). */
  via: string;
  /** Characters: clips ("<set>/<id>") one of which should show while visible and alive. */
  poses?: string[];
  /** Characters placed as corpses (start behaviour DeathBehavior). */
  corpse?: boolean;
}

const behaviors = new BehaviorLibrary(packages, byUid);
const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const outMessage = (e: Entity, name: string) => e.outputs.find((o) => o.name === name)?.message ?? 0;
const clipKey = (r: { pkg: number; id: number } | undefined) => {
  const c = r && clip(r.pkg, r.id);
  return c ? `${c.animSet}/${c.id}` : undefined;
};

/** Pose a character shows at rest once visible: its start behaviour's clip (actors/manager.ts initBehavior). */
function restPose(e: Entity): { poses: string[]; corpse: boolean } | undefined {
  if (e.family !== 'Character') return undefined;
  const types = classByHash(e.classHash)?.types ?? [];
  const initial = behaviors.fromTemplate(templateProp(e.values, types, CHAR.initial));
  const act = behaviors.fromTemplate(templateProp(e.values, types, CHAR.active));
  if (!initial && act?.kind === 'death') return { poses: act.clips.map(clipKey).filter((k): k is string => !!k), corpse: true };
  const b = initial?.kind === 'dormant' ? initial : act;
  const c = b && (b.kind === 'idle' || b.kind === 'dormant') ? clipKey(b.clip) : undefined;
  return c ? { poses: [c], corpse: false } : undefined;
}

/**
 * Objects a message reaches through the level logic (world/logic.ts): relays pass their output
 * on, timers after their delay, Visibility Togglers show / hide their links, characters take
 * BlowUp / Destroy. Other receivers end the path.
 */
function follow(name: string, uid: number, message: number, t: number, via: string, depth: number, out: Indirect[], tracks: Set<number>) {
  const e = byUid.get(uid);
  if (!e || depth > 5) return;
  const input = e.inputs.find((i) => i.message === message)?.name;
  if (!input) return;
  const step = `${via} -> ${e.className}#${uid.toString(16)}`;
  const add = (target: number, effect: Indirect['effect']) => {
    const x = byUid.get(target);
    if (!x || tracks.has(target)) return;
    const r = role(x);
    if (r === 'logic' || r === 'missing') return;
    const rest = restPose(x);
    out.push({ seq: name, uid: target, cls: x.className, role: r, t, effect, via: step, poses: rest?.poses, corpse: rest?.corpse });
  };
  switch (e.className) {
    case 'Message Relay':
      if (input === 'inRelay') for (const l of e.links) follow(name, l, outMessage(e, 'outRelay'), t, step, depth + 1, out, tracks);
      return;
    case 'Timer':
      if (input === 'inStart') for (const l of e.links) follow(name, l, outMessage(e, 'outOnFire'), t + n(e.props.delay), step, depth + 1, out, tracks);
      return;
    case 'Visibility Toggler':
      for (const l of e.links) add(l, input === 'inShow' ? 'show' : input === 'inHide' ? 'hide' : 'toggle');
      return;
  }
  // Direct Destroy keys are audited with the track; BlowUp only kills characters (props break).
  if (depth === 0) return;
  if (input === 'inBlowUp' && e.family === 'Character') add(uid, 'kill');
  else if (input === 'inDestroy') add(uid, 'destroy');
}

function indirectTargets(name: string, seq: StompSequence): Indirect[] {
  const out: Indirect[] = [];
  const tracks = new Set(seq.tracks.map((t) => t.uid));
  for (const t of seq.tracks)
    for (const k of t.messages) if (k.message) follow(name, t.uid, k.message, k.time, `${t.name}@${k.time.toFixed(2)} ${messageName(k.message)}`, 0, out, tracks);
  return out.sort((a, b) => a.t - b.t);
}

function describe(name: string, seq: StompSequence, keys: boolean) {
  console.log(`\n=== "${name}" seq ${seq.id} flags 0x${seq.flags.toString(16)} duration ${f2(seq.duration)} s, ${seq.tracks.length} tracks`);
  for (const t of seq.tracks) {
    const e = byUid.get(t.uid);
    const counts = (
      [
        ['xf', t.transforms.length],
        ['anim', t.anims.length],
        ['snd', t.sounds.length],
        ['att', t.attaches.length],
        ['ctl', t.controls.length],
        ['vis', t.visibility.length],
        ['msg', t.messages.length],
        ['cam', t.cameras.length],
      ] as const
    )
      .filter(([, n]) => n)
      .map(([k, n]) => `${k}${n}`)
      .join(' ');
    console.log(
      `#${t.index} "${t.name}" uid ${t.uid.toString(16)} -> ${e ? `${e.className} tpl ${e.template.pkg}:${e.template.id}${e.modelRef ? ` model ${e.modelRef.pkg}:${e.modelRef.id}` : ''} flags 0x${e.flags.toString(16)} placed ${pos(e.position)}` : 'MISSING'} [${role(e)}] tflags 0x${t.flags.toString(16)}${t.flags & TRACK_REMOVE_AT_END ? ' (removed at the end)' : ''} | ${counts}`,
    );
    if (!keys) continue;
    for (const k of t.transforms) console.log(`   ${f2(k.time)} xf ${pos(k.position)} yaw ${yaw(k.quat)} tilt ${tilt(k.quat)} f 0x${k.flags.toString(16)}`);
    for (const k of t.anims) {
      const c = clip(k.clip.pkg, k.clip.id);
      console.log(
        `   ${f2(k.time)} anim ch${k.channel} ${k.clip.pkg}:${k.clip.id} ${c ? `${guessClipLabel(c)} dur ${f2(c.duration)} ${c.flags & 1 ? 'once' : 'loop'} cflags 0x${c.flags.toString(16)}` : 'MISSING CLIP'} off ${f2(k.offset)} blend ${f2(k.blend)} speed ${f2(k.speed)} f 0x${k.flags.toString(16)}`,
      );
    }
    for (const k of t.attaches) console.log(`   ${f2(k.time)} attach track #${k.track} (${seq.tracks.find((x) => x.index === k.track)?.name ?? '-'}) hardpoint ${k.hardpoint}`);
    for (const k of t.controls) console.log(`   ${f2(k.time)} control ${k.release ? 'release' : 'take'}`);
    for (const k of t.visibility) console.log(`   ${f2(k.time)} visible ${k.visible}`);
    for (const k of t.messages) console.log(`   ${f2(k.time)} message ${k.message} ${messageName(k.message)} param ${k.param} f 0x${k.flags.toString(16)}`);
    for (const k of t.sounds) console.log(`   ${f2(k.time)} sound ${k.sound.pkg}:${k.sound.id} vol ${f2(k.volume)} f 0x${k.flags.toString(16)}`);
  }
}

const filter = flag('--seq')?.toLowerCase();
const all: Expectation[] = [];
const indirect: Indirect[] = [];
const sequences = new Map<string, StompSequence>();
for (const e of ents.filter((x) => x.className === 'STOMP Player')) {
  const r = e.values[0] as { pkg: number; id: number } | null;
  const q = r ? packages.get(r.pkg)?.qdu : undefined;
  const seq = q && r ? parseStompSequence(q, r.id) : undefined;
  if (!seq) continue;
  const name = `${seq.tracks[0]?.name ?? ''}#${seq.id}`;
  if (filter && !name.toLowerCase().includes(filter)) continue;
  if (sequences.has(name)) continue;
  sequences.set(name, seq);
  describe(name, seq, args.includes('--keys'));
  all.push(...expectations(name, seq));
  const ind = indirectTargets(name, seq);
  indirect.push(...ind);
  for (const x of ind)
    console.log(
      `   indirect ${x.t.toFixed(2)} ${x.effect} ${x.cls}#${x.uid.toString(16)} [${x.role}]${x.poses?.length ? ` pose ${x.poses.join('|')}${x.corpse ? ' (corpse)' : ''}` : ''}  via ${x.via}`,
    );
}

const jsonOut = flag('--json');
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ tracks: all, indirect }));
  console.log(`\n${all.length} track expectations, ${indirect.length} indirect targets -> ${jsonOut}`);
}

// ---------------------------------------------------------------------------
// Diff against a browser recording (tools/stomp-sample.mjs / window.__stomp.probe): rows
// { seq, index, t, at, rendered, position?, yaw?, clip?, clipTime?, visible?, scripted? } and
// messages { seq, at, to, message, handled }. Expectations are re-sampled at `at`, the
// sequence time of the frame that recorded the row.

interface Actual {
  seq: string;
  index: number;
  t: number;
  at?: number;
  rendered?: string;
  position?: [number, number, number];
  yaw?: number;
  clip?: string;
  clipTime?: number;
  visible?: boolean;
  drawn?: boolean;
  scripted?: boolean;
  alive?: boolean;
  uid?: number;
  after?: boolean;
  pose?: string;
  activity?: string;
}
interface ActualMessage {
  seq: string;
  at: number;
  to: number;
  message: number;
  handled: boolean;
}

const actualPath = flag('--actual');
if (actualPath) {
  const raw = JSON.parse(readFileSync(actualPath, 'utf8')) as Actual[] | { rows: Actual[]; messages: ActualMessage[] };
  const rows = Array.isArray(raw) ? raw : raw.rows;
  const messages = Array.isArray(raw) ? [] : raw.messages;
  const issues = new Map<string, string[]>();
  const notes = new Map<string, Set<string>>();
  const label = (name: string, t: StompTrack) => {
    const e = byUid.get(t.uid);
    return `${name} #${t.index} "${t.name}" (${e?.className ?? '?'}/${role(e)})`;
  };
  const add = (k: string, s: string) => {
    const l = issues.get(k) ?? issues.set(k, []).get(k)!;
    if (l.length < 6) l.push(s);
  };
  const note = (k: string, s: string) => (notes.get(k) ?? notes.set(k, new Set()).get(k)!).add(s);
  for (const [name, seq] of sequences) {
    for (const t of seq.tracks) {
      const k = label(name, t);
      const ch = new Set(t.anims.filter((a) => a.channel !== 0).map((a) => a.channel));
      if (ch.size) note(k, `animation channel(s) ${[...ch].join(', ')} not layered (only channel 0 plays)`);
      if (t.messages.some((m) => !m.message)) note(k, 'message keys with message id 0 (no-op, nothing is sent)');
      if (t.messages.some((m) => m.param)) note(k, 'message keys with a parameter (sent as the plain message)');
      if (t.attaches.length && !['actor', 'puppet'].includes(role(byUid.get(t.uid)))) note(k, 'attach keys on a non-character');
    }
    // Indirect targets: state from the effects reached by `at`.
    const ind = indirect.filter((x) => x.seq === name);
    for (const a of rows.filter((r) => r.seq === name && r.index < 0 && r.uid !== undefined)) {
      const fx = ind.filter((x) => x.uid === a.uid);
      const at = a.after ? seq.duration : (a.at ?? a.t);
      const reached = fx.filter((x) => x.t <= at + 1e-3);
      if (!reached.length) continue;
      const x0 = reached[0];
      const k = `${name} indirect ${x0.cls}#${x0.uid.toString(16)} (${x0.role}; ${x0.via})`;
      const tag = a.after ? `${a.t.toFixed(1)} s after the end` : `t=${at.toFixed(2)}`;
      let visible: boolean | undefined;
      let killed = false, destroyed = false;
      for (const x of reached) {
        if (x.effect === 'show') visible = true;
        else if (x.effect === 'hide') visible = false;
        else if (x.effect === 'kill') killed = true;
        else if (x.effect === 'destroy') destroyed = true;
      }
      // Effects take a frame or two through relays: skip samples right at the effect time.
      if (reached.every((x) => at - x.t < 0.2)) continue;
      if (destroyed) {
        if (a.rendered !== 'none' && a.visible) add(k, `${tag}: still shown after Destroy`);
        continue;
      }
      if (visible !== undefined && a.visible !== undefined && a.visible !== visible) add(k, `${tag}: visible ${a.visible}, expected ${visible}`);
      if (x0.role === 'actor' && visible !== false) {
        if (a.rendered === 'none') add(k, `${tag}: character not rendered`);
        const dead = killed || !!x0.corpse;
        if (a.alive !== undefined && a.alive === dead) add(k, `${tag}: ${a.alive ? 'alive' : 'dead'}, expected ${dead ? 'dead' : 'alive'}${a.activity ? ` (${a.activity})` : ''}`);
        if (!killed && x0.poses?.length && a.pose && !x0.poses.includes(a.pose))
          add(k, `${tag}: shows clip ${a.pose}, expected its ${x0.corpse ? 'corpse' : 'rest'} pose ${x0.poses.join(' | ')}${a.activity ? ` (${a.activity})` : ''}`);
        if (!killed && x0.poses?.length && !a.pose) add(k, `${tag}: no clip playing, expected ${x0.poses.join(' | ')}`);
      }
    }
    // After the end: the end state must hold (corpses stay, hidden stays hidden, scripted
    // actors that were never handed back stay where the sequence left them).
    for (const a of rows.filter((r) => r.seq === name && r.after && r.index >= 0)) {
      const t = seq.tracks.find((x) => x.index === a.index);
      if (!t) continue;
      const x = expectAt(name, seq, t, seq.duration);
      const k = label(name, t);
      const tag = `${a.t.toFixed(1)} s after the end`;
      // Track flag 0x08: the sequence removes the object when it finishes (stomp.ts).
      if (t.flags & TRACK_REMOVE_AT_END) {
        if (a.rendered !== 'none' && a.visible) add(k, `${tag}: still present, expected removed at the end (track flag 0x08)`);
        continue;
      }
      if (x.destroyed) {
        if (x.role === 'actor' && a.rendered === 'actor' && a.visible) add(k, `${tag}: present again after Destroy`);
        continue;
      }
      if (x.visible !== undefined && a.visible !== undefined && a.visible !== x.visible) add(k, `${tag}: visible ${a.visible}, expected ${x.visible} (end state)`);
      if (x.role === 'actor' && x.position && a.position && !x.attachedTo) {
        const d = Math.hypot(...x.position.map((v, i) => v - a.position![i]));
        if (d > 1) {
          if (x.scripted) add(k, `${tag}: moved ${d.toFixed(2)} m from its final key while still held by the sequence`);
          else note(k, `moves ${d.toFixed(2)} m from its final key after the hand-back (AI)`);
        }
      }
    }
    for (const a of rows.filter((r) => r.seq === name && !r.after && r.index >= 0)) {
      const t = seq.tracks.find((x) => x.index === a.index);
      if (!t) continue;
      // The probe rounds the frame time (5 decimals); the last keys sit at the (f32) duration.
      const at = Math.min(a.at ?? a.t, seq.duration) >= seq.duration - 1e-4 ? seq.duration : (a.at ?? a.t);
      const x = expectAt(name, seq, t, at);
      const k = label(name, t);
      const tag = `t=${at.toFixed(2)}`;
      const shown = !['logic', 'missing'].includes(x.role);
      if (shown && a.rendered === 'none' && !(x.destroyed && x.role === 'actor')) add(k, `${tag}: object not rendered (expected ${x.role})${undecodable(t.uid)}`);
      // Messages go through the level logic's queue: the object goes on the next frame.
      const destroyedAt = t.messages.find((m) => m.message === DESTROY)?.time ?? Infinity;
      if (x.destroyed && x.role === 'actor' && a.rendered === 'actor' && at - destroyedAt > 0.1) add(k, `${tag}: still present after Destroy`);
      // Handed back (control release key reached): the AI owns the actor from then on.
      const released = x.role === 'actor' && x.scripted === false;
      if (x.position && a.position && shown && !x.attachedTo && !released) {
        const d = Math.hypot(...x.position.map((v, i) => v - a.position![i]));
        if (d > 0.15) add(k, `${tag}: position off by ${d.toFixed(2)} m (expected ${x.position.map(f2).join(',')} got ${a.position.map(f2).join(',')})`);
        if (x.yaw !== undefined && a.yaw !== undefined && x.tilt! < 60) {
          const dy = Math.abs(((x.yaw - a.yaw + 540) % 360) - 180);
          if (dy > 10) add(k, `${tag}: yaw off by ${dy}° (expected ${x.yaw} got ${a.yaw})`);
        }
      }
      if (x.attachedTo && x.position && t.transforms.length) note(k, `transform keys while attached to ${x.attachedTo} (the hardpoint wins)`);
      if (x.clip && ['actor', 'puppet', 'skinned'].includes(x.role) && a.rendered !== 'none' && !released) {
        if (a.clip !== x.clip) add(k, `${tag}: clip ${a.clip ?? 'none'} playing, expected ${x.clip}`);
        else if (x.clipTime !== undefined && a.clipTime !== undefined && Math.abs(a.clipTime - x.clipTime) > 0.35 && !(x.clipOnce === false))
          add(k, `${tag}: clip time ${a.clipTime} expected ${x.clipTime}`);
      }
      if (x.visible !== undefined && a.visible !== undefined && a.visible !== x.visible && !x.destroyed) add(k, `${tag}: visible ${a.visible}, expected ${x.visible}`);
      if (x.scripted !== undefined && a.scripted !== undefined && a.scripted !== x.scripted && at < seq.duration - 1e-3) add(k, `${tag}: scripted ${a.scripted}, expected ${x.scripted}`);
    }
    // Characters take level messages through the actors system (On wakes, BlowUp / Destroy
    // kill / remove, invulnerability on / off), which the world log does not mark as handled.
    const ACTOR_MSGS = new Set([1, 11, 12, 22, 90, 91]);
    for (const m of messages.filter((r) => r.seq === name && !r.handled)) {
      const t = seq.tracks.find((x) => x.uid === m.to && x.messages.some((k) => k.message === m.message && Math.abs(k.time - m.at) < 0.5));
      const e = byUid.get(m.to);
      const k = t ? label(name, t) : `${name} uid ${m.to.toString(16)}`;
      if (e && (e.family === 'Character' || e.className === 'Player') && ACTOR_MSGS.has(m.message)) continue;
      // Prefetch only preloads (nothing to see).
      if (m.message === 13) note(k, 'Prefetch (preload hint) not acted on');
      else if (e && e.inputs.some((i) => i.message === m.message)) add(k, `t=${m.at.toFixed(2)}: message ${messageName(m.message)} reaches an input the port does not act on`);
      else note(k, `message ${messageName(m.message)} has no matching input on the receiver (no-op)`);
    }
  }
  const nIndirect = [...issues.keys()].filter((k) => k.includes(' indirect ')).length;
  console.log(
    `\n--- diff vs ${actualPath}: ${issues.size} discrepant tracks / targets (${nIndirect} indirect; ${rows.length} samples, ${rows.filter((r) => r.after).length} after the end, ${messages.length} messages)`,
  );
  for (const [k, l] of issues) console.log(`${k}\n   ${l.join('\n   ')}`);
  console.log(`\n--- not modelled (informational): ${notes.size} tracks`);
  for (const [k, l] of notes) console.log(`${k}\n   ${[...l].join('\n   ')}`);
}
