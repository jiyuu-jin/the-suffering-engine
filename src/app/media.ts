// Converted media (game/converted, produced by `npm run bake`): manifest lookup
// and file access for the dev server and for a user-picked local folder.
//
//   const media = await convertedMedia(fs);      // null when there is none (cached per GameFS)
//   media?.sound('5:24') / media?.video('5:16')   // manifest entries (src/formats/converted.ts)
//   await media.url(entry.file)                   // <video src> (http: or blob:)
//   await media.fetch(entry.file)                 // bytes (decodeAudioData)
//
// Dev server: served by vite.config.ts at /converted/. Local folder: a
// "converted" folder next to the picked install's app folder (where the bake
// writes it) or inside it (LocalFolderFS keeps those files aside).
// When converted media is missing the app still runs without video/audio;
// the first lookup reports it once through onConvertedMediaMissing().

import { DevServerFS, LocalFolderFS, type GameFS } from './gamefs';
import { MANIFEST_FILE, isManifest, type ConvertedManifest, type ConvertedSound, type ConvertedVideo } from '../formats/converted';

export interface ConvertedMedia {
  readonly label: string;
  readonly manifest: ConvertedManifest;
  sound(key: string): ConvertedSound | undefined;
  video(key: string): ConvertedVideo | undefined;
  /** A URL for a media element. */
  url(file: string): Promise<string>;
  fetch(file: string): Promise<ArrayBuffer>;
}

type FileAccess = Pick<ConvertedMedia, 'url' | 'fetch'> & { label: string };

function make(manifest: ConvertedManifest, access: FileAccess): ConvertedMedia {
  return {
    label: access.label,
    manifest,
    sound: (key) => manifest.sounds[key],
    video: (key) => manifest.videos[key],
    url: access.url,
    fetch: access.fetch,
  };
}

function httpAccess(base: string): FileAccess {
  const url = (file: string) => `${base}/converted/${file.split('/').map(encodeURIComponent).join('/')}`;
  return {
    label: `${base || 'dev server'}/converted`,
    url: async (file) => url(file),
    fetch: async (file) => {
      const res = await fetch(url(file));
      if (!res.ok) throw new Error(`converted/${file}: HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

function localAccess(fs: LocalFolderFS): FileAccess {
  const urls = new Map<string, Promise<string>>();
  const file = async (rel: string) => {
    const f = await fs.convertedFile(rel);
    if (!f) throw new Error(`converted/${rel} not found in the picked folder`);
    return f;
  };
  return {
    label: 'local folder converted/',
    // Object URLs are kept for the session (only videos ask for URLs: a few dozen at most).
    url: (rel) => {
      let u = urls.get(rel);
      if (!u) {
        u = file(rel).then((f) => URL.createObjectURL(f));
        urls.set(rel, u);
        u.catch(() => urls.delete(rel));
      }
      return u;
    },
    fetch: async (rel) => (await file(rel)).arrayBuffer(),
  };
}

async function open(fs: GameFS): Promise<ConvertedMedia | null> {
  let access: FileAccess | undefined;
  if (fs instanceof DevServerFS) {
    if (await fs.hasConvertedMedia()) access = httpAccess(fs.base);
  }
  else if (fs instanceof LocalFolderFS && fs.hasConvertedMedia) access = localAccess(fs);
  if (!access) return null;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(await access.fetch(MANIFEST_FILE)));
    if (!isManifest(json)) throw new Error('unsupported manifest version');
    return make(json, access);
  } catch (err) {
    console.warn(`[media] no usable converted media (${access.label}):`, (err as Error).message);
    return null;
  }
}

const cache = new WeakMap<object, Promise<ConvertedMedia | null>>();
let missingHandler: ((message: string) => void) | undefined;
let missingReported = false;

export const MISSING_MEDIA_MESSAGE = 'No converted video/audio found: run `npm run bake` to enable cutscenes and sound.';

/** Called once (per page) the first time converted media turns out to be missing. */
export function onConvertedMediaMissing(fn: (message: string) => void): void {
  missingHandler = fn;
}

/** Reports missing media once (also used when a single file is missing from the manifest). */
export function reportMissingMedia(detail?: string): void {
  if (missingReported) return;
  missingReported = true;
  console.warn(`[media] ${MISSING_MEDIA_MESSAGE}${detail ? ` (${detail})` : ''}`);
  missingHandler?.(MISSING_MEDIA_MESSAGE);
}

/** Converted media for a game file system (cached per instance); null if there is none. */
export function convertedMedia(fs: GameFS): Promise<ConvertedMedia | null> {
  let p = cache.get(fs);
  if (!p) {
    p = open(fs).then((m) => {
      if (!m) reportMissingMedia();
      return m;
    });
    cache.set(fs, p);
  }
  return p;
}
