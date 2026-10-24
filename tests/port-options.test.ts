// Port option "Enemies ignore the player" (src/game/port-options.ts; docs/game-logic.md §15.17):
// the URL override, the specials' target / aim / grab gates, persistence with the settings, and
// the Gameplay pages' menu row (data check skips without the local game install).
// The actor-level target choice, grudge and hearing rules are in tests/targeting.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignorePlayerOverride, portOptions, storedIgnorePlayer } from '../src/game/port-options';
import { fightTarget, noTargetAim } from '../src/game/actors/specials/params';
import { PlayerHold } from '../src/game/actors/specials/hold';
import { IGNORE_PLAYER_SETTING, buildMenuModel } from '../src/app/menu/gui-adapter';
import { nodeFS, skip } from './helpers';

test('ignore player: ?ignorePlayer= overrides (1 / empty / true on, 0 / false / off off), absent = none', () => {
  assert.equal(ignorePlayerOverride(''), undefined);
  assert.equal(ignorePlayerOverride('?level=x'), undefined);
  assert.equal(ignorePlayerOverride('?ignorePlayer=1'), true);
  assert.equal(ignorePlayerOverride('?ignorePlayer'), true);
  assert.equal(ignorePlayerOverride('?a=b&ignorePlayer=true'), true);
  assert.equal(ignorePlayerOverride('?ignorePlayer=0'), false);
  assert.equal(ignorePlayerOverride('?ignorePlayer=off'), false);
  assert.equal(portOptions.ignorePlayer, false, 'off by default (no page URL under node)');
});

test('ignore player: the specials see no fight target on him and aim away from him', () => {
  const player = { position: { x: 3, y: 0, z: 4 } };
  const a = { alive: true, inCombat: true, currentTarget: { player: true }, position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  assert.deepEqual(fightTarget(a, { playerAlive: true, player }), { player: true, pos: player.position });
  assert.equal(fightTarget(a, { playerAlive: true, player, ignorePlayer: true }), undefined);
  assert.equal(noTargetAim(a, { player }), player.position);
  // 5 m ahead (yaw 0 faces -z).
  assert.deepEqual(noTargetAim(a, { player, ignorePlayer: true }), { x: 0, y: 0, z: -5 });
});

test('ignore player: no grab or ride takes the player while it is on', () => {
  const rt = { player: { motionOverride: null, attackOverride: null, motor: { onGround: true } }, holder: null, playerAlive: true };
  const holder = {} as never;
  const h = new PlayerHold(rt as never, holder);
  portOptions.ignorePlayer = true;
  try {
    assert.equal(h.start(), false);
    assert.equal(rt.holder, null);
  } finally {
    portOptions.ignorePlayer = false;
  }
  assert.equal(h.start(), true);
  h.release();
});

test('ignore player: saved and loaded with the settings; applySettings sets the live flag', async () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const had = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const { applySettings, loadSettings, saveSettings, setSetting } = await import('../src/app/menu/settings');
    const s = loadSettings();
    assert.equal(s.extra.ignorePlayer, undefined, 'off unless set');
    assert.equal(storedIgnorePlayer(), false);
    setSetting(s, IGNORE_PLAYER_SETTING, true);
    saveSettings(s);
    const r = loadSettings();
    assert.equal(r.extra.ignorePlayer, true, 'persisted');
    assert.equal(storedIgnorePlayer(), true, 'read back for pages without the menu flow');
    const audio = { setBusVolume: () => {} };
    applySettings(r, { audio: audio as never, look: [] });
    assert.equal(portOptions.ignorePlayer, true);
    setSetting(r, IGNORE_PLAYER_SETTING, false);
    applySettings(r, { audio: audio as never, look: [] });
    assert.equal(portOptions.ignorePlayer, false);
  } finally {
    g.localStorage = had;
    portOptions.ignorePlayer = false;
  }
});

test('ignore player: a row on both Gameplay pages (front end and pause menu), Off / On, with its help line', { skip }, async () => {
  const model = await buildMenuModel(nodeFS());
  for (const id of ['page.gameplay', 'page.gameplayInGame']) {
    const sc = model.screens[id];
    assert.ok(sc, id);
    const row = sc.items.find((it) => it.type === 'choice' && it.setting === IGNORE_PLAYER_SETTING);
    assert.ok(row && row.type === 'choice', `${id}: row`);
    assert.deepEqual(row.choices.map((c) => c.value), [false, true]);
    assert.match(row.help?.label.text ?? '', /Port option, not in the original game/);
    assert.match(row.help?.label.text ?? '', /still hurt/);
    // Below Always Run, above Accept / Cancel.
    const run = sc.items.find((it) => it.type === 'choice' && it.setting === 'x.alwaysRun');
    const accept = sc.items.find((it) => it.type === 'button' && it.action.kind === 'pageAccept');
    assert.ok(run?.place && row.place && accept?.place);
    assert.ok(row.place.rect.y > run.place.rect.y && row.place.rect.y + row.place.rect.h <= accept.place.rect.y + 1);
  }
});
