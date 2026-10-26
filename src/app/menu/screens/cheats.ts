// Pause menu port page "Cheats" (not in the original game; a testing convenience). It lists the
// original's 25 cheats (src/game/cheats) by their in-game names, read from the user's data while
// a level runs (Game Cheats p0..p24), and applies one per press, as typing its key sequence would.
// The flow fills the labels when the page opens (MenuFlow 'openCheats') and after each press (the
// two screen-effect toggles show On / Off).

import type { CheatEntry } from '../../../game/cheats/bridge';
import type { MenuItem, MenuScreen, Placed } from '../model';

export const CHEATS_SCREEN = 'portCheats';
export const CHEATS_BUTTON = 'Cheats (port)';
export const CHEATS_HEADING = 'Cheats - port convenience, not in the original game. In play: the original key sequences work too.';

const ROWS = 13;

/** The page: two columns of 13 rows (25 cheats) and Back, in the style of `style`. */
export function cheatsScreen(style: Placed, dim?: number): MenuScreen {
  const at = (x: number, y: number, w: number, h: number, scale: number, hAlign: Placed['hAlign']): Placed => ({ ...style, scale, hAlign, vAlign: 'middle', margins: undefined, rect: { x, y, w, h } });
  const items: MenuItem[] = [];
  for (let i = 0; i < 25; i++) {
    const col = Math.floor(i / ROWS);
    const row = i % ROWS;
    items.push({ type: 'button', label: { text: `Cheat ${i}` }, action: { kind: 'cheat', index: i }, place: at(col === 0 ? 24 : 328, 76 + row * 26, 288, 24, 0.62, 'left') });
  }
  items.push({ type: 'button', label: { text: 'Back' }, action: { kind: 'back' }, place: at(270, 424, 100, 28, 0.8, 'center') });
  return {
    id: CHEATS_SCREEN,
    layout: 'placed',
    message: { text: CHEATS_HEADING },
    messagePlace: { ...at(40, 24, 560, 44, 0.6, 'center'), vAlign: 'top' },
    items,
    dim: dim ?? 0.75,
  };
}

/** Labels from the running level (index + name; toggles with their state). */
export function fillCheats(screen: MenuScreen, entries: readonly CheatEntry[]): void {
  for (const e of entries) {
    const it = screen.items[e.index];
    if (!it || it.type !== 'button' || it.action.kind !== 'cheat') continue;
    it.label = { text: `${e.index + 1}. ${e.name}${e.on === undefined ? '' : e.on ? ' (On)' : ' (Off)'}` };
    it.disabled = false;
  }
}
