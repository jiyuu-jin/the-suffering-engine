// Sound Effect (placed sound emitter) rules decoded from Suffering.rfl (docs/re/audio.md §12).
// Pure: World (logic.ts) keeps the per-object state and calls these.
//
// Properties [verified unless marked]:
//   p0  sound list
//   p2  keep the sounds loaded (prefetch)
//   p3  play mode: 0 once (outOnFinished p18 when it ends), 1 repeat the picked sound until
//       stopped (voice flag 1, 0x1012c177), 2 re-trigger with a random pick every p6 +- p7 s,
//       3 the same with a shuffle (no sound twice before every one played), 4 shuffle and the
//       object destroys itself once every sound played (0x1012c9a0)
//   p6  re-trigger interval (s) and p7 its jitter: interval = p6 + uniform(-p7, p7), at least 0,
//       plus p13 (0x1012ca58..0x1012caf3). NOT a radius: the voice uses the sound header's own
//       min / max distance (the play call passes none, 0x1012bfba).
//   p8  InvestigateSound for an AI noise when a mode-0 sound starts
//   p9  position: 0 the object, 1 the nearest point of the p11 objects, 2 at the listener
//       (play flag 4: 2D, 0x1012c158), 3 the p10 object
//   p12 fade-out (s) on Stop (0x1012c572)
//   p13 fade-in (s) of every start (passed to the play call, 0x1012bfa1)
//
// Starting a sound that is already the current one does nothing: the voice keeps playing
// (0x1012bc80 compares the new sound with the current one first). Switching to another sound
// (a re-trigger, a new pick) stops the old voice at once.

export const SFX_MODE = { once: 0, repeat: 1, random: 2, shuffle: 3, shuffleOnce: 4 } as const;

/** Modes that re-trigger on a timer (2, 3, 4). */
export function sfxRetriggers(mode: number): boolean {
  return mode === 2 || mode === 3 || mode === 4;
}

/** Re-trigger delay of modes 2..4: p6 + uniform(-p7, p7) clamped at 0, then + p13. */
export function sfxInterval(p6: number, p7: number, p13: number, rnd: number): number {
  const v = p6 + (-p7 + rnd * 2 * p7);
  return Math.max(0, v) + p13;
}

/**
 * Sound pick (0x1012c270): modes 0..2 any sound at random (rand() % n); modes 3 / 4 a random
 * sound not played yet in this round (stepping to the next unused one, 0x10041650); the round
 * starts again once every sound was played. `used` is the round's set (mutated).
 */
export function sfxPick(mode: number, n: number, used: Set<number>, rnd: number): number {
  if (n <= 0) return -1;
  let i = Math.min(n - 1, Math.floor(rnd * n));
  if (mode !== 3 && mode !== 4) return i;
  if (used.size >= n) used.clear();
  for (let k = 0; k < n && used.has(i); k++) i = (i + 1) % n;
  used.add(i);
  return i;
}

/** Mode 4: the play that finds every sound already played destroys the object instead. */
export function sfxExhausted(mode: number, playsSoFar: number, n: number): boolean {
  return mode === 4 && playsSoFar > n;
}
