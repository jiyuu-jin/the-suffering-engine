// Third-person gait rules (src/game/actors/gait.ts): heading-set choice with the original's
// hysteresis, the body's facing offset, and phase-aligned walk / run cycles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { blendCycle, pickHeadingSet, setCentre, setFacingOffset, type HeadingSet } from '../src/game/actors/gait';
import type { Skeleton } from '../src/formats/skeleton';

// The retail human sets (every Player Weapon Properties template): forward, right, back, left.
const SETS: HeadingSet[] = [
  { bound: 45, walk: 0, walkSpeed: 1.626, run: 1, runSpeed: 6.637 },
  { bound: 135, walk: 2, walkSpeed: 1.626, run: 3, runSpeed: 5.11 },
  { bound: 225, walk: 4, walkSpeed: 4.109, run: 4, runSpeed: 4.109 },
  { bound: 315, walk: 5, walkSpeed: 1.626, run: 6, runSpeed: 5.11 },
];

test('heading sets: 90 deg sectors centred on forward / right / back / left', () => {
  assert.deepEqual([0, 30, -30, 44.9, 45, 90, 134, 180, 224, 225, 270, 314, 315, 359].map((a) => pickHeadingSet(SETS, a)), [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 0, 0]);
  assert.deepEqual(SETS.map((_, i) => setCentre(SETS, i)), [0, 90, 180, 270]);
});

test('heading sets: the set being played keeps 10 % of its width on each side', () => {
  // Forward held: up to 45 + 9 deg still forward; right held: down to 45 - 9.
  assert.equal(pickHeadingSet(SETS, 53, 0), 0);
  assert.equal(pickHeadingSet(SETS, 55, 0), 1);
  assert.equal(pickHeadingSet(SETS, 37, 1), 1);
  assert.equal(pickHeadingSet(SETS, 35, 1), 0);
  assert.equal(pickHeadingSet(SETS, -50, 0), 0);
  assert.equal(pickHeadingSet(SETS, 310, 3), 3);
  // Keyboard diagonal (exactly on a bound) keeps whichever set it came from.
  assert.equal(pickHeadingSet(SETS, 45, 0), 0);
  assert.equal(pickHeadingSet(SETS, 45, 1), 1);
});

test('facing offset turns the body into the movement (yaw grows to the left)', () => {
  const D = Math.PI / 180;
  assert.ok(Math.abs(setFacingOffset(SETS, 0, 45) + 45 * D) < 1e-9); // forward-right: body turns right
  assert.ok(Math.abs(setFacingOffset(SETS, 1, 45) - 45 * D) < 1e-9); // strafing right, stick forward-right: body turns left
  assert.ok(Math.abs(setFacingOffset(SETS, 0, 0)) < 1e-9);
  assert.ok(Math.abs(setFacingOffset(SETS, 2, 200) + 20 * D) < 1e-9);
});

test('blendCycle keeps the stride, aligns phases and loops seamlessly', () => {
  const skel = {
    bones: [{ index: 0, hash: 1, name: 'b_1', parent: -1, children: [], position: [0, 0, 0], quaternion: [0, 0, 0, 1] }],
  } as unknown as Skeleton;
  const rot = (name: string, dur: number) => {
    const t = [0, dur / 2, dur];
    const q = (a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    const v = [q(0), q(Math.PI / 2), q(0)].flatMap((x) => [x.x, x.y, x.z, x.w]);
    return new THREE.AnimationClip(name, dur, [new THREE.QuaternionKeyframeTrack('b_1.quaternion', t, v)]);
  };
  const walk = { clip: rot('w', 1.3), phase: 0.5, rate: 1, speed: 1.626 };
  const run = { clip: rot('r', 0.7), phase: 0, rate: 1, speed: 6.637 };
  const pure = blendCycle('w0', walk, run, 0, skel);
  assert.ok(Math.abs(pure.clip.duration - 1.3) < 1e-6);
  assert.ok(Math.abs(pure.speed - 1.626) < 1e-9);
  const mid = blendCycle('m', walk, run, 0.27, skel);
  const stride = 1.626 * 1.3 + (6.637 * 0.7 - 1.626 * 1.3) * 0.27;
  assert.ok(Math.abs(mid.clip.duration * mid.speed - stride) < 1e-6);
  const v = mid.clip.tracks[0].values;
  // Phase 0 of the walk side is its time 0.65 (the half-turn), of the run side its time 0.
  const q0 = new THREE.Quaternion(v[0], v[1], v[2], v[3]);
  const qEnd = new THREE.Quaternion(...(Array.from(v.slice(-4)) as [number, number, number, number]));
  assert.ok(q0.angleTo(qEnd) < 1e-5, 'first and last key equal');
  assert.ok(Math.abs(q0.angleTo(new THREE.Quaternion()) - 0.73 * (Math.PI / 2)) < 1e-3);
});
