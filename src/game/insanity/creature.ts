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
import { loadClip } from '../actors/clipmap';
import { readAnimEvents } from '../../formats/animation';
import { boneName } from '../../formats/skeleton';
import type { AttackParams, FormParams } from './params';
import { CREATURE_WEAPON_SHAPES, armWindows, creatureBlowOutcome, meleeDamage, reputationDamageScale, sweepCapsule, sweepSpheres, type ArmWindow, type MeleeShape, type Vec3 } from './melee';

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
  /** Leaf hit spheres of a body as posed now: blows on the dead are tested on them. */
  spheres?(a: ActorLike): readonly { c: Vec3; r: number }[];
}

/** Melee auto-face rate (Player p173, deg/s): the body turns to the swing's target. */
export const MELEE_FACE_RATE_DEG = 350;
/** Reach used to pick the target the body turns to at the start of a swing (m) [inferred]. */
const FACE_REACH = 3.5;

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

export class CreatureBody {
  readonly ch: Character;
  /** Human rig used only for the morph-back clip (the creature model is shown before). */
  private humanRig?: Character;
  private humanMorph = -1;
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
    windows: { w: ArmWindow; weapon: ArmWeapon; prev?: [Vec3, Vec3]; swept: boolean; hit: Set<ActorLike> }[];
    face?: ActorLike;
  } | null = null;
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
      if (hash !== undefined && shape && node) this.weapons.set(hash >>> 0, { node, shape, damage: w.damage, type: w.type ?? creature.hitDamageType });
    }
    this.ch.root.visible = false;
    const humanRun = human.locomotion?.run?.speed ?? 6.6;
    const creatureRun = loc?.run?.speed ?? humanRun;
    this.speedScale = Math.min(2, Math.max(0.5, creatureRun / humanRun));

    // Human rig for the morph-back clip (Character Morpher of the creature template).
    const back = creature.morph;
    const humanModel = human.model ?? back?.model;
    if (back?.clip && humanModel) {
      const hs = readSkinnedModel(pkgs, humanModel);
      const c = hs ? loadClip(pkgs, back.clip) : undefined;
      if (hs && c && c.animSet === hs.animSet) {
        this.humanRig = new Character(hs, [c], decodeCharacterTextures(hs, pkgs));
        this.humanRig.root.name = 'player-morph-back';
        this.humanRig.root.visible = false;
        this.humanMorph = 0;
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

  /** Root to hand to PlayerController.setModel(). */
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

  /** Start of the transformation: the creature model plays the morph clip. */
  startMorphIn(duration: number) {
    this.ch.root.visible = true;
    if (this.humanRig) this.humanRig.root.visible = false;
    const i = this.morphIn;
    if (i >= 0) {
      const clip = this.ch.clipData[i];
      // Stretch the clip over the morpher's duration (p4).
      const scale = clip.duration > 0 ? clip.duration / Math.max(0.1, duration) : 1;
      this.play(i, { loop: false, fade: 0, timeScale: scale });
      this.oneShotUntil = this.time + duration;
    } else this.play(this.roles.get('idle') ?? -1, { fade: 0 });
  }

  /** Change back: the human rig plays the morph-back clip. Returns the root to show. */
  startMorphOut(duration: number): THREE.Object3D {
    this.swing = null;
    if (!this.humanRig || this.humanMorph < 0) return this.ch.root;
    this.ch.root.visible = false;
    this.humanRig.root.visible = true;
    const clip = this.humanRig.clipData[0];
    const scale = clip.duration > 0 ? clip.duration / Math.max(0.1, duration) : 1;
    this.humanRig.play(0, { loop: false, fade: 0, timeScale: scale });
    return this.humanRig.root;
  }

  hide() {
    this.ch.root.visible = false;
    if (this.humanRig) this.humanRig.root.visible = false;
    this.swing = null;
    this.current = -1;
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
    this.swing = { clip: pick.clip, scale: pick.a.scale, windows, face: world && player ? this.faceTarget(world, player) : undefined };
    return true;
  }

  /** The target the body turns to: the nearest one ahead of the view within reach [inferred]. */
  private faceTarget(world: MeleeWorld, player: PlayerController): ActorLike | undefined {
    const p = player.position;
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    let best: ActorLike | undefined, bd = Infinity;
    for (const a of world.actors) {
      if (!a.alive || creatureBlowOutcome(this.targetOf(a), world.playerTeam ?? '') === 'skip') continue;
      const dx = a.position.x - p.x, dz = a.position.z - p.z, d = Math.hypot(dx, dz);
      if (d > FACE_REACH + (a.radius ?? 0.4) || Math.abs(a.position.y - p.y) > 2.2) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < 0.5) continue;
      if (d < bd) (bd = d), (best = a);
    }
    return best;
  }

  private targetOf(a: ActorLike) {
    const v = a.entity?.values?.[167];
    return { alive: a.alive, hidden: a.hidden, decor: a.kind?.decor, team: a.team, vision: typeof v === 'number' ? v : undefined, cuttable: a.cuttable };
  }

  /** Per frame (from PlayerController.onUpdate while shown). Returns hits that land now. */
  update(f: PlayerFrame, player: PlayerController, world: MeleeWorld | readonly ActorLike[] | undefined, locomotion: boolean): CreatureHit[] {
    const w: MeleeWorld = Array.isArray(world) ? { actors: world } : ((world as MeleeWorld | undefined) ?? { actors: [] });
    this.time += f.dt;
    if (this.humanRig?.root.visible) this.humanRig.update(f.dt);
    if (!this.ch.root.visible) return [];
    if (locomotion && !this.busy) this.locomotion(f);
    if (this.swing && this.current !== this.swing.clip) this.swing = null;
    if (this.swing) this.face(player, f.dt);
    this.ch.update(f.dt);
    return this.sweep(player, w);
  }

  /** Melee auto-face (p173 = 350 deg/s): the body turns to the swing's target, else the view. */
  private face(player: PlayerController, dt: number) {
    const t = this.swing?.face;
    const goal = t && t.alive ? Math.atan2(-(t.position.x - player.position.x), -(t.position.z - player.position.z)) : player.yaw;
    let d = goal - player.bodyYaw;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    const step = ((MELEE_FACE_RATE_DEG * Math.PI) / 180) * dt;
    player.bodyYaw += Math.sign(d) * Math.min(Math.abs(d), step);
    player.root.rotation.y = player.bodyYaw;
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
        // A body on the floor: its leaf hit spheres (the struck one names the part); the living
        // keep the standing capsule stand-in.
        const p = a.alive
          ? sweepCapsule(prev[0], prev[1], cur[0], cur[1], win.weapon.shape.r, { x: a.position.x, z: a.position.z, y0, y1: y0 + (a.height ?? 1.8), r })
          : sweepSpheres(prev[0], prev[1], cur[0], cur[1], win.weapon.shape.r, w.spheres?.(a) ?? []);
        if (!p) continue;
        win.hit.add(a); // once per target per Arm window, whatever the outcome
        if (w.blocked?.([player.position.x, p[1], player.position.z], p)) continue;
        const npc = a.kind?.className === 'Unspeakable NPC' ? reputationDamageScale(w.reputation ?? 0, [this.human.reputationRange[0], this.human.reputationRange[1]], this.creature.npcDamageScale) : 1;
        hits.push({ actors: [a], damage: meleeDamage(win.weapon.damage, sw.scale, npc), kind: win.weapon.type, point: p, reflect: outcome === 'reflect' });
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
    this.ch.dispose();
    this.humanRig?.dispose();
  }
}

interface ArmWeapon {
  node: THREE.Object3D;
  shape: MeleeShape;
  damage: number;
  type?: number;
}

/** The weapon shape's two points (a sphere: twice its centre) through a bone's world matrix. */
function shapePoints(shape: MeleeShape, m: ArrayLike<number>): [Vec3, Vec3] {
  const tr = (v: Vec3): Vec3 => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
  const a = tr(shape.a);
  return [a, shape.b ? tr(shape.b) : a];
}
