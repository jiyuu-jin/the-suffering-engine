// Gamepad button glyphs drawn with Canvas 2D: plain geometric shapes and system-font letters
// made here (no controller artwork or vendor fonts). Used by the HUD prompts, the death
// prompt, the keyboard / controller pages and the save-list hints whenever a pad is the
// last-used device (src/app/gamepad.ts `pads.usingPad`).
//
//   face buttons   a dark disc with the family's mark: Xbox-style letters A / B / X / Y,
//                  PlayStation-style cross / ring / square / triangle outlines, Nintendo-style
//                  letters B / A / Y / X (positional: bottom = B)
//   bumpers        a wide rounded bar (LB / RB, L1 / R1, L / R)
//   triggers       a bar rounded on top (LT / RT, L2 / R2, ZL / ZR)
//   back / start   a small pill (View / Menu, Share / Options, - / +)
//   stick clicks   a ringed disc (LS / RS, L3 / R3)
//   d-pad          a plus with the pressed arm lit
//   home           a disc with a small house outline

import { padButtonName, type PadFamily } from './gamepad';

type Ctx = CanvasRenderingContext2D;

const FACE_TINT: Record<PadFamily, string[]> = {
  xbox: ['#7cc456', '#e0564b', '#4b8fe0', '#e8c547'],
  playstation: ['#8fb2e6', '#e08a92', '#d79bd0', '#5cc8b0'],
  nintendo: ['#e6e2d8', '#e6e2d8', '#e6e2d8', '#e6e2d8'],
  generic: ['#e6e2d8', '#e6e2d8', '#e6e2d8', '#e6e2d8'],
};

const SHORT: Record<PadFamily, Record<number, string>> = {
  xbox: { 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'LS', 11: 'RS' },
  playstation: { 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Share', 9: 'Options', 10: 'L3', 11: 'R3' },
  nintendo: { 4: 'L', 5: 'R', 6: 'ZL', 7: 'ZR', 8: '−', 9: '+', 10: 'LS', 11: 'RS' },
  generic: { 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS' },
};

const FILL = 'rgba(16,15,14,0.88)';
const EDGE = 'rgba(230,226,216,0.85)';
const INK = '#e6e2d8';

/** Width a glyph of height `h` takes (for layout). */
export function padGlyphWidth(index: number, h: number, family: PadFamily = 'generic'): number {
  if (index === 4 || index === 5 || index === 6 || index === 7) return h * 1.55;
  if (index === 8 || index === 9) return Math.max(h * 1.3, h * 0.42 * (SHORT[family][index]?.length ?? 4) + h * 0.5);
  return h;
}

/**
 * Draws glyph `index` (standard button) with its left edge at x, vertically centred on y.
 * Returns the width used.
 */
export function drawPadGlyph(ctx: Ctx, family: PadFamily, index: number, x: number, y: number, h: number, alpha = 1): number {
  const w = padGlyphWidth(index, h, family);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const cx = x + w / 2;
  const r = h / 2;
  if (index >= 0 && index <= 3) face(ctx, family, index, cx, y, r);
  else if (index === 4 || index === 5) bar(ctx, x, y, w, h * 0.72, false, SHORT[family][index]);
  else if (index === 6 || index === 7) bar(ctx, x, y, w, h * 0.9, true, SHORT[family][index]);
  else if (index === 8 || index === 9) pill(ctx, x, y, w, h * 0.66, SHORT[family][index]);
  else if (index === 10 || index === 11) stick(ctx, cx, y, r, SHORT[family][index]);
  else if (index >= 12 && index <= 15) dpad(ctx, cx, y, r, index - 12);
  else if (index === 16) home(ctx, cx, y, r);
  else label(ctx, cx, y, h * 0.5, padButtonName(index, family));
  ctx.restore();
  return w;
}

function disc(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2);
  ctx.fillStyle = FILL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.strokeStyle = EDGE;
  ctx.stroke();
}

function label(ctx: Ctx, cx: number, cy: number, px: number, s: string, color = INK): void {
  ctx.font = `700 ${Math.max(6, px)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, cx, cy + px * 0.05);
}

function face(ctx: Ctx, family: PadFamily, i: number, cx: number, cy: number, r: number): void {
  disc(ctx, cx, cy, r);
  const tint = FACE_TINT[family][i];
  if (family === 'playstation') {
    ctx.strokeStyle = tint;
    ctx.lineWidth = Math.max(1.2, r * 0.17);
    const s = r * 0.42;
    ctx.beginPath();
    if (i === 0) {
      ctx.moveTo(cx - s, cy - s);
      ctx.lineTo(cx + s, cy + s);
      ctx.moveTo(cx + s, cy - s);
      ctx.lineTo(cx - s, cy + s);
    } else if (i === 1) ctx.arc(cx, cy, s * 1.05, 0, Math.PI * 2);
    else if (i === 2) ctx.rect(cx - s * 0.9, cy - s * 0.9, s * 1.8, s * 1.8);
    else {
      ctx.moveTo(cx, cy - s * 1.05);
      ctx.lineTo(cx + s * 1.05, cy + s * 0.75);
      ctx.lineTo(cx - s * 1.05, cy + s * 0.75);
      ctx.closePath();
    }
    ctx.stroke();
    return;
  }
  const letters = family === 'nintendo' ? ['B', 'A', 'Y', 'X'] : ['A', 'B', 'X', 'Y'];
  label(ctx, cx, cy, r * 1.15, letters[i], tint);
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, rTop: number, rBottom: number): void {
  ctx.beginPath();
  ctx.moveTo(x + rTop, y);
  ctx.lineTo(x + w - rTop, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rTop);
  ctx.lineTo(x + w, y + h - rBottom);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rBottom, y + h);
  ctx.lineTo(x + rBottom, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rBottom);
  ctx.lineTo(x, y + rTop);
  ctx.quadraticCurveTo(x, y, x + rTop, y);
  ctx.closePath();
}

function bar(ctx: Ctx, x: number, cy: number, w: number, h: number, trigger: boolean, text = ''): void {
  const y = cy - h / 2;
  roundRect(ctx, x + 1, y, w - 2, h, trigger ? h * 0.45 : h * 0.3, h * 0.2);
  ctx.fillStyle = FILL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, h * 0.09);
  ctx.strokeStyle = EDGE;
  ctx.stroke();
  label(ctx, x + w / 2, cy + (trigger ? h * 0.06 : 0), h * 0.55, text);
}

function pill(ctx: Ctx, x: number, cy: number, w: number, h: number, text = ''): void {
  roundRect(ctx, x + 1, cy - h / 2, w - 2, h, h / 2, h / 2);
  ctx.fillStyle = FILL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, h * 0.1);
  ctx.strokeStyle = EDGE;
  ctx.stroke();
  label(ctx, x + w / 2, cy, h * (text.length > 2 ? 0.55 : 0.8), text);
}

function stick(ctx: Ctx, cx: number, cy: number, r: number, text = ''): void {
  disc(ctx, cx, cy, r);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.66, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.strokeStyle = 'rgba(230,226,216,0.45)';
  ctx.stroke();
  label(ctx, cx, cy, r * 0.75, text);
}

function dpad(ctx: Ctx, cx: number, cy: number, r: number, dir: number): void {
  const a = r * 0.36; // arm half-width
  const l = r * 0.95; // arm length
  ctx.beginPath();
  ctx.moveTo(cx - a, cy - l);
  ctx.lineTo(cx + a, cy - l);
  ctx.lineTo(cx + a, cy - a);
  ctx.lineTo(cx + l, cy - a);
  ctx.lineTo(cx + l, cy + a);
  ctx.lineTo(cx + a, cy + a);
  ctx.lineTo(cx + a, cy + l);
  ctx.lineTo(cx - a, cy + l);
  ctx.lineTo(cx - a, cy + a);
  ctx.lineTo(cx - l, cy + a);
  ctx.lineTo(cx - l, cy - a);
  ctx.lineTo(cx - a, cy - a);
  ctx.closePath();
  ctx.fillStyle = FILL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.09);
  ctx.strokeStyle = EDGE;
  ctx.stroke();
  // Lit arm: 0 up, 1 down, 2 left, 3 right.
  const arm: [number, number, number, number][] = [
    [cx - a, cy - l, a * 2, l - a],
    [cx - a, cy + a, a * 2, l - a],
    [cx - l, cy - a, l - a, a * 2],
    [cx + a, cy - a, l - a, a * 2],
  ];
  const [x, y, w, h] = arm[dir];
  ctx.fillStyle = INK;
  ctx.fillRect(x + r * 0.08, y + r * 0.08, w - r * 0.16, h - r * 0.16);
}

function home(ctx: Ctx, cx: number, cy: number, r: number): void {
  disc(ctx, cx, cy, r);
  const s = r * 0.45;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy);
  ctx.lineTo(cx, cy - s);
  ctx.lineTo(cx + s, cy);
  ctx.moveTo(cx - s * 0.7, cy - s * 0.1);
  ctx.lineTo(cx - s * 0.7, cy + s * 0.8);
  ctx.lineTo(cx + s * 0.7, cy + s * 0.8);
  ctx.lineTo(cx + s * 0.7, cy - s * 0.1);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
}

/** Standard button index of a "Pad<n>" code, else -1. */
export function padIndexOf(code: string | undefined): number {
  const m = code ? /^Pad(\d+)$/.exec(code) : null;
  return m ? Number(m[1]) : -1;
}
