// Mixing rules of the original audio engine (docs/re/audio.md §10–§11), kept free of
// WebAudio so they can be unit-tested. AudioSystem (audio.ts) applies them.

/** Header +0x04 → linear amplitude. */
export const SOUND_VOLUME_SCALE = 1 / 10000;
/** Priority of a sound with no header; 0x55 → 5. */
export const SOUND_PRIORITY_DEFAULT = 5;
/** Flat part of the distance curve, as a fraction of (max − min). */
export const ROLLOFF_KNEE = 0.06;
/** Exponent scale of the curve segment: 10^(0.1 (1 − (d − min) / w)). */
export const ROLLOFF_EXP = 0.1;
/** The last 10 % of (max − min) fades linearly to silence. */
export const EDGE_FADE_START = 0.9;
/** Engine voice limits without hardware caps. */
export const ENGINE_MAX_VOICES = 20;
export const ENGINE_MAX_3D_VOICES = 8;
/** Music out / in when the game pauses. */
export const MUSIC_PAUSE_FADE = 1;
/** Music ducking while a sequence drives the player. */
export const CINEMATIC_MUSIC_ATTENUATION = 0.5;
export const CINEMATIC_MUSIC_FADE = 0.5;
/** Dialog fade when a movie starts. */
export const MOVIE_DIALOG_FADE = 1;
/** AI hearing: a noise counts when rand() % 101 ≤ the listener's p3. */
export const NOISE_CHANCE_DIVISOR = 101;

/** Sound categories that are never positional (Music 2, Movie 3, GUI 4). */
const NON_POSITIONAL_CATEGORIES = new Set([2, 3, 4]);

/** Header +0x0c priority word → priority 0..15 (0x55 → 5). */
export function soundPriority(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return SOUND_PRIORITY_DEFAULT;
  return (raw >> 4) & 15;
}

/** Stereo sounds and Music / Movie / GUI sounds always play 2D. */
export function isPositionalSound(info: { channels: number; category: number }): boolean {
  return info.channels === 1 && !NON_POSITIONAL_CATEGORIES.has(info.category);
}

/**
 * The engine's distance attenuation (DirectSound rolloff is disabled): full volume up to
 * min + w (w = 6 % of the range), then 10^(0.1 (1 − (d − min) / w)) clamped to 1, multiplied
 * by a linear fade over the last 10 % of the range; silent at and beyond max.
 */
export function distanceGain(d: number, min: number, max: number): number {
  if (!(max > min)) return d <= min ? 1 : 0;
  if (d >= max) return 0;
  const range = max - min;
  const w = ROLLOFF_KNEE * range;
  let g = 1;
  if (d > min + w) g = Math.min(1, Math.pow(10, ROLLOFF_EXP * (1 - (d - min) / w)));
  const t = (d - min) / range;
  if (t > EDGE_FADE_START) g *= Math.max(0, (1 - t) / (1 - EDGE_FADE_START));
  return g;
}

/**
 * Voice stealing: the new sound replaces the first voice (in start order) whose priority is
 * strictly lower; −1 means the new sound is dropped.
 */
export function pickVoiceToSteal(newPriority: number, voicePriorities: readonly number[]): number {
  for (let i = 0; i < voicePriorities.length; i++) if (voicePriorities[i] < newPriority) return i;
  return -1;
}

export interface NoiseCandidate {
  /** Noise level (InvestigateSound p1). */
  level: number;
  /** Distance from the listener to the noise. */
  distance: number;
}

/**
 * AI hearing filter (InvestigateBehavior): a noise passes when the listener's chance roll
 * succeeds (`floor(rnd × 101) ≤ chancePercent`). Among passing noises the highest level wins;
 * a noise of the same level only replaces the current one if it is closer.
 */
export function hearsNoise(chancePercent: number, rnd: number): boolean {
  return Math.floor(rnd * NOISE_CHANCE_DIVISOR) <= chancePercent;
}

export function preferNoise(current: NoiseCandidate | undefined, next: NoiseCandidate): boolean {
  if (!current) return true;
  if (next.level !== current.level) return next.level > current.level;
  return next.distance < current.distance;
}

/**
 * STOMP sound key volume (EXE 0x450ab1..0x450bf7): the key's u16 / 10000 times the sound's
 * header volume, clamped to 0..1. Returns the final linear gain.
 */
export function stompKeyGain(keyVolume: number, headerVolume: number): number {
  const v = keyVolume * headerVolume;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * A sequence's voices (EXE 0x44eb10) are stopped once their sound's length has played since
 * the key started them: a looping sound started by a STOMP key plays one pass. Returns the
 * clock time at which the voice is cut.
 */
export function stompVoiceEnd(start: number, soundDuration: number): number {
  return start + Math.max(0, soundDuration);
}
