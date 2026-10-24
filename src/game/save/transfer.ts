// Save files on the player's own disk: export / import of the port's saves (a JSON bundle) and
// import of the original PC game's saves (`<Level>.rsg`) and profile (`Unspeakable.cfg`).
// Pure (no DOM): src/app/menu/save-files.ts does the file pickers and downloads.
//
// Bundle (.json): { format: BUNDLE_FORMAT, version: 1, exportedAt, saves: SaveData[] }. A file
// holding one SaveData or an array of them is accepted too. Every save goes through
// migrateSave() (the store's own validation): what it rejects is counted, not imported.
//
// Original saves (docs/re/saves.md §3): only the header chunk and the start of the world chunk
// can be read, because the per-object records have no lengths and each class writes its own
// layout. So an imported .rsg becomes a port save of the start of its level: the level, the save's
// name, its time (the save folder's name is the hex of time(NULL) + 1), the slot and the thumbnail
// carry over; the player's inventory, health, position and every object's state do not (the save
// loads as the level started fresh, at its Player Spawn Point). See saves.md §8.

import { levelStem, migrateSave, SAVE_VERSION, stableJson, type SaveData } from './types';
import { AUTOSAVE_ID } from './manager';
import type { OriginalSave, SaveThumbnail } from '../../formats/save-original';

export const BUNDLE_FORMAT = 'the-suffering-web/saves';
export const BUNDLE_VERSION = 1;

export interface SaveBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: number;
  saves: SaveData[];
}

export function makeBundle(saves: readonly SaveData[], now = Date.now()): SaveBundle {
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now, saves: saves.map((s) => JSON.parse(JSON.stringify(s)) as SaveData) };
}

/** File name of an export: one save (by its level and time) or the whole list. */
export function bundleFileName(saves: readonly Pick<SaveData, 'levelName' | 'createdAt'>[], now = Date.now()): string {
  const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  if (saves.length === 1) return `suffering-save-${saves[0].levelName.replace(/[^\w-]+/g, '_')}-${stamp(saves[0].createdAt || now)}.json`;
  return `suffering-saves-${stamp(now)}.json`;
}

export interface ParsedBundle {
  saves: SaveData[];
  /** Entries migrateSave() refused (damaged, or from a newer version). */
  rejected: number;
  /** Not a save file at all (no JSON, or JSON without saves). */
  error?: string;
}

/** Read an export file: a bundle, one save, or an array of saves. */
export function parseBundle(text: string): ParsedBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { saves: [], rejected: 0, error: 'not JSON' };
  }
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as SaveBundle).saves)
      ? (raw as SaveBundle).saves
      : raw && typeof raw === 'object' && 'levelPath' in raw
        ? [raw]
        : [];
  if (!list.length) return { saves: [], rejected: 0, error: 'no saves in the file' };
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'format' in raw && (raw as SaveBundle).format !== BUNDLE_FORMAT) return { saves: [], rejected: list.length, error: 'not a save bundle of this game' };
  const saves: SaveData[] = [];
  let rejected = 0;
  for (const x of list) {
    const d = migrateSave(x);
    if (d) saves.push(d);
    else rejected++;
  }
  return { saves, rejected };
}

/**
 * Ids for imported saves next to the existing ones: a save already in the store with the same
 * content is skipped; one whose id is taken by another save gets a new id; the autosave slot
 * (written by checkpoints only) comes in as a manual save.
 */
export function planImport(incoming: readonly SaveData[], existing: ReadonlyMap<string, SaveData | null>, rand: () => number = Math.random): { put: SaveData[]; skipped: number } {
  const put: SaveData[] = [];
  let skipped = 0;
  const taken = new Set(existing.keys());
  const same = (a: SaveData, b: SaveData) => stableJson({ ...a, kind: 0 }) === stableJson({ ...b, kind: 0 });
  for (const s0 of incoming) {
    let s = s0;
    if (s.id === AUTOSAVE_ID || s.kind !== 'manual') s = { ...s, kind: 'manual' };
    const prior = existing.get(s0.id);
    if (prior && same(prior, s)) {
      skipped++;
      continue;
    }
    if (taken.has(s.id) || s.id === AUTOSAVE_ID) {
      let id: string;
      do id = `${s0.id === AUTOSAVE_ID ? 'save' : s0.id}-i${Math.floor(rand() * 36 ** 4).toString(36)}`;
      while (taken.has(id));
      s = { ...s, id };
    }
    taken.add(s.id);
    put.push(s);
  }
  return { put, skipped };
}

// ---------------------------------------------------------------------------
// Original saves

/** Unix time (ms) of an original save from its folder name (hex of time(NULL) + 1), if plausible. */
export function originalSaveTime(folder: string | undefined): number | undefined {
  if (!folder || !/^[0-9a-f]{6,10}$/i.test(folder)) return undefined;
  const s = parseInt(folder, 16) - 1;
  // 2004 (the game) .. 2100.
  return s >= 1_072_915_200 && s < 4_102_444_800 ? s * 1000 : undefined;
}

/**
 * The thumbnail's pixels as RGBA, when its layout can be told from its size: 4 bytes per pixel
 * read as B, G, R, A (Direct3D A8R8G8B8 / X8R8G8B8 in memory), 2 bytes as R5G6B5. The engine's
 * format codes are not mapped (docs/re/saves.md §7), so this is a guess from the pitch [inferred].
 */
export function decodeOriginalThumbnail(t: SaveThumbnail): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  const { width: w, height: h, data } = t;
  if (!(w > 0 && h > 0 && w <= 1024 && h <= 1024) || data.length % h) return null;
  const pitch = data.length / h;
  const bpp = pitch >= w * 4 ? 4 : pitch >= w * 2 ? 2 : 0;
  if (!bpp) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const i = y * pitch + x * bpp;
      if (bpp === 4) {
        rgba[o] = data[i + 2];
        rgba[o + 1] = data[i + 1];
        rgba[o + 2] = data[i];
      } else {
        const v = data[i] | (data[i + 1] << 8);
        rgba[o] = ((v >> 11) & 31) * 255 / 31;
        rgba[o + 1] = ((v >> 5) & 63) * 255 / 63;
        rgba[o + 2] = (v & 31) * 255 / 31;
      }
      rgba[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

export interface OriginalImportOptions {
  /** The port's path of the save's level (GameFS.resolve of the header's path); undefined = unknown level. */
  levelPath: string | undefined;
  /** Name of the folder the .rsg was in (its time). */
  folder?: string;
  /** File time when the folder name gives none (ms). */
  fileTime?: number;
  /** Difficulty to start with: the original keeps it outside the header [unknown where]. */
  difficulty: number;
  /** JPEG data URL of the decoded thumbnail. */
  thumbnail?: string;
  /** Chapter Properties template ("pkg:id") of the level, when the menu data knows it. */
  chapter?: string;
}

/** What an imported original save carries over (docs/re/saves.md §8). */
export interface OriginalImportInfo {
  from: 'rsg';
  /** Original slot number and chapter object id (not mapped). */
  slot: number;
  chapterId: number;
  /** Header level path as the original wrote it. */
  originalPath: string;
  /** Objects in the original's world chunk (not imported). */
  objects?: number;
}

/** A port save of the start of the level an original save was made in. Null: unknown level. */
export function originalSaveToPort(o: OriginalSave, opts: OriginalImportOptions): SaveData | null {
  if (!opts.levelPath) return null;
  const h = o.header;
  const createdAt = originalSaveTime(opts.folder) ?? opts.fileTime ?? 0;
  const tag = opts.folder && /^[0-9a-f]+$/i.test(opts.folder) ? opts.folder.toLowerCase() : `${h.slot}-${createdAt.toString(36)}`;
  const imported: OriginalImportInfo = { from: 'rsg', slot: h.slot, chapterId: h.chapterId, originalPath: h.levelPath, objects: o.body?.objectCount };
  return {
    version: SAVE_VERSION,
    id: `rsg-${tag}`,
    kind: 'manual',
    createdAt,
    playtime: 0,
    difficulty: opts.difficulty,
    levelPath: opts.levelPath,
    chapter: opts.chapter,
    title: h.name || levelStem(opts.levelPath),
    levelName: levelStem(opts.levelPath),
    thumbnail: opts.thumbnail,
    imported,
    game: {},
    levels: {},
  };
}
