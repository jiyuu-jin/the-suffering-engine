// Projector Effect (class 0x04cb8be8, Special Effect): an object drawn as a film projection.
// Decoded from Suffering.rfl [verified unless marked]: init vt[4] 0x1008c080, update vt[8]
// 0x1008c4c0, beam vertex 0x1008b9e0, inputs (message map 0x10177958) p13 0x1008be30,
// p14 0x1008be90, p15 0x1008bf10, p16 0x1008b820. docs/game-logic.md §15.7.8.
//
// Properties: p0 the target object, p1 on at start, p2 / p3 flatten the target's normals on
// axis p3 (0 in every retail instance, not ported), p4 flicker %, p5 / p6 opacity % with all /
// none of the projectors standing, p7 strobe period (frames), p9 a bone of the target per
// projector, p10 the projector objects, p11 a bone of each projector (its lens), p12 a vertex of
// the target per projector, p13..p16 the inputs.
//
//   init      hides the effect's own object, keeps the target, counts the projectors that exist
//             (a missing one hides target bone p9[i]); p1 runs the p13 input.
//   p13 (On)  starts the effect's updates; the target no longer casts its projected shadow
//             (engine flag bit 24 cleared) and is skipped by the queries that test object +0xc
//             bit 0x10000000 [use of that bit inferred: object filters 0x425ed4 / 0x4259d4].
//   p16 (On)  enables it and arms the strobe counter with 1: the next update SHOWS the target
//             (vt +0x128, the Visibility Toggler's call). Nothing else shows it: 1b's Killjoy
//             (instance flags 0, hidden) appears when "Turn on Projector & Killjoy" (#80ba)
//             turns the effect on at 59.09 s of STOMP 12:247.
//   p14 (Off) stops the updates, restores the shadow, opacity 1, shows the target.
//   p15 (Off) hides the target and disables the effect. Off runs p14 then p15 (map order).
//   update    (enabled, updates on) strobe: while the counter runs the target is hidden; when
//             it reaches 0 the target is shown and the counter restarts at p7 (0 in retail, so
//             shown once). Then for every projector i: vertex p12[i] of the target goes to the
//             world position of bone p11[i] of projector p10[i] (in the target's frame, its
//             welded copies too), or, if that projector is gone, bone p9[i] is hidden and the
//             share f of standing projectors drops by 1 / count. Opacity (object +0xd0) =
//             clamp(p6 + (p5 - p6) x f + U(-1, 1) x p4, 0, 1) / 100 per update; f <= 0 deals
//             the target 10000 damage.
//
// Killjoy's model (10:90) carries five additive light cones (submesh 0, Advanced 10:781:
// 10:256 tinted 0x2d2d2d) whose tips are skeleton vertices 0..4 on bones 86..90; p12 (a
// permutation of 0..4 in every Killjoy projector) names those tips [inferred: p12 indexes the
// skeleton's vertex list; the five tips are exactly vertices 0..4]. Moving them to the lens
// stretches the cones from the projector onto him: the projector beam.
//
// Port: actor targets (Characters) and skinned prop targets (1a #8897 12:624, 1c #808d and the 5b
// figures 7:653..655: skinned Breakables / Switches drawn by levels/skinned-props.ts, whose one
// beam vertex p12 follows the lens), and their projectors (Animating Statics, decoration
// actors). The vertex is placed so that after skinning by its bone it lands on the lens; a
// missing projector's tip goes back to its bind position (the cone folds onto the body) instead
// of a hidden bone [port]. A prop target takes the 10000 damage through the world's damage
// service (props.ts breaks it: p18 generator, p21, destroyed).

import * as THREE from 'three/webgpu';
import type { Character } from '../../../app/character';
import type { Entity, PropValue } from '../../../formats/entities';
import type { Actor, ActorEnv } from '../actor';
import { num, nums, ref, type SpecialMove, type SpecialRuntime } from './runtime';

/** The decoded properties of a Projector Effect. */
export interface ProjectorParams {
  target: number;
  onAtStart: boolean;
  /** Percent. */
  flicker: number;
  high: number;
  low: number;
  /** Strobe period in updates (p7). */
  strobe: number;
  bones: number[];
  units: number[];
  lenses: number[];
  vertices: number[];
  /** Message values of the inputs p13..p16. */
  inputs: [number, number, number, number];
}

export function projectorParams(val: readonly PropValue[]): ProjectorParams {
  const t = val[0];
  return {
    target: num(Array.isArray(t) ? t[0] : t, 0),
    onAtStart: num(val[1], 0) !== 0,
    flicker: num(val[4], 0),
    high: num(val[5], 100),
    low: num(val[6], 0),
    strobe: Math.max(0, num(val[7], 0)),
    bones: nums(val[9]),
    units: nums(val[10]),
    lenses: nums(val[11]),
    vertices: nums(val[12]),
    inputs: [num(val[13], 1), num(val[14], 2), num(val[15], 2), num(val[16], 1)],
  };
}

/**
 * Opacity of the target (0x1008ca6d..0x1008cb3b): f = share of the projectors standing (clamped
 * to 0..1), r = uniform -1..1; percentages as in the template.
 */
export function projectorOpacity(p: Pick<ProjectorParams, 'flicker' | 'high' | 'low'>, f: number, r: number): number {
  const s = Math.min(1, Math.max(0, f));
  const o = (p.low + (p.high - p.low) * s + r * p.flicker) / 100;
  return Math.min(1, Math.max(0, o));
}

/** What an update or an input asks of the target. */
export interface ProjectorStep {
  /** Show (true) / hide (false) the target now. */
  show?: boolean;
  /** Opacity forced (Off: 1). */
  opacity?: number;
  /** The update ran on (vertices, opacity, damage are due). */
  run: boolean;
}

/**
 * The effect's own state machine: updates on / off (+0x26, the engine's update flags),
 * disabled (+0x22) and the strobe counter (+0xc).
 */
export class ProjectorState {
  updating = false;
  disabled = false;
  counter: number;

  constructor(readonly p: Pick<ProjectorParams, 'strobe' | 'inputs' | 'onAtStart'>) {
    this.counter = p.strobe;
    if (p.onAtStart) this.input(0);
  }

  /** A level message: every input whose value it is runs, in map order (p13, p14, p15, p16). */
  message(msg: number): ProjectorStep[] {
    const out: ProjectorStep[] = [];
    this.p.inputs.forEach((v, i) => {
      if (v === msg) out.push(this.input(i));
    });
    return out;
  }

  /** Input slot 0..3 = p13..p16. */
  input(slot: number): ProjectorStep {
    switch (slot) {
      case 0:
        this.updating = true;
        return { run: false };
      case 1:
        if (!this.updating) return { run: false };
        this.updating = false;
        return { show: true, opacity: 1, run: false };
      case 2:
        this.disabled = true;
        return { show: false, run: false };
      default:
        this.disabled = false;
        this.counter = 1;
        return { run: false };
    }
  }

  /** One update of the effect (0x1008c4c0 up to the strobe). */
  tick(): ProjectorStep {
    if (!this.updating || this.disabled) return { run: false };
    if (this.counter > 0) {
      this.counter--;
      if (this.counter !== 0) return { show: false, run: false };
      this.counter = this.p.strobe;
      return { show: true, run: true };
    }
    return { run: true };
  }
}

/**
 * Bind-space position for a skinned vertex so that, skinned by bone `b` alone (the cone tips
 * have weight 1), it lands on `world` (three.js attached skinning with an identity bind
 * matrix: world = boneWorld x boneInverse x v).
 */
export function skinnedVertexFor(world: THREE.Vector3, boneWorld: THREE.Matrix4, boneInverse: THREE.Matrix4, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(world).applyMatrix4(_m.multiplyMatrices(boneWorld, boneInverse).invert());
}
const _m = new THREE.Matrix4();

/** Animating Statics given hit points, per runtime (shared by every effect and the pass below). */
const breakables = new WeakMap<SpecialRuntime, Set<number>>();
const breakableSet = (rt: SpecialRuntime) => breakables.get(rt) ?? breakables.set(rt, new Set()).get(rt)!;

/** Install every Projector Effect of the level; returns the disposer. */
export function installProjectors(rt: SpecialRuntime): () => void {
  const offs: (() => void)[] = [];
  // Not only the projectors an effect lists: a skinned Animating Static whose breaking the level
  // logic listens to (outOnBroken p21 set) is broken the same way. 5b's three projectors 2c4e /
  // 2c4f / 2c50 belong to no effect's p10 (Relays 2dad / 2daf / 2db0 take their invulnerability
  // off; their p21 Off counts Count Down 12ab down, which unlocks the doors 12ac / 12ad of
  // Killjoy's theatre); as plain decorations nothing could hit them and the theatre stayed shut.
  let swept = false;
  rt.tickers.push(() => {
    if (swept || !rt.world?.subscribe) return;
    swept = true;
    const done = breakableSet(rt);
    for (const e of rt.entities) if (e.className === 'Animating Static' && num(e.values[21], 0) !== 0 && num(e.values[0], 0) > 0 && !done.has(e.uid)) makeBreakable(rt, e.uid, done);
  });
  for (const e of rt.entities) if (e.className === 'Projector Effect') offs.push(projector(rt, e));
  return () => offs.forEach((f) => f());
}

/**
 * A projector is a placed skinned Animating Static (15 HP): the port draws it as a decoration
 * actor, which nothing can hit. Give it the PhysicalObject rules it has in the original: hit
 * points (p0), inputs p11 BlowUp / p13 / p14 invulnerability on / off, and when it breaks its
 * p18 generator and output p21 (Died) to its links (5b: Relay #164c). The same for every
 * Animating Static whose break the level listens to (installProjectors).
 */
function makeBreakable(rt: SpecialRuntime, uid: number, done: Set<number>) {
  const a = rt.manager.get(uid);
  const e = rt.byUid.get(uid);
  if (!a || !e || !rt.world?.subscribe) return;
  done.add(uid);
  const v = e.values;
  if (a.kind.decor) (a as unknown as { kind: Actor['kind'] }).kind = { ...a.kind, decor: false, hostile: false, attacks: [] };
  a.hostile = false;
  a.profile = { team: 'projector' };
  const move: SpecialMove = {
    name: 'projector',
    update: () => true,
    died: () => {
      rt.effect(ref(v[18]), a.position);
      const msg = num(v[21], 0);
      if (msg) for (const l of e.links) rt.send(l, msg, uid);
      a.ch.root.visible = false;
      rt.log(a, `projector #${uid.toString(16)} breaks`);
      return true;
    },
    info: () => ({ projector: a.alive ? Math.round(a.health) : 'broken' }),
  };
  a.special = (dt, env) => move.update(dt, env);
  rt.moves.set(a, move);
  rt.world.subscribe(uid, (msg) => {
    if (!a.alive) return;
    if (msg === num(v[13], 90)) a.invulnerable = true;
    else if (msg === num(v[14], 91)) a.invulnerable = false;
    else if (msg === num(v[11], 11)) rt.hurtActor(a, 1e6, uid);
  });
}

/** A projected figure: an actor's Character, or a skinned prop's. */
interface ProjectedTarget {
  ch: Character;
  alive: boolean;
  actor?: Actor;
}

interface PropDamage {
  apply(e: { point: { x: number; y: number; z: number }; amount: number; targetUid: number; source: number }): { hits?: unknown[] } | undefined;
}

interface WorldVisibility {
  world?: { setVisible?(uid: number, visible: boolean): void };
}

/** Debug / tests: the running effects (window.__specials.runtime.projectors). */
export interface ProjectorDebug {
  uid: number;
  target: number;
  state: ProjectorState;
  opacity?: number;
  share: number;
  /** World positions of the moved cone tips (last update). */
  tips: THREE.Vector3[];
}

function projector(rt: SpecialRuntime, e: Entity): () => void {
  const p = projectorParams(e.values);
  if (!p.target) return () => {};
  const st = new ProjectorState(p);
  const dbg: ProjectorDebug = { uid: e.uid, target: p.target, state: st, share: 1, tips: [] };
  ((rt as unknown as { projectors?: ProjectorDebug[] }).projectors ??= []).push(dbg);
  const breakable = breakableSet(rt);
  let hooked = false;
  let unsub: (() => void) | undefined;
  let killed = false;
  /** The target's own geometry / materials (actors of a kind share theirs). */
  let owned: { ch: Character; geometry: THREE.BufferGeometry; mats: THREE.Material[]; bind: Float32Array; tips: number[][] } | undefined;
  /** Projectors found when the effect started (the engine's count, +0x10). */
  let found = -1;
  const lens = new THREE.Vector3();
  const v = new THREE.Vector3();

  /** The target: an actor, or a skinned prop (levels/skinned-props.ts) with the world's health. */
  const target = (): ProjectedTarget | undefined => {
    const a = rt.manager.get(p.target);
    if (a) return { ch: a.ch, alive: a.alive, actor: a };
    const ch = (rt.ctx.services.skinnedProps as { character?(uid: number): Character | undefined } | undefined)?.character?.(p.target);
    return ch ? { ch, alive: !rt.world?.isDestroyed?.(p.target) } : undefined;
  };
  const gone = (u: number) => !!rt.world?.isDestroyed?.(u) || (rt.manager.get(u) ? !rt.manager.get(u)!.alive : !rt.byUid.has(u));
  const setVisible = (show: boolean) => {
    const w = (rt.world as WorldVisibility | undefined)?.world;
    if (w?.setVisible) w.setVisible(p.target, show);
    else {
      const t = target();
      if (t) t.ch.root.visible = show;
    }
  };
  const own = (ch: Character) => {
    if (owned?.ch === ch) return owned;
    const mesh = ch.mesh;
    const geometry = mesh.geometry.clone();
    mesh.geometry = geometry;
    const m = mesh.material;
    const mats = (Array.isArray(m) ? m : [m]).map((x) => x.clone());
    mesh.material = mats.length === 1 ? mats[0] : mats;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    // Render vertices of each skeleton vertex p12[i] (the welded copies the engine updates too).
    const source = ch.skinned.model.source;
    const tips = p.vertices.map((sv) => {
      const out: number[] = [];
      for (let c = 0; c < source.length && c < pos.count; c++) if (source[c] === sv) out.push(c);
      return out;
    });
    owned = { ch, geometry, mats, bind: (pos.array as Float32Array).slice(), tips };
    return owned;
  };
  const applyOpacity = (o: { mats: THREE.Material[] }, op: number) => {
    for (const m of o.mats) {
      // Blended passes already blend; an opaque pass starts blending (the engine's translucent
      // object path, 0x48fab0 with the object's opacity), its depth write off.
      if (op < 1 && !m.transparent) {
        m.transparent = true;
        m.depthWrite = false;
        m.needsUpdate = true;
      }
      m.opacity = op;
    }
  };
  const step = (s: ProjectorStep) => {
    if (s.show !== undefined) setVisible(s.show);
    const t = target();
    if (s.opacity !== undefined && t) applyOpacity(own(t.ch), s.opacity);
    // On: no projected shadow (flag bit 24); Off (p14) gives it back.
    if (t) t.ch.root.userData.noShadow = st.updating;
  };

  /** Cone tip i at the lens of projector i (true), or back at its bind position. */
  const placeTip = (o: NonNullable<typeof owned>, i: number, unit: Actor | undefined) => {
    const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute;
    const verts = o.tips[i];
    if (!verts?.length) return;
    const ch = o.ch;
    if (unit) {
      const bones = unit.ch.skeleton.bones;
      const b = bones[p.lenses[i] ?? -1];
      if (b) b.getWorldPosition(lens);
      else unit.ch.root.getWorldPosition(lens);
      if (!dbg.tips[i]) dbg.tips[i] = new THREE.Vector3();
      dbg.tips[i].copy(lens);
    }
    const skin = ch.mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    for (const c of verts) {
      if (unit) {
        const bi = skin.getX(c);
        const bone = ch.skeleton.bones[bi];
        if (!bone) continue;
        skinnedVertexFor(lens, bone.matrixWorld, ch.skeleton.boneInverses[bi], v);
        pos.setXYZ(c, v.x, v.y, v.z);
      } else pos.setXYZ(c, o.bind[3 * c], o.bind[3 * c + 1], o.bind[3 * c + 2]);
    }
    pos.needsUpdate = true;
  };

  rt.tickers.push((_dt: number, _env: ActorEnv) => {
    // The world system starts after the actors: listen once it is up.
    if (!hooked && rt.world?.subscribe) {
      hooked = true;
      unsub = rt.world.subscribe(e.uid, (msg) => {
        for (const s of st.message(msg)) step(s);
      });
    }
    for (const u of p.units) if (!breakable.has(u) && u !== p.target) makeBreakable(rt, u, breakable);
    const t = target();
    if (!t || killed) return;
    const s = st.tick();
    if (s.show !== undefined) setVisible(s.show);
    if (!s.run) return;
    const o = own(t.ch);
    t.ch.root.userData.noShadow = true;
    if (found < 0) found = p.units.filter((u) => !gone(u)).length;
    let f = 1;
    p.vertices.forEach((_, i) => {
      const u = p.units[i];
      const missing = u === undefined || gone(u);
      if (missing && found > 0) f -= 1 / found;
      placeTip(o, i, missing ? undefined : rt.manager.get(u));
    });
    dbg.share = f = Math.min(1, Math.max(0, f));
    const op = projectorOpacity(p, f, Math.random() * 2 - 1);
    dbg.opacity = op;
    applyOpacity(o, op);
    if (f <= 0 && t.alive) {
      killed = true;
      if (t.actor) {
        rt.log(t.actor, 'projectors destroyed: 10000 damage');
        rt.hurtActor(t.actor, 10000, e.uid);
      } else {
        const at = t.ch.root.getWorldPosition(new THREE.Vector3());
        const r = (rt.ctx.services.damage as PropDamage | undefined)?.apply({ point: { x: at.x, y: at.y, z: at.z }, amount: 10000, targetUid: p.target, source: e.uid });
        // A target the world keeps no health for (a skinned Switch: 1c #808d, 5b) dies the same
        // way: its GameObject p12 Destroy input [inferred: 10000 exceeds every retail p0].
        if (!r?.hits?.length) rt.send(p.target, num(rt.byUid.get(p.target)?.values[12], 12), e.uid);
      }
    }
  });

  return () => {
    unsub?.();
    if (owned) {
      owned.geometry.dispose();
      for (const m of owned.mats) m.dispose();
    }
  };
}
