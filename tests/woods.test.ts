// Chapter 6 (6a The Woods / 6b The Beach) rules found by the playthrough (docs/playthrough.md
// "6 Woods"): an object target's own body does not hide it from the picking character, and the
// modelless truck jack in 6a is used by its anchor. Data tests are skipped without game data.

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
import { viewOnAnchor } from '../src/game/world/interact';
import { ballisticLaunch, flightHeight, throwElevation } from '../src/game/actors/throw';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { nodeFS, readSrsc, skip } from './helpers';

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

function shooter(): Actor {
  const skinned = rig();
  const kind = {
    key: 'test:Unspeakable NPC',
    template: { pkg: 0, id: 0 },
    className: 'Unspeakable NPC',
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
  return new Actor(kind, { x: 0, y: 8, z: 0 }, 0);
}

// 6a KillEnemiesBehavior 142c: the stranger 54b's only target is the propane tank 1432 (p3),
// with a line-of-sight test (p6) and a full view; p5 cleared here, so the choice needs the clear
// line (with p5 = 1, as in 142c, an unseen p3 target is taken anyway).
const W = targetWeights([[], [], [], [0x1432], [], 0, 1, 45, 10, 0, 50, 360, 2, 2, 10, null, 10, 999, 0.75, 1, 0.5, 0, 0, -0.8, 1, 0]);
const KILL_TANK = { cls: 'KillEnemiesBehavior', next: [], kind: 'kill', targets: [0x1432], enemies: [], allies: [], range: 45, alwaysSee: 0, keep: 50, fov: 360, los: true, reevalMin: 2, reevalRand: 2, weights: W } as unknown as Extract<Behavior, { kind: 'kill' }>;

test('KillEnemies object target: its own body does not hide it (6a: the stranger and the propane tank 1432)', () => {
  const a = shooter();
  a.profile = { team: '10:212', kill: KILL_TANK, priority: 0.5, maxAttackers: 4 };
  a.hostile = true;
  a.setBehavior(KILL_TANK);
  // The tank lies 8 m below and 10 m ahead; every ray at it (centre, 0.5 and 0.9 m lower) meets
  // its own collision (body 210, a 1.2 m sphere) before its point, and nothing else.
  const tank: PropTargetInfo = { x: 0, y: 1.2, z: -10, bottom: 0, radius: 1.2, priority: 0.1, maxAttackers: 4, healthFrac: 1, body: 210 };
  const centre = new THREE.Vector3(tank.x, tank.y, tank.z);
  const world = {
    raycast: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max = Infinity) => {
      // Distance along the ray to the sphere of radius 0.6 round the centre.
      const o = new THREE.Vector3(ox, oy, oz), d = new THREE.Vector3(dx, dy, dz).normalize();
      const oc = o.clone().sub(centre);
      const b = oc.dot(d), c = oc.lengthSq() - 1.44;
      const disc = b * b - c;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0 || t > max) return null;
      return { distance: t, point: [0, 0, 0], normal: [0, 1, 0], triangle: 0, part: 0, dynamic: 210 };
    },
  };
  const e: ActorEnv = {
    world: world as never,
    nav: null,
    player: { position: new THREE.Vector3(30, 0, 30) } as never,
    playerAlive: true,
    playerUid: 2,
    time: 0,
    actors: [a],
    damagePlayer: () => {},
    damageActor: () => {},
    propTarget: (uid) => (uid === 0x1432 ? tank : undefined),
    damageProp: () => {},
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
  }
  assert.equal(a.currentTarget?.prop, 0x1432, a.activity);
});

test('a handed-out KillEnemies whose search finds no target completes, and its chain goes on (6a: 142c after the tank)', () => {
  const a = shooter();
  a.profile = { team: '10:212', priority: 0.5, maxAttackers: 4 };
  a.hostile = true;
  let done = 0;
  a.setBehavior(KILL_TANK);
  a.chainOf = 0x142b;
  a.onChainDone = () => done++;
  const e: ActorEnv = {
    world: { raycast: () => null } as never,
    nav: null,
    player: { position: new THREE.Vector3(30, 0, 30) } as never,
    playerAlive: true,
    playerUid: 2,
    time: 0,
    actors: [a],
    damagePlayer: () => {},
    damageActor: () => {},
    // The tank is gone (broken): no target is left.
    propTarget: () => undefined,
    damageProp: () => {},
    sound: () => {},
    onDeath: () => {},
    clip: () => -1,
    entity: () => undefined,
    send: () => {},
    say: () => 0,
  };
  for (let t = 0; t < 2; t += 1 / 30) {
    e.time += 1 / 30;
    a.update(1 / 30, e);
  }
  assert.equal(done, 1, 'the Behavior Changer chain completed');
  assert.notEqual(a.behavior?.kind, 'kill');
});

test('a modelless usable is looked at by its anchor (6a: the truck jack a08)', () => {
  const eye = { x: 0, y: 1.7, z: 0 };
  const ahead = { x: 0, y: 0, z: -1 };
  // The jack's anchor on the ground 1.5 m ahead: looking down at it.
  const anchor = [{ x: 0, y: 0.2, z: -1.5 }];
  const down = new THREE.Vector3(0, -1.5, -1.5).normalize();
  assert.ok(viewOnAnchor(eye, down, anchor, 3));
  assert.ok(!viewOnAnchor(eye, ahead, anchor, 3), 'looking over it');
  assert.ok(!viewOnAnchor(eye, { x: 0, y: 0, z: 1 }, anchor, 3), 'behind the player');
  assert.ok(!viewOnAnchor(eye, down, [{ x: 0, y: -2.8, z: -4.5 }], 3), 'beyond reach');
});

async function level(path: string) {
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  return parseEntities(lvl, packages);
}

test('retail 6a: the truck jack a08 is a Switch without a model, used through Interaction Properties 2:924', { skip }, async () => {
  const ents = await level('LEVELS/6 Woods/6a Woods.lvl');
  const sw = ents.filter((e) => e.className === 'Switch');
  const modelless = sw.filter((e) => !e.modelRef);
  assert.deepEqual(modelless.map((e) => e.uid), [0xa08]);
  const jack = modelless[0];
  assert.deepEqual(jack.values[30], [{ pkg: 2, id: 924 }]);
  // Its use (p27 On) starts Timer 23a3 -> "Truck" a9b.
  assert.ok(jack.links.includes(0x23a3));
});

// --- NPC throws (actors/throw.ts) -----------------------------------------------------------------


test('NPC throw: the lowest elevation whose parabola reaches the aim point (6a: the stranger 9 m above the tank)', () => {
  const aim = { speed: 70000 / 2048, gravity: 9.8, reach: 25, fallbackDeg: 45 };
  const from = { x: 247.6, y: 103.5, z: 429.1 }, to = { x: 258.6, y: 93.3, z: 426.6 };
  const e = throwElevation(from, to, aim);
  assert.ok(e.solved);
  const x = Math.hypot(to.x - from.x, to.z - from.z);
  assert.ok(Math.abs(flightHeight(x, e.theta, aim.speed, aim.gravity) - (to.y - from.y)) < 1e-6);
  // The other root is steeper: the low one wins.
  assert.ok(e.theta < 0.3, `theta ${e.theta}`);
  const v = ballisticLaunch(from, to, aim);
  assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - aim.speed) < 1e-6);
  // Flown step by step it lands on the tank.
  let p = { ...from }, w = { ...v };
  for (let t = 0; t < 3 && Math.hypot(p.x - from.x, p.z - from.z) < x; t += 1e-3) {
    w.y -= aim.gravity * 1e-3;
    p = { x: p.x + w.x * 1e-3, y: p.y + w.y * 1e-3, z: p.z + w.z * 1e-3 };
  }
  assert.ok(Math.abs(p.y - to.y) < 0.1, `lands at ${p.y}`);
});

test('NPC throw: beyond its reach (p9) the aim point is pulled in; out of range it takes p10 degrees', () => {
  const aim = { speed: 10, gravity: 9.8, reach: 25, fallbackDeg: 45 };
  // 40 m off: scaled to 25 m, still beyond what 10 m/s reaches (10.2 m): the fallback.
  const far = throwElevation({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, aim);
  assert.ok(Math.abs(far.dx - 25) < 1e-6);
  assert.equal(far.solved, false);
  assert.ok(Math.abs(far.theta - Math.PI / 4) < 1e-9);
  // Within reach: solved, below 45 degrees.
  const near = throwElevation({ x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, aim);
  assert.ok(near.solved && near.theta < Math.PI / 4);
});

test('retail 6a: the stranger 10:642 throws the BouncingObject 10:1863 (aim mode p0 1, aim point p48 2, reach p9 25 m, p10 45)', { skip }, async () => {
  const ents = await level('LEVELS/6 Woods/6a Woods.lvl');
  const stranger = ents.find((e) => e.uid === 0x54b)!;
  assert.deepEqual(stranger.values[55], [{ pkg: 10, id: 1863 }]);
});
