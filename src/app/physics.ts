// Static-world collision for walking through levels.
//
// CollisionWorld flattens the level's triangles (optionally filtered per
// MeshPart) into a binned-SAH bounding volume hierarchy and answers:
//   - raycast(origin, dir, maxDist)               nearest triangle hit
//   - sphereCast(origin, radius, dir, maxDist)    continuous swept-sphere TOI
//   - capsuleOverlap / resolveCapsule             push a capsule out of geometry
//   - moveCapsule(...)                             substepped move-and-slide
//   - groundQuery(feet, radius, maxDrop)           what is under a point
//
// Everything is plain typed arrays + scalar math (no THREE dependency, no
// allocations in the hot paths) so it also runs in Node for tests and could be
// moved into a Web Worker unchanged. Triangles are treated as double-sided:
// the game's world geometry is rendered double-sided and has many single
// planes (fences, cell bars, walls seen from both sides).
//
// Units: LevelData space (Y up, ~1 unit = 1 m).

import type { LevelData, MeshPart } from '../formats/types';

/** Return false to make a part non-colliding (foliage, decals, cables...). */
export type PartFilter = (part: MeshPart, index: number) => boolean;

export interface CollisionWorldOptions {
  filter?: PartFilter;
  /** Max triangles per BVH leaf (default 4). */
  leafSize?: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface RayHit {
  /** Distance along the (normalised) direction. */
  distance: number;
  point: [number, number, number];
  /** Geometric triangle normal, flipped to face the query origin. */
  normal: [number, number, number];
  /** Triangle index (into CollisionWorld order) and its source part index. */
  triangle: number;
  part: number;
  /** Set when the hit is on a dynamic body (see CollisionWorld.addDynamic); triangle/part are then body-local. */
  dynamic?: number;
}

/** Geometry for a dynamic collision body (world space, LevelData units). */
export type DynamicParts = Pick<MeshPart, 'positions' | 'indices'>[];

/**
 * Layers of dynamic bodies (addDynamic `layers`) and of queries (CollisionWorld.queryLayers): a
 * query sees a body when they share a bit. Ordinary geometry is `solid` and every query includes
 * `solid`. The other bits are the original's per-mover filters of Invisible Static Object
 * (Suffering.rfl 0x100bc9d0, docs/game-logic.md §14.7): an invisible box with only `player`
 * stops the player's movement and nothing else (not NPCs, shots, sight or the use ray).
 */
export const COLLISION_LAYER = {
  solid: 1,
  /** The Player (ISO p1). */
  player: 2,
  /** ISO p2 (movers whose engine object +0xe4 is 7). No port mover queries it (§14.7). */
  character: 4,
  /** Pushables (ISO p3). */
  pushable: 8,
  /** Missiles, BouncingObjects, Lightning (ISO p5). */
  projectile: 16,
  /**
   * Static geometry of a class no mover's collide list names (MeshPart.moveSolid false:
   * Decorations). The plain queries (sight, shots, the use ray) see it; a CharacterMotor's do not
   * (its layers are `solid` plus its own), docs/game-logic.md §14.9.
   */
  decor: 32,
  /**
   * Carried by the outdoor Landscape's triangles (parts with floor layers) besides `solid`: the
   * NPC ground follower's Landscape fallback asks for it alone (CharacterMotor 'centre' probe).
   */
  landscape: 64,
} as const;

export interface SweepHit extends RayHit {
  /** For sphere casts: the sphere centre at the time of impact. */
  center: [number, number, number];
}

export interface GroundHit {
  /** Height of the supporting surface under the query point. */
  height: number;
  normal: [number, number, number];
  /** normal.y >= cos(slope limit) */
  walkable: boolean;
  /** Distance the probe travelled down before touching. */
  drop: number;
  part: number;
}

/** A vertical capsule: segment from (x, y0, z) to (x, y1, z), radius r. */
export interface Capsule {
  x: number;
  z: number;
  /** Centre of the bottom hemisphere. */
  y0: number;
  /** Centre of the top hemisphere (>= y0). */
  y1: number;
  r: number;
}

export interface MoveResult {
  /** Contact normals hit while moving (up to 8), xyz packed. */
  contacts: number;
  hitCeiling: boolean;
  hitWall: boolean;
  /** Any contact whose normal is walkable (floor-like). */
  hitFloor: boolean;
  /** Final displacement actually applied. */
  dx: number;
  dy: number;
  dz: number;
}

export interface BuildStats {
  triangles: number;
  nodes: number;
  depth: number;
  ms: number;
  skippedParts: number;
}

const EPS = 1e-7;

interface DynamicBody {
  id: number;
  world: CollisionWorld;
  enabled: boolean;
  /** COLLISION_LAYER bits. */
  layers: number;
}

export class CollisionWorld {
  /** 9 floats per triangle, BVH order. */
  readonly tris: Float32Array;
  /** Unit normals, 3 per triangle. */
  readonly normals: Float32Array;
  /** Source part index per triangle. */
  readonly triPart: Uint32Array;
  /** COLLISION_LAYER bits per triangle: `solid` (+ `landscape`), or `decor`. */
  readonly triLayers: Uint8Array;
  /** Node AABBs: minx, miny, minz, maxx, maxy, maxz. */
  private readonly nodeBox: Float32Array;
  /** Node data: leaf [firstTri, count]; inner [left, INNER | right]. */
  private readonly nodeData: Uint32Array;
  readonly stats: BuildStats;
  readonly bounds: { min: [number, number, number]; max: [number, number, number] };

  // Scratch buffers for queries (avoid per-call allocation).
  private stack = new Uint32Array(128);
  private candidates = new Uint32Array(1024);

  /**
   * Dynamic layer: small separately-built bodies (doors, movable props) that can be
   * switched on/off or rebuilt without touching the static BVH. Every public query
   * (raycast, sphereCast, groundQuery, capsuleOverlaps, resolveCapsule, moveCapsule)
   * includes the enabled bodies.
   */
  private dynamics = new Map<number, DynamicBody>();
  /**
   * The same bodies as a dense array, for the per-query loops: iterating the Map's entries
   * allocated an entry per body per query (with hundreds of prop bodies and many sweeps a frame
   * that was ~30 MB/s of garbage and 50-100 ms collector pauses; docs/game-logic.md §18).
   */
  private dynamicList: DynamicBody[] = [];
  private nextDynamicId = 1;
  /**
   * Layers the queries see (COLLISION_LAYER): `solid` unless a mover widens it for its own
   * queries (CharacterMotor.layers, restored after its step).
   */
  queryLayers: number = COLLISION_LAYER.solid | COLLISION_LAYER.decor;

  constructor(level: Pick<LevelData, 'parts'>, opts: CollisionWorldOptions = {}) {
    const t0 = now();
    const filter = opts.filter;
    const leafSize = Math.max(1, opts.leafSize ?? 4);

    // Count triangles of included parts.
    let total = 0;
    let skipped = 0;
    const include = level.parts.map((p, i) => {
      const ok = !!p.indices.length && p.solid !== false && !lightOnly(p) && (!filter || filter(p, i));
      if (ok) total += Math.floor(p.indices.length / 3);
      else skipped++;
      return ok;
    });

    // Gather triangles (drop degenerate ones), their AABB centroids and bounds.
    const raw = new Float32Array(total * 9);
    const rawPart = new Uint32Array(total);
    let n = 0;
    for (let pi = 0; pi < level.parts.length; pi++) {
      if (!include[pi]) continue;
      const { positions: P, indices: I } = level.parts[pi];
      for (let k = 0; k + 2 < I.length; k += 3) {
        const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2];
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const cx = P[c], cy = P[c + 1], cz = P[c + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const area2 = nx * nx + ny * ny + nz * nz;
        if (!(area2 > 1e-14)) continue; // degenerate or NaN
        const o = 9 * n;
        raw[o] = ax; raw[o + 1] = ay; raw[o + 2] = az;
        raw[o + 3] = bx; raw[o + 4] = by; raw[o + 5] = bz;
        raw[o + 6] = cx; raw[o + 7] = cy; raw[o + 8] = cz;
        rawPart[n] = pi;
        n++;
      }
    }

    const { order, nodeBox, nodeData, depth } = buildBvh(raw, n, leafSize);
    this.nodeBox = nodeBox;
    this.nodeData = nodeData;

    // Reorder triangles into leaf order for locality.
    this.tris = new Float32Array(n * 9);
    this.normals = new Float32Array(n * 3);
    this.triPart = new Uint32Array(n);
    this.triLayers = new Uint8Array(n);
    const partLayers = level.parts.map((p) =>
      p.moveSolid === false ? COLLISION_LAYER.decor : p.splat?.length ? COLLISION_LAYER.solid | COLLISION_LAYER.landscape : COLLISION_LAYER.solid,
    );
    for (let i = 0; i < n; i++) {
      const s = 9 * order[i], d = 9 * i;
      for (let k = 0; k < 9; k++) this.tris[d + k] = raw[s + k];
      this.triPart[i] = rawPart[order[i]];
      this.triLayers[i] = partLayers[this.triPart[i]];
      const T = this.tris;
      const ux = T[d + 3] - T[d], uy = T[d + 4] - T[d + 1], uz = T[d + 5] - T[d + 2];
      const vx = T[d + 6] - T[d], vy = T[d + 7] - T[d + 1], vz = T[d + 8] - T[d + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      this.normals[3 * i] = nx; this.normals[3 * i + 1] = ny; this.normals[3 * i + 2] = nz;
    }

    this.bounds =
      n > 0
        ? { min: [nodeBox[0], nodeBox[1], nodeBox[2]], max: [nodeBox[3], nodeBox[4], nodeBox[5]] }
        : { min: [0, 0, 0], max: [0, 0, 0] };
    this.stats = { triangles: n, nodes: nodeData.length / 2, depth, ms: now() - t0, skippedParts: skipped };
    if (this.stack.length < depth + 8) this.stack = new Uint32Array(depth + 64);
  }

  get triangleCount() {
    return this.tris.length / 9;
  }

  // -------------------------------------------------------------------------
  // Dynamic bodies

  /** Add a dynamic body from world-space triangles. Returns its id. `layers`: COLLISION_LAYER bits. */
  addDynamic(parts: DynamicParts, enabled = true, layers: number = COLLISION_LAYER.solid): number {
    const id = this.nextDynamicId++;
    const body: DynamicBody = { id, world: new CollisionWorld({ parts: parts as MeshPart[] }), enabled, layers };
    this.dynamics.set(id, body);
    this.dynamicList.push(body);
    return id;
  }

  /** Replace a body's geometry (e.g. after the object moved); keeps its enabled state. */
  updateDynamic(id: number, parts: DynamicParts) {
    const d = this.dynamics.get(id);
    if (d) d.world = new CollisionWorld({ parts: parts as MeshPart[] });
  }

  setDynamicEnabled(id: number, enabled: boolean) {
    const d = this.dynamics.get(id);
    if (d) d.enabled = enabled;
  }

  isDynamicEnabled(id: number): boolean {
    return !!this.dynamics.get(id)?.enabled;
  }

  removeDynamic(id: number) {
    const body = this.dynamics.get(id);
    this.dynamics.delete(id);
    if (body) this.dynamicList.splice(this.dynamicList.indexOf(body), 1);
  }

  /** World-space AABB of a dynamic body (undefined if unknown or empty). */
  dynamicBounds(id: number) {
    const d = this.dynamics.get(id);
    return d && d.world.triangleCount ? d.world.bounds : undefined;
  }

  private static boxOverlap(
    b: { min: [number, number, number]; max: [number, number, number] },
    minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number,
  ) {
    return !(b.min[0] > maxx || b.max[0] < minx || b.min[1] > maxy || b.max[1] < miny || b.min[2] > maxz || b.max[2] < minz);
  }

  // -------------------------------------------------------------------------
  // Broad phase

  /**
   * Static triangles whose AABB overlaps the box (indices into `tris` / `triPart`), copied out.
   * Used by decal projection (src/game/fx/decals.ts). Dynamic bodies are not included.
   */
  trianglesInBox(minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number): Uint32Array {
    return this.candidates.slice(0, this.queryBox(minx, miny, minz, maxx, maxy, maxz));
  }

  /**
   * Collect triangle indices whose node AABB overlaps the box. Returns the
   * count; indices are in `this.candidates` (valid until the next query).
   */
  private queryBox(minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number): number {
    const B = this.nodeBox, D = this.nodeData;
    if (!D.length) return 0;
    let found = 0;
    let sp = 0;
    const stack = this.stack;
    stack[sp++] = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const o = 6 * i;
      if (B[o] > maxx || B[o + 3] < minx || B[o + 1] > maxy || B[o + 4] < miny || B[o + 2] > maxz || B[o + 5] < minz)
        continue;
      const count = D[2 * i + 1];
      if (count & INNER) {
        stack[sp++] = D[2 * i];
        stack[sp++] = (count & ~INNER) >>> 0;
      } else {
        const first = D[2 * i];
        if (found + count > this.candidates.length) {
          const grown = new Uint32Array(this.candidates.length * 2);
          grown.set(this.candidates);
          this.candidates = grown;
        }
        const T = this.tris, TL = this.triLayers, QL = this.queryLayers;
        for (let t = first; t < first + count; t++) {
          if (!(TL[t] & QL)) continue;
          // Per-triangle AABB reject.
          const p = 9 * t;
          const tminx = Math.min(T[p], T[p + 3], T[p + 6]);
          if (tminx > maxx) continue;
          const tmaxx = Math.max(T[p], T[p + 3], T[p + 6]);
          if (tmaxx < minx) continue;
          const tminy = Math.min(T[p + 1], T[p + 4], T[p + 7]);
          if (tminy > maxy) continue;
          const tmaxy = Math.max(T[p + 1], T[p + 4], T[p + 7]);
          if (tmaxy < miny) continue;
          const tminz = Math.min(T[p + 2], T[p + 5], T[p + 8]);
          if (tminz > maxz) continue;
          const tmaxz = Math.max(T[p + 2], T[p + 5], T[p + 8]);
          if (tmaxz < minz) continue;
          this.candidates[found++] = t;
        }
      }
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Ray cast

  /** Nearest hit along a ray (dir need not be normalised). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist = Infinity): RayHit | null {
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) return null;
    dx /= len; dy /= len; dz /= len;
    return this.sweep(ox, oy, oz, dx, dy, dz, maxDist, 0);
  }

  /**
   * The engine's object segment test as the BouncingObject sweep uses it [verified: Suffering.rfl
   * 0x100ceff0 -> 0x100c6630 -> 0x100c5c70 -> collision interface vt+0x24 (SUFFERING.EXE
   * 0x4283c0 -> 0x4276b0 -> 0x424b20 -> 0x4249f0 -> 0x4dd290), docs/game-logic.md §14.2]: the
   * segment from `o` to `e` against FRONT faces only (the caller passes no back-face flag, so the
   * Moller-Trumbore test keeps det >= eps: the segment runs against the triangle's own normal, the
   * front of the port's counter-clockwise winding), every triangle grown in its plane by `grow`
   * (0x4dd540 pushes its edges out by the sweep radius) [growth construction inferred: a homothety
   * about the incentre]. Static triangles and the enabled dynamic bodies `queryLayers` sees; the
   * nearest hit, with the triangle's own normal.
   */
  frontSegmentCast(ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, grow = 0): RayHit | null {
    const dx = ex - ox, dy = ey - oy, dz = ez - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) return null;
    const best = { t: 1, hit: null as RayHit | null };
    const test = (w: CollisionWorld, dynamic?: number) => {
      const n = w.queryBox(Math.min(ox, ex) - grow, Math.min(oy, ey) - grow, Math.min(oz, ez) - grow, Math.max(ox, ex) + grow, Math.max(oy, ey) + grow, Math.max(oz, ez) + grow);
      const T = w.tris, N = w.normals;
      for (let c = 0; c < n; c++) {
        const t = w.candidates[c];
        const nx = N[3 * t], ny = N[3 * t + 1], nz = N[3 * t + 2];
        const dn = dx * nx + dy * ny + dz * nz;
        if (dn >= -1e-12) continue; // back face or parallel: not hit
        let ax = T[9 * t], ay = T[9 * t + 1], az = T[9 * t + 2];
        let bx = T[9 * t + 3], by = T[9 * t + 4], bz = T[9 * t + 5];
        let cx = T[9 * t + 6], cy = T[9 * t + 7], cz = T[9 * t + 8];
        if (grow > 0) {
          const la = Math.hypot(bx - cx, by - cy, bz - cz), lb = Math.hypot(cx - ax, cy - ay, cz - az), lc = Math.hypot(ax - bx, ay - by, az - bz);
          const per = la + lb + lc;
          const area2 = Math.hypot((by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
          if (per < EPS || area2 < EPS) continue;
          const ix = (la * ax + lb * bx + lc * cx) / per, iy = (la * ay + lb * by + lc * cy) / per, iz = (la * az + lb * bz + lc * cz) / per;
          const k = 1 + grow / (area2 / per);
          ax = ix + (ax - ix) * k; ay = iy + (ay - iy) * k; az = iz + (az - iz) * k;
          bx = ix + (bx - ix) * k; by = iy + (by - iy) * k; bz = iz + (bz - iz) * k;
          cx = ix + (cx - ix) * k; cy = iy + (cy - iy) * k; cz = iz + (cz - iz) * k;
        }
        const s = ((ax - ox) * nx + (ay - oy) * ny + (az - oz) * nz) / dn;
        if (s < 0 || s > best.t) continue;
        const px = ox + dx * s, py = oy + dy * s, pz = oz + dz * s;
        const side = (ux: number, uy: number, uz: number, vx: number, vy: number, vz: number) =>
          ((uy - vy) * (pz - vz) - (uz - vz) * (py - vy)) * nx + ((uz - vz) * (px - vx) - (ux - vx) * (pz - vz)) * ny + ((ux - vx) * (py - vy) - (uy - vy) * (px - vx)) * nz;
        if (side(bx, by, bz, ax, ay, az) < 0 || side(cx, cy, cz, bx, by, bz) < 0 || side(ax, ay, az, cx, cy, cz) < 0) continue;
        best.t = s;
        best.hit = { distance: s * len, point: [px, py, pz], normal: [nx, ny, nz], triangle: t, part: w.triPart[t], ...(dynamic !== undefined ? { dynamic } : {}) };
      }
    };
    test(this);
    for (const d of this.dynamicList) if (d.enabled && d.layers & this.queryLayers && d.world.triangleCount) test(d.world, d.id);
    return best.hit;
  }

  /**
   * Continuous swept sphere: first contact of a sphere of `radius` moving from
   * origin along dir for up to maxDist. A sphere already overlapping geometry
   * reports distance 0. radius 0 is a ray cast.
   */
  sphereCast(
    ox: number, oy: number, oz: number,
    radius: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): SweepHit | null {
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) return null;
    dx /= len; dy /= len; dz /= len;
    return this.sweep(ox, oy, oz, dx, dy, dz, maxDist, radius);
  }

  private sweep(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number, r: number,
  ): SweepHit | null {
    let hit = this.sweepStatic(ox, oy, oz, dx, dy, dz, maxDist, r);
    if (!this.dynamics.size) return hit;
    let best = hit ? hit.distance : maxDist;
    const list = this.dynamicList;
    for (let k = 0; k < list.length; k++) {
      const d = list[k];
      if (!d.enabled || !(d.layers & this.queryLayers) || !d.world.triangleCount) continue;
      if (Number.isFinite(best)) {
        const ex = ox + dx * best, ey = oy + dy * best, ez = oz + dz * best;
        if (!CollisionWorld.boxOverlap(d.world.bounds,
          Math.min(ox, ex) - r, Math.min(oy, ey) - r, Math.min(oz, ez) - r,
          Math.max(ox, ex) + r, Math.max(oy, ey) + r, Math.max(oz, ez) + r)) continue;
      }
      const h = d.world.sweepStatic(ox, oy, oz, dx, dy, dz, best, r);
      if (h && h.distance < best) {
        best = h.distance;
        h.dynamic = d.id;
        hit = h;
      }
    }
    return hit;
  }

  private sweepStatic(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number, r: number,
  ): SweepHit | null {
    const B = this.nodeBox, D = this.nodeData, T = this.tris;
    if (!D.length) return null;
    const idx = 1 / (dx === 0 ? 1e-30 : dx), idy = 1 / (dy === 0 ? 1e-30 : dy), idz = 1 / (dz === 0 ? 1e-30 : dz);
    let best = Number.isFinite(maxDist) ? maxDist : 1e30;
    let bestTri = -1;
    let hx = 0, hy = 0, hz = 0; // contact point
    let sp = 0;
    const stack = this.stack;
    stack[sp++] = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const o = 6 * i;
      // Slab test against the node box inflated by r.
      let t1 = (B[o] - r - ox) * idx, t2 = (B[o + 3] + r - ox) * idx;
      let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
      t1 = (B[o + 1] - r - oy) * idy; t2 = (B[o + 4] + r - oy) * idy;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
      t1 = (B[o + 2] - r - oz) * idz; t2 = (B[o + 5] + r - oz) * idz;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
      if (tmax < Math.max(tmin, 0) || tmin > best) continue;
      const count = D[2 * i + 1];
      if (count & INNER) {
        // Visit the nearer child first (by child box entry along the ray).
        const l = D[2 * i], rr = (count & ~INNER) >>> 0;
        const dl = entry(B, l, ox, oy, oz, idx, idy, idz, r);
        const drr = entry(B, rr, ox, oy, oz, idx, idy, idz, r);
        if (dl < drr) {
          stack[sp++] = rr;
          stack[sp++] = l;
        } else {
          stack[sp++] = l;
          stack[sp++] = rr;
        }
      } else {
        const first = D[2 * i];
        const TL = this.triLayers, QL = this.queryLayers;
        for (let t = first; t < first + count; t++) {
          if (!(TL[t] & QL)) continue;
          const p = 9 * t;
          const hit =
            r === 0
              ? rayTri(ox, oy, oz, dx, dy, dz, T, p, best)
              : sphereTri(ox, oy, oz, dx, dy, dz, r, T, p, best, SWEEP_OUT);
          if (hit >= 0 && hit < best) {
            best = hit;
            bestTri = t;
            if (r === 0) {
              hx = ox + dx * hit; hy = oy + dy * hit; hz = oz + dz * hit;
            } else {
              hx = SWEEP_OUT[0]; hy = SWEEP_OUT[1]; hz = SWEEP_OUT[2];
            }
          }
        }
      }
    }
    if (bestTri < 0) return null;
    const cx = ox + dx * best, cy = oy + dy * best, cz = oz + dz * best;
    let nx: number, ny: number, nz: number;
    if (r === 0) {
      nx = this.normals[3 * bestTri]; ny = this.normals[3 * bestTri + 1]; nz = this.normals[3 * bestTri + 2];
      if (nx * dx + ny * dy + nz * dz > 0) (nx = -nx), (ny = -ny), (nz = -nz);
    } else {
      // Contact normal = from contact point to sphere centre (handles edges/vertices).
      nx = cx - hx; ny = cy - hy; nz = cz - hz;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-6) (nx /= l), (ny /= l), (nz /= l);
      else {
        nx = this.normals[3 * bestTri]; ny = this.normals[3 * bestTri + 1]; nz = this.normals[3 * bestTri + 2];
        if (nx * dx + ny * dy + nz * dz > 0) (nx = -nx), (ny = -ny), (nz = -nz);
      }
    }
    return {
      distance: best,
      point: [hx, hy, hz],
      normal: [nx, ny, nz],
      center: [cx, cy, cz],
      triangle: bestTri,
      part: this.triPart[bestTri],
    };
  }

  // -------------------------------------------------------------------------
  // Ground

  /**
   * Probe straight down from `from` (e.g. a point just above the feet) with a
   * sphere of `radius`, up to `maxDrop`. Returns the support height (the
   * height the feet should be at), the contact normal and whether the surface
   * counts as walkable for `slopeLimitDeg`.
   *
   * Sphere contacts on stair edges report a tilted normal; in that case a ray
   * straight down is used to decide walkability, so stair edges stay walkable.
   */
  groundQuery(x: number, y: number, z: number, radius: number, maxDrop: number, slopeLimitDeg = 50): GroundHit | null {
    const cosLimit = Math.cos((slopeLimitDeg * Math.PI) / 180);
    const hit = this.sphereCast(x, y + radius, z, radius, 0, -1, 0, maxDrop);
    if (!hit) return null;
    let n = hit.normal;
    let height = hit.center[1] - radius;
    let walkable = n[1] >= cosLimit;
    if (!walkable) {
      // Edge contact (stair nose, ledge): look at the surface just past the
      // edge, on the far side from the probe centre. If that's walkable, we
      // stand on the edge at its height.
      const px = hit.point[0], pz = hit.point[2];
      let ex = px - x, ez = pz - z;
      const el = Math.hypot(ex, ez);
      if (el > 1e-4) {
        ex /= el; ez /= el;
        const down = this.raycast(px + ex * 0.02, hit.point[1] + 0.05, pz + ez * 0.02, 0, -1, 0, 0.1);
        if (down && down.normal[1] >= cosLimit) {
          n = down.normal;
          height = Math.max(height, down.point[1]);
          walkable = true;
        }
      }
    }
    return {
      height,
      normal: n,
      walkable,
      drop: hit.distance,
      part: hit.part,
    };
  }

  // -------------------------------------------------------------------------
  // Capsule overlap / depenetration

  /** True if the capsule overlaps any triangle (by more than `skin`). */
  capsuleOverlaps(c: Capsule, skin = 0.001): boolean {
    const r = c.r - skin;
    const n = this.queryBox(c.x - r, c.y0 - r, c.z - r, c.x + r, c.y1 + r, c.z + r);
    const T = this.tris;
    for (let k = 0; k < n; k++) {
      const p = 9 * this.candidates[k];
      if (segTriDist2(c.x, c.y0, c.z, c.y1 - c.y0, T, p, CLOSEST) < r * r) return true;
    }
    for (const d of this.dynamicList) {
      if (!d.enabled || !(d.layers & this.queryLayers) || !d.world.triangleCount) continue;
      if (!CollisionWorld.boxOverlap(d.world.bounds, c.x - r, c.y0 - r, c.z - r, c.x + r, c.y1 + r, c.z + r)) continue;
      if (d.world.capsuleOverlaps(c, skin)) return true;
    }
    return false;
  }

  /**
   * Push a capsule out of the geometry. Contacts with walkable normals can be
   * resolved purely vertically (`verticalOnWalkable`) so standing on slopes
   * doesn't make the capsule creep downhill. Velocity (if given) loses its
   * component into each contact. Returns flags of contacts made.
   */
  resolveCapsule(
    c: Capsule,
    vel: Vec3Like | null,
    cosSlope: number,
    iterations = 4,
    verticalOnWalkable = false,
    out?: MoveResult,
    flattenLow = false,
  ): MoveResult {
    const res = this.resolveCapsuleStatic(c, vel, cosSlope, iterations, verticalOnWalkable, out, flattenLow);
    if (!this.dynamics.size) return res;
    const m = c.r + 0.05;
    for (const d of this.dynamicList) {
      if (!d.enabled || !(d.layers & this.queryLayers) || !d.world.triangleCount) continue;
      if (!CollisionWorld.boxOverlap(d.world.bounds, c.x - m, c.y0 - m, c.z - m, c.x + m, c.y1 + m, c.z + m)) continue;
      d.world.resolveCapsuleStatic(c, vel, cosSlope, iterations, verticalOnWalkable, res, flattenLow);
    }
    return res;
  }

  private resolveCapsuleStatic(
    c: Capsule,
    vel: Vec3Like | null,
    cosSlope: number,
    iterations = 4,
    verticalOnWalkable = false,
    out?: MoveResult,
    flattenLow = false,
  ): MoveResult {
    const res = out ?? emptyMove();
    const r = c.r;
    const T = this.tris;
    const margin = r + 0.05;
    const n = this.queryBox(c.x - margin, c.y0 - margin, c.z - margin, c.x + margin, c.y1 + margin, c.z + margin);
    if (!n) return res;
    for (let it = 0; it < iterations; it++) {
      let any = false;
      for (let k = 0; k < n; k++) {
        const tri = this.candidates[k];
        const p = 9 * tri;
        const d2 = segTriDist2(c.x, c.y0, c.z, c.y1 - c.y0, T, p, CLOSEST);
        if (d2 >= r * r) continue;
        // CLOSEST: segment point (0..2), triangle point (3..5)
        let nx = CLOSEST[0] - CLOSEST[3], ny = CLOSEST[1] - CLOSEST[4], nz = CLOSEST[2] - CLOSEST[5];
        let d = Math.sqrt(d2);
        if (d > 1e-6) {
          nx /= d; ny /= d; nz /= d;
        } else {
          // Segment passes through the triangle: push along the face normal,
          // towards the side the capsule centre is on.
          nx = this.normals[3 * tri]; ny = this.normals[3 * tri + 1]; nz = this.normals[3 * tri + 2];
          const mx = c.x - T[p], my = (c.y0 + c.y1) * 0.5 - T[p + 1], mz = c.z - T[p + 2];
          if (mx * nx + my * ny + mz * nz < 0) (nx = -nx), (ny = -ny), (nz = -nz);
          d = 0;
        }
        let depth = r - d + 1e-4;
        any = true;
        if (flattenLow && ny > 0 && CLOSEST[4] < c.y0) {
          // Contact under the bottom hemisphere's centre: don't let it lift
          // the capsule (stepping is the ground probe's job); push sideways.
          const hl = Math.hypot(nx, nz);
          if (hl > 0.05) {
            depth = Math.min(depth / hl, r);
            nx /= hl; nz /= hl; ny = 0;
          }
        }
        if (ny >= cosSlope) {
          res.hitFloor = true;
          if (verticalOnWalkable) {
            const up = Math.min(depth / ny, r);
            c.y0 += up; c.y1 += up;
            if (vel && vel.y < 0) vel.y = 0;
            pushContact(res, 0, 1, 0);
            continue;
          }
        } else if (ny < -0.3) res.hitCeiling = true;
        else res.hitWall = true;
        c.x += nx * depth; c.y0 += ny * depth; c.y1 += ny * depth; c.z += nz * depth;
        if (vel) {
          const vn = vel.x * nx + vel.y * ny + vel.z * nz;
          if (vn < 0) {
            vel.x -= nx * vn; vel.y -= ny * vn; vel.z -= nz * vn;
          }
        }
        pushContact(res, nx, ny, nz);
      }
      if (!any) break;
    }
    return res;
  }

  /**
   * Move a capsule by (dx, dy, dz), sliding along geometry. The move is
   * substepped so no substep exceeds half the radius (no tunnelling through
   * thin walls); each substep depenetrates. The capsule is updated in place.
   */
  moveCapsule(
    c: Capsule,
    dx: number, dy: number, dz: number,
    vel: Vec3Like | null,
    cosSlope: number,
    verticalOnWalkable = false,
    /** Contacts below the bottom sphere centre push only sideways (grounded movement). */
    flattenLow = false,
  ): MoveResult {
    const res = emptyMove();
    const sx = c.x, sy = c.y0, sz = c.z;
    const dist = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(dist / (c.r * 0.5)));
    // Remaining motion is re-projected against contacts as we go (slide).
    let mx = dx / steps, my = dy / steps, mz = dz / steps;
    for (let s = 0; s < steps; s++) {
      c.x += mx; c.y0 += my; c.y1 += my; c.z += mz;
      const before = res.contacts;
      this.resolveCapsule(c, vel, cosSlope, 4, verticalOnWalkable, res, flattenLow);
      // Clip the remaining per-step motion against new contact normals.
      for (let k = before; k < res.contacts && k < 8; k++) {
        const nx = CONTACTS[3 * k], ny = CONTACTS[3 * k + 1], nz = CONTACTS[3 * k + 2];
        const d = mx * nx + my * ny + mz * nz;
        if (d < 0) {
          mx -= nx * d; my -= ny * d; mz -= nz * d;
        }
      }
    }
    res.dx = c.x - sx;
    res.dy = c.y0 - sy;
    res.dz = c.z - sz;
    return res;
  }

  /** Recently recorded contact normals from the last moveCapsule/resolveCapsule call. */
  contactNormal(i: number): [number, number, number] {
    return [CONTACTS[3 * i], CONTACTS[3 * i + 1], CONTACTS[3 * i + 2]];
  }
}

// ---------------------------------------------------------------------------
// Default collision filter (pluggable): everything collides for now.

export const collideEverything: PartFilter = () => true;

/**
 * Surfaces that only add light (every layer additive, blend 2 = src x a + dst, and not writing
 * depth: light shafts, glows) are not solid. 1b's arena has a sloped light shaft (Advanced
 * Material 9:5841, blend 2, no depth write) across the Move Node edges 727b / 7280 -> 727c that
 * creatures path along; colliding with it stopped them there.
 * Blend 7 (src + dst x srcAlpha) is not light: the texture's alpha hides what is behind, a
 * see-through surface such as glass. Its retail uses are the glass panes (Layered 7:1823 /
 * 29:447 over Game Material Properties 6:35, hardness 1, with a reflection layer) and 5b's
 * glass lobby floor (29:571 on models 28:278 / 28:285, whose collision record is a flat 1 mm
 * box at the glass: walls and door sills stand on it, the basement shows through) [data]. Taken
 * for light, the lobby floor let the player fall 1 m onto the basement's wall tops, under the
 * door sills, and no door of the lobby could be used.
 */
export function lightOnly(p: Pick<MeshPart, 'material'>): boolean {
  const layers = p.material?.layers;
  return !!layers?.length && layers.every((l) => l.blend === 2 && !l.depthWrite);
}

/**
 * Opt-in heuristic: skip parts whose diffuse texture is mostly cut-out alpha
 * (tree canopies, bushes, hanging moss...). `maxCutout` is the fraction of
 * texels with alpha < 128 above which a part stops colliding. Chain-link
 * fences and grates are also cut-out textures, so this is deliberately not
 * the default until the real collision flags are decoded.
 */
export function cutoutAlphaFilter(
  textures: readonly { key: string; rgba: Uint8Array; hasAlpha: boolean }[],
  maxCutout = 0.5,
): PartFilter {
  const cut = new Map<string, number>();
  for (const t of textures) {
    if (!t.hasAlpha) continue;
    let n = 0;
    for (let i = 3; i < t.rgba.length; i += 4) if (t.rgba[i] < 128) n++;
    cut.set(t.key, n / (t.rgba.length / 4));
  }
  return (part) => !(part.textureKey !== undefined && (cut.get(part.textureKey) ?? 0) > maxCutout);
}

// ---------------------------------------------------------------------------
// BVH build (binned SAH, iterative)

const BINS = 16;
/** nodeData[2i+1] flag: inner node; low bits = right child, nodeData[2i] = left child. */
const INNER = 0x80000000;

function buildBvh(tris: Float32Array, n: number, leafSize: number) {
  // Per-triangle AABB and centroid.
  const tb = new Float32Array(n * 6);
  const cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = 9 * i;
    const minx = Math.min(tris[p], tris[p + 3], tris[p + 6]);
    const miny = Math.min(tris[p + 1], tris[p + 4], tris[p + 7]);
    const minz = Math.min(tris[p + 2], tris[p + 5], tris[p + 8]);
    const maxx = Math.max(tris[p], tris[p + 3], tris[p + 6]);
    const maxy = Math.max(tris[p + 1], tris[p + 4], tris[p + 7]);
    const maxz = Math.max(tris[p + 2], tris[p + 5], tris[p + 8]);
    tb[6 * i] = minx; tb[6 * i + 1] = miny; tb[6 * i + 2] = minz;
    tb[6 * i + 3] = maxx; tb[6 * i + 4] = maxy; tb[6 * i + 5] = maxz;
    cen[3 * i] = (minx + maxx) * 0.5;
    cen[3 * i + 1] = (miny + maxy) * 0.5;
    cen[3 * i + 2] = (minz + maxz) * 0.5;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  let cap = Math.max(64, Math.ceil((n / leafSize) * 2.5));
  let nodeBox = new Float32Array(cap * 6);
  let nodeData = new Uint32Array(cap * 2);
  let nodeCount = 0;
  let maxDepth = 0;

  const binCount = new Uint32Array(BINS);
  const binBox = new Float32Array(BINS * 6);
  const rightArea = new Float64Array(BINS);
  const rightCount = new Uint32Array(BINS);

  const alloc = () => {
    if (nodeCount >= cap) {
      cap *= 2;
      const nb = new Float32Array(cap * 6);
      nb.set(nodeBox);
      nodeBox = nb;
      const nd = new Uint32Array(cap * 2);
      nd.set(nodeData);
      nodeData = nd;
    }
    return nodeCount++;
  };

  if (n === 0) return { order, nodeBox: new Float32Array(0), nodeData: new Uint32Array(0), depth: 0 };

  // Work stack of (node, start, end, depth).
  const work: number[] = [];
  const root = alloc();
  work.push(root, 0, n, 0);

  while (work.length) {
    const depth = work.pop()!, end = work.pop()!, start = work.pop()!, node = work.pop()!;
    if (depth > maxDepth) maxDepth = depth;
    // Node bounds + centroid bounds.
    let bminx = Infinity, bminy = Infinity, bminz = Infinity, bmaxx = -Infinity, bmaxy = -Infinity, bmaxz = -Infinity;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity, cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let k = start; k < end; k++) {
      const i = order[k];
      const o = 6 * i;
      if (tb[o] < bminx) bminx = tb[o];
      if (tb[o + 1] < bminy) bminy = tb[o + 1];
      if (tb[o + 2] < bminz) bminz = tb[o + 2];
      if (tb[o + 3] > bmaxx) bmaxx = tb[o + 3];
      if (tb[o + 4] > bmaxy) bmaxy = tb[o + 4];
      if (tb[o + 5] > bmaxz) bmaxz = tb[o + 5];
      const cx = cen[3 * i], cy = cen[3 * i + 1], cz = cen[3 * i + 2];
      if (cx < cminx) cminx = cx;
      if (cy < cminy) cminy = cy;
      if (cz < cminz) cminz = cz;
      if (cx > cmaxx) cmaxx = cx;
      if (cy > cmaxy) cmaxy = cy;
      if (cz > cmaxz) cmaxz = cz;
    }
    const nb = 6 * node;
    nodeBox[nb] = bminx; nodeBox[nb + 1] = bminy; nodeBox[nb + 2] = bminz;
    nodeBox[nb + 3] = bmaxx; nodeBox[nb + 4] = bmaxy; nodeBox[nb + 5] = bmaxz;

    const count = end - start;
    const makeLeaf = () => {
      nodeData[2 * node] = start;
      nodeData[2 * node + 1] = count;
    };
    if (count <= leafSize) {
      makeLeaf();
      continue;
    }

    // Split axis: largest centroid extent.
    const ex = cmaxx - cminx, ey = cmaxy - cminy, ez = cmaxz - cminz;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const cmin = axis === 0 ? cminx : axis === 1 ? cminy : cminz;
    const extent = axis === 0 ? ex : axis === 1 ? ey : ez;
    if (!(extent > 1e-9)) {
      // All centroids coincide: split in the middle of the list.
      if (count <= leafSize * 4) {
        makeLeaf();
        continue;
      }
      const mid = (start + end) >> 1;
      pushChildren(node, start, mid, end, depth);
      continue;
    }

    // Bin.
    binCount.fill(0);
    for (let b = 0; b < BINS; b++) {
      binBox[6 * b] = binBox[6 * b + 1] = binBox[6 * b + 2] = Infinity;
      binBox[6 * b + 3] = binBox[6 * b + 4] = binBox[6 * b + 5] = -Infinity;
    }
    const scale = (BINS * (1 - 1e-6)) / extent;
    for (let k = start; k < end; k++) {
      const i = order[k];
      const b = Math.min(BINS - 1, ((cen[3 * i + axis] - cmin) * scale) | 0);
      binCount[b]++;
      const o = 6 * i, q = 6 * b;
      if (tb[o] < binBox[q]) binBox[q] = tb[o];
      if (tb[o + 1] < binBox[q + 1]) binBox[q + 1] = tb[o + 1];
      if (tb[o + 2] < binBox[q + 2]) binBox[q + 2] = tb[o + 2];
      if (tb[o + 3] > binBox[q + 3]) binBox[q + 3] = tb[o + 3];
      if (tb[o + 4] > binBox[q + 4]) binBox[q + 4] = tb[o + 4];
      if (tb[o + 5] > binBox[q + 5]) binBox[q + 5] = tb[o + 5];
    }
    // Sweep from the right.
    {
      let a0 = Infinity, a1 = Infinity, a2 = Infinity, a3 = -Infinity, a4 = -Infinity, a5 = -Infinity, c = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const q = 6 * b;
        c += binCount[b];
        if (binCount[b]) {
          a0 = Math.min(a0, binBox[q]); a1 = Math.min(a1, binBox[q + 1]); a2 = Math.min(a2, binBox[q + 2]);
          a3 = Math.max(a3, binBox[q + 3]); a4 = Math.max(a4, binBox[q + 4]); a5 = Math.max(a5, binBox[q + 5]);
        }
        rightCount[b] = c;
        rightArea[b] = c ? area(a0, a1, a2, a3, a4, a5) : 0;
      }
    }
    // Sweep from the left and pick the best split.
    let bestCost = Infinity, bestSplit = -1;
    {
      let a0 = Infinity, a1 = Infinity, a2 = Infinity, a3 = -Infinity, a4 = -Infinity, a5 = -Infinity, c = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const q = 6 * b;
        c += binCount[b];
        if (binCount[b]) {
          a0 = Math.min(a0, binBox[q]); a1 = Math.min(a1, binBox[q + 1]); a2 = Math.min(a2, binBox[q + 2]);
          a3 = Math.max(a3, binBox[q + 3]); a4 = Math.max(a4, binBox[q + 4]); a5 = Math.max(a5, binBox[q + 5]);
        }
        const rc = rightCount[b + 1];
        if (!c || !rc) continue;
        const cost = c * area(a0, a1, a2, a3, a4, a5) + rc * rightArea[b + 1];
        if (cost < bestCost) {
          bestCost = cost;
          bestSplit = b;
        }
      }
    }
    const parentArea = area(bminx, bminy, bminz, bmaxx, bmaxy, bmaxz);
    // Leaf if splitting doesn't pay off (traversal cost ~1 tri test).
    if (bestSplit < 0 || (count <= 8 && bestCost / parentArea >= count - 1)) {
      if (bestSplit < 0 && count > leafSize * 4) {
        const mid = (start + end) >> 1;
        pushChildren(node, start, mid, end, depth);
      } else makeLeaf();
      continue;
    }
    // Partition in place.
    let lo = start, hi = end - 1;
    while (lo <= hi) {
      const i = order[lo];
      const b = Math.min(BINS - 1, ((cen[3 * i + axis] - cmin) * scale) | 0);
      if (b <= bestSplit) lo++;
      else {
        order[lo] = order[hi];
        order[hi] = i;
        hi--;
      }
    }
    let mid = lo;
    if (mid === start || mid === end) mid = (start + end) >> 1;
    pushChildren(node, start, mid, end, depth);
  }

  function pushChildren(node: number, start: number, mid: number, end: number, depth: number) {
    const left = alloc();
    const right = alloc();
    nodeData[2 * node] = left;
    nodeData[2 * node + 1] = INNER | right;
    work.push(right, mid, end, depth + 1);
    work.push(left, start, mid, depth + 1);
  }

  return {
    order,
    nodeBox: nodeBox.slice(0, nodeCount * 6),
    nodeData: nodeData.slice(0, nodeCount * 2),
    depth: maxDepth,
  };
}

function area(a0: number, a1: number, a2: number, a3: number, a4: number, a5: number) {
  const x = a3 - a0, y = a4 - a1, z = a5 - a2;
  return x * y + y * z + z * x;
}

// ---------------------------------------------------------------------------
// Narrow phase helpers

const SWEEP_OUT = new Float64Array(3);
const CLOSEST = new Float64Array(6);
const CONTACTS = new Float64Array(24);

function pushContact(res: MoveResult, nx: number, ny: number, nz: number) {
  if (res.contacts < 8) {
    CONTACTS[3 * res.contacts] = nx;
    CONTACTS[3 * res.contacts + 1] = ny;
    CONTACTS[3 * res.contacts + 2] = nz;
  }
  res.contacts++;
}

function emptyMove(): MoveResult {
  return { contacts: 0, hitCeiling: false, hitWall: false, hitFloor: false, dx: 0, dy: 0, dz: 0 };
}

function entry(
  B: Float32Array, i: number,
  ox: number, oy: number, oz: number,
  idx: number, idy: number, idz: number, r: number,
) {
  const o = 6 * i;
  const t1 = (B[o] - r - ox) * idx, t2 = (B[o + 3] + r - ox) * idx;
  const t3 = (B[o + 1] - r - oy) * idy, t4 = (B[o + 4] + r - oy) * idy;
  const t5 = (B[o + 2] - r - oz) * idz, t6 = (B[o + 5] + r - oz) * idz;
  return Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
}

/** Möller–Trumbore, double-sided. Returns t or -1. */
function rayTri(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  T: Float32Array, p: number, maxT: number,
): number {
  const ax = T[p], ay = T[p + 1], az = T[p + 2];
  const e1x = T[p + 3] - ax, e1y = T[p + 4] - ay, e1z = T[p + 5] - az;
  const e2x = T[p + 6] - ax, e2y = T[p + 7] - ay, e2z = T[p + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 && t <= maxT ? t : -1;
}

/**
 * Swept sphere vs triangle (double-sided). Returns time of impact in [0, maxT]
 * or -1; writes the contact point on the triangle into out[0..2].
 */
function sphereTri(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number,
  T: Float32Array, p: number, maxT: number, out: Float64Array,
): number {
  const ax = T[p], ay = T[p + 1], az = T[p + 2];
  const bx = T[p + 3], by = T[p + 4], bz = T[p + 5];
  const cx = T[p + 6], cy = T[p + 7], cz = T[p + 8];

  // Already overlapping at t = 0?
  closestPtTri(ox, oy, oz, ax, ay, az, bx, by, bz, cx, cy, cz, out);
  {
    const ex = ox - out[0], ey = oy - out[1], ez = oz - out[2];
    const d2 = ex * ex + ey * ey + ez * ez;
    if (d2 < r * r) {
      // Only report if moving towards the triangle (lets you escape overlaps).
      return ex * dx + ey * dy + ez * dz < 0 ? 0 : -1;
    }
  }

  let best = maxT;
  let found = false;
  let hx = 0, hy = 0, hz = 0;

  // Face: plane offset by r on the side the sphere starts on.
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-12) return -1;
  nx /= nl; ny /= nl; nz /= nl;
  let dist0 = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz;
  if (dist0 < 0) {
    nx = -nx; ny = -ny; nz = -nz; dist0 = -dist0;
  }
  const dn = dx * nx + dy * ny + dz * nz;
  if (dn < -1e-12) {
    const t = (dist0 - r) / -dn;
    if (t >= 0 && t <= best) {
      const qx = ox + dx * t - nx * r, qy = oy + dy * t - ny * r, qz = oz + dz * t - nz * r;
      if (pointInTri(qx, qy, qz, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz)) {
        out[0] = qx; out[1] = qy; out[2] = qz;
        return t; // the face contact is always the earliest one if it exists
      }
    }
  } else if (dist0 > r) {
    return -1; // moving away / parallel and not touching the plane
  }

  // Vertices: ray vs sphere of radius r around each vertex.
  for (let v = 0; v < 3; v++) {
    const vx = T[p + 3 * v], vy = T[p + 3 * v + 1], vz = T[p + 3 * v + 2];
    const t = raySphere(ox, oy, oz, dx, dy, dz, vx, vy, vz, r);
    if (t >= 0 && t < best) {
      best = t; found = true;
      hx = vx; hy = vy; hz = vz;
    }
  }
  // Edges: ray vs infinite cylinder, clamped to the segment.
  for (let e = 0; e < 3; e++) {
    const p0 = p + 3 * e, p1 = p + 3 * ((e + 1) % 3);
    const sx = T[p0], sy = T[p0 + 1], sz = T[p0 + 2];
    const ex = T[p1] - sx, ey = T[p1 + 1] - sy, ez = T[p1 + 2] - sz;
    const ee = ex * ex + ey * ey + ez * ez;
    if (ee < 1e-12) continue;
    const mx = ox - sx, my = oy - sy, mz = oz - sz;
    const ed = ex * dx + ey * dy + ez * dz;
    const em = ex * mx + ey * my + ez * mz;
    const a = ee * (dx * dx + dy * dy + dz * dz) - ed * ed;
    const b = ee * (mx * dx + my * dy + mz * dz) - em * ed;
    const c = ee * (mx * mx + my * my + mz * mz - r * r) - em * em;
    if (Math.abs(a) < 1e-12) continue;
    const disc = b * b - a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t < 0 || t >= best) continue;
    const f = (em + t * ed) / ee;
    if (f < 0 || f > 1) continue;
    best = t; found = true;
    hx = sx + ex * f; hy = sy + ey * f; hz = sz + ez * f;
  }
  if (!found) return -1;
  out[0] = hx; out[1] = hy; out[2] = hz;
  return best;
}

function raySphere(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number,
): number {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

function pointInTri(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
): boolean {
  const e = -1e-7;
  // Edge ab
  let ux = bx - ax, uy = by - ay, uz = bz - az, vx = px - ax, vy = py - ay, vz = pz - az;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < e) {
    // Orientation of n may be flipped relative to winding; test with the opposite sign below.
    return pointInTriSigned(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, -nx, -ny, -nz);
  }
  ux = cx - bx; uy = cy - by; uz = cz - bz; vx = px - bx; vy = py - by; vz = pz - bz;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < e) return false;
  ux = ax - cx; uy = ay - cy; uz = az - cz; vx = px - cx; vy = py - cy; vz = pz - cz;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < e) return false;
  return true;
}

function pointInTriSigned(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
): boolean {
  const e = -1e-7;
  let ux = bx - ax, uy = by - ay, uz = bz - az, vx = px - ax, vy = py - ay, vz = pz - az;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < e) return false;
  ux = cx - bx; uy = cy - by; uz = cz - bz; vx = px - bx; vy = py - by; vz = pz - bz;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < e) return false;
  ux = ax - cx; uy = ay - cy; uz = az - cz; vx = px - cx; vy = py - cy; vz = pz - cz;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < e) return false;
  return true;
}

/** Closest point on triangle abc to p (Ericson, RTCD 5.1.5). Writes out[0..2]. */
function closestPtTri(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array, o = 0,
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set3(out, o, ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set3(out, o, bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set3(out, o, ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set3(out, o, cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set3(out, o, ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set3(out, o, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  set3(out, o, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

function set3(out: Float64Array, o: number, x: number, y: number, z: number) {
  out[o] = x; out[o + 1] = y; out[o + 2] = z;
}

const TMP = new Float64Array(3);

/**
 * Squared distance between the vertical segment (x, y0..y0+h, z) and a
 * triangle. Writes the closest points into out: segment point [0..2], triangle
 * point [3..5]. Exact up to the segment/triangle-interior crossing case, which
 * reports distance 0.
 */
function segTriDist2(x: number, y0: number, z: number, h: number, T: Float32Array, p: number, out: Float64Array): number {
  const ax = T[p], ay = T[p + 1], az = T[p + 2];
  const bx = T[p + 3], by = T[p + 4], bz = T[p + 5];
  const cx = T[p + 6], cy = T[p + 7], cz = T[p + 8];
  let best = Infinity;

  if (h <= 1e-9) {
    closestPtTri(x, y0, z, ax, ay, az, bx, by, bz, cx, cy, cz, out, 3);
    out[0] = x; out[1] = y0; out[2] = z;
    const ex = x - out[3], ey = y0 - out[4], ez = z - out[5];
    return ex * ex + ey * ey + ez * ez;
  }

  // 1) Segment crosses the triangle?
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  if (Math.abs(ny) > 1e-12) {
    // Plane: n·(q - a) = 0 with q = (x, y, z) => y = ay - (nx(x-ax) + nz(z-az)) / ny
    const yi = ay - (nx * (x - ax) + nz * (z - az)) / ny;
    if (yi >= y0 && yi <= y0 + h) {
      // Inside test in xz projection (barycentric).
      const d00 = e1x * e1x + e1z * e1z, d01 = e1x * e2x + e1z * e2z, d11 = e2x * e2x + e2z * e2z;
      const px = x - ax, pz = z - az;
      const d20 = px * e1x + pz * e1z, d21 = px * e2x + pz * e2z;
      const den = d00 * d11 - d01 * d01;
      if (Math.abs(den) > 1e-18) {
        const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
        if (v >= 0 && w >= 0 && v + w <= 1) {
          out[0] = x; out[1] = yi; out[2] = z;
          out[3] = x; out[4] = yi; out[5] = z;
          return 0;
        }
      }
    }
  }

  // 2) Endpoints vs triangle.
  for (let e = 0; e < 2; e++) {
    const sy = e === 0 ? y0 : y0 + h;
    closestPtTri(x, sy, z, ax, ay, az, bx, by, bz, cx, cy, cz, TMP, 0);
    const dx = x - TMP[0], dy = sy - TMP[1], dz = z - TMP[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) {
      best = d2;
      out[0] = x; out[1] = sy; out[2] = z;
      out[3] = TMP[0]; out[4] = TMP[1]; out[5] = TMP[2];
    }
  }

  // 3) Segment vs each triangle edge (segment-segment closest points).
  for (let e = 0; e < 3; e++) {
    const p0 = p + 3 * e, p1 = p + 3 * ((e + 1) % 3);
    const qx = T[p0], qy = T[p0 + 1], qz = T[p0 + 2];
    const ux = T[p1] - qx, uy = T[p1 + 1] - qy, uz = T[p1 + 2] - qz;
    // Segment 1: S(s) = (x, y0 + s h, z), s in [0,1]; segment 2: E(t) = q + t u.
    const rx = x - qx, ry = y0 - qy, rz = z - qz;
    const a = h * h; // d1·d1
    const ee = ux * ux + uy * uy + uz * uz; // d2·d2
    const f = ux * rx + uy * ry + uz * rz; // d2·r
    const c = h * ry; // d1·r
    const b = h * uy; // d1·d2
    let s: number, t: number;
    if (ee < 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const den = a * ee - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * ee) / den) : 0;
      t = (b * s + f) / ee;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
    const sy = y0 + s * h;
    const tx = qx + ux * t, ty = qy + uy * t, tz = qz + uz * t;
    const dx = x - tx, dy = sy - ty, dz = z - tz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) {
      best = d2;
      out[0] = x; out[1] = sy; out[2] = z;
      out[3] = tx; out[4] = ty; out[5] = tz;
    }
  }
  return best;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// Kinematic character motor ("floating capsule").
//
// The collision capsule spans [feet + stepHeight, feet + height], so anything
// lower than stepHeight (stair treads, curbs, terrain bumps) never blocks it.
// A downward sphere probe from feet + stepHeight finds the support surface and
// places the feet on it: that gives step-up, ground snapping when walking down
// stairs/slopes, and a slope limit (non-walkable probe hits are treated as
// walls the character slides down along). Pure math, no THREE: runs in Node.

export interface MotorConfig {
  radius: number;
  height: number;
  crouchHeight: number;
  stepHeight: number;
  slopeLimitDeg: number;
  /** Extra downward reach of the ground probe while grounded (walking down slopes/stairs). */
  snapDistance: number;
  gravity: number;
  jumpSpeed: number;
  walkSpeed: number;
  runSpeed: number;
  crouchSpeed: number;
  groundAccel: number;
  airAccel: number;
  /** Seconds after leaving the ground during which a jump is still accepted. */
  coyoteTime: number;
  /**
   * Dynamic-body layers this mover collides with besides `solid` (COLLISION_LAYER). The player
   * passes `player`. NPC motors pass nothing: Invisible Static Objects never stop them in the
   * port (docs/game-logic.md §14.7).
   */
  layers?: number;
  /**
   * The ground test. 'sphere' (default; the player): a sphere probe of 0.85 x radius, so the
   * feet stand on anything the probe touches. 'centre' (NPC motors; the original's character
   * mover, docs/game-logic.md §14.9): the feet stand only on a walkable surface under the feet
   * point (rays at the point and 1.5 cm around it, the original's nudge towards the triangle),
   * so a body whose centre is over a drop falls off the rim; a steep surface under the point is
   * not ground (the body slides off it).
   */
  groundProbe?: 'sphere' | 'centre';
  /** Height above the feet the ground probe starts from: the step-up limit (default stepHeight). */
  probeTop?: number;
}

export const DEFAULT_MOTOR: MotorConfig = {
  radius: 0.35,
  height: 1.8,
  crouchHeight: 1.1,
  stepHeight: 0.4,
  slopeLimitDeg: 50,
  snapDistance: 0.35,
  gravity: 18,
  jumpSpeed: 5.2,
  walkSpeed: 3.2,
  runSpeed: 6.5,
  crouchSpeed: 1.6,
  groundAccel: 14,
  airAccel: 2.5,
  coyoteTime: 0.12,
};

export interface MotorInput {
  /** Desired horizontal direction in world space (length <= 1). */
  wishX: number;
  wishZ: number;
  run: boolean;
  crouch: boolean;
  /** True on the frame jump was pressed (edge). */
  jump: boolean;
}

export class CharacterMotor {
  readonly cfg: MotorConfig;
  /** Feet position. */
  readonly position = { x: 0, y: 0, z: 0 };
  readonly velocity = { x: 0, y: 0, z: 0 };
  onGround = false;
  groundNormal: [number, number, number] = [0, 1, 0];
  /** Source part index of the surface stood on (-1 when airborne). */
  groundPart = -1;
  crouched = false;
  /** Current capsule height (switches between height and crouchHeight). */
  currentHeight: number;
  /** Vertical feet change applied by step-up/snap this step (for camera smoothing). */
  stepOffset = 0;
  /** Collision flags from the last step. */
  lastMove: MoveResult | null = null;

  private airTime = 0;
  private readonly cosSlope: number;
  private readonly cap: Capsule = { x: 0, z: 0, y0: 0, y1: 0, r: 0 };

  constructor(private world: CollisionWorld | null, cfg: Partial<MotorConfig> = {}) {
    this.cfg = { ...DEFAULT_MOTOR, ...cfg };
    this.currentHeight = this.cfg.height;
    this.cosSlope = Math.cos((this.cfg.slopeLimitDeg * Math.PI) / 180);
  }

  setWorld(world: CollisionWorld | null) {
    this.world = world;
  }

  /** Teleport (feet position); snaps to the ground below if close. */
  teleport(x: number, y: number, z: number) {
    // The world's queries see this mover's layers for the call (COLLISION_LAYER).
    const w = this.world, prev = w?.queryLayers ?? 0;
    if (w) w.queryLayers = this.layers;
    try {
      this.teleportIn(x, y, z);
    } finally {
      if (w) w.queryLayers = prev;
    }
  }

  /**
   * Move the feet sideways by (dx, dz) as a step of the capsule would: swept and slid along what
   * it meets, never into or through it (a push from outside, e.g. a body the player overlaps).
   * The height is kept; the next step's ground probe settles it.
   */
  shove(dx: number, dz: number) {
    const w = this.world;
    if (!w) {
      this.position.x += dx;
      this.position.z += dz;
      return;
    }
    const prev = w.queryLayers;
    w.queryLayers = this.layers;
    try {
      const c = this.capsule(this.currentHeight);
      w.moveCapsule(c, dx, 0, dz, null, this.cosSlope, false, true);
      // Only the sideways part: a contact's vertical push-out is the ground probe's to decide.
      this.position.x = c.x;
      this.position.z = c.z;
    } finally {
      w.queryLayers = prev;
    }
  }

  /** COLLISION_LAYER bits of this mover's queries. */
  get layers(): number {
    return COLLISION_LAYER.solid | (this.cfg.layers ?? 0);
  }

  private teleportIn(x: number, y: number, z: number) {
    this.position.x = x; this.position.y = y; this.position.z = z;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.onGround = false;
    this.airTime = 0;
    this.crouched = false;
    this.currentHeight = this.cfg.height;
    if (this.world) {
      // Get out of anything we spawned overlapping.
      const c = this.capsule(this.currentHeight);
      this.world.resolveCapsule(c, null, this.cosSlope, 8);
      this.position.x = c.x; this.position.z = c.z;
      this.position.y = c.y0 - this.cfg.stepHeight - this.cfg.radius;
      this.probeGround(true, 1.0);
    }
  }

  /** The collision capsule for the current feet position and a height. */
  capsule(height: number): Capsule {
    const { radius: r, stepHeight } = this.cfg;
    const c = this.cap;
    c.x = this.position.x;
    c.z = this.position.z;
    c.r = r;
    c.y0 = this.position.y + stepHeight + r;
    c.y1 = Math.max(c.y0, this.position.y + height - r);
    return c;
  }

  step(dt: number, input: MotorInput) {
    const w = this.world, prev = w?.queryLayers ?? 0;
    if (w) w.queryLayers = this.layers;
    try {
      this.stepIn(dt, input);
    } finally {
      if (w) w.queryLayers = prev;
    }
  }

  private stepIn(dt: number, input: MotorInput) {
    const cfg = this.cfg;
    const v = this.velocity;
    this.stepOffset = 0;
    if (dt <= 0) return;

    // Crouch / stand up (only if there is room).
    if (input.crouch) {
      this.crouched = true;
    } else if (this.crouched) {
      const blocked = this.world?.capsuleOverlaps(this.capsule(cfg.height), 0.01) ?? false;
      if (!blocked) this.crouched = false;
    }
    this.currentHeight = this.crouched ? cfg.crouchHeight : cfg.height;

    // Horizontal acceleration towards the wish velocity.
    const speed = this.crouched ? cfg.crouchSpeed : input.run ? cfg.runSpeed : cfg.walkSpeed;
    let wx = input.wishX, wz = input.wishZ;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) (wx /= wl), (wz /= wl);
    const tx = wx * speed, tz = wz * speed;
    const accel = this.onGround ? cfg.groundAccel : cfg.airAccel;
    const a = 1 - Math.exp(-accel * dt);
    v.x += (tx - v.x) * a;
    v.z += (tz - v.z) * a;

    // Jump.
    const canJump = this.onGround || this.airTime < cfg.coyoteTime;
    if (input.jump && canJump && !this.crouched && v.y <= 0.01) {
      v.y = cfg.jumpSpeed;
      this.onGround = false;
      this.airTime = cfg.coyoteTime; // no double jump via coyote time
    }

    // Gravity.
    const wasGrounded = this.onGround;
    if (!this.onGround) v.y -= cfg.gravity * dt;
    else v.y = Math.min(v.y, 0);

    if (!this.world) {
      this.position.x += v.x * dt;
      this.position.y += v.y * dt;
      this.position.z += v.z * dt;
      return;
    }

    // Move + slide the floating capsule.
    const c = this.capsule(this.currentHeight);
    const dy = this.onGround ? 0 : v.y * dt;
    const mv = this.world.moveCapsule(c, v.x * dt, dy, v.z * dt, v, this.cosSlope, false, this.onGround);
    this.lastMove = mv;
    this.position.x = c.x;
    this.position.z = c.z;
    this.position.y = c.y0 - cfg.stepHeight - cfg.radius;

    // Ground probe: step up / snap down / land.
    const reach = wasGrounded && v.y <= 0.01 ? cfg.snapDistance : Math.max(0.02, -v.y * dt);
    this.probeGround(v.y <= 0.01, reach);

    if (this.onGround) this.airTime = 0;
    else this.airTime += dt;
  }

  /**
   * Find support under the capsule. `allowSnap`: may place the feet on the
   * ground (false while moving upwards). `reach`: how far below the feet to look.
   */
  private probeGround(allowSnap: boolean, reach: number) {
    if (this.cfg.groundProbe === 'centre') return this.probeCentre(allowSnap, reach);
    const cfg = this.cfg;
    const w = this.world!;
    const v = this.velocity;
    const pr = cfg.radius * 0.85;
    const top = this.position.y + cfg.stepHeight;
    const g = w.groundQuery(this.position.x, top, this.position.z, pr, cfg.stepHeight + reach, cfg.slopeLimitDeg);
    if (!g) {
      this.onGround = false;
      this.groundPart = -1;
      return;
    }
    if (g.walkable) {
      if (!allowSnap && g.height < this.position.y) {
        this.onGround = false;
        this.groundPart = -1;
        return;
      }
      const before = this.position.y;
      this.position.y = g.height;
      this.stepOffset = g.height - before;
      this.onGround = true;
      this.groundNormal = g.normal;
      this.groundPart = g.part;
      if (v.y < 0) v.y = 0;
      // Stepping up may have pushed the head into a ceiling: settle.
      if (this.stepOffset > 0.001) {
        const c = this.capsule(this.currentHeight);
        w.resolveCapsule(c, null, this.cosSlope, 4);
        this.position.x = c.x;
        this.position.z = c.z;
        const fy = c.y0 - cfg.stepHeight - cfg.radius;
        if (fy < this.position.y) {
          // Can't fit standing on that step: undo the step-up.
          this.position.y = before;
          this.stepOffset = 0;
        }
      }
    } else {
      // Too steep: in the step band it acts like a wall. Push the feet out
      // horizontally (raising them would let you climb it) and slide along it.
      const [nx, ny, nz] = g.normal;
      const hl = Math.hypot(nx, nz);
      const pen = g.height - this.position.y;
      if (pen > 0 && hl > 1e-3) {
        const d = Math.min((pen * Math.max(ny, 0)) / hl, cfg.radius);
        this.position.x += (nx / hl) * d;
        this.position.z += (nz / hl) * d;
      }
      const vn = v.x * nx + v.y * ny + v.z * nz;
      if (vn < 0) {
        v.x -= nx * vn; v.y -= ny * vn; v.z -= nz * vn;
      }
      // Walkable ground straight below the centre still supports us
      // (e.g. standing on a floor at the foot of a steep slope).
      const down = w.raycast(this.position.x, top, this.position.z, 0, -1, 0, cfg.stepHeight + reach);
      if (down && down.normal[1] >= this.cosSlope && (allowSnap || down.point[1] >= this.position.y)) {
        this.stepOffset = down.point[1] - this.position.y;
        this.position.y = down.point[1];
        this.onGround = true;
        this.groundNormal = down.normal;
        this.groundPart = down.part;
        if (v.y < 0) v.y = 0;
      } else {
        this.onGround = false;
        this.groundPart = -1;
      }
    }
  }

  /**
   * The original's character ground test (MotorConfig.groundProbe 'centre', docs/game-logic.md
   * §14.9): the highest walkable surface under the feet point, from probeTop above the feet down
   * to `reach` below them. Nothing walkable there: the outdoor Landscape under a probe 2 m above
   * the feet (`landscapeGround`, the ground follower's fallback); else airborne (a steep surface
   * under the feet only turns the velocity along it).
   */
  private probeCentre(allowSnap: boolean, reach: number) {
    const cfg = this.cfg;
    const w = this.world!;
    const v = this.velocity;
    const up = Math.min(cfg.probeTop ?? cfg.stepHeight, cfg.stepHeight);
    let g = centreGround(w, this.position.x, this.position.y + up, this.position.z, up + reach, this.cosSlope);
    if (!g?.walkable) g = landscapeGround(w, this.position.x, this.position.y, this.position.z, reach, this.cosSlope) ?? g;
    if (!g?.walkable || (!allowSnap && g.height < this.position.y)) {
      if (g && !g.walkable && g.height >= this.position.y - 0.02) {
        const [nx, ny, nz] = g.normal;
        const vn = v.x * nx + v.y * ny + v.z * nz;
        if (vn < 0) {
          v.x -= nx * vn; v.y -= ny * vn; v.z -= nz * vn;
        }
      }
      this.onGround = false;
      this.groundPart = -1;
      return;
    }
    const before = this.position.y;
    this.position.y = g.height;
    this.stepOffset = g.height - before;
    this.onGround = true;
    this.groundNormal = g.normal;
    this.groundPart = g.part;
    if (v.y < 0) v.y = 0;
    // Stepping up may have pushed the head into a ceiling: settle, or undo the step.
    if (this.stepOffset > 0.001) {
      const c = this.capsule(this.currentHeight);
      w.resolveCapsule(c, null, this.cosSlope, 4);
      this.position.x = c.x;
      this.position.z = c.z;
      if (c.y0 - cfg.stepHeight - cfg.radius < this.position.y - 1e-4) {
        this.position.y = before;
        this.stepOffset = 0;
      }
    }
  }
}

/**
 * The ground follower's Landscape probe height above the feet: 4096 units (Suffering.rfl 0x100b6730,
 * constant 0x10155808), docs/game-logic.md §14.9.
 */
export const LANDSCAPE_PROBE = 2;

/**
 * The ground follower's fallback (Suffering.rfl 0x100b6730 -> 0x100c0520) [verified: the probe;
 * port choices inferred]: with no mover ground under the feet, the outdoor Landscape's height under
 * a point LANDSCAPE_PROBE above the feet (x, y, z) is the ground, down to `reach` below them. So a
 * body placed under the terrain (9's Inferna bd5, 0.66 m) stands on it, where its capsule had held
 * it from below with the probe under the surface. Port: only the Landscape's own triangles (parts
 * with floor layers, COLLISION_LAYER.landscape), only a walkable one, and only when the mover found
 * no walkable ground (the original also lets a higher Landscape override a mover ground within the
 * character's region, which the port does not model: interiors under the terrain would be lifted).
 */
export function landscapeGround(w: CollisionWorld, x: number, y: number, z: number, reach: number, cosSlope: number): CentreGround | null {
  const prev = w.queryLayers;
  w.queryLayers = COLLISION_LAYER.landscape;
  try {
    const h = w.raycast(x, y + LANDSCAPE_PROBE, z, 0, -1, 0, LANDSCAPE_PROBE + reach);
    return h && h.normal[1] >= cosSlope ? { height: h.point[1], normal: h.normal, part: h.part, walkable: true } : null;
  } finally {
    w.queryLayers = prev;
  }
}

/** The original's test point is moved 30 units (1.5 cm) towards the triangle (SUFFERING.EXE 0x421500). */
const GROUND_NUDGE = 0.015;
const NUDGES: readonly [number, number][] = [[GROUND_NUDGE, 0], [-GROUND_NUDGE, 0], [0, GROUND_NUDGE], [0, -GROUND_NUDGE]];

interface CentreGround {
  height: number;
  normal: [number, number, number];
  part: number;
  walkable: boolean;
}

/**
 * The surface under a point (x, z), looking down from `top` for `dist`: the first walkable one
 * (steep ones in between are passed through), else the first steep one, else null.
 */
function rayGround(w: CollisionWorld, x: number, top: number, z: number, dist: number, cosSlope: number): CentreGround | null {
  let y = top, left = dist, steep: CentreGround | null = null;
  for (let i = 0; i < 4 && left > 0; i++) {
    const h = w.raycast(x, y, z, 0, -1, 0, left);
    if (!h) break;
    if (h.normal[1] >= cosSlope) return { height: h.point[1], normal: h.normal, part: h.part, walkable: true };
    steep ??= { height: h.point[1], normal: h.normal, part: h.part, walkable: false };
    const d = h.distance + 1e-3;
    y -= d;
    left -= d;
  }
  return steep;
}

/** The ground under a feet point: the point itself, else the highest walkable surface 1.5 cm around it. */
export function centreGround(w: CollisionWorld, x: number, top: number, z: number, dist: number, cosSlope: number): CentreGround | null {
  const g = rayGround(w, x, top, z, dist, cosSlope);
  if (g?.walkable) return g;
  let best: CentreGround | null = null;
  for (const [dx, dz] of NUDGES) {
    const h = rayGround(w, x + dx, top, z + dz, dist, cosSlope);
    if (h?.walkable && (!best || h.height > best.height)) best = h;
  }
  return best ?? g;
}
