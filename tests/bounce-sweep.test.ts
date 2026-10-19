// The BouncingObject sweep (CollisionWorld.frontSegmentCast, docs/game-logic.md §14.2): front
// faces only, triangles grown by the object's bounds radius.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { CollisionWorld } from '../src/app/physics';
import type { MeshPart } from '../src/formats/types';
import { loadPackages } from '../src/app/loader';
import { parseLevel, readLevelHeader } from '../src/formats/level';
import { modelBoundsRadius } from '../src/game/world/fx';
import type { PackageSet } from '../src/formats/model';
import { nodeFS, readSrsc, skip } from './helpers';

// A 2 x 2 floor at y = 0, counter-clockwise seen from above (front face up).
const floor = { positions: new Float32Array([-1, 0, -1, -1, 0, 1, 1, 0, 1, 1, 0, -1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) } as unknown as MeshPart;

test('front faces only: a fall onto the floor hits it, a rise through it from below does not', () => {
  const w = new CollisionWorld({ parts: [floor] });
  const down = w.frontSegmentCast(0.2, 0.5, 0.1, 0.2, -0.5, 0.1);
  assert.ok(down);
  assert.deepEqual(down!.normal.map((x) => Math.round(x)), [0, 1, 0]);
  assert.ok(Math.abs(down!.point[1]) < 1e-6);
  assert.equal(w.frontSegmentCast(0.2, -0.5, 0.1, 0.2, 0.5, 0.1), null, 'the back face lets it through');
  // The two-sided ray (sight, shots) still stops.
  assert.ok(w.raycast(0.2, -0.5, 0.1, 0, 1, 0, 1));
});

test('triangles grow in their plane by the sweep radius: a fall just past the edge is caught', () => {
  const w = new CollisionWorld({ parts: [floor] });
  assert.equal(w.frontSegmentCast(1.1, 0.5, 0, 1.1, -0.5, 0), null);
  const h = w.frontSegmentCast(1.1, 0.5, 0, 1.1, -0.5, 0, 0.15);
  assert.ok(h && Math.abs(h.point[1]) < 1e-6, 'caught by the grown triangle');
  assert.equal(w.frontSegmentCast(1.3, 0.5, 0, 1.3, -0.5, 0, 0.15), null);
});

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

test('1a "Hat Gen": the cap is caught by the grate fixture it starts in, then lands below it', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {})) as unknown as PackageSet;
  const R = modelBoundsRadius(pkgs, { pkg: 3, id: 477 })!;
  assert.ok(Math.abs(R - 0.197) < 0.001, `cap bounds radius ${R}`);
  const w = new CollisionWorld(parseLevel(lvl, '1a', { packages: pkgs }));
  // Launch (bouncingLaunch): 9.77 m/s along +x from the generator, 0.75 x 10.41 m/s² gravity.
  const p = [409.91, 101.68, 508.02], v = [9.77, 0, 0];
  const dt = 1 / 30;
  let first: number[] | undefined;
  let floorAt: number[] | undefined;
  for (let i = 0; i < 90 && !floorAt; i++) {
    v[1] -= 0.75 * 10.41 * dt;
    const e = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
    const h = w.frontSegmentCast(p[0], p[1], p[2], e[0], e[1], e[2], R);
    if (!h) {
      p.splice(0, 3, ...e);
      continue;
    }
    first ??= [...h.point, ...h.normal];
    if (h.normal[1] > 0.6) floorAt = h.point;
    const vn = v[0] * h.normal[0] + v[1] * h.normal[1] + v[2] * h.normal[2];
    for (let k = 0; k < 3; k++) v[k] = (v[k] - 2 * vn * h.normal[k]) * 0.5;
    p.splice(0, 3, h.point[0] + h.normal[0] * 0.002, h.point[1] + h.normal[1] * 0.002, h.point[2] + h.normal[2] * 0.002);
  }
  assert.ok(first && first[0] < 410.6 && first[3] < -0.8, `first contact inside the fixture, facing back (${first})`);
  assert.ok(floorAt && floorAt[0] < 410 && Math.abs(floorAt[1] - 97.66) < 0.05, `lands on the floor below (${floorAt})`);
});
