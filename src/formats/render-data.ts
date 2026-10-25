// Renderer constants and small pure decoders reverse engineered from SUFFERING.EXE and the
// shader library (docs/re/renderer.md). Addresses are given so each value can be re-checked;
// tags as in docs/game-logic.md: [verified] read in the code, [strong] read but the caller /
// meaning is partly inferred, [inferred] chosen to fit.
//
// Everything here is plain arithmetic: no three.js, no game data. The renderer
// (src/app/engine-light.ts), the insanity screen effects and the tests use it.

// ---------------------------------------------------------------------------
// Per-object light selection

/**
 * "Light Radius Cutoff Factor": the light level below which a point light stops being given to
 * an object. Initialised data at 0x5ba608 (= 0.1); read only by 0x4c7c00 / 0x4c7c3f / 0x4c8681.
 * The engine-property slot of that name (index 0x34) is never read [verified].
 */
export const LIGHT_RADIUS_CUTOFF = 0.1;

/** Light colour weights used for the cull radius (0x59560c, 0x58eba4, 0x595610) [verified]. */
export const CULL_LUMA = [0.33, 0.45, 0.22] as const;
/** Light colour weights used to rank lights per object (0x595600..0x595608) [verified]. */
export const RANK_LUMA = [0.212, 0.701, 0.087] as const;

/** Slots in an object's light set (0x16 + 4 × i, 12 entries) [verified, 0x4c2f30]. */
export const LIGHT_SET_SLOTS = 12;
/** Ambient (type 1) slots in an object's light set (+0x46 / +0x4a) [verified, 0x4c2ed0]. */
export const AMBIENT_SLOTS = 2;
/** Lights uploaded to the vertex shader per object (0x4cff10 loop, `cmp 8`) [verified]. */
export const SHADER_LIGHTS = 8;
/** Point lights uploaded per object, of those 8 (0x4d05c1, `cmp 5`) [verified]. */
export const SHADER_POINT_LIGHTS = 5;

/** Engine light types (light vtable +0x28) [verified: 0x4c9640 ambient, 0x4c97f0 directional, point vtable 0x5953b0, spot 0x595690]. */
export const enum LightType {
  Ambient = 1,
  Directional = 2,
  Point = 3,
  Spot = 4,
}

/** Light flag bits (light +0xc) [verified setters]. */
export const LightFlag = {
  /** Point: hemisphere "above only" (p9 = 1). Ambient / Directional: p8 set = this light hides the larger regions after it. */
  Exclusive: 0x400,
  /**
   * Point: hemisphere "below only" (p9 = 2). Directional: rim light (created from a Rim Light
   * template; set through directional vtable +0x74 = 0x4c9830 at 0x4c7573, while +0x70 = 0x4c9800,
   * the 0x400 setter, is called only for the base light's p8 at 0x4c75f8).
   */
  Rim: 0x800,
  /**
   * Ranked before every non-directional light (0x4c2fdb) and never a dynamic object's shadow
   * light (0x4cc073) [verified]. Set only by the Flashlight class on its linked Spot Light
   * (Suffering.rfl 0x10013cb2 / 0x100140d7, vtable 0x1014c4c8); no EXE code sets it.
   */
  Priority: 0x100,
} as const;

const dot3 = (c: ArrayLike<number>, w: readonly number[]) => c[0] * w[0] + c[1] * w[1] + c[2] * w[2];

/**
 * Point Light strength I: the engine stores p8 × 2048² at light +0x54 (0x4c60b0 `fmul 2048²`;
 * the Lighting Effect animator 0x4c55d8 and the save loader 0x4c65c0 write the same unit), and
 * xvsLightPoint.vsh computes min(I / d², 2) with d in engine units (× 2048). In metres the
 * level is therefore p8 / d²: p8 is the light's strength in m², not a radius to square
 * [verified code; data: the .ldu bake of 1a / 1b matches p8 / d² around static lights, median
 * ratio 1.0, and is ~5 % of p8² / d², docs/re/renderer.md §1.2].
 */
export function pointLightLevel(intensity: number, d2: number): number {
  return Math.min(intensity / Math.max(d2, 1e-12), 2);
}

/**
 * Distance beyond which a point light is not given to an object (light +0x58), in metres:
 * sqrt(cullLuma(colour) / cutoff × I) with I = p8 (0x4c7c20 / 0x4c8650) [verified]. The colour
 * is the signed engine colour (bytes / 255, negated for p1): a negative or black light gets NaN
 * / 0 here and is never selected (the sphere tests fail) [verified arithmetic; no retail Point
 * Light sets p1].
 */
export function pointLightCullRadius(intensity: number, rgb: ArrayLike<number>, cutoff = LIGHT_RADIUS_CUTOFF): number {
  const l = dot3(rgb, CULL_LUMA);
  return l > 0 && intensity > 0 ? Math.sqrt((l / cutoff) * intensity) : 0;
}

/**
 * Rank of a point light for an object at squared distance `d2` (light vtable +0x40, 0x4c7ed0):
 * 0 outside the cull radius, else rankLuma(colour) × I / d² [verified].
 */
export function pointLightInfluence(intensity: number, rgb: ArrayLike<number>, d2: number, cullRadius = pointLightCullRadius(intensity, rgb)): number {
  if (!(d2 < cullRadius * cullRadius)) return 0;
  return (dot3(rgb, RANK_LUMA) * intensity) / Math.max(d2, 1e-9);
}

export interface RankedLight {
  type: LightType;
  /** vtable +0x40 at the object's position. */
  influence: number;
  flags?: number;
}

/**
 * Insert `light` into an object's light set (0x4c2f30) [verified]. Walking the set, a
 * directional light is inserted before the first non-directional entry or the first weaker
 * directional; a Priority light before the first non-directional entry; any other light before
 * the first entry with a lower influence. A full set (12) drops its last entry. Returns false
 * when the light would go after a full set. Ambient lights use their own two slots.
 */
export function insertLight<T extends RankedLight>(set: T[], light: T, slots = LIGHT_SET_SLOTS): boolean {
  let at = 0;
  for (; at < set.length; at++) {
    const cur = set[at];
    if (light.type === LightType.Directional) {
      if (cur.type !== LightType.Directional || cur.influence < light.influence) break;
    } else {
      if ((light.flags ?? 0) & LightFlag.Priority && cur.type !== LightType.Directional) break;
      if (cur.influence < light.influence) break;
    }
  }
  if (at >= slots) return false;
  set.splice(at, 0, light);
  if (set.length > slots) set.length = slots;
  return true;
}

/**
 * Index of an object's shadow light in its light set (0x4cc020): the first light, skipping
 * Priority lights (the flashlight) when the caster is a dynamic object (object +0x10 bit 1:
 * characters) [verified]. The caster's position getter (vtable +0x16c) then gives the light's
 * position; a light without one (directional) ends the search with no shadow light [strong:
 * the getter's failure return exits 0x4cc0bf, the getter itself was not read]. -1 = none.
 */
export function shadowLightIndex(set: readonly RankedLight[], dynamic = true): number {
  for (let i = 0; i < set.length; i++) {
    const l = set[i];
    if (dynamic && (l.flags ?? 0) & LightFlag.Priority) continue;
    return l.type === LightType.Point || l.type === LightType.Spot ? i : -1;
  }
  return -1;
}

/**
 * The lights the vertex shader gets for an object (0x4cff10) [verified]: the light set in
 * order, at most 8, of which at most 5 point lights (later point lights are skipped, the walk
 * continues for other types).
 */
export function shaderLights<T extends RankedLight>(set: readonly T[]): T[] {
  const out: T[] = [];
  let points = 0;
  for (const l of set) {
    if (out.length >= SHADER_LIGHTS) break;
    if (l.type === LightType.Point) {
      if (points >= SHADER_POINT_LIGHTS) continue;
      points++;
    }
    out.push(l);
  }
  return out;
}

export interface RegionLight {
  /** Volume of the light's region (box, or its zone for unscaled lights). */
  volume: number;
  /** p8: hides every larger region after it (flag 0x400). */
  exclusive: boolean;
}

/**
 * Ambient / directional regions applying to one object (0x4ca730) [verified order, inferred
 * that the region volume is the comparator's key]: the lights whose region contains the object,
 * smallest region first (qsort 0x4c9bc0), cut after the first exclusive one. Every retail
 * Ambient Light has p8 = 1, so in practice the smallest containing box wins.
 */
export function applicableRegions<T extends RegionLight>(containing: readonly T[]): T[] {
  const sorted = [...containing].sort((a, b) => a.volume - b.volume);
  const cut = sorted.findIndex((l) => l.exclusive);
  return cut < 0 ? sorted : sorted.slice(0, cut + 1);
}

export interface DirectionalRegionLight extends RegionLight {
  /** A rim light (flag 0x800). Rim lights are never exclusive: their init sets no 0x400. */
  rim: boolean;
}

/**
 * Directional lights applying to one object (0x4ca730: gather 0x4cab22, cut 0x4cac44, apply 0x4cad56)
 * [verified]: those whose region holds it, smallest region first, cut after the first
 * exclusive one. Rim lights are gathered only for dynamic objects (object +0x10 bit 1), survive
 * the cut, and only the first of them is applied. Every retail Directional Light base light
 * has p8 = 1 except 1a 0x8add.
 */
export function applicableDirectionals<T extends DirectionalRegionLight>(containing: readonly T[], dynamic: boolean): T[] {
  const sorted = containing.filter((l) => dynamic || !l.rim).sort((a, b) => a.volume - b.volume);
  const cut = sorted.findIndex((l) => l.exclusive);
  let rim = false;
  return sorted.filter((l, i) => {
    if (!l.rim) return cut < 0 || i <= cut;
    if (rim) return false;
    return (rim = true);
  });
}

// ---------------------------------------------------------------------------
// Spot lights

/** Spot Light properties p8 / p9 / p10 in metres (Spot Light instance loader 0x4cf450). */
export interface SpotProps {
  /** p8: start distance S along the axis. */
  start: number;
  /** p9: length L. */
  length: number;
  /** p10: cone radius R (the cone widens by R between S and L). */
  radius: number;
}

/** Shader constants of a spot light (xvsLightSpot.vsh: c[8].w, c[9].w, c[10].w). */
export interface SpotConstants {
  /** c[8].w: I in I·l²/r². */
  cone: number;
  /** c[9].w: 1 / range², the fall-off 1 − l²·c9w reaches 0 at the range. */
  invRange2: number;
  /** c[10].w: no light before this distance along the axis (l ≥ start). */
  start: number;
}

/**
 * Spot shader constants from p8 / p9 / p10 [verified: constructor 0x4c99e0 with
 * (R = p10, S = p8, L = p9) × 2048 from 0x4cf450; k = 1 / (L − S), +0x60 = R·k,
 * +0x64 = 1 / (R·L·k), +0x68 = R·S·k; per draw (0x4d0191) c10.w = +0x68, c9.w = +0x64²,
 * c8.w = 0.05 × (2L)² × c9.w (0x4369c8)]. Units: whatever p8..p10 are in (metres).
 */
export function spotConstants(p: SpotProps): SpotConstants {
  const span = Math.max(p.length - p.start, 1e-6);
  const r = Math.max(p.radius, 1e-6);
  const inv = span / (r * Math.max(p.length, 1e-6));
  return { cone: 0.2 * p.length * p.length * inv * inv, invRange2: inv * inv, start: (r * p.start) / span };
}

// ---------------------------------------------------------------------------
// Screen blur (Screen Blur objects -> renderer vtable +0x4c, 0x49c270)

export interface ScreenBlurPass {
  /** Alpha of the previous frame drawn over the new one: min(1.4·A, 225/255). */
  alpha: number;
  /** UV inset of the previous frame (it is drawn with UVs B .. 1 − B: a zoom towards the centre). */
  inset: number;
  /** Blend mode index (surface-material Blend): 1 alpha blend, 2 additive, 4 reverse subtract. */
  blend: number;
}

/**
 * What the renderer does with one Screen Blur update (RFL 0x10129070 passes A × 0.01, B × 0.01
 * and the mode p2 with 3 → 4 [verified]; renderer 0x49c270 [verified]): the previous frame
 * (front-buffer ping-pong target) is drawn over the new frame as a full-screen quad, vertex
 * colour white with alpha min(1.4·A × 255, 225) / 255, UVs from B to 1 − B, with the material
 * blend mode `mode`. `aPercent` / `bPercent` are the Screen Blur's eased A / B (p4/p5, p8/p9).
 */
export function screenBlurPass(aPercent: number, bPercent: number, mode: number): ScreenBlurPass {
  const a = Math.max(0, aPercent) * 0.01;
  return {
    alpha: Math.min(Math.round(a * 1.4 * 255), 225) / 255,
    inset: Math.max(0, Math.min(0.49, bPercent * 0.01)),
    blend: mode === 3 ? 4 : mode,
  };
}

// ---------------------------------------------------------------------------
// HDR scene glow ("HDR ScreenBlur", 0x48d0a0)

/** Render-target sizes of the four glow levels (0x48d2ba) [verified]. */
export const GLOW_LEVELS = [256, 128, 64, 32] as const;
/**
 * Blur taps: quad offsets in pixels of the level being blurred, with their vertex colour (grey
 * byte), drawn additively (blend mode 2) [verified, 0x48d0d0..0x48d1be and the loop at 0x48d470].
 * The weights sum to 480 / 255.
 */
export const GLOW_TAPS: readonly { dx: number; dy: number; weight: number }[] = [
  { dx: 0, dy: 2, weight: 0x40 },
  { dx: 0, dy: -2, weight: 0x40 },
  { dx: 1.75, dy: 1, weight: 0x48 },
  { dx: -1.75, dy: -1, weight: 0x48 },
  { dx: -1.75, dy: 1, weight: 0x48 },
  { dx: 1.75, dy: -1, weight: 0x48 },
  { dx: 0, dy: 0, weight: 0x40 },
];
/** Vertex colour of the down-sampling copies (×0.5) [verified, 0x48d34e]. */
export const GLOW_DOWNSAMPLE = 0x80 / 255;

/** HDR Scene Glow template (class 0xb345d08d, "2.f.7.7") as applied by 0x48d680 [verified]. */
export interface SceneGlow {
  /** Glow colour (0xRRGGBB, p1). */
  color: number;
  /** Alpha of the composite: p0 % (× 0.01 × 255). */
  alpha: number;
  /** p2: blend mode of the accumulation / composite (2 = additive). */
  blend: number;
  /** p3. */
  flag: number;
}

/** Engine defaults of the glow state (0x5ba0a4: 0xffffffff, 2, 0, 0) [verified]. */
export const DEFAULT_GLOW: SceneGlow = { color: 0xffffff, alpha: 1, blend: 2, flag: 0 };

/**
 * The level-0 down-sample keeps a frame texel only when its destination alpha (the glow mask,
 * 0x49c030) is > 5 / 255: the pass state there has ALPHAREF 5, ALPHAFUNC GREATER, and
 * 0x49a940 enables the test whenever the reference is non-zero [verified, 0x48d264..0x48d28f].
 * (A non-zero glow flag p3, +0xc, or engine property 0x39 = 2 set the reference to 0 instead:
 * no test, the whole frame glows. No retail template or setting does.)
 */
export const GLOW_MASK_REF = 5 / 255;

/**
 * Does a material mark the pixels it draws for the scene glow? Each pass whose layer flag 4
 * (Advanced p5 / Animating p7, the decoder's `depthWrite`) is set draws with STENCILPASS =
 * REPLACE; an opaque first pass without it with ZERO, every other pass KEEP (0x48fb55..0x48fbc3)
 * [verified]. So the last marking pass of a material wins: marked when any layer carries the
 * flag. In the retail data all 120 flagged materials are tinted (unlit): lamp glass and bulbs
 * (4:1374, 7:1863, 9:5742...), glowing panels, fire and effect cards.
 */
export function glowMarked(layers: readonly { blend: number; depthWrite?: boolean }[] | undefined): boolean {
  return !!layers?.some((l) => l.depthWrite);
}

/**
 * Alpha a marking pass needs to touch the stencil: the pass's own alpha test (passAlphaRef with
 * the mark, so > 32 / 255 for an additive pass), cut-out > 200 / 255; null = every pixel drawn.
 */
export function glowMarkAlphaRef(blend: number): number | null {
  return passAlphaRef(blend, true);
}

/**
 * Whether a texel of a marking pass writes the glow mark: its alpha is texture alpha x TFACTOR
 * alpha, and TFACTOR alpha carries the object's opacity (a tinted layer always, any layer of an
 * object below 0.99: SUFFERING.EXE 0x498a5c, 0x48fcd7), so a faded object marks only where
 * texture alpha x opacity clears the pass's alpha test [verified]. 1b's Killjoy (Projector Effect
 * 7edb: 0.4 +- 0.5 opacity, his glow-flagged additive layer 10:428 at alpha 1) marks nothing in
 * the updates that draw him at 32 / 255 or less, about a fifth of them.
 */
export function glowMarkWritten(blend: number, textureAlpha: number, opacity: number): boolean {
  const ref = glowMarkAlphaRef(blend);
  return ref === null || textureAlpha * opacity > ref;
}

/**
 * CPU reference of the glow chain (0x48d0a0) on one 256² image of the masked frame: `src` holds
 * gamma rgb per texel (0..1, already masked: 0 where the mask fails). Returns the accumulation
 * target C (gamma rgb, 256²) that the composite adds to the back buffer (× colour × alpha).
 * Per level f (256, 128, 64, 32): B = 0.5 × (src or the previous level's A, halved), A = Σ taps
 * of B at the pixel offsets of GLOW_TAPS × weight / 255, saturated per tap; C = A0 + up(A1) +
 * up(A2) + up(A3), saturated per add. Sampling is nearest / box here (the engine filters
 * bilinearly); the port's GPU version (src/app/scene-glow.ts) samples bilinearly.
 */
export function sceneGlowReference(src: Float32Array, size: number = GLOW_LEVELS[0]): Float32Array {
  const sat = (x: number) => (x > 1 ? 1 : x < 0 ? 0 : x);
  const C = new Float32Array(size * size * 3);
  let prev = src, prevSize: number = size;
  for (let l = 0; l < GLOW_LEVELS.length; l++) {
    const f = size >> l;
    // Down-sample: level 0 copies the masked frame, later levels average 2 x 2 of the last A.
    const B = new Float32Array(f * f * 3);
    const k = prevSize / f;
    for (let y = 0; y < f; y++)
      for (let x = 0; x < f; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += prev[((y * k + j) * prevSize + x * k + i) * 3 + c];
          B[(y * f + x) * 3 + c] = sat((s / (k * k)) * GLOW_DOWNSAMPLE);
        }
    // Blur: seven additive taps (a quad drawn at the offset reads B at p - offset).
    const A = new Float32Array(f * f * 3);
    for (let y = 0; y < f; y++)
      for (let x = 0; x < f; x++)
        for (const t of GLOW_TAPS) {
          const sx = Math.round(x - t.dx), sy = Math.round(y - t.dy);
          if (sx < 0 || sy < 0 || sx >= f || sy >= f) continue;
          for (let c = 0; c < 3; c++) A[(y * f + x) * 3 + c] = sat(A[(y * f + x) * 3 + c] + B[(sy * f + sx) * 3 + c] * (t.weight / 255));
        }
    // Accumulate, stretched over the 256² target.
    const u = size / f;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        for (let c = 0; c < 3; c++) {
          const i = (y * size + x) * 3 + c;
          C[i] = sat(C[i] + A[((Math.floor(y / u)) * f + Math.floor(x / u)) * 3 + c]);
        }
    prev = A;
    prevSize = f;
  }
  return C;
}

export function decodeSceneGlow(v: ArrayLike<unknown>): SceneGlow {
  const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    alpha: Math.max(0, Math.min(255, Math.trunc(n(v[0], 100) * 0.01 * 255))) / 255,
    color: n(v[1], 0xffffff) & 0xffffff,
    blend: n(v[2], 2),
    flag: n(v[3], 0),
  };
}

// ---------------------------------------------------------------------------
// Present / screen

/**
 * Hardware gamma ramp of the Graphics page's Gamma Value (0x4b24f0) [verified]:
 * ramp[i] = ((i << 8) / 65535)^(1 / g) × 65535, only for g > 0.
 */
export function gammaRamp(g: number): Uint16Array {
  const out = new Uint16Array(256);
  for (let i = 0; i < 256; i++) out[i] = g > 0 ? Math.trunc(Math.pow((i << 8) / 65535, 1 / g) * 65535) : (i << 8);
  return out;
}

/** Black-and-white present (xpsBW_PC.psh, renderer vtable +0x6c toggles it) [verified weights]. */
export const GREYSCALE_WEIGHTS = [0.3, 0.55, 0.15] as const;

// ---------------------------------------------------------------------------
// Shadows (projected render-to-texture, 0x4ceea0 / 0x492a00, xvsShadowBackfaceCull.vsh)

/** Shadow texture size requested for characters (0x492ae2: 0x100) [verified]. */
export const SHADOW_TEXTURE_SIZE = 256;
/** c[56]: receiver alpha = clamp((N·L + 0.3) × 1/0.7) (0x4366c6) [verified]. */
export const SHADOW_FACING_OFFSET = 0.3;
export const SHADOW_FACING_SCALE = 1 / 0.7;

/** Receiver alpha factor from the facing term (xvsShadowBackfaceCull.vsh, without the planes). */
export function shadowFacing(nDotL: number): number {
  return Math.max(0, Math.min(1, (nDotL + SHADOW_FACING_OFFSET) * SHADOW_FACING_SCALE));
}

/**
 * New shadow record (0x4cbfe0): alpha scale 1.0 at +0, colour 0xff000000 (black) at +4, texture
 * size 0x40 at +0x26 (characters ask for 0x100), zero light direction [verified].
 */
export const SHADOW_COLOR = 0x000000;
/**
 * Receiver alpha beyond half the shadow's reach (0x595b60 = 0.66, used at 0x4ce9ae and
 * 0x4ced37) [verified constant].
 */
export const SHADOW_RECEIVER_ALPHA = 0.66;

/**
 * Alpha of one receiving object's shadow pass (0x4ce942..0x4ce9bb, again 0x4cecbe..0x4ced3d)
 * [verified arithmetic]: `t` = (receiver distance − reach / 2) / (reach / 2); t ≤ 0 keeps the
 * record's camera-distance fade as is, 0 < t < 1 gives (1 − t) × fade × 0.66, t ≥ 1 draws
 * nothing. The colour is c[80] with this alpha (× 255, 0x498ac1), times the facing term and the
 * three clip planes per vertex.
 */
export function shadowReceiverAlpha(t: number, fade = 1): number {
  if (!(t < 1)) return 0;
  return t <= 0 ? fade : (1 - t) * fade * SHADOW_RECEIVER_ALPHA;
}

/**
 * sin 45° (0x595b54): a shadow light lower than this above the caster is raised to 45°
 * (0x4cc169) [verified].
 */
export const SHADOW_MIN_ELEVATION = Math.SQRT1_2;

/**
 * Direction of a caster's shadow light (0x4cc020) [verified]: from the caster's position to
 * the position of the first light of its light set (skipping Priority lights on dynamic
 * objects), normalised; when its up component is below sin 45° the up component is replaced by
 * the horizontal length (the light is raised to 45°) and the vector normalised again. The
 * shadow is then projected along this direction (orthographic frame from it, 0x4cd550).
 * Returns null for a zero vector (no shadow). Y is up.
 */
export function shadowLightDirection(toLight: ArrayLike<number>): [number, number, number] | null {
  let [x, y, z] = [toLight[0], toLight[1], toLight[2]];
  let l = Math.hypot(x, y, z);
  if (!(l > 1e-9)) return null;
  x /= l;
  y /= l;
  z /= l;
  if (y < SHADOW_MIN_ELEVATION) {
    y = Math.hypot(x, z);
    l = Math.hypot(x, y, z);
    if (!(l > 1e-9)) return null;
    x /= l;
    y /= l;
    z /= l;
  }
  return [x, y, z];
}

/** The Graphics "Shadows" option values stored in 0x5c6d00 and what 0x4ceea0 casts for each. */
export const enum ShadowMode {
  Off = 0,
  /** The object whose owner equals the first registered player. */
  PlayerOnly = 1,
  /** Objects whose attachment lacks flag 0x2000. */
  Characters = 2,
  All = 3,
}

// ---------------------------------------------------------------------------
// Shader library keys (xvsh/ShaderLibrary.bin, CachedVSHandles.bin)

/** Fields of a vertex-shader variant key [strong: bit 0 / 1 checked against the 989 programs]. */
export function shaderKeyLights(key: number): { baked: boolean; uniform: boolean; directional: number; fieldA: number; fieldB: number } {
  return {
    baked: (key & 1) !== 0,
    uniform: (key & 2) !== 0,
    directional: (key >>> 2) & 3,
    fieldA: (key >>> 6) & 0xf,
    fieldB: (key >>> 10) & 0xf,
  };
}

// ---------------------------------------------------------------------------
// Directional Light objects (Directional Light init 0x4c7230)

export interface DirectionalRole {
  /** The object keeps its own light at run time (a rim template, or switchable). */
  base: boolean;
  /** Switchable (light flag 2): it also lights geometry with precomputed colours. */
  baked: boolean;
  /** On at start (p6; p6 = 0 lights start off, 0x4c760c). */
  on: boolean;
}

/**
 * What a placed Directional Light does at run time [verified]: it is switchable when it has
 * links, a Lighting Effect (p3), p6 = 0, or p6 with any of p2 / p4 / p5 set; it keeps a light
 * object when switchable or when p9 names a Rim Light template. Lights that are neither exist
 * only in the bake (the object is dropped, return -5).
 */
export function directionalRole(v: { p2: number; p3: boolean; p4: number; p5: number; p6: number; rim: boolean; links: number }): DirectionalRole {
  const switchable = v.links > 0 || v.p3 || v.p6 === 0 || !!(v.p2 || v.p4 || v.p5);
  return { base: switchable || v.rim, baked: switchable, on: v.p6 !== 0 };
}

// ---------------------------------------------------------------------------
// Point Light objects (Point Light init 0x4c6ca0)

/**
 * Is a placed Point Light switchable (light flag 2) [verified, 0x4c6ca0]? It is when it follows
 * an object (links), has a Lighting Effect (p3), starts off (p6 = 0), or starts on with any of
 * p2 / p4 / p5 set or p7 > 0. A switchable light lights every object at run time, geometry with
 * precomputed colours included. Any other Point Light is static: the init clears flag 2 and
 * drops its object (return -5); the light stays for dynamic objects only, and reaches geometry
 * with precomputed colours through those colours (the .ldu bake, docs/re/renderer.md §1.6).
 */
export function pointLightSwitchable(v: { links: number; p2: number; p3: boolean; p4: number; p5: number; p6: number; p7: number }): boolean {
  return v.links > 0 || v.p3 || v.p6 === 0 || !!(v.p2 || v.p4 || v.p5) || v.p7 > 0;
}

/**
 * Colour factor of one material pass (docs/re/renderer.md §3.5) [verified]: a tinted layer is
 * modulated by TFACTOR = tint / 2 per channel (bytes / 255, no lighting); otherwise by the
 * vertex lighting. Returns the gamma factor for a tinted layer, null for a lit one.
 */
export function tintFactor(tint: number | undefined): [number, number, number] | null {
  if (tint === undefined) return null;
  const t = tint >>> 0;
  return [((t >> 16) & 255) / 510, ((t >> 8) & 255) / 510, (t & 255) / 510];
}

/**
 * Texture stage 1 while the world is drawn [verified]: the frame start (0x48c4d0, when the
 * world view is up, [0x5c5c30] & 2) sets stage 1 COLOROP = D3DTOP_ADD, whose COLORARG1 and
 * COLORARG2 the device set-up leaves at D3DTA_CURRENT (0x49bc02 / 0x49bc18); nothing changes
 * stage 1's colour until the frame end sets it back to DISABLE (0x49d5f5, 0x49beea) before the
 * front-buffer effects. So every world pass leaves the texture stages as
 * saturate(stage 0 + stage 0): the vertex lighting oD0 (halved in xvsLightFooter) and the
 * TFACTOR tint (halved by the material builders, §3.5) are doubled back, with the light
 * clamp of 400/255 giving up to 1.57 × the texture before the saturate (docs/re/renderer.md §1.8).
 */
export const WORLD_STAGE_GAIN = 2;

/** The colour a world pass writes for a stage-0 result `c` (gamma, 0..1): saturate(2c). */
export function worldStageColor(c: number): number {
  return Math.min(1, Math.max(0, c * WORLD_STAGE_GAIN));
}

/** Alpha-test reference of blend modes 1..6 (D3DRS_ALPHAREF 2, GREATER) [verified, 0x48fab0]. */
export const BLEND_ALPHA_REF = 2 / 255;

// ---------------------------------------------------------------------------
// Pass state of a material layer (0x48fab0) and the back buffer it blends into
// (docs/re/renderer.md §5.1)

/**
 * Bits of the per-pass render-state word (state +4) that the pass builder 0x48fab0 fills and
 * the state applier 0x4952a0 turns into Direct3D states when a bit differs from the device's
 * current word [verified unless marked].
 */
export const PassBit = {
  /** ALPHATESTENABLE with ALPHAREF / ALPHAFUNC from state +8 / +0xc (0x49a940). */
  AlphaTest: 1 << 0,
  /** SRCBLEND / DESTBLEND / BLENDOP of the blend mode in state +0x14 (0x49a990). */
  BlendMode: 1 << 1,
  /** ALPHABLENDENABLE (0x49a8f0). */
  AlphaBlend: 1 << 3,
  /** CULLMODE: CCW (back faces culled) when set, NONE when clear (0x49a700). */
  Cull: 1 << 6,
  /** D3DRS_LIGHTING (0x49a6d0). */
  Lighting: 1 << 7,
  /** FOGENABLE (0x49a5a0). */
  Fog: 1 << 9,
  /** Fog colour replaced for blend modes 2..6 (table 0x5ba100: black, black, black, white, grey). */
  FogOverride: 1 << 10,
  /** Texture stage 0 ALPHAOP = MODULATE (texture alpha × ALPHAARG2); clear: SELECTARG2 (0x49aa60). */
  AlphaModulate: 1 << 12,
  /** ZENABLE (0x49a7a0). */
  ZEnable: 1 << 17,
  /** ZWRITEENABLE (0x49a780). */
  ZWrite: 1 << 18,
  /** STENCILPASS: KEEP when clear; ZERO, or REPLACE with StencilReplace (0x49a740). */
  Stencil: 1 << 19,
  StencilReplace: 1 << 20,
  /** Stage 0 ALPHAARG2 = TFACTOR (else DIFFUSE). */
  AlphaFromFactor: 1 << 22,
  /** Stage 0 COLORARG2 = TFACTOR (else DIFFUSE): a tinted layer, unlit. */
  ColorFromFactor: 1 << 23,
} as const;

/**
 * The state word every object draw starts from: static initialiser 0x586290 (0x6dd280, the
 * dynamic-object draw 0x492b40) and 0x586a80 (0x6dd8d4, the static draw 0x4930f0) both store
 * 0x63a08 [verified]. Fog, alpha-op MODULATE, z test and z write are on; culling is off.
 */
export const DEFAULT_PASS_STATE = 0x63a08;

/**
 * Does a model cull back faces? The static draw (0x493410) sets PassBit.Cull only when the
 * model's flag word has bit 23; the flag word is the first dword of the model's header entry
 * (.mdu type 0), kept under the mask 0x1c3c000 by the header loader 0x483850 [verified]. With
 * the default state above every other model is drawn two-sided.
 */
export const MODEL_CULL_FLAG = 0x800000;
export function modelCullsBackFaces(headerFlags: number): boolean {
  return ((headerFlags & 0x1c3c000) & MODEL_CULL_FLAG) !== 0;
}

/**
 * Does a material's passes write depth [verified, 0x48fc56..0x48fc98]? The builder sets
 * ZWRITEENABLE for the first pass only (pass index 0): on when its blend mode is opaque (0) or
 * cut-out (8), off otherwise; later passes keep that. The Advanced p5 / Animating p7 flag that
 * looks like a depth-write switch is not one: it sets the stencil pass operation to REPLACE
 * (PassBit.StencilReplace), the mark the screen glow pass reads (docs/re/renderer.md §3.2).
 */
export function passDepthWrite(firstPassBlend: number): boolean {
  return firstPassBlend === 0 || firstPassBlend === 8;
}

/** Below this object opacity the draws blend the whole object (0x4933b1 / 0x492c3b: fcomp 0.99). */
export const TRANSLUCENT_OPACITY = 0.99;

/**
 * Pass state of a material on an object drawn at `opacity` [verified, 0x48fab0 with the
 * translucent argument, from 0x4933b1 / 0x493719: opacity < 0.99 or object +0xc bit 7]:
 * every pass blends (ALPHABLENDENABLE), an opaque or cut-out first pass as mode 1 with the
 * > 2 / 255 alpha test; ZWRITEENABLE still follows the first pass's own mode (0x48fc70 reads the
 * layer's mode, not the substituted one), so a fading figure whose first pass is opaque keeps
 * writing depth and its farther faces behind nearer ones are not drawn over. At full opacity
 * the material's own state (`base`) applies.
 */
export function translucentPassState(
  base: { transparent: boolean; depthWrite: boolean; alphaTest: number },
  opacity: number,
): { transparent: boolean; depthWrite: boolean; alphaTest: number } {
  if (opacity >= TRANSLUCENT_OPACITY || base.transparent) return { ...base };
  return { transparent: true, depthWrite: base.depthWrite, alphaTest: Math.max(base.alphaTest, BLEND_ALPHA_REF) };
}

/**
 * The blend mode a pass of a translucent object is drawn with [verified, 0x48fb08..0x48fb1d]: an
 * opaque (0) or cut-out (8) pass becomes mode 1 (SRCALPHA, INVSRCALPHA, alpha > 2 / 255); every
 * other mode keeps its own. Depth is still written by the first pass's own mode (passDepthWrite).
 */
export function translucentPassBlend(blend: number): number {
  return blend === 0 || blend === 8 ? 1 : blend;
}

/**
 * Does a pass take the vertex alpha [verified, docs/re/renderer.md §5.3]? Texture stage 0 alpha is
 * MODULATE(texture, ALPHAARG2) for every object pass (state bit 12 of DEFAULT_PASS_STATE, never
 * cleared by the object draw 0x4986f0 or the pass builder), and ALPHAARG2 is DIFFUSE (oD0.a)
 * unless the layer is tinted (layer +0x14, 0x48fc9b..0x48fd0e: TFACTOR replaces it). For a
 * precomputed draw oD0.a = the .ldu vertex alpha x the object's opacity (xvsLightPrecomputed keeps
 * v10.w, c51.x = 1; the light footer multiplies by c80.w = opacity, 0x436c54).
 */
export function passTakesVertexAlpha(tint: number | undefined): boolean {
  return tintFactor(tint) === null;
}

/**
 * The colour resource's translucent flag [verified, .ldu loader 0x487610 at 0x487722..0x48777e]:
 * set when any colour of the record has alpha below 0xfe and is not the zero dword (black with
 * alpha 0 does not count). The object draw (0x498861..0x498873) then draws the object as
 * translucent: every pass blends and an opaque or cut-out pass becomes mode 1
 * (translucentPassBlend). `bgra`: the record's colours, 4 bytes each (B, G, R, A).
 */
export function lduColorsTranslucent(bgra: ArrayLike<number>): boolean {
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    const a = bgra[i + 3];
    if (a < 0xfe && (bgra[i] | bgra[i + 1] | bgra[i + 2] | a) !== 0) return true;
  }
  return false;
}

/**
 * Does any of the corners `vertices` (indices into the record's colours) have a vertex alpha
 * below 255? Surfaces without one draw exactly as before (no vertex-alpha term in the shader).
 */
export function lduVertexAlphaBelowOne(bgra: ArrayLike<number>, vertices: Iterable<number>): boolean {
  for (const v of vertices) if (bgra[4 * v + 3] < 255) return true;
  return false;
}

/**
 * Alpha test of a pass [verified, 0x48fb08..0x48fb4e]: modes 0 and 7 test ALWAYS (none), mode
 * 8 keeps alpha > 200 / 255, the other modes > 2 / 255, except an additive (mode 2) pass with
 * the glow mark (p5 / p7), which keeps alpha > 32 / 255. Returns the reference (0..1), or null
 * for no test. (A translucent object, opacity < 0.99, draws its mode 0 / 8 passes as mode 1
 * with the 2 / 255 test.)
 */
export function passAlphaRef(blend: number, glowMark = false): number | null {
  if (blend === 0 || blend === 7) return null;
  if (blend === 8) return 200 / 255;
  if (blend === 2 && glowMark) return 32 / 255;
  return 2 / 255;
}

/**
 * One pass blended into the back buffer as Direct3D 9 does it here: on gamma-encoded bytes (no
 * sRGB conversion anywhere), saturated to 0..1 after the blend. `src` is the pass's colour
 * after the texture stages, `a` its alpha, `dst` what the back buffer holds (gamma). The blend
 * factors are those of 0x49a990 (game-logic.md §16) [verified]; this is the reference the
 * renderer's gamma back buffer reproduces (engine-light.ts GAMMA_BACK_BUFFER).
 */
export function backBufferBlend(blend: number, src: number, a: number, dst: number): number {
  const sat = (v: number) => Math.min(1, Math.max(0, v));
  switch (blend) {
    case 1:
    case 8:
      return sat(src * a + dst * (1 - a));
    case 2:
      return sat(src * a + dst);
    case 4:
      return sat(dst - src * a);
    case 5:
      return sat(dst * a);
    case 6:
      return sat(2 * src * dst);
    case 7:
      return sat(src + dst * a);
    default:
      return sat(src);
  }
}

/**
 * TFACTOR of a tinted pass [verified, 0x48fcd7..0x48fd2c]: the halved tint in the colour bytes
 * (Advanced builder 0x490046 stores (c >> 1) & 0x7f7f7f | 0xff000000), and as alpha the layer
 * alpha (+0x48, 1 from the builders) × the object's opacity (+0xd0) when that product is not 1.
 * Before the passes the object draw (0x498a5c..0x498aa9) also sets TFACTOR alpha = opacity with
 * white colour and ALPHAARG2 = TFACTOR for an object below 0.99 opacity, but the pass builder
 * clears ALPHAARG2 = TFACTOR again for an untinted layer (0x48fd0e): untinted passes of a fading
 * object take its opacity through the vertex alpha instead (c80.w in the light footer,
 * passTakesVertexAlpha).
 */
export function tintFactorWord(tint: number, layerAlpha: number, opacity: number): number {
  const half = (((tint >>> 0) >> 1) & 0x7f7f7f) >>> 0;
  const a = layerAlpha * opacity;
  const alpha = a === 1 ? 0xff : Math.trunc(Math.min(1, Math.max(0, a)) * 255);
  return ((alpha << 24) | half) >>> 0;
}
