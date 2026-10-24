// SaveManager: the app-wide half of the save system (one instance, `saves`).
//
//   session      what is being played: difficulty, playtime, chapter, the game-scope state
//                carried across level transitions and the level-scope state of every level
//                visited (docs/game-logic.md §8: a revisited level keeps its state).
//   checkpoint   the last checkpoint (in memory): Revert to checkpoint and death restart
//                restore it. Checkpoints are taken when an Autosave object receives its
//                inSave message, after every level transition and at New Game; with the
//                Gameplay "Checkpoints" option not Off they are also written to the
//                persistent "autosave" slot.
//   store        IndexedDB / localStorage (store.ts): manual saves + the autosave slot.
//
// The per-level half is the save GameSystem (system.ts): it owns the SaveRegistry of the
// running level (ctx.services.save), takes deferred checkpoints and notices the player's
// death. main.ts calls levelReady() once a level's systems have started; the menu flow calls
// newGame(), saveManual(), list()/get()/delete() and canSave().

import { SaveRegistry } from './registry';
import { MemoryStore, storeChannel, type SaveStore } from './store';
import { levelKey, levelStem, SAVE_VERSION, type ProviderStates, type SaveData, type SaveKind, type SaveSummary } from './types';

export const AUTOSAVE_ID = 'autosave';

/** How a level was entered (main.ts -> levelReady). */
export type LevelEntry =
  | { kind: 'new' }
  | { kind: 'transition' }
  | { kind: 'load'; data: SaveData };

export interface SaveHost {
  /** Restore a save: load its level (or restart the current one in place) and apply it. */
  restore(data: SaveData): Promise<boolean>;
  /** Interface string by ref ("pkg:id"); undefined until the menu assets are loaded. */
  label?(ref: string): string | undefined;
  /** Gameplay option "Checkpoints": 0 Off, 1 Prompt, 2 On (default On). */
  checkpointsMode?(): number;
}

interface Session {
  difficulty: number;
  playtime: number;
  chapter?: string;
  game: ProviderStates;
  levels: Record<string, ProviderStates>;
}

interface BoundLevel {
  registry: SaveRegistry;
  path: string;
  spawnName?: string;
  ready: boolean;
}

/** Frames to wait before a requested checkpoint is taken (lets queued start-up messages run). */
const CHECKPOINT_SETTLE_FRAMES = 2;
const THUMB_W = 160;
const THUMB_H = 120;

export class SaveManager {
  store: SaveStore = new MemoryStore();
  host?: SaveHost;
  /** Write checkpoints / manual saves to the store (the menu flow turns this on). */
  persist = false;
  session: Session = { difficulty: 1, playtime: 0, game: {}, levels: {} };
  /** Last checkpoint (in memory). */
  checkpoint: SaveData | null = null;
  /** Chapter announced by the Level Transition being taken (Chapter Properties "pkg:id"). */
  nextChapter?: string;
  /** Shows the checkpoint notice (set by the save system of the running level). */
  onNotice?: () => void;
  /** Called after the store changed (menus refresh their lists). */
  onChange?: () => void;

  /** Other tabs of the game (store.ts storeChannel): their writes refresh this tab's lists. */
  private channel = storeChannel(() => this.onChange?.());
  private askedPersistence = false;
  private bound: BoundLevel | null = null;
  private pending: { reason: string; frames: number } | null = null;
  private transitioning = false;
  private thumbSource?: HTMLCanvasElement;
  private thumbWaiters: ((url: string | undefined) => void)[] = [];
  private seq = 0;

  get registry(): SaveRegistry | undefined {
    return this.bound?.registry;
  }

  get levelPath(): string | undefined {
    return this.bound?.path;
  }

  // ---------------------------------------------------------------------------
  // Wiring

  /** Grab thumbnails from the game canvas (frame listeners run right after rendering). */
  attachView(view: { onFrame(fn: (dt: number) => void): void; renderer: { domElement: HTMLCanvasElement } }): void {
    this.thumbSource = view.renderer.domElement;
    view.onFrame(() => {
      if (!this.thumbWaiters.length) return;
      const waiters = this.thumbWaiters;
      this.thumbWaiters = [];
      const url = this.grabThumbnail();
      for (const w of waiters) w(url);
    });
  }

  private grabThumbnail(): string | undefined {
    const src = this.thumbSource;
    if (!src || !src.width || !src.height) return undefined;
    try {
      const c = document.createElement('canvas');
      c.width = THUMB_W;
      c.height = THUMB_H;
      const g = c.getContext('2d')!;
      // Centre crop to 4:3.
      const sw = Math.min(src.width, (src.height * 4) / 3);
      const sh = Math.min(src.height, (src.width * 3) / 4);
      g.fillStyle = '#000';
      g.fillRect(0, 0, THUMB_W, THUMB_H);
      g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, THUMB_W, THUMB_H);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (err) {
      console.warn('[save] thumbnail failed:', err);
      return undefined;
    }
  }

  /** Thumbnail of the next rendered frame (undefined without a view or after 8 s). */
  thumbnail(): Promise<string | undefined> {
    if (!this.thumbSource) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let done = false;
      const fin = (u: string | undefined) => {
        if (done) return;
        done = true;
        resolve(u);
      };
      this.thumbWaiters.push(fin);
      // Frames can be slow right after a level load.
      setTimeout(() => fin(undefined), 8000);
    });
  }

  // ---------------------------------------------------------------------------
  // Session / level lifecycle

  /** New Game: fresh session (the level's game-scope providers are reset in levelReady). */
  newGame(difficulty: number): void {
    this.session = { difficulty, playtime: 0, game: {}, levels: {} };
    this.checkpoint = null;
    this.pending = null;
    this.nextChapter = undefined;
  }

  /** Called by the save system when a level's systems are being created. */
  bindLevel(registry: SaveRegistry, path: string, spawnName?: string): void {
    this.bound = { registry, path, spawnName, ready: false };
    this.pending = null;
    this.transitioning = false;
  }

  unbindLevel(registry: SaveRegistry): void {
    if (this.bound?.registry === registry) this.bound = null;
  }

  /**
   * Every system of the level has started (main.ts). Applies the save being loaded, or the
   * state carried over by a level transition, or resets the game state for a new game, and
   * schedules the level-start checkpoint.
   */
  levelReady(entry: LevelEntry): void {
    const b = this.bound;
    if (!b) return;
    b.ready = true;
    const key = levelKey(b.path);
    if (entry.kind === 'load') {
      const d = entry.data;
      b.spawnName = d.spawnName;
      this.pending = null;
      this.session = {
        difficulty: d.difficulty,
        playtime: d.playtime,
        chapter: d.chapter,
        game: structuredCloneJson(d.game),
        levels: Object.fromEntries(Object.entries(d.levels).map(([k, v]) => [levelKey(k), structuredCloneJson(v)])),
      };
      const info = { reason: 'load' as const, levelPath: b.path, version: d.version };
      // Game-scope state the save has no entry for starts as in a new game (it would otherwise
      // be whatever the session played before: weapons and insanity outlive a level).
      b.registry.reset('game', d.game);
      b.registry.apply(d.game, 'game', info);
      b.registry.apply(this.session.levels[key], 'level', info);
      // Death / Revert go back to what was loaded.
      this.checkpoint = { ...d, kind: 'checkpoint' };
      console.info(`[save] restored "${d.title}" (${d.kind}) in ${b.path}`);
      return;
    }
    if (entry.kind === 'transition') {
      const info = { reason: 'transition' as const, levelPath: b.path, version: SAVE_VERSION };
      b.registry.apply(this.session.game, 'game', info);
      const revisit = this.session.levels[key];
      if (revisit) {
        b.registry.apply(revisit, 'level', info);
        console.info(`[save] revisiting ${b.path}: level state restored`);
      }
      if (this.nextChapter) this.session.chapter = this.nextChapter;
      this.nextChapter = undefined;
    } else {
      b.registry.reset('game');
    }
    this.requestCheckpoint(entry.kind === 'new' ? 'level start' : 'level transition');
  }

  /** The player takes a Level Transition: keep this level's state and the game state. */
  leavingLevel(): void {
    const b = this.bound;
    if (!b?.ready) return;
    this.session.levels[levelKey(b.path)] = b.registry.capture('level');
    this.session.game = b.registry.capture('game');
    this.transitioning = true;
    this.pending = null;
  }

  /** Ask for a checkpoint; taken by tick() once the logic settled and no cinematic runs. */
  requestCheckpoint(reason: string): void {
    this.pending = { reason, frames: CHECKPOINT_SETTLE_FRAMES };
  }

  /**
   * Per frame from the save system (not called while paused). `blocked` = a reason the
   * checkpoint must wait (cinematic running, player dead).
   */
  tick(dt: number, blocked: string | null): void {
    if (!this.bound?.ready) return;
    this.session.playtime += dt;
    const p = this.pending;
    if (!p || this.transitioning) return;
    if (p.frames > 0) {
      p.frames--;
      return;
    }
    if (blocked) return;
    this.pending = null;
    void this.takeCheckpoint(p.reason);
  }

  private async takeCheckpoint(reason: string): Promise<void> {
    const data = this.capture('checkpoint', 'checkpoint');
    if (!data) return;
    this.checkpoint = data;
    this.onNotice?.();
    console.info(`[save] checkpoint (${reason}) in ${data.levelName}`);
    const mode = this.host?.checkpointsMode?.() ?? 2;
    const thumb = await this.thumbnail();
    data.thumbnail = thumb;
    if (this.persist && mode !== 0) {
      if (await this.store.put({ ...data, id: AUTOSAVE_ID, kind: 'auto' })) this.channel.notify();
      this.onChange?.();
    }
  }

  // ---------------------------------------------------------------------------
  // Capture / store

  /** Snapshot of the running level + session (no thumbnail). Null when no level is ready. */
  capture(kind: SaveKind, id: string): SaveData | null {
    const b = this.bound;
    if (!b?.ready) return null;
    const levels: Record<string, ProviderStates> = { ...this.session.levels };
    const key = levelKey(b.path);
    levels[key] = b.registry.capture('level');
    const chapterName = this.session.chapter ? this.host?.label?.(this.session.chapter) : undefined;
    return {
      version: SAVE_VERSION,
      id,
      kind,
      createdAt: Date.now(),
      playtime: Math.round(this.session.playtime * 10) / 10,
      difficulty: this.session.difficulty,
      levelPath: b.path,
      spawnName: b.spawnName,
      chapter: this.session.chapter,
      title: chapterName || levelStem(b.path),
      levelName: levelStem(b.path),
      game: b.registry.capture('game'),
      levels,
    };
  }

  /** Why the player can't save right now (null = allowed). */
  canSave(): string | null {
    const b = this.bound;
    if (!b?.ready) return 'no level';
    if (this.transitioning) return 'level transition';
    return b.registry.veto();
  }

  /** Save Game: a new slot, or overwrite `id`. Resolves the stored save, or null on failure. */
  async saveManual(id?: string): Promise<SaveData | null> {
    // (The random part: two tabs saving in the same millisecond get different ids.)
    const data = this.capture('manual', id ?? `save-${Date.now().toString(36)}-${(this.seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`);
    if (!data) return null;
    data.thumbnail = await this.thumbnail();
    const ok = await this.store.put(data);
    if (ok) {
      this.channel.notify();
      this.requestPersistence();
    }
    this.onChange?.();
    return ok ? data : null;
  }

  /** Why the store's last write failed ('quota': the browser's storage for the site is full). */
  get lastError(): string | undefined {
    return this.store.lastError;
  }

  /**
   * Ask the browser to keep the site's storage under storage pressure (navigator.storage.persist),
   * once, after the player's first manual save: an evicted database loses every save.
   */
  private requestPersistence(): void {
    if (this.askedPersistence || this.store.kind !== 'indexeddb') return;
    this.askedPersistence = true;
    try {
      void navigator.storage?.persisted?.().then((p) => (p ? true : navigator.storage.persist?.())).catch(() => undefined);
    } catch {
      /* not offered */
    }
  }

  /** Every usable save, in full (export). */
  async exportAll(): Promise<SaveData[]> {
    const out: SaveData[] = [];
    for (const s of await this.list()) {
      if (s.damaged) continue;
      const d = await this.get(s.id);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * Store imported saves (transfer.ts planImport: same content skipped, taken ids renamed).
   * Resolves the counts.
   */
  async importSaves(list: readonly SaveData[]): Promise<{ added: number; skipped: number; failed: number }> {
    const { planImport } = await import('./transfer');
    const existing = new Map<string, SaveData | null>();
    for (const s of await this.list()) existing.set(s.id, s.damaged ? null : await this.get(s.id));
    const plan = planImport(list, existing);
    let added = 0, failed = 0;
    for (const s of plan.put) (await this.store.put(s).catch(() => false)) ? added++ : failed++;
    if (added) this.channel.notify();
    this.onChange?.();
    return { added, skipped: plan.skipped, failed };
  }

  list(): Promise<SaveSummary[]> {
    return this.store.list().catch(() => []);
  }

  get(id: string): Promise<SaveData | null> {
    return this.store.get(id).catch(() => null);
  }

  async delete(id: string): Promise<boolean> {
    const ok = await this.store.delete(id).catch(() => false);
    if (ok) this.channel.notify();
    this.onChange?.();
    return ok;
  }

  /** Newest usable save (main menu Continue). */
  async newest(): Promise<SaveSummary | undefined> {
    return (await this.list()).find((s) => !s.damaged);
  }

  /** Restore the last checkpoint (Revert / death). */
  async revert(): Promise<boolean> {
    const cp = this.checkpoint;
    if (!cp || !this.host) return false;
    return this.host.restore(cp);
  }
}

function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? {})) as T;
}

/** The app's save manager. */
export const saves = new SaveManager();
