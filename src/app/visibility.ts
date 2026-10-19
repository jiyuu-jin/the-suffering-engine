// Zone / portal culling for the static level geometry (docs/game-logic.md §18).
//
// The level geometry is split into chunks, one per (zone, cell); renderer.ts keeps one mesh per
// material with its triangles ordered by chunk and draws only the visible chunks' triangles
// (compactLevel). Each frame:
//   1. find the zones whose box holds the camera (none -> every zone is a candidate);
//   2. walk the zone graph from them: a portal narrows the screen-space window to the
//      projection of its box (a portal crossing the near plane keeps the current window),
//      a closed portal (door shut) stops the walk, an open link (no portal) passes the
//      window on unchanged;
//   3. a chunk is drawn when it is in the view frustum, its zone was reached and its box
//      overlaps that zone's window, and it is not entirely beyond the fog's fade-out
//      distance (only without visible sky, see fogCull). Unzoned chunks get the frustum and
//      distance tests;
//   4. every other drawable in the scene (doors, props, actors, effects) is hidden when it
//      sits only in zones that were not reached (cullObjects; batched props: prop-batch.ts).

import * as THREE from 'three/webgpu';
import type { LevelVisibility } from '../formats/visgraph';

export interface VisChunk {
  /** "zone:cell" (debugging). */
  name: string;
  /** Set by the culler: draw this chunk's triangles. */
  visible: boolean;
  /** Zone index, -1 = not in any zone. */
  zone: number;
  /** World-space bounds of the chunk's geometry. */
  box: THREE.Box3;
  triangles: number;
}

export interface CullStats {
  /** Zones holding the camera (empty = none: every zone is a candidate). */
  cameraZones: number[];
  zones: number;
  zonesVisible: number;
  chunks: number;
  chunksVisible: number;
  trianglesVisible: number;
  portalsClosed: number;
  /** Scene objects outside the level geometry hidden this frame (cullObjects). */
  objectsHidden: number;
  ms: number;
}

// Screen rect in NDC: [minX, minY, maxX, maxY].
type Rect = [number, number, number, number];
/** Zone windows are rounded outwards to 1/Q of NDC. */
const Q = 32;
/** Zones closer than this to the camera are always walk seeds (see updateChunks). */
const NEAR_ZONE = 40;
/** cullObjects: objects with a larger bounding radius are always drawn; zone grid cell size. */
const OBJECT_MAX_RADIUS = 12;
const GRID = 16;
/** Zone (re)visits per walk before giving up and drawing every zone. */
const MAX_VISITS = 20000;

export class ZoneCuller {
  /** Off = draw every chunk (for comparisons; also the `?nocull` URL flag). */
  enabled = !new URLSearchParams(location.search).has('nocull');
  /**
   * Hide chunks wholly beyond the fog's fade-out distance. Only safe when no fog-less sky is
   * drawn behind the level (fully fogged geometry would still show as silhouettes against
   * it); the visibility game system turns it off when the level has a visible sky.
   */
  fogCull = true;
  /** Placed objects' draw distances (dynamic.ts placedCullDistance); off with `?nodrawdistance`. */
  drawDistances = !new URLSearchParams(location.search).has('nodrawdistance');
  /** Debug: treat every portal as open (closed doors stop hiding what is behind them). */
  openAll = false;
  /**
   * Distance beyond which the fog hides everything, for the last update (Infinity: no fog
   * culling, e.g. a visible sky or the culler off). The actors use it as their draw distance.
   */
  fogDistance = Infinity;
  readonly stats: CullStats = { cameraZones: [], zones: 0, zonesVisible: 0, chunks: 0, chunksVisible: 0, trianglesVisible: 0, portalsClosed: 0, objectsHidden: 0, ms: 0 };
  /** Per portal: 1 = open. Starts from Portal p0; the visibility game system drives it (setPortalOpen). */
  readonly portalOpen: Uint8Array;
  private portalVersion = 0;
  /** Bumped whenever a chunk's `visible` flag changes. */
  chunkVersion = 0;
  /** Bumped whenever the zone visibility behind objectVisible() may have changed. */
  objectsVersion = 0;
  private readonly frustum = new THREE.Frustum();

  private readonly zoneRect: Float32Array;
  private readonly zoneSeen: Uint8Array;
  private readonly zoneBoxes: THREE.Box3[];
  private readonly portalUid = new Map<number, number>();
  private readonly vp = new THREE.Matrix4();
  private readonly lastVp = new THREE.Matrix4();
  private lastKey = '';
  private readonly queue: number[] = [];
  private readonly queued: Uint8Array;
  private readonly reachable: Uint8Array;
  private readonly seeds: number[] = [];
  private allZones = true;
  private objects: THREE.Object3D[] = [];
  private objMask = new Uint32Array(0);
  /** Per object: draw distance from its centre (Infinity = none; userData.cullDistance). */
  private objDist = new Float32Array(0);
  /** Camera position of the last update. */
  private readonly eye = new THREE.Vector3();
  /** Per object: local bounding-sphere centre xyz + world radius (with slack). */
  private objSphere = new Float32Array(0);
  private refreshIn = 0;
  private grid: number[][] = [];
  private gridX = 0;
  private gridZ = 0;
  private gridW = 0;
  private gridH = 0;

  constructor(
    private readonly vis: LevelVisibility | undefined,
    readonly chunks: VisChunk[],
  ) {
    const nz = vis?.zones.length ?? 0;
    this.zoneRect = new Float32Array(4 * nz);
    this.zoneSeen = new Uint8Array(nz);
    this.queued = new Uint8Array(nz);
    this.reachable = new Uint8Array(nz);
    // Zone extents: the zone's actual geometry (the sector tree's boxes can be stale), else the
    // tree box; plus eye height above the tallest member (open-air zones) and some slack.
    this.zoneBoxes = (vis?.zones ?? []).map((z) => {
      const [x0, y0, z0, x1, y1, z1] = z.box;
      return new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    });
    const fromGeometry = new Set<number>();
    for (const c of chunks) {
      if (c.zone < 0 || c.zone >= nz || c.box.isEmpty()) continue;
      if (!fromGeometry.has(c.zone)) this.zoneBoxes[c.zone].copy(c.box), fromGeometry.add(c.zone);
      else this.zoneBoxes[c.zone].union(c.box);
    }
    for (const b of this.zoneBoxes) {
      b.min.x -= 0.25; b.min.y -= 1; b.min.z -= 0.25;
      b.max.x += 0.25; b.max.y += 3; b.max.z += 0.25;
    }
    // XZ grid of the zone boxes (grown by the largest object radius tested) for cullObjects.
    const all = new THREE.Box3();
    for (const b of this.zoneBoxes) all.union(b);
    const pad = OBJECT_MAX_RADIUS + 1;
    this.gridX = all.min.x - pad;
    this.gridZ = all.min.z - pad;
    this.gridW = nz ? Math.max(1, Math.ceil((all.max.x - all.min.x + 2 * pad) / GRID)) : 0;
    this.gridH = nz ? Math.max(1, Math.ceil((all.max.z - all.min.z + 2 * pad) / GRID)) : 0;
    this.grid = Array.from({ length: this.gridW * this.gridH }, () => [] as number[]);
    this.zoneBoxes.forEach((b, z) => {
      const x0 = Math.floor((b.min.x - pad - this.gridX) / GRID), x1 = Math.floor((b.max.x + pad - this.gridX) / GRID);
      const z0 = Math.floor((b.min.z - pad - this.gridZ) / GRID), z1 = Math.floor((b.max.z + pad - this.gridZ) / GRID);
      for (let j = Math.max(0, z0); j <= Math.min(this.gridH - 1, z1); j++) {
        for (let i = Math.max(0, x0); i <= Math.min(this.gridW - 1, x1); i++) this.grid[j * this.gridW + i].push(z);
      }
    });
    this.portalOpen = new Uint8Array(vis?.portals.length ?? 0);
    vis?.portals.forEach((p, i) => {
      this.portalOpen[i] = p.startsClosed ? 0 : 1;
      this.portalUid.set(p.uid, i);
    });
    this.stats.zones = nz;
    this.stats.chunks = chunks.length;
  }

  private setChunks(show: (c: VisChunk) => boolean) {
    let changed = false;
    for (const c of this.chunks) {
      const v = show(c);
      if (c.visible !== v) (c.visible = v), (changed = true);
    }
    if (changed) this.chunkVersion++;
  }

  /** Open / close portal `i` (index into LevelVisibility.portals). */
  setPortalOpen(i: number, open: boolean) {
    const v = open ? 1 : 0;
    if (this.portalOpen[i] === v) return;
    this.portalOpen[i] = v;
    this.portalVersion++;
  }

  portalIndex(uid: number): number | undefined {
    return this.portalUid.get(uid);
  }

  /**
   * Update chunk visibility for this camera (`fogDensity` 0 = no fog), then hide the other
   * objects of `scene` (everything outside `level`) that sit in hidden zones.
   */
  update(camera: THREE.PerspectiveCamera, fogDensity: number, scene?: THREE.Object3D, level?: THREE.Object3D) {
    const t0 = performance.now();
    camera.getWorldPosition(this.eye);
    this.updateChunks(camera, fogDensity);
    if (scene && level) this.cullObjects(scene, level, !this.enabled || this.allZones);
    this.stats.ms = performance.now() - t0;
  }

  private updateChunks(camera: THREE.PerspectiveCamera, fogDensity: number) {
    const st = this.stats;
    if (!this.enabled) {
      this.fogDistance = Infinity;
      this.objectsVersion++;
      this.setChunks(() => true);
      st.chunksVisible = this.chunks.length;
      st.zonesVisible = st.zones;
      st.cameraZones = [];
      st.trianglesVisible = this.chunks.reduce((s, c) => s + c.triangles, 0);
      this.lastKey = '';
      return;
    }
    camera.updateMatrixWorld();
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Fully fogged beyond d where exp(-(density d)^2) < 1/512.
    const fogCut = this.fogCull && fogDensity > 0 ? 2.5 / fogDensity : Infinity;
    this.fogDistance = fogCut;
    const key = `${fogCut}|${this.portalVersion}|${this.openAll}`;
    if (key === this.lastKey && this.vp.equals(this.lastVp)) return;
    this.lastKey = key;
    this.lastVp.copy(this.vp);
    this.objectsVersion++;

    const nz = this.zoneSeen.length;
    const eye = camera.getWorldPosition(_v);
    this.zoneSeen.fill(0);
    st.cameraZones.length = 0;
    for (let z = 0; z < nz; z++) if (this.zoneBoxes[z].containsPoint(eye)) st.cameraZones.push(z);
    let allZones = st.cameraZones.length === 0;
    if (!allZones) {
      // The precomputed visibility lists also cover sight lines that no portal explains
      // (bars, holes in walls), so every listed zone seeds the walk with the whole screen as
      // its window, unless only a shut door leads there (reachable with every portal open
      // but not with the real states); every zone within NEAR_ZONE does too (windows).
      const cam = st.cameraZones;
      if (!this.walk(cam, true)) allZones = true;
      else {
        this.reachable.set(this.zoneSeen);
        if (!this.openAll && !this.walk(cam, false)) allZones = true;
        else {
          const seeds = this.seeds;
          seeds.length = 0;
          for (const z of cam) seeds.push(z);
          const seed = (z: number, doorBlocks: boolean) => {
            if (z >= nz || seeds.includes(z)) return;
            if (doorBlocks && this.reachable[z] && !this.zoneSeen[z]) return;
            seeds.push(z);
          };
          for (const cz of cam) for (const z of this.vis!.zones[cz].pvs) seed(z, true);
          // Near field: the lists miss sight lines through windows (1a's yard windows, 5b's
          // greenhouse, 3b's cell fronts), so zones close to the camera are seeded too, even
          // when the only portal path to them is a shut door (the window still shows them).
          const near2 = NEAR_ZONE * NEAR_ZONE;
          for (let z = 0; z < nz; z++) if (this.zoneBoxes[z].distanceToPoint(eye) ** 2 < near2) seed(z, false);
          if (!this.walk(seeds, this.openAll)) allZones = true;
        }
      }
    }
    this.allZones = allZones;
    let zonesVisible = 0;
    for (let z = 0; z < nz; z++) if (allZones || this.zoneSeen[z]) zonesVisible++;

    let chunksVisible = 0, tris = 0;
    const fogCut2 = fogCut * fogCut;
    this.frustum.setFromProjectionMatrix(this.vp, camera.coordinateSystem);
    let changed = false;
    for (const c of this.chunks) {
      let show = c.box.distanceToPoint(eye) ** 2 <= fogCut2 && this.frustum.intersectsBox(c.box);
      if (show && c.zone >= 0 && !allZones) {
        if (!this.zoneSeen[c.zone]) show = false;
        else {
          const r = this.zoneRect;
          const o = 4 * c.zone;
          show = this.boxOverlaps(c.box, r[o], r[o + 1], r[o + 2], r[o + 3]);
        }
      }
      if (c.visible !== show) (c.visible = show), (changed = true);
      if (show) {
        chunksVisible++;
        tris += c.triangles;
      }
    }
    if (changed) this.chunkVersion++;
    st.zonesVisible = zonesVisible;
    st.chunksVisible = chunksVisible;
    st.trianglesVisible = tris;
    let closed = 0;
    for (const o of this.portalOpen) if (!o) closed++;
    st.portalsClosed = closed;
  }

  // -------------------------------------------------------------------------
  // Everything else in the scene (doors, props, pickups, actors, effects)

  /**
   * Hide scene objects outside the level geometry that sit wholly inside zones that are not
   * visible. An object is tested by its bounding sphere (last frame's matrices, 1 unit of
   * slack): it stays drawn if any zone box holding its centre is visible, if no zone box holds
   * it (unzoned space) or if it is large. Hiding uses `layers` (mask 0), which nothing else in
   * the app touches, so the systems' own `visible` flags are left alone.
   */
  private cullObjects(scene: THREE.Object3D, skip: THREE.Object3D, allZones: boolean) {
    if (--this.refreshIn <= 0 || !this.objects.length) this.collectObjects(scene, skip);
    const objs = this.objects, mask = this.objMask, sph = this.objSphere, dist = this.objDist;
    const ex = this.eye.x, ey = this.eye.y, ez = this.eye.z, on = this.enabled && this.drawDistances;
    let hidden = 0;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!o.visible) continue;
      let show = allZones || sph[4 * i + 3] > OBJECT_MAX_RADIUS;
      const far = on && dist[i] < Infinity;
      if (!show || far) {
        const e = o.matrixWorld.elements;
        const x = sph[4 * i], y = sph[4 * i + 1], z = sph[4 * i + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (!show) show = this.sphereVisible(wx, wy, wz, sph[4 * i + 3]);
        // Placed objects' draw distance (dynamic.ts placedCullDistance).
        if (show && far) show = (wx - ex) ** 2 + (wy - ey) ** 2 + (wz - ez) ** 2 <= dist[i] * dist[i];
      }
      const m = show ? mask[i] : 0;
      if (o.layers.mask !== m) o.layers.mask = m;
      if (!show) hidden++;
    }
    this.stats.objectsHidden = hidden;
  }

  /**
   * Would cullObjects draw a mesh with this world bounding sphere (radius with its slack) and
   * draw distance this frame? For meshes drawn by someone else (prop-batch.ts members).
   */
  objectVisible(x: number, y: number, z: number, r: number, cullDistance = Infinity): boolean {
    if (!this.enabled) return true;
    if (cullDistance < Infinity && this.drawDistances && (x - this.eye.x) ** 2 + (y - this.eye.y) ** 2 + (z - this.eye.z) ** 2 > cullDistance * cullDistance) return false;
    if (this.allZones || r > OBJECT_MAX_RADIUS || !this.zoneBoxes.length) return true;
    return this.sphereVisible(x, y, z, r);
  }

  /** Does the level have zones (else only frustum and fog distance cull)? */
  get hasZones(): boolean {
    return this.zoneBoxes.length > 0;
  }

  /** Re-gather the scene's objects on the next update (e.g. after objects were batched). */
  refreshObjects() {
    this.refreshIn = 0;
  }

  /** Gather the scene's drawables outside the level (every 30 frames: systems add and remove objects). */
  private collectObjects(scene: THREE.Object3D, skip: THREE.Object3D) {
    this.refreshIn = 30;
    for (let i = 0; i < this.objects.length; i++) this.objects[i].layers.mask = this.objMask[i];
    const objs: THREE.Object3D[] = [];
    const walk = (o: THREE.Object3D) => {
      if (o === skip || (o as THREE.Camera).isCamera) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry && !exempt(m)) objs.push(o);
      for (const c of o.children) walk(c);
    };
    walk(scene);
    this.objects = objs;
    this.objMask = new Uint32Array(objs.length);
    this.objSphere = new Float32Array(4 * objs.length);
    this.objDist = new Float32Array(objs.length);
    objs.forEach((o, i) => {
      this.objMask[i] = o.layers.mask;
      this.objDist[i] = (o.userData.cullDistance as number | undefined) ?? Infinity;
      const g = (o as THREE.Mesh).geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = g.boundingSphere!;
      const e = o.matrixWorld.elements;
      const scale = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])) || 1;
      const r = s.radius * scale + 1; // 1 unit of slack

      this.objSphere.set([s.center.x, s.center.y, s.center.z, Number.isFinite(r) ? r : Infinity], 4 * i);
    });
  }

  /** A world sphere is drawn unless every zone box it touches is hidden (and it touches one). */
  private sphereVisible(x: number, y: number, z: number, r: number): boolean {
    const gx = Math.floor((x - this.gridX) / GRID), gz = Math.floor((z - this.gridZ) / GRID);
    if (gx < 0 || gz < 0 || gx >= this.gridW || gz >= this.gridH) return true;
    let inZone = false;
    for (const zi of this.grid[gz * this.gridW + gx]) {
      const b = this.zoneBoxes[zi];
      if (x < b.min.x - r || x > b.max.x + r || y < b.min.y - r || y > b.max.y + r || z < b.min.z - r || z > b.max.z + r) continue;
      if (this.zoneSeen[zi]) return true;
      inZone = true;
    }
    return !inZone;
  }

  /**
   * Portal walk as a fixpoint: each zone keeps the union of the windows it is seen through;
   * when that grows, the zone is (re)queued and passes its window on through its links.
   * Windows are rounded outwards to 1/64 of the screen so the walk ends after a bounded
   * number of steps however the graph loops.
   */
  private walk(start: number[], allOpen: boolean) {
    const r = this.zoneRect;
    const queue = this.queue;
    queue.length = 0;
    this.zoneSeen.fill(0);
    this.queued.fill(0);
    const widen = (z: number, x0: number, y0: number, x1: number, y1: number) => {
      x0 = Math.floor(x0 * Q) / Q;
      y0 = Math.floor(y0 * Q) / Q;
      x1 = Math.ceil(x1 * Q) / Q;
      y1 = Math.ceil(y1 * Q) / Q;
      const o = 4 * z;
      if (this.zoneSeen[z]) {
        if (x0 >= r[o] && y0 >= r[o + 1] && x1 <= r[o + 2] && y1 <= r[o + 3]) return;
        r[o] = Math.min(r[o], x0);
        r[o + 1] = Math.min(r[o + 1], y0);
        r[o + 2] = Math.max(r[o + 2], x1);
        r[o + 3] = Math.max(r[o + 3], y1);
      } else {
        this.zoneSeen[z] = 1;
        r[o] = x0;
        r[o + 1] = y0;
        r[o + 2] = x1;
        r[o + 3] = y1;
      }
      if (!this.queued[z]) {
        this.queued[z] = 1;
        queue.push(z);
      }
    };
    for (const z of start) widen(z, -1, -1, 1, 1);
    const win: Rect = [0, 0, 0, 0];
    let steps = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      if (++steps > MAX_VISITS) return false;
      const z = queue[qi];
      this.queued[z] = 0;
      const o = 4 * z;
      win[0] = r[o];
      win[1] = r[o + 1];
      win[2] = r[o + 2];
      win[3] = r[o + 3];
      for (const l of this.vis!.zones[z].links) {
        if (l.portal < 0) {
          widen(l.zone, win[0], win[1], win[2], win[3]);
          continue;
        }
        if (!allOpen && !this.portalOpen[l.portal]) continue;
        const next = this.portalRect(this.vis!.portals[l.portal].corners, win);
        if (next) widen(l.zone, next[0], next[1], next[2], next[3]);
      }
    }
    return true;
  }

  /** Screen window of a portal box clipped to `rect` (null = not visible through it). */
  private portalRect(c: number[], rect: Rect): Rect | null {
    const e = this.vp.elements;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let behind = 0;
    for (let i = 0; i < 24; i += 3) {
      const x = c[i], y = c[i + 1], z = c[i + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-3) {
        behind++;
        continue;
      }
      const sx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const sy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy;
      if (sy > y1) y1 = sy;
    }
    if (behind === 8) return null;
    // Straddles the camera plane (camera in or next to the doorway): keep the whole window.
    if (behind > 0) return rect;
    const r: Rect = [Math.max(x0, rect[0]), Math.max(y0, rect[1]), Math.min(x1, rect[2]), Math.min(y1, rect[3])];
    return r[0] < r[2] && r[1] < r[3] ? r : null;
  }

  /** Does a world box's screen projection overlap the window? (Boxes crossing the near plane do.) */
  private boxOverlaps(b: THREE.Box3, rx0: number, ry0: number, rx1: number, ry1: number): boolean {
    if (rx0 <= -1 && ry0 <= -1 && rx1 >= 1 && ry1 >= 1) return true;
    const e = this.vp.elements;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? b.max.x : b.min.x;
      const y = i & 2 ? b.max.y : b.min.y;
      const z = i & 4 ? b.max.z : b.min.z;
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-3) return true;
      const sx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const sy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy;
      if (sy > y1) y1 = sy;
    }
    return x0 <= rx1 && x1 >= rx0 && y0 <= ry1 && y1 >= ry0;
  }
}

const _v = new THREE.Vector3();

/**
 * Drawables cullObjects never hides: characters (skinned: their bind-pose bounds say nothing
 * about the animated pose a sequence puts them in), morphing, instanced and point / sprite
 * geometry, geometry rewritten on the CPU (particles, trails), and anything the owner already
 * draws without frustum culling. Only rigid meshes with fixed geometry are tested.
 */
function exempt(m: THREE.Mesh): boolean {
  // Static batch members and the merged meshes: prop-batch.ts culls them itself.
  if (m.userData.staticBatch) return true;
  if ((m as unknown as THREE.SkinnedMesh).isSkinnedMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return true;
  if (!m.frustumCulled || m.morphTargetInfluences?.length) return true;
  const pos = m.geometry.getAttribute('position');
  return !pos || (pos as THREE.BufferAttribute).usage === THREE.DynamicDrawUsage;
}
