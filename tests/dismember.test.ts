// Dismemberment: Part Caps (src/game/actors/dismember.ts, docs/game-logic.md §15.16), decoded
// from Suffering.rfl 0x10119150 (the blow), 0x10118dd0 (the cut), 0x10118680 (the bleed),
// 0x10119690 (parts cut at creation). Rules on synthetic values; the retail census when the game
// data is there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  capAllows,
  capFor,
  channelOf,
  corpseCutReputation,
  cutChance,
  cutRoll,
  descendantsOf,
  Dismemberment,
  nearestSphere,
  readPartCap,
  readPartCapRef,
  type PartActor,
  type PartCapRule,
} from '../src/game/actors/dismember';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDbId } from '../src/formats/model';
import type { EntityPackage } from '../src/formats/entities';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

function loadAllPackages(): Map<number, EntityPackage> {
  const pk = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`) } as EntityPackage);
  }
  return pk;
}

/** 10:865, the guards' head cap: p1 48, bleed 500, p6 3.9, 40..70 % at 15, health <= 100 %. */
const HEAD = readPartCap([{ pkg: 10, id: 103 }, 48, 500, 0, 5, -2, 3.9, 40, 15, 70, 100, 100, 2, 1, [], [], { pkg: 4, id: 1255 }, { pkg: 3, id: 2814 }]);
/** 10:904, the guards' left forearm: p1 12, bleed 20, 35..70 % at 15, health <= 60 %. */
const ARM = readPartCap([{ pkg: 10, id: 76 }, 12, 20, 0, 5, -2, 3.9, 35, 15, 70, 60, 100, 1, 1, [], [], { pkg: 4, id: 1280 }, { pkg: 3, id: 2778 }]);
/** 10:866, the guards' chest: types 12 / 1 / 10 / 2 / 5 cannot cut (p13 1). */
const CHEST = readPartCap([{ pkg: 10, id: 106 }, 6, 500, 0, 5, -2, 3.9, 40, 15, 70, 100, 100, 1, 1, [12, 1, 10, 2, 5], [], null, { pkg: 3, id: 2835 }]);
/** 10:870, the pelvis: threshold 1e10, p13 0 with no types: never by a blow (only created cut). */
const PELVIS = readPartCap([{ pkg: 10, id: 107 }, 55, 500, 0, 5, -2, 1e10, 0, 15, 70, 100, 100, 2, 0, [], [], null, null]);

test('Part Cap values: p1 bone, p2 bleed, p4 / p5 corpse rule, p6 threshold, p7..p11 chance, p13 / p14 types', () => {
  assert.equal(HEAD.bone, 48);
  assert.equal(HEAD.bleed, 500);
  assert.deepEqual([HEAD.corpseDelay, HEAD.reputation], [5, -2]);
  assert.deepEqual([HEAD.chanceMin, HEAD.fullAt, HEAD.chanceMax, HEAD.healthPct, HEAD.healthWeight], [40, 15, 70, 100, 100]);
  assert.deepEqual(HEAD.capModel, { pkg: 10, id: 103 });
  assert.deepEqual(CHEST.types, [12, 1, 10, 2, 5]);
  assert.equal(capFor([ARM, HEAD, CHEST], 48), HEAD, 'the first p16 cap on the struck channel');
  assert.equal(capFor([ARM, HEAD], 30), undefined);
});

test('the blow (0x10119150): amount > 0 and >= p6, health % <= p10, p13 XOR listed type, p15 attacks', () => {
  const blow = (amount: number, type?: number, attack?: string) => ({ amount, type, attack });
  assert.equal(capAllows(HEAD, blow(6, 1), 100, 100), true, 'a revolver bullet may take the head at full health');
  assert.equal(capAllows(HEAD, blow(3.8, 1), 100, 100), false, 'below p6 (3.9)');
  assert.equal(capAllows(HEAD, blow(0, 1), 0, 100), false, 'no damage, no cut');
  assert.equal(capAllows(ARM, blow(20, 13), 61, 100), false, 'the arm only at 60 % health or less');
  assert.equal(capAllows(ARM, blow(20, 13), 60, 100), true);
  assert.equal(capAllows(ARM, blow(20, 13), -20, 100), true, 'a corpse (health <= 0) always passes the health test');
  assert.equal(capAllows(CHEST, blow(20, 1), 50, 100), false, 'bullets (1) cannot open the chest');
  assert.equal(capAllows(CHEST, blow(20, 13), 50, 100), true, 'the shotgun (13) can');
  assert.equal(capAllows(CHEST, blow(35, 8), 50, 100), true, 'the creature claws (8) can');
  assert.equal(capAllows(PELVIS, blow(1e6, 3), 0, 100), false, 'p13 0 with no listed type: never');
  const only = { ...ARM, typeMode: 0, types: [11] };
  assert.equal(capAllows(only, blow(20, 11), 50, 100), true, 'p13 0: only the listed types (Torque 2:675, type 11)');
  assert.equal(capAllows(only, blow(20, 1), 50, 100), false);
  const special = { ...ARM, attacks: ['2:923'] };
  assert.equal(capAllows(special, blow(20, 1), 50, 100), false, 'p15: the attacker must be in one of its attacks');
  assert.equal(capAllows(special, blow(20, 1, '2:923'), 50, 100), true);
});

test('cut chance (%): (p7 + (p9 - p7) min(amount / p8, 1)) x (p11 + (100 - p11)(p10 - health) / p10) / 100', () => {
  assert.equal(cutChance(HEAD, 6, 100), 40 + 30 * 0.4, 'a revolver round (6) at the head: 52 %');
  assert.equal(cutChance(HEAD, 20, 100), 70, 'from p8 (15) on: p9');
  assert.equal(cutChance(ARM, 7.5, 50), 52.5);
  const weighted = { ...ARM, healthWeight: 0 };
  assert.equal(cutChance(weighted, 15, 30), 70 * (30 / 60), 'p11 0: scaled by how far below p10 the health is');
  assert.equal(cutRoll(HEAD, 6, 100, 0.51), true, 'roll x 100 below the chance cuts');
  assert.equal(cutRoll(HEAD, 6, 100, 0.52), false);
});

test('corpse rule (0x10119617): the player cutting a body dead more than p4 s pays p5', () => {
  assert.equal(corpseCutReputation(HEAD, true, 5.5), -2);
  assert.equal(corpseCutReputation(HEAD, true, 5), 0, 'not before p4 has passed');
  assert.equal(corpseCutReputation(HEAD, true, undefined), 0, 'alive');
  assert.equal(corpseCutReputation(HEAD, false, 100), 0, "someone else's cut");
});

test('skeleton helpers: channel of a bone, descendants, nearest hit sphere', () => {
  // 0 root - 1 spine - 2 shoulder - 3 arm - 4 hand; 1 - 5 neck - 6 head
  const parents = [-1, 0, 1, 2, 3, 1, 5];
  const ch = new Set([0, 1, 3, 5]);
  assert.equal(channelOf(parents, ch, 4), 3, 'the hand has no channel: its arm');
  assert.equal(channelOf(parents, ch, 3), 3);
  assert.equal(channelOf(parents, ch, 6), 5);
  assert.equal(channelOf(parents, new Set(), 6), -1);
  assert.deepEqual(descendantsOf(parents, 3), [4]);
  assert.deepEqual(descendantsOf(parents, 1).sort(), [2, 3, 4, 5, 6]);
  assert.equal(nearestSphere([{ c: [0, 0, 0], r: 0.5 }, { c: [0, 2, 0], r: 0.1 }], { x: 0, y: 1.8, z: 0 }), 1);
  assert.equal(nearestSphere([], { x: 0, y: 0, z: 0 }), -1);
});

// --- the runtime on a synthetic body -------------------------------------------------------

function body(alive = true) {
  // 0 root, 1 chest, 2 neck (cap bone), 3 head, 4 hat; 1 - 5 upper arm (cap), 6 forearm, 7 hand
  const parents = [-1, 0, 1, 2, 3, 1, 5, 6];
  const bones = parents.map(() => new THREE.Bone());
  parents.forEach((p, i) => p >= 0 && bones[p].add(bones[i]));
  const root = new THREE.Group();
  root.add(bones[0]);
  new THREE.Scene().add(root);
  bones[2].position.set(0, 1.6, 0);
  bones[5].position.set(0.3, 1.4, 0);
  const skeleton = new THREE.Skeleton(bones);
  const a: PartActor & { hooks: (() => void)[] } = {
    ch: { skeleton, root, mesh: root, poseHooks: [] as never[] },
    alive,
    health: alive ? 100 : -5,
    maxHealth: 100,
    uid: 0x781c,
    position: { x: 0, y: 0, z: 0 },
    hooks: [],
  };
  return { a, parents, bones };
}

function runtime(now: { t: number }) {
  const spawned: string[] = [];
  const rep: number[] = [];
  const parts = new Dismemberment({
    time: () => now.t,
    spawn: (r) => void spawned.push(`${r.pkg}:${r.id}`),
    buildCap: () => new THREE.Group(),
    // One sphere per cap bone where its channel is.
    spheres: () => [
      { c: [0, 1.7, 0], r: 0.15, bone: 3 },
      { c: [0.4, 1.3, 0], r: 0.1, bone: 6 },
    ],
    addReputation: (p) => void rep.push(p),
    log: () => {},
    rand: () => 0,
  });
  return { parts, spawned, rep };
}

const NECK = { ...HEAD, bone: 2 };
const UPPER = { ...ARM, bone: 5 };

test('runtime: a head shot cuts the neck cap; the head hides, the stump spurts, the part flies, the body bleeds', () => {
  const now = { t: 0 };
  const { parts, spawned } = runtime(now);
  const { a, parents, bones } = body();
  parts.setup(a, [UPPER, NECK], parents, [0, 2, 5]);
  assert.equal(a.cuttable, true);
  // A sphere on bone 3 (the head) maps to the channel of bone 2 (its nearest channel up).
  const r = parts.hit(a, { amount: 20, type: 1, point: { x: 0, y: 1.72, z: 0 }, from: { x: 0, y: 1.7, z: 5 }, byPlayer: true });
  assert.equal(r?.bone, 2);
  assert.ok(bones[3].scale.x < 1e-3, 'the cut bone keeps its scale, its children are collapsed');
  assert.equal(bones[2].scale.x, 1);
  assert.deepEqual([...(a.brokenParts ?? [])].sort(), [3, 4], 'what rides the head goes (the hat on bone 4)');
  assert.deepEqual(spawned.sort(), ['3:2814', '4:1255'], 'p17 severed part and p16 spurt');
  assert.equal(bones[2].children.some((c) => c.name.startsWith('part-cap')), true, 'the cap model rides the cut bone');
  assert.equal(parts.bleeding(a), true);
  let bled = 0;
  parts.update(0.1, (_x, amount, byPlayer) => {
    bled += amount;
    assert.equal(byPlayer, true, "the player's cut: the bleed is his (the kill counts as his)");
  });
  assert.equal(bled, 50, 'p2 500 / s');
  // The same channel again: already cut.
  assert.equal(parts.hit(a, { amount: 20, point: { x: 0, y: 1.72, z: 0 }, byPlayer: true }), undefined);
});

test('runtime: the arm only below p10 health; no point (a radius blow): no cut', () => {
  const now = { t: 0 };
  const { parts } = runtime(now);
  const { a, parents } = body();
  parts.setup(a, [UPPER, NECK], parents, [0, 2, 5]);
  assert.equal(parts.hit(a, { amount: 20, point: { x: 0.4, y: 1.3, z: 0 }, byPlayer: true }), undefined, 'at 100 % health the arm stays');
  a.health = 40;
  assert.equal(parts.hit(a, { amount: 20, byPlayer: true }), undefined, 'radius damage: no hit sphere');
  assert.equal(parts.hit(a, { amount: 20, point: { x: 0.4, y: 1.3, z: 0 }, byPlayer: true })?.bone, 5);
});

test('runtime: cutting a corpse pays p5 only after p4 s; parts cut at creation (p17, p18 0) bleed but spawn nothing', () => {
  const now = { t: 0 };
  const { parts, rep, spawned } = runtime(now);
  const { a, parents } = body(false);
  parts.setup(a, [UPPER, NECK], parents, [0, 2, 5]);
  parts.died(a);
  now.t = 3;
  parts.hit(a, { amount: 20, point: { x: 0.4, y: 1.3, z: 0 }, byPlayer: true });
  assert.deepEqual(rep, [], 'dead 3 s: nothing');
  now.t = 9;
  parts.hit(a, { amount: 20, point: { x: 0, y: 1.72, z: 0 }, byPlayer: true });
  assert.deepEqual(rep, [-2], 'dead 9 s: p5');
  let bled = 0;
  parts.update(1, () => (bled += 1));
  assert.equal(bled, 0, 'a corpse does not bleed');
  assert.equal(a.cuttable, false, 'nothing left to cut');

  const b = body();
  const before = spawned.length;
  parts.setup(b.a, [UPPER, NECK], b.parents, [0, 2, 5], [NECK]);
  assert.equal(spawned.length, before, 'created cut: no spurt, no part');
  assert.ok(b.bones[3].scale.x < 1e-3);
  assert.deepEqual(parts.cutBones(b.a), [2]);
  assert.equal(parts.bleeding(b.a), true, 'its p2 is added (0x10118dd0 runs for both)');
});

test('runtime: cuts survive a save', () => {
  const now = { t: 0 };
  const { parts } = runtime(now);
  const { a, parents } = body();
  parts.setup(a, [UPPER, NECK], parents, [0, 2, 5]);
  a.health = 40;
  parts.hit(a, { amount: 20, point: { x: 0.4, y: 1.3, z: 0 }, byPlayer: true });
  const saved = JSON.parse(JSON.stringify(parts.save()));
  assert.deepEqual(saved.a[0].slice(0, 4), [0x781c, [5], 20, 1]);
  const r = runtime(now);
  const b = body();
  r.parts.setup(b.a, [UPPER, NECK], b.parents, [0, 2, 5]);
  r.parts.load(saved, () => b.a);
  assert.deepEqual(r.parts.cutBones(b.a), [5]);
  assert.ok(b.bones[6].scale.x < 1e-3);
  assert.equal(r.parts.bleeding(b.a), true);
});

test('retail Part Caps: humans lose heads to any blow of 3.9, arms below 60 %, torsos not to bullets', { skip }, () => {
  const pk = loadAllPackages();
  const cap = (id: number) => readPartCapRef(pk, { pkg: 10, id }) as PartCapRule;
  const head = cap(865), arm = cap(904), chest = cap(866), pelvis = cap(870);
  assert.deepEqual([head.bone, head.bleed, head.minDamage, head.healthPct, head.corpseDelay, head.reputation], [48, 500, 3.9000000953674316, 100, 5, -2]);
  assert.deepEqual([arm.bone, arm.bleed, arm.healthPct, arm.chanceMin, arm.chanceMax, arm.fullAt], [12, 20, 60, 35, 70, 15]);
  assert.deepEqual(chest.types, [12, 1, 10, 2, 5]);
  assert.equal(capAllows(pelvis, { amount: 1e6, type: 3 }, 0, 100), false, 'the pelvis caps are only for placed bodies');
  assert.equal(readPartCapRef(pk, { pkg: 10, id: 3 }), undefined, 'a Character is no Part Cap');
});

test('runtime: a body removed from the level is forgotten (no bleed, its caps go)', () => {
  const now = { t: 0 };
  const { parts } = runtime(now);
  const { a, parents, bones } = body();
  parts.setup(a, [UPPER, NECK], parents, [0, 2, 5], [NECK]);
  assert.equal(bones[2].children.some((c) => c.name.startsWith('part-cap')), true);
  a.ch.root.removeFromParent();
  let bled = 0;
  parts.update(0.1, () => (bled += 1));
  assert.equal(bled, 0);
  assert.equal(parts.bleeding(a), false);
  assert.equal(bones[2].children.some((c) => c.name.startsWith('part-cap')), false);
});
