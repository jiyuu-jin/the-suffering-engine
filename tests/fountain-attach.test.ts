// Particle Fountains that ride a hardpoint (1a "Gaurd" #280: MouthBloodGen on the guard's jaw)
// and the fountain rules decoded for it: start state p14, p0 = 1 emission from the model box,
// Destroy with p17 (docs/game-logic.md §14.2; world/fx.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { nodeFS, readSrsc, skip } from './helpers';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import type { PackageSet } from '../src/formats/model';
import { Emitter, FOUNTAIN_GRAVITY, fountainBlend, fountainDestroyKeepsParticles, fountainEmitPoint, fountainParticleAlpha, fountainParticleLife, fountainStartsOn, modelBox } from '../src/game/world/fx';
import { parseStompSequence } from '../src/game/world/stomp';
import { hardpointTable } from '../src/game/weapons/hardpoints';
import { readSkeleton } from '../src/formats/skeleton';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('fountain start state is p14 (init calls On only then); Destroy keeps the particles with p17', () => {
  const v: PropValue[] = [];
  assert.equal(fountainStartsOn(v), false);
  v[16] = 0;
  v[17] = 1;
  assert.equal(fountainStartsOn(v), false, 'p16 / p17 do not start it');
  v[14] = 1;
  assert.equal(fountainStartsOn(v), true);
  assert.equal(fountainDestroyKeepsParticles(v), true);
  v[17] = 0;
  assert.equal(fountainDestroyKeepsParticles(v), false);
});

test('particle lifetime p40 (p48: random), fade-in p42, fade-out over the last p41 s', () => {
  const v: PropValue[] = [];
  v[40] = 1;
  v[41] = 0.25;
  v[42] = 0.1;
  assert.deepEqual(fountainParticleLife(v, 0.5), { life: 1, fadeIn: 0.1, fadeOut: 0.25 });
  v[48] = 1;
  close(fountainParticleLife(v, 0.5).life, 0.5);
  // A lifetime shorter than the fade-out fades from the start (engine: death = now + p41).
  v[40] = 1e-34;
  v[48] = 0;
  v[41] = 1;
  close(fountainParticleLife(v, 0.5).life, 1);
  close(fountainParticleAlpha(0.05, 1, 0.1, 0.25), 0.5);
  close(fountainParticleAlpha(0.5, 1, 0.1, 0.25), 1);
  close(fountainParticleAlpha(0.9, 1, 0.1, 0.25), 0.4);
  close(fountainParticleAlpha(1.2, 1, 0.1, 0.25), 0);
});

test('particles: size p37..p38 engine units shrinking / growing by p39 per second, gravity p43 x g, upright', () => {
  const v: PropValue[] = [];
  v[26] = 100;
  v[37] = 50;
  v[38] = 100;
  v[39] = -25;
  v[40] = 1;
  v[43] = 0.5;
  const em = new Emitter(v, new THREE.Matrix4(), [], null, 3);
  em.update(0.1, 1);
  assert.ok(em.particles.length >= 9);
  for (const p of em.particles) {
    assert.ok(p.size0 >= 50 / 2048 - 1e-9 && p.size0 <= 100 / 2048 + 1e-9, `size ${p.size0}`);
    close(p.grow, -25 / 2048);
    assert.equal(p.rot, 0, 'no spin, no random turn: drip textures hang down');
  }
  const p = em.particles[0];
  const vy = p.v.y;
  em.update(0.2, 0);
  close(p.v.y - vy, -FOUNTAIN_GRAVITY * 0.5 * 0.2, 1e-6);
});

test('blend: p46 = 1 or p47 additive, p46 = 2 subtractive, 0 and 3 alpha', () => {
  const b = (p46: number, p47 = 0) => {
    const v: PropValue[] = [];
    v[46] = p46;
    v[47] = p47;
    return fountainBlend(v);
  };
  assert.deepEqual([b(0), b(1), b(2), b(3), b(0, 1), b(3, 1)], [1, 0, 2, 1, 0, 0]);
});

test('p0 = 1 emission point: random point of the model box carried by the placement', () => {
  const box = new THREE.Box3(new THREE.Vector3(0.05, -0.06, -0.03), new THREE.Vector3(0.1, 0, 0.03));
  const M = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 2, -4);
  const p0 = fountainEmitPoint(box, M, 0, 0, 0);
  const want = new THREE.Vector3(0.05, -0.06, -0.03).applyMatrix4(M);
  close(p0.distanceTo(want), 0);
  const mid = fountainEmitPoint(box, M, 0.5, 0.5, 0.5);
  close(mid.distanceTo(box.getCenter(new THREE.Vector3()).applyMatrix4(M)), 0);
});

test('an emitter following a moving matrix emits from its model box where the matrix is now', () => {
  const v: PropValue[] = [];
  v[0] = 1;
  v[26] = 100;
  v[37] = 1000;
  v[38] = 1000;
  const follow = new THREE.Matrix4();
  const em = new Emitter(v, follow, [], null, 1);
  em.box = new THREE.Box3(new THREE.Vector3(0.05, -0.06, -0.03), new THREE.Vector3(0.1, 0, 0.03));
  em.followM = follow;
  // The bone moves 3 m up and turns; particles appear in the box at the new pose.
  follow.makeRotationZ(0.7).setPosition(1, 3, 2);
  em.update(0.1, 1);
  assert.ok(em.particles.length >= 9, `${em.particles.length} particles`);
  const inv = follow.clone().invert();
  for (const p of em.particles) {
    const local = p.p.clone().sub(p.v.clone().multiplyScalar(p.age)).applyMatrix4(inv);
    assert.ok(em.box.clone().expandByScalar(0.02).containsPoint(local), `particle at ${local.toArray()} outside the box`);
  }
  // Without p0 the origin of the placement is used.
  const em2 = new Emitter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 100], follow, [], null, 2);
  em2.box = em.box;
  em2.update(0.05, 1);
  for (const p of em2.particles) close(p.p.clone().sub(p.v.clone().multiplyScalar(p.age)).distanceTo(new THREE.Vector3(1, 3, 2)), 0, 1e-3);
});

async function level(name: string) {
  const path = `LEVELS/1 PrisonDeathRow/${name} PrisonDeathRow.lvl`;
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { packages, ents: parseEntities(lvl, packages, { resolveStrings: false }) };
  } finally {
    console.warn = warn;
  }
}

test('retail: 1a "Gaurd" #280 hangs MouthBloodGen on the guard jaw, turns it on while the blade is in his head', { skip }, async () => {
  const { packages, ents } = await level('1a');
  const seq = parseStompSequence((packages as unknown as PackageSet).get(12)!.qdu!, 280)!;
  const guard = seq.tracks.find((t) => t.uid === 0x5a57)!;
  const blood = seq.tracks.find((t) => t.uid === 0x7c2d)!;
  const key = guard.attaches.find((a) => a.track === blood.index)!;
  assert.equal(key.hardpoint, 22);
  close(key.time, 1.06, 0.01);
  assert.deepEqual(blood.messages.map((m) => [m.message, +m.time.toFixed(2)]), [[1, 6.9], [2, 9.74], [11, 9.75]]);
  // Hardpoint 22 of the guard rig is bone 50, the jaw (0x30cb6f7d) under the head (0x07c159a2).
  const e = ents.find((x) => x.uid === 0x5a57)!;
  const bone = hardpointTable(packages as unknown as PackageSet, e.modelRef!)[22];
  const sk = readSkeleton((packages as unknown as PackageSet).get(e.modelRef!.pkg)!.mdu!, e.modelRef!.id)!;
  assert.equal(bone, 50);
  assert.equal(sk.bones[bone].hash, 0x30cb6f7d);
  assert.equal(sk.bones[sk.bones[bone].parent].hash, 0x07c159a2);
  // The fountain: off until On (p14 = 0), emits from its 5 cm model box (p0 = 1), lets its
  // particles finish on BlowUp (p17 = 1).
  const f = ents.find((x) => x.uid === 0x7c2d)!;
  assert.equal(f.className, 'Particle Fountain');
  assert.equal(fountainStartsOn(f.values), false);
  assert.equal(f.values[0], 1);
  assert.equal(fountainDestroyKeepsParticles(f.values), true);
  const box = modelBox(packages, f.modelRef!)!;
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.x < 0.07 && size.y < 0.07 && size.z < 0.07, `box ${size.toArray()}`);
  // Its drops: 2.4-4.9 cm, a second each (+0.25 s fade-out), falling at half gravity.
  assert.deepEqual([f.values[37], f.values[38], f.values[39], f.values[40], f.values[43]], [50, 100, -25, 1, 0.5]);
});

test('retail: every 1a fountain that does not start on (p14 = 0) waits for an On from a link or a sequence', { skip }, async () => {
  const { packages, ents } = await level('1a');
  const driven = new Set<number>();
  for (const e of ents) for (const l of e.links) driven.add(l);
  for (const e of ents) {
    if (e.className !== 'STOMP Player') continue;
    const r = e.values[0] as { pkg: number; id: number } | null;
    const q = r && (packages as unknown as PackageSet).get(r.pkg)?.qdu;
    for (const t of (q && parseStompSequence(q, r!.id)?.tracks) || []) if (t.messages.length) driven.add(t.uid);
  }
  const waiting = ents.filter((e) => e.className === 'Particle Fountain' && !fountainStartsOn(e.values));
  assert.ok(waiting.length > 40);
  // Two strays: 689e (a copy beside its driven twins 6885..6894) and 7d4d (instance flags 0).
  assert.deepEqual(waiting.filter((e) => !driven.has(e.uid)).map((e) => e.uid.toString(16)).filter((u) => u !== '689e' && u !== '7d4d'), []);
});
