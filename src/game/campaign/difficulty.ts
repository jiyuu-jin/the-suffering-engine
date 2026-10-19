// Difficulty (Easy / Medium / Hard / Impossible) as the retail game applies it.
//
// Decoded from SUFFERING.EXE / Suffering.rfl (docs/campaign.md "Difficulty"). The difficulty
// is one integer d (0 easy .. 3 impossible; engine settings +0xd0, set by the main menu's
// difficulty items). The game uses it in exactly four places:
//
//   1. Placed objects: an instance is not created when its flags hold (0x10000 << d) | 0x8
//      (EXE 0x45a63f). Levels use this for extra ammo / health on easier settings, extra
//      enemies on harder ones, and the bonus movie after finishing on Impossible.
//   2. Health: every GameObject's health and max health are p0 / p1 x the Difficulty Modifier
//      template named in its p2 (four floats, one per difficulty; RFL 0x100a2a90 /
//      0x100a3174). Player 2:642 = 2 / 1 / 0.75 / 0.6, creatures 10:238 = 0.45 / 1.6 / 2.2 / 2.6,
//      the final boss 10:1850 = 1 / 1.33 / 1.67 / 2.33. No p2 = x1.
//   3. Health Bonus Items heal p55 x the modifier in their p56 (2:642; RFL 0x100b6d1d).
//   4. The flashlight battery drains dt / modifier (Flashlight p70 = 4:1414: 2 / 1 / 0.85 /
//      0.58; RFL 0x1001460f).
//
// Damage dealt, ammo counts, enemy speed / accuracy and the insanity meter are NOT scaled.
//
// Consumers read `difficulty` (this module) or ctx.services.difficulty (same object).

import { readObjectTemplate, setPlacedObjectFilter, type Entity, type EntityPackageSet } from '../../formats/entities';
import { parseLevelObjects } from '../../formats/level';
import type { ResRef } from '../../formats/model';
import { dynamicObjectProviders } from '../../app/loader';
import { saves } from '../save/manager';

export const DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard', 'Impossible'] as const;
export const DIFFICULTY_MODIFIER_CLASS = 0x83e942b4;

/** Instance flag bits that keep an object from being created on difficulty `d`. */
export function instanceExcludeMask(d: number): number {
  const k = Math.max(0, Math.min(3, Math.round(d) | 0));
  return ((0x10000 << k) | 0x8) >>> 0;
}

/** Is a placed object with these instance flags created on difficulty `d`? */
export function createdOnDifficulty(flags: number, d: number): boolean {
  return (flags & instanceExcludeMask(d)) === 0;
}

/** Difficulty Modifier value (p0..p3) of a template for difficulty `d`; 1 when absent. */
export function modifierValue(pkgs: EntityPackageSet | undefined, ref: ResRef | null | undefined, d: number): number {
  if (!pkgs || !ref || typeof ref !== 'object') return 1;
  const t = readObjectTemplate(pkgs, ref);
  if (!t || t.classHash >>> 0 !== DIFFICULTY_MODIFIER_CLASS) return 1;
  const i = Math.max(0, Math.min(3, d | 0));
  const w = t.words[i];
  if (w === undefined) return 1;
  const f = new Float32Array(new Uint32Array([w]).buffer)[0];
  return Number.isFinite(f) && f > 0 ? f : 1;
}

const asRef = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in (v as object) ? (v as ResRef) : null);

export interface DifficultyService {
  /** 0 easy .. 3 impossible. */
  readonly level: number;
  readonly name: string;
  /** Instance flags excluded on this difficulty. */
  readonly excludeMask: number;
  /** Health multiplier of a GameObject entity (its p2 Difficulty Modifier). */
  healthScale(e: Pick<Entity, 'values'> | undefined): number;
  /** Health multiplier of the player (Player template 2:5 p2). */
  playerHealthScale(): number;
  /** The player's max health on this difficulty (Player template p1 x p2 modifier). */
  playerMaxHealth(): number;
  /** Heal multiplier of a Health Bonus Item (entity or template: p56). */
  healScale(item: Pick<Entity, 'values'> | ResRef | undefined): number;
  /** Flashlight battery drain multiplier (1 / Flashlight p70 modifier). */
  flashlightDrainScale(flashlight?: Pick<Entity, 'values'> | ResRef): number;
  /** Difficulty Modifier value of any template ref. */
  modifier(ref: ResRef | null | undefined): number;
}

const PLAYER_TEMPLATE: ResRef = { pkg: 2, id: 5 };
const FLASHLIGHT_MODIFIER: ResRef = { pkg: 4, id: 1414 };

class Difficulty implements DifficultyService {
  /** Packages of the running level (template lookups); set by the campaign system. */
  packages: EntityPackageSet | undefined;
  /** Explicit override (tests / URL); otherwise the save session's difficulty. */
  override: number | undefined;

  get level(): number {
    const d = this.override ?? saves.session.difficulty;
    return Number.isInteger(d) ? Math.max(0, Math.min(3, d)) : 1;
  }

  get name(): string {
    return DIFFICULTY_NAMES[this.level];
  }

  get excludeMask(): number {
    return instanceExcludeMask(this.level);
  }

  modifier(ref: ResRef | null | undefined): number {
    return modifierValue(this.packages, ref, this.level);
  }

  healthScale(e: Pick<Entity, 'values'> | undefined): number {
    return this.modifier(asRef(e?.values[2]));
  }

  playerHealthScale(): number {
    const t = this.packages ? readObjectTemplate(this.packages, PLAYER_TEMPLATE) : undefined;
    if (!t) return modifierValue(undefined, null, this.level);
    // Player p2 (template word 2 is a ref word: pkg << 16 | id).
    const w = t.words[2];
    return w ? this.modifier({ pkg: w >>> 16, id: w & 0xffff }) : 1;
  }

  playerMaxHealth(): number {
    const t = this.packages ? readObjectTemplate(this.packages, PLAYER_TEMPLATE) : undefined;
    const w = t?.words[1];
    const base = w !== undefined ? new Float32Array(new Uint32Array([w]).buffer)[0] : 100;
    return (Number.isFinite(base) && base > 0 ? base : 100) * this.playerHealthScale();
  }

  healScale(item: Pick<Entity, 'values'> | ResRef | undefined): number {
    if (!item) return 1;
    if ('values' in item) return this.modifier(asRef(item.values[56]));
    const t = this.packages ? readObjectTemplate(this.packages, item) : undefined;
    const w = t?.words[56];
    return w ? this.modifier({ pkg: w >>> 16, id: w & 0xffff }) : 1;
  }

  flashlightDrainScale(flashlight?: Pick<Entity, 'values'> | ResRef): number {
    let ref: ResRef | null = FLASHLIGHT_MODIFIER;
    if (flashlight && 'values' in flashlight) ref = asRef(flashlight.values[70]) ?? ref;
    return 1 / this.modifier(ref);
  }
}

/** The app-wide difficulty (reads saves.session.difficulty). */
export const difficulty = new Difficulty();
// Developer / test override: ?difficulty=0..3 (developer viewer deep links have no menu).
try {
  const q = globalThis.location ? new URLSearchParams(globalThis.location.search).get('difficulty') : null;
  if (q !== null && /^[0-3]$/.test(q)) {
    difficulty.override = Number(q);
    saves.session.difficulty = Number(q);
  }
} catch {
  /* not in a browser */
}

// Objects the engine does not create on this difficulty: left out of every entity list and
// of the merged static geometry (registered with the loader before the level is built).
setPlacedObjectFilter((o) => createdOnDifficulty(o.flags, difficulty.level));
const excludedStatics = (lvl: Parameters<typeof parseLevelObjects>[0]) => {
  const mask = difficulty.excludeMask;
  return parseLevelObjects(lvl)
    .filter((o) => o.flags & mask)
    .map((o) => o.uid);
};
if (!dynamicObjectProviders.includes(excludedStatics)) dynamicObjectProviders.push(excludedStatics);
