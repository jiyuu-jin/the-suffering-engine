// 1a: taking the Shiv out of the stabbed inmate's back kills him on his bed.
// The visible Shiv (Ammo Box 5bfb) is granted by Quest Item Pickup 8368; only using that spot
// fires its p27 (Timer 8369 0.831 s -> Timer 836c 0.15 s -> BlowUp to the inmate 7652, who dies
// through his own DeathBehavior 12:287, clip 12:107). docs/game-logic.md §11.3 / §11.5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World, type WorldHooks } from '../src/game/world/logic';
import { nodeFS, readSrsc, skip } from './helpers';

const LEVEL_1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
const SHIV = 0x5bfb;
const SPOT = 0x8368;
const INMATE = 0x7652;
const SHOW_CORPSES = 0x7653;

async function world1a() {
  const lvl = readSrsc(LEVEL_1A);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(LEVEL_1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const picked: number[] = [];
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    pickup: (w) => void picked.push(w.uid),
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_1A });
  world.start();
  world.update(0);
  // "Goose" relay 5f1b shows the corpse doubles and the Shiv through Visibility Toggler 7653.
  world.send(SHOW_CORPSES, 1, 0);
  world.update(0);
  return { world, picked };
}

test('1a: the Shiv in the inmate is taken through Quest Item Pickup 8368; scenery Shivs not at all', { skip }, async () => {
  const { world } = await world1a();
  const shiv = world.get(SHIV)!;
  assert.equal(shiv.visible, true, 'shown with the corpse doubles');
  assert.equal(world.pickupVia(shiv)?.uid, SPOT, 'Use on the visible Shiv goes through its pickup spot');
  assert.equal(world.pickupVia(world.get(SPOT)!)?.uid, SPOT);
  assert.equal(world.itemLabel(world.get(SPOT)!), 'Shiv', 'the spot is labelled with the item it grants');
  // The three Shivs in Goose's corpse: p26 = 0, no p51 input, no spot: not for the player.
  for (const u of [0x7cdc, 0x7cdd, 0x7cde]) assert.equal(world.pickupVia(world.get(u)!), undefined, `#${u.toString(16)}`);
  // A locker's batteries (p26 = 0, Enable on p51) and a plain pickup stay their own target.
  assert.equal(world.pickupVia(world.get(0x7822)!)?.uid, 0x7822);
  const plain = world.of('Health Bonus Item').find((w) => (w.e.values[26] ?? 1) !== 0)!;
  assert.equal(world.pickupVia(plain)?.uid, plain.uid);
});

test('1a: using the Shiv spot gives the Shiv and BlowUps the inmate 0.98 s later', { skip }, async () => {
  const { world, picked } = await world1a();
  const blowUps: number[] = [];
  let t = 0;
  world.subscribe(INMATE, (msg) => {
    if (msg === 11) blowUps.push(t);
  });
  world.pickup(world.pickupVia(world.get(SHIV)!)!);
  assert.deepEqual(picked, [SHIV], 'the Shiv itself is given');
  assert.equal(world.get(SHIV)!.destroyed, true);
  assert.equal(world.get(SPOT)!.s.taken, true);
  for (let i = 0; i < 60; i++) {
    t += 1 / 30;
    world.update(1 / 30);
  }
  assert.equal(blowUps.length, 1, 'one BlowUp to the inmate');
  assert.ok(blowUps[0] > 0.95 && blowUps[0] < 1.05, `BlowUp at ${blowUps[0].toFixed(2)} s (0.831 + 0.15)`);
});

test('1a: the Shiv taken before this rule (spot left unused) still goes through the spot', { skip }, async () => {
  // A save from a build that let the Shiv be picked directly: the Shiv is gone, the spot is not.
  const { world } = await world1a();
  world.pickup(world.get(SHIV)!);
  const spot = world.get(SPOT)!;
  assert.ok(!spot.s.taken);
  let blownUp = false;
  world.subscribe(INMATE, (msg) => void (blownUp ||= msg === 11));
  world.pickup(world.pickupVia(spot)!);
  for (let i = 0; i < 40; i++) world.update(1 / 30);
  assert.equal(blownUp, true, 'using the spot still kills the inmate');
});
