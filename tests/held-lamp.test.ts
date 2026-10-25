// The flashlight belongs to the player, not to the view camera (docs/re/renderer.md §2.1): while a
// security monitor's feed has the camera, the lamp and its beam stay at the player's eye
// (src/app/held-lamp.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { HELD_AXIS, heldLampPose, LAMP_AIM, LAMP_OFFSET, lampAxis } from '../src/app/held-lamp';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function cameraAt(pos: THREE.Vector3, yaw: number, pitch: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera();
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch, yaw, 0);
  cam.position.copy(pos);
  cam.updateMatrixWorld(true);
  return cam;
}

test('held lamp: with the camera at the eye the lamp keeps its offset and aim', () => {
  const eye = new THREE.Vector3(3, 1.6, -2);
  const cam = cameraAt(eye, 0.7, -0.2);
  const p = new THREE.Vector3(), t = new THREE.Vector3(), axis = new THREE.Vector3();
  heldLampPose(cam.matrixWorld, eye, 0.7, -0.2, p, t, axis);
  close(p.x, LAMP_OFFSET.x), close(p.y, LAMP_OFFSET.y), close(p.z, LAMP_OFFSET.z);
  close(t.x, LAMP_AIM.x), close(t.y, LAMP_AIM.y), close(t.z, LAMP_AIM.z);
  const d = cam.getWorldDirection(new THREE.Vector3());
  close(axis.x, d.x), close(axis.y, d.y), close(axis.z, d.z);
});

test('held lamp: during a monitor view it lights from the player, not from the security camera', () => {
  // 1a monitor 6ddf: the camera 7976 hangs at (419.2, 92.3, 438.2) looking down a corridor; the
  // player stands at the monitor (410.2, 90.7, 459.2) facing it.
  const cam = cameraAt(new THREE.Vector3(419.2, 92.3, 438.2), 2.5, -0.37);
  const eye = new THREE.Vector3(410.2, 90.65, 460.0);
  const yaw = 0, pitch = -0.1;
  const p = new THREE.Vector3(), t = new THREE.Vector3(), axis = new THREE.Vector3();
  heldLampPose(cam.matrixWorld, eye, yaw, pitch, p, t, axis);
  // Put the lamp under the camera as the renderer does and read it back in world space.
  const lamp = new THREE.Object3D(), target = new THREE.Object3D();
  cam.add(lamp, target);
  lamp.position.copy(p);
  target.position.copy(t);
  cam.updateMatrixWorld(true);
  const w = lamp.getWorldPosition(new THREE.Vector3());
  // At the eye, 0.15 m to the right and 0.1 m down (yaw 0: right is +x).
  close(w.x, eye.x + 0.15, 1e-4);
  close(w.y, eye.y - 0.1 * Math.cos(pitch), 1e-4);
  assert.ok(w.distanceTo(cam.position) > 20, 'not at the security camera');
  // The beam points where the player looks (-z, slightly down), whatever the camera does.
  close(axis.x, 0), close(axis.y, Math.sin(pitch)), close(axis.z, -Math.cos(pitch));
  const fl = new THREE.Object3D();
  const out = new THREE.Vector3();
  assert.ok(lampAxis(fl, cam, out).distanceTo(cam.getWorldDirection(new THREE.Vector3())) < 1e-9, 'camera axis by default');
  fl.userData[HELD_AXIS] = axis;
  assert.ok(lampAxis(fl, cam, out).distanceTo(axis) < 1e-9, 'held axis while set');
});
