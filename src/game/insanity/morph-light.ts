// The morph's light (docs/game-logic.md §13.10 step 2): the lead-in of a morph (Morph state,
// 0x100440f0) spawns the form's Player p274 Object Generator at the player; in the retail data
// that is 4:1250, whose p0 is the white Point Light 4:1248 (p8 0.05 m², omni) pulsed by Lighting
// Effect 4:1246 (strength 1.8 -> 7.2 m² by curve 4:107). The leave (0x10044280) destroys it.
// [verified: the call sites; the templates are data]
//
// Its clocks: the generator and the Lighting Effect run on the game clock, which the morph has
// slowed to 1 / p272 (128), so over the 3.4 / 3.7 s lead-in the effect's curve barely moves (as
// the p273 Screen Blur of the same call, which mostly shows after the morph) [strong: the same
// clock as every world object's update]. The generator's own run (p21 3.367 s, p22 1, p5 set)
// would end it after 3.367 game seconds, i.e. never within a morph.
//
// Port: the light goes to the engine lighting rig as a provider's point light (engine-light.ts
// addProvider), the same list the flare's light and the world's lamps use: no three.js light is
// added, so no lit material is rebuilt when the first morph starts (the rig's light slots are
// uniforms of a fixed size). Original and Enhanced both draw it.

import type { EntityPackageSet, PropValue } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import type { EnginePointLight } from '../../app/engine-light';
import { readTemplate } from '../world/fx';
import { generatorSpawnsEnd, pointLightDef, thrownLightAt, type ThrownLightDef } from '../weapons/thrown-light';

const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : v ? [v] : []).filter((r): r is ResRef => !!r && typeof r === 'object' && !Array.isArray(r) && typeof (r as ResRef).id === 'number');

/** The Point Lights an Object Generator (Player p274) spawns, with the generator's end (game s). */
export function morphLightDefs(pkgs: PackageSet, generator: ResRef | undefined): ThrownLightDef[] {
  if (!generator) return [];
  const epk = pkgs as unknown as EntityPackageSet;
  const g = readTemplate(epk, generator);
  if (g?.cls !== 'Object Generator') return [];
  const end = generatorSpawnsEnd(g.values);
  const out: ThrownLightDef[] = [];
  for (const s of refs(g.values[0])) {
    const t = readTemplate(epk, s);
    if (t?.cls === 'Point Light') out.push({ ...pointLightDef(t.values, pkgs), end });
  }
  return out;
}

/** The morph's lights at the player while a morph runs (insanity/system.ts). */
export class MorphLight {
  private defs: ThrownLightDef[] = [];
  private readonly at = { x: 0, y: 0, z: 0 };
  /** Game seconds since the morph started (its clock is slowed with the world's). */
  t = 0;
  private readonly pool: EnginePointLight[] = [];

  get active(): boolean {
    return this.defs.length > 0;
  }

  /** The lead-in starts: spawn the generator's lights at the player's position. */
  start(defs: ThrownLightDef[], at: { x: number; y: number; z: number }) {
    this.defs = defs;
    this.at.x = at.x;
    this.at.y = at.y;
    this.at.z = at.z;
    this.t = 0;
  }

  /** The Morph state's leave destroys them. */
  stop() {
    this.defs = [];
  }

  /** Advance by the game clock's dt. */
  step(gameDt: number) {
    if (this.defs.length) this.t += Math.max(0, gameDt);
  }

  /** Engine-light provider: the lights for this frame. */
  write(out: EnginePointLight[]) {
    let n = 0;
    for (const d of this.defs) {
      if (this.t >= (d.end ?? Infinity)) continue;
      const l = (this.pool[n++] ??= { x: 0, y: 0, z: 0, intensity: 0, r: 0, g: 0, b: 0, hemi: 0 });
      thrownLightAt(d, this.t, l);
      l.x = this.at.x;
      l.y = this.at.y;
      l.z = this.at.z;
      out.push(l);
    }
  }
}
