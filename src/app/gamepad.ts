// Gamepads: the one module that talks to the browser's Gamepad API. Everything else (gameplay
// bindings, menu navigation, the rebinding / calibration pages, cutscene skipping, rumble,
// button glyphs) reads the normalised state from `pads`.
//
// What it does
// ------------
//   * Polls navigator.getGamepads() (lazily, at most once per ~4 ms, so every consumer in a
//     frame shares one snapshot) and normalises the active pad to the W3C "standard" layout:
//     17 buttons (0 bottom face, 1 right face, 2 left face, 3 top face, 4/5 bumpers, 6/7
//     triggers, 8 back/view, 9 start/menu, 10/11 stick clicks, 12..15 d-pad, 16 home) and four
//     stick axes (LX, LY, RX, RY; +Y = down).
//   * Pads the browser already maps (`mapping === 'standard'`, the usual case for Xbox,
//     DualShock 4, DualSense and Switch Pro controllers in Chrome / Brave / Edge, Safari and
//     Firefox on macOS) are used as they are. Others go through a remap table keyed by the
//     vendor / product parsed from `gamepad.id` (REMAPS below), then through a per-device
//     calibration made on the Controller page ("press each button"), then a generic guess.
//   * Hot-plug: Bluetooth pads drop and come back (often at another index). Connect /
//     disconnect is detected from the events and from polling; the active pad is the most
//     recently *used* one, so a reconnected pad takes over as soon as a button is pressed.
//   * Last-used device: keyboard / mouse input or pad input switches `lastDevice`, which drives
//     the button labels / glyphs and hides the mouse cursor (class `pad-active` on <html>).
//   * Rumble: `vibrationActuator.playEffect('dual-rumble')`, falling back to
//     `hapticActuators[0].pulse()`; silently nothing where neither exists (Safari, Firefox
//     without the pref). The game's own rumble curves (.wdu type 0x60, referenced by sound
//     headers at +0x28) are mixed and streamed to the actuator (attachAudioRumble).
//
// The pure helpers (id parsing, remapping, dead zones, response curves, rumble-curve decoding)
// are exported for tests (tests/gamepad.test.ts).

import type { AudioSystem, PlayOptions } from './audio';
import type { SoundInfo } from '../formats/sound';
import { SrscFile } from '../formats/srsc';

// ---------------------------------------------------------------------------
// Identification

export type PadFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic';

export interface PadIdInfo {
  vendor?: number;
  product?: number;
  /** Product name without the browser's decorations. */
  name: string;
}

/**
 * Parses the browser's `gamepad.id`:
 *   Chromium: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
 *             "8BitDo SN30 Pro (Vendor: 2dc8 Product: 6101)"            (no standard mapping)
 *   Firefox:  "054c-09cc-Wireless Controller" / "45e-2e0-Xbox Wireless Controller" (no padding)
 *   Safari:   "DualSense Wireless Controller", "Pro Controller"         (name only)
 */
export function parsePadId(id: string): PadIdInfo {
  const s = id.trim();
  let m = /^(.*?)\s*\((?:STANDARD GAMEPAD\s*)?Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})\)\s*$/i.exec(s);
  if (m) return { vendor: parseInt(m[2], 16), product: parseInt(m[3], 16), name: m[1].trim() || s };
  m = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.*)$/i.exec(s);
  if (m) return { vendor: parseInt(m[1], 16), product: parseInt(m[2], 16), name: m[3].trim() };
  m = /^(.*?)\s*\(STANDARD GAMEPAD\)\s*$/i.exec(s);
  if (m) return { name: m[1].trim() || s };
  return { name: s };
}

export const VENDOR = { microsoft: 0x045e, sony: 0x054c, nintendo: 0x057e, eightBitDo: 0x2dc8 } as const;

/** Button-label family of a pad (decides glyphs and names). */
export function padFamily(info: PadIdInfo): PadFamily {
  const n = info.name.toLowerCase();
  // "Wireless Controller" (bare) is the DualShock 4's product name.
  if (info.vendor === VENDOR.sony || /dualshock|dualsense|playstation|sony/.test(n) || n === 'wireless controller') return 'playstation';
  if (info.vendor === VENDOR.microsoft || /xbox|x-box|xinput|microsoft/.test(n)) return 'xbox';
  if (info.vendor === VENDOR.nintendo || /pro controller|joy-?con|nintendo|switch/.test(n)) return 'nintendo';
  // 8BitDo pads in D-input mode use Nintendo-style labels (B bottom, A right).
  if (info.vendor === VENDOR.eightBitDo || /8bitdo/.test(n)) return 'nintendo';
  return 'generic';
}

// ---------------------------------------------------------------------------
// Remapping (non-standard mappings)

/** Where one standard input comes from on a raw (unmapped) pad. */
export type RawSource =
  | { b: number }
  /** An axis past ±0.5 in `dir` (d-pad as two axes, triggers as axes). `rest` = idle value. */
  | { a: number; dir: 1 | -1; rest?: number }
  /** One direction of an 8-way hat switch reported as a single axis. */
  | { hat: number; dir: 'up' | 'down' | 'left' | 'right' };

export interface PadMapping {
  name: string;
  /** Sources of the 17 standard buttons (null = none). */
  buttons: (RawSource | null)[];
  /** Sources of LX, LY, RX, RY. */
  axes: ({ a: number; invert?: boolean } | null)[];
  /** Where the table comes from (docs / tests). */
  source?: string;
}

const B = (b: number): RawSource => ({ b });
const HAT = (hat: number) => (['up', 'down', 'left', 'right'] as const).map((dir) => ({ hat, dir }) as RawSource);
const TRIG = (a: number): RawSource => ({ a, dir: 1, rest: -1 });

/** DualShock 4 / DualSense raw HID (button order Square, Cross, Circle, Triangle, ...). */
const SONY_RAW: PadMapping = {
  name: 'Sony raw HID',
  // standard: 0 Cross, 1 Circle, 2 Square, 3 Triangle, 4 L1, 5 R1, 6 L2, 7 R2, 8 Share, 9 Options, 10 L3, 11 R3, d-pad (hat), 16 PS
  buttons: [B(1), B(2), B(0), B(3), B(4), B(5), TRIG(3), TRIG(4), B(8), B(9), B(10), B(11), ...HAT(9), B(12)],
  axes: [{ a: 0 }, { a: 1 }, { a: 2 }, { a: 5 }],
  source: 'SDL GameControllerDB (Mac OS X "PS4 Controller" / "PS5 Controller"); hat axis index as Chromium reports it',
};

/** Switch Pro Controller in its simple-HID Bluetooth mode (before the full-report handshake). */
const SWITCH_PRO_RAW: PadMapping = {
  name: 'Switch Pro raw HID',
  // raw: 0 B, 1 A, 2 Y, 3 X, 4 L, 5 R, 6 ZL, 7 ZR, 8 Minus, 9 Plus, 10 LS, 11 RS, 12 Home, 13 Capture
  buttons: [B(0), B(1), B(2), B(3), B(4), B(5), B(6), B(7), B(8), B(9), B(10), B(11), ...HAT(9), B(12)],
  axes: [{ a: 0 }, { a: 1 }, { a: 2 }, { a: 3 }],
  source: 'SDL GameControllerDB / Switch Pro simple HID report (positional: bottom B, right A)',
};

/** Xbox Wireless controllers on the Bluetooth LE HID descriptor (One S fw 4.8+, Series, Elite 2). */
const XBOX_BLE_RAW: PadMapping = {
  name: 'Xbox Bluetooth raw HID',
  // raw buttons: 0 A, 1 B, 3 X, 4 Y, 6 LB, 7 RB, 10 View, 11 Menu, 12 Guide, 13 LS, 14 RS (2, 5, 8, 9 unused)
  buttons: [B(0), B(1), B(3), B(4), B(6), B(7), TRIG(5), TRIG(4), B(10), B(11), B(13), B(14), ...HAT(9), B(12)],
  axes: [{ a: 0 }, { a: 1 }, { a: 2 }, { a: 3 }],
  source: 'SDL GameControllerDB (Mac OS X "Xbox Wireless Controller" BLE entries)',
};

/** Xbox One S on the older Bluetooth Classic firmware (product 0x02e0). */
const XBOX_02E0_RAW: PadMapping = {
  name: 'Xbox One S (BT classic) raw HID',
  buttons: [B(0), B(1), B(2), B(3), B(4), B(5), TRIG(2), TRIG(5), B(6), B(7), B(8), B(9), ...HAT(9), B(10)],
  axes: [{ a: 0 }, { a: 1 }, { a: 3 }, { a: 4 }],
  source: 'SDL GameControllerDB (Xbox One S 045e:02e0 generic HID layout)',
};

/** 8BitDo pads in D-input mode (Nintendo labels: raw 0 B, 1 A, 3 X, 4 Y). */
const EIGHTBITDO_RAW: PadMapping = {
  name: '8BitDo D-input raw HID',
  buttons: [B(0), B(1), B(4), B(3), B(6), B(7), B(8), B(9), B(10), B(11), B(13), B(14), ...HAT(9), B(12)],
  axes: [{ a: 0 }, { a: 1 }, { a: 2 }, { a: 5 }],
  source: 'SDL GameControllerDB (8BitDo D-input entries; positional, unverified on hardware)',
};

/** Remap tables for pads the browser leaves unmapped, by vendor / product. */
export const REMAPS: { vendor: number; products: number[] | '*'; mapping: PadMapping }[] = [
  { vendor: VENDOR.sony, products: [0x05c4, 0x09cc, 0x0ba0, 0x0ce6, 0x0df2], mapping: SONY_RAW },
  { vendor: VENDOR.nintendo, products: [0x2009], mapping: SWITCH_PRO_RAW },
  { vendor: VENDOR.microsoft, products: [0x02e0], mapping: XBOX_02E0_RAW },
  { vendor: VENDOR.microsoft, products: [0x02fd, 0x0b05, 0x0b13, 0x0b20, 0x0b22], mapping: XBOX_BLE_RAW },
  { vendor: VENDOR.eightBitDo, products: '*', mapping: EIGHTBITDO_RAW },
];

/** Generic guess for an unknown unmapped pad: buttons as they come, first four axes as sticks. */
export const GENERIC_MAPPING: PadMapping = {
  name: 'generic',
  buttons: Array.from({ length: 17 }, (_, i) => B(i)),
  axes: [{ a: 0 }, { a: 1 }, { a: 2 }, { a: 3 }],
};

export function findRemap(info: PadIdInfo): PadMapping | undefined {
  if (info.vendor === undefined) return undefined;
  return REMAPS.find((r) => r.vendor === info.vendor && (r.products === '*' || (info.product !== undefined && r.products.includes(info.product))))?.mapping;
}

/**
 * Decodes an 8-way hat switch reported as one axis (Chromium / Firefox on macOS): up = -1,
 * then clockwise in steps of 2/7 to up-left = +1; anything outside [-1.1, 1.1] is centred.
 */
export function decodeHat(v: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  const out = { up: false, down: false, left: false, right: false };
  if (!Number.isFinite(v) || Math.abs(v) > 1.1) return out;
  const i = Math.round(((v + 1) * 7) / 2);
  if (i < 0 || i > 7) return out;
  out.up = i === 0 || i === 1 || i === 7;
  out.right = i >= 1 && i <= 3;
  out.down = i >= 3 && i <= 5;
  out.left = i >= 5 && i <= 7;
  return out;
}

/** Minimal shape of a browser Gamepad (also what tests and the e2e fake provide). */
export interface RawPad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  buttons: readonly { value: number; pressed: boolean }[];
  axes: readonly number[];
  timestamp?: number;
  vibrationActuator?: unknown;
  hapticActuators?: readonly unknown[];
}

/** Value (0..1) of one raw source. */
export function sourceValue(raw: Pick<RawPad, 'buttons' | 'axes'>, s: RawSource | null | undefined): number {
  if (!s) return 0;
  if ('b' in s) {
    const b = raw.buttons[s.b];
    return b ? Math.max(b.value || 0, b.pressed ? 1 : 0) : 0;
  }
  if ('hat' in s) return decodeHat(raw.axes[s.hat] ?? 9)[s.dir] ? 1 : 0;
  const v = raw.axes[s.a] ?? 0;
  const rest = s.rest ?? 0;
  // Axis travel from rest towards dir, scaled so that full travel = 1.
  const span = s.dir > 0 ? 1 - rest : rest + 1;
  return clamp01(((v - rest) * s.dir) / (span || 1));
}

/** Standard-layout buttons (17 analog values) and stick axes (4) of a raw pad. */
export function normalizePad(raw: Pick<RawPad, 'buttons' | 'axes'>, map: PadMapping | null): { buttons: number[]; axes: [number, number, number, number] } {
  const buttons: number[] = [];
  if (!map) {
    for (let i = 0; i < 17; i++) {
      const b = raw.buttons[i];
      buttons.push(b ? Math.max(b.value || 0, b.pressed ? 1 : 0) : 0);
    }
    const a = raw.axes;
    return { buttons, axes: [num(a[0]), num(a[1]), num(a[2]), num(a[3])] };
  }
  for (let i = 0; i < 17; i++) buttons.push(sourceValue(raw, map.buttons[i]));
  const ax = (k: number) => {
    const s = map.axes[k];
    if (!s) return 0;
    const v = num(raw.axes[s.a]);
    return s.invert ? -v : v;
  };
  return { buttons, axes: [ax(0), ax(1), ax(2), ax(3)] };
}

// ---------------------------------------------------------------------------
// Stick math

/**
 * Radial dead zone: inputs inside `inner` are zero, the rest is rescaled so that the edge of the
 * dead zone is 0 and `outer` (worn sticks rarely reach 1) is full deflection. Direction is kept.
 */
export function radialDeadzone(x: number, y: number, inner: number, outer = 0.95): [number, number] {
  const m = Math.hypot(x, y);
  if (!(m > inner) || !Number.isFinite(m)) return [0, 0];
  const t = clamp01((m - inner) / Math.max(1e-3, outer - inner));
  return [(x / m) * t, (y / m) * t];
}

/** Response curves of the Controller page: 0 linear, 1 smooth (default), 2 precise. */
export const CURVE_EXPONENTS = [1, 1.8, 2.6] as const;

export function responseCurve(m: number, curve: number): number {
  const e = CURVE_EXPONENTS[Math.max(0, Math.min(CURVE_EXPONENTS.length - 1, Math.round(curve)))] ?? 1;
  return Math.pow(clamp01(m), e);
}

/** Dead zone + response curve on a stick, keeping its direction. */
export function shapeStick(x: number, y: number, deadZone: number, curve: number): [number, number] {
  const [dx, dy] = radialDeadzone(x, y, deadZone);
  const m = Math.hypot(dx, dy);
  if (!m) return [0, 0];
  const k = responseCurve(m, curve) / m;
  return [dx * k, dy * k];
}

/** Stick magnitude at and above which movement runs instead of walking. */
export const RUN_THRESHOLD = 0.88;

/**
 * Movement from the left stick: walk speed scales with the stick, full deflection runs.
 * Returns the wish vector (magnitude <= 1) and whether to run.
 */
export function stickMove(x: number, y: number, deadZone: number): { forward: number; strafe: number; run: boolean; magnitude: number } {
  const [dx, dy] = radialDeadzone(x, y, deadZone);
  const m = Math.hypot(dx, dy);
  if (!m) return { forward: 0, strafe: 0, run: false, magnitude: 0 };
  const run = m >= RUN_THRESHOLD;
  const scale = run ? 1 / m : 1 / RUN_THRESHOLD;
  return { forward: -dy * scale, strafe: dx * scale, run, magnitude: m };
}

// ---------------------------------------------------------------------------
// Button names (engine wording; no vendor artwork)

const NAMES: Record<PadFamily, string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L Stick', 'R Stick', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'Guide'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'PS'],
  // Positional: the bottom button of a Nintendo layout is labelled B, the right one A.
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', 'Minus', 'Plus', 'L Stick', 'R Stick', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'Home'],
  generic: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L Stick', 'R Stick', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'Home'],
};

/** Display name of standard button `i` for a family ("Cross", "RT", "ZR"...). */
export function padButtonName(i: number, family: PadFamily = 'generic'): string {
  return NAMES[family][i] ?? `Button ${i + 1}`;
}

export const FAMILY_NAMES: Record<PadFamily, string> = { xbox: 'Xbox', playstation: 'PlayStation', nintendo: 'Nintendo', generic: 'Generic' };

// ---------------------------------------------------------------------------
// Rumble curves (.wdu type 0x60, header kind 0)

export interface RumbleCurve {
  /** Frames per second (10..30 in the retail data). */
  rate: number;
  /** Motor count (2: [0] large / low-frequency, [1] small / high-frequency [inferred]). */
  motors: number;
  /** Per frame, per motor intensity 0..1. */
  frames: [number, number][];
  duration: number;
}

export const WDU_CURVE_TYPE = 0x60;

/**
 * Decodes a rumble curve entry: u32 kind (0 = rumble), u16 motors, u16 bits, u32 rate (Hz),
 * u32 0, u32 n, then n bytes of interleaved motor levels. Levels are signed 8-bit (0..127 =
 * off..full; the odd negative byte reads as off) [inferred from the data: every curve stays in
 * 0..127 apart from one trailing 255]. Two entries claim 16 bits but their byte counts only fit
 * 8-bit motor pairs, so the bit depth is ignored. Other kinds (1/2/3/4: animation curves and
 * tables in the same file type) return null.
 */
export function parseRumbleCurve(v: DataView): RumbleCurve | null {
  if (v.byteLength < 20) return null;
  const kind = v.getUint32(0, true);
  const motors = v.getUint16(4, true);
  const rate = v.getUint32(8, true);
  const n = v.getUint32(16, true);
  if (kind !== 0 || motors < 1 || motors > 2 || rate < 1 || rate > 1000) return null;
  const count = Math.min(n, v.byteLength - 20);
  const frames: [number, number][] = [];
  const level = (b: number) => (b > 127 ? 0 : b / 127);
  for (let p = 0; p + motors <= count; p += motors) {
    const a = level(v.getUint8(20 + p));
    const b = motors > 1 ? level(v.getUint8(21 + p)) : a;
    frames.push([a, b]);
  }
  if (!frames.length) return null;
  return { rate, motors, frames, duration: frames.length / rate };
}

/** Motor levels of a curve `t` seconds after it started ([0, 0] outside it). */
export function rumbleAt(c: RumbleCurve, t: number): [number, number] {
  if (!(t >= 0)) return [0, 0];
  const i = Math.floor(t * c.rate);
  return c.frames[i] ?? [0, 0];
}

export interface ActiveRumble {
  curve: RumbleCurve;
  start: number;
  gain: number;
}

/** Mix of overlapping curves at time `now` (seconds): per-motor maximum, scaled by gain. */
export function mixRumble(list: readonly ActiveRumble[], now: number): [number, number] {
  let s = 0, w = 0;
  for (const r of list) {
    const [a, b] = rumbleAt(r.curve, now - r.start);
    s = Math.max(s, a * r.gain);
    w = Math.max(w, b * r.gain);
  }
  return [clamp01(s), clamp01(w)];
}

export interface DualRumbleEffect {
  startDelay: number;
  duration: number;
  strongMagnitude: number;
  weakMagnitude: number;
}

/**
 * A curve as a list of 'dual-rumble' effects (runs of equal frames merged), each starting at
 * `startDelay` ms. The live mixer streams the same values frame by frame; this form is what a
 * single curve turns into and what the tests check.
 */
export function curveToEffects(c: RumbleCurve, gain = 1): DualRumbleEffect[] {
  const out: DualRumbleEffect[] = [];
  const ms = 1000 / c.rate;
  c.frames.forEach(([a, b], i) => {
    const strongMagnitude = round3(clamp01(a * gain));
    const weakMagnitude = round3(clamp01(b * gain));
    const last = out[out.length - 1];
    if (last && last.strongMagnitude === strongMagnitude && last.weakMagnitude === weakMagnitude) last.duration += ms;
    else out.push({ startDelay: i * ms, duration: ms, strongMagnitude, weakMagnitude });
  });
  for (const e of out) {
    e.startDelay = Math.round(e.startDelay);
    e.duration = Math.round(e.duration);
  }
  return out.filter((e) => e.strongMagnitude > 0 || e.weakMagnitude > 0);
}

/** Reads every rumble curve of a .wdu file. */
export function readRumbleCurves(file: SrscFile): Map<number, RumbleCurve> {
  const out = new Map<number, RumbleCurve>();
  for (const e of file.entries) {
    if (e.type !== WDU_CURVE_TYPE) continue;
    const c = parseRumbleCurve(file.data(e));
    if (c) out.set(e.id, c);
  }
  return out;
}

/** Distance gain for a positional rumble: full within `near`, fading to 0 at `far`. */
export function rumbleDistanceGain(d: number, near: number, far: number): number {
  if (!(far > near)) return d <= near ? 1 : 0;
  return clamp01(1 - (d - near) / (far - near));
}

// ---------------------------------------------------------------------------
// Options (Controller page; applied from the settings by src/app/menu/settings.ts)

export interface PadOptions {
  /** Look speed multiplier (0.25..3). */
  sensitivity: number;
  /** Radial dead zone of both sticks (0..0.5). */
  deadZone: number;
  /** Look response curve: 0 linear, 1 smooth, 2 precise. */
  curve: number;
  /** Trigger press threshold (0..1). */
  triggerThreshold: number;
  vibration: boolean;
  /** Aim assist ("Auto Targeting"): slowdown + magnetism + shots toward the locked target. */
  aimAssist: boolean;
  /** "Auto Pitch Correction": pitch eases toward the target / level while walking. */
  autoPitch: boolean;
}

// Curve Linear: the original's analog bindings rescale past their dead zone linearly (exponent 1
// in every retail record, input vtable +0x98 = EXE 0x40d1a0). Auto Targeting and Auto Pitch
// Correction are off as in the original's defaults (settings flags 0x40 / 0x80, 0x10007400).
export const PAD_DEFAULTS: PadOptions = {
  sensitivity: 1,
  deadZone: 0.15,
  curve: 0,
  triggerThreshold: 0.3,
  vibration: true,
  aimAssist: false,
  autoPitch: false,
};

// ---------------------------------------------------------------------------
// Runtime

export interface PadSnapshot {
  index: number;
  id: string;
  name: string;
  family: PadFamily;
  /** 'standard' (browser), 'remap' (table), 'calibrated' (Controller page) or 'generic'. */
  source: 'standard' | 'remap' | 'calibrated' | 'generic';
  /** 17 standard buttons, analog 0..1. */
  buttons: number[];
  /** 17 standard buttons as pressed (triggers by threshold with hysteresis). */
  pressed: boolean[];
  /** LX, LY, RX, RY (-1..1, +Y down), raw (no dead zone). */
  axes: [number, number, number, number];
}

type DeviceKind = 'pad' | 'keyboard';

export interface PadEventInfo {
  index: number;
  id: string;
  name: string;
  /** Disconnect: the pad was the active one. */
  wasActive?: boolean;
}
type PadEvent = 'device' | 'connect' | 'disconnect';

interface Slot {
  index: number;
  id: string;
  info: PadIdInfo;
  family: PadFamily;
  lastActive: number;
  pressed: boolean[];
  /** Raw axes at first sight (rest values, for activity detection). */
  rest: number[];
  connected: boolean;
}

const CALIBRATION_KEY = 'suffering.padmaps.v1';

class GamepadManager {
  readonly options: PadOptions = { ...PAD_DEFAULTS };
  /** Last input device; drives labels / glyphs and the cursor. */
  lastDevice: DeviceKind = 'keyboard';
  /** Per-device calibrations (gamepad.id -> mapping), from the Controller page. */
  calibrations: Record<string, PadMapping> = loadCalibrations();
  private readonly slots = new Map<number, Slot>();
  private active: Slot | null = null;
  /** Family of the last pad used (kept after it disconnects, for labels). */
  private lastFamily: PadFamily = 'xbox';
  private lastPoll = -Infinity;
  private snap: PadSnapshot | null = null;
  private installed = false;
  private readonly handlers = new Map<PadEvent, Set<(slot: PadEventInfo) => void>>();
  // Rumble.
  private readonly rumbles: ActiveRumble[] = [];
  private rumbleSent: [number, number] = [0, 0];
  private rumbleSentAt = 0;
  /** True while rumble may play (in game, not paused); set by the app each frame. */
  rumbleAllowed = false;

  /** Installs the device listeners (once). */
  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    window.addEventListener('gamepadconnected', () => this.poll(true));
    window.addEventListener('gamepaddisconnected', () => this.poll(true));
    const kb = (e: Event) => {
      if (!e.isTrusted) return; // synthetic events from the bindings layer
      this.setDevice('keyboard');
    };
    window.addEventListener('keydown', kb, true);
    window.addEventListener('mousedown', kb, true);
    window.addEventListener('wheel', kb, { capture: true, passive: true });
    window.addEventListener(
      'mousemove',
      (e) => {
        if (e.isTrusted && Math.abs(e.movementX) + Math.abs(e.movementY) > 6) this.setDevice('keyboard');
      },
      true,
    );
  }

  /** The active pad, normalised (polls at most every ~4 ms unless forced). */
  poll(force = false): PadSnapshot | null {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - this.lastPoll < 4) return this.snap;
    this.lastPoll = now;
    const list = readPads();
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.index);
      let s = this.slots.get(p.index);
      if (!s || s.id !== p.id) {
        const info = parsePadId(p.id);
        s = { index: p.index, id: p.id, info, family: padFamily(info), lastActive: 0, pressed: [], rest: [...p.axes], connected: true };
        this.slots.set(p.index, s);
        this.emit('connect', s);
      }
      const norm = this.normalize(p);
      // Activity: a new press, or a stick pushed past half way.
      const pressed = this.pressedOf(norm.buttons, s.pressed);
      const newPress = pressed.some((b, i) => b && !s!.pressed[i]);
      const moved = Math.hypot(norm.axes[0], norm.axes[1]) > 0.5 || Math.hypot(norm.axes[2], norm.axes[3]) > 0.5;
      s.pressed = pressed;
      if (newPress || moved) {
        s.lastActive = now;
        if (this.active !== s) this.active = s;
        this.lastFamily = s.family;
        this.setDevice('pad');
      }
    }
    for (const [i, s] of [...this.slots]) {
      if (seen.has(i)) continue;
      this.slots.delete(i);
      const wasActive = this.active === s;
      if (wasActive) this.active = null;
      this.emit('disconnect', s, wasActive);
    }
    // No pad chosen yet: the first connected one (labels / glyphs before the first press).
    if (!this.active && this.slots.size) this.active = [...this.slots.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
    const a = this.active;
    const raw = a ? list.find((p) => p.index === a.index) : undefined;
    if (!a || !raw) {
      this.snap = null;
      return null;
    }
    const norm = this.normalize(raw);
    this.snap = { index: a.index, id: a.id, name: a.info.name, family: a.family, source: this.sourceOf(raw), buttons: norm.buttons, pressed: a.pressed, axes: norm.axes };
    return this.snap;
  }

  /** The active raw pad (calibration reads raw indices). */
  raw(): RawPad | null {
    const a = this.active;
    return a ? (readPads().find((p) => p.index === a.index) ?? null) : null;
  }

  /** Every connected raw pad (calibration listens to whichever is pressed). */
  rawAll(): RawPad[] {
    return readPads();
  }

  get connected(): boolean {
    this.poll();
    return this.slots.size > 0;
  }

  /** Name of the active pad, if any. */
  get name(): string | undefined {
    this.poll();
    return this.active?.info.name;
  }

  get family(): PadFamily {
    this.poll();
    return this.active?.family ?? this.lastFamily;
  }

  /** True when the player is using a pad (labels, cursor, aim assist, rumble). */
  get usingPad(): boolean {
    return this.lastDevice === 'pad';
  }

  on(ev: PadEvent, fn: (slot: PadEventInfo) => void): () => void {
    let set = this.handlers.get(ev);
    if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(ev: PadEvent, s: Slot, wasActive?: boolean): void {
    for (const fn of this.handlers.get(ev) ?? []) fn({ index: s.index, id: s.id, name: s.info.name, wasActive });
  }

  setDevice(d: DeviceKind): void {
    if (d === this.lastDevice) return;
    this.lastDevice = d;
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('pad-active', d === 'pad');
    if (d !== 'pad') this.stopRumble();
    for (const fn of this.handlers.get('device') ?? []) fn({ index: this.active?.index ?? -1, id: this.active?.id ?? '', name: this.active?.info.name ?? '' });
  }

  /** A calibration wins (also over a browser mapping that turned out wrong), then the browser's. */
  private mappingOf(p: RawPad): PadMapping | null {
    const cal = this.calibrations[p.id];
    if (cal) return cal;
    if (p.mapping === 'standard') return null;
    return findRemap(parsePadId(p.id)) ?? GENERIC_MAPPING;
  }

  private sourceOf(p: RawPad): PadSnapshot['source'] {
    if (this.calibrations[p.id]) return 'calibrated';
    if (p.mapping === 'standard') return 'standard';
    return findRemap(parsePadId(p.id)) ? 'remap' : 'generic';
  }

  private normalize(p: RawPad) {
    return normalizePad(p, this.mappingOf(p));
  }

  /** Buttons as pressed: digital buttons at 0.5, triggers at the threshold with hysteresis. */
  private pressedOf(values: number[], prev: boolean[]): boolean[] {
    const t = this.options.triggerThreshold;
    return values.map((v, i) => {
      if (i === 6 || i === 7) return prev[i] ? v > t * 0.7 : v >= t;
      return v >= 0.5;
    });
  }

  // --- calibration -----------------------------------------------------------

  setCalibration(id: string, m: PadMapping | null): void {
    if (m) this.calibrations[id] = m;
    else delete this.calibrations[id];
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(this.calibrations));
    } catch {
      /* storage unavailable */
    }
    this.poll(true);
  }

  // --- rumble -----------------------------------------------------------------

  /** Starts a rumble curve (mixed with the others; per-motor maximum). */
  playCurve(curve: RumbleCurve, gain = 1): void {
    if (!this.options.vibration || !this.usingPad || gain <= 0.01) return;
    const now = performance.now() / 1000;
    this.rumbles.push({ curve, start: now, gain });
    if (this.rumbles.length > 16) this.rumbles.shift();
  }

  /** One-off effect (engine use: tests, calibration feedback). */
  pulse(strong: number, weak: number, ms: number): void {
    if (!this.options.vibration) return;
    void sendRumble(this.raw(), { startDelay: 0, duration: ms, strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak) });
  }

  /** Streams the curve mix to the active pad's actuator (call every frame). */
  updateRumble(): void {
    const nowMs = performance.now();
    const now = nowMs / 1000;
    for (let i = this.rumbles.length - 1; i >= 0; i--) if (now - this.rumbles[i].start > this.rumbles[i].curve.duration) this.rumbles.splice(i, 1);
    if (!this.rumbleAllowed || !this.options.vibration || !this.usingPad) {
      this.rumbles.length = 0;
      this.stopRumble();
      return;
    }
    const [s, w] = mixRumble(this.rumbles, now);
    const [ps, pw] = this.rumbleSent;
    const changed = Math.abs(s - ps) > 0.03 || Math.abs(w - pw) > 0.03;
    const live = s > 0 || w > 0;
    // Effects are sent ~120 ms long and refreshed every 80 ms while the mix holds still.
    if (!changed && !(live && nowMs - this.rumbleSentAt > 80)) return;
    if (!live && !(ps > 0 || pw > 0)) return;
    this.rumbleSent = [s, w];
    this.rumbleSentAt = nowMs;
    void sendRumble(this.raw(), { startDelay: 0, duration: live ? 120 : 0, strongMagnitude: s, weakMagnitude: w });
  }

  stopRumble(): void {
    if (this.rumbleSent[0] > 0 || this.rumbleSent[1] > 0) {
      this.rumbleSent = [0, 0];
      const p = this.raw();
      const act = p?.vibrationActuator as { reset?(): Promise<unknown> } | undefined;
      try {
        void act?.reset?.()?.catch?.(() => undefined);
      } catch {
        /* unsupported */
      }
    }
  }

  /** Debug / tests: currently mixed motor levels. */
  get rumbleLevel(): [number, number] {
    return [...this.rumbleSent] as [number, number];
  }
}

function readPads(): RawPad[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  let list: (Gamepad | null)[];
  try {
    list = [...navigator.getGamepads()];
  } catch {
    return []; // blocked by a permissions policy
  }
  return list.filter((p): p is Gamepad => !!p && p.connected !== false) as unknown as RawPad[];
}

/** Plays one dual-rumble effect on a pad; resolves silently where unsupported. */
export async function sendRumble(p: RawPad | null, e: DualRumbleEffect): Promise<void> {
  if (!p) return;
  try {
    const act = p.vibrationActuator as { playEffect?(type: string, params: DualRumbleEffect): Promise<unknown>; effects?: string[] } | undefined;
    if (act?.playEffect && (!act.effects || act.effects.includes('dual-rumble'))) {
      if (e.duration <= 0) await (act as { reset?(): Promise<unknown> }).reset?.();
      else await act.playEffect('dual-rumble', e);
      return;
    }
    const h = p.hapticActuators?.[0] as { pulse?(value: number, ms: number): Promise<unknown> } | undefined;
    if (h?.pulse) await h.pulse(Math.max(e.strongMagnitude, e.weakMagnitude), Math.max(0, e.duration));
  } catch {
    /* unsupported / refused (no user activation, pad gone): rumble is optional */
  }
}

function loadCalibrations(): Record<string, PadMapping> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CALIBRATION_KEY) : null;
    if (!raw) return {};
    const d = JSON.parse(raw) as Record<string, PadMapping>;
    const out: Record<string, PadMapping> = {};
    for (const [k, v] of Object.entries(d)) if (v && Array.isArray(v.buttons) && Array.isArray(v.axes)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** The engine-wide gamepad manager. */
export const pads = new GamepadManager();

// ---------------------------------------------------------------------------
// Rumble from sounds

export interface RumbleAudioHost {
  /** Rumble while this is true (in game, not paused). */
  active(): boolean;
  /** Reads a game file (the .wdu next to a mounted .sdu). */
  read(path: string): Promise<ArrayBuffer>;
}

/**
 * Plays the rumble curve a sound header references (+0x28) whenever such a sound starts.
 * Positional sounds fade with the distance to the listener (full within the sound's min
 * distance, nothing past its max distance).
 */
export function attachAudioRumble(audio: AudioSystem, host: RumbleAudioHost): () => void {
  const files = new Map<number, Promise<Map<number, RumbleCurve>>>();
  const curves = (pkg: number) => {
    let p = files.get(pkg);
    if (!p) {
      const sdu = audio.packagePath(pkg);
      p = sdu
        ? host
            .read(sdu.replace(/\.sdu$/i, '.wdu'))
            .then((buf) => readRumbleCurves(new SrscFile(buf)))
            .catch(() => new Map<number, RumbleCurve>())
        : Promise.resolve(new Map<number, RumbleCurve>());
      files.set(pkg, p);
    }
    return p;
  };
  const onPlay = (info: SoundInfo, opts: PlayOptions) => {
    const r = info.rumble;
    if (!r || !pads.options.vibration || !pads.usingPad || !host.active()) return;
    let gain = 1;
    if (opts.position) {
      const l = audio.listenerPosition;
      const d = Math.hypot(opts.position[0] - l[0], opts.position[1] - l[1], opts.position[2] - l[2]);
      const far = opts.maxDistance ?? (info.maxDistance > 0 ? info.maxDistance : 40);
      const near = Math.max(1, Math.min(far * 0.5, opts.minDistance ?? (info.minDistance || 2)));
      gain = rumbleDistanceGain(d, near, far * 0.6);
    }
    gain *= Math.min(1, opts.volume ?? 1);
    if (gain <= 0.05) return;
    void curves(r.pkg).then((m) => {
      const c = m.get(r.id);
      if (c) pads.playCurve(c, gain);
    });
  };
  audio.onPlay = onPlay;
  return () => {
    if (audio.onPlay === onPlay) audio.onPlay = undefined;
  };
}

// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

