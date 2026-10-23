// Level lights and environment (docs/game-logic.md §14.4):
//
//   * Point / Spot Light on/off by message (p4 On, p5 Off; p6 = on at start [strong: lights
//     with p6 = 0 are exactly the ones scripts turn on]) and Lighting Effect flicker.
//     Every light that is on feeds the engine lighting rig (src/app/engine-light.ts) with its
//     colour (p0 / 255, negated when p1 is set), strength p8 (I = p8 × 2048² engine units: the
//     level is min(p8 / d², 2) in metres, render-data.ts pointLightLevel) and hemisphere mode p9
//     (1 = lights only above it, 2 = only below) [verified: SUFFERING.EXE 0x4c5fd0 / 0x4c60b0 /
//     0x4d06e4].
//     Only switchable Point Lights (render-data.ts pointLightSwitchable) light geometry with
//     precomputed colours at run time; static ones are in the .ldu bake (vertices lit only by
//     switchable lights keep the flat ambient colour, those near static ones are brighter)
//     and light dynamic objects only [verified: 0x4c6ca0, 0x4ca730; docs/re/renderer.md §1.6].
//     `?lighting=legacy` keeps the old pool of three.js point lights that rendered only the
//     difference from an assumed bake.
//   * Ambient Light: p0 colour, applying within its parent group of the sector tree; the one
//     under the root group is the level's global ambient (c[80], engine-light.ts), the others
//     set the ambient of dynamic objects in their group's box, the smallest region winning
//     (docs/re/renderer.md §1.4). Levels without a sector tree: the unscaled one is global and
//     scaled ones are boxes (instance scale).
//   * Lighting Effect [verified: SUFFERING.EXE init 0x4c4c40, update 0x4c5820, channels
//     0x4c4f20 / 0x4c5450, map 0x5ba480]: a clock t (s) drives two waveform channels; each
//     samples its .wdu curve at fmod(t, duration) (p1 = loop; without it a channel stops once t
//     reaches the duration and the light keeps the last value), maps the sample s to
//     k = (s + 1) / 2 and writes into the lights it drives:
//       - colour: p8 curve, colour = lerp(p6, p7, k) (bytes / 255), replacing the light's p0;
//       - strength: p11 curve, I = lerp(p9, p10, k), replacing the Point Light's p8.
//     A channel whose curve is unset leaves that value alone (white p6 / p7 are unused then).
//     Placed ones drive their linked Point / Spot Lights; p0 starts the clock, p2 On / p3 Off
//     start / stop it (the light keeps the values it had), p4 Destroy. A light's p3 template is
//     attached to that light: its clock runs while p0 is set and is also advanced by the
//     light's own update while the light is on (0x4c7b09), so a p0 = 1 template runs at twice
//     the wall-clock rate on a lit light [inferred: both paths reach 0x4c5820 unguarded]. The
//     spot cone channels (p12..p17) have no retail use and are not ported.
//   * Sky / Sun: sky dome layers drawn around the camera (the layer marked p6 = 1 is the dome
//     centre; the others keep their offset from it); inputs p4 On / p5 Off.
//   * Fog / Sky Switcher: On (p3) blends the scene fog to the Sky Properties p0 over p2
//     seconds (linear fog: end p2 m, start p3 × p2, colour p4; atmosphere.ts).
//   * Directional Light: rim lights only (src/game/fx/rim.ts).

import * as THREE from 'three/webgpu';
import { mix, positionLocal, vec3 } from 'three/tsl';
import { cloneWithGlowMark } from '../../app/glow-mark';
import { EngineFog, LEGACY_LIGHTING, engineColor, engineLights, type AmbientBox, type EnginePointLight } from '../../app/engine-light';
import { entityBoxCorners } from '../../formats/entities';
import { instanceRotation } from '../../formats/level';
import { skyFog, SKY_DOME } from '../levels/atmosphere';
import type { PropValue } from '../../formats/entities';
import { readWaveform, waveformSample, type PackageSet, type ResRef, type Waveform } from '../../formats/model';
import { isSwitchablePointLight } from '../../formats/static-light';
import { instanceMatrix, type DynamicObjects } from './dynamic';
import type { World, WorldEntity } from './logic';
import { colorOf, readTemplate } from './fx';
import type { EntityPackageSet } from '../../formats/entities';
import type { LightRegion } from '../../formats/visgraph';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);

const POOL = 8;
/** Scale from the engine radius to a three.js point light (intensity at the centre). */
const INTENSITY = 6;
/** Strength of the negative light standing in for a baked light that was switched off. */
const INTENSITY_OFF = 14;

/** One waveform channel of a Lighting Effect: value = lerp(a, b, (sample + 1) / 2). */
export interface FxChannel<T> {
  wave: Waveform;
  a: T;
  b: T;
}

/** Decoded Lighting Effect properties (see the header). */
export interface LightingEffectDef {
  /** p0: the clock runs from the start. */
  start: boolean;
  /** p1: curves loop; otherwise each channel stops at its curve's end. */
  loop: boolean;
  /** p8 curve, p6 -> p7 colours (0..1 RGB, as the engine divides the bytes by 255). */
  color?: FxChannel<[number, number, number]>;
  /** p11 curve, p9 -> p10 Point Light strength (p8 units, m²). */
  power?: FxChannel<number>;
}

const rgb = (v: unknown): [number, number, number] => {
  const c = num(v) >>> 0;
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
};

/** Lighting Effect properties -> channels (curves resolved from the packages' .wdu). */
export function lightingEffectDef(v: PropValue[], pkgs: PackageSet): LightingEffectDef {
  const wave = (i: number) => {
    const r = ref(v[i]);
    const w = r ? readWaveform(pkgs, r) : undefined;
    return w && w.duration > 0 ? w : undefined;
  };
  const cw = wave(8), pw = wave(11);
  return {
    start: num(v[0], 1) !== 0,
    loop: num(v[1], 1) !== 0,
    color: cw && { wave: cw, a: rgb(v[6]), b: rgb(v[7]) },
    power: pw && { wave: pw, a: num(v[9]), b: num(v[10]) },
  };
}

/** k = (s + 1) / 2 of a channel at clock t, or undefined once a non-looping curve has ended. */
export function lightingEffectK(ch: FxChannel<unknown>, loop: boolean, t: number): number | undefined {
  const d = ch.wave.duration;
  if (!loop && d <= t) return undefined;
  return (waveformSample(ch.wave, t % d, 0) + 1) * 0.5;
}

/** A running Lighting Effect. */
interface LightFx {
  def: LightingEffectDef;
  /** Lights it writes (uids). */
  targets: number[];
  /** Attached to this light (a Point / Spot Light's p3 template). */
  owner?: number;
  /** Own clock running (+0x18 / update flag: p0, On, Off). */
  on: boolean;
  t: number;
}

interface LightRec {
  uid: number;
  w: WorldEntity;
  pos: THREE.Vector3;
  color: THREE.Color;
  /** Reach of the legacy three.js pool light (p8, at least 1). */
  radius: number;
  /** Engine strength I = p8 (m²). */
  intensity: number;
  baked: boolean;
  on: boolean;
  /** Spot Light (Lighting Effect strength applies to Point Lights only). */
  spot: boolean;
  /** Colour / strength written by a Lighting Effect (replace p0 / p8 once set). */
  fxColor?: THREE.Color;
  fxPower?: number;
  /** Engine colour (p0 / 255, negative for p1) and hemisphere mode (engine-light.ts). */
  raw: THREE.Color;
  hemi: number;
  /** Switchable (light flag 2): also lights geometry with precomputed colours at run time. */
  switchable: boolean;
  /** Reused record handed to the engine rig each frame (no per-frame garbage, §18). */
  out?: EnginePointLight;
}

export interface LightsSaveState {
  on: Record<string, number>;
  /** Lighting Effect clocks running (key: light uid for templates, e<uid> for placed ones). */
  fx: Record<string, number>;
  /** Lighting Effect clocks (s). */
  ft?: Record<string, number>;
}

export class Lights {
  readonly lights = new Map<number, LightRec>();
  private readonly pool: THREE.PointLight[] = [];
  readonly group = new THREE.Group();
  private sky: { root: THREE.Object3D; offset: THREE.Vector3; uid: number }[] = [];
  private skyMats: THREE.Material[] = [];
  private fogBlend?: { from: THREE.Color; to: THREE.Color; d0: number; d1: number; t: number; dur: number; near?: [number, number]; far?: [number, number] };
  private removeProvider?: () => void;
  /** Lighting Effects: placed ones by `e<uid>`, light templates by the light's uid. */
  private readonly fx = new Map<string, LightFx>();

  constructor(
    readonly world: World,
    readonly pkgs: EntityPackageSet,
    readonly dyn: DynamicObjects,
    readonly fog: THREE.FogExp2 | null,
    /** Ambient / Directional Light regions (LevelData.lightRegions). */
    private readonly regions?: ReadonlyMap<number, LightRegion>,
  ) {
    this.group.name = 'world-lights';
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1, 1);
      l.visible = true;
      this.pool.push(l);
      this.group.add(l);
    }
    for (const cls of ['Point Light', 'Spot Light']) {
      for (const w of world.of(cls)) {
        const v = w.e.values;
        const baked = num(v[6], 1) !== 0;
        const rec: LightRec = {
          uid: w.uid,
          w,
          pos: new THREE.Vector3(...w.pos),
          color: colorOf(v[0]),
          radius: Math.max(1, num(v[8], 6)),
          intensity: Math.max(0, num(v[8], 6)),
          baked,
          on: baked,
          spot: cls === 'Spot Light',
          raw: engineColor(num(v[0])).multiplyScalar(num(v[1]) ? -1 : 1),
          hemi: num(v[9]) === 1 ? -1 : num(v[9]) === 2 ? 1 : 0,
          // Spot Light objects (one retail instance, switchable) keep lighting everything.
          switchable: cls !== 'Point Light' || isSwitchablePointLight(w.e),
        };
        this.lights.set(w.uid, rec);
        // p3: a Lighting Effect created for and attached to this light (0x4c6d64).
        const tpl = ref(v[3]);
        const tv = tpl && readTemplate(pkgs, tpl)?.values;
        if (tv) this.addFx(String(w.uid), tv, [w.uid], w.uid);
      }
    }
    // Placed Lighting Effects drive the Point / Spot Lights they link to (0x4c4d46).
    for (const w of world.of('Lighting Effect')) this.addFx(`e${w.uid}`, w.e.values, w.e.links.filter((u) => this.lights.has(u)));
    this.initSky();
    world.handlers.push((w, msg) => this.onMessage(w, msg));
    if (!LEGACY_LIGHTING) {
      this.removeProvider = engineLights.addProvider((out) => this.engineLightsOut(out));
      this.initAmbient();
    }
  }

  /** Lights that are on, for the engine lighting rig (flicker applied in update()). */
  private engineLightsOut(out: EnginePointLight[]) {
    for (const r of this.lights.values()) {
      if (!r.on || r.w.destroyed) continue;
      const c = r.fxColor ?? r.raw;
      const intensity = r.fxPower ?? r.intensity;
      if ((c.r === 0 && c.g === 0 && c.b === 0) || !(intensity > 0)) continue;
      const o = (r.out ??= { x: 0, y: 0, z: 0, intensity: 0, r: 0, g: 0, b: 0, hemi: 0, baked: false });
      o.x = r.pos.x;
      o.y = r.pos.y;
      o.z = r.pos.z;
      o.intensity = intensity;
      o.r = c.r;
      o.g = c.g;
      o.b = c.b;
      o.hemi = r.hemi;
      o.baked = r.switchable;
      out.push(o);
    }
  }

  /** Ambient Lights: the root group's one is the level's global ambient, the others regions (header). */
  private initAmbient() {
    let global: THREE.Color | undefined;
    const boxes: AmbientBox[] = [];
    for (const w of this.world.of('Ambient Light')) {
      const color = engineColor(num(w.e.values[0]));
      const exclusive = num(w.e.values[8], 1) !== 0;
      const reg = this.regions?.get(w.uid);
      if (reg) {
        if (!reg.box) global ??= color;
        else boxes.push({ min: new THREE.Vector3(reg.box[0], reg.box[1], reg.box[2]), max: new THREE.Vector3(reg.box[3], reg.box[4], reg.box[5]), color, exclusive });
        continue;
      }
      const corners = w.e.scale ? entityBoxCorners(w.e, instanceRotation) : undefined;
      if (!corners) {
        global ??= color;
        continue;
      }
      const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const c of corners) {
        const p = new THREE.Vector3(c[0] / 2048, c[1] / 2048, c[2] / 2048);
        min.min(p);
        max.max(p);
      }
      boxes.push({ min, max, color, exclusive });
    }
    // No global Ambient Light: a dim default (the engine warns "No ambient light").
    engineLights.setAmbient(global ?? new THREE.Color(0.15, 0.15, 0.15), boxes);
  }

  private addFx(key: string, v: PropValue[], targets: number[], owner?: number) {
    const def = lightingEffectDef(v, this.pkgs as PackageSet);
    if (!def.color && !def.power) return;
    this.fx.set(key, { def, targets, owner, on: def.start, t: 0 });
  }

  /** Clock steps this frame: own update (on) + the owning light's update while it is lit. */
  private fxTicks(f: LightFx): number {
    const o = f.owner !== undefined ? this.lights.get(f.owner) : undefined;
    return (f.on ? 1 : 0) + (o && o.on && !o.w.destroyed ? 1 : 0);
  }

  /** Write a Lighting Effect's channels at its clock into its lights (0x4c4f20 / 0x4c5450). */
  private applyFx(f: LightFx) {
    const { color, power, loop } = f.def;
    const kc = color && lightingEffectK(color, loop, f.t);
    const kp = power && lightingEffectK(power, loop, f.t);
    for (const u of f.targets) {
      const r = this.lights.get(u);
      if (!r) continue;
      if (color && kc !== undefined) {
        const [a, b] = [color.a, color.b];
        (r.fxColor ??= new THREE.Color()).setRGB(a[0] + (b[0] - a[0]) * kc, a[1] + (b[1] - a[1]) * kc, a[2] + (b[2] - a[2]) * kc, THREE.LinearSRGBColorSpace);
      }
      if (power && kp !== undefined && !r.spot) r.fxPower = power.a + (power.b - power.a) * kp;
    }
  }

  setLight(uid: number, on: boolean) {
    const r = this.lights.get(uid);
    if (r) r.on = on;
  }

  private onMessage(w: WorldEntity, msg: number): boolean {
    const v = w.e.values;
    const r = this.lights.get(w.uid);
    if (r) {
      if (num(v[4]) === msg) return (r.on = true), true;
      if (num(v[5]) === msg) return (r.on = false), true;
      return false;
    }
    if (w.cls === 'Lighting Effect') {
      // 0x4c49d0 On / 0x4c49f0 Off: start / stop the clock (values stay); 0x4c4a20 Destroy.
      const f = this.fx.get(`e${w.uid}`);
      const on = num(v[2], 1) === msg ? true : num(v[3], 2) === msg ? false : undefined;
      if (on !== undefined) return f && (f.on = on), true;
      if (num(v[4], 12) === msg) return this.fx.delete(`e${w.uid}`), true;
      return false;
    }
    if (w.cls === 'Sky / Sun') {
      const show = num(v[4], 1) === msg ? true : num(v[5], 2) === msg ? false : undefined;
      if (show === undefined) return false;
      for (const s of this.sky) if (s.uid === w.uid) s.root.visible = show;
      return true;
    }
    if (w.cls === 'Fog / Sky Switcher') {
      if (num(v[3], 1) !== msg) return false;
      const sp = ref(v[0]);
      const t = sp ? readTemplate(this.pkgs, sp) : undefined;
      if (t && this.fog instanceof EngineFog && !LEGACY_LIGHTING) {
        const sky = skyFog(t.values);
        this.fogBlend = {
          from: this.fog.color.clone(),
          to: new THREE.Color().setHex(sky.color, THREE.SRGBColorSpace),
          d0: this.fog.density,
          d1: this.fog.density,
          t: 0,
          dur: Math.max(0.05, num(v[2], 1)),
          near: [this.fog.near, sky.near],
          far: [this.fog.far, sky.far],
        };
      } else if (t && this.fog) {
        const col = num(t.values[5]) ? colorOf(t.values[5]) : num(t.values[4]) ? colorOf(t.values[4]) : this.fog.color.clone();
        const dens = this.fog.density * (num(t.values[7], 0.2) / 0.2);
        this.fogBlend = { from: this.fog.color.clone(), to: col, d0: this.fog.density, d1: Math.min(0.2, Math.max(0.005, dens)), t: 0, dur: Math.max(0.05, num(v[2], 1)) };
      }
      return true;
    }
    return false;
  }

  // Sky dome: Sky / Sun objects are dynamic models (dynamic.ts builds them when drawn); keep
  // them centred on the camera.
  private initSky() {
    const skies = this.world.of('Sky / Sun');
    const centre = skies.find((w) => num(w.e.values[6]) === 1) ?? skies[0];
    if (!centre) return;
    const c = new THREE.Vector3(...centre.pos);
    for (const w of skies) {
      const d = this.dyn.objects.get(w.uid);
      if (!d) continue;
      const dome = w === centre;
      d.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.renderOrder = dome ? -11 : -10;
        m.frustumCulled = false;
        let mat: THREE.Material;
        // SKY_DOME.levels: src/game/levels/sky.ts colours the dome from the level's Sky
        // Properties, so the fixed gradient below is skipped (the dome keeps a plain clone).
        if (dome && !SKY_DOME.levels) {
          // The dome's texture is a colour strip the engine rewrites at run time from the
          // Sky Properties ("sky texture cannot be written to"); a night gradient stands in.
          m.geometry.computeBoundingBox();
          const bb = m.geometry.boundingBox!;
          const h = Math.max(1e-3, bb.max.y);
          const basic = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
          basic.colorNode = mix(vec3(0.05, 0.055, 0.065), vec3(0.008, 0.01, 0.018), positionLocal.y.div(h).clamp(0, 1).pow(0.6));
          mat = basic;
        } else mat = cloneWithGlowMark(m.material as THREE.Material);
        mat.depthWrite = false;
        (mat as THREE.MeshStandardNodeMaterial).fog = false;
        m.material = mat;
        this.skyMats.push(mat);
      });
      this.sky.push({ root: d.root, offset: new THREE.Vector3(...w.pos).sub(c), uid: w.uid });
      d.root.visible = num(w.e.values[0], 1) !== 0;
    }
  }

  private readonly tmp = new THREE.Vector3();

  update(dt: number, cam: THREE.Camera) {
    const cp = cam.getWorldPosition(this.tmp);
    // Sky follows the camera.
    for (const s of this.sky) {
      const m = s.root.matrix;
      m.setPosition(cp.x + s.offset.x, cp.y + s.offset.y, cp.z + s.offset.z);
      s.root.matrixWorldNeedsUpdate = true;
    }
    if (this.fogBlend && this.fog) {
      const b = this.fogBlend;
      b.t += dt;
      const k = Math.min(1, b.t / b.dur);
      this.fog.color.copy(b.from).lerp(b.to, k);
      if (b.near && b.far && this.fog instanceof EngineFog) {
        this.fog.near = b.near[0] + (b.near[1] - b.near[0]) * k;
        this.fog.far = b.far[0] + (b.far[1] - b.far[0]) * k;
      } else this.fog.density = b.d0 + (b.d1 - b.d0) * k;
      if (k >= 1) this.fogBlend = undefined;
    }
    // Lighting Effects advance their clocks and write into their lights.
    for (const f of this.fx.values()) {
      const n = this.fxTicks(f);
      if (!n) continue;
      f.t += n * dt;
      this.applyFx(f);
    }
    if (!LEGACY_LIGHTING) return; // engine lighting reads the lights directly
    // Legacy: choose the lights whose state differs from the baked lighting.
    const cand: { r: LightRec; delta: number; d: number }[] = [];
    for (const r of this.lights.values()) {
      let k = r.on ? 1 : 0;
      if (r.on && r.fxPower !== undefined && r.intensity > 0) k = Math.min(2, r.fxPower / r.intensity);
      const delta = k - (r.baked ? 1 : 0);
      if (Math.abs(delta) < 0.02) continue;
      const d = r.pos.distanceTo(cp);
      if (d > 35 + r.radius) continue;
      cand.push({ r, delta, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (let i = 0; i < POOL; i++) {
      const l = this.pool[i];
      const c = cand[i];
      if (!c) {
        l.intensity = 0;
        continue;
      }
      l.position.copy(c.r.pos);
      l.distance = c.r.radius * 1.5;
      if (c.delta < 0) {
        // Removing baked light: a neutral negative light (a coloured one leaves tinted holes).
        l.color.setRGB(1, 1, 1);
        l.intensity = INTENSITY_OFF * c.delta;
      } else {
        l.color.copy(c.r.fxColor ?? c.r.color);
        l.intensity = INTENSITY * c.delta;
      }
    }
  }

  /** Lights currently off / on against their baked state (for the overlay / tests). */
  stats() {
    let off = 0, on = 0, flick = 0;
    for (const r of this.lights.values()) {
      if (r.baked && !r.on) off++;
      if (!r.baked && r.on) on++;
    }
    for (const f of this.fx.values()) if (this.fxTicks(f)) flick++;
    return { lights: this.lights.size, switchedOff: off, switchedOn: on, flickering: flick, active: this.pool.filter((l) => l.intensity !== 0).length };
  }

  save(): LightsSaveState {
    const s: LightsSaveState = { on: {}, fx: {}, ft: {} };
    for (const r of this.lights.values()) if (r.on !== r.baked) s.on[r.uid] = r.on ? 1 : 0;
    for (const [k, f] of this.fx) {
      s.fx[k] = f.on ? 1 : 0;
      if (f.t) s.ft![k] = f.t;
    }
    return s;
  }

  load(s: LightsSaveState) {
    for (const r of this.lights.values()) {
      const v = s.on?.[r.uid];
      r.on = v === undefined ? r.baked : !!v;
    }
    for (const [k, f] of this.fx) {
      const on = s.fx?.[k];
      if (on !== undefined) f.on = !!on;
      f.t = s.ft?.[k] ?? 0;
      if (f.t) this.applyFx(f);
    }
  }

  /** Matrix of a light's placement (debug). */
  matrixOf(uid: number) {
    const r = this.lights.get(uid);
    return r ? instanceMatrix(r.w.e.position, r.w.e.rotation) : undefined;
  }

  dispose() {
    this.removeProvider?.();
    for (const l of this.pool) l.dispose();
    for (const m of this.skyMats) m.dispose();
    this.group.removeFromParent();
  }
}
