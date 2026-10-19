// Converted media manifest (game/converted/manifest.json, written by `npm run bake`).
//
// The original WMV2/ASF videos and raw PCM sound banks are converted once,
// offline, into files every browser decodes natively; the engine keeps reading
// the original .vdu/.sdu headers (catalogs, sound categories, loop flags,
// distances, subtitles, lip-sync envelopes) and only fetches the media payload
// from here. Converted files are derived from the user's own install and are
// never part of the repository (game/ is gitignored).
//
// Formats (see tools/bake.ts for the exact ffmpeg settings):
//   audio  AAC-LC in MP4 (.m4a): decodeAudioData() accepts it in Chrome, Firefox and
//          Safari alike. Opus would be smaller, but Safari only decodes Opus in some
//          containers/versions, so AAC is the one format that works everywhere.
//          Encoder priming is described by the MP4 edit list (most browsers trim it);
//          `priming`/`frames` let the app trim it itself when a decoder doesn't.
//   video  H.264 (High, yuv420p) + the paired soundtrack as AAC in MP4 (.mp4), playable
//          by a plain <video> everywhere. Original ASF timestamps are kept (variable frame
//          rate, millisecond timescale), so the picture can't drift from its soundtrack.

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';

export interface ConvertedSound {
  /** Path relative to the converted/ folder. */
  file: string;
  /** Seconds (== the .sdu sound's frames / sampleRate). */
  duration: number;
  /** Sample frames of the original sound (at `rate` after any resampling). */
  frames: number;
  /** Sample rate of the encoded stream (the original unless it was below what AAC supports). */
  rate: number;
  channels: number;
  /** Encoder delay in frames at `rate`, as recorded in the MP4 edit list. */
  priming: number;
  bytes: number;
  /** Fingerprint of the source + settings (bake skips entries whose fingerprint is unchanged). */
  source: string;
}

export interface ConvertedVideo {
  file: string;
  /** Picture duration, seconds (video track). */
  duration: number;
  /** Whole file duration (longer than the picture when the soundtrack runs past it). */
  mediaDuration: number;
  /** Number of pictures (variable frame rate). */
  frames: number;
  width: number;
  height: number;
  group: number;
  /** Muxed ('sync') or separately looping ('bed') soundtrack key, if any. */
  soundtrack?: string;
  soundtrackMode?: 'sync' | 'bed';
  pairing?: string;
  bytes: number;
  source: string;
}

export interface ConvertedManifest {
  version: typeof MANIFEST_VERSION;
  created: string;
  audio: { codec: 'aac'; container: 'mp4'; mime: string };
  video: { codec: 'h264'; container: 'mp4'; mime: string };
  /** Package id -> container path without extension (e.g. "COMMON/Interface/Interface"). */
  packages: Record<string, string>;
  /** Sound key "pkg:id" -> converted file. */
  sounds: Record<string, ConvertedSound>;
  /** Video key "pkg:id" -> converted file. */
  videos: Record<string, ConvertedVideo>;
}

export const soundFile = (pkg: number, id: number) => `audio/${pkg}/${id}.m4a`;
export const videoFile = (pkg: number, id: number) => `video/${pkg}/${id}.mp4`;

export function isManifest(x: unknown): x is ConvertedManifest {
  const m = x as ConvertedManifest;
  return !!m && m.version === MANIFEST_VERSION && typeof m.sounds === 'object' && typeof m.videos === 'object';
}
