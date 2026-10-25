// Melee auto-face: where the player's body turns while he attacks in melee (docs/game-logic.md
// §14.1 "Player melee: facing and auto-face"). Shared by the human's weapons (shiv, fire axe, the
// empty-handed strike: weapons/system.ts) and the creature form (insanity/creature.ts), which run
// the same Player states in the original.
//
// The original (Suffering.rfl) [verified unless marked]:
//   * The Attack state (3, enter 0x10029990) hands a Melee Weapon (or the creature's empty hands)
//     to MeleeAttack (state 4) or, in first person, FP Melee Attack (state 32). Every Attack
//     template has p9 = 1, which enters the Aim state (2) with the strike (0x1002a318).
//   * Aim per frame (0x10045830) runs the melee target pick 0x1004b350 every frame while state 4
//     or 32 is on: the characters (type 7) that are enemies of the player (0x100e4a50), whose
//     template p128 is at least the best priority so far (starting at Player p219 = 5: creatures
//     only, humans have 1), whose distance (3D, object positions) is within the held Player
//     Weapon Properties' p10 (shiv / axe 4, the empty hand 0.01, the creature's 2:241 6), whose
//     direction is within Player p223 of the BODY's horizontal forward (0x10045470: the view
//     turned by the gait offset +0x5ae; human 90, creature 105) and to which a ray is clear
//     (0x100c7270). Score = p224 · angle / p223 + p225 · distance / range (human 1 / 0.1, creature
//     0.1 / 1); a lower score or a higher priority wins (start score p224 + p225). The pick is the
//     player's target (vtable +0x70 -> +0xc); none clears it. Props are never picked.
//   * The input handler (0x100496c8..0x1004971d) runs the Turn state (5) every frame of states 4 /
//     32. Turn (0x10046dc0), with no turn input and a target at +0xc: the angle from the body's
//     forward to the target is closed at the state's rate without overshoot (input = -angle /
//     (rate · dt), else ±1): Player p173 = 350 °/s, but p167 = 220 °/s in first person (the
//     first-person test comes first). The turn rotates the player object, so the view turns with
//     the body [the follow camera itself was not located: strong]. With turn input the player
//     turns as usual and nothing is auto-faced that frame. No target: no auto turn.
//   * So the auto-face runs continuously from the strike's start through the recovery clip (state
//     4 lasts until the combo's last clip ends, 0x1002a13f..0x1002a306), re-picking every frame.
//   * The body offset +0x5ae: Move leave (0x100457f9) sets its goal to 0, turned at Player p133 =
//     170 °/s (main per frame 0x1004c33b): a standing body faces the view. Moving, it is the gait's
//     heading deviation (at most half a set's width plus its 10 % hysteresis, 54°).
//   * With no target on the ground, the strike's forward root motion is scaled by PWP p85 (shiv /
//     axe 0.5, MeleeAttack per frame 0x1002a005 -> animator +0x6c, the z root-motion scale at
//     SUFFERING.EXE 0x478d82): melee-lunge.ts, which reads this frame's pick (`target`).
//
// Port: the camera can orbit a standing body (the original turns the player instead), so at the
// start of a third-person swing the body takes the facing the original would have (the view, or
// the gait offset clamped to 54° while moving) [port mapping]; then `MeleeAutoFace.step` runs
// the pick and the turn every frame of the swing, turning the view yaw and the body together.

export interface FaceVec {
  x: number;
  y: number;
  z: number;
}

/** Player template values for the pick and the turn (Player 2:5 human, 2:240 creature). */
export interface MeleeFaceParams {
  /** p219: lowest priority (character template p128) that can be picked. */
  minPriority: number;
  /** p223: cone half-angle around the body's forward (degrees). */
  coneDeg: number;
  /** p224 / p225: score weights of the angle (per cone) and the distance (per range). */
  angleWeight: number;
  distWeight: number;
  /** p173: auto-face rate in third person (deg/s). */
  rateDeg: number;
  /** p167: the first-person turn rate, used by the auto-face in first person (deg/s). */
  fpRateDeg: number;
}

/** Human Player 2:5. */
export const HUMAN_MELEE_FACE: MeleeFaceParams = { minPriority: 5, coneDeg: 90, angleWeight: 1, distWeight: 0.1, rateDeg: 350, fpRateDeg: 220 };
/** Creature-form Player 2:240. */
export const CREATURE_MELEE_FACE: MeleeFaceParams = { minPriority: 5, coneDeg: 105, angleWeight: 0.1, distWeight: 1, rateDeg: 350, fpRateDeg: 220 };
/** Player p133: the body offset returns to the view at this rate once the player stops (deg/s). */
export const BODY_RELAX_DEG = 170;
/** Largest body offset the gait gives (half a 90° heading set plus 10 % of its width, degrees). */
export const MAX_GAIT_OFFSET_DEG = 54;

/** Reads the pick / turn values from a Player template's values (missing ones: `fallback`). */
export function readMeleeFaceParams(v: readonly unknown[] | undefined, fallback: MeleeFaceParams = HUMAN_MELEE_FACE): MeleeFaceParams {
  const n = (i: number, d: number) => {
    const x = v?.[i];
    return typeof x === 'number' && Number.isFinite(x) ? x : d;
  };
  return {
    minPriority: n(219, fallback.minPriority),
    coneDeg: n(223, fallback.coneDeg),
    angleWeight: n(224, fallback.angleWeight),
    distWeight: n(225, fallback.distWeight),
    rateDeg: n(173, fallback.rateDeg),
    fpRateDeg: n(167, fallback.fpRateDeg),
  };
}

export interface FaceCandidate<T = unknown> {
  /** Object position (feet). */
  x: number;
  y: number;
  z: number;
  /** Character template p128. */
  priority: number;
  ref: T;
}

const DEG = Math.PI / 180;

export function wrapYaw(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

/** Yaw (port convention: 0 looks down -Z) of the horizontal direction from `o` to `p`. */
export function yawTo(o: FaceVec, p: FaceVec): number {
  return Math.atan2(-(p.x - o.x), -(p.z - o.z));
}

/**
 * The melee target pick (0x1004b350): candidates already filtered to live enemies of the player.
 * `facingYaw` is the body's facing; `range` the held Player Weapon Properties p10 (m).
 */
export function pickMeleeTarget<T>(
  origin: FaceVec,
  facingYaw: number,
  range: number,
  list: readonly FaceCandidate<T>[],
  p: MeleeFaceParams,
  blocked?: (c: FaceCandidate<T>) => boolean,
): FaceCandidate<T> | undefined {
  const fx = -Math.sin(facingYaw), fz = -Math.cos(facingYaw);
  const cone = p.coneDeg * DEG;
  let best: FaceCandidate<T> | undefined;
  let bestScore = p.angleWeight + p.distWeight;
  let bestPriority = p.minPriority;
  for (const c of list) {
    if (c.priority < bestPriority) continue;
    const dx = c.x - origin.x, dy = c.y - origin.y, dz = c.z - origin.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > range || d < 1e-6) continue;
    // The 3D direction against the horizontal forward: height counts in the angle.
    const cos = Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d));
    const angle = Math.acos(cos);
    if (angle > cone) continue;
    if (blocked?.(c)) continue;
    const score = (p.angleWeight * angle) / (cone || 1) + (p.distWeight * d) / (range || 1);
    if (score < bestScore || c.priority > bestPriority) {
      best = c;
      bestScore = score;
      bestPriority = c.priority;
    }
  }
  return best;
}

/** One frame of the Turn state's auto-face: the yaw change (rad) toward `goalYaw`, no overshoot. */
export function faceStep(facingYaw: number, goalYaw: number, rateDeg: number, dt: number): number {
  const d = wrapYaw(goalYaw - facingYaw);
  const max = rateDeg * DEG * Math.max(0, dt);
  return Math.abs(d) <= max ? d : Math.sign(d) * max;
}

/** The player as the auto-face sees it (PlayerController). */
export interface FacePlayer {
  yaw: number;
  bodyYaw: number;
  readonly position: FaceVec;
  readonly mode: 'fp' | 'tp';
  readonly root?: { rotation: { y: number } };
}

/**
 * Third-person swing start: the body takes the facing the original's player would have (body =
 * view + gait offset; standing the offset is 0, moving at most 54°) [port mapping of the orbit].
 */
export function alignBodyForMelee(pl: FacePlayer, moving: boolean): void {
  if (pl.mode === 'fp') return;
  const o = wrapYaw(pl.bodyYaw - pl.yaw);
  const max = moving ? MAX_GAIT_OFFSET_DEG * DEG : 0;
  const c = Math.max(-max, Math.min(max, o));
  if (c === o) return;
  pl.bodyYaw = wrapYaw(pl.yaw + c);
  if (pl.root) pl.root.rotation.y = pl.bodyYaw;
}

/** Per-swing auto-face state: notices turn input (any yaw change since its last frame). */
export class MeleeAutoFace {
  private lastYaw: number | null = null;
  /** The target picked this frame (the player's +0xc). */
  target: FaceCandidate | undefined;

  start(pl: FacePlayer, moving: boolean): void {
    alignBodyForMelee(pl, moving);
    this.lastYaw = pl.yaw;
    this.target = undefined;
  }

  stop(): void {
    this.lastYaw = null;
    this.target = undefined;
  }

  get active(): boolean {
    return this.lastYaw !== null;
  }

  /**
   * One frame of states 4 / 32: pick (always, from the body's facing) and, with no turn input
   * since the last frame, turn the view and the body together toward the target.
   */
  step<T>(
    pl: FacePlayer,
    dt: number,
    p: MeleeFaceParams,
    range: number,
    list: readonly FaceCandidate<T>[],
    blocked?: (c: FaceCandidate<T>) => boolean,
  ): FaceCandidate<T> | undefined {
    if (this.lastYaw === null) return undefined;
    const input = Math.abs(wrapYaw(pl.yaw - this.lastYaw)) > 1e-6;
    const facing = pl.mode === 'fp' ? pl.yaw : pl.bodyYaw;
    const t = pickMeleeTarget(pl.position, facing, range, list, p, blocked);
    this.target = t as FaceCandidate | undefined;
    if (t && !input) {
      const s = faceStep(facing, yawTo(pl.position, t), pl.mode === 'fp' ? p.fpRateDeg : p.rateDeg, dt);
      if (s !== 0) {
        pl.yaw += s;
        pl.bodyYaw = wrapYaw(pl.bodyYaw + s);
        if (pl.root) pl.root.rotation.y = pl.bodyYaw;
      }
    }
    this.lastYaw = pl.yaw;
    return t;
  }
}
