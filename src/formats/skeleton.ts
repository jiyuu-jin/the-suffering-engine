// Riot Engine skinned models: skeleton + vertex weights (.mdu type 8).
//
// A skinned model is an ordinary .mdu model (type 0 header, type 3 vertices,
// type 4 faces; see model.ts) plus a type-8 skeleton entry with the same id.
// The SRSC `extra` field of every entry of a skinned model is an "animation
// set" id that the .adu clips made for that rig carry too (per package; clips
// are bound to bones by name hash, so any clip whose hashes match can drive it).
//
// .mdu type 8 (skeleton)
// ----------------------
//   f32[4]  bounding sphere (centre xyz, radius), bind pose, model units
//   f32[4]  second sphere / box (unused here)
//   f32[8]  two more (0,0,0,r) records (unused here)
//   u32     version: 1 or 2
//   u32     vertexCount (== type 3 vertex count)
//   u32     boneCount
//   boneCount x {
//     u32     name hash (stable across models: the same bone has the same hash on every
//             human, which is how .adu tracks are bound)
//     f32[3]  t  \  inverse bind matrix (model -> bone space), Direct3D row-vector form:
//     f32[9]  R  /  boneLocal = v · R + t   (R stored row-major)
//     u32     first child bone index (0 = none; bone 0 is always the root)
//     u32     next sibling bone index (0 = none)
//     u16 n, n x { u32 vertex, f32 weight }   skin weights (sum to 1 per vertex)
//     [v2 only: u16 m, m x { u32 vertex, f32 weight }  weights of the LOD1 vertices
//               (indices relative to LOD1's firstVertex); ignored here]
//   }
//   trailer (readSkeletonTrailer; exact byte coverage on all 190 retail rigs; loader
//   SUFFERING.EXE 0x47ae80..0x47b450, docs/re/animation.md):
//     version x LOD record (below)
//     u32      kept at model +0x104 (low 16 bits small, high 16 bits 0x0002..0x0037; unknown)
//     u16      channelCount
//     channelCount x { u32 bone, u16 n, n x u32 bits }  the channel table (model +0xc8, 16-byte
//              records; each bone gets its channel index at +0x40). STOMP attach keys use it as
//              hardpoints, STOMP animation keys as animation channels (the clip plays on the
//              bone's subtree). `bits`: one word per LOD; a few channels carry one distinct
//              bit each (1, 2, 4 ... in channel order: spine, arms, neck, head, pelvis on the
//              human rigs); what reads them was not found.
//     f32[3]   LOD distances (model +0xf8 / +0xfc / +0x100)
//     u16      sphereCount; if non-zero: u16 x 4 header, then sphereCount x 24-byte nodes
//              { u16 child A, u16 child B (0 = none), f32 x y z r (model units; the engine
//              scales them by 2048), u32 bone }: a bounding-sphere tree, node 0 = the whole
//              body (0x482d10 / 0x481c40).
//
// LOD records (one per LOD, `version` of them, 20 bytes each; verified on all 190 rigs):
//   f32 switch distance (engine units; 0 for LOD0, e.g. 20480 / 24576 / 30720 / 47104 for LOD1)
//   u32 firstVertex, u32 vertexCount   -> the LOD's slice of the type 3 vertex array
//   u32 firstFace,   u32 faceCount     -> the LOD's slice of the type 4 face array
// The slices are contiguous and cover both arrays exactly (LOD0 = vertices [0, V0), faces
// [0, F0)). LOD1 faces index their own vertex slice (indices relative to firstVertex) and
// LOD1 is weighted by the second weight list. Only LOD0 is drawn (readSkinnedGeometry).
// The type-17 per-vertex UV block repeats V0.
//
// Weights only cover the "unique" vertices. Vertices duplicated for UV seams
// are listed in type 17 (first section): u32 sectionCount, u32 pairCount,
// pairCount x { u16 source, u16 duplicate }, u32 V0, V0 x f32[2] per-vertex UV,
// then section 2 (LOD1 data, not decoded). Duplicates copy their source's
// weights. A handful of vertices (detached shells) have no weights at all;
// they take the weights of the nearest weighted vertex.
//
// Bind pose: bindWorld = inverse(inverseBind); local = inverse(bindWorld[parent]) · bindWorld.
// Animation tracks (animation.ts) express the same local transforms as
// T(position) · R(quaternion) with Three.js-compatible quaternions (x, y, z, w).
// Model space is the same as static models: Y up, character faces -Z (+X = its right),
// 1 unit ~ 0.85 m. Level placement maps model -Z to world +X (see level.ts).

import type { SrscFile } from './srsc';
import {
  findEntry,
  MDU_FACES,
  MDU_HEADER,
  MDU_VERTICES,
  readMaterial,
  refKey,
  resolveMaterialTexture,
  type ModelSubmesh,
  type PackageSet,
  type ResRef,
  type RiotModel,
} from './model';

export const MDU_SKELETON = 8;
export const MDU_SEAMS = 17;
/** Influences kept per vertex (Three.js skinning uses 4). */
export const MAX_INFLUENCES = 4;

/** Hash of the root bone shared by every humanoid/creature rig seen so far. */
export const ROOT_BONE_HASH = 0xb6c65665;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface SkeletonBone {
  index: number;
  hash: number;
  /** Stable name derived from the hash ("b_<hex>"), used as the Three.js bone name. */
  name: string;
  /** Parent bone index, -1 for the root. */
  parent: number;
  children: number[];
  /** Model -> bone (column-major 4x4, Three.js Matrix4.elements order). */
  inverseBind: Float32Array;
  /** Bone -> model in bind pose (column-major 4x4). */
  bindWorld: Float32Array;
  /** Bind-pose transform relative to the parent. */
  position: Vec3;
  quaternion: Quat;
}

export interface Skeleton {
  version: number;
  vertexCount: number;
  bones: SkeletonBone[];
  /** Bone index by name hash. */
  byHash: Map<number, number>;
  /** Bounding sphere of the bind pose. */
  sphere: { center: Vec3; radius: number };
  /** Per source (type 3) vertex: MAX_INFLUENCES bone indices and normalised weights. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

export interface SkinnedModel {
  ref: ResRef;
  /** SRSC `extra` of the skeleton entry: the animation-set id of this rig in its package. */
  animSet: number;
  model: RiotModel;
  skeleton: Skeleton;
  /** Per corner vertex of `model` (MAX_INFLUENCES each). */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

export const boneName = (hash: number) => `b_${(hash >>> 0).toString(16).padStart(8, '0')}`;

// ---------------------------------------------------------------------------
// Small column-major 4x4 helpers (rigid transforms only)

function invertRigid(m: Float32Array): Float32Array {
  // [R t] -> [R^T, -R^T t]; tolerant of slight non-orthogonality via a full 3x3 inverse.
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  const inv = new Float32Array(16);
  // rows of the inverse 3x3
  const r00 = A / det, r01 = -(b * i - c * h) / det, r02 = (b * f - c * e) / det;
  const r10 = B / det, r11 = (a * i - c * g) / det, r12 = -(a * f - c * d) / det;
  const r20 = C / det, r21 = -(a * h - b * g) / det, r22 = (a * e - b * d) / det;
  const tx = m[12], ty = m[13], tz = m[14];
  inv[0] = r00; inv[4] = r01; inv[8] = r02;
  inv[1] = r10; inv[5] = r11; inv[9] = r12;
  inv[2] = r20; inv[6] = r21; inv[10] = r22;
  inv[12] = -(r00 * tx + r01 * ty + r02 * tz);
  inv[13] = -(r10 * tx + r11 * ty + r12 * tz);
  inv[14] = -(r20 * tx + r21 * ty + r22 * tz);
  inv[15] = 1;
  return inv;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}

/** Rotation part of a column-major matrix -> unit quaternion (x, y, z, w). */
export function matrixToQuat(m: Float32Array): Quat {
  // Normalise columns to drop any scale.
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const m11 = m[0] / sx, m12 = m[4] / sy, m13 = m[8] / sz;
  const m21 = m[1] / sx, m22 = m[5] / sy, m23 = m[9] / sz;
  const m31 = m[2] / sx, m32 = m[6] / sy, m33 = m[10] / sz;
  const tr = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

// ---------------------------------------------------------------------------

/** True if the .mdu has a skeleton for model `id`. */
export function hasSkeleton(mdu: SrscFile | undefined, id: number): boolean {
  return !!findEntry(mdu, MDU_SKELETON, id);
}

/** Decode the type-8 skeleton (and complete the per-vertex weights) of model `id`. */
export function readSkeleton(mdu: SrscFile, id: number): Skeleton | undefined {
  const es = findEntry(mdu, MDU_SKELETON, id);
  if (!es || es.size < 0x4c) return undefined;
  const v = mdu.data(es);
  const f = (o: number) => v.getFloat32(o, true);
  const version = v.getUint32(0x40, true);
  const vertexCount = v.getUint32(0x44, true);
  const boneCount = v.getUint32(0x48, true);
  if (version < 1 || version > 2 || boneCount === 0 || boneCount > 1024 || vertexCount > 65536) return undefined;

  type Raw = { hash: number; ib: Float32Array; child: number; sibling: number };
  const raw: Raw[] = [];
  // Per vertex influence lists (LOD0 only).
  const infl: { bone: number; w: number }[][] = Array.from({ length: vertexCount }, () => []);
  let p = 0x4c;
  for (let b = 0; b < boneCount; b++) {
    if (p + 60 > v.byteLength) return undefined;
    const hash = v.getUint32(p, true);
    const ib = new Float32Array(16);
    // Stored row r of R becomes column r of the column-vector matrix (M = R^T).
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) ib[r * 4 + c] = f(p + 16 + 12 * r + 4 * c);
    ib[12] = f(p + 4);
    ib[13] = f(p + 8);
    ib[14] = f(p + 12);
    ib[15] = 1;
    const child = v.getUint32(p + 52, true);
    const sibling = v.getUint32(p + 56, true);
    p += 60;
    for (let list = 0; list < version; list++) {
      const n = v.getUint16(p, true);
      p += 2;
      if (p + 8 * n > v.byteLength) return undefined;
      if (list === 0) {
        for (let k = 0; k < n; k++) {
          const vi = v.getUint32(p + 8 * k, true);
          const w = f(p + 8 * k + 4);
          if (vi < vertexCount && w > 0) infl[vi].push({ bone: b, w });
        }
      }
      p += 8 * n;
    }
    raw.push({ hash, ib, child, sibling });
  }

  // Hierarchy from first-child / next-sibling links.
  const parent = new Array<number>(boneCount).fill(-1);
  const children: number[][] = Array.from({ length: boneCount }, () => []);
  for (let b = 0; b < boneCount; b++) {
    let c = raw[b].child;
    let guard = 0;
    while (c > 0 && c < boneCount && guard++ < boneCount) {
      if (parent[c] === -1 && c !== b) {
        parent[c] = b;
        children[b].push(c);
      }
      c = raw[c].sibling;
    }
  }

  const bones: SkeletonBone[] = [];
  const byHash = new Map<number, number>();
  for (let b = 0; b < boneCount; b++) {
    const bindWorld = invertRigid(raw[b].ib);
    bones.push({
      index: b,
      hash: raw[b].hash,
      name: boneName(raw[b].hash),
      parent: parent[b],
      children: children[b],
      inverseBind: raw[b].ib,
      bindWorld,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
    });
    if (!byHash.has(raw[b].hash)) byHash.set(raw[b].hash, b);
  }
  for (const bone of bones) {
    const local = bone.parent < 0 ? bone.bindWorld : multiply(bones[bone.parent].inverseBind, bone.bindWorld);
    bone.position = [local[12], local[13], local[14]];
    bone.quaternion = matrixToQuat(local);
  }

  // Seam duplicates (type 17, first section) copy their source's weights.
  const seams = findEntry(mdu, MDU_SEAMS, id);
  if (seams && seams.size >= 8) {
    const s = mdu.data(seams);
    const sections = s.getUint32(0, true);
    const pairs = sections ? s.getUint32(4, true) : 0;
    for (let k = 0; k < pairs && 8 + 4 * k + 4 <= s.byteLength; k++) {
      const src = s.getUint16(8 + 4 * k, true);
      const dst = s.getUint16(10 + 4 * k, true);
      if (src < vertexCount && dst < vertexCount && infl[dst].length === 0) infl[dst] = infl[src];
    }
  }

  // Remaining unweighted vertices: borrow from the nearest weighted vertex.
  const ev = findEntry(mdu, MDU_VERTICES, id);
  const pos = ev ? mdu.data(ev) : undefined;
  const nvPos = pos ? Math.min(pos.getUint16(0, true), vertexCount) : 0;
  // (Positions read once into typed arrays: the search is quadratic in the vertex count, and
  // reading them through the DataView per pair cost up to ~0.7 s per level load.)
  const xyz = new Float32Array(nvPos * 3);
  for (let i = 0; i < nvPos * 3; i++) xyz[i] = pos!.getFloat32(2 + 4 * i, true);
  const weighted: number[] = [];
  for (let i = 0; i < vertexCount; i++) if (infl[i].length) weighted.push(i);
  // The weighted vertices that have a position, in index order, with their positions.
  const wi = weighted.filter((j) => j < nvPos);
  const wp = new Float32Array(wi.length * 3);
  wi.forEach((j, k) => wp.set(xyz.subarray(3 * j, 3 * j + 3), 3 * k));
  for (let i = 0; i < vertexCount; i++) {
    if (infl[i].length) continue;
    let best = -1;
    if (i < nvPos && weighted.length) {
      let bd = Infinity;
      const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
      for (let k = 0; k < wi.length; k++) {
        const dx = wp[3 * k] - x, dy = wp[3 * k + 1] - y, dz = wp[3 * k + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) {
          bd = d;
          best = wi[k];
        }
      }
    }
    infl[i] = best >= 0 ? infl[best] : [{ bone: 0, w: 1 }];
  }

  const skinIndex = new Uint16Array(vertexCount * MAX_INFLUENCES);
  const skinWeight = new Float32Array(vertexCount * MAX_INFLUENCES);
  for (let i = 0; i < vertexCount; i++) {
    const list = [...infl[i]].sort((a, b) => b.w - a.w).slice(0, MAX_INFLUENCES);
    const sum = list.reduce((s, x) => s + x.w, 0) || 1;
    list.forEach((x, k) => {
      skinIndex[i * MAX_INFLUENCES + k] = x.bone;
      skinWeight[i * MAX_INFLUENCES + k] = x.w / sum;
    });
  }

  return {
    version,
    vertexCount,
    bones,
    byHash,
    sphere: { center: [f(0), f(4), f(8)], radius: f(12) },
    skinIndex,
    skinWeight,
  };
}

/** Skinned model = static geometry (model.ts) + skeleton, with weights expanded to corner vertices. */
export function readSkinnedModel(pkgs: PackageSet, ref: ResRef): SkinnedModel | undefined {
  const mdu = pkgs.get(ref.pkg)?.mdu;
  if (!mdu) return undefined;
  const es = findEntry(mdu, MDU_SKELETON, ref.id);
  if (!es) return undefined;
  const skeleton = readSkeleton(mdu, ref.id);
  const model = readSkinnedGeometry(pkgs, ref);
  if (!skeleton || !model) return undefined;
  const n = model.source.length;
  const skinIndex = new Uint16Array(n * MAX_INFLUENCES);
  const skinWeight = new Float32Array(n * MAX_INFLUENCES);
  for (let c = 0; c < n; c++) {
    const s = model.source[c];
    if (s >= skeleton.vertexCount) {
      skinWeight[c * MAX_INFLUENCES] = 1;
      continue;
    }
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      skinIndex[c * MAX_INFLUENCES + k] = skeleton.skinIndex[s * MAX_INFLUENCES + k];
      skinWeight[c * MAX_INFLUENCES + k] = skeleton.skinWeight[s * MAX_INFLUENCES + k];
    }
  }
  return { ref, animSet: es.extra, model, skeleton, skinIndex, skinWeight };
}

/** All skinned model ids in a .mdu, with their animation-set id and bone count. */
export function listSkinnedModels(mdu: SrscFile): { id: number; animSet: number; bones: number; vertices: number }[] {
  const out: { id: number; animSet: number; bones: number; vertices: number }[] = [];
  for (const e of mdu.entries) {
    if (e.type !== MDU_SKELETON || e.size < 0x4c) continue;
    const v = mdu.data(e);
    out.push({ id: e.id, animSet: e.extra, vertices: v.getUint32(0x44, true), bones: v.getUint32(0x48, true) });
  }
  return out;
}

export interface SkinnedLod {
  /** Switch distance in engine units (0 for LOD0). */
  distance: number;
  firstVertex: number;
  vertexCount: number;
  firstFace: number;
  faceCount: number;
}

/**
 * The LOD records of a skinned model's type-8 trailer (one per skeleton version: 1 or 2),
 * or undefined when the entry is malformed. See the format notes at the top of this file.
 */
export function readSkinnedLods(mdu: SrscFile, id: number): SkinnedLod[] | undefined {
  const es = findEntry(mdu, MDU_SKELETON, id);
  if (!es || es.size < 0x4c) return undefined;
  const v = mdu.data(es);
  const version = v.getUint32(0x40, true);
  const boneCount = v.getUint32(0x48, true);
  if (version < 1 || version > 2 || boneCount === 0 || boneCount > 1024) return undefined;
  let p = 0x4c;
  for (let b = 0; b < boneCount; b++) {
    p += 60;
    for (let list = 0; list < version; list++) {
      if (p + 2 > v.byteLength) return undefined;
      p += 2 + 8 * v.getUint16(p, true);
    }
  }
  if (p + 20 * version > v.byteLength) return undefined;
  const lods: SkinnedLod[] = [];
  for (let l = 0; l < version; l++, p += 20) {
    lods.push({
      distance: v.getFloat32(p, true),
      firstVertex: v.getUint32(p + 4, true),
      vertexCount: v.getUint32(p + 8, true),
      firstFace: v.getUint32(p + 12, true),
      faceCount: v.getUint32(p + 16, true),
    });
  }
  return lods;
}

/**
 * Like model.ts readModel, restricted to LOD0 (version-2 skinned models append a lower LOD
 * whose face indices would otherwise be misread as LOD0 vertices). The LOD0 slices come from
 * the skeleton's LOD records; without a usable record the whole mesh is LOD0.
 */
export function readSkinnedGeometry(pkgs: PackageSet, ref: ResRef): RiotModel | undefined {
  const mdu = pkgs.get(ref.pkg)?.mdu;
  const eh = findEntry(mdu, MDU_HEADER, ref.id);
  const ev = findEntry(mdu, MDU_VERTICES, ref.id);
  const ef = findEntry(mdu, MDU_FACES, ref.id);
  if (!mdu || !ev || !ef) return undefined;
  const materials: ResRef[] = [];
  if (eh && eh.size >= 12) {
    const h = mdu.data(eh);
    let p = 8 + (h.getUint8(2) & 2 ? 4 : 0);
    const n = h.getUint32(p, true);
    p += 4;
    for (let i = 0; i < n && p + 4 <= h.byteLength; i++, p += 4) materials.push({ id: h.getUint16(p, true), pkg: h.getUint16(p + 2, true) });
  }
  const vv = mdu.data(ev);
  const nv = vv.getUint16(0, true);
  const fv = mdu.data(ef);
  const nf = fv.getUint32(0, true);
  if (ev.size < 2 + 16 * nv || ef.size < 4 + 36 * nf) return undefined;
  const P = (i: number, c: number) => vv.getFloat32(2 + 12 * i + 4 * c, true);
  const idx = (f: number, c: number) => fv.getUint16(4 + 12 * f + 4 + 2 * c, true);

  let faceCount = nf;
  let v0 = nv;
  const lod0 = readSkinnedLods(mdu, ref.id)?.[0];
  if (lod0 && lod0.firstVertex === 0 && lod0.firstFace === 0 && lod0.vertexCount <= nv && lod0.faceCount <= nf) {
    v0 = lod0.vertexCount;
    faceCount = lod0.faceCount;
  }

  const uvBase = 4 + 12 * nf;
  const cornerMap = new Map<string, number>();
  const src: number[] = [], pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  const byMat = new Map<number, number[]>();
  for (let f = 0; f < faceCount; f++) {
    const mat = fv.getUint16(4 + 12 * f + 2, true);
    const tri: number[] = [];
    for (let c = 0; c < 3; c++) {
      const vi = idx(f, c);
      if (vi >= v0) break;
      const u = fv.getFloat32(uvBase + (f * 3 + c) * 8, true);
      const w = fv.getFloat32(uvBase + (f * 3 + c) * 8 + 4, true);
      const key = `${vi},${u},${w}`;
      let ci = cornerMap.get(key);
      if (ci === undefined) {
        ci = src.length;
        cornerMap.set(key, ci);
        src.push(vi);
        pos.push(P(vi, 0), P(vi, 1), P(vi, 2));
        const no = 2 + 12 * nv + 4 * vi;
        nrm.push(vv.getInt8(no) / 127, vv.getInt8(no + 1) / 127, vv.getInt8(no + 2) / 127);
        uv.push(u, w);
      }
      tri.push(ci);
    }
    if (tri.length !== 3) continue;
    let list = byMat.get(mat);
    if (!list) byMat.set(mat, (list = []));
    list.push(...tri);
  }
  const submeshes: ModelSubmesh[] = [];
  for (const [mat, list] of [...byMat].sort((a, b) => a[0] - b[0])) {
    const m = materials[mat];
    const tex = m ? resolveMaterialTexture(pkgs, m) : undefined;
    // The decoded material too: characters draw their blended passes (Hermes' additive glow)
    // with it (app/character.ts characterSurfaceBlend).
    submeshes.push({ textureKey: tex ? refKey(tex) : undefined, material: m ? readMaterial(pkgs, m) : undefined, materialIndex: mat, indices: Uint32Array.from(list) });
  }
  return {
    ref,
    vertexCount: v0,
    source: Uint32Array.from(src),
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    uvs: Float32Array.from(uv),
    submeshes,
    materials,
  };
}

export interface SkeletonChannel {
  /** Bone index (attach / animation channel bone). */
  bone: number;
  /** One word per LOD (single distinct bits on a few channels, else 0). */
  bits: number[];
}

export interface SkeletonSphere {
  /** Child node indices (0 = none). */
  children: [number, number];
  /** Centre and radius, model units. */
  center: Vec3;
  radius: number;
  /** Bone the sphere follows. */
  bone: number;
}

export interface SkeletonTrailer {
  lods: SkinnedLod[];
  /** The u32 the engine keeps at model +0x104 (meaning unknown). */
  word104: number;
  channels: SkeletonChannel[];
  /** LOD switch distances (engine units). */
  lodDistances: [number, number, number];
  /** u16 x 4 before the sphere nodes (first 0, then counts; meaning partly unknown). */
  sphereHeader: number[];
  spheres: SkeletonSphere[];
  /** Bytes decoded from the start of the entry (equals the entry size on retail data). */
  end: number;
}

/** Decode the whole type-8 trailer after the bone records (see the header). */
export function readSkeletonTrailer(mdu: SrscFile, id: number): SkeletonTrailer | undefined {
  const es = findEntry(mdu, MDU_SKELETON, id);
  if (!es || es.size < 0x4c) return undefined;
  const v = mdu.data(es);
  const version = v.getUint32(0x40, true);
  const boneCount = v.getUint32(0x48, true);
  if (version < 1 || version > 2 || boneCount === 0 || boneCount > 1024) return undefined;
  const lods = readSkinnedLods(mdu, id);
  if (!lods) return undefined;
  let p = 0x4c;
  for (let b = 0; b < boneCount; b++) {
    p += 60;
    for (let list = 0; list < version; list++) p += 2 + 8 * v.getUint16(p, true);
  }
  p += 20 * version;
  try {
    const word104 = v.getUint32(p, true);
    p += 4;
    const n = v.getUint16(p, true);
    p += 2;
    const channels: SkeletonChannel[] = [];
    for (let c = 0; c < n; c++) {
      const bone = v.getUint32(p, true);
      const k = v.getUint16(p + 4, true);
      p += 6;
      const bits: number[] = [];
      for (let i = 0; i < k; i++) bits.push(v.getUint32(p + 4 * i, true));
      p += 4 * k;
      channels.push({ bone, bits });
    }
    const lodDistances: [number, number, number] = [v.getFloat32(p, true), v.getFloat32(p + 4, true), v.getFloat32(p + 8, true)];
    p += 12;
    const count = v.getUint16(p, true);
    p += 2;
    const sphereHeader: number[] = [];
    const spheres: SkeletonSphere[] = [];
    if (count) {
      for (let i = 0; i < 4; i++) sphereHeader.push(v.getUint16(p + 2 * i, true));
      p += 8;
      for (let i = 0; i < count; i++, p += 24) {
        spheres.push({
          children: [v.getUint16(p, true), v.getUint16(p + 2, true)],
          center: [v.getFloat32(p + 4, true), v.getFloat32(p + 8, true), v.getFloat32(p + 12, true)],
          radius: v.getFloat32(p + 16, true),
          bone: v.getUint32(p + 20, true),
        });
      }
    }
    return { lods, word104, channels, lodDistances, sphereHeader, spheres, end: p };
  } catch {
    return undefined;
  }
}

/** Bone indices of the subtree rooted at `bone` (the bone itself included). */
export function boneSubtree(skeleton: Skeleton, bone: number): number[] {
  const out: number[] = [];
  const walk = (b: number) => {
    out.push(b);
    for (const c of skeleton.bones[b]?.children ?? []) walk(c);
  };
  if (skeleton.bones[bone]) walk(bone);
  return out;
}
