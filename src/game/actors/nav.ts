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
      const node: NavNode = { uid: e.uid, x, y, z, radius: Math.max(0.5, (e.scale?.[0] ?? 1) * 0.5), edges: [], ceiling: e.values?.[0] === 1 };
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
   */
  nearest(x: number, y: number, z: number, world: CollisionWorld | null, tries = 6, radius = 0, surface: NavSurface = 'floor'): number {
    // Keep only the `tries` closest candidates (insertion into a tiny sorted list).
    const cand: { i: number; d: number }[] = [];
    const up = surface === 'ceiling';
    // Sight lines: at hip height over the floor, a little under a ceiling.
    const off = up ? -0.4 : 0.9;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.ceiling !== up) continue;
      const dy = Math.abs(n.y - y);
      if (dy > 6) continue;
      const d = Math.abs(n.x - x) + Math.abs(n.z - z) + dy * 2;
      if (cand.length === tries && d >= cand[tries - 1].d) continue;
      let k = cand.length < tries ? cand.length : tries - 1;
      cand[k] = { i, d };
      while (k > 0 && cand[k - 1].d > cand[k].d) [cand[k - 1], cand[k]] = [cand[k], cand[k - 1]], k--;
    }
    if (world && radius > 0) {
      for (let k = 0; k < Math.min(tries, cand.length); k++) {
        const n = this.nodes[cand[k].i];
        if (clearWide(world, x, y + off, z, n.x, n.y + off, n.z, radius)) return cand[k].i;
      }
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
