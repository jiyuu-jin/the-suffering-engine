// Image checks for the Enhanced graphics mode comparison (docs/enhanced.md "Image checks"):
// a minimal PNG decoder (8-bit RGB / RGBA, not interlaced: what a Chromium screenshot writes) and
// per-frame exposure metrics compared against the Original frame of the same pose.
//
// Every value is measured on display values (0..255, as the screen shows them) with Rec. 709
// luma weights: Original writes gamma values to the screen directly and Enhanced encodes sRGB, so
// both are compared on what the player sees.
import { inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** Tightly packed RGBA8, top row first. */
  rgba: Uint8Array;
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG. */
export function decodePng(buf: Uint8Array): Image {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${data[12]})`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const up = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      px[row + x] = v & 255;
    }
  }
  if (bpp === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) (rgba[j] = px[i]), (rgba[j + 1] = px[i + 1]), (rgba[j + 2] = px[i + 2]), (rgba[j + 3] = 255);
  return { width, height, rgba };
}

/** Display luma of a pixel (0..255). */
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Luma at or above this counts as clipped white. */
export const CLIP_LUMA = 250;
/** Luma at or below this counts as near black (about 4 % of the display range). */
export const BLACK_LUMA = 10;

export interface FrameMetrics {
  /** Mean display luma (0..255). */
  mean: number;
  /** Median and 95th percentile luma. */
  p50: number;
  p95: number;
  /** Share of pixels at or above CLIP_LUMA (0..1). */
  clipped: number;
  /** Share of pixels at or below BLACK_LUMA (0..1). */
  black: number;
}

/** Metrics of a frame. */
export function frameMetrics(img: Image): FrameMetrics {
  const n = img.width * img.height;
  const hist = new Uint32Array(256);
  let sum = 0, clipped = 0, black = 0;
  for (let i = 0; i < n; i++) {
    const y = luma(img.rgba[4 * i], img.rgba[4 * i + 1], img.rgba[4 * i + 2]);
    sum += y;
    if (y >= CLIP_LUMA) clipped++;
    if (y <= BLACK_LUMA) black++;
    hist[Math.min(255, Math.round(y))]++;
  }
  const pct = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * n) return v;
    return 255;
  };
  return { mean: sum / n, p50: pct(0.5), p95: pct(0.95), clipped: clipped / n, black: black / n };
}

/**
 * Limits of an Enhanced frame against the Original frame of the same pose. Enhanced may be darker
 * (it is meant to be moodier), but not crushed and not blown out.
 */
export const LIMITS = {
  /** Clipped white: at most this share, or the Original's share when the Original clips more. */
  clipped: 0.02,
  /** Near black: at most this share above the Original's share... */
  blackOver: 0.12,
  /** ...and at most this share overall unless the Original is as dark. */
  black: 0.6,
  /** Mean luma relative to the Original's... */
  meanMin: 0.6,
  meanMax: 1.15,
  /** ...or within this many levels of it (ratios of near-black frames say little). */
  meanAbs: 6,
};

export interface PoseCheck {
  ok: boolean;
  failures: string[];
  /** Mean luma relative to the Original. */
  ratio: number;
}

/** Checks an Enhanced frame's metrics against the Original's (LIMITS). */
export function checkFrame(orig: FrameMetrics, enh: FrameMetrics, limits = LIMITS): PoseCheck {
  const failures: string[] = [];
  const ratio = enh.mean / Math.max(orig.mean, 1e-3);
  const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
  if (enh.clipped > Math.max(limits.clipped, orig.clipped)) failures.push(`clipped ${pct(enh.clipped)} > ${pct(Math.max(limits.clipped, orig.clipped))}`);
  if (enh.black > orig.black + limits.blackOver) failures.push(`near black ${pct(enh.black)} > Original ${pct(orig.black)} + ${pct(limits.blackOver)}`);
  if (enh.black > Math.max(limits.black, orig.black)) failures.push(`near black ${pct(enh.black)} > ${pct(Math.max(limits.black, orig.black))}`);
  if ((ratio < limits.meanMin || ratio > limits.meanMax) && Math.abs(enh.mean - orig.mean) > limits.meanAbs) failures.push(`mean ${ratio.toFixed(2)} x Original outside ${limits.meanMin}..${limits.meanMax} (and ${(enh.mean - orig.mean).toFixed(1)} levels off)`);
  return { ok: failures.length === 0, failures, ratio };
}
