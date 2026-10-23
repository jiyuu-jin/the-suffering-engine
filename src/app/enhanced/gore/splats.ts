// Enhanced gore: the procedural splat atlas (docs/enhanced.md "Gore"). Generated in code at
// start-up from a seeded generator: nothing is downloaded or derived from the game's data.
//
// A 4 × 4 atlas of 256² tiles, RGBA8:
//   R  film thickness (0..1): coverage, colour, relief and drying speed;
//   G  pools only: arrival order (0 at the source, 1 at the rim) — the shader reveals the pool
//      outwards as it spreads, so it follows its own lobes;
//   B  slow variation (clots, uneven drying).
// Tiles (SPLAT_TILES): impact spatters travel towards +u (tails point the way the blood flew),
// round drops (falling straight down), pools, cast-off lines (arterial spurts).

export const TILE = 256;
export const GRID = 4;
export const ATLAS = TILE * GRID;
/** Atlas margin kept clear inside each tile (texels): mip levels do not bleed into neighbours. */
export const MARGIN = 6;

export const SPLAT_TILES = {
  impact: [0, 1, 2, 3, 4, 5],
  drop: [6, 7, 8, 9],
  pool: [10, 11, 12, 13],
  castoff: [14, 15],
} as const;
export type SplatKind = keyof typeof SPLAT_TILES;

/** Atlas UV rectangle of a tile: u0, v0, du, dv (with the margin). */
export function tileRect(tile: number): [number, number, number, number] {
  const tx = tile % GRID, ty = Math.floor(tile / GRID);
  const m = MARGIN / ATLAS;
  return [tx / GRID + m, ty / GRID + m, 1 / GRID - 2 * m, 1 / GRID - 2 * m];
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on a periodic 64-cell lattice, 0..1. */
function makeNoise(seed: number) {
  const r = rng(seed);
  const P = 64;
  const g = new Float32Array(P * P);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (x: number, y: number) => g[(((y % P) + P) % P) * P + (((x % P) + P) % P)];
  const n = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x: number, y: number, oct = 3) => {
    let s = 0, amp = 0.5, f = 1, w = 0;
    for (let o = 0; o < oct; o++) {
      s += n(x * f, y * f) * amp;
      w += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return s / w;
  };
}

interface Tile {
  r: Float32Array;
  g: Float32Array;
}

interface Stamp {
  x: number;
  y: number;
  /** Direction (radians), half length and half width (tile units). */
  th: number;
  a: number;
  b: number;
  /** Peak thickness. */
  h: number;
  /** Edge roughness (fraction of the radius). */
  e: number;
}

function stamp(t: Tile, s: Stamp, noise: (x: number, y: number, o?: number) => number, seed: number) {
  const R = Math.max(s.a, s.b) * (1 + s.e) + 2 / TILE;
  const x0 = Math.max(0, Math.floor((s.x - R) * TILE)), x1 = Math.min(TILE - 1, Math.ceil((s.x + R) * TILE));
  const y0 = Math.max(0, Math.floor((s.y - R) * TILE)), y1 = Math.min(TILE - 1, Math.ceil((s.y + R) * TILE));
  const c = Math.cos(s.th), sn = Math.sin(s.th);
  // Edge noise frequency scales with the stain: small drops get a few bumps, pools many.
  const f = 10 / Math.max(0.02, Math.max(s.a, s.b));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const u = (x + 0.5) / TILE - s.x, v = (y + 0.5) / TILE - s.y;
      const lx = (u * c + v * sn) / s.a, ly = (-u * sn + v * c) / s.b;
      let d = Math.sqrt(lx * lx + ly * ly);
      if (d > 1 + s.e * 1.2) continue;
      d += s.e * (noise(u * f + seed, v * f - seed, 3) - 0.5) * 2;
      // Meniscus: thickest inside, a soft rim over the outer quarter.
      const k = Math.min(1, Math.max(0, (1 - d) / 0.28));
      if (k <= 0) continue;
      const th = s.h * Math.pow(k, 0.65);
      const i = y * TILE + x;
      if (th > t.r[i]) t.r[i] = th;
    }
  }
}

/** A drop flying off along `th` leaves an ellipse with a smaller tail further along. */
function teardrop(t: Tile, x: number, y: number, th: number, r: number, elong: number, h: number, noise: (x: number, y: number, o?: number) => number, seed: number) {
  stamp(t, { x, y, th, a: r * elong, b: r, h, e: 0.12 }, noise, seed);
  if (elong > 1.4) {
    const d = r * elong * 1.15;
    stamp(t, { x: x + Math.cos(th) * d, y: y + Math.sin(th) * d, th, a: r * 0.55 * elong * 0.6, b: r * 0.35, h: h * 0.8, e: 0.1 }, noise, seed + 7);
  }
}

function impactTile(t: Tile, r: () => number, noise: (x: number, y: number, o?: number) => number, k: number) {
  // Main stain: left of centre, slightly elongated along +u, scalloped rim.
  const cx = 0.36 + r() * 0.04, cy = 0.5 + (r() - 0.5) * 0.04;
  const R = 0.13 + r() * 0.05;
  stamp(t, { x: cx, y: cy, th: (r() - 0.5) * 0.2, a: R * 1.15, b: R, h: 0.85 + r() * 0.15, e: 0.18 }, noise, k * 13);
  // A scalloped rim: short lobes all round, a few longer fingers downstream (+u).
  const lobes = 14 + Math.floor(r() * 10);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + (r() - 0.5) * 0.3;
    const down = Math.max(0, Math.cos(a));
    const finger = r() < 0.25 * down;
    const len = R * (finger ? 0.35 + r() * 0.6 : 0.06 + r() * 0.12);
    const sx = cx + Math.cos(a) * R * 0.95, sy = cy + Math.sin(a) * R * 0.95;
    stamp(t, { x: sx + Math.cos(a) * len * 0.4, y: sy + Math.sin(a) * len * 0.4, th: a, a: len * 0.6, b: R * (finger ? 0.05 + r() * 0.04 : 0.1 + r() * 0.08), h: 0.6 + r() * 0.25, e: 0.15 }, noise, k * 17 + i);
  }
  // Satellites in a cone downstream: smaller and longer the further they flew.
  const sats = 25 + Math.floor(r() * 35);
  for (let i = 0; i < sats; i++) {
    const a = (r() - 0.5) * (r() < 0.8 ? 1.2 : 3.2);
    const dist = R * 1.2 + r() * (0.55 - R);
    const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
    if (x < 0.04 || x > 0.96 || y < 0.04 || y > 0.96) continue;
    const far = (dist - R) / 0.5;
    const rad = (0.022 - 0.016 * far) * (0.4 + r() * 0.8);
    teardrop(t, x, y, a, Math.max(0.003, rad), 1.1 + far * 2.2 + r() * 0.6, 0.45 + r() * 0.35, noise, k * 31 + i);
  }
  // Fine mist.
  const mist = 60 + Math.floor(r() * 80);
  for (let i = 0; i < mist; i++) {
    const a = (r() - 0.5) * 2.4;
    const dist = R + r() * 0.5;
    const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
    if (x < 0.03 || x > 0.97 || y < 0.03 || y > 0.97) continue;
    stamp(t, { x, y, th: a, a: 0.003 + r() * 0.004, b: 0.0025 + r() * 0.003, h: 0.25 + r() * 0.25, e: 0.05 }, noise, i);
  }
}

function dropTile(t: Tile, r: () => number, noise: (x: number, y: number, o?: number) => number, k: number) {
  const R = 0.26 + r() * 0.06;
  stamp(t, { x: 0.5, y: 0.5, th: 0, a: R, b: R * (0.94 + r() * 0.06), h: 0.8 + r() * 0.2, e: 0.08 }, noise, k * 11);
  // A slightly scalloped rim (a drop falling a metre or two; no long spines).
  const n = 16 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.3;
    const len = R * (0.04 + r() * 0.1);
    if (r() < 0.45) continue;
    stamp(t, { x: 0.5 + Math.cos(a) * (R * 0.9 + len * 0.3), y: 0.5 + Math.sin(a) * (R * 0.9 + len * 0.3), th: a, a: len * 1.4, b: R * (0.05 + r() * 0.05), h: 0.65, e: 0.12 }, noise, k * 23 + i);
  }
  const sats = 2 + Math.floor(r() * 7);
  for (let i = 0; i < sats; i++) {
    const a = r() * Math.PI * 2, d = R * (1.35 + r() * 0.35);
    teardrop(t, 0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, a, 0.012 + r() * 0.02, 1.2 + r(), 0.55, noise, k * 41 + i);
  }
}

function poolTile(t: Tile, r: () => number, noise: (x: number, y: number, o?: number) => number, k: number) {
  // Two to four overlapping lobes; the rim of the union is the pool's edge.
  const lobes = 2 + Math.floor(r() * 3);
  const L: { x: number; y: number; R: number }[] = [{ x: 0.5, y: 0.5, R: 0.24 + r() * 0.04 }];
  for (let i = 1; i < lobes; i++) {
    const a = r() * Math.PI * 2, d = 0.12 + r() * 0.08;
    L.push({ x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d, R: 0.12 + r() * 0.1 });
  }
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const u = (x + 0.5) / TILE, v = (y + 0.5) / TILE;
      // Soft union of the lobes' normalised distances.
      let field = 0;
      for (const l of L) {
        const d = Math.hypot(u - l.x, v - l.y) / l.R;
        field += Math.exp(-3 * d * d) * (l.R / 0.3);
      }
      // Edge wobble.
      const n = noise(u * 9 + k, v * 9 - k, 3) - 0.5;
      const lvl = field * (1 + n * 1.6);
      const edge = Math.exp(-3);
      const i = y * TILE + x;
      if (lvl > edge * 0.85) {
        const inside = Math.min(1, (lvl - edge * 0.85) / 0.25);
        t.r[i] = Math.max(t.r[i], 0.55 + 0.45 * Math.pow(inside, 0.5));
        // Arrival: the pool reaches a texel as the field falls from its peak to the rim.
        const arr = 1 - Math.min(1, Math.max(0, (Math.log(Math.max(lvl, 1e-4)) + 3) / 3));
        t.g[i] = Math.max(0.01, Math.min(1, arr * 0.92 + (noise(u * 23, v * 23, 2) - 0.5) * 0.1));
      }
    }
  }
  // A few drops around it (fallen with the body: arrival 0, there from the start).
  const sats = 4 + Math.floor(r() * 8);
  for (let i = 0; i < sats; i++) {
    const a = r() * Math.PI * 2, d = 0.36 + r() * 0.1;
    const x = 0.5 + Math.cos(a) * d, y = 0.5 + Math.sin(a) * d;
    if (x < 0.04 || x > 0.96 || y < 0.04 || y > 0.96) continue;
    stamp(t, { x, y, th: a, a: 0.01 + r() * 0.012, b: 0.009 + r() * 0.01, h: 0.6, e: 0.1 }, noise, k * 53 + i);
  }
}

function castoffTile(t: Tile, r: () => number, noise: (x: number, y: number, o?: number) => number, k: number) {
  // A line of drops flung along +u, getting smaller and longer; a faint curve.
  const n = 9 + Math.floor(r() * 7);
  const bend = (r() - 0.5) * 0.25;
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const x = 0.08 + s * 0.84, y = 0.5 + Math.sin(s * Math.PI) * bend + (r() - 0.5) * 0.03;
    const rad = 0.045 * (1 - 0.55 * s) * (0.6 + r() * 0.6);
    teardrop(t, x, y, Math.atan2(Math.cos(s * Math.PI) * bend * Math.PI, 0.84), rad, 1.6 + s * 2.5, 0.7, noise, k * 61 + i);
  }
}

export interface SplatAtlas {
  width: number;
  height: number;
  /** RGBA8, row 0 = v 0. */
  data: Uint8Array;
}

/** Build the atlas (deterministic for a seed). */
export function buildSplatAtlas(seed = 0x5eed): SplatAtlas {
  const data = new Uint8Array(ATLAS * ATLAS * 4);
  const r = rng(seed);
  const noise = makeNoise(seed ^ 0x9e3779b9);
  const vary = makeNoise(seed + 1);
  for (let tile = 0; tile < GRID * GRID; tile++) {
    const t: Tile = { r: new Float32Array(TILE * TILE), g: new Float32Array(TILE * TILE) };
    if ((SPLAT_TILES.impact as readonly number[]).includes(tile)) impactTile(t, r, noise, tile + 1);
    else if ((SPLAT_TILES.drop as readonly number[]).includes(tile)) dropTile(t, r, noise, tile + 1);
    else if ((SPLAT_TILES.pool as readonly number[]).includes(tile)) poolTile(t, r, noise, tile + 1);
    else castoffTile(t, r, noise, tile + 1);
    const tx = (tile % GRID) * TILE, ty = Math.floor(tile / GRID) * TILE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x;
        // Keep the margin clear.
        const inside = x >= MARGIN && y >= MARGIN && x < TILE - MARGIN && y < TILE - MARGIN;
        const o = ((ty + y) * ATLAS + tx + x) * 4;
        data[o] = inside ? Math.round(Math.min(1, t.r[i]) * 255) : 0;
        data[o + 1] = inside ? Math.round(t.g[i] * 255) : 0;
        data[o + 2] = Math.round(vary((tx + x) / 48, (ty + y) / 48, 4) * 255);
        data[o + 3] = 255;
      }
    }
  }
  return { width: ATLAS, height: ATLAS, data };
}

/** Covered share (thickness ≥ 0.03) of a tile (tests / stats). */
export function tileCoverage(a: SplatAtlas, tile: number): number {
  const tx = (tile % GRID) * TILE, ty = Math.floor(tile / GRID) * TILE;
  let n = 0;
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (a.data[((ty + y) * ATLAS + tx + x) * 4] >= 8) n++;
  return n / (TILE * TILE);
}
