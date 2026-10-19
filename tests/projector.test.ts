// Projector Effect (src/game/actors/specials/projector.ts, docs/game-logic.md §15.7.8) and the
// views from other cameras (PlayerController.setExternalView, docs/re/player.md "External views").
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import * as THREE from 'three/webgpu';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readSkinnedModel } from '../src/formats/skeleton';
import type { PackageSet } from '../src/formats/model';
import { characterSurfaceBlend, decodeCharacterTextures } from '../src/app/character';
import { projectorOpacity, projectorParams, ProjectorState, skinnedVertexFor } from '../src/game/actors/specials/projector';
import { nodeFS, readSrsc, skip } from './helpers';

test('Projector Effect inputs: On shows the target on the next update, Off hides it', () => {
  // 1b #7edb: p13 = p16 = 1 (On), p14 = p15 = 2 (Off), p7 = 0.
  const st = new ProjectorState({ strobe: 0, inputs: [1, 2, 2, 1], onAtStart: false });
  assert.deepEqual(st.tick(), { run: false }, 'off until On');
  assert.equal(st.message(1).length, 2, 'On runs p13 and p16');
  assert.deepEqual(st.tick(), { show: true, run: true }, 'the first update shows the target');
  assert.deepEqual(st.tick(), { run: true }, 'then it stays shown (p7 = 0)');
  // Off: p14 (updates off, opacity 1, shown) then p15 (hidden, disabled).
  assert.deepEqual(st.message(2), [{ show: true, opacity: 1, run: false }, { show: false, run: false }]);
  assert.deepEqual(st.tick(), { run: false });
  // On again starts over.
  st.message(1);
  assert.deepEqual(st.tick(), { show: true, run: true });
});

test('Projector Effect strobe p7: shown one update in p7', () => {
  const st = new ProjectorState({ strobe: 3, inputs: [1, 2, 2, 1], onAtStart: true });
  st.message(1);
  const seen = Array.from({ length: 7 }, () => st.tick().show);
  assert.deepEqual(seen, [true, false, false, true, false, false, true]);
});

test('Projector Effect opacity: p6 + (p5 - p6) x f + U(-1, 1) x p4, clamped', () => {
  const p = { flicker: 50, high: 40, low: 0 }; // 1b
  assert.equal(projectorOpacity(p, 1, 0), 0.4);
  assert.equal(projectorOpacity(p, 1, 1), 0.9);
  assert.equal(projectorOpacity(p, 1, -1), 0);
  assert.ok(Math.abs(projectorOpacity({ flicker: 35, high: 55, low: 0 }, 0.6, 0) - 0.33) < 1e-9);
  assert.equal(projectorOpacity({ flicker: 0, high: 100, low: 0 }, 2, 1), 1, 'f clamps to 1');
});

test('a skinned vertex placed for its bone lands on the lens after skinning', () => {
  const bind = new THREE.Matrix4().compose(new THREE.Vector3(0.6, 1.7, 0.5), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
  const inverse = bind.clone().invert();
  // The bone posed elsewhere, under an object turned and moved in the world.
  const object = new THREE.Matrix4().compose(new THREE.Vector3(473.9, 81.65, 497.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.2, 0)), new THREE.Vector3(1, 1, 1));
  const posed = object.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0.5, 1.6, 0.4), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0.1)), new THREE.Vector3(1, 1, 1)));
  const lens = new THREE.Vector3(475.2, 82.9, 497.8);
  const v = skinnedVertexFor(lens, posed, inverse);
  const skinned = v.clone().applyMatrix4(posed.clone().multiply(inverse));
  assert.ok(skinned.distanceTo(lens) < 1e-4, `lands at ${skinned.toArray()}`);
});

const L1B = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';

test('1b: Killjoy is a hidden, projected figure; his model carries five light cones', { skip }, async () => {
  const lvl = readSrsc(L1B);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1B), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const by = new Map(parseEntities(lvl, pkgs, { resolveStrings: false }).map((e) => [e.uid, e]));
  const fx = by.get(0x7edb)!;
  assert.equal(fx.className, 'Projector Effect');
  const p = projectorParams(fx.values);
  assert.equal(p.target, 0x7eb5);
  assert.deepEqual([p.flicker, p.high, p.low, p.strobe], [50, 40, 0, 0]);
  assert.deepEqual(p.units, [0x7eba, 0x7eba, 0x7eba, 0x7eba, 0x7eba]);
  assert.deepEqual(p.lenses, [5, 5, 5, 5, 5]);
  assert.deepEqual([...p.vertices].sort(), [0, 1, 2, 3, 4]);
  const kj = by.get(0x7eb5)!;
  assert.equal(kj.className, 'Killjoy');
  assert.equal(kj.flags & 1, 0, 'hidden at start: only the effect shows him');
  assert.equal(by.get(0x7eba)!.className, 'Animating Static', 'the projector');

  // Model 10:90: the cone tips are skeleton vertices 0..4, each on its own bone 86..90 at full
  // weight, in the additive cone submesh (0); the body passes are tinted (drawn unlit).
  const sk = readSkinnedModel(pkgs as unknown as PackageSet, kj.modelRef!)!;
  const cones = new Set(sk.model.submeshes[0].indices);
  const tipBones = new Set<number>();
  for (const sv of [0, 1, 2, 3, 4]) {
    const c = [...sk.model.source].indexOf(sv);
    assert.ok(cones.has(c), `vertex ${sv} is in the cone submesh`);
    assert.equal(sk.skinWeight[4 * c], 1);
    tipBones.add(sk.skinIndex[4 * c]);
  }
  assert.deepEqual([...tipBones].sort(), [86, 87, 88, 89, 90]);
  const mats = sk.model.submeshes.map((s) => s.material!);
  assert.equal(mats[0].layers[0].tint, 0x2d2d2d);
  for (const i of [2, 3, 4]) assert.equal(mats[i].layers[0].tint, 0x414141);
  assert.deepEqual(mats.map(characterSurfaceBlend), [true, false, true, true, true], 'tinted and blended passes take the surface material');
  // Every pass of those is decoded (the additive second pass 10:428 drew the placeholder).
  const tex = decodeCharacterTextures(sk, pkgs as unknown as PackageSet);
  for (const k of ['10:256', '10:232', '10:233', '10:234', '10:428']) assert.ok(tex.has(k), k);
});
