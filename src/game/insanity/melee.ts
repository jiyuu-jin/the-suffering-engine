// Melee hits of the player's creature form, as the original's Melee Weapon does them
// (Suffering.rfl; docs/game-logic.md §13.9). Pure rules: no Three.js, no game state.
//
//   Arm window     an Attack's strike clip arms the Melee Weapon on the marker's bone at an Arm
//                  (100) event and disarms it at the next Disarm (101) (player Arm handler
//                  0x100286f0 -> 0x10027c60 -> arm 0x100ca210; disarm 0x100ca4c0, deferred until
//                  at least one sweep ran) [verified]. A clip without Arm events deals no damage.
//   Sweep          every frame while armed (0x100cb6c0 -> 0x100caff0) the weapon model's sphere
//                  nodes are swept from their previous to their current place: two nodes make a
//                  segment whose swept quad is tested, one node a sphere of its radius swept
//                  along its path [verified]. Creature form (Player 2:240 p231 / p232):
//                  4:155 on bone 31 is a segment from x -0.023 to x 1.177 (model 4:36),
//                  4:832 on bone 22 a sphere of radius 0.65 at the origin (model 4:135)
//                  [verified data; model units taken as metres, inferred].
//   Targets        the target's leaf hit spheres (skeleton sphere tree, 0x100c9680) [verified];
//                  the port uses the actor's capsule (radius, bottom..top) [inferred stand-in].
//                  Each target once per Arm window, several targets per swing; the wielder never
//                  [verified]. A ray from the wielder (its x / z at the hit's height) to the hit
//                  point that is blocked cancels that hit (0x100c9490) [verified].
//   Damage         Melee Weapon p68 (flat, 35 for both creature weapons) x the Attack's p6;
//                  p69 is the impact force, p70 the damage type (8) (0x100ca920) [verified].
//                  A player hitting an Unspeakable NPC also scales by lerp(Player p78 0.75,
//                  p79 1.25) over reputation p70..p71 (0x100e42e0 -> 0x10041f30) [verified].
//   Who            the player's own team takes nothing from the player (0x100e7390) [verified];
//                  vision NPCs with p167 = 2 (Torque's creature-self visions) reflect the blow
//                  onto the player while the player is transformed (0x10087010) [verified].
//   Air            the creature form's air-attack clip (PWP p164) is empty: no attack in the air;
//                  the p90 jump attack list is never read [verified].

export type Vec3 = [number, number, number];

export const ARM_EVENT = 100;
export const DISARM_EVENT = 101;
/** Kind of an animation message event (.adu type 5). */
const MESSAGE_KIND = 1;

export interface ArmWindow {
  /** Bone hash of the Arm marker (selects the weapon on that bone). */
  bone: number;
  /** Clip time (s, the clip's own time base) of the Arm and the Disarm. */
  t0: number;
  t1: number;
}

/**
 * Arm windows of a strike clip from its events: each Arm pairs with the next Disarm on the same
 * bone (or any bone when the clip names none), else the clip's end.
 */
export function armWindows(events: readonly { kind: number; time: number; boneHash: number; param: number }[], duration: number): ArmWindow[] {
  const msgs = events.filter((e) => e.kind === MESSAGE_KIND).slice().sort((a, b) => a.time - b.time);
  const out: ArmWindow[] = [];
  for (const e of msgs) {
    if (e.param !== ARM_EVENT) continue;
    const off = msgs.find((d) => d.param === DISARM_EVENT && d.time >= e.time && d.boneHash === e.boneHash) ?? msgs.find((d) => d.param === DISARM_EVENT && d.time >= e.time && !d.boneHash);
    out.push({ bone: e.boneHash >>> 0, t0: e.time, t1: off ? off.time : duration });
  }
  return out;
}

/** A Melee Weapon's hit shape in its bone's space: a segment (b set) or a sphere of radius r. */
export interface MeleeShape {
  a: Vec3;
  b?: Vec3;
  r: number;
}

/** The creature form's arm weapons by Player p231 template (shape data of their models). */
export const CREATURE_WEAPON_SHAPES: Record<string, MeleeShape> = {
  '4:155': { a: [-0.023, 0, 0], b: [1.177, 0, 0], r: 0 },
  '4:832': { a: [0, 0, 0], r: 0.65 },
};

export interface Capsule {
  x: number;
  z: number;
  /** Bottom and top (world y). */
  y0: number;
  y1: number;
  r: number;
}

/** Closest points of segments p0-p1 and q0-q1: parameters s, t in [0, 1] and the distance. */
export function segmentDistance(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3): { s: number; t: number; d: number } {
  const d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) (t = 0), (s = clamp01(-c / a));
      else if (t > 1) (t = 1), (s = clamp01((b - c) / a));
    }
  }
  const cp = add(p0, scale(d1, s)), cq = add(q0, scale(d2, t));
  return { s, t, d: Math.hypot(cp[0] - cq[0], cp[1] - cq[1], cp[2] - cq[2]) };
}

/**
 * Sweep test of a weapon shape that moved from (prevA, prevB) to (curA, curB) this frame against
 * a capsule: the swept quad / swept sphere is sampled in `steps` slices. Returns the contact
 * point on the weapon, or null.
 */
export function sweepCapsule(prevA: Vec3, prevB: Vec3, curA: Vec3, curB: Vec3, r: number, c: Capsule, steps = 6): Vec3 | null {
  const q0: Vec3 = [c.x, Math.min(c.y0, c.y1), c.z], q1: Vec3 = [c.x, Math.max(c.y0, c.y1), c.z];
  let best: { d: number; p: Vec3 } | null = null;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const a = lerp3(prevA, curA, k), b = lerp3(prevB, curB, k);
    const h = segmentDistance(a, b, q0, q1);
    if (h.d <= c.r + r && (!best || h.d < best.d)) best = { d: h.d, p: lerp3(a, b, h.s) };
  }
  return best ? best.p : null;
}

/**
 * Sweep test against leaf hit spheres (0x100c9680 tests the skeleton sphere tree's leaves): the
 * centre of the sphere the weapon comes deepest into, or null. Used for bodies on the floor,
 * where the standing capsule stand-in does not fit.
 */
export function sweepSpheres(prevA: Vec3, prevB: Vec3, curA: Vec3, curB: Vec3, r: number, spheres: readonly { c: Vec3; r: number }[], steps = 6): Vec3 | null {
  let best: { d: number; p: Vec3 } | null = null;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const a = lerp3(prevA, curA, k), b = lerp3(prevB, curB, k);
    for (const s of spheres) {
      const d = segmentDistance(a, b, s.c, s.c).d - s.r;
      if (d <= r && (!best || d < best.d)) best = { d, p: s.c };
    }
  }
  return best ? best.p : null;
}

/** Damage of one creature blow: Melee Weapon p68 x Attack p6 (x the reputation scale). */
export function meleeDamage(p68: number, attackScale: number, reputationScale = 1): number {
  return p68 * attackScale * reputationScale;
}

/** Player-on-Unspeakable-NPC scale: lerp(p78, p79) over reputation p70..p71, clamped. */
export function reputationDamageScale(reputation: number, range: readonly [number, number] = [-150, 150], scale: readonly [number, number] = [0.75, 1.25]): number {
  const [lo, hi] = range;
  const t = hi > lo ? clamp01((reputation - lo) / (hi - lo)) : 0.5;
  return scale[0] + (scale[1] - scale[0]) * t;
}

export interface MeleeTarget {
  alive: boolean;
  hidden?: boolean;
  decor?: boolean;
  team?: string;
  /** NPC p167: 1 = Torque's human-self vision, 2 = his creature-self vision. */
  vision?: number;
  /** A dead body with Part Caps left: the blow still runs its part-cap test (actors/dismember.ts). */
  cuttable?: boolean;
}

/**
 * What a creature-form blow does to a target: 'hit', 'skip' (dead, hidden, decoration, the
 * player's own team) or 'reflect' (a p167 = 2 vision while transformed: the player takes it).
 * A dead body is struck only while it can still lose a part (the Character damage runs on
 * corpses: 0x100e7390 -> Part Caps 0x10119150).
 */
export function creatureBlowOutcome(t: MeleeTarget, playerTeam: string): 'hit' | 'skip' | 'reflect' {
  if ((!t.alive && !t.cuttable) || t.hidden || t.decor) return 'skip';
  if (t.team && t.team === playerTeam) return 'skip';
  if (t.vision === 2) return 'reflect';
  return 'hit';
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function lerp3(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
