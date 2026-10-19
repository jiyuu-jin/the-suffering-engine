// Controller page (engine page, Options -> Controller) and its calibration screen.
//
// The page is a normal options page (Accept keeps, Cancel restores) whose rows edit settings
// (`x.pad*` in Settings.extra, applied to src/app/gamepad.ts `pads.options` and the bindings by
// ../settings.ts). Rows with a console counterpart use the game's own strings from the console
// GUI Controller Settings (#855) and Gameplay (#761) templates: Invert Pitch Axis 5:375, Controller
// Vibration 5:370, Auto Targeting 5:355, Auto Pitch Correction 5:362 and Controller Setting 5:405
// with its layouts 5:400..5:404 and Custom 5:406. The others are engine wording. The page's
// placement follows #855 (rows at x 10 %, values at x 50..57.5 %, font 3 x0.85, 5-6.5 % rows);
// gui-adapter.ts places the rows, ./controller.ts (this file) defines them.
//
// Calibration ("press each button"): for pads the browser does not map and the remap tables of
// gamepad.ts do not know. It walks through the 17 standard buttons and the two sticks, records
// which raw button / axis / hat direction moved, and stores the result per `gamepad.id`
// (localStorage 'suffering.padmaps.v1'). Keyboard: Space skips a step, Esc cancels, Delete
// drops the saved calibration of the pad.

import { FAMILY_NAMES, PAD_DEFAULTS, decodeHat, padButtonName, pads, type PadMapping, type RawPad, type RawSource } from '../../gamepad';
import { drawPadGlyph } from '../../glyphs';
import type { CustomScreen, CustomUi, Label, MenuItem, NavInput, Placed } from '../model';

export const CONTROLLER_SCREEN = 'page.controller';
export const CALIBRATE_SCREEN = 'padCalibrate';

const s = (id: number, fallback: string): Label => ({ str: { pkg: 5, id }, fallback });
const t = (text: string): Label => ({ text });

export type ControllerRow =
  | { kind: 'slider'; label: Label; setting: string; min: number; max: number; step: number }
  | { kind: 'choice'; label: Label; setting: string; choices: { label: Label; value: number | boolean }[] }
  | { kind: 'button'; label: Label; screen: string };

/** The Controller page rows, top to bottom. */
export const CONTROLLER_ROWS: ControllerRow[] = [
  { kind: 'slider', label: t('Look Sensitivity'), setting: 'x.padSensitivity', min: 0.25, max: 3, step: 0.25 },
  { kind: 'slider', label: t('Stick Dead Zone'), setting: 'x.padDeadZone', min: 0.05, max: 0.4, step: 0.05 },
  {
    kind: 'choice',
    label: t('Look Response'),
    setting: 'x.padCurve',
    choices: [
      { label: t('Linear'), value: 0 },
      { label: t('Smooth'), value: 1 },
      { label: t('Precise'), value: 2 },
    ],
  },
  { kind: 'slider', label: t('Trigger Threshold'), setting: 'x.padTrigger', min: 0.1, max: 0.9, step: 0.1 },
  {
    kind: 'choice',
    label: s(375, 'Invert Pitch Axis'),
    setting: 'invertY',
    choices: [
      { label: s(374, 'Yes'), value: true },
      { label: s(376, 'No'), value: false },
    ],
  },
  {
    kind: 'choice',
    label: s(370, 'Controller Vibration'),
    setting: 'x.padVibration',
    choices: [
      { label: s(371, 'On'), value: true },
      { label: s(369, 'Off'), value: false },
    ],
  },
  {
    kind: 'choice',
    label: s(355, 'Auto Targeting'),
    setting: 'x.padAimAssist',
    choices: [
      { label: s(354, 'On'), value: true },
      { label: s(356, 'Off'), value: false },
    ],
  },
  {
    kind: 'choice',
    label: s(362, 'Auto Pitch Correction'),
    setting: 'x.padAutoPitch',
    choices: [
      { label: s(363, 'On'), value: true },
      { label: s(361, 'Off'), value: false },
    ],
  },
  {
    kind: 'choice',
    label: s(405, 'Controller Setting'),
    setting: 'x.padLayout',
    choices: [
      { label: s(400, 'Double Stick (Default)'), value: 0 },
      { label: s(401, 'Throw/Jump Swap'), value: 1 },
      { label: s(402, 'Single Stick'), value: 2 },
      { label: s(403, 'Double Stick+Flashlight'), value: 3 },
      { label: s(404, 'Jump On Top'), value: 4 },
      { label: s(406, 'Custom'), value: 5 },
    ],
  },
  { kind: 'button', label: t('Calibrate Controller'), screen: CALIBRATE_SCREEN },
];

/** Settings defaults of the page (Settings.extra keys). */
export const PAD_SETTING_DEFAULTS: Record<string, number | boolean> = {
  padSensitivity: PAD_DEFAULTS.sensitivity,
  padDeadZone: PAD_DEFAULTS.deadZone,
  padCurve: PAD_DEFAULTS.curve,
  padTrigger: PAD_DEFAULTS.triggerThreshold,
  padVibration: PAD_DEFAULTS.vibration,
  padAimAssist: PAD_DEFAULTS.aimAssist,
  padAutoPitch: PAD_DEFAULTS.autoPitch,
  padLayout: 0,
};

/**
 * Menu items of the page. `place(i, row)` gives each row's label / value placement and meter
 * rect (data-driven layout); without it the automatic form layout is used.
 */
export function controllerItems(place?: (i: number, row: ControllerRow) => { label: Placed; value?: Placed; meter?: { rect: { x: number; y: number; w: number; h: number }; fill: string; frame?: { texture: number; uv: { x: number; y: number; w: number; h: number } } } }): MenuItem[] {
  return CONTROLLER_ROWS.map((row, i): MenuItem => {
    const p = place?.(i, row);
    if (row.kind === 'slider') return { type: 'slider', label: row.label, setting: row.setting, min: row.min, max: row.max, step: row.step, place: p?.label, meter: p?.meter };
    if (row.kind === 'choice') return { type: 'choice', label: row.label, setting: row.setting, place: p?.label, choices: row.choices.map((c) => ({ ...c, place: p?.value })) };
    return { type: 'button', label: row.label, action: { kind: 'push', screen: row.screen }, place: p?.label };
  });
}

/** Status line of the page: the connected pad and how it is mapped. */
export function decorateController(ui: CustomUi): void {
  const st = pads.poll();
  const text = st
    ? `${st.name} — ${FAMILY_NAMES[st.family]} buttons, ${st.source === 'standard' ? 'browser mapping' : st.source === 'remap' ? 'built-in remap' : st.source === 'calibrated' ? 'calibrated' : 'generic mapping (calibrate it)'}`
    : 'No controller connected: pair one over Bluetooth, then press any of its buttons';
  ui.text('ui', text, 320, 386, { align: 'center', color: '#9a968c', scale: 0.72, maxWidth: 560 });
}

// ---------------------------------------------------------------------------
// Calibration

type Step = { kind: 'button'; index: number; text: string } | { kind: 'axis'; axis: 0 | 1 | 2 | 3; text: string };

const STEPS: Step[] = [
  { kind: 'button', index: 0, text: 'bottom face button (A / Cross / B)' },
  { kind: 'button', index: 1, text: 'right face button (B / Circle / A)' },
  { kind: 'button', index: 2, text: 'left face button (X / Square / Y)' },
  { kind: 'button', index: 3, text: 'top face button (Y / Triangle / X)' },
  { kind: 'button', index: 4, text: 'left bumper' },
  { kind: 'button', index: 5, text: 'right bumper' },
  { kind: 'button', index: 6, text: 'left trigger' },
  { kind: 'button', index: 7, text: 'right trigger' },
  { kind: 'button', index: 8, text: 'Back / View / Share / Minus' },
  { kind: 'button', index: 9, text: 'Start / Menu / Options / Plus' },
  { kind: 'button', index: 10, text: 'left stick click' },
  { kind: 'button', index: 11, text: 'right stick click' },
  { kind: 'button', index: 12, text: 'd-pad up' },
  { kind: 'button', index: 13, text: 'd-pad down' },
  { kind: 'button', index: 14, text: 'd-pad left' },
  { kind: 'button', index: 15, text: 'd-pad right' },
  { kind: 'button', index: 16, text: 'Home / Guide (Space if there is none)' },
  { kind: 'axis', axis: 0, text: 'Push the LEFT stick to the RIGHT' },
  { kind: 'axis', axis: 1, text: 'Push the LEFT stick DOWN' },
  { kind: 'axis', axis: 2, text: 'Push the RIGHT stick to the RIGHT' },
  { kind: 'axis', axis: 3, text: 'Push the RIGHT stick DOWN' },
];

const HAT_DIRS: Record<number, 'up' | 'down' | 'left' | 'right'> = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

/**
 * Pure step detector (tests): the raw input that moved from `rest`, or null. Buttons count when
 * pressed; axes past 0.6 from their rest value. An axis resting outside [-1.1, 1.1] is a hat
 * switch (centred value) and reads as a direction.
 */
export function detectSource(raw: Pick<RawPad, 'buttons' | 'axes'>, rest: readonly number[], step: Step): RawSource | { a: number; invert: boolean } | null {
  if (step.kind === 'button') {
    const b = raw.buttons.findIndex((x) => x && (x.pressed || x.value > 0.6));
    if (b >= 0) return { b };
  }
  let best = -1;
  let bestD = 0.6;
  raw.axes.forEach((v, j) => {
    const d = Math.abs(v - (rest[j] ?? 0));
    if (d > bestD && Number.isFinite(v)) {
      best = j;
      bestD = d;
    }
  });
  if (best < 0) return null;
  const v = raw.axes[best];
  const r = rest[best] ?? 0;
  if (step.kind === 'axis') return { a: best, invert: v - r < 0 };
  if (Math.abs(r) > 1.1) {
    const h = decodeHat(v);
    const want = HAT_DIRS[step.index];
    const dir = want && h[want] ? want : h.up ? 'up' : h.down ? 'down' : h.left ? 'left' : h.right ? 'right' : null;
    return dir ? { hat: best, dir } : null;
  }
  return { a: best, dir: v - r > 0 ? 1 : -1, rest: Math.abs(r) > 0.5 ? r : 0 };
}

export class CalibrationScreen implements CustomScreen {
  private step = 0;
  private padId = '';
  private padIndex = -1;
  private rest: number[] = [];
  private waitRelease = true;
  private buttons: (RawSource | null)[] = [];
  private axes: ({ a: number; invert?: boolean } | null)[] = [null, null, null, null];
  private done: { at: number; text: string } | null = null;

  open(): void {
    this.step = 0;
    this.buttons = Array(17).fill(null);
    this.axes = [null, null, null, null];
    this.done = null;
    this.waitRelease = true;
    this.pick();
  }

  /** The pad to calibrate: the active one, else the first connected. */
  private pick(): RawPad | null {
    const p = pads.raw() ?? pads.rawAll()[0] ?? null;
    if (p && p.id !== this.padId) {
      this.padId = p.id;
      this.padIndex = p.index;
      this.rest = [...p.axes];
    }
    return p;
  }

  private current(): RawPad | null {
    return pads.rawAll().find((p) => p.index === this.padIndex && p.id === this.padId) ?? this.pick();
  }

  key(ui: CustomUi, e: KeyboardEvent): boolean {
    if (e.repeat) return true;
    if (e.code === 'Escape' || e.code === 'Backspace') {
      ui.close();
      return true;
    }
    if (e.code === 'Space' || e.code === 'Tab') {
      this.advance(ui);
      ui.sound('move');
      return true;
    }
    if (e.code === 'Delete' && this.padId) {
      pads.setCalibration(this.padId, null);
      this.done = { at: performance.now(), text: 'Calibration removed: the built-in mapping is used again' };
      ui.sound('value');
      return true;
    }
    return true;
  }

  /** Pad buttons are what is being recorded: navigation is ignored here. */
  nav(_ui: CustomUi, _a: NavInput): boolean {
    return true;
  }

  click(ui: CustomUi, index: number): void {
    if (index === 1) ui.close();
    else if (index === 2) this.advance(ui);
  }

  private advance(ui: CustomUi): void {
    this.step++;
    this.waitRelease = true;
    if (this.step < STEPS.length) return;
    const m: PadMapping = { name: 'calibrated', buttons: this.buttons, axes: this.axes, source: 'calibration (Controller page)' };
    if (this.padId) pads.setCalibration(this.padId, m);
    this.done = { at: performance.now(), text: 'Calibration saved' };
    ui.sound('select');
  }

  private poll(ui: CustomUi): void {
    if (this.done || this.step >= STEPS.length || ui.age < 0.4) return;
    const p = this.current();
    if (!p) return;
    const anyButton = p.buttons.some((b) => b && (b.pressed || b.value > 0.3));
    const anyAxis = p.axes.some((v, j) => Math.abs(v - (this.rest[j] ?? 0)) > 0.3);
    if (this.waitRelease) {
      if (!anyButton && !anyAxis) this.waitRelease = false;
      return;
    }
    const st = STEPS[this.step];
    const src = detectSource(p, this.rest, st);
    if (!src) return;
    if (st.kind === 'axis') {
      if (!('invert' in src)) return;
      this.axes[st.axis] = src;
    } else {
      if ('invert' in src) return;
      this.buttons[st.index] = src;
    }
    ui.sound('value');
    this.advance(ui);
  }

  draw(ui: CustomUi, time: number): void {
    this.poll(ui);
    const ctx = ui.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(40, 60, 560, 360);
    ctx.strokeStyle = 'rgba(150,140,120,0.6)';
    ctx.strokeRect(40.5, 60.5, 559, 359);
    ui.text('title', 'Calibrate Controller', 320, 74, { align: 'center', color: '#d9cfae', scale: 0.9 });
    const p = this.current();
    if (this.done) {
      ui.text('ui', this.done.text, 320, 220, { align: 'center', color: '#e6e2d8' });
      if (performance.now() - this.done.at > 1400) ui.close(true);
      return;
    }
    if (!p) {
      ui.text('ui', 'No controller found. Connect one and press any of its buttons.', 320, 220, { align: 'center', color: '#c4bfb2', maxWidth: 520 });
    } else {
      ui.text('ui', `${p.id}`, 320, 112, { align: 'center', color: '#9a968c', scale: 0.7, maxWidth: 540 });
      ui.text('ui', `Step ${this.step + 1} of ${STEPS.length}`, 320, 140, { align: 'center', color: '#9a968c', scale: 0.8 });
      const st = STEPS[this.step];
      const msg = st.kind === 'button' ? `Press the ${st.text}` : st.text;
      ui.text('ui', this.waitRelease ? 'Release all buttons and sticks' : msg, 320, 200, { align: 'center', color: '#e6e2d8', maxWidth: 520 });
      if (st.kind === 'button') {
        const blink = 0.6 + 0.4 * Math.sin(time * 6);
        drawPadGlyph(ctx, pads.family, st.index, 320 - 18, 262, 36, this.waitRelease ? 0.35 : blink);
        ui.text('ui', padButtonName(st.index, pads.family), 320, 288, { align: 'center', color: '#9a968c', scale: 0.7 });
      }
    }
    // Footer: keyboard keys and clickable Skip / Cancel.
    ui.text('ui', 'Space: skip    Esc: cancel    Delete: remove saved calibration', 320, 372, { align: 'center', color: '#77736b', scale: 0.7 });
    const skip = { x: 200, y: 392, w: 100, h: 20 };
    const cancel = { x: 340, y: 392, w: 100, h: 20 };
    ui.text('ui', 'Skip', skip.x + skip.w / 2, skip.y, { align: 'center', color: '#c4bfb2', scale: 0.8 });
    ui.text('ui', 'Cancel', cancel.x + cancel.w / 2, cancel.y, { align: 'center', color: '#c4bfb2', scale: 0.8 });
    ui.hit(2, skip);
    ui.hit(1, cancel);
  }
}
