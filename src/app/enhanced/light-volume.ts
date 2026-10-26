// Enhanced mode: soft light volumes (docs/enhanced.md "Light volumes", docs/re/renderer.md §5.3).
//
// The level's light shafts and pools are flat additive sheets: 1b's arena grate (Decoration 86c7,
// model 9:4284) is four boxes of 2 m walls, the 1a cell-lamp pools (7:292) cones of quads. Their
// textures fade the light along the height only, and the engine draws every wall at that alpha
// whatever the view (no view-angle term exists in its shader library), so each wall ends in a
// hard edge and a wall seen edge-on is a bright line. Original keeps exactly that. Enhanced fades
// each fragment by how squarely the wall faces the eye (|N·V|, from the flat face normal: the
// models' own normals point anywhere) and close to the camera (walking through a wall), so the
// sheets read as a volume of light instead of panes. The sheets that enclose a shaft go further:
// they become thickness volumes (below, and light-volume-pass.ts); the rest keep this fade.
//
// Which surfaces: single-pass additive, tinted (unlit light), without the glow mark (fire and lamp
// cards stay as they are), drawn as level geometry (the renderer's merged parts: Decorations and
// Static Objects; Sky / Sun cards, pickups and props go through the prop cache and are untouched).

import { abs, dot, float, mix, normalFlat, positionView, positionViewDirection, smoothstep, uniform } from 'three/tsl';
import { Vector2 } from 'three/webgpu';
import { Blend, type MaterialLayer } from '../../formats/model';
import type { MeshPart } from '../../formats/types';
import { tintFactor, WORLD_STAGE_GAIN } from '../../formats/render-data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Fade ramps: |N·V| from `graze[0]` (gone) to `graze[1]` (full); view depth (m) from `near[0]` to `near[1]`. */
export const LIGHT_VOLUME = { graze: [0.1, 0.85] as const, near: [0.3, 1.5] as const };

/** Is a surface's pass list one of the light sheets Enhanced softens? */
export function isLightVolume(layers: readonly MaterialLayer[]): boolean {
  if (layers.length !== 1) return false;
  const l = layers[0];
  return l.blend === Blend.Add && l.tint !== undefined && !l.depthWrite;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** CPU twin of lightVolumeFade: `nv` = cos of the angle between the face normal and the eye, `depth` in m. */
export function lightVolumeFadeAt(nv: number, depth: number): number {
  return smooth(LIGHT_VOLUME.graze[0], LIGHT_VOLUME.graze[1], Math.abs(nv)) * smooth(LIGHT_VOLUME.near[0], LIGHT_VOLUME.near[1], depth);
}

/**
 * Shared uniforms (browser A/B and tuning: `import('/src/app/enhanced/light-volume.ts')`):
 * `strength` 1 applies the fade, 0 draws the sheets as Original does; the ramps start at LIGHT_VOLUME.
 */
export const lightVolumeUniforms = {
  strength: uniform(1),
  graze: uniform(new Vector2(...LIGHT_VOLUME.graze)),
  near: uniform(new Vector2(...LIGHT_VOLUME.near)),
};

/** Per-fragment fade of a light sheet (multiplies its alpha, i.e. the light it adds). */
export function lightVolumeFade(): N {
  const U = lightVolumeUniforms;
  const facing = smoothstep(U.graze.x, U.graze.y, abs(dot(normalFlat, positionViewDirection)));
  const near = smoothstep(U.near.x, U.near.y, positionView.z.negate());
  return mix(float(1), facing.mul(near), U.strength);
}

// ---------------------------------------------------------------------------
// Thickness volumes (docs/enhanced.md "Light volumes"): the shafts become light in a volume.
//
// The |N·V| fade above leaves each box's outer silhouette hard: where two walls seen at ordinary
// angles stop together, the light stops. Real light through dust is as bright as the path the
// eye's ray takes through the lit air, so it thins out towards a shaft's sides and grows where
// the eye looks down its length. Enhanced therefore takes the level's shafts out of the sheet
// geometry and integrates their light per pixel in the post chain (light-volume-pass.ts): each
// shaft is fitted here with a soft frustum along the direction its texture fades in (v), whose
// light per metre is the walls' own texture x tint at that height (a 16-step profile), scaled
// so that over a spread of views it adds what the walls add (a CPU ray cast of the decoded
// sheets: the brightness budget). Sheets that do not enclose a volume (floor pools, flat cards,
// halo domes) stay sheets with the fade above.


/** A soft frustum of light (world space). Local frame: x along e1, y along e2, z along axis, 0..length. */
export interface LightVolumeShape {
  origin: [number, number, number];
  axis: [number, number, number];
  e1: [number, number, number];
  e2: [number, number, number];
  length: number;
  /** Cross-section centre (x, y) and half extents (x, y) at z = 0 and z = length. */
  c0: [number, number];
  r0: [number, number];
  c1: [number, number];
  r1: [number, number];
  /** Superellipse exponent of the cross-section (2 round, 4 boxy). */
  exponent: number;
  /** Fraction of the half extent over which the light fades out towards the sides. */
  soft: number;
  /** Metres over which the light fades in at each end. */
  endFade: number;
  /**
   * Concentration towards the narrow end: density x (wide half extent / half extent at z)^focus
   * (0 for the level's shafts; 1 for a projector's beam, whose light per section stays the same
   * from the lens to the screen, so the beam is as bright near the lens as on the body).
   */
  focus?: number;
  /**
   * Projector beams: the light fades in over the first `near` metres from the eye, and a volume's
   * light at a pixel saturates towards `cap` (linear, before the 1.6 additive gain): from inside
   * a beam, looking down it, the path through the lit air is metres long and the haze would
   * wash the frame out (5b's theatre). 0 / undefined: neither (the level's shafts).
   */
  near?: number;
  cap?: number;
  /** Light per metre: 16 linear RGB steps along z (each the walls' added light at that height, max 1). */
  profile: Float32Array | null;
  /** Linear RGB multiplier (dynamic volumes; 1 for level shafts). */
  colour: [number, number, number];
  /** Gain: walls' light per metre of path at full density (the brightness budget). */
  gain: number;
  /** Bounding sphere (frustum culling). */
  centre: [number, number, number];
  radius: number;
}

/** Fit thresholds and look (docs/enhanced.md "Light volumes"). */
export const LIGHT_SHAFT = {
  /** v must be linear along the axis (R²) and the walls run along it (area-weighted mean |n·axis|). */
  minR2: 0.95,
  maxWallTilt: 0.35,
  /** Smallest half extent (m) of the wide end, and the shortest shaft (m). */
  minHalf: 0.25,
  minLength: 0.75,
  /** The section's narrow side against its wide one (a slab of sheets is not a shaft), and the fewest triangles. */
  minAspect: 0.2,
  minTriangles: 8,
  /** Of 12 sectors around the axis, how many the walls must cover (they enclose the volume). */
  minSectors: 10,
  /** Share of the half extent over which the light fades out to the sides, and the section's exponent for a box (round: 2). */
  soft: 0.8,
  boxExponent: 2.5,
  endFade: 0.25,
  profileSteps: 16,
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Deterministic PRNG (mulberry32) for the fit's samples. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What one wall adds where its texture reads `rgba` (bytes): linear RGB, as additiveEffectColor sums it. */
export type WallLight = (u: number, v: number) => [number, number, number];

/** A sheet pass's added light at (u, v): sRGB texel x tint (halved, doubled by stage 1) x alpha, linearised. */
export function wallLightOf(tex: { width: number; height: number; rgba: Uint8Array }, tint: number | undefined): WallLight {
  const tf = tintFactor(tint) ?? [0.5, 0.5, 0.5];
  return (u, v) => {
    const x = Math.min(tex.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * tex.width)));
    const y = Math.min(tex.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * tex.height)));
    const i = 4 * (y * tex.width + x);
    const a = tex.rgba[i + 3] / 255;
    return [0, 1, 2].map((k) => srgbToLinear(Math.min(1, (tex.rgba[i + k] / 255) * tf[k] * WORLD_STAGE_GAIN * a))) as V3;
  };
}

/** Triangles (index triples into `pos`) -> connected components (welded by position). */
export function triangleComponents(pos: Float32Array, idx: ArrayLike<number>): number[][] {
  const key = new Map<string, number>();
  const id = new Int32Array(pos.length / 3);
  for (let i = 0; i < id.length; i++) {
    const k = `${pos[3 * i].toFixed(3)},${pos[3 * i + 1].toFixed(3)},${pos[3 * i + 2].toFixed(3)}`;
    let w = key.get(k);
    if (w === undefined) key.set(k, (w = key.size));
    id[i] = w;
  }
  const par = new Int32Array(key.size).map((_, i) => i);
  const find = (x: number): number => {
    while (par[x] !== x) x = par[x] = par[par[x]];
    return x;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(id[idx[t]]);
    par[find(id[idx[t + 1]])] = a;
    par[find(id[idx[t + 2]])] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(id[idx[t]]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  return [...groups.values()];
}

/** Light per metre of a shape at local point (x, y, z), without the profile (0..1). */
export function shapeDensity(s: LightVolumeShape, x: number, y: number, z: number): number {
  if (z < 0 || z > s.length) return 0;
  const f = z / s.length;
  const cx = s.c0[0] + (s.c1[0] - s.c0[0]) * f, cy = s.c0[1] + (s.c1[1] - s.c0[1]) * f;
  const rx = Math.max(1e-3, s.r0[0] + (s.r1[0] - s.r0[0]) * f), ry = Math.max(1e-3, s.r0[1] + (s.r1[1] - s.r0[1]) * f);
  const qx = Math.abs((x - cx) / rx), qy = Math.abs((y - cy) / ry);
  const d = Math.pow(Math.pow(qx, s.exponent) + Math.pow(qy, s.exponent), 1 / s.exponent);
  const edge = 1 - smooth(1 - s.soft, 1, d);
  const ends = smooth(0, s.endFade, z) * smooth(0, s.endFade, s.length - z);
  return edge * ends;
}

/** The profile's light (linear RGB) at fraction f of the length. */
function profileAt(s: LightVolumeShape, f: number): V3 {
  const p = s.profile;
  if (!p) return [1, 1, 1];
  const n = p.length / 3;
  const x = Math.min(n - 1, Math.max(0, f * n - 0.5));
  const i = Math.floor(x), j = Math.min(n - 1, i + 1), w = x - i;
  return [0, 1, 2].map((k) => p[3 * i + k] * (1 - w) + p[3 * j + k] * w) as V3;
}

/** World point -> the shape's local frame. */
function toLocal(s: LightVolumeShape, p: V3): V3 {
  const d = sub(p, s.origin);
  return [dot3(d, s.e1), dot3(d, s.e2), dot3(d, s.axis)];
}

/** Ray (world) through the shape's local box: [t0, t1] or null. */
function boxSpan(s: LightVolumeShape, o: V3, d: V3): [number, number] | null {
  const lo = toLocal(s, o);
  const ld: V3 = [dot3(d, s.e1), dot3(d, s.e2), dot3(d, s.axis)];
  const rx = Math.max(s.r0[0], s.r1[0]), ry = Math.max(s.r0[1], s.r1[1]);
  const cxs = [s.c0[0], s.c1[0]], cys = [s.c0[1], s.c1[1]];
  const mn: V3 = [Math.min(...cxs) - rx, Math.min(...cys) - ry, 0];
  const mx: V3 = [Math.max(...cxs) + rx, Math.max(...cys) + ry, s.length];
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-9) {
      if (lo[k] < mn[k] || lo[k] > mx[k]) return null;
      continue;
    }
    const a = (mn[k] - lo[k]) / ld[k], b = (mx[k] - lo[k]) / ld[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 > t0 ? [t0, t1] : null;
}

/** The volume's light (luminance, before `gain`) along a world ray: ∫ density x profile ds. */
export function volumeRayLight(s: LightVolumeShape, o: V3, d: V3, steps = 48): number {
  const span = boxSpan(s, o, d);
  if (!span) return 0;
  const [t0, t1] = span, ds = (t1 - t0) / steps;
  let acc = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 0.5) * ds;
    const l = toLocal(s, [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
    const den = shapeDensity(s, l[0], l[1], l[2]);
    if (den > 0) {
      const c = profileAt(s, l[2] / s.length);
      acc += den * lum(c[0], c[1], c[2]) * ds;
    }
  }
  return acc;
}

interface Tri {
  p: [V3, V3, V3];
  uv: [[number, number], [number, number], [number, number]];
  area: number;
  n: V3;
}

/** Möller-Trumbore: ray parameter and barycentrics, or null. */
function hit(t: Tri, o: V3, d: V3): [number, number, number] | null {
  const e1 = sub(t.p[1], t.p[0]), e2 = sub(t.p[2], t.p[0]);
  const h = cross(d, e2);
  const a = dot3(e1, h);
  if (Math.abs(a) < 1e-12) return null;
  const f = 1 / a, s = sub(o, t.p[0]);
  const u = f * dot3(s, h);
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = f * dot3(d, q);
  if (v < 0 || u + v > 1) return null;
  const tt = f * dot3(e2, q);
  return tt > 0 ? [tt, u, v] : null;
}

/**
 * Fit a soft frustum to one component of a light sheet (world positions, uvs), or null when the
 * sheet does not enclose a shaft (docs/enhanced.md "Light volumes": the classification).
 */
export function fitLightShaft(pos: Float32Array, uvs: Float32Array, tris: readonly number[], idx: ArrayLike<number>, wall: WallLight): LightVolumeShape | null {
  const T: Tri[] = [];
  for (const t of tris) {
    const ids = [idx[t], idx[t + 1], idx[t + 2]];
    const p = ids.map((i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]] as V3) as [V3, V3, V3];
    const uv = ids.map((i) => [uvs[2 * i], uvs[2 * i + 1]] as [number, number]) as Tri['uv'];
    const c = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const area = Math.hypot(...c) / 2;
    if (area > 1e-8) T.push({ p, uv, area, n: norm(c) });
  }
  if (T.length < LIGHT_SHAFT.minTriangles) return null;
  // v = g·p + c over the vertices (least squares).
  const verts: { p: V3; v: number }[] = [];
  for (const t of T) for (let k = 0; k < 3; k++) verts.push({ p: t.p[k], v: t.uv[k][1] });
  const n = verts.length;
  const m: V3 = [0, 0, 0];
  let mv = 0;
  for (const x of verts) (m[0] += x.p[0] / n), (m[1] += x.p[1] / n), (m[2] += x.p[2] / n), (mv += x.v / n);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const x of verts) {
    const d = sub(x.p, m), dv = x.v - mv;
    for (let r = 0; r < 3; r++) {
      b[r] += d[r] * dv;
      for (let c = 0; c < 3; c++) A[r][c] += d[r] * d[c];
    }
  }
  for (let r = 0; r < 3; r++) A[r][r] += 1e-9;
  const det = (M: number[][]) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return null;
  const g = [0, 1, 2].map((k) => det(A.map((row, r) => row.map((x, c) => (c === k ? b[r] : x)))) / D) as V3;
  let ss = 0, sr = 0;
  for (const x of verts) {
    const dv = x.v - mv, pr = dot3(g, sub(x.p, m));
    ss += dv * dv;
    sr += (dv - pr) ** 2;
  }
  const r2 = 1 - sr / Math.max(ss, 1e-12);
  if (!(r2 >= LIGHT_SHAFT.minR2) || Math.hypot(...g) < 1e-6) return null;
  const axis = norm(g);
  let wa = 0, wn = 0;
  for (const t of T) (wa += t.area), (wn += t.area * Math.abs(dot3(t.n, axis)));
  if (wn / wa > LIGHT_SHAFT.maxWallTilt) return null;
  // Area-weighted samples on the walls.
  const rand = rng(T.length * 7919 + Math.round(m[0] * 13 + m[1] * 17 + m[2] * 19));
  const total = wa;
  const samples: { p: V3; u: number; v: number }[] = [];
  for (const t of T) {
    const k = Math.max(2, Math.round((t.area / total) * 600));
    for (let i = 0; i < k; i++) {
      let a = rand(), c = rand();
      if (a + c > 1) (a = 1 - a), (c = 1 - c);
      const w0 = 1 - a - c;
      samples.push({
        p: [0, 1, 2].map((q) => t.p[0][q] * w0 + t.p[1][q] * a + t.p[2][q] * c) as V3,
        u: t.uv[0][0] * w0 + t.uv[1][0] * a + t.uv[2][0] * c,
        v: t.uv[0][1] * w0 + t.uv[1][1] * a + t.uv[2][1] * c,
      });
    }
  }
  // Cross axes: principal direction of the samples across the axis.
  const ref: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u1 = norm(cross(ref, axis));
  let u2 = cross(axis, u1);
  let sxx = 0, sxy = 0, syy = 0;
  for (const s of samples) {
    const d = sub(s.p, m), x = dot3(d, u1), y = dot3(d, u2);
    (sxx += x * x), (sxy += x * y), (syy += y * y);
  }
  // (A square section has no principal direction: then the walls' own headings, by their
  // four-fold mean angle, so that the frame lines up with a box's walls.)
  let c4 = 0, s4 = 0, w4 = 0;
  for (const t of T) {
    const th = Math.atan2(dot3(t.n, u2), dot3(t.n, u1));
    (c4 += t.area * Math.cos(4 * th)), (s4 += t.area * Math.sin(4 * th)), (w4 += t.area);
  }
  const elong = Math.hypot(sxx - syy, 2 * sxy) / Math.max(sxx + syy, 1e-9);
  const ang = elong < 0.25 && Math.hypot(c4, s4) > 0.5 * w4 ? Math.atan2(s4, c4) / 4 : 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const e1 = norm([0, 1, 2].map((k) => u1[k] * Math.cos(ang) + u2[k] * Math.sin(ang)) as V3);
  const e2 = cross(axis, e1);
  u1 = e1;
  u2 = e2;
  // Local coordinates; the origin at the lowest z along the axis.
  let zmin = Infinity, zmax = -Infinity;
  for (const x of verts) {
    const z = dot3(x.p, axis);
    (zmin = Math.min(zmin, z)), (zmax = Math.max(zmax, z));
  }
  const L = zmax - zmin;
  if (L < LIGHT_SHAFT.minLength) return null;
  const origin: V3 = [0, 1, 2].map((k) => m[k] + axis[k] * (zmin - dot3(m, axis))) as V3;
  const loc = samples.map((s) => {
    const d = sub(s.p, origin);
    return { x: dot3(d, e1), y: dot3(d, e2), z: dot3(d, axis), u: s.u, v: s.v };
  });
  // Cross-section at each end (the outer quarter bands), extrapolated linearly to z = 0 / L.
  const band = (lo: number, hi: number) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zs = 0, c = 0;
    for (const s of loc)
      if (s.z >= lo && s.z <= hi) {
        (x0 = Math.min(x0, s.x)), (x1 = Math.max(x1, s.x)), (y0 = Math.min(y0, s.y)), (y1 = Math.max(y1, s.y)), (zs += s.z), c++;
      }
    return c ? { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2, z: zs / c } : null;
  };
  const lo = band(0, 0.25 * L), hi = band(0.75 * L, L);
  if (!lo || !hi || hi.z - lo.z < 1e-3) return null;
  const at = (z: number, a: number, b: number) => a + ((b - a) * (z - lo.z)) / (hi.z - lo.z);
  const c0: [number, number] = [at(0, lo.cx, hi.cx), at(0, lo.cy, hi.cy)];
  const c1: [number, number] = [at(L, lo.cx, hi.cx), at(L, lo.cy, hi.cy)];
  const r0: [number, number] = [Math.max(0.02, at(0, lo.rx, hi.rx)), Math.max(0.02, at(0, lo.ry, hi.ry))];
  const r1: [number, number] = [Math.max(0.02, at(L, lo.rx, hi.rx)), Math.max(0.02, at(L, lo.ry, hi.ry))];
  const wide = [Math.max(r0[0], r1[0]), Math.max(r0[1], r1[1])];
  if (Math.min(...wide) < LIGHT_SHAFT.minHalf || Math.min(...wide) < LIGHT_SHAFT.minAspect * Math.max(...wide)) return null;
  // The walls must enclose the axis, and how boxy the cross-section is.
  const sectors = new Set<number>();
  let l2 = 0;
  for (const s of loc) {
    const f = s.z / L;
    const qx = (s.x - (c0[0] + (c1[0] - c0[0]) * f)) / (r0[0] + (r1[0] - r0[0]) * f);
    const qy = (s.y - (c0[1] + (c1[1] - c0[1]) * f)) / (r0[1] + (r1[1] - r0[1]) * f);
    sectors.add(Math.floor(((Math.atan2(qy, qx) + Math.PI) / (2 * Math.PI)) * 12) % 12);
    l2 += Math.hypot(qx, qy) / loc.length;
  }
  if (sectors.size < LIGHT_SHAFT.minSectors) return null;
  // The walls' light by height.
  const N = LIGHT_SHAFT.profileSteps;
  const acc = new Float64Array(3 * N), cnt = new Float64Array(N);
  for (const s of loc) {
    const i = Math.min(N - 1, Math.max(0, Math.floor((s.z / L) * N)));
    const c = wall(s.u, s.v);
    for (let k = 0; k < 3; k++) acc[3 * i + k] += c[k];
    cnt[i]++;
  }
  const profile = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    let j = i;
    // (An empty step takes its nearest filled neighbour.)
    for (let d = 1; !cnt[j] && d < N; d++) j = cnt[i - d] ? i - d : cnt[i + d] ? i + d : j;
    for (let k = 0; k < 3; k++) profile[3 * i + k] = cnt[j] ? acc[3 * j + k] / cnt[j] : 0;
  }
  let peak = 0;
  for (let i = 0; i < profile.length; i++) peak = Math.max(peak, profile[i]);
  if (peak <= 1e-6) return null;
  for (let i = 0; i < profile.length; i++) profile[i] /= peak;
  // Bounding sphere.
  let bmin: V3 = [Infinity, Infinity, Infinity], bmax: V3 = [-Infinity, -Infinity, -Infinity];
  for (const x of verts) for (let k = 0; k < 3; k++) (bmin[k] = Math.min(bmin[k], x.p[k])), (bmax[k] = Math.max(bmax[k], x.p[k]));
  const centre = [0, 1, 2].map((k) => (bmin[k] + bmax[k]) / 2) as V3;
  const radius = Math.hypot(...sub(bmax, bmin)) / 2;
  const shape: LightVolumeShape = {
    origin, axis, e1, e2, length: L, c0, r0, c1, r1,
    exponent: l2 > 1.07 ? LIGHT_SHAFT.boxExponent : 2,
    soft: LIGHT_SHAFT.soft,
    endFade: Math.min(LIGHT_SHAFT.endFade, 0.1 * L),
    profile,
    colour: [1, 1, 1],
    gain: 1,
    centre,
    radius,
  };
  // The budget: over a spread of views (any heading, within 35° of level), the walls' summed
  // light along the rays equals the volume's (peak folded in: the profile is normalised).
  const rays = rng(4242);
  let sheet = 0, vol = 0;
  for (let i = 0; i < 700; i++) {
    const az = rays() * 2 * Math.PI, el = (rays() * 2 - 1) * (35 * Math.PI) / 180;
    const d: V3 = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const ref2: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a1 = norm(cross(ref2, d)), a2 = cross(d, a1);
    const rr = radius * Math.sqrt(rays()), th = rays() * 2 * Math.PI;
    const o: V3 = [0, 1, 2].map((k) => centre[k] + a1[k] * rr * Math.cos(th) + a2[k] * rr * Math.sin(th) - d[k] * 2 * radius) as V3;
    for (const t of T) {
      const h = hit(t, o, d);
      if (!h) continue;
      const w0 = 1 - h[1] - h[2];
      const c = wall(t.uv[0][0] * w0 + t.uv[1][0] * h[1] + t.uv[2][0] * h[2], t.uv[0][1] * w0 + t.uv[1][1] * h[1] + t.uv[2][1] * h[2]);
      sheet += lum(c[0], c[1], c[2]);
    }
    vol += volumeRayLight(shape, o, d, 32) * peak;
  }
  if (vol <= 1e-9) return null;
  shape.gain = (peak * sheet) / vol;
  return shape;
}

/**
 * Enhanced: take the level's light shafts out of its sheet geometry. Returns the parts to draw
 * (shaft components removed) and the fitted volumes (light-volume-pass.ts draws them).
 */
export function takeLightShafts(parts: readonly MeshPart[], texture: (key: string) => { width: number; height: number; rgba: Uint8Array } | undefined): { parts: MeshPart[]; volumes: LightVolumeShape[] } {
  const out: MeshPart[] = [];
  const volumes: LightVolumeShape[] = [];
  for (const part of parts) {
    const layers = part.material?.layers;
    const tex = layers && isLightVolume(layers) && part.uvs && layers[0].texture && !layers[0].frames ? texture(layers[0].texture) : undefined;
    if (!tex) {
      out.push(part);
      continue;
    }
    const wall = wallLightOf(tex, layers![0].tint);
    const keep: number[] = [];
    for (const comp of triangleComponents(part.positions, part.indices)) {
      const s = fitLightShaft(part.positions, part.uvs!, comp, part.indices, wall);
      if (s) volumes.push(s);
      else for (const t of comp) keep.push(part.indices[t], part.indices[t + 1], part.indices[t + 2]);
    }
    if (keep.length === part.indices.length) out.push(part);
    else if (keep.length) out.push({ ...part, indices: Uint32Array.from(keep) });
  }
  return { parts: out, volumes };
}

/** QA (before / after frames): `?lightvol=sheet` keeps the shafts as faded sheets (the previous Enhanced look). */
export const LIGHT_VOLUME_SHEETS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lightvol') === 'sheet';

/** A volume placed each frame (Killjoy's projector beams: projector.ts, Enhanced). */
export interface DynamicLightVolume {
  /** Write the volume for this frame into `out`; false: not drawn. */
  update(out: LightVolumeShape): boolean;
}

/** The level's volumes and the dynamic ones (light-volume-pass.ts reads them each frame). */
export const lightVolumeScene = {
  level: [] as LightVolumeShape[],
  dynamic: new Set<DynamicLightVolume>(),
  /** Bumped when `level` changes (the pass rebuilds its profile texture). */
  version: 0,
  setLevel(v: LightVolumeShape[]) {
    this.level = v;
    this.version++;
  },
};

/** An empty shape (dynamic volumes fill one each frame). */
export function emptyLightVolume(): LightVolumeShape {
  return { origin: [0, 0, 0], axis: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], length: 1, c0: [0, 0], r0: [0.1, 0.1], c1: [0, 0], r1: [0.1, 0.1], exponent: 2, soft: 0.6, endFade: 0.1, profile: null, colour: [1, 1, 1], gain: 1, centre: [0, 0, 0], radius: 1 };
}
