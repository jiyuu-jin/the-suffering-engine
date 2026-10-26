// An Animating Static brushed by the player plays a p37 clip (docs/game-logic.md §14.5; src/game/actors/brush.ts).
// Decoded from Suffering.rfl: the touch handler 0x10093d10 (a Collider owned by the Player, the
// 0.2 s touch stamp, a random p37 clip with the p40 request), the think 0x10093e70 (back to the
// idle list when channel 0's clip is done). The data tests skip without a game install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import { readDbId, type PackageSet } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { peOffset, readPe } from '../src/formats/pe';
import { tpl } from '../src/game/weapons/data';
import { BRUSH_GAP, brushTouch, playerProxySpheres, spheresTouch } from '../src/game/actors/brush';

test('brush: a touch plays the clip only after 0.2 s without one; every touch moves the stamp', () => {
  assert.equal(BRUSH_GAP, 0.2);
  assert.deepEqual(brushTouch(0, 0.1), { play: false, last: 0.1 }, 'the stamp starts at 0');
  assert.equal(brushTouch(0, 5).play, true);
  // Walking through the object: touches every frame. One clip at the first touch, none after.
  let last = 0, plays = 0;
  for (let t = 10; t < 12; t += 1 / 60) {
    const r = brushTouch(last, t);
    last = r.last;
    if (r.play) plays++;
  }
  assert.equal(plays, 1);
  // Out of contact for 0.25 s, then in again: another clip.
  assert.equal(brushTouch(last, last + 0.25).play, true);
  assert.equal(brushTouch(last, last + 0.19).play, false);
});

test('brush: sphere against sphere, no allowance', () => {
  const a = [{ c: [0, 0, 0] as [number, number, number], r: 0.6 }];
  assert.equal(spheresTouch(a, [{ c: [1.5, 0, 0], r: 0.9 }]), true);
  assert.equal(spheresTouch(a, [{ c: [1.51, 0, 0], r: 0.9 }]), false);
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
    for (const ext of ['odu', 'mdu']) {
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

test('brush data: the player proxy (Player p91 Collider 2:44) and the handler constants', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  const player = tpl(pkgs as never, { pkg: 2, id: 5 })!;
  const s = playerProxySpheres(pkgs, player.v);
  assert.deepEqual(s.map((x) => [+x.y.toFixed(3), +x.r.toFixed(2)]), [[1.306, 0.6], [1.639, 0.6], [0.9, 0.6], [0, 0.6]]);
  const b = new Uint8Array(readFileSync(join(DATA_ROOT, 'Suffering.rfl')));
  const img = readPe(b);
  const o = (va: number) => peOffset(img, va);
  const dv = new DataView(b.buffer, b.byteOffset);
  assert.deepEqual([...b.subarray(o(0x10093d21), o(0x10093d21) + 4)], [0x6a, 0xff, 0x6a, 0x25], 'p37');
  assert.equal(dv.getUint32(o(0x10093d69), true), 0xfa5951fc, 'Collider');
  assert.equal(dv.getUint32(o(0x10093dd4), true), 0xc8bc44e1, 'Player');
  assert.ok(Math.abs(dv.getFloat32(o(0x10150dd0), true) - 0.2) < 1e-7, 'the gap');
  // 1a's four Animating Statics of 23:157 brush with clip 23:17 and idle on 23:21.
  const t = tpl(pkgs as never, { pkg: 23, id: 157 })!;
  assert.equal(t.cls, 'Animating Static');
  assert.deepEqual(t.v[37], [{ pkg: 23, id: 17 }]);
  assert.deepEqual(t.v[23], [{ pkg: 23, id: 21 }]);
});
