// Searchlights: Mountables whose p49 Object Generator spawns a Spot Light Cone (3a's yard and
// west walkway, 2 Cellblocks, 4a, 8a, 9 Lighthouse).
//
// Original (Suffering.rfl) [verified unless marked]:
//   * Mountable p49 is an Object Generator template; the Mountable spawns it at creation on the
//     hardpoint p51 of its skinned model through the generator's Follower Object (p25), so what
//     it makes moves with the gun (Mountable post-create 0x100196d0 -> 0x100afcb0 with p51).
//     World Common 7:2896 / 7:2898 make a Spot Light (7:2895), a Spot Light Cone (7:2902 /
//     7:2906, model 3:362) and the lens (a Breakable).
//   * Model 7:1244's hardpoint 3 sits 1.27 m up with its frame turned half round about the
//     vertical (bind pose: x = -X, z = -Z of the model); the cone model reaches along its own -Z
//     from 0.41 to 21.06 m and opens to 5.81 m [data]: the beam leaves along the model's +Z, the
//     same way the gun 7:2918's muzzle hardpoint (3, at z +1.55) points.
//   * A Detector with filter p1 = 4 reacts to Spot Light Cones (docs/game-logic.md §11.2). 3a
//     places three: 13ed / 1b5b on the west walkway (they stop the Object Cloners 13c9 / 1b5a
//     that keep sending CartWheelers along it) and 13f8 at the pit in the west yard (lights its
//     fires, stops Object Cloner 436d, counts Count Down 1b7a down: the way to the 4a exit).
//   * Lit or dark (Mountable 0x10019510 / 0x100193c0): lit spawns p55 at hardpoint p56 and the
//     p49 generator at p51 (0x10019090, its handle kept at +0xc0); dark deletes that and spawns
//     p59 at p60 (7:2900: the lens alone). p32 picks the state at creation: 1 lit, 2 dark, 0
//     neither (0x100196d0). While mounted, each press of Fire (action 0x428) switches between the
//     two (0x10019e0c..0x10019e64). 3a's walkway lights cbb / cc2 / 348e / cc3 start dark (p32 2).
//   * Every Mountable has p23 = 0 (no eye-ray test, usable: interact.ts) and the player turns a
//     mounted one with the view (p38 yaw range, p42 / p43 pitch limits).
//   * The generator's Spot Light (7:2895: colour p0 0xf7f5f2, start p8 1 m, length p9 12 m, cone
//     radius p10 45 m, on at creation, p6 = 1) rides the same hardpoint and shines along the
//     cone's axis; dark deletes it with the cone. A light the engine owns, it lights what lies
//     in its cone like the flashlight's (docs/re/renderer.md §2) [verified: the loader 0x4cf450
//     reads p8..p10 for every Spot Light; the axis shared with the cone: inferred].
//   * Saved with the level: the lit state (+0xc0 handle: the generator's objects exist) and where
//     the player left the beam [inferred: the port's steering pitch].
// Port: the cone's axis and a ring of rays at its half-angle are sampled for the Detectors; the
// cone is drawn with its model, the Spot Light goes to the engine rig (engine-light.ts
// addSpotProvider) while lit.

import * as THREE from 'three/webgpu';
import type { ResRef } from '../../formats/model';
import { readModel } from '../../formats/model';
import type { EntityPackageSet } from '../../formats/entities';
import { readSkeleton } from '../../formats/skeleton';
import type { World, WorldEntity } from './logic';
import type { DynamicObject, DynamicObjects } from './dynamic';
import { readTemplate } from './fx';
import { hardpointTable } from '../weapons/hardpoints';
import { engineLights, type EngineSpot, type SpotDef } from '../../app/engine-light';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && 'pkg' in (v as object) && 'id' in (v as object);
const refList = (v: unknown): ResRef[] => (Array.isArray(v) ? v.filter(isRef) : isRef(v) ? [v] : []);

export interface LightCone {
  /** The Mountable carrying it. */
  uid: number;
  /** Beam origin (world) and unit direction. */
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  /** Cone length (m) and half-angle (rad), from the cone model. */
  length: number;
  half: number;
}

interface Light extends LightCone {
  w: WorldEntity;
  /** Hardpoint frame in the Mountable's model space. */
  local: THREE.Matrix4;
  mesh?: DynamicObject;
  near: number;
  /** Extra pitch (rad, up positive) while the player steers it. */
  pitch: number;
  /** Lit: the p49 generator's cone exists. */
  on: boolean;
  /** The generator's Spot Light (engine rig), reused each frame. */
  spot?: EngineSpot;
}

/** Model-space bind frame of hardpoint `hp` of a skinned model (undefined: no such hardpoint). */
export function hardpointLocal(pkgs: EntityPackageSet, model: ResRef | undefined, hp: number): THREE.Matrix4 | undefined {
  if (!model || hp < 0) return undefined;
  const bone = hardpointTable(pkgs, model)[hp];
  const mdu = pkgs.get(model.pkg)?.mdu;
  const sk = bone !== undefined && mdu ? readSkeleton(mdu, model.id) : undefined;
  const b = bone !== undefined ? sk?.bones[bone] : undefined;
  return b ? new THREE.Matrix4().fromArray(b.bindWorld) : undefined;
}

/** The first template of a class an Object Generator spawns (recursively through generators). */
export function generatedOf(pkgs: EntityPackageSet, gen: ResRef, cls: string, depth = 0): ResRef | undefined {
  const t = readTemplate(pkgs, gen);
  if (!t || depth > 3) return undefined;
  if (t.cls === cls) return gen;
  if (t.cls !== 'Object Generator') return undefined;
  for (const r of refList(t.values[0])) {
    const c = generatedOf(pkgs, r, cls, depth + 1);
    if (c) return c;
  }
  return undefined;
}

/** The Spot Light Cone template an Object Generator spawns (recursively through generators). */
export function coneTemplateOf(pkgs: EntityPackageSet, gen: ResRef): ResRef | undefined {
  return generatedOf(pkgs, gen, 'Spot Light Cone');
}

/** A Spot Light template's rig definition: p0 colour (p1 negates), p8 start, p9 length, p10 radius. */
export function spotDefOf(values: readonly unknown[]): { def: SpotDef; sign: number } {
  return { def: { color: num(values[0]) & 0xffffff, start: num(values[8], 1), length: num(values[9], 12), radius: num(values[10], 45) }, sign: num(values[1]) ? -1 : 1 };
}

/** Saved searchlight state: lit (1 / 0) and steering pitch per Mountable uid. */
export interface SearchlightsSave {
  on: Record<string, number>;
  pitch?: Record<string, number>;
}

/** Cone length, opening radius and near end of a cone model (its own -Z axis). */
export function coneShape(positions: ArrayLike<number>): { length: number; near: number; radius: number } {
  let zMin = Infinity, zMax = -Infinity, r = 0;
  for (let i = 0; i < positions.length; i += 3) {
    zMin = Math.min(zMin, positions[i + 2]);
    zMax = Math.max(zMax, positions[i + 2]);
    r = Math.max(r, Math.hypot(positions[i], positions[i + 1]));
  }
  return { length: Math.max(0.1, -zMin), near: Math.max(0, -zMax), radius: r };
}

/**
 * Points a Detector tests against a cone (filter 4): the axis every half metre from the near
 * end, and six rays at the half-angle.
 */
export function conePoints(c: LightCone, near = 0.5): [number, number, number][] {
  const out: [number, number, number][] = [];
  const up = Math.abs(c.dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3().crossVectors(c.dir, up).normalize();
  const b = new THREE.Vector3().crossVectors(c.dir, a).normalize();
  const tan = Math.tan(c.half);
  for (let s = Math.max(0.25, near); s <= c.length + 1e-6; s += 0.5) {
    const p = c.origin.clone().addScaledVector(c.dir, s);
    out.push([p.x, p.y, p.z]);
    const r = s * tan;
    for (let k = 0; k < 6; k++) {
      const t = (k / 6) * Math.PI * 2;
      out.push([p.x + (a.x * Math.cos(t) + b.x * Math.sin(t)) * r, p.y + (a.y * Math.cos(t) + b.y * Math.sin(t)) * r, p.z + (a.z * Math.cos(t) + b.z * Math.sin(t)) * r]);
    }
  }
  return out;
}

export class Searchlights {
  readonly lights: Light[] = [];

  constructor(
    private readonly world: World,
    private readonly dyn: DynamicObjects,
    pkgs: EntityPackageSet,
  ) {
    for (const w of world.of('Mountable')) {
      const gen = w.e.values[49];
      if (!isRef(gen) || w.destroyed) continue;
      const coneT = coneTemplateOf(pkgs, gen);
      const cone = coneT && readTemplate(pkgs, coneT);
      if (!cone?.model) continue;
      const m = readModel(pkgs, cone.model);
      if (!m) continue;
      const shape = coneShape(m.positions);
      // Hardpoint p51 of the Mountable's model, in model space (bind pose).
      const local = hardpointLocal(pkgs, w.e.modelRef, num(w.e.values[51], 3)) ?? new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 1.27, 0);
      const light: Light = { uid: w.uid, w, local, origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), length: shape.length, half: Math.atan2(shape.radius, shape.length), near: shape.near, pitch: 0, on: num(w.e.values[32], 2) === 1 };
      light.mesh = dyn.spawnModel(cone.model, new THREE.Matrix4(), { collides: false, name: `cone:${w.uid.toString(16)}` });
      const spotT = generatedOf(pkgs, gen, 'Spot Light');
      const spotV = spotT && readTemplate(pkgs, spotT)?.values;
      if (spotV) {
        const { def, sign } = spotDefOf(spotV);
        light.spot = { pos: light.origin, dir: light.dir, def, sign };
      }
      this.lights.push(light);
    }
    this.update();
    this.removeSpots = engineLights.addSpotProvider((out) => {
      for (const l of this.lights) if (l.spot && this.lit(l)) out.push(l.spot);
    });
  }

  private removeSpots?: () => void;

  private lit(l: Light) {
    const d = this.dyn.objects.get(l.uid);
    return l.on && !l.w.destroyed && !!d && d.visible;
  }

  save(): SearchlightsSave {
    const s: SearchlightsSave = { on: {}, pitch: {} };
    for (const l of this.lights) {
      s.on[l.uid] = l.on ? 1 : 0;
      if (l.pitch) s.pitch![l.uid] = l.pitch;
    }
    return s;
  }

  load(s: SearchlightsSave) {
    for (const l of this.lights) {
      const v = s.on?.[l.uid];
      l.on = v === undefined ? num(l.w.e.values[32], 2) === 1 : !!v;
      l.pitch = s.pitch?.[l.uid] ?? 0;
    }
    this.update();
  }

  dispose() {
    this.removeSpots?.();
  }

  /** Fire pressed while mounted: lit <-> dark. */
  toggle(uid: number) {
    const l = this.lights.find((x) => x.uid === uid);
    if (l) l.on = !l.on;
    return l?.on;
  }

  /** Lit state of a searchlight (undefined: not one). */
  isOn(uid: number) {
    return this.lights.find((x) => x.uid === uid)?.on;
  }

  /** Steer the cone of a mounted Mountable (the view's pitch; yaw turns the object itself). */
  setPitch(uid: number, pitch: number) {
    const l = this.lights.find((x) => x.uid === uid);
    if (l) l.pitch = pitch;
  }

  private readonly M = new THREE.Matrix4();
  private readonly P = new THREE.Matrix4();

  update() {
    for (const l of this.lights) {
      const d = this.dyn.objects.get(l.uid);
      const gone = l.w.destroyed || !d || !d.visible || !l.on;
      if (l.mesh) this.dyn.setVisible(l.mesh.uid, !gone);
      if (!d || gone) continue;
      // Hardpoint frame, tilted by the steering pitch about its own x axis: the beam runs along
      // the frame's -Z, which a positive turn about x lifts (view pitch up = positive).
      this.M.multiplyMatrices(d.root.matrix, l.local).multiply(this.P.makeRotationX(l.pitch));
      const e = this.M.elements;
      l.origin.set(e[12], e[13], e[14]);
      l.dir.set(-e[8], -e[9], -e[10]).normalize();
      if (l.mesh) {
        l.mesh.root.matrix.copy(this.M);
        l.mesh.root.matrixWorldNeedsUpdate = true;
      }
    }
  }

  /** Cones for Detectors with filter 4 (logic.ts occupants). */
  occupants(): { uid: number; points: [number, number, number][] }[] {
    return this.lights.filter((l) => l.on && !l.w.destroyed && this.dyn.objects.get(l.uid)?.visible).map((l) => ({ uid: l.uid, points: conePoints(l, l.near) }));
  }
}
