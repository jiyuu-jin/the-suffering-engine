// Camera Shake (class 0x6506a1ba, System; docs/game-logic.md §17.2).
//
// Verified from Suffering.rfl (On handler 0x1009d8f0, think 0x1009d6d0, camera use 0x10003de3):
//   On (p6): time left = p2 (s), thinking starts.
//   Every tick while time is left:
//     a = p0, b = p1 (model units; the code multiplies by 2048 engine units)
//     during the last p3 seconds both fade linearly: a, b *= timeLeft / p3
//     distance d from the camera to the shake object: full inside p4, linear falloff to 0 at
//     p5 (model units; most templates use 10000 = everywhere)
//     the result is written into the player object (a -> +0x30, b -> +0x2c) - so the most
//     recently updated shake wins - and time left -= frame dt; at 0 both are cleared.
//   The player camera then, every unpaused frame, adds rand(-a, a) along the camera's right axis
//   and rand(-b, b) along its up axis to the eye position, and independent rand(-a, a) /
//   rand(-b, b) offsets to the look-at point: a per-frame jitter of position and aim.
//
// Port: the eye offset is applied as is (clamped against walls so the camera can't poke through);
// the look-at offset becomes a rotation at an assumed look distance of LOOK_DIST model units
// (the original's third-person look-at point is on the player; inferred). The offset is added
// right after the player / fly controller placed the camera (their update() is wrapped) and taken
// off again before the next frame's update.

import * as THREE from 'three/webgpu';
import type { CollisionWorld } from '../../app/physics';

const LOOK_DIST = 2.5;

export interface ShakeParams {
  /** p0: horizontal (camera right) amplitude, model units. */
  a: number;
  /** p1: vertical (camera up) amplitude, model units. */
  b: number;
  /** p2: duration (s). */
  time: number;
  /** p3: fade-out time at the end (s). */
  fade: number;
  /** p4 / p5: full strength within, none beyond (model units). */
  inner: number;
  outer: number;
  /** Shake origin (falloff); undefined = at the camera. */
  at?: THREE.Vector3;
}

interface Active extends ShakeParams {
  left: number;
}

export class CameraShaker {
  private active: Active[] = [];
  private readonly applied = { pos: new THREE.Vector3(), rot: new THREE.Quaternion(), set: new THREE.Vector3(), on: false };
  private readonly tmp = { r: new THREE.Vector3(), u: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'YXZ') };
  /** Current amplitudes (for tests / the overlay). */
  amp = { a: 0, b: 0 };
  /** Frames since update() ran: the game is paused (menu) when systems stop updating. */
  private stale = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly collision: () => CollisionWorld | null,
  ) {}

  /** Start a shake (Camera Shake On, or a spawned template). */
  start(p: ShakeParams) {
    if (!(p.time > 0)) return;
    this.active.push({ ...p, at: p.at?.clone(), left: p.time });
  }

  /** Template values -> params (p0..p5). */
  static fromValues(v: readonly unknown[], at?: THREE.Vector3): ShakeParams {
    const n = (i: number, d: number) => (typeof v[i] === 'number' && Number.isFinite(v[i]) ? (v[i] as number) : d);
    return { a: n(0, 0.2), b: n(1, 0.2), time: n(2, 0.5), fade: n(3, 0), inner: n(4, 10000), outer: n(5, 10000), at };
  }

  /** Advance the shakes (game time) and compute this frame's amplitude. */
  update(dt: number) {
    const cam = this.camera.position;
    let a = 0, b = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i];
      if (s.left <= 0) {
        this.active.splice(i, 1);
        continue;
      }
      let sa = s.a, sb = s.b;
      if (s.fade > s.left) {
        const k = s.left / s.fade;
        sa *= k;
        sb *= k;
      }
      let f = 1;
      if (s.at) {
        const d = s.at.distanceTo(cam);
        f = d <= s.inner ? 1 : d < s.outer ? 1 - (d - s.inner) / Math.max(1e-6, s.outer - s.inner) : 0;
      }
      // The engine keeps one value (last writer); with several active the strongest is used.
      a = Math.max(a, sa * f);
      b = Math.max(b, sb * f);
      s.left -= dt;
    }
    this.amp = { a, b };
    this.stale = 0;
  }

  /** Take last frame's offset off the camera (if nobody moved it since). */
  remove() {
    const ap = this.applied;
    if (!ap.on) return;
    ap.on = false;
    if (this.camera.position.distanceToSquared(ap.set) > 1e-10) return;
    this.camera.position.sub(ap.pos);
    this.camera.quaternion.multiply(this.tmp.q.copy(ap.rot).invert());
  }

  /** Add this frame's jitter (call right after the camera was placed). */
  apply() {
    const { a, b } = this.amp;
    if ((a <= 0 && b <= 0) || this.stale++ > 1) return;
    const cam = this.camera;
    const { r, u } = this.tmp;
    r.set(1, 0, 0).applyQuaternion(cam.quaternion);
    u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const rnd = (m: number) => (Math.random() * 2 - 1) * m;
    const ex = rnd(a), ey = rnd(b), tx = rnd(a), ty = rnd(b);
    const off = this.applied.pos.set(0, 0, 0).addScaledVector(r, ex).addScaledVector(u, ey);
    // Keep the eye out of walls.
    const len = off.length();
    const col = this.collision();
    if (col && len > 1e-4) {
      const h = col.raycast(cam.position.x, cam.position.y, cam.position.z, off.x, off.y, off.z, len + 0.12);
      if (h) off.multiplyScalar(Math.max(0, h.distance - 0.12) / len);
    }
    // Look-at jitter relative to the eye jitter -> yaw / pitch at the look distance.
    const yaw = -Math.atan2(tx - ex, LOOK_DIST), pitch = Math.atan2(ty - ey, LOOK_DIST);
    this.applied.rot.setFromEuler(this.tmp.e.set(pitch, yaw, 0, 'YXZ'));
    cam.position.add(off);
    cam.quaternion.multiply(this.applied.rot);
    cam.updateMatrixWorld();
    this.applied.set.copy(cam.position);
    this.applied.on = true;
  }

  get shaking() {
    return this.active.length > 0;
  }

  clear() {
    this.active = [];
    this.amp = { a: 0, b: 0 };
  }
}
