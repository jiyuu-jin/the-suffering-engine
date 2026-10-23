// Texture enhancement generators (docs/enhanced.md "Texture enhancement"): pure functions on RGBA8
// images in the engine's stored row order, used by tools/enhance-textures.ts (offline, on the
// user's machine, from the user's own install) and by the tests. Nothing here runs in Original
// mode, and the runtime (maps/runtime.ts) only loads what the tool wrote.
//
//   upscale(img, 2)            edge-aware upscale (bicubic + a steering kernel along edges)
//   heightOf(img)              band-passed luminance: micro relief, not the baked shading
//   normalMap(height, k)       tangent-space normal map; red = +u, green = +v (stored rows)
//   surfaceMaps(img, ...)      roughness (R), specular (G), cavity (B) from colour and class
//
// Every texture tiles (the renderer samples with RepeatWrapping), so every filter wraps.

/** RGBA8, tightly packed, rows in the engine's stored order (row r is v = (r + 0.5) / height). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Generator version: part of every cache fingerprint (bump to regenerate everything). */
export const GENERATOR_VERSION = 'g3';

// ---------------------------------------------------------------------------
// Helpers

const wrap = (i: number, n: number) => ((i % n) + n) % n;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Luma (Rec. 709 weights) of the gamma values, 0..1, one float per pixel. */
export function luminance(img: Rgba): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  return out;
}

/** Separable box blur with wrap-around, `passes` times (3 passes approximate a Gaussian). */
export function blur(src: Float32Array, w: number, h: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return src.slice();
  let a = src.slice();
  let b = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[row + wrap(k, w)];
      for (let x = 0; x < w; x++) {
        b[row + x] = s * inv;
        s += a[row + wrap(x + r + 1, w)] - a[row + wrap(x - r, w)];
      }
    }
    // Vertical.
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += b[wrap(k, h) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s * inv;
        s += b[wrap(y + r + 1, h) * w + x] - b[wrap(y - r, h) * w + x];
      }
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Edge-aware upscale

/** Catmull-Rom cubic weights for fractional position t (taps at -1, 0, 1, 2). */
function cubicWeights(t: number, out: Float32Array): void {
  const t2 = t * t, t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

/**
 * Upscale by an integer factor (2 or 4) with correct texel centres (output texel j samples the
 * source at (j + ½) / s − ½), edge-aware:
 *
 * - everywhere a Catmull-Rom bicubic, clamped to the range of the four nearest source texels
 *   (no ringing, no halo: the result is never sharper than the source's own contrast);
 * - where the local structure tensor says there is one dominant edge direction, it blends towards
 *   a steering kernel, an anisotropic Gaussian stretched along the edge (σ 1.1 texels) and narrow
 *   across it (σ 0.42): edges stay crisp and lose the staircase without a sharpening filter.
 *
 * Colour is interpolated premultiplied by alpha, so transparent texels (DXT1a cut-outs store
 * black there) leave no dark fringe on bars and foliage.
 */
export function upscale(img: Rgba, scale: number): Rgba {
  const { width: w, height: h, data: src } = img;
  const W = w * scale, H = h * scale;
  const out = new Uint8Array(W * H * 4);
  // Premultiplied source as floats.
  const n = w * h;
  const pm = new Float32Array(n * 4);
  let anyAlpha = false;
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3] / 255;
    if (src[i * 4 + 3] !== 255) anyAlpha = true;
    pm[i * 4] = src[i * 4] * a;
    pm[i * 4 + 1] = src[i * 4 + 1] * a;
    pm[i * 4 + 2] = src[i * 4 + 2] * a;
    pm[i * 4 + 3] = src[i * 4 + 3];
  }
  // Structure tensor of the luma (alpha counts too: cut-out edges are edges), smoothed.
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = (0.2126 * pm[i * 4] + 0.7152 * pm[i * 4 + 1] + 0.0722 * pm[i * 4 + 2] + 0.5 * pm[i * 4 + 3]) / 255;
  const jxx = new Float32Array(n), jxy = new Float32Array(n), jyy = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const L = (dx: number, dy: number) => lum[wrap(y + dy, h) * w + wrap(x + dx, w)];
      // Scharr gradients.
      const gx = 3 * (L(1, -1) - L(-1, -1)) + 10 * (L(1, 0) - L(-1, 0)) + 3 * (L(1, 1) - L(-1, 1));
      const gy = 3 * (L(-1, 1) - L(-1, -1)) + 10 * (L(0, 1) - L(0, -1)) + 3 * (L(1, 1) - L(1, -1));
      const i = y * w + x;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  const sxx = blur(jxx, w, h, 1, 2), sxy = blur(jxy, w, h, 1, 2), syy = blur(jyy, w, h, 1, 2);

  const wx = new Float32Array(4), wy = new Float32Array(4);
  const kw = new Float32Array(16);
  const SIG_ALONG = 1 / (2 * 1.1 * 1.1), SIG_ACROSS = 1 / (2 * 0.42 * 0.42);
  // Edge strength (gradient magnitude of the Scharr filter, ×32 of a unit step) that counts fully.
  const EDGE_LO = 0.6, EDGE_HI = 2.4;
  const idx = new Int32Array(16);
  const acc = new Float64Array(4), acc2 = new Float64Array(4);

  for (let oy = 0; oy < H; oy++) {
    const sy = (oy + 0.5) / scale - 0.5;
    const iy = Math.floor(sy);
    const fy = sy - iy;
    cubicWeights(fy, wy);
    for (let ox = 0; ox < W; ox++) {
      const sx = (ox + 0.5) / scale - 0.5;
      const ix = Math.floor(sx);
      const fx = sx - ix;
      cubicWeights(fx, wx);
      for (let j = 0; j < 4; j++) {
        const row = wrap(iy - 1 + j, h) * w;
        for (let i = 0; i < 4; i++) idx[j * 4 + i] = (row + wrap(ix - 1 + i, w)) * 4;
      }
      // Bicubic, clamped to the four nearest.
      acc.fill(0);
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const k = wx[i] * wy[j];
          const p = idx[j * 4 + i];
          acc[0] += k * pm[p];
          acc[1] += k * pm[p + 1];
          acc[2] += k * pm[p + 2];
          acc[3] += k * pm[p + 3];
        }
      const n0 = idx[5], n1 = idx[6], n2 = idx[9], n3 = idx[10];
      for (let c = 0; c < 4; c++) {
        const a = pm[n0 + c], b = pm[n1 + c], d = pm[n2 + c], e = pm[n3 + c];
        const lo = Math.min(a, b, d, e), hi = Math.max(a, b, d, e);
        acc[c] = acc[c] < lo ? lo : acc[c] > hi ? hi : acc[c];
      }
      // Structure tensor at the sample point (bilinear between the four nearest).
      const t00 = n0 >> 2, t10 = n1 >> 2, t01 = n2 >> 2, t11 = n3 >> 2;
      const bl = (f: Float32Array) => (f[t00] * (1 - fx) + f[t10] * fx) * (1 - fy) + (f[t01] * (1 - fx) + f[t11] * fx) * fy;
      const a = bl(sxx), b = bl(sxy), c = bl(syy);
      const tr = a + c;
      const disc = Math.sqrt(((a - c) * (a - c)) / 4 + b * b);
      const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      const coherence = l1 > 1e-9 ? (l1 - l2) / (l1 + l2 + 1e-9) : 0;
      const edge = coherence * coherence * smoothstep(EDGE_LO, EDGE_HI, Math.sqrt(Math.max(l1, 0)));
      const o = (oy * W + ox) * 4;
      if (edge > 0.02) {
        // Steering kernel: n = gradient direction (across the edge), e = along it.
        const th = 0.5 * Math.atan2(2 * b, a - c);
        const nx = Math.cos(th), ny = Math.sin(th);
        let ks = 0;
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++) {
            const dx = i - 1 - fx, dy = j - 1 - fy;
            const across = dx * nx + dy * ny;
            const along = -dx * ny + dy * nx;
            const k = Math.exp(-along * along * SIG_ALONG - across * across * SIG_ACROSS);
            kw[j * 4 + i] = k;
            ks += k;
          }
        acc2.fill(0);
        for (let t = 0; t < 16; t++) {
          const k = kw[t] / ks, p = idx[t];
          acc2[0] += k * pm[p];
          acc2[1] += k * pm[p + 1];
          acc2[2] += k * pm[p + 2];
          acc2[3] += k * pm[p + 3];
        }
        for (let ch = 0; ch < 4; ch++) acc[ch] += (acc2[ch] - acc[ch]) * edge;
      }
      const al = acc[3];
      if (anyAlpha) {
        const inv = al > 0.5 ? 255 / al : 0;
        out[o] = Math.min(255, Math.round(acc[0] * inv));
        out[o + 1] = Math.min(255, Math.round(acc[1] * inv));
        out[o + 2] = Math.min(255, Math.round(acc[2] * inv));
        out[o + 3] = Math.min(255, Math.round(al));
        // Fully transparent: keep the nearest texel's colour (bilinear filtering of the result
        // near a cut-out edge then still averages plausible colours).
        if (al <= 0.5) {
          const p = fx < 0.5 ? (fy < 0.5 ? n0 : n2) : fy < 0.5 ? n1 : n3;
          out[o] = src[p];
          out[o + 1] = src[p + 1];
          out[o + 2] = src[p + 2];
        }
      } else {
        out[o] = Math.round(acc[0]);
        out[o + 1] = Math.round(acc[1]);
        out[o + 2] = Math.round(acc[2]);
        out[o + 3] = 255;
      }
    }
  }
  return { width: W, height: H, data: out };
}

// ---------------------------------------------------------------------------
// Material classes

/** Coarse material class of a texture (texture-wide), refined per pixel by colour. */
export type MaterialClass = 'stone' | 'ground' | 'metal' | 'wood' | 'foliage' | 'character' | 'glass';

/** Per-class parameters [inferred: chosen by eye, docs/enhanced.md "Texture enhancement"]. */
export interface ClassParams {
  /** Normal strength (slope multiplier of the height at the source's texel scale). */
  normal: number;
  /** Base roughness and how much the local brightness moves it (+: darker is glossier). */
  rough: number;
  roughVar: number;
  /** Base specular (shading.ts reads 0.5 as a 4 % dielectric). */
  spec: number;
}

export const CLASS_PARAMS: Record<MaterialClass, ClassParams> = {
  // Concrete, brick, tile, plaster: the prison. Dark patches read as damp (glossier).
  stone: { normal: 2.6, rough: 0.74, roughVar: 0.55, spec: 0.55 },
  // Earth, gravel, grass ground (Landscape Textures).
  ground: { normal: 2.0, rough: 0.86, roughVar: 0.4, spec: 0.4 },
  // Bare / painted metal (reflection-masked textures, grey low-saturation plates).
  metal: { normal: 1.5, rough: 0.48, roughVar: -0.5, spec: 0.85 },
  wood: { normal: 1.8, rough: 0.72, roughVar: 0.25, spec: 0.45 },
  foliage: { normal: 1.2, rough: 0.66, roughVar: 0.2, spec: 0.45 },
  // Skinned models: skin and cloth decided per pixel by colour.
  character: { normal: 0.9, rough: 0.82, roughVar: 0.1, spec: 0.4 },
  glass: { normal: 0.3, rough: 0.15, roughVar: 0, spec: 0.9 },
};

/** Texture-wide colour statistics used by classify(). */
export interface ColourStats {
  meanLum: number;
  meanSat: number;
  /** Share of pixels with green as the dominant, saturated channel. */
  green: number;
  /** Share of pixels with brown / orange hues (wood, rust, dirt). */
  brown: number;
  /** Share of pixels with partial alpha (16..239): a reflection mask rather than coverage. */
  partialAlpha: number;
  /** Share of fully transparent pixels. */
  transparent: number;
  /** Coherence of the dominant gradient direction across the texture (wood grain, planks). */
  grain: number;
}

/** HSV-ish saturation and hue (degrees) of an 8-bit colour. */
export function hueSat(r: number, g: number, b: number): { hue: number; sat: number; max: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const c = max - min;
  const sat = max > 0 ? c / max : 0;
  let hue = 0;
  if (c > 0) {
    if (max === r) hue = 60 * (((g - b) / c + 6) % 6);
    else if (max === g) hue = 60 * ((b - r) / c + 2);
    else hue = 60 * ((r - g) / c + 4);
  }
  return { hue, sat, max: max / 255 };
}

export function colourStats(img: Rgba): ColourStats {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  let lum = 0, sat = 0, green = 0, brown = 0, partial = 0, transparent = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
    const hs = hueSat(r, g, b);
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sat += hs.sat;
    if (hs.sat > 0.25 && hs.hue > 65 && hs.hue < 170) green++;
    if (hs.sat > 0.3 && hs.hue >= 12 && hs.hue <= 45) brown++;
    if (a >= 16 && a <= 239) partial++;
    if (a < 16) transparent++;
  }
  // Grain: coherence of the summed structure tensor.
  const L = luminance(img);
  let a = 0, b = 0, c = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = L[y * w + wrap(x + 1, w)] - L[y * w + wrap(x - 1, w)];
      const gy = L[wrap(y + 1, h) * w + x] - L[wrap(y - 1, h) * w + x];
      a += gx * gx;
      b += gx * gy;
      c += gy * gy;
    }
  const disc = Math.sqrt(((a - c) * (a - c)) / 4 + b * b);
  const grain = a + c > 1e-9 ? (2 * disc) / (a + c) : 0;
  return { meanLum: lum / n, meanSat: sat / n, green: green / n, brown: brown / n, partialAlpha: partial / n, transparent: transparent / n, grain };
}

/** What the tool knows about how a texture is drawn (tools/enhance-textures.ts usage scan). */
export interface TextureUsage {
  /** Drawn on a skinned model (characters, the player). */
  character?: boolean;
  /** A layer over an environment-reflection pass: its alpha masks the reflection. */
  reflectMasked?: boolean;
  /** Ground package (Landscape Textures). */
  ground?: boolean;
}

/** The texture's class from its usage and colour statistics [inferred heuristics]. */
export function classify(stats: ColourStats, usage: TextureUsage = {}): MaterialClass {
  if (usage.character) return 'character';
  if (stats.green > 0.35 && (stats.transparent > 0.05 || stats.meanSat > 0.3)) return 'foliage';
  if (usage.ground) return 'ground';
  if (usage.reflectMasked && stats.meanSat < 0.3) return 'metal';
  if (stats.brown > 0.45 && stats.grain > 0.35) return 'wood';
  // Grey, cool, low-saturation plates with a reflection mask in alpha.
  if (stats.partialAlpha > 0.2 && stats.meanSat < 0.18) return 'metal';
  return 'stone';
}

// ---------------------------------------------------------------------------
// Height and normals

/**
 * Relief from the albedo: luma band-passed between ~1 and ~`large` texels of the source, so the
 * baked shading gradients across a texture do not become slopes and DXT block noise does not
 * become bumps. Dark is low (mortar, cracks, seams). 0-centred, roughly ±0.3.
 */
/** Height soft-clip (luma units). */
export const HEIGHT_CLIP = 0.12;

export function heightOf(img: Rgba, scale: number, large = 6): Float32Array {
  const { width: w, height: h } = img;
  const L = luminance(img);
  // Transparent texels: no relief (their colour is undefined).
  for (let i = 0; i < L.length; i++) if (img.data[i * 4 + 3] < 128) L[i] = NaN;
  let mean = 0, cnt = 0;
  for (const v of L) if (v === v) (mean += v, cnt++);
  mean = cnt ? mean / cnt : 0.5;
  for (let i = 0; i < L.length; i++) if (L[i] !== L[i]) L[i] = mean;
  const fine = blur(L, w, h, Math.max(1, scale * 0.5), 2);
  const coarse = blur(L, w, h, large * scale, 3);
  const out = new Float32Array(L.length);
  // Soft-clipped (±HEIGHT_CLIP): a hard paint edge (a checkerboard floor, a sign) is not a cliff,
  // while small relief keeps its full slope.
  for (let i = 0; i < L.length; i++) out[i] = HEIGHT_CLIP * Math.tanh((fine[i] - coarse[i]) / HEIGHT_CLIP);
  return out;
}

/**
 * Tangent-space normal map of a height field (RGBA8, alpha 255). Convention: red is +u (increasing
 * column), green is +v (increasing *stored* row: v = (row + ½) / height with flipY = false), blue
 * is up; n = normalize(−k ∂h/∂u, −k ∂h/∂v, 1), with the slopes per source texel (`scale` output
 * texels). This is the frame shading.ts builds from screen derivatives (T = ∂P/∂u, B = ∂P/∂v),
 * so no channel is flipped anywhere.
 */
export function normalMap(height: Float32Array, w: number, h: number, strength: number, scale = 1): Rgba {
  const out = new Uint8Array(w * h * 4);
  const k = strength * scale;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const H = (dx: number, dy: number) => height[wrap(y + dy, h) * w + wrap(x + dx, w)];
      // Sobel, normalised to a central difference per texel.
      const gx = (H(1, -1) + 2 * H(1, 0) + H(1, 1) - H(-1, -1) - 2 * H(-1, 0) - H(-1, 1)) / 8;
      const gy = (H(-1, 1) + 2 * H(0, 1) + H(1, 1) - H(-1, -1) - 2 * H(0, -1) - H(1, -1)) / 8;
      let nx = -k * gx, ny = -k * gy, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * w + x) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  return { width: w, height: h, data: out };
}

/** Decode one texel of a normal map to a unit vector (tests, QA). */
export function decodeNormal(map: Rgba, x: number, y: number): [number, number, number] {
  const o = (y * map.width + x) * 4;
  const v = [map.data[o], map.data[o + 1], map.data[o + 2]].map((c) => (c / 255) * 2 - 1);
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---------------------------------------------------------------------------
// Roughness / specular / cavity

/** Roughness never goes below this: low-res relief with a mirror finish sparkles. */
export const ROUGH_MIN = 0.18;

/**
 * Surface maps at the albedo's resolution, RGBA8: R roughness, G specular (0.5 = a 4 % dielectric,
 * cavity already applied), B cavity (1 open, 0 deep crevice), A 255.
 *
 * - roughness: the class base, moved by the local brightness (stone: darker is damp, glossier;
 *   metal: brighter is polished), rougher in crevices; per pixel, skin tones on characters are
 *   smoother than cloth, rust and dirt are matt, partial alpha on a reflection-masked texture is
 *   the original's own reflectivity mask (glossier, more specular where it is high);
 * - specular: the class base × cavity^1.5 (crevices see no highlight), skin and wet stone a
 *   little higher, rust lower.
 */
export function surfaceMaps(img: Rgba, cls: MaterialClass, usage: TextureUsage = {}, scale = 1): Rgba {
  const { width: w, height: h, data: d } = img;
  const p = CLASS_PARAMS[cls];
  const L = luminance(img);
  const mid = blur(L, w, h, Math.max(1, 1.5 * scale), 2);
  const coarse = blur(L, w, h, 8 * scale, 3);
  const out = new Uint8Array(w * h * 4);
  const reflectMask = !!usage.reflectMasked;
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
    const { hue, sat } = hueSat(r, g, b);
    // Cavity: how far this texel sits below its neighbourhood.
    // (Small-scale only: a large dark area is paint or dirt, not a hole.)
    const cavity = clamp01(1 - 4 * Math.max(0, mid[i] - L[i]));
    const detail = Math.max(-0.35, Math.min(0.35, mid[i] - coarse[i]));
    let rough = p.rough + p.roughVar * detail;
    let spec = p.spec;
    if (cls === 'character') {
      // Skin: warm hues, moderate saturation, not too dark.
      const skin = hue >= 5 && hue <= 45 && sat > 0.18 && sat < 0.62 && r > 60 && r > g && g >= b;
      if (skin) (rough = 0.52 + 0.2 * detail), (spec = 0.5);
      // Leather / metal fittings: dark, low saturation, high local contrast.
      else if (sat < 0.15 && L[i] < 0.25) rough -= 0.12;
    } else {
      const rust = hue >= 8 && hue <= 38 && sat > 0.45 && L[i] < 0.55;
      if (rust) (rough = Math.max(rough, 0.86)), (spec *= 0.55);
    }
    if (reflectMask && a < 255) {
      // The original's reflection mask: reflective where high.
      const m = a / 255;
      rough = rough * (1 - 0.45 * m);
      spec = spec * (0.7 + 0.6 * m);
    }
    rough += (1 - cavity) * 0.15;
    spec *= Math.pow(cavity, 1.5);
    const o = i * 4;
    out[o] = Math.round(Math.max(ROUGH_MIN, Math.min(1, rough)) * 255);
    out[o + 1] = Math.round(clamp01(spec) * 255);
    out[o + 2] = Math.round(cavity * 255);
    out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// The whole set for one texture

export interface EnhancedSet {
  cls: MaterialClass;
  /** Upscaled albedo (null when the texture is not upscaled: already large). */
  albedo: Rgba | null;
  normal: Rgba;
  /** Roughness / specular / cavity (see surfaceMaps), at the source resolution. */
  surface: Rgba;
}

/** Textures this large (either side) are not upscaled: they are already sharp enough. */
export const UPSCALE_MAX_SOURCE = 512;

/**
 * The full set for one decoded texture: the upscaled albedo, the normal map from its relief (at
 * the upscaled resolution) and the surface maps (at the source resolution: they are smooth).
 */
export function enhanceTexture(img: Rgba, usage: TextureUsage = {}, scale = 2): EnhancedSet {
  const stats = colourStats(img);
  const cls = classify(stats, usage);
  const s = Math.max(img.width, img.height) >= UPSCALE_MAX_SOURCE ? 1 : scale;
  const albedo = s > 1 ? upscale(img, s) : null;
  const big = albedo ?? img;
  const height = heightOf(big, s);
  const normal = normalMap(height, big.width, big.height, CLASS_PARAMS[cls].normal, s);
  const surface = surfaceMaps(img, cls, usage, 1);
  return { cls, albedo, normal, surface };
}
