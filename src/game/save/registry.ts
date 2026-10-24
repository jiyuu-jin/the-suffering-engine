// Save registry: every game system persists its own state.
//
//   const off = (ctx.services.save as SaveService).register('weapons', {
//     save: () => ({ ammo: 12, current: 'revolver' }),   // plain JSON
//     load: (data, info) => { ... },                     // the same JSON back
//     reset: () => { ... },                               // New Game (scope 'game' only)
//   }, { scope: 'game', priority: 30 });
//   // call off() in dispose() (the registry is per level, so this is optional)
//
// Scopes:
//   'level' (default)  state of the current level (entities, doors, NPCs...). Stored per
//                      level path; restored when a save is loaded and when the level is
//                      revisited through a Level Transition (info.reason 'transition').
//   'game'             state that travels with the player between levels (inventory,
//                      health, weapons, insanity). Restored on load AND carried over on every
//                      level transition (info.reason 'transition'); reset() on New Game.
//
// load(data, info) is called right after every system of the freshly started level was
// created and before its first update. info.reason:
//   'load'        a save / checkpoint is being restored: restore exactly.
//   'transition'  arriving through a Level Transition: game state carries over; level state
//                 only exists if the level was visited before (player position must NOT be
//                 restored then - the spawn point applies).
// Providers run in ascending `priority` (default 50): world logic 0, actors 10, player 20.
// A provider whose key is missing from the save is not called (keep the fresh-level state).
// Exceptions are caught and logged per provider, so one broken provider can't break a load.
//
// Vetoes: addVeto(() => reason | null) blocks manual saving (pause "Save Game" disabled)
// while it returns a reason (e.g. a scripted sequence that can't be restored).

export type SaveScope = 'level' | 'game';

export interface LoadInfo {
  reason: 'load' | 'transition';
  /** Level being restored. */
  levelPath: string;
  /** SaveData.version the data was written with. */
  version: number;
}

export interface SaveProvider<T = unknown> {
  /** Current state as plain JSON (no class instances, functions or cycles). */
  save(): T;
  load(data: T, info: LoadInfo): void;
  /** New Game: back to the initial state (game-scope providers that outlive a level). */
  reset?(): void;
}

export interface ProviderOptions {
  scope?: SaveScope;
  /** Load order, ascending (default 50). */
  priority?: number;
}

interface Entry {
  key: string;
  provider: SaveProvider;
  scope: SaveScope;
  priority: number;
  order: number;
}

export class SaveRegistry {
  private entries = new Map<string, Entry>();
  private vetoes = new Set<() => string | null | undefined>();
  private seq = 0;

  register<T>(key: string, provider: SaveProvider<T>, opts: ProviderOptions = {}): () => void {
    if (this.entries.has(key)) console.warn(`[save] provider "${key}" registered twice; the last one wins`);
    const e: Entry = { key, provider: provider as SaveProvider, scope: opts.scope ?? 'level', priority: opts.priority ?? 50, order: this.seq++ };
    this.entries.set(key, e);
    return () => {
      if (this.entries.get(key) === e) this.entries.delete(key);
    };
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(scope?: SaveScope): string[] {
    return this.sorted(scope).map((e) => e.key);
  }

  /** Blocks manual saving while fn returns a reason. Returns an unsubscribe function. */
  addVeto(fn: () => string | null | undefined): () => void {
    this.vetoes.add(fn);
    return () => this.vetoes.delete(fn);
  }

  /** First veto reason, or null when saving is allowed. */
  veto(): string | null {
    for (const fn of this.vetoes) {
      try {
        const r = fn();
        if (r) return r;
      } catch (err) {
        console.warn('[save] veto failed', err);
      }
    }
    return null;
  }

  private sorted(scope?: SaveScope): Entry[] {
    return [...this.entries.values()].filter((e) => !scope || e.scope === scope).sort((a, b) => a.priority - b.priority || a.order - b.order);
  }

  /** State of every provider of a scope (JSON round-tripped, so it can't alias live objects). */
  capture(scope: SaveScope): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.sorted(scope)) {
      try {
        const v = e.provider.save();
        if (v !== undefined) out[e.key] = JSON.parse(JSON.stringify(v));
      } catch (err) {
        console.error(`[save] provider "${e.key}" failed to save:`, err);
      }
    }
    return out;
  }

  /** Give each provider of a scope its state (providers without an entry are skipped). */
  apply(states: Record<string, unknown> | undefined, scope: SaveScope, info: LoadInfo): string[] {
    const done: string[] = [];
    if (!states) return done;
    for (const e of this.sorted(scope)) {
      if (!(e.key in states)) continue;
      try {
        e.provider.load(states[e.key], info);
        done.push(e.key);
      } catch (err) {
        console.error(`[save] provider "${e.key}" failed to load:`, err);
      }
    }
    return done;
  }

  /**
   * New Game: reset() every provider of a scope that has one. `except`: the states of a save
   * being loaded; providers it has an entry for are left to their load() (a save without a
   * provider's key, such as an imported original save, gets that provider's initial state).
   */
  reset(scope: SaveScope, except?: Record<string, unknown>): void {
    for (const e of this.sorted(scope)) {
      if (except && e.key in except) continue;
      try {
        e.provider.reset?.();
      } catch (err) {
        console.error(`[save] provider "${e.key}" failed to reset:`, err);
      }
    }
  }
}
