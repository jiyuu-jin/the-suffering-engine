// A character's hand weapon falling out of its hand at death (docs/game-logic.md §4.4 "Held and
// dropped").
//
// Decoded [verified: Suffering.rfl item drop 0x10096c20 -> 0x100be330 -> 0x100bd300]:
//  - The item leaves the hand where the hand holds it: it is detached at its attached pose.
//  - An item whose engine object is of type 10 is turned upright first: the smallest rotation that
//    takes its local Y axis to world up (axis = its Y x up, angle = acos(Y . up), applied to its
//    matrix by 0x1000c6a0; skipped when Y is already up). Its heading is kept.
//  - It gets a physics body (collision interface vt+0x10 with 0.766 and 0.4: SUFFERING.EXE
//    0x423820 -> 0x42aae0, a rigid body of three points under world gravity (0, 1, 0), stepped by
//    0x42adf0). A p27 template (guard revolvers -> Ammo Box 4:1404) is spawned at the item's matrix
//    and replaces it; otherwise the item itself enters its dropped state.
// Port [inferred: the body's integration was not traced]: the pickup falls from that pose with no
// starting speed under the level's gravity, bounces off what it hits keeping DROP_BOUNCE of its
// speed into the surface and 1 - DROP_FRICTION of its speed along it, and comes to rest on the
// first floor it touches slowly (or after DROP_MAX_TIME).

import * as THREE from 'three/webgpu';

/** The two numbers the drop passes to the body: read here as friction and restitution [inferred]. */
export const DROP_FRICTION = 0.766;
export const DROP_BOUNCE = 0.4;
/** Below this speed (m/s) on a floor the pickup rests. */
export const DROP_REST_SPEED = 0.6;
/** A fall never takes longer than this (s). */
export const DROP_MAX_TIME = 6;
/** Surfaces at least this upward count as floor (normal y). */
const FLOOR_NY = 0.6;

const UP = new THREE.Vector3(0, 1, 0);

/** The upright pose of a held item (0x10096c20): its Y axis turned to world up, heading kept. */
export function uprightQuaternion(q: THREE.Quaternion, out = new THREE.Quaternion()): THREE.Quaternion {
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  if (y.y >= 1 - 1e-6) return out.copy(q);
  return out.setFromUnitVectors(y.normalize(), UP).multiply(q);
}

export interface DropFall {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  t: number;
  resting: boolean;
}

/** Segment test against the level (and solid objects): the first hit from `from` to `to`. */
export type SegmentCast = (from: THREE.Vector3, to: THREE.Vector3) => { point: THREE.Vector3; normal: THREE.Vector3 } | null;

/** One step of a falling drop; returns true while it still moves. */
export function stepDropFall(d: DropFall, dt: number, gravity: number, cast: SegmentCast): boolean {
  if (d.resting) return false;
  d.t += dt;
  d.vel.y -= gravity * dt;
  const to = d.pos.clone().addScaledVector(d.vel, dt);
  const hit = cast(d.pos, to);
  if (!hit) {
    d.pos.copy(to);
    if (d.t > DROP_MAX_TIME) d.resting = true;
    return !d.resting;
  }
  const n = hit.normal;
  d.pos.copy(hit.point).addScaledVector(n, 0.002);
  const vn = d.vel.dot(n);
  if (vn < 0) {
    const normal = n.clone().multiplyScalar(vn);
    const tangent = d.vel.clone().sub(normal);
    d.vel.copy(tangent.multiplyScalar(1 - DROP_FRICTION)).addScaledVector(normal, -DROP_BOUNCE);
  }
  if ((n.y >= FLOOR_NY && d.vel.length() < DROP_REST_SPEED) || d.t > DROP_MAX_TIME) {
    d.resting = true;
    d.vel.set(0, 0, 0);
    if (n.y >= FLOOR_NY) d.pos.copy(hit.point);
  }
  return !d.resting;
}

/**
 * Where a held model drops (0x10096c20): its world position, and the heading of its upright pose
 * as an instance yaw (degrees: instanceRotation([0, yaw, 0]) = rotY(yaw - 90) carries the model's
 * +Z to (sin, 0, cos) of yaw - 90).
 */
export function handDropPose(m: THREE.Object3D): { at: [number, number, number]; yawDeg: number } {
  m.updateWorldMatrix(true, false);
  const p = m.getWorldPosition(new THREE.Vector3());
  const q = uprightQuaternion(m.getWorldQuaternion(new THREE.Quaternion()));
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return { at: [p.x, p.y, p.z], yawDeg: (Math.atan2(f.x, f.z) * 180) / Math.PI + 90 };
}
