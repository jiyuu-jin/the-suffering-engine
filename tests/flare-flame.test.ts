// The thrown flare's flame (docs/game-logic.md §4.5 "Flare key", §14.2 MorphingModel):
// BouncingObject 4:452 p36 -> Object Generator 4:942 -> MorphingModel 4:938 + Point Light 4:941.
// Decoded from Suffering.rfl: MorphingModel create 0x100d2c10 / think 0x100d2e20 (vertex blend
// between consecutive key models), the generator's run end 0x100b4590 and destructor
// 0x100b4dc0 -> 0x100b49e0 (p5: its spawns go with it). The data tests skip without a game install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import { readDbId, readModel, type PackageSet } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { morphClock, morphingModelDef, morphSegment } from '../src/game/world/morphing-model';
import { generatorSpawnsEnd, thrownGeneratorSpawns } from '../src/game/weapons/thrown-light';

const ref = (id: number) => ({ pkg: 4, id });

test('MorphingModel: valid key lists (looping: one time per model, else one fewer; times > 0)', () => {
  const four = [ref(1), ref(2), ref(3), ref(4)];
  assert.ok(morphingModelDef([1, 1, 0, four, [0.1, 0.1, 0.1, 0.1]]));
  assert.equal(morphingModelDef([1, 1, 0, four, [0.1, 0.1, 0.1]]), undefined, 'looping needs a time back to the first');
  assert.ok(morphingModelDef([1, 0, 0, four, [0.1, 0.1, 0.1]]));
  assert.equal(morphingModelDef([1, 0, 0, four, [0.1, 0.1, 0.1, 0.1]]), undefined);
  assert.equal(morphingModelDef([1, 1, 0, [ref(1)], [0.1]]), undefined, 'one model: refused');
  assert.equal(morphingModelDef([1, 1, 0, [ref(1), ref(2)], [0.1, 0]]), undefined, 'a zero time: refused');
  assert.equal(morphingModelDef([0, 1, 0, [ref(1), ref(2)], [0.1, 0.2]])!.on, false, 'p0 = 0: off at start');
});

test('MorphingModel: the clock blends model i into i + 1 by the segment fraction, wrapping when looping', () => {
  const d = morphingModelDef([1, 1, 0, [ref(1), ref(2), ref(3), ref(4)], [0.075, 0.11, 0.1, 0.085]])!;
  assert.ok(Math.abs(d.total - 0.37) < 1e-9);
  assert.deepEqual(morphSegment(d, 0), { a: 0, b: 1, f: 0 }, 'starts on the first model (no random phase)');
  const s = morphSegment(d, 0.075 + 0.055);
  assert.equal(s.a, 1);
  assert.equal(s.b, 2);
  assert.ok(Math.abs(s.f - 0.5) < 1e-9);
  const last = morphSegment(d, 0.37 - 0.0425);
  assert.equal(last.a, 3);
  assert.equal(last.b, 0, 'the last segment blends back into the first model');
  assert.ok(Math.abs(last.f - 0.5) < 1e-9);
  assert.ok(Math.abs(morphClock(d, 0.36, 0.02) - 0.01) < 1e-9, 'wraps');
  const once = morphingModelDef([1, 0, 0, [ref(1), ref(2), ref(3)], [0.2, 0.3]])!;
  assert.equal(morphClock(once, 0.4, 1), 0.5, 'not looping: stops at the end');
  assert.deepEqual(morphSegment(once, 0.5), { a: 1, b: 2, f: 1 });
});

test('Object Generator: a single run with p5 takes its spawns at p21', () => {
  const g = (p5: number, p21: number, p22: number) => {
    const v: unknown[] = new Array(39).fill(0);
    v[5] = p5;
    v[21] = p21;
    v[22] = p22;
    return v as never;
  };
  assert.equal(generatorSpawnsEnd(g(1, 10, 1)), 10);
  assert.equal(generatorSpawnsEnd(g(0, 10, 1)), Infinity, 'without p5 the spawns live on');
  assert.equal(generatorSpawnsEnd(g(1, 10, 2)), Infinity, 'more runs: it only goes off');
  assert.equal(generatorSpawnsEnd(g(1, 0, 1)), Infinity, 'endless');
});

let cache: Map<number, Record<string, unknown>> | undefined;
function packages() {
  if (cache) return cache;
  const out = new Map<number, Record<string, unknown>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu', 'adu', 'wdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p);
  }
  return (cache = out);
}

test('flare data: the flame 4:938 and the light 4:941 of generator 4:942, both gone at 10 s', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  const s = thrownGeneratorSpawns(pkgs, { pkg: 4, id: 452 });
  assert.equal(s.lights.length, 1);
  assert.equal(s.lights[0].end, 10, 'generator 4:942: p21 10 s, p22 1, p5 1');
  assert.equal(s.morphs.length, 1);
  const [m] = s.morphs;
  assert.deepEqual(m.ref, { pkg: 4, id: 938 });
  assert.equal(m.end, 10);
  assert.deepEqual(m.def.frames.map((r) => r.id), [172, 170, 171, 169]);
  assert.deepEqual(m.def.times.map((t) => Math.round(t * 1000)), [75, 110, 100, 85]);
  assert.equal(m.def.loop, true);
  assert.equal(m.def.on, true);
  // Every key model has the same vertices (the engine refuses a blend otherwise) and the additive
  // material 4:939.
  for (const f of m.def.frames) {
    const md = readModel(pkgs, f)!;
    assert.equal(md.vertexCount, 42, `4:${f.id}`);
    assert.deepEqual(md.materials, [{ pkg: 4, id: 939 }]);
    assert.equal(md.submeshes[0].material?.layers[0].blend, 2, 'additive');
  }
  // No other retail throwable spawns a MorphingModel.
  for (const id of [280, 245, 81, 621, 806]) assert.equal(thrownGeneratorSpawns(pkgs, { pkg: 4, id }).morphs.length, 0, `4:${id}`);
});
