// Worker entry for texture-decode.ts: decodes a batch of texture jobs and hands the pixel
// buffers back without copying.

import { decodeTextureJob, type TextureJob } from './texture-decode';
import type { DecodedTexture } from '../formats/types';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<TextureJob[]>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const out: (DecodedTexture | null)[] = e.data.map((job) => {
    try {
      return decodeTextureJob(job);
    } catch (err) {
      console.warn(`[texture-worker] ${job.key}: ${(err as Error).message}`);
      return null;
    }
  });
  scope.postMessage(out, out.filter((t): t is DecodedTexture => !!t).map((t) => t.rgba.buffer as ArrayBuffer));
};
