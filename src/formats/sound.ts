// Riot Engine sound packages (.sdu), plus the small helpers sounds point at:
// subtitles (.xdu strings), lip-sync envelopes (.sdu type 5) and placed sound
// emitters in levels (.odu templates + .lvl property overrides).
//
// .sdu (SRSC, every sound entry in group 3; ids are per package)
// -------------------------------------------------------------
//   type 0x02 g4  container header (10 bytes, like every package)
//   type 0x02 g3  SOUND HEADER, always 60 bytes:
//     +0x00 u32  category: 0 effect, 1 ambient, 2 music, 3 movie, 4 GUI, 5 (interface stingers), 6 dialog
//     +0x04 u32  0..10000: linear amplitude x 10000 (applied as the default play volume)
//     +0x08 u32  flags; 0x8 = looping (all music/ambient beds carry it). Always has 0x2 and 0x10000.
//     +0x0c u32  priority word, usually 0x55; priority = (v >> 4) & 15 (audio-rules.ts)
//     +0x10 f32  random pitch variation in percent (ignored on PC), usually 0
//     +0x14 f32  3D min distance (model units; often 0)
//     +0x18 f32  3D max distance (model units; 2..250, typically 40-90)
//     +0x1c f32  usually 1.0
//     +0x20 f32  usually 2.0
//     +0x24 ref  (u16 id, u16 pkg) subtitle string in that package's .xdu (dialog lines), or 0
//     +0x28 ref  (u16 id, u16 pkg) force-feedback waveform in that package's .wdu, or 0
//     +0x2c u16  channels (1 or 2)
//     +0x2e u16  bits per sample (always 16)
//     +0x30 u32  sample rate (32000, 22050, 11025, 8000, 16000, 6000, 44100, 2000 seen)
//     +0x34 u32  0
//     +0x38 u32  payload size in bytes (== size of the type-3 entry)
//   type 0x03 g3  SAMPLE DATA, same id: raw little-endian signed 16-bit PCM, interleaved.
//                 Every retail sound (3187 in 16 files) is PCM16 — no ADPCM on PC.
//                 There are no loop points: looping sounds loop the whole buffer.
//   type 0x05 g3  LIP-SYNC envelope (dialog only), same id:
//                 u32 0, u32 44100, u32 1764 (samples per frame at 44.1 kHz => 25 fps),
//                 u32 ?, u32 count, count x u16 mouth-open amplitude (0..0x7fff).
//   The SRSC entry `extra` field groups sounds by source folder; there are no names.
//
// .xdu (strings): type 0x00 g4 entries = u16 byteLength + UTF-16LE text (subtitles, UI text).
// .wdu ("Waveform"): type 0x60 entries are controller rumble curves, not audio:
//   u32 0, u16 2 (motors), u16 8 (bits), u32 rate (20/30 Hz), u32 0, u32 n, n x u8 interleaved.
//
// Sound keys are "pkg:id" (package .db id : sound entry id), the same pair the
// rest of the data uses to reference a sound.

import type { SrscEntry, SrscFile } from './srsc';
import type { LevelObject } from './level';
import type { PackageSet, ResRef } from './model';

export const SDU_GROUP = 3;
export const SDU_HEADER = 0x02;
export const SDU_DATA = 0x03;
export const SDU_LIPSYNC = 0x05;
export const SOUND_HEADER_SIZE = 60;
export const SOUND_FLAG_LOOP = 0x8;

export const SoundCategory = {
  Effect: 0,
  Ambient: 1,
  Music: 2,
  Movie: 3,
  Gui: 4,
  Interface5: 5,
  Dialog: 6,
} as const;
const CATEGORY_NAMES = ['effect', 'ambient', 'music', 'movie', 'gui', 'interface', 'dialog'];

export const soundKey = (pkg: number, id: number) => `${pkg}:${id}`;

export function parseSoundKey(key: string): ResRef {
  const [pkg, id] = key.split(':').map(Number);
  return { pkg, id };
}

/** Everything known about one sound without touching its sample data. */
export interface SoundInfo {
  key: string;
  pkg: number;
  id: number;
  category: number;
  categoryName: string;
  flags: number;
  loop: boolean;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  codec: 'pcm16';
  frames: number;
  duration: number;
  /** Absolute file offset/size of the sample payload (type 3 entry). */
  dataOffset: number;
  dataSize: number;
  /** Absolute file offset/size of the lip-sync envelope (type 5 entry), dialog only. */
  lipsync?: { offset: number; size: number };
  minDistance: number;
  maxDistance: number;
  /** Header +0x04 / 10000: linear amplitude (default play volume). */
  volume: number;
  priority: number;
  /** Subtitle string (.xdu) reference. */
  subtitle?: ResRef;
  /** Force-feedback curve (.wdu) reference. */
  rumble?: ResRef;
  /** Directory `extra` field (source-folder grouping). */
  group: number;
  /** Unidentified header floats at +0x10, +0x1c, +0x20. */
  params: [number, number, number];
}

export interface DecodedSound {
  key: string;
  sampleRate: number;
  channels: number;
  /** One Float32Array per channel, samples in [-1, 1). */
  pcm: Float32Array[];
  /** Frame range to loop (whole buffer for looping sounds). */
  loop?: { start: number; end: number };
}

const readRef = (v: DataView, o: number): ResRef | undefined => {
  const id = v.getUint16(o, true);
  const pkg = v.getUint16(o + 2, true);
  return pkg || id ? { id, pkg } : undefined;
};

/** Parse a 60-byte sound header. `dataEntry`/`lipEntry` supply absolute payload locations. */
export function parseSoundHeader(
  v: DataView,
  pkg: number,
  id: number,
  dataEntry: { offset: number; size: number } | undefined,
  lipEntry?: { offset: number; size: number },
  group = 0,
): SoundInfo {
  if (v.byteLength < SOUND_HEADER_SIZE) throw new Error(`sound ${pkg}:${id}: header is ${v.byteLength} bytes`);
  const category = v.getUint32(0x00, true);
  const flags = v.getUint32(0x08, true);
  const channels = v.getUint16(0x2c, true);
  const bitsPerSample = v.getUint16(0x2e, true);
  const sampleRate = v.getUint32(0x30, true);
  const declared = v.getUint32(0x38, true);
  if (bitsPerSample !== 16) throw new Error(`sound ${pkg}:${id}: unsupported ${bitsPerSample}-bit samples`);
  if (channels < 1 || channels > 2) throw new Error(`sound ${pkg}:${id}: ${channels} channels`);
  if (sampleRate < 1000 || sampleRate > 96000) throw new Error(`sound ${pkg}:${id}: sample rate ${sampleRate}`);
  const dataSize = Math.min(dataEntry?.size ?? 0, declared || Infinity);
  const frames = Math.floor(dataSize / (2 * channels));
  return {
    key: soundKey(pkg, id),
    pkg,
    id,
    category,
    categoryName: CATEGORY_NAMES[category] ?? `cat${category}`,
    flags,
    loop: (flags & SOUND_FLAG_LOOP) !== 0,
    sampleRate,
    channels,
    bitsPerSample,
    codec: 'pcm16',
    frames,
    duration: frames / sampleRate,
    dataOffset: dataEntry?.offset ?? 0,
    dataSize,
    lipsync: lipEntry && { offset: lipEntry.offset, size: lipEntry.size },
    minDistance: v.getFloat32(0x14, true),
    maxDistance: v.getFloat32(0x18, true),
    volume: v.getUint32(0x04, true) / 10000,
    priority: v.getUint32(0x0c, true),
    subtitle: readRef(v, 0x24),
    rumble: readRef(v, 0x28),
    group,
    params: [v.getFloat32(0x10, true), v.getFloat32(0x1c, true), v.getFloat32(0x20, true)],
  };
}

/** Decode interleaved little-endian PCM16 into per-channel float arrays. */
export function decodePcm16(bytes: Uint8Array, channels: number, frames?: number): Float32Array[] {
  const n = Math.min(frames ?? Infinity, Math.floor(bytes.byteLength / (2 * channels)));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let c = 0; c < channels; c++) {
    const dst = out[c];
    for (let i = 0, p = 2 * c; i < n; i++, p += 2 * channels) dst[i] = v.getInt16(p, true) / 32768;
  }
  return out;
}

function finish(info: SoundInfo, pcm: Float32Array[]): DecodedSound {
  const frames = pcm[0]?.length ?? 0;
  return {
    key: info.key,
    sampleRate: info.sampleRate,
    channels: info.channels,
    pcm,
    loop: info.loop ? { start: 0, end: frames } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Synchronous API over an in-memory SrscFile (tools, small files)

/** List every sound in a loaded .sdu (headers only; no sample decoding). */
export function indexSounds(file: SrscFile, pkg: number): SoundInfo[] {
  const byKey = (t: number) => {
    const m = new Map<number, SrscEntry>();
    for (const e of file.entries) if (e.type === t && e.group === SDU_GROUP) m.set(e.id, e);
    return m;
  };
  const data = byKey(SDU_DATA);
  const lip = byKey(SDU_LIPSYNC);
  const out: SoundInfo[] = [];
  for (const e of file.entries) {
    if (e.type !== SDU_HEADER || e.group !== SDU_GROUP) continue;
    out.push(parseSoundHeader(file.data(e), pkg, e.id, data.get(e.id), lip.get(e.id), e.extra));
  }
  return out;
}

/** Decode one sound from a loaded .sdu. */
export function decodeSound(file: SrscFile, info: SoundInfo): DecodedSound {
  const bytes = new Uint8Array(file.buffer, info.dataOffset, info.dataSize);
  return finish(info, decodePcm16(bytes, info.channels, info.frames));
}

// ---------------------------------------------------------------------------
// Lazy API over byte ranges (browser: File.slice / HTTP Range). Never reads the
// whole file: the index costs one directory read plus one 60-byte read per sound.

/** Read `length` bytes at absolute `offset`. */
export type RangeReader = (offset: number, length: number) => Promise<ArrayBuffer>;

/** Read just the SRSC directory of a file through a RangeReader. */
export async function readSrscDirectory(read: RangeReader): Promise<SrscEntry[]> {
  const head = new DataView(await read(0, 14));
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== 'SRSC') throw new Error(`Not an SRSC file (magic "${magic}")`);
  const dirOffset = head.getUint32(6, true);
  const count = head.getUint16(10, true);
  const dir = new DataView(await read(dirOffset, count * 14));
  const out: SrscEntry[] = [];
  for (let i = 0; i < count; i++) {
    const p = i * 14;
    out.push({
      index: i,
      type: dir.getUint8(p),
      group: dir.getUint8(p + 1),
      id: dir.getUint16(p + 2, true),
      extra: dir.getUint16(p + 4, true),
      offset: dir.getUint32(p + 6, true),
      size: dir.getUint32(p + 10, true),
    });
  }
  return out;
}

/** Index a .sdu lazily. `concurrency` bounds parallel header reads. */
export async function indexSoundsLazy(read: RangeReader, pkg: number, concurrency = 256): Promise<SoundInfo[]> {
  const entries = await readSrscDirectory(read);
  const data = new Map<number, SrscEntry>();
  const lip = new Map<number, SrscEntry>();
  const heads: SrscEntry[] = [];
  for (const e of entries) {
    if (e.group !== SDU_GROUP) continue;
    if (e.type === SDU_DATA) data.set(e.id, e);
    else if (e.type === SDU_LIPSYNC) lip.set(e.id, e);
    else if (e.type === SDU_HEADER) heads.push(e);
  }
  const out: SoundInfo[] = new Array(heads.length);
  let next = 0;
  const worker = async () => {
    while (next < heads.length) {
      const i = next++;
      const e = heads[i];
      const v = new DataView(await read(e.offset, e.size));
      out[i] = parseSoundHeader(v, pkg, e.id, data.get(e.id), lip.get(e.id), e.extra);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, heads.length) }, worker));
  return out;
}

/** Decode one sound by reading only its payload. */
export async function decodeSoundLazy(read: RangeReader, info: SoundInfo): Promise<DecodedSound> {
  const bytes = new Uint8Array(await read(info.dataOffset, info.dataSize));
  return finish(info, decodePcm16(bytes, info.channels, info.frames));
}

// ---------------------------------------------------------------------------
// Lip-sync and subtitles

export interface LipSync {
  /** Envelope frames per second (25). */
  fps: number;
  /** Mouth-open amount per frame, 0..1. */
  values: Float32Array;
}

export function parseLipSync(v: DataView): LipSync | undefined {
  if (v.byteLength < 20) return undefined;
  const rate = v.getUint32(4, true);
  const step = v.getUint32(8, true);
  const n = v.getUint32(16, true);
  if (!rate || !step || 20 + 2 * n > v.byteLength) return undefined;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = v.getUint16(20 + 2 * i, true) / 0x7fff;
  return { fps: rate / step, values };
}

export const XDU_STRING = 0x00;

/** Decode an .xdu string entry (u16 byte length + UTF-16LE). */
export function parseXduString(v: DataView): string {
  const len = Math.min(v.getUint16(0, true), v.byteLength - 2);
  let s = '';
  for (let p = 2; p + 1 < 2 + len; p += 2) {
    const c = v.getUint16(p, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// Object templates (.odu type 2) and placed sound emitters
//
// Template layout (verified on 13586 of 13624 retail templates):
//   +0  ref model (0 if none), +4 u32 flags, +8 u32, +12 u16 hasBounds,
//   [64 bytes bounds/transform if hasBounds], u32 class hash, u16 ?,
//   u32 propCount, u32 wordCount, wordCount x u32 words.
//   The first propCount words are the property values; a list-valued property
//   is stored as (u16 wordOffset, u16 count) pointing at its items further on
//   in the same word array.
// Level instances override properties: LevelObject.propIndices[k] is a
// property index and propWords[k] its value, with list values encoded the same
// way (offset/count into propWords).
//
// Classes that carry sounds (property index -> sound list):
//   0xed6b2ff8 "sound" object (Sound Effect): p0 sound list, p3 play mode, p6 / p7 the
//              re-trigger interval and jitter (not a radius: the voice keeps the header's
//              distances), p12 / p13 stop / start fades (src/game/world/sound-effect.ts).
//              Used for both positional effects and script-triggered dialog; looping sounds
//              are ambient beds.
//   0xcd739b63 "Combat Music": p0 music list (category 2, looping). Started by level-logic
//              messages, never at load (src/game/world/music.ts, docs/game-logic.md §11.6).
//   0xe6ec6c84 Ambient Sound: a crossfade zone, p1..p4 / p5..p8 ambient beds (kind 'loop'
//              here). Run by src/game/fx/ambient.ts in a level, not as positional loops.
//   0x86a01249 Animating Static (kind 'zone' here): p23/p24/p39 one-shots, p37/p40 sounds.
//   0xbd83621b Flying Sound: p3 list of sounds moved along a path (kind 'ambient-set' here;
//              run by src/game/fx/flying.ts). See docs/game-logic.md §17.4.

export const CLASS_SOUND = 0xed6b2ff8;
export const CLASS_MUSIC = 0xcd739b63;
export const CLASS_LOOP_EMITTER = 0xe6ec6c84;
export const CLASS_ZONE = 0x86a01249;
export const CLASS_AMBIENT_SET = 0xbd83621b;

export interface ObjectTemplate {
  model?: ResRef;
  classHash: number;
  propCount: number;
  words: Uint32Array;
}

export function parseObjectTemplate(v: DataView): ObjectTemplate | undefined {
  if (v.byteLength < 28) return undefined;
  let p = 12;
  const hasBounds = v.getUint16(p, true);
  p += 2 + (hasBounds ? 64 : 0);
  if (p + 14 > v.byteLength) return undefined;
  const classHash = v.getUint32(p, true);
  const propCount = v.getUint32(p + 6, true);
  const wordCount = v.getUint32(p + 10, true);
  p += 14;
  if (p + 4 * wordCount > v.byteLength || propCount > wordCount) return undefined;
  const words = new Uint32Array(wordCount);
  for (let i = 0; i < wordCount; i++) words[i] = v.getUint32(p + 4 * i, true);
  return { model: readRef(v, 0), classHash, propCount, words };
}

function propValue(words: ArrayLike<number>, i: number, scalars: number): number[] {
  const w = words[i] >>> 0;
  const off = w & 0xffff;
  const n = w >>> 16;
  if (n > 0 && off >= scalars && off + n <= words.length) return Array.from({ length: n }, (_, k) => words[off + k] >>> 0);
  return [w];
}

/** Effective property values of a placed object: template defaults + instance overrides. */
export function resolveObjectProperties(tmpl: ObjectTemplate, obj?: Pick<LevelObject, 'propWords' | 'propIndices'>): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let i = 0; i < tmpl.propCount; i++) m.set(i, propValue(tmpl.words, i, tmpl.propCount));
  if (obj) {
    const n = obj.propIndices.length;
    for (let k = 0; k < n && k < obj.propWords.length; k++) m.set(obj.propIndices[k], propValue(obj.propWords, k, n));
  }
  return m;
}

const f32 = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];

export type EmitterKind = 'sound' | 'music' | 'loop' | 'zone' | 'ambient-set';

export interface SoundEmitter {
  uid: number;
  kind: EmitterKind;
  classHash: number;
  template: ResRef;
  /** Output space (model units), same as LevelData / the renderer. */
  position: [number, number, number];
  /** First (or only) sound; `soundKeys` holds all candidates (the game picks randomly). */
  soundKey: string;
  soundKeys: string[];
  /** Audible radius in model units: the sound header's max distance. */
  radius?: number;
  /** Header min distance of the first sound (full volume inside it). */
  minDistance?: number;
  loop: boolean;
  category: number;
}

/** Anything that can tell whether a key is a known sound (e.g. Map<string, SoundInfo>). */
export interface SoundLookup {
  get(key: string): SoundInfo | undefined;
}

/**
 * Find placed sound emitters / music / ambient zones in a level.
 * `packages` must hold the .odu of every template package (as built by the loader);
 * `sounds` should contain the index of every .sdu in the level's dependency packages.
 */
export function levelSoundEmitters(objects: LevelObject[], packages: PackageSet, sounds: SoundLookup): SoundEmitter[] {
  const cache = new Map<string, ObjectTemplate | null>();
  const template = (r: ResRef) => {
    const k = `${r.pkg}:${r.id}`;
    let t = cache.get(k);
    if (t === undefined) {
      const f = packages.get(r.pkg)?.odu;
      const e = f?.entries.find((x) => x.type === 2 && x.id === r.id);
      t = (e && f && parseObjectTemplate(f.data(e))) || null;
      cache.set(k, t);
    }
    return t;
  };
  const toKeys = (vals: number[] | undefined) =>
    (vals ?? []).map((w) => soundKey(w >>> 16, w & 0xffff)).filter((k) => sounds.get(k));

  const out: SoundEmitter[] = [];
  for (const o of objects) {
    const t = template(o.template);
    if (!t) continue;
    let kind: EmitterKind;
    let props: number[];
    switch (t.classHash) {
      case CLASS_SOUND:
        kind = 'sound';
        props = [0];
        break;
      case CLASS_MUSIC:
        kind = 'music';
        props = [0];
        break;
      case CLASS_LOOP_EMITTER:
        kind = 'loop';
        props = [1, 5];
        break;
      case CLASS_ZONE:
        kind = 'zone';
        props = [37, 40, 23, 24, 39];
        break;
      case CLASS_AMBIENT_SET:
        kind = 'ambient-set';
        props = [3];
        break;
      default:
        continue;
    }
    const m = resolveObjectProperties(t, o);
    const keys = [...new Set(props.flatMap((i) => toKeys(m.get(i))))];
    if (!keys.length) continue;
    const first = sounds.get(keys[0])!;
    // The header's max distance (a Sound Effect's p6 is its re-trigger interval, not a range).
    const radius = first.maxDistance > 0 ? first.maxDistance : undefined;
    out.push({
      uid: o.uid,
      kind,
      classHash: t.classHash,
      template: o.template,
      position: [o.position[0] / 2048, o.position[1] / 2048, o.position[2] / 2048],
      soundKey: keys[0],
      soundKeys: keys,
      radius,
      minDistance: first.minDistance,
      loop: keys.some((k) => sounds.get(k)!.loop),
      category: first.category,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WAV export (tools / debugging)

export function encodeWav(s: DecodedSound): Uint8Array {
  const frames = s.pcm[0]?.length ?? 0;
  const bytes = frames * s.channels * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, s.channels, true);
  v.setUint32(24, s.sampleRate, true);
  v.setUint32(28, s.sampleRate * s.channels * 2, true);
  v.setUint16(32, s.channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, bytes, true);
  let p = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < s.channels; c++, p += 2) v.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(s.pcm[c][i] * 32768))), true);
  return new Uint8Array(buf);
}
