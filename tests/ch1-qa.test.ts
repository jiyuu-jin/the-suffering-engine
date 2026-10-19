// Chapter 1 playthrough findings (docs/playthrough.md rows 51-55): ladder edges only for
// characters with a LadderClimbBehavior, the Waypoint p4 / p5 blend to the Waypoint's placement
// before a WaypointBehavior goes on, and STOMP attach links kept after a sequence (1a's Dumbell).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntities, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader, toOutputSpace } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { ladderEdgeOpen, NavGraph } from '../src/game/actors/nav';
import { placementYaw, waypointSlerp, waypointTurn } from '../src/game/actors/actor';
import { decodeStompSequence, QDU_SEQUENCE } from '../src/game/world/stomp';
import { nodeFS, readSrsc, skip } from './helpers';

async function level(path: string) {
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const ents = parseEntities(lvl, packages);
  return { ents, byUid: new Map<number, Entity>(ents.map((e) => [e.uid, e])) };
}

test('ladder edges: climbers only, locked ladders shut, Ladder p34 one way', () => {
  const o = { climber: true, unlocked: true, oneWay: 0, forward: true };
  assert.equal(ladderEdgeOpen(o), true);
  assert.equal(ladderEdgeOpen({ ...o, forward: false }), true);
  assert.equal(ladderEdgeOpen({ ...o, climber: false }), false, 'no LadderClimbBehavior (p102)');
  assert.equal(ladderEdgeOpen({ ...o, unlocked: false }), false);
  // p34 = 1: nodeA -> nodeB closed; 2: nodeB -> nodeA closed.
  assert.deepEqual([ladderEdgeOpen({ ...o, oneWay: 1 }), ladderEdgeOpen({ ...o, oneWay: 1, forward: false })], [false, true]);
  assert.deepEqual([ladderEdgeOpen({ ...o, oneWay: 2 }), ladderEdgeOpen({ ...o, oneWay: 2, forward: false })], [true, false]);
});

test('1c: CartWheelers get no path over Ladder 7c2f, the companion does', { skip }, async () => {
  const { ents, byUid } = await level('LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl');
  const ep = byUid.get(0x7e4f)!;
  // Edge Passage p0 = 0: the passage is a Ladder (1 = a door).
  assert.deepEqual([ep.values[0], ep.values[1]], [0, 0x7c2f]);
  assert.equal(byUid.get(0x7c2f)!.values[34], 0, 'both ways');
  // Character p102: the companion's LadderClimbBehavior 10:811; the CartWheelers have none.
  const p102 = (u: number) => byUid.get(u)!.values[102] as { pkg: number; id: number } | null;
  assert.deepEqual(p102(0x7569), { pkg: 10, id: 811 });
  for (const u of [0x7e20, 0x7e21, 0x7e16, 0x7e1a, 0x8015, 0x8016]) assert.equal(p102(u), null, u.toString(16));
  const nav = new NavGraph(ents);
  const foot = nav.byUid.get(ep.values[3] as number)!, top = nav.byUid.get(ep.values[2] as number)!;
  const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const ladder = key(foot, top);
  const blocked = (climber: boolean) => (a: number, b: number) => key(a, b) === ladder && !ladderEdgeOpen({ climber, unlocked: true, oneWay: 0, forward: a === top });
  const usesLadder = (p: number[] | null) => !!p && p.some((n, i) => i > 0 && key(p[i - 1], n) === ladder);
  assert.ok(usesLadder(nav.path(foot, top, blocked(true))), 'the companion climbs');
  const cw = nav.path(foot, top, blocked(false));
  assert.ok(!usesLadder(cw), 'a CartWheeler never paths over the ladder');
});

test('Waypoint p4 / p5: blend to the placement over p5 s, the shortest way round', () => {
  assert.equal(waypointTurn([0, 1, 2, 1, 0, 0.2, 0]), undefined, 'p4 = 0: no turn');
  assert.deepEqual(waypointTurn([0, 1, 2, 1, 1, 0.2, 0]), { time: 0.2 });
  const a = { x: 0, z: 0, yaw: 3 }, b = { x: 1, z: -2, yaw: -3 };
  const mid = waypointSlerp(a, b, 0.5);
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.z + 1) < 1e-9);
  // 3 -> -3 rad goes through pi (0.28 rad), not through 0.
  assert.ok(Math.abs(Math.cos(mid.yaw) - Math.cos(Math.PI)) < 0.01);
  const end = waypointSlerp(a, b, 1);
  assert.ok(Math.abs(Math.atan2(Math.sin(end.yaw - b.yaw), Math.cos(end.yaw - b.yaw))) < 1e-9);
});

test('1c: Waypoints 7e22 / 7e26 face the CartWheelers over the fence into the east yard', { skip }, async () => {
  const { ents, byUid } = await level('LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl');
  const nav = new NavGraph(ents);
  // Behind the fence (the mound side) and the yard side of it: separate parts of the graph.
  const behind = nav.byUid.get(0x7dde)!, yard = nav.byUid.get(0x7dd5)!;
  assert.equal(nav.path(behind, yard), null);
  for (const u of [0x7e22, 0x7e26]) {
    const wp = byUid.get(u)!;
    assert.ok(Math.abs((waypointTurn(wp.values)?.time ?? 0) - 0.2) < 1e-6, u.toString(16));
    const [x, , z] = toOutputSpace(wp.position);
    const yaw = placementYaw(wp.rotation);
    // The JumpBehavior's launch clip (10:1310) carries the body 4.9 m forward (-Z) at scale 1.2.
    const lx = x - Math.sin(yaw) * 4.9, lz = z - Math.cos(yaw) * 4.9;
    // The node nearest the landing spot belongs to the yard's part of the graph.
    let best = -1;
    for (let i = 0; i < nav.nodes.length; i++) {
      const n = nav.nodes[i];
      if (n.ceiling || Math.abs(n.y - 79.1) > 1.5) continue;
      if (best < 0 || Math.hypot(lx - n.x, lz - n.z) < Math.hypot(lx - nav.nodes[best].x, lz - nav.nodes[best].z)) best = i;
    }
    assert.ok(nav.path(best, yard) && !nav.path(best, behind), `${u.toString(16)}: lands on the yard side (${lx.toFixed(1)}, ${lz.toFixed(1)}), node ${nav.nodes[best].uid.toString(16)}`);
  }
});

test('1a "Goose": the Dumbell stays in Goose\'s hand after the intro (attach never cleared)', { skip }, () => {
  const q = readSrsc('LEVELS/1 PrisonDeathRow/1 PrisonDeathRow.qdu');
  const e = q.entries.find((x) => x.type === QDU_SEQUENCE && x.id === 284)!;
  const seq = decodeStompSequence(q.data(e), 284);
  const goose = seq.tracks.find((t) => t.uid === 0x75a7)!;
  const dumbell = seq.tracks.find((t) => t.uid === 0x7b16)!;
  const keys = goose.attaches.filter((k) => k.hardpoint === 19);
  assert.deepEqual(keys.map((k) => [k.track, +k.time.toFixed(2)]), [[dumbell.index, 40.15]], 'attached once, never cleared');
  // Its one transform key (on the cell floor) comes while it is attached: the bone overwrites it.
  assert.deepEqual(dumbell.transforms.map((k) => +k.time.toFixed(2)), [150.12]);
  // Goose ends at the off-map staging area, the Dumbell with him; neither track is removed.
  const last = goose.transforms.at(-1)!;
  assert.ok(last.position[0] / 2048 < 300 && last.time > 216);
  assert.equal((goose.flags | dumbell.flags) & 0x08, 0);
});
