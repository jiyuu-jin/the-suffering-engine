// Chapter-1 NPC / creature data the actors system relies on (src/game/actors/behaviors.ts,
// director.ts; docs/game-logic.md §15): every Behavior Changer hands out a decodable root
// behaviour, behaviour chains and waypoint paths resolve, Object Cloner templates are
// characters, and Line of Dialog / Speech Player sounds are dialog sounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { parseEntities, type Entity, type EntityPackage } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { BehaviorLibrary } from '../src/game/actors/behaviors';

let cache: { packages: Map<number, EntityPackage>; levels: Map<string, Entity[]> } | undefined;
function load() {
  if (cache) return cache;
  const packages = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || packages.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    packages.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`) } as EntityPackage);
  }
  const levels = new Map<string, Entity[]>();
  for (const l of ['1a', '1b', '1c']) levels.set(l, parseEntities(readSrsc(`LEVELS/1 PrisonDeathRow/${l} PrisonDeathRow.lvl`), packages));
  return (cache = { packages, levels });
}

test('chapter 1 Behavior Changers hand out decodable behaviours with resolvable chains', { skip }, () => {
  const { packages, levels } = load();
  let changers = 0, placed = 0, talks = 0, lines = 0;
  for (const [l, ents] of levels) {
    const byUid = new Map(ents.map((e) => [e.uid, e]));
    const B = new BehaviorLibrary(packages, byUid);
    for (const e of ents.filter((x) => x.className === 'Behavior Changer')) {
      changers++;
      const p6 = e.values[6];
      const uid = (Array.isArray(p6) ? p6[0] : p6) as number | null;
      if (!uid) continue;
      const seen = new Set<number>();
      let b = B.fromPlaced(uid);
      assert.ok(b, `${l} BC#${e.uid.toString(16)}: root #${uid.toString(16)} decodes`);
      while (b && b.uid && !seen.has(b.uid)) {
        seen.add(b.uid);
        placed++;
        if (b.kind === 'waypoint') assert.equal(byUid.get(b.first)?.className, 'Waypoint', `${l} ${b.cls}#${b.uid.toString(16)} first waypoint`);
        if (b.kind === 'talk') {
          talks++;
          lines += b.lines.length + b.ambient.length;
          assert.ok(b.lines.length + b.ambient.length > 0, `${l} ${b.cls}#${b.uid.toString(16)} has lines`);
          for (const ln of [...b.lines, ...b.ambient]) assert.ok(ln.sounds.length > 0, 'line has a sound');
        }
        b = b.next.length ? B.fromPlaced(b.next[0]) : undefined;
      }
    }
  }
  assert.ok(changers >= 140 && placed >= 100 && talks >= 40 && lines >= 40, `${changers} changers, ${placed} behaviours, ${talks} talks, ${lines} lines`);
});

test('chapter 1 Object Cloners copy characters', { skip }, () => {
  const { levels } = load();
  let n = 0;
  for (const [l, ents] of levels) {
    const byUid = new Map(ents.map((e) => [e.uid, e]));
    for (const e of ents.filter((x) => x.className === 'Object Cloner')) {
      const list = (Array.isArray(e.values[5]) ? e.values[5] : [e.values[5]]) as number[];
      for (const u of list) {
        assert.equal(byUid.get(u)?.family, 'Character', `${l} Cloner#${e.uid.toString(16)} template #${u.toString(16)}`);
        n++;
      }
    }
  }
  assert.ok(n >= 40, `${n} cloner templates`);
});

test('chapter 1 Nooseman drop groups exist', { skip }, () => {
  const { levels } = load();
  for (const [l, ents] of levels) {
    const byUid = new Map(ents.map((e) => [e.uid, e]));
    for (const e of ents.filter((x) => x.className === 'Nooseman')) {
      const g = byUid.get(e.values[185] as number);
      assert.equal(g?.className, 'Nooseman Drop Position', `${l} Nooseman#${e.uid.toString(16)} p185`);
      assert.ok(g!.links.length > 0, 'drop group root links to the other positions');
    }
  }
});

test('chapter 1: every placed Character class is in the actors class registry', { skip }, async () => {
  const { ACTOR_CLASSES, CHARACTER_CLASSES } = await import('../src/game/actors/classes');
  const { levels } = load();
  for (const [l, ents] of levels) {
    for (const e of ents) {
      if (e.family === 'Character' && e.className !== 'Player') assert.ok(CHARACTER_CLASSES.has(e.className), `${l} ${e.className}`);
    }
  }
  for (const c of ['EdgeToggler', 'Object Cloner', 'Behavior Changer', 'Companion Spawn Point']) assert.ok(ACTOR_CLASSES[c], c);
});

test('chapter 1 EdgeTogglers name an existing Move Node edge', { skip }, async () => {
  const { NavGraph } = await import('../src/game/actors/nav');
  const { levels } = load();
  let n = 0;
  for (const [l, ents] of levels) {
    const nav = new NavGraph(ents);
    for (const e of ents.filter((x) => x.className === 'EdgeToggler')) {
      assert.ok(e.links.length >= 2, `${l} EdgeToggler#${e.uid.toString(16)} links two nodes`);
      assert.ok(nav.setEdge(e.links[0], e.links[1], false), `${l} EdgeToggler#${e.uid.toString(16)}: edge exists`);
      const a = nav.byUid.get(e.links[0])!, b = nav.byUid.get(e.links[1])!;
      assert.equal(nav.edgeEnabled(b, a), false, 'both directions switch together');
      const p = nav.path(a, b);
      assert.ok(!p || p.length > 2, 'a disabled edge is not used');
      nav.setEdge(e.links[0], e.links[1], true);
      assert.deepEqual(nav.path(a, b), [a, b]);
      n++;
    }
  }
  assert.ok(n >= 8, `${n} togglers`);
});
