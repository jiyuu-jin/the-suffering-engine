// 1a's guard 609e: the escort to the electrified door and his death there (docs/playthrough.md,
// docs/game-logic.md §15.5 / §17.3). The death picker by blow angle (Character death 0x100e5d00),
// the scene's chain from the guard's Waypoint 752d, the door the ambush CartWheeler 64f1 opens,
// and the level logic the escort waits for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntities, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader, toOutputSpace } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { BehaviorLibrary, CHAR, templateList } from '../src/game/actors/behaviors';
import { deathAngle, deathPick, goalOnEdge } from '../src/game/actors/actor';
import { nodeFS, readSrsc, skip } from './helpers';

async function level1a() {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
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

const num = (v: unknown) => (typeof v === 'number' ? v : NaN);

test('death picker: the blow angle against the body +Z axis, the first DeathBehavior whose p4 is above it', () => {
  // No attacker in the damage record (a Damage Action Object): the zero vector, 90 degrees.
  assert.equal(deathAngle(0, 1), 90);
  assert.equal(deathAngle(1.3, 1), 90);
  // A guard's list: 10:250 (p4 90), 10:22 (p4 270).
  const guard = [90, 270];
  assert.equal(deathPick(guard, 90), 1, 'exactly 90 is not below 90: the second entry');
  // Facing -z (yaw 0, his back +z): shot from in front, the blow travels along +z -> 0 degrees.
  assert.equal(deathPick(guard, deathAngle(0, 1, { x: 0, y: 0, z: 1 })), 0);
  // Shot from behind: 180 degrees.
  assert.equal(Math.round(deathAngle(0, 1, { x: 0, y: 0, z: -1 })), 180);
  assert.equal(deathPick(guard, deathAngle(0, 1, { x: 0, y: 0, z: -1 })), 1);
  // Attacker on top of him: a zero direction counts as straight down (90).
  assert.equal(deathAngle(0, 1, { x: 0, y: 0, z: 0 }), 90);
  // A scaled body (1.1) hit straight from in front: acos past 1 is NaN, no entry matches: the first.
  assert.ok(Number.isNaN(deathAngle(0, 1.1, { x: 0, y: 0, z: 1 })));
  assert.equal(deathPick(guard, NaN), 0);
  assert.equal(deathPick([], 45), 0);
});

test('1a guard 609e: p72 is 10:250 (p4 90) then 10:22 (p4 270, clip 10:156); the electrified door kills him with no attacker', { skip }, async () => {
  const { packages, byUid } = await level1a();
  const lib = new BehaviorLibrary(packages, byUid);
  const guard = byUid.get(0x609e)!;
  const deaths = templateList(guard.values, CHAR.deaths).map((r) => lib.fromTemplate(r));
  assert.deepEqual(
    deaths.map((d) => (d?.kind === 'death' ? [d.angle, d.clips.map((c) => `${c.pkg}:${c.id}`)] : null)),
    [
      [90, ['10:301', '10:1470']],
      [270, ['10:156']],
    ],
  );
  const angles = deaths.map((d) => (d?.kind === 'death' ? (d.angle ?? 360) : 360));
  assert.equal(deathPick(angles, deathAngle(0, 1)), 1, 'a Damage Action Object kill plays 10:22');
  // The chain: Waypoint 752d (p0 On) -> Relay 8a1b (once) -> Timer 81d5 (0.1 s) -> Damage
  // Action Objects 75dd (0 damage, Electric Arc Effect 3:2898) and 8185 (200, 3:2941) on him.
  const wp = byUid.get(0x752d)!;
  assert.equal(wp.values[0], 1);
  assert.ok(wp.links.includes(0x8a1b) && wp.links.includes(0x75de));
  assert.deepEqual(byUid.get(0x8a1b)!.links, [0x7619, 0x81d5]);
  const timer = byUid.get(0x81d5)!;
  assert.ok(Math.abs(num(timer.values[2]) - 0.1) < 1e-6);
  assert.deepEqual(timer.links, [0x75dd, 0x8185]);
  for (const [u, dmg] of [[0x75dd, 0], [0x8185, 200]] as const) {
    const d = byUid.get(u)!;
    assert.equal(num(d.values[4]), dmg);
    assert.equal(num(d.values[3]), 0, 'all at once, not per second');
    assert.deepEqual(d.links, [0x609e]);
  }
  // Horace's line: Relay 75de -> Timer 5bd2 (0.1 s) -> Relay 7a77 -> Timer 8a1c (0.25 s) ->
  // Speech Player 8b33, one of four lines (12:351..12:354) said by Horace 7a47.
  assert.deepEqual(byUid.get(0x75de)!.links, [0x5bd2]);
  assert.ok(byUid.get(0x5bd2)!.links.includes(0x7a77) && byUid.get(0x5bd2)!.links.includes(0x7619));
  assert.deepEqual(byUid.get(0x7a77)!.links, [0x8a1c]);
  assert.ok(Math.abs(num(byUid.get(0x8a1c)!.values[2]) - 0.25) < 1e-6);
  const sp = byUid.get(0x8b33)!;
  assert.deepEqual(sp.links, [0x7a47]);
  assert.equal((sp.values[5] as unknown[]).length, 4);
});

test('1a ambush CartWheeler 64f1: its Waypoint 8025 lies in door 4e48, on the Move Node edge 71b5 -> 71b4', { skip }, async () => {
  const { byUid } = await level1a();
  const at = (u: number) => {
    const [x, , z] = toOutputSpace(byUid.get(u)!.position);
    return { x, z };
  };
  const wp = at(0x8025), door = at(0x4e48), near = at(0x71b5), far = at(0x71b4);
  assert.ok(Math.abs(wp.x - door.x) < 0.2, 'the waypoint is in the doorway');
  // Its nearest node is the walker's own (71b5): the path crosses no door edge.
  assert.ok(Math.hypot(wp.x - near.x, wp.z - near.z) < Math.hypot(wp.x - far.x, wp.z - far.z));
  assert.equal(goalOnEdge(near, far, wp), true);
  // A goal on the walker's side of the edge is not behind the door.
  assert.equal(goalOnEdge(near, far, { x: near.x - 0.3, z: near.z }), false);
  assert.equal(goalOnEdge(near, far, { x: wp.x, z: wp.z + 1.5 }), false, 'off the edge');
  // The ambush: Count Down 73a5 (2) <- 64ee / 64f1; its zero starts the guard's walk to the door
  // controls (Timer 7532 -> Behavior Changer 7527 -> SimpleConversation 7528).
  assert.equal(byUid.get(0x73a5)!.values[0], 2);
  assert.ok(byUid.get(0x64f1)!.links.includes(0x73a5) && byUid.get(0x64ee)!.links.includes(0x73a5));
  assert.deepEqual(byUid.get(0x73a5)!.links, [0x7532]);
  assert.ok(byUid.get(0x7532)!.links.includes(0x7527));
  assert.equal(byUid.get(0x8027)!.values[2], 0x8025);
});

test('1a escort: the chatter 7520 ends only through Detector 7523, which taking the flashlight 6978 enables', { skip }, async () => {
  const { packages, byUid } = await level1a();
  const lib = new BehaviorLibrary(packages, byUid);
  const chat = lib.fromPlaced(0x7520);
  assert.ok(chat?.kind === 'talk' && chat.ambient.length === 4, 'repeating lines: it never completes');
  assert.equal(byUid.get(0x7523)!.values[0], 0, 'Detector 7523 starts disabled');
  assert.ok(byUid.get(0x6978)!.links.includes(0x8aba), 'the flashlight enables it (Relay 8aba)');
  assert.ok(byUid.get(0x8aba)!.links.includes(0x7523));
  assert.ok(byUid.get(0x7523)!.links.includes(0x8ab9));
  assert.ok(byUid.get(0x8ab9)!.links.includes(0x837d) && byUid.get(0x837d)!.links.includes(0x7521));
  const bc = byUid.get(0x7521)!;
  assert.equal(bc.values[6], 0x7522);
});
