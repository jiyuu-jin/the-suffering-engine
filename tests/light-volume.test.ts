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

// ---------------------------------------------------------------------------
// Thickness volumes (enhanced/light-volume.ts fitLightShaft / takeLightShafts, light-volume-pass.ts)

import { fitLightShaft, takeLightShafts, triangleComponents, shapeDensity, volumeRayLight, LIGHT_SHAFT, type WallLight } from '../src/app/enhanced/light-volume';
import type { MeshPart } from '../src/formats/types';

/** An open box of four walls (w x d section, h tall, from y0), v = 0 at the top, 1 at the floor. */
function box(cx: number, cz: number, w: number, d: number, h: number, y0 = 0) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
    const base = pos.length / 3;
    for (const [x, z, y, u, v] of [[ax, az, y0, 0, 1], [bx, bz, y0, 1, 1], [bx, bz, y0 + h, 1, 0], [ax, az, y0 + h, 0, 0]]) pos.push(cx + x, y, cz + z), uv.push(u, v);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos: Float32Array.from(pos), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
}
/** A light that fades along v only (as 7:584): alpha v, white. */
const fadeV: WallLight = (_u, v) => [0.02 * v, 0.02 * v, 0.02 * v];
const allTris = (n: number) => Array.from({ length: n / 3 }, (_, i) => 3 * i);

test('light shafts: an open box of light walls becomes a volume along v, boxy section, brightest at the floor', () => {
  const b = box(0, 0, 4, 4, 2);
  const s = fitLightShaft(b.pos, b.uv, allTris(b.idx.length), b.idx, fadeV)!;
  assert.ok(s, 'fitted');
  assert.ok(Math.abs(Math.abs(s.axis[1]) - 1) < 1e-6, 'axis vertical (v runs along the height)');
  assert.ok(Math.abs(s.length - 2) < 1e-3);
  for (const r of [...s.r0, ...s.r1]) assert.ok(Math.abs(r - 2) < 0.05, `half extent 2 (${r})`);
  assert.equal(s.exponent, LIGHT_SHAFT.boxExponent, 'a box section');
  const p = s.profile!;
  // Profile along z: the axis points down (v grows downwards), so z = L is the floor.
  assert.ok(p[3 * 15 + 1] > 0.9 && p[1] < 0.15, `fades along the height (${p[1]} .. ${p[3 * 15 + 1]})`);
  // Soft sides: full light on the axis, none at the walls, in between half-way out.
  const mid = s.length / 2;
  assert.ok(shapeDensity(s, s.c0[0], s.c0[1], mid) > 0.99);
  assert.equal(shapeDensity(s, s.c0[0] + 2.01, s.c0[1], mid), 0);
  const half = shapeDensity(s, s.c0[0] + 1.4, s.c0[1], mid);
  assert.ok(half > 0.05 && half < 0.95, `fades towards the side (${half})`);
});

test('light shafts: the budget: over the spread of views the volume adds what the walls add', () => {
  const b = box(0, 0, 4, 4, 2);
  const s = fitLightShaft(b.pos, b.uv, allTris(b.idx.length), b.idx, fadeV)!;
  // Horizontal rays across the box at every height and offset: the walls add two crossings
  // each (a hard-edged band), the volume a soft one; summed over the set they agree.
  let walls = 0, vol = 0;
  for (let y = 0.05; y < 2; y += 0.1)
    for (let z = -2.95; z < 3; z += 0.1) {
      if (Math.abs(z) < 2) walls += 2 * fadeV(0, 1 - y / 2)[0];
      vol += volumeRayLight(s, [-10, y, z], [1, 0, 0], 64) * s.gain;
    }
  assert.ok(vol > 0.5 * walls && vol < 2 * walls, `budget (${vol.toFixed(3)} vs ${walls.toFixed(3)})`);
  // The light gathers where the path through the air is long: the middle is brighter than a wall pair.
  const o: [number, number, number] = [-10, 0.3, 0], d: [number, number, number] = [1, 0, 0];
  assert.ok(volumeRayLight(s, o, d, 200) * s.gain > 2 * fadeV(0, 1 - 0.3 / 2)[0], 'brighter core');
  // A ray past the box's side adds nothing (the walls' hard edge is gone).
  assert.equal(volumeRayLight(s, [-10, 0.3, 2.2], d, 50), 0);
  // Grazing the side inside the box: much less than through the middle.
  assert.ok(volumeRayLight(s, [-10, 0.3, 1.7], d, 200) < 0.4 * volumeRayLight(s, o, d, 200));
});

test('light shafts: flat sheets, slabs and cards stay sheets', () => {
  // One wall (a card): does not enclose the axis.
  const b = box(0, 0, 4, 4, 2);
  const one = fitLightShaft(b.pos, b.uv, [0, 3], b.idx, fadeV);
  assert.equal(one, null, 'a single wall');
  // A thin slab (14 x 0.3 section, like 1b's ceiling grate sheet 9:5847).
  const slab = box(0, 0, 14, 0.3, 2);
  assert.equal(fitLightShaft(slab.pos, slab.uv, allTris(slab.idx.length), slab.idx, fadeV), null, 'slab');
  // A floor pool: v not along any axis the walls run along.
  const floor = { pos: Float32Array.from([0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4]), uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]), idx: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
  assert.equal(fitLightShaft(floor.pos, floor.uv, [0, 3], floor.idx, fadeV), null, 'floor sheet');
});

test('light shafts: takeLightShafts removes the shaft components and keeps the rest of the part', () => {
  const a = box(0, 0, 4, 4, 2), c = box(10, 0, 4, 4, 2);
  // Two boxes in one part, the second missing three walls (a card).
  const n = a.pos.length / 3;
  const idx = [...a.idx, ...Array.from(c.idx.slice(0, 6), (i) => i + n)];
  const part = {
    positions: Float32Array.from([...a.pos, ...c.pos]),
    uvs: Float32Array.from([...a.uv, ...c.uv]),
    indices: Uint32Array.from(idx),
    textureKey: '7:584',
    material: { key: '9:5841', cls: 0, layers: [add()] },
  } as unknown as MeshPart;
  assert.equal(triangleComponents(part.positions, part.indices).length, 2);
  const tex = { width: 2, height: 2, rgba: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 200, 255, 255, 255, 200]) };
  const r = takeLightShafts([part], () => tex);
  assert.equal(r.volumes.length, 1);
  assert.equal(r.parts.length, 1);
  assert.equal(r.parts[0].indices.length, 6, 'the card stays a sheet');
  // Untinted or layered passes are not light volumes: untouched.
  const lit = { ...part, material: { key: 'x', cls: 0, layers: [add({ tint: undefined })] } } as unknown as MeshPart;
  assert.deepEqual(takeLightShafts([lit], () => tex).parts, [lit]);
});

test('light shafts in the data: 1b arena 86c7 is four box volumes, its ceiling sheet 9:5847 stays', { skip }, async () => {
  const { loadLevel } = await import('../src/app/loader');
  const L = await loadLevel(nodeFS(), 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl');
  const tex = new Map(L.textures.map((t) => [t.key, t]));
  const r = takeLightShafts(L.level.parts, (k) => tex.get(k));
  assert.equal(r.volumes.length, 4);
  for (const v of r.volumes) {
    assert.ok(Math.abs(v.axis[1] + 1) < 1e-3, 'down the shaft');
    assert.ok(Math.abs(v.length - 2.05) < 0.05);
    assert.ok(v.r0[0] > 2.2 && v.r0[0] < 2.45 && v.r1[0] > 1.8 && v.r1[0] < 2.05, `walls lean out upwards (${v.r0[0]} / ${v.r1[0]})`);
    assert.ok(v.gain > 0 && Number.isFinite(v.gain));
  }
  assert.ok(r.parts.some((p) => p.material?.key === '9:5847'), 'the ceiling grate sheet stays');
  assert.ok(!r.parts.some((p) => p.material?.key === '9:5841'), 'the shaft walls are gone');
});
