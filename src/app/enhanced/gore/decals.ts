// Enhanced gore: blood films on the level (docs/enhanced.md "Gore"). Spatters, drops, trails and
// pools are projected onto the level's drawn triangles exactly as fx/decals.ts projects the
// original's decals (Decals.project: clipped to the decal box, wrapping steps and corners), but
// all of a kind live in one vertex buffer recycled as a ring (ring.ts): one draw call and one
// shader for every splat, whatever the count.
//
// Shading (blood.ts has the CPU twin): the film's thickness comes from the splat atlas
// (splats.ts); colour, coverage, gloss and drying follow its age in the shader (no per-splat
// uniforms, nothing to update on the CPU). It is lit by the Enhanced hooks like the level itself:
// engineLitColor with the surface's baked light carried as the vertex colour, the per-pixel
// flashlight, lamp shadows and GGX specular with the film's own roughness, specular and relief
// normal. So fresh blood catches the flashlight with a wet highlight and dries matte.

import * as THREE from 'three/webgpu';
import { attribute, cross, dFdx, dFdy, dot, exp, float, mix, normalWorld, positionWorld, sign, smoothstep, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import { engineLitColor } from '../../engine-light';
import { ALPHA_HI, ALPHA_LO, DRY, DRY_TAU, POOL_DELAY, ROUGH_DRY, ROUGH_WET, SPEC_DRY, SPEC_WET, WET_THICK, WET_THIN } from './blood';
import { DecalRing } from './ring';
import { tileRect, type SplatAtlas } from './splats';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Game time (s) the films age by (EnhancedGore.update). */
export const goreTime: N = uniform(0);
/** 1: the film's relief perturbs its normal (tier: GoreTier.bump). */
export const goreBump: N = uniform(1);

export function atlasTexture(a: SplatAtlas): THREE.DataTexture {
  const t = new THREE.DataTexture(a.data, a.width, a.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.name = 'gore-splats';
  t.needsUpdate = true;
  return t;
}

const v3 = (c: readonly number[]): N => vec3(c[0], c[1], c[2]);

/**
 * World normal bent by a height field h (metres) given per pixel: the surface-gradient bump of
 * Mikkelsen (screen derivatives; no tangents needed).
 */
export function bumpNormal(h: N): N {
  const Nn: N = normalWorld;
  const p: N = positionWorld;
  const dpdx: N = dFdx(p), dpdy: N = dFdy(p);
  const dhdx: N = dFdx(h), dhdy: N = dFdy(h);
  const r1: N = cross(dpdy, Nn), r2: N = cross(Nn, dpdx);
  const det: N = dot(dpdx, r1);
  const grad: N = r1.mul(dhdx).add(r2.mul(dhdy)).mul(sign(det));
  return Nn.mul(det.abs()).sub(grad).normalize();
}

/** The blood film's albedo / coverage / gloss for a thickness and an age (blood.ts bloodLook). */
export function filmLook(thick: N, age: N, variation: N): { albedo: N; dry: N; k: N; rough: N; spec: N } {
  const dry: N = float(1).sub(exp(age.div(thick.max(0).add(0.25).mul(DRY_TAU)).negate()));
  const k: N = smoothstep(0.1, 0.8, thick);
  const wet: N = mix(v3(WET_THIN), v3(WET_THICK), k);
  // Clots and uneven drying: ±17 % in brightness from the slow noise channel.
  const albedo: N = mix(wet, v3(DRY), dry).mul(variation.mul(0.35).add(0.83));
  return { albedo, dry, k, rough: mix(float(ROUGH_WET), float(ROUGH_DRY), dry), spec: mix(float(SPEC_WET), float(SPEC_DRY), dry) };
}

/**
 * The shared film material. Vertex attributes: `uv` (atlas), `color` (baked light C of the level
 * under it), `normal`, `gore` = (birth time, pool spreading time constant (0: not a pool), opacity, relief
 * height in metres).
 */
export function filmMaterial(atlas: THREE.Texture): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -3;
  m.polygonOffsetUnits = -3;
  const g: N = attribute('gore', 'vec4');
  const tx: N = texture(atlas, uv());
  const age: N = goreTime.sub(g.x).max(0);
  // Pools (gore.y = their spreading time constant, s) spread outwards in the order of the atlas'
  // arrival channel; every other film is there at once.
  const reach: N = float(1).sub(exp(age.sub(POOL_DELAY).max(0).div(g.y.max(1e-3)).negate()));
  const revealed: N = g.y.greaterThan(0).select(smoothstep(tx.g.sub(0.035), tx.g, reach), float(1));
  const thick: N = tx.r.mul(revealed);
  const f = filmLook(thick, age, tx.b);
  const alpha: N = smoothstep(ALPHA_LO, ALPHA_HI, thick).mul(g.z).mul(float(1).sub(f.dry.mul(0.25).mul(float(1).sub(f.k))));
  const normal: N = bumpNormal(thick.mul(g.w).mul(goreBump));
  const rgb: N = engineLitColor(f.albedo, { precomputed: true, surface: { normal, roughness: f.rough, specular: f.spec } });
  m.colorNode = vec4(rgb, alpha);
  m.lights = false;
  (m as THREE.Material & { vertexColors: boolean }).vertexColors = false;
  m.userData.engineLit = true;
  m.name = 'gore-film';
  return m;
}

/** A projected decal (fx/decals.ts Decals.project output: non-indexed positions + uvs). */
export interface ProjectedSplat {
  positions: ArrayLike<number>;
  uvs: ArrayLike<number>;
}

const ATTRS = { position: 3, normal: 3, uv: 2, color: 3, gore: 4 } as const;
type AttrName = keyof typeof ATTRS;

/** One kind of film (spatters, or pools) in one ring buffer, one mesh. */
export class FilmBatch {
  readonly mesh: THREE.Mesh;
  readonly ring: DecalRing;
  private readonly geo = new THREE.BufferGeometry();
  private readonly attrs = {} as Record<AttrName, THREE.BufferAttribute>;
  private dirtyLo = Infinity;
  private dirtyHi = -1;

  constructor(name: string, material: THREE.Material, size: number, capacity: number, budget: number) {
    this.ring = new DecalRing(size, capacity, budget);
    for (const [k, n] of Object.entries(ATTRS) as [AttrName, number][]) {
      const a = new THREE.BufferAttribute(new Float32Array(size * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      this.attrs[k] = a;
      this.geo.setAttribute(k, a);
    }
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    // First among the transparent passes: the films lie on opaque surfaces (smoke, glass and
    // particles in front of them blend over them, not under).
    this.mesh.renderOrder = -1;
    this.mesh.matrixAutoUpdate = false;
  }

  get count() {
    return this.ring.records.length;
  }

  /**
   * Add a splat: its projected triangles, the atlas tile, the baked light under it, the decal
   * normal (triangle normals are turned towards it) and gore = [birth, pool, opacity, relief].
   */
  add(s: ProjectedSplat, tile: number, light: { r: number; g: number; b: number }, n: THREE.Vector3Like, gore: [number, number, number, number]): boolean {
    const nv = s.positions.length / 3;
    const a = this.ring.alloc(nv);
    if (!a) return false;
    for (const e of a.evicted) if (e.start + e.count > a.start + nv || e.start < a.start) this.zero(e.start, e.count);
    const [u0, v0, du, dv] = tileRect(tile);
    const P = this.attrs.position.array as Float32Array, Nm = this.attrs.normal.array as Float32Array;
    const UV = this.attrs.uv.array as Float32Array, C = this.attrs.color.array as Float32Array, G = this.attrs.gore.array as Float32Array;
    const sp = s.positions, su = s.uvs;
    for (let i = 0; i < nv; i += 3) {
      // Triangle normal, facing the decal's normal.
      const ax = sp[3 * i], ay = sp[3 * i + 1], az = sp[3 * i + 2];
      const e1x = sp[3 * i + 3] - ax, e1y = sp[3 * i + 4] - ay, e1z = sp[3 * i + 5] - az;
      const e2x = sp[3 * i + 6] - ax, e2y = sp[3 * i + 7] - ay, e2z = sp[3 * i + 8] - az;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      const sgn = nx * n.x + ny * n.y + nz * n.z < 0 ? -1 / l : 1 / l;
      nx *= sgn; ny *= sgn; nz *= sgn;
      for (let k = 0; k < 3 && i + k < nv; k++) {
        const j = i + k, o = a.start + j;
        P[3 * o] = sp[3 * j]; P[3 * o + 1] = sp[3 * j + 1]; P[3 * o + 2] = sp[3 * j + 2];
        Nm[3 * o] = nx; Nm[3 * o + 1] = ny; Nm[3 * o + 2] = nz;
        UV[2 * o] = u0 + Math.min(1, Math.max(0, su[2 * j])) * du;
        UV[2 * o + 1] = v0 + Math.min(1, Math.max(0, su[2 * j + 1])) * dv;
        C[3 * o] = light.r; C[3 * o + 1] = light.g; C[3 * o + 2] = light.b;
        G[4 * o] = gore[0]; G[4 * o + 1] = gore[1]; G[4 * o + 2] = gore[2]; G[4 * o + 3] = gore[3];
      }
    }
    this.dirty(a.start, nv);
    return true;
  }

  /** Clear a vertex range (degenerate, transparent). */
  private zero(start: number, count: number) {
    for (const [k, n] of Object.entries(ATTRS) as [AttrName, number][]) (this.attrs[k].array as Float32Array).fill(0, start * n, (start + count) * n);
    this.dirty(start, count);
  }

  private dirty(start: number, count: number) {
    this.dirtyLo = Math.min(this.dirtyLo, start);
    this.dirtyHi = Math.max(this.dirtyHi, start + count);
  }

  /** A new tier's budget. */
  resize(capacity: number, budget: number) {
    for (const r of this.ring.resize(capacity, budget)) this.zero(r.start, r.count);
  }

  /** Upload what changed this frame. */
  flush() {
    if (this.dirtyHi < 0) return;
    for (const [k, n] of Object.entries(ATTRS) as [AttrName, number][]) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(this.dirtyLo * n, (this.dirtyHi - this.dirtyLo) * n);
      a.needsUpdate = true;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  clear() {
    for (const r of this.ring.clear()) this.zero(r.start, r.count);
    this.flush();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
  }
}
