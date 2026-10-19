// Bitmap fonts (.fdu): SRSC entries of type 0 / group 7, one per font.
//
// Font entry layout (little endian):
//   0x00 u32  payload size (entry size - 4)
//   0x04 u32  version (1)
//   0x08 u16  0
//   0x0a u32  size of the remaining data
//   0x0e u8[8] 0
//   0x16 u32  line height (pixels)
//   0x1a u32  baseline (pixels from the top of a line)
//   0x1e u32  extra spacing between characters (unconfirmed; exposed as `tracking`)
//   0x22 u32  page count P
//   0x26 u32  0
//   0x2a P x (u16 texture id, u16 package id)  — glyph atlases, usually in Interface.tdu
//        u16  row count R
//        u8[6] 0
//        R x { u16 y, u8 height, u8 top }       — atlas rows; `top` is the row's
//                                                  offset below the line top. (Pages
//                                                  are implicit: a row whose y does
//                                                  not increase starts the next one.)
//        u8[6] (unknown, 01 00 00 00 00 00)
//        u16  glyph count G
//        G x { u16 char (UTF-16), u16 row (0xffff = not drawn, e.g. space/tab),
//              u16 x, u8 pre, u8 post (6-bit signed bearings), u8 width,
//              u8 page (atlas index, 0xff = no bitmap) }
// Atlas textures are white with coverage in alpha.

import type { SrscEntry, SrscFile } from './srsc';

export const FONT_ENTRY_TYPE = 0x00;
export const FONT_ENTRY_GROUP = 7;

export interface FontTextureRef {
  id: number;
  pkg: number;
}

export interface FontRow {
  page: number;
  y: number;
  height: number;
  /** Offset of the row's cells below the line top. */
  top: number;
}

export interface FontGlyph {
  char: number;
  /** -1 for glyphs with no bitmap (space, tab). */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Offset of the bitmap below the line top. */
  top: number;
  /** Bearing before / after the bitmap. */
  pre: number;
  post: number;
  /** Pen advance (pre + width + post). */
  advance: number;
}

export interface Font {
  key: string;
  id: number;
  pkg: number;
  lineHeight: number;
  baseline: number;
  tracking: number;
  textures: FontTextureRef[];
  rows: FontRow[];
  glyphs: Map<number, FontGlyph>;
}

const s6 = (v: number) => {
  const x = v & 0x3f;
  return x >= 32 ? x - 64 : x;
};

export function parseFont(file: SrscFile, entry: SrscEntry, pkg = 0): Font {
  const v = file.data(entry);
  const lineHeight = v.getUint32(0x16, true);
  const baseline = v.getUint32(0x1a, true);
  const tracking = v.getUint32(0x1e, true);
  const pages = v.getUint32(0x22, true);
  let p = 0x2a;
  const textures: FontTextureRef[] = [];
  for (let i = 0; i < pages; i++, p += 4) textures.push({ id: v.getUint16(p, true), pkg: v.getUint16(p + 2, true) });
  const rowCount = v.getUint16(p, true);
  p += 2 + 6;
  const rows: FontRow[] = [];
  let page = 0;
  let lastY = -1;
  for (let i = 0; i < rowCount; i++, p += 4) {
    const y = v.getUint16(p, true);
    if (i > 0 && y <= lastY) page = Math.min(page + 1, Math.max(0, pages - 1));
    lastY = y;
    rows.push({ page, y, height: v.getUint8(p + 2), top: v.getUint8(p + 3) });
  }
  p += 6;
  const count = v.getUint16(p, true);
  p += 2;
  const glyphs = new Map<number, FontGlyph>();
  for (let i = 0; i < count && p + 10 <= v.byteLength; i++, p += 10) {
    const char = v.getUint16(p, true);
    const rowIdx = v.getUint16(p + 2, true);
    const row = rows[rowIdx];
    const pre = s6(v.getUint8(p + 6));
    const post = s6(v.getUint8(p + 7));
    const width = v.getUint8(p + 8);
    const pg = v.getUint8(p + 9);
    glyphs.set(char, {
      char,
      page: pg === 0xff || !row ? -1 : pg,
      x: v.getUint16(p + 4, true),
      y: row?.y ?? 0,
      width,
      height: row?.height ?? 0,
      top: row?.top ?? 0,
      pre,
      post,
      advance: pre + width + post,
    });
  }
  return { key: `${pkg}:${entry.id}`, id: entry.id, pkg, lineHeight, baseline, tracking, textures, rows, glyphs };
}

/** All fonts of an .fdu. `pkg` is the package id from its .db (Interface = 5). */
export function readFonts(file: SrscFile, pkg = 0): Font[] {
  return file.entries
    .filter((e) => e.type === FONT_ENTRY_TYPE && e.group === FONT_ENTRY_GROUP && e.size > 0x40)
    .map((e) => parseFont(file, e, pkg));
}

export interface PlacedGlyph {
  glyph: FontGlyph;
  /** Top-left of the bitmap in pixels, relative to the text origin (top-left of the first line). */
  x: number;
  y: number;
}

export interface TextLayout {
  glyphs: PlacedGlyph[];
  width: number;
  height: number;
}

/** Glyph for a character, falling back to '?' for characters the font lacks. */
export function glyphFor(font: Font, char: number): FontGlyph | undefined {
  return font.glyphs.get(char) ?? font.glyphs.get(0x3f);
}

/** Width in pixels of a single line of text. */
export function measureText(font: Font, text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += glyphFor(font, text.charCodeAt(i))?.advance ?? 0;
  return w;
}

/**
 * Lays out text with '\n' line breaks and optional word wrapping at
 * `maxWidth`. `align` positions each line within the widest line.
 */
export function layoutText(
  font: Font,
  text: string,
  opts: { maxWidth?: number; align?: 'left' | 'center' | 'right'; lineSpacing?: number } = {},
): TextLayout {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!opts.maxWidth) {
      lines.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? line + ' ' + word : word;
      if (line && measureText(font, candidate) > opts.maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  const widths = lines.map((l) => measureText(font, l));
  const width = Math.max(0, ...widths);
  const lh = font.lineHeight + (opts.lineSpacing ?? 0);
  const glyphs: PlacedGlyph[] = [];
  lines.forEach((line, li) => {
    let x = opts.align === 'center' ? (width - widths[li]) / 2 : opts.align === 'right' ? width - widths[li] : 0;
    x = Math.round(x);
    for (let i = 0; i < line.length; i++) {
      const g = glyphFor(font, line.charCodeAt(i));
      if (!g) continue;
      if (g.page >= 0 && g.width > 0) glyphs.push({ glyph: g, x: x + g.pre, y: li * lh + g.top });
      x += g.advance;
    }
  });
  return { glyphs, width, height: lines.length * lh };
}

/** Atlas as decoded RGBA (top-down rows), one per font page. */
export interface FontAtlas {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Rasterises text into an RGBA buffer (CPU path, e.g. for a 2D canvas or a
 * texture upload). Coverage comes from the atlas alpha; `color` is RGB.
 */
export function renderText(
  font: Font,
  atlases: FontAtlas[],
  text: string,
  opts: { maxWidth?: number; align?: 'left' | 'center' | 'right'; color?: [number, number, number] } = {},
): { width: number; height: number; rgba: Uint8Array } {
  const lay = layoutText(font, text, opts);
  const W = Math.max(1, Math.ceil(lay.width));
  const H = Math.max(1, Math.ceil(lay.height));
  const out = new Uint8Array(W * H * 4);
  const [r, g, b] = opts.color ?? [255, 255, 255];
  for (const pg of lay.glyphs) {
    const a = atlases[pg.glyph.page];
    if (!a) continue;
    for (let yy = 0; yy < pg.glyph.height; yy++) {
      const dy = pg.y + yy;
      const sy = pg.glyph.y + yy;
      if (dy < 0 || dy >= H || sy >= a.height) continue;
      for (let xx = 0; xx < pg.glyph.width; xx++) {
        const dx = pg.x + xx;
        const sx = pg.glyph.x + xx;
        if (dx < 0 || dx >= W || sx >= a.width) continue;
        const cov = a.rgba[(sy * a.width + sx) * 4 + 3];
        const o = (dy * W + dx) * 4;
        if (cov > out[o + 3]) {
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = cov;
        }
      }
    }
  }
  return { width: W, height: H, rgba: out };
}
