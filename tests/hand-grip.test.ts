// Enhanced option "Close Hand on Weapon" (game/actors/hand-grip.ts, docs/enhanced.md): off by
// default, not in the original. The third-person idle / walk clips leave the right hand open about
// the weapon bone 35 (docs/game-logic.md §4.5 "Held weapon grip"); the option blends the finger
// bones towards the armed run's fist. Data checks use the local install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import { fingerBones, gripPose, handGripOption, stepGripWeight, HAND_GRIP_BLEND } from '../src/game/actors/hand-grip';
import { buildAnimationClip } from '../src/app/character';
import { readDbId, type PackageSet } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { readSkinnedModel, type SkinnedModel } from '../src/formats/skeleton';
import { sampleTrackRotation, sampleTrackTranslation, type AnimClipData } from '../src/formats/animation';
import { loadClip } from '../src/game/actors/clipmap';

test('hand grip: off by default', () => {
  assert.equal(handGripOption.enabled, false);
});

test('hand grip: the fingers are the hand bone\'s descendants outside the weapon bone', () => {
  // 0 root, 1 hand, 2 weapon, 3 weapon child, 4..5 a finger, 6 the other hand.
  const parents = [-1, 0, 1, 2, 1, 4, 0];
  assert.deepEqual(fingerBones(parents, 1, 2), [4, 5]);
  assert.deepEqual(fingerBones(parents, 6, 2), []);
});

test('hand grip: eases in and out over HAND_GRIP_BLEND', () => {
  let w = 0;
  w = stepGripWeight(w, 1, HAND_GRIP_BLEND / 2);
  assert.ok(Math.abs(w - 0.5) < 1e-9);
  w = stepGripWeight(w, 1, HAND_GRIP_BLEND);
  assert.equal(w, 1);
  assert.equal(stepGripWeight(1, 0, HAND_GRIP_BLEND * 2), 0);
});

test('hand grip: the grip pose is the clip\'s finger rotation at t', () => {
  const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1);
  const clip = new THREE.AnimationClip('c', 1, [new THREE.QuaternionKeyframeTrack('f.quaternion', [0, 1], [...q0.toArray(), ...q1.toArray()])]);
  const bone = Object.assign(new THREE.Bone(), { name: 'f' });
  const g = gripPose(clip, [new THREE.Bone(), bone], [1], 0.5);
  assert.ok(g.get(1)!.angleTo(new THREE.Quaternion().slerpQuaternions(q0, q1, 0.5)) < 1e-6);
  assert.equal(gripPose(clip, [new THREE.Bone(), bone], [0]).size, 0, 'bones the clip does not key keep their pose');
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

/** Centre of the right hand's skin (palm 34, fingers) in bone 35's frame: `clip` at 0, finger rotations overridden. */
function fist(sk: SkinnedModel, clip: AnimClipData, over: Map<number, THREE.Quaternion>): number {
  const byBone = new Map<number, AnimClipData['tracks'][number]>();
  for (const tr of clip.tracks) {
    const bi = sk.skeleton.byHash.get(tr.boneHash);
    if (bi !== undefined) byBone.set(bi, tr);
  }
  const world: THREE.Matrix4[] = [];
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  for (const b of sk.skeleton.bones) {
    p.fromArray(b.position);
    q.fromArray(b.quaternion);
    const tr = byBone.get(b.index);
    if (tr) {
      q.fromArray(sampleTrackRotation(clip, 0, tr.boneHash));
      p.fromArray(tr.translations ? sampleTrackTranslation(clip, 0, tr.boneHash) : tr.constantTranslation);
    }
    if (over.has(b.index)) q.copy(over.get(b.index)!);
    const local = new THREE.Matrix4().compose(p, q, one);
    world[b.index] = b.parent < 0 ? local : world[b.parent].clone().multiply(local);
  }
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
    if (dom === 34 || (dom >= 36 && dom <= 47)) (sum.add(acc.applyMatrix4(toWeapon)), n++);
  }
  return sum.multiplyScalar(1 / n).length() * 100;
}

test('hand grip on the player rig 2:9: fingers 36..47 of hand 34; the walk\'s open hand closes on bone 35 with the armed run\'s fist', { skip }, () => {
  const pkgs = packages();
  const sk = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!;
  assert.ok(sk);
  const parents = sk.skeleton.bones.map((b) => b.parent);
  assert.equal(parents[35], 34, 'weapon bone 35 hangs off hand 34');
  const fingers = fingerBones(parents, 34, 35);
  assert.deepEqual(fingers, Array.from({ length: 12 }, (_, i) => 36 + i));
  const walk = loadClip(pkgs, { pkg: 2, id: 30 })!, run = loadClip(pkgs, { pkg: 2, id: 28 })!;
  const bones = sk.skeleton.bones.map((b) => Object.assign(new THREE.Bone(), { name: b.name }));
  const grip = gripPose(buildAnimationClip(run, sk.skeleton), bones, fingers);
  assert.equal(grip.size, 12, 'the armed run keys every finger');
  const open = fist(sk, walk, new Map()), closed = fist(sk, walk, grip);
  assert.ok(open > 3.5, `walk 2:30: open hand ${open.toFixed(1)} cm from bone 35`);
  assert.ok(closed < 0.6 * open, `with the grip: ${closed.toFixed(1)} cm`);
});
