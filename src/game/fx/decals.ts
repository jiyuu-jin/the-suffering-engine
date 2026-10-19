// Projected decals (bullet holes, scorch marks, blood splats and pools) on the level geometry.
//
// The engine's Decal objects carry a small quad model (its texture and blend mode are the
// decal's look; docs/game-logic.md §17.3). The port projects that texture orthographically along
// the surface normal onto the static collision triangles around the hit point (CollisionWorld
// .trianglesInBox), clipping each triangle to the decal box (Sutherland-Hodgman), so a splat
// wraps over corners and steps and never hangs in the air. Dynamic bodies (doors, props) get no
// decals. A fixed budget keeps the oldest decals from piling up.

import * as THREE from 'three/webgpu';
import type { CollisionWorld } from '../../app/physics';

export interface DecalOptions {
  /** Width / height in model units (≈ m). */
  width: number;
  height?: number;
  /** Rotation about the normal (radians); random when undefined. */
  angle?: number;
  /** Engine blend mode of the decal material (1 alpha, 2 add, 4 reverse-subtract, 5 dst*a, 6 mod2x). */
  blend?: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  /** Seconds before it starts fading (Infinity = stays), fade length. */
  life?: number;
  fade?: number;
  /** How far in front of / behind the surface triangles are still painted. */
  depth?: number;
  /** Grow from this fraction of the size to 1 over `grow` seconds (blood pools). */
  growFrom?: number;
  grow?: number;
}

interface Decal {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicNodeMaterial;
  age: number;
  life: number;
  fade: number;
  opacity: number;
  grow: number;
  growFrom: number;
  center: THREE.Vector3;
}

const MAX_DECALS = 96;

function blendState(mat: THREE.Material, blend: number) {
  mat.transparent = true;
  mat.depthWrite = false;
  switch (blend) {
    case 2:
      mat.blending = THREE.AdditiveBlending;
      break;
    case 4:
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.ReverseSubtractEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneFactor;
      break;
    case 5:
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.ZeroFactor;
      mat.blendDst = THREE.SrcAlphaFactor;
      break;
    case 6:
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.DstColorFactor;
      mat.blendDst = THREE.SrcColorFactor;
      break;
    default:
      mat.blending = THREE.NormalBlending;
  }
}

export class Decals {
  readonly group = new THREE.Group();
  private list: Decal[] = [];

  /**
   * @param light baked light at a point from the level parts the decal landed on (the static
   *   surfaces are drawn as texture x baked vertex colour, so an unlit decal would glow).
   */
  constructor(
    private readonly collision: () => CollisionWorld | null,
    private readonly light?: (point: THREE.Vector3, parts: Set<number>) => THREE.Color,
  ) {
    this.group.name = 'fx-decals';
  }

  get count() {
    return this.list.length;
  }

  /**
   * Hidden stand-in decals with this texture in each blend mode (src/app/prewarm.ts): their
   * pipelines are compiled with the level, so the first blood splat does not stall the GPU
   * (~150 ms; docs/game-logic.md §18). Later decals with other textures share the pipelines.
   */
  warm(map: THREE.Texture, into: THREE.Object3D, blends = [1, 2, 4, 5, 6]): THREE.Mesh[] {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    return blends.map((b) => {
      const mat = new THREE.MeshBasicNodeMaterial({ map, color: 0xffffff, side: THREE.DoubleSide, fog: true });
      blendState(mat, b);
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -2;
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = 1;
      mesh.name = 'decal-warm';
      into.add(mesh);
      return mesh;
    });
  }

  /** Build the clipped geometry for a decal box; null when nothing was hit. */
  static project(col: CollisionWorld, point: THREE.Vector3, normal: THREE.Vector3, w: number, h: number, angle: number, depth: number, parts?: Set<number>): THREE.BufferGeometry | null {
    const n = normal.clone().normalize();
    const t0 = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t = t0.clone().cross(n).normalize();
    const b = n.clone().cross(t).normalize();
    // Rotate the tangent frame about the normal.
    const c = Math.cos(angle), s = Math.sin(angle);
    const U = t.clone().multiplyScalar(c).addScaledVector(b, s);
    const V = n.clone().cross(U).normalize();
    const r = Math.max(w, h) * 0.75 + depth;
    const ids = col.trianglesInBox(point.x - r, point.y - r, point.z - r, point.x + r, point.y + r, point.z + r);
    const T = col.tris, N = col.normals;
    const pos: number[] = [];
    const uvs: number[] = [];
    const lift = 0.004;
    // Polygon in decal space: [u, v, d] with |u| <= w/2, |v| <= h/2, |d| <= depth.
    type P = [number, number, number];
    const clip = (poly: P[], axis: 0 | 1 | 2, lim: number, sign: 1 | -1): P[] => {
      const out: P[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], q = poly[(i + 1) % poly.length];
        const da = sign * a[axis] - lim, dq = sign * q[axis] - lim;
        if (da <= 0) out.push(a);
        if ((da <= 0) !== (dq <= 0)) {
          const k = da / (da - dq);
          out.push([a[0] + (q[0] - a[0]) * k, a[1] + (q[1] - a[1]) * k, a[2] + (q[2] - a[2]) * k]);
        }
      }
      return out;
    };
    const v = new THREE.Vector3();
    for (const tri of ids) {
      const nx = N[3 * tri], ny = N[3 * tri + 1], nz = N[3 * tri + 2];
      // Collision triangles are double-sided: paint those roughly facing the decal either way.
      if (Math.abs(nx * n.x + ny * n.y + nz * n.z) < 0.35) continue;
      let poly: P[] = [];
      for (let k = 0; k < 3; k++) {
        v.set(T[9 * tri + 3 * k], T[9 * tri + 3 * k + 1], T[9 * tri + 3 * k + 2]).sub(point);
        poly.push([v.dot(U), v.dot(V), v.dot(n)]);
      }
      poly = clip(poly, 0, w / 2, 1);
      if (poly.length >= 3) poly = clip(poly, 0, w / 2, -1);
      if (poly.length >= 3) poly = clip(poly, 1, h / 2, 1);
      if (poly.length >= 3) poly = clip(poly, 1, h / 2, -1);
      if (poly.length >= 3) poly = clip(poly, 2, depth, 1);
      if (poly.length >= 3) poly = clip(poly, 2, depth, -1);
      if (poly.length < 3) continue;
      parts?.add(col.triPart[tri]);
      const world = poly.map(([pu, pv, pd]) => [
        point.x + U.x * pu + V.x * pv + n.x * (pd + lift),
        point.y + U.y * pu + V.y * pv + n.y * (pd + lift),
        point.z + U.z * pu + V.z * pv + n.z * (pd + lift),
      ]);
      for (let k = 1; k + 1 < poly.length; k++) {
        for (const j of [0, k, k + 1]) {
          pos.push(...world[j]);
          uvs.push(poly[j][0] / w + 0.5, 1 - (poly[j][1] / h + 0.5));
        }
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeBoundingSphere();
    return g;
  }

  /** Paint a decal; returns false when there was no surface. */
  add(map: THREE.Texture | null, point: THREE.Vector3, normal: THREE.Vector3, o: DecalOptions): boolean {
    const col = this.collision();
    if (!col) return false;
    const w = o.width, h = o.height ?? o.width;
    const parts = new Set<number>();
    const geo = Decals.project(col, point, normal, w, h, o.angle ?? Math.random() * Math.PI * 2, o.depth ?? Math.max(0.05, Math.min(w, h) * 0.5), parts);
    if (!geo) return false;
    const color = new THREE.Color(o.color ?? 0xffffff);
    // Additive / modulating decals keep their colour; covering ones take the surface's light.
    const b = o.blend ?? 1;
    if (this.light && (b === 1 || b === 0 || b === 8)) color.multiply(this.light(point, parts));
    const mat = new THREE.MeshBasicNodeMaterial({ map: map ?? undefined, color, side: THREE.DoubleSide, fog: true });
    blendState(mat, o.blend ?? 1);
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    mat.opacity = o.opacity ?? 1;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    mesh.name = 'decal';
    const center = point.clone();
    if (o.growFrom !== undefined && o.grow) {
      // Scale about the centre: geometry relative to it.
      geo.translate(-center.x, -center.y, -center.z);
      mesh.position.copy(center);
      mesh.scale.setScalar(o.growFrom);
    }
    this.group.add(mesh);
    this.list.push({ mesh, mat, age: 0, life: o.life ?? 30, fade: o.fade ?? 2, opacity: mat.opacity, grow: o.grow ?? 0, growFrom: o.growFrom ?? 1, center });
    while (this.list.length > MAX_DECALS) this.removeAt(0);
    return true;
  }

  private removeAt(i: number) {
    const d = this.list[i];
    d.mesh.removeFromParent();
    d.mesh.geometry.dispose();
    d.mat.dispose();
    this.list.splice(i, 1);
  }

  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.age += dt;
      if (d.grow > 0 && d.age <= d.grow + dt) {
        const k = Math.min(1, d.age / d.grow);
        d.mesh.scale.setScalar(d.growFrom + (1 - d.growFrom) * Math.sqrt(k));
      }
      if (d.age > d.life) {
        const k = 1 - (d.age - d.life) / Math.max(0.01, d.fade);
        if (k <= 0) {
          this.removeAt(i);
          continue;
        }
        d.mat.opacity = d.opacity * k;
      }
    }
  }

  clear() {
    while (this.list.length) this.removeAt(this.list.length - 1);
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}
