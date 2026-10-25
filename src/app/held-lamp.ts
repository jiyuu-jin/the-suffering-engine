// Where the player's flashlight shines from while another camera shows him (docs/re/renderer.md
// §2.1, docs/game-logic.md §14.5 Security Monitor).
//
// The original's lamp is an item attached to the player (the give code Suffering.rfl 0x10038f84
// attaches the Flashlight object to him and switches it on) [verified]; the view camera is
// separate. Looking through a Security Monitor (View Monitor, 0x1001b4a0) moves only the view
// to the camera Mechanism, so the lamp keeps lighting from Torque where he stands at the monitor,
// facing it [the lamp's exact hardpoint not traced: the port uses its first-person eye pose].
//
// The port hangs the lamp on the view camera (renderer.ts, 0.15 m right and 0.1 m below the eye,
// aimed along the view). During a monitor view that put it on the security camera: its hot
// spot swept across the walls in front of every camera as the camera panned, and blew out the
// picture wherever a wall came within a few metres (user report: "the lights flash too bright in
// the camera feeds, occasionally blinding the camera"). `heldLampPose` gives the lamp's pose in the
// view camera's local frame so that it stays at the player's eye.

import * as THREE from 'three/webgpu';

/** The lamp's offset from the eye and its aim, in the eye's frame (x right, y up, -z ahead). */
export const LAMP_OFFSET: Readonly<{ x: number; y: number; z: number }> = { x: 0.15, y: -0.1, z: 0 };
export const LAMP_AIM: Readonly<{ x: number; y: number; z: number }> = { x: 0, y: 0, z: -1 };

const eyeM = new THREE.Matrix4();
const inv = new THREE.Matrix4();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const q = new THREE.Quaternion();
const one = new THREE.Vector3(1, 1, 1);

/**
 * The lamp's position and target in `cameraWorld`'s local frame for a player eye at `eye` looking
 * along (`yaw`, `pitch`) (the PlayerController's convention: rotation order YXZ, forward -z), and
 * the eye's view axis in world space (`outAxis`, the beam's axis). With the camera at the eye this
 * is LAMP_OFFSET / LAMP_AIM unchanged and the camera's own view axis.
 */
export function heldLampPose(
  cameraWorld: THREE.Matrix4,
  eye: THREE.Vector3,
  yaw: number,
  pitch: number,
  outPos: THREE.Vector3,
  outTarget: THREE.Vector3,
  outAxis?: THREE.Vector3,
): void {
  q.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));
  eyeM.compose(eye, q, one);
  inv.copy(cameraWorld).invert();
  outPos.set(LAMP_OFFSET.x, LAMP_OFFSET.y, LAMP_OFFSET.z).applyMatrix4(eyeM).applyMatrix4(inv);
  outTarget.set(LAMP_AIM.x, LAMP_AIM.y, LAMP_AIM.z).applyMatrix4(eyeM).applyMatrix4(inv);
  outAxis?.set(0, 0, -1).applyQuaternion(q);
}

/** Set by the renderer while the lamp is held away from the view camera (heldLampPose's axis). */
export const HELD_AXIS = 'heldLampAxis';

/**
 * The flashlight beam's axis: the view axis of whoever holds the lamp. The camera's view axis,
 * unless the renderer holds the lamp at the player's eye while another camera shows him.
 */
export function lampAxis(flashlight: THREE.Object3D, camera: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  const held = flashlight.userData[HELD_AXIS] as THREE.Vector3 | undefined;
  return held ? out.copy(held) : camera.getWorldDirection(out);
}
