// The selected throwable carried on the player's back (docs/game-logic.md §4.5 "Carried
// throwable"; src/game/weapons/back-throwable.ts). Suffering.rfl: taken out onto Player p119 =
// bone 51 (0x10038ca0), moved to the marker's bone by AttachThrownWeapon 231 (0x1002ae40),
// launched by ThrowWeapon 230 (0x10029310), the next one picked by p45 at 0 (0x1002b1a4).
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import type { Character } from '../src/app/character';
import { readDbId, readModel, type PackageSet, type ResRef } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { readSkinnedModel } from '../src/formats/skeleton';
import type { EntityPackageSet } from '../src/formats/entities';
import { HardpointAttacher } from '../src/game/weapons/hardpoints';
import { THROWABLE_BONE, ThrowableCarry, throwableAfterEmpty } from '../src/game/weapons/back-throwable';
import { clipMarks } from '../src/game/weapons/system';
import { tpl, weaponDef } from '../src/game/weapons/data';

test('back throwable: the next one at 0 is the highest p45 above -1, ties keep the first', () => {
  const owned = [
    { k: 'flare', p: 4294967295 },
    { k: 'flashbang', p: 2 },
    { k: 'tnt', p: 3 },
    { k: 'molotov', p: 4 },
  ];
  assert.equal(throwableAfterEmpty(owned, (d) => d.p)?.k, 'molotov');
  assert.equal(throwableAfterEmpty([...owned, { k: 'shrapnel', p: 5 }], (d) => d.p)?.k, 'shrapnel');
  assert.equal(throwableAfterEmpty([owned[0]], (d) => d.p), null, 'p45 = -1 (the flare) is never taken out');
  assert.equal(throwableAfterEmpty([], () => 1), null);
  assert.equal(throwableAfterEmpty([{ k: 'a', p: 3 }, { k: 'b', p: 3 }], (d) => d.p)?.k, 'a');
});

/** A carrier with `n` bones under its root (bone i at x = i cm). */
function carrier(scene: THREE.Object3D, n = 52): Character {
  const root = new THREE.Group();
  const bones = Array.from({ length: n }, (_, i) => {
    const b = new THREE.Bone();
    b.position.set(i / 100, 1, 0);
    root.add(b);
    return b;
  });
  scene.add(root);
  return { root, skeleton: { bones } } as unknown as Character;
}
const world = (o: THREE.Object3D) => {
  o.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
};

test('back throwable: one copy on the body and one on the arms, swapped on selection, moved to the hand by the throw', () => {
  const scene = new THREE.Scene();
  const body = carrier(scene), arms = carrier(scene);
  const pivot = new THREE.Group();
  scene.add(pivot);
  const at = new HardpointAttacher(new Map() as unknown as PackageSet);
  let built = 0;
  const carry = new ThrowableCarry(at, () => {
    built++;
    return new THREE.Group();
  });
  const rig = { body, arms, armsParent: pivot };
  const molotov: ResRef = { pkg: 4, id: 71 }, tnt: ResRef = { pkg: 4, id: 24 };

  carry.syncBack(rig, { key: '4:249', model: molotov });
  assert.equal(carry.backKey, '4:249');
  const [tp, fp] = carry.backMeshes;
  assert.equal(tp.parent, body.root, 'third-person copy under the body (hidden with it in first person)');
  assert.equal(fp.parent, pivot, 'first-person copy under the arms pivot');
  assert.equal(at.boneOf(tp), body.skeleton.bones[THROWABLE_BONE]);
  assert.equal(at.boneOf(fp), arms.skeleton.bones[THROWABLE_BONE]);
  assert.ok(world(tp).distanceTo(new THREE.Vector3(0.51, 1, 0)) < 1e-6, 'identity matrix in the bone frame');

  // Same selection: nothing rebuilt. New selection: the old one is put away first.
  carry.syncBack(rig, { key: '4:249', model: molotov });
  assert.equal(built, 2);
  carry.syncBack(rig, { key: '4:236', model: tnt });
  assert.equal(built, 4);
  assert.equal(tp.parent, null, 'the previous one is gone');
  assert.equal(at.isAttached(tp), false);

  // AttachThrownWeapon: the carried one goes to the marker's bone (35); the back is empty until
  // the next sync takes another out.
  const [tp2] = carry.backMeshes;
  assert.ok(carry.toHand(35));
  assert.equal(carry.backKey, null);
  assert.equal(carry.handKey, '4:236');
  assert.equal(at.boneOf(tp2), body.skeleton.bones[35]);
  carry.syncBack(rig, { key: '4:236', model: tnt });
  assert.equal(carry.backMeshes.length, 2, 'the next of the same item on the back while one is in the hand');
  // ThrowWeapon: the hand's one leaves.
  carry.releaseHand();
  assert.equal(carry.handKey, null);
  assert.equal(tp2.parent, null);
  assert.equal(carry.toHand(35) && carry.handKey, '4:236');
  assert.equal(carry.toHand(35), false, 'nothing on the back: nothing to take');

  // Nothing selected (count 0, creature form): nothing on the back. A new body rebuilds.
  carry.syncBack(rig, null);
  assert.equal(carry.backMeshes.length, 0);
  carry.syncBack(rig, { key: '4:249', model: molotov });
  const before = carry.backMeshes[0];
  const body2 = carrier(scene);
  carry.syncBack({ body: body2, arms, armsParent: pivot }, { key: '4:249', model: molotov });
  assert.notEqual(carry.backMeshes[0], before);
  assert.equal(carry.backMeshes[0].parent, body2.root);
  // Without arms (no first-person rig) only the body copy.
  carry.syncBack({ body: body2 }, { key: '4:249', model: molotov });
  assert.equal(carry.backMeshes.length, 1);
  carry.dispose();
  assert.equal(carry.backKey, null);
  assert.equal(carry.handKey, null);
});

let cache: Map<number, Record<string, unknown>> | undefined;
function packages() {
  if (cache) return cache;
  const out = new Map<number, Record<string, unknown>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu', 'adu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p);
  }
  return (cache = out);
}

test('back throwable data: Player p119 = 51 on both rigs, the throw markers, p45 and the thrown models', { skip }, () => {
  const all = packages();
  const epk = all as unknown as EntityPackageSet, pkgs = all as unknown as PackageSet;
  assert.equal(tpl(epk, { pkg: 2, id: 5 })?.v[119], THROWABLE_BONE);
  // The first-person swap keeps the attachments when the bone count is unchanged (EXE 0x46d3bd).
  const body = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!, arms = readSkinnedModel(pkgs, { pkg: 2, id: 138 })!;
  assert.equal(body.skeleton.bones.length, arms.skeleton.bones.length);
  assert.equal(body.skeleton.bones[51].parent, 3, 'a child of spine bone 3');
  assert.equal(arms.skeleton.bones[51].hash, body.skeleton.bones[51].hash);
  const b51 = body.skeleton.bones[51].bindWorld;
  assert.ok(b51[12] > 0.1 && b51[13] > 1.2 && b51[14] > 0.03, 'right side, behind the spine (model faces -Z)');

  // The throw clips: AttachThrownWeapon (231) on the right-hand bone 35, then ThrowWeapon (230).
  for (const [clip, grab, release] of [[534, 0.184, 0.961], [107, 0.184, 0.961], [170, 0.195, 1.001], [171, 0.245, 0.971]] as const) {
    const m = clipMarks(pkgs, { pkg: 2, id: clip });
    const a = m.find((x) => x.param === 231)!, r = m.find((x) => x.param === 230)!;
    assert.ok(Math.abs(a.time - grab) < 2e-3 && Math.abs(r.time - release) < 2e-3, `2:${clip}`);
    assert.equal(body.skeleton.byHash.get(a.boneHash), 35);
    assert.equal(body.skeleton.byHash.get(r.boneHash), 35);
  }

  // p45 picks Shrapnel > Molotov > TNT > Flash/Bang; the flare (-1) is never taken out.
  const keys = ['4:284', '4:249', '4:655', '4:236', '4:455'];
  const defs = keys.map((k) => weaponDef(epk, { pkg: 4, id: Number(k.split(':')[1]) })!);
  const p45 = (d: (typeof defs)[number]) => tpl(epk, d.template)?.v[45] as number;
  assert.equal(throwableAfterEmpty(defs, p45)?.key, '4:655');
  assert.equal(throwableAfterEmpty(defs.filter((d) => d.key !== '4:655'), p45)?.key, '4:249');
  assert.equal(throwableAfterEmpty(defs.filter((d) => d.key === '4:455'), p45), null);
  // What is carried is the thrown object (Missile Item p55's model), which has geometry.
  for (const d of defs) {
    assert.ok(d.thrown?.model, d.name);
    assert.ok(readModel(pkgs, d.thrown!.model!)?.submeshes.length, `${d.name} ${d.thrown!.model!.pkg}:${d.thrown!.model!.id}`);
  }
  assert.deepEqual(defs.find((d) => d.key === '4:455')!.thrown!.model, { pkg: 4, id: 283 }, 'the flare carries its thrown object, not the pickup model 4:112');
});
