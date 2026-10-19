// Weapons in NPC hands (docs/game-logic.md §4.4 / §7.1).
//
// Character templates list their weapons in p52 (Melee / Ranged Weapon templates) and, at the
// same positions, the BONE each one is held by in p51 [data: guards p51 = [35] (the right-hand
// weapon bone) with the guard revolver 10:1802 (model 4:15); Ernesto 10:1020 [35] with the Tommy
// Gun 4:260; CartWheeler [10 15 23 27], Slayer [33 36 39 42 45], ... whose weapons are invisible
// hit volumes (their models have no geometry and are skipped here)]. Instance values override
// the template's (Entity.values); spawned clones use their kind's template.
//
// The models ride the bone like the player's (no offset, model space in the bone frame), are
// shown while the actor's mesh is (the actors system culls / hides it) and hidden while a STOMP
// attach key puts something else on the same bone (the 1a door guard's magazine replaces his
// revolver in the right hand).
//
// Body parts (p54 bones / p55 templates, parallel lists like p51 / p52) are worn the same way.
// The blade-limbed Slayer creature (engine class CartWheeler) ends in a neck stump held by two
// bolt rods; its head is a separate TargetableBreakable model on head bone 18 (10:24 -> model 10:121, 10:1320 -> 10:157,
// 10:1321 -> 10:119, 10:627 -> 10:158), and the guards' caps are Attachments on bone 54 (10:1726
// -> 10:168). Only model-carrying TargetableBreakable / Attachment entries are worn: the other
// p55 kinds are effect generators, projectiles that throw keys attach (BouncingObject, Missile),
// or the class "Slayer" 10:527's Breakable 10:144 (a 5-unit trunk on bone 59, purpose unverified;
// not worn) [data: every Character template, docs/game-logic.md §7.1]. Parts stay on while the
// actor's mesh is shown, except those on `brokenParts` bones (a head shot off: actors/specials/head.ts).
//
// When the sets are in the hand [verified: Character init 0x100e5288 passes p53 and p56 to the set
// object 0x10095d10; the think's spawn 0x100e1f50 -> 0x10096400 creates the p51 / p52 weapons only
// with p53 and the p54 / p55 (and p57 / p58) parts only with p56; the Character message handler
// 0x100e3ab0 runs clip event SpawnWeapons (153) -> 0x100966f0 and SpawnAttachments (154) ->
// 0x10096710, which create those sets whatever p53 / p56 say]: a set is drawn from creation when
// its flag is set, else from the first frame the actor's playing clip crosses its event
// (setSpawnEvents). 1a's guards with p53 = 0 (609f at the office bars, the posed corpses) hold no
// gun; those with p56 = 0 wear no cap. Retail SpawnWeapons events: the dormant creatures' rise
// clips 10:1423 / 10:1778 / 10:1779 (at 0.75 s) and the player's 2:389.
//
// These lists are attachment sets, the same engine mechanism as an Animating Static's p49 / p50
// spawned at creation when its p53 is set (docs/re/object-model.md §7; fx/attachments.ts): the
// caged CartWheelers of 1a / 2 (Animating Static 10:635, model 10:2) wear their Slayer head
// 10:965 on bone 18 that way, dead guards (10:604) their caps / guns. Their worn models are
// built here too (decoration actors), from the same pair list (attachmentPairs) and class set
// (WORN_CLASSES); fx/attachments.ts handles the set's lights and generators and only records
// these, so nothing is built twice.

import * as THREE from 'three/webgpu';
import type { Character } from '../../app/character';
import type { PackageSet, ResRef } from '../../formats/model';
import type { PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { HardpointAttacher } from './hardpoints';
import { buildHeldModel, type HeldModel } from './models';
import { WORN_CLASSES, attachmentPairs } from '../fx/attachments';
import { deathWeaponMode } from '../actors/drops';

export interface NpcLike {
  readonly ch: Character;
  readonly entity?: { values: PropValue[]; family?: string };
  readonly kind: { template: ResRef };
  /** Bones whose body part was broken off (actors/specials/head.ts: a Slayer's shot-off head). */
  readonly brokenParts?: ReadonlySet<number>;
  /** The hand weapons fell out on death (actors/drops.ts): no longer drawn in the hand. */
  readonly weaponDropped?: boolean;
  /** False once dead (a set a SpawnWeapons event put in the hand follows p109 too). */
  readonly alive?: boolean;
}

interface Held {
  actor: NpcLike;
  /** `part`: a p55 body part (always shown with the actor), else a p52 hand weapon. */
  items: { model: HeldModel; bone: number; part?: boolean }[];
  /** The p51 / p52 set is in the hand (p53, or a SpawnWeapons event). */
  weapons: boolean;
  /** The p54 / p55 set is worn (p56, or a SpawnAttachments event). */
  parts: boolean;
  /** Event scan: the clip last seen and its time then. */
  clip?: THREE.AnimationClip;
  t: number;
}

/** Clip event ids that put a set in the hand (Character handler 0x100e3ab0). */
export const SPAWN_WEAPONS_EVENT = 153;
export const SPAWN_ATTACHMENTS_EVENT = 154;

/**
 * Sets in the hand at creation (0x10096400): p51 / p52 when p53 is set, p54 / p55 when p56 is.
 * Characters only; an Animating Static's p49 / p50 set follows its own p53 (animatingStaticWornSlots).
 */
export function npcSpawnedAtCreation(values: readonly PropValue[] | undefined): { weapons: boolean; parts: boolean } {
  const on = (v: PropValue | undefined) => typeof v === 'number' && v !== 0;
  return { weapons: on(values?.[53]), parts: on(values?.[56]) };
}

/** Times (s) of a clip's events with message `id` (kind-1 type-5 events). */
export type ClipEventTimes = (clip: THREE.AnimationClip, ch: Character, id: number) => readonly number[];

/** Did the clip time move across `te` this frame (looping clips wrap)? */
export function crossedEvent(prev: number, t: number, te: number, duration: number, loops: boolean): boolean {
  if (t >= prev) return te > prev && te <= t;
  return loops ? te > prev || te <= t : false;
}

const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in v;
const list = (v: PropValue | undefined): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Character property values (instance values, else its template); undefined for other families. */
function characterValues(pkgs: PackageSet, a: NpcLike): PropValue[] | undefined {
  // p51 / p52 / p54 / p55 have these meanings on the Character classes only (Animating Statics differ).
  if (a.entity && a.entity.family !== 'Character') return undefined;
  if (a.entity) return a.entity.values;
  const t = readObjectTemplate(pkgs, a.kind.template);
  const c = t && classByHash(t.classHash);
  return t && c && c.family === 'Character' ? decodeTemplateProps(c, t) : undefined;
}

/** Worn body-part classes: one set with the Animating Statics' (fx/attachments.ts). */
const BODY_PART_CLASSES = WORN_CLASSES;

/**
 * Worn models of an Animating Static's creation set: p49 bones / p50 templates when p53 is set,
 * entries of WORN_CLASSES that carry a model.
 */
export function animatingStaticWornSlots(pkgs: PackageSet, a: NpcLike): { bone: number; part: ResRef; model: ResRef }[] {
  const e = a.entity as { values: PropValue[]; className?: string } | undefined;
  if (!e || e.className !== 'Animating Static' || !(typeof e.values[53] === 'number' && e.values[53] !== 0)) return [];
  const out: { bone: number; part: ResRef; model: ResRef }[] = [];
  for (const { hp, ref } of attachmentPairs(e.values)) {
    const t = readObjectTemplate(pkgs, ref);
    const c = t && classByHash(t.classHash);
    if (t?.modelRef && c && WORN_CLASSES.has(c.name)) out.push({ bone: hp, part: ref, model: t.modelRef });
  }
  return out;
}

/** p54 bones / p55 body-part templates of a character that carry a model (see the header). */
export function npcBodyPartSlots(pkgs: PackageSet, a: NpcLike): { bone: number; part: ResRef; model: ResRef }[] {
  const v = characterValues(pkgs, a);
  if (!v) return animatingStaticWornSlots(pkgs, a);
  const bones = list(v[54]);
  const out: { bone: number; part: ResRef; model: ResRef }[] = [];
  list(v[55]).forEach((r, i) => {
    const bone = bones[i];
    if (!isRef(r) || typeof bone !== 'number' || bone < 0) return;
    const t = readObjectTemplate(pkgs, r);
    const c = t && classByHash(t.classHash);
    if (t?.modelRef && c && BODY_PART_CLASSES.has(c.name)) out.push({ bone, part: r, model: t.modelRef });
  });
  return out;
}

/** p51 bones / p52 weapon templates of a character (instance values, else its template). */
export function npcWeaponSlots(pkgs: PackageSet, a: NpcLike): { bone: number; weapon: ResRef; model?: ResRef }[] {
  const v = characterValues(pkgs, a);
  if (!v) return [];
  const bones = list(v[51]);
  const weapons = list(v[52]);
  const out: { bone: number; weapon: ResRef; model?: ResRef }[] = [];
  weapons.forEach((w, i) => {
    const bone = bones[i];
    if (!isRef(w) || typeof bone !== 'number' || bone < 0) return;
    const t = readObjectTemplate(pkgs, w);
    const c = t && classByHash(t.classHash);
    if (!t || (c?.name !== 'Ranged Weapon' && c?.name !== 'Melee Weapon')) return;
    out.push({ bone, weapon: w, model: t.modelRef });
  });
  return out;
}

export class NpcWeapons {
  private held = new Map<NpcLike, Held>();

  constructor(
    private readonly pkgs: PackageSet,
    private readonly attacher: HardpointAttacher,
    /** Event times of a playing clip (src/game/weapons/system.ts reads the clips' type-5 events). */
    private readonly eventTimes?: ClipEventTimes,
  ) {}

  /** Build / show / drop the hand weapons of the current actors (after the actors animated). */
  update(actors: readonly NpcLike[]) {
    const live = new Set(actors);
    for (const [a, h] of this.held) if (!live.has(a) || !a.ch.root.parent) this.drop(h);
    for (const a of actors) {
      let h = this.held.get(a);
      if (!h) this.held.set(a, (h = this.build(a)));
      if (!h.weapons || !h.parts) this.scanEvents(a, h);
      if (!h.items.length) continue;
      const shown = a.ch.mesh.visible && a.ch.root.visible;
      for (const it of h.items) {
        if (it.part) {
          it.model.root.visible = shown && !a.brokenParts?.has(it.bone);
          continue;
        }
        const bone = a.ch.skeleton.bones[it.bone];
        // Something else attached to this bone by a sequence takes the hand.
        const busy = !!bone && this.attacher.attachedTo(a.ch).some((o) => o !== it.model.root && this.attacher.boneOf(o) === bone);
        // A hand cut off with its arm takes the gun along (actors/dismember.ts: the hidden bones).
        const dropped = a.weaponDropped || !!a.brokenParts?.has(it.bone) || (a.alive === false && !!a.entity && deathWeaponMode(a.entity.values, h.weapons) !== 'keep');
        it.model.root.visible = shown && !busy && !dropped;
      }
    }
  }

  private build(a: NpcLike): Held {
    const h: Held = { actor: a, items: [], weapons: false, parts: false, t: 0 };
    const values = characterValues(this.pkgs, a);
    // Animating Statics (no Character values) keep their own p53 rule (animatingStaticWornSlots).
    const at = values ? npcSpawnedAtCreation(values) : { weapons: true, parts: true };
    if (at.weapons) this.buildWeapons(a, h);
    if (at.parts) this.buildParts(a, h);
    return h;
  }

  /** SpawnWeapons / SpawnAttachments events of the clip the actor plays now. */
  private scanEvents(a: NpcLike, h: Held) {
    const action = a.ch.current;
    const clip = action?.getClip();
    if (!action || !clip || !this.eventTimes) return;
    if (clip !== h.clip) {
      h.clip = clip;
      h.t = action.time;
      return;
    }
    const t = action.time;
    const loops = action.loop !== THREE.LoopOnce;
    const hit = (id: number) => this.eventTimes!(clip, a.ch, id).some((te) => crossedEvent(h.t, t, te, clip.duration, loops));
    if (!h.weapons && hit(SPAWN_WEAPONS_EVENT)) this.buildWeapons(a, h);
    if (!h.parts && hit(SPAWN_ATTACHMENTS_EVENT)) this.buildParts(a, h);
    h.t = t;
  }

  private buildWeapons(a: NpcLike, h: Held) {
    h.weapons = true;
    for (const s of npcWeaponSlots(this.pkgs, a)) {
      if (!s.model || !a.ch.skeleton.bones[s.bone]) continue;
      const m = buildHeldModel(this.pkgs, s.model);
      if (!m) continue; // creature weapons: hit volumes without geometry
      m.root.name = `npc-weapon ${s.weapon.pkg}:${s.weapon.id}`;
      a.ch.root.add(m.root);
      if (!this.attacher.attach(m.root, a.ch, { bone: s.bone })) {
        m.dispose();
        m.root.removeFromParent();
        continue;
      }
      h.items.push({ model: m, bone: s.bone });
    }
  }

  private buildParts(a: NpcLike, h: Held) {
    h.parts = true;
    for (const s of npcBodyPartSlots(this.pkgs, a)) {
      if (!a.ch.skeleton.bones[s.bone]) continue;
      const m = buildHeldModel(this.pkgs, s.model);
      if (!m) continue;
      m.root.name = `npc-part ${s.part.pkg}:${s.part.id}`;
      a.ch.root.add(m.root);
      if (!this.attacher.attach(m.root, a.ch, { bone: s.bone })) {
        m.dispose();
        m.root.removeFromParent();
        continue;
      }
      h.items.push({ model: m, bone: s.bone, part: true });
    }
  }

  private drop(h: Held) {
    for (const it of h.items) {
      this.attacher.detach(it.model.root);
      it.model.dispose();
      it.model.root.removeFromParent();
    }
    this.held.delete(h.actor);
  }

  /** Weapon models held by an actor (shots leave the first; body parts excluded). */
  of(a: NpcLike): THREE.Object3D[] {
    return this.held.get(a)?.items.filter((i) => !i.part).map((i) => i.model.root) ?? [];
  }

  /** Whether the actor's p51 / p52 set is in its hand (p53 or a SpawnWeapons event). */
  inHand(a: NpcLike): boolean {
    return !!this.held.get(a)?.weapons;
  }

  /** Body-part models (heads, caps) worn by an actor. */
  parts(a: NpcLike): THREE.Object3D[] {
    return this.held.get(a)?.items.filter((i) => i.part).map((i) => i.model.root) ?? [];
  }

  dispose() {
    for (const h of [...this.held.values()]) this.drop(h);
  }
}
