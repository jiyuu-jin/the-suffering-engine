// Dismemberment: the Character's Part Caps (docs/game-logic.md §15.16). Decoded from
// Suffering.rfl [verified unless marked]:
//
//   Part Cap (class 0x627acba2, template-only): p0 cap model (a 2-bone skinned stump), p1 the
//   bone it caps, p2 bleed (damage per second added to the body), p3 grows back when Killjoy
//   resurrects the body, p4 / p5 the corpse rule's delay and reputation, p6 smallest blow,
//   p7..p9 chance (%) from p7 to p9 as the blow grows to p8, p10 most health (% of the maximum)
//   the body may have, p11 weight of the health term, p12 what happens to a weapon held on the
//   capped bone (1 / 2), p13 / p14 damage-type rule, p15 attacker classes, p16 stump spurt
//   generator, p17 severed-part generator.
//
//   Character p16 lists its Part Caps, p17 the parts already cut when it is created (when its
//   p18 is 0: 0x100e1fb3 -> 0x10119690 -> 0x10118fc0), so placed corpses lie headless or
//   armless. The component lives at Character +0x536 (Player +0x448, the same p16): +0 the bleed
//   rate, +4 flags (2: a cut was the player's; 1: the created cuts are done), +8 the owner.
//
//   The blow (0x10119150, from the Character damage 0x100e76e1 after the health change and the
//   kill reputation, for every blow alive or dead, unless the character's flags +0x6c & 0x100 /
//   +0x70 & 0x80 forbid it; the Player's damage 0x1002e036 likewise):
//     - the struck hit sphere's bone (record +0x20 -> 0x10085e50) gives its channel; the first
//       p16 cap whose p1 is the channel's bone is the candidate (0x10119270 loop); the channel
//       must not be cut already (node flag 0x10, 0x1008b8e0);
//     - amount > 0 and >= p6; health / max x 100 <= p10;
//     - p13 XOR (damage type listed in p14) must be 1: p13 = 1 lists the types that cannot cut
//       (bullets 1, axe 2, fire 5, shiv 10, 12 on the torso / pelvis caps), p13 = 0 the only
//       ones that can (none listed: never);
//     - p15 listed: the attacker (record +0x24) must be a Character whose template's class is
//       the class of one of the p15 templates (0x101193d5..0x101194ac compares the class
//       hashes): Torque's head 2:625 [2:923 CartWheeler], his waist 2:675 [2:922 Fester];
//     - chance (%) = (p7 + (p9 - p7) x min(amount / p8, 1)) x (p11 + (100 - p11) x (p10 -
//       health) / p10) / 100 against rand() / 32767 x 100 (retail p11 = 100: the health term is 1).
//   The cut (0x10118dd0): weapons on capped bones of the subtree are dropped (p12 1) or removed
//   (p12 2, or the bone was cut before) (0x10118790 -> 0x100e4dd0); bleed += p2; the Part Cap
//   object is created at the hit bone's matrix and attached to the bone (world vt +4, animator
//   vt +0x18); the animator sets node flag 0x10 on the bone's node and on every node of its
//   subtree (request 0x100010 -> 0x470f20 -> 0x470b70 0x470bc6) and its own state flag
//   0x4000000. Then, when the attacker is the player: flag 2, and on a body dead for more than
//   p4 s (0x100a1f20: now - death time) reputation += p5 (0x1011961f).
//   What node flag 0x10 does (SUFFERING.EXE): nothing to the pose (the bone matrices 0x4701c0 /
//   0x46ecd0 never read it). The renderer (draw 0x493698, shadow 0x4cd447), while the animator
//   has 0x4000000, ORs for every channel whose bone's node is cut (0x4914d0) the channel's LOD
//   bits (0x4914a0: the channel table's `bits` word of the drawn LOD) and skips the mesh's draw
//   batches whose bit is set (0x4cc640: batch i skipped when mask & 1 << i). On every rig with
//   Part Caps the channels that carry a bit are the body segments the caps cut off (humans:
//   chest 6 / 7, forearms 12 / 30, hands 14 / 32, neck 48, head 49, legs 55 / 60..62), so the
//   cut bone's own segment and every segment below it vanish and the cap stands in for them.
//   Hit-sphere tests skip spheres whose bone's node is cut (0x4271fd, 0x42908a, 0x429264), and
//   animation events on a cut node are not dispatched (0x46d96a).
//   The bleed (update 0x10118680): while the body lives, bleed x frame time through its damage
//   virtual, attacker the player when flag 2 is set (so the kill is the player's), else itself.
//   Readers of the bleed besides the update: the Action Dialog count skips a player's hit while
//   the body bleeds (0x10040d10); HitReactBehavior (0x100ef7a8) kills a knocked-down body at
//   once when health <= bleed x the length of its get-up clip p21 instead of standing it up;
//   KillObjectBehavior (0x100fc047) starts no Dodge (0x38) / ProjectileBlock (0x21) and
//   MainlinerKillObject (0x1007ebcf) no evasion while bleeding; the Player (0x100415ac): alive
//   and not bleeding for two pickup classes. Nothing reads it for speed.
//   Regrowth (0x101189e0, from the resurrection 0x100eda49: bleed = 0, flag 2 cleared, then
//   every p16 cap with p3 != 0): the cap object is released and the bone's subtree gets request
//   0x200010 (node flag 0x10 cleared): the segments show again. Caps without p3 stay cut.
//   CapLimb (message 451, fixed input of the Character and the Player maps, 0x100e3e19 /
//   0x1002d99b): [+4] = 1 cuts the p16 cap of bone [+0xa] (an animation event's bone) by bone
//   (0x10118fc0, no blow test), otherwise the whole p17 list. The only retail clip with the
//   event is Torque's death by a Slayer, Player p332 = 2:562 (bones 11, 31, 48: caps 2:766 /
//   2:765 / 2:770, whose p6 1e9 no blow reaches).
//
// Port [inferred unless marked]: an NPC blade's blow carries the sphere it struck (the first leaf
// in node index order its sweep touches [verified 0x100c9680], npc-melee.ts sweepHit), a thrown
// missile's the sphere it met; other blows pick the nearest posed leaf hit sphere to their point
// that is not on a cut bone; a bone's channel is the nearest bone up the tree (itself first) in the model's
// channel table. The draw batches are the engine's; the port groups the mesh's triangles by
// segment (the nearest bit channel up the tree from each corner's heaviest bone, the corners'
// majority) and drops the triangles of the cut segments from the actor's own index (the vertex
// buffers stay shared). Rigs without channel bits keep the older stand-in (the cut bone's
// descendants scaled to nothing). What rides the cut bones goes too (worn caps, guns:
// weapons/npc.ts brokenParts); the cap model rides the cut bone; the p17 generator is spawned at
// the cut bone, thrown away from the attacker; the p16 spurt follows the bone. Posed bodies (a
// DormantBehavior pose) do not bleed [port: their placed pose is kept].

import * as THREE from 'three/webgpu';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { partCapReputation } from '../insanity/reputation';
import { gore } from '../fx/gore-bus';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');
const ints = (v: PropValue | undefined): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const key = (r: ResRef) => `${r.pkg}:${r.id}`;

/** Message 451 (animation event / link message): cut a cap by bone, or the p17 list. */
export const CAP_LIMB = 451;

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
  /** p15: the attacker's class must be one of these (class names; "pkg:id" when unresolved). */
  attackers: string[];
  spurt?: ResRef;
  part?: ResRef;
}

/** `classOf`: the class name of a p15 template (the attacker test compares classes). */
export function readPartCap(v: readonly PropValue[], r?: ResRef, classOf?: (r: ResRef) => string | undefined): PartCapRule {
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
    attackers: refs(v[15]).map((x) => classOf?.(x) ?? key(x)),
    spurt: ref(v[16]),
    part: ref(v[17]),
  };
}

/** Class name of a template (undefined: no template / unknown class). */
export function templateClass(pkgs: EntityPackageSet, r: ResRef): string | undefined {
  const t = readObjectTemplate(pkgs, r);
  return t ? classByHash(t.classHash)?.name : undefined;
}

/** A Part Cap template by reference (anything else: undefined). */
export function readPartCapRef(pkgs: EntityPackageSet, r: ResRef): PartCapRule | undefined {
  const t = readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  return t && c?.name === 'Part Cap' ? readPartCap(decodeTemplateProps(c, t), r, (x) => templateClass(pkgs, x)) : undefined;
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
  /** The attacker's class (a Character's template class), for p15. */
  attackerClass?: string;
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
  if (r.attackers.length && !(b.attackerClass && r.attackers.includes(b.attackerClass))) return false;
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

/** Bones whose nodes carry flag 0x10 after these cuts: each cut bone and its subtree. */
export function goneBones(parents: readonly number[], cut: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const c of cut) {
    out.add(c);
    for (const d of descendantsOf(parents, c)) out.add(d);
  }
  return out;
}

/** Segment bones: the channels whose LOD-0 bits word is set (the renderer's batch bits). */
export function segmentBonesOf(channels: readonly { bone: number; bits: readonly number[] }[]): number[] {
  return channels.filter((c) => (c.bits[0] ?? 0) !== 0).map((c) => c.bone);
}

/**
 * Segment of every triangle [port]: each corner's heaviest bone, up the tree to the nearest
 * segment bone (-1: the trunk, never hidden); the corners' majority (ties: the first corner).
 */
export function faceSegments(
  index: ArrayLike<number>,
  skinIndex: ArrayLike<number>,
  skinWeight: ArrayLike<number>,
  parents: readonly number[],
  segs: ReadonlySet<number>,
  influences = 4,
): Int32Array {
  const memo = new Map<number, number>();
  const segOf = (bone: number) => {
    let s = memo.get(bone);
    if (s === undefined) memo.set(bone, (s = channelOf(parents, segs, bone)));
    return s;
  };
  const corner = (v: number) => {
    let best = -1, w = -1;
    for (let k = 0; k < influences; k++) {
      const x = skinWeight[v * influences + k];
      if (x > w) (w = x), (best = skinIndex[v * influences + k]);
    }
    return segOf(best);
  };
  const n = Math.floor(index.length / 3);
  const out = new Int32Array(n);
  for (let t = 0; t < n; t++) {
    const a = corner(index[3 * t]), b = corner(index[3 * t + 1]), c = corner(index[3 * t + 2]);
    out[t] = b === c ? b : a;
  }
  return out;
}

/** The index without the triangles of hidden segments, groups (material ranges) re-counted. */
export function keptTriangles(
  index: ArrayLike<number>,
  groups: readonly { start: number; count: number; materialIndex?: number }[],
  faceSeg: Int32Array,
  hidden: ReadonlySet<number>,
): { index: Uint32Array; groups: { start: number; count: number; materialIndex: number }[] } {
  const out: number[] = [];
  const gs: { start: number; count: number; materialIndex: number }[] = [];
  const ranges = groups.length ? groups : [{ start: 0, count: index.length, materialIndex: 0 }];
  for (const g of ranges) {
    const start = out.length;
    for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
      if (hidden.has(faceSeg[i / 3])) continue;
      out.push(index[i], index[i + 1], index[i + 2]);
    }
    gs.push({ start, count: out.length - start, materialIndex: g.materialIndex ?? 0 });
  }
  return { index: Uint32Array.from(out), groups: gs };
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

/**
 * HitReactBehavior's knockdown (0x100ef75c..0x100ef7ef): a bleeding body whose health would run
 * out while its get-up clip p21 plays (health <= bleed x clip length) dies on the floor instead.
 */
export function bleedsOutBeforeUp(health: number, bleed: number, getUpLength: number): boolean {
  return bleed > 0 && health > 0 && health <= bleed * getUpLength;
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
  /** Parts left to cut, or blows that still do something (a dead body still takes blows). */
  cuttable?: boolean;
  /** Corpse blows matter besides the caps (Character p117 gibs: actors/gibs.ts). */
  corpseBlows?: boolean;
  /** The bleed rate (+0x536), mirrored for the AI readers. */
  bleed?: number;
}

interface PartState {
  rules: PartCapRule[];
  /** Character p17 (the CapLimb message without a bone cuts these). */
  precut: PartCapRule[];
  parents: number[];
  channels: Set<number>;
  /** Segment bones (channels with LOD bits); empty: the scale stand-in. */
  segs: Set<number>;
  /** Cut cap bones (node flag 0x10), in order. */
  cut: number[];
  /** Cut bones and their subtrees (node flag 0x10). */
  gone: Set<number>;
  /** +0x536: bleed (damage per second). */
  bleed: number;
  /** Flag 2: a cut was the player's. */
  byPlayer: boolean;
  /** Game time of death (undefined: alive, or dead before the runtime saw it: long dead). */
  diedAt?: number;
  /** Spurts following their bone: matrix updated in place until `until`. */
  follow: { bone: number; M: THREE.Matrix4; until: number }[];
  caps: Map<number, THREE.Object3D>;
  /** Bones this runtime put into brokenParts. */
  broken: Set<number>;
  /** Bones scaled away by the stand-in (restored on regrowth). */
  scaled: Set<number>;
  /** Face mode: the shared geometry, its triangles' segments. */
  base?: THREE.BufferGeometry;
  faceSeg?: Int32Array;
  /** CapLimb events due (clip events: game time, bone). */
  due: { t: number; bone: number }[];
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

  /**
   * Give an actor its Part Caps (Character p16) and model data; `precut`: p17 (cut now when
   * `cutNow`: p18 = 0); `segments`: bones of the channels with LOD bits (segmentBonesOf).
   */
  setup(a: PartActor, rules: PartCapRule[], parents: number[], channels: number[], precut: PartCapRule[] = [], segments: number[] = [], cutNow = true) {
    if (!rules.length && !precut.length) return;
    const s: PartState = {
      rules,
      precut,
      parents,
      channels: new Set(channels),
      segs: new Set(segments),
      cut: [],
      gone: new Set(),
      bleed: 0,
      byPlayer: false,
      follow: [],
      caps: new Map(),
      broken: new Set(),
      scaled: new Set(),
      due: [],
    };
    this.st.set(a, s);
    a.ch.poseHooks.push(() => this.applyScaled(s, a));
    // Created already cut (0x10119690 with flag 0: no spurt, no severed part); the bleed is added.
    if (cutNow) for (const r of precut) this.cut(a, s, r, { effects: false, byPlayer: false });
    this.mark(a, s);
  }

  private mark(a: PartActor, s: PartState) {
    a.cuttable = !!a.corpseBlows || s.rules.some((r) => !s.gone.has(r.bone));
    a.bleed = s.bleed;
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

  bleedRate(a: PartActor): number {
    return this.st.get(a)?.bleed ?? 0;
  }

  /** The bleed's credit: the player when a cut was his (flag 2). */
  bleedByPlayer(a: PartActor): boolean {
    return !!this.st.get(a)?.byPlayer;
  }

  cutBones(a: PartActor): readonly number[] {
    return this.st.get(a)?.cut ?? [];
  }

  /** A bone whose node is cut (hit spheres on it are skipped, its clip events not dispatched). */
  isGone(a: PartActor, bone: number): boolean {
    return !!this.st.get(a)?.gone.has(bone);
  }

  died(a: PartActor) {
    const s = this.st.get(a);
    if (s) s.diedAt = this.deps.time();
  }

  /**
   * A blow on the actor (after its health changed): 0x10119150. `point`: where it landed (no
   * point: no hit sphere, no cut); `from`: the attacker's position (the part flies away from it).
   */
  hit(a: PartActor, blow: PartBlow & { point?: THREE.Vector3Like; bone?: number; from?: THREE.Vector3Like; byPlayer: boolean }): PartCapRule | undefined {
    const s = this.st.get(a);
    if (!s?.rules.length || !blow.point) return undefined;
    // The struck sphere's bone when the blow carries it (a blade's first touched leaf, npc-melee.ts
    // sweepHit; a missile's contact); else the leaf nearest the point. The sphere tree skips the
    // spheres of cut nodes (0x4271fd).
    let bone = blow.bone !== undefined && blow.bone >= 0 && !s.gone.has(blow.bone) ? blow.bone : -1;
    if (bone < 0) {
      const spheres = this.deps.spheres(a).filter((x) => !s.gone.has(x.bone));
      const i = nearestSphere(spheres, blow.point);
      if (i < 0) return undefined;
      bone = spheres[i].bone;
    }
    const ch = channelOf(s.parents, s.channels, bone);
    const r = ch >= 0 ? capFor(s.rules, ch) : undefined;
    if (!r || s.gone.has(r.bone)) return undefined;
    const health = a.alive ? a.health : Math.min(0, a.health);
    if (!capAllows(r, blow, health, a.maxHealth)) return undefined;
    if (!cutRoll(r, blow.amount, health, (this.deps.rand ?? Math.random)())) return undefined;
    const dir = blow.from ? new THREE.Vector3(blow.point.x - blow.from.x, 0, blow.point.z - blow.from.z) : undefined;
    if (dir && dir.lengthSq() > 1e-6) dir.normalize();
    this.cut(a, s, r, { effects: true, byPlayer: blow.byPlayer, dir: dir?.lengthSq() ? dir : undefined });
    return r;
  }

  /**
   * CapLimb (message 451): with a bone, the p16 cap of that bone by bone (0x10118fc0: no blow
   * test); without, the p17 list. Returns the caps cut.
   */
  capLimb(a: PartActor, bone?: number): number {
    const s = this.st.get(a);
    if (!s) return 0;
    const list = bone === undefined ? s.precut : s.rules.filter((r) => r.bone === bone).slice(0, 1);
    let n = 0;
    for (const r of list) {
      if (s.gone.has(r.bone)) continue;
      this.cut(a, s, r, { effects: true, byPlayer: false });
      n++;
    }
    return n;
  }

  /** CapLimb events of a clip that starts now: [clip time, bone] (fired from update()). */
  schedule(a: PartActor, events: readonly { time: number; bone: number }[], rate = 1) {
    const s = this.st.get(a);
    if (!s) return;
    const now = this.deps.time();
    s.due = events.map((e) => ({ t: now + e.time / Math.max(0.05, rate), bone: e.bone }));
  }

  /**
   * Resurrection (0x100eda37..0x100eda61): bleed 0, flag 2 cleared, the p16 caps with p3 grow
   * back (0x101189e0). Returns the caps that grew back.
   */
  regrow(a: PartActor): number {
    const s = this.st.get(a);
    if (!s) return 0;
    s.bleed = 0;
    s.byPlayer = false;
    s.diedAt = undefined;
    let n = 0;
    for (const r of s.rules) {
      if (!r.regrow || !s.cut.includes(r.bone)) continue;
      s.cut.splice(s.cut.indexOf(r.bone), 1);
      const cap = s.caps.get(r.bone);
      if (cap) {
        cap.removeFromParent();
        (cap.userData.dispose as (() => void) | undefined)?.();
        s.caps.delete(r.bone);
      }
      n++;
    }
    s.follow = s.follow.filter((f) => s.cut.includes(f.bone));
    if (n) {
      this.refresh(a, s);
      this.deps.log(`part caps: ${n} grew back`);
    }
    this.mark(a, s);
    return n;
  }

  private cut(a: PartActor, s: PartState, r: PartCapRule, o: { effects: boolean; byPlayer: boolean; dir?: THREE.Vector3 }) {
    const bones = a.ch.skeleton.bones;
    const b = bones[r.bone];
    if (!b || s.cut.includes(r.bone)) return;
    s.cut.push(r.bone);
    s.bleed += r.bleed;
    if (s.bleed === 0) s.byPlayer = false;
    if (r.capModel) {
      const cap = this.deps.buildCap(r.capModel);
      if (cap) {
        cap.name = `part-cap ${key(r.capModel)}`;
        b.add(cap);
        s.caps.set(r.bone, cap);
      }
    }
    this.refresh(a, s);
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
      // Enhanced mode's gore (gore-bus.ts; never set in Original): the stump bleeds.
      gore.listener?.cut?.(b, a.ch.root, o.dir);
      if (o.byPlayer) {
        s.byPlayer = true;
        const deadFor = a.alive ? undefined : s.diedAt === undefined ? Infinity : this.deps.time() - s.diedAt;
        rep = corpseCutReputation(r, true, deadFor);
        if (rep) this.deps.addReputation(rep, a.uid);
      }
    }
    this.mark(a, s);
    this.deps.log(`part cap ${r.ref ? key(r.ref) : '?'} bone ${r.bone} cut${o.effects ? '' : ' (created so)'}${o.byPlayer ? ' by the player' : ''}${rep ? ` (corpse: reputation ${rep})` : ''}`);
  }

  /** After the cut list changed: the gone set, what rides the bones, the drawn triangles. */
  private refresh(a: PartActor, s: PartState) {
    s.gone = goneBones(s.parents, s.cut);
    // What rides the cut bones goes with them (worn caps, guns: weapons/npc.ts brokenParts).
    a.brokenParts ??= new Set();
    for (const d of s.broken) if (!s.gone.has(d)) a.brokenParts.delete(d);
    for (const d of s.gone) a.brokenParts.add(d);
    s.broken = new Set(s.gone);
    if (!this.applyFaces(a, s)) {
      // The stand-in: the cut bones' children scaled to nothing (restored when they grow back).
      const want = new Set<number>();
      for (const c of s.cut) for (let i = 0; i < s.parents.length; i++) if (s.parents[i] === c) want.add(i);
      for (const i of s.scaled) if (!want.has(i)) a.ch.skeleton.bones[i]?.scale.setScalar(1);
      s.scaled = want;
      this.applyScaled(s, a);
    }
  }

  /** Face mode: the actor's own index without the cut segments. False: no segments (stand-in). */
  private applyFaces(a: PartActor, s: PartState): boolean {
    const mesh = a.ch.mesh as THREE.Mesh;
    if (!s.segs.size || !(mesh as { isMesh?: boolean }).isMesh) return false;
    s.base ??= mesh.geometry;
    const base = s.base;
    const idx = base.index, si = base.getAttribute('skinIndex'), sw = base.getAttribute('skinWeight');
    if (!idx || !si || !sw) return false;
    s.faceSeg ??= faceSegments(idx.array, si.array, sw.array, s.parents, s.segs, si.itemSize);
    const hidden = new Set([...s.segs].filter((b) => s.gone.has(b)));
    if (!hidden.size) {
      mesh.geometry = base;
      return true;
    }
    const k = keptTriangles(idx.array, base.groups, s.faceSeg, hidden);
    // The vertex buffers stay the shared ones; only the index is the actor's own. The old cut
    // geometry is dropped without dispose() (that would release the shared attributes).
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(k.index, 1));
    for (const gr of k.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    if (base.boundingSphere) g.boundingSphere = base.boundingSphere.clone();
    if (base.boundingBox) g.boundingBox = base.boundingBox.clone();
    g.name = `${base.name || 'body'} (cut)`;
    mesh.geometry = g;
    return true;
  }

  /** The stand-in: scale the cut bones' children to nothing (after the clips posed the skeleton). */
  private applyScaled(s: PartState, a: PartActor) {
    if (!s.scaled.size) return;
    const bones = a.ch.skeleton.bones;
    for (const i of s.scaled) bones[i]?.scale.setScalar(TINY);
  }

  /**
   * Per frame: the bleed of living bodies (`damage` deals it; attacker the player when a cut was
   * his), the spurts following their bones and CapLimb events due.
   */
  update(dt: number, damage: (a: PartActor, amount: number, byPlayer: boolean) => void) {
    const now = this.deps.time();
    for (const [a, s] of this.st) {
      // Removed from the level (Destroy, a clone gone): forget it.
      if (!a.ch.root.parent) {
        this.forget(a);
        continue;
      }
      if (s.due.length) {
        const fire = s.due.filter((d) => d.t <= now);
        s.due = s.due.filter((d) => d.t > now);
        for (const d of fire) this.capLimb(a, d.bone);
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
    for (const c of s.caps.values()) {
      c.removeFromParent();
      (c.userData.dispose as (() => void) | undefined)?.();
    }
    if (s.base && (a.ch.mesh as THREE.Mesh).geometry !== s.base) (a.ch.mesh as THREE.Mesh).geometry = s.base;
    this.st.delete(a);
  }

  dispose() {
    for (const a of [...this.st.keys()]) this.forget(a);
  }

  save(): PartsSave {
    const now = this.deps.time();
    const out: PartsSave = { a: [] };
    for (const [a, s] of this.st) {
      if ((!s.cut.length && !s.bleed && !s.precut.length) || a.uid === undefined) continue;
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
      // Created cuts the saved body no longer has (it grew them back): restore the saved list.
      for (const bone of [...s.cut]) if (!cut.includes(bone)) this.uncut(a, s, bone);
      for (const bone of cut) {
        const r = s.rules.find((x) => x.bone === bone) ?? s.precut.find((x) => x.bone === bone) ?? { ...readPartCap([]), bone };
        if (!s.cut.includes(bone)) this.cut(a, s, { ...r, bleed: 0 }, { effects: false, byPlayer: false });
      }
      s.bleed = bleed;
      s.byPlayer = !!byPlayer;
      if (dead >= 0) s.diedAt = now - dead;
      this.mark(a, s);
    }
  }

  private uncut(a: PartActor, s: PartState, bone: number) {
    s.cut.splice(s.cut.indexOf(bone), 1);
    const cap = s.caps.get(bone);
    if (cap) {
      cap.removeFromParent();
      (cap.userData.dispose as (() => void) | undefined)?.();
      s.caps.delete(bone);
    }
    this.refresh(a, s);
  }
}
