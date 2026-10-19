// Weapons and body parts in NPC hands: which sets a character has from creation (p53 / p56) and
// the clip events that put them there later (src/game/weapons/npc.ts, docs/game-logic.md §4.4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readAnimEvents } from '../src/formats/animation';
import { crossedEvent, npcSpawnedAtCreation, npcWeaponSlots, npcBodyPartSlots, SPAWN_WEAPONS_EVENT } from '../src/game/weapons/npc';
import { deathDropPairs, deathWeaponMode } from '../src/game/actors/drops';
import type { PackageSet } from '../src/formats/model';
import { nodeFS, readSrsc, skip, DATA_ROOT } from './helpers';
import { SrscFile } from '../src/formats/srsc';
import { join } from 'node:path';

test('sets in the hand from creation: p53 the p51 / p52 weapons, p56 the p54 / p55 parts', () => {
  const v: unknown[] = [];
  assert.deepEqual(npcSpawnedAtCreation(v as never), { weapons: false, parts: false });
  v[53] = 1;
  assert.deepEqual(npcSpawnedAtCreation(v as never), { weapons: true, parts: false });
  v[56] = 1;
  v[53] = 0;
  assert.deepEqual(npcSpawnedAtCreation(v as never), { weapons: false, parts: true });
});

test('a clip event fires when the clip time crosses it (once; looping clips wrap)', () => {
  assert.equal(crossedEvent(0.7, 0.8, 0.75, 4, false), true);
  assert.equal(crossedEvent(0.75, 0.8, 0.75, 4, false), false, 'not twice');
  assert.equal(crossedEvent(3.9, 0.1, 0.05, 4, true), true, 'wrapped');
  assert.equal(crossedEvent(3.9, 0.1, 0.05, 4, false), false);
});

test('death drops follow the hand state: a SpawnWeapons event can arm a p53 = 0 character', () => {
  const v: unknown[] = [];
  v[109] = 1;
  assert.equal(deathWeaponMode(v as never), 'keep', 'p53 = 0: nothing in the hand');
  assert.equal(deathWeaponMode(v as never, true), 'drop', 'armed by the event');
});

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

test('1a: guards without p53 hold no gun, without p56 wear no cap; armed guards drop the Ammo Box', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const by = new Map(parseEntities(lvl, pkgs, { resolveStrings: false }).map((e) => [e.uid, e]));
  const npc = (uid: number) => {
    const e = by.get(uid)!;
    return { ch: {} as never, entity: { values: e.values, family: e.family }, kind: { template: e.template } };
  };
  // 609f, the guard at the office bars: revolver listed, p53 = 0; cap listed, p56 = 1.
  const g = by.get(0x609f)!;
  assert.equal(g.values[53], 0);
  assert.equal(npcWeaponSlots(pkgs as unknown as PackageSet, npc(0x609f)).length, 1, 'the revolver is listed');
  assert.deepEqual(npcSpawnedAtCreation(g.values), { weapons: false, parts: true });
  // 7889: neither (a posed corpse).
  assert.deepEqual(npcSpawnedAtCreation(by.get(0x7889)!.values), { weapons: false, parts: false });
  assert.equal(npcBodyPartSlots(pkgs as unknown as PackageSet, npc(0x7889)).length, 1, 'the cap is listed');
  // The gas chamber guard 782b holds his: p109 = 1 drops the revolver as Ammo Box 4:1404.
  const armed = by.get(0x782b)!;
  assert.deepEqual(npcSpawnedAtCreation(armed.values).weapons, true);
  const drops = deathDropPairs(pkgs, armed.values);
  if (armed.values[109] === 1) assert.deepEqual(drops.map((d) => `${d.weapon.pkg}:${d.weapon.id}>${d.drop.pkg}:${d.drop.id}`), ['10:1802>4:1404']);
});

test("retail SpawnWeapons events: the dormant creatures' rise clips at 0.75 s", { skip }, () => {
  const adu = new SrscFile(new Uint8Array(readFileSync(join(DATA_ROOT, 'COMMON/NPCs/NPCs.adu'))).buffer as ArrayBuffer);
  for (const id of [1423, 1778, 1779]) {
    const ev = readAnimEvents(adu, id)!.events.filter((e) => e.kind === 1 && e.param === SPAWN_WEAPONS_EVENT);
    assert.equal(ev.length, 1, `10:${id}`);
    assert.ok(Math.abs(ev[0].time - 0.75) < 0.01);
  }
});
