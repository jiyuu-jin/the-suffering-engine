// The player's creature form: body (System model 2:124, anim set 379), locomotion,
// attacks, and the morph animations, all from the creature Player template (2:240)
// and its Player Weapon Properties (2:241) / Attack templates.
//
// Clip roles come from the templates, not from guesses:
//   Player Weapon Properties  p13 idle, p18/p19 forward walk + speed, p20/p21 forward run
//                             + speed, p23/p25 (135 deg), p28/p30 (225 deg), p33/p35 (315 deg)
//                             walk/run, p86 attack combo, p89 alternate attacks, p90 jump attack
//   Attack                    p0 clip, p3 follow-up clip, p6 damage scale [inferred]
//   Character Morpher         p3 morph clip, p4 duration (2:371 human -> creature on the
//                             creature rig, 2:372 creature -> human on the human rig)
//   Player p254               the morph's lead-in on the form's own rig (human 2:154, creature
//                             2:157); its MorphCharacter event (220) starts the morpher
//
// A morph (Player state 19, docs/game-logic.md §13.10): the old form plays its p254 clip; at the
// clip's MorphCharacter marker the new form appears at the player playing the morpher's p3 and
// the two cross-fade over the morpher's p4 (rules.ts morpherFade); at its end the new form stays.
// Both rigs run on real time (the game clock is slowed to 1 / p272 meanwhile).
//   Player p275               insanity attack acquisition clip (state 30)
//   Insanity Attack Template  p2 the attack clip (state 29)
//
// The human body (actors system) stays alive while transformed; this module only swaps
// what PlayerController.setModel() shows and hides the first-person viewmodel layer.

import * as THREE from 'three/webgpu';
import type { PackageSet, ResRef } from '../../formats/model';
import { readSkinnedModel } from '../../formats/skeleton';
import type { AnimClipData } from '../../formats/animation';
import { Character, decodeCharacterTextures } from '../../app/character';
import type { PlayerController, PlayerFrame } from '../../app/player';
import { loadClip, readClipEvents } from '../actors/clipmap';
import { morpherFade } from './rules';
import { readAnimEvents } from '../../formats/animation';
import { boneName } from '../../formats/skeleton';
import type { AttackParams, FormParams } from './params';
import { CREATURE_MELEE_FACE, MeleeAutoFace, readMeleeFaceParams, type FaceCandidate, type MeleeFaceParams } from '../weapons/melee-face';
import { MeleeLunge, lungeToWorld, meleeRootScale } from '../weapons/melee-lunge';
import { CREATURE_WEAPON_SHAPES, armWindows, creatureBlowOutcome, meleeDamage, reputationDamageScale, strikeTarget, type ArmWindow, type MeleeShape, type Vec3 } from './melee';
import type { HitSphereLike } from '../actors/npc-melee';

const key = (r: ResRef) => `${r.pkg}:${r.id}`;

/** Duck-typed actor (src/game/actors/actor.ts). */
export interface ActorLike {
  readonly position: THREE.Vector3Like;
  readonly alive: boolean;
  readonly hidden?: boolean;
  readonly radius?: number;
  readonly height?: number;
  /** World y of the lowest point of the body (Actor.bottom; feet when missing). */
  readonly bottom?: number;
  /** Decorations (Animating Static) are actors too; never targets. */
  readonly kind?: { decor?: boolean; className?: string };
  /** Team template key (the player's own team takes nothing from the player). */
  readonly team?: string;
  /** A dead body with Part Caps left (actors/dismember.ts): blows still land on it. */
  readonly cuttable?: boolean;
  /** Placed entity: NPC p167 marks Torque's vision selves. */
  readonly entity?: { values?: readonly unknown[] };
}

export interface CreatureHit {
  actors: ActorLike[];
  damage: number;
  /** Damage type of the form's arm weapons (Melee Weapon p70). */
  kind?: number;
  /** Contact point on the weapon (world). */
  point?: Vec3;
  /**
   * The struck leaf hit sphere's bone (damage record +0x20): the Part Cap test cuts by it
   * (actors/dismember.ts). Absent when the target has no sphere tree (capsule stand-in).
   */
  bone?: number;
  /** Impact force: Melee Weapon p69 x the Attack's p7 (damage record +0x1c, 0x100caa7d). */
  force?: number;
  /** A Torque vision (p167 = 2) struck while transformed: the blow lands on the player. */
  reflect?: boolean;
}

/** What the sweep needs from the world (src/game/insanity/system.ts). */
export interface MeleeWorld {
  actors: readonly ActorLike[];
  /** True when level geometry blocks the segment (the wall check 0x100c9490). */
  blocked?(from: Vec3, to: Vec3): boolean;
  /** Reputation (Player +0x454) for the Unspeakable NPC scale. */
  reputation?: number;
  /** The player's team template key. */
  playerTeam?: string;
  /** Leaf hit spheres of a body as posed now, in node index order, with their bones: what blows are swept against. */
  spheres?(a: ActorLike): readonly HitSphereLike[];
  /** Auto-target priority of an actor (its character template's p128; default 10). */
  priority?(a: ActorLike): number;
}

/** Melee auto-face rate (Player p173, deg/s): the body turns to the swing's target. */
export const MELEE_FACE_RATE_DEG = CREATURE_MELEE_FACE.rateDeg;

class ClipSet {
  readonly clips: AnimClipData[] = [];
  private index = new Map<string, number>();
  constructor(private readonly pkgs: PackageSet, private readonly animSet: number) {}
  add(r: ResRef | undefined): number {
    if (!r) return -1;
    const k = key(r);
    const have = this.index.get(k);
    if (have !== undefined) return have;
    const c = loadClip(this.pkgs, r);
    if (!c || c.animSet !== this.animSet) {
      this.index.set(k, -1);
      return -1;
    }
    this.index.set(k, this.clips.length);
    this.clips.push(c);
    return this.clips.length - 1;
  }
  get(r: ResRef | undefined): number {
    return r ? (this.index.get(key(r)) ?? -1) : -1;
  }
}

type Role = 'idle' | 'walk' | 'run' | 'back' | 'left' | 'right' | 'backRun' | 'leftRun' | 'rightRun';

/** MorphCharacter (message 220): the lead-in clip's marker that spawns the Character Morpher. */
export const MORPH_CHARACTER = 220;

/** A lead-in clip (p254) on one rig: its index, length, morph marker time and sound cues. */
interface LeadIn {
  clip: number;
  duration: number;
  morphAt: number;
  sounds: { time: number; keys: string[] }[];
}

/** The running morph (both directions). */
interface MorphRun {
  dir: 'in' | 'out';
  /** Real seconds since the morph started. */
  t: number;
  from: Character;
  to: Character;
  lead?: LeadIn;
  /** Seconds before the morpher starts (the lead-in's marker; 0 without a lead-in). */
  morphAt: number;
  /** The morpher's p3 clip on `to` (-1: none) and its p4 / p5. */
  toClip: number;
  fade: number;
  cosine: boolean;
  started: boolean;
  played: number;
}

/** Per-material state kept while a rig is drawn translucent. */
const opaqueState = new WeakMap<THREE.Material, { transparent: boolean; depthWrite: boolean; opacity: number }>();

/** A rig's opacity (the engine object's +0xd0 the morpher writes): 1 restores its own materials. */
export function setRigOpacity(ch: Character, op: number) {
  const mats = Array.isArray(ch.mesh.material) ? ch.mesh.material : [ch.mesh.material];
  for (const m of mats) {
    let st = opaqueState.get(m);
    if (op >= 1) {
      if (!st) continue;
      if (m.transparent !== st.transparent || m.depthWrite !== st.depthWrite) m.needsUpdate = true;
      m.transparent = st.transparent;
      m.depthWrite = st.depthWrite;
      m.opacity = st.opacity;
      opaqueState.delete(m);
      continue;
    }
    if (!st) opaqueState.set(m, (st = { transparent: m.transparent, depthWrite: m.depthWrite, opacity: m.opacity }));
    if (!m.transparent) {
      m.transparent = true;
      m.depthWrite = false;
      m.needsUpdate = true;
    }
    m.opacity = st.opacity * Math.max(0, op);
  }
}

export class CreatureBody {
  readonly ch: Character;
  /** Human rig of the morphs (the human's lead-in and the morph back; the creature model is shown before). */
  private humanRig?: Character;
  /** Both rigs: what PlayerController.setModel() shows while transformed or morphing. */
  readonly group = new THREE.Group();
  /** Morph clips: the morph-in's p3 on the creature, the morph-back's p3 on the human rig. */
  private humanMorph = -1;
  private leadIn?: LeadIn;
  private leadOut?: LeadIn;
  private run: MorphRun | null = null;
  /** Sound cues of the lead-in clips (keys "pkg:id", one picked at random), for the system to play. */
  onSound?: (keys: string[]) => void;
  private roles = new Map<Role, number>();
  private speeds = new Map<Role, number>();
  private combo: { a: AttackParams; clip: number }[] = [];
  private alt: { a: AttackParams; clip: number }[] = [];
  private jump: { a: AttackParams; clip: number }[] = [];
  private morphIn = -1;
  /** One-shot clips by ref key (insanity attacks, acquisition). */
  private specials = new Map<string, number>();
  private current = -1;
  private oneShotUntil = 0;
  private time = 0;
  private comboStep = 0;
  private lastAttack = -1e9;
  /** The running swing: its Arm windows, swept weapon points and the targets already hit. */
  private swing: {
    clip: number;
    scale: number;
    /** The Attack's p7 (x Melee Weapon p69: the blow's impact force). */
    forceScale: number;
    windows: { w: ArmWindow; weapon: ArmWeapon; prev?: [Vec3, Vec3]; swept: boolean; hit: Set<ActorLike> }[];
  } | null = null;
  /** Melee auto-face (weapons/melee-face.ts: the human's pick and turn with 2:240's values). */
  private readonly autoFace = new MeleeAutoFace();
  private readonly faceParams: MeleeFaceParams;
  /** The swing's root motion (weapons/melee-lunge.ts); `alt`: a p89 attack (class 3, never scaled). */
  private readonly lunge = new MeleeLunge();
  private lungeAlt = false;
  private lungeTarget = false;
  private lungePlayer: PlayerController | null = null;
  /** Arm windows per clip index (from the clips' Arm / Disarm events). */
  private windows = new Map<number, ArmWindow[]>();
  /** The form's arm weapons by bone hash. */
  private weapons = new Map<number, ArmWeapon>();
  /** Speed ratio of the creature's forward run to the human's (template speeds). */
  readonly speedScale: number;

  private constructor(
    readonly creature: FormParams,
    readonly human: FormParams,
    skinned: NonNullable<ReturnType<typeof readSkinnedModel>>,
    clips: ClipSet,
    pkgs: PackageSet,
  ) {
    const loc = creature.locomotion;
    const addRole = (role: Role, r: ResRef | undefined, speed?: number) => {
      const i = clips.add(r);
      if (i >= 0) this.roles.set(role, i);
      if (speed) this.speeds.set(role, speed);
    };
    addRole('idle', loc?.idle);
    addRole('walk', loc?.walk?.clip, loc?.walk?.speed);
    addRole('run', loc?.run?.clip, loc?.run?.speed);
    addRole('right', loc?.right?.walk);
    addRole('rightRun', loc?.right?.run);
    addRole('back', loc?.back?.walk);
    addRole('backRun', loc?.back?.run);
    addRole('left', loc?.left?.walk);
    addRole('leftRun', loc?.left?.run);
    const atk = creature.attacks;
    const map = (list: AttackParams[] | undefined) => (list ?? []).map((a) => ({ a, clip: clips.add(a.clip) })).filter((x) => x.clip >= 0);
    this.combo = map(atk?.combo);
    this.alt = map(atk?.alt);
    this.jump = map(atk?.jump);
    this.morphIn = clips.add(human.morph?.clip);
    const creatureLead = clips.add(creature.morphLead);
    for (const r of [creature.acquireClip, ...creature.insanityAttackDefs.map((a) => a.clip), ...human.insanityAttackDefs.map((a) => a.clip)]) {
      if (r && clips.add(r) >= 0) this.specials.set(key(r), clips.get(r));
    }
    this.ch = new Character(skinned, clips.clips, decodeCharacterTextures(skinned, pkgs));
    this.ch.root.name = 'player-creature';
    // Arm windows of the attack clips and the arm weapons on their bones.
    for (const { a, clip } of [...this.combo, ...this.alt, ...this.jump]) {
      const r = a.clip;
      const adu = r ? pkgs.get(r.pkg)?.adu : undefined;
      const ev = adu && r ? readAnimEvents(adu, r.id) : undefined;
      this.windows.set(clip, ev ? armWindows(ev.events, this.ch.clipData[clip].duration) : []);
    }
    for (const w of creature.armWeapons) {
      const hash = skinned.skeleton.bones[w.bone]?.hash;
      const shape = CREATURE_WEAPON_SHAPES[`${w.template.pkg}:${w.template.id}`];
      const node = hash !== undefined ? this.ch.root.getObjectByName(boneName(hash)) : undefined;
      if (hash !== undefined && shape && node) this.weapons.set(hash >>> 0, { node, shape, damage: w.damage, force: w.force, type: w.type ?? creature.hitDamageType });
    }
    this.ch.root.visible = false;
    this.group.name = 'player-insanity-forms';
    this.group.add(this.ch.root);
    if (creatureLead >= 0) this.leadOut = leadIn(pkgs, creature.morphLead!, creatureLead, this.ch.clipData[creatureLead]);
    const humanRun = human.locomotion?.run?.speed ?? 6.6;
    const creatureRun = loc?.run?.speed ?? humanRun;
    this.speedScale = Math.min(2, Math.max(0.5, creatureRun / humanRun));
    this.faceParams = readMeleeFaceParams(creature.values, CREATURE_MELEE_FACE);

    // Human rig: the morph-back clip (the creature's Character Morpher p3) and the human's lead-in (p254).
    const back = creature.morph;
    const humanModel = human.model ?? back?.model;
    const hs = humanModel ? readSkinnedModel(pkgs, humanModel) : undefined;
    if (hs) {
      const hClips = new ClipSet(pkgs, hs.animSet);
      const backClip = hClips.add(back?.clip);
      const lead = hClips.add(human.morphLead);
      if (hClips.clips.length) {
        this.humanRig = new Character(hs, hClips.clips, decodeCharacterTextures(hs, pkgs));
        this.humanRig.root.name = 'player-morph-back';
        this.humanRig.root.visible = false;
        this.group.add(this.humanRig.root);
        this.humanMorph = backClip;
        if (lead >= 0) this.leadIn = leadIn(pkgs, human.morphLead!, lead, this.humanRig.clipData[lead]);
      }
    }
  }

  static create(pkgs: PackageSet, creature: FormParams, human: FormParams): CreatureBody | null {
    if (!creature.model) return null;
    const skinned = readSkinnedModel(pkgs, creature.model);
    if (!skinned) return null;
    const clips = new ClipSet(pkgs, skinned.animSet);
    const body = new CreatureBody(creature, human, skinned, clips, pkgs);
    return body.roles.has('idle') || body.roles.has('walk') ? body : null;
  }

  get attackCount() {
    return { combo: this.combo.length, alt: this.alt.length, jump: this.jump.length };
  }

  /** The creature rig's root. */
  get root() {
    return this.ch.root;
  }

  get humanRoot() {
    return this.humanRig?.root;
  }

  private play(i: number, o: { loop?: boolean; fade?: number; timeScale?: number } = {}) {
    if (i < 0) return;
    this.ch.play(i, { loop: o.loop ?? true, fade: o.fade ?? 0.15, timeScale: o.timeScale ?? 1 });
    this.current = i;
  }

  /** Real seconds of a morph's lead-in before its morpher starts (0: the morpher starts at once). */
  leadSeconds(dir: 'in' | 'out'): number {
    const lead = dir === 'in' ? (this.humanRig ? this.leadIn : undefined) : this.leadOut;
    return lead ? lead.morphAt : 0;
  }

  /**
   * Start a morph (Morph state enter, 0x10044e70): the old form's rig plays its lead-in (p254);
   * at its MorphCharacter marker the new form appears playing the morpher's p3 (0x10044970 ->
   * Character Morpher init 0x100101c0) and the two cross-fade over p4 (update 0x10010510). Without
   * the human rig (no 2:9) a morph-in shows the creature at once.
   */
  startMorph(dir: 'in' | 'out', morpher: { duration: number; cosine?: boolean } | undefined) {
    this.swing = null;
    this.stopLunge();
    if (this.autoFace.active) this.autoFace.stop();
    const human = this.humanRig;
    const fade = Math.max(0.05, morpher?.duration ?? 1);
    const cosine = morpher?.cosine ?? true;
    if (!human) {
      // No human rig: the creature alone (its morph clip on the way in, nothing on the way out).
      this.ch.root.visible = dir === 'in';
      if (dir === 'in' && this.morphIn >= 0) this.play(this.morphIn, { loop: false, fade: 0 });
      this.run = null;
      return;
    }
    const from = dir === 'in' ? human : this.ch;
    const to = dir === 'in' ? this.ch : human;
    const lead = dir === 'in' ? this.leadIn : this.leadOut;
    for (const r of [from, to]) setRigOpacity(r, 1);
    from.root.visible = true;
    to.root.visible = false;
    if (lead) {
      from.play(lead.clip, { loop: false, fade: dir === 'out' ? 0.2 : 0 });
      if (from === this.ch) this.current = lead.clip;
    }
    this.run = {
      dir,
      t: 0,
      from,
      to,
      lead,
      morphAt: lead ? lead.morphAt : 0,
      toClip: dir === 'in' ? this.morphIn : this.humanMorph,
      fade,
      cosine,
      started: false,
      played: 0,
    };
    this.oneShotUntil = Number.POSITIVE_INFINITY;
    this.stepMorph(0);
  }

  /** The transformed form at once (a loaded save, a cancelled morph-in's end pose): the creature, opaque. */
  showCreature() {
    this.run = null;
    if (this.humanRig) (this.humanRig.root.visible = false), setRigOpacity(this.humanRig, 1);
    setRigOpacity(this.ch, 1);
    this.ch.root.visible = true;
    this.oneShotUntil = this.time;
    this.current = -1;
    this.play(this.roles.get('idle') ?? -1, { fade: 0 });
  }

  /** The morph ended (the form it went to is shown by the system). */
  endMorph() {
    const run = this.run;
    this.run = null;
    this.oneShotUntil = this.time;
    if (!run) return;
    setRigOpacity(run.from, 1);
    setRigOpacity(run.to, 1);
    if (run.dir === 'in') {
      if (this.humanRig) this.humanRig.root.visible = false;
      this.ch.root.visible = true;
      // The creature goes on from the morpher's clip into its locomotion (Morph leave plays p13).
      this.current = -1;
    }
  }

  /** The running morph (debug / tests): direction, real time, opacities, the morpher started. */
  get morphState() {
    const r = this.run;
    if (!r) return null;
    const f = r.started ? morpherFade(r.t - r.morphAt, r.fade, r.cosine) : { from: 1, to: 0 };
    return { dir: r.dir, t: r.t, morphAt: r.morphAt, started: r.started, from: f.from, to: f.to, orbit: this.orbit };
  }

  /**
   * Camera orbit during a morph (radians): the Player's +0x4aa = 360 deg x the lead-in clip's
   * played fraction while the old form plays it (1 otherwise; 0x100443e0), negative on the way
   * back (0x10044832..0x10044851), turned about the player by the camera code (0x1000419a).
   */
  get orbit(): number {
    const r = this.run;
    if (!r || !r.lead) return 0;
    const a = r.from.current;
    const clip = r.from.clips[r.lead.clip];
    const f = a && a.getClip() === clip ? Math.min(1, a.time / Math.max(1e-3, r.lead.duration)) : 1;
    return (r.dir === 'out' ? -1 : 1) * 2 * Math.PI * f;
  }

  /** A morph step on real time: the morpher's start at the marker, the cross-fade, the lead-in's sounds. */
  private stepMorph(dt: number) {
    const r = this.run;
    if (!r) return;
    r.t += dt;
    const sounds = r.lead?.sounds ?? [];
    while (r.played < sounds.length && sounds[r.played].time <= r.t) this.onSound?.(sounds[r.played++].keys);
    if (!r.started && r.t >= r.morphAt) {
      r.started = true;
      r.to.root.visible = true;
      if (r.toClip >= 0) {
        r.to.play(r.toClip, { loop: false, fade: 0 });
        if (r.to === this.ch) this.current = r.toClip;
      }
    }
    if (r.started) {
      const f = morpherFade(r.t - r.morphAt, r.fade, r.cosine);
      setRigOpacity(r.from, f.from);
      setRigOpacity(r.to, f.to);
    } else setRigOpacity(r.to, 0);
    if (r.from.root.visible) r.from.update(dt);
    if (r.to.root.visible) r.to.update(dt);
  }

  hide() {
    this.run = null;
    this.ch.root.visible = false;
    setRigOpacity(this.ch, 1);
    if (this.humanRig) (this.humanRig.root.visible = false), setRigOpacity(this.humanRig, 1);
    this.swing = null;
    this.current = -1;
    this.oneShotUntil = this.time;
    this.stopLunge();
  }

  /** End the swing's root motion and give the stick back (MeleeAttack leaves). */
  private stopLunge() {
    this.lunge.stop();
    if (this.lungePlayer) this.lungePlayer.holdMove = false;
    this.lungePlayer = null;
  }

  /** The swing's root motion (debug / tests): playing, model-space distance so far. */
  get lungeState() {
    return { active: this.lunge.active, moved: { ...this.lunge.moved }, alt: this.lungeAlt, target: !!this.autoFace.target };
  }

  get busy() {
    return this.time < this.oneShotUntil;
  }

  /**
   * A one-shot special clip (insanity attack p2, acquisition p275). Returns its duration (s),
   * 0 when the clip is not on the creature rig.
   */
  special(r: ResRef | undefined): number {
    const i = r ? (this.specials.get(key(r)) ?? -1) : -1;
    if (i < 0 || !this.ch.root.visible) return 0;
    const clip = this.ch.clipData[i];
    const dur = Math.max(0.2, clip.duration / (clip.rate || 1));
    this.swing = null;
    this.stopLunge();
    this.play(i, { loop: false, fade: 0.08 });
    this.oneShotUntil = this.time + dur;
    return dur;
  }

  /**
   * Attack: 'combo' cycles the p86 chain (the next swing within 0.6 s of the last one ending
   * continues the chain), 'alt' the p89 attacks. The form has no air attack (PWP p164 empty) and
   * never reads its p90 list, so 'jump' does nothing. Damage comes from the strike clip's Arm
   * windows (melee.ts); a clip without them (alternate 2:370) only animates.
   */
  attack(kind: 'combo' | 'alt' | 'jump', world?: MeleeWorld, player?: PlayerController): boolean {
    if (this.busy || kind === 'jump') return false;
    const list = kind === 'combo' ? this.combo : this.alt;
    if (!list.length) return false;
    let pick = list[0];
    if (kind === 'combo') {
      if (this.time - this.lastAttack > 0.6) this.comboStep = 0;
      pick = list[this.comboStep % list.length];
      this.comboStep++;
    } else pick = list[Math.floor(Math.random() * list.length)];
    const clip = this.ch.clipData[pick.clip];
    const dur = Math.max(0.2, clip.duration / (clip.rate || 1));
    this.play(pick.clip, { loop: false, fade: 0.06 });
    this.oneShotUntil = this.time + dur * 0.9;
    this.lastAttack = this.time + dur;
    const windows = (this.windows.get(pick.clip) ?? []).flatMap((w) => {
      const weapon = this.weapons.get(w.bone);
      return weapon ? [{ w, weapon, swept: false, hit: new Set<ActorLike>() }] : [];
    });
    this.swing = { clip: pick.clip, scale: pick.a.scale, forceScale: pick.a.forceScale ?? 1, windows };
    if (player) this.autoFace.start(player, Math.hypot(player.velocity.x, player.velocity.z) > 0.2);
    // Root motion (melee-lunge.ts): the strike's root carries the form; MeleeAttack ends Move.
    if (player && player.mode === 'tp') {
      this.lunge.start(clip);
      this.lungeAlt = kind === 'alt';
      this.lungeTarget = false;
      if (!player.holdMove && player.onGround) player.motor.velocity.x = player.motor.velocity.z = 0;
      player.holdMove = true;
      this.lungePlayer = player;
    }
    return true;
  }

  /** Pick candidates: live actors the claws may strike (object positions, template p128). */
  private faceCandidates(world: MeleeWorld): FaceCandidate<ActorLike>[] {
    const out: FaceCandidate<ActorLike>[] = [];
    for (const a of world.actors) {
      if (!a.alive || a.kind?.decor || creatureBlowOutcome(this.targetOf(a), world.playerTeam ?? '') === 'skip') continue;
      out.push({ x: a.position.x, y: a.position.y, z: a.position.z, priority: world.priority?.(a) ?? 10, ref: a });
    }
    return out;
  }

  private targetOf(a: ActorLike) {
    const v = a.entity?.values?.[167];
    return { alive: a.alive, hidden: a.hidden, decor: a.kind?.decor, team: a.team, vision: typeof v === 'number' ? v : undefined, cuttable: a.cuttable };
  }

  /** Per frame (from PlayerController.onUpdate while shown). Returns hits that land now. */
  update(f: PlayerFrame, player: PlayerController, world: MeleeWorld | readonly ActorLike[] | undefined, locomotion: boolean, realDt = f.dt): CreatureHit[] {
    const w: MeleeWorld = Array.isArray(world) ? { actors: world } : ((world as MeleeWorld | undefined) ?? { actors: [] });
    this.time += f.dt;
    // A morph runs on real time (the clock is at 1 / p272; Torque's clips at x p272).
    if (this.run) return this.stepMorph(realDt), [];
    if (!this.ch.root.visible) return [];
    if (locomotion && !this.busy) this.locomotion(f);
    if (this.swing && this.current !== this.swing.clip) this.swing = null;
    if (this.swing) this.face(player, f.dt, w);
    else if (this.autoFace.active) this.autoFace.stop();
    if (this.lunge.active) {
      // The port hands the body back to locomotion at 90 % of the clip: the rest of the root
      // goes with that frame, so a swing moves its whole root track like the original's.
      // (The ended swing has dropped its pick: the tail keeps the last frame's.)
      const end = !this.swing || !this.busy;
      if (!end) this.lungeTarget = !!this.autoFace.target;
      const d = this.lunge.step(end ? 1e3 : f.dt, meleeRootScale({ onGround: f.onGround, target: this.lungeTarget, alternate: this.lungeAlt, p85: this.creature.lungeScale ?? 1 }));
      const m = lungeToWorld(d.x, d.z, player.bodyYaw);
      player.rootMove.x += m.x;
      player.rootMove.z += m.z;
      if (end) this.stopLunge();
    }
    this.ch.update(f.dt);
    return this.sweep(player, w);
  }

  /**
   * Melee auto-face every frame of the swing (the creature runs states 4 / 32 too): the pick
   * from the body's facing in 2:240's p223 = 105° cone within its PWP 2:241 p10 = 6 m, nearest
   * first (p224 0.1 / p225 1), and the turn at p173 = 350 deg/s of the view and the body together.
   */
  private face(player: PlayerController, dt: number, w: MeleeWorld) {
    const blocked = w.blocked;
    const p = player.position;
    const ends = (c: FaceCandidate<ActorLike>): [Vec3, Vec3] => {
      const a = c.ref;
      return [[p.x, p.y + 1.2, p.z], [a.position.x, (a.bottom ?? a.position.y) + (a.height ?? 1.8) * 0.6, a.position.z]];
    };
    this.autoFace.step(player, dt, this.faceParams, this.creature.meleeRange ?? 6, this.faceCandidates(w), blocked ? (c) => blocked(...ends(c)) : undefined);
  }

  /** Sweeps the armed weapons (melee.ts) and returns the blows that landed this frame. */
  private sweep(player: PlayerController, w: MeleeWorld): CreatureHit[] {
    const sw = this.swing;
    const act = this.ch.current;
    if (!sw || !act) return [];
    const t = act.time;
    const hits: CreatureHit[] = [];
    const team = w.playerTeam ?? '';
    for (const win of sw.windows) {
      // Armed from the Arm to the Disarm; a window skipped over in one frame still sweeps once.
      const armed = t >= win.w.t0 && (t <= win.w.t1 || !win.swept);
      if (!armed) continue;
      win.weapon.node.updateWorldMatrix(true, false);
      const cur = shapePoints(win.weapon.shape, win.weapon.node.matrixWorld.elements);
      const prev = win.prev ?? cur;
      win.prev = cur;
      win.swept = true;
      for (const a of w.actors) {
        if (win.hit.has(a)) continue;
        const outcome = creatureBlowOutcome(this.targetOf(a), team);
        if (outcome === 'skip') continue;
        const r = a.radius ?? 0.4;
        const y0 = a.bottom ?? a.position.y;
        const cap = { x: a.position.x, z: a.position.z, y0, y1: y0 + (a.height ?? 1.8), r };
        // The target's leaf hit spheres, walked in node index order: the first one the swept
        // shape meets is struck and its bone goes with the blow (0x100c9680; the Part Cap test
        // cuts by it, actors/dismember.ts), alive or dead (melee.ts strikeTarget). The spheres
        // are posed only for bodies within REACH_SLACK of the standing capsule.
        const struck = strikeTarget(prev[0], prev[1], cur[0], cur[1], win.weapon.shape.r, cap, () => w.spheres?.(a) ?? [], a.alive, REACH_SLACK);
        if (!struck) continue;
        const p = struck.p;
        win.hit.add(a); // once per target per Arm window, whatever the outcome
        if (w.blocked?.([player.position.x, p[1], player.position.z], p)) continue;
        const npc = a.kind?.className === 'Unspeakable NPC' ? reputationDamageScale(w.reputation ?? 0, [this.human.reputationRange[0], this.human.reputationRange[1]], this.creature.npcDamageScale) : 1;
        const bone = struck.bone;
        hits.push({
          actors: [a],
          damage: meleeDamage(win.weapon.damage, sw.scale, npc),
          kind: win.weapon.type,
          point: p,
          ...(bone !== undefined && bone >= 0 ? { bone } : {}),
          ...(win.weapon.force !== undefined ? { force: win.weapon.force * sw.forceScale } : {}),
          reflect: outcome === 'reflect',
        });
      }
    }
    return hits;
  }

  private locomotion(f: PlayerFrame) {
    let role: Role = 'idle';
    let ts = 1;
    if (f.speed > 0.3) {
      const ang = Math.atan2(f.localVelocity.x, f.localVelocity.z) * (180 / Math.PI);
      const a = Math.abs(ang);
      const run = f.running || f.speed > 5;
      if (a <= 50) role = run ? 'run' : 'walk';
      else if (a < 135) role = ang < 0 ? (run ? 'leftRun' : 'left') : run ? 'rightRun' : 'right';
      else role = run ? 'backRun' : 'back';
      if (!this.roles.has(role)) role = run && this.roles.has('run') ? 'run' : 'walk';
      const natural = this.speeds.get(role) ?? this.speeds.get(run ? 'run' : 'walk') ?? f.speed;
      ts = Math.min(2, Math.max(0.5, f.speed / Math.max(0.5, natural)));
    }
    const i = this.roles.get(role) ?? this.roles.get('idle') ?? -1;
    if (i !== this.current) this.play(i, { fade: 0.2 });
    const rate = this.ch.clipData[i]?.rate || 1;
    if (this.ch.current) this.ch.current.timeScale = ts * rate;
  }

  dispose() {
    this.group.removeFromParent();
    this.ch.dispose();
    this.humanRig?.dispose();
  }
}

/** A lead-in clip's MorphCharacter marker (its end without one) and sound cues. */
function leadIn(pkgs: PackageSet, r: ResRef, clip: number, data: AnimClipData): LeadIn {
  const adu = pkgs.get(r.pkg)?.adu;
  const ev = adu ? readAnimEvents(adu, r.id) : undefined;
  const rate = data.rate || 1;
  const duration = data.duration / rate;
  const mark = ev?.events.find((e) => e.kind === 1 && e.param === MORPH_CHARACTER);
  const sounds = adu ? readClipEvents(adu, r.id).sounds.map((x) => ({ time: x.time / rate, keys: x.keys })) : [];
  return { clip, duration, morphAt: mark ? Math.min(duration, mark.time / rate) : duration, sounds: sounds.sort((a, b) => a.time - b.time) };
}

interface ArmWeapon {
  node: THREE.Object3D;
  shape: MeleeShape;
  damage: number;
  /** Melee Weapon p69: the impact force (x the Attack's p7). */
  force?: number;
  type?: number;
}

/**
 * Broad phase of the sphere sweep (m): how far a leaf sphere may stand outside the actor's
 * standing capsule (outstretched arms, a CartWheeler's blades) [port].
 */
const REACH_SLACK = 1.2;

/** The weapon shape's two points (a sphere: twice its centre) through a bone's world matrix. */
function shapePoints(shape: MeleeShape, m: ArrayLike<number>): [Vec3, Vec3] {
  const tr = (v: Vec3): Vec3 => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
  const a = tr(shape.a);
  return [a, shape.b ? tr(shape.b) : a];
}
