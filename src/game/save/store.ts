// Save storage: IndexedDB (database "suffering-saves", store "saves", key = SaveData.id),
// falling back to localStorage ("suffering.save.<id>"), falling back to memory. Every
// storage call is wrapped: private windows / blocked site data / quota errors only lose
// persistence, they never break the game.
//
// Robustness (tools/save-matrix.mjs --storage, tests/save-store.test.ts):
//   * a write that fails says why (`lastError`: 'quota' when the browser's storage is full);
//   * a damaged entry (not JSON, not a save, from a newer version) lists as damaged and can be
//     deleted; delete reports whether it worked;
//   * IndexedDB: another tab upgrading or deleting the database closes this connection
//     (versionchange), and a closed connection is opened again on the next call;
//   * `?storage=localStorage|memory` forces a backend (tests, or a player who wants no
//     IndexedDB);
//   * other tabs of the game hear about every write / delete (BroadcastChannel
//     "suffering-saves"): their save lists refresh (SaveManager.onChange).

import { migrateSave, summarize, type SaveData, type SaveSummary } from './types';

export type StoreError = 'quota' | 'unavailable' | 'failed';

export interface SaveStore {
  readonly kind: 'indexeddb' | 'localStorage' | 'memory';
  list(): Promise<SaveSummary[]>;
  get(id: string): Promise<SaveData | null>;
  put(save: SaveData): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /** Why the last put / delete failed (cleared by the next success). */
  lastError?: StoreError;
}

/** Newest first. */
const byTime = (a: SaveSummary, b: SaveSummary) => b.createdAt - a.createdAt;

/** A storage exception's kind: the quota is full, or anything else. */
export function storeErrorOf(err: unknown): StoreError {
  const e = err as { name?: string; code?: number } | null;
  // QuotaExceededError (code 22; Firefox's old NS_ERROR_DOM_QUOTA_REACHED is 1014).
  if (e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014)) return 'quota';
  if (e && (e.name === 'SecurityError' || e.name === 'InvalidStateError')) return 'unavailable';
  return 'failed';
}

function parseEntry(text: string | null | undefined): SaveData | null {
  if (!text) return null;
  try {
    return migrateSave(JSON.parse(text));
  } catch {
    return null;
  }
}

export class MemoryStore implements SaveStore {
  readonly kind = 'memory' as const;
  lastError?: StoreError;
  private map = new Map<string, string>();
  async list() {
    return [...this.map.entries()].map(([id, s]) => {
      const d = parseEntry(s);
      return d ? summarize(d) : damaged(id);
    }).sort(byTime);
  }
  async get(id: string) {
    return parseEntry(this.map.get(id));
  }
  async put(save: SaveData) {
    this.map.set(save.id, JSON.stringify(save));
    this.lastError = undefined;
    return true;
  }
  async delete(id: string) {
    this.lastError = undefined;
    return this.map.delete(id);
  }
}

const LS_PREFIX = 'suffering.save.';

export class LocalStorageStore implements SaveStore {
  readonly kind = 'localStorage' as const;
  lastError?: StoreError;
  constructor(private readonly ls: Storage = localStorage) {}
  private ids(): string[] {
    const out: string[] = [];
    try {
      for (let i = 0; i < this.ls.length; i++) {
        const k = this.ls.key(i);
        if (k?.startsWith(LS_PREFIX) && k !== PROBE_KEY) out.push(k.slice(LS_PREFIX.length));
      }
    } catch {
      /* unavailable */
    }
    return out;
  }
  async list() {
    const out: SaveSummary[] = [];
    for (const id of this.ids()) {
      const d = await this.get(id);
      out.push(d ? summarize(d) : damaged(id));
    }
    return out.sort(byTime);
  }
  async get(id: string) {
    try {
      return parseEntry(this.ls.getItem(LS_PREFIX + id));
    } catch {
      return null;
    }
  }
  async put(save: SaveData) {
    try {
      this.ls.setItem(LS_PREFIX + save.id, JSON.stringify(save));
      this.lastError = undefined;
      return true;
    } catch (err) {
      this.lastError = storeErrorOf(err);
      console.warn(`[save] localStorage write failed (${this.lastError}):`, err);
      return false;
    }
  }
  async delete(id: string) {
    try {
      this.ls.removeItem(LS_PREFIX + id);
      this.lastError = undefined;
      return true;
    } catch (err) {
      this.lastError = storeErrorOf(err);
      return false;
    }
  }
}

function damaged(id: string): SaveSummary {
  return { version: 0, id, kind: 'manual', createdAt: 0, playtime: 0, difficulty: 1, levelPath: '', title: '', levelName: '', damaged: true };
}

const DB_NAME = 'suffering-saves';
const STORE = 'saves';
const PROBE_KEY = `${LS_PREFIX}__probe`;

function browserIdb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function openDb(idb: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // Another tab holds an older version open: it is asked to close (versionchange); this
      // open goes on once it did, or fails (onerror) if it never does. Nothing to do here.
      req.onblocked = () => console.warn('[save] IndexedDB open waits for another tab to close the database');
    } catch {
      resolve(null);
    }
  });
}

export class IndexedDbStore implements SaveStore {
  readonly kind = 'indexeddb' as const;
  lastError?: StoreError;
  private db: IDBDatabase | null;
  private reopening: Promise<IDBDatabase | null> | null = null;

  private constructor(
    db: IDBDatabase,
    private readonly idb: IDBFactory,
  ) {
    this.db = db;
    this.watch(db);
  }

  /** The browser's IndexedDB (blocked site data: reading it throws), unless one is passed. */
  static async open(idb: IDBFactory | null = browserIdb()): Promise<IndexedDbStore | null> {
    if (!idb) return null;
    const db = await openDb(idb);
    return db ? new IndexedDbStore(db, idb) : null;
  }

  private watch(db: IDBDatabase) {
    // Another tab upgrades / deletes the database: let it (this tab reopens on its next call).
    db.onversionchange = () => {
      db.close();
      if (this.db === db) this.db = null;
    };
    // Closed by the browser (storage cleared, disk error).
    db.onclose = () => {
      if (this.db === db) this.db = null;
    };
  }

  private async connection(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    this.reopening ??= openDb(this.idb).then((db) => {
      this.reopening = null;
      if (db) {
        this.db = db;
        this.watch(db);
      }
      return db;
    });
    return this.reopening;
  }

  /** One request in its own transaction: { ok, result } once the transaction completed. */
  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, retry = true): Promise<{ ok: boolean; result?: T; error?: StoreError }> {
    const db = await this.connection();
    if (!db) return { ok: false, error: 'unavailable' };
    return new Promise((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, mode);
      } catch (err) {
        // Closed under us (InvalidStateError): open again once.
        if (this.db === db) this.db = null;
        if (retry) return void this.run(mode, fn, false).then(resolve);
        return resolve({ ok: false, error: storeErrorOf(err) });
      }
      let result: T | undefined;
      try {
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => (result = req.result);
      } catch (err) {
        // (put() of data the structured clone refuses, a bad key...)
        try {
          tx.abort();
        } catch {}
        return resolve({ ok: false, error: storeErrorOf(err) });
      }
      tx.oncomplete = () => resolve({ ok: true, result });
      tx.onerror = () => resolve({ ok: false, error: storeErrorOf(tx.error) });
      tx.onabort = () => resolve({ ok: false, error: storeErrorOf(tx.error) });
    });
  }

  async list() {
    const r = await this.run('readonly', (s) => s.getAll());
    const all = (r.result ?? []) as unknown[];
    return all
      .map((raw) => {
        const d = migrateSave(raw);
        return d ? summarize(d) : damaged(String((raw as { id?: unknown })?.id ?? '?'));
      })
      .sort(byTime);
  }
  async get(id: string) {
    const r = await this.run('readonly', (s) => s.get(id));
    return migrateSave(r.result);
  }
  async put(save: SaveData) {
    // Stored as plain JSON data (structured clone of a JSON round trip).
    const r = await this.run('readwrite', (s) => s.put(JSON.parse(JSON.stringify(save))));
    this.lastError = r.ok ? undefined : r.error;
    if (!r.ok) console.warn(`[save] IndexedDB write failed (${r.error})`);
    return r.ok;
  }
  async delete(id: string) {
    const r = await this.run('readwrite', (s) => s.delete(id));
    this.lastError = r.ok ? undefined : r.error;
    return r.ok;
  }
}

/** Backend asked for by `?storage=` (developer / tests), if any. */
function forcedBackend(): string | null {
  try {
    return globalThis.location ? new URLSearchParams(globalThis.location.search).get('storage') : null;
  } catch {
    return null;
  }
}

/** localStorage when it can be written (a private window may refuse it, or throw on access). */
function localStorageStore(): LocalStorageStore | null {
  try {
    const ls = globalThis.localStorage;
    ls.setItem(PROBE_KEY, '1');
    ls.removeItem(PROBE_KEY);
    return new LocalStorageStore(ls);
  } catch {
    return null;
  }
}

/** Best available store: IndexedDB, else localStorage, else memory (`?storage=` forces one). */
export async function openSaveStore(): Promise<SaveStore> {
  const forced = forcedBackend();
  if (forced === 'memory') return new MemoryStore();
  if (forced !== 'localStorage') {
    // (Blocked site data: the getter itself throws; browserIdb() gives null then.)
    const s = await IndexedDbStore.open(browserIdb());
    if (s) return s;
  }
  const ls = localStorageStore();
  if (ls) return ls;
  console.warn('[save] no persistent storage available: saves last until the page is closed');
  return new MemoryStore();
}

// ---------------------------------------------------------------------------
// Other tabs

const CHANNEL = 'suffering-saves';

/** Tell other tabs the store changed (notify); `fn` runs when another tab did. */
export function storeChannel(fn?: () => void): { notify(): void; close(): void } {
  let ch: BroadcastChannel | null = null;
  try {
    ch = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    if (ch && fn) ch.onmessage = () => fn();
    // (Node: a listening channel would keep the process alive.)
    (ch as { unref?(): void } | null)?.unref?.();
  } catch {
    ch = null;
  }
  return {
    notify: () => {
      try {
        ch?.postMessage('changed');
      } catch {}
    },
    close: () => ch?.close(),
  };
}
