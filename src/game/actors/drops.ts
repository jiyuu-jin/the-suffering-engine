// What a character's hand weapons do when it dies [verified: Character death 0x100e5d00 ->
// 0x100e12f0, body-part sets 0x10095d10 / 0x10096400, item drop 0x10096c20 -> 0x100be330 ->
// 0x100bd300]:
//  - The p51 / p52 hand weapons exist only when p53 is set: creation spawns the p52 set only
//    with p53 (0x10096400, flag bit 1 from 0x10095d10's p53 argument); otherwise only a
//    SpawnWeapons clip event (153) puts them in the hand. 1a's posed corpses have p53 = 0 (no
//    gun), the guard 609e and the gas chamber guards 782b / 7831..7833 have p53 = 1.
//  - At death p109 says what happens to them: 1 they drop, 2 they are destroyed, 0 they stay
//    (p110 does the same for the p54 / p55 body parts; p109 == p110 lets that one pass handle
//    both).
//  - A dropped Item with a p27 template is replaced by that template at its position
//    (0x100bd300; guard revolver 10:1801 / 10:1802 -> Ammo Box 4:1404, which gives the
//    Revolver 4:5); without one it falls as itself. The player's own weapons leave p27 empty.
// Whether the set is in the hand: p53, or a SpawnWeapons clip event (153) the character played
// (weapons/npc.ts tracks it; callers pass `inHand`).
//  - The drop leaves the hand where it is [verified: 0x10096c20 detaches the item at its attached
//    pose; 0x100bd300 spawns the p27 template at that item's matrix and removes the item, or else
//    puts the item itself in its dropped state (+0x94 = 2, engine physics mode 4); both give it a
//    body first (collision interface vt+0x10 with 0.766 / 0.4, a three-point rigid body under
//    gravity, SUFFERING.EXE 0x42aae0 / 0x42adf0)]. The port lets it fall from the hand's world
//    pose and velocity (world/drop-fall.ts).

import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as object);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter(isRef);

/** What happens to a character's hand weapons at its death (instance values). */
export function deathWeaponMode(values: readonly PropValue[], inHand: boolean = !!values[53]): 'drop' | 'destroy' | 'keep' {
  if (!inHand) return 'keep'; // none in the hand
  return values[109] === 1 ? 'drop' : values[109] === 2 ? 'destroy' : 'keep';
}

/** Pickup templates a character with these instance values drops on death. */
export function deathDrops(pkgs: EntityPackageSet, values: readonly PropValue[], inHand?: boolean): ResRef[] {
  return deathDropPairs(pkgs, values, inHand).map((d) => d.drop);
}

/** The same, with the hand weapon (p52 entry) each pickup replaces. */
export function deathDropPairs(pkgs: EntityPackageSet, values: readonly PropValue[], inHand?: boolean): { weapon: ResRef; drop: ResRef }[] {
  if (deathWeaponMode(values, inHand) !== 'drop') return [];
  const out: { weapon: ResRef; drop: ResRef }[] = [];
  for (const w of refs(values[52])) {
    const t = readObjectTemplate(pkgs, w);
    const cls = t ? classByHash(t.classHash) : undefined;
    if (!t || (cls?.name !== 'Ranged Weapon' && cls?.name !== 'Melee Weapon')) continue;
    const drop = decodeTemplateProps(cls, t)[27];
    if (isRef(drop)) out.push({ weapon: w, drop });
  }
  return out;
}
