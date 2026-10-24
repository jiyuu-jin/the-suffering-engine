// Save data model (versioned) and JSON helpers. Renderer-free: usable from node tests.
//
// A save is one JSON document (SaveData). Provider state is opaque to the save system:
// every provider (see registry.ts) returns plain JSON and gets the same JSON back.
//
//   game   state that travels with the player (inventory, health, weapons, insanity...)
//   levels state of every level visited this session, keyed by level path, so a level
//          revisited through a Level Transition keeps its state (docs/game-logic.md §8).
//          The current level's entry is captured fresh when the save is made.

export const SAVE_VERSION = 1;

export type SaveKind = 'manual' | 'auto' | 'checkpoint';

/** Provider key -> provider JSON. */
export type ProviderStates = Record<string, unknown>;

export interface SaveData {
  version: number;
  id: string;
  /** 'auto' = the persisted checkpoint (one slot), 'manual' = Save Game, 'checkpoint' = in-memory only. */
  kind: SaveKind;
  /** Date.now() when written. */
  createdAt: number;
  /** Seconds of play (paused time excluded). */
  playtime: number;
  /** 0 easy .. 3 impossible (Settings.difficulty). */
  difficulty: number;
  /** Level the save resumes in (as passed to ctx.requestLevel / openLevel). */
  levelPath: string;
  /** Spawn name the level was entered with (informational; the player transform is restored). */
  spawnName?: string;
  /** Chapter Properties template ("pkg:id") the player is in, when known. */
  chapter?: string;
  /** Display: chapter name (resolved from the user's game strings at save time) or the level name. */
  title: string;
  /** Display: level file name without extension. */
  levelName: string;
  /** Small JPEG data URL of the game view. */
  thumbnail?: string;
  /** Imported from a file of the original game (transfer.ts): what it came from. */
  imported?: { from: 'rsg'; slot: number; chapterId: number; originalPath: string; objects?: number };
  game: ProviderStates;
  levels: Record<string, ProviderStates>;
}

/** What the Load screen lists (SaveData without the provider state). */
export type SaveSummary = Omit<SaveData, 'game' | 'levels'> & { damaged?: boolean };

export function summarize(d: SaveData): SaveSummary {
  const { game: _g, levels: _l, ...rest } = d;
  return rest;
}

/**
 * Validate / upgrade a stored document. Returns null for anything unusable (shown as a
 * damaged save). Add a step here whenever SAVE_VERSION changes.
 */
export function migrateSave(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<SaveData>;
  if (typeof d.version !== 'number' || d.version > SAVE_VERSION) return null;
  if (typeof d.id !== 'string' || typeof d.levelPath !== 'string') return null;
  // (version 1 is the first format: nothing to upgrade yet.)
  return {
    version: SAVE_VERSION,
    id: d.id,
    kind: d.kind === 'auto' || d.kind === 'checkpoint' ? d.kind : 'manual',
    createdAt: Number(d.createdAt) || 0,
    playtime: Number(d.playtime) || 0,
    difficulty: Number.isInteger(d.difficulty) ? (d.difficulty as number) : 1,
    levelPath: d.levelPath,
    spawnName: typeof d.spawnName === 'string' ? d.spawnName : undefined,
    chapter: typeof d.chapter === 'string' ? d.chapter : undefined,
    title: typeof d.title === 'string' ? d.title : levelStem(d.levelPath),
    levelName: typeof d.levelName === 'string' ? d.levelName : levelStem(d.levelPath),
    thumbnail: typeof d.thumbnail === 'string' && d.thumbnail.startsWith('data:image/') ? d.thumbnail : undefined,
    imported: isPlain(d.imported) && d.imported.from === 'rsg' ? d.imported : undefined,
    game: isPlain(d.game) ? (d.game as ProviderStates) : {},
    levels: isPlain(d.levels) ? (d.levels as Record<string, ProviderStates>) : {},
  };
}

export function levelStem(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.lvl$/i, '');
}

/** Normalised key for level paths (engine paths use backslashes and mixed case). */
export function levelKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

// ---------------------------------------------------------------------------
// JSON codec for runtime state objects (WorldEntity.s etc.)
//
// Plain objects, arrays, strings, booleans and finite numbers pass through. Set and Map are
// tagged ({$set: [...]}, {$map: [[k, v], ...]}), non-finite numbers become {$num: "Infinity"}.
// Functions, symbols, undefined and class instances (THREE objects, handles...) are dropped:
// they can't be persisted, so state that needs them must be rebuilt by its owner on load.

const MAX_DEPTH = 12;

export function isPlain(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

export function encodeValue(v: unknown, depth = 0): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : { $num: String(v) };
    case 'object':
      break;
    default:
      return undefined;
  }
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(v)) return v.map((x) => encodeValue(x, depth + 1) ?? null);
  if (v instanceof Set) return { $set: [...v].map((x) => encodeValue(x, depth + 1) ?? null) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encodeValue(k, depth + 1) ?? null, encodeValue(x, depth + 1) ?? null]) };
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return { $arr: Array.from(v as unknown as ArrayLike<number>) };
  if (!isPlain(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const e = encodeValue(x, depth + 1);
    if (e !== undefined) out[k] = e;
  }
  return out;
}

export function decodeValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (Array.isArray(o.$set)) return new Set(o.$set.map(decodeValue));
    if (Array.isArray(o.$map)) return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [decodeValue(k), decodeValue(x)]));
    if (typeof o.$num === 'string') return Number(o.$num);
    if (Array.isArray(o.$arr)) return (o.$arr as number[]).slice();
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decodeValue(x);
  return out;
}

/** JSON with object keys sorted (order-independent comparisons). */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

/** Deep copy through JSON (what a save round trip does to provider data). */
export function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
