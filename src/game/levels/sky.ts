// Sky dome colours from the level's Sky Properties (docs/levels.md §4.8).
//
// The dome is the Sky / Sun layer with p6 = 1 (World Common 7:1: a 5-unit sphere around the
// camera, drawn first; lights.ts keeps it centred on the camera). Its texture is not art: the
// engine rewrites it whenever the sky changes (Suffering.rfl 0x1012ad70, "Invalid or
// Non-unique sky texture cannot be written to." / "Cannot lock sky texture for writing!")
// [verified for the writer]:
//   * n1 = round(p6 × 448) texels of p4, then p7 × 448 texels blending p4 -> p5 (the colour
//     lerp 0x10066bf0), then p5 to texel 448; when p4 == p5 the whole strip is p4;
//   * a second run of 448 texels of p4 half-way through the texture;
//   * the fog colour becomes lerp(p4, p5, p8) (atmosphere.ts skyFog).
// So p4 is the horizon (= fog) colour, p5 the sky colour, p6 / p7 the horizon band and the
// gradient as fractions of the strip.
// Port [inferred: the strip's orientation in the texture and the dome's v mapping (upper
// hemisphere v 0..0.09, lower 0.5..0.6, varying with azimuth) are not decoded]: the strip runs
// from the horizon (0) to the zenith (1) by height on the dome; below the horizon is p4.
// Fog / Sky Switchers (On = p3) blend the dome to the switcher's Sky Properties (p0) over p2 s,
// like the fog (lights.ts).

import * as THREE from 'three/webgpu';
import { clamp, mix, positionLocal, uniform } from 'three/tsl';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { WorldService } from '../world/world';
import { SKY_DOME } from './atmosphere';
import type { World, WorldEntity } from '../world/logic';

const SKY_PROPERTIES = 0x4f594492;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Dome strip parameters of a Sky Properties template. */
export interface SkyStrip {
  horizon: number;
  sky: number;
  /** Fraction of the strip in the horizon colour (p6). */
  band: number;
  /** Fraction blending horizon -> sky (p7). */
  blend: number;
}

export function skyStrip(v: readonly PropValue[]): SkyStrip {
  const horizon = num(v[4]) & 0xffffff, sky = num(v[5]) & 0xffffff;
  const band = Math.min(1, Math.max(0, num(v[6], 0.1)));
  const blend = Math.min(1, Math.max(0, num(v[7], 0.2)));
  return { horizon, sky: horizon === sky ? horizon : sky, band, blend };
}

/** Strip colour (0xRRGGBB, gamma) at s in [0, 1] (0 horizon, 1 zenith), as the engine writes it. */
export function skyStripAt(st: SkyStrip, s: number): number {
  const n1 = Math.round(st.band * 448), n2 = n1 + Math.floor(st.blend * 448);
  const i = s * 448;
  if (i < n1 || st.horizon === st.sky) return st.horizon;
  if (i >= n2) return st.sky;
  const t = (i - n1) / Math.max(1, n2 - n1);
  let out = 0;
  for (const sh of [16, 8, 0]) out |= Math.round(((st.horizon >> sh) & 255) * (1 - t) + ((st.sky >> sh) & 255) * t) << sh;
  return out;
}

function readStrip(pkgs: EntityPackageSet, r: unknown): SkyStrip | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const t = readObjectTemplate(pkgs, r as ResRef);
  if (!t || t.classHash !== SKY_PROPERTIES) return undefined;
  return skyStrip(decodeTemplateProps(classByHash(SKY_PROPERTIES), t));
}

export class SkyDome {
  private readonly horizon = uniform(new THREE.Color());
  private readonly sky = uniform(new THREE.Color());
  private readonly band = uniform(0.1);
  private readonly blend = uniform(0.2);
  private readonly materials: THREE.Material[] = [];
  private fade?: { from: SkyStrip; to: SkyStrip; t: number; dur: number };
  private current?: SkyStrip;
  private unsubscribe?: () => void;
  /** Dome meshes coloured (0 when the level has no dome). */
  readonly meshes: THREE.Mesh[] = [];

  constructor(
    private readonly world: World,
    private readonly pkgs: EntityPackageSet,
    scene: THREE.Object3D,
    ws?: WorldService,
  ) {
    const skies = world.of('Sky / Sun');
    // Every dome layer (p6 = 1; 10 Docks places two, both on 7:1): they share the one texture
    // the engine writes, so all show the strip. Without one, the first layer (as lights.ts).
    const domes = skies.filter((w) => num(w.e.values[6]) === 1);
    if (!domes.length && skies[0]) domes.push(skies[0]);
    const strip = readStrip(pkgs, world.of('Level Properties')[0]?.e.values[10]);
    if (!domes.length || !strip || !SKY_DOME.levels) return;
    const uids = new Set(domes.map((w) => w.uid));
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && uids.has(m.userData.uid)) this.meshes.push(m);
    });
    for (const m of this.meshes) {
      m.geometry.computeBoundingBox();
      const h = Math.max(1e-3, m.geometry.boundingBox!.max.y);
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthWrite: false });
      // Height on the dome -> strip position (0 horizon .. 1 zenith).
      const s: N = clamp((positionLocal as N).y.div(h), 0, 1);
      const b: N = this.band, l: N = this.blend;
      const t: N = clamp(s.sub(b).div(l.max(1 / 448)), 0, 1);
      mat.colorNode = mix(this.horizon as N, this.sky as N, t);
      mat.fog = false;
      // Not written by lights.ts for a second dome: keep it in the sky's draw order.
      m.renderOrder = Math.min(m.renderOrder, -10);
      m.frustumCulled = false;
      mat.name = 'levels-sky-dome';
      // lights.ts disposes the material it put here (a clone) with its other sky materials.
      m.material = mat;
      this.materials.push(mat);
    }
    if (!this.meshes.length) return;
    this.set(strip);
    if (ws) this.unsubscribe = ws.subscribe('*', (msg, _from, to) => this.onMessage(to, msg));
  }

  private set(st: SkyStrip) {
    this.current = st;
    this.horizon.value.setHex(st.horizon, THREE.SRGBColorSpace);
    this.sky.value.setHex(st.sky, THREE.SRGBColorSpace);
    this.band.value = st.band;
    this.blend.value = st.blend;
  }

  private onMessage(uid: number, msg: number) {
    const w: WorldEntity | undefined = this.world.get(uid);
    if (!w || w.cls !== 'Fog / Sky Switcher' || num(w.e.values[3], 1) !== msg) return;
    const to = readStrip(this.pkgs, w.e.values[0]);
    if (!to || !this.current) return;
    this.fade = { from: this.current, to, t: 0, dur: Math.max(0.05, num(w.e.values[2], 1)) };
  }

  update(dt: number) {
    const f = this.fade;
    if (!f) return;
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    const lerp = (a: number, b: number) => a + (b - a) * k;
    const c = (a: number, b: number) => new THREE.Color().setHex(a, THREE.SRGBColorSpace).lerp(new THREE.Color().setHex(b, THREE.SRGBColorSpace), k);
    this.horizon.value.copy(c(f.from.horizon, f.to.horizon));
    this.sky.value.copy(c(f.from.sky, f.to.sky));
    this.band.value = lerp(f.from.band, f.to.band);
    this.blend.value = lerp(f.from.blend, f.to.blend);
    if (k >= 1) {
      this.set(f.to);
      this.fade = undefined;
    }
  }

  dispose() {
    this.unsubscribe?.();
    for (const m of this.materials) m.dispose();
  }
}
