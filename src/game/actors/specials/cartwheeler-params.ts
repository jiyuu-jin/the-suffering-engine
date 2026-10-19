// CartWheeler (the blade-limbed "Slayer" creature) parameters, decoded from the retail templates
// and the Suffering.rfl class code (docs/game-logic.md §15.7.5). Pure functions over a package
// set, so tests check the decoded numbers without a renderer. Tags: [verified 0xADDR] read in the
// code, [data] from the retail values, [inferred] otherwise.
//
// Class code (vtable 0x10152f88, ctor 0x10071dd0):
//   behaviour type -> template slot (vt 46, 0x100720c0; Character default 0x100e17c0):
//     5  MeleeAttack            p179 on a ceiling (and not in a transition), else Character p87
//     36 JumpAttack             p181
//     37 / 38 JumpAttackLaunch / Stick   none (built from the JumpAttack's Attacks)
//     41 CeilingFloorTransition p178
//     44 CartWheelerKillMelee   p182 (KillMelee 77 is mapped to 44 and back, vt 61 / 62)
//     50 FleeLight              p183
//   hit reactions (vt 64, 0x100722b0): on a ceiling p177 when the blow kills, else p175; on the
//     floor p186 (the head's own reaction) while the head bone p187 is intact, p184 in the close
//     stance, else p70. Special hit reactions (vt 65): p176 on a ceiling, else p71. Death (vt 66):
//     p185 in the close stance on the floor, else p72.
//   p180 = 1: on the ceiling from the start (init vt 3, 0x10071eb0, calls SetOnCeiling(1)).

import type { EntityPackageSet, PropValue } from '../../../formats/entities';
import type { ResRef } from '../../../formats/model';
import type { ClipRef } from '../clipmap';
import { condBits, pickVariant, readVariant, readVariants, type BehaviorVariant } from '../variants';
import { meleeBlow } from './params';
import { num, readTemplate, ref, refs } from './runtime';
import { readHitReactList, type HitTables } from '../hit-react';

/** CartWheeler template slots [verified, see the header]. */
export const CW_SLOT = {
  movementAnim: 92,
  melee: 87,
  ceilingHit: 175,
  ceilingSpecialHit: 176,
  ceilingDeath: 177,
  transition: 178,
  ceilingMelee: 179,
  startOnCeiling: 180,
  jumpAttack: 181,
  killMelee: 182,
  fleeLight: 183,
  closeHits: 184,
  closeDeath: 185,
  headHit: 186,
} as const;

/** CeilingFloorTransitionBehavior [verified: start 0x1010e2c0, events 0x10110610, end 0x1010e430]. */
export interface TransitionParams {
  /** Ceiling -> floor: p2 let go (its root translation lowers the body), p3 fall loop, p4 landing. */
  letGo?: ClipRef;
  fall?: ClipRef;
  land?: ClipRef;
  /** Floor -> ceiling: p5 launch, p6 rise loop, p7 catching the ceiling. */
  launch?: ClipRef;
  rise?: ClipRef;
  grab?: ClipRef;
  /** p8: speed going up (m/s, gravity off). */
  upSpeed: number;
  /** p9: gravity scale falling, p10: speed at letting go (m/s, down). */
  gravity: number;
  downSpeed: number;
  /** p11: seconds idle after the transition. */
  hold: number;
}

export function transitionParams(v: readonly PropValue[]): TransitionParams {
  return {
    letGo: ref(v[2]),
    fall: ref(v[3]),
    land: ref(v[4]),
    launch: ref(v[5]),
    rise: ref(v[6]),
    grab: ref(v[7]),
    upSpeed: num(v[8], 15),
    gravity: num(v[9], 1),
    downSpeed: num(v[10], 0),
    hold: num(v[11], 0),
  };
}

/**
 * CartWheelerKillMeleeBehavior [verified: start 0x1007cd70 + hook 0x10072f00, update hook
 * 0x10074c80, child hook 0x10073180, generic KillMelee 0x1007cf10 / 0x1007ce60].
 */
export interface KillMeleeParams {
  ref?: ResRef;
  /** p2..p3: wait after a melee attack before the next (s) (KillMelee child-finished). */
  attackPause: [number, number];
  /** p5: percent chance of the special reposition at the start (0x1007cbc0) [not modelled]. */
  repositionChance: number;
  /** p11: re-check interval of the jump attack (s); p12: wait after a jump or a failed roll. */
  jumpRecheck: number;
  jumpWait: number;
  /** p13: percent chance to jump once the tests pass (0x10071140). */
  jumpChance: number;
  /** p14..p15: target distance band (m, 3D) of the jump attack. */
  jumpBand: [number, number];
  /** p16: half angle (degrees) the target must be within, ahead. */
  jumpCone: number;
  /** p17: width of the swept test to the target (m) [inferred unit]. */
  jumpSweep: number;
  /** p18 / p19: the close stance starts within p18 m and ends beyond p19 m (condition bit 1). */
  closeIn: number;
  closeOut: number;
  /** p20: AlertInfo played once the head is shot off (its p0 clips, p1 sounds) (0x10073080). */
  alertClips: ClipRef[];
  alertSounds: string[];
  /** p21 / p22: flashlight intensity tests, p23: percent chance to flee the light (0x100747a0). */
  lightSeen: number;
  lightFlee: number;
  lightChance: number;
  /** p24..p25: wait between two light flights (s) (0x10072f00). */
  lightWait: [number, number];
}

export function killMeleeParams(pkgs: EntityPackageSet, r: ResRef | undefined, v: readonly PropValue[]): KillMeleeParams {
  const alert = readTemplate(pkgs, ref(v[20]));
  const lo = num(v[2], 0.1), hi = num(v[3], 0.5);
  return {
    ref: r,
    attackPause: [Math.min(lo, hi), Math.max(lo, hi)],
    repositionChance: num(v[5], 0),
    jumpRecheck: num(v[11], 0.15),
    jumpWait: num(v[12], 4),
    jumpChance: num(v[13], 0),
    jumpBand: [num(v[14], 4), num(v[15], 6.5)],
    jumpCone: num(v[16], 30),
    jumpSweep: num(v[17], 1),
    closeIn: num(v[18], 5),
    closeOut: num(v[19], 7),
    alertClips: alert?.cls === 'AlertInfo' ? refs(alert.v[0]) : [],
    alertSounds: alert?.cls === 'AlertInfo' ? refs(alert.v[1]).map((x) => `${x.pkg}:${x.id}`) : [],
    lightSeen: num(v[21], 0.4),
    lightFlee: num(v[22], 0.4),
    lightChance: num(v[23], 0),
    lightWait: [num(v[24], 1.5), Math.max(num(v[24], 1.5), num(v[25], 3))],
  };
}

/** A melee or leap Attack with its blow (Melee Weapon p68..p69 mean x Attack p6). */
export interface CwAttack {
  ref?: ResRef;
  clip?: ClipRef;
  /** Attack p15 / p16: target distance band (m, horizontal, target radius off). */
  minReach: number;
  reach: number;
  /** Attack p14: the band scales with the creature's size. */
  scaled: boolean;
  /** Attack p17: height limit (m); <= 0 none. */
  maxDy: number;
  damage: number;
}

function attackOf(pkgs: EntityPackageSet, values: readonly PropValue[], r: ResRef | undefined): CwAttack | undefined {
  const at = readTemplate(pkgs, r);
  if (!at || at.cls !== 'Attack') return undefined;
  const blow = meleeBlow(pkgs, values as PropValue[], r);
  return {
    ref: r,
    clip: ref(at.v[0]),
    minReach: num(at.v[15], 0),
    reach: num(at.v[16], 1.2),
    scaled: num(at.v[14], 0) !== 0,
    maxDy: num(at.v[17], -1),
    damage: blow?.damage ?? 10,
  };
}

/**
 * JumpAttackBehavior [verified: start 0x10073b90, children 0x10073e50; JumpAttackLaunch
 * 0x100736b0 / 0x100743c0; JumpAttackStick 0x10073920]: walk up to the launch Attack's range
 * (MoveTo, p5 s), face the target, leap (the launch clip's root motion carries the body); a touch
 * inside the cone / height window sticks (the stick Attack's clip), the clip running out misses
 * (p9); after a stick p10.
 */
export interface JumpAttackParams {
  ref?: ResRef;
  /** p2: passed to the stick (its time scale) [inferred]. */
  stickTime: number;
  /** p3 / p4: launch and stick Attacks. */
  launch?: CwAttack;
  stick?: CwAttack;
  /** p5: time allowed to get into launch range (s). */
  approach: number;
  /** p6: cone (degrees) of the touch test; p7..p8: target height window (m, target - self). */
  cone: number;
  height: [number, number];
  /** p9: missed landing, p10: recovering after a stick. */
  missed?: ClipRef;
  recover?: ClipRef;
}

export function jumpAttackParams(pkgs: EntityPackageSet, values: readonly PropValue[], r: ResRef | undefined): JumpAttackParams | undefined {
  const t = readTemplate(pkgs, r);
  if (!t || t.cls !== 'JumpAttackBehavior') return undefined;
  const v = t.v;
  return {
    ref: r,
    stickTime: num(v[2], 1),
    launch: attackOf(pkgs, values, ref(v[3])),
    stick: attackOf(pkgs, values, ref(v[4])),
    approach: num(v[5], 2),
    cone: num(v[6], 0),
    height: [num(v[7], -0.5), num(v[8], 0.7)],
    missed: ref(v[9]),
    recover: ref(v[10]),
  };
}

/** MovementAnimBehavior clips: p2 idle, p3 walk, p5 run, p9 / p10 turns (left / right). */
export interface Gait {
  ref?: ResRef;
  idle?: ClipRef;
  walk?: ClipRef;
  run?: ClipRef;
  turnLeft?: ClipRef;
  turnRight?: ClipRef;
}

export function gaitOf(b: Pick<BehaviorVariant, 'ref' | 'v'> | undefined): Gait | undefined {
  if (!b) return undefined;
  const v = b.v;
  return { ref: b.ref, idle: ref(v[2]), walk: ref(v[3]) ?? ref(v[5]), run: ref(v[5]) ?? ref(v[3]), turnLeft: ref(v[9]), turnRight: ref(v[10]) };
}

/** Everything the CartWheeler controller needs, per condition word where the data varies. */
export interface CartWheelerParams {
  startOnCeiling: boolean;
  transition: TransitionParams;
  /** p179 MeleeAttackBehavior's Attacks (on the ceiling). */
  ceilingAttacks: CwAttack[];
  jump?: JumpAttackParams;
  /** p183 FleeLightBehavior: p2 [unknown], p3 AlertInfo (backing-off clip, hiss). */
  fleeClips: ClipRef[];
  fleeSounds: string[];
  /** Hit reactions on the ceiling: p175 (alive), p177 (killed: falls off). */
  ceilingHit: ClipRef[];
  /**
   * The hit-reaction lists on a ceiling (CartWheeler vt 64 / vt 65 0x100722b0 / 0x10072180:
   * p175 by damage, p176 by Special Hit Reaction instead of p70 / p71) [verified].
   */
  ceilingHits: HitTables;
  ceilingDeath?: { clips: ClipRef[]; fall?: ClipRef; land?: ClipRef };
  /** KillMelee by condition word (variants p106 by p1, else p182). */
  killMelee(bits: number): KillMeleeParams;
  /** MovementAnim by condition word (variants by p1, else p92). */
  gait(bits: number): Gait | undefined;
}

export function cartWheelerParams(pkgs: EntityPackageSet, values: readonly PropValue[], types: readonly number[]): CartWheelerParams {
  const variants = readVariants(pkgs, values, types);
  const slot = (i: number) => readVariant(pkgs, ref(values[i]));
  const kmDefault = slot(CW_SLOT.killMelee);
  const kmCache = new Map<number, KillMeleeParams>();
  const gaitDefault = slot(CW_SLOT.movementAnim);
  const ceilMelee = readTemplate(pkgs, ref(values[CW_SLOT.ceilingMelee]));
  const flee = readTemplate(pkgs, ref(values[CW_SLOT.fleeLight]));
  const fleeAlert = flee ? readTemplate(pkgs, ref(flee.v[3])) : undefined;
  const hitClips = (i: number) => {
    const h = readTemplate(pkgs, ref(values[i]));
    return h?.cls === 'HitReactBehavior' ? h : undefined;
  };
  const ceilHit = hitClips(CW_SLOT.ceilingHit);
  const ceilDeath = hitClips(CW_SLOT.ceilingDeath);
  const tr = readTemplate(pkgs, ref(values[CW_SLOT.transition]));
  return {
    startOnCeiling: num(values[CW_SLOT.startOnCeiling], 0) === 1,
    transition: transitionParams(tr?.cls === 'CeilingFloorTransitionBehavior' ? tr.v : []),
    ceilingAttacks: ceilMelee?.cls === 'MeleeAttackBehavior' ? refs(ceilMelee.v[2]).map((r) => attackOf(pkgs, values, r)).filter((a): a is CwAttack => !!a) : [],
    jump: jumpAttackParams(pkgs, values, ref(values[CW_SLOT.jumpAttack])),
    fleeClips: fleeAlert?.cls === 'AlertInfo' ? refs(fleeAlert.v[0]) : [],
    fleeSounds: fleeAlert?.cls === 'AlertInfo' ? refs(fleeAlert.v[1]).map((x) => `${x.pkg}:${x.id}`) : [],
    ceilingHit: ceilHit ? refs(ceilHit.v[7]) : [],
    ceilingHits: { hits: readHitReactList(pkgs, values[CW_SLOT.ceilingHit]), specials: readHitReactList(pkgs, values[CW_SLOT.ceilingSpecialHit]) },
    // HitReactBehavior p7 the reaction, p18 / p19 the fall loop / landing it continues with.
    ceilingDeath: ceilDeath ? { clips: refs(ceilDeath.v[7]), fall: ref(ceilDeath.v[18]), land: ref(ceilDeath.v[19]) } : undefined,
    killMelee(bits) {
      let k = kmCache.get(bits);
      if (!k) {
        const b = pickVariant(variants, 'CartWheelerKillMeleeBehavior', bits, kmDefault);
        k = killMeleeParams(pkgs, b?.ref, b?.v ?? []);
        kmCache.set(bits, k);
      }
      return k;
    },
    gait(bits) {
      return gaitOf(pickVariant(variants, 'MovementAnimBehavior', bits, gaitDefault));
    },
  };
}

export { condBits };
