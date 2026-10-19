// Player profile: progress that outlives a single game, like the retail game's settings file
// (the Game Finished screen offers to save the settings file to keep this content,
// docs/frontend.md §8). Holds
//   * the Archive Pages unlocked by Archives Trigger objects (and by finishing the game),
//     keyed by the page's template ref ("5:467");
//   * the prelude unlock (engine flag 0x400 in the original, set by the Game Finished class):
//     New Game then starts the Prelude level (Main Menu p18) instead of level 1a (p17).
// Persisted in localStorage ('suffering.profile.v1'); every access is wrapped (private windows
// keep the progress for the session only). Game-scope save providers (src/game/hud/level-ui.ts)
// also carry the unlocks inside each save, merged back into the profile when a save loads.
//
// Campaign API (src/game/campaign/*): call `profile.setGameFinished()` when the game ends
// (or open the Game Finished screen through the GUI Launcher path, which calls it).

const KEY = 'suffering.profile.v1';

interface ProfileData {
  pages: string[];
  prelude: boolean;
}

class Profile {
  private pages = new Set<string>();
  private _prelude = false;
  private readonly listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<ProfileData>;
        if (Array.isArray(d.pages)) for (const p of d.pages) if (typeof p === 'string' && /^\d+:\d+$/.test(p)) this.pages.add(p);
        this._prelude = d.prelude === true;
      }
    } catch {
      /* storage unavailable or corrupt */
    }
  }

  /** Prelude level unlocked (the game was finished once). */
  get preludeUnlocked(): boolean {
    return this._prelude;
  }

  isUnlocked(page: string): boolean {
    return this.pages.has(page);
  }

  unlockedPages(): string[] {
    return [...this.pages];
  }

  /** Unlocks archive pages; returns the ones that were new. */
  unlockPages(pages: Iterable<string>): string[] {
    const fresh: string[] = [];
    for (const p of pages) {
      if (!this.pages.has(p)) {
        this.pages.add(p);
        fresh.push(p);
      }
    }
    if (fresh.length) this.changed();
    return fresh;
  }

  /**
   * The game was finished: unlocks the prelude level and `pages` (the archive pages the
   * Game Finished notice promises; the flow passes every page of both sets [guess]).
   */
  setGameFinished(pages: Iterable<string> = []): void {
    const had = this._prelude;
    this._prelude = true;
    if (!this.unlockPages(pages).length && !had) this.changed();
  }

  /** Developer / tests: forget everything. */
  reset(): void {
    this.pages.clear();
    this._prelude = false;
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ pages: [...this.pages], prelude: this._prelude } satisfies ProfileData));
    } catch {
      /* storage unavailable */
    }
    for (const fn of this.listeners) fn();
  }
}

export const profile = new Profile();
