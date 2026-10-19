// Save system: codec, registry, store and a full serialization round trip of level 1a's
// logic state (src/game/save). The 1a tests skip without the local game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFS, readSrsc, skip } from './helpers';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World, PICKUP_CLASSES, type WorldHooks } from '../src/game/world/logic';
import { decodeValue, encodeValue, stableJson, migrateSave, SAVE_VERSION, summarize, type SaveData } from '../src/game/save/types';
import { SaveRegistry } from '../src/game/save/registry';
import { MemoryStore } from '../src/game/save/store';
import { SaveManager } from '../src/game/save/manager';
import { inventorySaveProvider, worldSaveProvider, type WorldSaveState } from '../src/game/save/providers';

const LEVEL_1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

test('codec: Set / Map / non-finite numbers survive JSON, class instances are dropped', () => {
  class Handle {
    x = 1;
  }
  const src = { a: 1, s: new Set([1, 2]), m: new Map([['k', { v: Infinity }]]), h: new Handle(), f: () => 1, n: null, arr: [1, 'x', undefined] };
  const enc = JSON.parse(JSON.stringify(encodeValue(src)));
  const dec = decodeValue(enc) as Record<string, unknown>;
  assert.equal(dec.a, 1);
  assert.deepEqual([...(dec.s as Set<number>)], [1, 2]);
  assert.equal(((dec.m as Map<string, { v: number }>).get('k') as { v: number }).v, Infinity);
  assert.equal('h' in dec, false);
  assert.equal('f' in dec, false);
  assert.equal(dec.n, null);
  assert.deepEqual(dec.arr, [1, 'x', null]);
});

test('migrateSave: validates and rejects future versions', () => {
  assert.equal(migrateSave(null), null);
  assert.equal(migrateSave({ version: SAVE_VERSION + 1, id: 'x', levelPath: 'a.lvl' }), null);
  const d = migrateSave({ version: 1, id: 'x', levelPath: 'LEVELS/1 X/1a Foo.lvl', thumbnail: 'javascript:1' })!;
  assert.equal(d.levelName, '1a Foo');
  assert.equal(d.thumbnail, undefined);
  assert.deepEqual(d.game, {});
});

test('registry: scopes, priority order, isolation of failing providers, reset and vetoes', () => {
  const r = new SaveRegistry();
  const order: string[] = [];
  let a = 1;
  r.register('late', { save: () => ({ v: 'late' }), load: () => void order.push('late') }, { priority: 90 });
  r.register('a', { save: () => ({ a }), load: (d: { a: number }) => void ((a = d.a), order.push('a')) }, { priority: 1 });
  r.register('broken', { save: () => { throw new Error('boom'); }, load: () => { throw new Error('boom'); } });
  let resets = 0;
  r.register('inv', { save: () => [1], load: () => void order.push('inv'), reset: () => void resets++ }, { scope: 'game' });
  const err = console.error;
  console.error = () => {};
  try {
    const lvl = r.capture('level');
    assert.deepEqual(Object.keys(lvl), ['a', 'late']);
    assert.deepEqual(Object.keys(r.capture('game')), ['inv']);
    a = 5;
    const done = r.apply({ ...lvl, broken: {} }, 'level', { reason: 'load', levelPath: 'x', version: 1 });
    assert.deepEqual(done, ['a', 'late']);
    assert.equal(a, 1);
    assert.deepEqual(order, ['a', 'late']);
  } finally {
    console.error = err;
  }
  r.reset('game');
  assert.equal(resets, 1);
  assert.equal(r.veto(), null);
  let busy = true;
  const off = r.addVeto(() => (busy ? 'cinematic' : null));
  assert.equal(r.veto(), 'cinematic');
  busy = false;
  assert.equal(r.veto(), null);
  off();
});

test('memory store: newest first, JSON round trip, delete', async () => {
  const st = new MemoryStore();
  const mk = (id: string, t: number): SaveData => ({
    version: SAVE_VERSION, id, kind: 'manual', createdAt: t, playtime: 1, difficulty: 1, levelPath: 'L/a.lvl',
    title: 'a', levelName: 'a', game: { g: { n: 1 } }, levels: {},
  });
  await st.put(mk('old', 1));
  await st.put(mk('new', 2));
  assert.deepEqual((await st.list()).map((s) => s.id), ['new', 'old']);
  assert.deepEqual((await st.get('old'))!.game, { g: { n: 1 } });
  await st.delete('new');
  assert.deepEqual((await st.list()).map((s) => s.id), ['old']);
  assert.equal('game' in summarize(mk('x', 0)), false);
});

// ---------------------------------------------------------------------------
// Level 1a

async function load1a() {
  const fs = nodeFS();
  const lvl = readSrsc(LEVEL_1A);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(fs, dirname(LEVEL_1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages };
  } finally {
    console.warn = warn;
  }
}

function makeWorld(data: Awaited<ReturnType<typeof load1a>>, log: string[] = []) {
  const entities = parseEntities(data.lvl, data.packages);
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: (uid, v) => void log.push(`vis ${uid} ${v}`),
    setTransform: () => {},
    switchPose: (uid, pose) => void log.push(`pose ${uid} ${pose}`),
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    destroyed: (uid) => void log.push(`destroyed ${uid}`),
    hasItem: () => false,
  };
  const world = new World(entities, data.packages, hooks, { levelPath: LEVEL_1A });
  world.start();
  return world;
}

const records = (w: World) => {
  const out = new Map<number, string>();
  for (const e of w.ents.values()) {
    const { motion: _m, ...s } = e.s as Record<string, unknown>;
    // A running sequence re-samples its pose on load: same pose, the key's own time may differ.
    if (s.stompKey) s.stompKey = { ...(s.stompKey as object), time: 0 };
    // A Timer that has not run keeps the countdown drawn at level start (p2 ± p3, random); the
    // original also treats it as unchanged (0x101338f0) and draws it again on load.
    const v = e.e.values as number[];
    if (e.cls === 'Timer' && !s.running && typeof s.left === 'number' && Math.abs(s.left - (v[2] ?? 0)) <= (v[3] ?? 0) + 1e-6) delete s.left;
    out.set(e.uid, stableJson([e.destroyed, e.enabled, e.visible, encodeValue(s)]));
  }
  return out;
};

test('1a: level logic state survives a save / load round trip', { skip }, async () => {
  const data = await load1a();
  const a = makeWorld(data);
  const provA = worldSaveProvider(a);
  // Play a little: open a door, pick up an item, destroy a relay, run the logic.
  const door = a.of('Switch').find((w) => (w.s.motion as { kind: string }).kind === 'rotate' && w.s.unlocked);
  assert.ok(door, 'an unlocked door in 1a');
  a.switchSet(door!, true);
  const item = [...PICKUP_CLASSES].flatMap((c) => a.of(c)).find((w) => w.visible && !w.destroyed && w.cls !== 'Quest Item Pickup');
  assert.ok(item, 'a pickup in 1a');
  a.pickup(item!);
  const relay = a.of('Message Relay')[0];
  a.destroy(relay);
  for (let i = 0; i < 120; i++) a.update(1 / 30);
  assert.equal(door!.s.open, true);

  const saved = JSON.parse(JSON.stringify(provA.save())) as WorldSaveState;
  assert.ok(Object.keys(saved.ents).length > 0 && Object.keys(saved.ents).length < a.ents.size / 2, 'saved as a diff');
  assert.ok(JSON.stringify(saved).length < 200_000, `world state is ${JSON.stringify(saved).length} bytes`);

  // Fresh level, then load.
  const log: string[] = [];
  const b = makeWorld(data, log);
  const provB = worldSaveProvider(b);
  provB.load(saved, { reason: 'load', levelPath: LEVEL_1A, version: SAVE_VERSION });
  const ra = records(a), rb = records(b);
  const diff = [...ra].filter(([uid, r]) => rb.get(uid) !== r).map(([uid]) => `${b.get(uid)?.cls}#${uid.toString(16)} ${ra.get(uid)} ${rb.get(uid)}`);
  assert.deepEqual(diff, [], 'entity states differ after load');
  assert.equal(b.time, a.time);
  assert.ok(log.includes(`pose ${door!.uid} 1`), 'door posed open');
  assert.ok(log.includes(`destroyed ${item!.uid}`) || log.includes(`vis ${item!.uid} false`), 'item hidden');
  // Restoring onto a played world goes back exactly as well (entities not in the save -> initial state).
  const c = makeWorld(data);
  const provC = worldSaveProvider(c);
  const blank = provC.save();
  provA.load(blank, { reason: 'load', levelPath: LEVEL_1A, version: SAVE_VERSION });
  const rc = records(c), ra2 = records(a);
  assert.deepEqual([...ra2].filter(([uid, r]) => rc.get(uid) !== r).length, 0, 'in-place restore to the initial state');
});

test('1a: SaveManager captures game + level scope and restores them through levelReady', { skip }, async () => {
  const data = await load1a();
  const m = new SaveManager();
  m.store = new MemoryStore();
  m.persist = true;
  m.host = { restore: async () => true, checkpointsMode: () => 2 };
  m.newGame(2);

  const items = new Map<string, { name: string; count: number }>();
  const inv = {
    items,
    health: 100,
    maxHealth: 100,
    add(name: string, count: number) {
      const it = items.get(name) ?? { name, count: 0 };
      it.count += count;
      items.set(name, it);
    },
  };
  const level = (w: World) => {
    const r = new SaveRegistry();
    r.register('world', worldSaveProvider(w), { priority: 0 });
    r.register('inventory', inventorySaveProvider(inv, () => items.clear()), { scope: 'game' });
    m.bindLevel(r, LEVEL_1A);
    return r;
  };

  const a = makeWorld(data);
  level(a);
  m.levelReady({ kind: 'new' });
  inv.add('Key', 1);
  inv.health = 42;
  const door = a.of('Switch').find((w) => w.s.unlocked && (w.s.motion as { kind: string }).kind !== 'none')!;
  a.switchSet(door, true);
  for (let i = 0; i < 90; i++) a.update(1 / 30);
  // Pending level-start checkpoint is taken after the logic settled.
  for (let i = 0; i < 4; i++) m.tick(1 / 30, null);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.checkpoint, 'checkpoint taken');
  assert.ok((await m.store.get('autosave'))?.kind === 'auto', 'autosave slot written');

  const saved = await m.saveManual();
  assert.ok(saved);
  assert.equal(saved!.difficulty, 2);
  assert.equal(saved!.levelName, '1a PrisonDeathRow');
  const stored = (await m.store.get(saved!.id))!;

  // New game wipes the inventory; loading brings it back with the door open.
  items.clear();
  inv.health = 100;
  m.newGame(0);
  const b = makeWorld(data);
  level(b);
  m.levelReady({ kind: 'load', data: stored });
  assert.equal(inv.health, 42);
  assert.equal(items.get('Key')?.count, 1);
  assert.equal(b.get(door.uid)!.s.open, true);
  assert.equal(m.session.difficulty, 2);
  assert.equal(m.checkpoint?.kind, 'checkpoint');
  assert.equal(m.canSave(), null);
});
