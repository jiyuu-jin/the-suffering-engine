// Bitmap-font text on a 2D canvas, using the game's .fdu fonts and their
// glyph atlases. Atlases are white with coverage in alpha, so each colour gets
// a tinted copy of the atlas (cached) and glyphs are blitted with drawImage.

import { layoutText, measureText, type Font, type FontAtlas } from '../../formats/font';

export interface DrawTextOptions {
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Uniform scale (1 = the font's native pixel size in virtual units). */
  scale?: number;
  alpha?: number;
  /** Drop shadow colour (offset 1 virtual px); null disables. */
  shadow?: string | null;
  /** Soft glow colour drawn behind the text. */
  glow?: string;
  maxWidth?: number;
}

const SUBSTITUTES: Record<string, string> = {
  '\u2026': '...',
  '\u2014': '-',
  '\u2013': '-',
  '\u00b7': '-',
  '\u2192': '->',
  '\u2190': '<-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2713': '+',
  '\u2717': 'x',
};

export class BitmapFont {
  private readonly pages: HTMLCanvasElement[];
  private readonly tinted = new Map<string, HTMLCanvasElement[]>();

  constructor(
    readonly font: Font,
    atlases: FontAtlas[],
  ) {
    this.pages = atlases.map((a) => {
      const c = document.createElement('canvas');
      c.width = a.width;
      c.height = a.height;
      const g = c.getContext('2d')!;
      const img = g.createImageData(a.width, a.height);
      // Keep only coverage (the RGB of the atlas is white).
      for (let i = 0; i < a.rgba.length; i += 4) {
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = a.rgba[i + 3];
      }
      g.putImageData(img, 0, 0);
      return c;
    });
  }

  get lineHeight(): number {
    return this.font.lineHeight;
  }

  /** Replaces typographic characters the font lacks with ASCII equivalents. */
  sanitize(text: string): string {
    if (/^[\x20-\x7e\n]*$/.test(text)) return text;
    const g = this.font.glyphs;
    return text.replace(/[^\x20-\x7e\n]/g, (c) => {
      if (g.has(c.charCodeAt(0))) return c;
      return SUBSTITUTES[c] ?? '?';
    });
  }

  measure(text: string): number {
    text = this.sanitize(text);
    let w = 0;
    for (const line of text.split('\n')) w = Math.max(w, measureText(this.font, line));
    return w;
  }

  /**
   * Atlas pages tinted with `color`. `solid` drops faint coverage (the DXT5
   * alpha of the decorative font has low-level noise around glyphs, which
   * shows up as smudges when drawn in black as a drop shadow).
   */
  private pagesFor(color: string, solid = false): HTMLCanvasElement[] {
    const key = solid ? `${color}|solid` : color;
    let p = this.tinted.get(key);
    if (!p) {
      p = this.pages.map((src) => {
        const c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        const g = c.getContext('2d')!;
        g.drawImage(src, 0, 0);
        if (solid) {
          const img = g.getImageData(0, 0, c.width, c.height);
          for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] < 112 ? 0 : img.data[i];
          g.putImageData(img, 0, 0);
        }
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = color;
        g.fillRect(0, 0, c.width, c.height);
        return c;
      });
      this.tinted.set(key, p);
    }
    return p;
  }

  private readonly rendered = new Map<string, HTMLCanvasElement>();

  /**
   * Text rasterised at the font's native size (integer glyph positions, no
   * filtering, so neighbouring atlas cells never bleed in). Cached per text/colour.
   */
  private raster(text: string, color: string, align: 'left' | 'center' | 'right', maxWidth?: number, solid = false): HTMLCanvasElement {
    const key = `${color}|${solid ? 1 : 0}|${align}|${maxWidth ?? 0}|${text}`;
    let c = this.rendered.get(key);
    if (c) {
      // LRU touch
      this.rendered.delete(key);
      this.rendered.set(key, c);
      return c;
    }
    const lay = layoutText(this.font, text, { align, maxWidth });
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(lay.width));
    c.height = Math.max(1, Math.ceil(lay.height));
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const pages = this.pagesFor(color, solid);
    for (const pg of lay.glyphs) {
      const gl = pg.glyph;
      const img = pages[gl.page];
      if (img) g.drawImage(img, gl.x, gl.y, gl.width, gl.height, pg.x, pg.y, gl.width, gl.height);
    }
    this.rendered.set(key, c);
    if (this.rendered.size > 300) this.rendered.delete(this.rendered.keys().next().value!);
    return c;
  }

  /**
   * Draws text with its top-left (or top-center/right for other alignments)
   * at (x, y) in the current canvas transform. Returns the drawn size.
   */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: DrawTextOptions = {}): { width: number; height: number } {
    const scale = o.scale ?? 1;
    text = this.sanitize(text);
    const align = o.align ?? 'left';
    const maxWidth = o.maxWidth ? Math.floor(o.maxWidth / scale) : undefined;
    const main = this.raster(text, o.color ?? '#fff', align, maxWidth);
    const w = main.width * scale;
    const h = main.height * scale;
    const ox = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const prevAlpha = ctx.globalAlpha;
    const a = o.alpha ?? 1;
    const shadow = o.shadow === undefined ? 'rgb(0,0,0)' : o.shadow;
    if (shadow) {
      const sh = this.raster(text, shadow, align, maxWidth, true);
      ctx.globalAlpha = prevAlpha * a * 0.85;
      ctx.drawImage(sh, ox + scale, y + scale, w, h);
      ctx.globalAlpha = prevAlpha * a * 0.35;
      ctx.drawImage(sh, ox + 2 * scale, y + 2 * scale, w, h);
    }
    if (o.glow) {
      // Soft halo: canvas shadows are in device pixels, so scale the blur with the transform.
      ctx.save();
      const m = ctx.getTransform();
      ctx.shadowColor = o.glow;
      ctx.shadowBlur = 9 * scale * Math.hypot(m.a, m.b);
      ctx.globalAlpha = prevAlpha * a;
      ctx.drawImage(main, ox, y, w, h);
      ctx.drawImage(main, ox, y, w, h);
      ctx.restore();
    }
    ctx.globalAlpha = prevAlpha * a;
    ctx.drawImage(main, ox, y, w, h);
    ctx.globalAlpha = prevAlpha;
    return { width: w, height: h };
  }
}
