// The 1a gas chamber (docs/game-logic.md §11.5 "Gas chamber"): the inmate's monologue (a
// SimpleConversationBehavior without a listener), the tank door (Mechanism motion timing) and
// the gas (Particle Fountain damage volumes). Synthetic checks run everywhere; the retail ones
// need the game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import type { Behavior, DialogLine } from '../src/game/actors/behaviors';
import type { CreatureKind } from '../src/game/actors/kinds';
import { parseEntities, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { mechMotion, mechStep } from '../src/game/world/props';
import { bodyTouches, FountainHazards, fountainDamage, fountainSwitch, leafSpheres, resistanceMultiplier, sphereTouchesBox, touches, volumeOf, type GasBox, type GasTarget, type HitSphere } from '../src/game/fx/gas';
import { readSkeletonTrailer } from '../src/formats/skeleton';
import { driveFloorY } from '../src/game/sequence/clips';
import { fountainStartsOn } from '../src/game/world/fx';
import { nodeFS, readSrsc, skip } from './helpers';

// ---------------------------------------------------------------------------------------------
// A speaker on a synthetic rig

function rig(): SkinnedModel {
  const bones = [-1, 0].map((parent, index) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, index * 0.5, 0, 1]);
    return { index, hash: 0x1000 + index, name: `b${index}`, parent, children: [] as number[], inverseBind: m, bindWorld: m, position: [0, index ? 0.5 : 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
  });
  bones[0].children.push(1);
  const skeleton: Skeleton = { version: 1, vertexCount: 0, bones, byHash: new Map(bones.map((b) => [b.hash, b.index])), sphere: { center: [0, 0, 0], radius: 1 }, skinIndex: new Uint16Array(), skinWeight: new Float32Array() };
  return {
    ref: { pkg: 0, id: 0 },
    animSet: 0,
    model: { ref: { pkg: 0, id: 0 }, vertexCount: 0, source: new Uint32Array(), positions: new Float32Array([0, 0, 0, 0, 1.8, 0]), normals: new Float32Array(), uvs: new Float32Array(), submeshes: [], materials: [] },
    skeleton,
    skinIndex: new Uint16Array(),
    skinWeight: new Float32Array(),
  } as unknown as SkinnedModel;
}

const IDLE_CLIP: AnimClipData = {
  id: 0,
  animSet: 0,
  duration: 1,
  flags: 0,
  blendTime: 0.2,
  rate: 1,
  links: [],
  tracks: [0, 1].map((b) => ({ boneHash: 0x1000 + b, format: 0xc0, times: new Float32Array([0, 1]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number] })),
};

function kind(): CreatureKind {
  const skinned = rig();
  return {
    key: 'test:npc', template: { pkg: 0, id: 0 }, className: 'Unspeakable NPC', skinned, proto: new Character(skinned, [IDLE_CLIP]),
    idle: 0, walk: -1, run: -1, attacks: [], hits: [], deaths: [], fall: -1, land: -1,
    events: [{ hitTimes: [], sounds: [] } as never], speeds: [0],
    height: 1.8, bottom: 0, anchored: true, radius: 0.4, moveSpeed: 1.5, runSpeed: 3, hostile: false, maxHealth: 100, decor: false,
  };
}

const LINE = (s: string): DialogLine => ({ anims: [], pause: 0, sounds: [s], message: 0 });

function talk(toPlayer: boolean, target = 0): Behavior {
  return {
    cls: 'SimpleConversationBehavior', next: [], kind: 'talk', toPlayer, target,
    lines: [LINE('12:104'), LINE('12:105')], ambient: [], gapMin: -1, gapMax: -1,
    startRange: 10, rangeHeight: 3, approach: false, nearDist: 5, nearHeight: 2, doneMessage: 1,
  } as Behavior;
}

function speaker(b: Behavior, playerAt: THREE.Vector3) {
  const said: string[] = [];
  const sent: [number, number][] = [];
  const entity = { uid: 0x71ec, links: [0x7545, 0x754e], values: [] } as unknown as Entity;
  const a = new Actor(kind(), { x: 420.4, y: 88.7, z: 454 }, 0, 1, entity, 0x71ec);
  const env: ActorEnv = {
    world: null as never, nav: null, player: { position: playerAt } as never, playerAlive: true, playerUid: 0x5818, time: 0, actors: [],
    damagePlayer: () => {}, damageActor: () => {}, sound: () => {}, onDeath: () => {},
    clip: () => -1, entity: () => undefined,
    send: (to, msg) => sent.push([to, msg]),
    say: (_a, line) => (said.push(line.sounds[0]), 1),
  };
  a.setBehavior(b, env);
  const run = (secs: number) => {
    for (let t = 0; t < secs; t += 1 / 30) {
      env.time += 1 / 30;
      a.update(1 / 30, env);
    }
  };
  return { said, sent, run };
}

test('SimpleConversation with no listener (p0 = 0, p1 = 0) talks at once, wherever the player is (0x10100600)', () => {
  // The 1a gas chamber inmate: Detector 7555 at the corridor junction, 36 m from his chair.
  const s = speaker(talk(false, 0), new THREE.Vector3(384, 88.7, 454));
  s.run(0.2);
  assert.deepEqual(s.said, ['12:104'], 'the first line starts at once');
  s.run(2);
  assert.deepEqual(s.said, ['12:104', '12:105']);
  s.run(1.5);
  // p21: the done message to his own links (the timers chaining the next Behavior Changer).
  assert.deepEqual(s.sent, [[0x7545, 1], [0x754e, 1]]);
});

test('SimpleConversation to the player still waits for him (p11 / p12, the port p9 range)', () => {
  const far = speaker(talk(true), new THREE.Vector3(384, 88.7, 454));
  far.run(1);
  assert.deepEqual(far.said, [], 'the player is 36 m away');
  const near = speaker(talk(true), new THREE.Vector3(423, 88.7, 455));
  near.run(0.2);
  assert.deepEqual(near.said, ['12:104']);
});

// ---------------------------------------------------------------------------------------------
// Mechanism motion (0x100c8fd0)

function travelTime(time: number, a: number, d: number, travel: number) {
  const m = mechMotion(time, a, d, travel);
  let angle = 0, vel = 0, t = 0;
  const dt = 1 / 60;
  while (angle < Math.abs(travel) && t < 1000) {
    vel = mechStep(vel, Math.abs(travel) - angle, dt, m);
    angle += vel * dt;
    t += dt;
  }
  return { t, m };
}

test('Mechanism: p32 is the time of the move, p33 / p34 the ramps, p35 the travel', () => {
  // 1a gas chamber door 5e1a (9:2878): 120 degrees in 1 s with 0.1 s ramps.
  const door = travelTime(1, 0.1, 0.1, 120);
  assert.ok(Math.abs(door.m.speed - 120 / 0.9) < 1e-9);
  assert.ok(door.t > 0.95 && door.t < 1.1, `door opens in ${door.t.toFixed(2)} s`);
  // Security cameras (9:2853): 50 degrees in 5 s, 1 s ramps.
  const cam = travelTime(5, 1, 1, -50);
  assert.ok(Math.abs(cam.m.speed - 12.5) < 1e-9);
  assert.ok(cam.t > 4.9 && cam.t < 5.15, `camera sweep ${cam.t.toFixed(2)} s`);
  // Ramps longer than the move: 0.01 s up, 0.01 s down.
  assert.ok(Math.abs(mechMotion(1, 2, 2, 90).speed - 90 / 0.99) < 1e-9);
  // Fans (12:606): 3.6e9 degrees over 5e7 s = 72 deg/s.
  assert.ok(Math.abs(mechMotion(5e7, 1, 1, 3.6e9).speed - 72) < 1e-4);
});

// ---------------------------------------------------------------------------------------------
// Gas: fountain damage volumes

// The 1a tiles: a 6 x 0.001 x 6 m box whose bottom face is the chamber floor (88.6553).
const FLOOR = 181566 / 2048;
const floorTile: GasBox = { c: [420, FLOOR + 0.0005, 460], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [3, 0.0005, 3] };

test('gas: a hit sphere touches a box only when it reaches into it (0x418810, no allowance)', () => {
  assert.equal(sphereTouchesBox(floorTile, [420.5, FLOOR + 0.251, 461], 0.4), true, 'first-person root sphere over the tile');
  assert.equal(sphereTouchesBox(floorTile, [420.5, FLOOR + 0.0765, 461], 0.1), true, 'a foot sphere 2.4 cm into the floor');
  assert.equal(sphereTouchesBox(floorTile, [420.5, FLOOR + 0.102, 461], 0.1), false, 'a foot sphere 1 mm over the tile top');
  assert.equal(sphereTouchesBox(floorTile, [420.5, FLOOR + 0.251, 463.4], 0.4), false, '0.4 m past the edge, 0.25 up');
  assert.equal(sphereTouchesBox(floorTile, [420.5, FLOOR + 0.251, 463.2], 0.4), true, '0.2 m past the edge');
  assert.equal(sphereTouchesBox(floorTile, [420, FLOOR + 2.4, 460], 0.4), false, 'on a walkway above');
});

test('gas: sphere tree leaves, walked from the body by first child / next sibling', () => {
  const n = (a: number, b: number, y: number) => ({ children: [a, b] as [number, number], center: [0, y, 0], radius: 0.1, bone: 0 });
  // 0 body -> 1 (leaf, next 2) -> 2 (group: child 3, next 0) -> 3 (leaf, next 4) -> 4 (leaf);
  // 5 links to 4 but nothing links to 5: not visited.
  const leaves = leafSpheres([n(1, 0, 1), n(0, 2, 1.5), n(3, 0, 0.5), n(0, 4, 0.3), n(0, 0, 0.1), n(0, 4, -1)]);
  assert.deepEqual(leaves.map((l) => l.center[1]), [1.5, 0.3, 0.1]);
});

test('gas: hit spheres decide; the capsule stands in (strictly) for a body without a tree', () => {
  const target = (feet: [number, number, number], spheres?: HitSphere[]): GasTarget => ({
    key: 't', feet: { x: feet[0], y: feet[1], z: feet[2] }, height: 1.8, radius: 0.35, values: [], hit: () => {},
    spheres: spheres && (() => spheres),
  });
  // Standing on the floor: the capsule's feet are on the tile's bottom face.
  assert.equal(touches(floorTile, target([420, FLOOR, 460])), true);
  assert.equal(touches(floorTile, target([420, FLOOR + 0.002, 460])), false, '2 mm up: above the 1 mm tile');
  // With spheres, only they count: none low enough, no contact though the capsule overlaps.
  assert.equal(touches(floorTile, target([420, FLOOR, 460], [{ c: [420, FLOOR + 0.3, 460], r: 0.2 }])), false);
  assert.equal(touches(floorTile, target([420, FLOOR, 460], [{ c: [420, FLOOR + 0.3, 460], r: 0.2 }, { c: [420.2, FLOOR + 0.05, 460], r: 0.1 }])), true);
  // Far away: the coarse pass skips the spheres altogether.
  let asked = 0;
  const far: GasTarget = { ...target([440, FLOOR, 460]), spheres: () => (asked++, [{ c: [420, FLOOR, 460], r: 1 }]) };
  assert.equal(touches(floorTile, far), false);
  assert.equal(asked, 0);
  // The old reading (capsule + 10 cm allowance) reached the next tile from 0.45 m: the decoded
  // one does not from 0.5 m (first person, root sphere r 0.4 centred 0.25 m up: 0.31 m at the floor).
  assert.equal(sphereTouchesBox(floorTile, [423.5, FLOOR + 0.251, 460], 0.4), false);
});

test('scripted root motion: a character the drive takes down stops on the floor under it', () => {
  // 1a "CartWheeler#210": keyed at 88.76, 12:11 takes the root 0.68 m down while it lands.
  assert.equal(driveFloorY(88.18, 88.86, FLOOR), FLOOR);
  assert.equal(driveFloorY(88.9, 88.86, FLOOR), 88.9, 'going up: the motion as it is');
  assert.equal(driveFloorY(88.18, 88.86, null), 88.18, 'nothing under it');
  assert.equal(driveFloorY(88.18, 88.86, 89.6), 88.18, 'a surface above its start (a table it is under) is not its floor');
});

test('gas: p18 per second of type p19 while On; Off / Destroy stop it; whole points', () => {
  assert.deepEqual(fountainDamage([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, 0, 0, 0, 1, 13, 16]), { perSecond: 13, type: 16 });
  assert.equal(fountainDamage([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, 0, 0, 0, 1, 0, 16]), undefined);
  const v = Array(53).fill(0);
  v[50] = 1, v[51] = 2, v[52] = 11;
  assert.equal(fountainSwitch(v, 1), true);
  assert.equal(fountainSwitch(v, 2), false);
  assert.equal(fountainSwitch(v, 11), false);
  assert.equal(fountainSwitch(v, 4), undefined);
});

test('gas: resistance lookup (0x100a2dc0): own attachments, then p5, then the global list', () => {
  const pkgs = new Map() as unknown as EntityPackageSet;
  assert.equal(resistanceMultiplier(pkgs, [], 16), 1, 'no attachments, p5 0: full damage');
  assert.equal(resistanceMultiplier(pkgs, [0, 0, 0, 0, 0, 1, 0, []], 16), 0, 'p5: immune to unlisted types');
  assert.equal(resistanceMultiplier(pkgs, [], 14), 0, 'global list: 14 and 6 at x0');
});

// ---------------------------------------------------------------------------------------------
// Retail data

async function level1a() {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    const ents = parseEntities(lvl, packages, { resolveStrings: false });
    return { packages, ents, byUid: new Map(ents.map((e) => [e.uid, e])) };
  } finally {
    console.warn = warn;
  }
}

test('retail 1a: the inmate monologue, the tank door and the gas chain', { skip }, async () => {
  const { byUid } = await level1a();
  // Detector 7555 -> Behavior Changer 7543 -> SimpleConversation 7544 (p0 0, p1 0: no listener).
  const conv = byUid.get(0x7544)!;
  assert.equal(conv.values[0], 0);
  assert.equal(conv.values[1], 0);
  assert.equal(conv.values[21], 1, 'done: On to the inmate links (timers 7545 ..)');
  assert.deepEqual(byUid.get(0x7555)!.links, [0x7543]);
  // The door: Timer 755f 39 s after the scene starts -> 7565 -> 7563 0.5 s -> Relay 755e ->
  // Timer 6895 (0 s) On -> Mechanism 5e1a p64 = 1 (forward): 120 deg in 1 s.
  assert.equal(byUid.get(0x755f)!.values[2], 39);
  assert.ok(byUid.get(0x755e)!.links.includes(0x6895));
  assert.deepEqual(byUid.get(0x6895)!.links, [0x5e1a]);
  const door = byUid.get(0x5e1a)!.values;
  assert.deepEqual([door[32], door[35], door[64]], [1, 120, 1]);
  // The window CartWheeler's scene starts 9 s after the door (Timer 6f6b), the gas stops 12 s
  // later (Timer 5c21 -> Timer 689c Off to every fountain).
  assert.equal(byUid.get(0x6f6b)!.values[2], 9);
  assert.equal(byUid.get(0x5c21)!.values[2], 12);
});

test('retail 1a: the gas floor tiles hurt the player and the CartWheeler, never Hermes', { skip }, async () => {
  const { packages, ents, byUid } = await level1a();
  const gas = new FountainHazards(packages);
  for (const e of ents) if (e.className === 'Particle Fountain') gas.add(e, fountainStartsOn(e.values));
  // The eight floor tiles (3:1213, 13 / s), the tank (3:112, 10 / s) and one stray tile.
  assert.equal(gas.size, 10);
  const tile = volumeOf(byUid.get(0x688b)!)!;
  assert.ok(Math.abs(tile.h[0] - 3) < 0.01 && Math.abs(tile.h[2] - 3) < 0.01, 'a 6 x 6 m floor quad');
  assert.deepEqual(fountainDamage(byUid.get(0x688b)!.values), { perSecond: 13, type: 16 });
  assert.equal(fountainDamage(byUid.get(0x6894)!.values), undefined, 'the rising wisps (3:1279) do no damage');

  const taken = new Map<string, number>();
  const target = (key: string, uid: number | null, at: [number, number, number]): GasTarget => ({
    key,
    feet: { x: at[0], y: at[1], z: at[2] },
    height: 1.8,
    radius: 0.5,
    values: uid === null ? [] : byUid.get(uid)!.values,
    hit: (n) => taken.set(key, (taken.get(key) ?? 0) + n),
  });
  const targets = [
    target('cartwheeler', 0x64f6, [420.6, FLOOR, 460.6]),
    target('player', null, [414.5, FLOOR, 459.5]),
    target('inmate', 0x71ec, [420.4, FLOOR, 454]),
    target('hermes', 0x84ff, [420.4, FLOOR, 455.2]),
  ];
  assert.equal(resistanceMultiplier(packages, byUid.get(0x71ec)!.values, 16), 0, 'the inmate: Damage Resistance 2:839, type 16 x0');
  assert.equal(resistanceMultiplier(packages, byUid.get(0x84ff)!.values, 16), 0, 'Hermes: p5, immune to unlisted');
  assert.equal(resistanceMultiplier(packages, byUid.get(0x64f6)!.values, 16), 1);
  for (let t = 0; t < 2; t += 1 / 30) gas.update(1 / 30, targets);
  assert.equal(taken.size, 0, 'all off until the timers turn them on');
  for (const u of [0x688a, 0x688b, 0x5c31]) gas.message(u, byUid.get(u)!.values, 1);
  for (let t = 0; t < 2; t += 1 / 30) gas.update(1 / 30, targets);
  assert.ok(Math.abs((taken.get('cartwheeler') ?? 0) - 26) <= 1, `CartWheeler ${taken.get('cartwheeler')}`);
  assert.ok(Math.abs((taken.get('player') ?? 0) - 26) <= 1, `player ${taken.get('player')}`);
  // The tank's own gas (3:112) is type 0, which the inmate does not resist: 10 / s on his
  // 9999 health (he dies by the scene's DeathBehavior); type 16 (the room) does nothing to him.
  assert.ok(Math.abs((taken.get('inmate') ?? 0) - 20) <= 1, `inmate ${taken.get('inmate')}`);
  assert.equal(taken.get('hermes'), undefined);
  // Timer 689c's Off.
  for (const u of [0x688a, 0x688b, 0x5c31]) gas.message(u, byUid.get(u)!.values, 2);
  const before = taken.get('player');
  for (let t = 0; t < 1; t += 1 / 30) gas.update(1 / 30, targets);
  assert.equal(taken.get('player'), before);
});

test('retail 1a: who the floor gas reaches, by the hit spheres (2:9, 2:138, 10:94) [bind pose]', { skip }, async () => {
  const { packages, ents, byUid } = await level1a();
  const tiles = ents.filter((e) => e.className === 'Particle Fountain' && fountainDamage(e.values)?.type === 16).map((e) => volumeOf(e)!);
  assert.equal(tiles.length, 9, 'eight room tiles and the stray 689e');
  // Every tile's bottom face is the chamber floor; none reaches the strip under the window.
  for (const t of tiles) assert.ok(Math.abs(t.c[1] - t.h[1] - FLOOR) < 1e-4);
  const north = Math.max(...tiles.map((t) => t.c[2] + Math.abs(t.h[0] * t.ax[0][2]) + Math.abs(t.h[2] * t.ax[2][2])));
  assert.ok(Math.abs(north - 463) < 1e-3, `tiles end at z ${north}`);
  // Bind-pose leaf spheres (model units = m; Torque unscaled, facing +z) at a feet position.
  const leaves = (pkg: number, id: number) => leafSpheres(readSkeletonTrailer((packages as unknown as Map<number, { mdu: never }>).get(pkg)!.mdu, id)!.spheres);
  const placed = (ls: ReturnType<typeof leaves>, at: [number, number, number], scale = 1): HitSphere[] =>
    ls.map((l) => ({ c: [at[0] + l.center[0] * scale, at[1] + l.center[1] * scale, at[2] + l.center[2] * scale], r: l.radius * scale }));
  const hurt = (spheres: HitSphere[]) => tiles.some((t) => spheres.some((h) => sphereTouchesBox(t, h.c, h.r)));
  const fp = leaves(2, 138), tp = leaves(2, 9);
  assert.deepEqual([tp.length, fp.length, leaves(10, 94).length], [23, 14, 12]);
  assert.equal(byUid.get(0x5818)!.values[227] && (byUid.get(0x5818)!.values[227] as { id: number }).id, 138, 'Player p227: the first-person model');
  // Standing on a tile: the first-person root column (r 0.4, 0.25 up) and Torque's left foot
  // (2.4 cm under the soles) both reach into it.
  assert.equal(hurt(placed(fp, [422.84, FLOOR, 447.43])), true);
  assert.equal(hurt(placed(tp, [422.84, FLOOR, 447.43])), true);
  // Under the window (z 463.75, the harness's spot): nothing reaches a tile.
  assert.equal(hurt(placed(fp, [420.5, FLOOR, 463.75])), false);
  assert.equal(hurt(placed(tp, [420.5, FLOOR, 463.75])), false);
  // The CartWheeler's hit spheres stay well above its feet (lowest leaf 0.28 x 1.3 m up in the
  // bind pose): characters touch with their mover instead (fx/gas.ts), which stands on the tile.
  assert.equal(Math.min(...leaves(10, 94).map((l) => l.center[1] - l.radius)) > 0.25, true);
});
