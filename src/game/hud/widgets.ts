// HUD widget classes, decoded from their GUI templates and drawn on a 2D canvas
// in the game's 640x480 virtual space (one virtual pixel = one texel of the HUD
// atlases, which is how the templates' texel rects and sizes line up).
//
// HUD Meter (0xe35e393f) properties, as read here [strong unless noted]:
//   p23 / p24  fill colour full / low            p25  flash colour        p26  low threshold %
//   p27 / p28  stripe glow colour bottom / top [guess]
//   p32 + p33,p34  fill pattern texture + its texel origin (size = frame minus margins,
//                  or the meter rect for frameless segment strips)
//   p30  > 0 when the meter draws a fill [guess]
//   p37 + p38..41  frame texture + texel rect, stretched over the widget rect
//   p43, p44  frame margins in texels (x, y)
// HUD Ammo Meter (0xfafde2a6): p23 background HUD Texture, p24 meter at texel offset
//   (p28, p27) with p26 = capacity, p30 count text at offset (p34, p35) in a field of
//   p31 digits x p32 px, aligned by p33 (0 left, 1 centre, 2 right) [guess on p31..33].
// Simple Text HUD (0x77d5366f): p16 display seconds, p23 its Simple Text GUI.
// Shared HUD block p15..22 on meters [guess from the values]: the element fades to
// p21 % opacity when its value changes (in p16 s), holds p18 s, then fades to its idle
// opacity p20 % over p19 s. Health idles at -10 % (hidden), insanity and the flashlight at
// 5 %, the weapon ammo panels at 101 % (always shown). This is why the flashlight meter and
// the ammo panels can share the bottom-right corner.

import type { GuiNode, Rect, RefKey, TextWidget } from '../../formats/gui';
import { GUI_VIRTUAL_HEIGHT, GUI_VIRTUAL_WIDTH, imageWidget, resolveRect, textWidget } from '../../formats/gui';
import { layoutText } from '../../formats/font';
import type { BitmapFont } from '../../app/menu/text';

export const VW = GUI_VIRTUAL_WIDTH;
export const VH = GUI_VIRTUAL_HEIGHT;
const SCREEN: Rect = { x: 0, y: 0, w: VW, h: VH };

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
export const css = (c: number, a = 1) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
const kid = (n: GuiNode | undefined, name: string): GuiNode | undefined => {
  const c = n?.children[name];
  return Array.isArray(c) ? c[0] : c;
};

export function rectOf(n: GuiNode | undefined, parent: Rect = SCREEN): Rect | undefined {
  return n?.layout ? resolveRect(n.layout, parent, { width: VW, height: VH }) : undefined;
}

// ---------------------------------------------------------------------------
// Definitions

/** Change-driven visibility (HUD block p16..21). */
export interface HudFade {
  fadeIn: number;
  hold: number;
  fadeOut: number;
  idle: number;
  active: number;
}

export function hudFade(n: GuiNode | undefined): HudFade {
  const p = n?.props ?? {};
  const pct = (v: unknown, d: number) => Math.max(0, Math.min(1, num(v, d) / 100));
  // The hold is floored at 2 s so a change stays readable (engine value unknown).
  return { fadeIn: num(p.p16, 0.01), hold: Math.max(2, num(p.p18, 1)), fadeOut: num(p.p19, 0.5), idle: pct(p.p20, 100), active: pct(p.p21, 100) };
}

/** Opacity `age` seconds after the last change. */
export function fadeAlpha(f: HudFade, age: number): number {
  if (age < 0) return f.idle;
  if (age < f.fadeIn) return f.idle + (f.active - f.idle) * (age / Math.max(1e-3, f.fadeIn));
  const t = age - f.fadeIn - f.hold;
  if (t <= 0) return f.active;
  if (t >= f.fadeOut) return f.idle;
  return f.active + (f.idle - f.active) * (t / Math.max(1e-3, f.fadeOut));
}

export interface MeterDef {
  rect: Rect;
  fade: HudFade;
  frame?: { tex: RefKey; uv: Rect };
  fill?: { tex: RefKey; x: number; y: number };
  margin: { x: number; y: number };
  drawsFill: boolean;
  full: number;
  low: number;
  flash: number;
  lowFrac: number;
  glowLo: number;
  glowHi: number;
  vertical: boolean;
}

export function meterDef(n: GuiNode | undefined): MeterDef | undefined {
  const rect = rectOf(n);
  if (!n || !rect) return undefined;
  const p = n.props;
  const frameTex = str(p.p37);
  const fillTex = str(p.p32);
  return {
    rect,
    fade: hudFade(n),
    frame: frameTex ? { tex: frameTex, uv: { x: num(p.p38), y: num(p.p39), w: num(p.p40), h: num(p.p41) } } : undefined,
    fill: fillTex ? { tex: fillTex, x: num(p.p33), y: num(p.p34) } : undefined,
    margin: { x: num(p.p43), y: num(p.p44) },
    drawsFill: num(p.p30) > 0,
    full: num(p.p23, 0xffffff),
    low: num(p.p24, num(p.p23, 0xffffff)),
    flash: num(p.p25, 0xffff00),
    lowFrac: num(p.p26, 20) / 100,
    glowLo: num(p.p27, 0),
    glowHi: num(p.p28, num(p.p27, 0)),
    vertical: rect.h > rect.w,
  };
}

export interface TextDef {
  widget: TextWidget;
  rect: Rect;
  /** Display seconds of the owning Simple Text HUD (p16). */
  hold: number;
}

/** A Simple Text HUD (or a bare Simple Text GUI) placed in `parent`. */
export function textDef(n: GuiNode | undefined, parent: Rect = SCREEN): TextDef | undefined {
  if (!n) return undefined;
  const inner = textWidget(n) ? n : kid(n, 'p23');
  const w = textWidget(inner);
  const outer = rectOf(n, parent);
  if (!w || !outer) return undefined;
  const rect = inner === n ? outer : resolveRect(w.layout, outer, { width: VW, height: VH });
  return { widget: w, rect, hold: inner === n ? 5 : num(n.props.p16, 5) };
}

export interface AmmoMeterDef {
  fade: HudFade;
  /** Top-left of the group (virtual px). */
  x: number;
  y: number;
  background?: { tex: RefKey; uv?: Rect };
  meter?: MeterDef;
  meterAt: { x: number; y: number };
  capacity: number;
  text?: { widget: TextWidget; at: { x: number; y: number }; w: number; h: number; align: 'left' | 'center' | 'right' };
}

export function ammoMeterDef(n: GuiNode | undefined): AmmoMeterDef | undefined {
  const l = n?.layout;
  if (!n || !l) return undefined;
  const p = n.props;
  const x = (l.x * VW) / 100;
  const y = (l.y * VH) / 100;
  const bg = imageWidget(kid(n, 'p23'));
  const meter = meterDef(kid(n, 'p24'));
  const tw = textWidget(kid(n, 'p30'));
  return {
    fade: hudFade(n),
    x,
    y,
    background: bg?.texture ? { tex: bg.texture, uv: bg.uv.w > 0 && bg.uv.h > 0 ? bg.uv : undefined } : undefined,
    meter,
    meterAt: { x: num(p.p28), y: num(p.p27) },
    capacity: Math.max(1, num(p.p26, 1)),
    text: tw
      ? {
          widget: tw,
          at: { x: num(p.p34), y: num(p.p35) },
          w: num(p.p31) > 0 && num(p.p32) > 0 ? num(p.p31) * num(p.p32) : (tw.layout.w * VW) / 100,
          h: (tw.layout.h * VH) / 100,
          align: (['left', 'center', 'right'] as const)[num(p.p33)] ?? tw.hTextAlign,
        }
      : undefined,
  };
}

export interface ImageDef {
  tex: RefKey;
  uv?: Rect;
  rect: Rect;
}

/** HUD Texture; a 0x0 layout size means the source rect's own size. */
export function imageDef(n: GuiNode | undefined): ImageDef | undefined {
  const w = imageWidget(n);
  if (!w?.texture) return undefined;
  const uv = w.uv.w > 0 && w.uv.h > 0 ? w.uv : undefined;
  const l = w.layout;
  const sized = l.w > 0 && l.h > 0 ? l : { ...l, w: ((uv?.w ?? 32) * 100) / VW, h: ((uv?.h ?? 32) * 100) / VH };
  return { tex: w.texture, uv, rect: resolveRect(sized, SCREEN, { width: VW, height: VH }) };
}

// ---------------------------------------------------------------------------
// Drawing

export interface Painter {
  g: CanvasRenderingContext2D;
  font: BitmapFont | null;
  texture(key: RefKey | undefined): HTMLCanvasElement | undefined;
}

const tintCache = new Map<string, HTMLCanvasElement>();

/** A texel rect of `src` recoloured to `color` (alpha kept), cached. */
function tinted(src: HTMLCanvasElement, key: string, uv: Rect, color: string): HTMLCanvasElement {
  const k = `${key}|${uv.x},${uv.y},${uv.w},${uv.h}|${color}`;
  let c = tintCache.get(k);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(uv.w));
    c.height = Math.max(1, Math.round(uv.h));
    const g = c.getContext('2d')!;
    g.drawImage(src, uv.x, uv.y, uv.w, uv.h, 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    tintCache.set(k, c);
    if (tintCache.size > 200) tintCache.delete(tintCache.keys().next().value!);
  }
  return c;
}

export function drawImage(p: Painter, key: RefKey | undefined, uv: Rect | undefined, dst: Rect, alpha = 1, tint?: string): void {
  const src = p.texture(key);
  if (!src || alpha <= 0) return;
  const u = uv ?? { x: 0, y: 0, w: src.width, h: src.height };
  const g = p.g;
  const a = g.globalAlpha;
  g.globalAlpha = a * alpha;
  if (tint) g.drawImage(tinted(src, key!, u, tint), dst.x, dst.y, dst.w, dst.h);
  else g.drawImage(src, u.x, u.y, u.w, u.h, dst.x, dst.y, dst.w, dst.h);
  g.globalAlpha = a;
}

const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

export interface MeterState {
  /** 0..1 */
  value: number;
  /** 0..1 strength of the flash colour (damage, full insanity). */
  flash?: number;
  /** Seconds, for the low-value pulse. */
  time: number;
  alpha?: number;
  /** Draw at a different place (ammo meter children). */
  at?: { x: number; y: number };
}

export function drawMeter(p: Painter, m: MeterDef, s: MeterState): void {
  const g = p.g;
  const r = s.at ? { ...m.rect, x: s.at.x, y: s.at.y } : m.rect;
  const alpha = s.alpha ?? 1;
  const f = Math.max(0, Math.min(1, s.value));
  // Inner area: the frame's margins scaled with the frame.
  let inner = r;
  let src: Rect | undefined;
  if (m.frame && m.frame.uv.w > 0 && m.frame.uv.h > 0) {
    const sx = r.w / m.frame.uv.w;
    const sy = r.h / m.frame.uv.h;
    inner = { x: r.x + m.margin.x * sx, y: r.y + m.margin.y * sy, w: r.w - 2 * m.margin.x * sx, h: r.h - 2 * m.margin.y * sy };
    if (m.fill) src = { x: m.fill.x, y: m.fill.y, w: m.frame.uv.w - 2 * m.margin.x, h: m.frame.uv.h - 2 * m.margin.y };
    drawImage(p, m.frame.tex, m.frame.uv, r, alpha);
  } else if (m.fill) src = { x: m.fill.x, y: m.fill.y, w: Math.round(r.w), h: Math.round(r.h) };
  if (!m.drawsFill || f <= 0) return;

  const low = f <= m.lowFrac + 1e-6;
  let color = low ? m.low : m.full;
  if (low) color = mix(color, m.flash, 0.5 + 0.5 * Math.sin(s.time * 9));
  if (s.flash) color = mix(color, m.flash, Math.min(1, s.flash));

  // Filled part (bottom-up for vertical meters, left-to-right otherwise).
  const part = m.vertical
    ? { x: inner.x, y: inner.y + inner.h * (1 - f), w: inner.w, h: inner.h * f }
    : { x: inner.x, y: inner.y, w: inner.w * f, h: inner.h };
  const srcPart = src
    ? m.vertical
      ? { x: src.x, y: src.y + src.h * (1 - f), w: src.w, h: src.h * f }
      : { x: src.x, y: src.y, w: src.w * f, h: src.h }
    : undefined;
  const a0 = g.globalAlpha;
  if (m.frame) {
    // Gauges: solid colour plus the scanline pattern lit on top.
    g.globalAlpha = a0 * alpha * 0.8;
    g.fillStyle = css(color);
    g.fillRect(part.x, part.y, part.w, part.h);
    g.globalAlpha = a0;
    if (srcPart && srcPart.h > 0.5 && srcPart.w > 0.5) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      const glow = mix(m.glowLo, m.glowHi, 0.5);
      drawImage(p, m.fill!.tex, srcPart, part, alpha, css(glow || 0xffffff));
      g.restore();
    }
  } else if (srcPart && srcPart.w > 0.5) {
    // Segment strips (clip rounds): the atlas art, red when low.
    drawImage(p, m.fill!.tex, srcPart, part, alpha, low ? css(m.low) : undefined);
  } else {
    g.globalAlpha = a0 * alpha;
    g.fillStyle = css(color);
    g.fillRect(part.x, part.y, part.w, part.h);
    g.globalAlpha = a0;
  }
}

export interface TextOptions {
  alpha?: number;
  color?: string;
  /** Overrides the widget's horizontal alignment. */
  align?: 'left' | 'center' | 'right';
  shadow?: string | null;
}

/** Draws `text` in a Simple Text GUI's rect with its font scale, alignment and colour. */
export function drawText(p: Painter, w: TextWidget, rect: Rect, text: string, o: TextOptions = {}): Rect {
  const g = p.g;
  const scale = w.scale[0] || 1;
  const align = o.align ?? w.hTextAlign;
  const color = o.color ?? css(w.colors.normal);
  const alpha = o.alpha ?? 1;
  const r = {
    x: rect.x + (w.margins.left * VW) / 100,
    y: rect.y + (w.margins.top * VH) / 100,
    w: rect.w - ((w.margins.left + w.margins.right) * VW) / 100,
    h: rect.h - ((w.margins.top + w.margins.bottom) * VH) / 100,
  };
  const font = p.font;
  if (font) {
    const s = font.sanitize(text);
    const lay = layoutText(font.font, s, { maxWidth: Math.max(8, r.w / scale), align });
    const h = lay.height * scale;
    const y = w.vTextAlign === 'top' ? r.y : w.vTextAlign === 'bottom' ? r.y + r.h - h : r.y + (r.h - h) / 2;
    const x = align === 'left' ? r.x : align === 'right' ? r.x + r.w : r.x + r.w / 2;
    const d = font.draw(g, s, x, y, { align, scale, color, alpha, maxWidth: r.w, shadow: o.shadow });
    const x0 = align === 'left' ? x : align === 'right' ? x - d.width : x - d.width / 2;
    return { x: x0, y, w: d.width, h: d.height };
  }
  // Fallback: canvas text when the interface font is unavailable.
  const px = 14 * scale;
  g.save();
  g.globalAlpha *= alpha;
  g.font = `600 ${px}px system-ui, sans-serif`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'top';
  const lines = text.split('\n');
  const h = lines.length * px * 1.2;
  const y = w.vTextAlign === 'top' ? r.y : w.vTextAlign === 'bottom' ? r.y + r.h - h : r.y + (r.h - h) / 2;
  const x = align === 'left' ? r.x : align === 'right' ? r.x + r.w : r.x + r.w / 2;
  let wmax = 0;
  lines.forEach((l, i) => {
    g.shadowColor = 'black';
    g.shadowOffsetX = g.shadowOffsetY = 1;
    g.fillText(l, x, y + i * px * 1.2, r.w);
    wmax = Math.max(wmax, g.measureText(l).width);
  });
  g.restore();
  return { x: align === 'left' ? x : align === 'right' ? x - wmax : x - wmax / 2, y, w: wmax, h };
}

/** Line height of a text widget in virtual px. */
export function lineHeight(p: Painter, w: TextWidget): number {
  return (p.font?.lineHeight ?? 17) * (w.scale[1] || w.scale[0] || 1);
}

export function drawAmmoMeter(p: Painter, d: AmmoMeterDef, value: number, count: string | undefined, time: number, alpha = 1): void {
  if (d.background) {
    const src = p.texture(d.background.tex);
    const uv = d.background.uv ?? (src ? { x: 0, y: 0, w: src.width, h: src.height } : undefined);
    if (uv) drawImage(p, d.background.tex, uv, { x: d.x, y: d.y, w: uv.w, h: uv.h }, alpha);
  }
  if (d.meter) drawMeter(p, d.meter, { value: value / d.capacity, time, alpha, at: { x: d.x + d.meterAt.x, y: d.y + d.meterAt.y } });
  if (d.text && count !== undefined) {
    drawText(p, d.text.widget, { x: d.x + d.text.at.x, y: d.y + d.text.at.y, w: d.text.w, h: d.text.h }, count, { alpha, align: d.text.align });
  }
}
