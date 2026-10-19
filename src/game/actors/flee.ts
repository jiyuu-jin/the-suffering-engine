// FleeBehavior and Flee Positions, as Suffering.rfl runs them (docs/game-logic.md §15.14).
//
// Read in Suffering.rfl [verified unless marked]: the FleeBehavior vtable 0x10157640 (start
// 0x10111100, child-done 0x10111220, update 0x10111340, message handler 0x101115b0), the spot
// choice 0x1010f3c0 -> 0x1010ccd0 -> the Flee Position manager 0x100adaa0 (threat terms
// 0x100ad620, ally terms 0x100ad810), the threat / ally gathering 0x1010e730 (team lists
// 0x1010b340 = p42, 0x1010b3b0 = p44), the group flood fill 0x100ae480 and the failure mark
// 0x100ae310.
//
// The fleeing character runs to a Flee Position, stands there, and every p16..p17 s while it
// stands picks again. A pick scores every Flee Position of its group:
//   p23 x the mean of d / p32 over the threats within p32 m of the spot (1 when none), where a
//       threat within p33 m of the spot rules the spot out;
//   p24 x the mean of (1 - d / p32) over the allies within p32 m of the spot (0 when none);
//   p25 x (1 - its horizontal distance / p31); spots beyond p31 m are out;
//   p26 x min(1 - cos^2) over the threats nearer than the spot, cos of the angle between the
//       way to the threat and the way to the spot (0 for a threat behind): running at a threat
//       scores low;
//   p27 the same over allies; p28 for the spot it stands on; p29 for the spot it runs to.
// The best (strictly greater) wins; a spot marked failed is out for 7 s.

/** A Flee Position as the AI sees it. */
export interface FleeSpot {
  uid: number;
  x: number;
  y: number;
  z: number;
  /** Linked Flee Positions share a group (fleeGroups); -1 for a spot linked to none [verified]. */
  group: number;
  /** p0 > 0: the most the spot may be above / below the character (m); else no limit [verified]. */
  maxDy: number;
  /** Game time it was marked failed (0x100ae310 stamps it; skipped for 7 s), -Infinity never. */
  failedAt: number;
  /** Nearest Move Node (index), -1 none: the spot must share the character's nav area. */
  node?: number;
}

/** FleeBehavior properties (instance values first) [verified reads; roles as noted]. */
export interface FleeParams {
  /** p2: done when no threat is left. */
  doneWhenSafe: boolean;
  /** p10 / p11: done when a threat comes within p11 m again after all were farther [verified]. */
  doneWhenCaught: boolean;
  caughtRange: number;
  /** p12: arrival distance of the run to a spot (m). */
  arrive: number;
  /** p13: no spot found -> done. */
  doneWhenNone: boolean;
  /** p15: spots to reach before done (0: flee until replaced). */
  runs: number;
  /** p16..p17: seconds between picks while standing. */
  repickMin: number;
  repickMax: number;
  /** p18 / p19 / p20: at least p18 hits of p20 or more within p19 s while standing -> pick again. */
  hitCount: number;
  hitWindow: number;
  hitMin: number;
  /** p21: one blow of p21 % of max health while standing -> pick again. */
  bigHitPercent: number;
  /** p22: keep to the group of the first spot. */
  keepGroup: boolean;
  /** Weights p23..p29 (p27, running at an ally, always multiplies 0). */
  wThreatFar: number;
  wAllyNear: number;
  wNear: number;
  wAway: number;
  wAllyAway: number;
  wStay: number;
  wCurrent: number;
  /** p31 (m): farthest spot; p32 (m): threat / ally radius around a spot; p33 (m): a threat this close rules a spot out. */
  maxDist: number;
  radius: number;
  tooClose: number;
  /** p42 threat teams, p43 threat uids, p44 ally teams. */
  threatTeams: string[];
  threatUids: number[];
  allyTeams: string[];
}

type V = readonly unknown[];
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refs = (v: unknown): { pkg: number; id: number }[] => (Array.isArray(v) ? v : [v]).filter((x): x is { pkg: number; id: number } => !!x && typeof x === 'object' && 'id' in (x as object));
const uids = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && x > 0);

export function fleeParams(v: V): FleeParams {
  return {
    doneWhenSafe: num(v[2], 0) !== 0,
    doneWhenCaught: num(v[10], 0) !== 0,
    caughtRange: num(v[11], 5),
    arrive: Math.max(0.5, num(v[12], 2)),
    doneWhenNone: num(v[13], 0) !== 0,
    runs: Math.max(0, Math.trunc(num(v[15], 0))),
    repickMin: Math.max(0.05, num(v[16], 0.4)),
    repickMax: Math.max(0.05, num(v[17], 0.8)),
    hitCount: num(v[18], 3),
    hitWindow: num(v[19], 5),
    hitMin: num(v[20], 5),
    bigHitPercent: num(v[21], 10),
    keepGroup: num(v[22], 0) !== 0,
    wThreatFar: num(v[23], 1),
    wAllyNear: num(v[24], 1),
    wNear: num(v[25], 0.5),
    wAway: num(v[26], 1),
    wAllyAway: num(v[27], 0),
    wStay: num(v[28], 0.25),
    wCurrent: num(v[29], 0),
    // 0x100adaa0 clamps both to at least 0.1 engine units / 2048.
    maxDist: Math.max(1e-4, num(v[31], 40)),
    radius: Math.max(1e-4, num(v[32], 20)),
    tooClose: num(v[33], 8),
    threatTeams: refs(v[42]).map((r) => `${r.pkg}:${r.id}`),
    threatUids: uids(v[43]),
    allyTeams: refs(v[44]).map((r) => `${r.pkg}:${r.id}`),
  };
}

/**
 * Groups of linked Flee Positions: connected components over the links (the manager first adds
 * every link the other way, 0x100ae370, then floods them, 0x100ae480) [verified].
 */
export function fleeGroups(spots: readonly { uid: number; links: readonly number[] }[]): Map<number, number> {
  const adj = new Map<number, Set<number>>();
  for (const s of spots) adj.set(s.uid, new Set());
  for (const s of spots)
    for (const l of s.links)
      if (adj.has(l)) {
        adj.get(s.uid)!.add(l);
        adj.get(l)!.add(s.uid);
      }
  const group = new Map<number, number>();
  let g = 0;
  for (const s of spots) {
    if (group.has(s.uid)) continue;
    // A spot linked to no other is in no group (-1): the flood fill finds nothing and resets it
    // (0x100ae6c0).
    if (!adj.get(s.uid)!.size) {
      group.set(s.uid, -1);
      continue;
    }
    const todo = [s.uid];
    group.set(s.uid, g);
    while (todo.length) for (const n of adj.get(todo.pop()!)!) if (!group.has(n)) group.set(n, g), todo.push(n);
    g++;
  }
  return group;
}

/** Seconds a failed spot stays out of the choice ([0x10154ebc] = 7.0) [verified]. */
export const FLEE_FAIL_TIME = 7;

interface P {
  x: number;
  y: number;
  z: number;
}

export interface FleeChoice {
  me: P;
  threats: readonly P[];
  allies: readonly P[];
  spots: readonly FleeSpot[];
  /** Group to keep to (p22), -1 none. */
  group: number;
  /** The spot it stands on (arrived at), -1 none. */
  stay: number;
  /** The spot it is running to, -1 none (passed only on the timed re-pick). */
  current: number;
  time: number;
  /** The spot is in the character's nav area (0x100ade21: same area id of their nodes). */
  reachable?: (s: FleeSpot) => boolean;
}

/** Score of one spot, or null when it is ruled out (0x100adaa0 per position) [verified]. */
export function fleeScore(p: FleeParams, c: FleeChoice, s: FleeSpot): number | null {
  if (c.time - s.failedAt < FLEE_FAIL_TIME) return null;
  if (c.group >= 0 && s.group !== c.group) return null;
  if (c.reachable && !c.reachable(s)) return null;
  if (s.maxDy > 0 && Math.abs(s.y - c.me.y) > s.maxDy) return null;
  const dx = s.x - c.me.x, dz = s.z - c.me.z;
  const dist = Math.hypot(dx, dz);
  if (dist > p.maxDist) return null;
  const ux = dist > 1e-6 ? dx / dist : 0, uz = dist > 1e-6 ? dz / dist : 0;
  // Threats (0x100ad620).
  let n = 0, far = 0, away = 1;
  for (const t of c.threats) {
    const d = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
    if (d > p.radius) continue;
    if (d < p.tooClose) return null;
    n++;
    if (d > 0.1) far += d / p.radius;
    const tx = t.x - c.me.x, tz = t.z - c.me.z;
    const td = Math.hypot(tx, tz);
    if (td > dist || td < 1e-6) continue;
    const cos = Math.max(0, (tx * ux + tz * uz) / td);
    away = Math.min(away, 1 - cos * cos);
  }
  const threatFar = n ? far / n : 1;
  // Allies (0x100ad810). Its "running at an ally" minimum starts at 0 and so stays 0: the p27
  // term never adds anything [verified].
  let m = 0, near = 0;
  for (const a of c.allies) {
    const d = Math.hypot(a.x - s.x, a.y - s.y, a.z - s.z);
    if (d > p.radius) continue;
    m++;
    near += d > 0.1 ? 1 - d / p.radius : 1;
  }
  const allyNear = m ? near / m : 0;
  return (
    p.wThreatFar * threatFar +
    p.wAllyNear * allyNear +
    p.wNear * (1 - dist / p.maxDist) +
    p.wAway * away +
    (s.uid === c.stay ? p.wStay : 0) +
    (s.uid === c.current ? p.wCurrent : 0)
  );
}

/** The spot a pick chooses (uid), or -1 when none passes. */
export function chooseFleeSpot(p: FleeParams, c: FleeChoice): number {
  let best = -1, bestScore = -Infinity;
  for (const s of c.spots) {
    const v = fleeScore(p, c, s);
    if (v !== null && v > bestScore) (bestScore = v), (best = s.uid);
  }
  return best;
}

/** Hits of at least `min` within the last `window` s, blows of one instant counted once [verified shape: 0x100a35a0]. */
export function recentHits(hits: readonly { t: number; amount: number }[], now: number, window: number, min: number): number {
  let n = 0, last = NaN;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.t < now - window) break;
    if (h.amount < min || h.t === last) continue;
    n++;
    last = h.t;
  }
  return n;
}
