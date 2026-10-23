// Enhanced gore: blood droplets in flight (docs/enhanced.md "Gore"). Heavy drops of 0.5-4 mm:
// ballistic with gravity and quadratic air drag (terminal speed 2-9 m/s by size), they fly until
// they hit the level and leave a splat shaped by their impact (blood.ts impactShape). One
// instanced draw: each drop is a camera-facing impostor stretched along its screen motion over a
// 1/60 s exposure (a streak when fast, a bead when slow), never thinner than about a pixel
// (energy kept by its alpha). Shading: a sphere normal across the impostor, lit by the baked
// light where it started, the per-pixel flashlight (with its shadow) and a GGX highlight, so a
// spray in the beam glints wet.

import * as THREE from 'three/webgpu';
import { cameraPosition, cameraProjectionMatrix, cameraViewMatrix, cameraWorldMatrix, dot, float, instancedDynamicBufferAttribute, length, pow, positionGeometry, smoothstep, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import type { CollisionWorld } from '../../physics';
import { enhancedShading, engineLightInternals } from '../../engine-light';
import { EU } from '../lights';
import { flashRadiance, ggx } from '../shading';
import { LIGHT_SOFT } from '../tone';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const GRAVITY = 9.8;
/** Exposure a streak is drawn over (s). */
const EXPOSURE = 1 / 60;
/** Linear albedo of a drop (thin: lighter than a pool). */
const DROP_ALBEDO = [0.2, 0.01, 0.008] as const;

export interface DropSpawn {
  p: THREE.Vector3Like;
  v: THREE.Vector3Like;
  /** Radius (m). */
  r: number;
  /** Baked light C where it starts (gamma, L = 2C). */
  light: { r: number; g: number; b: number };
  /** Paints a splat where it lands. */
  splat: boolean;
}

/** Terminal speed (m/s) of a drop of radius r (m): 2 m/s for mist, about 9 m/s for 4 mm drops. */
export function terminalSpeed(r: number): number {
  return Math.min(9, 2 + 2200 * r);
}

/** One integration step of a drop (velocity in place); pure (tests). */
export function stepDrop(v: { x: number; y: number; z: number }, r: number, dt: number) {
  const vt = terminalSpeed(r);
  const k = GRAVITY / (vt * vt);
  const s = Math.hypot(v.x, v.y, v.z);
  const drag = 1 / (1 + k * s * dt);
  v.x *= drag;
  v.y = (v.y - GRAVITY * dt) * drag;
  v.z *= drag;
}

const softLight = (L: N): N => {
  const l = vec3(L).max(0);
  const o = l.sub(1).max(0);
  return l.min(1).add(o.div(o.div(LIGHT_SOFT).add(1)));
};

export class Droplets {
  readonly mesh: THREE.Mesh;
  /** Called where a splatting drop lands: point, surface normal, velocity, radius. */
  onLand?: (p: THREE.Vector3, n: THREE.Vector3, v: THREE.Vector3, r: number) => void;
  private n = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly c: Float32Array;
  private readonly r: Float32Array;
  private readonly age: Float32Array;
  private readonly splat: Uint8Array;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly vel: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  /** World size of one pixel per metre of depth (2 tan(fov / 2) / height). */
  readonly pxScale: N = uniform(0.002);
  limit: number;
  spawned = 0;
  landed = 0;

  constructor(readonly cap: number, limit: number) {
    this.limit = Math.min(limit, cap);
    this.p = new Float32Array(cap * 3);
    this.v = new Float32Array(cap * 3);
    this.c = new Float32Array(cap * 3);
    this.r = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.splat = new Uint8Array(cap);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    for (const a of [this.pos, this.vel, this.col]) a.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'gore-droplets';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    (this.mesh as THREE.Mesh & { count: number }).count = 0;
  }

  get count() {
    return this.n;
  }

  private material(): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const iPos: N = instancedDynamicBufferAttribute(this.pos, 'vec4');
    const iVel: N = instancedDynamicBufferAttribute(this.vel, 'vec4');
    const iCol: N = instancedDynamicBufferAttribute(this.col, 'vec4');
    const vPos: N = cameraViewMatrix.mul(vec4(iPos.xyz, 1));
    const vVel: N = cameraViewMatrix.mul(vec4(iVel.xyz, 0)).xy;
    const sp: N = length(vVel);
    const dir: N = sp.greaterThan(1e-4).select(vVel.div(sp.max(1e-4)), vec2(0, 1));
    const perp: N = vec2(dir.y.negate(), dir.x);
    const depth: N = vPos.z.negate().max(0.05);
    const d: N = iPos.w.mul(2);
    // Never thinner than ~1.3 px; a thinner drop keeps its energy through its alpha.
    const width: N = d.max(depth.mul(this.pxScale).mul(1.3));
    const len: N = width.max(d.add(sp.mul(EXPOSURE)));
    const fade: N = d.div(width).mul(d.mul(2).div(len).clamp(0.3, 1));
    const c: N = positionGeometry.xy;
    const off: N = perp.mul(c.x.mul(width)).add(dir.mul(c.y.mul(len)));
    m.vertexNode = cameraProjectionMatrix.mul(vec4(vPos.xy.add(off), vPos.z, 1));
    const vDir: N = varying(dir, 'v_goreDir');
    const vFade: N = varying(fade, 'v_goreFade');
    const vDepth: N = varying(depth, 'v_goreDepth');
    const vP: N = varying(iPos.xyz, 'v_goreP');
    const vL: N = varying(iCol.rgb, 'v_goreL');
    const vA: N = varying(iVel.w, 'v_goreA');
    const q: N = uv().mul(2).sub(1);
    const r2: N = dot(q, q);
    const alpha: N = smoothstep(1, 0.5, r2).mul(vA).mul(vFade);
    // A sphere across the impostor (flattened along the streak).
    const nb: N = vec3(q.x, q.y.mul(0.35), float(1).sub(r2).max(0).sqrt().add(0.15)).normalize();
    const pd: N = vec2(vDir.y.negate(), vDir.x);
    const nV: N = vec3(pd.mul(nb.x).add(vDir.mul(nb.y)), nb.z);
    const nW: N = cameraWorldMatrix.mul(vec4(nV, 0)).xyz.normalize();
    const V: N = cameraPosition.sub(vP).normalize();
    const L: N = vL.mul(2);
    const E: N = pow(softLight(L).max(EU.ambientFloor), vec3(2.2)).mul(EU.engineGain);
    const fl: N = flashRadiance(vP, nW);
    const albedo: N = vec3(DROP_ALBEDO[0], DROP_ALBEDO[1], DROP_ALBEDO[2]);
    const rgb: N = albedo.mul(E.add(fl.xyz.mul(fl.w))).add(fl.xyz.mul(ggx(nW, V, EU.flPos.sub(vP).normalize(), float(0.08), float(0.03))));
    const { u } = engineLightInternals();
    const fogF: N = vDepth.sub(u.fogNear).div(u.fogFar.sub(u.fogNear).max(1e-3)).clamp(0, 1);
    m.colorNode = enhancedShading.fog ? enhancedShading.fog(vec4(rgb, alpha), fogF, u.fogColor) : vec4(rgb, alpha);
    m.lights = false;
    m.name = 'gore-droplets';
    return m;
  }

  spawn(d: DropSpawn): boolean {
    if (this.n >= this.limit) return false;
    const i = this.n++;
    this.p[3 * i] = d.p.x; this.p[3 * i + 1] = d.p.y; this.p[3 * i + 2] = d.p.z;
    this.v[3 * i] = d.v.x; this.v[3 * i + 1] = d.v.y; this.v[3 * i + 2] = d.v.z;
    this.c[3 * i] = d.light.r; this.c[3 * i + 1] = d.light.g; this.c[3 * i + 2] = d.light.b;
    this.r[i] = d.r;
    this.age[i] = 0;
    this.splat[i] = d.splat ? 1 : 0;
    this.spawned++;
    return true;
  }

  private kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    this.p.copyWithin(3 * i, 3 * j, 3 * j + 3);
    this.v.copyWithin(3 * i, 3 * j, 3 * j + 3);
    this.c.copyWithin(3 * i, 3 * j, 3 * j + 3);
    this.r[i] = this.r[j];
    this.age[i] = this.age[j];
    this.splat[i] = this.splat[j];
  }

  private readonly tv = new THREE.Vector3();

  update(dt: number, col: CollisionWorld | null) {
    const v = this.tv;
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] > 4) {
        this.kill(i);
        continue;
      }
      v.set(this.v[3 * i], this.v[3 * i + 1], this.v[3 * i + 2]);
      stepDrop(v, this.r[i], dt);
      this.v[3 * i] = v.x; this.v[3 * i + 1] = v.y; this.v[3 * i + 2] = v.z;
      const len = v.length() * dt;
      const px = this.p[3 * i], py = this.p[3 * i + 1], pz = this.p[3 * i + 2];
      const h = col && len > 1e-6 ? col.raycast(px, py, pz, v.x, v.y, v.z, len) : null;
      if (h) {
        if (this.splat[i] && this.onLand) {
          this.landed++;
          this.onLand(new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), v.clone(), this.r[i]);
        }
        this.kill(i);
        continue;
      }
      this.p[3 * i] = px + v.x * dt; this.p[3 * i + 1] = py + v.y * dt; this.p[3 * i + 2] = pz + v.z * dt;
    }
    this.write();
  }

  private write() {
    const P = this.pos.array as Float32Array, V = this.vel.array as Float32Array, C = this.col.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      P[4 * i] = this.p[3 * i]; P[4 * i + 1] = this.p[3 * i + 1]; P[4 * i + 2] = this.p[3 * i + 2]; P[4 * i + 3] = this.r[i];
      V[4 * i] = this.v[3 * i]; V[4 * i + 1] = this.v[3 * i + 1]; V[4 * i + 2] = this.v[3 * i + 2];
      // Fade in over the first frame (no pop at the wound), out after 3 s.
      V[4 * i + 3] = Math.min(1, this.age[i] * 30 + 0.3) * Math.min(1, Math.max(0, 4 - this.age[i]));
      C[4 * i] = this.c[3 * i]; C[4 * i + 1] = this.c[3 * i + 1]; C[4 * i + 2] = this.c[3 * i + 2]; C[4 * i + 3] = 1;
    }
    for (const a of [this.pos, this.vel, this.col]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, this.n) * 4);
      a.needsUpdate = true;
    }
    (this.mesh as THREE.Mesh & { count: number }).count = this.n;
  }

  clear() {
    this.n = 0;
    (this.mesh as THREE.Mesh & { count: number }).count = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
