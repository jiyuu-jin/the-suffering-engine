// The player's animated body (third person) and first-person arms.
//
// Body: the Player template's skinned model (System 2:9, anim set 328), attached
// with player.setModel(). Arms: the Player template's first-person model (p227 = 2:138,
// same rig and clips), parented to a pivot at the eye that follows camera yaw/pitch; shown
// only in first person.
//
// First-person arms (how the original does it: docs/game-logic.md §4.5):
//   * Entering first person swaps the player's model for p227 (2:138: arms and hands only)
//     and the camera sits at a fixed offset from the model's origin (the feet): Player
//     p106 / p107 / p108 = 0 / 1.85 / -0.44 model units (x, up, forward), i.e. 1.85 up and
//     0.44 *behind* the origin. The arms model plays the player's clips, but in first person
//     the clips come from the first-person entries of the held weapon's Player Weapon
//     Properties (Suffering.rfl; docs/game-logic.md §4.5 "First-person clips"):
//       - locomotion: the stance helper 0x100456e0 adds 48 to every set index while the
//         first-person flag is set, so idle p13 -> p61 and the four (heading, walk, speed,
//         run, speed) sets p17..p36 -> p65..p84; no crouch variant; played at rate 1;
//         no idle fidgets (p14 -> p62, empty in every retail set);
//       - entering first person (0x10042400) snaps to p13 and blends into p104;
//       - fire / reload / throw / draw use heading set k = -2: p106 (+ p107) then the hold
//         p105, p96, p108, p172 (weaponAction below);
//       - melee strikes come from the Attack list p91 instead of p86 (0x1002a1a7).
//     Unarmed (Player p143 = 2:409) holds 2:232 standing and moving (hands below the view).
//   * Pose: the arms play their clips with each rotation-only track's stored constant
//     translation, as the engine's sampler does (SUFFERING.EXE 0x46a180 / 0x46a290: 0x80
//     tracks interpolate key translations, 0xc0 tracks return the track's constant, untracked
//     bones keep the bind). The first-person sets use those constants to move the collar bones
//     8 / 28 up and back (2:270: local (0.341, 0.554) instead of the bind's (0.216, 0)), so the
//     shoulders sit level with or behind the eye and only the forearms reach into the picture.
//     With the bind translations instead, the shoulders stayed 0.44 in front of the eye and the
//     open ends of the arm mesh (the cuts at the shoulders) filled the bottom corners.
//   * Pitch (Suffering.rfl first-person per-frame 0x10043294..0x10043393): the camera starts at
//     the p106..p108 offset, is turned about its right axis by the spine's share of the pitch
//     (+0x5a2) around the posed bone p109 (5), then by the rest (pitch - spine) around the
//     posed bone p112 (29). The model's spine p109 and shoulders p111 / p112 (and the neck
//     p110) take the same angles as model-space hooks (0x10030030). Here: the same bend on the
//     arms, and the arms root placed at the inverse of that camera (fpCameraInModel), so the
//     right arm is rigid to the view and the left one turns about its own shoulder.
//   * The port's eye (1.6 above the feet, 0.95 crouched, following the physics jump arc) is
//     not the original's fixed 1.85; only the arms-to-eye offset matters for the viewmodel.
//     The clips' own vertical body motion (jump, land, crouch) is cancelled by holding the
//     posed neck (p110 bone 48) at its height in the weapon's first-person hold clip, so the
//     arms do not swing through the view on top of the eye's own motion; the first-person
//     sets themselves (whose neck height equals their hold's) are drawn as posed.
//   * 2:138 carries, besides the arms (texture 2:70), an 8-triangle box (texture 2:129,
//     rigid on the pelvis) spanning the whole body height around the camera - an engine
//     helper volume, not something to draw. Drawn, it filled the screen as a flat brown
//     slab. dropHelperVolumes() removes such single-bone full-height boxes.
//   * The arms are drawn in the renderer's viewmodel pass (LevelRenderer.viewmodel:
//     cleared depth, the original's 32-unit (1.6 cm) near plane), so they never poke
//     through walls. Both passes use the engine's lens (engineLens: Level Properties p16 =
//     53 deg vertical at 4:3, the 4:3 horizontal angle kept on wider screens; the actors
//     system hands it to LevelRenderer.setLens). Under the port's former 70 deg lens the upper
//     arms, 0.3-0.5 from the eye, filled the lower middle of the screen as flat brown masses.
//
// Interaction clip API (services.actors.playerBody; used by src/game/world/interact.ts with
// the clip refs of each interactable's Interaction Properties, docs/game-logic.md §14.5):
//
//   play(clipRefOrRole, { loop?, fade?, lock?, timeScale?, inPlace?, onEnd? }) -> duration (s)
//       clipRefOrRole  a clip ref ({ pkg, id }, rig 328), decoded clip data, or a locomotion
//                      role name ('idle', 'walk', 'run', ...). 0 is returned when unusable.
//       loop           repeat until release() (default: one-shot, ends by itself)
//       fade           cross-fade seconds (default 0.15)
//       lock           freeze the player's movement input while the clip holds the body (the
//                      feet stay where they are; jump / look still work). Ignored while a
//                      caller already drives the feet (player.motionOverride: ladders, ...).
//       timeScale      playback rate (setRate() changes it while held, 0 pauses)
//       inPlace        drop the clip's whole root translation (default: only the horizontal
//                      part, like locomotion) - for clips whose motion the caller performs
//                      itself (ladder steps move the player 0.5 m per clip)
//       onEnd          called once when the clip ends or is released; a play() from inside
//                      onEnd chains clips without a blend back to locomotion
//     The clip overrides the locomotion state machine (and weapon one-shots) until it ends
//     (one-shot) or release() is called; another play() replaces it (the replaced clip's onEnd
//     does not run).
//   release(fade?)   back to locomotion (runs onEnd, lifts the lock)
//   setRate(ts)      playback rate of the held clip
//   overriding       true while a clip holds the body
//   tick(dt)         the actors system calls it every frame: the body keeps animating while
//                    player.motionOverride suppresses the player's own frame callbacks
//
// Idle fidgets (Player state 7 "IntermittentIdle", RFL 0x10048f70; docs/game-logic.md §4.5):
//   standing idle, a timer of Player p139 ± p141 s (10 ± 2) starts on entering the idle; when it
//   runs out and no live creature is within Player p241 (25) units (0x1004b730), a fidget plays
//   and the timer restarts at p140 ± p142 (15 ± 4). The fidget is a random clip (never the same
//   one twice in a row) of the held weapon's Player Weapon Properties p14 "Reputation Idle Anim
//   Set" whose p1 is the highest at or below the reputation (unarmed: Player p143 = 2:409, sets
//   from -999999 / -50 / +50). Moving cancels it. `fidgetContext` (set by the insanity system)
//   supplies the reputation and the creature check; without it, reputation 0 and no check.
//
// Third-person locomotion (docs/re/animation.md §9 "Third-person locomotion", gait.ts): the held
// weapon's Player Weapon Properties (unarmed: Player p143) give the idle p13 and four heading
// sets p17..p36 (forward / right / back / left: walk clip + speed, run clip + speed). The set
// follows the stick angle with the original's hysteresis; the body turns up to 45 deg into
// diagonal movement (PlayerController.gait); each set's clip plays at rate 1 at the set's own
// ground speed, as a phase-aligned cycle that blends walk and run poses for speeds in between
// (the port's 3 m/s default walk). The role table below is the fallback for rigs without sets.
//
// Clip roles were identified from root motion and pose analysis of set 328
// (clip ids are data references into the user's System.adu, not content):
//   idle 27, run fwd 167 / 172 (172 = the wounded run, PWP p44), back 29, strafe L/R 48 / 52,
//   back diagonals 67 / 69,
//   crouch idle 249, crouch walk fwd/back 206 / 207, jump 234, land 236,
//   collapse 164, melee combo 408-410 (shiv set), revolver fire 477.

import * as THREE from 'three/webgpu';
import type { PackageSet, ResRef } from '../../formats/model';
import { readSkinnedModel, type SkinnedModel } from '../../formats/skeleton';
import { blendInto, guessClipLabel, listAnimations, TRACK_ROTATION, type AnimClipData } from '../../formats/animation';
import { Character, buildAnimationClip, decodeCharacterTextures } from '../../app/character';
import type { PlayerController, PlayerFrame } from '../../app/player';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import { clipSpeed, loadClip } from './clipmap';
import { ENHANCED } from '../../app/enhanced/config';
import { HandGrip, handGripOption } from './hand-grip';
import { blendCycle, contactPhase, pickHeadingSet, rightAnkle, setCentre, setClipEventSource, setFacingOffset, setWidth, type HeadingSet } from './gait';

const ROLE_IDS = {
  idle: 27,
  walk: 167,
  run: 172,
  back: 29,
  left: 48,
  right: 52,
  backLeft: 67,
  backRight: 69,
  crouchIdle: 249,
  crouchFwd: 206,
  crouchBack: 207,
  jump: 234,
  land: 236,
  death: 164,
  // Player p29 (2:325): the drowning death (RFL 0x1002e5c3, src/game/levels/water.ts).
  drown: 325,
  melee1: 408,
  melee2: 409,
  melee3: 410,
  shoot: 477,
} as const;
type Role = keyof typeof ROLE_IDS;

/** Weapon actions of the held weapon (PlayerBody.weaponAction). */
export type WeaponActionKind = 'fire' | 'reload' | 'throw' | 'draw';
interface UpperLayer {
  bone: number;
  /** The same bone in the first-person arms model. */
  arms?: number;
  clip: number;
}

export const PLAYER_MODEL: ResRef = { pkg: 2, id: 9 };
const ARMS_MODEL: ResRef = { pkg: 2, id: 138 };
/** Player template (class Player) of the human model 2:9. */
const PLAYER_TEMPLATE: ResRef = { pkg: 2, id: 5 };
/**
 * First-person eye in the arms model's space (Y up, -Z forward), from Player p106..p108
 * (x, height, forward; model units): 1.85 above the feet, 0.44 behind the origin.
 */
const FP_EYE_DEFAULT = new THREE.Vector3(0, 1.85, 0.44);

/**
 * The engine's lens: Level Properties (System 2:9) p16 = 53, handed to every view as both the
 * current and the default field of view at level start (Suffering.rfl 0x100b2346 -> lens
 * +0x28 / +0x30). A view stores 48 / tan(fov / 2) on a 128 x 96 film (SUFFERING.EXE 0x4b21f0,
 * projection 0x49c400), i.e. 53 deg is the vertical angle of the 4:3 picture. docs/game-logic.md
 * §4.5 "Lens".
 */
const LEVEL_PROPERTIES: ResRef = { pkg: 2, id: 9 };
const LENS_DEFAULT = 53;

/** Level Properties p16 (vertical field of view of the 4:3 picture, degrees). */
export function engineLens(pkgs: PackageSet): number {
  const epk = pkgs as unknown as EntityPackageSet;
  const t = readObjectTemplate(epk, LEVEL_PROPERTIES);
  const cls = t && classByHash(t.classHash);
  const v = t && cls?.name === 'Level Properties' ? decodeTemplateProps(cls, t) : [];
  const f = v[16];
  return typeof f === 'number' && f > 1 && f < 179 ? f : LENS_DEFAULT;
}

/** Reputation Idle Anim Set (Player Weapon Properties p14 entries): clips + lowest reputation. */
export interface IdleSet {
  clips: ResRef[];
  minReputation: number;
}

/** The p14 sets of a Player Weapon Properties template, sorted by their p1 (ascending). */
export function readIdleSets(pkgs: PackageSet, pwp: ResRef | null | undefined): IdleSet[] {
  if (!pwp) return [];
  const epk = pkgs as unknown as EntityPackageSet;
  const props = (r: ResRef, cls: string) => {
    const t = readObjectTemplate(epk, r);
    const c = t && classByHash(t.classHash);
    return t && c?.name === cls ? decodeTemplateProps(c, t) : undefined;
  };
  const isRef = (x: unknown): x is ResRef => !!x && typeof x === 'object' && 'pkg' in (x as object);
  const v = props(pwp, 'Player Weapon Properties');
  const list = Array.isArray(v?.[14]) ? (v![14] as unknown[]) : [];
  const out: IdleSet[] = [];
  for (const r of list) {
    const sv = isRef(r) ? props(r, 'Reputation Idle Anim Set') : undefined;
    if (!sv) continue;
    const clips = (Array.isArray(sv[0]) ? sv[0] : [sv[0]]).filter(isRef);
    out.push({ clips, minReputation: typeof sv[1] === 'number' ? sv[1] : 0 });
  }
  return out.sort((a, b) => a.minReputation - b.minReputation);
}

/** The engine's pick (0x10048f70): the last set whose p1 <= reputation, else the first. */
export function idleSetFor(sets: readonly IdleSet[], reputation: number): IdleSet | undefined {
  let pick = sets[0];
  for (const s of sets) if (s.minReputation <= reputation) pick = s;
  return pick;
}

/** Fidget timing from the Player template: p139 ± p141 first, p140 ± p142 again, p241 radius. */
interface FidgetTiming {
  first: [number, number];
  again: [number, number];
  radius: number;
}
/** Neck bone of the human rig (Player p110 = bone 48; the same hash on every human). */
const NECK_BONE_HASH = 0x8023796d;
/** Clip options of the first-person arms: rotation-only tracks keep their constant translation. */
const ARMS_CLIP_OPTS = { constantTranslations: 'animation' } as const;

/**
 * Model-space position of `bone` in a clip's first frame, sampled as the engine does
 * (SUFFERING.EXE 0x46a180 / 0x46a290): key translations of 0x80 tracks, the stored constant of
 * 0xc0 (rotation-only) tracks, the bind pose for bones the clip does not list.
 */
export function clipBonePosition(clip: AnimClipData, skel: SkinnedModel['skeleton'], bone: number, out = new THREE.Vector3()): THREE.Vector3 {
  const tracks = new Map<number, AnimClipData['tracks'][number]>();
  for (const t of clip.tracks) {
    const i = skel.byHash.get(t.boneHash >>> 0);
    if (i !== undefined) tracks.set(i, t);
  }
  const m = new THREE.Matrix4(), l = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  for (let i = bone; i >= 0 && i < skel.bones.length; i = skel.bones[i].parent) {
    const b = skel.bones[i], t = tracks.get(i);
    if (t && t.rotations.length >= 4) q.fromArray(t.rotations, 0);
    else q.fromArray(b.quaternion);
    if (t?.translations && t.translations.length >= 3) p.fromArray(t.translations, 0);
    else if (t && t.format === TRACK_ROTATION) p.fromArray(t.constantTranslation);
    else p.fromArray(b.position);
    m.premultiply(l.compose(p, q, one));
  }
  return out.setFromMatrixPosition(m);
}

/**
 * The original's first-person camera in the arms model's space (Suffering.rfl 0x10042ffa..
 * 0x10043393): start at `eye` (Player p106..p108; level, facing -Z), turn about the model's X
 * axis by the spine share `spine` (radians, positive = looking down) around `spinePivot` (bone
 * p109), then by `pitch - spine` around `shoulderPivot` (bone p112) where that bone is after the
 * spine bend. `shoulderPivot` is its position before the spine bend. Returns the camera's
 * model-space matrix (rotation about X by -pitch, then its position).
 */
export function fpCameraInModel(eye: THREE.Vector3, pitch: number, spine: number, spinePivot: THREE.Vector3, shoulderPivot: THREE.Vector3, out = new THREE.Matrix4()): THREE.Matrix4 {
  const turn = (m: THREE.Matrix4, pivot: THREE.Vector3, angle: number) => {
    const r = _fpM.makeRotationX(-angle);
    r.setPosition(pivot.x - (r.elements[0] * pivot.x + r.elements[4] * pivot.y + r.elements[8] * pivot.z), pivot.y - (r.elements[1] * pivot.x + r.elements[5] * pivot.y + r.elements[9] * pivot.z), pivot.z - (r.elements[2] * pivot.x + r.elements[6] * pivot.y + r.elements[10] * pivot.z));
    return m.premultiply(r);
  };
  out.makeTranslation(eye.x, eye.y, eye.z);
  turn(out, spinePivot, spine);
  // The shoulder pivot as the spine bend leaves it.
  const r = _fpV.copy(shoulderPivot).sub(spinePivot).applyAxisAngle(_fpX, -spine).add(spinePivot);
  return turn(out, r, pitch - spine);
}
const _fpM = new THREE.Matrix4();
const _fpV = new THREE.Vector3();
const _fpX = new THREE.Vector3(1, 0, 0);
const _armsV = new THREE.Vector3();
const _armsX = new THREE.Vector3(1, 0, 0);

/** First-person model (p227) and eye offset (p106..p108) of a Player template. */
/**
 * Upper-body bend from the view pitch (Suffering.rfl 0x1004c6b1..0x1004c7cc, 0x1003f930;
 * docs/re/animation.md §9): Player p109 spine / p110 neck / p111, p112 shoulder bones get
 * model-space rotations about the lateral axis (the engine's bone node +0xc hook). The spine
 * takes p194 % of the pitch, the neck and (while aiming) the shoulders the rest; each angle
 * moves toward its target at p193 (spine) / p195 (neck, shoulders) degrees per second.
 */
interface BendProps {
  spine: number;
  neck: number;
  shoulders: [number, number];
  spineShare: number;
  spineRate: number;
  rate: number;
}

function firstPersonProps(pkgs: PackageSet, template: ResRef): { model: ResRef; eye: THREE.Vector3; unarmed?: ResRef; fidget: FidgetTiming; bend: BendProps; turnTime: number } {
  const epk = pkgs as unknown as EntityPackageSet;
  const t = readObjectTemplate(epk, template);
  const cls = t && classByHash(t.classHash);
  const v = t && cls?.name === 'Player' ? decodeTemplateProps(cls, t) : [];
  const num = (i: number, d: number) => (typeof v[i] === 'number' && Number.isFinite(v[i]) ? (v[i] as number) : d);
  const m = v[227];
  const u = v[143];
  return {
    model: m && typeof m === 'object' && !Array.isArray(m) ? m : ARMS_MODEL,
    eye: new THREE.Vector3(num(106, FP_EYE_DEFAULT.x), num(107, FP_EYE_DEFAULT.y), -num(108, -FP_EYE_DEFAULT.z)),
    unarmed: u && typeof u === 'object' && !Array.isArray(u) ? u : undefined,
    fidget: { first: [num(139, 10), num(141, 2)], again: [num(140, 15), num(142, 4)], radius: num(241, 25) },
    bend: { spine: num(109, 5), neck: num(110, 48), shoulders: [num(111, 9), num(112, 29)], spineShare: num(194, 50) / 100, spineRate: num(193, 20), rate: num(195, 20) },
    // Move per-frame 0x100464ac: the body turns by a heading set's width per p154 seconds.
    turnTime: num(154, 0.35),
  };
}

/**
 * Remove helper volumes from a skinned model: small submeshes (<= 12 triangles) rigidly
 * bound to one bone whose box spans most of the model's height. Returns the input when
 * there is nothing to drop.
 */
export function dropHelperVolumes(sk: SkinnedModel): SkinnedModel {
  const m = sk.model;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < m.positions.length; i += 3) (minY = Math.min(minY, m.positions[i])), (maxY = Math.max(maxY, m.positions[i]));
  const height = maxY - minY;
  const keep = m.submeshes.filter((s) => {
    if (s.indices.length / 3 > 12 || height <= 0) return true;
    let lo = Infinity, hi = -Infinity;
    const bones = new Set<number>();
    for (const c of s.indices) {
      lo = Math.min(lo, m.positions[c * 3 + 1]);
      hi = Math.max(hi, m.positions[c * 3 + 1]);
      bones.add(sk.skinWeight[c * 4] >= 0.999 ? sk.skinIndex[c * 4] : -1);
    }
    const rigid = bones.size === 1 && !bones.has(-1);
    return !(rigid && hi - lo > height * 0.7);
  });
  return keep.length === m.submeshes.length ? sk : { ...sk, model: { ...m, submeshes: keep } };
}

export class PlayerBody {
  readonly body: Character;
  readonly arms?: Character;
  /** Pivot at the eye for the first-person arms. */
  readonly armsPivot = new THREE.Group();
  /** The original's first-person eye in the arms model's space (Player p106..p108). */
  private fpEye0 = new THREE.Vector3();
  private neckBone = -1;
  /** Neck height (model space) of the first-person hold clip: what holdNeck keeps. */
  private neckRefY = 0;
  /** Neck height in the bind pose (no first-person hold clip). */
  private neckBindY = 0;
  /** Arms bones of the pitch bend: spine p109, neck p110, shoulders p111 / p112 (-1: none). */
  private armsBend = { spine: -1, neck: -1, shoulders: [-1, -1] as [number, number] };
  /** This frame's arms pose before the bend: neck height, spine and p112 shoulder pivots. */
  private armsPose = { neckY: NaN, spine: new THREE.Vector3(), shoulder: new THREE.Vector3() };
  private neckMat = new THREE.Matrix4();
  private camM = new THREE.Matrix4();
  showArms = true;
  /**
   * First person: hold the posed neck at its height in the weapon's first-person hold clip
   * relative to the eye (see followEye). Use animations (src/game/world/use-anim.ts) turn it
   * off: the original films them from the rigid first-person eye, so the body's own bend shows.
   */
  holdNeck = true;
  dead = false;
  /** Reputation and "creature nearby" for the idle fidgets (the insanity system sets it). */
  fidgetContext: { reputation(): number; threatNear(radius: number): boolean } | null = null;
  /** Unarmed Player Weapon Properties (Player p143). */
  readonly unarmedProps?: ResRef;
  private fidgetTiming: FidgetTiming;
  private idleSets: IdleSet[] = [];
  /** Seconds until the next fidget check (NaN: not standing idle). */
  private fidgetIn = NaN;
  private fidgetIndex = -1;
  private lastFidget = '';

  private roles = new Map<Role, number>();
  private speeds: number[] = [];
  private current = -1;
  private oneShot: { index: number; until: number; interruptible?: boolean } | null = null;
  private airTime = 0;
  private held: { index: number; loop: boolean; until: number; rate: number; locked: boolean; onEnd?: () => void } | null = null;
  /** Inline-root copies of interaction clips (play inPlace). */
  private inPlaceClips = new Map<AnimClipData, AnimClipData>();
  /** A player frame arrived since the last tick(). */
  private framed = false;
  private pkgs: PackageSet;
  private time = 0;
  private unsub: () => void;

  private constructor(
    private readonly player: PlayerController,
    scene: THREE.Scene,
    skinnedModel: NonNullable<ReturnType<typeof readSkinnedModel>>,
    clips: AnimClipData[],
    roleIndex: Map<Role, number>,
    pkgs: PackageSet,
    viewmodel?: THREE.Object3D,
  ) {
    this.pkgs = pkgs;
    this.body = new Character(skinnedModel, clips, decodeCharacterTextures(skinnedModel, pkgs));
    this.body.root.name = 'player-body';
    this.roles = roleIndex;
    this.speeds = clips.map(clipSpeed);
    player.setModel(this.body.root);

    const fp = firstPersonProps(pkgs, PLAYER_TEMPLATE);
    this.unarmedProps = fp.unarmed;
    this.fidgetTiming = fp.fidget;
    this.bendProps = fp.bend;
    this.gaitTurnTime = fp.turnTime > 0 ? fp.turnTime : 0.35;
    this.ankle = rightAnkle(skinnedModel.skeleton);
    this.body.poseHooks.push(() => this.applyBend());
    // (Enhanced "Close Hand on Weapon", after the bend: hand-grip.ts.)
    this.body.poseHooks.push((_c, dt) => this.handGrip?.apply(dt, this.mode !== 'fp' || !!this.player.externalView));
    this.idleSets = readIdleSets(pkgs, fp.unarmed);
    const rawArms = readSkinnedModel(pkgs, fp.model);
    if (rawArms && rawArms.animSet === skinnedModel.animSet) {
      const armsModel = dropHelperVolumes(rawArms);
      this.arms = new Character(armsModel, clips, decodeCharacterTextures(armsModel, pkgs), ARMS_CLIP_OPTS);
      this.arms.root.name = 'player-arms';
      // The model's origin (the feet) sits where the original puts it relative to the eye.
      this.fpEye0.copy(fp.eye);
      this.arms.root.position.copy(fp.eye).negate();
      const nb = armsModel.skeleton.byHash.get(NECK_BONE_HASH);
      if (nb !== undefined) {
        this.neckBone = nb;
        this.neckBindY = this.neckRefY = armsModel.skeleton.bones[nb].bindWorld[13];
      }
      // The bend bones are body (2:9) rig indices: the same bones of the arms rig by hash.
      const onArms = (i: number) => {
        const h = skinnedModel.skeleton.bones[i]?.hash;
        return h === undefined ? -1 : (armsModel.skeleton.byHash.get(h >>> 0) ?? -1);
      };
      const bp = fp.bend;
      this.armsBend = { spine: onArms(bp.spine), neck: onArms(bp.neck), shoulders: [onArms(bp.shoulders[0]), onArms(bp.shoulders[1])] };
      this.arms.poseHooks.push(() => this.applyArmsBend());
      this.armsPivot.add(this.arms.root);
      this.armsPivot.visible = false;
      this.armsPivot.name = 'player-arms-pivot';
      (viewmodel ?? scene).add(this.armsPivot);
    }
    this.setFirstPerson(this.unarmedProps);
    this.setThirdPerson(this.unarmedProps);
    player.gait = (angle, run, walkSpeed) => this.chooseGait(angle, run, walkSpeed);

    this.playRole('idle', { fade: 0 });
    this.unsub = player.onUpdate((f) => this.update(f));
  }

  /** `viewmodel`: parent for the first-person arms (LevelRenderer.viewmodel); default `scene`. */
  static create(
    player: PlayerController,
    scene: THREE.Scene,
    pkgs: PackageSet,
    model: ResRef = PLAYER_MODEL,
    viewmodel?: THREE.Object3D,
  ): PlayerBody | null {
    const skinned = readSkinnedModel(pkgs, model);
    const adu = pkgs.get(model.pkg)?.adu;
    if (!skinned || !adu) return null;
    const clips: AnimClipData[] = [];
    const roles = new Map<Role, number>();
    for (const [role, id] of Object.entries(ROLE_IDS) as [Role, number][]) {
      const c = loadClip(pkgs, { pkg: model.pkg, id });
      if (!c || c.animSet !== skinned.animSet) continue;
      roles.set(role, clips.length);
      clips.push(c);
    }
    // A different rig/clip set: fall back to labels.
    if (!roles.has('idle') || !roles.has('walk')) {
      for (const info of listAnimations(adu, skinned.animSet)) {
        const c = loadClip(pkgs, { pkg: model.pkg, id: info.id });
        if (!c) continue;
        const label = guessClipLabel(c);
        const role: Role | undefined =
          label === 'idle_or_long_action' ? 'idle' : label === 'run_forward' ? 'walk' : label === 'run_back' || label === 'walk_back' ? 'back' : label === 'strafe_left' ? 'left' : label === 'strafe_right' ? 'right' : undefined;
        if (role && !roles.has(role)) {
          roles.set(role, clips.length);
          clips.push(c);
        }
      }
    }
    if (!clips.length) return null;
    return new PlayerBody(player, scene, skinned, clips, roles, pkgs, viewmodel);
  }

  private idx(role: Role): number {
    if (this.mode === 'fp' && this.fpStance.size) {
      const fp = this.fpStance.get(role);
      if (fp !== undefined) return fp;
    }
    if (this.mode !== 'fp' && this.tpSets.length) {
      if (role === 'idle' && this.tpIdle >= 0) return this.tpIdle;
      if (role === 'walk') return this.tpSets[0].walk;
      if (role === 'run') return this.tpSets[0].run;
    }
    return this.stance.get(role) ?? this.roles.get(role) ?? -1;
  }

  /**
   * First-person locomotion of a Player Weapon Properties template (see the header): p61
   * idle (p104 when unset), p65..p84 = four (heading, walk clip, walk speed, run clip, run
   * speed) sets in the same heading order as the third-person p17..p36 (forward, right,
   * back, left). Crouching uses the same clips (the first-person shift comes before the
   * crouch one).
   */
  private setFirstPerson(pwp: ResRef | null | undefined) {
    const roles = new Map<Role, number>();
    const sets: { walk: number; run: number }[] = [];
    this.fpStance = roles;
    this.fpSets = sets;
    this.neckRefY = this.neckBindY;
    if (!pwp) return;
    const v = this.pwp(pwp);
    const clip = (i: number, alt: number) => {
      const c = this.pwpClip(v, i);
      return c >= 0 ? c : this.pwpClip(v, alt);
    };
    const hold = clip(61, 104);
    if (hold < 0) return;
    // holdNeck keeps the neck where this set's hold clip has it (the sets' walk / run clips
    // share their hold's body height), so the first-person sets are drawn as posed.
    const holdData = this.body.clipData[hold];
    if (this.arms && this.neckBone >= 0 && holdData) this.neckRefY = clipBonePosition(holdData, this.arms.skinned.skeleton, this.neckBone).y;
    for (const r of ['idle', 'crouchIdle'] as Role[]) roles.set(r, hold);
    // Sets without clips (the Dual Revolvers' first hand set) keep the hold.
    for (let s = 0; s < 4; s++) {
      const walk = clip(66 + 5 * s, 68 + 5 * s);
      const run = clip(68 + 5 * s, 66 + 5 * s);
      sets.push({ walk: walk >= 0 ? walk : hold, run: run >= 0 ? run : hold });
    }
    roles.set('walk', sets[0].walk);
    roles.set('run', sets[0].run);
  }
  /**
   * Third-person locomotion of a Player Weapon Properties template (Move per-frame 0x10045d70,
   * see gait.ts): the idle p13 and the four heading sets p17..p36 (bound, walk clip, walk speed,
   * run clip, run speed). Every retail set idles on the plain 2:27 (p13) - the weapon-ready
   * holds (p61) are first-person clips; the aim-state sets (p110, p116 + 7k) are not modelled.
   */
  private setThirdPerson(pwp: ResRef | null | undefined) {
    this.handGrip?.setClip(null);
    this.tpSets = [];
    this.tpIdle = -1;
    this.gaitSet = -1;
    this.gaitWant = null;
    if (!pwp) return;
    const v = this.pwp(pwp);
    const sets: HeadingSet[] = [];
    for (let s = 0; s < 4; s++) {
      const o = 17 + 5 * s;
      const bound = v[o], ws = v[o + 2], rs = v[o + 4];
      let walk = this.pwpClip(v, o + 1), run = this.pwpClip(v, o + 3);
      if (walk < 0) walk = run;
      if (run < 0) run = walk;
      if (typeof bound !== 'number' || walk < 0 || typeof ws !== 'number' || typeof rs !== 'number' || !(ws > 0) || !(rs > 0)) return;
      sets.push({ bound, walk, walkSpeed: ws, run, runSpeed: rs });
    }
    this.tpSets = sets;
    this.tpIdle = this.pwpClip(v, 13);
    // Enhanced option: the fist of the weapon's armed run (set 0's run, p20) over the open hand
    // of its idle / walk, on the PWP p0 weapon bone's hand (hand-grip.ts).
    const wb = typeof v[0] === 'number' ? v[0] : -1;
    const u = this.unarmedProps;
    if (ENHANCED && wb >= 0 && u && !(pwp.pkg === u.pkg && pwp.id === u.id)) {
      this.handGrip ??= new HandGrip(this.body, this.body.skinned.skeleton.bones[wb]?.parent ?? -1, wb, () => handGripOption.enabled);
      this.handGrip.setClip(this.body.clips[sets[0].run] ?? null);
    }
  }
  /** Enhanced "Close Hand on Weapon" (hand-grip.ts), made on the first weapon. */
  private handGrip: HandGrip | null = null;
  private tpSets: HeadingSet[] = [];
  private tpIdle = -1;
  /** Heading set being played (pickHeadingSet hysteresis), -1 standing. */
  private gaitSet = -1;
  /** What the player asked for this frame (chooseGait): set, ground speed, run. */
  private gaitWant: { set: number; speed: number } | null = null;
  /** Seconds for the body to turn through one set's width (Player p154). */
  private gaitTurnTime = 0.35;
  private ankle = -1;
  /** Phase-aligned gait cycles (clip index) by walk / run clip and speed. */
  private gaitCycles = new Map<string, number>();
  private clipPhase = new Map<number, number>();
  /** The retail clip a gait cycle stands for (the walk or run it is mostly made of; headingSet). */
  private gaitSource = new Map<number, number>();

  /**
   * PlayerController.gait: the heading set for stick angle `angle` (deg, clockwise from the
   * view's forward), its ground speed and the body's facing offset from the view. Walking uses
   * the set's walk speed, or the port's walk speed when that is faster (the brisk default walk;
   * the backpedal set walks at its own 4.1 m/s); running the set's run speed.
   */
  private chooseGait(angle: number, run: boolean, walkSpeed: number): { speed: number; offset: number; turnRate: number } | null {
    const sets = this.tpSets;
    if (this.mode === 'fp' || !sets.length || this.dead) return null;
    let s = pickHeadingSet(sets, angle, this.gaitSet);
    if (this.gaitSet < 0) {
      // Starting on a sector bound (keyboard diagonals): the original takes the next set
      // (strafe); the port prefers the one centred nearer the forward / back axis, which keeps
      // the body turned into the movement instead of strafing with it turned away.
      const alt = pickHeadingSet(sets, angle - 0.01);
      const axis = (i: number) => Math.abs(Math.sin((setCentre(sets, i) * Math.PI) / 180));
      if (alt !== s && axis(alt) < axis(s)) s = alt;
    }
    this.gaitSet = s;
    const set = sets[s];
    const speed = run ? set.runSpeed : Math.min(set.runSpeed, Math.max(set.walkSpeed, walkSpeed));
    this.gaitWant = { set: s, speed };
    return { speed, offset: setFacingOffset(sets, s, angle), turnRate: (setWidth(sets, s) * Math.PI) / 180 / this.gaitTurnTime };
  }

  /** Normalised time of the right foot's mid-stance in clip i (cached). */
  private phaseOf(i: number): number {
    let p = this.clipPhase.get(i);
    if (p === undefined) this.clipPhase.set(i, (p = contactPhase(this.body.clips[i], this.body.skinned.skeleton, this.ankle)));
    return p;
  }

  /**
   * The gait cycle for heading set `set` at ground speed `speed`: the walk clip, the run clip, or
   * (between the set's walk and run speeds) the two blended, all re-timed to start at the right
   * foot's mid-stance (gait.ts). Added to the clips once; returns its index.
   */
  private gaitCycle(set: HeadingSet, speed: number): number {
    const span = set.runSpeed - set.walkSpeed;
    const alpha = set.run === set.walk || !(span > 0) ? 0 : Math.round(Math.min(1, Math.max(0, (speed - set.walkSpeed) / span)) * 20) / 20;
    const key = `${set.walk}/${set.run}/${alpha}`;
    let i = this.gaitCycles.get(key);
    if (i !== undefined) return i;
    const side = (c: number, v: number) => ({ clip: this.body.clips[c], phase: this.phaseOf(c), rate: this.body.clipData[c].rate || 1, speed: v });
    const cyc = blendCycle(`gait#${this.body.clipData[set.walk].id}/${this.body.clipData[set.run].id}@${alpha}`, side(set.walk, set.walkSpeed), side(set.run, set.runSpeed), alpha, this.body.skinned.skeleton);
    i = this.body.clips.length;
    // Same data record as the walk clip (blend links), played at rate 1.
    const data: AnimClipData = { ...this.body.clipData[set.walk], rate: 1, duration: cyc.clip.duration };
    this.body.clips.push(cyc.clip);
    this.body.clipData.push(data);
    if (this.arms) {
      if (this.arms.clips !== this.body.clips) this.arms.clips.push(cyc.clip);
      if (this.arms.clipData !== this.body.clipData) this.arms.clipData.push(data);
    }
    this.speeds.push(cyc.speed);
    this.gaitCycles.set(key, i);
    const src = alpha > 0.5 ? set.run : set.walk;
    this.gaitSource.set(i, src);
    // Footstep markers: the dominant clip's, re-timed onto the cycle (fx/footsteps.ts).
    setClipEventSource(cyc.clip, { id: this.body.clipData[src].id, animSet: this.body.clipData[src].animSet, duration: this.body.clipData[src].duration, phase: this.phaseOf(src) });
    return i;
  }

  /** First-person roles (idle / walk / run) and the four heading sets (see setFirstPerson). */
  private fpStance = new Map<Role, number>();
  private fpSets: { walk: number; run: number }[] = [];

  // -------------------------------------------------------------------------
  // Weapon stances and actions (src/game/weapons, documented there): the weapons system adds
  // the clips of the held weapon's Player Weapon Properties and maps locomotion roles onto
  // them (weapon-ready idle, armed walk / run), and plays one-shot fire / reload / draw /
  // throw / strike clips. Clips are appended to both the body and the first-person arms.
  private stance = new Map<Role, number>();
  private extra = new Map<AnimClipData, number>();

  /** Add a clip (same rig) to the body and arms; returns its index (cached per clip). */
  addClip(data: AnimClipData): number {
    const have = this.extra.get(data);
    if (have !== undefined) return have;
    const i = this.body.clips.length;
    this.body.clips.push(buildAnimationClip(data, this.body.skinned.skeleton));
    this.body.clipData.push(data);
    if (this.arms) {
      if (this.arms.clips !== this.body.clips) this.arms.clips.push(buildAnimationClip(data, this.arms.skinned.skeleton, ARMS_CLIP_OPTS));
      if (this.arms.clipData !== this.body.clipData) this.arms.clipData.push(data);
    }
    this.speeds.push(clipSpeed(data));
    this.extra.set(data, i);
    return i;
  }

  /**
   * Locomotion roles -> clip indices (from addClip); null restores the unarmed set. `props`:
   * the held weapon's Player Weapon Properties (its p14 idle fidgets; null = unarmed p143).
   * `fp`: the Player Weapon Properties whose first-person sets (p61..p84) drive the arms in
   * first person (default `props`; the original reads the weapon's p66 set when it has one).
   */
  setStance(map: Partial<Record<'idle' | 'walk' | 'run' | 'back' | 'left' | 'right', number>> | null, props?: ResRef | null, fp?: ResRef | null) {
    if (props !== undefined || map === null) this.idleSets = readIdleSets(this.pkgs, props ?? this.unarmedProps);
    if (props !== undefined || map === null || fp !== undefined) this.setFirstPerson((map === null ? null : (fp ?? props)) ?? this.unarmedProps);
    if (props !== undefined || map === null) this.setThirdPerson((map === null ? null : props) ?? this.unarmedProps);
    this.stance.clear();
    for (const [k, v] of Object.entries(map ?? {})) if (typeof v === 'number' && v >= 0) this.stance.set(k as Role, v);
    if (!this.oneShot) this.current = -1;
  }

  /**
   * Play a one-shot whole-body clip (index from addClip): melee swings, fidgets.
   * `interruptible`: moving cancels it; otherwise it plays out. Returns the duration (s). The
   * weapon actions (fire, reload, throw, draw) go through weaponAction().
   */
  playAction(i: number, o: { fade?: number; interruptible?: boolean; timeScale?: number } = {}): number {
    if (this.dead || i < 0 || i >= this.body.clips.length) return 0;
    const rate = this.body.clipData[i].rate || 1;
    const ts = o.timeScale ?? 1;
    const dur = this.body.clips[i].duration / rate / ts;
    // Any other action leaves the idle: its fidget timer starts again afterwards.
    this.fidgetIn = NaN;
    this.playIndex(i, { loop: false, fade: o.fade ?? 0.08, timeScale: ts });
    this.oneShot = { index: i, until: this.time + dur * 0.97, interruptible: o.interruptible ?? false };
    return dur;
  }

  /** Play an interaction clip over locomotion (see the header). Returns its duration (s). */
  play(
    clip: ResRef | AnimClipData | string,
    o: { loop?: boolean; fade?: number; lock?: boolean; timeScale?: number; inPlace?: boolean; onEnd?: () => void } = {},
  ): number {
    if (this.dead) return 0;
    let i = -1;
    if (typeof clip === 'string') i = this.idx(clip as Role);
    else {
      let data = 'tracks' in clip ? clip : loadClip(this.pkgs, clip);
      if (data && o.inPlace) data = this.inPlaceCopy(data);
      if (data && data.animSet === this.body.skinned.animSet) i = this.addClip(data);
    }
    if (i < 0) return 0;
    const ts = o.timeScale ?? 1;
    const dur = this.body.clips[i].duration / (this.body.clipData[i].rate || 1) / Math.max(1e-3, ts);
    const loop = o.loop ?? false;
    const wasLocked = this.held?.locked ?? false;
    this.fidgetIn = NaN;
    this.oneShot = null;
    this.playIndex(i, { loop, fade: o.fade ?? 0.15, timeScale: ts });
    this.setTimeScale(i, ts);
    const lock = !!o.lock && (wasLocked || !this.player.motionOverride);
    if (lock && !wasLocked) this.player.motionOverride = this.lockMotion;
    else if (!lock && wasLocked && this.player.motionOverride === this.lockMotion) this.player.motionOverride = null;
    this.held = { index: i, loop, until: this.time + dur, rate: ts, locked: lock, onEnd: o.onEnd };
    return dur;
  }

  // -------------------------------------------------------------------------
  // Upper-body bend by the view pitch (see BendProps). Angles in radians, engine sign
  // (positive = looking down; the port's pitch is positive up).
  private bendProps: BendProps;
  private bendNow = { spine: 0, neck: 0, shoulder: 0 };
  private bendQ = new THREE.Quaternion();

  private updateBend(dt: number, mode: string) {
    const D = Math.PI / 180;
    const fp = mode === 'fp';
    const pitch = this.dead ? 0 : THREE.MathUtils.clamp(-this.player.pitch, -50 * D, 50 * D);
    const p = this.bendProps;
    const spineT = p.spineShare * pitch;
    const rest = pitch - spineT;
    const aiming = this.stance.size > 0;
    const step = (cur: number, target: number, rate: number) => {
      const d = target - cur, m = rate * D * dt;
      return Math.abs(d) <= m ? target : cur + Math.sign(d) * m;
    };
    const b = this.bendNow;
    b.spine = fp ? spineT : step(b.spine, spineT, p.spineRate);
    b.neck = step(b.neck, rest, p.rate);
    b.shoulder = fp ? rest : step(b.shoulder, aiming ? rest : 0, p.rate);
  }

  /** Pose hook of the body: spine, then shoulders and neck (parents first). */
  private applyBend() {
    const p = this.bendProps, b = this.bendNow, n = this.body.skeleton.bones.length;
    const X = new THREE.Vector3(1, 0, 0);
    const rot = (bone: number, angle: number) => {
      if (bone < 0 || bone >= n || !angle) return;
      this.body.rotateBoneModel(bone, this.bendQ.setFromAxisAngle(X, -angle));
    };
    rot(p.spine, b.spine);
    rot(p.shoulders[0], b.shoulder);
    rot(p.shoulders[1], b.shoulder);
    rot(p.neck, b.neck);
  }

  // -------------------------------------------------------------------------
  // Weapon actions (Suffering.rfl Player states; docs/re/animation.md §2 "Player weapon
  // actions") [verified]. Each plays the held weapon's Player Weapon Properties clip as an
  // INDEPENDENT layer (play flag 0x08: locomotion changes do not take it over) on a bone the
  // PWP names, and the clip depends on the locomotion "heading set" k (0x10042390 /
  // 0x100411e0): -2 in first person, 0..4 when the whole-body clip is one of the five
  // moving-aim sets (p117 + 7k run clip, p119 / p120 / p121 + 7k), else -1.
  //   fire   (Attack state, enter 0x10029990): p120 + 7k on bone p1, p121 + 7k on bone p2;
  //          standing (k = -1) p121 + 7k (= p114) also plays on the whole body. When k
  //          changes the clips are swapped at the same clip time (0x10028830); after the
  //          shot p119 + 7k holds on bone p1 (0x1004cb60).
  //   reload (state 18, 0x10027d40): p98 + k on bone p3 (-1 = the whole body); standing,
  //          also on the whole body; swapped at the same time on heading changes (0x10027e60).
  //   throw  (0x10027b40): p122 + 7k on bone p4 (none with p4 = -1), and on the whole body
  //          [the original also does it while moving unless jumping or landing; the port keeps
  //          the legs running].
  //   draw   (state 25, 0x10038230): p174 + j on bone p6 (p172 first person, p173 standing,
  //          p174 moving; p173 when that clip is missing, 0x100371e0).
  // Revolver: p1 = 6 (chest: arms, neck, head), p2..p4 / p6 = 5 (the spine).

  private pwpProps = new Map<string, PropValue[]>();
  /** Player frame mode of the last update ('fp' = first person). */
  private mode = '';
  /** Standing still (speed < 0.3) in the last update. */
  private standing = true;
  private airborne = false;

  private pwp(ref: ResRef): PropValue[] {
    const k = `${ref.pkg}:${ref.id}`;
    let v = this.pwpProps.get(k);
    if (!v) {
      const epk = this.pkgs as unknown as EntityPackageSet;
      const t = readObjectTemplate(epk, ref);
      const cls = t && classByHash(t.classHash);
      v = t && cls?.name === 'Player Weapon Properties' ? decodeTemplateProps(cls, t) : [];
      this.pwpProps.set(k, v);
    }
    return v;
  }

  /** Clip index (addClip) of a PWP clip property; -1 when unset or not of this rig. */
  private pwpClip(v: PropValue[], i: number): number {
    const r = v[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return -1;
    const data = loadClip(this.pkgs, r as ResRef);
    if (!data || data.animSet !== this.body.skinned.animSet) return -1;
    const idx = this.addClip(data);
    this.clipRefs.set(idx, r as ResRef);
    return idx;
  }
  /** Clip ref of clip indices that came from PWP properties. */
  private clipRefs = new Map<number, ResRef>();
  /** The clip ref weaponAction() played as its main clip (animation markers: ThrowWeapon). */
  lastActionClip: ResRef | undefined;

  private pwpBone(v: PropValue[], i: number): number {
    const b = v[i];
    return typeof b === 'number' && Number.isFinite(b) ? b : -1;
  }

  /** Heading set index k of the current locomotion (see above). */
  headingSet(pwp: ResRef): number {
    if (this.mode === 'fp') return -2;
    const v = this.pwp(pwp);
    if (this.current < 0) return -1;
    const cur = this.gaitSource.get(this.current) ?? this.current;
    for (let k = 0; k < 5; k++) for (const o of [117, 119, 120, 121]) if (this.pwpClip(v, o + 7 * k) === cur) return k;
    return -1;
  }

  /** The weapon action layers (bone -> clip) for heading set k. */
  private actionLayers(kind: WeaponActionKind, v: PropValue[], k: number, swap = false): { bone: number; clip: number; blend?: number }[] {
    const out: { bone: number; clip: number; blend?: number }[] = [];
    // `blend`: the request's blend time (0x1004cb20 argument 3); none = the engine's default
    // (the clip's type-4 entry, else its header blend).
    const add = (bone: number, clip: number, blend?: number) => {
      if (clip >= 0 && bone >= 0 && bone < this.body.skeleton.bones.length) out.push({ bone, clip, blend });
    };
    switch (kind) {
      case 'fire': {
        const fire = this.pwpClip(v, 120 + 7 * k);
        add(Math.max(0, this.pwpBone(v, 1)), fire, 0);
        // On a heading change the fire clip goes on both bones (0x10028c19 / 0x10028ce6).
        if (this.pwpBone(v, 2) >= 0) add(this.pwpBone(v, 2), swap ? fire : this.pwpClip(v, 121 + 7 * k));
        break;
      }
      case 'reload':
        add(Math.max(0, this.pwpBone(v, 3)), this.pwpClip(v, 98 + k), 0);
        break;
      case 'throw':
        add(this.pwpBone(v, 4), this.pwpClip(v, 122 + 7 * k));
        break;
      case 'draw': {
        const j = k === -2 ? -2 : k >= 0 ? 0 : -1;
        let c = this.pwpClip(v, 174 + j);
        if (c < 0) c = this.pwpClip(v, 173);
        add(this.pwpBone(v, 6), c);
        break;
      }
    }
    return out;
  }

  /**
   * Play a weapon action of the held weapon (`pwp`: its Player Weapon Properties) the way the
   * original does (see above). Returns the duration of its main clip (s); 0 when it has none.
   */
  weaponAction(kind: WeaponActionKind, pwp: ResRef, o: { timeScale?: number; interruptible?: boolean } = {}): number {
    if (this.dead) return 0;
    const v = this.pwp(pwp);
    const k = this.headingSet(pwp);
    const layers = this.actionLayers(kind, v, k);
    const ts = o.timeScale ?? 1;
    // The whole-body copy while standing in third person: fire p121 + 7k (k = -1: p114),
    // reload p98 + k, throw p122 + 7k.
    const wholeOf = kind === 'fire' ? this.pwpClip(v, 121 + 7 * k) : kind === 'reload' ? this.pwpClip(v, 98 + k) : kind === 'throw' ? this.pwpClip(v, 122 + 7 * k) : -1;
    const whole = k === -1 && this.standing && !this.airborne && !this.held ? wholeOf : -1;
    const main = layers[0]?.clip ?? whole;
    this.lastActionClip = main >= 0 ? this.clipRefs.get(main) : undefined;
    if (main < 0) return 0;
    const dur = this.body.clips[main].duration / (this.body.clipData[main].rate || 1) / ts;
    this.fidgetIn = NaN;
    // Layers of the previous action on other bones end; on the same bones the new clip replaces
    // the old one inside the layer (engine blend into it; the same clip restarts).
    const prev = this.upper;
    this.upper = null;
    for (const l of prev?.layers ?? []) {
      if (layers.some((n) => n.bone === l.bone)) continue;
      this.body.stopLayer(l.bone, 0.15);
      if (l.arms !== undefined) this.arms?.stopLayer(l.arms, 0.15);
    }
    const skel = this.body.skinned.skeleton;
    const entries: UpperLayer[] = [];
    for (const l of layers) {
      const blend = l.blend ?? blendInto(this.body.clipData[l.clip], this.layerFrom(l.bone));
      this.body.playLayer(l.bone, l.clip, { loop: false, timeScale: ts, blend, independent: true });
      const armsBone = this.arms?.skinned.skeleton.byHash.get(skel.bones[l.bone].hash);
      if (this.arms && armsBone !== undefined) this.arms.playLayer(armsBone, l.clip, { loop: false, timeScale: ts, blend, independent: true });
      entries.push({ bone: l.bone, arms: armsBone, clip: l.clip });
    }
    if (whole >= 0) {
      this.playIndex(whole, { loop: false, fade: 0.08, timeScale: ts });
      this.oneShot = { index: whole, until: this.time + dur * 0.97, interruptible: o.interruptible ?? false };
    } else if (this.oneShot) {
      // A whole-body one-shot still showing gives way to locomotion under the layers.
      this.oneShot = null;
      this.current = -1;
    }
    this.upper = { kind, pwp, k, layers: entries, ts, until: this.time + dur, held: false };
    return dur;
  }

  /** Data of the clip a layer on `bone` shows now (for the engine's blend into the next one). */
  private layerFrom(bone: number): { id: number } | undefined {
    const a = this.body.layers.get(bone)?.action;
    const i = a ? this.body.clips.findIndex((c) => a.getClip().name.startsWith(`${c.name}@`)) : -1;
    return i >= 0 ? { id: this.body.clipData[i].id } : undefined;
  }

  /** The weapon action under way (weaponAction). */
  private upper: { kind: WeaponActionKind; pwp: ResRef; k: number; layers: UpperLayer[]; ts: number; until: number; held: boolean } | null = null;

  private stopUpper(blend = 0.15) {
    const u = this.upper;
    if (!u) return;
    this.upper = null;
    for (const l of u.layers) {
      this.body.stopLayer(l.bone, blend);
      if (l.arms !== undefined) this.arms?.stopLayer(l.arms, blend);
    }
  }

  /** Per frame: swap clips on heading changes, hold the post-shot pose, end the action. */
  private updateUpper() {
    const u = this.upper;
    if (!u) return;
    if (this.dead) return this.stopUpper(0);
    const k = this.headingSet(u.pwp);
    if (k !== u.k && !u.held) {
      u.k = k;
      const next = this.actionLayers(u.kind, this.pwp(u.pwp), k, true);
      for (const n of next) {
        const l = u.layers.find((x) => x.bone === n.bone);
        if (!l || l.clip === n.clip) continue;
        // Same clip time on the new heading's clip (start time = the node's time).
        const time = this.body.layers.get(l.bone)?.action?.time ?? 0;
        const blend = blendInto(this.body.clipData[n.clip], { id: this.body.clipData[l.clip].id });
        this.body.playLayer(l.bone, n.clip, { loop: false, timeScale: u.ts, time, blend, independent: true });
        if (this.arms && l.arms !== undefined) this.arms.playLayer(l.arms, n.clip, { loop: false, timeScale: u.ts, time, blend, independent: true });
        l.clip = n.clip;
      }
    }
    if (this.time < u.until) return;
    // After a shot: p119 + 7k (the aim hold of the heading set) on bone p1.
    const hold = u.kind === 'fire' && !u.held ? this.pwpClip(this.pwp(u.pwp), 119 + 7 * u.k) : -1;
    const top = u.layers[0];
    if (hold >= 0 && top && hold !== top.clip) {
      u.held = true;
      const blend = 0;
      this.body.playLayer(top.bone, hold, { loop: false, blend, independent: true });
      if (this.arms && top.arms !== undefined) this.arms.playLayer(top.arms, hold, { loop: false, blend, independent: true });
      top.clip = hold;
      u.until = this.time + this.body.clips[hold].duration / (this.body.clipData[hold].rate || 1);
      return;
    }
    this.stopUpper(0.15);
  }

  /** Feet held in place while a locked clip plays (player.motionOverride). */
  private lockMotion = () => !!this.held?.locked;

  /** A copy of a clip with its root translation pinned to the first key. */
  private inPlaceCopy(data: AnimClipData): AnimClipData {
    let c = this.inPlaceClips.get(data);
    if (c) return c;
    const skel = this.body.skinned.skeleton;
    const tracks = data.tracks.map((t) => {
      const b = skel.byHash.get(t.boneHash);
      if (!t.translations || b === undefined || skel.bones[b].parent >= 0) return t;
      const tr = Float32Array.from(t.translations);
      for (let k = 3; k < tr.length; k += 3) (tr[k] = tr[0]), (tr[k + 1] = tr[1]), (tr[k + 2] = tr[2]);
      return { ...t, translations: tr };
    });
    c = { ...data, tracks };
    this.inPlaceClips.set(data, c);
    return c;
  }

  /** End an interaction clip: back to locomotion (or to the clip its onEnd starts). */
  release(fade = 0.2) {
    const h = this.held;
    if (!h) return;
    this.held = null;
    this.current = -1;
    h.onEnd?.();
    if (this.held) return; // onEnd chained another clip
    if (h.locked && this.player.motionOverride === this.lockMotion) this.player.motionOverride = null;
    if (fade > 0 && !this.dead) this.playIndex(this.idx('idle'), { fade });
  }

  /** Playback rate of the held interaction clip (0 pauses it). */
  setRate(ts: number) {
    const h = this.held;
    if (!h || h.rate === ts) return;
    // Keep a one-shot's end time consistent with the new rate.
    if (!h.loop && h.rate > 0 && ts > 0) h.until = this.time + ((h.until - this.time) * h.rate) / ts;
    h.rate = ts;
    this.setTimeScale(h.index, ts);
  }

  /**
   * Per-frame tick from the actors system: the player's onUpdate frames stop while
   * player.motionOverride drives the feet (ladders, clamber, mounted gun, locked clips), so
   * the body animates from here then.
   */
  tick(dt: number) {
    if (this.framed) {
      this.framed = false;
      return;
    }
    this.time += dt;
    this.updateUpper();
    if (this.held && !this.held.loop && this.held.rate > 0 && this.time >= this.held.until) this.release(0.2);
    if (this.player.externalView) this.externalStance();
    this.body.update(dt);
    if (this.armsPivot.visible && this.arms) {
      this.arms.update(dt);
      this.followEye();
    }
  }

  /**
   * The first-person eye in the model's frame (Player p106..p108): x right, y up, z back
   * (0, 1.85, 0.44: 0.44 behind the model's origin).
   */
  get firstPersonEye(): THREE.Vector3 {
    return this.fpEye.copy(this.fpEye0);
  }
  private fpEye = new THREE.Vector3();

  /**
   * World matrix of a bone (by name hash) of the rig on screen: the first-person arms while
   * they are shown, else the body. False when the rig has no such bone.
   */
  boneWorld(hash: number, out: THREE.Matrix4): boolean {
    const rig = this.arms && this.armsPivot.visible ? this.arms : this.body;
    const i = rig.skinned.skeleton.byHash.get(hash >>> 0);
    const bone = i !== undefined ? rig.skeleton.bones[i] : undefined;
    if (!bone) return false;
    bone.updateWorldMatrix(true, false);
    out.copy(bone.matrixWorld);
    return true;
  }

  /**
   * Seen through another camera (player.setExternalView; no player frames arrive meanwhile):
   * no first-person arms, and the body leaves the first-person stance for the third-person idle
   * as the original's View Monitor / Controlled states do (they end First Person; View Monitor's
   * enter, 0x100347f0, plays the stance idle p13) [verified]. The next player frame brings the
   * first-person stance back.
   */
  private externalStance() {
    this.armsPivot.visible = false;
    if (this.mode !== 'fp') return;
    this.mode = 'tp';
    if (!this.held && !this.dead) this.playRole('idle', { fade: 0.2 });
  }

  /** True while an interaction clip holds the body. */
  get overriding(): boolean {
    return !!this.held;
  }

  /** True while a one-shot action plays. */
  get busy(): boolean {
    return (!!this.oneShot && this.time < this.oneShot.until) || (!!this.upper && this.time < this.upper.until);
  }

  private playIndex(i: number, o: { loop?: boolean; fade?: number; timeScale?: number } = {}) {
    if (i < 0) return;
    const opts = { loop: o.loop ?? true, fade: o.fade ?? 0.2, timeScale: o.timeScale ?? 1 };
    this.body.play(i, opts);
    this.arms?.play(i, opts);
    this.current = i;
  }

  private playRole(role: Role, o: { loop?: boolean; fade?: number } = {}) {
    this.playIndex(this.idx(role), o);
  }

  private setTimeScale(i: number, ts: number) {
    const rate = this.body.clipData[i]?.rate || 1;
    if (this.body.current) this.body.current.timeScale = ts * rate;
    if (this.arms?.current) this.arms.current.timeScale = ts * rate;
  }

  /** Play a one-shot full-body action (melee swing, shot). Returns its duration (s), 0 if unavailable. */
  action(kind: 'melee' | 'shoot'): number {
    if (this.dead) return 0;
    let role: Role = 'shoot';
    if (kind === 'melee') {
      const combo: Role[] = ['melee1', 'melee2', 'melee3'];
      const prev = this.oneShot && this.time < this.oneShot.until + 0.4 ? this.oneShot.index : -1;
      const k = combo.findIndex((r) => this.idx(r) === prev);
      role = combo[(k + 1) % combo.length];
    }
    const i = this.idx(role);
    if (i < 0) return 0;
    const clip = this.body.clips[i];
    const rate = this.body.clipData[i].rate || 1;
    const dur = clip.duration / rate;
    this.playIndex(i, { loop: false, fade: 0.08 });
    this.oneShot = { index: i, until: this.time + dur * 0.92 };
    return dur;
  }

  private span([base, rand]: [number, number]): number {
    return Math.max(0.5, base + (Math.random() * 2 - 1) * rand);
  }

  /** Standing idle: counts down and starts a fidget (see the header). True when one started. */
  private fidget(dt: number): boolean {
    if (Number.isNaN(this.fidgetIn)) {
      this.fidgetIn = this.span(this.fidgetTiming.first);
      return false;
    }
    this.fidgetIn -= dt;
    if (this.fidgetIn > 0) return false;
    this.fidgetIn = this.span(this.fidgetTiming.again);
    const ctx = this.fidgetContext;
    if (ctx?.threatNear(this.fidgetTiming.radius)) return false;
    const set = idleSetFor(this.idleSets, ctx?.reputation() ?? 0);
    if (!set?.clips.length) return false;
    // A random clip of the set, not the previous one (0x10048520).
    const keys = set.clips.map((c) => `${c.pkg}:${c.id}`);
    let k = Math.floor(Math.random() * keys.length);
    if (keys.length > 1 && keys[k] === this.lastFidget) k = (k + 1 + Math.floor(Math.random() * (keys.length - 1))) % keys.length;
    const data = loadClip(this.pkgs, set.clips[k]);
    if (!data || data.animSet !== this.body.skinned.animSet) return false;
    this.lastFidget = keys[k];
    this.fidgetIndex = this.addClip(data);
    this.playAction(this.fidgetIndex, { fade: 0.3, interruptible: true });
    // Back in the idle afterwards: the first timer again (the Idle state is entered anew).
    this.fidgetIn = NaN;
    return true;
  }

  /** The fidget clip playing now ("pkg:id"), or '' (debug / tests). */
  get fidgeting(): string {
    return this.oneShot && this.oneShot.index === this.fidgetIndex && this.time < this.oneShot.until ? this.lastFidget : '';
  }

  /** Debug: run the fidget timer out now. */
  fidgetNow() {
    this.fidgetIn = 0.001;
  }

  /** The next death plays the drowning clip (Player p29) instead of the collapse. */
  private drownNext = false;
  drowning() {
    this.drownNext = true;
  }

  /**
   * `clip`: the killer's death clip (Player p330 / p332 / p335 / p337 by the killer's class:
   * 0x1002e3f0; system.ts playerDeathClip). Returns its length (s), 0 for the role's clip.
   */
  die(clip?: ResRef): number {
    if (this.dead) return 0;
    this.dead = true;
    this.oneShot = null;
    this.stopUpper(0);
    const drown = this.drownNext ? this.idx('drown') : -1;
    this.drownNext = false;
    let own = -1;
    if (drown < 0 && clip) {
      const data = loadClip(this.pkgs, clip);
      if (data && data.animSet === this.body.skinned.animSet) own = this.addClip(data);
    }
    const i = drown >= 0 ? drown : own >= 0 ? own : this.idx('death');
    if (i >= 0) this.playIndex(i, { loop: false, fade: 0.15 });
    return own >= 0 ? this.body.clips[own]?.duration ?? 0 : 0;
  }

  revive() {
    this.dead = false;
    this.oneShot = null;
    this.current = -1;
    this.playRole('idle', { fade: 0 });
  }

  private update(f: PlayerFrame) {
    this.framed = true;
    this.time += f.dt;
    this.mode = f.mode;
    this.standing = f.speed < 0.3;
    this.airborne = !f.onGround;
    this.updateBend(f.dt, f.mode);
    if (!this.dead) this.chooseLocomotion(f);
    this.updateUpper();
    this.body.update(f.dt);

    // First-person arms follow the camera.
    // Not while another camera looks (player.setExternalView): the whole body shows then.
    const show = !!this.arms && this.showArms && f.mode === 'fp' && !this.dead && !this.player.externalView;
    this.armsPivot.visible = show;
    if (show) {
      this.arms!.update(f.dt);
      this.followEye();
    }
  }

  /**
   * The arms pivot follows the eye with the full view yaw and pitch (the port's camera); the
   * arms root sits at the inverse of the original's camera in the model (fpCameraInModel: the
   * p106..p108 eye turned about the posed spine and p112 shoulder pivots by the bend angles),
   * so the bent right arm is rigid to the view (see the header).
   */
  private followEye() {
    this.player.eyePosition(this.armsPivot.position);
    this.armsPivot.rotation.set(this.player.pitch, this.player.yaw, 0, 'YXZ');
    const root = this.arms!.root, ap = this.armsPose;
    const pitch = this.fpPitch();
    const cam = fpCameraInModel(this.fpEye0, pitch, this.bendProps.spineShare * pitch, ap.spine, ap.shoulder, this.camM);
    // Vertical only: keep the unbent neck at its height in the first-person hold clip relative
    // to the eye. The port's eye follows the physics (jump arc, crouch height), so the clips'
    // own body rise / drop (jump 234 lifts the body 0.4, crouch 249 lowers it 0.35) would
    // otherwise come on top of it and swing the arms through the view. Lean and arm motion stay.
    if (this.holdNeck && Number.isFinite(ap.neckY)) cam.elements[13] -= this.neckRefY - ap.neckY;
    cam.invert().decompose(root.position, root.quaternion, root.scale);
  }

  /** First-person view pitch in the engine's sign (radians, positive = looking down). */
  private fpPitch(): number {
    return this.dead ? 0 : -this.player.pitch;
  }

  /**
   * Pose hook of the arms: the original's first-person bend (model-space hooks 0x10030030;
   * first person snaps to the targets): the spine p109 takes p194 % of the view pitch, the
   * shoulders p111 / p112 and the neck p110 the rest. Notes the unbent neck height and the
   * spine / p112 pivots for followEye first.
   */
  private applyArmsBend() {
    const a = this.arms!, ap = this.armsPose, k = this.armsBend;
    ap.neckY = this.neckBone >= 0 ? this.armsModelPos(this.neckBone, _armsV).y : NaN;
    if (k.spine >= 0) this.armsModelPos(k.spine, ap.spine);
    else ap.spine.set(0, 0, 0);
    if (k.shoulders[1] >= 0) this.armsModelPos(k.shoulders[1], ap.shoulder);
    else ap.shoulder.copy(ap.spine);
    const pitch = this.fpPitch(), spine = this.bendProps.spineShare * pitch, rest = pitch - spine;
    const rot = (bone: number, angle: number) => {
      if (bone < 0 || !angle) return;
      a.rotateBoneModel(bone, this.bendQ.setFromAxisAngle(_armsX, -angle));
    };
    rot(k.spine, spine);
    rot(k.shoulders[0], rest);
    rot(k.shoulders[1], rest);
    rot(k.neck, rest);
  }

  /** Model-space position of an arms bone in the current (local) pose. */
  private armsModelPos(bone: number, out: THREE.Vector3): THREE.Vector3 {
    const root = this.arms!.root;
    const m = this.neckMat.identity();
    for (let o: THREE.Object3D | null = this.arms!.skeleton.bones[bone]; o && o !== root; o = o.parent) {
      o.updateMatrix();
      m.premultiply(o.matrix);
    }
    return out.setFromMatrixPosition(m);
  }

  private chooseLocomotion(f: PlayerFrame) {
    this.airTime = f.onGround ? 0 : this.airTime + f.dt;
    if (this.held) {
      if (this.held.loop || this.held.rate <= 0 || this.time < this.held.until) return;
      this.release(0.2);
    }
    if (f.jumped && this.idx('jump') >= 0) {
      this.oneShot = null;
      this.playIndex(this.idx('jump'), { loop: false, fade: 0.1 });
      return;
    }
    const inAir = !f.onGround && this.airTime > 0.2;
    if (inAir) {
      if (this.current !== this.idx('jump') && this.idx('jump') >= 0) this.playIndex(this.idx('jump'), { loop: false, fade: 0.25 });
      return;
    }
    if (f.landed && this.current === this.idx('jump') && f.speed < 1.5 && this.idx('land') >= 0) {
      this.playIndex(this.idx('land'), { loop: false, fade: 0.08 });
      this.oneShot = { index: this.idx('land'), until: this.time + 0.3 };
      return;
    }
    if (this.oneShot) {
      // Moving cancels the shot pose; swings play out.
      const isShot = this.oneShot.index === this.idx('shoot') || this.oneShot.index === this.idx('land') || !!this.oneShot.interruptible;
      if (this.time < this.oneShot.until && !(isShot && f.speed > 0.8)) return;
      this.oneShot = null;
      this.current = -1;
    }

    let role: Role;
    let ts = 1;
    const { x, z } = f.localVelocity;
    if (this.mode === 'fp' && this.fpSets.length) {
      // First person (see the header): the hold standing, else the walk / run clip of the
      // heading's set at rate 1; no fidgets, no crouch clips.
      this.fidgetIn = NaN;
      let i = this.idx('idle');
      if (f.speed >= 0.3) {
        const a = Math.atan2(x, z) * (180 / Math.PI); // 0 forward, +90 right
        const s = Math.abs(a) <= 45 ? 0 : Math.abs(a) >= 135 ? 2 : a > 0 ? 1 : 3;
        const set = this.fpSets[s];
        i = f.running && !f.crouched ? set.run : set.walk;
      }
      if (i !== this.current) this.playIndex(i, { fade: 0.2 });
      // The original plays these at rate 1 at its own speeds; match the clip to the port's
      // movement speed (e.g. the brisker default walk) the same way third person does.
      const natural = this.speeds[i] || 0;
      this.setTimeScale(i, f.speed >= 0.3 && natural > 0 ? Math.min(2, Math.max(0.5, f.speed / natural)) : 1);
      return;
    }
    if (f.speed < 0.3) {
      this.gaitWant = null;
      this.gaitSet = -1;
      role = f.crouched && this.idx('crouchIdle') >= 0 ? 'crouchIdle' : 'idle';
      if (role === 'idle' && this.fidget(f.dt)) return;
      if (role !== 'idle') this.fidgetIn = NaN;
    } else if (!f.crouched && this.gaitWant && this.tpSets[this.gaitWant.set]) {
      // Third person (gait.ts): the heading set's phase-aligned cycle for the wanted speed, at
      // rate 1 once up to speed (the original's rate); slower while accelerating or blocked so
      // the feet do not skate. A new cycle continues at the old one's phase.
      this.fidgetIn = NaN;
      const i = this.gaitCycle(this.tpSets[this.gaitWant.set], this.gaitWant.speed);
      if (i !== this.current) {
        const prev = this.body.current;
        const wasGait = this.gaitSource.has(this.current) && prev;
        const phase = wasGait ? prev.time / Math.max(1e-3, prev.getClip().duration) : 0;
        this.playIndex(i, { fade: wasGait ? 0.2 : 0.3 });
        if (this.body.current) this.body.current.time = phase * this.body.clips[i].duration;
      }
      this.setTimeScale(i, Math.min(1.2, Math.max(0.5, f.speed / (this.speeds[i] || 1))));
      return;
    } else {
      this.fidgetIn = NaN;
      const ang = Math.atan2(x, z) * (180 / Math.PI); // 0 forward, +90 right
      const a = Math.abs(ang);
      if (f.crouched && this.idx('crouchFwd') >= 0) role = a > 100 && this.idx('crouchBack') >= 0 ? 'crouchBack' : 'crouchFwd';
      else if (a <= 50) role = f.running && this.idx('run') >= 0 ? 'run' : 'walk';
      else if (a < 125) role = ang < 0 ? 'left' : 'right';
      else if (a < 160) role = ang < 0 ? 'backLeft' : 'backRight';
      else role = 'back';
      if (this.idx(role) < 0) role = 'walk';
      // In-place clips (no root motion) play at their own rate.
      const natural = this.speeds[this.idx(role)] || 0;
      ts = natural > 0 ? Math.min(2, Math.max(0.5, f.speed / natural)) : 1;
    }
    const i = this.idx(role);
    if (i !== this.current) this.playIndex(i, { fade: 0.2 });
    this.setTimeScale(i, ts);
  }

  dispose() {
    this.unsub();
    if (this.player.gait) this.player.gait = null;
    this.player.setModel(null);
    this.armsPivot.removeFromParent();
    this.arms?.dispose();
    this.body.dispose();
  }
}
