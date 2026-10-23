// Generator-spawned BouncingObjects (break debris, gibs, casings) and particles' (absent) ground
// test: docs/game-logic.md §14.2 "Debris".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CollisionWorld } from '../src/app/physics';
import type { MeshPart } from '../src/formats/types';
import { readDbId } from '../src/formats/model';
import type { PropValue } from '../src/formats/entities';
import { bouncingLaunch, bouncingSpeed, bouncingSpin, Emitter, FOUNTAIN_GRAVITY, generatorSpawn, readTemplate } from '../src/game/world/fx';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const vals = (o: Record<number, PropValue>) => {
  const v: PropValue[] = [];
  for (const [k, x] of Object.entries(o)) v[Number(k)] = x;
  return v;
};
/** rand() returning the given values in turn. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

test('launch speed: p1, or p2 when a projectile record comes with the launch (every generator spawn)', () => {
  const t = vals({ 1: 3000, 2: 5000 });
  assert.equal(bouncingSpeed(t, false), 3000);
  assert.equal(bouncingSpeed(t, true), 5000);
  // The corpse gibs (3:3521): -500 / -2000: backwards along +Z.
  const g = vals({ 1: -500, 2: -2000, 12: 1.5, 46: 50, 47: 10 });
  const l = bouncingLaunch(g, new THREE.Matrix4(), 10, 0.5, true);
  close(l.vel.z, 2000 / 2048);
  close(l.vel.x, 0);
  close(l.gravity, 5);
  assert.equal(l.life, 1.5, 'p12 s, not p1..p2 ms');
});

test('spin: p3 / p4 / p5 deg/s about x / y / z, the rate capped at p6 deg/s', () => {
  const w = bouncingSpin(vals({ 3: 300, 4: 100, 5: 100, 6: 45 }));
  close(w.length(), (45 * Math.PI) / 180);
  close(w.x / w.y, 3);
  const cap = bouncingSpin(vals({ 3: 350, 4: 20, 5: 75, 6: 720 }));
  close(cap.x, (350 * Math.PI) / 180);
});

test('generator spawn, p16 = 0: -Z x p9 turned by p11 about world up, then the p14 lift and p13 spread', () => {
  const M = new THREE.Matrix4().setPosition(1, 2, 3);
  // p9 2 m/s, p11 90 deg: -Z (0, 0, -1) turned about +y by 90 deg -> (-1, 0, 0).
  let s = generatorSpawn(vals({ 9: 2, 11: 90 }), M, undefined, seq(0.5));
  close(s.vel.x, -2);
  close(s.vel.z, 0);
  close(s.vel.y, 0);
  // p14 0.2: y += (0.5 + r) x p14; p13 1: x, z += uniform(-1, 1).
  s = generatorSpawn(vals({ 9: 1, 13: 1, 14: 0.2 }), M, undefined, seq(1, 0, 1));
  close(s.vel.y, 0.3);
  close(s.vel.x, -1);
  close(s.vel.z, -1 + 1);
  // The matrix is the generator's own without p18 / p20.
  assert.ok(s.matrix.equals(M));
  // An inherited velocity is added (after the p18 facing).
  s = generatorSpawn(vals({ 9: 1 }), M, { x: 0, y: 5, z: 0 }, seq(0.5));
  close(s.vel.y, 5);
});

test('generator spawn, cone (p16 != 0): uniform(p15, p16) deg off -Z, spun about Z; p17 units back', () => {
  for (const r of [0, 0.3, 0.9]) {
    const s = generatorSpawn(vals({ 9: 1, 15: 10, 16: 30, 17: 2048 }), new THREE.Matrix4(), undefined, seq(r, 0.25));
    const off = (Math.acos(-s.vel.z / s.vel.length()) * 180) / Math.PI;
    close(off, 10 + 20 * r, 1e-3);
    // The spawn point moved one metre (2048 units) against the direction.
    const p = new THREE.Vector3().setFromMatrixPosition(s.matrix);
    close(p.dot(s.vel.clone().normalize()), -1, 1e-6);
  }
});

test('generator spawn: p20 turns the matrix about its axis p19 (radians as read); p18 faces -Z along V', () => {
  const M = new THREE.Matrix4().setPosition(4, 5, 6);
  const s = generatorSpawn(vals({ 19: 1, 20: 0.5 }), M, undefined, seq(1));
  // A turn of +0.5 rad about +y: -Z goes to (-sin 0.5, 0, -cos 0.5).
  const z = new THREE.Vector3().setFromMatrixColumn(s.matrix, 2);
  close(z.x, Math.sin(0.5));
  close(z.z, Math.cos(0.5));
  close(new THREE.Vector3().setFromMatrixPosition(s.matrix).x, 4);
  // p18: faces the velocity (here lifted straight up by p14 and pushed by p9 along -Z).
  const f = generatorSpawn(vals({ 9: 1, 14: 1, 18: 1, 20: 3 }), M, undefined, seq(0.5));
  const fz = new THREE.Vector3().setFromMatrixColumn(f.matrix, 2).negate();
  const vd = f.vel.clone().normalize();
  close(fz.dot(vd), 1, 1e-6);
  close(f.matrix.determinant(), 1, 1e-6);
  // A BouncingObject spawned there flies along it at its p2.
  const l = bouncingLaunch(vals({ 1: 1000, 2: 2048 }), f.matrix, 10, 0.5, true);
  close(l.vel.clone().normalize().dot(vd), 1, 1e-6);
  close(l.vel.length(), 1);
});

// A 4 x 4 floor at y = 0 seen from above.
const floor = { positions: new Float32Array([-2, 0, -2, -2, 0, 2, 2, 0, 2, 2, 0, -2]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) } as unknown as MeshPart;

test('particles have no ground test: they fall through the floor below the emitter until their life ends', () => {
  const v: PropValue[] = [];
  v[26] = 200;
  v[37] = 50;
  v[38] = 50;
  v[40] = 2;
  v[43] = 1;
  const M = new THREE.Matrix4().setPosition(0, 1.3, 0);
  const em = new Emitter(v, M, [], new CollisionWorld({ parts: [floor] }), 1);
  em.update(0.05, 1);
  const p = em.particles[0];
  for (let i = 0; i < 20; i++) em.update(0.05, 0);
  // 1 s of fall from 1.3 m: well under the floor, still moving (the port used to stop it at 0).
  assert.ok(p.p.y < -3, `particle at ${p.p.y}`);
  assert.ok(p.v.y < -FOUNTAIN_GRAVITY * 0.9);
});

// Retail templates.
const pk = new Map<number, unknown>();
const loadPk = () => {
  if (pk.size) return pk;
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`) });
  }
  return pk;
};

test('retail: break debris, corpse gibs and casings leave at their p2 along the spawn matrix', { skip }, () => {
  const pkgs = loadPk() as never;
  const t = (pkg: number, id: number) => readTemplate(pkgs, { pkg, id })!;
  // Crate-debris generator 3:4448 turns nothing; its pieces (3:4439: p1 3000, p2 5000, p12 2.8 s,
  // p46 80 +- 10, p49 3) fly -Z at 2.44 m/s.
  const g = t(3, 4448);
  for (const k of [9, 10, 11, 12, 13, 14, 16, 18, 20]) assert.equal(g.values[k], 0, `3:4448 p${k}`);
  const deb = t(3, 4439);
  assert.equal(deb.cls, 'BouncingObject');
  const l = bouncingLaunch(deb.values, generatorSpawn(g.values, new THREE.Matrix4()).matrix, FOUNTAIN_GRAVITY, 0.5, true);
  close(l.vel.z, -5000 / 2048);
  close(l.life, 2.8, 1e-6);
  close(l.gravity, 0.8 * FOUNTAIN_GRAVITY);
  // The guards' gib generator 3:2834 (p18 0, p20 0): the limb 3:3521 backwards at 0.98 m/s.
  const gib = t(3, 2834);
  assert.equal(gib.values[18], 0);
  assert.equal(gib.values[20], 0);
  close(bouncingLaunch(t(3, 3521).values, new THREE.Matrix4(), FOUNTAIN_GRAVITY, 0.5, true).vel.z, 2000 / 2048);
  // Revolver / shotgun casings (generators 4:71 / 4:88 turn nothing): 2.44 m/s, 50 +- 10 %.
  for (const [gid, cid] of [
    [71, 64],
    [88, 87],
  ]) {
    const cg = t(4, gid);
    for (const k of [9, 16, 18, 20]) assert.equal(cg.values[k], 0);
    close(bouncingSpeed(t(4, cid).values, true) / 2048, 2.441, 1e-3);
  }
});
