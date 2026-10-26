// Weapon definitions decoded from the object templates (Resources pkg 4, System pkg 2).
//
// Property meanings (docs/game-logic.md §4.4; [code] = read in Suffering.rfl, [data] = from
// comparing all retail templates, [guess] otherwise):
//
// Item family (all weapons and ammo): p22 name, p29 inventory model, p37 weapon slot
//   (1 melee, 2 pistols, 3 shotgun, 4 tommy gun, 5 flamethrower, 6 throwables, 9 flare) [data],
//   p38 global cycle order (shiv 1, axe 2, revolver 3, dual 4, tommy 5, shotgun 6, ...) [data],
//   p44 maximum carried (Missile Item ammo: 200 bullets, 40 shells, 8 throwables) [data].
// Ranged Weapon (fire code at RFL 0x10127b30 [code]):
//   p64 Adrenaline Template, p65 Player Weapon Properties (clips, hand bones), p66 its second
//   set (dual revolvers' left hand), p67 weapon given by picking up a second one (revolver ->
//   Dual Revolvers), p68 ammo item, p69 clip size, p70 rounds in a picked-up weapon [data],
//   p71 automatic [data], p75 spread (degrees, random cone around the aim) [code], p76 aim-assist
//   cone (degrees) [code], p77 weapon-model fire clip, p78 projectile spawn bone (weapon model)
//   [code], p79 fire sounds [code], p80 muzzle-flash bone [code], p81 projectile generator
//   (Object Generator -> Missile; generator p2 = projectiles per shot, 6 for the shotgun) [code],
//   p82 extra generator at the muzzle (smoke), p83 Muzzle Flash (models, seconds) [code],
//   p85 fire from the muzzle bone instead of the eye [code], p86 casing generator
//   (BouncingObject), p87 weapon-model reload clip, p88 casing bone, p89 HUD Ammo Meter.
// Missile (projectile; impact code at RFL 0x100d1450 [code], docs/re/properties.md): p1 speed
//   (engine units / s), p26 damage per projectile (flat) [code: it fills the damage field of the
//   engine's damage record, which GameObject 0x100a31b0 subtracts from health], p28 impact force
//   up to p30 m travelled, p29 force from p31 m on, linear between [code]; p32 damage type
//   [code]; p40 Missile Tracer; p41 Missile Material Effects (impact sound / particles / decal
//   per surface material).
// Melee Weapon (hit code RFL 0x100ca920 [code]): p68 damage, p69 impact force, p70 damage type,
//   p71 swing sounds, p74 hit sounds, p77 per-material hit effects; the combo comes from Player
//   Weapon Properties p86 (Attack templates: p0 strike clip, p3 recovery clip, p6 damage
//   multiplier, p7 force multiplier [code]).
// Missile Item (throwables): p55 thrown object (BouncingObject: p1 launch speed, p12 fuse (s),
//   p34 detonation generators, p46 gravity (% of the world's), p49 bounces before it settles,
//   p50 1 = every surface counts as a bounce (0 = floor hits only), p51 % speed lost per bounce,
//   p54 seconds from settling to detonation, p60 detonates on hitting a character [code,
//   RFL 0x1009a8c0]) and the generators' Radius Damage (RFL 0x10125c70 [code]: p0 damage at the
//   centre falling linearly to p1 at p5 m, p2 / p3 impact force at the centre / edge, p10
//   damage type), p56 HUD meter.
// Player Weapon Properties: p0 hand bone (35 = right-hand weapon bone), p5 off-hand bone (27),
//   p7..p9 crosshair HUD textures (normal / ? / on target), p13 idle, p61 weapon-ready idle,
//   p96 reload, p106 secondary action, p108 throw, p110..p114 fire (p113 standing),
//   p116..p150 moving fire sets (45 / 120 / 180 / 240 / 315 deg), p172 draw (Equip event),
//   p175 / p177 put away. Clip roles from their animation events (.adu type 5: 102 Fire,
//   103 AmmoEject, 104 DetachWeaponFX, 107 Stow, 108 Equip, 100/101 Arm/Disarm = melee
//   damage window, 230 ThrowWeapon, 231 AttachThrownWeapon).

import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate, readXduString } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

/** Engine units per output unit (metre-ish model unit). */
export const ENGINE_UNITS = 2048;
/**
 * Gravity the port's thrown objects fall with, times BouncingObject p46 % (system.ts updateThrown;
 * NPC throws aim with it, actors/throw.ts) [port: the decoded world gravity is 10.41 m/s²,
 * docs/re/properties.md].
 */
export const THROWN_GRAVITY = 9.8;

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((r): r is ResRef => !!r && typeof r === 'object');
export const keyOf = (r: ResRef) => `${r.pkg}:${r.id}`;

export interface Tpl {
  ref: ResRef;
  cls: string;
  v: PropValue[];
  model?: ResRef;
}

export function tpl(pkgs: EntityPackageSet, r: ResRef | undefined): Tpl | undefined {
  if (!r) return undefined;
  const t = readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  if (!t || !c) return undefined;
  return { ref: r, cls: c.name, v: decodeTemplateProps(c, t), model: t.modelRef };
}

export type WeaponKind = 'melee' | 'ranged' | 'throwable';

export interface AttackDef {
  clip: ResRef;
  recovery?: ResRef;
  /** Damage multiplier (Attack p6). */
  mult: number;
  /** Impact force multiplier (Attack p7) [code: RFL 0x100caa7d]. */
  forceMult: number;
}

export interface PlayerWeaponProps {
  ref: ResRef;
  handBone: number;
  offhandBone: number;
  crosshair?: ResRef;
  crosshairTarget?: ResRef;
  idle?: ResRef;
  ready?: ResRef;
  fire?: ResRef;
  reload?: ResRef;
  draw?: ResRef;
  holster?: ResRef;
  throw?: ResRef;
  /** p86: the third-person strike list (Attack templates, a combo in order). */
  attacks: AttackDef[];
  /**
   * p91: the first-person strike list. The original picks p86 + 5·(first person) + the attack
   * class (0x1002a1a7), so p91 is not a running attack: unarmed and shiv strike with 2:393
   * (clip 2:218, x1.6) in first person.
   */
  fpAttacks: AttackDef[];
}

export interface ProjectileDef {
  template: ResRef;
  model?: ResRef;
  /** m/s */
  speed: number;
  /** Damage per projectile (Missile p26), the same at any distance [code]. */
  damage: number;
  /** Impact force near / far (p28 / p29) and the distances between which it falls off (p30 / p31, m). */
  forceNear: number;
  forceFar: number;
  nearDist: number;
  farDist: number;
  damageType: number;
  /** Projectiles per shot (generator p2). */
  count: number;
  tracer?: { model?: ResRef; width: number; length: number };
  materialFx: ResRef[];
}

export interface ExplosionDef {
  generator: ResRef;
  /** Damage at the centre (Radius Damage p0) falling linearly to minDamage (p1) at the radius. */
  maxDamage: number;
  minDamage: number;
  /** Always 0: the falloff starts at the centre (kept for the damage service's falloff). */
  innerRadius: number;
  /** Radius (p5, m). */
  outerRadius: number;
  /** Impact force at the centre / at the radius (p2 / p3). */
  maxForce: number;
  minForce: number;
  damageType: number;
  /** p7: the thrower is hurt too; p8: walls shield (line-of-sight test). */
  hurtsOwner: boolean;
  needsSight: boolean;
  /** p9: effect template attached to every victim (Molotov: burning). */
  victimEffect?: ResRef;
  /** p4: the Special Hit Reaction it carries (2:736: the player's 2:835 reaction). */
  special?: ResRef;
}

/**
 * Radius Damage template (RFL 0x10125c70 [code]): every object within p5 m takes
 * p1 + (p0 - p1) * (1 - d / p5) damage of type p10 and p3 + (p2 - p3) * (1 - d / p5) impact force.
 */
export function radiusDamageDef(v: PropValue[], generator: ResRef): ExplosionDef {
  return {
    generator,
    maxDamage: num(v[0]),
    minDamage: num(v[1]),
    innerRadius: 0,
    outerRadius: num(v[5]),
    maxForce: num(v[2]),
    minForce: num(v[3]),
    damageType: num(v[10]),
    hurtsOwner: num(v[7]) !== 0,
    needsSight: num(v[8]) !== 0,
    victimEffect: refs(v[9])[0],
    special: refs(v[4])[0],
  };
}

export interface ThrownDef {
  template: ResRef;
  model?: ResRef;
  /** Launch speed (m/s) used by the port. */
  speed: number;
  /** Fuse / burn time (s, BouncingObject p12). */
  fuse: number;
  /** Bounces before it settles (p49; 0 = never), counting every surface (p50) or floor hits only. */
  bounces: number;
  anySurfaceBounces: boolean;
  /** Fraction of speed kept per bounce (1 - p51 %). */
  restitution: number;
  /** Seconds from settling to detonation (p54; 0 = at once: the Molotov and the Flash/Bang). */
  settleDelay: number;
  /** p46: gravity, % of the world's (casings 50, throwables 100). */
  gravityPct: number;
  /** Detonates on hitting a character (p60). */
  hitDetonates: boolean;
  /** The blast that does the damage: the strongest of `explosions`. */
  explosion?: ExplosionDef;
  /**
   * Every Radius Damage the detonation generators throw, in order (each one applies: the
   * Killjoy Rebirth grenade's 4:893 throws 4:805, 21 damage, and 4:1439, 0 damage + a victim
   * effect).
   */
  explosions: ExplosionDef[];
  /** Detonation generators (p34) for the world FX service. */
  detonate: ResRef[];
  /**
   * Bounce sounds (RFL 0x1009a8c0 [code]): p62, or p63 when the surface's Game Material
   * Properties p2 (hardness: 0.3 / 0.5 / 0.7 / 1) is at least p56 (`bounceSound`).
   */
  bounceSounds: string[];
  hardBounceSounds: string[];
  /** p56: the surface hardness from which p63 plays. */
  hardSurface: number;
  /**
   * p64 InvestigateSound: AI noise made where it bounces, whenever a bounce plays a sound
   * (RFL 0x1009ad02, no source). No retail BouncingObject sets it.
   */
  bounceNoise?: ResRef;
}

/** BouncingObject floor test: the hit normal within 45 degrees of up (RFL 0x1009aa65 [code]). */
export const FLOOR_COS = Math.SQRT1_2;

/**
 * A BouncingObject hitting something (RFL 0x1009a8c0 [code]): every hit counts; at p49 (when
 * set) the object settles if p50 is set or the hit is a floor (`FLOOR_COS`), else that hit is
 * taken back and it bounces on. Returns the new count and whether it settles; a settling hit
 * plays no bounce sound.
 */
export function bounceHit(td: Pick<ThrownDef, 'bounces' | 'anySurfaceBounces'>, count: number, normalY: number): { count: number; settle: boolean } {
  count++;
  if (td.bounces > 0 && count >= td.bounces) {
    if (td.anySurfaceBounces || normalY > FLOOR_COS) return { count, settle: true };
    count--;
  }
  return { count, settle: false };
}

/** Game Material Properties of a surface: p2 hardness, p4 % of speed it absorbs. */
export interface SurfaceProps {
  hardness: number;
  damping: number;
}

/**
 * Sound of a (non-settling) bounce (RFL 0x1009ac26..0x1009ada8 [code]): the p63 list when the
 * surface's Game Material Properties p2 >= p56, else p62 (also with no surface record); the
 * engine picks from the list (duplicates weigh) [inferred: list handed to the sound system,
 * 0x10019f60]. Volume = the sound's own x k^(count - 1) with k = (1 - surface p4 %) x
 * (1 - p51 %), count = bounces so far. Empty `keys`: no sound (and no p64 noise).
 */
export function bounceSound(td: Pick<ThrownDef, 'bounceSounds' | 'hardBounceSounds' | 'hardSurface' | 'restitution'>, surface: SurfaceProps | undefined, count: number): { keys: string[]; volume: number } {
  const keys = surface && surface.hardness >= td.hardSurface ? td.hardBounceSounds : td.bounceSounds;
  const k = (1 - (surface?.damping ?? 0) / 100) * td.restitution;
  return { keys, volume: Math.pow(Math.max(0, k), Math.max(0, count - 1)) };
}

export interface WeaponDef {
  key: string;
  template: ResRef;
  className: string;
  kind: WeaponKind;
  name: string;
  slot: number;
  order: number;
  model?: ResRef;
  pwp?: PlayerWeaponProps;
  // ranged
  ammo?: ResRef;
  clipSize: number;
  startAmmo: number;
  auto: boolean;
  spread: number;
  aimCone: number;
  muzzleBone: number;
  flashBone: number;
  casingBone: number;
  fromMuzzle: boolean;
  fireSounds: string[];
  projectile?: ProjectileDef;
  muzzleFlash?: { template: ResRef; models: ResRef[]; duration: number };
  /** Extra generator spawned at the muzzle on each shot (p82: the shotgun's smoke). */
  muzzleGen?: ResRef;
  casing?: ResRef;
  /** The casing generator's BouncingObject (bounce rules and sounds: the brass clinks). */
  casingObject?: ThrownDef;
  ammoMeter?: ResRef;
  icon?: { texture: ResRef; rect: [number, number, number, number] };
  upgrade?: ResRef;
  weaponFireClip?: ResRef;
  weaponReloadClip?: ResRef;
  // melee
  damageMin: number;
  damageMax: number;
  damageType: number;
  /** Melee impact force (p69). */
  force: number;
  swingSounds: string[];
  hitSounds: string[];
  /** Melee Weapon p77: per-material hit effects (Melee Weapon Material Effects list). */
  meleeFx: ResRef[];
  /** Ranged / Melee Weapon p61: Reputation Point Based Blood Texture Set Suite (blood decals). */
  bloodSuite?: ResRef;
  // throwable
  thrown?: ThrownDef;
  meter?: ResRef;
  maxCarry: number;
  pickupSound?: string;
}

const soundKeys = (v: PropValue | undefined) => refs(v).map(keyOf);

function attackDef(pkgs: EntityPackageSet, r: ResRef | undefined): AttackDef | undefined {
  const a = tpl(pkgs, r);
  const clip = a && ref(a.v[0]);
  if (!a || !clip) return undefined;
  return { clip, recovery: ref(a.v[3]), mult: num(a.v[6], 1), forceMult: num(a.v[7], 1) };
}

export function readPlayerWeaponProps(pkgs: EntityPackageSet, r: ResRef | undefined): PlayerWeaponProps | undefined {
  const t = tpl(pkgs, r);
  if (!t || t.cls !== 'Player Weapon Properties' || !r) return undefined;
  const v = t.v;
  const attacks = refs(v[86]).map((x) => attackDef(pkgs, x)).filter((x): x is AttackDef => !!x);
  return {
    ref: r,
    handBone: num(v[0], 35),
    offhandBone: num(v[5], -1),
    crosshair: ref(v[7]),
    crosshairTarget: ref(v[9]),
    idle: ref(v[13]),
    ready: ref(v[61]),
    fire: ref(v[113]) ?? ref(v[110]),
    reload: ref(v[96]),
    draw: ref(v[172]),
    holster: ref(v[175]),
    throw: ref(v[108]),
    attacks,
    fpAttacks: refs(v[91]).map((x) => attackDef(pkgs, x)).filter((x): x is AttackDef => !!x),
  };
}

function projectileDef(pkgs: EntityPackageSet, gen: ResRef | undefined): ProjectileDef | undefined {
  const g = tpl(pkgs, gen);
  if (!g) return undefined;
  const m = tpl(pkgs, refs(g.v[0])[0]);
  if (!m || m.cls !== 'Missile') return undefined;
  const v = m.v;
  const tr = tpl(pkgs, ref(v[40]));
  return {
    template: m.ref,
    model: m.model,
    speed: num(v[1], 200000) / ENGINE_UNITS,
    damage: num(v[26]),
    forceNear: num(v[28]),
    forceFar: num(v[29]),
    nearDist: num(v[30], 1000),
    farDist: num(v[31], 1000),
    damageType: num(v[32], 1),
    count: Math.max(1, num(g.v[2], 1)),
    tracer: tr ? { model: tr.model, width: num(tr.v[0], 0.025), length: num(tr.v[1], 0.15) } : undefined,
    materialFx: refs(v[41]),
  };
}

const thrownCache = new WeakMap<object, Map<string, ThrownDef | null>>();

/** A BouncingObject template as a thrown object (an NPC's thrown weapon, actors/throw.ts). */
export function thrownDefOf(pkgs: EntityPackageSet, r: ResRef): ThrownDef | undefined {
  let m = thrownCache.get(pkgs);
  if (!m) thrownCache.set(pkgs, (m = new Map()));
  const k = keyOf(r);
  if (!m.has(k)) m.set(k, thrownDef(pkgs, r) ?? null);
  return m.get(k) ?? undefined;
}

function thrownDef(pkgs: EntityPackageSet, r: ResRef | undefined): ThrownDef | undefined {
  const t = tpl(pkgs, r);
  if (!t || !r) return undefined;
  const v = t.v;
  const detonate = refs(v[34]);
  const explosions: ExplosionDef[] = [];
  for (const d of detonate) {
    const g = tpl(pkgs, d);
    for (const s of refs(g?.v[0])) {
      const rd = tpl(pkgs, s);
      if (rd?.cls === 'Radius Damage') explosions.push(radiusDamageDef(rd.v, d));
    }
  }
  const explosion = explosions.reduce<ExplosionDef | undefined>((a, e) => (!a || e.maxDamage > a.maxDamage ? e : a), undefined);
  return {
    template: r,
    model: t.model,
    // p1 is the launch speed, 70000 engine units/s (34 m/s; RFL 0x100cf9fd). Gravity is p46 %
    // of a world gravity that was not decoded, so the port launches at 40% of p1 [guess: the
    // full value with 9.8 m/s² throws a grenade ~100 m].
    speed: (num(v[1], 70000) / ENGINE_UNITS) * 0.4,
    fuse: num(v[12], 2),
    bounces: num(v[49]),
    anySurfaceBounces: num(v[50]) !== 0,
    restitution: Math.max(0, 1 - num(v[51], 65) / 100),
    settleDelay: num(v[54]),
    gravityPct: num(v[46], 100),
    hitDetonates: num(v[60]) !== 0,
    explosion,
    explosions,
    detonate,
    bounceSounds: soundKeys(v[62]),
    hardBounceSounds: soundKeys(v[63]),
    hardSurface: num(v[56]),
    bounceNoise: ref(v[64]),
  };
}

function iconOf(pkgs: EntityPackageSet, meter: ResRef | undefined) {
  const m = tpl(pkgs, meter);
  const h = m && tpl(pkgs, ref(m.v[23]));
  const tex = h && ref(h.v[23]);
  if (!h || !tex) return undefined;
  return { texture: tex, rect: [num(h.v[24]), num(h.v[25]), num(h.v[26]), num(h.v[27])] as [number, number, number, number] };
}

const cache = new WeakMap<object, Map<string, WeaponDef | null>>();

/** Weapon / ammo / throwable definition of an item template (undefined for other items). */
export function weaponDef(pkgs: EntityPackageSet, r: ResRef): WeaponDef | undefined {
  let m = cache.get(pkgs);
  if (!m) cache.set(pkgs, (m = new Map()));
  const k = keyOf(r);
  if (m.has(k)) return m.get(k) ?? undefined;
  const d = buildDef(pkgs, r);
  m.set(k, d ?? null);
  return d;
}

function buildDef(pkgs: EntityPackageSet, r: ResRef): WeaponDef | undefined {
  const t = tpl(pkgs, r);
  if (!t) return undefined;
  const v = t.v;
  const kind: WeaponKind | undefined =
    t.cls === 'Melee Weapon' ? 'melee' : t.cls === 'Ranged Weapon' ? 'ranged' : t.cls === 'Missile Item' && ref(v[56]) ? 'throwable' : undefined;
  if (!kind) return undefined;
  const nameRef = ref(v[22]);
  const name = (nameRef && readXduString(pkgs, nameRef)) || t.cls;
  const base: WeaponDef = {
    key: keyOf(r),
    template: r,
    className: t.cls,
    kind,
    name,
    slot: num(v[37]),
    order: num(v[38]),
    model: t.model,
    clipSize: 0,
    startAmmo: 0,
    auto: false,
    spread: 0,
    aimCone: 0,
    muzzleBone: -1,
    flashBone: -1,
    casingBone: -1,
    fromMuzzle: false,
    fireSounds: [],
    damageMin: 0,
    damageMax: 0,
    damageType: 0,
    force: 0,
    swingSounds: [],
    hitSounds: [],
    meleeFx: [],
    maxCarry: num(v[44], 0),
    pickupSound: ref(v[48]) ? keyOf(ref(v[48])!) : undefined,
  };
  if (kind === 'throwable') {
    base.thrown = thrownDef(pkgs, ref(v[55]));
    base.meter = ref(v[56]);
    base.slot = 6;
    return base;
  }
  base.pwp = readPlayerWeaponProps(pkgs, ref(v[65]));
  base.bloodSuite = refs(v[61])[0];
  if (kind === 'melee') {
    // p68 is the damage and p69 the impact force (RFL 0x100ca920 [code]); no random spread.
    base.damageMin = base.damageMax = num(v[68]);
    base.force = num(v[69]);
    base.damageType = num(v[70]);
    base.swingSounds = soundKeys(v[71]);
    base.hitSounds = soundKeys(v[74]);
    base.meleeFx = refs(v[77]);
    return base;
  }
  // Ranged
  base.upgrade = ref(v[67]);
  base.ammo = ref(v[68]);
  base.clipSize = num(v[69]);
  base.startAmmo = num(v[70]);
  base.auto = num(v[71]) !== 0;
  base.spread = num(v[75]);
  base.aimCone = num(v[76]);
  base.weaponFireClip = ref(v[77]);
  base.muzzleBone = num(v[78], -1);
  base.fireSounds = soundKeys(v[79]);
  base.flashBone = num(v[80], -1);
  base.projectile = projectileDef(pkgs, ref(v[81]));
  const mf = tpl(pkgs, ref(v[83]));
  if (mf) base.muzzleFlash = { template: mf.ref, models: refs(mf.v[0]), duration: num(mf.v[1], 0.1) };
  base.muzzleGen = ref(v[82]);
  base.fromMuzzle = num(v[85]) !== 0;
  const cg = tpl(pkgs, ref(v[86]));
  base.casing = cg ? tpl(pkgs, refs(cg.v[0])[0])?.model : undefined;
  base.casingObject = cg ? thrownDef(pkgs, refs(cg.v[0])[0]) : undefined;
  base.weaponReloadClip = ref(v[87]);
  base.casingBone = num(v[88], -1);
  base.ammoMeter = refs(v[89])[0];
  base.icon = iconOf(pkgs, base.ammoMeter);
  return base;
}

/** Ammo item (Missile Item without a HUD meter): max carried and the projectile it stands for. */
export function ammoDef(pkgs: EntityPackageSet, r: ResRef): { maxCarry: number } | undefined {
  const t = tpl(pkgs, r);
  if (!t || t.cls !== 'Missile Item' || ref(t.v[56])) return undefined;
  return { maxCarry: num(t.v[44], 999) || 999 };
}

/** Item template class name (for inventory routing). */
export function templateClass(pkgs: EntityPackageSet, r: ResRef | undefined): string | undefined {
  return tpl(pkgs, r)?.cls;
}

/**
 * The player's flashlight (Player +0x134, a Flashlight object): held once an item of class
 * Flashlight is in the inventory. The Flashlight action does nothing without one (RFL 0x10049ed8
 * -> 0x10007d50 checks the class 0xcf3a3fa5) [verified].
 */
export function holdsFlashlight(items: Iterable<{ count: number; className?: string; template?: ResRef }>, classOf: (r: ResRef) => string | undefined): boolean {
  for (const it of items) {
    if (it.count <= 0) continue;
    if (it.className === 'Flashlight' || (it.template && classOf(it.template) === 'Flashlight')) return true;
  }
  return false;
}

/**
 * The lamp's on state this frame: off without a flashlight; switched on when the item has just
 * been received (the give code attaches it and calls Flashlight vtable +0x94, switch on, RFL
 * 0x10038fee) [verified]; otherwise as the player left it. `had` = held at the previous frame
 * (null on the level's first frame: a carried or loaded flashlight keeps its state).
 */
export function flashlightLampOn(held: boolean, had: boolean | null, on: boolean): boolean {
  if (!held) return false;
  return had === false ? true : on;
}

/** Projectile damage (Missile p26: flat, RFL 0x100d1921 [code]); `dist` is kept for callers. */
export function projectileDamage(p: ProjectileDef, _dist?: number): number {
  return p.damage;
}

/** Projectile impact force after `dist` metres travelled (Missile p28..p31, RFL 0x100d17a0 [code]). */
export function projectileForce(p: ProjectileDef, dist: number): number {
  if (dist <= p.nearDist) return p.forceNear;
  if (dist >= p.farDist) return p.forceFar;
  return p.forceNear - ((dist - p.nearDist) * (p.forceNear - p.forceFar)) / (p.farDist - p.nearDist);
}

/** Damage of a Radius Damage explosion at `d` m (0 beyond the radius). */
export function explosionDamage(e: ExplosionDef, d: number): number {
  if (d >= e.outerRadius) return 0;
  return e.minDamage + (e.maxDamage - e.minDamage) * (1 - d / Math.max(1e-3, e.outerRadius));
}

const labels = new WeakMap<object, Map<string, string>>();
/** Display name of an ammo item: the name of an Ammo Box that grants it, without the count. */
export function ammoLabel(pkgs: EntityPackageSet, r: ResRef): string | undefined {
  let m = labels.get(pkgs);
  if (!m) {
    labels.set(pkgs, (m = new Map()));
    for (const [pk, p] of pkgs) {
      const odu = (p as { odu?: import('../../formats/srsc').SrscFile }).odu;
      for (const e of odu?.entries ?? []) {
        if (e.type !== 2 || e.group !== 1) continue;
        const t = tpl(pkgs, { pkg: pk, id: e.id });
        if (t?.cls !== 'Ammo Box') continue;
        const item = ref(t.v[55]);
        const name = ref(t.v[22]);
        if (!item || !name || m.has(keyOf(item))) continue;
        const s = readXduString(pkgs, name);
        if (s) m.set(keyOf(item), s.replace(/\s+\d+$/, ''));
      }
    }
  }
  return m.get(keyOf(r));
}
