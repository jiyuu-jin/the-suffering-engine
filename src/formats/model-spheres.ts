// Sphere nodes of a static model (.mdu entry type 7, "bounds / collision proxies").
//
// Layout [verified on every retail weapon volume: Melee Weapon models 4:36, 4:135, 10:177..193]:
//   u32 0, u32 0
//   f32[4]   bounding sphere (centre xyz, radius), model units
//   f32[3]   box corner, f32[9] box axes x extents (3 x 3)
//   u16 0, u16 count, u16 0, u16 count, u32 0
//   count x 20-byte nodes { u16 first, u16 next, f32 x y z r }
// The engine reads the nodes as a list (Melee Weapon sweep, Suffering.rfl 0x100caff0): node 0's
// `first` names the weapon's first point, that node's `next` its second (0 = none). Two points are
// a blade (the segment between them sweeps a quad from frame to frame); one is a sphere of its
// radius swept along its path [verified].

import { findEntry } from './model';
import type { SrscFile } from './srsc';

export const MDU_BOUNDS = 7;

export interface ModelSphereNode {
  first: number;
  next: number;
  center: [number, number, number];
  radius: number;
}

/** The type-7 sphere nodes of model `id` (empty when it has none). */
export function readModelSphereNodes(mdu: SrscFile, id: number): ModelSphereNode[] {
  const e = findEntry(mdu, MDU_BOUNDS, id);
  if (!e || e.size < 0x54) return [];
  const v = mdu.data(e);
  const count = v.getUint16(0x4a, true);
  const out: ModelSphereNode[] = [];
  for (let i = 0, p = 0x54; i < count && p + 20 <= v.byteLength; i++, p += 20) {
    out.push({
      first: v.getUint16(p, true),
      next: v.getUint16(p + 2, true),
      center: [v.getFloat32(p + 4, true), v.getFloat32(p + 8, true), v.getFloat32(p + 12, true)],
      radius: v.getFloat32(p + 16, true),
    });
  }
  return out;
}

/** A Melee Weapon's hit shape in its model (bone) space: a segment (b set) or a sphere of radius r. */
export interface WeaponShape {
  a: [number, number, number];
  b?: [number, number, number];
  r: number;
}

/** The weapon shape the sweep uses (see the header); undefined without nodes. */
export function weaponShape(nodes: readonly ModelSphereNode[]): WeaponShape | undefined {
  const first = nodes[0]?.first;
  const n1 = first !== undefined ? nodes[first] : undefined;
  if (!n1) return undefined;
  const n2 = n1.next > 0 ? nodes[n1.next] : undefined;
  return n2 ? { a: n1.center, b: n2.center, r: 0 } : { a: n1.center, r: n1.radius };
}

/**
 * The record's bounding box: a corner and three edge vectors (axis x extent), model units, at
 * 0x18 / 0x24 / 0x30 / 0x3c [verified layout: 1a gas tile 3:139 = 6 x 0.001 x 6 m; the Inferna
 * footprint fire 3:895 = 0.98 x 0.90 x 0.44 m with no tree nodes].
 */
export function readModelBoundsBox(mdu: SrscFile, id: number): { corner: [number, number, number]; edges: [[number, number, number], [number, number, number], [number, number, number]] } | undefined {
  const e = findEntry(mdu, MDU_BOUNDS, id);
  if (!e || e.size < 0x48) return undefined;
  const v = mdu.data(e);
  const f3 = (o: number): [number, number, number] => [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)];
  return { corner: f3(0x18), edges: [f3(0x24), f3(0x30), f3(0x3c)] };
}
