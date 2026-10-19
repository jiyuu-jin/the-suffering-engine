// Material decoding (formats/model.ts readMaterial) and texture helpers used for
// cutout surfaces. Data tests run against a local game install and are structural only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFS, skip } from './helpers';
import { bleedTransparentTexels, coverageMipmaps, readTextureHeader } from '../src/formats/texture';
import { parseFloorLayers, parseLevel, readLevelHeader } from '../src/formats/level';
import { loadPackages, partTextureKeys } from '../src/app/loader';
import { SrscFile } from '../src/formats/srsc';
import {
  Blend,
  findEntry,
  materialSignature,
  mduFaceCount,
  parseWaveform,
  readLandscapeSplat,
  readMaterial,
  readModel,
  TDU_TEXTURE,
  TexInput,
  waveformAt,
  type PackageSet,
} from '../src/formats/model';

const silent = () => {};

test('bleedTransparentTexels fills colour under alpha 0 and keeps alpha', () => {
  // 4x1: opaque red, two transparent black texels, opaque blue.
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255]);
  bleedTransparentTexels(rgba, 4, 1);
  assert.deepEqual([rgba[3], rgba[7], rgba[11], rgba[15]], [255, 0, 0, 255]);
  assert.ok(rgba[4] > 0 || rgba[6] > 0, 'transparent texel took a neighbour colour');
  assert.ok(rgba[8] > 0 || rgba[10] > 0, 'transparent texel took a neighbour colour');
});

test('coverageMipmaps keeps alpha-test coverage of thin cutouts', () => {
  // 16x16 with one opaque column every 4 texels (25% coverage): plain box filtering
  // drops every level below the 0.5 threshold from 4x4 down.
  const n = 16;
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) rgba[(y * n + x) * 4 + 3] = x % 4 === 0 ? 255 : 0;
  const mips = coverageMipmaps(rgba, n, n, 0.5);
  assert.equal(mips.length, 5);
  assert.deepEqual(mips.map((m) => m.width), [16, 8, 4, 2, 1]);
  for (const m of mips.slice(1, 4)) {
    let covered = 0;
    for (let i = 3; i < m.data.length; i += 4) if (m.data[i] >= 128) covered++;
    assert.ok(covered / (m.width * m.height) >= 0.2, `level ${m.width}: coverage kept`);
  }
});

async function chapterOne(name: string) {
  const fs = nodeFS();
  const path = `LEVELS/1 PrisonDeathRow/${name} PrisonDeathRow.lvl`;
  const lvl = new SrscFile(await fs.read(path));
  const packages = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, silent);
  return { lvl, packages };
}

const alphaMode = (pkgs: PackageSet, key: string) => {
  const [pkg, id] = key.split(':').map(Number);
  const tdu = pkgs.get(pkg)?.tdu;
  const e = findEntry(tdu, TDU_TEXTURE, id);
  return tdu && e ? readTextureHeader(tdu, e).alphaMode : undefined;
};

for (const name of ['1a', '1b', '1c']) {
  test(`chapter 1 (${name}): every surface material decodes to resolvable textures`, { skip }, async () => {
    const { lvl, packages } = await chapterOne(name);
    const level = parseLevel(lvl, name, { packages });
    let layered = 0, cutouts = 0, blended = 0;
    for (const part of level.parts) {
      for (const k of partTextureKeys(part)) assert.notEqual(alphaMode(packages, k), undefined, `texture ${k} missing`);
      const m = part.material;
      if (!m) continue;
      assert.ok(m.layers.length >= 1 && m.layers.length <= 8, m.key);
      if (m.layers.length > 1) layered++;
      for (const l of m.layers) {
        assert.ok(l.blend >= 0 && l.blend <= 8, `${m.key} blend ${l.blend}`);
        if (l.blend === Blend.Cutout) {
          cutouts++;
          assert.equal(alphaMode(packages, l.texture!), 1, `${m.key}: cutout layers use 1-bit-alpha textures`);
        } else if (l.blend !== Blend.Opaque) blended++;
      }
    }
    assert.ok(layered > 0 && cutouts > 0 && blended > 0, `layered ${layered} cutouts ${cutouts} blended ${blended}`);
  });
}

test('chapter 1 floor layers: landscape splats resolve with a positive tiling', { skip }, async () => {
  const { lvl, packages } = await chapterOne('1a');
  let n = 0;
  for (const L of parseFloorLayers(lvl)) {
    for (const b of L.blocks) {
      for (const m of b.materials) {
        const s = readLandscapeSplat(packages, m);
        assert.ok(s, `landscape material ${m.pkg}:${m.id}`);
        assert.ok(s.tiling >= 1 && s.fade > 0);
        assert.notEqual(alphaMode(packages, s.texture), undefined, `splat texture ${s.texture}`);
        n++;
      }
    }
  }
  assert.ok(n > 100, `${n} splat materials`);
  const level = parseLevel(lvl, '1a', { packages });
  const splatParts = level.parts.filter((p) => p.splat);
  assert.ok(splatParts.length > 0);
  for (const p of splatParts) assert.equal(p.splatWeights?.length, (p.positions.length / 3) * 8);
});

// ---------------------------------------------------------------------------
// Advanced Material texture coordinates, .wdu waveforms, face counts (docs/game-logic.md §16)

const waveBytes = (rate: number, frames: [number, number][], bits = 0) => {
  const v = new DataView(new ArrayBuffer(20 + frames.length * 8));
  v.setUint32(0, 3, true);
  v.setUint16(4, 2, true);
  v.setUint16(6, bits, true);
  v.setUint32(8, rate, true);
  v.setUint32(12, 2, true);
  v.setUint32(16, frames.length * 8, true);
  frames.forEach(([a, b], i) => (v.setFloat32(20 + 8 * i, a, true), v.setFloat32(24 + 8 * i, b, true)));
  return v;
};

test('waveforms: float channels, duration = samples / rate, looped linear interpolation', () => {
  const w = parseWaveform(waveBytes(10, [[0, 0], [-0.5, 1], [-1, 2]]), 'test')!;
  assert.equal(w.channels, 2);
  assert.ok(Math.abs(w.duration - 0.3) < 1e-9);
  assert.equal(waveformAt(w, 0, 0), 0);
  assert.ok(Math.abs(waveformAt(w, 0.05, 0) + 0.25) < 1e-6, 'halfway between samples 0 and 1');
  assert.ok(Math.abs(waveformAt(w, 0.15, 1) - 1.5) < 1e-6);
  assert.ok(Math.abs(waveformAt(w, 0.35, 0) + 0.25) < 1e-6, 'loops after the duration');
  assert.equal(waveformAt(w, 0, 2), 0, 'missing channel reads 0');
  // The element type (u32 at 0) decides the sample format, not the bit-width field; type 4
  // entries are raw bytes (credits text), not curves.
  assert.ok(parseWaveform(waveBytes(10, [[0, 0]], 8)));
  const raw = waveBytes(10, [[0, 0]]);
  raw.setUint32(0, 4, true);
  assert.equal(parseWaveform(raw), undefined);
});

test('water materials: planar glint layer, scrolling caustics (World Common 7:1582)', { skip }, async () => {
  const { packages } = await chapterOne('1a');
  const m = readMaterial(packages, { pkg: 7, id: 1582 })!;
  assert.equal(m.layers.length, 4);
  const [base, glint, caustics, caustics2] = m.layers;
  assert.equal(base.blend, Blend.Opaque);
  // 7:1580: texture 7:393, mode 1 (x / z), input 3 (reflection vector), scale 2, v offset 0.5.
  assert.equal(glint.texture, '7:393');
  assert.equal(glint.texGen, 1);
  assert.equal(glint.texInput, TexInput.Reflection);
  assert.equal(glint.uvScale, 2);
  assert.deepEqual(glint.uvOffset, [0, 0.5]);
  // 7:1583 / 7:1585: mesh UVs scrolled by World Common waveforms 7:33 / 7:51 (6 samples / s).
  assert.equal(caustics.texGen, undefined);
  assert.equal(caustics.scroll?.key, '7:33');
  assert.equal(caustics2.scroll?.key, '7:51');
  const w = caustics2.scroll!;
  assert.equal(w.rate, 6);
  assert.ok(Math.abs(w.duration - 16) < 1e-6, '96 samples at 6 / s');
  assert.ok(waveformAt(w, 15.9, 0) > 0.9, 'u scrolls one repeat per loop');
  // A different scroll makes a different draw signature (no wrong batching).
  assert.notEqual(materialSignature(m), materialSignature({ ...m, layers: [base, glint, { ...caustics, scroll: undefined }, caustics2] }));
});

test('models: face count is a u16 (glass shards 9:4498..4500 of the 1a CartWheeler decode)', { skip }, async () => {
  const { packages } = await chapterOne('1a');
  for (const id of [4498, 4499, 4500]) {
    const m = readModel(packages, { pkg: 9, id });
    assert.ok(m, `9:${id} decodes`);
    const tris = m.submeshes.reduce((n, s) => n + s.indices.length / 3, 0);
    assert.ok(tris > 100 && tris < 2000, `9:${id}: ${tris} triangles`);
    assert.ok(m.submeshes.every((s) => s.material?.layers.length), `9:${id}: materials resolve`);
  }
  const v = new DataView(new ArrayBuffer(4 + 36));
  v.setUint16(0, 1, true);
  v.setUint16(2, 2, true);
  assert.equal(mduFaceCount(v), 1);
  v.setUint16(0, 2, true);
  assert.equal(mduFaceCount(v), undefined, 'too short for 2 faces');
});
