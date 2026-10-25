// The player's Melee Weapon blade against level objects (Breakables and the other damageable
// props), as the original's sweep does it (Suffering.rfl; docs/game-logic.md §14.1 "Melee on
// props"). Pure rules: no Three.js, no game state.
//
// Original [verified unless marked]:
//   * An Arm marker (100) of the strike clip arms the Melee Weapon in the hand (0x100ca210, the
//     list of objects already struck is cleared); the arming frame only records the blade's place.
//     Every frame until the Disarm (101; 0x100ca4c0 waits for at least one sweep) the blade
//     (model 4:23 for the shiv: a segment from the hilt to 1.23 m along -z) is swept from its
//     previous place to its current one (0x100cb6c0 -> 0x100caff0).
//   * Candidates are what the engine's collision query returns for that volume with the class
//     filter reset and then off for Collider (0xfa5951fc), Invisible Static Object (0xaa7d6985)
//     and category 10 (Item); at most 8 per frame. No class test beyond that: Breakables,
//     Pushables, doors and characters alike. The wielder and what rides on it are skipped
//     (0x100c9ca0).
//   * Per candidate (0x100c9de0): a character is tested by its posed skeleton's leaf hit spheres
//     (0x100c9680); a rigid object by its model's own leaf volumes: leaf boxes (0x100c99c0: the
//     swept quad's edges against each oriented box) or leaf spheres (0x100c9810), moved by the
//     object's matrix. A Breakable crate's model holds one leaf box: its bounds.
//   * A struck object that takes damage (0x100a1ff0) and is not a character gets the wall test
//     (0x100c9490: a segment from the wielder's x / z at the contact's height to the contact,
//     with the wielder, the weapon and the target taken out of the query (engine +8 0x400000)
//     and Items, the Player category, Detectors, Water Volumes and Invisible Static Objects
//     filtered off; any other hit, level geometry or another object, cancels the blow); then
//     the damage record (0x100ca920): Melee Weapon p68 x the Attack's p6, type p70, impact force
//     p69 x Attack p7. Each object once per Arm window; one swing can strike several.
//   * The object's own damage code then applies Damage Resistance (GameObject 0x100a31b0 ->
//     0x100a2dc0): x1, or x0 with GameObject p5; the first p7 attachment of the type replaces it
//     with its p1, else the global list (Level Properties p46).
//
// Port: the blade's swept quad is sampled by segments (the blade at a few points of the frame's
// move plus the paths of its two ends) cast against the collision world, whose dynamic bodies are
// the props' own meshes [port stand-in for the leaf boxes / spheres].

export type Vec3 = [number, number, number];

/** A blade (hilt a, tip b) in world space. */
export interface BladePose {
  a: Vec3;
  b: Vec3;
}

/**
 * Segments that sample the quad a blade swept this frame, from `prev` to `cur`: the blade at
 * `steps` evenly spaced points of the move (the current place last), then the hilt's and the
 * tip's paths. A blade that did not move gives its current place only.
 */
export function sweptQuadSegments(prev: BladePose, cur: BladePose, steps = 4): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  const moved = dist(prev.a, cur.a) + dist(prev.b, cur.b) > 1e-4;
  const n = moved ? Math.max(1, steps) : 1;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    out.push([lerp3(prev.a, cur.a, k), lerp3(prev.b, cur.b, k)]);
  }
  if (moved) {
    out.push([prev.b, cur.b]);
    out.push([prev.a, cur.a]);
  }
  return out;
}

/** What a segment cast found: the distance along it, the point and the dynamic body (props). */
export interface SegmentHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
  body?: number;
}

/** A blade contact with a prop body. */
export interface PropContact {
  body: number;
  point: Vec3;
  normal: Vec3;
}

/** Casts per segment and direction: the blade goes on past what it met (MAX_PASS - 1 things). */
const MAX_PASS = 6;

/**
 * The props a swept blade meets: each segment is cast both ways (a segment that starts inside a
 * body still finds it) and goes on past every hit, since the original's query hands over every
 * object in the swept volume, not the nearest (a gate's bars in front of the crate do not hide
 * it), and level geometry is no candidate at all (walls only block through the wall test). The
 * first contact on each body is kept; bodies in `struck` (already hit in this Arm window) are
 * left out.
 */
export function bladePropContacts(segments: readonly [Vec3, Vec3][], cast: (o: Vec3, e: Vec3) => SegmentHit | null, struck: ReadonlySet<number> = new Set()): PropContact[] {
  const out: PropContact[] = [];
  const seen = new Set<number>(struck);
  for (const [p, q] of segments) {
    for (const [o0, e] of [[p, q], [q, p]] as const) {
      const len = dist(o0, e);
      if (len < 1e-6) continue;
      const d: Vec3 = [(e[0] - o0[0]) / len, (e[1] - o0[1]) / len, (e[2] - o0[2]) / len];
      let o = o0;
      let done = 0;
      for (let pass = 0; pass < MAX_PASS && done < len; pass++) {
        const h = cast(o, e);
        if (!h) break;
        if (h.body !== undefined && !seen.has(h.body)) {
          seen.add(h.body);
          out.push({ body: h.body, point: h.point, normal: h.normal });
        }
        // On from just past the hit.
        done += h.distance + 2e-3;
        o = [o0[0] + d[0] * done, o0[1] + d[1] * done, o0[2] + d[2] * done];
      }
    }
  }
  return out;
}

/**
 * The wall test before a blow on a non-character (0x100c9490): a ray from the wielder's x / z at
 * the contact's height to the contact. `firstHit` gives the distance and body of the first thing
 * on that ray; anything other than the struck body before the contact cancels the blow.
 */
export function bladeWallClear(wielder: { x: number; z: number }, contact: Vec3, body: number, firstHit: (o: Vec3, dir: Vec3, len: number) => { distance: number; body?: number } | null): boolean {
  const o: Vec3 = [wielder.x, contact[1], wielder.z];
  const dx = contact[0] - o[0], dz = contact[2] - o[2];
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return true;
  const h = firstHit(o, [dx / len, 0, dz / len], len);
  return !h || h.body === body || h.distance >= len - 0.05;
}

/** Hits a blow of `amount` needs to take `health` (after the resistance multiplier). */
export function blowsToBreak(health: number, amounts: readonly number[], mult = 1): number {
  let left = health;
  for (let i = 0; i < 100; i++) {
    const a = amounts[Math.min(i, amounts.length - 1)] * mult;
    if (a <= 0) return Infinity;
    left -= a;
    if (left <= 0) return i + 1;
  }
  return Infinity;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function lerp3(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
