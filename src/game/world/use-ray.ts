// The use prompt's ray: what the crosshair is on (docs/game-logic.md §14.5 "Use target", "The
// port's prompt").
//
// The original lists usables by touch and its fit test and never casts a view ray for Use
// (Suffering.rfl 0x1002bde0 / 0x10036240) [verified]. The port keeps a prompt for the object
// under the crosshair [port], so that ray has to be the crosshair's: the camera's view ray. In
// first person the camera is the eye. In third person the camera orbits 3.2 m behind an
// over-the-shoulder pivot (app/player.ts updateCamera), and the old ray (from the head along the
// camera's direction) ran parallel to the crosshair, 0.45 m to the left and 0.1 m down; small
// objects (light switches, buttons) were found only with the crosshair well off them.
//
// The ray: from the camera along its view direction. The player's reach (3 m) is measured from
// the eye to the point on that ray, so in third person the usable stretch of the ray is where it
// passes within `reach` of the head (a sphere), and it ends a little past the first surface the
// ray meets (the crosshair cannot see through a wall). In first person this is the old test
// exactly: from 0 to min(reach, wall + slack).

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface UseRay {
  /** The camera (ray origin). */
  origin: V3;
  /** Unit view direction. */
  dir: V3;
  /** The player's eye (reach is measured from it). */
  eye: V3;
  /** Usable stretch of the ray, distances from `origin`. */
  near: number;
  far: number;
  /** The point under the crosshair (the first surface, or the far end of the reach). */
  aim: V3;
  /** Unit direction from the eye to `aim` (the eye's own look at the crosshair's point). */
  eyeDir: V3;
}

/** Slack past the first surface (a door's or switch's box sits a few cm in front of the wall). */
export const USE_RAY_SLACK = 0.15;

/**
 * The crosshair's use ray. `wall`: distance along the view ray to the first collision surface
 * (undefined: none). null when no part of the ray within reach of the eye is in front of a wall.
 */
export function useRay(camera: V3, dir: V3, eye: V3, reach: number, wall: number | undefined, slack = USE_RAY_SLACK): UseRay | null {
  // |camera + t dir - eye| <= reach.
  const mx = camera.x - eye.x, my = camera.y - eye.y, mz = camera.z - eye.z;
  const b = mx * dir.x + my * dir.y + mz * dir.z;
  const c = mx * mx + my * my + mz * mz - reach * reach;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const near = Math.max(0, -b - s);
  let far = -b + s;
  if (wall !== undefined) far = Math.min(far, wall + slack);
  if (far < near) return null;
  const ta = wall !== undefined ? Math.max(near, Math.min(wall, far)) : far;
  const aim = { x: camera.x + dir.x * ta, y: camera.y + dir.y * ta, z: camera.z + dir.z * ta };
  let ex = aim.x - eye.x, ey = aim.y - eye.y, ez = aim.z - eye.z;
  const l = Math.hypot(ex, ey, ez);
  if (l > 1e-6) (ex /= l), (ey /= l), (ez /= l);
  else (ex = dir.x), (ey = dir.y), (ez = dir.z);
  return { origin: { x: camera.x, y: camera.y, z: camera.z }, dir: { x: dir.x, y: dir.y, z: dir.z }, eye: { x: eye.x, y: eye.y, z: eye.z }, near, far, aim, eyeDir: { x: ex, y: ey, z: ez } };
}

/**
 * Where the ray first meets an axis-aligned box within [near, far] (slab test): the entry
 * distance, clamped to `near` when the ray is already inside there; null when it misses.
 */
export function rayBoxEntry(o: V3, d: V3, min: V3, max: V3, near: number, far: number): number | null {
  let t0 = near, t1 = far;
  for (const k of ['x', 'y', 'z'] as const) {
    const ok = o[k], dk = d[k];
    if (Math.abs(dk) < 1e-12) {
      if (ok < min[k] || ok > max[k]) return null;
      continue;
    }
    let a = (min[k] - ok) / dk, b = (max[k] - ok) / dk;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  return t0;
}

/** The point at distance `t` along the ray. */
export function rayPoint(r: UseRay, t: number): V3 {
  return { x: r.origin.x + r.dir.x * t, y: r.origin.y + r.dir.y * t, z: r.origin.z + r.dir.z * t };
}

/** Is the camera away from the eye (third person: the eye's own line to the target is checked too)? */
export function thirdPersonRay(r: UseRay): boolean {
  return Math.hypot(r.origin.x - r.eye.x, r.origin.y - r.eye.y, r.origin.z - r.eye.z) > 1e-3;
}
