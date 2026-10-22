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

test('the blow (0x10119150): amount > 0 and >= p6, health % <= p10, p13 XOR listed type, p15 attacker classes', () => {
  const blow = (amount: number, type?: number, attackerClass?: string) => ({ amount, type, attackerClass });
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
  const special = { ...ARM, attackers: ['CartWheeler'] };
  assert.equal(capAllows(special, blow(20, 1), 50, 100), false, 'p15: the attacker must be of a listed class');
  assert.equal(capAllows(special, blow(20, 1, 'Fester'), 50, 100), false);
  assert.equal(capAllows(special, blow(20, 1, 'CartWheeler'), 50, 100), true);
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
  assert.deepEqual([...(a.brokenParts ?? [])].sort(), [2, 3, 4], 'what rides the cut bone and its subtree goes (the hat on bone 4)');
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

// --- what node flag 0x10 hides, regrowth, CapLimb, the bleed's readers ---------------------

import {
  bleedsOutBeforeUp,
  faceSegments,
  goneBones,
  keptTriangles,
  segmentBonesOf,
  templateClass,
} from '../src/game/actors/dismember';
import { readSkeletonTrailer } from '../src/formats/skeleton';
import { ANIM_EVENT_MESSAGE, readAnimEvents } from '../src/formats/animation';
import { readSkeleton } from '../src/formats/skeleton';
import { spreadShotHits, spreadShotPoint } from '../src/game/actors/actor';
import { decodeTemplateProps, readObjectTemplate, classByHash } from '../src/formats/entities';

test('node flag 0x10: the cut bone and its subtree; the renderer hides the bit channels among them', () => {
  // 0 root, 1 chest, 2 neck, 3 head, 4 hat; 1 - 5 upper arm, 6 forearm, 7 hand
  const parents = [-1, 0, 1, 2, 3, 1, 5, 6];
  assert.deepEqual([...goneBones(parents, [2])].sort(), [2, 3, 4], 'the cut bone itself too (request 0x100010 on its node)');
  assert.deepEqual([...goneBones(parents, [5, 2])].sort(), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(segmentBonesOf([{ bone: 0, bits: [0, 0] }, { bone: 2, bits: [0x40, 0x40] }, { bone: 6, bits: [4] }]), [2, 6], 'channels with an LOD-0 bit');
  // Triangles by the heaviest bone of their corners, up to the nearest segment bone.
  const segs = new Set([2, 6]);
  const skinIndex = [1, 0, 0, 0, 3, 0, 0, 0, 2, 1, 0, 0, 7, 0, 0, 0, 5, 0, 0, 0];
  const skinWeight = [1, 0, 0, 0, 1, 0, 0, 0, 0.6, 0.4, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  // v0 chest (trunk), v1 head (seg 2), v2 neck (seg 2), v3 hand (seg 6), v4 upper arm (trunk)
  const index = [0, 1, 2, 1, 2, 2, 3, 3, 4, 0, 0, 4];
  const seg = faceSegments(index, skinIndex, skinWeight, parents, segs);
  assert.deepEqual([...seg], [2, 2, 6, -1], 'corner majority (ties: the first corner)');
  const k = keptTriangles(index, [{ start: 0, count: 6, materialIndex: 0 }, { start: 6, count: 6, materialIndex: 1 }], seg, new Set([2]));
  assert.deepEqual([...k.index], [3, 3, 4, 0, 0, 4]);
  assert.deepEqual(k.groups, [{ start: 0, count: 0, materialIndex: 0 }, { start: 0, count: 6, materialIndex: 1 }]);
});

/** A skinned body (8 bones as body()) with one triangle per bone, weighted to it. */
function skinnedBody() {
  const b = body();
  const n = 8;
  const pos: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.push(i, 0, 0, i, 1, 0, i, 0, 1);
    for (let c = 0; c < 3; c++) si.push(i, 0, 0, 0), sw.push(1, 0, 0, 0);
    idx.push(3 * i, 3 * i + 1, 3 * i + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.addGroup(0, idx.length, 0);
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  b.a.ch.root.add(mesh);
  (b.a.ch as { mesh: THREE.Object3D }).mesh = mesh;
  return { ...b, mesh, base: g };
}

const tris = (m: THREE.Mesh) => (m.geometry.index?.count ?? 0) / 3;

test('runtime (bit channels): the cut segments vanish from the actor\'s own index; spheres on cut bones are not struck', () => {
  const now = { t: 0 };
  const { parts } = runtime(now);
  const { a, parents, mesh, base, bones } = skinnedBody();
  // Segments: neck 2, head 3, forearm 6 (the bones with channel bits).
  parts.setup(a, [UPPER, NECK], parents, [0, 2, 5], [], [2, 3, 6]);
  assert.equal(tris(mesh), 8);
  parts.hit(a, { amount: 20, type: 1, point: { x: 0, y: 1.72, z: 0 }, byPlayer: true });
  assert.deepEqual(parts.cutBones(a), [2]);
  assert.equal(tris(mesh), 5, 'the neck, head and hat triangles are gone (the hat, bone 4, is in the head segment)');
  assert.equal(mesh.geometry.getAttribute('position'), base.getAttribute('position'), 'the vertex buffers stay shared');
  assert.equal(base.index!.count, 24, 'the shared geometry keeps every triangle');
  assert.equal(bones[3].scale.x, 1, 'no bone is scaled in this mode');
  assert.equal(parts.isGone(a, 3), true);
  // The head sphere is on a cut bone: a blow there finds the arm's sphere (the nearest left).
  a.health = 40;
  assert.equal(parts.hit(a, { amount: 20, point: { x: 0, y: 1.72, z: 0 }, byPlayer: true })?.bone, 5);
  assert.equal(tris(mesh), 3, 'the forearm segment (6: forearm and hand) under the upper-arm cap goes as well; the upper arm stays');
});

test('regrowth (0x101189e0 from the resurrection): p3 caps come back, the others stay, the bleed stops', () => {
  const now = { t: 0 };
  const { parts } = runtime(now);
  const { a, parents, mesh, bones } = skinnedBody();
  const NECK3 = { ...NECK, regrow: true };
  parts.setup(a, [UPPER, NECK3], parents, [0, 2, 5], [], [2, 3, 6]);
  a.health = 40;
  parts.hit(a, { amount: 20, point: { x: 0, y: 1.72, z: 0 }, byPlayer: true });
  parts.hit(a, { amount: 20, point: { x: 0.4, y: 1.3, z: 0 }, byPlayer: true });
  assert.deepEqual(parts.cutBones(a), [2, 5]);
  assert.equal(parts.bleeding(a), true);
  assert.equal(parts.regrow(a), 1);
  assert.deepEqual(parts.cutBones(a), [5], 'the arm cap has p3 0');
  assert.equal(parts.bleeding(a), false, 'bleed 0 (0x100eda3d)');
  assert.equal(parts.bleedByPlayer(a), false, 'flag 2 cleared');
  assert.equal(bones[2].children.some((c) => c.name.startsWith('part-cap')), false, 'the cap object goes');
  assert.equal(tris(mesh), 6, 'the head is back; the forearm and hand stay off');
  assert.deepEqual([...(a.brokenParts ?? [])].sort(), [5, 6, 7], 'the hat shows again');
  assert.equal(a.cuttable, true, 'the head can be cut again');
});

test('regrowth on the stand-in rigs (no bit channels): the scaled bones come back', () => {
  const now = { t: 0 };
  const { parts } = runtime(now);
  const { a, parents, bones } = body();
  parts.setup(a, [{ ...NECK, regrow: true }], parents, [0, 2, 5]);
  parts.hit(a, { amount: 20, point: { x: 0, y: 1.72, z: 0 }, byPlayer: false });
  assert.ok(bones[3].scale.x < 1e-3);
  parts.regrow(a);
  assert.equal(bones[3].scale.x, 1);
});

test('CapLimb (451): by bone (no blow test) or the p17 list; clip events fire at their time', () => {
  const now = { t: 0 };
  const { parts, spawned } = runtime(now);
  const { a, parents } = body();
  const NEVER = { ...NECK, minDamage: 1e9 };
  parts.setup(a, [UPPER, NEVER], parents, [0, 2, 5], [UPPER], [], false);
  assert.deepEqual(parts.cutBones(a), [], 'p18 != 0: p17 is not cut at creation');
  assert.equal(parts.hit(a, { amount: 1e6, point: { x: 0, y: 1.72, z: 0 }, byPlayer: false }), undefined, 'p6 1e9: no blow');
  parts.schedule(a, [{ time: 0.5, bone: 2 }]);
  parts.update(0.1, () => {});
  assert.deepEqual(parts.cutBones(a), []);
  now.t = 0.6;
  parts.update(0.1, () => {});
  assert.deepEqual(parts.cutBones(a), [2], 'the event cut the neck by bone');
  assert.ok(spawned.includes('4:1255'), 'with its spurt');
  assert.equal(parts.capLimb(a), 1, 'no bone: the p17 list');
  assert.deepEqual(parts.cutBones(a), [2, 5]);
});

test('the bleed: a knocked-down body that would bleed out while getting up dies down (0x100ef7a8)', () => {
  assert.equal(bleedsOutBeforeUp(30, 20, 2), true, '30 <= 20 x 2');
  assert.equal(bleedsOutBeforeUp(50, 20, 2), false);
  assert.equal(bleedsOutBeforeUp(30, 0, 2), false, 'not bleeding');
});

test('NPC shots carry a hit point: the deflected round where spreadShotHits tests it', () => {
  const muzzle = { x: 0, y: 1.5, z: 0 }, aim = { x: 0, y: 1.5, z: -10 };
  for (const [u1, u2] of [[0, 0], [0.5, 0.25], [0.9, 0.6]]) {
    const p = spreadShotPoint(muzzle, aim, 3, 10, u1, u2);
    const off = Math.hypot(p.x - aim.x, p.y - aim.y);
    assert.ok(Math.abs(off - 10 * Math.tan((u1 * 3 * Math.PI) / 180)) < 1e-9);
    const hits = spreadShotHits(3, 10, 0.35, 0.9, u1, u2);
    assert.equal(hits, Math.abs(p.x - aim.x) <= 0.35 && Math.abs(p.y - aim.y) <= 0.9);
  }
});

test('retail: the bit channels are the capped segments; Torque\'s caps; the Slayer death clip carries CapLimb', { skip }, () => {
  const pk = loadAllPackages() as never;
  const mdu = readSrsc('COMMON/NPCs/NPCs.mdu');
  // Guards (10:3, model 10:22): caps 48 / 12 / 30 / 55 / 6, all bit channels; arms 10 / 32 are not.
  const tr = readSkeletonTrailer(mdu as never, 22)!;
  assert.deepEqual(segmentBonesOf(tr.channels), [6, 7, 12, 14, 30, 32, 48, 49, 55, 60, 61, 62]);
  // Torque's p15: the class of 2:923 / 2:922.
  assert.equal(templateClass(pk, { pkg: 2, id: 923 }), 'CartWheeler');
  const head = readPartCapRef(pk, { pkg: 2, id: 625 })!, waist = readPartCapRef(pk, { pkg: 2, id: 675 })!;
  assert.deepEqual([head.bone, head.healthPct, head.chanceMin, head.attackers], [48, 20, 100, ['CartWheeler']]);
  assert.deepEqual([waist.bone, waist.typeMode, waist.types, waist.attackers], [2, 0, [11], ['Fester']]);
  assert.equal(capAllows(head, { amount: 5, type: 8, attackerClass: 'CartWheeler' }, 15, 100), true);
  assert.equal(capAllows(head, { amount: 5, type: 8, attackerClass: 'CartWheeler' }, 25, 100), false, 'above 20 %');
  for (const id of [765, 766, 770]) assert.ok(readPartCapRef(pk, { pkg: 2, id })!.minDamage >= 1e9, `2:${id}: no blow`);
  // Player p332 (death by a Slayer) = 2:562; its CapLimb events are on bones 11, 31, 48.
  const t = readObjectTemplate(pk, { pkg: 2, id: 5 })!;
  const pv = decodeTemplateProps(classByHash(t.classHash)!, t);
  assert.deepEqual(pv[332], { pkg: 2, id: 562 });
  const adu = readSrsc('COMMON/System/System.adu');
  const ev = readAnimEvents(adu as never, 562)!;
  const sk = readSkeleton(readSrsc('COMMON/System/System.mdu') as never, 9)!;
  const bones = ev.events.filter((e) => e.kind === ANIM_EVENT_MESSAGE && e.param === 451).map((e) => sk.byHash.get(e.boneHash)).sort((x, y) => x! - y!);
  assert.deepEqual(bones, [11, 31, 48]);
});
