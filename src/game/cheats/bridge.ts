// The running level's cheats for the pause menu's port page (src/app/menu: "Cheats", not in the
// original game). The cheats system (system.ts) fills it while a level runs.

export interface CheatEntry {
  /** Dispatcher case (0..24). */
  index: number;
  /** In-game name (Game Cheats p0..p24 from the user's data), or a placeholder without it. */
  name: string;
  /** Toggle state for the two screen-effect toggles (cases 20 / 21). */
  on?: boolean;
}

export const cheatsBridge: {
  list: (() => CheatEntry[]) | null;
  apply: ((index: number) => void) | null;
} = { list: null, apply: null };
