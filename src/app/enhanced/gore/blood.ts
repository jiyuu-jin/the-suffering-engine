// Enhanced gore: the blood model (docs/enhanced.md "Gore"). Pure CPU code: the shaders in
// decals.ts / wounds.ts / droplets.ts evaluate the same formulas with the same constants, and the
// tests check these twins.
//
// Blood is a dark, wet, slightly glossy film that oxidises and dries:
//   - fresh: a thick film is near black-red (linear albedo 0.075, 0.0035, 0.003; sRGB about
//     77 / 11 / 10), a thin one redder (0.2, 0.02, 0.016) where the surface shows through; a water
//     film on top (GGX roughness 0.1, full specular): the flashlight catches it;
//   - dry: brown-black (0.03, 0.009, 0.007), matte (roughness 0.8, specular 0.12);
//   - dryness = 1 - exp(-age / (DRY_TAU × (0.25 + thickness))): a thin spatter is dry in a minute
//     or two, a pool's centre stays wet for many minutes;
//   - thin films are lighter and redder (the surface shows through), thick ones near black.
// A splat's shape follows its impact: a drop hitting a surface at angle α leaves an ellipse with
// width / length = sin α (the bloodstain-pattern rule), its tail pointing the way it travelled.

/** Linear albedo of fresh blood (thick film). */
export const WET_THICK = [0.075, 0.0035, 0.003] as const;
/** Linear albedo of a fresh thin film. */
export const WET_THIN = [0.2, 0.02, 0.016] as const;
/** Linear albedo of dried blood. */
export const DRY = [0.03, 0.009, 0.007] as const;
/** Drying time constant (s) of a film of thickness 1 (thin ones: × 0.25). */
export const DRY_TAU = 110;
export const ROUGH_WET = 0.1;
export const ROUGH_DRY = 0.8;
export const SPEC_WET = 1;
export const SPEC_DRY = 0.12;
/** Pools: they start spreading after POOL_DELAY s and reach 63 % of their size after POOL_TAU s. */
export const POOL_DELAY = 0.4;
export const POOL_TAU = 16;
/** Wounds on bodies: the stain soaks outwards to SOAK × its first radius (time constant SOAK_TAU s). */
export const SOAK = 1.7;
export const SOAK_TAU = 22;
/** Thickness below which a texel draws nothing, and where it is fully opaque. */
export const ALPHA_LO = 0.03;
export const ALPHA_HI = 0.2;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Dryness 0 (fresh) .. 1 (dry) of a film of `thickness` (0..1) after `age` seconds. */
export function dryness(age: number, thickness: number): number {
  return 1 - Math.exp(-Math.max(0, age) / (DRY_TAU * (0.25 + Math.max(0, thickness))));
}

export interface BloodLook {
  dry: number;
  /** Linear albedo. */
  albedo: [number, number, number];
  roughness: number;
  specular: number;
  /** Coverage (alpha) of the film. */
  alpha: number;
}

/** The look of a blood film texel (decals.ts shader twin). */
export function bloodLook(age: number, thickness: number, opacity = 1): BloodLook {
  const d = dryness(age, thickness);
  const k = smooth(0.1, 0.8, thickness);
  const wet = [0, 1, 2].map((i) => mix(WET_THIN[i], WET_THICK[i], k));
  const albedo = [0, 1, 2].map((i) => mix(wet[i], DRY[i], d)) as [number, number, number];
  // Dried thin films soak in and fade a little; the thick crust stays.
  const alpha = smooth(ALPHA_LO, ALPHA_HI, thickness) * opacity * (1 - 0.25 * d * (1 - k));
  return { dry: d, albedo, roughness: mix(ROUGH_WET, ROUGH_DRY, d), specular: mix(SPEC_WET, SPEC_DRY, d), alpha };
}

/** How far a pool has spread (0..1 of its final reach) after `age` seconds (time constant `tau`). */
export function poolReach(age: number, tau = POOL_TAU): number {
  return 1 - Math.exp(-Math.max(0, age - POOL_DELAY) / Math.max(1e-3, tau));
}

/** A wound stain's radius factor after `age` seconds (it soaks into the clothes). */
export function soakRadius(age: number): number {
  return 1 + (SOAK - 1) * (1 - Math.exp(-Math.max(0, age) / SOAK_TAU));
}

type V3 = { x: number; y: number; z: number };

/**
 * The decal frame of fx/decals.ts Decals.project for a normal: tangent t and bitangent b
 * (U = t cos a + b sin a). Returned so a direction can be turned into the decal's angle.
 */
export function decalFrame(n: V3): { t: V3; b: V3 } {
  const l = Math.hypot(n.x, n.y, n.z) || 1;
  const nx = n.x / l, ny = n.y / l, nz = n.z / l;
  const t0 = Math.abs(ny) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  // t = t0 × n
  let tx = t0.y * nz - t0.z * ny, ty = t0.z * nx - t0.x * nz, tz = t0.x * ny - t0.y * nx;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  // b = n × t
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  return { t: { x: tx, y: ty, z: tz }, b: { x: bx, y: by, z: bz } };
}

/**
 * Splat shape for a drop travelling along `vel` onto a surface with normal `n`: the decal angle
 * (its +U along the drop's path over the surface), the elongation length / width = 1 / sin α
 * (clamped to `maxElong`), and α itself (radians between the path and the surface).
 */
export function impactShape(vel: V3, n: V3, maxElong = 5): { angle: number; elongation: number; alpha: number } {
  const vl = Math.hypot(vel.x, vel.y, vel.z);
  const nl = Math.hypot(n.x, n.y, n.z) || 1;
  if (vl < 1e-6) return { angle: 0, elongation: 1, alpha: Math.PI / 2 };
  const vx = vel.x / vl, vy = vel.y / vl, vz = vel.z / vl;
  const nx = n.x / nl, ny = n.y / nl, nz = n.z / nl;
  const vn = vx * nx + vy * ny + vz * nz;
  const alpha = Math.asin(Math.min(1, Math.abs(vn)));
  // Tangential part of the path.
  const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
  const { t, b } = decalFrame(n);
  const tl = Math.hypot(tx, ty, tz);
  const angle = tl < 1e-6 ? 0 : Math.atan2(tx * b.x + ty * b.y + tz * b.z, tx * t.x + ty * t.y + tz * t.z);
  const elongation = Math.min(maxElong, 1 / Math.max(Math.sin(alpha), 1 / maxElong));
  return { angle, elongation, alpha };
}

/**
 * Size (m, across) of the stain a drop of radius `r` (m) leaves when it lands at `speed` m/s:
 * spread factor about 1 + 0.35 × speed^0.5 (a fast drop flattens wider) [inferred from the
 * bloodstain literature's drop-size / height tables].
 */
export function stainSize(r: number, speed: number): number {
  return 2 * r * (1.6 + 0.35 * Math.sqrt(Math.max(0, speed)));
}
