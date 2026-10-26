// MorphingModel (class 0xb51c3da1; Suffering.rfl vtable 0x10156110) and DripMorphingModel
// (0x3c3d9695, vtable 0x10154c78) [verified unless marked]: a model whose vertices are blended
// between key models. docs/game-logic.md §14.2.
//
// - Create (vt +0xc, 0x100d2c10): p0 = 0 starts it off (+0xc bit 0), p1 loops (bit 1), p2
//   removes the object at the end of a one-shot (bit 2), p10 rebuilds the drawn model at every
//   segment change (bit 3; 0 in retail). It is valid only with p3 >= 2 key models and, looping,
//   as many p4 times as models (the last time blends the last model back into the first), else
//   one time fewer; every time must be above 0. The total time (+0x10) is the sum of p4. The
//   clock (+0x14) starts at 0 and runs forward (the constructor 0x100d3ba0 sets the direction
//   bit 0x20): no random phase.
// - Think (vt +0x18, 0x100d2e20): nothing while off or paused, unless forced (bit 0x80: set by
//   Reset and when the object is shown again). Else the clock moves by dt forward (backward
//   with the direction bit clear); past the end a looping one wraps (fmod), a one-shot stops
//   there: off, output p15 (forward) / p13 (backward), removed with p2, else posed at the end.
//   The segment i is the first whose running sum of p4 reaches the clock; its weight is
//   f = 1 - (sum_i - clock) / p4[i]. Reaching segment p5 pauses it (bit 0x100, once per run:
//   bit 0x200) and fires p14. A clock passing p11 calls vt +0x4c: p12 is spawned at the object
//   (MorphingModel 0x100d25f0; the DripMorphingModel 0x100a8b40 also drops its Drip, drip.ts).
//   Segment p9 (0 = none) starts a fade: opacity (engine +0xd0) = 1 - (clock - start) / (total
//   - start). Then every vertex v of the drawn model below the models' unique-vertex count
//   becomes A[v] + (B[v] - A[v]) x f (A = model p3[i], B = p3[i + 1], p3[0] after the last),
//   and the drawn model's duplicated vertices are copied from their sources (the pair list of
//   .mdu entry 17, list +0xa8: u16 source, u16 copy). Positions only: normals and colours stay.
//   Key models of a different unique count are refused and the object removed (0x100d35c7 ->
//   engine vt +0x30). The unique count is the positive entries of .mdu entry 22 (the list at
//   +0xb4 is index-aligned across the models; every retail key family agrees on it while their
//   vertex counts differ, e.g. the drips' 49 / 41 / 49) [strong: code shape + every retail
//   family]. The object is then marked dirty (+8 bit 0x1000): one lit at run time is lit again
//   at its new positions, one with .ldu colours keeps them [verified renderer, docs/re/renderer.md
//   §1.9; port: the colours of the first pass are kept].
// - Inputs (map 0x10178a18, run in this order, every matching slot): p16 On (on, and think at
//   once), p21 Off, p17 backward / p18 forward / p22 flip the direction (each also turns it on
//   and thinks), p23 Reset (clock 0, pause cleared, off, forced), p19 skip the next pause, p20
//   resume a pause (and think), p24 remove the object (0x100cb870 -> engine vt +0x30). A one-shot
//   at its end stays there off; On does nothing more (its clock is at the end), Reset rewinds it.
// - p7 / p8: a random p7 sound every total-time while none plays, stopped by Off / the end with
//   p8; p6 keeps the clock while a key model is not loaded. Not ported: every retail p7 is empty.
//
// The flame of a thrown flare (BouncingObject 4:452 p36 -> generator 4:942 -> 4:938): four key
// models 4:172 / 4:170 / 4:171 / 4:169, 42 vertices each, blended over 0.075 / 0.11 / 0.1 /
// 0.085 s, looping; material 4:939 (one additive layer, blend 2, tint 0xffcd9b) [data].
//
// The blend runs on the GPU: the drawn meshes carry one morph target per distinct key model and
// the pose sets two influences, (1 - f) on A and f on B (three's absolute morph targets give
// A + (B - A) x f); no vertex buffer is rewritten per frame.

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../formats/entities';
import { findEntry, MDU_VERTICES, readModel, type PackageSet, type ResRef, type RiotModel } from '../../formats/model';
import { translucentPassState } from '../../formats/render-data';
import { cloneWithGlowMark } from '../../app/glow-mark';
import type { DynamicObject, DynamicObjects } from './dynamic';

export interface MorphingModelDef {
  frames: ResRef[];
  /** p4: blend time of each segment (s). */
  times: number[];
  /** p1: the last model blends back into the first. */
  loop: boolean;
  /** p0: running from creation. */
  on: boolean;
  /** Sum of the times. */
  total: number;
  /** p2: a one-shot removes its object at the end. */
  removeAtEnd?: boolean;
  /** p5: the segment that pauses it and fires p14 (-1: none). */
  pauseAt?: number;
  /** p9: the segment it starts fading out at (0: none). */
  fadeFrom?: number;
  /** p11: the clock time whose crossing calls vt +0x4c (spawn p12; a DripMorphingModel's drip). */
  spawnAt?: number;
  /** p12: spawned at the p11 time. */
  spawn?: ResRef;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refs = (v: unknown): ResRef[] => (Array.isArray(v) ? v : v ? [v] : []).filter((r): r is ResRef => !!r && typeof r === 'object' && typeof (r as ResRef).id === 'number');
const ref1 = (v: unknown): ResRef | undefined => refs(v)[0];
/** Signed 32-bit read of an int property (p5 = -1 is stored as 0xffffffff). */
const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v | 0 : d);

/** The template's key models and times, or undefined where the create refuses it (0x100d2c10). */
export function morphingModelDef(v: PropValue[]): MorphingModelDef | undefined {
  const frames = refs(v[3]);
  const times = (Array.isArray(v[4]) ? (v[4] as unknown[]) : []).map((x) => num(x));
  const loop = num(v[1]) !== 0;
  if (frames.length < 2) return undefined;
  if (times.length !== (loop ? frames.length : frames.length - 1)) return undefined;
  if (times.some((t) => !(t > 0))) return undefined;
  return {
    frames,
    times,
    loop,
    on: num(v[0]) !== 0,
    total: times.reduce((a, b) => a + b, 0),
    removeAtEnd: num(v[2]) !== 0,
    pauseAt: int(v[5], -1),
    fadeFrom: int(v[9], 0),
    spawnAt: num(v[11]),
    spawn: ref1(v[12]),
  };
}

/** The clock after `dt` more seconds forward (wraps when looping, else stops at the end). */
export function morphClock(d: MorphingModelDef, t: number, dt: number): number {
  const n = t + dt;
  if (n <= d.total) return n;
  return d.loop ? n % d.total : d.total;
}

/** The segment the clock is in: blend from key model `a` to `b` by `f` (0..1). */
export function morphSegment(d: MorphingModelDef, t: number): { a: number; b: number; f: number } {
  let sum = 0;
  let i = 0;
  for (; i < d.times.length; i++) {
    sum += d.times[i];
    if (!(sum < t)) break;
  }
  if (i >= d.times.length) i = d.times.length - 1;
  const f = Math.min(1, Math.max(0, 1 - (sum - t) / d.times[i]));
  const b = i + 1 === d.frames.length ? 0 : i + 1;
  return { a: i, b, f };
}

/**
 * Does a clock moving from `o` to `n` cross the p11 time `t` (0x100d31c4..0x100d321e)? Rising:
 * o <= t < n; falling (a wrap): o <= t or t < n, as the engine tests it.
 */
export function morphCrosses(o: number, n: number, t: number): boolean {
  if (o < n) return o <= t && t < n;
  if (o > n) return o <= t || t < n;
  return false;
}

/** Input slots in the order of the class map 0x10178a18. */
export const MORPH_INPUTS = [16, 21, 17, 18, 22, 23, 19, 20, 24] as const;

export interface MorphEvents {
  /** Output slots fired (13, 14, 15). */
  fire: number[];
  /** vt +0x4c calls (the p11 time crossed). */
  spawn: number;
  /** The object removes itself (p2 at the end, p24). */
  remove: boolean;
}

export const morphEvents = (): MorphEvents => ({ fire: [], spawn: 0, remove: false });

/** The logic of one MorphingModel (renderer-free). */
export class MorphMachine {
  clock = 0;
  /** +0xc bit 0. */
  off: boolean;
  /** Bit 0x20. */
  forward = true;
  /** Bit 0x100: held at the p5 segment until p20. */
  paused = false;
  /** Bit 0x200: this run's pause is spent (or skipped by p19). */
  passed = false;
  /** Bit 0x80: the next think runs although off / paused. */
  force = false;
  /** Bit 0x40: the object was shown at the last think. */
  shown: boolean;
  /** +0x24: the segment of the last blend. */
  seg = 0;
  /** +0x1c / +0x20: fade start clock (0: none yet) and the time left from it. */
  fadeStart = 0;
  fadeLeft = 0;
  /** The current blend; undefined until the first blend (the drawn model as placed). */
  pose?: { a: number; b: number; f: number };
  /** Engine opacity +0xd0 (unclamped; above 1 before a restarted fade comes round again). */
  opacity = 1;
  removed = false;
  /** Frame time of the last think (the handlers' immediate thinks use it). */
  private lastDt = 0;

  constructor(
    readonly def: MorphingModelDef,
    shown = true,
  ) {
    this.off = !def.on;
    this.shown = shown;
  }

  /** One think (0x100d2e20). */
  think(dt: number, shown = true, ev: MorphEvents = morphEvents()): MorphEvents {
    if (this.removed) return ev;
    this.lastDt = dt;
    if (!this.shown && shown) this.force = true;
    this.shown = shown;
    if ((this.off || this.paused) && !this.force) return ev;
    const d = this.def;
    this.force = false;
    const old = this.clock;
    if (this.forward) {
      this.clock += dt;
      if (this.clock > d.total) {
        if (d.loop) {
          this.clock %= d.total;
          this.passed = false;
        } else {
          this.clock = d.total;
          if (this.end(ev)) return ev;
        }
      }
    } else {
      this.clock -= dt;
      if (this.clock < 0) {
        if (d.loop) {
          this.clock = (this.clock % d.total) + d.total;
          this.passed = false;
        } else {
          this.clock = 0;
          if (this.end(ev)) return ev;
        }
      }
    }
    const s = morphSegment(d, this.clock);
    if (s.a === (d.pauseAt ?? -1) && !this.passed) {
      this.paused = this.passed = true;
      ev.fire.push(14);
    }
    if (d.spawnAt !== undefined && morphCrosses(old, this.clock, d.spawnAt)) ev.spawn++;
    const fadeFrom = d.fadeFrom ?? 0;
    if (fadeFrom !== 0 && this.fadeStart === 0 && s.a === fadeFrom) {
      this.fadeStart = this.clock;
      this.fadeLeft = d.total - this.clock;
    }
    if (this.fadeStart !== 0) this.opacity = 1 - (this.clock - this.fadeStart) / this.fadeLeft;
    this.seg = s.a;
    this.pose = s;
    return ev;
  }

  /** The end of a one-shot (0x100d3005): off, p15 / p13; true when it removes itself (p2). */
  private end(ev: MorphEvents): boolean {
    this.off = true;
    this.passed = false;
    ev.fire.push(this.forward ? 15 : 13);
    if (this.def.removeAtEnd) {
      this.removed = true;
      ev.remove = true;
      return true;
    }
    return false;
  }

  /** An input slot of the class map (see MORPH_INPUTS). */
  input(slot: number, ev: MorphEvents = morphEvents()): MorphEvents {
    if (this.removed) return ev;
    const resume = () => {
      if (this.off) {
        this.off = false;
        this.think(this.lastDt, this.shown, ev);
      }
    };
    switch (slot) {
      case 16:
        resume();
        break;
      case 21:
        this.off = true;
        break;
      case 17:
        this.forward = false;
        resume();
        break;
      case 18:
        this.forward = true;
        resume();
        break;
      case 22:
        this.forward = !this.forward;
        resume();
        break;
      case 23:
        this.clock = 0;
        this.paused = this.passed = false;
        this.off = true;
        this.force = true;
        break;
      case 19:
        this.passed = true;
        break;
      case 20:
        if (this.paused) {
          this.paused = false;
          this.think(this.lastDt, this.shown, ev);
        }
        break;
      case 24:
        this.removed = true;
        ev.remove = true;
        break;
    }
    return ev;
  }

  /** Reset, then On (0x100d3ad0: the Drip restarts its splash this way). */
  restart(ev: MorphEvents = morphEvents()): MorphEvents {
    this.input(23, ev);
    return this.input(16, ev);
  }

  /** In its start state (nothing to save)? */
  get pristine(): boolean {
    return this.clock === 0 && this.off === !this.def.on && this.forward && !this.paused && !this.passed && !this.pose && this.fadeStart === 0;
  }

  /** The class save (vt +0x30 0x100d2770 writes the clock, flags and fade). */
  save(): number[] {
    const bits = (this.off ? 1 : 0) | (this.forward ? 0x20 : 0) | (this.paused ? 0x100 : 0) | (this.passed ? 0x200 : 0) | (this.pose ? 0x1000 : 0);
    return [this.clock, bits, this.fadeStart, this.fadeLeft];
  }

  load(s: readonly number[]) {
    const [clock, bits, fs, fl] = s;
    this.clock = num(clock);
    this.off = !!(bits & 1);
    this.forward = !!(bits & 0x20);
    this.paused = !!(bits & 0x100);
    this.passed = !!(bits & 0x200);
    this.fadeStart = num(fs);
    this.fadeLeft = num(fl);
    this.pose = bits & 0x1000 ? morphSegment(this.def, this.clock) : undefined;
    this.opacity = this.fadeStart !== 0 ? 1 - (this.clock - this.fadeStart) / this.fadeLeft : 1;
  }
}

// ---------------------------------------------------------------------------
// Key model vertices

export interface MorphKey {
  /** File vertex positions (xyz). */
  positions: Float32Array;
  /** Unique vertices: the positive entries of .mdu entry 22 (all vertices without it). */
  unique: number;
  /** Duplicated vertex -> its source (.mdu entry 17 pairs). */
  dup: Map<number, number>;
}

/** A model's vertex data as the blend reads it, or undefined when it does not decode. */
export function morphKey(pkgs: PackageSet, r: ResRef): MorphKey | undefined {
  const mdu = pkgs.get(r.pkg)?.mdu;
  const ev = findEntry(mdu, MDU_VERTICES, r.id);
  if (!mdu || !ev) return undefined;
  const vv = mdu.data(ev);
  const nv = vv.getUint16(0, true);
  if (vv.byteLength < 2 + 12 * nv) return undefined;
  const positions = new Float32Array(3 * nv);
  for (let i = 0; i < 3 * nv; i++) positions[i] = vv.getFloat32(2 + 4 * i, true);
  let unique = nv;
  const e22 = findEntry(mdu, 22, r.id);
  if (e22) {
    const t = mdu.data(e22);
    const n = t.getUint16(0, true);
    if (t.byteLength >= 2 + 2 * n) {
      unique = 0;
      for (let k = 0; k < n; k++) if (t.getInt16(2 + 2 * k, true) > 0) unique++;
    }
  }
  const dup = new Map<number, number>();
  const e17 = findEntry(mdu, 17, r.id);
  if (e17) {
    const t = mdu.data(e17);
    const n = t.byteLength >= 8 ? t.getUint16(4, true) : 0;
    for (let k = 0; k < n && 12 + 4 * k <= t.byteLength; k++) dup.set(t.getUint16(10 + 4 * k, true), t.getUint16(8 + 4 * k, true));
  }
  return { positions, unique, dup };
}

/**
 * The position key `k` gives drawn vertex `v` (scaled by `s`): v itself below the unique count,
 * its source when it is a duplicate, undefined otherwise (it keeps its own).
 */
export function keyVertex(k: MorphKey, drawn: MorphKey, v: number): number | undefined {
  if (v < drawn.unique) return v < k.positions.length / 3 ? v : undefined;
  const src = drawn.dup.get(v);
  return src !== undefined && src < drawn.unique && src < k.positions.length / 3 ? src : undefined;
}

// ---------------------------------------------------------------------------
// GPU blend on a dynamic object's meshes

/** Own copies of a mesh's materials once an opacity below 1 applies (body-parts.ts does the same). */
interface FadeState {
  mats: THREE.Material[];
  base: { transparent: boolean; depthWrite: boolean; alphaTest: number; alphaToCoverage: boolean }[];
}

/** Morph targets on the meshes of a drawn object: one per distinct key model. */
export class MorphTargets {
  private constructor(
    readonly obj: DynamicObject,
    private readonly meshes: THREE.Mesh[],
    /** Key index -> morph target index. */
    private readonly targetOf: number[],
    private readonly count: number,
  ) {}

  private fades = new Map<THREE.Mesh, FadeState>();
  private applied = '';

  /**
   * Morph targets for `def`'s key models on `obj` (drawn as `model`, its vertices scaled by
   * `scale`). Undefined when a key model is missing or its unique-vertex count differs from the
   * drawn model's (the engine removes such an object at its first blend).
   */
  static attach(obj: DynamicObject, pkgs: PackageSet, def: MorphingModelDef, scale?: readonly number[]): MorphTargets | undefined {
    const model: RiotModel | undefined = obj.model;
    if (!model) return undefined;
    const drawn = morphKey(pkgs, model.ref);
    if (!drawn) return undefined;
    const keyIds = new Map<string, number>();
    const keys: MorphKey[] = [];
    const targetOf: number[] = [];
    for (const f of def.frames) {
      const id = `${f.pkg}:${f.id}`;
      let t = keyIds.get(id);
      if (t === undefined) {
        const k = morphKey(pkgs, f);
        if (!k || k.unique !== drawn.unique) return undefined;
        keyIds.set(id, (t = keys.length));
        keys.push(k);
      }
      targetOf.push(t);
    }
    const s = scale ?? [1, 1, 1];
    const meshes: THREE.Mesh[] = [];
    for (const c of obj.pivot.children) {
      const mesh = c as THREE.Mesh;
      const g = mesh.isMesh ? (mesh.geometry as THREE.BufferGeometry) : undefined;
      const corners = g?.userData.corners as Uint32Array | undefined;
      const pos = g?.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!g || !corners || !pos) continue;
      const base = pos.array as Float32Array;
      g.morphAttributes.position = keys.map((k) => {
        const a = new Float32Array(3 * corners.length);
        for (let j = 0; j < corners.length; j++) {
          const v = keyVertex(k, drawn, model.source[corners[j]]);
          if (v === undefined) a.set(base.subarray(3 * j, 3 * j + 3), 3 * j);
          else for (let x = 0; x < 3; x++) a[3 * j + x] = k.positions[3 * v + x] * s[x];
        }
        return new THREE.BufferAttribute(a, 3);
      });
      g.morphTargetsRelative = false;
      mesh.updateMorphTargets();
      mesh.morphTargetInfluences!.fill(0);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      meshes.push(mesh);
    }
    return meshes.length ? new MorphTargets(obj, meshes, targetOf, keys.length) : undefined;
  }

  /** Show a pose (undefined: the drawn model as placed) at an opacity (clamped to 0..1). */
  apply(pose: { a: number; b: number; f: number } | undefined, opacity = 1) {
    const op = Math.min(1, Math.max(0, opacity));
    const key = pose ? `${pose.a},${pose.b},${pose.f},${op}` : `-,${op}`;
    if (key === this.applied) return;
    this.applied = key;
    for (const m of this.meshes) {
      const inf = m.morphTargetInfluences!;
      for (let i = 0; i < this.count; i++) inf[i] = 0;
      if (pose) {
        inf[this.targetOf[pose.a]] += 1 - pose.f;
        inf[this.targetOf[pose.b]] += pose.f;
      }
      this.opacity(m, op);
    }
  }

  /** Engine opacity: below 0.99 opaque / cut-out passes draw blended (translucentPassState). */
  private opacity(mesh: THREE.Mesh, op: number) {
    let st = this.fades.get(mesh);
    if (!st) {
      if (op >= 1) return;
      const m = mesh.material;
      const mats = (Array.isArray(m) ? m : [m]).map((x) => cloneWithGlowMark(x));
      st = { mats, base: mats.map((x) => ({ transparent: x.transparent, depthWrite: x.depthWrite, alphaTest: x.alphaTest, alphaToCoverage: x.alphaToCoverage })) };
      this.fades.set(mesh, st);
      mesh.material = mats.length === 1 ? mats[0] : mats;
    }
    st.mats.forEach((m, k) => {
      const b = st.base[k];
      const s = translucentPassState(b, op);
      const a2c = s.transparent && !b.transparent ? false : b.alphaToCoverage;
      if (s.transparent !== m.transparent || s.depthWrite !== m.depthWrite || s.alphaTest !== m.alphaTest || a2c !== m.alphaToCoverage) {
        m.transparent = s.transparent;
        m.depthWrite = s.depthWrite;
        m.alphaTest = s.alphaTest;
        m.alphaToCoverage = a2c;
        m.needsUpdate = true;
      }
      m.opacity = op;
    });
  }

  dispose() {
    for (const st of this.fades.values()) for (const m of st.mats) m.dispose();
    this.fades.clear();
  }
}

/**
 * A spawned MorphingModel drawn by the dynamic objects (its first key model, with its own
 * materials), blended on the GPU. Follows the matrix it is given (`follow`).
 */
export class MorphingModelRun {
  private constructor(
    readonly def: MorphingModelDef,
    readonly obj: DynamicObject,
    private readonly targets: MorphTargets,
    private readonly dyn: DynamicObjects,
  ) {
    this.apply();
  }

  t = 0;

  /** Builds it at M; undefined when a key model is missing or the vertex counts differ. */
  static spawn(dyn: DynamicObjects, pkgs: PackageSet, def: MorphingModelDef, M: THREE.Matrix4, name: string): MorphingModelRun | undefined {
    if (!readModel(pkgs, def.frames[0])) return undefined;
    const obj = dyn.spawnModel(def.frames[0], M, { collides: false, name });
    if (!obj) return undefined;
    const targets = MorphTargets.attach(obj, pkgs, def);
    if (!targets) {
      dyn.remove(obj.uid);
      return undefined;
    }
    return new MorphingModelRun(def, obj, targets, dyn);
  }

  /** Place it (world matrix of what it follows). */
  follow(M: THREE.Matrix4) {
    this.obj.root.matrix.copy(M);
    this.obj.root.matrixWorldNeedsUpdate = true;
  }

  step(dt: number) {
    if (!this.def.on) return;
    this.t = morphClock(this.def, this.t, dt);
    this.apply();
  }

  private apply() {
    this.targets.apply(morphSegment(this.def, this.t));
  }

  remove() {
    this.targets.dispose();
    this.dyn.remove(this.obj.uid);
  }
}
