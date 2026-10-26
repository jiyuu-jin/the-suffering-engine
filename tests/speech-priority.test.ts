// One speech channel per character (docs/game-logic.md §15.4 "Speech priorities";
// src/game/actors/speech.ts). Decoded from Suffering.rfl: Speak 0x1012d190, Character Say
// 0x100e1b40, the callers' priorities, the adoption of a STOMP key's sound (0x1012d3b0, priority 9).
// The byte checks run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, skip } from './helpers';
import { peOffset, readPe } from '../src/formats/pe';
import { SPEECH_PRIORITY, speechAdmits } from '../src/game/actors/speech';

test('speech: a line starts on a silent channel, or over a line of no higher priority when its own is above 1', () => {
  // Silent (nothing said, or the last line's sound has ended): any line, whatever was said before.
  assert.equal(speechAdmits(false, 9, 1), true);
  assert.equal(speechAdmits(false, 0, 0), true);
  // Priority 1 (every conversation line, bark, Speech Player line) never cuts a line: dropped.
  assert.equal(speechAdmits(true, 1, 1), false);
  assert.equal(speechAdmits(true, 0, 1), false);
  // An Action Dialog's answer to a hit (2) cuts a line and another answer, not a sequence's line.
  assert.equal(speechAdmits(true, 1, SPEECH_PRIORITY.hitAnswer), true);
  assert.equal(speechAdmits(true, 2, SPEECH_PRIORITY.hitAnswer), true);
  assert.equal(speechAdmits(true, SPEECH_PRIORITY.sequence, SPEECH_PRIORITY.hitAnswer), false);
  // A sequence's sound (9) cuts everything.
  assert.equal(speechAdmits(true, 2, SPEECH_PRIORITY.sequence), true);
});

test('speech: the original passes priority 1 for lines, 2 for the hit answers, 9 for STOMP sounds', { skip }, () => {
  const b = new Uint8Array(readFileSync(join(DATA_ROOT, 'Suffering.rfl')));
  const img = readPe(b);
  const at = (va: number, n: number) => [...b.subarray(peOffset(img, va), peOffset(img, va) + n)];
  // Speak: the priority is compared with 1 (it must be above 1 to interrupt), then with the playing line's (+0xb4).
  assert.deepEqual(at(0x1012d194, 3), [0x83, 0xf8, 0x01]);
  assert.deepEqual(at(0x1012d19e, 6), [0x3b, 0x86, 0xb4, 0x00, 0x00, 0x00]);
  // push <priority> before the calls of Character Say / Speak.
  const push = (va: number) => (b[peOffset(img, va)] === 0x6a ? b[peOffset(img, va) + 1] : -1);
  assert.equal(push(0x100ffbbd), 1, 'PlayDialog (conversation line)');
  assert.equal(push(0x1012dab1), 1, 'Speech Player');
  assert.equal(push(0x1008d7f1), 1, 'Action Dialog spotting bark');
  assert.equal(push(0x1008d5e9), 2, 'Action Dialog warning (p16)');
  assert.equal(push(0x1008df51), 2, 'Action Dialog p13');
  assert.equal(push(0x1008e060), 2, 'Action Dialog turn (p20)');
  assert.equal(push(0x1012d435), 9, 'a STOMP sound adopted by the channel');
});
