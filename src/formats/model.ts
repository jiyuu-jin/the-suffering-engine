// Riot Engine static models (.mdu) and material resolution (.odu -> .tdu).
//
// Cross-package references
// ------------------------
// Every package (.mdu/.odu/.tdu/.adu/... sharing a stem) has a .db text file
// with an `id N` line. Binary data references resources in any package as a
// u32 = (u16 entryId, u16 packageDbId). E.g. (0x0d38, 9) = entry 3384 of
// "World Common/Prison Common" (Prison Common.db: id 9).
//
// .mdu entries (all share the model id; group 2)
// -----------------------------------------------
//   type 0  header:   u16 flags, u16 flags2, u32 0,
//                     [f32 (e.g. LOD distance) if flags2 & 2],
//                     u32 materialCount, materialCount x ref(u16 id, u16 pkg) -> .odu material,
//                     u32 ?, f32 1.0
//   type 3  vertices: u16 nv, nv x f32[3] position, nv x i8[4] normal (xyz/127, w pad)
//   type 4  faces:    u16 nf, u16 face flags (2 on 60 retail models: FX debris, glass shards;
//                     meaning unknown, the records are the same), nf x { u16 3,
//                     u16 materialIndex, u16 a, u16 b, u16 c, u16 pad },
//                     nf x 3 x f32[2] per-corner UV (D3D convention, v=0 = top / first stored row)
//   type 7  bounds / collision proxies (not needed for rendering)
//   type 17 render-order data: vertex-duplication pairs, per-vertex UVs, edges (redundant)
//   type 22 vertex remap table (redundant)
//   type 8  (rare) skeleton / extra data
// Model units: 1 unit ~ 0.85 m (humans are ~2.1 units tall). Y is up.
// Faces are clockwise-front: the stored normals oppose the cross product (b-a)x(c-a).
// No axis flip is needed for display (text on textures reads correctly as stored).
//
// .odu materials (type 2, group 1) — engine classes (SUFFERING.EXE), see readMaterial()
// ------------------------------------------------------------------------------------
// A material is an ordinary object template (+14 class id, words from +28; see
// docs/game-logic.md §2.2 and §16). Property 0 of every material class is the surface
// ("Material Type") template. Per class (property index: meaning):
//   Simple    0xad99e79b  1 texture, 2 blend mode
//   Advanced  0x7e3ad512  1 texture, 2 blend mode, 3 tint on, 4 tint colour, 5 depth write,
//                         6 UV scale, 7 / 8 U / V offset, 9 UV scale waveform, 10 UV scroll
//                         waveform, 11 texture-coordinate input, 12 texgen mode, 13 texgen
//                         object-offset factor (modes 7..9 only), 14 / 17 address modes [guess]
//                         (see advancedLayer())
//   Animating 0xd58d8e2c  1 frame list, 2 fps, 4 blend mode, 5 tint on, 6 tint colour, 7 depth write
//   Layered   0x03656e9f  1 single-pass fallback material, 2 list of layer materials (<= 8)
//   Landscape 0xb13556e7  3 texture, 4 tiling (floor cells per repeat), 7 splat fade distance
//   Preset    0x2d8c5d43  1 base texture, 2 blend mode, 4/5/7/9 preset effect textures
// Blend modes (render-state switch at 0x49a990; alpha test set at 0x48fab0):
//   0 opaque, 1 alpha blend, 2 additive (src*a + dst), 3 opaque, 4 reverse-subtract,
//   5 dst*srcAlpha, 6 modulate2x (2*src*dst), 7 src + dst*srcAlpha,
//   8 (= mode 1 on a 1-bit-alpha texture) alpha-tested cutout (ref 200/255).

import type { SrscEntry, SrscFile } from './srsc';
import type { MeshPart } from './types';

export const MDU_HEADER = 0;
export const MDU_VERTICES = 3;
export const MDU_FACES = 4;
export const ODU_OBJECT = 2;
export const TDU_TEXTURE = 0x40;
/** .wdu entry type of waveforms (sampled curves: UV animation, rumble). */
export const WDU_WAVEFORM = 0x60;

/** One package (one .db id) worth of containers. Any member may be missing. */
export interface RiotPackage {
  id: number;
  name?: string;
  mdu?: SrscFile;
  odu?: SrscFile;
  tdu?: SrscFile;
  /** Animation clips (skinned characters). */
  adu?: SrscFile;
  /** Waveforms (material UV animation, rumble curves). */
  wdu?: SrscFile;
}

export type PackageSet = Map<number, RiotPackage>;

export interface ResRef {
  id: number;
  pkg: number;
}

export const refKey = (r: ResRef) => `${r.pkg}:${r.id}`;

/** Parse the `id N` line of a package .db file. */
export function readDbId(text: string): number | undefined {
  const m = /^\s*id\s+(\d+)/im.exec(text);
  return m ? parseInt(m[1], 10) : undefined;
}

// ---------------------------------------------------------------------------
// Per-container entry index (type,id) -> entry, cached per SrscFile.

const indexCache = new WeakMap<SrscFile, Map<number, SrscEntry>>();

export function findEntry(file: SrscFile | undefined, type: number, id: number): SrscEntry | undefined {
  if (!file) return undefined;
  let idx = indexCache.get(file);
  if (!idx) {
    idx = new Map();
    for (const e of file.entries) {
      const k = e.type * 0x10000 + e.id;
      if (!idx.has(k)) idx.set(k, e);
    }
    indexCache.set(file, idx);
  }
  return idx.get(type * 0x10000 + id);
}

function odu(pkgs: PackageSet, r: ResRef): DataView | undefined {
  const f = pkgs.get(r.pkg)?.odu;
  const e = findEntry(f, ODU_OBJECT, r.id);
  return e && f ? f.data(e) : undefined;
}

function readRef(v: DataView, off: number): ResRef {
  return { id: v.getUint16(off, true), pkg: v.getUint16(off + 2, true) };
}

/** Model reference stored at the start of an .odu object template (u16 id, u16 pkg), if any. */
export function templateModelRef(pkgs: PackageSet, template: ResRef): ResRef | undefined {
  const v = odu(pkgs, template);
  if (!v || v.byteLength < 4) return undefined;
  const r = readRef(v, 0);
  return r.pkg ? r : undefined;
}

// ---------------------------------------------------------------------------
// Materials

export const CLASS_SIMPLE = 0xad99e79b;
export const CLASS_ADVANCED = 0x7e3ad512;
export const CLASS_LAYERED = 0x03656e9f;
export const CLASS_LANDSCAPE = 0xb13556e7;
export const CLASS_LANDSCAPE_WATER = 0x8c84cce7;
export const CLASS_ANIMATING = 0xd58d8e2c;
export const CLASS_PRESET = 0x2d8c5d43;

export const MATERIAL_CLASS_NAMES: Record<number, string> = {
  [CLASS_SIMPLE]: 'Simple',
  [CLASS_ADVANCED]: 'Advanced',
  [CLASS_LAYERED]: 'Layered',
  [CLASS_LANDSCAPE]: 'Landscape',
  [CLASS_LANDSCAPE_WATER]: 'Landscape Water',
  [CLASS_ANIMATING]: 'Animating',
  [CLASS_PRESET]: 'Preset',
};

/** Engine blend modes (see header). */
export const Blend = {
  Opaque: 0,
  Alpha: 1,
  Add: 2,
  Opaque3: 3,
  Subtract: 4,
  MulAlpha: 5,
  Modulate2x: 6,
  AddOverAlpha: 7,
  Cutout: 8,
} as const;

/** One draw pass of a material. */
export interface MaterialLayer {
  /** Texture key "<pkg>:<id>" (the first frame of an animated layer). */
  texture?: string;
  /** Animating Material: every frame, played at `fps`. */
  frames?: string[];
  fps?: number;
  /** Blend mode 0..8 (Blend). Mode 1 on a 1-bit-alpha texture is promoted to 8 (cutout). */
  blend: number;
  /** Tint colour 0xRRGGBB multiplied into the texture (only when the material enables it). */
  tint?: number;
  /**
   * Advanced p5 / Animating p7, named for its old reading. It is not a depth write: the pass
   * builder (SUFFERING.EXE 0x48fab0) turns it into the stencil REPLACE that marks pixels for the
   * screen glow pass, and raises an additive pass's alpha test to > 32/255; depth is written only
   * by an opaque or cut-out first pass (render-data.ts passDepthWrite / passAlphaRef) [verified].
   */
  depthWrite?: boolean;
  /** Advanced Material texture-coordinate generation mode (prop 12; 0 = mesh UVs). */
  texGen?: number;
  /**
   * Advanced Material texture-coordinate input (prop 11): 0 mesh UVs (no [-1, 1] -> [0, 1]
   * bias), 1 normal (scaled by 1 / 2048), 2 position, 3 reflection vector. See TexInput.
   */
  texInput?: number;
  /** Advanced Material UV scale (prop 6, 1 = none). */
  uvScale?: number;
  /** Advanced Material U / V offset (props 7 / 8), added after scale and bias. */
  uvOffset?: [number, number];
  /** UV scroll waveform (prop 10): (u, v) added to the coordinates, looped. */
  scroll?: Waveform;
  /** UV scale waveform (prop 9): (u, v) multiplying the scaled coordinates, looped. */
  scaleWave?: Waveform;
}

/** Advanced Material prop 11 values (texture-coordinate input). */
export const TexInput = { Uv: 0, Normal: 1, Position: 2, Reflection: 3 } as const;

/**
 * A sampled curve from a .wdu (type 0x60): u32 element type (0 int8, 1 int16, 2 int32,
 * 3 float32, 4 raw bytes), u16 channels, u16 bit width (not read by the engine), u32 rate
 * (samples / s), u32 (skipped), u32 byte count, then the samples interleaved by channel
 * [verified: loader SUFFERING.EXE 0x4881c0; samples = bytes / channels / element size 0x488000;
 * duration = samples / rate 0x487a20, 0 for type 4]. The sampler (vtable +0x60, 0x487d40)
 * normalises integers (int8 / 127, int16 / 32767, int32 / 2^31) when asked to interpolate,
 * which every caller does. Type 3 curves with 2 channels drive the material UV scroll
 * (0x48e7c0, at fmod(game time, duration)); type 1 curves drive Lighting Effects (lights.ts).
 * Type 4 entries (credits text, morph data) are not curves: parseWaveform skips them.
 */
export interface Waveform {
  key: string;
  rate: number;
  channels: number;
  /** samples × channels floats. */
  data: Float32Array;
  /** Seconds per loop (samples / rate). */
  duration: number;
}

/** A decoded .odu material: the passes the engine draws, base first. */
export interface SurfaceMaterial {
  /** "<pkg>:<id>" of the material template. */
  key: string;
  cls: number;
  layers: MaterialLayer[];
  /** Layered Material: the engine's single-pass fallback (used on low-end settings). */
  fallback?: MaterialLayer;
}

/** Template words of an .odu object: class id + property words (lists are count << 16 | offset). */
export function readTemplateWords(v: DataView): { cls: number; propCount: number; words: Uint32Array } | undefined {
  if (v.byteLength < 28) return undefined;
  let p = 12;
  const hasBounds = v.getUint16(p, true);
  p += 2 + (hasBounds ? 64 : 0);
  if (p + 14 > v.byteLength) return undefined;
  const cls = v.getUint32(p, true);
  const propCount = v.getUint32(p + 6, true);
  const wordCount = v.getUint32(p + 10, true);
  p += 14;
  if (wordCount > 4096 || p + 4 * wordCount > v.byteLength) return undefined;
  const words = new Uint32Array(wordCount);
  for (let i = 0; i < wordCount; i++) words[i] = v.getUint32(p + 4 * i, true);
  return { cls, propCount, words };
}

const wordRef = (w: number | undefined): ResRef | undefined =>
  w && w >>> 16 ? { id: w & 0xffff, pkg: w >>> 16 } : undefined;

function listItems(words: Uint32Array, i: number): number[] {
  const w = words[i] ?? 0;
  const n = w >>> 16, off = w & 0xffff;
  if (!n || off + n > words.length) return [];
  return Array.from(words.subarray(off, off + n));
}

/** 1-bit alpha (DXT1 punch-through) texture? (the engine promotes blend 1 to cutout for these) */
function isOneBitAlpha(pkgs: PackageSet, r: ResRef): boolean {
  const f = pkgs.get(r.pkg)?.tdu;
  const e = findEntry(f, TDU_TEXTURE, r.id);
  return !!(f && e && e.size >= 0x14 && f.data(e).getUint32(0x10, true) === 1);
}

const materialCache = new WeakMap<PackageSet, Map<string, SurfaceMaterial | null>>();

/**
 * Decode an .odu material (any engine material class) into its draw passes.
 * Returns undefined when the reference is not a material.
 */
export function readMaterial(pkgs: PackageSet, ref: ResRef, depth = 0): SurfaceMaterial | undefined {
  let cache = materialCache.get(pkgs);
  if (!cache) materialCache.set(pkgs, (cache = new Map()));
  const key = refKey(ref);
  const hit = cache.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const out = decodeMaterial(pkgs, ref, depth);
  cache.set(key, out ?? null);
  return out;
}

function decodeMaterial(pkgs: PackageSet, ref: ResRef, depth: number): SurfaceMaterial | undefined {
  const v = odu(pkgs, ref);
  if (!v) {
    // A bare texture reference (some models point straight at a .tdu entry).
    return isTexture(pkgs, ref) === true
      ? { key: refKey(ref), cls: 0, layers: [{ texture: refKey(ref), blend: Blend.Opaque }] }
      : undefined;
  }
  const t = readTemplateWords(v);
  if (!t) return undefined;
  const { cls, words } = t;
  const tex = (i: number) => {
    const r = wordRef(words[i]);
    return r && texOk(pkgs, r) ? r : undefined;
  };
  const blendOf = (mode: number, r: ResRef | undefined) =>
    mode === Blend.Alpha && r && isOneBitAlpha(pkgs, r) ? Blend.Cutout : mode;
  const colour = (w: number) => w & 0xffffff;
  const base = { key: refKey(ref), cls };

  switch (cls) {
    case CLASS_SIMPLE: {
      const r = tex(1);
      return { ...base, layers: [{ texture: r && refKey(r), blend: blendOf(words[2] ?? 0, r) }] };
    }
    case CLASS_ADVANCED:
      return { ...base, layers: [advancedLayer(pkgs, words, tex(1), blendOf)] };
    case CLASS_ANIMATING: {
      const frames = listItems(words, 1)
        .map(wordRef)
        .filter((r): r is ResRef => !!r && texOk(pkgs, r));
      const fps = new Float32Array(new Uint32Array([words[2] ?? 0]).buffer)[0];
      const layer: MaterialLayer = {
        texture: frames[0] && refKey(frames[0]),
        blend: blendOf(words[4] ?? 0, frames[0]),
      };
      if (frames.length > 1) {
        layer.frames = frames.map(refKey);
        layer.fps = Number.isFinite(fps) && fps > 0 ? fps : 15;
      }
      if (words[5]) layer.tint = colour(words[6] ?? 0xffffff);
      if (words[7]) layer.depthWrite = true;
      return { ...base, layers: [layer] };
    }
    case CLASS_LANDSCAPE:
    case CLASS_LANDSCAPE_WATER: {
      const r = tex(3);
      return { ...base, layers: [{ texture: r && refKey(r), blend: Blend.Opaque }] };
    }
    case CLASS_PRESET: {
      const r = tex(1);
      return { ...base, layers: [{ texture: r && refKey(r), blend: blendOf(words[2] ?? 0, r) }] };
    }
    case CLASS_LAYERED: {
      if (depth > 3) return undefined;
      const sub = (w: number | undefined) => {
        const r = wordRef(w);
        return r ? readMaterial(pkgs, r, depth + 1)?.layers[0] : undefined;
      };
      const layers = listItems(words, 2)
        .slice(0, 8)
        .map(sub)
        .filter((l): l is MaterialLayer => !!l);
      const fallback = sub(words[1]);
      return { ...base, layers: layers.length ? layers : fallback ? [fallback] : [], fallback };
    }
  }
  // Unknown class: legacy heuristic, the first 4-aligned word that names a texture.
  for (let i = 1; i < words.length; i++) {
    const r = wordRef(words[i]);
    if (r && isTexture(pkgs, r) === true) return { ...base, layers: [{ texture: refKey(r), blend: Blend.Opaque }] };
  }
  return undefined;
}

/**
 * Advanced Material layer. The engine copies the properties into the pass (SUFFERING.EXE
 * 0x48ff70: p6 -> +0x24 scale, p7 -> +0x2c, p8 -> +0x28 offsets, p10 -> +0x1c / p9 -> +0x20
 * waveforms, p11 -> +0x34, p12 -> +0x38, p13 -> +0x3c) and builds the texture matrix per draw
 * (0x48e9f0): R = M · S · B · D, then the waveforms (0x48e7c0), and the two columns of R
 * that the texgen mode selects (0x48e1a0: mode 1 x / z, 2 y / z, 3 x / y, 0 / 4 / 5 u / v,
 * 7..9 as 1..3) become the vertex shader's texture planes (xvsTextureMatrix.vsh):
 *   M  mode 0: identity (mesh UVs); 1..3: the object's matrix (translation dropped for
 *      inputs 2 / 3); 4: object · camera (scale removed for inputs 2 / 3); 7..9: identity
 *      plus the object position × p13
 *   S  uniform scale p6, × 1/2048 for input 1
 *   B  [-1, 1] -> [0, 1] bias (× 0.5 + 0.5) unless input 0
 *   D  offsets: p7 on the u column, p8 on the v column
 *   waveforms: p10 adds (u, v) to the translation (scroll), p9 multiplies the u / v
 *      columns (scale); both looped over game time.
 * Input p11 (0 mesh UVs, 1 normal, 2 position, 3 reflection vector) is also handed to the
 * fixed-function path as the texture-coordinate source (0x436110) [inferred from the
 * texture choice: every planar-texgen layer is an environment / sheen / glint texture].
 */
function advancedLayer(
  pkgs: PackageSet,
  words: Uint32Array,
  r: ResRef | undefined,
  blendOf: (mode: number, r: ResRef | undefined) => number,
): MaterialLayer {
  const layer: MaterialLayer = { texture: r && refKey(r), blend: blendOf(words[2] ?? 0, r) };
  if (words[3]) layer.tint = (words[4] ?? 0xffffff) & 0xffffff;
  if (words[5]) layer.depthWrite = true;
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const scale = f[6];
  if (Number.isFinite(scale) && scale !== 1 && scale !== 0) layer.uvScale = scale;
  const ou = Number.isFinite(f[7]) ? f[7] : 0, ov = Number.isFinite(f[8]) ? f[8] : 0;
  if (ou || ov) layer.uvOffset = [ou, ov];
  const scroll = wordRef(words[10]);
  const sw = scroll && readWaveform(pkgs, scroll);
  if (sw) layer.scroll = sw;
  const sc = wordRef(words[9]);
  const scw = sc && readWaveform(pkgs, sc);
  if (scw) layer.scaleWave = scw;
  if (words[12]) {
    layer.texGen = words[12];
    layer.texInput = words[11] <= 3 ? words[11] : TexInput.Uv;
  }
  return layer;
}

const waveCache = new WeakMap<PackageSet, Map<string, Waveform | null>>();

/** Decode a .wdu waveform (float channels only); undefined when missing or not float. */
export function readWaveform(pkgs: PackageSet, ref: ResRef): Waveform | undefined {
  let cache = waveCache.get(pkgs);
  if (!cache) waveCache.set(pkgs, (cache = new Map()));
  const key = refKey(ref);
  const hit = cache.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const f = pkgs.get(ref.pkg)?.wdu;
  const e = findEntry(f, WDU_WAVEFORM, ref.id);
  const out = f && e ? parseWaveform(f.data(e), key) : undefined;
  cache.set(key, out ?? null);
  return out;
}

/** Parse a waveform entry (see Waveform); integer samples are normalised as the engine samples them. */
export function parseWaveform(v: DataView, key = ''): Waveform | undefined {
  if (v.byteLength < 20) return undefined;
  const type = v.getUint32(0, true);
  const size = WAVE_ELEMENT_SIZE[type];
  const channels = v.getUint16(4, true);
  const rate = v.getUint32(8, true);
  const bytes = Math.min(v.getUint32(16, true), v.byteLength - 20);
  if (!size || channels < 1 || channels > 4 || !(rate > 0 && rate <= 1000)) return undefined;
  const n = Math.floor(bytes / size / channels);
  if (n < 1) return undefined;
  const data = new Float32Array(n * channels);
  for (let i = 0; i < data.length; i++) {
    const o = 20 + size * i;
    const x =
      type === 0 ? v.getInt8(o) / 127 : type === 1 ? v.getInt16(o, true) / 32767 : type === 2 ? v.getInt32(o, true) * 2 ** -31 : v.getFloat32(o, true);
    data[i] = Number.isFinite(x) ? x : 0;
  }
  return { key, rate, channels, data, duration: n / rate };
}

/** Bytes per sample of .wdu element types 0..3 (int8, int16, int32, float32). */
const WAVE_ELEMENT_SIZE: Record<number, number> = { 0: 1, 1: 2, 2: 4, 3: 4 };

/** Channel `c` of a waveform at time `t` (s), looped, linearly interpolated. */
export function waveformAt(w: Waveform, t: number, c: number): number {
  if (c >= w.channels) return 0;
  const n = w.data.length / w.channels;
  let tt = t % w.duration;
  if (tt < 0) tt += w.duration;
  const x = tt * w.rate;
  const i = Math.min(n - 1, Math.floor(x));
  const j = Math.min(n - 1, i + 1);
  const k = x - Math.floor(x);
  return w.data[i * w.channels + c] * (1 - k) + w.data[j * w.channels + c] * k;
}

/**
 * The engine's sampler exactly (SUFFERING.EXE 0x487d40, interpolating): x = t / duration ×
 * samples, i = trunc(x); past the last sample it holds the last one, and below sample 1 it
 * returns sample 0 without interpolating; otherwise samples i and i + 1 are lerped. No
 * wrapping: callers pass fmod(time, duration). (Integer types lerp the raw integers and
 * truncate before normalising; the difference is below one integer step.)
 */
export function waveformSample(w: Waveform, t: number, c: number): number {
  if (c >= w.channels) return 0;
  const n = w.data.length / w.channels;
  const x = (t / w.duration) * n;
  let i = Math.trunc(x);
  let f = x - i;
  if (!(i < n - 1)) (i = n - 1), (f = 0);
  else if (i <= 0) (i = 0), (f = 0);
  const a = w.data[i * w.channels + c];
  return f ? a + (w.data[(i + 1) * w.channels + c] - a) * f : a;
}

/** Texture usable? (trust refs into packages whose .tdu was not supplied) */
function texOk(pkgs: PackageSet, r: ResRef): boolean {
  if (!pkgs.has(r.pkg)) return false;
  return isTexture(pkgs, r) !== false;
}

/** A Landscape Material as a floor-layer splat: full-resolution texture tiled in world space. */
export interface LandscapeSplat {
  /** Texture key "<pkg>:<id>". */
  texture: string;
  /** Model units (floor cells) per texture repeat (property 4). */
  tiling: number;
  /** Distance (model units) over which the splat fades into the baked atlas (property 7). */
  fade: number;
}

/**
 * Landscape Material (0xb13556e7 / water 0x8c84cce7) splat parameters. Property 4 is the
 * tiling in cells: u = worldX / tiling, v = worldZ / tiling (verified by correlating the
 * baked floor atlases with the textures: r = 0.986 at the decoded scale and orientation).
 */
export function readLandscapeSplat(pkgs: PackageSet, ref: ResRef): LandscapeSplat | undefined {
  const v = odu(pkgs, ref);
  const t = v && readTemplateWords(v);
  if (!t || (t.cls !== CLASS_LANDSCAPE && t.cls !== CLASS_LANDSCAPE_WATER)) return undefined;
  const r = wordRef(t.words[3]);
  if (!r || !texOk(pkgs, r)) return undefined;
  const tiling = t.words[4] || 1;
  const fade = new Float32Array(new Uint32Array([t.words[7] ?? 0]).buffer)[0];
  return { texture: refKey(r), tiling, fade: Number.isFinite(fade) && fade > 0 ? fade : 20 };
}

/** Stable string identifying how a material draws (for batching identical surfaces). */
export function materialSignature(m: SurfaceMaterial | undefined): string {
  if (!m) return '';
  const l = (x: MaterialLayer) =>
    [
      x.texture ?? '-',
      x.blend,
      x.tint ?? '',
      x.depthWrite ? 'z' : '',
      x.texGen ?? '',
      x.texInput ?? '',
      x.uvScale ?? '',
      x.uvOffset?.join('/') ?? '',
      x.scroll?.key ?? '',
      x.scaleWave?.key ?? '',
      x.fps ?? '',
      x.frames?.length ?? '',
    ].join(',');
  return m.layers.map(l).join('+');
}

/** The one texture to use when a consumer can only draw a single texture per submesh. */
export function singlePassTexture(m: SurfaceMaterial | undefined): string | undefined {
  return m?.fallback?.texture ?? m?.layers[0]?.texture;
}

/**
 * Resolve an .odu material reference to its base texture reference (.tdu entry).
 * Returns undefined when the material has no resolvable texture.
 */
export function resolveMaterialTexture(pkgs: PackageSet, material: ResRef): ResRef | undefined {
  const m = readMaterial(pkgs, material);
  const k = singlePassTexture(m);
  if (!k) return undefined;
  const [pkg, id] = k.split(':').map(Number);
  return { id, pkg };
}

/** true/false if the package's .tdu is known, undefined if it was not supplied. */
function isTexture(pkgs: PackageSet, r: ResRef): boolean | undefined {
  const p = pkgs.get(r.pkg);
  if (!p?.tdu) return undefined;
  return !!findEntry(p.tdu, TDU_TEXTURE, r.id);
}

// ---------------------------------------------------------------------------
// Model geometry

export interface ModelSubmesh {
  /**
   * Global texture key "<pkgDbId>:<texId>" for single-texture consumers (a Layered material's
   * single-pass fallback, else the base layer), or undefined if unresolved. Its alpha channel is
   * only coverage when material.layers[0].blend says so (see SurfaceMaterial).
   */
  textureKey?: string;
  /** Decoded material (blend mode, tint, layers), when the material resolved. */
  material?: SurfaceMaterial;
  /** Index into the model's material list (RiotModel.materials). */
  materialIndex?: number;
  /** Corner-vertex indices (into RiotModel corner arrays), CW-front in model space. */
  indices: Uint32Array;
}

/**
 * A decoded model in its own (Y-up) model space, split into
 * "corner vertices" (unique (vertex, uv) pairs) so it can be emitted indexed.
 */
export interface RiotModel {
  ref: ResRef;
  vertexCount: number;
  /** Source vertex index of each corner vertex (for per-vertex .ldu colours). */
  source: Uint32Array;
  /** xyz per corner vertex. */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  submeshes: ModelSubmesh[];
  materials: ResRef[];
}

/**
 * Face count of an .mdu type-4 entry: a u16 (the next u16 is 0, or 2 on 60 retail models such
 * as the 1a glass shards 9:4498..4500, which a u32 read turned into 131 000+ faces).
 */
export function mduFaceCount(fv: DataView): number | undefined {
  if (fv.byteLength < 4) return undefined;
  const nf = fv.getUint16(0, true);
  return fv.byteLength >= 4 + 36 * nf ? nf : undefined;
}

export function readModel(pkgs: PackageSet, ref: ResRef): RiotModel | undefined {
  const mdu = pkgs.get(ref.pkg)?.mdu;
  const eh = findEntry(mdu, MDU_HEADER, ref.id);
  const ev = findEntry(mdu, MDU_VERTICES, ref.id);
  const ef = findEntry(mdu, MDU_FACES, ref.id);
  if (!mdu || !ev || !ef) return undefined;

  // Materials
  const materials: ResRef[] = [];
  if (eh && eh.size >= 12) {
    const h = mdu.data(eh);
    let p = 8 + (h.getUint8(2) & 2 ? 4 : 0);
    const n = h.getUint32(p, true);
    p += 4;
    for (let i = 0; i < n && p + 4 <= h.byteLength; i++, p += 4) materials.push(readRef(h, p));
  }

  const vv = mdu.data(ev);
  const nv = vv.getUint16(0, true);
  if (ev.size < 2 + 16 * nv) return undefined;
  const fv = mdu.data(ef);
  const nf = mduFaceCount(fv);
  if (nf === undefined) return undefined;

  const uvBase = 4 + 12 * nf;
  const cornerMap = new Map<string, number>();
  const src: number[] = [];
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const byMat = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    const fo = 4 + 12 * f;
    const mat = fv.getUint16(fo + 2, true);
    let list = byMat.get(mat);
    if (!list) byMat.set(mat, (list = []));
    for (let c = 0; c < 3; c++) {
      const vi = fv.getUint16(fo + 4 + 2 * c, true);
      if (vi >= nv) {
        list.length -= c; // drop the partial triangle
        break;
      }
      const u = fv.getFloat32(uvBase + (f * 3 + c) * 8, true);
      const w = fv.getFloat32(uvBase + (f * 3 + c) * 8 + 4, true);
      const key = `${vi},${u},${w}`;
      let ci = cornerMap.get(key);
      if (ci === undefined) {
        ci = src.length;
        cornerMap.set(key, ci);
        src.push(vi);
        pos.push(vv.getFloat32(2 + 12 * vi, true), vv.getFloat32(6 + 12 * vi, true), vv.getFloat32(10 + 12 * vi, true));
        const no = 2 + 12 * nv + 4 * vi;
        nrm.push(vv.getInt8(no) / 127, vv.getInt8(no + 1) / 127, vv.getInt8(no + 2) / 127);
        uv.push(u, w);
      }
      list.push(ci);
    }
  }

  const submeshes: ModelSubmesh[] = [];
  for (const [mat, list] of byMat) {
    const m = materials[mat];
    const material = m ? readMaterial(pkgs, m) : undefined;
    const textureKey = singlePassTexture(material);
    submeshes.push({ textureKey, material, materialIndex: mat, indices: Uint32Array.from(list) });
  }
  return {
    ref,
    vertexCount: nv,
    source: Uint32Array.from(src),
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    uvs: Float32Array.from(uv),
    submeshes,
    materials,
  };
}

/**
 * Standalone model as MeshParts in model units (same axes as LevelData; Y up).
 * Indices are reversed so front faces are counter-clockwise. One part per material.
 */
export function parseModel(pkgs: PackageSet, ref: ResRef): MeshPart[] {
  const m = readModel(pkgs, ref);
  if (!m) return [];
  return m.submeshes.map((s) => {
    const indices = new Uint32Array(s.indices.length);
    for (let t = 0; t + 2 < s.indices.length; t += 3) {
      indices[t] = s.indices[t];
      indices[t + 1] = s.indices[t + 2];
      indices[t + 2] = s.indices[t + 1];
    }
    return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices, textureKey: s.textureKey };
  });
}
