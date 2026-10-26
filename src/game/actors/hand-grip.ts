// Enhanced option "Close Hand on Weapon" (off by default; not in the original game).
//
// The original's third-person standing idle (PWP p13, 2:27) and walk (p18, 2:30) are the
// unarmed clips: the right hand stays open, its fingers spread about 4 cm from the weapon bone 35,
// so the gun hangs beside the open hand (docs/game-logic.md §4.5 "Held weapon grip"; Original
// keeps exactly that). With the option on, Enhanced blends the right hand's finger bones towards
// the fist of the weapon's own armed run clip (heading set 0's run, PWP p20: the revolver's 2:28,
// the shotgun's 2:413, the tommy gun's 2:416, the shiv's 2:408), which closes them about bone 35,
// while a weapon is held and the body is drawn in third person.

import * as THREE from 'three/webgpu';
import type { Character } from '../../app/character';

/** The live option (menu: Gameplay "Close Hand on Weapon"; applied in Enhanced only). */
export const handGripOption = { enabled: false };

/** Seconds for the hand to close / open. */
export const HAND_GRIP_BLEND = 0.2;

/**
 * The finger bones of a hand: every descendant of `hand` except the weapon bone and its subtree
 * (rig 2:9: hand 34, weapon bone 35, fingers 36..47). `parents[i]` = parent index (-1 root).
 */
export function fingerBones(parents: readonly number[], hand: number, weapon: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < parents.length; i++) {
    if (i === hand || i === weapon) continue;
    let p = parents[i], inWeapon = false, under = false;
    for (let guard = 0; p >= 0 && guard < 256; guard++, p = parents[p]) {
      if (p === weapon) inWeapon = true;
      if (p === hand) {
        under = true;
        break;
      }
    }
    if (under && !inWeapon) out.push(i);
  }
  return out;
}

/** The grip: each finger bone's local rotation in the armed clip at time `t` (by track name). */
export function gripPose(clip: THREE.AnimationClip, bones: readonly THREE.Bone[], fingers: readonly number[], t = 0): Map<number, THREE.Quaternion> {
  const out = new Map<number, THREE.Quaternion>();
  for (const i of fingers) {
    const b = bones[i];
    const track = b && clip.tracks.find((k) => k.name === `${b.name}.quaternion`);
    if (!track) continue;
    const T = track.times, V = track.values;
    let k = 0;
    while (k + 1 < T.length && T[k + 1] <= t) k++;
    const q = new THREE.Quaternion(V[4 * k], V[4 * k + 1], V[4 * k + 2], V[4 * k + 3]);
    if (k + 1 < T.length && t > T[k]) {
      const n = new THREE.Quaternion(V[4 * k + 4], V[4 * k + 5], V[4 * k + 6], V[4 * k + 7]);
      q.slerp(n, (t - T[k]) / Math.max(1e-6, T[k + 1] - T[k]));
    }
    out.set(i, q.normalize());
  }
  return out;
}

/** Ease `w` towards `target` at 1 / HAND_GRIP_BLEND per second. */
export function stepGripWeight(w: number, target: number, dt: number): number {
  const k = dt / HAND_GRIP_BLEND;
  return target > w ? Math.min(target, w + k) : Math.max(target, w - k);
}

/** The pose hook of the player's body (player-body.ts). */
export class HandGrip {
  private grip: Map<number, THREE.Quaternion> | null = null;
  private w = 0;
  readonly fingers: number[];

  constructor(
    private readonly ch: Character,
    hand: number,
    weapon: number,
    private readonly enabled: () => boolean,
  ) {
    const parents = ch.skinned.skeleton.bones.map((b) => b.parent);
    this.fingers = hand >= 0 && weapon >= 0 ? fingerBones(parents, hand, weapon) : [];
  }

  /** The held weapon's armed run clip (null: unarmed). */
  setClip(clip: THREE.AnimationClip | null) {
    this.grip = clip && this.fingers.length ? gripPose(clip, this.ch.skeleton.bones, this.fingers) : null;
    if (this.grip && !this.grip.size) this.grip = null;
  }

  /** After the mixer: `drawn` = the body is the view (third person). */
  apply(dt: number, drawn: boolean) {
    const target = this.grip && drawn && this.enabled() ? 1 : 0;
    this.w = stepGripWeight(this.w, target, dt);
    if (this.w <= 0 || !this.grip) return;
    for (const [i, q] of this.grip) this.ch.blendBoneLocal(i, q, this.w);
  }
}
