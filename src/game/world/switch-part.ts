// A Switch's moving part: Switch p37 (docs/game-logic.md §11.1 "Moving part").
//
// [verified, Suffering.rfl] The Switch's post-create (vtable slot 3, 0x10132520) keeps the model
// it was placed with (engine object +0x64 -> Switch +0xba). Its post-load hook (slot 7, +0x1c:
// 0x101314d0 -> 0x101313b0) creates the p37 template at the switch's saved placement (+0x4a),
// then the two swap models through the engine's set-model (vtable +0xb8, as the Phone does with
// its receiver, 0x10015d30): the switch wears the p37 template's model, the new object the
// switch's own. The handle of the new object is kept at Switch +0xb8. The switch's motion
// (p55..p58) turns or slides the switch object, so only the part it now wears moves; the base
// stays where it was placed.
//
// The base takes the state colours [verified]: with a p32 list (flag 0x100, set by the post-create
// 0x101325cd and by the arrival 0x101314e0 -> 0x101317f8), the think (0x10132e00) calls
// 0x101308a0, which writes p32 (open, state bit 0x40) or p33 (closed) slot by slot into the
// material table of the object at +0xb8, when the list is as long as its model's table. So the
// breaker boxes' two lamps (7:557: 7:1729 / 7:1419 closed, 7:1417 / 7:1730 open) change when
// the lever comes to rest.
//
// Retail (all 18 levels, census in docs): 10 Switch templates, 46 instances, every one with a
// Breakable p37 whose model is the part the switch moves - levers 7:3 (on the 7:2 boxes of
// 7:4 / 7:11 / 12:731) and 7:556 (on the breaker boxes 7:557 / 7:492 of 7:12 / 7:13 / 7:1420),
// the buttons 7:5 / 7:644 / 7:1172 (7:6 / 7:1690 / 7:789: no travel), the 4b plunger 7:109
// (7:141, slides 0.26). Mechanisms have no such part: their post-create (0x100c84f0) spawns the
// p42 template at their placement without a swap (no retail Mechanism sets p42), and their
// models are the moving part alone (8b's valve wheel 7:1287, the cameras, fans and doors).

import { readObjectTemplate, classByHash, type Entity, type EntityPackageSet } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

export interface SwitchPart {
  /** The p37 template (a Breakable). */
  template: ResRef;
  /** Its class name and template flags (the base's collision rule). */
  cls: string;
  flags: number;
  /** The model the switch moves (the p37 template's). */
  model: ResRef;
}

const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as ResRef).id === 'number';

/** The p37 moving part of a Switch, when its template names a model. */
export function switchPart(e: Pick<Entity, 'className' | 'values'>, pkgs: EntityPackageSet): SwitchPart | undefined {
  if (e.className !== 'Switch') return undefined;
  const r = e.values[37];
  if (!isRef(r)) return undefined;
  const t = readObjectTemplate(pkgs, r);
  if (!t?.modelRef) return undefined;
  return { template: r, cls: classByHash(t.classHash)?.name ?? '', flags: t.flags, model: t.modelRef };
}

/**
 * The material table the base wears (0x101308a0): p32 open, p33 closed; undefined (the model's
 * own) when the list is empty or does not cover the model's table slot for slot.
 */
export function switchBaseMaterials(values: readonly unknown[], open: boolean, slots: number): (ResRef | null)[] | undefined {
  const list = values[open ? 32 : 33];
  if (!Array.isArray(list) || !list.length || list.length !== slots) return undefined;
  return list.map((x) => (isRef(x) ? x : null));
}

/** Does the base change colours at all (p32 set: the flag 0x100 path)? */
export function switchBaseSwaps(values: readonly unknown[]): boolean {
  const list = values[32];
  return Array.isArray(list) && list.length > 0;
}
