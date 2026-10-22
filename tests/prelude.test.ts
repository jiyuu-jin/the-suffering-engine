// The Prelude (docs/playthrough.md "0 Prelude"): the attackers in the holding pen fight with
// their placement's own MeleeAttackBehavior (Character p87 overridden on template 10:392) and
// wait between blows by their KillMeleeBehavior (p85); the level's one transition leads to 1a's
// West Spawn, where New Game starts 1a.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classByHash, decodeTemplateProps, parseEntities, readObjectTemplate, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { CHARACTER_MELEE_SLOT, resolveCreatureClips } from '../src/game/actors/clipmap';
import { CHAR, templateProp } from '../src/game/actors/behaviors';
import { nodeFS, readSrsc, skip } from './helpers';

async function level(path: string) {
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    const ents = parseEntities(lvl, packages);
    return { packages, byUid: new Map<number, Entity>(ents.map((e) => [e.uid, e])) };
  } finally {
    console.warn = warn;
  }
}

const PRELUDE = 'LEVELS/0 Prelude Docks/0 Prelude Docks.lvl';

test('Prelude attackers: their own MeleeAttackBehavior (p87 overridden) gives the weapon clips', { skip }, async () => {
  const { packages, byUid } = await level(PRELUDE);
  const ddd = byUid.get(0xddd)!;
  assert.ok(ddd.overridden.includes(CHARACTER_MELEE_SLOT), 'p87 is an instance override');
  const own = ddd.values[CHARACTER_MELEE_SLOT] as { pkg: number; id: number };
  assert.deepEqual([own.pkg, own.id], [10, 297]);
  const tpl = { pkg: 10, id: 392 };
  // The template alone has no MeleeAttackBehavior: no weapon attacks.
  const plain = resolveCreatureClips(packages as never, tpl, 10, 5);
  assert.ok(!plain.attacks.some((a) => a.weaponOnly), 'template: no weapon-armed attack');
  const withOwn = resolveCreatureClips(packages as never, tpl, 10, 5, new Map([[CHARACTER_MELEE_SLOT, own]]));
  assert.deepEqual(withOwn.attacks.map((a) => `${a.clip.pkg}:${a.clip.id}`), ['10:1727', '10:351']);
  assert.ok(withOwn.attacks.every((a) => a.weaponOnly && a.scale === 1));
});

test('Prelude attackers: KillMeleeBehavior p85 waits 0.5..1.5 s between blows', { skip }, async () => {
  const { packages, byUid } = await level(PRELUDE);
  const ddd = byUid.get(0xddd)!;
  const r = templateProp(ddd.values, classByHash(ddd.classHash)!.types, CHAR.killMelee)!;
  const t = readObjectTemplate(packages, r)!;
  const c = classByHash(t.classHash)!;
  assert.equal(c.name, 'KillMeleeBehavior');
  const v = decodeTemplateProps(c, t);
  assert.deepEqual([v[2], v[3]], [0.5, 1.5]);
});

test('Prelude exit: Level Transition 1172 -> 1a "West Spawn" (chapter 5:585), the spot New Game starts 1a', { skip }, async () => {
  const p = await level(PRELUDE);
  const lt = p.byUid.get(0x1172)!;
  assert.match(String(lt.props.targetLevel), /1a PrisonDeathRow\.lvl$/);
  assert.deepEqual(lt.props.targetSpawnNames, ['West Spawn']);
  const a = await level('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl');
  const sp = a.byUid.get(0x894e)!;
  assert.equal(sp.props.spawnName, 'West Spawn');
  assert.match(String(sp.props.fromLevel), /0 Prelude Docks\.lvl$/);
  const player = [...a.byUid.values()].find((e) => e.className === 'Player')!;
  const d = Math.hypot((sp.position[0] - player.position[0]) / 2048, (sp.position[2] - player.position[2]) / 2048);
  assert.ok(d < 1, `West Spawn ${d.toFixed(2)} m from 1a's Player object`);
});
