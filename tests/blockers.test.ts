// Invisible Static Objects (src/game/world/blockers.ts): the original's invisible collision boxes.
// 1a's ceiling rubble ("Gaurd" #114, skinned Breakables 72b7 / 734d) has no collision data of its
// own; boxes 72c2 / 7658 / 7659 close the corridor. Without them the player walked through the
// rubble and out of the level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { CharacterMotor, COLLISION_LAYER, CollisionWorld } from '../src/app/physics';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { hasSkeleton } from '../src/formats/skeleton';
import { BLOCKER_CLASS, blockerLayers, InvisibleBlockers } from '../src/game/world/blockers';
import type { World, WorldEntity } from '../src/game/world/logic';
import type { MeshPart } from '../src/formats/types';
import { nodeFS, readSrsc, skip } from './helpers';

test('blocker filters: p1 player, p2 characters, p3 pushables, p5 projectiles; p0 / p4 / p6 none', () => {
  const L = COLLISION_LAYER;
  assert.equal(blockerLayers([0, 1, 1, 1, 1, 1, 0]), L.player | L.character | L.pushable | L.projectile);
  assert.equal(blockerLayers([0, 1, 0, 0, 0, 0, 0]), L.player);
  assert.equal(blockerLayers([0, 0, 0, 1, 0, 0, 1]), L.pushable);
  assert.equal(blockerLayers([1, 0, 0, 0, 1, 0, 1]), 0);
});

test('dynamic bodies on a layer are seen only by queries of that layer', () => {
  const quad = (x: number): MeshPart =>
    ({ positions: new Float32Array([x, 0, -5, x, 0, 5, x, 5, 0]), indices: new Uint32Array([0, 1, 2]) }) as unknown as MeshPart;
  const c = new CollisionWorld({ parts: [] });
  c.addDynamic([quad(2)], true, COLLISION_LAYER.player);
  c.addDynamic([quad(4)], true);
  assert.equal(c.raycast(0, 1, 0, 1, 0, 0, 10)?.point[0], 4, 'plain queries skip the player-only body');
  c.queryLayers = COLLISION_LAYER.solid | COLLISION_LAYER.player;
  assert.equal(c.raycast(0, 1, 0, 1, 0, 0, 10)?.point[0], 2);
  c.queryLayers = COLLISION_LAYER.solid | COLLISION_LAYER.character;
  assert.equal(c.raycast(0, 1, 0, 1, 0, 0, 10)?.point[0], 4);
});

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

test('1a: the rubble of "Gaurd" #114 is closed by player clips the player cannot walk through', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const pkgs = (await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const ents = parseEntities(lvl, pkgs, { resolveStrings: false });
  const by = new Map(ents.map((e) => [e.uid, e]));
  // The rubble itself: skinned Breakables (no collision data: skinned models carry no type-7
  // collision entry), so the boxes are what blocks.
  for (const uid of [0x72b7, 0x734d]) {
    const e = by.get(uid)!;
    assert.equal(e.className, 'Breakable');
    assert.ok(hasSkeleton(pkgs.get(e.modelRef!.pkg)?.mdu, e.modelRef!.id));
  }
  for (const uid of [0x72c2, 0x7658, 0x7659]) {
    const e = by.get(uid)!;
    assert.equal(e.className, BLOCKER_CLASS);
    assert.ok(blockerLayers(e.values) & COLLISION_LAYER.player, `${uid.toString(16)} blocks the player`);
  }

  // The world system's blockers over a floor, a minimal World stand-in.
  const list: WorldEntity[] = ents
    .filter((e) => e.className === BLOCKER_CLASS)
    .map((e) => ({ uid: e.uid, e, cls: e.className, pos: [0, 0, 0], destroyed: false, enabled: true, visible: true, s: {} }));
  const world = { of: (cls: string) => (cls === BLOCKER_CLASS ? list : []), handlers: [] } as unknown as World;
  const floor = { positions: new Float32Array([400, 97.66, 500, 500, 97.66, 500, 400, 97.66, 600, 500, 97.66, 600]), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) } as unknown as MeshPart;
  const col = new CollisionWorld({ parts: [floor] });
  const blockers = new InvisibleBlockers(world, pkgs, col);
  assert.ok(blockers.count >= 40, `${blockers.count} boxes built`);

  const walk = (motor: CharacterMotor, z: number, dir: 1 | -1, x0: number) => {
    motor.teleport(x0, 97.7, z);
    let maxX = -Infinity, minX = Infinity;
    for (let i = 0; i < 6 * 60; i++) {
      motor.step(1 / 60, { wishX: dir, wishZ: 0, run: true, crouch: false, jump: false });
      maxX = Math.max(maxX, motor.position.x);
      minX = Math.min(minX, motor.position.x);
    }
    return { maxX, minX };
  };
  const player = new CharacterMotor(col, { layers: COLLISION_LAYER.player });
  // Eastward along three lanes of the corridor, then westward from the far side.
  for (const z of [536, 538, 540]) assert.ok(walk(player, z, 1, 438).maxX < 447, `lane z ${z}`);
  assert.ok(walk(player, 538, -1, 452).minX > 447, 'from the east side');
  // NPC motors (no layers) are not stopped: 1a "Gaurd" #86 releases its guard at x 451.6, beyond
  // the boxes, and the guard of #114 is keyed back west of them.
  assert.ok(walk(new CharacterMotor(col), 538, 1, 438).maxX > 448, 'NPC motor passes');
  // Off (p8): the way is open; On (p7) closes it again.
  const w72c2 = list.find((w) => w.uid === 0x72c2)!;
  const send = (msg: unknown) => (world.handlers as ((w: WorldEntity, m: number, f: number) => boolean)[]).forEach((h) => h(w72c2, msg as number, 0));
  send(w72c2.e.values[8]);
  assert.ok(walk(player, 538, 1, 438).maxX > 448, 'switched off');
  send(w72c2.e.values[7]);
  assert.ok(walk(player, 538, 1, 438).maxX < 447, 'on again');
  // Sight and the plain queries pass through the invisible boxes.
  assert.equal(col.raycast(440, 98.4, 538, 1, 0, 0, 20), null);
  blockers.dispose();
});
