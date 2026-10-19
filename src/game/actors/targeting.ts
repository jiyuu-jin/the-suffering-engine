// Target choice of KillEnemiesBehavior and the HostilityBehavior that restarts it, as the original
// does them (Suffering.rfl; docs/game-logic.md §15.15). Pure rules: no Three.js, no game state.
//
//   Candidates   (search 0x100fbdd0) every character in a +-p7 box on x / z around the chooser
//                (the engine's sorted-axis character lists, 0x100e0890 / 0x100e0960; the player is
//                one of them), plus non-character current / p3 targets. The current target is
//                not added on its own: a character target outside the box is dropped at the next
//                choice [verified].
//   Add          (0x100f9eb0) a candidate is left out when its team is an ally team (p4), it is
//                dead, it runs a DormantBehavior (0x10070b20 with the class hash of
//                DormantBehavior), or it is the chooser. It must be the current target, a p3
//                target, of an enemy team (p2) or targeting the chooser (its GameObject target
//                handle, +0xc). The sight test (0x100f39a0: range p7 / always-see p9 / cone p11,
//                no line of sight) must pass, except for the current target and, with p5 set, a
//                p3 target [verified].
//   Score        (0x100f9eb0, fields from init 0x100f7d40) [verified]:
//                  p23 x n / p8 (n = characters already attacking it, the chooser not counted;
//                    its KillObject start / end count them, 0x100fe8ec / 0x100f3d2f), and - 1000
//                    once n >= its GameObject p8;
//                  - 1000 when it is on the recent-failure list (MoveTo failed, 0x100fbbdf);
//                  + p18 x (1 - d / p7) (d the 3D distance), + p19 for the current target;
//                  + p20 x (cos + 1) / 2, cos between the chooser's facing and the way to it;
//                  + p21 x its GameObject p4, + p22 x its health / max health;
//                  + p24 x (damage it dealt the chooser in the last p14 s) / (all damage taken in
//                    them) (the damage memory, 0x100a34f0 / 0x100a36c0; nothing when none);
//                  + p25 when it targets the chooser, + p16 for an enemy team, + p17 for a p3
//                    target.
//   Choice       (0x100fa1f0) highest score first; the first that is seen through a clear line
//                (sight test, then vt 20 0x100f2570: with p6 a ray to a quarter of its bounds),
//                is the current target, or is a p3 target with p5 set wins. None: no target.
//   Re-picks     (update 0x100fd770) every p12 + U(0, p13) s, rolled once when the behaviour
//                starts and at least 0.5 s when p12 > 0; p12 = 0 every frame; p12 < 0 only the
//                first pick (1a / 1b rats: p12 = -1). The current target is dropped (and the next
//                pick made at once) when it is farther than p10 (3D), unless it is a p3 target
//                held with p5; message 0x200e and 0x2008 code 6 forget it too [verified].
//   Hostility    (HostilityBehavior, vtable 0x101567a0: start 0x100f7880, update 0x100f3520,
//                child events 0x100f7a30, re-arm 0x100f7950) [verified]: starts its KillEnemies
//                child after U(0, 1/6) s; when that child ends without a target the Hostility
//                listens (ListenBehavior child) and starts it again after p3 + U(0, 1) x (p4 - p3)
//                s. Its first engagement installs the p2 sub-behaviour templates (movement / move
//                parameters while fighting).

import type { PropValue } from '../../formats/entities';

/** KillEnemiesBehavior score weights and timing (p5, p12..p14, p16..p25). */
export interface TargetWeights {
  /** p16: candidate of an enemy team (p2). */
  enemyTeam: number;
  /** p17: candidate listed in p3. */
  explicit: number;
  /** p18: x (1 - d / range). */
  near: number;
  /** p19: the current target. */
  current: number;
  /** p20: x (cos + 1) / 2 of the angle off the chooser's facing. */
  facing: number;
  /** p21: x the candidate's GameObject p4. */
  priority: number;
  /** p22: x the candidate's health fraction. */
  health: number;
  /** p23: x attackers / the candidate's GameObject p8. */
  crowd: number;
  /** p24: x its share of the damage taken in the last `memory` s. */
  damage: number;
  /** p25: the candidate targets the chooser. */
  targetsMe: number;
  /** p14: damage memory window (s). */
  memory: number;
  /** p5 != 0: a p3 target may be chosen unseen. */
  unseenExplicit: boolean;
  /** p12 / p13: re-pick interval (see repickInterval). */
  repick: number;
  repickRand: number;
}

const num = (v: PropValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The weights of a KillEnemiesBehavior's values (template + instance). */
export function targetWeights(v: readonly PropValue[]): TargetWeights {
  return {
    enemyTeam: num(v[16], 10),
    explicit: num(v[17], 100),
    near: num(v[18], 0.75),
    current: num(v[19], 1),
    facing: num(v[20], 0.5),
    priority: num(v[21], 0),
    health: num(v[22], 0),
    crowd: num(v[23], -0.8),
    damage: num(v[24], 1),
    targetsMe: num(v[25], 0),
    memory: num(v[14], 10),
    unseenExplicit: num(v[5], 1) !== 0,
    repick: num(v[12], 2),
    repickRand: num(v[13], 2),
  };
}

/**
 * Characters without a KillEnemiesBehavior (port default): the weights every retail creature
 * template uses (CartWheeler 10:102 and most others) [data].
 */
export const DEFAULT_WEIGHTS: TargetWeights = targetWeights([]);

/**
 * Seconds between re-picks, rolled once per KillEnemies run: p12 > 0 -> max(p12, 0.5) + U(0, p13);
 * otherwise p12 itself (0: every frame; < 0: never after the first pick) [verified, 0x100f7e82].
 */
export function repickInterval(w: Pick<TargetWeights, 'repick' | 'repickRand'>, rand: number): number {
  if (!(w.repick > 0)) return w.repick;
  return Math.max(0.5, w.repick) + rand * w.repickRand;
}

/** What the score of one candidate reads (all from the chooser's point of view). */
export interface TargetCandidate {
  /** Its team is in the chooser's p2. */
  enemyTeam: boolean;
  /** It is listed in p3. */
  explicit: boolean;
  /** Its current target is the chooser. */
  targetsMe: boolean;
  /** It is the chooser's current target. */
  current: boolean;
  /** 3D distance (m). */
  dist: number;
  /** Cosine of the angle between the chooser's facing and the way to it. */
  cos: number;
  /** Its GameObject p4 (0.5 for the player and most characters, 0.1 for rats). */
  priority: number;
  /** Its health / max health. */
  healthFrac: number;
  /** Characters other than the chooser attacking it. */
  attackers: number;
  /** Its GameObject p8 (4 for the player and every retail character). */
  maxAttackers: number;
  /** Its share of the damage the chooser took in the memory window (0..1). */
  damageShare: number;
  /** On the chooser's recent-failure list. */
  failed: boolean;
}

/** A candidate's score (0x100f9eb0), `range` = p7 (m). */
export function targetScore(w: TargetWeights, range: number, c: TargetCandidate): number {
  let s = c.maxAttackers > 0 ? (c.attackers * w.crowd) / c.maxAttackers : 0;
  if (c.attackers >= c.maxAttackers) s -= 1000;
  if (c.failed) s -= 1000;
  s += w.near * (1 - c.dist / Math.max(range, 1e-6));
  if (c.current) s += w.current;
  s += (w.facing * (c.cos + 1)) / 2;
  s += w.priority * c.priority;
  s += w.health * c.healthFrac;
  s += w.damage * c.damageShare;
  if (c.targetsMe) s += w.targetsMe;
  if (c.enemyTeam) s += w.enemyTeam;
  if (c.explicit) s += w.explicit;
  return s;
}

/**
 * The choice (0x100fa1f0): candidates by score, highest first (ties keep their order); the first
 * that `accept` lets through (seen through a clear line, the current target, or a p3 target with
 * p5) wins. Returns its index in `scores`, or -1.
 */
export function chooseTarget(scores: readonly number[], accept: (i: number) => boolean): number {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of order) if (accept(i)) return i;
  return -1;
}

/** Share of the damage taken within `window` s before `now` that came from `from` (0 when none). */
export function damageShare<T>(log: readonly { by: T; amount: number; t: number }[], from: (by: T) => boolean, now: number, window: number): number {
  let all = 0, mine = 0;
  for (const h of log) {
    if (h.t < now - window) continue;
    all += h.amount;
    if (from(h.by)) mine += h.amount;
  }
  return all > 0 ? mine / all : 0;
}

/** HostilityBehavior p3..p4: seconds before it restarts its KillEnemies after one found no target. */
export function hostilityRetry(v: readonly PropValue[]): [number, number] {
  const a = num(v[3], 0.4), b = num(v[4], a);
  return [a, Math.max(a, b)];
}
