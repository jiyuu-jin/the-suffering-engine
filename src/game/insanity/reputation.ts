// Reputation rules of the original (docs/game-logic.md §13.2, "Reputation"): everything that
// changes the player's reputation (Player +0x454), renderer-free so the census tool
// (tools/reputation-census.ts) and the tests use the same rules as the game.
//
// RFL code read [verified unless marked]:
//   0x10041460  Player: reputation += amount (no clamp), then the skin update (§13.6). Its only
//               callers are the five below and two cheat entries (0x1000147b / 0x10001491);
//               0x10041480 / 0x100414b0 set it to p71 / p70 (cheats).
//   0x1008e510  Reputation Points Sender, input p1: by its p0 target mode, 0 the message's sender,
//               1 the player, 2 each of its links (0x1008e541 loop), the apply (vt +0x4c,
//               0x1001a7c0) runs once per target found; the apply ignores the target and adds p3 to
//               the player's reputation. p2 destroys (0x100cb870).
//   0x100e7390  Character damage, after the health change (0x100e74a0..0x100e75fa):
//               - a hit by the player (damage > 0) on an NPC with an attached Action Dialog (the
//                 NPC's dialog handle +0x5a2, set on the dialog's attach) runs the dialog's count
//                 (0x1008e130, below), unless the NPC bleeds from a cut (+0x536, the bleed rate of
//                 its Part Cap component, 0x10040d10; actors/dismember.ts);
//               - the death blow of the player (dead now, not before, the damager is the player):
//                 reputation += victim p166 + the attached dialog's p22 when not paid yet
//                 (0x1008d300), passed to the kill handler 0x10033890 (which adds it first, then
//                 the insanity meter, §13.2); then the victim fires its output p169 (0x100e75fa).
//   0x1008e130  Action Dialog count ("AttackedByPlayer"): hits closer than p14 s to the last
//               counted one are not counted; a gap over p19 s starts the count again; not while
//               the NPC's AttackedByPlayer behaviour (type 0x7c) runs. On the count reaching p18:
//               reputation += p22 once (flag 0x40, the kill then pays nothing more) and the
//               dialog's state 4 (the update 0x1008dda0 fires p30 to the level logic; below p18
//               the AttackedByPlayer warning: actors/director.ts dialogWarn / dialogTurn).
//   0x100916f0  Ambient Creature killed (vt +0x90, called by the PhysicalObject damage code with
//               the killer): reputation += p26 when the killer is the player.
//   0x10119150  Body-part reaction (Character p16 Part Caps): a part cut off by the player from a
//               body dead for more than the Part Cap's p4 s: reputation += its p5 (0x1011961f).
//               Applied by actors/dismember.ts (corpseCutReputation).

import type { PropValue } from '../../formats/entities';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * How many times a Reputation Points Sender applies its p3 on its p1 message: p0 is the target
 * mode (0 the message's sender, 1 the player, 2 each link), the add runs once per target found
 * (0x1008e510). `links`: its live links; `player`: a player exists.
 */
export function senderApplications(target: number, links: number, player = true): number {
  if (target === 0) return 1;
  if (target === 1) return player ? 1 : 0;
  if (target === 2) return Math.max(0, links);
  return 0;
}

/** The Action Dialog's count rules (p14, p18, p19) and its reputation (p22). */
export interface DialogRepRules {
  /** p14: hits closer than this (s) to the last counted one are not counted. */
  minGap: number;
  /** p19: a gap over this (s) starts the count again. */
  resetAfter: number;
  /** p18: counted hits that pay. */
  hits: number;
  /** p22: reputation paid once (by the count or by the kill). */
  points: number;
}

export function dialogRepRules(v: readonly PropValue[]): DialogRepRules {
  return { minGap: num(v[14], 3), resetAfter: num(v[19], 30), hits: num(v[18], 3), points: num(v[22]) };
}

/** An Action Dialog's count state (Action Dialog +0x10 / +0x14 / flag 0x40). */
export interface DialogRepState {
  count: number;
  /** Game time of the last counted hit (s); -Infinity before the first. */
  last: number;
  /** p22 paid (flag 0x40). */
  paid: boolean;
}

export const newDialogRepState = (): DialogRepState => ({ count: 0, last: -Infinity, paid: false });

/**
 * A hit of the player's on the dialog's NPC at game time `now` (0x1008e130). Returns the
 * reputation to pay now (p22 on the count reaching p18, once), and updates the state.
 */
export function dialogHit(s: DialogRepState, r: DialogRepRules, now: number): number {
  if (now - s.last < r.minGap) return 0;
  if (now - s.last > r.resetAfter) s.count = 0;
  s.count++;
  s.last = now;
  if (s.count < r.hits || s.paid) return 0;
  s.paid = true;
  return r.points;
}

/** The dialog's share of a kill by the player (0x1008d300): p22 unless paid already. */
export function dialogKillPoints(s: DialogRepState, r: DialogRepRules): number {
  if (s.paid) return 0;
  s.paid = true;
  return r.points;
}

/**
 * Reputation of a kill by the player for a victim of class `cls` with property values `v`:
 * Characters their p166 (plus the attached dialog's share, dialogKillPoints), Ambient
 * Creatures their p26. Anything else: none.
 */
export function killReputation(cls: string, v: readonly PropValue[]): number {
  if (cls === 'Ambient Creature') return num(v[26]);
  if (cls === 'Player') return 0;
  return v.length > 166 ? num(v[166]) : 0;
}

/** The Character output fired when the player kills it (0x100e75fa). */
export const KILLED_BY_PLAYER_OUTPUT = 169;

/** Part Cap rule (actors/dismember.ts): a part cut from a body dead longer than p4 s by the
 * player pays p5. */
export function partCapReputation(v: readonly PropValue[], deadFor: number): number {
  return deadFor > num(v[4], 5) ? num(v[5]) : 0;
}
