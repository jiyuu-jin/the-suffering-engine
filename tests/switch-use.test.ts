// Regression: light switches and lockers must stay usable by the player.
// Both retail templates carry p23 = 0, which was once misread as "not usable".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFS, readSrsc, skip } from './helpers';
import { parseEntities } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World } from '../src/game/world/logic';

test('1a light switches (7:5) and lockers (7:2250) are usable', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const pkgs = await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {});
  const ents = parseEntities(lvl, pkgs);
  const tpl = (e: { template?: { pkg: number; id: number } }) => `${e.template?.pkg}:${e.template?.id}`;
  const lights = ents.filter((e) => e.className === 'Switch' && tpl(e as never) === '7:5');
  const lockers = ents.filter((e) => e.className === 'Switch' && tpl(e as never) === '7:2250');
  assert.ok(lights.length > 0 && lockers.length > 0, 'expected light switches and lockers in 1a');
  const usable = World.prototype.switchUsable;
  for (const e of [...lights, ...lockers]) {
    assert.equal(usable.call({}, { cls: 'Switch', destroyed: false, e } as never), true, `switch ${e.uid.toString(16)} not usable`);
  }
});
