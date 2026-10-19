// Carry cap on pickups (Item CanPickUp 0x100be240, pickup touch 0x100bda00; docs/re/player.md §8):
// at Item p44 the item stays in the world and its p24 message shows in the pickup text widget,
// once per touch (the player's (item, time) list keeps a touch for Player p250 = 3 s).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { World, atCarryCap, type WorldHooks } from '../src/game/world/logic';
import { nodeFS, readSrsc, skip } from './helpers';

test('carry cap: Items and Health Bonus Items stop at p44 of their template', () => {
  const v: unknown[] = [];
  v[44] = 9;
  assert.equal(atCarryCap('Health Bonus Item', v, 8), false);
  assert.equal(atCarryCap('Health Bonus Item', v, 9), true);
  assert.equal(atCarryCap('Item', v, 12), true);
  assert.equal(atCarryCap('Ammo Box', v, 12), false, 'other pickup classes are not capped here');
  v[44] = 0;
  assert.equal(atCarryCap('Item', v, 50), false, 'p44 = 0: no cap');
});

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
const BOTTLE = 0x6ff5;

test('1a: a ninth-bottle Xombium stays where it lies and shows "Xombium Full" once per touch', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  let feet: [number, number, number] = [0, -1000, 0];
  let full = true;
  const texts: string[] = [];
  const picked: number[] = [];
  const hooks: WorldHooks = {
    player: () => ({ feet, eye: [feet[0], feet[1] + 1.6, feet[2]], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    pickup: (w) => void picked.push(w.uid),
    canPickUp: () => !full,
    pickupText: (t) => void texts.push(t),
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: L1A });
  world.start();
  const bottle = world.get(BOTTLE)!;
  assert.equal(bottle.cls, 'Health Bonus Item');
  assert.equal(bottle.e.values[44], 9);
  bottle.visible = true;
  bottle.enabled = true;
  const at = (p: number[]) => (feet = [p[0], p[1], p[2]]);
  const away = () => (feet = [0, -1000, 0]);
  const step = (s: number) => {
    for (let t = 0; t < s; t += 0.1) world.update(0.1);
  };
  at(bottle.pos);
  step(1);
  assert.deepEqual(texts, ['Xombium Full'], 'shown once while standing on it');
  assert.ok(!bottle.destroyed && !bottle.s.taken && bottle.visible, 'the bottle stays');
  assert.deepEqual(picked, []);
  away();
  step(1);
  at(bottle.pos);
  step(0.5);
  assert.equal(texts.length, 1, 'back within Player p250 (3 s): not again');
  away();
  step(3.5);
  at(bottle.pos);
  step(0.5);
  assert.equal(texts.length, 2, 'after p250 s away it shows again');
  full = false;
  step(0.2);
  assert.deepEqual(picked, [BOTTLE], 'taken once there is room');
});
