// Three.js materials for Riot Engine surfaces (decoded .odu materials, see formats/model.ts).
//
// The engine draws a material as up to 8 passes ("layers"), each a texture with one of nine
// blend modes (SUFFERING.EXE 0x49a990):
//   0/3 opaque (ONE, ZERO)            1 alpha (SRCALPHA, INVSRCALPHA)   2 add (SRCALPHA, ONE)
//   4 reverse-subtract (SRCALPHA, ONE) 5 dst*a (ZERO, SRCALPHA)         6 modulate2x (DESTCOLOR, SRCCOLOR)
//   7 src + dst*a (ONE, SRCALPHA)     8 cutout (alpha test 200/255, 1-bit-alpha textures)
// A texture's alpha channel therefore only means coverage for modes 1/2/4/5/7/8: on opaque
// layers it is ignored (many DXT5 diffuse maps store a reflection mask there).
//
// Single-layer materials map to one Three material with the matching blend state. Layered
// materials (typically an environment-reflection base + a mode-7 diffuse whose alpha masks
// the reflection, + a modulate2x detail layer) are composited in one shader, in pass order, on
// gamma values saturated after each pass, as the passes would land in the engine's back buffer.
// Every blend happens on gamma values: the renderer's back buffer is gamma-encoded like the
// engine's (engine-light.ts GAMMA_BACK_BUFFER, docs/re/renderer.md §5.1).
//
// Each pass is its texture × the vertex lighting (untinted) or × its tint (tinted, unlit), in
// gamma space, doubled by texture stage 1 (engine-light.ts, docs/re/renderer.md §1.8 / §3.5);
// that holds for effect passes too. Blended passes never write depth: only an opaque or
// cut-out first pass does (render-data.ts passDepthWrite).

import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  attribute,
  clamp,
  float,
  floor,
  mix,
  mod,
  normalView,
  normalWorld,
  positionView,
  positionWorld,
  reflectVector,
  reflectView,
  sRGBTransferEOTF as srgbToLinearTsl,
  sRGBTransferOETF as linearToSrgbTsl,
  materialOpacity,
  materialReference,
  texture as textureNode,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';
import {
  Blend,
  findEntry,
  materialSignature,
  TDU_TEXTURE,
  TexInput,
  waveformAt,
  type LandscapeSplat,
  type MaterialLayer,
  type PackageSet,
  type SurfaceMaterial,
  type Waveform,
} from '../formats/model';
import { coverageMipmaps, decodeTexture } from '../formats/texture';
import type { DecodedTexture } from '../formats/types';
import { glowMarkAlphaRef, glowMarked, passAlphaRef, passDepthWrite, tintFactor } from '../formats/render-data';
import { glowMark, setGlowMark } from './glow-mark';
import { ENGINE_SHADOW_TEXTURES, LEGACY_LIGHTING, MAX_FRAGMENT_TEXTURES, additiveEffectColor, engineAlbedo, engineLightFactor, engineLightMaterial, engineStages, engineSurfaceFinish, enhancedShading, fitEnhancedMaps, type EnhancedMaps } from './engine-light';

/** Legacy look only (`?lighting=legacy`): gain applied to baked per-vertex lighting. */
export const bakedGain = uniform(3.0);

/** Alpha-test threshold for cutout (mode 8) surfaces. The engine uses 200/255 on bilinear
 *  samples of 1-bit alpha; 0.5 keeps thin bars/grates their authored width. */
export const CUTOUT_ALPHA_TEST = 0.5;

// TSL node types are deeply generic; the helpers below pass nodes around untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
/** sRGB transfer functions (gamma ↔ linear), untyped for chaining. */
const toSrgb = (c: N): N => (linearToSrgbTsl as N)(c);
const toLinear = (c: N): N => (srgbToLinearTsl as N)(c);

export interface SurfaceTextureSource {
  /** GPU texture for a key (null when the key is missing). `cutout` asks for the coverage-preserving variant. */
  texture(key: string, cutout: boolean): THREE.Texture | null;
  /** All frames as one array texture (null when the frames differ in size or are missing). */
  frames?(keys: string[]): THREE.DataArrayTexture | null;
  /** Placeholder for missing textures. */
  missing(): THREE.Texture;
  /** Does the decoded texture carry alpha? (parts without a material: alpha = cutout coverage) */
  hasAlpha?(key: string): boolean;
}

export interface SurfaceMaterialOptions {
  material?: SurfaceMaterial;
  /** Single texture of parts without a decoded material. */
  textureKey?: string;
  /** Mesh has a `color` attribute (baked lighting). */
  vertexColors: boolean;
  /** Mesh has a `uv` attribute. */
  hasUvs?: boolean;
  /** Floor-layer splats (mesh has `splat0`/`splat1` weight attributes). */
  splat?: LandscapeSplat[];
  side?: THREE.Side;
  /**
   * Enhanced mode: generated maps of the base texture (normal / roughness / specular), sampled
   * with the base layer's coordinates; part of the shared graph's structure. Ignored in Original
   * mode (docs/enhanced.md "Extension points").
   */
  enhancedMaps?: EnhancedMaps;
}

/**
 * Enhanced mode, texture enhancement (docs/enhanced.md "Texture enhancement"): the generated cache's
 * maps of a texture key, and its upscaled replacement (`base` is the texture Original draws).
 * Installed by src/app/enhanced/maps/runtime.ts; unset in Original mode, where nothing changes.
 */
export const enhancedTextures: {
  maps?(key: string): EnhancedMaps | undefined;
  texture?(key: string, cutout: boolean, base: THREE.Texture | null): THREE.Texture | null;
  /**
   * Materials lit through engineLightMaterial's shared graph (characters): the map layout of this
   * level's tier (its `enhancedMaps` option; undefined: none), and `bind` gives a material the
   * maps of its texture key (neutral stand-ins without an entry).
   */
  layout?(): EnhancedMaps | undefined;
  bind?(material: THREE.Material, key: string | undefined): void;
} = {};

/** Does this layer sample with the mesh's own UVs (layerUv's `uv()` branch)? */
export function meshUvLayer(l: MaterialLayer): boolean {
  const g = l.texGen ?? 0;
  const generated = g === 4 || g === 5 || (g >= 1 && g <= 3) || (g >= 7 && g <= 9);
  return !generated || (l.texInput ?? TexInput.Uv) === TexInput.Uv;
}

export interface SurfaceMaterialResult {
  material: THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial;
  /** Texture keys that could not be resolved (drawn with the placeholder). */
  missing: string[];
  /** Blend mode the material was built with (base layer). */
  blend: number;
}

const isUnlitBlend = (b: number) => b === Blend.Add || b === Blend.Subtract || b === Blend.MulAlpha || b === Blend.Modulate2x;
const isBlended = (b: number) => b !== Blend.Opaque && b !== Blend.Opaque3 && b !== Blend.Cutout;

// Shared shaders. three.js keys a material's shader by the ids of its nodes, so a node graph of
// its own made every surface material build (and, through the generated names, often compile)
// its own shader, although most differ only in their textures and constants: 1a's load spent
// most of its time on that (docs/game-logic.md §18.8). A material's graph is therefore built from
// its *structure* (layer count, blend modes, texture inputs, tinted or lit passes, splats...) and
// shared by every material with the same structure; the per-material values (textures, uv scales
// and offsets, tints, splat tiling and fade) are read from the material being drawn, through
// material reference nodes into `material.surfaceSlots`, as three.js does for `map` and `color`.

/** Per-material values of a shared surface graph, in the order the graph reads them. */
interface SurfaceSlots {
  t: THREE.Texture[];
  f: number[];
  v2: THREE.Vector2[];
  v3: THREE.Vector3[];
}

/** Records a material's structure (`key`) and values (`slots`) while its graph is composed. */
class SurfaceGraph {
  readonly key: string[] = [];
  readonly slots: SurfaceSlots = { t: [], f: [], v2: [], v3: [] };
  tok(s: string | number) {
    this.key.push(String(s));
  }
  /** The material's i-th texture, sampled at `coords`. */
  tex(t: THREE.Texture, coords: N): N {
    const i = this.slots.t.push(t) - 1;
    this.key.push('t');
    return (materialReference(`surfaceSlots.t.${i}`, 'texture') as N).context({ getUV: () => coords });
  }
  f(v: number): N {
    const i = this.slots.f.push(v) - 1;
    this.key.push('f');
    return materialReference(`surfaceSlots.f.${i}`, 'float');
  }
  v2(x: number, y: number): N {
    const i = this.slots.v2.push(new THREE.Vector2(x, y)) - 1;
    this.key.push('v2');
    return materialReference(`surfaceSlots.v2.${i}`, 'vec2');
  }
  v3(x: number, y: number, z: number): N {
    const i = this.slots.v3.push(new THREE.Vector3(x, y, z)) - 1;
    this.key.push('v3');
    return materialReference(`surfaceSlots.v3.${i}`, 'vec3');
  }
}

/**
 * Surface materials carry their slot values in `surfaceSlots`, kept by clone() / copy() (a
 * sky dome clones its surface material) so a copy reads the same values through the graph.
 */
class SurfaceStandardMaterial extends THREE.MeshStandardNodeMaterial {
  surfaceSlots?: SurfaceSlots;
  override copy(source: SurfaceStandardMaterial): this {
    super.copy(source);
    this.surfaceSlots = source.surfaceSlots;
    return this;
  }
}
class SurfaceBasicMaterial extends THREE.MeshBasicNodeMaterial {
  surfaceSlots?: SurfaceSlots;
  override copy(source: SurfaceBasicMaterial): this {
    super.copy(source);
    this.surfaceSlots = source.surfaceSlots;
    return this;
  }
}

/** Colour node of each surface structure (SurfaceGraph key). */
const sharedGraphs = new Map<string, N>();
/** engineLightFactor per lighting kind (precomputed or not), shared by every surface graph. */
const lightFactors = new Map<boolean, N>();
const lightFactor = (precomputed: boolean): N => {
  let f = lightFactors.get(precomputed);
  if (!f) lightFactors.set(precomputed, (f = engineLightFactor({ precomputed })));
  return f;
};

/**
 * Looped (u, v) value of a .wdu waveform (material UV scroll / scale), one uniform per
 * waveform shared by every material using it, updated once per frame from the frame time.
 */
const waveUniforms = new Map<string, N>();
function waveUniform(w: Waveform): N {
  let u = waveUniforms.get(w.key);
  if (!u) {
    const v = new THREE.Vector2();
    u = (uniform(v) as N).onFrameUpdate((frame: { time: number }) => v.set(waveformAt(w, frame.time, 0), waveformAt(w, frame.time, 1)));
    waveUniforms.set(w.key, u);
  }
  return u;
}

/**
 * Texture coordinates of a layer: the engine's per-pass texture matrix (formats/model.ts
 * advancedLayer, SUFFERING.EXE 0x48e9f0) applied to the input the pass selects (0x4359xx):
 * Advanced prop 11 picks mesh UVs (0), position (1, engine units scaled by 1 / 2048 = model
 * units), normal (2) or the reflection vector (3, xvsTextureMatrix_Reflection.vsh); the texgen
 * mode (prop 12) picks the space and the two axes: 1 / 7 x-z, 2 / 8 y-z, 3 / 9 x-y of world
 * space (the object's matrix), 4 / 5 x-y of camera space. Generated inputs are mapped from
 * [-1, 1] to [0, 1] (× 0.5 + 0.5) after the prop 6 scale; then the prop 7 / 8 offsets and the
 * waveforms (prop 9 scale, prop 10 scroll) apply.
 */
function layerUv(l: MaterialLayer, S: SurfaceGraph): N {
  const g = l.texGen ?? 0;
  const input = l.texInput ?? TexInput.Uv;
  const camera = g === 4 || g === 5;
  const planar = (g >= 1 && g <= 3) || (g >= 7 && g <= 9);
  let c: N;
  let bias = false;
  if ((camera || planar) && input !== TexInput.Uv) {
    bias = true;
    // Position: engine units / 2048 = model units (the port's world units).
    const v: N =
      input === TexInput.Position ? (camera ? positionView : positionWorld)
      : input === TexInput.Normal ? (camera ? normalView : normalWorld)
      : camera ? reflectView : reflectVector;
    const a = planar ? (g % 3 === 1 ? 'xz' : g % 3 === 2 ? 'yz' : 'xy') : 'xy';
    S.tok(`g${camera ? 'c' : 'w'}${input}${a}`);
    c = a === 'xz' ? vec2(v.x, v.z) : a === 'yz' ? vec2(v.y, v.z) : vec2(v.x, v.y);
  } else {
    S.tok('uv');
    c = uv();
  }
  const k = (l.uvScale ?? 1) * (bias ? 0.5 : 1);
  let coords: N = c.mul(S.f(k));
  if (l.scaleWave) {
    S.tok(`sw:${l.scaleWave.key}`);
    coords = coords.mul(waveUniform(l.scaleWave));
  }
  const off = [(bias ? 0.5 : 0) + (l.uvOffset?.[0] ?? 0), (bias ? 0.5 : 0) + (l.uvOffset?.[1] ?? 0)];
  if (off[0] || off[1]) coords = coords.add(S.v2(off[0], off[1]));
  if (l.scroll) {
    S.tok(`sc:${l.scroll.key}`);
    coords = coords.add(waveUniform(l.scroll));
  }
  return coords;
}

interface LayerSample {
  rgb: N;
  a: N;
}

/**
 * Colour of one engine pass (docs/re/renderer.md §3.5): texture stage 0 is MODULATE of the texture
 * with DIFFUSE (the vertex lighting oD0) or, for a tinted layer, with TFACTOR = tint / 2 and no
 * lighting at all. Both on gamma values. `light` is the material's engineLightFactor (gamma).
 * Texture stage 1 then doubles the result, saturated (engineStages, render-data.ts
 * WORLD_STAGE_GAIN): a white-tinted layer shows its texture as is.
 */
function shadePass(l: MaterialLayer, s: LayerSample, light: N, S: SurfaceGraph): LayerSample {
  const g: N = toSrgb(s.rgb);
  const tf = tintFactor(l.tint);
  if (tf) {
    S.tok('tint');
    return { rgb: toLinear(engineStages(g.mul(S.v3(tf[0], tf[1], tf[2])))), a: s.a };
  }
  S.tok('lit');
  return { rgb: toLinear(engineStages(engineAlbedo(g).mul(light))), a: s.a };
}

function sampleLayer(l: MaterialLayer, src: SurfaceTextureSource, missing: string[], S: SurfaceGraph): LayerSample | null {
  const coords = layerUv(l, S);
  let node: N | null = null;
  if (l.frames && l.frames.length > 1 && src.frames) {
    const arr = src.frames(l.frames);
    if (arr) {
      // Animated layers (rare) keep their frames in the graph: part of the structure.
      S.tok(`arr:${arr.id}:${l.fps ?? 15}`);
      const frame = mod(floor(time.mul(l.fps ?? 15)), float(l.frames.length));
      node = textureNode(arr, coords).depth(frame);
    }
  }
  if (!node && l.texture) {
    const t = src.texture(l.texture, l.blend === Blend.Cutout);
    if (!t) missing.push(l.texture);
    node = S.tex(t ?? src.missing(), coords);
  }
  if (!node) {
    S.tok('none');
    return null;
  }
  let rgb: N = node.rgb;
  // Legacy look: the tint multiplies the texture (the engine path is shadePass).
  if (LEGACY_LIGHTING) {
    const c = new THREE.Color().setHex(l.tint ?? 0xffffff, THREE.SRGBColorSpace);
    rgb = rgb.mul(S.v3(c.r, c.g, c.b));
  }
  return { rgb, a: node.a };
}

/**
 * Composite pass `l` (colour c) over the accumulated colour, as the blend mode would in the
 * engine's back buffer: on gamma values, saturated (render-data.ts backBufferBlend). Colours
 * in and out are linear.
 */
function blendOver(acc: N, c: LayerSample, blend: number): N {
  if (LEGACY_LIGHTING) return blendOverLinear(acc, c, blend);
  if (blend === Blend.Opaque || blend === Blend.Opaque3) return c.rgb;
  // A cut-out pass replaces or keeps: the same in either space.
  if (blend === Blend.Cutout) return mix(acc, c.rgb, c.a.step(CUTOUT_ALPHA_TEST).oneMinus());
  const d: N = toSrgb(acc), s: N = toSrgb(c.rgb), a: N = c.a;
  let out: N;
  switch (blend) {
    case Blend.Alpha:
      out = mix(d, s, a);
      break;
    case Blend.Add:
      out = d.add(s.mul(a));
      break;
    case Blend.Subtract:
      out = d.sub(s.mul(a));
      break;
    case Blend.MulAlpha:
      out = d.mul(a);
      break;
    case Blend.Modulate2x:
      // DESTCOLOR × SRCCOLOR + SRCCOLOR × DESTCOLOR: 50 % grey is neutral.
      out = d.mul(s).mul(2);
      break;
    case Blend.AddOverAlpha:
      out = s.add(d.mul(a));
      break;
    default:
      return acc;
  }
  return toLinear(out.clamp(0, 1));
}

/** `?lighting=legacy`: the previous linear-space compositing. */
function blendOverLinear(acc: N, c: LayerSample, blend: number): N {
  switch (blend) {
    case Blend.Opaque:
    case Blend.Opaque3:
      return c.rgb;
    case Blend.Alpha:
      return mix(acc, c.rgb, c.a);
    case Blend.Cutout:
      return mix(acc, c.rgb, c.a.step(CUTOUT_ALPHA_TEST).oneMinus());
    case Blend.Add:
      return acc.add(c.rgb.mul(c.a));
    case Blend.Subtract:
      return acc.sub(c.rgb.mul(c.a)).max(0);
    case Blend.MulAlpha:
      return acc.mul(c.a);
    case Blend.Modulate2x:
      return acc.mul(c.rgb).mul(2);
    case Blend.AddOverAlpha:
      return c.rgb.add(acc.mul(c.a));
    default:
      return acc;
  }
}

function applyBlendState(m: THREE.Material, blend: number, glowMark: boolean | undefined) {
  if (!isBlended(blend)) return;
  m.transparent = true;
  // Only an opaque or cut-out first pass writes depth (0x48fc56): the layer flag decoded as
  // `depthWrite` (Advanced p5 / Animating p7) is the glow pass's stencil mark instead
  // (render-data.ts passDepthWrite). `?lighting=legacy` keeps the old reading.
  m.depthWrite = LEGACY_LIGHTING ? !!glowMark : passDepthWrite(blend);
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  switch (blend) {
    case Blend.Alpha:
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
    case Blend.Add:
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneFactor;
      break;
    case Blend.Subtract:
      m.blendEquation = THREE.ReverseSubtractEquation;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneFactor;
      break;
    case Blend.MulAlpha:
      m.blendSrc = THREE.ZeroFactor;
      m.blendDst = THREE.SrcAlphaFactor;
      break;
    case Blend.Modulate2x:
      m.blendSrc = THREE.DstColorFactor;
      m.blendDst = THREE.SrcColorFactor;
      break;
    case Blend.AddOverAlpha:
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.SrcAlphaFactor;
      break;
  }
  // Separate alpha factors are irrelevant (the canvas is opaque); keep them equal.
  m.blendSrcAlpha = m.blendSrc;
  m.blendDstAlpha = m.blendDst;
  m.blendEquationAlpha = m.blendEquation;
}

/**
 * Floor-layer splats ("Land Splat", xvsLandsplatAlpha.vsh): near the camera the engine draws the
 * full-resolution landscape textures over the low-resolution baked atlas, each pass with
 * alpha = vertex weight × (1 - (depth / fadeDistance)²). Composited here in pass order.
 */
function applySplats(rgb: N, splats: LandscapeSplat[], src: SurfaceTextureSource, missing: string[], S: SurfaceGraph, shade: (c: N) => N = (c) => c): N {
  const depth: N = positionView.z.negate();
  const p: N = positionWorld;
  splats.slice(0, 8).forEach((sp, k) => {
    const t = src.texture(sp.texture, false);
    if (!t) {
      missing.push(sp.texture);
      S.tok(`s${k}-`);
      return;
    }
    S.tok(`s${k}`);
    const w: N = attribute(k < 4 ? 'splat0' : 'splat1', 'vec4');
    const weight: N = [w.x, w.y, w.z, w.w][k % 4];
    const d: N = depth.div(S.f(sp.fade));
    const fade: N = clamp(float(1).sub(d.mul(d)), 0, 1);
    const c: N = shade(S.tex(t, vec2(p.x, p.z).div(S.f(sp.tiling))).rgb);
    rgb = mix(rgb, c, weight.mul(fade));
  });
  return rgb;
}

/**
 * Build the Three material for a surface. Works for static level parts and for dynamic
 * object submeshes (pass `material` and `textureKey` from ModelSubmesh).
 */
export function createSurfaceMaterial(opts: SurfaceMaterialOptions, src: SurfaceTextureSource): SurfaceMaterialResult {
  const missing: string[] = [];
  const side = opts.side ?? THREE.DoubleSide;
  let layers = opts.material?.layers.filter((l) => l.texture || l.frames) ?? [];
  if (!layers.length && opts.textureKey) {
    // No decoded material: legacy behaviour, texture alpha = cutout coverage.
    const cut = src.hasAlpha?.(opts.textureKey) ?? false;
    layers = [{ texture: opts.textureKey, blend: cut ? Blend.Cutout : Blend.Opaque }];
  }
  if (opts.hasUvs === false) layers = layers.filter((l) => l.texGen);

  if (!layers.length) {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x6a6a66, vertexColors: opts.vertexColors, roughness: 0.9, metalness: 0, side });
    // (The material's own colour through the shared engine-lit graph: no shader of its own.)
    if (!LEGACY_LIGHTING) engineLightMaterial(m, { precomputed: opts.vertexColors });
    return { material: m, missing, blend: Blend.Opaque };
  }

  const base = layers[0];
  const blend = base.blend;
  const unlit = isUnlitBlend(blend);
  const gammaAdd = !LEGACY_LIGHTING && (blend === Blend.Add || blend === Blend.Subtract);
  // The graph is composed every time (cheap: plain objects) to record the structure and the
  // values; the first material of a structure keeps its graph, later ones share it.
  const S = new SurfaceGraph();
  S.tok(`${blend}|${opts.vertexColors ? 'vc' : ''}`);
  // Engine passes: every layer is lit by the vertex lighting, or by its halved tint (unlit).
  // Enhanced mode: per-surface nodes from generated maps (part of the structure: tokens + slots).
  let surface: unknown;
  // (Without explicit maps, the generated cache's maps of the first lit mesh-UV layer: enhancedTextures.)
  let mapsLayer = layers[0];
  let emaps = opts.enhancedMaps;
  if (!emaps && enhancedTextures.maps && !unlit) {
    const l = layers.find((x) => x.texture && !x.frames && !isUnlitBlend(x.blend) && meshUvLayer(x));
    if (l) (emaps = enhancedTextures.maps(l.texture!)), (mapsLayer = l);
  }
  if (enhancedTextures.texture) {
    const base = src, swap = enhancedTextures.texture;
    src = { ...base, texture: (key, cutout) => swap(key, cutout, base.texture(key, cutout)) };
  }
  // (Within the fragment stage's texture limit: every layer and splat samples one texture, every
  // lit Enhanced graph its shadow maps and the projected character shadows; the maps take what is
  // left, dropping by priority. Layered surfaces of 1a went to 17-18 and their pipelines failed.)
  if (emaps) {
    const used = layers.length + Math.min(opts.splat?.length ?? 0, 8) + (enhancedShading.textures ?? 0) + ENGINE_SHADOW_TEXTURES;
    emaps = fitEnhancedMaps(emaps, MAX_FRAGMENT_TEXTURES - used);
  }
  if (enhancedShading.surface && emaps && (emaps.normal || emaps.roughness || emaps.specular)) {
    const coords = layerUv(mapsLayer, S);
    const maps = emaps;
    S.tok(`em:${maps.normal ? 'n' : ''}${maps.roughness ? 'r' : ''}${maps.specular ? 's' : ''}${maps.detail ? 'd' : ''}`);
    surface = enhancedShading.surface(maps, (t) => S.tex(t, coords), coords);
  }
  const light: N | null = LEGACY_LIGHTING ? null : surface ? engineLightFactor({ precomputed: opts.vertexColors, surface }) : lightFactor(opts.vertexColors);
  const samples = layers.map((l) => {
    const s = sampleLayer(l, src, missing, S);
    return s && light ? shadePass(l, s, light, S) : s;
  });
  let rgb: N = samples[0]!.rgb;
  const alpha: N = samples[0]!.a;
  for (let i = 1; i < layers.length; i++) {
    const s = samples[i];
    S.tok(`b${layers[i].blend}`);
    if (s) rgb = blendOver(rgb, s, layers[i].blend);
  }
  if (opts.splat?.length) rgb = applySplats(rgb, opts.splat, src, missing, S, light ? (c: N) => toLinear(engineStages(engineAlbedo(toSrgb(c)).mul(light))) : undefined);
  const colour: N = vec4(rgb, isBlended(blend) || blend === Blend.Cutout ? alpha : float(1));
  // Enhanced mode: glow-marked surfaces (the scene glow's sources) are emitters in the HDR frame.
  const glow = !LEGACY_LIGHTING && !!enhancedShading.glow && glowMarked(layers);
  if (glow) S.tok('glow');
  const key = S.key.join(',');
  let node = sharedGraphs.get(key);
  if (!node) {
    // The object's opacity (material.opacity) scales the pass alpha like the engine's TFACTOR
    // alpha x object opacity (SUFFERING.EXE 0x48fcdf): here also the premultiplied colour (ONE,
    // ONE); 1 for everything but faded characters (fx/body-parts.ts).
    if (unlit) node = gammaAdd ? vec4(additiveEffectColor(rgb, alpha.mul(materialOpacity)), alpha) : colour;
    // Lit: already shaded per pass; the projected-shadow receiver pass darkens the result.
    else if (!LEGACY_LIGHTING) node = vec4(engineSurfaceFinish(rgb, { precomputed: opts.vertexColors, surface }), colour.a);
    else node = colour;
    if (glow) node = vec4(enhancedShading.glow!(vec4(node).rgb), vec4(node).a);
    sharedGraphs.set(key, node);
  }

  let material: THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial;
  if (unlit) {
    const m = new SurfaceBasicMaterial({ side });
    m.surfaceSlots = S.slots;
    m.colorNode = node;
    // Multiplicative decals must not fade to the (dark) fog colour.
    // Additive / subtractive effects: gamma-space sum, fog to black (engine-light.ts); alpha
    // kept for the alpha test below (the blend factors ignore it: ONE, ONE).
    if (blend === Blend.MulAlpha || blend === Blend.Modulate2x || gammaAdd) m.fog = false;
    material = m;
  } else {
    const m = new SurfaceStandardMaterial({ vertexColors: opts.vertexColors, roughness: 0.9, metalness: 0, side });
    m.surfaceSlots = S.slots;
    if (!LEGACY_LIGHTING) {
      // (applyEngineColor's settings, with the shared node itself as the colour.)
      m.colorNode = node;
      m.lights = false;
      m.vertexColors = false;
      m.userData.engineLit = true;
    } else {
      m.colorNode = node;
      // Legacy: texture × vertex colour × gain emitted in linear space, three.js lights on top.
      if (opts.vertexColors) m.emissiveNode = rgb.mul(vec3(vertexColor())).mul(bakedGain);
    }
    material = m;
  }
  if (blend === Blend.Cutout) {
    material.alphaTest = CUTOUT_ALPHA_TEST;
    material.alphaToCoverage = true;
  } else if (!LEGACY_LIGHTING && isBlended(blend)) {
    // Modes 1..6 draw with D3DRS_ALPHATEST > 2/255 (0x48fab0), an additive pass carrying the
    // glow mark (`depthWrite`: fire cards' Animating p7) with > 32/255; mode 7 has no test.
    const ref = passAlphaRef(blend, !!base.depthWrite);
    if (ref !== null) material.alphaTest = ref;
  }
  applyBlendState(material, blend, base.depthWrite);
  if (gammaAdd) {
    // The colour is already premultiplied (additiveEffectColor).
    material.blendSrc = material.blendSrcAlpha = THREE.OneFactor;
  }
  material.name = opts.material?.key ?? opts.textureKey ?? 'untextured';
  // Pixels this surface marks for the scene glow (src/app/scene-glow.ts, render-data.ts glowMarked).
  if (!LEGACY_LIGHTING && glowMarked(layers)) setGlowMark(material, glowMarkMaterial(layers, side, src, missing));
  return { material, missing, blend };
}

/** Mark materials of the scene glow, shared per (side) for the passes that need no alpha. */
const plainMarks = new Map<THREE.Side, THREE.Material>();

/**
 * The scene-glow mark of a surface (docs/re/renderer.md §3.2): drawn after the scene over its
 * depth (equal or nearer), it leaves the colour alone and writes alpha 1, the frame's glow mask,
 * as the engine's flagged passes write stencil 1 that 0x49c030 turns into destination alpha.
 * The first flagged layer's alpha test applies (additive > 32 / 255, cut-out > 200 / 255,
 * other blends > 2 / 255; opaque: none).
 */
function glowMarkMaterial(layers: MaterialLayer[], side: THREE.Side, src: SurfaceTextureSource, missing: string[]): THREE.Material {
  const fl = layers.find((l) => l.depthWrite) ?? layers[0];
  const ref = glowMarkAlphaRef(fl.blend);
  let m: SurfaceBasicMaterial | undefined;
  if (ref === null) {
    const hit = plainMarks.get(side);
    if (hit) return hit;
    m = new SurfaceBasicMaterial({ side });
    m.colorNode = vec4(0, 0, 0, 1);
    plainMarks.set(side, m);
  } else {
    const S = new SurfaceGraph();
    S.tok(`mark|${ref}`);
    const s = sampleLayer(fl, src, missing, S);
    const key = S.key.join(',');
    let node = sharedGraphs.get(key);
    if (!node) {
      const a: N = s ? s.a : float(1);
      node = Fn(() => {
        Discard(a.lessThanEqual(ref));
        return vec4(0, 0, 0, 1);
      })();
      sharedGraphs.set(key, node);
    }
    m = new SurfaceBasicMaterial({ side });
    m.surfaceSlots = S.slots;
    m.colorNode = node;
  }
  m.fog = false;
  m.depthWrite = false;
  m.depthFunc = THREE.LessEqualDepth;
  // Drawn again over the scene's own depth: the basic material's vertex shader does not land on
  // exactly the depth the surface wrote (the mark failed the equal test nearly everywhere), so
  // it is pulled a hair towards the camera.
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  m.blending = THREE.CustomBlending;
  m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
  // Colour kept (ZERO, ONE), alpha replaced (ONE, ZERO).
  m.blendSrc = THREE.ZeroFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.ZeroFactor;
  m.name = `glow-mark:${ref ?? 'opaque'}`;
  return m;
}

// ---------------------------------------------------------------------------
// GPU textures

/** RGBA8 DataTexture for a decoded texture (stored row order, engine UVs as-is). */
export function toDataTexture(src: DecodedTexture, opts: { lightmap?: boolean; cutout?: boolean } = {}): THREE.DataTexture {
  const tex = new THREE.DataTexture(src.rgba, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = src.name ?? src.key;
  // Rows stay in stored (bottom-up) order with flipY=false: uv v=0 samples stored row 0,
  // which is what the engine's Direct3D UVs address.
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  if (opts.cutout && isPow2(src.width) && isPow2(src.height)) {
    // Coverage-preserving mip chain: plain box-filtered alpha erodes thin cutouts (bars,
    // grates, foliage) until they vanish a few metres away.
    tex.mipmaps = coverageMipmaps(src.rgba, src.width, src.height, CUTOUT_ALPHA_TEST);
    tex.generateMipmaps = false;
  } else {
    tex.generateMipmaps = true;
  }
  if (opts.lightmap) tex.channel = 1; // sample with geometry attribute "uv1" (from uvs2)
  tex.needsUpdate = true;
  return tex;
}

/** Animation frames as one array texture (all frames must share a size). */
export function toArrayTexture(frames: DecodedTexture[]): THREE.DataArrayTexture | null {
  if (!frames.length) return null;
  const { width: w, height: h } = frames[0];
  if (frames.some((f) => f.width !== w || f.height !== h)) return null;
  const data = new Uint8Array(w * h * 4 * frames.length);
  frames.forEach((f, i) => data.set(f.rgba, i * w * h * 4));
  const tex = new THREE.DataArrayTexture(data, w, h, frames.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

// ---------------------------------------------------------------------------
// Cache for systems that build object meshes outside the static level (doors, props...)

/**
 * Decodes textures straight from the packages and builds one shared material per distinct
 * surface. Usage, per ModelSubmesh `sm`: `mesh.material = cache.get(sm)`.
 */
export class SurfaceMaterialCache {
  private readonly decoded = new Map<string, DecodedTexture | null>();
  private readonly gpu = new Map<string, THREE.Texture | null>();
  private readonly materials = new Map<string, THREE.Material>();
  private missingTex: THREE.DataTexture | null = null;
  private readonly source: SurfaceTextureSource;

  constructor(
    private readonly packages: PackageSet,
    private readonly defaults: { vertexColors?: boolean; side?: THREE.Side } = {},
  ) {
    this.source = {
      texture: (key, cutout) => this.texture(key, cutout),
      frames: (keys) => {
        const id = `arr:${keys.join(',')}`;
        if (!this.gpu.has(id)) {
          const frames = keys.map((k) => this.decode(k));
          this.gpu.set(id, frames.every((f) => f) ? toArrayTexture(frames as DecodedTexture[]) : null);
        }
        return this.gpu.get(id) as THREE.DataArrayTexture | null;
      },
      missing: () => (this.missingTex ??= missingTexture()),
      hasAlpha: (key) => !!this.decode(key)?.hasAlpha,
    };
  }

  /** Material for a model submesh (shared between identical surfaces). */
  get(sm: { textureKey?: string; material?: SurfaceMaterial }, opts: { vertexColors?: boolean; side?: THREE.Side } = {}): THREE.Material {
    const vertexColors = opts.vertexColors ?? this.defaults.vertexColors ?? true;
    const side = opts.side ?? this.defaults.side ?? THREE.DoubleSide;
    const key = `${sm.textureKey ?? ''}|${materialSignature(sm.material)}|${vertexColors}|${side}`;
    let m = this.materials.get(key);
    if (!m) {
      m = createSurfaceMaterial({ material: sm.material, textureKey: sm.textureKey, vertexColors, side }, this.source).material;
      this.materials.set(key, m);
    }
    return m;
  }

  /** Decoded texture (stored row order), cached; null when missing. */
  decode(key: string): DecodedTexture | null {
    let t = this.decoded.get(key);
    if (t !== undefined) return t;
    const [pkg, id] = key.split(':').map(Number);
    const tdu = this.packages.get(pkg)?.tdu;
    const entry = findEntry(tdu, TDU_TEXTURE, id);
    t = tdu && entry ? decodeTexture(tdu, entry, { rowOrder: 'stored' }) : null;
    if (t) t = { ...t, key };
    this.decoded.set(key, t);
    return t;
  }

  texture(key: string, cutout = false): THREE.Texture | null {
    const id = `${cutout ? 'cut' : 'tx'}:${key}`;
    if (!this.gpu.has(id)) {
      const src = this.decode(key);
      this.gpu.set(id, src ? toDataTexture(src, { cutout }) : null);
    }
    return this.gpu.get(id)!;
  }

  dispose() {
    for (const t of this.gpu.values()) t?.dispose();
    for (const m of this.materials.values()) {
      const mark = glowMark(m);
      if (mark && ![...plainMarks.values()].includes(mark)) mark.dispose();
      m.dispose();
    }
    this.missingTex?.dispose();
    this.gpu.clear();
    this.materials.clear();
    this.decoded.clear();
  }
}

/** Magenta/black checker drawn where a texture key is missing. */
export function missingTexture(): THREE.DataTexture {
  const n = 8;
  const rgba = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const on = ((i % n) + Math.floor(i / n)) % 2 === 0;
    rgba.set(on ? [120, 20, 110, 255] : [20, 20, 20, 255], i * 4);
  }
  const tex = toDataTexture({ key: '__missing__', width: n, height: n, rgba, hasAlpha: false });
  tex.magFilter = THREE.NearestFilter;
  return tex;
}
