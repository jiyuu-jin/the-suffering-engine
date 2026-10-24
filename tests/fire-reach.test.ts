// FireObj.reach (fx/effects.ts): the quick reject of the fire contact test (docs/perf.md) must
// hold every point of the drawn bounding box, whatever the placement, camera turn and growth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { FireObj } from '../src/game/fx/effects';
import type { DynamicObject } from '../src/game/world/dynamic';

test('every point of a fire box lies within its reach of the model origin', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0; k < 200; k++) {
    const root = new THREE.Object3D();
    const f = new FireObj({ root, uid: k } as unknown as DynamicObject, [], new THREE.Matrix4(), k);
    f.bounds = {
      corner: [rnd() * 2, rnd() * 2, rnd() * 2],
      edges: [
        [rnd() * 3, rnd() * 0.5, rnd() * 0.5],
        [rnd() * 0.5, rnd() * 3, rnd() * 0.5],
        [rnd() * 0.5, rnd() * 0.5, rnd() * 3],
      ],
    };
    const M = root.matrix
      .makeRotationFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3))
      .multiply(new THREE.Matrix4().makeScale(0.1 + Math.abs(rnd()) * 3, 0.1 + Math.abs(rnd()) * 3, 0.1 + Math.abs(rnd()) * 3))
      .setPosition(rnd() * 50, rnd() * 50, rnd() * 50);
    const o = new THREE.Vector3().setFromMatrixPosition(M);
    const reach = f.reach();
    const b = f.bounds;
    for (let i = 0; i < 64; i++) {
      const t = [Math.abs(rnd()), Math.abs(rnd()), Math.abs(rnd())];
      if (i < 8) for (let a = 0; a < 3; a++) t[a] = (i >> a) & 1;
      const p = new THREE.Vector3(...b.corner);
      for (let a = 0; a < 3; a++) p.add(new THREE.Vector3(...b.edges[a]).multiplyScalar(t[a]));
      p.applyMatrix4(M);
      assert.ok(p.distanceTo(o) <= reach + 1e-9, `fire ${k}: ${p.distanceTo(o)} > ${reach}`);
    }
  }
});
