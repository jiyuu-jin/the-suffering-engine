// Particle Fountain damage volumes: the 1a gas chamber's gas (docs/game-logic.md §14.2).
//
// Decoded from Suffering.rfl / SUFFERING.EXE [verified unless marked]:
//   * The Particle Fountain's touch handler (vtable +0x24, 0x1011c0a0) runs only while the
//     fountain is On (engine object +8 & 0xc: the On handler 0x10119ad0 sets that mode through
//     vt +0xfc(8), Off 0x10119b50 clears it with vt +0xfc(0)).
//   * For a damageable object (0x100a1ff0: game object +0x60, +8 bit 0) it builds a damage
//     record (0x10001190) of p18 x the frame time (p18 read as an integer: damage per second),
//     impact force p20, damage type p19, the fountain (or its owner, +0x24) as the inflictor,
//     and hands it to the target's damage virtual (vt +0x58): the ordinary GameObject damage, so
//     the target's Damage Resistance attachments apply (docs/re/properties.md).
//   * p21 names a template spawned on what it touches (a burn effect on the flamethrower's
//     fountain 4:869); the gas templates leave it empty [port: not spawned here].
//   * Who touches it. Nothing scans the fountain's volume: the touch comes from the MOVER's own
//     collision query. The player's per-frame step (Player vt +0x20 0x1004bf90 -> 0x1002cb50)
//     queries the collision world twice: its movement proxy ([+0xd0] -> handle +0xdc) with the
//     solid classes (filter 0x1002c340(1)), then its own body ([+4], listener vt +0x34 ->
//     0x426420, flags 0x61) with a filter (0x1002c340(0)) that makes Particle Fountain and Fire
//     "collide" classes. Characters query through their touch component (+0x1ae, 0x1009fbc6):
//     the object is the component's mover ([+0x34] -> handle +0xdc, 0x1002c500), the collide
//     list 0x10178c40 the solid classes plus Detector, Particle Fountain and Fire. Each contact
//     found is passed both ways (listener vt +0x3c -> 0x424880 / 0x4248d0), which calls the
//     fountain's handler with the mover in the touch record (+0x30).
//   * The contact test (0x425a80 -> 0x428b30) is geometric, with no allowance: bounding spheres,
//     then the world boxes (engine object +0x78, 0x4d4d40), then the two collision trees. The
//     fountain's is its model's boxes (the 1a room gas 3:1213 carries model 3:139, ONE box
//     6 x 0.001 x 6 m whose bottom face lies exactly on the chamber floor; the tank's 3:112
//     carries 3:1009, a 1 m box scaled 3 x 2 x 3). A character's is its skeleton's sphere tree
//     (formats/skeleton.ts trailer: 24-byte nodes, radius +0x10, bone +0x14; first child /
//     next sibling), each sphere following its bone; contacts come from the leaves (sphere vs box
//     0x418810, sphere vs sphere 0x4d2a00) [leaves only: inferred from the traversal].
//   * So the player is hurt by a floor tile only while one of his hit spheres reaches into the
//     tile's 1 mm: standing on it they do (third person, 2:9: the left foot sphere hangs 2.4 cm
//     below the soles in the bind pose; first person, 2:138: a column of r 0.4 spheres on the
//     root, the lowest centred 0.25 m up), at 13 / s per tile. Off the tiles nothing touches:
//     the 1.1 m strip along the chamber's north wall, under the window, has no tile.
//   * A character touches with its mover [inferred: the proxy's shape is the body's movement
//     volume, resting on the floor; port: its capsule], so a CartWheeler standing on a lit tile
//     is hurt. Its hit spheres would not be: the lowest sit 0.36 m above its feet (10:94 x 1.3).
//
// Retail data: 27 fountain templates carry damage type 16 with the gas colour 0x819c56
// (Hermes' gas, the gas chamber); in 1a the eight floor tiles 6885..688c (3:1213, 13 / s) and
// the tank 5c31 (3:112, 10 / s) do damage, the rising wisps 3:1279 / 3:1230 do not. The gas
// chamber inmate 71ec resists type 16 (Damage Resistance 2:839, x0) and Hermes is immune to
// everything his attachments do not list (GameObject p5), so the gas hurts the player and the
// CartWheeler 64f6 that breaks in through the window.
//
// Port: the player's hit spheres are posed from his skeleton each frame they are needed
// (gas-system.ts); characters, and a body without a sphere tree, use the capsule (feet to
// height, radius), tested with the same strictness. Damage is applied in whole points (the player's
// HUD flashes per hit), through the resistance lookup below.

import type { Entity, EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, entityBoxCorners, readObjectTemplate } from '../../formats/entities';
import { instanceRotation, WORLD_SCALE } from '../../formats/level';
import type { ResRef } from '../../formats/model';

type Vec3 = [number, number, number];
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refs = (v: unknown): ResRef[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as ResRef[]) : []);

/** Oriented box in output space: centre, unit axes, half extents. */
export interface GasBox {
  c: Vec3;
  ax: [Vec3, Vec3, Vec3];
  h: Vec3;
}

/** Damage a fountain does to what touches it: p18 per second of type p19; undefined for none. */
export function fountainDamage(v: readonly PropValue[]): { perSecond: number; type: number } | undefined {
  const perSecond = Math.trunc(num(v[18]));
  return perSecond > 0 ? { perSecond, type: num(v[19]) } : undefined;
}

/** Fountain p50 On / p51 Off / p52 Destroy (the class's message map 0x10178e78). */
export function fountainSwitch(v: readonly PropValue[], msg: number): boolean | undefined {
  if (num(v[50], 1) === msg) return true;
  if (num(v[51], 2) === msg || num(v[52], 11) === msg) return false;
  return undefined;
}

/** The object's volume (template box x instance scale and rotation), output space. */
export function volumeOf(e: Entity): GasBox | undefined {
  const c = entityBoxCorners(e, instanceRotation);
  if (!c) return undefined;
  const P = c.map((p) => p.map((x) => x / WORLD_SCALE) as Vec3);
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const edges = [sub(P[1], P[0]), sub(P[2], P[0]), sub(P[4], P[0])];
  const len = edges.map((d) => Math.hypot(...d));
  const ax = edges.map((d, i) => d.map((x) => x / (len[i] || 1)) as Vec3) as [Vec3, Vec3, Vec3];
  const centre = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / 8) as Vec3;
  return { c: centre, ax, h: [len[0] / 2, len[1] / 2, len[2] / 2] };
}

/** A hit sphere in output space (centre, radius). */
export interface HitSphere {
  c: Vec3;
  r: number;
  /** The bone it follows (posedSpheres). */
  bone?: number;
}

/** Sphere tree node (formats/skeleton.ts SkeletonSphere): first child, next sibling. */
export interface SphereNode {
  children: readonly [number, number] | readonly number[];
  center: readonly number[];
  radius: number;
  bone: number;
}

/**
 * The leaves of a skeleton sphere tree, walked from node 0 (the whole body) by first child /
 * next sibling: the nodes reached that have no first child. Torque 2:9: 23 leaves (head, torso,
 * arm and leg parts, hands, feet); 2:138 (first person): the arms plus four r 0.4 spheres
 * stacked on the root. Nodes nothing links to (two in the CartWheeler rig 10:94) are not
 * visited.
 */
export function leafSpheres<T extends SphereNode>(nodes: readonly T[]): T[] {
  if (nodes.length <= 1) return nodes.slice();
  const out: T[] = [];
  const seen = new Set<number>();
  const walk = (first: number) => {
    for (let i = first; i > 0 && i < nodes.length && !seen.has(i); i = nodes[i].children[1] ?? 0) {
      seen.add(i);
      const child = nodes[i].children[0] ?? 0;
      if (child) walk(child);
      else out.push(nodes[i]);
    }
  };
  walk(nodes[0].children[0] ?? 0);
  return out;
}

/** Squared distance from a point to an oriented box. */
function boxDistanceSq(b: GasBox, p: readonly number[]): number {
  const d = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const a = b.ax[k];
    const t = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    const o = Math.abs(t) - b.h[k];
    if (o > 0) s += o * o;
  }
  return s;
}

/** A hit sphere reaches into a box (0x418810: sphere against the box's faces, no allowance). */
export function sphereTouchesBox(b: GasBox, c: readonly number[], r: number): boolean {
  return r > 0 && boxDistanceSq(b, c) < r * r;
}

/**
 * A body (a vertical segment from the feet up `height`, `radius` thick) overlaps the box,
 * widened by `margin`: its projection on each box axis meets the box's extent there [port:
 * separating axes of the box only; the coarse pass before the hit spheres, and the stand-in
 * for a body without a sphere tree with margin 0].
 */
export function bodyTouches(b: GasBox, feet: { x: number; y: number; z: number }, height: number, radius: number, margin = 0): boolean {
  const d0: Vec3 = [feet.x - b.c[0], feet.y - b.c[1], feet.z - b.c[2]];
  for (let k = 0; k < 3; k++) {
    const a = b.ax[k];
    const p0 = d0[0] * a[0] + d0[1] * a[1] + d0[2] * a[2];
    const p1 = p0 + height * a[1];
    const r = radius * Math.hypot(a[0], a[2]);
    if (Math.max(p0, p1) + r <= -b.h[k] - margin || Math.min(p0, p1) - r >= b.h[k] + margin) return false;
  }
  return true;
}

/** Coarse pass margin (m): hit spheres stay within a body's capsule plus this. */
const COARSE = 0.5;

/** Level Properties 2:9 p46, the global Damage Resistance fallback: types 14 and 6 at x0 [data]. */
const GLOBAL_ZERO = new Set([14, 6]);

/**
 * Damage multiplier of a game object for a damage type (0x100a2dc0 / 0x100a2950): 1, or 0 with
 * GameObject p5; the first Damage Resistance in p7 for that type replaces it with its p1;
 * else the global fallback list.
 */
export function resistanceMultiplier(pkgs: EntityPackageSet, values: readonly PropValue[], type: number): number {
  for (const r of refs(values[7])) {
    const t = readObjectTemplate(pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || c?.name !== 'Damage Resistance') continue;
    const v = decodeTemplateProps(c, t);
    if (num(v[0], -1) === type) return num(v[1], 1);
  }
  if (GLOBAL_ZERO.has(type)) return 0;
  return num(values[5]) !== 0 ? 0 : 1;
}

/**
 * Impact-force multiplier of a game object for a damage type, what the hit reaction is picked
 * by [verified: Character damage 0x100e7390]: the record's copy that becomes the attack stimulus
 * (0x2001, 0x100e779b) has its force (+0x1c) times the matching Damage Resistance's p2
 * (0x100e77e9; same lookup 0x100a2950 as the damage, the global list's 2:655 / 2:464 have p2 = 0),
 * or 0 when none matches and GameObject p6 is set (0x100e7801), else 1. Hermes (p5 = p6 = 1,
 * 2:779 type 5 / 2:656 type 14 with p1 = 0 and p2 = 1) takes no damage at all but is pushed by
 * fire and wind.
 */
export function resistanceForceMultiplier(pkgs: EntityPackageSet, values: readonly PropValue[], type: number): number {
  for (const r of refs(values[7])) {
    const t = readObjectTemplate(pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || c?.name !== 'Damage Resistance') continue;
    const v = decodeTemplateProps(c, t);
    if (num(v[0], -1) === type) return num(v[2], 1);
  }
  if (GLOBAL_ZERO.has(type)) return 0;
  return num(values[6]) !== 0 ? 0 : 1;
}

/** Something the gas can hurt this frame. */
export interface GasTarget {
  /** Stable key (accumulators): 'player' or an actor id. */
  key: string | number;
  feet: { x: number; y: number; z: number };
  height: number;
  radius: number;
  /** Its GameObject values (p5, p7) for the resistance lookup. */
  values: readonly PropValue[];
  /**
   * Its hit spheres this frame (the skeleton sphere tree's leaves, posed); absent or empty: the
   * capsule (feet, height, radius) stands in.
   */
  spheres?(): readonly HitSphere[];
  /**
   * Apply whole damage points. `frame`: this frame's share (p18 x frame time), the amount the
   * engine's damage record carries and the hit reaction is picked by (actors/hit-react.ts).
   */
  hit(amount: number, type: number, from: { x: number; y: number; z: number }, fountain: number, frame: number): void;
}

interface Volume {
  uid: number;
  box: GasBox;
  perSecond: number;
  type: number;
  on: boolean;
  /** Fractional damage per target. */
  acc: Map<string | number, number>;
}

export class FountainHazards {
  private readonly volumes = new Map<number, Volume>();
  /** Recent hits (tests / debug). */
  readonly recent: { uid: number; target: string | number; amount: number }[] = [];

  constructor(private readonly pkgs: EntityPackageSet) {}

  /** A placed Particle Fountain: tracked when it does damage and has a volume. */
  add(e: Entity, startsOn: boolean) {
    const d = fountainDamage(e.values);
    if (!d) return false;
    const box = volumeOf(e);
    if (!box) return false;
    this.volumes.set(e.uid, { uid: e.uid, box, ...d, on: startsOn, acc: new Map() });
    return true;
  }

  get size() {
    return this.volumes.size;
  }

  /** A message reached a placed object (all of them pass through: ignored unless tracked). */
  message(uid: number, values: readonly PropValue[], msg: number) {
    const v = this.volumes.get(uid);
    if (!v) return;
    const on = fountainSwitch(values, msg);
    if (on !== undefined) v.on = on;
  }

  isOn(uid: number) {
    return !!this.volumes.get(uid)?.on;
  }

  /** Save / restore: the volumes that are on. */
  onList(): number[] {
    return [...this.volumes.values()].filter((v) => v.on).map((v) => v.uid);
  }

  setOnList(uids: readonly number[]) {
    const s = new Set(uids);
    for (const v of this.volumes.values()) v.on = s.has(v.uid);
  }

  update(dt: number, targets: readonly GasTarget[]) {
    if (dt <= 0) return;
    const posed = new Map<GasTarget, readonly HitSphere[]>();
    const spheresOf = (t: GasTarget) => {
      let s = posed.get(t);
      if (!s) posed.set(t, (s = t.spheres?.() ?? []));
      return s;
    };
    for (const v of this.volumes.values()) {
      if (!v.on) continue;
      for (const t of targets) {
        if (!touches(v.box, t, spheresOf)) continue;
        const m = resistanceMultiplier(this.pkgs, t.values, v.type);
        if (!(m > 0)) continue;
        const acc = (v.acc.get(t.key) ?? 0) + v.perSecond * m * dt;
        const n = Math.floor(acc);
        v.acc.set(t.key, acc - n);
        if (n <= 0) continue;
        t.hit(n, v.type, { x: v.box.c[0], y: v.box.c[1], z: v.box.c[2] }, v.uid, v.perSecond * m * dt);
        this.recent.push({ uid: v.uid, target: t.key, amount: n });
        if (this.recent.length > 100) this.recent.shift();
      }
    }
  }
}

/** The decoded contact: a hit sphere in the box; the capsule without spheres. */
export function touches(box: GasBox, t: GasTarget, spheresOf: (t: GasTarget) => readonly HitSphere[] = (x) => x.spheres?.() ?? []): boolean {
  if (!bodyTouches(box, t.feet, t.height, t.radius, t.spheres ? COARSE : 0)) return false;
  if (!t.spheres) return true;
  const s = spheresOf(t);
  if (!s.length) return bodyTouches(box, t.feet, t.height, t.radius);
  return s.some((h) => sphereTouchesBox(box, h.c, h.r));
}
