// World effects: Particle Fountain, Object Generator (FX spawner), BouncingObject debris,
// Volumetric Fog, Billboard glows. Driven by the world system (world.ts) and the prop runtime
// (props.ts, which spawns break effects through `spawn`).
//
// Property meanings are documented in docs/game-logic.md §14 (verified vs guessed). In short:
//
// Particle Fountain [rate, axes and the p1 velocity scale verified from the emitter code; the
//   rest inferred from the retail values]:
//   p0 = 1 emit from inside the fountain's own model box (verified, fountainEmitPoint), p1 speed
//   along the primary axis (m/s, scaled by a random 0.5..1), p3 radial disc radius, p5 radial
//   speed, p8 disc angle range (deg), p10 emission duration (s, 0 = endless), p14 on at start
//   (verified, fountainStartsOn), p17 Destroy lets the particles finish (verified), p22/p23/p24 emitter axes
//   (0 x, 1 y, 2 z of the object: primary, disc u, disc v), p26 particles per second,
//   p29/p30 level-of-detail distances (m; scaled by 2048 like positions in the setup code:
//   full rate within p29, fading out to nothing at p30), p33/p34 start/end colour, p36 texture list,
//   p37..p38 particle size (engine units), p39 size change per second, p40 lifetime (s), p41
//   fade-out, p42 fade-in, p43 gravity factor x the level's gravity (levelGravity), p48 random
//   lifetime and velocity-aligned quads (fountainStreak / streakFrame) (all verified, see
//   fountainParticleLife), p46 / p47 blend (fountainBlend: 1 or p47 additive, 2 subtractive,
//   else alpha; p46 = 3 also takes p33 times the light at the emitter, litParticleColor),
//   p49 spin (deg/s); inputs p50 On, p51 Off, p52 Destroy.
// Object Generator [verified, `Generator`]: p0 templates, p1 / p2 counts, p6 which entries a
//   firing takes (generatorPicks), p7 ± p8 s between firings, p21 run time (0 = endless), p22
//   runs before it is destroyed (0 = any), p24 on from creation, p28 player range (m) with p29 /
//   p30 height window, p5 destroys its spawns with it, p36 sounds (one random per firing);
//   inputs p31 Destroy, p32 Start, p33 Stop, p34 Toggle, p35 Prefetch; p9..p20 shape what each
//   spawn gets (generatorSpawn: a velocity only Items take, the spawn matrix's p20 turn and p18
//   facing) [verified].
// BouncingObject (debris, gibs, the 1a cap) [verified]: created at the generator's spawn matrix,
//   it flies its own launch (bouncingLaunch: -local Z at p2 with a generator's record, else p1;
//   p46 / p47 gravity; p12 life; p3..p6 spin), sweeps its origin's segment against front faces
//   (frontSegmentCast), bounces by bounceVelocity / bounceKeep (p51 and the surface's p4), settles
//   by p49 / p50 and goes p54 s later, spawning its p34 generators.
// Particles have no ground test (Emitter.update) [verified].

import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, instancedDynamicBufferAttribute, modelViewMatrix, positionGeometry, rotate, texture as tslTexture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { additiveEffectColor, engineLights, engineStages, gammaDecode, gammaEncode, LEGACY_LIGHTING } from '../../app/engine-light';
import type { Entity, EntityPackageSet, PropValue } from '../../formats/entities';
import { readObjectTemplate, className as classNameOf, classByHash, decodeTemplateProps, entityBoxCorners } from '../../formats/entities';
import { instanceRotation, WORLD_SCALE } from '../../formats/level';
import { worldStageColor } from '../../formats/render-data';
import { findEntry, readModel, type PackageSet, type ResRef } from '../../formats/model';
import { COLLISION_LAYER, type CollisionWorld, type RayHit } from '../../app/physics';
import { bounceHit } from '../weapons/data';
import type { DynamicObjects, DynamicObject } from './dynamic';
import type { World } from './logic';
import { instanceMatrix } from './dynamic';
import { SFX_MODE } from './sound-effect';
import { gore } from '../fx/gore-bus';

type Vec3 = [number, number, number];

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);
const refList = (v: unknown): (ResRef | null)[] => (Array.isArray(v) ? (v as unknown[]).map((x) => ref(x)) : []);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** 0xAARRGGBB / 0xRRGGBB colour word -> linear-ish [0..1] rgb. */
export function colorOf(v: unknown, out = new THREE.Color()): THREE.Color {
  const c = num(v) >>> 0;
  return out.setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, THREE.SRGBColorSpace);
}

export interface TemplateInfo {
  ref: ResRef;
  cls: string;
  values: PropValue[];
  model?: ResRef;
}

export function readTemplate(pkgs: EntityPackageSet, r: ResRef): TemplateInfo | undefined {
  const t = readObjectTemplate(pkgs, r);
  if (!t) return undefined;
  const c = classByHash(t.classHash);
  return { ref: r, cls: classNameOf(t.classHash), values: decodeTemplateProps(c, t), model: t.modelRef };
}

export interface FxEnv {
  packages: EntityPackageSet;
  dyn: DynamicObjects;
  collision: CollisionWorld | null;
  /** Play one of the sound keys ("pkg:id") at a position. */
  playSound(keys: string[], pos: Vec3, opts?: { radius?: number; loop?: boolean }): { stop(): void } | undefined;
  /** World time scale (services.time.scale). */
  timeScale(): number;
  /** Templates other modules handle (Breakable remains, Radius Damage, ...). Return true if handled. */
  spawnOther?(t: TemplateInfo, M: THREE.Matrix4, ctx: SpawnContext): boolean;
  /** The player's position (Object Generator p28 range); undefined: no player (no range test). */
  playerPos?(): Vec3 | undefined;
}

export interface SpawnContext {
  /** Direction away from the attacker (debris fly along it); also the surface normal for impacts. */
  dir?: THREE.Vector3;
  /** Generator template that spawned this (debris cone / speed). */
  gen?: PropValue[];
  /** Object the effect follows (muzzle flashes on a weapon bone); the matrix M is then local to it. */
  parent?: THREE.Object3D;
  /**
   * An attachment set owns what is spawned (fx/attachments.ts): Particle Fountains are added
   * here, emit for their own p10 time (0 = until the owner stops them) and, when the spawning
   * generator has a Follower Object (p25), keep following M (updated in place by the owner).
   */
  owner?: Emitter[];
}

/**
 * Extra spawners (src/game/fx: Camera Shake, Muzzle Flash, Fire, Decal, Blood, Water Ripple,
 * Electric Arc, Particle Smoke, spawned Point Lights). Return true when the template was handled.
 */
export type FxSpawner = (t: TemplateInfo, M: THREE.Matrix4, ctx: SpawnContext) => boolean;

// ---------------------------------------------------------------------------
// Particle pools: one instanced sprite per (texture, blend), shared by every emitter.

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  age: number;
  life: number;
  /** Size at birth (m) and its change per second (m/s, p39; never below 0). */
  size0: number;
  grow: number;
  /** Fade-in / fade-out times (s; fountainParticleAlpha). */
  fadeIn: number;
  fadeOut: number;
  rot: number;
  spin: number;
}

const POOL_CAP = 2048;

/**
 * Sprite material for velocity-aligned particles (p48 = 1, fountainStreak): the quad is scaled
 * by `scaleNode` (vec2), turned by `rotationNode` and then squashed along screen y by
 * `squashNode` (f), all in view space, which is the engine's screen space up to the perspective
 * divide. The engine's streak frame is mirrored against its upright one; the pool mirrors the
 * texture's u instead of the quad (the same picture), because a quad mirrored in x turns its
 * winding round and the front-face cull dropped every streak: from b42f105 on no p48 = 1
 * particle was drawn (1a's shower spray, metal-impact sparks, gun blood, glass).
 */
class StreakSpriteNodeMaterial extends THREE.SpriteNodeMaterial {
  squashNode: THREE.Node | null = null;

  override setupPositionView(): ReturnType<typeof vec4> {
    const mv = modelViewMatrix.mul(vec3(this.positionNode as ReturnType<typeof vec3>));
    const xy = positionGeometry.xy.mul(vec2(this.scaleNode as ReturnType<typeof vec2>));
    const turned = rotate(xy, float(this.rotationNode as ReturnType<typeof float>));
    const squashed = turned.mul(vec2(float(1), this.squashNode ? float(this.squashNode as ReturnType<typeof float>) : float(1)));
    return vec4(mv.xy.add(squashed), mv.zw);
  }
}

class ParticlePool {
  readonly sprite: THREE.Sprite;
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly colAttr: THREE.InstancedBufferAttribute;
  private readonly miscAttr: THREE.InstancedBufferAttribute;
  n = 0;

  /** `streak`: velocity-aligned quads (p48 = 1); misc then holds width, angle and squash. */
  constructor(map: THREE.Texture, blend: number, readonly streak = false) {
    this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 3), 3);
    this.colAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 4), 4);
    this.miscAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 3), 3);
    for (const a of [this.posAttr, this.colAttr, this.miscAttr]) a.setUsage(THREE.DynamicDrawUsage);
    const additive = blend === 0;
    const params = { transparent: blend !== 3, depthWrite: blend === 3, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending };
    const mat = streak ? new StreakSpriteNodeMaterial(params) : new THREE.SpriteNodeMaterial(params);
    if (blend === 2) {
      // Engine blend mode 4: reverse subtract (destination - source).
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.ReverseSubtractEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneFactor;
    }
    const col = instancedDynamicBufferAttribute(this.colAttr, 'vec4') as unknown as ReturnType<typeof vec4>;
    const misc = instancedDynamicBufferAttribute(this.miscAttr, 'vec3') as unknown as ReturnType<typeof vec3>;
    // Streaks: the mirror is in the texture (u -> 1 - u), the quad keeps its winding.
    const tex = streak ? tslTexture(map, vec2(float(1).sub(uv().x), uv().y)) : tslTexture(map);
    mat.positionNode = instancedDynamicBufferAttribute(this.posAttr, 'vec3');
    if (mat instanceof StreakSpriteNodeMaterial) {
      mat.scaleNode = vec2(misc.x, misc.x);
      mat.squashNode = misc.z;
    } else mat.scaleNode = misc.x;
    mat.rotationNode = misc.y;
    // The billboard's vertex colour is the particle's colour word as it is (p33, or p33 x the
    // light for p46 = 3; SUFFERING.EXE 0x4ad888 copies particle +0x30 to the four vertices, and
    // the update 0x4ac4e0..0x4ac5f3 only rewrites its alpha byte), and the quad is drawn at once
    // inside the world loop, where texture stage 1 adds the stage-0 colour to itself: the pass
    // writes saturate(2 x texture x colour), as every other world pass (docs/game-logic.md §14.2
    // "Particles: doubled"; engine-light.ts engineStages). The port drew them at half that: 1a's
    // shower spray (3:1793, 0x484a4d) added at most ~9 / 255 and did not show.
    const rgb = LEGACY_LIGHTING ? tex.rgb.mul(col.rgb) : gammaDecode(engineStages(gammaEncode(tex.rgb.mul(col.rgb))));
    // Additive particles: gamma-space add that fades to black with the fog, like the engine's
    // blend-mode-2 passes (fog colour forced to black, 0x49a990; engine-light.ts). The engine
    // adds source x source alpha, and the alpha is the texture's times the particle's: the spark
    // and glow textures (4:1830, 4:1808, ...) are white with the shape in their alpha, so without
    // it every spark drew as its whole quad, a large orange ball.
    if (additive && !LEGACY_LIGHTING) {
      mat.colorNode = vec4(additiveEffectColor(rgb, tex.a.mul(col.a)), float(1));
      mat.fog = false;
    } else mat.colorNode = additive ? vec4(rgb.mul(tex.a.mul(col.a)), float(1)) : vec4(rgb, tex.a.mul(col.a));
    if (blend === 3) mat.alphaTest = 0.4;
    // The engine alpha-tests every blended pass at > 2/255 (render-data BLEND_ALPHA_REF).
    else if (blend !== 0) mat.alphaTest = 2 / 255;
    this.sprite = new THREE.Sprite(mat);
    this.sprite.frustumCulled = false;
    this.sprite.count = 0;
    this.sprite.renderOrder = additive ? 3 : 2;
    this.sprite.name = streak ? 'fx-streaks' : 'fx-particles';
  }

  begin() {
    this.n = 0;
  }

  /** One sprite: centre, width (m), angle (rad), colour, opacity; `squash` streaks only. */
  push(x: number, y: number, z: number, size: number, rot: number, r: number, g: number, b: number, a: number, squash = 1) {
    if (this.n >= POOL_CAP) return;
    const i = this.n++;
    this.posAttr.array[3 * i] = x;
    this.posAttr.array[3 * i + 1] = y;
    this.posAttr.array[3 * i + 2] = z;
    const c = this.colAttr.array;
    c[4 * i] = r;
    c[4 * i + 1] = g;
    c[4 * i + 2] = b;
    c[4 * i + 3] = a;
    this.miscAttr.array[3 * i] = size;
    this.miscAttr.array[3 * i + 1] = rot;
    this.miscAttr.array[3 * i + 2] = squash;
  }

  end() {
    this.sprite.count = this.n;
    this.sprite.visible = this.n > 0;
    if (this.n) for (const a of [this.posAttr, this.colAttr, this.miscAttr]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose() {
    (this.sprite.material as THREE.Material).dispose();
    this.sprite.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Particle Fountain rules decoded from Suffering.rfl (docs/game-logic.md §14.2)

/**
 * A placed fountain emits from level start only when p14 is set: its init (vtable +0x0c,
 * 0x1011a870) calls the On handler (0x10119ad0) when p14 != 0, nothing else does [verified].
 * The rest wait for an On message (relay, STOMP key): 1a's mouth blood, glass bursts, eye smoke.
 */
export function fountainStartsOn(v: PropValue[]): boolean {
  return num(v[14]) !== 0;
}

/**
 * Destroy input (p52, BlowUp in the retail data; handler 0x10119b80) [verified]: with p17 set
 * the fountain stops emitting and lives on until its particles died; with p17 = 0 the object is
 * deleted at once.
 */
export function fountainDestroyKeepsParticles(v: PropValue[]): boolean {
  return num(v[17]) !== 0;
}

/**
 * Start point of a particle of a p0 = 1 fountain [verified: emitter think 0x1011b57d]: a random
 * point inside the box of the fountain's own model (corner + r1·u + r2·v + r3·w, r in 0..1)
 * carried by the object's current matrix, so an attached fountain emits from where its model
 * box sits on the bone. The engine takes the box from the model's collision data; the port uses
 * the geometry's bounds [inferred: the same box for these one-box emitter proxies].
 */
export function fountainEmitPoint(box: THREE.Box3, M: THREE.Matrix4, r1: number, r2: number, r3: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = box.min, b = box.max;
  return out.set(a.x + (b.x - a.x) * r1, a.y + (b.y - a.y) * r2, a.z + (b.z - a.z) * r3).applyMatrix4(M);
}

/**
 * World gravity in output metres per s² from the level's Level Properties [verified: the setup
 * Suffering.rfl 0x100b23c8 hands p18 (units per metre) and p19 (gravity in m/s²) to the engine
 * clock object (SUFFERING.EXE 0x5c6dc8, vtable 0x58ca50: +0x50 stores the units, +0x4c sets the
 * gravity to p19 x units at +0x90). That float (0x5c6e58, read as [0x1017bf40]+0x90 by the RFL) is
 * the gravity of particles (p43, update 0x4ac39a) and of BouncingObjects / Missiles (p46, launch
 * 0x100cfbcb)]. Positions are 2048 units per output metre, so the template's 9.8 x 2175 units/s²
 * is 10.41 m/s² here, not 9.81.
 */
export function levelGravity(v?: PropValue[]): number {
  return (num(v?.[19], 9.8) * num(v?.[18], 2175)) / WORLD_SCALE;
}

/** Gravity with the Level Properties template's values (every chapter 1 level keeps them). */
export const FOUNTAIN_GRAVITY = levelGravity();

/**
 * p48 = 1: velocity-aligned particles [verified: the system setup 0x1011a4b0 sets flag 0x80000,
 * which the billboard build (SUFFERING.EXE 0x4ad430) draws through 0x4ad9b8; the emitter (0x1011b0d3)
 * also gives these a random lifetime 0..p40, fountainParticleLife]. See streakFrame.
 */
export function fountainStreak(v: PropValue[]): boolean {
  return num(v[48]) === 1;
}

/**
 * Screen frame of a p48 = 1 particle [verified: SUFFERING.EXE 0x4ad9b8..0x4adb1b and the shared
 * corner build 0x4adbbb]. In view space n = -velocity / |velocity| ((1, 0, 0) when it stands
 * still); u is the screen direction from the projected centre to the projected p + n x size
 * (towards where the particle came from); f = max(0, 0.99 - |n.z|). With hx, hy the projected
 * half size, the corners are centre +- A +- B in pixels (y down):
 *   A = hy (u.x, f u.y)   (texture v = 1 on the +A side, the tail)
 *   B = hx (u.y, -f u.x)  (texture u = 1 on the +B side)
 * So the quad is the ordinary sprite size, not stretched with speed: a streak texture (4:1808
 * sparks, 4:1934 blood) is turned along the motion. Only the y components carry f, which flattens
 * a particle flying at the camera. In view space with y up (w = (u.x, -u.y)) this is a sprite
 * mirrored in x, turned by `angle` = atan2(-w.x, w.y) and scaled by (1, `squash` = f) after the
 * turn (StreakSpriteNodeMaterial; the pool mirrors the texture's u, which draws the same picture
 * without turning the quad's winding round). `view` is the camera's world-to-view matrix.
 */
export function streakFrame(view: THREE.Matrix4, p: THREE.Vector3, vel: THREE.Vector3, size: number, out = { angle: 0, squash: 1 }): { angle: number; squash: number } {
  const e = view.elements;
  const len = vel.length();
  // n in view space (rotation part of the view matrix).
  let nx = 1, ny = 0, nz = 0;
  if (len > 1e-9) {
    const x = -vel.x / len, y = -vel.y / len, z = -vel.z / len;
    nx = e[0] * x + e[4] * y + e[8] * z;
    ny = e[1] * x + e[5] * y + e[9] * z;
    nz = e[2] * x + e[6] * y + e[10] * z;
  }
  const cx = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
  const cy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
  const cz = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
  const tx = cx + nx * size, ty = cy + ny * size, tz = cz + nz * size;
  // Projected (y up): x / -z, y / -z.
  const wx = tx / -tz - cx / -cz, wy = ty / -tz - cy / -cz;
  if (wx * wx + wy * wy > 1e-20) out.angle = Math.atan2(-wx, wy);
  out.squash = Math.max(0, 0.99 - Math.abs(nz));
  return out;
}

/**
 * Colour of a lit particle (p46 = 3) [verified: Suffering.rfl 0x10119e30, and the particle update
 * SUFFERING.EXE 0x4ac4e0 copies the system colour into every live particle each frame for setup
 * flag 0x800000]: each channel of p33 (bytes) times the clamped light at the emitter
 * (engine-light.ts particleLight), in the engine's gamma space; p34 is not used. Returned as
 * linear RGB for the sprite colour.
 */
export function litParticleColor(p33: unknown, light: THREE.Color, out = new THREE.Color()): THREE.Color {
  const c = num(p33) >>> 0;
  const k = (x: number) => Math.min(1, Math.max(0, x));
  return out.setRGB(((c >> 16) & 255) / 255 * k(light.r), ((c >> 8) & 255) / 255 * k(light.g), (c & 255) / 255 * k(light.b), THREE.SRGBColorSpace);
}

/**
 * Particle sizes, lifetime, fade and gravity [verified: Suffering.rfl emitter 0x1011ab10 and
 * system setup 0x10119fc0, SUFFERING.EXE particle update 0x4ac1e0]:
 *   p37..p38  size at birth, engine units (2048 / m), random per particle (x the object scale)
 *   p39       size change per second (engine units/s; the size stays >= 0): smoke grows,
 *             debris and the mouth blood shrink
 *   p40       lifetime (s); p48 = 1: random 0..p40
 *   p41       fade-out over the last p41 s (a lifetime shorter than p41 fades from the start)
 *   p42       fade-in over the first p42 s (0 = none)
 *   p43       gravity factor: v = v0 - up · g · p43 · age (1 = full gravity, < 0 rises)
 * The port used to read p37..p38 as lifetime (ms), p40 -> p41 as size (m), p39 as gravity
 * (cm/s², sign flipped), p42 as drag and p43 as floor bounce: the 1a mouth blood drew as
 * 1 m splats living 75 ms instead of 2-5 cm drops falling from the mouth for a second.
 * The size is the sprite's half width [verified: billboard build SUFFERING.EXE 0x4ad430, corners
 * at the projected centre ± size x focal / depth].
 */
export function fountainParticleLife(v: PropValue[], rand = Math.random()): { life: number; fadeIn: number; fadeOut: number } {
  const p40 = Math.max(0, num(v[40], 1));
  const fadeOut = Math.max(0, num(v[41]));
  const fadeIn = Math.max(0, num(v[42]));
  const life = num(v[48]) === 1 ? p40 * rand : p40;
  return { life: Math.max(life, fadeOut, 0.02), fadeIn, fadeOut };
}

/** Opacity of a particle at `age` (0..1): fade-in over fadeIn, fade-out over the last fadeOut. */
export function fountainParticleAlpha(age: number, life: number, fadeIn: number, fadeOut: number): number {
  const a = fadeIn > 0 ? Math.min(1, age / fadeIn) : 1;
  const b = fadeOut > 0 ? Math.min(1, Math.max(0, life - age) / fadeOut) : 1;
  return a * b;
}

/**
 * Colour channel (gamma, 0..1) a particle's billboard pass writes for texture value `tex` and
 * particle colour `colour` (p33, or p33 x the light for p46 = 3) [strong: the vertex colour is the
 * particle's colour word unchanged (SUFFERING.EXE billboard build 0x4ad888 copies particle +0x30
 * to the four vertices; the update 0x4ac4e0..0x4ac5f3 only rewrites its alpha byte), the quad is
 * drawn at once (0x496c60 sets the texture, 0x4969f0 draws) from the particle system's render in
 * the world loop, and texture stage 1 adds stage 0 to itself for every world pass (0x48c4d7,
 * docs/re/renderer.md §1.8)]: saturate(2 x tex x colour). The alpha is not doubled. The port's
 * pools apply it in the shader (ParticlePool, engine-light.ts engineStages).
 */
export function particlePassColor(tex: number, colour: number): number {
  return worldStageColor(tex * colour);
}

/**
 * Particle pool blend (0 additive, 1 alpha, 2 subtractive) of a fountain [verified: the system
 * setup 0x10119fc0 sets flag 0x20 for p46 = 1, 0x40 for p46 = 2, 0x800000 for p46 = 3 and 0x200
 * for p47 != 0; the billboard pass (SUFFERING.EXE 0x4ad698) draws flags & 0x220 with engine
 * blend mode 2 (additive), 0x40 with mode 4 (reverse subtract), the rest with mode 1 (alpha)].
 * Retail: 286 additive (sparks, glows, Hermes' gas), 316 alpha (smoke, dust, blood), 2
 * subtractive. p46 = 3 (200 templates, blood and debris) also takes its colour from the light
 * at the emitter (0x10119e30, litParticleColor). The port used to read p46 as
 * 0 additive / 1 alpha / 3 alpha-tested: smoke glowed and sparks drew as orange fog.
 */
export function fountainBlend(v: PropValue[]): 0 | 1 | 2 {
  const m = num(v[46]);
  if (m === 1 || num(v[47]) !== 0) return 0;
  return m === 2 ? 2 : 1;
}

/**
 * Own launch of a BouncingObject handed only a matrix (an Object Generator spawn: 0x100b52a0 gives
 * BouncingObjects / Missiles no velocity, 0x100b5be1) [verified: launch Suffering.rfl 0x100cf8b0]:
 * velocity = -(row +0x34 of the object matrix, its local Z axis) x the launch speed (bouncingSpeed:
 * p1, or p2 when the launch carries a projectile record, `record`: every generator spawn);
 * gravity = world gravity x (p46 + uniform(-p47, p47)) % (0x100cfb81..0x100cfbd3); lifetime p12 s
 * (0x100cf8e9); spin bouncingSpin. In output
 * space the local Z axis is column 2 of the port's instance matrix (formats/level.ts
 * instanceRotation reproduces the engine's object matrix: positions are not rotated and models
 * are not converted) [inferred]. 1a "Hat Gen" 7047 (rotation 0): the cap leaves at 9.77 m/s
 * towards +x and falls at 0.75 x 10.41 m/s² (+- 5 %).
 */
export function bouncingLaunch(
  t: PropValue[],
  M: THREE.Matrix4,
  gravity: number,
  rand = Math.random(),
  record = false,
): { vel: THREE.Vector3; gravity: number; life: number; spin: THREE.Vector3 } {
  const vel = new THREE.Vector3().setFromMatrixColumn(M, 2).normalize().multiplyScalar(-bouncingSpeed(t, record) / WORLD_SCALE);
  return { vel, gravity: (gravity * (num(t[46], 100) + (2 * rand - 1) * num(t[47]))) / 100, life: num(t[12], 10), spin: bouncingSpin(t) };
}

/**
 * Launch speed of a Missile / BouncingObject (engine units/s) [verified: Suffering.rfl
 * 0x100cfa03..0x100cfa40]: p1, or, when the launch is handed a projectile record (record type 2:
 * every Object Generator spawn, 0x100b5be1 -> 0x100282e0, and every weapon's casing generator),
 * (p2 - p1) + p1, i.e. p2. No strength or random factor is read there. So break debris with p1 /
 * p2 = 3000 / 5000 leaves at 5000 units/s (2.44 m/s), the corpse gibs 3:3521 (-500 / -2000) at
 * -2000: backwards, along +local Z, at 0.98 m/s. The port used to read p1..p2 as a lifetime in ms
 * (the gibs then lived 0 s and vanished at once).
 */
export function bouncingSpeed(t: PropValue[], record: boolean): number {
  const p1 = num(t[1]);
  return record ? num(t[2], p1) - p1 + p1 : p1;
}

/**
 * Spin of a launched BouncingObject / Missile (rad/s about its local x, y, z) [strong: the launch
 * 0x100cfc0a..0x100cfc92 hands p4 deg/s about (0, 1, 0), p3 about (1, 0, 0) and p5 about (0, 0, 1)
 * to 0x100cc400, which sums them into one axis and rate and caps the rate at p6 deg/s; the frame
 * of the axes is inferred as the object's own]. Crate debris 3:4439: (300, 100, 100) capped at 45
 * deg/s; the guard's cap 3:1481: (350, 20, 75) under its 720.
 */
export function bouncingSpin(t: PropValue[]): THREE.Vector3 {
  const w = new THREE.Vector3(num(t[3]), num(t[4]), num(t[5])).multiplyScalar(Math.PI / 180);
  const cap = (num(t[6], 720) * Math.PI) / 180;
  const l = w.length();
  return l > cap && l > 0 ? w.multiplyScalar(cap / l) : w;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * What an Object Generator hands one spawned object (Suffering.rfl 0x100b52a0) [verified unless
 * marked]. Engine object rows X / Y / Z are the port matrix's columns 0 / 1 / 2 (as for
 * bouncingLaunch); `rand` gives uniform 0..1 (the engine's rand() / 32767). Speeds are p x 2048
 * units/s in the engine, so p m/s here; p17 is in engine units.
 *   Velocity V:
 *     p16 = 0: V = -Z x p9, turned by p11 deg about world up (0, 1, 0), p10 deg about the local X
 *       axis and p12 deg about the local Z axis (right-handed: 0x1000f910 / 0x1000c5b0); then
 *       V.y += (0.5 + rand) x p14 and V.x, V.z += uniform(-p13, p13) each.
 *     p16 != 0 (a cone): -Z turned uniform(p15, p16) deg about the local Y axis, then uniform(0,
 *       2 pi) about the local Z axis; with p17 > 0 the spawn point moves p17 units back against
 *       that direction; V = that direction x p9 (p13 / p14 not used).
 *   Matrix: the generator's own, then p20 != 0 turns it about its own axis p19 (0 X, 1 Y, 2 Z)
 *     by uniform(-p20, p20) taken as radians (no degree conversion: the retail 180 / 45 are a
 *     random turn); then p18 with |V| > 0 turns it to face V: local -Z along V (0x1000d070 with
 *     axis 2 negated, axis 1 from world up), dropping the p20 turn [the roll / handedness of the
 *     new basis inferred: kept a rotation, Y towards up, like the port's other matrices].
 *   Inherited velocity (the caller's argument, 0x100b5888): added to V after p18. The fire
 *     (0x100b616f) passes the generator's +0x2c and +0x38 vectors summed, which only a parent
 *     generator's record fills (0x100b51de); every generator a level, a Breakable or a weapon
 *     makes has zero.
 *   Who takes V: only an Item (class 0x5a410dde, 0x100b5a32 -> 0x10037b60). A BouncingObject or
 *   a Missile (0x100b5be1) gets the matrix and a projectile record without velocity, and flies
 *   its own launch along the matrix's -Z (bouncingLaunch with the record: speed p2). So for
 *   debris the generator's p9..p16 only matter through p18.
 */
export function generatorSpawn(gv: PropValue[], M: THREE.Matrix4, inherited?: THREE.Vector3Like, rand: () => number = Math.random): { vel: THREE.Vector3; matrix: THREE.Matrix4 } {
  const deg = Math.PI / 180;
  const X = new THREE.Vector3().setFromMatrixColumn(M, 0).normalize();
  const Y = new THREE.Vector3().setFromMatrixColumn(M, 1).normalize();
  const Z = new THREE.Vector3().setFromMatrixColumn(M, 2).normalize();
  const matrix = M.clone();
  const p9 = num(gv[9]);
  const d = Z.clone().negate();
  const vel = new THREE.Vector3();
  if (!num(gv[16])) {
    vel.copy(d).multiplyScalar(p9);
    if (num(gv[11])) vel.applyAxisAngle(WORLD_UP, num(gv[11]) * deg);
    if (num(gv[10])) vel.applyAxisAngle(X, num(gv[10]) * deg);
    if (num(gv[12])) vel.applyAxisAngle(Z, num(gv[12]) * deg);
    const p14 = num(gv[14]), p13 = num(gv[13]);
    vel.y += (0.5 + rand()) * p14;
    vel.x += (2 * rand() - 1) * p13;
    vel.z += (2 * rand() - 1) * p13;
  } else {
    const a = (num(gv[15]) + (num(gv[16]) - num(gv[15])) * rand()) * deg;
    d.applyAxisAngle(Y, a).applyAxisAngle(Z, rand() * 2 * Math.PI);
    const p17 = num(gv[17]);
    if (p17 > 0) {
      const e = matrix.elements;
      e[12] -= (d.x * p17) / WORLD_SCALE;
      e[13] -= (d.y * p17) / WORLD_SCALE;
      e[14] -= (d.z * p17) / WORLD_SCALE;
    }
    vel.copy(d).multiplyScalar(p9);
  }
  const p20 = num(gv[20]);
  if (p20) {
    const axis = [X, Y, Z][Math.min(2, Math.max(0, num(gv[19], 1)))];
    const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
    matrix.premultiply(new THREE.Matrix4().makeRotationAxis(axis, (2 * rand() - 1) * p20)).setPosition(pos);
  }
  if (num(gv[18]) && vel.lengthSq() > 1e-12) {
    const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
    const s = new THREE.Vector3().setFromMatrixScale(matrix);
    const up = Math.abs(vel.clone().normalize().y) > 0.999 ? new THREE.Vector3(1, 0, 0) : WORLD_UP;
    // lookAt(eye, target, up) builds +Z = eye - target: -Z points along V.
    matrix.lookAt(new THREE.Vector3(), vel, up).scale(s).setPosition(pos);
  }
  if (inherited) vel.add(inherited as THREE.Vector3);
  return { vel, matrix };
}

/**
 * Speed kept by one BouncingObject bounce [verified: Suffering.rfl 0x1009ac0f..0x1009ac52]:
 * (1 - the surface's Game Material Properties p4 %) x (1 - p51 %).
 */
export function bounceKeep(p51: number, surfaceP4 = 0): number {
  return Math.max(0, 1 - surfaceP4 / 100) * Math.max(0, 1 - p51 / 100);
}

/**
 * BouncingObject bounce off a contact normal n [verified: Suffering.rfl vtable +0x54 0x1009a3b0,
 * then 0x1009adae..0x1009ae45]: a contact the object moves away from (v . n >= 0) is ignored and
 * the object moves on; otherwise v becomes the mirror reflection (v - 2 (v . n) n) x keep
 * (bounceKeep). The random scatter (p58) and the spin damping (p6 / p53) do not change the path of
 * the retail objects that matter here (the cap has p58 = 0). Returns whether it bounced.
 */
export function bounceVelocity(v: THREE.Vector3, n: THREE.Vector3Like, keep: number): boolean {
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  if (vn >= 0) return false;
  v.set(v.x - 2 * vn * n.x, v.y - 2 * vn * n.y, v.z - 2 * vn * n.z).multiplyScalar(keep);
  return true;
}

const modelBoxes = new Map<string, THREE.Box3 | null>();

/** Model-space bounds of a (static) model, cached; undefined when it does not decode. */
export function modelBox(pkgs: EntityPackageSet, r: ResRef): THREE.Box3 | undefined {
  const k = `${r.pkg}:${r.id}`;
  let b = modelBoxes.get(k);
  if (b === undefined) {
    let m: ReturnType<typeof readModel>;
    try {
      m = readModel(pkgs as PackageSet, r);
    } catch {
      m = undefined;
    }
    b = m && m.positions.length ? new THREE.Box3().setFromArray(m.positions) : null;
    modelBoxes.set(k, b);
  }
  return b ?? undefined;
}

// ---------------------------------------------------------------------------
// Particle Fountain emitter

export class Emitter {
  on: boolean;
  dead = false;
  private acc = 0;
  private runFor = 0;
  readonly particles: Particle[] = [];
  private readonly c0 = new THREE.Color();
  private readonly c1 = new THREE.Color();
  private readonly axes: THREE.Vector3[] = [];
  readonly origin = new THREE.Vector3();
  /** Removed when its emission ended and its particles died (spawned one-shots). */
  oneShot = false;
  /**
   * Placement it keeps following (fountains spawned by an attached generator with a Follower
   * Object, p25): origin and axes are re-read every update; live particles stay in the world.
   */
  followM?: THREE.Matrix4;
  /**
   * p0 = 1 ("emit from the object"): the box of the fountain's own model, in model space.
   * Particles start at a random point inside it, carried by the current placement (a hardpoint
   * bone when a sequence attached the fountain). See `fountainEmitPoint`.
   */
  box?: THREE.Box3;
  /** Current placement (follows followM). */
  private readonly placement = new THREE.Matrix4();
  /** World gravity for p43 (m/s², levelGravity); the Fx sets the level's. */
  gravity = FOUNTAIN_GRAVITY;
  /** p46 = 3: coloured by the light at the emitter (litParticleColor). */
  readonly lit: boolean;
  /** Light at the emitter this frame (engine-light.ts particleLight); white until set. */
  readonly light = new THREE.Color(1, 1, 1);
  /** p48 = 1: velocity-aligned quads (streakFrame). */
  readonly streak: boolean;
  private readonly frame = { angle: 0, squash: 1 };
  /** Enhanced mode's gore only (gore-bus.ts): multiplies the lit colour. */
  goreTint?: THREE.Color;

  constructor(
    readonly v: PropValue[],
    M: THREE.Matrix4,
    readonly pools: ParticlePool[],
    // Kept for the callers; particles have no ground test (update).
    _collision: CollisionWorld | null,
    readonly uid = 0,
  ) {
    this.on = num(v[17], 1) !== 0 && num(v[16]) === 0;
    colorOf(v[33], this.c0);
    colorOf(v[34], this.c1);
    this.lit = num(v[46]) === 3;
    this.streak = fountainStreak(v);
    for (let k = 0; k < 3; k++) this.axes.push(new THREE.Vector3());
    this.place(M);
    this.start();
  }

  /** Origin and emission axes (p22 / p23 / p24: 0 x, 1 y, 2 z of the placement) from M. */
  place(M: THREE.Matrix4) {
    const v = this.v, e = M.elements;
    for (const k of [22, 23, 24]) {
      const i = Math.min(2, Math.max(0, num(v[k], k === 22 ? 1 : k === 23 ? 0 : 2)));
      this.axes[k - 22].set(e[4 * i], e[4 * i + 1], e[4 * i + 2]).normalize();
    }
    this.origin.set(e[12], e[13], e[14]);
    this.placement.copy(M);
  }

  start() {
    this.on = true;
    this.runFor = num(this.v[10]) > 0 ? num(this.v[10]) : Infinity;
  }

  stop() {
    this.on = false;
  }

  /** Destroy (p52): emission stops; p17 lets the live particles finish (fountainDestroyKeepsParticles). */
  destroy() {
    this.stop();
    if (fountainDestroyKeepsParticles(this.v)) this.oneShot = true;
    else this.dead = true;
  }

  get done() {
    return this.oneShot && !this.on && this.particles.length === 0;
  }

  /** Emission LOD from the camera distance: 1 within p29, 0 beyond p30. */
  lod(dist: number) {
    const near = num(this.v[29], 50), far = Math.max(near + 0.01, num(this.v[30], 50));
    return dist <= near ? 1 : dist >= far ? 0 : (far - dist) / (far - near);
  }

  update(dt: number, lod: number) {
    const v = this.v;
    if (this.followM) this.place(this.followM);
    if (this.on) {
      this.runFor -= dt;
      if (this.runFor <= 0) this.on = false;
      // Spawned one-shots (debris dust, sparks) always emit; placed fountains follow the LOD.
      const k = this.oneShot ? 1 : lod;
      if (k > 0) {
        this.acc += num(v[26]) * dt * k;
        let guard = 0;
        while (this.acc >= 1 && guard++ < 400) {
          this.acc -= 1;
          this.emit();
        }
      } else this.acc = 0;
    }
    // Gravity p43 (fountainParticleLife); no drag, no bounce in the engine's update.
    const g = this.gravity * num(v[43]) * dt;
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      p.v.y -= g;
      p.p.addScaledVector(p.v, dt);
      p.rot += p.spin * dt;
      // No ground test [verified]: neither the emitter think (Suffering.rfl 0x1011ab10) nor the
      // engine's particle update (SUFFERING.EXE 0x4ac1e0, run by 0x4ad1cb / 0x4ae85f) queries
      // collision; a particle flies until its lifetime ends and one that falls through a floor is
      // hidden by the depth test. The port used to stop every particle at the first surface
      // straight below the emitter: 1a's wall-box sparks (Breakable 5d69) lay in mid-air on the
      // box's own collision box, 1.26 m above the floor.
    }
  }

  private emit() {
    const v = this.v;
    if (this.particles.length > 600) return;
    const [A, U, W] = this.axes;
    const ang = THREE.MathUtils.degToRad(num(v[8], 360)) * Math.random();
    const c = Math.cos(ang), s = Math.sin(ang);
    const radial = new THREE.Vector3().addScaledVector(U, c).addScaledVector(W, s);
    const r = num(v[3]) * Math.sqrt(Math.random());
    const p = (this.box && num(v[0]) !== 0 ? fountainEmitPoint(this.box, this.placement, Math.random(), Math.random(), Math.random()) : this.origin.clone()).addScaledVector(radial, r);
    const vel = new THREE.Vector3()
      .addScaledVector(A, num(v[1]) * rnd(0.5, 1))
      .addScaledVector(radial, num(v[5]) * Math.random());
    const s0 = num(v[37], 600), s1 = Math.max(s0, num(v[38], s0));
    const { life, fadeIn, fadeOut } = fountainParticleLife(v);
    const spin = THREE.MathUtils.degToRad(num(v[49]));
    this.particles.push({
      p,
      v: vel,
      age: 0,
      life,
      size0: rnd(s0, s1) / WORLD_SCALE,
      grow: num(v[39]) / WORLD_SCALE,
      fadeIn,
      fadeOut,
      // Upright unless the fountain spins (p49): drip textures hang down [inferred].
      rot: spin ? Math.random() * Math.PI * 2 : 0,
      spin: spin * (Math.random() < 0.5 ? 1 : -1),
    });
  }

  /**
   * Write live particles into the pools. `view`: the camera's world-to-view matrix, for the
   * p48 = 1 streak frame.
   */
  draw(view?: THREE.Matrix4) {
    const np = this.pools.length;
    // p46 = 3: one colour for every live particle, p33 times the light at the emitter.
    const lit = this.lit && !LEGACY_LIGHTING ? litParticleColor(this.v[33], this.light, this.c1Lit) : null;
    if (lit && this.goreTint) lit.multiply(this.goreTint);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const t = p.age / p.life;
      const a = fountainParticleAlpha(p.age, p.life, p.fadeIn, p.fadeOut);
      const r = lit ? lit.r : this.c0.r + (this.c1.r - this.c0.r) * t;
      const g = lit ? lit.g : this.c0.g + (this.c1.g - this.c0.g) * t;
      const b = lit ? lit.b : this.c0.b + (this.c1.b - this.c0.b) * t;
      const size = Math.max(0, p.size0 + p.grow * p.age);
      if (size <= 0 || a <= 0) continue;
      // The size is the half extent: the engine's billboard corners are the projected centre
      // ± size (0x4ad5f9); a three.js sprite of scale s is s wide.
      if (this.streak && view) {
        const f = streakFrame(view, p.p, p.v, size, this.frame);
        this.pools[i % np].push(p.p.x, p.p.y, p.p.z, 2 * size, f.angle, r, g, b, a, f.squash);
      } else this.pools[i % np].push(p.p.x, p.p.y, p.p.z, 2 * size, p.rot, r, g, b, a);
    }
  }
  private readonly c1Lit = new THREE.Color();
}

// ---------------------------------------------------------------------------
// Debris (BouncingObject)

interface Debris {
  d: DynamicObject;
  /**
   * The point the engine sweeps (its position, or with p25 its bounds centre `c`, model space),
   * rotation, scale.
   */
  p: THREE.Vector3;
  c: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
  v: THREE.Vector3;
  /** Spin (rad/s about its own axes, bouncingSpin). */
  w: THREE.Vector3;
  age: number;
  life: number;
  rest: boolean;
  /** Trail fountains (BouncingObject p36) following the piece, and the matrix they follow. */
  trails?: Emitter[];
  trailM?: THREE.Matrix4;
  /** Gravity (m/s²) and the speed kept per bounce (bounceKeep: p51). */
  grav: number;
  keep: number;
  /**
   * Sweep radius (its model's bounds radius): the engine's segment test grows the triangles it
   * tests by it (CollisionWorld.frontSegmentCast).
   */
  grow: number;
  /** Bounces so far, p49 settle count (0 = never), p50 any surface counts, p54 fuse after settling. */
  bounces: number;
  settleBounces: number;
  anySurface: boolean;
  settleFuse: number;
  /** p34: generators spawned when it goes off. */
  detonate: ResRef[];
}

/**
 * Bounds-sphere radius of a model (.mdu type 7: u32 0, u32 0, f32 centre xyz, f32 radius) [data:
 * formats/model-spheres.ts]. The BouncingObject sweep radius is its engine object's bounds radius
 * (Suffering.rfl 0x100cfdd2: E vt+0x8c (0) -> +0xc into +0x18, passed down 0x100ceff0 ->
 * 0x100c6e10 as the narrow phase's radius) [strong: the bounds object read as that sphere].
 */
export function modelBoundsRadius(pkgs: PackageSet, r: ResRef): number | undefined {
  return modelBoundsSphere(pkgs, r)?.r;
}

/** Bounds sphere of a model (.mdu type 7): model-space centre and radius. */
export function modelBoundsSphere(pkgs: PackageSet, r: ResRef): { c: THREE.Vector3; r: number } | undefined {
  const mdu = (pkgs.get(r.pkg) as { mdu?: Parameters<typeof findEntry>[0] } | undefined)?.mdu;
  const e = mdu && findEntry(mdu, 7, r.id);
  if (!mdu || !e || e.size < 24) return undefined;
  const v = mdu.data(e);
  const rad = v.getFloat32(20, true);
  if (!(Number.isFinite(rad) && rad > 0)) return undefined;
  return { c: new THREE.Vector3(v.getFloat32(8, true), v.getFloat32(12, true), v.getFloat32(16, true)), r: rad };
}

// ---------------------------------------------------------------------------
// Object Generator runtime

/**
 * The p0 entries one firing of an Object Generator spawns (Suffering.rfl spawn 0x100b5ed0)
 * [verified]: p6 = 0 one random entry, 1 the next one in order (the counter at +0x10 starts at 0,
 * so the first firing takes entry 1), 2 every entry, any other value the first; each chosen entry
 * p1[i] times when p1 lists counts, else p2 times (0 or less: none). 4a/9/10's Inferna footsteps
 * (generator 3:2624, p6 0) light one of six fires a step, not all six.
 */
export function generatorPicks(gv: PropValue[], pick: { next: number }, rand = Math.random): { index: number; count: number }[] {
  const n = Array.isArray(gv[0]) ? (gv[0] as unknown[]).length : 0;
  if (!n) return [];
  const mode = num(gv[6], 2);
  let first = 0, last = 0;
  if (mode === 0) first = last = Math.min(n - 1, Math.floor(rand() * n));
  else if (mode === 1) first = last = pick.next = (pick.next + 1) % n;
  else if (mode === 2) last = n - 1;
  const counts = Array.isArray(gv[1]) ? (gv[1] as unknown[]) : [];
  const out: { index: number; count: number }[] = [];
  for (let i = first; i <= last; i++) {
    const count = counts.length ? num(counts[i]) : num(gv[2], 1);
    if (count > 0) out.push({ index: i, count });
  }
  return out;
}

/** Life a Stop leaves a running generator (0x100b4350: 1e-4 s, so the next think ends the run). */
export const GENERATOR_STOP_LIFE = 0.0001;

/**
 * Next spawn timer of an Object Generator: p7 + a uniform pick in [-p8, p8] (0x100b5ed0:
 * rand() x (p8 - -p8) / 32767 - p8 + p7) [verified]. At or below 0 it fires every think.
 */
export function generatorInterval(gv: PropValue[], rand = Math.random): number {
  const p8 = num(gv[8]);
  return num(gv[7]) - p8 + 2 * p8 * rand();
}

/**
 * Spawn range test of an Object Generator (0x100b5ed0, before the spawn) [verified]: with p28 > 0
 * nothing is spawned while the player (`d` = player - generator, metres; engine units / 2048) is
 * beyond p28 m. With p29 or p30 above 0 the player must also be at most p29 m above and p30 m
 * below the generator and the range is horizontal; else it is the 3D distance. No player: spawns.
 */
export function generatorInRange(gv: PropValue[], d: Vec3 | undefined): boolean {
  const range = num(gv[28]);
  if (!(range > 0) || !d) return true;
  const up = num(gv[29]), down = num(gv[30]);
  let dy = d[1];
  if (up > 0 || down > 0) {
    if (dy > up || dy < -down) return false;
    dy = 0;
  }
  return d[0] * d[0] + dy * dy + d[2] * d[2] <= range * range;
}

/**
 * Object Generator runtime (Suffering.rfl, vtable 0x10155710) [verified unless marked]:
 * - Created (vt +0xc, 0x100b4ea0) with its run time `life` = p21 (s; 0 = the run never ends) and
 *   `runs` = p22 (runs before it is destroyed; 0 = any number). p24 starts it (0x100b5232).
 * - Start (p32; Toggle p34 while off; 0x100b43d0): on, spawn timer 0, so the next think fires. A
 *   generator with a run time goes to engine state 8 (thinks every frame: EXE 0x457d40 ->
 *   0x45bdc0) and thinks once at once when created on; one without (p21 = 0) to state 4, which
 *   thinks only in frames the renderer reaches it (EXE list 0x45bf00, filled from the scene visit
 *   0x4a06d0, cleared every frame 0x45bfd0) [port: within 45 m of the camera, `near`].
 * - Stop (p33; Toggle while on): life = 1e-4 s (0x100b4350): the next think ends the run.
 * - Think (vt +0x18, 0x100b6190): life -= dt (when set; the run ends at <= 0); timer -= dt; at
 *   <= 0 it fires (in the think that ends the run only if timer <= life): the timer is reset to
 *   generatorInterval, the generatorPicks entries spawn when generatorInRange, then the sound p36
 *   (0x100b4460, whatever the range).
 * - Run end (0x100b4590): off, life = p21 again; `runs` counts down when set and at 0 the
 *   generator is destroyed. A destroyed generator with p5 set destroys what it spawned
 *   (0x100b4dc0 -> 0x100b49e0: Particle Fountains through their Destroy p52, the rest removed);
 *   without p5 its spawns live on.
 * - p23 caps what it has alive: every spawn is refused while p23 > 0 objects it made still exist
 *   (spawn 0x100b52a0 compares the handle list +0x5a / count +0x62 with p23 first; the think
 *   0x100b61fa drops the handles of objects gone, before the timer). 1a's lobby sparks 81f2
 *   (3:2642: p7 0.1 endless, p23 3) spawn two spark fountains and the Sound Effect 4:1159 (p1
 *   plays it at creation, p3 1 repeats 4:297 until stopped, so it never goes): one hum, the
 *   fountains renewed as they burn out. Without the cap the port started a new looping hum
 *   every 0.1 s, filled all 48 voices in 5 s and every later sound of the same or lower
 *   priority was dropped (the metal detector alarm 8147 among them) [verified].
 *   Port: what is alive is known for fountains, generators, BouncingObjects and Sound Effects
 *   (`Fx.spawn` returns the probe); other spawned classes (src/game/fx spawners, props) are not
 *   counted.
 * So 1a's chair-room generator 12:779 (p7 0.05, p21 0.6, p22 1) fires 12 or 13 times and is
 * gone, leaving the one endless 12:775 it spawned (p7 1 ± 0.3, within p28 50 m).
 */
export class Generator {
  /** On (engine state 4 / 8). */
  running = false;
  dead = false;
  /** Spawn timer (+0x18). */
  private wait = 0;
  /** Run time left (+0x1c; 0 = endless). */
  private life: number;
  /** Runs left before it is destroyed (+0x14; 0 = no limit). */
  private runs: number;
  /** p21 = 0 at creation (state 4: thinks only while seen) (+0xc bit 0). */
  readonly endless: boolean;
  /** Context the spawns get (debris direction, attachment owner). */
  private ctx: SpawnContext = {};
  /** What it spawned, for a p5 destroy. */
  private readonly children: { emitters: Emitter[]; generators: Generator[] } | undefined;
  /** The p6 = 1 entry counter (+0x10, 0 at creation). */
  readonly pick = { next: 0 };
  /** What it spawned that still exists, for the p23 cap (+0x5a / +0x62). */
  readonly live: (() => boolean)[] = [];

  constructor(
    readonly v: PropValue[],
    readonly M: THREE.Matrix4,
    readonly fx: Fx,
    readonly uid = 0,
  ) {
    this.life = Math.max(0, num(v[21]));
    this.endless = this.life === 0;
    this.runs = Math.max(0, Math.floor(num(v[22])));
    this.children = num(v[5]) !== 0 ? { emitters: [], generators: [] } : undefined;
  }

  get mode() {
    return num(this.v[6], 2);
  }

  /** p24: on from creation. */
  get autoStart() {
    return num(this.v[24]) !== 0;
  }

  /** Start (On): fires at the next think. */
  trigger(ctx?: SpawnContext) {
    if (this.dead) return;
    if (ctx) this.ctx = ctx;
    this.running = true;
    this.wait = 0;
  }

  /** Stop (Off): the run ends at the next think. */
  stop() {
    this.life = GENERATOR_STOP_LIFE;
  }

  /** Destroyed (p31, its run count used up, an owner going). */
  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.running = false;
    const c = this.children;
    if (!c) return;
    for (const em of c.emitters) em.destroy();
    for (const g of c.generators) g.destroy();
    c.emitters.length = c.generators.length = 0;
  }

  /**
   * One think. `near`: an endless generator thinks only then (state 4); `player`: player minus
   * generator (m) for the p28 range, undefined when there is no player.
   */
  update(dt: number, near: boolean, player?: Vec3) {
    if (this.dead || !this.running) return;
    if (this.endless && !near) return;
    // Handles of objects gone are dropped first (0x100b61fa).
    for (let i = this.live.length - 1; i >= 0; i--) if (!this.live[i]()) this.live.splice(i, 1);
    let ended = false;
    if (this.life !== 0) {
      this.life -= dt;
      ended = this.life <= 0;
    }
    this.wait -= dt;
    if (this.wait <= 0 && (!ended || this.wait <= this.life)) this.fire(player);
    if (ended) this.endRun();
  }

  private fire(player: Vec3 | undefined) {
    this.wait = generatorInterval(this.v);
    const c = this.children;
    const e0 = c ? this.fx.emitters.length : 0;
    const g0 = c ? this.fx.generators.length : 0;
    this.fx.spawnList(this.v, this.M, this.ctx, this.pick, generatorInRange(this.v, player), { max: Math.max(0, Math.floor(num(this.v[23]))), live: this.live });
    if (c) {
      c.emitters.push(...this.fx.emitters.slice(e0));
      c.generators.push(...this.fx.generators.slice(g0));
    }
  }

  private endRun() {
    this.running = false;
    this.life = Math.max(0, num(this.v[21]));
    if (this.runs > 0 && --this.runs === 0) this.destroy();
  }
}

// ---------------------------------------------------------------------------
// Volumetric Fog [inferred]: p0 texture, p1 colour, p2 puff count, p11 opacity, p12 puff size,
// p8 drift speed, p13 start on; inputs p15 On, p16 Off, p17 Destroy. The volume is the
// template's unit cube scaled by the instance (like Detectors).

export class FogVolume {
  readonly group = new THREE.Group();
  on: boolean;
  /** Puff rest positions relative to the centre (xyz) and drift phases. */
  private readonly base: Float32Array;
  private readonly phase: Float32Array;
  private readonly offsets: THREE.InstancedBufferAttribute;
  private readonly sprite: THREE.Sprite;
  /** Offsets and sizes are stored times this (1 / the sprite's object scale). */
  private readonly k: number;
  private t = 0;

  constructor(
    readonly e: Entity,
    map: THREE.Texture | null,
    readonly center: THREE.Vector3,
    axes: THREE.Vector3[],
  ) {
    const v = e.values;
    this.on = num(v[13], 1) !== 0;
    const n = Math.min(48, Math.max(4, Math.round(num(v[2], 20) / 3)));
    const size = Math.max(0.5, num(v[12], 3));
    // Puffs accumulate additively: the fog colour (p1) is the light the volume adds.
    const col = colorOf(v[1]).multiplyScalar(1.5);
    const opacity = Math.min(1, Math.max(0.1, num(v[11], 0.3) * 2.5));
    // All puffs in one instanced sprite draw (they used to be one Sprite each: up to 48 draws
    // per volume). Additive blending does not depend on the drawing order.
    const mat = new THREE.SpriteNodeMaterial({ map, color: col, transparent: true, opacity, depthWrite: false, fog: true, blending: THREE.AdditiveBlending });
    if (!LEGACY_LIGHTING) {
      // Additive: fades to black with the fog (engine blend mode 2), summed on gamma values.
      const t = map ? tslTexture(map) : null;
      const rgb = vec3(uniform(new THREE.Vector3(col.r, col.g, col.b)));
      mat.colorNode = vec4(additiveEffectColor(t ? t.rgb.mul(rgb) : rgb, t ? t.a.mul(opacity) : float(opacity)), float(1));
      mat.fog = false;
    }
    this.base = new Float32Array(3 * n);
    this.phase = new Float32Array(n);
    const scales = new Float32Array(n);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(0, 0, 0);
      for (const a of axes) p.addScaledVector(a, rnd(-0.5, 0.5));
      p.toArray(this.base, 3 * i);
      scales[i] = size * rnd(0.7, 1.3);
      // (The material was shared by every puff, so the last rotation drawn applied to all.)
      mat.rotation = Math.random() * Math.PI;
      this.phase[i] = Math.random() * 100;
    }
    // Frustum culling: three.js tests a sprite as a sphere of radius 0.7071 x its object
    // scale, so the object is scaled to cover every puff (drift and size included) and the
    // instance offsets / sizes are divided by that scale.
    let reach = 0;
    for (let i = 0; i < n; i++) reach = Math.max(reach, Math.hypot(this.base[3 * i], this.base[3 * i + 1], this.base[3 * i + 2]) + 0.6 + scales[i]);
    this.k = 1 / (reach / Math.SQRT1_2);
    for (let i = 0; i < 3 * n; i++) this.base[i] *= this.k;
    for (let i = 0; i < n; i++) scales[i] *= this.k;
    this.offsets = new THREE.InstancedBufferAttribute(this.base.slice(), 3);
    this.offsets.setUsage(THREE.DynamicDrawUsage);
    mat.positionNode = instancedDynamicBufferAttribute(this.offsets, 'vec3');
    mat.scaleNode = instancedBufferAttribute(new THREE.InstancedBufferAttribute(scales, 1), 'float');
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = n;
    this.sprite.position.copy(center);
    this.sprite.scale.setScalar(1 / this.k);
    this.sprite.renderOrder = 1;
    this.sprite.name = 'fog-puffs';
    this.group.name = `Volumetric Fog#${e.uid.toString(16)}`;
    this.group.add(this.sprite);
    this.group.visible = this.on;
  }

  update(dt: number) {
    if (!this.on) return;
    this.t += dt;
    const sp = Math.max(0.05, num(this.e.values[8], 1)) * 0.15;
    const b = this.base, o = this.offsets.array as Float32Array, s = this.k;
    for (let i = 0; i < this.phase.length; i++) {
      const k = this.t * sp + this.phase[i];
      o[3 * i] = b[3 * i] + Math.sin(k) * 0.4 * s;
      o[3 * i + 1] = b[3 * i + 1] + Math.sin(k * 0.7) * 0.1 * s;
      o[3 * i + 2] = b[3 * i + 2] + Math.cos(k * 0.8) * 0.4 * s;
    }
    this.offsets.needsUpdate = true;
  }

  setOn(on: boolean) {
    this.on = on;
    this.group.visible = on;
  }

  dispose() {
    (this.sprite.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------------

export class Fx {
  readonly group = new THREE.Group();
  readonly emitters: Emitter[] = [];
  readonly generators: Generator[] = [];
  readonly fogs: FogVolume[] = [];
  private debris: Debris[] = [];
  private pools = new Map<string, ParticlePool>();
  private textures = new Map<string, THREE.Texture | null>();
  private billboards: { s: THREE.Sprite; size: [number, number]; far: number }[] = [];
  private readonly camPos = new THREE.Vector3();

  /** World gravity (m/s², levelGravity): the level's Level Properties once placed. */
  gravity = FOUNTAIN_GRAVITY;
  /**
   * Speed a bounce keeps on a surface besides the BouncingObject's own p51 loss: 1 - the
   * surface's Game Material Properties p4 % (bounceKeep); set by src/game/fx/system.ts, which
   * knows the surfaces. Undefined: 1.
   */
  surfaceKeep?: (hit: RayHit) => number;

  constructor(readonly env: FxEnv) {
    this.group.name = 'world-fx';
  }

  texture(r: ResRef | null): THREE.Texture | null {
    if (!r) return null;
    const k = `${r.pkg}:${r.id}`;
    let t = this.textures.get(k);
    if (t === undefined) {
      t = this.env.dyn.textureByKey(k);
      if (t) {
        // Particles want clamped edges.
        t = t.clone();
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
      }
      this.textures.set(k, t);
    }
    return t;
  }

  /** Spawners added by other modules (src/game/fx/system.ts), tried after `env.spawnOther`. */
  readonly spawners: FxSpawner[] = [];
  /** Called every frame while the sprite pools are open for writing (`pool(...).push`). */
  readonly drawHooks: ((dt: number) => void)[] = [];

  /**
   * Shared instanced sprite pool for a texture and blend mode (0 additive, 1 alpha, 3 cutout);
   * `streak`: velocity-aligned quads (p48 = 1).
   */
  pool(tex: THREE.Texture, key: string, blend: number, streak = false) {
    const k = `${key}|${blend}${streak ? '|s' : ''}`;
    let p = this.pools.get(k);
    if (!p) {
      p = new ParticlePool(tex, blend, streak);
      this.pools.set(k, p);
      this.group.add(p.sprite);
    }
    return p;
  }

  /** Particle Fountain (placed or spawned) at a placement matrix. */
  addFountain(v: PropValue[], M: THREE.Matrix4, uid = 0, model?: ResRef): Emitter | undefined {
    const texs = refList(v[36]).filter((r): r is ResRef => !!r);
    const blend = fountainBlend(v);
    const pools: ParticlePool[] = [];
    const streak = fountainStreak(v);
    for (const r of texs) {
      const t = this.texture(r);
      if (t) pools.push(this.pool(t, `${r.pkg}:${r.id}`, blend, streak));
    }
    if (!pools.length) return undefined;
    const em = new Emitter(v, M, pools, this.env.collision, uid);
    em.gravity = this.gravity;
    // p0 = 1: emit from inside the fountain's own model box (fountainEmitPoint).
    if (model && num(v[0]) !== 0) em.box = modelBox(this.env.packages, model);
    this.emitters.push(em);
    // Enhanced mode's gore (gore-bus.ts; never set in Original): blood fountains drip and darken.
    if (em.lit) gore.listener?.fountain?.(em, texs.map((r) => this.texture(r)));
    return em;
  }

  addGenerator(v: PropValue[], M: THREE.Matrix4, uid = 0): Generator {
    const g = new Generator(v, M, this, uid);
    this.generators.push(g);
    return g;
  }

  addFog(e: Entity): FogVolume | undefined {
    const c = entityBoxCorners(e, instanceRotation);
    if (!c) return undefined;
    const P = c.map((p) => new THREE.Vector3(p[0] / WORLD_SCALE, p[1] / WORLD_SCALE, p[2] / WORLD_SCALE));
    const center = P.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / 8);
    const axes = [P[1].clone().sub(P[0]), P[2].clone().sub(P[0]), P[4].clone().sub(P[0])];
    const f = new FogVolume(e, this.texture(ref(e.values[0])), center, axes);
    this.fogs.push(f);
    this.group.add(f.group);
    return f;
  }

  /** Billboard (glow corona) [inferred]: p0 textures, p2..p3 size range, p9 fade distance. */
  addBillboard(e: Entity) {
    const v = e.values;
    const map = this.texture(refList(v[0])[0] ?? null);
    if (!map) return;
    const mat = new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const s = new THREE.Sprite(mat);
    const M = instanceMatrix(e.position, e.rotation);
    s.position.setFromMatrixPosition(M);
    s.renderOrder = 4;
    s.name = `Billboard#${e.uid.toString(16)}`;
    this.group.add(s);
    this.billboards.push({ s, size: [Math.max(0.05, num(v[2], 0.5)), Math.max(0.1, num(v[3], 2))], far: Math.max(5, num(v[9], 40)) });
  }

  /** One firing of an Object Generator at M: the p0 entries `generatorPicks` chooses. */
  /** `inRange`: generatorInRange; out of range only the sound plays (the picks do not advance). */
  /** `cap`: the generator's p23 (0 = no limit) and what it has alive (Generator.live). */
  spawnList(gv: PropValue[], M: THREE.Matrix4, ctx: SpawnContext, pick: { next: number } = { next: 0 }, inRange = true, cap?: { max: number; live: (() => boolean)[] }) {
    const list = refList(gv[0]);
    const sounds = refList(gv[36]);
    const pos = new THREE.Vector3().setFromMatrixPosition(M);
    const snd = sounds[Math.floor(Math.random() * sounds.length)];
    if (snd) this.env.playSound([`${snd.pkg}:${snd.id}`], [pos.x, pos.y, pos.z]);
    if (!inRange) return;
    const sub = { ...ctx, gen: gv };
    for (const { index, count } of generatorPicks(gv, pick)) {
      const r = list[index];
      if (!r) continue;
      for (let n = 0; n < count; n++) {
        if (cap && cap.max > 0 && cap.live.length >= cap.max) continue;
        // Each spawn's matrix (generatorSpawn: p17 / p18 / p20) [verified]; objects that follow
        // their owner keep the matrix it moves (attachments, parented effects).
        const turns = !!(num(gv[20]) || num(gv[18]) || (num(gv[16]) && num(gv[17]) > 0));
        const alive = this.spawn(r, turns && !ctx.owner && !ctx.parent ? generatorSpawn(gv, M).matrix : M, sub);
        if (alive && cap) cap.live.push(alive);
      }
    }
  }

  /**
   * Spawn a template at a placement (output space). Returns whether the object it made still
   * exists (a generator's p23 cap), for the classes whose life the port tracks.
   */
  spawn(r: ResRef, M: THREE.Matrix4, ctx: SpawnContext = {}): (() => boolean) | undefined {
    const t = readTemplate(this.env.packages, r);
    if (!t) return;
    if (this.env.spawnOther?.(t, M, ctx)) return;
    for (const f of this.spawners) if (f(t, M, ctx)) return;
    switch (t.cls) {
      case 'Object Generator': {
        // Started at creation: p24 [verified]; the spawners of the p24 = 0 templates (CartWheeler
        // p55, Black One p48, Drip, Map Item, ...) start theirs [port: their own code is not
        // decoded]. A generator with a run time thinks at once (Generator).
        const g = new Generator(t.values, M, this);
        this.generators.push(g);
        g.trigger(ctx);
        if (!g.endless) g.update(0, true, this.playerOffset(M));
        return () => !g.dead;
      }
      case 'Particle Fountain': {
        const em = this.addFountain(t.values, M, 0, t.model);
        if (em) {
          // Owned by an attachment set: kept (paused while its carrier is hidden) until the owner
          // stops it for good (attachments.ts stopEmitters makes it a one-shot then); follows
          // the generator through its Follower Object (Object Generator p25, 0x100b4810).
          em.oneShot = !ctx.owner;
          if (ctx.owner) {
            ctx.owner.push(em);
            if (ref(ctx.gen?.[25])) em.followM = M;
          }
          // Spawned fountains without a duration emit for a short burst only.
          else if (!(num(t.values[10]) > 0)) setTimeout(() => em.stop(), 1500);
          return () => !em.dead && !em.done;
        }
        return;
      }
      case 'BouncingObject': {
        const last = this.debris[this.debris.length - 1];
        this.spawnDebris(t, M, ctx);
        const x = this.debris[this.debris.length - 1];
        return x && x !== last ? () => this.debris.includes(x) : undefined;
      }
      case 'Decorative FX':
        for (const x of refList(t.values[0])) if (x) this.spawn(x, M, ctx);
        return;
      case 'Sound Effect': {
        const keys = refList(t.values[0]).filter((x): x is ResRef => !!x).map((x) => `${x.pkg}:${x.id}`);
        const p = new THREE.Vector3().setFromMatrixPosition(M);
        // p6 is the re-trigger interval, not a range: the sound's header distances apply
        // (src/game/world/sound-effect.ts). p1 plays it at creation (0x1012cc8c -> Play
        // 0x1012c9a0); play mode p3 1 repeats it until stopped. The object stays (a Sound Effect
        // destroys itself only in play mode 4 or when what it is attached to goes), so it holds
        // its generator's p23 slot [port: spawned modes 2..4 play once].
        if (keys.length && num(t.values[1]) !== 0) this.env.playSound(keys, [p.x, p.y, p.z], num(t.values[3]) === SFX_MODE.repeat ? { loop: true } : undefined);
        return () => true;
      }
    }
  }

  /**
   * A BouncingObject (break debris, gibs, the 1a guard's cap) [verified unless marked;
   * docs/game-logic.md §14.2 "Debris"]: created at the matrix its spawner hands it (an Object
   * Generator's: generatorSpawn, p18 / p19 / p20), it flies its own launch (bouncingLaunch: -local
   * Z at p2 with a generator's record, else p1; p46 / p47 gravity; p12 life; p3..p6 spin) from its
   * origin, which is where the pieces of a break are modelled around. The engine sweeps the
   * origin's segment (vt+0x5c), not the piece's centre.
   */
  private spawnDebris(t: TemplateInfo, M: THREE.Matrix4, ctx: SpawnContext) {
    if (!t.model) return;
    if (this.debris.length > 120) this.removeDebris(0);
    // A generator's spawn carries a projectile record (speed p2); M is already its spawn matrix.
    const record = !!ctx.gen;
    const S = M;
    const d = this.env.dyn.spawnModel(t.model, S, { collides: false, name: `debris:${t.ref.pkg}:${t.ref.id}` });
    if (!d) return;
    const l = bouncingLaunch(t.values, S, this.gravity, Math.random(), record);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    S.decompose(p, q, s);
    let sph = modelBoundsSphere(this.env.packages as unknown as PackageSet, t.model);
    if (!sph) {
      const bb = new THREE.Box3();
      d.pivot.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g) {
          g.computeBoundingBox();
          bb.union(g.boundingBox!);
        }
      });
      const bs = bb.isEmpty() ? new THREE.Sphere() : bb.getBoundingSphere(new THREE.Sphere());
      sph = { c: bs.center, r: bs.radius };
    }
    // p25 = 1: the sweep follows the object's vt+0x64 point instead of its position (the current
    // position getter 0x100cc1f0; the launch 0x100cf95c seeds the previous one from it too), the
    // point its detonation (0x100d10b2) and the aim's p48 = 1 also use: its bounds centre
    // [strong: the 66 retail objects with p25 = 1 are break pieces modelled metres from their
    // origin, the crate's 3:4439 4.0..5.2 m up; those with p25 = 0 sit on theirs]. The piece
    // turns about that point.
    const c = num(t.values[25]) ? sph.c.clone() : new THREE.Vector3();
    p.add(c.clone().multiply(s).applyQuaternion(q));
    const grow = sph.r;
    this.debris.push({
      d,
      s,
      c,
      p,
      v: l.vel,
      q,
      w: l.spin,
      age: 0,
      life: l.life,
      rest: false,
      grav: l.gravity,
      keep: bounceKeep(num(t.values[51])),
      grow,
      bounces: 0,
      settleBounces: num(t.values[49]),
      anySurface: num(t.values[50]) !== 0,
      settleFuse: num(t.values[54]),
      detonate: refList(t.values[34]).filter((r): r is ResRef => !!r),
    });
    // p36: fountains carried by the piece (1a "Hat Gen": the guard's cap 3:1481 trails blood
    // 3:2357 for its p10 = 5 s) [inferred from the data: the only list of fountain templates
    // on the class, each with a short emission time].
    const x = this.debris[this.debris.length - 1];
    for (const r of refList(t.values[36])) {
      const ft = r && readTemplate(this.env.packages, r);
      if (!ft || ft.cls !== 'Particle Fountain') continue;
      x.trailM ??= new THREE.Matrix4().compose(x.p, x.q, this.one.set(1, 1, 1));
      const em = this.addFountain(ft.values, x.trailM, 0, ft.model);
      if (!em) continue;
      em.oneShot = true;
      em.followM = x.trailM;
      (x.trails ??= []).push(em);
    }
  }

  private removeDebris(i: number) {
    const x = this.debris[i];
    for (const em of x.trails ?? []) em.stop();
    this.env.dyn.remove(x.d.uid);
    this.debris.splice(i, 1);
  }

  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();
  private readonly one = new THREE.Vector3(1, 1, 1);

  private updateDebris(dt: number) {
    const col = this.env.collision;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const x = this.debris[i];
      x.age += dt;
      // Lifetime over (p12, or p54 s after settling): the object goes off, its p34 generators
      // spawn where it is (0x1009a230), and it is removed.
      if (x.age >= x.life) {
        if (x.detonate.length) {
          const at = new THREE.Matrix4().compose(x.p, x.q, this.one.set(1, 1, 1));
          for (const r of x.detonate) this.spawn(r, at);
        }
        this.removeDebris(i);
        continue;
      }
      if (!x.rest) {
        x.v.y -= x.grav * dt;
        const sx = x.v.x * dt, sy = x.v.y * dt, sz = x.v.z * dt;
        // The engine's sweep (CollisionWorld.frontSegmentCast: the origin's segment to the new
        // position against front faces, triangles grown by the bounds radius; characters are not
        // in it [inferred]).
        // Invisible Static Objects with p5 stop it (world/blockers.ts, the projectile layer).
        let h: RayHit | null = null;
        if (col && sx * sx + sy * sy + sz * sz > 1e-10) {
          const layers = col.queryLayers ?? 0;
          col.queryLayers = layers | COLLISION_LAYER.projectile;
          h = col.frontSegmentCast(x.p.x, x.p.y, x.p.z, x.p.x + sx, x.p.y + sy, x.p.z + sz, x.grow);
          col.queryLayers = layers;
        }
        if (h) {
          const n = new THREE.Vector3(...h.normal);
          x.p.set(h.point[0], h.point[1], h.point[2]).addScaledVector(n, 0.002);
          // Every hit counts (0x1009a8c0, weapons/data.ts bounceHit): at p49 it settles when p50
          // is set or the hit is a floor, and goes p54 s later; otherwise it bounces: mirror x
          // (1 - p51 %) x the surface's keep (bounceVelocity).
          const r = bounceHit({ bounces: x.settleBounces, anySurfaceBounces: x.anySurface }, x.bounces, n.y);
          x.bounces = r.count;
          if (r.settle) {
            x.rest = true;
            x.v.set(0, 0, 0);
            x.life = Math.min(x.life, x.age + x.settleFuse);
          } else bounceVelocity(x.v, n, x.keep * (this.surfaceKeep?.(h) ?? 1));
        } else x.p.set(x.p.x + sx, x.p.y + sy, x.p.z + sz);
        // Spin about its own axes (bouncingSpin) [frame inferred].
        const wl = x.w.length();
        if (wl > 1e-6) x.q.multiply(this.tmpQ.setFromAxisAngle(this.tmpV.copy(x.w).divideScalar(wl), wl * dt));
      }
      // root = T(p) · R(q) · S(s) · T(-c)
      x.d.root.matrix.compose(x.p, x.q, x.s).multiply(this.tmpM.makeTranslation(-x.c.x, -x.c.y, -x.c.z));
      x.d.root.matrixWorldNeedsUpdate = true;
      x.trailM?.compose(x.p, x.q, this.one.set(1, 1, 1));
    }
  }

  private readonly tmpV = new THREE.Vector3();

  update(dt: number, cam: THREE.Camera) {
    dt *= this.env.timeScale();
    cam.getWorldPosition(this.camPos);
    if (this.anchors.size) this.followAnchors();
    this.updateGenerators(dt);
    for (const em of this.emitters) em.update(dt, em.lod(this.camPos.distanceTo(em.origin)));
    for (let i = this.emitters.length - 1; i >= 0; i--) if (this.emitters[i].done || this.emitters[i].dead) this.emitters.splice(i, 1);
    for (const p of this.pools.values()) p.begin();
    cam.updateMatrixWorld();
    const view = cam.matrixWorldInverse;
    for (const em of this.emitters) {
      if (!em.particles.length || this.camPos.distanceToSquared(em.origin) >= 80 * 80) continue;
      // p46 = 3: the light at the emitter, every think (Suffering.rfl 0x1011b087).
      if (em.lit && !LEGACY_LIGHTING) engineLights.particleLight(em.origin, em.light);
      em.draw(view);
    }
    // Other modules' sprites (src/game/fx: smoke puffs) go into the same pools.
    for (const fn of this.drawHooks) fn(dt);
    for (const p of this.pools.values()) p.end();
    for (const f of this.fogs) f.update(dt);
    for (const b of this.billboards) {
      const d = this.camPos.distanceTo(b.s.position);
      const k = Math.min(1, d / b.far);
      b.s.scale.setScalar(b.size[0] + (b.size[1] - b.size[0]) * k);
      (b.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - Math.max(0, d - b.far) / b.far);
    }
    this.updateDebris(dt);
  }

  /** Generators think (`near`: within 45 m of the camera); the destroyed ones go. */
  updateGenerators(dt: number) {
    // A firing may add generators while this runs: they think from the next frame.
    const gens = this.generators;
    for (let i = 0, n = gens.length; i < n; i++) {
      const g = gens[i];
      if (!g.dead) g.update(dt, this.near(g.M, 45), this.playerOffset(g.M));
    }
    for (let i = gens.length - 1; i >= 0; i--) if (gens[i].dead) gens.splice(i, 1);
  }

  /** Player minus the placement's position (m), for a generator's p28 range; undefined: no player. */
  playerOffset(M: THREE.Matrix4): Vec3 | undefined {
    const p = this.env.playerPos?.();
    if (!p) return undefined;
    const e = M.elements;
    return [p[0] - e[12], p[1] - e[13], p[2] - e[14]];
  }

  private near(M: THREE.Matrix4, r: number) {
    const e = M.elements;
    const dx = e[12] - this.camPos.x, dy = e[13] - this.camPos.y, dz = e[14] - this.camPos.z;
    return dx * dx + dy * dy + dz * dz < r * r;
  }

  /**
   * Placed effect objects of a level: Particle Fountains, Object Generators (on from the start
   * with p24, Generator), Volumetric Fog and Billboards, with their message inputs.
   */
  placeLevel(world: World) {
    this.gravity = levelGravity(world.of('Level Properties')[0]?.e.values);
    for (const em of this.emitters) em.gravity = this.gravity;
    const byUid = new Map<number, Emitter | Generator | FogVolume>();
    for (const w of world.of('Particle Fountain')) {
      const em = this.addFountain(w.e.values, instanceMatrix(w.e.position, w.e.rotation), w.uid, w.e.modelRef);
      if (!em) continue;
      // Off until an On message unless p14 (fountainStartsOn).
      if (!w.visible || !fountainStartsOn(w.e.values)) em.stop();
      byUid.set(w.uid, em);
    }
    for (const w of world.of('Object Generator')) {
      const g = this.addGenerator(w.e.values, instanceMatrix(w.e.position, w.e.rotation), w.uid);
      byUid.set(w.uid, g);
      // p24 starts it at creation (0x100b5232); the save-state test 0x100b4530 also takes p24 as
      // its initial state [verified]. Links do not matter: 1a's STOMP-driven blood generators
      // (7489 / 7f1b) have p24 0 and wait for their sequence's On.
      if (g.autoStart && w.visible) g.trigger();
    }
    for (const w of world.of('Volumetric Fog')) {
      const f = this.addFog(w.e);
      if (f) byUid.set(w.uid, f);
    }
    for (const w of world.of('Billboard')) this.addBillboard(w.e);
    world.handlers.push((w, msg) => {
      const x = byUid.get(w.uid);
      if (!x) return false;
      const v = w.e.values;
      if (x instanceof Emitter) {
        if (num(v[50], 1) === msg) return x.start(), true;
        if (num(v[51], 2) === msg) return x.stop(), true;
        if (num(v[52], 11) === msg) {
          x.stop();
          // p17: the live particles finish (fountainDestroyKeepsParticles); else gone at once.
          if (fountainDestroyKeepsParticles(v)) x.oneShot = true;
          else x.dead = true;
          return true;
        }
      } else if (x instanceof Generator) {
        if (num(v[32], 1) === msg) return x.trigger(), true;
        if (num(v[33], 2) === msg) return x.stop(), true;
        // Toggle (0x100b4410): Stop while on, else Start.
        if (num(v[34], 3) === msg) return (x.running ? x.stop() : x.trigger()), true;
        if (num(v[31], 12) === msg) return x.destroy(), true;
        if (num(v[35], 13) === msg) return true;
      } else {
        if (num(v[15], 1) === msg) return x.setOn(true), true;
        if (num(v[16], 2) === msg) return x.setOn(false), true;
        if (num(v[17], 12) === msg) return x.setOn(false), true;
      }
      return false;
    });
    this.placed = byUid;
    this.world = world;
  }

  private world?: World;

  private placed = new Map<number, Emitter | Generator | FogVolume>();
  /** Scene stand-ins of placed emitters / generators that ride a hardpoint (`anchor`). */
  private anchors = new Map<number, { o: THREE.Object3D; x: Emitter | Generator }>();

  /**
   * Scene object standing in for a placed Particle Fountain or Object Generator, for the
   * hardpoint attacher (weapons/attach.ts): a STOMP attach key parents any object to a bone
   * (EXE 0x450c10 makes no class distinction), and effect objects have no mesh of their own.
   * The effect follows the stand-in every frame from then on: a fountain's origin, axes and
   * emission box, a generator's spawn matrix. 1a "Gaurd" #280 attaches MouthBloodGen to the
   * guard's jaw (hardpoint 22). Undefined for other uids.
   */
  anchor(uid: number): THREE.Object3D | undefined {
    const had = this.anchors.get(uid);
    if (had) return had.o;
    const x = this.placed.get(uid);
    if (!(x instanceof Emitter) && !(x instanceof Generator)) return undefined;
    const o = new THREE.Object3D();
    o.name = `fx-anchor#${uid.toString(16)}`;
    const w = this.world?.get(uid);
    (w ? instanceMatrix(w.e.position, w.e.rotation) : x instanceof Generator ? x.M : new THREE.Matrix4()).decompose(o.position, o.quaternion, o.scale);
    this.group.add(o);
    o.updateMatrixWorld();
    if (x instanceof Emitter) x.followM = o.matrixWorld;
    this.anchors.set(uid, { o, x });
    return o;
  }

  private followAnchors() {
    for (const { o, x } of this.anchors.values()) {
      o.updateWorldMatrix(true, false);
      if (x instanceof Generator) x.M.copy(o.matrixWorld);
    }
  }

  /** Level logic showed / hid a placed effect (instance flag 0x1 clear = shown later). */
  setVisible(uid: number, visible: boolean) {
    const x = this.placed.get(uid);
    if (x instanceof Emitter) visible ? x.start() : x.stop();
    else if (x instanceof FogVolume) x.setOn(visible);
  }

  /** Stats for the overlay / tests. */
  stats() {
    let particles = 0;
    for (const e of this.emitters) particles += e.particles.length;
    return { emitters: this.emitters.length, generators: this.generators.length, particles, debris: this.debris.length, fogs: this.fogs.length, billboards: this.billboards.length };
  }

  dispose() {
    for (const p of this.pools.values()) p.dispose();
    for (const f of this.fogs) f.dispose();
    for (const b of this.billboards) (b.s.material as THREE.Material).dispose();
    for (const t of this.textures.values()) t?.dispose();
    for (const x of this.debris) this.env.dyn.remove(x.d.uid);
    this.debris = [];
    this.group.removeFromParent();
  }
}
