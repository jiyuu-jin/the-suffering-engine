// Melee lunge: the root motion of the player's strike clips (docs/game-logic.md §14.1 "Player
// melee: root motion"). Shared by the human's weapons (weapons/system.ts) and the creature form
// (insanity/creature.ts), which run the same Player states in the original.
//
// The original [verified unless marked]:
//   * The animator moves its object by the clip's root translation when an axis is "extracted"
//     and not "locked" (animator flags 0x10/0x20/0x40 and 0x100/0x200/0x400; SUFFERING.EXE
//     0x478b90): the root's sampled translation minus last frame's, scaled per axis in model
//     space by animator +0x64 / +0x68 / +0x6c (x, y, z; 1 by default, 0x46d099..0x46d0a2,
//     0x478d72..0x478d88), turned by the model's matrix and added to the object's pending move
//     (0x4790c1..0x4790f1 -> 0x4546d0, the matrix the object's vtable +0xf0 returns). The gait
//     adds its speed x stick x dt to the same matrix (Move per-frame 0x10046851..0x10046872), so
//     the lunge goes through the player's mover like walking [the mover itself: strong].
//   * MeleeAttack (Player state 4) enter 0x10027970 turns extraction on for x, y and z (vtable
//     +0x70 with 1). Entering it ends Move and Idle (state transition table 0x10175150, value 2),
//     whose leave handlers clear the lock (Move leave 0x10045770: +0x70(1), +0x80(0)); Move cannot
//     start while state 4 is on (value 0). So a third-person strike stands the player still and
//     the clip's root carries him.
//   * MeleeAttack per frame 0x10029ff0 sets the z scale (+0x6c) every frame: 1 when the player is
//     off the ground (+0x98 bit 0 clear), when the melee target (+0xc, this frame's pick) is
//     live, or when the playing attack class (+0x404) is 3 (the p89 list: the creature's
//     alternates); else the held Player Weapon Properties' p85 (shiv / axe 0.5, creature 2:241
//     0.5, empty hand 2:409 1). MeleeAttack leave 0x1002a370 puts it back to 1. x and y are not
//     scaled.
//   * FP Melee Attack (state 32) touches neither the flags nor the scale and coexists with Move
//     (whose lock then holds); its clips (2:218, 2:269) have a rotation-only root with a zero
//     constant, so first person never lunges [data].
//   * The human strikes and recoveries cut in (header blend 0), so the motion is each clip's own
//     root track in turn [data]; the root's y is 0 in every strike clip [data].

import { sampleTrackTranslation, type AnimClipData } from '../../formats/animation';

/** The z root-motion scale of a strike frame (MeleeAttack per frame 0x10029ff0). */
export function meleeRootScale(o: { onGround: boolean; target: boolean; alternate: boolean; p85: number }): number {
  return !o.onGround || o.target || o.alternate ? 1 : o.p85;
}

/** A Player Weapon Properties' p85 (the no-target lunge scale); 1 when missing. */
export function readLungeScale(v: readonly unknown[] | undefined): number {
  const x = v?.[85];
  return typeof x === 'number' && Number.isFinite(x) ? x : 1;
}

/** Model-space (x right, z back: the clips' -Z is forward) to world, for a body yaw (port: 0 looks down -Z). */
export function lungeToWorld(dx: number, dz: number, yaw: number): { x: number; z: number } {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  return { x: dx * c + dz * s, z: -dx * s + dz * c };
}

/**
 * The playing strike (or recovery) clip's root, sampled on the clip's own clock: `step` returns
 * this frame's model-space delta with the z scale applied.
 */
export class MeleeLunge {
  private clip: AnimClipData | null = null;
  private t = 0;
  private speed = 1;
  private lastX = 0;
  private lastZ = 0;
  /** Model-space distance moved since `start` (x, z after scaling; debug and tests). */
  readonly moved = { x: 0, z: 0 };

  /** A new clip starts (strike or recovery): the root counts from its first frame. */
  start(clip: AnimClipData | undefined, timeScale = 1): void {
    this.clip = clip ?? null;
    this.t = 0;
    this.speed = (clip?.rate || 1) * timeScale;
    const r = clip ? sampleTrackTranslation(clip, 0) : [0, 0, 0];
    this.lastX = r[0];
    this.lastZ = r[2];
    this.moved.x = this.moved.z = 0;
  }

  stop(): void {
    this.clip = null;
  }

  get active(): boolean {
    return !!this.clip;
  }

  /** Advance the clip by `dt` (s); the root's change in model space, z scaled by `scaleZ`. */
  step(dt: number, scaleZ: number): { x: number; z: number } {
    const c = this.clip;
    if (!c || dt <= 0) return { x: 0, z: 0 };
    // Once-clips hold their last frame (every strike and recovery plays once).
    this.t = Math.min(c.duration, this.t + dt * this.speed);
    const r = sampleTrackTranslation(c, this.t);
    const x = r[0] - this.lastX, z = (r[2] - this.lastZ) * scaleZ;
    this.lastX = r[0];
    this.lastZ = r[2];
    this.moved.x += x;
    this.moved.z += z;
    return { x, z };
  }
}
