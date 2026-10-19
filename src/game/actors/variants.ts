// Behaviour template variants by condition (docs/game-logic.md §15.7.5).
//
// A Character template names one behaviour template per behaviour type (its slot, e.g.
// CartWheeler p92 MovementAnimBehavior) and, in its lists p105 / p106, further templates of the
// same classes that apply under conditions. Every behaviour template starts with two enum
// lists [verified: the variant test 0x10101380]:
//   p0  behaviour types that must be running above it (ancestors in the behaviour tree; e.g. 66
//       FleeBehavior for a flee-only gait);
//   p1  condition bits that must all be set in the character's condition word (+0x74): v -> bit
//       (1 << v).
// A template with empty lists always applies. When a condition changes the character marks the
// behaviours of the affected type for re-evaluation (0x10098620 / 0x100976d0), so the variant
// switches while the behaviour runs.
//
// Condition bits set by the code [verified]:
//   0  on a ceiling                 Character SetOnCeiling (vt 55, 0x100e2160)
//   1  close to the target          CartWheeler 0x10072330 (CartWheelerKillMelee p18 / p19)
//   2  head shot off                CartWheeler 0x10072a30 (from the damage path's head test)
// Which matching variant wins when several do is not decoded: the one with the most conditions
// (the most specific) [inferred]; the slot's own template otherwise.

import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, PROP_LIST, PropType, readObjectTemplate } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

/** Condition bits of the character condition word [verified setters, see above]. */
export const COND = { ceiling: 0, close: 1, headless: 2 } as const;

/** Character template lists holding the conditional behaviour templates [data: every retail Character]. */
export const VARIANT_LISTS = [105, 106] as const;

export interface BehaviorVariant {
  ref: ResRef;
  cls: string;
  /** p0: behaviour types that must be running above it. */
  under: number[];
  /** p1: condition bits that must be set. */
  conds: number[];
  /** Decoded template properties. */
  v: PropValue[];
}

const enums = (x: PropValue | undefined): number[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]).filter((n): n is number => typeof n === 'number');

/** Decode one behaviour template as a variant (undefined when it is not a template). */
export function readVariant(pkgs: EntityPackageSet, ref: ResRef | null | undefined): BehaviorVariant | undefined {
  if (!ref) return undefined;
  const t = readObjectTemplate(pkgs, ref);
  const c = t ? classByHash(t.classHash) : undefined;
  if (!t || !c || !/Behavior$/.test(c.name)) return undefined;
  const v = decodeTemplateProps(c, t);
  return { ref: { pkg: ref.pkg, id: ref.id }, cls: c.name, under: enums(v[0]), conds: enums(v[1]), v };
}

/** The conditional behaviour templates of a Character (its p105 / p106 lists). */
export function readVariants(pkgs: EntityPackageSet, values: readonly PropValue[], types: readonly number[]): BehaviorVariant[] {
  const out: BehaviorVariant[] = [];
  for (const i of VARIANT_LISTS) {
    const ty = types[i] ?? 0;
    if ((ty & 0xff) !== PropType.Template || !(ty & PROP_LIST)) continue;
    const x = values[i];
    for (const r of Array.isArray(x) ? x : [x]) {
      if (!r || typeof r !== 'object') continue;
      const b = readVariant(pkgs, r as ResRef);
      if (b) out.push(b);
    }
  }
  return out;
}

/** The variant test (0x10101380): every p1 bit set in `bits`, every p0 type among `running`. */
export function variantMatches(b: Pick<BehaviorVariant, 'conds' | 'under'>, bits: number, running: readonly number[] = []): boolean {
  return b.conds.every((c) => c >= 0 && c < 31 && (bits & (1 << c)) !== 0) && b.under.every((u) => running.includes(u));
}

/**
 * The template a behaviour of class `cls` uses under `bits`: the matching variant with the most
 * conditions, else `fallback` (the slot's template) [verified test; inferred tie-break].
 */
export function pickVariant<T extends Pick<BehaviorVariant, 'cls' | 'conds' | 'under'>>(list: readonly T[], cls: string, bits: number, fallback?: T, running: readonly number[] = []): T | undefined {
  let best: T | undefined;
  for (const b of list) {
    if (b.cls !== cls || (!b.conds.length && !b.under.length) || !variantMatches(b, bits, running)) continue;
    if (!best || b.conds.length + b.under.length > best.conds.length + best.under.length) best = b;
  }
  return best ?? fallback;
}

/** Condition word from flags. */
export function condBits(c: { ceiling?: boolean; close?: boolean; headless?: boolean }): number {
  return (c.ceiling ? 1 << COND.ceiling : 0) | (c.close ? 1 << COND.close : 0) | (c.headless ? 1 << COND.headless : 0);
}
