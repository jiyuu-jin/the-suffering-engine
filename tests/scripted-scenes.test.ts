// Scripted scenes as the player meets them (docs/game-logic.md §11.3 "Message filters", §11.4
// "Hand-back keeps the place"):
// - Visiblity Message Filters pass only with their point on screen (Suffering.rfl 0x10136db0):
//   p2 / p3 are shares of the screen, not half-angles. Read as angles, 1a's way-out scene
//   (Gaurd #86) and rubble (#114) scenes started while the player looked elsewhere, and the guard
//   they show was never seen.
// - A character handed back by a sequence stays where it was left: 1b's Horace stands on a narrow
//   beam in an electrified niche over the arena; pushing his capsule out of the niche's walls at
//   the hand-back dropped him 6.6 m to the arena floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import * as THREE from 'three/webgpu';
import { approximateView, inBox, visibilityFilterPasses, type PlayerView, type Vec3, type VisibilityFilterParams } from '../src/game/world/logic';
import { CollisionWorld } from '../src/app/physics';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import type { CreatureKind } from '../src/game/actors/kinds';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import type { MeshPart } from '../src/formats/types';
import { loadPackages } from '../src/app/loader';
import { instanceRotation, readLevelHeader, toOutputSpace, WORLD_SCALE } from '../src/formats/level';
import { entityBoxCorners, parseEntities, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { nodeFS, readSrsc, skip } from './helpers';

const F: VisibilityFilterParams = { lineOfSight: -1, screenX: 90, screenY: 90, maxDistance: 50, nearPlayer: 2 };
const on = (x: number, y: number, front = true, camera: Vec3 = [0, 0, 0]) => ({ camera, x, y, front });

test('Visiblity Message Filter: on screen within p2 / p3 % of it, p4 range, p5 near the player, p1 line of sight', () => {
  const obj: Vec3 = [0, 0, -10];
  const far: Vec3 = [0, 0, 20];
  assert.equal(visibilityFilterPasses(F, obj, far, on(0, 0), () => true), true, 'centre of the screen');
  assert.equal(visibilityFilterPasses(F, obj, far, on(0.89, -0.89), () => true), true, 'inside the 90 % box');
  assert.equal(visibilityFilterPasses(F, obj, far, on(0.95, 0), () => true), false, 'beyond 90 % of the width');
  assert.equal(visibilityFilterPasses(F, obj, far, on(0, -0.95), () => true), false, 'beyond 90 % of the height');
  assert.equal(visibilityFilterPasses({ ...F, screenX: 10, screenY: 20 }, obj, far, on(0.15, 0), () => true), false, 'p2 10: the middle tenth');
  assert.equal(visibilityFilterPasses(F, obj, far, on(0, 0, false), () => true), false, 'behind the camera');
  assert.equal(visibilityFilterPasses(F, [0, 0, -60], far, on(0, 0), () => true), false, 'farther than p4 from the camera');
  // Within p5 of the player it passes whatever the view (but not beyond p4).
  assert.equal(visibilityFilterPasses(F, obj, [0, 0, -9], on(0, 0, false), () => true), true, 'player within p5');
  assert.equal(visibilityFilterPasses({ ...F, nearPlayer: 0 }, obj, [0, 0, -9], on(0, 0, false), () => true), false, 'p5 0');
  // p1 >= 0 adds a clear line from the camera; p1 < 0 never asks.
  let asked = 0;
  assert.equal(visibilityFilterPasses(F, obj, far, on(0, 0), () => (asked++, false)), true);
  assert.equal(asked, 0);
  assert.equal(visibilityFilterPasses({ ...F, lineOfSight: 0.1 }, obj, far, on(0, 0), () => false), false, 'p1 0.1: blocked line');
  assert.equal(visibilityFilterPasses({ ...F, lineOfSight: 0.1 }, obj, far, on(0, 0), () => true), true, 'p1 0.1: clear line');
});

test('approximateView: screen position for the 53 degree lens on 4:3', () => {
  const p: PlayerView = { feet: [0, 0, 0], eye: [0, 1.6, 0], forward: [0, 0, -1] };
  const ahead = approximateView(p, [0, 1.6, -10]);
  assert.ok(ahead.front && Math.abs(ahead.x) < 1e-9 && Math.abs(ahead.y) < 1e-9);
  const tanY = Math.tan((26.5 * Math.PI) / 180);
  const right = approximateView(p, [10 * tanY * (4 / 3), 1.6, -10]);
  assert.ok(Math.abs(right.x - 1) < 1e-9 && Math.abs(right.y) < 1e-9, 'right edge');
  const up = approximateView(p, [0, 1.6 + 10 * tanY, -10]);
  assert.ok(Math.abs(up.y - 1) < 1e-9 && Math.abs(up.x) < 1e-9, 'top edge');
  assert.equal(approximateView(p, [0, 1.6, 10]).front, false, 'behind');
  // Turned east (+x): north (-z) is to the left.
  const east: PlayerView = { ...p, forward: [1, 0, 0] };
  assert.ok(approximateView(east, [10, 1.6, -1]).x < 0);
});

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

test('1a guard post hall: "Gaurd" #86 and #114 start only with their point on screen', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const by = new Map(parseEntities(lvl, pkgs, { resolveStrings: false }).map((e) => [e.uid, e]));
  const filter = (uid: number) => {
    const e = by.get(uid)!;
    assert.equal(e.className, 'Visiblity Message Filter');
    const v = e.values as number[];
    const f: VisibilityFilterParams = { lineOfSight: v[1], screenX: v[2], screenY: v[3], maxDistance: v[4], nearPlayer: v[5] };
    const pos = toOutputSpace(e.position);
    return (feet: Vec3, forward: Vec3) => {
      const p: PlayerView = { feet, eye: [feet[0], feet[1] + 1.6, feet[2]], forward };
      return visibilityFilterPasses(f, pos, feet, approximateView(p, pos), () => true);
    };
  };
  const east: Vec3 = [1, 0, 0], south: Vec3 = [0, 0, 1], north: Vec3 = [0, 0, -1];
  // #86 (Relay 79ad): filter 6a86 at the hall's far end, asked by Detector 6a85 at its corner.
  const wayOut = filter(0x6a86);
  const corner: Vec3 = [433.6, 97.7, 507.6];
  assert.equal(wayOut(corner, east), false, 'walking east along the corridor: the hall is not in view');
  assert.equal(wayOut(corner, south), true, 'looking down the hall');
  // The duct scene "Guard" #242 (filter 7ea4) is up the hall to the north from the same corner.
  const duct = filter(0x7ea4);
  assert.equal(duct(corner, east), false);
  assert.equal(duct(corner, north), true);
  assert.equal(duct(corner, south), false, 'the two scenes are on opposite sides: one look starts one');
  // #114 (Timer 6046): filter 6c7c down the east walkway, asked by Detector 6c7d in the hall.
  const rubble = filter(0x6c7c);
  for (const z of [534.6, 536, 538]) assert.equal(rubble([435, 97.7, z], south), false, `walking down the hall at z ${z}`);
  assert.equal(rubble([435, 97.7, 536], east), true, 'looking east into the walkway');
});

/** A Detector's box in output space (as logic.ts builds it). */
function detectorBox(e: Entity) {
  const P = entityBoxCorners(e, instanceRotation)!.map((p) => p.map((x) => x / WORLD_SCALE) as Vec3);
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const edges = [sub(P[1], P[0]), sub(P[2], P[0]), sub(P[4], P[0])];
  const len = edges.map((d) => Math.hypot(...d));
  const ax = edges.map((d, i) => d.map((x) => x / (len[i] || 1)) as Vec3) as [Vec3, Vec3, Vec3];
  const c = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / 8) as Vec3;
  return { c, ax, h: [len[0] / 2, len[1] / 2, len[2] / 2] as Vec3 };
}

test('1a guard post hall, walked like a player: #114 starts with the guard on screen (not with half-angle filters)', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const by = new Map(parseEntities(lvl, pkgs, { resolveStrings: false }).map((e) => [e.uid, e]));
  const box = (u: number) => detectorBox(by.get(u)!);
  const params = (u: number): VisibilityFilterParams => {
    const v = by.get(u)!.values as number[];
    return { lineOfSight: v[1], screenX: v[2], screenY: v[3], maxDistance: v[4], nearPlayer: v[5] };
  };
  // The port's reading before the fix: p2 as a horizontal half-angle in front of the eye.
  const halfAngle = (f: VisibilityFilterParams, obj: Vec3, p: PlayerView) => {
    const dx = obj[0] - p.eye[0], dz = obj[2] - p.eye[2];
    if (Math.hypot(dx, obj[1] - p.eye[1], dz) > f.maxDistance) return false;
    return (dx * p.forward[0] + dz * p.forward[2]) / (Math.hypot(dx, dz) * Math.hypot(p.forward[0], p.forward[2])) >= Math.cos((Math.min(180, f.screenX) * Math.PI) / 180);
  };
  const filter = { uid: 0x6c7c, pos: toOutputSpace(by.get(0x6c7c)!.position), f: params(0x6c7c) };
  const junction = box(0x6c7d), walkway = box(0x5bb1), past = box(0x8a1e);
  // The guard's body as #86 left it and #114 draws it (16 m east of the object, at the hips).
  const guard: Vec3 = [451.5, 98.8, 538.6];
  // Walk down the hall from its north corner and follow the guard east into the walkway, at the
  // default walk (3 m/s), the view turned towards the next point at 200 degrees a second.
  const walk = (oldRule: boolean) => {
    const via: Vec3[] = [[435, 97.7, 524], [435, 97.7, 537.6], [441, 97.7, 538]];
    const feet: Vec3 = [434, 97.7, 509.5];
    let yaw = Math.PI, i = 0, timer = -1;
    for (let t = 0; t < 20; t += 1 / 60) {
      const to = via[i];
      if (Math.hypot(to[0] - feet[0], to[2] - feet[2]) < (i < via.length - 1 ? 1.2 : 0.6)) {
        if (++i === via.length) return undefined;
        continue;
      }
      let d = Math.atan2(-(to[0] - feet[0]), -(to[2] - feet[2])) - yaw;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      yaw += Math.max(-3.5 / 60, Math.min(3.5 / 60, d));
      feet[0] += -Math.sin(yaw) * 0.05;
      feet[2] += -Math.cos(yaw) * 0.05;
      const p: PlayerView = { feet: [...feet], eye: [feet[0], feet[1] + 1.6, feet[2]], forward: [-Math.sin(yaw), 0, -Math.cos(yaw)] };
      const pts: Vec3[] = [0.25, 0.9, 1.55].map((h) => [feet[0], feet[1] + h, feet[2]]);
      const inside = (b: ReturnType<typeof box>) => pts.some((q) => inBox(b, q, 0.3));
      // Detector 6c7d asks filter 6c7c every tick; it starts Timer 6046 (0.25 s); stepping into
      // the walkway (5bb1) starts the scene at once; past the junction (8a1e) starts the timer.
      const seen = oldRule ? halfAngle(filter.f, filter.pos, p) : visibilityFilterPasses(filter.f, filter.pos, p.feet, approximateView(p, filter.pos), () => true);
      if (timer < 0 && ((inside(junction) && seen) || inside(past))) timer = t + 0.25;
      if (inside(walkway) || (timer >= 0 && t >= timer)) {
        const v = approximateView(p, guard);
        return { at: [...feet], onScreen: v.front && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
      }
    }
    return undefined;
  };
  const now = walk(false), before = walk(true);
  assert.ok(now?.onScreen, `the scene starts with the guard on screen: ${JSON.stringify(now)}`);
  assert.ok(before && !before.onScreen && before.at[2] < 536, `half-angle filters started it in the hall, the guard out of view: ${JSON.stringify(before)}`);
});

// --- hand-back -------------------------------------------------------------------------------

function rig(): SkinnedModel {
  const parents = [-1, 0, 1];
  const bones = parents.map((parent, index) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, index * 0.5, 0, 1]);
    return { index, hash: 0x1000 + index, name: `b${index}`, parent, children: [] as number[], inverseBind: m, bindWorld: m, position: [0, index ? 0.5 : 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
  });
  bones.forEach((b) => b.parent >= 0 && bones[b.parent].children.push(b.index));
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

const idleClip: AnimClipData = {
  id: 0,
  animSet: 0,
  duration: 1,
  flags: 0,
  blendTime: 0.2,
  rate: 1,
  links: [],
  tracks: [0, 1, 2].map((b) => ({ boneHash: 0x1000 + b, format: 0xc0, times: new Float32Array([0, 1]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number] })),
};

function horaceKind(): CreatureKind {
  const skinned = rig();
  return {
    key: 'test:Horace',
    template: { pkg: 0, id: 0 },
    className: 'Horace',
    skinned,
    proto: new Character(skinned, [idleClip]),
    idle: 0,
    walk: -1,
    run: -1,
    attacks: [],
    hits: [],
    deaths: [],
    fall: -1,
    land: -1,
    events: [{ hitTimes: [], sounds: [] }] as never,
    speeds: [0],
    height: 2.47,
    bottom: 0,
    anchored: false,
    radius: 0.49,
    moveSpeed: 1.5,
    runSpeed: 3,
    hostile: false,
    maxHealth: 50,
    decor: false,
  };
}

/** Axis-aligned box as level triangles. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): MeshPart {
  const P = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a, c, b, a, d, c);
  return { positions: new Float32Array(P.flat()), indices: new Uint32Array(idx) } as unknown as MeshPart;
}

function env(): ActorEnv {
  return {
    world: null as never,
    nav: null,
    player: { position: new THREE.Vector3(0, 0, 30) } as never,
    playerAlive: true,
    playerUid: 0x5818,
    time: 0,
    actors: [],
    damagePlayer: () => {},
    damageActor: () => {},
    sound: () => {},
    onDeath: () => {},
    clip: () => -1,
    entity: () => undefined,
    send: () => {},
    say: () => 0,
  };
}

test('hand-back: a character released on a narrow beam inside a niche stays there (1b Horace)', () => {
  // A 20 cm beam (top at y 6.6) between the niche's side walls, 0.3 m from his axis: closer than
  // his 0.49 m radius. The arena floor is 6.6 m below.
  const world = new CollisionWorld({
    parts: [box(-10, 10, -1, 0, -10, 10), box(-0.1, 0.1, 5.6, 6.6, -1, 1), box(-1, -0.3, 6.6, 9, -1, 1), box(0.3, 1, 6.6, 9, -1, 1)],
  });
  const release = (y: number) => {
    const a = new Actor(horaceKind(), { x: 0, y, z: 0 }, 0);
    a.settle(world, false);
    a.setScriptPose({ x: 0, y, z: 0 }, new THREE.Quaternion());
    a.setScriptPose(null);
    const e = env();
    for (let t = 0; t < 3; t += 1 / 30) {
      e.time += 1 / 30;
      a.update(1 / 30, e);
    }
    return a.position;
  };
  const kept = release(6.62);
  assert.ok(Math.abs(kept.y - 6.6) < 0.05 && Math.abs(kept.x) < 0.01, `on the beam: ${kept.x.toFixed(2)}, ${kept.y.toFixed(2)}`);
  // Released with nothing under the feet within reach, the body still falls.
  const open = new CollisionWorld({ parts: [box(-10, 10, -1, 0, -10, 10)] });
  const a = new Actor(horaceKind(), { x: 0, y: 5, z: 0 }, 0);
  a.settle(open, false);
  a.setScriptPose({ x: 0, y: 5, z: 0 }, new THREE.Quaternion());
  a.setScriptPose(null);
  const e = env();
  for (let t = 0; t < 3; t += 1 / 30) {
    e.time += 1 / 30;
    a.update(1 / 30, e);
  }
  assert.ok(a.position.y < 0.1, `fell to the floor: ${a.position.y.toFixed(2)}`);
});
