// Lines of sight through the collision world that look through see-through surfaces.
//
// The collision world holds every rendered triangle, including surfaces the eye passes
// through: cut-out bars and grates (cell fronts, cell doors), chain-link fences, glass and
// other blended layers, decals. A plain raycast stops at them, so a sight test built on it
// treats a cell door as a wall. sightBlocked() keeps casting past such hits.
//
//   const seeThrough = (hit: RayHit) => ...;           // e.g. WorldService.seeThrough
//   sightBlocked(world, eye, target, slack, seeThrough)  // true = a solid surface is in between
//   bodyVisible(world, eye, x, z, bottom, height, radius, seeThrough)  // any part of a body seen
//   pointsVisible(world, eye, xyz, seeThrough)            // any of these points seen
//   spreadPoints(xyz, usable, start, count)               // indices of well spread points
//
// bodyVisible is the actors' draw-occlusion test in gameplay (manager.ts; cinematics skip it).
// It samples head / chest / knees on the body's axis and to its left and right as seen from the
// eye: samples on one vertical line are all hidden by one thin vertical occluder that covers a
// sliver of the body (a cell bar, a pipe, a door post), which hid whole characters standing
// behind cell doors. The caller adds points of the animated pose (spreadPoints: head, hands,
// feet), which reach past the capsule (raised or outstretched arms, a crouch, a lean).
//
// What counts as see-through matches how the surface is drawn (src/app/surface-material.ts):
// a base layer with any blend mode but opaque (alpha, additive, ..., cutout), or, for a
// surface without a decoded material, a texture with alpha (drawn as cutout coverage).

import type * as THREE from 'three/webgpu';
import type { CollisionWorld, RayHit } from '../../app/physics';
import { Blend, type SurfaceMaterial } from '../../formats/model';
import type { MeshPart } from '../../formats/types';

/** Occlusion samples: fractions of the body height, and lateral offsets (units of occlusionSide). */
const BODY_HEIGHTS = [0.9, 0.55, 0.2];
const BODY_SIDES = [0, 1, -1];

/** Predicate for a collision hit: does the eye pass through that surface? */
export type SeeThrough = (hit: RayHit) => boolean;

/** See-through layers followed before giving up (each bar can be two faces). */
const MAX_LAYERS = 16;
/** Restart distance past a see-through hit. */
const STEP = 1e-3;

/** Is a surface drawn see-through (blended or cut-out)? */
export function surfaceSeeThrough(material: SurfaceMaterial | undefined, textureKey: string | undefined, hasAlpha: (key: string) => boolean): boolean {
  const base = material?.layers.find((l) => l.texture || l.frames);
  if (base) return base.blend !== Blend.Opaque && base.blend !== Blend.Opaque3;
  return !!textureKey && hasAlpha(textureKey);
}

/** Is a built Three material drawn see-through (alpha test or blending)? */
export function materialSeeThrough(m: THREE.Material | THREE.Material[] | undefined): boolean {
  if (!m) return false;
  const one = Array.isArray(m) ? m[0] : m;
  return !!one && (one.alphaTest > 0 || one.transparent);
}

/** Per level part: 1 = see-through (indexable by RayHit.part of static hits). */
export function seeThroughParts(parts: readonly Pick<MeshPart, 'material' | 'textureKey'>[], hasAlpha: (key: string) => boolean): Uint8Array {
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = surfaceSeeThrough(parts[i].material, parts[i].textureKey, hasAlpha) ? 1 : 0;
  return out;
}

/**
 * Is the segment from (ox, oy, oz) to (tx, ty, tz) blocked by a solid surface? Hits within
 * `slack` of the target do not count (the target's own body radius). See-through hits are
 * passed; after MAX_LAYERS of them the segment counts as clear (a wrongly hidden object is
 * worse than a wrongly drawn one).
 */
export function sightBlocked(
  world: Pick<CollisionWorld, 'raycast'>,
  ox: number, oy: number, oz: number,
  tx: number, ty: number, tz: number,
  slack: number,
  seeThrough?: SeeThrough | null,
): boolean {
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-6)) return false;
  dx /= len;
  dy /= len;
  dz /= len;
  let start = 0;
  for (let i = 0; i < MAX_LAYERS; i++) {
    const hit = world.raycast(ox + dx * start, oy + dy * start, oz + dz * start, dx, dy, dz, len - start);
    if (!hit || start + hit.distance >= len - slack) return false;
    if (!seeThrough?.(hit)) return true;
    start += hit.distance + STEP;
  }
  return false;
}

/**
 * Horizontal offset from a body's axis to its side as seen from the eye: perpendicular to the
 * eye -> body direction, 0.75 x the body radius long (zero when the eye is on the axis).
 */
export function occlusionSide(eyeX: number, eyeZ: number, x: number, z: number, radius: number): [number, number] {
  const dx = x - eyeX, dz = z - eyeZ;
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-6)) return [0, 0];
  const k = (0.75 * radius) / len;
  return [-dz * k, dx * k];
}

/**
 * Is any part of an upright body (axis at x / z, feet at `bottom`) visible from the eye? Up to
 * nine sight lines: head / chest / knees on the axis, then on its right and left side. Hits
 * within `radius` of a sample are the body's own space and do not count.
 */
export function bodyVisible(
  world: Pick<CollisionWorld, 'raycast'>,
  eye: { x: number; y: number; z: number },
  x: number, z: number, bottom: number, height: number, radius: number,
  seeThrough?: SeeThrough | null,
): boolean {
  const [sx, sz] = occlusionSide(eye.x, eye.z, x, z, radius);
  for (const o of BODY_SIDES) {
    for (const f of BODY_HEIGHTS) {
      if (!sightBlocked(world, eye.x, eye.y, eye.z, x + sx * o, bottom + height * f, z + sz * o, radius, seeThrough)) return true;
    }
  }
  return false;
}

/** Hits this close to a pose point (a hand on a wall, a foot on the floor) do not count. */
const POINT_SLACK = 0.1;

/** Is any of `points` (xyz triples: bone positions of the pose) visible from the eye? */
export function pointsVisible(
  world: Pick<CollisionWorld, 'raycast'>,
  eye: { x: number; y: number; z: number },
  points: ArrayLike<number>,
  seeThrough?: SeeThrough | null,
): boolean {
  for (let i = 0; i + 2 < points.length; i += 3) {
    if (!sightBlocked(world, eye.x, eye.y, eye.z, points[i], points[i + 1], points[i + 2], POINT_SLACK, seeThrough)) return true;
  }
  return false;
}

/**
 * Up to `count` of the points `pos` (xyz triples) spread as far apart as possible: farthest-point
 * sampling from `start`, skipping points that are not `usable`. For a skeleton's bind-pose bone
 * positions (skinned bones only) it picks the extremities: head, hands, feet. Returns indices.
 */
export function spreadPoints(pos: ArrayLike<number>, usable: (i: number) => boolean, start: number, count: number): number[] {
  const n = Math.floor(pos.length / 3);
  const near = new Float64Array(n).fill(Infinity);
  const out: number[] = [];
  let from = start;
  while (out.length < count && from >= 0) {
    let best = -1, bestD = 1e-6;
    for (let i = 0; i < n; i++) {
      const d = (pos[3 * i] - pos[3 * from]) ** 2 + (pos[3 * i + 1] - pos[3 * from + 1]) ** 2 + (pos[3 * i + 2] - pos[3 * from + 2]) ** 2;
      if (d < near[i]) near[i] = d;
      if (usable(i) && near[i] > bestD) (bestD = near[i]), (best = i);
    }
    if (best >= 0) out.push(best);
    from = best;
  }
  return out;
}
