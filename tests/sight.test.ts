// Sight lines for the actors' draw-occlusion test (src/game/actors/sight.ts): thin occluders
// in front of a body's axis (cell bars) must not hide the whole body, solid walls must, and
// see-through surfaces (cut-out grates, glass) never occlude.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollisionWorld } from '../src/app/physics';
import type { MeshPart } from '../src/formats/types';
import { Blend, type SurfaceMaterial } from '../src/formats/model';
import { bodyVisible, materialSeeThrough, occlusionSide, pointsVisible, seeThroughParts, sightBlocked, spreadPoints, surfaceSeeThrough } from '../src/game/actors/sight';

/** Axis-aligned box as a mesh part (12 triangles). */
function box(min: [number, number, number], max: [number, number, number], textureKey?: string): MeshPart {
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), textureKey };
}

const eye = { x: 0, y: 1.6, z: 0 };
// A standing body 4 m ahead (feet at 0, 2 m tall, 0.42 m radius), like an inmate behind his cell door.
const body = { x: 0, z: -4, bottom: 0, height: 2, radius: 0.42 };
const visible = (w: CollisionWorld, seeThrough?: (h: { part: number }) => boolean) =>
  bodyVisible(w, eye, body.x, body.z, body.bottom, body.height, body.radius, seeThrough as never);

test('a thin vertical bar in front of the body axis does not hide the body', () => {
  // 6 cm bar, floor to ceiling, 1.5 m in front of the eye, right on the line to the body's axis.
  const w = new CollisionWorld({ parts: [box([-0.03, 0, -1.53], [0.03, 3, -1.47])] });
  // Every sample on the axis is behind the bar (the old test: head / chest / knees on the axis).
  for (const f of [0.9, 0.55, 0.2]) assert.equal(sightBlocked(w, eye.x, eye.y, eye.z, body.x, body.height * f, body.z, body.radius), true);
  assert.equal(visible(w), true);
});

test('a row of bars with gaps narrower than the body still shows it; a solid wall hides it', () => {
  const bars: MeshPart[] = [];
  for (let x = -2; x <= 2.001; x += 0.2) bars.push(box([x - 0.03, 0, -1.53], [x + 0.03, 3, -1.47]));
  assert.equal(visible(new CollisionWorld({ parts: bars })), true);
  assert.equal(visible(new CollisionWorld({ parts: [box([-5, 0, -1.6], [5, 4, -1.4])] })), false);
});

test('see-through surfaces do not occlude, opaque ones do', () => {
  const w = new CollisionWorld({ parts: [box([-5, 0, -1.6], [5, 4, -1.4], 'grate')] });
  assert.equal(visible(w), false);
  assert.equal(visible(w, (h) => h.part === 0), true);
  // A see-through grate in front of a solid wall: still hidden.
  const both = new CollisionWorld({ parts: [box([-5, 0, -1.6], [5, 4, -1.4], 'grate'), box([-5, 0, -3.1], [5, 4, -2.9])] });
  assert.equal(visible(both, (h) => h.part === 0), false);
  // Hits within the body's radius of a sample are its own space.
  assert.equal(sightBlocked(new CollisionWorld({ parts: [box([-1, 0, -3.8], [1, 3, -3.7])] }), 0, 1, 0, 0, 1, -4, 0.42), false);
});

test('a raised arm reaching past the capsule shows the body through a gap the capsule misses', () => {
  // A wall with one window up and to the right: only the hand held out beside the head is seen.
  const wall = [box([-5, 0, -1.6], [0.5, 4, -1.4]), box([0.5, 0, -1.6], [5, 1.8, -1.4]), box([0.5, 2.3, -1.6], [5, 4, -1.4]), box([1.2, 1.8, -1.6], [5, 2.3, -1.4])];
  const w = new CollisionWorld({ parts: wall });
  assert.equal(visible(w), false);
  const hand = [1.6, 2.6, -4];
  assert.equal(pointsVisible(w, eye, hand), true);
  // The hand at the side, behind the wall: hidden.
  assert.equal(pointsVisible(w, eye, [0.5, 1, -4]), false);
});

test('spreadPoints picks the extremities of a skeleton', () => {
  // hips, chest, head, two hands, two feet, a finger next to the right hand (not skinned).
  const pos = [0, 1, 0, 0, 1.4, 0, 0, 1.8, 0, -0.6, 1.0, 0, 0.6, 1.0, 0, -0.15, 0, 0, 0.15, 0, 0, 0.65, 0.95, 0];
  const skinned = (i: number) => i !== 7;
  // Feet first (farthest from the hips), then the head, the hands; the chest before the second
  // foot (closer to the first one than the chest is to anything picked).
  assert.deepEqual(spreadPoints(pos, skinned, 0, 5), [5, 2, 3, 4, 1]);
  assert.deepEqual(spreadPoints(pos, skinned, 0, 6), [5, 2, 3, 4, 1, 6]);
  // Fewer points than asked for: each once, never the start itself (the capsule covers it).
  assert.deepEqual(spreadPoints([0, 0, 0, 1, 0, 0, 1, 0, 0], () => true, 0, 4), [1]);
});

test('occlusion side offsets are perpendicular to the view and scale with the radius', () => {
  const [sx, sz] = occlusionSide(0, 0, 0, -4, 0.4);
  assert.ok(Math.abs(Math.hypot(sx, sz) - 0.3) < 1e-9);
  assert.ok(Math.abs(sx * 0 + sz * -4) < 1e-9);
  assert.deepEqual(occlusionSide(1, 1, 1, 1, 0.4), [0, 0]);
});

test('see-through classification follows the base layer blend, else the texture alpha', () => {
  const mat = (...blends: number[]): SurfaceMaterial => ({ key: 'm', cls: 0, layers: blends.map((blend, i) => ({ texture: `t${i}`, blend })) });
  const alpha = (k: string) => k === 'alpha';
  assert.equal(surfaceSeeThrough(mat(Blend.Opaque), 'alpha', alpha), false);
  assert.equal(surfaceSeeThrough(mat(Blend.Cutout), undefined, alpha), true);
  assert.equal(surfaceSeeThrough(mat(Blend.Alpha), undefined, alpha), true);
  // Reflection base + diffuse over it + detail: an opaque surface (1a's cell door bars).
  assert.equal(surfaceSeeThrough(mat(Blend.Opaque, Blend.AddOverAlpha, Blend.Modulate2x), undefined, alpha), false);
  // No decoded material: texture alpha is cut-out coverage.
  assert.equal(surfaceSeeThrough(undefined, 'alpha', alpha), true);
  assert.equal(surfaceSeeThrough(undefined, 'solid', alpha), false);
  assert.deepEqual([...seeThroughParts([{ textureKey: 'alpha' }, { textureKey: 'solid' }, { material: mat(Blend.Cutout) }], alpha)], [1, 0, 1]);
  assert.equal(materialSeeThrough({ alphaTest: 0.5, transparent: false } as never), true);
  assert.equal(materialSeeThrough({ alphaTest: 0, transparent: true } as never), true);
  assert.equal(materialSeeThrough({ alphaTest: 0, transparent: false } as never), false);
  assert.equal(materialSeeThrough(undefined), false);
});
