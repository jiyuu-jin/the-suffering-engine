// Enhanced mode, texture enhancement (docs/enhanced.md "Texture enhancement"): the generators
// (src/app/enhanced/maps/generate.ts), the cache policy and fallback (maps/manifest.ts,
// maps/runtime.ts) and the Original guard (surface-material.ts enhancedTextures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import {
  CLASS_PARAMS,
  ROUGH_MIN,
  classify,
  colourStats,
  decodeNormal,
  enhanceTexture,
  normalMap,
  surfaceMaps,
  upscale,
  type MaterialClass,
  type Rgba,
} from '../src/app/enhanced/maps/generate';
import { LEVEL_SHARE, TIER_MAPS, entryBytes, isEnhancedManifest, mapFileName, normalSize, type EnhancedEntry } from '../src/app/enhanced/maps/manifest';
import { createSurfaceMaterial, enhancedTextures, missingTexture, toDataTexture } from '../src/app/surface-material';
import { enhancedShading } from '../src/app/engine-light';
import { Blend, TexInput, type SurfaceMaterial } from '../src/formats/model';
import { encodePngFiltered } from '../tools/enhance/png';
import { decodePng } from '../tools/image-metrics';

const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number?]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = f(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
};

/**
 * shading.ts surface(): the cotangent frame from screen derivatives and n = T·x + B·y + N·z,
 * mirrored on the CPU. One screen step right moves P by dp1 and the texture coordinates by duv1,
 * one step up by dp2 / duv2 (three.js's dFdy is y-up on both backends: WGSL `- dpdy`), so for a
 * surface facing the camera dp1 × dp2 points along N.
 */
function shaderNormal(tn: number[], dp1: number[], duv1: number[], dp2: number[], duv2: number[], N: number[]): number[] {
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  const T = dp2perp.map((c, i) => c * duv1[0] + dp1perp[i] * duv2[0]);
  const B = dp2perp.map((c, i) => c * duv1[1] + dp1perp[i] * duv2[1]);
  const inv = 1 / Math.sqrt(Math.max(dot(T, T), dot(B, B)));
  const n = [0, 1, 2].map((i) => T[i] * inv * tn[0] + B[i] * inv * tn[1] + N[i] * tn[2]);
  const l = Math.hypot(n[0], n[1], n[2]);
  return n.map((c) => c / l);
}

test('normal maps: red is +u, green is +v in stored rows; the shader frame tilts away from the rise', () => {
  const w = 16, h = 16;
  // Height rising with u (column): the normal leans towards −u (red below 128), green neutral.
  const hu = new Float32Array(w * h).map((_, i) => (i % w) * 0.01);
  // (Wrap-around: sample away from the seam.)
  const nu = decodeNormal(normalMap(hu, w, h, 3), 8, 8);
  assert.ok(nu[0] < -0.02 && Math.abs(nu[1]) < 0.01 && nu[2] > 0.9, `${nu}`);
  // Height rising with the stored row (v): green below 128.
  const hv = new Float32Array(w * h).map((_, i) => Math.floor(i / w) * 0.01);
  const nv = decodeNormal(normalMap(hv, w, h, 3), 8, 8);
  assert.ok(nv[1] < -0.02 && Math.abs(nv[0]) < 0.01, `${nv}`);
  // A floor (N +y) seen from above, screen right = +x, screen up = −z. Texture u along +x and
  // v along −z: a rise in u tilts the normal to −x, a rise in v to +z: away from the uphill side,
  // as a real slope's normal. Mirrored (u along −x): the rise in u now tilts it to +x.
  const N = [0, 1, 0], right = [1, 0, 0], up = [0, 0, -1];
  const floorU = shaderNormal(nu, right, [1, 0], up, [0, 1], N);
  assert.ok(floorU[0] < -0.02 && Math.abs(floorU[2]) < 0.01 && floorU[1] > 0.9, `${floorU}`);
  const floorV = shaderNormal(nv, right, [1, 0], up, [0, 1], N);
  assert.ok(floorV[2] > 0.02 && Math.abs(floorV[0]) < 0.01, `${floorV}`);
  const mirrored = shaderNormal(nu, right, [-1, 0], up, [0, 1], N);
  assert.ok(mirrored[0] > 0.02, `${mirrored}`);
  // A flat height gives the flat normal (128, 128, 255).
  const flat = normalMap(new Float32Array(w * h), w, h, 3);
  assert.deepEqual([...flat.data.subarray(0, 4)], [128, 128, 255, 255]);
});

test('upscale: correct size and texel centres, flat stays flat, edges stay crisp without ringing, cut-outs keep their colour', () => {
  const flat = upscale(img(8, 8, () => [90, 120, 30]), 2);
  assert.equal(flat.width, 16);
  assert.equal(flat.height, 16);
  for (let i = 0; i < flat.data.length; i += 4) assert.deepEqual([...flat.data.subarray(i, i + 4)], [90, 120, 30, 255]);
  // A vertical step (wrapping texture: two edges). No value outside the source range (no
  // ringing / halo), and the step is at most two output texels wide.
  const step = upscale(img(16, 16, (x) => (x < 8 ? [20, 20, 20] : [220, 220, 220])), 2);
  const row = Array.from({ length: 32 }, (_, x) => step.data[(10 * 32 + x) * 4]);
  assert.ok(row.every((v) => v >= 20 && v <= 220), `${row}`);
  const mid = row.filter((v) => v > 30 && v < 210).length;
  assert.ok(mid <= 4, `transition texels ${mid}: ${row}`);
  // Texel centres: output texels 2i and 2i+1 straddle source texel i, so the left half of the
  // output (columns 0..15) is the dark side apart from the wrap-around edge at 0.
  assert.ok(row[8] === 20 && row[24] === 220);
  // A diagonal edge: the steering kernel keeps it smooth (no staircase): along a row the
  // transition stays as narrow as the vertical edge's.
  const diag = upscale(img(16, 16, (x, y) => (x + y < 16 ? [30, 30, 30] : [200, 200, 200])), 2);
  const drow = Array.from({ length: 32 }, (_, x) => diag.data[(12 * 32 + x) * 4]).slice(4, 28);
  assert.ok(drow.filter((v) => v > 40 && v < 190).length <= 4, `${drow}`);
  // Cut-out (DXT1a stores black under alpha 0): no dark fringe on the opaque side.
  const cut = upscale(img(8, 8, (x) => (x >= 2 && x < 6 ? [200, 160, 40, 255] : [0, 0, 0, 0])), 2);
  for (let x = 0; x < 16; x++) {
    const o = (5 * 16 + x) * 4;
    if (cut.data[o + 3] >= 128) assert.ok(cut.data[o] >= 190 && cut.data[o + 1] >= 150, `x ${x}: ${[...cut.data.subarray(o, o + 4)]}`);
  }
});

test('surface maps: roughness and specular in range for every class; damp stone, skin, rust, cavities', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const noisy = img(32, 32, () => [rnd() * 255, rnd() * 255, rnd() * 255, rnd() < 0.2 ? rnd() * 255 : 255]);
  for (const cls of Object.keys(CLASS_PARAMS) as MaterialClass[]) {
    const s = surfaceMaps(noisy, cls, { reflectMasked: true });
    for (let i = 0; i < s.data.length; i += 4) {
      assert.ok(s.data[i] >= Math.round(ROUGH_MIN * 255) && s.data[i] <= 255, `${cls} roughness ${s.data[i]}`);
      assert.ok(s.data[i + 1] <= 255 && s.data[i + 2] <= 255 && s.data[i + 3] === 255);
    }
  }
  // Stone: a dark patch on a bright wall reads damp (glossier); it is not a crevice (no specular loss
  // in its interior), while a 1-texel crack is (specular down, rougher).
  const wall = img(64, 64, (x, y) => (x >= 16 && x < 48 && y >= 16 && y < 48 ? [70, 70, 68] : x === 4 ? [40, 40, 40] : [170, 168, 160]));
  const st = surfaceMaps(wall, 'stone');
  const at = (m: Rgba, x: number, y: number, c: number) => m.data[(y * m.width + x) * 4 + c];
  assert.ok(at(st, 32, 32, 0) < at(st, 58, 58, 0) - 5, `damp ${at(st, 32, 32, 0)} vs dry ${at(st, 58, 58, 0)}`);
  assert.ok(at(st, 32, 32, 2) > 240, 'a large dark patch is not a cavity');
  assert.ok(at(st, 4, 58, 2) < 200 && at(st, 4, 58, 1) < at(st, 58, 58, 1), 'a crack occludes the specular');
  // Characters: skin smoother than cloth.
  const ch = surfaceMaps(img(16, 16, (x) => (x < 8 ? [200, 150, 120] : [60, 70, 110])), 'character');
  assert.ok(at(ch, 4, 8, 0) < at(ch, 12, 8, 0) - 40, `skin ${at(ch, 4, 8, 0)} cloth ${at(ch, 12, 8, 0)}`);
  // Rust is matt.
  const rust = surfaceMaps(img(16, 16, () => [140, 70, 25]), 'metal');
  assert.ok(at(rust, 8, 8, 0) >= Math.round(0.86 * 255) - 1);
});

test('classify: foliage, ground, metal, wood, characters, stone by default', () => {
  const s = (f: (x: number, y: number) => [number, number, number, number?]) => colourStats(img(32, 32, f));
  assert.equal(classify(s((x) => [40, 120 + (x % 3) * 10, 30, x % 5 ? 255 : 0])), 'foliage');
  assert.equal(classify(s(() => [120, 110, 100]), { ground: true }), 'ground');
  assert.equal(classify(s(() => [120, 122, 128]), { reflectMasked: true }), 'metal');
  assert.equal(classify(s(() => [128, 128, 132, 120])), 'metal');
  assert.equal(classify(s((x) => [150 + (x % 4) * 12, 95, 45])), 'wood');
  assert.equal(classify(s(() => [200, 150, 120]), { character: true }), 'character');
  assert.equal(classify(s((x, y) => [130 + ((x * y) % 7), 128, 125])), 'stone');
  // Large sources are not upscaled; the set's maps share the albedo's size.
  const big = enhanceTexture(img(512, 4, () => [100, 100, 100]));
  assert.equal(big.albedo, null);
  const small = enhanceTexture(img(16, 8, () => [100, 100, 100]));
  assert.equal(small.albedo!.width, 32);
  assert.equal(small.normal.width, 32);
  assert.equal(small.surface.width, 16);
});

test('cache PNG encoder: filtered rows round-trip (RGB and RGBA)', () => {
  const a = img(13, 7, (x, y) => [x * 19, y * 31, (x * y) & 255, 100 + x]);
  const rgba = decodePng(encodePngFiltered(13, 7, a.data, 4));
  assert.deepEqual([...rgba.rgba], [...a.data]);
  const rgb = decodePng(encodePngFiltered(13, 7, a.data, 3));
  for (let i = 0; i < 13 * 7; i++) assert.deepEqual([...rgb.rgba.subarray(i * 4, i * 4 + 3)], [...a.data.subarray(i * 4, i * 4 + 3)]);
});

test('tier policy and manifest: Low none, Medium normals, High / Ultra everything within budget', () => {
  assert.deepEqual([TIER_MAPS.low.normal, TIER_MAPS.low.surface, TIER_MAPS.low.albedo, TIER_MAPS.low.budget], [false, false, false, 0]);
  assert.deepEqual([TIER_MAPS.medium.normal, TIER_MAPS.medium.surface, TIER_MAPS.medium.albedo], [true, false, false]);
  for (const t of ['high', 'ultra'] as const) assert.deepEqual([TIER_MAPS[t].normal, TIER_MAPS[t].surface, TIER_MAPS[t].albedo], [true, true, true]);
  assert.ok(TIER_MAPS.medium.budget < TIER_MAPS.high.budget && TIER_MAPS.high.budget <= TIER_MAPS.ultra.budget);
  const e: EnhancedEntry = {
    fp: 'x', width: 128, height: 128, cls: 'stone', alpha: false,
    albedo: { file: mapFileName('9:12', 'a', 'webp'), width: 256, height: 256, bytes: 1 },
    normal: { file: mapFileName('9:12', 'n', 'webp'), width: 256, height: 256, bytes: 1 },
    surface: { file: mapFileName('9:12', 's', 'webp'), width: 128, height: 128, bytes: 1 },
  };
  assert.equal(e.normal.file, 'enhanced/tex/9/12.n.webp');
  // Normal maps: Medium / High at the source's resolution, Ultra at the cached (upscaled) one.
  assert.deepEqual(normalSize(e, TIER_MAPS.medium), { width: 128, height: 128 });
  assert.deepEqual(normalSize(e, TIER_MAPS.high), { width: 128, height: 128 });
  assert.deepEqual(normalSize(e, TIER_MAPS.ultra), { width: 256, height: 256 });
  assert.ok(LEVEL_SHARE > 0.5 && LEVEL_SHARE < 1);
  assert.equal(entryBytes(e, TIER_MAPS.low), 0);
  assert.ok(entryBytes(e, TIER_MAPS.medium) < entryBytes(e, TIER_MAPS.high));
  assert.equal(isEnhancedManifest({ version: 1, textures: {} }), true);
  assert.equal(isEnhancedManifest({ version: 99, textures: {} }), false);
  assert.equal(isEnhancedManifest(null), false);
});

test('Original is untouched: no texture hooks, and an unused hook builds the identical shared graph', async () => {
  // Original (the tests' page default): nothing installed.
  assert.deepEqual(Object.keys(enhancedTextures), []);
  assert.deepEqual(Object.keys(enhancedShading), []);
  const tex = toDataTexture({ key: '9:1', width: 4, height: 4, rgba: new Uint8Array(64).fill(200), hasAlpha: false });
  const src = { texture: () => tex, missing: missingTexture };
  const material: SurfaceMaterial = { key: '9:900', cls: 0, layers: [{ texture: '9:1', blend: Blend.Opaque }] };
  const a = createSurfaceMaterial({ material, vertexColors: true, hasUvs: true }, src).material as THREE.MeshStandardNodeMaterial & { surfaceSlots: { t: THREE.Texture[] } };
  assert.equal(a.surfaceSlots.t[0], tex);
  // Hooks that find nothing (no cache, Low tier, over budget): the same graph and textures.
  enhancedTextures.maps = () => undefined;
  enhancedTextures.texture = (_k, _c, base) => base;
  try {
    const b = createSurfaceMaterial({ material, vertexColors: true, hasUvs: true }, src).material as typeof a;
    assert.equal(b.colorNode, a.colorNode);
    assert.equal(b.surfaceSlots.t[0], tex);
    // The upscaled albedo replaces the texture in the material's slot, not the graph.
    const up = new THREE.Texture();
    enhancedTextures.texture = (_k, _c, base) => (base === tex ? up : base);
    const c = createSurfaceMaterial({ material, vertexColors: true, hasUvs: true }, src).material as typeof a;
    assert.equal(c.colorNode, a.colorNode);
    assert.equal(c.surfaceSlots.t[0], up);
  } finally {
    delete enhancedTextures.maps;
    delete enhancedTextures.texture;
  }
  // The runtime is only reachable from the Enhanced entry point.
  for (const f of ['src/app/surface-material.ts', 'src/app/character.ts', 'src/app/main.ts', 'src/app/renderer.ts']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /from '\.\/enhanced\/maps/, f);
  }
  assert.match(readFileSync('src/app/main.ts', 'utf8'), /if \(view\.enhanced && fs\) await view\.enhanced\.maps\.prepareLevel/);
});

test('runtime fallback: no cache, missing entries, Low tier and the budget leave surfaces as they are', async () => {
  const { EnhancedTextureMaps, levelTextureKeys } = await import('../src/app/enhanced/maps/runtime');
  const maps = new EnhancedTextureMaps();
  try {
    const base = new THREE.Texture();
    maps.setTier('high');
    // No cache attached.
    assert.equal(maps.maps('9:1'), undefined);
    assert.equal(maps.texture('9:1', false, base), base);
    assert.equal(maps.available, false);
    // A cache without this key; and an entry the Low tier does not draw, or the budget cannot hold.
    const entry: EnhancedEntry = {
      fp: 'x', width: 8192, height: 8192, cls: 'stone', alpha: false,
      normal: { file: 'n', width: 16384, height: 16384, bytes: 1 },
      surface: { file: 's', width: 8192, height: 8192, bytes: 1 },
    };
    (maps as unknown as { manifest: unknown }).manifest = { version: 1, generator: 'g', scale: 2, codec: 'webp', textures: { '9:2': entry } };
    assert.equal(maps.maps('9:1'), undefined);
    assert.equal(maps.maps('9:2'), undefined, 'over the High budget');
    assert.equal(maps.stats.overBudget, 1);
    assert.equal(maps.maps('9:2'), undefined, 'still turned away');
    assert.equal(maps.stats.overBudget, 1);
    assert.equal(maps.texture('9:2', false, base), base, 'no upscaled albedo in the entry');
    maps.setTier('low');
    assert.equal(maps.maps('9:2'), undefined);
    // The level's keys: the maps of the first lit mesh-UV layer (after an environment-reflection
    // base), the albedo of every layer.
    const keys = levelTextureKeys({
      parts: [
        { material: { key: 'm', cls: 0, layers: [{ texture: '1:1', blend: Blend.Opaque, texGen: 4, texInput: TexInput.Reflection }, { texture: '1:2', blend: Blend.AddOverAlpha }] } },
        { textureKey: '1:3' },
        { material: { key: 'f', cls: 0, layers: [{ texture: '1:4', blend: Blend.Add }] } },
      ],
    } as never);
    assert.deepEqual(keys.maps.sort(), ['1:2', '1:3']);
    assert.deepEqual(keys.albedo.sort(), ['1:1', '1:2', '1:3', '1:4']);
  } finally {
    delete enhancedTextures.maps;
    delete enhancedTextures.texture;
  }
});
