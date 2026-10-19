// Decoded parameters of the creature special moves and bosses (src/game/actors/specials,
// docs/game-logic.md §15.7) read from the retail templates. Skipped without game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { decodeTemplateProps, readObjectTemplate, classByHash, type EntityPackage } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';
import {
  blackOneStages,
  burrowerParams,
  festerParams,
  generatorMissile,
  infernaParams,
  mainlinerParams,
  mainlinerVictim,
  noosemanParams,
  repositionParams,
  standBand,
  standScore,
} from '../src/game/actors/specials/params';
import { headDamage, headParams } from '../src/game/actors/specials/head';

let pk: Map<number, EntityPackage> | undefined;
function pkgs() {
  if (pk) return pk;
  pk = new Map();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), adu: ld(`${base}.adu`) } as EntityPackage);
  }
  return pk;
}
const values = (r: ResRef) => {
  const t = readObjectTemplate(pkgs(), r)!;
  return decodeTemplateProps(classByHash(t.classHash), t);
};
const ref = (pkg: number, id: number) => ({ pkg, id });
/** Template floats are float32: compare rounded. */
const r3 = (x: unknown): unknown => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : Array.isArray(x) ? x.map(r3) : x);

test('Black One: three stages, heart, attacks and missiles', { skip }, () => {
  const s = blackOneStages(pkgs(), ref(10, 1024));
  assert.deepEqual(s.map((x) => `${x.ref.pkg}:${x.ref.id}`), ['10:1024', '10:1699', '10:1700']);
  assert.deepEqual(s.map((x) => x.stageHealth), [100, 80, 60]);
  assert.deepEqual(s[0].nearTimer, [30, 40]);
  assert.equal(s[0].nearRadius, 15);
  assert.equal(s[0].heartBone, 5);
  assert.deepEqual(s[0].heart, ref(10, 1563));
  assert.equal(s[0].msg.died, 19);
  assert.equal(s[0].blowDamage, 20);
  const slots = new Set(s[0].attacks.map((a) => a.slot));
  assert.deepEqual([...slots].sort(), [0, 2, 3, 4, 5]);
  const melee = s[0].attacks.find((a) => a.ref.id === 1847)!;
  assert.deepEqual([melee.range, melee.arc], [[0, 6], [-90, 90]]);
  const fire = generatorMissile(pkgs(), s[0].fireball)!;
  assert.ok(Math.abs(fire.speed - 31.25) < 0.01);
  // Radius Damage p5 is the radius (p2 / p3 are impact force, RFL 0x10125c70).
  assert.deepEqual(fire.radius, { max: 40, min: 15, outer: 1.5, inner: 0, type: 5 });
  const tele = generatorMissile(pkgs(), s[0].teleport)!;
  assert.equal(tele.teleportMessage, 4);
});

test('Nooseman: rope, drop and grapple parameters', { skip }, () => {
  const p = noosemanParams(pkgs(), values(ref(10, 215)));
  assert.equal(p.lowBone, 18);
  assert.equal(p.bodyBone, 7);
  assert.ok(Math.abs(p.ropeNative - 5.294) < 0.001);
  assert.equal(p.maxDrop, 20);
  assert.deepEqual(r3([p.grabRadius, p.grabHeight, p.cooldownHit, p.cooldownMiss]), [1, 0.8, 3, 0.5]);
  assert.deepEqual(r3([p.dropSpeed, p.reelSpeed]), [10, 4.5]);
  assert.deepEqual(p.grapple.dps, [15, 15]);
  assert.deepEqual(r3([p.grapple.grace, p.grapple.meterMax, p.grapple.hold, p.grapple.darken]), [0.25, 3, 5, 85]);
});

test('Fester / Mainliner / Burrower: special attack parameters', { skip }, () => {
  const f = festerParams(pkgs(), values(ref(10, 363)));
  assert.deepEqual(f.rat, ref(10, 381));
  assert.deepEqual(r3([f.releaseMinDist, f.releaseEvery]), [2, [11, 16]]);
  assert.deepEqual(r3([f.chargeCone, f.chargeRange, f.chargeEvery]), [30, [5, 20], [1.5, 3.5]]);
  assert.equal(f.strikeDamage, 30);
  const m = mainlinerParams(pkgs(), values(ref(10, 176)));
  assert.deepEqual(r3([m.cooldown, m.maxRise, m.band]), [[10, 15], 1.5, [3, 9]]);
  assert.deepEqual(r3([m.jump.base, m.jump.leapRange, m.jump.cone, m.jump.ride]), [20, [3, 7.5], 30, 2]);
  assert.equal(m.jump.stick[0].mult * m.jump.base, 30);
  const b = burrowerParams(pkgs(), values(ref(10, 256)));
  assert.deepEqual(r3([b.flyByEvery, b.flyByChance, b.flyByFinal, b.flyByOffset, b.flyByPasses]), [[10, 15], 70, [7.5, 10], 4, 3]);
  assert.deepEqual(b.deathUnder, ref(10, 1258));
  assert.equal(b.hole.length, 2);
});

test('Characters as victims: Mainliner ride (p141..p143), Nooseman hold (Grapple p18 / p19)', { skip }, () => {
  // Clem (10:642) and Dallas (10:391): p143 1, both incapacitate Attacks 10:205 (the front stick
  // clip 10:228, p6 0: no damage at the grapple start).
  for (const id of [642, 391]) {
    const v = mainlinerVictim(pkgs(), values(ref(10, id)));
    assert.equal(v.rideable, true, `10:${id} takes a Mainliner's jump`);
    assert.deepEqual(v.incapacitate[0].clip, ref(10, 228));
    assert.deepEqual(v.incapacitate[1].clip, ref(10, 228));
    assert.equal(v.incapacitate[0].mult, 0);
  }
  // The finisher on a character is the stick Attack: 1.5 x 20.
  const m = mainlinerParams(pkgs(), values(ref(10, 176)));
  assert.deepEqual(m.jump.stick.map((x) => x.mult * m.jump.base), [30, 30]);
  // A template without p143 is not jumped at.
  assert.equal(mainlinerVictim(pkgs(), []).rideable, false);
  const n = noosemanParams(pkgs(), values(ref(10, 215)));
  assert.deepEqual(r3([n.grapple.npcHold, n.grapple.npcDamage]), [3, 30]);
});

test('Inferna: burn, ash and attack parameters', { skip }, () => {
  const p = infernaParams(pkgs(), values(ref(10, 823)));
  assert.deepEqual(r3([p.burn, p.burnPerDamage, p.ashTime]), [[20, 40], 0.3, [15, 25]]);
  assert.deepEqual([p.igniteRange, p.circleLimit, p.circleRadius], [20, 11, 4]);
  assert.deepEqual([p.flameBand, p.ballBand, p.ballChance], [[0, 5], [6, 30], 90]);
  assert.deepEqual(p.flame.parts.radius, { max: 20, min: 5, outer: 8, inner: 0, type: 5 });
  assert.ok(Math.abs(p.ball.speed - 12.2) < 0.05);
  assert.deepEqual(p.flameModel, ref(10, 99));
});

test('Slayer head: 3 HP, damage types, explosion-proof', { skip }, () => {
  const h = headParams({ pkgs: pkgs() }, ref(10, 983), 18)!;
  assert.equal(h.health, 3);
  assert.equal(headDamage(h, 6, 1), 6); // bullet
  assert.equal(headDamage(h, 6, 10), 6); // shiv
  assert.equal(headDamage(h, 40, 3), 0); // explosion
  assert.equal(headDamage(h, 20, 2), 0); // blades
});

test('Ranged Targeting Positions: reposition scoring', { skip }, () => {
  const p = repositionParams(pkgs(), ref(10, 236))!;
  assert.deepEqual(r3([p.stay, p.radius, p.wCentre, p.wNear, p.wCover, p.margin]), [[3, 8], 30, -1, 0.5, 1.5, 0.75]);
  const band = standBand(0, 30, p.margin);
  assert.deepEqual(r3(band), [0.75, 29.25]);
  // Cover adds p5; nearer stands score higher.
  assert.ok(standScore(p, 5, 15, band, true) > standScore(p, 5, 15, band, false));
  assert.ok(standScore(p, 2, 15, band, false) > standScore(p, 20, 15, band, false));
});
