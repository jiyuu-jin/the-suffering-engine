// Where FindPath puts a MoveTo's target on the Move Node graph (docs/game-logic.md §15.5, "Where a
// point lies on the graph"): edge areas (both squares and the hull between them), the edge's
// NPC Exclusion Types, and the fallback to the nearest edge outline that ignores the walker's
// type. 6b's Waypoint 208d (Clem's walk 208c) is the one retail leg that locates only on an edge
// its walker may not use: the leg fails at once and his chain goes on. Data tests skip without
// game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classByHash, decodeTemplateProps, parseEntities, readObjectTemplate, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader, toOutputSpace } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { edgeHolds, navEdgePasses, NavGraph, NO_NAV_TYPE, type NavNode } from '../src/game/actors/nav';
import { nodeFS, readSrsc, skip } from './helpers';

const WORLD_SCALE = 2048;
const node = (x: number, z: number, size: number, extra: Partial<NavNode> = {}): NavNode => ({ uid: 0, x, y: 0, z, radius: size / 2, edges: [], ceiling: false, size, yaw: 0, ...extra });

test('nav: an edge holds its two squares and the hull between them, within 2 m of its plane', () => {
  const A = node(0, 0, 2), B = node(10, 0, 4);
  assert.ok(edgeHolds(A, B, 0.9, 0, 0.9), 'in A\'s square (half side 1 m, no walker radius taken off)');
  assert.ok(!edgeHolds(A, B, -1.2, 0, 0), 'behind A, outside the hull');
  assert.ok(edgeHolds(A, B, 5, 0, 1.4), 'in the strip: the hull widens from 1 m to 2 m');
  assert.ok(!edgeHolds(A, B, 5, 0, 1.8), 'outside the strip at its middle');
  assert.ok(edgeHolds(A, B, 10, 1.9, 1.9), 'B\'s square, 1.9 m over the edge');
  assert.ok(!edgeHolds(A, B, 10, 2.1, 0), 'more than 2 m off the edge\'s plane');
  // A turned square (yaw 45 degrees): its corner points along x.
  const R = node(0, 0, 2, { yaw: Math.PI / 4 });
  assert.ok(edgeHolds(R, B, -1.3, 0, 0) && !edgeHolds(A, B, -1.3, 0, 0));
});

test('nav: an edge\'s NPC Exclusion Types come from both nodes', () => {
  const free = node(0, 0, 2), bars5 = node(0, 0, 2, { types: 1 << 5 }), only5 = node(0, 0, 2, { types: 1 << 5, only: true });
  assert.ok(navEdgePasses(free, free, 5) && navEdgePasses(free, free, NO_NAV_TYPE));
  assert.ok(!navEdgePasses(free, bars5, 5), 'either node excluding bars the edge');
  assert.ok(navEdgePasses(free, bars5, 3));
  assert.ok(navEdgePasses(only5, free, 5) && !navEdgePasses(only5, free, 3) && !navEdgePasses(only5, free, NO_NAV_TYPE));
  assert.ok(!navEdgePasses(only5, bars5, 5), 'one only: its types less the other\'s excluded ones');
  assert.ok(navEdgePasses(only5, only5, 5) && !navEdgePasses(only5, only5, 4));
});

test('nav: locateEdge takes the first usable edge holding the point, else the nearest outline, barred or not', () => {
  // Two edges: 1 - 2 free, 3 - 4 kept from type 5 (template 10:674 -> bit 5).
  const bar = { pkg: 10, id: 674 };
  const ents = [
    [1, 0, 0, [2], null],
    [2, 10, 0, [], null],
    [3, 0, 20, [4], bar],
    [4, 10, 20, [], bar],
  ].map(([uid, x, z, links, p2]) => ({ uid, className: 'Move Node Object', position: [(x as number) * WORLD_SCALE, 0, (z as number) * WORLD_SCALE], rotation: [0, 0, 0], links, values: [0, [], p2 ? [p2] : [], 0, 0], props: {}, scale: [2, 2, 2] }) as unknown as Entity);
  const nav = new NavGraph(ents, (r) => (r.pkg === 10 && r.id === 674 ? 5 : undefined));
  const at = (u: number) => nav.nodes[nav.byUid.get(u)!];
  const uidsOf = (g: { a: number; b: number } | null) => (g ? [nav.nodes[g.a].uid, nav.nodes[g.b].uid].sort() : null);
  const p1 = at(1), p3 = at(3);
  const mid = (a: NavNode, b: NavNode, off: number) => [(a.x + b.x) / 2, 0, (a.z + b.z) / 2 + off] as const;
  // In the free edge's area.
  let g = nav.locateEdge(...mid(p1, at(2), 0), 5);
  assert.deepEqual([uidsOf(g), g?.held, g?.passes], [[1, 2], true, true]);
  // Off every area, nearer the barred edge: it is taken for type 5 too, and does not pass.
  const side = Math.sign(p3.z - p1.z);
  g = nav.locateEdge(...mid(p3, at(4), -side * 2), 5);
  assert.deepEqual([uidsOf(g), g?.held, g?.passes], [[3, 4], false, false]);
  // In the barred edge's area: for type 5 the nearest outline among the failed edges (still 3 - 4).
  g = nav.locateEdge(...mid(p3, at(4), 0), 5);
  assert.deepEqual([uidsOf(g), g?.passes], [[3, 4], false]);
  // A creature (no type) may use it.
  g = nav.locateEdge(...mid(p3, at(4), 0), NO_NAV_TYPE);
  assert.deepEqual([uidsOf(g), g?.held, g?.passes], [[3, 4], true, true]);
});

test('6b: Clem\'s Waypoint 208d locates only on 17f5-1872, an edge his type 10:674 may not use; a40 on a usable one', { skip }, async () => {
  const path = 'LEVELS/6 Woods/6b Woods.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const ents = parseEntities(lvl, packages);
  const byUid = new Map<number, Entity>(ents.map((e) => [e.uid, e]));
  const typeOf = (r: { pkg: number; id: number }) => {
    const t = readObjectTemplate(packages, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || c?.name !== 'NPC Exclusion Type') return undefined;
    const v = decodeTemplateProps(c, t);
    return typeof v[0] === 'number' ? v[0] : undefined;
  };
  const nav = new NavGraph(ents, typeOf);
  // Clem 49a: NPC Exclusion Type 10:674 (bit 5); WaypointBehavior 208c (p7 = 1: a path-mode
  // MoveTo) -> Waypoint 208d; Behavior Changer a45 hands it out.
  const clem = byUid.get(0x49a)!;
  assert.equal(typeOf(clem.values[45] as { pkg: number; id: number }), 5);
  const wb = byUid.get(0x208c)!;
  assert.equal(Number(wb.values[7]), 1);
  assert.equal(Number((wb.values[2] as number[])[0] ?? wb.values[2]), 0x208d);
  const pos = (u: number) => toOutputSpace(byUid.get(u)!.position) as [number, number, number];
  const g = nav.locateEdge(...pos(0x208d), 5)!;
  assert.deepEqual([[nav.nodes[g.a].uid, nav.nodes[g.b].uid].sort((a, b) => a - b), g.held, g.passes], [[0x17f5, 0x1872], false, false]);
  // The walk before it (a3f -> a40) ends on an edge he may use.
  const h = nav.locateEdge(...pos(0xa40), 5)!;
  assert.ok(h.held && h.passes, `a40 on ${nav.nodes[h.a].uid.toString(16)}-${nav.nodes[h.b].uid.toString(16)}`);
});
