// Third-person gait of the player (PlayerBody): the original's heading sets, and phase-aligned
// gait cycles so walk / run clips can be switched and blended without the feet jumping.
//
// The original (Suffering.rfl Move per-frame 0x10045d70, docs/re/player.md §6):
//   * The held weapon's Player Weapon Properties carry four heading sets at p17 + 5s:
//     {heading bound (deg), walk clip, walk speed, run clip, run speed}. The stick angle
//     relative to the body (clockwise, 0 = forward) falls in set s when it lies in
//     [bound(s-1), bound(s)) (bounds 45 / 135 / 225 / 315: forward, right, back, left); the
//     set being played keeps 10 % of its width extra on each side (0x10045290 / 0x10045200).
//   * The body turns so that the movement runs along the set's centre: diagonal input plays
//     the forward (or strafe) clip with the body turned up to 45 deg into the movement, at
//     width / Player p154 = 90 / 0.35 = 257 deg/s (0x10045550).
//   * Ground speed is the set's walk or run speed (the stick magnitude above Player p144 runs);
//     the clip plays at rate 1. The gait clips have no root motion: the speed slot is what
//     their feet are animated for (2:30 walk feet move back at ~1.6 m/s for p19 = 1.626).
//
// Port: `pickHeadingSet` is the sector choice; `GaitCycles` builds, per (walk clip, run clip,
// speed), one looping clip re-timed so that phase 0 is the right foot's mid-stance, blending
// the walk and run poses when the wanted speed lies between the set's walk and run speeds
// (the port's default walk, 3 m/s, has no clip of its own). Any two gait clips therefore share
// the same phase and the body switches between them at the same normalised time.

import * as THREE from 'three/webgpu';
import type { Skeleton } from '../../formats/skeleton';

/** One heading set of a Player Weapon Properties template (clip = index into the body's clips). */
export interface HeadingSet {
  /** Upper bound of the sector, degrees clockwise from forward (p17 + 5s). */
  bound: number;
  walk: number;
  walkSpeed: number;
  run: number;
  runSpeed: number;
}

/** Hysteresis of the set being played: share of its sector width added on both sides. */
export const SET_HYSTERESIS = 0.1;

const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/** Width (deg) of set i's sector. */
export function setWidth(sets: readonly HeadingSet[], i: number): number {
  const n = sets.length;
  return wrap360(sets[i].bound - sets[(i + n - 1) % n].bound) || 360;
}

/** Centre (deg, clockwise from forward) of set i's sector. */
export function setCentre(sets: readonly HeadingSet[], i: number): number {
  return wrap360(sets[i].bound - setWidth(sets, i) / 2);
}

/**
 * The heading set for stick angle `angle` (deg, clockwise from forward) - 0x10045290: the first
 * set whose bound is above the angle (none: set 0); the previous set `prev` widens its own sector
 * by 10 % of its width on both sides (its predecessor's bound moves down, its own up).
 */
export function pickHeadingSet(sets: readonly HeadingSet[], angle: number, prev = -1): number {
  const n = sets.length;
  if (!n) return -1;
  const a = wrap360(angle);
  if (prev >= 0 && prev < n) {
    // Same test as the engine, done on the angle relative to the widened sector.
    const w = setWidth(sets, prev), m = SET_HYSTERESIS * w;
    const lo = sets[(prev + n - 1) % n].bound - m;
    if (wrap360(a - lo) < w + 2 * m) return prev;
  }
  for (let i = 0; i < n; i++) if (a < sets[i].bound) return i;
  return 0;
}

/**
 * Body facing offset (radians, added to the view yaw; the port's yaw grows to the left) that
 * puts movement at stick angle `angle` on set i's centre.
 */
export function setFacingOffset(sets: readonly HeadingSet[], i: number, angle: number): number {
  let d = wrap360(angle - setCentre(sets, i));
  if (d > 180) d -= 360;
  return (-d * Math.PI) / 180;
}

// ---------------------------------------------------------------------------
// Phase-aligned cycles

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

type Sampler = (t: number) => ArrayLike<number>;

function samplers(clip: THREE.AnimationClip): Map<string, Sampler> {
  const out = new Map<string, Sampler>();
  for (const tr of clip.tracks) {
    // createInterpolant() is public in three.js but missing from its type declarations.
    const ip = (tr as unknown as { createInterpolant(): { evaluate(t: number): ArrayLike<number> } }).createInterpolant();
    out.set(tr.name, (t) => ip.evaluate(t));
  }
  return out;
}

/** The right foot's ankle: the lowest non-root bone above the toes on the +X side. */
export function rightAnkle(skel: Skeleton): number {
  let best = -1;
  for (const b of skel.bones) {
    const x = b.bindWorld[12], y = b.bindWorld[13];
    if (b.parent < 0 || x <= 0.05 || y < 0.05 || y > 0.2 || !b.children.length) continue;
    if (best < 0 || y < skel.bones[best].bindWorld[13]) best = b.index;
  }
  return best;
}

/** Normalised time (0..1) of the lowest point of bone `bone` (model space) over the clip. */
export function contactPhase(clip: THREE.AnimationClip, skel: Skeleton, bone: number, n = 64): number {
  if (bone < 0 || !(clip.duration > 0)) return 0;
  const chain: number[] = [];
  for (let b = bone; b >= 0; b = skel.bones[b].parent) chain.unshift(b);
  const s = samplers(clip);
  let best = 0, low = Infinity;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * clip.duration;
    const m = new THREE.Matrix4();
    for (const b of chain) {
      const sb = skel.bones[b];
      const q = s.get(`${sb.name}.quaternion`)?.(t);
      const p = s.get(`${sb.name}.position`)?.(t);
      _q.set(...((q ? [q[0], q[1], q[2], q[3]] : sb.quaternion) as [number, number, number, number]));
      _p.set(...((p ? [p[0], p[1], p[2]] : sb.position) as [number, number, number]));
      m.multiply(_m.compose(_p, _q, _s));
    }
    if (m.elements[13] < low) (low = m.elements[13]), (best = k / n);
  }
  return best;
}

export interface GaitCycle {
  clip: THREE.AnimationClip;
  /** Ground speed (m/s) the cycle's feet are animated for. */
  speed: number;
}

/**
 * One looping cycle starting at the right foot's mid-stance: walk clip `a` (phase pa, rate ra,
 * speed va) blended with run clip `b` by `alpha` (0 = walk). Its length keeps the stride of the
 * blend: lerp(va * Ta, vb * Tb) / lerp(va, vb).
 */
export function blendCycle(
  name: string,
  a: { clip: THREE.AnimationClip; phase: number; rate: number; speed: number },
  b: { clip: THREE.AnimationClip; phase: number; rate: number; speed: number },
  alpha: number,
  skel: Skeleton,
  keys = 40,
): GaitCycle {
  const Ta = a.clip.duration / (a.rate || 1), Tb = b.clip.duration / (b.rate || 1);
  const speed = a.speed + (b.speed - a.speed) * alpha;
  const stride = a.speed * Ta + (b.speed * Tb - a.speed * Ta) * alpha;
  const T = speed > 1e-3 ? stride / speed : Ta + (Tb - Ta) * alpha;
  const sa = samplers(a.clip), sb = samplers(b.clip);
  const names = new Set([...sa.keys(), ...sb.keys()]);
  const byName = new Map(skel.bones.map((x) => [x.name, x]));
  const times = new Float32Array(keys + 1);
  for (let k = 0; k <= keys; k++) times[k] = (k / keys) * T;
  const tracks: THREE.KeyframeTrack[] = [];
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  for (const nm of names) {
    const dot = nm.lastIndexOf('.');
    const bone = byName.get(nm.slice(0, dot));
    if (!bone) continue;
    const prop = nm.slice(dot + 1);
    const fa = sa.get(nm), fb = sb.get(nm);
    const rot = prop === 'quaternion';
    const size = rot ? 4 : 3;
    const vals = new Float32Array((keys + 1) * size);
    for (let k = 0; k <= keys; k++) {
      const u = (k % keys) / keys;
      const ta = ((a.phase + u) % 1) * a.clip.duration, tb = ((b.phase + u) % 1) * b.clip.duration;
      const va = fa ? fa(ta) : rot ? bone.quaternion : bone.position;
      const vb = fb ? fb(tb) : rot ? bone.quaternion : bone.position;
      if (rot) {
        qa.set(va[0], va[1], va[2], va[3]);
        qb.set(vb[0], vb[1], vb[2], vb[3]);
        qa.slerp(qb, alpha);
        vals.set([qa.x, qa.y, qa.z, qa.w], k * 4);
      } else for (let c = 0; c < 3; c++) vals[k * 3 + c] = va[c] + (vb[c] - va[c]) * alpha;
    }
    tracks.push(rot ? new THREE.QuaternionKeyframeTrack(nm, times, vals) : new THREE.VectorKeyframeTrack(nm, times, vals));
  }
  return { clip: new THREE.AnimationClip(name, T, tracks), speed };
}

// ---------------------------------------------------------------------------
// Clip events of a gait cycle

/**
 * The retail clip whose type-5 events (footstep markers) a re-timed gait cycle plays: its clip
 * id / animation set and the normalised time of that clip at the cycle's start. The original
 * plays the walk or the run clip itself and fires that clip's markers (docs/re/animation.md §7);
 * the port's cycle stands for the clip it is mostly made of (PlayerBody.gaitSource).
 */
export interface ClipEventSource {
  id: number;
  animSet: number;
  /** The source clip's length (its event times are in this clock). */
  duration: number;
  phase: number;
}

const EVENT_SOURCE = 'eventSource';

export function setClipEventSource(clip: THREE.AnimationClip, src: ClipEventSource): void {
  clip.userData[EVENT_SOURCE] = src;
}

export function clipEventSource(clip: THREE.AnimationClip): ClipEventSource | undefined {
  const v = clip.userData?.[EVENT_SOURCE] as ClipEventSource | undefined;
  return v && Number.isFinite(v.id) && Number.isFinite(v.phase) ? v : undefined;
}

/**
 * Time in a cycle of length `cycleDuration` of an event at `time` in its source clip of length
 * `sourceDuration` (the cycle starts at the source's normalised `phase`).
 */
export function cycleEventTime(time: number, sourceDuration: number, phase: number, cycleDuration: number): number {
  if (!(sourceDuration > 0)) return 0;
  const u = time / sourceDuration - phase;
  return (((u % 1) + 1) % 1) * cycleDuration;
}
