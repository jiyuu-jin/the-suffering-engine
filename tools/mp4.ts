// Minimal ISO-BMFF (MP4) reader for tools and tests: track timing only.

export interface Mp4Track {
  handler: string; // 'vide' | 'soun' | ...
  timescale: number;
  /** mdhd duration, seconds. */
  mediaDuration: number;
  /** Presented duration, seconds (edit list if present, else mdhd). */
  duration: number;
  /** Media time skipped by the first edit (encoder priming), in timescale units. */
  editStart: number;
  samples: number;
}

export interface Mp4Info {
  duration: number;
  tracks: Mp4Track[];
}

function boxes(b: Uint8Array, start: number, end: number): { type: string; p: number; end: number }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: { type: string; p: number; end: number }[] = [];
  for (let p = start; p + 8 <= end; ) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let hdr = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, p: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

const child = (b: Uint8Array, box: { p: number; end: number }, type: string) => boxes(b, box.p, box.end).find((x) => x.type === type);

export function readMp4(b: Uint8Array): Mp4Info {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const moov = boxes(b, 0, b.length).find((x) => x.type === 'moov');
  if (!moov) throw new Error('mp4: no moov box');
  const mvhd = child(b, moov, 'mvhd')!;
  const ver = b[mvhd.p];
  const movieScale = v.getUint32(mvhd.p + (ver ? 20 : 12));
  const movieDur = ver ? Number(v.getBigUint64(mvhd.p + 24)) : v.getUint32(mvhd.p + 16);
  const tracks: Mp4Track[] = [];
  for (const trak of boxes(b, moov.p, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia');
    if (!mdia) continue;
    const mdhd = child(b, mdia, 'mdhd')!;
    const mv = b[mdhd.p];
    const timescale = v.getUint32(mdhd.p + (mv ? 20 : 12));
    const mdur = mv ? Number(v.getBigUint64(mdhd.p + 24)) : v.getUint32(mdhd.p + 16);
    const hdlr = child(b, mdia, 'hdlr')!;
    const handler = String.fromCharCode(...b.subarray(hdlr.p + 8, hdlr.p + 12));
    const stbl = child(b, child(b, mdia, 'minf')!, 'stbl')!;
    const stts = child(b, stbl, 'stts')!;
    let samples = 0;
    const n = v.getUint32(stts.p + 4);
    for (let i = 0; i < n; i++) samples += v.getUint32(stts.p + 8 + 8 * i);
    let duration = mdur / timescale;
    let editStart = 0;
    const edts = child(b, trak, 'edts');
    const elst = edts && child(b, edts, 'elst');
    if (elst) {
      const ev = b[elst.p];
      const count = v.getUint32(elst.p + 4);
      let total = 0;
      for (let i = 0, q = elst.p + 8; i < count; i++, q += ev ? 20 : 12) {
        const seg = ev ? Number(v.getBigUint64(q)) : v.getUint32(q);
        const mt = ev ? Number(v.getBigInt64(q + 8)) : v.getInt32(q + 4);
        if (mt === -1) continue; // empty edit (delay)
        if (!total) editStart = mt;
        total += seg;
      }
      if (total) duration = total / movieScale;
    }
    tracks.push({ handler, timescale, mediaDuration: mdur / timescale, duration, editStart, samples });
  }
  return { duration: movieDur / movieScale, tracks };
}
