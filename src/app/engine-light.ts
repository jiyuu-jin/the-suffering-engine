// The Riot Engine's lighting equation (docs/game-logic.md §19), shared by every lit material.
//
// Per vertex, in "light units" where 2.0 is full texture brightness (xvsh/*.vsh, compiled
// copies in xvsh/ShaderLibrary.bin):
//
//   L  = 2 × baked vertex colour                          (precomputed: level, .ldu props)
//      | ambient (Ambient Light region / global) + Σ directional max(N·Ldir, 0) × colour
//   L += Σ point  colour × min(I / d², 2) × max(N·L̂, 0) × hemisphere test   (I = p8, m²)
//        (precomputed geometry: switchable lights only, the static ones are in its colours;
//        docs/re/renderer.md §1.6)
//   L += Σ spot   colour × (1 − l²/Lr²) × I·l²/r² × N·(−dir) × (l ≥ start)
//   oD0 = clamp(0.5 × min(L, 400/255), 0, 1)                (xvsLightFooter.vsh)
//   pixel = saturate(2 × texture × oD0)    (stage 0 MODULATE, stage 1 ADD CURRENT + CURRENT;
//                                           gamma space; render-data.ts WORLD_STAGE_GAIN)
//
// then linear vertex fog f = clamp((end − z) / (end − start)) blended towards the fog colour,
// all on gamma-encoded values (Direct3D 9 fixed function, no sRGB conversion, no tone map).
// The port evaluates L per vertex (a varying, like the original) and does the texture
// modulate and the fog in sRGB space so the output matches the engine's byte-for-byte maths.
//
// `?lighting=legacy` keeps the previous look (texture × vertex colour × 3 as emissive in linear
// space + three.js lights + ACES) for comparison.

import * as THREE from 'three/webgpu';
import {
  CULL_LUMA,
  LIGHT_RADIUS_CUTOFF,
  pointLightCullRadius,
  pointLightInfluence,
  RANK_LUMA,
  SHADER_LIGHTS,
  SHADER_POINT_LIGHTS,
  SHADOW_FACING_OFFSET,
  SHADOW_FACING_SCALE,
  SHADOW_RECEIVER_ALPHA,
  SHADOW_TEXTURE_SIZE,
  ShadowMode,
  WORLD_STAGE_GAIN,
  shadowLightDirection,
  spotConstants,
  type SpotProps,
} from '../formats/render-data';
import {
  Fn,
  Loop,
  clamp,
  float,
  int,
  materialColor,
  materialOpacity,
  materialReference,
  mix,
  normalWorld,
  output,
  positionView,
  positionWorld,
  renderGroup,
  sRGBTransferEOTF as srgbToLinearTsl,
  sRGBTransferOETF as linearToSrgbTsl,
  smoothstep,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';
import { ENHANCED } from './enhanced/config';
import { lampAxis } from './held-lamp';

// TSL node types are deeply generic; the helpers below pass nodes around untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
/** sRGB transfer functions (gamma ↔ linear), untyped for chaining. */
const toSrgb = (c: N): N => (linearToSrgbTsl as N)(c);
const toLinear = (c: N): N => (srgbToLinearTsl as N)(c);

/** `?lighting=legacy`: previous renderer look (for before/after comparisons). */
export const LEGACY_LIGHTING = typeof location !== 'undefined' && /(?:^|[?&])lighting=legacy(?:&|$)/.test(location.search);

/**
 * Point lights evaluated per frame (nearest to the camera, by the edge of their cull radius).
 * The engine gives each object ≤ 8 lights, ≤ 5 of them point lights (docs/re/renderer.md §1).
 */
export const MAX_POINTS = 32;
const MAX_SPOTS = 4;
/** Directional lights per frame: Directional Light base lights + rim lights (docs/re/renderer.md §1.4, §1.5; 8b has 14). */
const MAX_DIRS = 16;
const MAX_AMBIENT_BOXES = 8;
/**
 * Reach of a projected shadow, in caster radii: receivers fade from half of it to all of it
 * (the engine fades per receiving object over a reach it derives from the caster's size and the
 * level's shadow distance, 0x4ce583..0x4ce5ad; its units were not resolved) [port].
 */
const SHADOW_REACH = 4;
/**
 * Camera distance (m) up to which a caster's shadow is at full strength, and where it is gone:
 * Level Properties p14 / p15 (15 / 30 in every retail level), set through EXE interface slot
 * +0x18 (0x4084a0); the record's fade at +8 runs between them (0x4cf1e5..0x4cf231) [verified
 * fade; reading the values as metres is inferred].
 */
const SHADOW_NEAR = 15;
const SHADOW_FAR = 30;
/** c[82]: the summed light is clamped to 400/255 before halving. */
const LIGHT_CLAMP = 400 / 255;
/**
 * Point-light cull radius (SUFFERING.EXE 0x4c8650): a light is given to an object only while
 * the object is within sqrt(I × cullLuma(colour) / 0.1) of it ("Light Radius Cutoff
 * Factor" = 0.1, data at 0x5ba608). The shader itself has no cut-off. The engine decides per
 * object (an object touching the sphere is lit all over); per vertex, the port lights fully up
 * to the cull radius and fades out over the next CULL_FADE of it [port: stands in for the
 * object's extent].
 */
const CULL_FADE = 0.3;
const cullRadius = (intensity: number, r: number, g: number, b: number) => pointLightCullRadius(intensity, [r, g, b]);

// All light constants live in one vec4 array (one uniform buffer: WebGPU allows only 12 per
// shader stage, and skinned meshes already use several). Sections, in vec4s:
//   points  A = position.xyz, intensity I (p8); B = colour (light units, may be negative), hemisphere
//   spots   A = position, I (cone constant); B = unit direction, 1/range²; C = colour, start
//   dirs    A = unit vector towards the light, baked (flag 2); B = colour;
//           lo / hi = region AABB, lo.w exclusive (p8, flag 0x400), hi.w rim (flag 0x800);
//           uploaded smallest region first
//   ambient lo / hi = region AABB; colour, exclusive (p8); smallest first (dynamic objects only)
let at = 0;
const section = (n: number) => ((at += n), at - n);
const P_A = section(MAX_POINTS), P_B = section(MAX_POINTS);
const S_A = section(MAX_SPOTS), S_B = section(MAX_SPOTS), S_C = section(MAX_SPOTS);
const D_A = section(MAX_DIRS), D_B = section(MAX_DIRS), D_LO = section(MAX_DIRS), D_HI = section(MAX_DIRS);
const A_LO = section(MAX_AMBIENT_BOXES), A_HI = section(MAX_AMBIENT_BOXES), A_COL = section(MAX_AMBIENT_BOXES);
/** Projected character shadows (see "Shadows" below): light view-projection rows, caster info. */
const MAX_SHADOWS = 4;
// SH_M: light view-projection rows; SH_I: unit vector towards the shadow light, plane
// dot(dir, centre); SH_C: caster centre, reach; SH_F: camera-distance fade.
const SH_M = section(4 * MAX_SHADOWS), SH_I = section(MAX_SHADOWS), SH_C = section(MAX_SHADOWS), SH_F = section(MAX_SHADOWS);
const data = Array.from({ length: at }, () => new THREE.Vector4());
const view = (o: number, n: number) => data.slice(o, o + n);
const pointA = view(P_A, MAX_POINTS), pointB = view(P_B, MAX_POINTS);
const spotA = view(S_A, MAX_SPOTS), spotB = view(S_B, MAX_SPOTS), spotC = view(S_C, MAX_SPOTS);
const dirA = view(D_A, MAX_DIRS), dirB = view(D_B, MAX_DIRS), dirLo = view(D_LO, MAX_DIRS), dirHi = view(D_HI, MAX_DIRS);
const ambLo = view(A_LO, MAX_AMBIENT_BOXES), ambHi = view(A_HI, MAX_AMBIENT_BOXES), ambCol = view(A_COL, MAX_AMBIENT_BOXES);
// Shared by every draw of a render() call (renderGroup): in the default object group each
// mesh would carry, update and upload its own copy of the whole array every frame.
const lightData: N = uniformArray(data, 'vec4').setGroup(renderGroup);
const el = (o: number, i: N): N => lightData.element(i.add(o));

const u: Record<string, N> = {
  points: uniform(0, 'int'),
  /** The first `bakedPoints` point lights also light precomputed geometry (switchable ones). */
  bakedPoints: uniform(0, 'int'),
  spots: uniform(0, 'int'),
  dirs: uniform(0, 'int'),
  ambBoxes: uniform(0, 'int'),
  ambient: uniform(new THREE.Vector3(0.22, 0.22, 0.24)),
  fogNear: uniform(30),
  fogFar: uniform(50),
  fogColor: uniform(new THREE.Vector3(0, 0, 0)),
  shadows: uniform(0),
  shadowFlipY: uniform(0),
};
for (const k in u) u[k].setGroup(renderGroup);

// ---------------------------------------------------------------------------
// Shader side

/**
 * Σ of the first `count` point lights (xvsLightPoint / xvsLightPointHemiXtra). Precomputed
 * geometry takes only the switchable lights, uploaded first (u.bakedPoints): SUFFERING.EXE gives
 * an object with precomputed colours only lights with flag 2 (0x4ca730), the static ones are
 * in its colours (docs/re/renderer.md §1.6).
 */
// (A plain builder, called inside the Fn bodies below, so the count stays a JS choice.)
//
// The engine gives an object at most 5 point lights, the strongest at the object (0x4cff10,
// ranked by 0x4c7ed0: rankLuma × I / d² inside the cull radius). Level geometry here is merged
// into one mesh per material, so there is no object to rank at: each vertex keeps the 5
// strongest lights at itself instead [port approximation of the per-object choice]. Summing
// every light within reach (up to MAX_POINTS) clipped every channel of the 400/255 clamp in
// lamp-lit rooms (1a cell block: white light, the warm lamp colour lost).
function pointLights(P: N, Nrm: N, count: N): N {
  const keep = SHADER_POINT_LIGHTS;
  const slot = Array.from({ length: keep }, () => float(-1).toVar());
  const rank = Array.from({ length: keep }, () => float(0).toVar());
  Loop(count, ({ i }: { i: N }) => {
    const a = el(P_A, i);
    const b = el(P_B, i);
    const L = a.xyz.sub(P);
    const d2 = L.dot(L).max(1e-6);
    const I = a.w;
    // Within the cull radius (plus the fade margin of pointLight): I × luma33 / 0.1.
    const luma33 = b.x.mul(CULL_LUMA[0]).add(b.y.mul(CULL_LUMA[1])).add(b.z.mul(CULL_LUMA[2])).max(0);
    const reach2 = I.mul(luma33).div(LIGHT_RADIUS_CUTOFF).mul((1 + CULL_FADE) * (1 + CULL_FADE));
    const k = b.x.mul(RANK_LUMA[0]).add(b.y.mul(RANK_LUMA[1])).add(b.z.mul(RANK_LUMA[2])).mul(I).div(d2);
    // Not a candidate: -1 (never above an empty entry's 0).
    const ck = mix(float(-1), k, step(d2, reach2).mul(step(1e-9, k))).toVar();
    const ci = float(i).toVar();
    // Insert (ck, ci) into the sorted list, carrying the displaced entry down.
    for (let j = 0; j < keep; j++) {
      // (Snapshots: TSL expressions read variables where they are emitted, after the assigns.)
      const sw = step(rank[j], ck).mul(step(0, ck)).toVar();
      const ok = rank[j].toVar(), oi = slot[j].toVar();
      rank[j].assign(mix(ok, ck, sw));
      slot[j].assign(mix(oi, ci, sw));
      ck.assign(mix(ck, ok, sw));
      ci.assign(mix(ci, oi, sw));
    }
  });
  let acc: N = vec3(0);
  for (let j = 0; j < keep; j++) acc = acc.add(pointLight(P, Nrm, int(slot[j].max(0)), true).mul(step(0, slot[j])));
  return acc;
}

/**
 * One point light (slot `i`) at P (xvsLightPoint / xvsLightPointHemiXtra). `perVertexReach`:
 * fade it out past its cull radius per vertex (lights not chosen per object, see CULL_FADE).
 */
function pointLight(P: N, Nrm: N, i: N, perVertexReach: boolean): N {
  const a = el(P_A, i);
  const b = el(P_B, i);
  const L = a.xyz.sub(P).toVar();
  const d2 = L.dot(L).max(1e-6);
  const invD = d2.inverseSqrt();
  const ndl = Nrm.dot(L.mul(invD)).max(0);
  // xvsLightPoint.vsh: min(I / d², 2); I = p8 × 2048² in engine units, p8 in metres
  // (render-data.ts pointLightLevel).
  const I = a.w;
  const att = I.div(d2).min(2);
  // xvsLightPointHemiXtra.vsh: keep when (world up × hemi) · (light − vertex) ≥ 0.
  const hemi = step(0, L.y.mul(b.w));
  let k: N = att.mul(ndl).mul(hemi);
  if (perVertexReach) {
    const d = d2.mul(invD);
    // Cull radius sqrt(I × luma33 / 0.1) (render-data.ts pointLightCullRadius).
    const luma = b.x.mul(CULL_LUMA[0]).add(b.y.mul(CULL_LUMA[1])).add(b.z.mul(CULL_LUMA[2])).max(0);
    const Rc = I.mul(luma).div(LIGHT_RADIUS_CUTOFF).sqrt();
    k = k.mul(float(1).sub(smoothstep(Rc, Rc.mul(1 + CULL_FADE), d)));
  }
  return b.xyz.mul(k);
}

// Per-object light sets (dynamic objects drawn with `lightSet`: characters). SUFFERING.EXE gives
// each object its own light set, ranked by influence at the object (0x4ca730, 0x4c2f30), and the
// shader gets at most 8 of them, at most 5 point lights (0x4cff10); the object's ambient is the
// smallest Ambient Light region holding it (docs/re/renderer.md §1.3, §1.4). Summing every
// point light within reach per vertex instead (up to MAX_POINTS) saturates the 400/255 clamp
// in a lamp-lit room: every channel clips and characters turn pale and flat (1a cell block).
// The choice is made on the CPU per object and frame (objectLightSet) and handed to the shader
// as per-object uniforms: the slots of the chosen point lights (-1 = none) and the ambient.
const setOf = (o: THREE.Object3D | null) => (o ? engineLights.objectLightSet(o) : undefined);
const objectPoints: N = uniform(new THREE.Vector4(-1, -1, -1, -1)).onObjectUpdate(({ object }) => setOf(object)?.points);
const objectPoint5: N = uniform(-1).onObjectUpdate(({ object }) => setOf(object)?.point5);
const objectAmbient: N = uniform(new THREE.Vector3()).onObjectUpdate(({ object }) => setOf(object)?.ambient);
/** Bit i set: uploaded directional light i applies to the object (objectLightSet). */
const objectDirs: N = uniform(0).onObjectUpdate(({ object }) => setOf(object)?.dirs);

/** Σ of the object's chosen point lights (no per-vertex cut-off: the engine lights the whole object). */
function chosenPointLights(P: N, Nrm: N): N {
  let acc: N = vec3(0);
  for (const slot of [objectPoints.x, objectPoints.y, objectPoints.z, objectPoints.w, objectPoint5]) {
    acc = acc.add(pointLight(P, Nrm, int(slot.max(0)), false).mul(step(0, slot)));
  }
  return acc;
}

const spotLights = Fn(([P, Nrm]: N[]) => {
  const acc = vec3(0).toVar();
  Loop(u.spots, ({ i }: { i: N }) => {
    const a = el(S_A, i);
    const b = el(S_B, i);
    const c = el(S_C, i);
    // xvsLightSpot.vsh
    const delta = P.sub(a.xyz).toVar();
    const l = b.xyz.dot(delta).toVar();
    const fall = float(1).sub(b.w.mul(l).mul(l)).max(0);
    const perp = delta.sub(b.xyz.mul(l));
    const r2 = perp.dot(perp).max(1e-4);
    const cone = a.w.mul(l.mul(l)).div(r2);
    const facing = Nrm.dot(b.xyz.negate()).max(0);
    const started = step(c.w, l);
    acc.addAssign(c.xyz.mul(fall.mul(cone).mul(facing).mul(started).min(4)));
  });
  return acc;
});

/** Ambient of the object (objectLightSet) + its directional lights: dynamic objects with a light set. */
const objectBase = Fn(([P, Nrm]: N[]) => vec3(objectAmbient).add(directionalLights(P, Nrm, 'object')));

const insideBox = (P: N, lo: N, hi: N): N => step(lo.x, P.x).mul(step(P.x, hi.x)).mul(step(lo.y, P.y)).mul(step(P.y, hi.y)).mul(step(lo.z, P.z)).mul(step(P.z, hi.z));

const dynamicBase = Fn(([P, Nrm]: N[]) => {
  // Ambient (c[80], 0x4ca730): the Ambient Light regions holding the vertex, smallest first,
  // summed up to the first exclusive one (every retail one: the smallest wins); the level's
  // global ambient (root group, the largest region) when none was exclusive.
  const amb = vec3(0).toVar();
  const cut = float(0).toVar();
  Loop(u.ambBoxes, ({ i }: { i: N }) => {
    const c = el(A_COL, i);
    const k = insideBox(P, el(A_LO, i).xyz, el(A_HI, i).xyz).mul(float(1).sub(cut));
    amb.addAssign(c.xyz.mul(k));
    cut.assign(cut.max(k.mul(c.w)));
  });
  amb.addAssign(vec3(u.ambient).mul(float(1).sub(cut)));
  amb.addAssign(directionalLights(P, Nrm, 'vertex'));
  return amb;
});

/**
 * Σ colour × max(N·L, 0) of the directional lights that apply (xvsLightDir.vsh), by the rule of
 * the object gather 0x4ca730 (render-data.ts applicableDirectionals): the lights whose region
 * holds the point, in upload order (smallest region first), up to and including the first
 * exclusive one, plus the first rim light.
 * - 'vertex': the rule per vertex (dynamic objects without a light set);
 * - 'baked': objects with precomputed colours, which gather only lights with flag 2 (A.w = 1:
 *   switchable ones, never rim lights; 0x4ca730 with its last argument set);
 * - 'object': the object's own choice (objectLightSet, made on its bounds).
 */
// (A plain builder, called inside the Fn bodies below, so `mode` stays a JS choice.)
function directionalLights(P: N, Nrm: N, mode: 'vertex' | 'baked' | 'object'): N {
  const acc = vec3(0).toVar();
  const cut = float(0).toVar();
  const rimDone = float(0).toVar();
  const bits = mode === 'object' ? float(objectDirs).toVar() : null;
  Loop(u.dirs, ({ i }: { i: N }) => {
    const a = el(D_A, i);
    const contrib = el(D_B, i).xyz.mul(Nrm.dot(a.xyz).max(0));
    if (bits) {
      const bit = bits.mod(2);
      bits.assign(bits.sub(bit).mul(0.5));
      acc.addAssign(contrib.mul(bit));
      return;
    }
    const lo = el(D_LO, i);
    const hi = el(D_HI, i);
    let k: N = insideBox(P, lo.xyz, hi.xyz);
    if (mode === 'baked') k = k.mul(a.w);
    const rim = hi.w;
    acc.addAssign(contrib.mul(k.mul(mix(float(1).sub(cut), float(1).sub(rimDone), rim))));
    cut.assign(cut.max(k.mul(lo.w)));
    rimDone.assign(rimDone.max(k.mul(rim)));
  });
  return acc;
}

/** Start value of r2 for geometry with precomputed colours (xvsLightPrecomputed + xvsLightDir). */
const bakedBase = Fn(([P, Nrm]: N[]) => vec3(vertexColor()).mul(2).add(directionalLights(P, Nrm, 'baked')));

// Shadows (docs/re/renderer.md §4). The engine draws character shadows as projected textures:
// each caster is rendered along the direction of its shadow light (the first light of its light
// set, raised to at least 45°, 0x4cc020) into its own 256² texture (0x4cb600, 0x4ceea0, frame
// 0x4cd550), and the receiving geometry is drawn again with that texture projected on it, in
// black (record colour 0xff000000) whose alpha is 0.66 × a fall-off with the receiver's distance
// from the caster (0x4ce942), scaled by clamp((N·L + 0.3) / 0.7) and cut by three planes
// (xvsShadowBackfaceCull.vsh). The port folds the receiver pass into the engine-lit colour:
// up to MAX_SHADOWS silhouettes are sampled (bilinear) per fragment and darken it on gamma
// values.
const shadowTargets = Array.from({ length: MAX_SHADOWS }, () => {
  const rt = new THREE.RenderTarget(SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE, { depthBuffer: true });
  rt.texture.name = 'projected-shadow';
  return rt;
});
const shadowTextures: N[] = shadowTargets.map((rt) => texture(rt.texture));

const shadowTerm = Fn(([P, Nrm]: N[]) => {
  const P1 = vec4(P, 1);
  let s: N = float(0);
  for (let i = 0; i < MAX_SHADOWS; i++) {
    const row = (k: number): N => lightData.element(int(SH_M + 4 * i + k));
    // Orthographic light frame: w = 1.
    const nx = row(0).dot(P1), ny = row(1).dot(P1);
    const uvs = vec2(nx.mul(0.5).add(0.5), mix(ny.mul(0.5).add(0.5), ny.mul(-0.5).add(0.5), u.shadowFlipY)).clamp(0, 1);
    const inside = step(nx.abs(), 1).mul(step(ny.abs(), 1));
    const info = lightData.element(int(SH_I + i));
    const caster = lightData.element(int(SH_C + i));
    // c[56]: clamp((N·L + 0.3) / 0.7) with L the shadow light direction.
    const facing = clamp(Nrm.dot(info.xyz).add(SHADOW_FACING_OFFSET).mul(SHADOW_FACING_SCALE), 0, 1);
    // Plane: only what lies beyond the caster's centre (seen from the light) receives.
    const behind = step(P.dot(info.xyz), info.w);
    // 0.66 × (1 − t), t = (distance − reach / 2) / (reach / 2) (render-data.ts
    // shadowReceiverAlpha; per fragment here, so the engine's full-strength case for receivers
    // centred within half the reach is not used: it would draw a hard ring).
    const half = caster.w.mul(0.5).max(1e-3);
    const fall = clamp(float(2).sub(P.sub(caster.xyz).length().div(half)), 0, 1);
    const active = step(i + 0.5, u.shadows);
    const a = shadowTextures[i].sample(uvs).r.mul(inside).mul(behind).mul(facing).mul(fall).mul(lightData.element(int(SH_F + i)).x);
    s = s.max(a.mul(active));
  }
  return s.mul(SHADOW_RECEIVER_ALPHA);
});

/**
 * Engine-lit colour (linear, for a NodeMaterial colorNode with `lights = false`) of a surface
 * whose texture colour (linear) is `tex`. `precomputed`: the mesh has baked vertex colours
 * (level geometry, .ldu props); otherwise ambient + directional lights stand in for them.
 */
export function engineLitColor(tex: N, opts: EngineLightOptions): N {
  const lit = engineStages(engineAlbedo(toSrgb(vec3(tex))).mul(engineLightFactor(opts)));
  // Characters (light-set objects) are casters, not receivers: the receiver pass redraws the
  // scene geometry under a caster's shadow (0x4ce1a0), and a character receiving its own
  // silhouette darkened its legs and lap in patches [inferred: no self-shadowing in the
  // original's cinematics].
  if (enhancedShading.finish) return enhancedShading.finish(toLinear(lit), opts);
  return toLinear(opts.lightSet ? lit : lit.mul(engineShadowFactor()));
}

/**
 * Final colour (linear) of a lit surface pass stack (surface-material.ts): the projected-shadow
 * receiver pass darkens it on gamma values; Enhanced mode adds its specular / shadow terms.
 * Light-set objects (skinned models) are casters, not receivers, as in engineLitColor.
 */
export function engineSurfaceFinish(rgb: N, opts: EngineLightOptions): N {
  if (enhancedShading.finish) return enhancedShading.finish(rgb, opts);
  if (opts.lightSet && !opts.precomputed) return rgb;
  return toLinear(toSrgb(rgb).mul(engineShadowFactor()));
}

/**
 * Enhanced graphics mode hooks, installed by src/app/enhanced/shading.ts before any material is
 * built (docs/enhanced.md). Unset in Original mode, where every function here builds exactly the
 * faithful graph.
 */
export const enhancedShading: {
  /** Per-pixel light factor (gamma, ≥ 0, may exceed 1) from the vertex light L (light units). */
  lightFactor?(L: N, opts: EngineLightOptions): N;
  /** Final linear colour of a lit surface from its engine-lit colour (linear). */
  finish?(rgb: N, opts: EngineLightOptions): N;
  /** Fogged output (linear) from the material output, the fog amount and the fog colour (gamma). */
  fog?(out: N, f: N, fogColor: N): N;
  /**
   * Per-surface nodes (normal, roughness, specular) from a surface's generated maps, sampled by
   * `sample(texture)` at the surface's base-layer coordinates `coords` (surface-material.ts
   * enhancedMaps).
   */
  surface?(maps: EnhancedMaps, sample: (t: THREE.Texture) => N, coords: N): unknown;
  /** Albedo (gamma) of a lit pass's texture colour (gamma): white is not a light source. */
  albedo?(g: N): N;
  /** Colour (linear) of a glow-marked surface (scene-glow.ts marks): an emitter in the HDR frame. */
  glow?(rgb: N): N;
  /** Textures every lit Enhanced graph samples in its fragment stage (its shadow maps). */
  textures?: number;
} = {};

/**
 * Sampled textures a fragment shader may bind: WebGPU's default maxSampledTexturesPerShaderStage
 * (three.js requests no higher limit, and many adapters have no more). A pipeline over it fails
 * to build and its objects are not drawn.
 */
export const MAX_FRAGMENT_TEXTURES = 16;
/** Textures of the projected character shadows that every lit, non-light-set surface samples. */
export const ENGINE_SHADOW_TEXTURES = MAX_SHADOWS;

/**
 * Fragment textures a surface's Enhanced maps add: one per distinct map texture, plus the
 * surface hook's own (`detail`).
 */
export function enhancedMapsTextures(m: EnhancedMaps | undefined): number {
  if (!m) return 0;
  return new Set([m.normal, m.roughness, m.specular].filter(Boolean)).size + (m.detail ?? 0);
}

/**
 * The maps that fit in `room` fragment textures, dropping by priority: the detail maps first,
 * then the roughness / specular map, then the normal map (undefined when none fits).
 */
export function fitEnhancedMaps(m: EnhancedMaps | undefined, room: number): EnhancedMaps | undefined {
  if (!m) return undefined;
  const steps: EnhancedMaps[] = [m, { ...m, detail: 0 }, { normal: m.normal, normalScale: m.normalScale }, {}];
  for (const c of steps) if (enhancedMapsTextures(c) <= room && (c.normal || c.roughness || c.specular)) return c;
  return undefined;
}

/**
 * The texture colour (gamma) a lit pass multiplies by its light: the colour itself, or in
 * Enhanced mode its albedo (enhancedShading.albedo).
 */
export function engineAlbedo(g: N): N {
  return enhancedShading.albedo ? enhancedShading.albedo(g) : g;
}

/**
 * Generated per-texture maps for Enhanced mode (docs/enhanced.md "Extension points"): a
 * tangent-space normal map (OpenGL convention, +Y up), a roughness map (R) and a specular /
 * cavity map (R). All optional; ignored in Original mode.
 */
export interface EnhancedMaps {
  normal?: THREE.Texture;
  roughness?: THREE.Texture;
  specular?: THREE.Texture;
  /** Normal map strength (default 1). */
  normalScale?: number;
  /**
   * Extra textures the installed surface hook samples with these maps (the generated cache's CC0
   * detail maps: 2); 0 or unset tells the hook to leave them out.
   */
  detail?: number;
}

/** Uniforms and light arrays the Enhanced mode reads (src/app/enhanced/*). */
export function engineLightInternals() {
  return { u, lightData, data, pointA, pointB, spotA, spotB, spotC, dirA, dirB, MAX_POINTS, P_A, P_B };
}

/**
 * The vertex lighting oD0 (gamma, 0..1) that texture stage 0 multiplies an untinted pass by
 * (D3DTOP_MODULATE with COLORARG2 = DIFFUSE). A tinted pass uses the halved tint instead
 * (TFACTOR, docs/re/renderer.md §3.5). Call once per material.
 */
export function engineLightFactor(opts: EngineLightOptions): N {
  const P = positionWorld;
  const Nrm = normalWorld;
  const set = !opts.precomputed && !!opts.lightSet;
  const base = opts.precomputed ? bakedBase(P, Nrm) : set ? objectBase(P, Nrm) : dynamicBase(P, Nrm);
  const points = Fn(() => (set ? chosenPointLights(P, Nrm) : pointLights(P, Nrm, opts.precomputed ? u.bakedPoints : u.points)))();
  const light: N = varying(base.add(points).add(spotLights(P, Nrm)), 'v_engineLight');
  // Enhanced mode (docs/enhanced.md): per-pixel factor with the flashlight, lamp shadows, HDR.
  if (enhancedShading.lightFactor) return enhancedShading.lightFactor(light, opts);
  return clamp(light.min(LIGHT_CLAMP).mul(0.5), 0, 1);
}

/**
 * Options of an engine-lit material. `precomputed`: the mesh has baked vertex colours (level
 * geometry, .ldu props). `lightSet`: a dynamic object lit like the engine's objects, by its own
 * ranked light set (≤ 5 point lights, its own ambient region) instead of every light within
 * reach per vertex; meant for compact objects (characters), not for meshes spread over a level.
 */
export interface EngineLightOptions {
  precomputed: boolean;
  lightSet?: boolean;
  /** Enhanced mode only: per-surface nodes from generated maps (enhancedShading.surface). */
  surface?: unknown;
}

/** Gamma factor of the projected-shadow receiver pass (alpha-blended darkening). */
export function engineShadowFactor(): N {
  return float(1).sub(shadowTerm(positionWorld, normalWorld));
}

/**
 * The texture stages' output of a world pass from its stage-0 colour (gamma): stage 1 adds the
 * current colour to itself, saturated (render-data.ts WORLD_STAGE_GAIN, 0x48c4d7).
 */
export function engineStages(stage0: N): N {
  return stage0.mul(WORLD_STAGE_GAIN).min(STAGE_MAX);
}

/** Saturation of a pass (1, the back buffer's); Enhanced keeps HDR headroom for bloom. */
const STAGE_MAX = ENHANCED ? 16 : 1;

/** Gamma-encode / decode helpers for materials composing engine passes. */
export const gammaEncode = toSrgb;
export const gammaDecode = toLinear;

/**
 * Set an already engine-shaded colour (linear) on a NodeMaterial: three.js lighting off, vertex
 * colours read by the lighting nodes themselves.
 */
export function applyEngineColor<M extends THREE.NodeMaterial>(m: M, rgb: N, alpha: N): M {
  m.colorNode = vec4(rgb, alpha);
  m.lights = false;
  (m as THREE.Material & { vertexColors: boolean }).vertexColors = false;
  m.userData.engineLit = true;
  return m;
}

/**
 * Turn a lit NodeMaterial into an engine-lit one: `colorNode` = engine colour + alpha, three.js
 * lighting off (outgoing light = diffuse colour), vertex colours read by the equation itself.
 */
export function applyEngineLighting<M extends THREE.NodeMaterial>(m: M, tex: N, alpha: N, opts: EngineLightOptions & { emissive?: N }): M {
  let rgb = engineLitColor(tex, opts);
  if (opts.emissive) rgb = rgb.add(opts.emissive);
  m.colorNode = vec4(rgb, alpha);
  m.lights = false;
  (m as THREE.Material & { vertexColors: boolean }).vertexColors = false;
  m.userData.engineLit = true;
  return m;
}

/**
 * Engine-light a standard material from its own `map` × `color` (characters, held weapons,
 * props). No-op with `?lighting=legacy`.
 */
export function engineLightMaterial<M extends THREE.NodeMaterial>(m: M, opts: EngineLightOptions & { emissive?: N; enhancedMaps?: EnhancedMaps }): M {
  if (LEGACY_LIGHTING) return m;
  const c: N = materialColor;
  if (opts.emissive) return applyEngineLighting(m, c.rgb, c.a.mul(materialOpacity), opts);
  // One colour node per lighting kind, shared by every material: three.js keys a material's
  // shader by the ids of its nodes, so a graph of its own made each character / prop / held-item
  // material build the same shader again (docs/game-logic.md §18.8). The texture and colour come
  // from the material being drawn (materialColor reads its current `map` and `color`).
  // Enhanced mode: `enhancedMaps` gives the layout of generated maps (normal; roughness /
  // specular), which the graph samples from the drawn material's `enhancedMapTextures` (set by
  // the texture enhancement, neutral stand-ins where it has none): still one graph per layout.
  const maps = enhancedShading.surface && opts.enhancedMaps && (opts.enhancedMaps.normal || opts.enhancedMaps.roughness || opts.enhancedMaps.specular) ? opts.enhancedMaps : undefined;
  const surf = maps && (maps.roughness ?? maps.specular);
  const key = `${opts.precomputed ? 1 : 0}${opts.lightSet ? 1 : 0}${maps ? `|m${maps.normal ? 'n' : ''}${surf ? 's' : ''}` : ''}`;
  let node = sharedEngineColor.get(key);
  if (!node) {
    let o: EngineLightOptions = opts;
    if (maps) {
      const layout: EnhancedMaps = { normal: maps.normal, roughness: surf, specular: surf, normalScale: maps.normalScale };
      const ref = (t: THREE.Texture): N => materialReference(`enhancedMapTextures.${t === maps.normal ? 'normal' : 'surface'}`, 'texture');
      o = { ...opts, surface: enhancedShading.surface!(layout, ref, uv()) };
    }
    sharedEngineColor.set(key, (node = vec4(engineLitColor(c.rgb, o), c.a.mul(materialOpacity))));
  }
  m.colorNode = node;
  m.lights = false;
  (m as THREE.Material & { vertexColors: boolean }).vertexColors = false;
  m.userData.engineLit = true;
  return m;
}
const sharedEngineColor = new Map<string, N>();

/** Fog amount at this fragment: 0 before the fog start, 1 at its end (view depth, linear). */
export const engineFogFactor: N = clamp(positionView.z.negate().sub(u.fogNear).div(u.fogFar.sub(u.fogNear).max(1e-3)), 0, 1);

/** Gamma-space linear fog (xvsHeaderFog.vsh: oFog = 1 − (z − start) / (end − start)). */
export const engineFogNode: N = ENHANCED
  ? Fn(() => enhancedShading.fog!(output, engineFogFactor, u.fogColor))()
  : Fn(() => {
      const rgb = toLinear(mix(toSrgb(output.rgb), vec3(u.fogColor), engineFogFactor));
      return vec4(rgb, output.a);
    })();

/**
 * The back buffer holds gamma values, as the engine's did (docs/re/renderer.md §5.1).
 * Direct3D 9 blends every pass on the bytes in an 8-bit back buffer, gamma-encoded, with no sRGB
 * conversion anywhere, saturating after each blend (render-data.ts backBufferBlend). three.js
 * normally blends in a linear half-float target and converts once at the end, which made every
 * blended pass wrong over anything but black: an additive glow over a mid-grey wall rose by a
 * quarter of what the engine adds (Hermes behind the gas-chamber glass all but vanished), alpha
 * blends and the modulate-2x detail passes mixed the wrong values. So, unless `?lighting=legacy`:
 *
 *   - every material encodes its own output to gamma (`backBufferOutput`, installed as the
 *     renderer's `contextNode.getOutput`, after fog), so blending runs on gamma values;
 *   - the frame target is 8-bit (BACK_BUFFER_TYPE), saturating like the engine's;
 *   - the output pass copies it unchanged (no colour-space conversion; LinearToneMapping at
 *     exposure 1 is a saturate) (renderer.ts).
 *
 * Shaders that write the frame themselves (`fragmentNode` quads: the screen effects) and
 * anything sampling the frame (the monitor warp card) work on gamma values directly.
 */
export const GAMMA_BACK_BUFFER = !LEGACY_LIGHTING && !ENHANCED;

/** Colour buffer type of the frame target (and of targets that share its passes). */
export const BACK_BUFFER_TYPE: THREE.TextureDataType = GAMMA_BACK_BUFFER ? THREE.UnsignedByteType : THREE.HalfFloatType;

/** Material output hook: linear colour to the gamma value the back buffer blends (see above). */
export function backBufferOutput(node: N): N {
  return vec4(toSrgb(vec3(node.rgb).max(0)), node.a);
}

/**
 * Colour to add (linear, premultiplied: draw with blend ONE, ONE, or reverse-subtract for
 * blend 4) for an engine additive (blend 2) or subtractive (blend 4) pass whose texture × tint
 * is `rgb` (linear) with alpha `a`.
 *
 * The engine adds (or takes away) src × alpha on the gamma back buffer and, for these modes,
 * sets the fog colour to black so the effect fades out with distance instead of turning
 * fog-coloured [verified: blend-state switch 0x49a990, §16]. The result is linear so that the
 * output hook (backBufferOutput) turns it into exactly the gamma src × alpha × (1 − fog), which
 * the blend then adds to the gamma back buffer as the engine does [exact with GAMMA_BACK_BUFFER].
 */
export function additiveEffectColor(rgb: N, a: N, opts: { fog?: boolean } = {}): N {
  let s: N = toSrgb(vec3(rgb)).mul(a);
  if (opts.fog !== false) s = s.mul(float(1).sub(engineFogFactor));
  // Enhanced: fire, sparks and arcs keep HDR headroom so they bloom (docs/enhanced.md).
  if (ENHANCED) return toLinear(s.clamp(0, 1)).mul(ADDITIVE_HDR);
  return toLinear(s.clamp(0, 1));
}
/** Enhanced: gain of additive effects in the HDR frame. */
const ADDITIVE_HDR = 1.6;

// ---------------------------------------------------------------------------
// CPU side

/**
 * Linear fog parameters (Sky Properties: end = p2 m, start = p3 × p2, colour p4). It is a
 * FogExp2 for the zone culler and older callers: `density` maps to 2.5 / far, which is
 * where the culler stops drawing (fully fogged).
 */
export class EngineFog extends THREE.FogExp2 {
  near!: number;
  far!: number;
  constructor(color: THREE.ColorRepresentation, near: number, far: number) {
    super(color, 2.5 / far);
    this.near = near;
    this.far = far;
  }
  // @ts-expect-error accessor over the base class field
  get density(): number {
    return 2.5 / Math.max(this.far ?? 50, 1e-3);
  }
  set density(v: number) {
    if (this.far === undefined) return; // base constructor
    const far = 2.5 / Math.max(v, 1e-6);
    this.near = far * (this.near / Math.max(this.far, 1e-3));
    this.far = far;
  }
}

/** A light the rig evaluates: engine colour units (bytes / 255, sign = negative light). */
export interface EnginePointLight {
  x: number;
  y: number;
  z: number;
  /** Strength I: Point Light p8 (m²); the level at d metres is min(I / d², 2). */
  intensity: number;
  r: number;
  g: number;
  b: number;
  /** 0 omni, +1 lights only below it, −1 only above (Point Light p9 = 2 / 1). */
  hemi: number;
  /**
   * Also lights geometry with precomputed colours: a switchable Point Light (flag 2) or an
   * effect light. Static Point Lights (false) light only dynamic objects at run time; they
   * are in the precomputed colours. Default true.
   */
  baked?: boolean;
}

/** An Ambient Light region (its parent group's box, docs/re/renderer.md §1.4). */
export interface AmbientBox {
  min: THREE.Vector3;
  max: THREE.Vector3;
  color: THREE.Color;
  /** p8 (flag 0x400): hides the larger regions; default true (every retail Ambient Light). */
  exclusive?: boolean;
}

/** A spot light: colour and Spot Light p8 start / p9 length / p10 cone radius (metres). */
export interface SpotDef extends SpotProps {
  color: number;
}

/** A world Spot Light this frame: position, unit beam direction, its p0 colour and p8..p10; sign -1 for p1. */
export interface EngineSpot {
  pos: THREE.Vector3Like;
  dir: THREE.Vector3Like;
  def: SpotDef;
  sign?: number;
}

/** Flashlight: Spot Light templates 4:123 (beam) and 4:669 (spill) of the Flashlight item. */
export const FLASHLIGHT_SPOTS: SpotDef[] = [
  { color: 0xc8c4ac, start: 1, length: 6, radius: 10 },
  { color: 0x35311c, start: 1, length: 4, radius: 5 },
];
/** SpotLight.intensity the renderer's flashlight uses at full charge. */
export const FLASHLIGHT_BASE_INTENSITY = 6;

const raw = (c: THREE.Color, out: THREE.Color) => c.getRGB(out as unknown as THREE.RGB, THREE.SRGBColorSpace);

class EngineLightRig {
  /** World light providers (Point Lights of the level, pooled effect lights...). */
  private providers = new Set<(out: EnginePointLight[]) => void>();
  private cand: EnginePointLight[] = [];
  private fxLights: THREE.PointLight[] = [];
  private scanAt = -1;
  private rims = new Set<EngineDirectional>();
  private dirList: EngineDirectional[] = [];
  private readonly t = { v: new THREE.Vector3(), d: new THREE.Vector3(), c: new THREE.Color(), q: new THREE.Quaternion() };
  /** Flashlight spot definitions (beam + spill). */
  flashlight = FLASHLIGHT_SPOTS;
  /** Enhanced mode lights the flashlight per pixel (src/app/enhanced/shading.ts): not a rig spot. */
  perPixelFlashlight = false;
  /** Directional lights uploaded this frame (Enhanced: the moonlight shafts). */
  get directionals(): readonly EngineDirectional[] {
    return this.dirList;
  }
  stats = { points: 0, bakedPoints: 0, candidates: 0, spots: 0, fx: 0, shadows: 0 };
  /**
   * Graphics "Shadows" option as the engine stores it (0x5c6d00: 0 off, 1 player only,
   * 3 all characters; src/app/menu/graphics.ts sets it, its default is all characters).
   */
  shadowMode: ShadowMode = ShadowMode.All;
  /** Characters that may cast a shadow this frame (the fx system registers the actors). */
  shadowCasters: (() => ShadowCaster[]) | null = null;
  private readonly silhouette = (() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    m.colorNode = vec4(1, 1, 1, 1);
    m.fog = false;
    m.name = 'shadow-silhouette';
    return m;
  })();
  /**
   * Silhouettes of cut-out materials (foliage, grates): the caster's texture alpha with its
   * alpha test, so only the drawn texels cast. A plain white silhouette would make every
   * cut-out card cast its whole quad: the dark polygons around the swaying bushes of 4b
   * (Animating Statics are casters).
   */
  private readonly cutSilhouettes = new Map<string, THREE.Material>();
  private silhouetteOf(m: THREE.Material): THREE.Material {
    // Surface materials keep their textures in `surfaceSlots` (surface-material.ts); the first is
    // the first pass's, whose alpha the cut-out test reads.
    const map =
      (m as THREE.MeshStandardMaterial).map ??
      (m as { surfaceSlots?: { t: THREE.Texture[] } }).surfaceSlots?.t[0];
    if (!map || !(m.alphaTest > 0)) return this.silhouette;
    const k = `${map.uuid}|${m.alphaTest}`;
    let s = this.cutSilhouettes.get(k);
    if (!s) {
      const b = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      b.colorNode = vec4(1, 1, 1, texture(map, uv()).a);
      b.alphaTest = m.alphaTest;
      b.fog = false;
      b.name = 'shadow-silhouette-cut';
      this.cutSilhouettes.set(k, (s = b));
    }
    return s;
  }
  private readonly shadowCams = Array.from({ length: MAX_SHADOWS }, () => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10));
  /**
   * Compile the silhouette pass of these characters (hidden or not) into a shadow target ahead
   * of play (the fx system calls it from the level's pipeline precompile, src/app/prewarm.ts):
   * a character's first shadow otherwise built its pipelines in that frame, and the GPU stalled
   * ~350 ms on them (docs/game-logic.md §18). Performance only; renders nothing.
   */
  precompileShadows(renderer: THREE.WebGPURenderer, roots: THREE.Object3D[]): Promise<void>[] {
    const out: Promise<void>[] = [];
    const cam = this.shadowCams[0];
    const prev = renderer.getRenderTarget();
    for (const root of roots) {
      const saved: [THREE.Object3D, boolean, boolean, number, THREE.Material | THREE.Material[] | undefined][] = [];
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        saved.push([o, o.visible, o.frustumCulled, o.layers.mask, mesh.isMesh ? mesh.material : undefined]);
        o.frustumCulled = false;
        o.layers.mask |= cam.layers.mask;
        if (mesh.isMesh) {
          o.visible = true;
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.silhouetteOf(m)) : this.silhouetteOf(mesh.material);
        } else if ((o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) o.visible = false;
        else o.visible = true;
      });
      try {
        renderer.setRenderTarget(shadowTargets[0]);
        out.push(renderer.compileAsync(root, cam));
      } finally {
        for (const [o, v, f, l, m] of saved) {
          o.visible = v;
          o.frustumCulled = f;
          o.layers.mask = l;
          if (m) (o as THREE.Mesh).material = m;
        }
      }
    }
    renderer.setRenderTarget(prev);
    return out;
  }
  private readonly shadowScratch ={ list: [] as { c: ShadowCaster; d: number; dir: THREE.Vector3; fade: number }[], swapped: [] as [THREE.Mesh, THREE.Material | THREE.Material[]][], hidden: [] as THREE.Object3D[] };
  /** Frame counter (update()): per-object light sets are chosen once per frame. */
  private frame = 0;
  /** Ambient Light boxes, smallest first (setAmbient). */
  private ambientBoxes: AmbientBox[] = [];
  private readonly sets = new WeakMap<THREE.Object3D, ObjectLightSet>();
  private readonly rank: { slot: number; influence: number }[] = [];
  private readonly sphere = new THREE.Sphere();

  /**
   * The light set of a dynamic object this frame (SUFFERING.EXE 0x4ca730 / 0x4c2f30 / 0x4cff10):
   * its point lights ranked by influence at its bounding-sphere centre (rankLuma × I / d² within
   * the cull radius, render-data.ts pointLightInfluence), keeping at most 5 and at most 8 lights
   * with the directional lights and spots that apply. Ambient and directional lights are those
   * whose region overlaps its bounds, by the rule of 0x4ca730 (render-data.ts applicableRegions /
   * applicableDirectionals): smallest region first, cut after the first exclusive one, plus the
   * first rim light; no exclusive ambient adds the level's global one (docs/re/renderer.md §1.3,
   * §1.4). Slots refer to this frame's uploaded lights.
   */
  objectLightSet(o: THREE.Object3D): ObjectLightSet {
    let set = this.sets.get(o);
    if (!set) this.sets.set(o, (set = { frame: -1, points: new THREE.Vector4(-1, -1, -1, -1), point5: -1, ambient: new THREE.Vector3(), dirs: 0, centre: new THREE.Vector3(), radius: 0 }));
    if (set.frame === this.frame) return set;
    set.frame = this.frame;
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g && !g.boundingSphere) g.computeBoundingSphere();
    const sp = this.sphere;
    if (g?.boundingSphere) sp.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    else sp.set(o.getWorldPosition(set.centre), 0.5);
    set.centre.copy(sp.center);
    set.radius = sp.radius;
    const c = sp.center;
    const r2 = sp.radius * sp.radius;
    // The query box is the object's bounds (0x4ca7e6): a region applies when it overlaps them.
    const overlaps = (lo: { x: number; y: number; z: number }, hi: { x: number; y: number; z: number }) => {
      const dx = Math.max(lo.x - c.x, 0, c.x - hi.x), dy = Math.max(lo.y - c.y, 0, c.y - hi.y), dz = Math.max(lo.z - c.z, 0, c.z - hi.z);
      return dx * dx + dy * dy + dz * dz <= r2;
    };
    // Ambient: the regions (smallest first) up to the first exclusive one, else + the global.
    set.ambient.set(0, 0, 0);
    let cut = false;
    for (const b of this.ambientBoxes) {
      if (!overlaps(b.min, b.max)) continue;
      set.ambient.x += b.color.r;
      set.ambient.y += b.color.g;
      set.ambient.z += b.color.b;
      if (b.exclusive !== false) {
        cut = true;
        break;
      }
    }
    if (!cut) set.ambient.add(u.ambient.value);
    // Directional lights (uploaded smallest region first): the same rule as the shader's
    // per-vertex loop, on the object's bounds; the shader reads the chosen ones as bits.
    let others = u.spots.value as number;
    let dirs = 0, rimDone = false;
    cut = false;
    for (let i = 0; i < (u.dirs.value as number); i++) {
      if (!overlaps(dirLo[i], dirHi[i])) continue;
      const rim = dirHi[i].w > 0;
      if (rim ? rimDone : cut) continue;
      if (rim) rimDone = true;
      else if (dirLo[i].w > 0) cut = true;
      dirs += 2 ** i;
      others++;
    }
    set.dirs = dirs;
    const budget = Math.max(0, Math.min(SHADER_POINT_LIGHTS, SHADER_LIGHTS - others));
    const n = u.points.value as number;
    // (Allocation-free, docs/perf.md: one light set per drawn dynamic object and frame. The
    // lights' cull radii are this frame's, computed once; the best `budget` lights are kept by
    // insertion, after any of equal influence: the order of the stable sort it replaced.)
    const rgb = this.rgb3, cullR = this.lightCullRadii(n);
    const topSlot = this.topSlot, topK = this.topK;
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const a = pointA[i], b = pointB[i];
      rgb[0] = b.x;
      rgb[1] = b.y;
      rgb[2] = b.z;
      const d2 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2 + (a.z - c.z) ** 2;
      // The object is given the light while its bounds touch the light's sphere (0x4c8ea0).
      const influence = pointLightInfluence(a.w, rgb, d2, cullR[i] + sp.radius);
      if (!(influence > 0) || budget === 0) continue;
      let at = kept;
      while (at > 0 && topK[at - 1] < influence) at--;
      if (at >= budget) continue;
      for (let j = Math.min(kept, budget - 1); j > at; j--) (topK[j] = topK[j - 1]), (topSlot[j] = topSlot[j - 1]);
      topK[at] = influence;
      topSlot[at] = i;
      if (kept < budget) kept++;
    }
    const pick = (k: number) => (k < kept ? topSlot[k] : -1);
    set.points.set(pick(0), pick(1), pick(2), pick(3));
    set.point5 = pick(4);
    return set;
  }
  private readonly rgb3 = [0, 0, 0];
  private readonly topSlot = new Int32Array(8);
  private readonly topK = new Float64Array(8);
  private readonly cullRadii = new Float64Array(64);
  private cullRadiiVersion = -1;
  /** Uploads of the point lights (update): the cull radii below are recomputed after each. */
  private pointsVersion = 0;
  /** pointLightCullRadius of each uploaded point light, once per upload. */
  private lightCullRadii(n: number): Float64Array {
    if (this.cullRadiiVersion !== this.pointsVersion) {
      this.cullRadiiVersion = this.pointsVersion;
      const rgb = this.rgb3;
      for (let i = 0; i < n && i < this.cullRadii.length; i++) {
        const b = pointB[i];
        rgb[0] = b.x;
        rgb[1] = b.y;
        rgb[2] = b.z;
        this.cullRadii[i] = pointLightCullRadius(pointA[i].w, rgb);
      }
    }
    return this.cullRadii;
  }

  /**
   * Light colour a lit particle system (Particle Fountain p46 = 3) takes at its position this
   * frame [verified: Suffering.rfl 0x10119e30, called from the emitter think 0x1011b087, with the
   * light set calls of SUFFERING.EXE 0x595420]: the system object sets flag +0xc bit 13 (the
   * gather skips the sector-group test), gathers its light set (0x4ca730), then sums
   *   ambient slots (set vt+4, 0x4c2ba0)
   *   + the first directional entry (vt+0xc, 0x4c2390)
   *   + the full colour (light +0x10, bytes / 255) of every other non-directional entry,
   * with no distance or angle term, and clamps each channel to 0..1 (0x10119860). Entries are
   * the lights whose cull sphere touches the object (point lights, render-data.ts
   * pointLightCullRadius; spots by their range), at most 12 slots ranked by influence (0x4c2f30).
   * [inferred: the system is not a dynamic object, so rim lights are not in its set (0x4cab22)
   * and the first directional is the base light of the smallest region holding the point.]
   */
  particleLight(p: THREE.Vector3Like, out: THREE.Color): THREE.Color {
    const inBox = (lo: THREE.Vector3Like, hi: THREE.Vector3Like) => p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y && p.z >= lo.z && p.z <= hi.z;
    let r = 0, g = 0, b = 0;
    let cut = false;
    for (const box of this.ambientBoxes) {
      if (!inBox(box.min, box.max)) continue;
      r += box.color.r;
      g += box.color.g;
      b += box.color.b;
      if (box.exclusive !== false) {
        cut = true;
        break;
      }
    }
    if (!cut) {
      const a = u.ambient.value as THREE.Vector3;
      r += a.x;
      g += a.y;
      b += a.z;
    }
    let dirs = 0;
    for (const d of this.dirList) {
      if (d.rim || (d.box && !inBox(d.box.min, d.box.max))) continue;
      if (!dirs) (r += d.color.r), (g += d.color.g), (b += d.color.b);
      dirs++;
      if (d.exclusive) break;
    }
    const rank = this.rank;
    rank.length = 0;
    const n = u.points.value as number;
    for (let i = 0; i < n; i++) {
      const A = pointA[i], B = pointB[i];
      const d2 = (A.x - p.x) ** 2 + (A.y - p.y) ** 2 + (A.z - p.z) ** 2;
      const k = pointLightInfluence(A.w, [B.x, B.y, B.z], d2);
      if (k > 0) rank.push({ slot: i, influence: k });
    }
    rank.sort((x, y) => y.influence - x.influence);
    const room = Math.max(0, 12 - dirs);
    for (let k = 0; k < rank.length && k < room; k++) {
      const B = pointB[rank[k].slot];
      r += B.x;
      g += B.y;
      b += B.z;
    }
    const ns = u.spots.value as number;
    for (let i = 0, k = Math.min(rank.length, room); i < ns && k < room; i++) {
      const A = spotA[i], B = spotB[i], C = spotC[i];
      const range = B.w > 0 ? 1 / Math.sqrt(B.w) : 0;
      if ((A.x - p.x) ** 2 + (A.y - p.y) ** 2 + (A.z - p.z) ** 2 > range * range) continue;
      r += C.x;
      g += C.y;
      b += C.z;
      k++;
    }
    const c01 = (x: number) => Math.min(1, Math.max(0, x));
    return out.setRGB(c01(r), c01(g), c01(b), THREE.LinearSRGBColorSpace);
  }

  /**
   * A caster's shadow light this frame (0x4cc020): the first light of its light set that has a
   * position, skipping lights with flag 0x100 because casters are dynamic objects. Directional
   * lights have no position; the only lights with flag 0x100 are flashlights (the Flashlight
   * class sets it on its linked Spot Light, Suffering.rfl 0x10013cb2 / 0x100140d7), so the
   * shadow light is the strongest point light of the set (rankLuma × I / d² within the cull
   * radius plus the caster's radius, 0x4c7ed0 / 0x4c8ea0). The rig's spots are the flashlight's
   * beam and spill, so they never give a shadow. Null when no point light reaches the caster.
   */
  private shadowLightOf(centre: THREE.Vector3, radius: number): THREE.Vector3 | null {
    let best = 0;
    let at: THREE.Vector3 | null = null;
    const n = u.points.value as number;
    for (let i = 0; i < n; i++) {
      const a = pointA[i], b = pointB[i];
      const rgb = [b.x, b.y, b.z];
      const d2 = (a.x - centre.x) ** 2 + (a.y - centre.y) ** 2 + (a.z - centre.z) ** 2;
      const k = pointLightInfluence(a.w, rgb, d2, pointLightCullRadius(a.w, rgb) + radius);
      if (k > best) (best = k), (at = this.t.d.set(a.x, a.y, a.z));
    }
    return at;
  }

  addProvider(fn: (out: EnginePointLight[]) => void): () => void {
    this.providers.add(fn);
    return () => this.providers.delete(fn);
  }

  /** World Spot Lights (the searchlights' 7:2895, world/searchlight.ts), after the flashlight's. */
  private spotProviders = new Set<(out: EngineSpot[]) => void>();
  private readonly spotList: EngineSpot[] = [];
  addSpotProvider(fn: (out: EngineSpot[]) => void): () => void {
    this.spotProviders.add(fn);
    return () => this.spotProviders.delete(fn);
  }

  /** A directional light (Directional Light base lights, camera-relative rim lights). */
  addDirectional(): EngineDirectional {
    const d: EngineDirectional = { dir: new THREE.Vector3(0, -1, 0), color: new THREE.Color(0, 0, 0), on: false, baked: false, exclusive: false, rim: false, box: null, remove: () => this.rims.delete(d) };
    this.rims.add(d);
    return d;
  }

  /**
   * Level ambient for dynamic objects: the global colour (the Ambient Light under the root
   * group) + the Ambient Light regions (engine units). The engine sorts the regions overlapping
   * an object by volume and sums them up to the first one with p8 set (all retail ones), so the
   * smallest region wins (0x4ca730, 0x4c9bc0). The regions are uploaded smallest first (the
   * MAX_AMBIENT_BOXES smallest).
   */
  setAmbient(global: THREE.Color, boxes: AmbientBox[]) {
    u.ambient.value.set(global.r, global.g, global.b);
    const vol = (b: AmbientBox) => (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
    // Smallest first, for the per-object choice (objectLightSet) and the shader.
    this.ambientBoxes = [...boxes].sort((a, b) => vol(a) - vol(b));
    const n = Math.min(this.ambientBoxes.length, MAX_AMBIENT_BOXES);
    for (let i = 0; i < n; i++) {
      const b = this.ambientBoxes[i];
      ambLo[i].set(b.min.x, b.min.y, b.min.z, 0);
      ambHi[i].set(b.max.x, b.max.y, b.max.z, 0);
      ambCol[i].set(b.color.r, b.color.g, b.color.b, b.exclusive === false ? 0 : 1);
    }
    u.ambBoxes.value = n;
  }

  /** Per frame, before rendering: choose the lights and upload the uniforms. */
  update(scene: THREE.Scene, camera: THREE.Camera, flashlight: THREE.SpotLight | null, fog: THREE.Fog | THREE.FogExp2 | null) {
    this.frame++;
    const cam = camera.getWorldPosition(this.t.v).clone();
    // Fog.
    if (fog instanceof EngineFog) {
      u.fogNear.value = fog.near;
      u.fogFar.value = fog.far;
      raw(fog.color, this.t.c);
      u.fogColor.value.set(this.t.c.r, this.t.c.g, this.t.c.b);
    }
    // Point lights: providers + three.js point lights of effects (muzzle flashes, fires...).
    const cand = this.cand;
    cand.length = 0;
    for (const p of this.providers) p(cand);
    const now = performance.now();
    if (now - this.scanAt > 500) {
      this.scanAt = now;
      this.fxLights = [];
      scene.traverseVisible((o) => {
        if ((o as THREE.PointLight).isPointLight) this.fxLights.push(o as THREE.PointLight);
      });
    }
    let fx = 0;
    for (const l of this.fxLights) {
      if (!l.visible || l.intensity <= 0 || !l.parent) continue;
      // three.js effect lights (intensity ~2..60, distance = reach): engine colour scaled by
      // intensity / 12 (capped at 2), strength (half the reach)² [port mapping].
      const k = Math.min(2, l.intensity / 12);
      const p = l.getWorldPosition(this.t.d);
      raw(l.color, this.t.c);
      const half = Math.max(0.5, (l.distance || 8) * 0.5);
      cand.push({ x: p.x, y: p.y, z: p.z, intensity: half * half, r: this.t.c.r * k, g: this.t.c.g * k, b: this.t.c.b * k, hemi: 0 });
      fx++;
    }
    // Nearest (to the edge of their cull radius) first; black / negative lights are never
    // selected by the engine (their cull radius is 0 / NaN).
    const key = (l: EnginePointLight) => Math.hypot(l.x - cam.x, l.y - cam.y, l.z - cam.z) - cullRadius(l.intensity, l.r, l.g, l.b) * (1 + CULL_FADE);
    for (let i = cand.length - 1; i >= 0; i--) if (cullRadius(cand[i].intensity, cand[i].r, cand[i].g, cand[i].b) <= 0) cand.splice(i, 1);
    if (cand.length > MAX_POINTS) {
      for (const l of cand) (l as EnginePointLight & { k?: number }).k = key(l);
      cand.sort((a, b) => (a as { k?: number }).k! - (b as { k?: number }).k!);
    }
    const n = Math.min(cand.length, MAX_POINTS);
    // Lights for precomputed geometry first (switchable / effect lights), then the static ones.
    let slot = 0;
    for (const pass of [true, false]) {
      for (let i = 0; i < n; i++) {
        const l = cand[i];
        if ((l.baked !== false) !== pass) continue;
        pointA[slot].set(l.x, l.y, l.z, l.intensity);
        pointB[slot].set(l.r, l.g, l.b, l.hemi);
        slot++;
      }
      if (pass) u.bakedPoints.value = this.stats.bakedPoints = slot;
    }
    u.points.value = n;
    this.pointsVersion++;
    this.stats.points = n;
    this.stats.candidates = cand.length;
    this.stats.fx = fx;

    // Spot lights: the flashlight (beam + spill), dimmed with the lamp's intensity (battery).
    let s = 0;
    if (flashlight && flashlight.visible && flashlight.intensity > 0 && flashlight.parent && !this.perPixelFlashlight) {
      const k = flashlight.intensity / FLASHLIGHT_BASE_INTENSITY;
      const pos = flashlight.getWorldPosition(this.t.d).clone();
      // The beam follows the view axis (the SpotLight sits off-centre and aims 1 m ahead): the
      // holder's, the player's while a security monitor's feed has the camera (held-lamp.ts).
      const dir = lampAxis(flashlight, camera, this.t.v);
      for (const def of this.flashlight) {
        if (s >= MAX_SPOTS) break;
        this.t.c.setHex(def.color, THREE.LinearSRGBColorSpace);
        // c[8].w cone constant, c[9].w 1 / range², c[10].w start (render-data.ts spotConstants).
        const sc = spotConstants(def);
        spotA[s].set(pos.x, pos.y, pos.z, sc.cone);
        spotB[s].set(dir.x, dir.y, dir.z, sc.invRange2);
        spotC[s].set(this.t.c.r * k, this.t.c.g * k, this.t.c.b * k, sc.start);
        s++;
      }
    }
    // World Spot Lights in the slots left, nearest to the camera first.
    const ws = this.spotList;
    ws.length = 0;
    for (const p of this.spotProviders) p(ws);
    if (ws.length > MAX_SPOTS - s) ws.sort((a, b) => Math.hypot(a.pos.x - cam.x, a.pos.y - cam.y, a.pos.z - cam.z) - Math.hypot(b.pos.x - cam.x, b.pos.y - cam.y, b.pos.z - cam.z));
    for (const w of ws) {
      if (s >= MAX_SPOTS) break;
      const sc = spotConstants(w.def);
      this.t.c.setHex(w.def.color, THREE.LinearSRGBColorSpace);
      const k = w.sign ?? 1;
      spotA[s].set(w.pos.x, w.pos.y, w.pos.z, sc.cone);
      spotB[s].set(w.dir.x, w.dir.y, w.dir.z, sc.invRange2);
      spotC[s].set(this.t.c.r * k, this.t.c.g * k, this.t.c.b * k, sc.start);
      s++;
    }
    u.spots.value = s;
    this.stats.spots = s;

    // Directional lights (Directional Light base lights + rim lights). A black exclusive light
    // still hides the larger regions after it (1a's root-group light 0x7f8a).
    const dl = this.dirList;
    dl.length = 0;
    for (const r of this.rims) if (r.on && (r.exclusive || r.color.r || r.color.g || r.color.b)) dl.push(r);
    if (dl.length > MAX_DIRS) {
      // The regions nearest the camera (a light without a region holds it).
      const dist = (r: EngineDirectional) => (r.box ? r.box.distanceToPoint(cam) : 0);
      dl.sort((a, b) => dist(a) - dist(b));
      dl.length = MAX_DIRS;
    }
    // Smallest region first (0x4c9bc0), the order the shader applies them in; the sort is
    // stable, so lights of one region keep their order.
    const vol = (r: EngineDirectional) => (r.box ? (r.box.max.x - r.box.min.x) * (r.box.max.y - r.box.min.y) * (r.box.max.z - r.box.min.z) : Infinity);
    dl.sort((a, b) => vol(a) - vol(b));
    let d = 0;
    for (const r of dl) {
      dirA[d].set(r.dir.x, r.dir.y, r.dir.z, r.baked ? 1 : 0);
      dirB[d].set(r.color.r, r.color.g, r.color.b, 0);
      if (r.box) {
        dirLo[d].set(r.box.min.x, r.box.min.y, r.box.min.z, r.exclusive ? 1 : 0);
        dirHi[d].set(r.box.max.x, r.box.max.y, r.box.max.z, r.rim ? 1 : 0);
      } else {
        dirLo[d].set(-1e9, -1e9, -1e9, r.exclusive ? 1 : 0);
        dirHi[d].set(1e9, 1e9, 1e9, r.rim ? 1 : 0);
      }
      d++;
    }
    u.dirs.value = d;
  }

  /**
   * Projected character shadows (docs/re/renderer.md §4): each caster is drawn as a white
   * silhouette into its own 256² target along the direction of its shadow light, the strongest
   * light of its light set raised to at least 45° (0x4cc020), with an orthographic frame fitted
   * to its bounds (0x4cd550); the engine-lit materials sample them (shadowTerm). Casters fade
   * out with the camera distance (Level Properties p14 / p15). Call after update(), before the
   * scene.
   */
  renderShadows(renderer: THREE.Renderer, camera: THREE.Camera, _flashlight: THREE.SpotLight | null) {
    u.shadows.value = 0;
    this.stats.shadows = 0;
    const casters = this.shadowMode !== ShadowMode.Off && this.shadowCasters ? this.shadowCasters() : [];
    if (!casters.length) return;
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const sc = this.shadowScratch;
    sc.list.length = 0;
    for (const c of casters) {
      if (this.shadowMode === ShadowMode.PlayerOnly && !c.player) continue;
      // Characters culled from this view draw nothing into a target (their meshes are hidden).
      const mesh = visibleMesh(c.root);
      if (!mesh) continue;
      // Centre the frame on the drawn body: a sequence poses the model away from the actor's
      // own position (1a "Goose": the silhouettes fell beside the frame).
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (g.boundingSphere) c.centre.copy(g.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
      const d = c.centre.distanceTo(eye);
      const fade = THREE.MathUtils.clamp((SHADOW_FAR - d) / (SHADOW_FAR - SHADOW_NEAR), 0, 1);
      if (fade <= 0) continue;
      const light = this.shadowLightOf(c.centre, c.radius);
      const dir = light && shadowLightDirection([light.x - c.centre.x, light.y - c.centre.y, light.z - c.centre.z]);
      if (!dir) continue;
      sc.list.push({ c, d, dir: new THREE.Vector3(...dir), fade });
    }
    sc.list.sort((a, b) => a.d - b.d);
    const n = Math.min(MAX_SHADOWS, sc.list.length);
    if (!n) return;
    const prevTarget = renderer.getRenderTarget();
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const { c, dir, fade } = sc.list[i];
      const cam = this.shadowCams[i];
      const r = c.radius * 1.1;
      const back = c.radius * 3;
      cam.position.copy(c.centre).addScaledVector(dir, back);
      cam.up.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.99) cam.up.set(0, 0, 1);
      cam.lookAt(c.centre);
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = Math.max(0.01, back - c.radius * 1.5);
      cam.far = back + c.radius * 1.5;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      const e = m.elements; // column-major: row r = (e[r], e[r+4], e[r+8], e[r+12])
      for (let k = 0; k < 4; k++) data[SH_M + 4 * i + k].set(e[k], e[k + 4], e[k + 8], e[k + 12]);
      data[SH_I + i].set(dir.x, dir.y, dir.z, dir.dot(c.centre));
      data[SH_C + i].set(c.centre.x, c.centre.y, c.centre.z, c.radius * SHADOW_REACH);
      data[SH_F + i].set(fade, 0, 0, 0);
      // Silhouette pass: every mesh of the caster in white, nothing else.
      sc.swapped.length = 0;
      sc.hidden.length = 0;
      c.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          sc.swapped.push([mesh, mesh.material]);
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.silhouetteOf(m)) : this.silhouetteOf(mesh.material);
        } else if ((o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) {
          if (o.visible) (sc.hidden.push(o), (o.visible = false));
        }
      });
      const auto = c.root.matrixWorldAutoUpdate;
      c.root.matrixWorldAutoUpdate = false; // keep the parent-relative world matrices
      renderer.setRenderTarget(shadowTargets[i]);
      renderer.render(c.root, cam);
      c.root.matrixWorldAutoUpdate = auto;
      for (const [mesh, mat] of sc.swapped) mesh.material = mat;
      for (const o of sc.hidden) o.visible = true;
    }
    renderer.setRenderTarget(prevTarget);
    u.shadowFlipY.value = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? 1 : 0;
    u.shadows.value = n;
    this.stats.shadows = n;
  }
}

/** The first visible mesh under `root` (visibility of the path included), or null. */
function visibleMesh(root: THREE.Object3D): THREE.Mesh | null {
  if (!root.visible) return null;
  if ((root as THREE.Mesh).isMesh) return root as THREE.Mesh;
  for (const c of root.children) {
    const m = visibleMesh(c);
    if (m) return m;
  }
  return null;
}

/** A dynamic object's light set this frame (EngineLightRig.objectLightSet). */
export interface ObjectLightSet {
  frame: number;
  /** Uploaded point-light slots of the chosen lights (-1 = none); the fifth in `point5`. */
  points: THREE.Vector4;
  point5: number;
  /** Ambient colour (engine units). */
  ambient: THREE.Vector3;
  /** Bit i: uploaded directional light i applies. */
  dirs: number;
  centre: THREE.Vector3;
  radius: number;
}

/** A directional light of the rig (xvsLightDir.vsh). */
export interface EngineDirectional {
  /** Unit vector towards the light (world). */
  dir: THREE.Vector3;
  /** Engine colour (bytes / 255, negative for negative lights). */
  color: THREE.Color;
  on: boolean;
  /** Also lights geometry with precomputed colours (the light has flag 2: switchable). */
  baked: boolean;
  /** p8 (flag 0x400): hides the lights of larger regions after it (render-data.ts applicableDirectionals). */
  exclusive: boolean;
  /** A rim light (flag 0x800): dynamic objects only, the first one applies. */
  rim: boolean;
  /** Region (world box: the light's parent group, docs/re/renderer.md §1.4) it applies in; null = everywhere. */
  box: THREE.Box3 | null;
  remove(): void;
}

/** A character that can cast a projected shadow. */
export interface ShadowCaster {
  root: THREE.Object3D;
  /** World-space centre and radius of its bounds. */
  centre: THREE.Vector3;
  radius: number;
  player?: boolean;
}

/** The single lighting rig (one renderer per page). */
export const engineLights = new EngineLightRig();
// Debug/test hook, like window.__view.
if (typeof window !== 'undefined') Object.assign(window, { __lighting: { rig: engineLights, legacy: LEGACY_LIGHTING, shadowTargets, data } });

/** Engine colour (bytes / 255) of a 0xRRGGBB value. */
export function engineColor(v: number, out = new THREE.Color()): THREE.Color {
  const c = v >>> 0;
  return out.setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, THREE.LinearSRGBColorSpace);
}

