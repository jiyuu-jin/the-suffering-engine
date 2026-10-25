// Enhanced mode GPU cost work (docs/perf.md "Perf C"): the baked dust noise of the volumetrics
// (src/app/enhanced/dust-noise.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUST_PERIOD, DUST_SIZE, bakeDustNoise, mxHash3, mxPerlin3 } from '../src/app/enhanced/dust-noise';

test('dust noise: MaterialX lattice hash is a uint32 and deterministic', () => {
  for (const [x, y, z] of [[0, 0, 0], [1, 2, 3], [-1, 5, -7], [15, 15, 15]]) {
    const h = mxHash3(x, y, z);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    assert.equal(h, mxHash3(x, y, z));
  }
  assert.notEqual(mxHash3(0, 0, 0), mxHash3(1, 0, 0));
});

test('dust noise: Perlin is zero on the lattice, bounded and continuous', () => {
  for (const p of [[0, 0, 0], [3, 7, 11], [-2, 4, 9]]) assert.equal(Math.abs(mxPerlin3(p[0], p[1], p[2])), 0);
  let min = 1, max = -1, sum = 0, n = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (i * 0.731) % 40, y = (i * 0.377) % 40, z = (i * 0.913) % 40;
    const v = mxPerlin3(x, y, z);
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    n++;
    // Continuity: a tiny step moves the value a tiny amount (gradients are at most ~2 per cell).
    assert.ok(Math.abs(mxPerlin3(x + 1e-4, y, z) - v) < 1e-3);
  }
  assert.ok(min > -1.05 && max < 1.05, `range ${min} .. ${max}`);
  assert.ok(max - min > 0.8, 'the noise has contrast');
  assert.ok(Math.abs(sum / n) < 0.05, `mean ${sum / n}`);
});

test('dust noise: the wrapped lattice tiles and equals the unwrapped noise inside one period', () => {
  const P = DUST_PERIOD;
  for (const [x, y, z] of [[0.3, 1.7, 2.2], [5.5, 9.25, 14.75], [14.9, 0.1, 7.5]]) {
    assert.ok(Math.abs(mxPerlin3(x, y, z, P) - mxPerlin3(x + P, y - P, z + 2 * P, P)) < 1e-12);
    // Away from the period's last cell the wrapped and plain noise agree.
    if (x < P - 1 && y < P - 1 && z < P - 1) assert.ok(Math.abs(mxPerlin3(x, y, z, P) - mxPerlin3(x, y, z)) < 1e-12);
  }
});

test('dust noise: baked texture layout and quantisation', () => {
  const size = 8, period = 4;
  const t = bakeDustNoise(size, period);
  assert.equal(t.length, size ** 3);
  const at = (i: number, j: number, k: number) => t[i + size * (j + size * k)];
  const s = period / size;
  for (const [i, j, k] of [[0, 0, 0], [3, 5, 7], [7, 1, 2]]) {
    const n = mxPerlin3((i + 0.5) * s, (j + 0.5) * s, (k + 0.5) * s, period);
    assert.ok(Math.abs(at(i, j, k) / 255 * 2 - 1 - n) <= 1 / 255 + 1e-9);
  }
  // The full-size texture: 64³ bytes, mean near the middle (zero noise).
  const full = bakeDustNoise();
  assert.equal(full.length, DUST_SIZE ** 3);
  const mean = full.reduce((a, b) => a + b, 0) / full.length;
  assert.ok(Math.abs(mean - 127.5) < 6, `mean ${mean}`);
});
