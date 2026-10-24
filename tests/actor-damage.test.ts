// Damage, death and provocation rules of actors (docs/game-logic.md §15.12) on a synthetic rig:
// dead bodies stay dead whatever hits them, posed bodies do not get up, sequence-driven
// characters swallow attacks, and fighting back depends on the root behaviour as decoded from
// Suffering.rfl (behaviors.ts attackStartsFight). No game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import { ActorManager } from '../src/game/actors/manager';
import { attackStartsFight, type Behavior } from '../src/game/actors/behaviors';
import type { CreatureKind } from '../src/game/actors/kinds';
import type { PackageSet } from '../src/formats/model';

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

function clip(id: number, duration = 1): AnimClipData {
  return {
    id,
    animSet: 0,
    duration,
    flags: 0,
    blendTime: 0.2,
    rate: 1,
    links: [],
    tracks: [0, 1, 2].map((b) => ({ boneHash: 0x1000 + b, format: 0xc0, times: new Float32Array([0, duration]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number] })),
  };
}

// Clip ids = indices: 0 idle, 1 hit, 2 death, 3 a lying pose (DormantBehavior p5).
const CLIPS = [clip(0), clip(1, 0.5), clip(2), clip(3)];

function kind(className: string, hostile: boolean): CreatureKind {
  const skinned = rig();
  return {
    key: `test:${className}`,
    template: { pkg: 0, id: 0 },
    className,
    skinned,
    proto: new Character(skinned, CLIPS),
    idle: 0,
    walk: -1,
    run: -1,
    attacks: hostile ? [{ clip: 0, reach: 1.5, minReach: 0, maxDy: 0, scaled: false, damage: 10, hitTimes: [0.5] }] : [],
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
    hostile,
    maxHealth: 100,
    decor: false,
  };
}

interface Log {
  deaths: { a: Actor; source: 'player' | number }[];
}

function env(log: Log): ActorEnv {
  return {
    world: null as never,
    nav: null,
    player: { position: new THREE.Vector3(0, 0, 3) } as never,
    playerAlive: true,
    playerUid: 0x5818,
    time: 0,
    actors: [],
    damagePlayer: () => {},
    damageActor: () => {},
    sound: () => {},
    onDeath: (a) => log.deaths.push({ a, source: a.lastHitBy }),
    clip: (_a, r) => (r && r.pkg === 0 && r.id < CLIPS.length ? r.id : -1),
    entity: () => undefined,
    send: () => {},
    say: () => 0,
  };
}

const B = (b: Omit<Behavior, 'cls' | 'next'> & { cls?: string }): Behavior => ({ cls: 'X', next: [], ...b }) as Behavior;
const LYING = B({ kind: 'dormant', mode: 1, clip: { pkg: 0, id: 3 }, wakeOnAttack: true, wakeMessage: 1 });
const DEATH = B({ kind: 'death', clips: [{ pkg: 0, id: 2 }] });
const IDLE = B({ kind: 'idle', fidgets: [], fidgetMin: 4, fidgetMax: 12 });
const waypoint = (fight: number) => B({ kind: 'waypoint', first: 0, fight, escort: [], near: 10, far: 20, keepPath: true });

function make(className = 'Unspeakable NPC', hostile = false) {
  const log: Log = { deaths: [] };
  const a = new Actor(kind(className, hostile), { x: 0, y: 0, z: 0 }, 0);
  return { a, e: env(log), log };
}

/** Run the actor's AI for `secs` (30 Hz), hitting it with `hit` every tick. */
function run(a: Actor, e: ActorEnv, secs: number, hit?: () => void) {
  for (let t = 0; t < secs; t += 1 / 30) {
    e.time += 1 / 30;
    hit?.();
    a.update(1 / 30, e);
    a.animate(1 / 30);
  }
}

test('attackStartsFight: who fights back, by root behaviour (RFL 0x100ea490, 0x100e9dc0, Idle 0x100ede20)', () => {
  const npc = { hostileKind: false, actionDialog: false, byPlayer: true };
  assert.equal(attackStartsFight(waypoint(0), npc), true, 'WaypointBehavior p3 = 0 fights while walking');
  assert.equal(attackStartsFight(waypoint(1), npc), true, 'p3 = 1 starts fighting once attacked');
  assert.equal(attackStartsFight(waypoint(2), npc), false, 'p3 = 2 never fights (1a / 1b vision monster selves)');
  assert.equal(attackStartsFight(IDLE, npc), false, 'an idling neutral NPC does not fight back');
  // An attached Action Dialog counts the player's hits and warns (AttackedByPlayer: face, clip,
  // line); the turn at p18 is the level logic's (0x1008d4a0 / 0x1008dda0), not a fight back.
  assert.equal(attackStartsFight(IDLE, { ...npc, actionDialog: true }), false, 'an Action Dialog does not make it fight back');
  assert.equal(attackStartsFight(IDLE, { ...npc, actionDialog: true, byPlayer: false }), false);
  assert.equal(attackStartsFight(IDLE, { ...npc, hostileKind: true }), true, 'hostile creature classes keep fighting back (port)');
  assert.equal(attackStartsFight(LYING, npc), false);
  assert.equal(attackStartsFight(DEATH, { ...npc, hostileKind: true, actionDialog: true }), false);
  assert.equal(attackStartsFight(B({ kind: 'hostile' }), npc), true);
  assert.equal(attackStartsFight(undefined, npc), true, "the kind's plain default (no root behaviour)");
});

test('a dead actor stays dead: damage, wake, behaviours, BlowUp do nothing (manager and actor)', () => {
  const { a, e, log } = make('Unspeakable NPC', true);
  const scene = new THREE.Scene();
  const m = new ActorManager(new Map() as unknown as PackageSet, scene, null);
  m.env = e;
  m.adopt(a);
  e.actors = m.actors;
  a.die(e);
  assert.equal(log.deaths.length, 1);
  const before = { health: a.health, behavior: a.behavior, provoked: a.provoked };
  run(a, e, 12, () => {
    assert.equal(m.damage(a, 25, { x: 0, y: 0, z: 2 }, 'player', { type: 10 }), false);
    assert.equal(a.damage(25, e, undefined, 'player'), false);
  });
  a.wake(e);
  a.setBehavior(B({ kind: 'hostile' }), e);
  m.receive(a.uid ?? -1, 11, e);
  run(a, e, 1);
  assert.equal(a.state, 'dead');
  assert.equal(a.alive, false);
  assert.equal(a.health, before.health);
  assert.equal(a.behavior, before.behavior);
  assert.equal(a.provoked, before.provoked);
  assert.equal(a.inCombat, false);
  assert.equal(log.deaths.length, 1, 'no second death');
  m.dispose();
});

test('a body lying in its DormantBehavior pose (p69 = the same behaviour) does not get up when hit', () => {
  const { a, e, log } = make();
  a.profile = { team: '10:120', active: LYING };
  a.behavior = LYING;
  a.setBehavior(LYING, e);
  run(a, e, 0.2);
  for (let i = 0; i < 3; i++) {
    a.damage(10, e, { x: 0, y: 0, z: 3 }, 'player');
    run(a, e, 1);
    assert.equal(a.behavior, LYING, 'woken by p6, it takes its p69: the same pose');
    assert.notEqual(a.state, 'hurt', 'no hit reaction from a pose');
    assert.equal(a.inCombat, false);
    assert.equal(a.provoked, false);
    assert.equal(a.activity.includes('>player'), false, 'no target');
  }
  // Enough damage kills it like any body; nobody revives it afterwards.
  a.damage(1000, e, undefined, 'player');
  assert.equal(a.state, 'dead');
  assert.equal(log.deaths.length, 1);
  run(a, e, 3, () => a.damage(50, e, undefined, 'player'));
  assert.equal(a.state, 'dead');
});

test('a sleeper whose p69 is a DeathBehavior dies when woken, credited to nobody (1a 8b32)', () => {
  const { a, e, log } = make();
  const hidden = B({ kind: 'dormant', mode: 2, wakeOnAttack: true, wakeMessage: 1 });
  a.profile = { team: '10:120', active: DEATH };
  a.behavior = hidden;
  a.setDormantHidden(false);
  a.wake(e);
  assert.equal(a.state, 'dead');
  assert.equal(log.deaths.length, 1);
  assert.equal(log.deaths[0].source, 0, 'a scripted death is nobody\'s kill (no reputation)');
  // Behavior Changer death of an NPC the player had hurt: still nobody's kill.
  const b = make();
  b.a.damage(5, b.e, undefined, 'player');
  b.a.setBehavior(DEATH, b.e);
  assert.equal(b.log.deaths[0]?.source, 0);
});

test('an NPC walking a WaypointBehavior with p3 = 2 never turns on its attacker (vision monster self)', () => {
  const { a, e } = make('Unspeakable NPC', false);
  const wp = waypoint(2);
  a.profile = { team: '10:1133', active: IDLE, kill: { cls: 'KillEnemiesBehavior', next: [], kind: 'kill', targets: [], enemies: ['2:384'], allies: [], range: 45, alwaysSee: 10, keep: 50, fov: 360, los: false, reevalMin: 2, reevalRand: 2 } };
  a.behavior = wp;
  for (let i = 0; i < 4; i++) a.damage(20, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(a.provoked, false);
  assert.equal(a.inCombat, false);
  assert.equal(a.behavior, wp);
  assert.ok(a.alive && Math.abs(a.health - 20) < 1e-9, 'it takes the damage');
  // p3 = 1: the same hit starts the fight.
  const b = make('Unspeakable NPC', false);
  b.a.profile = a.profile;
  b.a.behavior = waypoint(1);
  b.a.damage(20, b.e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(b.a.inCombat, true);
});

test('an idling neutral NPC takes the hit but does not fight back; a hostile creature does', () => {
  const { a, e } = make('Unspeakable NPC', false);
  a.profile = { team: '10:212', active: IDLE };
  a.setBehavior(IDLE, e);
  a.damage(20, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(a.health, 80);
  assert.equal(a.state, 'hurt', 'the hit reaction still plays');
  assert.equal(a.inCombat, false);
  const c = make('CartWheeler', true);
  c.a.damage(20, c.e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(c.a.inCombat, true);
});

test('a sequence-driven character swallows attacks and dies only when control is handed back', () => {
  const { a, e, log } = make('Unspeakable NPC', false);
  a.profile = { team: '10:120', active: IDLE };
  a.setBehavior(waypoint(0), e);
  a.setScriptPose({ x: 0, y: 0, z: 0 }, new THREE.Quaternion());
  a.damage(30, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(a.provoked, false);
  assert.equal(a.inCombat, false, 'no fight from the Stomp root');
  assert.notEqual(a.state, 'hurt');
  a.damage(500, e, undefined, 'player');
  assert.equal(a.alive, true, 'the death event waits for the hand-back');
  assert.equal(a.getState().alive, false, 'saved dead');
  run(a, e, 0.5);
  assert.equal(a.alive, true, 'still scripted');
  a.setScriptPose(null);
  run(a, e, 0.1);
  assert.equal(a.state, 'dead');
  assert.equal(log.deaths.length, 1);
});

test('Character p161: health regained per second up to the maximum, never by the dead (0x100e1410 from 0x100e58d0)', () => {
  const values: unknown[] = [];
  values[161] = 4;
  const ent = { uid: 0xbc9, values, className: 'Unspeakable NPC', links: [] } as never;
  const a = new Actor(kind('Unspeakable NPC', false), { x: 0, y: 0, z: 0 }, 0, 1, ent);
  assert.equal(a.regen, 4);
  a.health = 40;
  a.regenerate(2.5);
  assert.equal(a.health, 50, '4 a second');
  a.regenerate(100);
  assert.equal(a.health, a.maxHealth, 'capped at the maximum (setter 0x100a2d00)');
  a.health = 0;
  a.regenerate(1);
  assert.equal(a.health, 0, 'not at 0 health (0x100a1ad0: dead)');
  // Characters without p161 (every creature, ordinary guards) do not heal.
  const { a: b } = make();
  b.health = 10;
  b.regenerate(10);
  assert.equal(b.health, 10);
});

test('the player is pushed out of a body he overlaps, but not while something holds his feet (a Mainliner ride)', () => {
  const { a, e } = make();
  const scene = new THREE.Scene();
  const m = new ActorManager(new Map() as unknown as PackageSet, scene, null);
  m.env = e;
  m.adopt(a);
  // A rider 0.45 m in front of the feet, as the ride places it every frame.
  const at = { x: a.position.x, y: a.bottom, z: a.position.z + 0.45 };
  const shoves: [number, number][] = [];
  const motor = { position: { ...at }, cfg: { radius: 0.35 }, shove: (dx: number, dz: number) => shoves.push([dx, dz]) } as never;
  m.pushPlayer(motor);
  assert.equal(shoves.length, 1, 'free: pushed out of the overlap');
  assert.ok(Math.hypot(...shoves[0]) > 0.05);
  m.pushPlayer(motor, true);
  assert.equal(shoves.length, 1, 'held: not pushed (the ride would drag him 0.3 m a frame)');
  m.dispose();
});
