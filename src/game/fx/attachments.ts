// Attachment sets of Animating Statics (SpawnAttachments) and the bookkeeping shared with other
// attached effects (rebirth.ts). docs/re/object-model.md §7.
//
// An Animating Static owns an attachment set (RFL object +0x6e, built by its constructor through
// 0x10095d10) over the property pairs p49 / p50 (hardpoint indices / templates, spawned) and
// p51 / p52 (hardpoint indices / placed objects, linked) [verified]:
//
//   - fixed message 154 SpawnAttachments and input slot p45 run the same handler (0x10093290):
//     spawn every p50[i] at hardpoint p49[i] of the object's model (0x10096220 -> 0x10095e80);
//     a pair is skipped when the index is -1, beyond the model's hardpoint table, or the
//     hardpoint already holds an attachment;
//   - input slot p46 (0x100932b0 -> 0x10096ba0) destroys every attachment of the set;
//   - p53 set: the set is also spawned (p49 / p50) and linked (p51 / p52) when the object is
//     created (0x10096400, flag 0x4).
//
// The same set code (0x10095d10 / 0x10096400 / 0x10096220 / 0x10095e80) serves the Characters:
// their constructor (0x100e52c6) builds it over p51 / p52 (hand weapons, spawned when p53 is set)
// and p54 / p55 (body parts, when p56 is set), plus p57 / p58; the Animating Static constructor
// (0x10093419) over p49 / p50 (spawned) and p51 / p52 (linked), both when p53 is set [verified].
// An entry spawns its template whatever its class, attached to the bone.
//
// Port, one set mechanism split by what an entry is (attachmentPairs + WORN_CLASSES, shared
// with weapons/npc.ts):
//   - entries that are worn models (WORN_CLASSES: the caged CartWheelers' Slayer heads 10:965,
//     dead guards' caps and guns) are built by weapons/npc.ts on the carrier's bone, for the
//     Characters' p51 / p52 / p54 / p55 and the Animating Statics' p49 / p50 alike; this class
//     only records them so a later 154 does not stack a copy;
//   - Point Lights become attached lights fed to the engine lighting rig at the bone (`lights`),
//     retail: the 1b..9 lamps (7:357 / 7:526 / 7:347 on bone 7), whose p45 On / p46 Off
//     messages spawn / remove them;
//   - anything else spawns through the world FX runtime at a matrix that follows the bone every
//     frame; generators that keep running (mode 1) are owned by the attachment and stopped when
//     it goes (p46, or the carrier is destroyed / broken).
// Creation sets (p53) are spawned once the carrier's bone resolves (the actors system's
// decoration actors give it). Not ported: p51 / p52 links (retail: hanged NPC bodies on rope
// models 7:308 / 7:661 in 1b / 2 / 3b / 4a / 4b), worn models spawned by a later 154 / p45 (no
// retail case) and the Point Lights' Lighting Effect flicker (no retail attached light has one).
//
// Characters' body-part sets (p54 bones / p55 templates; docs/game-logic.md §15.7.12) [verified,
// Character message handler 0x100e3ab0]: message 154 SpawnAttachments spawns every pair
// (0x10096710 -> 0x10096220), clip event 151 SpawnItem at bone b the first pair whose index is b
// (0x10096c00 -> 0x10096870; the hand-weapon pair p51 / p52 is tried first, 0x10096be0), 152
// DestroyItem destroys what is attached at bone b (0x10096b80 -> 0x10096ab0, vt +0x30). A hidden
// Character hides its set (0x100e1a6c -> 0x10095260). Port: `spawnParts` / `removeAt`, effect
// entries only (CHARACTER_EFFECT_CLASSES; worn ones stay with weapons/npc.ts), Particle Fountains
// spawned by an attached generator are owned (they emit until removed and, through the
// generator's Follower Object p25, follow the bone), and a hidden carrier's fountains pause.

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { Emitter, Fx, Generator } from '../world/fx';
import type { World, WorldEntity } from '../world/logic';

/** Fixed message of the Animating Static map (0x10177d20). */
export const SPAWN_ATTACHMENTS = 154;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** List property as a positional array (null entries kept so pairs stay aligned). */
const list = (v: PropValue | undefined): PropValue[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);

/** Hardpoint / template pairs of an attachment set (p49 / p50), in order, invalid ones dropped. */
export function attachmentPairs(values: PropValue[], hpProp = 49, tplProp = 50): { hp: number; ref: ResRef }[] {
  const hps = list(values[hpProp]);
  const tpls = list(values[tplProp]);
  const out: { hp: number; ref: ResRef }[] = [];
  for (let i = 0; i < Math.min(hps.length, tpls.length); i++) {
    const hp = num(hps[i], -1);
    const r = tpls[i];
    if (hp >= 0 && isRef(r)) out.push({ hp, ref: r });
  }
  return out;
}

/** First body-part pair of a Character on `bone` (p54 / p55; 0x10096870 takes the first match). */
export function bodyPartAt(values: PropValue[], bone: number): { hp: number; ref: ResRef } | undefined {
  return attachmentPairs(values, 54, 55).find((p) => p.hp === bone);
}

/**
 * Body-part classes a Character's set spawns here as effects [port scope]. Worn models
 * (WORN_CLASSES) are weapons/npc.ts's; projectiles (BouncingObject, Missile) and Breakables in
 * p55 belong to the specials that throw or break them.
 */
export const CHARACTER_EFFECT_CLASSES: ReadonlySet<string> = new Set(['Object Generator', 'Particle Fountain']);

/**
 * Spawn through the world FX runtime and return the generators that keep running (mode 1).
 * `owner`: Particle Fountains spawned on the way are collected there and kept emitting (and
 * following M when their generator has a Follower Object) until stopEmitters.
 */
export function spawnOwned(wfx: Pick<Fx, 'spawn' | 'generators'>, ref: ResRef, M: THREE.Matrix4, owner?: Emitter[]): Generator[] {
  const before = wfx.generators.length;
  wfx.spawn(ref, M, owner ? { owner } : undefined);
  return wfx.generators.slice(before);
}

/** Stop owned fountains: no new particles; the runtime drops them once the live ones died. */
export function stopEmitters(ems: Emitter[]) {
  for (const em of ems) {
    em.stop();
    em.oneShot = true;
  }
  ems.length = 0;
}

/** Stop owned generators and drop them from the runtime's list. */
export function killOwned(wfx: Pick<Fx, 'generators'>, gens: Generator[]) {
  for (const g of gens) {
    g.stop();
    g.dead = true;
    const i = wfx.generators.indexOf(g);
    if (i >= 0) wfx.generators.splice(i, 1);
  }
  gens.length = 0;
}

/** Matrices that spawned effects should keep following (fires spawned by an attached generator). */
export const followMatrices = new WeakSet<THREE.Matrix4>();

/**
 * Classes spawned as models worn on the carrier's bone (weapons/npc.ts builds them). Not
 * Breakable: the Character "Slayer" 10:527's 10:144 (a 5-unit trunk on bone 59) and the 2
 * Cellblocks body 10:978's 7:150 stay unworn [unverified purpose].
 */
export const WORN_CLASSES: ReadonlySet<string> = new Set(['TargetableBreakable', 'Attachment', 'Ranged Weapon', 'Melee Weapon']);

/** An attached Point Light: engine colour (bytes / 255, negative light < 0), strength p8, hemisphere. */
export interface AttachedLightDef {
  r: number;
  g: number;
  b: number;
  /** Strength I = p8 (m²): level min(I / d², 2) (render-data.ts pointLightLevel). */
  intensity: number;
  hemi: number;
}

export interface AttachmentsEnv {
  wfx: Pick<Fx, 'spawn' | 'generators'>;
  /** Template class of a ref. */
  classOf(ref: ResRef): string | undefined;
  /** A Point Light template's light (none: Point Lights are skipped). */
  light?(ref: ResRef): AttachedLightDef | undefined;
  /**
   * World matrix of hardpoint `hp` of the object `uid` into `out`; false when the object has no
   * such hardpoint (no skinned carrier, or the index is beyond its table).
   */
  hardpoint(uid: number, hp: number, out: THREE.Matrix4): boolean;
  /** The carrier is gone (destroyed, broken / dead): its attachments go with it. */
  gone(uid: number): boolean;
  /** The carrier is shown (default true); a hidden one's owned fountains pause. */
  shown?(uid: number): boolean;
  log?(m: string): void;
}

interface Attached {
  hp: number;
  ref: ResRef;
  M: THREE.Matrix4;
  gens: Generator[];
  /** Particle Fountains spawned by it, emitting until it goes (body-part sets). */
  emitters?: Emitter[];
  /** Its fountains are paused while the carrier is hidden. */
  paused?: boolean;
  /** A Point Light fed to the lighting rig. */
  light?: AttachedLightDef;
  /** A model worn through weapons/npc.ts (recorded only). */
  worn?: boolean;
}

/** Give up on a creation set whose carrier bone never resolves (s). */
const PENDING_TIMEOUT = 15;

export class Attachments {
  private readonly sets = new Map<number, Attached[]>();
  /** Creation sets (p53) waiting for their carrier's bones: uid -> values, seconds waited. */
  private readonly pending = new Map<number, { values: PropValue[]; t: number }>();
  /** Spawn / removal events for tests and the debug overlay. */
  readonly events: { uid: number; what: 'spawn' | 'remove' | 'create'; count: number }[] = [];

  constructor(private readonly env: AttachmentsEnv) {}

  /** Level-logic hook (World.handlers): 154 / p45 spawn, p46 removes. */
  readonly handler = (w: WorldEntity, msg: number): boolean => {
    if (w.cls !== 'Animating Static' || w.destroyed) return false;
    const v = w.e.values;
    let handled = false;
    if (msg === SPAWN_ATTACHMENTS || (num(v[45]) !== 0 && num(v[45]) === msg)) {
      this.spawn(w.uid, v);
      handled = true;
    }
    if (num(v[46]) !== 0 && num(v[46]) === msg) {
      this.remove(w.uid);
      handled = true;
    }
    return handled;
  };

  install(world: Pick<World, 'handlers'> & { of?(cls: string): readonly WorldEntity[] }) {
    world.handlers.push(this.handler);
    // p53: the set is spawned with the object (0x10096400, flag 0x4).
    for (const w of world.of?.('Animating Static') ?? []) if (!w.destroyed && num(w.e.values[53]) !== 0) this.create(w.uid, w.e.values);
  }

  /** A creation set (p53): spawned once the carrier's bones resolve (update()). */
  create(uid: number, values: PropValue[]) {
    if (attachmentPairs(values).length) this.pending.set(uid, { values, t: 0 });
  }

  private note(uid: number, what: 'spawn' | 'remove' | 'create', count: number) {
    this.events.push({ uid, what, count });
    if (this.events.length > 50) this.events.shift();
  }

  /**
   * SpawnAttachments: every free, valid (p49[i], p50[i]) pair. Returns the number spawned.
   * `creation`: the p53 set at creation, whose worn models weapons/npc.ts builds.
   */
  spawn(uid: number, values: PropValue[], creation = false): number {
    const set = this.sets.get(uid) ?? [];
    let n = 0;
    for (const { hp, ref } of attachmentPairs(values)) {
      if (set.some((a) => a.hp === hp)) continue;
      const M = new THREE.Matrix4();
      if (!this.env.hardpoint(uid, hp, M)) continue;
      const cls = this.env.classOf(ref);
      if (cls && WORN_CLASSES.has(cls)) {
        if (!creation) continue; // (no retail set spawns a worn model by message)
        set.push({ hp, ref, M, gens: [], worn: true });
      } else if (cls === 'Point Light') {
        const light = this.env.light?.(ref);
        if (!light) continue;
        set.push({ hp, ref, M, gens: [], light });
      } else {
        followMatrices.add(M);
        set.push({ hp, ref, M, gens: spawnOwned(this.env.wfx, ref, M) });
      }
      n++;
    }
    if (set.length) this.sets.set(uid, set);
    this.note(uid, creation ? 'create' : 'spawn', n);
    if (n) this.env.log?.(`[fx] attachments #${uid.toString(16)}: ${n} ${creation ? 'created' : 'spawned'}`);
    return n;
  }

  /**
   * A Character's body parts (p54 / p55): every effect pair (message 154 SpawnAttachments), or
   * with `bone` the first pair on that bone (clip event 151 SpawnItem). A bone that already holds
   * an attachment of the set is skipped. Returns the number spawned.
   */
  spawnParts(uid: number, values: PropValue[], bone?: number): number {
    const pairs = bone === undefined ? attachmentPairs(values, 54, 55) : [bodyPartAt(values, bone)].filter((p) => !!p);
    const set = this.sets.get(uid) ?? [];
    let n = 0;
    for (const { hp, ref } of pairs) {
      if (set.some((a) => a.hp === hp)) continue;
      const cls = this.env.classOf(ref);
      if (!cls || !CHARACTER_EFFECT_CLASSES.has(cls)) continue;
      const M = new THREE.Matrix4();
      if (!this.env.hardpoint(uid, hp, M)) continue;
      followMatrices.add(M);
      const emitters: Emitter[] = [];
      set.push({ hp, ref, M, gens: spawnOwned(this.env.wfx, ref, M, emitters), emitters });
      n++;
    }
    if (set.length) this.sets.set(uid, set);
    this.note(uid, 'spawn', n);
    if (n) this.env.log?.(`[fx] body parts #${uid.toString(16)}: ${n} spawned${bone === undefined ? '' : ` on bone ${bone}`}`);
    return n;
  }

  /** Clip event 152 DestroyItem: destroy what the set holds on `bone`. Returns the number removed. */
  removeAt(uid: number, bone: number): number {
    const set = this.sets.get(uid);
    if (!set) return 0;
    const gone = set.filter((a) => a.hp === bone && !a.worn);
    if (!gone.length) return 0;
    for (const a of gone) this.kill(a);
    const left = set.filter((a) => !gone.includes(a));
    if (left.length) this.sets.set(uid, left);
    else this.sets.delete(uid);
    this.note(uid, 'remove', gone.length);
    return gone.length;
  }

  private kill(a: Attached) {
    killOwned(this.env.wfx, a.gens);
    if (a.emitters) stopEmitters(a.emitters);
  }

  /** Attached Point Lights that are live, for the engine lighting rig (EngineLightRig provider). */
  lightsOut(out: { x: number; y: number; z: number; intensity: number; r: number; g: number; b: number; hemi: number }[]) {
    for (const set of this.sets.values()) {
      for (const a of set) {
        const l = a.light;
        if (!l) continue;
        const e = a.M.elements;
        out.push({ x: e[12], y: e[13], z: e[14], intensity: l.intensity, r: l.r, g: l.g, b: l.b, hemi: l.hemi });
      }
    }
  }

  /** Number of attached lights (tests / overlay). */
  get lightCount() {
    let n = 0;
    for (const set of this.sets.values()) for (const a of set) if (a.light) n++;
    return n;
  }

  /** Destroy every attachment of an object (p46, or the carrier went away). */
  remove(uid: number) {
    const set = this.sets.get(uid);
    this.sets.delete(uid);
    for (const a of set ?? []) this.kill(a);
    this.note(uid, 'remove', set?.length ?? 0);
  }

  /** Attachments currently held, by carrier uid (tests / overlay). */
  held(uid: number): { hp: number; ref: ResRef; generators: number; emitters: number; light: boolean; worn: boolean }[] {
    return (this.sets.get(uid) ?? []).map((a) => ({ hp: a.hp, ref: a.ref, generators: a.gens.length, emitters: a.emitters?.length ?? 0, light: !!a.light, worn: !!a.worn }));
  }

  /** Creation sets still waiting for their carrier (tests / overlay). */
  get pendingCount() {
    return this.pending.size;
  }

  /** Follow the carriers' bones; drop the sets of carriers that are gone. */
  update(dt = 0) {
    for (const [uid, p] of [...this.pending]) {
      p.t += dt;
      const M = new THREE.Matrix4();
      if (attachmentPairs(p.values).some((x) => this.env.hardpoint(uid, x.hp, M))) {
        this.pending.delete(uid);
        this.spawn(uid, p.values, true);
      } else if (p.t > PENDING_TIMEOUT) {
        this.pending.delete(uid);
        this.env.log?.(`[fx] attachments #${uid.toString(16)}: carrier bones never resolved`);
      }
    }
    for (const [uid, set] of [...this.sets]) {
      if (this.env.gone(uid)) {
        this.remove(uid);
        continue;
      }
      const shown = this.env.shown?.(uid) ?? true;
      for (const a of set) {
        this.env.hardpoint(uid, a.hp, a.M);
        if (!a.emitters?.length || a.paused === !shown) continue;
        a.paused = !shown;
        for (const em of a.emitters) shown ? em.start() : em.stop();
      }
    }
  }

  dispose() {
    this.pending.clear();
    for (const uid of [...this.sets.keys()]) this.remove(uid);
  }
}
