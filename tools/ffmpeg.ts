// ffmpeg helpers for tools ($FFMPEG, else ffmpeg on PATH).

import { spawnSync } from 'node:child_process';
import { asfStream } from '../src/formats/video';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';

/**
 * Decodes picture `frame` (0-based, in stream order) of a .vdu data entry to RGBA
 * (`width`/`height` from the video header).
 * Throws if ffmpeg is unavailable or fails.
 */
export function videoFrameRGBA(entry: Uint8Array, frame: number, width: number, height: number): { width: number; height: number; rgba: Uint8Array } {
  const stream = asfStream(entry);
  const run = (args: string[]) => {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'asf', '-i', 'pipe:0', ...args], {
      input: stream,
      maxBuffer: 1 << 28,
    });
    // EPIPE: ffmpeg stopped reading once it had the frame.
    if (r.error && (r.error as NodeJS.ErrnoException).code !== 'EPIPE') throw new Error(`${FFMPEG}: ${r.error.message} (set FFMPEG=/path/to/ffmpeg)`);
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().trim().slice(0, 400)}`);
    return r.stdout;
  };
  const out = run(['-vf', `select=eq(n\\,${frame | 0})`, '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  if (out.length !== width * height * 4) throw new Error(`frame ${frame}: got ${out.length} bytes`);
  return { width, height, rgba: new Uint8Array(out) };
}
