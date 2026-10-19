// Reputation / blood skins (src/game/actors/reputation-skin.ts, docs/game-logic.md §13.6):
// every Reputation Point Based Blood Texture Set Suite in the data decodes, its ranges cover the
// reputation / blood domain without gaps, every material resolves to a texture, and the sets fit
// the models they are applied to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classByHash, readObjectTemplate, type EntityPackage, type EntityPackageSet } from '../src/formats/entities';
import { findEntry, ODU_OBJECT, readDbId, TDU_TEXTURE, type PackageSet } from '../src/formats/model';
import {
  bloodFromGenerator,
  modelSlotTextures,
  pickIndex,
  readPlayerSkins,
  readSuite,
  readWeaponSkin,
  refKey,
  skinFor,
  SUITE_CLASS,
} from '../src/game/actors/reputation-skin';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

test('suite / set selection: last threshold <= value, index 0 below the first', () => {
  const rep = [-99999, -90, -30, 30, 90];
  assert.equal(pickIndex(rep, -150), 0);
  assert.equal(pickIndex(rep, -90.01), 0);
  assert.equal(pickIndex(rep, -90), 1);
  assert.equal(pickIndex(rep, 0), 2);
  assert.equal(pickIndex(rep, 29.99), 2);
  assert.equal(pickIndex(rep, 30), 3);
  assert.equal(pickIndex(rep, 90), 4);
  assert.equal(pickIndex(rep, 1e6), 4);
  assert.equal(pickIndex([0, 10, 20], -1), 0);
  assert.equal(pickIndex([0, 10, 20], 9.99), 0);
  assert.equal(pickIndex([0, 10, 20], 10), 1);
  assert.equal(pickIndex([], 5), 0);
});

test('Blood Point Generator: p0 at the edge of p2, p1 at the centre, nothing outside', () => {
  const v = [5, 10, 50, 360];
  assert.equal(bloodFromGenerator(v, 0), 10);
  assert.equal(bloodFromGenerator(v, 25), 7.5);
  assert.equal(bloodFromGenerator(v, 50), 0);
  assert.equal(bloodFromGenerator(v, 10, 179), 9);
  // A 90 degree cone: 45 degrees off the axis is the edge.
  assert.equal(bloodFromGenerator([5, 10, 50, 90], 10, 60), 0);
  assert.equal(bloodFromGenerator([5, 10, 50, 90], 10, 30), 9);
});

function packages(): Map<number, EntityPackage> {
  const pk = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const load = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: load(`${base}.odu`), mdu: load(`${base}.mdu`), tdu: load(`${base}.tdu`) } as EntityPackage);
  }
  return pk;
}

test('every suite in the data decodes, covers its domain and resolves its textures', { skip }, () => {
  const pk = packages();
  const epk = pk as EntityPackageSet;
  const texExists = (k: string) => {
    const [pkg, id] = k.split(':').map(Number);
    return !!findEntry(pk.get(pkg)?.tdu, TDU_TEXTURE, id);
  };
  let suites = 0, sets = 0, materials = 0;
  for (const [pkg, p] of pk) {
    for (const e of p.odu?.entries ?? []) {
      if (e.type !== ODU_OBJECT || e.group !== 1) continue;
      const t = readObjectTemplate(epk, { pkg, id: e.id });
      if (!t || classByHash(t.classHash)?.name !== SUITE_CLASS) continue;
      const s = readSuite(epk, { pkg, id: e.id })!;
      const name = refKey(s.ref);
      suites++;
      assert.ok(s.sets.length > 0, `${name}: has sets`);
      // Blood levels start at 0 (the first set is the clean one) and ascend: no gaps.
      assert.equal(s.sets[0].minBlood, 0, `${name}: first set from blood 0`);
      for (let i = 1; i < s.sets.length; i++) assert.ok(s.sets[i].minBlood > s.sets[i - 1].minBlood, `${name}: ascending`);
      const n = s.sets[0].materials.length;
      for (const set of s.sets) {
        sets++;
        assert.equal(set.materials.length, n, `${name}: same slot count in every set`);
        for (const k of set.textures) {
          materials++;
          assert.ok(k && texExists(k), `${name} ${refKey(set.ref)}: texture ${k} resolves`);
        }
      }
    }
  }
  assert.equal(suites, 13);
  assert.ok(sets >= 40 && materials >= 100, `${sets} sets, ${materials} materials`);
});

test('Player p66 / p67: five reputation tiers over the whole range, start look is clean', { skip }, () => {
  const pk = packages();
  const epk = pk as EntityPackageSet;
  const pkgs = pk as unknown as PackageSet;
  const skins = readPlayerSkins(epk)!;
  assert.ok(skins);
  const tiers = skins.body.suites.map((s) => s.minReputation);
  assert.deepEqual(tiers, [-99999, -90, -30, 30, 90]);
  // Covers the reputation range (Player p70 / p71 = -150 / +150): the first tier starts below it.
  assert.ok(tiers[0] <= -150);
  assert.deepEqual(skins.body.suites.map((s) => refKey(s.ref)), ['2:693', '2:827', '2:682', '2:806', '2:681']);
  assert.equal(skins.arms.suites.length, 5);
  assert.ok(skins.arms.suites.every((s) => refKey(s.ref) === '2:694'), 'arms: one suite for every tier');
  assert.equal(skins.body.maxBlood, 50);
  assert.equal(skins.body.decay, 0.5);

  // Sets fit the models (2:9 body: 3 slots; 2:138 arms: 2 slots incl. the helper box).
  const body = modelSlotTextures(pkgs, { pkg: 2, id: 9 });
  const arms = modelSlotTextures(pkgs, { pkg: 2, id: 138 });
  assert.equal(body.length, 3);
  assert.equal(arms.length, 2);
  for (const s of skins.body.suites) for (const set of s.sets) assert.equal(set.materials.length, 3);
  for (const set of skins.arms.suites[0].sets) assert.equal(set.materials.length, 2);

  // New game (reputation 0, blood 0): the neutral suite's first set.
  const start = skinFor(skins.body, 0, 0)!;
  assert.equal(start.suite, 2);
  assert.equal(start.set, 0);
  assert.deepEqual(start.textures, ['2:112', '2:122', '2:117']);
  // The model's own materials are the most evil suite at blood level 10 - the dirty look the
  // port showed before the suite was applied.
  assert.deepEqual(body, skins.body.suites[0].sets[1].textures);
  assert.notDeepEqual(body, start.textures);
  // The arms' own materials are the clean set.
  assert.deepEqual(arms, skins.arms.suites[0].sets[0].textures);
  assert.deepEqual(skinFor(skins.body, 150, 0)!.textures, ['2:11', '2:12', '2:13']);
  assert.equal(skinFor(skins.body, -150, 50)!.set, 4);
});

test('weapon suites: one suite each, first set = the weapon model\'s own textures', { skip }, () => {
  const pk = packages();
  const epk = pk as EntityPackageSet;
  const pkgs = pk as unknown as PackageSet;
  let weapons = 0;
  for (const [pkg, p] of pk) {
    for (const e of p.odu?.entries ?? []) {
      if (e.type !== ODU_OBJECT || e.group !== 1) continue;
      const r = { pkg, id: e.id };
      const w = readWeaponSkin(epk, r);
      if (!w) continue;
      weapons++;
      assert.equal(w.suites.length, 1, `${refKey(r)}: one suite`);
      assert.ok(w.maxBlood > 0 && w.decay > 0);
      const model = readObjectTemplate(epk, r)!.modelRef!;
      const slots = modelSlotTextures(pkgs, model);
      const s0 = w.suites[0].sets[0];
      assert.ok(s0.materials.length <= slots.length, `${refKey(r)}: fits ${refKey(model)}`);
      assert.deepEqual(slots.slice(0, s0.textures.length), s0.textures, `${refKey(r)}: model ${refKey(model)} starts clean`);
    }
  }
  assert.ok(weapons >= 10, `${weapons} weapons`);
});
