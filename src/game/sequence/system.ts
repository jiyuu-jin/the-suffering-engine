// Sequence presenter: shows STOMP sequences (.qdu) that the world system runs.
//
// The world system (src/game/world/logic.ts + stomp.ts StompRun) owns the sequence
// clock, delivers message / visibility keys into the level logic and poses props and
// NPCs. This system is the StompObserver that adds what the player sees and hears:
//
//   * cinematic sequences (flag 0x40): the Camera track takes over the view camera
//     (pose + field of view), player input / HUD / first-person arms are off, the
//     Player track drives a third-person puppet of the player model, Enter / Esc skips
//     to the end state, and control returns at the Player track's final pose;
//   * animation keys play clips on the driven characters (actors or the puppet);
//   * sound keys play through the AudioSystem (dialog on the voice bus), with
//     subtitles in the game's font when the subtitle setting is on;
//   * control keys pause / resume the AI of the driven actors;
//   * animation keys on secondary channels play on the channel bone's subtree (a layer,
//     Character.playLayer); a later whole-body key takes such layers over again;
//   * root-motion modes of animation keys: mode-1 axes move the object by the clip's root
//     motion while no transform key poses it, and rotation mode 1 turns it by the root's
//     rotation (docs/re/animation.md §4);
//   * camera keys' time scale sets the game clock rate (relative to the rate at the start).
//
// Debug: window.__stomp { runs, log } (log = sound cues with sequence time).

import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import type { WorldService } from '../world/world';
import {
  ANIM_INDEPENDENT,
  rootMotionModes,
  keyIndexAt,
  sampleCamera,
  SEQ_LETTERBOX,
  XF_LINEAR,
  XF_SPLINE,
  type StompAnimKey,
  type StompTransformKey,
  type StompEvent,
  type StompObserver,
  type StompRun,
  type StompSoundKey,
  type StompTrack,
} from '../world/stomp';
import { Character, decodeCharacterTextures, type RootAxes } from '../../app/character';
import { sampleTrackRotation, sampleTrackTranslation } from '../../formats/animation';
import { hardpointTable } from '../weapons/hardpoints';
import { readSkinnedModel, type SkinnedModel } from '../../formats/skeleton';
import { readXduString, type EntityPackageSet } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { loadClip } from '../actors/clipmap';
import { loadSettings } from '../../app/menu/settings';
import { SoundCategory } from '../../formats/sound';
import type { SoundHandle } from '../../app/audio';
import { CINEMATIC_MUSIC_ATTENUATION, CINEMATIC_MUSIC_FADE, stompKeyGain, stompVoiceEnd } from '../../app/audio-rules';
import { loadSubtitleFont, SubtitleOverlay } from './subtitles';
import { levelLetterbox } from './cinema';
import { driveFloorY, lensFov, makeScriptedClip, playScriptedClip, scriptedClipTime, type ScriptedClip } from './clips';
import { lipSyncService } from '../actors/lipsync';
import { instanceMatrix } from '../world/dynamic';
import { registerSave } from '../save/providers';
import { uiBridge } from '../hud/ui-bridge';
import { sequencePropCandidate } from './props';

const SCALE = 2048;
const noop = () => {};

/** What this system uses of an actor (src/game/actors/actor.ts). */
interface ActorLike {
  readonly ch: Character;
  scripted: boolean;
  setScriptPose(pos: THREE.Vector3Like | null, quat?: THREE.Quaternion): void;
  /** The character's speech channel takes a sound at priority 9 (actors/speech.ts). */
  adoptSpeech?(h: { stop(fade?: number): void; readonly playing: boolean }): void;
}
interface ActorsLike {
  get(uid: number): ActorLike | undefined;
  refreshVisibility?(camera: THREE.PerspectiveCamera): void;
}
/** services.weapons attach API (src/game/weapons/attach.ts). */
interface AttachLike {
  attach(obj: number, carrier: Character, hardpoint: number): boolean;
  detachHardpoint(carrier: Character, hardpoint?: number): void;
}

interface CueLog {
  seq: string;
  t: number;
  track: string;
  sound: string;
  category: string;
  subtitle?: string;
  played: boolean;
}

/** One track's actual state at a probed time (debug, see __stomp.probe). */
interface ProbeRow {
  seq: string;
  /** Track index; -1 for an indirect target (`uid`: an object the sequence reaches through relays). */
  index: number;
  uid?: number;
  /** Recorded by __stomp.snapshot after the sequence ended (`t` = seconds after the end). */
  after?: boolean;
  /** Requested time; `at` = the sequence time of the frame that recorded it. */
  t: number;
  at: number;
  rendered: string;
  /** Mesh drawn this frame (actors: frustum / occlusion culling). */
  drawn?: boolean;
  position?: [number, number, number];
  yaw?: number;
  clip?: string;
  clipTime?: number;
  visible?: boolean;
  scripted?: boolean;
  alive?: boolean;
  /** Actors: the clip shown, as "<animation set>/<clip id>" (also for clips the AI plays). */
  pose?: string;
  activity?: string;
}
/** Module scope: survives the system being re-created (level restart / save restore). */
let probe: {
  times: Map<string, number[]>;
  /** Indirect targets per sequence: objects reached through relays / togglers / timers. */
  extra: Map<string, number[]>;
  /** Sequences seen by the probe (for snapshots after they ended). */
  seen: Map<string, StompRun>;
  rows: ProbeRow[];
  /** Message keys as the level logic took them (handled = the receiver had a matching input). */
  messages: { seq: string; at: number; to: number; message: number; handled: boolean }[];
  lastLog?: unknown;
} | null = null;

const CSS = `.stomp-cine .whud, .stomp-cine .chud { display: none !important; }`;


export async function createSequenceSystem(ctx: GameContext): Promise<GameSystem> {
  const { view, audio, fs } = ctx;
  const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
  const ws = ctx.services.world as WorldService | undefined;
  if (!pkgs || !ws) return { name: 'sequence (no world)' };
  const world = ws.world;
  const actors = () => ctx.services.actors as ActorsLike | undefined;
  /** Skinned scenery drawn by the levels system (cranes; src/game/levels/skinned-props.ts). */
  const skinnedScenery = () => ctx.services.skinnedProps as { character?(uid: number): Character | undefined } | undefined;

  const container = view.renderer.domElement.parentElement ?? document.body;
  const style = document.createElement('style');
  style.textContent = CSS;
  container.append(style);
  const subs = new SubtitleOverlay(container, null);
  void loadSubtitleFont(fs).then((f) => subs.setFont(f));

  // Letterbox bars (cinema.ts): Level Properties p36 % of the view height each, colour p37, on
  // while a sequence with flag 0x04 holds the player (control key on the player's track), off
  // at its release or when that run ends. Under the subtitles, over the 3D view.
  const lb = levelLetterbox(world.of('Level Properties')[0]?.e.values as unknown[] | undefined);
  const bars = (['top', 'bottom'] as const).map((side) => {
    const d = document.createElement('div');
    Object.assign(d.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      [side]: '0',
      height: `${lb.size}%`,
      background: `#${lb.color.toString(16).padStart(6, '0')}`,
      pointerEvents: 'none',
      zIndex: '5',
      display: 'none',
    });
    d.className = 'stomp-letterbox';
    container.append(d);
    return d;
  });
  let letterboxRun: StompRun | null = null;
  const setLetterbox = (run: StompRun | null) => {
    letterboxRun = run;
    for (const d of bars) d.style.display = run && lb.size > 0 ? '' : 'none';
  };

  const log: CueLog[] = [];
  let clock = 0;

  // Game clock rate from the camera keys' time scale (SUFFERING.EXE 0x44e2a0): the rate the
  // clock had at the sequence start times the key value interpolated like the FOV; restored
  // at the end. Composed with whatever else sets view.timeScale (the insanity system's time
  // effects set it every frame) through an accessor: reads give base x sequence rate.
  const clockRates = new Map<StompRun, number>();
  let baseRate = view.timeScale;
  let stompRate = 1;
  const rateDesc = Object.getOwnPropertyDescriptor(view, 'timeScale');
  const rateHooked = !rateDesc || (rateDesc.configurable !== false && 'value' in rateDesc);
  const rateGet = () => baseRate * stompRate;
  if (rateHooked) {
    Object.defineProperty(view, 'timeScale', {
      configurable: true,
      enumerable: true,
      get: rateGet,
      set: (v: number) => {
        baseRate = v;
      },
    });
  }
  const updateClockRate = () => {
    let r = 1;
    for (const v of clockRates.values()) r *= v;
    stompRate = r > 0 && Number.isFinite(r) ? r : 1;
  };
  const sampleClockRate = (run: StompRun) => {
    if (run.skipping || run.finished) return void clockRates.delete(run);
    let rate: number | undefined;
    for (const t of run.seq.tracks) {
      if (!t.cameras.length) continue;
      rate = sampleCamera(t, run.t)?.timeScale;
      break;
    }
    if (rate && rate > 0 && rate !== 1) clockRates.set(run, rate);
    else clockRates.delete(run);
  };

  // ---------------------------------------------------------------------------
  // Clips on characters

  /** Scripted clip -> "pkg:id" of its STOMP clip ref (debug probe). */
  const clipRefOf = new WeakMap<THREE.AnimationClip, string>();
  const clipCache = new WeakMap<SkinnedModel, Map<string, ScriptedClip | null>>();
  /** Scripted clip of a ref for a rig; `axes` = the key's root-motion modes (channel 0). */
  const clipFor = (skinned: SkinnedModel, ref: ResRef, axes?: RootAxes) => {
    let m = clipCache.get(skinned);
    if (!m) clipCache.set(skinned, (m = new Map()));
    const k = `${ref.pkg}:${ref.id}`;
    const mk = axes ? `${k}/${axes.x}${axes.y}${axes.z}${axes.rotation}` : k;
    if (!m.has(mk)) {
      const data = loadClip(pkgs, ref);
      const c = data ? makeScriptedClip(data, skinned, axes) : null;
      if (c) clipRefOf.set(c.clip, k);
      m.set(mk, c);
    }
    return m.get(mk) ?? undefined;
  };

  /** Current scripted action per character. */
  const current = new WeakMap<Character, THREE.AnimationAction>();

  // Root motion extracted to the object (mode-1 axes of a channel-0 key): while no transform
  // key re-poses the object, it moves by the clip's root translation (SUFFERING.EXE 0x478b90),
  // and with rotation mode 1 it turns by the root's rotation relative to the reference taken
  // at the key (0x478ec2..0x478f35; the pose holds that reference rotation, character.ts).
  interface RootDrive {
    run: StompRun;
    track: StompTrack;
    key: StompAnimKey;
    clip: ScriptedClip;
    action: THREE.AnimationAction;
    axes: [boolean, boolean, boolean];
    /** Rotation mode 1: the object turns with the root. */
    rot: boolean;
    /** Sequence time the motion counts from (the key, or the last transform key after it). */
    from: number;
    lastPose?: StompTransformKey;
    /** Object position at `from`, output units. */
    base: THREE.Vector3;
    /** Object rotation at `from`. */
    baseQuat: THREE.Quaternion;
  }
  const drives = new Map<Character, RootDrive>();

  const playClip = (ch: Character, key: StompAnimKey, elapsed: number, run?: StompRun, track?: StompTrack) => {
    const modes = rootMotionModes(key.flags);
    const axes: RootAxes = { x: modes.x, y: modes.y, z: modes.z, rotation: modes.rotation };
    const c = clipFor(ch.skinned, key.clip, axes);
    if (!c) return false;
    const action = playScriptedClip(ch, c, key, elapsed);
    current.set(ch, action);
    // A whole-body clip takes the layers over (not independent ones), blending like the clip.
    ch.releaseLayers(Math.max(0, key.blend - elapsed));
    const ex: [boolean, boolean, boolean] = [modes.x === 1, modes.y === 1, modes.z === 1];
    const rot = modes.rotation === 1;
    if (run && track && (ex.some(Boolean) || rot)) {
      // Motion counts from the later of the key and the last transform key (the object's pose
      // then), including what already played when the key is reached late.
      const lastXf = track.transforms[keyIndexAt(track.transforms, run.t)]?.time ?? -Infinity;
      // A previous extracted clip still holding the object: its motion up to this key stays.
      const prev = drives.get(ch);
      const base = ch.root.position.clone();
      // The object's rotation at the key: the transform key's (it may pose the object later in
      // this frame than the clip starts), else what it shows.
      const pz = run.pose(track);
      const baseQuat = pz ? new THREE.Quaternion(pz.quat[0], pz.quat[1], pz.quat[2], pz.quat[3]) : ch.root.quaternion.clone();
      if (prev && prev.run === run && prev.lastPose === run.pose(track)) {
        base.copy(prev.base).add(driveOffset(prev, ch, key.time));
        baseQuat.copy(driveRotation(prev, key.time));
      }
      drives.set(ch, {
        run,
        track,
        key,
        clip: c,
        action,
        axes: ex,
        rot,
        from: Math.max(key.time, Math.min(lastXf, run.t)),
        lastPose: run.pose(track),
        base,
        baseQuat,
      });
    } else drives.delete(ch);
    return true;
  };

  /** Channel table bone of a secondary channel of the character's model. */
  const channelBone = (ch: Character, channel: number): number | undefined => {
    const b = hardpointTable(pkgs, ch.skinned.ref)[channel];
    return b !== undefined && ch.skinned.skeleton.bones[b] ? b : undefined;
  };

  /** Secondary-channel key: the clip plays on the channel bone's subtree (a layer). */
  const playLayerKey = (ch: Character, key: StompAnimKey, elapsed: number) => {
    const bone = channelBone(ch, key.channel);
    const c = bone !== undefined ? clipFor(ch.skinned, key.clip) : undefined;
    if (bone === undefined || !c) return false;
    ch.playLayer(bone, c.clip, {
      loop: c.loop,
      timeScale: key.speed,
      time: scriptedClipTime(c, key, elapsed),
      blend: Math.max(0, key.blend - elapsed),
      independent: !!(key.flags & ANIM_INDEPENDENT),
    });
    return true;
  };

  /**
   * An animation key, posed at once: the characters' mixers ran earlier this frame (actors
   * system) and the key's transform key has already moved the object, so until their next
   * update the skeleton would show the previous clip at the new origin. In paired scenes both
   * objects are re-keyed with the clips (1a "Gaurd" #218 at 11.95 s: 16 m between origin and
   * body), and for that frame both bodies stood at the bare origins; culled around those hips,
   * the scripted actors also froze there until the next low-rate update (0.2 s).
   */
  const animKey = (ch: Character, key: StompAnimKey, elapsed: number, run?: StompRun, track?: StompTrack) => {
    const ok = key.channel === 0 ? playClip(ch, key, elapsed, run, track) : playLayerKey(ch, key, elapsed);
    if (ok) ch.update(0);
    return ok;
  };

  const _d = new THREE.Vector3();
  /** Height of the first surface straight down from `top`, if it lies above `y` - 0.05. */
  const floorBelow = (x: number, top: number, z: number, y: number): number | null => {
    const hit = ctx.view.collision?.raycast(x, top, z, 0, -1, 0, Math.max(0, top - y) + 0.05);
    return hit ? top - hit.distance : null;
  };
  /** Debug switches (window.__stomp.flags). */
  const debugFlags = { rootMotion: true };
  /** Clip root translation at sequence time `t`, loops unrolled (continuous over wraps). */
  const rootAt = (d: RootDrive, t: number) => {
    const c = d.clip, dur = Math.max(c.clip.duration, 1e-3);
    const ct = d.key.offset + (t - d.key.time) * d.key.speed * c.rate;
    if (!c.loop) return sampleTrackTranslation(c.data, Math.min(Math.max(0, ct), dur));
    const n = Math.floor(ct / dur), r = sampleTrackTranslation(c.data, ct - n * dur);
    const a0 = sampleTrackTranslation(c.data, 0), a1 = sampleTrackTranslation(c.data, dur);
    return r.map((v, i) => v + n * (a1[i] - a0[i]));
  };
  /** Clip root rotation at sequence time `t`, loops unrolled (each wrap adds end * start^-1). */
  const rootRotAt = (d: RootDrive, t: number) => {
    const c = d.clip, dur = Math.max(c.clip.duration, 1e-3);
    const q = (x: number) => new THREE.Quaternion(...sampleTrackRotation(c.data, x));
    const ct = d.key.offset + (t - d.key.time) * d.key.speed * c.rate;
    if (!c.loop) return q(Math.min(Math.max(0, ct), dur));
    const n = Math.floor(ct / dur), r = q(ct - n * dur);
    const wrap = q(dur).multiply(q(0).invert());
    for (let i = 0; i < Math.min(Math.abs(n), 64); i++) r.premultiply(n > 0 ? wrap : wrap.clone().invert());
    return r;
  };
  /**
   * World offset a drive has moved its object by at sequence time `t`: the root's translation
   * since `from`, in the object's frame at `from` (the clip's model space; with rotation mode 1
   * the object turns under it, so the root bone moves exactly as it would in the pose).
   */
  const driveOffset = (d: RootDrive, ch: Character, t: number) => {
    const a = rootAt(d, d.from), b = rootAt(d, Math.max(d.from, t));
    return new THREE.Vector3(d.axes[0] ? b[0] - a[0] : 0, d.axes[1] ? b[1] - a[1] : 0, d.axes[2] ? b[2] - a[2] : 0).multiply(ch.root.scale).applyQuaternion(d.baseQuat);
  };
  /** Object rotation of a drive at sequence time `t`: base * root(t) * root(from)^-1. */
  const driveRotation = (d: RootDrive, t: number) => {
    if (!d.rot) return d.baseQuat.clone();
    const rel = rootRotAt(d, Math.max(d.from, t)).multiply(rootRotAt(d, d.from).invert());
    return d.baseQuat.clone().multiply(rel);
  };
  /**
   * Move driven objects by their clip's extracted root motion (after this frame's poses),
   * computed from the sequence clock like the clip time itself.
   */
  const applyDrives = (run: StompRun) => {
    if (!debugFlags.rootMotion) return;
    for (const [ch, d] of drives) {
      if (d.run !== run) continue;
      if (current.get(ch) !== d.action || !d.action.isScheduled()) {
        drives.delete(ch);
        continue;
      }
      const pose = run.pose(d.track);
      if (pose !== d.lastPose) {
        // A transform key placed the object: the motion continues from that key (a step key),
        // or from now while keys interpolate the object (they re-pose it every frame).
        d.lastPose = pose;
        const tk = d.track.transforms, xi = keyIndexAt(tk, run.t), next = tk[xi + 1];
        const moving = !!next && !!(next.flags & (XF_LINEAR | XF_SPLINE)) && next.time - tk[xi].time >= 1e-3;
        d.from = moving || xi < 0 ? run.t : Math.max(d.key.time, tk[xi].time);
        if (pose) {
          d.base.set(pose.position[0] / SCALE, pose.position[1] / SCALE, pose.position[2] / SCALE);
          d.baseQuat.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
        } else {
          d.base.copy(ch.root.position);
          d.baseQuat.copy(ch.root.quaternion);
        }
      }
      _d.copy(driveOffset(d, ch, run.t));
      if (!_d.lengthSq() && !d.rot) continue;
      // Every frame: props and the puppet are re-posed from the track before this.
      const pos = d.base.clone().add(_d);
      const quat = d.rot ? driveRotation(d, run.t) : ch.root.quaternion.clone();
      const actor = actors()?.get(d.track.uid);
      if (actor && actor.ch === ch) {
        // A character the extracted motion takes down stops on the floor under it.
        if (d.axes[1]) pos.y = driveFloorY(pos.y, d.base.y, floorBelow(pos.x, Math.max(d.base.y, pos.y) + 0.05, pos.z, pos.y));
        actor.setScriptPose(pos, quat);
      } else {
        ch.root.position.copy(pos);
        ch.root.quaternion.copy(quat);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // The player's puppet (third-person model driven by the Player track)

  let puppet: Character | null = null;
  const makePuppet = (): Character | null => {
    const w = world.get(world.playerUid);
    const ref = w?.e.modelRef;
    const skinned = ref && readSkinnedModel(pkgs, ref);
    if (!skinned) return null;
    const ch = new Character(skinned, [], decodeCharacterTextures(skinned, pkgs));
    ch.root.name = 'stomp-player-puppet';
    ch.root.visible = false;
    view.scene.add(ch.root);
    return ch;
  };

  // Built with the level when any sequence drives the player (hidden until a cinematic shows
  // it): creating it, decoding its textures and compiling its materials at the first
  // cinematic's first frame hitched that frame (docs/game-logic.md §18).
  if (world.of('STOMP Player').some((sp) => world.sequenceOf(sp)?.tracks.some((t) => t.uid === world.playerUid))) puppet = makePuppet();

  // ---------------------------------------------------------------------------
  // Skinned props: sequence-driven objects with a skinned model that are not characters
  // (1a "Goose": Torque's shoes and his box of belongings are skinned Breakables posed by
  // animation keys). The static level renderer skips skinned models and the actors system
  // only takes characters / Animating Statics, so this system shows them: at their placement
  // until a sequence moves them, posed by transform keys, animated by animation keys, shown /
  // hidden / destroyed by the level logic.

  // Which objects: props.ts (instance flag 0x80 is no condition for plain prop classes; 1a
  // "Guard" #242's "Chain" that drags the guard into the duct has flags 0x1).
  const props = new Map<number, Character>();
  for (const sp of world.of('STOMP Player')) {
    for (const t of world.sequenceOf(sp)?.tracks ?? []) {
      const w = world.get(t.uid);
      const e = w?.e;
      if (!w || !e?.modelRef || props.has(t.uid) || !sequencePropCandidate(w.cls, e.flags, e.modelRef.pkg)) continue;
      if (e.family === 'Character' || w.cls === 'Animating Static' || w.cls === 'Player') continue;
      const skinned = readSkinnedModel(pkgs, e.modelRef);
      if (!skinned) continue;
      const ch = new Character(skinned, [], decodeCharacterTextures(skinned, pkgs));
      ch.root.name = `stomp-prop:${w.cls}#${t.uid.toString(16)}`;
      instanceMatrix(e.position, e.rotation).decompose(ch.root.position, ch.root.quaternion, new THREE.Vector3());
      ch.root.visible = w.visible && !w.destroyed;
      view.scene.add(ch.root);
      props.set(t.uid, ch);
    }
  }
  const updateProps = (dt: number) => {
    for (const [uid, ch] of props) {
      const w = world.get(uid);
      ch.root.visible = !!w && w.visible && !w.destroyed;
      if (ch.root.visible) ch.update(dt);
    }
  };

  /** Character a track drives (actor, the player puppet or a skinned prop). */
  const characterOf = (uid: number): Character | undefined => {
    if (uid === world.playerUid) return puppet ?? undefined;
    return actors()?.get(uid)?.ch ?? props.get(uid) ?? skinnedScenery()?.character?.(uid);
  };

  /**
   * Attach keys' links still in place: attached object uid -> carrier uid and hardpoint. The
   * engine keeps them after the sequence (its end, 0x4512c0 / 0x44f730, detaches nothing; only a
   * track-0 key or the attached object's death ends one) [verified], and a transform key on an
   * attached object is overwritten by the bone in the same frame (0x450470, then the attachment
   * pass 0x46b890) [verified]. 1a "Goose" leaves the Dumbell (Breakable 7b16) in Goose's hand at
   * the off-map staging area; its one key (150.12 s, on the cell floor) never shows. Saved, so a
   * checkpoint restore hangs it there again instead of drawing it at that key.
   */
  const attachLinks = new Map<number, { carrier: number; hp: number }>();
  const liveLinks = () =>
    [...attachLinks].filter(([c, l]) => {
      const w = world.get(c);
      return !!w && !w.destroyed && !!characterOf(l.carrier)?.root.parent;
    });
  const unregisterSave = registerSave<[number, number, number][]>(
    ctx.services,
    'sequence.attach',
    {
      save: () => liveLinks().map(([c, l]) => [c, l.carrier, l.hp]),
      load: (s) => {
        attachLinks.clear();
        const svc = ctx.services.weapons as AttachLike | undefined;
        for (const [c, carrier, hp] of Array.isArray(s) ? s : []) {
          const ch = characterOf(carrier);
          if (svc && ch && svc.attach(c, ch, hp)) attachLinks.set(c, { carrier, hp });
        }
      },
    },
    // After the world (its stomp keys pose the object) and the actors (the carriers).
    { scope: 'level', priority: 13 },
  );

  // ---------------------------------------------------------------------------
  // Cinematic state

  interface Cine {
    run: StompRun;
    camera?: StompTrack;
    player?: StompTrack;
    saved: { fov: number; playerEnabled: boolean; controlsEnabled: boolean; flashlight: boolean };
  }
  let cine: Cine | null = null;
  const sounds = new Map<StompRun, SoundHandle[]>();
  /** Looping voices of sequence keys and when they are cut (stompVoiceEnd). */
  let loopCuts: { h: SoundHandle; at: number }[] = [];
  /** Control hand-backs reached this frame, applied after its poses (observer.frame). */
  const releases = new Map<StompRun, StompTrack[]>();
  /** While skipping: animation keys per character, in order (the end state is applied at the end). */
  const pendingAnims = new Map<StompRun, Map<number, { key: StompAnimKey; track: StompTrack }[]>>();

  /** First-person viewmodel objects (the arms): LevelRenderer.viewmodel, else found by name. */
  const viewmodelParts = (): THREE.Object3D[] => {
    const vm = (view as { viewmodel?: THREE.Object3D }).viewmodel;
    if (vm) return vm.children;
    const a = view.scene.getObjectByName('player-arms')?.parent;
    return a ? [a] : [];
  };

  const trackOfClass = (run: StompRun, cls: string) => run.seq.tracks.find((t) => world.get(t.uid)?.cls === cls && t.transforms.length);

  const beginCinematic = (run: StompRun) => {
    const camera = trackOfClass(run, 'Camera');
    if (!camera) return;
    const player = run.seq.tracks.find((t) => t.uid === world.playerUid);
    // A sequence that drives the player ducks the music to half over 0.5 s (original rule).
    if (player) audio.fadeBus('music', CINEMATIC_MUSIC_ATTENUATION, CINEMATIC_MUSIC_FADE);
    cine = {
      run,
      camera,
      player,
      saved: {
        fov: view.camera.fov,
        playerEnabled: view.player.enabled,
        controlsEnabled: view.controls.enabled,
        flashlight: view.flashlight.visible,
      },
    };
    if (player && !puppet) puppet = makePuppet();
    if (puppet) {
      // Until the first Player key the puppet stands where the player is.
      const p = view.player.position;
      puppet.root.position.set(p.x, p.y, p.z);
      puppet.root.rotation.set(0, view.player.bodyYaw, 0);
      puppet.root.visible = !!player;
    }
    // The film camera is not the player's eye: his whole body is drawn, not the first-person
    // arms (player.ts setExternalView); with a Player track the puppet stands in for it.
    view.player.setExternalView('cinematic', true);
    container.classList.add('stomp-cine');
    subs.hintVisible = true;
    // The pointer lock is kept (mouse look is off while the camera is taken over): releasing it
    // here would open the pause menu (menu flow pauses on a lost lock), and control returns
    // locked when the cinematic ends.
    console.info(`[sequence] cinematic "${run.seq.tracks[0]?.name}" (${run.seq.duration.toFixed(1)} s, ${run.seq.tracks.length} tracks)`);
  };

  const holdCinematic = () => {
    // Re-assert every frame: menus / mode switches may toggle these.
    view.player.enabled = false;
    view.controls.enabled = false;
    // The player's own body where he stands, unless the sequence drives him (the puppet).
    view.player.root.visible = !cine?.player && view.walking;
    for (const o of viewmodelParts()) o.visible = false;
    // The flashlight hangs on the view camera, which the Camera track now drives: left on it
    // would light the scene from the film camera (flat, pale faces) and cast every character's
    // shadow straight behind it. The original's lamp belongs to the player [port: off while the
    // camera is taken over].
    view.flashlight.visible = false;
  };

  const endCinematic = (run: StompRun) => {
    if (!cine || cine.run !== run) return;
    const c = cine;
    cine = null;
    view.player.setExternalView('cinematic', false);
    if (c.player) audio.fadeBus('music', 0, CINEMATIC_MUSIC_FADE);
    container.classList.remove('stomp-cine');
    subs.hintVisible = false;
    view.flashlight.visible = c.saved.flashlight;
    view.camera.fov = c.saved.fov;
    view.camera.updateProjectionMatrix();
    // Hand control back where the Player track left the player.
    const pose = c.player ? run.pose(c.player) : undefined;
    if (pose) {
      const q = new THREE.Quaternion(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const yaw = Math.atan2(-f.x, -f.z);
      const feet = { x: pose.position[0] / SCALE, y: pose.position[1] / SCALE + 0.02, z: pose.position[2] / SCALE };
      view.player.teleport(feet, yaw, 0);
      if (!view.walking) view.controls.setPose(new THREE.Vector3(feet.x, feet.y + view.player.eyeHeight, feet.z), yaw, 0);
    }
    view.player.enabled = c.saved.playerEnabled && view.walking;
    view.controls.enabled = c.saved.controlsEnabled && !view.walking;
    view.player.update(0);
    // The player body / arms re-evaluate their visibility on the next player update.
    if (puppet) puppet.root.visible = false;
    console.info(`[sequence] cinematic finished${run.skipping ? ' (skipped)' : ''}; control back at`, pose?.position.map((x) => (x / SCALE).toFixed(2)).join(', '));
  };

  // ---------------------------------------------------------------------------
  // Keys

  const trackPosition = (run: StompRun, track: StompTrack): [number, number, number] | undefined => {
    const ch = characterOf(track.uid);
    if (ch) {
      const p = ch.root.getWorldPosition(new THREE.Vector3());
      return [p.x, p.y + 1.5, p.z];
    }
    const pose = track.transforms.length ? run.pose(track) : undefined;
    if (pose) return [pose.position[0] / SCALE, pose.position[1] / SCALE, pose.position[2] / SCALE];
    const w = world.get(track.uid);
    return w ? [w.pos[0], w.pos[1], w.pos[2]] : undefined;
  };

  const playSound = (run: StompRun, track: StompTrack, key: StompSoundKey) => {
    const k = `${key.sound.pkg}:${key.sound.id}`;
    const info = audio.get(k);
    const dialog = info?.category === SoundCategory.Dialog;
    const subtitle = info?.subtitle ? readXduString(pkgs, info.subtitle) : undefined;
    log.push({
      seq: run.seq.tracks[0]?.name ?? String(run.seq.id),
      t: +run.t.toFixed(2),
      track: track.name,
      sound: k,
      category: info?.categoryName ?? 'missing',
      subtitle: subtitle ? `${subtitle.length} chars` : undefined,
      played: !!info && !run.skipping,
    });
    if (!info || run.skipping) return;
    const pos = key.flags & 0x10 ? undefined : trackPosition(run, track);
    // Key volume x header volume, clamped to 1 (EXE 0x450ab1; audio.play applies the header).
    const hv = info.volume > 0 ? info.volume : 1;
    const h = audio.play(k, { volume: stompKeyGain(key.volume, hv) / hv, position: pos, bus: dialog ? 'voice' : undefined });
    const list = sounds.get(run) ?? sounds.set(run, []).get(run)!;
    list.push(h);
    // A looping sound started by a key plays one pass (EXE 0x44eb10).
    if (h.loop) loopCuts.push({ h, at: stompVoiceEnd(clock, info.duration) });
    // Lip-sync: the track's object is the speaker (src/game/actors/lipsync.ts).
    lipSyncService(ctx)?.speak(h, track.uid, characterOf(track.uid));
    // Key flag 0x20 hands the sound to the track's character (message 0x1011, SUFFERING.EXE
    // 0x450b10): its speech channel takes it at priority 9, cutting the line it was saying, and
    // the character's own lines wait for it (actors/speech.ts) [verified].
    if (key.flags & 0x20) actors()?.get(track.uid)?.adoptSpeech?.(h);
    // Paged over the line's duration, the box closes 1 s after it (cinema.ts subtitlePages).
    if (subtitle && loadSettings().subtitles) subs.show(subtitle, clock, Math.max(0, info.duration));
  };

  const control = (track: StompTrack, release: boolean) => {
    const a = actors()?.get(track.uid);
    if (!a) return;
    if (release) a.setScriptPose(null);
    else if (!a.scripted) {
      const r = a.ch.root;
      a.setScriptPose(r.position.clone(), r.quaternion.clone());
    }
  };

  // ---------------------------------------------------------------------------
  // Debug probe (tools/stomp-audit.ts): the state every track's object actually shows at
  // requested sequence times, recorded on the first frame at or after each time.

  const yawOf = (q: THREE.Quaternion) => {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return Math.round((Math.atan2(-f.x, -f.z) * 180) / Math.PI);
  };
  /** Clip an actor / character shows: "<animation set>/<clip id>". */
  const poseOf = (ch: Character): string | undefined => {
    const act = current.get(ch) ?? ch.current;
    if (!act || !(act.isRunning() || act.enabled)) return undefined;
    const ref = clipRefOf.get(act.getClip());
    const i = ch.clips.indexOf(act.getClip());
    const d = i >= 0 ? ch.clipData[i] : ref ? loadClip(pkgs, { pkg: +ref.split(':')[0], id: +ref.split(':')[1] }) : undefined;
    return d ? `${d.animSet}/${d.id}` : undefined;
  };
  /** Actual state of the object `uid` (a track's object or an indirect target). */
  const probeObject = (row: ProbeRow, uid: number) => {
    const w = world.get(uid);
    row.visible = w?.visible;
    const a = actors()?.get(uid) as (ActorLike & { alive?: boolean; activity?: string }) | undefined;
    const ch = characterOf(uid);
    if (ch) {
      row.rendered = uid === world.playerUid ? 'puppet' : props.has(uid) ? 'skinned' : 'actor';
      const r = ch.root;
      row.position = [r.position.x, r.position.y, r.position.z];
      row.yaw = yawOf(r.quaternion);
      row.visible = r.visible && (w?.visible ?? true);
      row.drawn = row.visible && ch.mesh.visible;
      const act = current.get(ch) ?? ch.current;
      if (act?.isRunning() || act?.enabled) {
        row.clip = clipRefOf.get(act.getClip());
        row.clipTime = +act.time.toFixed(2);
      }
      row.pose = poseOf(ch);
      if (a) {
        row.scripted = a.scripted;
        row.alive = a.alive;
        row.activity = a.activity;
      }
    } else if (w?.cls === 'Camera') {
      row.rendered = 'camera';
      row.position = [view.camera.position.x, view.camera.position.y, view.camera.position.z];
      row.yaw = yawOf(view.camera.quaternion);
    } else if (w) {
      const o = view.scene.getObjectByName(`${w.cls}#${uid.toString(16)}`);
      if (o) {
        row.rendered = 'dynamic';
        const p = new THREE.Vector3(), q = new THREE.Quaternion();
        o.updateWorldMatrix(true, false); // normally done by the render (the sampler skips it)
        o.matrixWorld.decompose(p, q, new THREE.Vector3());
        row.position = [p.x, p.y, p.z];
        row.yaw = yawOf(q);
        row.visible = o.visible;
      } else if (!w.e.modelRef) row.rendered = 'logic';
    }
    return row;
  };
  const probeName = (run: StompRun) => `${run.seq.tracks[0]?.name ?? ''}#${run.seq.id}`;
  const sampleProbe = (run: StompRun) => {
    const name = probeName(run);
    probe!.seen.set(name, run);
    const log = world.log;
    let i = log.length;
    while (i > 0 && log[i - 1] !== probe!.lastLog) i--;
    for (; i < log.length; i++) {
      const e = log[i];
      if (e.from === run.uid) probe!.messages.push({ seq: name, at: +run.t.toFixed(5), to: e.to, message: e.message, handled: e.handled });
    }
    probe!.lastLog = log[log.length - 1];
    const times = probe!.times.get(name);
    while (times?.length && times[0] <= run.t + 1e-4) {
      const t = times.shift()!;
      const at = +run.t.toFixed(5);
      for (const track of run.seq.tracks) probe!.rows.push(probeObject({ seq: name, index: track.index, t, at, rendered: 'none' }, track.uid));
      for (const uid of probe!.extra.get(name) ?? []) probe!.rows.push(probeObject({ seq: name, index: -1, uid, t, at, rendered: 'none' }, uid));
    }
  };

  /** Cinematic frame: camera (pose, lens) and the player's puppet from their tracks. */
  const presentCinematic = (c: Cine, run: StompRun) => {
    holdCinematic();
    const cam = c.camera && run.pose(c.camera);
    if (cam) {
      view.camera.position.set(cam.position[0] / SCALE, cam.position[1] / SCALE, cam.position[2] / SCALE);
      // Keys hold the object rotation (stomp.ts): the camera looks down its -Z like a model.
      view.camera.quaternion.set(cam.quat[0], cam.quat[1], cam.quat[2], cam.quat[3]);
      const lens = c.camera && sampleCamera(c.camera, run.t);
      if (lens?.fov) {
        const fov = lensFov(lens.fov, view.camera.aspect);
        if (Math.abs(view.camera.fov - fov) > 1e-3) {
          view.camera.fov = fov;
          view.camera.updateProjectionMatrix();
        }
      }
      view.camera.updateMatrixWorld();
      // The actors culled for last frame's camera (they update before the world system):
      // after a cut the next frame would show the previous shot's culling.
      actors()?.refreshVisibility?.(view.camera);
    }
    const pl = c.player && run.pose(c.player);
    if (pl && puppet) {
      puppet.root.position.set(pl.position[0] / SCALE, pl.position[1] / SCALE, pl.position[2] / SCALE);
      puppet.root.quaternion.set(pl.quat[0], pl.quat[1], pl.quat[2], pl.quat[3]);
      puppet.root.visible = world.get(world.playerUid)?.visible !== false;
    }
  };

  /**
   * Decode a sequence's sounds ahead of their keys, in key order and one at a time (a burst of
   * decodes competes with the frame; a line decoded at its key also starts late). §18.
   */
  const preloadSounds = (run: StompRun) => {
    const keys = run.seq.tracks
      .flatMap((t) => t.sounds)
      .sort((a, b) => a.time - b.time)
      .map((k) => `${k.sound.pkg}:${k.sound.id}`)
      .filter((k) => !!audio.get(k));
    let chain = Promise.resolve();
    for (const k of new Set(keys)) chain = chain.then(() => audio.load(k).then(noop, noop));
  };

  const observer: StompObserver = {
    begin(run) {
      if (!run.skipping) preloadSounds(run);
      if (run.cinematic && !cine) beginCinematic(run);
    },
    event(run: StompRun, track: StompTrack, ev: StompEvent) {
      switch (ev.kind) {
        case 'anim': {
          if (run.skipping) {
            const m = pendingAnims.get(run) ?? pendingAnims.set(run, new Map()).get(run)!;
            (m.get(track.uid) ?? m.set(track.uid, []).get(track.uid)!).push({ key: ev.key, track });
            return;
          }
          const ch = characterOf(track.uid);
          if (ch) animKey(ch, ev.key, Math.max(0, run.t - ev.key.time), run, track);
          return;
        }
        case 'sound':
          playSound(run, track, ev.key);
          return;
        case 'control':
          // Letterbox: a control key on the player in a sequence with flag 0x04 (0x450ea6).
          if (track.uid === world.playerUid && run.seq.flags & SEQ_LETTERBOX) {
            if (!ev.key.release) setLetterbox(run);
            else if (letterboxRun === run) setLetterbox(null);
          }
          // A hand-back takes effect after this frame's poses: a transform key just before
          // the release key (1a guard scene: 20.09 / 20.10 s) is reached in the same frame
          // and would take the actor over again.
          if (ev.key.release) (releases.get(run) ?? releases.set(run, []).get(run)!).push(track);
          else {
            const r = releases.get(run);
            if (r?.includes(track)) r.splice(r.indexOf(track), 1);
            control(track, false);
          }
          return;
        case 'attach': {
          // Hardpoint attachment (props in hands): services.weapons (src/game/weapons/attach.ts)
          // parents the other track's object to the carrier's hardpoint (channel table of the
          // carrier model, docs/game-logic.md §7.1); track 0 clears the hardpoint. Also applied
          // while skipping so the end state is right.
          const svc = ctx.services.weapons as AttachLike | undefined;
          const ch = characterOf(track.uid);
          if (!svc || !ch) return;
          // The hardpoint's previous occupant goes (0x46d9d0 detaches it first).
          for (const [c, l] of attachLinks) if (l.carrier === track.uid && l.hp === ev.key.hardpoint) attachLinks.delete(c);
          if (!ev.key.track) svc.detachHardpoint(ch, ev.key.hardpoint);
          else {
            const child = run.trackByIndex(ev.key.track);
            if (child && child !== track && svc.attach(child.uid, ch, ev.key.hardpoint)) attachLinks.set(child.uid, { carrier: track.uid, hp: ev.key.hardpoint });
          }
          return;
        }
      }
    },
    frame(run) {
      for (const t of releases.get(run) ?? []) control(t, true);
      releases.delete(run);
      for (const t of run.seq.tracks) {
        const ch = t.transforms.length ? props.get(t.uid) : undefined;
        const pose = ch && run.pose(t);
        if (!ch || !pose) continue;
        ch.root.position.set(pose.position[0] / SCALE, pose.position[1] / SCALE, pose.position[2] / SCALE);
        ch.root.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
      }
      if (cine?.run === run) presentCinematic(cine, run);
      applyDrives(run);
      sampleClockRate(run);
      updateClockRate();
      // After the camera / puppet poses of this frame (the probe reads them back).
      if (probe) sampleProbe(run);
    },
    end(run) {
      // Final poses are applied after the last keys: hand released actors back again.
      for (const t of run.seq.tracks) {
        const last = t.controls[t.controls.length - 1];
        if (last?.release) control(t, true);
      }
      // Skipped: show the end state of each character's last animation.
      const pend = pendingAnims.get(run);
      if (pend) {
        for (const [uid, keys] of pend) {
          const ch = characterOf(uid);
          if (!ch) continue;
          // The end state: the last whole-body clip, then the last clip of every channel
          // keyed after it (an earlier layer was taken over by that whole-body clip).
          let last0 = -1;
          keys.forEach((k, i) => k.key.channel === 0 && (last0 = i));
          const lastOf = new Map<number, number>();
          keys.forEach((k, i) => i > last0 && k.key.channel !== 0 && lastOf.set(k.key.channel, i));
          for (const i of [last0, ...lastOf.values()].filter((i) => i >= 0).sort((a, b) => a - b)) {
            const { key } = keys[i];
            animKey(ch, { ...key, blend: 0 }, Math.max(0, run.seq.duration - key.time));
          }
        }
        pendingAnims.delete(run);
      }
      for (const [ch, d] of drives) if (d.run === run) drives.delete(ch);
      clockRates.delete(run);
      updateClockRate();
      if (run.skipping) for (const h of sounds.get(run) ?? []) h.stop(0.2);
      // The sequence's voices stop with it (EXE 0x44ec60 from 0x44f7ba): its loops at once.
      // One-shots finish [port: the sequence end time is inferred, lines must not be cut].
      else for (const h of sounds.get(run) ?? []) if (h.loop) h.stop(0);
      // Screen effects (Screen Fader / Blur, insanity system) run on game time: after a skip
      // they would still show the state at the skip (1a "Goose" opens on a black fader that
      // holds 3.75 s). Let the skipped time pass for them once the skip's messages went out
      // (the world flushes them after this returns).
      const skipped = run.skipping ? run.seq.duration - run.skippedFrom : 0;
      if (skipped > 0) {
        const insanity = ctx.services.insanity as { fastForwardScreen?(s: number): void } | undefined;
        queueMicrotask(() => insanity?.fastForwardScreen?.(skipped));
      }
      sounds.delete(run);
      if (run.skipping || run.cinematic) subs.clear();
      if (letterboxRun === run) setLetterbox(null);
      endCinematic(run);
    },
  };

  world.stompObserver = observer;
  // Sequences that started before this system did.
  for (const r of world.runningStomps()) observer.begin(r);

  // Esc skips a cinematic (Enter is handled by the world system); other game input is
  // swallowed while the camera is taken over.
  //
  // With the pointer locked, Esc also makes the browser release the lock, and the menu flow
  // opens the pause menu on a lost lock (src/app/menu/flow.ts onPointerLockChange). A lock
  // lost during a cinematic, or right after Esc skipped one, is therefore kept from the other
  // pointerlockchange listeners (this capture listener on document runs first); the view's
  // lock hint is updated here instead. A lock lost while the window keeps the focus counts as
  // Esc (skip) for browsers that do not pass Esc on while locked; losing it to a window switch
  // pauses nothing and skips nothing.
  const PASS = new Set(['Enter', 'NumpadEnter', 'F1', 'Backquote']);
  let skippedAt = -Infinity;
  const onKey = (e: KeyboardEvent) => {
    if (!cine) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        skippedAt = performance.now();
        world.skipCutscenes();
      }
      return;
    }
    if (!PASS.has(e.code)) e.stopImmediatePropagation();
  };
  const onMouse = (e: MouseEvent) => {
    if (cine) e.stopImmediatePropagation();
  };
  const onLockChange = (e: Event) => {
    if (document.pointerLockElement) return;
    const justSkipped = performance.now() - skippedAt < 500;
    if (!cine && !justSkipped) return;
    e.stopImmediatePropagation();
    const controls = view.controls as { onLockChange?: (locked: boolean) => void };
    controls.onLockChange?.(false);
    // Browsers that keep the Esc key from the page while locked: a lock lost with the window
    // still focused was Esc (a window switch takes the focus too).
    if (cine && !justSkipped && document.hasFocus()) {
      skippedAt = performance.now();
      world.skipCutscenes();
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  document.addEventListener('pointerlockchange', onLockChange, true);
  // Gamepad: the menu flow asks first on Start / A / B (src/app/menu/flow.ts update()).
  const padSkip = (): boolean => {
    if (!cine && !world.activeCutscenes().length) return false;
    skippedAt = performance.now();
    world.skipCutscenes();
    return true;
  };
  uiBridge.skipCutscene = padSkip;

  Object.assign(window, {
    __stomp: {
      log,
      /** Debug: { rootMotion } - false keeps objects at their keyed poses (no mode-1 drive). */
      flags: debugFlags,
      get runs() {
        return world.runningStomps();
      },
      get cinematic() {
        return !!cine;
      },
      get puppet() {
        return puppet;
      },
      /**
       * Debug: record every track's actual state at these sequence times, keyed by
       * "<first track name>#<sequence id>" (e.g. { 'Goose#284': [3.98, 40.4] }), plus the state
       * of `extra` objects (uids per sequence: objects it reaches through relays, togglers and
       * timers); read the rows back from `probeRows` / `probeMessages` (tools/stomp-audit.ts
       * diffs them).
       */
      probe(times: Record<string, number[]>, extra: Record<string, number[]> = {}) {
        probe = {
          times: new Map(Object.entries(times).map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
          extra: new Map(Object.entries(extra)),
          seen: new Map(),
          rows: [],
          messages: [],
        };
      },
      /**
       * Debug: record the current state of a probed sequence's objects (tracks and indirect
       * targets) after it ended; `t` = seconds since its end (rows flagged `after`).
       */
      snapshot(name: string, t: number) {
        const run = probe?.seen.get(name);
        if (!probe || !run) return 0;
        const at = run.seq.duration;
        const n = probe.rows.length;
        for (const track of run.seq.tracks) probe.rows.push(probeObject({ seq: name, index: track.index, t, at, after: true, rendered: 'none' }, track.uid));
        for (const uid of probe.extra.get(name) ?? []) probe.rows.push(probeObject({ seq: name, index: -1, uid, t, at, after: true, rendered: 'none' }, uid));
        return probe.rows.length - n;
      },
      get probeRows() {
        return probe?.rows ?? [];
      },
      get probeMessages() {
        return probe?.messages ?? [];
      },
      /** Sequences the probe saw run (names as in probe()). */
      get probeSeen() {
        return [...(probe?.seen.keys() ?? [])];
      },
      /** Debug: run the level logic ahead by `seconds` (0.1 s steps). */
      fastForward(seconds: number) {
        for (let t = 0; t < seconds; t += 0.1) world.update(0.1);
      },
    },
  });

  // Subtitles and the skip hint are DOM over the canvas: while the game is paused (pause menu;
  // the app stops calling update) they would draw on top of the menu. Hidden while no frame
  // reaches this system.
  let lastUpdate = performance.now();
  let raf = 0;
  const watchPause = () => {
    const paused = performance.now() - lastUpdate > 250;
    const v = paused ? 'hidden' : '';
    if (subs.root.style.visibility !== v) subs.root.style.visibility = v;
    raf = requestAnimationFrame(watchPause);
  };
  raf = requestAnimationFrame(watchPause);

  return {
    name: 'sequence',
    update(dt) {
      lastUpdate = performance.now();
      if (subs.root.style.visibility) subs.root.style.visibility = '';
      clock += dt;
      if (loopCuts.length) loopCuts = loopCuts.filter((c) => (c.h.playing && clock >= c.at ? (c.h.stop(0), false) : c.h.playing));
      puppet?.update(dt);
      updateProps(dt);
      subs.update(clock);
    },
    dispose() {
      unregisterSave();
      cancelAnimationFrame(raf);
      if (world.stompObserver === observer) world.stompObserver = undefined;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      document.removeEventListener('pointerlockchange', onLockChange, true);
      if (uiBridge.skipCutscene === padSkip) delete uiBridge.skipCutscene;
      clockRates.clear();
      stompRate = 1;
      // Restore a plain property unless someone replaced the accessor since (a debug tool).
      if (rateHooked && Object.getOwnPropertyDescriptor(view, 'timeScale')?.get === rateGet) {
        Object.defineProperty(view, 'timeScale', { value: baseRate, writable: true, configurable: true, enumerable: true });
      }
      for (const list of sounds.values()) for (const h of list) h.stop(0.1);
      for (const d of bars) d.remove();
      if (cine) {
        container.classList.remove('stomp-cine');
        view.flashlight.visible = cine.saved.flashlight;
        view.camera.fov = cine.saved.fov;
        view.camera.updateProjectionMatrix();
        cine = null;
        view.player.setExternalView('cinematic', false);
      }
      puppet?.dispose();
      for (const ch of props.values()) {
        ch.root.removeFromParent();
        ch.dispose();
      }
      subs.dispose();
      style.remove();
      delete (window as unknown as { __stomp?: unknown }).__stomp;
    },
  };
}
