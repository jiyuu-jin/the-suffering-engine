// Renderer RE constants and decoders (src/formats/render-data.ts, docs/re/renderer.md).
// Pure arithmetic checks, plus data checks against a local install (skipped without one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, hasData, skip } from './helpers';
import {
  applicableDirectionals,
  applicableRegions,
  directionalRole,
  tintFactor,
  decodeSceneGlow,
  gammaRamp,
  GLOW_TAPS,
  insertLight,
  LightFlag,
  LightType,
  LIGHT_RADIUS_CUTOFF,
  pointLightCullRadius,
  pointLightInfluence,
  pointLightLevel,
  screenBlurPass,
  shaderKeyLights,
  shaderLights,
  shadowLightIndex,
  shadowFacing,
  shadowLightDirection,
  shadowReceiverAlpha,
  SHADOW_MIN_ELEVATION,
  SHADOW_RECEIVER_ALPHA,
  spotConstants,
  type RankedLight,
} from '../src/formats/render-data';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('point light cull radius: luma33 × I / d² falls to the 0.1 cutoff at the radius (I = p8)', () => {
  assert.equal(LIGHT_RADIUS_CUTOFF, 0.1);
  // White light: sqrt(I / 0.1) metres.
  close(pointLightCullRadius(4, [1, 1, 1]), Math.sqrt(40));
  // At the cull radius the cull-weighted level is exactly the cutoff.
  const rgb = [0.8, 0.5, 0.2];
  const R = pointLightCullRadius(6, rgb);
  close(((0.33 * 0.8 + 0.45 * 0.5 + 0.22 * 0.2) * 6) / (R * R), 0.1, 1e-9);
  // Black and negative lights are never selected.
  assert.equal(pointLightCullRadius(6, [0, 0, 0]), 0);
  assert.equal(pointLightCullRadius(6, [-1, -1, -1]), 0);
});

test('point light influence: rank luma × I / d² inside the cull radius, else 0', () => {
  close(pointLightInfluence(2, [1, 1, 1], 1), 2 * (0.212 + 0.701 + 0.087));
  // The shader level: min(I / d², 2) (xvsLightPoint.vsh; I = p8 × 2048² in engine units, 0x4c60b0).
  close(pointLightLevel(4.05, 4), 4.05 / 4);
  close(pointLightLevel(4.05, 1), 2);
  assert.equal(pointLightInfluence(2, [1, 1, 1], 1e6), 0);
});

test('light set: insertion order of 0x4c2f30; 12 slots, 8 / 5 to the shader', () => {
  const set: (RankedLight & { id: string })[] = [];
  const add = (id: string, type: LightType, influence: number, flags = 0) => insertLight(set, { id, type, influence, flags });
  add('p1', LightType.Point, 1);
  add('p3', LightType.Point, 3);
  add('d1', LightType.Directional, 0.5);
  add('s2', LightType.Spot, 2);
  add('pp', LightType.Point, 0.1, LightFlag.Priority);
  add('d2', LightType.Directional, 0.7);
  // A directional goes before the first non-directional; a priority light before the first
  // non-directional; anything else before the first weaker light.
  assert.deepEqual(set.map((l) => l.id), ['d2', 'pp', 's2', 'd1', 'p3', 'p1']);
  for (let i = 0; i < 10; i++) add('q' + i, LightType.Point, 0.01 * (10 - i));
  assert.equal(set.length, 12);
  assert.equal(add('weak', LightType.Point, 0.0001), false);
  const sh = shaderLights(set);
  assert.equal(sh.length, 8);
  assert.equal(sh.filter((l) => l.type === LightType.Point).length, 5);
});

test('ambient regions: smallest first, cut after the first exclusive one', () => {
  const r = applicableRegions([
    { id: 'big', volume: 100, exclusive: true },
    { id: 'small', volume: 2, exclusive: true },
    { id: 'mid', volume: 10, exclusive: false },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['small']);
  assert.deepEqual(applicableRegions([{ id: 'a', volume: 5, exclusive: false }, { id: 'b', volume: 1, exclusive: false }]).map((x) => x.id), ['b', 'a']);
});

test('directional lights: smallest first, cut after the first exclusive, rims kept for dynamic objects, first rim only (0x4ca730)', () => {
  const lights = [
    { id: 'rootBase', volume: Infinity, exclusive: true, rim: false },
    { id: 'rootRim', volume: Infinity, exclusive: false, rim: true },
    { id: 'roomBase', volume: 50, exclusive: true, rim: false },
    { id: 'roomRim', volume: 50, exclusive: false, rim: true },
    { id: 'lamp', volume: 10, exclusive: false, rim: false },
  ];
  const ids = (dynamic: boolean, from = lights) => applicableDirectionals(from, dynamic).map((l) => l.id);
  // The room's exclusive base light hides the root one; the room's rim (the first) applies.
  assert.deepEqual(ids(true), ['lamp', 'roomBase', 'roomRim']);
  // Objects that are not dynamic never gather rim lights.
  assert.deepEqual(ids(false), ['lamp', 'roomBase']);
  // In the root region only: a black exclusive base light still leaves its rim.
  assert.deepEqual(ids(true, lights.slice(0, 2)), ['rootBase', 'rootRim']);
  // A non-exclusive light (1a 0x8add, p8 = 0) cuts nothing.
  assert.deepEqual(ids(false, [lights[0], { ...lights[2], exclusive: false }]), ['roomBase', 'rootBase']);
});

test('spot constants from p8 / p9 / p10 (start / length / cone radius)', () => {
  // With p8 = 0: start 0, range = R·L / (L − S) = R, I = 0.2·L² / R².
  const z = spotConstants({ start: 0, length: 6, radius: 20 });
  close(z.start, 0);
  close(z.invRange2, 1 / 400);
  close(z.cone, (0.2 * 36) / 400);
  // Flashlight beam 4:123 (p8 1, p9 6, p10 10): slope 2, range 12, start 2, I = 0.05.
  const b = spotConstants({ start: 1, length: 6, radius: 10 });
  close(b.start, 2);
  close(1 / Math.sqrt(b.invRange2), 12);
  close(b.cone, 0.05);
});

test('screen blur pass: alpha = min(1.4 A, 225/255), UV inset = B, mode 3 -> 4', () => {
  const p = screenBlurPass(60, 0.3, 1);
  close(p.alpha, 214 / 255);
  close(p.inset, 0.003);
  assert.equal(p.blend, 1);
  assert.equal(screenBlurPass(100, 0, 3).alpha, 225 / 255);
  assert.equal(screenBlurPass(100, 0, 3).blend, 4);
  assert.equal(screenBlurPass(0, 0, 2).alpha, 0);
});

test('glow taps, scene glow decode, gamma ramp, shadow facing', () => {
  assert.equal(GLOW_TAPS.length, 7);
  assert.equal(GLOW_TAPS.reduce((s, t) => s + t.weight, 0), 480);
  const g = decodeSceneGlow([50, 0xc6d7ea, 2, 1]);
  assert.equal(g.color, 0xc6d7ea);
  close(g.alpha, 127 / 255);
  assert.equal(g.blend, 2);
  const id = gammaRamp(1);
  assert.equal(id[0], 0);
  assert.equal(id[255], 255 << 8);
  assert.ok(gammaRamp(2)[64] > id[64]);
  assert.equal(shadowFacing(-0.3), 0);
  close(shadowFacing(0.4), 1);
  close(shadowFacing(0.05), 0.5);
});

test('projected shadows: light direction raised to 45°, receiver alpha 0.66 beyond half the reach', () => {
  close(SHADOW_RECEIVER_ALPHA, 0.66);
  close(SHADOW_MIN_ELEVATION, Math.SQRT1_2);
  // A light high above keeps its direction.
  const up = shadowLightDirection([0, 4, 0])!;
  close(up[1], 1);
  const steep = shadowLightDirection([1, 2, 0])!;
  close(steep[0], 1 / Math.sqrt(5));
  close(steep[1], 2 / Math.sqrt(5));
  // A light level with (or below) the caster is raised to 45°, keeping its heading.
  const flat = shadowLightDirection([3, 0, 4])!;
  close(flat[1], Math.SQRT1_2);
  close(flat[0], 0.6 * Math.SQRT1_2);
  close(flat[2], 0.8 * Math.SQRT1_2);
  const below = shadowLightDirection([0, -5, 1])!;
  close(below[1], Math.SQRT1_2);
  close(below[2], Math.SQRT1_2);
  assert.equal(shadowLightDirection([0, 0, 0]), null);
  // Receiver alpha: the fade near the caster, 0.66 × (1 − t) × fade beyond, nothing past the reach.
  assert.equal(shadowReceiverAlpha(-0.5, 0.8), 0.8);
  close(shadowReceiverAlpha(0.25), 0.75 * 0.66);
  close(shadowReceiverAlpha(0.5, 0.5), 0.5 * 0.5 * 0.66);
  assert.equal(shadowReceiverAlpha(1), 0);
});

test('shader library: 989 programs; bit 0 = baked colours, 101 of them also run directional lights', { skip }, () => {
  const d = readFileSync(join(DATA_ROOT, 'xvsh/ShaderLibrary.bin'));
  const n = d.readUInt32LE(0);
  assert.equal(n, 989);
  let o = 4 + 8 * n;
  let bakedDir = 0;
  for (let i = 0; i < n; i++) {
    const key = d.readUInt32LE(4 + 8 * i);
    const size = d.readUInt32LE(o);
    const code = d.subarray(o + 4, o + 4 + size);
    o += 4 + size;
    assert.equal(code.readUInt32LE(0), 0xfffe0101, `program ${i} is vs_1_1`);
    // Walk the vs_1_1 instructions. xvsLightPrecomputed: mul r2, v10, c51; xvsLightDir: max with c50.
    const NOPS: Record<number, number> = { 1: 2, 2: 3, 3: 3, 4: 4, 5: 3, 6: 2, 7: 2, 8: 3, 9: 3, 10: 3, 11: 3, 12: 3, 13: 3, 14: 2, 15: 2, 16: 2, 17: 3, 18: 4, 19: 2, 20: 3, 0x1f: 2 };
    const reg = (t: number) => ((((t >>> 28) & 7) | ((t >>> 8) & 0x18)) << 16) | (t & 0x7ff);
    let baked = false, dir = false;
    for (let k = 4; k < code.length; ) {
      const tok = code.readUInt32LE(k);
      const op = tok & 0xffff;
      if (op === 0xffff) break;
      if (op === 0xfffe) { k += 4 * (((tok >>> 16) & 0x7fff) + 1); continue; }
      const n = NOPS[op];
      assert.ok(n, `program ${i}: opcode ${op}`);
      const src = [1, 2, 3].slice(0, n - 1).map((j) => reg(code.readUInt32LE(k + 4 * (j + 1))));
      if (op === 5 && src[0] === ((1 << 16) | 10)) baked = true;
      if (op === 11 && src.includes((2 << 16) | 50)) dir = true;
      k += 4 * (n + 1);
    }
    assert.equal(baked, shaderKeyLights(key).baked, `program ${i} key ${key.toString(16)}`);
    if (baked && dir) bakedDir++;
  }
  assert.equal(o, d.length);
  assert.equal(bakedDir, 101);
});

test('directional light roles and pass tint factor', () => {
  // Retail: rim lights thinking with no inputs light dynamic objects only.
  assert.deepEqual(directionalRole({ p2: 0, p3: false, p4: 0, p5: 0, p6: 1, rim: true, links: 0 }), { base: true, baked: false, on: true });
  // Level 2 / 1a style: off at start, switched by messages, lights baked geometry too.
  assert.deepEqual(directionalRole({ p2: 0, p3: false, p4: 1, p5: 2, p6: 0, rim: true, links: 0 }), { base: true, baked: true, on: false });
  // Bake-only.
  assert.equal(directionalRole({ p2: 0, p3: false, p4: 0, p5: 0, p6: 1, rim: false, links: 0 }).base, false);
  assert.equal(tintFactor(undefined), null);
  assert.deepEqual(tintFactor(0xffffff), [0.5, 0.5, 0.5]);
  close(tintFactor(0x3f3f3f)![0], 63 / 510);
});

test('install present for data checks', { skip: hasData ? false : 'no data' }, () => assert.ok(hasData));

test('shadow light (0x4cc020): first light of the set, skipping the flashlight (flag 0x100) for dynamic casters', () => {
  const lamp = { type: LightType.Point, influence: 0.3 };
  const corridor = { type: LightType.Point, influence: 0.2 };
  const flashlight = { type: LightType.Spot, influence: 0.1, flags: LightFlag.Priority };
  const set: RankedLight[] = [];
  for (const l of [corridor, lamp, flashlight]) insertLight(set, l);
  // The flashlight is ranked first (priority) but never a character's shadow light.
  assert.equal(set[0], flashlight);
  assert.equal(set[shadowLightIndex(set)], lamp);
  // A static caster would take it.
  assert.equal(shadowLightIndex(set, false), 0);
  assert.equal(shadowLightIndex([]), -1);
  assert.equal(shadowLightIndex([flashlight]), -1);
});
