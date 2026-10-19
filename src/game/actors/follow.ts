// FollowBehavior's rules (docs/game-logic.md §15.10), kept pure for the tests; actor.ts runFollow
// drives the body with them.
//
// Read in Suffering.rfl [verified unless marked]: start 0x100ed480, update 0x100f03a0, child
// events 0x100eeb30, message handler 0x100ed550 (0x2015 GetOutOfWay), the waiting child
// 0x100ea6c0 / 0x100ea7a0, the path test 0x100ea610 -> 0x1011e350, the step aside 0x100ee710,
// the re-check timer 0x100e8930.
//
// The follower waits (p3 = 1: a HostilityBehavior, so it fights; 0: an IdleBehavior) and every
// 0.5..1 s finds a path to the leader (FindPath). A path longer than p5 m (p6 while its Hostility
// has a target) makes it run (movement mode 3) along that path to p4 m from its end, with the
// waiting child stopped; an attack under way is never cut short for it (0x10097780). Arrived, it
// waits again. No path, or a run that fails: it beckons (LookAt the leader over an Idle) and
// keeps checking. A leader within 2 m coming at it with the follower in his way makes it step
// aside (its radius + 0.5 m) for 2.5..3 s. A leader farther than p7 (> 0) ends the behaviour.

/** Seconds to the next path check: (rand() / 32767 + 1) x 0.5, so U(0.5, 1) (0x100e8930). */
export function followCheckDelay(u: number): number {
  return (Math.max(0, Math.min(1, u)) + 1) * 0.5;
}

/** The longest path to the leader the follower waits on: p6 while its Hostility has a target, else p5. */
export function followLimit(b: { far: number; combatFar: number }, engaged: boolean): number {
  return engaged ? b.combatFar : b.far;
}

/**
 * Runs after the leader? `pathLength` is the length of the path found to him (undefined: no
 * path, so it beckons instead). 0x1011e350 sums the path's legs and compares the sum with the
 * limit (longer = run).
 */
export function followRuns(pathLength: number | undefined, limit: number): boolean {
  return pathLength !== undefined && pathLength > limit;
}

/** The behaviour gives up: the leader is farther than p7 (3D; p7 <= 0 never) (0x100f0544). */
export function followGivesUp(giveUp: number, distance3d: number): boolean {
  return giveUp > 0 && distance3d > giveUp;
}

/** Length of a path through `pts` (3D legs). */
export function polylineLength(pts: readonly { x: number; y: number; z: number }[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  return n;
}

/** Seconds a step aside lasts: U(0, 0.5) + 2.5 (0x100ee9d6). */
export function stepAsideTime(u: number): number {
  return Math.max(0, Math.min(1, u)) * 0.5 + 2.5;
}

/**
 * The step aside (0x100ee710) [verified]: the leader (within 2 m, tested by the caller) moves
 * (horizontal velocity v) towards the follower, and his line of motion passes through the
 * follower's body (radius r: the two points r to either side of the follower, across the line
 * of motion, lie on different sides of it). `d` is the follower's position minus the leader's
 * (x / z). Returns the spot to step to, relative to the leader: the follower moved r + 0.5 m
 * across the line, to the side whose side point lies farther from it (the side it leans to); it
 * walks there (movement mode 1, arrival 0.5 m) and stays out of the way for 2.5..3 s.
 */
export function stepAside(v: { x: number; z: number }, d: { x: number; z: number }, r: number): { x: number; z: number } | undefined {
  const s = Math.hypot(v.x, v.z);
  if (s < 1e-3) return undefined;
  // Coming at it: the follower is ahead of the leader along his motion.
  if (d.x * v.x + d.z * v.z <= 0) return undefined;
  // Across the line of motion (v x up, normalised).
  const nx = -v.z / s, nz = v.x / s;
  const side = (px: number, pz: number) => Math.sign(v.x * pz - v.z * px);
  const a = side(d.x - nx * r, d.z - nz * r), b = side(d.x + nx * r, d.z + nz * r);
  if (a === b) return undefined;
  // Away from the line on the side the centre is on (on the line: the +n side).
  const k = d.x * nx + d.z * nz >= 0 ? 1 : -1;
  const m = r + 0.5;
  return { x: d.x + nx * m * k, z: d.z + nz * m * k };
}
