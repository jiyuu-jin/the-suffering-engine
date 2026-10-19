// NPC thrown weapons: a BouncingObject in a character's weapon set (Character p55: 6a / 6b's
// stranger, Clem, template 10:642, throws 10:1863 - a molotov). Decoded from Suffering.rfl
// [verified unless marked]:
//
//   * ProjectileAttack's animation-message handler (0x100fcec0) takes the firing clip's
//     ThrowWeapon (230) marker (jump-table case 0x100fd026; 102 Fire goes to the Ranged Weapon
//     instead, 0x100958e0, which only fires class 0x9710d816): the weapon of the marker's index
//     (0x10096ab0) as a Missile / BouncingObject (0x10028420), the target's aim point
//     (0x1009e0f0) unless one is kept, then by the object's p0:
//       0  launch along the weapon's -Z axis at the object's speed (0x100fd0d1..0x100fd147);
//       1  the ballistic aim 0x100ccee0 -> 0x100cc590 (below);
//       2  another aim (0x100ccb20, not decoded; no retail NPC weapon uses it [data]).
//     The object is then released (0x100ce190) and flies as any BouncingObject.
//   * The point aimed at (0x100ccee0) by the object's p48: 0 the target's position, 1 its vt
//     +0x64 point, 2 its aim point (10:1863: 2).
//   * Ballistic aim 0x100cc590: d = aim point - the object's position. With d's horizontal
//     length over p9 (m x 2048) the whole of d is scaled down to p9 (the throw's reach). The
//     speed is the object's current speed (its launch speed p1 [inferred]) and g its gravity.
//     The two elevations that reach d on a parabola (both signs of each root: four candidates
//     built with acos and 0.5, 0x100cc72a..0x100cc84c) are kept when the flight they give passes
//     within 2 m of d's height at d's distance (0x100cc870..0x100cc8c5, constant 2.0); the
//     lowest kept elevation wins. None (no real root, or none within 2 m): p10 degrees. The
//     velocity is the horizontal direction turned up by that elevation times the speed; the
//     caller's spread argument (0 for a throw) would add a random cone.
//
// Port: `ballisticLaunch` solves the same parabola in closed form (tan theta = (v^2 +- sqrt(v^4 -
// g (g x^2 + 2 y v^2))) / (g x)), keeps the roots that pass within 2 m, takes the lowest.

export interface ThrowAim {
  /** Launch speed (m/s). */
  speed: number;
  /** Gravity (m/s^2, positive down). */
  gravity: number;
  /** Reach (m, the object's p9; 0 = none). */
  reach: number;
  /** Fallback elevation (degrees, the object's p10). */
  fallbackDeg: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Height of a throw at elevation `theta` after `x` m horizontally (relative to the launch). */
export function flightHeight(x: number, theta: number, speed: number, gravity: number): number {
  const c = Math.cos(theta);
  if (Math.abs(c) < 1e-6) return -Infinity;
  return x * Math.tan(theta) - (gravity * x * x) / (2 * speed * speed * c * c);
}

/** Elevation (radians) of the decoded ballistic aim from `from` to `to`, and the aimed offset. */
export function throwElevation(from: Vec3, to: Vec3, aim: ThrowAim): { theta: number; dx: number; dy: number; dz: number; solved: boolean } {
  let dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const h = Math.hypot(dx, dz);
  if (aim.reach > 0 && h > aim.reach) {
    // The whole offset is scaled to the reach (0x100cc60f..0x100cc63d).
    const s = aim.reach / Math.hypot(h, dy);
    dx *= s;
    dy *= s;
    dz *= s;
  }
  const x = Math.hypot(dx, dz);
  const v2 = aim.speed * aim.speed, g = aim.gravity;
  let best = Infinity;
  if (x > 1e-6 && g > 0) {
    const disc = v2 * v2 - g * (g * x * x + 2 * dy * v2);
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      for (const t of [Math.atan((v2 - r) / (g * x)), Math.atan((v2 + r) / (g * x))]) {
        if (Math.abs(flightHeight(x, t, aim.speed, g) - dy) < 2 && t < best) best = t;
      }
    }
  } else if (x <= 1e-6) best = dy >= 0 ? Math.PI / 2 : -Math.PI / 2;
  const solved = Number.isFinite(best);
  return { theta: solved ? best : (aim.fallbackDeg * Math.PI) / 180, dx, dy, dz, solved };
}

/** Launch velocity of an NPC throw at `to` (the target's aim point) from `from` (the hand). */
export function ballisticLaunch(from: Vec3, to: Vec3, aim: ThrowAim): Vec3 & { solved: boolean } {
  const e = throwElevation(from, to, aim);
  const h = Math.hypot(e.dx, e.dz);
  const ux = h > 1e-6 ? e.dx / h : 0, uz = h > 1e-6 ? e.dz / h : 0;
  const c = Math.cos(e.theta), s = Math.sin(e.theta);
  return { x: ux * c * aim.speed, y: s * aim.speed, z: uz * c * aim.speed, solved: e.solved };
}
