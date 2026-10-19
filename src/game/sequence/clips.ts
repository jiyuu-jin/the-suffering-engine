// Scripted animation for sequence-driven characters (STOMP animation keys, docs/game-logic.md
// §7 / §11.4): how a clip is built for a rig, and how an animation key takes the character over.
//
//   const c = makeScriptedClip(clipData, character.skinned);
//   playScriptedClip(character, c, key, sequenceTime - key.time);
//
// Two rules matter for scenes where two characters must meet (1a "Gaurd" #280: the
// CartWheeler's blade through the flashlight guard's head):
//   * the clip keeps its body offset (hips translation) while root motion is stripped: both
//     characters of a paired kill play from nearly the same origin and their clips carry the
//     whole relative placement (7 m for that scene);
//   * the scripted clip is the only clip on the character: every other action still active on
//     the mixer (an AI idle started between two sequences, a clamped once-clip) fades out.
//     three.js averages active actions by weight, so one stray idle at weight 1 halves the
//     scripted pose, body offset included.

import * as THREE from 'three/webgpu';
import { buildAnimationClip, mixerActionsOf, type Character, type RootAxes } from '../../app/character';
import type { AnimClipData } from '../../formats/animation';
import type { SkinnedModel } from '../../formats/skeleton';

export interface ScriptedClip {
  clip: THREE.AnimationClip;
  /** Clip header flag 1 = plays once (designers time the next key to its end); else it loops. */
  loop: boolean;
  /** The clip's own playback rate (header). */
  rate: number;
  data: AnimClipData;
}

/** The parts of an animation key (stomp.ts StompAnimKey) that start a clip. */
export interface ScriptedClipKey {
  /** Start position in the clip (s). */
  offset: number;
  /** Cross-fade time (s). */
  blend: number;
  /** Playback speed (0 holds the pose). */
  speed: number;
}

/**
 * Clip for a scripted character. Every rotation-only bone track poses its bone at the clip's
 * constant translation, as the engine samples it (buildAnimationClip). Two cases make it
 * visible in scenes:
 *   - the hips (children of the root bone) carry the clip's body offset: scripted poses such as
 *     sitting in a chair or leaning over a desk put the pelvis well away from the object origin
 *     (1a "Goose": the seated door guard's hips sit 0.65 m behind and 0.23 m below the origin;
 *     at the bind position he sits in front of the chair and his button-press hand stops ~0.7 m
 *     short of the console);
 *   - attach points (attachPointBones) sit where the held object belongs (Torque's photo).
 *
 * `axes`: the key's root-motion modes (stomp.ts rootMotionModes; docs/re/animation.md): axes
 * in mode 0 keep the root bone's translation in the pose, modes 1 / 2 zero it (mode 1 motion
 * is moved onto the object by the presenter). Without modes: horizontal root motion stripped.
 */
export function scriptedClip(data: AnimClipData, skinned: SkinnedModel, axes?: RootAxes): THREE.AnimationClip {
  return buildAnimationClip(data, skinned.skeleton, { rootMotion: axes ?? 'inPlace' });
}

const attachPoints = new WeakMap<SkinnedModel, Set<number>>();
/**
 * Bones whose whole subtree skins no vertex: the rig's attach points (the hand "weapon" bone 35
 * of the human rigs, hardpoint channel 16 / 19, and the other weightless leaves). A clip places
 * them where the held object belongs, independently of the hand: Torque's "looks at the photo"
 * clips (1a "Goose" 2:395 / 2:396) move bone 35 7-12 cm from its bind position towards the
 * fingertips, so the photo attached there is held by its edge instead of through the palm.
 * Their translation cannot distort the mesh. Every clip places them by its own constant
 * translation (buildAnimationClip), like every other rotation-only bone.
 */
export function attachPointBones(skinned: SkinnedModel): Set<number> {
  let set = attachPoints.get(skinned);
  if (set) return set;
  const skel = skinned.skeleton;
  const weighted = new Uint8Array(skel.bones.length);
  for (let i = 0; i < skel.skinIndex.length; i++) if (skel.skinWeight[i] > 0 && skel.skinIndex[i] < weighted.length) weighted[skel.skinIndex[i]] = 1;
  const subtree = new Int8Array(skel.bones.length).fill(-1);
  const skins = (i: number): number => {
    if (subtree[i] < 0) {
      subtree[i] = weighted[i];
      for (const c of skel.bones[i].children) if (skins(c)) subtree[i] = 1;
    }
    return subtree[i];
  };
  set = new Set(skel.bones.filter((b) => b.parent >= 0 && !skins(b.index)).map((b) => b.index));
  attachPoints.set(skinned, set);
  return set;
}

export function makeScriptedClip(data: AnimClipData, skinned: SkinnedModel, axes?: RootAxes): ScriptedClip {
  return { clip: scriptedClip(data, skinned, axes), loop: !(data.flags & 1), rate: data.rate || 1, data };
}

/**
 * Height of a character the extracted root motion of a scripted clip (STOMP mode 1 on y) moves:
 * the motion's height, but never below the floor under it when the motion went down from the
 * drive's start (`baseY`) [inferred: the engine hands the root delta to the character's mover,
 * 0x478b90 -> anim component +0x6c; the leap of 1a "CartWheeler#210" (12:11, root y -0.3 ..
 * -0.7 m for its last 1.2 s) would otherwise bury the creature 0.7 m in the gas chamber floor,
 * where the scene shows it from the player's side]. `floorY`: the first surface under it
 * between its start height and its new height (null: none).
 */
export function driveFloorY(y: number, baseY: number, floorY: number | null): number {
  if (floorY === null || y >= baseY || floorY > baseY + 0.05) return y;
  return Math.max(y, floorY);
}

/** All actions a mixer has created (three.js keeps them in a protected list). */
export const mixerActions = mixerActionsOf;

/** Clip time `elapsed` seconds after a key: offset + elapsed * speed * rate (held / wrapped). */
export function scriptedClipTime(c: ScriptedClip, key: ScriptedClipKey, elapsed: number): number {
  const dur = c.clip.duration;
  const t = key.offset + elapsed * key.speed * c.rate;
  return c.loop ? ((t % Math.max(dur, 1e-3)) + Math.max(dur, 1e-3)) % Math.max(dur, 1e-3) : Math.min(Math.max(0, t), dur);
}

/**
 * Start a scripted clip on a character `elapsed` seconds after its key: clip time
 * `offset + elapsed * speed * rate` (held at the end of a once-clip, wrapped for a loop). Every
 * other active action on the character fades out over what is left of the key's blend time
 * (stopped at once without one), on the engine's blend curve. Returns the action, which
 * becomes `ch.current`. Layers are the caller's (Character.releaseLayers).
 */
export function playScriptedClip(ch: Character, c: ScriptedClip, key: ScriptedClipKey, elapsed: number): THREE.AnimationAction {
  const action = ch.mixer.clipAction(c.clip);
  const wasOn = action.isRunning() && action.getEffectiveWeight() > 0;
  action.reset();
  action.setLoop(c.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = !c.loop;
  action.timeScale = key.speed * c.rate;
  action.time = scriptedClipTime(c, key, elapsed);
  action.enabled = true;
  action.play();
  const fade = Math.max(0, key.blend - elapsed);
  const others = mixerActions(ch.mixer).filter((o) => o !== action && o.isScheduled() && !ch.isLayerAction(o));
  if (fade > 0.01 && wasOn) {
    // The same clip again (engine: no cross-fade, only the time is set).
    ch.fadeAction(action, 1, 0);
    for (const o of others) ch.fadeAction(o, 0, fade);
  } else if (fade > 0.01) {
    action.setEffectiveWeight(0);
    ch.crossFadeTo(action, fade, others);
  } else {
    for (const o of others) o.stop();
    ch.fadeAction(action, 1, 0);
  }
  ch.current = action;
  if (key.speed === 0) action.paused = false; // timeScale 0 holds the pose
  return action;
}

/**
 * Camera-key FOV -> three.js vertical FOV. The key's value goes to the same lens call as the
 * level lens (SUFFERING.EXE 0x44e4cf -> view manager vtable +0x28 = 0x4b0d90; Level
 * Properties p16 at Suffering.rfl 0x100b2364): a VERTICAL angle of the 4:3 picture (lens
 * 48 / tan(fov / 2) on a 128 x 96 film). Wider screens keep the 4:3 horizontal angle, the
 * rule of the renderer's viewmodel lens.
 */
export const lensFov = (deg: number, aspect: number) => (2 * Math.atan(Math.tan((deg * Math.PI) / 360) * Math.min(1, 4 / 3 / Math.max(aspect, 1e-3))) * 180) / Math.PI;
