// Loads what the front end needs from the interface package: fonts + glyph
// atlases (.fdu/.tdu), strings (.xdu), a few images (.tdu) and the menu sound
// bank (.sdu, mounted lazily on the AudioSystem). Textures are read by range
// (only the needed entries of the 19 MB .tdu are fetched).

import type { GameFS } from '../gamefs';
import type { AudioSystem } from '../audio';
import { SrscFile, type SrscEntry } from '../../formats/srsc';
import { readFonts, type Font, type FontAtlas } from '../../formats/font';
import { StringDb, normalizeNewlines } from '../../formats/strings';
import { decodeTexture, TEXTURE_ENTRY_TYPE } from '../../formats/texture';
import type { Label, MenuModel } from './model';

/** Every Interface texture id the model draws. */
function modelTextures(m: MenuModel): number[] {
  const out: (number | undefined)[] = [m.images.arrowLeft, m.images.arrowRight, m.images.cursor];
  for (const i of m.images.logo) out.push(i.texture);
  if (m.boot.copyright) out.push(...m.boot.copyright.tiles);
  out.push(...(m.loading.newGame?.tiles ?? []), ...(m.loading.default?.tiles ?? []), m.loading.meter?.frame?.texture);
  for (const sc of Object.values(m.screens)) {
    for (const i of [...(sc.titleImages ?? []), ...(sc.images ?? [])]) out.push(i.texture);
    for (const it of sc.items) if (it.type === 'slider') out.push(it.meter?.frame?.texture);
    if (sc.saves) out.push(sc.saves.border?.texture, sc.saves.arrows?.up?.texture, sc.saves.arrows?.down?.texture);
  }
  return out.filter((x): x is number => x !== undefined);
}
import { BitmapFont } from './text';

export interface MenuAssets {
  pkg: number;
  strings: StringDb;
  fonts: { ui: BitmapFont; title: BitmapFont };
  /** Every font of the interface package by .fdu id. */
  fontById: Map<number, BitmapFont>;
  /** Raw font + atlases (e.g. for cutscene subtitles). */
  uiFont: { font: Font; atlases: FontAtlas[] };
  images: Map<number, HTMLCanvasElement>;
  label(l: Label): string;
  /** Loads more Interface textures into `images` (read by range; archive pages). */
  loadImages(ids: number[]): Promise<void>;
}

/** Reads the `id N` line of a package .db. */
async function packageId(fs: GameFS, base: string): Promise<number> {
  const db = await fs.resolve(`${base}.db`);
  if (!db) return 0;
  const m = /^\s*id\s+(\d+)/m.exec(new TextDecoder().decode(await fs.read(db)));
  return m ? Number(m[1]) : 0;
}

/**
 * Reads only the directory and the selected entries of an SRSC file, and
 * returns a compact SrscFile containing just those entries.
 */
export async function readSrscSubset(fs: GameFS, path: string, want: (e: SrscEntry) => boolean): Promise<SrscFile> {
  const head = new DataView(await fs.readRange(path, 0, 14));
  const dirOffset = head.getUint32(6, true);
  const count = head.getUint16(10, true);
  const dirBuf = new Uint8Array(await fs.readRange(path, dirOffset, count * 14));
  const dv = new DataView(dirBuf.buffer);
  const picked: { dir: Uint8Array; offset: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const p = i * 14;
    const e: SrscEntry = {
      index: i,
      type: dv.getUint8(p),
      group: dv.getUint8(p + 1),
      id: dv.getUint16(p + 2, true),
      extra: dv.getUint16(p + 4, true),
      offset: dv.getUint32(p + 6, true),
      size: dv.getUint32(p + 10, true),
    };
    if (want(e)) picked.push({ dir: dirBuf.slice(p, p + 14), offset: e.offset, size: e.size });
  }
  const payloads = await Promise.all(picked.map((e) => fs.readRange(path, e.offset, e.size)));
  const total = 14 + picked.reduce((n, e) => n + e.size, 0) + picked.length * 14;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  out.set([0x53, 0x52, 0x53, 0x43]); // "SRSC"
  ov.setUint16(4, 0x0101, true);
  let at = 14;
  const offsets: number[] = [];
  payloads.forEach((buf) => {
    offsets.push(at);
    out.set(new Uint8Array(buf), at);
    at += buf.byteLength;
  });
  ov.setUint32(6, at, true);
  ov.setUint16(10, picked.length, true);
  picked.forEach((e, i) => {
    out.set(e.dir, at + i * 14);
    ov.setUint32(at + i * 14 + 6, offsets[i], true);
  });
  return new SrscFile(out.buffer);
}

function toCanvas(width: number, height: number, rgba: Uint8Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  const img = g.createImageData(width, height);
  img.data.set(rgba);
  g.putImageData(img, 0, 0);
  return c;
}

export async function loadMenuAssets(fs: GameFS, audio: AudioSystem, model: MenuModel): Promise<MenuAssets> {
  const base = model.interfacePackage;
  const pkg = (await packageId(fs, base)) || 5;
  const need = async (ext: string) => {
    const p = await fs.resolve(`${base}.${ext}`);
    if (!p) throw new Error(`${base}.${ext} not found`);
    return p;
  };

  const [fdu, xdu, tduPath, sduPath] = await Promise.all([
    need('fdu').then(async (p) => new SrscFile(await fs.read(p))),
    need('xdu').then(async (p) => new SrscFile(await fs.read(p))),
    need('tdu'),
    fs.resolve(`${base}.sdu`),
  ]);

  const strings = new StringDb();
  strings.addFile(xdu, pkg);

  const fonts = readFonts(fdu, pkg);
  const uiFont = fonts.find((f) => f.id === model.fonts.ui) ?? fonts[0];
  const titleFont = fonts.find((f) => f.id === model.fonts.title) ?? uiFont;
  if (!uiFont) throw new Error('no fonts in interface package');

  const imageIds = new Set<number>(modelTextures(model));
  for (const f of fonts) for (const t of f.textures) imageIds.add(t.id);
  const tdu = await readSrscSubset(fs, tduPath, (e) => e.type === TEXTURE_ENTRY_TYPE && imageIds.has(e.id));
  const rgba = new Map<number, { width: number; height: number; rgba: Uint8Array }>();
  for (const e of tdu.entries) {
    try {
      const t = decodeTexture(tdu, e);
      if (t) rgba.set(e.id, t);
    } catch (err) {
      console.warn(`[menu] texture ${e.id}:`, err);
    }
  }
  const atlases = (f: Font): FontAtlas[] =>
    f.textures.map((t) => rgba.get(t.id) ?? { width: 1, height: 1, rgba: new Uint8Array(4) });
  const images = new Map<number, HTMLCanvasElement>();
  for (const [id, t] of rgba) images.set(id, toCanvas(t.width, t.height, t.rgba));

  if (sduPath) {
    try {
      await audio.mountSdu(fs, sduPath, pkg);
    } catch (err) {
      console.warn('[menu] interface sounds unavailable:', err);
    }
  }

  const uiAtlases = atlases(uiFont);
  const fontById = new Map<number, BitmapFont>();
  for (const f of fonts) fontById.set(f.id, new BitmapFont(f, atlases(f)));
  return {
    pkg,
    strings,
    fonts: { ui: fontById.get(uiFont.id)!, title: fontById.get(titleFont.id)! },
    fontById,
    uiFont: { font: uiFont, atlases: uiAtlases },
    images,
    label(l: Label): string {
      if ('text' in l) return l.text;
      const v = strings.get(l.str.id, l.str.pkg);
      return v !== undefined ? normalizeNewlines(v).trim() : l.fallback;
    },
    async loadImages(ids: number[]): Promise<void> {
      const want = new Set(ids.filter((id) => !images.has(id)));
      if (!want.size) return;
      const sub = await readSrscSubset(fs, tduPath, (e) => e.type === TEXTURE_ENTRY_TYPE && want.has(e.id));
      for (const e of sub.entries) {
        try {
          const t = decodeTexture(sub, e);
          if (t) images.set(e.id, toCanvas(t.width, t.height, t.rgba));
        } catch (err) {
          console.warn(`[menu] texture ${e.id}:`, err);
        }
      }
    },
  };
}
