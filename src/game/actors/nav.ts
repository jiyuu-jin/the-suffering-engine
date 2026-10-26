// AI navigation graph from the level's "Move Node Object" entities.
//
// Each Move Node links to its neighbours (links are mostly one-way in the data;
// we treat them as undirected edges). Node scale looks like a clearance radius.
// Edge Passages mark doorways between two nodes (closed doors are vetoed by the caller's
// `blocked` callback, see system.ts). EdgeToggler objects switch single edges off and on
// (setEdge; docs/game-logic.md §15.3): a disabled edge is never used by path().
//
// Ceiling nodes (docs/game-logic.md §15.7.5) [verified: graph build Suffering.rfl 0x100da930,
// reverse edges 0x100daea0, FollowPath 0x10110db0]: Move Node p0 = 1 (template 10:128) marks a
// node on a ceiling; every other node is on the floor. An edge's type follows from its two nodes,
// in the direction it is walked: 0 floor -> floor, 1 ceiling -> ceiling, 2 floor -> ceiling,
// 3 ceiling -> floor (the reverse edge swaps 2 and 3). FollowPath walking a type 2 / 3 edge runs
// a CeilingFloorTransitionBehavior (the creature leaps up / lets go). Only creatures that can
// crawl ceilings use those edges: path() keeps everyone else on floor nodes [inferred: the
// original filters edges per character], `crawler` lets a ceiling crawler use all of them.

import type { Entity } from '../../formats/entities';
import { toOutputSpace } from '../../formats/level';
import type { CollisionWorld } from '../../app/physics';

export interface NavNode {
  uid: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  edges: number[]; // node indices
  /** Move Node p0 = 1: the node is on a ceiling (crawling creatures only) [verified]. */
  ceiling: boolean;
  /**
   * Move Node p2 / p3: NPC Exclusion Types (bits of their p0) and whether only those may use the
   * node (p3 = 1) or those may not (p3 = 0) [verified: mask 0x100d9bb0, flags 0x100db7f5,
   * test 0x100dbf30].
   */
  types?: number;
  only?: boolean;
  /** Full side of the node's square (m: the instance's scale x) and its yaw (radians) [strong, 0x100db756]. */
  size?: number;
  yaw?: number;
}

/**
 * May a character of NPC Exclusion Type `t` walk the edge between nodes A and B? An edge's types
 * come from its two nodes at load (0x100dac90..0x100dadbd) [verified]: both "only" -> the types
 * both list, "only"; one "only" -> its types less the other's excluded ones, "only"; neither ->
 * excluded when either node excludes. Type 31 (no type) passes no "only" edge.
 */
export function navEdgePasses(A: Pick<NavNode, 'types' | 'only'>, B: Pick<NavNode, 'types' | 'only'>, t: number | undefined): boolean {
  if (t === undefined) return true;
  const bit = (n: Pick<NavNode, 'types'>) => (((n.types ?? 0) >>> t) & 1) === 1;
  if (A.only && B.only) return bit(A) && bit(B);
  if (A.only) return bit(A) && !bit(B);
  if (B.only) return bit(B) && !bit(A);
  return !bit(A) && !bit(B);
}

/** The 2D corners (x, z) of a node's square: (±0.5, ±0.5) x size turned by its yaw (0x100d50e0). */
function squareCorners(n: NavNode): [number, number][] {
  const h = (n.size ?? 2 * n.radius) / 2, c = Math.cos(n.yaw ?? 0), s = Math.sin(n.yaw ?? 0);
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => [n.x + u * c + v * s, n.z - u * s + v * c] as [number, number]);
}

/** Is (x, z) in the node's square (0x100d3da0: the offset turned by -yaw, |x|, |z| <= size / 2)? */
function inSquare(n: NavNode, x: number, z: number): boolean {
  const h = (n.size ?? 2 * n.radius) / 2, c = Math.cos(n.yaw ?? 0), s = Math.sin(n.yaw ?? 0);
  const dx = x - n.x, dz = z - n.z;
  return Math.abs(dx * c - dz * s) <= h && Math.abs(dx * s + dz * c) <= h;
}

/** Convex hull (x, z) of a point set, counter-clockwise (monotone chain). */
function hull2(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], hi: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function inConvex(poly: [number, number][], x: number, z: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    if ((bx - ax) * (z - az) - (bz - az) * (x - ax) < 0) return false;
  }
  return poly.length >= 3;
}

function outlineDistance(poly: [number, number][], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

/**
 * Does the edge A-B's area hold the point (0x100d6a10 with the prefilter, margin 0) [verified
 * unless marked]: within 2 m of the plane through A that holds the edge and its horizontal
 * perpendicular (0x100d5c90 / 0x100d5da0, [0x10178b30]); within 1.415 x size (3D) of either node,
 * or over the segment within the smaller of the two horizontally (0x100d4eb0); then in either
 * node's square, or in the strip between them: the convex hull of both squares' corners
 * (0x100d5400 / 0x100d6040) [hull: strong]. No walker radius is taken off (FindPath's margin is 0).
 */
export function edgeHolds(A: NavNode, B: NavNode, x: number, y: number, z: number): boolean {
  const ex = B.x - A.x, ey = B.y - A.y, ez = B.z - A.z;
  const nx = -ey * ex, ny = ex * ex + ez * ez, nz = -ey * ez, nl = Math.hypot(nx, ny, nz);
  if (nl > 1e-9 && Math.abs((nx * (x - A.x) + ny * (y - A.y) + nz * (z - A.z)) / nl) > 2) return false;
  const rA = 1.415 * (A.size ?? 2 * A.radius), rB = 1.415 * (B.size ?? 2 * B.radius);
  if (Math.hypot(x - A.x, y - A.y, z - A.z) > rA && Math.hypot(x - B.x, y - B.y, z - B.z) > rB) {
    const L = Math.hypot(ex, ey, ez);
    if (L * L <= (rA - rB) ** 2) return false;
    const t = ((x - A.x) * ex + (y - A.y) * ey + (z - A.z) * ez) / (L || 1e-9);
    if (t < 0 || t > L) return false;
    const hl = Math.hypot(ex, ez) || 1e-9;
    if (Math.abs(((x - A.x) * ez - (z - A.z) * ex) / hl) > Math.min(rA, rB)) return false;
  }
  if (inSquare(A, x, z) || inSquare(B, x, z)) return true;
  return inConvex(hull2([...squareCorners(A), ...squareCorners(B)]), x, z);
}

/**
 * Does the graph's way from node a to node b, NPC Exclusion Types left aside, pass a node barred
 * to type t? Then a straight walk from a to b stands for a way the walker may not take (actor.ts
 * steer / wayLength) [inferred].
 */
export function shortcutBarred(nav: Pick<NavGraph, 'path' | 'nodes'>, a: number, b: number, t: number): boolean {
  if (a < 0 || b < 0 || a === b) return false;
  const free = nav.path(a, b);
  return !!free && free.some((i) => !navNodePasses(nav.nodes[i], t));
}

/** A character's NPC Exclusion Type (Character p45 -> template p0, 0..30); 31 = none [verified: 0x100dc070]. */
export const NO_NAV_TYPE = 31;

/**
 * Where a point lies on the graph (the start or the goal of a path) [verified, Suffering.rfl]:
 * the nav code keeps edges, not nodes. Each edge's area is its two nodes' squares (half the node's size, turned
 * by the node's yaw, no walker radius taken off; 0x100d3da0) and the strip between them (0x100d5400 /
 * 0x100d6040): edgeHolds, locateEdge. The global search (0x100d87e0) walks the grid cells
 * around the point and returns the first edge that passes the walker's filter (0x100d8780 ->
 * 0x100d5c30: usable, the walker's surface, wide enough, and its passage kind and NPC Exclusion
 * Types, 0x100dbf30) and holds the point; the incremental one (0x100d8bd0) and the A*'s goal
 * lookup (0x1011e436, a walker-less filter: type 31, so edges kept to listed types fail there
 * too) filter the same way. An edge's types come from its two nodes at load (0x100dac90..
 * 0x100dadbd): both "only" -> only the types both list; one "only" -> its types less the other's
 * excluded ones, "only"; neither -> excluded when either node excludes. So a goal placed beside a
 * room kept to another type is located on the walker's own edge next to it: 8b's Waypoint 1ea5
 * lies 0.4 m from walkway node 207f (any type) and 1.5 m from 254a (Hermes' room, 10:682 only),
 * and Jimmy's walk 189f ends on the walkway, where Detector 26b5 sees him.
 * Port: NavGraph.nearest with the walker's type skips the nodes barred to it (the nearest node
 * stands for the containing edge).
 */
export function locatesOn(n: Pick<NavNode, 'types' | 'only'>, t: number | undefined): boolean {
  return t === undefined || !(n.types || n.only) || navNodePasses(n, t);
}

/** May a character of NPC Exclusion Type `t` use the node (0x100dbf30)? */
export function navNodePasses(n: Pick<NavNode, 'types' | 'only'>, t: number): boolean {
  const has = (((n.types ?? 0) >>> t) & 1) === 1;
  return n.only ? has : !has;
}

/**
 * May a character walk a nav edge an Edge Passage runs through a Ladder (Edge Passage p0 = 0)?
 * [verified, Suffering.rfl] The setup (0x100d9520 -> 0x100a9670 / 0x100a96f0 / 0x100a9990)
 * gives both directions of the edge the passage kind 1 (Ladder vt +0xf8 = 0x100bee30) and the
 * enable bit: off both ways while the Ladder is locked; Ladder p34 = 1 closes nodeA -> nodeB,
 * 2 closes nodeB -> nodeA (0x100bf1a0). The A* neighbour filter (0x100d5c30 -> 0x100dbf30)
 * drops an edge whose kind bit is missing from the character's passage mask; bit 1 is set only
 * for a character with a LadderClimbBehavior (Character p102, behaviour id 0x59; mask
 * 0x100dc070). So a character without one never gets a path over a ladder (CartWheelers: p102
 * null); the edge is not walked up to and given up at.
 */
export function ladderEdgeOpen(o: { climber: boolean; unlocked: boolean; oneWay: number; forward: boolean }): boolean {
  if (!o.climber || !o.unlocked) return false;
  if (o.oneWay === 1) return !o.forward;
  if (o.oneWay === 2) return o.forward;
  return true;
}

/**
 * Doors (Switch uids) whose Edge Passage lets characters through while they are locked: Edge
 * Passage p4 = 1 [verified, Suffering.rfl: the Switch's passage kind 0x10130e50 asks its passage
 * 0x100a8d50 (p4 == 1) when the door is locked and then answers the unlocked kinds 2..5, which a
 * character with an OpenDoorBehavior passes; otherwise a locked door is kind 6 (destructible:
 * only OpenDoorBehavior p6 = 1, which breaks it) or 8 (nobody)]. Whose side the character is on
 * does not matter. Retail: 1a 4d99 / 8302 / 4e47, 1c 5262, 2 be4 / 24b8, 3a 4122.
 */
export function lockPassDoors(entities: readonly Entity[]): Set<number> {
  return new Set(entities.filter((e) => e.className === 'Edge Passage' && Number(e.values[4]) === 1).map((e) => Number(e.values[1])));
}

/** Which nodes an actor may use: floor walkers (default) or ceiling crawlers (both kinds). */
export type NavSurface = 'floor' | 'ceiling';

/** Nav edge types [verified 0x100da930]: 0 floor, 1 ceiling, 2 floor -> ceiling, 3 ceiling -> floor. */
export const EDGE = { floor: 0, ceiling: 1, up: 2, down: 3 } as const;

/** Type of the edge walked from a node of kind `from` to one of kind `to` (true = ceiling node). */
export function edgeTypeOf(from: boolean, to: boolean): number {
  return from ? (to ? EDGE.ceiling : EDGE.down) : to ? EDGE.up : EDGE.floor;
}

export class NavGraph {
  readonly nodes: NavNode[] = [];

  /**
   * `typeOf`: the type bit (0..30) of an NPC Exclusion Type template, else undefined; without it
   * the Move Nodes' exclusion lists are not read (every walker may use every node).
   */
  constructor(entities: Entity[], typeOf?: (r: { pkg: number; id: number }) => number | undefined) {
    const index = new Map<number, number>();
    for (const e of entities) {
      if (e.className !== 'Move Node Object') continue;
      const [x, y, z] = toOutputSpace(e.position);
      index.set(e.uid, this.nodes.length);
      this.byUid.set(e.uid, this.nodes.length);
      const node: NavNode = { uid: e.uid, x, y, z, radius: Math.max(0.5, (e.scale?.[0] ?? 1) * 0.5), edges: [], ceiling: e.values?.[0] === 1, size: e.scale?.[0] ?? 1, yaw: ((e.rotation?.[1] ?? 0) * Math.PI) / 180 };
      const list = e.values?.[2];
      let types = 0;
      if (typeOf)
        for (const r of Array.isArray(list) ? list : [list])
          if (r && typeof r === 'object' && 'id' in r) {
            const t = typeOf(r as { pkg: number; id: number });
            if (t !== undefined && t >= 0 && t <= 30) types |= 1 << t;
          }
      if (types) node.types = types;
      if (typeOf && e.values?.[3] === 1) node.only = true;
      this.nodes.push(node);
    }
    for (const e of entities) {
      const a = index.get(e.uid);
      if (a === undefined) continue;
      for (const l of e.links) {
        const b = index.get(l);
        if (b === undefined || b === a) continue;
        if (!this.nodes[a].edges.includes(b)) this.nodes[a].edges.push(b);
        if (!this.nodes[b].edges.includes(a)) this.nodes[b].edges.push(a);
      }
    }
  }

  get size() {
    return this.nodes.length;
  }

  /** Nodes with an NPC Exclusion Type list (built on first use). */
  private typed?: NavNode[];

  /**
   * Would a straight walk from (x0, z0) to (x1, z1) at height y cross the area of a node this
   * walker's type may not use? Then it must take the graph (actor.ts steer) [inferred: 2 Cellblocks
   * keeps the inmate's type 10:674 out of the cell block's ends (Move Nodes 9b4 / 9bd) and the
   * corridor behind door 3158 (a49), leaving him the cell e3 that switch 809 opens as his way to
   * the middle block; walked straight after the player he passed 9bd and could not path back].
   */
  crossesExcluded(x0: number, y: number, z0: number, x1: number, z1: number, navType: number): boolean {
    if (navType === NO_NAV_TYPE) return false;
    const typed = (this.typed ??= this.nodes.filter((n) => n.types || n.only));
    const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
    for (const n of typed) {
      if (Math.abs(n.y - y) > 2 || navNodePasses(n, navType)) continue;
      const t = Math.max(0, Math.min(1, ((n.x - x0) * dx + (n.z - z0) * dz) / L2));
      // The node's area: its scale in metres (the marker is a unit sphere scaled by the
      // instance) [inferred]; `radius` (half of it) is the port's arrival radius.
      if (Math.hypot(x0 + dx * t - n.x, z0 + dz * t - n.z) < 2 * n.radius + 0.3) return true;
    }
    return false;
  }

  /**
   * The floor edge FindPath puts a target point on [verified: global locate 0x100db660 ->
   * 0x100d87e0, FindPath's hint edge is -1, margin 0]: the first edge the walker may use whose area
   * holds the point (edgeHolds); when none does, the edge whose area outline is nearest
   * horizontally among those that failed, **the walker's type filter included** (0x100d5940): the
   * search never comes back empty while the graph has an edge, and its fallback may hand the walker
   * an edge it may not use. `passes`: whether the walker may use the edge found. The original
   * walks its grid cells outward from the point and stops at the first productive cell; the port
   * takes the nearest outline over all edges [inferred to agree]. Disabled edges (EdgeToggler) are
   * left out [inferred].
   */
  locateEdge(x: number, y: number, z: number, navType?: number): { a: number; b: number; held: boolean; passes: boolean } | null {
    let best: { a: number; b: number; held: boolean; passes: boolean } | null = null;
    let bd = Infinity;
    for (let a = 0; a < this.nodes.length; a++) {
      const A = this.nodes[a];
      if (A.ceiling) continue;
      for (const b of A.edges) {
        if (b < a || this.nodes[b].ceiling || !this.edgeEnabled(a, b)) continue;
        const B = this.nodes[b];
        const passes = navEdgePasses(A, B, navType);
        const held = edgeHolds(A, B, x, y, z);
        if (held && passes) return { a, b, held, passes };
        const d = outlineDistance(hull2([...squareCorners(A), ...squareCorners(B)]), x, z);
        if (d < bd) (bd = d), (best = { a, b, held, passes });
      }
    }
    return best;
  }

  /** Any ceiling node in the level (crawling creatures have somewhere to climb). */
  get hasCeiling() {
    return this.nodes.some((n) => n.ceiling);
  }

  /** Type of the edge walked from node a to node b (EDGE). */
  edgeType(a: number, b: number): number {
    return edgeTypeOf(this.nodes[a].ceiling, this.nodes[b].ceiling);
  }

  /**
   * Where a crawler changes surface on a transition edge (ceiling node c, floor node f):
   * horizontally, the middle of the stretch both node areas cover on the line between them
   * (the middle between the two circles when they do not overlap) [inferred: the original
   * places the transition point between the two node areas at load, 0x100db910].
   */
  transitionPoint(c: number, f: number): { x: number; z: number } {
    const C = this.nodes[c], F = this.nodes[f];
    const dx = F.x - C.x, dz = F.z - C.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return { x: C.x, z: C.z };
    const lo = Math.max(0, d - F.radius), hi = Math.min(d, C.radius);
    const s = lo <= hi ? (lo + hi) / 2 : (C.radius + d - F.radius) / 2;
    const k = Math.max(0, Math.min(d, s)) / d;
    return { x: C.x + dx * k, z: C.z + dz * k };
  }

  /** Disabled edges (EdgeToggler), as "lo:hi" node-index keys; both directions at once. */
  private disabled = new Set<string>();

  private static edgeKey(a: number, b: number) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  /** Enable / disable the edge between two Move Nodes (by level uid). False when there is no such edge. */
  setEdge(uidA: number, uidB: number, enabled: boolean): boolean {
    const a = this.byUid.get(uidA), b = this.byUid.get(uidB);
    if (a === undefined || b === undefined || !this.nodes[a].edges.includes(b)) return false;
    const k = NavGraph.edgeKey(a, b);
    if (enabled) this.disabled.delete(k);
    else this.disabled.add(k);
    return true;
  }

  /** True unless an EdgeToggler switched the edge (node indices) off. */
  edgeEnabled(a: number, b: number): boolean {
    return !this.disabled.size || !this.disabled.has(NavGraph.edgeKey(a, b));
  }

  /**
   * Nearest node to a feet position that can be reached in a straight line
   * (no wall between, similar floor height). Checks the `tries` closest nodes.
   * With `radius` a node a body of that radius can walk to straight (clearWide) is preferred:
   * a thin ray passes between the bars of an open gate leaf that the body cannot.
   * With `navType` (the walker's NPC Exclusion Type) nodes barred to it are not candidates: the
   * original places a point on the graph through the walker's own edge filter (locatesOn).
   * `goal`: a path's goal lies on the node whose area holds it (within its radius across, 1.5 m
   * up or down) before any sight line is asked: the original's lookup is the area test alone
   * (locatesOn) [the height window inferred]. 8b's walkway nodes 1e7f / 207f lie 1 m under the
   * floor of Hermes' doorway, so no sight line reached them from Jimmy's goal 1ea5 and the goal
   * went to 1e81 outside the door: he paced between the two.
   */
  nearest(x: number, y: number, z: number, world: CollisionWorld | null, tries = 6, radius = 0, surface: NavSurface = 'floor', navType?: number, goal = false): number {
    // Keep only the `tries` closest candidates (insertion into a tiny sorted list).
    const cand: { i: number; d: number }[] = [];
    const up = surface === 'ceiling';
    // Sight lines: at hip height over the floor, a little under a ceiling.
    const off = up ? -0.4 : 0.9;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.ceiling !== up) continue;
      if (!locatesOn(n, navType)) continue;
      const dy = Math.abs(n.y - y);
      if (dy > 6) continue;
      const d = Math.abs(n.x - x) + Math.abs(n.z - z) + dy * 2;
      if (cand.length === tries && d >= cand[tries - 1].d) continue;
      let k = cand.length < tries ? cand.length : tries - 1;
      cand[k] = { i, d };
      while (k > 0 && cand[k - 1].d > cand[k].d) [cand[k - 1], cand[k]] = [cand[k], cand[k - 1]], k--;
    }
    if (goal)
      for (let k = 0; k < Math.min(tries, cand.length); k++) {
        const n = this.nodes[cand[k].i];
        if (Math.hypot(n.x - x, n.z - z) <= n.radius && Math.abs(n.y - y) <= 1.5) return cand[k].i;
      }
    if (world && radius > 0) {
      // Over ground first: a start node across a drop is not walked to (groundAlong); then any
      // the body fits through to.
      let wide = -1;
      for (let k = 0; k < Math.min(tries, cand.length); k++) {
        const n = this.nodes[cand[k].i];
        if (!clearWide(world, x, y + off, z, n.x, n.y + off, n.z, radius)) continue;
        if (up || groundAlong(world, x, y, z, n.x, n.y, n.z, radius)) return cand[k].i;
        if (wide < 0) wide = cand[k].i;
      }
      if (wide >= 0) return wide;
    }
    for (let k = 0; k < Math.min(tries, cand.length); k++) {
      const n = this.nodes[cand[k].i];
      if (!world || clearLine(world, x, y + off, z, n.x, n.y + off, n.z)) return cand[k].i;
    }
    return cand.length ? cand[0].i : -1;
  }

  /** Node index by level uid. */
  readonly byUid = new Map<number, number>();

  /**
   * A* between node indices; returns node indices (inclusive) or null. `blocked` vetoes edges
   * (e.g. closed doors). Without `crawler` only floor nodes are used. With it every edge is,
   * and a transition edge costs its horizontal length: the climb itself is not charged
   * [inferred: transition edges get a length from the two node areas at load, 0x100db910].
   * `navType`: the walker's NPC Exclusion Type (NO_NAV_TYPE when it has none).
   */
  path(from: number, to: number, blocked?: (a: number, b: number) => boolean, opts?: { crawler?: boolean; navType?: number }): number[] | null {
    if (from < 0 || to < 0) return null;
    if (from === to) return [from];
    const N = this.nodes;
    const crawler = !!opts?.crawler;
    if (!crawler && (N[from].ceiling || N[to].ceiling)) return null;
    const g = new Map<number, number>([[from, 0]]);
    const came = new Map<number, number>();
    const h = crawler ? (i: number) => Math.hypot(N[i].x - N[to].x, N[i].z - N[to].z) : (i: number) => Math.hypot(N[i].x - N[to].x, N[i].y - N[to].y, N[i].z - N[to].z);
    const cost = (i: number, j: number) => (N[i].ceiling !== N[j].ceiling ? Math.hypot(N[i].x - N[j].x, N[i].z - N[j].z) : Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y, N[i].z - N[j].z));
    const open: { i: number; f: number }[] = [{ i: from, f: h(from) }];
    const closed = new Set<number>();
    while (open.length) {
      let best = 0;
      for (let k = 1; k < open.length; k++) if (open[k].f < open[best].f) best = k;
      const { i } = open.splice(best, 1)[0];
      if (i === to) {
        const out = [i];
        let c = i;
        while (came.has(c)) out.push((c = came.get(c)!));
        return out.reverse();
      }
      if (closed.has(i)) continue;
      closed.add(i);
      for (const j of N[i].edges) {
        if (closed.has(j) || !this.edgeEnabled(i, j) || blocked?.(i, j)) continue;
        if (!crawler && N[j].ceiling) continue;
        // NPC Exclusion Types (Move Node p2 / p3): the starting node is where it already stands.
        if ((N[j].types || N[j].only) && !navNodePasses(N[j], opts?.navType ?? NO_NAV_TYPE)) continue;
        const d = g.get(i)! + cost(i, j);
        if (d < (g.get(j) ?? Infinity)) {
          g.set(j, d);
          came.set(j, i);
          open.push({ i: j, f: d + h(j) });
        }
      }
      if (closed.size > 2000) break;
    }
    return null;
  }
}

/** Deepest drop under a straight walk that still counts as ground (m) [port]. */
export const STRAIGHT_WALK_DROP = 1.5;
/** Least up component of that ground's normal (60 degrees) [port]. */
export const STRAIGHT_WALK_SLOPE = 0.5;

/**
 * Ground all along a straight walk from feet (ax, ay, az) to feet (bx, by, bz): every 0.6 m (64
 * samples at most) rays down, on the line and `halfWidth` to either side, find a surface no more
 * than STRAIGHT_WALK_DROP under it, no steeper than STRAIGHT_WALK_SLOPE [port]. The original walks a MoveTo along the Move Node graph's edge areas (docs/game-logic.md
 * §15.5; locatesOn), which keep to the ground; the port's shortcuts off the graph (a straight
 * walk on a clear line: actor.ts clearLineCached; skipping ahead to a later path node; the start
 * node walked to: NavGraph.nearest) stand for that and must not leave it. 9's guard bc9, sent
 * from the first Inferna fight to the gate (Behavior Changer c5a -> WaypointBehavior c5b ->
 * Waypoint c63), walked the clear line from the north rim of the inlet south of the lighthouse
 * (326, 194) towards the gate, went down its rim and lay on the shore at (324.4, 84.5, 181.5),
 * 28 m down with no Move Node and no way back (runs t9b / d9; reproduced in a session).
 */
export function groundAlong(world: Pick<CollisionWorld, 'raycast'>, ax: number, ay: number, az: number, bx: number, by: number, bz: number, halfWidth = 0, maxDrop = STRAIGHT_WALK_DROP): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-3) return true;
  const n = Math.min(64, Math.ceil(len / 0.6));
  // Across the body's width: the walk's centre wanders off the line as the body turns onto it.
  const ox = (-(bz - az) / len) * halfWidth, oz = ((bx - ax) / len) * halfWidth;
  const sides = halfWidth > 0 ? [-1, 0, 1] : [0];
  const top = Math.max(ay, by) + 0.5;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const x = ax + (bx - ax) * k, y = ay + (by - ay) * k, z = az + (bz - az) * k;
    for (const s of sides) {
      // From over the higher end (a node can lie under the floor it stands for: 8b's 207f).
      const hit = world.raycast(x + ox * s, top, z + oz * s, 0, -1, 0, top - y + maxDrop);
      // Walkable: a steep rim the body would slide down is no ground either.
      if (!hit || (hit.normal && hit.normal[1] < STRAIGHT_WALK_SLOPE)) return false;
    }
  }
  return true;
}

/** True when nothing in the collision world blocks the segment a -> b. */
export function clearLine(world: CollisionWorld, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return true;
  const hit = world.raycast(ax, ay, az, dx / len, dy / len, dz / len, len);
  return !hit || hit.distance >= len - 0.05;
}

/**
 * clearLine for a body of radius r: the centre line and two lines offset sideways by r, plus a
 * sphere swept along the centre line (rays slip between the bars of a gate or a grate that the
 * body cannot pass). `ground`: the sphere meeting walkable ground (normal up >= 0.7, the floor of
 * stairs rising faster than the line) does not block.
 */
export function clearWide(world: CollisionWorld, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, ground = false): boolean {
  if (!clearLine(world, ax, ay, az, bx, by, bz)) return false;
  const dx = bx - ax, dz = bz - az;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return true;
  const ox = (-dz / l) * r, oz = (dx / l) * r;
  if (!clearLine(world, ax + ox, ay, az + oz, bx + ox, by, bz + oz) || !clearLine(world, ax - ox, ay, az - oz, bx - ox, by, bz - oz)) return false;
  const dy = by - ay, len = Math.hypot(dx, dy, dz);
  const hit = world.sphereCast(ax, ay, az, r * 0.7, dx, dy, dz, len);
  return !hit || hit.distance >= len - 0.05 || (ground && hit.normal[1] >= 0.7);
}
