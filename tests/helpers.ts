// Shared helpers for tests that run against a local game install.
//
// Game data is never part of the repo. Tests look for it at $SUFFERING_DATA or
// ./game/app and skip themselves when it isn't there, so `npm test` still
// passes (with skips) on a machine without the game.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GameFS } from '../src/app/gamefs';
import { normalizePath } from '../src/app/gamefs';
import { SrscFile } from '../src/formats/srsc';

export const DATA_ROOT = resolve(process.env.SUFFERING_DATA ?? 'game/app');
export const hasData = existsSync(join(DATA_ROOT, 'LEVELS'));
/** Pass as `{ skip }` to node:test so data tests skip without game files. */
export const skip = hasData ? false : `no game data at ${DATA_ROOT} (set SUFFERING_DATA)`;

function walk(dir: string, rel = '', out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) walk(abs, r, out);
    else out.push(r);
  }
  return out;
}

let files: string[] | undefined;
export function allFiles(): string[] {
  return (files ??= hasData ? walk(DATA_ROOT).sort() : []);
}

export function filesWithExt(ext: string): string[] {
  return allFiles().filter((f) => f.toLowerCase().endsWith(ext));
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function readSrsc(path: string): SrscFile {
  return new SrscFile(toArrayBuffer(readFileSync(join(DATA_ROOT, path))));
}

/** A GameFS over the local install, matching the browser implementations. */
export function nodeFS(): GameFS {
  const index = new Map(allFiles().map((f) => [f.toLowerCase(), f]));
  const canonical = (p: string) => index.get(normalizePath(p).toLowerCase());
  const mustResolve = (p: string) => {
    const c = canonical(p);
    if (!c) throw new Error(`File not found in game data: ${p}`);
    return c;
  };
  return {
    label: 'node',
    list: async () => allFiles(),
    resolve: async (p) => canonical(p),
    size: async (p) => {
      const c = canonical(p);
      return c ? statSync(join(DATA_ROOT, c)).size : undefined;
    },
    read: async (p) => toArrayBuffer(readFileSync(join(DATA_ROOT, mustResolve(p)))),
    readRange: async (p, offset, length) => {
      const b = readFileSync(join(DATA_ROOT, mustResolve(p)));
      return toArrayBuffer(b.subarray(offset, offset + length));
    },
  };
}
