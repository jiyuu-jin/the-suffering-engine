// FleeBehavior and Flee Positions as decoded from Suffering.rfl (src/game/actors/flee.ts,
// docs/game-logic.md §15.14): the spot scoring, its rule-outs, the groups of linked spots, and
// the 1c companion's FleeBehavior 7e38 in the yard where the port used to send him under the
// wall CartWheelers (docs/playthrough.md, the 1c inmate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classByHash, decodeTemplateProps, parseEntities, readObjectTemplate, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader, toOutputSpace } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { BehaviorLibrary } from '../src/game/actors/behaviors';
import { NavGraph, NO_NAV_TYPE } from '../src/game/actors/nav';
import { chooseFleeSpot, fleeGroups, fleeParams, fleeScore, recentHits, FLEE_FAIL_TIME, type FleeChoice, type FleeSpot } from '../src/game/actors/flee';
import { nodeFS, readSrsc, skip } from './helpers';

// FleeBehavior 7e38's values (template 10:341, p22 = 1).
const P = fleeParams([[], [], 0, 0, 3, 5, 5, 0, -1, -1, 0, 5, 2, 0, null, 0, 0.4, 0.8, 3, 5, 5, 10, 1, 1, 1, 0.5, 1, 0, 0.25, 0, 0, 40, 20, 8, 0, 0, 0, 15, 0, 0, 0, 0.5, [{ pkg: 10, id: 119 }], [], [{ pkg: 10, id: 212 }, { pkg: 2, id: 384 }]]);
const spot = (uid: number, x: number, z: number, group = 0): FleeSpot => ({ uid, x, y: 0, z, group, maxDy: -1, failedAt: -Infinity });
const choice = (o: Partial<FleeChoice>): FleeChoice => ({ me: { x: 0, y: 0, z: 0 }, threats: [], allies: [], spots: [], group: -1, stay: -1, current: -1, time: 100, ...o });

test('flee params: 7e38 reads as decoded', () => {
  assert.deepEqual(
    [P.doneWhenSafe, P.runs, P.repickMin, P.repickMax, P.hitCount, P.hitWindow, P.hitMin, P.bigHitPercent, P.keepGroup, P.maxDist, P.radius, P.tooClose],
    [false, 0, 0.4, 0.8, 3, 5, 5, 10, true, 40, 20, 8],
  );
  assert.deepEqual([P.wThreatFar, P.wAllyNear, P.wNear, P.wAway, P.wStay, P.wCurrent], [1, 1, 0.5, 1, 0.25, 0]);
  assert.deepEqual([P.threatTeams, P.allyTeams], [['10:119'], ['10:212', '2:384']]);
});

test('flee score: a threat within p33 rules a spot out, farther threats count by distance', () => {
  const s = spot(1, 10, 0);
  assert.equal(fleeScore(P, choice({ threats: [{ x: 10, y: 0, z: 7 }] }), s), null, '7 m from the spot');
  const none = fleeScore(P, choice({}), s)!;
  const far = fleeScore(P, choice({ threats: [{ x: 10, y: 0, z: 18 }] }), s)!;
  // No threat: threat term 1; one at 18 m: 18 / 20.
  assert.ok(Math.abs(none - far - (1 - 18 / 20)) < 1e-9);
  // Beyond p32 it does not count at all.
  assert.equal(fleeScore(P, choice({ threats: [{ x: 10, y: 0, z: 25 }] }), s), none);
});

test('flee score: running at a threat scores low, allies pull', () => {
  const ahead = spot(1, 30, 0), aside = spot(2, 0, 30);
  // A threat 12 m off along +x, nearer than either spot and on the way to the first one.
  const c = choice({ threats: [{ x: 12, y: 0, z: 0 }], spots: [ahead, aside] });
  assert.ok(fleeScore(P, c, aside)! > fleeScore(P, c, ahead)! + 1);
  assert.equal(chooseFleeSpot(P, c), 2);
  // No threat: the spot by the player (an ally) beats a nearer one.
  const a = spot(1, 10, 0), b = spot(2, 0, 8);
  assert.equal(chooseFleeSpot(P, choice({ spots: [a, b] })), 2);
  assert.equal(chooseFleeSpot(P, choice({ spots: [a, b], allies: [{ x: 10, y: 0, z: 2 }] })), 1);
});

test('flee score: farther than p31, other group, failed recently, standing bonus', () => {
  assert.equal(fleeScore(P, choice({}), spot(1, 41, 0)), null);
  assert.equal(fleeScore(P, choice({ group: 3 }), spot(1, 5, 0, 2)), null);
  const failed = { ...spot(1, 5, 0), failedAt: 100 - FLEE_FAIL_TIME + 1 };
  assert.equal(fleeScore(P, choice({}), failed), null);
  assert.notEqual(fleeScore(P, choice({}), { ...failed, failedAt: 100 - FLEE_FAIL_TIME }), null);
  const a = spot(1, 10, 0), b = spot(2, 0, 9.5);
  assert.equal(chooseFleeSpot(P, choice({ spots: [a, b] })), 2, 'nearer');
  assert.equal(chooseFleeSpot(P, choice({ spots: [a, b], stay: 1 })), 1, 'p28 for the spot stood on');
  // Height limit p0.
  assert.equal(fleeScore(P, choice({}), { ...spot(1, 5, 0), y: 3, maxDy: 2 }), null);
});

test('flee hits: p18 hits of p20+ within p19 s, one instant counted once', () => {
  const hits = [
    { t: 1, amount: 9 },
    { t: 7, amount: 4 },
    { t: 8, amount: 9 },
    { t: 8, amount: 9 },
    { t: 9, amount: 15 },
  ];
  assert.equal(recentHits(hits, 10, 5, 5), 2);
  assert.equal(recentHits(hits, 10, 10, 5), 3);
});

test('flee groups: linked Flee Positions form a group whichever way the links go', () => {
  const g = fleeGroups([
    { uid: 1, links: [] },
    { uid: 2, links: [1, 3] },
    { uid: 3, links: [] },
    { uid: 4, links: [5] },
    { uid: 5, links: [] },
    { uid: 6, links: [] },
  ]);
  assert.equal(g.get(1), g.get(3));
  assert.equal(g.get(2), g.get(1));
  assert.equal(g.get(4), g.get(5));
  assert.notEqual(g.get(4), g.get(1));
  assert.equal(g.get(6), -1, 'linked to none: no group');
});

test('1c: the companion flees away from the yard CartWheelers, towards the player', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const ents = parseEntities(lvl, packages);
  const byUid = new Map<number, Entity>(ents.map((e) => [e.uid, e]));
  const lib = new BehaviorLibrary(packages, byUid);
  const b = lib.fromPlaced(0x7e38);
  assert.equal(b?.kind, 'flee');
  if (b?.kind !== 'flee') return;
  const p = b.flee;
  assert.deepEqual([p.keepGroup, p.radius, p.tooClose, p.threatTeams.includes('10:119'), p.allyTeams.includes('2:384')], [true, 20, 8, true, true]);
  const fe = ents.filter((e) => e.className === 'Flee Position');
  const groups = fleeGroups(fe);
  const spots: FleeSpot[] = fe.map((e) => {
    const [x, y, z] = toOutputSpace(e.position);
    return { uid: e.uid, x, y, z, group: groups.get(e.uid)!, maxDy: -1, failedAt: -Infinity };
  });
  const yard = [0x7e39, 0x7e3b, 0x7e3c, 0x7e3d].map((u) => groups.get(u));
  assert.ok(yard.every((g) => g === yard[0]), 'the first yard group');
  assert.notEqual(groups.get(0x7e41), yard[0]);
  const pos = (u: number) => {
    const [x, y, z] = toOutputSpace(byUid.get(u)!.position);
    return { x, y, z };
  };
  const s = (u: number) => spots.find((q) => q.uid === u)!;
  // At the yard gate (where his WaypointBehavior 757f ends), the player beside him and the wall
  // CartWheelers still up: the old port rule (farthest from the player) took 7e3c, right under
  // 6520 / 6517.
  const me = { x: 438.4, y: s(0x7e3c).y, z: 411.7 };
  const player = { x: 437, y: me.y, z: 409 };
  const wall = [0x6520, 0x6517, 0x6516].map(pos);
  const first = chooseFleeSpot(p, { me, threats: wall, allies: [player], spots, group: -1, stay: -1, current: -1, time: 0 });
  assert.notEqual(first, 0x7e3c);
  assert.equal(spots.find((q) => q.uid === first)!.group, yard[0]);
  // 6520 down in the yard at (448, 447): 7e3c (448, 450) is ruled out, 7e3b too; he keeps away.
  const down = { x: 448, y: me.y, z: 447 };
  const c2 = { me: { ...s(0x7e3c) }, threats: [down], allies: [player], spots, group: yard[0]!, stay: 0x7e3c, current: -1, time: 0 };
  assert.equal(fleeScore(p, c2, s(0x7e3c)), null);
  // The east yard (7e40..7e44): the companion (NPC Exclusion Type 10:674 = bit 5) may not use
  // Move Nodes 7ee1 / 7ee2 (p3 = 0) and only he may use 7b71 / 7b72 (p3 = 1), whose edge is off
  // until Count Down 7b95 (the first group dead) turns EdgeToggler 7ee3 on.
  const nav = new NavGraph(ents, (r) => (r.pkg === 10 && r.id === 674 ? 5 : undefined));
  const n = (u: number) => nav.nodes[nav.byUid.get(u)!];
  assert.deepEqual([n(0x7ee1).types, !!n(0x7ee1).only, n(0x7b71).types, !!n(0x7b71).only], [32, false, 32, true]);
  assert.ok(nav.setEdge(0x7b71, 0x7b72, false));
  const node = (q: { x: number; y: number; z: number }) => nav.nearest(q.x, q.y, q.z, null);
  for (const q of spots) q.node = node(q);
  const from = node(me);
  const walk = (q: FleeSpot, navType: number) => !!nav.path(from, q.node!, undefined, { navType });
  assert.ok(walk(s(0x7e3c), 5));
  assert.ok(!walk(s(0x7e42), 5), 'the companion cannot reach the east yard yet');
  assert.ok(walk(s(0x7e42), NO_NAV_TYPE), 'creatures can');
  const inYard = { ...c2, group: -1, me, reachable: (q: FleeSpot) => walk(q, 5) };
  assert.equal(spots.find((q) => q.uid === chooseFleeSpot(p, inYard))!.group, yard[0]);
  assert.ok(nav.setEdge(0x7b71, 0x7b72, true));
  assert.ok(walk(s(0x7e42), 5), 'his way opens with the first group dead');
  const next = chooseFleeSpot(p, c2);
  assert.ok(next > 0 && next !== 0x7e3c, `ran to ${next.toString(16)}`);
  assert.ok(Math.hypot(s(next).x - down.x, s(next).z - down.z) >= 8);
});

test('1c: the companion climbs Ladder 7c2f to his last Waypoint (Edge Passage, LadderClimbBehavior)', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const ents = parseEntities(lvl, packages);
  const byUid = new Map<number, Entity>(ents.map((e) => [e.uid, e]));
  // Edge Passage 7e4f: Ladder 7c2f between Move Nodes 7b8a (foot) and 7c7f (top, 6.2 m up).
  const ep = byUid.get(0x7e4f)!;
  assert.deepEqual([ep.values[1], ep.values[2], ep.values[3]], [0x7c2f, 0x7c7f, 0x7b8a]);
  assert.equal(byUid.get(0x7c2f)!.className, 'Ladder');
  const nav = new NavGraph(ents);
  const foot = nav.byUid.get(0x7b8a)!, top = nav.byUid.get(0x7c7f)!;
  assert.ok(nav.nodes[foot].edges.includes(top));
  assert.ok(nav.nodes[top].y - nav.nodes[foot].y > 5);
  // His last Waypoint 7b8c (Relay 808c enables Level Transition 7813) is at the top.
  const [, wy] = toOutputSpace(byUid.get(0x7b8c)!.position);
  assert.ok(Math.abs(wy - nav.nodes[top].y) < 0.5);
  // The companion's LadderClimbBehavior (template p102 = 10:811): the player's rung clips.
  const t = readObjectTemplate(packages, { pkg: 10, id: 811 })!;
  const v = decodeTemplateProps(classByHash(t.classHash), t);
  assert.deepEqual([v[2], v[3], v[8], v[9]].map((r) => `${(r as { pkg: number }).pkg}:${(r as { id: number }).id}`), ['2:234', '2:243', '2:235', '2:244']);
});
