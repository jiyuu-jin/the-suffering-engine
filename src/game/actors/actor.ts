// One placed or spawned Character (NPC or creature): a Character model (shared clips), a
// physics motor, health, and the behaviour runner (behaviors.ts, docs/game-logic.md §15).
//
// Behaviours (what the actor is doing):
//   passive  idle / dormant / waypoint path / play animation / conversation / flee / corpse
//   combat   kill (KillEnemiesBehavior: teams or explicit targets), hostile (HostilityBehavior),
//            jump attack; also entered when a passive actor is hurt (grudge on the attacker)
// A passive behaviour that completes hands over to its chain successor (the behaviour
// object's links), else to the template's active behaviour (p69).
//
// Combat states:
//   chase --(in reach)--> attack (melee clip, damage at the clip's hit markers)
//   chase --(ranged weapon, line of fire, cooldown)--> shoot (hitscan at the clip's marker)
//   any --(damage)--> hurt --> previous;   any --(health <= 0)--> dead
//   fall --(lands)--> landing clip --> behaviour
// Targets are the player or other actors: an actor's team (template p130) is an enemy when
// the active KillEnemiesBehavior lists it (p2); the player team is 2:384.
//
// Dormancy (placed creatures, see clipmap.ts readDormancy and ActorManager.populate):
//   * dormantHidden: not shown, inert and not hittable until woken/revealed.
//   * ceiling: hangs from the ceiling at its placement until woken (or prey passes below).
//   * wake(): Behavior Changer / On message; reveal(): level visibility or a STOMP sequence.
//
// Doors: walking a Move Node path through an Edge Passage whose door is closed, an actor
// with an OpenDoorBehavior (template p104) stops at the door, plays the push clip and sends
// the Switch its activate message; locked doors cut the edge.

import * as THREE from 'three/webgpu';
import { CharacterMotor, COLLISION_LAYER, type CollisionWorld } from '../../app/physics';
import type { PlayerController } from '../../app/player';
import { AimBones, Character, LookAtBone } from '../../app/character';
import type { Entity } from '../../formats/entities';
import { instanceRotation } from '../../formats/level';
import type { CreatureKind, KindAttack } from './kinds';
import { npcMotorConfig } from './mover';
import { clearLine, clearWide, shortcutBarred, type NavGraph } from './nav';
import type { Behavior, BehaviorLibrary, DialogLine, InvestigateProfile, NoiseSpec } from './behaviors';
import { deathWeaponMode } from './drops';
import { chooseFleeSpot, recentHits, type FleeSpot } from './flee';
import { followCheckDelay, followGivesUp, followLimit, followRuns, polylineLength, stepAside, stepAsideTime } from './follow';
import { attackStartsFight, DEFAULT_SIGHT, inSight, jumpVelocity, noiseHeard, PLAYER_TEAM, rootListens, type SightRules } from './behaviors';
import { hearsNoise } from '../../app/audio-rules';
import { sightBlocked, type SeeThrough } from './sight';
import { ballisticLaunch, type ThrowAim } from './throw';
import { missileStep, type MissileBody, type MissileFlight } from './missile';
import type { ClipRef } from './clipmap';
import { difficulty } from '../campaign/difficulty';
import { npcBlowDamage, shapeWorld, sweepSpheres, type HitSphereLike, type NpcMeleeWeapon, type SwingWindow } from './npc-melee';
import { chooseTarget, damageShare, DEFAULT_WEIGHTS, repickInterval, targetScore, type TargetCandidate, type TargetWeights } from './targeting';
import { downTimeOf, flinchClip, pickHitReact, reactionBlocks, reactionRate, type HitPick, type HitTables } from './hit-react';

export type ActorState = 'idle' | 'move' | 'act' | 'door' | 'chase' | 'attack' | 'shoot' | 'hurt' | 'fall' | 'dead';

/**
 * One Attack template of a ProjectileAttackBehavior (p2) [verified: Suffering.rfl ProjectileAttack
 * 0x101569a0; docs/re/animation.md §9]. Everything plays on the whole body: the actor stands.
 */
export interface RangedAttack {
  /** Attack p0: the firing clip. */
  clip: ClipRef;
  /** Attack p4: the aim pose held while aiming and between shots. */
  aim?: ClipRef;
  /**
   * Attack p20: the channel the aim pose plays on; -1 = the whole body (every retail Attack but
   * the Mainliner's needle throw 10:210, channel 5, whose legs keep their locomotion meanwhile).
   */
  aimChannel: number;
  /** Attack p1 +- p2: playback rate of the firing clip (uniform). */
  rate: number;
  rateSpread: number;
  /** Attack p23: shots per attack. */
  shots: number;
  /** Attack p21..p22: seconds of aim pose between two shots. */
  pauseMin: number;
  pauseMax: number;
  /** Attack p30 = 1: each further shot needs a clear line of fire. */
  lineCheck: boolean;
  /**
   * Attack p19: x the Ranged Weapon's p75 spread for this attack (0 on every prisoner attack:
   * no spread; guards 1; Slayers 0 / 0.3) [verified: 0x100fcec0].
   */
  spreadScale?: number;
  /** ProjectileAttack p3 weight (1 each without weights). */
  weight: number;
}

/** Ranged attack of an actor (ProjectileAttackBehavior p88 + a Ranged Weapon / Missile, manager.ts). */
export interface RangedProfile {
  attacks: RangedAttack[];
  /** Seconds between attacks (ProjectileAttackBehavior p19..p20; port reading, see manager.ts). */
  cooldownMin: number;
  cooldownMax: number;
  /** Max range (Attack p16, m) [guess]. */
  range: number;
  /**
   * Facing channel (ProjectileAttackBehavior p21..p25): bone turned toward the target, cone /
   * pitch limits (degrees), speed (deg/s), ease time (s) [code: Suffering.rfl 0x100b3d70].
   */
  track?: { bone: number; cone: number; pitch: number; speed: number; ease: number };
  /** Aim bones (ProjectileAttackBehavior p7 / p8 limits, p11 bones, p12 split, p13 origin bone). */
  aim?: { bones: number[]; split: number; origin: number; min: number; max: number };
  /** Damage per shot (Missile p28 x projectiles per shot) [data]. */
  damage: number;
  /** Damage type of the shot (Missile p32: 1 bullets, 13 pellets) [data]. */
  type?: number;
  /** Projectile speed (m/s, Missile p1); slow ones (thrown needles) fly visibly. */
  speed: number;
  /** Ranged Weapon p75 spread (degrees). */
  spread: number;
  /** Ranged Weapon p83 Muzzle Flash template (none for thrown missiles). */
  flash?: { pkg: number; id: number };
  /** AI noise of a shot (the Missile's p16 InvestigateSound) [data]. */
  noise?: NoiseSpec;
  /**
   * A thrown weapon (a BouncingObject in the weapon set, 6a / 6b's stranger: the molotov
   * 10:1863): it leaves on the clip's ThrowWeapon (230) markers, aimed by actors/throw.ts.
   */
  thrown?: {
    template: { pkg: number; id: number };
    aimMode: number;
    aim: ThrowAim;
    /**
     * A thrown Missile (the Mainliner's needle): flown by the actor (actors/missile.ts) and set
     * off by its first contact. p26 damage, p32 type, p12 life (s), bounds radius (m), p34.
     */
    missile?: { damage: number; type: number; life: number; radius: number; impact: { pkg: number; id: number }[] };
  };
  /**
   * ProjectileAttackBehavior p5 != 0: a throw goes to the aim point taken when the firing clip
   * started, not where the target is at the ThrowWeapon marker [verified: 0x100fd069].
   */
  keepAim?: boolean;
}

/**
 * An AI noise (docs/game-logic.md §15.8): footsteps, shots, impacts. Kept for one AI tick like
 * the engine's noise list (0x100e2e60 adds, 0x100e2ef0 ages); InvestigateBehavior polls it.
 */
export interface AiNoise {
  x: number;
  y: number;
  z: number;
  radius: number;
  level: number;
  /** Who made it: 'player', an actor, or nobody known. */
  source?: 'player' | Actor;
}

/** Per-actor data from the entity / template (built by the manager). */
export interface ActorProfile {
  team: string;
  /** NPC Exclusion Type bit (Character p45; nav.ts NO_NAV_TYPE when none). */
  navType?: number;
  /** LadderClimbBehavior (Character p102): rung clips up / down (two hands), the exits at the top and bottom. */
  ladder?: { up: ClipRef[]; down: ClipRef[]; exitTop?: ClipRef; exitBottom?: ClipRef };
  /** Initial and active behaviour (template p68 / p69), provoked behaviour (p76). */
  active?: Behavior;
  provoked?: Behavior;
  /** KillEnemiesBehavior from the template (p82): default enemies. */
  kill?: Extract<Behavior, { kind: 'kill' }>;
  ranged?: RangedProfile;
  /** OpenDoorBehavior push clips (p2 front, p3 back) or null when it can't open doors. */
  openDoor?: { front?: ClipRef; back?: ClipRef } | null;
  /** InvestigateBehavior (p97): hears AI noises of at least minLevel [verified rules]. */
  investigate?: InvestigateProfile;
  /** Corpse at start (p69 DeathBehavior with no initial behaviour). */
  corpse?: Behavior;
  /**
   * Death behaviour (p72, first DeathBehavior of the list) when the instance overrides the
   * template's: its clips are played on death instead of the kind's (1a: the stabbed inmate on
   * his bed dies in his bed pose when the shiv is pulled out).
   */
  death?: Extract<Behavior, { kind: 'death' }>;
  /** The whole p72 list in order: the death picker chooses among them by the blow's angle (deathPick). */
  deaths?: Extract<Behavior, { kind: 'death' }>[];
  /**
   * Hit reactions (p70 by damage, p71 by Special Hit Reaction; hit-react.ts). Undefined for a
   * profile built without game data: the kind's hit clips stand in.
   */
  hitReacts?: HitTables;
  /** GameObject p4 / p8: what other characters' target score reads (targeting.ts) [verified]. */
  priority?: number;
  maxAttackers?: number;
  /** HostilityBehavior p3..p4 of its p69 / p76: seconds between searches without a target. */
  hostileRetry?: [number, number];
  /** Melee Weapons on their bones (p51 / p52; npc-melee.ts). */
  melee?: NpcMeleeWeapon[];
  /**
   * KillMeleeBehavior p2..p3 (Character p85): seconds the melee fight waits after each attack
   * before the next (child-finished handler 0x1007cf10) [verified].
   */
  meleePause?: [number, number];
  /** Killjoy: his FleeBehavior (p77) and KilljoyRaiseDeadBehavior (p175), run by KilljoyRoot. */
  flee?: Extract<Behavior, { kind: 'flee' }>;
  raiseDead?: Extract<Behavior, { kind: 'raiseDead' }>;
}

/** Extra detail of a blow that the hit reaction reads (hit-react.ts). */
export interface ActorBlow {
  /** Special Hit Reaction template the damage carries (Radius Damage 2:736, arcs 2:545...). */
  special?: ClipRef;
  /**
   * The amount the engine's damage record carries when it differs from the points dealt:
   * damage over time applies its per-second rate x the frame time every frame.
   */
  frameAmount?: number;
  /**
   * The blow's impact force after the resistance's force factor (record +0x1c, the amount the
   * hit reaction is picked by: hit-react.ts header), when the source gives one. A blow of no
   * damage still reacts by it (Hermes and fire).
   */
  react?: number;
}

/**
 * Where a character's blow or shot landed on its victim and its damage type: the blade's
 * contact (npc-melee.ts sweepSpheres), the shot's point on the target. Part Caps read the
 * struck hit sphere from it (dismember.ts).
 */
export interface NpcBlowHit {
  point?: THREE.Vector3Like;
  type?: number;
}

/** What an actor needs from the outside world each frame. */
export interface ActorEnv {
  world: CollisionWorld;
  nav: NavGraph | null;
  player: PlayerController;
  playerAlive: boolean;
  /** Player object uid (sender of player-caused events). */
  playerUid: number;
  /** Hit spheres of a body as posed now (skeleton sphere tree leaves; npc-melee.ts sweeps them). */
  hitSpheres?(who: Actor | 'player'): HitSphereLike[];
  /** The player as a target (Player GameObject p4 / p8, health fraction; targeting.ts). */
  playerTarget?: { priority: number; maxAttackers: number; healthFrac?: () => number };
  time: number;
  actors: readonly Actor[];
  behaviors?: BehaviorLibrary;
  /** `hit`: where the blow landed and its damage type (Part Caps: dismember.ts). */
  damagePlayer(amount: number, from: Actor, hit?: NpcBlowHit): void;
  damageActor(target: Actor, amount: number, from: Actor, hit?: NpcBlowHit): void;
  /** A corpse brought back (Killjoy's RaiseDead): its p3 Part Caps grow back (dismember.ts). */
  resurrected?(a: Actor): void;
  /**
   * HitReactBehavior's knockdown (0x100ef7a8): a body that would bleed out while its get-up clip
   * (s) plays dies on the floor instead. True when it died.
   */
  bleedsOut?(a: Actor, getUpLength: number): boolean;
  /**
   * A level object a KillEnemiesBehavior lists in p3 (explicit targets) that is not a character:
   * where it is while it stands (bounds centre, bottom, horizontal radius) and its GameObject
   * target values (p4 priority, p8 most attackers, health fraction); undefined once broken or gone.
   */
  propTarget?(uid: number): PropTargetInfo | undefined;
  /** A blow or shot at such an object (services.damage, the attacker's uid as the source). */
  damageProp?(uid: number, amount: number, from: Actor, at: THREE.Vector3Like): void;
  /** Play one of `keys` (random) at a position. */
  /** Plays one of `keys` (picked at random) at `pos`; the handle tells whether it still plays. */
  sound(keys: string[], pos: THREE.Vector3Like, volume?: number, from?: Actor): { readonly playing: boolean } | void;
  onDeath(a: Actor): void;
  /** Clip index of `ref` in the actor's kind (-1 when it can't be used on this rig). */
  clip(a: Actor, ref: ClipRef | undefined): number;
  /** Bone of a channel of the actor's model (the skeleton trailer's channel table). */
  channelBone?(a: Actor, channel: number): number | undefined;
  /** Level object by uid (waypoints, flee positions, ...). */
  entity(uid: number): Entity | undefined;
  /** Level-logic message. */
  send(uid: number, message: number, from: number): void;
  /** Speak a dialog line (sound + subtitle + lip-sync); returns its length (s). */
  say(a: Actor, line: DialogLine): number;
  /** Behaviour change notice (debug / save). */
  onBehavior?(a: Actor, b: Behavior | undefined): void;
  /** Nav edge veto (locked or unopenable closed doors), by node index. */
  navBlocked?: (a: number, b: number, who: Actor) => boolean;
  /** Closed door on a nav edge: its uid, else undefined. */
  closedDoor?: (a: number, b: number) => number | undefined;
  openDoor?: (door: number, who: Actor) => void;
  doorOpen?: (door: number) => boolean;
  /**
   * A shot leaves the actor's held weapon (services.weapons.npcWeapons) when it has one: its
   * muzzle point (world), after spawning the weapon's Muzzle Flash there (services.fx).
   */
  weaponMuzzle?(a: Actor, r: RangedProfile): THREE.Vector3Like | undefined;
  /** Muzzle flash / tracer for ranged attacks; `speed` (m/s) for slow projectiles that fly visibly. */
  shotFx?(from: THREE.Vector3Like, to: THREE.Vector3Like, hit: boolean, speed?: number): void;
  /** Spawn an effect template (Object Generator, ...) at a point, facing `normal` when given. */
  spawnFx?(template: { pkg: number; id: number }, at: THREE.Vector3Like, normal?: THREE.Vector3Like): void;
  /** Release a thrown object (a BouncingObject template) at `from` with velocity `vel` (m/s). */
  throwObject?(template: { pkg: number; id: number }, from: THREE.Vector3Like, vel: THREE.Vector3Like, by: Actor): void;
  /**
   * A Ladder on the nav edge a - b (an Edge Passage naming it): its foot (origin), the ladder's
   * facing (model -Z, horizontal) and height (Ladder p30).
   */
  ladder?(a: number, b: number): { uid: number; x: number; y: number; z: number; fx: number; fz: number; height: number } | undefined;
  /** Flee Position objects (output space; failure stamps are shared by every fleeing character). */
  fleePositions?: readonly FleeSpot[];
  /**
   * Collision hits that sight and bullets pass (cut-out bars, grates, chain-link, glass:
   * WorldService.seeThrough); without it every surface blocks.
   */
  seeThrough?: SeeThrough | null;
  /** AI noises made since the last AI tick (manager.ts; empty when nothing was heard). */
  noises?: readonly AiNoise[];
  /** Report an AI noise (an actor's shot). */
  noise?(at: THREE.Vector3Like, spec: NoiseSpec, from: Actor): void;
}

/** A level object as a target (ActorEnv.propTarget). */
export interface PropTargetInfo {
  x: number;
  y: number;
  z: number;
  bottom: number;
  radius: number;
  priority: number;
  maxAttackers: number;
  healthFrac: number;
  /** Its collision body: a sight or shot ray that meets it has reached it. */
  body?: number;
}

/** Sight samples below a target's head point (m): head, chest, hips. */
const SIGHT_DROPS = [0, 0.5, 0.9];
const GIVE_UP_AFTER = 8;
const TURN_RATE = 6;
/** Placed feet more than this above the ground (m) count as airborne (not snapped down). */
const AIRBORNE_GAP = 0.6;
/** Feet released by a sequence up to this above a surface stand on it (the motor's teleport snap). */
const HANDBACK_SNAP = 1.0;
/** A hostile ceiling hanger lets go when the player passes within this horizontal distance. */
const CEILING_DROP_RANGE = 7;

let nextId = 1;

/** Actor.getState() record (JSON-safe). */
export interface ActorSaveState {
  /** Level object uid (placed actors and clones' synthetic uids). */
  u?: number;
  /** Object Cloner copy: the template character's uid (re-created with manager.clone). */
  clone?: number;
  /** services.actors.spawn creature: its template ref. */
  t?: { pkg: number; id: number };
  alive: boolean;
  h: number;
  p: [number, number, number];
  yaw: number;
  /** AI state: only 'fall' is restored as such. */
  st: string;
  hostile: boolean;
  provoked: boolean;
  inv?: boolean;
  /** root.visible (level logic), dormant-hidden, ceiling hanger, drop on wake, dormant clip. */
  vis: boolean;
  dh: boolean;
  ceil: boolean;
  dw: boolean;
  di: number;
  ground: boolean;
  np: boolean;
  /** Placed behaviour object the actor runs. */
  b?: number;
  /** Else the template behaviour it runs: 'active' (p69) / 'provoked' (p76) / 'kill' (p82). */
  bt?: 'active' | 'provoked' | 'kill';
  /**
   * How far the behaviour got (a WaypointBehavior's current waypoint, the conversation line
   * next to say): the original saves each behaviour's own state (behaviour vtable +0x44 save /
   * +0x48 load, e.g. FleeBehavior 0x1010b420 / 0x1010b4b0; docs/re/saves.md §4.1), so a restore
   * goes on from there instead of starting the behaviour over and firing its outputs again.
   */
  bp?: BehaviorProgress;
}

/** Actor.getState() `bp`: behaviour kind, phase, line / clip count, waypoint, timer left (s). */
export interface BehaviorProgress {
  k: string;
  ph: number;
  i: number;
  wp: number;
  t?: number;
}

/** Behaviours whose progress a save keeps (the others start over: their set-up is the state). */
const RESUMABLE = new Set(['waypoint', 'talk', 'horace']);

/**
 * The progress of a behaviour (Actor `b`) as a save keeps it: timers relative to `now`
 * (the actors' clock starts again at 0 with the restored level). Undefined when there is
 * nothing to keep.
 */
export function behaviorProgress(kind: string | undefined, b: { phase: number; i: number; wp: number; until: number }, now: number): BehaviorProgress | undefined {
  if (!kind || !RESUMABLE.has(kind) || (!b.phase && !b.i && !b.wp)) return undefined;
  const r: BehaviorProgress = { k: kind, ph: b.phase, i: b.i, wp: b.wp };
  if (b.until) r.t = Math.round((b.until - now) * 1000) / 1000;
  return r;
}

/** Puts saved progress back into a freshly started behaviour of the same kind (false: not applied). */
export function resumeProgress(kind: string | undefined, b: { phase: number; i: number; wp: number; until: number }, p: BehaviorProgress | undefined, now: number): boolean {
  if (!p || p.k !== kind) return false;
  b.phase = p.ph;
  b.i = p.i;
  b.wp = p.wp;
  b.until = p.t !== undefined ? now + p.t : 0;
  return true;
}

/** Who deals damage: an actor, the player, or a level object's uid (hazards). */
export type DamageSource = Actor | 'player' | number | undefined;

/** 'player' or a uid for a damage source (actors without a uid report 0). */
export function sourceId(by: DamageSource): 'player' | number {
  if (by === undefined || by === 'player') return 'player';
  if (typeof by === 'number') return by;
  return by.uid ?? 0;
}

/**
 * Whether a Waypoint is walked to at a run (docs/game-logic.md §15.2): its p1 = 1 makes the
 * move request's mode 3 (MovementAnimBehavior p5, the run clip), anything else mode 1 (p3, the
 * walk) [verified: RFL 0x100e9f90, 0x100940d0].
 */
export function waypointRuns(values: readonly unknown[]): boolean {
  return values[1] === 1;
}

/**
 * Does a looping clip's event at `time` fire while the clip moves from `t0` to `t1`? Events fire
 * in [t0, t1), the window wrapping when the loop restarted in between (t1 < t0)
 * (docs/re/animation.md §7, type 5).
 */
export function loopEventCrossed(time: number, t0: number, t1: number): boolean {
  return t1 > t0 ? time >= t0 && time < t1 : t1 < t0 ? time >= t0 || time < t1 : false;
}

/** Actor gait of a Waypoint leg walked at a run (step(): the run clip's natural speed). */
const WAYPOINT_RUN = 2;

/** Distance (m, horizontal) at which a Waypoint counts as reached [port; the original's MoveTo
 * close-enough test is not decoded]. */
const WAYPOINT_REACH = 0.45;

/**
 * Waypoint p4 / p5 [verified, Suffering.rfl WaypointBehavior message handler 0x100f0f70 ->
 * 0x100f10db]: when MoveTo has brought the walker to the Waypoint and p4 is not 0, a "Slerp"
 * child behaviour (ctor 0x10104ad0, init 0x100ed3b0, step 0x100e8840 -> 0x100de0d0) blends the
 * walker's transform to the Waypoint's placement transform over p5 seconds (t = elapsed / p5:
 * rotation slerped, position moved by (waypoint - walker) x t), playing Idle. Only then come the
 * arrival message (p0), the p6 behaviour or the next Waypoint, or the end of the WaypointBehavior
 * (so a JumpBehavior next leaps along the Waypoint's facing: 1c's CartWheelers 7e20 / 7e21 over
 * the fence from Waypoints 7e22 / 7e26, the companion off the ladder landing at 7b8d). p5 is that
 * time, not an arrival radius. Returns undefined when the Waypoint does not turn.
 */
export function waypointTurn(values: readonly unknown[]): { time: number } | undefined {
  const p4 = values[4];
  if (typeof p4 !== 'number' || p4 === 0) return undefined;
  const p5 = values[5];
  return { time: typeof p5 === 'number' && p5 > 0 ? p5 : 0 };
}

/** The Slerp step at k = elapsed / p5 (0..1): position and yaw (shortest way) from `a` to `b`. */
export function waypointSlerp(a: { x: number; z: number; yaw: number }, b: { x: number; z: number; yaw: number }, k: number): { x: number; z: number; yaw: number } {
  const d = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + d * k };
}

/** Yaw (the actors' convention, as a character's own placement: manager.ts yawOf) of a placement rotation. */
export function placementYaw(rot: [number, number, number]): number {
  const R = instanceRotation(rot);
  return Math.atan2(R[2], R[8]);
}

/**
 * Something an actor fights: the player, another actor, or a level object listed in its
 * KillEnemiesBehavior p3 (a Breakable: 3a's fence the Slayer 296e shoots down; `prop` is its uid).
 */
type Target = { player: true; actor?: undefined; prop?: undefined } | { player?: false; actor: Actor; prop?: undefined } | { player?: false; actor?: undefined; prop: number };

export class Actor {
  readonly id = nextId++;
  readonly ch: Character;
  readonly motor: CharacterMotor;
  readonly scale: number;
  health: number;
  maxHealth: number;
  state: ActorState = 'idle';
  /** Facing (radians, three.js yaw; 0 = -Z). */
  yaw: number;
  /** Fights its enemies on sight (else only after being hurt). */
  hostile: boolean;
  provoked = false;
  invulnerable = false;
  /**
   * Its hand weapons left the hand when it died (dropped or destroyed by its p109, drops.ts;
   * weapons/npc.ts stops drawing them). Derived, so a loaded save of a dead body agrees.
   */
  get weaponDropped(): boolean {
    return !this.alive && !!this.entity && deathWeaponMode(this.entity.values) !== 'keep';
  }
  /** Synthetic uid for spawned clones (entity uid otherwise). */
  private ownUid?: number;
  profile: ActorProfile = { team: '' };
  /** Current root behaviour (undefined = the kind's plain hostile/neutral default). */
  behavior?: Behavior;
  /** Culling / LOD (managed by ActorManager). */
  inView = true;
  occluded = false;
  occlusionTimer = Math.random() * 0.25;
  /** Time not yet simulated (AI LOD). */
  aiAccum = 0;
  private animAccum = 0;

  private anim = -1;
  private action?: THREE.AnimationAction;
  private stateTime = 0;
  private thinkTimer = Math.random() * 0.2;
  private seesTarget = false;
  private target?: Target;
  /** Attacker that hurt this actor (fought until lost). */
  private grudge?: Target;
  /** Damage memory (0x100a3800): who hurt it, how much, when (targeting.ts damageShare). */
  private hurtLog: { by: Actor | 'player'; amount: number; t: number }[] = [];
  /** Target choice timing (perceive): interval of this fight, next re-pick, next search. */
  private repickEvery = 0;
  private repickAt = 0;
  private searchAt = 0;
  private lastSeen = new THREE.Vector3();
  private lastSeenTime = -1e9;
  private path: number[] = [];
  private prevNode = -1;
  private pathGoal = -1;
  private pathTimer = 0;
  private targetNode = -1;
  private targetFrom = new THREE.Vector3(Infinity, 0, 0);
  private attack?: KindAttack;
  private hitsDone = 0;
  private soundsDone = 0;
  /** Looping clips' sound cues: the clip time of the last update and the cue sound still playing. */
  private loopCueT = -1;
  private loopCueAnim = -1;
  private loopCueSound?: { readonly playing: boolean };
  private loopCueLast?: string;
  private stuckTimer = 0;
  /** steer(): next check of the goal's reachability on the graph for this walker's type. */
  private reachCheckAt = 0;
  private goalReachable = true;
  /** The graph's way to the goal (ignoring NPC Exclusion Types) runs through a node barred to this walker (steer). */
  private shortcutBarred = false;
  private stuckFrom = new THREE.Vector3();
  private forceNavUntil = 0;
  private collapse = 0;
  private shotCooldown = 1 + Math.random() * 2;
  /**
   * The ranged attack under way (state 'shoot'): aim (aim pose until facing the target), fire
   * (the firing clip, shot at its Fire marker), pause (aim pose) and aim again until `left` is 0.
   */
  private shot?: { attack: RangedAttack; clip: number; aim: number; aimBone: number; phase: 'aim' | 'fire' | 'pause'; t: number; until: number; left: number; done: boolean; fired: number; aimAt?: THREE.Vector3Like };
  /** Behaviour scratch state. */
  private b: {
    phase: number;
    t: number;
    i: number;
    wp: number;
    until: number;
    line?: DialogLine;
    done?: boolean;
    clip: number;
    move?: [number, number];
    /** Waypoint p4: the blend to the Waypoint's placement under way (waypointSlerp). */
    slerp?: { wp: number; t: number; x: number; z: number; yaw: number; toYaw: number };
    /** The leg to Waypoint `wp` was last found walkable (waypointLegFails) at `at`. */
    leg?: { wp: number; at: number; ok: boolean };
    /** FollowBehavior: waiting / running to the leader / out of his way (runFollow). */
    fol?: { mode: 'wait' | 'run' | 'aside'; checkAt: number; run: boolean; beckon: boolean; until: number; goal?: { x: number; y: number; z: number }; best: number; bestAt: number };
    /** KilljoyRootBehavior: the corpses left to tend and the RaiseDead under way (runKilljoy). */
    kj?: { list: number[]; raise?: { corpse: Actor; phase: 'move' | 'anim'; clip: number; progT: number; progX: number; progZ: number } };
  } = {
    phase: 0,
    t: 0,
    i: 0,
    wp: 0,
    until: 0,
    clip: -1,
  };
  /** Speed factor of the current waypoint segment. */
  private gait = 1;
  private door = 0;
  /** root.visible as last seen by the manager (to notice level logic revealing it). */
  rootShown = true;
  /** Not shown / inert until woken or revealed (see the header). */
  dormantHidden = false;
  /** Hangs from the ceiling at its placement until woken. */
  ceiling = false;
  /** Lowest body point relative to the origin while hanging (model units, < 0). */
  private hangBottom = 0;
  /** Clip played while dormant (DormantBehavior p5); -1 = the kind's idle. */
  private dormantIdle = -1;
  /** Falls from its placement when woken/revealed (drop-in). */
  private dropOnWake = false;
  /** Landing clip override (JumpBehavior p6) and the behaviour to resume after landing. */
  private landClip = -1;
  /** JumpBehavior launch clip under way: its root translation moves the body (jump()). */
  private jumpLaunch?: { from: THREE.Vector3; d: THREE.Vector3; t: number; dur: number };
  /** Motor settings replaced while airborne from a JumpBehavior (air control, gravity). */
  private jumpPhys?: { airAccel: number; gravity: number };
  /** The jump's attack stimulus was sent. */
  private jumpStim = false;
  private world: CollisionWorld | null = null;
  /** Desired steering this frame (world xz, length <= 1). */
  private wish = new THREE.Vector2();
  /** Extra steering added by the manager (separation). */
  readonly push = new THREE.Vector2();
  /** Last attacking actor (undefined = the player or a hazard); the killer once dead. */
  killedBy?: Actor;
  /** Who dealt the last damage: 'player', or the uid of an attacking actor / hazard object. */
  lastHitBy: 'player' | number = 'player';
  /** Template of an Object Cloner (inert, never shown). */
  template = false;
  /** Created at runtime (Object Cloner copy, services.actors.spawn). */
  spawned = false;
  /** First-frame setup pending (ActorManager.init). */
  needsInit = false;
  /** Seconds left turning towards the player (Speech Player p3 = 2). */
  lookAtPlayer = 0;
  /** Situational lines from an attached Action Dialog (director.ts). */
  barks?: { spot: string[]; spotChance: number; hurt: string[]; hurtChance: number; gap: number; muted: boolean; next: number };
  /** Nooseman moving to another drop position: 0 = no, else progress (s). */
  relocating = 0;
  /**
   * A special crawls this actor on ceilings (specials/cartwheeler.ts): while `ceiling` is set it
   * hangs there by its own rules, so the hanger rules here stand aside (letting go when woken,
   * hit or killed).
   */
  crawler = false;
  /**
   * KillMelee pause after a melee attack: the next one waits rand(min, max) s [verified: the
   * KillMelee child-finished handler 0x1007cf10 sets the timer to p2 + rand x (p3 - p2)].
   * Set by a special that knows the behaviour's values; none = attacks back to back.
   */
  meleePause?: [number, number];
  private attackDelay = 0;
  /** Locomotion clips of a behaviour variant (MovementAnimBehavior by condition, variants.ts). */
  gaitClips?: { idle: number; walk: number; run: number };
  /** DormantBehavior p7 clip to play on the next tick (set by wake()). */
  private pendingWakeClip?: ClipRef;
  /** Root behaviour a wake() without a frame environment hands over to on the next tick. */
  private pendingRoot?: Behavior;
  /** Killed while a sequence drove it (the Stomp root swallowed the death): dies at the hand-back. */
  private deathDeferred = false;
  /** Playing the wake clip until this time (env.time); the AI waits. */
  private wakingUntil = 0;
  /** Heard an AI noise (InvestigateBehavior): goes there, then looks around until `until`. */
  investigating?: { x: number; y: number; z: number; until: number; arrived: boolean; level: number };
  /** Killed by a save applied before the first frame: dies silently once the frame env exists. */
  pendingDeath = false;
  /**
   * Placed behaviour (uid) of a save applied before the first frame, when the library is not at
   * hand yet: ActorManager.init starts it (1b: Hermes' conversation after the Horace scene came
   * back as his idle default after a checkpoint restore).
   */
  restoredPlaced?: number;
  /** Saved behaviour progress (getState `bp`) waiting for its behaviour to start (resumeSaved). */
  private savedProgress?: BehaviorProgress;
  /** Behavior Changer whose chain this actor runs (its p17 fires when the chain completes). */
  chainOf?: number;
  /** A handed-out KillEnemies found no target: completed after this perception tick. */
  private killDone = false;
  /** Class special-move controller (specials/index.ts installs it; see update()). */
  special?: (dt: number, env: ActorEnv) => boolean;
  /**
   * Special-move damage rule (ActorManager.damage calls it first): returns the damage the body
   * takes from a blow (0 = none), given where / how it landed when known.
   */
  damageFilter?: (amount: number, hit: { point?: THREE.Vector3Like; type?: number } | undefined, by: DamageSource) => number;
  /**
   * Special-move hit-reaction gate: false while the special drives the body through a move the
   * original's behaviour swallows the attack stimulus in (a CeilingFloorTransition in transit).
   */
  reactGate?: () => boolean;
  /**
   * Blows taken since the special last looked (a ceiling crawler picks its own ceiling list,
   * vt 64 -> p175): the largest reaction amount and the Special Hit Reaction it carried.
   */
  blowsTaken?: { amount: number; special?: ClipRef };
  /** Whole-body hit reaction in progress (state 'hurt'; hit-react.ts). */
  private reaction?: {
    pick: HitPick;
    /** Knockdown steps still to play, then the getting-up clip [inferred roles]. */
    steps: ('land' | 'down' | 'getUp')[];
    down: number;
    downUntil: number;
    face?: { x: number; z: number };
  };
  /** Partial-body flinch in progress (independent layer on bone p12) until `until`. */
  private flinch?: { min: number; max: number; mode: number; bone: number; until: number };
  private relocateTo?: { x: number; y: number; z: number };
  get relocationTarget() {
    return this.relocateTo;
  }

  constructor(
    readonly kind: CreatureKind,
    position: THREE.Vector3Like,
    yaw: number,
    scale = 1,
    readonly entity?: Entity,
    uid?: number,
  ) {
    this.ownUid = uid;
    this.ch = new Character(kind.skinned, [], new Map(), {}, kind.proto);
    this.ch.root.name = `${kind.className}${entity ? ` #${(uid ?? entity.uid).toString(16)}` : ''}`;
    this.scale = scale;
    this.ch.root.scale.setScalar(scale);
    this.yaw = yaw;
    this.hostile = kind.hostile;
    // Difficulty: health x the entity's p2 Difficulty Modifier (src/game/campaign/difficulty.ts).
    this.maxHealth = this.health = (readHealth(entity) ?? kind.maxHealth) * difficulty.healthScale(entity);
    // GameObject p3 = 1: invulnerable until an InvulnerabilityOff (or BlowUp) message [verified,
    // RFL 0x100a3166]. 1c's inmate companion and 1b's scripted Slayer 7ff6 start so.
    this.invulnerable = entity?.values[3] === 1;
    // p161: health regained per second, up to the maximum (every companion template: 4).
    const regen = entity?.values[161];
    this.regen = typeof regen === 'number' && regen > 0 ? regen : 0;
    // A character's mover is its template's Collider spheres at its scale, with the original's ground
    // test (mover.ts, docs/game-logic.md §14.9); other kinds keep a capsule from the bind pose.
    this.motor = new CharacterMotor(null, {
      ...(kind.mover
        ? npcMotorConfig(kind.mover, entity?.values, scale)
        : {
            radius: kind.radius * scale,
            height: Math.max(kind.height * scale, kind.radius * scale * 2 + 0.45),
            stepHeight: Math.min(0.4, kind.height * scale * 0.3),
          }),
      walkSpeed: kind.moveSpeed,
      runSpeed: kind.moveSpeed,
      groundAccel: 10,
    });
    this.motor.position.x = position.x;
    this.motor.position.y = position.y;
    this.motor.position.z = position.z;
    this.play(kind.idle, { loop: true, fade: 0, random: true });
    this.sync();
  }

  /** p161 health per second (0: none), see regenerate(). */
  readonly regen: number;

  /**
   * Character p161 [verified, Suffering.rfl]: every frame the Character update (0x100e58d0) calls
   * its vtable +0x90 (0x100e1410), which, while p161 > 0 and the character is not dead
   * (0x100a1ad0), adds p161 x the frame time to its health; the setter (0x100a2d00) caps it at the
   * maximum. Retail p161 > 0 only on the companions' templates (10:391 Dallas, 10:1234, 10:642 Clem,
   * 10:988, 10:1020 the 9 / 10 guard): 4 health a second. The Player's p161 (220) is his turn rate
   * (another class). docs/game-logic.md §15.10.
   */
  regenerate(dt: number) {
    if (this.regen > 0 && this.alive && this.health > 0 && this.health < this.maxHealth) this.health = Math.min(this.maxHealth, this.health + this.regen * dt);
  }

  /** Hidden by level logic (Visibility Toggler etc. set root.visible) or dormant: inert until shown. */
  get hidden() {
    return !this.ch.root.visible || this.dormantHidden || this.template;
  }
  /** No gravity / no walking: hanging creatures (Nooseman kinds, ceiling hangers). */
  get anchored() {
    return this.kind.anchored || this.ceiling;
  }
  private get idleClip() {
    if (this.dormantIdle >= 0) return this.dormantIdle;
    if (this.b.clip >= 0 && this.behavior?.kind === 'idle') return this.b.clip;
    if (this.gaitClips && this.gaitClips.idle >= 0) return this.gaitClips.idle;
    return this.kind.idle;
  }
  get team() {
    return this.profile.team;
  }

  /** Play `clip` while dormant (DormantBehavior p5). */
  setDormantIdle(clip: number) {
    this.dormantIdle = clip;
    this.play(clip, { loop: true, fade: 0, random: true });
  }

  /** Hang from the ceiling at the placement; `bottom` = lowest body point (model units, < 0). */
  hangFromCeiling(bottom: number) {
    this.ceiling = true;
    this.hangBottom = bottom;
  }

  /** Start hidden; when `drop`, fall from the placement once woken or revealed. */
  setDormantHidden(drop: boolean) {
    this.dormantHidden = true;
    this.dropOnWake ||= drop;
  }

  /** Shown by level logic or a sequence: visible and active (drop-ins start falling). */
  reveal() {
    if (!this.dormantHidden) return;
    this.dormantHidden = false;
    if (this.dropOnWake && !this.scripted) this.startFall();
  }

  /** The message that wakes this actor (its DormantBehavior p12; 1 = On). */
  get wakeMessage() {
    return this.behavior?.kind === 'dormant' ? this.behavior.wakeMessage : 1;
  }

  /**
   * Behavior Changer "On" / an On message / (DormantBehavior p6) an attack: leave dormancy
   * (reveal, let go of the ceiling, hunt). `env` lets the hand-over below happen at once
   * (otherwise on the next AI tick).
   */
  wake(env?: ActorEnv) {
    if (!this.alive || this.kind.decor || this.template) return;
    // The DormantBehavior ends and the character takes its p69 behaviour, whatever it is
    // [verified: event handler 0x100ecdf0 -> behaviour finished 0x100973e0; the stack falls back
    // to the p69 it was built with, 0x100e5170]. A body posed by a DormantBehavior that is also
    // its p69 lies down in that pose again (1a's guards 781c / 782d / 782e, mode 1); a p69
    // DeathBehavior dies (1a 8b32, woken when 1a is re-entered). Port: a p69 mode-2 (hidden)
    // DormantBehavior is not re-entered here (Behavior Changers without a behaviour use wake()).
    const sleeping = this.behavior?.kind === 'dormant' ? this.behavior : undefined;
    const act = this.profile.active;
    if (sleeping && act && ((act.kind === 'dormant' && act.mode === 1) || act.kind === 'death')) {
      if (env) this.setBehavior(act, env);
      else this.pendingRoot = act;
      return;
    }
    const wasDormant = this.dormantHidden || this.ceiling || this.dormantIdle >= 0 || this.dropOnWake || this.behavior?.kind === 'dormant';
    // DormantBehavior p7: a clip played on waking before the next behaviour [verified].
    if (this.behavior?.kind === 'dormant' && this.behavior.wakeClip) this.pendingWakeClip = this.behavior.wakeClip;
    this.dormantHidden = false;
    if (this.dormantIdle >= 0) {
      this.dormantIdle = -1;
      if (this.state === 'idle') this.play(this.kind.idle, { loop: true, fade: 0.3 });
    }
    if (!this.behavior || this.behavior.kind === 'dormant') {
      const act = this.profile.active;
      this.behavior = act && act.kind !== 'dormant' && act.kind !== 'death' ? act : undefined;
      this.b = { phase: 0, t: 0, i: 0, wp: 0, until: 0, clip: -1 };
    }
    if (((this.ceiling && !this.crawler) || this.dropOnWake) && !this.scripted) this.startFall();
    if (wasDormant && this.hostile) this.provoked = true;
  }

  /** Pull up out of sight and drop down at another position (Nooseman drop positions). */
  relocate(p: { x: number; y: number; z: number }) {
    if (!this.alive || this.relocating) return;
    this.relocateTo = { ...p };
    this.relocating = 1e-3;
    this.enterState('idle');
  }

  private updateRelocate(dt: number) {
    const RISE = 0.6, DROP = 0.7, RISE_H = 3;
    const t = (this.relocating += dt);
    const to = this.relocateTo!;
    if (t < RISE) {
      this.ch.root.position.y = this.motor.position.y + (t / RISE) ** 2 * RISE_H;
      return;
    }
    if (this.motor.position.x !== to.x || this.motor.position.z !== to.z) {
      this.motor.position.x = to.x;
      this.motor.position.y = to.y;
      this.motor.position.z = to.z;
    }
    const k = Math.min(1, (t - RISE) / DROP);
    const e = 1 - (1 - k) ** 3;
    this.sync();
    this.ch.root.position.y = to.y + (1 - e) * RISE_H;
    if (k >= 1) {
      this.relocating = 0;
      this.relocateTo = undefined;
      this.sync();
    }
  }

  /** Say one of the attached Action Dialog's lines. */
  private bark(env: ActorEnv, keys: string[], chance: number) {
    const b = this.barks;
    if (!b || b.muted || !keys.length || env.time < b.next || Math.random() * 100 > chance) return;
    b.next = env.time + b.gap;
    env.say(this, { anims: [], pause: 0, sounds: [keys[Math.floor(Math.random() * keys.length)]], message: 0 });
  }

  /** Killed while hanging: drop the body (no fall clip, the death clip keeps playing). */
  private startFallDead() {
    this.motor.position.y += this.hangBottom * this.scale;
    this.ceiling = false;
    this.motor.onGround = false;
  }

  private startFall(fallClip = -1, landClip = -1) {
    if (this.ceiling) {
      // Origin is at the ceiling: drop the body (capsule) to where it hung.
      this.motor.position.y += this.hangBottom * this.scale;
      this.ceiling = false;
    }
    this.dropOnWake = false;
    this.motor.onGround = false;
    this.motor.velocity.x = this.motor.velocity.z = 0;
    this.landClip = landClip;
    this.enterState('fall');
    const clip = fallClip >= 0 ? fallClip : this.kind.fall >= 0 ? this.kind.fall : this.kind.idle;
    this.play(clip, { loop: true, fade: 0.1 });
    this.sync();
  }
  // --- JumpBehavior (behaviors.ts jumpParams) -----------------------------------

  /** Launch clip (p4) with its root translation (x / y / z) moving the body. */
  private startJumpLaunch(clip: number) {
    const d = rootDeltaOf(this, clip);
    const len = this.clipLen(clip);
    this.enterState('fall');
    this.motor.velocity.x = this.motor.velocity.y = this.motor.velocity.z = 0;
    this.play(clip, { loop: false, fade: 0.1 });
    const from = new THREE.Vector3(this.motor.position.x, this.motor.position.y, this.motor.position.z);
    this.jumpLaunch = { from, d, t: 0, dur: Math.max(0.05, len) };
  }

  /** Launch step (0x100ec710): moves the body along the clip's root path, then takes off. */
  private updateJumpLaunch(dt: number, env: ActorEnv) {
    const j = this.jumpLaunch!;
    j.t = Math.min(j.dur, j.t + dt);
    const k = j.t / j.dur;
    const m = this.motor.position;
    const x = j.from.x + j.d.x * k, z = j.from.z + j.d.z * k;
    let y = j.from.y + j.d.y * k;
    // Climbing down onto a ledge: the body stops on the first floor below its start.
    if (j.d.y < 0) {
      const g = env.world.raycast(x, j.from.y + 0.5, z, 0, -1, 0, 0.5 - j.d.y + 0.05);
      if (g && g.normal[1] > 0.6) y = Math.max(y, g.point[1]);
    }
    m.x = x;
    m.y = y;
    m.z = z;
    this.sync();
    if (j.t < j.dur) return;
    this.jumpLaunch = undefined;
    const b = this.behavior;
    if (b?.kind === 'jump') this.jumpOff(b, env);
  }

  /** Airborne step (0x100f0cd0): velocity = facing x p7 + up x p8, gravity x p9. */
  private jumpOff(b: Extract<Behavior, { kind: 'jump' }>, env: ActorEnv) {
    this.startFall(env.clip(this, b.fall), env.clip(this, b.land));
    const tgt = b.toward ? env.entity(b.toward) : undefined;
    let dx = -Math.sin(this.yaw), dz = -Math.cos(this.yaw);
    if (tgt) {
      const [tx, , tz] = outPos(tgt);
      dx = tx - this.position.x;
      dz = tz - this.position.z;
    }
    const v = jumpVelocity(b, dx, dz);
    this.motor.velocity.x = v.x;
    this.motor.velocity.y = v.y;
    this.motor.velocity.z = v.z;
    this.motor.onGround = false;
    const cfg = this.motor.cfg;
    if (!this.jumpPhys) this.jumpPhys = { airAccel: cfg.airAccel, gravity: cfg.gravity };
    cfg.airAccel = 0;
    cfg.gravity = this.jumpPhys.gravity * b.gravity;
  }

  private endJumpPhysics() {
    if (!this.jumpPhys) return;
    this.motor.cfg.airAccel = this.jumpPhys.airAccel;
    this.motor.cfg.gravity = this.jumpPhys.gravity;
    this.jumpPhys = undefined;
  }

  /**
   * Finish (0x100efe70): at the earlier of the timer (p2) and the end of the landing clip the
   * jumper gets an attack stimulus with no attacker (alert afterwards); the behaviour ends at the
   * later of the two.
   */
  private updateJump(env: ActorEnv) {
    const b = this.behavior;
    if (b?.kind !== 'jump') return;
    const landed = this.b.phase === 2 && this.state !== 'hurt' && this.state !== 'fall';
    const timeUp = env.time >= this.b.until;
    if (!this.jumpStim && (timeUp || landed)) {
      this.jumpStim = true;
      this.provoked = true;
    }
    if (landed && timeUp) this.completeBehavior(env);
  }

  /** On screen this frame (not hidden, not culled). */
  get drawn() {
    return this.ch.root.visible && this.ch.mesh.visible;
  }

  /** The Waypoint a WaypointBehavior walk is heading for (uid; 0 when none). */
  get waypointNow(): number {
    return this.behavior?.kind === 'waypoint' ? this.b.wp : 0;
  }

  /** Driven by a STOMP sequence: pose comes from the script, AI and physics pause. */
  scripted = false;
  /** Standing still in the pose a sequence left at its hand-back (no idle clip yet). */
  private heldPose = false;

  /**
   * Apply a scripted pose (output-space position + rotation), or release it (null).
   * A scripted creature is revealed (it's on stage). The sequence player interpolates
   * keys like the original engine, so poses are applied exactly.
   */
  setScriptPose(pos: THREE.Vector3Like | null, quat?: THREE.Quaternion) {
    if (!pos) {
      if (!this.scripted) return;
      this.scripted = false;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ch.root.quaternion);
      this.yaw = Math.atan2(-f.x, -f.z);
      const p = this.ch.root.position;
      if (this.motor) this.handBackAt(p.x, p.y, p.z);
      this.anim = -1;
      this.action = undefined;
      // The scene's last pose stays until the AI plays something itself: designers key the
      // pose a released character keeps (1a "Gaurd" #218 keys the corpse pose 12:195 at
      // 20.09 s and releases at 20.10 s; "Gaurd" #86 keys idle 10:70 before its release).
      // Re-picking the idle at once stood the dead guard up for the 8 s until Behavior
      // Changer 8a21 killed him. Held: a play-once clip (a pose); a loop gives way as before.
      const held = this.ch.current;
      this.heldPose = !!held && held.loop === THREE.LoopOnce && held.enabled;
      this.sync();
      return;
    }
    this.scripted = true;
    this.dormantHidden = false;
    this.dropOnWake = false;
    this.ceiling = false;
    this.motor.position.x = pos.x;
    this.motor.position.y = pos.y;
    this.motor.position.z = pos.z;
    this.ch.root.position.set(pos.x, pos.y, pos.z);
    if (quat) this.ch.root.quaternion.copy(quat);
  }

  /**
   * Take the body over where the sequence left it. The engine moves the object itself while a
   * sequence holds it and hands it back in place: nothing pushes it out of the geometry around
   * it, and it stands on whatever is under its feet. 1b's Horace (7eb2) stands on a 20 cm beam
   * in a niche over the arena ("Camera" #247 keys him there and releases him at 86.6 s); the
   * motor's teleport pushed his capsule out of the niche's walls, off the beam, and he dropped
   * 6.6 m to the arena floor. Feet up to HANDBACK_SNAP above a surface (or a little into it)
   * stand on it, as a teleport would have snapped them; with nothing under them the body falls.
   */
  private handBackAt(x: number, y: number, z: number) {
    const m = this.motor;
    m.position.x = x;
    m.position.y = y;
    m.position.z = z;
    m.velocity.x = m.velocity.y = m.velocity.z = 0;
    const gap = this.world && !this.anchored ? groundGap(this.world, x, y, z, 60) : 0;
    if (gap === null || gap > HANDBACK_SNAP) {
      m.onGround = false;
      return;
    }
    if (gap > -0.25) m.position.y -= gap;
    m.onGround = true;
  }

  get uid() {
    return this.ownUid ?? this.entity?.uid;
  }
  get position() {
    return this.motor.position;
  }
  get alive() {
    return this.state !== 'dead';
  }
  get height() {
    return this.kind.height * this.scale;
  }
  /** World y of the lowest point of the body. */
  get bottom() {
    return this.motor.position.y + (this.ceiling ? this.hangBottom : this.kind.bottom) * this.scale;
  }
  /** Vertical distance from y to the body's extent (0 when inside). */
  verticalGap(y: number) {
    const b = this.bottom;
    return y < b ? b - y : y > b + this.height ? y - b - this.height : 0;
  }
  get radius() {
    return this.kind.radius * this.scale;
  }
  /** Awake = needs per-frame simulation even when not visible. */
  get awake() {
    // Sequence-driven: clips keep running off screen so a camera cut shows them in step.
    if (this.scripted) return true;
    if (this.state === 'dead') return !(this.collapse >= 1 && this.actionDone());
    if (this.state !== 'idle') return true;
    const k = this.behavior?.kind;
    return k === 'waypoint' || k === 'talk' || k === 'anim' || k === 'flee' || k === 'killjoy' || k === 'follow' || !!this.investigating || (!!this.target && this.inCombat);
  }
  /** Fighting (combat behaviour, provoked or holding a grudge). */
  get inCombat() {
    if (this.state === 'dead') return false;
    const k = this.behavior?.kind;
    return !!this.grudge || k === 'kill' || k === 'hostile' || k === 'jumpAttack' || (!this.behavior && (this.hostile || this.provoked));
  }
  /**
   * Perception for a special that runs the actor itself (a ceiling crawler): the generic AI's
   * target choice on its own timer (perceive below).
   */
  sense(dt: number, env: ActorEnv) {
    this.thinkTimer -= dt;
    if (this.thinkTimer > 0) return;
    this.thinkTimer = 0.15 + Math.random() * 0.1;
    this.perceive(env);
  }
  /** The current target is in sight (last perception tick). */
  get targetInSight() {
    return this.seesTarget && !!this.target;
  }
  /** Feet position of the current target (undefined without one). */
  targetFeet(env: ActorEnv): THREE.Vector3Like | undefined {
    return this.target && this.targetAlive(this.target, env) ? this.targetPos(env) : undefined;
  }
  /** Short label for debugging / tests. */
  get activity() {
    return `${this.investigating ? 'investigate:' : ''}${this.state}${this.shot && this.state === 'shoot' ? `:${this.shot.phase}` : ''}${this.behavior ? `/${this.behavior.cls}${this.behavior.uid ? '#' + this.behavior.uid.toString(16) : ''}` : ''}${this.target ? (this.target.player ? '>player' : this.target.prop !== undefined ? `>#${this.target.prop.toString(16)}` : `>${this.target.actor?.kind.className}`) : ''}`;
  }

  /** Feet-to-ground distance at the current position (null: no ground within 60 m). */
  groundGap(world = this.world): number | null {
    if (!world) return null;
    const p = this.motor.position;
    return groundGap(world, p.x, p.y, p.z, 60);
  }

  /**
   * Attach to the collision world. Spawned actors are dropped onto the ground; placed
   * ones are checked against the ground by place() on their first managed frame (after
   * the level logic has added its dynamic objects - furniture, crates - to the world).
   */
  settle(world: CollisionWorld, drop: boolean) {
    this.motor.setWorld(world);
    this.world = world;
    if (this.anchored || !drop) {
      this.motor.onGround = true;
      this.needsPlacement = !drop && !this.anchored;
      return;
    }
    const p = this.motor.position;
    this.motor.teleport(p.x, p.y + 0.05, p.z);
    this.sync();
  }

  /** Placed actor not yet checked against the ground (see place()). */
  needsPlacement = false;

  /**
   * Check a placed actor against the ground: placement noise (feet up to 0.6 m above or
   * 0.25 m into the floor) is snapped onto the surface; a creature with nothing under it
   * within 0.6 m is a drop-in that waits hidden until woken; deeper "sinking" is left
   * alone (sitting / lying on furniture whose top is above the feet).
   */
  place() {
    this.needsPlacement = false;
    const world = this.world;
    if (!world || this.anchored || this.scripted || this.template) return;
    const gap = this.groundGap(world);
    if (gap === null || gap > AIRBORNE_GAP) {
      if (this.state === 'dead') return;
      this.setDormantHidden(true);
      this.motor.onGround = false;
      return;
    }
    if (Math.abs(gap) > 0.02 && gap > -0.25) {
      this.motor.position.y -= gap;
      this.sync(false);
    }
    this.motor.onGround = true;
  }

  // ---------------------------------------------------------------------------
  // Animation

  private play(index: number, o: { loop: boolean; fade?: number; timeScale?: number; random?: boolean }) {
    if (index < 0) return undefined;
    if (index === this.anim && o.loop && this.action) return this.action;
    this.heldPose = false;
    const a = this.ch.play(index, { loop: o.loop, fade: o.fade ?? 0.2, timeScale: o.timeScale ?? 1 });
    if (a && o.random) a.time = Math.random() * this.ch.clips[index].duration;
    this.anim = index;
    this.action = a;
    this.soundsDone = 0;
    return a;
  }

  /** Play a clip of the kind (decorations / ambient creatures driven from outside). */
  playClip(index: number, loop: boolean, timeScale = 1) {
    return this.play(index, { loop, fade: 0.15, timeScale });
  }

  /**
   * AttackedByPlayer (an attached Action Dialog's warning: 0x1008d4a0 pushes behaviour type 0x7c,
   * whose children face the player (0xa) and play the dialog's p17 clip with its line (0x78))
   * [verified]: over whatever the character does, it turns to the player and plays `clip` once;
   * the stack under it waits. Returns the clip's length (s); 0 when it cannot play.
   */
  attackedByPlayer(clip: number, env: ActorEnv): number {
    if (!this.alive || clip < 0 || this.scripted || this.state === 'fall') return 0;
    const len = Math.max(0.2, this.clipLen(clip));
    this.enterState('idle');
    this.play(clip, { loop: false, fade: 0.15 });
    this.wakingUntil = env.time + len;
    this.lookAtPlayer = len;
    return len;
  }

  /** The current clip finished (one-shot) or none plays. */
  get clipDone() {
    return this.actionDone();
  }

  private actionDone() {
    const a = this.action;
    // anim -1 with an action left: the wake-up clip ran out (update(): wakingUntil) and the AI
    // has not picked the next one yet (3a Slayer 8d0 hit right then threw every frame).
    const clip = this.ch.clips[this.anim];
    if (!a || !clip) return true;
    return a.time >= clip.duration - 1e-3 || !a.isRunning();
  }

  private clipLen(i: number) {
    const d = this.ch.clipData[i];
    return i >= 0 && d ? d.duration / (d.rate || 1) : 0;
  }

  /** Advance the skeleton (the manager may skip/slow this for far or hidden actors). */
  animate(dt: number, skip = false) {
    this.animAccum += dt;
    // A melee swing is animated every frame wherever it is: its blades are swept frame by frame.
    if (skip && this.animAccum < 0.2 && !(this.state === 'attack' && this.swing)) return;
    this.ch.update(this.animAccum);
    this.animAccum = 0;
  }

  // ---------------------------------------------------------------------------
  // Behaviours

  /**
   * Hand the actor a root behaviour (Behavior Changer, chain successor, template default).
   * Anything but a dormant behaviour also ends dormancy.
   */
  setBehavior(b: Behavior | undefined, env?: ActorEnv, chained = false) {
    if (!this.alive || this.kind.decor || this.template) return;
    if (!chained) (this.onChainDone = undefined), (this.chainOf = undefined);
    this.behavior = b;
    this.b = { phase: 0, t: 0, i: 0, wp: 0, until: 0, clip: -1 };
    this.fleeState = undefined;
    this.grudge = undefined;
    env?.onBehavior?.(this, b);
    if (!b) return;
    if (b.kind !== 'dormant') {
      const dropping = ((this.ceiling && !this.crawler) || this.dropOnWake) && !this.scripted;
      this.dormantHidden = false;
      this.dormantIdle = -1;
      if (dropping && b.kind !== 'jump') this.startFall();
    }
    switch (b.kind) {
      case 'idle':
        this.b.clip = env ? env.clip(this, b.clip) : -1;
        if (this.state === 'idle' || this.state === 'move' || this.state === 'act') {
          this.enterState('idle');
          this.play(this.idleClip, { loop: true, fade: 0.3 });
        }
        this.b.until = (env?.time ?? 0) + rand(b.fidgetMin, b.fidgetMax);
        break;
      case 'dormant':
        if (b.mode === 2) this.setDormantHidden(false);
        else if (env) {
          const c = env.clip(this, b.clip);
          if (c >= 0) this.setDormantIdle(c);
        }
        break;
      case 'jump': {
        if (!env) break;
        this.dormantHidden = false;
        this.b.until = env.time + b.timer;
        this.jumpStim = false;
        // p3: face the object first, then jump towards it.
        const tgt = b.toward ? env.entity(b.toward) : undefined;
        if (tgt) {
          const [tx, , tz] = outPos(tgt);
          this.yaw = Math.atan2(-(tx - this.position.x), -(tz - this.position.z));
        }
        const launch = env.clip(this, b.launch);
        if (launch >= 0) this.startJumpLaunch(launch);
        else this.jumpOff(b, env);
        break;
      }
      case 'fall':
        if (env) this.startFall(env.clip(this, b.clip));
        break;
      case 'death':
        // A scripted death is nobody's kill: kill reputation is paid by the damage code only
        // (0x100e7519..0x100e75fa) [verified].
        this.lastHitBy = 0;
        this.killedBy = undefined;
        if (env) this.die(env, b);
        break;
      case 'kill':
      case 'hostile':
      case 'jumpAttack':
        this.provoked = true;
        if (this.state === 'move' || this.state === 'act') this.enterState('idle');
        break;
      default:
        if (this.state === 'chase' || this.state === 'act' || this.state === 'door') this.enterState('idle');
    }
  }

  /** Called once when the behaviour chain handed out by a Behavior Changer completes. */
  onChainDone?: () => void;

  /** Passive behaviour finished: chain successor, else the template's active behaviour. */
  private completeBehavior(env: ActorEnv) {
    const b = this.behavior;
    const next = b?.next.length && env.behaviors ? env.behaviors.fromPlaced(b.next[0]) : undefined;
    if (next) return this.setBehavior(next, env, true);
    const done = this.onChainDone;
    this.onChainDone = undefined;
    this.chainOf = undefined;
    done?.();
    const def = this.profile.active;
    this.setBehavior(def && def !== b && def.kind !== 'dormant' && def.kind !== 'death' ? def : idleOf(b), env);
    if (this.state !== 'fall' && this.state !== 'dead') this.enterState('idle');
  }

  /**
   * An explosion throws the corpse (gibs.ts, the p112 BouncingObject): clip `clip` once, the body
   * turned to face along `vel` (the BouncingObject's -Z) and launched at it (m/s); the motor
   * flies it, keeping its speed in the air, and the dead update lets it fall and land.
   */
  throwCorpse(clip: number, vel: THREE.Vector3Like) {
    if (this.state !== 'dead') return;
    this.collapse = 1;
    if (clip >= 0) this.play(clip, { loop: false, fade: 0.05 });
    this.yaw = Math.atan2(-vel.x, -vel.z);
    this.ch.root.rotation.set(0, this.yaw, 0, 'YXZ');
    this.motor.cfg.airAccel = 0;
    this.motor.velocity.x = vel.x;
    this.motor.velocity.y = vel.y;
    this.motor.velocity.z = vel.z;
    this.motor.onGround = false;
  }

  /** Corpse placed at start: dead, showing the end of its death clip, no messages. */
  makeCorpse(env: ActorEnv, b: Extract<Behavior, { kind: 'death' }>) {
    const clips = b.clips.map((r) => env.clip(this, r)).filter((i) => i >= 0);
    const c = clips.length ? clips[0] : this.kind.deaths[0] ?? -1;
    this.health = 0;
    this.state = 'dead';
    this.collapse = 1;
    if (c >= 0) {
      const a = this.play(c, { loop: false, fade: 0 });
      if (a) a.time = this.ch.clips[c].duration;
      this.ch.update(0);
    }
  }

  // ---------------------------------------------------------------------------
  // Damage

  /**
   * Apply damage; returns true if this killed the actor. `by`: the attacking actor, 'player'
   * (also when omitted), or the uid of a non-actor source (Damage Action Object, trap) that
   * provokes but gives nobody to fight back against. `blow`: what the hit reaction reads
   * besides the amount (hitReact).
   */
  damage(amount: number, env: ActorEnv, from?: THREE.Vector3Like, by?: DamageSource, blow?: ActorBlow): boolean {
    if (this.state === 'dead' || this.kind.decor || this.template) return false;
    if (this.invulnerable) return false;
    this.health -= amount;
    const actor = by instanceof Actor ? by : undefined;
    // Damage memory: the target score's p24 term reads the share of the last p14 s per attacker.
    if (amount > 0 && (actor || by === undefined || by === 'player')) {
      const now = env.time;
      this.hurtLog = this.hurtLog.filter((h) => h.t > now - 30);
      this.hurtLog.push({ by: actor ?? 'player', amount, t: now });
    }
    this.killedBy = actor;
    this.lastHitBy = sourceId(by);
    // The blow's attacker for the death picker (deathPick): a character or the player; a hazard
    // (a uid: Damage Action Object, trap) names nobody in its damage record.
    const at = actor ? actor.position : by === undefined || by === 'player' ? env.player.position : undefined;
    this.blowFrom = at ? { x: at.x, y: at.y, z: at.z } : undefined;
    // Driven by a sequence: its Stomp root behaviour swallows the attack stimulus (event 0x2001)
    // and the death event (0x2003) [verified: Stomp message handler 0x100e9dc0]. No hit reaction,
    // no fighting back; a body killed meanwhile dies once control is handed back (update()).
    if (this.scripted) {
      if (this.health <= 0) this.deathDeferred = true;
      return false;
    }
    // A dormant character hears the attack stimulus (event 0x2001) only when its
    // DormantBehavior has p6 set; otherwise it stays dormant and does not fight back
    // (Horace, Noosemen) [verified: DormantBehavior event handler 0x100ecdf0].
    const dormant = this.behavior?.kind === 'dormant' ? this.behavior : undefined;
    if (dormant && !dormant.wakeOnAttack && this.health > 0) return false;
    if (dormant) this.wake(env);
    // Woken into its p69 DeathBehavior (a corpse double): dead, and nobody's kill.
    if (!this.alive) return false;
    // A pose (a body lying in its DormantBehavior pose, a sequence's last pose held after the
    // hand-back, a DeathBehavior root) shows no hit reaction and does not get up [inferred].
    const posed = this.heldPose || this.behavior?.kind === 'dormant' || this.behavior?.kind === 'death';
    // Fighting back depends on the root behaviour (behaviors.ts attackStartsFight) [verified].
    const fights = !posed && attackStartsFight(this.behavior, { hostileKind: this.kind.hostile, actionDialog: !!this.barks, byPlayer: by === undefined || by === 'player' });
    if (fights) {
      this.provoked = true;
      this.investigating = undefined;
      // Who hurt us: fight back (grudge), unless it's an ally hitting by accident.
      const attacker: Target | undefined = actor ? { actor } : typeof by === 'number' ? undefined : { player: true };
      // The player is never a candidate of a KillEnemies that lists his team as an ally
      // (0x100f9eb0): the companions (1c 7569, 2 868, 6b 49a: 10:214 allies 2:384) take his hits
      // without fighting back; their Action Dialog's turn is the level logic's (director.ts).
      const allyPlayer = !!attacker?.player && !!(this.behavior?.kind === 'kill' ? this.behavior : this.profile.kill)?.allies.includes(PLAYER_TEAM);
      if (attacker && !allyPlayer && !(actor && actor.team && actor.team === this.team)) {
        if (!this.target || !this.inCombat) this.grudge = attacker;
        this.target ??= attacker;
      }
      // Where the blow came from is where the target was: only when it came from the target (or
      // there is none yet). A hazard's blows (gas, arcs: no attacker) or another attacker's
      // must not drag the chase towards them: the gas chamber's floor tiles pulled the
      // CartWheeler back to the tile centre 13 times a second, so it shuffled on the spot.
      const fromTarget = !this.target || (!!attacker && (attacker.player ? !!this.target.player : attacker.actor === this.target.actor));
      if (from && fromTarget) {
        this.lastSeen.set(from.x, from.y, from.z);
        this.lastSeenTime = env.time;
      }
    }
    if (this.health <= 0) {
      this.die(env, undefined, this.blowFrom);
      return true;
    }
    if (amount > 0) {
      this.fleeHit(amount, env);
      this.bark(env, this.barks?.hurt ?? [], this.barks?.hurtChance ?? 0);
    }
    if (posed) return false;
    // The hit reaction reads the blow's impact force when the source gives one (hit-react.ts).
    const stimulus = blow?.react ?? blow?.frameAmount ?? amount;
    if (this.ceiling) {
      if (!this.crawler) this.startFall();
      else if (stimulus > (this.blowsTaken?.amount ?? -1) || blow?.special) this.blowsTaken = { amount: Math.max(stimulus, this.blowsTaken?.amount ?? 0), special: blow?.special ?? this.blowsTaken?.special };
      return false;
    }
    if (this.profile.hitReacts) {
      if (!this.hitReact(stimulus, env, from, actor, blow) && this.inCombat && (this.state === 'idle' || this.state === 'move' || this.state === 'act')) this.enterState('chase');
      return false;
    }
    // No decoded hit-reaction lists (a profile built without game data): the kind's hit clips,
    // and small hits don't interrupt an attack in progress.
    if ((this.state !== 'attack' && this.state !== 'shoot' && this.state !== 'fall') || amount >= 20) {
      const hits = this.kind.hits;
      if (hits.length && this.state !== 'fall') {
        const i = hits[Math.min(hits.length - 1, amount >= 30 ? 2 : amount >= 15 ? 1 : 0)];
        this.play(i, { loop: false, fade: 0.08 });
        this.enterState('hurt');
      } else if (this.state === 'idle' || this.state === 'move' || this.state === 'act') this.enterState('chase');
    }
    return false;
  }

  /**
   * The hit reaction of a blow (hit-react.ts; Suffering.rfl vt 72 0x100e6480) [verified unless
   * marked]. `amount` is what the engine's damage record carries (per frame for damage over
   * time). Returns true when a reaction started.
   */
  private hitReact(amount: number, env: ActorEnv, from: THREE.Vector3Like | undefined, attacker: Actor | undefined, blow: ActorBlow | undefined): boolean {
    const t = this.profile.hitReacts!;
    // Behaviours that swallow the attack stimulus: a JumpBehavior / FallBehavior in the air, a
    // CeilingFloorTransition in transit (port: the special's gate) [verified handlers, port
    // mapping of the states].
    if (this.state === 'fall' || this.jumpLaunch || (this.reactGate && !this.reactGate())) return false;
    const pick = pickHitReact(t.hits, amount, { specials: t.specials, special: blow?.special });
    if (!pick) return false;
    const d = pick.def;
    // Message 0x2008 code 1 to the stack: a running whole-body reaction refuses by its p6 mode
    // against the blow's whole points (0x100efa30 -> 0x100e83f0).
    const r = this.reaction;
    if (this.state === 'hurt' && r) {
      const down = r.steps[0] === 'getUp' && env.time < r.downUntil;
      if (reactionBlocks({ min: r.pick.def.min, max: r.pick.max, mode: r.pick.def.mode }, Math.trunc(amount))) {
        // Down on the floor: the blow keeps it down (p23 twitch, the down time again) [inferred].
        if (down) this.keepDown(env);
        return false;
      }
      if (down && !r.pick.def.newWhileDown) {
        this.keepDown(env);
        return false;
      }
    }
    // A MeleeAttack refuses while its Attack's p39 is 0: no retail Attack sets it (0x10080290).
    if (d.layerBone >= 0) return this.startFlinch(pick, env, from ?? attacker?.position);
    this.startReaction(pick, env, from ?? attacker?.position);
    return true;
  }

  /** Partial-body flinch: an independent layer on bone p12; nothing else stops [verified]. */
  private startFlinch(p: HitPick, env: ActorEnv, from: THREE.Vector3Like | undefined): boolean {
    const d = p.def;
    const f = this.flinch;
    if (f && env.time < f.until && reactionBlocks(f, d.min)) return false;
    let local: { x: number; y: number } | undefined;
    let boneY: number | undefined;
    const bones = this.ch.skeleton.bones;
    if (from && d.sideBone >= 0 && bones[d.sideBone]) {
      // Attacker and side bone in the character's model space (0x100e67a1).
      const m = this.ch.mesh;
      m.updateWorldMatrix(true, true);
      const a = m.worldToLocal(new THREE.Vector3(from.x, from.y, from.z));
      const b = m.worldToLocal(bones[d.sideBone].getWorldPosition(new THREE.Vector3()));
      local = { x: a.x, y: a.y };
      boneY = b.y;
    }
    const c = env.clip(this, flinchClip(d, local, boneY));
    if (c < 0 || !bones[d.layerBone]) return false;
    const a = this.ch.playLayer(d.layerBone, c, { loop: false, hold: false, independent: true, blend: 0.08, timeScale: reactionRate(d) });
    if (!a) return false;
    this.flinch = { min: d.min, max: p.max, mode: d.mode, bone: d.layerBone, until: env.time + this.clipLen(c) / Math.max(0.05, a.timeScale) };
    return true;
  }

  /** Whole-body reaction: the HitReactBehavior pauses what the character was doing. */
  private startReaction(p: HitPick, env: ActorEnv, from: THREE.Vector3Like | undefined) {
    const d = p.def;
    const c = d.clips.length ? env.clip(this, d.clips[Math.floor(Math.random() * d.clips.length)]) : -1;
    if (this.flinch) {
      this.ch.stopLayer(this.flinch.bone, 0.08);
      this.flinch = undefined;
    }
    const steps: ('land' | 'down' | 'getUp')[] = [];
    if (d.knock.land) steps.push('land');
    if (d.knock.down) steps.push('down');
    if (d.knock.getUp) steps.push('getUp');
    this.enterState('hurt');
    this.reaction = { pick: p, steps, down: downTimeOf(p), downUntil: Infinity, face: d.face && from ? { x: from.x, z: from.z } : undefined };
    if (c >= 0) this.play(c, { loop: false, fade: 0.08, timeScale: reactionRate(d) });
    else {
      this.anim = -1;
      this.action = undefined;
    }
    // HitReactBehavior p11 to the character's links as it starts (0x100ebfa0) [verified]: 8b's
    // Hermes copies send Triggered to the stove Relay 1f0d.
    if (d.message) this.fireLinks(env, d.message);
  }

  /** A blow while knocked down: the down time starts again (p23 when it has one) [inferred]. */
  private keepDown(env: ActorEnv) {
    const r = this.reaction!;
    r.downUntil = env.time + r.down;
    const k = r.pick.def.knock;
    const c = env.clip(this, k.hitDown);
    if (c >= 0) this.play(c, { loop: false, fade: 0.05 });
  }

  /** 'hurt' with a whole-body reaction: the clip, then the knockdown steps. False when done. */
  private updateReaction(dt: number, env: ActorEnv): boolean {
    const r = this.reaction!;
    if (r.face) this.faceTowards(r.face.x - this.position.x, r.face.z - this.position.z, dt, TURN_RATE * 2);
    const k = r.pick.def.knock;
    const step = r.steps[0];
    if (step === 'getUp' && r.downUntil !== Infinity) {
      if (env.time < r.downUntil) {
        // Lying: the down pose (p20) after a p23 twitch.
        const pose = env.clip(this, k.down);
        if (this.actionDone() && pose >= 0 && this.anim !== pose) this.play(pose, { loop: false, fade: 0.1 });
        return true;
      }
      r.steps.shift();
      const up = env.clip(this, k.getUp);
      // A bleeder that would bleed out while getting up dies down here (0x100ef7a8).
      if (up >= 0 && env.bleedsOut?.(this, this.clipLen(up))) return true;
      if (up >= 0) this.play(up, { loop: false, fade: 0.15 });
      return true;
    }
    if (!this.actionDone()) return true;
    if (!step) return false;
    if (step === 'land') {
      r.steps.shift();
      const c = env.clip(this, k.land);
      if (c >= 0) this.play(c, { loop: false, fade: 0.05 });
      return true;
    }
    if (step === 'down') {
      r.steps.shift();
      const c = env.clip(this, k.down);
      if (c >= 0) this.play(c, { loop: false, fade: 0.05 });
      r.downUntil = env.time + r.down;
      if (r.steps[0] !== 'getUp') r.steps.unshift('getUp');
      return true;
    }
    r.steps.shift();
    const up = env.clip(this, k.getUp);
    if (up < 0) return r.steps.length > 0;
    if (env.bleedsOut?.(this, this.clipLen(up))) return true;
    this.play(up, { loop: false, fade: 0.15 });
    return true;
  }

  /** Where the attacker of the last blow stood (damage()); undefined: nobody (a hazard). The
   * killing blow's goes to die(). */
  private blowFrom?: THREE.Vector3Like;

  /**
   * The DeathBehavior of the character's p72 list for the killing blow (Character death
   * 0x100e5d00, picker at 0x100e6174) [verified]: the angle between the body's +Z axis (its back:
   * the row of its world matrix, times its scale) and the direction from the attacker to the body,
   * in degrees; the first entry whose p4 is above it, else the first. A blow with no attacker in
   * its damage record (Damage Action Objects build theirs with none, 0x1008e9e7) keeps the zero
   * vector: 90 degrees exactly. Guards (p72 10:250 p4 90, 10:22 p4 270): shot from the front ->
   * 10:250 (10:301 / 10:1470, thrown back), from behind or by a hazard -> 10:22 (10:156, 5.7 s:
   * he stands, sinks to his knees and only falls at the end): 1a's guard 609e at the electrified
   * door (Damage Action Object 8185, 200 damage).
   */
  private deathFor(f?: THREE.Vector3Like): Extract<Behavior, { kind: 'death' }> | undefined {
    const list = this.profile.deaths;
    if (!list || list.length < 2) return this.profile.death;
    const p = this.motor.position;
    const theta = deathAngle(this.yaw, this.scale, f && { x: p.x - f.x, y: p.y - f.y, z: p.z - f.z });
    return list[deathPick(list.map((d) => d.angle ?? 360), theta)];
  }

  /** `from`: where the killing blow's attacker stood (none: a hazard, BlowUp, a script). */
  die(env: ActorEnv, b?: Extract<Behavior, { kind: 'death' }>, from?: THREE.Vector3Like) {
    if (this.state === 'dead') return;
    this.health = 0;
    this.enterState('dead');
    const own = (b ?? this.deathFor(from))?.clips.map((r) => env.clip(this, r)).filter((i) => i >= 0) ?? [];
    const d = own.length ? own : this.kind.deaths;
    if (d.length) {
      this.play(d[Math.floor(Math.random() * d.length)], { loop: false, fade: 0.12 });
      this.collapse = 1;
    } else {
      this.collapse = 0; // no death clip: tip over procedurally
      this.play(this.idleClip, { loop: false, fade: 0.1 });
      this.action?.halt(0.5);
    }
    this.motor.velocity.x = this.motor.velocity.z = 0;
    env.onDeath(this);
  }

  // ---------------------------------------------------------------------------
  // AI

  update(dt: number, env: ActorEnv) {
    if (this.kind.decor || this.scripted) return;
    if (this.deathDeferred) {
      this.deathDeferred = false;
      if (this.alive && this.health <= 0) return this.die(env, undefined, this.blowFrom);
    }
    if (this.pendingRoot) {
      const b = this.pendingRoot;
      this.pendingRoot = undefined;
      if (this.alive) this.setBehavior(b, env);
    }
    // Special-move hook (specials/index.ts): runs before the generic AI, also while the actor
    // is dormant-hidden (a Burrower travelling underground); true = it ran this tick itself.
    if (this.special?.(dt, env)) return;
    if (this.hidden) {
      // A scripted conversation still runs for an unseen speaker: 1b's Hermes (instance flag 0x1
      // clear, so hidden from the start) talks after the Horace scene, and the end of his lines
      // (p17) starts the arena; skipping it stopped the level there.
      if (this.behavior?.kind === 'talk' && !this.template && !this.dormantHidden && this.state !== 'dead') {
        this.stateTime += dt;
        this.runTalk(this.behavior, dt, env);
      }
      return;
    }
    this.stateTime += dt;
    this.playClipSounds(env);
    if (this.state === 'dead') {
      if (this.collapse < 1) {
        this.collapse = Math.min(1, this.collapse + dt * 2.2);
        const e = this.collapse * this.collapse;
        this.ch.root.rotation.set(-e * Math.PI * 0.5, this.yaw, 0, 'YXZ');
      }
      // Dead bodies still fall to the ground (ceiling hangers let go).
      if (this.ceiling && !this.crawler) this.startFallDead();
      if (!this.motor.onGround && !this.kind.anchored) this.step(dt, 0, 0);
      this.sync(false);
      return;
    }

    if (this.relocating) return this.updateRelocate(dt);
    if (this.climb) return this.updateClimb(dt, env);
    if (this.jumpLaunch) return this.updateJumpLaunch(dt, env);
    if (this.behavior?.kind === 'jump') this.updateJump(env);
    // DormantBehavior p7: the wake clip plays out before the behaviour that follows.
    if (this.pendingWakeClip) {
      const c = env.clip(this, this.pendingWakeClip);
      this.pendingWakeClip = undefined;
      if (c >= 0 && this.state !== 'fall') {
        this.enterState('idle');
        this.play(c, { loop: false, fade: 0.1 });
        this.wakingUntil = env.time + Math.max(0.2, this.clipLen(c));
      }
    }
    if (this.wakingUntil) {
      if (env.time < this.wakingUntil) {
        // AttackedByPlayer's facing child (attackedByPlayer) turns it to the player meanwhile.
        if (this.lookAtPlayer > 0) {
          this.lookAtPlayer -= dt;
          const p = env.player.position;
          this.faceTowards(p.x - this.position.x, p.z - this.position.z, dt, TURN_RATE);
        }
        this.sync();
        return;
      }
      this.wakingUntil = 0;
      this.anim = -1;
    }
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.15 + Math.random() * 0.1;
      const had = this.target;
      this.perceive(env);
      if (this.killDone) {
        this.killDone = false;
        if (this.behavior?.kind === 'kill') this.completeBehavior(env);
      }
      if (this.target && !had && this.inCombat) this.bark(env, this.barks?.spot ?? [], this.barks?.spotChance ?? 0);
    }
    // InvestigateBehavior: AI noises of this tick (manager.ts keeps them for one tick).
    // Only a ListenBehavior hears (behaviors.ts rootListens): a fleeing, talking, idling or
    // running-to-the-leader character does not go after noises [verified].
    const listens = rootListens(this.behavior, this.b.fol?.mode !== 'run' && this.b.fol?.mode !== 'aside');
    if (this.investigating && !listens) this.investigating = undefined;
    if (env.noises?.length && this.profile.investigate && listens) this.hear(env.noises, env);
    this.shotCooldown -= dt;
    this.attackDelay -= dt;
    this.updateLook(env);
    if (this.inFlight.length) this.updateInFlight(env);
    if (this.missiles.length) this.updateMissiles(dt, env);
    if (this.lookAtPlayer > 0) {
      this.lookAtPlayer -= dt;
      const p = env.player.position;
      if (!this.inCombat) this.faceTowards(p.x - this.position.x, p.z - this.position.z, dt, TURN_RATE * 0.5);
    }
    this.wish.set(0, 0);
    // A special that set the state itself took the body out of a hit reaction.
    if (this.reaction && this.state !== 'hurt') this.reaction = undefined;

    switch (this.state) {
      case 'fall':
        if (this.motor.onGround) {
          this.endJumpPhysics();
          const land = this.landClip >= 0 ? this.landClip : this.kind.land;
          this.landClip = -1;
          if (land >= 0) {
            this.play(land, { loop: false, fade: 0.05 });
            this.enterState('hurt');
          } else this.enterState('idle');
          // A JumpBehavior finishes after its landing clip and timer (updateJump); a
          // FallBehavior when the creature lands.
          if (this.behavior?.kind === 'jump') this.b.phase = 2;
          else if (this.behavior?.kind === 'fall') this.completeBehavior(env);
        } else if (this.stateTime > 6) {
          this.endJumpPhysics();
          this.enterState('idle'); // fell out of the world
          if (this.behavior?.kind === 'jump') this.b.phase = 2;
        }
        break;
      case 'hurt':
        if (this.reaction) {
          if (!this.updateReaction(dt, env) || this.stateTime > 15) this.enterState(this.inCombat && this.target ? 'chase' : 'idle');
        } else if (this.actionDone() || this.stateTime > 1.2) this.enterState(this.inCombat && this.target ? 'chase' : 'idle');
        break;
      case 'attack':
        this.updateAttack(dt, env);
        break;
      case 'shoot':
        this.updateShoot(dt, env);
        break;
      case 'door':
        this.updateDoor(dt, env);
        break;
      default:
        // (A follower's investigation is its waiting Hostility's: runFollow keeps its path check.)
        if (this.investigating && !this.seesTarget && this.behavior?.kind !== 'follow' && (this.state === 'idle' || this.state === 'move' || this.state === 'chase')) this.updateInvestigate(dt, env);
        else if (this.inCombat) this.updateCombat(dt, env);
        else this.updatePassive(dt, env);
    }

    const wx = this.wish.x + this.push.x, wz = this.wish.y + this.push.y;
    const v = this.motor.velocity;
    // Standing still on the ground: skip the physics query entirely (most actors, most frames).
    const rootMove = this.b.move;
    const resting = this.anchored || (wx === 0 && wz === 0 && !rootMove && this.motor.onGround && Math.abs(v.x) + Math.abs(v.z) < 0.02);
    if (resting) v.x = v.z = 0;
    else if (rootMove && this.state === 'act') this.stepRoot(dt, rootMove);
    else this.step(dt, wx, wz);
    this.updateLocomotion();
    this.sync();
  }

  // --- passive behaviours ----------------------------------------------------

  private updatePassive(dt: number, env: ActorEnv) {
    const b = this.behavior;
    if (this.ceiling) {
      // Hangers wait for prey to pass underneath.
      if ((this.hostile || this.provoked) && env.playerAlive && this.seesTarget && this.target?.player) {
        const p = env.player.position;
        if (Math.hypot(p.x - this.position.x, p.z - this.position.z) < CEILING_DROP_RANGE) this.wake(env);
      }
      return;
    }
    if (!b) return this.setStateIf('idle');
    switch (b.kind) {
      case 'idle':
        this.setStateIf('idle');
        // Fidgets (IdleBehavior p5) now and then.
        if (b.fidgets.length && env.time > this.b.until && this.state === 'idle' && this.anim === this.idleClip) {
          this.b.until = env.time + rand(b.fidgetMin, b.fidgetMax);
          const c = env.clip(this, b.fidgets[Math.floor(Math.random() * b.fidgets.length)]);
          if (c >= 0) {
            this.play(c, { loop: false, fade: 0.25 });
            this.enterState('act');
            this.b.phase = 99;
          }
        }
        break;
      case 'dormant':
        // Waits for its waking message or (p6) an attack; mode 0 ends at once [verified].
        if (b.mode === 0) return this.wake(env);
        this.setStateIf('idle');
        break;
      case 'follow':
        this.runFollow(b, dt, env);
        break;
      case 'waypoint':
        this.runWaypoints(b, dt, env);
        break;
      case 'anim':
        this.runAnim(b, dt, env);
        break;
      case 'talk':
        this.runTalk(b, dt, env);
        break;
      case 'flee':
        this.runFlee(b, dt, env);
        break;
      case 'killjoy':
        this.runKilljoy(b, dt, env);
        break;
      case 'ratSpawn':
        // Emerge clip once (RatSpawnBehavior p2), then the active behaviour.
        if (this.b.phase === 0) {
          this.b.phase = 1;
          const c = env.clip(this, b.clip);
          if (c < 0) return this.completeBehavior(env);
          this.play(c, { loop: false, fade: 0.05 });
          this.enterState('act');
        } else if (this.state !== 'act' || this.actionDone()) this.completeBehavior(env);
        break;
      case 'horace': {
        // Horace electrocutes the player who comes within reach.
        this.setStateIf('idle');
        const p = env.player.position;
        if (env.playerAlive && Math.hypot(p.x - this.position.x, p.y - this.position.y, p.z - this.position.z) < b.range && env.time > this.b.until) {
          this.b.until = env.time + 2;
          env.damagePlayer(b.damage, this);
        }
        break;
      }
      default:
        this.setStateIf('idle');
    }
    // A fidget / act finished.
    if (this.state === 'act' && this.b.phase === 99 && this.actionDone()) {
      this.b.phase = 0;
      this.enterState('idle');
    }
  }

  private setStateIf(s: ActorState) {
    if (this.state === 'act' && this.b.phase === 99) return;
    if (this.state !== s && (this.state === 'idle' || this.state === 'move' || this.state === 'chase')) this.enterState(s);
  }

  /** WaypointBehavior: walk the Waypoint chain, waiting for escorted objects. */
  private runWaypoints(b: Extract<Behavior, { kind: 'waypoint' }>, dt: number, env: ActorEnv) {
    if (!this.b.wp) this.b.wp = b.first;
    const wp = env.entity(this.b.wp);
    if (!wp || wp.className !== 'Waypoint') return this.completeBehavior(env);
    // Hostile creatures leave the path when an enemy shows up (p7 = 0).
    if (!b.keepPath && this.hostile && this.seesTarget && this.target) {
      this.behavior = this.profile.active?.kind === 'hostile' || this.profile.active?.kind === 'kill' ? this.profile.active : { cls: 'HostilityBehavior', kind: 'hostile', next: [] };
      return;
    }
    // Escort (p8 escorted objects: the player; RFL update 0x100f13d0 -> 0x100ea110 / 0x100ea2b0 /
    // 0x100f0210) [verified unless marked]: each escorted object is flagged beyond p9 and beyond
    // p10 (3D distance). A new leg to the next waypoint starts only while every escorted object is
    // within p9; a leg under way is walked to its end. An escorted object beyond p10 is looked up
    // every 0.4..0.7 s (a FindPath to it, a search only); when the search comes back the walker
    // stops its leg (MoveTo, and its KillEnemies) and beckons it (BeckonBehavior: a LookAt on it
    // over an Idle), standing until every escorted object is within p9 again (0x100ea110,
    // FindPath result 0x100f12ee) [verified]. It never walks back to fetch it: the port used to
    // walk 1c's companion to the player, into the player's fight. [Not modelled: a found path
    // ending off the walker's own route clears the flags, 0x100f1378.]
    // Phases: 0 start, 1 waiting at a waypoint, 2 walking a leg, 3 beckoning.
    if (b.escort.length) {
      const p = env.player.position;
      const d = Math.hypot(p.x - this.position.x, p.y - this.position.y, p.z - this.position.z);
      if (this.b.phase === 0) this.b.phase = 1;
      if (this.b.phase !== 3 && d > b.far) this.b.phase = 3;
      if (this.b.phase === 3) {
        if (d > b.near) {
          this.gait = 1;
          this.setStateIf('idle');
          this.faceTowards(p.x - this.position.x, p.z - this.position.z, dt, TURN_RATE * 0.5);
          return;
        }
        this.b.phase = 1;
      }
      if (this.b.phase === 1) {
        if (d > b.near) {
          this.setStateIf('idle');
          this.faceTowards(p.x - this.position.x, p.z - this.position.z, dt, TURN_RATE * 0.5);
          return;
        }
        // A new leg: a new MoveTo, checked afresh (waypointLegFails).
        this.b.phase = 2;
        this.b.leg = undefined;
      }
    }
    const [x, y, z] = outPos(wp);
    const v = wp.values;
    // Gait: the Waypoint's own p1 (RFL 0x100e9f90: p1 = 1 -> movement mode 3, else 1; the rig's
    // locomotion table 0x100940d0 plays mode 1 = MovementAnimBehavior p3 walk, 2 = p4, 3 = p5
    // run) [verified]. p2 is a distance (x 2048 into the move request), not a speed.
    this.gait = waypointRuns(v) ? WAYPOINT_RUN : 1;
    const turn = waypointTurn(v);
    const sl = this.b.slerp;
    if (sl && sl.wp !== wp.uid) this.b.slerp = undefined;
    if ((this.b.slerp && turn) || (Math.hypot(x - this.position.x, z - this.position.z) < WAYPOINT_REACH && Math.abs(y - this.position.y) < 2)) {
      // p4: first blend to the Waypoint's own placement (Slerp, 0x100ed3b0 / 0x100e8840) over p5 s,
      // then the arrival (waypointSlerp).
      if (turn) {
        if (!this.b.slerp) {
          this.b.slerp = { wp: wp.uid, t: 0, x: this.position.x, z: this.position.z, yaw: this.yaw, toYaw: placementYaw(wp.rotation) };
          this.motor.velocity.x = this.motor.velocity.z = 0;
          this.setStateIf('idle');
          if (this.state === 'idle') this.play(this.idleClip, { loop: true, fade: 0.2 });
        }
        const s = this.b.slerp!;
        s.t += dt;
        const k = turn.time > 0 ? Math.min(1, s.t / turn.time) : 1;
        const q = waypointSlerp(s, { x, z, yaw: s.toYaw }, k);
        this.motor.position.x = q.x;
        this.motor.position.z = q.z;
        this.yaw = q.yaw;
        this.sync();
        if (s.t < turn.time) return;
        this.b.slerp = undefined;
      }
      // Arrived: p0 message to the waypoint's other links [data], then on to the next one.
      const msg = typeof v[0] === 'number' ? v[0] : 0;
      const nextWp = wp.links.find((u) => env.entity(u)?.className === 'Waypoint');
      if (msg) for (const u of wp.links) if (u !== nextWp) env.send(u, msg, wp.uid);
      if (!nextWp || (typeof v[4] === 'number' && v[4] !== 0 && !nextWp)) {
        this.gait = 1;
        return this.completeBehavior(env);
      }
      this.b.wp = nextWp;
      // The next leg waits for the escorted objects again.
      if (b.escort.length) this.b.phase = 1;
      return;
    }
    // MoveTo failing ends the WaypointBehavior: the stack goes on with its next behaviour
    // (waypointLegFails).
    if (this.waypointLegFails(wp.uid, x, y, z, env)) {
      this.gait = 1;
      return this.completeBehavior(env);
    }
    this.setStateIf('move');
    this.moveTo(x, y, z, dt, env);
  }

  /**
   * A WaypointBehavior's MoveTo that fails ends the behaviour [verified: message handler
   * 0x100f0f70, MoveTo's code 2 (failed; the code KillEnemies treats as failure at 0x100fbbdf)
   * -> behaviour finished 0x100973e0 with 1, and the stack runs the next linked behaviour].
   * When MoveTo fails is not decoded: the port's stand-in [inferred] is a leg with neither a
   * straight walk for the body (clearLineCached, not across an area barred to its type) nor a
   * path on the Move Node graph between the nodes the body reaches at either end. 3a's wall
   * CartWheelers (WaypointBehavior 26ae / 3ff7 / 3ffe / 4005 from Object Cloners 3fdc ...) walk
   * a strip behind the west yard's fence whose Move Nodes (3fdd / 3fde) join nothing; their
   * next Waypoint (3fd9 ...) is in the yard, so the walk ends at the fence and their JumpBehavior
   * (3fd7 ...) leaps it, as 1c's CartWheelers 7e20 / 7e21 do from the last Waypoint.
   * The test is made once per leg, when its MoveTo is issued (a new Waypoint, or an escort
   * walking on after waiting / beckoning), not again on the way: a MoveTo that found its way
   * walks it. Re-testing every second from wherever the body was ended 1a's guard 609e on the
   * stairs down to the gate (WaypointBehavior 7524 -> Waypoint 8316), so the gate 7f48 he opens
   * stayed shut.
   */
  private waypointLegFails(wp: number, x: number, y: number, z: number, env: ActorEnv): boolean {
    const nav = env.nav;
    if (!nav?.size) return false;
    const leg = this.b.leg;
    if (leg && leg.wp === wp) return !leg.ok;
    const pos = this.motor.position;
    const navType = this.profile.navType;
    const barred = navType !== undefined && nav.crossesExcluded(pos.x, pos.y, pos.z, x, z, navType);
    let ok = !barred && clearLineCached(this, env, x, y, z);
    if (!ok) {
      // The start node is one the body walks to (nearest() falls back to a thin ray, which
      // passes between a fence's rails); rising walkable ground on the way (stairs up to the
      // node) does not stop it.
      const r = this.radius * 0.9;
      const a = nav.nearest(pos.x, pos.y, pos.z, env.world, 6, r);
      const b = nav.nearest(x, y, z, env.world, 6, r);
      const n = a >= 0 ? nav.nodes[a] : undefined;
      const fits = !n || clearWide(env.world, pos.x, pos.y + 0.9, pos.z, n.x, n.y + 0.9, n.z, r, true);
      ok = a < 0 || b < 0 || (fits && (a === b || !!nav.path(a, b, undefined, { navType })));
    }
    this.b.leg = { wp, at: env.time, ok };
    return !ok;
  }

  /**
   * RootPlayAnimBehavior (RFL 0x100e8c50 [code]): play p2's clips one after another (in order,
   * or a random one each time), completing after p4 clips or when the p5 timer runs out
   * (whichever comes first; neither set = until a Behavior Changer replaces it).
   */
  private runAnim(b: Extract<Behavior, { kind: 'anim' }>, dt: number, env: ActorEnv) {
    if (this.b.phase === 0) {
      this.b.phase = 1;
      this.b.i = 0;
      this.b.until = b.duration > 0 ? env.time + b.duration : 0;
      if (!this.startAnimClip(b, env)) return this.completeBehavior(env);
      return;
    }
    if (this.state !== 'act') this.enterState('act');
    if (b.duration > 0 && env.time >= this.b.until) {
      this.b.move = undefined;
      return this.completeBehavior(env);
    }
    if (!this.actionDone()) return;
    this.b.i++;
    if ((b.plays <= 0 || this.b.i < b.plays) && this.startAnimClip(b, env)) return;
    this.b.move = undefined;
    this.completeBehavior(env);
  }

  private startAnimClip(b: Extract<Behavior, { kind: 'anim' }>, env: ActorEnv) {
    const n = b.clips.length;
    const c = n ? env.clip(this, b.clips[b.ordered ? this.b.i % n : Math.floor(Math.random() * n)]) : -1;
    if (c < 0) return false;
    this.play(c, { loop: false, fade: 0.2 });
    this.enterState('act');
    this.b.phase = 1;
    this.b.move = rootMoveOf(this, c);
    return true;
  }

  /** SimpleConversationBehavior: face the listener and say the lines. */
  private runTalk(b: Extract<Behavior, { kind: 'talk' }>, dt: number, env: ActorEnv) {
    // Listener: the player (p0 != 0) or the object p1 names. p0 = 0 with no such object (1a's
    // gas chamber inmate 71ec: p0 0, p1 0) is a monologue: the start (0x10100600) finds the
    // listener handle empty and goes straight to talking (state 2, 0x10100a19), and the wait
    // state's update does the same (0x100023d0 -> 0x10100c2d) [verified]. The port used to fall
    // back to the player and wait for him to come within range, so those lines never played.
    const target = b.toPlayer ? undefined : b.target ? env.entity(b.target) : undefined;
    const alone = !b.toPlayer && !target;
    const lp = alone ? this.position : target ? (() => {
      const [x, y, z] = outPos(target);
      return { x, y, z };
    })() : env.player.position;
    const dx = lp.x - this.position.x, dz = lp.z - this.position.z;
    const d = Math.hypot(dx, dz);
    // Phase 0 (start 0x10100600): talk once the listener is within p11 m and p12 m in height;
    // with p5 the speaker walks up to the listener wherever it is (MoveTo on the listener);
    // without it the port starts within p9 (the original's other modes are not decoded).
    if (this.b.phase === 0) {
      const near = alone || (d <= b.nearDist && Math.abs(lp.y - this.position.y) <= Math.max(b.nearHeight, 0.5));
      if (b.approach && !near) {
        this.setStateIf('move');
        this.moveTo(lp.x, lp.y, lp.z, dt, env);
        return;
      }
      this.setStateIf('idle');
      if (!near && d > b.startRange && b.startRange < 900) {
        if (b.toPlayer) this.faceTowards(dx, dz, dt, TURN_RATE * 0.3);
        return;
      }
      this.b.phase = 1;
      this.b.i = 0;
      this.b.until = env.time;
    }
    if (!alone) this.faceTowards(dx, dz, dt, TURN_RATE * 0.5);
    if (env.time < this.b.until) {
      if (this.state === 'act' && this.actionDone()) this.enterState('idle');
      return;
    }
    if (this.b.phase === 1) {
      const line = b.lines[this.b.i++];
      if (line) return this.speak(line, env);
      this.b.phase = 2;
      if (b.doneMessage) this.fireLinks(env, b.doneMessage);
      if (!b.ambient.length) return this.completeBehavior(env);
      this.b.until = env.time + rand(Math.max(0.5, b.gapMin), Math.max(1, b.gapMax));
      return;
    }
    // Phase 2: ambient lines (p16) every p19..p20 s until the behaviour is replaced.
    const line = b.ambient[Math.floor(Math.random() * b.ambient.length)];
    this.speak(line, env);
    this.b.until += rand(Math.max(0.5, b.gapMin), Math.max(1, b.gapMax));
  }

  private speak(line: DialogLine, env: ActorEnv) {
    const len = env.say(this, line);
    if (line.message) this.fireLinks(env, line.message);
    const c = line.anims.length ? env.clip(this, line.anims[Math.floor(Math.random() * line.anims.length)]) : -1;
    if (c >= 0) {
      this.play(c, { loop: false, fade: 0.25 });
      this.enterState('act');
    } else this.setStateIf('idle');
    this.b.until = env.time + Math.max(0.6, len) + Math.max(0, line.pause);
  }

  private fireLinks(env: ActorEnv, msg: number) {
    const uid = this.uid;
    for (const u of this.entity?.links ?? []) env.send(u, msg, uid ?? 0);
  }

  /**
   * FleeBehavior (flee.ts; Suffering.rfl 0x10111100 / 0x10111220 / 0x10111340 / 0x101115b0)
   * [verified unless marked]: run to the best Flee Position of the group (flee.ts
   * chooseFleeSpot: away from the threat teams p42, near the ally teams p44), stand there and
   * pick again every p16..p17 s; a spot is marked failed (7 s) and left when the run to it
   * fails, when standing there takes p18 hits of p20+ within p19 s, or one blow of p21 % of
   * the max health. p15 spots reached end it (0: until a Behavior Changer replaces it), as do
   * p2 (no threat left), p10 (a threat within p11 m again) and p13 (no spot).
   */
  private runFlee(b: Extract<Behavior, { kind: 'flee' }>, dt: number, env: ActorEnv) {
    const p = b.flee;
    let st = this.fleeState;
    if (!st) {
      st = this.fleeState = { phase: 'stay', spot: -1, stay: -1, group: -1, repick: 0, runs: p.runs, hits: [], cleared: false, repickNow: false, progT: 0, progX: this.position.x, progZ: this.position.z };
      if (!this.fleePick(b, env, true)) return;
    }
    const spots = env.fleePositions ?? [];
    if (st.phase === 'run') {
      const f = spots.find((s) => s.uid === st!.spot);
      if (!f) {
        st.phase = 'stay';
        return;
      }
      if (Math.hypot(f.x - this.position.x, f.z - this.position.z) <= p.arrive) {
        // Arrived (child done, 0x10111220): p15 counts down; else pick again with this spot
        // as the one stood on.
        if (st.runs > 0 && --st.runs === 0) return this.completeBehavior(env);
        st.stay = st.spot;
        st.phase = 'stay';
        this.fleePick(b, env, true);
        return;
      }
      // The run failed (stuck: the port's stand-in for MoveTo failing): mark it, pick again.
      st.progT += dt;
      if (st.progT > 3) {
        if (Math.hypot(this.position.x - st.progX, this.position.z - st.progZ) < 0.5) {
          f.failedAt = env.time;
          if (!this.fleePick(b, env, true)) return;
        }
        st.progT = 0;
        st.progX = this.position.x;
        st.progZ = this.position.z;
      }
      if (st.phase === 'run') {
        this.gait = 1.6;
        this.setStateIf('move');
        this.moveTo(f.x, f.y, f.z, dt, env);
        return;
      }
    }
    // Standing at the spot (an Idle child).
    this.setStateIf('idle');
    const pick = () => {
      const f = spots.find((s) => s.uid === st!.spot);
      if (f) f.failedAt = env.time;
      this.fleePick(b, env, false);
    };
    if (st.repickNow) {
      st.repickNow = false;
      return pick();
    }
    if (recentHits(st.hits, env.time, p.hitWindow, p.hitMin) >= p.hitCount) {
      st.hits.length = 0;
      return pick();
    }
    st.repick -= dt;
    if (st.repick <= 0) {
      if (st.runs > 0 && --st.runs === 0) return this.completeBehavior(env);
      this.fleePick(b, env, false);
    }
  }

  private fleeState?: {
    phase: 'run' | 'stay';
    /** The spot run to / stood at, the one arrived at (-1 none), the kept group. */
    spot: number;
    stay: number;
    group: number;
    repick: number;
    runs: number;
    hits: { t: number; amount: number }[];
    cleared: boolean;
    repickNow: boolean;
    progT: number;
    progX: number;
    progZ: number;
  };

  /**
   * One pick (0x1010f3c0). `arrived`: after reaching a spot or at the start (the spot run to
   * is not passed as current). Returns false when the behaviour completed.
   */
  private fleePick(b: Extract<Behavior, { kind: 'flee' }>, env: ActorEnv, arrived: boolean): boolean {
    const p = b.flee;
    const st = this.fleeState!;
    const threats: THREE.Vector3Like[] = [];
    const allies: THREE.Vector3Like[] = [];
    // Every living character but itself, by team (0x1010e730): p42 / p43 threats, p44 allies.
    if (env.playerAlive) {
      if (p.threatTeams.includes(PLAYER_TEAM) || p.threatUids.includes(env.playerUid)) threats.push(env.player.position);
      else if (p.allyTeams.includes(PLAYER_TEAM)) allies.push(env.player.position);
    }
    for (const o of env.actors) {
      if (o === this || !o.alive || o.template || o.kind.decor) continue;
      if ((o.team && p.threatTeams.includes(o.team)) || (o.uid !== undefined && p.threatUids.includes(o.uid))) threats.push(o.position);
      else if (o.team && p.allyTeams.includes(o.team)) allies.push(o.position);
    }
    if (p.doneWhenSafe && !threats.length) {
      this.completeBehavior(env);
      return false;
    }
    if (p.doneWhenCaught) {
      const me = this.position;
      const near = threats.some((t) => Math.hypot(t.x - me.x, t.y - me.y, t.z - me.z) <= p.caughtRange);
      if (near && st.cleared) {
        this.completeBehavior(env);
        return false;
      }
      if (!near) st.cleared = true;
    }
    const spots = env.fleePositions ?? [];
    // Only spots in the character's nav area: 1c's east yard is cut off (EdgeToggler 7ee3) until
    // the first yard group is dead.
    // Only spots the character can walk to: the original compares nav area ids, and a run its
    // MoveTo cannot plan fails and stamps the spot; the port asks the graph for a path with the
    // character's NPC Exclusion Type at once (1c: the companion's way into the east yard, Move
    // Nodes 7b71 - 7b72, is off until the first yard group is dead; 7ee1 - 7ee2 keep him out).
    const nav = env.nav;
    const here = nav?.size ? nav.nearest(this.position.x, this.position.y, this.position.z, env.world, 6, this.radius * 0.9) : -1;
    const reachable = here >= 0 ? (s: FleeSpot) => (s.node ?? -1) < 0 || !!nav!.path(here, s.node!, undefined, { navType: this.profile.navType }) : undefined;
    const uid = chooseFleeSpot(p, { me: this.position, threats, allies, spots, group: p.keepGroup ? st.group : -1, stay: st.stay, current: arrived ? -1 : st.spot, time: env.time, reachable });
    if (uid < 0) {
      if (p.doneWhenNone) {
        this.completeBehavior(env);
        return false;
      }
      st.phase = 'stay';
    } else if (st.runs === 0 && uid === st.spot) {
      // The same spot again: no new run (standing there, it stays).
    } else {
      st.spot = uid;
      st.stay = -1;
      st.phase = 'run';
      st.progT = 0;
      st.progX = this.position.x;
      st.progZ = this.position.z;
      if (p.keepGroup && st.group < 0) st.group = spots.find((s) => s.uid === uid)?.group ?? -1;
    }
    st.repick = rand(p.repickMin, Math.max(p.repickMin, p.repickMax));
    return true;
  }

  /**
   * KilljoyRootBehavior [verified: Suffering.rfl start 0x1007bd70, update 0x1007bea0, child done
   * 0x1007c000; KilljoyRaiseDeadBehavior start 0x1007c170, child done 0x1007bcc0, update
   * 0x1007c330; behaviour types from the class map 0x10106d40: 0x42 FleeBehavior, 0xb
   * LookAtBehavior, 0x4b KilljoyRaiseDead, 1 MoveTo, 0xc PlayAnim]:
   *   - Root: a FleeBehavior (his p77) and a LookAt on the player run under it. Each update
   *     (while no RaiseDead runs) scans the p2 corpses from the last: one that is gone or is no
   *     character is dropped from the list (the last entry takes its place); the first one dead
   *     stops the Flee and the LookAt and starts a RaiseDead on it. When the RaiseDead ends
   *     (done or failed) a new LookAt on the player and a new Flee start.
   *   - RaiseDead: a MoveTo the corpse (the request's own defaults: 2 m short, movement mode 3,
   *     a run) with a LookAt on it; when the MoveTo ends, arrived or not, the p2 clip plays. Its
   *     end resurrects the corpse (Character vt 22) and the RaiseDead is done. The corpse gone:
   *     failed. Without the clip playing and within p3 m of the corpse, the clip starts again.
   * Port: the Flee is runFlee with his p77 (10:568 never completes: p2 / p10 / p13 / p15 are 0);
   * the LookAt turns the body to the player while the flee stands; a MoveTo that makes no way
   * for 3 s has failed (as runFlee's). The resurrection itself grows back the corpse's Part
   * Caps with p3 set and stops its bleed (0x100eda37 -> 0x10118930 / 0x101189e0;
   * env.resurrected -> dismember.ts regrow).
   */
  private runKilljoy(b: Extract<Behavior, { kind: 'killjoy' }>, dt: number, env: ActorEnv) {
    const st = (this.b.kj ??= { list: [...b.corpses] });
    const flee = this.profile.flee;
    const rd = this.profile.raiseDead;
    const r = st.raise;
    const back = () => {
      st.raise = undefined;
      // A new Flee child: it chooses its spot afresh.
      this.fleeState = undefined;
      if (this.state === 'act' || this.state === 'move') this.enterState('idle');
    };
    if (r) {
      const c = r.corpse;
      if (!env.actors.includes(c) || c.kind.decor) return back();
      if (r.phase === 'move') {
        const d = Math.hypot(c.position.x - this.position.x, c.position.z - this.position.z);
        r.progT += dt;
        let ended = d <= 2;
        if (!ended && r.progT > 3) {
          if (Math.hypot(this.position.x - r.progX, this.position.z - r.progZ) < 0.5) ended = true;
          r.progT = 0;
          r.progX = this.position.x;
          r.progZ = this.position.z;
        }
        if (!ended) {
          this.gait = 1.6;
          this.setStateIf('move');
          this.moveTo(c.position.x, c.position.y, c.position.z, dt, env);
          return;
        }
        r.phase = 'anim';
        r.clip = -1;
      }
      // LookAt the corpse.
      this.faceTowards(c.position.x - this.position.x, c.position.z - this.position.z, dt, TURN_RATE);
      const playing = r.clip >= 0 && this.state === 'act' && this.anim === r.clip;
      if (playing && this.actionDone()) {
        if (c.resurrect?.(env)) env.resurrected?.(c);
        return back();
      }
      if (!playing) {
        const near = Math.hypot(c.position.x - this.position.x, c.position.y - this.position.y, c.position.z - this.position.z) <= (rd?.near ?? 1);
        // The first start comes from the MoveTo's end; later ones from within p3.
        if (r.clip < 0 || near) {
          const i = env.clip(this, rd?.clip);
          if (i < 0) {
            if (c.resurrect?.(env)) env.resurrected?.(c);
            return back();
          }
          r.clip = i;
          this.play(i, { loop: false, fade: 0.2 });
          this.enterState('act');
        }
      }
      return;
    }
    // Root update: the corpses from the last.
    for (let i = st.list.length - 1; i >= 0; i--) {
      const c = env.actors.find((a) => a.uid === st.list[i] && !a.template);
      if (!c || c.kind.decor) {
        st.list[i] = st.list[st.list.length - 1];
        st.list.pop();
        continue;
      }
      if (!c.alive) {
        st.raise = { corpse: c, phase: 'move', clip: -1, progT: 0, progX: this.position.x, progZ: this.position.z };
        this.fleeState = undefined;
        return;
      }
    }
    if (flee) this.runFlee(flee, dt, env);
    else this.setStateIf('idle');
    // LookAt the player while the flee stands.
    if (env.playerAlive && this.state === 'idle') {
      const p = env.player.position;
      this.faceTowards(p.x - this.position.x, p.z - this.position.z, dt, TURN_RATE * 0.5);
    }
  }

  /** Resurrection (the special that knows how: CartWheeler rise; specials/index.ts). */
  resurrect?: (env: ActorEnv) => boolean;

  /** A blow while fleeing (damage memory; the 0x2001 handler 0x101115b0). */
  private fleeHit(amount: number, env: ActorEnv) {
    const b = this.behavior;
    const st = this.fleeState;
    if (b?.kind !== 'flee' || !st) return;
    st.hits.push({ t: env.time, amount });
    while (st.hits.length > 32) st.hits.shift();
    // Standing: one blow of p21 % of the max health (or more) leaves the spot.
    if (st.phase === 'stay' && amount >= (b.flee.bigHitPercent / 100) * this.maxHealth) st.repickNow = true;
  }

  /**
   * FollowBehavior (follow.ts, docs/game-logic.md §15.10) [verified unless marked]: the follower
   * waits where it is (p3 = 1: its HostilityBehavior fights; 0: Idle) and every 0.5..1 s finds the
   * way to the leader; a way longer than p5 m (p6 while it has a target) makes it run (movement
   * mode 3) to p4 m from where the leader was, not fighting on the way, once no attack of its own
   * is under way. No way: it beckons (looks at the leader) and keeps checking. A leader within
   * 2 m walking into it makes it step aside; a leader beyond p7 ends the behaviour.
   */
  private runFollow(b: Extract<Behavior, { kind: 'follow' }>, dt: number, env: ActorEnv) {
    const lead = b.target > 1 ? env.entity(b.target) : undefined;
    const la = lead ? env.actors.find((o) => o.uid === b.target) : undefined;
    // A leader that is gone or dead ends it (0x100f043f: completes with code 1).
    if (la && !la.alive) return this.completeBehavior(env);
    const leader = la ? la.position : lead ? (() => {
      const [x, y, z] = outPos(lead);
      return { x, y, z };
    })() : env.player.position;
    const pos = this.position;
    const dx = leader.x - pos.x, dy = leader.y - pos.y, dz = leader.z - pos.z;
    const d3 = Math.hypot(dx, dy, dz);
    if (followGivesUp(b.giveUp, d3)) return this.completeBehavior(env);
    const f = (this.b.fol ??= { mode: 'wait', checkAt: env.time, run: false, beckon: false, until: 0, best: Infinity, bestAt: env.time });
    const engaged = b.fights && !!this.target && this.targetAlive(this.target, env);
    if (f.mode === 'aside') {
      // Out of the leader's way for 2.5..3 s, then waiting again (0x100f046e).
      const g = f.goal!;
      if (env.time >= f.until) {
        f.mode = 'wait';
        f.checkAt = env.time + followCheckDelay(Math.random());
      } else if (Math.hypot(g.x - pos.x, g.z - pos.z) > 0.3) {
        this.gait = 1;
        this.setStateIf('move');
        this.moveTo(g.x, g.y, g.z, dt, env);
        return;
      } else return this.setStateIf('idle');
    }
    if (f.mode === 'run') {
      const g = f.goal!;
      const left = Math.hypot(g.x - pos.x, g.z - pos.z);
      // Arrived: MoveTo's arrival distance p4 from the end of the path; waits and checks again.
      if (left <= b.stop && Math.abs(g.y - pos.y) < 2) {
        f.mode = 'wait';
        f.beckon = false;
        f.checkAt = env.time + followCheckDelay(Math.random());
        this.gait = 1;
        this.setStateIf('idle');
        return;
      }
      // A run that gets nowhere (no way for its type, 3 s without coming 0.5 m closer) fails:
      // it beckons instead (MoveTo code 2 -> Beckon, 0x100eed68) [port: when MoveTo fails].
      if (left < f.best - 0.5) (f.best = left), (f.bestAt = env.time);
      if ((this.profile.navType !== undefined && !this.goalReachable) || env.time - f.bestAt > 3) {
        f.mode = 'wait';
        f.beckon = true;
        f.checkAt = env.time + followCheckDelay(Math.random());
        this.gait = 1;
        this.setStateIf('idle');
        return;
      }
      this.gait = WAYPOINT_RUN;
      this.setStateIf('move');
      this.moveTo(g.x, g.y, g.z, dt, env);
      return;
    }
    // Waiting. The path check (FindPath every 0.5..1 s): too long a way sets the run off.
    if (!f.run && env.time >= f.checkAt) {
      const len = this.wayLength(env, leader.x, leader.y, leader.z);
      f.checkAt = env.time + followCheckDelay(Math.random());
      if (len === undefined) f.beckon = true;
      else if (followRuns(len, followLimit(b, engaged))) {
        f.run = true;
        f.goal = { x: leader.x, y: leader.y, z: leader.z };
      }
    }
    // The run starts once nothing of its own is under way (shots and blows are their own states,
    // so here it is free): the waiting child (and its fight) stops.
    if (f.run) {
      f.run = false;
      f.mode = 'run';
      f.beckon = false;
      f.best = Infinity;
      f.bestAt = env.time;
      this.goalReachable = true;
      this.reachCheckAt = 0;
      if (!this.grudge) (this.target = undefined), (this.seesTarget = false);
      this.gait = WAYPOINT_RUN;
      this.enterState('move');
      return;
    }
    if (engaged) return this.updateCombat(dt, env);
    // Its Hostility's Listen / Investigate (p3 = 1) [verified chain, port movement].
    if (this.investigating && !this.seesTarget) return this.updateInvestigate(dt, env);
    // The leader within 2 m and coming at it: step out of his way (0x100ee710).
    if (d3 < b.near) {
      const v = la ? la.motor.velocity : env.player.velocity;
      const s = stepAside({ x: v.x, z: v.z }, { x: -dx, z: -dz }, this.radius);
      if (s) {
        f.mode = 'aside';
        f.goal = { x: leader.x + s.x, y: pos.y, z: leader.z + s.z };
        f.until = env.time + stepAsideTime(Math.random());
        return;
      }
    }
    this.gait = 1;
    this.setStateIf('idle');
    // Beckon: an Idle with a LookAt on the leader (0x100ea8f0).
    if (f.beckon) this.faceTowards(dx, dz, dt, TURN_RATE * 0.5);
  }

  /**
   * Length of the way to a point (FollowBehavior's FindPath): straight when the body can walk it,
   * else along the Move Node graph; undefined when there is none for this walker [port: the
   * original's path search is the engine's].
   */
  private wayLength(env: ActorEnv, x: number, y: number, z: number): number | undefined {
    const pos = this.motor.position;
    const straight = Math.hypot(x - pos.x, y - pos.y, z - pos.z);
    const nav = env.nav;
    const navType = this.profile.navType;
    if (!nav?.size) return straight;
    const a = nav.nearest(pos.x, pos.y, pos.z, env.world, 6, this.radius * 0.9);
    const b = nav.nearest(x, y, z, env.world);
    const barred = navType !== undefined && (nav.crossesExcluded(pos.x, pos.y, pos.z, x, z, navType) || shortcutBarred(nav, a, b, navType));
    if (!barred && clearLineCached(this, env, x, y, z)) return straight;
    if (a < 0 || b < 0) return straight;
    const blocked = env.navBlocked ? (i: number, j: number) => env.navBlocked!(i, j, this) : undefined;
    const p = a === b ? [a] : nav.path(a, b, blocked, { navType });
    if (!p) return undefined;
    return polylineLength([pos, ...p.map((i) => nav.nodes[i]), { x, y, z }]);
  }

  // --- hearing ---------------------------------------------------------------

  /**
   * InvestigateBehavior (Character p97) [verified: 0x100eeec0 polls the noise list, 0x100ed680
   * filters]: a noise is heard when its level is at least p4 (and at least the level of the
   * one being followed up) and the listener is within the noise's radius + p2. The loudest /
   * nearest wins. Footsteps are level 0, so p4 = 1 listeners (every retail one) ignore them.
   */
  private hear(noises: readonly AiNoise[], env: ActorEnv) {
    const inv = this.profile.investigate;
    if (!inv || this.behavior?.kind === 'dormant' || this.ceiling || this.anchored) return;
    if (this.seesTarget && this.target) return;
    const p = this.position;
    let best: AiNoise | undefined, bestD = Infinity;
    for (const n of noises) {
      if (n.source === this) continue;
      if (n.source instanceof Actor && n.source.team && n.source.team === this.team) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z);
      if (!noiseHeard(inv, n, d, this.investigating?.level)) continue;
      if (!hearsNoise(inv.chance, Math.random())) continue;
      if (!best || n.level > best.level || (n.level === best.level && d < bestD)) (best = n), (bestD = d);
    }
    if (!best) return;
    this.investigating = { x: best.x, y: best.y, z: best.z, until: env.time + inv.linger + 8, arrived: false, level: best.level };
    this.lastSeen.set(best.x, best.y, best.z);
    env.onBehavior?.(this, this.behavior);
  }

  /** Go to the heard noise, then look around for a while; seeing an enemy ends it. */
  private updateInvestigate(dt: number, env: ActorEnv) {
    const n = this.investigating!;
    const dx = n.x - this.position.x, dz = n.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (env.time > n.until) {
      this.investigating = undefined;
      if (this.behavior) this.b.phase = 0;
      return this.setStateIf('idle');
    }
    if (!n.arrived && d > 1.5) {
      this.gait = n.level >= 2 ? 1.6 : 1;
      this.setStateIf('move');
      this.moveTo(n.x, n.y, n.z, dt, env);
      // Stuck or unreachable: look from here.
      if (this.stateTime > 12) n.arrived = true;
      return;
    }
    if (!n.arrived) {
      n.arrived = true;
      n.until = Math.min(n.until, env.time + (this.profile.investigate?.linger ?? 6));
    }
    this.gait = 1;
    this.setStateIf('idle');
    // Look around: sweep the facing slowly.
    this.yaw = wrap(this.yaw + Math.sin(env.time * 0.7 + this.id) * dt * 1.2);
  }

  /** Facing channel: the tracking bone turns toward the target while shooting (LookAtBone). */
  private look?: LookAtBone;
  private aimBones?: AimBones;
  private updateLook(env: ActorEnv) {
    const r = this.profile.ranged;
    const tr = r?.track, am = r?.aim;
    if (!tr && !am) return;
    if (tr && !this.look) {
      this.look = new LookAtBone(tr.bone, tr.cone, tr.pitch, tr.speed, tr.ease);
      this.ch.poseHooks.push(this.look.apply);
    }
    if (am && !this.aimBones) {
      // Slew: NPC p39 (0.5 turns / s on every NPC) [data].
      this.aimBones = new AimBones(am.bones, am.origin, am.min, am.max, am.split, 180);
      this.ch.poseHooks.push(this.aimBones.apply);
    }
    const t = this.target;
    const on = this.alive && !this.scripted && !!t && this.state === 'shoot' && this.targetAlive(t, env);
    let point: THREE.Vector3 | null = null;
    if (on) {
      const p = this.targetPos(env);
      // Aim at the chest of the target (feet + 1.2 m) [port choice].
      point = (this.look?.target ?? this.aimBones?.target ?? new THREE.Vector3()).set(p.x, p.y + 1.2, p.z);
    }
    if (this.look) this.look.target = point;
    if (this.aimBones) this.aimBones.target = point;
  }

  // --- combat ----------------------------------------------------------------

  private updateCombat(dt: number, env: ActorEnv) {
    const t = this.target;
    if (this.ceiling) {
      if (t && this.seesTarget) {
        const p = this.targetPos(env);
        if (Math.hypot(p.x - this.position.x, p.z - this.position.z) < CEILING_DROP_RANGE) this.wake(env);
      }
      return;
    }
    if (!t || env.time - this.lastSeenTime > GIVE_UP_AFTER || !this.targetAlive(t, env)) {
      if (this.state !== 'idle') this.enterState('idle');
      if (t && (!this.targetAlive(t, env) || env.time - this.lastSeenTime > GIVE_UP_AFTER)) {
        this.target = undefined;
        if (this.grudge) {
          this.grudge = undefined;
          // Back to what it was doing.
          if (this.behavior) this.b.phase = 0;
        }
        if (!this.behavior) this.provoked = false;
      }
      return;
    }
    if (this.state === 'idle') this.enterState('chase');
    const p = this.targetPos(env);
    const dx = p.x - this.position.x, dz = p.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    const tr = this.targetRadius(t, env);
    // Melee needs no line of fire: KillMelee attacks the selected target once it is in range
    // (seen or kept), with no wall test [verified, RFL 0x1007c910].
    const attack = this.attackDelay > 0 ? undefined : this.pickAttack(dist - tr, Math.abs((t.actor ? t.actor.position.y : p.y) - this.position.y));
    if (attack) return this.startAttack(attack);
    const r = this.profile.ranged;
    // Ranged: the original stops and shoots from where it stands (ProjectileAttack stops the
    // MovementAnim sub-behaviour; the aim pose and firing clips are whole-body) [verified].
    if (r && this.seesTarget && this.shotCooldown <= 0 && dist > 2.5 && dist < r.range && this.facingErr(dx, dz) < 0.6) return this.startShoot(env);
    // Ranged attackers keep their distance once they have a line of fire.
    if (r && this.seesTarget && dist < Math.min(r.range * 0.6, 14) && dist > 3.5) {
      this.faceTowards(dx, dz, dt, TURN_RATE);
      return;
    }
    if (this.anchored) this.faceTowards(dx, dz, dt, TURN_RATE * 0.5);
    else this.steer(env, dt);
  }

  private updateAttack(dt: number, env: ActorEnv) {
    const t = this.target;
    if (t) {
      const p = this.targetPos(env);
      this.faceTowards(p.x - this.position.x, p.z - this.position.z, dt, TURN_RATE * 0.6);
    }
    const a = this.attack!;
    const time = this.action?.time ?? 0;
    // Melee Weapons armed by the clip's Arm / Disarm events: blows land where a blade passes
    // through a body (npc-melee.ts) [verified]. Attacks without them (specials' grabs, a profile
    // without game data) keep the clip's hit times and the start test.
    if (this.swing) this.sweepMelee(env, a, time);
    // A MeleeAttackBehavior Attack deals damage only through a Melee Weapon its clip arms (Arm
    // 100 on the weapon's bone, npc-melee.ts) [verified]: the Slayer 10:527 holds only Ranged
    // Weapons and its clip 10:1554 has no Arm marker (its 201 is a footstep effect, Character
    // p49[1]), so its kick does no damage (before: a guessed Attack p18 / 4 = 30 a blow).
    else if (a.weaponOnly) {
      /* no blow */
    } else
      while (this.hitsDone < a.hitTimes.length && time >= a.hitTimes[this.hitsDone]) {
        this.hitsDone++;
        if (t && this.targetAlive(t, env) && this.canHit(env, a, t)) this.hitTarget(env, t, a.damage);
      }
    if (this.actionDone() || this.stateTime > 4) {
      // The KillMelee's wait after an attack: a special's own KillMelee (the CartWheeler's p182)
      // or the Character's p85 KillMeleeBehavior (guards: 10:578, 0.5..1.5 s).
      const pause = this.meleePause ?? this.profile.meleePause;
      if (pause) this.attackDelay = rand(pause[0], pause[1]);
      this.enterState('chase');
    }
  }

  /**
   * ProjectileAttack (Suffering.rfl vtable 0x101569a0) [verified]: an Attack is picked by the p3
   * weights; the actor aims (Attack p4 pose on the whole body with the Aim sub-behaviour,
   * 0x100fabe0) until it faces the target (the Aim behaviour completes at a facing dot >= 0.99,
   * 0x100e967e), fires (Attack p0 on the whole body at rate p1 +- p2, 0x100fcbc0; the shot
   * leaves at the clip's Fire marker), and after the clip holds the aim pose for p21..p22 s
   * (0x100ff444) before aiming and firing again, Attack p23 times in all (0x100ff3c2).
   */
  private startShoot(env: ActorEnv) {
    const r = this.profile.ranged!;
    const total = r.attacks.reduce((n, a) => n + a.weight, 0);
    let pick = Math.random() * total;
    const attack = r.attacks.find((a) => (pick -= a.weight) < 0) ?? r.attacks[0];
    // Until endShoot sets the pause between attacks.
    this.shotCooldown = Infinity;
    const clip = env.clip(this, attack.clip);
    const aim = attack.aim ? env.clip(this, attack.aim) : -1;
    const aimBone = attack.aimChannel > 0 ? env.channelBone?.(this, attack.aimChannel) ?? -1 : -1;
    this.shot = { attack, clip, aim, aimBone, phase: 'aim', t: 0, until: 0, left: attack.shots, done: false, fired: 0 };
    this.enterState('shoot');
    this.playAim(0.15);
  }

  /**
   * The aim pose (Attack p4): on the whole body, or with a channel (p20) on that channel's
   * subtree over the idle / turning locomotion (0x100f9230 with mode 6 plus MovementAnim).
   */
  private playAim(fade: number) {
    const s = this.shot!;
    if (s.aim < 0) return;
    if (s.aimBone > 0) {
      this.ch.playLayer(s.aimBone, s.aim, { loop: true, blend: fade });
      this.play(this.kind.idle, { loop: true, fade });
    } else this.play(s.aim, { loop: true, fade });
  }

  private updateShoot(dt: number, env: ActorEnv) {
    const t = this.target;
    const s = this.shot;
    if (!s || !t || !this.targetAlive(t, env)) return this.endShoot();
    const p = this.targetPos(env);
    const dx = p.x - this.position.x, dz = p.z - this.position.z;
    this.faceTowards(dx, dz, dt, TURN_RATE);
    s.t += dt;
    if (s.phase === 'pause') {
      if (s.t < s.until) return;
      s.phase = 'aim';
      s.t = 0;
    }
    if (s.phase === 'aim') {
      // Aligned: facing within acos(0.99) of the target. Port safety: give up after 2 s.
      if (this.facingErr(dx, dz) > Math.acos(0.99)) {
        if (s.t > 2) this.endShoot();
        return;
      }
      s.phase = 'fire';
      s.t = 0;
      s.done = false;
      s.fired = 0;
      // The Fire state's entry takes the target's aim point while none is kept (0x100fcc31; the
      // behaviour's start clears it) [verified]: a throw with ProjectileAttackBehavior p5 set goes
      // there (fire).
      s.aimAt ??= { ...this.aimPoint(env, t) };
      // The firing clip plays on the whole body: it takes a channel aim pose over (0x470f20).
      if (s.aimBone > 0) this.ch.releaseLayers(0.1);
      if (s.clip >= 0) {
        this.play(s.clip, { loop: false, fade: 0.1, timeScale: Math.max(0.05, s.attack.rate + s.attack.rateSpread * (2 * Math.random() - 1)) });
      }
      return;
    }
    // Fire: one shot per Fire (102) marker of the clip, each from the weapon on the marker's bone
    // (Character clip messages 0x100e3c0a -> weapon set 0x100958e0) [verified]: the Slayer's
    // firing clips 10:1359 / 10:1370 fire its five arm guns once each. A clip without markers
    // fires once at 40 % (port).
    // A thrown weapon leaves on the ThrowWeapon (230) markers instead (0x100fcec0 case 230).
    const ev = s.clip >= 0 ? this.kind.events[s.clip] : undefined;
    const marks = this.profile.ranged?.thrown ? ev?.throwTimes : ev?.fireTimes;
    const times = marks?.length ? marks : [ev?.hitTimes.length ? ev.hitTimes[0] : s.clip >= 0 ? Math.min(0.35, this.clipLen(s.clip) * 0.4) : 0.3];
    const time = this.action?.time ?? s.t;
    while (s.fired < times.length && time >= times[s.fired]) {
      s.fired++;
      this.fire(env, t);
    }
    s.done = s.fired >= times.length;
    if (!(s.done && (s.clip < 0 || this.actionDone())) && s.t <= 3) return;
    s.left--;
    const clear = !s.attack.lineCheck || this.lineOfFire(env, t);
    if (s.left <= 0 || !clear) return this.endShoot();
    s.phase = 'pause';
    s.t = 0;
    s.until = rand(s.attack.pauseMin, s.attack.pauseMax);
    this.playAim(0.1);
  }

  private endShoot() {
    this.enterState(this.target ? 'chase' : 'idle');
  }

  /** Clear line from the muzzle height to the target (Attack p30 check before another shot). */
  private lineOfFire(env: ActorEnv, t: Target): boolean {
    const a = this.aimPoint(env, t);
    return !sightBlocked(env.world, this.position.x, this.bottom + this.height * 0.75, this.position.z, a.x, a.y, a.z, 0.3, this.seeThroughFor(env, t));
  }

  /**
   * What sight and shots pass on the way to the target: an object target's own body counts as
   * reached (its centre lies inside it: a ray to the 3a fence boards stopped 1.2 m short).
   */
  private seeThroughFor(env: ActorEnv, t: Target | undefined): SeeThrough | null | undefined {
    const body = t?.prop !== undefined ? env.propTarget?.(t.prop)?.body : undefined;
    if (body === undefined) return env.seeThrough;
    return (hit) => hit.dynamic === body || !!env.seeThrough?.(hit);
  }

  /** Where a shot at the target goes: the player's chest, a character's upper body, an object's centre. */
  private aimPoint(env: ActorEnv, t: Target): THREE.Vector3Like {
    if (t.prop !== undefined) {
      const o = env.propTarget?.(t.prop);
      return o ? { x: o.x, y: o.y, z: o.z } : env.player.position;
    }
    const p = t.player ? env.player.position : t.actor!.position;
    return { x: p.x, y: t.player ? p.y + 1.2 : t.actor!.bottom + t.actor!.height * 0.6, z: p.z };
  }

  /** Horizontal radius of the target's body (m). */
  private targetRadius(t: Target, env: ActorEnv) {
    if (t.prop !== undefined) return env.propTarget?.(t.prop)?.radius ?? 0.35;
    return t.actor ? t.actor.radius : 0.35;
  }

  /** Swing under way: Arm windows of the attack clip with their weapons (npc-melee.ts). */
  private swing?: SwingWindow[];

  /**
   * The armed weapons swept from their last place to this frame's (Melee Weapon 0x100caff0)
   * [verified]: every character and the player whose hit spheres a blade passes through is hit
   * once per Arm (friendly fire included), unless a wall stands between the wielder and the
   * contact; damage p68, x the Attack's p6 on the attack's target.
   */
  private sweepMelee(env: ActorEnv, a: KindAttack, time: number) {
    const pos = this.position;
    for (const win of this.swing!) {
      const armed = time >= win.w.t0 && (time <= win.w.t1 || !win.swept);
      if (!armed) continue;
      const cur = shapeWorld(win.weapon.shape, win.node);
      const prev = win.prev;
      win.prev = cur;
      // The arming frame only records where the weapon is; the Disarm waits for one sweep
      // (0x100cb6c0: +0xf4 / +0xf8) [verified].
      if (!prev) continue;
      win.swept = true;
      const reach = Math.max(Math.hypot(cur[0][0] - pos.x, cur[0][2] - pos.z), Math.hypot(cur[1][0] - pos.x, cur[1][2] - pos.z)) + 3;
      const victims: (Actor | 'player')[] = [];
      if (env.playerAlive && Math.hypot(env.player.position.x - pos.x, env.player.position.z - pos.z) < reach) victims.push('player');
      for (const o of env.actors) if (o !== this && o.alive && !o.hidden && !o.kind.decor && !o.template && Math.hypot(o.position.x - pos.x, o.position.z - pos.z) < reach) victims.push(o);
      for (const v of victims) {
        if (win.hit.has(v)) continue;
        const spheres = env.hitSpheres?.(v) ?? [];
        const p = sweepSpheres(prev[0], prev[1], cur[0], cur[1], win.weapon.shape.r, spheres.length ? spheres : bodySpheres(v, env));
        if (!p) continue;
        win.hit.add(v);
        // The wall test: a ray from the wielder (its x / z at the contact's height) to the contact.
        if (sightBlocked(env.world, pos.x, p[1], pos.z, p[0], p[1], p[2], 0.02)) continue;
        const onTarget = !this.target || (v === 'player' ? !!this.target.player : this.target.actor === v);
        const dmg = npcBlowDamage(win.weapon, a.scale ?? 1, onTarget);
        // The contact and the weapon's p70 type go with the blow: Part Caps cut by them.
        const hit: NpcBlowHit = { point: { x: p[0], y: p[1], z: p[2] }, type: win.weapon.type };
        if (v === 'player') env.damagePlayer(dmg, this, hit);
        else env.damageActor(v, dmg, this, hit);
      }
    }
  }

  /** A blow or shot lands on the target. */
  private hitTarget(env: ActorEnv, t: Target, damage: number, hit?: NpcBlowHit) {
    // Without a contact (a blow with no weapon spheres): the aim point stands for it [port].
    const h = hit ?? { point: this.aimPoint(env, t) };
    if (t.player) env.damagePlayer(damage, this, h);
    else if (t.prop !== undefined) env.damageProp?.(t.prop, damage, this, this.aimPoint(env, t));
    else env.damageActor(t.actor!, damage, this, h);
  }

  /** Thrown Missiles in flight (actors/missile.ts). */
  private missiles: { f: MissileFlight; spec: NonNullable<NonNullable<RangedProfile['thrown']>['missile']> }[] = [];

  /**
   * Fly the thrown Missiles one step (missileStep): the world's front faces and every body's hit
   * spheres but the thrower's. The first contact sets it off: p26 damage to the body it touched,
   * p34 spawned there; a needle that only meets the world does no damage.
   */
  private updateMissiles(dt: number, env: ActorEnv) {
    const bodies: MissileBody<Target>[] = [];
    if (env.playerAlive) bodies.push({ body: { player: true } as Target, spheres: env.hitSpheres?.('player') ?? [] });
    for (const a of env.actors) {
      if (a === this || !a.alive || a.kind.decor || a.hidden) continue;
      const sp = env.hitSpheres?.(a) ?? [];
      // Without posed spheres: the body's capsule axis as three spheres [port].
      bodies.push({ body: { actor: a } as Target, spheres: sp.length ? sp : [0.25, 0.5, 0.75].map((k) => ({ c: [a.position.x, a.bottom + a.height * k, a.position.z], r: a.radius })) });
    }
    // The projectile layer: Invisible Static Objects with p5 stop it (world/blockers.ts).
    const w = env.world;
    const sweep = {
      frontSegmentCast: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r?: number) => {
        const l = w.queryLayers;
        w.queryLayers = l | COLLISION_LAYER.projectile;
        try {
          return w.frontSegmentCast(ax, ay, az, bx, by, bz, r);
        } finally {
          w.queryLayers = l;
        }
      },
    };
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const { f, spec } = this.missiles[i];
      const from = { ...f.p };
      const c = missileStep(f, dt, sweep, bodies);
      const len = Math.hypot(f.p.x - from.x, f.p.y - from.y, f.p.z - from.z);
      if (len > 1e-4) env.shotFx?.(from, f.p, true, len / Math.max(dt, 1e-3));
      if (!c) continue;
      this.missiles.splice(i, 1);
      if (c.kind === 'expired') continue;
      for (const g of spec.impact) env.spawnFx?.(g, c.point, c.kind === 'world' ? c.normal : undefined);
      if (c.kind === 'body') this.hitTarget(env, c.body, spec.damage, { point: c.point, type: spec.type });
    }
  }

  /** Projectiles in flight (slow missiles): they hit what is still near the aim point on arrival. */
  private inFlight: { t: number; target: Target; at: THREE.Vector3Like; damage: number }[] = [];

  private updateInFlight(env: ActorEnv) {
    for (let i = this.inFlight.length - 1; i >= 0; i--) {
      const s = this.inFlight[i];
      if (env.time < s.t) continue;
      this.inFlight.splice(i, 1);
      if (!this.targetAlive(s.target, env)) continue;
      const p = this.aimPoint(env, s.target);
      if (Math.hypot(p.x - s.at.x, p.z - s.at.z) > 0.9) continue; // dodged
      this.hitTarget(env, s.target, s.damage, { point: p, type: this.profile.ranged?.type });
    }
  }

  /**
   * Shot at the target: bullets are hitscan, slow missiles (thrown needles, < 60 m/s) land
   * after their flight time. Accuracy falls off with distance (and the weapon's spread).
   */
  private fire(env: ActorEnv, t: Target) {
    const r = this.profile.ranged!;
    const pos = this.position;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const muzzle = env.weaponMuzzle?.(this, r) ?? { x: pos.x + fx * 0.5, y: this.bottom + this.height * 0.75, z: pos.z + fz * 0.5 };
    const p = this.targetPos(env);
    const aim = this.aimPoint(env, t);
    // Thrown (a BouncingObject: the stranger's molotov): released from the hand with the decoded
    // ballistic aim at the target's aim point (actors/throw.ts); it flies, bounces and goes off
    // as any thrown object (the weapons service).
    if (r.thrown) {
      if (r.noise) env.noise?.(muzzle, r.noise, this);
      // ProjectileAttackBehavior p5: the aim point kept from the clip's start (0x100fd079).
      const to = r.keepAim && this.shot?.aimAt ? this.shot.aimAt : aim;
      const v = r.thrown.aimMode === 1 ? ballisticLaunch(muzzle, to, r.thrown.aim) : ballisticLaunch(muzzle, { x: muzzle.x + fx, y: muzzle.y, z: muzzle.z + fz }, { ...r.thrown.aim, reach: 0, fallbackDeg: 0 });
      // A thrown Missile (the Mainliner's needle) flies here until its first contact
      // (actors/missile.ts); a BouncingObject goes to the weapons service.
      const m = r.thrown.missile;
      if (m) this.missiles.push({ f: { p: { x: muzzle.x, y: muzzle.y, z: muzzle.z }, v: { x: v.x, y: v.y, z: v.z }, gravity: r.thrown.aim.gravity, age: 0, life: m.life, radius: m.radius }, spec: m });
      else env.throwObject?.(r.thrown.template, muzzle, v, this);
      return;
    }
    const d = Math.hypot(aim.x - muzzle.x, aim.z - muzzle.z);
    // Shots pass what sight passes (bars, grates, chain-link): the guards fire through cell fronts.
    const clear = !sightBlocked(env.world, muzzle.x, muzzle.y, muzzle.z, aim.x, aim.y, aim.z, 0.3, this.seeThroughFor(env, t));
    if (r.noise) env.noise?.(muzzle, r.noise, this);
    // Bullets: a random cone of Ranged Weapon p75 x Attack p19 degrees around the aim point (the
    // deviation uniform in [0, cone], the roll uniform; 0x10127b30 0x1012810d..0x10128194)
    // [verified]; whether the deflected ray meets the body is the port's box test (its radius
    // across, its half height up). Thrown missiles keep the port's distance rule [guess].
    let hit: boolean;
    // Where the round meets the target (the deflected ray at the aim point's distance): the
    // struck hit sphere for the Part Caps [port].
    let at: THREE.Vector3Like = aim;
    if (r.speed > 0 && r.speed < 60) hit = clear && Math.random() < Math.max(0.25, 0.9 - d * (0.02 + r.spread * 0.002));
    else {
      const half = t.player ? 0.9 : t.actor ? t.actor.height * 0.5 : 0.5;
      const cone = r.spread * (this.shot?.attack.spreadScale ?? 1), dist = Math.hypot(d, aim.y - muzzle.y);
      const u1 = Math.random(), u2 = Math.random();
      hit = clear && spreadShotHits(cone, dist, this.targetRadius(t, env), half, u1, u2);
      at = spreadShotPoint(muzzle, aim, cone, dist, u1, u2);
    }
    const end = hit ? aim : { x: aim.x + (Math.random() - 0.5) * 1.2, y: aim.y + (Math.random() - 0.3) * 0.8, z: aim.z + (Math.random() - 0.5) * 1.2 };
    const slow = r.speed > 0 && r.speed < 60;
    env.shotFx?.(muzzle, end, hit, slow ? r.speed : undefined);
    if (!hit) return;
    if (slow) {
      this.inFlight.push({ t: env.time + Math.hypot(d, aim.y - muzzle.y) / r.speed, target: t, at: { x: p.x, y: p.y, z: p.z }, damage: r.damage });
      return;
    }
    this.hitTarget(env, t, r.damage, { point: at, type: r.type });
  }

  // --- doors -----------------------------------------------------------------

  private updateDoor(dt: number, env: ActorEnv) {
    const open = env.doorOpen?.(this.door) ?? true;
    if (open || this.stateTime > 4) {
      this.door = 0;
      this.enterState(this.inCombat ? 'chase' : 'move');
      this.pathTimer = 0;
    }
  }

  private tryDoor(env: ActorEnv, a: number, b: number): boolean {
    if (!env.closedDoor || !env.openDoor || a < 0 || b < 0) return false;
    const door = env.closedDoor(a, b);
    if (door === undefined || this.profile.openDoor === null) return false;
    const nav = env.nav!;
    const na = nav.nodes[a], nb = nav.nodes[b];
    const mx = (na.x + nb.x) / 2, mz = (na.z + nb.z) / 2;
    if (Math.hypot(mx - this.position.x, mz - this.position.z) > 1.4) return false;
    this.door = door;
    this.enterState('door');
    this.faceTowards(mx - this.position.x, mz - this.position.z, 1, 100);
    const od = this.profile.openDoor;
    const c = od ? env.clip(this, od.front ?? od.back) : -1;
    if (c >= 0) this.play(c, { loop: false, fade: 0.15 });
    else this.play(this.kind.idle, { loop: true, fade: 0.2 });
    env.openDoor(door, this);
    return true;
  }

  /**
   * NPC ladder climbing (LadderClimbBehavior, Character p102; Suffering.rfl names it "ladder
   * climb behavior" and keeps the NPC's own mount templates p10 / p11) [port: the climb's
   * geometry follows the player's ladder (interact.ts); clips and their roles as the player's
   * Ladder Animation Set, inferred]: at the foot (or top) of a Ladder that a nav edge passes
   * through, the character takes the rungs at 0.5 m per rung clip and steps off onto the edge's
   * far node. 1c's companion climbs Ladder 7c2f to his last Waypoint 7b8c, which opens the way to
   * chapter 2.
   */
  private climb?: {
    l: NonNullable<ReturnType<NonNullable<ActorEnv['ladder']>>>;
    up: boolean;
    y: number;
    spot: { x: number; z: number };
    to: { x: number; y: number; z: number };
    exitT: number;
    rung: number;
    len: number;
    hand: number;
    next: number;
  };

  private tryLadder(env: ActorEnv, a: number, b: number): boolean {
    const l = env.ladder!(a, b);
    if (!l) return false;
    const nb = env.nav!.nodes[b];
    const pos = this.position;
    const up = nb.y > pos.y + 1;
    if (!up && nb.y > pos.y - 1) return false;
    const side = Math.sign((pos.x - l.x) * l.fx + (pos.z - l.z) * l.fz) || 1;
    const spot = { x: l.x + l.fx * side * 0.45, z: l.z + l.fz * side * 0.45 };
    // Going up: at the foot; going down: at the top (where the edge starts).
    if (Math.hypot(spot.x - pos.x, spot.z - pos.z) > (up ? 1.0 : 1.6)) return false;
    this.climb = { l, up, y: up ? Math.max(0, pos.y - l.y) : l.height - 1, spot, to: { x: nb.x, y: nb.y, z: nb.z }, exitT: -1, rung: 0, len: 0.37, hand: 0, next: b };
    this.yaw = Math.atan2(side * l.fx, side * l.fz);
    this.enterState('act');
    return true;
  }

  private updateClimb(dt: number, env: ActorEnv) {
    const c = this.climb!;
    const l = c.l;
    const set = this.profile.ladder;
    const m = this.motor.position;
    if (c.exitT >= 0) {
      c.exitT = Math.min(1, c.exitT + dt / 0.45);
      const k = c.exitT;
      const fromY = l.y + c.y;
      m.x = c.spot.x + (c.to.x - c.spot.x) * k;
      m.z = c.spot.z + (c.to.z - c.spot.z) * k;
      m.y = fromY + (c.to.y - fromY) * Math.min(1, k * 2);
      if (k >= 1) {
        this.climb = undefined;
        this.motor.onGround = true;
        if (this.path[0] === c.next) this.prevNode = this.path.shift()!;
        this.stuckTimer = 0;
        this.stuckFrom.set(m.x, m.y, m.z);
        this.enterState('move');
      }
      this.sync();
      return;
    }
    const RUNG = 0.5;
    const clips = (c.up ? set?.up : set?.down) ?? [];
    if (c.rung <= 0) {
      // The next rung: alternate hands; each clip carries the body 0.5 m.
      const i = clips.length ? env.clip(this, clips[c.hand % clips.length]) : -1;
      const len = i >= 0 ? Math.max(0.2, this.clipLen(i)) : 0.37;
      if (i >= 0) this.play(i, { loop: false, fade: 0.08 });
      c.hand++;
      c.rung = c.len = len;
    }
    c.rung -= dt;
    c.y += ((c.up ? 1 : -1) * RUNG * dt) / c.len;
    m.x = c.spot.x;
    m.z = c.spot.z;
    m.y = l.y + Math.max(0, c.y);
    this.motor.onGround = true;
    if ((c.up && c.y >= l.height - 0.9) || (!c.up && c.y <= 0)) {
      c.exitT = 0;
      const e = c.up ? set?.exitTop : set?.exitBottom;
      const i = e ? env.clip(this, e) : -1;
      if (i >= 0) this.play(i, { loop: false, fade: 0.1 });
    }
    this.sync();
  }

  // --- perception ------------------------------------------------------------

  private enterState(s: ActorState) {
    if (s === this.state) return;
    // Leaving a ranged attack (shots done, hurt, killed, scripted): a channel aim pose ends and
    // the pause before the next attack starts.
    if (this.state === 'shoot' && this.shot) {
      if (this.shot.aimBone > 0) this.ch.releaseLayers(0.15);
      this.shot = undefined;
      const r = this.profile.ranged;
      this.shotCooldown = r ? rand(r.cooldownMin, r.cooldownMax) : 1;
    }
    // Leaving a whole-body hit reaction (done, killed, scripted, a special takes over).
    if (this.state === 'hurt') this.reaction = undefined;
    this.state = s;
    this.stateTime = 0;
    if (s !== 'act') this.b.move = undefined;
    if (s === 'idle') this.play(this.idleClip, { loop: true });
    if (s === 'chase' || s === 'move') {
      this.path = [];
      this.pathTimer = 0;
      this.stuckTimer = 0;
      this.stuckFrom.set(this.position.x, this.position.y, this.position.z);
    }
  }

  private targetAlive(t: Target, env: ActorEnv) {
    if (t.prop !== undefined) return !!env.propTarget?.(t.prop);
    return t.player ? env.playerAlive : !!t.actor && t.actor.alive && !t.actor.hidden;
  }

  private targetPos(env: ActorEnv): THREE.Vector3Like {
    const t = this.target;
    if (t?.actor) return t.actor.position;
    if (t?.prop !== undefined) {
      const o = env.propTarget?.(t.prop);
      if (o) return { x: o.x, y: o.bottom, z: o.z };
    }
    return env.player.position;
  }

  /**
   * KillEnemies candidate test (targeting.ts; RFL 0x100f9eb0) [verified unless marked]: not an
   * ally team (p4), alive, shown, not in a DormantBehavior, not itself; it must be of an enemy
   * team (p2), a p3 target, the current target or targeting this character. Port additions: the
   * attacker a passive root fights back on (the grudge, behaviors.ts attackStartsFight) counts as
   * targeting it, and the player is only considered by an actor whose KillEnemies runs (hostile,
   * provoked or fighting) or that follows (companions shoot creatures).
   */
  private candidateOf(o: Actor | 'player'): { enemyTeam: boolean; explicit: boolean; targetsMe: boolean } | undefined {
    const b = this.behavior;
    const kill = b?.kind === 'kill' ? b : this.profile.kill;
    if (o === 'player') {
      const grudge = !!this.grudge?.player;
      if (!grudge && !(this.hostile || this.provoked || this.inCombat)) return undefined;
      if (!grudge && kill?.allies.includes(PLAYER_TEAM)) return undefined;
      const explicit = !!kill?.targets.some((u) => u > 0 && u === playerUidCache);
      const enemyTeam = !!kill?.enemies.includes(PLAYER_TEAM);
      if (!enemyTeam && !explicit && !grudge && !this.target?.player) return undefined;
      return { enemyTeam, explicit, targetsMe: grudge };
    }
    if (o === this || !o.alive || o.hidden || o.kind.decor || o.template || o.behavior?.kind === 'dormant') return undefined;
    const grudge = this.grudge?.actor === o;
    if (!grudge && o.team && kill?.allies.includes(o.team)) return undefined;
    const explicit = o.uid !== undefined && !!kill?.targets.includes(o.uid);
    const enemyTeam = !!o.team && o.team !== this.team && !!kill?.enemies.includes(o.team);
    const targetsMe = grudge || (o.target?.actor === this && o.inCombat);
    if (!enemyTeam && !explicit && !targetsMe && this.target?.actor !== o) return undefined;
    return { enemyTeam, explicit, targetsMe };
  }

  /** Is `t` the same target as this actor's current one? */
  private isCurrent(t: Target) {
    const c = this.target;
    return !!c && (t.player ? !!c.player : t.prop !== undefined ? c.prop === t.prop : c.actor === t.actor);
  }

  /** The target this actor is going for (undefined: none); other actors' choice reads it. */
  get currentTarget(): Readonly<Target> | undefined {
    return this.target;
  }

  /**
   * Target choice (KillEnemiesBehavior; targeting.ts, docs/game-logic.md §15.15) [verified unless
   * marked]. Every perception tick a dead or hidden target, or one farther than the keep range p10
   * (3D; a p3 target held with p5 excepted), is dropped and the choice is made again at once. The
   * choice also runs every re-pick interval (p12 + U(0, p13) s, rolled per fight; p12 < 0: only the
   * first pick) and, without a target, every HostilityBehavior p3..p4 s (other roots: 0.5 s, the
   * WaypointBehavior's restart [verified 0x100f1054; port for the rest]). It scores every candidate
   * in a +-p7 box on x / z (the current target too only when it is in the box) and takes the best
   * one seen through a clear line, the current target, or a p3 target with p5. Sight: within p7
   * (3D) inside the view cone p11 or within the always-see radius p9; no vertical limit.
   */
  private perceive(env: ActorEnv) {
    playerUidCache = env.playerUid;
    // A follower chooses targets only through the HostilityBehavior it waits with (FollowBehavior
    // p3 = 1); running to the leader that child is stopped (0x100ea6c0 / 0x100ea7a0) [verified].
    const fb = this.behavior?.kind === 'follow' ? this.behavior : undefined;
    if (fb && !this.grudge && (!fb.fights || (this.b.fol && this.b.fol.mode !== 'wait'))) {
      this.target = undefined;
      this.seesTarget = false;
      return;
    }
    const pos = this.motor.position;
    const eye = this.anchored ? this.height * 0.3 : Math.max(0.5, this.height * 0.85);
    // Hanging under a ceiling the head is low in the body (a crawler's ceiling clips hang from
    // the origin; looking from near the origin the ceiling's own beams hide everything).
    const ey = this.ceiling ? pos.y + this.hangBottom * this.scale * 0.6 : this.bottom + eye;
    const r = this.sightRules();
    const w = this.targetWeights();
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const inView = (x: number, y: number, z: number) => {
      const dx = x - pos.x, dy = y - ey, dz = z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      const h = Math.hypot(dx, dz);
      return inSight(r, d, h > 1e-3 ? (fx * dx + fz * dz) / Math.max(d, 1e-3) : 1);
    };
    // One ray in the original (vt 20 0x100f2570: eye to a quarter up the target's bounds); the
    // port tries head, chest and hips. Bars, grates, chain-link and glass don't block the view
    // (env.seeThrough). An object target's own body counts as reached, as for the shots
    // (seeThroughFor): 6a's guard 54b looks down on the propane tank 1432 he has to shoot, whose
    // centre lies 0.6 m inside its own collision, and never picked it.
    const clear = (x: number, y: number, z: number, t?: Target) => {
      if (!r.los) return true;
      const st = t ? this.seeThroughFor(env, t) : env.seeThrough;
      for (const drop of SIGHT_DROPS) if (!sightBlocked(env.world, pos.x, ey, pos.z, x, y - drop, z, 0.3, st)) return true;
      return false;
    };
    const aim = (t: Target) => (t.prop !== undefined ? this.aimPoint(env, t) : t.player ? { x: env.player.position.x, y: env.player.position.y + 1.5, z: env.player.position.z } : { x: t.actor!.position.x, y: t.actor!.bottom + t.actor!.height * 0.7, z: t.actor!.position.z });
    const feetDist = (t: Target) => {
      const p = t.prop !== undefined ? this.aimPoint(env, t) : t.player ? env.player.position : t.actor!.position;
      return Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z);
    };
    const kill = this.behavior?.kind === 'kill' ? this.behavior : this.profile.kill;
    const explicitHeld = (t: Target) => w.unseenExplicit && !!kill?.targets.some((u) => u > 0 && (t.player ? u === playerUidCache : t.prop !== undefined ? u === t.prop : u === t.actor!.uid));
    let cur = this.target;
    let due = false;
    if (cur && !this.targetAlive(cur, env)) (this.target = cur = undefined), (due = true);
    if (cur && feetDist(cur) > r.keep && !explicitHeld(cur)) (this.target = cur = undefined), (due = true);
    if (!cur) due ||= env.time >= this.searchAt;
    else due ||= env.time >= this.repickAt;
    if (due) {
      const had = this.target;
      this.chooseTarget(env, r, w, inView, clear, aim);
      // A choice with no target completes the KillEnemies (docs §15.15) [verified]: one a
      // Behavior Changer handed out ends, and its chain goes on (6a: the stranger's 142c ends
      // once the propane tank 1432 is gone; Relay 2330 hands him 225b, the next tank). The
      // character's own default one keeps searching (HostilityBehavior re-arms it).
      if (!this.target && this.behavior?.kind === 'kill' && this.behavior !== this.profile.active) this.killDone = true;
      if (!this.target) this.searchAt = env.time + this.searchInterval();
      else {
        // A fight starts: its re-pick interval is rolled once (KillEnemies init 0x100f7d40).
        if (!had) this.repickEvery = repickInterval(w, Math.random());
        this.repickAt = this.repickEvery < 0 ? Infinity : env.time + this.repickEvery;
      }
    }
    const t = this.target;
    if (!t) {
      this.seesTarget = false;
      return;
    }
    const a = aim(t);
    this.seesTarget = inView(a.x, a.y, a.z) && clear(a.x, a.y, a.z, t);
    // Seen, or kept unseen within the keep range: the actor goes on to where it is (KillObject
    // follows the target object itself).
    if (this.seesTarget || this.inCombat || this.behavior?.kind === 'follow') {
      const tp = this.targetPos(env);
      this.lastSeen.set(tp.x, tp.y, tp.z);
      this.lastSeenTime = env.time;
    }
  }

  /** The choice proper (0x100fbdd0 -> 0x100f9eb0 -> 0x100fa1f0), see perceive(). */
  private chooseTarget(env: ActorEnv, r: SightRules, w: TargetWeights, inView: (x: number, y: number, z: number) => boolean, clear: (x: number, y: number, z: number, t?: Target) => boolean, aim: (t: Target) => { x: number; y: number; z: number }) {
    const pos = this.motor.position;
    const inBox = (x: number, z: number) => Math.abs(x - pos.x) <= r.range && Math.abs(z - pos.z) <= r.range;
    const list: { t: Target; c: TargetCandidate; seen: boolean; explicit: boolean }[] = [];
    // Characters already attacking each candidate (KillObject running on it), this one not counted.
    const attackers = new Map<Actor | 'player' | number, number>();
    for (const o of env.actors) {
      if (o === this || !o.alive || !o.inCombat) continue;
      const ot = o.target;
      const key = ot?.player ? 'player' : ot?.actor ?? ot?.prop;
      if (key !== undefined) attackers.set(key, (attackers.get(key) ?? 0) + 1);
    }
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const add = (t: Target, f: { enemyTeam: boolean; explicit: boolean; targetsMe: boolean }, p: THREE.Vector3Like, key: Actor | 'player' | number, priority: number, maxAttackers: number, healthFrac: number) => {
      const current = this.isCurrent(t);
      const a = aim(t);
      const seen = inView(a.x, a.y, a.z);
      if (!current && !seen && !(f.explicit && w.unseenExplicit)) return;
      const dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      const by = (h: Actor | 'player') => h === key;
      list.push({
        t,
        seen,
        explicit: f.explicit,
        c: {
          ...f,
          current,
          dist: d,
          cos: d > 1e-3 ? (fx * dx + fz * dz) / d : 1,
          priority,
          healthFrac,
          attackers: attackers.get(key) ?? 0,
          maxAttackers,
          damageShare: damageShare(this.hurtLog, by, env.time, w.memory),
          failed: this.recentlyFailed(t, env),
        },
      });
    };
    if (env.playerAlive) {
      const p = env.player.position;
      const f = inBox(p.x, p.z) ? this.candidateOf('player') : undefined;
      const pp = env.playerTarget;
      if (f) add({ player: true }, f, p, 'player', pp?.priority ?? 0.5, pp?.maxAttackers ?? 4, pp?.healthFrac?.() ?? 1);
    }
    if (this.inCombat || this.hostile || this.behavior?.kind === 'follow') {
      for (const o of env.actors) {
        if (!inBox(o.position.x, o.position.z)) continue;
        const f = this.candidateOf(o);
        if (f) add({ actor: o }, f, o.position, o, o.profile.priority ?? 0.5, o.profile.maxAttackers ?? 4, o.maxHealth > 0 ? Math.max(0, o.health) / o.maxHealth : 1);
      }
    }
    // KillEnemies p3 lists level objects as well as characters: a target only needs to be a
    // GameObject that is not destroyed (the candidate test 0x100f9eb0 reads the team only of a
    // character, 0x100e1760, and takes the object's GameObject part, 0x100a2010) [strong: code
    // shape]. 3a: the Slayer 296e's KillEnemies 3ba8 lists the three fence Breakables 329c..329e
    // and no enemy team; it shoots them down and the Fence scene follows.
    const kb = this.behavior?.kind === 'kill' ? this.behavior : undefined;
    if (kb && env.propTarget) {
      for (const u of kb.targets) {
        if (u <= 0 || u === playerUidCache) continue;
        const o = env.propTarget(u);
        if (!o || !inBox(o.x, o.z)) continue;
        add({ prop: u }, { enemyTeam: false, explicit: true, targetsMe: false }, { x: o.x, y: o.bottom, z: o.z }, u, o.priority, o.maxAttackers, o.healthFrac);
      }
    }
    const scores = list.map((x) => targetScore(w, r.range, x.c));
    const i = chooseTarget(scores, (k) => {
      const x = list[k];
      if (x.c.current || (x.explicit && w.unseenExplicit)) return true;
      if (!x.seen) return false;
      const a = aim(x.t);
      return clear(a.x, a.y, a.z, x.t);
    });
    const pick = i >= 0 ? list[i].t : undefined;
    if (!pick) this.target = undefined;
    else if (!this.isCurrent(pick)) {
      this.target = pick;
      // "ISeeYou": KillEnemies' choice (0x100fa1f0) taking the player as a new target sends the
      // character event 0x200c (0x100fa30c..0x100fa361), whose handler fires the character's
      // output p31 (0x100e3fd4 -> 0x100e40ea) [verified]. 8b's Hermes copies need it: Relay 1f0d
      // takes their p31 (they take no damage), which plays "Hermes" 1f0f at the stove.
      if (pick.player) this.fireSlot31(env);
    }
  }

  private fireSlot31(env: ActorEnv) {
    const msg = this.entity?.values[31];
    if (typeof msg === 'number' && msg) this.fireLinks(env, msg);
  }

  /** KillEnemiesBehavior score weights (defaults: the retail creature values). */
  private targetWeights(): TargetWeights {
    const b = this.behavior;
    return (b?.kind === 'kill' ? b.weights : this.profile.kill?.weights) ?? DEFAULT_WEIGHTS;
  }

  /** Seconds before a search that found no target runs again (HostilityBehavior p3..p4). */
  private searchInterval(): number {
    const b = this.behavior;
    const retry = (b?.kind === 'hostile' ? b.retry : undefined) ?? this.profile.hostileRetry;
    return retry ? retry[0] + Math.random() * (retry[1] - retry[0]) : 0.5;
  }

  /** Sight rules of the behaviour that picks targets (defaults: no KillEnemiesBehavior). */
  private sightRules(): SightRules {
    const b = this.behavior;
    if (b?.kind === 'kill') return b;
    return this.profile.kill ?? DEFAULT_SIGHT;
  }

  // Targets given up on: MoveTo failed (KillEnemies 0x100fbbdf adds them to a recent-failure
  // list; they score -1000 for 5 x the re-evaluation interval).
  private failed: { t: Target; until: number }[] = [];
  private navStuck = 0;
  private legStuck = 0;

  private recentlyFailed(t: Target, env: ActorEnv) {
    this.failed = this.failed.filter((f) => f.until > env.time);
    return this.failed.some((f) => (t.player ? f.t.player : t.prop !== undefined ? f.t.prop === t.prop : f.t.actor === t.actor));
  }

  /**
   * MoveTo failed (stuck on the way): KillEnemies stops, idles, forgets the target and picks
   * again after its normal re-evaluation interval; the failed target ranks last for 5 x that
   * interval (still picked when it is the only one).
   */
  private giveUpTarget(env: ActorEnv) {
    const t = this.target;
    if (!t) return;
    // The fight's own re-pick interval (KillEnemies +0x36; 5 x it on the failure list).
    const interval = this.repickEvery;
    this.failed.push({ t, until: env.time + 5 * interval });
    this.target = undefined;
    this.seesTarget = false;
    this.path = [];
    this.pathGoal = -1;
    this.enterState('idle');
    this.thinkTimer = Math.max(0, interval);
    this.searchAt = env.time + Math.max(0, interval);
  }

  /**
   * Can-attack test per Attack (RFL 0x10080180 / 0x10080010): Attack p15 <= horizontal
   * distance minus the target's radius <= p16 (here `reach`; x the size scale when p14), and the height
   * difference within p17 when p17 > 0. CartWheelers' p17 is -1: no height limit [verified].
   */
  private pickAttack(surface: number, dy: number): KindAttack | undefined {
    if (!this.kind.attacks.length) return undefined;
    const ok = this.kind.attacks.filter((a) => {
      const sc = a.scaled ? this.scale : 1;
      return surface <= a.reach * sc && surface >= a.minReach * sc && (!a.maxDy || dy <= a.maxDy);
    });
    return ok.length ? ok[Math.floor(Math.random() * ok.length)] : undefined;
  }

  private startAttack(a: KindAttack) {
    this.attack = a;
    this.hitsDone = 0;
    // The clip's Arm windows and the weapon each one arms (by the event's bone).
    this.swing = undefined;
    const melee = this.profile.melee;
    if (melee?.length && a.windows?.length) {
      const bones = this.ch.skeleton.bones, hashes = this.kind.skinned.skeleton.bones;
      this.swing = [];
      for (const w of a.windows) {
        for (const weapon of melee) {
          const node = bones[weapon.bone];
          if (node && (hashes[weapon.bone]?.hash ?? 0) >>> 0 === w.bone) this.swing.push({ w, weapon, node, swept: false, hit: new Set() });
        }
      }
    }
    this.enterState('attack');
    this.play(a.clip, { loop: false, fade: 0.12 });
  }

  /**
   * The blow lands (clip hit marker): the start test again with a little slack for movement
   * during the swing. No facing or wall test (the original has no melee line of fire); the
   * height limit is Attack p17, else the bodies must overlap in height within 1.4 m [the hit
   * resolution itself is not decoded: guess].
   */
  private canHit(env: ActorEnv, a: KindAttack, t: Target) {
    const pos = this.motor.position, p = this.targetPos(env);
    const d = Math.hypot(p.x - pos.x, p.z - pos.z);
    const tr = this.targetRadius(t, env);
    if (d - tr > a.reach * (a.scaled ? this.scale : 1) + 0.6) return false;
    if (a.maxDy) return Math.abs((t.actor ? t.actor.position.y : p.y) - pos.y) <= a.maxDy + 0.3;
    const ty = t.prop !== undefined ? this.aimPoint(env, t).y : t.player ? p.y + 0.9 : t.actor!.bottom + t.actor!.height * 0.5;
    return this.verticalGap(ty) <= 1.4;
  }

  // --- movement --------------------------------------------------------------

  /** Walk towards a point: straight when clear, else along the Move Node graph. */
  private moveTo(x: number, y: number, z: number, dt: number, env: ActorEnv) {
    if (this.targetFrom.distanceToSquared({ x, y, z } as THREE.Vector3) > 0.25) this.forceNavUntil = 0;
    this.lastSeen.set(x, y, z);
    this.steer(env, dt, true);
  }

  /** Choose a steering direction towards lastSeen (direct / graph). */
  private steer(env: ActorEnv, dt: number, passive = false) {
    const pos = this.motor.position;
    let tx = this.lastSeen.x, tz = this.lastSeen.z;
    const nav = env.nav;
    // A walker with an NPC Exclusion Type keeps out of the areas of nodes barred to it: a straight
    // walk through one goes by the graph instead (NavGraph.crossesExcluded) [inferred].
    const navType = this.profile.navType;
    const barred = (x: number, z: number) => navType !== undefined && !!nav?.crossesExcluded(pos.x, pos.y, pos.z, x, z, navType);
    // ... and does not walk straight to a goal its type has no way to on the graph (2 Cellblocks:
    // the inmate stood by the player at the cell block's east door, past node 9bd, and had no
    // way on from there; kept back, he goes round through the cell e3 when the player moves on).
    if (navType !== undefined && nav?.size && env.time >= this.reachCheckAt) {
      this.reachCheckAt = env.time + 1;
      const a = nav.nearest(pos.x, pos.y, pos.z, env.world, 6, this.radius * 0.9);
      const b = nav.nearest(this.lastSeen.x, this.lastSeen.y, this.lastSeen.z, env.world);
      this.goalReachable = a < 0 || b < 0 || a === b || !!nav.path(a, b, undefined, { navType });
      this.shortcutBarred = shortcutBarred(nav, a, b, navType);
    }
    const direct =
      !barred(tx, tz) &&
      // A straight walk stands for the graph's own way there: when that way runs through a node
      // barred to the walker, it goes by its own way instead (2 Cellblocks: following the player
      // through door 85c, 4 m beside node 9bd, the companion walked into the steam-pipe yard his
      // type is kept out of, and the yard's Mainliners killed him) [inferred: MoveTo follows the
      // FindPath result, which leaves out barred nodes].
      !(navType !== undefined && this.shortcutBarred) &&
      // (A Waypoint leg the body walks straight is walked: waypointLegFails ends the others.)
      (navType === undefined || this.goalReachable || (passive && this.behavior?.kind === 'waypoint')) &&
      (passive
        ? clearLineCached(this, env, tx, this.lastSeen.y, tz)
        : // Seen through bars or glass is not a way through: walk straight only on a clear line.
          this.seesTarget && env.time >= this.forceNavUntil && (!env.seeThrough || clearLineCached(this, env, tx, this.lastSeen.y, tz)));
    const useNav = nav && nav.size && (!direct || env.time < this.forceNavUntil);
    if (useNav) {
      this.pathTimer -= dt;
      // Re-target when the goal moved; full replans are rare (graph search is the costly part).
      if (this.targetFrom.distanceToSquared(this.lastSeen) > 1.5 * 1.5) {
        this.targetFrom.copy(this.lastSeen);
        this.targetNode = nav.nearest(this.lastSeen.x, this.lastSeen.y, this.lastSeen.z, env.world);
        this.pathTimer = Math.min(this.pathTimer, 0.3);
      }
      // Passive walks to a fixed goal keep their path (replanning from the middle of a
      // staircase edge picks a poor start node); chases replan every few seconds.
      if (!this.path.length || this.pathGoal !== this.targetNode || (this.pathTimer <= 0 && !passive)) {
        this.pathGoal = this.targetNode;
        this.pathTimer = 2.5 + Math.random();
        // Start from a node the body fits through to (an open gate leaf can stand between it
        // and a node a thin ray still reaches).
        const a = nav.nearest(pos.x, pos.y, pos.z, env.world, 6, this.radius * 0.9);
        const blocked = env.navBlocked ? (i: number, j: number) => env.navBlocked!(i, j, this) : undefined;
        const found = nav.path(a, this.targetNode, blocked, { navType: this.profile.navType });
        // No way on the graph to a target out of straight reach: MoveTo fails, and the fight
        // drops the target, idles and picks again after its interval, the failed target last
        // (KillEnemies 0x100fbbdf) [inferred: a FindPath without a result is a MoveTo failure].
        // 3a's walkway CartWheelers that fell into the yard stood under the player in "chase"
        // for good (stuck-actor notes 15d7 / 1b5e).
        if (!found && !passive && this.target && a >= 0 && this.targetNode >= 0 && a !== this.targetNode) {
          this.giveUpTarget(env);
          return;
        }
        this.path = found ?? [];
        this.prevNode = -1;
        // Already between the first two nodes (e.g. halfway down a staircase edge): don't
        // walk back to the first one.
        if (this.path.length > 1) {
          const n0 = nav.nodes[this.path[0]], n1 = nav.nodes[this.path[1]];
          const seg = Math.hypot(n1.x - n0.x, n1.y - n0.y, n1.z - n0.z);
          // (Only with room to walk straight to the second one: a shelf can stand in between.)
          if (Math.hypot(n1.x - pos.x, n1.y - pos.y, n1.z - pos.z) < seg && !barred(n1.x, n1.z) && clearWide(env.world, pos.x, pos.y + 0.8, pos.z, n1.x, n1.y + 0.8, n1.z, this.radius * 0.9)) this.prevNode = this.path.shift()!;
        }
        if (!this.path.length) this.pathTimer = 1;
      }
      // Drop reached nodes and skip ahead to the farthest node in sight.
      while (this.path.length) {
        const n = nav.nodes[this.path[0]];
        if (Math.hypot(n.x - pos.x, n.z - pos.z) < Math.max(0.6, Math.min(n.radius, 1.5))) this.prevNode = this.path.shift()!;
        else break;
      }
      // A ladder on the next edge (an Edge Passage naming a Ladder): climb it.
      if (this.prevNode >= 0 && this.path.length && env.ladder && this.tryLadder(env, this.prevNode, this.path[0])) return;
      // A closed door on the next edge: open it first.
      if (this.prevNode >= 0 && this.path.length && this.tryDoor(env, this.prevNode, this.path[0])) return;
      if (this.path.length > 1 && !(env.closedDoor && env.closedDoor(this.path[0], this.path[1]) !== undefined)) {
        const n1 = nav.nodes[this.path[1]];
        // Only on level ground: a line down a staircase passes over the stairwell edge.
        if (Math.abs(n1.y - pos.y) < 0.6 && !barred(n1.x, n1.z) && clearWide(env.world, pos.x, pos.y + 0.8, pos.z, n1.x, n1.y + 0.8, n1.z, this.radius * 0.9)) this.prevNode = this.path.shift()!;
      }
      if (this.path.length) {
        const n = nav.nodes[this.path[0]];
        tx = n.x;
        tz = n.z;
      } else if (navType !== undefined && !this.goalReachable) {
        // No way for this walker's type: it stays where it is (see goalReachable above).
        tx = pos.x;
        tz = pos.z;
      }
    }
    const dx = tx - pos.x, dz = tz - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.4) {
      if (!passive) {
        const p = this.targetPos(env);
        this.faceTowards(p.x - pos.x, p.z - pos.z, dt, TURN_RATE);
      }
      return;
    }
    const err = this.faceTowards(dx, dz, dt, TURN_RATE);
    // Move along the facing direction once roughly aligned (no moonwalking).
    const k = Math.max(0, Math.cos(err));
    this.wish.set(-Math.sin(this.yaw) * k, -Math.cos(this.yaw) * k);

    // Stuck against something while moving directly: route through the graph for a while.
    this.stuckTimer += dt;
    if (this.stuckTimer > 1.5) {
      const moved = Math.hypot(pos.x - this.stuckFrom.x, pos.z - this.stuckFrom.z);
      if (moved < 0.4 && nav?.size) {
        // Stuck against a closed door whose edge the goal lies on: open it (doorInTheWay).
        if (passive && this.doorInTheWay(env)) {
          this.stuckTimer = 0;
          this.stuckFrom.set(pos.x, pos.y, pos.z);
          return;
        }
        // Stuck on the graph route as well: the move failed. Hunting, the actor gives up on
        // its target for a while (giveUpTarget); the route is planned afresh either way.
        if (useNav && ++this.navStuck >= 2 && !passive && this.target) {
          this.navStuck = 0;
          this.giveUpTarget(env);
        }
        // A Waypoint leg the body stays stuck on (three checks, 4.5 s) is a MoveTo that failed:
        // it ends the WaypointBehavior (waypointLegFails) [inferred]. 6a's Slayer 2337 (its 3 m
        // stack) walked the Move Node edge 1c5d -> c2a under a log 1.5 m up for good.
        if (passive && this.behavior?.kind === 'waypoint' && this.b.wp && ++this.legStuck >= 3) {
          this.legStuck = 0;
          this.b.leg = { wp: this.b.wp, at: env.time, ok: false };
        }
        this.forceNavUntil = env.time + 4;
        this.path = [];
        this.pathGoal = -1;
      } else this.navStuck = this.legStuck = 0;
      this.stuckTimer = 0;
      this.stuckFrom.set(pos.x, pos.y, pos.z);
    }
  }

  /**
   * A passive walk (a Waypoint leg, a talk's approach) stuck against a closed door on the Move
   * Node edge its goal lies on opens it [port]. The original's path following pushes OpenDoor
   * when the path crosses a door edge (0x1010ee84 -> 0x1010b200, docs/game-logic.md §15.5); a goal
   * placed in the doorway itself has its nearest node on the walker's side, so the path is that
   * node alone and no door edge is crossed: 1a's second ambush CartWheeler 64f1 (Behavior Changer
   * 8026 -> WaypointBehavior 8027) walks to Waypoint 8025 inside door 4e48 and stood against the
   * shut leaf, 0.51 m short of it (its Collider radius 0.4); the leg then failed (legStuck), it
   * idled behind the door, Count Down 73a5 never reached zero and the guard 609e never went on to
   * the door controls (Timer 7532 -> Behavior Changer 7527). The goal counts as on the edge within
   * 1 m of the segment, from a quarter of the way to the door's far node on.
   */
  private doorInTheWay(env: ActorEnv): boolean {
    const nav = env.nav;
    if (!nav?.size || !env.closedDoor || this.profile.openDoor === null) return false;
    const pos = this.motor.position;
    const a = nav.nearest(pos.x, pos.y, pos.z, env.world, 6, this.radius * 0.9);
    if (a < 0) return false;
    const na = nav.nodes[a];
    for (const b of na.edges) {
      // (A door the walker may not pass, locked or not its kind, stays shut: system.ts navBlocked.)
      if (env.closedDoor(a, b) === undefined || env.navBlocked?.(a, b, this)) continue;
      const nb = nav.nodes[b];
      if (!goalOnEdge(na, nb, this.lastSeen)) continue;
      if (this.tryDoor(env, a, b)) return true;
    }
    return false;
  }

  private facingErr(dx: number, dz: number) {
    return Math.abs(wrap(Math.atan2(-dx, -dz) - this.yaw));
  }

  /** Turn towards a direction; returns the remaining angle error. */
  private faceTowards(dx: number, dz: number, dt: number, rate: number): number {
    if (Math.hypot(dx, dz) < 1e-3) return 0;
    const want = Math.atan2(-dx, -dz);
    let err = wrap(want - this.yaw);
    const stepA = rate * dt;
    this.yaw = wrap(this.yaw + Math.max(-stepA, Math.min(stepA, err)));
    err = wrap(want - this.yaw);
    return err;
  }

  private step(dt: number, wx: number, wz: number) {
    const l = Math.hypot(wx, wz);
    if (l > 1) (wx /= l), (wz /= l);
    // Gait: > 1.3 runs. A Waypoint run (WAYPOINT_RUN) moves at the run clip's own root speed, as
    // the engine's locomotion does (the 1a / 1b vision creatures sprint past at 9.3 m/s); other
    // runs keep the capped chase speed.
    const g = this.state === 'move' ? this.gait : 1;
    const natural = g >= WAYPOINT_RUN && this.kind.run >= 0 ? this.kind.speeds[this.kind.run] || 0 : 0;
    const base = this.state === 'chase' || g > 1.3 ? Math.max(this.kind.runSpeed, natural) : this.kind.moveSpeed;
    const sp = base * (g > 1.3 ? 1 : Math.max(0.3, Math.min(2.2, g)));
    if (this.motor.cfg.walkSpeed !== sp) this.motor.cfg.walkSpeed = this.motor.cfg.runSpeed = sp;
    const steps = Math.min(3, Math.max(1, Math.ceil(dt / (1 / 28))));
    for (let i = 0; i < steps; i++) this.motor.step(dt / steps, { wishX: wx, wishZ: wz, run: false, crouch: false, jump: false });
  }

  /** Root motion of a behaviour clip (m/s in character space) applied through the motor. */
  private stepRoot(dt: number, m: [number, number]) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // Character space: -Z forward; rotate by yaw into world space.
    const vx = m[0] * c + m[1] * s, vz = -m[0] * s + m[1] * c;
    const sp = Math.hypot(vx, vz);
    if (sp < 0.05) return this.step(dt, 0, 0);
    const keep = this.motor.cfg.walkSpeed;
    this.motor.cfg.walkSpeed = this.motor.cfg.runSpeed = sp;
    const steps = Math.min(3, Math.max(1, Math.ceil(dt / (1 / 28))));
    for (let i = 0; i < steps; i++) this.motor.step(dt / steps, { wishX: vx / sp, wishZ: vz / sp, run: false, crouch: false, jump: false });
    this.motor.cfg.walkSpeed = this.motor.cfg.runSpeed = keep;
  }

  private updateLocomotion() {
    if (this.state !== 'chase' && this.state !== 'idle' && this.state !== 'move') return;
    const v = this.motor.velocity;
    const speed = Math.hypot(v.x, v.z);
    const fast = this.state === 'chase' || this.gait > 1.3;
    const g = this.gaitClips;
    const walk = g && (fast ? g.run : g.walk) >= 0 ? (fast ? g.run : g.walk) : fast && this.kind.run >= 0 ? this.kind.run : this.kind.walk;
    if (speed > 0.35 && walk >= 0) {
      const natural = this.kind.speeds[walk] || 1;
      const ts = Math.min(1.8, Math.max(0.5, speed / natural));
      const a = this.play(walk, { loop: true, fade: 0.2 });
      if (a) a.timeScale = ts * (this.ch.clipData[walk].rate || 1);
    } else if (!this.heldPose) {
      this.play(this.idleClip, { loop: true, fade: 0.25 });
    }
  }

  private playClipSounds(env: ActorEnv) {
    if (this.anim < 0 || !this.action || !this.drawn) return;
    const cues = this.kind.events[this.anim]?.sounds;
    if (!cues?.length) return;
    if (this.action.loop !== THREE.LoopOnce) return this.playLoopCues(env, cues);
    const t = this.action.time;
    while (this.soundsDone < cues.length && t >= cues[this.soundsDone].time) {
      env.sound(cues[this.soundsDone].keys, { x: this.position.x, y: this.bottom + this.height * 0.7, z: this.position.z }, undefined, this);
      this.soundsDone++;
    }
  }

  /**
   * Sound cues of a looping clip (the vision creatures' run 2:137 growls from its pool 2:227..232
   * every cycle) as the engine fires them (docs/re/animation.md §7, type 5): a cue fires when the
   * clip time crosses it, wrapping at the loop; a pool cue (param 0) never repeats the previous
   * pick; a cue is not restarted while its sound still plays.
   */
  private playLoopCues(env: ActorEnv, cues: { time: number; keys: string[] }[]) {
    const a = this.action!;
    const t1 = a.time;
    const dur = a.getClip().duration || 1;
    // A clip just switched to starts at 0.
    const t0 = this.loopCueAnim === this.anim && this.loopCueT >= 0 ? this.loopCueT : 0;
    this.loopCueAnim = this.anim;
    this.loopCueT = t1;
    if (t1 === t0 || a.timeScale === 0 || a.paused) return;
    for (const c of cues) {
      if (!loopEventCrossed(Math.min(c.time, dur - 1e-4), t0, t1)) continue;
      if (this.loopCueSound?.playing) continue;
      const pool = c.keys.length > 1 && this.loopCueLast ? c.keys.filter((k) => k !== this.loopCueLast) : c.keys;
      const key = pool[Math.floor(Math.random() * pool.length)];
      const h = env.sound([key], { x: this.position.x, y: this.bottom + this.height * 0.7, z: this.position.z }, undefined, this);
      if (h) this.loopCueSound = h;
      this.loopCueLast = key;
    }
  }

  sync(rot = true) {
    const p = this.motor.position;
    this.ch.root.position.set(p.x, p.y, p.z);
    if (rot) this.ch.root.rotation.set(0, this.yaw, 0, 'YXZ');
  }

  // ---------------------------------------------------------------------------
  // Save state (src/game/save/providers.ts 'actors' provider)

  /**
   * Everything needed to put this actor back: placement, health, alive / dead, dormancy,
   * visibility, hostility and the placed behaviour it runs. Spawned actors also carry what
   * re-creates them (`clone`: the Object Cloner template uid; `template`: the template ref
   * of a services.actors.spawn creature). The AI's momentary state (target, path) is not
   * kept: only 'fall' survives, everything else resumes from idle and re-acquires targets.
   * The behaviour's progress is kept (`bp`, timers relative to `now`, the actors' clock).
   */
  getState(now = 0): ActorSaveState {
    const p = this.position;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
      u: this.uid,
      clone: this.spawned && this.entity ? this.entity.uid : undefined,
      t: this.spawned && !this.entity ? this.kind.template : undefined,
      // Killed during a sequence (death deferred to the hand-back): saved dead.
      alive: this.alive && !this.deathDeferred,
      h: this.health,
      p: [r3(p.x), r3(p.y), r3(p.z)],
      yaw: r3(this.yaw),
      st: this.state,
      hostile: this.hostile,
      provoked: this.provoked,
      inv: this.invulnerable,
      vis: this.ch.root.visible,
      dh: this.dormantHidden,
      ceil: this.ceiling,
      dw: this.dropOnWake,
      di: this.dormantIdle,
      ground: this.motor.onGround,
      np: this.needsPlacement,
      b: this.behavior?.uid,
      bt: this.behavior && this.behavior.uid === undefined ? templateSlot(this.profile, this.behavior) : undefined,
      bp: this.alive ? behaviorProgress(this.behavior?.kind, this.b, now) : undefined,
    };
  }

  /**
   * The behaviour of a restored save has started (setBehavior): put its saved progress back
   * (once; a different behaviour by then drops it).
   */
  resumeSaved(env: ActorEnv) {
    const p = this.savedProgress;
    this.savedProgress = undefined;
    resumeProgress(this.behavior?.kind, this.b, p, env.time);
  }

  /** Apply a getState() record (same actor, or a freshly re-created clone / spawn). */
  setState(r: ActorSaveState, env: ActorEnv | null) {
    this.motor.position.x = r.p[0];
    this.motor.position.y = r.p[1];
    this.motor.position.z = r.p[2];
    this.motor.velocity.x = this.motor.velocity.y = this.motor.velocity.z = 0;
    this.motor.onGround = r.ground;
    this.yaw = r.yaw;
    this.hostile = r.hostile;
    this.provoked = r.provoked;
    this.invulnerable = !!r.inv;
    this.needsPlacement = r.np;
    this.ceiling = r.ceil;
    this.dormantHidden = r.dh;
    this.dropOnWake = r.dw;
    this.ch.root.visible = r.vis;
    this.rootShown = r.vis;
    if (this.scripted) this.scripted = false;
    this.target = undefined;
    this.grudge = undefined;
    this.investigating = undefined;
    this.pendingWakeClip = undefined;
    this.pendingRoot = undefined;
    this.deathDeferred = false;
    this.wakingUntil = 0;
    this.shot = undefined;
    this.shotCooldown = 1 + Math.random() * 2;
    this.ch.releaseLayers(0);
    if (!r.alive) {
      if (this.alive && env) this.dieSilently(env);
      // Applied before the level's first frame (no env yet): it must not come back to life
      // in its first-frame init (a guard killed by a script stood again after loading).
      else if (this.alive) this.pendingDeath = true;
      this.health = 0;
    } else {
      this.pendingDeath = false;
      this.maxHealth = Math.max(this.maxHealth, r.h);
      this.health = r.h;
      // A save is often applied before the restored level's first frame (no env yet): keep
      // the first-frame init then, which starts the behaviour and its pose (1a: the stabbed
      // inmate's IdleBehavior holds him lying on his bed; without it he stood in front of
      // it after loading). With an env, a not yet initialised actor starts its behaviour here.
      const fresh = this.needsInit;
      this.needsInit = fresh && !env;
      const beh = r.b !== undefined && env?.behaviors ? env.behaviors.fromPlaced(r.b) : r.bt ? this.profile[r.bt] : undefined;
      if (beh && !env && fresh) this.behavior = beh;
      this.restoredPlaced = !env && fresh && r.b !== undefined ? r.b : undefined;
      this.savedProgress = r.bp;
      if (beh && env && (beh !== this.behavior || fresh)) {
        // Without the wake-up side effects (falling from the ceiling, revealing): those
        // flags come from the record.
        this.ceiling = this.dropOnWake = false;
        this.setBehavior(beh, env);
        this.ceiling = r.ceil;
        this.dropOnWake = r.dw;
      }
      // With an env the behaviour runs now; else ActorManager.init starts it and resumes it.
      if (env) this.resumeSaved(env);
      const wantIdle = r.di >= 0 ? r.di : -1;
      if (wantIdle !== this.dormantIdle) {
        this.dormantIdle = wantIdle;
        this.play(wantIdle >= 0 ? wantIdle : this.kind.idle, { loop: true, fade: 0 });
      }
      this.dormantHidden = r.dh;
      if (r.st === 'fall' && this.state !== 'fall') this.enterState('fall');
      else if (r.st !== 'fall' && this.state !== 'idle') this.enterState('idle');
    }
    this.sync();
  }

  /** Dead from a save: the death pose played to its end, without the death outputs / sounds. */
  dieSilently(env: ActorEnv) {
    this.pendingDeath = false;
    if (!this.alive) return;
    this.die({ ...env, onDeath: () => {} });
    this.soundsDone = 1e9;
    this.animate(30);
  }

  snapshot() {
    const p = this.position;
    return {
      x: +p.x.toFixed(3),
      y: +p.y.toFixed(3),
      z: +p.z.toFixed(3),
      yaw: +this.yaw.toFixed(3),
      health: this.health,
      dead: !this.alive,
      hidden: this.dormantHidden,
      visible: this.ch.root.visible,
      behavior: this.behavior?.uid,
      provoked: this.provoked,
    };
  }

  dispose() {
    this.ch.dispose();
  }
}

let playerUidCache = 0;

/** Cheap per-frame line test for passive walking (cached for a few frames). */
const lineCache = new WeakMap<Actor, { t: number; x: number; z: number; ok: boolean }>();
function clearLineCached(a: Actor, env: ActorEnv, x: number, y: number, z: number) {
  const c = lineCache.get(a);
  if (c && env.time - c.t < 0.3 && Math.abs(c.x - x) + Math.abs(c.z - z) < 0.5) return c.ok;
  const p = a.position;
  // The body, not a thin ray: a sphere swept at hip and at chest height (a bench seat or a rail
  // between two rays stopped 1c's inmate walking straight at it for good).
  const r = a.radius * 0.9;
  const hi = Math.min(1.35, a.height * 0.7);
  const ok =
    Math.abs(y - p.y) < 1.5 &&
    clearWide(env.world, p.x, p.y + 0.8, p.z, x, y + 0.8, z, r) &&
    clearWide(env.world, p.x, p.y + hi, p.z, x, y + hi, z, r);
  lineCache.set(a, { t: env.time, x, z, ok });
  return ok;
}

/**
 * The death picker's blow angle (degrees, Character death 0x100e5d00) [verified]: acos of the
 * body's +Z axis (yaw, times its scale) . the unit direction from the attacker to the body
 * (`toVictim`); a zero direction counts as straight down; no attacker leaves the zero vector
 * (90). Past +-1 (a scaled body) acos is NaN and deathPick takes the first entry.
 */
export function deathAngle(yaw: number, scale: number, toVictim?: { x: number; y: number; z: number }): number {
  let nx = 0, nz = 0;
  if (toVictim) {
    const l = Math.hypot(toVictim.x, toVictim.y, toVictim.z);
    if (l > 1e-6) {
      nx = toVictim.x / l;
      nz = toVictim.z / l;
    }
  }
  return (Math.acos((Math.sin(yaw) * nx + Math.cos(yaw) * nz) * scale) * 180) / Math.PI;
}

/** The first DeathBehavior whose p4 is above the blow angle, else the first (0x100e6340). */
export function deathPick(angles: readonly number[], theta: number): number {
  for (let i = 0; i < angles.length; i++) if (theta < angles[i]) return i;
  return 0;
}

/**
 * A goal on the Move Node edge a -> b (actor.ts doorInTheWay): within 1 m of the segment and at
 * least a quarter of the way from a to b (a goal well on the walker's side is not behind the
 * door). Horizontal.
 */
export function goalOnEdge(a: { x: number; z: number }, b: { x: number; z: number }, g: { x: number; z: number }): boolean {
  const ex = b.x - a.x, ez = b.z - a.z;
  const l2 = ex * ex + ez * ez;
  if (l2 < 1e-6) return false;
  const t = ((g.x - a.x) * ex + (g.z - a.z) * ez) / l2;
  if (t < 0.25) return false;
  const k = Math.min(1, t);
  return Math.hypot(a.x + ex * k - g.x, a.z + ez * k - g.z) <= 1;
}

/**
 * An NPC bullet with a spread cone of `coneDeg` degrees (Ranged Weapon p75 x Attack p19): the
 * deviation is `u1` x the cone, the roll `u2` x 2 pi (0x10127b30) [verified]; it meets a body of
 * this radius / half height at `dist` m when the deflected point stays inside it [port test].
 */
export function spreadShotHits(coneDeg: number, dist: number, radius: number, half: number, u1: number, u2: number): boolean {
  const off = dist * Math.tan((u1 * coneDeg * Math.PI) / 180);
  const roll = u2 * 2 * Math.PI;
  return Math.abs(off * Math.cos(roll)) <= radius && Math.abs(off * Math.sin(roll)) <= half;
}

/**
 * Where that deflected round passes the aim point's distance (the same u1 / u2 as
 * spreadShotHits): the aim point moved sideways by off cos(roll) and up by off sin(roll).
 */
export function spreadShotPoint(muzzle: THREE.Vector3Like, aim: THREE.Vector3Like, coneDeg: number, dist: number, u1: number, u2: number): THREE.Vector3Like {
  const off = dist * Math.tan((u1 * coneDeg * Math.PI) / 180);
  const roll = u2 * 2 * Math.PI;
  const dx = aim.x - muzzle.x, dz = aim.z - muzzle.z;
  const l = Math.hypot(dx, dz) || 1;
  const sx = -dz / l, sz = dx / l;
  const h = off * Math.cos(roll), v = off * Math.sin(roll);
  return { x: aim.x + sx * h, y: aim.y + v, z: aim.z + sz * h };
}

/** Horizontal root velocity of a clip (m/s, character space) when it travels noticeably. */
function rootMoveOf(a: Actor, clip: number): [number, number] | undefined {
  const d = a.ch.clipData[clip];
  if (!d) return undefined;
  const t = d.tracks.find((x) => x.translations && a.kind.skinned.skeleton.bones[a.kind.skinned.skeleton.byHash.get(x.boneHash) ?? -1]?.parent === -1);
  if (!t?.translations || t.times.length < 2) return undefined;
  const v = t.translations, e = v.length - 3;
  const dx = v[e] - v[0], dz = v[e + 2] - v[2];
  const dur = Math.max(1e-3, d.duration / (d.rate || 1));
  if (Math.hypot(dx, dz) < 0.3) return undefined;
  return [(dx / dur) * a.scale, (dz / dur) * a.scale];
}

/** Whole root translation of a clip (world space for the actor's yaw, scaled). */
function rootDeltaOf(a: Actor, clip: number): THREE.Vector3 {
  const out = new THREE.Vector3();
  const d = a.ch.clipData[clip];
  const t = d?.tracks.find((x) => x.translations && a.kind.skinned.skeleton.bones[a.kind.skinned.skeleton.byHash.get(x.boneHash) ?? -1]?.parent === -1);
  if (!t?.translations || t.times.length < 2) return out;
  const v = t.translations, e = v.length - 3;
  const mx = (v[e] - v[0]) * a.scale, my = (v[e + 1] - v[1]) * a.scale, mz = (v[e + 2] - v[2]) * a.scale;
  // Character space (-Z forward) rotated by the yaw, as stepRoot.
  const s = Math.sin(a.yaw), c = Math.cos(a.yaw);
  return out.set(mx * c + mz * s, my, -mx * s + mz * c);
}

function templateSlot(p: ActorProfile, b: Behavior): 'active' | 'provoked' | 'kill' | undefined {
  return b === p.active ? 'active' : b === p.provoked ? 'provoked' : b === p.kill ? 'kill' : undefined;
}

function idleOf(b: Behavior | undefined): Behavior {
  return { cls: 'IdleBehavior', kind: 'idle', next: [], fidgets: [], fidgetMin: 4, fidgetMax: 12, pos: b?.pos };
}

function outPos(e: Entity): [number, number, number] {
  return [e.position[0] / 2048, e.position[1] / 2048, e.position[2] / 2048];
}

/** Hit spheres standing in for a body without a sphere tree: a stack along its capsule. */
function bodySpheres(v: Actor | 'player', env: ActorEnv): HitSphereLike[] {
  const p = v === 'player' ? env.player.position : v.position;
  const r = v === 'player' ? 0.35 : v.radius;
  const y0 = v === 'player' ? p.y : v.bottom, h = v === 'player' ? 1.8 : v.height;
  const out: HitSphereLike[] = [];
  for (let y = y0 + r; y <= y0 + h - r + 1e-6; y += r) out.push({ c: [p.x, y, p.z], r });
  return out.length ? out : [{ c: [p.x, y0 + h / 2, p.z], r: Math.max(r, h / 2) }];
}

function rand(a: number, b: number) {
  return a + Math.random() * Math.max(0, b - a);
}

/**
 * Ground below a feet position: distance (negative when the feet are slightly sunk), null if
 * none within maxDrop. A surface just above the feet (bunk, table the creature lies under)
 * doesn't count when there is floor right at the feet; with nothing under the feet it is the
 * floor the feet are sunk in (9's Inferna c9c is placed 0.2 m under the terrain: it read as a
 * drop-in with no ground and was hidden until woken). Movers pass Decorations, so this does too.
 */
function groundGap(world: CollisionWorld, x: number, y: number, z: number, maxDrop: number): number | null {
  const prev = world.queryLayers;
  world.queryLayers = prev & ~COLLISION_LAYER.decor;
  try {
    const lift = 0.5;
    const hit = world.raycast(x, y + lift, z, 0, -1, 0, maxDrop + lift);
    const gap = hit ? hit.distance - lift : null;
    if (gap !== null && gap < -0.02) {
      const low = world.raycast(x, y + 0.05, z, 0, -1, 0, maxDrop + 0.05);
      const lowGap = low ? low.distance - 0.05 : null;
      if (lowGap === null) return gap;
      if (lowGap < 0.3) return lowGap;
    }
    return gap;
  } finally {
    world.queryLayers = prev;
  }
}

function wrap(a: number) {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

function readHealth(e?: Entity): number | undefined {
  const h = e?.values[1] ?? e?.values[0];
  return typeof h === 'number' && h > 0 && h < 1e5 ? h : undefined;
}
