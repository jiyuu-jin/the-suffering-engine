// Enhanced mode: the per-frame light choice and the uniforms every Enhanced shader shares.
//
// The sources are the original's own lights, as the engine light rig uploads them each frame
// (engine-light.ts): the level's Point Lights (static and switchable, Light Housings, Lighting
// Effects: flicker, alarms), effect lights (muzzle flashes, fires, sparks), the Directional Light
// base lights of the light regions, the Ambient Light regions and the level fog. Enhanced only
// re-evaluates them per pixel with modern models:
//   - the flashlight: a physically based spot (inverse square, cone with a soft penumbra and a
//     generated lens "cookie"), shadow-mapped, GGX specular;
//   - the strongest lamps near the camera: GGX specular; the first TierFeatures.lampShadows of
//     them cube shadow-mapped (their share of the engine light is taken out where occluded);
//   - the dominant directional light (moonlight): a shadow map for volumetric shafts.

import * as THREE from 'three/webgpu';
import { renderGroup, step, uniform, uniformArray } from 'three/tsl';
import { CULL_LUMA, RANK_LUMA, spotConstants } from '../../formats/render-data';
import { FLASHLIGHT_BASE_INTENSITY, FLASHLIGHT_SPOTS, engineLightInternals, engineLights } from '../engine-light';
import { AMBIENT_FLOOR, GLOW_GAIN } from './tone';
import { lampAxis } from '../held-lamp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Lamps with per-pixel specular (TierFeatures.specularLights ≤ this). */
export const MAX_SPEC_LAMPS = 8;
/** Lamps with cube shadow maps (TierFeatures.lampShadows ≤ this). */
export const MAX_SHADOW_LAMPS = 2;
/** Reach of a lamp cube shadow map (m): distances are stored as a fraction of it. */
export const LAMP_SHADOW_RANGE = 24;
/**
 * Occluders this close to a shadowed lamp (m) are its own fixture (the shade, cage or bulb of a
 * Light Housing, often drawn in a prop batch with every other lamp of the level) and cast no
 * shadow of it: the original's baked and point light light the room the shade would hide, and a
 * shade in the cube map took that light away (High / Ultra corridors went black around lamps).
 */
export const LAMP_FIXTURE = 1.2;
/** Lit (1) or not (0) by a lamp cube map: `dist` and the stored `occluder` as fractions of the range. */
export const lampLit = (dist: N, occluder: N): N => step(dist, occluder).max(step(occluder, LAMP_FIXTURE / LAMP_SHADOW_RANGE));
/**
 * Where the original's beam starts: its vertex shader lights nothing nearer than c10.w along the
 * beam's axis [verified, render-data.ts spotConstants: R·S / (L − S) from Spot Light p8..p10;
 * the flashlight's beam 1 / 6 / 10 gives 2 m]. Enhanced fades its beam in across that distance,
 * measured along the axis as the original does, from FLASH_START_RAMP[0] before it to
 * FLASH_START_RAMP[1] after (the original's per-vertex step is as soft across a floor's large
 * triangles, and it starts a little early there), so a floor, a cell door or a face at arm's
 * length reads as in the original, by the room's own light. (A fade over the metre before 2 m
 * left the cell row floor close-up at 1.4 × the original; −0.3 / +0.3 m gave 0.98 × with 14 %
 * near black where Enhanced's lamp shadows fall, −0.45 / +0.3 m about 1.1 × and 11 %.)
 */
export const FLASH_BEAM_START = spotConstants(FLASHLIGHT_SPOTS[0]).start;
export const FLASH_START_RAMP = [0.45, 0.3] as const;
/** Flashlight beam: cone half-angles (outer, inner), reach (m) and start along the axis (m). */
export const FLASH = { outer: THREE.MathUtils.degToRad(26), inner: THREE.MathUtils.degToRad(9), range: 26, spillOuter: THREE.MathUtils.degToRad(55), start: FLASH_BEAM_START };
/**
 * Flashlight radiance (linear, × the battery): the irradiance on the axis is POWER / (d² + NEAR),
 * × 1.37 in the cookie's hot centre. Matched to the original's beam (Spot Light 4:123: colour 0.78 ×
 * at most 4 on the axis, clamped at 400 / 255 light units, so ≈ 2.7 linear at most, in a narrower
 * cone): about 2.2 at arm's length, 1.5 at 3 m, 0.75 at 6 m; it reaches further than the
 * original's 7 m, falling off, and its wider cone and spill put about as much light into a room.
 * (45 / (d² + 5) gave 12 at arm's length: pale walls and leaves blew out to glowing white.)
 */
const FLASH_POWER = 30;
export const FLASH_NEAR = 18;
const FLASH_COLOR = new THREE.Color(1.0, 0.9, 0.74);

const lampData = Array.from({ length: MAX_SPEC_LAMPS * 2 }, () => new THREE.Vector4());

/** Uniforms shared by every draw (renderGroup). */
export const EU: Record<string, N> = {
  time: uniform(0),
  // Flashlight.
  flPos: uniform(new THREE.Vector3()),
  flDir: uniform(new THREE.Vector3(0, 0, -1)),
  /** Linear radiance × battery; zero when off. */
  flColor: uniform(new THREE.Vector3()),
  /** cos(outer), cos(inner), cos(spill outer), spill share. */
  flCone: uniform(new THREE.Vector4(Math.cos(FLASH.outer), Math.cos(FLASH.inner), Math.cos(FLASH.spillOuter), 0.04)),
  flRange: uniform(FLASH.range),
  /** The beam's start along its axis: fades in from x to y (m). */
  flStart: uniform(new THREE.Vector2(FLASH.start - FLASH_START_RAMP[0], FLASH.start + FLASH_START_RAMP[1])),
  flShadowMatrix: uniform(new THREE.Matrix4()),
  flShadowOn: uniform(0),
  flShadowTexel: uniform(1 / 1024),
  /** PCF taps of the shadow lookups. */
  taps: uniform(4, 'int'),
  /** 1 on WebGPU (render-target v runs down). */
  flipY: uniform(0),
  // Lamps: entry 2i = position, I (engine p8); 2i+1 = linear colour (engine units), shadow slot (-1 none).
  lampCount: uniform(0, 'int'),
  // Shadowed lamps: position (w = 1 when active), engine colour × I as the lamp's light-unit scale.
  shadowLamp0: uniform(new THREE.Vector4()),
  shadowLamp1: uniform(new THREE.Vector4()),
  shadowLampColor0: uniform(new THREE.Vector4()),
  shadowLampColor1: uniform(new THREE.Vector4()),
  // Moonlight (volumetric shafts): direction towards the light, colour, ortho shadow matrix.
  moonDir: uniform(new THREE.Vector3(0, 1, 0)),
  moonColor: uniform(new THREE.Vector3()),
  moonMatrix: uniform(new THREE.Matrix4()),
  moonOn: uniform(0),
  // Surfaces.
  /** Wet floors: roughness of up-facing surfaces (the rest use `roughness`). */
  floorRoughness: uniform(0.38),
  roughness: uniform(0.68),
  specular: uniform(0.55),
  /** Gain on the engine's light (its light units, linearised). */
  engineGain: uniform(1),
  /** Projected character shadows kept (0..1): off once real shadow maps take over. */
  projected: uniform(1),
  /** Fog: gain on the level's fog colour, and a floor on the fog amount near the camera. */
  fogGain: uniform(1),
  /** Light floor (light units): AMBIENT_FLOOR × the ambient of the camera's region. */
  ambientFloor: uniform(new THREE.Vector3()),
  /** Gain of glow-marked surfaces (emitters; tone.ts GLOW_GAIN). */
  glowGain: uniform(GLOW_GAIN),
};
for (const k in EU) EU[k].setGroup(renderGroup);
export const lampArray: N = uniformArray(lampData, 'vec4').setGroup(renderGroup);

const sRGBToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const signedLinear = (c: number) => Math.sign(c) * sRGBToLinear(Math.min(1, Math.abs(c)));

export interface LampPick {
  slot: number;
  x: number;
  y: number;
  z: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
  score: number;
}

/**
 * Per-frame CPU side: flashlight uniforms from the renderer's SpotLight, the lamp lists from the
 * rig's uploaded point lights, the moonlight from its directional lights.
 */
export class EnhancedLights {
  readonly picks: LampPick[] = [];
  /** Lamps given a cube shadow map this frame (indices into `picks`), stable across frames. */
  readonly shadowed: (LampPick | null)[] = [null, null];
  private readonly cam = new THREE.Vector3();
  moon: { dir: THREE.Vector3; color: THREE.Color } | null = null;

  update(camera: THREE.Camera, flashlight: THREE.SpotLight, features: { specularLights: number; lampShadows: number }, time: number) {
    EU.time.value = time;
    const cam = camera.getWorldPosition(this.cam);
    // Flashlight: the beam follows the view axis (engine-light.ts update), from the lamp's offset.
    const on = flashlight.visible && flashlight.intensity > 0 && !!flashlight.parent;
    const k = on ? flashlight.intensity / FLASHLIGHT_BASE_INTENSITY : 0;
    flashlight.getWorldPosition(EU.flPos.value);
    // The holder's view axis: the player's while a security monitor's feed has the camera (held-lamp.ts).
    lampAxis(flashlight, camera, EU.flDir.value);
    EU.flColor.value.set(FLASH_COLOR.r, FLASH_COLOR.g, FLASH_COLOR.b).multiplyScalar(FLASH_POWER * k);

    // Lamps: the rig's uploaded point lights ranked by their light at the camera.
    const { pointA, pointB, u } = engineLightInternals();
    const n = u.points.value as number;
    const picks = this.picks;
    picks.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pointA[i], b = pointB[i];
      const luma = b.x * RANK_LUMA[0] + b.y * RANK_LUMA[1] + b.z * RANK_LUMA[2];
      if (!(luma > 0.02) || !(a.w > 0)) continue;
      const d2 = (a.x - cam.x) ** 2 + (a.y - cam.y) ** 2 + (a.z - cam.z) ** 2;
      // Reach of the engine's cull radius (render-data.ts pointLightCullRadius).
      const reach2 = (a.w * Math.max(0, b.x * CULL_LUMA[0] + b.y * CULL_LUMA[1] + b.z * CULL_LUMA[2])) / 0.1;
      if (d2 > reach2 * 2.25 + 100) continue;
      picks.push({ slot: i, x: a.x, y: a.y, z: a.z, intensity: a.w, r: b.x, g: b.y, b: b.z, score: (luma * a.w) / Math.max(d2, 1) });
    }
    picks.sort((p, q) => q.score - p.score);
    // Cube shadows: keep last frame's lamps while they are still in the list (no flip-flop).
    const want = Math.min(features.lampShadows, MAX_SHADOW_LAMPS);
    for (let s = 0; s < MAX_SHADOW_LAMPS; s++) {
      const prev = this.shadowed[s];
      const still = prev && picks.find((p) => Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) + Math.abs(p.z - prev.z) < 0.05);
      this.shadowed[s] = s < want && still ? still : null;
    }
    for (let s = 0; s < want; s++) {
      if (this.shadowed[s]) continue;
      const free = picks.slice(0, 4).find((p) => p.score > 0.004 && !this.shadowed.includes(p));
      this.shadowed[s] = free ?? null;
    }
    const m = Math.min(features.specularLights, MAX_SPEC_LAMPS, picks.length);
    for (let i = 0; i < m; i++) {
      const p = picks[i];
      lampData[2 * i].set(p.x, p.y, p.z, p.intensity);
      lampData[2 * i + 1].set(signedLinear(p.r), signedLinear(p.g), signedLinear(p.b), this.shadowed.indexOf(p));
    }
    EU.lampCount.value = m;
    for (let s = 0; s < MAX_SHADOW_LAMPS; s++) {
      const p = this.shadowed[s];
      const pos = s ? EU.shadowLamp1.value : EU.shadowLamp0.value;
      const col = s ? EU.shadowLampColor1.value : EU.shadowLampColor0.value;
      if (p) {
        pos.set(p.x, p.y, p.z, 1);
        col.set(p.r, p.g, p.b, p.intensity);
      } else {
        pos.w = 0;
        col.set(0, 0, 0, 0);
      }
    }

    // Light floor: the ambient light (engine units) of the camera's Ambient Light region, by the
    // engine's own rule for objects (smallest region first, else the level's global ambient).
    EU.ambientFloor.value.copy(engineLights.objectLightSet(camera).ambient).multiplyScalar(AMBIENT_FLOOR);

    // Moonlight: the strongest non-rim directional light whose region holds the camera.
    let best = 0;
    this.moon = null;
    for (const d of engineLights.directionals) {
      if (d.rim || !d.on) continue;
      if (d.box && !d.box.containsPoint(cam)) continue;
      const l = d.color.r * 0.3 + d.color.g * 0.59 + d.color.b * 0.11;
      if (l > best) (best = l), (this.moon = { dir: d.dir, color: d.color });
    }
    if (this.moon && best > 0.03) {
      EU.moonDir.value.copy(this.moon.dir).normalize();
      EU.moonColor.value.set(signedLinear(this.moon.color.r), signedLinear(this.moon.color.g), signedLinear(this.moon.color.b));
    } else {
      this.moon = null;
      EU.moonColor.value.set(0, 0, 0);
    }
  }
}

export const enhancedLights = new EnhancedLights();
