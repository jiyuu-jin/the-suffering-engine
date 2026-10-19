// Dismemberment: the Character's Part Caps (docs/game-logic.md §15.16). Decoded from
// Suffering.rfl [verified unless marked]:
//
//   Part Cap (class 0x627acba2, template-only): p0 cap model (a 2-bone skinned stump), p1 the
//   bone it caps, p2 bleed (damage per second added to the body), p3 grows back with Killjoy's
//   resurrection (0x100eda49 -> 0x101189e0, not modelled), p4 / p5 the corpse rule's delay and
//   reputation, p6 smallest blow, p7..p9 chance (%) from p7 to p9 as the blow grows to p8, p10
//   most health (% of the maximum) the body may have, p11 weight of the health term, p12 what
//   happens to a weapon held on the capped bone (1 / 2), p13 / p14 damage-type rule, p15 attack
//   templates the cut needs, p16 stump spurt generator, p17 severed-part generator.
//
//   Character p16 lists its Part Caps, p17 the parts already cut when it is created (when its
//   p18 is 0: 0x100e1fb3 -> 0x10119690 -> 0x10118fc0), so placed corpses lie headless or
//   armless. The component lives at Character +0x536 (Player +0x448): +0 the bleed rate, +4
//   flags (2: a cut was the player's), +8 the owner.
//
//   The blow (0x10119150, from the Character damage 0x100e76e1 after the health change and the
//   kill reputation, for every blow alive or dead, unless the character's flags +0x6c & 0x100 /
//   +0x70 & 0x80 forbid it):
//     - the struck hit sphere's bone (record +0x20 -> 0x10085e50) gives its channel; the first
//       p16 cap whose p1 is the channel's bone is the candidate (0x10119270 loop); the channel
//       must not be cut already (node flag 0x10, 0x1008b8e0);
//     - amount > 0 and >= p6; health / max x 100 <= p10;
//     - p13 XOR (damage type listed in p14) must be 1: p13 = 1 lists the types that cannot cut
//       (bullets 1, axe 2, fire 5, shiv 10, 12 on the torso / pelvis caps), p13 = 0 the only
//       ones that can (none listed: never);
//     - p15 listed: the attacker's current attack template must be one of them;
//     - chance (%) = (p7 + (p9 - p7) x min(amount / p8, 1)) x (p11 + (100 - p11) x (p10 -
//       health) / p10) / 100 against rand() / 32767 x 100 (retail p11 = 100: the health term is 1).
//   The cut (0x10118dd0): weapons on capped bones of the subtree are dropped (p12 1) or removed
//   (p12 2, or the bone was cut before) (0x10118790 -> 0x100e4dd0); bleed += p2; the Part Cap
//   object is created at the hit bone's matrix and attached to the bone (world vt +4, character
//   vt +0x18); the animator sets node flag 0x10 on the bone (request 0x100010, SUFFERING.EXE
//   0x470bc6). Then, when the attacker is the player: flag 2, and on a body dead for more than
//   p4 s (0x100a1f20: now - death time) reputation += p5 (0x1011961f).
//   The bleed (update 0x10118680): while the body lives, bleed x frame time through its damage
//   virtual, attacker the player when flag 2 is set (so the kill is the player's), else itself.
//   The Action Dialog count skips a player's hit while the body bleeds (0x10040d10).
//
// Port [inferred unless marked]: the hit point picks the nearest posed leaf hit sphere; a bone's
// channel is the nearest bone up the tree (itself first) in the model's channel table; the cut
// hides the cut bone's descendants (their bones scaled to nothing: the caps are modelled from
// the cut bone outwards, 0.1..0.25 m along the arm, 0.04..0.1 m up the neck, so the bone itself
// stays) and whatever rides them (worn caps, guns); the cap model rides the cut bone; the p17
// generator is spawned at the cut bone, thrown away from the attacker; the p16 spurt follows the
// bone. Posed bodies (a DormantBehavior pose) do not bleed [port: their placed pose is kept].

import * as THREE from 'three/webgpu';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { partCapReputation } from '../insanity/reputation';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');
const ints = (v: PropValue | undefined): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const key = (r: ResRef) => `${r.pkg}:${r.id}`;

/** A Part Cap template's values (see the header). */
export interface PartCapRule {
  ref?: ResRef;
  bone: number;
  capModel?: ResRef;
  bleed: number;
  regrow: boolean;
  corpseDelay: number;
  reputation: number;
  minDamage: number;
  chanceMin: number;
  fullAt: number;
  chanceMax: number;
  healthPct: number;
  healthWeight: number;
  drop: number;
  /** p13: 1 = the p14 types cannot cut, 0 = only they can. */
  typeMode: number;
  types: number[];
  /** p15 attack templates ("pkg:id"); empty = any. */
  attacks: string[];
  spurt?: ResRef;
  part?: ResRef;
}

export function readPartCap(v: readonly PropValue[], r?: ResRef): PartCapRule {
  return {
    ref: r,
    capModel: ref(v[0]),
    bone: num(v[1], -1),
    bleed: num(v[2]),
    regrow: num(v[3]) !== 0,
    corpseDelay: num(v[4], 5),
    reputation: num(v[5]),
    minDamage: num(v[6]),
    chanceMin: num(v[7]),
    fullAt: num(v[8], 1),
    chanceMax: num(v[9]),
    healthPct: num(v[10], 100),
    healthWeight: num(v[11], 100),
    drop: num(v[12], 2),
    typeMode: num(v[13], 1),
    types: ints(v[14]),
    attacks: refs(v[15]).map(key),
    spurt: ref(v[16]),
    part: ref(v[17]),
  };
}

/** A Part Cap template by reference (anything else: undefined). */
export function readPartCapRef(pkgs: EntityPackageSet, r: ResRef): PartCapRule | undefined {
  const t = readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  return t && c?.name === 'Part Cap' ? readPartCap(decodeTemplateProps(c, t), r) : undefined;
}

/** Template references of a (list) property. */
export const refsOf = (v: unknown): ResRef[] => refs(v as PropValue);

/** A Character's values (placed: instance; spawned: its template); other classes: undefined. */
export function characterValues(pkgs: EntityPackageSet, a: { entity?: { values: PropValue[]; family?: string }; kind: { template: ResRef } }): PropValue[] | undefined {
  if (a.entity) return a.entity.family === 'Character' ? a.entity.values : undefined;
  const t = readObjectTemplate(pkgs, a.kind.template);
  const c = t && classByHash(t.classHash);
  return t && c && c.family === 'Character' ? decodeTemplateProps(c, t) : undefined;
}

/** What the blow carries that the rule reads. */
export interface PartBlow {
  amount: number;
  /** Damage type (record +0x40). */
  type?: number;
  /** The attacker's current attack template ("pkg:id"), for p15. */
  attack?: string;
}

/** The candidate cap of a struck channel: the first p16 entry whose p1 is its bone (0x10119270). */
export function capFor(rules: readonly PartCapRule[], channelBone: number): PartCapRule | undefined {
  return rules.find((r) => r.bone === channelBone);
}

/** The deterministic tests of 0x10119150 (everything but the roll). */
export function capAllows(r: PartCapRule, b: PartBlow, health: number, maxHealth: number): boolean {
  if (!(b.amount > 0) || b.amount < r.minDamage) return false;
  const pct = maxHealth > 0 ? (health / maxHealth) * 100 : 0;
  if (pct > r.healthPct) return false;
  const listed = r.types.length > 0 && b.type !== undefined && r.types.includes(b.type);
  if (((r.typeMode ? 1 : 0) ^ (listed ? 1 : 0)) === 0) return false;
  if (r.attacks.length && !(b.attack && r.attacks.includes(b.attack))) return false;
  return true;
}

/** Cut chance in percent (0x10119500..0x1011956c). */
export function cutChance(r: PartCapRule, amount: number, health: number): number {
  const k = r.fullAt > 0 ? Math.min(amount / r.fullAt, 1) : 1;
  const hp = r.healthPct !== 0 ? (r.healthPct - health) / r.healthPct : 0;
  return (r.chanceMin + (r.chanceMax - r.chanceMin) * k) * (r.healthWeight + (100 - r.healthWeight) * hp) * 0.01;
}

/** Does a roll (0..1, rand() / 32767) cut: roll x 100 below the chance. */
export function cutRoll(r: PartCapRule, amount: number, health: number, roll: number): boolean {
  return roll * 100 < cutChance(r, amount, health);
}

/** The channel of a bone: itself or the nearest ancestor in the channel table [inferred]; -1: none. */
export function channelOf(parents: readonly number[], channels: ReadonlySet<number>, bone: number): number {
  for (let b = bone, n = 0; b >= 0 && n < 256; b = parents[b] ?? -1, n++) if (channels.has(b)) return b;
  return -1;
}

/** Descendants of a bone (the bone itself excluded). */
export function descendantsOf(parents: readonly number[], bone: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < parents.length; i++) {
    for (let b = parents[i], n = 0; b >= 0 && n < 256; b = parents[b] ?? -1, n++)
      if (b === bone) {
        out.push(i);
        break;
      }
  }
  return out;
}

/** Corpse rule (0x10119617..0x1011965f): the player's cut on a body dead longer than p4 s pays p5. */
export function corpseCutReputation(r: PartCapRule, byPlayer: boolean, deadFor: number | undefined): number {
  if (!byPlayer || deadFor === undefined) return 0;
  return partCapReputation([null, null, null, null, r.corpseDelay, r.reputation], deadFor);
}

/** Point -> nearest sphere: smallest distance outside its surface (inside counts as 0 - depth). */
export function nearestSphere(spheres: readonly { c: readonly number[]; r: number }[], p: THREE.Vector3Like): number {
  let best = -1, bd = Infinity;
  spheres.forEach((s, i) => {
    const d = Math.hypot(s.c[0] - p.x, s.c[1] - p.y, s.c[2] - p.z) - s.r;
    if (d < bd) (bd = d), (best = i);
  });
  return best;
}

// ---------------------------------------------------------------------------
// Runtime

/** What the runtime needs from an actor. */
export interface PartActor {
  readonly ch: { skeleton: THREE.Skeleton; root: THREE.Object3D; mesh: THREE.Object3D; poseHooks: ((ch: never, dt: number) => void)[] };
  readonly alive: boolean;
  health: number;
  maxHealth: number;
  readonly uid?: number;
  readonly position: THREE.Vector3Like;
  readonly behavior?: { kind: string };
  brokenParts?: Set<number>;
  /** Parts left to cut (a dead body still takes blows: weapons / creature melee read it). */
  cuttable?: boolean;
}

interface PartState {
  rules: PartCapRule[];
  parents: number[];
  channels: Set<number>;
  /** Cut cap bones (node flag 0x10), in order. */
  cut: number[];
  /** +0x536: bleed (damage per second). */
  bleed: number;
  /** Flag 2: a cut was the player's. */
  byPlayer: boolean;
  /** Game time of death (undefined: alive, or dead before the runtime saw it: long dead). */
  diedAt?: number;
  /** Spurts following their bone: matrix updated in place until `until`. */
  follow: { bone: number; M: THREE.Matrix4; until: number }[];
  caps: THREE.Object3D[];
  hidden: Set<number>;
}

export interface PartDeps {
  time(): number;
  /** Spawn an effect template at a world matrix (services.fx.spawn). `owner` keeps fountains following M. */
  spawn(r: ResRef, M: THREE.Matrix4, opts?: { dir?: THREE.Vector3; owner?: unknown[] }): void;
  /** A cap model (skinned stump) to hang on the cut bone. */
  buildCap(r: ResRef): THREE.Object3D | undefined;
  /** Leaf hit spheres of the actor posed now (world space) with their bones. */
  spheres(a: PartActor): { c: number[]; r: number; bone: number }[];
  addReputation(points: number, uid?: number): void;
  log(msg: string): void;
  rand?(): number;
}

export interface PartsSave {
  /** [actor uid, cut bones, bleed, by player, seconds dead (-1 alive / unknown)]. */
  a: [number, number[], number, number, number][];
}

const TINY = 1e-4;

export class Dismemberment {
  private st = new Map<PartActor, PartState>();

  constructor(private readonly deps: PartDeps) {}

  /** Give an actor its Part Caps (Character p16) and model data; `precut`: p17 when p18 = 0. */
  setup(a: PartActor, rules: PartCapRule[], parents: number[], channels: number[], precut: PartCapRule[] = []) {
    if (!rules.length && !precut.length) return;
    const s: PartState = { rules, parents, channels: new Set(channels), cut: [], bleed: 0, byPlayer: false, follow: [], caps: [], hidden: new Set() };
    this.st.set(a, s);
    a.ch.poseHooks.push(() => this.applyHidden(s, a));
    // Created already cut (0x10119690 with flag 0: no spurt, no severed part); the bleed is added.
    for (const r of precut) this.cut(a, s, r, { effects: false, byPlayer: false });
    this.mark(a, s);
  }

  private mark(a: PartActor, s: PartState) {
    a.cuttable = s.rules.some((r) => !s.cut.includes(r.bone) && !s.hidden.has(r.bone));
  }

  /** Bodies a shot or a claw still strikes when dead (ActorManager.cuttable). */
  cuttable(a: PartActor): boolean {
    return !!a.cuttable;
  }

  has(a: PartActor): boolean {
    return (this.st.get(a)?.rules.length ?? 0) > 0;
  }

  /** The body bleeds (the Action Dialog does not count the player's hits meanwhile). */
  bleeding(a: PartActor): boolean {
    return (this.st.get(a)?.bleed ?? 0) > 0;
  }

  cutBones(a: PartActor): readonly number[] {
    return this.st.get(a)?.cut ?? [];
  }

  died(a: PartActor) {
    const s = this.st.get(a);
    if (s) s.diedAt = this.deps.time();
  }

  /**
   * A blow on the actor (after its health changed): 0x10119150. `point`: where it landed (no
   * point: no hit sphere, no cut); `from`: the attacker's position (the part flies away from it).
   */
  hit(a: PartActor, blow: PartBlow & { point?: THREE.Vector3Like; from?: THREE.Vector3Like; byPlayer: boolean }): PartCapRule | undefined {
    const s = this.st.get(a);
    if (!s?.rules.length || !blow.point) return undefined;
    const spheres = this.deps.spheres(a);
    const i = nearestSphere(spheres, blow.point);
    if (i < 0) return undefined;
    const ch = channelOf(s.parents, s.channels, spheres[i].bone);
    const r = ch >= 0 ? capFor(s.rules, ch) : undefined;
    if (!r || s.cut.includes(r.bone) || this.insideCut(s, r.bone)) return undefined;
    const health = a.alive ? a.health : Math.min(0, a.health);
    if (!capAllows(r, blow, health, a.maxHealth)) return undefined;
    if (!cutRoll(r, blow.amount, health, (this.deps.rand ?? Math.random)())) return undefined;
    const dir = blow.from ? new THREE.Vector3(blow.point.x - blow.from.x, 0, blow.point.z - blow.from.z) : undefined;
    if (dir && dir.lengthSq() > 1e-6) dir.normalize();
    this.cut(a, s, r, { effects: true, byPlayer: blow.byPlayer, dir: dir?.lengthSq() ? dir : undefined });
    return r;
  }

  /** A bone already hidden by an earlier cut higher up (its node is gone with the subtree). */
  private insideCut(s: PartState, bone: number): boolean {
    return s.hidden.has(bone);
  }

  private cut(a: PartActor, s: PartState, r: PartCapRule, o: { effects: boolean; byPlayer: boolean; dir?: THREE.Vector3 }) {
    const bones = a.ch.skeleton.bones;
    const b = bones[r.bone];
    if (!b || s.cut.includes(r.bone)) return;
    s.cut.push(r.bone);
    for (const d of descendantsOf(s.parents, r.bone)) s.hidden.add(d);
    // What rides the hidden bones goes with them (worn caps, guns: weapons/npc.ts brokenParts).
    a.brokenParts ??= new Set();
    for (const d of s.hidden) a.brokenParts.add(d);
    s.bleed += r.bleed;
    if (s.bleed === 0) s.byPlayer = false;
    if (r.capModel) {
      const cap = this.deps.buildCap(r.capModel);
      if (cap) {
        cap.name = `part-cap ${key(r.capModel)}`;
        b.add(cap);
        s.caps.push(cap);
      }
    }
    this.applyHidden(s, a);
    this.mark(a, s);
    let rep = 0;
    if (o.effects) {
      b.updateWorldMatrix(true, false);
      const M = b.matrixWorld.clone();
      if (r.part) this.deps.spawn(r.part, M, { dir: o.dir });
      if (r.spurt) {
        const F = M.clone();
        this.deps.spawn(r.spurt, F, { owner: [] });
        s.follow.push({ bone: r.bone, M: F, until: this.deps.time() + 20 });
      }
      if (o.byPlayer) {
        s.byPlayer = true;
        const deadFor = a.alive ? undefined : s.diedAt === undefined ? Infinity : this.deps.time() - s.diedAt;
        rep = corpseCutReputation(r, true, deadFor);
        if (rep) this.deps.addReputation(rep, a.uid);
      }
    }
    this.deps.log(`part cap ${r.ref ? key(r.ref) : '?'} bone ${r.bone} cut${o.effects ? '' : ' (created so)'}${o.byPlayer ? ' by the player' : ''}${rep ? ` (corpse: reputation ${rep})` : ''}`);
  }

  /** Scale the cut bones' children to nothing (after the clips posed the skeleton). */
  private applyHidden(s: PartState, a: PartActor) {
    if (!s.cut.length) return;
    const bones = a.ch.skeleton.bones;
    for (const c of s.cut)
      for (let i = 0; i < s.parents.length; i++) if (s.parents[i] === c && bones[i]) bones[i].scale.setScalar(TINY);
  }

  /**
   * Per frame: the bleed of living bodies (`damage` deals it; attacker the player when a cut was
   * his) and the spurts following their bones.
   */
  update(dt: number, damage: (a: PartActor, amount: number, byPlayer: boolean) => void) {
    const now = this.deps.time();
    for (const [a, s] of this.st) {
      // Removed from the level (Destroy, a clone gone): forget it.
      if (!a.ch.root.parent) {
        this.forget(a);
        continue;
      }
      if (s.follow.length) {
        s.follow = s.follow.filter((f) => f.until > now);
        for (const f of s.follow) {
          const b = a.ch.skeleton.bones[f.bone];
          if (!b) continue;
          b.updateWorldMatrix(true, false);
          f.M.copy(b.matrixWorld);
        }
      }
      if (s.bleed > 0 && a.alive && dt > 0 && a.behavior?.kind !== 'dormant') damage(a, s.bleed * dt, s.byPlayer);
    }
  }

  forget(a: PartActor) {
    const s = this.st.get(a);
    if (!s) return;
    for (const c of s.caps) {
      c.removeFromParent();
      (c.userData.dispose as (() => void) | undefined)?.();
    }
    this.st.delete(a);
  }

  dispose() {
    for (const a of [...this.st.keys()]) this.forget(a);
  }

  save(): PartsSave {
    const now = this.deps.time();
    const out: PartsSave = { a: [] };
    for (const [a, s] of this.st) {
      if (!s.cut.length || a.uid === undefined) continue;
      const dead = a.alive ? -1 : s.diedAt === undefined ? 1e6 : +(now - s.diedAt).toFixed(2);
      out.a.push([a.uid, [...s.cut], +s.bleed.toFixed(3), s.byPlayer ? 1 : 0, dead]);
    }
    return out;
  }

  /** Put cuts back (no effects); `byUid` finds the re-created actors. */
  load(save: Partial<PartsSave> | undefined, byUid: (uid: number) => PartActor | undefined) {
    const now = this.deps.time();
    for (const [uid, cut, bleed, byPlayer, dead] of save?.a ?? []) {
      const a = byUid(uid);
      const s = a && this.st.get(a);
      if (!a || !s) continue;
      for (const bone of cut) {
        const r = s.rules.find((x) => x.bone === bone) ?? { ...readPartCap([]), bone };
        if (!s.cut.includes(bone)) this.cut(a, s, { ...r, bleed: 0 }, { effects: false, byPlayer: false });
      }
      s.bleed = bleed;
      s.byPlayer = !!byPlayer;
      if (dead >= 0) s.diedAt = now - dead;
    }
  }
}
