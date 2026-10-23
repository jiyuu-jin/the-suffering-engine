// The optional gore listener: Enhanced mode's blood and gore (src/app/enhanced/gore,
// docs/enhanced.md "Gore") listens to the game's blood events through this slot.
//
// Original mode never sets it: every call site is `gore.listener?.x?.(...)`, which does nothing
// and returns undefined, so the faithful effects (fx/effects.ts bloodSpray / bloodPool, the
// decals of fx/system.ts bloodNear, the fountains of world/fx.ts) run exactly as before. When a
// handler returns true it has drawn the blood itself and the faithful splat is skipped.
//
// This module imports no Enhanced code (tests/enhanced-gore.test.ts guards it).

import type * as THREE from 'three/webgpu';
import type { CollisionWorld } from '../../app/physics';

/** What the gore code reads of an actor (duck-typed: actors/actor.ts Actor). */
export interface GoreActor {
  readonly alive: boolean;
  readonly hidden?: boolean;
  readonly position: THREE.Vector3Like;
  readonly bottom?: number;
  readonly height?: number;
  readonly health?: number;
  readonly maxHealth?: number;
  /** Part Cap bleed (damage per second, actors/dismember.ts). */
  readonly bleed?: number;
  readonly uid?: number;
  readonly entity?: { family?: string; className?: string };
  /** A DormantBehavior pose: a placed body that does not bleed (actors/dismember.ts). */
  readonly behavior?: { kind: string };
  readonly ch: { root: THREE.Object3D; mesh: THREE.Object3D; skeleton: THREE.Skeleton };
}

/** The level the gore draws into (fx/system.ts attaches it on level start). */
export interface GoreEnv {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** The level's drawn triangles (decals project onto them, as fx/decals.ts). */
  drawn(): CollisionWorld | null;
  /** The collision world (ray casts). */
  collision(): CollisionWorld | null;
  /** Mean baked vertex colour (the engine's C, gamma; L = 2C) of level parts near a point. */
  lightAt(point: THREE.Vector3Like, parts: Iterable<number>): { r: number; g: number; b: number };
  actors(): readonly GoreActor[];
  /** The player's health, or null when there is no player body. */
  player(): { health: number; maxHealth: number; alive: boolean } | null;
}

/** A particle fountain as the gore code sees it (world/fx.ts Emitter). */
export interface GoreFountain {
  readonly v: readonly unknown[];
  readonly origin: THREE.Vector3;
  readonly particles: readonly { p: THREE.Vector3; v: THREE.Vector3; age: number; life: number; size0: number }[];
  readonly dead: boolean;
  readonly done: boolean;
  /** Set by the listener: multiplies the lit colour (p46 = 3) in Enhanced mode. */
  goreTint?: THREE.Color;
}

export interface GoreListener {
  attach(env: GoreEnv): void;
  detach(): void;
  /** Game time step (fx system update). */
  update(dt: number): void;
  /**
   * Blood from a blow on a character at `point`, `dir` pointing away from the attacker
   * (fx/system.ts bloodNear, and the NPC / hazard blows). True: drawn, skip the faithful splat.
   */
  hit?(point: THREE.Vector3, dir: THREE.Vector3, amount: number): boolean;
  /**
   * A Blood Point Generator at M (fx/effects.ts): elevation p0..p1 degrees, reach p2, spread p3
   * degrees around M's -z. True: drawn.
   */
  spray?(v: readonly unknown[], M: THREE.Matrix4): boolean;
  /** A BloodPool at a floor point: final size (m), grow time (s), opacity 0..1. True: drawn. */
  pool?(point: THREE.Vector3, normal: THREE.Vector3, size: number, grow: number, opacity: number): boolean;
  /** A Part Cap cut (actors/dismember.ts): the cut bone, the body, the blow's direction. */
  cut?(bone: THREE.Object3D, body: THREE.Object3D, dir?: THREE.Vector3): void;
  /** A body gibbed at M (actors/system.ts gibBody). */
  gib?(M: THREE.Matrix4, body: THREE.Object3D): void;
  /** A lit (p46 = 3) particle fountain was created with these textures (world/fx.ts). */
  fountain?(f: GoreFountain, textures: readonly (THREE.Texture | null)[]): void;
}

/** The listener slot: null in Original mode. */
export const gore: { listener: GoreListener | null } = { listener: null };
