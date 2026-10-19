// Localized string tables (.xdu).
//
// Every string is an SRSC entry of type 0 / group 4; the entry id is the
// string id and `extra` is the asset group it belongs to (the same group
// numbers used by the package's sounds and videos). Payload:
//   u16  byte length of the text including its terminator
//   u16[] UTF-16LE text, NUL terminated, padded to 4 bytes
// Strings are referenced from other files as (u16 id, u16 packageDbId), e.g.
// a sound header's subtitle reference (see video.ts listSounds).
//
// Text conventions found in the data: "\r\n" line breaks, printf-style %s/%d
// arguments, and <ActionName> placeholders for the bound control
// (e.g. "<Use>", "<Attack>"), which the game substitutes with button names.

import type { SrscFile } from './srsc';

export const STRING_ENTRY_TYPE = 0x00;
export const STRING_ENTRY_GROUP = 4;

export interface StringEntry {
  id: number;
  group: number;
  text: string;
}

export class StringTable {
  readonly entries = new Map<number, StringEntry>();

  constructor(
    file: SrscFile,
    readonly pkg = 0,
  ) {
    for (const e of file.entries) {
      if (e.type !== STRING_ENTRY_TYPE || e.group !== STRING_ENTRY_GROUP || e.size < 2) continue;
      const v = file.data(e);
      const len = Math.min(v.getUint16(0, true), e.size - 2);
      let text = '';
      for (let p = 2; p + 1 < 2 + len; p += 2) {
        const c = v.getUint16(p, true);
        if (c === 0) break;
        text += String.fromCharCode(c);
      }
      this.entries.set(e.id, { id: e.id, group: e.extra, text });
    }
  }

  get(id: number): string | undefined {
    return this.entries.get(id)?.text;
  }

  /** All strings of an asset group, in id order. */
  group(group: number): StringEntry[] {
    return [...this.entries.values()].filter((s) => s.group === group).sort((a, b) => a.id - b.id);
  }
}

/** Cross-package string lookup keyed by "pkg:id" (package ids come from the .db files). */
export class StringDb {
  private readonly tables = new Map<number, StringTable>();

  add(table: StringTable): this {
    this.tables.set(table.pkg, table);
    return this;
  }

  addFile(file: SrscFile, pkg: number): StringTable {
    const t = new StringTable(file, pkg);
    this.tables.set(pkg, t);
    return t;
  }

  table(pkg: number): StringTable | undefined {
    return this.tables.get(pkg);
  }

  get(id: number, pkg: number): string | undefined {
    return this.tables.get(pkg)?.get(id);
  }

  /** Resolves "pkg:id". */
  lookup(key: string): string | undefined {
    const [pkg, id] = key.split(':').map(Number);
    return this.get(id, pkg);
  }
}

/** Substitutes printf-style %s / %d / %% arguments in order. */
export function formatString(text: string, ...args: (string | number)[]): string {
  let i = 0;
  return text.replace(/%(%|[-+ 0#]*\d*(?:\.\d+)?[sdiuxXf])/g, (m, spec: string) => {
    if (spec === '%') return '%';
    const a = args[i++];
    if (a === undefined) return m;
    return /[dixXu]$/.test(spec) && typeof a === 'number' ? String(Math.trunc(a)) : String(a);
  });
}

/** Replaces <Action> control placeholders using a binding map (unknown names are kept). */
export function expandControls(text: string, bindings: Record<string, string>): string {
  return text.replace(/<([A-Za-z][A-Za-z0-9]*)>/g, (m, name: string) => bindings[name] ?? m);
}

/** Normalizes the game's "\r\n" breaks to "\n". */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
