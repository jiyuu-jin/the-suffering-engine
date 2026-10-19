// Translucent and additive passes as SUFFERING.EXE draws them (docs/re/renderer.md §5.1,
// src/formats/render-data.ts): the pass state word, depth writes, alpha tests, the gamma back
// buffer blend, and the data behind Hermes and the gas-chamber glass. Pure checks, then data and
// EXE checks against a local install (skipped without one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, nodeFS, skip } from './helpers';
import {
  backBufferBlend,
  DEFAULT_PASS_STATE,
  modelCullsBackFaces,
  PassBit,
  passAlphaRef,
  passDepthWrite,
  tintFactor,
  tintFactorWord,
  worldStageColor,
} from '../src/formats/render-data';
import { Blend, CLASS_ADVANCED, CLASS_SIMPLE, findEntry, MDU_HEADER, readMaterial, TDU_TEXTURE, type PackageSet } from '../src/formats/model';
import { decodeTexture } from '../src/formats/texture';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { SrscFile } from '../src/formats/srsc';

const close = (a: number, b: number, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} != ${b}`);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

test('default pass state 0x63a08: fog, alpha-op MODULATE, z test and write on; no culling', () => {
  const s = DEFAULT_PASS_STATE;
  assert.ok(s & PassBit.Fog);
  assert.ok(s & PassBit.AlphaModulate, 'texture alpha × diffuse / TFACTOR alpha');
  assert.ok(s & PassBit.ZEnable);
  assert.ok(s & PassBit.ZWrite);
  assert.equal(s & PassBit.Cull, 0, 'two-sided unless the model asks');
  assert.equal(s & (PassBit.Stencil | PassBit.StencilReplace), 0);
});

test('only models with header flag bit 23 cull back faces (loader mask 0x1c3c000)', () => {
  assert.equal(modelCullsBackFaces(0x00cc0002), true, "Hermes' model 10:92");
  assert.equal(modelCullsBackFaces(0x000d0012), false, 'window glass model 9:2089');
  assert.equal(modelCullsBackFaces(0x000c8002), false, 'gas tank model 9:2085');
  assert.equal(modelCullsBackFaces(0x00800000), true);
});

test('depth is written only by an opaque or cut-out first pass', () => {
  assert.equal(passDepthWrite(Blend.Opaque), true);
  assert.equal(passDepthWrite(Blend.Cutout), true);
  for (const b of [Blend.Alpha, Blend.Add, Blend.Opaque3, Blend.Subtract, Blend.MulAlpha, Blend.Modulate2x, Blend.AddOverAlpha]) {
    assert.equal(passDepthWrite(b), false, `blend ${b}`);
  }
});

test('alpha tests: none for 0 / 7, 200 for cut-outs, 32 for a glow-marked additive pass, else 2', () => {
  assert.equal(passAlphaRef(Blend.Opaque), null);
  assert.equal(passAlphaRef(Blend.AddOverAlpha), null);
  close(passAlphaRef(Blend.Cutout)!, 200 / 255);
  close(passAlphaRef(Blend.Add)!, 2 / 255);
  close(passAlphaRef(Blend.Add, true)!, 32 / 255);
  close(passAlphaRef(Blend.Alpha, true)!, 2 / 255, 1e-9, 'only mode 2 takes the higher reference');
  for (const b of [Blend.Alpha, Blend.Subtract, Blend.MulAlpha, Blend.Modulate2x]) close(passAlphaRef(b)!, 2 / 255);
});

test('TFACTOR: halved tint, alpha = layer alpha × object opacity (0xff when that is 1)', () => {
  assert.equal(tintFactorWord(0x4b4b4b, 1, 1), 0xff252525);
  // Hermes at 85 %: alpha byte ftol(0.85 × 255) = 216.
  assert.equal(tintFactorWord(0x4b4b4b, 1, 0.85) >>> 24, 216);
  assert.equal(tintFactorWord(0x4b4b4b, 1, 0.85) & 0xffffff, 0x252525);
  assert.equal(tintFactorWord(0xffffff, 1, 0) >>> 24, 0);
});

test('back buffer blends: the factors of 0x49a990 on gamma values, saturated', () => {
  close(backBufferBlend(Blend.Add, 0.5, 0.5, 0.9), 1, 1e-9, 'add saturates');
  close(backBufferBlend(Blend.Add, 0.2, 0.5, 0.3), 0.4);
  close(backBufferBlend(Blend.Alpha, 1, 0.25, 0.2), 0.4);
  close(backBufferBlend(Blend.Cutout, 1, 1, 0.2), 1);
  close(backBufferBlend(Blend.Subtract, 0.5, 1, 0.2), 0, 1e-9, 'subtract stops at 0');
  close(backBufferBlend(Blend.MulAlpha, 0.9, 0.5, 0.6), 0.3);
  close(backBufferBlend(Blend.Modulate2x, 0.5, 1, 0.37), 0.37, 1e-9, 'modulate 2x: 50 % grey is neutral');
  close(backBufferBlend(Blend.AddOverAlpha, 0.3, 0.5, 0.4), 0.5);
  close(backBufferBlend(Blend.Opaque, 0.3, 0, 0.9), 0.3);
});

test("Hermes' glow over the glass-lit tank: a gamma-space sum, not a linear one", () => {
  // His skin pass: texture × TFACTOR (0x4b / 2) doubled by texture stage 1, × 85 % opacity as
  // the source alpha, added (SRCALPHA, ONE).
  const tf = tintFactor(0x4b4b4b)![0];
  const texel = 229 / 255; // the brightest texel of 10:269
  const src = worldStageColor(texel * tf);
  const a = 216 / 255;
  const dst = 0.4; // the tank seen through the window glass (port frames: ~100 / 255)
  const engine = backBufferBlend(Blend.Add, src, a, dst);
  close(engine - dst, src * a, 1e-9);
  assert.ok(engine - dst > 0.2, `rise ${engine - dst}`);
  // The same addition in a linear frame buffer (three.js default) rises far less.
  const linear = linearToSrgb(srgbToLinear(dst) + srgbToLinear(src) * a);
  assert.ok(linear - dst < (engine - dst) * 0.6, `linear rise ${linear - dst} vs ${engine - dst}`);
});

// ---------------------------------------------------------------------------
// Data

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
let pkgs: PackageSet | undefined;
async function packages1a(): Promise<PackageSet> {
  if (pkgs) return pkgs;
  const fs = nodeFS();
  const lvl = new SrscFile(await fs.read(L1A));
  pkgs = await loadPackages(fs, L1A.slice(0, L1A.lastIndexOf('/')), readLevelHeader(lvl).dependencies, () => {});
  return pkgs;
}
function headerFlags(p: PackageSet, pkg: number, id: number): number {
  const mdu = p.get(pkg)?.mdu;
  const e = findEntry(mdu, MDU_HEADER, id);
  assert.ok(mdu && e, `model ${pkg}:${id}`);
  return mdu!.data(e!).getUint32(0, true);
}

test('the gas-chamber window glass 7:1885 is one untinted additive pass of white at alpha 128', { skip }, async () => {
  const p = await packages1a();
  const m = readMaterial(p, { pkg: 7, id: 1885 })!;
  assert.equal(m.cls, CLASS_SIMPLE);
  assert.equal(m.layers.length, 1);
  const l = m.layers[0];
  assert.equal(l.blend, Blend.Add);
  assert.equal(l.tint, undefined, 'untinted: lit by the vertex lighting');
  assert.equal(l.texture, '7:603');
  const tdu = p.get(7)!.tdu!;
  const t = decodeTexture(tdu, findEntry(tdu, TDU_TEXTURE, 603)!);
  let minRgb = 255, maxA = 0, minA = 255;
  for (let i = 0; i < t.width * t.height; i++) {
    minRgb = Math.min(minRgb, t.rgba[4 * i], t.rgba[4 * i + 1], t.rgba[4 * i + 2]);
    maxA = Math.max(maxA, t.rgba[4 * i + 3]);
    minA = Math.min(minA, t.rgba[4 * i + 3]);
  }
  assert.equal(minRgb, 255);
  assert.equal(minA, 128);
  assert.equal(maxA, 128);
  // Its model is two-sided (no cull flag): both faces of the pane add their light.
  assert.equal(modelCullsBackFaces(headerFlags(p, 9, 2089)), false);
});

test("Hermes' skin 10:92: two tinted additive Advanced passes (0x4b4b4b), a culling model", { skip }, async () => {
  const p = await packages1a();
  for (const id of [814, 815]) {
    const m = readMaterial(p, { pkg: 10, id })!;
    assert.equal(m.cls, CLASS_ADVANCED);
    assert.equal(m.layers[0].blend, Blend.Add);
    assert.equal(m.layers[0].tint, 0x4b4b4b);
    assert.ok(!m.layers[0].depthWrite, 'no glow mark');
  }
  assert.equal(modelCullsBackFaces(headerFlags(p, 10, 92)), true);
  // The tank around him: two-sided, its solid north panel (9:5350) opaque.
  assert.equal(modelCullsBackFaces(headerFlags(p, 9, 2085)), false);
  assert.equal(readMaterial(p, { pkg: 9, id: 5350 })!.layers[0].blend, Blend.Opaque);
  assert.equal(readMaterial(p, { pkg: 7, id: 1873 })!.layers[0].blend, Blend.Alpha, 'tank glass');
});

// ---------------------------------------------------------------------------
// SUFFERING.EXE

const EXE = join(DATA_ROOT, 'SUFFERING.EXE');
const exeSkip = existsSync(EXE) ? false : `no ${EXE}`;
/** Bytes at virtual address `va` (PE sections mapped by hand). */
function exeBytes(va: number, n: number): Buffer {
  const b = readFileSync(EXE);
  const pe = b.readUInt32LE(0x3c);
  const sections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const imageBase = b.readUInt32LE(pe + 24 + 28);
  let s = pe + 24 + optSize;
  for (let i = 0; i < sections; i++, s += 40) {
    const vaddr = imageBase + b.readUInt32LE(s + 12), vsize = b.readUInt32LE(s + 8), raw = b.readUInt32LE(s + 20);
    if (va >= vaddr && va + n <= vaddr + vsize) return b.subarray(raw + va - vaddr, raw + va - vaddr + n);
  }
  throw new Error(`va ${va.toString(16)} not mapped`);
}

test('EXE: both object draws start from the state word 0x63a08', { skip: exeSkip }, () => {
  // mov dword ptr [0x6dd280], 0x63a08 / mov dword ptr [0x6dd8d4], 0x63a08
  assert.deepEqual([...exeBytes(0x586290, 10)], [0xc7, 0x05, 0x80, 0xd2, 0x6d, 0x00, 0x08, 0x3a, 0x06, 0x00]);
  assert.deepEqual([...exeBytes(0x586a80, 10)], [0xc7, 0x05, 0xd4, 0xd8, 0x6d, 0x00, 0x08, 0x3a, 0x06, 0x00]);
});

test('EXE: blend table 0x49aa3c and the glow-marked additive alpha reference 0x20', { skip: exeSkip }, () => {
  const t = exeBytes(0x49aa3c, 36);
  const targets = Array.from({ length: 9 }, (_, i) => t.readUInt32LE(4 * i));
  // Modes 1 and 8 share the alpha-blend case; 0 and 3 the default (ONE, ZERO).
  assert.equal(targets[1], targets[8]);
  assert.equal(targets[0], targets[3]);
  assert.equal(new Set(targets).size, 7);
  // 0x48fb40: mov dword ptr [esi + 8], 0x20 (ALPHAREF of a mode-2 pass with layer flag 4).
  assert.deepEqual([...exeBytes(0x48fb40, 7)], [0xc7, 0x46, 0x08, 0x20, 0x00, 0x00, 0x00]);
  // 0x49a766: SetRenderState(0x37 STENCILPASS, ...) is what layer flag 4 drives (bits 19 / 20).
  assert.deepEqual([...exeBytes(0x49a765, 3)], [0x52, 0x6a, 0x37]);
});
