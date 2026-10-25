// Riot Engine texture container (.tdu) decoder.
//
// A .tdu is an SRSC file. Entries:
//   type 0x02 group 4  - 10-byte container header (same in every .tdu)
//   type 0x40 (64)     - one texture each; `entry.id` is the texture id
//   type 0x41 (65)     - optional source-asset record (name + .tga path); only
//                        one exists in the shipped data (Interface.tdu id 1121).
//                        It shares the id of the texture it describes.
//
// Texture payload: a 48-byte little-endian header followed by the pixel data
// of the top mip only (no mip chain is stored; the engine builds mips at load).
//   0x00 u32 width
//   0x04 u32 height
//   0x08 u32 pitch          width * bpp / 8 (DXT1 w/2, DXT5/L8/P8 w)
//   0x0C u32 bitsPerPixel   4 (DXT1) or 8 (DXT5, L8, P8)
//   0x10 u32 alphaMode      0 opaque, 1 one-bit (DXT1 punch-through),
//                           4 interpolated (DXT5), 8 = 8-bit alpha/luminance (L8)
//   0x14 i32 -1             unknown (always 0xFFFFFFFF)
//   0x18 u32 flags          material/usage bits (0x200, 0x20a, 0x120a, ...), meaning unknown
//   0x1C f32 unknown        usually 256.0; 3.5..40 on some (detail/bump scale?)
//   0x20 u32 format         0 = 8-bit paletted, 2 = DXT1, 3 = DXT5 (alphaMode 4) or
//                           uncompressed 8-bit single channel (alphaMode 8, only
//                           seen once: the 32x32 mouse pointer; decoded as L8 with alpha=L)
//   0x24 u32 2              unknown
//   0x28 u32 1              unknown (mip count?)
//   0x2C u32 0              unknown
// Paletted (format 0) data: u32 1, u32 paletteCount (256), u32 0, u32 0,
// paletteCount * 4 bytes RGBA palette, then width*height u8 indices.
// Rows are stored BOTTOM row first (verified on text/portrait textures), i.e.
// stored row 0 is what D3D samples at v=0. decodeTexture() flips to top-row-first
// by default (per DecodedTexture); pass { rowOrder: 'stored' } to keep the raw
// order (then a Three.js DataTexture with flipY=false + raw engine UVs matches
// the usual "v=0 is the image bottom" convention).

import type { SrscEntry, SrscFile } from './srsc';
import type { DecodedTexture } from './types';

export const TEXTURE_ENTRY_TYPE = 0x40;
export const TEXTURE_NAME_ENTRY_TYPE = 0x41;
export const TEXTURE_HEADER_SIZE = 48;

export enum TextureFormat {
  P8 = 0,
  DXT1 = 2,
  /** DXT5, or L8 when alphaMode === 8 */
  DXT5 = 3,
}

export interface TextureHeader {
  width: number;
  height: number;
  pitch: number;
  bitsPerPixel: number;
  alphaMode: number;
  flags: number;
  scale: number;
  format: number;
}

/** Human-readable pixel format: "DXT1", "DXT1a", "DXT5", "L8" or "P8". */
export function formatName(h: TextureHeader): string {
  switch (h.format) {
    case TextureFormat.P8:
      return 'P8';
    case TextureFormat.DXT1:
      return h.alphaMode === 1 ? 'DXT1a' : 'DXT1';
    case TextureFormat.DXT5:
      return h.alphaMode === 8 ? 'L8' : 'DXT5';
    default:
      return `unknown(${h.format})`;
  }
}

export function readTextureHeader(file: SrscFile, entry: SrscEntry): TextureHeader {
  const v = file.data(entry);
  return {
    width: v.getUint32(0x00, true),
    height: v.getUint32(0x04, true),
    pitch: v.getUint32(0x08, true),
    bitsPerPixel: v.getUint32(0x0c, true),
    alphaMode: v.getUint32(0x10, true),
    flags: v.getUint32(0x18, true),
    scale: v.getFloat32(0x1c, true),
    format: v.getUint32(0x20, true),
  };
}

/** Reads the optional type-0x41 name records: id -> { name, path }. */
export function readTextureNames(file: SrscFile): Map<number, { name: string; path: string }> {
  const out = new Map<number, { name: string; path: string }>();
  for (const e of file.byType(TEXTURE_NAME_ENTRY_TYPE)) {
    try {
      const b = file.bytes(e);
      const v = file.data(e);
      let p = 0;
      const str = () => {
        const n = v.getUint16(p, true);
        p += 2;
        let s = '';
        for (let i = 0; i < n && b[p + i] !== 0; i++) s += String.fromCharCode(b[p + i]);
        p += n;
        return s;
      };
      const name = str();
      const path = str();
      out.set(e.id, { name, path });
    } catch {
      // malformed record; ignore
    }
  }
  return out;
}

// DXT decoding writes whole texels as 32-bit words (RGBA bytes in a little-endian word), with
// the block's palette in a reused array: no allocation per block or texel. It was ~1 s of the
// main thread per level load (character / prop textures; docs/game-logic.md §18.8). Output
// identical to a byte-wise decode (tests/formats.test.ts).
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const rgba32 = LITTLE_ENDIAN
  ? (r: number, g: number, b: number, a: number) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
  : (r: number, g: number, b: number, a: number) => ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

/** The 4 colours of the 8-byte DXT colour block at `src[s]` (alpha 255, or 0 for punch-through). */
function colorPalette(src: Uint8Array, s: number, pal: Uint32Array, allowPunchThrough: boolean): void {
  const c0 = src[s] | (src[s + 1] << 8);
  const c1 = src[s + 2] | (src[s + 3] << 8);
  const r0 = ((c0 >> 11) & 31) << 3 | (((c0 >> 11) & 31) >> 2);
  const g0 = ((c0 >> 5) & 63) << 2 | (((c0 >> 5) & 63) >> 4);
  const b0 = (c0 & 31) << 3 | ((c0 & 31) >> 2);
  const r1 = ((c1 >> 11) & 31) << 3 | (((c1 >> 11) & 31) >> 2);
  const g1 = ((c1 >> 5) & 63) << 2 | (((c1 >> 5) & 63) >> 4);
  const b1 = (c1 & 31) << 3 | ((c1 & 31) >> 2);
  pal[0] = rgba32(r0, g0, b0, 255);
  pal[1] = rgba32(r1, g1, b1, 255);
  if (c0 > c1 || !allowPunchThrough) {
    pal[2] = rgba32(((2 * r0 + r1 + 1) / 3) | 0, ((2 * g0 + g1 + 1) / 3) | 0, ((2 * b0 + b1 + 1) / 3) | 0, 255);
    pal[3] = rgba32(((r0 + 2 * r1 + 1) / 3) | 0, ((g0 + 2 * g1 + 1) / 3) | 0, ((b0 + 2 * b1 + 1) / 3) | 0, 255);
  } else {
    pal[2] = rgba32((r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1, 255);
    pal[3] = 0;
  }
}

/** DXT1 / DXT3 / DXT5 blocks to RGBA8 (exported for tests). */
export function decodeDxt(
  src: Uint8Array,
  width: number,
  height: number,
  kind: 'DXT1' | 'DXT3' | 'DXT5',
  punchThrough: boolean,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const out32 = new Uint32Array(out.buffer);
  const bw = Math.max(1, (width + 3) >> 2);
  const bh = Math.max(1, (height + 3) >> 2);
  const blockSize = kind === 'DXT1' ? 8 : 16;
  const pal = new Uint32Array(4);
  const alpha = new Uint8Array(8);
  const texelAlpha = new Uint8Array(16);
  // Masks keeping a texel's RGB (alpha replaced from the alpha block).
  const rgbMask = LITTLE_ENDIAN ? 0x00ffffff : 0xffffff00;
  const alphaShift = LITTLE_ENDIAN ? 24 : 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const s = (by * bw + bx) * blockSize;
      if (s + blockSize > src.length) continue;
      const cs = kind === 'DXT1' ? s : s + 8;
      colorPalette(src, cs, pal, kind === 'DXT1' && punchThrough);
      const bits = (src[cs + 4] | (src[cs + 5] << 8) | (src[cs + 6] << 16) | (src[cs + 7] << 24)) >>> 0;
      if (kind === 'DXT3') {
        for (let i = 0; i < 16; i++) texelAlpha[i] = ((src[s + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      } else if (kind === 'DXT5') {
        const a0 = src[s];
        const a1 = src[s + 1];
        alpha[0] = a0;
        alpha[1] = a1;
        if (a0 > a1) {
          for (let k = 1; k < 7; k++) alpha[k + 1] = ((7 - k) * a0 + k * a1 + 3) / 7;
        } else {
          for (let k = 1; k < 5; k++) alpha[k + 1] = ((5 - k) * a0 + k * a1 + 2) / 5;
          alpha[6] = 0;
          alpha[7] = 255;
        }
        // 48 bits of 3-bit indices, little-endian
        const lo = (src[s + 2] | (src[s + 3] << 8) | (src[s + 4] << 16)) >>> 0;
        const hi = (src[s + 5] | (src[s + 6] << 8) | (src[s + 7] << 16)) >>> 0;
        for (let i = 0; i < 8; i++) texelAlpha[i] = alpha[(lo >> (3 * i)) & 7];
        for (let i = 0; i < 8; i++) texelAlpha[i + 8] = alpha[(hi >> (3 * i)) & 7];
      }
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        const row = y * width;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) break;
          const i = py * 4 + px;
          let c = pal[(bits >>> (2 * i)) & 3];
          if (kind !== 'DXT1') c = ((c & rgbMask) | (texelAlpha[i] << alphaShift)) >>> 0;
          out32[row + x] = c;
        }
      }
    }
  }
  return out;
}

function decodeP8(src: Uint8Array, width: number, height: number): Uint8Array {
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const count = Math.min(256, v.getUint32(4, true) || 256);
  const palOff = 16;
  const pixOff = palOff + count * 4;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = src[pixOff + i] ?? 0;
    const p = palOff + (idx < count ? idx : 0) * 4;
    out[i * 4] = src[p];
    out[i * 4 + 1] = src[p + 1];
    out[i * 4 + 2] = src[p + 2];
    out[i * 4 + 3] = src[p + 3];
  }
  return out;
}

function decodeL8(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) out.fill(src[i], i * 4, i * 4 + 4);
  return out;
}

/**
 * Give fully transparent texels the colour of their visible neighbours (grown outwards,
 * then the mean visible colour). DXT1 punch-through texels decode as black, which bilinear
 * filtering and mipmaps would otherwise smear into dark fringes around cutout edges.
 * Alpha is unchanged.
 */
export function bleedTransparentTexels(rgba: Uint8Array, width: number, height: number, passes = 4): void {
  let pending: number[] = [];
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (rgba[i + 3] === 0) pending.push(p);
    else (sr += rgba[i]), (sg += rgba[i + 1]), (sb += rgba[i + 2]), sn++;
  }
  if (!pending.length || !sn) return;
  const known = new Uint8Array(width * height);
  for (let p = 0; p < known.length; p++) known[p] = rgba[p * 4 + 3] !== 0 ? 1 : 0;
  for (let pass = 0; pass < passes && pending.length; pass++) {
    const filled: number[] = [];
    const rest: number[] = [];
    for (const p of pending) {
      const x = p % width, y = (p / width) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // Wrap: textures tile (RepeatWrapping).
          const q = ((y + dy + height) % height) * width + ((x + dx + width) % width);
          if (!known[q]) continue;
          r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n++;
        }
      }
      if (n) {
        rgba[p * 4] = r / n; rgba[p * 4 + 1] = g / n; rgba[p * 4 + 2] = b / n;
        filled.push(p);
      } else rest.push(p);
    }
    for (const p of filled) known[p] = 1;
    pending = rest;
  }
  for (const p of pending) {
    rgba[p * 4] = sr / sn; rgba[p * 4 + 1] = sg / sn; rgba[p * 4 + 2] = sb / sn;
  }
}

/**
 * A punch-through texture as a pass that does not cut it samples it: alpha-0 texels black. The
 * engine creates every alpha-mode-1 texture as D3DFMT_DXT1 (SUFFERING.EXE 0x4485d0: compressed,
 * no alpha bits 17..19 -> 'DXT1'), whose transparent texels decode to RGBA 0. Only a cut-out
 * pass (mode 8) keeps the bled colours of decodeTexture, so its edges filter without dark
 * fringes [port]; an opaque pass (mode 0: no alpha test, no blend) shows those texels black, as
 * the original does (docs/re/renderer.md "Alpha test, blend and coverage"). Returns a copy.
 */
export function punchThroughBlack(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out[i] = out[i + 1] = out[i + 2] = 0;
  return out;
}

/**
 * Mip chain (level 0 included) whose alpha keeps the fraction of texels at or above
 * `threshold` equal to the top level's (Castaño, "Computing alpha mipmaps"). RGB is
 * alpha-weighted so transparent texels do not darken the visible ones.
 */
export function coverageMipmaps(rgba: Uint8Array, width: number, height: number, threshold: number) {
  const coverage = (d: Uint8Array, scale: number) => {
    let n = 0;
    const t = threshold * 255;
    for (let i = 3; i < d.length; i += 4) if (Math.min(255, d[i] * scale) >= t) n++;
    return n / (d.length / 4);
  };
  const target = coverage(rgba, 1);
  const levels: { data: Uint8Array; width: number; height: number }[] = [{ data: rgba, width, height }];
  let prev = rgba, pw = width, ph = height;
  while (pw > 1 || ph > 1) {
    const w = Math.max(1, pw >> 1), h = Math.max(1, ph >> 1);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0, wsum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(pw - 1, 2 * x + dx), sy = Math.min(ph - 1, 2 * y + dy);
            const i = (sy * pw + sx) * 4;
            const wa = prev[i + 3] + 1;
            r += prev[i] * wa; g += prev[i + 1] * wa; b += prev[i + 2] * wa;
            wsum += wa;
            a += prev[i + 3];
          }
        }
        const o = (y * w + x) * 4;
        out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = a / 4;
      }
    }
    // Binary-search an alpha scale that restores the top level's coverage.
    if (target > 0) {
      let lo = 0, hi = 4;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        if (coverage(out, mid) < target) lo = mid;
        else hi = mid;
      }
      const s = hi;
      for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, Math.round(out[i] * s));
    }
    levels.push({ data: out, width: w, height: h });
    prev = out; pw = w; ph = h;
  }
  return levels;
}

function anyAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

/** Decodes a single texture entry (top mip, RGBA8). Returns null (with a warning) for unknown formats. */
export interface DecodeOptions {
  /** 'top-down' (default): first row of rgba is the visual top. 'stored': raw file order (bottom-up). */
  rowOrder?: 'top-down' | 'stored';
  name?: string;
}

function flipRows(rgba: Uint8Array, width: number, height: number): void {
  const stride = width * 4;
  const tmp = new Uint8Array(stride);
  for (let y = 0, z = height - 1; y < z; y++, z--) {
    tmp.set(rgba.subarray(y * stride, y * stride + stride));
    rgba.copyWithin(y * stride, z * stride, z * stride + stride);
    rgba.set(tmp, z * stride);
  }
}

export function decodeTexture(file: SrscFile, entry: SrscEntry, opts: DecodeOptions = {}): DecodedTexture | null {
  const name = opts.name;
  if (entry.type !== TEXTURE_ENTRY_TYPE || entry.size < TEXTURE_HEADER_SIZE) return null;
  const h = readTextureHeader(file, entry);
  const src = file.bytes(entry).subarray(TEXTURE_HEADER_SIZE);
  const { width, height } = h;
  if (!width || !height || width > 8192 || height > 8192) {
    console.warn(`texture ${entry.id}: bad size ${width}x${height}`);
    return null;
  }
  let rgba: Uint8Array;
  switch (h.format) {
    case TextureFormat.P8:
      rgba = decodeP8(src, width, height);
      break;
    case TextureFormat.DXT1:
      rgba = decodeDxt(src, width, height, 'DXT1', h.alphaMode === 1);
      if (h.alphaMode === 1) bleedTransparentTexels(rgba, width, height);
      break;
    case TextureFormat.DXT5:
      if (h.alphaMode === 8 && src.length >= width * height && src.length < (width * height * 3) / 2) {
        rgba = decodeL8(src, width, height);
      } else {
        rgba = decodeDxt(src, width, height, 'DXT5', false);
      }
      break;
    default:
      console.warn(`texture ${entry.id}: unknown format ${h.format} (bpp ${h.bitsPerPixel}, alpha ${h.alphaMode})`);
      return null;
  }
  if ((opts.rowOrder ?? 'top-down') === 'top-down') flipRows(rgba, width, height);
  return {
    key: String(entry.id),
    name,
    width,
    height,
    rgba,
    hasAlpha: h.alphaMode !== 0 && anyAlpha(rgba),
    ...(h.format === TextureFormat.DXT1 && h.alphaMode === 1 ? { punchThrough: true } : {}),
  };
}

/** Decodes every texture in a .tdu. Keys are the SRSC entry ids as strings. */
export function decodeTextures(file: SrscFile, opts: Omit<DecodeOptions, 'name'> = {}): DecodedTexture[] {
  const names = readTextureNames(file);
  const out: DecodedTexture[] = [];
  for (const e of file.byType(TEXTURE_ENTRY_TYPE)) {
    try {
      const t = decodeTexture(file, e, { ...opts, name: names.get(e.id)?.name });
      if (t) out.push(t);
    } catch (err) {
      console.warn(`texture ${e.id}: decode failed: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Convenience: decode and index by numeric id. */
export function decodeTextureMap(file: SrscFile, opts: Omit<DecodeOptions, 'name'> = {}): Map<number, DecodedTexture> {
  return new Map(decodeTextures(file, opts).map((t) => [Number(t.key), t]));
}
