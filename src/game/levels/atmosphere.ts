// Level start atmosphere: Level Properties p10 names the level's initial Sky Properties
// (class 0x4f594492, System, 10 properties) [verified: every level's Level Properties p10
// is a Sky Properties template; Fog / Sky Switchers name the same class in their p0].
//
// Sky Properties [verified: Suffering.rfl 0x1012b2f0 copies p0..p8 into the level's sky state,
// 0x100b1460 sets the fog from p2 / p3, 0x1012ad70 writes the sky dome texture and the fog
// colour]: p2 fog distance (m: 35..90 indoors and in the yards, 240 for the Prelude's sunset
// sea view), p3 fog start fraction (0.4..1), p4 horizon / fog colour, p5 sky colour
// (0xRRGGBB; black in most interiors), p6 / p7 the dome strip's horizon band and gradient
// fractions (sky.ts), p8 (float, 0 in all but three templates) how far the fog colour moves
// from p4 towards p5, p9 the Sky / Sun layer templates drawn with it, p0 = 90 / p1 = 0.65 not
// read here.
//
// The engine's fog is linear vertex fog (xvsHeaderFog.vsh: oFog = 1 − (z − start) × c[50].z,
// c[50] = [start, ?, 1 / (end − start), …], SUFFERING.EXE 0x437630) blended in gamma space.
// The port reads end = p2, start = p3 × p2 and the fog colour p4 [inferred: names from the
// value ranges] for every level (engine-light.ts EngineFog / engineFogNode).
// `?lighting=legacy`: the previous exponential fog (density = 1.4 / p2, colour p5 else p4,
// chapter 1 keeping the renderer's own tuned fog).

import * as THREE from 'three/webgpu';
import type { LevelRenderer } from '../../app/renderer';
import type { World } from '../world/logic';
import { readObjectTemplate, decodeTemplateProps, classByHash, type EntityPackageSet } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { EngineFog, LEGACY_LIGHTING } from '../../app/engine-light';

const SKY_PROPERTIES = 0x4f594492;
const CHAPTER_1 = /(^|[\\/])1 PrisonDeathRow[\\/]/i;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface Atmosphere {
  template: string;
  fogDistance: number;
  color: number;
  density: number;
}

/**
 * The sky dome is coloured by src/game/levels/sky.ts; lights.ts (which owns the Sky / Sun
 * objects) skips its stand-in night gradient while this is set.
 */
export const SKY_DOME = { levels: true };

/** Mix of two 0xRRGGBB colours per byte (the engine lerps the packed colour bytes). */
export function lerpColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  let out = 0;
  for (const sh of [16, 8, 0]) out |= Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k) << sh;
  return out;
}

/**
 * Linear fog of a Sky Properties template: start / end (m) and colour (0xRRGGBB). The colour
 * is p4 moved towards p5 by p8 (a float; 0.4 in three templates, else 0) [verified: the sky
 * writer 0x1012ad70 sets the fog colour to lerp(p4, p5, p8)].
 */
export function skyFog(v: readonly unknown[]): { near: number; far: number; color: number } {
  const far = Math.max(5, num(v[2], 45));
  const frac = Math.min(0.98, Math.max(0, num(v[3], 0.6)));
  const t = num(v[8]);
  const color = lerpColor(num(v[4]) & 0xffffff, num(v[5]) & 0xffffff, t > 0 && t <= 1 ? t : 0);
  return { near: far * frac, far, color };
}

export function applyLevelAtmosphere(world: World, pkgs: EntityPackageSet, view: LevelRenderer, levelPath: string): Atmosphere | undefined {
  if (LEGACY_LIGHTING && CHAPTER_1.test(levelPath)) return undefined;
  const lp = world.of('Level Properties')[0];
  const r = lp?.e.values[10] as ResRef | null | undefined;
  if (!r || typeof r !== 'object') return undefined;
  const t = readObjectTemplate(pkgs, r);
  if (!t || t.classHash !== SKY_PROPERTIES) return undefined;
  const v = decodeTemplateProps(classByHash(SKY_PROPERTIES), t);
  if (!LEGACY_LIGHTING && view.fog instanceof EngineFog) {
    const f = skyFog(v);
    view.fog.near = f.near;
    view.fog.far = f.far;
    view.fog.color.setHex(f.color, THREE.SRGBColorSpace);
    if (view.scene.background instanceof THREE.Color) view.scene.background.setHex(f.color, THREE.SRGBColorSpace);
    const far = Math.max(view.camera.far, f.far * 2);
    if (far !== view.camera.far) {
      view.camera.far = far;
      view.camera.updateProjectionMatrix();
    }
    return { template: `${r.pkg}:${r.id}`, fogDistance: f.far, color: f.color, density: view.fog.density };
  }
  const dist = num(v[2], 45);
  const color = (num(v[5]) || num(v[4])) & 0xffffff;
  const density = Math.min(0.06, Math.max(0.003, 1.4 / Math.max(dist, 1)));
  const fog = view.fog;
  fog.color.setHex(color);
  fog.density = density;
  if (view.scene.background instanceof THREE.Color) view.scene.background.setHex(color);
  // Wide outdoor views need the far plane past the fog.
  const far = Math.max(view.camera.far, dist * 4);
  if (far !== view.camera.far) {
    view.camera.far = far;
    view.camera.updateProjectionMatrix();
  }
  return { template: `${r.pkg}:${r.id}`, fogDistance: dist, color, density };
}
