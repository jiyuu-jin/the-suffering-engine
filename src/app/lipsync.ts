// Lip-sync: drives a character's jaw bone from a dialog sound's mouth envelope.
//
// How the original does it (Suffering.rfl, see docs/game-logic.md "Lip-sync"):
//   * Character-family classes carry three template properties: jaw bone (signed bone
//     INDEX into the model's skeleton, -1 = no lip-sync), maximum jaw angle in degrees and
//     the rotation axis (0 = X, 1 = Y, 2 = Z, in the bone's own frame). They sit at property
//     indices 118..120 for every Character class and 124..126 for Player. Every shipped
//     template that sets a bone points at the bone with name hash 0x30cb6f7d (a child of
//     the head bone 0x07c159a2) with axis Z and 5..20 degrees (human NPCs: 10).
//   * While a voiced sound plays, the envelope (25 fps, u16 0..0x7fff) is linearly
//     interpolated and turned into an angle: raw * 4e-5 * maxAngle (so a full-scale frame
//     opens the jaw ~1.31 x maxAngle). That rotation is an extra local transform applied on
//     top of whatever the animation poses the jaw at (additive); with no sound it is identity.
//
// Here: JawDriver post-multiplies the bone's animated local quaternion every frame and
// undoes its own previous offset when the mixer did not rewrite the bone in between.

import * as THREE from 'three/webgpu';
import type { Entity } from '../formats/entities';
import type { LipSync } from '../formats/sound';
import type { Skeleton } from '../formats/skeleton';
import type { Character } from './character';

/** Name hash of the jaw bone on every rig that has one (humans and most creatures). */
export const JAW_BONE_HASH = 0x30cb6f7d;
/** Engine scale from raw envelope units to "fraction of max angle" (raw * 4e-5). */
export const JAW_RAW_SCALE = 4e-5;
/** Envelope values are stored 0..0x7fff; parseLipSync normalises them by this. */
const RAW_MAX = 0x7fff;
/** Template property index of the jaw bone (Character classes; Player uses PLAYER_JAW_PROP). */
export const JAW_PROP = 0x76;
export const PLAYER_JAW_PROP = 0x7c;
/** Defaults for characters without template data (most templates use these). */
export const DEFAULT_JAW_DEGREES = 10;
export const DEFAULT_JAW_AXIS = 2;

export interface JawConfig {
  /** Bone index in the character's skeleton. */
  bone: number;
  /** Template maximum angle in degrees. */
  maxDegrees: number;
  /** 0 = X, 1 = Y, 2 = Z (bone-local). */
  axis: number;
}

/**
 * Jaw setup for a character: from its entity's template properties when it has one
 * (bone -1 there means "no lip-sync", as in the original), else the jaw bone by hash.
 */
export function jawConfig(skel: Skeleton, entity?: Pick<Entity, 'family' | 'className' | 'values'>): JawConfig | null {
  const byHash = skel.byHash.get(JAW_BONE_HASH);
  if (entity && entity.family === 'Character') {
    const base = entity.className === 'Player' ? PLAYER_JAW_PROP : JAW_PROP;
    const bone = entity.values[base];
    const deg = entity.values[base + 1];
    const axis = entity.values[base + 2];
    if (typeof bone === 'number') {
      if (bone < 0) return null;
      // The index is relative to the model the template was authored with; trust it only
      // when it lands on the jaw (or the rig has no jaw-hash bone at all).
      const ok = bone < skel.bones.length && (skel.bones[bone].hash === JAW_BONE_HASH || byHash === undefined);
      const index = ok ? bone : byHash;
      if (index === undefined) return null;
      return {
        bone: index,
        maxDegrees: typeof deg === 'number' && deg > 0 ? deg : DEFAULT_JAW_DEGREES,
        axis: typeof axis === 'number' && axis >= 0 && axis <= 2 ? axis : DEFAULT_JAW_AXIS,
      };
    }
  }
  return byHash === undefined ? null : { bone: byHash, maxDegrees: DEFAULT_JAW_DEGREES, axis: DEFAULT_JAW_AXIS };
}

/** Envelope value (0..1) at `t` seconds into the sound. Frame i covers [i, i+1) / fps. */
export function sampleEnvelope(env: LipSync, t: number): number {
  const v = env.values;
  if (!v.length || !(t >= 0)) return 0;
  const p = t * env.fps - 0.5; // frame centres
  if (p >= v.length - 1) return t * env.fps < v.length ? v[v.length - 1] : 0;
  if (p <= 0) return v[0];
  const i = Math.floor(p);
  const f = p - i;
  return v[i] + (v[i + 1] - v[i]) * f;
}

/** Jaw angle (radians) for an envelope value 0..1 and a template max angle. */
export function jawAngle(value: number, maxDegrees: number): number {
  return value * RAW_MAX * JAW_RAW_SCALE * maxDegrees * THREE.MathUtils.DEG2RAD;
}

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** Applies an additive jaw rotation to one character's skeleton. */
export class JawDriver {
  readonly bone: THREE.Bone;
  /** Angle currently applied (radians). */
  angle = 0;
  private readonly base = new THREE.Quaternion();
  private readonly applied = new THREE.Quaternion();
  private readonly delta = new THREE.Quaternion();
  private active = false;

  constructor(
    readonly ch: Character,
    readonly cfg: JawConfig,
  ) {
    this.bone = ch.skeleton.bones[cfg.bone];
  }

  /** Set the jaw to `value` (0..1 envelope units) on top of the current animated pose. */
  apply(value: number) {
    const q = this.bone.quaternion;
    // Undo last frame's offset unless the animation rewrote the bone since.
    if (this.active && q.equals(this.applied)) q.copy(this.base);
    this.active = false;
    this.angle = 0;
    if (!(value > 0)) return;
    this.base.copy(q);
    this.angle = jawAngle(value, this.cfg.maxDegrees);
    q.multiply(this.delta.setFromAxisAngle(AXES[this.cfg.axis] ?? AXES[2], this.angle));
    this.applied.copy(q);
    this.active = true;
  }

  /** Remove any applied offset. */
  reset() {
    this.apply(0);
  }
}
