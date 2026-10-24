// The per-object light choice (engine-light.ts objectLightSet) after its allocation-free rewrite
// (docs/perf.md): the same slots as ranking every light by influence with a stable sort and
// keeping the best five, ties included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { engineLightInternals, engineLights, type EnginePointLight } from '../src/app/engine-light';
import { pointLightCullRadius, pointLightInfluence, SHADER_POINT_LIGHTS } from '../src/formats/render-data';

/** The choice as it was written before (every light ranked, stable sort, best five). */
function reference(lights: EnginePointLight[], uploaded: number[], centre: THREE.Vector3, radius: number): number[] {
  const rank: { slot: number; influence: number }[] = [];
  uploaded.forEach((li, slot) => {
    const l = lights[li];
    const rgb = [l.r, l.g, l.b];
    const d2 = (l.x - centre.x) ** 2 + (l.y - centre.y) ** 2 + (l.z - centre.z) ** 2;
    const influence = pointLightInfluence(l.intensity, rgb, d2, pointLightCullRadius(l.intensity, rgb) + radius);
    if (influence > 0) rank.push({ slot, influence });
  });
  rank.sort((x, y) => y.influence - x.influence);
  return Array.from({ length: SHADER_POINT_LIGHTS }, (_, k) => (k < rank.length ? rank[k].slot : -1));
}

test('objectLightSet keeps the five strongest lights in stable order', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lights: EnginePointLight[] = [];
  for (let i = 0; i < 24; i++) {
    // Pairs of identical lights: equal influences must keep their upload order.
    const base = { x: rnd() * 20 - 10, y: rnd() * 4, z: rnd() * 20 - 10, intensity: 1 + rnd() * 30, r: rnd(), g: rnd(), b: rnd(), hemi: 0, baked: true };
    lights.push(base, { ...base });
  }
  const off = engineLights.addProvider((out) => out.push(...lights));
  try {
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    scene.add(cam);
    engineLights.update(scene, cam, null, null);
    // The rig uploads at most MAX_POINTS, nearest first: read back which light went to which slot.
    const { pointA } = engineLightInternals();
    const n = engineLights.stats.points;
    const uploaded = Array.from({ length: n }, (_, s) => lights.findIndex((l) => l.x === pointA[s].x && l.y === pointA[s].y && l.z === pointA[s].z && l.intensity === pointA[s].w));
    assert.ok(n > 8 && uploaded.every((i) => i >= 0), 'lights uploaded and matched');
    let lit = 0;
    for (let k = 0; k < 40; k++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2 + rnd() * 2));
      mesh.position.set(rnd() * 20 - 10, rnd() * 4, rnd() * 20 - 10);
      mesh.updateMatrixWorld(true);
      const set = engineLights.objectLightSet(mesh);
      const got = [set.points.x, set.points.y, set.points.z, set.points.w, set.point5];
      const g = mesh.geometry;
      g.computeBoundingSphere();
      const sphere = g.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
      // Same budget as the rig (no spots / directionals here): all five point slots.
      assert.deepEqual(got, reference(lights, uploaded, sphere.center, sphere.radius), `object ${k}`);
      if (got.filter((x) => x >= 0).length >= 3) lit++;
    }
    assert.ok(lit > 10, `objects with three or more lights: ${lit}`);
  } finally {
    off();
  }
});
