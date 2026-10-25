// Creature-form blows and what they do to a body (docs/game-logic.md §13.9 "What the blow
// carries", §15.16): the claws are swept against the target's leaf hit spheres in node index
// order (Suffering.rfl 0x100c9680) and the struck sphere's bone goes with the blow (damage record
// +0x20) to the Part Cap test; the impact force is Melee Weapon p69 x the Attack's p7. A kill by
// the claws (type 8) bursts a body with p117 into its gib generator; spawned debris is lit by the
// first-draw light pass (world/dynamic.ts spawnModel).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strikeTarget, sweepHit, type Vec3 } from '../src/game/insanity/melee';
import { sweepHit as npcSweepHit } from '../src/game/actors/npc-melee';
import { createDamageService, type DamageablePropSet } from '../src/game/world/damage';
import { readInsanityParams } from '../src/game/insanity/params';
import { capAllows, capFor, channelOf, cutChance, readPartCapRef, type PartCapRule } from '../src/game/actors/dismember';
import { corpseBlowKind, readGibRule } from '../src/game/actors/gibs';
import { modelHitSpheres } from '../src/game/fx/gas-system';
import { readSkeleton, readSkeletonTrailer } from '../src/formats/skeleton';
import { readDbId, templateModelRef } from '../src/formats/model';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage } from '../src/formats/entities';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

const R = (pkg: number, id: number) => ({ pkg, id });

test('strike: the first leaf in node index order the claw meets, with its bone', () => {
  // A pelvis sphere listed before the chest; the claw sweeps across at 1.4 m through both.
  const pelvis = { c: [0, 1.25, 0] as Vec3, r: 0.2, bone: 20 }, chest = { c: [0, 1.6, 0] as Vec3, r: 0.25, bone: 3 };
  const cap = { x: 0, z: 0, y0: 0, y1: 1.8, r: 0.4 };
  const a0: Vec3 = [-1.5, 1.4, -0.5], b0: Vec3 = [-0.3, 1.4, -0.5], a1: Vec3 = [-0.5, 1.4, 0], b1: Vec3 = [0.7, 1.4, 0];
  assert.equal(strikeTarget(a0, b0, a1, b1, 0, cap, [pelvis, chest], true)?.bone, 20, 'node order, not depth');
  assert.equal(strikeTarget(a0, b0, a1, b1, 0, cap, [chest, pelvis], true)?.bone, 3);
  // Only the chest in reach (the claw passes at 1.7 m): the chest.
  const hi = (v: Vec3): Vec3 => [v[0], 1.7, v[2]];
  assert.equal(strikeTarget(hi(a0), hi(b0), hi(a1), hi(b1), 0, cap, [pelvis, chest], true)?.bone, 3);
  // The same rule as the NPCs' blades (npc-melee.ts re-exports it).
  assert.equal(npcSweepHit, sweepHit);
  // Spheres are posed only when the claw comes within the slack of the standing capsule.
  let posed = 0;
  const far = { ...cap, x: 5 };
  assert.equal(strikeTarget(a0, b0, a1, b1, 0, far, () => (posed++, [pelvis]), true), null);
  assert.equal(posed, 0, 'out of reach: not posed');
  // No sphere tree: the capsule stands in (no bone); a dead body only by its spheres.
  const noTree = strikeTarget(a0, b0, a1, b1, 0, cap, [], true);
  assert.ok(noTree && noTree.bone === undefined);
  assert.equal(strikeTarget(a0, b0, a1, b1, 0, cap, [], false), null);
  // Leaves met by neither the claw nor its sweep: no blow, even inside the capsule.
  const miss = strikeTarget(a0, b0, a1, b1, 0, cap, [{ c: [0, 0.3, 0], r: 0.1, bone: 22 }], true);
  assert.equal(miss, null);
});

test('damage router: the struck bone and the force go with a point blow, not with a blast', () => {
  const seen: { bone?: number; force?: number; type?: number }[] = [];
  const actor = { position: { x: 0, y: 0, z: 0 }, entity: { uid: 7 } };
  const props: DamageablePropSet = {
    uidOfBody: () => undefined,
    propAt: () => undefined,
    propsNear: () => [],
    has: () => false,
    damage: () => ({ damage: 0, killed: false }),
  } as never;
  const svc = createDamageService(props, () => ({ list: () => [actor], get: () => actor, damage: (_a, _n, _f, _b, hit) => (seen.push(hit ?? {}), false) }) as never);
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 35, kind: 8, force: 20, bone: 3, actor, source: { x: 1, y: 1, z: 0 } });
  assert.deepEqual([seen[0].bone, seen[0].force, seen[0].type], [3, 20, 8]);
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 35, kind: 8, actor });
  assert.equal(seen[1].bone, undefined, 'no bone: the nearest leaf stands in (dismember.ts)');
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 35, kind: 3, radius: 5, bone: 3 });
  assert.equal(seen[2].bone, undefined, 'radius damage strikes no sphere');
});

function packages(): Map<number, EntityPackage> {
  const pk = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), mdu: ld(`${base}.mdu`) } as EntityPackage);
  }
  return pk;
}

test('retail: the claws hit for 35 / 52.5 / 70 with force 20 / 30 / 40 (p69 x Attack p7), type 8', { skip }, () => {
  const p = readInsanityParams(packages())!;
  const c = p.creature!;
  assert.deepEqual(c.armWeapons.map((w) => [w.damage, w.force, w.type]), [[35, 20, 8], [35, 20, 8]]);
  assert.deepEqual(c.attacks!.combo.map((a) => [a.scale, a.forceScale]), [[1, 1], [1, 1], [1, 1], [1, 1], [1.5, 1.5]]);
  // The alternates (p89): 2:360 (clip 2:366, p6 / p7 2), 2:367 (clip 2:370: no Arm marker).
  assert.deepEqual(c.attacks!.alt.map((a) => [`${a.template.pkg}:${a.template.id}`, a.scale, a.forceScale]), [['2:360', 2, 2], ['2:367', 1, 1]]);
});

test('retail: a claw across a CartWheeler or a guard strikes the pelvis first, whose cap no blow takes; kills gib', { skip }, () => {
  const pk = packages();
  const mdu = readSrsc('COMMON/NPCs/NPCs.mdu');
  const values = (r: { pkg: number; id: number }) => {
    const t = readObjectTemplate(pk, r)!;
    return decodeTemplateProps(classByHash(t.classHash)!, t);
  };
  const rules = (r: { pkg: number; id: number }) => ((values(r)[16] as { pkg: number; id: number }[]) ?? []).map((x) => readPartCapRef(pk, x) as PartCapRule);
  for (const [tpl, pelvisBone, gib] of [[R(10, 24), 20, R(3, 2966)], [R(10, 3), 55, R(3, 2834)]] as const) {
    const model = templateModelRef(pk as never, tpl)!;
    const leaves = modelHitSpheres(new Map([[10, { mdu }]]) as never, model, new Map());
    assert.equal(leaves[0].bone, pelvisBone, `${tpl.id}: the first leaf`);
    const tr = readSkeletonTrailer(mdu as never, model.id)!;
    const parents = readSkeleton(mdu as never, model.id)!.bones.map((b) => b.parent);
    const ch = channelOf(parents, new Set(tr.channels.map((c) => c.bone)), pelvisBone);
    const cap = capFor(rules(tpl), ch)!;
    assert.ok(cap.minDamage >= 9e6, `${tpl.id}: the pelvis cap needs a blow of ${cap.minDamage}`);
    assert.equal(capAllows(cap, { amount: 52.5, type: 8 }, 10, 100), false);
    // The killing blow of type 8 bursts the body into p117.
    const g = readGibRule(values(tpl))!;
    assert.deepEqual([g.gib, corpseBlowKind(g, 8, true)], [gib, 'gib']);
  }
  // Higher up the claw meets the CartWheeler's chest (bone 3, cap 10:800): its upper body goes
  // at 50 % or less, 85..100 % (100 % at 35), not to types 12 / 1 / 10 / 2 / 5.
  const waist = capFor(rules(R(10, 24)), 3)!;
  assert.equal(`${waist.ref!.pkg}:${waist.ref!.id}`, '10:800');
  assert.equal(capAllows(waist, { amount: 35, type: 8 }, 13, 48), true);
  assert.equal(capAllows(waist, { amount: 35, type: 8 }, 30, 48), false, 'above 50 %');
  assert.equal(capAllows(waist, { amount: 35, type: 10 }, 13, 48), false, 'the shiv');
  assert.equal(cutChance(waist, 35, 13), 100);
  // A guard's chest (bone 6, 10:866): any health, 40 + 30 x min(35 / 15, 1) = 70 %.
  const chest = capFor(rules(R(10, 3)), 6)!;
  assert.equal(capAllows(chest, { amount: 35, type: 8 }, 50, 50), true);
  assert.equal(cutChance(chest, 35, 50), 70);
});
