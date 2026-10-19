// Light Housing (lamp fixtures) as the original runs them: Suffering.rfl class 0x9aa22111,
// constructor 0x10016c20, vtable 0x1014c820 (docs/game-logic.md §14.4). Pure rules; props.ts
// applies them to the meshes, the linked lights and the spawned decorations.
//
// State [verified]: the object keeps one state word (+0xa8): 0 off, 1 on, 2 broken. Init
// (vtable +0x0c, 0x100162b0) sets it from **p31** (so p31 = on at start); the post-load hook
// (+0x1c, 0x10016da0) and every change (On 0x10017050, Off 0x10017070, Use toggles 0 <-> 1 at
// 0x10017090, the killed hook +0x90 sets 2 at 0x10017010) run the apply function 0x100166d0:
//
//   state      materials   spawned at the lamp   sent to the linked lights + p34 spawns   p43 objects
//   1 on       p32         p40                   the message in p38 (On)                  shown
//   0 off      p33         p41                   the message in p39 (Off)                 hidden
//   2 broken   unchanged   p42                   none: they are removed                   removed
//
// - Materials [verified]: the list replaces the model instance's material table slot by slot
//   (slot i = list[i]), and only when the list has exactly as many entries as the model has
//   materials (0x100168f6: count compared with the table's +0xc); otherwise the model keeps its
//   own. p32 holds the "on" materials (Advanced, tinted: drawn texture x tint, unlit), p33 the
//   "off" ones (Simple, lit).
// - Spawns [verified]: the previous state's spawns are removed and the new list is created at
//   the lamp's transform (0x10016ae0..0x10016bf0); p42 is the broken remains (a Breakable such as
//   9:3402, the cell-block shade without its bulb), p40 / p41 the glow cones and light pools.
// - Lights [verified]: the post-load hook collects the lamp's links whose category is Light
//   Source (engine type 0xe at +0xe4, via the links list vtable +0x118 / +0x120, the same calls
//   the message filters use to forward to their links) together with the p34 spawns (the
//   fluorescent hum Sound Effect 3:1529). On / off sends them the message held in p38 / p39
//   (dispatcher vt[0] with the property index); breaking removes them (vtable +0x30) and clears
//   the list, so a broken lamp's light stays off.
// - p43 [strong]: uids of placed objects (in the retail data, 60 Decorations of category
//   Special Effect: light pools on the floor under the lamp) set visible / hidden with the state
//   (vtable +0x128 with 1 / 0) and removed when the lamp breaks.
//
// The start state wins over the light's own p6: the post-load apply sends p39 (Off) to the
// lights of a lamp with p31 = 0, so e.g. 1a's fluorescent rooms behind light switch 6847 start
// dark although their Point Lights have p6 = 1.

import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

export const HOUSING_OFF = 0;
export const HOUSING_ON = 1;
export const HOUSING_BROKEN = 2;
export type HousingState = typeof HOUSING_OFF | typeof HOUSING_ON | typeof HOUSING_BROKEN;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (x: unknown): x is ResRef => !!x && typeof x === 'object' && !Array.isArray(x);
const list = (v: unknown): (ResRef | null)[] => (Array.isArray(v) ? v.map((x) => (isRef(x) ? x : null)) : []);

/** p31: the state the lamp starts in (init 0x100162b0): 1 on, anything else off. */
export function housingStartState(values: readonly PropValue[]): HousingState {
  return num(values[31]) === 1 ? HOUSING_ON : HOUSING_OFF;
}

export interface HousingLook {
  /** Material table to apply slot by slot; undefined = the model keeps the materials it has. */
  materials?: (ResRef | null)[];
  /** Templates spawned at the lamp for this state (the previous state's are removed). */
  spawns: ResRef[];
  /** Message sent to the linked lights and the p34 spawns; undefined when broken (removed). */
  message?: number;
  /** What happens to the p43 objects. */
  extras: 'show' | 'hide' | 'remove';
}

/**
 * What a lamp in `state` looks like (0x100166d0). `materialCount` is the number of materials of
 * the lamp's model; a list of another length is not applied.
 */
export function housingLook(values: readonly PropValue[], state: HousingState, materialCount: number | undefined): HousingLook {
  const fit = (l: (ResRef | null)[]) => (materialCount !== undefined && l.length > 0 && l.length === materialCount ? l : undefined);
  if (state === HOUSING_BROKEN) return { spawns: refsOf(values[42]), extras: 'remove' };
  const on = state === HOUSING_ON;
  return {
    materials: fit(list(values[on ? 32 : 33])),
    spawns: refsOf(values[on ? 40 : 41]),
    message: num(values[on ? 38 : 39], on ? 1 : 2) || undefined,
    extras: on ? 'show' : 'hide',
  };
}

/** The lamp's links that it switches: those of category Light Source (engine type 0xe). */
export function housingLights<T extends { category: string }>(links: readonly number[], get: (uid: number) => T | undefined): number[] {
  return links.filter((u) => get(u)?.category === 'Light Source');
}

/** p43: placed objects shown with the lamp (uids). */
export function housingExtras(values: readonly PropValue[]): number[] {
  const v = values[43];
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > 0) : [];
}

function refsOf(v: unknown): ResRef[] {
  return list(v).filter((x): x is ResRef => !!x);
}
