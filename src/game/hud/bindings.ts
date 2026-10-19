// Input bindings: the one place that maps physical input (keys, mouse buttons, the wheel,
// gamepad buttons and sticks) to the game's actions.
//
// Actions are the 40 rows of the game's keyboard page (Control Settings GUI #906 p30, in
// binding order; labels are those string refs, resolved at runtime). Each action has two
// keyboard/mouse slots (the page's two key columns, p29 = 2) and one gamepad slot (engine
// addition). Bindings persist in localStorage ('suffering.bindings.v1').
//
// How the rest of the engine sees the bindings
// --------------------------------------------
// The game systems were written against fixed codes (player.ts reads KeyW/Space/Shift...,
// world E, weapons R/G/brackets/digits/mouse buttons/wheel, insanity Q, main.ts F). Rather than
// rewriting every listener, a capture-phase translation layer (installed first, on window)
// rewrites physical input into each action's *canonical* code, the code its existing call site
// listens for:
//   * a physical input bound to action A whose code is one A's call site already accepts
//     (W for Forward, Up Arrow for Forward...) passes through untouched;
//   * any other input bound to A is swallowed and replaced by a synthetic event carrying A's
//     canonical code (keyboard, mouse button or wheel, whichever the call site listens to);
//   * a managed code (one some call site listens for) that is not bound to its own action is
//     swallowed, so rebinding really moves the action.
// Actions without a legacy call site (weapon selection by name, inventory, archives, turn and
// look keys...) are "native": handlers subscribe with onPress(action, fn) / isDown(action).
// New code should test actions, never codes: is(action, event), isDown(action), onPress().
// Nothing is translated while the front end (menus) is open or a text field has focus.
//
// Gamepad (src/app/gamepad.ts `pads`: any supported pad normalised to the standard layout):
// buttons behave like keys (codes Pad0..Pad16, bindable in the gamepad column of the keyboard
// page; the triggers Pad6 / Pad7 press at the Controller page's threshold). The pad column
// starts from one of the console layouts of the Controller page (PAD_LAYOUTS; "Custom" keeps
// the player's own column). The sticks are analog: the left stick moves with walk / run by
// deflection (PlayerController.setAnalogInput, which leaves setVirtualInput to scripted
// freezes), the right stick looks at the original's turn / pitch rates (220 / 84 deg/s x the
// Gameplay page's Turn / Pitch sensitivity, Invert Pitch) through the Controller page's dead
// zone, response curve and multiplier, plus the aim assist of src/game/weapons/aim-assist.ts. Start (Pad9) is reserved for the
// pause menu (MenuFlow polls it).
//
// Engine addition: a 41st action, Crouch (C / Ctrl were hard-wired in player.ts; the data's
// list has no crouch row), so that it can sit on a pad button and be rebound.
//
// Labels for help-text placeholders ("<Use>") come from labelMap(), which the HUD system
// publishes as services.input.bindings each level. They follow the last-used device: key names
// for keyboard / mouse, the connected pad's button names (Xbox A/B/X/Y, PlayStation Cross /
// Circle / Square / Triangle, Nintendo B/A/Y/X...) while a pad is in use.

import { padButtonName, pads, shapeStick, stickMove, type PadFamily } from '../../app/gamepad';
import { lookRates } from '../../app/player-rules';
import { AUTO_PITCH_DELAY, aimAssist, assistLook, autoPitchRate, pickTarget } from '../weapons/aim-assist';

export type ActionId =
  | 'map' | 'documents' | 'archives' | 'forward' | 'backward' | 'turnLeft' | 'turnRight' | 'strafeLeft' | 'strafeRight' | 'run'
  | 'lookUp' | 'lookDown' | 'fire' | 'throw' | 'jump' | 'use' | 'firstPerson' | 'health' | 'insanity' | 'reload'
  | 'flashlight' | 'flare' | 'rollLeft' | 'rollRight' | 'shiv' | 'fireAxe' | 'pistol' | 'dualPistols' | 'shotgun' | 'tommyGun'
  | 'flamethrower' | 'flashBang' | 'shrapnel' | 'tnt' | 'molotov' | 'prevWeapon' | 'nextWeapon' | 'prevThrown' | 'nextThrown' | 'inventory'
  | 'crouch';

/**
 * The keyboard page's action list, in the data's binding order (#906 p30[i] labels action i),
 * followed by the engine's own actions (DATA_ACTIONS onward: Crouch).
 */
export const ACTIONS: readonly ActionId[] = [
  'map', 'documents', 'archives', 'forward', 'backward', 'turnLeft', 'turnRight', 'strafeLeft', 'strafeRight', 'run',
  'lookUp', 'lookDown', 'fire', 'throw', 'jump', 'use', 'firstPerson', 'health', 'insanity', 'reload',
  'flashlight', 'flare', 'rollLeft', 'rollRight', 'shiv', 'fireAxe', 'pistol', 'dualPistols', 'shotgun', 'tommyGun',
  'flamethrower', 'flashBang', 'shrapnel', 'tnt', 'molotov', 'prevWeapon', 'nextWeapon', 'prevThrown', 'nextThrown', 'inventory',
  'crouch',
];

/** Number of actions the data's keyboard page names (p30); later ones are engine additions. */
export const DATA_ACTIONS = 40;

/** Engine labels of the engine-added actions (no game string exists). */
export const ENGINE_ACTION_LABELS: Partial<Record<ActionId, string>> = { crouch: 'Crouch' };

/**
 * Engine defaults. '' = unbound. The retail PC defaults are the RFL's main control table
 * (0x10167520, records {action id, device, code, -1, 1}; translated in RETAIL_PC_KEYS,
 * src/app/player-rules.ts, docs/re/player.md section 9): Map G, Documents V, Archives B, Forward
 * Up / W, Backward Down / S, Turn Num 4 / 6 (+ mouse), Left Left / A, Right Right / D, Run/Walk
 * Left Shift (running is the default), Look Num 8 / 2 (+ mouse), Fire left mouse / Num 0, Throw
 * right mouse / Num +, Jump Space, Use Left Alt / Mouse 4 / Enter, First Person Left Ctrl,
 * Health Tab, Insanity C, Reload R, Flashlight F, Flare T, Roll Left Q, Roll Right E, the
 * weapons 1..0 and `, Prev / Next Weapon [ / ], Prev / Next Thrown Num 1 / . and Num 3 / ,,
 * Inventory I. The engine keeps its own WASD-style set (C crouches, Q is Insanity, E is Use,
 * Tab the inventory, H Health), so the rolls (Player state 15, input 0x432 / 0x433) sit on
 * Z / X here.
 */
const DEFAULT_KEYS: Record<ActionId, [string, string]> = {
  map: ['KeyM', ''],
  documents: ['KeyJ', ''],
  archives: ['KeyK', ''],
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  turnLeft: ['', ''],
  turnRight: ['', ''],
  strafeLeft: ['KeyA', 'ArrowLeft'],
  strafeRight: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  lookUp: ['PageUp', ''],
  lookDown: ['PageDown', ''],
  fire: ['Mouse0', ''],
  throw: ['Mouse2', ''],
  jump: ['Space', ''],
  use: ['KeyE', ''],
  firstPerson: ['KeyV', ''],
  health: ['KeyH', ''],
  insanity: ['KeyQ', ''],
  reload: ['KeyR', ''],
  flashlight: ['KeyF', ''],
  flare: ['KeyT', ''],
  rollLeft: ['KeyZ', ''],
  rollRight: ['KeyX', ''],
  // Weapon selection follows the global cycle order (Item p38), see hud/actions.ts.
  shiv: ['Digit1', ''],
  fireAxe: ['Digit2', ''],
  pistol: ['Digit3', ''],
  dualPistols: ['Digit4', ''],
  tommyGun: ['Digit5', ''],
  shotgun: ['Digit6', ''],
  flamethrower: ['Digit7', ''],
  flashBang: ['Digit8', ''],
  shrapnel: ['Digit9', ''],
  tnt: ['Digit0', ''],
  molotov: ['Minus', ''],
  prevWeapon: ['WheelUp', 'BracketLeft'],
  nextWeapon: ['WheelDown', 'BracketRight'],
  prevThrown: ['', ''],
  nextThrown: ['KeyG', ''],
  inventory: ['Tab', ''],
  crouch: ['KeyC', 'ControlLeft'],
};

/**
 * Pad layouts of the Controller page ("Controller Setting", the console's preset names, strings
 * 5:400..5:404 and 5:406 Custom). The console's own button tables were not found in the data;
 * these are the engine's, console style (standard button indices as Pad<n>):
 *   RT fire, LT throw, RB next weapon, A jump, B crouch, X use, Y reload, LB insanity,
 *   View / Share / Minus archives, L3 run, R3 first / third person, D-pad up flashlight,
 *   down health, left next throwable, right inventory; Start pauses.
 * The variants move a few of them: Throw/Jump Swap (A throw, LT jump), Single Stick (same
 * buttons; the left stick turns instead of strafing, the right stick strafes and pitches),
 * Double Stick+Flashlight (flashlight on LB, insanity on D-pad up), Jump On Top (Y jump,
 * A reload).
 */
export const PAD_LAYOUT_COUNT = 6;
export const PAD_LAYOUT_CUSTOM = 5;
export const PAD_LAYOUT_SINGLE_STICK = 2;

const BASE_PAD: Partial<Record<ActionId, string>> = {
  jump: 'Pad0',
  crouch: 'Pad1',
  use: 'Pad2',
  reload: 'Pad3',
  insanity: 'Pad4',
  nextWeapon: 'Pad5',
  throw: 'Pad6',
  fire: 'Pad7',
  archives: 'Pad8',
  run: 'Pad10',
  firstPerson: 'Pad11',
  flashlight: 'Pad12',
  health: 'Pad13',
  nextThrown: 'Pad14',
  inventory: 'Pad15',
};

export function padLayout(layout: number): Partial<Record<ActionId, string>> {
  const p = { ...BASE_PAD };
  switch (layout) {
    case 1:
      p.jump = 'Pad6';
      p.throw = 'Pad0';
      break;
    case 3:
      p.flashlight = 'Pad4';
      p.insanity = 'Pad12';
      break;
    case 4:
      p.jump = 'Pad3';
      p.reload = 'Pad0';
      break;
  }
  return p;
}

const DEFAULT_PAD = BASE_PAD;

/**
 * Codes the existing call sites listen for, per action (the first is the canonical code
 * that translated input is rewritten to). Actions not listed are native (onPress / isDown).
 */
const LEGACY: Partial<Record<ActionId, string[]>> = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  strafeLeft: ['KeyA', 'ArrowLeft'],
  strafeRight: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  use: ['KeyE'],
  firstPerson: ['KeyV'],
  insanity: ['KeyQ'],
  reload: ['KeyR'],
  flashlight: ['KeyF'],
  fire: ['Mouse0'],
  throw: ['Mouse2'],
  prevWeapon: ['WheelUp', 'BracketLeft'],
  nextWeapon: ['WheelDown', 'BracketRight'],
  nextThrown: ['KeyG'],
  crouch: ['KeyC', 'ControlLeft', 'ControlRight'],
};

/** Codes some call site listens for without an action (weapon slot digits): swallowed in game. */
const EXTRA_MANAGED = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

/** Codes that cannot be bound (the page shows its "reserved key" string, #906 p28). */
export const RESERVED = new Set(['Escape', 'F1', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ContextMenu', 'Pad9']);

/** Help-text placeholder names (game strings, "<Use>") -> actions. */
const PLACEHOLDERS: Record<string, ActionId | ActionId[]> = {
  Use: 'use',
  Crouch: 'crouch',
  Attack: 'fire',
  Fire: 'fire',
  Throw: 'throw',
  Jump: 'jump',
  Run: 'run',
  LadderMove: ['forward', 'backward'],
  Flashlight: 'flashlight',
  FirstPerson: 'firstPerson',
  Insanity: 'insanity',
  Reload: 'reload',
  Health: 'health',
  UseHealth: 'health',
  Inventory: 'inventory',
  Map: 'map',
  NextWeapon: 'nextWeapon',
  PrevWeapon: 'prevWeapon',
  NextThrown: 'nextThrown',
  RollLeft: 'rollLeft',
  RollRight: 'rollRight',
};

export interface BindingSet {
  /** Two keyboard / mouse codes per action ('' = empty slot). */
  keys: Record<ActionId, [string, string]>;
  /** One gamepad button code per action ('' = none). */
  pad: Record<ActionId, string>;
  /** Controller page layout the pad column follows (PAD_LAYOUT_CUSTOM: the player's own). */
  padLayout: number;
  /** The player's own pad column (kept while a preset layout is selected). */
  customPad: Record<ActionId, string>;
}

const STORAGE_KEY = 'suffering.bindings.v1';

export function defaultBindings(): BindingSet {
  const keys = {} as BindingSet['keys'];
  const pad = {} as BindingSet['pad'];
  const customPad = {} as BindingSet['customPad'];
  for (const a of ACTIONS) {
    keys[a] = [...DEFAULT_KEYS[a]] as [string, string];
    pad[a] = customPad[a] = DEFAULT_PAD[a] ?? '';
  }
  return { keys, pad, padLayout: 0, customPad };
}

export function cloneBindings(b: BindingSet): BindingSet {
  const out = defaultBindings();
  for (const a of ACTIONS) {
    out.keys[a] = [...b.keys[a]] as [string, string];
    out.pad[a] = b.pad[a];
    out.customPad[a] = b.customPad[a];
  }
  out.padLayout = b.padLayout;
  return out;
}

function loadBindings(): BindingSet {
  const b = defaultBindings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return b;
    const d = JSON.parse(raw) as Partial<BindingSet>;
    for (const a of ACTIONS) {
      const k = d.keys?.[a];
      if (Array.isArray(k) && k.length === 2 && k.every((x) => typeof x === 'string')) b.keys[a] = [k[0], k[1]];
      const p = d.pad?.[a];
      if (typeof p === 'string') b.pad[a] = p;
      const c = d.customPad?.[a] ?? d.pad?.[a];
      if (typeof c === 'string') b.customPad[a] = c;
    }
    // Bindings stored before the rolls had keys: give them the defaults when nobody uses those.
    for (const a of ['rollLeft', 'rollRight'] as const) {
      const def = DEFAULT_KEYS[a][0];
      const taken = ACTIONS.some((x) => b.keys[x][0] === def || b.keys[x][1] === def);
      if (!b.keys[a][0] && !b.keys[a][1] && def && !taken) b.keys[a][0] = def;
    }
    if (typeof d.padLayout === 'number' && d.padLayout >= 0 && d.padLayout < PAD_LAYOUT_COUNT) b.padLayout = Math.round(d.padLayout);
    else {
      // Stored before the layouts existed: start from the default layout, keep the old column
      // as the Custom one.
      b.padLayout = 0;
      for (const a of ACTIONS) b.pad[a] = DEFAULT_PAD[a] ?? '';
    }
  } catch {
    /* storage unavailable or corrupt: defaults */
  }
  return b;
}

// ---------------------------------------------------------------------------
// Code names

const NAMED: Record<string, string> = {
  Mouse0: 'Left Mouse',
  Mouse1: 'Middle Mouse',
  Mouse2: 'Right Mouse',
  Mouse3: 'Mouse 4',
  Mouse4: 'Mouse 5',
  WheelUp: 'Wheel Up',
  WheelDown: 'Wheel Down',
  Space: 'Space',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ArrowUp: 'Up Arrow',
  ArrowDown: 'Down Arrow',
  ArrowLeft: 'Left Arrow',
  ArrowRight: 'Right Arrow',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
};

/**
 * Display name of an input code (engine wording; key names are not game text). Pad buttons are
 * named for `family` (default: the generic Xbox-style names).
 */
export function codeLabel(code: string, family: PadFamily = 'generic'): string {
  if (!code) return '';
  if (NAMED[code]) return NAMED[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  m = /^Pad(\d+)$/.exec(code);
  if (m) return padButtonName(Number(m[1]), family);
  return code;
}

/** Code of a physical event: KeyboardEvent.code, Mouse<button>, Wheel<Up|Down>. */
export function eventCode(e: Event): string | undefined {
  if (e instanceof KeyboardEvent) return e.code || undefined;
  if (e instanceof WheelEvent) return e.deltaY < 0 ? 'WheelUp' : e.deltaY > 0 ? 'WheelDown' : undefined;
  if (e instanceof MouseEvent) return `Mouse${e.button}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
// Runtime

/** What the gamepad drives (set by the menu flow from the renderer's PlayerController). */
export interface PadPlayer {
  enabled: boolean;
  yaw: number;
  pitch: number;
  sensitivity: number;
  pitchScale?: number;
  invertY?: boolean;
  /** Gameplay "Turn sensitivity" (settings +0x1c, 0.25..4); pitch uses pitchScale (+0x20). */
  turnScale?: number;
  /** Per-view-mode look limits (PlayerController.clampPitch). */
  clampPitch?(pitch: number): number;
  /** View mode: Auto Pitch Correction only runs in third person (docs/re/player.md 3.4). */
  mode?: 'fp' | 'tp';
  setVirtualInput(v: { forward: number; strafe: number; run?: boolean; crouch?: boolean } | null): void;
  /** Analog stick movement, combined with the keys (PlayerController). */
  setAnalogInput?(v: { forward: number; strafe: number; run?: boolean } | null): void;
}

type PressFn = (action: ActionId) => void;

// Look rates: the original's Turn / Pitch handlers (src/app/player-rules.ts lookRates,
// docs/re/player.md §12): an axis of 1 turns at 220 deg/s x Turn sensitivity and pitches at
// 84 deg/s x Pitch sensitivity, with no ramp. The PC build reads no joystick; the stick is fed in
// as the same axis (its dead zone rescaled linearly, like the binding records' lo field), the
// turn / look keys as an axis of 1.

class InputBindings {
  current: BindingSet = loadBindings();
  private installed = false;
  private readonly held = new Set<string>();
  /** Synthetic canonical codes held down, with the physical codes holding them. */
  private readonly synthHeld = new Map<string, Set<string>>();
  private readonly pressHandlers = new Map<ActionId | '*', Set<PressFn>>();
  private readonly changeHandlers = new Set<() => void>();
  private dispatching = false;
  private padPrev: boolean[] = [];
  private padMoving = false;
  private wasActive = true;
  private pitchIdle = 0;
  /** Last aim-assist target position (tracking also follows a moving target). */
  private lastLock: { id: number; x: number; y: number; z: number } | null = null;
  private player?: PadPlayer;
  /** True while gameplay input is suspended (front end open, capture prompt...). */
  suspended: () => boolean = () => false;
  /** Set while the keyboard page waits for a key: receives the next physical input. */
  capture: ((code: string) => void) | null = null;

  // --- queries -----------------------------------------------------------

  codes(a: ActionId): string[] {
    return [...this.current.keys[a], this.current.pad[a]].filter(Boolean);
  }

  /** Actions bound to a code. */
  actionsOf(code: string): ActionId[] {
    return ACTIONS.filter((a) => this.current.keys[a].includes(code) || this.current.pad[a] === code);
  }

  /** True if the event's input is bound to `a` (keyboard, mouse button or wheel event). */
  is(a: ActionId, e: Event): boolean {
    const c = eventCode(e);
    return !!c && this.codes(a).includes(c);
  }

  /** Held now (any bound key / button). */
  isDown(a: ActionId): boolean {
    for (const c of this.codes(a)) if (this.held.has(c)) return true;
    return false;
  }

  /** The pad layout the pad column follows (PAD_LAYOUT_CUSTOM: the player's own). */
  get padLayout(): number {
    return this.current.padLayout;
  }

  /**
   * Display text of an action's bindings ("E", "W / Up Arrow"); `slot` limits to one. Without a
   * slot, the pad button's name while a pad is in use (and the action has one).
   */
  label(a: ActionId, slot?: 0 | 1 | 'pad'): string {
    if (slot === 'pad') return codeLabel(this.current.pad[a], pads.family);
    if (slot !== undefined) return codeLabel(this.current.keys[a][slot]);
    if (pads.usingPad && this.current.pad[a]) return codeLabel(this.current.pad[a], pads.family);
    return this.current.keys[a].filter(Boolean).map((c) => codeLabel(c)).join(' / ');
  }

  /** Standard pad button index of an action ('' bindings: -1). */
  padButton(a: ActionId): number {
    const m = /^Pad(\d+)$/.exec(this.current.pad[a]);
    return m ? Number(m[1]) : -1;
  }

  /**
   * Placeholder name -> label, for help texts ("<Use>") and prompts: key names, or the pad's
   * button names while a pad is in use.
   */
  labelMap(): Record<string, string> {
    const pad = pads.usingPad;
    const fam = pads.family;
    const out: Record<string, string> = pad ? { GUISelect: padButtonName(0, fam), GUICancel: padButtonName(1, fam) } : { GUISelect: 'Enter', GUICancel: 'Esc' };
    for (const [name, a] of Object.entries(PLACEHOLDERS)) {
      const list = Array.isArray(a) ? a : [a];
      if (pad && name === 'LadderMove') {
        out[name] = 'Left Stick';
        continue;
      }
      const parts = list
        .map((x) => (pad && this.current.pad[x] ? codeLabel(this.current.pad[x], fam) : codeLabel(this.current.keys[x][0] || this.current.keys[x][1] || this.current.pad[x], fam)))
        .filter(Boolean);
      if (parts.length) out[name] = parts.join(' / ');
    }
    return out;
  }

  // --- editing -----------------------------------------------------------

  /** Binds `code` to an action slot; the code is removed from any other action first. */
  set(a: ActionId, slot: 0 | 1 | 'pad', code: string): void {
    const padEdit = slot === 'pad' || code.startsWith('Pad');
    if (code) {
      for (const b of ACTIONS) {
        const k = this.current.keys[b];
        if (k[0] === code) k[0] = '';
        if (k[1] === code) k[1] = '';
        if (this.current.pad[b] === code) this.current.pad[b] = '';
      }
    }
    if (slot === 'pad') this.current.pad[a] = code;
    else this.current.keys[a][slot] = code;
    if (padEdit) {
      // Editing the pad column makes it the player's own layout.
      this.current.padLayout = PAD_LAYOUT_CUSTOM;
      for (const b of ACTIONS) this.current.customPad[b] = this.current.pad[b];
    }
    this.changed();
  }

  /** Switches the pad column to a Controller page layout (PAD_LAYOUT_CUSTOM: the player's own). */
  setPadLayout(layout: number): void {
    const n = Math.max(0, Math.min(PAD_LAYOUT_COUNT - 1, Math.round(layout) || 0));
    if (n === this.current.padLayout) return;
    const preset = n === PAD_LAYOUT_CUSTOM ? this.current.customPad : padLayout(n);
    for (const a of ACTIONS) this.current.pad[a] = preset[a] ?? '';
    this.current.padLayout = n;
    this.changed();
  }

  replace(b: BindingSet): void {
    this.current = cloneBindings(b);
    this.changed();
  }

  resetDefaults(): void {
    this.replace(defaultBindings());
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      /* storage unavailable */
    }
  }

  onChange(fn: () => void): () => void {
    this.changeHandlers.add(fn);
    return () => this.changeHandlers.delete(fn);
  }

  private changed(): void {
    this.releaseAll();
    for (const fn of this.changeHandlers) fn();
  }

  // --- native actions ------------------------------------------------------

  /** Called when a bound input of `a` is pressed during gameplay ('*' = every action). */
  onPress(a: ActionId | '*', fn: PressFn): () => void {
    let set = this.pressHandlers.get(a);
    if (!set) this.pressHandlers.set(a, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private pressed(a: ActionId): void {
    for (const fn of this.pressHandlers.get(a) ?? []) fn(a);
    for (const fn of this.pressHandlers.get('*') ?? []) fn(a);
  }

  // --- translation layer ---------------------------------------------------

  /** Installs the capture listeners (once; before the game's own listeners). */
  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    pads.install();
    const opts = { capture: true, passive: false } as const;
    window.addEventListener('keydown', (e) => this.onInput(e, true), opts);
    window.addEventListener('keyup', (e) => this.onInput(e, false), opts);
    window.addEventListener('mousedown', (e) => this.onInput(e, true), opts);
    window.addEventListener('mouseup', (e) => this.onInput(e, false), opts);
    window.addEventListener('wheel', (e) => this.onInput(e, true), opts);
    window.addEventListener('blur', () => this.releaseAll());
  }

  attachPlayer(p: PadPlayer | undefined): void {
    this.player = p;
  }

  private onInput(e: Event, down: boolean): void {
    if (this.dispatching) return;
    const code = eventCode(e);
    if (!code) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (this.capture && down) {
      if (e instanceof KeyboardEvent && e.repeat) return;
      const fn = this.capture;
      e.preventDefault();
      e.stopImmediatePropagation();
      fn(code);
      return;
    }
    if (this.suspended()) {
      if (!down) this.held.delete(code);
      return;
    }
    const isWheel = code === 'WheelUp' || code === 'WheelDown';
    const repeat = e instanceof KeyboardEvent && e.repeat;
    if (down && !isWheel) this.held.add(code);
    else if (!down) this.held.delete(code);
    const handled = this.route(code, down, repeat, e);
    if (handled === 'swallow') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  /**
   * Routes one physical input. Returns 'pass' when the original event should reach the
   * game's listeners unchanged, 'swallow' when it was replaced (or must not act).
   */
  private route(code: string, down: boolean, repeat: boolean, e: Event | null): 'pass' | 'swallow' {
    const actions = this.actionsOf(code);
    let pass = false;
    let replaced = false;
    for (const a of actions) {
      if (down && !repeat) this.pressed(a);
      const legacy = LEGACY[a];
      if (!legacy) continue;
      if (legacy.includes(code)) {
        pass = true;
        continue;
      }
      replaced = true;
      this.emit(legacy[0], down, repeat, code, e);
    }
    if (pass) return 'pass';
    if (replaced) return 'swallow';
    // Unbound, or bound only to native actions: keep it away from the legacy listeners.
    return MANAGED.has(code) || actions.length ? 'swallow' : 'pass';
  }

  /** Dispatches the canonical input of an action (on behalf of physical `source`). */
  private emit(canonical: string, down: boolean, repeat: boolean, source: string, e: Event | null): void {
    const isWheel = canonical === 'WheelUp' || canonical === 'WheelDown';
    if (isWheel && !down) return;
    if (!isWheel) {
      let holders = this.synthHeld.get(canonical);
      if (down) {
        if (!holders) this.synthHeld.set(canonical, (holders = new Set()));
        // Key repeat is forwarded for keyboard canonicals only (mouse buttons don't repeat).
        if (holders.has(source) && (!repeat || canonical.startsWith('Mouse'))) return;
        holders.add(source);
      } else {
        if (!holders?.has(source)) return;
        holders.delete(source);
        if (holders.size) return; // another physical input still holds it
        this.synthHeld.delete(canonical);
      }
    }
    const target: EventTarget = (e?.target as EventTarget | null) ?? document.pointerLockElement ?? document.body;
    let ev: Event;
    if (isWheel) ev = new WheelEvent('wheel', { deltaY: canonical === 'WheelUp' ? -120 : 120, bubbles: true, cancelable: true });
    else if (canonical.startsWith('Mouse')) {
      const button = Number(canonical.slice(5));
      ev = new MouseEvent(down ? 'mousedown' : 'mouseup', { button, buttons: down ? 1 << button : 0, bubbles: true, cancelable: true });
    } else ev = new KeyboardEvent(down ? 'keydown' : 'keyup', { code: canonical, key: canonicalKey(canonical), repeat, bubbles: true, cancelable: true });
    this.dispatching = true;
    try {
      target.dispatchEvent(ev);
    } finally {
      this.dispatching = false;
    }
  }

  /** Releases every synthetic hold (rebinding, blur, menus opening). */
  releaseAll(): void {
    for (const canonical of [...this.synthHeld.keys()]) {
      const holders = this.synthHeld.get(canonical)!;
      for (const s of [...holders]) this.emit(canonical, false, false, s, null);
    }
    this.synthHeld.clear();
    this.held.clear();
    this.stopPadMove();
    aimAssist.lock = null;
  }

  private stopPadMove(): void {
    if (!this.padMoving) return;
    const p = this.player;
    if (p?.setAnalogInput) p.setAnalogInput(null);
    else p?.setVirtualInput(null);
    this.padMoving = false;
  }

  // --- per frame: gamepad + continuous native actions ---------------------------------

  /** Polls the gamepad and applies continuous actions (call once per frame). */
  update(dt: number): void {
    const st = pads.poll();
    const now: boolean[] = st ? [...st.pressed] : [];
    if (this.capture) {
      const i = now.findIndex((b, k) => b && !this.padPrev[k]);
      this.padPrev = now;
      if (i >= 0) this.capture(`Pad${i}`);
      return;
    }
    const active = !this.suspended();
    if (!active && this.wasActive) this.releaseAll();
    this.wasActive = active;
    // Buttons held while a menu was open (the A that closed it) don't count as new presses:
    // padPrev follows the pad while suspended.
    if (active) {
      for (let i = 0; i < Math.max(now.length, this.padPrev.length); i++) {
        const was = !!this.padPrev[i];
        const is = !!now[i];
        if (is === was || i === 9) continue;
        const code = `Pad${i}`;
        if (is) this.held.add(code);
        else this.held.delete(code);
        this.route(code, is, false, null);
      }
    }
    this.padPrev = now;
    const p = this.player;
    const o = pads.options;
    aimAssist.enabled = o.aimAssist && pads.usingPad;
    if (!active || !p || !p.enabled) {
      this.stopPadMove();
      aimAssist.lock = null;
      this.pitchIdle = 0;
      return;
    }
    let yawRate = 0;
    let pitchRate = 0;
    if (st) {
      // Sticks: Single Stick turns with the left stick and strafes with the right one.
      const single = this.current.padLayout === PAD_LAYOUT_SINGLE_STICK;
      const [lx, ly, rx, ry] = st.axes;
      const mv = stickMove(single ? rx : lx, ly, o.deadZone);
      const [sx, sy] = shapeStick(single ? lx : rx, ry, o.deadZone, o.curve);
      if (mv.magnitude > 0) {
        const v = { forward: mv.forward, strafe: mv.strafe, run: mv.run };
        if (p.setAnalogInput) p.setAnalogInput(v);
        else p.setVirtualInput(v);
        this.padMoving = true;
      } else this.stopPadMove();
      // The right stick is the Turn / Look axis pair (x the Controller page's own multiplier).
      ({ yaw: yawRate, pitch: pitchRate } = lookRates(-sx * o.sensitivity, -sy * o.sensitivity, { turnSens: p.turnScale ?? 1, pitchSens: p.pitchScale ?? 1, invert: p.invertY }));
      // Aim assist (gamepad play only).
      // Original rules (src/game/weapons/aim-assist.ts): pick in the 5 x 3 deg pyramid out to the
      // held gun's range, slow the stick down near the target, keep it centred while moving.
      const prov = aimAssist.provider;
      const moving = mv.magnitude > 0.05;
      const range = prov?.range ? prov.range() : undefined;
      if (aimAssist.enabled && prov && range !== 0) {
        const lock = pickTarget(prov.eye(), p.yaw, p.pitch, prov.candidates(), { blocked: prov.blocked, range });
        aimAssist.lock = lock;
        const prev = this.lastLock;
        const t = lock?.target;
        const targetMoved = !!(t && prev && prev.id === t.id && Math.hypot(t.x - prev.x, t.y - prev.y, t.z - prev.z) > 1e-3);
        this.lastLock = t ? { id: t.id, x: t.x, y: t.y, z: t.z } : null;
        const steer = Math.max(Math.hypot(sx, sy), mv.magnitude * 0.6);
        ({ yaw: yawRate, pitch: pitchRate } = assistLook(lock, { yaw: yawRate, pitch: pitchRate }, steer, p.pitch, { dt, moving, targetMoved }));
      } else (aimAssist.lock = null), (this.lastLock = null);
      // Auto Pitch Correction (Pitch per-frame 0x1003fc40): after 2.2 s of third-person movement
      // without a target the pitch returns to level at 42 deg/s. The original overrides the stick;
      // the port waits for it to be centred.
      if (o.autoPitch && pads.usingPad && p.mode !== 'fp' && moving && !aimAssist.lock && Math.abs(sy) < 0.05) this.pitchIdle += dt;
      else this.pitchIdle = 0;
      if (this.pitchIdle > AUTO_PITCH_DELAY) pitchRate += autoPitchRate(p.pitch, 0, dt);
    } else {
      this.stopPadMove();
      aimAssist.lock = null;
    }
    // Turn / look keys (native actions): an axis of 1 at the same rates.
    const keys = lookRates((this.isDown('turnLeft') ? 1 : 0) - (this.isDown('turnRight') ? 1 : 0), (this.isDown('lookUp') ? 1 : 0) - (this.isDown('lookDown') ? 1 : 0), { turnSens: p.turnScale ?? 1, pitchSens: p.pitchScale ?? 1, invert: p.invertY });
    yawRate += keys.yaw;
    pitchRate += keys.pitch;
    if (yawRate && Number.isFinite(yawRate)) p.yaw += yawRate * dt;
    if (pitchRate && Number.isFinite(pitchRate)) p.pitch = p.clampPitch ? p.clampPitch(p.pitch + pitchRate * dt) : Math.max(-1.45, Math.min(1.45, p.pitch + pitchRate * dt));
  }
}

const MANAGED = new Set<string>([...Object.values(LEGACY).flat(), ...EXTRA_MANAGED]);

function canonicalKey(code: string): string {
  if (code === 'Space') return ' ';
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  if (code.startsWith('Shift')) return 'Shift';
  if (code.startsWith('Control')) return 'Control';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  return code;
}

/** The engine-wide input bindings. */
export const input = new InputBindings();

/**
 * True while a pad drives gameplay (the systems that require pointer lock for mouse play accept
 * pad input without it: browsers only grant pointer lock on a mouse / key gesture).
 */
export function padPlaying(): boolean {
  return pads.usingPad && !input.suspended();
}
