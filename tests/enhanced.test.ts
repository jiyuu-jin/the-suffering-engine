// Enhanced graphics mode (docs/enhanced.md): mode / tier resolution, the tier table, Auto's
// starting tier and frame-time governor, and guards that Original mode is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';
import { ENHANCED, GRAPHICS, SETTINGS_KEY, TIERS, TIER_FEATURES, TIER_SETTINGS, WEBGL_MAX_TIER, capTier, resolveGraphics, stepTier } from '../src/app/enhanced/config';
import { TierGovernor, tierFromProbe } from '../src/app/enhanced/auto-tier';
import { BACK_BUFFER_TYPE, GAMMA_BACK_BUFFER, engineLights, engineStages, enhancedShading } from '../src/app/engine-light';
import { GRAPHICS_DEFAULTS } from '../src/app/menu/graphics';

test('graphics mode: Original by default; URL beats the saved settings', () => {
  assert.deepEqual(resolveGraphics('', null), { mode: 'original', tier: 'auto', source: 'default' });
  assert.deepEqual(resolveGraphics('?gfx=enhanced&tier=high', null), { mode: 'enhanced', tier: 'high', source: 'url' });
  assert.deepEqual(resolveGraphics('', { gfxMode: 1, gfxTier: 4 }), { mode: 'enhanced', tier: 'ultra', source: 'settings' });
  assert.deepEqual(resolveGraphics('?gfx=original', { gfxMode: 1, gfxTier: 2 }), { mode: 'original', tier: 'medium', source: 'url' });
  // Junk is ignored.
  assert.deepEqual(resolveGraphics('?gfx=rtx&tier=insane', { gfxMode: 7, gfxTier: 'x' }), { mode: 'original', tier: 'auto', source: 'default' });
  // Menu choice order = the stored indices.
  assert.deepEqual([...TIER_SETTINGS], ['auto', 'low', 'medium', 'high', 'ultra']);
  assert.equal(GRAPHICS_DEFAULTS.gfxMode, 0);
  assert.equal(GRAPHICS_DEFAULTS.gfxTier, 0);
});

test('graphics mode: config reads the settings key the settings module writes', () => {
  const src = readFileSync('src/app/menu/settings.ts', 'utf8');
  assert.match(src, new RegExp(`const KEY = '${SETTINGS_KEY.replace(/\./g, '\\.')}'`));
});

test('tiers: every feature grows (or holds) from Low to Ultra', () => {
  const num = ['renderScale', 'flashShadowSize', 'shadowTaps', 'lampShadows', 'lampShadowSize', 'lampFacesPerFrame', 'moonShadowSize', 'specularLights', 'volumetricSteps', 'volumetricScale', 'aoSamples', 'aoScale'] as const;
  for (let i = 1; i < TIERS.length; i++) {
    const a = TIER_FEATURES[TIERS[i - 1]], b = TIER_FEATURES[TIERS[i]];
    for (const k of num) assert.ok(b[k] >= a[k], `${k}: ${TIERS[i]} ${b[k]} < ${TIERS[i - 1]} ${a[k]}`);
    for (const k of ['bloom', 'ssr', 'dof'] as const) assert.ok(!a[k] || b[k], `${k} lost at ${TIERS[i]}`);
  }
  assert.equal(stepTier('low', -1), 'low');
  assert.equal(stepTier('high', 1), 'ultra');
  assert.equal(stepTier('medium', 1, 'medium'), 'medium');
  assert.equal(capTier('ultra', WEBGL_MAX_TIER), 'medium');
});

test('auto tier: adapter probe -> starting tier; WebGL2 and fallback adapters capped', () => {
  assert.equal(tierFromProbe({ backend: 'WebGPU', fallback: false, score: 4, probeMs: 1 }), 'ultra');
  assert.equal(tierFromProbe({ backend: 'WebGPU', fallback: false, score: 4, probeMs: 3 }), 'high');
  assert.equal(tierFromProbe({ backend: 'WebGPU', fallback: false, score: 4, probeMs: 9 }), 'medium');
  assert.equal(tierFromProbe({ backend: 'WebGPU', fallback: false, score: 4, probeMs: 40 }), 'low');
  assert.equal(tierFromProbe({ backend: 'WebGPU', fallback: false, score: 1, probeMs: 1 }), 'medium');
  assert.equal(tierFromProbe({ backend: 'WebGPU', fallback: true, score: 4, probeMs: 1 }), 'low');
  assert.equal(tierFromProbe({ backend: 'WebGL2', fallback: false, score: 4, probeMs: 1 }), WEBGL_MAX_TIER);
  assert.equal(tierFromProbe({ backend: 'WebGL2', fallback: false, score: 0, probeMs: -1 }), 'low');
});

test('auto tier: the governor drops under the target, raises with headroom, remembers a failed raise', () => {
  const g = new TierGovernor('high');
  g.target = 60;
  let now = 0;
  const run = (fps: number, secs: number, busy = 0.2) => {
    const out: string[] = [];
    const dt = 1000 / fps;
    for (let t = 0; t < secs * 1000; t += dt) {
      now += dt;
      const r = g.sample(dt, dt * busy, now);
      if (r) out.push(r);
    }
    return out;
  };
  // 40 fps: two slow windows -> one tier down; after the cooldown, down again.
  assert.deepEqual(run(40, 3.2), ['medium']);
  assert.deepEqual(run(40, 6.5), ['low']);
  // At the display rate with an idle CPU: up again after the cooldown and three fast windows.
  assert.deepEqual(run(60, 8), ['medium']);
  // Holding 60 but busy: no raise.
  assert.deepEqual(run(60, 6, 0.8), []);
  // Idle again: up to High; undone at once, so High is not retried for a minute.
  assert.deepEqual(run(60, 5), ['high']);
  assert.deepEqual(run(40, 7)[0], 'medium');
  assert.deepEqual(run(60, 20), []);
  assert.ok(g.log.length >= 4);
});

test('Original mode is untouched: gamma back buffer, no Enhanced hooks, saturating passes', () => {
  // The tests run without `?gfx=`: the page default.
  assert.equal(GRAPHICS.mode, 'original');
  assert.equal(ENHANCED, false);
  assert.equal(GAMMA_BACK_BUFFER, true);
  assert.equal(BACK_BUFFER_TYPE, THREE.UnsignedByteType);
  assert.deepEqual(Object.keys(enhancedShading), []);
  assert.equal(engineLights.perPixelFlashlight, false);
  // engineStages still saturates at 1 (the back buffer), as before Enhanced existed.
  const n = (engineStages(float(0.5)) as unknown as { node: { method: string; bNode: { value: number } } }).node;
  assert.equal(n.method, 'min');
  assert.equal(n.bNode.value, 1);
});

test('Original mode never loads the Enhanced modules (only a type import and a guarded dynamic import)', () => {
  const r = readFileSync('src/app/renderer.ts', 'utf8');
  assert.match(r, /import type \{ EnhancedRenderer \} from '\.\/enhanced';/);
  assert.match(r, /const enhanced = ENHANCED \? await import\('\.\/enhanced'\) : null;/);
  assert.doesNotMatch(r, /^import \{[^}]*\} from '\.\/enhanced(\/(index|shading|post|lights|shadows|volumetric))?';/m);
  for (const f of ['src/app/engine-light.ts', 'src/app/surface-material.ts', 'src/game/insanity/effects.ts', 'src/app/menu/graphics.ts']) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /from '\.\.?\/(\.\.\/)*(app\/)?enhanced\/(index|shading|post|lights|shadows|volumetric)'/, f);
  }
});
