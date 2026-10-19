// Keyboard page (Options -> Keyboard; Control Settings GUI #906, docs/frontend.md §7.2).
//
// The listbox (#904) lists the 40 actions of p30 (labels are those string refs) with two key
// columns (p29 = 2; name text #898 27.5 % wide, key texts #899 17.5 %) and, as an engine
// addition, a gamepad column in the listbox's spare width. Enter (or a click) on a cell waits
// for the next key / mouse button / wheel / gamepad button (prompt p27 in the #907 text);
// reserved keys show p28; Esc cancels the wait; Delete clears the cell. Accept saves, Cancel /
// Esc restores the bindings the page opened with, Default resets after the p24 confirmation.
// Bindings are src/game/hud/bindings.ts (`input`).
//
// Gamepad: the pad column shows the connected controller's button glyphs and names
// (src/app/glyphs.ts); A starts a capture on the focused cell (the next pad button binds it),
// Y clears the cell, B cancels the page. Engine-added actions (Crouch) follow the data's 40
// rows with engine labels. Editing a pad cell switches the Controller page layout to Custom.

import { ACTIONS, ENGINE_ACTION_LABELS, RESERVED, cloneBindings, codeLabel, input, type BindingSet } from '../../../game/hud/bindings';
import { pads } from '../../gamepad';
import { drawPadGlyph, padIndexOf } from '../../glyphs';
import type { CustomScreen, CustomUi, KeyboardSpec, MenuAction, NavInput, Placed, Rect } from '../model';

type Slot = 0 | 1 | 'pad';
const SLOTS: Slot[] = [0, 1, 'pad'];
/** Focus targets after the rows: Accept, Cancel, Default. */
const BUTTONS = 3;

export class KeyboardScreen implements CustomScreen {
  private row = 0;
  private col = 0;
  /** -1 = in the list; 0..2 = Accept / Cancel / Default. */
  private button = -1;
  private scroll = 0;
  private snapshot?: BindingSet;
  private capturing = false;
  private captureAt = 0;
  private message: { text: string; until: number } | null = null;

  constructor(private readonly spec: KeyboardSpec) {}

  open(): void {
    this.snapshot = cloneBindings(input.current);
    this.row = this.col = this.scroll = 0;
    this.button = -1;
    this.capturing = false;
  }

  close(): void {
    this.stopCapture();
  }

  private get rows(): number {
    return ACTIONS.length;
  }

  private actionLabel(ui: CustomUi, i: number): string {
    const l = this.spec.actions[i];
    return (l && ui.label(l)) || ENGINE_ACTION_LABELS[ACTIONS[i]] || ACTIONS[i];
  }

  private startCapture(ui: CustomUi): void {
    this.capturing = true;
    this.captureAt = performance.now();
    this.message = null;
    ui.sound('select');
    input.capture = (code) => this.captured(ui, code);
  }

  private stopCapture(): void {
    this.capturing = false;
    if (input.capture) input.capture = null;
  }

  private captured(ui: CustomUi, code: string): void {
    if (performance.now() - this.captureAt < 200) return; // the click / key that started it
    if (code === 'Escape') {
      this.stopCapture();
      ui.sound('back');
      return;
    }
    const slot = SLOTS[this.col];
    const isPad = code.startsWith('Pad');
    if (RESERVED.has(code) || isPad !== (slot === 'pad')) {
      this.message = { text: ui.label(this.spec.strings.reserved) || 'Reserved', until: performance.now() + 2000 };
      ui.sound('back');
      return;
    }
    input.set(ACTIONS[this.row], slot, code);
    this.stopCapture();
    ui.sound('value');
  }

  key(ui: CustomUi, e: KeyboardEvent): boolean {
    if (this.capturing) return true; // the bindings capture gets it first; swallow the rest
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.button < 0 && !e.repeat) {
      input.set(ACTIONS[this.row], SLOTS[this.col], '');
      ui.sound('value');
      return true;
    }
    return false;
  }

  nav(ui: CustomUi, a: NavInput): boolean {
    if (this.capturing) return true;
    const n = this.rows;
    switch (a) {
      case 'up':
        if (this.button >= 0) {
          this.button = -1;
          this.row = n - 1;
        } else this.row = (this.row - 1 + n) % n;
        ui.sound('move');
        return true;
      case 'down':
        if (this.button >= 0) {
          this.button = -1;
          this.row = 0;
        } else if (this.row === n - 1) this.button = 0;
        else this.row++;
        ui.sound('move');
        return true;
      case 'left':
      case 'right': {
        const d = a === 'left' ? -1 : 1;
        if (this.button >= 0) this.button = (this.button + d + BUTTONS) % BUTTONS;
        else this.col = (this.col + d + SLOTS.length) % SLOTS.length;
        ui.sound('move');
        return true;
      }
      case 'accept':
        if (this.button >= 0) this.press(ui, this.button);
        else this.startCapture(ui);
        return true;
      case 'back':
        this.cancel(ui);
        return true;
      case 'alt':
        if (this.button < 0) {
          input.set(ACTIONS[this.row], SLOTS[this.col], '');
          ui.sound('value');
        }
        return true;
      default:
        return false;
    }
  }

  private press(ui: CustomUi, b: number): void {
    if (b === 0) {
      input.save();
      ui.sound('select');
      ui.close(true);
    } else if (b === 1) this.cancel(ui);
    else {
      ui.sound('select');
      ui.action({ kind: 'bindingsDefaults' } as MenuAction);
    }
  }

  private cancel(ui: CustomUi): void {
    this.stopCapture();
    if (this.snapshot) input.replace(this.snapshot);
    ui.close();
  }

  click(ui: CustomUi, index: number): void {
    if (this.capturing) return;
    if (index >= 1000) {
      this.button = index - 1000;
      this.press(ui, this.button);
    } else if (index >= 0) {
      this.button = -1;
      this.row = Math.floor(index / 3);
      this.col = index % 3;
      this.startCapture(ui);
    }
  }

  hover(ui: CustomUi, index: number): void {
    if (this.capturing) return;
    if (index >= 1000) {
      if (this.button !== index - 1000) ui.sound('move');
      this.button = index - 1000;
    } else if (index >= 0) {
      const r = Math.floor(index / 3), c = index % 3;
      if (r !== this.row || c !== this.col || this.button >= 0) ui.sound('move');
      this.button = -1;
      this.row = r;
      this.col = c;
    }
  }

  draw(ui: CustomUi, time: number): void {
    const ctx = ui.ctx;
    const sp = this.spec;
    for (const img of sp.titles) ui.drawImage(img);
    const L = sp.list;
    ctx.fillStyle = sp.listBg;
    ctx.fillRect(L.x, L.y, L.w, L.h);
    const rowH = sp.rowHeight;
    const pad = 4;
    const visible = Math.max(1, Math.floor((L.h - pad * 2) / rowH));
    if (this.row < this.scroll) this.scroll = this.row;
    if (this.row >= this.scroll + visible) this.scroll = this.row - visible + 1;
    const nameW = sp.name?.rect.w ?? 176;
    const keyW = sp.key?.rect.w ?? 112;
    const colX = [L.x + pad + 8 + nameW, L.x + pad + 8 + nameW + keyW, L.x + pad + 8 + nameW + keyW * 2];
    const focusBg = sp.rowFocusBg === '#000000' ? 'rgba(127,127,127,0.35)' : sp.rowFocusBg;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.x, L.y, L.w, L.h);
    ctx.clip();
    for (let i = this.scroll; i < Math.min(this.rows, this.scroll + visible); i++) {
      const y = L.y + pad + (i - this.scroll) * rowH;
      const focusedRow = this.button < 0 && i === this.row;
      if (focusedRow) {
        ctx.fillStyle = focusBg;
        ctx.fillRect(L.x + pad, y, L.w - pad * 2, rowH);
      }
      const nameStyle: Placed = sp.name ?? defaultText(nameW, rowH);
      ui.placedText({ ...nameStyle, rect: { x: L.x + pad + 6, y, w: nameW, h: rowH }, vAlign: 'middle' }, this.actionLabel(ui, i), focusedRow ? '#ffffff' : '#c8c8c8');
      SLOTS.forEach((slot, c) => {
        const r: Rect = { x: colX[c], y, w: keyW - 6, h: rowH };
        const cellFocused = focusedRow && this.col === c;
        if (cellFocused) {
          const blink = this.capturing ? 0.5 + 0.5 * Math.sin(time * 10) : 1;
          ctx.strokeStyle = `rgba(230,226,216,${0.75 * blink})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(r.x + 0.5, r.y + 1.5, r.w - 1, r.h - 3);
        }
        const code = slot === 'pad' ? input.current.pad[ACTIONS[i]] : input.current.keys[ACTIONS[i]][slot];
        const keyStyle: Placed = sp.key ?? defaultText(keyW, rowH);
        const capturingHere = cellFocused && this.capturing;
        const glyph = slot === 'pad' && !capturingHere ? padIndexOf(code) : -1;
        if (glyph >= 0) {
          // Pad cell: the button's glyph, then its name for the connected controller.
          const gh = Math.min(rowH - 4, 16);
          const gw = drawPadGlyph(ui.ctx, pads.family, glyph, r.x + 4, y + rowH / 2, gh);
          ui.placedText({ ...keyStyle, scale: keyStyle.scale * 0.85, rect: { ...r, x: r.x + 8 + gw, w: r.w - 8 - gw }, vAlign: 'middle' }, codeLabel(code, pads.family), cellFocused ? '#ffffff' : '#a8a8a8');
        } else {
          const text = capturingHere ? '?' : codeLabel(code);
          ui.placedText({ ...keyStyle, rect: { ...r, x: r.x + 4 }, vAlign: 'middle' }, text, slot === 'pad' ? '#9a9a9a' : cellFocused ? '#ffffff' : '#c8c8c8');
        }
        ui.hit(i * 3 + c, r);
      });
    }
    ctx.restore();
    const bob = Math.sin(time * 6) * 1.5;
    const up = sp.arrows?.up, down = sp.arrows?.down;
    if (this.scroll > 0 && up) ui.drawImage({ ...up, rect: { x: L.x + L.w - 20, y: L.y + 4 - bob, w: 16, h: 16 } });
    if (this.scroll + visible < this.rows && down) ui.drawImage({ ...down, rect: { x: L.x + L.w - 20, y: L.y + L.h - 20 + bob, w: 16, h: 16 } });

    // Prompt (while waiting for a key / showing a message) or the page buttons.
    const msg = this.message && performance.now() < this.message.until ? this.message.text : null;
    if (this.capturing || msg) {
      const text = msg ?? ui.label(sp.strings.pressKey);
      const p = sp.prompt ?? defaultText(512, 40);
      ui.placedText({ ...p, rect: { x: 64, y: 410, w: 512, h: 40 }, hAlign: 'center', vAlign: 'middle' }, text, '#e6e2d8');
      return;
    }
    const buttons = [sp.accept, sp.cancel, sp.reset];
    buttons.forEach((b, k) => {
      if (!b) return;
      const focused = this.button === k;
      const flicker = focused ? 0.9 + 0.1 * Math.sin(time * 9) * Math.sin(time * 2.3) : 1;
      ui.placedText(b.place, ui.label(b.label), b.place.colors[focused ? 'focused' : 'normal'], { alpha: flicker, glow: focused ? 'rgba(255,240,210,0.55)' : undefined });
      ui.hit(1000 + k, b.place.rect);
    });
  }
}

function defaultText(w: number, h: number): Placed {
  return { rect: { x: 0, y: 0, w, h }, font: 2, scale: 1, hAlign: 'left', vAlign: 'middle', colors: { normal: '#c8c8c8', disabled: '#606060', focused: '#ffffff' } };
}
