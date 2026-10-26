// The light a thrown object carries (docs/game-logic.md §4.5 "Flare key"). Decoded from
// Suffering.rfl [verified unless marked]:
//
// - Launching a Missile / BouncingObject (0x100cf8b0) spawns each Object Generator of its p36
//   at the object's matrix (0x100cfa88 -> 0x100cd100), owned by it (kept at +0x68) so they
//   follow it and go with it. The flare's thrown object 4:452 has p36 = 4:942, whose p0 spawns
//   a flame (MorphingModel 4:938) and Point Light 4:941 (p25: a Follower Object). No other
//   retail throwable lists a Point Light there.
// - Point Light 4:941: p0 colour 0x835745 (bytes / 255), p8 strength 1.8 m², omni (p9 0), p3
//   Lighting Effect 4:943: p0 / p1 running and looping, no colour curve (p8 empty), strength
//   p9 2.8125 -> p10 45 by the 12 s curve p11 4:109 (samples between half and full: 24..45 m²
//   most of the time). Rules as world/lights.ts: the strength channel replaces p8; the clock of a
//   light's own template advances twice per frame while the light is lit [inferred there].
// - The generator's own run ends the light and the flame: 4:942 has p21 = 10 s, p22 = 1 and p5
//   set, so 10 s after the launch it is destroyed and takes its spawns with it
//   (generatorSpawnsEnd); the flare itself lies on, unlit, to its p12 = 20 s.
// - The flame, MorphingModel 4:938 (world/morphing-model.ts), is drawn by the weapons system
//   following the thrown object's matrix (the generator's Follower Object 4:1190 has zero
//   offsets; the generator's p16..p20 turn nothing) [strong].
//
// The port feeds these to the engine lighting rig at the thrown object's position while it is
// in the world; `?lighting=legacy` keeps a three.js point light (weapons system).

import { engineColor, type EnginePointLight } from '../../app/engine-light';
import type { EntityPackageSet, PropValue } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import { readTemplate } from '../world/fx';
import { lightingEffectDef, lightingEffectK, type LightingEffectDef } from '../world/lights';
import { morphingModelDef, type MorphingModelDef } from '../world/morphing-model';

/** A Point Light a thrown object carries: engine colour (sign: negative light), p8, p9, its effect. */
export interface ThrownLightDef {
  r: number;
  g: number;
  b: number;
  /** Strength I (m²): the level at d metres is min(I / d², 2). */
  intensity: number;
  /** 0 omni, +1 lights only below it, -1 only above (p9 = 2 / 1). */
  hemi: number;
  /** The light's p3 Lighting Effect (strength / colour channels), if it has one. */
  fx?: LightingEffectDef;
  /** Seconds after the launch when its generator removes it (generatorSpawnsEnd; Infinity: with the object). */
  end?: number;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refs = (v: unknown): ResRef[] => (Array.isArray(v) ? v : v ? [v] : []).filter((r): r is ResRef => !!r && typeof r === 'object' && !Array.isArray(r) && typeof (r as ResRef).id === 'number');

/** Point Light template values -> the light (as world/lights.ts and the fx attachments read them). */
export function pointLightDef(v: PropValue[], pkgs: PackageSet): ThrownLightDef {
  const c = engineColor(num(v[0]));
  const sign = num(v[1]) ? -1 : 1;
  const hemi = num(v[9]) === 1 ? -1 : num(v[9]) === 2 ? 1 : 0;
  const fxRef = refs(v[3])[0];
  const fxT = fxRef && readTemplate(pkgs as unknown as EntityPackageSet, fxRef);
  const fx = fxT?.cls === 'Lighting Effect' ? lightingEffectDef(fxT.values, pkgs) : undefined;
  return { r: c.r * sign, g: c.g * sign, b: c.b * sign, intensity: Math.max(0, num(v[8], 1)), hemi, fx: fx && (fx.color || fx.power) ? fx : undefined };
}

/**
 * When an Object Generator takes what it spawned with it (s after its creation; Infinity: never
 * by itself) [verified, world/fx.ts Generator]: its run of p21 s ends (0x100b4590), the run
 * count p22 drops to 0 and the generator is destroyed (0x100b463f); with p5 set its destructor
 * (0x100b4dc0 -> 0x100b49e0) removes its spawns. With p22 above 1 it only goes off and its
 * spawns stay (no link restarts an owned generator). The flare's 4:942: p21 10, p22 1, p5 1, so
 * its flame and light go out 10 s after the launch while the flare lies on for its p12 = 20 s.
 */
export function generatorSpawnsEnd(gv: PropValue[]): number {
  const life = num(gv[21]);
  return life > 0 && Math.floor(num(gv[22])) === 1 && num(gv[5]) !== 0 ? life : Infinity;
}

/** What a BouncingObject's p36 generators spawn at its launch that the port draws. */
export interface ThrownGeneratorSpawns {
  lights: ThrownLightDef[];
  /** MorphingModels (the flare's flame 4:938). */
  morphs: { ref: ResRef; def: MorphingModelDef; end: number }[];
}

/** The Point Lights and MorphingModels of a BouncingObject's p36 generators. */
export function thrownGeneratorSpawns(pkgs: PackageSet, bouncing: ResRef): ThrownGeneratorSpawns {
  const epk = pkgs as unknown as EntityPackageSet;
  const t = readTemplate(epk, bouncing);
  const out: ThrownGeneratorSpawns = { lights: [], morphs: [] };
  for (const g of refs(t?.values[36])) {
    const gt = readTemplate(epk, g);
    if (gt?.cls !== 'Object Generator') continue;
    const end = generatorSpawnsEnd(gt.values);
    for (const s of refs(gt.values[0])) {
      const st = readTemplate(epk, s);
      if (st?.cls === 'Point Light') out.lights.push({ ...pointLightDef(st.values, pkgs), end });
      else if (st?.cls === 'MorphingModel') {
        const def = morphingModelDef(st.values);
        if (def) out.morphs.push({ ref: s, def, end });
      }
    }
  }
  return out;
}

/** The Point Lights of a BouncingObject's p36 generators (none: the object carries no light). */
export function thrownLightDefs(pkgs: PackageSet, bouncing: ResRef): ThrownLightDef[] {
  return thrownGeneratorSpawns(pkgs, bouncing).lights;
}

/**
 * The light `t` seconds after launch (the effect's clock runs twice per frame on a lit light),
 * written into `out` (colour, strength, hemisphere; the caller sets the position).
 */
export function thrownLightAt(d: ThrownLightDef, t: number, out: EnginePointLight): EnginePointLight {
  out.r = d.r;
  out.g = d.g;
  out.b = d.b;
  out.intensity = d.intensity;
  out.hemi = d.hemi;
  const fx = d.fx;
  if (fx) {
    const clock = (fx.start ? 2 : 1) * t;
    const kp = fx.power && lightingEffectK(fx.power, fx.loop, clock);
    if (fx.power && kp !== undefined) out.intensity = fx.power.a + (fx.power.b - fx.power.a) * kp;
    const kc = fx.color && lightingEffectK(fx.color, fx.loop, clock);
    if (fx.color && kc !== undefined) {
      const [a, b] = [fx.color.a, fx.color.b];
      out.r = a[0] + (b[0] - a[0]) * kc;
      out.g = a[1] + (b[1] - a[1]) * kc;
      out.b = a[2] + (b[2] - a[2]) * kc;
    }
  }
  return out;
}
