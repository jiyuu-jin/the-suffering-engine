// FrontEnd: the full-screen menu layer. Draws the click-to-start gate, the
// copyright screen, menu screens (from a MenuModel) and loading screens on a 2D
// canvas at the game's 640x480 virtual resolution, letterboxed to 4:3 and
// scaled to the window, over the menu background video (or over the dimmed
// game for the pause menu). Input: keyboard (arrows/WASD, Enter/Space,
// Esc/Backspace), mouse hover/click, and gamepads (any pad src/app/gamepad.ts supports: d-pad /
// left stick, A accept, B back, Y delete a save, Start). While a pad is the last-used device the
// mouse cursor is hidden (class `pad-active` on <html>) and key hints show pad glyphs.
//
// Screens with layout 'placed' are drawn exactly where the game's GUI
// templates put them (rects, fonts, glyph scales, per-state colours); 'list'
// and 'form' screens (developer tools, the provisional fallback) use an
// automatic layout. Dialogs use the game's Alert Box layout when the model has
// one (AlertSpec). Screens with a `custom` object (archives, credits, keyboard
// page) draw themselves through the CustomUi services below.

import type { AudioSystem } from '../audio';
import type { MenuAssets } from './assets';
import type { BorderSpec, CustomUi, ImageSpec, Label, MenuAction, MenuItem, MenuModel, MenuScreen, MeterSpec, Placed, Rect, SaveListSpec } from './model';
import { cloneSettings, getSetting, setSetting, type Settings } from './settings';
import { GamepadNav, type NavAction } from './input';
import type { BitmapFont } from './text';
import { pads } from '../gamepad';
import { drawPadGlyph } from '../glyphs';

export const VW = 640;
export const VH = 480;

/** Colours for automatic layouts (placed widgets use the game's own colours). */
const COLOR = {
  item: '#8d8a84',
  itemHi: '#e6e2d8',
  glow: '#b01a10',
  disabled: '#3a3836',
  title: '#d9cfae',
  text: '#c4bfb2',
  dim: '#77736b',
};

type Mode = 'hidden' | 'blank' | 'gate' | 'copyright' | 'menu' | 'loading';
type Backdrop = 'video' | 'black' | 'game';

interface Hit {
  index: number;
  rect: Rect;
  /** Value area of slider rows (click sets the value). */
  value?: Rect;
}

interface StackEntry {
  screen: MenuScreen;
  sel: number;
  openedAt: number;
  /** Options pages: settings when the page opened (Cancel restores them). */
  snapshot?: Settings;
  /** 'saves' screens: first visible row. */
  scroll?: number;
  /** Custom screens: their CustomUi. */
  ui?: CustomUi;
}

export interface FrontEndHost {
  /** Run a menu action that leaves the menu stack (new game, resume, ...). */
  action(a: MenuAction): void;
  settingsChanged(s: Settings, save: boolean): void;
}

export class FrontEnd {
  readonly root: HTMLDivElement;
  /** Container for the background video player (behind the canvas). */
  readonly bgLayer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private mode: Mode = 'hidden';
  private backdrop: Backdrop = 'black';
  private stack: StackEntry[] = [];
  private hits: Hit[] = [];
  private raf = 0;
  private readonly t0 = performance.now();
  private openedAt = 0;
  private readonly pad = new GamepadNav();
  private assets?: MenuAssets;
  private gateResolve?: () => void;
  private copyrightResolve?: () => void;
  private copyrightTimer = 0;
  private loadingMsg = '';
  private loadingSteps = 0;
  private loadingShown = 0;
  private loadingVariant: 'newGame' | 'default' = 'default';
  private loadingTiles: (number | undefined)[] | undefined;
  private gateReady = false;
  /** Items hidden (while a transition video plays). */
  private itemsHidden = false;
  /** Called on accept/back while the items are hidden (skips a transition video). */
  onSkip?: () => void;
  /** performance.now() of the last user input (attract-mode idle timer). */
  lastInputAt = performance.now();
  private view = { x: 0, y: 0, s: 1 };

  constructor(
    private readonly model: MenuModel,
    private readonly audio: AudioSystem,
    private readonly settings: Settings,
    private readonly host: FrontEndHost,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'frontend';
    this.root.hidden = true;
    this.bgLayer = document.createElement('div');
    this.bgLayer.className = 'fe-bg';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fe-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.root.append(this.bgLayer, this.canvas);
    document.body.append(this.root);

    window.addEventListener('keydown', (e) => this.onKey(e), true);
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Custom screens may use the wheel (map zoom).
        const top = this.stack[this.stack.length - 1];
        if (this.mode !== 'menu' || !top?.screen.custom?.wheel || !top.ui) return;
        const r = this.canvas.getBoundingClientRect();
        top.screen.custom.wheel(top.ui, e.deltaY, (e.clientX - r.left - this.view.x) / this.view.s, (e.clientY - r.top - this.view.y) / this.view.s);
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setAssets(a: MenuAssets): void {
    this.assets = a;
    const cur = this.model.images.cursor !== undefined ? a.images.get(this.model.images.cursor) : undefined;
    if (cur) {
      try {
        this.canvas.style.cursor = `url(${cur.toDataURL()}) 1 1, default`;
      } catch {
        /* keep the default cursor */
      }
    }
  }

  get visible(): boolean {
    return this.mode !== 'hidden';
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get screenId(): string | undefined {
    return this.stack[this.stack.length - 1]?.screen.id;
  }

  /** Root screen of the open menu stack. */
  get rootScreenId(): string | undefined {
    return this.stack[0]?.screen.id;
  }

  get stackDepth(): number {
    return this.stack.length;
  }

  // -------------------------------------------------------------------------
  // Modes

  /** Black "click to start" gate; resolves on the first click/key/gamepad press (a user gesture). */
  showGate(): Promise<void> {
    this.setMode('gate', 'black');
    return new Promise((r) => (this.gateResolve = r));
  }

  setGateReady(ready: boolean): void {
    this.gateReady = ready;
  }

  /** Plain black screen (between movies). */
  showBlank(): void {
    this.setMode('blank', 'black');
  }

  /** Copyright screen for `seconds` (input skips it after a moment). */
  showCopyright(seconds: number): Promise<void> {
    this.setMode('copyright', 'black');
    return new Promise((r) => {
      this.copyrightResolve = r;
      clearTimeout(this.copyrightTimer);
      this.copyrightTimer = window.setTimeout(() => this.finishCopyright(), seconds * 1000);
    });
  }

  /** Opens a menu screen as the root of a new stack. */
  openMenu(screenId: string, backdrop: Backdrop): void {
    const screen = this.model.screens[screenId];
    if (!screen) throw new Error(`menu screen "${screenId}" not in model`);
    this.closeAll();
    this.itemsHidden = false;
    this.setMode('menu', backdrop);
    this.push(screen);
  }

  /** `tiles`: a chapter's loading-screen picture (Interface texture ids) instead of the variant's. */
  showLoading(variant: 'newGame' | 'default', tiles?: (number | undefined)[]): void {
    this.loadingTiles = tiles;
    this.loadingMsg = '';
    this.loadingSteps = 0;
    this.loadingShown = 0;
    this.loadingVariant = variant;
    this.setMode('loading', 'black');
  }

  setLoadingMessage(msg: string): void {
    this.loadingMsg = msg;
    this.loadingSteps++;
  }

  /**
   * Shows the background video layer whatever the backdrop (credits video, archive page-turn
   * clips over the paused game); the 'game' / 'black' backdrops hide it otherwise.
   */
  showVideoLayer(on: boolean): void {
    this.bgLayer.style.visibility = on ? 'visible' : '';
  }

  /** Hides the menu items (e.g. while a transition video plays). */
  setItemsHidden(hidden: boolean): void {
    this.itemsHidden = hidden;
  }

  hide(): void {
    this.closeAll();
    this.setMode('hidden', 'black');
  }

  private closeAll(): void {
    for (const e of this.stack.splice(0)) e.screen.custom?.close?.();
  }

  private setMode(mode: Mode, backdrop: Backdrop): void {
    this.mode = mode;
    this.backdrop = backdrop;
    this.openedAt = performance.now();
    this.pad.reset();
    this.root.hidden = mode === 'hidden';
    this.root.dataset.mode = mode;
    this.root.dataset.backdrop = backdrop;
    if (mode === 'hidden') {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (!this.raf) {
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        this.pollPad();
        this.draw();
      };
      this.raf = requestAnimationFrame(loop);
    }
    this.draw();
  }

  private push(screen: MenuScreen): void {
    const n = screen.items.length;
    let sel = Math.min(Math.max(0, screen.defaultFocus ?? 0), Math.max(0, n - 1));
    if (isDisabled(screen.items[sel])) sel = Math.max(0, screen.items.findIndex((it) => !isDisabled(it)));
    const entry: StackEntry = { screen, sel, openedAt: performance.now(), snapshot: screen.page ? cloneSettings(this.settings) : undefined };
    this.stack.push(entry);
    if (screen.custom) {
      entry.ui = this.customUi(entry);
      screen.custom.open?.(entry.ui);
    }
  }

  private pop(): void {
    this.stack.pop()?.screen.custom?.close?.();
    const top = this.stack[this.stack.length - 1];
    if (top) top.openedAt = performance.now() - 1e4; // no fade when returning
  }

  // -------------------------------------------------------------------------
  // Input

  private onKey(e: KeyboardEvent): void {
    if (this.mode === 'hidden') return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'F1') return; // developer toggle handled by the app
    this.lastInputAt = performance.now();
    // The menu is modal: keep keys away from the game while it is open.
    e.stopPropagation();
    if (this.mode === 'gate' || this.mode === 'copyright') {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      this.nav('accept');
      return;
    }
    const map: Record<string, NavAction> = {
      ArrowUp: 'up',
      KeyW: 'up',
      ArrowDown: 'down',
      KeyS: 'down',
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      Enter: 'accept',
      NumpadEnter: 'accept',
      Space: 'accept',
      Escape: 'back',
      Backspace: 'back',
    };
    const topEntry = this.stack[this.stack.length - 1];
    if (this.mode === 'menu' && topEntry?.ui && topEntry.screen.custom?.key?.(topEntry.ui, e)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Delete' && this.mode === 'menu' && !e.repeat) {
      // Save lists: Delete removes the focused save (the flow asks for confirmation).
      const top = this.stack[this.stack.length - 1];
      const it = top?.screen.items[top.sel];
      if (it?.type === 'button' && it.deleteAction) {
        e.preventDefault();
        this.sound('select');
        this.host.action(it.deleteAction);
      }
      return;
    }
    const act = map[e.code];
    if (!act) return;
    e.preventDefault();
    if (e.repeat && (act === 'accept' || act === 'back')) return;
    this.nav(act);
  }

  private pollPad(): void {
    const acts = this.pad.poll();
    if (acts.length) this.lastInputAt = performance.now();
    for (const a of acts) this.nav(a === 'start' ? (this.rootScreenId === this.model.pauseScreen && this.stack.length === 1 ? 'back' : 'accept') : a);
  }

  private nav(a: NavAction): void {
    const now = performance.now();
    if (this.mode === 'gate') {
      if (this.gateReady && (a === 'accept' || a === 'back' || a === 'start')) {
        const r = this.gateResolve;
        this.gateResolve = undefined;
        r?.();
      }
      return;
    }
    if (this.mode === 'copyright') {
      if (now - this.openedAt > 1000) this.finishCopyright();
      return;
    }
    if (this.mode === 'menu' && this.itemsHidden) {
      if (a === 'accept' || a === 'back' || a === 'start') this.onSkip?.();
      return;
    }
    if (this.mode !== 'menu') return;
    // Ignore input in the first instant (e.g. the Esc that opened the pause menu).
    if (now - this.openedAt < 200) return;
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    if (top.screen.custom && top.ui) {
      if (top.screen.custom.nav?.(top.ui, a)) return;
      if (a === 'back') this.back();
      return;
    }
    const items = top.screen.items;
    const cur = items[top.sel];
    switch (a) {
      case 'up':
      case 'down':
        this.moveFocus(top, a === 'up' ? -1 : 1);
        break;
      case 'left':
      case 'right': {
        const d = a === 'left' ? -1 : 1;
        if (cur?.type === 'button' && cur.group) {
          // Horizontal button rows (Accept/Cancel, Yes/No).
          const peers = items.map((it, i) => (it.type === 'button' && it.group === cur.group && !isDisabled(it) ? i : -1)).filter((i) => i >= 0);
          const k = peers.indexOf(top.sel);
          const next = peers[(k + d + peers.length) % peers.length];
          if (next !== undefined && next !== top.sel) {
            top.sel = next;
            this.sound('move');
          }
        } else this.adjust(cur, d);
        break;
      }
      case 'accept':
        this.activate(top.sel);
        break;
      case 'back':
        this.back();
        break;
      case 'alt':
        // Pad "alt" (Y / Triangle): Delete on save rows.
        if (cur?.type === 'button' && cur.deleteAction && !isDisabled(cur)) {
          this.sound('select');
          this.host.action(cur.deleteAction);
        }
        break;
    }
  }

  private moveFocus(top: StackEntry, d: number): void {
    const items = top.screen.items;
    let i = top.sel;
    for (let n = 0; n < items.length; n++) {
      i = (i + d + items.length) % items.length;
      if (!isDisabled(items[i])) break;
    }
    if (i !== top.sel) {
      top.sel = i;
      this.sound('move');
    }
  }

  private finishCopyright(): void {
    clearTimeout(this.copyrightTimer);
    const r = this.copyrightResolve;
    this.copyrightResolve = undefined;
    r?.();
  }

  private back(): void {
    const top = this.stack[this.stack.length - 1];
    if (top?.screen.page) {
      this.cancelPage();
      return;
    }
    if (this.stack.length > 1) {
      this.sound('back');
      this.pop();
      return;
    }
    // Esc on a root screen: the pause menu (or a screen opened over the game) resumes; the
    // main menu stays.
    if (this.screenId === this.model.pauseScreen || this.backdrop === 'game') {
      this.sound('back');
      this.host.action({ kind: 'resume' });
    }
  }

  private cancelPage(): void {
    const top = this.stack[this.stack.length - 1];
    if (top?.snapshot) {
      const snap = top.snapshot;
      Object.assign(this.settings, cloneSettings(snap));
      this.host.settingsChanged(this.settings, false);
    }
    this.sound('back');
    if (this.stack.length > 1) this.pop();
  }

  private activate(index: number): void {
    const top = this.stack[this.stack.length - 1];
    const item = top?.screen.items[index];
    if (!item || isDisabled(item)) return;
    top.sel = index;
    if (item.type === 'choice') {
      this.adjust(item, 1);
      return;
    }
    if (item.type === 'slider') return;
    const a = item.action;
    switch (a.kind) {
      case 'push': {
        const screen = this.model.screens[a.screen];
        if (!screen) return;
        this.sound('select');
        if (a.transition) {
          // The game plays a transition video first (flow), then opens the screen.
          this.host.action(a);
          return;
        }
        this.push(screen);
        break;
      }
      case 'back':
        this.back();
        break;
      case 'pageAccept':
        this.sound('select');
        this.host.settingsChanged(this.settings, true);
        if (this.stack.length > 1) this.pop();
        break;
      case 'pageCancel':
        this.cancelPage();
        break;
      case 'none':
        break;
      default:
        this.sound('select');
        this.host.action(a);
    }
  }

  /** Opens a pushed screen after its transition video (called by the flow). */
  pushScreen(id: string): void {
    const screen = this.model.screens[id];
    if (screen && this.mode === 'menu') this.push(screen);
  }

  /** Closes the top screen (flow: after a confirmation was answered). */
  popScreen(): void {
    if (this.mode === 'menu' && this.stack.length > 1) this.pop();
  }

  /** Closes screens until `id` is on top (no-op if it isn't open). */
  popTo(id: string): void {
    if (!this.stack.some((e) => e.screen.id === id)) return;
    while (this.stack.length > 1 && this.screenId !== id) this.pop();
  }

  /** Items of open screens changed (save lists, disabled flags): keep the focus valid. */
  refresh(): void {
    for (const e of this.stack) {
      const items = e.screen.items;
      e.sel = Math.min(e.sel, Math.max(0, items.length - 1));
      if (isDisabled(items[e.sel])) {
        const i = items.findIndex((it) => !isDisabled(it));
        e.sel = i < 0 ? 0 : i;
      }
    }
  }

  private adjust(item: MenuItem | undefined, dir: number): void {
    if (!item) return;
    if (item.type === 'slider') {
      const v = Number(getSetting(this.settings, item.setting) ?? (item.min + item.max) / 2);
      const next = clamp(Math.round((v + dir * item.step) / item.step) * item.step, item.min, item.max);
      if (Math.abs(next - v) < 1e-6) return;
      setSetting(this.settings, item.setting, Number(next.toFixed(3)));
    } else if (item.type === 'choice') {
      const n = item.choices.length;
      if (n < 2) return;
      const k = this.choiceIndex(item);
      setSetting(this.settings, item.setting, item.choices[(k + dir + n) % n].value);
    } else return;
    this.host.settingsChanged(this.settings, false);
    this.sound('value');
  }

  private choiceIndex(item: Extract<MenuItem, { type: 'choice' }>): number {
    const v = getSetting(this.settings, item.setting);
    const k = item.choices.findIndex((c) => c.value === v);
    return k < 0 ? 0 : k;
  }

  private toVirtual(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.x) / this.view.s, y: (e.clientY - r.top - this.view.y) / this.view.s };
  }

  private hitAt(x: number, y: number): Hit | undefined {
    return this.hits.find((h) => inRect(h.rect, x, y) || (h.value && inRect(h.value, x, y)));
  }

  private onPointerMove(e: PointerEvent): void {
    this.lastInputAt = performance.now();
    if (this.mode !== 'menu' || this.itemsHidden) return;
    const p = this.toVirtual(e);
    const h = this.hitAt(p.x, p.y);
    const top = this.stack[this.stack.length - 1];
    if (top?.screen.custom && top.ui) {
      if (h) top.screen.custom.hover?.(top.ui, h.index);
      return;
    }
    if (h && top && top.sel !== h.index && !isDisabled(top.screen.items[h.index])) {
      top.sel = h.index;
      this.sound('move');
    }
  }

  private onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    this.lastInputAt = performance.now();
    if (e.button === 2) {
      if (this.mode === 'menu') this.nav('back');
      return;
    }
    if (e.button !== 0) return;
    if (this.mode === 'gate' || this.mode === 'copyright') {
      this.nav('accept');
      return;
    }
    if (this.mode === 'menu' && this.itemsHidden) {
      this.onSkip?.();
      return;
    }
    if (this.mode !== 'menu') return;
    if (performance.now() - this.openedAt < 200) return;
    const p = this.toVirtual(e);
    const h = this.hitAt(p.x, p.y);
    const custom = this.stack[this.stack.length - 1];
    if (custom?.screen.custom && custom.ui) {
      custom.screen.custom.click?.(custom.ui, h?.index ?? -1, p.x, p.y);
      return;
    }
    if (!h) return;
    const top = this.stack[this.stack.length - 1];
    const item = top?.screen.items[h.index];
    if (!item || isDisabled(item)) return;
    top.sel = h.index;
    if (item.type === 'slider' && h.value && inRect(h.value, p.x, p.y)) {
      // Click position on the bar sets the value directly.
      const f = clamp((p.x - h.value.x) / h.value.w, 0, 1);
      const v = clamp(Math.round((item.min + f * (item.max - item.min)) / item.step) * item.step, item.min, item.max);
      if (v !== getSetting(this.settings, item.setting)) {
        setSetting(this.settings, item.setting, Number(v.toFixed(3)));
        this.host.settingsChanged(this.settings, false);
        this.sound('value');
      }
      return;
    }
    if (item.type === 'slider') return;
    this.activate(h.index);
  }

  sound(kind: 'move' | 'select' | 'back' | 'value'): void {
    const key = this.model.sounds[kind];
    if (!key || this.audio.context.state !== 'running') return;
    try {
      this.audio.play(key, { bus: 'sfx' });
    } catch {
      /* sound bank missing */
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    const s = Math.min(w / VW, h / VH);
    this.view = { s, x: (w - VW * s) / 2, y: (h - VH * s) / 2 };
    this.draw();
  }

  private label(l: Label | undefined): string {
    if (!l) return '';
    return this.assets ? this.assets.label(l) : 'text' in l ? l.text : l.fallback;
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, window.innerWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.mode === 'hidden') return;
    if (this.backdrop === 'black') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(dpr * this.view.s, 0, 0, dpr * this.view.s, dpr * this.view.x, dpr * this.view.y);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const time = (performance.now() - this.t0) / 1000;
    switch (this.mode) {
      case 'gate':
        this.drawGate(time);
        break;
      case 'copyright':
        this.drawCopyright();
        break;
      case 'menu':
        this.drawMenu(time);
        break;
      case 'loading':
        this.drawLoading(time);
        break;
    }
  }

  private font(id: number | 'ui' | 'title'): BitmapFont | undefined {
    if (!this.assets) return undefined;
    if (id === 'ui') return this.assets.fonts.ui;
    if (id === 'title') return this.assets.fonts.title;
    return this.assets.fontById.get(id) ?? this.assets.fonts.ui;
  }

  /** Text with the bitmap font if loaded, else a CSS fallback (only before assets exist). */
  private text(
    which: number | 'ui' | 'title',
    s: string,
    x: number,
    y: number,
    o: { color?: string; align?: 'left' | 'center' | 'right'; scale?: number; alpha?: number; glow?: string; maxWidth?: number; shadow?: string | null } = {},
  ): { width: number; height: number } {
    const f = this.font(which);
    if (f) return f.draw(this.ctx, s, x, y, o);
    const ctx = this.ctx;
    const px = (which === 'title' || which === 3 ? 24 : 15) * (o.scale ?? 1);
    ctx.save();
    ctx.globalAlpha *= o.alpha ?? 1;
    ctx.font = `${px}px Georgia, serif`;
    ctx.fillStyle = o.color ?? '#fff';
    ctx.textAlign = o.align ?? 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(s, x, y);
    const w = ctx.measureText(s).width;
    ctx.restore();
    return { width: w, height: px * 1.3 };
  }

  /** Draws a game text widget's label inside its rect (alignment, margins, scale). */
  private placedText(p: Placed, s: string, color: string, o: { alpha?: number; glow?: string } = {}): Rect {
    const f = this.font(p.font);
    const m = p.margins ?? { top: 0, bottom: 0, left: 0, right: 0 };
    const r = { x: p.rect.x + m.left, y: p.rect.y + m.top, w: p.rect.w - m.left - m.right, h: p.rect.h - m.top - m.bottom };
    const lines = s.split('\n').length;
    const h = (f?.lineHeight ?? 20) * p.scale * lines;
    const y = p.vAlign === 'top' ? r.y : p.vAlign === 'bottom' ? r.y + r.h - h : r.y + (r.h - h) / 2;
    const x = p.hAlign === 'left' ? r.x : p.hAlign === 'right' ? r.x + r.w : r.x + r.w / 2;
    const d = this.text(p.font, s, x, y, { align: p.hAlign, scale: p.scale, color, alpha: o.alpha, glow: o.glow });
    const x0 = p.hAlign === 'left' ? x : p.hAlign === 'right' ? x - d.width : x - d.width / 2;
    return { x: x0, y, w: d.width, h: d.height };
  }

  private drawImage(img: ImageSpec, alpha = 1): void {
    const c = this.assets?.images.get(img.texture);
    if (!c) return;
    const uv = img.uv ?? { x: 0, y: 0, w: c.width, h: c.height };
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(c, uv.x, uv.y, uv.w, uv.h, img.rect.x, img.rect.y, img.rect.w, img.rect.h);
    ctx.restore();
  }

  /** 3x2 tiled full-screen picture (Screen Background). */
  private drawTiles(tiles: (number | undefined)[], alpha = 1): boolean {
    const ctx = this.ctx;
    let any = false;
    ctx.save();
    ctx.globalAlpha *= alpha;
    tiles.forEach((id, i) => {
      const c = id !== undefined ? this.assets?.images.get(id) : undefined;
      if (!c) return;
      any = true;
      const tw = VW / 3;
      const th = VH / 2;
      // +0.5 overlap hides seams between scaled tiles.
      ctx.drawImage(c, (i % 3) * tw, Math.floor(i / 3) * th, tw + 0.5, th + 0.5);
    });
    ctx.restore();
    return any;
  }

  private drawLogo(cx: number, y: number, width: number, alpha = 1): number {
    const logo = this.model.images.logo;
    if (!logo.length || !this.assets) return 0;
    const minX = Math.min(...logo.map((l) => l.rect.x));
    const maxX = Math.max(...logo.map((l) => l.rect.x + l.rect.w));
    const minY = Math.min(...logo.map((l) => l.rect.y));
    const maxY = Math.max(...logo.map((l) => l.rect.y + l.rect.h));
    const s = width / (maxX - minX);
    for (const l of logo) {
      this.drawImage({ ...l, rect: { x: cx - width / 2 + (l.rect.x - minX) * s, y: y + (l.rect.y - minY) * s, w: l.rect.w * s, h: l.rect.h * s } }, alpha);
    }
    return (maxY - minY) * s;
  }

  private drawMeter(m: MeterSpec, f: number, focused: boolean): void {
    const ctx = this.ctx;
    const r = m.rect;
    // Inner bar area (the frame art has a border of about 1/8 of its height).
    const ix = r.x + r.h * 0.18;
    const iy = r.y + r.h * 0.3;
    const iw = r.w - r.h * 0.36;
    const ih = r.h * 0.4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(ix, iy, iw, ih);
    ctx.save();
    ctx.globalAlpha = focused ? 1 : 0.8;
    ctx.fillStyle = m.fill;
    ctx.fillRect(ix, iy, iw * clamp(f, 0, 1), ih);
    ctx.restore();
    if (m.frame) this.drawImage({ texture: m.frame.texture, uv: m.frame.uv, rect: r }, 1);
    else {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ix - 1, iy - 1, iw + 2, ih + 2);
    }
  }

  private vignette(strength: number): void {
    const ctx = this.ctx;
    const { x, y, s } = this.view;
    const ex = x / s;
    const ey = y / s;
    const g = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.3, VW / 2, VH / 2, Math.max(VW / 2 + ex, VH * 0.85));
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(-ex, -ey, VW + 2 * ex, VH + 2 * ey);
  }

  /** Fills the whole window (not only the 4:3 area) with black at `alpha`. */
  private dimAll(alpha: number): void {
    const { x, y, s } = this.view;
    this.ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    this.ctx.fillRect(-x / s, -y / s, VW + (2 * x) / s, VH + (2 * y) / s);
  }

  private drawGate(time: number): void {
    const fade = clamp((performance.now() - this.openedAt) / 800, 0, 1);
    const h = this.drawLogo(VW / 2, 120, 440, fade);
    const y = 120 + (h || 160) + 50;
    if (this.gateReady) {
      const a = 0.55 + 0.45 * Math.sin(time * 3);
      this.text('ui', 'Click or press any key to start', VW / 2, y, { align: 'center', color: COLOR.text, alpha: a * fade });
    } else {
      this.text('ui', 'Preparing...', VW / 2, y, { align: 'center', color: COLOR.dim, alpha: fade });
    }
  }

  private drawCopyright(): void {
    const fade = clamp((performance.now() - this.openedAt) / 500, 0, 1);
    const tiles = this.model.boot.copyright?.tiles ?? [];
    if (!this.drawTiles(tiles, fade)) this.drawLogo(VW / 2, 140, 460, fade);
  }

  private drawLoading(time: number): void {
    const v = this.loadingVariant === 'newGame' ? (this.model.loading.newGame ?? this.model.loading.default) : this.model.loading.default;
    const hasPicture = (this.loadingTiles && this.drawTiles(this.loadingTiles)) || (v ? this.drawTiles(v.tiles) : false);
    if (!hasPicture) {
      this.vignette(0.9);
      this.drawLogo(VW / 2, 90, 360, 0.9);
      this.text('title', this.label(this.model.loading.label), VW / 2, 268, { align: 'center', color: COLOR.title });
    }
    // Pseudo progress from the loader's step messages (eases toward the next step).
    const target = 1 - Math.pow(0.82, this.loadingSteps);
    this.loadingShown += (target - this.loadingShown) * 0.08;
    const meter = this.model.loading.meter ?? { rect: { x: 215, y: 406, w: 210, h: 37 }, fill: '#afaf00' };
    this.drawMeter(meter, this.loadingShown, true);
    if (this.loadingMsg) {
      this.text('ui', this.loadingMsg, VW / 2, meter.rect.y - 14, { align: 'center', color: '#d0c8b0', scale: 0.7, maxWidth: 560 });
    }
    void time;
  }

  private drawMenu(time: number): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    const screen = top.screen;
    // Alert boxes are drawn over the screen that opened them (its hits are discarded).
    let below = screen.dialog && screen.alert ? this.stack[this.stack.length - 2] : undefined;
    if (below?.screen.dialog) below = undefined;
    const base = below?.screen ?? screen;
    if (!base.custom?.opaque) {
      if (this.backdrop === 'video') this.vignette(0.65);
      if (base.dim !== undefined) this.dimAll(base.dim);
      else if (this.backdrop === 'game') this.dimAll(0.6);
    }
    if (below) this.drawEntry(below, time, 1);
    this.hits = [];
    const fadeIn = screen.fadeIn ?? 0.15;
    const alpha = clamp((performance.now() - top.openedAt) / 1000 / fadeIn, 0, 1);
    this.drawEntry(top, time, alpha);
  }

  private drawEntry(entry: StackEntry, time: number, alpha: number): void {
    const screen = entry.screen;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    if (screen.custom && entry.ui) screen.custom.draw(entry.ui, time);
    else if (screen.dialog && screen.alert) this.drawAlert(screen, entry.sel, time);
    else if (screen.dialog) this.drawDialog(screen, entry.sel, time);
    else if (screen.layout === 'saves') this.drawSaves(screen, entry, time);
    else if (screen.layout === 'placed') this.drawPlaced(screen, entry.sel, time);
    else this.drawAuto(screen, entry.sel, time);
    if (screen.decorate && !screen.custom) screen.decorate((entry.ui ??= this.customUi(entry)), time, entry.sel);
    this.ctx.restore();
  }

  // ---- placed (game layout) ----

  private drawPlaced(screen: MenuScreen, sel: number, time: number): void {
    for (const img of screen.titleImages ?? []) this.drawImage(img);
    for (const img of screen.images ?? []) this.drawImage(img);
    if (screen.message && screen.messagePlace) {
      const mp = screen.messagePlace;
      this.wrapText(mp, this.label(screen.message), mp.colors.normal);
    } else if (screen.message) {
      this.text('ui', this.label(screen.message), VW / 2, VH * 0.45, { align: 'center', color: COLOR.text, maxWidth: 480 });
    }
    const focusedItem = screen.items[sel];
    if (!this.itemsHidden && focusedItem?.help) {
      const h = focusedItem.help;
      this.wrapText(h.place, this.label(h.label), h.place.colors.normal);
    }
    if (!this.itemsHidden) {
      screen.items.forEach((item, i) => {
        if (!item.place) return;
        const state = isDisabled(item) ? 'disabled' : i === sel ? 'focused' : 'normal';
        const focused = state === 'focused';
        const color = item.place.colors[state];
        // Focus effect: soft glow with a slow flicker (GUI Effects parameters are not decoded).
        const glow = focused ? 'rgba(255,240,210,0.55)' : undefined;
        const flicker = focused ? 0.9 + 0.1 * Math.sin(time * 9) * Math.sin(time * 2.3) : 1;
        const r = this.placedText(item.place, this.label(item.label), color, { glow, alpha: flicker });
        let hit: Rect = item.place.rect;
        let value: Rect | undefined;
        if (item.type === 'slider') {
          const v = Number(getSetting(this.settings, item.setting) ?? (item.min + item.max) / 2);
          const f = (v - item.min) / (item.max - item.min);
          const m = item.meter ?? { rect: { x: item.place.rect.x + item.place.rect.w + 20, y: item.place.rect.y, w: 200, h: item.place.rect.h }, fill: '#808080' };
          this.drawMeter(m, f, focused);
          value = m.rect;
          hit = union(hit, m.rect);
        } else if (item.type === 'choice') {
          const c = item.choices[this.choiceIndex(item)];
          if (c) {
            const cp = c.place ?? { ...item.place, rect: { ...item.place.rect, x: item.place.rect.x + item.place.rect.w } };
            const text = item.format === 'resolution' ? this.resolutionText(Number(c.value)) : this.label(c.label);
            const cr = this.placedText(cp, text, cp.colors[focused ? 'focused' : 'normal']);
            hit = union(hit, union(cp.rect, cr));
            if (focused) this.drawArrows(cr.x - 10, cr.x + cr.w + 10, cr.y + cr.h / 2, time, 10);
          }
        }
        void r;
        this.hits.push({ index: i, rect: hit, value });
      });
    }
    if (screen.footer && screen.footerPlace) this.placedText(screen.footerPlace, this.label(screen.footer), screen.footerPlace.colors.normal);
    else if (screen.footer) this.text('ui', this.label(screen.footer), VW / 2, VH - 34, { align: 'center', color: COLOR.dim, scale: 0.8 });
  }

  /**
   * A key hint ("<key> - <action>"): drawn as is for keyboard play; with a pad,
   * the key word becomes the pad's glyph (Return / Enter = accept, Esc = back, Delete = alt).
   */
  private drawHint(place: Placed, text: string): void {
    const m = pads.usingPad ? /^\s*([A-Za-z]+)\s+-\s+(.+)$/s.exec(text) : null;
    const key = m?.[1].toLowerCase();
    const index = key === 'return' || key === 'enter' ? 0 : key === 'esc' || key === 'escape' ? 1 : key === 'delete' || key === 'del' ? 3 : -1;
    if (!m || index < 0) {
      this.placedText(place, text, place.colors.normal);
      return;
    }
    const h = Math.min(18, place.rect.h * 0.9);
    const shifted = { ...place, rect: { ...place.rect, x: place.rect.x + h + 4, w: place.rect.w - h - 4 } };
    const r = this.placedText(shifted, m[2], place.colors.normal);
    drawPadGlyph(this.ctx, pads.family, index, r.x - h - 4, r.y + r.h / 2, h);
  }

  // ---- Load / Save list (LoadSave GUI) ----

  private thumbs = new Map<string, HTMLImageElement>();

  private thumb(url: string | undefined): HTMLImageElement | undefined {
    if (!url) return undefined;
    let img = this.thumbs.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      if (this.thumbs.size > 64) this.thumbs.clear();
      this.thumbs.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : undefined;
  }

  /** Nine-slice GUI Border around a rect. */
  private drawBorder(b: BorderSpec | NonNullable<SaveListSpec['border']>, r: Rect): void {
    const c = this.assets?.images.get(b.texture);
    if (!c) {
      this.ctx.strokeStyle = 'rgba(150,140,120,0.6)';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      return;
    }
    const e = b.edge;
    const { x: u, y: v, w: uw, h: vh } = b.uv;
    const ctx = this.ctx;
    const xs = [u, u + e, u + uw - e, u + uw];
    const ys = [v, v + e, v + vh - e, v + vh];
    const dx = [r.x - e, r.x, r.x + r.w, r.x + r.w + e];
    const dy = [r.y - e, r.y, r.y + r.h, r.y + r.h + e];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        if (i === 1 && j === 1) continue; // the centre is the listbox background
        const sw = xs[i + 1] - xs[i], sh = ys[j + 1] - ys[j];
        if (sw <= 0 || sh <= 0) continue;
        ctx.drawImage(c, xs[i], ys[j], sw, sh, dx[i], dy[j], dx[i + 1] - dx[i], dy[j + 1] - dy[j]);
      }
    }
  }

  private drawSaves(screen: MenuScreen, top: StackEntry, time: number): void {
    const spec = screen.saves;
    if (!spec) return;
    const ctx = this.ctx;
    for (const img of screen.titleImages ?? []) this.drawImage(img);
    if (!screen.titleImages?.length && screen.title) this.text('title', this.label(screen.title), VW / 2, 34, { align: 'center', color: COLOR.title, scale: 1.25 });
    const L = spec.list;
    ctx.fillStyle = spec.listBg;
    ctx.fillRect(L.x, L.y, L.w, L.h);
    if (spec.border) this.drawBorder(spec.border, L);
    const rowH = spec.rowHeight;
    const pad = 3;
    const visible = Math.max(1, Math.floor((L.h - pad * 2) / rowH));
    const items = screen.items;
    let scroll = top.scroll ?? 0;
    if (top.sel < scroll) scroll = top.sel;
    if (top.sel >= scroll + visible) scroll = top.sel - visible + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, items.length - visible)));
    top.scroll = scroll;
    if (!items.length && spec.strings.empty) {
      const c = spec.center ?? spec.name;
      if (c) this.placedText({ ...c, rect: { x: L.x, y: L.y, w: L.w, h: L.h }, hAlign: 'center', vAlign: 'middle' }, this.label(spec.strings.empty), COLOR.text);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.x, L.y, L.w, L.h);
    ctx.clip();
    for (let i = scroll; i < Math.min(items.length, scroll + visible); i++) {
      const item = items[i];
      if (item.type !== 'button') continue;
      const row = item.save;
      const y = L.y + pad + (i - scroll) * rowH;
      const focused = i === top.sel;
      const state = isDisabled(item) ? 'disabled' : focused ? 'focused' : 'normal';
      const rr: Rect = { x: L.x + pad, y, w: L.w - pad * 2, h: rowH };
      if (focused) {
        ctx.fillStyle = spec.rowFocusBg;
        ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
      }
      const name = spec.name;
      const color = name?.colors[state] ?? (focused ? '#000' : COLOR.item);

      if (!row || row.isNew) {
        if (name) this.placedText({ ...name, rect: { x: rr.x + 10, y: rr.y, w: rr.w - 20, h: rr.h } }, this.label(item.label), color);
        else this.text('ui', this.label(item.label), rr.x + 10, rr.y + 10, { color });
      } else {
        // Thumbnail (engine addition), then name / detail and the date column.
        const th = rr.h - 6;
        const tw = Math.round((th * 4) / 3);
        ctx.fillStyle = '#111';
        ctx.fillRect(rr.x + 4, rr.y + 3, tw, th);
        const img = this.thumb(row.thumbnail);
        // Unfocused rows are dim (the data's #404040 text); their thumbnails follow suit.
        if (img) {
          ctx.globalAlpha = focused ? 1 : 0.45;
          ctx.drawImage(img, rr.x + 4, rr.y + 3, tw, th);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = focused ? 'rgba(0,0,0,0.6)' : 'rgba(128,128,128,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(rr.x + 4.5, rr.y + 3.5, tw - 1, th - 1);
        const nx = rr.x + tw + 12;
        const dateW = spec.date?.rect.w ?? 150;
        const nameW = rr.x + rr.w - dateW - nx - 6;
        const title = row.damaged && spec.strings.damaged ? this.label(spec.strings.damaged) : row.title;
        if (name) {
          this.placedText({ ...name, rect: { x: nx, y: rr.y + 1, w: nameW, h: rr.h * 0.58 }, vAlign: 'middle' }, title, row.damaged ? '#800000' : color);
          this.text(name.font, row.detail, nx, rr.y + rr.h * 0.58, { color, scale: name.scale * 0.72, alpha: 0.85, shadow: null, maxWidth: nameW });
        }
        if (spec.date) this.placedText({ ...spec.date, rect: { x: rr.x + rr.w - dateW - 6, y: rr.y, w: dateW, h: rr.h } }, row.date, spec.date.colors[state]);
      }
      // Horizontal Rule between rows (LoadSave p27).
      if (spec.rule && i < items.length - 1) {
        ctx.fillStyle = spec.rule;
        ctx.fillRect(rr.x, rr.y + rr.h - 0.5, rr.w, 1);
      }
      this.hits.push({ index: i, rect: rr });
    }
    ctx.restore();
    // Scroll arrows.
    const bob = Math.sin(time * 6) * 1.5;
    const up = spec.arrows?.up, down = spec.arrows?.down;
    if (scroll > 0 && up) this.drawImage({ ...up, rect: { x: L.x + L.w - 22, y: L.y + 4 - bob, w: 16, h: 16 } });
    if (scroll + visible < items.length && down) this.drawImage({ ...down, rect: { x: L.x + L.w - 22, y: L.y + L.h - 20 + bob, w: 16, h: 16 } });
    for (const h of spec.hints) this.drawHint(h.place, this.label(h.label));
  }

  // ---- automatic layouts (developer tools, provisional fallback) ----

  private drawAuto(screen: MenuScreen, sel: number, time: number): void {
    const ctx = this.ctx;
    let y = 48;
    if (screen.logo) {
      const h = this.drawLogo(VW / 2, 0, 430);
      y = Math.max(y, h * 0.95);
    }
    for (const img of screen.titleImages ?? []) {
      this.drawImage(img);
      y = Math.max(y, img.rect.y + img.rect.h + 20);
    }
    if (screen.title) {
      const r = this.text('title', this.label(screen.title), VW / 2, y, { align: 'center', color: COLOR.title, scale: 1.25 });
      y += r.height + 4;
      const g = ctx.createLinearGradient(VW / 2 - 160, 0, VW / 2 + 160, 0);
      g.addColorStop(0, 'rgba(163,36,28,0)');
      g.addColorStop(0.5, 'rgba(163,36,28,0.9)');
      g.addColorStop(1, 'rgba(163,36,28,0)');
      ctx.fillStyle = g;
      ctx.fillRect(VW / 2 - 160, y, 320, 1.5);
      y += 22;
    }
    if (screen.message) {
      if (!screen.title && !screen.logo && !screen.titleImages?.length) y = 150;
      const r = this.text('ui', this.label(screen.message), VW / 2, y, { align: 'center', color: COLOR.text, maxWidth: 480 });
      y += r.height + 26;
    }
    if (!this.itemsHidden) {
      if (screen.layout === 'form') this.drawForm(screen, sel, y, time);
      else this.drawList(screen, sel, y, time);
    }
    if (screen.footer) this.text('ui', this.label(screen.footer), VW / 2, VH - 34, { align: 'center', color: COLOR.dim, scale: 0.8 });
  }

  private drawList(screen: MenuScreen, sel: number, y: number, time: number): void {
    const which = screen.font ?? 'title';
    const scale = which === 'title' ? 1.25 : 1;
    const lh = (this.font(which)?.lineHeight ?? 28) * scale * 1.15;
    screen.items.forEach((item, i) => {
      const selected = i === sel;
      const disabled = isDisabled(item);
      const r = this.text(which, this.label(item.label), VW / 2, y, {
        align: 'center',
        scale,
        color: disabled ? COLOR.disabled : selected ? COLOR.itemHi : COLOR.item,
        glow: selected ? COLOR.glow : undefined,
      });
      if (selected) this.drawArrows(VW / 2 - r.width / 2 - 14, VW / 2 + r.width / 2 + 14, y + r.height / 2, time);
      const hw = Math.max(r.width + 40, 200);
      this.hits.push({ index: i, rect: { x: VW / 2 - hw / 2, y: y - 2, w: hw, h: lh } });
      y += lh;
    });
  }

  private drawForm(screen: MenuScreen, sel: number, y: number, time: number): void {
    const ctx = this.ctx;
    const lh = Math.round((this.font('ui')?.lineHeight ?? 22) * 1.45);
    const lx = 96;
    const vx = 360;
    const vw = 184;
    screen.items.forEach((item, i) => {
      const selected = i === sel;
      const color = selected ? COLOR.itemHi : COLOR.item;
      const label = this.label(item.label);
      if (item.type === 'button') {
        const r = this.text('ui', label, VW / 2, y + 2, { align: 'center', color, glow: selected ? COLOR.glow : undefined });
        this.hits.push({ index: i, rect: { x: VW / 2 - r.width / 2 - 20, y: y - 3, w: r.width + 40, h: lh } });
      } else {
        this.text('ui', label, lx, y + 2, { color, glow: selected ? COLOR.glow : undefined });
        const cy = y + 2 + (this.font('ui')?.lineHeight ?? 22) / 2;
        if (item.type === 'slider') {
          const v = Number(getSetting(this.settings, item.setting) ?? item.min);
          const f = (v - item.min) / (item.max - item.min);
          ctx.fillStyle = 'rgba(255,255,255,0.1)';
          ctx.fillRect(vx, cy - 4, vw, 8);
          ctx.fillStyle = selected ? '#d8432f' : '#8e2a20';
          ctx.fillRect(vx, cy - 4, vw * f, 8);
        } else {
          const c = item.choices[this.choiceIndex(item)];
          this.text('ui', this.label(c?.label), vx + vw / 2, y + 2, { align: 'center', color });
        }
        if (selected) this.drawArrows(vx - 8, vx + vw + 8, cy, time);
        this.hits.push({ index: i, rect: { x: lx - 20, y: y - 3, w: vx + vw + 40 - lx, h: lh }, value: { x: vx, y: y - 3, w: vw, h: lh } });
      }
      y += lh;
    });
  }

  private drawDialog(screen: MenuScreen, sel: number, time: number): void {
    const ctx = this.ctx;
    const box = { x: 160, y: 150, w: 320, h: 180 };
    ctx.fillStyle = 'rgba(0,0,0,0.88)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = 'rgba(150,140,120,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    ctx.strokeStyle = 'rgba(150,140,120,0.25)';
    ctx.strokeRect(box.x + 4.5, box.y + 4.5, box.w - 9, box.h - 9);
    if (screen.message) this.text('ui', this.label(screen.message), VW / 2, box.y + 34, { align: 'center', color: COLOR.text, maxWidth: box.w - 48 });
    const n = screen.items.length;
    const slot = box.w / Math.max(1, n);
    screen.items.forEach((item, i) => {
      const selected = i === sel;
      const cx = box.x + slot * (i + 0.5);
      const y = box.y + box.h - 58;
      const r = this.text('title', this.label(item.label), cx, y, {
        align: 'center',
        color: selected ? COLOR.itemHi : COLOR.item,
        glow: selected ? COLOR.glow : undefined,
      });
      if (selected) this.drawArrows(cx - r.width / 2 - 12, cx + r.width / 2 + 12, y + r.height / 2, time);
      this.hits.push({ index: i, rect: { x: cx - slot / 2 + 8, y: y - 6, w: slot - 16, h: r.height + 12 } });
    });
  }

  /** Word-wrapped text inside a placed widget's rect (alignment from the widget). */
  private wrapText(p: Placed, s: string, color: string, alpha = 1): void {
    const f = this.font(p.font);
    const m = p.margins ?? { top: 0, bottom: 0, left: 0, right: 0 };
    const w = p.rect.w - m.left - m.right;
    const lines: string[] = [];
    for (const para of s.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? `${line} ${word}` : word;
        if (line && (f ? f.measure(t) * p.scale : t.length * 8) > w) {
          lines.push(line);
          line = word;
        } else line = t;
      }
      lines.push(line);
    }
    this.placedText(p, lines.join('\n'), color, { alpha });
  }

  /** Render size at a resolution scale (Graphics "Resolution" value text). */
  private resolutionText(scale: number): string {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = document.getElementById('viewport');
    const w = Math.round((vp?.clientWidth || window.innerWidth) * dpr * scale);
    const h = Math.round((vp?.clientHeight || window.innerHeight) * dpr * scale);
    return `${w} x ${h}`;
  }

  /** Alert Box (game layout): panel, nine-slice border, message, button row. */
  private drawAlert(screen: MenuScreen, sel: number, time: number): void {
    const a = screen.alert!;
    const ctx = this.ctx;
    ctx.fillStyle = a.background;
    ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
    if (a.border) this.drawBorder(a.border, a.rect);
    // The message uses the focused colour: the normal one (#404040) is meant for disabled
    // buttons and is barely visible on the black panel [guess].
    if (screen.message) this.wrapText(a.message, this.label(screen.message), a.message.colors.focused);
    const n = screen.items.length;
    const bw = a.button.rect.w;
    const gap = n > 1 ? Math.min(24, (a.rect.w - n * bw) / (n + 1)) : 0;
    const total = n * bw + (n - 1) * gap;
    screen.items.forEach((item, i) => {
      const focused = i === sel;
      const r = { ...a.button.rect, x: a.rect.x + (a.rect.w - total) / 2 + i * (bw + gap) };
      const flicker = focused ? 0.9 + 0.1 * Math.sin(time * 9) * Math.sin(time * 2.3) : 1;
      this.placedText({ ...a.button, rect: r }, this.label(item.label), a.button.colors[focused ? 'focused' : 'normal'], {
        glow: focused ? 'rgba(255,240,210,0.45)' : undefined,
        alpha: flicker,
      });
      this.hits.push({ index: i, rect: r });
    });
  }

  /** Services lent to a custom screen. */
  private customUi(entry: StackEntry): CustomUi {
    const fe = this;
    return {
      get ctx() {
        return fe.ctx;
      },
      get age() {
        return (performance.now() - entry.openedAt) / 1000;
      },
      label: (l) => this.label(l),
      text: (f, str, x, y, o) => this.text(f, str, x, y, o),
      placedText: (p, str, color, o) => this.placedText(p, str, color, o),
      lineHeight: (f) => this.font(f)?.lineHeight ?? 20,
      measure: (f, str) => this.font(f)?.measure(str) ?? str.length * 8,
      image: (id) => this.assets?.images.get(id),
      drawImage: (img, alpha) => this.drawImage(img, alpha),
      drawBorder: (b, r) => this.drawBorder(b, r),
      loadImages: (ids) => this.assets?.loadImages(ids) ?? Promise.resolve(),
      sound: (k) => this.sound(k),
      close: (silent) => {
        if (this.stack[this.stack.length - 1] !== entry) return;
        if (!silent) this.sound('back');
        if (this.stack.length > 1) this.pop();
        else this.host.action({ kind: 'resume' });
      },
      action: (a) => this.host.action(a),
      push: (id) => this.pushScreen(id),
      hit: (index, r) => this.hits.push({ index, rect: r }),
    };
  }

  private drawArrows(xl: number, xr: number, cy: number, time: number, sz = 14): void {
    const ctx = this.ctx;
    const right = this.model.images.arrowRight !== undefined ? this.assets?.images.get(this.model.images.arrowRight) : undefined;
    const left = this.model.images.arrowLeft !== undefined ? this.assets?.images.get(this.model.images.arrowLeft) : undefined;
    const bob = Math.sin(time * 6) * 1.5;
    if (right && left) {
      ctx.drawImage(right, xl - sz + bob, cy - sz / 2, sz, sz);
      ctx.drawImage(left, xr - bob, cy - sz / 2, sz, sz);
    } else {
      ctx.fillStyle = COLOR.glow;
      ctx.fillRect(xl - 8 + bob, cy - 2, 6, 4);
      ctx.fillRect(xr + 2 - bob, cy - 2, 6, 4);
    }
  }
}

function isDisabled(item: MenuItem | undefined): boolean {
  return !item || (item.type === 'button' && !!item.disabled);
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
