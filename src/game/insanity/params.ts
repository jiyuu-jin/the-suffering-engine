// Insanity tuning read from the game's own templates (no numbers from the data are
// copied into the repo; every value below is looked up at runtime).
//
// Player template (System 2:5, class Player) and the creature-form Player template it
// names in p253 (2:240, model 2:124). The engine swaps the player's property set to the
// creature template while transformed, so every "creature" value is the same property
// index read from 2:240. Property meanings (docs/game-logic.md §13):
//
//   p38 adrenaline decay /s     p39/p40 adrenaline max/min   p41..p46 Adrenaline Templates
//   p52/p53 breath period (s) at adrenaline 0 / 100 (lerp)   p50 breath sounds
//   p58/p59 heartbeat sounds     p60/p61 heartbeat period (s) at adrenaline 0 / 100
//   p62/p63 heartbeat volume (%) p64/p65 heartbeat pitch     p70/p71 reputation range (-150..150)
//   p80/p81 meter-gain scale at reputation p70 / p71         p82/p83 drain /s at p70 / p71
//   p143 Player Weapon Properties (locomotion clips + speeds)  p253 other-form template
//   p255 Character Morpher (model, clip p3, duration p4)       p257 health drain /s at empty meter
//   p258 meter maximum   p259 kill-combo window (s)   p260/p261 combo x2 / x3+ multipliers
//   p262 unknown-flag multiplier   p263 melee-kill multiplier   p264 held Melee Weapon multiplier
//   p265 Screen Blur, p266/p267 Screen Faders while transformed   p270/p271 FOV pulse (deg)
//   p231 the form's own Melee Weapons (creature arms; empty for the human)
//   p256 put-away clip before transforming with a weapon in hand   p275 acquisition clip
//   p276 Insanity Attack Templates   p292 + n player event n (Help Popups; n = 9: p301 low meter)
//   p302 low-meter warning (% of max)

import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

export const PLAYER_TEMPLATE: ResRef = { pkg: 2, id: 5 };

export type Values = PropValue[];

export function templateValues(pkgs: EntityPackageSet, ref: ResRef | null | undefined): { cls: string; values: Values; model?: ResRef } | undefined {
  if (!ref) return undefined;
  const t = readObjectTemplate(pkgs, ref);
  if (!t) return undefined;
  const cls = classByHash(t.classHash);
  return { cls: cls?.name ?? '', values: decodeTemplateProps(cls, t), model: t.modelRef };
}

export const num = (v: PropValue | undefined, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const ref = (v: PropValue | undefined): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);
export const refs = (v: PropValue | undefined): ResRef[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is ResRef => !!x && typeof x === 'object');
export const keyOf = (r: ResRef) => `${r.pkg}:${r.id}`;

/** One form (human or creature) of the player. */
export interface FormParams {
  template: ResRef;
  model?: ResRef;
  adrenalineDecay: number;
  adrenalineMax: number;
  adrenalineMin: number;
  breathPeriod: [number, number];
  heartPeriod: [number, number];
  heartVolume: [number, number];
  heartPitch: [number, number];
  heartSounds: string[];
  breathSounds: string[];
  reputationRange: [number, number];
  gainScale: [number, number];
  drainRate: [number, number];
  healthDrain: number;
  meterMax: number;
  comboWindow: number;
  combo2: number;
  combo3: number;
  flagMult: number;
  meleeKillMult: number;
  meleeWeaponMult: number;
  fovPulse: [number, number];
  lowMeterPct: number;
  /** Morph to the other form: model, clip and duration (Character Morpher, p255). */
  morph?: { model?: ResRef; clip?: ResRef; duration: number };
  /** Screen effects while in this form (creature: blur + tint; human: unused here). */
  blur?: ResRef;
  tint?: ResRef;
  flash?: ResRef;
  /** Locomotion clips + speeds (Player Weapon Properties p13.. of p143). */
  locomotion?: Locomotion;
  /** Attack templates: combo (weapon props p86), alternate (p89), jump (p90). */
  attacks?: { combo: AttackParams[]; alt: AttackParams[]; jump: AttackParams[] };
  /**
   * Damage range of the form's melee hits: the p231 Melee Weapons' p68 / p69 (the creature's
   * invisible arm weapons 4:155 / 4:832, armed by the Attack clips' Arm markers). Falls back
   * to p54..p55 when the form has none (the human: those are breathing values, not damage).
   */
  hitDamage: [number, number];
  /** Damage type of those weapons (Melee Weapon p70). */
  hitDamageType?: number;
  /**
   * The form's arm weapons (p231 Melee Weapons on the p232 bones, by skeleton index): p68 the
   * damage of a blow (flat, x the Attack's p6), p70 its type (src/game/insanity/melee.ts).
   */
  armWeapons: { template: ResRef; bone: number; damage: number; type?: number }[];
  /** Reputation scale of the player's blows on Unspeakable NPCs: p78 / p79 over p70..p71. */
  npcDamageScale: [number, number];
  insanityAttacks: ResRef[];
  /** p276 decoded (Insanity Attack Template), in unlock order. */
  insanityAttackDefs: InsanityAttackDef[];
  /** p256: the clip that puts the weapon away before the transformation (Play Anim state). */
  putAway?: ResRef;
  /** p275: the clip played when an insanity attack is acquired (state 30). */
  acquireClip?: ResRef;
  /** p301 (player event 9, sent once when the meter falls below p302 %): a Help Popup. */
  lowMeterEvent?: ResRef;
  values: Values;
}

/**
 * Insanity Attack Template (2:663..2:667). Read by the RFL: p0 threshold compared with the
 * points of kills made while transformed (0x100338e6), p2 the attack clip on the creature rig
 * and the effects spawned by the attack routine (0x10034566..0x10034793): p10 at the player,
 * p4 at each target (after a random p8..p9 s delay); the p3 Object Generator holds the attack's
 * Radius Damage. p1 is the index in the list, p5 / p6 / p7 [unknown].
 */
export interface InsanityAttackDef {
  template: ResRef;
  threshold: number;
  index: number;
  clip?: ResRef;
  generator?: ResRef;
  targetGenerator?: ResRef;
  playerEffect?: ResRef;
  delay: [number, number];
  values: Values;
}

export function readInsanityAttack(pkgs: EntityPackageSet, r: ResRef): InsanityAttackDef | undefined {
  const t = templateValues(pkgs, r);
  if (!t || t.cls !== 'Insanity Attack Template') return undefined;
  const v = t.values;
  return {
    template: r,
    threshold: num(v[0]),
    index: num(v[1]),
    clip: ref(v[2]) ?? undefined,
    generator: ref(v[3]) ?? undefined,
    targetGenerator: ref(v[4]) ?? undefined,
    playerEffect: ref(v[10]) ?? undefined,
    delay: [num(v[8]), num(v[9])],
    values: v,
  };
}

/** Damage range / type of a form's own Melee Weapons (Player p231). */
function formWeaponDamage(pkgs: EntityPackageSet, list: PropValue | undefined): { range: [number, number]; type?: number } | undefined {
  let lo = Infinity, hi = -Infinity, type: number | undefined;
  for (const r of refs(list)) {
    const w = templateValues(pkgs, r);
    if (!w || w.cls !== 'Melee Weapon') continue;
    const a = num(w.values[68]), b = num(w.values[69]);
    lo = Math.min(lo, a, b);
    hi = Math.max(hi, a, b);
    type ??= num(w.values[70]);
  }
  return Number.isFinite(lo) ? { range: [lo, hi], type } : undefined;
}

export interface Locomotion {
  idle?: ResRef;
  /** Forward walk / run clip and the speed (m/s) the engine pairs with it. */
  walk?: { clip: ResRef; speed: number };
  run?: { clip: ResRef; speed: number };
  /** Directional sets at 135 / 225 / 315 degrees: walk + run. */
  right?: { walk?: ResRef; run?: ResRef };
  back?: { walk?: ResRef; run?: ResRef };
  left?: { walk?: ResRef; run?: ResRef };
}

export interface AttackParams {
  template: ResRef;
  clip?: ResRef;
  follow?: ResRef;
  /** p6: damage multiplier [inferred]. */
  scale: number;
}

const soundKeys = (v: PropValue | undefined) => refs(v).map(keyOf);

function readAttack(pkgs: EntityPackageSet, r: ResRef): AttackParams | undefined {
  const t = templateValues(pkgs, r);
  if (!t || t.cls !== 'Attack') return undefined;
  return { template: r, clip: ref(t.values[0]) ?? undefined, follow: ref(t.values[3]) ?? undefined, scale: num(t.values[6], 1) };
}

function readLocomotion(pkgs: EntityPackageSet, r: ResRef | null): Locomotion | undefined {
  const t = templateValues(pkgs, r);
  if (!t || t.cls !== 'Player Weapon Properties') return undefined;
  const v = t.values;
  const clip = (i: number) => ref(v[i]) ?? undefined;
  const walk = clip(18), run = clip(20);
  return {
    idle: clip(13),
    walk: walk ? { clip: walk, speed: num(v[19], 1.5) } : undefined,
    run: run ? { clip: run, speed: num(v[21], 6) } : undefined,
    right: { walk: clip(23), run: clip(25) },
    back: { walk: clip(28), run: clip(30) },
    left: { walk: clip(33), run: clip(35) },
  };
}

function readAttacks(pkgs: EntityPackageSet, r: ResRef | null): FormParams['attacks'] {
  const t = templateValues(pkgs, r);
  if (!t || t.cls !== 'Player Weapon Properties') return undefined;
  const list = (i: number) => refs(t.values[i]).flatMap((x) => readAttack(pkgs, x) ?? []);
  return { combo: list(86), alt: list(89), jump: list(90) };
}

export function readForm(pkgs: EntityPackageSet, template: ResRef): FormParams | undefined {
  const t = templateValues(pkgs, template);
  if (!t || t.cls !== 'Player') return undefined;
  const v = t.values;
  const pair = (a: number, b: number, da: number, db: number): [number, number] => [num(v[a], da), num(v[b], db)];
  const morphT = templateValues(pkgs, ref(v[255]));
  const morph = morphT && morphT.cls === 'Character Morpher'
    ? { model: morphT.model, clip: ref(morphT.values[3]) ?? undefined, duration: num(morphT.values[4], 1) }
    : undefined;
  return {
    template,
    model: t.model,
    adrenalineDecay: num(v[38], 5),
    adrenalineMax: num(v[39], 100),
    adrenalineMin: num(v[40], 0),
    breathPeriod: pair(52, 53, 2.5, 0.5),
    heartPeriod: pair(60, 61, 2, 0.5),
    heartVolume: pair(62, 63, 9, 32),
    heartPitch: pair(64, 65, 1, 1.5),
    heartSounds: [...soundKeys(v[58]), ...soundKeys(v[59])],
    breathSounds: soundKeys(v[50]),
    reputationRange: pair(70, 71, -150, 150),
    gainScale: pair(80, 81, 1.25, 0.75),
    drainRate: pair(82, 83, 2.25, 4.25),
    healthDrain: num(v[257], 0),
    meterMax: num(v[258], 100) || 100,
    comboWindow: num(v[259], 3),
    combo2: num(v[260], 1.5),
    combo3: num(v[261], 2),
    flagMult: num(v[262], 1),
    meleeKillMult: num(v[263], 1),
    meleeWeaponMult: num(v[264], 1),
    fovPulse: pair(270, 271, 55, 62),
    lowMeterPct: num(v[302], 35),
    morph,
    blur: ref(v[265]) ?? undefined,
    tint: ref(v[266]) ?? undefined,
    flash: ref(v[267]) ?? undefined,
    locomotion: readLocomotion(pkgs, ref(v[143])),
    attacks: readAttacks(pkgs, ref(v[143])),
    hitDamage: formWeaponDamage(pkgs, v[231])?.range ?? pair(54, 55, 1, 8),
    hitDamageType: formWeaponDamage(pkgs, v[231])?.type,
    armWeapons: refs(v[231]).flatMap((r, i) => {
      const w = templateValues(pkgs, r);
      const bone = Array.isArray(v[232]) ? Number((v[232] as unknown[])[i]) : NaN;
      if (!w || w.cls !== 'Melee Weapon' || !Number.isFinite(bone)) return [];
      return [{ template: r, bone, damage: num(w.values[68]), type: typeof w.values[70] === 'number' ? (w.values[70] as number) : undefined }];
    }),
    npcDamageScale: pair(78, 79, 1, 1),
    insanityAttacks: refs(v[276]),
    insanityAttackDefs: refs(v[276]).flatMap((r) => readInsanityAttack(pkgs, r) ?? []),
    putAway: ref(v[256]) ?? undefined,
    acquireClip: ref(v[275]) ?? undefined,
    lowMeterEvent: ref(v[301]) ?? undefined,
    values: v,
  };
}

export interface InsanityParams {
  human: FormParams;
  creature?: FormParams;
}

export function readInsanityParams(pkgs: EntityPackageSet, playerTemplate: ResRef = PLAYER_TEMPLATE): InsanityParams | undefined {
  const human = readForm(pkgs, playerTemplate);
  if (!human) return undefined;
  const other = ref(human.values[253]);
  const creature = other ? readForm(pkgs, other) : undefined;
  return { human, creature };
}

/** Adrenaline Template (class "Adrenaline Template", 6 props). */
export interface AdrenalineTemplate {
  amount: number;
  perSecond: boolean;
  cap: number;
  clampMax: boolean;
  floor: number;
  clampMin: boolean;
}

export function readAdrenalineTemplate(pkgs: EntityPackageSet, r: ResRef | null): AdrenalineTemplate | undefined {
  const t = templateValues(pkgs, r);
  if (!t || t.cls !== 'Adrenaline Template') return undefined;
  const v = t.values;
  return { amount: num(v[0]), perSecond: num(v[1]) === 1, cap: num(v[2], 100), clampMax: num(v[3]) === 1, floor: num(v[4]), clampMin: num(v[5]) === 1 };
}

/** Screen Fader template / entity values (18 props). */
export interface FaderParams {
  fadeIn: number;
  hold: number;
  fadeOut: number;
  autoStart: boolean;
  destroyAtEnd: boolean;
  p5: number;
  texture: ResRef | null;
  /** 0xRRGGBB */
  color: number;
  alpha: number;
  sound: ResRef | null;
  /** When the sound plays: 0 start, 1 reaching the hold, 2 starting the fade-out. */
  soundAt: number;
}

export function faderParams(v: Values): FaderParams {
  return {
    fadeIn: num(v[0]),
    hold: num(v[1]),
    fadeOut: num(v[2]),
    autoStart: num(v[3]) !== 0,
    destroyAtEnd: num(v[4], 1) === 1,
    p5: num(v[5]),
    texture: ref(v[6]),
    color: num(v[7], 0xffffff) & 0xffffff,
    alpha: num(v[8], 1),
    sound: ref(v[9]),
    soundAt: num(v[10]),
  };
}

/** Screen Blur template / entity values (15 props). */
export interface BlurParams {
  startOn: boolean;
  destroyAtEnd: boolean;
  mode: number;
  /** Phase k = 0 (in), 1 (hold), 2 (out): duration, strength A (%), spread B (%), audio level C. */
  phases: { duration: number; a: number; b: number; c: number }[];
}

export function blurParams(v: Values): BlurParams {
  return {
    startOn: num(v[0]) !== 0,
    destroyAtEnd: num(v[1], 1) === 1,
    mode: num(v[2], 1),
    phases: [
      { duration: num(v[3]), a: num(v[4]), b: num(v[5]), c: num(v[6], 1) },
      { duration: num(v[7], -1), a: num(v[8]), b: num(v[9]), c: num(v[10], 1) },
      { duration: num(v[11]), a: 0, b: 0, c: 1 },
    ],
  };
}
