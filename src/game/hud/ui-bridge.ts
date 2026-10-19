// Bridge from game systems (level objects, HUD) to the front end (src/app/menu/flow.ts), so
// game code can open UI screens without importing the menu. The menu flow fills these in;
// without the menu flow (developer viewer) they stay undefined and callers fall back.

import type { MapScreenData } from './map';

export interface UiBridge {
  /**
   * Modal alert box over the paused game: `box` = Alert Box template ref (GUI Launcher p1,
   * e.g. "5:247"), `text` = message. Resolves with the button index when closed.
   */
  alert(box: string | undefined, text: string): Promise<number>;
  /** Credits roll (GUI Launcher mode 2). */
  credits(): Promise<void>;
  /** Game Finished screen (GUI Launcher mode 6): unlock notice, then the main menu. */
  gameFinished(): void;
  /** Archives viewer over the paused game (Archives / Documents keys). */
  archives(): void;
  /** Map screen over the paused game (Map key); false when it could not open. */
  map(data: MapScreenData): boolean;
  /** Death: revert to the last checkpoint now (falls back to restarting the level). */
  revert(): void;
  /** Label resolver for game string refs ("5:107"). */
  label(ref: string): string | undefined;
  /**
   * Set by the sequence system (game -> menu direction): skips the running cinematic and returns
   * true, or returns false when none runs. The menu flow calls it for gamepad Start / A / B, so
   * that Start skips a cinematic instead of pausing (Esc does the same on the keyboard).
   */
  skipCutscene(): boolean;
}

export const uiBridge: Partial<UiBridge> = {};
