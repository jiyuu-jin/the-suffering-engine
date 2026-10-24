// Minimal PE32 reader: the image base and the section table, to map a virtual address of the
// user's own SUFFERING.EXE / Suffering.rfl to a file offset (data tables the port reads at
// runtime, e.g. the RFL's default key bindings: save-original.ts readRflDefaultBindings).

export interface PeSection {
  name: string;
  /** RVA and size in memory. */
  va: number;
  vsize: number;
  /** File offset and size on disk. */
  raw: number;
  rawSize: number;
}

export interface PeImage {
  imageBase: number;
  sections: PeSection[];
}

export function readPe(bytes: Uint8Array): PeImage {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0, true) !== 0x5a4d) throw new Error('pe: no MZ header');
  const pe = v.getUint32(0x3c, true);
  if (v.getUint32(pe, true) !== 0x00004550) throw new Error('pe: no PE signature');
  const nsec = v.getUint16(pe + 6, true);
  const optSize = v.getUint16(pe + 20, true);
  const opt = pe + 24;
  if (v.getUint16(opt, true) !== 0x10b) throw new Error('pe: not PE32');
  const imageBase = v.getUint32(opt + 28, true);
  const sections: PeSection[] = [];
  for (let i = 0, o = opt + optSize; i < nsec; i++, o += 40) {
    let name = '';
    for (let k = 0; k < 8 && bytes[o + k]; k++) name += String.fromCharCode(bytes[o + k]);
    sections.push({ name, vsize: v.getUint32(o + 8, true), va: v.getUint32(o + 12, true), rawSize: v.getUint32(o + 16, true), raw: v.getUint32(o + 20, true) });
  }
  return { imageBase, sections };
}

/** File offset of a virtual address, or -1 when no section's file data holds it. */
export function peOffset(img: PeImage, va: number): number {
  const rva = va - img.imageBase;
  for (const s of img.sections) if (rva >= s.va && rva < s.va + Math.min(s.rawSize, Math.max(s.vsize, s.rawSize))) return s.raw + (rva - s.va);
  return -1;
}
