// Light shafts and pools (docs/re/renderer.md §5.3, docs/enhanced.md "Light volumes", playthrough
// bug 88): the original draws them as flat additive sheets whose texture fades along the height
// only, with no view-angle term; the scene glow of the lit panel under 1b's arena grate brightens
// the shaft over it. Original keeps that; Enhanced fades the sheets by view angle and near the eye.
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blend, findEntry, readModel, TDU_TEXTURE, type MaterialLayer } from '../src/formats/model';
import { readLevelHeader, parseLevelObjects } from '../src/formats/level';
import { SrscFile } from '../src/formats/srsc';
import { decodeTexture } from '../src/formats/texture';
import { glowMarked, modelCullsBackFaces } from '../src/formats/render-data';
import { isLightVolume, lightVolumeFadeAt, LIGHT_VOLUME } from '../src/app/enhanced/light-volume';
import { DATA_ROOT, nodeFS, skip } from './helpers';

const add = (o: Partial<MaterialLayer> = {}): MaterialLayer => ({ texture: '7:584', blend: Blend.Add, tint: 0x414530, ...o });

test('Enhanced light volumes: single tinted additive passes without the glow mark', () => {
  assert.ok(isLightVolume([add()]), '1b shaft 9:5841');
  assert.ok(!isLightVolume([add({ depthWrite: true })]), 'glow-marked fire / lamp cards keep their look');
  assert.ok(!isLightVolume([add({ tint: undefined })]), 'untinted (lit) additive passes: glass shards, lamp cones');
  assert.ok(!isLightVolume([add({ blend: Blend.Alpha })]));
  assert.ok(!isLightVolume([{ texture: '7:518', blend: Blend.Alpha }, add()]), 'layered surfaces (water)');
});

test('Enhanced light volumes: full face-on, nothing edge-on or at the eye', () => {
  assert.equal(lightVolumeFadeAt(1, 10), 1);
  assert.equal(lightVolumeFadeAt(-1, 10), 1, 'both faces of a two-sided sheet');
  assert.equal(lightVolumeFadeAt(LIGHT_VOLUME.graze[0], 10), 0);
  assert.equal(lightVolumeFadeAt(0, 10), 0);
  assert.equal(lightVolumeFadeAt(1, LIGHT_VOLUME.near[0]), 0);
  const mid = lightVolumeFadeAt(0.45, 10);
  assert.ok(mid > 0.2 && mid < 0.8, `oblique wall partly faded (${mid})`);
  for (let nv = 0; nv < 1; nv += 0.05) assert.ok(lightVolumeFadeAt(nv + 0.05, 5) >= lightVolumeFadeAt(nv, 5), 'monotonic in |N·V|');
});

test('engine shader library: the only view-dependent alpha is LightSpecularAlpha (water), nothing fades a light sheet by angle', { skip }, () => {
  const dir = join(DATA_ROOT, 'xvsh');
  const writers = readdirSync(dir)
    .filter((f) => f.endsWith('.vsh'))
    .filter((f) => /^\s*\w+\s+r2\.w\b/m.test(readFileSync(join(dir, f), 'latin1').replace(/(\/\/|;).*$/gm, '')));
  // The footer scales the vertex alpha by c80.w, the floor splats fade by view depth (ported), the
  // projected shadow by N·L; the specular one is the reflection-vector water term.
  assert.deepEqual(writers.sort(), ['xvsLandsplatAlpha.vsh', 'xvsLightFooter.vsh', 'xvsLightSpecularAlpha.vsh', 'xvsShadowBackfaceCull.vsh']);
  assert.match(readFileSync(join(dir, 'xvsLightSpecularAlpha.vsh'), 'latin1'), /reflection vector/);
});

test('1b arena grate shaft 86c7: four two-sided boxes of 2 m walls, alpha fades along v only, opaque vertex alpha', { skip }, async () => {
  const { loadPackages } = await import('../src/app/loader');
  const fs = nodeFS();
  const lvlPath = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const lvl = new SrscFile(await fs.read(lvlPath));
  const pkgs = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, () => {});
  const o = parseLevelObjects(lvl).find((x) => x.uid === 0x86c7)!;
  assert.ok(o, 'Decoration 86c7');
  const m = readModel(pkgs, { pkg: 9, id: 4284 })!;
  assert.equal(m.submeshes.length, 1);
  const layers = m.submeshes[0].material!.layers;
  assert.deepEqual(layers.map((l) => [l.blend, l.texture, l.tint]), [[Blend.Add, '7:584', 0x414530]]);
  assert.ok(isLightVolume(layers));
  const mdu = pkgs.get(9)!.mdu!;
  assert.ok(!modelCullsBackFaces(mdu.data(findEntry(mdu, 0, 4284)!).getUint32(0, true)), 'drawn two-sided');
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 1; i < m.positions.length; i += 3) (ymin = Math.min(ymin, m.positions[i])), (ymax = Math.max(ymax, m.positions[i]));
  assert.ok(Math.abs(ymin) < 1e-3 && Math.abs(ymax - 2.048) < 1e-3, `walls 0..2.048 m (${ymin}..${ymax})`);
  // Texture 7:584 (stored rows: v = 0 is row 0): white, alpha 0 at the top (v 0.04), ~133 / 255 at the floor (v 0.96), constant across u.
  const tdu = pkgs.get(7)!.tdu!;
  const t = decodeTexture(tdu, findEntry(tdu, TDU_TEXTURE, 584)!, { rowOrder: 'stored' })!;
  const a = (x: number, y: number) => t.rgba[4 * (y * t.width + x) + 3];
  assert.ok(a(64, 4) <= 2 && a(64, 123) >= 125, `fade along v (${a(64, 4)} -> ${a(64, 123)})`);
  for (const y of [40, 80, 120]) {
    const row = Array.from({ length: t.width }, (_, x) => a(x, y));
    assert.ok(Math.max(...row) - Math.min(...row) <= 6, `row ${y}: no fade across u (hard sides in the data)`);
  }
  // Its baked colours carry alpha 255 (the untinted-pass vertex alpha would not apply to a tinted pass anyway).
  const ldu = new SrscFile(await fs.read(lvlPath.replace('.lvl', '_level.ldu')));
  const e = ldu.entries.find((x) => x.id === o.ref.id && x.size >= 12)!;
  const cols = new Uint8Array(ldu.buffer, e.offset + 12, 4 * ldu.data(e).getUint32(8, true));
  for (let i = 3; i < cols.length; i += 4) assert.equal(cols[i], 255);
});

test('1b arena: the lit panel under the grate (Static Object 87cd, 9:5897) is the glow source; the grate is a cut-out', { skip }, async () => {
  const { loadPackages } = await import('../src/app/loader');
  const fs = nodeFS();
  const lvl = new SrscFile(await fs.read('LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl'));
  const pkgs = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, () => {});
  const panel = readModel(pkgs, { pkg: 12, id: 560 })!;
  const pl = panel.submeshes.find((s) => s.material?.key === '9:5897')!.material!.layers;
  assert.deepEqual(pl.map((l) => [l.blend, l.texture, l.tint]), [[Blend.Opaque, '7:596', 0xf0ee99]]);
  assert.ok(glowMarked(pl), 'flag p5: stencil REPLACE, the scene glow takes these pixels');
  const grate = readModel(pkgs, { pkg: 12, id: 635 })!;
  assert.ok(grate.submeshes.some((s) => s.material?.layers[0]?.blend === Blend.Cutout), 'grate 87ce: mode 8 (KEEP, 0x48fb55..0x48fb93)');
});
