// Directional Light / Ambient Light at run time (docs/game-logic.md §17.7).
//
// Verified in SUFFERING.EXE: a Directional Light (0x6b110672) whose p9 names a Rim Light
// template runs every frame (0x4c76b0) while thinking (p6): it builds a direction from the Rim
// Light's p10 / p11 angles (degrees; elevation / azimuth) relative to the active camera's
// orientation and points its light object along it - a camera-relative rim light that only
// the per-object (dynamic) lighting sees; the level geometry is baked. Ambient Light (scaled
// box, p9 a colour) and Directional Lights without a rim template have no per-frame code and
// only feed the lighting bake [inferred: no think, nothing reads them at run time].
//
// Which lights an object gets (SUFFERING.EXE 0x4ca730, docs/re/renderer.md §1.4) [verified
// rule, region strong]: a light applies within its parent node of the sector tree (the root
// group: everywhere; formats/visgraph.ts lightRegions). The directional lights whose region
// overlaps the object are sorted by region volume (smallest first) and cut after the first
// exclusive one (p8, flag 0x400); rim lights (flag 0x800, never exclusive) are gathered only for
// dynamic objects (object flag +0x10 bit 1), survive the cut, and only the first one applies
// (render-data.ts applicableDirectionals). Port: every rim source is its own camera-relative
// rig directional (colour = the Rim Light template's p0, 0x4c74bd) in its Directional Light's
// region; the rig applies the rule (engine-light.ts). With `?lighting=legacy` the rim of the
// smallest region holding the camera (else the nearest) drives one THREE.DirectionalLight given
// to character materials through a per-material lights node.
//
// Base lights (docs/re/renderer.md §1.5) [verified, Directional Light init 0x4c7230]: a
// Directional Light also keeps its own light (colour p0, negated by p1; pointing along the
// object's local +Z, 0x4c9890) when it has a rim template or is switchable: links, a Lighting
// Effect (p3), p6 = 0 (off at start), or p6 with an input / flag (p2, p4, p5). Without either
// the object is dropped and the light only exists in the bake. Switchable ones keep flag 2 and
// so also light geometry with precomputed colours (the 101 baked + directional shader
// variants: level 2's relay-switched lights); the others light dynamic objects only. Each
// applies within its region (levels without a sector tree: the smallest zone box containing
// it, else everywhere); p4 / p5 switch it on / off. A black one still counts: being exclusive,
// it hides the larger regions' lights (1a's root light 0x7f8a).

import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { World, WorldEntity } from '../world/logic';
import { engineColor, engineLights, type EngineDirectional } from '../../app/engine-light';
import { instanceRotation } from '../../formats/level';
import { directionalRole } from '../../formats/render-data';
import type { LightRegion } from '../../formats/visgraph';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);

interface Source {
  w: WorldEntity;
  color: THREE.Color;
  elev: number;
  azim: number;
  /** The Directional Light's region (null = everywhere). */
  box: THREE.Box3 | null;
  /** This rim light in the engine lighting rig (xvsLightDir.vsh: colour × max(N·L, 0)). */
  engine: EngineDirectional;
}

const volume = (b: THREE.Box3 | null) => (b ? (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z) : Infinity);

export class RimLight {
  readonly light = new THREE.DirectionalLight(0xffffff, 0);
  private sources: Source[] = [];
  private current?: Source;
  private node = lights([]);
  private sceneLights: THREE.Light[] = [];
  private acc = 1;
  private done = new WeakSet<THREE.Material>();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly dir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  /** Character roots to light (set by the system each frame). */
  targets: () => THREE.Object3D[] = () => [];

  constructor(
    world: World,
    template: (r: ResRef) => PropValue[] | undefined,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly zones: THREE.Box3[] = [],
    private readonly regions?: ReadonlyMap<number, LightRegion>,
  ) {
    for (const w of world.of('Directional Light')) {
      const v = w.e.values;
      if (!isRef(v[9]) || num(v[6]) === 0) continue;
      const rim = template(v[9] as ResRef);
      if (!rim) continue;
      // Rim colour: the Rim Light template's p0 (negated by its p1), 0x4c74bd.
      const c = engineColor(num(rim[0])).multiplyScalar(num(rim[1]) ? -1 : 1);
      const engine = engineLights.addDirectional();
      engine.rim = true;
      engine.color.copy(c); // engine units (bytes / 255)
      engine.box = this.regionOf(w);
      this.sources.push({ w, color: c, elev: num(rim[10], -45), azim: num(rim[11], 0), box: engine.box, engine });
    }
    this.initBaseLights(world, template);
    this.light.name = 'rim-light';
    // Kept out of the scene graph so the scene's own lights node (the level, props) never sees
    // it; its matrices are updated here.
    this.light.matrixAutoUpdate = true;
  }

  private readonly base: { w: WorldEntity; light: EngineDirectional }[] = [];

  /** Directional Lights' own lights (see the header). */
  private initBaseLights(world: World, template: (r: ResRef) => PropValue[] | undefined) {
    for (const w of world.of('Directional Light')) {
      const v = w.e.values;
      const role = directionalRole({ p2: num(v[2]), p3: isRef(v[3]), p4: num(v[4]), p5: num(v[5]), p6: num(v[6]), rim: isRef(v[9]) && !!template(v[9] as ResRef), links: w.e.links?.length ?? 0 });
      if (!role.base) continue;
      const color = engineColor(num(v[0])).multiplyScalar(num(v[1]) ? -1 : 1);
      // p8: exclusive (base light vtable +0x70, 0x4c75f8).
      const exclusive = num(v[8], 1) !== 0;
      if (!exclusive && !color.r && !color.g && !color.b) continue;
      const m = instanceRotation(w.e.rotation);
      const light = engineLights.addDirectional();
      light.dir.set(m[2], m[5], m[8]).normalize();
      light.color.copy(color);
      light.on = role.on;
      light.baked = role.baked;
      light.exclusive = exclusive;
      light.box = this.regionOf(w);
      this.base.push({ w, light });
    }
    if (!this.base.length) return;
    world.handlers.push((w, msg) => {
      const b = this.base.find((x) => x.w === w);
      if (!b) return false;
      const v = w.e.values;
      if (num(v[4]) === msg) return (b.light.on = true), true;
      if (num(v[5]) === msg) return (b.light.on = false), true;
      return false;
    });
  }

  /**
   * Region of a Directional Light: its parent group's box (null under the root group); levels
   * without a sector tree: the smallest zone box containing it, else everywhere.
   */
  private regionOf(w: WorldEntity): THREE.Box3 | null {
    const r = this.regions?.get(w.uid);
    if (r) return r.box ? new THREE.Box3(new THREE.Vector3(r.box[0], r.box[1], r.box[2]), new THREE.Vector3(r.box[3], r.box[4], r.box[5])) : null;
    const p = new THREE.Vector3(...w.pos);
    let best: THREE.Box3 | null = null;
    for (const b of this.zones) if (b.containsPoint(p) && volume(b) < volume(best)) best = b;
    return best;
  }

  baseState() {
    return this.base.map((b) => ({ uid: b.w.uid.toString(16), on: b.light.on, baked: b.light.baked, color: b.light.color.toArray().map((x) => +x.toFixed(3)), dir: b.light.dir.toArray().map((x) => +x.toFixed(2)) }));
  }

  state() {
    return {
      sources: this.sources.length,
      source: this.current?.w.uid.toString(16),
      color: this.current ? '#' + this.current.color.getHexString() : undefined,
      rims: this.sources.map((s) => ({ uid: s.w.uid.toString(16), on: s.engine.on, color: '#' + s.color.getHexString(), region: s.box ? +volume(s.box).toFixed(0) : 'all' })),
    };
  }

  /** Direction a rim light shines along: its template angles relative to the camera. */
  private rimDirection(s: Source, out: THREE.Vector3): THREE.Vector3 {
    // Azimuth about the camera's up, elevation about its right.
    this.e.set(THREE.MathUtils.degToRad(s.elev), THREE.MathUtils.degToRad(s.azim), 0, 'YXZ');
    return out.set(0, 0, -1).applyEuler(this.e).applyQuaternion(this.q);
  }

  update(dt: number) {
    if (!this.sources.length) return;
    const cam = this.camera.position;
    this.camera.getWorldQuaternion(this.q);
    // Engine rig: every rim light, camera-relative, in its own region; the vector towards the
    // light, colour = p0 / 255 (light units).
    let best: Source | undefined;
    for (const s of this.sources) {
      s.engine.on = !s.w.destroyed;
      if (!s.engine.on) continue;
      s.engine.dir.copy(this.rimDirection(s, this.dir)).negate();
      // Legacy light: the rim of the smallest region holding the camera.
      if ((!s.box || s.box.containsPoint(cam)) && (!best || volume(s.box) < volume(best.box))) best = s;
    }
    if (!best) {
      let bd = Infinity;
      for (const s of this.sources) {
        if (s.w.destroyed) continue;
        const d = cam.distanceToSquared(this.tmp.set(...s.w.pos));
        if (d < bd) (bd = d), (best = s);
      }
    }
    this.current = best;
    if (!best) {
      this.light.intensity = 0;
      return;
    }
    this.light.color.copy(best.color);
    this.light.intensity = 2.2;
    const dir = this.rimDirection(best, this.dir);
    // The light shines along dir: place it behind the target.
    this.light.target.position.copy(cam);
    this.light.position.copy(cam).addScaledVector(dir, -10);
    this.light.updateMatrixWorld(true);
    this.light.target.updateMatrixWorld(true);
    // Every half second: refresh the scene light list and give new character materials the
    // scene lights + rim light.
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    const found: THREE.Light[] = [];
    this.scene.traverseVisible((o) => {
      if ((o as THREE.Light).isLight) found.push(o as THREE.Light);
    });
    const list = [...found, this.light];
    if (list.length !== this.sceneLights.length + 1 || found.some((l, i) => l !== this.sceneLights[i])) {
      this.sceneLights = found;
      this.node.setLights(list);
    }
    for (const root of this.targets()) {
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
          const nm = mat as THREE.Material & { lightsNode?: unknown; isNodeMaterial?: boolean; lights?: boolean };
          if (!nm.isNodeMaterial || this.done.has(mat) || nm.lights === false) continue;
          if ((mat as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial) continue;
          nm.lightsNode = this.node;
          mat.needsUpdate = true;
          this.done.add(mat);
        }
      });
    }
  }

  dispose() {
    for (const s of this.sources) s.engine.remove();
    for (const b of this.base) b.light.remove();
    this.light.dispose();
  }
}
