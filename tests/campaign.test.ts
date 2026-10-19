// Campaign flow (src/game/campaign): the Level Transition graph of all 18 levels, spawn
// points, chapters, the transition mailbox, difficulty rules and the ending selection.
// Data tests skip without the local game install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { allFiles, DATA_ROOT, skip } from './helpers';
import { SrscFile } from '../src/formats/srsc';
import { readDbId } from '../src/formats/model';
import { parseEntities, type Entity, type EntityPackage, type EntityPackageSet } from '../src/formats/entities';
import { parseLevelObjects } from '../src/formats/level';
import { TransitionMailbox, handlerKey } from '../src/game/campaign/mailbox';
import { createdOnDifficulty, instanceExcludeMask, modifierValue } from '../src/game/campaign/difficulty';
import { advanceChapter, chapterIndexOf, readChapters } from '../src/game/campaign/chapters';
import { CAMPAIGN_ROUTE, campaignRoute, exactSpawn, levelSpawns, levelTransitions, normLevel, resolveSpawn, stemOf, type GraphSpawn, type GraphTransition } from '../src/game/campaign/graph';
import { endingFor } from '../src/game/campaign/system';
import { World, type WorldHooks } from '../src/game/world/logic';

// --- Pure rules ------------------------------------------------------------------------

test('mailbox: handlers store by (p0, p1), arrivals deliver to handlers with links once', () => {
  const box = new TransitionMailbox();
  box.store({ values: [12, 0] }, 1); // 6b posts "for 1b"
  box.store({ values: [31, 2] }, 1);
  box.store({ values: [12, 0] }, 2); // same key: replaced
  assert.equal(box.entries.length, 2);
  const sent: [number, number, number][] = [];
  const out = box.deliver(
    [
      { uid: 1, values: [12, 0], links: [] }, // no links: not a reader
      { uid: 2, values: [12, 0], links: [10, 11] },
      { uid: 3, values: [11, 0], links: [12] },
    ],
    (to, m, from) => sent.push([to, m, from]),
  );
  assert.deepEqual(sent, [
    [10, 2, 2],
    [11, 2, 2],
  ]);
  assert.deepEqual(out.map((o) => o.handler), [2]);
  assert.deepEqual(box.entries.map((e) => e.key), [handlerKey([31, 2])]);
  const copy = new TransitionMailbox();
  copy.load(JSON.parse(JSON.stringify(box.save())));
  assert.deepEqual(copy.entries, box.entries);
});

test('difficulty: instance masks, forward-only chapters, ending bounds', () => {
  assert.equal(instanceExcludeMask(0), 0x10008);
  assert.equal(instanceExcludeMask(3), 0x80008);
  // Retail masks: c0000 = extra pickups gone on Hard / Impossible, 10000 = enemy gone on Easy.
  assert.deepEqual([0, 1, 2, 3].map((d) => createdOnDifficulty(0xc0001, d)), [true, true, false, false]);
  assert.deepEqual([0, 1, 2, 3].map((d) => createdOnDifficulty(0x10001, d)), [false, true, true, true]);
  assert.deepEqual([0, 1, 2, 3].map((d) => createdOnDifficulty(0x70001, d)), [false, false, false, true]);
  assert.equal(createdOnDifficulty(0x9, 1), false);
  assert.equal(advanceChapter(7, 3), 7);
  assert.equal(advanceChapter(7, 9), 9);
  const docks = [
    { lo: 70, hi: 999 },
    { lo: -90, hi: 70 },
    { lo: -999, hi: -90 },
  ];
  assert.equal(endingFor(150, docks), 'good');
  assert.equal(endingFor(70, docks), 'neutral');
  assert.equal(endingFor(0, docks), 'neutral');
  assert.equal(endingFor(-90, docks), 'evil');
  assert.equal(endingFor(-150), 'evil');
});

// --- Game data ---------------------------------------------------------------------------

let packages: EntityPackageSet | undefined;
function pkgs(): EntityPackageSet {
  if (packages) return packages;
  const set = new Map<number, EntityPackage>();
  const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer as ArrayBuffer) : undefined);
  for (const rel of allFiles().filter((f) => f.toLowerCase().endsWith('.db'))) {
    const abs = join(DATA_ROOT, rel);
    const id = readDbId(readFileSync(abs, 'latin1'));
    if (id === undefined || set.has(id)) continue;
    const base = abs.slice(0, -3);
    set.set(id, { id, name: basename(base), odu: load(`${base}.odu`), xdu: load(`${base}.xdu`), qdu: load(`${base}.qdu`) });
  }
  return (packages = set);
}

const levels = () => allFiles().filter((f) => f.toLowerCase().endsWith('.lvl'));
const lvlCache = new Map<string, Entity[]>();
function entities(path: string): Entity[] {
  let e = lvlCache.get(path);
  if (!e) lvlCache.set(path, (e = parseEntities(new SrscFile(new Uint8Array(readFileSync(join(DATA_ROOT, path))).buffer as ArrayBuffer), pkgs(), { all: true })));
  return e;
}

test('graph: every Level Transition targets a level and arrives at a spawn point', { skip }, () => {
  const files = new Map(levels().map((l) => [normLevel(l), l]));
  assert.equal(files.size, 18);
  const spawns = new Map<string, GraphSpawn[]>();
  const all: GraphTransition[] = [];
  for (const l of levels()) {
    spawns.set(normLevel(l), levelSpawns(l, entities(l)));
    all.push(...levelTransitions(l, entities(l)));
  }
  assert.equal(all.length, 37);
  for (const t of all) {
    const target = files.get(normLevel(t.target));
    assert.ok(target, `${stemOf(t.level)} #${t.uid.toString(16)} -> ${t.target}: missing level`);
    const sp = resolveSpawn(spawns.get(normLevel(target!)) ?? [], t.level, t.spawn);
    assert.ok(sp, `${stemOf(t.level)} -> ${stemOf(target!)} "${t.spawn}": no spawn point`);
    // 7 ReturnToPrison is an unused test level (no transition leads there); its exit has no
    // matching spawn point name in 1b (it would land on the point named for 6b).
    if (!/7 returntoprison/.test(normLevel(t.level))) assert.ok(exactSpawn(sp, t.level, t.spawn), `${stemOf(t.level)} -> ${stemOf(target!)} "${t.spawn}": inexact spawn`);
    assert.ok(t.triggers.length > 0, `${stemOf(t.level)} #${t.uid.toString(16)}: nothing triggers it`);
  }
  // Nothing transitions into the test level 7.
  assert.equal(all.filter((t) => /7 returntoprison/.test(normLevel(t.target))).length, 0);
});

test('chapters: 21 in the UI properties; the chapter order is the campaign route', { skip }, () => {
  const chapters = readChapters(pkgs());
  assert.equal(chapters.length, 21);
  assert.ok(chapters.every((c) => c.title && c.loadingScreen && c.tiles.filter(Boolean).length === 6));
  const all = levels().flatMap((l) => levelTransitions(l, entities(l)));
  const route = campaignRoute(
    all,
    chapters.map((c) => c.template),
  );
  assert.equal(route.length, 20);
  route.forEach((t, i) => {
    const want = CAMPAIGN_ROUTE[i];
    assert.ok(t, `no transition names chapter ${chapters[i + 1].template}`);
    assert.equal(stemOf(t!.level), want.from);
    assert.equal(stemOf(t!.target), want.to);
    assert.equal(t!.spawn, want.spawn);
    if (i) assert.equal(stemOf(route[i - 1]!.target), stemOf(t!.level), 'route is continuous');
  });
  // Each chapter is named by exactly one transition (besides the unused test level 7, whose
  // exit copies 6b's).
  for (const c of chapters.slice(1)) assert.equal(all.filter((t) => t.chapter === c.template && !/7 returntoprison/.test(normLevel(t.level))).length, 1);
  // Level Properties p23: each level's own chapter (1a = index 1; the Prelude = index 0).
  const own = (l: string) => chapterIndexOf(chapters, entities(l).find((e) => e.className === 'Level Properties')?.values[23] as never);
  assert.equal(own('LEVELS/0 Prelude Docks/0 Prelude Docks.lvl'), 0);
  assert.equal(own('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'), 1);
  assert.equal(own('LEVELS/10 Docks/10 Docks.lvl'), 20);
});

test('mailbox data: every reader key (handler with links) has a sender elsewhere', { skip }, () => {
  const handlers = levels().flatMap((l) => entities(l).filter((e) => e.className === 'Level Transition Msg Handler').map((e) => ({ l, e })));
  assert.equal(handlers.length, 17);
  const senders = new Map<number, string[]>();
  for (const l of levels()) {
    const ents = entities(l);
    for (const e of ents) {
      if (e.className !== 'Level Transition Msg Handler') continue;
      const linkedFrom = ents.some((x) => x.links.includes(e.uid));
      if (linkedFrom) (senders.get(handlerKey(e.values)) ?? senders.set(handlerKey(e.values), []).get(handlerKey(e.values))!).push(stemOf(l));
    }
  }
  const readers = handlers.filter(({ e }) => e.links.length > 0);
  for (const { l, e } of readers) {
    // 10 Docks' reader 10:1 has its sender in 9 Lighthouse, 1a's 11:0 in 1b, and so on.
    const from = senders.get(handlerKey(e.values)) ?? [];
    assert.ok(from.length, `${stemOf(l)} handler #${e.uid.toString(16)} (${e.values[0]}:${e.values[1]}) has no sender`);
  }
});

test('difficulty data: modifier templates and per-difficulty placed objects', { skip }, () => {
  const p = pkgs();
  assert.deepEqual([0, 1, 2, 3].map((d) => modifierValue(p, { pkg: 2, id: 642 }, d).toFixed(2)), ['2.00', '1.00', '0.75', '0.60']);
  assert.deepEqual([0, 1, 2, 3].map((d) => modifierValue(p, { pkg: 10, id: 238 }, d).toFixed(2)), ['0.45', '1.60', '2.20', '2.60']);
  assert.equal(modifierValue(p, { pkg: 2, id: 5 }, 0), 1, 'not a Difficulty Modifier');
  const lvl = new SrscFile(new Uint8Array(readFileSync(join(DATA_ROOT, 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'))).buffer as ArrayBuffer);
  const objs = parseLevelObjects(lvl);
  const count = (d: number) => objs.filter((o) => createdOnDifficulty(o.flags, d)).length;
  // 1a: two CartWheelers only from Medium, five extra pickups only up to Medium, ...
  assert.ok(count(0) < objs.length && count(1) < objs.length);
  assert.notEqual(count(0), count(2));
  const docks = parseLevelObjects(new SrscFile(new Uint8Array(readFileSync(join(DATA_ROOT, 'LEVELS/10 Docks/10 Docks.lvl'))).buffer as ArrayBuffer));
  const bonus = docks.find((o) => o.uid === 0x13b2)!; // Movie Player 34:5 after the ending
  assert.deepEqual([0, 1, 2, 3].map((d) => createdOnDifficulty(bonus.flags, d)), [false, false, false, true]);
  const relay = docks.find((o) => o.uid === 0x13b3)!; // straight to Game Finished
  assert.deepEqual([0, 1, 2, 3].map((d) => createdOnDifficulty(relay.flags, d)), [true, true, true, false]);
});

function fakeHooks(onLevel: (path: string, spawn?: string) => void): WorldHooks {
  return {
    player: () => null,
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: onLevel,
  };
}

test('world: Level Transition p6 / p11 / p12, Message Relay enable slots', { skip }, () => {
  const path = 'LEVELS/9 Lighthouse/9 Lighthouse.lvl';
  const reqs: string[] = [];
  const w = new World(entities(path), pkgs(), fakeHooks((p, s) => reqs.push(`${stemOf(p)}|${s ?? ''}`)), { levelPath: path });
  w.start();
  const lt = w.get(0xca6)!; // -> 10 Docks, p6 = 0, p11 = Enable, p12 = Disable
  assert.equal(lt.enabled, false);
  w.send(lt.uid, 1);
  w.update(0.01);
  assert.deepEqual(reqs, []);
  w.send(lt.uid, 4); // Enable
  w.send(lt.uid, 1);
  w.update(0.01);
  assert.deepEqual(reqs, ['10 Docks|']);
  w.send(lt.uid, 5); // Disable
  w.send(lt.uid, 1);
  w.update(0.01);
  assert.equal(reqs.length, 1);
  // Message Relay: slot 5 enables, slot 6 disables (RFL 0x10178980). 10 Docks a73 starts
  // disabled with p5 = Enable.
  const dpath = 'LEVELS/10 Docks/10 Docks.lvl';
  const d = new World(entities(dpath), pkgs(), fakeHooks(() => {}), { levelPath: dpath });
  d.start();
  const relay = d.get(0xa73)!;
  assert.equal(relay.enabled, false);
  d.send(relay.uid, 4);
  d.update(0.01);
  assert.equal(relay.enabled, true);
});
