// Enhanced mode exposure model (src/app/enhanced/tone.ts, docs/enhanced.md §Exposure) and the
// image checks of the comparison set (tools/image-metrics.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALBEDO_MAX, ALBEDO_MAX_GAMMA, LIGHT_SOFT, TONE, displayOf, softLight, toneCurve } from '../src/app/enhanced/tone';
import { checkFrame, decodePng, frameMetrics } from '../tools/image-metrics';
import { encodePng } from '../tools/png';
import { float } from 'three/tsl';
import { engineAlbedo, enhancedShading } from '../src/app/engine-light';
import { readFileSync } from 'node:fs';

test('enhanced exposure: darks read as in Original, white albedo is not a light source', () => {
  // Dark and mid tones (texture x light <= 0.7, no flashlight): within 25 % of what Original shows,
  // never darker by more than that, never brighter (the old AgX + linear contrast sent everything under 0.17 to black).
  for (const g of [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7]) {
    const d = displayOf(g, 1);
    assert.ok(d >= g * 0.75 && d <= g * 1.02, `gamma ${g} -> ${d.toFixed(3)}`);
  }
  // A white texture under its authored light (L = 1) stays well below clipping.
  assert.ok(displayOf(1, 1) < 0.92, `white at L 1 -> ${displayOf(1, 1)}`);
  // Albedo: at most 80 % reflectance.
  assert.ok(Math.abs(Math.pow((ALBEDO_MAX_GAMMA + 0.055) / 1.055, 2.4) - ALBEDO_MAX) < 1e-9);
  // Authored light saturates softly (the original's clamp is 400 / 255).
  assert.equal(softLight(0.5), 0.5);
  assert.equal(softLight(1), 1);
  assert.ok(softLight(400 / 255) < 400 / 255 && softLight(1e6) < 1 + LIGHT_SOFT);
  // The tone curve: identity below the knee, monotonic, C1 at the knee, bounded by 1.
  assert.equal(toneCurve(TONE.knee * 0.5), TONE.knee * 0.5);
  let prev = 0;
  for (let m = 0; m < 40; m += 0.05) {
    const v = toneCurve(m);
    assert.ok(v >= prev && v < 1 + 1e-9);
    prev = v;
  }
  const e = 1e-5;
  assert.ok(Math.abs((toneCurve(TONE.knee + e) - toneCurve(TONE.knee)) / e - 1) < 1e-3);
  // Bloom starts above diffuse white under the brightest authored light.
  assert.ok(TONE.bloomThreshold > ALBEDO_MAX * Math.pow(1 + LIGHT_SOFT, 2.2) * 0.75);
});

test('image metrics: PNG round trip, clipped / near-black shares, the per-pose check', () => {
  const w = 10, h = 10;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = i < 10 ? 255 : i < 40 ? 0 : 128;
    rgba.set([v, v, v, 255], i * 4);
  }
  const img = decodePng(encodePng(w, h, rgba));
  assert.equal(img.width, w);
  assert.deepEqual([...img.rgba], [...rgba]);
  const m = frameMetrics(img);
  assert.ok(Math.abs(m.clipped - 0.1) < 1e-9);
  assert.ok(Math.abs(m.black - 0.3) < 1e-9);
  assert.equal(m.p50, 128);
  // Same frame: passes except the clipped share, which is above 2 % but not above the Original's.
  assert.ok(checkFrame(m, m).ok);
  const crushed = { ...m, black: m.black + 0.2, mean: m.mean * 0.5 };
  const r = checkFrame(m, crushed);
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 2);
  assert.ok(!checkFrame({ ...m, clipped: 0 }, m).ok);
});

test('Original mode: the albedo and glow hooks build the old graphs', () => {
  // Unset hooks: the lit pass multiplies the texture colour node itself (the same node, so the
  // same shader), and no surface gets the glow token.
  assert.equal(enhancedShading.albedo, undefined);
  assert.equal(enhancedShading.glow, undefined);
  const g = float(0.5);
  assert.equal(engineAlbedo(g), g);
  const src = readFileSync('src/app/surface-material.ts', 'utf8');
  assert.match(src, /const glow = !LEGACY_LIGHTING && !!enhancedShading\.glow && glowMarked\(layers\);/);
});
