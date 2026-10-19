// Lighting Effect (docs/game-logic.md §14.4, docs/re/renderer.md §1.10): .wdu element types,
// the engine's waveform sampler, and the channel rule on the retail templates (the 1a alarm
// lights flash red on a 1 s square wave).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFS, skip } from './helpers';
import { parseWaveform, waveformSample, type Waveform } from '../src/formats/model';
import { lightingEffectDef, lightingEffectK } from '../src/game/world/lights';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { readObjectTemplate, classByHash, decodeTemplateProps } from '../src/formats/entities';
import { SrscFile } from '../src/formats/srsc';

const int16Wave = (rate: number, samples: number[]) => {
  const v = new DataView(new ArrayBuffer(20 + samples.length * 2));
  v.setUint32(0, 1, true); // element type 1 = int16
  v.setUint16(4, 1, true);
  v.setUint16(6, 0, true); // bit-width field: not read by the engine
  v.setUint32(8, rate, true);
  v.setUint32(12, 2, true);
  v.setUint32(16, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(20 + 2 * i, s, true));
  return v;
};

test('waveforms: int16 samples normalised by 32767; engine sampler edge rules (0x487d40)', () => {
  const w = parseWaveform(int16Wave(10, [32767, -32767, 0, 16384]))!;
  assert.equal(w.duration, 0.4);
  assert.deepEqual([...w.data].map((x) => +x.toFixed(4)), [1, -1, 0, 0.5]);
  // Below sample 1 the sampler returns sample 0 without interpolating.
  assert.equal(waveformSample(w, 0.05, 0), 1);
  // Between samples 1 and 2: lerp.
  assert.ok(Math.abs(waveformSample(w, 0.15, 0) + 0.5) < 1e-6);
  // From the last sample on it holds it.
  assert.ok(Math.abs(waveformSample(w, 0.35, 0) - 0.5) < 1e-4);
  assert.ok(Math.abs(waveformSample(w, 9, 0) - 0.5) < 1e-4);
});

test('Lighting Effect channel: k = (s + 1) / 2 at fmod(t, duration); non-looping stops at the end', () => {
  const wave: Waveform = parseWaveform(int16Wave(10, [-32767, -32767, 32767, 32767]))!;
  const ch = { wave, a: 0, b: 8 };
  assert.equal(lightingEffectK(ch, true, 0), 0);
  assert.equal(lightingEffectK(ch, true, 0.35), 1);
  assert.equal(lightingEffectK(ch, true, 0.45), 0, 'loops');
  assert.equal(lightingEffectK(ch, false, 0.35), 1);
  assert.equal(lightingEffectK(ch, false, 0.45), undefined, 'one-shot: the light keeps its last value');
});

test('Lighting Effect templates: 1a alarm 7:176 flashes strength 0 -> 8 at 1 Hz, keeps the red colour', { skip }, async () => {
  const fs = nodeFS();
  const lvl = new SrscFile(await fs.read('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'));
  const silent = () => {};
  const packages = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, silent);
  const def = (pkg: number, id: number) => {
    const t = readObjectTemplate(packages, { pkg, id })!;
    return lightingEffectDef(decodeTemplateProps(classByHash(t.classHash), t), packages);
  };

  const alarm = def(7, 176);
  assert.equal(alarm.color, undefined, 'p8 unset: no colour channel, the light keeps p0 (red)');
  assert.ok(alarm.power && alarm.loop && alarm.start);
  assert.equal(alarm.power.wave.key, '7:2');
  assert.equal(alarm.power.wave.duration, 1);
  const power = (t: number) => alarm.power!.a + (alarm.power!.b - alarm.power!.a) * lightingEffectK(alarm.power!, true, t)!;
  for (let t = 0; t < 0.45; t += 0.05) assert.ok(power(t) > 7.7, `high at ${t.toFixed(2)}: ${power(t)}`);
  for (let t = 0.6; t < 0.98; t += 0.05) assert.ok(power(t) < 0.2, `low at ${t.toFixed(2)}: ${power(t)}`);
  assert.ok(power(1.2) > 7.7, 'loops every second');

  // 8148's template 7:583: the same square wave up to 31.25.
  const big = def(7, 583);
  assert.equal(big.power?.wave.key, '7:2');
  assert.equal(big.power?.b, 31.25);

  // Fire lights 7:968: strength flicker 7.2 -> 16.2 on curve 4:110; p6 / p7 unused (p8 unset).
  const fire = def(7, 968);
  assert.equal(fire.color, undefined);
  assert.equal(fire.power?.wave.key, '4:110');
  assert.ok(Math.abs(fire.power!.a - 7.2) < 1e-5 && Math.abs(fire.power!.b - 16.2) < 1e-5);

  // Blue cell lamps 7:237: both channels (colour 4:107 between p6 / p7, strength 4:110).
  const lamp = def(7, 237);
  assert.equal(lamp.color?.wave.key, '4:107');
  assert.equal(lamp.power?.wave.key, '4:110');
});
