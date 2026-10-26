// hipsWorldPosition (actors/manager.ts, docs/perf.md Perf D): the actor culling's hips position
// without matrix writes must equal Object3D.getWorldPosition, whatever the chain's transforms,
// with a scene whose world matrix is not auto-updated and a node without matrixAutoUpdate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { hipsWorldPosition } from '../src/game/actors/manager';

test('hips world position matches getWorldPosition and writes no matrix', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const pose = (o: THREE.Object3D) => {
    o.position.set(rnd() * 50, rnd() * 50, rnd() * 50);
    o.quaternion.set(rnd(), rnd(), rnd(), rnd()).normalize();
    const s = 0.5 + Math.abs(rnd());
    o.scale.set(s, s * (rnd() > 0 ? 1 : 1.3), s);
  };
  for (let k = 0; k < 200; k++) {
    const scene = new THREE.Scene();
    pose(scene);
    scene.updateMatrixWorld(true);
    scene.matrixWorldAutoUpdate = false;
    const group = new THREE.Group(), root = new THREE.Group(), mesh = new THREE.Object3D(), b0 = new THREE.Bone(), hips = new THREE.Bone();
    scene.add(group);
    group.add(root);
    root.add(mesh);
    mesh.add(b0);
    b0.add(hips);
    for (const o of [group, root, mesh, b0, hips]) pose(o);
    if (k % 3 === 0) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.compose(new THREE.Vector3(rnd(), rnd(), rnd()), new THREE.Quaternion(rnd(), rnd(), rnd(), rnd()).normalize(), new THREE.Vector3(1, 2, 1));
      // Without the flag three.js keeps its (stale) world matrix; with it, recomputes it.
      mesh.matrixWorldNeedsUpdate = k % 2 === 0;
    }
    if (k % 5 === 0) {
      group.updateMatrixWorld(true);
      group.matrixWorldAutoUpdate = false;
      pose(group); // its stale matrixWorld is what three.js uses
    }
    const before = hips.matrixWorld.clone();
    const got = hipsWorldPosition(hips, new THREE.Vector3());
    assert.ok(hips.matrixWorld.equals(before), 'no matrix written');
    const want = hips.getWorldPosition(new THREE.Vector3());
    assert.ok(got.distanceTo(want) < 1e-9 * (1 + want.length()), `${k}: ${got.toArray()} vs ${want.toArray()}`);
  }
});
