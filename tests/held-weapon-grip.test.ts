// Where a held weapon sits in the hand (docs/game-logic.md §4.5 "Held weapon grip").
// The engine draws an attached object in its bone's posed frame with an identity attachment
// matrix (SUFFERING.EXE skinned-instance vtable 0x591588: slot 6 0x46d9d0 attaches, slot 5
// 0x46b5d0 would set the matrix and is never called for weapons; per frame 0x4701c0 composes
// matrix x bone world). The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import type { Character } from '../src/app/character';
import { readDbId, type PackageSet, type ResRef } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { readSkinnedModel, type SkinnedModel } from '../src/formats/skeleton';
import { sampleTrackRotation, sampleTrackTranslation, type AnimClipData } from '../src/formats/animation';
import { loadClip } from '../src/game/actors/clipmap';
import { HardpointAttacher } from '../src/game/weapons/hardpoints';

test('held weapon: model space lands in the bone frame, no offset, own scale kept', () => {
  const scene = new THREE.Scene();
  // A carrier turned, moved and scaled like a placed body, with a two-bone arm.
  const root = new THREE.Group();
  root.position.set(4, 1, -2);
  root.rotation.y = 0.7;
  root.scale.setScalar(1.1);
  const hand = new THREE.Bone(), weapon = new THREE.Bone();
  hand.position.set(0.44, 1.17, -0.02);
  hand.quaternion.setFromEuler(new THREE.Euler(-1.2, 0.3, 0.1));
  weapon.position.set(-0.108, 0.03, -0.007);
  weapon.quaternion.set(1, -0.012, 0, 0).normalize();
  hand.add(weapon);
  root.add(hand);
  scene.add(root);
  const carrier = { root, skeleton: { bones: [hand, weapon] } } as unknown as Character;

  // The weapons system hangs the held model under the body's root, at its own scale.
  const gun = new THREE.Object3D();
  gun.scale.setScalar(1);
  root.add(gun);
  const at = new HardpointAttacher(new Map() as unknown as PackageSet);
  assert.ok(at.attach(gun, carrier, { bone: 1 }));
  at.updateCarriers(carrier);

  gun.updateWorldMatrix(true, false);
  weapon.updateWorldMatrix(true, false);
  const toBone = weapon.matrixWorld.clone().invert();
  for (const p of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(-0.355, 0, 0.1), new THREE.Vector3(0.05, 0.03, -0.089)]) {
    const inBone = p.clone().applyMatrix4(gun.matrixWorld).applyMatrix4(toBone);
    assert.ok(inBone.distanceTo(p) < 1e-6, `model point ${p.toArray()} is drawn at the same point of the bone frame`);
  }
  // A non-unit object scale stays on top of the bone frame (the carrier's scale is in the bone).
  gun.scale.setScalar(2);
  gun.updateMatrix();
  at.attach(gun, carrier, { bone: 1 });
  gun.updateWorldMatrix(true, false);
  const q = new THREE.Vector3(0.1, 0, 0).applyMatrix4(gun.matrixWorld).applyMatrix4(toBone);
  assert.ok(q.distanceTo(new THREE.Vector3(0.2, 0, 0)) < 1e-6);
});

let cache: PackageSet | undefined;
function packages(): PackageSet {
  if (cache) return cache;
  const out = new Map<number, Record<string, unknown>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['mdu', 'adu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p);
  }
  return (cache = out as unknown as PackageSet);
}

/** Bone world matrices (model space) of `sk` posed by `clip` at time t with the engine's sampler rule. */
function pose(sk: SkinnedModel, clip?: AnimClipData, t = 0): THREE.Matrix4[] {
  const byBone = new Map<number, AnimClipData['tracks'][number]>();
  if (clip) for (const tr of clip.tracks) {
    const bi = sk.skeleton.byHash.get(tr.boneHash);
    if (bi !== undefined) byBone.set(bi, tr);
  }
  const world: THREE.Matrix4[] = [];
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  for (const b of sk.skeleton.bones) {
    p.fromArray(b.position);
    q.fromArray(b.quaternion);
    const tr = byBone.get(b.index);
    if (tr && clip) {
      q.fromArray(sampleTrackRotation(clip, t, tr.boneHash));
      p.fromArray(tr.translations ? sampleTrackTranslation(clip, t, tr.boneHash) : tr.constantTranslation);
    }
    const local = new THREE.Matrix4().compose(p, q, one);
    world[b.index] = b.parent < 0 ? local : world[b.parent].clone().multiply(local);
  }
  return world;
}

/** Centre of the right hand's skin (palm 34 and fingers 36..47) in the weapon bone's (35) frame. */
function fistInWeaponFrame(pkgs: PackageSet, model: ResRef, clipRef: ResRef): THREE.Vector3 {
  const sk = readSkinnedModel(pkgs, model)!;
  const clip = loadClip(pkgs, clipRef)!;
  assert.ok(sk && clip, `model ${model.pkg}:${model.id} / clip ${clipRef.pkg}:${clipRef.id}`);
  const world = pose(sk, clip);
  const skin = world.map((w, i) => w.clone().multiply(new THREE.Matrix4().fromArray(sk.skeleton.bones[i].inverseBind)));
  const toWeapon = world[35].clone().invert();
  const pos = sk.model.positions, sum = new THREE.Vector3(), v = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    let dom = -1, dw = 0;
    const acc = new THREE.Vector3();
    for (let k = 0; k < 4; k++) {
      const w = sk.skinWeight[i * 4 + k];
      if (!w) continue;
      const b = sk.skinIndex[i * 4 + k];
      if (w > dw) ((dw = w), (dom = b));
      acc.addScaledVector(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(skin[b]), w);
    }
    if (dom === 34 || (dom >= 36 && dom <= 47)) {
      sum.add(acc.applyMatrix4(toWeapon));
      n++;
    }
  }
  return sum.multiplyScalar(1 / n);
}

test('player rig: bone 35 is the right hand weapon bone; its bind chain matches its inverse bind', { skip }, () => {
  const sk = readSkinnedModel(packages(), { pkg: 2, id: 9 })!;
  const b = sk.skeleton.bones;
  assert.equal(b[35].parent, 34);
  assert.deepEqual(b[35].children, []);
  const chain = pose(sk)[35];
  const bind = new THREE.Matrix4().fromArray(b[35].bindWorld);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(chain.elements[i] - bind.elements[i]) < 1e-4, `bind element ${i}`);
});

test('the fist sits on the weapon bone in the weapon clips, not in the shared idle / walk', { skip }, () => {
  const pkgs = packages();
  const body = { pkg: 2, id: 9 }, arms = { pkg: 2, id: 138 };
  // Clips made for holding a gun: the armed run (revolver p20), the aim hold (p119), the
  // shot (p120), the shotgun / tommy gun runs and the first-person revolver hold (p61).
  for (const [m, c] of [[body, 28], [body, 283], [body, 278], [body, 413], [body, 416], [arms, 270]] as const) {
    const d = fistInWeaponFrame(pkgs, m, { pkg: 2, id: c }).length();
    assert.ok(d < 0.02, `clip 2:${c}: fist centre ${(d * 100).toFixed(1)} cm from the weapon bone`);
  }
  // Idle p13 = 2:27 and walk p18 = 2:30 of every weapon are the unarmed clips (open hand): the
  // weapon bone stays at the rig's bind, ~4 cm from the hand's centre, as in the original.
  for (const c of [27, 30]) {
    const d = fistInWeaponFrame(pkgs, body, { pkg: 2, id: c }).length();
    assert.ok(d > 0.035 && d < 0.05, `clip 2:${c}: ${(d * 100).toFixed(1)} cm`);
  }
});

test('first-person sets move the weapon bone into the fist; third-person clips keep the bind', { skip }, () => {
  const pkgs = packages();
  const sk = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!;
  const h35 = sk.skeleton.bones[35].hash;
  const t35 = (id: number) => {
    const clip = loadClip(pkgs, { pkg: 2, id })!;
    const tr = clip.tracks.find((t) => t.boneHash === h35)!;
    return new THREE.Vector3().fromArray(tr.translations ? sampleTrackTranslation(clip, 0, h35) : tr.constantTranslation);
  };
  const bind = new THREE.Vector3().fromArray(sk.skeleton.bones[35].position);
  for (const id of [27, 28, 30, 283, 278]) assert.ok(t35(id).distanceTo(bind) < 0.003, `third-person 2:${id} keeps the bind`);
  for (const id of [270, 288, 476]) assert.ok(t35(id).distanceTo(bind) > 0.02, `first-person 2:${id} moves bone 35`);
});
