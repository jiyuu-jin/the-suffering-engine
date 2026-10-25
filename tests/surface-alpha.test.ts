// Alpha test, blend and coverage of a surface from its base pass's blend mode, shared by static
// surfaces (src/app/surface-material.ts) and skinned ones (src/app/character.ts):
// docs/re/renderer.md "Alpha test, blend and coverage", docs/game-logic.md §11.4, playthrough bug 78.
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blend, findEntry, readDbId, TDU_TEXTURE, type PackageSet, type RiotPackage, type SurfaceMaterial } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { listSkinnedModels, readSkinnedModel } from '../src/formats/skeleton';
import { decodeTexture, punchThroughBlack } from '../src/formats/texture';
import { CUTOUT_ALPHA_TEST, surfaceAlphaTest, surfaceBaseBlend } from '../src/app/surface-material';
import { buildSkinnedMesh, characterAlphaTest, characterLayeredSurface, characterSurfaceBlend, decodeCharacterTextures } from '../src/app/character';
import { DATA_ROOT, filesWithExt, skip } from './helpers';

const mat = (layers: SurfaceMaterial['layers']): SurfaceMaterial => ({ key: 't:1', layers }) as SurfaceMaterial;

test('alpha test by blend mode (0x48fab0): none for 0 and 7, > 2/255 for 1..6, > 32/255 glow-marked add, cut-out', () => {
  assert.equal(surfaceAlphaTest(Blend.Opaque), 0);
  assert.equal(surfaceAlphaTest(Blend.AddOverAlpha), 0);
  for (const b of [Blend.Alpha, Blend.Add, Blend.Opaque3, Blend.Subtract, Blend.MulAlpha, Blend.Modulate2x]) assert.equal(surfaceAlphaTest(b), 2 / 255, `mode ${b}`);
  assert.equal(surfaceAlphaTest(Blend.Add, true), 32 / 255);
  assert.equal(surfaceAlphaTest(Blend.Alpha, true), 2 / 255, 'the glow mark raises only the additive test');
  assert.equal(surfaceAlphaTest(Blend.Cutout), CUTOUT_ALPHA_TEST);
});

test('base blend: the first textured pass decides; texture alpha matters only without a material', () => {
  assert.equal(surfaceBaseBlend(mat([{ blend: Blend.Alpha }, { texture: '1:2', blend: Blend.Opaque }]), true), Blend.Opaque);
  assert.equal(surfaceBaseBlend(mat([{ texture: '1:2', blend: Blend.Cutout }]), false), Blend.Cutout);
  assert.equal(surfaceBaseBlend(mat([{ frames: ['1:2', '1:3'], blend: Blend.Add }]), false), Blend.Add);
  assert.equal(surfaceBaseBlend(undefined, true), Blend.Cutout);
  assert.equal(surfaceBaseBlend(undefined, false), Blend.Opaque);
  assert.equal(surfaceBaseBlend(mat([]), true), Blend.Cutout);
});

test('skinned passes: an opaque pass is never cut, whatever its texture alpha; cut-outs stay cut', () => {
  const opaque = mat([{ texture: '10:352', blend: Blend.Opaque }]);
  assert.equal(characterAlphaTest(opaque, true), 0, 'mode 0 with an alpha texture (Fester 10:1338)');
  assert.equal(characterAlphaTest(opaque, false), 0);
  assert.equal(characterAlphaTest(mat([{ texture: '23:341', blend: Blend.Cutout }]), true), CUTOUT_ALPHA_TEST);
  assert.equal(characterAlphaTest(mat([{ texture: '2:164', blend: Blend.Cutout }]), false), CUTOUT_ALPHA_TEST, 'the header says nothing: the mode cuts');
  assert.equal(characterAlphaTest(undefined, true), CUTOUT_ALPHA_TEST, 'no material: alpha is coverage [port]');
  assert.equal(characterAlphaTest(undefined, false), 0);
});

test('skinned passes: a single mode-7 pass takes the lit surface material (blended, no test, no depth write)', () => {
  const m7 = mat([{ texture: '7:187', blend: Blend.AddOverAlpha }]);
  assert.equal(characterSurfaceBlend(m7), false);
  assert.equal(characterLayeredSurface(m7), true);
  assert.equal(characterLayeredSurface(mat([{ texture: '7:187', blend: Blend.Opaque }])), false);
  assert.equal(characterLayeredSurface(mat([{ texture: '3:694', blend: Blend.Cutout }])), false);
  // Tinted mode 7 stays an effect (unlit, tint x texture).
  assert.equal(characterLayeredSurface(mat([{ texture: '7:542', blend: Blend.AddOverAlpha, tint: 0xb4b4b4 }])), false);
});

test('punch-through texels: black for a pass that does not cut, colour and alpha kept otherwise', () => {
  const src = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 0]);
  const out = punchThroughBlack(src);
  assert.deepEqual([...out], [0, 0, 0, 0, 40, 50, 60, 255, 0, 0, 0, 0]);
  assert.equal(src[0], 10, 'a copy');
});

let cache: PackageSet | undefined;
function packages(): PackageSet {
  if (cache) return cache;
  const out: PackageSet = new Map();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'mdu', 'tdu', 'wdu']) {
      try {
        const b = readFileSync(join(DATA_ROOT, db.slice(0, -3)) + '.' + ext);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p as unknown as RiotPackage);
  }
  return (cache = out);
}

test('every skinned submesh: the lit skin cuts only cut-out passes; mode 7 never reaches it', { skip }, () => {
  const pkgs = packages();
  let skin = 0, cut = 0;
  const opaqueWithAlpha: string[] = [];
  const mode7: string[] = [];
  for (const [pkg, p] of pkgs) {
    if (!p.mdu) continue;
    for (const { id } of listSkinnedModels(p.mdu)) {
      const sk = readSkinnedModel(pkgs, { pkg, id });
      if (!sk) continue;
      sk.model.submeshes.forEach((s, i) => {
        const m = s.material;
        const base = m?.layers.find((l) => l.texture || l.frames);
        if (base?.blend === Blend.AddOverAlpha && base.tint === undefined && m!.layers.filter((l) => l.texture || l.frames).length === 1) {
          mode7.push(`${pkg}:${id}#${i}`);
          assert.equal(characterLayeredSurface(m), true, `${pkg}:${id}#${i} takes the surface material`);
        }
        if (characterSurfaceBlend(m) || characterLayeredSurface(m)) return;
        skin++;
        const [tp, tid] = (s.textureKey ?? '0:0').split(':').map(Number);
        const tdu = pkgs.get(tp)?.tdu;
        const e = findEntry(tdu, TDU_TEXTURE, tid);
        const hasAlpha = !!(tdu && e && decodeTexture(tdu, e, { rowOrder: 'stored' })?.hasAlpha);
        const test = characterAlphaTest(m, hasAlpha);
        if (base?.blend === Blend.Cutout) cut++, assert.equal(test, CUTOUT_ALPHA_TEST, `${pkg}:${id}#${i} cut-out`);
        else assert.equal(test, 0, `${pkg}:${id}#${i} (mode ${base?.blend}) has no alpha test`);
        if (base?.blend === Blend.Opaque && hasAlpha) opaqueWithAlpha.push(`${pkg}:${id}#${i}`);
      });
    }
  }
  assert.ok(skin > 400 && cut >= 30, `${skin} lit skin submeshes, ${cut} cut-outs`);
  // The opaque passes the lit skin cut at 0.5 before (playthrough bug 78).
  assert.deepEqual(opaqueWithAlpha.sort(), ['10:40#4', '23:135#2', '23:137#2', '23:138#2', '23:140#2', '55:1#10']);
  assert.deepEqual(mode7.sort(), ['10:135#0', '10:89#0', '28:46#0', '34:87#2']);
});

test('Fester 10:40 and the PoliceBoat 55:1: opaque parts drawn whole, cut-outs cut, mode 7 blended', { skip }, () => {
  const pkgs = packages();
  const fester = readSkinnedModel(pkgs, { pkg: 10, id: 40 })!;
  const fm = buildSkinnedMesh(fester, decodeCharacterTextures(fester, pkgs)).mesh.material as { alphaTest: number; transparent: boolean }[];
  assert.equal(fm[4].alphaTest, 0, 'part 4 (10:1338, mode 0 over 10:352) is not cut');
  const boat = readSkinnedModel(pkgs, { pkg: 55, id: 1 })!;
  const tex = decodeCharacterTextures(boat, pkgs);
  assert.equal(tex.get('55:11')?.punchThrough, true, 'the lettering decal is DXT1 with 1-bit alpha');
  const bm = buildSkinnedMesh(boat, tex).mesh.material as { alphaTest: number; map?: { image: { data: Uint8Array } } }[];
  assert.equal(bm[10].alphaTest, 0, 'the lettering decal 55:12 is mode 0');
  const data = bm[10].map!.image.data;
  let black = 0, transparent = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) transparent++, (black += +(data[i] + data[i + 1] + data[i + 2] === 0));
  assert.ok(transparent > 0 && black === transparent, 'its alpha-0 texels are black, as Direct3D decodes DXT1');
  assert.equal(bm[5].alphaTest, CUTOUT_ALPHA_TEST, 'the cut-out 55:3 (mode 1 on a 1-bit texture) stays cut');
  const horace = readSkinnedModel(pkgs, { pkg: 10, id: 135 })!;
  const hm = buildSkinnedMesh(horace, decodeCharacterTextures(horace, pkgs)).mesh.material as { alphaTest: number; transparent: boolean; depthWrite: boolean }[];
  assert.deepEqual([hm[0].alphaTest, hm[0].transparent, hm[0].depthWrite], [0, true, false], 'mode 7: blended, no test, no depth write');
});
