// Enhanced: Killjoy's projector beams as a soft fan (enhanced/projector-beam.ts, docs/enhanced.md
// "Projector beams"). Original keeps the decoded thin-ray cones (docs/game-logic.md §15.7.8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { beamVolume, fitBeamCone, PROJECTOR_BEAM, ProjectorBeamFx } from '../src/app/enhanced/projector-beam';
import { emptyLightVolume, lightVolumeScene, shapeDensity } from '../src/app/enhanced/light-volume';

/** Ray ends on an ellipse (2 x 1 m) in the plane z = -4, seen from a lens at the origin. */
const outline = (n = 24, z = -4) => Array.from({ length: n }, (_, i) => new THREE.Vector3(2 * Math.cos((2 * Math.PI * i) / n) + 0.5, Math.sin((2 * Math.PI * i) / n), z));

test('projector beam: the cone runs from the lens to the outline its rays end on', () => {
  const k = fitBeamCone(new THREE.Vector3(), outline())!;
  assert.ok(k);
  // (The axis points at the outline's centre, so the off-centre plane is a little oblique to it.)
  assert.ok(k.length >= 4 && k.length < 4.4, `length ${k.length}`);
  assert.ok(k.axis.z < -0.98, 'towards the outline');
  const [a, b] = [k.rx, k.ry].sort((x, y) => y - x);
  assert.ok(Math.abs(a - 2) < 0.2 && Math.abs(b - 1) < 0.1, `the outline's section (${a}, ${b})`);
  assert.equal(fitBeamCone(new THREE.Vector3(), outline().slice(0, 2)), null, 'too few rays');
});

test('projector beam: a soft volume, faded near the eye and capped, flickering with the opacity', () => {
  const k = fitBeamCone(new THREE.Vector3(), outline())!;
  const s = beamVolume(k, 0.5, emptyLightVolume());
  assert.equal(s.focus, 1, 'the light per section is the same along the beam');
  assert.equal(s.near, PROJECTOR_BEAM.near);
  assert.equal(s.cap, PROJECTOR_BEAM.cap);
  assert.deepEqual(s.colour, PROJECTOR_BEAM.colour.map((c) => c * 0.5), 'x opacity');
  // On the axis halfway: full; at the outline's rim: none (soft sides, no ray edges).
  assert.ok(shapeDensity(s, s.c1[0] / 2, s.c1[1] / 2, s.length / 2) > 0.99);
  assert.equal(shapeDensity(s, s.c1[0] + s.r1[0] * 1.01, s.c1[1], s.length * 0.999), 0);
});

test('projector beam: beams from one lens are one volume; hidden beams and a faded figure draw nothing', () => {
  const fx = new ProjectorBeamFx(new THREE.Group(), 3);
  const lens = new THREE.Vector3(1, 1, 1), other = new THREE.Vector3(5, 1, 1);
  fx.setOpacity(0.8);
  fx.set(0, lens, outline(24).map((p) => p.clone().add(lens)));
  fx.set(1, lens, outline(24, -5).map((p) => p.clone().add(lens)));
  fx.set(2, other, outline(24).map((p) => p.clone().add(other)));
  const vols = [...lightVolumeScene.dynamic].slice(-3);
  const drawn = vols.map((v) => v.update(emptyLightVolume()));
  assert.deepEqual(drawn, [true, false, true], 'the second beam of the first lens merges into the first');
  const merged = emptyLightVolume();
  vols[0].update(merged);
  assert.ok(merged.length >= 5, `fitted to both beams' rays (${merged.length})`);
  assert.ok(Math.abs(merged.gain - PROJECTOR_BEAM.gain * Math.SQRT2) < 1e-9);
  fx.set(2, null, []);
  assert.equal(vols[2].update(emptyLightVolume()), false, 'a hidden beam');
  fx.setOpacity(0);
  assert.equal(vols[0].update(emptyLightVolume()), false, 'a faded figure');
  fx.dispose();
  for (const v of vols) assert.ok(!lightVolumeScene.dynamic.has(v), 'disposed');
});
