// How an Inferna moves (docs/game-logic.md §15.7.6 "How it moves"; specials/inferna.ts): the
// circling steering's wish (0x100796d0), its stuck test (0x1007b0f0) and the reposition MoveTo's
// distance rule (0x1007abc5), decoded from Suffering.rfl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CIRCLE_STUCK_SPREAD, CIRCLE_STUCK_WINDOW, CircleStuck, circleWish, repositionDone } from '../src/game/actors/specials/inferna';
import { infernaParams } from '../src/game/actors/specials/params';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('circling wish: tangent on the radius, out from inside it, in from outside, both directions', () => {
  // Target at the origin, the Inferna 4 m east (on the 4 m radius): pure tangent.
  const [x0, z0] = circleWish(4, 0, 0, 0, 4, 0);
  assert.ok(near(x0, 0) && near(Math.abs(z0), 1), `on the radius (${x0}, ${z0})`);
  const [x1, z1] = circleWish(4, 0, 0, 0, 4, 1);
  assert.ok(near(x1, 0) && near(z1, -z0), 'flag 1 goes round the other way');
  // n = (-1, 0) (towards the target); flag 0's tangent is (n.z, -n.x) = (0, 1).
  assert.ok(near(z0, 1));
  // Inside at 2 m: k = 1 - 2 / 4 = 0.5: tangent x 0.5 plus away from the target x 0.5 (45 degrees).
  const [x2, z2] = circleWish(2, 0, 0, 0, 4, 0);
  assert.ok(near(x2, Math.SQRT1_2) && near(z2, Math.SQRT1_2), `inside (${x2}, ${z2})`);
  // Outside at 8 m: k = 4 / 8 - 1 = -0.5: tangent x 0.5 plus towards the target x 0.5.
  const [x3, z3] = circleWish(8, 0, 0, 0, 4, 0);
  assert.ok(near(x3, -Math.SQRT1_2) && near(z3, Math.SQRT1_2), `outside (${x3}, ${z3})`);
  // Far out the pull towards the target dominates (k -> -1).
  const [x4] = circleWish(400, 0, 0, 0, 4, 0);
  assert.ok(x4 < -0.99);
  // No graph and no ground in it: the wish over a drop is the same as over ground (the Inferna
  // circling a target at a cliff's edge goes over it, as the original's steering does).
  assert.deepEqual(circleWish(0, 6, 0, 0, 4, 1), circleWish(0, 6, 0, 0, 4, 1));
});

test('circling stuck test: 0.15 s windows, reverse once, give up when stuck twice running', () => {
  assert.equal(CIRCLE_STUCK_WINDOW, 0.15);
  assert.equal(CIRCLE_STUCK_SPREAD, 0.015);
  const dt = 1 / 60;
  const run = (s: CircleStuck, secs: number, at: (t: number) => [number, number], speed: number) => {
    const out: string[] = [];
    for (let t = 0; t < secs; t += dt) {
      const [x, z] = at(t);
      const r = s.step(dt, x, z, speed);
      if (r) out.push(r);
    }
    return out;
  };
  // Moving freely at 5 m/s: never stuck.
  const free = new CircleStuck();
  free.reset(0, 0);
  assert.deepEqual(run(free, 3, (t) => [5 * t, 0], 5), []);
  // Against a wall (no motion): reversed after the first window, given up after the second.
  const wall = new CircleStuck();
  wall.reset(0, 0);
  assert.deepEqual(run(wall, 0.32, () => [0, 0], 5), ['reverse', 'end']);
  // Creeping at 4 % of the speed: the window's circle (radius about half its travel, 0.015 m) is
  // under 0.015 x 5 = 0.075 m: stuck.
  const creep = new CircleStuck();
  creep.reset(0, 0);
  assert.deepEqual(run(creep, 0.17, (t) => [0.2 * t, 0], 5).slice(0, 1), ['reverse']);
  // Stuck, then free again: the reversal is cleared, so the next stuck window reverses again.
  const s = new CircleStuck();
  s.reset(0, 0);
  const path = (t: number): [number, number] => (t < 0.16 ? [0, 0] : t < 0.5 ? [5 * (t - 0.16), 0] : [1.7, 0]);
  assert.deepEqual(run(s, 0.8, path, 5).slice(0, 2), ['reverse', 'reverse']);
});

test('reposition MoveTo: nearer than now is an arrival distance, farther a least distance', () => {
  assert.equal(repositionDone(3, 4, false), true);
  assert.equal(repositionDone(5, 4, false), false);
  assert.equal(repositionDone(12, 10, true), true);
  assert.equal(repositionDone(8, 10, true), false);
});

test('retail: the KillObject walks to 8 m; the circle has its own steering only (no avoidance, no constraint)', { skip }, () => {
  const pk = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), adu: ld(`${base}.adu`) } as EntityPackage);
  }
  const values = (id: number) => {
    const t = readObjectTemplate(pk, { pkg: 10, id })!;
    return decodeTemplateProps(classByHash(t.classHash), t);
  };
  const inf = values(823);
  assert.equal(infernaParams(pk, inf).approach, 8, 'InfernaKillObject 10:847 p3: the MoveTo arrival distance');
  // InfernaCircleTarget 10:845 (Character p179): p2 the circle steering's weight; p3 / p4 / p5 /
  // p6 / p7 the CharacterAvoidance / ObstacleAvoidance / SeparationSteer / WanderSteer /
  // SpotlightAvoidance weights (0x1007a120 pushes each only when > 0): all 0. ConstrainSteer is
  // pushed by Scurry alone (0x1010c1e4).
  const ct = values(845);
  assert.deepEqual([ct[2], ct[3], ct[4], ct[5], ct[6], ct[7]], [1, 0, 0, 0, 0, 0]);
});
