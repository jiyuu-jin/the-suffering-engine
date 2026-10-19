// Converted media (`npm run bake` -> game/converted): every sound and video of
// the install must have a converted file whose duration matches the original
// (sounds +-50 ms, video pictures +-1 frame), and cutscene soundtracks must be
// paired as verified. Skips when the install or the converted folder is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DATA_ROOT, filesWithExt, hasData, readSrsc } from './helpers';
import { readDbId } from '../src/formats/model';
import { indexSounds } from '../src/formats/sound';
import { asfPlayDuration, listVideos } from '../src/formats/video';
import { MANIFEST_FILE, isManifest, type ConvertedManifest } from '../src/formats/converted';
import { readMp4 } from '../tools/mp4';

const ROOT = resolve(process.env.SUFFERING_CONVERTED ?? join(dirname(DATA_ROOT), 'converted'));
const hasConverted = hasData && existsSync(join(ROOT, MANIFEST_FILE));
const skip = hasConverted ? false : `no converted media at ${ROOT} (run npm run bake)`;

let manifest: ConvertedManifest | undefined;
const getManifest = () => {
  if (!manifest) {
    const m: unknown = JSON.parse(readFileSync(join(ROOT, MANIFEST_FILE), 'utf8'));
    assert.ok(isManifest(m), 'manifest version');
    manifest = m;
  }
  return manifest;
};

const pkgOf = (container: string) => {
  const db = container.replace(/\.[^./]+$/, '.db');
  const real = filesWithExt('.db').find((f) => f.toLowerCase() === db.toLowerCase());
  return real ? readDbId(readFileSync(join(DATA_ROOT, real), 'latin1')) : undefined;
};

test('every sound has a converted file with matching duration', { skip }, () => {
  const m = getManifest();
  let count = 0;
  for (const f of filesWithExt('.sdu')) {
    const pkg = pkgOf(f);
    assert.ok(pkg !== undefined, `${f}: package id`);
    for (const s of indexSounds(readSrsc(f), pkg)) {
      const e = m.sounds[s.key];
      assert.ok(e, `${s.key} (${f}) missing from manifest`);
      const abs = join(ROOT, e.file);
      assert.ok(existsSync(abs), `${s.key}: ${e.file} missing`);
      assert.equal(statSync(abs).size, e.bytes, `${s.key}: size`);
      const t = readMp4(readFileSync(abs)).tracks.find((x) => x.handler === 'soun');
      assert.ok(t, `${s.key}: no audio track`);
      assert.ok(Math.abs(t.duration - s.duration) <= 0.05, `${s.key}: ${t.duration.toFixed(3)} s vs ${s.duration.toFixed(3)} s`);
      assert.ok(Math.abs(e.duration - s.duration) <= 0.05, `${s.key}: manifest duration`);
      assert.equal(e.channels, s.channels, `${s.key}: channels`);
      count++;
    }
  }
  assert.ok(count > 3000, `expected 3000+ sounds, found ${count}`);
});

test('every video has a converted file with matching picture duration', { skip }, () => {
  const m = getManifest();
  let count = 0;
  for (const f of filesWithExt('.vdu')) {
    const file = readSrsc(f);
    for (const v of listVideos(file, pkgOf(f))) {
      const e = m.videos[v.key];
      assert.ok(e, `${v.key} (${f}) missing from manifest`);
      const abs = join(ROOT, e.file);
      assert.ok(existsSync(abs), `${v.key}: ${e.file} missing`);
      const mp4 = readMp4(readFileSync(abs));
      const vt = mp4.tracks.find((x) => x.handler === 'vide');
      assert.ok(vt, `${v.key}: no video track`);
      const asf = asfPlayDuration(file.bytes(v.data))!;
      assert.ok(Math.abs(vt.duration - asf) <= 1 / v.fps + 1e-3, `${v.key}: ${vt.duration.toFixed(3)} s vs ASF ${asf.toFixed(3)} s`);
      assert.ok(Math.abs(e.duration - asf) <= 1 / v.fps + 1e-3, `${v.key}: manifest duration`);
      const at = mp4.tracks.find((x) => x.handler === 'soun');
      if (e.soundtrackMode === 'sync') {
        const snd = m.sounds[e.soundtrack!];
        assert.ok(at && snd, `${v.key}: muxed soundtrack missing`);
        assert.ok(Math.abs(at.duration - snd.duration) <= 0.05, `${v.key}: soundtrack ${at.duration} s vs ${snd.duration} s`);
      } else assert.ok(!at, `${v.key}: unexpected audio track`);
      count++;
    }
  }
  assert.equal(count, 35);
});

test('cutscene soundtracks are paired as verified', { skip }, () => {
  const m = getManifest();
  const expected: Record<string, string> = {
    '5:30': '5:73', '5:31': '5:74', '5:16': '5:24',
    '34:1': '34:60', '34:2': '34:61', '34:3': '34:62', '34:4': '34:59', '34:5': '34:80',
    '12:2': '12:355', '12:4': '12:489', '12:5': '12:490', '17:1': '17:301', '17:2': '17:302',
    '28:1': '28:122', '28:2': '28:123', '40:1': '40:200', '39:1': '39:216',
  };
  for (const [key, e] of Object.entries(m.videos)) {
    if (key === '5:32') {
      assert.equal(e.soundtrackMode, 'bed', '5:32 music bed');
      assert.equal(e.soundtrack, '5:72');
    } else if (expected[key]) {
      assert.equal(e.soundtrackMode, 'sync', key);
      assert.equal(e.soundtrack, expected[key], key);
    } else assert.equal(e.soundtrack, undefined, `${key} should be silent`);
  }
});
