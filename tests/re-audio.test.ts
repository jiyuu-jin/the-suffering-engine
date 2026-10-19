// The original engine's mixing rules (src/app/audio-rules.ts, docs/re/audio.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceGain,
  hearsNoise,
  isPositionalSound,
  pickVoiceToSteal,
  preferNoise,
  soundPriority,
} from '../src/app/audio-rules';

test('distance curve: flat to min + 6 %, exponential segment, linear edge fade, silent at max', () => {
  const min = 10, max = 110; // range 100, knee w = 6
  assert.equal(distanceGain(0, min, max), 1);
  assert.equal(distanceGain(min + 6, min, max), 1);
  // One knee past the flat part: 10^(0.1 (1 - 12/6)) = 10^-0.1
  assert.ok(Math.abs(distanceGain(min + 12, min, max) - Math.pow(10, -0.1)) < 1e-9);
  // Monotonic and inside [0, 1].
  let prev = 1;
  for (let d = 0; d <= max; d += 0.5) {
    const g = distanceGain(d, min, max);
    assert.ok(g >= 0 && g <= 1 && g <= prev + 1e-12, `d=${d}`);
    prev = g;
  }
  assert.equal(distanceGain(max, min, max), 0);
  assert.equal(distanceGain(max + 5, min, max), 0);
});

test('priority comes from the high nibble of the header byte; unknown sounds get 5', () => {
  assert.equal(soundPriority(0x55), 5);
  assert.equal(soundPriority(0xa3), 10);
  assert.equal(soundPriority(undefined), 5);
});

test('voice stealing takes the first strictly lower priority voice, else drops the new sound', () => {
  assert.equal(pickVoiceToSteal(5, [5, 5, 3, 1]), 2);
  assert.equal(pickVoiceToSteal(5, [5, 5, 5]), -1);
  assert.equal(pickVoiceToSteal(0, [0, 0]), -1);
});

test('stereo and Music / Movie / GUI sounds are never positional', () => {
  assert.equal(isPositionalSound({ channels: 1, category: 0 }), true);
  assert.equal(isPositionalSound({ channels: 2, category: 0 }), false);
  for (const category of [2, 3, 4]) assert.equal(isPositionalSound({ channels: 1, category }), false);
});

test('AI hearing: percent chance roll and the louder-then-closer preference', () => {
  assert.equal(hearsNoise(100, 0.9999), true);
  assert.equal(hearsNoise(0, 0), true); // floor(0) = 0 <= 0
  assert.equal(hearsNoise(0, 0.5), false);
  assert.equal(hearsNoise(50, 0.49), true);
  assert.equal(hearsNoise(50, 0.51), false);
  assert.equal(preferNoise(undefined, { level: 1, distance: 9 }), true);
  assert.equal(preferNoise({ level: 1, distance: 5 }, { level: 2, distance: 50 }), true);
  assert.equal(preferNoise({ level: 2, distance: 5 }, { level: 1, distance: 1 }), false);
  assert.equal(preferNoise({ level: 1, distance: 5 }, { level: 1, distance: 3 }), true);
  assert.equal(preferNoise({ level: 1, distance: 5 }, { level: 1, distance: 8 }), false);
});
