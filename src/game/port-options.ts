// Port options that change the game's rules. None of them is in the original game; each is
// labelled as a port option in the menu and documented in docs/game-logic.md §15.17.
//
// The original's cheats are the Game Cheats object (class 0x2b195280, template 2:935): 25 typed
// sequences dispatched by Suffering.rfl 0x100013c0 (jump table 0x1000187c), all on the Player:
// reputation (+-50, to p70 / p71), blood full / clear, health, suicide, weapons and items
// (0x100421c0), ammo, grenades, two more Player state changes (insanity [inferred]), a
// combination of five, and two screen-effect toggles.
// None of them touches the creatures or their target choice [verified: all 25 cases], and the
// engine has no debug variable for it [verified: no such strings in SUFFERING.EXE /
// Suffering.rfl]. "Enemies ignore the player" is therefore the port's own.
//
// The live flag is read by the actors system every frame (env.ignorePlayer) and by the HUD's
// indicator. The menu's Gameplay pages set it (settings `extra.ignorePlayer`, saved with the other
// settings: src/app/menu/settings.ts applySettings); `?ignorePlayer=1` / `=0` on the page URL
// overrides the saved value for that page load.

import { SETTINGS_KEY } from '../app/enhanced/config';

export interface PortOptions {
  /** Enemies never take the player as a target, ignore his noise and start no special move on him. */
  ignorePlayer: boolean;
}

/** `?ignorePlayer=1` (or `true` / empty) forces it on, `=0` / `false` off; undefined: not given. */
export function ignorePlayerOverride(search: string = typeof location !== 'undefined' ? location.search : ''): boolean | undefined {
  const q = new URLSearchParams(search);
  if (!q.has('ignorePlayer')) return undefined;
  const v = (q.get('ignorePlayer') ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** The saved setting (`extra.ignorePlayer`), for pages without the menu flow (the level deep link). */
export function storedIgnorePlayer(): boolean {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    const extra = raw ? (JSON.parse(raw) as { extra?: Record<string, unknown> }).extra : null;
    return !!extra && typeof extra === 'object' && extra.ignorePlayer === true;
  } catch {
    return false;
  }
}

export const portOptions: PortOptions = {
  ignorePlayer: ignorePlayerOverride() ?? storedIgnorePlayer(),
};
