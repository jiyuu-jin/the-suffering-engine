// Subtitle line for in-engine sequences, drawn with the game's interface font
// (COMMON/Interface/Interface.fdu, the font the menus use). Falls back to a CSS
// font when the font can't be loaded.

import type { GameFS } from '../../app/gamefs';
import { SrscFile } from '../../formats/srsc';
import { readFonts } from '../../formats/font';
import { decodeTexture, TEXTURE_ENTRY_TYPE } from '../../formats/texture';
import { readSrscSubset } from '../../app/menu/assets';
import { BitmapFont } from '../../app/menu/text';
import { measureText } from '../../formats/font';
import { GUI_H, GUI_W, SUBTITLE_BOX, SUBTITLE_CENTRE_Y, SUBTITLE_HOLD, subtitleMaxLines, subtitlePages, type SubtitlePage } from './cinema';

const INTERFACE = 'COMMON/Interface/Interface';
/** Font id of the menu's body text (MenuModel.fonts.ui default). */
const UI_FONT = 2;

let fontPromise: Promise<BitmapFont | null> | undefined;

/** CSS fallback font (no interface font): size and line height in GUI px. */
const FALLBACK_PX = 18;
const FALLBACK_LINE = 22;
let measureCtx: CanvasRenderingContext2D | null | undefined;
const fallbackWidth = (t: string): number => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return t.length * FALLBACK_PX * 0.5;
  measureCtx.font = `${FALLBACK_PX}px Georgia, serif`;
  return measureCtx.measureText(t).width;
};

/** Word-wraps `text` to `width` (the text widget's wrap: words, explicit newlines kept). */
export function wrapLines(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate) > width) {
        out.push(line);
        line = word;
      } else line = candidate;
    }
    out.push(line);
  }
  // Trailing spaces of a page join are not lines of their own.
  return out.filter((l, i) => l.trim() || i < out.length - 1);
}

/** The interface font (cached for the session). */
export function loadSubtitleFont(fs: GameFS): Promise<BitmapFont | null> {
  fontPromise ??= (async () => {
    try {
      const fdu = await fs.resolve(`${INTERFACE}.fdu`);
      const tdu = await fs.resolve(`${INTERFACE}.tdu`);
      const db = await fs.resolve(`${INTERFACE}.db`);
      if (!fdu || !tdu) return null;
      const pkg = db ? Number(/^\s*id\s+(\d+)/m.exec(new TextDecoder().decode(await fs.read(db)))?.[1] ?? 0) : 0;
      const fonts = readFonts(new SrscFile(await fs.read(fdu)), pkg);
      const font = fonts.find((f) => f.id === UI_FONT) ?? fonts[0];
      if (!font) return null;
      const ids = new Set(font.textures.map((t) => t.id));
      const tex = await readSrscSubset(fs, tdu, (e) => e.type === TEXTURE_ENTRY_TYPE && ids.has(e.id));
      const byId = new Map<number, { width: number; height: number; rgba: Uint8Array }>();
      for (const e of tex.entries) {
        const t = decodeTexture(tex, e);
        if (t) byId.set(e.id, t);
      }
      return new BitmapFont(
        font,
        font.textures.map((t) => byId.get(t.id) ?? { width: 1, height: 1, rgba: new Uint8Array(4) }),
      );
    } catch (err) {
      console.warn('[sequence] subtitle font unavailable:', err);
      return null;
    }
  })();
  return fontPromise;
}

/**
 * Subtitle box + a small skip hint, over the viewport. Laid out like the original's Subtitle
 * Textbox (cinema.ts SUBTITLE_BOX): the 640×480 GUI screen fitted into the view, the line
 * wrapped to 71 % of its width at the template's 0.9 × 0.91 font scale, shown in pages of at
 * most two lines spread over the sound (subtitlePages), white with a dark drop shadow.
 */
/**
 * Overlays alive (sequences, speech, the HUD each have one). The game has one subtitle box: a line
 * shown by one replaces the line of the others, which used to be drawn over each other (2
 * Cellblocks: the inmate's Speech Player line during the cell block's camera scene).
 */
const live = new Set<SubtitleOverlay>();

export class SubtitleOverlay {
  readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly hint = document.createElement('div');
  private lines: string[] = [];
  private pages: SubtitlePage[] = [];
  private start = 0;
  private until = 0;
  /** Page shown (-1 none); redraw when it changes. */
  private page = -1;
  private dirty = false;
  /** Text of the last show(): re-wrapped when the font arrives. */
  private text = '';
  private duration = 0;

  constructor(
    container: HTMLElement,
    private font: BitmapFont | null,
  ) {
    Object.assign(this.root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '6' });
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' });
    Object.assign(this.hint.style, {
      position: 'absolute',
      right: '14px',
      bottom: '10px',
      font: '12px/1.2 system-ui, sans-serif',
      color: 'rgba(230,220,200,.55)',
      textShadow: '0 1px 2px #000',
      display: 'none',
    });
    this.hint.textContent = 'Enter: skip';
    this.root.append(this.canvas, this.hint);
    container.append(this.root);
    live.add(this);
  }

  setFont(font: BitmapFont | null) {
    this.font = font;
    if (this.text) this.layout();
    this.dirty = true;
  }

  /** Font px per line and the wrap width in font px. */
  private metrics(): { lineHeight: number; wrap: number } {
    return { lineHeight: this.font?.lineHeight ?? FALLBACK_LINE, wrap: (SUBTITLE_BOX.textW / 100) * GUI_W / SUBTITLE_BOX.scaleX };
  }

  private layout() {
    const { lineHeight, wrap } = this.metrics();
    const text = this.font ? this.font.sanitize(this.text) : this.text;
    this.lines = this.text ? wrapLines(text, wrap, (t) => (this.font ? measureText(this.font.font, t) : fallbackWidth(t))) : [];
    this.pages = subtitlePages(this.lines.length, this.duration, subtitleMaxLines(lineHeight * SUBTITLE_BOX.scaleY));
    this.page = -1;
  }

  /**
   * Show a line spoken over `seconds` from `now` (empty string clears): paged, and the box stays
   * up until `now + seconds + 1` (SUBTITLE_HOLD).
   */
  show(text: string, now: number, seconds: number) {
    if (text) for (const o of live) if (o !== this && o.text) o.setText('', 0, 0);
    this.setText(text, now, seconds);
  }

  private setText(text: string, now: number, seconds: number) {
    this.text = text;
    this.duration = Math.max(0, seconds);
    this.start = now;
    this.until = text ? now + this.duration + SUBTITLE_HOLD : 0;
    this.layout();
    this.dirty = true;
  }

  clear() {
    this.show('', 0, 0);
  }

  set hintVisible(v: boolean) {
    this.hint.style.display = v ? '' : 'none';
  }

  update(now: number) {
    let page = -1;
    if (this.lines.length && now <= this.until) {
      for (let i = 0; i < this.pages.length; i++) if (this.pages[i].at <= now - this.start + 1e-6) page = i;
    }
    if (page !== this.page) {
      this.page = page;
      this.dirty = true;
    }
    const c = this.canvas;
    const w = Math.max(1, this.root.clientWidth), h = Math.max(1, this.root.clientHeight);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const p = this.pages[page];
    if (!p) return;
    const shown = this.lines.slice(p.first, p.first + p.count);
    // The GUI screen fitted into the view (as the HUD), then the text box's font scale.
    const s = Math.min(w / GUI_W, h / GUI_H);
    const { lineHeight } = this.metrics();
    const top = SUBTITLE_CENTRE_Y - (shown.length * lineHeight * SUBTITLE_BOX.scaleY) / 2;
    g.setTransform(s * SUBTITLE_BOX.scaleX, 0, 0, s * SUBTITLE_BOX.scaleY, (w - GUI_W * s) / 2 + (GUI_W / 2) * s, (h - GUI_H * s) / 2 + top * s);
    const color = `#${SUBTITLE_BOX.color.toString(16).padStart(6, '0')}`;
    if (this.font) {
      this.font.draw(g, shown.join('\n'), 0, 0, { align: 'center', color, shadow: '#000' });
    } else {
      g.font = `${FALLBACK_PX}px Georgia, serif`;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      shown.forEach((l, i) => {
        g.fillStyle = '#000';
        g.fillText(l, 1, i * FALLBACK_LINE + 1);
        g.fillStyle = color;
        g.fillText(l, 0, i * FALLBACK_LINE);
      });
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  dispose() {
    live.delete(this);
    this.root.remove();
  }
}
