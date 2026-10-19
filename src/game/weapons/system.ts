// Weapons game system: the player's weapons, ammo and throwables, supplies (Xombium bottles,
// flashlight charge), hardpoint attachments (props and weapons in hands, NPC hand weapons),
// projectiles and explosions. Formats and stats: docs/game-logic.md §4.4 / §7.1, data.ts.
//
// ---------------------------------------------------------------------------------------------
// services.weapons (all fields read lazily; HUD contract in src/game/hud/model.ts):
//
//   current: {                         the equipped weapon, null when unarmed
//     id: string                       weapon template "pkg:id" (e.g. "4:5" Revolver)
//     name: string                     display name (template p22 string)
//     icon?: { texture: ResRef; rect: [x, y, w, h] }   HUD atlas cut (Ammo Meter -> HUD Texture)
//     ammoMeter: ResRef | null         HUD Ammo Meter template (Ranged Weapon p89)
//     crosshair: ResRef | null         Player Weapon Properties p7 (HUD Texture)
//     clip: number; clipSize: number   rounds loaded / per clip (0 / 0 for melee)
//     reserve: number                  rounds carried besides the clip
//     ranged: boolean
//   } | null
//   throwable: { id, name, meter: ResRef | null, count } | null   selected throwable (Missile Item p56)
//   weapons: { id, name, kind, slot, order, clip, clipSize, reserve, icon?, current }[]  owned
//   healthPacks: number                Xombium bottles carried
//   flashlight: { on, battery 0..1 }   the renderer's lamp and its charge
//   targeting: boolean                 crosshair over a live enemy
//   busy: boolean                      switching / reloading / attacking
//   enabled / setEnabled(on)           false puts the weapons away (insanity's creature form)
//   equip(id) / next() / prev() / last() / selectSlot(n)
//   fire() (one shot / swing; holding is handled by the mouse input) / reload() / throw()
//   nextThrowable(dir?) / selectThrowable(id)
//   useHealthPack()                    drink a bottle (Health key)
//   storeHealthPack(name, tpl, amount) world.ts pickup hook for Health Bonus Items
//   give(id, amount?)                  add a weapon, ammo item, throwable, supply (template "pkg:id")
//   stow() / unstow() / stowed         weapons away / back (Killjoy Rebirth Effect, fx/rebirth.ts)
//   def(id)                            decoded stats of a weapon / throwable template (data.ts)
//   attach(objectOrModel, actorOrPuppet, hardpointIndex) / detach(obj) / detachHardpoint(c, hp?)
//                                      hardpoints (attach.ts; STOMP attach keys use these)
//   npcWeapons(actor)                  weapon models in an actor's hands (npc.ts)
//
// Inventory: services.inventory (world.ts, world/inventory.ts) stays the item store, keyed by
// item template "pkg:id" (display names are for the HUD: the Killjoy Rebirth grenade 4:804 and
// the Shrapnel Grenade 4:655 share one), and is saved by its own provider ('inventory',
// priority 5). This system wraps its add(): weapon templates are owned once (a second revolver
// adds the Dual Revolvers, Ranged Weapon p67, and its rounds), ammo items are capped at Missile
// Item p44 ("Revolver Ammo" is only their label), throwables / batteries / bottles count up to
// their Item p44. Clip contents, the equipped weapon, the selected throwable and the flashlight
// charge are this system's own save state ('weapons', game scope, priority 30: after the
// inventory), keyed by template too (old name keys are migrated where unambiguous).
//
// Thrown objects and spent casings are BouncingObjects (docs/re/object-model.md §9): bounce
// count / settle rule, bounce sounds by surface hardness and the p64 noise with them.
//
// Damage: every player hit goes through services.damage.apply (world/damage.ts): bullets and
// swings with targetUid (placed actors / clones), `actor` (spawned creatures) or `body` (the
// CollisionWorld ray hit's dynamic body: props); explosions with the Radius Damage falloff
// (radius / innerRadius / minAmount). Damage types are the template numbers (Missile p32,
// Melee Weapon p70, Radius Damage p10). Effects go through fx.ts (services.fx when it runs).
//
// Unarmed: Fire with no weapon plays the unarmed Player Weapon Properties' attack (Player p143 =
// 2:409: p86 Attack 2:376 = strike 2:124 + recovery 2:212, first person p91 2:393 = 2:218 x1.6).
// The original's Arm marker arms the Melee Weapon in the hand (RFL 0x10095750) and the human
// form has none (Player p231 is empty), so its empty-handed swing deals no damage; the port's
// strike hits for UNARMED_DAMAGE x Attack p6 [engine addition], damage type 10 (the shiv's).
//
// Controls (the original's keyboard page lists the actions, not their default keys; see
// docs/game-logic.md §4.4): left mouse Fire, right mouse Throw, R Reload, H Health, mouse wheel
// or ] / [ next / previous weapon, 1..5 weapon slots (Item p37: 1 Shiv / Fire
// Axe, 2 Pistol / Dual Pistols, 3 Shotgun, 4 Tommy Gun, 5 Flamethrower; a second press cycles
// within the slot), 6..0 throwables (Flash/Bang, Shrapnel, TNT, Molotov, Flare), G / T next /
// previous throwable. Q stays the Insanity key (hud/controls.ts). Published in
// services.input.bindings.
//
// Gamepad (src/game/hud/bindings.ts): pad buttons arrive as the same (synthetic) mouse / key
// events, and are accepted without pointer lock while a pad is in use (padPlaying()). Aim
// assist (aim-assist.ts): this system publishes the hostile actors as candidates; when firing,
// a ranged shot goes to the target the bindings layer locked if it is within the weapon's p76
// cone (the decoded fire rule), else along the crosshair.
// ---------------------------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { engineLightMaterial } from '../../app/engine-light';
import { warmObjects, warmViewmodelObjects } from '../../app/prewarm';
import { COLLISION_LAYER } from '../../app/physics';
import type { GameContext, GameSystem } from '../runtime';
import type { PackageSet, ResRef } from '../../formats/model';
import { findEntry } from '../../formats/model';
import type { EntityPackageSet } from '../../formats/entities';
import { ADU_EVENTS, type AnimClipData } from '../../formats/animation';
import { buildAnimationClip, type Character } from '../../app/character';
import { loadClip } from '../actors/clipmap';
import { combatLink } from '../actors/combat';
import type { PlayerBody } from '../actors/player-body';
import { AttachService } from './attach';
import { buildHeldModel, buildStaticModel, flashCards, type HeldModel } from './models';
import { weaponFx } from './fx';
import { NpcWeapons, type NpcLike } from './npc';
import { THROWN_GRAVITY, ammoDef, ammoLabel, bounceHit, bounceSound, explosionDamage, thrownDefOf, flashlightLampOn, holdsFlashlight, keyOf, projectileDamage, readPlayerWeaponProps, templateClass, tpl, weaponDef, type ProjectileDef, type SurfaceProps, type ThrownDef, type WeaponDef } from './data';
import { hudBus } from '../hud/bus';
import { migrateItemKey, registerSave } from '../save/providers';
import { byNameOnce } from '../world/inventory';
import { padPlaying } from '../hud/bindings';
import { aimAssist, shotTarget, withinWeaponCone, type AimProvider } from './aim-assist';
import { HEALTH_HINT_EVENT, canDrinkHealth, healAmount, healthHintDue } from '../../app/player-rules';

// ---------------------------------------------------------------------------
// Services used (all optional)

interface ActorLike {
  /** Level uid (synthetic for clones; undefined for spawned creatures). */
  uid?: number;
  entity?: { uid: number };
  alive: boolean;
  hidden?: boolean;
  radius: number;
  bottom: number;
  height: number;
  position: THREE.Vector3Like;
  kind: { decor?: boolean; template?: { pkg: number; id: number } };
  verticalGap(y: number): number;
  /** Hostility (aim assist targets hostile or provoked actors only). */
  hostile?: boolean;
  provoked?: boolean;
  id?: number;
}
interface ActorsLike {
  list(): readonly (ActorLike & NpcLike)[];
  get(uid: number): { ch: Character } | undefined;
  damage(a: ActorLike, amount: number, from?: THREE.Vector3Like): boolean;
  /** `includeDead` 'cuttable': dead bodies with Part Caps left stop the shot (actors/dismember.ts). */
  raycast(o: THREE.Vector3Like, d: THREE.Vector3Like, max: number, includeDead?: boolean | 'cuttable'): { actor: ActorLike; distance: number; point: THREE.Vector3 } | null;
}
interface DamageLike {
  apply(e: {
    point: THREE.Vector3Like;
    normal?: THREE.Vector3Like;
    amount: number;
    kind?: number | string;
    source?: unknown;
    targetUid?: number;
    body?: number;
    radius?: number;
    innerRadius?: number;
    minAmount?: number;
    actor?: unknown;
    dir?: THREE.Vector3Like;
  }): { hits: { uid: number; kind: string; damage: number; killed: boolean }[] };
}
interface InventoryLike {
  /** Entries by item template "pkg:id" (world/inventory.ts). */
  readonly items: Map<string, { name: string; count: number; template?: ResRef; className?: string }>;
  add(name: string, count: number, template?: ResRef, className?: string): void;
  remove?(item: ResRef | string, n?: number): number;
}
interface WorldLike {
  readonly inCutscene?: boolean;
}

// ---------------------------------------------------------------------------
// State carried across levels (like the world's inventory) and saved

interface Persist {
  clips: Record<string, number>;
  current: string | null;
  last: string | null;
  throwable: string | null;
  /** Flashlight charge 0..1. */
  battery?: number;
}
const persist: Persist = { clips: {}, current: null, last: null, throwable: null, battery: 1 };

const MELEE_REACH = 2.1; // Player template p96 [guess]
/** Engine addition: an empty-handed strike's damage before the Attack p6 scale (see the header). */
const UNARMED_DAMAGE = 2;
/** Damage type of the unarmed strike (the shiv's Melee Weapon p70). */
const UNARMED_TYPE = 10;
const MELEE_CONE = Math.cos((55 * Math.PI) / 180);
const MAX_RANGE = 200;
const UP = new THREE.Vector3(0, 1, 0);
/** Throw clip of the unarmed / revolver set (Player Weapon Properties 2:436 p108). */
const DEFAULT_PWP: ResRef = { pkg: 2, id: 436 };
/** Player template (unarmed Player Weapon Properties p143). */
const PLAYER_TEMPLATE: ResRef = { pkg: 2, id: 5 };

/**
 * Number keys. The original's keyboard page (Control Settings GUI 5:906 p30) has one action per
 * weapon in this order - Shiv, Fire Axe, Pistol, Dual Pistols, Shotgun, Tommy Gun, Flamethrower -
 * then Flash/Bang, Shrapnel, TNT, Molotov (and Flare next to Flashlight); its default keys are not
 * in the data. The port gives each weapon slot (Item p37) a digit in that order (a second press
 * cycles within the slot: Shiv / Fire Axe, Revolver / Dual Revolvers) and the throwables 6..0.
 */
const WEAPON_KEYS: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
/** Throwable templates per digit: Flash/Bang 4:284, Shrapnel 4:655, TNT 4:236, Molotov 4:249, Flare 4:455. */
const THROWN_KEYS: Record<string, string> = { '6': '4:284', '7': '4:655', '8': '4:236', '9': '4:249', '0': '4:455' };

const refOf = (k: string): ResRef => {
  const [pkg, id] = k.split(':').map(Number);
  return { pkg, id };
};

/** Animation markers (.adu type 5, kind 1): message id + time (s). */
export function clipMarks(pkgs: PackageSet, r: ResRef): { time: number; param: number }[] {
  const adu = pkgs.get(r.pkg)?.adu;
  const e = adu && findEntry(adu, ADU_EVENTS, r.id);
  if (!adu || !e || e.size < 4) return [];
  const v = adu.data(e);
  const n = v.getUint32(0, true);
  const out: { time: number; param: number }[] = [];
  for (let i = 0; i < n && 4 + 16 * i + 16 <= v.byteLength; i++) {
    const o = 4 + 16 * i;
    if (v.getUint32(o, true) === 1) out.push({ time: v.getFloat32(o + 4, true), param: v.getUint32(o + 12, true) });
  }
  return out;
}

interface Shot {
  weapon: WeaponDef;
  def: ProjectileDef;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  travelled: number;
  tracer: THREE.Mesh;
  age: number;
}
interface Thrown {
  /** The player's throwable (none for an NPC's throw). */
  def?: WeaponDef;
  /** Who threw it (an NPC: the damage's source, and its own body does not stop it). */
  by?: ActorLike;
  age?: number;
  /** The BouncingObject (the throwable's p55, or a casing generator's object). */
  td: ThrownDef;
  /** A spent casing (no detonation, no creature test). */
  casing?: boolean;
  mesh: THREE.Object3D;
  vel: THREE.Vector3;
  fuse: number;
  rest: boolean;
  /** Bounces counted so far (BouncingObject p49 / p50). */
  bounces?: number;
}
interface Effect {
  obj: THREE.Object3D;
  life: number;
  max: number;
  kind: 'flash' | 'blood' | 'dust' | 'decal' | 'casing' | 'boom' | 'light';
  vel?: THREE.Vector3;
}

export async function createWeaponsSystem(ctx: GameContext): Promise<GameSystem> {
  const pkgs = ctx.loaded.packages as PackageSet | undefined;
  if (!pkgs) return { name: 'weapons (no packages)' };
  const epk = pkgs as EntityPackageSet;
  const { view, audio } = ctx;
  const actors = () => ctx.services.actors as ActorsLike | undefined;
  const damageSvc = () => ctx.services.damage as DamageLike | undefined;
  // Effects (impacts, explosions, muzzle flashes) go through one helper (fx.ts).
  const fx = weaponFx(ctx.services);
  // Placed effect emitters hang on bones through the world fx's stand-ins (world/fx.ts anchor).
  const attach = new AttachService(pkgs, view.scene, actors, (uid) => (ctx.services.world as { fx?: { anchor?(uid: number): THREE.Object3D | undefined } } | undefined)?.fx?.anchor?.(uid));

  // -------------------------------------------------------------------------
  // Inventory routing

  const inv = ctx.services.inventory as InventoryLike | undefined;
  const items = (): InventoryLike['items'] => inv?.items ?? new Map();
  const countOf = (r: ResRef | undefined) => {
    if (!r) return 0;
    let n = 0;
    for (const it of items().values()) if (it.template && it.template.pkg === r.pkg && it.template.id === r.id) n += it.count;
    return n;
  };
  const consume = (r: ResRef, n: number) => {
    for (const it of items().values()) {
      if (n <= 0) break;
      if (!it.template || it.template.pkg !== r.pkg || it.template.id !== r.id || it.count <= 0) continue;
      const k = Math.min(n, it.count);
      it.count -= k;
      n -= k;
    }
  };
  const ammoName = (r: ResRef, hint: string) => {
    for (const it of items().values()) if (it.template && it.template.pkg === r.pkg && it.template.id === r.id) return it.name;
    return (/^Item \d/.test(hint) ? ammoLabel(epk, r) : undefined) ?? (hint.replace(/\s+\d+$/, '') || `Ammo ${keyOf(r)}`);
  };
  const owned = (def: WeaponDef) => countOf(def.template) > 0;
  let pendingEquip: string | null = null;
  let current: WeaponDef | null = null;
  /** Item templates by display name (old name-keyed saves only). */
  const byName = byNameOnce(epk);
  /** Weapon / throwable put away by stow() (the Killjoy Rebirth Effect), see stow(). */
  let stowed: { weapon: string | null; throwable: string | null } | null = null;

  const hudPickup = (text: string) => (ctx.services.hud as { pickup?(t: string): void } | undefined)?.pickup?.(text);
  const itemCap = (r: ResRef) => {
    const t = tpl(epk, r);
    return t && (t.cls === 'Item' || t.cls === 'Health Bonus Item') && typeof t.v[44] === 'number' ? (t.v[44] as number) : 0;
  };
  let origAdd: InventoryLike['add'] | undefined;
  const addAmmo = (r: ResRef, n: number, hint: string) => {
    const a = ammoDef(epk, r);
    const room = Math.max(0, (a?.maxCarry ?? 999) - countOf(r));
    if (room > 0 && origAdd) origAdd(ammoName(r, hint), Math.min(n, room), r, templateClass(epk, r));
  };
  if (inv) {
    const raw = (origAdd = inv.add.bind(inv));
    inv.add = (name, count, template, className) => {
      const def = template && weaponDef(epk, template);
      if (def && def.kind !== 'throwable') {
        if (!owned(def)) {
          raw(def.name, 1, template, className ?? def.className);
          if (def.kind === 'ranged') {
            // A picked-up gun holds p70 rounds: a clip's worth loaded, the rest carried
            // (the shotgun's 21 = 7 + 14).
            persist.clips[def.key] = Math.min(def.clipSize, def.startAmmo);
            if (def.ammo && def.startAmmo > def.clipSize) addAmmo(def.ammo, def.startAmmo - def.clipSize, `${def.name} Ammo`);
          }
          // Equip a new weapon when unarmed or when it ranks higher (Item p38).
          if (count > 0 && (!current || def.order > current.order)) pendingEquip = def.key;
        } else {
          if (def.ammo && def.startAmmo > 0) addAmmo(def.ammo, def.startAmmo, `${def.name} Ammo`);
          const up = def.upgrade && weaponDef(epk, def.upgrade);
          if (def.upgrade && up && !owned(up)) hudPickup(up.name);
          if (def.upgrade) inv.add(def.name, 1, def.upgrade);
        }
        return;
      }
      if (def && def.kind === 'throwable') {
        const room = Math.max(0, (def.maxCarry || 99) - countOf(template));
        if (room > 0) raw(def.name, Math.min(count, room), template, className ?? def.className);
        if (!persist.throwable) persist.throwable = def.key;
        return;
      }
      if (template && ammoDef(epk, template)) return addAmmo(template, count, name);
      // Flashlight pickups (class Flashlight, 4:72) recharge the lamp [guess].
      if (className === 'Flashlight' || (template && templateClass(epk, template) === 'Flashlight')) persist.battery = 1;
      // Carried supplies with a cap (Item p44): flashlight batteries (9), Xombium bottles (9).
      const cap = template ? itemCap(template) : 0;
      if (cap > 0) {
        const room = Math.max(0, cap - countOf(template));
        if (room > 0) raw(name, Math.min(count, room), template, className);
        return;
      }
      raw(name, count, template, className);
    };
  }

  // -------------------------------------------------------------------------
  // Player body / clips

  const body = (): PlayerBody | null => combatLink.body;
  const clipCache = new Map<string, AnimClipData | null>();
  const clipData = (r: ResRef | null | undefined): AnimClipData | undefined => {
    if (!r) return undefined;
    const k = keyOf(r);
    if (!clipCache.has(k)) clipCache.set(k, loadClip(pkgs, r) ?? null);
    return clipCache.get(k) ?? undefined;
  };
  const clipIndex = (r: ResRef | null | undefined) => {
    const b = body();
    const d = clipData(r);
    return b && d && d.animSet === b.body.skinned.animSet ? b.addClip(d) : -1;
  };

  // Held models (third person on the body, first person on the arms in the viewmodel pass).
  interface Held {
    def: WeaponDef;
    tp: HeldModel[];
    fp: HeldModel[];
  }
  let held: Held | null = null;
  const dropHeld = () => {
    if (!held) return;
    for (const m of [...held.tp, ...held.fp]) {
      attach.attacher.detach(m.root);
      m.dispose();
      m.root.removeFromParent();
    }
    held = null;
  };
  const showHeld = (def: WeaponDef | null) => {
    dropHeld();
    const b = body();
    if (!def || !b || !def.model || !def.pwp) return;
    // Dual revolvers: the second Player Weapon Properties (p66) holds the left hand's bone.
    const pwp2 = def.kind === 'ranged' ? readPlayerWeaponProps(epk, tpl(epk, def.template)?.v[66] as ResRef | undefined) : undefined;
    const hands = [def.pwp.handBone, ...(pwp2 ? [pwp2.handBone] : [])].filter((x) => x >= 0);
    const h: Held = { def, tp: [], fp: [] };
    for (const bone of hands) {
      const tp = buildHeldModel(pkgs, def.model);
      if (tp) {
        b.body.root.add(tp.root);
        attach.attacher.attach(tp.root, b.body, { bone });
        h.tp.push(tp);
      }
      if (b.arms) {
        const fp = buildHeldModel(pkgs, def.model);
        if (fp) {
          b.armsPivot.add(fp.root);
          attach.attacher.attach(fp.root, b.arms, { bone });
          h.fp.push(fp);
        }
      }
    }
    for (const m of [...h.tp, ...h.fp]) m.root.visible = enabled;
    held = h;
  };

  // -------------------------------------------------------------------------
  // Weapon state

  let cooldown = 0;
  let action: { kind: 'reload' | 'switch' | 'throw'; until: number; then?: () => void } | null = null;
  const timers: { at: number; fn: () => void }[] = [];
  let clock = 0;
  let combo = 0;
  /** Dual Revolvers: the next shot uses the second hand set (p66). */
  let altHand = false;
  let comboUntil = 0;
  let fireHeld = false;
  let targeting = false;

  const after = (s: number, fn: () => void) => timers.push({ at: clock + s, fn });
  const busy = () => !!action && clock < action.until;

  const play = (keys: string[], pos?: THREE.Vector3Like, volume = 1) => {
    const ok = keys.filter((k) => audio.get(k));
    if (!ok.length) return;
    const k = ok[Math.floor(Math.random() * ok.length)];
    if (pos) audio.play3D(k, [pos.x, pos.y, pos.z], { volume, bus: 'sfx' });
    else audio.play(k, { volume, bus: 'sfx' });
  };

  const defsOfKind = (pred: (d: WeaponDef) => boolean): WeaponDef[] => {
    const out: WeaponDef[] = [];
    for (const it of items().values()) {
      if (!it.template || it.count <= 0) continue;
      const d = weaponDef(epk, it.template);
      if (d && pred(d) && !out.includes(d)) out.push(d);
    }
    return out.sort((a, b) => a.order - b.order);
  };
  const ownedWeapons = () => defsOfKind((d) => d.kind !== 'throwable');
  const ownedThrowables = () => defsOfKind((d) => d.kind === 'throwable');
  const clipOf = (d: WeaponDef) => persist.clips[d.key] ?? 0;
  const reserveOf = (d: WeaponDef) => countOf(d.ammo);

  const setStance = (def: WeaponDef | null) => {
    const b = body();
    if (!b) return;
    const p = def?.pwp;
    if (!p) return b.setStance(null, null);
    const v = tpl(epk, p.ref)!.v;
    const r = (i: number) => v[i] as ResRef | null | undefined;
    // Weapon-ready idle (p61). The Dual Revolvers' first set names its reload clip there (2:127,
    // hands crossing to reload, looped forever in first person); the second set (p66) holds
    // the held two-gun aim (2:484).
    const same = (a?: ResRef, c?: ResRef) => !!a && !!c && a.pkg === c.pkg && a.id === c.id;
    const pwp2 = def.kind === 'ranged' ? readPlayerWeaponProps(epk, tpl(epk, def.template)?.v[66] as ResRef | undefined) : undefined;
    const ready = same(p.ready, p.reload) ? (pwp2?.ready && !same(pwp2.ready, pwp2.reload) ? pwp2.ready : p.idle) : p.ready;
    // Player Weapon Properties p17..p36: 4 x (heading, walk clip, walk speed, run clip, run speed).
    // First person: the p61..p84 sets of the weapon's p66 set when it has one (the original's
    // clip set, player +0x3ec), else p65 (PlayerBody.setFirstPerson).
    b.setStance({
      idle: clipIndex(ready ?? p.idle),
      walk: clipIndex(r(18)),
      run: clipIndex(r(20)),
      right: clipIndex(r(25)),
      back: clipIndex(r(28)),
      left: clipIndex(r(35)),
    }, p.ref, pwp2?.ref ?? p.ref);
  };

  const equip = (key: string | null, opts: { instant?: boolean } = {}) => {
    const def = key ? weaponDef(epk, refOf(key)) : undefined;
    if (key && (!def || !owned(def))) return false;
    if ((def ?? null) === current) return true;
    if (busy() && !opts.instant) return false;
    if (current) persist.last = current.key;
    current = def ?? null;
    persist.current = current?.key ?? null;
    showHeld(current);
    setStance(current);
    combo = 0;
    if (current?.pwp?.draw && !opts.instant) {
      // Draw: PWP p172..p174 by view / movement, an independent layer on bone p6 (PlayerBody.weaponAction).
      const dur = body()?.weaponAction('draw', current.pwp.ref, { interruptible: true }) ?? 0;
      action = { kind: 'switch', until: clock + Math.min(dur, 0.6) };
    }
    return true;
  };

  const cycle = (dir: 1 | -1) => {
    const list = ownedWeapons();
    if (!list.length) return;
    const i = current ? list.indexOf(current) : -1;
    equip(list[(i + dir + list.length) % list.length].key);
  };
  const selectSlot = (slot: number) => {
    const list = ownedWeapons().filter((d) => d.slot === slot);
    if (!list.length) return;
    const i = current ? list.indexOf(current) : -1;
    equip(list[(i + 1) % list.length].key);
  };

  // -------------------------------------------------------------------------
  // Aim

  const tmpV = new THREE.Vector3();
  const camPos = () => view.camera.getWorldPosition(new THREE.Vector3());
  const camDir = () => view.camera.getWorldDirection(new THREE.Vector3());
  /** Point under the crosshair (world or actor), else far along the view. */
  const aimPoint = () => {
    const o = camPos(), d = camDir();
    const w = view.collision?.raycast(o.x, o.y, o.z, d.x, d.y, d.z, MAX_RANGE);
    const a = actors()?.raycast(o, d, w ? w.distance : MAX_RANGE);
    return o.addScaledVector(d, a ? a.distance : w ? w.distance : MAX_RANGE);
  };
  // Aim-assist candidates for gamepad play (the bindings layer picks the target each frame).
  // Auto-target priority = the character template's p128 (creatures 10 / 5, humans 1, bosses 0;
  // instance overrides are not applied) and the search range = the held Ranged Weapon's Player
  // Weapon Properties p10 (docs/re/player.md 3.1-3.2).
  const priorityCache = new Map<string, number>();
  const priorityOf = (a: ActorLike): number => {
    const r = a.kind.template;
    if (!r) return 10;
    const k = keyOf(r);
    let v = priorityCache.get(k);
    if (v === undefined) {
      const n = tpl(epk, r)?.v[128];
      v = typeof n === 'number' && Number.isFinite(n) ? n : 10;
      priorityCache.set(k, v);
    }
    return v;
  };
  const rangeCache = new Map<string, number>();
  const aimProvider: AimProvider = {
    eye: () => camPos(),
    range: () => {
      const def = current;
      if (!def || def.kind !== 'ranged') return 0;
      const r = def.pwp?.ref;
      if (!r) return 45;
      const k = keyOf(r);
      let v = rangeCache.get(k);
      if (v === undefined) {
        const n = tpl(epk, r)?.v[10];
        v = typeof n === 'number' && Number.isFinite(n) ? n : 45;
        rangeCache.set(k, v);
      }
      return v;
    },
    candidates: () =>
      (actors()?.list() ?? [])
        .filter((a) => a.alive && (a.hostile || a.provoked) && !a.kind.decor && !a.hidden)
        .map((a) => ({ x: a.position.x, y: a.bottom + a.height * 0.6, z: a.position.z, radius: a.radius, id: a.id ?? a.uid ?? 0, priority: priorityOf(a) })),
    blocked: (e, p) => {
      const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-3) return false;
      const w = view.collision?.raycast(e.x, e.y, e.z, dx / d, dy / d, dz / d, d);
      return !!w && w.distance < d - 0.3;
    },
  };
  aimAssist.provider = aimProvider;
  const heldModel = () => (held ? (view.player.mode === 'fp' ? held.fp[0] : undefined) ?? held.tp[0] : undefined);
  const muzzle = (): THREE.Vector3 | undefined => {
    const m = heldModel();
    if (!m || !current) return undefined;
    const b = m.bone(current.muzzleBone);
    b.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  };
  const spreadDir = (d: THREE.Vector3, deg: number) => {
    if (deg <= 0) return d.clone();
    const a = (deg * Math.PI) / 180;
    const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(d, u);
    const r = Math.sqrt(Math.random()) * a, phi = Math.random() * Math.PI * 2;
    return d.clone().multiplyScalar(Math.cos(r)).addScaledVector(u, Math.sin(r) * Math.cos(phi)).addScaledVector(v, Math.sin(r) * Math.sin(phi)).normalize();
  };

  // -------------------------------------------------------------------------
  // Effects

  const effects: Effect[] = [];
  const fxGroup = new THREE.Group();
  fxGroup.name = 'weapons-fx';
  view.scene.add(fxGroup);
  const sphere = new THREE.SphereGeometry(1, 6, 4);
  const matBlood = new THREE.MeshBasicNodeMaterial({ color: 0x6a0a06, transparent: true, depthWrite: false });
  const matDust = new THREE.MeshBasicNodeMaterial({ color: 0x8a8070, transparent: true, depthWrite: false });
  const matTracer = new THREE.MeshBasicNodeMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
  const matBoom = new THREE.MeshBasicNodeMaterial({ color: 0xffa040, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
  const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 4, 1, true).rotateX(Math.PI / 2);
  const flashLight = new THREE.PointLight(0xffd9a0, 0, 9, 1.5);
  const casingGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.025, 6).rotateZ(Math.PI / 2);
  // Engine-lit like every dynamic object (three.js's light list is off: renderer.ts).
  const matBrass = engineLightMaterial(new THREE.MeshStandardNodeMaterial({ color: 0xb08d3c, metalness: 0.8, roughness: 0.35 }), { precomputed: false });
  view.scene.add(flashLight);

  const addEffect = (obj: THREE.Object3D, max: number, kind: Effect['kind'], vel?: THREE.Vector3, parent: THREE.Object3D = fxGroup) => {
    parent.add(obj);
    effects.push({ obj, life: 0, max, kind, vel });
  };
  const puffs = (at: THREE.Vector3, flesh: boolean) => {
    for (let i = 0; i < (flesh ? 6 : 3); i++) {
      const m = new THREE.Mesh(sphere, flesh ? matBlood : matDust);
      m.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2));
      m.scale.setScalar(0.025 + Math.random() * 0.035);
      addEffect(m, 0.35 + Math.random() * 0.25, flesh ? 'blood' : 'dust', new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 1.5, (Math.random() - 0.5) * 1.2));
    }
  };

  // Muzzle flash (Muzzle Flash template: random model of p0, shown p1 seconds) on the flash bone:
  // the FX system's Muzzle Flash spawner when it runs, else the cards drawn here. The extra
  // muzzle generator (p82, shotgun smoke) goes to whatever effects runtime exists.
  const muzzleFlash = (def: WeaponDef) => {
    const mf = def.muzzleFlash;
    if (held && mf) {
      for (const m of [held.fp[0], held.tp[0]]) {
        if (!m) continue;
        if (fx.muzzleFlash(mf.template, m.bone(def.flashBone))) continue;
        if (!mf.models.length) continue;
        const r = mf.models[Math.floor(Math.random() * mf.models.length)];
        const g = buildStaticModel(pkgs, r, { additive: true }) ?? flashCards(pkgs, r);
        g.rotation.x = Math.random() * Math.PI * 2;
        addEffect(g, Math.max(0.05, mf.duration), 'flash', undefined, m.bone(def.flashBone));
      }
    }
    const p = muzzle();
    if (p) flashLight.position.copy(p);
    flashLight.intensity = 30;
    if (p && def.muzzleGen) fx.spawn(def.muzzleGen, p, camDir());
  };

  // Spent casing (casing generator's BouncingObject model) from the casing bone.
  const ejectCasing = (def: WeaponDef) => {
    const m = heldModel();
    if (!def.casing || !m) return;
    const b = m.bone(def.casingBone);
    b.updateWorldMatrix(true, false);
    // The casing models use the face layout model.ts can't read yet: a small brass cylinder.
    const g = buildStaticModel(pkgs, def.casing) ?? new THREE.Mesh(casingGeo, matBrass);
    g.position.setFromMatrixPosition(b.matrixWorld);
    const right = new THREE.Vector3(Math.cos(view.player.yaw), 0, -Math.sin(view.player.yaw));
    const vel = right.multiplyScalar(1.5 + Math.random()).add(new THREE.Vector3(0, 2, 0));
    // The casing generator's BouncingObject (p86 -> 4:64 / 4:87 / 4:664) bounces like a thrown
    // one and clinks on each bounce (p62 / p63); it goes p54 s after settling, or after p12.
    const td = def.casingObject;
    if (!td) return addEffect(g, 1.2, 'casing', vel);
    fxGroup.add(g);
    thrown.push({ def, td, casing: true, mesh: g, vel, fuse: td.fuse || 1.2, rest: false });
  };

  // Wall impacts: the projectile's Missile Material Effects entry (p0 Material Type, p1 sounds,
  // p3 FX generator, p6 Decal) for the surface hit when the FX system can tell the surface,
  // else the first entry with sounds and a decal.
  interface WallFx {
    sounds: string[];
    gen?: ResRef;
    decal?: ResRef;
    decalModel?: ResRef;
  }
  const wallFx = new Map<string, WallFx>();
  const wallEntry = (r: ResRef): WallFx | undefined => {
    const t = tpl(epk, r);
    if (!t) return undefined;
    const sounds = (Array.isArray(t.v[1]) ? t.v[1] : []).filter((x): x is ResRef => !!x && typeof x === 'object').map(keyOf);
    const decal = (t.v[6] as ResRef | null) ?? undefined;
    return { sounds, gen: (t.v[3] as ResRef | null) ?? undefined, decal, decalModel: tpl(epk, decal)?.model };
  };
  const wallEffect = (p: ProjectileDef, surface?: string | null) => {
    // (surface: a Material Type key; the FX system's impact() does this lookup when it runs)
    const k = `${keyOf(p.template)}|${surface ?? ''}`;
    if (!wallFx.has(k)) {
      let pick: WallFx = { sounds: [] };
      if (surface) {
        for (const r of p.materialFx) {
          const t = tpl(epk, r);
          const mt = t?.v[0] as ResRef | null | undefined;
          if (mt && typeof mt === 'object' && keyOf(mt) === surface) {
            pick = wallEntry(r) ?? pick;
            break;
          }
        }
      }
      if (!pick.sounds.length) {
        for (const r of p.materialFx) {
          const e = wallEntry(r);
          if (e && e.sounds.length && e.decalModel) {
            pick = e;
            break;
          }
        }
      }
      wallFx.set(k, pick);
    }
    return wallFx.get(k)!;
  };

  const decals: THREE.Object3D[] = [];
  const decal = (model: ResRef, point: THREE.Vector3, normal: THREE.Vector3) => {
    const g = buildStaticModel(pkgs, model, { unlit: true });
    if (!g) return;
    g.position.copy(point).addScaledVector(normal, 0.01);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    g.scale.setScalar(0.6);
    addEffect(g, 20, 'decal');
    decals.push(g);
  };

  const hitMarker = (killed: boolean) => {
    hudBus.hitAt = hudBus.clock;
    hudBus.hitKill = killed;
  };

  const hitActor = (a: ActorLike, amount: number, at: THREE.Vector3, kind?: number, dir?: THREE.Vector3, suite?: ResRef) => {
    // Every player hit goes through the world's damage router (services.damage, world/damage.ts:
    // outOnDamaged, kill credit, resistances stay in one place): by uid for placed actors and
    // clones, by the actor object for spawned creatures without one. Only without the router
    // (tests, no world system) straight to the actors system.
    const uid = a.uid ?? a.entity?.uid;
    const dmg = damageSvc();
    let killed: boolean;
    if (dmg) {
      const r = dmg.apply({ point: at, amount, kind, source: view.player.position.clone(), dir, ...(uid !== undefined && actors()?.get(uid) ? { targetUid: uid } : { actor: a }) });
      killed = r.hits.some((h) => h.killed);
    } else killed = actors()?.damage(a, amount, view.player.position) ?? false;
    hitMarker(killed);
    const away = dir ?? at.clone().sub(view.player.position).setY(0).normalize();
    if (!fx.blood(at, away, suite)) puffs(at, true);
    return killed;
  };

  const playHeldClip = (r: ResRef | undefined) => {
    const d = clipData(r);
    if (!d || !held) return;
    for (const m of [...held.fp, ...held.tp]) {
      const ch = m.character;
      if (!ch || d.animSet !== ch.skinned.animSet) continue;
      let i = ch.clipData.indexOf(d);
      if (i < 0) {
        ch.clips.push(buildAnimationClip(d, ch.skinned.skeleton));
        ch.clipData.push(d);
        i = ch.clips.length - 1;
      }
      ch.play(i, { loop: false, fade: 0 });
    }
  };

  // -------------------------------------------------------------------------
  // Firing

  const shots: Shot[] = [];
  // AI noise (docs/game-logic.md §15.8): a Missile's p16 InvestigateSound goes off with the shot,
  // p14 where it hits [data: 2:441 27 m / level 2 and 2:442 20 m / level 1 on the bullets].
  const missileNoise = (p: ProjectileDef, i: 14 | 16): ResRef | undefined => {
    const v = tpl(epk, p.template)?.v[i];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : undefined;
  };
  const aiNoise = (at: THREE.Vector3Like, r: ResRef | undefined) => {
    if (r) (ctx.services.actors as { noise?(at: THREE.Vector3Like, sound: ResRef, source?: 'player'): void } | undefined)?.noise?.(at, r, 'player');
  };
  // Bullets fly through what the eye sees through (cell bars, grates, chain-link):
  // WorldService.seeThrough, the same test the actors' sight uses.
  const solidHit = (o: THREE.Vector3, d: THREE.Vector3, max: number) => {
    const see = (ctx.services.world as { seeThrough?(h: unknown): boolean } | undefined)?.seeThrough;
    let start = 0;
    for (let i = 0; i < 12; i++) {
      const h = view.collision?.raycast(o.x + d.x * start, o.y + d.y * start, o.z + d.z * start, d.x, d.y, d.z, max - start);
      if (!h || !see?.(h)) return h && start ? { ...h, distance: h.distance + start } : h;
      start += h.distance + 1e-3;
      if (start >= max) return null;
    }
    return null;
  };
  const fireRanged = (def: WeaponDef) => {
    const p = def.projectile;
    if (clipOf(def) <= 0) {
      if (reserveOf(def) > 0) reload();
      return false;
    }
    persist.clips[def.key] = clipOf(def) - 1;
    const b = body();
    // Fire: the heading set's clips on PWP bones p1 / p2 as independent layers, also on the whole
    // body when standing (PlayerBody.weaponAction; docs/re/animation.md §2). Two-handed sets
    // (Dual Revolvers: p65 / p66) take turns shot by shot, bones and clips from the same set
    // (0x10029bd0: player +0x98 bit 3, toggled per shot).
    const second = def.kind === 'ranged' ? (tpl(epk, def.template)?.v[66] as ResRef | undefined) : undefined;
    const firePwp = second && typeof second === 'object' && altHand ? second : def.pwp?.ref;
    if (second) altHand = !altHand;
    const dur = (b && firePwp ? b.weaponAction('fire', firePwp, { interruptible: true }) : 0) || 0.3;
    // Refire follows the fire clip (0.27 s revolver, 1.2 s shotgun incl. the pump, 0.1 s tommy gun).
    cooldown = Math.max(def.auto ? 0.08 : 0.2, dur);
    for (const k of def.fireSounds) play([k]);
    if (p) aiNoise(camPos(), missileNoise(p, 16));
    muzzleFlash(def);
    ejectCasing(def);
    playHeldClip(def.weaponFireClip);
    if (!p) return true;
    const eye = camPos();
    // Gamepad aim assist: the decoded fire rule (p76) - shots go to the tracked target when it
    // lies within the weapon's aim-assist cone (src/game/weapons/aim-assist.ts).
    const lock = aimAssist.enabled ? aimAssist.lock : null;
    // Original (0x10028490): with Auto Targeting a ranged shot snaps to the target inside the
    // 1 deg pyramid around the crosshair; p76 only cancels shots the gun can't face.
    const snap = def.kind === 'ranged' ? shotTarget(lock) : null;
    const aim = snap && withinWeaponCone(snap, def.aimCone || 45) ? new THREE.Vector3(snap.target.x, snap.target.y, snap.target.z) : aimPoint();
    let origin = def.fromMuzzle ? muzzle() ?? eye : eye;
    // Never start on the far side of a wall the eye can't see through.
    const toO = tmpV.copy(origin).sub(eye);
    const len = toO.length();
    if (len > 1e-3 && view.collision?.raycast(eye.x, eye.y, eye.z, toO.x / len, toO.y / len, toO.z / len, len)) origin = eye;
    const base = aim.clone().sub(origin);
    if (base.lengthSq() < 0.01) base.copy(camDir());
    base.normalize();
    for (let i = 0; i < p.count; i++) {
      // Pellets spread by the weapon's cone; the shotgun's 0.25 deg would stack its 6 pellets,
      // so multi-projectile shots use at least 3 deg [guess].
      const dir = spreadDir(base, Math.max(def.spread, p.count > 1 ? 3 : 0));
      const tracer = new THREE.Mesh(tracerGeo, matTracer);
      const w = p.tracer?.width ?? 0.02;
      tracer.scale.set(w * 0.5, w * 0.5, Math.max(0.4, (p.tracer?.length ?? 0.15) * 5));
      tracer.position.copy(origin);
      tracer.lookAt(tmpV.copy(origin).add(dir));
      fxGroup.add(tracer);
      shots.push({ weapon: def, def: p, pos: origin.clone(), dir, travelled: 0, tracer, age: 0 });
    }
    return true;
  };

  const updateShots = (dt: number) => {
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.age += dt;
      const step = s.def.speed * dt;
      const o = s.pos;
      const w = solidHit(o, s.dir, step);
      // A body that can still lose a part takes the shot too (Part Caps run on corpses).
      const a = actors()?.raycast(o, s.dir, w ? w.distance : step, 'cuttable');
      if (a) {
        s.travelled += a.distance;
        hitActor(a.actor, projectileDamage(s.def, s.travelled), a.point, s.def.damageType, s.dir, s.weapon.bloodSuite);
      } else if (w) {
        s.travelled += w.distance;
        const point = new THREE.Vector3(...w.point);
        const normal = new THREE.Vector3(...w.normal);
        aiNoise(point, missileNoise(s.def, 14));
        // Surface effects: the FX system picks the Missile Material Effects entry of the surface
        // (sounds, generator, projected decal); without it the first entry here.
        if (!fx.impact(s.def.materialFx, point, normal, w, s.dir)) {
          const wf = wallEffect(s.def);
          play(wf.sounds, point, 0.6);
          if (!fx.spawn(wf.gen, point, normal)) puffs(point, false);
          if (wf.decalModel && w.dynamic === undefined) decal(wf.decalModel, point, normal);
        }
        const r = damageSvc()?.apply({ point, normal, amount: projectileDamage(s.def, s.travelled), kind: s.def.damageType, source: 'player', body: w.dynamic, dir: s.dir });
        if (r?.hits.length) hitMarker(r.hits.some((h) => h.killed));
      } else {
        s.pos.addScaledVector(s.dir, step);
        s.travelled += step;
        s.tracer.position.copy(s.pos);
        if (s.travelled < MAX_RANGE && s.age < 4) continue;
      }
      s.tracer.removeFromParent();
      shots.splice(i, 1);
    }
  };

  // Melee: the Player Weapon Properties combo (Attack templates); damage at the Arm marker.
  interface Strike {
    pwp?: WeaponDef['pwp'];
    swing: string[];
    hit: string[];
    min: number;
    max: number;
    type?: number;
    suite?: ResRef;
    fx: ResRef[];
  }
  const strikeOf = (def: WeaponDef): Strike => ({ pwp: def.pwp, swing: def.swingSounds, hit: def.hitSounds, min: def.damageMin, max: def.damageMax, type: def.damageType, suite: def.bloodSuite, fx: def.meleeFx });
  const unarmed: Strike = {
    pwp: readPlayerWeaponProps(epk, (tpl(epk, PLAYER_TEMPLATE)?.v[143] as ResRef | undefined) ?? undefined),
    swing: [],
    hit: [],
    min: UNARMED_DAMAGE,
    max: UNARMED_DAMAGE,
    type: UNARMED_TYPE,
    fx: [],
  };
  const fireMelee = (st: Strike) => {
    const p = st.pwp;
    // Strike list: p86 in third person, p91 in first person (0x1002a1a7; data.ts fpAttacks).
    const fp = view.player.mode === 'fp' && !!p?.fpAttacks.length;
    const attacks = (fp ? p?.fpAttacks : p?.attacks) ?? [];
    const inCombo = clock < comboUntil;
    const atk = attacks.length ? attacks[inCombo ? combo % attacks.length : 0] : undefined;
    combo = inCombo ? combo + 1 : 1;
    const b = body();
    const idx = atk ? clipIndex(atk.clip) : -1;
    const dur = b && idx >= 0 ? b.playAction(idx) : 0.45;
    const arm = (atk && clipMarks(pkgs, atk.clip).find((m) => m.param === 100)?.time) ?? dur * 0.4;
    const mult = atk?.mult ?? 1;
    play(st.swing, undefined, 0.8);
    after(Math.max(0.05, arm), () => meleeHit(st, mult));
    const rec = atk?.recovery;
    const myCombo = combo;
    if (rec && b) after(dur, () => {
      if (combo === myCombo) b.playAction(clipIndex(rec), { interruptible: true });
    });
    cooldown = Math.max(0.15, dur);
    comboUntil = clock + dur + 0.45;
    lastStrike = { at: clock, unarmed: st === unarmed };
    return true;
  };
  let lastStrike: { at: number; unarmed: boolean } | null = null;

  const meleeHit = (st: Strike, mult: number) => {
    const p = view.player.position;
    const yaw = view.player.yaw;
    const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    const amount = (st.min + Math.random() * (st.max - st.min)) * mult;
    let best: ActorLike | null = null;
    let bestD = Infinity;
    for (const a of actors()?.list() ?? []) {
      if (!a.alive || a.kind.decor || a.hidden) continue;
      const dx = a.position.x - p.x, dz = a.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d - a.radius > MELEE_REACH || a.verticalGap(p.y + 1.0) > 1.0) continue;
      if (d > 0.3 && (dx * fwdX + dz * fwdZ) / d < MELEE_CONE) continue;
      const len = Math.max(d, 1e-3);
      const wall = view.collision?.raycast(p.x, p.y + 1.2, p.z, dx / len, 0, dz / len, len);
      if (wall && wall.distance < d - a.radius) continue;
      if (d - a.radius < bestD) (bestD = d - a.radius), (best = a);
    }
    if (best) {
      const at = new THREE.Vector3(best.position.x, best.bottom + best.height * 0.6, best.position.z);
      play(st.hit, at);
      hitActor(best, amount, at, st.type, undefined, st.suite);
      return;
    }
    // Props in reach (breakables): the world's damage router.
    const o = camPos(), d = camDir();
    const w = view.collision?.raycast(o.x, o.y, o.z, d.x, d.y, d.z, MELEE_REACH + 0.4);
    const dmg = damageSvc();
    if (w) {
      const point = new THREE.Vector3(...w.point);
      const normal = new THREE.Vector3(...w.normal);
      const r = dmg?.apply({ point, normal, amount, kind: st.type, source: 'player', body: w.dynamic, dir: d });
      // Wall / prop hit effects: the Melee Weapon Material Effects (p77) of the surface.
      if (!fx.impact(st.fx, point, normal, w, d)) play(st.hit, point, r?.hits.length ? 1 : 0.5);
      if (r?.hits.length) hitMarker(r.hits.some((h) => h.killed));
    }
  };

  const reload = () => {
    const def = current;
    if (!def || !enabled || def.kind !== 'ranged' || busy() || !def.ammo) return false;
    if (def.clipSize - clipOf(def) <= 0 || reserveOf(def) <= 0) return false;
    const b = body();
    // Reload: PWP p96..p102 by view / heading on bone p3 (PlayerBody.weaponAction).
    const dur = (b && def.pwp ? b.weaponAction('reload', def.pwp.ref) : 0) || 1.5;
    playHeldClip(def.weaponReloadClip);
    action = {
      kind: 'reload',
      until: clock + dur,
      then: () => {
        if (current !== def || !def.ammo) return;
        const n = Math.min(def.clipSize - clipOf(def), reserveOf(def));
        consume(def.ammo, n);
        persist.clips[def.key] = clipOf(def) + n;
      },
    };
    return true;
  };

  const attack = (): boolean => {
    // Held by a creature (Mainliner ride, Nooseman grip): the press is a struggle, no attack.
    if (view.player.attackOverride?.()) return false;
    const def = current;
    if (!enabled || busy() || cooldown > 0 || !combatLink.combat?.alive) return false;
    if (!def) return unarmed.pwp ? fireMelee(unarmed) : false;
    return def.kind === 'melee' ? fireMelee(strikeOf(def)) : fireRanged(def);
  };
  combatLink.attack = () => attack();

  // -------------------------------------------------------------------------
  // Throwables

  const thrown: Thrown[] = [];
  const nextThrowable = (dir: 1 | -1 = 1) => {
    const list = ownedThrowables();
    if (!list.length) return;
    const i = list.findIndex((d) => d.key === persist.throwable);
    persist.throwable = list[(i + dir + list.length) % list.length].key;
  };
  const selectThrowable = (key: string) => {
    if (ownedThrowables().some((d) => d.key === key)) persist.throwable = key;
  };
  const throwSelected = (): boolean => {
    if (view.player.attackOverride?.()) return false;
    const list = ownedThrowables();
    const def = list.find((d) => d.key === persist.throwable) ?? list[0];
    if (!def?.thrown || !enabled || busy() || cooldown > 0 || !combatLink.combat?.alive) return false;
    persist.throwable = def.key;
    const b = body();
    // Throw: PWP p108 / p115 / p122 + 7k by view / heading on bone p4 (PlayerBody.weaponAction).
    // Empty-handed the original's set is Player p143 (0x1003db3b), as for the strikes.
    const dur = (b ? b.weaponAction('throw', current?.pwp?.ref ?? unarmed.pwp?.ref ?? DEFAULT_PWP) : 0) || 1;
    const clip = (b?.lastActionClip ?? current?.pwp?.throw ?? readPlayerWeaponProps(epk, DEFAULT_PWP)?.throw) || undefined;
    const at = (clip && clipMarks(pkgs, clip).find((m) => m.param === 230)?.time) ?? dur * 0.6;
    consume(def.template, 1);
    action = { kind: 'throw', until: clock + dur * 0.9 };
    after(at, () => launch(def));
    return true;
  };

  const launch = (def: WeaponDef) => {
    const t = def.thrown!;
    const model = t.model ?? def.model;
    const mesh: THREE.Object3D = (model && buildStaticModel(pkgs, model)) || new THREE.Mesh(sphere, matDust);
    const o = camPos(), d = camDir();
    mesh.position.copy(o).addScaledVector(d, 0.6).add(new THREE.Vector3(0, -0.15, 0));
    const vel = d.clone().add(new THREE.Vector3(0, 0.25, 0)).normalize().multiplyScalar(t.speed).add(view.player.velocity);
    fxGroup.add(mesh);
    // Flares (no Radius Damage) burn for their fuse time with a red light.
    if (!t.explosion) mesh.add(new THREE.PointLight(0xff3020, 25, 14, 1.5));
    thrown.push({ def, td: t, mesh, vel, fuse: t.fuse, rest: false });
  };

  type Explosion = NonNullable<NonNullable<WeaponDef['thrown']>['explosion']>;
  // Radius Damage (RFL 0x10125c70 [code]): p0 at the centre down to p1 at the radius p5.
  const falloff = (e: Explosion, d: number) => explosionDamage(e, d);

  // The damage service names an attacker by uid ('player' otherwise): an NPC's throw (6's
  // molotovs, 9's Inferna fireballs) is that NPC's, not the player's, so its kills and the
  // companion's "attacked by the player" do not fall on the player.
  const thrownSource = (by?: ActorLike): 'player' | number => (by ? (by.entity?.uid ?? by.uid ?? 0) : 'player');
  const explode = (t: ThrownDef, at: THREE.Vector3, by?: ActorLike) => {
    const e = t.explosion!;
    // Effects: every non-damage part of the detonation generators (fire, particles, Screen
    // Fader, Camera Shake, sounds) through the effects runtime; the damage is applied below.
    let spawned = false;
    for (const g of t.detonate) {
      const gv = tpl(epk, g)?.v[0];
      for (const c of Array.isArray(gv) ? (gv as (ResRef | null)[]) : []) {
        if (!c || tpl(epk, c)?.cls === 'Radius Damage') continue;
        spawned = fx.spawn(c, at, UP) || spawned;
      }
    }
    if (!spawned) {
      const boom = new THREE.Mesh(sphere, matBoom);
      boom.position.copy(at);
      addEffect(boom, 0.35, 'boom');
    }
    const l = new THREE.PointLight(0xffa040, 60, e.outerRadius * 2 + 4, 1.5);
    l.position.copy(at);
    addEffect(l, 0.5, 'light');
    // Radius Damage: p0 at the centre falling linearly to p1 at the radius p5 (innerRadius 0);
    // every one the detonation generators throw applies (zero-damage ones only carry effects).
    const dmg = damageSvc();
    for (const x of t.explosions.length ? t.explosions : [e]) {
      if (x.maxDamage <= 0 && x.minDamage <= 0) continue;
      if (dmg) {
        const r = dmg.apply({ point: at, amount: x.maxDamage, minAmount: x.minDamage, innerRadius: 0, radius: x.outerRadius, kind: x.damageType, source: thrownSource(by) });
        if (r.hits.length) hitMarker(r.hits.some((h) => h.killed));
      } else {
        for (const a of actors()?.list() ?? []) {
          if (!a.alive || a.kind.decor) continue;
          const c = new THREE.Vector3(a.position.x, a.bottom + a.height * 0.5, a.position.z);
          const amt = falloff(x, c.distanceTo(at));
          if (amt > 0) hitActor(a, amt, c, x.damageType);
        }
      }
      // p7: the thrower is hurt by its own explosion (set on every retail throwable). An NPC's
      // throw reaches the player as any blast (through the damage service above).
      const pp = view.player.position;
      const self = x.hurtsOwner && !by ? falloff(x, Math.hypot(pp.x - at.x, pp.y + 1 - at.y, pp.z - at.z)) : 0;
      if (self > 0) combatLink.combat?.damage(self);
    }
  };

  // Surface of a bounce: the hit's Game Material Properties (material template word 0) p2
  // hardness / p4 damping, when the FX system can tell the material.
  const gmpCache = new Map<string, SurfaceProps | null>();
  const surfaceProps = (hit: Parameters<typeof fx.surface>[0]): SurfaceProps | undefined => {
    const k = fx.surface(hit)?.gmp;
    if (!k) return undefined;
    if (!gmpCache.has(k)) {
      const v = tpl(epk, refOf(k))?.v;
      gmpCache.set(k, v ? { hardness: typeof v[2] === 'number' ? v[2] : 0, damping: typeof v[4] === 'number' ? v[4] : 0 } : null);
    }
    return gmpCache.get(k) ?? undefined;
  };

  const updateThrown = (dt: number) => {
    for (let i = thrown.length - 1; i >= 0; i--) {
      const t = thrown[i];
      const td = t.td;
      t.fuse -= dt;
      if (!t.rest) {
        t.vel.y -= THROWN_GRAVITY * (td.gravityPct / 100) * dt;
        const step = t.vel.length() * dt;
        const p = t.mesh.position;
        if (step > 1e-4) {
          const dir = tmpV.copy(t.vel).normalize();
          // Thrown objects are BouncingObjects: Invisible Static Objects with p5 stop them
          // (world/blockers.ts, the projectile layer).
          const col = view.collision;
          const layers = col?.queryLayers ?? 0;
          if (col) col.queryLayers = layers | COLLISION_LAYER.projectile;
          const w = col?.raycast(p.x, p.y, p.z, dir.x, dir.y, dir.z, step + 0.05);
          if (col) col.queryLayers = layers;
          if (w) {
            const n = new THREE.Vector3(...w.normal);
            p.set(w.point[0], w.point[1], w.point[2]).addScaledVector(n, 0.05);
            t.vel.reflect(n).multiplyScalar(td.restitution);
            // BouncingObject bounce rules (RFL 0x1009a8c0 [code], data.ts bounceHit): every hit
            // counts; at p49 it settles when p50 is set or the hit is a floor, else the hit is
            // taken back. A settled grenade detonates p54 s later (the Molotov and the
            // Flash/Bang, p49 = 1 / p54 = 0, on their first impact); the fuse p12 sets them off
            // earlier.
            const r = bounceHit(td, t.bounces ?? 0, n.y);
            t.bounces = r.count;
            if (r.settle) {
              t.rest = true;
              t.vel.set(0, 0, 0);
              // (The flare's detonation generator is its burn: the port keeps burning it for
              // its fuse p12 instead.)
              if (td.explosion || t.casing) t.fuse = Math.min(t.fuse, td.settleDelay);
            } else {
              // A bounce that does not settle plays p62 / p63 (data.ts bounceSound); its p64 AI
              // noise rides on the sound (RFL 0x1009ad02): no sound, no noise. Retail: only the
              // casings (and a few props) have bounce sounds; no throwable has any.
              const snd = bounceSound(td, surfaceProps(w), t.bounces);
              if (snd.keys.length) {
                play(snd.keys, p, snd.volume);
                aiNoise(p, td.bounceNoise);
              }
              if (t.vel.length() < 0.6 && n.y > 0.6) t.rest = true;
            }
          } else p.addScaledVector(t.vel, dt);
          if (t.casing) t.mesh.rotation.z += dt * 15;
          else t.mesh.rotation.x += dt * 8;
        }
        // A creature in the way stops it; p60 sets it off on the spot (grenades, TNT). (Not the
        // NPC that threw it, which it leaves from inside.)
        const a = t.casing ? null : actors()?.raycast(p, tmpV.set(0, -1, 0), 0.01);
        if (a && !(t.by && a.actor === t.by)) {
          t.rest = true;
          if (td.hitDetonates) t.fuse = 0;
        }
      }
      if (t.fuse <= 0) {
        if (td.explosion && !t.casing) explode(td, t.mesh.position.clone(), t.by);
        t.mesh.removeFromParent();
        thrown.splice(i, 1);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Killjoy Rebirth Effect (fx/rebirth.ts, docs/re/object-model.md §8) [verified]: taking hold
  // of the player, the effect puts his weapons away (Player 0x10038a50, remembered in +0x770 /
  // +0x774) and empties the throwing hand (0x10038620, the throwable remembered in +0x77c), so
  // the grenades it then gives become the selected throwable (an item given while that hand is
  // empty goes to it: 0x10039b10 -> 0x10038ca0; the port's rule `!persist.throwable`). Its end
  // takes them out again (0x10039840 weapons, 0x100392d0 throwable).

  const stow = () => {
    if (stowed) return;
    stowed = { weapon: current?.key ?? null, throwable: persist.throwable };
    pendingEquip = null;
    equip(null, { instant: true });
    persist.throwable = null;
  };
  const unstow = () => {
    const s = stowed;
    if (!s) return;
    stowed = null;
    const has = (k: string | null) => !!k && ownedThrowables().some((d) => d.key === k);
    if (has(s.throwable)) persist.throwable = s.throwable;
    else if (!has(persist.throwable)) persist.throwable = ownedThrowables()[0]?.key ?? null;
    if (s.weapon) equip(s.weapon, { instant: true });
  };

  // -------------------------------------------------------------------------
  // Enable / disable (creature form: insanity calls setEnabled(false) while transformed)

  let enabled = true;
  const setEnabled = (on: boolean) => {
    if (enabled === on) return;
    enabled = on;
    fireHeld = false;
    if (!on) {
      action = null;
      timers.length = 0;
    }
    for (const m of held ? [...held.fp, ...held.tp] : []) m.root.visible = on;
  };

  // -------------------------------------------------------------------------
  // Xombium bottles (Health Bonus Item: p55 health restored, p56 Difficulty Modifier 2:642 on it,
  // Item p44 = 9 carried). Picked-up bottles are stored (world.ts asks storeHealthPack) and drunk
  // with the Health key; the HUD shows the count (Player HUD Ammo Meter 5:457).

  const packTemplate: { ref?: ResRef; amount: number; name: string } = { amount: 20, name: 'Xombium Bottle' };
  const healthPackItems = () => [...items().values()].filter((it) => it.className === 'Health Bonus Item' && it.template && it.count > 0);
  const healthPacks = () => healthPackItems().reduce((n, it) => n + it.count, 0);
  const storeHealthPack = (name: string, template: ResRef, amount: number): boolean => {
    if (!origAdd) return false;
    const cap = itemCap(template) || 9;
    if (countOf(template) >= cap) return false; // full: the world leaves it lying (logic.ts pickupRefused)
    packTemplate.ref = template;
    packTemplate.amount = amount;
    packTemplate.name = name;
    origAdd(name, 1, template, 'Health Bonus Item');
    const c = combatLink.combat;
    if (c && healthHintDue('pickup', c.health, c.maxHealth, healthPacks())) healthHint();
    return true;
  };
  const healthHint = () => (ctx.services.insanity as { playerEvent?(n: number): void } | undefined)?.playerEvent?.(HEALTH_HINT_EVENT);
  let lastHealth = NaN;
  // The Health action (docs/re/player.md §8, src/app/player-rules.ts canDrinkHealth / healAmount):
  // the first carried bottle in inventory order, p55 x Difficulty Modifier x the reputation
  // factor (Player p76..p77 over p70..p71), sound Item p46 (p48 is the pickup sound); no clip.
  const playerTpl = tpl(epk, { pkg: 2, id: 5 })?.v;
  const pnum = (i: number, d: number) => (typeof playerTpl?.[i] === 'number' ? (playerTpl[i] as number) : d);
  const useHealthPack = (): boolean => {
    const c = combatLink.combat;
    const it = healthPackItems()[0];
    const ins = ctx.services.insanity as { transformed?: boolean; reputation?: number } | undefined;
    const w = ctx.services.world as { inCutscene?: boolean } | undefined;
    if (!c || !it) return false;
    if (!canDrinkHealth({ alive: c.alive, health: c.health, maxHealth: c.maxHealth, transformed: !!ins?.transformed, scripted: !!w?.inCutscene, bottles: healthPacks() })) return false;
    const v = tpl(epk, it.template)?.v;
    const p55 = typeof v?.[55] === 'number' ? (v[55] as number) : 20;
    const dm = (ctx.services.difficulty as { healScale?(r: ResRef): number } | undefined)?.healScale?.(it.template!) ?? 1;
    const amount = healAmount(p55, dm, ins?.reputation ?? 0, [pnum(70, -150), pnum(71, 150)], [pnum(76, 0.5), pnum(77, 1.5)]);
    it.count -= 1;
    c.heal(amount);
    const snd = v?.[46];
    if (snd && typeof snd === 'object' && !Array.isArray(snd)) play([keyOf(snd as ResRef)]);
    return true;
  };

  // -------------------------------------------------------------------------
  // Flashlight battery (Flashlight 4:72; RFL 0x100142b0 update, 0x10013f30 new battery,
  // 0x10044035 automatic battery use [code], docs/re/properties.md): a charge gives p67 s (105) of
  // full light, then the beam dims over p68 s (3) down to p61 (25 %) and stays there - a dead
  // battery does not switch the lamp off and nothing recharges while it is off. Every frame the
  // lamp is on and dimming or dead, a battery item p69 (4:203) is used if the player has one.
  // The drain is dt / Difficulty Modifier p70. (p62..p66: the scene brightness adapting when
  // the lamp is switched, 60 % / 100 % over 2.9 s on, 5 s off - renderer side, not applied.)

  const flTpl = tpl(epk, { pkg: 4, id: 72 });
  const flNum = (i: number, d: number) => (typeof flTpl?.v[i] === 'number' ? (flTpl.v[i] as number) : d);
  const FL = {
    full: flNum(67, 105),
    dim: flNum(68, 3),
    deadLevel: flNum(61, 0.25),
    battery: (flTpl?.v[69] as ResRef | null) ?? { pkg: 4, id: 203 },
  };
  const FL_TOTAL = Math.max(1, FL.full + FL.dim);
  const lamp = view.flashlight;
  const lampIntensity = lamp.intensity;
  // The charge drains dt / Difficulty Modifier (Flashlight p70 = 4:1414; RFL 0x1001460f):
  // services.difficulty.flashlightDrainScale() = 1 / modifier (2 / 1 / 0.85 / 0.58 -> x0.5 easy,
  // x1 medium, x1.18 hard, x1.72 impossible).
  const drainScale = () => {
    const d = ctx.services.difficulty as { flashlightDrainScale?(r?: ResRef): number } | undefined;
    const k = d?.flashlightDrainScale?.({ pkg: 4, id: 72 });
    return typeof k === 'number' && Number.isFinite(k) && k > 0 ? k : 1;
  };
  // The lamp exists only once the player holds a Flashlight item (data.ts holdsFlashlight): 1a
  // starts without one (the office pickup 0x6978 gives it, switched on); later levels carry it.
  const hasFlashlight = () => holdsFlashlight(items().values(), (r) => templateClass(epk, r));
  view.flashlightAvailable = hasFlashlight;
  /** Held at the previous update (null before the first one: the level's starting state). */
  let hadFlashlight: boolean | null = null;
  const gateFlashlight = () => {
    const held = hasFlashlight();
    lamp.visible = flashlightLampOn(held, hadFlashlight, lamp.visible);
    hadFlashlight = held;
  };
  const updateFlashlight = (dt: number) => {
    gateFlashlight();
    let b = persist.battery ?? 1;
    if (lamp.visible) {
      b = Math.max(0, b - (dt * drainScale()) / FL_TOTAL);
      // Seconds of charge left; the last p68 s are the dimming phase.
      let left = b * FL_TOTAL;
      if (left < FL.dim && countOf(FL.battery) > 0) {
        consume(FL.battery, 1);
        b = 1;
        left = FL_TOTAL;
      }
      const level = left >= FL.dim ? 1 : Math.max(FL.deadLevel, left / Math.max(1e-3, FL.dim));
      lamp.intensity = lampIntensity * level;
    } else lamp.intensity = lampIntensity;
    persist.battery = b;
  };

  // -------------------------------------------------------------------------
  // NPC hand weapons (npc.ts)

  // Clip events that put an NPC's sets in its hand (SpawnWeapons 153 / SpawnAttachments 154,
  // npc.ts): a clip's package by animation set and id (as footsteps.ts keys them), its markers.
  let clipPkgs: Map<string, number> | undefined;
  const clipPkg = (d: AnimClipData): number | undefined => {
    if (!clipPkgs) {
      clipPkgs = new Map();
      for (const [pkg, p] of pkgs as unknown as Map<number, { adu?: { entries: { type: number; id: number; extra: number }[] } }>) {
        for (const e of p.adu?.entries ?? []) if (e.type === 2) clipPkgs.set(`${e.extra}:${e.id}`, pkg);
      }
    }
    return clipPkgs.get(`${d.animSet}:${d.id}`);
  };
  const clipEventCache = new WeakMap<THREE.AnimationClip, { time: number; param: number }[]>();
  const npcEventTimes = (clip: THREE.AnimationClip, ch: Character, id: number): number[] => {
    let marks = clipEventCache.get(clip);
    if (!marks) {
      const d = ch.clipData[ch.clips.indexOf(clip)];
      const pkg = d ? clipPkg(d) : undefined;
      marks = d && pkg !== undefined ? clipMarks(pkgs, { pkg, id: d.id }) : [];
      clipEventCache.set(clip, marks);
    }
    return marks.filter((m) => m.param === id).map((m) => m.time);
  };
  const npcWeapons = new NpcWeapons(pkgs, attach.attacher, npcEventTimes);
  // Held models of the weapons the player has or can pick up in this level, built once hidden
  // so the level's precompile covers their pipelines (src/app/prewarm.ts): the first draw of a
  // held model in the viewmodel pass (no fog: shader variants the scene never uses) stalled the
  // GPU ~300 ms at the pickup (docs/game-logic.md §18). showHeld still builds its own.
  const warmHeld: HeldModel[] = [];
  {
    const seen = new Set<string>();
    const refs: ResRef[] = [];
    for (const it of items().values()) if (it.template) refs.push(it.template);
    const wsv = ctx.services.world as { world?: { of(cls: string): { e: { template: ResRef } }[] } } | undefined;
    for (const w of wsv?.world?.of('Item') ?? []) refs.push(w.e.template);
    for (const r of refs) {
      const d = weaponDef(epk, r);
      if (!d?.model || seen.has(keyOf(d.model))) continue;
      seen.add(keyOf(d.model));
      for (const into of [warmViewmodelObjects, warmObjects]) {
        const m = buildHeldModel(pkgs, d.model);
        if (!m) continue;
        into.add(m.root);
        warmHeld.push(m);
      }
    }
  }
  // Built now for the actors placed in the level (not on the first update), so the load-time
  // pipeline precompile covers their models: compiling them when a guard first came into view
  // hitched that frame (docs/game-logic.md §18).
  {
    const list = actors()?.list();
    if (list) npcWeapons.update(list);
  }

  // -------------------------------------------------------------------------
  // Input

  const dom = view.renderer.domElement;
  const canAct = () => {
    const w = ctx.services.world as WorldLike | undefined;
    // Pointer lock for mouse play; a pad drives the game without it.
    return enabled && (document.pointerLockElement === dom || padPlaying()) && view.walking && !w?.inCutscene && !!combatLink.combat?.alive;
  };
  const onDown = (e: MouseEvent) => {
    if (!canAct()) return;
    if (e.button === 0) {
      fireHeld = true;
      attack();
    } else if (e.button === 2) throwSelected();
  };
  const onUp = (e: MouseEvent) => {
    if (e.button === 0) fireHeld = false;
  };
  // Capture phase: with more than one weapon the wheel switches weapons and does not reach
  // the third-person camera zoom (src/app/player.ts).
  const onWheel = (e: WheelEvent) => {
    if (!canAct() || Math.abs(e.deltaY) < 1 || ownedWeapons().length < 2) return;
    e.stopPropagation();
    cycle(e.deltaY > 0 ? 1 : -1);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    // The Health action is a native binding (src/game/hud/actions.ts -> useHealthPack).
    if (!canAct()) return;
    const m = /^Digit([0-9])$/.exec(e.code);
    if (m && WEAPON_KEYS[m[1]] !== undefined) selectSlot(WEAPON_KEYS[m[1]]);
    else if (m && THROWN_KEYS[m[1]]) selectThrowable(THROWN_KEYS[m[1]]);
    else if (e.code === 'KeyR') reload();
    else if (e.code === 'BracketRight') cycle(1);
    else if (e.code === 'BracketLeft') cycle(-1);
    else if (e.code === 'KeyG') nextThrowable(1);
    else if (e.code === 'KeyT') nextThrowable(-1);
  };
  const onCtx = (e: Event) => e.preventDefault();
  document.addEventListener('mousedown', onDown);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('wheel', onWheel, { passive: true, capture: true });
  window.addEventListener('keydown', onKey);
  dom.addEventListener('contextmenu', onCtx);

  const input = (ctx.services.input ??= {}) as { bindings?: Record<string, string> };
  input.bindings = {
    ...(input.bindings ?? {}),
    Attack: 'Left Mouse',
    Fire: 'Left Mouse',
    Throw: 'Right Mouse',
    Reload: 'R',
    Health: 'H',
    UseHealth: 'H',
    NextWeapon: 'Mouse Wheel Down / ]',
    PrevWeapon: 'Mouse Wheel Up / [',
    NextThrown: 'G',
    PrevThrown: 'T',
    Shiv: '1',
    FireAxe: '1',
    Pistol: '2',
    DualPistols: '2',
    Shotgun: '3',
    TommyGun: '4',
    Flamethrower: '5',
    FlashBangGrenade: '6',
    ShrapnelGrenade: '7',
    TNT: '8',
    MolotovCocktail: '9',
    Flare: '0',
  };

  // -------------------------------------------------------------------------
  // Service

  const weaponInfo = (d: WeaponDef) => ({
    id: d.key,
    name: d.name,
    kind: d.kind,
    slot: d.slot,
    order: d.order,
    clip: d.kind === 'ranged' ? clipOf(d) : 0,
    clipSize: d.kind === 'ranged' ? d.clipSize : 0,
    reserve: d.kind === 'ranged' ? reserveOf(d) : 0,
    icon: d.icon,
    current: d === current,
  });

  const service = {
    // Put away (creature form): no weapon / throwable panels.
    get current() {
      const d = current;
      if (!d || !enabled) return null;
      return { ...weaponInfo(d), ammoMeter: d.ammoMeter ?? null, crosshair: d.pwp?.crosshair ?? null, ranged: d.kind === 'ranged' };
    },
    get throwable() {
      if (!enabled) return null;
      const list = ownedThrowables();
      const d = list.find((x) => x.key === persist.throwable) ?? list[0];
      return d ? { id: d.key, name: d.name, meter: d.meter ?? null, count: countOf(d.template) } : null;
    },
    get weapons() {
      return ownedWeapons().map(weaponInfo);
    },
    get targeting() {
      return enabled && targeting;
    },
    get busy() {
      return busy() || cooldown > 0;
    },
    /** Xombium bottles carried (HUD bottle counter). */
    get healthPacks() {
      return healthPacks();
    },
    /** Flashlight lamp state and charge 0..1 (HUD battery meter); drain x difficulty. */
    get flashlight() {
      return { on: lamp.visible, battery: persist.battery ?? 1, drainScale: drainScale() };
    },
    /** The last strike: clock time and whether it was the unarmed one (debug / tests). */
    get lastStrike() {
      return lastStrike;
    },
    /** The unarmed Player Weapon Properties (Player p143) and its attacks (debug / tests). */
    unarmed: () => ({ pwp: unarmed.pwp?.ref ?? null, attacks: (unarmed.pwp?.attacks ?? []).map((a) => keyOf(a.clip)), fp: (unarmed.pwp?.fpAttacks ?? []).map((a) => keyOf(a.clip)) }),
    /** False while the weapons are put away (creature form). */
    get enabled() {
      return enabled;
    },
    set enabled(on: boolean) {
      setEnabled(on);
    },
    setEnabled,
    /** Drink a Xombium bottle (Health key); false when none / at full health. */
    useHealthPack,
    /** Called by the world's pickup code for Health Bonus Items; false = heal on the spot. */
    storeHealthPack,
    equip: (id: string) => equip(id),
    next: () => cycle(1),
    prev: () => cycle(-1),
    last: () => equip(persist.last),
    selectSlot,
    fire: () => attack(),
    reload: () => reload(),
    throw: () => throwSelected(),
    nextThrowable,
    selectThrowable,
    /** Killjoy Rebirth Effect: weapons away / back (see stow()). */
    stow,
    unstow,
    get stowed() {
      return !!stowed;
    },
    give(id: string, amount = 1) {
      const r = refOf(id);
      inv?.add(weaponDef(epk, r)?.name ?? `Item ${id}`, amount, r, templateClass(epk, r));
    },
    def: (id: string) => weaponDef(epk, refOf(id)),
    attach: (o: Parameters<AttachService['attach']>[0], c: Parameters<AttachService['attach']>[1], hp: Parameters<AttachService['attach']>[2]) => attach.attach(o, c, hp),
    detach: (o: number | THREE.Object3D) => attach.detach(o),
    detachHardpoint: (c: Parameters<AttachService['detachHardpoint']>[0], hp?: Parameters<AttachService['detachHardpoint']>[1]) => attach.detachHardpoint(c, hp),
    /** Weapon models in an actor's hands (debug / tests). */
    npcWeapons: (a: NpcLike) => npcWeapons.of(a),
    /** Its p51 / p52 set is in the hand (p53 or a SpawnWeapons event; npc.ts). */
    npcWeaponsInHand: (a: NpcLike) => npcWeapons.inHand(a),
    /**
     * An NPC's throw (actors/throw.ts): the BouncingObject `template` released at `from` with
     * velocity `vel` (m/s); it bounces and goes off as the player's throwables do.
     */
    throwObject: (template: ResRef, from: THREE.Vector3Like, vel: THREE.Vector3Like, by?: ActorLike) => {
      const td = thrownDefOf(epk, template);
      if (!td) return false;
      const mesh: THREE.Object3D = (td.model && buildStaticModel(pkgs, td.model)) || new THREE.Mesh(sphere, matDust);
      mesh.position.set(from.x, from.y, from.z);
      fxGroup.add(mesh);
      thrown.push({ td, by, mesh, vel: new THREE.Vector3(vel.x, vel.y, vel.z), fuse: td.fuse, rest: false });
      return true;
    },
  };
  ctx.services.weapons = service;

  const offSave = registerSave<Persist>(
    ctx.services,
    'weapons',
    {
      save: () => ({ clips: { ...persist.clips }, current: persist.current, last: persist.last, throwable: persist.throwable, battery: persist.battery }),
      load: (d) => {
        // Keys are item templates ("pkg:id"); old saves keyed by display name are mapped where
        // the name belongs to one template only (save/providers.ts migrateItemKey).
        const key = (k: string | null | undefined) => migrateItemKey(k, byName);
        persist.clips = {};
        for (const [k, n] of Object.entries(d.clips ?? {})) {
          const m = key(k);
          if (m) persist.clips[m] = n;
        }
        persist.last = key(d.last);
        persist.throwable = key(d.throwable);
        persist.battery = typeof d.battery === 'number' ? d.battery : 1;
        stowed = null;
        pendingEquip = null;
        equip(key(d.current), { instant: true });
      },
      reset: () => {
        stowed = null;
        persist.clips = {};
        persist.current = persist.last = persist.throwable = null;
        persist.battery = 1;
        current = null;
        dropHeld();
        body()?.setStance(null);
      },
    },
    { scope: 'game', priority: 30 },
  );

  // Re-equip the weapon carried in from the previous level once the body exists.
  let restored = false;

  Object.assign(window, { __weapons: { attach, service, persist, shots, thrown, loaded: ctx.loaded } });

  return {
    name: 'weapons',
    update(dt) {
      clock += dt;
      // The Xombium hint after damage (healthHintDue).
      const hc = combatLink.combat;
      if (hc) {
        if (hc.health < lastHealth && hc.alive && healthHintDue('damage', hc.health, hc.maxHealth, healthPacks())) healthHint();
        lastHealth = hc.health;
      }
      if (!restored && body()) {
        restored = true;
        if (persist.current && !current) equip(persist.current, { instant: true });
      }
      if (pendingEquip && body() && !busy()) {
        const k = pendingEquip;
        pendingEquip = null;
        equip(k);
      }
      // A weapon that left the inventory (save restore, New Game) is put away.
      if (current && !owned(current)) equip(null, { instant: true });
      cooldown = Math.max(0, cooldown - dt);
      if (action && clock >= action.until) {
        const a = action;
        action = null;
        a.then?.();
      }
      for (let i = timers.length - 1; i >= 0; i--) {
        if (clock >= timers[i].at) timers.splice(i, 1)[0].fn();
      }
      // (A held trigger is one struggle press while a creature holds the player, not one a frame.)
      if (fireHeld && current?.auto && canAct() && !view.player.attackOverride) attack();
      if (current?.kind === 'ranged' && clipOf(current) <= 0 && reserveOf(current) > 0 && !busy() && cooldown <= 0) reload();
      targeting = false;
      if (view.walking) {
        const hit = actors()?.raycast(camPos(), camDir(), 60);
        targeting = !!hit && hit.actor.alive && !hit.actor.kind.decor;
      }
      updateShots(dt);
      updateThrown(dt);
      for (let i = effects.length - 1; i >= 0; i--) {
        const f = effects[i];
        f.life += dt;
        if (f.vel) {
          f.vel.y -= 9.8 * dt * (f.kind === 'casing' ? 1 : 0.3);
          f.obj.position.addScaledVector(f.vel, dt);
          if (f.kind === 'casing') f.obj.rotation.z += dt * 15;
        }
        if (f.kind === 'boom') f.obj.scale.setScalar(0.3 + (f.life / f.max) * 2.5);
        if (f.kind === 'light') (f.obj as THREE.PointLight).intensity *= Math.exp(-dt * 8);
        if (f.life >= f.max) {
          f.obj.removeFromParent();
          effects.splice(i, 1);
        }
      }
      flashLight.intensity *= Math.exp(-dt * 30);
      for (const m of held ? [...held.fp, ...held.tp] : []) m.character?.update(dt);
      attach.update();
      // After the attacher: the NPC weapons' visibility reads the STOMP attachments.
      const list = actors()?.list();
      if (list) npcWeapons.update(list);
      updateFlashlight(dt);
    },
    dispose() {
      offSave();
      if (aimAssist.provider === aimProvider) aimAssist.provider = null;
      aimAssist.lock = null;
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('keydown', onKey);
      dom.removeEventListener('contextmenu', onCtx);
      if (inv && origAdd) inv.add = origAdd;
      combatLink.attack = null;
      dropHeld();
      npcWeapons.dispose();
      for (const m of warmHeld) {
        m.root.removeFromParent();
        m.dispose();
      }
      lamp.intensity = lampIntensity;
      if (view.flashlightAvailable === hasFlashlight) view.flashlightAvailable = null;
      for (const s of shots) s.tracer.removeFromParent();
      for (const t of thrown) t.mesh.removeFromParent();
      for (const f of effects) f.obj.removeFromParent();
      fxGroup.removeFromParent();
      flashLight.removeFromParent();
      sphere.dispose();
      tracerGeo.dispose();
      casingGeo.dispose();
      matBrass.dispose();
      matBlood.dispose();
      matDust.dispose();
      matTracer.dispose();
      matBoom.dispose();
      attach.dispose();
      if (ctx.services.weapons === service) delete ctx.services.weapons;
      delete (window as unknown as { __weapons?: unknown }).__weapons;
    },
  };
}
