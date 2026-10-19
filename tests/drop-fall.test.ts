// A dead character's hand weapon falling out of its hand (src/game/world/drop-fall.ts,
// docs/game-logic.md §4.4 "Held and dropped").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { DROP_BOUNCE, handDropPose, stepDropFall, uprightQuaternion, type DropFall } from '../src/game/world/drop-fall';
import { instanceMatrix } from '../src/game/world/dynamic';

test('the dropped item is turned upright with the smallest rotation, its heading kept', () => {
  // A gun held pointing forward-down, rolled: after the drop its Y axis is world up.
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, 1.1, -0.4, 'YXZ'));
  const up = uprightQuaternion(q);
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(up);
  assert.ok(y.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
  // Already upright: unchanged.
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8);
  assert.ok(uprightQuaternion(flat).angleTo(flat) < 1e-9);
});

test('handDropPose gives the instance yaw whose matrix carries the model +Z where the upright pose does', () => {
  const m = new THREE.Object3D();
  m.position.set(3, 1.2, -4);
  m.quaternion.setFromEuler(new THREE.Euler(0.3, -2.2, 0.5, 'YXZ'));
  const pose = handDropPose(m);
  assert.deepEqual(pose.at.map((x) => +x.toFixed(6)), [3, 1.2, -4]);
  const want = new THREE.Vector3(0, 0, 1).applyQuaternion(uprightQuaternion(m.quaternion));
  const M = instanceMatrix([0, 0, 0], [0, pose.yawDeg, 0]);
  const got = new THREE.Vector3(0, 0, 1).transformDirection(M);
  assert.ok(got.distanceTo(want) < 1e-6, `${got.toArray()} vs ${want.toArray()}`);
});

test('a drop falls from the hand, bounces with DROP_BOUNCE and comes to rest on the floor', () => {
  // Floor plane y = 0.
  const cast = (a: THREE.Vector3, b: THREE.Vector3) => {
    if (a.y >= 0 && b.y < 0) {
      const t = a.y / (a.y - b.y);
      return { point: a.clone().lerp(b, t), normal: new THREE.Vector3(0, 1, 0) };
    }
    return null;
  };
  const d: DropFall = { pos: new THREE.Vector3(0, 1.1, 0), vel: new THREE.Vector3(), t: 0, resting: false };
  let firstBounce: number | undefined;
  for (let i = 0; i < 600 && stepDropFall(d, 1 / 60, 10.41, cast); i++) {
    if (firstBounce === undefined && d.vel.y > 0) firstBounce = d.vel.y;
  }
  assert.ok(d.resting, 'rests');
  assert.ok(Math.abs(d.pos.y) < 1e-3, `on the floor (${d.pos.y})`);
  // From 1.1 m the impact speed is sqrt(2 g h) = 4.79 m/s; it bounces at DROP_BOUNCE of that.
  const impact = Math.sqrt(2 * 10.41 * 1.1);
  assert.ok(firstBounce !== undefined && Math.abs(firstBounce - DROP_BOUNCE * impact) < 0.25, `bounce ${firstBounce}`);
  assert.ok(d.t < 2, `settles quickly (${d.t.toFixed(2)} s)`);
});
