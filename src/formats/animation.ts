// Riot Engine skeletal animation clips (.adu).
//
// Each clip is a group of entries sharing an id (group 5). The SRSC `extra`
// field is the clip's animation-set id: the same value as the `extra` of the
// skinned .mdu entries of the rig it was authored for (per package). Clips
// carry no names; they are referenced by (id, package) from object templates.
//
// type 1 (28 bytes) header (SUFFERING.EXE loader 0x473ba0; clip object vtable 0x591650)
//   f32 duration (s)
//   u32 flags     bit 0 = plays once (start time clamped, held at the end; else it loops and
//                 the root displacement carries over each wrap), bit 1 = always animated at the
//                 full rate (exempt from distance-based animation LOD, 0x474d43; inferred)
//   u32 trackCount
//   f32 blendTime (s) default blend INTO this clip (0.2 x1323, 0 x271, 0.4, 0.35 ...)
//   f32 rate      playback speed multiplier (request speed x rate; usually 1.0)
//   f32, f32      editor values (0.01 / 1.0 mostly); never read by the runtime
//   Translations are in model units here; the engine scales them by 2048 at load (0x4736c0)
//   and keeps the first track's (root's) whole displacement, extrapolated to the duration.
//
// type 2 tracks
//   u32 trackCount
//   trackCount x { u32 boneHash, u32 keyOffset, u32 countAndFlags, f32[3] translation }
//     countAndFlags: low 24 bits = key count, top byte = format:
//       0x80  keys are { f32 time, f32 qx,qy,qz,qw, f32 tx,ty,tz }   (32 bytes)
//       0xc0  keys are { f32 time, f32 qx,qy,qz,qw }                 (20 bytes), translation is
//             the constant f32[3] of the track record
//       0x00  no keys (bone not animated: keep the bind pose)
//   u32 keyDataSize
//   key data; keyOffset is relative to the start of the key data.
//   Keys are sparse (reduced) and carry explicit times (authored at 30 fps).
//   Values are bone-local (relative to the parent bone): local = T(t) · R(q), the
//   same convention as Three.js Object3D (position, quaternion). The root bone's
//   translation is the character's root motion in model space (-Z = forward,
//   verified by planted feet staying put while the root moves).
//   Some clips have more tracks than a rig has bones (weapon/prop bones); tracks
//   bind by hash and unknown hashes are ignored.
//
// type 4 (optional) transition blends (0x473c50): u16 count, count x { u16 id, u16 pkg,
//                    f32 blend }: "when this clip replaces clip <id>, blend for <blend> s"; other
//                    clips use the header blendTime (0x473b60). The package half is replaced by the
//                    clip's own package at load (always equal in retail data). 35 clips.
// type 5 (optional) events (0x473d00): u32 count, count x { u32 kind, f32 time, u32 boneHash,
//                    [u32 param: kinds 0 and 1 only] }, u32 poolCount, poolCount x sound ref.
//                    kind 0 = sound (param = ref pkg<<16|id, 0 = random pick from the pool without
//                    an immediate repeat), kind 1 = message `param` to the owner (ANIM_MESSAGES),
//                    with the bone index. Fired in the window [previous, current) clip time, on
//                    the channel that owns the bone (0x470500 / 0x4703f0). Only kinds 0 / 1 occur.

import type { SrscFile } from './srsc';
import { findEntry } from './model';
import { ROOT_BONE_HASH, type Skeleton, type Vec3 } from './skeleton';
export { ROOT_BONE_HASH };

export const ADU_HEADER = 1;
export const ADU_TRACKS = 2;
export const ADU_LINKS = 4;
export const ADU_EVENTS = 5;
/** SRSC group of clip entries (the container header is type 2 group 4). */
export const ADU_GROUP = 5;

export const TRACK_FULL = 0x80;
export const TRACK_ROTATION = 0xc0;

export interface AnimTrack {
  boneHash: number;
  format: number;
  /** Key times in seconds. */
  times: Float32Array;
  /** xyzw per key (normalised). */
  rotations: Float32Array;
  /** xyz per key for TRACK_FULL tracks, undefined otherwise. */
  translations?: Float32Array;
  /** Constant translation for TRACK_ROTATION tracks. */
  constantTranslation: Vec3;
}

export interface AnimClipData {
  id: number;
  /** Animation-set id (SRSC extra). */
  animSet: number;
  duration: number;
  flags: number;
  blendTime: number;
  rate: number;
  tracks: AnimTrack[];
  /** Transition blends (type 4): blend time when this clip replaces clip (id, pkg). */
  links: ClipLink[];
}

export interface ClipLink {
  id: number;
  pkg: number;
  /** Blend time (s) when this clip replaces that clip. */
  blend: number;
}

/** Header flag bit 0: the clip plays once and holds its last frame (else it loops). */
export const CLIP_ONCE = 1;
/** Header flag bit 1: always animated at the full update rate (no distance LOD) [inferred]. */
export const CLIP_FULL_RATE = 2;

/**
 * Blend time when `clip` replaces `from` (SUFFERING.EXE 0x473b60): the type-4 entry for that
 * clip, else the clip's header blend time. An explicit blend of the request overrides both.
 */
export function blendInto(clip: AnimClipData, from?: { id: number; pkg?: number }): number {
  if (from) for (const l of clip.links) if (l.id === from.id && (from.pkg === undefined || l.pkg === from.pkg)) return l.blend;
  return clip.blendTime;
}

export interface AnimClipInfo {
  id: number;
  animSet: number;
  duration: number;
  flags: number;
  trackCount: number;
}

/** Cheap directory of the clips in an .adu (reads only the 28-byte headers). */
export function listAnimations(adu: SrscFile, animSet?: number): AnimClipInfo[] {
  const out: AnimClipInfo[] = [];
  for (const e of adu.entries) {
    if (e.type !== ADU_HEADER || e.group !== ADU_GROUP || e.size < 12) continue;
    if (animSet !== undefined && e.extra !== animSet) continue;
    const v = adu.data(e);
    out.push({
      id: e.id,
      animSet: e.extra,
      duration: v.getFloat32(0, true),
      flags: v.getUint32(4, true),
      trackCount: v.getUint32(8, true),
    });
  }
  return out;
}

export function readAnimation(adu: SrscFile, id: number): AnimClipData | undefined {
  const et = adu.entries.find((e) => e.type === ADU_TRACKS && e.group === ADU_GROUP && e.id === id);
  if (!et || et.size < 8) return undefined;
  const eh = findEntry(adu, ADU_HEADER, id);
  const v = adu.data(et);
  const n = v.getUint32(0, true);
  const tableEnd = 4 + 24 * n;
  if (n > 4096 || tableEnd + 4 > v.byteLength) return undefined;
  const dataSize = v.getUint32(tableEnd, true);
  const base = tableEnd + 4;
  if (base + dataSize > v.byteLength) return undefined;

  const tracks: AnimTrack[] = [];
  let maxTime = 0;
  for (let i = 0; i < n; i++) {
    const r = 4 + 24 * i;
    const boneHash = v.getUint32(r, true);
    const off = v.getUint32(r + 4, true);
    const cf = v.getUint32(r + 8, true);
    const count = cf & 0xffffff;
    const format = cf >>> 24;
    const constantTranslation: Vec3 = [v.getFloat32(r + 12, true), v.getFloat32(r + 16, true), v.getFloat32(r + 20, true)];
    if (count === 0 || (format !== TRACK_FULL && format !== TRACK_ROTATION)) continue;
    const stride = format === TRACK_FULL ? 32 : 20;
    if (off + stride * count > dataSize) continue;
    const times = new Float32Array(count);
    const rotations = new Float32Array(count * 4);
    const translations = format === TRACK_FULL ? new Float32Array(count * 3) : undefined;
    for (let k = 0; k < count; k++) {
      const p = base + off + stride * k;
      times[k] = v.getFloat32(p, true);
      let x = v.getFloat32(p + 4, true), y = v.getFloat32(p + 8, true);
      let z = v.getFloat32(p + 12, true), w = v.getFloat32(p + 16, true);
      const len = Math.hypot(x, y, z, w) || 1;
      x /= len; y /= len; z /= len; w /= len;
      // Keep consecutive keys in the same hemisphere so linear blending takes the short path.
      if (k > 0) {
        const q = rotations.subarray((k - 1) * 4, k * 4);
        if (q[0] * x + q[1] * y + q[2] * z + q[3] * w < 0) { x = -x; y = -y; z = -z; w = -w; }
      }
      rotations.set([x, y, z, w], k * 4);
      if (translations) translations.set([v.getFloat32(p + 20, true), v.getFloat32(p + 24, true), v.getFloat32(p + 28, true)], k * 3);
    }
    maxTime = Math.max(maxTime, times[count - 1]);
    tracks.push({ boneHash, format, times, rotations, translations, constantTranslation });
  }

  let duration = maxTime, flags = 0, blendTime = 0, rate = 1;
  if (eh && eh.size >= 20) {
    const h = adu.data(eh);
    duration = h.getFloat32(0, true) || maxTime;
    flags = h.getUint32(4, true);
    blendTime = h.getFloat32(12, true);
    rate = h.getFloat32(16, true) || 1;
  }
  const links = readClipLinks(adu, id);
  return { id, animSet: et.extra, duration, flags, blendTime, rate, tracks, links };
}

/** Fraction of the clip's tracks that bind to bones of `skeleton` (1 = authored for this rig). */
export function clipCoverage(clip: AnimClipData, skeleton: Skeleton): number {
  if (!clip.tracks.length) return 0;
  let hit = 0;
  for (const t of clip.tracks) if (skeleton.byHash.has(t.boneHash)) hit++;
  return hit / clip.tracks.length;
}

/** Root translation at the last key minus the first (model units, -Z forward, +X right). */
export function rootMotion(clip: AnimClipData, rootHash = ROOT_BONE_HASH): Vec3 {
  const t = clip.tracks.find((x) => x.boneHash === rootHash) ?? clip.tracks[0];
  if (!t?.translations || t.times.length < 2) return [0, 0, 0];
  const a = t.translations, e = a.length - 3;
  return [a[e] - a[0], a[e + 1] - a[1], a[e + 2] - a[2]];
}

/**
 * Heuristic label from root motion and duration (the files carry no names):
 * "run_forward", "walk_back", "strafe_left", "idle", "action", "pose", ...
 * Character space: -Z forward, +X = the character's right (right-handed, Y up).
 */
export function guessClipLabel(clip: AnimClipData): string {
  const [dx, dy, dz] = rootMotion(clip);
  const d = Math.max(clip.duration, 1e-3);
  const horiz = Math.hypot(dx, dz);
  const speed = horiz / d;
  if (speed > 0.6 && horiz > 0.3) {
    const gait = speed > 2.6 ? 'run' : 'walk';
    const ang = Math.atan2(-dx, -dz) * (180 / Math.PI); // 0 = forward, +90 = left
    let dir: string;
    if (Math.abs(ang) <= 30) dir = 'forward';
    else if (Math.abs(ang) >= 150) dir = 'back';
    else if (Math.abs(ang) >= 60 && Math.abs(ang) <= 120) dir = ang > 0 ? 'left' : 'right';
    else dir = (Math.abs(ang) < 90 ? 'forward_' : 'back_') + (ang > 0 ? 'left' : 'right');
    return dir === 'left' || dir === 'right' ? `strafe_${dir}` : `${gait}_${dir}`;
  }
  if (Math.abs(dy) > 0.5) return dy > 0 ? 'climb_up' : 'drop_down';
  if (clip.duration <= 0.1) return 'pose';
  // Count keyed tracks: an "idle" is long and mostly still.
  const moving = clip.tracks.filter((t) => t.times.length > 2).length;
  if (moving === 0) return 'pose';
  if (clip.duration >= 1.8) return 'idle_or_long_action';
  return 'action';
}

/**
 * Translation of a bone track at clip time t (linear between keys, clamped), model units; the
 * root bone by default. Rotation-only tracks give their constant translation.
 */
export function sampleTrackTranslation(clip: AnimClipData, t: number, boneHash = ROOT_BONE_HASH): Vec3 {
  const tr = clip.tracks.find((x) => x.boneHash === boneHash);
  if (!tr) return [0, 0, 0];
  const v = tr.translations;
  if (!v) return [...tr.constantTranslation] as Vec3;
  const ts = tr.times;
  const n = ts.length;
  if (t <= ts[0] || n === 1) return [v[0], v[1], v[2]];
  if (t >= ts[n - 1]) return [v[(n - 1) * 3], v[(n - 1) * 3 + 1], v[(n - 1) * 3 + 2]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= t) lo = m;
    else hi = m;
  }
  const u = (t - ts[lo]) / Math.max(1e-6, ts[hi] - ts[lo]);
  return [0, 1, 2].map((c) => v[lo * 3 + c] + (v[hi * 3 + c] - v[lo * 3 + c]) * u) as Vec3;
}

/**
 * Rotation (x, y, z, w) of a bone track at clip time t (spherical between keys, the shorter
 * way, as the three.js quaternion tracks the clips are built into; clamped), the root bone by
 * default. Identity when the clip has no such track.
 */
export function sampleTrackRotation(clip: AnimClipData, t: number, boneHash = ROOT_BONE_HASH): [number, number, number, number] {
  const tr = clip.tracks.find((x) => x.boneHash === boneHash);
  if (!tr) return [0, 0, 0, 1];
  const q = tr.rotations;
  const ts = tr.times;
  const n = ts.length;
  const at = (k: number): [number, number, number, number] => [q[k * 4], q[k * 4 + 1], q[k * 4 + 2], q[k * 4 + 3]];
  if (t <= ts[0] || n === 1) return at(0);
  if (t >= ts[n - 1]) return at(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= t) lo = m;
    else hi = m;
  }
  const u = (t - ts[lo]) / Math.max(1e-6, ts[hi] - ts[lo]);
  const a = at(lo), b = at(hi);
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = cos < 0 ? -1 : 1;
  cos *= s;
  let wa = 1 - u, wb = u;
  if (cos < 0.9995) {
    const th = Math.acos(Math.min(1, cos)), sn = Math.sin(th);
    wa = Math.sin((1 - u) * th) / sn;
    wb = Math.sin(u * th) / sn;
  }
  const r = [0, 1, 2, 3].map((c) => a[c] * wa + s * b[c] * wb) as [number, number, number, number];
  const l = Math.hypot(...r) || 1;
  return r.map((x) => x / l) as [number, number, number, number];
}

/** Type-4 transition blends of a clip (8 bytes each; see the header). */
export function readClipLinks(adu: SrscFile, id: number): ClipLink[] {
  const out: ClipLink[] = [];
  const el = findEntry(adu, ADU_LINKS, id);
  if (!el || el.size < 2) return out;
  const l = adu.data(el);
  const c = l.getUint16(0, true);
  for (let k = 0; k < c && 2 + 8 * k + 8 <= l.byteLength; k++) {
    const o = 2 + 8 * k;
    out.push({ id: l.getUint16(o, true), pkg: l.getUint16(o + 2, true), blend: l.getFloat32(o + 4, true) });
  }
  return out;
}

export const ANIM_EVENT_SOUND = 0;
export const ANIM_EVENT_MESSAGE = 1;

export interface AnimEvent {
  kind: number;
  /** Clip time (s). */
  time: number;
  boneHash: number;
  /** Kind 0: sound ref as pkg << 16 | id (0 = pick from the pool); kind 1: message id. */
  param: number;
}

export interface AnimEvents {
  events: AnimEvent[];
  /** Sounds a kind-0 event with param 0 picks from (random, no immediate repeat). */
  pool: { id: number; pkg: number }[];
  /** Bytes decoded (equals the entry size on retail data). */
  byteLength: number;
}

/**
 * Message ids of kind-1 animation events (the RFL's message name table at 0x10174658; the
 * ids retail clips use). Footsteps: 200 + footstep kind (src/game/fx/footsteps.ts).
 */
export const ANIM_MESSAGES: Record<number, string> = {
  5: 'Disable', 15: 'Unlock', 92: 'Breath',
  100: 'Arm', 101: 'Disarm', 102: 'Fire', 103: 'AmmoEject', 104: 'DetachWeaponFX', 108: 'Equip',
  112: 'CanAttack', 113: 'CannotAttack', 114: 'AttackEffect', 115: 'CanImpale', 116: 'CannotImpale', 117: 'ImpaleThrow',
  150: 'DropItem', 151: 'SpawnItem', 152: 'DestroyItem', 153: 'SpawnWeapons', 154: 'SpawnAttachments', 157: 'BlowupItem',
  200: 'FootStep_Light', 201: 'FootStep_Heavy', 202: 'FootStep_Scuff', 203: 'FootStep_Sneak', 204: 'FootStep_Land', 205: 'FootStep_BodyFall',
  206: 'StartFadeIn', 207: 'StopFadeIn', 208: 'StartFadeOut', 209: 'StopFadeOut',
  220: 'MorphCharacter', 230: 'ThrowWeapon', 231: 'AttachThrownWeapon',
  400: 'StartInteract', 401: 'EndInteract',
  450: 'SpawnEffect', 451: 'CapLimb', 454: 'TriggerSwitch', 455: 'Emerge', 456: 'StartVulnerable', 457: 'EndVulnerable', 458: 'Recede',
  460: 'SpawnRat',
};

/** Decode a clip's type-5 events (see the header), or undefined without / with a bad entry. */
export function readAnimEvents(adu: SrscFile, id: number): AnimEvents | undefined {
  const e = findEntry(adu, ADU_EVENTS, id);
  if (!e || e.size < 8) return undefined;
  const v = adu.data(e);
  try {
    const n = v.getUint32(0, true);
    if (n > 4096) return undefined;
    let p = 4;
    const events: AnimEvent[] = [];
    for (let i = 0; i < n; i++) {
      const kind = v.getUint32(p, true);
      const time = v.getFloat32(p + 4, true);
      const boneHash = v.getUint32(p + 8, true);
      p += 12;
      let param = 0;
      if (kind === ANIM_EVENT_SOUND || kind === ANIM_EVENT_MESSAGE) {
        param = v.getUint32(p, true);
        p += 4;
      }
      events.push({ kind, time, boneHash, param });
    }
    const m = v.getUint32(p, true);
    p += 4;
    const pool: { id: number; pkg: number }[] = [];
    for (let i = 0; i < m; i++, p += 4) pool.push({ id: v.getUint16(p, true), pkg: v.getUint16(p + 2, true) });
    return { events, pool, byteLength: p };
  } catch {
    return undefined;
  }
}

/**
 * Events due when a clip advances from t0 to t1 (window [t0, t1), wrapping for a looping clip
 * when t1 < t0; SUFFERING.EXE 0x470500). For reverse play pass the bounds swapped.
 */
export function eventsInWindow<T extends { time: number }>(events: readonly T[], t0: number, t1: number): T[] {
  if (t0 === t1) return [];
  if (t0 < t1) return events.filter((e) => e.time >= t0 && e.time < t1);
  return events.filter((e) => e.time >= t0 || e.time < t1);
}
