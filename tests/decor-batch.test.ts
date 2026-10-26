// Merged draws of skinned decorations (actors/decor-batch.ts, docs/perf.md Perf D): the merged
// geometry repeats the model per member with its skin indices moved into that member's bones,
// and a member not drawn this frame gets zero bone matrices (its triangles collapse).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { BatchSkeleton, mergeMembers } from '../src/game/actors/decor-batch';

function model(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0]), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0]), 4));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  return g;
}

test('merged geometry: the model per member, skin indices per member, one group per material', () => {
  const g = mergeMembers(model(), 3, 2);
  assert.equal(g.getAttribute('position').count, 12);
  assert.deepEqual([...(g.getAttribute('lightSlot').array as Float32Array)], [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  const si = g.getAttribute('skinIndex').array as Uint16Array;
  // Member 2's first vertex: bone 0 of the model -> bone 4 of the merged skeleton.
  assert.deepEqual([...si.subarray(32, 36)], [4, 4, 4, 4]);
  assert.deepEqual([...si.subarray(20, 24)], [3, 2, 2, 2]);
  assert.deepEqual([...(g.getAttribute('skinWeight').array as Float32Array).subarray(40, 44)], [0.5, 0.5, 0, 0]);
  assert.deepEqual(g.groups.map((x) => [x.start, x.count, x.materialIndex]), [[0, 9, 0], [9, 9, 1]]);
  assert.deepEqual([...(g.index!.array as Uint32Array)], [0, 1, 2, 4, 5, 6, 8, 9, 10, 1, 3, 2, 5, 7, 6, 9, 11, 10]);
});

test('a member not drawn gets zero bone matrices; a drawn one bone world x inverse', () => {
  const bones = Array.from({ length: 4 }, () => new THREE.Bone());
  bones.forEach((b, i) => {
    b.position.set(i, 2 * i, -i);
    b.rotation.set(0.1 * i, 0.2, 0);
    b.updateMatrixWorld(true);
  });
  const inverses = bones.map((_, i) => new THREE.Matrix4().makeTranslation(-i, 0, 1));
  const members = [{ merged: true, drawn: true }, { merged: true, drawn: false }];
  const sk = new BatchSkeleton(bones, inverses, 2, members);
  sk.update();
  const m = sk.boneMatrices!;
  for (let k = 0; k < 2; k++) {
    const want = new THREE.Matrix4().multiplyMatrices(bones[k].matrixWorld, inverses[k]).toArray();
    assert.deepEqual([...m.subarray(16 * k, 16 * k + 16)], [...new Float32Array(want)]);
  }
  assert.ok(m.subarray(32, 64).every((v) => v === 0));
  members[1].drawn = true;
  members[0].merged = false;
  sk.update();
  assert.ok(m.subarray(0, 32).every((v) => v === 0));
  assert.ok(m.subarray(32, 64).some((v) => v !== 0));
});
