// Creatures whose attacks come from their own attack behaviours' clips (no MeleeAttackBehavior):
// they hurt only through a Melee Weapon a clip arms (npc-melee.ts, docs/game-logic.md §15.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import type { EntityPackageSet } from '../src/formats/entities';
import { resolveCreatureClips } from '../src/game/actors/clipmap';
import { nodeFS, readSrsc, skip } from './helpers';

test('the Mainliner\'s attack-behaviour clips deal no guessed blow (no Melee Weapon, no Arm events)', { skip }, async () => {
  const path = 'LEVELS/2 Cellblocks/2 Cellblocks.lvl';
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(readSrsc(path)).dependencies, () => {})) as EntityPackageSet;
    // 10:176: 2's Mainliners (a60 killed Dallas with a guessed, untyped 10 in run d2a).
    const map = resolveCreatureClips(packages as never, { pkg: 10, id: 176 }, 10, 0);
    assert.equal(map.source.attack, 'attack behavior');
    assert.ok(map.attacks.length > 0);
    assert.ok(map.attacks.every((a) => a.weaponOnly), 'every one hurts only through an armed Melee Weapon');
  } finally {
    console.warn = warn;
  }
});
