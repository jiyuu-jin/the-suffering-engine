// Save storage robustness (src/game/save/store.ts), save files on the player's disk
// (src/game/save/transfer.ts: the .json bundle, original .rsg import), the original profile's
// export (save-original.ts portSettingsToOriginal / readDefaultBindings, formats/pe.ts) and the
// save fixes found by the save matrix (tools/save-matrix.mjs; docs/playthrough.md "Save
// matrix"): the inventory restored without the weapons' pickup rules, game-scope providers a
// save lacks reset, the creature form kept. Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, skip } from './helpers';
import { LocalStorageStore, MemoryStore, storeErrorOf } from '../src/game/save/store';
import { SAVE_VERSION, migrateSave, stableJson, type SaveData } from '../src/game/save/types';
import { BUNDLE_FORMAT, bundleFileName, decodeOriginalThumbnail, makeBundle, originalSaveTime, originalSaveToPort, parseBundle, planImport } from '../src/game/save/transfer';
import { SaveRegistry } from '../src/game/save/registry';
import { SaveManager } from '../src/game/save/manager';
import { inventorySaveProvider, worldSaveProvider } from '../src/game/save/providers';
import { createInventory, type InventoryItem } from '../src/game/world/inventory';
import {
  CHUNK_BODY,
  CHUNK_HEADER,
  EngineWriter,
  SettingsFlag,
  defaultOriginalSettings,
  originalSettingsToPort,
  parseOriginalSave,
  parseOriginalSettings,
  portSettingsToOriginal,
  readDefaultBindings,
  RFL_DEFAULT_BINDINGS,
  writeChunks,
  writeOriginalSettings,
  writeSaveHeaderPayload,
} from '../src/formats/save-original';
import { peOffset, readPe } from '../src/formats/pe';
import { InsanityModel } from '../src/game/insanity/rules';

const save = (id: string, extra: Partial<SaveData> = {}): SaveData => ({
  version: SAVE_VERSION,
  id,
  kind: 'manual',
  createdAt: 1000,
  playtime: 12,
  difficulty: 1,
  levelPath: 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl',
  title: 'Death Row',
  levelName: '1a PrisonDeathRow',
  game: { inventory: { items: [{ name: 'Shiv', count: 1 }], health: 80, maxHealth: 100 } },
  levels: { 'levels/1 prisondeathrow/1a prisondeathrow.lvl': { world: { rt: { time: 3 }, ents: {} } } },
  ...extra,
});

/** A Storage with a byte quota (UTF-16: 2 bytes a character, keys included), like a browser's. */
class FakeStorage implements Storage {
  private m = new Map<string, string>();
  constructor(private quota = Infinity, private broken = false) {}
  get length() {
    if (this.broken) throw new DOMException('blocked', 'SecurityError');
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    if (this.broken) throw new DOMException('blocked', 'SecurityError');
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.broken) throw new DOMException('blocked', 'SecurityError');
    const used = [...this.m].reduce((n, [a, b]) => (a === k ? n : n + (a.length + b.length) * 2), 0);
    if (used + (k.length + v.length) * 2 > this.quota) throw new DOMException('full', 'QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

test('store: localStorage round trip, newest first, damaged entries listed and deletable', async () => {
  const ls = new FakeStorage();
  const st = new LocalStorageStore(ls);
  assert.equal(await st.put(save('a', { createdAt: 1 })), true);
  assert.equal(await st.put(save('b', { createdAt: 2 })), true);
  ls.setItem('suffering.save.bad', '{not json');
  ls.setItem('suffering.save.future', JSON.stringify(save('future', { version: SAVE_VERSION + 1 })));
  ls.setItem('suffering.settings.v1', '{}'); // other keys are not saves
  const list = await st.list();
  assert.deepEqual(list.map((s) => s.id), ['b', 'a', 'bad', 'future']);
  assert.equal(list.find((s) => s.id === 'bad')?.damaged, true);
  assert.equal(list.find((s) => s.id === 'future')?.damaged, true, 'a newer version is refused, not misread');
  assert.equal(await st.get('bad'), null);
  assert.equal(stableJson(await st.get('a')), stableJson(save('a', { createdAt: 1 })));
  assert.equal(await st.delete('bad'), true);
  assert.ok(!(await st.list()).some((s) => s.id === 'bad'));
});

test('store: quota exceeded is reported (lastError "quota"), the store keeps working after', async () => {
  const big = save('big', { thumbnail: `data:image/jpeg;base64,${'A'.repeat(4000)}` });
  const ls = new FakeStorage(JSON.stringify(big).length * 2 + 200);
  const st = new LocalStorageStore(ls);
  assert.equal(await st.put(big), true);
  assert.equal(await st.put(save('second', { thumbnail: big.thumbnail })), false);
  assert.equal(st.lastError, 'quota');
  assert.equal(await st.delete('big'), true);
  assert.equal(await st.put(save('second')), true);
  assert.equal(st.lastError, undefined);
  assert.equal(storeErrorOf({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), 'quota');
  assert.equal(storeErrorOf({ code: 22 }), 'quota');
  assert.equal(storeErrorOf(new DOMException('x', 'SecurityError')), 'unavailable');
  assert.equal(storeErrorOf(new Error('x')), 'failed');
});

test('store: blocked storage (every access throws) never throws out of the store', async () => {
  const st = new LocalStorageStore(new FakeStorage(Infinity, true));
  assert.deepEqual(await st.list(), []);
  assert.equal(await st.get('a'), null);
  assert.equal(await st.put(save('a')), false);
  assert.equal(st.lastError, 'unavailable');
});

test('store: memory store lists damaged entries like the others', async () => {
  const st = new MemoryStore();
  await st.put(save('x'));
  (st as unknown as { map: Map<string, string> }).map.set('junk', 'nope');
  const list = await st.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((s) => s.id === 'junk')?.damaged, true);
});

test('migrateSave: old records fill defaults, the rsg import marker survives, junk does not', () => {
  const m = migrateSave({ version: 1, id: 'old', levelPath: 'LEVELS/x/2 Cellblocks.lvl' })!;
  assert.equal(m.kind, 'manual');
  assert.equal(m.title, '2 Cellblocks');
  assert.deepEqual(m.game, {});
  assert.equal(m.difficulty, 1);
  const imp = migrateSave({ ...save('r'), imported: { from: 'rsg', slot: 2, chapterId: 7, originalPath: 'x' } })!;
  assert.equal(imp.imported?.slot, 2);
  assert.equal(migrateSave({ ...save('r'), imported: { from: 'evil' } })!.imported, undefined);
  assert.equal(migrateSave({ ...save('r'), thumbnail: 'javascript:alert(1)' })!.thumbnail, undefined);
  assert.equal(migrateSave('x'), null);
  assert.equal(migrateSave({ ...save('r'), version: undefined }), null);
});

test('bundle: export / import round trip; single saves and arrays are accepted', () => {
  const b = makeBundle([save('a'), save('b')], 5);
  assert.equal(b.format, BUNDLE_FORMAT);
  const back = parseBundle(JSON.stringify(b));
  assert.equal(back.rejected, 0);
  assert.equal(stableJson(back.saves), stableJson([save('a'), save('b')]));
  assert.equal(parseBundle(JSON.stringify(save('one'))).saves.length, 1);
  assert.equal(parseBundle(JSON.stringify([save('x'), { junk: 1 }])).rejected, 1);
  assert.equal(parseBundle('not json').error, 'not JSON');
  assert.ok(parseBundle(JSON.stringify({ format: 'other-game', saves: [save('a')] })).error);
  assert.match(bundleFileName([save('a', { createdAt: Date.UTC(2026, 9, 24, 13, 5) })]), /^suffering-save-1a_PrisonDeathRow-202610241305\.json$/);
  assert.match(bundleFileName([save('a'), save('b')], Date.UTC(2026, 0, 2)), /^suffering-saves-20260102/);
});

test('import plan: identical saves skipped, taken ids renamed, the autosave slot comes in as a manual save', () => {
  const existing = new Map<string, SaveData | null>([
    ['a', save('a')],
    ['b', save('b')],
    ['autosave', save('autosave', { kind: 'auto' })],
  ]);
  let n = 0;
  const plan = planImport([save('a'), save('b', { playtime: 99 }), save('autosave', { kind: 'auto', playtime: 5 }), save('c')], existing, () => (n++ * 0.1) % 1);
  assert.equal(plan.skipped, 1);
  const ids = plan.put.map((s) => s.id);
  assert.equal(ids.length, 3);
  assert.ok(ids[0].startsWith('b-i'), 'another save under a taken id is renamed');
  assert.ok(ids[1].startsWith('save-i') && plan.put[1].kind === 'manual', 'never over the autosave slot');
  assert.equal(ids[2], 'c');
  assert.equal(new Set(ids).size, ids.length);
});

// --- Original saves

function rsg(opts: { path: string; name: string; slot?: number; thumb?: { w: number; h: number; bpp: number } }): Uint8Array {
  const t = opts.thumb;
  const data = t ? new Uint8Array(t.w * t.h * t.bpp).map((_, i) => (i * 7) & 0xff) : undefined;
  const header = writeSaveHeaderPayload({ flag: 1, slot: opts.slot ?? 3, chapterId: 0x1234, levelPath: opts.path, name: opts.name, thumbnail: t && data ? { width: t.w, height: t.h, format: 21, data } : undefined });
  const body = new EngineWriter().u32(2).u32(10).u32(11).u32(500).u32(9).u32(77).f32(1.5).u32(0xdead).finish();
  return writeChunks([
    { tag: CHUNK_HEADER, id: 0, data: header },
    { tag: CHUNK_BODY, id: 0, data: body },
  ]);
}

test('original save -> a port save of its level start: name, time from the folder, slot, thumbnail', () => {
  const o = parseOriginalSave(rsg({ path: 'Levels\\2 Cellblocks\\2 Cellblocks.lvl', name: 'Chapter Two', thumb: { w: 4, h: 2, bpp: 4 } }));
  // Folder = hex of time(NULL) + 1.
  const folder = (1_100_000_000 + 1).toString(16);
  assert.equal(originalSaveTime(folder), 1_100_000_000_000);
  assert.equal(originalSaveTime('zz'), undefined);
  assert.equal(originalSaveTime('1'), undefined, 'implausible times are not used');
  const d = originalSaveToPort(o, { levelPath: 'LEVELS/2 Cellblocks/2 Cellblocks.lvl', folder, difficulty: 2 })!;
  assert.equal(d.id, `rsg-${folder}`);
  assert.equal(d.title, 'Chapter Two');
  assert.equal(d.levelName, '2 Cellblocks');
  assert.equal(d.createdAt, 1_100_000_000_000);
  assert.equal(d.difficulty, 2);
  assert.deepEqual(d.game, {});
  assert.deepEqual(d.levels, {});
  assert.deepEqual(d.imported, { from: 'rsg', slot: 3, chapterId: 0x1234, originalPath: 'Levels\\2 Cellblocks\\2 Cellblocks.lvl', objects: 500 });
  assert.ok(migrateSave(JSON.parse(JSON.stringify(d))), 'stores like any save');
  assert.equal(originalSaveToPort(o, { levelPath: undefined, difficulty: 1 }), null, 'unknown level: not imported');
  // Thumbnail: 4 bytes a pixel read B, G, R, A; 2 bytes R5G6B5.
  const px = decodeOriginalThumbnail(o.header.thumbnail!)!;
  assert.equal(px.width, 4);
  const raw = o.header.thumbnail!.data;
  assert.deepEqual([...px.rgba.slice(0, 4)], [raw[2], raw[1], raw[0], 255]);
  const t16 = decodeOriginalThumbnail({ width: 1, height: 1, format: 0, data: new Uint8Array([0x00, 0xf8]) })!;
  assert.deepEqual([...t16.rgba], [255, 0, 0, 255]);
  assert.equal(decodeOriginalThumbnail({ width: 3, height: 3, format: 0, data: new Uint8Array(5) }), null);
});

test('original profile export: port options over the imported file, bindings and unknown fields kept', () => {
  const base = { ...defaultOriginalSettings(), unknown4: 9, flags: defaultOriginalSettings().flags | SettingsFlag.Bit6 | SettingsFlag.Loaded, bindings: [{ action: 0x3ea, device: 0, code: 1, lo: -1, hi: 1 }], archives: [0b101, 1] as [number, number] };
  const port = { ...originalSettingsToPort(base), sfx: 0.25, subtitles: true, invertY: true, extra: { checkpoints: 0, helpText: false, environmentFx: 1, vibration: false }, gameFinished: true, archivePages: [[1, 4]] as [number, number][] };
  const out = portSettingsToOriginal(port, base);
  assert.equal(out.effectsVolume, 0.25);
  assert.equal(out.checkpoints, 0);
  assert.equal(out.unknown4, 9);
  assert.ok(out.flags & SettingsFlag.Subtitles && out.flags & SettingsFlag.InvertPitch && out.flags & SettingsFlag.GameFinished && out.flags & SettingsFlag.Bit6);
  assert.ok(!(out.flags & SettingsFlag.HelpText) && !(out.flags & SettingsFlag.Vibration) && !(out.flags & SettingsFlag.EnvironmentFx));
  assert.ok(!(out.flags & SettingsFlag.Loaded), 'the reader sets "loaded", the file does not carry it');
  assert.deepEqual(out.archives, [0b101, 1 | (1 << 4)]);
  assert.deepEqual(out.bindings, base.bindings);
  // Written and read back as the original reads it (trailer present).
  const back = parseOriginalSettings(writeOriginalSettings(out));
  assert.equal(back.valid, true);
  assert.equal(back.flags, out.flags);
  assert.deepEqual(back.bindings, out.bindings);
});

test('RFL default bindings: 20-byte records up to action -1, found through the PE section table', () => {
  // A minimal PE32: MZ, PE header, one .data section at RVA 0x1000 / file 0x200.
  const file = new Uint8Array(0x200 + 0x100);
  const v = new DataView(file.buffer);
  v.setUint16(0, 0x5a4d, true);
  v.setUint32(0x3c, 0x40, true);
  v.setUint32(0x40, 0x4550, true);
  v.setUint16(0x46, 1, true); // sections
  v.setUint16(0x54, 0xe0, true); // optional header size
  v.setUint16(0x58, 0x10b, true);
  v.setUint32(0x58 + 28, 0x10000000, true); // image base
  const sec = 0x58 + 0xe0;
  file.set([0x2e, 0x64, 0x61, 0x74, 0x61], sec);
  v.setUint32(sec + 8, 0x100, true);
  v.setUint32(sec + 12, 0x1000, true);
  v.setUint32(sec + 16, 0x100, true);
  v.setUint32(sec + 20, 0x200, true);
  const img = readPe(file);
  assert.equal(img.sections[0].name, '.data');
  const off = peOffset(img, 0x10001010);
  assert.equal(off, 0x210);
  assert.equal(peOffset(img, 0x10005000), -1);
  const rec = (o: number, a: number, code: number) => {
    v.setUint32(o, a, true);
    v.setUint32(o + 4, 0, true);
    v.setUint32(o + 8, code, true);
    v.setFloat32(o + 12, -1, true);
    v.setFloat32(o + 16, 1, true);
  };
  rec(off, 0x3ea, 1);
  rec(off + 20, 0x3ff, 0x22);
  v.setUint32(off + 40, 0xffffffff, true);
  assert.deepEqual(readDefaultBindings(file, off), [
    { action: 0x3ea, device: 0, code: 1, lo: -1, hi: 1 },
    { action: 0x3ff, device: 0, code: 0x22, lo: -1, hi: 1 },
  ]);
  assert.throws(() => readPe(new Uint8Array(64)));
});

// --- Fixes found by the save matrix

test('inventory load bypasses the systems hooked onto add (a gun is not picked up again)', () => {
  const items = new Map<string, InventoryItem>();
  const inv = createInventory(items);
  const raw = createInventory(items);
  // The weapons system wraps add: a gun added there is a pickup with its start ammo.
  const add = inv.add.bind(inv);
  inv.add = (name, count, template, cls) => {
    add(name, count, template, cls);
    if (template?.id === 84) add('Shotgun Ammo', 14, { pkg: 4, id: 231 });
  };
  const p = inventorySaveProvider(inv, () => items.clear(), undefined, (i) => raw.add(i.name, i.count, i.template, i.className));
  inv.add('Shotgun', 1, { pkg: 4, id: 84 });
  const s = JSON.parse(JSON.stringify(p.save()));
  p.load(s, { reason: 'load', levelPath: 'x', version: 1 });
  assert.equal(inv.count({ pkg: 4, id: 231 }), 14, 'the saved 14 shells, not 28');
  p.load(s, { reason: 'transition', levelPath: 'y', version: 1 });
  assert.equal(inv.count({ pkg: 4, id: 231 }), 14);
});

test('a loaded save resets the game-scope providers it has no entry for (imported original saves)', () => {
  const r = new SaveRegistry();
  const calls: string[] = [];
  r.register('inventory', { save: () => 1, load: () => calls.push('load inventory'), reset: () => calls.push('reset inventory') }, { scope: 'game' });
  r.register('weapons', { save: () => 2, load: () => calls.push('load weapons'), reset: () => calls.push('reset weapons') }, { scope: 'game' });
  const m = new SaveManager();
  m.bindLevel(r, 'L/a.lvl');
  m.levelReady({ kind: 'load', data: save('x', { game: { inventory: {} }, levels: {} }) });
  assert.deepEqual(calls, ['reset weapons', 'load inventory']);
});

test('creature form: restoreCreature transforms at once (no morph wait), from human or mid-morph', () => {
  const human = { morph: { duration: 2.8 }, meterMax: 100 } as never;
  const forms: string[] = [];
  const m = new InsanityModel({ human, creature: { morph: { duration: 1 } } } as never, undefined, { form: (f) => forms.push(f) });
  m.restoreCreature();
  assert.equal(m.form, 'creature');
  assert.deepEqual(forms, ['morphIn', 'creature']);
  assert.equal(m.morphLeft, 0);
  m.restoreCreature();
  assert.deepEqual(forms, ['morphIn', 'creature'], 'already transformed: nothing');
  const n = new InsanityModel({ human } as never);
  n.restoreCreature();
  assert.equal(n.form, 'human', 'no creature form in the data: stays human');
});

test("the user's Suffering.rfl: its default table has the keyboard / mouse bindings, Pause on Esc first", { skip: skip || (!existsSync(join(DATA_ROOT, 'Suffering.rfl')) && 'no Suffering.rfl') }, () => {
  const rfl = new Uint8Array(readFileSync(join(DATA_ROOT, 'Suffering.rfl')));
  const off = peOffset(readPe(rfl), RFL_DEFAULT_BINDINGS);
  assert.ok(off > 0);
  const b = readDefaultBindings(rfl, off);
  assert.ok(b.length > 50 && b.length < 512, `${b.length} bindings`);
  assert.deepEqual(b[0], { action: 0x3ea, device: 0, code: 1, lo: -1, hi: 1 });
  assert.ok(b.every((x) => x.action >= 0x3e8 && x.action < 0x500));
});

test('world provider: an object destroyed while shown comes back destroyed with its shown flag', () => {
  const ent = { uid: 1, e: { family: 'PhysicalObject' }, cls: 'Animating Static', s: {} as Record<string, unknown>, enabled: true, visible: false, destroyed: false };
  const calls: string[] = [];
  const world = {
    ents: new Map([[1, ent]]),
    hooks: { destroyed: () => calls.push('destroyed'), setVisible: (_u: number, v: boolean) => calls.push(`show ${v}`), switchPose: () => {}, setTransform: () => {} },
    // World.setVisible refuses to show a destroyed object (logic.ts).
    setVisible(_u: number, v: boolean) {
      if (ent.destroyed && v) return;
      ent.visible = v;
    },
    saveRuntime: () => ({ time: 0, stomps: [], sounds: [], scheduled: 0 }),
    loadRuntime: () => {},
  };
  const p = worldSaveProvider(world as never);
  ent.visible = true;
  ent.destroyed = true;
  const s = JSON.parse(JSON.stringify(p.save()));
  ent.visible = false;
  ent.destroyed = false;
  p.load(s, { reason: 'load', levelPath: 'x', version: 1 });
  assert.equal(ent.destroyed, true);
  assert.equal(ent.visible, true, 'the flag as saved (save matrix 1a: Animating Static 7bf3)');
  assert.deepEqual(calls, ['destroyed']);
});

test('glow precompile: hidden objects whose meshes share a parent are hidden again after it (fresh-load Fire models)', async () => {
  const THREE = await import('three');
  const { showWithParents } = await import('../src/app/scene-glow');
  const scene = new THREE.Group();
  const fire = new THREE.Group();
  fire.visible = false;
  const a = new THREE.Mesh(), b = new THREE.Mesh();
  b.visible = false;
  fire.add(a, b);
  scene.add(fire);
  const restore = showWithParents([a, b]);
  assert.ok(fire.visible && a.visible && b.visible);
  restore();
  assert.equal(fire.visible, false, 'the shared parent comes back hidden');
  assert.equal(b.visible, false);
  assert.equal(a.visible, true);
  assert.equal(scene.visible, true);
});
