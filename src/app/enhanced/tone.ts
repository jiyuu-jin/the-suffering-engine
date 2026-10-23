// Enhanced mode exposure model (docs/enhanced.md §Exposure): the constants every Enhanced shader
// shares for albedo, authored light, the flashlight and the tone curve, and CPU twins of the
// shader curves (tests, docs). No imports: tests read it without a renderer.
//
// The original's frame is display-referred: a pass is texture × light on gamma values, saturated
// at 1, shown as is. Enhanced re-renders it scene-referred (linear HDR) and must map it back
// without crushing the darks the original shows (they carry most of a horror game's frame) and
// without turning ordinary bright albedo into light sources:
//
//   albedo  = min(texture, ALBEDO_MAX)               a white texture reflects 80 %, not 100 %
//   light   = softLight(L)                           the engine light, saturating softly where the
//                                                    original clamps (LIGHT_CLAMP 400 / 255)
//   display = toneCurve(exposure × scene) per pixel  linear in the darks (a dark wall reads as in
//                                                    the original), an exponential shoulder above
//                                                    TONE.knee, applied to the brightest channel
//                                                    so hue survives (the gas chamber's green)
//   bloom   = only the energy above TONE.bloomThreshold (lamps, fire, glow-marked surfaces, the
//             flashlight's hot spot close up), never diffuse white

/** Highest albedo (linear reflectance) of a lit texture, and its gamma value. */
export const ALBEDO_MAX = 0.8;
export const ALBEDO_MAX_GAMMA = 1.055 * Math.pow(ALBEDO_MAX, 1 / 2.4) - 0.055;

/** Authored light above 1 (light units) saturates towards 1 + LIGHT_SOFT (the original clamps at 1.57). */
export const LIGHT_SOFT = 0.6;
/** Lamp shadows and AO keep at least this share of the authored light (no crushed baked light). */
export const SHADOW_KEEP = 0.35;
/** Light floor: this share of the ambient light of the camera's Ambient Light region. */
export const AMBIENT_FLOOR = 0.5;
/** Gain of glow-marked surfaces (the passes the original's scene glow blooms: bulbs, lamp glass). */
export const GLOW_GAIN = 4;

/** Grade / tone-curve defaults (post.ts uniforms). */
export const TONE = {
  exposure: 0.85,
  /** Linear up to this (max channel after exposure), then an exponential shoulder to 1. */
  knee: 0.5,
  /** Highlights whiten between these (max channel after exposure): only hot sources. */
  whiteStart: 2.5,
  whiteEnd: 12,
  saturation: 0.9,
  /** Display-space power about `pivot` (> 1 deepens the darks a little). */
  contrast: 1.02,
  pivot: 0.4,
  /** Bloom: scene-linear luminance (before exposure) above which energy blooms. */
  bloomThreshold: 2,
  bloomStrength: 0.45,
  /** GTAO share multiplied in. */
  ao: 0.5,
};

/** softLight (CPU twin): identity up to 1, then saturating towards 1 + LIGHT_SOFT. */
export function softLight(l: number): number {
  if (l <= 1) return Math.max(0, l);
  const o = l - 1;
  return 1 + o / (1 + o / LIGHT_SOFT);
}

/** Tone curve of the brightest channel (CPU twin of post.ts): linear below the knee, shoulder to 1. */
export function toneCurve(m: number, knee = TONE.knee): number {
  if (m <= knee) return Math.max(0, m);
  return knee + (1 - knee) * (1 - Math.exp(-(m - knee) / (1 - knee)));
}

const oetf = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** sRGB decode, extended above 1 (three's sRGBTransferEOTF). */
const eotf = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Display value (0..1) of a grey surface the original shows at gamma value `g` (texture × light,
 * no flashlight): Enhanced's albedo clamp, soft light, exposure, tone curve and contrast.
 * `tex` = the texture's gamma value, `light` = the engine light (light units); g = tex × light.
 */
export function displayOf(tex: number, light: number): number {
  const lin = eotf(Math.min(tex, ALBEDO_MAX_GAMMA) * softLight(light));
  const d = oetf(Math.min(1, toneCurve(lin * TONE.exposure)));
  return Math.min(1, TONE.pivot * Math.pow(d / TONE.pivot, TONE.contrast));
}
