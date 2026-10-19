// Sound sample loading for AudioSystem: the .sdu headers stay the source of
// truth for everything about a sound (category, loop flag, distances,
// subtitles, lip-sync); only the samples come from the converted media
// (`npm run bake`: AAC in MP4, decoded with decodeAudioData).
//
//   const samples = new SoundSamples();
//   samples.mount(pkg, fs);                         // the GameFS the .sdu came from
//   const buffer = await samples.load(ctx, info);   // AudioBuffer aligned with the original PCM
//
// Alignment: AAC adds encoder priming (1024 frames) in front and padding at
// the end. The MP4 edit list says how much to drop and most decoders apply
// it; when one doesn't, the buffer is trimmed here using the manifest's
// `priming`/`frames`, so buffer time 0 is the original's first sample (lip-sync
// envelopes and SoundHandle.position() depend on that).

import type { SoundInfo } from '../formats/sound';
import type { ConvertedSound } from '../formats/converted';
import type { GameFS } from './gamefs';
import { convertedMedia, reportMissingMedia, type ConvertedMedia } from './media';

export class SoundSamples {
  private readonly sources = new Map<number, Promise<ConvertedMedia | null>>();

  /** Registers where package `pkg`'s samples come from (a GameFS; anything else has no converted media). */
  mount(pkg: number, source: unknown): void {
    const fs = source as Partial<GameFS>;
    const isFs = typeof fs?.list === 'function' && typeof fs.resolve === 'function';
    this.sources.set(pkg, isFs ? convertedMedia(source as GameFS) : Promise.resolve(null));
  }

  unmount(pkg: number): void {
    this.sources.delete(pkg);
  }

  /** Decoded size estimate in bytes (for cache budgets): float32 at the context rate. */
  static decodedBytes(ctx: BaseAudioContext, info: SoundInfo): number {
    return Math.ceil(info.duration * ctx.sampleRate) * info.channels * 4;
  }

  async load(ctx: BaseAudioContext, info: SoundInfo): Promise<AudioBuffer> {
    const media = await this.sources.get(info.pkg);
    if (!media) throw new Error(`no converted media for ${info.key} (run npm run bake)`);
    const entry = media.sound(info.key);
    if (!entry) {
      reportMissingMedia(`sound ${info.key} not in the manifest`);
      throw new Error(`sound ${info.key} is not in the converted media`);
    }
    const bytes = await media.fetch(entry.file);
    return alignDecoded(ctx, await ctx.decodeAudioData(bytes), entry);
  }
}

/**
 * Trims a decoded buffer to the original sound: drops encoder priming if the
 * decoder kept it, and padding past the original length.
 */
export function alignDecoded(ctx: BaseAudioContext, buf: AudioBuffer, entry: ConvertedSound): AudioBuffer {
  const scale = buf.sampleRate / entry.rate;
  const want = Math.max(1, Math.round(entry.frames * scale));
  const priming = Math.round(entry.priming * scale);
  if (buf.length <= want + 1) return buf;
  // Priming left in: the buffer is at least priming + frames long (plus up to one AAC frame of padding).
  const lead = priming > 0 && buf.length >= want + priming - 2 ? priming : 0;
  const n = Math.min(want, buf.length - lead);
  const out = ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(lead, lead + n), c);
  return out;
}
