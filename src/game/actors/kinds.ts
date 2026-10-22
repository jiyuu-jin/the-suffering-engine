// Per-template creature data shared by every instance: skinned model, clips
// (built once, shared via Character's `shareFrom`), clip roles, clip events,
// size and hostility.

import type { PackageSet, ResRef } from '../../formats/model';
import { readSkinnedModel, type SkinnedModel } from '../../formats/skeleton';
import { classByHash, readObjectTemplate, decodeTemplateProps } from '../../formats/entities';
import type { AnimClipData } from '../../formats/animation';
import * as THREE from 'three/webgpu';
import { buildAnimationClip, Character, decodeCharacterTextures } from '../../app/character';
import { CHARACTER_MELEE_SLOT, clipSpeed, loadClip, readClipEvents, resolveCreatureClips, type ClipEvents, type ClipRef } from './clipmap';
import { readAnimEvents } from '../../formats/animation';
import { armWindows, type ArmWindow } from '../insanity/melee';
import { readMoverVolume, type MoverVolume } from './mover';

export interface KindAttack {
  clip: number;
  reach: number;
  /** Attack p15 / p17 (clipmap.ts AttackSpec). */
  minReach: number;
  maxDy: number;
  scaled: boolean;
  damage: number;
  /** Clip times (s) at which the blow lands. */
  hitTimes: number[];
  /** Arm (100) .. Disarm (101) windows of the clip by bone hash: the weapon sweep (npc-melee.ts). */
  windows?: ArmWindow[];
  /** Attack p6: damage multiplier on the attack's target. */
  scale?: number;
  /** A MeleeAttackBehavior Attack: damage only through a Melee Weapon its clip arms. */
  weaponOnly?: boolean;
}

export interface CreatureKind {
  key: string;
  template: ResRef;
  className: string;
  skinned: SkinnedModel;
  /** Owns the shared GPU resources and clips; never added to the scene. */
  proto: Character;
  idle: number;
  walk: number;
  /** Run clip (MovementAnimBehavior p5), -1 if none (walk is used). */
  run: number;
  attacks: KindAttack[];
  hits: number[];
  deaths: number[];
  /** Falling pose / landing clip (drop-ins, ceiling hangers letting go); -1 if none. */
  fall: number;
  land: number;
  /** Per clip index: decoded events and natural root-motion speed (m/s at rate). */
  events: ClipEvents[];
  speeds: number[];
  height: number;
  /** Lowest point relative to the origin (0 for creatures standing on their origin). */
  bottom: number;
  /** Hangs from / floats at its placement (e.g. a Nooseman): no gravity, no walking. */
  anchored: boolean;
  radius: number;
  /** Walking speed (m/s, the walk clip's root motion). */
  moveSpeed: number;
  /** Running / chasing speed (m/s, the run clip's root motion; moveSpeed without one). */
  runSpeed: number;
  hostile: boolean;
  maxHealth: number;
  /** Decoration (Animating Static): loops its clip, no AI. */
  decor: boolean;
  /** The template's mover (Character p42 Collider, p46, p48; mover.ts). */
  mover?: MoverVolume;
}

/** Classes that fight the player on sight when they have attacks. Unspeakable NPCs (prisoners, guards) only retaliate. */
const NEUTRAL_CLASSES = new Set(['Unspeakable NPC', 'NPC', 'Horace', 'Hermes']);

export class KindLibrary {
  private kinds = new Map<string, CreatureKind | null>();
  /** Clip refs ("pkg:id") per kind, parallel to the kind's clip list. */
  private refs = new Map<string, string[]>();

  constructor(private readonly pkgs: PackageSet) {}

  /** Creature kind for a Character-family template (null when its model is not skinned). */
  /**
   * `melee`: an instance's own MeleeAttackBehavior (Character p87 overridden on the placement: the
   * Prelude's baton guards 10:297 on template 10:392, which has none); a kind of its own.
   */
  creature(template: ResRef, melee?: ResRef): CreatureKind | null {
    const key = `c${template.pkg}:${template.id}${melee ? `+m${melee.pkg}:${melee.id}` : ''}`;
    if (!this.kinds.has(key)) {
      let k: CreatureKind | null = null;
      try {
        k = this.buildCreature(key, template, melee);
      } catch (err) {
        console.warn(`[actors] template ${template.pkg}:${template.id}:`, err);
      }
      this.kinds.set(key, k);
    }
    return this.kinds.get(key)!;
  }

  /** Looping decoration (Animating Static with a skinned model). */
  decoration(model: ResRef, clips: ClipRef[]): CreatureKind | null {
    const key = `d${model.pkg}:${model.id}/${clips.map((c) => `${c.pkg}:${c.id}`).join(',')}`;
    if (!this.kinds.has(key)) {
      let k: CreatureKind | null = null;
      try {
        const skinned = readSkinnedModel(this.pkgs, model);
        if (skinned) {
          const refs = clips.filter((r) => !!loadClip(this.pkgs, r));
          const data = refs.map((r) => loadClip(this.pkgs, r)!);
          k = this.finish(key, model, 'Animating Static', skinned, data, { decor: true, refs });
        }
      } catch (err) {
        console.warn(`[actors] decoration ${model.pkg}:${model.id}:`, err);
      }
      this.kinds.set(key, k);
    }
    return this.kinds.get(key)!;
  }

  /**
   * Index of a clip in a kind's (shared) clip list, adding it when missing (e.g. an
   * instance's DormantBehavior clip). -1 if it can't be loaded or is for another rig.
   */
  clipIndex(kind: CreatureKind, ref: ClipRef | undefined): number {
    if (!ref) return -1;
    const keys = this.refs.get(kind.key) ?? [];
    const k = `${ref.pkg}:${ref.id}`;
    let i = keys.indexOf(k);
    if (i >= 0) return i;
    const c = loadClip(this.pkgs, ref);
    if (!c || (c.animSet !== kind.skinned.animSet && !fitsRig(c, kind.skinned))) return -1;
    const p = kind.proto;
    i = p.clips.length;
    if (i !== kind.events.length || i !== keys.length) return -1;
    p.clips.push(buildAnimationClip(c, kind.skinned.skeleton));
    p.clipData.push(c);
    kind.events.push(readClipEvents(this.pkgs.get(ref.pkg)?.adu, c.id));
    kind.speeds.push(clipSpeed(c));
    keys.push(k);
    this.refs.set(kind.key, keys);
    return i;
  }

  /**
   * Height range (model units, origin-relative) of the rig's joints at the start of a clip,
   * posed as the engine samples it (rotation-only tracks at their constant translation).
   */
  jointRange(kind: CreatureKind, clip: number): { minY: number; maxY: number } {
    const data = kind.proto.clipData[clip];
    const skel = kind.skinned.skeleton;
    const local = skel.bones.map((b) => ({ p: new THREE.Vector3(...b.position), q: new THREE.Quaternion(...b.quaternion) }));
    for (const t of data?.tracks ?? []) {
      const bi = skel.byHash.get(t.boneHash);
      if (bi === undefined || !t.times.length) continue;
      local[bi].q.fromArray(t.rotations, 0);
      if (t.translations) local[bi].p.fromArray(t.translations, 0);
      else local[bi].p.fromArray(t.constantTranslation);
    }
    const world: THREE.Matrix4[] = [];
    const one = new THREE.Vector3(1, 1, 1);
    let minY = Infinity, maxY = -Infinity;
    for (const b of skel.bones) {
      const m = new THREE.Matrix4().compose(local[b.index].p, local[b.index].q, one);
      world[b.index] = b.parent >= 0 && world[b.parent] ? world[b.parent].clone().multiply(m) : m;
      const y = world[b.index].elements[13];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { minY, maxY };
  }

  all(): CreatureKind[] {
    return [...this.kinds.values()].filter((k): k is CreatureKind => !!k);
  }

  dispose() {
    for (const k of this.all()) k.proto.dispose();
    this.kinds.clear();
  }

  private buildCreature(key: string, template: ResRef, melee?: ResRef): CreatureKind | null {
    const t = readObjectTemplate(this.pkgs, template);
    if (!t?.modelRef) return null;
    const cls = classByHash(t.classHash);
    const skinned = readSkinnedModel(this.pkgs, t.modelRef);
    if (!skinned || !cls) return null;
    const map = resolveCreatureClips(this.pkgs, template, t.modelRef.pkg, skinned.animSet, melee ? new Map([[CHARACTER_MELEE_SLOT, melee]]) : undefined);
    const refs: ClipRef[] = [];
    const add = (r: ClipRef | undefined) => {
      if (!r) return -1;
      let i = refs.findIndex((x) => x.pkg === r.pkg && x.id === r.id);
      if (i < 0) (i = refs.length), refs.push(r);
      return i;
    };
    const idle = add(map.idle);
    const walk = add(map.walk);
    const run = map.run && (map.run.id !== map.walk?.id || map.run.pkg !== map.walk?.pkg) ? add(map.run) : -1;
    const attacks = map.attacks.slice(0, 6).map((a) => ({ clip: add(a.clip), reach: a.reach, minReach: a.minReach ?? 0, maxDy: a.maxDy ?? 0, scaled: !!a.scaled, damage: a.damage, scale: a.scale ?? 1, weaponOnly: !!a.weaponOnly, hitTimes: [] as number[] }));
    const hits = map.hits.slice(0, 4).map(add);
    const deaths = map.deaths.slice(0, 3).map(add);
    const fall = add(map.fall);
    const land = add(map.land);
    const data = refs.map((r) => loadClip(this.pkgs, r)!);
    const vals = decodeTemplateProps(cls, t);
    const maxHealth = typeof vals[1] === 'number' && vals[1] > 0 ? vals[1] : 100;
    const kind = this.finish(key, template, cls.name, skinned, data, {
      idle,
      walk,
      run,
      attacks,
      hits,
      deaths,
      fall,
      land,
      maxHealth,
      refs,
    });
    kind.mover = readMoverVolume(this.pkgs, vals);
    kind.hostile = cls.categoryName === 'Ground Enemy' && !NEUTRAL_CLASSES.has(cls.name) && attacks.length > 0;
    // A Rat has no Melee Weapon and no MeleeAttackBehavior: it hurts only through its leap, and
    // only the player (specials/rat.ts: RatJumpAttack p4 once per rat; a leap at another
    // character ends on his body) [verified]. Its clip attacks stay for the hostility test and
    // deal nothing.
    if (cls.name === 'Rat') for (const a of kind.attacks) (a.damage = 0), (a.weaponOnly = true);
    for (const a of kind.attacks) {
      a.hitTimes = kind.events[a.clip]?.hitTimes.length ? kind.events[a.clip].hitTimes : [data[a.clip].duration * 0.45];
      const adu = this.pkgs.get(refs[a.clip].pkg)?.adu;
      const ev = adu ? readAnimEvents(adu, refs[a.clip].id) : undefined;
      a.windows = ev ? armWindows(ev.events, data[a.clip].duration) : [];
    }
    return kind;
  }

  private finish(
    key: string,
    template: ResRef,
    className: string,
    skinned: SkinnedModel,
    data: AnimClipData[],
    o: Partial<Pick<CreatureKind, 'idle' | 'walk' | 'run' | 'attacks' | 'hits' | 'deaths' | 'fall' | 'land' | 'maxHealth' | 'decor'>> & {
      refs?: ClipRef[];
    },
  ): CreatureKind {
    const proto = new Character(skinned, data, decodeCharacterTextures(skinned, this.pkgs));
    const pos = skinned.model.positions;
    let maxY = -Infinity, minY = Infinity;
    for (let i = 1; i < pos.length; i += 3) (maxY = Math.max(maxY, pos[i])), (minY = Math.min(minY, pos[i]));
    const anchored = minY < -1 || minY > 1;
    const bottom = anchored ? minY : 0;
    const height = Math.min(anchored ? 8 : 4, Math.max(0.3, maxY - bottom));
    const events = data.map((c, i) => readClipEvents(this.pkgs.get(o.refs?.[i]?.pkg ?? template.pkg)?.adu, c.id));
    this.refs.set(key, (o.refs ?? []).map((r) => `${r.pkg}:${r.id}`));
    const speeds = data.map(clipSpeed);
    const walk = o.walk ?? -1;
    return {
      key,
      template,
      className,
      skinned,
      proto,
      idle: o.idle ?? (data.length ? 0 : -1),
      walk,
      run: o.run ?? -1,
      attacks: o.attacks ?? [],
      hits: o.hits ?? [],
      deaths: o.deaths ?? [],
      fall: o.fall ?? -1,
      land: o.land ?? -1,
      events,
      speeds,
      height,
      bottom,
      anchored,
      radius: Math.min(0.6, Math.max(0.25, height * 0.2)),
      moveSpeed: walk >= 0 ? Math.min(5.2, Math.max(1.6, speeds[walk])) : 2.5,
      runSpeed: Math.max(walk >= 0 ? Math.min(5.2, Math.max(1.6, speeds[walk])) : 2.5, (o.run ?? -1) >= 0 ? Math.min(6.5, speeds[o.run!]) : 0),
      hostile: false,
      maxHealth: o.maxHealth ?? 100,
      decor: o.decor ?? false,
    };
  }
}

/**
 * A clip of another animation set made for the same rig: level packages carry scripted clips
 * for shared character rigs under their own set id (1a: the stabbed inmate's death clip 12:107
 * is set 209, his model's set is 52). Most of the rig's bones must be animated by the clip.
 * Tracks for bones the rig lacks do not count against it: clips carry tracks for the weapon /
 * prop bones of other rigs, which bind to nothing (the rig's own set has them too: guard
 * death clip 10:301 has 33 such tracks on the guard rig 10:22). The 1a guard of "Gaurd" #218
 * dies through Behavior Changer 8a21 into DeathBehavior 12:793 with the corpse pose 12:195
 * (set 209, 19 of 78 tracks unbound, 59 of the 64 bones animated) - the pose the sequence
 * left him in; refusing it played the generic standing death 10:301 instead, and the dead
 * guard got up and fell again.
 */
export function fitsRig(c: AnimClipData, skinned: SkinnedModel): boolean {
  const skel = skinned.skeleton;
  const animated = new Set<number>();
  for (const t of c.tracks) if (skel.byHash.has(t.boneHash)) animated.add(t.boneHash);
  return animated.size >= skel.bones.length * 0.9;
}
