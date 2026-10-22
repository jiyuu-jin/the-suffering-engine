// Electric Arc Effect (class 0x2d326c65) and Electric Arc (0x6c5a0ad6): the bolts a Damage Action
// Object (p8), a Lightning projectile (p27) or a particle impact puts on a target. Decoded from
// Suffering.rfl (docs/game-logic.md §17.3.1). [verified] unless marked.
//
// Electric Arc Effect (ctor 0x100aada0, start 0x100ab3d0, spawn 0x100ab180, update 0x100ab590):
//   p0 seconds it lasts (-1: until removed; 999 on Horace), p1 an Object Generator spawned at the
//   start endpoint and attached to it (a flickering pale-blue Point Light, 0x100aa680), p2 the
//   endpoints: 1 = the target and, recursively, the objects it links to (a loop ends the effect,
//   0x100aa380), otherwise the bones of the target's skeleton (0x100aa080; no skeleton or fewer
//   than two endpoints ends it). Both form a tree: first child / next sibling (bone records +0x44
//   / +0x48; the link order). p3 arcs, p4 the Electric Arc template, p5 = 1 travel, p6 = 0 ends
//   a travelling effect at the end of its path (otherwise it starts again from the root), p7 = 1
//   looks at direct children only, p8 damage per second to the target (0x100a9ef0; 0 in retail).
//   The start endpoint is the hit bone the spawning message carries, else bone 1 / the target.
// Electric Arc (ctor 0x1001ff80, init 0x100a9bf0, update 0x100a9c40): an engine object drawing the
//   template's model (3:447 / 3:578 / 3:1054 / 3:1150: two crossed ribbons 0.4 wide and 1 long
//   along -z, 10 or 20 sections, an additive bolt texture whose material carries the glow mark),
//   p0 / p1 (m) the distance range for its next end, p2 bow scale, p3..p4 (%) the per-section bow
//   range, p5..p6 (s) how long it keeps its ends, p7..p8 (%) the width scale.
//
// Every frame, for every arc (0x100ab590):
//   - its life t counts down (0x100a9c40); at 0 it takes new ends and a life U(p5, p6):
//       random (p5 = 0, 0x100aaf80): the old end B becomes the start A; the new B is a random
//         endpoint farther than p0 and nearer than p1 from A (0x100aa7a0), else any endpoint
//         (A itself included: a zero-length arc, drawn 0.01 long);
//       travel (p5 = 1, 0x100ab460): A <- B <- C and C <- next(C): a descendant of the node in
//         the tree within (p0, p1) of it (0x100aa9d0; below p0 the walk goes deeper with p1 less
//         that distance). Only arc 0 travels; the others copy its ends and life;
//   - width w = U(p7, p8) / 100, rolled every frame;
//   - travel: k = 1 - t / life; the arc runs from A + (B - A) k to B + (C - B) k (from A->B
//     to B->C over its life); with no C it shrinks into B, w x sqrt(1 - k);
//   - the model is placed at the start, its -z turned to the end, scaled (w, w, length) and
//     rolled about its axis by U(0, 2 pi);
//   - its sections (the vertices of one z, sorted by z; a vertex at the origin is left out,
//     0x100c3810) move along the model's y by sin(pi i / n) x U(p3, p4) / 100 x p2 x length
//     (model units): a bow to one side with a jagged edge, new every frame.
// The arc hides while its target is hidden. Arcs of one effect are separate objects; the
// effect is destroyed with its target.
//
// The glow: the bolt material's glow mark (Advanced Material p5) feeds the engine's HDR scene
// glow (docs/re/renderer.md §3.2, src/app/scene-glow.ts): the arc meshes are drawn with the
// model's own material, so the glow pass blurs their pixels and adds them back as the engine does.

import * as THREE from 'three/webgpu';
import { engineColor, engineLights, LEGACY_LIGHTING, type EnginePointLight } from '../../app/engine-light';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import type { DynamicObject } from '../world/dynamic';
import { lightingEffectDef, lightingEffectK, type LightingEffectDef } from '../world/lights';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in (v as object);

// ---------------------------------------------------------------------------------------------
// Templates

/** Electric Arc template (one bolt). */
export interface ArcTemplate {
  /** p0 / p1 (m): an end is picked farther than `near` and nearer than `far` from the other. */
  near: number;
  far: number;
  /** p2: bow scale. */
  bow: number;
  /** p3..p4 / 100: per-section bow range. */
  jitter: [number, number];
  /** p5..p6 (s): how long the arc keeps its ends. */
  life: [number, number];
  /** p7..p8 / 100: width scale of the model, rolled every frame. */
  width: [number, number];
  /** The bolt model (two crossed ribbons along -z). */
  model?: ResRef;
}

/** Electric Arc Effect template. */
export interface ArcEffectTemplate {
  ref?: ResRef;
  /** p0 (s); -1 = until removed. */
  duration: number;
  /** p1: Object Generator attached at the start endpoint (its Point Light). */
  generator?: ResRef;
  /** p2 = 1: the target and the objects it links to; otherwise the target's bones. */
  links: boolean;
  /** p3: number of arcs. */
  count: number;
  /** p4 */
  arc?: ArcTemplate;
  /** p5 = 1: the arcs travel along the tree. */
  travel: boolean;
  /** p6 != 0: a travelling effect starts again from the root at the end of its path. */
  loop: boolean;
  /** p7 = 1: travel to direct children only. */
  childrenOnly: boolean;
  /** p8: damage per second to the target (0 in retail). */
  damage: number;
}

function templateValues(pkgs: EntityPackageSet, r: ResRef, cls: string): { values: PropValue[]; model?: ResRef } | undefined {
  const t = readObjectTemplate(pkgs, r);
  const c = t ? classByHash(t.classHash) : undefined;
  if (!t || c?.name !== cls) return undefined;
  return { values: decodeTemplateProps(c, t), model: t.modelRef };
}

export function arcTemplateFrom(v: PropValue[], model?: ResRef): ArcTemplate {
  const lo = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
  return {
    near: num(v[0]),
    far: num(v[1], 3),
    bow: num(v[2]),
    jitter: lo(num(v[3]) / 100, num(v[4]) / 100),
    life: lo(num(v[5], 0.5), num(v[6], 1)),
    width: lo(num(v[7], 35) / 100, num(v[8], 50) / 100),
    model,
  };
}

export function readArcTemplate(pkgs: EntityPackageSet, r: ResRef): ArcTemplate | undefined {
  const t = templateValues(pkgs, r, 'Electric Arc');
  return t && arcTemplateFrom(t.values, t.model);
}

export function readArcEffect(pkgs: EntityPackageSet, r: ResRef): ArcEffectTemplate | undefined {
  const t = templateValues(pkgs, r, 'Electric Arc Effect');
  if (!t) return undefined;
  const v = t.values;
  return {
    ref: r,
    duration: num(v[0], -1),
    generator: isRef(v[1]) ? v[1] : undefined,
    links: num(v[2]) === 1,
    count: Math.max(0, Math.round(num(v[3], 1))),
    arc: isRef(v[4]) ? readArcTemplate(pkgs, v[4]) : undefined,
    travel: num(v[5]) === 1,
    loop: num(v[6]) !== 0,
    childrenOnly: num(v[7]) === 1,
    damage: num(v[8]),
  };
}

// ---------------------------------------------------------------------------------------------
// Endpoint trees

/** Endpoints as a tree: first child / next sibling, -1 = none. */
export interface ArcTree {
  count: number;
  firstChild: Int32Array;
  nextSibling: Int32Array;
}

/** A skeleton's bone tree (children in index order, as the bone records link them). */
export function treeFromParents(parents: ArrayLike<number>): ArcTree {
  const n = parents.length;
  const firstChild = new Int32Array(n).fill(-1), nextSibling = new Int32Array(n).fill(-1), last = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = parents[i];
    if (p < 0 || p >= n || p === i) continue;
    if (last[p] < 0) firstChild[p] = i;
    else nextSibling[last[p]] = i;
    last[p] = i;
  }
  return { count: n, firstChild, nextSibling };
}

/**
 * The target and, recursively, the objects it links to (0x100aa380): each link becomes the next
 * child of its object. undefined when an object turns up twice (the original destroys the effect).
 */
export function linkTree(root: number, linksOf: (uid: number) => readonly number[] | undefined): { uids: number[]; tree: ArcTree } | undefined {
  const uids = [root];
  const fc: number[] = [-1], ns: number[] = [-1];
  const seen = new Set([root]);
  const walk = (i: number): boolean => {
    let last = -1;
    for (const l of linksOf(uids[i]) ?? []) {
      if (seen.has(l)) return false;
      seen.add(l);
      const j = uids.length;
      uids.push(l);
      fc.push(-1);
      ns.push(-1);
      if (last < 0) fc[i] = j;
      else ns[last] = j;
      last = j;
      if (!walk(j)) return false;
    }
    return true;
  };
  if (!walk(0)) return undefined;
  return { uids, tree: { count: uids.length, firstChild: Int32Array.from(fc), nextSibling: Int32Array.from(ns) } };
}

type P3 = THREE.Vector3Like;
const dist = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A random endpoint within (near, far) of i, else any endpoint (0x100aa7a0). */
export function randomEndpoint(P: readonly P3[], i: number, near: number, far: number, rnd: () => number = Math.random): number {
  if (i < 0 || !P.length) return -1;
  const c: number[] = [];
  for (let j = 0; j < P.length; j++) {
    if (j === i) continue;
    const d = dist(P[i], P[j]);
    if (d > near && d < far) c.push(j);
  }
  if (c.length) return c[Math.floor(rnd() * c.length) % c.length];
  return Math.floor(rnd() * P.length) % P.length;
}

/** The next endpoint of a travelling arc (0x100aafb0 / 0x100aa9d0): -1 at the end of a path. */
export function nextEndpoint(P: readonly P3[], tree: ArcTree, i: number, near: number, far: number, childrenOnly: boolean, rnd: () => number = Math.random): number {
  if (i < 0 || i >= tree.count) return -1;
  const first = tree.firstChild[i];
  if (first < 0) return -1;
  const from = P[i];
  const c: number[] = [];
  const walk = (start: number, lo: number, hi: number) => {
    let node = start;
    for (let guard = 0; guard < tree.count + 1 && node >= 0; guard++) {
      const sib = tree.nextSibling[node];
      if (sib >= 0) walk(sib, lo, hi);
      const d = dist(from, P[node]);
      if (d > lo && d < hi) c.push(node);
      else if (d > hi) return;
      if (childrenOnly) return;
      hi -= d;
      node = tree.firstChild[node];
    }
  };
  walk(first, near, far);
  return c.length ? c[Math.floor(rnd() * c.length) % c.length] : -1;
}

// ---------------------------------------------------------------------------------------------
// The effect's arcs (no drawing: tests run this directly)

export interface ArcSlot {
  a: number;
  b: number;
  /** Travel: the end after B (-1 = none). */
  c: number;
  /** Life left and its length (s). */
  t: number;
  period: number;
  gone?: boolean;
}

export class ArcEffectSim {
  readonly arcs: ArcSlot[] = [];
  /** Seconds left; -1 = until removed. */
  left: number;
  dead = false;
  readonly arc: ArcTemplate;
  /** The start endpoint (where the generator's light hangs). */
  readonly start: number;

  constructor(
    readonly fx: ArcEffectTemplate,
    readonly tree: ArcTree,
    P: readonly P3[],
    start?: number,
    private readonly rnd: () => number = Math.random,
  ) {
    this.arc = fx.arc ?? arcTemplateFrom([]);
    this.left = fx.duration;
    // Fewer than two endpoints: the effect is destroyed at once (0x100aac60 / 0x100aa080).
    let s = start ?? (fx.links ? 0 : 1);
    if (s < 0 || s >= tree.count) s = fx.links ? 0 : Math.min(1, tree.count - 1);
    this.start = s;
    if (tree.count < 2 || !fx.arc || fx.count < 1) {
      this.dead = true;
      return;
    }
    const A = this.arc;
    for (let k = 0; k < fx.count; k++) {
      const slot: ArcSlot = { a: s, b: -1, c: -1, t: 0, period: 0 };
      let b: number;
      if (!fx.travel) b = randomEndpoint(P, s, A.near, A.far, rnd);
      else {
        b = this.next(P, s);
        if (b < 0) {
          // Nowhere to go from the hit bone: from bone 1 (0x100ab29c).
          if (s === 1) {
            this.die();
            return;
          }
          s = 1;
          slot.a = 1;
          b = this.next(P, 1);
        }
        if (b >= 0) slot.c = this.next(P, b);
      }
      if (b < 0) {
        this.die();
        return;
      }
      slot.b = b;
      slot.t = slot.period = this.life();
      this.arcs.push(slot);
    }
    if (fx.travel) for (const x of this.arcs) x.t = x.period = this.arcs[0].t;
  }

  private die() {
    this.dead = true;
  }

  private life() {
    const [lo, hi] = this.arc.life;
    return lo + this.rnd() * (hi - lo);
  }

  private next(P: readonly P3[], i: number) {
    return nextEndpoint(P, this.tree, i, this.arc.near, this.arc.far, this.fx.childrenOnly, this.rnd);
  }

  /** Advance the lives and the effect's time; new ends for arcs whose life ran out. */
  step(dt: number, P: readonly P3[]) {
    if (this.dead) return;
    for (const x of this.arcs) x.t -= dt;
    if (!this.arcs.some((x) => !x.gone)) return this.die();
    if (this.left !== -1) {
      this.left -= dt;
      if (this.left <= 0) return this.die();
    }
    const A = this.arc;
    for (let i = 0; i < this.arcs.length; i++) {
      const x = this.arcs[i];
      if (x.gone || x.t > 0) continue;
      if (!this.fx.travel) {
        x.a = x.b;
        x.b = randomEndpoint(P, x.a, A.near, A.far, this.rnd);
        x.t = x.period = this.life();
        continue;
      }
      if (i > 0) continue;
      // Arc 0 travels; the others take its ends and life (0x100ab774).
      x.a = x.b;
      x.b = x.c;
      x.c = this.next(P, x.b);
      if (x.b < 0) {
        if (!this.fx.loop) return this.die();
        x.a = this.fx.links ? 0 : 1;
        x.b = this.next(P, x.a);
        x.c = this.next(P, x.b);
        if (x.b < 0) {
          x.gone = true;
          continue;
        }
      }
      x.t = x.period = this.life();
      for (let j = 1; j < this.arcs.length; j++) {
        const o = this.arcs[j];
        if (o.gone) continue;
        o.a = x.a;
        o.b = x.b;
        o.c = x.c;
        o.t = o.period = x.t;
      }
    }
  }

  /**
   * Where arc i runs this frame: S -> E and its width scale (rolled every frame); -1 when the
   * arc is gone. Travel: from A->B to B->C over its life, shrinking into B when there is no C.
   */
  segment(i: number, P: readonly P3[], S: THREE.Vector3, E: THREE.Vector3): number {
    const x = this.arcs[i];
    if (!x || x.gone || x.a < 0 || x.b < 0) return -1;
    const [lo, hi] = this.arc.width;
    let w = lo + this.rnd() * (hi - lo);
    const A = P[x.a], B = P[x.b];
    if (!this.fx.travel) {
      S.set(A.x, A.y, A.z);
      E.set(B.x, B.y, B.z);
      return w;
    }
    const k = x.period > 0 ? Math.min(1, Math.max(0, 1 - x.t / x.period)) : 1;
    const C = x.c >= 0 ? P[x.c] : B;
    if (x.c < 0) w *= Math.sqrt(1 - k);
    S.set(A.x + (B.x - A.x) * k, A.y + (B.y - A.y) * k, A.z + (B.z - A.z) * k);
    E.set(B.x + (C.x - B.x) * k, B.y + (C.y - B.y) * k, B.z + (C.z - B.z) * k);
    return w;
  }
}

/**
 * Bow of each section (0x100a9c40): sin(pi i / n) x U(p3, p4) / 100 x p2 x length, in model
 * units along the model's y (i = 0 at the far end, z = -1).
 */
export function sectionBow(n: number, arc: Pick<ArcTemplate, 'bow' | 'jitter'>, length: number, out: Float32Array, rnd: () => number = Math.random): Float32Array {
  const [lo, hi] = arc.jitter;
  for (let i = 0; i < n; i++) out[i] = Math.sin((Math.PI * i) / n) * (lo + rnd() * (hi - lo)) * arc.bow * length;
  return out;
}

/** Sections of a bolt model: distinct z values sorted ascending; vertices at the origin are left out. */
export function modelSections(positions: ArrayLike<number>): { z: number[]; group: Int16Array } {
  const n = positions.length / 3;
  const zs = new Set<number>();
  for (let j = 0; j < n; j++) {
    const x = positions[3 * j], y = positions[3 * j + 1], z = positions[3 * j + 2];
    if (x === 0 && y === 0 && z === 0) continue;
    zs.add(z);
  }
  const z = [...zs].sort((a, b) => a - b);
  const index = new Map(z.map((v, i) => [v, i]));
  const group = new Int16Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    const x = positions[3 * j], y = positions[3 * j + 1], zz = positions[3 * j + 2];
    if (x === 0 && y === 0 && zz === 0) continue;
    group[j] = index.get(zz) ?? -1;
  }
  return { z, group };
}

// ---------------------------------------------------------------------------------------------
// Drawing

/** Endpoints of a target: a tree plus their world positions now. */
export interface ArcEndpoints extends ArcTree {
  positions(out: THREE.Vector3[]): void;
}

/** What an effect is put on. */
export interface ArcTarget {
  /** The target's bones (p2 = 0). */
  bones?: ArcEndpoints;
  /** The target and the objects it links to (p2 = 1). */
  links?: ArcEndpoints;
  /** Start endpoint (the hit bone); default bone 1 / the target. */
  start?: number;
  /** Arcs are drawn while this holds (the target is shown). */
  visible(): boolean;
  /** The effect ends when this fails (the target is gone). */
  alive(): boolean;
  label?: string;
}

export interface ArcHandle {
  readonly alive: boolean;
  stop(): void;
}

export interface ElectricArcsEnv {
  pkgs: EntityPackageSet;
  dyn: { spawnModel(model: ResRef, base: THREE.Matrix4, opts?: { collides?: boolean; name?: string }): DynamicObject | undefined; remove(uid: number): void };
  /** Texture of a template ref (world fx cache). */
  texture(r: ResRef): THREE.Texture | null;
  camera: THREE.Camera;
  group: THREE.Group;
  log?(msg: string): void;
}

interface ArcView {
  d: DynamicObject;
  meshes: { attr: THREE.BufferAttribute; base: Float32Array; group: Int16Array }[];
  sections: number[];
  bow: Float32Array;
}

interface ArcLight {
  color: [number, number, number];
  strength: number;
  fx?: LightingEffectDef;
  loop: boolean;
  clock: number;
  /** Seconds left (the generator's run time), Infinity for none. */
  left: number;
  out: EnginePointLight;
  on: boolean;
}

interface Running {
  tpl: ArcEffectTemplate;
  sim: ArcEffectSim;
  ep: ArcEndpoints;
  P: THREE.Vector3[];
  target: ArcTarget;
  views: (ArcView | null)[];
  light?: ArcLight;
  stopped: boolean;
  label: string;
}

export class ElectricArcs {
  private running: Running[] = [];
  private readonly offLights: () => void;
  private readonly lightList: EnginePointLight[] = [];
  /** Effects started (tests / overlay). */
  started = 0;
  private readonly M = new THREE.Matrix4();
  private readonly S = new THREE.Vector3();
  private readonly E = new THREE.Vector3();
  private readonly X = new THREE.Vector3();
  private readonly Y = new THREE.Vector3();
  private readonly Z = new THREE.Vector3();

  constructor(private readonly env: ElectricArcsEnv, private readonly rnd: () => number = Math.random) {
    this.offLights = LEGACY_LIGHTING ? () => {} : engineLights.addProvider((out) => {
      for (const l of this.lightList) out.push(l);
    });
  }

  /** Put an Electric Arc Effect (or a bare Electric Arc) template on a target. */
  start(ref: ResRef, target: ArcTarget): ArcHandle | undefined {
    const tpl = readArcEffect(this.env.pkgs, ref) ?? this.bareArc(ref, target);
    if (!tpl) return undefined;
    return this.startWith(tpl, target, `${ref.pkg}:${ref.id}`);
  }

  /** A bare Electric Arc as an effect of one arc over the target for its longest life [port]. */
  private bareArc(ref: ResRef, target: ArcTarget): ArcEffectTemplate | undefined {
    const arc = readArcTemplate(this.env.pkgs, ref);
    if (!arc) return undefined;
    return { duration: arc.life[1], links: !target.bones, count: 1, arc, travel: false, loop: false, childrenOnly: false, damage: 0 };
  }

  startWith(tpl: ArcEffectTemplate, target: ArcTarget, label = 'arc'): ArcHandle | undefined {
    const ep = tpl.links ? target.links : target.bones;
    if (!ep || ep.count < 2 || !tpl.arc?.model) {
      this.env.log?.(`[fx] electric arc ${label}: no ${tpl.links ? 'linked objects' : 'skeleton'} on ${target.label ?? 'target'}`);
      return undefined;
    }
    const P = Array.from({ length: ep.count }, () => new THREE.Vector3());
    ep.positions(P);
    const sim = new ArcEffectSim(tpl, ep, P, target.start, this.rnd);
    if (sim.dead) return undefined;
    const r: Running = { tpl, sim, ep, P, target, views: sim.arcs.map(() => null), stopped: false, label: `${label}${target.label ? ' on ' + target.label : ''}` };
    r.light = this.lightOf(tpl);
    this.running.push(r);
    this.started++;
    return {
      get alive() {
        return !r.stopped && !r.sim.dead;
      },
      stop: () => {
        r.stopped = true;
      },
    };
  }

  /**
   * Bolts crackling between a point and a few random points around it for `seconds` (template-free
   * hits: Horace's shots, a spawned bare Electric Arc) [port: the original puts its Lightning's
   * p27 effect on the target hit, whose bones carry the arcs].
   */
  burst(at: THREE.Vector3Like, arc: ArcTemplate | ResRef | undefined, seconds: number, scale = 1) {
    const tpl = isRef(arc) ? readArcTemplate(this.env.pkgs, arc) : arc;
    if (!tpl?.model) return undefined;
    const n = 5;
    const pts = [new THREE.Vector3(at.x, at.y, at.z)];
    for (let i = 1; i < n; i++) {
      const d = new THREE.Vector3().randomDirection();
      d.y = Math.abs(d.y) * 0.6 + 0.1;
      pts.push(d.normalize().multiplyScalar((0.35 + this.rnd() * 0.65) * scale).add(pts[0]));
    }
    const parents = pts.map((_, i) => (i ? 0 : -1));
    const tree = treeFromParents(parents);
    const ep: ArcEndpoints = { ...tree, positions: (out) => pts.forEach((p, i) => out[i].copy(p)) };
    const arcT: ArcTemplate = { ...tpl, near: 0.2 * scale, far: 2 * scale, life: [0.05, 0.15] };
    const fx: ArcEffectTemplate = { duration: seconds, links: true, count: 2, arc: arcT, travel: false, loop: false, childrenOnly: false, damage: 0 };
    return this.startWith(fx, { links: ep, visible: () => true, alive: () => true, label: 'burst' }, 'burst');
  }

  /** The effect generator's Point Light (Object Generator p1 -> Point Light, its Lighting Effect). */
  private lightOf(tpl: ArcEffectTemplate): ArcLight | undefined {
    if (!tpl.generator || LEGACY_LIGHTING) return undefined;
    const g = templateValues(this.env.pkgs, tpl.generator, 'Object Generator');
    if (!g) return undefined;
    const refs = (Array.isArray(g.values[0]) ? g.values[0] : [g.values[0]]).filter(isRef);
    for (const r of refs) {
      const p = templateValues(this.env.pkgs, r, 'Point Light');
      if (!p) continue;
      const v = p.values;
      const c = engineColor(num(v[0])).multiplyScalar(num(v[1]) ? -1 : 1);
      const le = isRef(v[3]) ? templateValues(this.env.pkgs, v[3], 'Lighting Effect') : undefined;
      const def = le ? lightingEffectDef(le.values, this.env.pkgs as PackageSet) : undefined;
      const run = num(g.values[21]);
      return {
        color: [c.r, c.g, c.b],
        strength: Math.max(0, num(v[8], 1)),
        fx: def,
        loop: def?.loop ?? true,
        clock: 0,
        left: run > 0 ? run : Infinity,
        on: false,
        out: { x: 0, y: 0, z: 0, intensity: 0, r: c.r, g: c.g, b: c.b, hemi: num(v[9]) === 1 ? -1 : num(v[9]) === 2 ? 1 : 0 } as EnginePointLight,
      };
    }
    return undefined;
  }

  update(dt: number) {
    this.lightList.length = 0;
    for (let i = this.running.length - 1; i >= 0; i--) {
      const r = this.running[i];
      if (!r.stopped && !r.target.alive()) r.stopped = true;
      if (!r.stopped) {
        r.ep.positions(r.P);
        r.sim.step(dt, r.P);
      }
      if (r.stopped || r.sim.dead) {
        this.end(r);
        this.running.splice(i, 1);
        continue;
      }
      this.draw(r, dt);
    }
  }

  private draw(r: Running, dt: number) {
    const shown = r.target.visible();
    for (let i = 0; i < r.sim.arcs.length; i++) {
      let v = r.views[i];
      const w = shown ? r.sim.segment(i, r.P, this.S, this.E) : -1;
      if (w < 0) {
        if (v) v.d.root.visible = false;
        if (r.sim.arcs[i].gone && v) (this.drop(v), (r.views[i] = null));
        continue;
      }
      if (!v) v = r.views[i] = this.view(r.tpl.arc!);
      if (!v) continue;
      this.place(v, r.sim.arc, w);
    }
    const l = r.light;
    if (l) {
      l.left -= dt;
      l.clock += dt * 2;
      const at = r.P[r.sim.start];
      if (shown && l.left > 0 && at) {
        const k = l.fx?.power ? lightingEffectK(l.fx.power, l.loop, l.clock) : undefined;
        const s = l.fx?.power ? (k === undefined ? l.strength : l.fx.power.a + (l.fx.power.b - l.fx.power.a) * k) : l.strength;
        const ck = l.fx?.color ? lightingEffectK(l.fx.color, l.loop, l.clock) : undefined;
        if (l.fx?.color && ck !== undefined) {
          const { a, b } = l.fx.color;
          l.out.r = a[0] + (b[0] - a[0]) * ck;
          l.out.g = a[1] + (b[1] - a[1]) * ck;
          l.out.b = a[2] + (b[2] - a[2]) * ck;
        }
        l.out.x = at.x;
        l.out.y = at.y;
        l.out.z = at.z;
        l.out.intensity = s;
        this.lightList.push(l.out);
      }
    }
  }

  /** Model placed S -> E, scaled (w, w, length), rolled about its axis; sections bowed. */
  private place(v: ArcView, arc: ArcTemplate, w: number) {
    const { S, E, X, Y, Z } = this;
    Z.subVectors(S, E);
    const L = Z.length();
    if (L > 1e-6) Z.multiplyScalar(1 / L);
    else Z.set(0, 0, 1);
    const ref = Math.abs(Z.y) < 0.99 ? X.set(0, 1, 0) : X.set(1, 0, 0);
    Y.crossVectors(ref, Z).normalize(); // provisional x
    X.crossVectors(Z, Y); // provisional y
    const roll = this.rnd() * Math.PI * 2, c = Math.cos(roll), s = Math.sin(roll);
    // x = Y c + X s, y = -Y s + X c (rolled basis)
    const xx = Y.x * c + X.x * s, xy = Y.y * c + X.y * s, xz = Y.z * c + X.z * s;
    const yx = -Y.x * s + X.x * c, yy = -Y.y * s + X.y * c, yz = -Y.z * s + X.z * c;
    const sz = L > 1e-6 ? L : 0.01;
    const m = this.M.elements;
    m[0] = xx * w; m[1] = xy * w; m[2] = xz * w; m[3] = 0;
    m[4] = yx * w; m[5] = yy * w; m[6] = yz * w; m[7] = 0;
    m[8] = Z.x * sz; m[9] = Z.y * sz; m[10] = Z.z * sz; m[11] = 0;
    m[12] = S.x; m[13] = S.y; m[14] = S.z; m[15] = 1;
    v.d.root.matrix.copy(this.M);
    v.d.root.matrixWorldNeedsUpdate = true;
    v.d.root.visible = true;
    // Bow (model units along y), new every frame.
    const n = v.sections.length;
    sectionBow(n, arc, sz, v.bow, this.rnd);
    for (const mesh of v.meshes) {
      const p = mesh.attr.array as Float32Array;
      for (let j = 0; j < mesh.group.length; j++) {
        const g = mesh.group[j];
        p[3 * j + 1] = mesh.base[3 * j + 1] + (g >= 0 ? v.bow[g] : 0);
      }
      mesh.attr.needsUpdate = true;
    }
  }

  private view(arc: ArcTemplate): ArcView | null {
    const d = this.env.dyn.spawnModel(arc.model!, new THREE.Matrix4(), { collides: false, name: 'electric-arc' });
    if (!d) return null;
    const meshes: ArcView['meshes'] = [];
    const all: number[] = [];
    d.pivot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const base = Float32Array.from(attr.array as Float32Array);
      for (const x of base) all.push(x);
      meshes.push({ attr, base, group: new Int16Array(0) });
    });
    const sec = modelSections(all);
    for (const m of meshes) {
      const g = modelSections(m.base).group;
      // Same z values across the meshes: map to the model's sections.
      for (let j = 0; j < g.length; j++) if (g[j] >= 0) g[j] = sec.z.indexOf(m.base[3 * j + 2]);
      m.group = g;
    }
    const n = sec.z.length;
    return { d, meshes, sections: sec.z, bow: new Float32Array(n) };
  }

  private drop(v: ArcView) {
    this.env.dyn.remove(v.d.uid);
  }

  private end(r: Running) {
    for (const v of r.views) if (v) this.drop(v);
    r.views.length = 0;
    r.stopped = true;
  }

  /** Running effects (tests / overlay): label, arcs with their ends and lives. */
  state() {
    return this.running.map((r) => ({
      label: r.label,
      left: r.sim.left,
      travel: r.tpl.travel,
      links: r.tpl.links,
      endpoints: r.ep.count,
      light: r.light ? { on: this.lightList.includes(r.light.out), intensity: r.light.out.intensity } : null,
      arcs: r.sim.arcs.map((x, i) => {
        const v = r.views[i];
        const e = v?.d.root.matrix.elements;
        return { a: x.a, b: x.b, c: x.c, t: +x.t.toFixed(3), gone: !!x.gone, shown: !!v?.d.root.visible, at: e ? [e[12], e[13], e[14]].map((q) => +q.toFixed(2)) : null, length: e ? +Math.hypot(e[8], e[9], e[10]).toFixed(3) : 0, width: e ? +Math.hypot(e[0], e[1], e[2]).toFixed(3) : 0 };
      }),
    }));
  }

  get count() {
    return this.running.length;
  }

  dispose() {
    for (const r of this.running) this.end(r);
    this.running = [];
    this.lightList.length = 0;
    this.offLights();
  }
}
