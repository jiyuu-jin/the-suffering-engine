// Riot Engine level (.lvl) -> static world geometry.
//
// The Suffering has no BSP/brush world: a level is a list of object instances
// (~1-6k per level). Static scenery instances place .mdu models (walls, floor
// tiles, pipes, trees...) from the level's dependency packages, and carry a
// reference into "<stem>_level.ldu", which holds the instance's baked
// per-vertex lighting. Rendering a level = instancing those models.
//
// .lvl entries (SRSC, group 0)
// ----------------------------
//   type 0x02 g4  container header
//   type 0x00     level header: u16 len + title ("Death House", NUL padded so 2+len % 4 == 0),
//                 u32 1024, u32 1024, u32 depCount, depCount x (u16 len + path) — package paths
//                 like "..\..\World Common\Prison Common\Prison Common" (the full set of packages
//                 the level uses; the chapter .db alone misses some, e.g. Outdoor Common), then
//                 u32 ?, u32 ?, u32 ?, and the editor camera: f32[3] position, f32[3x3] rotation.
//   type 0x01     FLOOR / TERRAIN LAYERS ("layer 191", "Join , 20, 14, 0"): heightfield grids of
//                 1x1-unit cells — all floors and outdoor ground. See parseFloorLayers.
//   type 0x03     u32 (unknown, e.g. 0x000320c8)
//   type 0x20     OBJECT INSTANCES (decoded here; see parseLevelObjects)
//   type 0x26     sector tree: editor groups + automatic splits over every object / floor
//                 layer, with bounding boxes (decoded in visgraph.ts)
//   type 0x27     zone graph: zones (named tree groups), their portals and visibility lists
//                 (decoded in visgraph.ts)
//   type 0x28     per-instance editor metadata: FILETIME + author name ("richard", "Brian")
//
// Object instance block (type 0x20)
// ---------------------------------
//   u16 n
//   n x { u32 uid, u16 templateId, u16 templatePkg }        template = .odu object (type 2)
//   n x record, same order, variable length:
//     f32[3] position (engine units; 2048 per model unit)
//     u32    flags   (0x80: placed static mesh w/ rotation semantics; 0x10: extra f32 follows;
//                     0x100: scale present; 0x8000: 64-byte block + extra ref at end (see below);
//                     the rest is read by the engine's instance loader, see INSTANCE_FLAGS)
//     [f32   if flags & 0x10: draw distance, engine units]
//     u16 linkCount, linkCount x u32 uid       links to other instances
//     i16[3] rotation in degrees (x, y, z)      applied as Ry(y)·Rx(x)·Rz(z)
//     [f32[3] scale if flags & 0x100]
//     u32 wordCount, u32 propCount, wordCount x u32 values, propCount x u16 property indices
//                                              (template property overrides)
//     ref (u16 id, u16 pkg)                    pkg == level package => .ldu entry (baked colours)
//     [if flags & 0x8000: 64 bytes, then another ref (the .ldu ref moves here)]
//   Verified: all 18 retail .lvl files parse to the exact end with this layout.
//
// .ldu (type 0x52 entries, one per lit instance; id = the ref above):
//   u16 modelId, u16 modelPkg, u32 1, u32 count, count x D3DCOLOR (bytes B,G,R,A)
//   count == the model's vertex count (type-3 vertices, not corners).
//
// Coordinates
// -----------
// Engine space: Y up. Instance world position W (engine units):
//   W = pos + 2048 · A · Ry(ry) · Rx(rx) · Rz(rz) · (scale ∘ v)
// where A = Ry(-90°) = [[0,0,-1],[0,1,0],[1,0,0]] (model -z -> world +x), and
// Ry(a) = [[c,0,s],[0,1,0],[-s,0,c]], Rx(a) = [[1,0,0],[0,c,-s],[0,s,c]], Rz(a) = [[c,-s,0],[s,c,0],[0,0,1]].
// Output (LevelData) space: engine axes in model units (W / 2048).
// Engine space is used as-is (verified: wall stencils such as "EAST WALKWAY" read correctly
// without any mirroring). Triangles are clockwise-front in that space, so indices are reversed
// to give the usual counter-clockwise front faces.

import type { SrscFile } from './srsc';
import { inflateZlib } from './inflate';
import { faceMaterialIndex, moverCollisionMesh, rayOnlyCollisionMesh, readModelCollision, type CollisionMesh } from './model-collision';
import { hasSkeleton } from './skeleton';
import type { LevelData, MeshPart } from './types';
import type { LoadTimeSet, StaticLighting } from './static-light';
import {
  type PackageSet,
  type ResRef,
  type RiotModel,
  type RiotPackage,
  findEntry,
  readLandscapeSplat,
  readMaterial,
  readModel,
  templateModelRef,
  materialSignature,
  refKey,
  TDU_TEXTURE,
  type LandscapeSplat,
  type SurfaceMaterial,
} from './model';

export type { PackageSet, RiotPackage } from './model';

export const LVL_HEADER = 0x00;
export const LVL_LAYERS = 0x01;
export const LVL_OBJECTS = 0x20;
export const LDU_COLORS = 0x52;
/** Engine units per model unit. */
export const WORLD_SCALE = 2048;
/** System package (editor markers, triggers): never rendered as scenery. */
const SYSTEM_PKG = 2;
/** Template of the Player object (class 0xc8bc44e1). System 2:6 is the Camera, not the player. */
const PLAYER_TEMPLATE: ResRef = { id: 5, pkg: 2 };

export interface LevelHeader {
  title: string;
  /** Package paths relative to the .lvl folder, backslashed, without extension. */
  dependencies: string[];
  /** Editor camera (engine units, engine space), if present. */
  camera?: { position: [number, number, number]; rotation: number[] };
}

export interface LevelObject {
  index: number;
  uid: number;
  template: ResRef;
  /** Engine-space position (engine units). */
  position: [number, number, number];
  flags: number;
  links: number[];
  /** Degrees about x, y, z. */
  rotation: [number, number, number];
  scale?: [number, number, number];
  /** Template property overrides: raw u32 words + property indices. */
  propWords: Uint32Array;
  propIndices: Uint16Array;
  /** Usually the .ldu entry (pkg == level package) or 0:0. */
  ref: ResRef;
  /** flags & 0x10: the instance's own draw distance (engine units; INSTANCE_FLAGS.drawDistance). */
  drawDistance?: number;
  /** Present when flags & 0x8000. */
  extraRef?: ResRef;
}

export interface LevelExtras {
  /** "<stem>_level.ldu" (baked per-vertex colours). */
  ldu?: SrscFile;
  /**
   * Packages by .db id. Must contain at least the .mdu/.odu of every package listed in the
   * level header (readLevelHeader().dependencies) plus the chapter package; .tdu is optional
   * (only used to validate material -> texture links).
   */
  packages?: PackageSet | RiotPackage[];
  /** .db id of "<stem>_level" (the package of the .ldu). Inferred from the data if omitted. */
  levelPackageId?: number;
  /**
   * Also render placed models that have no baked lighting (flags & 0x80 but no .ldu ref).
   * Default true; markers from the System package are always skipped.
   */
  includeUnlit?: boolean;
  /** Colour used for unlit instances (and when no .ldu): default = median .ldu colour or 0.5 grey. */
  unlitColor?: [number, number, number, number];
  /**
   * Light placed models and floor layers that have no .ldu colours with the lights that are on
   * at load, as the engine's load-time CPU pass does (formats/static-light.ts), instead of
   * `unlitColor`.
   */
  staticLighting?: StaticLighting;
  /** Emit the floor layers (type 0x01). Default true. */
  includeLayers?: boolean;
  /** Emit placed models (type 0x20 instances). Default true. */
  includeObjects?: boolean;
  /**
   * Placed objects (by uid) to leave out of the static geometry because a game system
   * renders and collides them dynamically (doors, pickups, toggled props).
   */
  excludeUids?: Set<number>;
  /**
   * Placed objects (by uid) drawn as usual but left out of collision (their parts get
   * `solid: false`): water surfaces (Water Volume, src/game/levels/water.ts).
   */
  nonSolidUids?: Set<number>;
  /**
   * Placed objects (by uid) that collide for sight and shots but not for movers (their parts get
   * `moveSolid: false`): Decorations, which no mover's collide list names (src/game/world/blockers.ts).
   */
  moverPassUids?: Set<number>;
  /**
   * How a placed object of the static geometry collides (docs/game-logic.md §14.10): null = not
   * at all. With this set, LevelData.collision holds the original's collision geometry (the
   * models' type-7 trees, formats/model-collision.ts, and the floor layers) instead of the drawn
   * triangles.
   */
  collisionOf?: (o: LevelObject) => ObjectCollision | null;
  /**
   * COLLISION_LAYER bits of the floor-layer triangles in LevelData.collision that are not drawn
   * but hold movers up (LAYER_CELL; floor layers are the original's Landscape). Default: the
   * physics default for a part.
   */
  layerCollision?: number;
  /**
   * Visibility zone of each object / floor layer by uid (formats/visgraph.ts buildLevelZoning).
   * Geometry is bucketed per zone so the renderer can hide zones the camera cannot see.
   */
  zoneOf?: Map<number, number>;
  /**
   * Also split geometry into square cells of this many model units (by object origin / floor
   * block centre) so frustum and distance culling can skip parts of large areas. Zoned
   * geometry is only split when its zone is wider than two cells. Default 48; 0 = off.
   */
  chunkSize?: number;
}

/** LevelExtras.collisionOf: COLLISION_LAYER bits (src/app/physics.ts) per geometry. */
export interface ObjectCollision {
  /** Layers of the geometry movers and rays share (formats/model-collision.ts). */
  layers: number;
  /** Layers of the geometry only rays hit (a sphere tree without nodes: the drawn faces). */
  rayLayers: number;
  /** AI sight passes the object (template bit 10 / instance 0x1000000). */
  sightPass: boolean;
}

// ---------------------------------------------------------------------------

function readString(v: DataView, p: number): [string, number] {
  const len = v.getUint16(p, true);
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = v.getUint8(p + 2 + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return [s, p + 2 + len];
}

export function readLevelHeader(lvl: SrscFile): LevelHeader {
  const e = lvl.entries.find((x) => x.type === LVL_HEADER && x.group === 0);
  if (!e) return { title: '', dependencies: [] };
  const v = lvl.data(e);
  let p = 0;
  let title: string;
  [title, p] = readString(v, p);
  const dependencies: string[] = [];
  try {
    p += 8;
    const n = v.getUint32(p, true);
    p += 4;
    for (let i = 0; i < n && n < 256; i++) {
      let s: string;
      [s, p] = readString(v, p);
      dependencies.push(s);
    }
  } catch {
    /* truncated header */
  }
  let camera: LevelHeader['camera'];
  if (v.byteLength >= 48 && v.byteLength - 48 >= p) {
    const f = (i: number) => v.getFloat32(v.byteLength - 48 + 4 * i, true);
    camera = { position: [f(0), f(1), f(2)], rotation: Array.from({ length: 9 }, (_, i) => f(3 + i)) };
  }
  return { title, dependencies, camera };
}

/**
 * Instance flag bits as SUFFERING.EXE's instance loader (0x45a5c0) reads them
 * (docs/re/object-model.md §2). `tmpl` = the template's own flag word (.odu template +4), used
 * whenever the instance does not override it.
 */
export const INSTANCE_FLAGS = {
  /** Shown at start: SetVisible(flags & 1) on the engine object (0x45a667 -> vtable +0x128). */
  visible: 0x1,
  /** Never created; with (0x10000 << difficulty) the per-difficulty exclusions (0x45a63f, campaign/difficulty.ts). */
  notCreated: 0x8,
  /** Own draw distance follows (f32, engine units); else the template's or 70.71 x radius. */
  drawDistance: 0x10,
  /** Scale (3 x f32) follows. */
  scale: 0x100,
  /** 0x400 / 0x800 replace template flag bits 0 / 1 only when 0x1000 is set (0x45a6dd). */
  overrideTmpl01: 0x1000,
  tmplBit0: 0x400,
  tmplBit1: 0x800,
  /** Own 64-byte bounds block + second ref. */
  ownBounds: 0x8000,
} as const;

/** Decode the object instance block (type 0x20). Throws if the layout does not fit. */
export function parseLevelObjects(lvl: SrscFile): LevelObject[] {
  const e = lvl.entries.find((x) => x.type === LVL_OBJECTS);
  if (!e) return [];
  const v = lvl.data(e);
  const n = v.getUint16(0, true);
  const out: LevelObject[] = [];
  let p = 2 + 8 * n;
  for (let i = 0; i < n; i++) {
    if (p >= v.byteLength) throw new Error(`object block ended after ${i}/${n} records`);
    const t = 2 + 8 * i;
    const position: [number, number, number] = [v.getFloat32(p, true), v.getFloat32(p + 4, true), v.getFloat32(p + 8, true)];
    const flags = v.getUint32(p + 12, true);
    p += 16;
    let drawDistance: number | undefined;
    if (flags & 0x10) {
      drawDistance = v.getFloat32(p, true);
      p += 4;
    }
    const nl = v.getUint16(p, true);
    p += 2;
    const links: number[] = [];
    for (let k = 0; k < nl; k++, p += 4) links.push(v.getUint32(p, true));
    const rotation: [number, number, number] = [v.getInt16(p, true), v.getInt16(p + 2, true), v.getInt16(p + 4, true)];
    p += 6;
    let scale: [number, number, number] | undefined;
    if (flags & 0x100) {
      scale = [v.getFloat32(p, true), v.getFloat32(p + 4, true), v.getFloat32(p + 8, true)];
      p += 12;
    }
    const nw = v.getUint32(p, true);
    const ni = v.getUint32(p + 4, true);
    p += 8;
    if (nw > 4096 || ni > 4096) throw new Error(`bad property counts at record ${i}`);
    const propWords = new Uint32Array(nw);
    for (let k = 0; k < nw; k++, p += 4) propWords[k] = v.getUint32(p, true);
    const propIndices = new Uint16Array(ni);
    for (let k = 0; k < ni; k++, p += 2) propIndices[k] = v.getUint16(p, true);
    let ref: ResRef = { id: v.getUint16(p, true), pkg: v.getUint16(p + 2, true) };
    p += 4;
    let extraRef: ResRef | undefined;
    if (flags & 0x8000) {
      extraRef = ref;
      p += 64;
      ref = { id: v.getUint16(p, true), pkg: v.getUint16(p + 2, true) };
      p += 4;
    }
    if (p > v.byteLength) throw new Error(`object record ${i} overruns block`);
    out.push({
      index: i,
      uid: v.getUint32(t, true),
      template: { id: v.getUint16(t + 4, true), pkg: v.getUint16(t + 6, true) },
      position,
      flags,
      links,
      rotation,
      scale,
      propWords,
      propIndices,
      ref,
      extraRef,
      ...(drawDistance !== undefined ? { drawDistance } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Floor layers (type 0x01)

export interface LayerBlock {
  /** Cell rect within the layer, inclusive of the far vertex: x0..x1, z0..z1 (vertex coords). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Landscape texture materials blended in this block (.odu refs, usually pkg 6). */
  materials: ResRef[];
  cols: number;
  rows: number;
  /** One cols*rows weight grid per material: low nibble = weight 0..4, 0x10 = cell drawn. */
  weights: Uint8Array[];
}

export interface FloorLayer {
  uid: number;
  name: string;
  /** Cells along x / z (vertices = (w+1)*(h+1)). */
  w: number;
  h: number;
  /** Grid origin in model units (engine x/2048, engine z/2048). */
  x: number;
  z: number;
  /** Engine-unit height. */
  y: number;
  flags: number;
  /** Baked material (level package) whose texture is an atlas holding this layer's pre-blended image. */
  material?: ResRef;
  /** Inclusive pixel rect of this layer in the atlas texture: x0, x1, y0, y1. */
  atlasRect?: [number, number, number, number];
  blocks: LayerBlock[];
  /** Per-vertex packed normals (i8 x, i8 y, ...) when not flat. */
  normals?: Int8Array;
  /** .ldu entry with (w+1)*(h+1) baked colours (model ref 0:0). */
  ldu: ResRef;
  /** Per-vertex raw heights: engine y = y + 2 * (height - 32768). */
  heights?: Uint16Array;
  /** Per-cell flags (LAYER_CELL: the diagonal, hidden and hole triangles). */
  cellFlags?: Uint8Array;
}

/** Engine-unit height of layer vertex (i, j). */
export function layerVertexY(L: FloorLayer, i: number, j: number): number {
  return L.heights ? L.y + 2 * (L.heights[j * (L.w + 1) + i] - 32768) : L.y;
}

/**
 * Floor-layer cell flags (the low byte of the engine's per-cell word, copied from the first u16
 * of the 22-byte cell record by the loader, SUFFERING.EXE 0x4a0500) [verified unless marked]:
 * - `flip` (0x1): the cell's diagonal. Without it the cell splits along (1, 0)-(0, 1) and its
 *   triangle 0 is fx + fz <= 1; with it along (0, 0)-(1, 1) and triangle 0 is fx <= fz
 *   (0x49db80, fx / fz the point's place in the cell along x / z).
 * - `hole` (0x40 << t): triangle t is a hole. The Landscape height lookups skip it (the ray
 *   0x4a6c03, the characters' Landscape probe Suffering.rfl 0x100c01cd).
 * - `hidden` (0x10 << t): triangle t is not drawn [strong: the loader sets 0x30 on a cell whose
 *   texture ref does not resolve (0x4a05df); every cell of 5b's material-less layers carries it].
 *   A hidden triangle that is not a hole still holds movers up: 5b's lobby, landing, upper floor
 *   and attic stand on such layers, while the room models drawn over them have collision trees
 *   without nodes (docs/game-logic.md §14.10).
 */
export const LAYER_CELL = { flip: 0x1, hidden: 0x10, hole: 0x40 } as const;

/**
 * The two triangles of a cell as corner offsets (di, dj), in the engine's order (triangle 0 then
 * 1, see LAYER_CELL.flip), wound counter-clockwise seen from +y (`down`: from -y).
 */
export function layerCellTriangles(flags: number, down = false): [number, number][][] {
  const a: [number, number] = [0, 0], b: [number, number] = [1, 0], c: [number, number] = [0, 1], d: [number, number] = [1, 1];
  const tris = flags & LAYER_CELL.flip ? [[a, c, d], [a, d, b]] : [[a, c, b], [b, c, d]];
  return down ? tris.map((t) => [t[0], t[2], t[1]]) : tris;
}

/** Triangle (0 or 1) of a cell under the point (fx, fz) in [0, 1] (0x49db80). */
export function layerCellTriangle(flags: number, fx: number, fz: number): 0 | 1 {
  return flags & LAYER_CELL.flip ? (fx <= fz ? 0 : 1) : 1 - fx >= fz ? 0 : 1;
}

/** Does triangle t of a cell hold movers up (not a hole)? */
export function layerTriangleSolid(flags: number, t: 0 | 1): boolean {
  return !(flags & (LAYER_CELL.hole << t));
}

/** Up-facing layers are wound counter-clockwise seen from +y; ceilings (normals down) reversed. */
function layerFacesDown(L: FloorLayer): boolean {
  let ny = 0;
  if (L.normals) for (let k = 1; k < L.normals.length; k += 4) ny += L.normals[k];
  else ny = 1;
  return ny < 0;
}

/**
 * Decode the floor layers (type 0x01): axis-aligned flat grids of 1x1-model-unit cells
 * (Riot "terrain layers"), each with landscape-texture blend weights, a baked atlas
 * image in the level .tdu and baked per-vertex colours in the .ldu.
 *
 *   u32 count; per layer:
 *   u32 uid, u32 w, u32 h, u32 0, u32 x, u32 z, f32 y, u16 len + name,
 *   u32 flags (bit 2: flat => one shared normal), ref material (0:0 => no texture data),
 *   [if material: u32 ?, u32 atlasX0, atlasX1, atlasY0, atlasY1, u32 nBlocks,
 *      nBlocks x { u32 x0, x1, z0, z1, u32 nMat, nMat x ref, u32 cols, u32 rows, u32 nMat,
 *                  nMat x cols*rows u8 weights }]
 *   normals: 4 bytes if (flags & 4) else (w+1)*(h+1) x 4 bytes,
 *   ref ldu
 */
export function parseFloorLayers(lvl: SrscFile): FloorLayer[] {
  const e = lvl.entries.find((x) => x.type === LVL_LAYERS);
  if (!e || e.size < 4) return [];
  const v = lvl.data(e);
  const n = v.getUint32(0, true);
  const out: FloorLayer[] = [];
  let p = 4;
  for (let i = 0; i < n; i++) {
    const uid = v.getUint32(p, true);
    const w = v.getUint32(p + 4, true);
    const h = v.getUint32(p + 8, true);
    const x = v.getUint32(p + 16, true);
    const z = v.getUint32(p + 20, true);
    const y = v.getFloat32(p + 24, true);
    if (w > 4096 || h > 4096) throw new Error(`bad layer ${i} size ${w}x${h}`);
    let name: string;
    [name, p] = readString(v, p + 28);
    const flags = v.getUint32(p, true);
    const mat = readRef(v, p + 4);
    p += 8;
    const layer: FloorLayer = { uid, name, w, h, x, z, y, flags, blocks: [], ldu: { id: 0, pkg: 0 } };
    if (mat.pkg) {
      layer.material = mat;
      layer.atlasRect = [v.getUint32(p + 4, true), v.getUint32(p + 8, true), v.getUint32(p + 12, true), v.getUint32(p + 16, true)];
      const nb = v.getUint32(p + 20, true);
      p += 24;
      if (nb > 4096) throw new Error(`bad layer ${i} block count ${nb}`);
      for (let b = 0; b < nb; b++) {
        const blk: LayerBlock = {
          x0: v.getUint32(p, true),
          x1: v.getUint32(p + 4, true),
          z0: v.getUint32(p + 8, true),
          z1: v.getUint32(p + 12, true),
          materials: [],
          cols: 0,
          rows: 0,
          weights: [],
        };
        const nm = v.getUint32(p + 16, true);
        p += 20;
        for (let k = 0; k < nm; k++, p += 4) blk.materials.push(readRef(v, p));
        blk.cols = v.getUint32(p, true);
        blk.rows = v.getUint32(p + 4, true);
        const nw = v.getUint32(p + 8, true);
        p += 12;
        const sz = blk.cols * blk.rows;
        for (let k = 0; k < nw; k++, p += sz) blk.weights.push(new Uint8Array(v.buffer, v.byteOffset + p, sz));
        layer.blocks.push(blk);
      }
    }
    const nn = flags & 4 ? 4 : 4 * (w + 1) * (h + 1);
    if (!(flags & 4)) layer.normals = new Int8Array(v.buffer, v.byteOffset + p, nn);
    p += nn;
    layer.ldu = readRef(v, p);
    p += 4;
    if (p > v.byteLength) throw new Error(`layer ${i} overruns block`);
    out.push(layer);
  }
  // Trailer: u32 1, then per layer u32 size + zlib stream:
  //   (w+1)*(h+1) x { u16 flags (0x100: ?), u16 edge bits, u16 height }   (height: engine y =
  //   layer.y + 2 * (height - 32768)), then w*h x 22-byte cell records (u16 flags, LAYER_CELL:
  //   the diagonal, hidden and hole triangles; then the cell's texture ref).
  if (p + 4 <= v.byteLength && v.getUint32(p, true) === 1) {
    p += 4;
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (const layer of out) {
      if (p + 4 > v.byteLength) break;
      const size = v.getUint32(p, true);
      p += 4;
      if (p + size > v.byteLength) break;
      const nv = (layer.w + 1) * (layer.h + 1), nc = layer.w * layer.h;
      try {
        const raw = inflateZlib(bytes.subarray(p, p + size), nv * 6 + nc * 22);
        if (raw.length >= nv * 6) {
          const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const heights = new Uint16Array(nv);
          for (let k = 0; k < nv; k++) heights[k] = rv.getUint16(6 * k + 4, true);
          layer.heights = heights;
          if (raw.length >= nv * 6 + nc * 22) {
            const cf = new Uint8Array(nc);
            for (let k = 0; k < nc; k++) cf[k] = raw[nv * 6 + 22 * k];
            layer.cellFlags = cf;
          }
        }
      } catch (err) {
        console.warn(`[level] layer ${layer.name}: height data not decoded`, err);
      }
      p += size;
    }
  }
  return out;
}

const readRef = (v: DataView, o: number): ResRef => ({ id: v.getUint16(o, true), pkg: v.getUint16(o + 2, true) });

// ---------------------------------------------------------------------------

interface LduInfo {
  model: ResRef;
  colors: Uint8Array; // BGRA
}

function readLdu(ldu: SrscFile | undefined): Map<number, LduInfo> {
  const m = new Map<number, LduInfo>();
  if (!ldu) return m;
  for (const e of ldu.entries) {
    if (e.type !== LDU_COLORS || e.size < 12) continue;
    const v = ldu.data(e);
    const count = v.getUint32(8, true);
    if (12 + 4 * count > e.size) continue;
    m.set(e.id, {
      model: { id: v.getUint16(0, true), pkg: v.getUint16(2, true) },
      colors: new Uint8Array(ldu.buffer, e.offset + 12, 4 * count),
    });
  }
  return m;
}

/** Growable typed-array part builder. */
/** Visibility group of a bucket: zone (-1 = none) and spatial cell (0 = whole zone). */
interface VisGroup {
  zone: number;
  cell: number;
}

// Start small: a level has a few thousand buckets once split per zone / cell.
const BUCKET_START = 256;

/** Collision triangles of one surface / layer set (LevelData.collision), unindexed. */
class CollisionBucket {
  pos: number[] = [];
  constructor(
    readonly textureKey: string | undefined,
    readonly material: SurfaceMaterial | undefined,
    /** Undefined: the physics default for a part (`solid`). */
    readonly layers: number | undefined,
    readonly sightPass: boolean,
  ) {}
  tri(P: Float32Array, a: number, b: number, c: number) {
    for (const i of [a, b, c]) this.pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
  }
  build(): MeshPart {
    const positions = Float32Array.from(this.pos);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    const part: MeshPart = { positions, indices, textureKey: this.textureKey, material: this.material };
    if (this.layers !== undefined) part.layers = this.layers;
    if (this.sightPass) part.sightPass = true;
    return part;
  }
}

class Bucket {
  pos = new Float32Array(3 * BUCKET_START);
  nrm = new Float32Array(3 * BUCKET_START);
  uv = new Float32Array(2 * BUCKET_START);
  col = new Float32Array(4 * BUCKET_START);
  idx = new Uint32Array(3 * BUCKET_START);
  nv = 0;
  ni = 0;
  /** Splat weights (8 per vertex), only for floor-layer buckets with splats. */
  sw?: Float32Array;
  constructor(
    readonly textureKey: string | undefined,
    readonly material: SurfaceMaterial | undefined,
    readonly splat: LandscapeSplat[] | undefined,
    readonly group: VisGroup,
  ) {
    if (splat) this.sw = new Float32Array(8 * BUCKET_START);
  }
  reserve(addV: number, addI: number) {
    const grow = <T extends Float32Array | Uint32Array>(a: T, need: number): T => {
      if (need <= a.length) return a;
      let len = a.length;
      while (len < need) len *= 2;
      const b = new (a.constructor as { new (n: number): T })(len);
      b.set(a);
      return b;
    };
    this.pos = grow(this.pos, 3 * (this.nv + addV));
    this.nrm = grow(this.nrm, 3 * (this.nv + addV));
    this.uv = grow(this.uv, 2 * (this.nv + addV));
    this.col = grow(this.col, 4 * (this.nv + addV));
    if (this.sw) this.sw = grow(this.sw, 8 * (this.nv + addV));
    this.idx = grow(this.idx, this.ni + addI);
  }
  build(): MeshPart {
    return {
      positions: this.pos.slice(0, 3 * this.nv),
      normals: this.nrm.slice(0, 3 * this.nv),
      uvs: this.uv.slice(0, 2 * this.nv),
      colors: this.col.slice(0, 4 * this.nv),
      indices: this.idx.slice(0, this.ni),
      textureKey: this.textureKey,
      material: this.material,
      splat: this.splat,
      splatWeights: this.sw?.slice(0, 8 * this.nv),
      zone: this.group.zone >= 0 ? this.group.zone : undefined,
      cell: this.group.cell || undefined,
    };
  }
}

type Mat3 = number[]; // row-major 3x3

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[3 * i + j] += a[3 * i + k] * b[3 * k + j];
  return r;
};
const D = Math.PI / 180;
const rotY = (a: number): Mat3 => {
  const c = Math.cos(a * D), s = Math.sin(a * D);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const rotX = (a: number): Mat3 => {
  const c = Math.cos(a * D), s = Math.sin(a * D);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const rotZ = (a: number): Mat3 => {
  const c = Math.cos(a * D), s = Math.sin(a * D);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const AXIS: Mat3 = rotY(-90);

/** Engine-space rotation (without scale) for an instance. */
export function instanceRotation(rot: [number, number, number]): Mat3 {
  return mul(AXIS, mul(rotY(rot[1]), mul(rotX(rot[0]), rotZ(rot[2]))));
}

/** Engine-space position -> output (model units, right-handed). */
export function toOutputSpace(p: [number, number, number]): [number, number, number] {
  return [p[0] / WORLD_SCALE, p[1] / WORLD_SCALE, p[2] / WORLD_SCALE];
}

/**
 * Placed objects whose .ldu ref is a stale copy of another instance's: the record is shared by
 * several instances, names the model of one of them, and this one's template names a different
 * model. Such an object uses its template's model, unlit by the record.
 *
 * The engine's .ldu record loader (SUFFERING.EXE 0x487610) reads the record's model ref and
 * drops it (only the colours are kept, as the object's type-9 resource): an instance's model is
 * not the record's [verified]. The port still takes the record's model elsewhere (about 150
 * instances whose record names another model than their template; not traced which one the
 * engine draws). The shared records are the clear case: 5b's Breakables 31ed / 31ee (template
 * model 7:251) carry the refs of the gallery's Static Objects fde / 1155 (28:373 / 28:387, 20 m
 * pieces) and stood as boxes across the upper corridor.
 */
export function staleLduRefs(
  objects: readonly LevelObject[],
  levelPkg: number | undefined,
  recordModel: (id: number) => ResRef | undefined,
  templateModel: (o: LevelObject) => ResRef | undefined,
): Set<number> {
  const out = new Set<number>();
  if (levelPkg === undefined) return out;
  const byRef = new Map<number, LevelObject[]>();
  for (const o of objects) if (o.ref.pkg === levelPkg && recordModel(o.ref.id)) byRef.set(o.ref.id, [...(byRef.get(o.ref.id) ?? []), o]);
  const same = (a: ResRef | undefined, b: ResRef | undefined) => !!a && !!b && a.pkg === b.pkg && a.id === b.id;
  for (const [id, group] of byRef) {
    if (group.length < 2) continue;
    const m = recordModel(id)!;
    if (!group.some((o) => same(templateModel(o), m))) continue;
    for (const o of group) {
      const t = templateModel(o);
      if (t && !same(t, m)) out.add(o.uid);
    }
  }
  return out;
}

function inferLevelPackage(objects: LevelObject[], ldu: Map<number, LduInfo>): number | undefined {
  const score = new Map<number, number>();
  for (const o of objects) {
    if (o.ref.pkg && ldu.has(o.ref.id)) score.set(o.ref.pkg, (score.get(o.ref.pkg) ?? 0) + 1);
  }
  let best: number | undefined, bestN = 0;
  for (const [k, n] of score) if (n > bestN) [best, bestN] = [k, n];
  return best;
}

export function parseLevel(lvl: SrscFile, name: string, extras: LevelExtras = {}): LevelData {
  const header = readLevelHeader(lvl);
  const objects = parseLevelObjects(lvl);
  const pkgs: PackageSet =
    extras.packages instanceof Map ? extras.packages : new Map((extras.packages ?? []).map((p) => [p.id, p]));
  const ldu = readLdu(extras.ldu);
  const levelPkg = extras.levelPackageId ?? inferLevelPackage(objects, ldu);
  const staleLdu = staleLduRefs(objects, levelPkg, (id) => ldu.get(id)?.model, (o) => templateModelRef(pkgs, o.template));
  const includeUnlit = extras.includeUnlit ?? true;

  // Default colour for instances without baked lighting.
  let unlit = extras.unlitColor;
  if (!unlit) {
    const samples: number[] = [];
    for (const { colors } of ldu.values()) {
      for (let i = 0; i < colors.length && samples.length < 200000; i += 4 * 7) {
        samples.push(colors[i] + colors[i + 1] + colors[i + 2]);
      }
    }
    samples.sort((a, b) => a - b);
    const g = samples.length ? samples[samples.length >> 1] / 3 / 255 : 0.5;
    unlit = [g, g, g, 1];
  }

  const models = new Map<string, RiotModel | null>();
  const getModel = (r: ResRef) => {
    const k = `${r.pkg}:${r.id}`;
    let m = models.get(k);
    if (m === undefined) {
      m = readModel(pkgs, r) ?? null;
      models.set(k, m);
    }
    return m;
  };

  const buckets = new Map<string, Bucket>();
  // One bucket per distinct surface (texture + blend mode / tint / layers) per visibility
  // group (zone + cell, see groupOf).
  const nonSolid = new Set<Bucket>();
  const moverPass = new Set<Bucket>();
  const bucket = (key: string | undefined, material: SurfaceMaterial | undefined, splat: LandscapeSplat[] | undefined, group: VisGroup, solid = true, pass = false) => {
    const k = `${key ?? ''}|${materialSignature(material)}|${splat?.map((s) => `${s.texture}/${s.tiling}/${s.fade}`).join(',') ?? ''}|${group.zone}|${group.cell}${solid ? '' : '|ns'}${pass ? '|mp' : ''}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = new Bucket(key, material, splat, group)));
    if (!solid) nonSolid.add(b);
    if (pass) moverPass.add(b);
    return b;
  };
  // Collision geometry (LevelExtras.collisionOf): placed objects' collision models by surface,
  // layers and sight flag, and the floor layers' buckets as drawn.
  const collisionBuckets = new Map<string, CollisionBucket>();
  /** Floor-layer triangles that are not drawn but hold movers up (hiddenLayerCollision). */
  let hiddenFloor: CollisionBucket | undefined;
  const collisionBucket = (key: string | undefined, material: SurfaceMaterial | undefined, layers: number, sightPass: boolean) => {
    const k = `${key ?? ''}|${material?.key ?? ''}|${layers}|${sightPass ? 1 : 0}`;
    let c = collisionBuckets.get(k);
    if (!c) collisionBuckets.set(k, (c = new CollisionBucket(key, material, layers, sightPass)));
    return c;
  };
  const landscape = new Set<Bucket>();
  // Visibility group of a uid at an output-space position.
  const zoneOf = extras.zoneOf;
  const chunk = extras.chunkSize ?? 48;
  const wideZones = new Set<number>();
  if (zoneOf && chunk > 0) {
    // Zone extents from their members' origins (objects) are enough to pick the wide ones.
    const ext = new Map<number, number[]>();
    for (const o of objects) {
      const z = zoneOf.get(o.uid);
      if (z === undefined) continue;
      const e = ext.get(z) ?? ext.set(z, [Infinity, Infinity, -Infinity, -Infinity]).get(z)!;
      const x = o.position[0] / WORLD_SCALE, zz = o.position[2] / WORLD_SCALE;
      e[0] = Math.min(e[0], x); e[1] = Math.min(e[1], zz); e[2] = Math.max(e[2], x); e[3] = Math.max(e[3], zz);
    }
    for (const [z, e] of ext) if (e[2] - e[0] > 2 * chunk || e[3] - e[1] > 2 * chunk) wideZones.add(z);
  }
  const groupOf = (uid: number, x: number, z: number): VisGroup => {
    const zone = zoneOf?.get(uid) ?? -1;
    if (chunk <= 0 || (zone >= 0 && !wideZones.has(zone))) return { zone, cell: 0 };
    const cx = Math.floor(x / chunk) + 1024, cz = Math.floor(z / chunk) + 1024;
    return { zone, cell: cx * 2048 + cz };
  };

  let spawn: LevelData['spawn'];

  for (const o of objects) {
    // Some levels hold a second, flag-0x8 Player instance; the plain one is the start.
    if (o.template.id === PLAYER_TEMPLATE.id && o.template.pkg === PLAYER_TEMPLATE.pkg && !(o.flags & 0x8) && !spawn) {
      const [x, y, z] = toOutputSpace(o.position);
      const R = instanceRotation(o.rotation);
      // Objects face model -Z (verified against open space at several level starts);
      // Three yaw 0 looks down -Z.
      const fx = R[2], fz = R[8];
      spawn = { position: [x, y + 1.6, z], yaw: Math.atan2(fx, fz) };
    }

    if (extras.excludeUids?.has(o.uid)) continue;
    let modelRef: ResRef | undefined;
    let colors: Uint8Array | undefined;
    const lit = levelPkg !== undefined && o.ref.pkg === levelPkg && !staleLdu.has(o.uid) ? ldu.get(o.ref.id) : undefined;
    if (lit) {
      colors = lit.colors;
      modelRef = lit.model.pkg ? lit.model : templateModelRef(pkgs, o.template);
    } else if (includeUnlit && o.flags & 0x80 && o.template.pkg !== SYSTEM_PKG) {
      modelRef = templateModelRef(pkgs, o.template);
    }
    if (!modelRef || modelRef.pkg === SYSTEM_PKG || extras.includeObjects === false) continue;
    // Skinned characters are built as animated actors by the app, not baked into static geometry.
    if (hasSkeleton(pkgs.get(modelRef.pkg)?.mdu, modelRef.id)) continue;
    const m = getModel(modelRef);
    if (!m) continue;
    if (colors && colors.length !== 4 * m.vertexCount) colors = undefined;

    const s = o.scale ?? [1, 1, 1];
    const R = instanceRotation(o.rotation);
    // Position matrix M = R·S (scaled by WORLD_SCALE later), normal matrix N = R·S^-1.
    const M = [R[0] * s[0], R[1] * s[1], R[2] * s[2], R[3] * s[0], R[4] * s[1], R[5] * s[2], R[6] * s[0], R[7] * s[1], R[8] * s[2]];
    const inv = s.map((x) => (x !== 0 ? 1 / x : 0));
    const N = [R[0] * inv[0], R[1] * inv[1], R[2] * inv[2], R[3] * inv[0], R[4] * inv[1], R[5] * inv[2], R[6] * inv[0], R[7] * inv[1], R[8] * inv[2]];
    const flip = s[0] * s[1] * s[2] < 0;
    const [ox, oy, oz] = toOutputSpace(o.position);
    const group = groupOf(o.uid, ox, oz);
    const solid = !extras.nonSolidUids?.has(o.uid);
    const pass = !!extras.moverPassUids?.has(o.uid);
    // No .ldu colours: the engine lights the object on the CPU when it loads (static-light.ts).
    let pre: LoadTimeSet | undefined;
    if (!colors && extras.staticLighting) {
      let r2 = 0;
      for (let k = 0; k < m.positions.length; k += 3) {
        const px = m.positions[k], py = m.positions[k + 1], pz = m.positions[k + 2];
        const wx = M[0] * px + M[1] * py + M[2] * pz, wy = M[3] * px + M[4] * py + M[5] * pz, wz = M[6] * px + M[7] * py + M[8] * pz;
        r2 = Math.max(r2, wx * wx + wy * wy + wz * wz);
      }
      // Every light on at load, of the groups holding the object (static-light.ts): the pass
      // runs at its first draw, after the level has loaded.
      pre = extras.staticLighting.setFor(ox, oy, oz, Math.sqrt(r2), o.uid);
    }

    for (const sm of m.submeshes) {
      if (!sm.indices.length) continue;
      const b = bucket(sm.textureKey, sm.material, undefined, group, solid, pass);
      // Only emit the corners this submesh uses.
      const remap = new Map<number, number>();
      const used: number[] = [];
      for (const ci of sm.indices) if (!remap.has(ci)) (remap.set(ci, used.length), used.push(ci));
      b.reserve(used.length, sm.indices.length);
      const base = b.nv;
      for (let j = 0; j < used.length; j++) {
        const ci = used[j];
        const px = m.positions[3 * ci], py = m.positions[3 * ci + 1], pz = m.positions[3 * ci + 2];
        const nx = m.normals[3 * ci], ny = m.normals[3 * ci + 1], nz = m.normals[3 * ci + 2];
        const w = base + j;
        b.pos[3 * w] = ox + M[0] * px + M[1] * py + M[2] * pz;
        b.pos[3 * w + 1] = oy + M[3] * px + M[4] * py + M[5] * pz;
        b.pos[3 * w + 2] = oz + M[6] * px + M[7] * py + M[8] * pz;
        let tx = N[0] * nx + N[1] * ny + N[2] * nz;
        let ty = N[3] * nx + N[4] * ny + N[5] * nz;
        let tz = N[6] * nx + N[7] * ny + N[8] * nz;
        const l = Math.hypot(tx, ty, tz) || 1;
        tx /= l; ty /= l; tz /= l;
        b.nrm[3 * w] = tx;
        b.nrm[3 * w + 1] = ty;
        b.nrm[3 * w + 2] = tz;
        b.uv[2 * w] = m.uvs[2 * ci];
        b.uv[2 * w + 1] = m.uvs[2 * ci + 1];
        if (colors) {
          const sv = 4 * m.source[ci];
          b.col[4 * w] = colors[sv + 2] / 255;
          b.col[4 * w + 1] = colors[sv + 1] / 255;
          b.col[4 * w + 2] = colors[sv] / 255;
          b.col[4 * w + 3] = colors[sv + 3] / 255;
        } else if (pre) {
          extras.staticLighting!.shadeSet(pre, b.pos[3 * w], b.pos[3 * w + 1], b.pos[3 * w + 2], tx, ty, tz, b.col, 4 * w);
          b.col[4 * w + 3] = 1;
        } else {
          b.col.set(unlit, 4 * w);
        }
      }
      const idx = sm.indices;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = base + remap.get(idx[t])!, c1 = base + remap.get(idx[t + 1])!, c2 = base + remap.get(idx[t + 2])!;
        b.idx[b.ni++] = a;
        // Engine triangles are CW-front: reverse to CCW (unless a negative scale mirrored them).
        b.idx[b.ni++] = flip ? c1 : c2;
        b.idx[b.ni++] = flip ? c2 : c1;
      }
      b.nv += used.length;
    }

    // The original's collision geometry of the object (docs/game-logic.md §14.10).
    const how = solid ? extras.collisionOf?.(o) : null;
    const mdu = how ? pkgs.get(modelRef.pkg)?.mdu : undefined;
    if (how && mdu) {
      const sMax = Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
      // Box leaves take the material of the model's largest submesh (the surface footsteps and
      // impacts read) [inferred].
      const main = m.submeshes.reduce((a, sm) => (sm.indices.length > (a?.indices.length ?? -1) ? sm : a), m.submeshes[0] as (typeof m.submeshes)[number] | undefined);
      const bySlot = new Map(m.submeshes.map((sm) => [sm.materialIndex, sm]));
      const emit = (mesh: CollisionMesh | undefined, layers: number) => {
        if (!mesh || !layers) return;
        const P = mesh.positions;
        const world = new Float32Array(P.length);
        for (let k = 0; k < P.length; k += 3) {
          const px = P[k], py = P[k + 1], pz = P[k + 2];
          world[k] = ox + M[0] * px + M[1] * py + M[2] * pz;
          world[k + 1] = oy + M[3] * px + M[4] * py + M[5] * pz;
          world[k + 2] = oz + M[6] * px + M[7] * py + M[8] * pz;
        }
        for (let t = 0; t < mesh.faces.length; t++) {
          const fi = mesh.faces[t];
          const sm = fi >= 0 ? (bySlot.get(faceMaterialIndex(mdu, modelRef.id, fi)) ?? main) : main;
          collisionBucket(sm?.textureKey, sm?.material, layers, how.sightPass).tri(world, mesh.indices[3 * t], mesh.indices[3 * t + 1], mesh.indices[3 * t + 2]);
        }
      };
      if (readModelCollision(mdu, modelRef.id)) {
        emit(moverCollisionMesh(mdu, modelRef.id, sMax), how.layers);
        emit(rayOnlyCollisionMesh(mdu, modelRef.id), how.rayLayers);
      }
    }
  }

  // Floor layers: flat cell grids textured with their baked atlas.
  if (extras.includeLayers ?? true) {
    let layers: FloorLayer[] = [];
    try {
      layers = parseFloorLayers(lvl);
    } catch (err) {
      console.warn('[level] floor layers not decoded:', err);
    }
    for (const L of layers) emitLayer(L);
  }

  function emitLayer(L: FloorLayer) {
    const drawn = !!L.material && L.blocks.length > 0;
    if (drawn) drawLayer(L);
    if (extras.collisionOf) hiddenLayerCollision(L, drawn);
  }

  /**
   * The triangles of a floor layer that are not drawn but are not holes either (LAYER_CELL):
   * collision only. Drawn cells collide as drawn (the `landscape` buckets). Without cell flags
   * nothing is known of the undrawn cells, and they stay out.
   */
  function hiddenLayerCollision(L: FloorLayer, drawn: boolean) {
    const F = L.cellFlags;
    if (!F) return;
    const W = L.w, down = layerFacesDown(L);
    let bk: CollisionBucket | undefined;
    for (let j = 0; j < L.h; j++) {
      for (let i = 0; i < W; i++) {
        const f = F[j * W + i];
        if (drawn && !(f & 0xf0)) continue;
        const tris = layerCellTriangles(f, down);
        for (const t of [0, 1] as const) {
          if (!layerTriangleSolid(f, t)) continue;
          bk ??= hiddenFloor ??= new CollisionBucket(undefined, undefined, extras.layerCollision, false);
          for (const [di, dj] of tris[t]) bk.pos.push(L.x + i + di, layerVertexY(L, i + di, j + dj) / WORLD_SCALE, L.z + j + dj);
        }
      }
    }
  }

  function drawLayer(L: FloorLayer) {
    if (!L.material) return;
    const mat = readMaterial(pkgs, L.material);
    const texKey = mat?.layers[0]?.texture;
    const tex = texKey ? { pkg: +texKey.split(':')[0], id: +texKey.split(':')[1] } : undefined;
    // Atlas size from the .tdu header (u32 width, u32 height).
    let atlas: [number, number] | undefined;
    if (tex) {
      const f = pkgs.get(tex.pkg)?.tdu;
      const te = findEntry(f, TDU_TEXTURE, tex.id);
      if (f && te && te.size >= 8) atlas = [f.data(te).getUint32(0, true), f.data(te).getUint32(4, true)];
    }
    const W = L.w, H = L.h, VW = W + 1;
    // Which cells are drawn: any block weight grid with bit 0x10 at the cell's min corner.
    const cell = new Uint8Array(W * H);
    // Cells with hidden (0x30) or hole (0xc0) triangles are not drawn (they match the blend-weight
    // presence bits exactly); the hidden ones still collide (hiddenLayerCollision).
    if (L.cellFlags) for (let k = 0; k < W * H; k++) cell[k] = L.cellFlags[k] & 0xf0 ? 0 : 1;
    else for (const b of L.blocks) {
      for (let j = b.z0; j < b.z1 && j < H; j++) {
        for (let i = b.x0; i < b.x1 && i < W; i++) {
          const k = (j - b.z0) * b.cols + (i - b.x0);
          for (const g of b.weights) if (g[k] & 0x10) cell[j * W + i] = 1;
        }
      }
    }
    const lit = L.ldu.pkg === levelPkg ? ldu.get(L.ldu.id) : undefined;
    const cols = lit && lit.colors.length === 4 * VW * (H + 1) ? lit.colors : undefined;
    // No .ldu colours: lit on the CPU at load like placed models (static-light.ts, 0x4c1900).
    let pre: LoadTimeSet | undefined;
    if (!cols && extras.staticLighting) {
      const cx = L.x + W / 2, cz = L.z + H / 2, cy = layerVertexY(L, W >> 1, H >> 1) / WORLD_SCALE;
      pre = extras.staticLighting.setFor(cx, cy, cz, Math.hypot(W, H) / 2 + 1);
    }
    const atlasKey = tex && atlas ? refKey(tex) : undefined;
    const atlasMat = tex && atlas ? mat : undefined;
    const down = layerFacesDown(L);

    /** Write layer vertex (i, j) into bucket slot w. */
    const vertex = (bk: Bucket, w: number, i: number, j: number) => {
      const vi = j * VW + i;
      bk.pos[3 * w] = L.x + i;
      bk.pos[3 * w + 1] = layerVertexY(L, i, j) / WORLD_SCALE;
      bk.pos[3 * w + 2] = L.z + j;
      let nx = 0, nyv = 1, nz = 0;
      if (L.normals) {
        nx = L.normals[4 * vi] / 127;
        nyv = L.normals[4 * vi + 1] / 127;
        nz = L.normals[4 * vi + 2] / 127;
        const l = Math.hypot(nx, nyv, nz);
        if (l > 0) (nx /= l), (nyv /= l), (nz /= l);
        else nyv = 1;
      }
      bk.nrm[3 * w] = nx;
      bk.nrm[3 * w + 1] = nyv;
      bk.nrm[3 * w + 2] = nz;
      if (atlas && L.atlasRect) {
        const [ax0, ax1, ay0, ay1] = L.atlasRect;
        bk.uv[2 * w] = (ax0 + ((ax1 - ax0 + 1) * i) / W) / atlas[0];
        bk.uv[2 * w + 1] = (ay0 + ((ay1 - ay0 + 1) * j) / H) / atlas[1];
      } else {
        bk.uv[2 * w] = i;
        bk.uv[2 * w + 1] = j;
      }
      if (cols) {
        bk.col[4 * w] = cols[4 * vi + 2] / 255;
        bk.col[4 * w + 1] = cols[4 * vi + 1] / 255;
        bk.col[4 * w + 2] = cols[4 * vi] / 255;
        bk.col[4 * w + 3] = cols[4 * vi + 3] / 255;
      } else if (pre) {
        extras.staticLighting!.shadeSet(pre, bk.pos[3 * w], bk.pos[3 * w + 1], bk.pos[3 * w + 2], nx, nyv, nz, bk.col, 4 * w);
        bk.col[4 * w + 3] = 1;
      } else bk.col.set(unlit!, 4 * w);
    };

    /** Emit cells [x0, x1) x [z0, z1) that pass `take`, with optional splat weights. */
    const emitCells = (
      bk: Bucket,
      x0: number, x1: number, z0: number, z1: number,
      take: (i: number, j: number) => boolean,
      weights?: (i: number, j: number, out: Float32Array, o: number) => void,
    ) => {
      const gw = x1 - x0 + 1, gh = z1 - z0 + 1;
      bk.reserve(gw * gh, 6 * (x1 - x0) * (z1 - z0));
      const base = bk.nv;
      for (let j = z0; j <= z1; j++) {
        for (let i = x0; i <= x1; i++) {
          const w = base + (j - z0) * gw + (i - x0);
          vertex(bk, w, i, j);
          if (weights && bk.sw) weights(i, j, bk.sw, 8 * w);
        }
      }
      for (let j = z0; j < z1; j++) {
        for (let i = x0; i < x1; i++) {
          if (!take(i, j)) continue;
          // Output z = L.z + j: corner (di, dj) is vertex base + (j - z0 + dj) * gw + (i - x0 + di).
          const a = base + (j - z0) * gw + (i - x0);
          for (const tri of layerCellTriangles(L.cellFlags?.[j * W + i] ?? 0, down)) for (const [di, dj] of tri) bk.idx[bk.ni++] = a + dj * gw + di;
        }
      }
      bk.nv += gw * gh;
    };

    // Each block blends up to 6 landscape textures (per-vertex weights 0..4) over the atlas.
    const claimed = new Uint8Array(W * H);
    for (const b of L.blocks) {
      const x0 = Math.min(b.x0, W), x1 = Math.min(b.x1, W), z0 = Math.min(b.z0, H), z1 = Math.min(b.z1, H);
      if (x1 <= x0 || z1 <= z0) continue;
      const take = (i: number, j: number) => {
        const k = j * W + i;
        if (!cell[k] || claimed[k]) return false;
        claimed[k] = 1;
        return true;
      };
      const splat: LandscapeSplat[] = [];
      const grids: Uint8Array[] = [];
      b.materials.forEach((m, k) => {
        const sp = atlasKey ? readLandscapeSplat(pkgs, m) : undefined;
        if (sp && b.weights[k] && splat.length < 8) (splat.push(sp), grids.push(b.weights[k]));
      });
      const ok = splat.length > 0 && b.cols === b.x1 - b.x0 + 1;
      const bk = bucket(atlasKey, atlasMat, ok ? splat : undefined, groupOf(L.uid, L.x + (x0 + x1) / 2, L.z + (z0 + z1) / 2));
      landscape.add(bk);
      emitCells(bk, x0, x1, z0, z1, take, ok
        ? (i, j, out, o) => {
            const g = (j - b.z0) * b.cols + (i - b.x0);
            for (let k = 0; k < grids.length; k++) out[o + k] = Math.min(4, grids[k][g] & 15) / 4;
          }
        : undefined);
    }
    // Drawn cells outside every block: atlas only.
    let rest = false;
    for (let k = 0; k < W * H && !rest; k++) rest = !!cell[k] && !claimed[k];
    if (rest) {
      const bk = bucket(atlasKey, atlasMat, undefined, groupOf(L.uid, L.x + W / 2, L.z + H / 2));
      landscape.add(bk);
      emitCells(bk, 0, W, 0, H, (i, j) => !!cell[j * W + i] && !claimed[j * W + i]);
    }
  }

  if (!spawn && header.camera) {
    spawn = { position: toOutputSpace(header.camera.position), yaw: 0 };
  }

  const built = new Map<Bucket, MeshPart>();
  const parts = [...buckets.values()].filter((b) => b.ni > 0).map((b) => {
    const part = b.build();
    built.set(b, part);
    return nonSolid.has(b) ? { ...part, solid: false as const } : moverPass.has(b) ? { ...part, moveSolid: false as const } : part;
  });
  // With collisionOf: the floor layers as drawn, and the objects' collision models.
  const collision = extras.collisionOf
    ? [
        ...[...landscape].flatMap((b) => (built.has(b) ? [built.get(b)!] : [])),
        ...[...collisionBuckets.values()].filter((c) => c.pos.length).map((c) => c.build()),
        ...(hiddenFloor?.pos.length ? [hiddenFloor.build()] : []),
      ]
    : undefined;

  return {
    name: header.title ? `${name} — ${header.title}` : name,
    parts,
    collision,
    spawn,
  };
}

/** Convenience: entry lookup re-export for tools. */
export { findEntry };
