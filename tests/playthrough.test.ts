// Regressions for the bugs found by the chapter 1 playthrough (tools/playthrough.mjs,
// docs/playthrough.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollisionWorld } from '../src/app/physics';
import type { MeshPart } from '../src/formats/types';
import { NavGraph, clearLine, clearWide } from '../src/game/actors/nav';
import type { Entity } from '../src/formats/entities';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { WORLD_SCALE, readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World, switchMotion, type WorldHooks } from '../src/game/world/logic';
import { dynamicObjectUids } from '../src/game/world/dynamic';
import { nodeFS, readSrsc, skip } from './helpers';

/** Axis-aligned box as a mesh part (12 triangles). */
function box(min: [number, number, number], max: [number, number, number]): MeshPart {
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** An open gate leaf lying across z = 0 from x = 0 to x = 1.9: vertical 3 cm bars every 12 cm. */
function gateLeaf(): MeshPart[] {
  const bars: MeshPart[] = [];
  for (let x = 0; x <= 1.9; x += 0.12) bars.push(box([x - 0.015, 0, -0.03], [x + 0.015, 2.2, 0.03]));
  bars.push(box([0, 2.1, -0.03], [1.9, 2.2, 0.03]));
  return bars;
}

test('nav: a body cannot walk through the bars of an open gate leaf that thin rays slip through', () => {
  const w = new CollisionWorld({ parts: gateLeaf() });
  // Guard south of the leaf (1a: Unspeakable NPC 609e at gate 7f48), node just north of it.
  const a = { x: 0.9, y: 0, z: -0.5 }, b = { x: 0.95, y: 0, z: 1.0 };
  // A ray between two bars (x = 0.9 + small slope) reports a clear line ...
  assert.equal(clearLine(w, a.x, a.y + 0.8, a.z, b.x, b.y + 0.8, b.z), true);
  // ... the body test does not.
  assert.equal(clearWide(w, a.x, a.y + 0.8, a.z, b.x, b.y + 0.8, b.z, 0.42 * 0.9), false);
  // Open floor: still clear.
  assert.equal(clearWide(w, 3, 0.8, -0.5, 3, 0.8, 1, 0.38), true);
});

test('nav: the start node for a replan is one the body can reach (not one behind gate bars)', () => {
  const w = new CollisionWorld({ parts: gateLeaf() });
  // Entity positions are level units (toOutputSpace divides by WORLD_SCALE).
  const node = (uid: number, x: number, z: number, links: number[]) =>
    ({ uid, className: 'Move Node Object', position: [x * WORLD_SCALE, 0, z * WORLD_SCALE], links, values: [], props: {}, scale: [1, 1, 1] }) as unknown as Entity;
  const ents = [node(1, 0.95, -1.0, [2]), node(2, -0.6, -1.0, [3]), node(3, -0.6, 1.2, [])];
  const nav = new NavGraph(ents);
  const n = (uid: number) => nav.nodes[nav.byUid.get(uid)!];
  // Sanity: node 1 is the closest one and is on the far side of the leaf from the actor.
  const at = { x: 0.9, y: 0, z: 0.5 };
  assert.ok(n(1).z < 0 && at.z > 0, 'node 1 is across the leaf');
  assert.equal(nav.nearest(at.x, at.y, at.z, w), nav.byUid.get(1), 'a thin ray reaches node 1 through the bars');
  const wide = nav.nearest(at.x, at.y, at.z, w, 6, 0.38);
  assert.notEqual(wide, nav.byUid.get(1), 'the body cannot: another node is chosen');
});

const LEVEL_1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
async function load1a() {
  const lvl = readSrsc(LEVEL_1A);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(LEVEL_1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages };
  } finally {
    console.warn = warn;
  }
}

test('1a: the three statues (Pushable 9:3359, flags 0x801) are built as dynamic objects', { skip }, async () => {
  const { lvl, packages } = await load1a();
  const uids = dynamicObjectUids(lvl, packages as never);
  // 8a46 stands in the sally port's gate (Detectors 8a47 / 7507 watch for pushables); 70cd / 75d5
  // in the lobby: pushed into Detector 8b3d they start the booth CartWheeler scene (5db4).
  for (const u of [0x8a46, 0x70cd, 0x75d5]) assert.ok(uids.has(u), `Pushable ${u.toString(16)} not built`);
});

test('1b: scripted Pushables without flag 0x80 (p23 = 0: untextured sheets across a corridor) stay unbuilt', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const uids = dynamicObjectUids(lvl, packages as never);
  for (const u of [0x8290, 0x828a, 0x79f1]) assert.ok(!uids.has(u), `Pushable ${u.toString(16)} built`);
});

test('1a: a Visibility Toggler cannot bring back an object a sequence destroyed', { skip }, async () => {
  const { lvl, packages } = await load1a();
  const shown: [number, boolean][] = [];
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: (uid, v) => void shown.push([uid, v]),
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_1A });
  world.start();
  world.update(0);
  // Sequence 5db4: the booth door 512a is destroyed (12) and hidden through Toggler 68aa at 0 s;
  // the toggler's Show at 5.5 s must not put the door (and its collision) back.
  world.send(0x68aa, 2, 0x5db4);
  world.send(0x512a, 12, 0x5db4);
  world.update(0.1);
  shown.length = 0;
  world.send(0x68aa, 1, 0x5db4);
  world.update(0.1);
  assert.equal(world.get(0x512a)!.destroyed, true);
  assert.ok(!shown.some(([u, v]) => u === 0x512a && v), 'destroyed door shown again');
  assert.equal(world.get(0x512a)!.visible, false);
});

test('Switch motion: a travel with speed 0 (1b door 6433, starts open) still has its open pose', () => {
  const sw = (v55: number, v57: number, v58: number) => {
    const values: unknown[] = [];
    values[55] = v55;
    values[56] = 1;
    values[57] = v57;
    values[58] = v58;
    return switchMotion({ values } as unknown as Entity);
  };
  const m = sw(0, 95, 0);
  assert.equal(m.kind, 'rotate');
  assert.ok(Math.abs(m.travel - (95 * Math.PI) / 180) < 1e-6);
  assert.ok(m.duration > 0 && m.duration <= 0.1);
  // Unchanged: the speed sign gives the direction; no travel = no motion.
  assert.ok(Math.abs(sw(0, 270, -45).travel - (-90 * Math.PI) / 180) < 1e-6);
  assert.equal(sw(1, 0, 5).kind, 'none');
});

test('Pushable: walking away while holding it pulls it at its own speed (the grab holds)', async () => {
  const THREE = await import('three/webgpu');
  const { Props } = await import('../src/game/world/props');
  const uid = 0x8a46;
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.matrix.makeTranslation(0, 0, 0);
  const pivot = new THREE.Group();
  root.add(pivot);
  pivot.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)));
  const d = { uid, root, pivot, local: [], base: root.matrix.clone(), collides: true, visible: true, solid: true } as never;
  const w = { uid, cls: 'Pushable', e: { values: [], links: [] }, pos: [0, 0, 0], destroyed: false, enabled: true, visible: true, s: {} };
  const world = { ents: new Map([[uid, w]]), of: () => [], fire: () => {}, get: () => w, handlers: [] };
  const player = { position: new THREE.Vector3(0, 0, 1.2), motor: { position: { x: 0, y: 0, z: 1.2 } } };
  const dyn = {
    objects: new Map([[uid, d]]),
    bounds: (_d: unknown, out: InstanceType<typeof THREE.Box3>) => out.setFromObject(pivot),
    refreshCollision: () => {},
  };
  const props = new Props({ world, dyn, fx: {}, packages: new Map(), collision: null, damage: () => undefined, playSound: () => undefined, setLight: () => {}, player: () => player, timeScale: () => 1 } as never);
  assert.equal(props.toggleGrab(uid), true);
  // The player backs off 4 m in one second (faster than the crate's 1.2 m/s).
  for (let i = 0; i < 60; i++) {
    player.position.z += 4 / 60;
    player.motor.position.z = player.position.z;
    props.update(1 / 60);
    player.position.set(player.motor.position.x, 0, player.motor.position.z);
  }
  assert.equal(props.grabbed(), uid, 'the grab let go');
  const z = root.matrix.elements[14];
  assert.ok(z > 0.9 && z < 1.3, `crate moved ${z.toFixed(2)} m (1.2 m/s for 1 s)`);
  assert.ok(Math.abs(player.position.z - z - 1.2) < 0.05, `player kept at the grab distance (${(player.position.z - z).toFixed(2)})`);
});

test('Behavior Changer chains survive a save: the p17 still fires after a load', async () => {
  const { Director: ActorDirector } = (await import('../src/game/actors/director')) as unknown as { Director: new (...a: unknown[]) => { snapshot(): { chains?: number[][] }; restore(s: unknown): void; update(dt: number, env: unknown): void } };
  // 1b: BC 7ebb hands Hermes (7eb4) his conversation; its p17 (On) goes to Relay 7ecc.
  const bc = { uid: 0x7ebb, className: 'Behavior Changer', values: Object.assign([], { 0: 1, 11: 1, 17: 1 }), links: [0x7eb4, 0x7ecc], props: {} } as unknown as Entity;
  const hermes = { uid: 0x7eb4, alive: true, needsInit: false, onChainDone: () => {}, chainOf: 0x7ebb } as { uid: number; alive: boolean; needsInit: boolean; onChainDone?: () => void; chainOf?: number };
  const sent: [number, number, number][] = [];
  const manager = { actors: [hermes], get: (u: number) => (u === hermes.uid ? hermes : undefined), clones: new Map() };
  const hooks = { send: (u: number, m: number, f: number) => void sent.push([u, m, f]), log: () => {}, playerUid: 0x5818, player: () => ({ x: 0, y: 0, z: 0 }), visibleToPlayer: () => false, isDestroyed: () => false };
  const d = new ActorDirector([bc], new Map([[bc.uid, bc]]), new Map(), manager, hooks, {});
  const save = JSON.parse(JSON.stringify(d.snapshot()));
  assert.deepEqual(save.chains, [[0x7eb4, 0x7ebb]]);
  // Load: the actor comes back without the callback (a closure); the director puts it back.
  hermes.onChainDone = undefined;
  hermes.chainOf = undefined;
  const d2 = new ActorDirector([bc], new Map([[bc.uid, bc]]), new Map(), manager, hooks, {});
  d2.restore(save);
  d2.update(0.016, {});
  assert.equal(typeof hermes.onChainDone, 'function');
  hermes.onChainDone!();
  assert.deepEqual(sent, [[0x7ecc, 1, 0x7ebb]]);
});
