// Front end: input bindings (src/game/hud/bindings.ts), the credits text parser, the archives /
// credits / keyboard decoders (src/app/menu/gui-adapter.ts; data checks skip without the local
// game install) and the profile store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrsc, skip } from './helpers';
import { ACTIONS, DATA_ACTIONS, codeLabel, defaultBindings, input } from '../src/game/hud/bindings';
import { parseCredits } from '../src/app/menu/screens/credits';
import { profile } from '../src/app/menu/profile';
import { readFrontEnd } from '../src/formats/gui';
import { archivesSpec, creditsSpec } from '../src/app/menu/gui-adapter';

test('bindings: the 40 data actions (+ engine Crouch) with two key slots and a pad slot', () => {
  assert.equal(DATA_ACTIONS, 40);
  assert.equal(ACTIONS.length, 41);
  const b = defaultBindings();
  for (const a of ACTIONS) {
    assert.equal(b.keys[a].length, 2);
    assert.equal(typeof b.pad[a], 'string');
  }
  // No code is bound twice by default.
  const seen = new Set<string>();
  for (const a of ACTIONS) for (const c of [...b.keys[a], b.pad[a]].filter(Boolean)) {
    assert.ok(!seen.has(c), `${c} bound twice`);
    seen.add(c);
  }
});

test('bindings: rebinding moves the code and updates placeholder labels', () => {
  input.resetDefaults();
  assert.equal(input.labelMap().Use, 'E');
  input.set('use', 0, 'KeyK');
  assert.deepEqual(input.current.keys.use, ['KeyK', '']);
  assert.equal(input.labelMap().Use, 'K');
  // K was the Archives key: it moved.
  assert.ok(!input.current.keys.archives.includes('KeyK'));
  assert.deepEqual(input.actionsOf('KeyK'), ['use']);
  assert.equal(input.labelMap().LadderMove, 'W / S');
  input.resetDefaults();
  assert.deepEqual(input.current.keys.use, ['KeyE', '']);
});

test('bindings: key names', () => {
  assert.equal(codeLabel('KeyQ'), 'Q');
  assert.equal(codeLabel('Digit7'), '7');
  assert.equal(codeLabel('Mouse0'), 'Left Mouse');
  assert.equal(codeLabel('WheelDown'), 'Wheel Down');
  assert.equal(codeLabel('Pad7'), 'RT');
  assert.equal(codeLabel(''), '');
});

test('credits: tab-separated columns, header skipped, blank rows kept', () => {
  const rows = parseCredits('"A"\t"B"\t"C"\t"D"\r\n\t\t\t\r\n"Studio"\t\t\t\r\n\t\t"Role"\t"Person One"\r\n\t\t\t"Person Two"\r\n\t\t\t\r\n');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], []);
  assert.deepEqual(rows[1], [{ col: 0, text: 'Studio' }]);
  assert.deepEqual(rows[2], [
    { col: 2, text: 'Role' },
    { col: 3, text: 'Person One' },
  ]);
  assert.deepEqual(rows[3], [{ col: 3, text: 'Person Two' }]);
});

test('profile: unlocks report only new pages; game finished sets the prelude flag', () => {
  profile.reset();
  assert.deepEqual(profile.unlockPages(['5:467', '5:469']), ['5:467', '5:469']);
  assert.deepEqual(profile.unlockPages(['5:467']), []);
  assert.ok(profile.isUnlocked('5:469'));
  assert.equal(profile.preludeUnlocked, false);
  profile.setGameFinished(['5:470']);
  assert.ok(profile.preludeUnlocked);
  assert.ok(profile.isUnlocked('5:470'));
  profile.reset();
});

test('archives / credits decode from Interface.odu', { skip }, () => {
  const odu = readSrsc('COMMON/Interface/Interface.odu');
  const fe = readFrontEnd(new Map([[5, { id: 5, odu }]]));
  const a = fe.screens.archives ? archivesSpec(fe.screens.archives, 2) : undefined;
  assert.ok(a, 'archives decoded');
  assert.equal(a.sets.length, 2);
  assert.deepEqual(
    a.sets.map((s) => s.pages.length),
    [15, 18],
  );
  for (const s of a.sets) {
    assert.ok(s.title && s.locked, 'set title / locked texts');
    assert.equal(s.turnVideos.length, 6);
    for (const p of s.pages) {
      assert.equal(p.tiles.length, 6);
      assert.equal(p.lockedTiles.length, 6);
      assert.match(p.ref, /^5:\d+$/);
      assert.ok(p.narration);
    }
  }
  const c = fe.screens.credits ? creditsSpec(fe.screens.credits, 2) : undefined;
  assert.ok(c, 'credits decoded');
  assert.equal(c.styles.length, 4);
  assert.equal(c.textEntry, 2);
  assert.equal(c.video?.id, 32);
  // Keyboard page: 40 action names.
  const kb = fe.optionPages.keyboard;
  assert.ok(kb);
  assert.equal((kb.node.props.p30 as unknown[]).length, DATA_ACTIONS);
});
