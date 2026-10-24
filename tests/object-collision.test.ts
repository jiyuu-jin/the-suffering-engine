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

test('retail 3a: the gas tank 13c3 the route shoots carries the AI sight flag (template bit 10), so shots cannot use that flag', { skip }, async () => {
  const { SrscFile } = await import('../src/formats/srsc');
  const { readLevelHeader, parseLevelObjects } = await import('../src/formats/level');
  const { findLevelDependencies, loadPackages } = await import('../src/app/loader');
  const { dirname } = await import('../src/app/gamefs');
  const { readObjectTemplate } = await import('../src/formats/entities');
  const fs = nodeFS();
  const deps = await findLevelDependencies(fs, 'LEVELS/3 YardCellBlock/3a YardCellBlock.lvl');
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const o = parseLevelObjects(lvl).find((x) => x.uid === 0x13c3)!;
  const t = readObjectTemplate(packages, o.template)!;
  assert.equal(sightPasses(o.flags, t.flags), true);
});

test('retail: the clamber room test sweeps half the widest sphere of the player proxy 2:44 (r 0.3) up to its box top 2.245', { skip }, async () => {
  const { clamberRoomShape, clamberRoom } = await import('../src/game/world/clamber');
  const { readModelBoundsBox } = await import('../src/formats/model-spheres');
  const { readObjectTemplate } = await import('../src/formats/entities');
  const { packages } = await level9();
  const t = readObjectTemplate(packages, { pkg: 2, id: 44 })!;
  const mdu = packages.get(t.modelRef!.pkg)!.mdu!;
  const c = readModelCollision(mdu, t.modelRef!.id)!;
  const box = readModelBoundsBox(mdu, t.modelRef!.id)!;
  const shape = clamberRoomShape(c.leaves.flatMap((l) => (l.kind === 'sphere' ? [l.radius] : [])), box.corner[1] + box.edges[1][1])!;
  assert.ok(Math.abs(shape.radius - 0.3) < 1e-6 && Math.abs(shape.height - 2.245) < 1e-3, JSON.stringify(shape));
  // 8b's Clamber Point 1802: its top 98.75, the ledge's collision box 0.3 m higher. The swept
  // sphere's lowest point stays above it (with the port's old 0.35 / 1.8 capsule it reached 99.025).
  const room = clamberRoom({ x: 0, z: 0 }, 98.75, shape.height, shape.radius);
  assert.ok(room.y0 - room.r > 99.05, `${room.y0 - room.r}`);
});

// Floor-layer cells (formats/level.ts LAYER_CELL): the diagonal (0x1, SUFFERING.EXE 0x49db80),
// hidden triangles (0x10 << t) and holes (0x40 << t, 0x4a6c03 / Suffering.rfl 0x100c01cd).
test('floor-layer cell: the triangle under a point is the one the cell split lists, wound up from +y', async () => {
  const { layerCellTriangle, layerCellTriangles, layerTriangleSolid, LAYER_CELL } = await import('../src/formats/level');
  const inside = (p: [number, number], t: [number, number][]) => {
    const s = (a: [number, number], b: [number, number]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const d = [s(t[0], t[1]), s(t[1], t[2]), s(t[2], t[0])];
    return d.every((x) => x >= -1e-9) || d.every((x) => x <= 1e-9);
  };
  for (const flags of [0, LAYER_CELL.flip]) {
    const tris = layerCellTriangles(flags);
    for (const t of tris) {
      // Up-facing: y of (c - a) x (b - a) in (x, z) = u_z v_x - u_x v_z > 0.
      const u = [t[1][0] - t[0][0], t[1][1] - t[0][1]], v = [t[2][0] - t[0][0], t[2][1] - t[0][1]];
      assert.ok(u[1] * v[0] - u[0] * v[1] > 0, `flags ${flags}: ${JSON.stringify(t)} faces up`);
    }
    for (let k = 0; k < 200; k++) {
      const p: [number, number] = [((k * 37) % 101) / 100, ((k * 61) % 103) / 102];
      assert.ok(inside(p, tris[layerCellTriangle(flags, p[0], p[1])]), `flags ${flags} point ${p}`);
    }
  }
  // Without the flag the split runs (1, 0)-(0, 1); with it (0, 0)-(1, 1).
  assert.equal(layerCellTriangle(0, 0.9, 0.2), 1);
  assert.equal(layerCellTriangle(LAYER_CELL.flip, 0.9, 0.2), 1);
  assert.equal(layerCellTriangle(0, 0.2, 0.2), 0);
  assert.equal(layerCellTriangle(LAYER_CELL.flip, 0.2, 0.9), 0);
  assert.equal(layerCellTriangle(LAYER_CELL.flip, 0.9, 0.95), 0);
  // Hidden (0x30) is not a hole; 0x40 / 0x80 are triangle 0 / 1's holes.
  assert.deepEqual([layerTriangleSolid(0x31, 0), layerTriangleSolid(0x31, 1)], [true, true]);
  assert.deepEqual([layerTriangleSolid(0x41, 0), layerTriangleSolid(0x41, 1)], [false, true]);
  assert.deepEqual([layerTriangleSolid(0x80, 0), layerTriangleSolid(0x80, 1)], [true, false]);
  assert.deepEqual([layerTriangleSolid(0xc1, 0), layerTriangleSolid(0xc1, 1)], [false, false]);
});

const load5b = async () => {
  const { SrscFile } = await import('../src/formats/srsc');
  const { readLevelHeader, parseLevel, parseFloorLayers, parseLevelObjects } = await import('../src/formats/level');
  const { findLevelDependencies, loadPackages } = await import('../src/app/loader');
  const { dirname } = await import('../src/app/gamefs');
  const { objectCollision } = await import('../src/game/world/object-collision');
  const fs = nodeFS();
  const deps = await findLevelDependencies(fs, 'LEVELS/5 Asylum/5b Asylum.lvl');
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const ldu = deps.levelLdu ? new SrscFile(await fs.read(deps.levelLdu)) : undefined;
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const LC = COLLISION_LAYER.solid | COLLISION_LAYER.landscape;
  const level = parseLevel(lvl, '5b', { ldu, packages, collisionOf: objectCollision(lvl, packages), layerCollision: LC });
  return { lvl, packages, level, LC, parseFloorLayers, parseLevelObjects };
};

test('retail 5b: the lobby floor is a hidden floor layer; the room models drawn over it have node-less sphere trees', { skip }, async () => {
  const { lvl, packages, level, LC, parseFloorLayers, parseLevelObjects } = await load5b();
  // The drawn floors: 28:285 (288a) and the glass 28:278 (14b0) are sphere trees without nodes.
  const mdu = packages.get(28)!.mdu!;
  for (const id of [285, 278, 160]) {
    const c = readModelCollision(mdu, id)!;
    assert.deepEqual([c.tree, c.nodes], [CollisionTree.Spheres, 0], `28:${id}`);
    assert.equal(moverCollisionMesh(mdu, id), undefined);
  }
  // Under them: material-less layers at the drawn height, every cell hidden (0x30) and none a hole.
  const L = parseFloorLayers(lvl).find((l) => l.name === 'Layer 1691')!;
  assert.equal(L.material, undefined);
  assert.deepEqual([L.x, L.z, L.w, L.h, L.y / 2048], [196, 176, 9, 14, 97.65625]);
  assert.ok([...L.cellFlags!].every((f) => (f & 0xf0) === 0x30));
  // The collision world holds them (collision only: no drawn part has them), the drawn one not.
  const hidden = level.collision!.filter((p) => p.layers === LC && !p.textureKey);
  assert.equal(hidden.length, 1);
  const col = new CollisionWorld({ parts: level.collision! });
  col.queryLayers = COLLISION_LAYER.solid;
  const ground = (w: CollisionWorld, x: number, z: number) => {
    const h = w.raycast(x, 99.5, z, 0, -1, 0, 10);
    return h ? 99.5 - h.distance : null;
  };
  // Over the glass (14b0), by the north door 10de (288a), in the south hall (1b43 / 25a9's corridor
  // has walls only in its tree), at the 5a arrival (the "collision" layer at 97.16).
  for (const [x, z, y] of [[198.3, 184.3, 97.66], [194.3, 188.3, 97.66], [188.3, 166.3, 97.66], [180.3, 160.3, 97.66], [207.3, 187.3, 97.16]]) {
    const g = ground(col, x, z);
    assert.ok(g !== null && Math.abs(g - y) < 0.05, `(${x}, ${z}): ${g} for ${y}`);
  }
  const without = new CollisionWorld({ parts: level.collision!.filter((p) => !hidden.includes(p)) });
  without.queryLayers = COLLISION_LAYER.solid;
  assert.ok((ground(without, 198.3, 184.3) ?? 0) < 97, 'without them the lobby glass leaves the basement ceiling 1 m down');
  assert.ok((ground(without, 188.3, 166.3) ?? 0) < 93, 'and the south hall open to the basement floor');
  // Every Move Node of the lobby and the upper floor has ground at its height.
  const nodes = parseLevelObjects(lvl).filter((o) => [0x116d, 0x116e, 0x116f, 0x1170, 0x1171, 0x1172, 0x1224, 0x1225, 0x1226, 0x1227, 0x1228].includes(o.uid));
  assert.equal(nodes.length, 11);
  for (const o of nodes) {
    const [x, y, z] = o.position.map((v) => v / 2048);
    const h = col.raycast(x, y + 0.5, z, 0, -1, 0, 1.5);
    assert.ok(h && Math.abs(y + 0.5 - h.distance - y) < 0.05, `node ${o.uid.toString(16)} at ${y}: ${h ? y + 0.5 - h.distance : null}`);
  }
});

test('retail: hole triangles of a floor layer stay out of the collision world, hidden ones come in', { skip }, async () => {
  const { lvl, level, LC, parseFloorLayers } = await load5b();
  const layers = parseFloorLayers(lvl);
  const holes = layers.reduce((n, l) => n + [...(l.cellFlags ?? [])].reduce((k, f) => k + (f & 0x40 ? 1 : 0) + (f & 0x80 ? 1 : 0), 0), 0);
  const hiddenSolid = layers.reduce(
    (n, l) => n + [...(l.cellFlags ?? [])].reduce((k, f) => k + (l.material && l.blocks.length && !(f & 0xf0) ? 0 : (f & 0x40 ? 0 : 1) + (f & 0x80 ? 0 : 1)), 0),
    0,
  );
  assert.ok(holes > 0);
  const part = level.collision!.find((p) => p.layers === LC && !p.textureKey)!;
  assert.equal(part.indices.length / 3, hiddenSolid);
});

test('retail 5b: .ldu refs copied from another instance give way to the template model (Breakables 31ed / 31ee)', { skip }, async () => {
  const { staleLduRefs } = await import('../src/formats/level');
  const { templateModelRef } = await import('../src/formats/model');
  const { lvl, packages, level, parseLevelObjects } = await load5b();
  const objs = parseLevelObjects(lvl);
  const ref = (u: number) => objs.find((o) => o.uid === u)!.ref;
  // 31ed (template model 7:251) shares its record with the gallery piece fde (28:373).
  assert.deepEqual(ref(0x31ed), ref(0xfde));
  const { SrscFile } = await import('../src/formats/srsc');
  const { findLevelDependencies } = await import('../src/app/loader');
  const deps = await findLevelDependencies(nodeFS(), 'LEVELS/5 Asylum/5b Asylum.lvl');
  const ldu = new SrscFile(await nodeFS().read(deps.levelLdu!));
  const model = new Map<number, { id: number; pkg: number }>();
  for (const e of ldu.entries) if (e.type === 0x52) { const v = ldu.data(e); model.set(e.id, { id: v.getUint16(0, true), pkg: v.getUint16(2, true) }); }
  const stale = staleLduRefs(objs, ref(0xfde).pkg, (id) => model.get(id), (o) => templateModelRef(packages, o.template));
  assert.ok(stale.has(0x31ed) && stale.has(0x31ee));
  assert.ok(!stale.has(0xfde) && !stale.has(0x1155), 'the owners keep their records');
  // The upper corridor west of the door 2ad8 is clear at the height of a person (no 20 m box).
  const col = new CollisionWorld({ parts: level.collision! });
  col.queryLayers = COLLISION_LAYER.solid;
  for (const x of [184, 179, 176]) assert.equal(col.capsuleOverlaps({ x, z: 148.2, y0: 103.95, y1: 104.75, r: 0.35 }), false, `x ${x}`);
});
