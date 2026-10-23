// Enhanced mode: every level surface's fragment shader stays within WebGPU's default sampled
// texture limit (16 per stage) at every tier (docs/enhanced.md "Texture enhancement"). Layered
// surfaces of 1a went to 17-18 textures with the generated maps on top of their layers, the
// Enhanced shadow maps and the projected character shadows, and their pipelines failed to build.
//
// Runs in its own process (node --test): it installs the Enhanced hooks, which Original-mode
// tests must not see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { filesWithExt, nodeFS, readSrsc, skip } from './helpers';
import { findLevelDependencies, loadPackages, stem } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { parseLevel, readLevelHeader } from '../src/formats/level';
import { ENGINE_SHADOW_TEXTURES, MAX_FRAGMENT_TEXTURES, enhancedMapsTextures, enhancedShading, fitEnhancedMaps, type EnhancedMaps } from '../src/app/engine-light';
import { createSurfaceMaterial, enhancedTextures, missingTexture } from '../src/app/surface-material';
import { installEnhancedShading } from '../src/app/enhanced/shading';
import { DETAIL_TEXTURES, EnhancedTextureMaps } from '../src/app/enhanced/maps/runtime';
import { TIER_MAPS } from '../src/app/enhanced/maps/manifest';
import { TIERS } from '../src/app/enhanced/config';
import { Blend, type SurfaceMaterial } from '../src/formats/model';

// (The runtime makes its 1×1 stand-ins on an OffscreenCanvas, which node lacks.)
(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas ??= class {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return { createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} };
  }
};

installEnhancedShading();
// The real surface hook (maps/runtime.ts wraps shading.ts's: the detail maps), then a spy on it.
new EnhancedTextureMaps();
const hook = enhancedShading.surface!;
let lastMaps: EnhancedMaps | null = null;
enhancedShading.surface = (maps, sample, coords) => ((lastMaps = maps), hook(maps, sample, coords));

const textures = new Map<string, THREE.Texture>();
const tex = (k: string) => textures.get(k) ?? (textures.set(k, new THREE.Texture()), textures.get(k)!);
const src = { texture: (k: string) => tex(k), missing: missingTexture, hasAlpha: () => false };

/** Fragment textures of a built surface: its slots, the hook's detail maps, the fixed shadow maps. */
function count(material: THREE.Material): number {
  const slots = (material as unknown as { surfaceSlots?: { t: THREE.Texture[] } }).surfaceSlots?.t.length ?? 0;
  const lit = !(material instanceof THREE.MeshBasicNodeMaterial);
  return slots + (lastMaps?.detail ?? 0) + (lit ? (enhancedShading.textures ?? 0) + ENGINE_SHADOW_TEXTURES : 0);
}

/** The generated maps a tier hands out for every key (worst case: every texture has an entry). */
function useTier(tier: (typeof TIERS)[number]) {
  const p = TIER_MAPS[tier];
  enhancedTextures.maps = (key) => {
    if (!p.normal && !p.surface) return undefined;
    const m: EnhancedMaps = {};
    if (p.normal) m.normal = tex(`${key}.n`);
    if (p.surface) (m.roughness = m.specular = tex(`${key}.s`)), (m.detail = DETAIL_TEXTURES);
    return m;
  };
  enhancedTextures.texture = (_k, _c, base) => base;
}

test('texture budget: maps are dropped by priority (detail, surface, normal) to fit', () => {
  const n = tex('n'), s = tex('s');
  const full: EnhancedMaps = { normal: n, roughness: s, specular: s, detail: 2 };
  assert.equal(enhancedMapsTextures(full), 4);
  assert.equal(fitEnhancedMaps(full, 4), full);
  assert.deepEqual(fitEnhancedMaps(full, 3), { ...full, detail: 0 });
  assert.deepEqual(fitEnhancedMaps(full, 2), { ...full, detail: 0 });
  assert.deepEqual(fitEnhancedMaps(full, 1), { normal: n, normalScale: undefined });
  assert.equal(fitEnhancedMaps(full, 0), undefined);
  assert.deepEqual(fitEnhancedMaps({ roughness: s, specular: s, detail: 2 }, 1), { roughness: s, specular: s, detail: 0 });
  assert.equal(fitEnhancedMaps({ roughness: s, specular: s, detail: 2 }, 0), undefined);
});

test('texture budget: a surface of many layers keeps within the limit; one layer keeps every map', () => {
  useTier('ultra');
  const layered: SurfaceMaterial = { key: 't:1', cls: 0, layers: Array.from({ length: 6 }, (_, i) => ({ texture: `9:${i}`, blend: i ? Blend.AddOverAlpha : Blend.Opaque })) };
  lastMaps = null;
  const a = createSurfaceMaterial({ material: layered, vertexColors: true, hasUvs: true }, src).material;
  assert.ok(count(a) <= MAX_FRAGMENT_TEXTURES, `6 layers: ${count(a)}`);
  lastMaps = null;
  const b = createSurfaceMaterial({ material: { key: 't:2', cls: 0, layers: [{ texture: '9:10', blend: Blend.Opaque }] }, vertexColors: true, hasUvs: true }, src).material;
  assert.equal(lastMaps && enhancedMapsTextures(lastMaps), 4, 'normal, surface and the two detail maps');
  assert.ok(count(b) <= MAX_FRAGMENT_TEXTURES);
});

test('texture budget: every retail level surface fits at every tier', { skip }, async () => {
  const fs = nodeFS();
  const levels = filesWithExt('.lvl');
  assert.equal(levels.length, 18);
  const silent = () => {};
  const origWarn = console.warn;
  console.warn = silent;
  let checked = 0, ultra = 0, trimmed = 0;
  try {
    for (const path of levels) {
      const deps = await findLevelDependencies(fs, path);
      const lvl = readSrsc(path);
      const ldu = deps.levelLdu ? readSrsc(deps.levelLdu) : undefined;
      const packages = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, silent);
      const level = parseLevel(lvl, stem(path), { ldu, packages });
      for (const tier of TIERS) {
        useTier(tier);
        for (const p of level.parts) {
          lastMaps = null;
          const { material } = createSurfaceMaterial(
            { material: p.material, textureKey: p.textureKey, vertexColors: !!p.colors, hasUvs: !!p.uvs, splat: p.splatWeights ? p.splat : undefined },
            src,
          );
          const n = count(material);
          assert.ok(n <= MAX_FRAGMENT_TEXTURES, `${stem(path)} ${tier} ${material.name}: ${n} fragment textures`);
          if (tier === 'ultra') (ultra++, lastMaps && !(lastMaps as EnhancedMaps).detail && trimmed++);
          checked++;
          material.dispose();
        }
      }
    }
  } finally {
    console.warn = origWarn;
    delete enhancedTextures.maps;
    delete enhancedTextures.texture;
  }
  assert.ok(checked > 1000, `${checked} surfaces`);
  // (Most surfaces are one or two layers and keep every map.)
  assert.ok(trimmed < ultra / 8, `${trimmed} of ${ultra} trimmed at Ultra`);
});

test('characters: one shared engine-lit graph per map layout, the maps read from the drawn material', async () => {
  const { engineLightMaterial } = await import('../src/app/engine-light');
  const maps = new EnhancedTextureMaps();
  (maps as unknown as { manifest: unknown }).manifest = { version: 1, generator: 'g', scale: 2, codec: 'webp', textures: {} };
  try {
    maps.setTier('high');
    const layout = maps.layout();
    assert.ok(layout?.normal && layout.roughness, 'High: normal and surface maps');
    assert.equal(layout.detail ?? 0, 0, 'no concrete detail on cloth and skin');
    const mk = (withMaps: boolean, key?: string) => {
      const m = new THREE.MeshStandardNodeMaterial();
      if (withMaps) maps.bind(m, key);
      return engineLightMaterial(m, { precomputed: false, lightSet: true, enhancedMaps: withMaps ? layout : undefined });
    };
    const a = mk(true, '9:1'), b = mk(true, undefined), plain = mk(false);
    assert.equal(a.colorNode, b.colorNode, 'shared by every character');
    assert.notEqual(a.colorNode, plain.colorNode);
    // No cache entry: the neutral stand-ins; a clone (three.js copies no custom fields) reads them too.
    const t = (a as unknown as { enhancedMapTextures: { normal: THREE.Texture } }).enhancedMapTextures;
    assert.ok(t.normal.isTexture);
    assert.ok((a.clone() as unknown as { enhancedMapTextures: { normal: THREE.Texture } }).enhancedMapTextures.normal.isTexture);
    // Fragment textures: the colour map, normal, surface and the three Enhanced shadow maps
    // (characters take no projected shadows).
    assert.ok(1 + enhancedMapsTextures(layout) + (enhancedShading.textures ?? 0) <= MAX_FRAGMENT_TEXTURES);
    maps.setTier('low');
    assert.equal(maps.layout(), undefined, 'Low: no maps, the plain graph');
  } finally {
    delete enhancedTextures.maps;
    delete enhancedTextures.texture;
  }
});
