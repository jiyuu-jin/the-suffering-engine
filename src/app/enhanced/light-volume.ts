// Enhanced mode: soft light volumes (docs/enhanced.md "Light volumes", docs/re/renderer.md §5.3).
//
// The level's light shafts and pools are flat additive sheets: 1b's arena grate (Decoration 86c7,
// model 9:4284) is four boxes of 2 m walls, the 1a cell-lamp pools (7:292) cones of quads. Their
// textures fade the light along the height only, and the engine draws every wall at that alpha
// whatever the view (no view-angle term exists in its shader library), so each wall ends in a
// hard edge and a wall seen edge-on is a bright line. Original keeps exactly that. Enhanced fades
// each fragment by how squarely the wall faces the eye (|N·V|, from the flat face normal: the
// models' own normals point anywhere) and close to the camera (walking through a wall), so the
// sheets read as a volume of light instead of panes.
//
// Which surfaces: single-pass additive, tinted (unlit light), without the glow mark (fire and lamp
// cards stay as they are), drawn as level geometry (the renderer's merged parts: Decorations and
// Static Objects; Sky / Sun cards, pickups and props go through the prop cache and are untouched).

import { abs, dot, float, mix, normalFlat, positionView, positionViewDirection, smoothstep, uniform } from 'three/tsl';
import { Vector2 } from 'three/webgpu';
import { Blend, type MaterialLayer } from '../../formats/model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Fade ramps: |N·V| from `graze[0]` (gone) to `graze[1]` (full); view depth (m) from `near[0]` to `near[1]`. */
export const LIGHT_VOLUME = { graze: [0.1, 0.85] as const, near: [0.3, 1.5] as const };

/** Is a surface's pass list one of the light sheets Enhanced softens? */
export function isLightVolume(layers: readonly MaterialLayer[]): boolean {
  if (layers.length !== 1) return false;
  const l = layers[0];
  return l.blend === Blend.Add && l.tint !== undefined && !l.depthWrite;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** CPU twin of lightVolumeFade: `nv` = cos of the angle between the face normal and the eye, `depth` in m. */
export function lightVolumeFadeAt(nv: number, depth: number): number {
  return smooth(LIGHT_VOLUME.graze[0], LIGHT_VOLUME.graze[1], Math.abs(nv)) * smooth(LIGHT_VOLUME.near[0], LIGHT_VOLUME.near[1], depth);
}

/**
 * Shared uniforms (browser A/B and tuning: `import('/src/app/enhanced/light-volume.ts')`):
 * `strength` 1 applies the fade, 0 draws the sheets as Original does; the ramps start at LIGHT_VOLUME.
 */
export const lightVolumeUniforms = {
  strength: uniform(1),
  graze: uniform(new Vector2(...LIGHT_VOLUME.graze)),
  near: uniform(new Vector2(...LIGHT_VOLUME.near)),
};

/** Per-fragment fade of a light sheet (multiplies its alpha, i.e. the light it adds). */
export function lightVolumeFade(): N {
  const U = lightVolumeUniforms;
  const facing = smoothstep(U.graze.x, U.graze.y, abs(dot(normalFlat, positionViewDirection)));
  const near = smoothstep(U.near.x, U.near.y, positionView.z.negate());
  return mix(float(1), facing.mul(near), U.strength);
}
