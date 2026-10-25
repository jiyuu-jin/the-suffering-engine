// The player's held weapon is placed from this frame's hand pose before the draw
// (HardpointAttacher.updateCarriers; docs/game-logic.md §4.5 "Held weapon placement").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { Character } from '../src/app/character';
import type { PackageSet } from '../src/formats/model';
import { HardpointAttacher } from '../src/game/weapons/hardpoints';

function carrier(scene: THREE.Scene): Character {
  const root = new THREE.Group();
  const hand = new THREE.Bone();
  root.add(hand);
  scene.add(root);
  return { root, skeleton: { bones: [hand] } } as unknown as Character;
}

const world = (o: THREE.Object3D) => {
  o.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
};

test('hardpoints: updateCarriers places the carried objects from the pose now, others wait for update()', () => {
  const scene = new THREE.Scene();
  const player = carrier(scene), npc = carrier(scene);
  const at = new HardpointAttacher(new Map() as unknown as PackageSet);
  // The gun hangs under the body's root (as the weapons system adds it), the NPC's under the scene.
  const gun = new THREE.Object3D(), club = new THREE.Object3D();
  player.root.add(gun);
  scene.add(club);
  assert.ok(at.attach(gun, player, { bone: 0 }));
  assert.ok(at.attach(club, npc, { bone: 0 }));

  // The player's update moves the body and poses the hand (before the draw).
  player.root.position.set(0, 0, 1);
  player.skeleton.bones[0].position.set(0.3, 1.1, -0.2);
  npc.skeleton.bones[0].position.set(0, 2, 0);
  at.updateCarriers(player, undefined);
  assert.ok(world(gun).distanceTo(new THREE.Vector3(0.3, 1.1, 0.8)) < 1e-6, 'gun on this frame’s hand');
  assert.ok(world(club).distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-6, 'other carriers untouched');
  at.update();
  assert.ok(world(club).distanceTo(new THREE.Vector3(0, 2, 0)) < 1e-6);
  assert.ok(world(gun).distanceTo(new THREE.Vector3(0.3, 1.1, 0.8)) < 1e-6, 'placing twice is idempotent');

  // A carrier out of the scene is skipped (update() detaches it).
  player.root.removeFromParent();
  player.skeleton.bones[0].position.set(9, 9, 9);
  at.updateCarriers(player);
  assert.ok(world(gun).distanceTo(new THREE.Vector3(0.3, 1.1, 0.8)) < 1e-6);
});
