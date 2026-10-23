// The Mainliner's thrown needle as a real projectile: docs/game-logic.md §15.7.4 "Thrown needles",
// src/game/actors/missile.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CollisionWorld } from '../src/app/physics';
import type { MeshPart } from '../src/formats/types';
import { readDbId } from '../src/formats/model';
import { missileStep, segmentSphere, type MissileBody, type MissileFlight } from '../src/game/actors/missile';
import { ballisticLaunch } from '../src/game/actors/throw';
import { readClipEvents } from '../src/game/actors/clipmap';
import { FOUNTAIN_GRAVITY, readTemplate } from '../src/game/world/fx';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// The needle (10:1814): 45000 units/s, 20 % gravity, reach 20 m, fallback 45 deg, 5 s.
const SPEED = 45000 / 2048;
const AIM = { speed: SPEED, gravity: 0.2 * FOUNTAIN_GRAVITY, reach: 20, fallbackDeg: 45 };
/** The player's hit spheres standing at (x, z): four r 0.4 spheres up the body. */
const playerAt = (x: number, z: number): MissileBody<string>[] => [{ body: 'player', spheres: [0.25, 0.75, 1.25, 1.75].map((y) => ({ c: [x, y, z], r: 0.4 })) }];

/** Fly a needle until it touches something (or 5 s). */
function fly(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, bodies: (t: number) => MissileBody<string>[], world: CollisionWorld | null = null) {
  const v = ballisticLaunch(from, to, AIM);
  const m: MissileFlight = { p: { ...from }, v: { x: v.x, y: v.y, z: v.z }, gravity: AIM.gravity, age: 0, life: 5, radius: 0.05 };
  for (let i = 0; i < 400; i++) {
    const c = missileStep(m, 1 / 60, world, bodies(m.age));
    if (c) return c;
  }
  return null;
}

test('segment vs sphere: first entry along the segment, inside at t = 0, a miss is undefined', () => {
  close(segmentSphere({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, [5, 0, 0], 1)!, 0.4);
  assert.equal(segmentSphere({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, [5, 2, 0], 1), undefined);
  assert.equal(segmentSphere({ x: 5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, [5, 0, 0], 1), 0);
  assert.equal(segmentSphere({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, [5, 0, 0], 1), undefined);
});

test('a needle thrown at a standing player 10 m away hits him; one he walked away from misses', () => {
  const hand = { x: 0, y: 1.5, z: 0 };
  const chest = { x: 0, y: 1.2, z: -10 };
  const c = fly(hand, chest, () => playerAt(0, -10));
  assert.equal(c?.kind, 'body');
  // The aim point is taken when the throw clip starts, 0.278 s before the release, with no lead:
  // a player strafing at 4 m/s is 1.1 m aside at the release and 3 m aside when it arrives.
  const t0 = 0.278;
  const m = fly(hand, chest, (t) => playerAt(4 * (t0 + t), -10));
  assert.notEqual(m?.kind, 'body');
});

test('the world stops it first: a wall between the thrower and the player', () => {
  // A wall at z = -5 facing the thrower (+z normal), 4 m wide and tall.
  const wall = { positions: new Float32Array([-2, 0, -5, 2, 0, -5, 2, 4, -5, -2, 4, -5]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) } as unknown as MeshPart;
  const w = new CollisionWorld({ parts: [wall] });
  const c = fly({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 1.2, z: -10 }, () => playerAt(0, -10), w);
  assert.equal(c?.kind, 'world');
  if (c?.kind === 'world') close(c.point.z, -5, 1e-3);
});

test('it expires after its life', () => {
  const m: MissileFlight = { p: { x: 0, y: 100, z: 0 }, v: { x: 0, y: 0, z: 1 }, gravity: 0, age: 0, life: 0.1, radius: 0 };
  let c = null;
  for (let i = 0; i < 10 && !c; i++) c = missileStep(m, 0.02, null, []);
  assert.equal(c?.kind, 'expired');
});

const pk = new Map<number, unknown>();
const loadPk = () => {
  if (pk.size) return pk;
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), adu: ld(`${base}.adu`) });
  }
  return pk;
};

test('retail: the needle, its throw clip and the behaviour that keeps the aim point', { skip }, () => {
  const pkgs = loadPk() as Map<number, { adu?: unknown }>;
  const t = (pkg: number, id: number) => readTemplate(pkgs as never, { pkg, id })!;
  const ml = t(10, 176);
  assert.equal(ml.cls, 'Mainliner');
  const p55 = ml.values[55] as { pkg: number; id: number }[];
  assert.ok(p55.some((r) => r.pkg === 10 && r.id === 1814));
  const n = t(10, 1814);
  assert.equal(n.cls, 'Missile');
  assert.equal(n.values[0], 1, 'ballistic aim');
  assert.equal(n.values[1], 45000);
  assert.equal(n.values[46], 20);
  assert.equal(n.values[9], 20);
  assert.equal(n.values[10], 45);
  assert.equal(n.values[12], 5);
  assert.equal(n.values[26], 10, 'damage');
  // ProjectileAttackBehavior 10:209 p5 = 1 (keep the aim point); its one Attack 10:210 throws
  // clip 10:242, whose only shot marker is a ThrowWeapon (230) at 0.278 s.
  const pab = t(10, 209);
  assert.equal(pab.values[5], 1);
  const atk = t(10, 210);
  assert.deepEqual(atk.values[0], { pkg: 10, id: 242 });
  const ev = readClipEvents(pkgs.get(10)!.adu as never, 242);
  assert.equal(ev.fireTimes, undefined);
  assert.equal(ev.throwTimes?.length, 1);
  close(ev.throwTimes![0], 0.278, 1e-3);
});
