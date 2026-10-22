// Object collision as the original does it (docs/game-logic.md §14.10): a placed object collides
// with its model's type-7 collision tree (formats/model-collision.ts), its class decides who it
// stops (object-collision.ts), template bit 10 lets AI sight through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModelCollision, moverCollisionMesh, rayOnlyCollisionMesh, CollisionTree, FACE_LEAF_MIN_RADIUS } from '../src/formats/model-collision';
import { findEntry, mduFaceCount } from '../src/formats/model';
import { collisionForClass, sightPasses } from '../src/game/world/object-collision';
import { COLLISION_LAYER, CollisionWorld } from '../src/app/physics';
import { skip, nodeFS } from './helpers';

const L9 = 'LEVELS/9 Lighthouse/9 Lighthouse.lvl';

const load9 = async () => {
  const { SrscFile } = await import('../src/formats/srsc');
  const { readLevelHeader, parseLevel } = await import('../src/formats/level');
  const { findLevelDependencies, loadPackages } = await import('../src/app/loader');
  const { dirname } = await import('../src/app/gamefs');
  const { objectCollision } = await import('../src/game/world/object-collision');
  const fs = nodeFS();
  const deps = await findLevelDependencies(fs, L9);
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const ldu = deps.levelLdu ? new SrscFile(await fs.read(deps.levelLdu)) : undefined;
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  return { lvl, ldu, packages, parseLevel, objectCollision };
};
let cached: ReturnType<typeof load9> | undefined;
const level9 = () => (cached ??= load9());

test('class rule: the blocking classes stop everyone, the player-only ones the player, the rest nobody', () => {
  assert.deepEqual(collisionForClass('Static Object', 0x281, 0), { layers: COLLISION_LAYER.solid, rayLayers: COLLISION_LAYER.decor, sightPass: false });
  const lamp = collisionForClass('Light Housing', 0x281, 0)!;
  assert.equal(lamp.layers, COLLISION_LAYER.player | COLLISION_LAYER.decor, 'Light Housing: the player list only (0x101509c0)');
  for (const c of ['Decoration', 'Instance Rendered Object', 'Water Volume', 'Fire', 'Detector', 'Particle Fountain', 'Sky / Sun']) assert.equal(collisionForClass(c, 0x281, 0), null, c);
});

test('AI sight passes engine +8 bit 0x20000: template bit 10, or instance 0x1000000 under 0x2000', () => {
  assert.equal(sightPasses(0x281, 0x400), true);
  assert.equal(sightPasses(0x281, 0), false);
  assert.equal(sightPasses(0x2000 | 0x281, 0x400), false, 'the instance overrides the template');
  assert.equal(sightPasses(0x2000 | 0x1000000, 0), true);
});

test('retail 9: every type-7 record parses to its last byte (box nodes 54 + 2n, sphere nodes 20)', { skip }, async () => {
  const { packages } = await level9();
  let n = 0;
  for (const pkg of packages.values()) {
    const mdu = pkg.mdu;
    if (!mdu) continue;
    for (const e of mdu.entries) {
      if (e.type !== 7 || e.size < 0x4c) continue;
      const v = mdu.data(e);
      const kind = v.getUint16(0x48, true), count = v.getUint16(0x4a, true);
      if (kind > 1 || !count) continue;
      let p = 0x54;
      for (let i = 0; i < count; i++) p += kind === 1 ? 54 + 2 * v.getUint16(p + 52, true) : 20;
      assert.equal(p, v.byteLength, `${pkg.id}:${e.id}`);
      n++;
    }
  }
  assert.ok(n > 2000, `${n} trees`);
});

test('retail 9: the burial-ground tree 23:142 collides as one leaf box, not its 328 cut-out faces', { skip }, async () => {
  const { packages } = await level9();
  const mdu = packages.get(23)!.mdu!;
  const c = readModelCollision(mdu, 142)!;
  assert.equal(c.tree, CollisionTree.Boxes);
  assert.equal(c.leaves.length, 1);
  const leaf = c.leaves[0];
  assert.equal(leaf.kind, 'box');
  if (leaf.kind !== 'box') return;
  assert.deepEqual(leaf.edges.map((e) => +Math.hypot(...e).toFixed(2)), [2.16, 5.88, 14.45]);
  assert.equal(mduFaceCount(mdu.data(findEntry(mdu, 4, 142)!)), 328);
  const mesh = moverCollisionMesh(mdu, 142)!;
  assert.equal(mesh.indices.length / 3, 12, 'a box: 12 triangles');
  assert.equal(rayOnlyCollisionMesh(mdu, 142), undefined);
});

test('retail 9: a sphere tree without nodes stops no mover; rays hit its drawn faces (the fog quad 3:440)', { skip }, async () => {
  const { packages } = await level9();
  const mdu = packages.get(3)!.mdu!;
  const c = readModelCollision(mdu, 440)!;
  assert.deepEqual([c.tree, c.nodes], [CollisionTree.Spheres, 0]);
  assert.equal(moverCollisionMesh(mdu, 440), undefined);
  const ray = rayOnlyCollisionMesh(mdu, 440)!;
  assert.equal(ray.indices.length / 3, mduFaceCount(mdu.data(findEntry(mdu, 4, 440)!)));
});

test('a leaf\'s face list counts only above a 200-unit bounding radius (0x41f0ff)', { skip }, async () => {
  const { packages } = await level9();
  // Find a retail model whose tree lists faces.
  for (const pkg of packages.values()) {
    const mdu = pkg.mdu;
    for (const e of mdu?.entries ?? []) {
      if (e.type !== 7) continue;
      const c = readModelCollision(mdu!, e.id);
      if (!c?.leaves.some((l) => l.kind === 'faces')) continue;
      const faces = c.leaves.filter((l) => l.kind === 'faces').reduce((k, l) => k + (l.kind === 'faces' ? l.faces.length : 0), 0);
      const big = moverCollisionMesh(mdu!, e.id, 1)!;
      assert.equal(big.indices.length / 3, faces + 12 * c.leaves.filter((l) => l.kind === 'box').length, 'listed faces + boxes');
      const tiny = moverCollisionMesh(mdu!, e.id, (FACE_LEAF_MIN_RADIUS / c.sphere[3]) * 0.5)!;
      assert.equal(tiny.indices.length / 3, 12 * c.leaves.length, 'below the radius: every leaf is its box');
      return;
    }
  }
  assert.fail('no face-list model in 9');
});

test('retail 9: the guard\'s leg west of the burial ground passes the tree 884; its drawn leaves blocked it', { skip }, async () => {
  const { lvl, ldu, packages, parseLevel, objectCollision } = await level9();
  const level = parseLevel(lvl, '9', { ldu, packages, collisionOf: objectCollision(lvl, packages) });
  const col = new CollisionWorld({ parts: level.collision! });
  const drawn = new CollisionWorld(level);
  // Where bc9 stood in run r1 (297.3, 113.7, 244.2), his next node 97 (292.5, 241.75): the body of
  // a person's Collider 10:149 (r 0.45 x 0.95 scale, up to 2.07 m).
  const capsule = (w: CollisionWorld, x: number, z: number) => {
    const g = w.groundQuery(x, 113.7 + 1, z, 0.2, 3)!;
    return w.capsuleOverlaps({ x, z, y0: g.height + 0.45 + 0.05, y1: g.height + 2.07 - 0.43, r: 0.43 });
  };
  let drawnBlocked = false;
  for (let k = 0; k <= 10; k++) {
    const x = 297.3 + (292.5 - 297.3) * (k / 10), z = 244.2 + (241.75 - 244.2) * (k / 10);
    assert.equal(capsule(col, x, z), false, `collision free at ${x.toFixed(2)}, ${z.toFixed(2)}`);
    drawnBlocked ||= capsule(drawn, x, z);
  }
  assert.ok(drawnBlocked, 'the drawn canopy stood in the way');
  // The tree's box stands north of the leg: x 285.5..300, z 246.8..249, up to 119.
  const top = col.groundQuery(292.8, 125, 247.9, 0.1, 10)!;
  assert.ok(Math.abs(top.height - 119) < 0.05, `box top ${top.height}`);
});

test('retail 1a: the gas-chamber window Real_Glass 6342 (additive faces) stops movers as its box; the shards 702f the scene leaves stop none', { skip }, async () => {
  const { readLevelHeader } = await import('../src/formats/level');
  const { findLevelDependencies, loadPackages } = await import('../src/app/loader');
  const { dirname } = await import('../src/app/gamefs');
  const { SrscFile } = await import('../src/formats/srsc');
  const fs = nodeFS();
  const deps = await findLevelDependencies(fs, 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl');
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const mdu = packages.get(9)!.mdu!;
  // 6342: Static Object 9:2896, model 9:2089 (144 faces, blend 2): one leaf box 0.09 x 3.92 x 11.3 m.
  assert.equal(collisionForClass('Static Object', 0xa81, 0x400)!.layers, COLLISION_LAYER.solid);
  const glass = moverCollisionMesh(mdu, 2089)!;
  assert.equal(glass.indices.length / 3, 12);
  // "CartWheeler" #210 sends it away at 2.26 s and leaves Breakable 702f (9:2551, broken glass):
  // a sphere tree without nodes, so rays hit its faces and movers pass.
  assert.equal(moverCollisionMesh(mdu, 2551), undefined);
  assert.ok(rayOnlyCollisionMesh(mdu, 2551));
});
