// Reputation / blood skins: Torque's body, his first-person arms and his weapons are retextured
// by "Reputation Point Based Blood Texture Set Suite" templates (docs/game-logic.md §13.6).
// Renderer-free: template decoding and the selection rules. The game system that applies the
// textures to the meshes is reputation-skin-system.ts.
//
// Data [verified]:
//   Suite (class 0xab95b967, "3003.2"): p0 = Blood Texture Sets, p1 = minimum reputation (f32).
//   Blood Texture Set (0xae2436db, "5003.2"): p0 = materials, p1 = minimum blood level (f32).
//   Set material i replaces material slot i of the model the suite is applied to (the suite's own
//   template model, 2:9 / 4:15, is an editor placeholder: weapon suites name 4:15 for every gun).
//   Player p66 = body suites by reputation, p67 = first-person arm suites (one per reputation
//   tier, all the same suite 2:694), p68 = maximum blood level (50), p69 = blood lost per second
//   (0.5). Ranged / Melee Weapon p61 = suite list (one suite), p62 = maximum (100), p63 = decay.
//
// Rules (Suffering.rfl, the blood-skin component: init 0x1002ffb0, update 0x10099f70, apply
// 0x10099cf0, Player reputation hook 0x1002b5e0) [verified]:
//   suite = the last list entry whose p1 <= reputation (lists are sorted ascending; index 0 when
//           none), recomputed whenever the reputation changes and at spawn;
//   set   = the last set of that suite whose p1 <= blood level (index 0 when none);
//   the set's materials are swapped in whole (discrete, no blending) on the next update after
//   either index changes. Blood level: +amount from Blood Point Generators near the player,
//   -p69 per second, clamped to [0, p68]. Weapons never change suite (no reputation hook).

import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import { findEntry, MDU_HEADER, resolveMaterialTexture, type PackageSet, type ResRef } from '../../formats/model';

export const SUITE_CLASS = 'Reputation Point Based Blood Texture Set Suite';
export const SET_CLASS = 'Blood Texture Set';
export const PLAYER_TEMPLATE: ResRef = { pkg: 2, id: 5 };

export const refKey = (r: ResRef) => `${r.pkg}:${r.id}`;
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);
const refsOf = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter(isRef);
const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface BloodSet {
  ref: ResRef;
  /** p1: used from this blood level up. */
  minBlood: number;
  materials: ResRef[];
  /** Base texture of each material ("pkg:id"), undefined when unresolved. */
  textures: (string | undefined)[];
}

export interface Suite {
  ref: ResRef;
  /** p1: used from this reputation up. */
  minReputation: number;
  /** Sorted by minBlood (the data is already sorted). */
  sets: BloodSet[];
}

function template(pkgs: EntityPackageSet, r: ResRef): { cls: string; values: PropValue[] } | undefined {
  const t = readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  return t && c ? { cls: c.name, values: decodeTemplateProps(c, t) } : undefined;
}

const suiteCache = new WeakMap<object, Map<string, Suite | null>>();

/** Decode a suite template (undefined when the ref is not a suite). */
export function readSuite(pkgs: EntityPackageSet, r: ResRef): Suite | undefined {
  let cache = suiteCache.get(pkgs);
  if (!cache) suiteCache.set(pkgs, (cache = new Map()));
  const k = refKey(r);
  if (cache.has(k)) return cache.get(k) ?? undefined;
  let out: Suite | null = null;
  const t = template(pkgs, r);
  if (t?.cls === SUITE_CLASS) {
    const sets: BloodSet[] = [];
    for (const sr of refsOf(t.values[0])) {
      const s = template(pkgs, sr);
      if (s?.cls !== SET_CLASS) continue;
      const materials = refsOf(s.values[0]);
      const textures = materials.map((m) => {
        const tex = resolveMaterialTexture(pkgs as PackageSet, m);
        return tex ? refKey(tex) : undefined;
      });
      sets.push({ ref: sr, minBlood: num(s.values[1]), materials, textures });
    }
    out = { ref: r, minReputation: num(t.values[1]), sets };
  }
  cache.set(k, out);
  return out ?? undefined;
}

/** Index of the last entry whose threshold is <= value (0 when none): the engine's loop. */
export function pickIndex(thresholds: readonly number[], value: number): number {
  let i = 0;
  while (i < thresholds.length && thresholds[i] <= value) i++;
  return Math.max(0, i - 1);
}

export const pickSuite = (suites: readonly Suite[], reputation: number) => pickIndex(suites.map((s) => s.minReputation), reputation);
export const pickSet = (suite: Suite, blood: number) => pickIndex(suite.sets.map((s) => s.minBlood), blood);

/** One skin channel: the suites (by reputation tier) for one model. */
export interface SkinChannel {
  suites: Suite[];
  /** Blood level ceiling and loss per second of the owner. */
  maxBlood: number;
  decay: number;
}

export interface PlayerSkins {
  /** p66: the third-person body. */
  body: SkinChannel;
  /** p67: the first-person arms. */
  arms: SkinChannel;
}

/** Player template p66 / p67 / p68 / p69. */
export function readPlayerSkins(pkgs: EntityPackageSet, player: ResRef = PLAYER_TEMPLATE): PlayerSkins | undefined {
  const t = template(pkgs, player);
  if (t?.cls !== 'Player') return undefined;
  const list = (i: number) => refsOf(t.values[i]).map((r) => readSuite(pkgs, r)).filter((s): s is Suite => !!s);
  const maxBlood = num(t.values[68], 50), decay = num(t.values[69], 0.5);
  return { body: { suites: list(66), maxBlood, decay }, arms: { suites: list(67), maxBlood, decay } };
}

/** Ranged / Melee Weapon p61 / p62 / p63 (undefined for other classes or without a suite). */
export function readWeaponSkin(pkgs: EntityPackageSet, weapon: ResRef): SkinChannel | undefined {
  const t = template(pkgs, weapon);
  if (t?.cls !== 'Ranged Weapon' && t?.cls !== 'Melee Weapon') return undefined;
  const suites = refsOf(t.values[61]).map((r) => readSuite(pkgs, r)).filter((s): s is Suite => !!s);
  return suites.length ? { suites, maxBlood: num(t.values[62], 100), decay: num(t.values[63], 0.5) } : undefined;
}

/** Default base texture ("pkg:id") of each material slot of a model (.mdu header). */
export function modelSlotTextures(pkgs: PackageSet, model: ResRef): (string | undefined)[] {
  const mdu = pkgs.get(model.pkg)?.mdu;
  const eh = findEntry(mdu, MDU_HEADER, model.id);
  if (!mdu || !eh || eh.size < 12) return [];
  const h = mdu.data(eh);
  let p = 8 + (h.getUint8(2) & 2 ? 4 : 0);
  const n = h.getUint32(p, true);
  p += 4;
  const out: (string | undefined)[] = [];
  for (let i = 0; i < n && p + 4 <= h.byteLength; i++, p += 4) {
    const tex = resolveMaterialTexture(pkgs, { id: h.getUint16(p, true), pkg: h.getUint16(p + 2, true) });
    out.push(tex ? refKey(tex) : undefined);
  }
  return out;
}

/** The set a channel shows: suite by reputation, set by blood level. */
export function skinFor(ch: SkinChannel, reputation: number, blood: number): { suite: number; set: number; textures: (string | undefined)[] } | undefined {
  if (!ch.suites.length) return undefined;
  const suite = ch.suites.length === 1 ? 0 : pickSuite(ch.suites, reputation);
  const s = ch.suites[suite];
  if (!s.sets.length) return undefined;
  const set = pickSet(s, blood);
  return { suite, set, textures: s.sets[set].textures };
}

/**
 * Blood Point Generator (class 0xd1856f97; the only template is FX 3:2305 = 5 / 10 / 50 / 360,
 * spawned by the Object Generator 3:1608 that two 1a scenes start) [verified, RFL 0x1000ff50]:
 * when spawned it adds blood to the player if he is within p2 model units and inside the cone
 * of p3 degrees (full angle) around the generator's forward axis: p0 at the edge of the range,
 * rising linearly to p1 at the generator. Returns 0 outside.
 */
export function bloodFromGenerator(values: readonly PropValue[], distance: number, angleDeg = 0): number {
  const edge = num(values[0]), centre = num(values[1]), reach = num(values[2]), cone = num(values[3], 360);
  if (!(reach > 0) || distance >= reach) return 0;
  if (Math.cos((angleDeg * Math.PI) / 180) < Math.cos((cone * Math.PI) / 360)) return 0;
  return edge + (centre - edge) * (1 - distance / reach);
}
