// Hit reactions of characters (docs/game-logic.md §15.13): which HitReactBehavior a blow
// plays, and when a blow plays none. Decoded from Suffering.rfl [verified unless marked]:
//
//   * The attack stimulus (event 0x2001) that the Character damage code 0x100e7390 sends for
//     every blow of >= 0 damage reaches the character's default handler unless a behaviour on
//     the stack consumes it (Stomp, TransitAnim, a JumpBehavior before its launch, a
//     CeilingFloorTransition in transit). The handler calls the hit-reaction virtual (vt 72,
//     0x100e6480) with the damage record: the amount after resistances, for damage over time
//     the per-frame share (a Particle Fountain's p18 x frame time, a Damage Action Object's
//     p4 / 30), and the Special Hit Reaction template the damage carries (+0x48: Radius Damage
//     2:736, a Damage Action Object's p7 2:545, melee Attacks' p8 2:439 / 2:430 / 2:440).
//   * The picker 0x1009e650 reads two lists of the character: vt 65 -> p71 ("special" hit
//     reactions) and vt 64 -> p70 (hit reactions by damage; a CartWheeler on a ceiling uses
//     p175 / p177 instead). A special entry is chosen when its p3 equals the blow's Special Hit
//     Reaction (or its p2 lists the attack), whatever the amount. Otherwise the p70 list is
//     walked in order and the LAST entry whose p4 (minimum damage) <= amount wins; a blow
//     below the first entry's p4 plays nothing. p5 is the band's top (< 0: the next entry's p4)
//     and only scales the reaction.
//   * Before playing, message 0x2008 (code 1) asks the behaviour stack; a running HitReact
//     refuses by its p6 mode (0x100e83f0): 0 never interrupted, 1 only by a blow above the
//     running band's top, 2 by a blow at least the running band's p4, 3 always. A MeleeAttack
//     refuses while its Attack's p39 is 0 (no retail Attack has it: melee is interruptible);
//     Dodge, LadderClimb, MorphTransform and AttackedByPlayer (below its threshold) refuse too.
//     Shooting (ProjectileAttack), KillEnemies, MoveTo, Waypoint and Idle do not.
//   * p12 >= 0: a partial-body flinch: the clip plays on the subtree of bone p12 as an
//     independent layer (play flag 8) and nothing else changes: the character keeps walking
//     or attacking. With p13 >= 0 and an attacker: an attacker above bone p13 gets a p7 clip,
//     else p14 (attacker on the character's -x side) or p15 (+x side). A running layered
//     flinch refuses a new one by the same p6 modes, against the new entry's p4 (0x100e8430).
//   * p12 < 0: a whole-body reaction: HitReactBehavior pushed on the stack (vt 73), which
//     pauses the behaviour under it: a random p7 clip at a rate in [p8, p9]; p10 turns the
//     character to the attacker first. p24..p25 (scaled by where the amount sits in the band)
//     is the time a knockdown stays down [inferred: p18..p23 are the knockdown clips: air
//     loop, landing, lying pose, getting up, dying down, hit while down].
//
// Damage over time therefore reacts only when its per-frame share reaches a band (none of the
// retail p70 bands start below 1, so gas and fire never flinch anyone), and electricity
// reacts through its Special Hit Reaction (2:545: a CartWheeler is electrocuted for as long
// as the arc holds it; guards have no 2:545 entry and do not react).

import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

/** Character template slots of the hit-reaction lists (vt 64 / vt 65 / vt 66 defaults). */
export const HIT_SLOT = { hits: 70, specials: 71, deaths: 72 } as const;

export interface HitReactDef {
  ref: ResRef;
  /** p2: attack templates that pick this entry (empty in retail data). */
  attacks: ResRef[];
  /** p3: the Special Hit Reaction template that picks this entry. */
  special?: ResRef;
  /** p4: lowest damage of the band. */
  min: number;
  /** p5: top of the band (< 0: up to the next entry's p4). */
  max: number;
  /** p6: interrupt mode while it plays (0 never, 1 above its top, 2 from its p4, 3 always). */
  mode: number;
  /** p7: clips (one at random). */
  clips: ResRef[];
  /** p8..p9: playback rate range. */
  rate: [number, number];
  /** p10: turn to the attacker. */
  face: boolean;
  /** p12: layer bone of a partial-body flinch, -1 = whole body. */
  layerBone: number;
  /** p13: bone whose height splits p7 (attacker above) from p14 / p15 (sides), -1 = none. */
  sideBone: number;
  /** p14 / p15: clips for an attacker on the character's -x / +x side. */
  side: [ResRef | undefined, ResRef | undefined];
  /** p16..p17: percentages written with the flinch [inferred: a slow-down; reader not found]. */
  slow: [number, number];
  /** p18..p23: knockdown clips [inferred roles]. */
  knock: { air?: ResRef; land?: ResRef; down?: ResRef; getUp?: ResRef; dieDown?: ResRef; hitDown?: ResRef };
  /** p24..p25: time down (s), scaled by the band position [inferred role]. */
  downTime: [number, number];
  /** p28: a blow while down starts a new reaction instead of restarting the down time. */
  newWhileDown: boolean;
}

export interface HitTables {
  /** p70 (vt 64): by damage, in list order. */
  hits: HitReactDef[];
  /** p71 (vt 65): by Special Hit Reaction / attack. */
  specials: HitReactDef[];
}

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in (v as object);
const ref = (v: PropValue | undefined): ResRef | undefined => (isRef(v) ? { pkg: v.pkg, id: v.id } : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? (v as unknown[]).filter(isRef).map((r) => ({ pkg: r.pkg, id: r.id })) : isRef(v) ? [{ pkg: v.pkg, id: v.id }] : []);
const same = (a: ResRef | undefined, b: ResRef | undefined) => !!a && !!b && a.pkg === b.pkg && a.id === b.id;

/** HitReactBehavior values -> definition. */
export function hitReactOf(r: ResRef, v: readonly PropValue[]): HitReactDef {
  return {
    ref: r,
    attacks: refs(v[2]),
    special: ref(v[3]),
    min: num(v[4]),
    max: num(v[5]),
    mode: num(v[6]),
    clips: refs(v[7]),
    rate: [num(v[8], 1), num(v[9], 1)],
    face: num(v[10]) !== 0,
    layerBone: num(v[12], -1),
    sideBone: num(v[13], -1),
    side: [ref(v[14]), ref(v[15])],
    slow: [num(v[16]), num(v[17])],
    knock: { air: ref(v[18]), land: ref(v[19]), down: ref(v[20]), getUp: ref(v[21]), dieDown: ref(v[22]), hitDown: ref(v[23]) },
    downTime: [num(v[24]), num(v[25], 1)],
    newWhileDown: num(v[28]) !== 0,
  };
}

/** The HitReactBehaviors of a template list property (other classes are skipped). */
export function readHitReactList(pkgs: EntityPackageSet, value: PropValue | undefined): HitReactDef[] {
  const out: HitReactDef[] = [];
  for (const r of refs(value)) {
    const t = readObjectTemplate(pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || c?.name !== 'HitReactBehavior') continue;
    out.push(hitReactOf(r, decodeTemplateProps(c, t)));
  }
  return out;
}

/** The p70 / p71 lists of a character's values (instances override the template's). */
export function readHitTables(pkgs: EntityPackageSet, values: readonly PropValue[]): HitTables {
  return { hits: readHitReactList(pkgs, values[HIT_SLOT.hits]), specials: readHitReactList(pkgs, values[HIT_SLOT.specials]) };
}

export interface HitPick {
  def: HitReactDef;
  /** Index in the list it came from. */
  index: number;
  special: boolean;
  /** The band's top as the reaction uses it (p5, or the next entry's p4 when p5 < 0). */
  max: number;
  /** Where the amount sits in the band, 0..1 (1 when the band is a single value). */
  scale: number;
}

export interface HitPickOptions {
  /** p71 entries. */
  specials?: readonly HitReactDef[];
  /** Special Hit Reaction template the damage carries. */
  special?: ResRef;
  /** Attack template the damage came from. */
  attack?: ResRef;
  /** Character flag (+0x70 bit 2) that skips partial-body entries [never seen set; port: unused]. */
  noLayered?: boolean;
}

/** 0x1009e650 over the general list: the last entry with p4 <= amount, -1 for none. */
function bandIndex(list: readonly HitReactDef[], amount: number, noLayered: boolean, next: boolean): number {
  let i = 0;
  for (; i < list.length; i++) {
    if (noLayered && list[i].layerBone !== -1) continue;
    if (list[i].min > amount) break;
  }
  i--;
  if (noLayered) while (i >= 0 && list[i].layerBone !== -1) i--;
  if (i < 0) return -1;
  if (next) i = Math.min(i + 1, list.length - 1);
  return i;
}

/**
 * The hit reaction a blow of `amount` picks (vt 72 0x100e6480 -> 0x1009e650), undefined for
 * none. Specials first (no amount test), then the p70 band.
 */
export function pickHitReact(hits: readonly HitReactDef[], amount: number, o: HitPickOptions = {}): HitPick | undefined {
  const specials = o.specials ?? [];
  if (o.special || o.attack) {
    for (let k = 0; k < specials.length; k++) {
      const d = specials[k];
      if ((o.attack && d.attacks.some((a) => same(a, o.attack))) || (o.special && same(d.special, o.special))) return finish(d, k, true, d.max);
    }
  }
  const i = bandIndex(hits, amount, !!o.noLayered, false);
  if (i < 0) return undefined;
  const d = hits[i];
  let max = d.max;
  // p5 < 0 on a blow without a Special Hit Reaction: the next entry's p4 is the top.
  if (max < 0 && !o.special) {
    const j = bandIndex(hits, amount, !!o.noLayered, true);
    if (j < 0) return undefined;
    max = hits[j].min;
  }
  return finish(d, i, false, max);

  function finish(def: HitReactDef, index: number, special: boolean, top: number): HitPick {
    let scale = 1;
    if (top !== def.min) scale = Math.max(0, Math.min(1, (amount - def.min) / (top - def.min)));
    return { def, index, special, max: top, scale };
  }
}

/** A reaction in progress, as the interrupt test sees it. */
export interface RunningReaction {
  min: number;
  max: number;
  mode: number;
}

/**
 * True when the running reaction refuses a new one (0x100e83f0 / 0x100e8430). `x` is the new
 * blow's whole damage points for a whole-body reaction (the 0x2008 message carries the amount
 * truncated), the new entry's p4 for a partial-body flinch.
 */
export function reactionBlocks(running: RunningReaction, x: number): boolean {
  switch (running.mode) {
    case 0:
      return true;
    case 1:
      return !(running.max < x);
    case 2:
      return !(running.min <= x);
    default:
      return false;
  }
}

/** Time a knockdown stays down: p24 + (p25 - p24) x the band position [inferred role]. */
export function downTimeOf(p: HitPick): number {
  const [a, b] = p.def.downTime;
  return a + (b - a) * p.scale;
}

/** Playback rate in [p8, p9]. */
export function reactionRate(d: HitReactDef, r = Math.random()): number {
  const [a, b] = d.rate;
  const x = a + (b - a) * r;
  return x > 0 ? x : 1;
}

/**
 * Clip of a partial-body flinch: with a side bone and an attacker, p7 when the attacker is
 * above the bone (character space), else p14 for the -x side, p15 for the +x side; otherwise
 * p7. `local` is the attacker in the character's model space, `boneY` the side bone's height.
 */
export function flinchClip(d: HitReactDef, local: { x: number; y: number } | undefined, boneY: number | undefined, r = Math.random()): ResRef | undefined {
  const any = () => (d.clips.length ? d.clips[Math.min(d.clips.length - 1, Math.floor(r * d.clips.length))] : undefined);
  if (d.sideBone < 0 || !local || boneY === undefined) return any();
  if (local.y > boneY) return any();
  return local.x >= 0 ? d.side[1] : d.side[0];
}
