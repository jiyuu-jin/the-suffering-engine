// Chapters 9 / 10 (9 Lighthouse, 10 Docks) rules found by the playthrough (docs/playthrough.md
// "9 Lighthouse", "10 Docks"), decoded from Suffering.rfl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { PropValue } from '../src/formats/entities';
import { generatorPicks } from '../src/game/world/fx';
import { FireObj } from '../src/game/fx/effects';
import type { DynamicObject } from '../src/game/world/dynamic';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntities, indexEntities, type Entity, type EntityPackage } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { toOutputSpace } from '../src/formats/level';
import { applyCarry, clearCarry, recordCarry } from '../src/game/actors/companions';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

let pkgCache: Map<number, EntityPackage> | undefined;
function packages() {
  if (pkgCache) return pkgCache;
  pkgCache = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pkgCache.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pkgCache.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`) } as EntityPackage);
  }
  return pkgCache;
}
const level = (path: string): Entity[] => parseEntities(readSrsc(path), packages());

const list = (n: number) => Array.from({ length: n }, (_, i) => ({ pkg: 3, id: 100 + i }));
const gen = (mode: number, n: number, p1: number[] = [], p2 = 1): PropValue[] => {
  const v: PropValue[] = [];
  v[0] = list(n) as unknown as PropValue;
  v[1] = p1 as unknown as PropValue;
  v[2] = p2;
  v[6] = mode;
  return v;
};

test('Object Generator p6: 0 one random entry, 1 the next in order, 2 all, other the first (0x100b5ed0)', () => {
  // The Inferna footstep generator 3:2624: six fires, p6 0 -> one fire a step.
  const one = generatorPicks(gen(0, 6), { next: 0 }, () => 0.5);
  assert.deepEqual(one, [{ index: 3, count: 1 }]);
  const pick = { next: 0 };
  assert.deepEqual([0, 1, 2, 3].map(() => generatorPicks(gen(1, 3), pick)[0].index), [1, 2, 0, 1]);
  assert.deepEqual(generatorPicks(gen(2, 3), { next: 0 }).map((x) => x.index), [0, 1, 2]);
  assert.deepEqual(generatorPicks(gen(5, 3), { next: 0 }).map((x) => x.index), [0]);
  // Counts: p1[i] when p1 lists them, else p2; none below 1.
  assert.deepEqual(generatorPicks(gen(2, 2, [3, 0]), { next: 0 }), [{ index: 0, count: 3 }]);
  assert.deepEqual(generatorPicks(gen(2, 1, [], 6), { next: 0 }), [{ index: 0, count: 6 }]);
  assert.deepEqual(generatorPicks(gen(0, 0), { next: 0 }), []);
});

function fire(v: PropValue[]) {
  const d = { root: new THREE.Object3D(), uid: 0 } as unknown as DynamicObject;
  return new FireObj(d, v, new THREE.Matrix4(), 0);
}

test('Fire: p2 burn time, p9 growth, shrink over the last p10 s, destroyed when p19 = 0 (0x100acd00 / 0x100ac6e0)', () => {
  // The Inferna's footprint fire 3:3598: 2.5 s, 0.25 s up, 0.5 s down, p15 10 / s.
  const v: PropValue[] = [1, 1, 2.5, 0.7, 0.001, 0.7, 3, 3.5, 3, 0.25, 0.5, 0, 1, 0.35, 0.5, 10, 5, 0, null, 0, 0, 0];
  const f = fire(v);
  assert.equal(f.burnFor, 2.5);
  f.setLit(true);
  const cam = new THREE.Vector3(0, 0, 10);
  f.update(0.125, cam);
  assert.ok(Math.abs(f.k - 0.5) < 1e-6);
  f.update(0.2, cam);
  assert.equal(f.k, 1);
  for (let t = 0; t < 1.9; t += 0.1) f.update(0.1, cam);
  assert.ok(f.k < 1 && f.k > 0, `shrinking in the last 0.5 s (k ${f.k})`);
  for (let t = 0; t < 0.4; t += 0.1) f.update(0.1, cam);
  assert.equal(f.gone, true);
  // A placed fire (p2 0, p19 = On) burns until put out and is never removed.
  const placed = fire([0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 10, 5, 0, null, 1, 2, 11]);
  assert.equal(placed.burnFor, Infinity);
  placed.setLit(true);
  for (let t = 0; t < 30; t++) placed.update(1, cam);
  assert.equal(placed.lit, true);
  assert.equal(placed.k, 1);
  placed.setLit(false);
  for (let t = 0; t < 10; t++) placed.update(1, cam);
  assert.equal(placed.gone, false);
});

test('Mountable aim: +-p38 degrees of turn from the placement, +-p42 degrees of pitch (0x100183e0)', async () => {
  const { mountedAimLimits } = await import('../src/game/world/interact');
  // 9's searchlight 1376: p38 50, p42 55 (the port used +-25 degrees and -p43..p42).
  const v: unknown[] = [];
  v[38] = 50;
  v[42] = 55;
  v[43] = 45;
  const deg = Math.PI / 180;
  const a = mountedAimLimits(v, 40 * deg, -50 * deg);
  assert.ok(Math.abs(a.yaw - 40 * deg) < 1e-9 && Math.abs(a.pitch + 50 * deg) < 1e-9);
  const b = mountedAimLimits(v, -70 * deg, 80 * deg);
  assert.ok(Math.abs(b.yaw + 50 * deg) < 1e-9 && Math.abs(b.pitch - 55 * deg) < 1e-9);
  // A turn past a full circle is measured the short way round.
  const c = mountedAimLimits(v, (360 + 10) * deg, 0);
  assert.ok(Math.abs(c.yaw - 10 * deg) < 1e-9);
  v[38] = 360;
  assert.ok(Math.abs(mountedAimLimits(v, 170 * deg, 0).yaw - 170 * deg) < 1e-9);
});

test('Pushable: one nobody has moved never falls (no think of its own: vtable +0x18 0x10128410)', async () => {
  const { pushableMayFall } = await import('../src/game/world/props');
  // 9's lamp crank 9e1 rests inside the hidden lamp mechanism until the player climbs up.
  assert.equal(pushableMayFall({ grabbed: false }), false);
  assert.equal(pushableMayFall({ grabbed: true }), true);
  assert.equal(pushableMayFall({ grabbed: false, handled: true }), true);
});

test('Ladder: the climbing face is the Ladder Interaction Properties side p3, not the side the player stands on', async () => {
  const { ladderFaceSide } = await import('../src/game/world/interact');
  // 2:427 / 2:428 (every retail ladder): p3 = 3, the local -z face.
  assert.equal(ladderFaceSide([0, 2, 1, 3, 0, 360, 90, 0, -0.4]), 1);
  assert.equal(ladderFaceSide([0, 2, 1, 1]), -1);
  assert.equal(ladderFaceSide([0, 2, 1, 0]), 0);
  assert.equal(ladderFaceSide(undefined), 0);
});

test('9 -> 10: the transition without spawn names carries the companion to the Companion Spawn Point', { skip }, () => {
  const l9 = indexEntities(level('LEVELS/9 Lighthouse/9 Lighthouse.lvl'));
  const ents = level('LEVELS/10 Docks/10 Docks.lvl');
  const by = indexEntities(ents);
  const ca6 = l9.get(0xca6)!;
  assert.deepEqual(ca6.values[7], [0xbc9]);
  const copy = by.get(0x7b8)!;
  const moved: number[][] = [];
  const actor = { entity: copy, alive: true, health: 70, maxHealth: 100, yaw: 0, needsPlacement: false, motor: { teleport: (x: number, y: number, z: number) => moved.push([x, y, z]) }, sync() {} };
  const companion = { ...actor, entity: l9.get(0xbc9)! };
  const manager = { get: (uid: number) => (uid === 0xbc9 ? companion : uid === 0x7b8 ? actor : undefined), remove() {} } as never;
  recordCarry('LEVELS/9 Lighthouse/9 Lighthouse.lvl', ca6, manager);
  // ca6 names no spawn: 10's Player Spawn Point 86d (from 9, no name) lists 7b8 (p4) and the
  // Companion Spawn Point 908 (p5).
  const arrived = applyCarry('', ents, manager, (v) => (typeof v === 'string' ? v : ''));
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].point?.uid, 0x908);
  const [x, y, z] = toOutputSpace(by.get(0x908)!.position);
  assert.deepEqual(moved[0].map((v) => +v.toFixed(2)), [x, y, z].map((v) => +v.toFixed(2)));
  assert.equal(actor.health, 70);
  clearCarry();
});

test('10: the dark selves end their waves by the death message p29 (0x100e2620), not an output slot', { skip }, () => {
  const by = indexEntities(level('LEVELS/10 Docks/10 Docks.lvl'));
  for (const [self, relay] of [[0xa48, 0xa49], [0xa46, 0xa8c]]) {
    const e = by.get(self)!;
    assert.equal(e.family, 'Character');
    assert.equal(e.values[28], 0, 'no Died output');
    assert.equal(e.values[29], 19, 'the message p29 sent to the links on death');
    assert.ok(e.links.includes(relay));
    assert.equal(by.get(relay)!.props.inRelay, 19, 'the relay takes 19');
  }
});

test('10: the ending is chosen when Relay a87 enables the three Reputation Points Message Filters', { skip }, () => {
  const by = indexEntities(level('LEVELS/10 Docks/10 Docks.lvl'));
  assert.deepEqual(by.get(0xa87)!.links, [0xa86, 0xa88, 0xa89]);
  // The bounds (p1 < reputation <= p2) and, per filter, the relay that it enables (Enable, 4) in
  // front of the ending movie and in front of the boat sequence.
  const want: [number, [number, number], number, number][] = [
    [0xa86, [70, 999], 0xb39, 0x1089], // good
    [0xa88, [-90, 70], 0xb26, 0x108a], // neutral
    [0xa89, [-999, -90], 0xb3a, 0x108b], // evil
  ];
  for (const [uid, [lo, hi], movie, boat] of want) {
    const f = by.get(uid)!;
    assert.equal(f.className, 'Reputation Points Message Filter');
    assert.deepEqual([f.values[1], f.values[2]], [lo, hi]);
    const targets = f.links.map((u) => by.get(u)!).filter((r) => r.props.inEnable === 4 && r.props.enabled === 0);
    const reaches = (to: number) => targets.some((r) => r.links.includes(to));
    assert.ok(reaches(movie), `${uid.toString(16)} enables the relay to Movie Player ${movie.toString(16)}`);
    assert.ok(reaches(boat), `${uid.toString(16)} enables the relay to STOMP Player ${boat.toString(16)}`);
    assert.equal(by.get(movie)!.className, 'Movie Player');
  }
  // Every movie ends in the same STOMP 108d; Timer 1241 then reaches GUI Launcher 123c (Game
  // Finished) through Relay 13b3.
  for (const m of [0xb39, 0xb26, 0xb3a]) assert.ok(by.get(m)!.links.includes(0x108d));
  assert.ok(by.get(0x1241)!.links.includes(0x13b3));
  assert.deepEqual(by.get(0x13b3)!.links, [0x123c]);
});
