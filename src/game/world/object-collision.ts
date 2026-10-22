// Which placed objects collide, and how (docs/game-logic.md §14.10).
//
// Geometry: an object collides with its model's type-7 collision tree, not its drawn triangles
// (formats/model-collision.ts). Classes [verified, Suffering.rfl]: a mover's query turns on only
// the classes of its collide list (docs/game-logic.md §14.9): a character's 18 classes at
// 0x10178c40, the player's 20 at 0x101509c0. Of those, Detector is touch-only, a Water Volume
// contact goes to the water-effects component and never blocks (docs/levels.md), Fire and
// Particle Fountain are touch volumes (dynamic.ts), and Collider is a character's own proxy: none
// of them blocks. Light Housing, Mountable, Security Monitor, Quest Item Pickup and Electric
// Shield are in the player's list only: they stop the player, not characters. Rays (sight, shots,
// the use ray) see what either list collides with [inferred: the ray queries take the scene's
// class filter as their caller left it, not traced].
// Sight: the characters' line of sight (0x100c7270, flags 0xa00 from 0x100e25ed) passes objects
// whose engine object +8 has bit 0x20000 (query 0x100c6c13). The instance loader (SUFFERING.EXE
// 0x45a77f..0x45a7c4) sets that bit from template flag bit 10, or with instance flag 0x2000 from
// instance bit 0x1000000 [verified]. 1a: 385 Static Objects, the cell doors (Switch 9:2027), the
// lamps; 9: 163 Static Objects with the burial-ground trees.

import { readObjectTemplate, classByHash, type EntityPackageSet } from '../../formats/entities';
import type { LevelObject, ObjectCollision } from '../../formats/level';
import type { PackageSet } from '../../formats/model';
import type { SrscFile } from '../../formats/srsc';
import { COLLISION_LAYER } from '../../app/physics';
import { objectCollisionProviders } from '../../app/loader';

/** Classes both lists name that block (the lists less the touch / water / proxy classes). */
export const BLOCKING_CLASSES = new Set([
  'Static Object',
  'Invisible Static Object',
  'Animating Static',
  'Mechanism',
  'MorphingModel',
  'Pressure Plate',
  'Switch',
  'Ladder',
  'Breakable',
  'TargetableBreakable',
  'Pushable',
  'Phone',
  'Toilet',
]);

/** Classes only the player's list names (0x101509c0). */
export const PLAYER_ONLY_CLASSES = new Set(['Light Housing', 'Mountable', 'Security Monitor', 'Quest Item Pickup', 'Electric Shield']);

/** Does AI sight pass the object (engine +8 bit 0x20000)? `templateFlags`: template record +4. */
export function sightPasses(instanceFlags: number, templateFlags: number): boolean {
  return instanceFlags & 0x2000 ? !!(instanceFlags & 0x1000000) : !!(templateFlags & 0x400);
}

/** How an object of class `cls` collides; null = it does not. */
export function collisionForClass(cls: string | undefined, instanceFlags: number, templateFlags: number): ObjectCollision | null {
  if (!cls) return null;
  const sightPass = sightPasses(instanceFlags, templateFlags);
  if (BLOCKING_CLASSES.has(cls)) return { layers: COLLISION_LAYER.solid, rayLayers: COLLISION_LAYER.decor, sightPass };
  if (PLAYER_ONLY_CLASSES.has(cls)) return { layers: COLLISION_LAYER.player | COLLISION_LAYER.decor, rayLayers: COLLISION_LAYER.decor, sightPass };
  return null;
}

/** LevelExtras.collisionOf for a level (one template read per distinct template). */
export function objectCollision(_lvl: SrscFile, packages: PackageSet): (o: LevelObject) => ObjectCollision | null {
  const templates = new Map<string, { cls?: string; flags: number } | null>();
  return (o) => {
    const k = `${o.template.pkg}:${o.template.id}`;
    let t = templates.get(k);
    if (t === undefined) {
      const d = readObjectTemplate(packages as EntityPackageSet, o.template);
      templates.set(k, (t = d ? { cls: classByHash(d.classHash)?.name, flags: d.flags } : null));
    }
    return t ? collisionForClass(t.cls, o.flags, t.flags) : null;
  };
}

if (!objectCollisionProviders.includes(objectCollision)) objectCollisionProviders.push(objectCollision);
