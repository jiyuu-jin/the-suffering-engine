// Drip (class 0x63158a64, Special Effect; Suffering.rfl vtable 0x1014dfe0) and the drops a
// DripMorphingModel lets fall [verified unless marked]. docs/game-logic.md §14.2.
//
// - The DripMorphingModel (vtable 0x10154c78) is a MorphingModel whose vt +0x4c (0x100a8b40),
//   called when its clock passes p11 (just before the cycle ends: 1.1 s of 1.12), spawns its
//   p25 Drip at its transform when it has none (one per model, handle +0x44) and then releases
//   that drip (0x100a8840). Its think (0x100a8a40) marks the frame; a frame without one (the
//   model not thinking) resets the drip and removes its splash objects (0x100a8bf0).
// - Drip think (0x100a88f0). The first one prepares it (0x100a8500): a ray 1000 m straight down
//   from its position (0x100c6630); no hit removes the drip. A hit on a Water Volume (class
//   check 0x029e9104) makes it a water drip. At the hit point (the drip's x / z, no rotation) it
//   spawns, dormant and hidden, p4 and p5 (p6 and p7 over water): a MorphingModel splat and an
//   Object Generator. Then it resets (0x100a8270): hidden, back at its start, at rest. So the
//   first release, which comes before that think, is undone; drops fall from the next cycle on.
// - Release (0x100a8840): shown, falling. Each think while falling: v -= p3 x dt x g (g the
//   world gravity, [0x1017bf40]+0x90), then the position moves by v - a per-frame step, not
//   v x dt - and the distance fallen grows by |v|. At the prepared distance it resets and hits
//   (0x100a8730): the splat MorphingModel is shown and restarted (Reset, On: 0x100d3ad0), the
//   generator gets input p32 (On: its run, the drip sound 3:71 of 3:1423). While the splat runs
//   nothing else happens; when it is off again both are put to sleep and the splat hidden.
// - p2 = 0 would release it by itself every p0..p1 s (random); both retail Drips have p2 = 1.
//   Inputs p8 / p9 / p10 / p11 (prepare again / sleep / release / remove): nothing sends them.
// - Port: the per-frame fall is stepped at 30 engine frames a second [inferred rate]; the water
//   test uses the water surfaces (levels/water.ts) since the collision world has no Water
//   Volumes; the model thinks whenever it runs (the "not seen" reset is not ported).

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import type { CollisionWorld } from '../../app/physics';
import type { DynamicObject, DynamicObjects } from './dynamic';
import { MorphMachine, MorphTargets, morphingModelDef } from './morphing-model';
import { readTemplate } from './fx';
import type { EntityPackageSet } from '../../formats/entities';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) && 'id' in v ? (v as ResRef) : undefined);

export interface DripParams {
  /** p3: the fall's gravity factor. */
  fall: number;
  /** p4 / p5: the splat MorphingModel and the generator on a floor; p6 / p7 on water. */
  splat?: ResRef;
  splash?: ResRef;
  waterSplat?: ResRef;
  waterSplash?: ResRef;
}

export function dripParams(v: readonly PropValue[]): DripParams {
  return { fall: num(v[3]), splat: ref(v[4]), splash: ref(v[5]), waterSplat: ref(v[6]), waterSplash: ref(v[7]) };
}

/** Engine frames per second the per-frame fall is stepped at [port; inferred rate]. */
export const DRIP_FPS = 30;
/** The prepare ray's length (0x10154c70: 2048000 units = 1000 m). */
export const DRIP_RAY = 1000;

/** One think of a falling drip (0x100a892b..0x100a899f): true when it has fallen its distance. */
export function dripFrame(s: { v: number; fallen: number; y: number }, fall: number, dt: number, g: number, dist: number): boolean {
  s.v -= fall * dt * g;
  s.y += s.v;
  s.fallen += Math.abs(s.v);
  return s.fallen >= dist;
}

export interface DripEnv {
  dyn: DynamicObjects;
  packages: EntityPackageSet;
  collision: CollisionWorld | null;
  gravity(): number;
  /** Highest water surface above (x, y, z), if any (levels/water.ts surfaceAt). */
  waterAt?(x: number, y: number, z: number): number | undefined;
  /** Spawn a template at M and start it (an Object Generator's run). */
  spawn(r: ResRef, M: THREE.Matrix4): void;
}

interface Splat {
  d: DynamicObject;
  m: MorphMachine;
  t: MorphTargets;
}

/** One Drip spawned by a DripMorphingModel. */
export class Drip {
  readonly d: DynamicObject;
  private readonly p: DripParams;
  private readonly start: THREE.Vector3;
  private prepared = false;
  private falling = false;
  private impact = false;
  private dist = 0;
  private hitY = 0;
  private water = false;
  private splat?: Splat;
  private readonly s = { v: 0, fallen: 0, y: 0 };
  private acc = 0;
  removed = false;

  private constructor(
    private readonly env: DripEnv,
    values: readonly PropValue[],
    d: DynamicObject,
  ) {
    this.p = dripParams(values);
    this.d = d;
    this.start = new THREE.Vector3().setFromMatrixPosition(d.root.matrix);
    this.s.y = this.start.y;
  }

  /** The p25 Drip of a DripMorphingModel at M; undefined when the template has no model. */
  static spawn(env: DripEnv, template: ResRef, M: THREE.Matrix4): Drip | undefined {
    const t = readTemplate(env.packages, template);
    if (!t?.model || t.cls !== 'Drip') return undefined;
    const d = env.dyn.spawnModel(t.model, M, { collides: false, name: 'drip' });
    return d ? new Drip(env, t.values, d) : undefined;
  }

  get isFalling() {
    return this.falling;
  }

  /** 0x100a8840: shown and falling from where it is. */
  release() {
    if (this.removed) return;
    this.env.dyn.setVisible(this.d.uid, true);
    this.falling = true;
  }

  update(dt: number) {
    if (this.removed) return;
    if (!this.prepared) {
      this.prepare();
      return;
    }
    if (this.falling) {
      this.acc += dt;
      const step = 1 / DRIP_FPS;
      while (this.falling && this.acc >= step) {
        this.acc -= step;
        if (dripFrame(this.s, this.p.fall, step, this.env.gravity(), this.dist)) {
          this.reset();
          this.hit();
        }
      }
      this.place();
    } else if (this.impact && this.splat) {
      const sp = this.splat;
      sp.m.think(dt, true);
      sp.t.apply(sp.m.pose, sp.m.opacity);
      if (sp.m.off) {
        this.env.dyn.setVisible(sp.d.uid, false);
        this.impact = false;
      }
    } else this.impact = false;
  }

  /** 0x100a8500: the ray down, the dormant splat at the hit, then reset. */
  private prepare() {
    const { x, y, z } = this.start;
    const hit = this.env.collision?.raycast(x, y, z, 0, -1, 0, DRIP_RAY);
    if (!hit) {
      this.remove();
      return;
    }
    let floor = hit.point[1];
    const w = this.env.waterAt?.(x, floor, z);
    this.water = w !== undefined && w > floor && w < y;
    if (this.water) floor = w!;
    this.hitY = floor;
    this.dist = y - floor;
    const r = this.water ? this.p.waterSplat : this.p.splat;
    const t = r ? readTemplate(this.env.packages, r) : undefined;
    const def = t?.cls === 'MorphingModel' ? morphingModelDef(t.values) : undefined;
    if (t?.model && def) {
      const M = new THREE.Matrix4().makeTranslation(x, floor, z);
      const d = this.env.dyn.spawnModel(t.model, M, { collides: false, name: `drip splat:${r!.pkg}:${r!.id}` });
      const targets = d && MorphTargets.attach(d, this.env.packages as unknown as PackageSet, def);
      if (d && targets) {
        this.env.dyn.setVisible(d.uid, false);
        this.splat = { d, m: new MorphMachine(def, false), t: targets };
      } else if (d) this.env.dyn.remove(d.uid);
    }
    this.prepared = true;
    this.reset();
  }

  /** 0x100a8270: hidden, back at the start, at rest. */
  private reset() {
    this.falling = false;
    this.s.v = 0;
    this.s.fallen = 0;
    this.s.y = this.start.y;
    this.acc = 0;
    this.place();
    this.env.dyn.setVisible(this.d.uid, false);
  }

  /** 0x100a8730: the splat restarted and the generator's On. */
  private hit() {
    this.impact = true;
    if (this.splat) {
      this.env.dyn.setVisible(this.splat.d.uid, true);
      this.splat.m.restart();
      this.splat.t.apply(this.splat.m.pose, this.splat.m.opacity);
    }
    const g = this.water ? this.p.waterSplash : this.p.splash;
    if (g) this.env.spawn(g, new THREE.Matrix4().makeTranslation(this.start.x, this.hitY, this.start.z));
  }

  private place() {
    this.d.root.matrix.elements[13] = this.s.y;
    this.d.root.matrixWorldNeedsUpdate = true;
  }

  /** Gone with its model (and its splat). */
  remove() {
    if (this.removed) return;
    this.removed = true;
    if (this.splat) {
      this.splat.t.dispose();
      this.env.dyn.remove(this.splat.d.uid);
    }
    this.env.dyn.remove(this.d.uid);
  }
}
