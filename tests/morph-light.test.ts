// The morph's light (insanity/morph-light.ts, docs/game-logic.md §13.10 step 2): the lead-in
// spawns the form's Player p274 Object Generator at the player (4:1250: white Point Light 4:1248
// pulsed by Lighting Effect 4:1246); the leave destroys it. The port hands it to the engine light
// rig's provider list (no three.js light, so no lit material is rebuilt on the first morph).
// Data checks use the local install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import { readDbId, type PackageSet } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import type { EnginePointLight } from '../src/app/engine-light';
import { MorphLight, morphLightDefs } from '../src/game/insanity/morph-light';
import { readInsanityParams } from '../src/game/insanity/params';
import type { EntityPackageSet } from '../src/formats/entities';

test('morph light: lit from start to stop at the start position, on the game clock', () => {
  const m = new MorphLight();
  const out: EnginePointLight[] = [];
  m.write(out);
  assert.equal(out.length, 0, 'nothing before a morph');
  m.start([{ r: 1, g: 1, b: 1, intensity: 0.05, hemi: 0, end: 3.367 }], { x: 1, y: 2, z: 3 });
  m.step(1 / 128 / 60);
  m.write(out);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].x, out[0].y, out[0].z, out[0].r, out[0].intensity], [1, 2, 3, 1, 0.05]);
  // The generator's own run (3.367 game s) would end it; at 1 / 128 that is minutes of real time.
  m.step(4);
  out.length = 0;
  m.write(out);
  assert.equal(out.length, 0, 'gone with its generator');
  m.start([{ r: 1, g: 1, b: 1, intensity: 1, hemi: 0 }], { x: 0, y: 0, z: 0 });
  m.stop();
  m.write(out);
  assert.equal(out.length, 0, 'the leave destroys it');
});

let cache: PackageSet | undefined;
function packages(): PackageSet {
  if (cache) return cache;
  const out = new Map<number, Record<string, unknown>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu', 'adu', 'wdu', 'qdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p);
  }
  return (cache = out as unknown as PackageSet);
}

test('morph light in the data: Player p274 4:1250 spawns one white omni Point Light 4:1248 with Lighting Effect 4:1246', { skip }, () => {
  const pkgs = packages();
  const params = readInsanityParams(pkgs as unknown as EntityPackageSet)!;
  assert.deepEqual(params.human.morphEffect, { pkg: 4, id: 1250 });
  const defs = morphLightDefs(pkgs, params.human.morphEffect);
  assert.equal(defs.length, 1);
  const [l] = defs;
  assert.ok(l.r > 0.99 && l.g > 0.99 && l.b > 0.99, 'white (0xffffff)');
  assert.equal(l.hemi, 0, 'omni');
  assert.ok(Math.abs(l.end! - 3.367) < 1e-3, 'the generator runs 3.367 s (p21, p22 1, p5)');
  assert.ok(l.fx?.power, 'its strength follows the Lighting Effect');
  assert.ok(Math.abs(l.fx!.power!.a - 1.8) < 1e-3 && Math.abs(l.fx!.power!.b - 7.2) < 1e-3, 'p9 1.8 -> p10 7.2');
  // At the start of the morph (game time ~0) the strength is at its curve's start.
  const m = new MorphLight();
  m.start(defs, { x: 0, y: 0, z: 0 });
  const out: EnginePointLight[] = [];
  m.write(out);
  assert.ok(out[0].intensity >= 1.8 - 1e-3 && out[0].intensity <= 7.2 + 1e-3, `strength ${out[0].intensity}`);
});
