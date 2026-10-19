// Texture decoding for level loads, on worker threads (texture-worker.ts) when the browser
// has them: DXT / paletted decode plus the atlas padding fix is ~1 s of main-thread work per
// level otherwise. Node (tests, tools) and worker-less browsers decode inline.

import type { SrscEntry, SrscFile } from '../formats/srsc';
import type { DecodedTexture } from '../formats/types';
import { decodeTexture } from '../formats/texture';

/** One .tdu texture entry to decode: its payload bytes and the key the level uses. */
export interface TextureJob {
  key: string;
  type: number;
  id: number;
  bytes: Uint8Array;
}

/** Decode one job (stored row order, atlas padding bled). Null if the format is unknown. */
export function decodeTextureJob(job: TextureJob): DecodedTexture | null {
  const entry: SrscEntry = { index: 0, type: job.type, group: 0, id: job.id, extra: 0, offset: 0, size: job.bytes.byteLength };
  const file = {
    data: () => new DataView(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength),
    bytes: () => job.bytes,
  } as unknown as SrscFile;
  const tex = decodeTexture(file, entry, { rowOrder: 'stored' });
  if (!tex) return null;
  bleedAtlasPadding(tex);
  return { ...tex, key: job.key };
}

/** Decode jobs across a few workers; the result is in job order (null = undecodable). */
export async function decodeTexturesInWorkers(jobs: TextureJob[]): Promise<(DecodedTexture | null)[]> {
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, Math.ceil(jobs.length / 16)));
  // Spread by size so the workers finish together.
  const order = jobs.map((_, i) => i).sort((a, b) => jobs[b].bytes.byteLength - jobs[a].bytes.byteLength);
  const lanes: number[][] = Array.from({ length: n }, () => []);
  const load = new Array(n).fill(0);
  for (const i of order) {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j;
    lanes[k].push(i);
    load[k] += jobs[i].bytes.byteLength;
  }
  const out: (DecodedTexture | null)[] = new Array(jobs.length).fill(null);
  await Promise.all(
    lanes.map(async (lane) => {
      if (!lane.length) return;
      let worker: Worker;
      try {
        worker = new Worker(new URL('./texture-worker.ts', import.meta.url), { type: 'module' });
      } catch {
        for (const i of lane) out[i] = decodeTextureJob(jobs[i]);
        return;
      }
      try {
        // Copies: the package buffers stay with the main thread.
        const batch = lane.map((i) => ({ ...jobs[i], bytes: jobs[i].bytes.slice() }));
        const result = await new Promise<(DecodedTexture | null)[]>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<(DecodedTexture | null)[]>) => resolve(e.data);
          worker.onerror = (e) => reject(new Error(e.message || 'texture worker failed'));
          worker.postMessage(batch, batch.map((j) => j.bytes.buffer));
        });
        lane.forEach((i, k) => (out[i] = result[k]));
      } catch (err) {
        console.warn('[loader] texture worker failed, decoding inline:', err);
        for (const i of lane) out[i] = decodeTextureJob(jobs[i]);
      } finally {
        worker.terminate();
      }
    }),
  );
  return out;
}

/**
 * Floor atlases (*_level.tdu) pack tiles on a magenta (255,100,255) fill that
 * bilinear filtering and mipmaps would smear onto tile edges. Grow the
 * neighbouring texels into the fill until none is left (every mip level then
 * averages real colours), so no magenta can reach a tile edge at any distance.
 */
export function bleedAtlasPadding(tex: DecodedTexture): void {
  const { width: w, height: h, rgba } = tex;
  const isPad = (i: number) => rgba[i] === 255 && rgba[i + 1] === 100 && rgba[i + 2] === 255;
  let pad: number[] = [];
  for (let i = 0; i < rgba.length; i += 4) if (isPad(i)) pad.push(i >> 2);
  if (pad.length === 0) return;
  const known = new Uint8Array(w * h).fill(1);
  for (const px of pad) known[px] = 0;
  while (pad.length) {
    const filled: [number, number, number, number][] = [];
    const remaining: number[] = [];
    for (const px of pad) {
      const x = px % w, y = (px / w) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!known[k]) continue;
        const j = k * 4;
        r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; n++;
      }
      if (n) filled.push([px, r / n, g / n, b / n]);
      else remaining.push(px);
    }
    if (!filled.length) break; // the whole texture is padding
    // Apply after the pass so growth is one texel per pass in every direction.
    for (const [px, r, g, b] of filled) {
      const i = px * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b;
      known[px] = 1;
    }
    pad = remaining;
  }
}

