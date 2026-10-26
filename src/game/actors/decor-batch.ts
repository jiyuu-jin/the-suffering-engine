// Merged draws of skinned decorations (docs/perf.md Perf D), Enhanced mode (DECOR_BATCH): 9
// places 153 swaying trees as Animating Statics, each its own skinned model of two or three
// materials, which was 439 draws a frame and as many again in Enhanced's shadow passes (1108
// draws at High, 18 ms of main thread: 48 fps). Every tree keeps its Actor, its Character (bones,
// clip, mixer) and its place in the scene graph; only the drawing changes.
//
// Per model (one decoration kind: geometry and materials shared by its members), one
// SkinnedMesh at the origin draws all members: the model's vertices once per member, each
// member's skin indices offset into one skeleton made of the members' own bones (their bone
// inverses too). A member is drawn in it while its own mesh would be drawn (it and every ancestor
// visible: the actor culling, level logic); the others get zero bone matrices this frame, which
// collapses their triangles to a point (no fragments). The members' own meshes move to
// BATCHED_LAYER, which only the projected-shadow silhouette cameras see (engine-light.ts): a tree
// still casts its own projected shadow.
//
// Lighting stays per tree: the members' light sets (engine-light.ts objectLightSet, chosen on
// each member's own bounds, exactly as for its own draw) are packed every frame into a uniform
// array that the merged materials read per vertex (`lightSlot` attribute, ObjectSetNodes).
//
// A member whose mesh no longer draws the model as built (another material or geometry, a
// replaced skeleton: a fade, a swap) leaves the merged draw and is drawn on its own again.

import * as THREE from 'three/webgpu';
import { attribute, int, uniformArray } from 'three/tsl';
import { BATCHED_LAYER, LEGACY_LIGHTING, engineLightMaterial, engineLights, type ObjectSetNodes } from '../../app/engine-light';
import { glowMark } from '../../app/glow-mark';
import { enhancedTextures } from '../../app/surface-material';
import { ENHANCED } from '../../app/enhanced/config';
import type { Actor } from './actor';

const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
/**
 * Merged draws in Enhanced mode only (`?nodecorbatch`: none; `?decorbatch`: Original too). In
 * Original a merged draw is not pixel-identical: three.js draws a skinned mesh through its own
 * world matrix and back (bind matrix inverse, then model and model-view matrices, in float32),
 * the merged one straight in world space, so positions and normals differ in the last bits; at a
 * fixed time in 9, 0.7 % of the pixels differed, by 1.25 levels on average (edges up to 40).
 */
export const DECOR_BATCH = !Q?.has('nodecorbatch') && (ENHANCED || !!Q?.has('decorbatch'));

/** Fewer members than this: not worth a merged mesh. */
const MIN_MEMBERS = 8;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type EnhancedMaterial = THREE.Material & { enhancedMapTextures?: unknown; map?: THREE.Texture | null; alphaTest: number; alphaToCoverage: boolean };

interface Member {
  a: Actor;
  mesh: THREE.SkinnedMesh;
  /** Layers mask of the mesh drawn on its own. */
  mask: number;
  /** In the merged draw (eligible); drawn this frame (shown). */
  merged: boolean;
  drawn: boolean;
}

/** The members' bones; a member not drawn this frame gets zero matrices. */
export class BatchSkeleton extends THREE.Skeleton {
  constructor(
    bones: THREE.Bone[],
    inverses: THREE.Matrix4[],
    private readonly per: number,
    private readonly members: readonly Pick<Member, 'merged' | 'drawn'>[],
  ) {
    super(bones, inverses);
  }

  update() {
    const bones = this.bones, inv = this.boneInverses, out = this.boneMatrices!;
    const m = _m;
    for (let j = 0; j < this.members.length; j++) {
      const on = this.members[j].merged && this.members[j].drawn;
      for (let k = j * this.per, end = k + this.per; k < end; k++) {
        if (on) m.multiplyMatrices(bones[k].matrixWorld, inv[k]).toArray(out, k * 16);
        else out.fill(0, k * 16, k * 16 + 16);
      }
    }
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}
const _m = new THREE.Matrix4();

class Batch {
  readonly mesh: THREE.SkinnedMesh;
  private readonly sets: THREE.Vector4[];
  private readonly materials: EnhancedMaterial[];
  private setsFrame = -1;

  /** The model as built: what a member's mesh must still draw to stay merged. */
  readonly geometry: THREE.BufferGeometry;
  readonly bonesPer: number;

  constructor(
    readonly members: Member[],
    readonly sources: EnhancedMaterial[],
    key: string,
  ) {
    const proto = members[0].mesh;
    const g = (this.geometry = proto.geometry);
    this.bonesPer = proto.skeleton.bones.length;
    const per = proto.skeleton.bones.length;
    const count = members.length;
    const geo = mergeMembers(g, count, per);
    const bones: THREE.Bone[] = [], inverses: THREE.Matrix4[] = [];
    for (const m of members) {
      bones.push(...m.mesh.skeleton.bones);
      inverses.push(...m.mesh.skeleton.boneInverses);
    }
    this.sets = Array.from({ length: 3 * count }, () => new THREE.Vector4(-1, -1, -1, -1));
    const arr: N = uniformArray(this.sets, 'vec4');
    const base = int(attribute('lightSlot', 'float')).mul(3);
    const b = arr.element(base.add(1));
    const nodes: ObjectSetNodes = { key, points: arr.element(base), point5: b.w, ambient: b.xyz, dirs: arr.element(base.add(2)).x };
    const layout = enhancedTextures.layout?.();
    this.materials = sources.map((s) => {
      const c = s.clone() as EnhancedMaterial;
      c.name = `${s.name} (batch)`;
      c.enhancedMapTextures = s.enhancedMapTextures;
      engineLightMaterial(c as unknown as THREE.NodeMaterial, { precomputed: false, lightSet: true, enhancedMaps: layout, objectSet: nodes });
      return c;
    });
    const mesh = new THREE.SkinnedMesh(geo, this.materials);
    mesh.name = `decor-batch ${key}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = proto.castShadow;
    mesh.receiveShadow = proto.receiveShadow;
    mesh.bind(new BatchSkeleton(bones, inverses, per, members), new THREE.Matrix4());
    mesh.onBeforeRender = () => this.beforeRender();
    // Picking and hit tests go to the members (their own meshes stay in the scene graph).
    mesh.raycast = () => {};
    this.mesh = mesh;
  }

  /** Every draw of the merged mesh (main and shadow passes): this frame's light sets, the sources' state. */
  private beforeRender() {
    const f = engineLights.frameId;
    if (f === this.setsFrame) return;
    this.setsFrame = f;
    const sets = this.sets;
    for (let j = 0; j < this.members.length; j++) {
      const m = this.members[j];
      if (!m.merged || !m.drawn) continue;
      const s = engineLights.objectLightSet(m.mesh);
      sets[3 * j].copy(s.points);
      sets[3 * j + 1].set(s.ambient.x, s.ambient.y, s.ambient.z, s.point5);
      sets[3 * j + 2].set(s.dirs, 0, 0, 0);
    }
    // Follow what other systems do to the shared materials (texture enhancement, fades).
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i], c = this.materials[i];
      if (c.map !== s.map) {
        if (!c.map !== !s.map) c.needsUpdate = true;
        c.map = s.map ?? null;
      }
      c.enhancedMapTextures = s.enhancedMapTextures;
      if (c.alphaTest !== s.alphaTest || c.alphaToCoverage !== s.alphaToCoverage || c.side !== s.side || c.transparent !== s.transparent || c.depthWrite !== s.depthWrite || c.blending !== s.blending) {
        c.alphaTest = s.alphaTest;
        c.alphaToCoverage = s.alphaToCoverage;
        c.side = s.side;
        c.transparent = s.transparent;
        c.depthWrite = s.depthWrite;
        c.blending = s.blending;
        c.needsUpdate = true;
      }
      c.opacity = s.opacity;
      c.visible = s.visible;
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.mesh.skeleton.dispose();
  }
}

/**
 * The merged geometry of `count` members of one skinned model of `per` bones: every attribute
 * repeated per member, skin indices offset by member × per, a `lightSlot` attribute (the member),
 * one group per source group with that group's triangles of every member, member after member.
 */
export function mergeMembers(g: THREE.BufferGeometry, count: number, per: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const geo = new THREE.BufferGeometry();
  for (const name in g.attributes) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const Ctor = (a.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
    const size = n * a.itemSize;
    const out = new Ctor(size * count);
    const src = (a.array as THREE.TypedArray).subarray(0, size);
    for (let j = 0; j < count; j++) {
      out.set(src, j * size);
      if (name === 'skinIndex') for (let i = j * size, e = i + size; i < e; i++) out[i] += j * per;
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
  }
  const slot = new Float32Array(n * count);
  for (let j = 0; j < count; j++) slot.fill(j, j * n, (j + 1) * n);
  geo.setAttribute('lightSlot', new THREE.BufferAttribute(slot, 1));
  const src = g.index!.array;
  const idx = new Uint32Array(src.length * count);
  let o = 0;
  for (const gr of g.groups) {
    const start = o;
    for (let j = 0; j < count; j++) for (let i = gr.start; i < gr.start + gr.count; i++) idx[o++] = src[i] + j * n;
    geo.addGroup(start, o - start, gr.materialIndex ?? 0);
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

/** Is the mesh drawn at all (it and every ancestor visible, inside the scene)? */
function shown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) {
    if (!o.visible) return false;
    if ((o as THREE.Scene).isScene) return true;
  }
  return false;
}

/** Can this decoration's model be merged with others of its kind? */
function mergeable(a: Actor): boolean {
  if (!a.kind.decor || a.template) return false;
  const mesh = a.ch.mesh;
  const g = mesh.geometry;
  if (!g.index || !g.groups.length || g.morphAttributes.position || mesh.morphTargetInfluences?.length) return false;
  const mats = mesh.material;
  if (!Array.isArray(mats) || g.groups.some((gr) => (gr.materialIndex ?? 0) >= mats.length)) return false;
  // Only the plain engine-lit character materials (character.ts): opaque or cut-out, no glow mark.
  return mats.every((m) => m.userData.engineLit === true && !m.transparent && !glowMark(m));
}

/** The merged draws of a level's skinned decorations (ActorManager). */
export class DecorBatches {
  private readonly batches: Batch[] = [];
  private readonly members: Member[] = [];
  /** Off: every member drawn on its own (comparisons). */
  enabled = true;

  constructor(actors: readonly Actor[], parent: THREE.Object3D) {
    if (LEGACY_LIGHTING || !DECOR_BATCH) return;
    const kinds = new Map<string, Actor[]>();
    for (const a of actors) {
      if (!mergeable(a)) continue;
      const k = a.kind.key;
      let list = kinds.get(k);
      if (!list) kinds.set(k, (list = []));
      list.push(a);
    }
    let id = 0;
    for (const [key, list] of kinds) {
      const proto = list[0].ch.mesh;
      const same = list.filter((a) => a.ch.mesh.geometry === proto.geometry && a.ch.mesh.material === proto.material && a.ch.mesh.skeleton.bones.length === proto.skeleton.bones.length);
      if (same.length < MIN_MEMBERS) continue;
      const members = same.map((a): Member => ({ a, mesh: a.ch.mesh, mask: a.ch.mesh.layers.mask || 1, merged: false, drawn: false }));
      const b = new Batch(members, proto.material as EnhancedMaterial[], `decor${id++}`);
      parent.add(b.mesh);
      this.batches.push(b);
      this.members.push(...members);
    }
    this.update();
  }

  get stats() {
    let merged = 0, drawn = 0;
    for (const m of this.members) if (m.merged) (merged++, m.drawn && drawn++);
    return { batches: this.batches.length, members: this.members.length, merged, drawn };
  }

  /** Before the frame is drawn (after the actor culling): who is merged, who is drawn. */
  update() {
    for (const b of this.batches) {
      for (const m of b.members) {
        const mesh = m.a.ch.mesh;
        const ok = this.enabled && mesh === m.mesh && mesh.geometry === b.geometry && mesh.material === b.sources && mesh.skeleton.bones.length === b.bonesPer && m.a.kind.decor;
        if (ok !== m.merged) {
          m.merged = ok;
          m.mesh.layers.mask = ok ? 1 << BATCHED_LAYER : m.mask;
        }
        m.drawn = ok && shown(mesh);
      }
    }
  }

  dispose() {
    for (const m of this.members) if (m.merged) m.mesh.layers.mask = m.mask;
    for (const b of this.batches) b.dispose();
    this.batches.length = 0;
    this.members.length = 0;
  }
}
