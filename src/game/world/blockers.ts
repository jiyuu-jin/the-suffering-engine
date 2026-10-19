// Invisible Static Object: the original's invisible collision boxes ("player clips").
//
// Designers close off places the level geometry leaves open with boxes of this class (System
// model 2:171, the unit cube, sized by the instance scale). 1a's ceiling rubble of "Gaurd" #114
// is a skinned prop with no collision data of its own; three of these boxes (72c2, 7658, 7659)
// are what keeps the player from walking through it and out of the level. The port did not
// build them at all (docs/game-logic.md §14.7).
//
// Original (Suffering.rfl) [verified]:
//   * constructor 0x10020110: SetVisible(0) on its engine object (vtable +0x128): never drawn,
//     whatever instance flag 0x1 says;
//   * input slots p7 (On) / p8 (Off), handlers 0x100bc940 / 0x100bc920: clear / set engine object
//     +8 bit 0x400000 (the engine's per-object "no collision" bit; the collision gather
//     0x425a80 skips objects carrying it); saved and restored with the object (0x100bc960 / 980);
//   * block test 0x100bc9d0 (asked for the moving object): nothing while Off; otherwise it blocks
//     unless the mover is of a kind whose flag is 0: p1 the Player (class 0xc8bc44e1), p2 engine
//     object type 7 (characters), p3 Pushable, p4 engine object type 10 [unknown kind], p5
//     Missile / BouncingObject / Lightning. p0 and p6 are not read there.
// Port: one dynamic body per box with those filters as COLLISION_LAYER bits (src/app/physics.ts):
// the player's motor sees `player` boxes, the push test `pushable` ones, thrown objects
// `projectile` ones; the plain queries (sight, the use ray, shots, decals) see none of them.
// p2 is kept on the body but no NPC motor asks for it: what engine object type 7 is was not
// identified, and the data says it is not "every character": 1b's CartWheeler 6501 is placed
// inside the p2-only box 8c2b, and 1a "Gaurd" #86 releases its guard beyond the rubble boxes (so
// NPCs move as before). p4 has no port mover. On / Off is kept in the entity state
// (`s.collisionOff`), which the world save carries.

import * as THREE from 'three/webgpu';
import { readObjectTemplate, type Entity, type EntityPackageSet } from '../../formats/entities';
import { parseLevelObjects } from '../../formats/level';
import { readModel, type PackageSet } from '../../formats/model';
import type { SrscFile } from '../../formats/srsc';
import { moverPassObjectProviders } from '../../app/loader';
import { COLLISION_LAYER, type CollisionWorld } from '../../app/physics';
import { instanceMatrix } from './dynamic';
import type { World, WorldEntity } from './logic';

/**
 * Which placed classes a mover collides with [verified, Suffering.rfl]. A mover's query first
 * clears the scene's per-class collision filter (the world's filter object +0x580, SUFFERING.EXE
 * vtable 0x58c5a8: +4 = 0x424550 clears bit 1 of every class) and then turns on only the classes
 * of its list (+0x24 = 0x4245a0); the gather (0x425e50) keeps an object whose class has bit 1.
 * - A character's mover (0x1009fb80 -> 0x1009ee20) uses the collide list the Character
 *   constructor hands it (0x100e5123: 18 classes at 0x10178c40) plus Detector: Static Object,
 *   Invisible Static Object, Animating Static, Mechanism, MorphingModel, Pressure Plate, Switch,
 *   Ladder, Breakable, TargetableBreakable, Pushable, Detector, Particle Fountain, Fire, Water
 *   Volume, Phone, Toilet, Collider.
 * - The player's movement query (0x1002c340 with 1) turns on Detector and the 20 classes at
 *   0x101509c0 (docs/levels.md, Water Volume).
 * Neither names Decoration (class 0x10d88bf0, category 12 "Special Effect"): its models (9's fog
 * quads 3:440 over the burial ground, cables, papers, posters, the lamp's beam) never stop a
 * mover. Sight, shots and the use ray keep seeing them (not decoded). 9 Lighthouse: four 12 m fog
 * quads 3:440 lie 0.42..0.48 m over the burial ground; the Infernas c9b / c9c walked into them
 * and stood on them or under them (docs/game-logic.md §14.9).
 */
export const DECORATION_CLASS = 0x10d88bf0;

/** Placed Decoration uids (one template read per distinct template). */
export function decorationUids(lvl: SrscFile, packages: PackageSet): number[] {
  const isDeco = new Map<string, boolean>();
  const out: number[] = [];
  for (const o of parseLevelObjects(lvl)) {
    const k = `${o.template.pkg}:${o.template.id}`;
    let d = isDeco.get(k);
    if (d === undefined) isDeco.set(k, (d = readObjectTemplate(packages as EntityPackageSet, o.template)?.classHash === DECORATION_CLASS));
    if (d) out.push(o.uid);
  }
  return out;
}

if (!moverPassObjectProviders.includes(decorationUids)) moverPassObjectProviders.push(decorationUids);

export const BLOCKER_CLASS = 'Invisible Static Object';

/** COLLISION_LAYER bits of a box from its p1..p5 filters (0: blocks nothing the port moves). */
export function blockerLayers(values: readonly unknown[]): number {
  const on = (i: number) => typeof values[i] === 'number' && values[i] !== 0;
  return (
    (on(1) ? COLLISION_LAYER.player : 0) |
    (on(2) ? COLLISION_LAYER.character : 0) |
    (on(3) ? COLLISION_LAYER.pushable : 0) |
    (on(5) ? COLLISION_LAYER.projectile : 0)
  );
}

/** World-space triangles of a box (its model at the instance placement and scale). */
export function blockerParts(e: Entity, packages: PackageSet): { positions: Float32Array; indices: Uint32Array }[] {
  const m = e.modelRef && readModel(packages, e.modelRef);
  if (!m) return [];
  const s = e.scale ?? [1, 1, 1];
  const M = instanceMatrix(e.position, e.rotation);
  const v = new THREE.Vector3();
  const positions = new Float32Array(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    v.set(m.positions[i] * s[0], m.positions[i + 1] * s[1], m.positions[i + 2] * s[2]).applyMatrix4(M);
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
  }
  const n = m.submeshes.reduce((k, sm) => k + sm.indices.length, 0);
  const indices = new Uint32Array(n);
  let o = 0;
  for (const sm of m.submeshes) (indices.set(sm.indices, o), (o += sm.indices.length));
  return [{ positions, indices }];
}

export class InvisibleBlockers {
  private readonly bodies = new Map<number, number>();
  private readonly list: WorldEntity[] = [];

  constructor(
    private readonly world: World,
    packages: PackageSet,
    private readonly collision: CollisionWorld | null,
  ) {
    if (!collision) return;
    for (const w of world.of(BLOCKER_CLASS)) {
      const layers = blockerLayers(w.e.values);
      const parts = layers ? blockerParts(w.e, packages) : [];
      if (!parts.length) continue;
      this.bodies.set(w.uid, collision.addDynamic(parts, this.isOn(w), layers));
      this.list.push(w);
    }
    // p7 On / p8 Off (input slots).
    world.handlers.push((w, msg) => {
      if (w.cls !== BLOCKER_CLASS) return false;
      const v = w.e.values;
      if (msg === v[7]) delete w.s.collisionOff;
      else if (msg === v[8]) w.s.collisionOff = true;
      else return false;
      this.sync(w);
      return true;
    });
  }

  get count() {
    return this.bodies.size;
  }

  /** Body of a box (tests / debug). */
  body(uid: number): number | undefined {
    return this.bodies.get(uid);
  }

  private isOn(w: WorldEntity) {
    return !w.destroyed && !w.s.collisionOff;
  }

  private sync(w: WorldEntity) {
    const b = this.bodies.get(w.uid);
    if (b !== undefined) this.collision?.setDynamicEnabled(b, this.isOn(w));
  }

  /** Follow the entity state (a loaded save replaces it without messages). */
  update() {
    for (const w of this.list) this.sync(w);
  }

  dispose() {
    for (const b of this.bodies.values()) this.collision?.removeDynamic(b);
    this.bodies.clear();
    this.list.length = 0;
  }
}
