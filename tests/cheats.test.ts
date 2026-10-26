// The original's cheats (src/game/cheats, docs/game-logic.md §15.18): the key-sequence matcher
// (Suffering.rfl 0x100018e0), the 25 cases of the dispatcher (0x100013c0) and their data. The
// chord, the sequences and the names come from the user's install at test time: none of them is
// written here (the data tests skip without the game).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHEAT_BUFFER, CHEAT_CASES, CHEAT_COUNT, CheatInput, DIK, giveListSource, matchCheat, greyOf, readCheatInput, confirmSoundProp, type CheatInputData } from '../src/game/cheats/rules';
import { createCheatsSystem } from '../src/game/cheats/system';
import { cheatsBridge } from '../src/game/cheats/bridge';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { readXduString, type EntityPackageSet } from '../src/formats/entities';
import { ref, refs, templateValues } from '../src/game/insanity/params';
import type { GameContext } from '../src/game/runtime';
import { DATA_ROOT, nodeFS, readSrsc, skip } from './helpers';

// --- Matcher (synthetic chord / sequences) -----------------------------------------------------

const CHORD = [0x30, 0x31];
const fake: CheatInputData = { chord: CHORD, sequences: [[1, 2, 3], [1, 2, 3, 4], [5, 6], [2, 5]] };
const press = (inp: CheatInput, held: Set<number>, k: number) => {
  held.add(k);
  const a = inp.poll(held);
  held.delete(k);
  const b = inp.poll(held);
  return a >= 0 ? a : b;
};

test('cheat input: keys typed while the chord is held match a sequence', () => {
  const inp = new CheatInput(fake);
  const held = new Set<number>();
  assert.equal(press(inp, held, 5), -1, 'no chord: nothing is recorded');
  held.add(0x30);
  assert.equal(inp.poll(held), -1);
  assert.equal(press(inp, held, 5), -1, 'half the chord is not enough');
  assert.deepEqual(inp.buffer, []);
  held.add(0x31);
  inp.poll(held);
  assert.equal(inp.held, true);
  assert.equal(press(inp, held, 5), -1);
  assert.equal(press(inp, held, 6), 2, 'sequence 2 complete');
  assert.equal(inp.blocked, true);
  assert.equal(press(inp, held, 5), -1, 'after a match: nothing until the chord is released');
  assert.equal(press(inp, held, 6), -1);
  held.delete(0x31);
  inp.poll(held);
  assert.equal(inp.held, false);
  assert.deepEqual(inp.buffer, [], 'released: the buffer empties');
  held.add(0x31);
  inp.poll(held);
  assert.equal(press(inp, held, 5), -1);
  assert.equal(press(inp, held, 6), 2, 'again after the release');
});

test('cheat input: the comparison starts at the first key, the lowest index wins', () => {
  const inp = new CheatInput(fake);
  const held = new Set(CHORD);
  inp.poll(held);
  assert.equal(press(inp, held, 9), -1, 'a wrong first key');
  assert.equal(press(inp, held, 5), -1);
  assert.equal(press(inp, held, 6), -1, 'spoiled: the buffer no longer starts with sequence 2');
  assert.deepEqual(inp.buffer, [9, 5, 6]);
  // Sequence 0 is a prefix of sequence 1: it matches first, so sequence 1 is never reached.
  assert.equal(matchCheat(fake.sequences, [1, 2, 3, 4]), 0);
  assert.equal(matchCheat(fake.sequences, [1, 2]), -1);
  assert.equal(matchCheat(fake.sequences, [2, 5, 7]), 3);
});

test('cheat input: only keys that went down count, the chord keys are not recorded, 32 keys block', () => {
  const inp = new CheatInput(fake);
  const held = new Set<number>([5]);
  inp.poll(held);
  held.add(0x30).add(0x31);
  inp.poll(held);
  assert.deepEqual(inp.buffer, [], 'a key already down when the chord closes is not new');
  held.delete(5);
  inp.poll(held);
  assert.equal(press(inp, held, 6), -1);
  assert.deepEqual(inp.buffer, [6]);
  // Two keys new in one poll: appended lowest code first.
  held.add(9).add(8);
  inp.poll(held);
  assert.deepEqual(inp.buffer, [6, 8, 9]);
  held.delete(9);
  held.delete(8);
  inp.poll(held);
  for (let i = 0; i < CHEAT_BUFFER; i++) press(inp, held, 0x40 + (i % 2));
  assert.equal(inp.buffer.length, CHEAT_BUFFER);
  assert.equal(inp.blocked, true, 'full: the input waits for the release');
});

// --- Case table ------------------------------------------------------------------------------

test('cheat cases: every name shown once, the give lists, the confirmation sounds', () => {
  assert.equal(CHEAT_CASES.length, CHEAT_COUNT);
  assert.deepEqual([...CHEAT_CASES.map((c) => c.name)].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
  assert.deepEqual([22, 23, 24].map((i) => CHEAT_CASES[i].name), [24, 22, 23], 'cases 22..24 show another index');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => giveListSource(n)?.prop), [25, 26, 27, 28, 29, 315, 30, 31, 32]);
  assert.equal(giveListSource(5)?.from, 'player');
  const combo = CHEAT_CASES[19].effect;
  assert.deepEqual(combo.kind === 'combo' ? combo.cases : [], [16, 15, 2, 9, 18]);
  assert.equal(confirmSoundProp(19), 34);
  assert.equal(confirmSoundProp(3), 33);
  assert.equal(greyOf(1, 1, 1), 1);
  assert.ok(Math.abs(greyOf(1, 0, 0) - 0.3) < 1e-9 && Math.abs(greyOf(0, 1, 0) - 0.55) < 1e-9);
});

// --- The user's data -------------------------------------------------------------------------

const rfl = () => new Uint8Array(readFileSync(join(DATA_ROOT, 'Suffering.rfl')));

test('Suffering.rfl: the chord and 25 sequences of DirectInput keys, each one reachable by typing', { skip }, () => {
  const data = readCheatInput(rfl());
  assert.ok(data, 'read');
  assert.equal(data.sequences.length, 25);
  const keys = new Set(Object.values(DIK));
  for (const k of [...data.chord, ...data.sequences.flat()]) assert.ok(keys.has(k), `key 0x${k.toString(16)} has a browser key`);
  data.sequences.forEach((s, i) => {
    assert.ok(s.length >= 2 && s.length < CHEAT_BUFFER, `sequence ${i} length`);
    for (const k of s) assert.ok(!data.chord.includes(k), 'no chord key inside a sequence (they are not recorded)');
    // Typed with the chord held: this sequence, not an earlier one.
    const inp = new CheatInput(data);
    const held = new Set(data.chord);
    inp.poll(held);
    let hit = -1;
    for (const k of s) {
      const got = press(inp, held, k);
      if (got >= 0) hit = got;
    }
    assert.equal(hit, i, `sequence ${i} typed`);
  });
});

test('Game Cheats (Player p314): 25 names, item lists of pickups, four sounds', { skip }, async () => {
  const pkgs = await packagesFor1a();
  const player = templateValues(pkgs, { pkg: 2, id: 5 });
  const cr = ref(player?.values[314]);
  assert.ok(cr);
  const gc = templateValues(pkgs, cr);
  assert.equal(gc?.cls, 'Game Cheats');
  for (let i = 0; i < 25; i++) {
    const r = ref(gc!.values[i]);
    assert.ok(r && (readXduString(pkgs, r) ?? '').length > 0, `p${i} is a string`);
  }
  for (let p = 25; p <= 32; p++) {
    const l = refs(gc!.values[p]);
    assert.ok(l.length > 0, `p${p} has items`);
    for (const t of l) assert.ok(['Ammo Box', 'Health Bonus Item', 'Map Pack'].includes(templateValues(pkgs, t)?.cls ?? ''), `p${p} ${t.pkg}:${t.id} is a pickup`);
  }
  assert.ok(refs(player?.values[315]).length > 20, 'the Player p315 list (case 18)');
  for (let p = 33; p <= 36; p++) assert.ok(ref(gc!.values[p]), `p${p} sound`);
});

let pkgsCache: EntityPackageSet | undefined;
async function packagesFor1a(): Promise<EntityPackageSet> {
  if (pkgsCache) return pkgsCache;
  const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const warn = console.warn;
  console.warn = () => {};
  try {
    pkgsCache = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(readSrsc(L1A)).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  return pkgsCache;
}

test('dispatch: each case reaches the services as the original dispatcher does', { skip }, async () => {
  const pkgs = await packagesFor1a();
  const calls: string[] = [];
  const played: string[] = [];
  const texts: string[] = [];
  let transformed = false;
  let reputation = 0;
  const inv = new Map<string, number>();
  const services: Record<string, unknown> = {
    insanity: {
      get transformed() {
        return transformed;
      },
      get mode() {
        return transformed ? 'insane' : 'normal';
      },
      reputationRange: [-150, 150],
      addReputation: (n: number) => (reputation += n),
      setReputation: (n: number) => (reputation = n),
      setMeter: (f: number) => calls.push(`meter ${f}`),
      acquireNextAttack: () => (calls.push('attack'), true),
      setClockRate: (r: number) => calls.push(`clock ${r}`),
    },
    repskin: { maxBlood: 100, addBlood: (n: number) => calls.push(`blood+ ${n}`), setBlood: (n: number) => calls.push(`blood= ${n}`) },
    combat: { player: { health: 10, maxHealth: 100, alive: true }, damagePlayer: (n: number) => calls.push(`damage ${n}`), healPlayer: (n: number) => (calls.push(`heal ${n}`), n) },
    weapons: {
      current: { id: '4:5', ranged: true },
      throwable: { id: '4:250', count: 3 },
      give: (id: string, n = 1) => {
        calls.push(`give ${id} ${n}`);
        inv.set(id, (inv.get(id) ?? 0) + n);
      },
    },
    inventory: { items: new Map(), count: (r: { pkg: number; id: number }) => inv.get(`${r.pkg}:${r.id}`) ?? 3 },
    world: { giveItem: (t: { pkg: number; id: number }) => (calls.push(`item ${t.pkg}:${t.id}`), true) },
  };
  const ctx = {
    fs: { resolve: async () => undefined },
    view: { renderer: {}, glow: { state: { flag: 0 } }, enhanced: null, postEffects: true },
    audio: { get: () => ({}), play: (k: string) => (played.push(k), { stop: () => played.push(`stop ${k}`) }) },
    loaded: { packages: pkgs },
    services,
  } as unknown as GameContext;
  const { hudBus } = await import('../src/game/hud/bus');
  const sys = await createCheatsSystem(ctx);
  const svc = services.cheats as { apply(i: number, announce?: boolean): boolean; names: string[]; toggles: { greyFilm: boolean; fullGlow: boolean } };
  assert.ok(svc && cheatsBridge.list, 'service and menu bridge');
  assert.equal(svc.names.length, 25);
  const run = (i: number) => {
    calls.length = 0;
    played.length = 0;
    const before = hudBus.messages.length;
    const r = svc.apply(i);
    texts.push(...hudBus.messages.slice(before).map((m) => m.text));
    return r;
  };
  run(0);
  assert.equal(reputation, -50);
  run(1);
  run(1);
  assert.equal(reputation, 50, 'no clamp: -50 +50 +50');
  assert.deepEqual(played, ['2:406'], 'p33 confirms');
  assert.equal(texts[texts.length - 1], svc.names[1], 'the name in the pickup text');
  run(9);
  assert.equal(reputation, -150, 'p70');
  run(10);
  assert.equal(reputation, 150, 'p71');
  run(2);
  assert.deepEqual(calls, ['blood+ 100']);
  run(3);
  assert.deepEqual(calls, ['blood= 0']);
  run(4);
  assert.deepEqual(calls, ['damage 100000']);
  run(16);
  assert.deepEqual(calls, ['heal 100']);
  run(15);
  assert.deepEqual(calls, ['meter 1']);
  run(12);
  const ammo = ref(templateValues(pkgs, { pkg: 4, id: 5 })?.values[68]);
  assert.deepEqual(calls, [`give ${ammo!.pkg}:${ammo!.id} 1000000`], 'the revolver\'s p68 ammo');
  run(13);
  assert.deepEqual(calls, ['give 4:250 5'], 'throwable to 8');
  run(11);
  assert.deepEqual(calls, ['item 4:72', ...Array(10).fill('item 4:203')], 'flashlight and 10 batteries (capped by the inventory)');
  assert.equal(run(14), false, 'not transformed: silent');
  assert.deepEqual(played, []);
  transformed = true;
  assert.equal(run(14), true);
  assert.deepEqual(calls, ['attack']);
  run(18);
  assert.equal(calls.length, 0, 'transformed: the creature template\'s p315 is empty');
  transformed = false;
  run(18);
  assert.ok(calls.length > 20 && calls.every((c) => c.startsWith('item 4:')), 'Player p315');
  run(19);
  assert.deepEqual(calls.slice(0, 3), ['heal 100', 'meter 1', 'blood+ 100']);
  assert.equal(reputation, -150, 'case 9 inside the combination');
  assert.deepEqual(played, ['2:407'], 'p34 confirms the combination, the parts are silent');
  for (const [i, prop] of [[5, 25], [6, 26], [7, 27], [8, 28], [17, 29], [23, 30], [24, 31], [22, 32]] as const) {
    run(i);
    const want = refs(templateValues(pkgs, { pkg: 2, id: 935 })?.values[prop]).map((t) => `item ${t.pkg}:${t.id}`);
    assert.deepEqual(calls, want, `case ${i} gives p${prop}`);
  }
  run(20);
  assert.equal(svc.toggles.greyFilm, true);
  assert.deepEqual(calls, ['clock 1.3']);
  assert.deepEqual(played, ['2:408', '2:406'], 'p35 loop, then p33');
  run(21);
  assert.deepEqual(calls, ['clock 0.7']);
  assert.equal((ctx.view as unknown as { glow: { state: { flag: number } } }).glow.state.flag, 1, 'the whole frame into the glow');
  run(20);
  assert.deepEqual(calls, ['clock 1']);
  assert.ok(played.includes('stop 2:408'));
  run(21);
  assert.equal(svc.toggles.fullGlow, false);
  assert.equal((ctx.view as unknown as { glow: { state: { flag: number } } }).glow.state.flag, 0);
  sys.dispose?.();
  assert.equal(cheatsBridge.list, null);
});
