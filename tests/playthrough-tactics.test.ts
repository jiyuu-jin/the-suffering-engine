// The playthrough harness's fight tactics (tools/playthrough-tactics.js): the pure decisions, and
// the data the "crowd the gunman" tactic leans on (the ranged Slayer's kick deals no damage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import type { EntityPackageSet } from '../src/formats/entities';
import { resolveCreatureClips } from '../src/game/actors/clipmap';
// @ts-expect-error a plain JS module of the harness (no types)
import { braceDrinks, drinkNow, EXPLOSIVE_TEMPLATES, harmlessUpClose, keepFromBlade, morphNow, TACTICS_PAGE } from '../tools/playthrough-tactics.js';
import { readTemplate } from '../src/game/world/fx';
import { nodeFS, readSrsc, skip } from './helpers';

test('tactics: a gunman is crowded only when every melee attack of its kind is weapon-only and it holds no blade', () => {
  const kick = { weaponOnly: true };
  assert.equal(harmlessUpClose({ profile: { ranged: {}, melee: [] }, kind: { attacks: [kick] } }), true);
  // A Melee Weapon held (a guard's baton), a blow of its own, no melee attack at all, a thrower
  // (the Mainliner's needle), no gun: not crowded.
  assert.equal(harmlessUpClose({ profile: { ranged: {}, melee: [{}] }, kind: { attacks: [kick] } }), false);
  assert.equal(harmlessUpClose({ profile: { ranged: {} }, kind: { attacks: [kick, { weaponOnly: false }] } }), false);
  assert.equal(harmlessUpClose({ profile: { ranged: {} }, kind: { attacks: [] } }), false);
  assert.equal(harmlessUpClose({ profile: { ranged: { thrown: {} } }, kind: { attacks: [kick] } }), false);
  assert.equal(harmlessUpClose({ profile: {}, kind: { attacks: [kick] } }), false);
});

test('tactics: bottles are drunk below 40, below 55 under fire, and topped up before a fight without waste', () => {
  assert.equal(drinkNow({ hp: 39, packs: 1, human: true, underFire: false }), true);
  assert.equal(drinkNow({ hp: 50, packs: 1, human: true, underFire: false }), false);
  assert.equal(drinkNow({ hp: 50, packs: 1, human: true, underFire: true }), true);
  assert.equal(drinkNow({ hp: 20, packs: 0, human: true, underFire: true }), false);
  // (Transformed the bottle cannot be drunk: canDrinkHealth.)
  assert.equal(drinkNow({ hp: 20, packs: 2, human: false, underFire: true }), false);
  assert.equal(braceDrinks({ hp: 50, max: 100, packs: 3 }, { hp: 85, keep: 1 }), 2);
  assert.equal(braceDrinks({ hp: 50, max: 100, packs: 3 }, { hp: 90, keep: 0 }), 2, 'a third would top 100');
  assert.equal(braceDrinks({ hp: 81, max: 100, packs: 3 }, { hp: 90, keep: 0 }), 0, 'within a bottle of full');
  assert.equal(braceDrinks({ hp: 30, max: 100, packs: 1 }, { hp: 70, keep: 1 }), 0, 'the kept bottle');
});

test('tactics: the player backs off from a blade only with a gun on it, and not from a Burrower', () => {
  const cw = { ranged: false, d: 3, st: 'chase', cls: 'CartWheeler' };
  assert.equal(keepFromBlade(cw, { human: true, shoot: true }), true);
  assert.equal(keepFromBlade(cw, { human: true, shoot: false }), false);
  assert.equal(keepFromBlade(cw, { human: false, shoot: true }), false);
  assert.equal(keepFromBlade({ ...cw, d: 5 }, { human: true, shoot: true }), false);
  assert.equal(keepFromBlade({ ...cw, st: 'idle' }, { human: true, shoot: true }), false);
  assert.equal(keepFromBlade({ ...cw, cls: 'Burrower' }, { human: true, shoot: true }), false);
  assert.equal(keepFromBlade({ ...cw, ranged: true }, { human: true, shoot: true }), false);
});

test('tactics: the creature form is taken when a fight goes badly, not against one creature at full strength', () => {
  const cw = (d: number) => ({ ranged: false, onMe: true, d, hp: 48 });
  assert.equal(morphNow({ sc: [cw(3)], hp: 90 }), false);
  assert.equal(morphNow({ sc: [cw(3)], hp: 55 }), true);
  assert.equal(morphNow({ sc: [cw(3), cw(8)], hp: 90 }), true);
  assert.equal(morphNow({ sc: [cw(6), cw(8)], hp: 90 }), false);
  assert.equal(morphNow({ sc: [cw(6), cw(8), cw(9)], hp: 90 }), true);
  assert.equal(morphNow({ sc: [{ ranged: true, onMe: true, d: 13, hp: 124.8 }], hp: 100 }), true);
  assert.equal(morphNow({ sc: [{ ranged: true, onMe: true, d: 13, hp: 30 }], hp: 100 }), false);
});

test('tactics: the page script parses', () => {
  assert.doesNotThrow(() => new Function(TACTICS_PAGE));
});

test('tactics: the ranged Slayer 10:527 is crowded by data (its kick hurts only through a Melee Weapon, it holds none)', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(readSrsc(path)).dependencies, () => {})) as EntityPackageSet;
    const map = resolveCreatureClips(packages as never, { pkg: 10, id: 527 }, 10, 0);
    assert.ok(map.attacks.length > 0, 'the kick (MeleeAttack 10:1566)');
    assert.equal(harmlessUpClose({ profile: { ranged: {}, melee: [] }, kind: { attacks: map.attacks } }), true);
  } finally {
    console.warn = warn;
  }
});

test('tactics: the listed explosive Breakables break into a Radius Damage (Breakable p18 -> Object Generator)', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(readSrsc(path)).dependencies, () => {})) as EntityPackageSet;
    const isRef = (v: unknown): v is { pkg: number; id: number } => !!v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in v;
    // The Radius Damages a template's generators make, two generators deep.
    const blasts = (r: { pkg: number; id: number }, depth = 0): { p0: number; radius: number }[] => {
      const t = readTemplate(packages, r);
      if (!t) return [];
      if (t.cls === 'Radius Damage') return [{ p0: Number(t.values[0]), radius: Number(t.values[5]) }];
      if (t.cls !== 'Object Generator' || depth > 2) return [];
      return t.values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isRef).flatMap((x) => blasts(x, depth + 1));
    };
    for (const key of EXPLOSIVE_TEMPLATES as string[]) {
      const [pkg, id] = key.split(':').map(Number);
      const t = readTemplate(packages, { pkg, id });
      assert.equal(t?.cls, 'Breakable', key);
      const spawn = t!.values[18];
      assert.ok(isRef(spawn), `${key} has a break spawn`);
      const b = blasts(spawn);
      assert.ok(b.length >= 1 && b.every((x) => x.radius >= 10), `${key}: ${JSON.stringify(b)}`);
    }
  } finally {
    console.warn = warn;
  }
});
