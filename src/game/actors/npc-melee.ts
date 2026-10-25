// Melee blows of characters as the original's Melee Weapon resolves them (Suffering.rfl; docs/
// game-logic.md §15.5, §13.9). The same weapon code serves the player's creature form
// (src/game/insanity/melee.ts) and every NPC / creature [verified unless marked]:
//
//   Weapons      Character p52 lists the weapons, p51 the bone each rides (bone indices; the
//                model's space is the bone's frame). A Melee Weapon's hit shape is its model's
//                type-7 nodes (formats/model-spheres.ts): a blade between two points or a sphere.
//   Arming       an attack clip's Arm event (100) arms the weapon held on the event's bone
//                (attachment set 0x10095750 -> 0x100ca210) and clears its list of victims; the next
//                Disarm (101) disarms it (0x100ca4c0, after at least one sweep). A clip without Arm
//                events deals no damage through the weapon.
//   Sweep        every frame while armed (0x100cb6c0 -> 0x100caff0) the shape is swept from where it
//                was to where it is now and tested against everything the collision query returns:
//                characters and the player by the leaf spheres of their skeleton sphere tree; the
//                wielder and what rides on it are left out (0x100c9ca0); there is no team test, so
//                a blade hurts whoever it passes through (friendly fire), each victim once per
//                Arm. A ray from the wielder (its x / z at the contact's height) to the contact
//                that is blocked cancels the blow (0x100c9490).
//   Damage       Melee Weapon p68, x the Attack's p6 when the victim is the attack's target (or it
//                has none) (0x100ca920); p70 the damage type. The character damage code ignores a
//                blow only when attacker and victim are both on the player's team (0x100e7390;
//                the same-team type-2 rule needs vt 0x98, which returns 0 on every character).
// So a blow lands only where the blade passes through the victim's body: a creature under a
// walkway swings at a player standing on it (the start test, Attack p15..p17, is horizontal
// for most attacks) but cannot reach him.

import * as THREE from 'three/webgpu';
import { sweepHit, type ArmWindow, type Vec3 } from '../insanity/melee';
import { readModelSphereNodes, weaponShape, type WeaponShape } from '../../formats/model-spheres';
import { classByHash, decodeTemplateProps, readObjectTemplate, type PropValue } from '../../formats/entities';
import type { PackageSet } from '../../formats/model';

/** A Melee Weapon a character holds (p51 bone / p52 template). */
export interface NpcMeleeWeapon {
  /** Bone index (p51). */
  bone: number;
  shape: WeaponShape;
  /** p68 (flat damage) and p70 (damage type). */
  damage: number;
  type: number;
}

const shapes = new Map<string, NpcMeleeWeapon | null>();
/** The Melee Weapons of a character's p51 / p52 (instance values first) with their hit shapes. */
export function readMeleeWeapons(pkgs: PackageSet, values: readonly PropValue[]): NpcMeleeWeapon[] {
  const list = (v: PropValue | undefined): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const bones = list(values[51]);
  const out: NpcMeleeWeapon[] = [];
  list(values[52]).forEach((r, i) => {
    const bone = bones[i];
    if (!r || typeof r !== 'object' || !('pkg' in r) || typeof bone !== 'number' || bone < 0) return;
    const ref = r as { pkg: number; id: number };
    const key = `${ref.pkg}:${ref.id}`;
    let w = shapes.get(key);
    if (w === undefined) {
      w = null;
      const t = readObjectTemplate(pkgs as never, ref);
      const c = t ? classByHash(t.classHash) : undefined;
      const mdu = t?.modelRef ? pkgs.get(t.modelRef.pkg)?.mdu : undefined;
      const shape = mdu && t?.modelRef ? weaponShape(readModelSphereNodes(mdu, t.modelRef.id)) : undefined;
      if (t && c?.name === 'Melee Weapon' && shape) {
        const v = decodeTemplateProps(c, t);
        w = { bone: -1, shape, damage: typeof v[68] === 'number' ? v[68] : 0, type: typeof v[70] === 'number' ? v[70] : 0 };
      }
      shapes.set(key, w);
    }
    if (w) out.push({ ...w, bone });
  });
  return out;
}

export interface HitSphereLike {
  c: Vec3;
  r: number;
  /** The bone the sphere follows (the struck sphere's bone goes with the blow: Part Caps). */
  bone?: number;
}

// sweepHit (the first leaf in node index order the swept shape meets, 0x100c9680) lives in
// insanity/melee.ts: the creature form's claws strike the same way.
export { sweepHit } from '../insanity/melee';

/** sweepHit's contact point on the weapon, or null. */
export function sweepSpheres(prevA: Vec3, prevB: Vec3, curA: Vec3, curB: Vec3, r: number, spheres: readonly HitSphereLike[], steps = 6): Vec3 | null {
  return sweepHit(prevA, prevB, curA, curB, r, spheres, steps)?.p ?? null;
}

/** Damage of a blow (0x100ca920): p68, x the Attack's p6 on the attack's own target. */
export function npcBlowDamage(w: Pick<NpcMeleeWeapon, 'damage'>, attackScale: number, onTarget: boolean): number {
  return w.damage * (onTarget ? attackScale : 1);
}

/** One Arm window of the swing under way. */
export interface SwingWindow {
  w: ArmWindow;
  weapon: NpcMeleeWeapon;
  node: THREE.Object3D;
  prev?: [Vec3, Vec3];
  swept: boolean;
  hit: Set<unknown>;
}

const _v = new THREE.Vector3();
/** The shape's two points (a sphere: its centre twice) through the bone's world matrix. */
export function shapeWorld(shape: WeaponShape, node: THREE.Object3D): [Vec3, Vec3] {
  node.updateWorldMatrix(true, false);
  const m = node.matrixWorld;
  _v.set(shape.a[0], shape.a[1], shape.a[2]).applyMatrix4(m);
  const a: Vec3 = [_v.x, _v.y, _v.z];
  if (!shape.b) return [a, a];
  _v.set(shape.b[0], shape.b[1], shape.b[2]).applyMatrix4(m);
  return [a, [_v.x, _v.y, _v.z]];
}
