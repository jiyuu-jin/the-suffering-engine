// The use prompt's ray (src/game/world/use-ray.ts, docs/game-logic.md §14.5 "The port's
// prompt"): the crosshair's ray from the camera, usable where it passes within reach of the eye,
// up to just past the first wall. The third-person camera sits 3.2 m behind an
// over-the-shoulder pivot (0.45 m right of the head); the old ray (from the head along the view)
// ran parallel to the crosshair and missed a light switch the crosshair was on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rayBoxEntry, rayPoint, thirdPersonRay, useRay, USE_RAY_SLACK, type V3 } from '../src/game/world/use-ray';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const norm = (v: V3): V3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

// A light switch plate on a wall at z = -1 (the player looks along -z): 10 x 17 cm, 4 cm deep.
const SWITCH = { min: { x: -0.05, y: 1.4, z: -1.0 }, max: { x: 0.05, y: 1.57, z: -0.96 } };
const WALL = -1.0;
const eye = { x: 0, y: 1.6, z: 0 };
// The port's third-person camera for that view: 0.45 m to the right, 0.1 m down, 3.2 m back.
const pivot = { x: 0.45, y: 1.5, z: 0 };
const target = { x: 0, y: 1.485, z: -0.98 };

function thirdPerson() {
  // Camera behind the pivot on the line through the target (what aiming the crosshair at it means).
  const d = norm({ x: target.x - pivot.x, y: target.y - pivot.y, z: target.z - pivot.z });
  const cam = { x: pivot.x - d.x * 3.2, y: pivot.y - d.y * 3.2, z: pivot.z - d.z * 3.2 };
  return { cam, d };
}

const wallAlong = (o: V3, d: V3) => (WALL - o.z) / d.z;

test('first person: the window is the old test (0 .. min(reach, wall + slack))', () => {
  const d = norm({ x: 0, y: -0.1, z: -1 });
  const r = useRay(eye, d, eye, 3, 1.0)!;
  assert.ok(r);
  assert.equal(r.near, 0);
  assert.ok(near(r.far, 1.0 + USE_RAY_SLACK));
  assert.ok(near(r.eyeDir.x, d.x) && near(r.eyeDir.y, d.y) && near(r.eyeDir.z, d.z));
  assert.ok(!thirdPersonRay(r));
  const open = useRay(eye, d, eye, 3, undefined)!;
  assert.ok(near(open.far, 3));
});

test('third person: the crosshair on a light switch finds it', () => {
  const { cam, d } = thirdPerson();
  const r = useRay(cam, d, eye, 3, wallAlong(cam, d))!;
  assert.ok(r && thirdPersonRay(r));
  const t = rayBoxEntry(r.origin, r.dir, SWITCH.min, SWITCH.max, r.near, r.far);
  assert.notEqual(t, null);
  const p = rayPoint(r, t!);
  // Within reach of the eye, on the plate's face.
  assert.ok(Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) <= 3);
  assert.ok(near(p.z, SWITCH.max.z, 1e-3));
});

test('third person: the old ray (head along the view) missed the switch the crosshair was on', () => {
  const { d } = thirdPerson();
  const t = rayBoxEntry(eye, d, SWITCH.min, SWITCH.max, 0, 3);
  assert.equal(t, null);
});

test('third person: aiming clearly off the switch finds nothing', () => {
  const { cam } = thirdPerson();
  for (const off of [
    { x: 0.25, y: 0 },
    { x: -0.25, y: 0 },
    { x: 0, y: 0.25 },
    { x: 0, y: -0.25 },
  ]) {
    const d = norm({ x: target.x + off.x - cam.x, y: target.y + off.y - cam.y, z: target.z - cam.z });
    const r = useRay(cam, d, eye, 3, wallAlong(cam, d))!;
    assert.equal(rayBoxEntry(r.origin, r.dir, SWITCH.min, SWITCH.max, r.near, r.far), null, JSON.stringify(off));
  }
});

test('third person: reach is measured from the eye, not the camera', () => {
  // A box 3.5 m in front of the eye: on the crosshair, in front of no wall, out of reach.
  const { cam } = thirdPerson();
  const box = { min: { x: -0.5, y: 1.0, z: -3.6 }, max: { x: 0.5, y: 2.0, z: -3.5 } };
  const d = norm({ x: 0 - cam.x, y: 1.5 - cam.y, z: -3.5 - cam.z });
  const r = useRay(cam, d, eye, 3, undefined)!;
  assert.equal(rayBoxEntry(r.origin, r.dir, box.min, box.max, r.near, r.far), null);
  // The same box at 2.5 m is taken.
  const box2 = { min: { x: -0.5, y: 1.0, z: -2.6 }, max: { x: 0.5, y: 2.0, z: -2.5 } };
  const d2 = norm({ x: 0 - cam.x, y: 1.5 - cam.y, z: -2.5 - cam.z });
  const r2 = useRay(cam, d2, eye, 3, undefined)!;
  assert.notEqual(rayBoxEntry(r2.origin, r2.dir, box2.min, box2.max, r2.near, r2.far), null);
});

test('a wall in front of the object stops the ray (slack past the first surface only)', () => {
  const d = { x: 0, y: 0, z: -1 };
  const o = { x: 0, y: 1.5, z: 0 };
  const box = { min: { x: -0.2, y: 1.3, z: -1.6 }, max: { x: 0.2, y: 1.7, z: -1.4 } };
  // A surface at 1.0: the box starts 0.4 m behind it.
  const r = useRay(o, d, o, 3, 1.0)!;
  assert.equal(rayBoxEntry(r.origin, r.dir, box.min, box.max, r.near, r.far), null);
  // Its own face at 1.4 (the ray meets the object first): taken.
  const r2 = useRay(o, d, o, 3, 1.4)!;
  assert.ok(near(rayBoxEntry(r2.origin, r2.dir, box.min, box.max, r2.near, r2.far)!, 1.4));
});

test('the crosshair stopped by a wall before it comes within reach: nothing', () => {
  // Camera 4 m behind the eye, a wall 0.5 m in front of the camera.
  const cam = { x: 0, y: 1.6, z: 4 };
  const d = { x: 0, y: 0, z: -1 };
  assert.equal(useRay(cam, d, eye, 3, 0.5), null);
  // No wall: the window is the stretch within 3 m of the eye (z 3 .. -3: t 1 .. 7).
  const r = useRay(cam, d, eye, 3, undefined)!;
  assert.ok(near(r.near, 1) && near(r.far, 7));
});

test('eyeDir looks from the eye at the point under the crosshair', () => {
  const cam = { x: 0.45, y: 1.5, z: 3.2 };
  const d = norm({ x: -0.45, y: -0.5, z: -4.2 });
  const r = useRay(cam, d, eye, 3, undefined)!;
  const a = r.aim;
  const e = norm({ x: a.x - eye.x, y: a.y - eye.y, z: a.z - eye.z });
  assert.ok(near(r.eyeDir.x, e.x) && near(r.eyeDir.y, e.y) && near(r.eyeDir.z, e.z));
  // The aim point is the far end of the reach (no wall): 3 m from the eye.
  assert.ok(near(Math.hypot(a.x - eye.x, a.y - eye.y, a.z - eye.z), 3, 1e-6));
});

test('rayBoxEntry: from inside the box the entry is the window start; parallel misses', () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  assert.equal(rayBoxEntry({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, box.min, box.max, 0.3, 5), 0.3);
  assert.equal(rayBoxEntry({ x: 2, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, box.min, box.max, 0, 10), null);
  assert.equal(rayBoxEntry({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, box.min, box.max, 0, 3.9), null);
  assert.equal(rayBoxEntry({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, box.min, box.max, 0, 4), 4);
});
