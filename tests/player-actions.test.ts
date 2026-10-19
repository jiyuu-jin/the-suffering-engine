// Player actions decoded from the templates: reputation idle sets, unarmed attack, rolls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import type { EntityPackage, EntityPackageSet } from '../src/formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../src/formats/entities';
import { readDbId, type PackageSet, type ResRef } from '../src/formats/model';
import { idleSetFor, readIdleSets, type IdleSet } from '../src/game/actors/player-body';
import { readPlayerWeaponProps } from '../src/game/weapons/data';

test('idle sets: the last set whose p1 is at or below the reputation', () => {
  const r = (id: number): ResRef => ({ pkg: 2, id });
  const sets: IdleSet[] = [
    { clips: [r(1)], minReputation: -999999 },
    { clips: [r(2)], minReputation: -50 },
    { clips: [r(3)], minReputation: 50 },
  ];
  assert.equal(idleSetFor(sets, -150)?.clips[0].id, 1);
  assert.equal(idleSetFor(sets, -50)?.clips[0].id, 2);
  assert.equal(idleSetFor(sets, 49)?.clips[0].id, 2);
  assert.equal(idleSetFor(sets, 50)?.clips[0].id, 3);
  assert.equal(idleSetFor([], 0), undefined);
});

function systemPackages(): EntityPackageSet {
  const pkgs = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id !== 2 || pkgs.has(id)) continue;
    pkgs.set(2, { id: 2, name: 'System', odu: readSrsc(db.slice(0, -3) + '.odu') } as EntityPackage);
  }
  return pkgs;
}

const props = (pkgs: EntityPackageSet, r: ResRef) => {
  const t = readObjectTemplate(pkgs, r)!;
  return decodeTemplateProps(classByHash(t.classHash), t);
};

test('player: unarmed props (p143) have reputation idle sets, an attack and roll clips', { skip }, () => {
  const pkgs = systemPackages();
  const unarmed = props(pkgs, { pkg: 2, id: 5 })[143] as ResRef;
  assert.ok(unarmed && typeof unarmed === 'object');
  const sets = readIdleSets(pkgs as unknown as PackageSet, unarmed);
  assert.equal(sets.length, 3);
  assert.ok(sets.every((s) => s.clips.length > 0));
  assert.ok(sets[0].minReputation < sets[1].minReputation && sets[1].minReputation < sets[2].minReputation);
  const pwp = readPlayerWeaponProps(pkgs, unarmed)!;
  assert.ok(pwp.attacks.length >= 1, 'p86 attack');
  assert.ok(pwp.fpAttacks.length >= 1, 'p91 first-person attack');
  const v = props(pkgs, unarmed);
  assert.ok(v[166] && v[167], 'p166 / p167 roll clips');
});

test('player: first-person sets of every chapter 1 Player Weapon Properties (p61..p84, p104..p108)', { skip }, () => {
  // docs/game-logic.md §4.5 "First-person clips": the stance helper adds 48 in first person.
  const pkgs = systemPackages();
  const isRef = (x: unknown): x is ResRef => !!x && typeof x === 'object' && 'pkg' in (x as object);
  const key = (x: unknown) => (isRef(x) ? `${x.pkg}:${x.id}` : '-');
  for (const id of [409, 303, 436, 109, 111, 244, 475]) {
    const v = props(pkgs, { pkg: 2, id });
    assert.ok(isRef(v[61]), `2:${id} p61 hold`);
    assert.equal(key(v[104]), key(v[61]), `2:${id} p104 = p61`);
    assert.equal(key(v[105]), key(v[61]), `2:${id} p105 = p61`);
    assert.ok(!Array.isArray(v[62]) || v[62].length === 0, `2:${id} p62: no first-person fidgets`);
    assert.deepEqual([65, 70, 75, 80].map((i) => v[i]), [45, 135, 225, 315], `2:${id} headings`);
    assert.ok(isRef(v[108]), `2:${id} p108 first-person throw`);
  }
  // Ranged sets have first-person fire / reload / draw clips of their own.
  for (const id of [436, 111, 244, 475]) {
    const v = props(pkgs, { pkg: 2, id });
    for (const [fp, tp] of [[106, 113], [96, 97], [172, 173]]) assert.notEqual(key(v[fp]), key(v[tp]), `2:${id} p${fp} vs p${tp}`);
  }
  // The strike list p91 (first person) of the unarmed set and the shiv.
  for (const id of [409, 303]) assert.equal(readPlayerWeaponProps(pkgs, { pkg: 2, id })!.fpAttacks[0]?.clip.id, 218);
});
