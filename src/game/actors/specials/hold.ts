// Holding the player (grapple moves: Nooseman grab, Mainliner jump attack).
//
// While a creature holds the player, the player's movement input no longer moves the feet:
// `PlayerController.motionOverride` takes it (the camera still looks around) and the feet are put
// where the move wants them each frame. A struggle press is a press of Fire, Throw, Jump or Use:
// the Mainliner's ride sums the four actions' presses each frame (input actions 0x428..0x42b,
// Suffering.rfl 0x1007fb1f..0x1007fb9d) [verified]; movement keys do not count. Jump comes with
// the movement input, the other three through `PlayerController.attackOverride` (weapons Fire /
// Throw, the world's Use key). The move decides what the presses do (break free after N of them,
// shorten the hold); the hold only counts them. One holder at a time (SpecialRuntime.holder).

import type * as THREE from 'three/webgpu';
import type { Actor } from '../actor';
import type { SpecialRuntime } from './runtime';

export class PlayerHold {
  /** Struggle presses since start(). */
  presses = 0;
  active = false;
  private last = { j: false };
  private feet: (() => THREE.Vector3Like | null) | null = null;

  constructor(
    private readonly rt: SpecialRuntime,
    private readonly holder: Actor,
  ) {}

  /** Take the player. False when another special or a scripted move already holds him. */
  start(feet?: () => THREE.Vector3Like | null): boolean {
    const rt = this.rt, p = rt.player;
    if (this.active) return true;
    if ((rt.holder && rt.holder !== this.holder) || p.motionOverride || !rt.playerAlive) return false;
    rt.holder = this.holder;
    this.active = true;
    this.presses = 0;
    this.feet = feet ?? null;
    this.last = { j: false };
    p.motionOverride = (_dt, input) => {
      if (!this.active) return false;
      // A Jump press (not held the frame before).
      if (input.jump && !this.last.j) this.presses++;
      this.last = { j: input.jump };
      const at = this.feet?.();
      if (at) p.setFeet(at.x, at.y, at.z);
      return true;
    };
    // Fire, Throw and Use presses (weapons/system.ts attack() / throwSelected(), world.ts Use).
    p.attackOverride = () => {
      if (!this.active) return false;
      this.presses++;
      return true;
    };
    return true;
  }

  /** Count one struggle press from outside the movement input (attack button, tests). */
  press() {
    if (this.active) this.presses++;
  }

  /** Let go: the player walks again (the override ends on its next call). */
  release() {
    if (!this.active) return;
    this.active = false;
    if (this.rt.holder === this.holder) this.rt.holder = null;
    const p = this.rt.player;
    p.motionOverride = null;
    p.attackOverride = null;
    p.motor.onGround = false;
  }
}
