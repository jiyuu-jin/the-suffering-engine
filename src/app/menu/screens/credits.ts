// Credits roll (UIP 15, GUI Credits #535; docs/frontend.md §8 "Credits").
//
// Data: p15 video (5:32, looped behind the text, with its music bed 5:72 paired by the
// cutscene library), p17 the credits text: an Interface .wdu entry holding UTF-16 tab-separated
// rows with four columns (company, department, title, names; the first row names the columns).
// p18 has one text style per column (font, glyph scale, colour); the style's rect height is
// used as the line pitch, its vertical alignment places the text in that pitch. Empty rows are
// spacing (one name pitch). p20 is the scroll speed (virtual px / s) [guess]; p19 / p21 / p22
// are not decoded. Long name lists word-wrap. Esc / Enter / click close; Up / Down change
// the speed (engine addition). The roll returns on its own after the last line.

import type { GameFS } from '../../gamefs';
import { readSrscSubset } from '../assets';
import type { CreditsSpec, CustomScreen, CustomUi, NavInput, Placed } from '../model';

/** Credits text rows: [column, text] (column -1 = blank row). */
export type CreditsRow = { col: number; text: string }[];

/** .wdu data entry type of the credits text. */
const WDU_DATA = 0x60;

export async function loadCreditsText(fs: GameFS, base: string, entry: number): Promise<CreditsRow[]> {
  const path = await fs.resolve(`${base}.wdu`);
  if (!path) return [];
  const f = await readSrscSubset(fs, path, (e) => e.type === WDU_DATA && e.id === entry);
  const e = f.entries[0];
  if (!e) return [];
  const bytes = new Uint8Array(f.data(e).buffer, f.data(e).byteOffset, e.size);
  // Header (5 x u32; the last is the text byte length), then a UTF-16LE BOM.
  let start = 0;
  for (let i = 0; i + 1 < Math.min(bytes.length, 64); i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xfe) {
      start = i + 2;
      break;
    }
  }
  const text = new TextDecoder('utf-16le').decode(bytes.subarray(start, start + ((bytes.length - start) & ~1)));
  return parseCredits(text);
}

/** Parses the tab-separated credits (first row = column names, skipped). */
export function parseCredits(text: string): CreditsRow[] {
  const lines = text.replace(/\0+$/, '').split(/\r?\n/);
  const rows: CreditsRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t').map((c) => c.trim().replace(/^"|"$/g, '').trim());
    const row: CreditsRow = [];
    cells.forEach((c, i) => {
      if (c && i < 4) row.push({ col: i, text: c });
    });
    rows.push(row);
  }
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}

export interface CreditsHost {
  fs: GameFS;
  base: string;
  /** Starts / stops the looping credits video with its music (absent without media). */
  startVideo?(): void;
  stopVideo?(): void;
}

interface Line {
  y: number;
  h: number;
  style: Placed;
  text: string;
}

export class CreditsScreen implements CustomScreen {
  /** The credits video fills the screen (no menu dim on top of it). */
  readonly opaque = true;
  private rows: CreditsRow[] | null = null;
  private lines: Line[] = [];
  private total = 0;
  private offset = 0;
  private last = 0;
  private speedMul = 1;
  private finished = false;

  constructor(
    private readonly spec: CreditsSpec,
    private readonly host: CreditsHost,
  ) {}

  open(): void {
    this.offset = 0;
    this.last = performance.now();
    this.finished = false;
    this.speedMul = 1;
    this.lines = [];
    this.host.startVideo?.();
    if (!this.rows && this.spec.textEntry !== undefined) {
      void loadCreditsText(this.host.fs, this.host.base, this.spec.textEntry)
        .then((r) => (this.rows = r))
        .catch((err) => {
          console.warn('[menu] credits text unavailable:', err);
          this.rows = [];
        });
    }
  }

  close(): void {
    this.host.stopVideo?.();
  }

  /** Lays the rows out once the fonts are known (word wrap needs them). */
  private layout(ui: CustomUi): void {
    const rows = this.rows ?? [];
    const st = this.spec.styles;
    const style = (c: number) => st[Math.min(c, st.length - 1)];
    const lines: Line[] = [];
    let y = 0;
    const blank = style(3).rect.h * 0.6;
    for (const row of rows) {
      if (!row.length) {
        y += blank;
        continue;
      }
      for (const cell of row) {
        const s = style(cell.col);
        const maxW = 600;
        const words = cell.text.split(/\s+/);
        let cur = '';
        const out: string[] = [];
        for (const w of words) {
          const t = cur ? `${cur} ${w}` : w;
          if (cur && ui.measure(s.font, t) * s.scale > maxW) {
            out.push(cur);
            cur = w;
          } else cur = t;
        }
        if (cur) out.push(cur);
        out.forEach((t, k) => {
          // Wrapped continuation lines only take a text line, not the style's full pitch.
          const h = k === 0 ? s.rect.h : ui.lineHeight(s.font) * s.scale * 1.1;
          lines.push({ y, h, style: s, text: t });
          y += h;
        });
      }
    }
    this.lines = lines;
    this.total = y;
  }

  nav(_ui: CustomUi, a: NavInput): boolean {
    if (a === 'up' || a === 'down') {
      this.speedMul = Math.max(0.25, Math.min(6, this.speedMul * (a === 'down' ? 1.5 : 1 / 1.5)));
      return true;
    }
    return false; // Esc closes
  }

  click(ui: CustomUi): void {
    ui.close();
  }

  draw(ui: CustomUi): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.rows && !this.lines.length && this.rows.length) this.layout(ui);
    const ctx = ui.ctx;
    // Darken the video a little behind the text.
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(-2000, -2000, 4640, 4480);
    if (!this.lines.length) return;
    this.offset += dt * (this.spec.speed || 50) * this.speedMul;
    const top = 480 - this.offset;
    for (const l of this.lines) {
      const y = top + l.y;
      if (y > 480 || y + l.h < 0) continue;
      // Fade near the top and bottom edges.
      const mid = y + l.h / 2;
      const a = Math.max(0, Math.min(1, Math.min(mid / 60, (480 - mid) / 60)));
      ui.placedText({ ...l.style, rect: { x: 0, y, w: 640, h: l.h }, margins: undefined }, l.text, l.style.colors.normal, { alpha: a });
    }
    if (!this.finished && top + this.total < -20) {
      this.finished = true;
      ui.close(true);
    }
  }
}
