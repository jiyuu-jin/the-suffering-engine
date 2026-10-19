// Minimal synchronous zlib/DEFLATE decoder (RFC 1950/1951).
// The browser's DecompressionStream is async-only; level parsing is sync, and the
// compressed chunks involved are small (a few KB each).

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

class BitReader {
  pos: number;
  bit = 0;
  bits = 0;
  constructor(readonly src: Uint8Array, start: number) {
    this.pos = start;
  }
  need(n: number): number {
    while (this.bits < n) {
      if (this.pos >= this.src.length) throw new Error('inflate: unexpected end of data');
      this.bit |= this.src[this.pos++] << this.bits;
      this.bits += 8;
    }
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.bits -= n;
    return v;
  }
  decode(h: Huffman): number {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.need(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad Huffman code');
  }
}

let fixedLit: Huffman | undefined;
let fixedDist: Huffman | undefined;

/** Inflate a raw DEFLATE stream starting at `start`. */
export function inflateRaw(src: Uint8Array, start = 0, sizeHint = 0): Uint8Array {
  let out = new Uint8Array(Math.max(sizeHint, 1024));
  let n = 0;
  const ensure = (k: number) => {
    if (n + k <= out.length) return;
    let len = out.length * 2;
    while (len < n + k) len *= 2;
    const o = new Uint8Array(len);
    o.set(out.subarray(0, n));
    out = o;
  };
  const br = new BitReader(src, start);
  let last = 0;
  while (!last) {
    last = br.need(1);
    const type = br.need(2);
    if (type === 0) {
      br.bit = 0;
      br.bits = 0;
      const len = src[br.pos] | (src[br.pos + 1] << 8);
      br.pos += 4;
      ensure(len);
      out.set(src.subarray(br.pos, br.pos + len), n);
      n += len;
      br.pos += len;
      continue;
    }
    let lit: Huffman, dist: Huffman;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144);
        l.fill(9, 144, 256);
        l.fill(7, 256, 280);
        l.fill(8, 280, 288);
        fixedLit = buildHuffman(l);
        fixedDist = buildHuffman(new Uint8Array(30).fill(5));
      }
      lit = fixedLit;
      dist = fixedDist!;
    } else if (type === 2) {
      const hlit = br.need(5) + 257, hdist = br.need(5) + 1, hclen = br.need(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = br.need(3);
      const clh = buildHuffman(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist; ) {
        const sym = br.decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep = 0, val = 0;
          if (sym === 16) {
            if (!i) throw new Error('inflate: repeat without previous length');
            val = lens[i - 1];
            rep = 3 + br.need(2);
          } else if (sym === 17) rep = 3 + br.need(3);
          else rep = 11 + br.need(7);
          while (rep-- && i < lens.length) lens[i++] = val;
        }
      }
      lit = buildHuffman(lens.subarray(0, hlit));
      dist = buildHuffman(lens.subarray(hlit));
    } else throw new Error('inflate: bad block type');

    for (;;) {
      const sym = br.decode(lit);
      if (sym < 256) {
        ensure(1);
        out[n++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: bad length code');
        const len = LEN_BASE[li] + br.need(LEN_EXTRA[li]);
        const di = br.decode(dist);
        if (di >= 30) throw new Error('inflate: bad distance code');
        const d = DIST_BASE[di] + br.need(DIST_EXTRA[di]);
        if (d > n) throw new Error('inflate: distance too far back');
        ensure(len);
        for (let k = 0; k < len; k++, n++) out[n] = out[n - d];
      }
    }
  }
  return out.subarray(0, n);
}

/** Inflate a zlib-wrapped stream (2-byte header, adler32 trailer ignored). */
export function inflateZlib(src: Uint8Array, sizeHint = 0): Uint8Array {
  if (src.length < 2 || (src[0] & 0x0f) !== 8 || ((src[0] << 8) | src[1]) % 31 !== 0) {
    throw new Error('inflate: not a zlib stream');
  }
  return inflateRaw(src, 2, sizeHint);
}
