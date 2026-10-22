// Skinned characters (player, monsters, NPCs) for Three.js / WebGPU.
//
//   const skinned = readSkinnedModel(packages, { id: 9, pkg: 2 });          // Torque
//   const clips = listAnimations(systemAdu, skinned.animSet).map((c) => readAnimation(systemAdu, c.id)!);
//   const ch = new Character(skinned, clips, decodeCharacterTextures(skinned, packages));
//   scene.add(ch.root);
//   ch.play('run_forward', { fade: 0.2 });
//   renderer.onFrame((dt) => ch.update(dt));
//
// Geometry stays in model space (Y up, faces -Z, model units == level output units).

import * as THREE from 'three/webgpu';
import type { DecodedTexture } from '../formats/types';
import { Blend, findEntry, TDU_TEXTURE, type PackageSet, type SurfaceMaterial } from '../formats/model';
import { decodeTexture } from '../formats/texture';
import { modelCullsBackFaces } from '../formats/render-data';
import { boneSubtree, MAX_INFLUENCES, type Skeleton, type SkinnedModel } from '../formats/skeleton';
import { blendInto, guessClipLabel, type AnimClipData } from '../formats/animation';
import { instanceRotation, toOutputSpace, type LevelObject } from '../formats/level';
import { engineLightMaterial } from './engine-light';
import { createSurfaceMaterial, missingTexture } from './surface-material';

/**
 * Whether a character submesh needs its decoded surface material rather than the plain lit
 * skin: blended / effect base passes (alpha, additive, subtractive, darkening, modulate2x).
 * Hermes (model 10:92) is two additive passes tinted 0x4b4b4b: a translucent glow, not a solid
 * body (docs/game-logic.md §16) [verified data; the engine draws characters through the same
 * material passes as every other model].
 * A tinted base pass also needs it: the engine draws a tinted layer as texture x tint, unlit
 * (TFACTOR replaces the vertex lighting, docs/re/renderer.md §3.5) [verified]. Killjoy (10:90)
 * is such a body (Layered: texture x 0x414141, then an additive pass), which the lit skin drew
 * as an ordinary lit figure.
 */
export function characterSurfaceBlend(m: SurfaceMaterial | undefined): boolean {
  const l = m?.layers.find((x) => x.texture || x.frames);
  const b = l?.blend;
  if (l?.tint !== undefined) return true;
  return b === Blend.Alpha || b === Blend.Add || b === Blend.Subtract || b === Blend.MulAlpha || b === Blend.Modulate2x;
}

/**
 * Per-axis root-motion modes of the engine's animator (STOMP animation key flags, low byte;
 * docs/re/animation.md): 0 = the root bone keeps that motion in the pose, 1 = extracted (the
 * pose loses it, the object is moved by it), 2 = locked (the pose loses it, nothing moves).
 * For rotation, 0 keeps it in the pose; 1 and 2 hold the root rotation of the clip start in
 * the pose, and with 1 the sequence presenter turns the object by the root's rotation since
 * the key (SUFFERING.EXE 0x478ec2..0x478f35: reference root and object matrices captured at
 * the key, the object follows the root's rotation relative to that reference).
 */
export interface RootAxes {
  x: 0 | 1 | 2;
  y: 0 | 1 | 2;
  z: 0 | 1 | 2;
  rotation: 0 | 1 | 2;
}

export type RootMotionMode =
  /** Keep the root bone's horizontal translation (character walks away from its origin). */
  | 'keep'
  /** Strip horizontal root translation (animate in place; vertical bob kept). */
  | 'inPlace'
  /** The engine's per-axis modes (axes with mode 1 / 2 are zeroed, as SUFFERING.EXE 0x478c07). */
  | RootAxes;

export interface ClipBuildOptions {
  rootMotion?: RootMotionMode;
  /**
   * Rotation-only (0xc0) tracks store a constant bone translation. 'animation' (the default)
   * is the engine's sampler: the bone's translation IS that constant (SUFFERING.EXE 0x46a180 /
   * 0x46a290, scaled at load like the key translations, 0x4737d0); only bones the clip has no
   * track for keep the rig's bind translation (skeleton node +0x7c). Clips bind by bone hash
   * whatever rig plays them (0x4793b0), so a clip made on another rig poses with that rig's
   * lengths, as in the original (Torque's creature morph 2:163 starts at the human lengths).
   * 'bind' (the mesh's own bone lengths for every rotation-only bone) is not the engine's
   * rule; it is kept for comparisons (tools/clip-constants.ts).
   */
  constantTranslations?: 'animation' | 'bind';
  /** Clip name; default "<label>#<id>" from guessClipLabel. */
  name?: string;
}

/** Decode the diffuse textures referenced by a skinned model (keyed like ModelSubmesh.textureKey). */
export function decodeCharacterTextures(skinned: SkinnedModel, packages: PackageSet): Map<string, DecodedTexture> {
  const out = new Map<string, DecodedTexture>();
  const add = (key: string | undefined) => {
    if (!key || out.has(key)) return;
    const [pkg, id] = key.split(':').map(Number);
    const tdu = packages.get(pkg)?.tdu;
    const entry = findEntry(tdu, TDU_TEXTURE, id);
    if (!tdu || !entry) return;
    const tex = decodeTexture(tdu, entry, { rowOrder: 'stored' });
    if (tex) out.set(key, { ...tex, key });
  };
  for (const s of skinned.model.submeshes) {
    add(s.textureKey);
    // Surface-material submeshes draw every pass: their later layers' textures too (Killjoy's
    // second pass 10:428 was missing and drew the placeholder).
    if (characterSurfaceBlend(s.material)) for (const l of s.material!.layers) add(l.texture);
  }
  return out;
}

function toTexture(src: DecodedTexture): THREE.DataTexture {
  const tex = new THREE.DataTexture(src.rgba, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = src.name ?? src.key;
  tex.flipY = false; // engine UVs address stored rows directly
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Build the Three.js bone hierarchy (bind pose) for a decoded skeleton. */
export function buildSkeleton(skel: Skeleton): { skeleton: THREE.Skeleton; bones: THREE.Bone[]; rootBones: THREE.Bone[] } {
  const bones = skel.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.position);
    bone.quaternion.fromArray(b.quaternion);
    return bone;
  });
  const rootBones: THREE.Bone[] = [];
  skel.bones.forEach((b, i) => (b.parent >= 0 ? bones[b.parent].add(bones[i]) : rootBones.push(bones[i])));
  const inverses = skel.bones.map((b) => new THREE.Matrix4().fromArray(b.inverseBind));
  return { skeleton: new THREE.Skeleton(bones, inverses), bones, rootBones };
}

/** SkinnedMesh with one material group per submesh. Triangles are re-wound to CCW-front. */
export function buildSkinnedMesh(
  skinned: SkinnedModel,
  textures: Map<string, DecodedTexture> = new Map(),
): { mesh: THREE.SkinnedMesh; skeleton: THREE.Skeleton; disposables: { dispose(): void }[] } {
  const m = skinned.model;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinned.skinIndex, MAX_INFLUENCES));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinned.skinWeight, MAX_INFLUENCES));

  const total = m.submeshes.reduce((n, s) => n + s.indices.length, 0);
  const index = new Uint32Array(total);
  const materials: (THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial)[] = [];
  const disposables: { dispose(): void }[] = [geometry];
  const texCache = new Map<string, THREE.DataTexture>();
  // Back faces: the object draw (SUFFERING.EXE 0x493410) culls them for a model whose header flag
  // word has bit 23, characters included (Killjoy 10:90, Hermes 10:92); every other model is
  // drawn two-sided (docs/re/renderer.md §5.1) [verified].
  const side = modelCullsBackFaces(m.headerFlags ?? 0) ? THREE.FrontSide : THREE.DoubleSide;
  let o = 0;
  m.submeshes.forEach((s, i) => {
    for (let t = 0; t + 2 < s.indices.length; t += 3) {
      index[o + t] = s.indices[t];
      index[o + t + 1] = s.indices[t + 2];
      index[o + t + 2] = s.indices[t + 1];
    }
    geometry.addGroup(o, s.indices.length, i);
    o += s.indices.length;

    if (characterSurfaceBlend(s.material)) {
      // Effect passes (additive ghosts and the like): the surface material with its blend
      // state, tint and alpha test; unlit like every effect pass.
      const tex = (key: string) => {
        const d = textures.get(key);
        if (!d) return null;
        let t = texCache.get(d.key);
        if (!t) (t = toTexture(d)), texCache.set(d.key, t), disposables.push(t);
        return t;
      };
      const { material } = createSurfaceMaterial(
        { material: s.material, textureKey: s.textureKey, vertexColors: false, hasUvs: true, side },
        { texture: (key) => tex(key), missing: missingTexture, hasAlpha: (key) => !!textures.get(key)?.hasAlpha },
      );
      materials.push(material);
      disposables.push(material);
      return;
    }
    const src = s.textureKey ? textures.get(s.textureKey) : undefined;
    let map: THREE.DataTexture | null = null;
    if (src) {
      map = texCache.get(src.key) ?? toTexture(src);
      if (!texCache.has(src.key)) {
        texCache.set(src.key, map);
        disposables.push(map);
      }
    }
    const mat = new THREE.MeshStandardNodeMaterial({
      color: map ? 0xffffff : 0x8a7f74,
      map,
      roughness: 0.85,
      metalness: 0,
      side,
      alphaTest: src?.hasAlpha ? 0.5 : 0,
    });
    mat.name = s.textureKey ?? 'untextured';
    // Lit like the engine's dynamic objects: its own light set (ambient region, directional / rim
    // lights, at most 5 point lights ranked at the character, spots) (engine-light.ts).
    engineLightMaterial(mat, { precomputed: false, lightSet: true });
    materials.push(mat);
    disposables.push(mat);
  });
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();

  const { skeleton, rootBones } = buildSkeleton(skinned.skeleton);
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.name = `model ${skinned.ref.pkg}:${skinned.ref.id}`;
  for (const b of rootBones) mesh.add(b);
  mesh.bind(skeleton, new THREE.Matrix4());
  // Animated limbs leave the bind-pose bounds; avoid popping.
  mesh.frustumCulled = false;
  return { mesh, skeleton, disposables };
}

/**
 * Convert a decoded clip into a Three.js AnimationClip bound by bone name ("b_<hash>").
 * Every track the rig has a bone for poses that bone: its rotation keys, and its translation
 * keys (0x80) or constant translation (0xc0, see ClipBuildOptions). Root-motion axes the
 * options extract or lock are zeroed whichever way the root got its translation: the engine
 * clears them on the root's sampled matrix (SUFFERING.EXE 0x478c07..0x478c39).
 */
export function buildAnimationClip(clip: AnimClipData, skel: Skeleton, opts: ClipBuildOptions = {}): THREE.AnimationClip {
  const rootMotion = opts.rootMotion ?? 'inPlace';
  const constant = opts.constantTranslations ?? 'animation';
  const tracks: THREE.KeyframeTrack[] = [];
  for (const t of clip.tracks) {
    const bi = skel.byHash.get(t.boneHash);
    if (bi === undefined) continue;
    const bone = skel.bones[bi];
    const times = Float32Array.from(t.times);
    const axes = typeof rootMotion === 'object' && bone.parent < 0 ? rootMotion : undefined;
    let rotations = t.rotations;
    if ((axes?.rotation === 1 || axes?.rotation === 2) && rotations.length > 4) {
      rotations = new Float32Array(rotations.length);
      for (let k = 0; k < rotations.length; k += 4) rotations.set(t.rotations.subarray(0, 4), k);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, rotations));
    if (t.translations) {
      let values = t.translations;
      if (bone.parent < 0 && rootMotion === 'inPlace') {
        values = Float32Array.from(values);
        for (let k = 0; k < values.length; k += 3) {
          values[k] = values[0];
          values[k + 2] = values[2];
        }
      } else if (axes && (axes.x || axes.y || axes.z)) {
        values = Float32Array.from(values);
        for (let k = 0; k < values.length; k += 3) {
          if (axes.x) values[k] = 0;
          if (axes.y) values[k + 1] = 0;
          if (axes.z) values[k + 2] = 0;
        }
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values));
    } else if (constant === 'animation') {
      const v = [...t.constantTranslation];
      if (axes?.x) v[0] = 0;
      if (axes?.y) v[1] = 0;
      if (axes?.z) v[2] = 0;
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, [0], v));
    }
  }
  const name = opts.name ?? `${guessClipLabel(clip)}#${clip.id}`;
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

export interface PlayOptions {
  /** Default true. */
  loop?: boolean;
  /** Cross-fade duration in seconds (default: the engine's blend into this clip, see play()). */
  fade?: number;
  timeScale?: number;
}

// ---------------------------------------------------------------------------
// Blending (SUFFERING.EXE animator, docs/re/animation.md)
//
// Cross-fades follow the engine's curve: a new clip's weight rises as a quadratic ease-in-out
// of the blend fraction (0x470130: 2x^2 below one half, 1 - 2(1-x)^2 above), the old clip
// takes the rest. Blend time runs on game time.
//
// Layers ("channels"): a clip played on a bone owns that bone's subtree and overrides the
// pose the full-body clip gives it (0x471020 / 0x470f20: each bone maps to a channel node;
// playing on bone B creates B's node, copied from the node it had, so the subtree blends from
// the pose it shows). A later full-body clip takes the layer over again, unless the layer is
// independent (STOMP key flag 0x200 / play flag 0x08), which only a clip on the same bone (or
// an explicit release) ends. Port: the layer plays a copy of the clip restricted to the
// subtree's tracks on the same mixer. three.js averages the actions of a property by weight,
// so a layer at mix m gets weight m / (1 - m) against the whole-body actions (weight 1 in
// total): the subtree shows lerp(pose under it, layer pose, m). A layer inside another one
// is weighted against everything under it (whole body + enclosing layers). One mixer: three.js skips writing a
// property whose value it wrote last frame, so a second mixer on the same bones would leave
// stale poses behind.

/** Engine cross-fade weight of the incoming clip at blend fraction x (0x470130). */
export function engineBlendWeight(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x <= 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

interface WeightFade {
  from: number;
  to: number;
  t: number;
  duration: number;
}

/** Engine-curve weight fades of the actions of one mixer. */
class Fader {
  readonly fades = new Map<THREE.AnimationAction, WeightFade>();
  fade(action: THREE.AnimationAction, to: number, duration: number) {
    const from = action.isRunning() || action.enabled ? action.getEffectiveWeight() : 0;
    if (duration <= 0) {
      this.fades.delete(action);
      if (to <= 0) action.stop();
      else action.setEffectiveWeight(to);
      return;
    }
    this.fades.set(action, { from, to, t: 0, duration });
    action.setEffectiveWeight(from);
  }
  step(dt: number) {
    for (const [a, f] of this.fades) {
      f.t += dt;
      const x = f.t / f.duration;
      a.setEffectiveWeight(f.from + (f.to - f.from) * engineBlendWeight(x));
      if (x >= 1) {
        this.fades.delete(a);
        if (f.to <= 0) a.stop();
      }
    }
  }
}

export interface LayerOptions {
  /** Default true. */
  loop?: boolean;
  /** Playback rate (the clip's own rate is applied on top). Default 1. */
  timeScale?: number;
  /** Start time in the clip (s). Default 0. */
  time?: number;
  /** Blend time (s): the subtree blends from the pose under it (or the layer's previous clip). Default 0.2. */
  blend?: number;
  /** Not taken over by a later full-body clip (releaseLayers keeps it). */
  independent?: boolean;
  /** Hold the last frame of a once-clip (default true); false ends the layer when it finishes. */
  hold?: boolean;
}

/** A clip playing on a bone subtree over the full-body animation (see Blending above). */
export interface AnimationLayer {
  readonly bone: number;
  /** Bone indices of the subtree (the bone first). */
  readonly bones: readonly number[];
  action?: THREE.AnimationAction;
  independent: boolean;
  /** Current mix over the pose underneath (0..1). */
  mix: number;
}

interface LayerState extends AnimationLayer {
  depth: number;
  /** Share of each of the layer's actions (sum 1; cross-fades inside the layer). */
  shares: Map<THREE.AnimationAction, WeightFade & { w: number }>;
  mixFade?: WeightFade;
  hold: boolean;
}

/** Weight ratio of a layer at mix m against the weight under it (see Blending). */
const layerRatio = (m: number) => (m >= 1 ? 1e5 : m <= 0 ? 0 : Math.min(1e5, m / (1 - m)));

/** Called after the animation pose of a frame (procedural bones: aim, look-at, jaw). */
export type PoseHook = (ch: Character, dt: number) => void;

export class Character {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly skeleton: THREE.Skeleton;
  readonly mixer: THREE.AnimationMixer;
  readonly clips: THREE.AnimationClip[];
  /** Decoded clip data, parallel to `clips`. */
  readonly clipData: AnimClipData[];
  current?: THREE.AnimationAction;
  /** Layers by bone index (playLayer). */
  readonly layers = new Map<number, AnimationLayer>();
  /** Procedural bone hooks run after the clips each update (in insertion order). */
  readonly poseHooks: PoseHook[] = [];
  private readonly fader = new Fader();
  /** Animated rotations of bones the pose hooks changed this frame (restored next update). */
  private readonly hooked = new Map<number, THREE.Quaternion>();
  private disposables: { dispose(): void }[];
  /** Filtered (subtree) copies of clips per layer bone. */
  private readonly subClips = new WeakMap<THREE.AnimationClip, Map<number, THREE.AnimationClip>>();

  constructor(
    readonly skinned: SkinnedModel,
    clips: AnimClipData[] = [],
    textures: Map<string, DecodedTexture> = new Map(),
    opts: ClipBuildOptions = {},
    /**
     * Share geometry, materials and clips with another Character of the same model
     * (crowds of one creature type). Only the skeleton is new; the source owns and
     * disposes the shared resources, so dispose clones before their source.
     */
    shareFrom?: Character,
  ) {
    if (shareFrom) {
      const { skeleton, rootBones } = buildSkeleton(skinned.skeleton);
      const mesh = new THREE.SkinnedMesh(shareFrom.mesh.geometry, shareFrom.mesh.material);
      mesh.name = shareFrom.mesh.name;
      for (const b of rootBones) mesh.add(b);
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      this.mesh = mesh;
      this.skeleton = skeleton;
      this.disposables = [];
      this.clipData = shareFrom.clipData;
      this.clips = shareFrom.clips;
    } else {
      const built = buildSkinnedMesh(skinned, textures);
      this.mesh = built.mesh;
      this.skeleton = built.skeleton;
      this.disposables = built.disposables;
      this.clipData = clips;
      this.clips = clips.map((c) => buildAnimationClip(c, skinned.skeleton, { ...opts, name: undefined }));
    }
    this.root.add(this.mesh);
    this.root.name = this.mesh.name;
    this.mixer = new THREE.AnimationMixer(this.mesh);
  }

  /** Find a clip by exact name, by label prefix ("run_forward"), by "#id", or by index. */
  findClip(clip: string | number): number {
    if (typeof clip === 'number') return clip >= 0 && clip < this.clips.length ? clip : -1;
    let i = this.clips.findIndex((c) => c.name === clip);
    if (i < 0) i = this.clips.findIndex((c) => c.name.endsWith(clip.startsWith('#') ? clip : `#${clip}`));
    if (i < 0) i = this.clips.findIndex((c) => c.name.startsWith(clip));
    return i;
  }

  play(clip: string | number, opts: PlayOptions = {}): THREE.AnimationAction | undefined {
    const i = this.findClip(clip);
    if (i < 0) return undefined;
    const action = this.mixer.clipAction(this.clips[i]);
    const loop = opts.loop ?? true;
    const prev = this.current;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = (opts.timeScale ?? 1) * (this.clipData[i].rate || 1);
    // Default: the engine's blend into this clip from the one playing (type-4 entry, else the
    // header blend time; SUFFERING.EXE 0x473b60).
    const prevData = prev ? this.clipData[this.clips.indexOf(prev.getClip())] : undefined;
    const fade = opts.fade ?? blendInto(this.clipData[i], prevData ? { id: prevData.id } : undefined);
    action.play();
    if (prev && prev !== action && fade > 0) this.crossFadeTo(action, fade, [prev]);
    else {
      if (prev && prev !== action) prev.stop();
      this.fader.fades.delete(action);
      action.setEffectiveWeight(1);
    }
    this.current = action;
    return action;
  }

  /**
   * Engine-curve cross-fade on the main mixer: `action` rises to weight 1 over `duration`
   * while `from` (default: the current action) and every action already fading out here
   * fall to 0 and stop. The action must be playing.
   */
  crossFadeTo(action: THREE.AnimationAction, duration: number, from: readonly THREE.AnimationAction[] = this.current ? [this.current] : []) {
    const out = new Set<THREE.AnimationAction>(from);
    for (const [a, f] of this.fader.fades) if (f.to <= 0) out.add(a);
    out.delete(action);
    if (!this.fader.fades.has(action) && !(action.getEffectiveWeight() < 1)) action.setEffectiveWeight(0);
    this.fader.fade(action, 1, duration);
    for (const a of out) if (a.isScheduled()) this.fader.fade(a, 0, duration);
  }

  /** Engine-curve weight fade of one main-mixer action (to 0 stops it at the end). */
  fadeAction(action: THREE.AnimationAction, to: number, duration: number) {
    this.fader.fade(action, to, duration);
  }

  stop() {
    this.mixer.stopAllAction();
    this.fader.fades.clear();
    for (const b of [...this.layers.keys()]) this.removeLayer(b);
    this.current = undefined;
    this.skeleton.pose();
  }

  // ---------------------------------------------------------------------------
  // Layers

  /** `clip` restricted to the tracks of `bone`'s subtree (cached). */
  subtreeClip(clip: THREE.AnimationClip, bone: number): THREE.AnimationClip {
    let m = this.subClips.get(clip);
    if (!m) this.subClips.set(clip, (m = new Map()));
    let c = m.get(bone);
    if (!c) {
      const names = new Set(boneSubtree(this.skinned.skeleton, bone).map((b) => this.skinned.skeleton.bones[b].name));
      c = new THREE.AnimationClip(`${clip.name}@${bone}`, clip.duration, clip.tracks.filter((t) => names.has(t.name.slice(0, t.name.lastIndexOf('.')))));
      m.set(bone, c);
    }
    return c;
  }

  /**
   * Play a clip on `bone`'s subtree over the full-body animation (`clip`: an index into
   * `clips` or a clip of this rig). Replaces the clip of an existing layer on that bone
   * (engine-curve cross-fade inside the layer); a new layer blends in from the pose under it.
   */
  playLayer(bone: number, clip: number | THREE.AnimationClip, o: LayerOptions = {}): THREE.AnimationAction | undefined {
    const skel = this.skinned.skeleton;
    if (!skel.bones[bone]) return undefined;
    const i = typeof clip === 'number' ? clip : this.clips.indexOf(clip);
    const src = typeof clip === 'number' ? this.clips[clip] : clip;
    if (!src) return undefined;
    const rate = i >= 0 ? this.clipData[i]?.rate || 1 : 1;
    const blend = Math.max(0, o.blend ?? 0.2);
    let layer = this.layers.get(bone) as LayerState | undefined;
    const fresh = !layer;
    if (!layer) {
      let depth = 0;
      for (let b = skel.bones[bone].parent; b >= 0; b = skel.bones[b].parent) depth++;
      layer = { bone, bones: boneSubtree(skel, bone), depth, independent: false, mix: 0, shares: new Map(), hold: true };
      this.layers.set(bone, layer);
    }
    const action = this.mixer.clipAction(this.subtreeClip(src, bone));
    const loop = o.loop ?? true;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = (o.timeScale ?? 1) * rate;
    const d = Math.max(action.getClip().duration, 1e-3);
    const t = o.time ?? 0;
    action.time = loop ? ((t % d) + d) % d : Math.min(Math.max(0, t), d);
    action.play();
    const prev = layer.action;
    if (prev && prev !== action && !fresh && blend > 0 && layer.mix > 0) {
      for (const [a, f] of layer.shares) layer.shares.set(a, { from: f.w, to: 0, t: 0, duration: blend, w: f.w });
      layer.shares.set(action, { from: 0, to: 1, t: 0, duration: blend, w: 0 });
    } else {
      for (const a of layer.shares.keys()) if (a !== action) a.stop();
      layer.shares.clear();
      layer.shares.set(action, { from: 1, to: 1, t: 0, duration: 0, w: 1 });
    }
    layer.action = action;
    layer.independent = !!o.independent;
    layer.hold = o.hold ?? true;
    if (fresh || layer.mixFade?.to === 0) this.mixLayer(layer, 1, blend);
    this.applyLayerWeights();
    return action;
  }

  /** End the layer on `bone`: its subtree blends back to the pose under it. */
  stopLayer(bone: number, blend = 0.2) {
    const layer = this.layers.get(bone) as LayerState | undefined;
    if (!layer) return;
    if (blend <= 0 || layer.mix <= 0) this.removeLayer(bone);
    else this.mixLayer(layer, 0, blend);
  }

  /**
   * What a full-body clip does to the layers (engine 0x470f20): every layer that is not
   * independent ends, blending into the new clip over `blend`. `all` ends independent ones too.
   */
  releaseLayers(blend = 0.2, all = false) {
    for (const [b, l] of [...this.layers]) if (all || !l.independent) this.stopLayer(b, blend);
  }

  /** True for the actions layers play (whole-body cross-fades leave them alone). */
  isLayerAction(a: THREE.AnimationAction): boolean {
    for (const l of this.layers.values()) if ((l as LayerState).shares.has(a)) return true;
    return false;
  }

  private mixLayer(layer: LayerState, to: number, duration: number) {
    if (duration <= 0) {
      layer.mix = to;
      layer.mixFade = undefined;
      if (to <= 0) this.removeLayer(layer.bone);
      return;
    }
    layer.mixFade = { from: layer.mix, to, t: 0, duration };
  }

  private removeLayer(bone: number) {
    const layer = this.layers.get(bone) as LayerState | undefined;
    if (!layer) return;
    for (const a of layer.shares.keys()) a.stop();
    this.layers.delete(bone);
  }

  /** Action weights of all layers, outer layers first (see Blending). */
  private applyLayerWeights() {
    const sorted = ([...this.layers.values()] as LayerState[]).sort((a, b) => a.depth - b.depth);
    const total = new Map<LayerState, number>();
    for (const l of sorted) {
      let under = 1;
      for (const o of sorted) if (o !== l && o.depth < l.depth && o.bones.includes(l.bone)) under += total.get(o) ?? 0;
      const w = layerRatio(l.mix) * under;
      total.set(l, w);
      for (const [a, f] of l.shares) a.setEffectiveWeight(f.w * w);
    }
  }

  private updateLayers(dt: number) {
    for (const l of [...this.layers.values()] as LayerState[]) {
      if (l.mixFade) {
        const f = l.mixFade;
        f.t += dt;
        const x = f.t / f.duration;
        l.mix = f.from + (f.to - f.from) * engineBlendWeight(x);
        if (x >= 1) {
          l.mix = f.to;
          l.mixFade = undefined;
          if (f.to <= 0) {
            this.removeLayer(l.bone);
            continue;
          }
        }
      }
      for (const [a, f] of l.shares) {
        if (f.duration > 0 && f.t < f.duration) {
          f.t += dt;
          f.w = f.from + (f.to - f.from) * engineBlendWeight(f.t / f.duration);
        }
        if (f.to <= 0 && f.t >= f.duration) {
          a.stop();
          l.shares.delete(a);
        }
      }
      // A once-clip that should not hold ends with the layer.
      const a = l.action;
      if (a && !l.hold && a.loop === THREE.LoopOnce && !l.mixFade && a.time >= a.getClip().duration - 1e-4) this.mixLayer(l, 0, 0.2);
    }
  }

  update(dt: number) {
    for (const [i, q] of this.hooked) this.skeleton.bones[i].quaternion.copy(q);
    this.hooked.clear();
    this.fader.step(dt);
    this.updateLayers(dt);
    if (this.layers.size) this.applyLayerWeights();
    this.mixer.update(dt);
    for (const h of this.poseHooks) h(this, dt);
  }

  /**
   * Rotate bone `i` by `r`, given in model (mesh) space, about the bone's own pivot, on top of
   * its animated pose: the engine's per-bone model-space hook (bone node +0xc, applied after
   * the bone's model matrix is built, so children follow; SUFFERING.EXE 0x46f930). Call from
   * a pose hook, parents before children.
   */
  rotateBoneModel(i: number, r: THREE.Quaternion) {
    const bone = this.skeleton.bones[i];
    if (!bone) return;
    // The animated rotation, restored before the next mixer update: three.js only writes a
    // property whose animated value changed, so the hook would otherwise compound.
    if (!this.hooked.has(i)) this.hooked.set(i, bone.quaternion.clone());
    const pw = _pw.identity();
    for (let o = bone.parent; o && o !== this.mesh; o = o.parent) pw.premultiply(o.quaternion);
    // q' = parent^-1 * r * parent * q
    _pr.copy(pw).invert().multiply(r).multiply(pw);
    bone.quaternion.premultiply(_pr);
  }

  /** Place like a level object instance (engine position / rotation; output space = engine / 2048). */
  placeAt(obj: Pick<LevelObject, 'position' | 'rotation'>) {
    const r = instanceRotation(obj.rotation);
    const [x, y, z] = toOutputSpace(obj.position);
    this.root.matrix.set(r[0], r[1], r[2], x, r[3], r[4], r[5], y, r[6], r[7], r[8], z, 0, 0, 0, 1);
    this.root.matrix.decompose(this.root.position, this.root.quaternion, this.root.scale);
  }

  dispose() {
    for (const b of [...this.layers.keys()]) this.removeLayer(b);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mesh);
    for (const d of this.disposables) d.dispose();
    this.root.removeFromParent();
  }
}


/** All actions a mixer has created (three.js keeps them in a protected list). */
export function mixerActionsOf(mixer: THREE.AnimationMixer): readonly THREE.AnimationAction[] {
  return (mixer as unknown as { _actions?: THREE.AnimationAction[] })._actions?.slice() ?? [];
}

/**
 * The bone a clip should be layered on to play over locomotion: the deepest common ancestor
 * of the bones it really animates (rotation change > ~1 degree), or undefined when that is the
 * root or the pelvis (the clip moves the whole body, legs included). The same rule the actors
 * use for shooting while walking (guard firing clip 10:35 animates spine and arms only).
 */
export function layerBoneForClip(data: AnimClipData, skel: Skeleton, minDepth = 2): number | undefined {
  const moving: number[] = [];
  for (const t of data.tracks) {
    const bi = skel.byHash.get(t.boneHash);
    if (bi === undefined) continue;
    const r = t.rotations;
    let d = 0;
    for (let k = 4; k < r.length && d <= 0.02; k += 4) d = Math.max(d, Math.abs(r[k] - r[0]) + Math.abs(r[k + 1] - r[1]) + Math.abs(r[k + 2] - r[2]) + Math.abs(r[k + 3] - r[3]));
    if (d > 0.02) moving.push(bi);
  }
  if (!moving.length) return undefined;
  const chain = (i: number) => {
    const out: number[] = [];
    for (let b = i; b >= 0; b = skel.bones[b].parent) out.unshift(b);
    return out;
  };
  let lca = chain(moving[0]);
  for (const m of moving.slice(1)) {
    const c = chain(m);
    let k = 0;
    while (k < lca.length && k < c.length && lca[k] === c[k]) k++;
    lca = lca.slice(0, k);
  }
  return lca.length > minDepth ? lca[lca.length - 1] : undefined;
}

const _pw = new THREE.Quaternion();
const _pr = new THREE.Quaternion();

/**
 * Look-at on one bone (an NPC's "facing channel": ProjectileAttackBehavior p21..p25,
 * Suffering.rfl 0x100b3d70 / 0x100b41f0; docs/re/animation.md §9): the direction from the bone
 * to the target, in the character's model space, is kept inside a cone of `cone` degrees around
 * forward (-Z) and within +-`pitch` degrees of elevation, the bone's look direction turns toward
 * it at `speed` degrees per second along the great circle, and the resulting rotation (yaw, then
 * pitch, up = +Y) is applied in model space on top of the pose, eased in / out over `ease`
 * seconds with a sine curve. Add `apply` to the character's poseHooks; set `target` (world
 * point) to track, null to let go.
 */
export class LookAtBone {
  target: THREE.Vector3 | null = null;
  /** True once the look direction is within ~14 degrees of the target direction (dot >= 0.97). */
  aligned = false;
  private dir = new THREE.Vector3(0, 0, -1);
  private ease = 0;

  constructor(
    readonly bone: number,
    readonly cone: number,
    readonly pitch: number,
    readonly speed: number,
    readonly easeTime: number,
  ) {}

  apply = (ch: Character, dt: number) => {
    const D = Math.PI / 180;
    const on = !!this.target;
    this.ease = THREE.MathUtils.clamp(this.ease + (on ? 1 : -1) * (this.easeTime > 0 ? dt / this.easeTime : 1), 0, 1);
    if (!this.ease) {
      this.dir.set(0, 0, -1);
      this.aligned = false;
      return;
    }
    const bone = ch.skinned.skeleton.bones[this.bone];
    if (!bone) return;
    if (this.target) {
      // Bone position from its bind pose: good enough for a direction.
      ch.root.updateWorldMatrix(true, false);
      const from = _la.set(bone.bindWorld[12], bone.bindWorld[13], bone.bindWorld[14]).applyMatrix4(ch.root.matrixWorld);
      ch.root.getWorldQuaternion(_lq).invert();
      const want = _lb.copy(this.target).sub(from).applyQuaternion(_lq);
      if (want.lengthSq() > 1e-8) {
        want.normalize();
        const cc = Math.cos(Math.min(180, this.cone) * D);
        if (this.cone < 180 && -want.z < cc) {
          // Outside the cone: onto its rim, keeping the sideways / vertical proportion.
          const h = Math.hypot(want.x, want.y) || 1, sn = Math.sqrt(1 - cc * cc);
          want.set((want.x / h) * sn, (want.y / h) * sn, -cc);
        }
        const ps = Math.sin(Math.min(90, Math.max(0, this.pitch)) * D);
        if (Math.abs(want.y) > ps) {
          const h = Math.hypot(want.x, want.z) || 1, c = Math.sqrt(1 - ps * ps);
          want.set((want.x / h) * c, Math.sign(want.y) * ps, (want.z / h) * c);
        }
        const ang = this.dir.angleTo(want), max = this.speed * D * dt;
        if (ang <= max || ang < 1e-6) this.dir.copy(want);
        else {
          const axis = _la.crossVectors(this.dir, want);
          if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
          this.dir.applyAxisAngle(axis.normalize(), max).normalize();
        }
        this.aligned = this.dir.dot(want) >= 0.97;
      }
    }
    const yaw = Math.atan2(-this.dir.x, -this.dir.z), pitch = Math.asin(THREE.MathUtils.clamp(this.dir.y, -1, 1));
    const r = _lr.setFromAxisAngle(_ly, yaw).multiply(_lp.setFromAxisAngle(_lx, pitch));
    const w = (1 - Math.cos(Math.PI * this.ease)) / 2;
    ch.rotateBoneModel(this.bone, _lq.identity().slerp(r, w));
  };
}

/**
 * Aim bones (the NPC Aim sub-behaviour: ProjectileAttackBehavior p7..p13, Suffering.rfl
 * 0x100eb780 / 0x100e94f0; docs/re/animation.md §9): the elevation of the target seen from the
 * `origin` bone, clamped to [min, max] degrees, slewed at `rate` degrees per second, pitches each
 * of `bones` up by elevation / `split` in model space (guards: both shoulder helpers 9 / 29,
 * origin 28 = the right clavicle, +-45 degrees, 180 deg/s). Without a target it returns to 0.
 */
export class AimBones {
  target: THREE.Vector3 | null = null;
  private angle = 0;

  constructor(
    readonly bones: readonly number[],
    readonly origin: number,
    readonly min: number,
    readonly max: number,
    readonly split = 1,
    readonly rate = 180,
  ) {}

  apply = (ch: Character, dt: number) => {
    const D = Math.PI / 180;
    let want = 0;
    const o = ch.skinned.skeleton.bones[this.origin];
    if (this.target && o) {
      ch.root.updateWorldMatrix(true, false);
      const from = _la.set(o.bindWorld[12], o.bindWorld[13], o.bindWorld[14]).applyMatrix4(ch.root.matrixWorld);
      const d = _lb.copy(this.target).sub(from);
      const len = d.length();
      if (len > 1e-6) want = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y / len, -1, 1)), this.min * D, this.max * D);
    }
    const step = this.rate * D * dt;
    this.angle = Math.abs(want - this.angle) <= step ? want : this.angle + Math.sign(want - this.angle) * step;
    if (Math.abs(this.angle) < 1e-5) return;
    const r = _lr.setFromAxisAngle(_lx, this.angle / Math.max(1, this.split));
    for (const b of this.bones) ch.rotateBoneModel(b, r);
  };
}

const _la = new THREE.Vector3();
const _lb = new THREE.Vector3();
const _lq = new THREE.Quaternion();
const _lr = new THREE.Quaternion();
const _lp = new THREE.Quaternion();
const _lx = new THREE.Vector3(1, 0, 0);
const _ly = new THREE.Vector3(0, 1, 0);
