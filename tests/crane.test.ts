// Crane hoist (src/game/levels/crane.ts), decoded from Suffering.rfl (update 0x10012730,
// control 0x10012b90): ratios of the posed cable length, speeds p31 down / p32 up, Increment /
// Decrement raising the hook, the retail placements.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CraneHoist, craneParams } from '../src/game/levels/crane';

// 4b's 7a26 (indices as placed: p26 2, p27 3, p28 1, p29 5, p30 1, p31 2.5, p32 1.5, p35 [3],
// p36 [23:856], p37 8, p38 9, p41 23:57, p44..p46 3:326 / 3:325 / 3:327).
const values: unknown[] = [];
Object.assign(values, {
  26: 2, 27: 3, 28: 1, 29: 5, 30: 1, 31: 2.5, 32: 1.5,
  35: [3], 36: [{ pkg: 23, id: 856 }], 37: 8, 38: 9,
  41: { pkg: 23, id: 57 },
  44: [{ pkg: 3, id: 326 }], 45: [{ pkg: 3, id: 325 }], 46: [{ pkg: 3, id: 327 }],
});

test('crane params: cable bones, lengths, speeds, the hung hook block, inputs', () => {
  const p = craneParams(values);
  assert.equal(p.cableTop, 2);
  assert.equal(p.cableEnd, 3);
  assert.deepEqual([p.minLen, p.maxLen, p.startLen, p.downSpeed, p.upSpeed], [1, 5, 1, 2.5, 1.5]);
  assert.deepEqual(p.hung, [{ bone: 3, template: { pkg: 23, id: 856 } }]);
  assert.deepEqual(p.inputs, [8, 9]);
  assert.deepEqual(p.pose, { pkg: 23, id: 57 });
});

test('the hoist works in ratios of the posed cable: the cable hangs at p30 m from the start', () => {
  const h = new CraneHoist(craneParams({ ...values, 30: 4.1 } as unknown[]), 2);
  assert.equal(h.current, 4.1 / 2);
  assert.equal(h.cable, 4.1);
  assert.equal(h.min, 0.5);
  assert.equal(h.max, 2.5);
  assert.equal(h.update(0.1), undefined, 'the target starts at the current ratio: no motion');
});

test('Increment / Decrement raise the hook to p28 at p32 m/s; lowering runs at p31', () => {
  const h = new CraneHoist(craneParams({ ...values, 30: 4 } as unknown[]), 2);
  h.control(-1);
  assert.equal(h.target, h.min);
  assert.equal(h.update(0.5), 'start');
  assert.ok(Math.abs(h.cable - (4 - 1.5 * 0.5)) < 1e-9, `${h.cable}`);
  let ev;
  for (let i = 0; i < 100 && ev !== 'stop'; i++) ev = h.update(0.1);
  assert.equal(ev, 'stop');
  assert.equal(h.cable, 1);
  h.control(1);
  assert.equal(h.target, h.max);
  h.update(0.1);
  h.update(0.2);
  assert.ok(Math.abs(h.cable - (1 + 2.5 * 0.3)) < 1e-9, `lowering at p31: ${h.cable}`);
});

// --- Retail 4b: Detector filter 5 is the Crane's hung object; Mountable p30 names the crane ------

import { dirname } from '../src/app/gamefs';
import { loadPackages } from '../src/app/loader';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { World, type WorldHooks } from '../src/game/world/logic';
import { nodeFS, readSrsc, skip } from './helpers';

const LEVEL_4B = 'LEVELS/4 Quarry/4b Quarry.lvl';

async function level4b() {
  const lvl = readSrsc(LEVEL_4B);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(LEVEL_4B), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages };
  } finally {
    console.warn = warn;
  }
}

test('retail 4b: the crane controls name their cranes (Mountable p30), the cranes hang the boulder 23:856 on bone 3', { skip }, async () => {
  const { lvl, packages } = await level4b();
  const ents = new Map(parseEntities(lvl, packages).map((e) => [e.uid, e]));
  for (const [mount, crane] of [[0x7bd9, 0x7a26], [0x7c1d, 0x7a2f], [0x7c2f, 0x7a37]]) {
    assert.equal(ents.get(mount)!.values[30], crane);
    const p = craneParams(ents.get(crane)!.values);
    assert.deepEqual(p.hung, [{ bone: 3, template: { pkg: 23, id: 856 } }]);
    assert.equal(ents.get(crane)!.values[39], 3, 'the hook bone the Detectors test');
  }
  assert.equal(ents.get(0x7da5)!.values[1], 5, 'Detector 7da5: filter 5 (Crane)');
});

test('retail 4b: the crane hook over Detector 7da5 (filter 5) plays "Boulder"; the player does not', { skip }, async () => {
  const { lvl, packages } = await level4b();
  let hook: [number, number, number][] = [];
  let feet: [number, number, number] = [0, -1000, 0];
  const hooks: WorldHooks = {
    player: () => ({ feet, eye: [feet[0], feet[1] + 1.6, feet[2]], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    cranes: () => (hook.length ? [{ uid: 0x7a26, points: hook }] : []),
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_4B });
  world.start();
  world.update(0);
  const got: string[] = [];
  world.subscribe('*', (msg, from, to) => got.push(`${to.toString(16)}:${msg}:${from.toString(16)}`));
  feet = [383.8, 103, 519.8];
  world.update(0.05);
  world.update(0.05);
  assert.ok(!got.some((g) => g.startsWith('7ef0:')), 'the player in the volume does nothing');
  feet = [0, -1000, 0];
  hook = [[383.8, 104.9, 519.8]];
  world.update(0.05);
  assert.ok(got.includes('7ef0:1:7a26') && got.includes('7da4:1:7a26'), got.slice(0, 12).join(' '));
});

// --- Collision of the hung object, saves (src/game/levels/skinned-props.ts) ---------------------

import * as THREE from 'three/webgpu';
import { CollisionWorld } from '../src/app/physics';
import { findEntry } from '../src/formats/model';
import { hasSkeleton } from '../src/formats/skeleton';
import { SkinnedProps, hungLocalParts, hungWorldParts } from '../src/game/levels/skinned-props';

test('a hung object collides as its model placed at the bone: local triangles, then the world matrix', () => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
  geo.setIndex([0, 1, 2]);
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(geo);
  mesh.position.set(0, -4, 0);
  root.add(mesh);
  const local = hungLocalParts(root);
  assert.deepEqual([...local[0].positions], [0, -4, 0, 1, -4, 0, 0, -4, 1], 'the mesh offset is kept in the model space');
  assert.deepEqual([...local[0].indices], [0, 1, 2]);
  const m = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 100, 20);
  const w = hungWorldParts(local, m);
  const p = [...w[0].positions].map((v) => Math.round(v * 1e4) / 1e4);
  assert.deepEqual(p.slice(0, 6), [10, 96, 20, 10, 96, 19]);
});

const loadRetail4b = async () => {
  const { lvl, packages } = await level4b();
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998.4, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_4B });
  world.start();
  const col = new CollisionWorld({ parts: [] });
  const props = new SkinnedProps(world, packages, LEVEL_4B, undefined, undefined, () => col);
  return { world, col, props, packages };
};

test('retail 4b: the crane is skinned without a collision record, its pallet 23:856 is a static model with one', { skip }, async () => {
  const { packages } = await level4b();
  const mdu = (pkg: number) => (packages.get(pkg) as { mdu?: import('../src/formats/srsc').SrscFile } | undefined)?.mdu;
  assert.equal(hasSkeleton(mdu(23), 630), true, 'Crane 23:630 is skinned');
  assert.equal(!!findEntry(mdu(23), 7, 630), false, 'and carries no type-7 record: the tower and jib block nothing');
  assert.equal(hasSkeleton(mdu(23), 580), false, 'the pallet 23:580 is static');
  assert.ok(findEntry(mdu(23), 7, 580), 'with its type-7 record: it collides');
});

test('retail 4b: Crane 7a2f\'s pallet is a body at the platforms\' height when lowered to p29, and swings with the slew', { skip }, async () => {
  const { world, col, props } = await loadRetail4b();
  const c = props.cranes.get(0x7a2f)!;
  assert.equal(c.bodies.length, 1, 'one body for the one hung object');
  const body = c.bodies[0].body!;
  assert.equal(col.isDynamicEnabled(body), true);
  // Lowered to p29 = 4.1 m: the pallet's top meets the controls' platform (Mountable 7c1d's
  // height) within a step (its deck is 105.3 in the middle, 105.07 at the rim).
  props.load({ '7a2f': { current: c.hoist.max, target: c.hoist.max, slew: 0 } });
  const deck = world.get(0x7c1d)!.e.position[1] / 2048;
  const b0 = col.dynamicBounds(body)!;
  const mid = [(b0.min[0] + b0.max[0]) / 2, (b0.min[2] + b0.max[2]) / 2];
  const g = col.groundQuery(mid[0], 108, mid[1], 0.2, 10);
  assert.ok(g && Math.abs(g.height - deck) < 0.3, `pallet top ${g?.height} vs the deck ${deck}`);
  // Swung to the slew's end (-35 deg, Mountable p38): it hangs by the ending platform's edge (x 393).
  props.load({ '7a2f': { current: c.hoist.max, target: c.hoist.max, slew: (-35 * Math.PI) / 180 } });
  const b1 = col.dynamicBounds(body)!;
  assert.ok(b1.min[0] < 395.5 && b1.min[0] > 394, `west edge ${b1.min[0]}`);
  assert.ok(b1.min[0] < b0.min[0] - 7, 'the body moved with the slew');
  // Hidden with the crane.
  world.get(0x7a2f)!.visible = false;
  props.update(0);
  assert.equal(col.isDynamicEnabled(body), false);
  world.get(0x7a2f)!.visible = true;
  props.update(0);
  assert.equal(col.isDynamicEnabled(body), true);
});

test('retail 4b: saves keep each crane\'s hoist ratios and slew; the lowering sweep starts under the pallet, past its own body', { skip }, async () => {
  const { col, props } = await loadRetail4b();
  const c = props.cranes.get(0x7a2f)!;
  props.load({ '7a2f': { current: 0.3, target: 0.4, slew: -0.5 } });
  const s = props.save();
  assert.deepEqual(s['7a2f'], { current: 0.3, target: 0.4, slew: -0.5 });
  assert.ok(s['7a26'] && s['7a37'], 'every crane');
  const fresh = await loadRetail4b();
  fresh.props.load(s);
  const f = fresh.props.cranes.get(0x7a2f)!;
  assert.deepEqual([f.hoist.current, f.hoist.target, f.slew], [0.3, 0.4, -0.5]);
  assert.deepEqual(fresh.col.dynamicBounds(f.bodies[0].body!), col.dynamicBounds(c.bodies[0].body!), 'the pallet where it was saved');
  // Lowering: the sweep is asked from under the pallet with the pallet's own body out of the query.
  const bottom = col.dynamicBounds(c.bodies[0].body!)!.min[1];
  let asked: { y: number; own: boolean } | undefined;
  const mount = { e: { values: Object.assign([], { 36: 1, 38: 35, 40: 10 }) } };
  props.driveCrane(mount, 0x7a2f, 1, 0, 1 / 60, (at) => ((asked = { y: at.y, own: col.isDynamicEnabled(c.bodies[0].body!) }), 1));
  assert.ok(asked && asked.y <= bottom + 1e-3 && !asked.own, JSON.stringify(asked));
  assert.equal(col.isDynamicEnabled(c.bodies[0].body!), true, 'on again after the sweep');
  assert.ok(Math.abs(c.hoist.target - (0.3 + 1 / c.hoist.length)) < 1e-9, 'down to what lies 1 m under it');
});
