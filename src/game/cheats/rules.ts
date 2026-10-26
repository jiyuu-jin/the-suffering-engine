// The original game's cheats (docs/game-logic.md §15.18), renderer-free: the key-sequence input,
// the 25 cases and the data they read. The system (system.ts) applies them through the port's
// services; tests/cheats.test.ts runs these rules against the user's own install.
//
// Input [verified, Suffering.rfl 0x100018e0, polled by the game frame 0x100b1960 at 0x100b19b3
// whenever the game state 0x1017ac2c is 2 (a level running), paused or not; state object
// 0x1017bae8]:
//   - the keyboard state comes as a bit set of DirectInput key codes ([0x1017bf90] vt+8);
//   - a chord must be held: the -1-terminated key list at 0x1014b0b8 (all of its keys down;
//     their bits are taken out of the state). Released: the sequence buffer empties;
//   - while held, every key that went down since the previous poll is appended to the buffer
//     (+0x10, at most 32: then nothing more until the chord is released), lowest code first;
//   - after each append the buffer is compared with the 25 sequences (pointer table 0x1014b480,
//     each a -1-terminated key list): a sequence matches when the buffer starts with it, the
//     lowest index first; a wrong key therefore spoils the attempt until the chord is released
//     (the comparison always starts at the first key);
//   - a match runs the dispatcher 0x100013c0 (case, announce = 1) and blocks the input until the
//     chord is released (+4). No other key is consumed: the keys keep their game bindings.
//   The chord and the sequences are code data of Suffering.rfl: the port reads them from the
//   user's file at runtime (readCheatInput) and keeps none of them.
//
// Dispatch [verified, 0x100013c0, jump table 0x1000187c]: on the Player only (no Player: nothing).
// The Game Cheats template is the Player's p314 (2:935): p0..p24 the names shown in the pickup text
// widget (0x100bc260) after a cheat, p25..p32 item lists, p33 / p34 the confirmation sounds (p34
// for the combination, case 19), p35 / p36 the sounds of the two screen-effect toggles. The shown
// name is not always the case's own index (cases 22 / 23 / 24 show p24 / p22 / p23).

import { peOffset, readPe } from '../../formats/pe';
import type { ResRef } from '../../formats/model';

/** Number of cheats (the dispatcher's jump table). */
export const CHEAT_COUNT = 25;
/** Suffering.rfl: the held chord (key list, -1 terminated) [verified]. */
export const RFL_CHEAT_CHORD = 0x1014b0b8;
/** Suffering.rfl: 25 pointers to the key sequences (-1 terminated) [verified]. */
export const RFL_CHEAT_SEQUENCES = 0x1014b480;
/** The buffer's size (+0x10, 32 entries): full, the input waits for the chord's release. */
export const CHEAT_BUFFER = 32;

/** The Player template (2:5) and its Game Cheats reference p314 / its own item list p315. */
export const PLAYER_TEMPLATE: ResRef = { pkg: 2, id: 5 };
export const PLAYER_CHEATS_PROP = 314;
export const PLAYER_ALL_ITEMS_PROP = 315;

/** Chord and sequences as DirectInput key codes. */
export interface CheatInputData {
  chord: number[];
  sequences: number[][];
}

/**
 * The chord and the 25 sequences from the user's Suffering.rfl (`readPe` / `peOffset` map the
 * virtual addresses to the file). Null when the file is not the retail one (a list runs past 32
 * keys, a code is not a key code, a pointer leaves the image).
 */
export function readCheatInput(rfl: Uint8Array): CheatInputData | null {
  try {
    const img = readPe(rfl);
    const v = new DataView(rfl.buffer, rfl.byteOffset, rfl.byteLength);
    const u32 = (va: number): number | undefined => {
      const o = peOffset(img, va);
      return o < 0 || o + 4 > rfl.byteLength ? undefined : v.getUint32(o, true);
    };
    const list = (va: number): number[] | null => {
      const out: number[] = [];
      for (let i = 0; i <= CHEAT_BUFFER; i++) {
        const k = u32(va + 4 * i);
        if (k === undefined) return null;
        if (k === 0xffffffff) return out.length ? out : null;
        if (k > 0xff) return null;
        out.push(k);
      }
      return null;
    };
    const chord = list(RFL_CHEAT_CHORD);
    if (!chord) return null;
    const sequences: number[][] = [];
    for (let i = 0; i < CHEAT_COUNT; i++) {
      const p = u32(RFL_CHEAT_SEQUENCES + 4 * i);
      const s = p === undefined ? null : list(p);
      if (!s) return null;
      sequences.push(s);
    }
    return { chord, sequences };
  } catch {
    return null;
  }
}

/** KeyboardEvent.code -> DirectInput key code (DIK_*); keys without one never match. */
export const DIK: Readonly<Record<string, number>> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x9c, ControlRight: 0x9d, NumpadDivide: 0xb5, PrintScreen: 0xb7, AltRight: 0xb8, Pause: 0xc5,
  Home: 0xc7, ArrowUp: 0xc8, PageUp: 0xc9, ArrowLeft: 0xcb, ArrowRight: 0xcd, End: 0xcf, ArrowDown: 0xd0,
  PageDown: 0xd1, Insert: 0xd2, Delete: 0xd3, MetaLeft: 0xdb, MetaRight: 0xdc, ContextMenu: 0xdd,
};

/**
 * The original's input state (0x1017bae8: +0 chord held, +4 just matched / full, +0xc / +0x10 the
 * buffer, +0x94 the previous key state). `poll` takes the keys down now and returns the matched
 * cheat or -1. The port polls on every key change; the original once per frame, which differs only
 * for keys pressed within the same frame (appended in code order there).
 */
export class CheatInput {
  held = false;
  blocked = false;
  readonly buffer: number[] = [];
  private prev = new Set<number>();

  constructor(readonly data: CheatInputData) {}

  poll(down: Iterable<number>): number {
    const cur = new Set(down);
    // The chord: each of its keys must be down (its bit is cleared); the first one up ends it.
    this.held = true;
    for (const k of this.data.chord) {
      if (!cur.has(k)) {
        this.held = false;
        this.buffer.length = 0;
        break;
      }
      cur.delete(k);
    }
    // After a match (or a full buffer) nothing happens until the chord is let go; the previous
    // key state is not updated meanwhile.
    if (this.blocked && this.held) return -1;
    this.blocked = false;
    if (this.held) {
      const fresh = [...cur].filter((k) => !this.prev.has(k)).sort((a, b) => a - b);
      for (const k of fresh) {
        this.buffer.push(k);
        if (this.buffer.length >= CHEAT_BUFFER) {
          this.blocked = true;
          return -1;
        }
      }
      const hit = matchCheat(this.data.sequences, this.buffer);
      if (hit >= 0) {
        this.blocked = true;
        return hit;
      }
    }
    this.prev = cur;
    return -1;
  }

  reset() {
    this.held = this.blocked = false;
    this.buffer.length = 0;
    this.prev.clear();
  }
}

/** The first sequence the buffer starts with (0x10001a4a..0x10001a82), or -1. */
export function matchCheat(sequences: readonly (readonly number[])[], buffer: readonly number[]): number {
  for (let i = 0; i < sequences.length; i++) {
    const s = sequences[i];
    if (s.length && buffer.length >= s.length && s.every((k, j) => buffer[j] === k)) return i;
  }
  return -1;
}

// --- The 25 cases -------------------------------------------------------------------------

export type CheatEffect =
  /** Reputation += amount (0x10041460, no clamp). */
  | { kind: 'reputationAdd'; amount: number }
  /** Reputation = Player p70 (evil end) / p71 (good end) (0x100414b0 / 0x10041480). */
  | { kind: 'reputationSet'; end: 'evil' | 'good' }
  /** Blood: add the maximum (0x1002b2d0: the blood component's add, so the held weapon too and, transformed, only the pending fill) / level to 0 (+0x42). */
  | { kind: 'bloodFill' }
  | { kind: 'bloodClear' }
  /** A 100000 blow to the player (vt+0x58). */
  | { kind: 'suicide'; amount: number }
  /** Give an item list (0x100421c0 n): each template spawned at the player and handed over (vt+0xa0). */
  | { kind: 'give'; list: number }
  /** No Flashlight: give one; then 10 of its p69 (batteries), capped (0x10042120). */
  | { kind: 'flashlight'; batteries: number }
  /** The Ranged Weapon in hand: + amount of its p68 ammo, capped at the ammo's p44 (0x10037f20). */
  | { kind: 'ammo'; amount: number }
  /** The selected throwable (the item on the throw bone) topped up to `count` (0x1003a3a0). */
  | { kind: 'throwables'; count: number }
  /** Transformed only (else silent): the next insanity attack, state 30 (0x10042100). */
  | { kind: 'insanityAttack' }
  /** Insanity meter = Player p258 (0x10033270). */
  | { kind: 'meterFull' }
  /** Health = its maximum (+0x1a) through the health setter (vt+0x50). */
  | { kind: 'healthFull' }
  /** Runs other cases without their announcement (case 19: 16, 15, 2, 9, 18). */
  | { kind: 'combo'; cases: number[] }
  /** Screen-effect toggles (Game Cheats state +0xd4 / +0xdc). */
  | { kind: 'toggle'; effect: 'greyFilm' | 'fullGlow' };

export interface CheatCase {
  /** Game Cheats property shown as the name (0x10001852: the dispatcher's edi). */
  name: number;
  effect: CheatEffect;
}

/** Case -> name and effect [verified, every case of 0x100013c0]. */
export const CHEAT_CASES: readonly CheatCase[] = [
  { name: 0, effect: { kind: 'reputationAdd', amount: -50 } },
  { name: 1, effect: { kind: 'reputationAdd', amount: 50 } },
  { name: 2, effect: { kind: 'bloodFill' } },
  { name: 3, effect: { kind: 'bloodClear' } },
  { name: 4, effect: { kind: 'suicide', amount: 100000 } },
  { name: 5, effect: { kind: 'give', list: 0 } },
  { name: 6, effect: { kind: 'give', list: 1 } },
  { name: 7, effect: { kind: 'give', list: 2 } },
  { name: 8, effect: { kind: 'give', list: 3 } },
  { name: 9, effect: { kind: 'reputationSet', end: 'evil' } },
  { name: 10, effect: { kind: 'reputationSet', end: 'good' } },
  { name: 11, effect: { kind: 'flashlight', batteries: 10 } },
  { name: 12, effect: { kind: 'ammo', amount: 1000000 } },
  { name: 13, effect: { kind: 'throwables', count: 8 } },
  { name: 14, effect: { kind: 'insanityAttack' } },
  { name: 15, effect: { kind: 'meterFull' } },
  { name: 16, effect: { kind: 'healthFull' } },
  { name: 17, effect: { kind: 'give', list: 4 } },
  { name: 18, effect: { kind: 'give', list: 5 } },
  { name: 19, effect: { kind: 'combo', cases: [16, 15, 2, 9, 18] } },
  { name: 20, effect: { kind: 'toggle', effect: 'greyFilm' } },
  { name: 21, effect: { kind: 'toggle', effect: 'fullGlow' } },
  { name: 24, effect: { kind: 'give', list: 8 } },
  { name: 22, effect: { kind: 'give', list: 6 } },
  { name: 23, effect: { kind: 'give', list: 7 } },
];

/**
 * Where give list n comes from (0x100421c0, jump table 0x100422ec) [verified]: 0..4 Game Cheats
 * p25..p29, 5 the Player's own p315, 6..8 Game Cheats p30..p32.
 */
export function giveListSource(n: number): { from: 'cheats' | 'player'; prop: number } | undefined {
  if (n === 5) return { from: 'player', prop: PLAYER_ALL_ITEMS_PROP };
  if (n >= 0 && n <= 4) return { from: 'cheats', prop: 25 + n };
  if (n >= 6 && n <= 8) return { from: 'cheats', prop: 24 + n };
  return undefined;
}

/** Confirmation sound property: p34 for the combination (case 19), p33 otherwise (0x1000180e). */
export const confirmSoundProp = (c: number) => (c === 19 ? 34 : 33);

/**
 * The two toggles [verified: 0x1000165b / 0x1000171b; SUFFERING.EXE engine vtable 0x58ca50]:
 *  - grey film (+0xd4): engine slot +0x28 -> renderer +0x134 (0x49a160): the end-of-frame blit
 *    (0x49d5d0) draws through pixel shader 0, xvsh\xpsBW_PC.psh (a dot product with (0.3, 0.55,
 *    0.15): grey); the clock at 1.3 (slot +0x44, 0x40b8a0); sound p35 (looping) while on;
 *  - whole-frame glow (+0xdc): engine slot +0x24 -> glow state 0x5ba0a4 +0xc (0x48cde0): the HDR
 *    scene glow takes the whole frame, not only the marked pixels (0x48d232..0x48d2e9); the
 *    clock at 0.7; sound p36 while on.
 * Off: the flag 0, the clock 1, the sound stopped (sound manager vt+0xc8 with 1.0).
 */
export const TOGGLES = {
  greyFilm: { clock: 1.3, sound: 35 },
  fullGlow: { clock: 0.7, sound: 36 },
} as const;

/** The grey of xpsBW_PC.psh: weights of R, G, B (on the frame's gamma values) [verified]. */
export const GREY_WEIGHTS: readonly [number, number, number] = [0.3, 0.55, 0.15];

/** Grey of a gamma-encoded colour as the shader computes it (dp3, saturated). */
export function greyOf(r: number, g: number, b: number): number {
  const [wr, wg, wb] = GREY_WEIGHTS;
  return Math.max(0, Math.min(1, wr * r + wg * g + wb * b));
}
