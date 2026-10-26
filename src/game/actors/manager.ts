// Owns every actor of the level: placement from entities, spawning, per-frame AI,
// culling / animation LOD, actor-vs-actor separation, and hit tests for combat.

import * as THREE from 'three/webgpu';
import type { CharacterMotor, CollisionWorld } from '../../app/physics';
import type { Entity } from '../../formats/entities';
import { classByHash, PropType } from '../../formats/entities';
import { instanceRotation, toOutputSpace } from '../../formats/level';
import type { PackageSet, ResRef } from '../../formats/model';
import { hasSkeleton } from '../../formats/skeleton';
import { Actor, sourceId, type ActorEnv, type ActorProfile, type AiNoise, type DamageSource, type RangedAttack, type RangedProfile } from './actor';
import { KindLibrary } from './kinds';
import { DecorBatches } from './decor-batch';
import { CHARACTER_CLASSES } from './classes';
import { NavGraph, NO_NAV_TYPE } from './nav';
import { CHARACTER_MELEE_SLOT, readDormancy, type ClipRef } from './clipmap';
import { BehaviorLibrary, CHAR, templateList, templateProp, type Behavior, type NoiseSpec } from './behaviors';
import { decodeTemplateProps, readObjectTemplate, type PropValue } from '../../formats/entities';
import { bodyVisible, pointsVisible, sightBlocked, spreadPoints, type SeeThrough } from './sight';
import { skipMatricesWhileHidden } from '../../app/matrix-pass';
import { readHitTables } from './hit-react';
import { readMeleeWeapons } from './npc-melee';
import { resistanceForceMultiplier, resistanceMultiplier } from '../fx/gas';
import { ENGINE_UNITS, THROWN_GRAVITY } from '../weapons/data';
import { FOUNTAIN_GRAVITY, modelBoundsRadius } from '../world/fx';

export interface ActorHit {
  actor: Actor;
  distance: number;
  point: THREE.Vector3;
}

export type ActorEvent = 'death' | 'damage' | 'spawn';

/** Where / how a blow landed (services.damage passes it on; Actor.damageFilter reads it). */
export interface ActorHitInfo {
  point?: THREE.Vector3Like;
  /** Engine damage type (world/damage.ts DAMAGE_TYPE: 1 bullet, 3 explosion, 5 fire, 10 melee). */
  type?: number;
  /** The struck hit sphere's bone (record +0x20), when the blow knows it: Part Caps (dismember.ts). */
  bone?: number;
  /** Special Hit Reaction template the damage carries (picks a p71 hit reaction; hit-react.ts). */
  special?: ResRef;
  /** Damage over time: the per-frame amount the hit reaction is picked by (hit-react.ts). */
  frameAmount?: number;
  /**
   * Impact force of the blow before resistances (damage record +0x1c: Missile p28..p31, Melee
   * Weapon p69 x Attack p7, Radius Damage p2..p3): what the hit reaction is picked by.
   */
  force?: number;
}

/**
 * Event payloads. `source` names the attacker: 'player', or the uid of the attacking actor
 * (0 for an actor without one) or of a hazard object (Damage Action Object, ...).
 */
export interface ActorDamageInfo {
  amount: number;
  killed: boolean;
  source: 'player' | number;
  /** The attacking actor, when an actor dealt the damage. */
  by?: Actor;
}
export interface ActorDeathInfo {
  source: 'player' | number;
  killer?: Actor;
}

const FULL_RATE_DISTANCE = 18;
/** Camera moves / turns between two visibility passes that count as a cut (occlusion redone). */
const CUT_DISTANCE = 1;
const CUT_COS = Math.cos((30 * Math.PI) / 180);
/** Occlusion re-test interval (s, plus up to half again at random: staggered over the actors). */
const RETEST = 0.2;
/** Bones of the pose the occlusion test looks at besides the body capsule (spreadPoints). */
const POSE_SAMPLES = 6;
/** Animated poses reach this much past the bind pose's reach (culling bound). */
const REACH_SCALE = 1.3;
/** Cinematic frustum test: slack (m) on the body sphere. */
const CINEMATIC_SLACK = 0.5;

export class ActorManager {
  readonly actors: Actor[] = [];
  readonly group = new THREE.Group();
  readonly kinds: KindLibrary;
  nav: NavGraph | null = null;
  stats = { total: 0, visible: 0, awake: 0, animated: 0, ms: 0 };

  private byUid = new Map<number, Actor>();
  private listeners = new Map<ActorEvent, Set<(a: Actor, info?: unknown) => void>>();
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private hipsPos = new THREE.Vector3();
  private frame = 0;
  /** Camera of the last visibility pass (cut detection). */
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastCamDir = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  /** Actors inside the view frustum at their last visibility pass (entering it re-tests occlusion). */
  private inFrustum = new WeakSet<Actor>();
  /** Frame of the last cinematic camera pose (refreshVisibility): cull() then skips occlusion. */
  private cinematicFrame = -Infinity;
  private posePoints = new Float32Array(3 * POSE_SAMPLES);
  /**
   * Collision hits the eye passes through (cut-out bars, glass: WorldService.seeThrough);
   * the occlusion test looks past them. Without it every surface occludes.
   */
  seeThrough: SeeThrough | null = null;
  /**
   * The draw-occlusion test's world and see-through rule: the level's drawn triangles and what the
   * eye sees through (WorldService.eyeThrough), when the collision world holds the original's
   * collision models instead (docs/game-logic.md §14.10). Unset: `world` / `seeThrough`.
   */
  occlusion: { world: () => CollisionWorld | null; seeThrough: SeeThrough | null } | null = null;
  /** What a shot passes on its way to an actor (WorldService.shotThrough); unset: `seeThrough`. */
  shotThrough: SeeThrough | null = null;
  /**
   * Would the zone / portal culling draw a sphere (x, y, z, radius) for the camera of the frame
   * just drawn (ZoneCuller.objectVisible; actors system)? A body in no visible zone is hidden
   * without casting sight lines.
   */
  zoneVisible: ((x: number, y: number, z: number, r: number) => boolean) | null = null;
  /**
   * Gameplay draw distance (body sphere to camera): where the fog hides everything (actors
   * system: ZoneCuller.fogDistance; Infinity without fog culling). A fixed 55 m popped
   * characters still a third visible through 1a's fog (fully fogged at 62.5 m).
   */
  drawDistance = Infinity;

  constructor(
    pkgs: PackageSet,
    private readonly scene: THREE.Scene,
    private world: CollisionWorld | null,
  ) {
    this.kinds = new KindLibrary(pkgs);
    this.group.name = 'actors';
    scene.add(this.group);
  }

  behaviors!: BehaviorLibrary;
  private pkgs!: PackageSet;
  /** Object Cloner templates: placed characters that are only copied, never active. */
  readonly templates = new Set<number>();
  /** Clones per template uid (messages to the template reach its clones too). */
  readonly clones = new Map<number, Actor[]>();
  private nextCloneUid = 0x7f000000;
  private unknown = new Set<string>();

  /** Merged draws of the skinned decorations (decor-batch.ts; QA: `__actors.manager.decor.stats`). */
  decor: DecorBatches | null = null;

  /** Create actors for every placed creature / NPC / skinned decoration. */
  populate(entities: Entity[], pkgs: PackageSet) {
    this.pkgs = pkgs;
    this.nav = new NavGraph(entities, (r) => this.navTypeOf(r));
    this.behaviors = new BehaviorLibrary(pkgs, new Map(entities.map((e) => [e.uid, e])));
    // Object Cloner p5: the characters it copies are templates (the cloner flags them inert).
    for (const e of entities) {
      if (e.className !== 'Object Cloner') continue;
      const v = e.values[5];
      for (const u of Array.isArray(v) ? v : [v]) if (typeof u === 'number' && u > 0) this.templates.add(u);
    }
    for (const e of entities) {
      const m = e.modelRef;
      if (!m || !hasSkeleton(pkgs.get(m.pkg)?.mdu, m.id)) continue;
      if (e.family === 'Character' && e.className !== 'Player') {
        // classes.ts registers the Character classes this system knows; others are still
        // run generically from their template behaviours.
        if (!CHARACTER_CLASSES.has(e.className) && !this.unknown.has(e.className)) {
          this.unknown.add(e.className);
          console.debug(`[actors] ${e.className}: not in the class registry, handled generically`);
        }
        // A placement's own MeleeAttackBehavior (p87 overridden) gives it the clips of that one.
        const m = e.overridden.includes(CHARACTER_MELEE_SLOT) ? e.values[CHARACTER_MELEE_SLOT] : undefined;
        const melee = m && typeof m === 'object' && !Array.isArray(m) ? { pkg: m.pkg, id: m.id } : undefined;
        const kind = this.kinds.creature(e.template, melee);
        if (!kind) continue;
        const a = new Actor(kind, feet(e), yawOf(e), e.scale?.[0] ?? 1, e);
        a.profile = this.profile(e.values, classByHash(e.classHash)?.types ?? []);
        if (this.templates.has(e.uid)) {
          a.template = true;
          a.ch.root.visible = false;
        } else this.applyDormancy(a, e, pkgs);
        this.initBehavior(a, e.values, classByHash(e.classHash)?.types ?? []);
        this.add(a, false);
      } else if (e.className === 'Animating Static') {
        const clips = animList(e);
        if (!clips.length) continue;
        const kind = this.kinds.decoration(m, clips.slice(0, 1));
        if (kind) {
          const a = new Actor(kind, feet(e), yawOf(e), e.scale?.[0] ?? 1, e);
          // Decorations keep their exact placement (incl. tilt).
          const R = instanceRotation(e.rotation);
          const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1));
          a.ch.root.quaternion.copy(q);
          this.add(a, false);
        }
      } else if (e.className === 'Ambient Creature') {
        // Scurrying vermin (PhysicalObject, no AI), driven by director.ts: p24 is its one
        // animation (the run / flight loop; p28 are sounds) [verified: On handler 0x10091070].
        const v = e.values[24];
        const clips = (Array.isArray(v) ? v : [v]).filter((r): r is ResRef => !!r && typeof r === 'object').map((r) => ({ pkg: r.pkg, id: r.id }));
        const kind = this.kinds.decoration(m, clips);
        if (kind) {
          const a = new Actor(kind, feet(e), yawOf(e), e.scale?.[0] ?? 1, e);
          a.ch.root.rotation.set(0, a.yaw, 0, 'YXZ');
          this.add(a, false);
        }
      }
    }
    // Skinned decorations of one model drawn as one mesh per material (decor-batch.ts).
    this.decor = new DecorBatches(this.actors, this.group);
  }

  /**
   * Initial behavior of a placed creature (clipmap.ts readDormancy):
   *   DormantBehavior mode 2 -> hidden until woken / revealed;
   *   its clip -> played while dormant; a clip that holds the body below the origin
   *   (Slayers clinging to ceilings) -> hangs from the ceiling at the placement;
   *   JumpBehavior -> hidden drop-in, falls from its placement when woken.
   * Creatures placed in mid-air without any of these are handled in Actor.settle.
   */
  private applyDormancy(a: Actor, e: Entity, pkgs: PackageSet) {
    const d = readDormancy(pkgs, e.values, classByHash(e.classHash)?.types ?? []);
    if (!d) return;
    const clip = this.kinds.clipIndex(a.kind, d.clip);
    if (clip >= 0) {
      const r = this.kinds.jointRange(a.kind, clip);
      // Joints only: pad for the mesh around the lowest joint. Not a Burrower: its dormant,
      // idle and move clips keep its body under the floor by design (it lives underground,
      // docs/game-logic.md §15.7.2; 4b / 5a 10:317); taken for a ceiling hanger it was dropped
      // through the floor when woken (5a's Object Cloner 21bd copies and the vision's 1e1c / 1e1e).
      if (!a.kind.anchored && e.className !== 'Burrower' && r.maxY < 0.5 && r.minY < -0.4) a.hangFromCeiling(r.minY - 0.2);
      if (d.mode !== 2) a.setDormantIdle(clip);
    }
    if (d.mode === 2) a.setDormantHidden(false);
    if (d.jump) a.setDormantHidden(true);
  }

  /**
   * Killjoy's slots for his KilljoyRootBehavior (actor.ts runKilljoy): the FleeBehavior (Character
   * p77, behaviour type 0x42) and the KilljoyRaiseDeadBehavior (p175, type 0x4b). Other
   * characters have neither.
   */
  private killjoyProfile(values: PropValue[], types: number[]): Pick<ActorProfile, 'flee' | 'raiseDead'> {
    const raise = this.behaviors.fromTemplate(templateProp(values, types, CHAR.raiseDead));
    if (raise?.kind !== 'raiseDead') return {};
    const flee = this.behaviors.fromTemplate(templateProp(values, types, CHAR.flee));
    return { raiseDead: raise, flee: flee?.kind === 'flee' ? flee : undefined };
  }

  /** NPC Exclusion Type template -> its type bit (p0, 0..30) [verified: 0x100dc070]. */
  private navTypeOf(r: ResRef | undefined): number | undefined {
    const t = r ? readObjectTemplate(this.pkgs, r) : undefined;
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || c?.name !== 'NPC Exclusion Type') return undefined;
    const v = decodeTemplateProps(c, t)[0];
    return typeof v === 'number' && v >= 0 && v <= 30 ? v : undefined;
  }

  /** Per-actor data from its effective property values (template + instance overrides). */
  profile(values: PropValue[], types: number[]): ActorProfile {
    const B = this.behaviors;
    const team = templateProp(values, types, CHAR.team);
    const kill = B.fromTemplate(templateProp(values, types, CHAR.kill));
    const p: ActorProfile = {
      team: team ? `${team.pkg}:${team.id}` : '',
      active: B.fromTemplate(templateProp(values, types, CHAR.active)),
      provoked: B.fromTemplate(templateProp(values, types, CHAR.provoked)),
      kill: kill?.kind === 'kill' ? kill : undefined,
      ...this.killjoyProfile(values, types),
      ranged: this.ranged(values, types),
      openDoor: null,
      investigate: B.investigate(templateProp(values, types, CHAR.investigate)),
      // Hit reactions: p70 by damage, p71 by Special Hit Reaction (hit-react.ts) [verified].
      hitReacts: readHitTables(this.pkgs, values),
      // Character p45: the NPC Exclusion Type Move Nodes let through or keep out (nav.ts).
      navType: this.navTypeOf(templateProp(values, types, CHAR.navType)) ?? NO_NAV_TYPE,
      // GameObject p4 / p8: read by other characters' target score (targeting.ts) [verified].
      priority: typeof values[4] === 'number' ? values[4] : undefined,
      maxAttackers: typeof values[8] === 'number' ? values[8] : undefined,
      // p51 bones / p52 Melee Weapons: the blades the attack clips arm (npc-melee.ts) [verified].
      melee: this.pkgs ? readMeleeWeapons(this.pkgs, values) : undefined,
    };
    // HostilityBehavior p3..p4 (p69, else p76): search interval without a target (targeting.ts).
    const hostility = p.active?.kind === 'hostile' ? p.active : p.provoked?.kind === 'hostile' ? p.provoked : undefined;
    if (hostility?.kind === 'hostile') p.hostileRetry = hostility.retry;
    // Death behaviour (p72): instances override the template list the kind's deaths come from.
    for (const r of templateList(values, CHAR.deaths)) {
      const d = B.fromTemplate(r);
      if (d?.kind === 'death') {
        p.death ??= d;
        (p.deaths ??= []).push(d);
      }
    }
    // LadderClimbBehavior p2 / p3 rung up, p4 / p5 rung down, p6 / p7 holds, p8 / p9 off at the
    // top / bottom: the player's Ladder Animation Set clips in its order [data; roles inferred].
    const lc = templateProp(values, types, CHAR.ladder);
    if (lc) {
      const t = readObjectTemplate(this.pkgs, lc);
      const c = t ? classByHash(t.classHash) : undefined;
      if (t && c?.name === 'LadderClimbBehavior') {
        const v = decodeTemplateProps(c, t);
        const r = (x: PropValue | undefined) => (x && typeof x === 'object' && !Array.isArray(x) ? { pkg: x.pkg, id: x.id } : undefined);
        const two = (a: PropValue | undefined, b: PropValue | undefined) => [r(a), r(b)].filter((x): x is { pkg: number; id: number } => !!x);
        p.ladder = { up: two(v[2], v[3]), down: two(v[4], v[5]), exitTop: r(v[8]), exitBottom: r(v[9]) };
      }
    }
    // KillMeleeBehavior (p85): the wait p2..p3 after each melee attack [verified: 0x1007cf10].
    // Only the generic class: the creatures' own KillMelee kinds come from their specials.
    const km = templateProp(values, types, CHAR.killMelee);
    if (km) {
      const t = readObjectTemplate(this.pkgs, km);
      const c = t ? classByHash(t.classHash) : undefined;
      if (t && c?.name === 'KillMeleeBehavior') {
        const v = decodeTemplateProps(c, t);
        const lo = typeof v[2] === 'number' ? v[2] : 0, hi = typeof v[3] === 'number' ? v[3] : lo;
        if (hi > 0) p.meleePause = [lo, Math.max(lo, hi)];
      }
    }
    const od = templateProp(values, types, CHAR.openDoor);
    if (od) {
      const t = readObjectTemplate(this.pkgs, od);
      const c = t ? classByHash(t.classHash) : undefined;
      if (t && c?.name === 'OpenDoorBehavior') {
        const v = decodeTemplateProps(c, t);
        const r = (x: PropValue | undefined) => (x && typeof x === 'object' && !Array.isArray(x) ? { pkg: x.pkg, id: x.id } : undefined);
        p.openDoor = { front: r(v[2]), back: r(v[3]) };
      }
    }
    return p;
  }

  /**
   * Ranged attack: a ProjectileAttackBehavior (p88) whose Attack templates (p2) name the
   * firing / throwing clips, and something to fire among the character's weapons (p52) or its
   * extra templates (p55): a Ranged Weapon (guards, Slayers; Horace lists his in p55) or a
   * Missile thrown directly (Mainliner needles) [data]. Damage and speed come from the
   * Missile (p26 damage per projectile, RFL 0x100d1921 [code]; p28..p31 are the impact force;
   * p1 speed in units / s), times the weapon's projectile generator count (Object Generator
   * p2); p75 spread (degrees). docs/re/properties.md.
   */
  private ranged(values: PropValue[], types: number[]): RangedProfile | undefined {
    const n = (x: PropValue | undefined, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    const list = (x: PropValue | undefined) => (Array.isArray(x) ? x : [x]).filter((r): r is ResRef => !!r && typeof r === 'object');
    const decode = (r: ResRef | undefined) => {
      const t = r ? readObjectTemplate(this.pkgs, r) : undefined;
      const c = t ? classByHash(t.classHash) : undefined;
      return t && c ? { cls: c.name, v: decodeTemplateProps(c, t) } : undefined;
    };
    // Missile p16: the InvestigateSound of the shot (27 m, level 2 for the guards' bullets) [data].
    // p28..p29 the impact force near / far over p30..p31 m (one record per projectile: a shot's
    // force is one round's, not the sum) [verified: the damage record's +0x1c, docs/game-logic.md §15.13].
    const missile = (m: { v: PropValue[] }, count = 1) => ({ damage: n(m.v[26], 6) * count, speed: n(m.v[1], 200000) / 2048, noise: this.behaviors.noise(list(m.v[16])[0]), type: n(m.v[32], 1), force: { near: n(m.v[28], 0), far: n(m.v[29], 0), nearDist: n(m.v[30], 1000), farDist: n(m.v[31], 1000) } });
    let shot: { damage: number; speed: number; spread?: number; flash?: ResRef; noise?: NoiseSpec; type?: number; force?: RangedProfile['force'] } | undefined;
    let thrown: RangedProfile['thrown'];
    for (const r of [...list(values[CHAR.weapons]), ...list(values[55])]) {
      const w = decode(r);
      // A BouncingObject is thrown (actors/throw.ts): its p1 launch speed, p46 % gravity, p9 reach
      // and p10 fallback elevation, p0 the aim mode [verified, 0x100fd026 / 0x100cc590].
      if (w?.cls === 'BouncingObject') {
        const speed = n(w.v[1], 70000) / ENGINE_UNITS;
        thrown = { template: { pkg: r.pkg, id: r.id }, aimMode: n(w.v[0], 0), aim: { speed, gravity: THROWN_GRAVITY * (n(w.v[46], 100) / 100), reach: n(w.v[9], 0), fallbackDeg: n(w.v[10], 45) } };
        shot = { damage: 0, speed, noise: this.behaviors.noise(list(w.v[16])[0]) };
        break;
      }
      if (w?.cls === 'Ranged Weapon') {
        const gen = decode(list(w.v[81])[0]);
        const m = gen?.cls === 'Object Generator' ? decode(list(gen.v[0])[0]) : undefined;
        const flash = list(w.v[83])[0];
        shot = { ...(m?.cls === 'Missile' ? missile(m, Math.max(1, n(gen!.v[2], 1))) : { damage: 6, speed: 98 }), spread: n(w.v[75], 3), flash };
        break;
      }
      // A Missile listed directly (the Mainliner's needle 10:1814) is thrown on the clip's
      // ThrowWeapon (230) markers like a BouncingObject (0x100fd026 takes either class) and then
      // flies as a real projectile (actors/missile.ts): p1 speed, p46 % of the world's gravity,
      // p9 reach and p10 fallback elevation for the aim, p12 life, p26 damage of type p32, p34 at
      // the impact; its sweep radius is its model's bounds radius [verified, docs/game-logic.md
      // §15.7.4].
      if (w?.cls === 'Missile') {
        shot = missile(w);
        const speed = n(w.v[1], 45000) / ENGINE_UNITS;
        const model = readObjectTemplate(this.pkgs, r)?.modelRef;
        thrown = {
          template: { pkg: r.pkg, id: r.id },
          aimMode: n(w.v[0], 0),
          aim: { speed, gravity: FOUNTAIN_GRAVITY * (n(w.v[46], 100) / 100), reach: n(w.v[9], 0), fallbackDeg: n(w.v[10], 45) },
          missile: {
            damage: n(w.v[26], 0),
            type: n(w.v[32], 1),
            life: n(w.v[12], 5),
            radius: (model && modelBoundsRadius(this.pkgs as unknown as PackageSet, model)) || 0,
            impact: list(w.v[34]),
          },
        };
        break;
      }
    }
    const pa = templateProp(values, types, CHAR.projectile);
    if (!shot || !pa) return undefined;
    const b = decode(pa);
    if (b?.cls !== 'ProjectileAttackBehavior') return undefined;
    // Attacks (ProjectileAttack p2, picked by the p3 weights) [verified: Suffering.rfl
    // ProjectileAttack 0x101569a0; docs/re/animation.md §9 "NPC ranged attacks"]: Attack p0 the
    // firing clip (whole body) and p4 the aim pose on channel p20 (-1, the whole body, in every
    // retail Attack but the Mainliner's 10:210: channel 5); p1 +- p2 the firing clip's rate;
    // p23 shots per attack, p21..p22 s of aim pose between them; p30 = 1 checks the line of
    // fire before each further shot.
    const ref1 = (x: PropValue | undefined) => (x && typeof x === 'object' && !Array.isArray(x) ? { pkg: x.pkg, id: x.id } : undefined);
    const weights = Array.isArray(b.v[3]) ? (b.v[3] as PropValue[]).map((w) => n(w, 0)) : [];
    const attacks: RangedAttack[] = [];
    let range = 30;
    list(b.v[2]).forEach((r, i) => {
      const a = decode(r);
      if (a?.cls !== 'Attack') return;
      const clip = ref1(a.v[0]);
      if (!clip) return;
      attacks.push({
        clip,
        aim: ref1(a.v[4]),
        aimChannel: n(a.v[20], -1),
        rate: n(a.v[1], 1),
        rateSpread: n(a.v[2], 0),
        shots: Math.max(1, Math.round(n(a.v[23], 1))),
        pauseMin: n(a.v[21], 0),
        pauseMax: Math.max(n(a.v[21], 0), n(a.v[22], 0)),
        lineCheck: n(a.v[30], 0) === 1,
        weight: weights.length ? Math.max(0, weights[i] ?? 0) : 1,
        // p19 scales the weapon's spread for this attack (ProjectileAttack fire 0x100fcec0 ->
        // 0x100958e0 -> Ranged Weapon 0x10128310 / 0x10127b30) [verified].
        spreadScale: n(a.v[19], 1),
      });
      range = Math.max(range, Math.min(60, n(a.v[16], 30)));
    });
    if (!attacks.length) return undefined;
    // p6 tracking on [inferred], p21..p25: facing channel bone, cone, pitch limit, turn speed,
    // ease time (docs/re/animation.md §9).
    const tb = n(b.v[6], 1) ? n(b.v[21], -1) : -1;
    const track = tb >= 0 ? { bone: tb, cone: n(b.v[22], 45), pitch: n(b.v[23], 0), speed: n(b.v[24], 90), ease: n(b.v[25], 0.25) } : undefined;
    // p7 / p8 elevation limits, p11 aim bones, p12 split, p13 aim origin bone.
    const aimList = (Array.isArray(b.v[11]) ? b.v[11] : [b.v[11]]).filter((x): x is number => typeof x === 'number' && x >= 0);
    const origin = n(b.v[13], -1);
    const aim = aimList.length && origin >= 0 ? { bones: aimList, split: Math.max(1, n(b.v[12], 1)), origin, min: n(b.v[7], -45), max: n(b.v[8], 45) } : undefined;
    // Pause between attacks: p19..p20 (port reading; the original reads them only with p18 set,
    // 0x100f2cc0, and otherwise leaves the timing to the parent KillProjectile / reposition
    // behaviour, which is not modelled).
    // ProjectileAttackBehavior p5 != 0: a throw keeps the aim point taken when the firing clip
    // started (0x100fd069..0x100fd0b9) [verified]; 18 of 20 retail behaviours set it.
    const keepAim = n(b.v[5], 0) !== 0;
    return { keepAim, attacks, cooldownMin: n(b.v[19], 2), cooldownMax: Math.max(n(b.v[19], 2), n(b.v[20], 4)), range, damage: shot.damage, type: shot.type, force: shot.force, speed: shot.speed, spread: shot.spread ?? 0, flash: shot.flash, noise: shot.noise, thrown, track, aim };
  }

  /**
   * Behaviour at start: the initial behaviour (p68) when it is a dormant one (readDormancy
   * already applied it), else the active behaviour (p69). A p69 DeathBehavior without an
   * initial behaviour is a corpse placed in its death pose; so is a p68 DeathBehavior (5b's
   * raisable CartWheelers, dead from the spawn until Killjoy raises them): neither stands
   * alive before its first AI tick.
   */
  private initBehavior(a: Actor, values: PropValue[], types: number[]) {
    const B = this.behaviors;
    const initial = B.fromTemplate(templateProp(values, types, CHAR.initial));
    const act = a.profile.active;
    if (act?.kind === 'hostile' || act?.kind === 'kill') a.hostile = a.kind.attacks.length > 0 || !!a.profile.ranged;
    else if (act) a.hostile = false;
    if (!initial && act?.kind === 'death') a.profile.corpse = act;
    else if (initial?.kind === 'death' && !a.spawned) a.profile.corpse = initial;
    if (initial?.kind === 'dormant') a.behavior = initial;
    else if (initial?.kind === 'jump' || initial?.kind === 'fall' || initial?.kind === 'ratSpawn') a.behavior = a.spawned ? initial : undefined;
    else if (act?.kind === 'dormant') a.behavior = act;
    else a.behavior = act?.kind === 'death' || a.profile.corpse ? undefined : act;
    a.needsInit = true;
  }

  /** Object Cloner: copy a template character to its placement. */
  clone(template: number, uid?: number): Actor | undefined {
    const src = this.byUid.get(template);
    if (!src?.entity) return undefined;
    const e = src.entity;
    if (uid !== undefined) this.nextCloneUid = Math.max(this.nextCloneUid, uid + 1);
    const a = new Actor(src.kind, feet(e), yawOf(e), e.scale?.[0] ?? 1, e, uid ?? this.nextCloneUid++);
    a.spawned = true;
    const types = classByHash(e.classHash)?.types ?? [];
    a.profile = this.profile(e.values, types);
    this.applyDormancy(a, e, this.pkgs);
    this.initBehavior(a, e.values, types);
    // Spawned in mid-air (JumpBehavior / FallBehavior templates) they drop at once.
    a.needsPlacement = false;
    this.add(a, true);
    (this.clones.get(template) ?? this.clones.set(template, []).get(template)!).push(a);
    return a;
  }

  /** First-frame setup that needs the frame environment (clips, corpses, behaviours). */
  private init(a: Actor, env: ActorEnv) {
    a.needsInit = false;
    if (a.profile.corpse?.kind === 'death') return a.makeCorpse(env, a.profile.corpse);
    // Dead in the save that was applied before this first frame: stays dead.
    if (a.pendingDeath) return a.dieSilently(env);
    if (a.restoredPlaced !== undefined) {
      const placed = env.behaviors?.fromPlaced(a.restoredPlaced);
      a.restoredPlaced = undefined;
      if (placed) a.behavior = placed;
    }
    const b = a.behavior;
    if (!b) return;
    if (b.kind === 'dormant') {
      // Mode 2 waits hidden; mode 1 plays its clip (readDormancy may have done it already).
      const c = env.clip(a, b.clip);
      if (b.mode !== 2 && c >= 0 && !a.ceiling && !a.dormantHidden) a.setDormantIdle(c);
      return;
    }
    // Spawned drop-ins (JumpBehavior / FallBehavior) fall at once.
    if ((b.kind === 'jump' || b.kind === 'fall') && a.dormantHidden) a.dormantHidden = false;
    a.setBehavior(b, env);
    // A restored save: the behaviour goes on where it was (its waypoint, its next line).
    a.resumeSaved(env);
  }

  setWorld(world: CollisionWorld | null) {
    this.world = world;
  }

  /** Spawn a creature from a template ref at a feet position (output space) and yaw. */
  spawn(template: ResRef, position: THREE.Vector3Like, yaw = 0): Actor | undefined {
    const kind = this.kinds.creature(template);
    if (!kind) return undefined;
    // No uid: the 'actors' save provider re-creates uid-less spawned creatures from their template.
    const a = new Actor(kind, position, yaw);
    a.spawned = true;
    const t = readObjectTemplate(this.pkgs, template);
    const cls = t ? classByHash(t.classHash) : undefined;
    if (t && cls) {
      const v = decodeTemplateProps(cls, t);
      a.profile = this.profile(v, cls.types);
      this.initBehavior(a, v, cls.types);
    }
    this.add(a, true);
    return a;
  }

  /** Manage an actor created outside populate() (specials/black-one.ts: non-Character bosses). */
  adopt(a: Actor, drop = false) {
    this.add(a, drop);
  }

  private add(a: Actor, drop: boolean) {
    this.actors.push(a);
    if (a.uid !== undefined && !this.byUid.has(a.uid)) this.byUid.set(a.uid, a);
    this.group.add(a.ch.root);
    // Culled / hidden characters keep their last bone matrices instead of recomputing them
    // every frame (cull() hides the mesh, level logic the root; recomputed when shown again).
    skipMatricesWhileHidden(a.ch.root);
    skipMatricesWhileHidden(a.ch.mesh);
    if (this.world && !a.kind.decor) a.settle(this.world, drop);
    this.emit('spawn', a);
  }

  /** Environment of the current frame (set by the actors system before update). */
  env: ActorEnv | null = null;

  /** Dismemberment (dismember.ts, wired by system.ts): every blow on a body, alive or dead. */
  partHit?: (a: Actor, amount: number, from: THREE.Vector3Like | undefined, by: DamageSource | undefined, hit: ActorHitInfo | undefined) => void;
  /** Ambient Creature damage (PhysicalObject health, death, p26; system.ts). Returns killed. */
  ambientHit?: (a: Actor, amount: number, from: THREE.Vector3Like | undefined, by: DamageSource | undefined) => boolean;
  /** Dead bodies a shot stops at (raycast 'cuttable'): those with Part Caps left. */
  cuttable?: (a: Actor) => boolean;
  /** CapLimb (message 451) without a bone: the Character's p17 list (system.ts -> dismember.ts). */
  capLimb?: (a: Actor) => void;
  /**
   * A blow on a body that is dead after it (a corpse, or the killing blow): explosions throw it,
   * Gonzo / claw blows gib it (system.ts -> gibs.ts: the hit reaction 0x100e6480 runs before the
   * Part Cap test, which still sees the body). True when the body goes.
   */
  corpseHit?: (a: Actor, amount: number, from: THREE.Vector3Like | undefined, by: DamageSource | undefined, hit: ActorHitInfo | undefined) => boolean;

  /**
   * Damage an actor (from: attacker position; by: attacking actor, 'player' / omitted, or a
   * hazard's uid). Returns true if it died. The 'damage' event follows the 'death' one.
   */
  damage(a: Actor, amount: number, from?: THREE.Vector3Like, by?: DamageSource, hit?: ActorHitInfo): boolean {
    if (!this.env || a.template) return false;
    // Ambient Creatures are PhysicalObjects (1 health), not characters (system.ts ambientHit).
    if (a.entity?.className === 'Ambient Creature') return this.ambientHit?.(a, amount, from, by) ?? false;
    // A dead body still takes the blow's part-cap test (Character damage 0x100e7390 runs on
    // corpses too; dismember.ts), nothing else.
    if (!a.alive) {
      if (amount > 0) {
        this.corpseHit?.(a, amount, from, by, hit);
        this.partHit?.(a, amount, from, by, hit);
      }
      return false;
    }
    // Special-move hook (specials/*): hit location / type rules (heads, weak spots, immunity).
    if (a.damageFilter) amount = a.damageFilter(amount, hit, by);
    // GameObject p5 "immune to unlisted" (0x100a2dc0 / 0x100a2950): only the types its Damage
    // Resistances (p7) list hurt it, by their multiplier [verified, fx/gas.ts]. 5b's insanity
    // creature 2c3b (p5 1, 2:870: type 17 x1) takes only the rebirth's ring; a shot no longer
    // fires its Damaged (Relay 2d51: the asylum's last scenes) in the middle of Killjoy's fight.
    // Characters without p5 keep the port's rule (no resistances outside the specials and gas).
    if (hit?.type !== undefined && a.entity && typeof a.entity.values[5] === 'number' && a.entity.values[5] !== 0) amount *= resistanceMultiplier(this.pkgs as never, a.entity.values, hit.type);
    // The hit reaction is picked by the blow's impact force times the resistance's force factor,
    // and the attack stimulus goes out for blows of 0 damage too (Character damage 0x100e776b,
    // amount >= 0) [verified]: Hermes takes no damage from anything, but fire and wind make him
    // react (8b: his reaction's Triggered passes the stove Relay 1f0d).
    const react = hit?.force !== undefined ? hit.force * (hit.type !== undefined && a.entity ? resistanceForceMultiplier(this.pkgs as never, a.entity.values, hit.type) : 1) : undefined;
    if (!(amount > 0) && !(react !== undefined && react > 0)) return false;
    amount = Math.max(0, amount);
    const actor = by instanceof Actor ? by : undefined;
    const killed = a.damage(amount, this.env, from ?? actor?.position, by, hit && { special: hit.special, frameAmount: hit.frameAmount, react });
    if (!(amount > 0)) return killed;
    // The killing blow's gibs (the stimulus' hit reaction), then Part Caps after the health
    // change and the kill (0x100e76e1 follows them).
    // The body's removal is deferred (system.ts), so the Part Cap test still runs on it.
    if (killed) this.corpseHit?.(a, amount, from ?? actor?.position, by, hit);
    if (!a.invulnerable) this.partHit?.(a, amount, from ?? actor?.position, by, hit);
    const info: ActorDamageInfo = { amount, killed, source: sourceId(by), by: actor };
    this.emit('damage', a, info);
    return killed;
  }

  /** Placed characters (level uids) removed by the level logic (saved: they stay gone). */
  readonly removedPlaced = new Set<number>();

  remove(a: Actor) {
    const i = this.actors.indexOf(a);
    if (i < 0) return;
    this.actors.splice(i, 1);
    if (!a.spawned && !a.template && a.entity && a.uid !== undefined) this.removedPlaced.add(a.uid);
    if (a.uid !== undefined && this.byUid.get(a.uid) === a) this.byUid.delete(a.uid);
    if (a.spawned && a.entity) {
      const list = this.clones.get(a.entity.uid);
      const k = list?.indexOf(a) ?? -1;
      if (k >= 0) list!.splice(k, 1);
    }
    a.dispose();
  }

  get(uid: number) {
    return this.byUid.get(uid);
  }

  on(ev: ActorEvent, fn: (a: Actor, info?: unknown) => void) {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(ev: ActorEvent, a: Actor, info?: unknown) {
    for (const fn of this.listeners.get(ev) ?? []) {
      try {
        fn(a, info);
      } catch (err) {
        console.error('[actors] listener', err);
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** AI noises reported since the last update (heard during the next one). */
  private pendingNoises: AiNoise[] = [];
  /** Recent noises (debug / tests: window.__actors.manager.noiseLog). */
  readonly noiseLog: { t: number; x: number; y: number; z: number; radius: number; level: number; source: string }[] = [];

  /**
   * Report an AI noise (an InvestigateSound) at a position: footsteps, shots, impacts
   * (docs/game-logic.md §15.8). Characters with an InvestigateBehavior hear it on the next AI
   * tick when within its radius (+ their p2) and it is loud enough (level >= their p4).
   */
  noise(at: THREE.Vector3Like, spec: NoiseSpec | undefined, source?: 'player' | Actor) {
    if (!spec || !(spec.radius > 0)) return;
    this.pendingNoises.push({ x: at.x, y: at.y, z: at.z, radius: spec.radius, level: spec.level, source });
    this.noiseLog.push({ t: +(this.env?.time ?? 0).toFixed(2), x: +at.x.toFixed(2), y: +at.y.toFixed(2), z: +at.z.toFixed(2), radius: spec.radius, level: spec.level, source: source === 'player' ? 'player' : source ? source.ch.root.name : '-' });
    if (this.noiseLog.length > 50) this.noiseLog.shift();
    if (this.pendingNoises.length > 64) this.pendingNoises.shift();
  }

  update(dt: number, env: ActorEnv, camera: THREE.PerspectiveCamera) {
    this.frame++;
    // Noises live for one AI tick, like the engine's list (0x100e2e60 / 0x100e2ef0).
    env.noises = this.pendingNoises;
    this.pendingNoises = [];
    const cut = this.setCamera(camera);
    const cam = camera.position;
    // The camera is still last frame's sequence camera (the world system poses it after us).
    const cinematic = this.frame - this.cinematicFrame <= 1;
    const t0 = performance.now();
    const st = (this.stats = { total: this.actors.length, visible: 0, awake: 0, animated: 0, ms: this.stats.ms });

    this.separate();

    // The original updates every object every frame; the port lets far idle actors sleep. Not
    // near a busy character on the player's side (a companion fighting or leading 40 m ahead):
    // the creatures there must see him (10's Infernas 7f0 / 7f1 never ignited while the player
    // hung back, and the companion's scene waited on their deaths for good).
    const allies: THREE.Vector3Like[] = [];
    for (const a of this.actors) if (!a.template && a.alive && !a.hostile && !a.kind.decor && a.entity && a.awake && !a.scripted) allies.push(a.position);
    const nearAlly = (p: THREE.Vector3Like) => allies.some((q) => Math.abs(q.x - p.x) < 40 && Math.abs(q.z - p.z) < 40 && Math.hypot(q.x - p.x, q.z - p.z) < 40);

    for (const a of this.actors) {
      if (a.template) continue;
      if (a.needsPlacement) a.place();
      if (a.needsInit) this.init(a, env);
      // Every character updates every frame in the original, asleep or not (actor.ts regenerate).
      a.regenerate(dt);
      // Level logic showing a hidden actor (world system hook sets root.visible) ends dormancy.
      const shown = a.ch.root.visible;
      if (shown && !a.rootShown) a.reveal();
      a.rootShown = shown;
      const p = a.position;
      const h = a.height;
      const dist = Math.hypot(p.x - cam.x, a.bottom + h * 0.5 - cam.y, p.z - cam.z);

      // AI: everything within reach of the player thinks; far idle actors sleep, and
      // far awake ones that are out of sight run at half rate.
      if (!a.kind.decor && (a.awake || dist < 40 || (env.noises.length && a.profile.investigate) || (allies.length && nearAlly(p)))) {
        a.aiAccum += dt;
        const half = dist > 25 && !a.drawn;
        if (!half || (this.frame + a.id) % 2 === 0 || a.aiAccum > 0.1) {
          a.update(a.aiAccum, env);
          a.aiAccum = 0;
        }
      }
      if (a.awake) st.awake++;

      let vis = this.cull(a, dt, cam, dist, cut, cinematic, true);
      vis = vis && !a.hidden;
      if (vis) st.visible++;

      // Animation LOD: hidden idle actors freeze, far ones update at half rate. Not while a
      // sequence drives the actor: it is culled around the hips of its pose, which a stale pose
      // puts metres off (body offsets), and a camera cut must find it at the keyed clip time.
      if (vis || a.awake) {
        a.animate(dt, !a.scripted && (!vis || (dist > FULL_RATE_DISTANCE && (this.frame + a.id) % 2 === 1)));
        st.animated++;
      }
    }
    // Smoothed CPU cost of the actor update (AI + culling + skeletons), for the HUD/tests.
    st.ms += (performance.now() - t0 - st.ms) * 0.05;
  }

  /**
   * Take the camera for this visibility pass: frustum, and whether it cut (jumped or turned
   * sharply since the last pass: sequence camera cuts, teleports), when every occlusion
   * result is stale.
   */
  private setCamera(camera: THREE.PerspectiveCamera): boolean {
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem);
    const dir = camera.getWorldDirection(this.camDir);
    const cut = this.lastCam.distanceToSquared(camera.position) > CUT_DISTANCE * CUT_DISTANCE || dir.dot(this.lastCamDir) < CUT_COS;
    this.lastCam.copy(camera.position);
    this.lastCamDir.copy(dir);
    return cut;
  }

  /**
   * Visibility of one actor. Sets the mesh's visible flag (root.visible belongs to level logic:
   * Visibility Toggler) and returns whether it is drawn, ignoring the root flag.
   *
   * Gameplay: distance, frustum, then a staggered occlusion test (sight lines to the body capsule
   * and to bones of the pose, sight.ts; none for a body in no visible zone), redone at once
   * after a camera cut or when the actor comes into the frustum.
   *
   * Cinematic camera (docs/game-logic.md §15.5 "Actor draw culling"): frustum only, with a
   * looser bound. A shot is framed on its characters, and every occlusion heuristic hid some of
   * them (bars or a door post close to the lens cover the sight lines to the body but not the
   * body; 1a "Goose" lost four of its speakers for up to 2.6 s); the few extra characters drawn
   * behind walls for the length of a cinematic cost little.
   */
  private cull(a: Actor, dt: number, cam: THREE.Vector3, dist: number, cut: boolean, cinematic: boolean, zones = false): boolean {
    const h = a.height;
    let p: { x: number; z: number } = a.position, bottom = a.bottom;
    // A clip can carry the body metres away from the actor's origin: a scripted one (STOMP body
    // offset, docs/game-logic.md §7 / §11.4: in 1a "Gaurd" #280 the guard's body is 7 m from his
    // origin, which sat behind the camera), a dormant creature's hanging from the ceiling (1a's
    // above the lower corridor: 4.5 m up). Cull around the hips.
    const hips = bodyHips(a);
    if (hips) {
      p = hipsWorldPosition(hips, this.hipsPos);
      bottom = this.hipsPos.y - h * 0.5;
      dist = this.hipsPos.distanceTo(cam);
    }
    const sphere = this.sphere;
    sphere.center.set(p.x, bottom + h * 0.5, p.z);
    // The body's bound: its height, or its reach from the hips with room for the animation.
    sphere.radius = Math.max(Math.max(h, 1) * 0.8, bodyModel(a).reach * REACH_SCALE + 0.25);
    const cx = sphere.center.x, cy = sphere.center.y, cz = sphere.center.z, r = sphere.radius;
    // In view around the hips or the origin: an animation key can move the body by metres from
    // one frame to the next, and the hips are last frame's.
    if (cinematic) sphere.radius += CINEMATIC_SLACK;
    let inView = this.frustum.intersectsSphere(sphere);
    if (!inView && hips) {
      sphere.center.set(a.position.x, a.bottom + h * 0.5, a.position.z);
      inView = this.frustum.intersectsSphere(sphere);
    }
    let vis = inView;
    if (cinematic) {
      // Gameplay re-tests occlusion at once when it resumes.
      a.occluded = false;
      a.occlusionTimer = 0;
      this.inFrustum.delete(a);
    } else {
      inView &&= dist - r < this.drawDistance;
      vis = inView;
      const occWorld = this.occlusion?.world() ?? this.world;
      if (inView && occWorld) {
        a.occlusionTimer -= dt;
        if (a.occlusionTimer <= 0 || cut || !this.inFrustum.has(a)) {
          a.occluded =
            dist > 3 &&
            ((zones && this.zoneVisible?.(cx, cy, cz, r) === false) ||
              !(bodyVisible(occWorld, cam, p.x, p.z, bottom, h, a.radius, this.occlusion ? this.occlusion.seeThrough : this.seeThrough) || this.poseVisible(a, cam)));
          a.occlusionTimer = RETEST * (1 + Math.random() * 0.5);
        }
        vis = !a.occluded;
      }
      if (inView) this.inFrustum.add(a);
      else this.inFrustum.delete(a);
    }
    a.ch.mesh.visible = vis && !a.dormantHidden;
    return vis;
  }

  /**
   * Visibility pass only, for a camera posed after this frame's update. The sequence system
   * calls it with the cinematic camera it has just set (the world system runs after the
   * actors): without it the frame after a cut is drawn with the previous shot's culling. It
   * also marks the camera as cinematic for this frame and the next update.
   */
  refreshVisibility(camera: THREE.PerspectiveCamera) {
    // Always re-culled (frustum only: cheap): a cut between shots can be smaller than what
    // setCamera calls a cut, and the frustum of last frame's shot then misses the new one.
    this.cinematicFrame = this.frame;
    this.visibilityPass(camera);
  }

  /**
   * Visibility pass right before the frame is drawn (LevelRenderer.onBeforeDraw, actors
   * system). The player moves the camera after the game systems ran, so update()'s culling is a
   * frame behind the drawn view: a teleport, a respawn or the hand-back after a cinematic drew
   * its first frame with the old view's culling (characters popping in a frame late), and a
   * turn of a couple of degrees per frame outruns the bound of a body 50 m away. Occlusion is
   * only re-tested here after a cut or for a body coming into view (dt 0: no timers run).
   */
  visibilityPass(camera: THREE.PerspectiveCamera) {
    const cut = this.setCamera(camera);
    const cam = camera.position;
    // A cinematic camera was set by the last update (or is being set now: refreshVisibility).
    const cinematic = this.frame - this.cinematicFrame <= 1;
    for (const a of this.actors) {
      if (a.template || a.needsPlacement || a.needsInit) continue;
      const p = a.position;
      this.cull(a, 0, cam, Math.hypot(p.x - cam.x, a.bottom + a.height * 0.5 - cam.y, p.z - cam.z), cut, cinematic);
    }
    this.decor?.update();
  }

  /**
   * Any of the pose's sample bones (head, hands, feet: bodyModel) visible from the camera? Their
   * world matrices are brought up to date first: a hidden mesh's are skipped by the frame pass.
   */
  private poseVisible(a: Actor, cam: THREE.Vector3): boolean {
    const world = this.occlusion?.world() ?? this.world;
    if (!world) return false;
    const bones = a.ch.skeleton.bones;
    const pts = this.posePoints;
    let n = 0;
    for (const i of bodyModel(a).pose) {
      const b = bones[i];
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      pts[n++] = e[12];
      pts[n++] = e[13];
      pts[n++] = e[14];
    }
    return n > 0 && pointsVisible(world, cam, pts.subarray(0, n), this.occlusion ? this.occlusion.seeThrough : this.seeThrough);
  }

  /** Keep awake actors from walking through each other. */
  private separate() {
    const act = this.actors.filter((a) => a.alive && !a.kind.decor && a.awake && !a.hidden);
    for (const a of act) a.push.set(0, 0);
    for (const a of act) {
      for (const b of this.actors) {
        if (a === b || !b.alive || b.kind.decor || b.hidden) continue;
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
        if (Math.abs(a.position.y - b.position.y) > 1.5) continue;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius + 0.1;
        if (d < min && d > 1e-4) a.push.x += (dx / d) * (1 - d / min) * 1.5, a.push.y += (dz / d) * (1 - d / min) * 1.5;
      }
    }
  }

  /**
   * Push the player out of live actors (horizontal). The push goes through the player's own
   * motor (`CharacterMotor.shove`: his capsule swept and slid), so it never puts him into the
   * level: a single waist-high ray let a shove pass a sill or a low wall, and the motor's next
   * depenetration could then take him out on the far side (5b's theatre fight).
   */
  pushPlayer(motor: Pick<CharacterMotor, 'position' | 'shove' | 'cfg'>, held = false) {
    // Not while something else puts the player's feet (`held`: player.motionOverride, a
    // creature's hold, a ladder, a clamber, a locked clip). The Mainliner's ride keeps its rider
    // 0.45 m off his feet every frame; pushed out of it, the pair went 0.3 m a frame across the
    // level, into a heap (1b's sewer) and off its floor (4b's ravine head).
    if (held) return;
    const pos = motor.position, radius = motor.cfg.radius;
    let px = 0, pz = 0;
    for (const a of this.actors) {
      if (!a.alive || a.kind.decor || a.hidden) continue;
      if (pos.y > a.bottom + a.height || pos.y + 1.6 < a.bottom) continue;
      const dx = pos.x - a.position.x, dz = pos.z - a.position.z;
      const d = Math.hypot(dx, dz);
      const min = a.radius + radius;
      if (d < min && d > 1e-4) {
        const push = min - d;
        px += (dx / d) * push;
        pz += (dz / d) * push;
      }
    }
    if (px || pz) motor.shove(px, pz);
  }

  /**
   * Nearest live actor hit by a ray (vertical capsule approximation), not
   * occluded by level geometry closer than `maxDist`.
   */
  raycast(origin: THREE.Vector3Like, dir: THREE.Vector3Like, maxDist: number, includeDead: boolean | 'cuttable' = false): ActorHit | null {
    let best: ActorHit | null = null;
    for (const a of this.actors) {
      // Ambient Creatures are shot like any PhysicalObject while shown (system.ts ambientHit).
      const ambient = a.entity?.className === 'Ambient Creature' && !!this.ambientHit && a.ch.root.visible;
      if ((a.kind.decor && !ambient) || a.hidden) continue;
      if (!a.alive && !(includeDead === true || (includeDead === 'cuttable' && !!this.cuttable?.(a)))) continue;
      const base = { x: a.position.x, y: a.bottom, z: a.position.z };
      const t = rayCapsule(origin, dir, base, a.radius * 1.15, a.alive || a.anchored ? a.height : Math.min(0.6, a.height));
      if (t === null || t > maxDist || (best && t >= best.distance)) continue;
      best = { actor: a, distance: t, point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t) };
    }
    if (best && this.world) {
      // Level geometry in front of the actor hides it, except what the eye sees through
      // (bars, grates: the shot passes them like the weapons' own wall test).
      const p = best.point;
      if (sightBlocked(this.world, origin.x, origin.y, origin.z, p.x, p.y, p.z, 0.05, this.shotThrough ?? this.seeThrough)) return null;
    }
    return best;
  }

  /**
   * Message from the level logic (docs/game-logic.md §6, §15): the Character input slots
   * p11 BlowUp, p12 Destroy, p13/p14 invulnerability on/off, p26 Gib, p136/p137 (Enable /
   * Disable on NPC classes); On wakes a dormant character [data: Object Cloner and STOMP
   * outputs send On to dormant creatures]. Messages to an Object Cloner template reach its
   * clones as well.
   */
  receive(uid: number, message: number, env: ActorEnv) {
    const a = this.byUid.get(uid);
    if (!a) return false;
    if (a.template) {
      let any = false;
      for (const c of this.clones.get(uid) ?? []) any = this.receiveOne(c, message, env) || any;
      return any;
    }
    return this.receiveOne(a, message, env);
  }

  private receiveOne(a: Actor, message: number, env: ActorEnv) {
    const v = a.entity?.values ?? [];
    const slot = (i: number, d: number) => (typeof v[i] === 'number' ? (v[i] as number) : d);
    if (message === slot(12, 12)) this.remove(a);
    else if (message === slot(11, 11) || message === slot(26, 22)) a.die(env);
    else if (message === slot(13, 90)) a.invulnerable = true;
    else if (message === slot(14, 91)) a.invulnerable = false;
    else if (message === a.wakeMessage || message === 1) a.wake(env);
    // CapLimb (451, a fixed input of the Character map: 0x100e3e19): the p17 list (dismember.ts).
    else if (message === 451 && this.capLimb) this.capLimb(a);
    else return false;
    return true;
  }

  dispose() {
    this.decor?.dispose();
    this.decor = null;
    for (const a of this.actors) a.dispose();
    this.actors.length = 0;
    this.byUid.clear();
    this.kinds.dispose();
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}

function feet(e: Entity): THREE.Vector3Like {
  const [x, y, z] = toOutputSpace(e.position);
  return { x, y, z };
}

function yawOf(e: Entity): number {
  const R = instanceRotation(e.rotation);
  return Math.atan2(R[2], R[8]);
}

/** Animation refs of an Animating Static (first non-empty animation-typed list). */
function animList(e: Entity): ClipRef[] {
  const types = classByHash(e.classHash)?.types ?? [];
  for (let i = 0; i < e.values.length; i++) {
    if (((types[i] ?? 0) & 0xff) !== PropType.Animation) continue;
    const v = e.values[i];
    const arr = Array.isArray(v) ? v : [v];
    const refs = arr.filter((x): x is ResRef => !!x && typeof x === 'object');
    if (refs.length) return refs.map((r) => ({ pkg: r.pkg, id: r.id }));
  }
  return [];
}

/** Ray (unit dir) vs vertical capsule standing at `base` (feet). Returns distance or null. */
function rayCapsule(o: THREE.Vector3Like, d: THREE.Vector3Like, base: THREE.Vector3Like, r: number, h: number): number | null {
  // Infinite cylinder in xz.
  const ox = o.x - base.x, oz = o.z - base.z;
  const a = d.x * d.x + d.z * d.z;
  let best: number | null = null;
  const consider = (t: number) => {
    if (t >= 0 && (best === null || t < best)) best = t;
  };
  if (a > 1e-8) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
        const y = o.y + d.y * t - base.y;
        if (y >= 0 && y <= h) consider(t);
      }
    }
  }
  // Caps (flat discs at feet and head are good enough).
  if (Math.abs(d.y) > 1e-6) {
    for (const yy of [base.y, base.y + h]) {
      const t = (yy - o.y) / d.y;
      const x = ox + d.x * t, z = oz + d.z * t;
      if (x * x + z * z <= r * r) consider(t);
    }
  }
  // Origin inside.
  if (ox * ox + oz * oz <= r * r && o.y >= base.y && o.y <= base.y + h) consider(0);
  return best;
}

/**
 * World position of `bone` from the local transforms of it and its ancestors, as
 * `getWorldPosition` would compute it, without writing any matrix (docs/perf.md Perf D: that
 * call recomposed and multiplied the five matrices above the hips, twice per actor and frame,
 * most of the actor time of 9 and 10). Where three.js would keep a node's world matrix (no
 * matrixWorldAutoUpdate: the scene; or no matrixAutoUpdate and no matrixWorldNeedsUpdate) that
 * matrix is used, as it would be; a node without matrixAutoUpdate otherwise contributes its matrix.
 */
export function hipsWorldPosition(bone: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  let o: THREE.Object3D | null = bone;
  out.set(0, 0, 0);
  while (o) {
    if (!o.matrixWorldAutoUpdate || (!o.matrixAutoUpdate && !o.matrixWorldNeedsUpdate)) return out.applyMatrix4(o.matrixWorld);
    if (o.matrixAutoUpdate) out.multiply(o.scale).applyQuaternion(o.quaternion).add(o.position);
    else out.applyMatrix4(o.matrix);
    o = o.parent;
  }
  return out;
}

/** Hips bone of an actor's rig (first bone under the root bone), cached. */
const hipsCache = new WeakMap<Actor, THREE.Bone | null>();
function bodyHips(a: Actor): THREE.Bone | undefined {
  let b = hipsCache.get(a);
  if (b === undefined) {
    const bones = a.ch.skeleton.bones;
    b = bones.find((x) => x.parent === bones[0] && x !== bones[0]) ?? null;
    hipsCache.set(a, b);
  }
  return b ?? undefined;
}

/** Per model geometry (shared by its clones): what the culling needs of its skeleton. */
interface BodyModel {
  /** Bones the occlusion test samples besides the body capsule (head, hands, feet). */
  pose: number[];
  /** Farthest skinned bone from the hips in the bind pose (m). */
  reach: number;
}
const bodyModels = new WeakMap<THREE.BufferGeometry, BodyModel>();

/**
 * The culling's view of a model: POSE_SAMPLES skinned bones spread over the bind pose from the
 * hips (spreadPoints: head, hands, feet for a person), and the body's reach from the hips (some
 * models reach far past their height: 1a's hanging Unspeakables 6 m, its Animating Statics 6.4 m).
 */
function bodyModel(a: Actor): BodyModel {
  const g = a.ch.mesh.geometry;
  let model = bodyModels.get(g);
  if (model) return model;
  const skel = a.ch.skeleton;
  const n = skel.bones.length;
  const weighted = new Uint8Array(n);
  const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
  if (si && sw) {
    for (let v = 0; v < si.count; v++) {
      for (let k = 0; k < 4; k++) {
        const b = si.getComponent(v, k);
        if (b < n && sw.getComponent(v, k) > 0.1) weighted[b] = 1;
      }
    }
  }
  const pos = new Float32Array(3 * n);
  const m = new THREE.Matrix4();
  skel.boneInverses.forEach((inv, i) => {
    const e = m.copy(inv).invert().elements;
    pos.set([e[12], e[13], e[14]], 3 * i);
  });
  const hips = Math.max(0, skel.bones.findIndex((x) => x.parent === skel.bones[0] && x !== skel.bones[0]));
  let reach = 0;
  for (let i = 0; i < n; i++) {
    if (weighted[i]) reach = Math.max(reach, Math.hypot(pos[3 * i] - pos[3 * hips], pos[3 * i + 1] - pos[3 * hips + 1], pos[3 * i + 2] - pos[3 * hips + 2]));
  }
  model = { pose: spreadPoints(pos, (i) => weighted[i] === 1, hips, POSE_SAMPLES), reach };
  bodyModels.set(g, model);
  return model;
}
