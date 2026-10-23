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
import { readSkeletonTrailer, readSkinnedModel } from '../src/formats/skeleton';
import { BLEND_ALPHA_REF, modelCullsBackFaces, translucentPassState } from '../src/formats/render-data';
import type { PackageSet } from '../src/formats/model';
import { buildSkinnedMesh, characterAlphaTest, characterSurfaceBlend, decodeCharacterTextures } from '../src/app/character';
import { beamHidden, beamTriangles, projectorOpacity, projectorParams, ProjectorState, skinnedVertexFor } from '../src/game/actors/specials/projector';
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

test('beam visibility per update: gone hides, standing shows a hidden beam or hides at p8 %', () => {
  assert.equal(beamHidden(false, false, 0, 50), true, 'a gone projector hides its beam');
  assert.equal(beamHidden(true, true, 0, 50), false, 'a standing one shows it again');
  assert.equal(beamHidden(false, true, 0, 0), false, 'p8 = 0 (retail): never flickers');
  assert.equal(beamHidden(false, true, 25, 10), true, 'U(0, 100) < p8 hides it for an update');
  assert.equal(beamHidden(false, true, 25, 40), false);
  assert.equal(beamHidden(true, true, 100, 0), false, 'a hidden beam is always shown next');
});

test('beam triangles: the fan of each tip, disjoint', () => {
  // Two fans: tip 0 with triangles 0, 1; tip 1 with triangle 3; triangle 2 is body.
  const source = [0, 5, 6, 7, 1, 8, 9];
  const index = [0, 1, 2, 2, 3, 0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(beamTriangles(index, source, [1, 0]), [[3], [0, 1]]);
});

test('a translucent object: an opaque first pass blends, keeps its depth write, alpha test > 2', () => {
  const opaque = { transparent: false, depthWrite: true, alphaTest: 0 };
  assert.deepEqual(translucentPassState(opaque, 0.5), { transparent: true, depthWrite: true, alphaTest: BLEND_ALPHA_REF });
  assert.deepEqual(translucentPassState(opaque, 0.99), opaque, 'at 0.99 and above the object draws opaque');
  const additive = { transparent: true, depthWrite: false, alphaTest: BLEND_ALPHA_REF };
  assert.deepEqual(translucentPassState(additive, 0.3), additive, 'a blended first pass never writes depth');
  const cutout = { transparent: false, depthWrite: true, alphaTest: 200 / 255 };
  assert.equal(translucentPassState(cutout, 0.5).alphaTest, 200 / 255);
});

test("Killjoy 10:90: back faces culled; each projector drives and hides the same cone", { skip }, async () => {
  const lvl = readSrsc(L1B);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1B), readLevelHeader(lvl).dependencies, () => {})) as unknown as PackageSet;
  const sk = readSkinnedModel(pkgs, { pkg: 10, id: 90 })!;
  assert.equal(sk.model.headerFlags, 0x1cc8012);
  assert.equal(modelCullsBackFaces(sk.model.headerFlags!), true);
  const { mesh } = buildSkinnedMesh(sk);
  const mats = mesh.material as THREE.Material[];
  assert.ok(mats.every((m) => m.side === THREE.FrontSide), 'every pass culls back faces');
  // The re-wound triangles face the way the stored normals do (front = CCW in three.js).
  const pos = sk.model.positions, nrm = sk.model.normals;
  let agree = 0, total = 0;
  const idx = mesh.geometry.getIndex()!.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(pos, 3 * idx[t]);
    b.fromArray(pos, 3 * idx[t + 1]).sub(a);
    c.fromArray(pos, 3 * idx[t + 2]).sub(a);
    const g = b.cross(c);
    if (g.lengthSq() < 1e-12) continue;
    n.set(0, 0, 0);
    for (let k = 0; k < 3; k++) n.add(new THREE.Vector3().fromArray(nrm, 3 * idx[t + k]));
    total++;
    if (g.dot(n) > 0) agree++;
  }
  assert.ok(agree / total > 0.95, `front faces agree with the normals: ${agree} / ${total}`);
  // The cones lie in the face list in the order of tips 2, 0, 4, 3, 1 (every Killjoy projector's
  // p12) and channels 86..90 carry partition bits 1, 2, 4, 8, 0x10: projector i hides cone i.
  const cones = sk.model.submeshes[0].indices;
  const order: number[] = [];
  for (const ci of cones) {
    const sv = sk.model.source[ci];
    if (sv < 5 && !order.includes(sv)) order.push(sv);
  }
  assert.deepEqual(order, [2, 0, 4, 3, 1]);
  const ch = readSkeletonTrailer(pkgs.get(10)!.mdu!, 90)!.channels.filter((x) => x.bone >= 86 && x.bone <= 90);
  assert.deepEqual(ch.map((x) => [x.bone, x.bits[0]]), [[86, 1], [87, 2], [88, 4], [89, 8], [90, 0x10]]);
  // Each beam is its tip's fan: five disjoint, non-empty triangle sets inside the cone submesh.
  const beams = beamTriangles(idx, sk.model.source, [2, 0, 4, 3, 1]);
  const all = new Set<number>();
  for (const bt of beams) {
    assert.ok(bt.length > 90, `a cone of ${bt.length} triangles`);
    for (const t of bt) {
      assert.ok(!all.has(t));
      all.add(t);
      assert.ok(3 * t < cones.length, 'in the cone submesh');
    }
  }
});

test('projectors without a model (1c, 10, 5b): the beam starts at their placement', { skip }, async () => {
  // Breakables 7:330 carry no model: the engine's beam uses the object position (+0x44).
  const L1C = 'LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl';
  const lvl = readSrsc(L1C);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1C), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const by = new Map(parseEntities(lvl, pkgs, { resolveStrings: false }).map((e) => [e.uid, e]));
  const p = projectorParams(by.get(0x7aba)!.values);
  assert.equal(p.target, 0x7ab8);
  const u = by.get(p.units[0])!;
  assert.equal(u.className, 'Breakable');
  assert.equal(u.modelRef, undefined, 'no model, no lens bone');
  assert.equal(p.beamFlicker, 0);
});

test("6a's figure 10:196: its cones' cut-out pass 2:904 (alpha 0) is discarded, not drawn black", { skip }, async () => {
  const L6A = 'LEVELS/6 Woods/6a Woods.lvl';
  const lvl = readSrsc(L6A);
  const pkgs = (await loadPackages(nodeFS(), dirname(L6A), readLevelHeader(lvl).dependencies, () => {})) as unknown as PackageSet;
  const sk = readSkinnedModel(pkgs, { pkg: 10, id: 196 })!;
  const cones = sk.model.submeshes[0];
  assert.equal(cones.material?.key, '2:904');
  assert.equal(characterAlphaTest(cones.material, false), 200 / 255);
  const tex = decodeCharacterTextures(sk, pkgs).get('2:164');
  if (tex) {
    let maxA = 0;
    for (let i = 3; i < tex.rgba.length; i += 4) maxA = Math.max(maxA, tex.rgba[i]);
    assert.ok(maxA <= 200, `texture alpha up to ${maxA}`);
  }
  assert.equal(characterAlphaTest(sk.model.submeshes[1].material, false), 0, 'the opaque body has no test');
});
