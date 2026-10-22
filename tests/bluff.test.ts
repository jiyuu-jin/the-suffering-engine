// 8a / 8b Bluff (docs/levels.md, docs/playthrough.md "8 Bluff"): rules decoded while playing the
// levels end to end.
// - Water holds nobody up (src/game/levels/water.ts header: a Water Volume contact goes to the
//   water-effects component, never to the mover) and the player drowns deeper than Player p28
//   (2 m). 8a's creek (3..3.5 m) is crossed at its south ford: water-level ledges on both
//   banks, 2 m apart at z 540 (Detector 2b2c, filter Player, spans it), then north along the
//   east ledge under the overhang to the rocks and up Clamber Points 25b1 / 2a3e.
// - A Mechanism's motion group at rest sends p55 + 2 g (+1 at its travel): 8b's gas valves turn
//   their Mechanisms 160 deg, whose p58 counts the gas Count Down 1fa9 down.
// - "ISeeYou" (character output p31) fires when KillEnemies newly picks the player.
// - A hidden hit target (a system-package Breakable, model 2:180) is never "seen through": its
//   box is what shots hit. 8a's paddy wagon engine 1b80 carries the cut-out texture 2:164 and took
//   no bullet, so the wagon never rolled through the yard gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { dirname } from 'node:path';
import { CharacterMotor, COLLISION_LAYER, CollisionWorld } from '../src/app/physics';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import type { MeshPart } from '../src/formats/types';
import { dynamicObjectUids, hiddenTarget, partSeeThrough } from '../src/game/world/dynamic';
import { RETAIL_WATER_RULES, waterSurfaceParts, waterVolumeUids } from '../src/game/levels/water';
import { parseLevel } from '../src/formats/level';
import { findLevelDependencies } from '../src/app/loader';
import { mechArrivalOutput } from '../src/game/world/props';
import { World, type WorldHooks } from '../src/game/world/logic';
import { resistanceForceMultiplier, resistanceMultiplier } from '../src/game/fx/gas';
import { readHitTables } from '../src/game/actors/hit-react';
import { readTemplate } from '../src/game/world/fx';
import { nodeFS, readSrsc, skip } from './helpers';

const cutOut = () => {
  const m = new THREE.MeshBasicMaterial();
  m.alphaTest = 0.5;
  return m;
};

test('see-through: cut-out parts are looked and shot through, a hidden hit target never', () => {
  const target = { className: 'Breakable', template: { pkg: 2, id: 489 } };
  const fence = { className: 'Static Object', template: { pkg: 7, id: 100 } };
  assert.equal(hiddenTarget(target), true);
  assert.equal(partSeeThrough(target, cutOut()), false, 'the hidden target is hit');
  assert.equal(partSeeThrough(fence, cutOut()), true, 'chain-link and bars stay see-through');
  assert.equal(partSeeThrough(fence, new THREE.MeshBasicMaterial()), false);
  assert.equal(partSeeThrough(undefined, cutOut()), true);
});

test('water: the surfaces hold nobody up; the player motor sinks to the bed', () => {
  const bed: MeshPart = { positions: new Float32Array([0, 80.6, 0, 20, 80.6, 0, 0, 80.6, 20, 20, 80.6, 20]), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) } as unknown as MeshPart;
  const col = new CollisionWorld({ parts: [bed] });
  const m = new CharacterMotor(col, { layers: COLLISION_LAYER.player });
  m.teleport(10, 85, 10);
  for (let i = 0; i < 120; i++) m.step(1 / 60, { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false });
  assert.ok(Math.abs(m.position.y - 80.6) < 0.05, `on the bed (${m.position.y})`);
});

const L8A = 'LEVELS/8 Bluff/8a Bluff.lvl';

async function level8a() {
  const lvl = readSrsc(L8A);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(L8A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages, ents: parseEntities(lvl, packages, { resolveStrings: false }) };
  } finally {
    console.warn = warn;
  }
}

test('8a: the paddy wagon engine 1b80 is a built hidden hit target that starts invulnerable', { skip }, async () => {
  const { lvl, packages, ents } = await level8a();
  const e = ents.find((x) => x.uid === 0x1b80)!;
  assert.equal(hiddenTarget(e), true);
  assert.deepEqual(e.modelRef, { pkg: 2, id: 180 });
  assert.ok(dynamicObjectUids(lvl, packages as never).has(0x1b80));
  // p3 = 1 (invulnerable at start); Detector 28fc sends InvulnerabilityOff (91), its break goes
  // to Relay 1b82, which plays "PaddyWagon" 1b7c.
  assert.equal(e.values[3], 1);
  assert.deepEqual(ents.find((x) => x.uid === 0x28fc)!.links, [0x1b80, 0x25b3]);
  assert.deepEqual(e.links, [0x1b82]);
});

test('8a: the creek is crossed at its south ford, not through the water', { skip }, async () => {
  const { lvl, packages, ents } = await level8a();
  const water = ents.filter((x) => x.className === 'Water Volume');
  const world = { of: (cls: string) => (cls === 'Water Volume' ? water.map((e) => ({ e })) : []) } as unknown as World;
  const surfaces = new CollisionWorld({ parts: waterSurfaceParts(world, packages as never) });
  const deps = await findLevelDependencies(nodeFS(), L8A);
  const ldu = deps.levelLdu ? readSrsc(deps.levelLdu) : undefined;
  const solid = new CollisionWorld(parseLevel(lvl, '8a', { ldu, packages, nonSolidUids: new Set(waterVolumeUids(lvl, packages)) }));
  // Dry rocks have no surface over them: the creek's level then.
  const surface = (x: number, z: number) => surfaces.raycast(x, 95, z, 0, -1, 0, 20)?.point[1] ?? 83.98;
  // A floor at the water level: cast from 1.5 m above the water (under the bank overhangs).
  const floor = (x: number, z: number) => solid.raycast(x, 85.5, z, 0, -1, 0, 20)?.point[1] ?? -Infinity;
  assert.ok(Math.abs(surface(470, 570) - 83.98) < 0.05);
  // The channel: 3..3.5 m everywhere the route meets it, over the drowning depth (2 m).
  for (const [x, z] of [[470, 570], [472, 585], [465, 540]] as const) {
    const d = surface(x, z) - floor(x, z);
    assert.ok(d > RETAIL_WATER_RULES.drown, `(${x}, ${z}) ${d.toFixed(2)} m deep`);
  }
  // The ford: ledges at the water level 2 m apart at z 540; the player Detector 2b2c spans it.
  assert.ok(floor(463, 540) >= 83.98 && floor(467, 540) >= 83.98);
  const det = ents.find((x) => x.uid === 0x2b2c)!;
  assert.equal(det.values[1], 0, 'filter: Player');
  assert.ok(Math.abs(det.position[2] / 2048 - 540) < 0.1);
  // The east ledge under the overhang runs dry from the ford north to the rocks.
  for (const [x, z] of [[468, 540], [471, 550], [472, 560], [476, 570], [480, 580], [485, 585], [490.8, 593.6]] as const)
    assert.ok(floor(x, z) > surface(x, z) - 0.05, `ledge at (${x}, ${z}): ${floor(x, z).toFixed(2)}`);
  // The far bank's Clamber Points start from the rocks at the water level (25b1: 87.2 m top,
  // 2a3e: 89.75 m), out of reach (p2 4.5 m) of the bed at ~80.6.
  for (const [uid, top] of [[0x25b1, 87.2], [0x2a3e, 89.75]] as const) {
    const c = ents.find((x) => x.uid === uid)!;
    const scaleY = c.scale?.[1] ?? 1;
    assert.ok(Math.abs(c.position[1] / 2048 + 0.5 * scaleY - top) < 0.1, `${uid.toString(16)} top`);
    assert.ok(top - 80.6 > 4.5, 'not from the bed');
  }
});

test('Mechanism arrival outputs: p55 / p56 the slide at start / travel, p57 / p58 the rotation', () => {
  assert.equal(mechArrivalOutput(22, 0, 4.2), 55);
  assert.equal(mechArrivalOutput(22, 4.2, 4.2), 56);
  assert.equal(mechArrivalOutput(32, 0, 160), 57);
  assert.equal(mechArrivalOutput(32, 160, 160), 58);
  assert.equal(mechArrivalOutput(32, -95, -95), 58);
});

test('8b: each gas valve\'s Mechanism sends p58 Off into the gas Count Down 1fa9', { skip }, async () => {
  const lvl = readSrsc('LEVELS/8 Bluff/8b Bluff.lvl');
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname('LEVELS/8 Bluff/8b Bluff.lvl'), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  const by = new Map(ents.map((e) => [e.uid, e]));
  for (const [sw, mech, relay] of [[0x213d, 0x2728, 0x1faf], [0x2157, 0x2729, 0x1fab], [0x2159, 0x272a, 0x1fad], [0x21cf, 0x2725, 0x1fa7]]) {
    assert.ok(by.get(sw)!.links.includes(mech));
    const m = by.get(mech)!;
    // The switch sends Disarm (101), the rotation group's forward input p64; 160 deg of travel.
    assert.equal(m.values[64], 101);
    assert.equal(m.values[35], 160);
    assert.equal(m.values[58], 2, 'p58 = Off');
    assert.equal(mechArrivalOutput(32, m.values[35] as number, m.values[35] as number), 58);
    assert.deepEqual(m.links, [relay]);
    assert.ok(by.get(relay)!.links.includes(0x1fa9));
  }
  // The Count Down decrements on Off (2) and starts at 4.
  assert.deepEqual([by.get(0x1fa9)!.values[0], by.get(0x1fa9)!.values[4]], [4, 2]);
});

async function level8b() {
  const L = 'LEVELS/8 Bluff/8b Bluff.lvl';
  const lvl = readSrsc(L);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(L), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    const ents = parseEntities(lvl, packages, { resolveStrings: false });
    return { packages, by: new Map(ents.map((e) => [e.uid, e])) };
  } finally {
    console.warn = warn;
  }
}

test('8b stove: fire makes Hermes react, his reaction\'s Triggered passes Relay 1f0d', { skip }, async () => {
  const { packages, by } = await level8b();
  const relay = by.get(0x1f0d)!;
  assert.equal(relay.values[4], 6, '1f0d relays Triggered');
  assert.equal(relay.values[0], 0, 'and starts disabled: a copy in Detector 2565 (filter 1) enables it');
  assert.deepEqual([by.get(0x2565)!.values[1], by.get(0x249b)!.links, by.get(0x249a)!.links], [1, [0x1f0d], [0x1f0d]]);
  for (const u of [0x1df3, 0x2410, 0x2419, 0x241d, 0x2421, 0x2425, 0x252b]) {
    const h = by.get(u)!;
    assert.ok(h.links.includes(0x1f0d), `Hermes ${u.toString(16)} links the relay`);
    // No damage from anything: p5 (immune to unlisted) and both resistances at x0 ...
    for (const type of [1, 3, 5, 13, 14]) assert.equal(resistanceMultiplier(packages as never, h.values, type), 0);
    // ... but fire (5) and wind (14) keep their force (p2 = 1); the rest none (p6 = 1).
    assert.equal(resistanceForceMultiplier(packages as never, h.values, 5), 1);
    assert.equal(resistanceForceMultiplier(packages as never, h.values, 14), 1);
    assert.equal(resistanceForceMultiplier(packages as never, h.values, 1), 0, 'bullets do not even push him');
    // His only hit reaction: from force 1, a whole-body one that sends Triggered to his links.
    const t = readHitTables(packages as never, h.values);
    assert.deepEqual(t.hits.map((d) => [d.min, d.layerBone, d.message]), [[1, -1, 6]]);
  }
  // A Molotov's blast (Radius Damage 4:248, fire): 20 force at the centre, 13 at its edge.
  const rd = readTemplate(packages as never, { pkg: 4, id: 248 })!;
  assert.deepEqual([rd.values[10], rd.values[2], rd.values[3]], [5, 20, 13]);
  // The rest of the chain: 1f0d -> 2496 -> "Hermes" 1f0f -> Relay 1f17 -> Count Down 1f15 (2);
  // the stove door 1e37 starts open (p36) and closing it (p65 Decrement) takes the second.
  assert.deepEqual(relay.links, [0x2496]);
  assert.ok(by.get(0x2496)!.links.includes(0x1f0f));
  assert.equal(by.get(0x1f15)!.values[0], 2);
  const door = by.get(0x1e37)!;
  assert.deepEqual([door.values[36], door.values[65]], [1, 9]);
  assert.ok(door.links.includes(0x1f15));
  assert.deepEqual(by.get(0x1f15)!.links, [0x1f21, 0x26ae]);
});

test('8b Jimmy: his escort chain ends in the gas room; the walkway Detector picks his scene; nothing of him reaches 9', { skip }, async () => {
  const { by } = await level8b();
  // Freed (Relay 174e) -> 1751 -> Behavior Changer 174f: SimpleConversation 1752 -> WaypointBehavior
  // 1753 (escort: p8 the Player 10, p9 10 m, p10 20 m) -> ... -> 1760 -> WaypointBehavior 189f to
  // Waypoint 1ea5 in Hermes' room (p0 On -> Count Down 1f01).
  assert.equal(by.get(0x174f)!.values[6], 0x1752);
  const chain = [0x1752, 0x1753, 0x1758, 0x1759, 0x1760, 0x189f];
  for (let i = 0; i + 1 < chain.length; i++) assert.deepEqual(by.get(chain[i])!.links, [chain[i + 1]]);
  assert.deepEqual([by.get(0x1753)!.values[8], by.get(0x1753)!.values[9], by.get(0x1753)!.values[10]], [[10], 10, 20]);
  assert.equal(by.get(0x189f)!.values[2], 0x1ea5);
  assert.deepEqual(by.get(0x1ea5)!.links, [0x1f01]);
  // Detector 26b5 (ground enemies) -> Instance Message Filter 26b6 (sender Jimmy) -> Relay 1ea3 ->
  // 24e9 Enable: 1edf (inDisable 4) off, 24e8 (inEnable 4) on -> "Camera" 1eb1 instead of 1ed5.
  assert.equal(by.get(0x26b5)!.values[1], 1);
  assert.deepEqual(by.get(0x26b6)!.values[1], [0x1738]);
  assert.deepEqual(by.get(0x24e9)!.links, [0x24e8, 0x1edf]);
  assert.deepEqual([by.get(0x1edf)!.values[6], by.get(0x24e8)!.values[5], by.get(0x24e8)!.values[0]], [4, 4, 0]);
  // His scene's end hands him a DeathBehavior (Behavior Changer 25d5 -> 10:350): Hermes kills him.
  assert.ok(by.get(0x1eb1)!.links.includes(0x25d5));
  // Level Transition 1798 lists him (p7) but 9's arrival from 8b (Player Spawn Point ca5) names no
  // companion copy (p4 / p5 empty): nobody is carried.
  assert.deepEqual(by.get(0x1798)!.values[7], [0x1738]);
});

test('8b: Relay 2413 (one random link) skips the jets already blocked: the copies keep coming', { skip }, async () => {
  const L = 'LEVELS/8 Bluff/8b Bluff.lvl';
  const lvl = readSrsc(L);
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(L), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    hasItem: () => false,
  };
  const world = new World(parseEntities(lvl, packages, { resolveStrings: false }), packages, hooks, { levelPath: L });
  const relay = world.get(0x2413)!;
  // p2 1 link, p3 1 random, over the five jets' Relays (2415 / 2418 the stove / 241c / 2420 / 2532).
  assert.deepEqual([relay.e.values[2], relay.e.values[3]], [1, 1]);
  assert.deepEqual(relay.e.links, [0x2415, 0x2418, 0x241c, 0x2420, 0x2532]);
  // Four jets blocked: their Relays destroyed (2415 by Relay 2041's Destroy 5, ...).
  for (const u of [0x2415, 0x241c, 0x2420, 0x2532]) world.destroy(world.get(u)!);
  const got: number[] = [];
  world.subscribe('*', (msg, _from, to) => {
    if (msg === 1 && relay.e.links.includes(to)) got.push(to);
  });
  for (let i = 0; i < 20; i++) {
    world.send(0x2413, 1, 0);
    world.update(0.01);
  }
  assert.equal(got.length, 20, 'every pick lands on a live jet');
  assert.ok(got.every((u) => u === 0x2418), 'the stove, the only one left');
});
