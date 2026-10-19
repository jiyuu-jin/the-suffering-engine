// Skinned model geometry (src/formats/skeleton.ts) and the body parts characters wear
// (src/game/weapons/npc.ts; docs/game-logic.md §7.1 "Skinned LODs" / body parts).
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import type { EntityPackage, EntityPackageSet } from '../src/formats/entities';
import { findEntry, MDU_FACES, MDU_VERTICES, readDbId, type PackageSet } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { listSkinnedModels, readSkinnedGeometry, readSkinnedLods, readSkinnedModel } from '../src/formats/skeleton';
import { Character } from '../src/app/character';
import { HardpointAttacher } from '../src/game/weapons/hardpoints';
import { NpcWeapons, npcBodyPartSlots, type NpcLike } from '../src/game/weapons/npc';

let cache: EntityPackageSet | undefined;
function packages(): EntityPackageSet {
  if (cache) return cache;
  const out = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p as unknown as EntityPackage);
  }
  return (cache = out as unknown as EntityPackageSet);
}

test('skinned LOD records slice every model exactly and LOD0 is drawn whole', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  let models = 0, twoLod = 0;
  for (const [pkg, p] of pkgs) {
    if (!p.mdu) continue;
    for (const s of listSkinnedModels(p.mdu)) {
      const key = `${pkg}:${s.id}`;
      models++;
      const lods = readSkinnedLods(p.mdu, s.id);
      assert.ok(lods?.length, `${key}: LOD records`);
      if (lods.length > 1) twoLod++;
      const nv = p.mdu.data(findEntry(p.mdu, MDU_VERTICES, s.id)!).getUint16(0, true);
      const nf = p.mdu.data(findEntry(p.mdu, MDU_FACES, s.id)!).getUint32(0, true);
      let v = 0, f = 0;
      for (const l of lods) {
        assert.deepEqual([l.firstVertex, l.firstFace], [v, f], `${key}: contiguous LOD slices`);
        v += l.vertexCount;
        f += l.faceCount;
      }
      assert.deepEqual([v, f], [nv, nf], `${key}: LOD slices cover the vertex and face arrays`);
      const m = readSkinnedGeometry(pkgs, { pkg, id: s.id })!;
      const tris = m.submeshes.reduce((n, sm) => n + sm.indices.length / 3, 0);
      assert.equal(tris, lods[0].faceCount, `${key}: drawn triangles = LOD0 faces`);
      assert.equal(m.vertexCount, lods[0].vertexCount, `${key}: LOD0 vertex count`);
      assert.ok(m.source.every((i) => i < lods[0].vertexCount), `${key}: only LOD0 vertices drawn`);
    }
  }
  assert.equal(models, 190, 'retail skinned models');
  assert.equal(twoLod, 26, 'two-LOD (version 2) models');
});

test('Slayer heads and guard caps are body parts worn on a bone (Character p54 / p55)', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  const parts = (id: number) =>
    npcBodyPartSlots(pkgs, { kind: { template: { pkg: 10, id } } } as never).map((s) => `${s.bone}:${s.model.pkg}:${s.model.id}`);
  // CartWheeler templates (the blade-limbed Slayer): one head model each on head bone 18.
  assert.deepEqual(parts(24), ['18:10:121']);
  assert.deepEqual(parts(1320), ['18:10:157']);
  assert.deepEqual(parts(1321), ['18:10:119']);
  assert.deepEqual(parts(627), ['18:10:158']);
  // Guard cap (Attachment 10:1726) on bone 54; effect generators in p55 are not worn.
  assert.deepEqual(parts(447), ['54:10:168']);
  assert.deepEqual(parts(256), [], 'Burrower: Object Generator only');
  assert.deepEqual(parts(527), [], 'class Slayer: its Breakable trunk is not worn (unverified)');
});

test('a Slayer wears its head where its neck ends, and shots still leave the weapons', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  const skinned = readSkinnedModel(pkgs, { pkg: 10, id: 2 })!;
  const ch = new Character(skinned);
  const actor: NpcLike = { ch, kind: { template: { pkg: 10, id: 24 } } };
  const npc = new NpcWeapons(pkgs, new HardpointAttacher(pkgs));
  npc.update([actor]);
  const worn = npc.parts(actor);
  assert.equal(worn.length, 1, 'one head');
  assert.deepEqual(npc.of(actor), [], 'CartWheeler blades are hit volumes: no muzzle source');
  assert.ok(worn[0].visible);

  // The body has no geometry at the head bone (a neck stump below it); the worn head covers it.
  const head = ch.skeleton.bones[18];
  ch.root.updateMatrixWorld(true);
  const at = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const pos = skinned.model.positions;
  let near = 0;
  for (let i = 0; i < pos.length; i += 3) if (Math.hypot(pos[i] - at.x, pos[i + 1] - at.y, pos[i + 2] - at.z) < 0.08) near++;
  assert.equal(near, 0, 'body vertices at the head bone');
  const box = new THREE.Box3().setFromObject(worn[0]);
  assert.ok(box.containsPoint(at), `head model ${box.min.toArray()} .. ${box.max.toArray()} contains the head bone ${at.toArray()}`);
  assert.ok(box.max.y - box.min.y > 0.2, 'head-sized');
  npc.dispose();
  ch.dispose();
});
