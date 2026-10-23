// Enhanced gore: wounds and blood soaking into a character (docs/enhanced.md "Gore").
//
// A wounded body gets two overlays: skinned meshes on the same geometry and skeleton, drawn over
// it with two shared materials. Each wound is a point in the mesh's rest pose (the bind-pose
// position of the vertex nearest the hit, so it rides the skin through every clip and stays where
// it was struck) with a radius. Per fragment the overlays measure the rest-pose distance to each
// wound: a dark core, a stain that soaks outwards into the clothes over half a minute (blood.ts
// soakRadius), runs a little further downwards, has a ragged edge (3D noise in rest space) and
// dries from wet red to brown. Blood dyes what it soaks: the first overlay multiplies the body's
// own colour by the blood's transmission (a white shirt turns crimson, a navy uniform near black,
// skin dark red); the second adds the wet stain's specular (engine light set, flashlight, lamps,
// GGX with the stain's roughness). The wound data are per-object uniforms read from the overlay
// being drawn, so every body shares the two shaders.

import * as THREE from 'three/webgpu';
import { exp, float, length, mix, mx_noise_float, positionGeometry, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { engineFogFactor, engineLitColor } from '../../engine-light';
import { DRY_TAU, SOAK, SOAK_TAU } from './blood';
import { goreTime } from './decals';
import { MAX_WOUNDS } from './config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Transmission of blood soaked into cloth / skin: fresh, dried, and the wound itself. */
export const DYE_WET = [0.6, 0.055, 0.045] as const;
export const DYE_DRY = [0.3, 0.12, 0.09] as const;
export const DYE_CORE = [0.07, 0.008, 0.008] as const;

/** Per-overlay wound data (Object3D.userData.goreWounds). */
interface WoundData {
  /** Rest-pose centre (model units) and first radius. */
  c: THREE.Vector4[];
  /** Birth time, strength (0..1.5), noise seed, active 0/1. */
  q: THREE.Vector4[];
}

const ZERO = new THREE.Vector4(0, 0, 0, 0);
const dataOf = (o: THREE.Object3D) => o.userData.goreWounds as WoundData | undefined;
const C: N[] = Array.from({ length: MAX_WOUNDS }, (_, i) => uniform(new THREE.Vector4(0, 0, 0, 0)).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => (object && dataOf(object)?.c[i]) || ZERO));
const Q: N[] = Array.from({ length: MAX_WOUNDS }, (_, i) => uniform(new THREE.Vector4(0, 0, 0, 0)).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => (object && dataOf(object)?.q[i]) || ZERO));

/** Coverage, core and wetness of the stains at this fragment. */
function stains(): { cov: N; core: N; wet: N } {
  const P: N = positionGeometry;
  let cov: N = float(0), core: N = float(0), wet: N = float(0);
  for (let i = 0; i < MAX_WOUNDS; i++) {
    const c: N = C[i], q: N = Q[i];
    const age: N = goreTime.sub(q.x).max(0);
    const soak: N = float(1).add(float(SOAK - 1).mul(float(1).sub(exp(age.div(SOAK_TAU).negate()))));
    const r: N = c.w.mul(soak).mul(q.y.max(0.3));
    const d3: N = P.sub(c.xyz);
    // Runs: the stain reaches further below the wound (an upright body's rest pose).
    const sy: N = d3.y.lessThan(0).select(float(0.55), float(1.1));
    const d: N = length(vec3(d3.x, d3.y.mul(sy), d3.z));
    const n: N = mx_noise_float(P.mul(26).add(q.z));
    const m1: N = smoothstep(r, r.mul(0.45), d.add(n.mul(r).mul(0.32))).mul(q.w);
    const k: N = smoothstep(c.w.mul(0.3), c.w.mul(0.08), d.add(n.mul(c.w).mul(0.1))).mul(q.w).mul(q.y.min(1));
    // Cloth soaks thin: it dries faster than a pool (0.6 × DRY_TAU).
    const wi: N = m1.mul(exp(age.div(DRY_TAU * 0.6).negate()));
    cov = cov.max(m1);
    core = core.max(k);
    wet = wet.max(wi);
  }
  return { cov, core, wet };
}

let shared: { dye: THREE.MeshBasicNodeMaterial; sheen: THREE.MeshBasicNodeMaterial } | null = null;

/** The two overlay materials (shared by every wounded body). */
export function woundMaterials(): { dye: THREE.MeshBasicNodeMaterial; sheen: THREE.MeshBasicNodeMaterial } {
  if (shared) return shared;
  const v3 = (c: readonly number[]): N => vec3(c[0], c[1], c[2]);
  // Dye: the frame × the blood's transmission (blend: dst × src), fading out in the fog.
  const dye = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  {
    const s = stains();
    const tint: N = mix(mix(v3(DYE_DRY), v3(DYE_WET), s.wet), v3(DYE_CORE), s.core);
    const t: N = mix(vec3(1), tint, s.cov.mul(0.92).max(s.core));
    dye.colorNode = vec4(mix(t, vec3(1), engineFogFactor), 1);
    dye.blending = THREE.CustomBlending;
    dye.blendEquation = THREE.AddEquation;
    dye.blendSrc = THREE.DstColorFactor;
    dye.blendDst = THREE.ZeroFactor;
    dye.blendSrcAlpha = THREE.ZeroFactor;
    dye.blendDstAlpha = THREE.OneFactor;
  }
  // Sheen: the wet stain's specular alone (engineLitColor of a black albedo), added.
  const sheen = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  {
    const s = stains();
    const rough: N = mix(mix(float(0.8), float(0.25), s.wet), float(0.12), s.core);
    const spec: N = mix(mix(float(0.1), float(0.7), s.wet), float(1), s.core);
    const rgb: N = engineLitColor(vec3(0), { precomputed: false, lightSet: true, surface: { roughness: rough, specular: spec } });
    sheen.colorNode = vec4(rgb.mul(float(1).sub(engineFogFactor)), s.cov.max(s.core));
    sheen.blending = THREE.AdditiveBlending;
  }
  for (const m of [dye, sheen]) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -2;
    m.lights = false;
    m.userData.engineLit = true;
  }
  dye.name = 'gore-wound-dye';
  sheen.name = 'gore-wound-sheen';
  shared = { dye, sheen };
  return shared;
}

export interface WoundBody {
  mesh: THREE.SkinnedMesh;
  /** The dye and sheen overlays. */
  overlays: THREE.SkinnedMesh[];
  data: WoundData;
  /** Next slot to (re)use. */
  next: number;
  lastHit: number;
}

const tv = new THREE.Vector3();
const tw = new THREE.Vector3();

/**
 * The bind-pose position (model units) of the vertex nearest `world` on a skinned mesh posed now,
 * and its distance (m); null without vertices.
 */
export function restPointNear(mesh: THREE.SkinnedMesh, world: THREE.Vector3Like): { rest: THREE.Vector3; dist: number } | null {
  const pos = mesh.geometry.getAttribute('position');
  if (!pos || !mesh.skeleton) return null;
  mesh.updateMatrixWorld(true);
  let best = -1, bd = Infinity;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, tv);
    tv.applyMatrix4(mesh.matrixWorld);
    const d = (tv.x - world.x) ** 2 + (tv.y - world.y) ** 2 + (tv.z - world.z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (best < 0) return null;
  return { rest: tw.fromBufferAttribute(pos, best).clone(), dist: Math.sqrt(bd) };
}

/** Bodies with overlays (the tier's budget: the least recently hit gives its overlay up). */
export class Wounds {
  readonly bodies = new Map<THREE.SkinnedMesh, WoundBody>();
  constructor(
    public maxBodies: number,
    public perBody: number,
  ) {}

  /**
   * A wound at `world` on the body: radius (m), strength 0..1.5, game time. False when the point is
   * not on it (> 0.3 m from every vertex).
   */
  add(mesh: THREE.SkinnedMesh, world: THREE.Vector3Like, radius: number, strength: number, time: number): boolean {
    const near = restPointNear(mesh, world);
    if (!near || near.dist > 0.3) return false;
    let b = this.bodies.get(mesh);
    if (!b) {
      if (this.bodies.size >= this.maxBodies) {
        let old: WoundBody | undefined;
        for (const x of this.bodies.values()) if (!old || x.lastHit < old.lastHit) old = x;
        if (old) this.drop(old.mesh);
      }
      const data: WoundData = { c: Array.from({ length: MAX_WOUNDS }, () => new THREE.Vector4(0, 0, 0, 0)), q: Array.from({ length: MAX_WOUNDS }, () => new THREE.Vector4(0, 0, 0, 0)) };
      const mats = woundMaterials();
      const overlays = [mats.dye, mats.sheen].map((m, i) => {
        const o = new THREE.SkinnedMesh(mesh.geometry, m);
        o.bind(mesh.skeleton, mesh.bindMatrix);
        o.bindMode = mesh.bindMode;
        o.frustumCulled = false;
        o.name = i ? 'gore-wound-sheen' : 'gore-wound-dye';
        o.renderOrder = 1 + i;
        o.userData.goreWounds = data;
        mesh.add(o);
        return o;
      });
      b = { mesh, overlays, data, next: 0, lastHit: time };
      this.bodies.set(mesh, b);
    }
    // Model units: the mesh may be scaled.
    const s = mesh.matrixWorld.getMaxScaleOnAxis() || 1;
    const n = Math.max(1, Math.min(this.perBody, MAX_WOUNDS));
    // A hit right on an existing wound deepens it instead of taking a slot.
    for (let i = 0; i < n; i++) {
      const c = b.data.c[i], q = b.data.q[i];
      if (q.w > 0 && tv.set(c.x, c.y, c.z).distanceTo(near.rest) * s < radius * 0.6) {
        q.y = Math.min(1.5, q.y + strength * 0.5);
        c.w = Math.max(c.w, (radius / s) * 0.9);
        b.lastHit = time;
        return true;
      }
    }
    const i = b.next % n;
    b.next = i + 1;
    b.data.c[i].set(near.rest.x, near.rest.y, near.rest.z, radius / s);
    b.data.q[i].set(time, strength, Math.random() * 100, 1);
    b.lastHit = time;
    return true;
  }

  /** Keep each overlay on its body's current geometry (Part Caps swap the index, dismember.ts). */
  update() {
    for (const b of this.bodies.values()) {
      if (!b.mesh.parent) {
        this.drop(b.mesh);
        continue;
      }
      for (const o of b.overlays) if (o.geometry !== b.mesh.geometry) o.geometry = b.mesh.geometry;
    }
  }

  drop(mesh: THREE.SkinnedMesh) {
    const b = this.bodies.get(mesh);
    if (!b) return;
    for (const o of b.overlays) o.removeFromParent();
    this.bodies.delete(mesh);
  }

  setBudget(maxBodies: number, perBody: number) {
    this.maxBodies = maxBodies;
    this.perBody = perBody;
    while (this.bodies.size > maxBodies) {
      let old: WoundBody | undefined;
      for (const x of this.bodies.values()) if (!old || x.lastHit < old.lastHit) old = x;
      if (!old) break;
      this.drop(old.mesh);
    }
  }

  clear() {
    for (const m of [...this.bodies.keys()]) this.drop(m);
  }
}
