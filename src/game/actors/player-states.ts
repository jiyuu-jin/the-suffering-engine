// The player's clip-driven states that the port used to fake or skip (docs/game-logic.md §14.1
// "Player hit reactions", "Third-person jump and landing"; docs/re/animation.md §4): Hit
// Reacting (Player state 17), the third-person Jump (8) and Landing (12). Each moves the player
// by its clip's root, through the motor like the melee lunge (weapons/melee-lunge.ts).
//
// Decoded from Suffering.rfl [verified unless marked]:
//
// Hit Reacting (17): requested only by the Player's damage override 0x1002e000 (Player vtable
// slot 38; the one request of state 17 in the code):
//   * After the GameObject damage (0x100a31b0, whatever the amount), the gate 0x1002ede0 picks a
//     reaction with the record's raw impact force (+0x1c) and its Special Hit Reaction (+0x48)
//     through the same picker as characters (0x1009e650, actors/hit-react.ts) over the Player's
//     own lists: p89 by force, p90 by special. The entries are "Hit Reaction" templates (class
//     0x06163ac3), laid out like HitReactBehavior shifted by two: p0 attacks, p1 the Special Hit
//     Reaction, p2 the least force, p3 "also in first person", p4 clips (one at random), p5 the
//     clip of a hit taken in the air, p6 the fall pose, p7 the floor clip (Landing), p8 the death
//     clip while down, p9 the cooldown. A special entry wins whatever the force; otherwise the
//     LAST entry with p2 <= force; below the first entry nothing plays.
//   * The gate refuses: no entry; within the cooldown (+0x620 = the last reaction's p9, counted
//     down every frame in 0x10043fea) a force below the last reaction's p2 (+0x624); while
//     rolling (state 15) a clip with root motion; in first person (state 16) an entry with p3 = 0.
//   * Then, with state 17 already on, only a force ABOVE the running entry's p2 restarts it
//     (0x1002e255). The force is the record's x the matching Damage Resistance's p2, and that
//     resistance's p5 replaces the special (0x1002e27f: the player's p7 list is empty, so only
//     the global types 14 / 6 zero it). The picked template goes to +0x410, the attacker (the
//     record's +0x24, or +0x26 for explosions) to +0x35e, and state 17 is requested.
//   * The state transition table (0x10175150, entry [new x 35 + old]) refuses 17 during the
//     death state 0, Controlled 11 (the Mainliner's ride 0x1007e354, the Nooseman's grip), Landing
//     12, Jump Melee 14, Morph 19, Interact 22, View Monitor 23, Item Pickup 26, LadderClimb 27,
//     Insanity Attack Acquisition 30, Document View 31, Freak Out 34; it ENDS Move, Attack,
//     MeleeAttack, Turn, Idle, Pitch, Roll, FIRST PERSON, Reload, Throw, Camera Yaw, Equip, Look
//     At, Insanity Attack, FP Melee and Play Anim; it runs beside Aim, Jump, Fall, Jump Attack and
//     Insanity. While 17 runs nothing of Move, Aim, Attack, MeleeAttack, Turn, Idle, Jump, Pitch,
//     Roll, First Person, Reload, Throw, Equip or FP Melee can start: no walking, looking,
//     shooting, striking, jumping or weapon change. Controlled, Morph, Play Anim, Freak Out and
//     Insanity Attack Acquisition end it. First person comes back by itself afterwards (the
//     wanted-first-person bit +0x98 0x8000 stays set; the input handler 0x100499fb requests
//     state 16 every frame, refused until 17 is over).
//   * Enter 0x1002ef40: stores p2 (+0x624) and picks a clip of p4 (+0x414). In the air (+0x98
//     bit 0 clear) with no p7: the p5 clip on bone Player p109 (5, the spine) as an independent
//     layer (+0x98 |= 0x10000), the state ends when that layer's clip ends (0x1002f1fd) and the
//     layer goes back to the body's clip (leave 0x1002ec60). Otherwise: the body turns 30 % of the
//     way toward the attacker (matrix slerp 0x1000d4c0 with 0.3) unless the clip playing has root
//     motion, the p4 clip plays on the whole body with no blend (0x1004cb20 blend 0, speed 1), and
//     root extraction is on (animator vt+0x70). Per frame (0x1002f1d0): the 30 % turn again while
//     the clip has no root motion and neither Fall nor Landing runs; extraction on; when the clip
//     ends: in Fall, p6 plays; otherwise p7 set -> Landing (12), whose enter plays p7 with root
//     extraction (0x1003bb33); else state 17 ends. Landing leave (0x1003c001) ends 17 too.
//   * Knocked off a ledge: Fall enter (0x1003b81e) with 17 on plays p6 (Player p115 set) and
//     zeroes the fall velocity: the player drops straight down; the root is no longer extracted
//     (Fall enter turns extraction off and the lock on).
//   * Dying with 17 on (death state 0 enter 0x1002e7d8): p8 instead of the Player's p84 clips
//     (the killer-class clips p330..p339 come first).
//   * Leave: +0x620 = p9.
//   * Retail data: Player 2:5 p89 = 2:332 (force 7: clip 2:126, 0.5 s, in place, cooldown 1.2 s),
//     2:333 (10: 2:138, 1.87 s, in place, 1.5 s), 2:334 (17, first person too: 2:128 three metres
//     back in 0.53 s, fall pose 2:129, floor 2:130 0.55 m back then up, 1.44 s at its rate 1.5,
//     death 2:131, 0.5 s); p90 = 2:835 (Special Hit Reaction 2:736, carried by Radius Damage
//     p4: 2:672, 1.6 s, in place, 1 s). The creature form 2:240 has no list: no reactions.
//     Every reaction is the same for every weapon held and only 2:334 plays in first person.
//
// Jump (8), third person [Jump enter 0x1003adf0, per frame 0x1003b210, leave 0x1003b520]:
//   * The stick (camera-relative) against the body's forward: magnitude < 0.2 -> standing jump
//     PWP p151; within p168 = 45 deg -> forward jump p152; beyond p169 = 135 deg -> backward
//     jump p153 (the body turns AWAY from the stick, so the clip's backward root goes the stick's
//     way); between -> Roll (state 15, toward the stick side, Roll enter 0x1003aa3c).
//   * The forward / backward jump turns the body to the stick (pending matrix 0x1000d070).
//   * Root scales: y = the jump power (+0x68), z = (1 + power) / 2 x max(stick, 0.3) (+0x6c);
//     the power (0x1003a590) is always 1 with p211 = 100. Speed 1 + (1 - power) / 2 = 1.
//   * Extraction on, lock off: the clip's root carries x, y and z. Retail clips (every human
//     set): 2:87 standing (apex 1.52 m at 0.54 s, 0.9 s, ends 0.27 m up), 2:86 forward (4.21 m
//     forward, apex 1.90 m, 0.73 s, ends 1.35 m up), 2:85 backward (5.22 m back, apex 1.91 m,
//     0.9 s, ends on the ground).
//   * Per frame: air steering (0x1003a6e0) adds rate x the stick's world direction x dt:
//     standing p207 = 3, a mostly sideways stick p208 = 3, along the jump p205 = 1, against it
//     p206 = 7 (first person p216). During the first 0.2 s of a standing jump a sideways stick
//     becomes a Roll. When the clip ends: Fall, with the root's last velocity (+0x15a, the
//     animator's root delta / dt), kept through the fall (no air control without the
//     first-person jump flag).
//   * Move cannot start while Jump or Landing runs ([1][8] = [1][12] = 0); Aim, Attack, Turn and
//     Pitch can (look and shoot in the air; turning turns the body and the jump with it).
//
// Landing (12) [enter 0x1003b990, per frame 0x1003bce0, leave 0x1003bfc0]:
//   * Fall damage first (0x1002db30, by height: player-rules.ts). The clip of the held PWP by
//     the fall's horizontal velocity against the body's forward: none p158 (2:91, 0.2 s), forward
//     p160 (2:89, 0.1 s, 0.4 m forward root), backward p162 (2:88, 0.1 s); +1 (p159 / p161 /
//     p163, the same clips in retail) when the fall did damage. First person: no clip, the state
//     ends at once. Ends with its clip; then the stance idle p13.
//
// Port mapping [port]: the motor moves the feet (rootMove x / y / z through physics.ts
// MotorInput.moveX / moveY / moveZ, `fly` while a jump clip carries y); the body plays the clips
// in place (PlayerBody.play inPlace); the 30 % turn per frame is taken at 30 frames per second
// [inferred]; a landing clip plays only after at least LAND_MIN_AIR s in the air (the port's
// motor leaves the ground for single frames on steps); blows whose force the port does not know
// (sources not yet decoded) play no reaction.

import type { PlayerController, PlayerFrame } from '../../app/player';
import type { AnimClipData } from '../../formats/animation';
import { sampleTrackTranslation } from '../../formats/animation';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { FALL_DAMAGE_MIN } from '../../app/player-rules';
import { lungeToWorld } from '../weapons/melee-lunge';

// ---------------------------------------------------------------------------------------
// Data

/** A Player "Hit Reaction" template (class 0x06163ac3). */
export interface PlayerHitReaction {
  ref: ResRef;
  /** p0: attack templates that pick this entry. */
  attacks: ResRef[];
  /** p1: the Special Hit Reaction that picks it, whatever the force. */
  special?: ResRef;
  /** p2: the least impact force of the band. */
  min: number;
  /** p3: also plays in first person. */
  fp: boolean;
  /** p4: clips (one at random). */
  clips: ResRef[];
  /** p5: the clip of a hit taken in the air (on bone Player p109, as a layer). */
  air?: ResRef;
  /** p6: the pose while knocked off a ledge. */
  fall?: ResRef;
  /** p7: the floor clip (the reaction goes on through Landing). */
  land?: ResRef;
  /** p8: the death clip while down. */
  die?: ResRef;
  /** p9: cooldown after it ends (s). */
  cooldown: number;
}

export interface PlayerHitTables {
  /** Player p89: by force, in list order. */
  hits: PlayerHitReaction[];
  /** Player p90: by Special Hit Reaction / attack. */
  specials: PlayerHitReaction[];
  /** Player p109: the bone of the airborne layer (-1: none). */
  layerBone: number;
  /** Player p115: the fall pose p6 is played (-1: never). */
  fallPose: boolean;
}

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in (v as object) && 'id' in (v as object);
const ref = (v: PropValue | undefined): ResRef | undefined => (isRef(v) ? { pkg: v.pkg, id: v.id } : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? (v as unknown[]).filter(isRef).map((r) => ({ pkg: r.pkg, id: r.id })) : isRef(v) ? [{ pkg: v.pkg, id: v.id }] : []);
const same = (a: ResRef | undefined, b: ResRef | undefined) => !!a && !!b && a.pkg === b.pkg && a.id === b.id;

/** Hit Reaction values -> entry. */
export function playerHitReactionOf(r: ResRef, v: readonly PropValue[]): PlayerHitReaction {
  return {
    ref: r,
    attacks: refs(v[0]),
    special: ref(v[1]),
    min: num(v[2]),
    fp: num(v[3]) !== 0,
    clips: refs(v[4]),
    air: ref(v[5]),
    fall: ref(v[6]),
    land: ref(v[7]),
    die: ref(v[8]),
    cooldown: num(v[9]),
  };
}

/** Template reader: class name and values of a template (actors/specials/runtime.ts readTemplate). */
export type TemplateReader = (r: ResRef) => { cls: string; v: readonly PropValue[] } | undefined;

/** The Player's p89 / p90 Hit Reaction lists (other classes skipped) and p109 / p115. */
export function readPlayerHitTables(read: TemplateReader, player: readonly PropValue[]): PlayerHitTables {
  const list = (v: PropValue | undefined) =>
    refs(v).flatMap((r) => {
      const t = read(r);
      return t && t.cls === 'Hit Reaction' ? [playerHitReactionOf(r, t.v)] : [];
    });
  return { hits: list(player[89]), specials: list(player[90]), layerBone: num(player[109], -1), fallPose: num(player[115], -1) !== -1 };
}

export interface PlayerHitPick {
  def: PlayerHitReaction;
  special: boolean;
}

/**
 * 0x1009e650 over the Player's lists (the entry's least force at p2): a special entry first
 * (its p0 lists the attack, or its p1 is the blow's Special Hit Reaction), else the last entry
 * of the force list with p2 <= force; undefined below the first.
 */
export function pickPlayerHitReaction(t: Pick<PlayerHitTables, 'hits' | 'specials'>, force: number, o: { special?: ResRef; attack?: ResRef } = {}): PlayerHitPick | undefined {
  if (o.special || o.attack) {
    for (const d of t.specials) if ((o.attack && d.attacks.some((a) => same(a, o.attack))) || (o.special && same(d.special, o.special))) return { def: d, special: true };
  }
  let i = 0;
  for (; i < t.hits.length; i++) if (t.hits[i].min > force) break;
  return i > 0 ? { def: t.hits[i - 1], special: false } : undefined;
}

/** What the gate and the state table look at (Player +0x620 / +0x624 / +0xa4). */
export interface PlayerHitStatus {
  /** State 17 is on: the running entry. */
  running?: PlayerHitReaction;
  /** +0x620: cooldown left (s). */
  cooldown: number;
  /** +0x624: p2 of the last reaction. */
  lastMin: number;
  firstPerson: boolean;
  rolling: boolean;
  /**
   * A state that refuses 17 is on (death, Controlled, Landing, Jump Melee, Morph, Interact, View
   * Monitor, Item Pickup, LadderClimb, Insanity Attack Acquisition, Document View, Freak Out).
   */
  refused: boolean;
}

/**
 * The player's damage override's reaction rule (0x1002e233..0x1002e360) [verified]: the gate
 * 0x1002ede0 with the raw force, the running reaction's own test, then the pick with the force
 * after the resistance. `hasRoot(def)`: its clip has root motion (refused while rolling).
 */
export function playerHitReaction(
  t: Pick<PlayerHitTables, 'hits' | 'specials'>,
  s: PlayerHitStatus,
  blow: { force: number; scaled?: number; special?: ResRef; attack?: ResRef },
  hasRoot: (d: PlayerHitReaction) => boolean,
): PlayerHitReaction | undefined {
  const gate = pickPlayerHitReaction(t, blow.force, blow);
  if (!gate) return undefined;
  if (s.cooldown > 0 && blow.force < s.lastMin) return undefined;
  if (s.rolling && hasRoot(gate.def)) return undefined;
  if (s.firstPerson && !gate.def.fp) return undefined;
  const force = blow.scaled ?? blow.force;
  if (s.running && !(force > s.lastMin)) return undefined;
  const pick = pickPlayerHitReaction(t, force, blow);
  if (!pick || s.refused) return undefined;
  return pick.def;
}

/** Fraction of the remaining angle the hit reaction turns the body per frame (0x1000d4c0 with 0.3). */
export const HIT_TURN_PER_FRAME = 0.3;
/** Frames per second the per-frame 30 % turn is taken at [inferred]. */
export const HIT_TURN_FPS = 30;

/** The body's yaw after `dt` of the reaction's turn toward `goal` (radians, shortest way). */
export function hitTurnStep(yaw: number, goal: number, dt: number, frames?: number): number {
  const d = wrapYaw(goal - yaw);
  const k = 1 - Math.pow(1 - HIT_TURN_PER_FRAME, frames ?? dt * HIT_TURN_FPS);
  return wrapYaw(yaw + d * k);
}

export function wrapYaw(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

// --- Jump / landing ------------------------------------------------------------------------

export type JumpKind = 'stand' | 'forward' | 'back' | 'roll';

/** PWP p168 / p169 and Jump enter's 0.2 standing threshold. */
export interface JumpParams {
  forwardDeg: number;
  backDeg: number;
  /** PWP p151..p153: standing, forward, backward. */
  clips: [ResRef | undefined, ResRef | undefined, ResRef | undefined];
  /** PWP p154: the falling clip [inferred: the first of p154..p156]. */
  falling?: ResRef;
  /** PWP p158..p163: landing none / hurt, forward / hurt, backward / hurt. */
  landing: (ResRef | undefined)[];
}

export function readJumpParams(pwp: readonly PropValue[]): JumpParams {
  return {
    forwardDeg: num(pwp[168], 45),
    backDeg: num(pwp[169], 135),
    clips: [ref(pwp[151]), ref(pwp[152]), ref(pwp[153])],
    falling: ref(pwp[154]),
    landing: [158, 159, 160, 161, 162, 163].map((i) => ref(pwp[i])),
  };
}

/** Jump enter's choice (0x1003aed9..0x1003af20): stick magnitude and cos(angle to the body's forward). */
export function jumpKind(magnitude: number, cosToForward: number, p: Pick<JumpParams, 'forwardDeg' | 'backDeg'>): JumpKind {
  if (magnitude < 0.2) return 'stand';
  const D = Math.PI / 180;
  if (cosToForward > Math.cos(p.forwardDeg * D)) return 'forward';
  if (cosToForward >= Math.cos(p.backDeg * D)) return 'roll';
  return 'back';
}

/** The jump's root scales (animator +0x68 / +0x6c, 0x1003af41..0x1003af87): power 1 (p211 = 100). */
export function jumpRootScale(magnitude: number, power = 1): { y: number; z: number } {
  return { y: power, z: ((1 + power) / 2) * Math.max(magnitude, 0.3) };
}

/**
 * Air steering rate of the third-person jump (0x1003a6e0; m/s along the stick's world direction):
 * standing p207, a mostly sideways stick p208, along the jump p205, against it p206.
 */
export function jumpSteerRate(kind: JumpKind, forwardAxis: number, strafeAxis: number, pv: readonly PropValue[]): number {
  if (kind === 'stand') return num(pv[207], 3);
  if (Math.abs(forwardAxis) < Math.abs(strafeAxis)) return num(pv[208], 3);
  const along = kind === 'forward' ? forwardAxis > 0 : forwardAxis <= 0;
  return along ? num(pv[205], 1) : num(pv[206], 7);
}

/** Landing enter's clip slot (0x1003bb74..0x1003bbfd): PWP p158 + (none 0, forward 2, back 4) + hurt. */
export function landingSlot(forwardSpeed: number, horizontalSpeed: number, hurt: boolean): number {
  const base = horizontalSpeed <= 1e-6 ? 158 : forwardSpeed > 0 ? 160 : forwardSpeed < 0 ? 162 : 158;
  return base + (hurt ? 1 : 0);
}

/** Least time in the air before a landing clip plays [port]. */
export const LAND_MIN_AIR = 0.12;
/** Least time off the ground before a reaction counts as knocked off a ledge [port]. */
export const FALL_MIN_AIR = 0.05;

// --- Root motion ---------------------------------------------------------------------------

/**
 * A clip's root translation sampled on the clip's own clock, per-axis scaled (the animator's
 * extraction, SUFFERING.EXE 0x478b90: x / y / z deltas in model space x +0x64 / +0x68 / +0x6c).
 */
export class RootClip {
  readonly clip: AnimClipData;
  t = 0;
  private last: [number, number, number];
  private readonly rate: number;
  /** Model-space distance moved so far (after scaling). */
  readonly moved = { x: 0, y: 0, z: 0 };
  /** Last step's model-space velocity (m/s, after scaling). */
  readonly velocity = { x: 0, y: 0, z: 0 };

  constructor(clip: AnimClipData, readonly scale = { x: 1, y: 1, z: 1 }, speed = 1) {
    this.clip = clip;
    this.rate = (clip.rate || 1) * speed;
    const r = sampleTrackTranslation(clip, 0);
    this.last = [r[0], r[1], r[2]];
  }

  /** Real time the clip lasts (s). */
  get length(): number {
    return this.clip.duration / Math.max(1e-6, this.rate);
  }

  get ended(): boolean {
    return this.t >= this.clip.duration - 1e-6;
  }

  /** True when the clip's root moves at all (the gate's and the turn's root test). */
  static hasRoot(clip: AnimClipData | undefined): boolean {
    if (!clip) return false;
    const a = sampleTrackTranslation(clip, 0), b = sampleTrackTranslation(clip, clip.duration);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 1e-4;
  }

  /** Advance by `dt` real seconds; this step's model-space root delta (scaled). */
  step(dt: number): { x: number; y: number; z: number } {
    if (dt <= 0) return { x: 0, y: 0, z: 0 };
    this.t = Math.min(this.clip.duration, this.t + dt * this.rate);
    const r = sampleTrackTranslation(this.clip, this.t);
    const d = { x: (r[0] - this.last[0]) * this.scale.x, y: (r[1] - this.last[1]) * this.scale.y, z: (r[2] - this.last[2]) * this.scale.z };
    this.last = [r[0], r[1], r[2]];
    this.moved.x += d.x;
    this.moved.y += d.y;
    this.moved.z += d.z;
    this.velocity.x = d.x / dt;
    this.velocity.y = d.y / dt;
    this.velocity.z = d.z / dt;
    return d;
  }
}

// ---------------------------------------------------------------------------------------
// Runtime

/** What the states need from the player's body (actors/player-body.ts PlayerBody). */
export interface StatesBody {
  play(clip: ResRef, o?: { loop?: boolean; fade?: number; inPlace?: boolean }): number;
  release(fade?: number): void;
  /** An independent layer on a bone's subtree (Character.playLayer through the body). */
  layer?(clip: ResRef, bone: number): number;
  stopLayer?(bone: number): void;
}

export interface PlayerStatesEnv {
  player: PlayerController;
  body(): StatesBody | null;
  clip(r: ResRef): AnimClipData | undefined;
  tables: PlayerHitTables;
  /** The held weapon's Player Weapon Properties values (unarmed: Player p143's). */
  pwp(): readonly PropValue[];
  /** Player template values (p205..p208 air steering). */
  playerValues: readonly PropValue[];
  /** A state that refuses Hit Reacting is on (see PlayerHitStatus.refused) besides the ones run here. */
  refused(): boolean;
  /** Rolling (state 15). */
  rolling(): boolean;
  /** In creature form (no reactions: 2:240 has no lists; its jump is the insanity attack). */
  transformed(): boolean;
  /** A Roll toward the stick side (-1 left, 1 right): hud/actions.ts. */
  roll?(dir: -1 | 1): boolean;
  /** Entering 17 ends MeleeAttack / Attack / Throw: drop the swing under way (weapons system). */
  endActions?(): void;
  /** Random in [0, 1) (tests). */
  random?(): number;
}

export type StatePhase = 'none' | 'react' | 'air' | 'fallen' | 'down' | 'jump' | 'fall' | 'land';

export interface BlowInfo {
  /** Impact force (damage record +0x1c); undefined: not known -> no reaction [port]. */
  force?: number;
  /** After the resistance (x Damage Resistance p2). */
  scaled?: number;
  special?: ResRef;
  attack?: ResRef;
  /** Where the blow came from (the attacker or the blast). */
  from?: { x: number; y: number; z: number };
}

/**
 * Hit Reacting, the third-person Jump and Landing as one small state machine on the player
 * (installed by actors/system.ts). Everything it moves goes through `player.rootMove`.
 */
export class PlayerStates {
  phase: StatePhase = 'none';
  /** +0x620 / +0x624. */
  cooldown = 0;
  lastMin = 0;
  /** The running reaction (state 17). */
  reaction: PlayerHitReaction | null = null;
  private root: RootClip | null = null;
  private attacker: { x: number; y: number; z: number } | null = null;
  private wasFp = false;
  private layerUntil = 0;
  private time = 0;
  private air = 0;
  private jump: { kind: JumpKind; facing: number; lastYaw: number; steer: number; strafeSign: number } | null = null;
  private fallVel: { x: number; y: number; z: number } | null = null;
  private airAccel: number | null = null;
  private dropTop = 0;
  /** Debug / tests: the last reaction, jump and landing with what they moved (model space). */
  readonly log: { t: number; what: string; clip?: string; moved?: { x: number; y: number; z: number } }[] = [];

  constructor(private readonly env: PlayerStatesEnv) {}

  /** True while state 17 runs. */
  get reacting(): boolean {
    return this.reaction !== null;
  }

  /** Hit Reacting or Landing refuse walking (and 17 everything else): PlayerController.holdMove. */
  get holding(): boolean {
    return this.reaction !== null || this.phase === 'land' || this.phase === 'jump' || this.phase === 'fall';
  }

  /** The death clip while knocked down (p8), else undefined (0x1002e7d8). */
  get deathClip(): ResRef | undefined {
    return this.reaction?.die;
  }

  private note(what: string, clip?: ResRef, moved?: { x: number; y: number; z: number }) {
    this.log.push({ t: +this.time.toFixed(2), what, clip: clip && `${clip.pkg}:${clip.id}`, moved: moved && { x: +moved.x.toFixed(3), y: +moved.y.toFixed(3), z: +moved.z.toFixed(3) } });
    if (this.log.length > 40) this.log.splice(0, 10);
  }

  status(): PlayerHitStatus {
    const p = this.env.player;
    return {
      running: this.reaction ?? undefined,
      cooldown: this.cooldown,
      lastMin: this.lastMin,
      firstPerson: p.mode === 'fp',
      rolling: this.env.rolling(),
      refused: this.phase === 'land' || this.env.refused(),
    };
  }

  /** A blow on the player (the damage override 0x1002e000): starts a reaction when the rules allow. */
  onBlow(b: BlowInfo): PlayerHitReaction | undefined {
    if (b.force === undefined || this.env.transformed()) return undefined;
    const pl = this.env.player;
    if (!pl.enabled) return undefined;
    const def = playerHitReaction(this.env.tables, this.status(), { force: b.force, scaled: b.scaled, special: b.special, attack: b.attack }, (d) => RootClip.hasRoot(d.clips[0] && this.env.clip(d.clips[0])));
    if (!def) return undefined;
    this.start(def, b.from);
    return def;
  }

  private pickClip(def: PlayerHitReaction): ResRef | undefined {
    const n = def.clips.length;
    return n ? def.clips[Math.min(n - 1, Math.floor((this.env.random ?? Math.random)() * n))] : undefined;
  }

  private start(def: PlayerHitReaction, from: BlowInfo['from']) {
    const env = this.env, pl = env.player;
    this.endJump(false);
    this.endFall();
    if (this.reaction && this.phase === 'air') env.body()?.stopLayer?.(env.tables.layerBone);
    this.reaction = def;
    this.lastMin = def.min;
    this.attacker = from ? { x: from.x, y: from.y, z: from.z } : null;
    env.endActions?.();
    // Entering 17 ends First Person; it comes back when 17 is over.
    if (pl.mode === 'fp') {
      this.wasFp = true;
      pl.stateTp = true;
      pl.setMode('tp');
    }
    pl.stateHold = true;
    pl.actionsLocked = true;
    pl.viewLock = { yaw: pl.yaw, pitch: pl.pitch };
    pl.bodyYawHold = pl.bodyYaw;
    const clip = this.pickClip(def);
    if (!pl.onGround && !def.land) {
      // In the air with no floor clip: the p5 clip on the spine's subtree (Player p109).
      this.phase = 'air';
      const b = env.body();
      const len = def.air && b?.layer && env.tables.layerBone >= 0 ? b.layer(def.air, env.tables.layerBone) : 0;
      this.layerUntil = this.time + len;
      this.root = null;
      this.note('react air', def.air);
      return;
    }
    this.phase = 'react';
    if (pl.onGround) pl.motor.velocity.x = pl.motor.velocity.z = 0;
    // The 30 % turn toward the attacker (the clip under way is locomotion: no root).
    this.turn(1);
    const data = clip && env.clip(clip);
    this.root = data ? new RootClip(data) : null;
    if (clip) env.body()?.play(clip, { inPlace: true, fade: 0 });
    this.note('react', clip);
  }

  /** The reaction's turn toward the attacker: `frames` 30 % steps, or `dt` at HIT_TURN_FPS. */
  private turn(frames: number | undefined, dt = 0) {
    const a = this.attacker, pl = this.env.player;
    if (!a) return;
    const dx = a.x - pl.position.x, dz = a.z - pl.position.z;
    if (Math.hypot(dx, dz) < 1e-4) return;
    const goal = Math.atan2(-dx, -dz);
    const next = hitTurnStep(pl.bodyYaw, goal, dt, frames);
    const d = wrapYaw(next - pl.bodyYaw);
    pl.bodyYaw = next;
    pl.bodyYawHold = next;
    pl.yaw = wrapYaw(pl.yaw + d);
    if (pl.viewLock) pl.viewLock.yaw = pl.yaw;
  }

  private moveRoot(dt: number, facing: number, fly = false) {
    const r = this.root, pl = this.env.player;
    if (!r) return;
    const d = r.step(dt);
    const w = lungeToWorld(d.x, d.z, facing);
    pl.rootMove.x += w.x;
    pl.rootMove.z += w.z;
    if (fly) pl.rootMove.y += d.y;
  }

  /** `keepView`: the player died (combat.die keeps the death view and gives the chosen one back). */
  private endReaction(keepView = false) {
    const env = this.env, pl = env.player, def = this.reaction;
    if (!def) return;
    if (this.phase === 'air') env.body()?.stopLayer?.(env.tables.layerBone);
    this.reaction = null;
    this.root = null;
    this.cooldown = def.cooldown;
    this.phase = 'none';
    pl.stateHold = false;
    pl.actionsLocked = false;
    pl.viewLock = null;
    pl.bodyYawHold = null;
    env.body()?.release(0.2);
    if (this.wasFp) {
      this.wasFp = false;
      pl.stateTp = false;
      // Not into the creature form (it keeps third person and gives back the chosen view when
      // it ends) nor a death's view. Before, a reaction running when the player transformed or
      // died left him in third person for good: the creature form and death remembered the
      // reaction's third person as his view (run r9 of 2026-10-25, from 10's Slayer fight on).
      if (!keepView && !env.transformed()) pl.setMode('fp');
    }
    this.note('react end');
  }

  /** Third-person jump press (PlayerController.jumpOverride): true when taken (or refused). */
  onJump(input: { forward: number; strafe: number }): boolean {
    const env = this.env, pl = env.player;
    if (pl.mode !== 'tp' || env.transformed()) return false;
    if (this.reaction || this.phase === 'land' || this.phase === 'jump' || this.phase === 'fall') return true;
    if (!pl.onGround || pl.crouched) return false;
    const pv = env.pwp();
    const p = readJumpParams(pv);
    const mag = Math.min(1, Math.hypot(input.forward, input.strafe));
    // Stick in the world (camera-relative), against the body's forward.
    const s = Math.sin(pl.yaw), c = Math.cos(pl.yaw);
    const wx = -s * input.forward + c * input.strafe, wz = -c * input.forward - s * input.strafe;
    const fx = -Math.sin(pl.bodyYaw), fz = -Math.cos(pl.bodyYaw);
    const wl = Math.hypot(wx, wz) || 1;
    const cos = (wx * fx + wz * fz) / wl;
    const kind = jumpKind(mag, cos, p);
    if (kind === 'roll') return env.roll?.(rollSide(wx, wz, pl.bodyYaw)) ?? false;
    const clip = p.clips[kind === 'stand' ? 0 : kind === 'forward' ? 1 : 2];
    const data = clip && env.clip(clip);
    if (!clip || !data) return false;
    let facing = pl.bodyYaw;
    if (kind !== 'stand') {
      const stickYaw = Math.atan2(-wx, -wz);
      facing = kind === 'forward' ? stickYaw : wrapYaw(stickYaw + Math.PI);
    }
    const sc = jumpRootScale(mag);
    this.root = new RootClip(data, { x: 1, y: sc.y, z: sc.z });
    this.jump = { kind, facing, lastYaw: pl.yaw, steer: 0, strafeSign: 0 };
    this.phase = 'jump';
    this.time0 = this.time;
    pl.bodyYaw = facing;
    pl.bodyYawHold = facing;
    pl.motor.velocity.x = pl.motor.velocity.z = pl.motor.velocity.y = 0;
    // Jump ends Move at once ([8][1] = 2): no gait this frame either.
    pl.stateHold = true;
    pl.rootFly = true;
    this.dropTop = pl.position.y;
    env.body()?.play(clip, { inPlace: true });
    this.note(`jump ${kind}`, clip);
    return true;
  }
  private time0 = 0;

  private endJump(fall: boolean) {
    const pl = this.env.player;
    if (!this.jump) return;
    const r = this.root, j = this.jump;
    this.jump = null;
    pl.rootFly = false;
    pl.bodyYawHold = null;
    if (r) this.note('jump end', undefined, r.moved);
    if (fall && r) {
      // Fall with the root's last velocity, kept through the fall (no air control).
      const w = lungeToWorld(r.velocity.x, r.velocity.z, j.facing);
      this.fallVel = { x: w.x, y: r.velocity.y, z: w.z };
      pl.motor.velocity.x = w.x;
      pl.motor.velocity.z = w.z;
      pl.motor.velocity.y = r.velocity.y;
      this.phase = 'fall';
      this.airAccel = pl.motor.cfg.airAccel;
      pl.motor.cfg.airAccel = 0;
    } else if (this.phase === 'jump') this.phase = 'none';
    this.root = null;
  }

  private endFall() {
    const pl = this.env.player;
    if (this.airAccel !== null) pl.motor.cfg.airAccel = this.airAccel;
    this.airAccel = null;
    this.fallVel = null;
  }

  /** Landing (12): the PWP clip by the fall's horizontal velocity, root extracted. */
  private land(f: PlayerFrame) {
    const env = this.env, pl = env.player;
    // The fall's velocity (+0x15a: kept from the jump, vy dropped), else the motor's.
    const v = this.fallVel ?? { x: pl.velocity.x, y: 0, z: pl.velocity.z };
    this.endFall();
    if (pl.mode === 'fp' || env.transformed()) {
      this.phase = 'none';
      return;
    }
    const fx = -Math.sin(pl.bodyYaw), fz = -Math.cos(pl.bodyYaw);
    const along = v.x * fx + v.z * fz;
    const slot = landingSlot(along, Math.hypot(v.x, v.z), (f.fall ?? 0) > FALL_DAMAGE_MIN);
    const clip = readJumpParams(env.pwp()).landing[slot - 158];
    const data = clip && env.clip(clip);
    if (!clip || !data) {
      this.phase = 'none';
      return;
    }
    pl.motor.velocity.x = pl.motor.velocity.z = 0;
    this.root = new RootClip(data);
    this.phase = 'land';
    this.landFacing = pl.bodyYaw;
    pl.bodyYawHold = pl.bodyYaw;
    env.body()?.play(clip, { inPlace: true });
    this.note(`land ${slot}`, clip);
  }
  private landFacing = 0;

  /** Per player frame (after the motor moved). */
  update(f: PlayerFrame) {
    const env = this.env, pl = env.player, dt = f.dt;
    this.time += dt;
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    const airBefore = this.air + (f.onGround ? dt : 0);
    this.air = f.onGround ? 0 : this.air + dt;
    if (env.transformed() && this.reaction) this.endReaction();
    switch (this.phase) {
      case 'air':
        if (this.time >= this.layerUntil) this.endReaction();
        break;
      case 'react': {
        const r = this.root;
        if (!f.onGround && this.air > FALL_MIN_AIR) {
          // Knocked off a ledge: Fall plays p6 and drops him straight down (no root).
          const def = this.reaction!;
          this.root = null;
          this.phase = 'fallen';
          pl.motor.velocity.x = pl.motor.velocity.z = 0;
          if (def.fall && env.tables.fallPose) env.body()?.play(def.fall, { inPlace: true, loop: true, fade: 0.1 });
          this.note('react fall', def.fall, r?.moved);
          break;
        }
        if (r && !RootClip.hasRoot(r.clip)) this.turn(undefined, dt);
        this.moveRoot(dt, pl.bodyYaw);
        if (!r || r.ended) {
          this.note('react clip end', undefined, r?.moved);
          if (this.reaction!.land) this.down();
          else this.endReaction();
        }
        break;
      }
      case 'fallen':
        if (f.onGround) {
          if (this.reaction!.land) this.down();
          else this.endReaction();
        }
        break;
      case 'down': {
        const r = this.root;
        this.moveRoot(dt, pl.bodyYaw);
        if (!r || r.ended) {
          this.note('down end', undefined, r?.moved);
          this.endReaction();
        }
        break;
      }
      case 'jump': {
        const j = this.jump!, r = this.root!;
        // Turning while in the air turns the body and the jump with it.
        const dy = wrapYaw(pl.yaw - j.lastYaw);
        j.lastYaw = pl.yaw;
        j.facing = wrapYaw(j.facing + dy);
        pl.bodyYaw = j.facing;
        pl.bodyYawHold = j.facing;
        this.moveRoot(dt, j.facing, true);
        // Air steering: rate x the stick's world direction.
        const inp = pl.moveInput;
        const s = Math.sin(pl.yaw), c = Math.cos(pl.yaw);
        const wx = -s * inp.forward + c * inp.strafe, wz = -c * inp.forward - s * inp.strafe;
        const wl = Math.hypot(wx, wz);
        if (wl > 1e-3) {
          const rate = jumpSteerRate(j.kind, inp.forward, inp.strafe, env.playerValues);
          const k = rate * dt * Math.min(1, wl) / wl;
          pl.rootMove.x += wx * k;
          pl.rootMove.z += wz * k;
          // The standing jump's first 0.2 s: a sideways stick becomes a Roll.
          if (j.kind === 'stand' && this.time - this.time0 < 0.2) {
            const p = readJumpParams(env.pwp());
            const fx = -Math.sin(pl.bodyYaw), fz = -Math.cos(pl.bodyYaw);
            const cos = (wx * fx + wz * fz) / wl;
            if (Math.min(1, Math.hypot(inp.forward, inp.strafe)) >= 0.2 && jumpKind(1, cos, p) === 'roll' && env.roll) {
              this.endJump(false);
              this.phase = 'none';
              pl.stateHold = false;
              env.body()?.release(0.1);
              env.roll(rollSide(wx, wz, pl.bodyYaw));
              break;
            }
          }
        }
        if (r.ended) this.endJump(true);
        break;
      }
      case 'fall':
        if (f.onGround) this.land(f);
        break;
      case 'land': {
        const r = this.root;
        this.moveRoot(dt, this.landFacing);
        if (!r || r.ended) {
          this.root = null;
          this.phase = 'none';
          pl.bodyYawHold = null;
          this.note('land end', undefined, r?.moved);
          env.body()?.release(0.2);
        }
        break;
      }
      case 'none':
        // A walk-off fall in third person lands too (Fall -> Landing).
        if (f.landed && pl.mode === 'tp' && !env.transformed() && airBefore >= LAND_MIN_AIR) this.land(f);
        break;
    }
    pl.stateHold = this.holding;
  }

  /** Into Landing with the reaction's floor clip p7 (Landing enter 0x1003bb33). */
  private down() {
    const def = this.reaction!, env = this.env;
    const data = def.land && env.clip(def.land);
    this.phase = 'down';
    this.root = data ? new RootClip(data) : null;
    if (def.land) env.body()?.play(def.land, { inPlace: true });
    this.note('down', def.land);
  }

  /** Drop everything (level change, death, cutscene). `dead`: the death keeps its view. */
  reset(dead = false) {
    const pl = this.env.player;
    if (this.reaction) this.endReaction(dead);
    this.endJump(false);
    this.endFall();
    this.phase = 'none';
    this.root = null;
    pl.rootFly = false;
    pl.bodyYawHold = null;
    pl.stateHold = false;
  }
}

/** Roll side of a world stick direction against the body's facing (Roll enter 0x1003aa3c). */
export function rollSide(wx: number, wz: number, bodyYaw: number): -1 | 1 {
  // Right of the facing: (cos, -sin).
  const rx = Math.cos(bodyYaw), rz = -Math.sin(bodyYaw);
  return wx * rx + wz * rz >= 0 ? 1 : -1;
}
