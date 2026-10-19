// Chapter 3 (3a / 3b YardCellBlock) rules found by the playthrough (docs/playthrough.md
// "Chapter 3"): KillEnemies object targets, searchlight Mountables and their beams on Detectors
// with filter 4, Fire out of the static level. Data tests are skipped without game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv, type PropTargetInfo } from '../src/game/actors/actor';
import type { Behavior } from '../src/game/actors/behaviors';
import type { CreatureKind } from '../src/game/actors/kinds';
import { targetWeights } from '../src/game/actors/targeting';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { readModel } from '../src/formats/model';
import { World, type WorldHooks } from '../src/game/world/logic';
import { dynamicObjectUids } from '../src/game/world/dynamic';
import { NavGraph } from '../src/game/actors/nav';
import { CollisionWorld } from '../src/app/physics';
import { moverVolume, npcMotorConfig } from '../src/game/actors/mover';
import { coneShape, conePoints, coneTemplateOf, hardpointLocal } from '../src/game/world/searchlight';
import { nodeFS, readSrsc, skip } from './helpers';

// --- KillEnemies p3: a level object as the target ------------------------------------------------

function rig(): SkinnedModel {
  const bones = [-1, 0].map((parent, index) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, index * 0.5, 0, 1]);
    return { index, hash: 0x1000 + index, name: `b${index}`, parent, children: [] as number[], inverseBind: m, bindWorld: m, position: [0, index ? 0.5 : 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
  });
  bones[0].children.push(1);
  const skeleton: Skeleton = { version: 1, vertexCount: 0, bones, byHash: new Map(bones.map((b) => [b.hash, b.index])), sphere: { center: [0, 0, 0], radius: 1 }, skinIndex: new Uint16Array(), skinWeight: new Float32Array() };
  return {
    ref: { pkg: 0, id: 0 },
    animSet: 0,
    model: { ref: { pkg: 0, id: 0 }, vertexCount: 0, source: new Uint32Array(), positions: new Float32Array([0, 0, 0, 0, 1.8, 0]), normals: new Float32Array(), uvs: new Float32Array(), submeshes: [], materials: [] },
    skeleton,
    skinIndex: new Uint16Array(),
    skinWeight: new Float32Array(),
  } as unknown as SkinnedModel;
}

const clip = (id: number, duration = 1): AnimClipData => ({
  id,
  animSet: 0,
  duration,
  flags: 0,
  blendTime: 0.2,
  rate: 1,
  links: [],
  tracks: [0, 1].map((b) => ({ boneHash: 0x1000 + b, format: 0xc0, times: new Float32Array([0, duration]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number] })),
});
const CLIPS = [clip(0), clip(1, 0.5), clip(2), clip(3, 1)];

function slayer(): Actor {
  const skinned = rig();
  const kind = {
    key: 'test:Slayer',
    template: { pkg: 0, id: 0 },
    className: 'Slayer',
    skinned,
    proto: new Character(skinned, CLIPS),
    idle: 0,
    walk: -1,
    run: -1,
    attacks: [{ clip: 3, reach: 1.5, minReach: 0, maxDy: 0, scaled: false, damage: 10, hitTimes: [0.5], scale: 2 }],
    hits: [1],
    deaths: [2],
    fall: -1,
    land: -1,
    events: CLIPS.map(() => ({ hitTimes: [], sounds: [] }) as never),
    speeds: CLIPS.map(() => 0),
    height: 1.8,
    bottom: 0,
    anchored: true,
    radius: 0.4,
    moveSpeed: 1.5,
    runSpeed: 3,
    hostile: true,
    maxHealth: 100,
    decor: false,
  } as unknown as CreatureKind;
  return new Actor(kind, { x: 0, y: 0, z: 0 }, 0);
}

// 3a KillEnemiesBehavior 3ba8: no enemy team, the fence boards 329c..329e in p3, p17 999.
const W = targetWeights([[], [], [], [0x329e, 0x329d, 0x329c], [], 1, 0, 45, 10, 7.5, 50, 180, 2, 2, 10, null, 10, 999, 0.75, 1, 0.5, 0, 0, -0.8, 1, 0]);
const KILL_FENCE = { cls: 'KillEnemiesBehavior', next: [], kind: 'kill', targets: [0x329e, 0x329d, 0x329c], enemies: [], allies: [], range: 45, alwaysSee: 7.5, keep: 50, fov: 180, los: false, reevalMin: 2, reevalRand: 2, weights: W } as unknown as Extract<Behavior, { kind: 'kill' }>;

test('KillEnemies p3 lists level objects: the Slayer goes for the fence board and hits it until it breaks', () => {
  const a = slayer();
  a.profile = { team: '10:234', kill: KILL_FENCE, priority: 0.5, maxAttackers: 4 };
  a.hostile = true;
  a.setBehavior(KILL_FENCE);
  let board: PropTargetInfo | undefined = { x: 0, y: 1, z: -1.2, bottom: 0, radius: 0.3, priority: 0.5, maxAttackers: 4, healthFrac: 1 };
  const hits: { uid: number; amount: number }[] = [];
  const e: ActorEnv = {
    world: { raycast: () => null } as never,
    nav: null,
    player: { position: new THREE.Vector3(30, 0, 30) } as never,
    playerAlive: true,
    playerUid: 2,
    time: 0,
    actors: [a],
    damagePlayer: () => assert.fail('the player is no target of 3ba8'),
    damageActor: () => {},
    propTarget: (uid) => (uid === 0x329d ? board : undefined),
    damageProp: (uid, amount) => hits.push({ uid, amount }),
    sound: () => {},
    onDeath: () => {},
    clip: () => -1,
    entity: () => undefined,
    send: () => {},
    say: () => 0,
  };
  for (let t = 0; t < 3; t += 1 / 30) {
    e.time += 1 / 30;
    a.update(1 / 30, e);
    a.animate(1 / 30);
  }
  assert.equal(a.currentTarget?.prop, 0x329d, a.activity);
  assert.ok(hits.length > 0 && hits.every((h) => h.uid === 0x329d && h.amount === 10), JSON.stringify(hits));
  // Broken: the target is dropped.
  board = undefined;
  for (let t = 0; t < 1; t += 1 / 30) {
    e.time += 1 / 30;
    a.update(1 / 30, e);
  }
  assert.equal(a.currentTarget, undefined, a.activity);
});

// --- searchlight beams ---------------------------------------------------------------------------

test('searchlight cone: the axis and a ring at the half-angle are sampled out to its length', () => {
  const s = coneShape([0, 0, -0.41, 5.81, 0, -21.06, -5.81, 0, -21.06, 0, 5.81, -21.06]);
  assert.ok(Math.abs(s.length - 21.06) < 1e-6 && Math.abs(s.near - 0.41) < 1e-6 && Math.abs(s.radius - 5.81) < 1e-3);
  const c = { uid: 1, origin: new THREE.Vector3(0, 10, 0), dir: new THREE.Vector3(0, 0, 1), length: 21.06, half: Math.atan2(5.81, 21.06) };
  const pts = conePoints(c, s.near);
  // 3a's pit Detector 13f8 seen from searchlight cc3: 17 m down the beam is inside.
  const inBox = (p: number[], ctr: number[], h: number) => p.every((v, k) => Math.abs(v - ctr[k]) <= h);
  assert.ok(pts.some((p) => inBox(p, [0, 10, 17], 1)), 'a point on the axis 17 m out');
  assert.ok(!pts.some((p) => inBox(p, [0, 10, 23], 1)), 'nothing past the cone');
  assert.ok(!pts.some((p) => inBox(p, [12, 10, 10], 1)), 'nothing outside its angle');
});

async function level3a() {
  const LEVEL = 'LEVELS/3 YardCellBlock/3a YardCellBlock.lvl';
  const lvl = readSrsc(LEVEL);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(LEVEL), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  return { LEVEL, lvl, packages };
}

test('retail: searchlight Mountables spawn a 21 m cone that shines along the model +Z from hardpoint 3', { skip }, async () => {
  const { packages } = await level3a();
  // 3a walkway lights: p49 Object Generator 7:2896 -> Spot Light 7:2895, Spot Light Cone 7:2902.
  assert.deepEqual(coneTemplateOf(packages, { pkg: 7, id: 2896 }), { pkg: 7, id: 2902 });
  const m = readModel(packages, { pkg: 3, id: 362 })!;
  const s = coneShape(m.positions);
  assert.ok(Math.abs(s.length - 21.06) < 0.05 && Math.abs(s.radius - 5.81) < 0.05, JSON.stringify(s));
  // Model 7:1244 hardpoint 3: 1.27 m up, its frame turned half round: the cone's -Z is the model's +Z.
  const hp = hardpointLocal(packages, { pkg: 7, id: 1244 }, 3)!;
  const e = hp.elements;
  assert.ok(Math.abs(e[13] - 1.27) < 0.02, `height ${e[13]}`);
  assert.deepEqual([-e[8], -e[9], -e[10]].map((v) => Math.round(v) + 0), [0, 0, 1]);
});

test('retail 3a: a light cone sets off Detector 13f8 (filter 4: Spot Light Cones), the player does not', { skip }, async () => {
  const { LEVEL, lvl, packages } = await level3a();
  let cone: [number, number, number][] = [];
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
    lightCones: () => (cone.length ? [{ uid: 0xcc3, points: cone }] : []),
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL });
  world.start();
  world.update(0);
  const got: string[] = [];
  world.subscribe('*', (msg, from, to) => got.push(`${to.toString(16)}:${msg}:${from.toString(16)}`));
  // The player standing in it: nothing.
  feet = [291, 98.4, 402];
  world.update(0.05);
  world.update(0.05);
  assert.equal(world.get(0x13f8)!.s.fired ?? 0, 0);
  // The beam on it: On to its links (Relay 4364 decrements Count Down 1b7a; Relay 436c destroys
  // the pit's Object Cloner 436d), with the Mountable as the sender.
  feet = [0, -1000, 0];
  cone = [[291, 99.2, 402]];
  world.update(0.05);
  assert.equal(world.get(0x13f8)!.s.fired, 1);
  assert.ok(got.includes('4364:1:cc3') && got.includes('436c:1:cc3'), got.slice(0, 10).join(' '));
});

test('retail 3a: Fires are dynamic objects (drawn by their class, never solid), not static level', { skip }, async () => {
  const { lvl, packages } = await level3a();
  const dyn = dynamicObjectUids(lvl, packages);
  // 3762: the unlit card in the fence gap (lit on the revisit, Relay 3fa8) that stood solid.
  assert.ok(dyn.has(0x3762));
  const fires = parseEntities(lvl, packages).filter((e) => e.className === 'Fire');
  assert.ok(fires.filter((e) => dyn.has(e.uid)).length >= 90, 'the baked fires');
});

// --- WaypointBehavior: MoveTo failing ends it -----------------------------------------------------

test('a Waypoint leg with neither a straight walk nor a graph path ends the WaypointBehavior (3a wall CartWheelers)', () => {
  // A fence along z = 0 that bodies (rays, spheres) do not cross. Waypoint 0x11 is behind it
  // (z = -1), the next one, 0x12, beyond it (z = 5).
  const crosses = (oz: number, dz: number, len: number) => {
    if (Math.abs(dz) < 1e-9) return undefined;
    const t = -oz / dz;
    return t > 0 && t < len ? t : undefined;
  };
  const hit = (t: number | undefined) => (t === undefined ? null : { distance: t, point: [0, 0, 0], normal: [0, 0, -1] });
  const world = {
    raycast: (_ox: number, _oy: number, oz: number, dx: number, dy: number, dz: number, max = Infinity) => {
      const l = Math.hypot(dx, dy, dz);
      return hit(crosses(oz, dz / l, max));
    },
    sphereCast: (_ox: number, _oy: number, oz: number, r: number, dx: number, dy: number, dz: number, len: number) => {
      const l = Math.hypot(dx, dy, dz);
      const t = crosses(oz + Math.sign(dz) * r, dz / l, len);
      return hit(t);
    },
  };
  const run = (joined: boolean) => {
    const nav = new NavGraph([]);
    // 0: the strip behind the fence; 1, 2: the yard. `joined`: a gate edge 0 - 1.
    nav.nodes.push({ uid: 0x20, x: 0, y: 0, z: -4, radius: 0.5, edges: joined ? [1] : [], ceiling: false });
    nav.nodes.push({ uid: 0x21, x: 0, y: 0, z: 2, radius: 0.5, edges: joined ? [0, 2] : [2], ceiling: false });
    nav.nodes.push({ uid: 0x22, x: 0, y: 0, z: 6, radius: 0.5, edges: [1], ceiling: false });
    const a = slayer();
    // At Waypoint 0x11 already (the walk there is plain steering).
    a.motor.position.z = -1;
    const wp = (uid: number, z: number, next: number[]) => ({ uid, className: 'Waypoint', position: [0, 0, z * 2048], rotation: [0, 0, 0], links: next, values: [0, 0, 1, 0, 0, 0.2, 0] });
    const ents = new Map<number, unknown>([
      [0x11, wp(0x11, -1, [0x12])],
      [0x12, wp(0x12, 5, [])],
    ]);
    const WALK = { cls: 'WaypointBehavior', kind: 'waypoint', next: [0x99], first: 0x11, fight: 2, escort: [], near: 5, far: 15, keepPath: true } as unknown as Behavior;
    const JUMP = { cls: 'IdleBehavior', kind: 'idle', next: [], fidgets: [], fidgetMin: 4, fidgetMax: 12 } as unknown as Behavior;
    a.profile = { team: '10:234', priority: 0.5, maxAttackers: 4 } as never;
    a.setBehavior(WALK);
    const e = {
      world,
      nav,
      player: { position: new THREE.Vector3(30, 0, 30) },
      playerAlive: true,
      playerUid: 2,
      time: 0,
      actors: [a],
      damagePlayer: () => {},
      damageActor: () => {},
      sound: () => {},
      onDeath: () => {},
      clip: () => -1,
      entity: (u: number) => ents.get(u),
      send: () => {},
      say: () => 0,
      behaviors: { fromPlaced: (u: number) => (u === 0x99 ? JUMP : undefined) },
    } as unknown as ActorEnv;
    for (let t = 0; t < 1; t += 1 / 30) {
      e.time += 1 / 30;
      a.update(1 / 30, e);
    }
    return a;
  };
  // No way into the yard: the walk ends at the fence and the next behaviour (the jump) runs.
  assert.equal(run(false).behavior?.cls, 'IdleBehavior');
  // A gate joins the strip to the yard: the walk goes on.
  assert.equal(run(true).behavior?.cls, 'WaypointBehavior');
});

test('a Waypoint leg the body is stuck on, on the graph route too, ends the WaypointBehavior (6a Slayer 2337 under a log)', () => {
  // A floor, and a log across the way 1.8 m up: the straight-walk sweeps (0.8 m, 1.35 m) pass
  // under it, the graph has an edge under it, but a Slayer's 3.15 m stack does not fit.
  const quad = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const q = [[3, 2, 6, 7], [0, 4, 5, 1], [0, 3, 7, 4], [1, 5, 6, 2], [0, 1, 2, 3], [4, 7, 6, 5]];
    const idx: number[] = [];
    for (const [a, b, c, d] of q) idx.push(a, b, c, a, c, d);
    return { positions: new Float32Array(p.flat()), indices: new Uint32Array(idx) } as never;
  };
  const world = new CollisionWorld({ parts: [quad(-20, -1, -20, 20, 0, 20), quad(-10, 1.8, -0.2, 10, 2.6, 0.2)] });
  const nav = new NavGraph([]);
  nav.nodes.push({ uid: 0x20, x: 0, y: 0, z: -4, radius: 0.5, edges: [1], ceiling: false });
  nav.nodes.push({ uid: 0x21, x: 0, y: 0, z: 4, radius: 0.5, edges: [0], ceiling: false });
  const a = slayer();
  (a.kind as { anchored: boolean }).anchored = false;
  const node = (first: number, next: number, y: number, r: number) => ({ first, next, center: [0, y, 0] as [number, number, number], radius: r });
  Object.assign(a.motor.cfg, npcMotorConfig(moverVolume([node(1, 0, 1.2, 1.95), node(0, 3, 0, 0.65), node(0, 0, 2.5, 0.65), node(0, 2, 1.3, 0.65)], 1, 0.8, 75)!));
  a.settle(world, false);
  a.motor.position.z = -3;
  const wp = (uid: number, z: number, next: number[]) => ({ uid, className: 'Waypoint', position: [0, 0, z * 2048], rotation: [0, 0, 0], links: next, values: [0, 0, 1, 0, 0, 0.2, 0] });
  const ents = new Map<number, unknown>([[0x11, wp(0x11, -3, [0x12])], [0x12, wp(0x12, 6, [])]]);
  const WALK = { cls: 'WaypointBehavior', kind: 'waypoint', next: [0x99], first: 0x11, fight: 2, escort: [], near: 5, far: 15, keepPath: true } as unknown as Behavior;
  const IDLE = { cls: 'IdleBehavior', kind: 'idle', next: [], fidgets: [], fidgetMin: 4, fidgetMax: 12 } as unknown as Behavior;
  a.profile = { team: '10:234', priority: 0.5, maxAttackers: 4 } as never;
  a.setBehavior(WALK);
  const e = {
    world, nav, player: { position: new THREE.Vector3(30, 0, 30) }, playerAlive: true, playerUid: 2, time: 0, actors: [a],
    damagePlayer: () => {}, damageActor: () => {}, sound: () => {}, onDeath: () => {}, clip: () => -1,
    entity: (u: number) => ents.get(u), send: () => {}, say: () => 0,
    behaviors: { fromPlaced: (u: number) => (u === 0x99 ? IDLE : undefined) },
  } as unknown as ActorEnv;
  for (let t = 0; t < 15; t += 1 / 30) {
    e.time += 1 / 30;
    a.update(1 / 30, e);
  }
  assert.ok(a.position.z < -0.2, `held by the log (z ${a.position.z.toFixed(2)})`);
  assert.equal(a.behavior?.cls, 'IdleBehavior', 'the walk failed and the next behaviour runs');
});

test('retail 3a: the wall CartWheelers walk a strip whose Move Nodes join nothing, then jump (WaypointBehavior 26ae -> JumpBehavior 3fd7)', { skip }, async () => {
  const { lvl, packages } = await level3a();
  const ents = parseEntities(lvl, packages);
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  const nav = new NavGraph(ents);
  const strip = nav.byUid.get(0x3fdd)!, yard = nav.byUid.get(0x444c)!;
  assert.equal(nav.path(strip, yard), null);
  assert.deepEqual(byUid.get(0x26ae)!.links, [0x3fd7]);
  assert.equal(byUid.get(0x3fd7)!.className, 'JumpBehavior');
  // Its first Waypoint 1fcc is behind the fence, the next (3fd9) in the yard.
  assert.deepEqual(byUid.get(0x1fcc)!.links, [0x3fd9]);
});

test('retail 3a: a cloned creature falling into the west-yard pit is the sender Detector 1b7c gives its Damage Action Object', { skip }, async () => {
  const { LEVEL, lvl, packages } = await level3a();
  // A copy of Slayer 1fbe (Object Cloner 4366) has its own uid (manager.ts clone), as the world
  // hook passes it (world.ts actors()).
  const copy = 0x7f000005;
  let at: [number, number, number] = [280, 97.7, 403.3];
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998.4, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    actors: () => [{ uid: copy, position: at, className: 'Slayer' }],
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL });
  world.start();
  world.update(0);
  const got: string[] = [];
  world.subscribe('*', (msg, from, to) => got.push(`${to.toString(16)}:${msg}:${from.toString(16)}`));
  world.update(0.05);
  assert.ok(!got.some((g) => g.startsWith('1b7d:')));
  // At the bottom of the pit (y 84.3): Damage Action Object 1b7d (200, p0 0: the sender) gets On
  // from the copy itself.
  at = [294.4, 84.3, 405];
  world.update(0.05);
  assert.ok(got.includes(`1b7d:1:${copy.toString(16)}`), got.slice(0, 12).join(' '));
});
