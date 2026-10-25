// Enhanced volumetrics: the dust noise as a baked, tiling 3D texture (docs/perf.md "Perf C").
//
// volumetric.ts modulates the fog's density with three.js's MaterialX Perlin noise
// (`mx_noise_float`) at every ray-march step: about half of the pass's GPU time on the
// development Mac (Medium at 1a's cell row, 2896 x 1960: 7.7 ms with it, 4.1 ms without). The
// same noise is baked here once, on the CPU, into a 64³ R8 texture holding one period of
// FLOAT_CELLS lattice cells (4 texels per cell), and the march reads it with one trilinear fetch.
// The function is MaterialX's own (Bob Jenkins' lattice hash, Perlin's improved gradients, the
// quintic fade, the 0.982 scale), with the lattice wrapped every DUST_PERIOD cells so the texture
// tiles: inside one period it is the shader's noise, sampled at 4 texels per cell.

/** Lattice cells per texture period (the noise repeats every DUST_PERIOD / 0.45 m ≈ 36 m). */
export const DUST_PERIOD = 16;
/** Texels per side of the baked texture. */
export const DUST_SIZE = 64;

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** MaterialX mx_bjfinal (Bob Jenkins' final mix), on uint32. */
function bjfinal(a: number, b: number, c: number): number {
  c = (c ^ b) >>> 0;
  c = (c - rotl(b, 14)) >>> 0;
  a = (a ^ c) >>> 0;
  a = (a - rotl(c, 11)) >>> 0;
  b = (b ^ a) >>> 0;
  b = (b - rotl(a, 25)) >>> 0;
  c = (c ^ b) >>> 0;
  c = (c - rotl(b, 16)) >>> 0;
  a = (a ^ c) >>> 0;
  a = (a - rotl(c, 4)) >>> 0;
  b = (b ^ a) >>> 0;
  b = (b - rotl(a, 14)) >>> 0;
  c = (c ^ b) >>> 0;
  c = (c - rotl(b, 24)) >>> 0;
  return c;
}

/** MaterialX mx_hash_int(x, y, z). */
export function mxHash3(x: number, y: number, z: number): number {
  const seed = (0xdeadbeef + (3 << 2) + 13) >>> 0;
  return bjfinal((seed + (x >>> 0)) >>> 0, (seed + (y >>> 0)) >>> 0, (seed + (z >>> 0)) >>> 0);
}

/** MaterialX mx_gradient_float(hash, x, y, z): Perlin's improved-noise gradients. */
function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * MaterialX 3D Perlin noise (`mx_perlin_noise_float`, what `mx_noise_float` returns with its
 * default amplitude and pivot), about -1..1. `period` > 0 wraps the lattice (a tiling noise).
 */
export function mxPerlin3(px: number, py: number, pz: number, period = 0): number {
  const X = Math.floor(px), Y = Math.floor(py), Z = Math.floor(pz);
  const fx = px - X, fy = py - Y, fz = pz - Z;
  const w = (i: number) => (period > 0 ? ((i % period) + period) % period : i);
  const h = (dx: number, dy: number, dz: number) => mxHash3(w(X + dx), w(Y + dy), w(Z + dz));
  const u = fade(fx), v = fade(fy), t = fade(fz);
  const lerp = (a: number, b: number, s: number) => a * (1 - s) + b * s;
  const v0 = gradient(h(0, 0, 0), fx, fy, fz);
  const v1 = gradient(h(1, 0, 0), fx - 1, fy, fz);
  const v2 = gradient(h(0, 1, 0), fx, fy - 1, fz);
  const v3 = gradient(h(1, 1, 0), fx - 1, fy - 1, fz);
  const v4 = gradient(h(0, 0, 1), fx, fy, fz - 1);
  const v5 = gradient(h(1, 0, 1), fx - 1, fy, fz - 1);
  const v6 = gradient(h(0, 1, 1), fx, fy - 1, fz - 1);
  const v7 = gradient(h(1, 1, 1), fx - 1, fy - 1, fz - 1);
  const r = lerp(lerp(lerp(v0, v1, u), lerp(v2, v3, u), v), lerp(lerp(v4, v5, u), lerp(v6, v7, u), v), t);
  return 0.982 * r;
}

/**
 * One period of the tiling noise, DUST_SIZE³ texels, as unsigned bytes: n = byte / 255 × 2 − 1.
 * Texel (i, j, k) holds the noise at lattice position ((i, j, k) + 0.5) × DUST_PERIOD / DUST_SIZE,
 * where a linear-filtered, repeat-wrapped fetch at texture coordinate p / DUST_PERIOD finds it.
 */
export function bakeDustNoise(size = DUST_SIZE, period = DUST_PERIOD): Uint8Array {
  const out = new Uint8Array(size * size * size);
  const s = period / size;
  let o = 0;
  for (let k = 0; k < size; k++)
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const n = mxPerlin3((i + 0.5) * s, (j + 0.5) * s, (k + 0.5) * s, period);
        out[o++] = Math.max(0, Math.min(255, Math.round((n * 0.5 + 0.5) * 255)));
      }
  return out;
}
