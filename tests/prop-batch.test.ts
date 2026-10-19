// Static prop batching (src/app/prop-batch.ts): unchanged props are drawn from the merged
// mesh (their own mesh hidden), a prop that moves / swaps material / hides is drawn on its own
// again, and it merges back once it has been back in its snapshot state for a while.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { StaticBatch, batchable } from '../src/app/prop-batch';

function scene(n: number) {
  const root = new THREE.Scene();
  const mat = new THREE.MeshStandardNodeMaterial();
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.clearGroups();
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(4 * g.getAttribute('position').count).fill(0.5), 4));
    const m = new THREE.Mesh(g, mat);
    m.position.set(3 * i, 0, 0);
    m.rotation.y = i;
    root.add(m);
    meshes.push(m);
  }
  root.updateMatrixWorld(true);
  return { root, mat, meshes };
}

const batchOf = (b: StaticBatch) => b.group.children[0] as THREE.Mesh;

test('merged props are drawn from the batch in world space', () => {
  const { root, meshes } = scene(3);
  const b = new StaticBatch(meshes, root);
  b.update(null);
  assert.equal(b.stats.members, 3);
  assert.equal(b.stats.merged, 3);
  for (const m of meshes) assert.equal(m.layers.mask, 0);
  const bm = batchOf(b);
  assert.equal(bm.visible, true);
  assert.equal(bm.geometry.drawRange.count, 3 * 36);
  // First vertex of the second box = its own vertex through its world matrix.
  const p = new THREE.Vector3().fromBufferAttribute(meshes[1].geometry.getAttribute('position') as THREE.BufferAttribute, 0).applyMatrix4(meshes[1].matrixWorld);
  const q = new THREE.Vector3().fromBufferAttribute(bm.geometry.getAttribute('position') as THREE.BufferAttribute, 24);
  assert.ok(p.distanceTo(q) < 1e-5);
  // Normals rotate with the prop.
  const n = new THREE.Vector3().fromBufferAttribute(meshes[1].geometry.getAttribute('normal') as THREE.BufferAttribute, 0).transformDirection(meshes[1].matrixWorld);
  const nb = new THREE.Vector3().fromBufferAttribute(bm.geometry.getAttribute('normal') as THREE.BufferAttribute, 24);
  assert.ok(n.distanceTo(nb) < 1e-5);
});

test('a changed prop leaves the batch and merges back once at rest', () => {
  const { root, meshes } = scene(2);
  const b = new StaticBatch(meshes, root);
  b.update(null);
  const door = meshes[0];
  door.rotation.y += 1;
  root.updateMatrixWorld();
  b.update(null);
  assert.equal(door.layers.mask, 1, 'drawn on its own');
  assert.equal(batchOf(b).geometry.drawRange.count, 36, 'only the other prop is batched');
  door.rotation.y -= 1;
  root.updateMatrixWorld();
  let frames = 0;
  while (door.layers.mask !== 0 && frames < 1000) (b.update(null), frames++);
  assert.ok(frames > 1 && frames < 1000, `merged again after ${frames} frames`);
  assert.equal(batchOf(b).geometry.drawRange.count, 72);
});

test('hidden or re-materialed props are not batched; transparent ones never', () => {
  const { root, meshes, mat } = scene(3);
  const glass = meshes[2];
  glass.material = mat.clone();
  (glass.material as THREE.Material).transparent = true;
  assert.equal(batchable(glass), false);
  const b = new StaticBatch(meshes, root);
  b.update(null);
  assert.equal(b.stats.members, 2);
  meshes[0].visible = false;
  meshes[1].material = mat.clone();
  b.update(null);
  assert.equal(b.stats.merged, 0);
  assert.equal(batchOf(b).visible, false);
  assert.equal(meshes[1].layers.mask, 1);
  b.dispose();
  for (const m of meshes) assert.equal(m.layers.mask, 1);
});
