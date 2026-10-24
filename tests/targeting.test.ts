// KillEnemies target choice and Melee Weapon hit resolution of NPCs and creatures, as decoded from
// Suffering.rfl (src/game/actors/targeting.ts, src/game/actors/npc-melee.ts; docs/game-logic.md
// §15.15 and §15.5). The rules run on a synthetic rig; the data tests check the retail templates
// and weapon volumes they read (skipped without game data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import type { Behavior } from '../src/game/actors/behaviors';
import type { CreatureKind } from '../src/game/actors/kinds';
import { chooseTarget, damageShare, DEFAULT_WEIGHTS, hostilityRetry, repickInterval, targetScore, targetWeights, type TargetCandidate } from '../src/game/actors/targeting';
import { npcBlowDamage, sweepHit, sweepSpheres, type HitSphereLike, type NpcMeleeWeapon } from '../src/game/actors/npc-melee';
import { readModelSphereNodes, weaponShape } from '../src/formats/model-spheres';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type Entity } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import type { PackageSet } from '../src/formats/model';
import { nodeFS, readSrsc, skip } from './helpers';

// --- the score -------------------------------------------------------------------------------

// CartWheeler KillEnemiesBehavior 10:102 (p5 1, p12 2, p13 2, p14 10, p16 10, p17 100, p18 0.75,
// p19 1, p20 0.5, p21 0, p22 0, p23 -0.8, p24 1, p25 0).
const CW = targetWeights([[], [], [], [], [], 1, 1, 45, 10, 0, 50, 360, 2, 2, 10, null, 10, 100, 0.75, 1, 0.5, 0, 0, -0.8, 1, 0]);
const cand = (o: Partial<TargetCandidate>): TargetCandidate => ({ enemyTeam: true, explicit: false, targetsMe: false, current: false, dist: 10, cos: 1, priority: 0.5, healthFrac: 1, attackers: 0, maxAttackers: 4, damageShare: 0, failed: false, ...o });

test('target score: every term of 0x100f9eb0 with the CartWheeler weights', () => {
  assert.deepEqual([CW.enemyTeam, CW.explicit, CW.near, CW.current, CW.facing, CW.crowd, CW.damage, CW.memory, CW.repick, CW.repickRand], [10, 100, 0.75, 1, 0.5, -0.8, 1, 10, 2, 2]);
  const base = targetScore(CW, 45, cand({}));
  assert.ok(Math.abs(base - (10 + 0.75 * (1 - 10 / 45) + 0.5)) < 1e-9);
  // Facing: (cos + 1) / 2 x p20; behind it scores 0.5 less.
  assert.ok(Math.abs(base - targetScore(CW, 45, cand({ cos: -1 })) - 0.5) < 1e-9);
  // The current target: + p19.
  assert.ok(Math.abs(targetScore(CW, 45, cand({ current: true })) - base - 1) < 1e-9);
  // Whoever hurt it: + p24 x its share of the last p14 s.
  assert.ok(Math.abs(targetScore(CW, 45, cand({ damageShare: 0.5 })) - base - 0.5) < 1e-9);
  // Crowding: p23 x n / p8, and - 1000 once p8 characters are on it.
  assert.ok(Math.abs(targetScore(CW, 45, cand({ attackers: 2 })) - base + 0.4) < 1e-9);
  assert.ok(targetScore(CW, 45, cand({ attackers: 4 })) < base - 1000);
  // A recent failure (MoveTo could not reach it): - 1000; a p3 target: + p17; not an enemy team: no p16.
  assert.ok(targetScore(CW, 45, cand({ failed: true })) < base - 999);
  assert.ok(Math.abs(targetScore(CW, 45, cand({ explicit: true })) - base - 100) < 1e-9);
  assert.ok(Math.abs(base - targetScore(CW, 45, cand({ enemyTeam: false })) - 10) < 1e-9);
});

test('target choice: highest score that is accepted; split attention between targets', () => {
  // The 1c yard: a CartWheeler between the inmate (5 m) and the player (8 m), both ahead.
  const inmate = (o: Partial<TargetCandidate> = {}) => cand({ dist: 5, ...o });
  const player = (o: Partial<TargetCandidate> = {}) => cand({ dist: 8, ...o });
  const pick = (a: TargetCandidate, b: TargetCandidate) => chooseTarget([targetScore(CW, 45, a), targetScore(CW, 45, b)], () => true);
  assert.equal(pick(inmate(), player()), 0, 'the nearer one');
  assert.equal(pick(inmate({ attackers: 2 }), player()), 1, 'two others on the inmate: the player');
  assert.equal(pick(inmate({ attackers: 2, current: true }), player()), 0, 'unless it is already its target');
  assert.equal(pick(inmate(), player({ damageShare: 1 })), 1, 'the player hurt it');
  assert.equal(pick(inmate({ current: true }), player({ damageShare: 1 })), 0, 'stickiness outweighs one attacker (1 vs 1 + distance)');
  // Not accepted (unseen, not current): the next one.
  assert.equal(chooseTarget([5, 3, 4], (i) => i !== 0), 2);
  assert.equal(chooseTarget([5], () => false), -1);
});

test('re-pick interval: p12 + U(0, p13) rolled once, at least 0.5 s; p12 = 0 every frame; p12 < 0 never again', () => {
  assert.equal(repickInterval({ repick: 2, repickRand: 2 }, 0.5), 3);
  assert.equal(repickInterval({ repick: 0.2, repickRand: 1 }, 0), 0.5);
  assert.equal(repickInterval({ repick: 0, repickRand: 2 }, 0.9), 0);
  assert.equal(repickInterval({ repick: -1, repickRand: 2 }, 0.9), -1, '1a / 1b rats (10:516)');
  assert.deepEqual(hostilityRetry([[], [], [], 0.4, 0.7]), [0.4, 0.7]);
  assert.equal(DEFAULT_WEIGHTS.enemyTeam, 10);
});

test('damage memory: the share of the last p14 s from one attacker', () => {
  const log = [
    { by: 'player', amount: 30, t: 1 },
    { by: 'a', amount: 10, t: 9 },
    { by: 'player', amount: 10, t: 9.5 },
  ];
  assert.equal(damageShare(log, (b) => b === 'player', 10, 10), 40 / 50);
  assert.equal(damageShare(log, (b) => b === 'player', 12, 10), 10 / 20, 'the first blow is older than p14');
  assert.equal(damageShare([], () => true, 0, 10), 0);
});

// --- on actors ---------------------------------------------------------------------------------

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

function clip(id: number, duration = 1, spin = false): AnimClipData {
  // `spin`: bone 1 turns half round about +y over the clip (the swing).
  const s = Math.SQRT1_2;
  return {
    id,
    animSet: 0,
    duration,
    flags: 0,
    blendTime: 0.2,
    rate: 1,
    links: [],
    tracks: [0, 1, 2].map((b) => ({
      boneHash: 0x1000 + b,
      format: 0xc0,
      times: spin && b === 1 ? new Float32Array([0, duration / 2, duration]) : new Float32Array([0, duration]),
      rotations: spin && b === 1 ? new Float32Array([0, 0, 0, 1, 0, s, 0, s, 0, 1, 0, 0]) : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number],
    })),
  };
}

// Clips: 0 idle, 1 hit, 2 death, 3 the swing (bone 2 armed from 0.1 to 0.9 s).
const CLIPS = [clip(0), clip(1, 0.5), clip(2), clip(3, 1, true)];

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
    attacks: hostile ? [{ clip: 3, reach: 1.5, minReach: 0, maxDy: 0, scaled: false, damage: 10, hitTimes: [0.5], windows: [{ bone: 0x1002, t0: 0.1, t1: 0.9 }], scale: 2 }] : [],
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

const IDLE: Behavior = { cls: 'IdleBehavior', next: [], kind: 'idle', fidgets: [], fidgetMin: 4, fidgetMax: 12 } as Behavior;
const killOf = (enemies: string[], allies: string[] = []) =>
  ({ cls: 'KillEnemiesBehavior', next: [], kind: 'kill', targets: [], enemies, allies, range: 45, alwaysSee: 0, keep: 50, fov: 360, los: false, reevalMin: 2, reevalRand: 2, weights: CW }) as Extract<Behavior, { kind: 'kill' }>;

function env(actors: Actor[], player: THREE.Vector3, hits: { who: string; amount: number }[], spheres?: (who: Actor | 'player') => HitSphereLike[]): ActorEnv {
  return {
    world: { raycast: () => null } as never,
    nav: null,
    player: { position: player } as never,
    playerAlive: true,
    playerUid: 0x5818,
    time: 0,
    actors,
    damagePlayer: (amount) => hits.push({ who: 'player', amount }),
    damageActor: (t, amount) => hits.push({ who: t.kind.className, amount }),
    sound: () => {},
    onDeath: () => {},
    clip: () => -1,
    entity: () => undefined,
    send: () => {},
    say: () => 0,
    hitSpheres: spheres,
  };
}

function step(actors: Actor[], e: ActorEnv, secs: number) {
  for (let t = 0; t < secs; t += 1 / 30) {
    e.time += 1 / 30;
    for (const a of actors) {
      a.update(1 / 30, e);
      a.animate(1 / 30);
    }
  }
}

function creature(x: number, z: number, yaw = 0) {
  const a = new Actor(kind('CartWheeler', true), { x, y: 0, z }, yaw);
  a.profile = { team: '10:119', kill: killOf(['2:384', '10:212']), priority: 0.5, maxAttackers: 4 };
  return a;
}

test('KillEnemies on actors: the choice splits attention by the decoded score', () => {
  // The inmate 5 m ahead, the player 8 m ahead (yaw 0 faces -z); no attacks in reach.
  const inmate = new Actor(kind('Unspeakable NPC', false), { x: 0, y: 0, z: -5 }, 0);
  inmate.profile = { team: '10:212', active: IDLE, priority: 0.5, maxAttackers: 4 };
  inmate.setBehavior(IDLE);
  const player = new THREE.Vector3(0, 0, -8);
  const hits: { who: string; amount: number }[] = [];
  // Alone, it goes for the nearer inmate.
  const c = creature(0, 0);
  const e1 = env([inmate, c], player, hits);
  step([c], e1, 0.5);
  assert.ok(c.currentTarget?.actor === inmate, c.activity);
  // Two others beside the inmate, facing him, go for him (the player 20 m off); a newcomer then
  // takes the player even so (inmate 5 m with two on him: 10.77; player 20 m: 10.92).
  const b1 = creature(1.8, -5, Math.PI / 2), b2 = creature(-1.8, -5, -Math.PI / 2);
  const e2 = env([inmate, b1, b2], new THREE.Vector3(0, 0, -20), hits);
  step([b1, b2], e2, 0.5);
  assert.ok(b1.currentTarget?.actor === inmate, b1.activity);
  assert.ok(b2.currentTarget?.actor === inmate, b2.activity);
  const n = creature(0, 0);
  (e2.actors as Actor[]).push(n);
  step([b1, b2, n], e2, 0.5);
  assert.ok(n.currentTarget?.player, `took ${n.activity}`);
  // An ally team (p4) is never a candidate, however near.
  const g = creature(0, -1);
  g.profile = { team: '10:120', kill: killOf(['10:119'], ['2:384', '10:212']) };
  g.hostile = true;
  const e3 = env([inmate, g], player, hits);
  step([g], e3, 0.5);
  assert.ok(!g.currentTarget, g.activity);
});

/** Hit spheres of a 1.8 m body standing at `p` (0.3 m spheres up its axis). */
const body = (p: THREE.Vector3Like): HitSphereLike[] => [0.3, 0.75, 1.2, 1.5].map((y) => ({ c: [p.x, p.y + y, p.z], r: 0.3 }));

function swing(playerAt: THREE.Vector3) {
  const c = creature(0, 0);
  // A blade along x on bone 2 (1 m up): the swing sweeps it round at that height.
  const blade: NpcMeleeWeapon = { bone: 2, shape: { a: [0, 0, 0], b: [1.2, 0, 0], r: 0 }, damage: 7, type: 2 };
  c.profile = { ...c.profile, melee: [blade] };
  const hits: { who: string; amount: number }[] = [];
  const e = env([c], playerAt, hits, (w) => (w === 'player' ? body(playerAt) : []));
  step([c], e, 1.5);
  return { c, hits };
}

test('NPC melee: the blade sweep lands on a body it passes through (p68 x the Attack p6 on the target)', () => {
  const { hits, c } = swing(new THREE.Vector3(0, 0, -1));
  assert.ok(c.activity.includes('player'), c.activity);
  assert.ok(hits.length >= 1, 'the swing hit');
  assert.ok(hits.every((h) => h.who === 'player' && h.amount === 14), JSON.stringify(hits));
});

test('NPC melee: a creature under a walkway swings but cannot reach the player 3 m above', () => {
  const { hits, c } = swing(new THREE.Vector3(0, 3, -1));
  // The start test is horizontal (Attack p17 <= 0): it attacks...
  assert.ok(c.state === 'attack' || c.activity.startsWith('chase') || c.activity.startsWith('attack'), c.activity);
  // ...but no blow lands.
  assert.equal(hits.length, 0, JSON.stringify(hits));
});

test('weapon sweep geometry: swept blade vs spheres, once per window, damage off the target', () => {
  const s: HitSphereLike[] = [{ c: [0, 1, -1], r: 0.3 }];
  // The blade turns from +x to -z at 1 m: it passes the sphere.
  assert.ok(sweepSpheres([0, 1, 0], [1.2, 1, 0], [0, 1, 0], [0, 1, -1.2], 0, s));
  // The same swing 3 m lower misses.
  assert.equal(sweepSpheres([0, -2, 0], [1.2, -2, 0], [0, -2, 0], [0, -2, -1.2], 0, s), null);
  // A sphere weapon (Fester 10:1750, r 0.6) swept along its path.
  assert.ok(sweepSpheres([2, 1, -1], [2, 1, -1], [0.5, 1, -1], [0.5, 1, -1], 0.6, s));
  assert.equal(npcBlowDamage({ damage: 7 }, 1.3, true), 7 * 1.3);
  assert.equal(npcBlowDamage({ damage: 7 }, 1.3, false), 7, 'a bystander takes p68 only');
});

test('the struck sphere (0x100c9680): the first leaf in node index order the sweep touches, not the deepest', () => {
  // A human's chest (bone 3: 1.61 m, r 0.245) before its head sphere (bone 48: 1.95 m, r 0.15),
  // as model 10:50 orders them. A blade (r 0.05) swept across at 1.84 m overlaps both, the head
  // deeper: the chest is struck.
  const chest = { c: [0, 1.61, -0.02] as [number, number, number], r: 0.245, bone: 3 };
  const head = { c: [0, 1.95, -0.06] as [number, number, number], r: 0.15, bone: 48 };
  const hit = sweepHit([-0.6, 1.84, 0.6], [-0.6, 1.84, -0.6], [0.6, 1.84, 0.6], [0.6, 1.84, -0.6], 0.05, [chest, head]);
  assert.equal(hit?.i, 0);
  // Only the head in reach (a blade over the shoulders): the head.
  assert.equal(sweepHit([-0.6, 2.0, 0.6], [-0.6, 2.0, -0.6], [0.6, 2.0, 0.6], [0.6, 2.0, -0.6], 0.05, [chest, head])?.i, 1);
  // Nothing in reach.
  assert.equal(sweepHit([-0.6, 3, 0.6], [-0.6, 3, -0.6], [0.6, 3, 0.6], [0.6, 3, -0.6], 0.05, [chest, head]), null);
  // The contact point is on the blade, beside the struck sphere.
  assert.ok(Math.abs(hit!.p[1] - 1.84) < 1e-9);
});

// --- retail data -------------------------------------------------------------------------------

test('retail: KillEnemies / Hostility templates and weapon volumes read as decoded', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const pk = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const vals = (pkg: number, id: number) => {
    const t = readObjectTemplate(pk, { pkg, id })!;
    return decodeTemplateProps(classByHash(t.classHash), t);
  };
  // CartWheeler 10:102, guard 10:168, rat 10:516 (p12 = -1: picks once).
  const cw = targetWeights(vals(10, 102)), guard = targetWeights(vals(10, 168)), rat = targetWeights(vals(10, 516));
  assert.deepEqual([cw.near, cw.facing, cw.crowd, cw.damage], [0.75, 0.5, -0.800000011920929, 1]);
  assert.deepEqual([guard.near, guard.facing, guard.crowd, guard.damage], [0.5, 0.25, -0.5, 0.75]);
  assert.equal(rat.repick, -1);
  assert.deepEqual(hostilityRetry(vals(10, 130)).map((x) => +x.toFixed(2)), [0.4, 0.7]);
  // The player template 2:5: GameObject p4 0.5, p8 4.
  const pl = vals(2, 5);
  assert.deepEqual([pl[4], pl[8]], [0.5, 4]);
  // Weapon volumes: the creature form's 4:36 blade, 4:135 sphere; the CartWheeler's 10:185 blade.
  const shape = (pkg: number, id: number) => weaponShape(readModelSphereNodes((pk as unknown as PackageSet).get(pkg)!.mdu!, id))!;
  const b = shape(4, 36);
  assert.deepEqual([b.a, b.b].map((p) => p!.map((x) => +x.toFixed(3))), [[1.177, 0, -0.021], [-0.023, 0, -0.021]]);
  assert.deepEqual([shape(4, 135).b, +shape(4, 135).r.toFixed(2)], [undefined, 0.65]);
  const cb = shape(10, 185);
  assert.ok(cb.b && Math.hypot(cb.a[0] - cb.b[0], cb.a[1] - cb.b[1], cb.a[2] - cb.b[2]) > 0.6);
  // Its Melee Weapon 10:1771: p68 7, type 2.
  const w = vals(10, 1771);
  assert.deepEqual([w[68], w[70]], [7, 2]);
});

test('KillEnemies taking the player as a new target fires the character output p31 ("ISeeYou")', () => {
  // Suffering.rfl 0x100fa30c..0x100fa361 -> event 0x200c -> 0x100e40ea [verified]. 8b's Hermes
  // copies link it (ISeeYou, 18) to Relay 1f0d.
  const entity = { uid: 0x2419, values: Object.assign([], { 31: 18 }), links: [0x1f0d] } as unknown as Entity;
  const c = new Actor(kind('CartWheeler', true), { x: 0, y: 0, z: 0 }, 0, 1, entity);
  c.profile = { team: '10:119', kill: killOf(['2:384']), priority: 0.5, maxAttackers: 4 };
  const sent: [number, number][] = [];
  const e = env([c], new THREE.Vector3(0, 0, -6), []);
  e.send = (uid, msg) => void sent.push([uid, msg]);
  step([c], e, 0.5);
  assert.ok(c.currentTarget?.player, c.activity);
  assert.deepEqual(sent.filter(([, m]) => m === 18), [[0x1f0d, 18]], 'once, on taking the player');
});

// --- port option "Enemies ignore the player" (src/game/port-options.ts, docs/game-logic.md §15.17)

test('ignore player: never a KillEnemies candidate; a creature on him drops him within a perception tick', () => {
  // The player 4 m ahead, the inmate 12 m: the nearer player is the pick with the option off.
  const inmate = new Actor(kind('Unspeakable NPC', false), { x: 0, y: 0, z: -12 }, 0);
  inmate.profile = { team: '10:212', active: IDLE, priority: 0.5, maxAttackers: 4 };
  inmate.setBehavior(IDLE);
  const hits: { who: string; amount: number }[] = [];
  const c = creature(0, 0);
  const e = env([inmate, c], new THREE.Vector3(0, 0, -4), hits);
  step([c], e, 0.5);
  assert.ok(c.currentTarget?.player, c.activity);
  // On: dropped at the next perception tick (0.15..0.25 s), the inmate taken instead.
  e.ignorePlayer = true;
  step([c], e, 0.3);
  assert.ok(c.currentTarget?.actor === inmate, c.activity);
  // A fresh creature with it on never takes him, even alone with him.
  const lone = creature(5, 0);
  const e2 = env([lone], new THREE.Vector3(5, 0, -3), hits);
  e2.ignorePlayer = true;
  step([lone], e2, 1);
  assert.ok(!lone.currentTarget, lone.activity);
  // Off again: he is re-acquired at the next search.
  e2.ignorePlayer = false;
  step([lone], e2, 1);
  assert.ok(lone.currentTarget?.player, lone.activity);
});

test('ignore player: his hits take no grudge, and his noise goes unheard', () => {
  // A passive character fights back on whoever hurts it (grudge); not on the player with the option.
  const hits: { who: string; amount: number }[] = [];
  const p = new THREE.Vector3(0, 0, -3);
  const npc = new Actor(kind('Unspeakable NPC', false), { x: 0, y: 0, z: 0 }, 0);
  npc.profile = { team: '10:212', active: IDLE, kill: killOf(['10:119']), priority: 0.5, maxAttackers: 4 };
  npc.setBehavior(IDLE);
  const e = env([npc], p, hits);
  e.ignorePlayer = true;
  npc.damage(5, e, p, 'player');
  step([npc], e, 0.5);
  assert.ok(!npc.currentTarget, npc.activity);
  // InvestigateBehavior's hearing (the per-tick poll, called directly: the test rig's bodies are
  // anchored, and anchored bodies do not investigate): a player noise is skipped, another heard.
  const ear = new Actor({ ...kind('Unspeakable NPC', false), anchored: false }, { x: 10, y: 0, z: 0 }, 0);
  ear.profile = { team: '10:120', investigate: { extra: 20, minLevel: 0, chance: 100, linger: 2 } };
  const e2 = env([ear], new THREE.Vector3(10, 0, -40), hits);
  const hear = (n: NonNullable<ActorEnv['noises']>) => (ear as unknown as { hear(n: NonNullable<ActorEnv['noises']>, e: ActorEnv): void }).hear(n, e2);
  e2.ignorePlayer = true;
  hear([{ x: 10, y: 0, z: -6, radius: 10, level: 2, source: 'player' }]);
  assert.equal(ear.investigating, undefined);
  hear([{ x: 10, y: 0, z: -6, radius: 10, level: 2 }]);
  assert.ok(ear.investigating, 'a noise of nobody known is heard');
  ear.investigating = undefined;
  e2.ignorePlayer = false;
  hear([{ x: 10, y: 0, z: -6, radius: 10, level: 2, source: 'player' }]);
  assert.ok(ear.investigating, 'the player noise with the option off');
});
