// Characters' clip item events and fades: how Hermes is a gaseous ghost (docs/game-logic.md
// §15.7.12). Decoded from Suffering.rfl [verified unless marked]:
//
//   * Character message handler 0x100e3ab0 (the catch-all 0x100e1e20 hands every message the
//     behaviour stack does not take to vt +0x118): 151 SpawnItem / 152 DestroyItem / 154
//     SpawnAttachments drive the body-part set (fx/attachments.ts); 206..209 Start / Stop
//     FadeIn / FadeOut go to the fader at +0x562 (0x100ac550); 206 also fires output p34.
//     Clip events of kind 1 reach it as messages carrying the bone index of the event (+0xa);
//     link and STOMP messages arrive the same way.
//   * Fader (0x100ac2e0..0x100ac630): opacity = from + (to - from) x (sin((t - 0.5) pi) + 1) / 2,
//     t = elapsed / duration clamped to 0..1, reversed (1 - t) for a fade-out (mode 2). Start
//     sets the mode, elapsed 0 and duration = the time of the matching Stop event (207 / 209)
//     in the clip channel 0 plays, else that clip's length [inferred: clip +0x28], minus its
//     current time (0x100ac400); Stop jumps to the end. Stepped by dt each frame from the
//     Character update (0x100e5947). The value goes to the engine object's opacity (vt +0x130,
//     SUFFERING.EXE 0x457410: object +0xd0, passed on to its attached objects).
//   * The engine multiplies a tinted pass's TFACTOR alpha by that opacity (0x48fcdf), and Hermes'
//     passes are tinted additive (SRCALPHA, ONE): opacity scales the glow he adds.
//   * Default range 0..1, not applied until a fade (Character ctor 0x100e5378). Hermes (vt +0xc
//     0x10076be0) sets from = p180 / 100, to = p181 / 100 and applies the end of a fade-in
//     (p182 != 0) or of a fade-out (p182 = 0) at once: retail 0 / 85 %, so 1a's Hermes
//     (p182 = 1) shows at 85 %, 1b's (p182 = 0) starts invisible until its scene fades him in.
//
// Port scope: the classes in BODY_PART_CLASSES (Hermes). Other creatures whose clips spawn p55
// effects (Fester, Mainliner, Slayer, Burrower, Killjoy) and the p56 creation sets (CartWheeler
// gas) are not wired here yet.

import * as THREE from 'three/webgpu';
import { ADU_EVENTS, ANIM_EVENT_MESSAGE, readAnimEvents } from '../../formats/animation';
import type { PropValue } from '../../formats/entities';
import type { SrscFile } from '../../formats/srsc';
import { findEntry } from '../../formats/model';
import type { Character } from '../../app/character';
import { cloneWithGlowMark } from '../../app/glow-mark';

export const SPAWN_ITEM = 151;
export const DESTROY_ITEM = 152;
export const SPAWN_ATTACHMENTS = 154;
export const START_FADE_IN = 206;
export const STOP_FADE_IN = 207;
export const START_FADE_OUT = 208;
export const STOP_FADE_OUT = 209;
/** Output fired to the links by StartFadeIn (0x100e3d99). */
export const FADE_IN_OUTPUT = 34;

/** Classes whose item / fade events and messages the port runs [port scope]. */
export const BODY_PART_CLASSES: ReadonlySet<string> = new Set(['Hermes']);

const MESSAGES = new Set([SPAWN_ITEM, DESTROY_ITEM, SPAWN_ATTACHMENTS, START_FADE_IN, STOP_FADE_IN, START_FADE_OUT, STOP_FADE_OUT]);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Fader curve (0x100ac380): mode 1 fades from -> to, mode 2 to -> from. */
export function fadeValue(from: number, to: number, elapsed: number, duration: number, mode: number): number {
  let t = duration > 0 ? elapsed / duration : 1;
  if (!(t >= 0)) t = 0;
  if (t > 1) t = 1;
  if (mode === 2) t = 1 - t;
  return from + (to - from) * ((Math.sin((t - 0.5) * Math.PI) + 1) * 0.5);
}

/** The fader a Character carries (+0x562). */
export class CharacterFader {
  from = 0;
  to = 1;
  duration = 1;
  elapsed = 1;
  /** 0 idle, 1 fading in, 2 fading out. */
  mode = 0;
  /** Opacity last applied; undefined until something applied one (the object keeps 1). */
  opacity?: number;

  private apply() {
    this.opacity = fadeValue(this.from, this.to, this.elapsed, this.duration, this.mode);
  }

  /** StartFadeIn (206) / StartFadeOut (208), lasting `duration` s. */
  start(msg: number, duration: number) {
    this.mode = msg === START_FADE_OUT ? 2 : 1;
    this.duration = duration;
    this.elapsed = 0;
    this.apply();
  }

  /** StopFadeIn (207) / StopFadeOut (209): jump to the end of the fade, if one runs. */
  stop() {
    this.elapsed = this.duration;
    if (this.mode) this.apply();
    this.mode = 0;
  }

  /** Per frame (0x100ac4f0): advance a running fade; ends it at its duration. */
  step(dt: number) {
    if (!this.mode) return;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) {
      this.elapsed = this.duration;
      this.apply();
      this.mode = 0;
    } else this.apply();
  }
}

/** Hermes' fader at creation (0x10076be0): p180 / p181 % range, p182 starts faded in. */
export function hermesFader(values: readonly PropValue[]): CharacterFader {
  const f = new CharacterFader();
  f.from = num(values[180]) * 0.01;
  f.to = num(values[181]) * 0.01;
  f.mode = num(values[182]) === 0 ? 2 : 1;
  f.duration = f.elapsed = 1;
  f.step(0); // applies the end of that fade and goes idle (0x100ac4d0)
  return f;
}

/**
 * Length of a fade started now (0x100ac400): until the matching Stop event of the clip channel
 * 0 plays, else until that clip's end; from its current time.
 */
export function fadeDuration(events: readonly ItemEvent[], stopMsg: number, clipLength: number, clipTime: number): number {
  const stop = events.find((e) => e.msg === stopMsg);
  return Math.max(0, (stop && stop.time !== 0 ? stop.time : clipLength) - clipTime);
}

/** Item / fade event of a clip: message, clip time, bone index (-1: not on this rig). */
export interface ItemEvent {
  msg: number;
  time: number;
  bone: number;
}

/**
 * Events crossed when a clip advanced from t0 to t1 (s): the engine's [t0, t1) window, wrapped
 * for loops; `end` includes events at the very end of a one-shot clip that reached it.
 */
export function crossedEvents(events: readonly ItemEvent[], t0: number, t1: number, duration: number, loop: boolean, end = false): ItemEvent[] {
  if (t1 === t0) return [];
  if (t1 > t0) return events.filter((e) => e.time >= t0 && (e.time < t1 || (end && e.time <= duration)));
  // Went back: a loop wrapped (t0 .. end, then 0 .. t1); a one-shot clip restarted (0 .. t1).
  const head = events.filter((e) => e.time < t1);
  return loop ? [...events.filter((e) => e.time >= t0), ...head] : head;
}

type PackageLike = { adu?: SrscFile };

export interface BodyPartsEnv {
  pkgs: ReadonlyMap<number, PackageLike>;
  /** Body-part set (fx/attachments.ts Attachments). */
  parts: {
    spawnParts(uid: number, values: PropValue[], bone?: number): number;
    removeAt(uid: number, bone: number): number;
  };
  /** Fire an output property of the carrier to its links. */
  fire?(uid: number, slot: number): void;
  log?(m: string): void;
}

/** A carrier's fader in a saved game (BodyParts.save). */
export interface FaderSave {
  uid: number;
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  mode: number;
  opacity?: number;
}

export interface BodyPartCarrier {
  uid: number;
  cls: string;
  values: PropValue[];
  ch: Character;
}

interface CarrierState {
  fader: CharacterFader;
  clip?: THREE.AnimationClip;
  t: number;
  /** Own copies of the carrier's materials (shared with its kind) once an opacity applies. */
  mats?: THREE.Material[];
  applied?: number;
}

/** Clip events of new clips are taken from 0 when the clip is at most this far in (s) [port]. */
const NEW_CLIP_WINDOW = 0.5;

export class BodyParts {
  private readonly states = new Map<number, CarrierState>();
  private readonly eventCache = new WeakMap<THREE.AnimationClip, ItemEvent[]>();
  private clipPkg?: Map<string, number>;
  /** Recent events (tests / overlay). */
  readonly recent: { uid: number; msg: number; bone?: number; opacity?: number }[] = [];

  constructor(private readonly env: BodyPartsEnv) {}

  static handles(cls: string | undefined) {
    return !!cls && BODY_PART_CLASSES.has(cls);
  }

  /** Item / fade events of a clip on this character (id + animation set -> its package). */
  eventsOf(ch: Character, clip: THREE.AnimationClip): ItemEvent[] {
    let out = this.eventCache.get(clip);
    if (out) return out;
    out = [];
    const i = ch.clips.indexOf(clip);
    const id = i >= 0 ? ch.clipData[i].id : Number(/#(\d+)$/.exec(clip.name)?.[1] ?? NaN);
    const animSet = i >= 0 ? ch.clipData[i].animSet : ch.skinned.animSet;
    if (!this.clipPkg) {
      this.clipPkg = new Map();
      for (const [pkg, p] of this.env.pkgs) for (const e of p.adu?.entries ?? []) if (e.type === 2) this.clipPkg.set(`${e.extra}:${e.id}`, pkg);
    }
    const adu = Number.isFinite(id) ? this.env.pkgs.get(this.clipPkg.get(`${animSet}:${id}`) ?? -1)?.adu : undefined;
    if (adu && findEntry(adu, ADU_EVENTS, id)) {
      const byHash = ch.skinned.skeleton.byHash;
      for (const e of readAnimEvents(adu, id)?.events ?? []) {
        if (e.kind !== ANIM_EVENT_MESSAGE || !MESSAGES.has(e.param)) continue;
        out.push({ msg: e.param, time: e.time, bone: byHash.get(e.boneHash) ?? -1 });
      }
      out.sort((a, b) => a.time - b.time);
    }
    this.eventCache.set(clip, out);
    return out;
  }

  private state(c: BodyPartCarrier): CarrierState {
    let st = this.states.get(c.uid);
    if (!st) {
      st = { fader: c.cls === 'Hermes' ? hermesFader(c.values) : new CharacterFader(), t: 0 };
      this.states.set(c.uid, st);
    }
    return st;
  }

  /** A message to the carrier (link, STOMP or clip event). Returns true when handled. */
  message(c: BodyPartCarrier, msg: number, bone = -1): boolean {
    if (!MESSAGES.has(msg)) return false;
    const st = this.state(c);
    switch (msg) {
      case SPAWN_ATTACHMENTS:
        this.env.parts.spawnParts(c.uid, c.values);
        break;
      case SPAWN_ITEM:
        if (bone < 0) return false;
        this.env.parts.spawnParts(c.uid, c.values, bone);
        break;
      case DESTROY_ITEM:
        if (bone < 0) return false;
        this.env.parts.removeAt(c.uid, bone);
        break;
      case START_FADE_IN:
      case START_FADE_OUT: {
        const a = c.ch.current;
        const clip = a?.getClip();
        const evs = clip ? this.eventsOf(c.ch, clip) : [];
        st.fader.start(msg, fadeDuration(evs, msg + 1, clip?.duration ?? 0, a?.time ?? 0));
        if (msg === START_FADE_IN) this.env.fire?.(c.uid, FADE_IN_OUTPUT);
        break;
      }
      default:
        st.fader.stop();
    }
    this.recent.push({ uid: c.uid, msg, bone: bone >= 0 ? bone : undefined, opacity: st.fader.opacity });
    if (this.recent.length > 60) this.recent.shift();
    this.applyOpacity(c, st);
    return true;
  }

  /** Per frame: the carriers' clip events, fades and opacity. */
  update(dt: number, carriers: Iterable<BodyPartCarrier>) {
    const seen = new Set<number>();
    for (const c of carriers) {
      seen.add(c.uid);
      const st = this.state(c);
      st.fader.step(dt);
      const a = c.ch.current;
      const clip = a?.getClip();
      if (a && clip) {
        const t = a.time;
        const loop = a.loop !== THREE.LoopOnce;
        const evs = this.eventsOf(c.ch, clip);
        let fired: ItemEvent[] = [];
        if (clip !== st.clip) fired = t <= NEW_CLIP_WINDOW ? crossedEvents(evs, 0, t, clip.duration, loop, !loop && t >= clip.duration - 1e-4) : [];
        else if (t !== st.t) fired = crossedEvents(evs, st.t, t, clip.duration, loop, !loop && t >= clip.duration - 1e-4);
        st.clip = clip;
        st.t = t;
        for (const e of fired) this.message(c, e.msg, e.bone);
      }
      this.applyOpacity(c, st);
    }
    for (const [uid, st] of this.states) if (!seen.has(uid) && !st.mats) this.states.delete(uid);
  }

  /**
   * Saved games: each carrier's fader. The Character save writes its fader component (+0x562,
   * 0x100ac2e0: from, to, duration, elapsed, mode) and the load reads it back (0x100ac330)
   * [verified] (docs/re/saves.md "Character"). Without it a checkpoint taken after 1b's scene
   * faded Hermes in (85 %) came back with his creation fade (p182 0: opacity 0).
   */
  save(): FaderSave[] {
    const out: FaderSave[] = [];
    for (const [uid, st] of this.states) {
      const f = st.fader;
      out.push({ uid, from: f.from, to: f.to, duration: f.duration, elapsed: f.elapsed, mode: f.mode, ...(f.opacity === undefined ? {} : { opacity: f.opacity }) });
    }
    return out;
  }

  /** Restores the faders `save` wrote; the opacity goes to the carriers on the next update. */
  load(data: readonly FaderSave[] | undefined) {
    for (const d of data ?? []) {
      let st = this.states.get(d.uid);
      if (!st) this.states.set(d.uid, (st = { fader: new CharacterFader(), t: 0 }));
      const f = st.fader;
      f.from = d.from;
      f.to = d.to;
      f.duration = d.duration;
      f.elapsed = d.elapsed;
      f.mode = d.mode;
      f.opacity = d.opacity;
      st.applied = undefined;
    }
  }

  /** Opacity of a carrier (tests / overlay); undefined = never set (drawn as is). */
  opacityOf(uid: number): number | undefined {
    return this.states.get(uid)?.fader.opacity;
  }

  private applyOpacity(c: BodyPartCarrier, st: CarrierState) {
    const op = st.fader.opacity;
    if (op === undefined || op === st.applied) return;
    st.applied = op;
    const mesh = c.ch.mesh;
    const cur = mesh.material;
    // Copies made for another mesh (a carrier rebuilt by a load) are not this one's.
    if (st.mats && !(Array.isArray(cur) ? cur === st.mats : cur === st.mats[0])) {
      for (const m of st.mats) m.dispose();
      st.mats = undefined;
    }
    if (!st.mats) {
      // Own materials: carriers of one kind share theirs.
      const m = mesh.material;
      // Keeps the alpha test (three r186's NodeMaterial.copy drops it) and the glow mark.
      st.mats = (Array.isArray(m) ? m : [m]).map((x) => cloneWithGlowMark(x));
      mesh.material = st.mats.length === 1 ? st.mats[0] : st.mats;
    }
    for (const m of st.mats) {
      // Blended passes already blend; an opaque one starts blending (its depth write off).
      if (op < 1 && !m.transparent) {
        m.transparent = true;
        m.depthWrite = false;
        m.needsUpdate = true;
      }
      m.opacity = op;
    }
  }

  dispose() {
    for (const st of this.states.values()) for (const m of st.mats ?? []) m.dispose();
    this.states.clear();
  }
}
