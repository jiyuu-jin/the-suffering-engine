// The player's Hit Reacting (17), third-person Jump (8) and Landing (12) states
// (src/game/actors/player-states.ts; docs/game-logic.md §14.1 "Player hit reactions", "Third-person
// jump and landing"): the reaction picked by the blow's impact force from the Player's p89 / p90
// Hit Reaction lists, the gate and cooldown, the knockback through the motor, the jump and
// landing clips' root motion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import {
  PlayerStates,
  RootClip,
  hitTurnStep,
  jumpKind,
  jumpRootScale,
  jumpSteerRate,
  landingSlot,
  pickPlayerHitReaction,
  playerHitReaction,
  readJumpParams,
  readPlayerHitTables,
  rollSide,
  type PlayerHitReaction,
  type PlayerHitStatus,
  type PlayerHitTables,
  type StatesBody,
} from '../src/game/actors/player-states';
import { missileForce } from '../src/game/actors/actor';
import { CollisionWorld } from '../src/app/physics';
import { PlayerController } from '../src/app/player';
import { ROOT_BONE_HASH, readAnimation, type AnimClipData } from '../src/formats/animation';
import type { EntityPackage, EntityPackageSet, PropValue } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';
import type { MeshPart } from '../src/formats/types';
import { readTemplate } from '../src/game/actors/specials/runtime';
import { meleeBlow } from '../src/game/actors/specials/params';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { playerSaveProvider } from '../src/game/save/providers';

const R = (id: number, pkg = 2): ResRef => ({ pkg, id });
const entry = (o: Partial<PlayerHitReaction> & { min: number }): PlayerHitReaction => ({ ref: R(o.min), attacks: [], clips: [R(100 + o.min)], fp: false, cooldown: 1, ...o });
const T: PlayerHitTables = {
  hits: [entry({ min: 7, cooldown: 1.2, air: R(126) }), entry({ min: 10, cooldown: 1.5 }), entry({ min: 17, fp: true, land: R(130), fall: R(129), die: R(131), cooldown: 0.5 })],
  specials: [entry({ min: 1, special: R(736) })],
  layerBone: 5,
  fallPose: true,
};
const idle: PlayerHitStatus = { cooldown: 0, lastMin: 0, firstPerson: false, rolling: false, refused: false };

test('pick (0x1009e650 over Player p89 / p90): the last band at or below the force; specials whatever the force', () => {
  assert.equal(pickPlayerHitReaction(T, 6.99), undefined, 'below the first band: nothing');
  assert.equal(pickPlayerHitReaction(T, 7)?.def.min, 7);
  assert.equal(pickPlayerHitReaction(T, 16.9)?.def.min, 10);
  assert.equal(pickPlayerHitReaction(T, 40)?.def.min, 17);
  const s = pickPlayerHitReaction(T, 0, { special: R(736) });
  assert.equal(s?.def.special?.id, 736);
  assert.equal(s?.special, true);
  assert.equal(pickPlayerHitReaction(T, 12, { special: R(545) })?.def.min, 10, 'an unlisted special: by force');
});

test('gate (0x1002ede0) and the running reaction (0x1002e255)', () => {
  const noRoot = () => false;
  assert.equal(playerHitReaction(T, idle, { force: 12 }, noRoot)?.min, 10);
  // Cooldown: only a force at least the last reaction's p2.
  assert.equal(playerHitReaction(T, { ...idle, cooldown: 0.3, lastMin: 10 }, { force: 8 }, noRoot), undefined);
  assert.equal(playerHitReaction(T, { ...idle, cooldown: 0.3, lastMin: 10 }, { force: 10 }, noRoot)?.min, 10);
  // Running: only ABOVE its p2.
  assert.equal(playerHitReaction(T, { ...idle, running: T.hits[1], lastMin: 10 }, { force: 10 }, noRoot), undefined);
  assert.equal(playerHitReaction(T, { ...idle, running: T.hits[1], lastMin: 10 }, { force: 10.5 }, noRoot)?.min, 10);
  assert.equal(playerHitReaction(T, { ...idle, running: T.hits[1], lastMin: 10 }, { force: 20 }, noRoot)?.min, 17);
  // First person: only p3 entries (the knockdown).
  assert.equal(playerHitReaction(T, { ...idle, firstPerson: true }, { force: 12 }, noRoot), undefined);
  assert.equal(playerHitReaction(T, { ...idle, firstPerson: true }, { force: 20 }, noRoot)?.min, 17);
  // Rolling: a clip with root motion is refused.
  const knock = (d: PlayerHitReaction) => d.min === 17;
  assert.equal(playerHitReaction(T, { ...idle, rolling: true }, { force: 20 }, knock), undefined);
  assert.equal(playerHitReaction(T, { ...idle, rolling: true }, { force: 8 }, knock)?.min, 7);
  // The resistance scales the force of the real pick (types 14 / 6: zero).
  assert.equal(playerHitReaction(T, idle, { force: 20, scaled: 0 }, noRoot), undefined);
  // A refusing state (Landing, Controlled, LadderClimb ...).
  assert.equal(playerHitReaction(T, { ...idle, refused: true }, { force: 20 }, noRoot), undefined);
});

test('turn toward the attacker: 30 % of the angle per frame (0x1000d4c0 with 0.3)', () => {
  assert.ok(Math.abs(hitTurnStep(0, 1, 0, 1) - 0.3) < 1e-9);
  assert.ok(Math.abs(hitTurnStep(0, 1, 1 / 30) - 0.3) < 1e-9, 'one 30 fps frame');
  assert.ok(Math.abs(hitTurnStep(3, -3, 0, 1) - (3 + 0.3 * (2 * Math.PI - 6))) < 1e-9, 'the short way round');
});

test('jump choice (Jump enter 0x1003aed9), scales, steering, landing slot', () => {
  const p = { forwardDeg: 45, backDeg: 135 };
  assert.equal(jumpKind(0.1, 1, p), 'stand');
  assert.equal(jumpKind(1, Math.cos(0.5), p), 'forward');
  assert.equal(jumpKind(1, 0, p), 'roll');
  assert.equal(jumpKind(1, -1, p), 'back');
  assert.deepEqual(jumpRootScale(1), { y: 1, z: 1 });
  assert.deepEqual(jumpRootScale(0.1), { y: 1, z: 0.3 });
  const pv: PropValue[] = [];
  pv[205] = 1;
  pv[206] = 7;
  pv[207] = 3;
  pv[208] = 3;
  assert.equal(jumpSteerRate('stand', 1, 0, pv), 3);
  assert.equal(jumpSteerRate('forward', 1, 0, pv), 1);
  assert.equal(jumpSteerRate('forward', -1, 0, pv), 7);
  assert.equal(jumpSteerRate('back', -1, 0, pv), 1);
  assert.equal(jumpSteerRate('forward', 0.2, 1, pv), 3, 'mostly sideways');
  assert.equal(landingSlot(0, 0, false), 158);
  assert.equal(landingSlot(2, 2, false), 160);
  assert.equal(landingSlot(-2, 2, true), 163);
  assert.equal(rollSide(1, 0, 0), 1, 'stick to the right of a body looking down -Z');
  assert.equal(rollSide(-1, 0, 0), -1);
  assert.equal(missileForce({ near: 20, far: 2, nearDist: 4, farDist: 20 }, 2), 20);
  assert.equal(missileForce({ near: 20, far: 2, nearDist: 4, farDist: 20 }, 12), 11);
  assert.equal(missileForce({ near: 6, far: 0, nearDist: 1000, farDist: 1000 }, 30), 6);
  assert.equal(missileForce(undefined, 3), undefined);
});

// --- Retail data ----------------------------------------------------------------------------

function packages(ids: number[]): EntityPackageSet {
  const pkgs = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (!ids.includes(id) || pkgs.has(id)) continue;
    const base = db.slice(0, -3);
    pkgs.set(id, { id, name: base, odu: readSrsc(base + '.odu'), adu: readSrsc(base + '.adu') } as unknown as EntityPackage);
  }
  return pkgs;
}

test('data: the Player 2:5 Hit Reaction lists, the clips and their roots', { skip }, () => {
  const pkgs = packages([2]);
  const player = readTemplate(pkgs, R(5))!.v;
  const t = readPlayerHitTables((r) => readTemplate(pkgs, r), player);
  assert.deepEqual(t.hits.map((h) => h.min), [7, 10, 17]);
  assert.deepEqual(t.hits.map((h) => h.clips.map((c) => c.id)), [[126], [138], [128]]);
  assert.deepEqual(t.hits.map((h) => h.fp), [false, false, true]);
  assert.deepEqual(t.hits.map((h) => h.cooldown.toFixed(1)), ['1.2', '1.5', '0.5']);
  assert.deepEqual([t.hits[2].fall?.id, t.hits[2].land?.id, t.hits[2].die?.id], [129, 130, 131]);
  assert.equal(t.specials.length, 1);
  assert.equal(t.specials[0].special?.id, 736);
  assert.equal(t.specials[0].clips[0].id, 672);
  assert.equal(t.layerBone, 5);
  assert.equal(t.fallPose, true);
  // The creature form has no lists.
  const cr = readTemplate(pkgs, R(240))!.v;
  const ct = readPlayerHitTables((r) => readTemplate(pkgs, r), cr);
  assert.equal(ct.hits.length + ct.specials.length, 0);
  // Roots: 2:128 three metres back (+Z) in 0.53 s, 2:130 0.55 m at rate 1.5; the light ones in place.
  const adu = (pkgs.get(2) as unknown as { adu: ReturnType<typeof readSrsc> }).adu;
  const r128 = new RootClip(readAnimation(adu, 128)!);
  for (let i = 0; i < 40; i++) r128.step(1 / 60);
  assert.ok(Math.abs(r128.moved.z - 3.0) < 0.01 && Math.abs(r128.moved.x) < 0.01, `${JSON.stringify(r128.moved)}`);
  assert.ok(Math.abs(r128.length - 0.533) < 0.01);
  const r130 = new RootClip(readAnimation(adu, 130)!);
  assert.ok(Math.abs(r130.length - 2.167 / 1.5) < 0.01, `${r130.length}`);
  for (const id of [126, 138, 672]) assert.equal(RootClip.hasRoot(readAnimation(adu, id)), false, `2:${id}`);
  // Jump clips (PWP p151..p153 of every human set) and landings p158..p163.
  const pwp = readTemplate(pkgs, R(436))!.v;
  const jp = readJumpParams(pwp);
  assert.deepEqual(jp.clips.map((c) => c?.id), [87, 86, 85]);
  assert.deepEqual(jp.landing.map((c) => c?.id), [91, 91, 89, 89, 88, 88]);
  const fwd = new RootClip(readAnimation(adu, 86)!);
  let apex = 0;
  for (let i = 0; i < 60; i++) {
    fwd.step(1 / 60);
    apex = Math.max(apex, fwd.moved.y);
  }
  assert.ok(Math.abs(fwd.moved.z + 4.21) < 0.02 && Math.abs(apex - 1.9) < 0.02, `forward ${JSON.stringify(fwd.moved)} apex ${apex}`);
  // Landing 2:89: 0.4 m forward in 0.1 s; 2:91 / 2:88 in place.
  assert.ok(Math.abs(new RootClip(readAnimation(adu, 89)!).clip.duration - 0.1) < 0.01);
  const l89 = new RootClip(readAnimation(adu, 89)!);
  l89.step(0.2);
  assert.ok(Math.abs(l89.moved.z + 0.4) < 0.01, `${l89.moved.z}`);
  for (const id of [91, 88]) assert.equal(RootClip.hasRoot(readAnimation(adu, id)), false, `2:${id}`);
  // Ladder rungs (Ladder Animation Set p0..p3): 0.5 m up / down in 0.367 s at speed 1 = 1.36 m/s.
  for (const [id, dy] of [[234, 0.5], [243, 0.5], [236, -0.5], [237, -0.5]] as const) {
    const r = new RootClip(readAnimation(adu, id)!);
    r.step(1);
    assert.ok(Math.abs(r.moved.y - dy) < 0.01 && Math.abs(r.length - 0.367) < 0.01, `2:${id} ${r.moved.y} ${r.length}`);
  }
});

test('data: NPC blow forces (Melee Weapon p69 x Attack p7)', { skip }, () => {
  const pkgs = packages([2, 10]);
  const cw = readTemplate(pkgs, R(24, 10))!.v;
  // The CartWheeler's blades (p69 6): attacks 10:955 x1.3, 10:956 x2, 10:957 x4; the ceiling slash 10:143 x3.5.
  const f = (id: number) => meleeBlow(pkgs, cw as PropValue[], R(id, 10))!.force;
  assert.ok(Math.abs(f(955) - 7.8) < 1e-4 && f(956) === 12 && f(957) === 24 && f(143) === 21, `${f(955)} ${f(956)} ${f(957)} ${f(143)}`);
});

// --- Runtime against the real motor -----------------------------------------------------------

const floor = (x0: number, x1: number, z0: number, z1: number, y = 0): MeshPart =>
  ({ positions: new Float32Array([x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1]), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) }) as unknown as MeshPart;
const wall = (z: number): MeshPart =>
  ({ positions: new Float32Array([-5, -1, z, 5, -1, z, -5, 4, z, 5, 4, z]), indices: new Uint32Array([0, 1, 2, 1, 3, 2]) }) as unknown as MeshPart;
const g = globalThis as unknown as { document?: unknown; window?: unknown };
const events = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null };
g.document ??= events;
g.window ??= events;

/** A linear root clip: (dx, dy, dz) over `dur` s. */
const lin = (dur: number, dz: number, dy = 0, rate = 1): AnimClipData => ({
  id: 1,
  animSet: 0,
  duration: dur,
  flags: 1,
  blendTime: 0,
  rate,
  links: [],
  tracks: [{ boneHash: ROOT_BONE_HASH, format: 0x80, times: new Float32Array([0, dur]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), translations: new Float32Array([0, 0, 0, 0, dy, dz]), constantTranslation: [0, 0, 0] }],
});

function rig(parts: MeshPart[], clips: Record<number, AnimClipData>, over: { transformed?: () => boolean } = {}) {
  const p = new PlayerController(new THREE.PerspectiveCamera(), events as unknown as HTMLElement);
  p.enabled = true;
  p.mode = 'tp';
  p.setWorld(new CollisionWorld({ parts }));
  p.teleport(new THREE.Vector3(0, 0, 0), 0);
  for (let i = 0; i < 5; i++) p.update(1 / 60);
  const plays: string[] = [];
  const body: StatesBody = { play: (c) => (plays.push(`${c.id}`), 1), release: () => plays.push('release'), layer: (c, b) => (plays.push(`layer ${c.id}@${b}`), 0.5), stopLayer: () => plays.push('stop layer') };
  const pv: PropValue[] = [];
  Object.assign(pv, { 151: R(87), 152: R(86), 153: R(85), 158: R(91), 159: R(91), 160: R(89), 161: R(89), 162: R(88), 163: R(88), 168: 45, 169: 135 });
  const s = new PlayerStates({
    player: p,
    body: () => body,
    clip: (r) => clips[r.id],
    tables: T,
    pwp: () => pv,
    playerValues: Object.assign([], { 205: 1, 206: 7, 207: 3, 208: 3 }),
    refused: () => false,
    rolling: () => false,
    transformed: over.transformed ?? (() => false),
    random: () => 0,
  });
  p.jumpOverride = (i) => s.onJump(i);
  p.onUpdate((f) => s.update(f));
  return { p, s, plays };
}

test('runtime: a knockdown moves the player 3 m back through the motor, then the floor clip, then the cooldown', () => {
  const { p, s, plays } = rig([floor(-20, 20, -20, 20)], { 117: lin(0.533, 3), 130: lin(1.444, 0.55) });
  p.setVirtualInput({ forward: 1, strafe: 0, run: true });
  // An attacker in front (-Z): the body turns to it, and the blow knocks him back (+Z).
  assert.ok(s.onBlow({ force: 24, from: { x: 0, y: 0, z: -3 } }));
  assert.equal(s.phase, 'react');
  assert.ok(p.stateHold && p.actionsLocked && p.viewLock, 'move, actions and look locked');
  const z0 = p.position.z;
  for (let i = 0; i < 40; i++) p.update(1 / 60);
  assert.equal(s.phase, 'down', 'the floor clip p7 (Landing)');
  assert.ok(Math.abs(p.position.z - z0 - 3.0) < 0.06, `knocked back ${p.position.z - z0}`);
  for (let i = 0; i < 120 && s.phase !== 'none'; i++) p.update(1 / 60);
  assert.equal(s.phase, 'none');
  assert.ok(Math.abs(p.position.z - z0 - 3.55) < 0.08, `with the floor clip ${p.position.z - z0}`);
  assert.equal(p.stateHold || p.actionsLocked || !!p.viewLock, false);
  assert.ok(Math.abs(s.cooldown - 0.5) < 0.05, `cooldown ${s.cooldown}`);
  assert.deepEqual(plays.slice(0, 3), ['117', '130', 'release']);
  // Within the cooldown a lighter blow does not react.
  assert.equal(s.onBlow({ force: 8 }), undefined);
  // Walking again.
  const z1 = p.position.z;
  for (let i = 0; i < 30; i++) p.update(1 / 60);
  assert.ok(p.position.z < z1 - 1, 'walks again');
});

test('runtime: a wall stops the knockback; first person comes back afterwards', () => {
  const { p, s } = rig([floor(-20, 20, -20, 20), wall(1.0)], { 117: lin(0.533, 3), 130: lin(1.444, 0.55) });
  p.setMode('fp');
  assert.equal(s.onBlow({ force: 12 }), undefined, 'first person: only the knockdown');
  assert.ok(s.onBlow({ force: 18 }));
  assert.equal(p.mode, 'tp', 'Hit Reacting ends First Person');
  for (let i = 0; i < 160; i++) p.update(1 / 60);
  assert.ok(p.position.z < 1.0 - p.motor.cfg.radius + 0.05 && p.position.z > 0.5, `stopped at the wall: ${p.position.z}`);
  assert.equal(s.phase, 'none');
  assert.equal(p.mode, 'fp', 'back in first person');
});

test('runtime: a reaction\'s third person is not the view the creature form, death or a save gives back', () => {
  let creature = false;
  const { p, s } = rig([floor(-20, 20, -20, 20)], { 117: lin(0.533, 3), 130: lin(1.444, 0.55) }, { transformed: () => creature });
  p.setMode('fp');
  assert.ok(s.onBlow({ force: 18 }));
  assert.equal(p.mode, 'tp');
  assert.equal(p.chosenMode(), 'fp', 'the chosen view under the reaction');
  // The creature form starts mid-reaction (insanity enterCreature keeps chosenMode()): the
  // reaction ends and leaves the creature's third person alone.
  const saved = p.chosenMode();
  creature = true;
  for (let i = 0; i < 5; i++) p.update(1 / 60);
  assert.equal(s.phase, 'none');
  assert.equal(p.mode, 'tp', 'still third person in the creature form');
  assert.equal(saved, 'fp', 'the creature form gives back first person');
  // Death mid-reaction: the death view stays, the chosen view is first person.
  creature = false;
  p.setMode('fp');
  assert.ok(s.onBlow({ force: 18 }));
  const deathSaved = p.chosenMode();
  p.setMode('tp');
  s.reset(true);
  assert.equal(p.mode, 'tp', 'the death keeps its view');
  assert.equal(deathSaved, 'fp');
  assert.equal(p.stateTp, false);
  // A save made during a reaction keeps first person.
  p.setMode('fp');
  assert.ok(s.onBlow({ force: 18 }));
  assert.equal(p.mode, 'tp');
  assert.equal((playerSaveProvider(p).save() as { mode: string }).mode, 'fp');
});

test('runtime: in the air a light hit is a layer on bone p109; knocked off a ledge he drops straight down', () => {
  const a = rig([floor(-20, 20, -20, 20)], { 107: lin(0.5, 0) });
  a.p.motor.onGround = false;
  a.p.motor.position.y = 3;
  assert.ok(a.s.onBlow({ force: 7 }));
  assert.equal(a.s.phase, 'air');
  assert.ok(a.plays.includes('layer 126@5'), a.plays.join());
  assert.ok(a.p.stateHold && a.p.actionsLocked, 'locked while the layer plays');
  for (let i = 0; i < 40; i++) a.p.update(1 / 60);
  assert.equal(a.s.phase, 'none');
  // The ledge: the floor ends 1 m behind him over a 3 m drop.
  const b = rig([floor(-20, 20, -20, 1), floor(-20, 20, 1, 20, -3)], { 117: lin(0.533, 3), 130: lin(1.444, 0.55) });
  assert.ok(b.s.onBlow({ force: 20, from: { x: 0, y: 0, z: -2 } }));
  let fellAt: number | undefined, landedAt: number | undefined;
  for (let i = 0; i < 200; i++) {
    b.p.update(1 / 60);
    if (b.s.phase === 'fallen') fellAt ??= b.p.position.z;
    if (b.s.phase === 'down') landedAt ??= b.p.position.z;
  }
  assert.ok(fellAt !== undefined && landedAt !== undefined, 'Fall with the reaction on, then the floor clip');
  assert.ok(b.plays.includes('129'), 'the fall pose p6');
  assert.ok(fellAt! < 1.7 && Math.abs(landedAt! - fellAt!) < 1e-3, `dropped straight down off the edge: ${fellAt} -> ${landedAt}`);
  assert.ok(b.p.position.y < -2.9 && Math.abs(b.p.position.z - landedAt! - 0.55) < 0.05, `then the floor clip's 0.55 m: ${b.p.position.z}`);
  assert.equal(b.s.phase, 'none');
});

test('runtime: the third-person jump follows its clip root (forward 4.21 m, apex 1.9 m), falls with its last velocity, lands', () => {
  const { p, s, plays } = rig([floor(-20, 20, -20, 20)], { 86: lin(0.733, -4.21, 1.35), 89: lin(0.1, -0.4), 91: lin(0.2, 0) });
  p.setVirtualInput({ forward: 1, strafe: 0, run: true });
  for (let i = 0; i < 20; i++) p.update(1 / 60);
  const z0 = p.position.z;
  p.jump();
  p.update(1 / 60);
  assert.equal(s.phase, 'jump');
  assert.equal(plays[0], '86', 'forward jump p152');
  let top = 0;
  for (let i = 0; i < 44; i++) {
    p.update(1 / 60);
    top = Math.max(top, p.position.y);
  }
  assert.equal(s.phase, 'fall', 'Fall after the clip');
  assert.ok(top > 1.3 && top < 1.4, `the clip's height ${top}`);
  for (let i = 0; i < 60 && s.phase === 'fall'; i++) p.update(1 / 60);
  assert.equal(s.phase, 'land');
  assert.ok(plays.includes('89'), 'forward landing p160');
  const travelled = z0 - p.position.z;
  assert.ok(travelled > 4.21 + 1, `root + steering + the kept fall velocity: ${travelled}`);
  for (let i = 0; i < 20; i++) p.update(1 / 60);
  assert.equal(s.phase, 'none');
});
