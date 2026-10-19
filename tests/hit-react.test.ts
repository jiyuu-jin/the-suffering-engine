// Hit reactions (docs/game-logic.md §15.13; src/game/actors/hit-react.ts): which
// HitReactBehavior a blow picks, when a running reaction refuses a new one, partial-body
// flinches that do not stop the character, and damage over time that never reaches a band.
// The pure rules and the actor runs need no game data; the retail tables skip without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import type { CreatureKind } from '../src/game/actors/kinds';
import { flinchClip, hitReactOf, pickHitReact, reactionBlocks, readHitTables, readHitReactList, type HitReactDef } from '../src/game/actors/hit-react';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage, type PropValue } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';

const R = (id: number, pkg = 0): ResRef => ({ pkg, id });
const key = (r: ResRef | undefined) => (r ? `${r.pkg}:${r.id}` : '');

/** A HitReactBehavior value list: p4 min, p5 max, p6 mode, p7 clips, p12 layer bone, ... */
function def(min: number, max: number, o: { mode?: number; clips?: ResRef[]; layer?: number; side?: number; sideClips?: [ResRef, ResRef]; special?: ResRef; attacks?: ResRef[]; knock?: ResRef[]; down?: [number, number]; id?: number } = {}): HitReactDef {
  const v: PropValue[] = [];
  v[2] = (o.attacks ?? []) as unknown as PropValue;
  v[3] = (o.special ?? null) as unknown as PropValue;
  v[4] = min;
  v[5] = max;
  v[6] = o.mode ?? 1;
  v[7] = (o.clips ?? [R(1)]) as unknown as PropValue;
  v[8] = 1;
  v[9] = 1;
  v[10] = 0;
  v[12] = o.layer ?? -1;
  v[13] = o.side ?? -1;
  v[14] = (o.sideClips?.[0] ?? null) as unknown as PropValue;
  v[15] = (o.sideClips?.[1] ?? null) as unknown as PropValue;
  (o.knock ?? []).forEach((r, i) => (v[18 + i] = r as unknown as PropValue));
  v[24] = o.down?.[0] ?? 0;
  v[25] = o.down?.[1] ?? 1;
  return hitReactOf(R(o.id ?? 100 + min), v);
}

// ---------------------------------------------------------------------------------------
// Pure rules [verified: Suffering.rfl 0x1009e650, 0x100e6480, 0x100e83f0, 0x100e8430]

test('pick: the last band whose p4 <= amount; below the first band nothing reacts', () => {
  const list = [def(2, 4), def(4, 7), def(7, 10), def(10, 15), def(15, 25)];
  assert.equal(pickHitReact(list, 0.43), undefined, 'a gas frame (13/s at 30 fps)');
  assert.equal(pickHitReact(list, 1.99), undefined);
  assert.equal(pickHitReact(list, 2)?.index, 0, 'p4 is inclusive');
  assert.equal(pickHitReact(list, 6.9)?.index, 1);
  assert.equal(pickHitReact(list, 12)?.index, 3);
  assert.equal(pickHitReact(list, 500)?.index, 4, 'p5 does not cap the band: the last band takes everything above');
  assert.equal(pickHitReact([], 50), undefined, 'no p70 list (Rat, Killjoy, Horace): never a reaction');
  // Order matters, not sorting: the walk stops at the first p4 above the amount.
  assert.equal(pickHitReact([def(2, 4), def(10, 15), def(4, 7)], 8)?.index, 0, 'stops at 10, never sees the 4');
});

test('pick: p5 < 0 tops the band with the next entry; the band position scales it', () => {
  const list = [def(2, -1), def(7, -1), def(12, -1), def(17, 999)];
  const p = pickHitReact(list, 4.5)!;
  assert.equal(p.index, 0);
  assert.equal(p.max, 7);
  assert.equal(p.scale, 0.5);
  const last = pickHitReact([def(12, -1)], 30)!;
  assert.deepEqual([last.max, last.scale], [12, 1], 'the last entry tops itself: a single value, scale 1');
  assert.equal(pickHitReact([def(0, 10)], 25)!.scale, 1, 'clamped at the top');
});

test('pick: specials by Special Hit Reaction or attack, whatever the amount', () => {
  const hits = [def(7, 10)];
  const specials = [def(15, 99, { special: R(439, 2), id: 308 }), def(15, 25, { special: R(545, 2), id: 648 }), def(0, 150, { special: R(736, 2), id: 1337, attacks: [R(5, 9)] })];
  assert.equal(key(pickHitReact(hits, 0.3, { specials, special: R(545, 2) })?.def.ref), '0:648', 'an arc frame electrocutes');
  assert.equal(pickHitReact(hits, 0.3, { specials, special: R(545, 2) })?.special, true);
  assert.equal(key(pickHitReact(hits, 3, { specials, attack: R(5, 9) })?.def.ref), '0:1337', 'p2 lists the attack');
  assert.equal(pickHitReact(hits, 3, { specials, special: R(999, 2) }), undefined, 'unknown special: the damage band (none at 3)');
  assert.equal(pickHitReact(hits, 3, { specials }), undefined, 'no special on the blow: specials are not looked at');
});

test('pick: the no-partial flag skips layered entries both ways', () => {
  const list = [def(2, 4, { layer: 5 }), def(4, 7, { layer: 5 }), def(7, 10)];
  assert.equal(pickHitReact(list, 5)?.index, 1);
  assert.equal(pickHitReact(list, 5, { noLayered: true }), undefined);
  assert.equal(pickHitReact(list, 8, { noLayered: true })?.index, 2);
});

test('interrupts: p6 mode 0 never, 1 above the top, 2 from the p4, 3 always', () => {
  const run = (mode: number) => ({ min: 10, max: 15, mode });
  assert.equal(reactionBlocks(run(0), 1000), true);
  assert.equal(reactionBlocks(run(1), 15), true, 'mode 1: a blow at the top still waits');
  assert.equal(reactionBlocks(run(1), 16), false);
  assert.equal(reactionBlocks(run(2), 9), true);
  assert.equal(reactionBlocks(run(2), 10), false, 'mode 2: a blow of the same band restarts it');
  assert.equal(reactionBlocks(run(3), 0), false);
});

test('flinch clip: attacker above the side bone -> p7, else p14 (-x) / p15 (+x)', () => {
  const d = def(2, 4, { layer: 1, side: 2, clips: [R(1)], sideClips: [R(2), R(3)] });
  assert.equal(key(flinchClip(d, { x: -1, y: 0 }, 1)), '0:2');
  assert.equal(key(flinchClip(d, { x: 1, y: 0 }, 1)), '0:3');
  assert.equal(key(flinchClip(d, { x: 1, y: 2 }, 1)), '0:1');
  assert.equal(key(flinchClip(d, undefined, undefined)), '0:1', 'no attacker: p7');
});

// ---------------------------------------------------------------------------------------
// Actor runs (synthetic rig, decoded tables)

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

// 0 idle, 1 / 2 / 3 hits (0.5 s), 4 lying pose, 5 getting up.
const CLIPS = [clip(0), clip(1, 0.5), clip(2, 0.5), clip(3, 0.5), clip(4, 0.1), clip(5, 0.6)];

function kind(): CreatureKind {
  const skinned = rig();
  return {
    key: 'test:hr',
    template: { pkg: 0, id: 0 },
    className: 'CartWheeler',
    skinned,
    proto: new Character(skinned, CLIPS),
    idle: 0,
    walk: -1,
    run: -1,
    attacks: [],
    hits: [1],
    deaths: [],
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
    maxHealth: 1000,
    decor: false,
  };
}

function env(): ActorEnv {
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
    onDeath: () => {},
    clip: (_a, r) => (r && r.pkg === 0 && r.id < CLIPS.length ? r.id : -1),
    entity: () => undefined,
    send: () => {},
    say: () => 0,
  };
}

const IDLE = { cls: 'IdleBehavior', next: [], kind: 'idle', fidgets: [], fidgetMin: 4, fidgetMax: 12 } as never;

function make(hits: HitReactDef[], specials: HitReactDef[] = []) {
  const a = new Actor(kind(), { x: 0, y: 0, z: 0 }, 0);
  const e = env();
  a.profile = { team: '10:212', active: IDLE, hitReacts: { hits, specials } };
  a.setBehavior(IDLE, e);
  a.health = 1000;
  return { a, e };
}

function run(a: Actor, e: ActorEnv, secs: number, each?: () => void) {
  for (let t = 0; t < secs; t += 1 / 30) {
    e.time += 1 / 30;
    each?.();
    a.update(1 / 30, e);
    a.animate(1 / 30);
  }
}

const CW = () => [def(2, 4, { layer: 1, side: 2, clips: [R(1)], sideClips: [R(2), R(3)] }), def(7, 10, { clips: [R(1)] }), def(15, 25, { mode: 2, clips: [R(2)], knock: [R(9), R(9), R(4), R(5)], down: [0.5, 3.5] })];

test('damage over time below the first band: no reaction, ever (the gas chamber CartWheeler)', () => {
  const { a, e } = make(CW());
  // 13 points a second as whole points (what the port deals), each frame's share 13/30.
  let acc = 0;
  run(a, e, 3, () => {
    acc += 13 / 30;
    const n = Math.floor(acc);
    acc -= n;
    if (n) a.damage(n, e, { x: 0, y: 0, z: 3 }, 1, { frameAmount: 13 / 30 });
  });
  assert.ok(a.health < 1000 - 30, 'the gas does its damage');
  assert.notEqual(a.state, 'hurt', 'and never stun-locks');
  assert.equal(a.ch.layers.size, 0, 'not even a flinch');
});

test('a small blow flinches a layer and leaves the state alone; a big one stops the character', () => {
  const { a, e } = make(CW());
  const before = a.state;
  a.damage(3, e, { x: 2, y: 0, z: 0 }, 'player');
  assert.equal(a.state, before, 'partial-body flinch: the behaviour goes on');
  assert.equal(a.ch.layers.has(1), true, 'the flinch plays on bone p12');
  a.damage(3, e, { x: 2, y: 0, z: 0 }, 'player');
  run(a, e, 1);
  assert.equal(a.ch.layers.get(1)?.mix ?? 0, 0, 'the layer ends with its clip');
  a.damage(8, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(a.state, 'hurt', 'whole-body reaction');
  run(a, e, 1);
  assert.notEqual(a.state, 'hurt', 'and it ends with its clip');
});

test('a running reaction refuses blows by its mode; a knockdown stays down, then gets up', () => {
  const { a, e } = make(CW());
  a.damage(20, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(a.state, 'hurt');
  // Mode 2 (from its p4 = 15): an 8 (band 7..10) does not cut in.
  a.damage(8, e, { x: 0, y: 0, z: 3 }, 'player');
  run(a, e, 0.6);
  assert.equal(a.state, 'hurt', 'down on the floor');
  // Down time p24 + (p25 - p24) x 0.5 = 2 s, then the getting-up clip.
  run(a, e, 1.6);
  assert.equal(a.state, 'hurt', 'still down');
  run(a, e, 1.5);
  assert.notEqual(a.state, 'hurt', 'up again');
});

test('posed bodies and sequence actors stay out of it; no tables -> the legacy kind clips', () => {
  const { a, e } = make(CW());
  a.setScriptPose({ x: 0, y: 0, z: 0 }, new THREE.Quaternion());
  a.damage(20, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.notEqual(a.state, 'hurt', 'the Stomp root swallows the attack');
  a.setScriptPose(null);
  const b = make(CW());
  b.a.profile = { team: '10:212', active: IDLE };
  b.a.damage(1, b.e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(b.a.state, 'hurt', 'without decoded tables any blow plays the kind clip (as before)');
});

test('the special gate (a CeilingFloorTransition in transit) swallows reactions', () => {
  const { a, e } = make(CW());
  a.reactGate = () => false;
  a.damage(20, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.notEqual(a.state, 'hurt');
  a.reactGate = undefined;
  a.damage(20, e, { x: 0, y: 0, z: 3 }, 'player');
  assert.equal(a.state, 'hurt');
});

test("a hazard's blows do not drag the chase to the hazard (the gas tile centre)", () => {
  const { a, e } = make(CW());
  a.kind.hostile = true; // a creature: fights back from its idle root
  a.damage(1, e, { x: 0, y: 0, z: 3 }, 'player');
  const seen = () => (a as unknown as { lastSeen: THREE.Vector3 }).lastSeen.clone();
  assert.deepEqual(seen().toArray(), [0, 0, 3], 'the player shot it: that is where the player was');
  a.damage(1, e, { x: 9, y: 0, z: -9 }, 0x6885, { frameAmount: 0.4 });
  assert.deepEqual(seen().toArray(), [0, 0, 3], 'a gas tile (no attacker) leaves it alone');
});

// ---------------------------------------------------------------------------------------
// Retail tables

let pk: Map<number, EntityPackage> | undefined;
function pkgs() {
  if (pk) return pk;
  pk = new Map();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), adu: ld(`${base}.adu`) } as EntityPackage);
  }
  return pk;
}
const values = (r: ResRef) => {
  const t = readObjectTemplate(pkgs(), r)!;
  return decodeTemplateProps(classByHash(t.classHash)!, t);
};

test('retail CartWheeler 10:24: bands 2/4/7/10/15, flinches below 7, gas and fire never react', { skip }, () => {
  const t = readHitTables(pkgs(), values(R(24, 10)));
  assert.deepEqual(t.hits.map((d) => [key(d.ref), d.min, d.max, d.mode, d.layerBone]), [
    ['10:29', 2, 4, 1, 5],
    ['10:91', 4, 7, 1, 5],
    ['10:97', 7, 10, 1, -1],
    ['10:92', 10, 15, 2, -1],
    ['10:93', 15, 25, 2, -1],
  ]);
  assert.deepEqual(t.hits[0].side.map(key), ['10:52', '10:53']);
  assert.equal(t.hits[0].sideBone, 17);
  assert.deepEqual(t.specials.map((d) => [key(d.ref), key(d.special)]), [
    ['10:308', '2:439'],
    ['10:648', '2:545'],
    ['10:1337', '2:736'],
  ]);
  // The gas chamber's floor tiles: 13 / s, a frame at 30 fps (or the port's 1-point steps).
  assert.equal(pickHitReact(t.hits, 13 / 30, { specials: t.specials }), undefined);
  assert.equal(pickHitReact(t.hits, 1, { specials: t.specials }), undefined);
  assert.equal(key(pickHitReact(t.hits, 3)?.def.ref), '10:29');
  assert.equal(key(pickHitReact(t.hits, 20)?.def.ref), '10:93');
  // Knockdown 10:93: down 0.5..3.5 s, getting up 10:57 [inferred roles].
  assert.deepEqual([key(t.hits[4].knock.down), key(t.hits[4].knock.getUp), t.hits[4].downTime], ['10:56', '10:57', [0.5, 3.5]]);
  // An arc's frame (Damage Action Object p7 2:545) electrocutes it whatever the amount.
  assert.equal(key(pickHitReact(t.hits, 0.2, { specials: t.specials, special: R(545, 2) })?.def.ref), '10:648');
  // On a ceiling (p175 / p176): from 5 on.
  const ceil = readHitReactList(pkgs(), values(R(24, 10))[175]);
  assert.deepEqual(ceil.map((d) => [key(d.ref), d.min]), [['10:1259', 5]]);
});

test('retail guard 10:3: whole-body reactions from 2, none of them partial', { skip }, () => {
  const t = readHitTables(pkgs(), values(R(3, 10)));
  assert.deepEqual(t.hits.map((d) => [key(d.ref), d.min, d.layerBone]), [
    ['10:123', 2, -1],
    ['10:122', 7, -1],
    ['10:121', 12, -1],
    ['10:8', 17, -1],
  ]);
  assert.equal(pickHitReact(t.hits, 1.5), undefined);
  assert.equal(pickHitReact(t.hits, 4)!.max, 7, 'p5 -1: up to the next p4');
  assert.equal(pickHitReact(t.hits, 0.4, { specials: t.specials, special: R(545, 2) }), undefined, 'no 2:545 entry: an arc frame does nothing');
});
