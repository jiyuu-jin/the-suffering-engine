// The surface a footstep (or an impact) takes where the material names no Game Material
// Properties, and on the floor layers' hidden cells (docs/game-logic.md §17.6; src/game/fx/surfaces.ts).
// Decoded: Suffering.rfl 0x100b6310 (material handle -> GMP, else Level Properties p17; a word 0
// naming a Material Type is refused with a warning), 0x100b0c10 (the floor layer under the feet
// asked for its texture there through the layer interface, SUFFERING.EXE 0x49f790: a cell whose
// texture index is below 0 gives the null handle), the loader 0x4a05df (0x30 = the texture did
// not resolve, index -1). The data tests skip without a game install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { allFiles, DATA_ROOT, skip } from './helpers';
import { SrscFile } from '../src/formats/srsc';
import { readDbId } from '../src/formats/model';
import { parseEntities, type EntityPackage, type EntityPackageSet } from '../src/formats/entities';
import type { LevelData } from '../src/formats/types';
import { Surfaces } from '../src/game/fx/surfaces';

let packages: EntityPackageSet | undefined;
function pkgs(): EntityPackageSet {
  if (packages) return packages;
  const set = new Map<number, EntityPackage>();
  const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer as ArrayBuffer) : undefined);
  for (const rel of allFiles().filter((f) => f.toLowerCase().endsWith('.db'))) {
    const abs = join(DATA_ROOT, rel);
    const id = readDbId(readFileSync(abs, 'latin1'));
    if (id === undefined || set.has(id)) continue;
    const base = abs.slice(0, -3);
    set.set(id, { id, name: basename(base), odu: load(`${base}.odu`), xdu: load(`${base}.xdu`) });
  }
  return (packages = set);
}

test('every retail level names Game Material Properties 2:7 (no Material Type) as its default', { skip }, () => {
  const levels = allFiles().filter((f) => f.toLowerCase().endsWith('.lvl'));
  assert.equal(levels.length, 18);
  for (const l of levels) {
    const es = parseEntities(new SrscFile(new Uint8Array(readFileSync(join(DATA_ROOT, l))).buffer as ArrayBuffer), pkgs(), { all: true });
    const lp = es.find((e) => e.className === 'Level Properties');
    assert.deepEqual(lp?.values[17], { pkg: 2, id: 7 }, l);
  }
  const s = new Surfaces(pkgs(), undefined, () => null);
  const t = s.template({ pkg: 2, id: 7 })!;
  assert.equal(t.cls, 'Game Material Properties');
  assert.equal(t.values[0], null, 'no Material Type');
  assert.equal(t.values[2], 0.5, 'hardness');
  assert.equal(t.values[4], 0, 'bounce loss');
});

test('a surface without Game Material Properties takes the level default; a Material Type in word 0 is refused', { skip }, () => {
  const parts = [
    // A hidden floor-layer cell: collision only, no material, no splat (level.ts hiddenLayerCollision).
    { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) },
  ];
  const level = { parts: [], collision: parts } as unknown as LevelData;
  const s = new Surfaces(pkgs(), level, () => null);
  s.setLevelDefault({ pkg: 2, id: 7 });
  const hidden = s.atHit({ part: 0, point: [0.2, 0, 0.2] });
  assert.equal(hidden.type, null, 'the default entry of the effect lists');
  assert.equal(hidden.gmp, '2:7');
  // 7:260 (Advanced Material) names a Material Type in word 0: the engine warns and uses the default.
  assert.equal(s.template({ pkg: 7, id: 260 })?.cls, 'Advanced Material');
  assert.equal(s.template(s.template({ pkg: 7, id: 260 })!.values[0] as never)?.cls, 'Material Type');
  assert.equal(s.typeOfMaterial('7:260'), null);
  assert.equal(s.gmpOfMaterial('7:260'), '2:7');
  assert.equal(s.gmpOfMaterial(undefined), '2:7');
  // A null type picks the Player p145 list's untyped entry (0x100c7790).
  const player = s.template({ pkg: 2, id: 5 })!;
  const e = s.pick(player.values[145], null)!;
  assert.ok(e, 'the player list has a default entry');
  assert.equal(e.values[0], null);
});
