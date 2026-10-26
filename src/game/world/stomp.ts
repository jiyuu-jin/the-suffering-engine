// STOMP sequences (.qdu entry type 0x11): parser + pose sampling.
//
// Full layout and semantics: docs/game-logic.md §7 / §11.4. In short:
//
//   header   u32 flags (0x40 = cinematic: camera takeover; 0x04 letterbox while the player is
//            held; 0x01 / 0x08 see SEQ_*; 0x02 unknown), f32 editor timeline length,
//            u32 next free track index, u32 trackCount
//   track    u16 nameLen + name (NUL padded), u32 index, u32 uid of the driven object,
//            u32 track flags, u32 keyCount, keys. The runtime copies the track flags into the
//            track's play state; 0x08 (TRACK_REMOVE_AT_END) removes the object when the
//            sequence finishes, 0x10 is set on every track (0x01 / 0x02 on four: unknown).
//   key      u16 tag, f32 time (seconds from sequence start), then a tag-specific body.
//            Keys of a track are stored in time order.
//
//   tag  size  body
//    0    54   transform: quat (x,y,z,w), f32[3] position (engine units),
//              u32 0, u32 flags, f32[3] scale. flags (of the key being moved TO):
//                0x10 linear / 0x20 Catmull-Rom position into this key (none = step),
//                0xc0 easing: 0x40 ease-out, 0x80 ease-in, 0xc0 ease-in-out (cosine),
//                0x100 / 0x200 / 0x400 leave position / rotation / scale alone,
//                0x800 position moves at constant speed (easing applies to rotation only).
//    1    30   animation: u32 channel, ref clip (u16 id, u16 pkg), f32 start offset into
//              the clip (s), f32 blend-in time (s), f32 playback speed, u32 flags. The channel
//              indexes the carrier model's channel table (the hardpoint table): the clip plays
//              on that bone's subtree (channel 0 = the root bone = whole body). Flags: four
//              2-bit root-motion modes (ANIM_ROOT_*), 0x100 unload the clip once unused,
//              0x200 independent layer (docs/re/animation.md).
//    3    14   sound: ref sound, u16 volume (1/10000), u16 flags (0x10 = not positional).
//    4    14   attach: u32 track index of the prop (0 = clear), u32 hardpoint index.
//    5    10   control: u32 0 = script takes the object over (AI / player input off),
//              1 = hand it back.
//    6    10   visibility: u32 0 hidden / 1 shown.
//    7    18   message: u32 message id, u32 parameter (0 = plain message), u32 flags.
//    9    18   camera: f32 time scale, u32 field of view (degrees, 0 = unchanged), u32 low
//              3 bits interpolation into this key (0 step, 1/3/5 linear, 2 ease-out,
//              4 ease-in, 6 ease-in-out); upper bits are uninitialised editor memory.
//   10     6   marker (no body; ignored by the runtime).
// Validated against all 186 sequences of the retail game (exact byte coverage, monotonic
// times per track; see tests/formats.test.ts).

import type { SrscFile } from '../../formats/srsc';
import { findEntry, type ResRef } from '../../formats/model';

export const QDU_SEQUENCE = 0x11;

export const StompTag = {
  Transform: 0,
  Anim: 1,
  Sound: 3,
  Attach: 4,
  Control: 5,
  Visibility: 6,
  Message: 7,
  Camera: 9,
  Marker: 10,
} as const;

/** Byte size of each key (including the u16 tag and the f32 time). */
const KEY_SIZE: Record<number, number> = { 0: 54, 1: 30, 3: 14, 4: 14, 5: 10, 6: 10, 7: 18, 9: 18, 10: 6 };

/**
 * Sequence flag 0x40: "cinematic". Only a track on the Camera object takes the view and the input
 * (World.takesCamera); the flag alone answers "is a cinematic playing" [verified, docs/game-logic.md].
 */
export const SEQ_CINEMATIC = 0x40;
/**
 * Sequence flag 0x01: the loader clears 0x40 and 0x02 when it is set (SUFFERING.EXE 0x44c06e);
 * a key whose object is missing aborts the key walk instead of skipping it (0x45114b) and a
 * resumed sequence seeks its keys (0x44f187). 4 retail sequences [code read; purpose inferred].
 */
export const SEQ_STRICT = 0x01;
/**
 * Sequence flag 0x04: a control key on the player switches the view manager's letterbox bars
 * on (take) / off (release), and destroying the run switches them off (0x450ea6, 0x44fa55;
 * bars drawn at 0x4b0b30). Their size is Level Properties p36 % (10) and colour p37, set by
 * Suffering.rfl at level start (0x100b239f) [verified]; src/game/sequence/cinema.ts.
 */
export const SEQ_LETTERBOX = 0x04;
/**
 * Sequence flag 0x08: when a run that held the player ends normally, the engine calls a
 * global service (vt 0x70, argument -1) and resets the game clock's input state
 * (0x45130c..0x451331) [code read; meaning not identified].
 */
export const SEQ_END_RESET = 0x08;

/**
 * Track flag: the object only exists for the sequence (stand-ins parked off the map, props
 * of a scene) and is removed when the sequence finishes, skipped or not. SUFFERING.EXE copies
 * the track flags into the per-track play state when a sequence starts (0x44f4ed) and, when
 * it reaches its end (0x4512c0), calls a virtual of every object whose state has 0x08
 * (0x45135a). 1a "Goose": the escort guards, the door guard, his chair and magazine, the
 * CartWheeler and the shoe decorations; elsewhere Horace, Hermes, Killjoy, Hargrave.
 */
export const TRACK_REMOVE_AT_END = 0x08;

/**
 * Animation key flags (StompAnimKey.flags). The low byte holds four 2-bit root-motion modes
 * (x, y, z translation of the root bone, then its rotation), applied for channel-0 keys only
 * (SUFFERING.EXE 0x44fd70; animator flags set at 0x46f620, used at 0x478b90):
 *   0  the root bone keeps that motion in the pose (the mesh moves away from the object);
 *   1  extracted: removed from the pose and applied to the object as it plays;
 *   2  locked: removed from the pose, the object does not move (in place).
 * For rotation, 1 = the root rotation is extracted to the object, 2 = it holds the value of
 * the clip start. Walk / run keys with transform keys use x 0, y 0, z 2 (forward stripped).
 */
export const ANIM_ROOT_MASK = 0xff;
/**
 * 0x100 -> play request flag 0x80: the animator remembers the clip (two slots at animator
 * +0x1e8 / +0x1ec) and releases it from the resource cache once no channel node plays, blends
 * from or queues it (0x46fd30). Memory management only; 477 retail keys.
 */
export const ANIM_UNLOAD = 0x100;
/**
 * 0x200 -> play request flag 0x08 -> channel node flag 0x400: an independent layer. A later
 * clip on an ancestor channel does not override it (0x470f20). Never set in retail data.
 */
export const ANIM_INDEPENDENT = 0x200;

/** Root-motion mode of an animation key: 0 kept in the pose, 1 extracted, 2 locked. */
export type RootMotionMode = 0 | 1 | 2;
export interface RootMotionModes {
  x: RootMotionMode;
  y: RootMotionMode;
  z: RootMotionMode;
  rotation: RootMotionMode;
}

/** The four root-motion modes of animation key flags (3 behaves like 2). */
export function rootMotionModes(flags: number): RootMotionModes {
  const m = (shift: number) => Math.min(2, (flags >>> shift) & 3) as RootMotionMode;
  return { x: m(0), y: m(2), z: m(4), rotation: m(6) };
}

export const XF_LINEAR = 0x10;
export const XF_SPLINE = 0x20;
export const XF_EASE_MASK = 0xc0;
export const XF_NO_POSITION = 0x100;
export const XF_NO_ROTATION = 0x200;
export const XF_NO_SCALE = 0x400;
export const XF_CONSTANT_SPEED = 0x800;

export interface StompMessageKey {
  time: number;
  message: number;
  param: number;
  flags: number;
}

export interface StompVisibilityKey {
  time: number;
  visible: boolean;
}

export interface StompTransformKey {
  time: number;
  /**
   * Object rotation (x, y, z, w) in engine space: maps model axes to world axes, the same
   * basis as level placements (level.ts instanceRotation). The file stores its inverse.
   */
  quat: [number, number, number, number];
  /** Engine units. */
  position: [number, number, number];
  scale: [number, number, number];
  /** Interpolation / channel flags (XF_*); 0 on sampled (interpolated) poses. */
  flags: number;
}

export interface StompAnimKey {
  time: number;
  /** Channel-table index of the carrier model (0 = whole body; see the header). */
  channel: number;
  clip: ResRef;
  /** Start position inside the clip (s). */
  offset: number;
  /** Cross-fade time (s). */
  blend: number;
  speed: number;
  /** Root-motion modes (low byte, ANIM_ROOT_*), ANIM_UNLOAD, ANIM_INDEPENDENT. */
  flags: number;
}

export interface StompSoundKey {
  time: number;
  sound: ResRef;
  /** Linear gain, 0..1. */
  volume: number;
  flags: number;
}

export interface StompAttachKey {
  time: number;
  /** Track index (StompTrack.index) of the attached object; 0 = clear the hardpoint. */
  track: number;
  hardpoint: number;
}

export interface StompControlKey {
  time: number;
  /** false = the sequence takes the object over, true = control is handed back. */
  release: boolean;
}

export interface StompCameraKey {
  time: number;
  /**
   * Game clock rate relative to the rate at the sequence start, interpolated between camera
   * keys like the FOV (0x44e2a0: rate = base * (prev + (next - prev) * u)); restored at the
   * end. 4 Quarry's three crane sequences drop to 0.25 for ~1 s.
   */
  timeScale: number;
  /** Degrees; 0 = leave unchanged. */
  fov: number;
  /** Interpolation into this key: 0 step, 1 linear, 2 ease-out, 4 ease-in, 6 ease-in-out. */
  interp: number;
}

export interface StompTrack {
  name: string;
  index: number;
  uid: number;
  flags: number;
  keyCount: number;
  transforms: StompTransformKey[];
  anims: StompAnimKey[];
  sounds: StompSoundKey[];
  attaches: StompAttachKey[];
  controls: StompControlKey[];
  visibility: StompVisibilityKey[];
  messages: StompMessageKey[];
  cameras: StompCameraKey[];
}

export interface StompSequence {
  id: number;
  flags: number;
  /** Editor timeline length (not the playing time). */
  length: number;
  tracks: StompTrack[];
  /** Time of the last key (s): the sequence finishes then. */
  duration: number;
  /** Bytes decoded (equals the entry size for well-formed data). */
  byteLength: number;
}

/** A few authored keys are slightly off unit length (or zero). */
function unitQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
  const n = Math.hypot(x, y, z, w);
  return n > 1e-6 ? [x / n, y / n, z / n, w / n] : [0, 0, 0, 1];
}

const ref = (v: DataView, o: number): ResRef => ({ id: v.getUint16(o, true), pkg: v.getUint16(o + 2, true) });

/** Decode a sequence from its raw bytes. Throws on malformed data. */
export function decodeStompSequence(v: DataView, id = 0): StompSequence {
  const flags = v.getUint32(0, true);
  const length = v.getFloat32(4, true);
  const trackCount = v.getUint32(12, true);
  if (trackCount > 4096) throw new Error(`STOMP ${id}: bad track count ${trackCount}`);
  const f = (o: number) => v.getFloat32(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const tracks: StompTrack[] = [];
  let duration = 0;
  let p = 16;
  for (let n = 0; n < trackCount; n++) {
    const len = v.getUint16(p, true);
    let name = '';
    for (let i = 0; i < len; i++) {
      const c = v.getUint8(p + 2 + i);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    p += 2 + len;
    const t: StompTrack = {
      name: name.trim(),
      index: u32(p),
      uid: u32(p + 4),
      flags: u32(p + 8),
      keyCount: u32(p + 12),
      transforms: [],
      anims: [],
      sounds: [],
      attaches: [],
      controls: [],
      visibility: [],
      messages: [],
      cameras: [],
    };
    p += 16;
    for (let k = 0; k < t.keyCount; k++) {
      const tag = v.getUint16(p, true);
      const size = KEY_SIZE[tag];
      if (!size || p + size > v.byteLength) throw new Error(`STOMP ${id}: unknown key tag ${tag} at ${p} (track "${t.name}")`);
      const time = f(p + 2);
      const b = p + 6;
      switch (tag) {
        case StompTag.Transform:
          t.transforms.push({
            time,
            // Stored inverted (world -> object); keep the object rotation.
            quat: unitQuat(-f(b), -f(b + 4), -f(b + 8), f(b + 12)),
            position: [f(b + 16), f(b + 20), f(b + 24)],
            flags: u32(b + 32),
            scale: [f(b + 36), f(b + 40), f(b + 44)],
          });
          break;
        case StompTag.Anim:
          t.anims.push({ time, channel: u32(b), clip: ref(v, b + 4), offset: f(b + 8), blend: f(b + 12), speed: f(b + 16), flags: u32(b + 20) });
          break;
        case StompTag.Sound:
          t.sounds.push({ time, sound: ref(v, b), volume: v.getUint16(b + 4, true) / 10000, flags: v.getUint16(b + 6, true) });
          break;
        case StompTag.Attach:
          t.attaches.push({ time, track: u32(b), hardpoint: u32(b + 4) });
          break;
        case StompTag.Control:
          t.controls.push({ time, release: u32(b) !== 0 });
          break;
        case StompTag.Visibility:
          t.visibility.push({ time, visible: u32(b) !== 0 });
          break;
        case StompTag.Message:
          t.messages.push({ time, message: u32(b), param: u32(b + 4), flags: u32(b + 8) });
          break;
        case StompTag.Camera:
          t.cameras.push({ time, timeScale: f(b), fov: u32(b + 4), interp: u32(b + 8) & 7 });
          break;
      }
      if (tag !== StompTag.Marker) duration = Math.max(duration, time);
      p += size;
    }
    tracks.push(t);
  }
  return { id, flags, length, tracks, duration, byteLength: p };
}

export function parseStompSequence(file: SrscFile, id: number): StompSequence | undefined {
  const e = findEntry(file, QDU_SEQUENCE, id);
  if (!e || e.size < 16) return undefined;
  try {
    return decodeStompSequence(file.data(e), id);
  } catch (err) {
    console.warn('[stomp]', (err as Error).message);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sampling

/** Easing of the interpolation parameter by the target key's flags (0xc0 bits). */
export function easeTransform(u: number, flags: number): number {
  switch (flags & XF_EASE_MASK) {
    case 0x40:
      return 1 - (u - 1) * (u - 1);
    case 0x80:
      return u * u;
    case 0xc0:
      return (1 - Math.cos(u * Math.PI)) * 0.5;
    default:
      return u;
  }
}

/** Camera key interpolation modes. */
export function easeCamera(u: number, mode: number): number {
  switch (mode) {
    case 0:
      return u >= 1 ? 1 : 0;
    case 2:
      return 1 - (u - 1) * (u - 1);
    case 4:
      return u * u;
    case 6:
      return (1 - Math.cos(u * Math.PI)) * 0.5;
    default:
      return u;
  }
}

/** Index of the last key with time <= t (-1 before the first key). */
export function keyIndexAt<T extends { time: number }>(keys: readonly T[], t: number): number {
  let lo = 0, hi = keys.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (keys[m].time <= t) (r = m), (lo = m + 1);
    else hi = m - 1;
  }
  return r;
}

function slerp(a: readonly number[], b: readonly number[], u: number): [number, number, number, number] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d = Math.abs(d);
  let wa: number, wb: number;
  if (d > 0.9995) {
    wa = 1 - u;
    wb = u;
  } else {
    const th = Math.acos(Math.min(1, d));
    const sn = Math.sin(th);
    wa = Math.sin((1 - u) * th) / sn;
    wb = Math.sin(u * th) / sn;
  }
  const q = [0, 1, 2, 3].map((j) => wa * a[j] + wb * s * b[j]);
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u3);
}

/**
 * Pose of a track at time t, as the engine evaluates it: the last key reached holds
 * until the next key, unless that next key asks to be interpolated into (flags 0x30).
 * Returns undefined before the first transform key (the object keeps its placement).
 * Channels a key leaves alone (0x100/0x200/0x400) keep the value of the last key that set them.
 */
export function sampleTrack(track: StompTrack, t: number): StompTransformKey | undefined {
  const k = track.transforms;
  const i = keyIndexAt(k, t);
  if (i < 0) return undefined;
  const cur = k[i];
  // Last value per channel from keys that set it.
  const held = (mask: number) => {
    for (let j = i; j >= 0; j--) if (!(k[j].flags & mask)) return k[j];
    return cur;
  };
  let position = held(XF_NO_POSITION).position;
  let quat = held(XF_NO_ROTATION).quat;
  let scale = held(XF_NO_SCALE).scale;
  const next = k[i + 1];
  if (next && next.flags & (XF_LINEAR | XF_SPLINE) && next.time - cur.time >= 1e-3) {
    const lin = Math.min(1, Math.max(0, (t - cur.time) / (next.time - cur.time)));
    const eased = easeTransform(lin, next.flags);
    const up = next.flags & XF_CONSTANT_SPEED ? lin : eased;
    if (!(next.flags & XF_NO_POSITION)) {
      const a = cur.position, b = next.position;
      if (next.flags & XF_SPLINE && k[i + 2]) {
        const p0 = (k[i - 1] ?? cur).position, p3 = k[i + 2].position;
        position = [0, 1, 2].map((j) => catmull(p0[j], a[j], b[j], p3[j], up)) as [number, number, number];
      } else position = [0, 1, 2].map((j) => a[j] + (b[j] - a[j]) * up) as [number, number, number];
    }
    if (!(next.flags & XF_NO_ROTATION)) quat = slerp(cur.quat, next.quat, eased);
    if (!(next.flags & XF_NO_SCALE)) scale = [0, 1, 2].map((j) => cur.scale[j] + (next.scale[j] - cur.scale[j]) * up) as [number, number, number];
  }
  return { time: t, quat, position, scale, flags: 0 };
}

/** Camera FOV (degrees, 0 = none) and time scale at time t. */
export function sampleCamera(track: StompTrack, t: number): { fov: number; timeScale: number } | undefined {
  const k = track.cameras;
  const i = keyIndexAt(k, t);
  if (i < 0) return undefined;
  const cur = k[i], next = k[i + 1];
  if (!next || next.time - cur.time < 1e-3) return { fov: cur.fov, timeScale: cur.timeScale };
  const u = easeCamera(Math.min(1, (t - cur.time) / (next.time - cur.time)), next.interp);
  const fov = cur.fov && next.fov ? cur.fov + (next.fov - cur.fov) * u : cur.fov;
  const timeScale = cur.timeScale && next.timeScale ? cur.timeScale + (next.timeScale - cur.timeScale) * u : cur.timeScale;
  return { fov, timeScale };
}

// ---------------------------------------------------------------------------
// Runtime: one playing sequence

export type StompEvent =
  | { kind: 'message'; key: StompMessageKey }
  | { kind: 'visibility'; key: StompVisibilityKey }
  | { kind: 'anim'; key: StompAnimKey }
  | { kind: 'sound'; key: StompSoundKey }
  | { kind: 'attach'; key: StompAttachKey }
  | { kind: 'control'; key: StompControlKey };

interface QueuedEvent {
  time: number;
  track: StompTrack;
  ev: StompEvent;
}

/** What a running sequence acts on (the world system implements it). */
export interface StompSink {
  send(uid: number, message: number, sender: number): void;
  setVisible(uid: number, visible: boolean): void;
  /** Pose a track's object (only called when the sampled pose changes). */
  pose(uid: number, key: StompTransformKey, track: StompTrack): void;
  /** Remove the object from the level (tracks flagged TRACK_REMOVE_AT_END, at the end). */
  remove?(uid: number): void;
  /**
   * A control key reached the object (also while skipping): the engine sends it 0x1001 (taken)
   * or 0x1002 (handed back) (0x450da0). Before the presenter's own handling (observer `event`).
   */
  control?(uid: number, release: boolean): void;
}

/** Presentation layer (camera, animation, sound, subtitles): src/game/sequence. */
export interface StompObserver {
  begin(run: StompRun): void;
  /** Animation / sound / attach / control keys, in time order (`run.skipping` while skipping). */
  event(run: StompRun, track: StompTrack, ev: StompEvent): void;
  /** After keys and poses were applied for run.t. */
  frame(run: StompRun): void;
  end(run: StompRun): void;
}

/**
 * Order of keys at the same time: the engine sorts a sequence's keys by time, then by a per-tag
 * rank (qsort comparator SUFFERING.EXE 0x44dbf0, table 0x5b9c70: control 1, transform 2,
 * animation 3, sound / attach / visibility / message 5, camera 9; lower first) [verified]. So a
 * take at 0 s comes before a hide at 0 s: 5b's Killjoys 13e3 ("Camera" 1296) and 13db (2942)
 * are taken (shown, stompTakeShows) and then hidden until their show keys.
 */
const KEY_RANK: Record<StompEvent['kind'], number> = { control: 1, anim: 3, sound: 5, attach: 5, visibility: 5, message: 5 };

/**
 * Plays one sequence: delivers keys of all tracks in time order (at one time: control, then
 * animation, then messages, visibility, sound and attach; KEY_RANK) and poses every transform
 * track each frame.
 */
export class StompRun {
  /** Sequence time (s). */
  t = 0;
  /** True while jumping to the end (skip): sounds are not started. */
  skipping = false;
  /** Sequence time the skip jumped from (= duration when it was not skipped). */
  skippedFrom = Infinity;
  finished = false;
  private readonly events: QueuedEvent[] = [];
  private cursor = 0;
  private readonly lastPose = new Map<StompTrack, StompTransformKey>();
  /** Attached child track -> { parent track, hardpoint } (attach keys). */
  private readonly attached = new Map<StompTrack, { parent: StompTrack; hardpoint: number }>();

  constructor(
    /** uid of the STOMP Player object. */
    readonly uid: number,
    readonly seq: StompSequence,
  ) {
    for (const track of seq.tracks) {
      const add = (time: number, ev: StompEvent) => this.events.push({ time, track, ev });
      for (const key of track.messages) add(key.time, { kind: 'message', key });
      for (const key of track.visibility) add(key.time, { kind: 'visibility', key });
      for (const key of track.anims) add(key.time, { kind: 'anim', key });
      for (const key of track.sounds) add(key.time, { kind: 'sound', key });
      for (const key of track.attaches) add(key.time, { kind: 'attach', key });
      for (const key of track.controls) add(key.time, { kind: 'control', key });
    }
    // Equal times: the engine's tag rank (KEY_RANK), then track / tag order (stable sort).
    this.events.sort((a, b) => a.time - b.time || KEY_RANK[a.ev.kind] - KEY_RANK[b.ev.kind]);
  }

  get cinematic() {
    return (this.seq.flags & SEQ_CINEMATIC) !== 0;
  }

  /** Track by its index (attach keys refer to tracks this way). */
  trackByIndex(index: number): StompTrack | undefined {
    return this.seq.tracks.find((t) => t.index === index);
  }

  /** Advance by dt (Infinity = skip to the end). Returns true once finished. */
  advance(dt: number, sink: StompSink, observer?: StompObserver): boolean {
    if (this.finished) return true;
    if (dt === Infinity && !this.skipping) {
      this.skipping = true;
      this.skippedFrom = this.t;
    }
    this.t = Math.min(this.t + dt, this.seq.duration);
    while (this.cursor < this.events.length && this.events[this.cursor].time <= this.t) {
      const { track, ev } = this.events[this.cursor++];
      if (ev.kind === 'message') sink.send(track.uid, ev.key.message, this.uid);
      else if (ev.kind === 'visibility') sink.setVisible(track.uid, ev.key.visible);
      else {
        if (ev.kind === 'attach') this.attach(track, ev.key);
        else if (ev.kind === 'control') sink.control?.(track.uid, ev.key.release);
        observer?.event(this, track, ev);
      }
    }
    for (const track of this.seq.tracks) {
      if (!track.transforms.length) continue;
      let key = sampleTrack(track, this.t);
      if (!key) continue;
      const att = this.attached.get(track);
      if (att && Math.hypot(...key.position) < LOCAL_LIMIT) {
        // Keys near the origin while attached are local to the carrier (10 Docks: a
        // character riding a boat). The hardpoint offset itself is not known: carrier origin.
        const parent = sampleTrack(att.parent, this.t);
        if (!parent) continue;
        key = composePose(parent, key);
      }
      const prev = this.lastPose.get(track);
      if (prev && samePose(prev, key)) continue;
      this.lastPose.set(track, key);
      sink.pose(track.uid, key, track);
    }
    observer?.frame(this);
    if (this.t >= this.seq.duration) {
      this.finished = true;
      observer?.end(this);
      // After the hand-backs and final clips of the end: the scene's stand-ins go.
      for (const track of this.seq.tracks) if (track.flags & TRACK_REMOVE_AT_END) sink.remove?.(track.uid);
    }
    return this.finished;
  }

  private attach(carrier: StompTrack, key: StompAttachKey) {
    for (const [child, a] of this.attached) if (a.parent === carrier && a.hardpoint === key.hardpoint) this.attached.delete(child);
    const child = key.track ? this.trackByIndex(key.track) : undefined;
    if (child && child !== carrier) this.attached.set(child, { parent: carrier, hardpoint: key.hardpoint });
  }

  /** Carrier track of an attached track (attach keys), if any. */
  carrierOf(track: StompTrack): StompTrack | undefined {
    return this.attached.get(track)?.parent;
  }

  /** Latest sampled pose of a track (undefined before its first transform key). */
  pose(track: StompTrack): StompTransformKey | undefined {
    return this.lastPose.get(track) ?? sampleTrack(track, this.t);
  }
}

/** Attached keys within this distance of the origin (engine units, 20 m) are carrier-local. */
const LOCAL_LIMIT = 20 * 2048;

function qmul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** parent ∘ local (rotation, then translation; scale ignored). */
function composePose(parent: StompTransformKey, local: StompTransformKey): StompTransformKey {
  const q = parent.quat;
  const v = local.position;
  // Rotate v by q: v + 2w(q×v) + 2q×(q×v)
  const cx = q[1] * v[2] - q[2] * v[1], cy = q[2] * v[0] - q[0] * v[2], cz = q[0] * v[1] - q[1] * v[0];
  const dx = q[1] * cz - q[2] * cy, dy = q[2] * cx - q[0] * cz, dz = q[0] * cy - q[1] * cx;
  const p = parent.position;
  return {
    time: local.time,
    quat: qmul(q, local.quat),
    position: [p[0] + v[0] + 2 * (q[3] * cx + dx), p[1] + v[1] + 2 * (q[3] * cy + dy), p[2] + v[2] + 2 * (q[3] * cz + dz)],
    scale: local.scale,
    flags: 0,
  };
}

function samePose(a: StompTransformKey, b: StompTransformKey) {
  for (let i = 0; i < 4; i++) if (a.quat[i] !== b.quat[i]) return false;
  for (let i = 0; i < 3; i++) if (a.position[i] !== b.position[i] || a.scale[i] !== b.scale[i]) return false;
  return true;
}
