// 2 Cellblocks (docs/levels.md, docs/playthrough.md "2 Cellblocks"): rules decoded while playing
// the level end to end.
// - Message filters (Instance / Visiblity / Inventory / Insanity / Reputation): p0 is "destroy
//   once a message passed", not an enable flag (Suffering.rfl filter catch-all 0x100cb7a0); the
//   Instance Message Filter test compares "sender listed in p1" with p2 (0x100b8b10). Read as an
//   enable flag, the level's filters with the template's p0 = 0 (905, 90d's siblings f9e / fcd /
//   12ab) never passed the inmate, and his scenes never started.
// - Usable objects (Pushable, Phone, Toilet, Mountable, Security Monitor): p22 is the lock at
//   start and p28 / p29 unlock / lock it, as for a Switch. The barricade bed 18f1 starts locked;
//   Count Down 18f6 unlocks it once the junk on it is smashed.
// - Struggle presses while a creature holds the player: Fire, Throw, Jump and Use (the
//   Mainliner's ride sums input actions 0x428..0x42b, 0x1007fb1f); movement keys do not count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSpent, instanceFilterPasses, World, type WorldHooks } from '../src/game/world/logic';
import { PlayerHold } from '../src/game/actors/specials/hold';
import type { SpecialRuntime } from '../src/game/actors/specials/runtime';
import type { Actor } from '../src/game/actors/actor';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { nodeFS, readSrsc, skip } from './helpers';
import { NavGraph, NO_NAV_TYPE, shortcutBarred } from '../src/game/actors/nav';
import { dynamicObjectUids, hiddenTarget } from '../src/game/world/dynamic';

test('Instance Message Filter: passes when "sender listed in p1" equals p2', () => {
  const v = (p2: number) => [0, [0x868], p2];
  assert.equal(instanceFilterPasses(v(1), 0x868), true, 'listed, p2 1');
  assert.equal(instanceFilterPasses(v(1), 0x1), false, 'not listed, p2 1');
  assert.equal(instanceFilterPasses(v(0), 0x1), true, 'not listed, p2 0');
  assert.equal(instanceFilterPasses(v(0), 0x868), false, 'listed, p2 0');
  assert.equal(instanceFilterPasses([0, [0x868]], 0x868), true, 'p2 defaults to 1');
});

test('message filters: destroyed after passing when p0 is set or no link is left', () => {
  assert.equal(filterSpent([1], [true]), true, 'p0 1');
  assert.equal(filterSpent([0], [true, false]), false, 'p0 0, a link alive');
  assert.equal(filterSpent([0], [false, false]), true, 'p0 0, every link gone');
  assert.equal(filterSpent([0], []), true, 'no links');
});

function fakeHold() {
  const player = {
    motionOverride: null as null | ((dt: number, i: { forward: number; strafe: number; jump: boolean; crouch: boolean }) => boolean),
    attackOverride: null as null | (() => boolean),
    setFeet() {},
    motor: { onGround: true },
  };
  const rt = { holder: null, player, playerAlive: true } as unknown as SpecialRuntime;
  const hold = new PlayerHold(rt, {} as Actor);
  return { hold, player, rt };
}

test('struggle presses: Fire / Throw / Use (attackOverride) and Jump count, movement does not', () => {
  const { hold, player } = fakeHold();
  assert.equal(hold.start(), true);
  const step = (i: Partial<{ forward: number; strafe: number; jump: boolean; crouch: boolean }>) => player.motionOverride!(1 / 60, { forward: 0, strafe: 0, jump: false, crouch: false, ...i });
  step({ forward: 1 });
  step({ forward: -1 });
  step({ strafe: 1 });
  step({ crouch: true });
  assert.equal(hold.presses, 0, 'movement and crouch are not struggle presses');
  step({ jump: true });
  step({ jump: true });
  assert.equal(hold.presses, 1, 'a held Jump is one press');
  step({});
  step({ jump: true });
  assert.equal(hold.presses, 2);
  assert.equal(player.attackOverride!(), true, 'Fire / Throw / Use are taken as presses');
  assert.equal(hold.presses, 3);
  hold.release();
  assert.equal(player.attackOverride, null, 'released: the buttons act again');
  assert.equal(player.motionOverride, null);
});

const LEVEL_2 = 'LEVELS/2 Cellblocks/2 Cellblocks.lvl';
async function world2() {
  const lvl = readSrsc(LEVEL_2);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(LEVEL_2), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_2 });
  world.start();
  world.update(0);
  return world;
}

test('2 Cellblocks: Instance Message Filters pass the inmate whatever their p0', { skip }, async () => {
  const world = await world2();
  const got: string[] = [];
  world.subscribe('*', (msg, from, to) => got.push(`${to.toString(16)}:${msg}:${from.toString(16)}`));
  // 905 (template p0 = 0): Detector 904 (NPCs) -> 905 [868] -> Behavior Changer 906 (his line 20:4).
  world.send(0x905, 1, 0x1234);
  world.update(0.05);
  assert.ok(!got.some((g) => g.startsWith('906:')), 'another sender is held back');
  world.send(0x905, 1, 0x868);
  world.update(0.05);
  assert.ok(got.includes('906:1:868'), 'the inmate passes to 906');
  assert.equal(world.get(0x905)!.destroyed, false, 'p0 0: it stays');
  // 932 (p0 = 1): passed once, then gone.
  world.send(0x932, 1, 0x868);
  world.update(0.05);
  assert.equal(world.get(0x932)!.destroyed, true, 'p0 1: destroyed after passing');
});

test('2 Cellblocks: the barricade bed 18f1 is locked until its five junk pieces are smashed', { skip }, async () => {
  const world = await world2();
  const bed = world.get(0x18f1)!;
  assert.equal(bed.enabled, false, 'p22 0: locked at start');
  // Each junk Breakable's break (BlowUp 11) decrements Count Down 18f6 (count 5), which sends
  // Enable (p28 inUnlock) to the bed at zero.
  // (props.ts applies the bed's p28 / p29 to the same flag.)
  const got: number[] = [];
  world.subscribe(0x18f1, (msg) => got.push(msg));
  for (let n = 0; n < 4; n++) world.send(0x18f6, 11, 0x18f3);
  world.update(0.05);
  assert.deepEqual(got, [], 'four smashed: still locked');
  world.send(0x18f6, 11, 0x18f3);
  world.update(0.05);
  assert.deepEqual(got, [bed.e.values[28]], 'the fifth: p28 inUnlock (Enable)');
  assert.equal(bed.e.values[28], 4);
});

async function level2() {
  const lvl = readSrsc(LEVEL_2);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(LEVEL_2), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages, ents: parseEntities(lvl, packages) };
  } finally {
    console.warn = warn;
  }
}

test('2 Cellblocks: the inmate\'s type (10:674) is barred from the cell block\'s ends; his way on is the cell e3', { skip }, async () => {
  const { ents } = await level2();
  const nav = new NavGraph(ents, (r) => (r.pkg === 10 && r.id === 674 ? 5 : undefined));
  const n = (u: number) => nav.byUid.get(u)!;
  for (const u of [0x9b4, 0x9bd, 0xa49]) assert.equal(nav.nodes[n(u)].types, 32, u.toString(16));
  // A straight walk past 9bd (186.3, 111) is barred to him, not to others.
  const at = nav.nodes[n(0x9bd)];
  assert.equal(nav.crossesExcluded(at.x - 5, at.y, at.z, at.x + 5, at.z, 5), true);
  assert.equal(nav.crossesExcluded(at.x - 5, at.y, at.z, at.x + 5, at.z, NO_NAV_TYPE), false);
  assert.equal(nav.crossesExcluded(at.x - 5, at.y, at.z + 4, at.x + 5, at.z + 4, 5), false, '4 m off the node');
  // From the cell block (node 1cd8) to the middle block (2d3a): only through the cell e3 for him.
  const p = nav.path(n(0x1cd8), n(0x2d3a), undefined, { navType: 5 });
  assert.ok(p, 'a way for his type');
  assert.ok(!p!.some((i) => [0x9b4, 0x9bd, 0xa49].includes(nav.nodes[i].uid)));
  assert.ok(p!.some((i) => nav.nodes[i].uid === 0x9ba), 'by the cell e3 (nodes 9b9 / 9ba)');
  // Past 9bd (the east door) there is no way back for him.
  assert.equal(nav.path(n(0x9c8), n(0x1cd8), undefined, { navType: 5 }), null);
  // Into the steam-pipe yard: the graph's way runs through 9bd, so a straight walk there through
  // door 85c (4 m beside the node) is not his way; the middle block is reached by his own.
  assert.equal(shortcutBarred(nav, n(0x1cd8), n(0x9c8), 5), true);
  assert.equal(shortcutBarred(nav, n(0x1cd8), n(0x9c8), NO_NAV_TYPE), false);
  assert.equal(shortcutBarred(nav, n(0x1cd8), n(0x9ba), 5), false);
});

test('2 Cellblocks: the hit target 18ce at the foot of the raised ladder is built (hidden)', { skip }, async () => {
  const { lvl, packages, ents } = await level2();
  const e = ents.find((x) => x.uid === 0x18ce)!;
  assert.equal(hiddenTarget(e), true);
  assert.ok(dynamicObjectUids(lvl, packages as never).has(0x18ce));
  // Mechanism 18cc: a 4.2 m drop (translation group p22..p26) on its p60 input (On); Object
  // Grouper 18cd carries the Ladder 18cb with it.
  const m = ents.find((x) => x.uid === 0x18cc)!;
  assert.deepEqual([m.values[22], +(m.values[25] as number).toFixed(2), m.values[26], m.values[60]], [1.25, -4.2, 1, 1]);
  assert.deepEqual(ents.find((x) => x.uid === 0x18cd)!.links, [0x18cc, 0x18cb]);
});
