// The original game's save files (SUFFERING.EXE + Suffering.rfl), for import / export.
// Reverse-engineered layout and addresses: docs/re/saves.md. Pure (no DOM), node-testable.
//
// Container (both kinds of file) [verified]
// -----------------------------------------
// Every file is an SRSC container (src/formats/srsc.ts, version 0x0101, 14-byte directory
// entries, payloads 8-byte aligned). Each entry is one "chunk" of the engine's chunk stream
// (EXE class vtable 0x590fc0): its u16 tag is the entry's (type | group << 8) and the payload
// is an independent zlib stream (deflateInit_ "1.1.3", default level; deflateReset between
// chunks). Inside, values are little-endian:
//   u8 / u16 / u32 / f32 / f64      raw
//   string   u16 length + bytes (no terminator)                         (vt+0x34 / +0x10)
//   wstring  u16 byte length + UTF-16LE including the NUL terminator    (vt+0x30 / +0x0c)
//
// Unspeakable.cfg (profile + options; RFL settings object 0x1017ac3c) [verified]
// ------------------------------------------------------------------------------
// One chunk, tag 0x0401 id 0: the fields of OriginalSettings in order (writer 0x10007690,
// reader 0x100077f0), the key table (u32 count + count x {u32 action, u32 device, u32 code,
// f32 lo, f32 hi}), then the u32 trailer 0x600D (written by the EXE profile object's close,
// 0x4308a0; a file without it is treated as invalid and the defaults are used).
//
// <Level>.rsg (a saved game; one file per save, in its own folder) [verified for the layout]
// --------------------------------------------------------------------------------------
// Chunk tag 0 id 0 = header (writer 0x42cf00, reader 0x42b490): u32 version (2), u32 1,
// u32 slot number, u32 chapter object id, string level path, wstring save name, thumbnail.
// Chunk tag 0x0401 id 0 = the world (0x42d010): a short prefix (below) and then a flat
// stream of per-object records whose layout depends on each class's save method (no lengths),
// so only the prefix is decoded here; the rest is kept as bytes.

import { SrscFile } from './srsc';
import { inflateZlib } from './inflate';

export const SRSC_VERSION = 0x0101;
/** Chunk tags (SRSC type | group << 8). */
export const CHUNK_HEADER = 0x0000;
export const CHUNK_BODY = 0x0401;
/** u32 written after the settings chunk; reading anything else invalidates the file. */
export const SETTINGS_TRAILER = 0x600d;
/** The .rsg header's first u32; the loader refuses anything else (0x42b4cb). */
export const RSG_VERSION = 2;
/** File and folder names (RFL string table 0x10169344..0x10169350). */
export const SETTINGS_FILE = 'Unspeakable.cfg';
export const SAVE_DIR = 'Saves\\';
/** Name the in-memory checkpoint gets (EXE 0x58ee1c). */
export const CHECKPOINT_SAVE_NAME = 'Autosave';

// ---------------------------------------------------------------------------
// Byte stream

export class EngineReader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  private get view(): DataView {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }
  get remaining(): number {
    return this.bytes.length - this.pos;
  }
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new Error(`save: read past end (${this.pos} + ${n} > ${this.bytes.length})`);
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    return this.u32() | 0;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytesN(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** u16 length + 8-bit characters (no terminator). */
  string(): string {
    const n = this.u16();
    let s = '';
    for (const c of this.bytesN(n)) s += String.fromCharCode(c);
    return s;
  }
  /** u16 byte length + UTF-16LE (the terminator is part of the length). */
  wstring(): string {
    const n = this.u16();
    const b = this.bytesN(n);
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

export class EngineWriter {
  private buf = new Uint8Array(256);
  private n = 0;
  private grow(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  get length(): number {
    return this.n;
  }
  u8(v: number): this {
    this.grow(1);
    this.buf[this.n++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.grow(2);
    new DataView(this.buf.buffer).setUint16(this.n, v, true);
    this.n += 2;
    return this;
  }
  u32(v: number): this {
    this.grow(4);
    new DataView(this.buf.buffer).setUint32(this.n, v >>> 0, true);
    this.n += 4;
    return this;
  }
  f32(v: number): this {
    this.grow(4);
    new DataView(this.buf.buffer).setFloat32(this.n, v, true);
    this.n += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
    return this;
  }
  string(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  wstring(s: string): this {
    this.u16((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this.u16(0);
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

// ---------------------------------------------------------------------------
// Chunks (SRSC + zlib)

export interface SaveChunk {
  /** type | group << 8 (0x0401 = type 1, group 4). */
  tag: number;
  id: number;
  extra: number;
  /** Inflated payload. */
  data: Uint8Array;
}

export function readChunks(file: ArrayBuffer | Uint8Array): SaveChunk[] {
  const buf = file instanceof Uint8Array ? file.slice().buffer : file;
  const srsc = new SrscFile(buf);
  return srsc.entries.map((e) => {
    const raw = srsc.bytes(e);
    return { tag: e.type | (e.group << 8), id: e.id, extra: e.extra, data: raw.length ? inflateZlib(raw) : new Uint8Array(0) };
  });
}

export function findChunk(chunks: readonly SaveChunk[], tag: number, id = 0): SaveChunk | undefined {
  return chunks.find((c) => c.tag === tag && c.id === id);
}

/** zlib stream of stored (uncompressed) deflate blocks: valid for the engine's inflate. */
export function zlibStore(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 0xffff));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let p = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 0xffff;
    const len = Math.min(0xffff, data.length - start);
    out[p++] = b === blocks - 1 ? 1 : 0;
    out[p++] = len & 0xff;
    out[p++] = len >> 8;
    out[p++] = ~len & 0xff;
    out[p++] = (~len >> 8) & 0xff;
    out.set(data.subarray(start, start + len), p);
    p += len;
  }
  let a = 1, c = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    c = (c + a) % 65521;
  }
  const adler = ((c << 16) | a) >>> 0;
  out[p++] = adler >>> 24;
  out[p++] = (adler >>> 16) & 0xff;
  out[p++] = (adler >>> 8) & 0xff;
  out[p++] = adler & 0xff;
  return out.subarray(0, p);
}

/** Build an SRSC file from chunks (payloads zlib-wrapped, 8-byte aligned, directory last). */
export function writeChunks(chunks: readonly { tag: number; id: number; extra?: number; data: Uint8Array }[]): Uint8Array {
  const payloads = chunks.map((c) => zlibStore(c.data));
  let size = 14;
  const offsets: number[] = [];
  for (const p of payloads) {
    size = (size + 7) & ~7;
    offsets.push(size);
    size += p.length;
  }
  const dir = size;
  size += chunks.length * 14;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0x53, 0x52, 0x53, 0x43], 0);
  v.setUint16(4, SRSC_VERSION, true);
  v.setUint32(6, dir, true);
  v.setUint16(10, chunks.length, true);
  chunks.forEach((c, i) => {
    out.set(payloads[i], offsets[i]);
    const e = dir + i * 14;
    v.setUint16(e, c.tag, true);
    v.setUint16(e + 2, c.id, true);
    v.setUint16(e + 4, c.extra ?? 0, true);
    v.setUint32(e + 6, offsets[i], true);
    v.setUint32(e + 10, payloads[i].length, true);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Unspeakable.cfg

/** Bits of OriginalSettings.flags (settings +0x30). Defaults: 0x10007400. */
export const SettingsFlag = {
  /** Speaker setup: bit 0 and bit 1 encode Mono (neither) / Stereo (bit 0) / Surround (both). */
  SpeakerStereo: 0x1,
  SpeakerSurround: 0x2,
  /** Subtitles on (the subtitle box only shows when set: 0x10069942). Default off. */
  Subtitles: 0x4,
  /** In-game help text (help popups 0x100152e0). Default on. */
  HelpText: 0x8,
  /** Invert pitch (player look code multiplies pitch by -1: 0x10012608, 0x10035a9b). */
  InvertPitch: 0x10,
  /** Controller vibration (handed to the input interface, 0x100b1b23). Default on. */
  Vibration: 0x20,
  /** Console aim option (read in player / weapon code 0x1001920e, 0x1004baa5) [meaning inferred]. */
  Bit6: 0x40,
  Bit7: 0x80,
  /** Environment FX (EAX). Default on when the sound hardware reports support. */
  EnvironmentFx: 0x100,
  /** Set after the file was read successfully (0x100079b4); lets the boot movie be skipped. */
  Loaded: 0x200,
  /** The game was finished once (Game Finished screen 0x100562e1): prelude level + extras. */
  GameFinished: 0x400,
} as const;

/** One control binding (the RFL default table 0x10167520 has the same record). */
export interface KeyBinding {
  /** Input action id (0x3ea Pause, 0x3ff Map, 0x409 Forward...). */
  action: number;
  /** 0 keyboard (code = DirectInput DIK_*), other values mouse / pad devices. */
  device: number;
  code: number;
  /** Axis range of the binding (-1 / 1 on every default record). */
  lo: number;
  hi: number;
}

export interface OriginalSettings {
  /** Settings +0x04 / +0x08 / +0x0c (u32, default 0); +0x08 / +0x0c go to the display interface (vt+0xac / +0xb0) [names unknown]. */
  unknown4: number;
  display8: number;
  displayC: number;
  /** Volumes, 0..1 (default 1): effects (categories 0, 1, 4, 5), dialog (3, 6), music (2). */
  effectsVolume: number;
  dialogVolume: number;
  musicVolume: number;
  /** Look sensitivity multipliers (default 1). */
  turnSensitivity: number;
  pitchSensitivity: number;
  /** Gameplay "Checkpoints": 0 Off, 1 Prompt, 2 On (default 2). */
  checkpoints: number;
  /** Unlocked Archive pages, one bit per page index, per Archive Set (default bit 0 each). */
  archives: [number, number];
  flags: number;
  bindings: KeyBinding[];
  /** False when the 0x600D trailer was missing (the game then falls back to defaults). */
  valid: boolean;
}

export function defaultOriginalSettings(): OriginalSettings {
  return {
    unknown4: 0,
    display8: 0,
    displayC: 0,
    effectsVolume: 1,
    dialogVolume: 1,
    musicVolume: 1,
    turnSensitivity: 1,
    pitchSensitivity: 1,
    checkpoints: 2,
    archives: [1, 1],
    // Stereo + surround + help text + vibration + environment FX (when supported).
    flags: SettingsFlag.SpeakerStereo | SettingsFlag.SpeakerSurround | SettingsFlag.HelpText | SettingsFlag.Vibration | SettingsFlag.EnvironmentFx,
    bindings: [],
    valid: true,
  };
}

export function parseOriginalSettingsPayload(data: Uint8Array): OriginalSettings {
  const r = new EngineReader(data);
  const s = defaultOriginalSettings();
  s.unknown4 = r.u32();
  s.display8 = r.u32();
  s.displayC = r.u32();
  s.effectsVolume = r.f32();
  s.dialogVolume = r.f32();
  s.musicVolume = r.f32();
  s.turnSensitivity = r.f32();
  s.pitchSensitivity = r.f32();
  s.checkpoints = r.u32();
  s.archives = [r.u32(), r.u32()];
  s.flags = r.u32();
  const n = r.u32();
  if (n > 4096) throw new Error(`settings: implausible key count ${n}`);
  s.bindings = [];
  for (let i = 0; i < n; i++) s.bindings.push({ action: r.u32(), device: r.u32(), code: r.u32(), lo: r.f32(), hi: r.f32() });
  s.valid = r.remaining >= 4 && r.u32() === SETTINGS_TRAILER;
  return s;
}

export function writeOriginalSettingsPayload(s: OriginalSettings): Uint8Array {
  const w = new EngineWriter()
    .u32(s.unknown4)
    .u32(s.display8)
    .u32(s.displayC)
    .f32(s.effectsVolume)
    .f32(s.dialogVolume)
    .f32(s.musicVolume)
    .f32(s.turnSensitivity)
    .f32(s.pitchSensitivity)
    .u32(s.checkpoints)
    .u32(s.archives[0])
    .u32(s.archives[1])
    .u32(s.flags)
    .u32(s.bindings.length);
  for (const b of s.bindings) w.u32(b.action).u32(b.device).u32(b.code).f32(b.lo).f32(b.hi);
  return w.u32(SETTINGS_TRAILER).finish();
}

/** Parse Unspeakable.cfg. */
export function parseOriginalSettings(file: ArrayBuffer | Uint8Array): OriginalSettings {
  const c = findChunk(readChunks(file), CHUNK_BODY);
  if (!c) throw new Error('settings: no 0x0401 chunk');
  return parseOriginalSettingsPayload(c.data);
}

/** Write Unspeakable.cfg. */
export function writeOriginalSettings(s: OriginalSettings): Uint8Array {
  return writeChunks([{ tag: CHUNK_BODY, id: 0, data: writeOriginalSettingsPayload(s) }]);
}

export function speakerSetup(flags: number): 'mono' | 'stereo' | 'surround' {
  return flags & SettingsFlag.SpeakerSurround ? 'surround' : flags & SettingsFlag.SpeakerStereo ? 'stereo' : 'mono';
}

/** Unlocked page indices of Archive Set `set` (0 or 1). */
export function archivePages(s: Pick<OriginalSettings, 'archives'>, set: 0 | 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if ((s.archives[set] >>> i) & 1) out.push(i);
  return out;
}

/** The port's settings fields an imported profile maps to (src/app/menu/settings.ts). */
export interface PortSettingsFromOriginal {
  sfx: number;
  voice: number;
  music: number;
  mouseSensitivity: number;
  pitchSensitivity: number;
  invertY: boolean;
  subtitles: boolean;
  extra: { checkpoints: number; helpText: boolean; environmentFx: number; vibration: boolean };
  gameFinished: boolean;
  /** [set, page index] of every unlocked Archive page. */
  archivePages: [number, number][];
}

export function originalSettingsToPort(s: OriginalSettings): PortSettingsFromOriginal {
  const clamp = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);
  return {
    sfx: clamp(s.effectsVolume, 0, 1),
    voice: clamp(s.dialogVolume, 0, 1),
    music: clamp(s.musicVolume, 0, 1),
    mouseSensitivity: clamp(s.turnSensitivity, 0.25, 4),
    pitchSensitivity: clamp(s.pitchSensitivity, 0.25, 4),
    invertY: !!(s.flags & SettingsFlag.InvertPitch),
    subtitles: !!(s.flags & SettingsFlag.Subtitles),
    extra: {
      checkpoints: s.checkpoints >= 0 && s.checkpoints <= 2 ? s.checkpoints : 2,
      helpText: !!(s.flags & SettingsFlag.HelpText),
      // Port row: choice 0 = On, 1 = Off.
      environmentFx: s.flags & SettingsFlag.EnvironmentFx ? 0 : 1,
      vibration: !!(s.flags & SettingsFlag.Vibration),
    },
    gameFinished: !!(s.flags & SettingsFlag.GameFinished),
    archivePages: [0, 1].flatMap((set) => archivePages(s, set as 0 | 1).map((p) => [set, p] as [number, number])),
  };
}

/**
 * Export: the port's settings written over an original profile `base` (the player's imported
 * Unspeakable.cfg, else defaults with the RFL's default bindings). The fields the port has no
 * equivalent of (speaker setup, flags 0x40 / 0x80, +0x04..+0x0c, the bindings) keep `base`'s
 * values; Archive pages and the "finished" flag are the union of both.
 */
export function portSettingsToOriginal(p: PortSettingsFromOriginal, base: OriginalSettings): OriginalSettings {
  const clamp = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : 1);
  const bit = (flags: number, f: number, on: boolean) => (on ? flags | f : flags & ~f);
  let flags = base.flags;
  flags = bit(flags, SettingsFlag.Subtitles, p.subtitles);
  flags = bit(flags, SettingsFlag.HelpText, p.extra.helpText);
  flags = bit(flags, SettingsFlag.InvertPitch, p.invertY);
  flags = bit(flags, SettingsFlag.Vibration, p.extra.vibration);
  flags = bit(flags, SettingsFlag.EnvironmentFx, p.extra.environmentFx === 0);
  if (p.gameFinished) flags |= SettingsFlag.GameFinished;
  // "Read successfully" is the reader's to set (0x100079b4), not the file's.
  flags &= ~SettingsFlag.Loaded;
  const archives: [number, number] = [base.archives[0] | 1, base.archives[1] | 1];
  for (const [set, page] of p.archivePages) if ((set === 0 || set === 1) && page >= 0 && page < 32) archives[set] = (archives[set] | (1 << page)) >>> 0;
  return {
    ...base,
    effectsVolume: clamp(p.sfx, 0, 1),
    dialogVolume: clamp(p.voice, 0, 1),
    musicVolume: clamp(p.music, 0, 1),
    turnSensitivity: clamp(p.mouseSensitivity, 0.25, 4),
    pitchSensitivity: clamp(p.pitchSensitivity, 0.25, 4),
    checkpoints: p.extra.checkpoints >= 0 && p.extra.checkpoints <= 2 ? p.extra.checkpoints : 2,
    archives,
    flags,
    bindings: base.bindings.map((b) => ({ ...b })),
    valid: true,
  };
}

/** VA of the RFL's default control table (records as KeyBinding, ended by action 0xFFFFFFFF). */
export const RFL_DEFAULT_BINDINGS = 0x10167520;

/**
 * The default bindings from the user's Suffering.rfl (`readPe` / `peOffset` give the file
 * offset): the table 0x10006c80 walks until the action is -1 [verified]. That routine also adds
 * controller entries of its own, so a profile written from this table alone has the keyboard /
 * mouse defaults only [inferred].
 */
export function readDefaultBindings(rfl: Uint8Array, offset: number, max = 512): KeyBinding[] {
  const r = new EngineReader(rfl.subarray(offset));
  const out: KeyBinding[] = [];
  while (out.length < max && r.remaining >= 20) {
    const action = r.u32();
    if (action === 0xffffffff) break;
    out.push({ action, device: r.u32(), code: r.u32(), lo: r.f32(), hi: r.f32() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// <Level>.rsg

export interface SaveThumbnail {
  width: number;
  height: number;
  /** Engine texture format code [values not mapped]. */
  format: number;
  /** Raw locked surface (pitch x height bytes). */
  data: Uint8Array;
}

export interface OriginalSaveHeader {
  version: number;
  /** Second u32, always 1 when written (0x42cf46); the loader keeps it in a global (0x5b9a04). */
  flag: number;
  /** Slot number: the lowest positive number not used by another save (0x42f850). */
  slot: number;
  /** Id of the object the save is named after (the chapter; resolved by the loader). */
  chapterId: number;
  /** Level path (as the engine loads it). */
  levelPath: string;
  /** Display name (UTF-16; the chapter title, or "Autosave" for the in-memory checkpoint). */
  name: string;
  thumbnail?: SaveThumbnail;
}

export function parseSaveHeaderPayload(data: Uint8Array): OriginalSaveHeader {
  const r = new EngineReader(data);
  const version = r.u32();
  if (version !== RSG_VERSION) throw new Error(`rsg: unsupported version ${version}`);
  const h: OriginalSaveHeader = { version, flag: r.u32(), slot: r.u32(), chapterId: r.u32(), levelPath: r.string(), name: r.wstring() };
  if (r.remaining >= 4 && r.u32() === 1) {
    const width = r.u32(), height = r.u32(), format = r.u32(), size = r.u32();
    h.thumbnail = { width, height, format, data: r.bytesN(size) };
  }
  return h;
}

export function writeSaveHeaderPayload(h: Omit<OriginalSaveHeader, 'version'> & { version?: number }): Uint8Array {
  const w = new EngineWriter()
    .u32(h.version ?? RSG_VERSION)
    .u32(h.flag)
    .u32(h.slot)
    .u32(h.chapterId)
    .string(h.levelPath)
    .wstring(h.name);
  if (h.thumbnail) {
    const t = h.thumbnail;
    w.u32(1).u32(t.width).u32(t.height).u32(t.format).u32(t.data.length).bytes(t.data);
  } else w.u32(0);
  return w.finish();
}

/** The decoded start of the world chunk (0x42d010). */
export interface OriginalSaveBodyPrefix {
  /** One u32 per entry of the engine's loaded-database table (0x5cbe40, 12-byte entries). */
  databases: number[];
  /** Object table size (world +0x328 + +0x31c). */
  objectCount: number;
  /** EXE global 0x5c6e98 [meaning unknown]. */
  value1: number;
  /** Id resolved from the current level-info object (+0x24) [meaning unknown]. */
  value2: number;
  /** f32 from the same object (+0x28) [meaning unknown]. */
  value3: number;
  /** Offset of the first byte not decoded (subsystem state, then per-object records). */
  rest: number;
}

export function parseSaveBodyPrefix(data: Uint8Array): OriginalSaveBodyPrefix {
  const r = new EngineReader(data);
  const n = r.u32();
  if (n > 65536) throw new Error(`rsg: implausible database count ${n}`);
  const databases: number[] = [];
  for (let i = 0; i < n; i++) databases.push(r.u32());
  return { databases, objectCount: r.u32(), value1: r.u32(), value2: r.u32(), value3: r.f32(), rest: r.pos };
}

export interface OriginalSave {
  header: OriginalSaveHeader;
  body?: OriginalSaveBodyPrefix;
  /** Inflated world chunk (kept whole: per-class records are not decoded). */
  bodyBytes?: Uint8Array;
  chunks: SaveChunk[];
}

/** Parse a <Level>.rsg file: header fully, world chunk prefix only. */
export function parseOriginalSave(file: ArrayBuffer | Uint8Array): OriginalSave {
  const chunks = readChunks(file);
  const hc = findChunk(chunks, CHUNK_HEADER);
  if (!hc) throw new Error('rsg: no header chunk');
  const out: OriginalSave = { header: parseSaveHeaderPayload(hc.data), chunks };
  const bc = findChunk(chunks, CHUNK_BODY);
  if (bc) {
    out.bodyBytes = bc.data;
    try {
      out.body = parseSaveBodyPrefix(bc.data);
    } catch {
      /* truncated / foreign body: header still usable for a listing */
    }
  }
  return out;
}

/** Folder name the engine gives a new save: hex of time(NULL) + 1, bumped until unused (0x42f6d9). */
export function saveFolderName(unixSeconds: number, taken: ReadonlySet<string> = new Set()): string {
  let n = Math.floor(unixSeconds) + 1;
  while (taken.has(n.toString(16))) n++;
  return n.toString(16);
}

/** Lowest positive slot number not used by `used` (0x42f850). */
export function nextSlotNumber(used: Iterable<number>): number {
  const s = new Set(used);
  let n = 1;
  while (s.has(n)) n++;
  return n;
}
