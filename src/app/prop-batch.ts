// Static batching of rigid world props (docs/game-logic.md §18.6).
//
// A level has hundreds to over a thousand prop meshes (doors, breakables, pickups, lamp
// housings, decorations...), each its own draw in three.js, while only a few of them ever move
// or change. StaticBatch copies every candidate mesh, in world space at the pose it has when the
// batch is built, into one merged mesh per material. Each frame it checks every candidate
// against that snapshot (same world matrix, material and geometry, and shown):
//
//   - unchanged ("merged"): the mesh itself is not drawn (layers mask 0) and its triangles are
//     included in the merged mesh's index buffer, if its zone is visible and it is within its
//     draw distance (the same tests visibility.ts cullObjects applies to other rigid meshes);
//   - changed (opened door, broken or picked up, swapped or glowing material, hidden,
//     reparented...): its triangles leave the merged mesh and the mesh is drawn on its own
//     again, zone-culled per frame like before. It merges back once it is back in its snapshot
//     state and has stayed there for a while (doubling each time, so flickering lamps or doors
//     that keep moving do not repack the batch over and over).
//
// The game systems keep working on the original meshes (they stay in the scene graph with
// their collision bodies, uids, materials and visibility); only drawing changes. The merged
// mesh packs the included members' triangles to the front of its index buffer and draws that
// range (like renderer.ts compactLevel), only when the included set changed.
//
// Transparent / blended, depth-test-off, custom-ordered and non-frustum-culled meshes are left
// alone (their draw order matters or their owner manages them), as are skinned, instanced and
// morphing meshes and CPU-rewritten geometry.

import * as THREE from 'three/webgpu';
import type { ZoneCuller } from './visibility';

/** `?nobatch`: no static batching (every prop its own draw; for comparisons). */
export const NO_BATCH = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nobatch');

/** Frames a changed member must stay back in its snapshot state before it merges again. */
const CALM_FRAMES = 30;
const CALM_MAX = 1800;

interface Batch {
  mesh: THREE.Mesh;
  /** All members' triangles, in member order. */
  full: Uint32Array;
  members: Member[];
  dirty: boolean;
  count: number;
}

interface Member {
  mesh: THREE.Mesh;
  material: THREE.Material;
  geometry: THREE.BufferGeometry;
  /** World matrix at the snapshot. */
  matrix: Float64Array;
  batch: Batch;
  /** Range in batch.full. */
  start: number;
  count: number;
  /** Local bounding-sphere centre and radius (zone test of the unmerged mesh). */
  lx: number;
  ly: number;
  lz: number;
  lr: number;
  /** Snapshot world sphere (with the culler's 1 unit of slack). */
  wx: number;
  wy: number;
  wz: number;
  wr: number;
  /** Layers mask the mesh is drawn with on its own. */
  mask: number;
  /** Draw distance from the sphere centre (userData.cullDistance; Infinity = none). */
  cull: number;
  /** Frames spent unchanged; merged when >= need. */
  calm: number;
  need: number;
  merged: boolean;
  /** Triangles currently in the merged mesh's index range. */
  included: boolean;
}

export interface StaticBatchStats {
  batches: number;
  members: number;
  merged: number;
  /** Members whose triangles are drawn this frame (merged and zone-visible). */
  included: number;
  repacks: number;
  ms: number;
}

const attrKey = (g: THREE.BufferGeometry) =>
  Object.keys(g.attributes)
    .sort()
    .map((k) => {
      const a = g.attributes[k] as THREE.BufferAttribute;
      return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${(a.array as { constructor: { name: string } }).constructor.name}`;
    })
    .join(',');

/** Can this mesh be drawn from a merged, world-space copy without any visible difference? */
export function batchable(m: THREE.Mesh): boolean {
  const mat = m.material as THREE.Material;
  if (!m.isMesh || Array.isArray(m.material) || !mat) return false;
  const any = m as unknown as { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean };
  if (any.isSkinnedMesh || any.isInstancedMesh || any.isBatchedMesh || m.morphTargetInfluences?.length) return false;
  if (!m.frustumCulled || m.renderOrder !== 0 || m.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return false;
  if (mat.transparent || !mat.depthTest || !mat.depthWrite || mat.blending !== THREE.NormalBlending) return false;
  const g = m.geometry;
  const pos = g?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || (pos as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || pos.usage === THREE.DynamicDrawUsage) return false;
  if (g.groups.length > 1 || g.drawRange.start !== 0 || g.drawRange.count !== Infinity || Object.keys(g.morphAttributes).length) return false;
  for (const k in g.attributes) if ((g.attributes[k] as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return false;
  return true;
}

const _m3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _world = new THREE.Matrix4();
const _local = new THREE.Matrix4();

/**
 * World matrix of `o` composed from the local transforms of it and its ancestors, without
 * touching three's update flags. `o.updateWorldMatrix(true, false)` is not safe here: it clears a
 * pending matrixWorldNeedsUpdate on an ancestor (a placed object's root, matrixAutoUpdate off)
 * without updating that ancestor's other descendants, and the frame's matrix pass then never
 * recomputes them. Batching did that to every pickup of 1b, whose roots were still flagged when
 * the batch was built: their meshes kept an identity world matrix, the batch copied them to the
 * level's origin, and they were invisible where they lay.
 */
export function worldMatrixOf(o: THREE.Object3D, out = _world): THREE.Matrix4 {
  const chain: THREE.Object3D[] = [];
  for (let p: THREE.Object3D | null = o; p; p = p.parent) chain.push(p);
  out.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const p = chain[i];
    out.multiply(p.matrixAutoUpdate ? _local.compose(p.position, p.quaternion, p.scale) : p.matrix);
  }
  return out;
}

export class StaticBatch {
  readonly group = new THREE.Group();
  readonly stats: StaticBatchStats = { batches: 0, members: 0, merged: 0, included: 0, repacks: 0, ms: 0 };
  /** Off: every member drawn on its own (comparisons; `?nobatch`). */
  enabled = true;
  private readonly members: Member[] = [];
  private readonly batches: Batch[] = [];
  private visVersion = -1;

  /**
   * `meshes`: candidates (filtered with batchable()); `root`: the scene they must be shown in.
   * The snapshot is their pose from the local transforms (worldMatrixOf). `cell` > 0 also splits the batches on a horizontal grid of
   * that size, for levels without zones: there a merged mesh spanning the whole level would
   * always be drawn, where the separate props were frustum-culled.
   */
  constructor(meshes: Iterable<THREE.Mesh>, private readonly root: THREE.Object3D, opts: { cell?: number } = {}) {
    this.group.name = 'static-batches';
    this.group.matrixAutoUpdate = false;
    const groups = new Map<string, THREE.Mesh[]>();
    const cell = opts.cell ?? 0;
    for (const m of meshes) {
      if (!batchable(m) || !this.inRoot(m)) continue;
      let key = `${(m.material as THREE.Material).uuid}|${attrKey(m.geometry)}`;
      if (cell > 0) {
        const e = worldMatrixOf(m).elements;
        key += `|${Math.floor(e[12] / cell)},${Math.floor(e[14] / cell)}`;
      }
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(m);
    }
    for (const list of groups.values()) if (list.length > 1) this.build(list);
    this.stats.batches = this.batches.length;
    this.stats.members = this.members.length;
  }

  private build(list: THREE.Mesh[]) {
    let verts = 0, indices = 0;
    for (const m of list) {
      const g = m.geometry;
      verts += g.getAttribute('position').count;
      indices += g.index ? g.index.count : g.getAttribute('position').count;
    }
    const first = list[0].geometry;
    const geo = new THREE.BufferGeometry();
    const arrays: Record<string, { out: THREE.TypedArray; size: number }> = {};
    for (const k in first.attributes) {
      const a = first.attributes[k] as THREE.BufferAttribute;
      const Ctor = (a.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
      arrays[k] = { out: new Ctor(verts * a.itemSize), size: a.itemSize };
    }
    const full = new Uint32Array(indices);
    const batch: Batch = { mesh: undefined as unknown as THREE.Mesh, full, members: [], dirty: true, count: 0 };
    let v0 = 0, i0 = 0;
    for (const m of list) {
      const g = m.geometry;
      const M = worldMatrixOf(m);
      const e = M.elements;
      const n = g.getAttribute('position').count;
      for (const k in arrays) {
        const src = g.getAttribute(k) as THREE.BufferAttribute;
        const { out, size } = arrays[k];
        const a = src.array;
        if (k === 'position') {
          for (let i = 0; i < n; i++) {
            const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2];
            const o = 3 * (v0 + i);
            out[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
            out[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
            out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
          }
        } else if (k === 'normal' && size === 3) {
          const N = _m3.getNormalMatrix(M).elements;
          for (let i = 0; i < n; i++) {
            const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2];
            _v.set(N[0] * x + N[3] * y + N[6] * z, N[1] * x + N[4] * y + N[7] * z, N[2] * x + N[5] * y + N[8] * z).normalize();
            const o = 3 * (v0 + i);
            out[o] = _v.x;
            out[o + 1] = _v.y;
            out[o + 2] = _v.z;
          }
        } else out.set((a as THREE.TypedArray).subarray(0, n * size), v0 * size);
      }
      // A mirroring matrix flips the winding (three.js swaps the front face for such objects).
      const flip = M.determinant() < 0;
      const idx = g.index?.array;
      const count = idx ? idx.length : n;
      for (let t = 0; t + 2 < count; t += 3) {
        const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        full[i0 + t] = v0 + a;
        full[i0 + t + 1] = v0 + (flip ? c : b);
        full[i0 + t + 2] = v0 + (flip ? b : c);
      }
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = g.boundingSphere!;
      const scale = M.getMaxScaleOnAxis() || 1;
      _v.copy(s.center).applyMatrix4(M);
      const r = s.radius * scale + 1;
      const member: Member = {
        mesh: m,
        material: m.material as THREE.Material,
        geometry: g,
        matrix: Float64Array.from(e),
        batch,
        start: i0,
        count: count - (count % 3),
        lx: s.center.x,
        ly: s.center.y,
        lz: s.center.z,
        lr: s.radius,
        wx: _v.x,
        wy: _v.y,
        wz: _v.z,
        wr: Number.isFinite(r) ? r : Infinity,
        mask: m.layers.mask || 1,
        cull: (m.userData.cullDistance as number | undefined) ?? Infinity,
        calm: CALM_FRAMES,
        need: CALM_FRAMES,
        merged: false,
        included: false,
      };
      m.userData.staticBatch = true;
      batch.members.push(member);
      this.members.push(member);
      v0 += n;
      i0 += member.count;
    }
    for (const k in arrays) geo.setAttribute(k, new THREE.BufferAttribute(arrays[k].out, arrays[k].size, (first.attributes[k] as THREE.BufferAttribute).normalized));
    // Static usage: repack() uploads it (version + update range) when the packing changes; a
    // DynamicDrawUsage buffer was uploaded whole on every render (renderer.ts compactLevel).
    const index = new THREE.BufferAttribute(new Uint32Array(i0), 1);
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere();
    const mesh = new THREE.Mesh(geo, list[0].material);
    mesh.name = `batch:${(list[0].material as THREE.Material).name}`;
    mesh.matrixAutoUpdate = false;
    mesh.userData.staticBatch = true;
    mesh.visible = false;
    batch.mesh = mesh;
    this.group.add(mesh);
    this.batches.push(batch);
  }

  private inRoot(m: THREE.Object3D): boolean {
    for (let o: THREE.Object3D | null = m; o; o = o.parent) if (o === this.root) return true;
    return false;
  }

  /** Is the mesh drawn at all (it and every ancestor visible, inside `root`)? */
  private shown(m: THREE.Object3D): boolean {
    for (let o: THREE.Object3D | null = m; o; o = o.parent) {
      if (!o.visible) return false;
      if (o === this.root) return true;
    }
    return false;
  }

  /** Per frame, after the culler (zone visibility for this frame) and before rendering. */
  update(culler: ZoneCuller | null) {
    const t0 = performance.now();
    const vv = culler ? culler.objectsVersion : 0;
    const zonesChanged = vv !== this.visVersion;
    this.visVersion = vv;
    let merged = 0, included = 0;
    for (const m of this.members) {
      const mesh = m.mesh;
      let same = this.enabled && mesh.material === m.material && mesh.geometry === m.geometry && this.shown(mesh);
      if (same) {
        const e = mesh.matrixWorld.elements, s = m.matrix;
        for (let i = 0; i < 16; i++) {
          if (e[i] !== s[i]) {
            same = false;
            break;
          }
        }
      }
      if (!this.enabled) m.calm = m.need; // switched off for a comparison: merge again at once
      else if (!same) {
        if (m.merged) m.need = Math.min(CALM_MAX, 2 * m.need);
        m.calm = 0;
      } else if (m.calm < m.need) m.calm++;
      const now = same && m.calm >= m.need;
      let include = false;
      if (now) {
        merged++;
        if (mesh.layers.mask !== 0) mesh.layers.mask = 0;
        include = m.merged && !zonesChanged ? m.included : !culler || culler.objectVisible(m.wx, m.wy, m.wz, m.wr, m.cull);
        if (include) included++;
      } else {
        // Drawn on its own: zone-culled like every other rigid mesh (visibility.ts).
        let show = true;
        if (culler && mesh.visible) {
          const e = mesh.matrixWorld.elements;
          const x = m.lx, y = m.ly, z = m.lz;
          const sc = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])) || 1;
          show = culler.objectVisible(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], m.lr * sc + 1, m.cull);
        }
        const mask = show ? m.mask : 0;
        if (mesh.layers.mask !== mask) mesh.layers.mask = mask;
      }
      m.merged = now;
      if (include !== m.included) {
        m.included = include;
        m.batch.dirty = true;
      }
    }
    for (const b of this.batches) if (b.dirty) this.repack(b);
    const st = this.stats;
    st.merged = merged;
    st.included = included;
    st.ms = performance.now() - t0;
  }

  /** Pack the included members' triangles to the front of the index buffer; bounds = theirs. */
  private repack(b: Batch) {
    b.dirty = false;
    const geo = b.mesh.geometry;
    const index = geo.index!;
    const out = index.array as Uint32Array;
    const full = b.full;
    let o = 0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const m of b.members) {
      if (!m.included) continue;
      out.set(full.subarray(m.start, m.start + m.count), o);
      o += m.count;
      const r = m.wr - 1;
      x0 = Math.min(x0, m.wx - r);
      y0 = Math.min(y0, m.wy - r);
      z0 = Math.min(z0, m.wz - r);
      x1 = Math.max(x1, m.wx + r);
      y1 = Math.max(y1, m.wy + r);
      z1 = Math.max(z1, m.wz + r);
    }
    b.count = o;
    geo.setDrawRange(0, o);
    b.mesh.visible = o > 0;
    if (o > 0) {
      const s = geo.boundingSphere!;
      s.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      s.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
      index.clearUpdateRanges();
      index.addUpdateRange(0, o);
      index.needsUpdate = true;
    }
    this.stats.repacks++;
  }

  dispose() {
    for (const m of this.members) {
      m.mesh.layers.mask = m.mask;
      delete m.mesh.userData.staticBatch;
    }
    for (const b of this.batches) b.mesh.geometry.dispose();
    this.members.length = 0;
    this.batches.length = 0;
    this.group.removeFromParent();
  }
}
