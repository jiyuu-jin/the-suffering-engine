// Enhanced mode: lamp cube-map caching (which faces a caster can show in) and the flashlight's
// beam start, decoded from the original's Spot Light constants (docs/enhanced.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubeFaceMask } from '../src/app/enhanced/shadows';
import { FLASH, FLASH_BEAM_START, FLASH_START_RAMP } from '../src/app/enhanced/lights';
import { spotConstants } from '../src/formats/render-data';
import { FLASHLIGHT_SPOTS } from '../src/app/engine-light';

// Face k looks along +x, −x, +y, −y, +z, −z (three.js's WebGL cube camera order).
const AXES = [0, 3, 1, 4, 2, 5];
const faces = (m: number) => [0, 1, 2, 3, 4, 5].filter((k) => m & (1 << k));

test('lamp cube cache: a caster marks only the faces it can show in', () => {
  // A small caster straight along +x: that face only.
  assert.deepEqual(faces(cubeFaceMask({ x: 5, y: 0, z: 0 }, 0.2, 24, AXES)), [0]);
  assert.deepEqual(faces(cubeFaceMask({ x: 0, y: -3, z: 0 }, 0.2, 24, AXES)), [3]);
  // On the diagonal between +x and +z, or large enough to cross the edge: both.
  assert.deepEqual(faces(cubeFaceMask({ x: 4, y: 0, z: 4 }, 0.1, 24, AXES)), [0, 4]);
  assert.deepEqual(faces(cubeFaceMask({ x: 5, y: 0, z: 4.5 }, 1, 24, AXES)), [0, 4]);
  // Around the lamp: every face. Beyond the map's reach: none.
  assert.deepEqual(faces(cubeFaceMask({ x: 0.2, y: 0, z: 0 }, 1, 24, AXES)), [0, 1, 2, 3, 4, 5]);
  assert.equal(cubeFaceMask({ x: 30, y: 0, z: 0 }, 1, 24, AXES), 0);
  // The face order comes from the cameras (WebGPU's cube cameras look the other way along x).
  assert.deepEqual(faces(cubeFaceMask({ x: 5, y: 0, z: 0 }, 0.2, 24, [3, 0, 1, 4, 2, 5])), [1]);
  // Conservative: every direction is in at least one face, whatever the radius.
  for (let i = 0; i < 500; i++) {
    const v = { x: Math.sin(i * 1.7) * 9, y: Math.cos(i * 2.3) * 9, z: Math.sin(i * 0.37) * 9 };
    assert.ok(cubeFaceMask(v, 0, 24, AXES) !== 0, JSON.stringify(v));
  }
});

test("flashlight: the beam starts where the original's does (spot c10.w along the axis)", () => {
  // The flashlight's beam: Spot Light p8 1, p9 6, p10 10 -> R·S / (L − S) = 2 m [verified,
  // render-data.ts spotConstants]; its spill 1 / 4 / 5 -> 1.67 m.
  assert.equal(spotConstants(FLASHLIGHT_SPOTS[0]).start, 2);
  assert.ok(Math.abs(spotConstants(FLASHLIGHT_SPOTS[1]).start - 5 / 3) < 1e-9);
  assert.equal(FLASH_BEAM_START, 2);
  assert.equal(FLASH.start, FLASH_BEAM_START);
  // The fade-in straddles it (the original's per-vertex step is as soft across a triangle).
  assert.ok(FLASH_START_RAMP.every((r) => r > 0 && r <= 0.5));
});
