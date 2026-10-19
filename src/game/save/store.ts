// Save storage: IndexedDB (database "suffering-saves", store "saves", key = SaveData.id),
// falling back to localStorage ("suffering.save.<id>"), falling back to memory. Every
// storage call is wrapped: private windows / blocked site data / quota errors only lose
// persistence, they never break the game.

import { migrateSave, summarize, type SaveData, type SaveSummary } from './types';

export interface SaveStore {
  readonly kind: 'indexeddb' | 'localStorage' | 'memory';
  list(): Promise<SaveSummary[]>;
  get(id: string): Promise<SaveData | null>;
  put(save: SaveData): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

/** Newest first. */
const byTime = (a: SaveSummary, b: SaveSummary) => b.createdAt - a.createdAt;

export class MemoryStore implements SaveStore {
  readonly kind = 'memory' as const;
  private map = new Map<string, string>();
  async list() {
    return [...this.map.values()].map((s) => migrateSave(JSON.parse(s))).filter((d): d is SaveData => !!d).map(summarize).sort(byTime);
  }
  async get(id: string) {
    const s = this.map.get(id);
    return s ? migrateSave(JSON.parse(s)) : null;
  }
  async put(save: SaveData) {
    this.map.set(save.id, JSON.stringify(save));
    return true;
  }
  async delete(id: string) {
    return this.map.delete(id);
  }
}

const LS_PREFIX = 'suffering.save.';

export class LocalStorageStore implements SaveStore {
  readonly kind = 'localStorage' as const;
  private ids(): string[] {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
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
      const s = localStorage.getItem(LS_PREFIX + id);
      return s ? migrateSave(JSON.parse(s)) : null;
    } catch {
      return null;
    }
  }
  async put(save: SaveData) {
    try {
      localStorage.setItem(LS_PREFIX + save.id, JSON.stringify(save));
      return true;
    } catch (err) {
      console.warn('[save] localStorage write failed:', err);
      return false;
    }
  }
  async delete(id: string) {
    try {
      localStorage.removeItem(LS_PREFIX + id);
      return true;
    } catch {
      return false;
    }
  }
}

function damaged(id: string): SaveSummary {
  return { version: 0, id, kind: 'manual', createdAt: 0, playtime: 0, difficulty: 1, levelPath: '', title: '', levelName: '', damaged: true };
}

const DB_NAME = 'suffering-saves';
const STORE = 'saves';

export class IndexedDbStore implements SaveStore {
  readonly kind = 'indexeddb' as const;
  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IndexedDbStore | null> {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(new IndexedDbStore(req.result));
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let result: T | undefined;
        req.onsuccess = () => (result = req.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async list() {
    const all = ((await this.run('readonly', (s) => s.getAll())) ?? []) as unknown[];
    return all
      .map((raw) => {
        const d = migrateSave(raw);
        return d ? summarize(d) : damaged(String((raw as { id?: unknown })?.id ?? '?'));
      })
      .sort(byTime);
  }
  async get(id: string) {
    return migrateSave(await this.run('readonly', (s) => s.get(id)));
  }
  async put(save: SaveData) {
    // Stored as plain JSON data (structured clone of a JSON round trip).
    const r = await this.run('readwrite', (s) => s.put(JSON.parse(JSON.stringify(save))));
    return r !== undefined;
  }
  async delete(id: string) {
    await this.run('readwrite', (s) => s.delete(id));
    return true;
  }
}

/** Best available store: IndexedDB, else localStorage, else memory. */
export async function openSaveStore(): Promise<SaveStore> {
  const idb = await IndexedDbStore.open();
  if (idb) return idb;
  try {
    const k = `${LS_PREFIX}__probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return new LocalStorageStore();
  } catch {
    console.warn('[save] no persistent storage available: saves last until the page is closed');
    return new MemoryStore();
  }
}
