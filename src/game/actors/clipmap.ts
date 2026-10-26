// Which animation clip a creature uses for idle / move / attack / hit / death.
//
// Clips carry no names. Character templates (Character family classes: NPCs,
// creatures) reference *behavior* templates (IdleBehavior, MovementAnimBehavior,
// DeathBehavior, HitReactBehavior, MeleeAttackBehavior -> Attack), and those
// hold the animation refs. We look the behaviors up by class name (not by
// property index, which differs between classes):
//
//   IdleBehavior           p2  idle clip
//   MovementAnimBehavior   p2  idle, p3 walk/move, p5 run (p9/p10: turn in place)
//   DeathBehavior          p2  death clips (list)
//   HitReactBehavior       p7  hit-reaction clips (list), several per creature
//   FallBehavior           p2  falling pose
//   JumpBehavior           p5  airborne pose, p6 landing (drop-in creatures, Behavior Changer 10:129)
//   DormantBehavior        p2  1 = present, playing p5 until woken; 2 = not shown until woken
//                              (Slayers placed in mid-air / inside walls); p3 unknown flag
//   MeleeAttackBehavior    p2  Attack templates: p0 clip, p6 / p16 reach (m) [guess],
//                              p18 attack strength [guess]
//
// When a template lacks a behavior, clip labels from root motion fill the gaps
// (formats/animation.ts guessClipLabel).
//
// Clip events (.adu type 5, see readClipEvents): kind 0 = play a sound (param 0:
// random pick from the clip's sound list, else a sound ref), kind 1 = marker
// (param 100/101 bracket the damage window of attacks, 200/205 footstep/impact).

import type { SrscFile } from '../../formats/srsc';
import { findEntry, type PackageSet, type ResRef } from '../../formats/model';
import { classByHash, decodeTemplateProps, PROP_LIST, PropType, readObjectTemplate, type PropValue } from '../../formats/entities';
import {
  ADU_EVENTS,
  guessClipLabel,
  listAnimations,
  readAnimation,
  rootMotion,
  type AnimClipData,
} from '../../formats/animation';

export interface ClipRef {
  pkg: number;
  id: number;
}

export interface AttackSpec {
  clip: ClipRef;
  /** Max distance (m) at which this attack is started. */
  reach: number;
  /** Damage dealt to the player when it connects. */
  damage: number;
  /** Attack p15: minimum distance (m, target radius off) to start it. */
  minReach?: number;
  /** Attack p17: maximum height difference (m) to start it; 0 = none (p17 <= 0). */
  maxDy?: number;
  /** Attack p14: p15 / p16 scale with the character's size. */
  scaled?: boolean;
  /** Attack p6: the Melee Weapon's p68 x this on the attack's target (actors/npc-melee.ts) [verified]. */
  scale?: number;
  /** Attack p7: the Melee Weapon's p69 impact force x this (0x100caa7d) [verified]. */
  forceScale?: number;
  /** From a MeleeAttackBehavior: hurts only through a Melee Weapon armed by the clip [verified]. */
  weaponOnly?: boolean;
}

export interface CreatureClipMap {
  idle?: ClipRef;
  walk?: ClipRef;
  run?: ClipRef;
  attacks: AttackSpec[];
  hits: ClipRef[];
  deaths: ClipRef[];
  /** Falling pose and landing clip (FallBehavior / JumpBehavior). */
  fall?: ClipRef;
  land?: ClipRef;
  /** Where each mapping came from ("behavior" or "heuristic"), for debugging. */
  source: Record<string, string>;
}

export interface ClipEvents {
  /** Sound keys ("pkg:id") played at a time (s, clip time). */
  sounds: { time: number; keys: string[] }[];
  /** Clip times of damage-window starts (attacks). */
  hitTimes: number[];
  /** Clip times of the Fire (102) markers: one shot each, from the weapon on the marker's bone. */
  fireTimes?: number[];
  /**
   * Clip times of the ThrowWeapon (230) markers: a thrown weapon (a BouncingObject in the weapon
   * set) leaves the hand (ProjectileAttack's animation messages 0x100fcec0, case 230 ->
   * 0x100fd026) [verified].
   */
  throwTimes?: number[];
}

const refOf = (v: PropValue | undefined): ClipRef | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? { pkg: v.pkg, id: v.id } : undefined;
const refsOf = (v: PropValue | undefined): ClipRef[] =>
  (Array.isArray(v) ? v : [v]).flatMap((x) => (x && typeof x === 'object' ? [{ pkg: x.pkg, id: x.id }] : []));
const num = (v: PropValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Character MeleeAttackBehavior slot (behaviour type 5) [verified 0x100e17c0]. */
export const CHARACTER_MELEE_SLOT = 87;

/**
 * Templates referenced by a template's top-level Template-typed properties, with their class names.
 * `overrides`: an instance's own values for some of those slots (property index -> template), used
 * in place of the template's.
 */
function behaviorTemplates(pkgs: PackageSet, template: ResRef, overrides?: ReadonlyMap<number, ResRef>): { cls: string; values: PropValue[]; types: number[]; index: number }[] {
  const t = readObjectTemplate(pkgs, template);
  if (!t) return [];
  const cls = classByHash(t.classHash);
  if (!cls) return [];
  const vals = decodeTemplateProps(cls, t);
  const out: { cls: string; values: PropValue[]; types: number[]; index: number }[] = [];
  vals.forEach((v, i) => {
    if (((cls.types[i] ?? 0) & 0xff) !== PropType.Template) return;
    const own = overrides?.get(i);
    for (const r of own ? [own] : refsOf(v)) {
      const bt = readObjectTemplate(pkgs, r);
      const bc = bt ? classByHash(bt.classHash) : undefined;
      if (bt && bc) out.push({ cls: bc.name, values: decodeTemplateProps(bc, bt), types: bc.types, index: i });
    }
  });
  return out;
}

/** Read a clip by ref (the clip's own package .adu). Cached per file. */
const clipCache = new WeakMap<SrscFile, Map<number, AnimClipData | null>>();
export function loadClip(pkgs: PackageSet, ref: ClipRef): AnimClipData | undefined {
  const adu = pkgs.get(ref.pkg)?.adu;
  if (!adu) return undefined;
  let m = clipCache.get(adu);
  if (!m) clipCache.set(adu, (m = new Map()));
  if (!m.has(ref.id)) m.set(ref.id, readAnimation(adu, ref.id) ?? null);
  return m.get(ref.id) ?? undefined;
}

/** Horizontal speed (m/s) of a clip's root motion at its authored rate. */
export function clipSpeed(clip: AnimClipData): number {
  const [dx, , dz] = rootMotion(clip);
  return (Math.hypot(dx, dz) / Math.max(clip.duration, 1e-3)) * (clip.rate || 1);
}

/**
 * Resolve the clip map for a Character-family template. `animSet`/`modelPkg`
 * are the rig's animation set (SkinnedModel.animSet) and the package of its
 * .mdu, used for the heuristic fallback.
 */
export function resolveCreatureClips(pkgs: PackageSet, template: ResRef, modelPkg: number, animSet: number, overrides?: ReadonlyMap<number, ResRef>): CreatureClipMap {
  const map: CreatureClipMap = { attacks: [], hits: [], deaths: [], source: {} };
  const ok = (r: ClipRef | undefined) => !!r && !!loadClip(pkgs, r);
  const behaviors = behaviorTemplates(pkgs, template, overrides);
  // A Character's melee is its MeleeAttackBehavior slot p87 (behaviour type 5 -> p87, RFL
  // 0x100e17c0) [verified]; other MeleeAttackBehaviors of the template belong to class-specific
  // slots used under conditions (the CartWheeler's ceiling slash p179, specials/cartwheeler.ts).
  const ownMelee = behaviors.some((b) => b.index === CHARACTER_MELEE_SLOT && b.cls === 'MeleeAttackBehavior');
  for (const b of behaviors) {
    const v = b.values;
    switch (b.cls) {
      case 'IdleBehavior':
        if (!map.idle && ok(refOf(v[2]))) (map.idle = refOf(v[2])), (map.source.idle = 'behavior');
        break;
      case 'MovementAnimBehavior': {
        const idle = refOf(v[2]), walk = refOf(v[3]), run = refOf(v[5]);
        if (!map.idle && ok(idle)) (map.idle = idle), (map.source.idle = 'behavior');
        if (!map.walk && ok(walk)) (map.walk = walk), (map.source.walk = 'behavior');
        if (!map.run && ok(run)) (map.run = run), (map.source.run = 'behavior');
        break;
      }
      case 'FallBehavior':
        if (!map.fall && ok(refOf(v[2]))) map.fall = refOf(v[2]);
        break;
      case 'JumpBehavior':
        if (!map.fall && ok(refOf(v[5]))) map.fall = refOf(v[5]);
        if (!map.land && ok(refOf(v[6]))) map.land = refOf(v[6]);
        break;
      case 'DeathBehavior':
        if (!map.deaths.length) {
          map.deaths = refsOf(v[2]).filter(ok);
          if (map.deaths.length) map.source.death = 'behavior';
        }
        break;
      case 'HitReactBehavior':
        for (const r of refsOf(v[7])) if (ok(r) && !map.hits.some((h) => h.id === r.id && h.pkg === r.pkg)) map.hits.push(r);
        if (map.hits.length) map.source.hit = 'behavior';
        break;
      case 'MeleeAttackBehavior':
        if (ownMelee && b.index !== CHARACTER_MELEE_SLOT) break;
        for (const a of refsOf(v[2])) {
          const at = readObjectTemplate(pkgs, a);
          const ac = at ? classByHash(at.classHash) : undefined;
          if (!at || ac?.name !== 'Attack') continue;
          const av = decodeTemplateProps(ac, at);
          const clip = refOf(av[0]);
          if (!ok(clip)) continue;
          // Attack p16: the farthest the attack is started from (p6 is the damage multiplier,
          // not a reach).
          const reach = Math.min(2.8, Math.max(0.8, num(av[16], 1.4)));
          // p18 looks like attack strength (35..60 for the Slayer-type); scaled to player health 100.
          const damage = Math.max(5, Math.min(30, num(av[18], 40) / 4));
          // Can-attack test (RFL 0x10080180 / 0x10080010): Attack p15 <= horizontal distance
          // minus the target's radius <= p16, |dy| <= p17 when p17 > 0 [verified].
          map.attacks.push({ clip: clip!, reach, damage, minReach: Math.max(0, num(av[15], 0)), maxDy: Math.max(0, num(av[17], 0)), scaled: num(av[14], 0) !== 0, scale: num(av[6], 1), forceScale: num(av[7], 1), weaponOnly: true });
        }
        if (map.attacks.length) map.source.attack = 'behavior';
        break;
    }
  }

  // Creatures with their own attack behaviors (grab, jump attack, ...): use their clips.
  if (!map.attacks.length) {
    for (const b of behaviors) {
      if (!/Attack|KillMelee/.test(b.cls)) continue;
      b.values.forEach((v, i) => {
        if (((b.types[i] ?? 0) & 0xff) !== PropType.Animation) return;
        for (const r of refsOf(v)) {
          // Hurting only through a Melee Weapon the clip arms (Arm 100 / Disarm 101, npc-melee.ts):
          // NPC melee damage comes from an armed weapon alone [verified 0x100ca210 / 0x100ca920].
          // The Mainliner's and the Nooseman's clips arm none (their needles and grabs are their
          // specials'); before, each landed a guessed 10 at its hit time with no damage type, which
          // the Part Caps' type rule could not refuse: 2's Dallas bled out from a chest cut
          // (10:863, which bullets and blades cannot cut) after a Mainliner's "blow" (run d2a).
          if (ok(r) && !map.attacks.some((a) => a.clip.id === r.id && a.clip.pkg === r.pkg)) map.attacks.push({ clip: r, reach: 1.8, damage: 10, weaponOnly: true });
        }
      });
    }
    if (map.attacks.length) map.source.attack = 'attack behavior';
  }

  // Heuristic fallback from the rig's animation set.
  const adu = pkgs.get(modelPkg)?.adu;
  if (adu && (!map.idle || !map.walk || !map.run)) {
    const labelled = listAnimations(adu, animSet)
      .map((info) => loadClip(pkgs, { pkg: modelPkg, id: info.id }))
      .filter((c): c is AnimClipData => !!c)
      .map((c) => ({ c, label: guessClipLabel(c), speed: clipSpeed(c) }));
    const pick = (f: (x: (typeof labelled)[number]) => boolean) => labelled.find(f)?.c;
    if (!map.idle) {
      const c = pick((x) => x.label === 'idle_or_long_action' && x.speed < 0.1);
      if (c) (map.idle = { pkg: modelPkg, id: c.id }), (map.source.idle = 'heuristic');
    }
    if (!map.walk) {
      const c = pick((x) => x.label === 'walk_forward' && x.speed > 0.6 && x.speed < 2.6);
      if (c) (map.walk = { pkg: modelPkg, id: c.id }), (map.source.walk = 'heuristic');
    }
    if (!map.run) {
      const c = pick((x) => x.label === 'run_forward' && x.speed >= 2.4 && x.speed < 6.5);
      if (c) (map.run = { pkg: modelPkg, id: c.id }), (map.source.run = 'heuristic');
    }
  }
  map.walk ??= map.run;
  map.run ??= map.walk;
  return map;
}

/** How a placed creature starts (its initial root behavior), see DormantBehavior above. */
export interface Dormancy {
  /** DormantBehavior p2 (1 present, 2 not shown until woken); 0 without a DormantBehavior. */
  mode: number;
  /** DormantBehavior p5: the clip played while dormant. */
  clip?: ClipRef;
  /** The initial behavior is a JumpBehavior: drops in from its placement when woken. */
  jump: boolean;
  fall?: ClipRef;
  land?: ClipRef;
}

/**
 * Initial behavior of a placed creature: the first single-valued Template property
 * (CartWheeler p68, Mainliner p175, ...) holding a DormantBehavior or a JumpBehavior.
 * `values`/`types` are the entity's effective property values and its class types.
 */
export function readDormancy(pkgs: PackageSet, values: PropValue[], types: number[]): Dormancy | undefined {
  for (let i = 0; i < values.length; i++) {
    const ty = types[i] ?? 0;
    if ((ty & 0xff) !== PropType.Template || ty & PROP_LIST) continue;
    const r = refOf(values[i]);
    if (!r) continue;
    const t = readObjectTemplate(pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || !c) continue;
    if (c.name === 'DormantBehavior') {
      const v = decodeTemplateProps(c, t);
      return { mode: num(v[2], 1), clip: refOf(v[5]), jump: false };
    }
    if (c.name === 'JumpBehavior') {
      const v = decodeTemplateProps(c, t);
      return { mode: 0, jump: true, fall: refOf(v[5]), land: refOf(v[6]) };
    }
  }
  return undefined;
}

/** Decode a clip's event block (.adu type 5) into sound cues and damage-window starts. */
export function readClipEvents(adu: SrscFile | undefined, id: number): ClipEvents {
  const out: ClipEvents = { sounds: [], hitTimes: [] };
  const e = adu && findEntry(adu, ADU_EVENTS, id);
  if (!adu || !e || e.size < 4) return out;
  const v = adu.data(e);
  const n = v.getUint32(0, true);
  const end = 4 + 16 * n;
  if (n > 256 || end + 4 > v.byteLength) return out;
  const listN = v.getUint32(end, true);
  const list: string[] = [];
  for (let k = 0; k < listN && end + 8 + 4 * k <= v.byteLength; k++) {
    const id16 = v.getUint16(end + 4 + 4 * k, true), pkg = v.getUint16(end + 6 + 4 * k, true);
    list.push(`${pkg}:${id16}`);
  }
  for (let i = 0; i < n; i++) {
    const o = 4 + 16 * i;
    const kind = v.getUint32(o, true);
    const time = v.getFloat32(o + 4, true);
    const param = v.getUint32(o + 12, true);
    if (kind === 0) {
      const keys = param ? [`${param >>> 16}:${param & 0xffff}`] : list;
      if (keys.length) out.sounds.push({ time, keys });
    } else if (kind === 1 && param === 102) {
      (out.fireTimes ??= []).push(time);
    } else if (kind === 1 && param === 230) {
      (out.throwTimes ??= []).push(time);
    } else if (kind === 1 && param === 100) {
      // Several bones open the window at nearly the same time: keep distinct starts.
      if (!out.hitTimes.some((t) => Math.abs(t - time) < 0.1)) out.hitTimes.push(time);
    }
  }
  return out;
}
