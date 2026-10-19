// FollowBehavior as decoded from Suffering.rfl (src/game/actors/follow.ts, actor.ts runFollow,
// docs/game-logic.md §15.10): the path check and its limits, the run's stop distance, the step
// aside, the give-up distance, and who fights while following. No game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import { attackStartsFight, rootListens, type Behavior } from '../src/game/actors/behaviors';
import type { CreatureKind } from '../src/game/actors/kinds';
import { followCheckDelay, followGivesUp, followLimit, followRuns, polylineLength, stepAside, stepAsideTime } from '../src/game/actors/follow';

// Dallas's FollowBehavior 902 (template 10:288: p3 1, p4 7, p5 10, p6 20, p7 -1).
const F = { cls: 'FollowBehavior', next: [], kind: 'follow', target: 1, near: 2, fights: true, stop: 7, far: 10, combatFar: 20, giveUp: -1 } as Behavior & { kind: 'follow' };

test('follow: the path check comes every 0.5..1 s (0x100e8930)', () => {
  assert.equal(followCheckDelay(0), 0.5);
  assert.equal(followCheckDelay(1), 1);
  assert.equal(followCheckDelay(0.5), 0.75);
});

test('follow: waits on a way up to p5 (p6 while it has a target), runs beyond it; no way: no run', () => {
  assert.equal(followLimit(F, false), 10);
  assert.equal(followLimit(F, true), 20);
  assert.equal(followRuns(9.9, followLimit(F, false)), false);
  assert.equal(followRuns(10.1, followLimit(F, false)), true);
  assert.equal(followRuns(15, followLimit(F, true)), false, 'fighting, it stays up to 20 m');
  assert.equal(followRuns(undefined, 10), false, 'no path: it beckons instead');
  assert.equal(polylineLength([{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }, { x: 3, y: 0, z: 10 }]), 11);
});

test('follow: p7 <= 0 never gives up; beyond p7 (3D) it does', () => {
  assert.equal(followGivesUp(-1, 1000), false);
  assert.equal(followGivesUp(30, 29), false);
  assert.equal(followGivesUp(30, 31), true);
});

test('follow: the leader walking into it makes it step aside (0x100ee710)', () => {
  assert.ok(stepAsideTime(0) === 2.5 && stepAsideTime(1) === 3);
  // Leader walking +z, follower 1.5 m ahead on his line, slightly to +x.
  const s = stepAside({ x: 0, z: 1.4 }, { x: 0.1, z: 1.5 }, 0.4)!;
  assert.ok(s, 'in his way');
  assert.ok(Math.abs(Math.abs(s.x) - 0.9) < 1e-6 + 0.1 && s.z === 1.5, `aside across his line: ${JSON.stringify(s)}`);
  assert.ok(s.x > 0.1, 'to the side it leans to');
  assert.equal(stepAside({ x: 0, z: 1.4 }, { x: 1.2, z: 1.5 }, 0.4), undefined, 'not on his line');
  assert.equal(stepAside({ x: 0, z: -1.4 }, { x: 0, z: 1.5 }, 0.4), undefined, 'walking away from it');
  assert.equal(stepAside({ x: 0, z: 0 }, { x: 0, z: 1.5 }, 0.4), undefined, 'standing');
});

test('follow: a follower fights only through its waiting Hostility (no grudge), also when the player hits it', () => {
  const npc = { hostileKind: false, actionDialog: false, byPlayer: false };
  assert.equal(attackStartsFight(F, npc), false);
  // The companion's Action Dialog warns and, at its p18th counted hit, hands the turn to the level
  // logic (director.ts dialogTurn); the first hit no longer turns him (0x1008dda0).
  assert.equal(attackStartsFight(F, { ...npc, actionDialog: true, byPlayer: true }), false);
});

// --- the follower on a synthetic rig (anchored: it never gets anywhere) -----------------------

function rig(): SkinnedModel {
  const parents = [-1, 0, 1];
  const bones = parents.map((parent, index) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, index * 0.5, 0, 1]);
    return { index, hash: 0x1000 + index, name: `b${index}`, parent, children: [] as number[], inverseBind: m, bindWorld: m, position: [0, index ? 0.5 : 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
  });
  bones.forEach((b) => b.parent >= 0 && bones[b.parent].children.push(b.index));
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

const clip = (id: number): AnimClipData => ({
  id,
  animSet: 0,
  duration: 1,
  flags: 0,
  blendTime: 0.2,
  rate: 1,
  links: [],
  tracks: [0, 1, 2].map((b) => ({ boneHash: 0x1000 + b, format: 0xc0, times: new Float32Array([0, 1]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number] })),
});
const CLIPS = [clip(0), clip(1), clip(2)];

function follower() {
  const skinned = rig();
  const kind = {
    key: 'test:follower',
    template: { pkg: 0, id: 0 },
    className: 'Unspeakable NPC',
    skinned,
    proto: new Character(skinned, CLIPS),
    idle: 0,
    walk: -1,
    run: -1,
    attacks: [],
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
    hostile: false,
    maxHealth: 100,
    decor: false,
  } as CreatureKind;
  const a = new Actor(kind, { x: 0, y: 0, z: 0 }, 0);
  const open = { raycast: () => null, sphereCast: () => null };
  const e: ActorEnv = {
    world: open as never,
    nav: null,
    player: { position: new THREE.Vector3(0, 0, 5), velocity: new THREE.Vector3() } as never,
    playerAlive: true,
    playerUid: 0x5818,
    time: 0,
    actors: [],
    damagePlayer: () => {},
    damageActor: () => {},
    sound: () => {},
    onDeath: () => {},
    clip: (_a, r) => (r && r.pkg === 0 && r.id < CLIPS.length ? r.id : -1),
    entity: () => undefined,
    send: () => {},
    say: () => 0,
  };
  e.actors = [a];
  a.setBehavior(F, e);
  const state = () => (a as unknown as { b: { fol?: { mode: string; beckon: boolean } } }).b.fol;
  const run = (secs: number) => {
    for (let t = 0; t < secs; t += 1 / 30) {
      e.time += 1 / 30;
      a.update(1 / 30, e);
    }
  };
  return { a, e, state, run };
}

test('follow (actor): waits with the leader 5 m off, runs for him 12 m off, beckons when it gets nowhere', () => {
  const { e, state, run } = follower();
  run(3);
  assert.equal(state()?.mode, 'wait', 'a 5 m way is within p5');
  e.player.position.set(0, 0, 12);
  run(1.1);
  assert.equal(state()?.mode, 'run', 'the next check (<= 1 s) finds 12 m > p5');
  // The anchored body never comes closer: the run fails after 3 s and it beckons (then the next
  // check finds the way again and it runs again).
  let failedAt = -1;
  for (let i = 0; i < 120 && failedAt < 0; i++) {
    run(1 / 30);
    if (state()?.mode === 'wait' && state()?.beckon) failedAt = e.time;
  }
  assert.ok(failedAt > 0, 'the run failed');
});

test('follow (actor): a run stops p4 (7 m) short of where the leader was', () => {
  const { a, e, state, run } = follower();
  e.player.position.set(0, 0, 12);
  run(1.1);
  assert.equal(state()?.mode, 'run');
  // Carried to 6.5 m from the goal: arrived.
  Object.assign(a.motor.position, { x: 0, y: 0, z: 5.5 });
  run(0.1);
  assert.equal(state()?.mode, 'wait');
  assert.equal(state()?.beckon, false);
});

test('WaypointBehavior escort: an escort beyond p10 is beckoned, not fetched (0x100ea110 / 0x100f12ee)', () => {
  const { a, e } = follower();
  // 1c's 75c0: escorts the player (p8), p9 10 m / p10 20 m; its next Waypoint 30 m off.
  const wp = { uid: 0x11, className: 'Waypoint', position: [30 * 2048, 0, 0], values: [0, 0, 0, 0, 0, 0, 0], links: [] };
  e.entity = (u: number) => (u === 0x11 ? (wp as never) : undefined);
  const walk = { cls: 'WaypointBehavior', kind: 'waypoint', next: [], first: 0x11, fight: 2, escort: [0x5818], near: 10, far: 20, keepPath: true } as unknown as Behavior;
  a.setBehavior(walk, e);
  e.player.position.set(0, 0, 3);
  const run = (secs: number) => {
    for (let t = 0; t < secs; t += 1 / 30) {
      e.time += 1 / 30;
      a.update(1 / 30, e);
    }
  };
  run(0.5);
  assert.equal(a.state, 'move', 'the player within p9: the leg is walked');
  e.player.position.set(-25, 0, 0);
  run(0.5);
  assert.equal(a.state, 'idle', 'beyond p10: it stops and beckons; it does not walk back to him');
  e.player.position.set(-8, 0, 0);
  run(0.5);
  assert.equal(a.state, 'move', 'back within p9: on with the walk');
});

test('hearing: only a ListenBehavior hears (Hostility, WaypointBehavior p4, a waiting fighting follower)', () => {
  const B = (b: object) => ({ cls: 'X', next: [], ...b }) as unknown as Behavior;
  assert.equal(rootListens(B({ kind: 'hostile' })), true, 'Hostility starts Listen (0x100f7880)');
  assert.equal(rootListens(B({ kind: 'waypoint', listen: true })), true, 'WaypointBehavior p4 (0x100e8790)');
  assert.equal(rootListens(B({ kind: 'waypoint', listen: false })), false);
  assert.equal(rootListens(B({ kind: 'flee' })), false, "1c's fleeing companion does not walk to gunshots");
  assert.equal(rootListens(B({ kind: 'idle' })), false);
  assert.equal(rootListens(B({ kind: 'talk' })), false);
  assert.equal(rootListens(B({ kind: 'kill' })), false);
  assert.equal(rootListens(F, true), true, 'waiting with its Hostility (p3 = 1)');
  assert.equal(rootListens(F, false), false, 'running to the leader: the Hostility is stopped');
  assert.equal(rootListens({ ...F, fights: false }, true), false, 'p3 = 0 waits with an Idle');
});

test('Ranged Targeting Positions: the stand search takes the fight target, whoever it is (0x100f74f0 -> 0x101265c0)', async () => {
  const { standTarget } = await import('../src/game/actors/specials/ranged-positions');
  const creature = { alive: true, position: { x: 4, y: 0, z: 5 } };
  const player = { x: 1, y: 2, z: 3 };
  const npc = (o: object) => ({ alive: true, hidden: false, inCombat: true, activity: 'chase/HostilityBehavior>CartWheeler', currentTarget: { actor: creature }, behavior: { kind: 'hostile' }, ...o }) as never;
  assert.deepEqual(standTarget(npc({}), player), creature.position, 'a creature target (a companion against creatures)');
  assert.equal(standTarget(npc({ activity: 'chase/HostilityBehavior>player', currentTarget: { player: true } }), player), player, 'the player');
  assert.deepEqual(standTarget(npc({ inCombat: false, behavior: { kind: 'follow' } }), player), creature.position, "a follower's waiting Hostility");
  assert.equal(standTarget(npc({ inCombat: false, behavior: { kind: 'idle' } }), player), null, 'not fighting');
  assert.equal(standTarget(npc({ currentTarget: { actor: { alive: false, position: creature.position } } }), player), null, 'a dead target');
});

test('NPC bullets: a cone of Ranged Weapon p75 x Attack p19 degrees (0x100fcec0 -> 0x10127b30)', async () => {
  const { spreadShotHits } = await import('../src/game/actors/actor');
  // Prisoners' attacks (10:314, 10:1438, 10:1439) have p19 = 0: no spread, every clear shot hits.
  for (let i = 0; i < 20; i++) assert.equal(spreadShotHits(3 * 0, 30, 0.4, 0.9, Math.random(), Math.random()), true);
  // Guards' (p19 = 1, 10:1802 p75 = 3): at 30 m the cone reaches 1.57 m, so some miss.
  let hits = 0;
  for (let i = 0; i < 400; i++) if (spreadShotHits(3, 30, 0.4, 0.9, (i % 20) / 20, Math.floor(i / 20) / 20)) hits++;
  assert.ok(hits > 50 && hits < 350, `${hits}`);
  // Close in the same cone stays on the body.
  assert.equal(spreadShotHits(3, 5, 0.4, 0.9, 1, 0), true);
});

test('WaypointBehavior: a leg is tested once, when its MoveTo is issued; a leg under way is walked (1a guard 609e)', () => {
  const { a, e } = follower();
  // A Waypoint 30 m off behind a wall, with no Move Node path to it once `blocked` is set.
  let blocked = false;
  const wp = { uid: 0x11, className: 'Waypoint', position: [30 * 2048, 0, 0], values: [0, 0, 0, 0, 0, 0, 0], links: [] };
  e.entity = (u: number) => (u === 0x11 ? (wp as never) : undefined);
  const hit = () => (blocked ? { distance: 0.1, point: [0, 0, 0], normal: [1, 0, 0] } : null);
  e.world = { raycast: hit, sphereCast: hit } as never;
  e.nav = { size: 2, nodes: [{ x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }], crossesExcluded: () => false, nearest: (x: number) => (x > 15 ? 1 : 0), path: () => (blocked ? null : [0, 1]) } as never;
  const walk = { cls: 'WaypointBehavior', kind: 'waypoint', next: [], first: 0x11, fight: 2, escort: [0x5818], near: 10, far: 20, keepPath: true } as unknown as Behavior;
  a.setBehavior(walk, e);
  e.player.position.set(0, 0, 3);
  const run = (secs: number) => {
    for (let t = 0; t < secs; t += 1 / 30) {
      e.time += 1 / 30;
      a.update(1 / 30, e);
    }
  };
  run(0.5);
  assert.equal(a.state, 'move', 'the leg was found walkable when it started');
  blocked = true;
  run(3);
  assert.equal(a.behavior, walk, 'the same leg is not tested again on the way');
  assert.equal(a.state, 'move');
  // The escort falls behind (beckoned), then comes back: a new MoveTo, tested afresh.
  e.player.position.set(-25, 0, 0);
  run(0.5);
  assert.equal(a.state, 'idle');
  e.player.position.set(a.position.x - 3, 0, 0);
  run(0.5);
  assert.notEqual(a.behavior, walk, 'the new leg finds no way: the WaypointBehavior ends');
});

test('clearWide ground: the body sphere meeting rising walkable floor (stairs) does not block; a wall still does', async () => {
  const { clearWide } = await import('../src/game/actors/nav');
  // 1a's stairs below 7517: the sphere at 0.9 m met the landing's floor (normal 0.48, 0.88, 0).
  const world = (n: number[]) => ({ raycast: () => null, sphereCast: () => ({ distance: 1.7, point: [0, 0, 0], normal: n }) }) as never;
  assert.equal(clearWide(world([0.48, 0.88, 0]), 0, 1, 0, 4.7, 2.3, 0, 0.38), false, 'as before without `ground`');
  assert.equal(clearWide(world([0.48, 0.88, 0]), 0, 1, 0, 4.7, 2.3, 0, 0.38, true), true);
  assert.equal(clearWide(world([1, 0, 0]), 0, 1, 0, 4.7, 2.3, 0, 0.38, true), false, 'a rail or a wall');
});
