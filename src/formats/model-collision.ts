// The collision model of a static model: the .mdu type-7 record's tree (SUFFERING.EXE).
//
// Record layout [verified: the loader 0x484020 / 0x482d10 / 0x481ea0, and every type-7 entry of
// the 1a, 3a, 9 and 10 package sets parses to its last byte]:
//   u16 ref, u16 ref                 (+0xc8 / +0xcc, both 0 on the retail static models)
//   f32                              (+0xd0, squared at load)
//   f32[4] bounding sphere           (centre xyz, radius; model units)
//   f32[3] corner, f32[9] 3 edges    the model's box
//   u16 kind                         0 sphere tree, 1 box tree, 2 bone spheres (+0xd4)
//   u16 count                        nodes (+0xb8); with 0 the record ends here (76 bytes)
//   u16 x4                           (+0xc0..+0xc6; +0xc2 = the nodes in use)
//   count nodes:
//     kind 0: u16 first, u16 next, f32 x y z r                    (20 bytes; model-spheres.ts)
//     kind 1: u16 first, u16 next, f32[3] corner, f32[9] edges,
//             u16 n, n x u16 face index (into the model's faces)  (54 + 2n bytes)
//     kind 2: 24 bytes
// `first` is a node's first child, `next` its next sibling; a node without a child is a leaf.
//
// Which geometry collides [verified unless marked]:
// - Movers (the EXE mover's contact gather 0x41ee40 / 0x41c340, after the tree-against-tree
//   narrow phase 0x428b30):
//   - box tree: each leaf box the mover's spheres reach. A leaf that lists faces is those faces
//     of the model (0x422f30), when the object's bounding radius is over 200 engine units
//     (0x41f0ff, [0x58eb00]); otherwise the leaf box itself, as 12 triangles (0x422ee0 ->
//     0x421e00).
//   - sphere tree: its leaf spheres (0x41c56a -> 0x4220b0).
//   - sphere tree without nodes, or a box tree without nodes: nothing (0x41c52b, 0x41f0cf).
// - Rays (the per-object ray 0x4283c0, collision interface vtable 0x58c5f0 slots +0x24 / +0x28;
//   sight and the BouncingObject sweep go through it):
//   - box tree (0x4276b0): the leaf boxes; a leaf with faces is its faces.
//   - sphere tree with nodes (0x426750 -> 0x426b38): the leaf spheres.
//   - sphere tree without nodes (0x426750 -> 0x42693d): the bounding sphere, then every face of
//     the model (collision interface +0x2c = 0x424b20 with no face list): the render faces.
// - Engine object +0xc bit 0 only says the model is bound to the object (set by 0x4582d0, the
//   first time vt+0x3c finds the model loaded); the ray tests the bounding sphere alone until
//   then. Every object the movers gather is bound by that gather, and drawn ones by the renderer,
//   so the port always uses the tree.
// So the original never collides with an alpha-tested canopy as drawn: 9's burial-ground tree
// 23:142 (328 cut-out faces) is one 2.2 x 5.9 x 14.5 m leaf box (docs/game-logic.md §14.10).

import { findEntry, mduFaceCount, MDU_FACES, MDU_VERTICES } from './model';
import type { SrscFile } from './srsc';

export const MDU_COLLISION = 7;
/** Tree kinds (record +0x48). */
export const CollisionTree = { Spheres: 0, Boxes: 1, Bones: 2 } as const;
/** A leaf's face list is used only above this bounding radius (200 engine units, 0x58eb00). */
export const FACE_LEAF_MIN_RADIUS = 200 / 2048;

export type Vec3 = [number, number, number];

export type CollisionLeaf =
  | { kind: 'box'; corner: Vec3; edges: [Vec3, Vec3, Vec3] }
  | { kind: 'faces'; corner: Vec3; edges: [Vec3, Vec3, Vec3]; faces: number[] }
  | { kind: 'sphere'; center: Vec3; radius: number };

export interface ModelCollision {
  tree: number;
  /** Bounding sphere (centre, radius), model units. */
  sphere: [number, number, number, number];
  /** Leaves reachable from node 0 (first / next). */
  leaves: CollisionLeaf[];
  /** Node count (0: the record ends after the box). */
  nodes: number;
}

const cache = new WeakMap<SrscFile, Map<number, ModelCollision | null>>();

/** The type-7 collision record of model `id`, or undefined without one. */
export function readModelCollision(mdu: SrscFile, id: number): ModelCollision | undefined {
  let m = cache.get(mdu);
  if (!m) cache.set(mdu, (m = new Map()));
  let c = m.get(id);
  if (c === undefined) m.set(id, (c = parse(mdu, id) ?? null));
  return c ?? undefined;
}

function parse(mdu: SrscFile, id: number): ModelCollision | undefined {
  const e = findEntry(mdu, MDU_COLLISION, id);
  if (!e || e.size < 0x4c) return undefined;
  const v = mdu.data(e);
  const f = (o: number) => v.getFloat32(o, true);
  const f3 = (o: number): Vec3 => [f(o), f(o + 4), f(o + 8)];
  const sphere: [number, number, number, number] = [f(8), f(12), f(16), f(20)];
  const tree = v.getUint16(0x48, true);
  const count = v.getUint16(0x4a, true);
  const nodes: { first: number; next: number; leaf: CollisionLeaf }[] = [];
  let p = 0x54;
  for (let i = 0; i < count; i++) {
    if (tree === CollisionTree.Boxes) {
      if (p + 54 > v.byteLength) break;
      const n = v.getUint16(p + 52, true);
      if (p + 54 + 2 * n > v.byteLength) break;
      const faces: number[] = [];
      for (let k = 0; k < n; k++) faces.push(v.getUint16(p + 54 + 2 * k, true));
      const corner = f3(p + 4), edges: [Vec3, Vec3, Vec3] = [f3(p + 16), f3(p + 28), f3(p + 40)];
      nodes.push({ first: v.getUint16(p, true), next: v.getUint16(p + 2, true), leaf: n ? { kind: 'faces', corner, edges, faces } : { kind: 'box', corner, edges } });
      p += 54 + 2 * n;
    } else if (tree === CollisionTree.Spheres) {
      if (p + 20 > v.byteLength) break;
      nodes.push({ first: v.getUint16(p, true), next: v.getUint16(p + 2, true), leaf: { kind: 'sphere', center: f3(p + 4), radius: f(p + 16) } });
      p += 20;
    } else break;
  }
  return { tree, sphere, leaves: leavesOf(nodes), nodes: count };
}

/** Leaves under node 0: a node with no first child is a leaf; siblings chain by `next`. */
function leavesOf(nodes: { first: number; next: number; leaf: CollisionLeaf }[]): CollisionLeaf[] {
  const out: CollisionLeaf[] = [];
  if (!nodes.length) return out;
  const seen = new Set<number>();
  const stack = [0];
  while (stack.length) {
    let i = stack.pop()!;
    while (i < nodes.length && !seen.has(i)) {
      seen.add(i);
      const n = nodes[i];
      if (n.first > 0 && n.first < nodes.length) stack.push(n.first);
      else out.push(n.leaf);
      if (!(n.next > 0)) break;
      i = n.next;
    }
  }
  return out;
}

/** Triangles in model units (Y up), counter-clockwise front; `faceIndex` = model face of each triangle or -1. */
export interface CollisionMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Per triangle: the model face it came from (face leaves, render faces), else -1. */
  faces: Int32Array;
}

/**
 * The geometry movers collide with (header: movers), model units. `radius`: the placed object's
 * bounding radius (model radius x scale), which decides whether a leaf's face list is used.
 * Undefined when the model has nothing a mover collides with.
 */
export function moverCollisionMesh(mdu: SrscFile, id: number, scale = 1): CollisionMesh | undefined {
  const c = readModelCollision(mdu, id);
  if (!c || !c.leaves.length) return undefined;
  const useFaces = c.sphere[3] * scale > FACE_LEAF_MIN_RADIUS;
  return build(mdu, id, c.leaves, useFaces, false);
}

/**
 * The geometry only rays (sight, shots) hit (header: rays), model units: every face of a model
 * whose sphere tree has no nodes. Rays otherwise hit the mover geometry (a leaf's face list
 * whatever the radius: 0x427cfa).
 */
export function rayOnlyCollisionMesh(mdu: SrscFile, id: number): CollisionMesh | undefined {
  const c = readModelCollision(mdu, id);
  if (!c || c.tree !== CollisionTree.Spheres || c.nodes) return undefined;
  return build(mdu, id, [], true, true);
}

/** Material slot (index into the model header's material list) of model face `fi`. */
export function faceMaterialIndex(mdu: SrscFile, id: number, fi: number): number | undefined {
  const ef = findEntry(mdu, MDU_FACES, id);
  if (!ef) return undefined;
  const v = mdu.data(ef);
  const nf = mduFaceCount(v);
  return nf !== undefined && fi >= 0 && fi < nf ? v.getUint16(4 + 12 * fi + 2, true) : undefined;
}

class MeshBuilder {
  pos: number[] = [];
  idx: number[] = [];
  faces: number[] = [];
  vert(x: number, y: number, z: number) {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number, face = -1) {
    this.idx.push(a, b, c);
    this.faces.push(face);
  }
  done(): CollisionMesh | undefined {
    if (!this.idx.length) return undefined;
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx), faces: Int32Array.from(this.faces) };
  }
}

function build(mdu: SrscFile, id: number, leaves: readonly CollisionLeaf[], useFaces: boolean, allFaces: boolean): CollisionMesh | undefined {
  const b = new MeshBuilder();
  let model: { verts: DataView; nv: number; faces: DataView; nf: number } | null | undefined;
  const modelData = () => {
    if (model === undefined) {
      const ev = findEntry(mdu, MDU_VERTICES, id), ef = findEntry(mdu, MDU_FACES, id);
      const verts = ev ? mdu.data(ev) : undefined, faces = ef ? mdu.data(ef) : undefined;
      const nv = verts && verts.byteLength >= 2 ? verts.getUint16(0, true) : 0;
      const nf = faces ? mduFaceCount(faces) ?? 0 : 0;
      model = verts && faces && verts.byteLength >= 2 + 12 * nv ? { verts, nv, faces, nf } : null;
    }
    return model;
  };
  const face = (fi: number) => {
    const m = modelData();
    if (!m || fi < 0 || fi >= m.nf) return;
    const fo = 4 + 12 * fi;
    const vi = [m.faces.getUint16(fo + 4, true), m.faces.getUint16(fo + 6, true), m.faces.getUint16(fo + 8, true)];
    if (vi.some((k) => k >= m.nv)) return;
    const [a, bb, c] = vi.map((k) => b.vert(m.verts.getFloat32(2 + 12 * k, true), m.verts.getFloat32(6 + 12 * k, true), m.verts.getFloat32(10 + 12 * k, true)));
    // The model's faces are clockwise-front; collision triangles counter-clockwise (parseModel).
    b.tri(a, c, bb, fi);
  };
  if (allFaces) {
    const m = modelData();
    for (let fi = 0; m && fi < m.nf; fi++) face(fi);
  }
  for (const l of leaves) {
    if (l.kind === 'faces' && useFaces) for (const fi of l.faces) face(fi);
    else if (l.kind === 'box' || l.kind === 'faces') boxTris(b, l.corner, l.edges);
    else if (l.kind === 'sphere') sphereTris(b, l.center, l.radius);
  }
  return b.done();
}

/** A leaf box (corner + three edge vectors) as 12 triangles (0x421e00: 8 corners, 6 quads). */
function boxTris(b: MeshBuilder, c: Vec3, e: [Vec3, Vec3, Vec3]) {
  const v: number[] = [];
  for (let k = 0; k < 8; k++) {
    const i = k & 1, j = (k >> 1) & 1, l = (k >> 2) & 1;
    v.push(b.vert(c[0] + i * e[0][0] + j * e[1][0] + l * e[2][0], c[1] + i * e[0][1] + j * e[1][1] + l * e[2][1], c[2] + i * e[0][2] + j * e[1][2] + l * e[2][2]));
  }
  const quad = (a: number, bb: number, cc: number, d: number) => (b.tri(v[a], v[bb], v[cc]), b.tri(v[a], v[cc], v[d]));
  quad(0, 2, 3, 1); // l = 0
  quad(4, 5, 7, 6); // l = 1
  quad(0, 1, 5, 4); // j = 0
  quad(2, 6, 7, 3); // j = 1
  quad(0, 4, 6, 2); // i = 0
  quad(1, 3, 7, 5); // i = 1
}

// A sphere as a once-subdivided icosahedron (80 faces) scaled so its faces touch the sphere
// [port: the triangle collision world has no sphere primitive].
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = (p: Vec3): Vec3 => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  verts = verts.map(norm);
  const mid = new Map<string, number>();
  const half = (a: number, b: number) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    let m = mid.get(k);
    if (m === undefined) {
      const p = verts[a], q = verts[b];
      verts.push(norm([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]));
      mid.set(k, (m = verts.length - 1));
    }
    return m;
  };
  const sub: number[][] = [];
  for (const [a, b, c] of faces) {
    const ab = half(a, b), bc = half(b, c), ca = half(c, a);
    sub.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  faces = sub;
  // Smallest distance from the centre to a face plane: scale by its inverse so every face
  // lies on or outside the unit sphere.
  let inr = 1;
  for (const [a, b, c] of faces) {
    const p = verts[a], q = verts[b], r = verts[c];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = norm([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
    inr = Math.min(inr, Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]));
  }
  return { verts: verts.map((p) => [p[0] / inr, p[1] / inr, p[2] / inr] as Vec3), faces };
})();

function sphereTris(b: MeshBuilder, c: Vec3, r: number) {
  if (!(r > 0)) return;
  const base = b.pos.length / 3;
  for (const p of ICO.verts) b.vert(c[0] + p[0] * r, c[1] + p[1] * r, c[2] + p[2] * r);
  for (const [x, y, z] of ICO.faces) b.tri(base + x, base + y, base + z);
}
