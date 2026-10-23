// HDR scene glow (SUFFERING.EXE 0x48d0a0, docs/re/renderer.md §3.2; port src/app/scene-glow.ts):
// which passes mark the glow, the chain's gain and spread, and the lamp tables that carry the
// marks (the frosted glass and the bulb of the "on" tables).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOW_MASK_REF, glowMarkAlphaRef, glowMarked, sceneGlowReference } from '../src/formats/render-data';
import { nodeFS, skip } from './helpers';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('glow marks: any flagged layer marks (stencil REPLACE wins over KEEP); the mark keeps the pass alpha test', () => {
  assert.equal(glowMarked([{ blend: 0 }]), false);
  assert.equal(glowMarked([{ blend: 0, depthWrite: true }]), true);
  assert.equal(glowMarked([{ blend: 0 }, { blend: 7, depthWrite: true }]), true);
  assert.equal(glowMarked(undefined), false);
  assert.equal(glowMarkAlphaRef(0), null);
  assert.equal(glowMarkAlphaRef(7), null);
  close(glowMarkAlphaRef(2)!, 32 / 255);
  close(glowMarkAlphaRef(1)!, 2 / 255);
  close(glowMarkAlphaRef(8)!, 200 / 255);
  close(GLOW_MASK_REF, 5 / 255);
});

const N = 256;
function field(fn: (x: number, y: number) => number): Float32Array {
  const a = new Float32Array(N * N * 3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) a.fill(fn(x, y), (y * N + x) * 3, (y * N + x) * 3 + 3);
  return a;
}
const at = (c: Float32Array, x: number, y: number) => c[(y * N + x) * 3];

test('glow chain: a flat marked area comes back about 3.4 times (4 levels of 0.5 x 480/255), saturating', () => {
  const dim = sceneGlowReference(field(() => 0.1));
  // Per level 0.5 x 1.882 of the previous level: 0.94 + 0.89 + 0.83 + 0.78 of the source.
  const gain = at(dim, 128, 128) / 0.1;
  assert.ok(gain > 3.2 && gain < 3.6, `gain ${gain}`);
  // The lamp glass (texture x 0x8a8a75 ~ 0.42 gamma) and the bulb saturate: white.
  const glass = sceneGlowReference(field(() => 0.42));
  assert.equal(at(glass, 128, 128), 1);
  // Nothing marked: no glow.
  assert.equal(sceneGlowReference(field(() => 0)).reduce((s, v) => s + v, 0), 0);
});

test('glow chain: a small marked spot spreads a halo well past itself (the 32² level blurs over 16 texels)', () => {
  const spot = sceneGlowReference(field((x, y) => (Math.abs(x - 128) < 4 && Math.abs(y - 128) < 4 ? 0.8 : 0)));
  assert.ok(at(spot, 128, 128) > 0.8);
  assert.ok(at(spot, 128 + 20, 128) > 0, 'halo 20 texels out');
  assert.ok(at(spot, 128 + 20, 128) < at(spot, 128 + 6, 128));
  assert.equal(at(spot, 10, 10), 0);
});

test('lamp tables: the "on" glass (7:1863) and bulb (4:1374) mark the glow, the "off" ones do not', { skip }, async () => {
  const { loadPackages } = await import('../src/app/loader');
  const { readLevelHeader } = await import('../src/formats/level');
  const { parseEntities } = await import('../src/formats/entities');
  const { readMaterial } = await import('../src/formats/model');
  const { SrscFile } = await import('../src/formats/srsc');
  const fs = nodeFS();
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = new SrscFile(await fs.read(path));
  const packages = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, () => {});
  const marks = (r: { pkg: number; id: number } | null) => (r ? glowMarked(readMaterial(packages, r)?.layers) : false);
  // The shade lamp 9:2653 (model 9:1878): [rod, chrome shade, bulb, frosted glass].
  assert.deepEqual([{ pkg: 7, id: 1860 }, { pkg: 7, id: 2140 }, { pkg: 4, id: 1374 }, { pkg: 7, id: 1863 }].map(marks), [false, false, true, true]);
  assert.deepEqual([{ pkg: 7, id: 1860 }, { pkg: 7, id: 2140 }, { pkg: 4, id: 1373 }, { pkg: 7, id: 1860 }].map(marks), [false, false, false, false]);
  // Every lamp type of 1a: its "on" table marks something, its "off" table less.
  const seen = new Set<string>();
  for (const e of parseEntities(lvl, packages)) {
    if (e.className !== 'Light Housing') continue;
    const key = `${e.template.pkg}:${e.template.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const on = ((e.values[32] as never[]) ?? []).filter((r) => marks(r)).length;
    const off = ((e.values[33] as never[]) ?? []).filter((r) => marks(r)).length;
    const listed = ((e.values[32] as never[]) ?? []).length > 0;
    if (listed) assert.ok(on > off, `${key}: on ${on} off ${off}`);
  }
  assert.ok(seen.size >= 8);
});

test('glow mark survives no JSON round trip: a plain clone has no mark, cloneWithGlowMark shares the real one', async () => {
  // Material.copy deep-copies userData through JSON.stringify / parse; a mark stored there as an
  // enumerable material came back a plain object that the glow pass handed to the renderer
  // ("customProgramCacheKey is not a function", chapter 5 in 1c6b915).
  const THREE = await import('three/webgpu');
  const { cloneWithGlowMark, glowMark, setGlowMark } = await import('../src/app/glow-mark');
  const src = new THREE.MeshStandardNodeMaterial();
  const mark = new THREE.MeshBasicNodeMaterial();
  setGlowMark(src, mark);
  assert.equal(glowMark(src), mark);
  assert.equal(JSON.stringify(src.userData), '{}');
  const plain = src.clone();
  assert.equal(glowMark(plain), undefined);
  const kept = cloneWithGlowMark(src);
  assert.equal(glowMark(kept), mark);
  assert.equal(glowMark(kept.clone()), undefined);
  // Whatever else sits under the key (an old enumerable copy, JSON data) is no mark.
  const stale = new THREE.MeshStandardNodeMaterial();
  stale.userData.glowMark = mark;
  assert.equal(glowMark(stale.clone()), undefined);
});

test('cloneWithGlowMark keeps the alpha test that NodeMaterial.copy drops (three r186)', async () => {
  const THREE = await import('three/webgpu');
  const { cloneWithGlowMark } = await import('../src/app/glow-mark');
  const cut = new THREE.MeshStandardNodeMaterial({ alphaTest: 200 / 255 });
  assert.equal(cut.alphaTest, 200 / 255);
  // The bug this guards against (a cloned cut-out drew its discarded texels: 6a's black cones).
  // If three fixes NodeMaterial.copy the first check starts failing: the workaround can go.
  assert.equal(cut.clone().alphaTest, 0, 'NodeMaterial.copy skips _alphaTest');
  assert.equal(cloneWithGlowMark(cut).alphaTest, 200 / 255);
});
