// Adapter between GameFS and the format parsers.
//
// The renderer only ever calls loadLevel(); everything it needs comes back as
// engine-neutral LevelData + DecodedTexture[] (src/formats/types.ts).
//
// A level is a set of Riot "packages" (one .db id each, with .mdu/.odu/.tdu
// containers). The .lvl header lists them; parseLevel resolves model, material
// and texture references across them as (id, package) pairs, and texture keys
// come back as "pkg:id".

import type { GameFS } from './gamefs';
import { basename, dirname, joinPath } from './gamefs';
import type { DecodedTexture, LevelData, MeshPart } from '../formats/types';
import { SrscFile } from '../formats/srsc';

import { decodeTextureJob, decodeTexturesInWorkers, type TextureJob } from './texture-decode';
import { parseLevel, readLevelHeader } from '../formats/level';
import { parseEntities } from '../formats/entities';
import { staticLightingFromEntities, type StaticLighting } from '../formats/static-light';
import { buildLevelZoning, lightRegions, parseSectorTree, type LightRegion } from '../formats/visgraph';
import { findEntry, readDbId, TDU_TEXTURE, type PackageSet, type RiotPackage } from '../formats/model';

/** Pseudo-path for the built-in procedural scene (no game files needed). */
export const DEMO_LEVEL_PATH = '__demo__';

export interface LevelDependencies {
  lvl: string;
  /** "<stem>_level.tdu" — level-local textures (highest priority). */
  levelTdu?: string;
  /** "<stem>_level.ldu" — passed to parseLevel as extras.ldu (lightmaps / extra level data). */
  levelLdu?: string;
  levelDb?: string;
  /** "<chapter>.tdu/.mdu/.db" in the same folder, named after the folder. */
  chapterTdu?: string;
  chapterMdu?: string;
  chapterDb?: string;
  /**
   * .tdu files of every transitive .db dependency (World Common/*, COMMON/*),
   * in priority order (direct deps of the level/chapter first).
   */
  dependencyTdus: string[];
  /** Referenced .db dependencies that could not be found. */
  missing: string[];
}

export interface LoadedLevel {
  level: LevelData;
  textures: DecodedTexture[];
  deps?: LevelDependencies;
  /** Raw .lvl container and its packages (by .db id), for systems beyond geometry. */
  lvl?: SrscFile;
  packages?: PackageSet;
  /** Package path (relative, no extension) by .db id, e.g. to find a package's .sdu. */
  packagePaths?: Map<number, string>;
  /** Human-readable notes for the HUD (e.g. "procedural placeholder"). */
  notes: string[];
  /** "<stem>_level.ldu" (baked per-instance colours), for systems that build object meshes. */
  ldu?: SrscFile;
  /** Objects left out of the static geometry for game systems to render (see dynamicObjectProviders). */
  dynamicUids?: Set<number>;
}

export type ProgressFn = (msg: string) => void;

/**
 * Game systems register here (at import time) to claim placed objects they render and
 * collide themselves (doors, pickups, ...); those uids are excluded from the merged
 * static geometry and collision.
 */
export const dynamicObjectProviders: ((lvl: SrscFile, packages: PackageSet) => Iterable<number>)[] = [];

/**
 * Same, for placed objects that stay in the merged static geometry but must not collide
 * (water surfaces: src/game/levels/water.ts); their parts get `solid: false`.
 */
export const nonSolidObjectProviders: ((lvl: SrscFile, packages: PackageSet) => Iterable<number>)[] = [];

/**
 * Same, for placed objects that stay in the merged static geometry and in collision for sight and
 * shots, but that movers pass (Decorations: src/game/world/blockers.ts); their parts get
 * `moveSolid: false`.
 */
export const moverPassObjectProviders: ((lvl: SrscFile, packages: PackageSet) => Iterable<number>)[] = [];

export async function loadLevel(
  fs: GameFS | null,
  lvlPath: string,
  onProgress: ProgressFn = () => {},
): Promise<LoadedLevel> {
  if (!fs || lvlPath === DEMO_LEVEL_PATH) {
    return { ...buildTestLevel('Procedural test level'), notes: ['procedural demo scene'] };
  }

  onProgress('Resolving dependencies…');
  const deps = await findLevelDependencies(fs, lvlPath);

  onProgress('Reading level…');
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const ldu = deps.levelLdu ? new SrscFile(await fs.read(deps.levelLdu)) : undefined;
  const packagePaths = new Map<number, string>();
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, onProgress, packagePaths);

  const dynamicUids = new Set<number>();
  for (const provide of dynamicObjectProviders) {
    try {
      for (const uid of provide(lvl, packages)) dynamicUids.add(uid);
    } catch (err) {
      console.warn('[loader] dynamic object provider failed:', err);
    }
  }

  const nonSolidUids = new Set<number>();
  for (const provide of nonSolidObjectProviders) {
    try {
      for (const uid of provide(lvl, packages)) nonSolidUids.add(uid);
    } catch (err) {
      console.warn('[loader] non-solid object provider failed:', err);
    }
  }

  const moverPassUids = new Set<number>();
  for (const provide of moverPassObjectProviders) {
    try {
      for (const uid of provide(lvl, packages)) moverPassUids.add(uid);
    } catch (err) {
      console.warn('[loader] mover-pass object provider failed:', err);
    }
  }

  onProgress('Building geometry…');
  // Visibility zones + portals (sector tree / zone graph); geometry is bucketed per zone.
  let zoning: ReturnType<typeof buildLevelZoning>;
  try {
    zoning = buildLevelZoning(lvl, packages);
  } catch (err) {
    console.warn('[loader] visibility zones not decoded:', err);
  }
  // `?chunk=N` overrides the visibility cell size (profiling; see LevelExtras.chunkSize).
  const chunkParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('chunk') : null;
  // Geometry without .ldu colours is lit by a CPU pass at load from the lights that are on, as
  // in the engine (formats/static-light.ts). `?lighting=legacy` (engine-light.ts) keeps the old
  // fill.
  const legacy = typeof location !== 'undefined' && /(?:^|[?&])lighting=legacy(?:&|$)/.test(location.search);
  let staticLighting: StaticLighting | undefined;
  // Ambient / Directional Lights apply within their parent group of the sector tree
  // (formats/visgraph.ts lightRegions, docs/re/renderer.md §1.4).
  let regions: Map<number, LightRegion> | undefined;
  try {
    const ents = parseEntities(lvl, packages, { resolveStrings: false });
    const tree = parseSectorTree(lvl);
    if (tree) regions = lightRegions(tree, ents.filter((e) => e.className === 'Ambient Light' || e.className === 'Directional Light').map((e) => e.uid));
    // The tree also gives each Point Light its group (static-light.ts sectorGroups).
    if (!legacy) staticLighting = staticLightingFromEntities(ents, regions, tree);
  } catch (err) {
    console.warn('[loader] static lights not read:', err);
  }
  const level = parseLevel(lvl, stem(deps.lvl), {
    ldu,
    packages,
    staticLighting,
    excludeUids: dynamicUids,
    nonSolidUids,
    moverPassUids,
    zoneOf: zoning?.zoneOf,
    chunkSize: chunkParam !== null ? Number(chunkParam) : undefined,
  });
  level.visibility = zoning?.visibility;
  level.lightRegions = regions;
  level.loadLighting = staticLighting;

  onProgress('Decoding textures…');
  const textures = await decodeReferencedTexturesAsync(level, packages);
  return { level, textures, deps, lvl, packages, packagePaths, notes: [`${packages.size} packages`], ldu, dynamicUids };
}

/**
 * Load every package listed in a .lvl header. Paths are relative to the .lvl
 * folder, backslashed and extension-less; each package's .db carries its id.
 */
type LoadedPackage = RiotPackage & { xdu?: SrscFile; qdu?: SrscFile };

/**
 * Packages of the previous loadPackages call per file system, by package path: a level
 * transition reuses the shared ones (World Common, COMMON/*: ~100 MB) instead of reading
 * them again. Only the latest level's set is kept.
 */
const packageCache = new WeakMap<GameFS, Map<string, Promise<{ id: number | undefined; pkg?: LoadedPackage }>>>();

export async function loadPackages(
  fs: GameFS,
  lvlDir: string,
  dependencies: string[],
  onProgress: ProgressFn,
  pathsOut?: Map<number, string>,
): Promise<PackageSet> {
  const packages: PackageSet = new Map();
  const readSrsc = async (path: string | undefined) => (path ? new SrscFile(await fs.read(path)) : undefined);
  const previous = packageCache.get(fs) ?? new Map();
  const current = new Map<string, Promise<{ id: number | undefined; pkg?: LoadedPackage }>>();
  const load = async (base: string): Promise<{ id: number | undefined; pkg?: LoadedPackage }> => {
    const db = await fs.resolve(`${base}.db`);
    if (!db) {
      console.warn(`[loader] missing package ${base}`);
      return { id: undefined };
    }
    const id = readDbId(new TextDecoder('latin1').decode(await fs.read(db)));
    if (id === undefined) return { id };
    onProgress(`Loading ${basename(base)}…`);
    // .xdu (strings) and .qdu (STOMP sequences) are small; gameplay systems read them
    // through the same package map (see EntityPackage in formats/entities.ts).
    // .wdu: waveforms (material UV scrolling; formats/model.ts readWaveform).
    const ext = ['mdu', 'odu', 'tdu', 'adu', 'xdu', 'qdu', 'wdu'] as const;
    const files = await Promise.all(ext.map(async (e) => readSrsc(await fs.resolve(`${base}.${e}`))));
    const [mdu, odu, tdu, adu, xdu, qdu, wdu] = files;
    return { id, pkg: { id, name: basename(base), mdu, odu, tdu, adu, xdu, qdu, wdu } };
  };
  // All packages load in parallel; the map keeps the dependency order.
  const bases = dependencies.map((dep) => joinPath(lvlDir, dep));
  for (const base of bases) {
    if (current.has(base)) continue;
    const p = previous.get(base) ?? load(base);
    current.set(base, p);
    // A failed read is not cached.
    p.catch(() => current.delete(base));
  }
  packageCache.set(fs, current);
  const pending = bases.map((base) => [base, current.get(base)!] as const);
  for (const [base, p] of pending) {
    const { id, pkg } = await p;
    if (id === undefined || !pkg || packages.has(id)) continue;
    packages.set(id, pkg);
    pathsOut?.set(id, base);
  }
  return packages;
}

/** Every texture key a part draws with (base texture, material layers, animation frames, floor splats, lightmap). */
export function partTextureKeys(part: MeshPart): string[] {
  const keys: string[] = [];
  if (part.textureKey) keys.push(part.textureKey);
  if (part.lightmapKey) keys.push(part.lightmapKey);
  for (const l of [...(part.material?.layers ?? []), ...(part.material?.fallback ? [part.material.fallback] : [])]) {
    if (l.texture) keys.push(l.texture);
    if (l.frames) keys.push(...l.frames);
  }
  for (const sp of part.splat ?? []) keys.push(sp.texture);
  return keys;
}

/**
 * Decode only the textures the level references. Engine UVs address the
 * stored (bottom-up) rows directly, so textures keep their stored row order.
 * Keys whose package or .tdu entry is missing are reported (the renderer draws them
 * with its magenta checker).
 */
export function decodeReferencedTextures(level: LevelData, packages: PackageSet): DecodedTexture[] {
  const { jobs, missing } = textureJobs(level, packages);
  const textures: DecodedTexture[] = [];
  for (const job of jobs) {
    const tex = decodeTextureJob(job);
    if (tex) textures.push(tex);
    else missing.push(job.key);
  }
  if (missing.length) console.warn(`[loader] ${missing.length}/${jobs.length + missing.length} texture keys not found:`, missing);
  return textures;
}

/** decodeReferencedTextures on worker threads when available (the result is identical). */
export async function decodeReferencedTexturesAsync(level: LevelData, packages: PackageSet): Promise<DecodedTexture[]> {
  if (typeof Worker === 'undefined') return decodeReferencedTextures(level, packages);
  const { jobs, missing } = textureJobs(level, packages);
  const decoded = await decodeTexturesInWorkers(jobs);
  const textures: DecodedTexture[] = [];
  decoded.forEach((tex, i) => (tex ? textures.push(tex) : missing.push(jobs[i].key)));
  if (missing.length) console.warn(`[loader] ${missing.length}/${jobs.length + missing.length} texture keys not found:`, missing);
  return textures;
}

function textureJobs(level: LevelData, packages: PackageSet): { jobs: TextureJob[]; missing: string[] } {
  const keys = new Set<string>();
  for (const part of level.parts) for (const k of partTextureKeys(part)) keys.add(k);
  const jobs: TextureJob[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const [pkg, id] = key.split(':').map(Number);
    const tdu = packages.get(pkg)?.tdu;
    const entry = findEntry(tdu, TDU_TEXTURE, id);
    if (!tdu || !entry) missing.push(key);
    else jobs.push({ key, type: entry.type, id: entry.id, bytes: tdu.bytes(entry) });
  }
  return { jobs, missing };
}

export function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

/** Parse a Riot Engine .db text file and return its dependency entries (raw, backslashed). */
export function parseDb(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const i = lines.findIndex((l) => /^dependencies\s+\d+/i.test(l));
  if (i < 0) return [];
  const n = parseInt(lines[i].split(/\s+/)[1], 10);
  return lines.slice(i + 1, i + 1 + n).filter(Boolean);
}

/**
 * Locate the sibling files of a .lvl and walk .db dependencies transitively.
 *
 *   LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl
 *   LEVELS/1 PrisonDeathRow/1a PrisonDeathRow_level.{tdu,ldu,db}
 *   LEVELS/1 PrisonDeathRow/1 PrisonDeathRow.{tdu,mdu,db}       (chapter-wide)
 *   .db: "dependencies N" followed by N paths like
 *        ..\..\World Common\Prison Common\Prison Common   (relative to the .db, no extension)
 */
export async function findLevelDependencies(fs: GameFS, lvlPath: string): Promise<LevelDependencies> {
  const dir = dirname(lvlPath);
  const s = stem(lvlPath);
  const chapter = basename(dir);
  const at = (name: string) => fs.resolve(joinPath(dir, name));

  const deps: LevelDependencies = {
    lvl: (await fs.resolve(lvlPath)) ?? lvlPath,
    levelTdu: await at(`${s}_level.tdu`),
    levelLdu: await at(`${s}_level.ldu`),
    levelDb: await at(`${s}_level.db`),
    chapterTdu: await at(`${chapter}.tdu`),
    chapterMdu: await at(`${chapter}.mdu`),
    chapterDb: await at(`${chapter}.db`),
    dependencyTdus: [],
    missing: [],
  };

  // BFS over .db files. Paths in .db files are relative to the .db's folder.
  const queue = [deps.levelDb, deps.chapterDb].filter((p): p is string => !!p);
  const seen = new Set(queue.map((p) => p.toLowerCase()));
  while (queue.length) {
    const db = queue.shift()!;
    let text: string;
    try {
      text = new TextDecoder('latin1').decode(await fs.read(db));
    } catch {
      continue;
    }
    for (const ref of parseDb(text)) {
      const base = joinPath(dirname(db), ref);
      const depDb = await fs.resolve(`${base}.db`);
      const depTdu = await fs.resolve(`${base}.tdu`);
      if (!depDb && !depTdu) {
        deps.missing.push(base);
        continue;
      }
      if (depTdu && !deps.dependencyTdus.some((p) => p.toLowerCase() === depTdu.toLowerCase())) {
        deps.dependencyTdus.push(depTdu);
      }
      if (depDb && !seen.has(depDb.toLowerCase())) {
        seen.add(depDb.toLowerCase());
        queue.push(depDb);
      }
    }
  }
  return deps;
}

/** All .lvl files grouped by their chapter folder, naturally sorted. */
export function groupLevels(paths: string[]): { chapter: string; levels: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    if (!/\.lvl$/i.test(p)) continue;
    const ch = basename(dirname(p)) || '(root)';
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch)!.push(p);
  }
  const nat = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...groups]
    .sort(([a], [b]) => nat.compare(a, b))
    .map(([chapter, levels]) => ({ chapter, levels: levels.sort((a, b) => nat.compare(a, b)) }));
}

// ---------------------------------------------------------------------------
// Procedural test level: a few boxy corridors/rooms with checker textures,
// lightmap-ish uvs2 and vertex-colour grime, exercising every MeshPart field.

function checker(
  key: string,
  size: number,
  a: [number, number, number],
  b: [number, number, number],
  cells: number,
  opts: { alphaHoles?: boolean; grime?: number } = {},
): DecodedTexture {
  const rgba = new Uint8Array(size * size * 4);
  let seed = key.length * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cell = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const c = on ? a : b;
      const n = 1 - (opts.grime ?? 0.15) * rnd();
      const i = (y * size + x) * 4;
      // Mortar lines.
      const edge = x % cell < 1 || y % cell < 1 ? 0.6 : 1;
      rgba[i] = c[0] * n * edge;
      rgba[i + 1] = c[1] * n * edge;
      rgba[i + 2] = c[2] * n * edge;
      let alpha = 255;
      if (opts.alphaHoles) {
        // Chain-link / grate pattern.
        const gx = x % 16, gy = y % 16;
        alpha = gx < 3 || gy < 3 ? 255 : 0;
      }
      rgba[i + 3] = alpha;
    }
  }
  return { key, name: key, width: size, height: size, rgba, hasAlpha: !!opts.alphaHoles };
}

function lightmapTexture(): DecodedTexture {
  const size = 64;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - size / 2) / (size / 2), dy = (y - size / 2) / (size / 2);
      const v = Math.max(0.15, 1 - Math.sqrt(dx * dx + dy * dy)) * 255;
      const i = (y * size + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v * 0.85;
      rgba[i + 2] = v * 0.6;
      rgba[i + 3] = 255;
    }
  }
  return { key: 'lm_pool', width: size, height: size, rgba, hasAlpha: false };
}

class PartBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  uv2: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  constructor(
    readonly textureKey: string,
    readonly lightmapKey?: string,
  ) {}

  /** Quad from corner o spanned by u and v (counter-clockwise when viewed from the normal side). */
  quad(o: number[], u: number[], v: number[], texScale: number, shade = 1) {
    const base = this.pos.length / 3;
    const n = normalize(cross(u, v));
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const [a, b] of corners) {
      this.pos.push(o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b);
      this.nrm.push(...n);
      this.uv.push((a * lu) / texScale, (1 - b) * (lv / texScale));
      this.uv2.push(a, b);
      // Darker toward the floor/corners for a bit of baked grime.
      const g = shade * (0.55 + 0.45 * b);
      this.col.push(g, g * 0.95, g * 0.9, 1);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): MeshPart {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uvs: new Float32Array(this.uv),
      uvs2: this.lightmapKey ? new Float32Array(this.uv2) : undefined,
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx),
      textureKey: this.textureKey,
      lightmapKey: this.lightmapKey,
    };
  }
}

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: number[]) => {
  const l = Math.hypot(...a) || 1;
  return a.map((x) => x / l);
};

/** Axis-aligned room with inward-facing faces. */
function room(
  parts: { floor: PartBuilder; wall: PartBuilder; ceil: PartBuilder },
  x0: number, z0: number, x1: number, z1: number, h: number,
  /** true = doorway, null = no wall at all (built by the caller). */
  openings: { north?: boolean | null; south?: boolean | null; east?: boolean | null; west?: boolean | null } = {},
) {
  const w = x1 - x0, d = z1 - z0;
  parts.floor.quad([x0, 0, z1], [w, 0, 0], [0, 0, -d], 2);
  parts.ceil.quad([x0, h, z0], [w, 0, 0], [0, 0, d], 2);
  const wall = (o: number[], u: number[], open?: boolean | null) => {
    if (open === null) return;
    if (!open) return parts.wall.quad(o, u, [0, h, 0], 2);
    // Leave a 2-wide, 3-tall doorway in the middle.
    const len = Math.hypot(...u), dir = u.map((c) => c / len);
    const side = (len - 2) / 2;
    const at = (t: number) => o.map((c, i) => c + dir[i] * t);
    parts.wall.quad(o, dir.map((c) => c * side), [0, h, 0], 2);
    parts.wall.quad(at(side + 2), dir.map((c) => c * side), [0, h, 0], 2);
    parts.wall.quad([at(side)[0], 3, at(side)[2]], dir.map((c) => c * 2), [0, h - 3, 0], 2);
  };
  wall([x0, 0, z0], [w, 0, 0], openings.north); // faces +z
  wall([x1, 0, z1], [-w, 0, 0], openings.south); // faces -z
  wall([x1, 0, z0], [0, 0, d], openings.east); // faces -x
  wall([x0, 0, z1], [0, 0, -d], openings.west); // faces +x
}

export function buildTestLevel(name: string): { level: LevelData; textures: DecodedTexture[] } {
  const textures = [
    checker('floor', 128, [70, 66, 58], [48, 45, 40], 4, { grime: 0.3 }),
    checker('wall', 128, [96, 98, 88], [80, 84, 76], 8, { grime: 0.25 }),
    checker('ceil', 64, [40, 40, 42], [34, 34, 36], 2),
    checker('rust', 128, [110, 52, 30], [80, 36, 22], 2, { grime: 0.4 }),
    checker('grate', 128, [130, 130, 125], [110, 110, 105], 1, { alphaHoles: true }),
    lightmapTexture(),
  ];

  const p = {
    floor: new PartBuilder('floor', 'lm_pool'),
    wall: new PartBuilder('wall'),
    ceil: new PartBuilder('ceil'),
  };
  // Cell block: a long corridor with rooms off both sides, then a big hall.
  room(p, -2, -40, 2, 0, 4, { north: true, south: true, east: null, west: null });
  // Corridor side walls with a doorway into each cell.
  const gaps = [0, 1, 2, 3].map((i) => -36 + i * 9 + 2);
  let zPrev = -40;
  for (const g of [...gaps, 0]) {
    const end = g === 0 ? 0 : g;
    if (end > zPrev) {
      p.wall.quad([-2, 0, end], [0, 0, zPrev - end], [0, 4, 0], 2); // faces +x
      p.wall.quad([2, 0, zPrev], [0, 0, end - zPrev], [0, 4, 0], 2); // faces -x
    }
    if (g !== 0) {
      p.wall.quad([-2, 3, g + 2], [0, 0, -2], [0, 1, 0], 2);
      p.wall.quad([2, 3, g], [0, 0, 2], [0, 1, 0], 2);
    }
    zPrev = g + 2;
  }
  for (let i = 0; i < 4; i++) {
    const z = -36 + i * 9;
    room(p, -8, z, -2, z + 6, 4, { east: true });
    room(p, 2, z, 8, z + 6, 4, { west: true });
  }
  room(p, -10, -60, 10, -40, 8, { south: true });
  room(p, -2, 0, 2, 8, 4, { north: true });

  // Rusty pillars in the hall.
  const rust = new PartBuilder('rust');
  for (const [x, z] of [[-5, -55], [5, -55], [-5, -45], [5, -45]]) {
    const s = 0.6;
    rust.quad([x - s, 0, z + s], [2 * s, 0, 0], [0, 8, 0], 2);
    rust.quad([x + s, 0, z - s], [-2 * s, 0, 0], [0, 8, 0], 2);
    rust.quad([x + s, 0, z + s], [0, 0, -2 * s], [0, 8, 0], 2);
    rust.quad([x - s, 0, z - s], [0, 0, 2 * s], [0, 8, 0], 2);
  }
  // Cell-door grates (alpha tested), across each cell entrance.
  const grate = new PartBuilder('grate');
  for (let i = 0; i < 4; i++) {
    const z = -36 + i * 9;
    grate.quad([-2.05, 0, z + 4], [0, 0, -2], [0, 3, 0], 2);
    grate.quad([2.05, 0, z + 2], [0, 0, 2], [0, 3, 0], 2);
  }

  const level: LevelData = {
    name,
    parts: [p.floor.build(), p.wall.build(), p.ceil.build(), rust.build(), grate.build()],
    spawn: { position: [0, 1.7, 6], yaw: 0 },
  };
  return { level, textures };
}
