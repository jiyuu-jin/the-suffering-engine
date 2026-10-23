// Root behaviours of Character-family actors (NPCs and creatures), decoded from level
// objects and behaviour templates (docs/game-logic.md §15).
//
// A root behaviour is what an actor is doing right now: idling, walking a waypoint path,
// playing an animation, talking, fighting, fleeing, ... Designers place behaviour objects
// in the level (WaypointBehavior, SimpleConversationBehavior, RootPlayAnimBehavior, ...)
// and Behavior Changers hand them to NPCs. A placed behaviour's links name the behaviour
// that follows once it completes, so behaviours form chains. Character templates also
// name their own defaults: p68 initial (DormantBehavior / JumpBehavior / FallBehavior /
// RatSpawnBehavior), p69 the behaviour when active (IdleBehavior, HostilityBehavior,
// DeathBehavior for placed corpses, DormantBehavior), p76 the behaviour taken when
// provoked, p82 the KillEnemiesBehavior that sets who counts as an enemy.
//
// Property meanings below are [verified] when read from Suffering.rfl code, [data] when
// they follow from how every chapter-1 instance uses them, [guess] otherwise.

import type { Entity, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, PropType, readObjectTemplate, type EntityPackageSet } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { toOutputSpace } from '../../formats/level';
import type { ClipRef } from './clipmap';
import { fleeParams, type FleeParams } from './flee';
import { hostilityRetry, targetWeights, type TargetWeights } from './targeting';

/** One line of an NPC conversation ("Line of Dialog" template). */
export interface DialogLine {
  /** p0: talk animations (one is picked). */
  anims: ClipRef[];
  /** p1: pause after the line (s). [data] */
  pause: number;
  /** p2: dialog sounds ("pkg:id", one is picked; category 6 with a subtitle). */
  sounds: string[];
  /** p3: message the speaker sends to its links when the line starts. [guess] */
  message: number;
}

interface Base {
  cls: string;
  /** Placed behaviour object (undefined for template behaviours). */
  uid?: number;
  /** Behaviours that follow on completion (placed behaviour's links to behaviour objects). */
  next: number[];
  /** Placement of a placed behaviour object (output space). */
  pos?: { x: number; y: number; z: number };
}

export type Behavior = Base &
  (
    | { kind: 'idle'; clip?: ClipRef; fidgets: ClipRef[]; fidgetMin: number; fidgetMax: number }
    | {
        kind: 'dormant';
        /** p2: 0 = ends at once, 1 = shown playing `clip`, 2 = hidden (inert) until woken. */
        mode: number;
        clip?: ClipRef;
        /** p6 != 0: woken by an attack stimulus (event 0x2001: being hit / shot at). */
        wakeOnAttack: boolean;
        /** p12: the message that wakes it (1 = On on every retail template). */
        wakeMessage: number;
        /** p7: clip played on waking before the next behaviour. */
        wakeClip?: ClipRef;
      }
    | {
        kind: 'waypoint';
        first: number;
        /** p3: fights while walking (0), once attacked (1) or never (2) [verified, see decode]. */
        fight: number;
        escort: number[];
        near: number;
        far: number;
        keepPath: boolean;
        /** p4 != 0: a ListenBehavior runs while it walks, so it hears noises (InvestigateBehavior) [verified: 0x100e8790]. */
        listen?: boolean;
      }
    | { kind: 'anim'; clips: ClipRef[]; ordered: boolean; plays: number; duration: number }
    | {
        kind: 'talk';
        toPlayer: boolean;
        target: number;
        lines: DialogLine[];
        ambient: DialogLine[];
        gapMin: number;
        gapMax: number;
        /** p9 / p10: range (m, horizontal) and height (m) of the wait-for-the-listener mode. */
        startRange: number;
        rangeHeight: number;
        approach: boolean;
        /** p11 / p12: talking distance (m, horizontal) and height difference (m). */
        nearDist: number;
        nearHeight: number;
        doneMessage: number;
      }
    | ({ kind: 'kill'; targets: number[]; enemies: string[]; allies: string[]; weights?: TargetWeights } & SightRules)
    | { kind: 'hostile'; retry?: [number, number] }
    | ({ kind: 'jump'; fall?: ClipRef; land?: ClipRef; launch?: ClipRef } & JumpParams)
    | { kind: 'fall'; clip?: ClipRef }
    | { kind: 'jumpAttack'; range: number }
    | { kind: 'flee'; flee: FleeParams }
    /** KilljoyRootBehavior (actor.ts runKilljoy): p2 the corpses Killjoy tends. */
    | { kind: 'killjoy'; corpses: number[] }
    /** KilljoyRaiseDeadBehavior (Killjoy p175): p2 the raise clip, p3 the distance it may start from (m). */
    | { kind: 'raiseDead'; clip?: ClipRef; near: number }
    /** p2 clips (one at random); p4 the blow angle (degrees) below which this entry is taken (deathPick). */
    | { kind: 'death'; clips: ClipRef[]; angle?: number }
    | { kind: 'horace'; range: number; damage: number }
    | { kind: 'ratSpawn'; clip?: ClipRef }
    | {
        kind: 'follow';
        /** p2: who to follow (1 on every placed instance: the player) [inferred]. */
        target: number;
        /** The leader this close (2 m) and coming at the follower: it steps out of his way [verified: 0x100f0603 -> 0x100ee710]. */
        near: number;
        /** p3: what it does while it waits: 1 = HostilityBehavior (fights), 0 = IdleBehavior [verified: 0x100ea6c0]. */
        fights: boolean;
        /** p4: the run to the leader stops this far from the end of the path (m) [verified: 0x100f07bc puts p4 x 2048 into the MoveTo request's distance, +0x1c; read as its arrival distance, as Waypoint p2, inferred]. */
        stop: number;
        /** p5: the path to the leader may be this long before it runs after him (m) [verified: 0x100eebac -> 0x1011e350]. */
        far: number;
        /** p6: that length while its Hostility has a target (child event 9 / 5; p5 again on 9 / 6) [verified: 0x100eedf6]. */
        combatFar: number;
        /** p7: gives up (behaviour fails) beyond this distance (3D), <= 0 never [verified]. */
        giveUp: number;
      }
    | { kind: 'other' }
  );

/** InvestigateBehavior (Character p97): how a character reacts to AI noises (InvestigateSound). */
export interface InvestigateProfile {
  /** p2: added to a noise's radius (m) [verified: (radius + p2)^2 against the squared distance]. */
  extra: number;
  /** p4: lowest noise level it reacts to (footsteps are level 0) [verified]. */
  minLevel: number;
  /** p3: percent chance a noise is noticed: rand() % 101 ≤ p3 [verified, docs/re/audio.md §8]. */
  chance: number;
  /** p7: seconds spent looking around at the noise [guess]. */
  linger: number;
}

/**
 * The InvestigateBehavior hearing test [verified: 0x100ed680]: loud enough (level >= p4 and >=
 * the level of the noise already being followed up) and close enough (distance <= radius + p2).
 */
export function noiseHeard(inv: InvestigateProfile, noise: NoiseSpec, distance: number, following = -Infinity): boolean {
  return noise.level >= Math.max(inv.minLevel, following) && distance <= noise.radius + inv.extra;
}

/** An AI noise (InvestigateSound template: p0 radius in m, p1 level) [data]. */
export interface NoiseSpec {
  radius: number;
  level: number;
}

export const PLAYER_TEAM = '2:384';

/**
 * Does an attack make a character fight back, given its root behaviour `b`? (docs/game-logic.md
 * §15.12). The Character damage code (0x100e7390) sends the victim the attack stimulus (event
 * 0x2001) and records the attacker in a damage memory (0x100a3800) that only a running
 * KillEnemies reads (target choice 0x100f3740 / 0x100fba00; ShootFromPosition, Flee).
 * Whether a KillEnemies runs is up to the root behaviour [verified]:
 *   - HostilityBehavior / KillEnemiesBehavior roots fight already: the attacker joins them;
 *   - WaypointBehavior p3: 0 fights while walking, 1 starts fighting once attacked, 2 never;
 *   - IdleBehavior, SimpleConversation, RootPlayAnim, Dormant, Death: their runtimes do not
 *     handle 0x2001 (Idle only 0x2015, Dormant wakes on it when p6 is set and hands over to
 *     p69); the character's default handler (vt 37, 0x100e72c0) then only fires output p35 and
 *     plays the hit reaction - no fight. A Stomp (sequence) root swallows 0x2001 and the death
 *     event 0x2003 entirely (0x100e9dc0).
 * An Action Dialog attached to an NPC turns it on the player through AttackedByPlayer with the
 * dialog's p17 KillObject template (0x1008d4a0) [inferred: code shape, not run]. Port: classes
 * that are hostile by kind keep fighting back from passive roots (their class code, e.g. the
 * Rat's, is not decoded), as does the kind's plain default (no root behaviour). A follower's
 * waiting Hostility picks its attacker by the target score (damage memory), not by a grudge.
 */
/**
 * Does the root behaviour hear noises? Only InvestigateBehavior polls the noise list, and only a
 * ListenBehavior starts it; Listen is started by a HostilityBehavior (0x100f7880, again on its
 * re-arm 0x100f7950) and by a WaypointBehavior with p4 set (0x100e8790) [verified: the only
 * pushers of behaviour type 0x2e]. A FollowBehavior has one through its waiting Hostility (p3 =
 * 1, not while it runs to the leader). Flee, Idle, conversations, animations, KillEnemies roots:
 * deaf. No root at all: the kind's default (creatures: their p69 Hostility) [port].
 */
export function rootListens(b: Behavior | undefined, followWaiting = true): boolean {
  if (!b) return true;
  switch (b.kind) {
    case 'hostile':
      return true;
    case 'waypoint':
      return !!b.listen;
    case 'follow':
      return b.fights && followWaiting;
    default:
      return false;
  }
}

/**
 * Does a blow make the character fight back (a grudge on the attacker)? By its root behaviour
 * (docs/game-logic.md §15.12). An attached Action Dialog does not: the player's hits on its NPC
 * are counted (0x1008e130), each counted one below p18 a warning (AttackedByPlayer: face the
 * player, the p17 clip, a p16 line), and the p18th fires the dialog's p30 to the level logic,
 * which hands out the turn (a FleeBehavior from the player, a Hostility whose KillEnemies may list
 * the player's team: director.ts) [verified]. `actionDialog` is kept for the callers; it no
 * longer starts a fight.
 */
export function attackStartsFight(b: Behavior | undefined, o: { hostileKind: boolean; actionDialog?: boolean; byPlayer: boolean }): boolean {
  if (!b) return true;
  switch (b.kind) {
    case 'kill':
    case 'hostile':
    case 'jumpAttack':
    case 'horace':
      return true;
    case 'follow':
      // FollowBehavior does not take 0x2001 itself (0x100ed550 handles only 0x2015): its waiting
      // HostilityBehavior (p3 = 1) scores the attacker through the damage memory like any
      // KillEnemies (no grudge needed); running, or with an Idle (p3 = 0), nothing fights.
      return false;
    case 'waypoint':
      return b.fight !== 2;
    case 'dormant':
    case 'death':
      return false;
    case 'idle':
    case 'talk':
    case 'anim':
    case 'flee':
    case 'killjoy':
      return o.hostileKind;
    default:
      return true;
  }
}

const num = (v: PropValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');
const uids = (v: PropValue | undefined): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && x > 0);

/**
 * KillEnemiesBehavior sight (RFL init 0x100f7d40, candidate search 0x100fbdd0, sight test
 * 0x100f39a0, line of sight vt slot 20 0x100f2570) [verified unless marked]:
 *   p7  acquire range (m): candidates in a +-p7 box on x / z, seen within p7 (3D distance);
 *   p8  short range (used while character p147 is set and the target faces it; no chapter-1
 *       creature sets p147, not modelled);
 *   p9  always-see radius (m): closer targets are seen whatever the view cone;
 *   p10 keep range (m): the current target stays selected, even unseen, until farther than p10;
 *   p11 FULL view angle (deg): the cone test uses cos(min(p11 / 2, 180)) (360 = all round);
 *   p6  != 0: the view needs a clear line of sight (one ray from the eye bone);
 *   p12 + U(0, p13) s between target re-evaluations (at least 0.5 s; p12 <= 0 see targeting.ts
 *   repickInterval, which the choice uses; reevalMin / reevalRand are kept for reference).
 * There is no vertical limit: a target 10 m below is seen like one on the same floor.
 */
export interface SightRules {
  range: number;
  alwaysSee: number;
  keep: number;
  fov: number;
  los: boolean;
  reevalMin: number;
  reevalRand: number;
}

/** Characters without a KillEnemiesBehavior (port defaults). */
export const DEFAULT_SIGHT: SightRules = { range: 22, alwaysSee: 0, keep: 30, fov: 140, los: true, reevalMin: 2, reevalRand: 2 };

export function sightRules(v: PropValue[]): SightRules {
  return {
    range: num(v[7], 45),
    alwaysSee: num(v[9], 0),
    keep: num(v[10], 50),
    fov: num(v[11], 360),
    los: num(v[6], 1) !== 0,
    reevalMin: Math.max(0.5, num(v[12], 2)),
    reevalRand: Math.max(0, num(v[13], 2)),
  };
}

/** Is a target at 3D distance d, at cosine `cos` off the facing, inside the view (before the line-of-sight ray)? */
export function inSight(r: Pick<SightRules, 'range' | 'alwaysSee' | 'fov'>, d: number, cos: number): boolean {
  if (d <= r.alwaysSee) return true;
  if (d > r.range) return false;
  return cos >= Math.cos((Math.min(r.fov / 2, 180) * Math.PI) / 180) - 1e-9;
}

/**
 * JumpBehavior (type 0x19; start 0x100edf30, launch 0x100ec710, airborne 0x100f0cd0, finish
 * 0x100efe70) [verified unless marked]: p2 a timer (s); p3 an optional object to face and jump
 * towards (0: along the jumper's facing); p4 the launch clip, played with its root translation
 * (x / y / z) moving the body; then the body leaves the ground with velocity = horizontal
 * direction x p7 + up x p8 (m/s) under gravity x p9, plays p5 until it touches ground, then p6.
 * At the earlier of the timer and the end of p6 the jumper gets an attack stimulus (no attacker:
 * it is alert afterwards); the behaviour ends at the later of the two. Hits do not interrupt it.
 */
export interface JumpParams {
  timer: number;
  toward: number;
  speed: number;
  up: number;
  gravity: number;
}

export function jumpParams(v: PropValue[]): JumpParams {
  return { timer: num(v[2], 3), toward: uids(v[3])[0] ?? 0, speed: num(v[7], 0), up: num(v[8], 0), gravity: num(v[9], 1) };
}

/** Launch velocity (m/s) for a jump along the horizontal direction (dx, dz). */
export function jumpVelocity(p: Pick<JumpParams, 'speed' | 'up'>, dx: number, dz: number): { x: number; y: number; z: number } {
  const l = Math.hypot(dx, dz);
  const ux = l > 1e-6 ? dx / l : 0, uz = l > 1e-6 ? dz / l : 0;
  return { x: ux * p.speed, y: p.up, z: uz * p.speed };
}
const key = (r: ResRef) => `${r.pkg}:${r.id}`;

/** Decodes behaviours and dialog lines, cached per template / placed object. */
export class BehaviorLibrary {
  private templates = new Map<string, Behavior | null>();
  private lines = new Map<string, DialogLine | null>();
  private placed = new Map<number, Behavior | null>();
  private noises = new Map<string, NoiseSpec | null>();

  constructor(
    private readonly pkgs: EntityPackageSet,
    private readonly byUid: Map<number, Entity>,
  ) {}

  /** Behaviour from a template ref (Character template defaults, Behavior Changer p5). */
  fromTemplate(r: ResRef | undefined): Behavior | undefined {
    if (!r) return undefined;
    const k = key(r);
    if (!this.templates.has(k)) {
      const t = readObjectTemplate(this.pkgs, r);
      const c = t ? classByHash(t.classHash) : undefined;
      this.templates.set(k, t && c ? this.decode(c.name, decodeTemplateProps(c, t), []) : null);
    }
    return this.templates.get(k) ?? undefined;
  }

  /** Behaviour from a placed behaviour object (Behavior Changer p6, chain links). */
  fromPlaced(uid: number): Behavior | undefined {
    if (!this.placed.has(uid)) {
      const e = this.byUid.get(uid);
      let b: Behavior | null = null;
      if (e && /Behavior$/.test(e.className)) {
        const next = e.links.filter((u) => /Behavior$/.test(this.byUid.get(u)?.className ?? ''));
        b = this.decode(e.className, e.values, next);
        if (b) {
          b.uid = uid;
          const [x, y, z] = toOutputSpace(e.position);
          b.pos = { x, y, z };
        }
      }
      this.placed.set(uid, b);
    }
    return this.placed.get(uid) ?? undefined;
  }

  /** InvestigateBehavior template (Character p97). */
  investigate(r: ResRef | undefined): InvestigateProfile | undefined {
    if (!r) return undefined;
    const t = readObjectTemplate(this.pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || c?.name !== 'InvestigateBehavior') return undefined;
    const v = decodeTemplateProps(c, t);
    return { extra: num(v[2], 0), minLevel: num(v[4], 1), chance: num(v[3], 100), linger: Math.max(2, num(v[7], 10)) };
  }

  /** InvestigateSound template (p0 radius in m, p1 level) [data: Missile p14 / p16, Material Effects p7 / p2]. */
  noise(r: ResRef | undefined): NoiseSpec | undefined {
    if (!r) return undefined;
    const k = key(r);
    if (!this.noises.has(k)) {
      const t = readObjectTemplate(this.pkgs, r);
      const c = t ? classByHash(t.classHash) : undefined;
      const v = t && c?.name === 'InvestigateSound' ? decodeTemplateProps(c, t) : undefined;
      this.noises.set(k, v ? { radius: num(v[0], 0), level: num(v[1], 0) } : null);
    }
    return this.noises.get(k) ?? undefined;
  }

  line(r: ResRef): DialogLine | undefined {
    const k = key(r);
    if (!this.lines.has(k)) {
      const t = readObjectTemplate(this.pkgs, r);
      const c = t ? classByHash(t.classHash) : undefined;
      if (!t || c?.name !== 'Line of Dialog') this.lines.set(k, null);
      else {
        const v = decodeTemplateProps(c, t);
        this.lines.set(k, { anims: refs(v[0]), pause: num(v[1], 0), sounds: refs(v[2]).map(key), message: num(v[3], 0) });
      }
    }
    return this.lines.get(k) ?? undefined;
  }

  private decode(cls: string, v: PropValue[], next: number[]): Behavior | null {
    const base = { cls, next };
    switch (cls) {
      case 'IdleBehavior':
        // p2 idle clip, p5 fidget clips played now and then (p8..p11 timing) [data].
        return { ...base, kind: 'idle', clip: ref(v[2]), fidgets: refs(v[5]), fidgetMin: num(v[9], 4), fidgetMax: num(v[11], 12) };
      case 'DormantBehavior':
        // [verified: Suffering.rfl start 0x100ec8f0, event handler 0x100ecdf0, end 0x100ecc60]
        // p2 mode (0 ends at once, 1 shown playing p5, 2 hidden / inert), p12 the waking
        // message, p6 != 0 also wakes on the attack stimulus (event 0x2001, which the Character
        // damage code sends to the victim), p7 a clip played on waking. Nothing wakes it by
        // sight: a dormant creature that no message reaches stays put until it is attacked.
        return {
          ...base,
          kind: 'dormant',
          mode: num(v[2], 1),
          clip: ref(v[5]),
          wakeOnAttack: num(v[6], 1) !== 0,
          wakeMessage: num(v[12], 1),
          wakeClip: ref(v[7]),
        };
      case 'FollowBehavior':
        // [verified: start 0x100ed480, update 0x100f03a0, child events 0x100eeb30, docs/game-logic.md
        // §15.10] p2 the leader (resolved through the engine's object lookup; 1 on every placed
        // instance), p3 the waiting child (1 Hostility, 0 Idle), p4 the run's arrival distance,
        // p5 / p6 the longest path to the leader it waits on (p6 while its Hostility has a
        // target), p7 x 2048 the give-up distance (squared; <= 0 = never).
        return {
          ...base,
          kind: 'follow',
          target: num(v[2], 1),
          near: 2,
          fights: num(v[3], 0) === 1,
          stop: Math.max(0.5, num(v[4], 2)),
          far: Math.max(1, num(v[5], 10)),
          combatFar: Math.max(1, num(v[6], 20)),
          giveUp: num(v[7], -1),
        };
      case 'WaypointBehavior':
        // p2 first Waypoint (used when p5 = 1; else the nearest, 0x100ee1f0) [verified: start
        // 0x100eff90]. p3 is not a gait: 0 starts a countdown at +0x60 (the update's timer),
        // anything else leaves it off (-1) [verified]. The timer starts a KillEnemies child when
        // it runs out (update 0x100f13fc..0x100f146c; again 0.5 s after one ends, 0x100f1054),
        // and the attack stimulus starts one when p3 = 1 (message 0x100ea490): p3 is whether
        // the walker fights - 0 while walking, 1 once attacked, 2 never [verified] (`fight`).
        // Walk or run comes from each Waypoint's p1 (actor.ts waypointRuns).
        // p7 1 = keep to the path even when enemies show up (creatures override 0) [guess],
        // p8 escorted objects (the Player): a leg starts only while they are within p9; beyond
        // p10 the NPC goes and fetches them (RFL 0x100ea110 / 0x100ea2b0 / 0x100f0210; actor.ts
        // runWaypoints).
        return {
          ...base,
          kind: 'waypoint',
          first: uids(v[2])[0] ?? 0,
          fight: num(v[3], 0),
          escort: uids(v[8]),
          near: num(v[9], 10),
          far: num(v[10], 20),
          keepPath: num(v[7], 1) !== 0,
          listen: num(v[4], 0) !== 0,
        };
      case 'RootPlayAnimBehavior':
        // RFL 0x100e8c10 / 0x100e8c50 / 0x100e8d80 [code]: p2 clips, p3 1 = in order (0 = a random
        // one each time), p4 number of clips to play before the behaviour completes (0 = no
        // limit), p5 time limit (s, 0 = none): it completes when either runs out, and with both 0
        // it plays until a Behavior Changer replaces it.
        return { ...base, kind: 'anim', clips: refs(v[2]), ordered: num(v[3], 1) !== 0, plays: Math.max(0, num(v[4], 1)), duration: num(v[5], 0) };
      case 'SimpleConversationBehavior':
        // p0 talk to the player (else to the object in p1) [verified: start code], p14 lines
        // said once in order, p16 lines repeated every p19..p20 s afterwards [data], p9 range
        // within which the talk starts, p5 walk up to the listener until p10 m away [guess],
        // p21 message the speaker sends to its links when done [data: NPC links listen for it].
        return {
          ...base,
          kind: 'talk',
          toPlayer: num(v[0], 1) !== 0,
          target: uids(v[1])[0] ?? 0,
          lines: refs(v[14]).map((r) => this.line(r)).filter((l): l is DialogLine => !!l),
          ambient: refs(v[16]).map((r) => this.line(r)).filter((l): l is DialogLine => !!l),
          gapMin: num(v[19], -1),
          gapMax: num(v[20], -1),
          // Start 0x10100600 / ranges 0x100ff570 [verified]: the talk starts at once when the
          // listener is within p11 m (horizontal) and p12 m in height (0x100e1c00); else with p5
          // the speaker walks up to the listener (a MoveTo on it that stops at p11 m, however far
          // it is: 0x101000e0); p9 / p10 are the range / height of the other wait mode (p8).
          startRange: num(v[9], 10),
          rangeHeight: num(v[10], 3),
          approach: num(v[5], 0) !== 0,
          nearDist: num(v[11], 5),
          nearHeight: num(v[12], 2),
          doneMessage: num(v[21], 0),
        };
      case 'KillEnemiesBehavior':
        // p2 enemy teams, p3 explicit targets (uids), p4 allied teams; sight rules from
        // p6..p13 (sightRules).
        return {
          ...base,
          kind: 'kill',
          targets: uids(v[3]),
          enemies: refs(v[2]).map(key),
          allies: refs(v[4]).map(key),
          ...sightRules(v),
          // Target score weights and re-pick timing (targeting.ts) [verified].
          weights: targetWeights(v),
        };
      case 'HostilityBehavior':
      case 'SpecialHostilityBehavior':
        // p3..p4: seconds before a KillEnemies that found nothing starts again (targeting.ts).
        return { ...base, kind: 'hostile', retry: hostilityRetry(v) };
      case 'JumpBehavior':
        // p4 launch, p5 airborne, p6 landing clips; p2 timer, p3 target, p7..p9 the launch
        // (jumpParams).
        return { ...base, kind: 'jump', launch: ref(v[4]), fall: ref(v[5]), land: ref(v[6]), ...jumpParams(v) };
      case 'FallBehavior':
        return { ...base, kind: 'fall', clip: ref(v[2]) };
      case 'JumpAttackBehavior':
        return { ...base, kind: 'jumpAttack', range: num(v[2], 6) };
      case 'FleeBehavior':
        // Spot choice, threat / ally teams, re-picks: flee.ts (decoded from Suffering.rfl).
        return { ...base, kind: 'flee', flee: fleeParams(v) };
      case 'DeathBehavior':
        // p4: the Character death picker's angle bound (actor.ts deathPick) [verified].
        return { ...base, kind: 'death', clips: refs(v[2]), angle: num(v[4], 360) };
      case 'KilljoyRootBehavior':
        // [verified: start 0x1007bd70, update 0x1007bea0, child done 0x1007c000] p2 the corpses.
        return { ...base, kind: 'killjoy', corpses: uids(v[2]) };
      case 'KilljoyRaiseDeadBehavior':
        // [verified: start 0x1007c170, child done 0x1007bcc0, update 0x1007c330] p2 clip, p3 m.
        return { ...base, kind: 'raiseDead', clip: ref(v[2]), near: num(v[3], 1) };
      case 'HoraceKillPlayerBehavior':
        // p2 / p3 are message ids (6 sent after p4..p5 s, 350 ends it), p6..p7 its length (s)
        // [code, RFL 0x10077e00]; the fight itself is specials/horace.ts. range / damage are the
        // port's fallback when the special is not running.
        return { ...base, kind: 'horace', range: 6, damage: 350 };
      case 'RatSpawnBehavior':
        // p2 emerge clip (1a rat templates: crawling out, 0.37 s), p3 unknown (8) [inferred:
        // played once when the cloner's copy appears, then the active behaviour].
        return { ...base, kind: 'ratSpawn', clip: ref(v[2]) };
      default:
        if (/Behavior$/.test(cls)) return { ...base, kind: 'other' };
        return null;
    }
  }
}

/** Character template behaviour slots (shared Character/NPC property layout) [data]. */
export const CHAR = {
  weapons: 52,
  initial: 68,
  active: 69,
  /** DeathBehavior list run when the character dies (instances may override it) [data]. */
  deaths: 72,
  provoked: 76,
  flee: 77,
  /** KilljoyRaiseDeadBehavior (Killjoy's p175 slot: behaviour type 0x4b) [data]. */
  raiseDead: 175,
  idle: 81,
  kill: 82,
  /**
   * KillMeleeBehavior: the melee fight a KillEnemies runs (behaviour type 0x4d -> p85 in the
   * Character slot map 0x100e17c0; CartWheelers map it to p182) [verified].
   */
  killMelee: 85,
  projectile: 88,
  /** InvestigateBehavior: reaction to AI noises (guards, prisoners, Slayers, Burrowers). */
  investigate: 97,
  openDoor: 104,
  /** NPC Exclusion Type: which Move Nodes the character may use (nav.ts navNodePasses) [verified]. */
  navType: 45,
  /** LadderClimbBehavior: an NPC's ladder clips (actor.ts tryLadder) [data]. */
  ladder: 102,
  team: 130,
  /** Lip-sync bone / angle / axis (docs §12). */
  jaw: 118,
  /** Nooseman: p183 reach below its drop position (m), p185 Nooseman Drop Position group. */
  noosemanReach: 183,
  noosemanDrops: 185,
} as const;

/** Template ref value of a single Template-typed property (instance overrides included). */
export function templateProp(values: PropValue[], types: number[], i: number): ResRef | undefined {
  const t = types[i] ?? 0;
  if ((t & 0xff) !== PropType.Template) return undefined;
  return Array.isArray(values[i]) ? refs(values[i])[0] : ref(values[i]);
}

export function templateList(values: PropValue[], i: number): ResRef[] {
  return refs(values[i]);
}
