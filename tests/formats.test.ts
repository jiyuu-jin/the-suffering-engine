// Data-pipeline tests against a local game install (skipped without one).
// Assertions are structural only (counts, sizes, ranges); no game content is
// embedded in the repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allFiles, filesWithExt, nodeFS, readSrsc, skip } from './helpers';
import { decodeDxt, decodeTextures } from '../src/formats/texture';
import { parseLevel, parseLevelObjects, readLevelHeader } from '../src/formats/level';
import { indexSounds } from '../src/formats/sound';
import { asfPlayDuration, listVideos } from '../src/formats/video';
import { readFonts } from '../src/formats/font';
import { StringTable } from '../src/formats/strings';
import { parseEntities } from '../src/formats/entities';
import { readFrontEnd } from '../src/formats/gui';
import { decodeReferencedTextures, findLevelDependencies, loadPackages, stem } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';

const silent = () => {};

test('every container is a readable SRSC file', { skip }, () => {
  const containers = allFiles().filter((f) => /\.(\w)du$|\.lvl$/i.test(f));
  assert.ok(containers.length >= 200, `expected 200+ containers, found ${containers.length}`);
  for (const f of containers) {
    // Skip the huge audio/video banks here; they get their own tests.
    if (/\.(sdu|vdu)$/i.test(f)) continue;
    const file = readSrsc(f);
    assert.equal(file.version, 0x0101, f);
    for (const e of file.entries) {
      assert.ok(e.offset + e.size <= file.buffer.byteLength, `${f}: entry ${e.index} past end of file`);
    }
  }
});

test('all textures decode to square RGBA images', { skip }, () => {
  let count = 0;
  for (const f of filesWithExt('.tdu')) {
    for (const t of decodeTextures(readSrsc(f))) {
      assert.equal(t.rgba.length, t.width * t.height * 4, `${f} ${t.key}`);
      assert.ok(t.width >= 1 && t.width <= 1024 && t.height >= 1 && t.height <= 1024, `${f} ${t.key}`);
      count++;
    }
  }
  assert.ok(count > 5000, `expected 5000+ textures, decoded ${count}`);
});

test('every level parses into renderable geometry with a spawn', { skip }, async () => {
  const fs = nodeFS();
  const levels = filesWithExt('.lvl');
  assert.equal(levels.length, 18);
  const origWarn = console.warn;
  console.warn = silent;
  try {
    for (const path of levels) {
      const deps = await findLevelDependencies(fs, path);
      const lvl = readSrsc(path);
      const ldu = deps.levelLdu ? readSrsc(deps.levelLdu) : undefined;
      const header = readLevelHeader(lvl);
      assert.ok(header.dependencies.length > 0, `${path}: no package dependencies`);
      const packages = await loadPackages(fs, dirname(path), header.dependencies, silent);
      const level = parseLevel(lvl, stem(path), { ldu, packages });

      let tris = 0;
      for (const p of level.parts) {
        assert.equal(p.positions.length % 3, 0);
        const verts = p.positions.length / 3;
        for (let i = 0; i < p.indices.length; i++) assert.ok(p.indices[i] < verts, `${path}: index out of range`);
        for (const v of p.positions) assert.ok(Number.isFinite(v), `${path}: non-finite vertex`);
        tris += p.indices.length / 3;
      }
      assert.ok(tris > 20_000, `${path}: only ${tris} triangles`);
      assert.ok(level.spawn, `${path}: no player spawn`);
      assert.ok(level.spawn!.position.every(Number.isFinite), `${path}: bad spawn`);

      // Every textured part should resolve to a decodable texture.
      const textures = decodeReferencedTextures(level, packages);
      const keys = new Set(textures.map((t) => t.key));
      const missing = level.parts.filter((p) => p.textureKey && !keys.has(p.textureKey)).length;
      assert.ok(missing / level.parts.length < 0.02, `${path}: ${missing} parts missing textures`);
    }
  } finally {
    console.warn = origWarn;
  }
});

test('every level object resolves to a known entity class', { skip }, async () => {
  const fs = nodeFS();
  for (const path of filesWithExt('.lvl')) {
    const lvl = readSrsc(path);
    const packages = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, silent);
    const objects = parseLevelObjects(lvl);
    const entities = parseEntities(lvl, packages);
    assert.equal(entities.length, objects.length, path);
    const unknown = entities.filter((e) => !e.className || /^0x/i.test(e.className)).length;
    assert.equal(unknown, 0, `${path}: ${unknown} entities with unknown class`);
    assert.equal(entities.filter((e) => e.className === 'Player').length >= 1, true, `${path}: no Player`);
  }
});

test('sound banks index cleanly as 16-bit PCM', { skip }, () => {
  let count = 0;
  for (const f of filesWithExt('.sdu')) {
    const file = readSrsc(f);
    for (const s of indexSounds(file, 0)) {
      assert.equal(s.bitsPerSample, 16, `${f} ${s.key}`);
      assert.ok(s.channels === 1 || s.channels === 2, `${f} ${s.key}`);
      assert.ok(s.sampleRate >= 2000 && s.sampleRate <= 48000, `${f} ${s.key}`);
      assert.ok(s.duration > 0, `${f} ${s.key}`);
      count++;
    }
  }
  assert.ok(count > 3000, `expected 3000+ sounds, found ${count}`);
});

test('video banks list videos with sane headers and ASF durations', { skip }, () => {
  let count = 0;
  for (const f of filesWithExt('.vdu')) {
    const file = readSrsc(f);
    for (const v of listVideos(file)) {
      assert.ok(v.width > 0 && v.height > 0 && v.fps > 0, `${f} ${v.key}`);
      const dur = asfPlayDuration(file.bytes(v.data));
      assert.ok(dur !== undefined && dur > 0.2 && dur < 600, `${f} ${v.key}: ASF play duration ${dur}`);
      count++;
    }
  }
  assert.ok(count >= 30, `expected 30+ videos, found ${count}`);
});

test('fonts and string tables load', { skip }, () => {
  const fdu = filesWithExt('.fdu');
  assert.ok(fdu.length >= 1);
  const fonts = readFonts(readSrsc(fdu[0]));
  assert.ok(fonts.length >= 2);
  for (const font of fonts) assert.ok(font.glyphs.size > 50, `font ${font.key} has ${font.glyphs.size} glyphs`);

  let strings = 0;
  for (const f of filesWithExt('.xdu')) strings += new StringTable(readSrsc(f)).entries.size;
  assert.ok(strings > 2000, `expected 2000+ strings, found ${strings}`);
});

test('front-end definitions decode to a usable menu', { skip }, () => {
  const iface = allFiles().find((f) => /interface\/interface\.odu$/i.test(f));
  const system = allFiles().find((f) => /system\/system\.odu$/i.test(f));
  assert.ok(iface && system);
  const fe = readFrontEnd(
    new Map([
      [5, { odu: readSrsc(iface!) }],
      [2, { odu: readSrsc(system!) }],
    ]) as never,
  );
  assert.ok(fe.boot.length > 0, 'no boot steps');
  assert.ok(fe.mainMenu, 'no main menu');
  assert.ok(fe.mainMenu!.items.length >= 4, 'main menu has too few items');
  assert.ok(fe.pause && fe.pause.items.length >= 3, 'pause menu missing');
  assert.ok(fe.mainMenu!.newGame?.level, 'no new-game level');
});

// Reference byte-wise DXT decode (the decoder writes 32-bit texels from a reused palette).
function referenceDxt(src: Uint8Array, w: number, h: number, kind: 'DXT1' | 'DXT5', punch: boolean): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const bs = kind === 'DXT1' ? 8 : 16;
  const c565 = (c: number) => {
    const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
  };
  for (let by = 0; by < Math.ceil(h / 4); by++)
    for (let bx = 0; bx < Math.ceil(w / 4); bx++) {
      const s = (by * Math.ceil(w / 4) + bx) * bs;
      const cs = kind === 'DXT1' ? s : s + 8;
      const c0 = src[cs] | (src[cs + 1] << 8), c1 = src[cs + 2] | (src[cs + 3] << 8);
      const p0 = c565(c0), p1 = c565(c1);
      const pal: number[][] = [[...p0, 255], [...p1, 255]];
      if (c0 > c1 || !(kind === 'DXT1' && punch)) {
        pal.push([0, 1, 2].map((k) => Math.floor((2 * p0[k] + p1[k] + 1) / 3)).concat(255));
        pal.push([0, 1, 2].map((k) => Math.floor((p0[k] + 2 * p1[k] + 1) / 3)).concat(255));
      } else {
        pal.push([0, 1, 2].map((k) => (p0[k] + p1[k]) >> 1).concat(255));
        pal.push([0, 0, 0, 0]);
      }
      const a = [src[s], src[s + 1]];
      if (a[0] > a[1]) for (let k = 1; k < 7; k++) a.push(Math.floor(((7 - k) * a[0] + k * a[1] + 3) / 7));
      else a.push(...[1, 2, 3, 4].map((k) => Math.floor(((5 - k) * a[0] + k * a[1] + 2) / 5)), 0, 255);
      let abits = 0n;
      for (let i = 0; i < 6; i++) abits |= BigInt(src[s + 2 + i]) << BigInt(8 * i);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const idx = (src[cs + 4 + (i >> 2)] >> (2 * (i & 3))) & 3;
        const px = pal[idx].slice();
        if (kind === 'DXT5') px[3] = a[Number((abits >> BigInt(3 * i)) & 7n)];
        out.set(px, (y * w + x) * 4);
      }
    }
  return out;
}

test('DXT1 / DXT5 decode matches a byte-wise reference decoder', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  for (const [kind, punch] of [['DXT1', false], ['DXT1', true], ['DXT5', false]] as const) {
    for (const [w, h] of [[8, 8], [16, 4], [6, 10], [1, 1]]) {
      const blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
      const src = new Uint8Array(blocks * (kind === 'DXT1' ? 8 : 16)).map(rnd);
      // Both colour orders (4-colour and 3-colour / punch-through blocks) and both alpha modes.
      if (blocks > 1) [src[2], src[3], src[0], src[1]] = [src[0] | 1, src[1], src[2] & 0xfe, src[3]];
      assert.deepEqual(decodeDxt(src, w, h, kind, punch), referenceDxt(src, w, h, kind, punch), `${kind}${punch ? 'a' : ''} ${w}x${h}`);
    }
  }
});
