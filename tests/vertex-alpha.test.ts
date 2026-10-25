// Baked vertex alpha (docs/re/renderer.md §5.3, docs/playthrough.md row 90): texture stage 0
// alpha of every object pass is texture alpha x DIFFUSE alpha, which for precomputed geometry is
// the .ldu colour's alpha byte (x the object's opacity), unless the pass is tinted (TFACTOR). A
// record with alpha below 0xfe also makes its object translucent: opaque and cut-out passes blend
// as mode 1. The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as THREE from 'three/webgpu';
import { Blend, readModel, templateModelRef, type SurfaceMaterial } from '../src/formats/model';
import { parseLevel, parseLevelObjects, readLevelHeader, staleLduRefs } from '../src/formats/level';
import { SrscFile } from '../src/formats/srsc';
import {
  BLEND_ALPHA_REF,
  lduColorsTranslucent,
  lduVertexAlphaBelowOne,
  passDepthWrite,
  passTakesVertexAlpha,
  translucentPassBlend,
} from '../src/formats/render-data';
import { createSurfaceMaterial, missingTexture, toDataTexture } from '../src/app/surface-material';
import { DATA_ROOT, nodeFS, skip } from './helpers';

const bgra = (...a: number[][]) => Uint8Array.from(a.flat());

test('the .ldu translucent flag: any colour with alpha < 0xfe except the zero dword (0x487722)', () => {
  assert.equal(lduColorsTranslucent(bgra([10, 20, 30, 255], [1, 1, 1, 0xfe])), false, '254 and 255 are opaque');
  assert.equal(lduColorsTranslucent(bgra([10, 20, 30, 255], [1, 1, 1, 0xfd])), true);
  assert.equal(lduColorsTranslucent(bgra([10, 20, 30, 255], [0, 0, 0, 0])), false, 'black with alpha 0 does not count (4a 814d.., 1b 87cd)');
  assert.equal(lduColorsTranslucent(bgra([0, 0, 0, 1])), true, 'black with some alpha does');
  assert.equal(lduVertexAlphaBelowOne(bgra([0, 0, 0, 255], [0, 0, 0, 254]), [0]), false);
  assert.equal(lduVertexAlphaBelowOne(bgra([0, 0, 0, 255], [0, 0, 0, 254]), [0, 1]), true);
});

test('pass rules: untinted passes take the vertex alpha, tinted ones TFACTOR; a translucent object blends modes 0 / 8 as 1', () => {
  assert.equal(passTakesVertexAlpha(undefined), true);
  assert.equal(passTakesVertexAlpha(0xffffff), false, 'a white tint still replaces it (ALPHAARG2 = TFACTOR)');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(translucentPassBlend), [1, 1, 2, 3, 4, 5, 6, 7, 1]);
  assert.equal(passDepthWrite(0), true, 'the first pass keeps its own depth write when blended (0x48fc70)');
});

const tex = toDataTexture({ key: '9:1', width: 4, height: 4, rgba: new Uint8Array(64).fill(200), hasAlpha: true });
const src = { texture: () => tex, missing: missingTexture };
const mat = (layers: SurfaceMaterial['layers']): SurfaceMaterial => ({ key: '9:900', cls: 0, layers });

test('surface graphs: the vertex-alpha term only where some alpha is below 255, and only on untinted passes', () => {
  const add = mat([{ texture: '9:1', blend: Blend.Add }]);
  const plain = createSurfaceMaterial({ material: add, vertexColors: true, hasUvs: true }, src).material;
  const off = createSurfaceMaterial({ material: add, vertexColors: true, hasUvs: true, vertexAlpha: false }, src).material;
  assert.equal(off.colorNode, plain.colorNode, 'all-255 surfaces keep their shared graph (Original unchanged there)');
  const va = createSurfaceMaterial({ material: add, vertexColors: true, hasUvs: true, vertexAlpha: true }, src).material;
  assert.notEqual(va.colorNode, plain.colorNode, '1b 827a / 1c 8041: texture alpha x vertex alpha');
  const noColours = createSurfaceMaterial({ material: add, vertexColors: false, hasUvs: true, vertexAlpha: true }, src).material;
  const noColoursPlain = createSurfaceMaterial({ material: add, vertexColors: false, hasUvs: true }, src).material;
  assert.equal(noColours.colorNode, noColoursPlain.colorNode, 'no baked colours: nothing to read');
  const tinted = mat([{ texture: '9:1', blend: Blend.Add, tint: 0x414530 }]);
  assert.equal(
    createSurfaceMaterial({ material: tinted, vertexColors: true, hasUvs: true, vertexAlpha: true }, src).material.colorNode,
    createSurfaceMaterial({ material: tinted, vertexColors: true, hasUvs: true }, src).material.colorNode,
    'a tinted pass: TFACTOR alpha replaces the vertex alpha',
  );
});

test('surface state: a translucent object draws its opaque first pass as an alpha blend that still writes depth', () => {
  const op = mat([{ texture: '9:1', blend: Blend.Opaque }]);
  const solid = createSurfaceMaterial({ material: op, vertexColors: true, hasUvs: true }, src);
  assert.equal(solid.material.transparent, false);
  const tr = createSurfaceMaterial({ material: op, vertexColors: true, hasUvs: true, vertexAlpha: true, translucent: true }, src);
  assert.equal(tr.blend, Blend.Alpha);
  assert.equal(tr.material.transparent, true);
  assert.equal(tr.material.depthWrite, true, 'ZWRITEENABLE by the layer\'s own mode 0');
  assert.equal(tr.material.blendSrc, THREE.SrcAlphaFactor);
  assert.equal(tr.material.blendDst, THREE.OneMinusSrcAlphaFactor);
  assert.ok(Math.abs(tr.material.alphaTest - BLEND_ALPHA_REF) < 1e-9, 'alpha > 2 / 255');
  // Blended passes are unchanged by the flag.
  const al = createSurfaceMaterial({ material: mat([{ texture: '9:1', blend: Blend.Alpha }]), vertexColors: true, hasUvs: true, translucent: true }, src);
  assert.equal(al.material.depthWrite, false);
});

/** Every placed object with .ldu colours of a level: its record, model and the census flags. */
async function levelCensus(lvlPath: string) {
  const fs = nodeFS();
  const lvl = new SrscFile(await fs.read(lvlPath));
  const { loadPackages } = await import('../src/app/loader');
  const pkgs = await loadPackages(fs, dirname(lvlPath), readLevelHeader(lvl).dependencies, () => {});
  let ldu: SrscFile;
  try {
    ldu = new SrscFile(await fs.read(lvlPath.replace('.lvl', '_level.ldu')));
  } catch {
    return undefined;
  }
  const rec = new Map<number, { model: { id: number; pkg: number }; cols: Uint8Array }>();
  for (const e of ldu.entries) {
    if (e.size < 12) continue;
    const n = ldu.data(e).getUint32(8, true);
    if (12 + 4 * n <= e.size) rec.set(e.id, { model: { id: ldu.data(e).getUint16(0, true), pkg: ldu.data(e).getUint16(2, true) }, cols: new Uint8Array(ldu.buffer, e.offset + 12, 4 * n) });
  }
  const objs = parseLevelObjects(lvl);
  const score = new Map<number, number>();
  for (const o of objs) if (o.ref.pkg && rec.has(o.ref.id)) score.set(o.ref.pkg, (score.get(o.ref.pkg) ?? 0) + 1);
  const levelPkg = [...score].sort((a, b) => b[1] - a[1])[0]?.[0];
  const stale = staleLduRefs(objs, levelPkg, (id) => rec.get(id)?.model, (o) => templateModelRef(pkgs, o.template));
  const out = new Map<number, { vertexAlpha: boolean; promoted: boolean; translucent: boolean; maxAlpha: number; layers: string[] }>();
  for (const o of objs) {
    const r = o.ref.pkg === levelPkg && !stale.has(o.uid) ? rec.get(o.ref.id) : undefined;
    const mr = r ? (r.model.pkg ? r.model : templateModelRef(pkgs, o.template)) : undefined;
    const m = mr && readModel(pkgs, mr);
    if (!r || !m || r.cols.length !== 4 * m.vertexCount) continue;
    const translucent = lduColorsTranslucent(r.cols);
    let vertexAlpha = false, promoted = false, maxAlpha = 0;
    const layers: string[] = [];
    for (const sm of m.submeshes) {
      const L = sm.material?.layers.filter((l) => l.texture || l.frames) ?? [];
      const corners = sm.indices.map((ci) => m.source[ci]);
      for (const c of corners) maxAlpha = Math.max(maxAlpha, r.cols[4 * c + 3]);
      if (L.some((l) => passTakesVertexAlpha(l.tint)) && lduVertexAlphaBelowOne(r.cols, corners)) vertexAlpha = true;
      if (translucent && L.some((l) => translucentPassBlend(l.blend) !== l.blend)) promoted = true;
      layers.push(...L.map((l) => `${l.blend}${l.tint !== undefined ? 't' : ''}:${l.texture}`));
    }
    if (vertexAlpha || promoted) out.set(o.uid, { vertexAlpha, promoted, translucent, maxAlpha, layers });
  }
  return { lvl, pkgs, ldu, out };
}

test('census: surfaces whose untinted passes read a vertex alpha below 255, and objects the flag blends, per level', { skip }, async () => {
  const counts: Record<string, [number, number]> = {};
  for (const d of readdirSync(join(DATA_ROOT, 'LEVELS')).sort()) {
    for (const f of readdirSync(join(DATA_ROOT, 'LEVELS', d)).filter((x) => x.endsWith('.lvl'))) {
      const c = await levelCensus(`LEVELS/${d}/${f}`);
      if (!c) continue;
      const v = [...c.out.values()];
      const n: [number, number] = [v.filter((x) => x.vertexAlpha).length, v.filter((x) => x.promoted).length];
      if (n[0] || n[1]) counts[f.split(' ')[0]] = n;
    }
  }
  // [objects with an untinted pass over vertex alpha < 255, objects whose opaque passes now blend]
  assert.deepEqual(counts, {
    '0': [33, 49], // 30 harbour Water Volumes (7:1440, alpha 92..242) + 3 shore sheets; the open sea (7:1582, tinted) blends
    '1b': [11, 0], // 827a and the ten 3:3103 additive sheets around the yard
    '1c': [1, 0], // 8041
    '4a': [14, 0],
    '5a': [2, 1], // 21c6 shore; 1e48 (opaque, alpha 223..255) blends
    '6a': [29, 0],
    '6b': [50, 0],
    '8a': [11, 0],
    '8b': [1, 0],
    '9': [9, 0],
    '10': [10, 0],
  });
});

test('1b 827a and 1c 8041: untinted additive sheets whose baked alpha softens them to nothing at the edges', { skip }, async () => {
  const b = (await levelCensus('LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl'))!;
  const s = b.out.get(0x827a)!;
  assert.deepEqual([s.vertexAlpha, s.translucent, s.maxAlpha, s.layers], [true, true, 88, ['2:3:376']]);
  const c = (await levelCensus('LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl'))!;
  const t = c.out.get(0x8041)!;
  assert.deepEqual([t.vertexAlpha, t.maxAlpha, t.layers], [true, 14, ['2:4:1940']]);
  // 1b's pit panel 87cd has zero colours but a tinted pass: neither term applies.
  assert.equal(b.out.has(0x87cd), false);
  // The merged level geometry carries the flags (renderer.ts takes them per mesh).
  const level = parseLevel(b.lvl, '1b', { ldu: b.ldu, packages: b.pkgs });
  const sheet = level.parts.filter((p) => p.material?.key === '3:3103');
  assert.ok(sheet.length && sheet.every((p) => p.vertexAlpha && p.translucent), '3:3103 parts');
  assert.ok(level.parts.filter((p) => p.vertexAlpha).every((p) => p.colors && [...p.colors.filter((_, i) => i % 4 === 3)].some((a) => a < 1)));
  assert.ok(level.parts.some((p) => !p.vertexAlpha && p.colors), 'everything else stays as it was');
});

test('0 Prelude Docks: the harbour water is blended by its vertex alpha, the open sea becomes a (texture-opaque) blend', { skip }, async () => {
  const c = (await levelCensus('LEVELS/0 Prelude Docks/0 Prelude Docks.lvl'))!;
  const harbour = c.out.get(0x10ed)!;
  assert.deepEqual([harbour.vertexAlpha, harbour.promoted, harbour.maxAlpha], [true, false, 92]);
  assert.equal(harbour.layers[0], '1:7:744', 'alpha blend of an alpha-less texture: the vertex alpha alone');
  const sea = c.out.get(0x104e)!;
  assert.deepEqual([sea.vertexAlpha, sea.promoted, sea.maxAlpha], [false, true, 242]);
  assert.equal(sea.layers[0], '0t:7:744', 'tinted: TFACTOR alpha (1) x texture alpha (255), so it stays opaque in colour');
});
