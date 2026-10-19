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
import type { World } from '../src/game/world/logic';
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
