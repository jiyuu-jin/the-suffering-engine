// NPC thrown missiles: the Mainliner's needle (Missile 10:1814 in Character p55). Decoded from
// Suffering.rfl [verified unless marked]; docs/game-logic.md §15.7.4 "Thrown needles".
//
//   * The throw clip 10:242 (Attack 10:210 p0) carries one ThrowWeapon (230) marker at 0.278 s and
//     no Fire (102): the needle leaves through ProjectileAttack's case 230 (0x100fd026), the path
//     of every thrown weapon (actors/throw.ts), not through a Ranged Weapon. So no Ranged Weapon
//     p75 x Attack p19 spread applies: the aim call 0x100ccee0 gets a spread argument of 0
//     (0x100fd165 push 0).
//   * The point aimed at: ProjectileAttack keeps one aim point (+0x64). Its start clears it
//     (0x100fee3e); the Fire state's entry (0x100fcc31) samples the target's aim point
//     (0x1009e0f0) only while it is unset; at the marker it is sampled again only when the
//     behaviour's own p5 is 0 (0x100fd069 -> 0x10097b80: the ProjectileAttackBehavior template;
//     0x100fd079). The Mainliner's 10:209 has p5 = 1, so the needle goes where the player was
//     when the throw clip started, 0.278 s before it leaves. There is no lead.
//   * Launch: the needle's p0 = 1, the ballistic aim (throw.ts ballisticLaunch) with its own speed
//     p1 (45000 units/s, 21.97 m/s), gravity p46 = 20 % of the world's (2.08 m/s²), reach p9 20 m
//     and fallback elevation p10 45 deg; it is released (0x100ce190) and flies as a Missile
//     (think vt+0x60 0x100ce940) for its p12 = 5 s.
//   * Contact: the sweep vt+0x5c (0x100ceff0, shared with BouncingObject) takes the segment from
//     the previous to the new position against the world's front faces, triangles grown by the
//     object's bounds radius (CollisionWorld.frontSegmentCast), and against objects (bounding
//     sphere, then the collision tree; a skinned body's sphere tree through 0x419b20, not traced:
//     port, the posed leaf hit spheres grown by the same radius) [inferred for bodies]. The
//     touch handler (vt+0x24 0x100cc120) sets it off (vt+0x4c 0x100d0f60): any contact ends the
//     flight, and the impact (vt+0x54 0x100d1450) deals p26 = 10 damage of type p32 = 1 to what
//     it touched and spawns p34 (3:3199) there.
//   * The thrower is not hit by its own needle [port: the release point is inside its body].

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A needle (or any NPC-thrown Missile) in flight. */
export interface MissileFlight {
  p: Vec3;
  v: Vec3;
  /** Gravity (m/s², positive down). */
  gravity: number;
  age: number;
  life: number;
  /** Sweep radius (the model's bounds radius, m). */
  radius: number;
}

/** A body the missile can touch: its hit spheres (output space). */
export interface MissileBody<T> {
  body: T;
  spheres: readonly { c: readonly number[]; r: number; bone?: number }[];
}

export interface WorldSweep {
  frontSegmentCast(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius?: number): { point: [number, number, number] | number[]; normal: [number, number, number] | number[] } | null;
}

export type MissileContact<T> = { kind: 'world'; point: Vec3; normal: Vec3 } | { kind: 'body'; body: T; point: Vec3; bone?: number } | { kind: 'expired'; point: Vec3 };

/**
 * First parameter t in [0, 1] at which the segment a -> a + d comes within `r` of centre c
 * (undefined: never). A start already inside counts at t = 0.
 */
export function segmentSphere(a: Vec3, d: Vec3, c: readonly number[], r: number): number | undefined {
  const fx = a.x - c[0], fy = a.y - c[1], fz = a.z - c[2];
  const A = d.x * d.x + d.y * d.y + d.z * d.z;
  const B = 2 * (fx * d.x + fy * d.y + fz * d.z);
  const C = fx * fx + fy * fy + fz * fz - r * r;
  if (C <= 0) return 0;
  if (A < 1e-12) return undefined;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return undefined;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : undefined;
}

/**
 * One step of a missile's flight: gravity, then the segment to the new position against the
 * world and the bodies; the nearest contact ends the flight. Moves `m` (to the contact point on a
 * contact). Returns the contact, `expired` when its life ran out, or null while it flies on.
 */
export function missileStep<T>(m: MissileFlight, dt: number, world: WorldSweep | null, bodies: readonly MissileBody<T>[]): MissileContact<T> | null {
  m.age += dt;
  m.v.y -= m.gravity * dt;
  const d = { x: m.v.x * dt, y: m.v.y * dt, z: m.v.z * dt };
  let best = Infinity;
  let hit: MissileContact<T> | null = null;
  const len = Math.hypot(d.x, d.y, d.z);
  const w = world && len > 1e-9 ? world.frontSegmentCast(m.p.x, m.p.y, m.p.z, m.p.x + d.x, m.p.y + d.y, m.p.z + d.z, m.radius) : null;
  if (w) {
    const t = Math.hypot(w.point[0] - m.p.x, w.point[1] - m.p.y, w.point[2] - m.p.z) / Math.max(len, 1e-9);
    best = t;
    hit = { kind: 'world', point: { x: w.point[0], y: w.point[1], z: w.point[2] }, normal: { x: w.normal[0], y: w.normal[1], z: w.normal[2] } };
  }
  for (const b of bodies) {
    for (const s of b.spheres) {
      const t = segmentSphere(m.p, d, s.c, s.r + m.radius);
      if (t !== undefined && t < best) {
        best = t;
        // The sphere touched first is the struck one (its bone goes with the blow: Part Caps) [port].
        hit = { kind: 'body', body: b.body, point: { x: m.p.x + d.x * t, y: m.p.y + d.y * t, z: m.p.z + d.z * t }, bone: s.bone };
      }
    }
  }
  if (hit) {
    m.p = { ...hit.point };
    return hit;
  }
  m.p = { x: m.p.x + d.x, y: m.p.y + d.y, z: m.p.z + d.z };
  if (m.age >= m.life) return { kind: 'expired', point: { ...m.p } };
  return null;
}
