// Save files on the player's disk (the Load / Save lists' file rows, flow.ts):
//   * export one save / every save as a .json bundle, import such files back;
//   * import the original PC game's saves (`Saves\<hex time>\<Level>.rsg`) and profile
//     (`Unspeakable.cfg`) from a folder (the game's install folder, its Saves folder, one save's
//     folder) or picked files; export the port's settings as an `Unspeakable.cfg`.
// Pickers: the File System Access API where the browser has it (showOpenFilePicker /
// showDirectoryPicker / showSaveFilePicker: Chromium), else <input type=file> (webkitdirectory
// for folders) and a download link. Nothing is uploaded anywhere: files are read in the page and
// the saves go to the browser's own save store. What carries over from an original save:
// src/game/save/transfer.ts and docs/re/saves.md §8.

import { parseOriginalSave, parseOriginalSettings, type OriginalSettings, type SaveThumbnail } from '../../formats/save-original';
import { decodeOriginalThumbnail, originalSaveToPort } from '../../game/save/transfer';
import type { SaveData } from '../../game/save/types';

export interface PickedFile {
  name: string;
  /** Path inside the picked folder ("Saves/4a1b2c3d/1a PrisonDeathRow.rsg"), or the name. */
  path: string;
  lastModified: number;
  bytes(): Promise<Uint8Array>;
}

type FsHandle = { kind: 'file' | 'directory'; name: string; getFile?(): Promise<File>; values?(): AsyncIterable<FsHandle> };
type FsWindow = Window & {
  showOpenFilePicker?(o: unknown): Promise<FsHandle[]>;
  showDirectoryPicker?(o?: unknown): Promise<FsHandle>;
  showSaveFilePicker?(o: unknown): Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }>;
};
const fsw = () => window as FsWindow;

const fromFile = (f: File, path?: string): PickedFile => ({
  name: f.name,
  path: path || (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
  lastModified: f.lastModified,
  bytes: async () => new Uint8Array(await f.arrayBuffer()),
});

/** <input type=file> fallback (a user gesture started the action). Resolves [] when cancelled. */
function inputPick(accept: string, multiple: boolean, directory: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = accept;
    el.multiple = multiple;
    if (directory) (el as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    el.style.display = 'none';
    let done = false;
    const finish = (files: PickedFile[]) => {
      if (done) return;
      done = true;
      el.remove();
      resolve(files);
    };
    el.addEventListener('change', () => finish([...(el.files ?? [])].map((f) => fromFile(f))));
    el.addEventListener('cancel', () => finish([]));
    document.body.append(el);
    el.click();
  });
}

/** Files under a picked folder whose name passes `want`, at most `depth` folders down. */
async function walk(dir: FsHandle, want: (name: string) => boolean, depth: number, prefix = ''): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for await (const h of dir.values?.() ?? []) {
    const path = prefix ? `${prefix}/${h.name}` : h.name;
    if (h.kind === 'file' && want(h.name) && h.getFile) out.push(fromFile(await h.getFile(), path));
    else if (h.kind === 'directory' && depth > 0) out.push(...(await walk(h, want, depth - 1, path)));
  }
  return out;
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

/** Pick .json export files. */
export async function pickJson(): Promise<PickedFile[]> {
  const w = fsw();
  if (w.showOpenFilePicker) {
    try {
      const hs = await w.showOpenFilePicker({ multiple: true, types: [{ description: 'Saved games (.json)', accept: { 'application/json': ['.json'] } }] });
      return Promise.all(hs.map(async (h) => fromFile(await h.getFile!())));
    } catch (e) {
      if (isAbort(e)) return [];
    }
  }
  return inputPick('.json,application/json', true, false);
}

const ORIGINAL = (n: string) => /\.rsg$/i.test(n) || /^unspeakable\.cfg$/i.test(n);

/** The original game's files: a folder (install, Saves, one save) or the files themselves. */
export async function pickOriginal(mode: 'folder' | 'files'): Promise<PickedFile[]> {
  const w = fsw();
  if (mode === 'folder') {
    if (w.showDirectoryPicker) {
      try {
        return await walk(await w.showDirectoryPicker({ id: 'suffering-original', mode: 'read' }), ORIGINAL, 3);
      } catch (e) {
        if (isAbort(e)) return [];
      }
    }
    return (await inputPick('', true, true)).filter((f) => ORIGINAL(f.name));
  }
  if (w.showOpenFilePicker) {
    try {
      const hs = await w.showOpenFilePicker({ multiple: true, types: [{ description: 'The Suffering saves and profile (.rsg, Unspeakable.cfg)', accept: { 'application/octet-stream': ['.rsg', '.cfg'] } }] });
      return Promise.all(hs.map(async (h) => fromFile(await h.getFile!())));
    } catch (e) {
      if (isAbort(e)) return [];
    }
  }
  return (await inputPick('.rsg,.cfg', true, false)).filter((f) => ORIGINAL(f.name));
}

/** Write a file to the player's disk (a save dialog where offered, else a download). */
export async function saveToDisk(name: string, data: Blob, type: { description: string; mime: string; ext: string }): Promise<boolean> {
  const w = fsw();
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: type.description, accept: { [type.mime]: [type.ext] } }] });
      const s = await h.createWritable();
      await s.write(data);
      await s.close();
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
    }
  }
  try {
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

/** JPEG data URL of an original save's thumbnail (160 x 120, like the port's), when it decodes. */
export function thumbnailDataUrl(t: SaveThumbnail | undefined): string | undefined {
  const d = t && decodeOriginalThumbnail(t);
  if (!d) return undefined;
  try {
    const src = document.createElement('canvas');
    src.width = d.width;
    src.height = d.height;
    src.getContext('2d')!.putImageData(new ImageData(d.rgba as Uint8ClampedArray<ArrayBuffer>, d.width, d.height), 0, 0);
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 120;
    c.getContext('2d')!.drawImage(src, 0, 0, 160, 120);
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  }
}

export interface OriginalFiles {
  /** Port saves made from the .rsg files (the start of their levels). */
  saves: SaveData[];
  /** The profile, when an Unspeakable.cfg was among the files (the newest one). */
  settings?: OriginalSettings;
  /** .rsg files whose level the game data does not have (header path). */
  unknownLevels: string[];
  /** Files that could not be read (name: reason). */
  errors: string[];
}

/** The level path of the port for an original save's header path. */
export type LevelResolver = (originalPath: string) => Promise<string | undefined>;

export async function readOriginalFiles(files: readonly PickedFile[], resolveLevel: LevelResolver, difficulty: number): Promise<OriginalFiles> {
  const out: OriginalFiles = { saves: [], unknownLevels: [], errors: [] };
  let cfgTime = -1;
  for (const f of files) {
    try {
      const bytes = await f.bytes();
      if (/^unspeakable\.cfg$/i.test(f.name)) {
        const s = parseOriginalSettings(bytes);
        if (!s.valid) out.errors.push(`${f.path}: no end marker (the game itself would use its defaults)`);
        else if (f.lastModified > cfgTime) {
          out.settings = s;
          cfgTime = f.lastModified;
        }
        continue;
      }
      const o = parseOriginalSave(bytes);
      const parts = f.path.split('/');
      const folder = parts.length > 1 ? parts[parts.length - 2] : undefined;
      const levelPath = await resolveLevel(o.header.levelPath);
      const d = originalSaveToPort(o, { levelPath, folder, fileTime: f.lastModified, difficulty, thumbnail: thumbnailDataUrl(o.header.thumbnail) });
      if (d) out.saves.push(d);
      else out.unknownLevels.push(o.header.levelPath);
    } catch (e) {
      out.errors.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return out;
}
