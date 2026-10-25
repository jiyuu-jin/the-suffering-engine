// Particle billboards (docs/game-logic.md §14.2): the p48 = 1 streak quads keep their winding
// (the mirror goes into the texture's u), and the stage-1 doubling of their colour (world/fx.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { particlePassColor } from '../src/game/world/fx';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** Signed area of a quad (counter-clockwise > 0: a front face for three.js). */
const area = (q: number[][]) => q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0) / 2;
const turn = (p: number[], a: number) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];

test('streak quads: a quad mirrored in x is a back face; mirroring u draws the same picture as a front face', () => {
  // three.js sprite corners (counter-clockwise) and their uv.
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const uvs = corners.map(([x, y]) => [x + 0.5, y + 0.5]);
  for (const a of [0, 0.7, 2.4, -1.9]) {
    const mirrored = corners.map(([x, y]) => turn([-x, y], a));
    const plain = corners.map((p) => turn(p, a));
    assert.ok(area(mirrored) < 0, 'the old mirrored quad turned its winding round: culled');
    assert.ok(area(plain) > 0, 'front face');
    // Same texel at the same place: the mirrored quad's corner i (uv i) sits where the plain quad
    // has the corner whose flipped uv is uv i.
    mirrored.forEach((m, i) => {
      const j = plain.findIndex((p) => Math.hypot(p[0] - m[0], p[1] - m[1]) < 1e-9);
      assert.ok(j >= 0);
      close(1 - uvs[j][0], uvs[i][0]);
      close(uvs[j][1], uvs[i][1]);
    });
  }
});

test('particle billboards are doubled by texture stage 1, saturated', () => {
  // 1a shower spray 3:1793: p33 0x484a4d, texture 3:301 grey 0xa5. The port drew 0.18; the
  // engine writes 0.37 (then x alpha, additive).
  close(particlePassColor(0xa5 / 255, 0x48 / 255), Math.min(1, (2 * 0xa5 * 0x48) / 255 / 255));
  close(particlePassColor(0.8, 0.9), 1);
  close(particlePassColor(0.5, 1), 1);
  close(particlePassColor(0.25, 1), 0.5);
});
