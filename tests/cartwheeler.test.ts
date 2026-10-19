// The CartWheeler ("Slayer") ceiling crawler: nav graph ceiling nodes and edge types, behaviour
// variants by condition bits, and the decoded CartWheeler parameters (docs/game-logic.md
// §15.7.5; src/game/actors/nav.ts, variants.ts, specials/cartwheeler-params.ts). The data tests
// run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { classByHash, decodeTemplateProps, parseEntities, readObjectTemplate, type Entity, type EntityPackage } from '../src/formats/entities';
import { WORLD_SCALE } from '../src/formats/level';
import { readDbId, type ResRef } from '../src/formats/model';
import { EDGE, edgeTypeOf, NavGraph } from '../src/game/actors/nav';
import { condBits, COND, pickVariant, variantMatches } from '../src/game/actors/variants';
import { cartWheelerParams, CW_SLOT } from '../src/game/actors/specials/cartwheeler-params';

const key = (r: ResRef | undefined) => (r ? `${r.pkg}:${r.id}` : '');

// ---------------------------------------------------------------------------------------
// Pure rules

test('nav: edge types follow the two nodes in walking order [verified 0x100da930]', () => {
  assert.equal(edgeTypeOf(false, false), EDGE.floor);
  assert.equal(edgeTypeOf(true, true), EDGE.ceiling);
  assert.equal(edgeTypeOf(false, true), EDGE.up);
  assert.equal(edgeTypeOf(true, false), EDGE.down);
  assert.deepEqual([EDGE.floor, EDGE.ceiling, EDGE.up, EDGE.down], [0, 1, 2, 3]);
});

/** Move Nodes: (uid, x, y, z, links, p0). Entity positions are level units (x WORLD_SCALE). */
function nodes(list: [number, number, number, number, number[], number][]): Entity[] {
  return list.map(([uid, x, y, z, links, p0]) => ({ uid, className: 'Move Node Object', position: [x * WORLD_SCALE, y * WORLD_SCALE, z * WORLD_SCALE], links, values: [p0], props: {}, scale: [2, 2, 2] }) as unknown as Entity);
}

test('nav: walkers keep to floor nodes, crawlers may go over the ceiling', () => {
  // Floor 1 - 2 - 3 - 4 in a U; ceiling 10 - 11 bridges 1 and 4 straight over.
  const nav = new NavGraph(
    nodes([
      [1, 0, 0, 0, [2, 10], 0],
      [2, 0, 0, 10, [3], 0],
      [3, 10, 0, 10, [4], 0],
      [4, 10, 0, 0, [11], 0],
      [10, 0, 4, 0, [11], 1],
      [11, 10, 4, 0, [], 1],
    ]),
  );
  const i = (u: number) => nav.byUid.get(u)!;
  assert.equal(nav.nodes[i(10)].ceiling, true);
  assert.equal(nav.nodes[i(1)].ceiling, false);
  assert.equal(nav.edgeType(i(1), i(10)), EDGE.up);
  assert.equal(nav.edgeType(i(10), i(1)), EDGE.down);
  assert.equal(nav.edgeType(i(10), i(11)), EDGE.ceiling);
  assert.deepEqual(nav.path(i(1), i(4))?.map((n) => nav.nodes[n].uid), [1, 2, 3, 4], 'walkers go around');
  assert.deepEqual(nav.path(i(1), i(4), undefined, { crawler: true })?.map((n) => nav.nodes[n].uid), [1, 10, 11, 4], 'crawlers go over (the climb is not charged)');
  assert.equal(nav.path(i(1), i(10)), null, 'no path for a walker onto the ceiling');
  // nearest(): floor queries never return ceiling nodes, ceiling queries only ceiling nodes.
  assert.equal(nav.nodes[nav.nearest(0, 3.9, 0, null)].uid, 1);
  assert.equal(nav.nodes[nav.nearest(0, 3.9, 0, null, 6, 0, 'ceiling')].uid, 10);
  // Transition point between the node areas (radius 1 each here, 0 apart horizontally).
  const tp = nav.transitionPoint(i(10), i(1));
  assert.deepEqual([tp.x, tp.z], [0, 0]);
  assert.equal(nav.hasCeiling, true);
});

test('nav: transition point lies between the two node areas', () => {
  const nav = new NavGraph(nodes([[1, 0, 0, 0, [2], 0], [2, 3, 4, 0, [], 1]]));
  // radius = max(0.5, scale 2 x 0.5) = 1: areas [-1, 1] and [2, 4] along x do not overlap.
  const p = nav.transitionPoint(nav.byUid.get(2)!, nav.byUid.get(1)!);
  assert.ok(Math.abs(p.x - 1.5) < 1e-9 && Math.abs(p.z) < 1e-9, `${p.x}`);
});

test('variants: p1 condition bits and p0 ancestors [verified 0x10101380]', () => {
  const v = (conds: number[], under: number[] = []) => ({ cls: 'MovementAnimBehavior', conds, under });
  assert.equal(variantMatches(v([]), 0), true);
  assert.equal(variantMatches(v([0]), condBits({ ceiling: true })), true);
  assert.equal(variantMatches(v([0]), condBits({ close: true })), false);
  assert.equal(variantMatches(v([1, 2]), condBits({ close: true })), false);
  assert.equal(variantMatches(v([1, 2]), condBits({ close: true, headless: true })), true);
  assert.equal(variantMatches(v([0], [66]), condBits({ ceiling: true })), false, 'needs a FleeBehavior above it');
  assert.equal(variantMatches(v([0], [66]), condBits({ ceiling: true }), [66]), true);
  assert.deepEqual([COND.ceiling, COND.close, COND.headless], [0, 1, 2]);
  const def = v([]);
  const list = [v([1]), v([1, 2]), v([0])];
  assert.equal(pickVariant(list, 'MovementAnimBehavior', condBits({ close: true, headless: true }), def), list[1], 'the most specific match');
  assert.equal(pickVariant(list, 'MovementAnimBehavior', 0, def), def, 'none: the slot template');
});

// ---------------------------------------------------------------------------------------
// Retail data

let pk: Map<number, EntityPackage> | undefined;
function pkgs() {
  if (pk) return pk;
  pk = new Map();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), adu: ld(`${base}.adu`) } as EntityPackage);
  }
  return pk;
}
const tplValues = (r: ResRef) => {
  const t = readObjectTemplate(pkgs(), r)!;
  const c = classByHash(t.classHash)!;
  return { v: decodeTemplateProps(c, t), types: c.types };
};

test('CartWheeler 10:24: transitions, ceiling attack, leap and the flashlight [verified slots, data]', { skip }, () => {
  const { v, types } = tplValues({ pkg: 10, id: 24 });
  const p = cartWheelerParams(pkgs(), v, types);
  assert.equal(p.startOnCeiling, false);
  const t = p.transition;
  assert.deepEqual([t.letGo, t.fall, t.land, t.launch, t.rise, t.grab].map(key), ['10:30', '10:29', '10:28', '10:98', '10:100', '10:99']);
  assert.deepEqual([t.upSpeed, t.gravity, t.downSpeed, t.hold], [15, 1, 0, 0]);
  // Ceiling melee p179 -> Attack 10:143: clip 10:8, 0..1.2 m, 4 m of height, x1.5 on the blades.
  assert.equal(p.ceilingAttacks.length, 1);
  const c = p.ceilingAttacks[0];
  assert.deepEqual([key(c.clip), c.minReach, Math.round(c.reach * 100) / 100, c.maxDy, c.scaled], ['10:8', 0, 1.2, 4, true]);
  assert.equal(c.damage, ((7 + 6) / 2) * 1.5, 'blade Melee Weapon 10:1771 p68..p69 mean x Attack p6');
  // JumpAttack p181 (10:139): launch 10:960 (clip 10:883, 3..6 m), stick 10:1292 (clip 10:87).
  const j = p.jump!;
  assert.deepEqual([key(j.launch?.clip), j.launch?.minReach, j.launch?.reach, key(j.stick?.clip), key(j.missed), key(j.recover)], ['10:883', 3, 6, '10:87', '10:880', '10:880']);
  assert.deepEqual([j.approach, j.cone, j.height.map((x) => Math.round(x * 10) / 10)], [2, 0, [-0.5, 0.7]]);
  // KillMelee p182 (10:141): attack pause, leap test, close stance, flashlight.
  const k = p.killMelee(0);
  assert.equal(key(k.ref), '10:141');
  assert.deepEqual(k.attackPause.map((x) => Math.round(x * 100) / 100), [0.1, 0.5]);
  assert.deepEqual([k.jumpChance, k.jumpBand, k.jumpCone, k.jumpWait, Math.round(k.jumpRecheck * 100) / 100], [70, [4, 6.5], 30, 4, 0.15]);
  assert.deepEqual([k.closeIn, k.closeOut], [5, 7]);
  assert.deepEqual([Math.round(k.lightFlee * 10) / 10, k.lightChance, k.lightWait], [0.4, 100, [1.5, 3]]);
  assert.deepEqual(k.alertClips.map(key), ['10:1056']);
  assert.deepEqual([p.fleeClips.map(key), p.fleeSounds], [['10:1237'], ['10:457']]);
  // Hit on a ceiling (p175) / killed there (p177).
  assert.deepEqual(p.ceilingHit.map(key), ['10:451']);
  assert.deepEqual([p.ceilingDeath?.clips.map(key), key(p.ceilingDeath?.fall), key(p.ceilingDeath?.land)], [['10:93'], '10:94', '10:95']);
  assert.equal(CW_SLOT.startOnCeiling, 180);
});

test('CartWheeler variants: ceiling, close stance and headless switch gait and KillMelee [verified 0x10101380, data]', { skip }, () => {
  const { v, types } = tplValues({ pkg: 10, id: 24 });
  const p = cartWheelerParams(pkgs(), v, types);
  const gait = (bits: number) => {
    const g = p.gait(bits)!;
    return [g.idle, g.walk, g.run, g.turnLeft, g.turnRight].map(key).join(' ');
  };
  assert.equal(gait(0), '10:1 10:668 10:875 10:4 10:5', 'p92 10:82: the floor gait');
  assert.equal(gait(condBits({ ceiling: true })), '10:31 10:13 10:9 10:91 10:92', '10:134 (p1 [0]): hanging under the ceiling');
  assert.equal(gait(condBits({ close: true })), '10:1 10:6 10:6 10:4 10:5', '10:36 (p1 [1]): the close stance');
  assert.equal(gait(condBits({ close: true, headless: true })), '10:1 10:875 10:875 10:4 10:5', '10:1420 (p1 [1, 2])');
  assert.equal(key(p.gait(condBits({ ceiling: true, headless: true }))!.ref), '10:1432', 'p1 [0, 2]');
  // KillMelee: on a ceiling 10:1880 (1..1.3 s between attacks), headless 10:1418 (0.1..0.3 s, no flight from the light).
  const ceil = p.killMelee(condBits({ ceiling: true }));
  assert.equal(key(ceil.ref), '10:1880');
  assert.deepEqual(ceil.attackPause.map((x) => Math.round(x * 10) / 10), [1, 1.3]);
  const off = p.killMelee(condBits({ headless: true }));
  assert.equal(key(off.ref), '10:1418');
  assert.deepEqual([off.attackPause.map((x) => Math.round(x * 10) / 10), off.lightChance], [[0.1, 0.3], 0]);
});

let levels: Map<string, Entity[]> | undefined;
function level(l: string) {
  levels ??= new Map();
  if (!levels.has(l)) levels.set(l, parseEntities(readSrsc(`LEVELS/1 PrisonDeathRow/${l} PrisonDeathRow.lvl`), pkgs()));
  return levels.get(l)!;
}

test('1a: ceiling Move Nodes, transition edges and the Slayer that starts on the ceiling [data]', { skip }, () => {
  const ents = level('1a');
  const nav = new NavGraph(ents);
  const ceil = nav.nodes.filter((n) => n.ceiling);
  assert.equal(ceil.length, 41, 'template 10:128 (p0 = 1)');
  let up = 0, down = 0;
  for (let a = 0; a < nav.nodes.length; a++)
    for (const b of nav.nodes[a].edges) {
      const t = nav.edgeType(a, b);
      if (t === EDGE.up) up++;
      if (t === EDGE.down) down++;
    }
  assert.ok(up > 10 && up === down, `${up} up / ${down} down transition edges`);
  // Ceiling nodes hang 4..13 m over the floor nodes they link to.
  for (const n of ceil)
    for (const b of n.edges) if (!nav.nodes[b].ceiling) assert.ok(n.y - nav.nodes[b].y > 3.5, `#${n.uid.toString(16)} over #${nav.nodes[b].uid.toString(16)}`);
  // #64f8 (p180 = 1): on the ceiling from the start, hanging in its DormantBehavior 10:155 (10:31).
  const e = ents.find((x) => x.uid === 0x64f8)!;
  const { types } = tplValues(e.template);
  const p = cartWheelerParams(pkgs(), e.values, types);
  assert.equal(p.startOnCeiling, true);
  assert.equal(ents.filter((x) => x.className === 'CartWheeler' && x.values[180] === 1).length, 1);
  // Its KillMelee is an instance override; the other overrides of 1a too.
  const kms = new Set(ents.filter((x) => x.className === 'CartWheeler').map((x) => key(x.values[CW_SLOT.killMelee] as ResRef)));
  assert.deepEqual([...kms].sort(), ['10:141', '10:159', '10:647', '10:832']);
  // 10:832 never leaps (p13 0); 10:159 never takes the close stance (p18 = p19 = 100).
  const q = cartWheelerParams(pkgs(), ents.find((x) => x.uid === 0x64f6)!.values, types).killMelee(0);
  assert.equal(q.jumpChance, 0);
});
