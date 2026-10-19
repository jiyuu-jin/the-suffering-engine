// Original save files (src/formats/save-original.ts) and the original save rules
// (src/game/save/rules.ts) on synthetic data only: no original save is shipped with the game.
// Audio / player RE constants have their own tests (re-audio.test.ts, re-player.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  CHUNK_BODY,
  CHUNK_HEADER,
  EngineReader,
  EngineWriter,
  RSG_VERSION,
  SETTINGS_TRAILER,
  SettingsFlag,
  archivePages,
  defaultOriginalSettings,
  nextSlotNumber,
  originalSettingsToPort,
  parseOriginalSave,
  parseOriginalSettings,
  parseOriginalSettingsPayload,
  parseSaveBodyPrefix,
  readChunks,
  saveFolderName,
  speakerSetup,
  writeChunks,
  writeOriginalSettings,
  writeSaveHeaderPayload,
  zlibStore,
} from '../src/formats/save-original';
import { inflateZlib } from '../src/formats/inflate';
import { SrscFile } from '../src/formats/srsc';
import { autosaveAction, originalSaveVeto, CHECKPOINT_MIN_HEALTH } from '../src/game/save/rules';

test('engine stream: strings are u16 length + bytes, wide strings carry their terminator', () => {
  const w = new EngineWriter().string('LEVELS/1a.lvl').wstring('Death Row').u32(7).f32(0.5).u16(3).u8(9);
  const b = w.finish();
  // 2 + 13, then 2 + (9 + 1) * 2
  assert.equal(b[0] | (b[1] << 8), 13);
  assert.equal(b[15] | (b[16] << 8), 20);
  assert.equal(b[17 + 18] | (b[17 + 19] << 8), 0, 'UTF-16 NUL inside the length');
  const r = new EngineReader(b);
  assert.equal(r.string(), 'LEVELS/1a.lvl');
  assert.equal(r.wstring(), 'Death Row');
  assert.equal(r.u32(), 7);
  assert.equal(r.f32(), 0.5);
  assert.equal(r.u16(), 3);
  assert.equal(r.u8(), 9);
  assert.equal(r.remaining, 0);
  assert.throws(() => r.u8());
});

test('zlibStore: stored blocks inflate back, also past 64 KiB', () => {
  for (const n of [0, 1, 1000, 0xffff, 0x10000 + 123]) {
    const src = new Uint8Array(n).map((_, i) => (i * 31) & 0xff);
    assert.deepEqual(inflateZlib(zlibStore(src)), src);
  }
});

test('chunks: SRSC directory tag = type | group << 8, payloads 8-byte aligned', () => {
  const file = writeChunks([
    { tag: CHUNK_HEADER, id: 0, data: new Uint8Array([1, 2, 3]) },
    { tag: CHUNK_BODY, id: 0, data: new Uint8Array([4, 5]) },
  ]);
  const srsc = new SrscFile(file.slice().buffer);
  assert.equal(srsc.version, 0x0101);
  assert.deepEqual(srsc.entries.map((e) => [e.type, e.group, e.offset % 8]), [[0, 0, 0], [1, 4, 0]]);
  const chunks = readChunks(file);
  assert.deepEqual(chunks.map((c) => [c.tag, [...c.data]]), [[0, [1, 2, 3]], [0x401, [4, 5]]]);
});

test('chunks: real deflate payloads (as the engine writes them) are read', () => {
  const payload = new EngineWriter().u32(42).string('x'.repeat(500)).finish();
  const z = new Uint8Array(deflateSync(payload));
  // Hand-made SRSC with one compressed entry.
  const out = new Uint8Array(16 + z.length + 14);
  const v = new DataView(out.buffer);
  out.set([0x53, 0x52, 0x53, 0x43]);
  v.setUint16(4, 0x101, true);
  v.setUint32(6, 16 + z.length, true);
  v.setUint16(10, 1, true);
  out.set(z, 16);
  const d = 16 + z.length;
  v.setUint8(d, 0x01);
  v.setUint8(d + 1, 0x04);
  v.setUint32(d + 6, 16, true);
  v.setUint32(d + 10, z.length, true);
  const [c] = readChunks(out);
  assert.equal(c.tag, CHUNK_BODY);
  const r = new EngineReader(c.data);
  assert.equal(r.u32(), 42);
  assert.equal(r.string().length, 500);
});

test('Unspeakable.cfg: field order, key table and the 0x600D trailer', () => {
  // Hand-built payload in the order of the reader at RFL 0x100077f0.
  const w = new EngineWriter()
    .u32(0).u32(0).u32(0)
    .f32(0.25).f32(0.5).f32(0.75) // effects, dialog, music
    .f32(1.5).f32(0.5) // turn, pitch
    .u32(1) // checkpoints: Prompt
    .u32(0b1011).u32(1) // archive sets
    .u32(SettingsFlag.InvertPitch | SettingsFlag.Subtitles | SettingsFlag.EnvironmentFx | SettingsFlag.GameFinished | SettingsFlag.SpeakerStereo)
    .u32(2)
    .u32(0x3ea).u32(0).u32(1).f32(-1).f32(1) // Pause = Esc
    .u32(0x3ff).u32(0).u32(0x22).f32(-1).f32(1) // Map = G
    .u32(SETTINGS_TRAILER);
  const s = parseOriginalSettingsPayload(w.finish());
  assert.equal(s.valid, true);
  assert.equal(s.dialogVolume, 0.5);
  assert.equal(s.checkpoints, 1);
  assert.deepEqual(archivePages(s, 0), [0, 1, 3]);
  assert.deepEqual(s.bindings[1], { action: 0x3ff, device: 0, code: 0x22, lo: -1, hi: 1 });
  assert.equal(speakerSetup(s.flags), 'stereo');
  const port = originalSettingsToPort(s);
  assert.equal(port.sfx, 0.25);
  assert.equal(port.music, 0.75);
  assert.equal(port.invertY, true);
  assert.equal(port.subtitles, true);
  assert.equal(port.gameFinished, true);
  assert.equal(port.extra.environmentFx, 0);
  assert.equal(port.extra.helpText, false);
  assert.deepEqual(port.archivePages, [[0, 0], [0, 1], [0, 3], [1, 0]]);

  // Without the trailer the game falls back to its defaults.
  const bytes = w.finish();
  assert.equal(parseOriginalSettingsPayload(bytes.subarray(0, bytes.length - 4)).valid, false);
});

test('Unspeakable.cfg: write / read round trip and defaults', () => {
  const d = defaultOriginalSettings();
  assert.equal(d.checkpoints, 2);
  assert.equal(speakerSetup(d.flags), 'surround');
  assert.ok(d.flags & SettingsFlag.HelpText && d.flags & SettingsFlag.Vibration && d.flags & SettingsFlag.EnvironmentFx);
  assert.ok(!(d.flags & SettingsFlag.Subtitles));
  d.bindings = [{ action: 0x42d, device: 0, code: 0x2e, lo: -1, hi: 1 }];
  d.musicVolume = 0.3;
  const back = parseOriginalSettings(writeOriginalSettings(d));
  assert.equal(back.valid, true);
  assert.equal(Math.round(back.musicVolume * 100), 30);
  assert.deepEqual(back.bindings, d.bindings);
  assert.deepEqual(back.archives, d.archives);
});

test('.rsg: header (version 2, slot, chapter, level, name, thumbnail) and body prefix', () => {
  const thumb = { width: 4, height: 2, format: 22, data: new Uint8Array(4 * 2 * 4).fill(7) };
  const header = writeSaveHeaderPayload({ flag: 1, slot: 3, chapterId: 0x1234, levelPath: 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow', name: 'Death Row', thumbnail: thumb });
  const body = new EngineWriter().u32(2).u32(10).u32(11).u32(5512).u32(9).u32(77).f32(12.5).u32(0xdeadbeef).finish();
  const file = writeChunks([
    { tag: CHUNK_HEADER, id: 0, data: header },
    { tag: CHUNK_BODY, id: 0, data: body },
  ]);
  const s = parseOriginalSave(file);
  assert.equal(s.header.version, RSG_VERSION);
  assert.equal(s.header.slot, 3);
  assert.equal(s.header.chapterId, 0x1234);
  assert.equal(s.header.name, 'Death Row');
  assert.equal(s.header.levelPath, 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow');
  assert.equal(s.header.thumbnail?.width, 4);
  assert.equal(s.header.thumbnail?.data.length, 32);
  assert.deepEqual(s.body?.databases, [10, 11]);
  assert.equal(s.body?.objectCount, 5512);
  assert.equal(s.body?.value3, 12.5);
  assert.equal(s.body?.rest, 28);
  assert.equal(s.bodyBytes?.length, body.length);
  assert.deepEqual(parseSaveBodyPrefix(body), s.body);

  // No thumbnail: a single u32 0.
  const bare = writeSaveHeaderPayload({ flag: 1, slot: 1, chapterId: 0, levelPath: 'a', name: 'Autosave' });
  assert.equal(parseOriginalSave(writeChunks([{ tag: CHUNK_HEADER, id: 0, data: bare }])).header.thumbnail, undefined);

  // Other versions are refused like the engine does.
  const v3 = writeSaveHeaderPayload({ version: 3, flag: 1, slot: 1, chapterId: 0, levelPath: 'a', name: 'b' });
  assert.throws(() => parseOriginalSave(writeChunks([{ tag: CHUNK_HEADER, id: 0, data: v3 }])));
});

test('save folder name and slot number follow the engine', () => {
  assert.equal(saveFolderName(0x5000_0000), '50000001');
  assert.equal(saveFolderName(0x10, new Set(['11', '12'])), '13');
  assert.equal(nextSlotNumber([1, 2, 4]), 3);
  assert.equal(nextSlotNumber([]), 1);
});

test('original can-save rule: no enemy rule, transformed allowed, airborne / morphing / ladder blocked', () => {
  const ok = { alive: true, controlled: false, airborne: false, morphing: false, climbing: false };
  assert.equal(originalSaveVeto(ok), null);
  assert.equal(originalSaveVeto({ ...ok, alive: false }), 'dead');
  assert.equal(originalSaveVeto({ ...ok, controlled: true }), 'cinematic');
  assert.equal(originalSaveVeto({ ...ok, airborne: true }), 'airborne');
  assert.equal(originalSaveVeto({ ...ok, morphing: true }), 'morphing');
  assert.equal(originalSaveVeto({ ...ok, climbing: true }), 'climbing');
});

test('Autosave: checkpoints option / object p1, health >= 5', () => {
  const base = { alive: true, health: 50, option: 2 };
  assert.equal(autosaveAction(base), 'save');
  assert.equal(autosaveAction({ ...base, option: 0 }), 'skip');
  assert.equal(autosaveAction({ ...base, option: 1 }), 'prompt');
  assert.equal(autosaveAction({ ...base, option: 0, objectMode: 2 }), 'save', 'p1 overrides the option');
  assert.equal(autosaveAction({ ...base, health: CHECKPOINT_MIN_HEALTH - 0.1 }), 'skip');
  assert.equal(autosaveAction({ ...base, health: CHECKPOINT_MIN_HEALTH }), 'save');
  assert.equal(autosaveAction({ ...base, alive: false }), 'skip');
  assert.equal(autosaveAction({ ...base, recentlyHurt: true }), 'skip');
});
