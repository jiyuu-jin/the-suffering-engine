// Companions carried through level transitions (docs/game-logic.md §15.9, docs/campaign.md).
//
// [data] A Level Transition's p7 lists the objects it carries (1c -> 2: the inmate 0x7569;
// 9 -> 10 one more). The target level has its own placed copy of the companion: the Player
// Spawn Point the player arrives at names it in p4 and the Companion Spawn Point it appears
// at in p5 (2 Cellblocks "East Spawn": p4 = [0x868], p5 = [0x1bf0]). The Companion Spawn
// Point (one property, p0 = 1) passes its p0 message to its links when the companion arrives
// (2: Timer 0x933, which starts the follower's scene) [inferred from the wiring].
//
// Port: when a transition with p7 receives its transition input, the carried characters' state
// (alive, health) is kept in module scope (it survives the level reload); in the next level the
// placed copy named by the arrival point is moved to the Companion Spawn Point with that
// health, or removed when the companion died before the transition. The spawn point's message
// then goes out. Loading a save never applies a carry (the save has the actors' state).

import type { Entity } from '../../formats/entities';
import { instanceRotation, toOutputSpace } from '../../formats/level';
import type { Actor } from './actor';
import type { ActorManager } from './manager';

export interface CarriedCompanion {
  uid: number;
  /** Template ref "pkg:id" (matches the placed copy in the target level). */
  template: string;
  alive: boolean;
  health: number;
  maxHealth: number;
}

interface Carry {
  /** Level left (path as the engine names it: "Levels\\1 PrisonDeathRow\\1c PrisonDeathRow.lvl"). */
  from: string;
  objects: CarriedCompanion[];
}

/** Survives level reloads (the actors system is re-created per level). */
let carry: Carry | null = null;

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/^.*?levels\//, 'levels/');
const uidList = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && x > 0);

/** The transition `t` fires in `levelPath`: remember the state of the characters it carries (p7). */
export function recordCarry(levelPath: string, t: Entity, manager: ActorManager) {
  const uids = uidList(t.values[7]);
  if (!uids.length) return;
  const objects: CarriedCompanion[] = [];
  for (const uid of uids) {
    const a = manager.get(uid);
    if (!a?.entity) continue;
    const tp = a.entity.template;
    objects.push({ uid, template: `${tp.pkg}:${tp.id}`, alive: a.alive, health: a.health, maxHealth: a.maxHealth });
  }
  carry = objects.length ? { from: levelPath, objects } : null;
}

/** Debug / tests. */
export function pendingCarry(): Readonly<Carry> | null {
  return carry;
}

export function clearCarry() {
  carry = null;
}

export interface ArrivedCompanion {
  actor: Actor;
  /** Companion Spawn Point it was placed at. */
  point?: Entity;
}

/**
 * Arriving in a level by `spawnName` after a carry: place the arrival point's companions (p4)
 * at its Companion Spawn Points (p5). Returns the companions placed (empty when nothing applies).
 * The carry is used up either way.
 */
export function applyCarry(
  spawnName: string | undefined,
  entities: readonly Entity[],
  manager: ActorManager,
  /** String property value (the actors system parses entities without resolving strings). */
  str: (v: unknown) => string = (v) => (typeof v === 'string' ? v : ''),
): ArrivedCompanion[] {
  const c = carry;
  carry = null;
  if (!c) return [];
  const from = norm(c.from);
  // A transition without spawn names (9 -> 10: Level Transition ca6) arrives at the point that
  // names the level left (docs/campaign.md §1, world.ts): its companions are placed the same way.
  const want = (spawnName ?? '').toLowerCase();
  const point = entities.find(
    (e) =>
      e.className === 'Player Spawn Point' &&
      str(e.props.spawnName).toLowerCase() === want &&
      norm(str(e.props.fromLevel)).endsWith(from.slice(from.lastIndexOf('/') + 1)),
  );
  if (!point) return [];
  const companions = uidList(point.values[4]);
  const spots = uidList(point.values[5]);
  const byUid = new Map(entities.map((e) => [e.uid, e]));
  const out: ArrivedCompanion[] = [];
  companions.forEach((uid, i) => {
    const a = manager.get(uid);
    if (!a?.entity) return;
    const tp = a.entity.template;
    const key = `${tp.pkg}:${tp.id}`;
    const carried = c.objects.find((o) => o.template === key) ?? (c.objects.length === companions.length ? c.objects[i] : undefined);
    if (!carried) return;
    if (!carried.alive) {
      // Died before the transition: no companion in this level either [inferred].
      manager.remove(a);
      return;
    }
    const spot = byUid.get(spots[i] ?? spots[0]);
    if (spot) {
      const [x, y, z] = toOutputSpace(spot.position);
      a.motor.teleport(x, y, z);
      const R = instanceRotation(spot.rotation);
      a.yaw = Math.atan2(R[2], R[8]);
      a.needsPlacement = true;
      a.sync();
    }
    a.maxHealth = Math.max(a.maxHealth, carried.maxHealth);
    a.health = Math.min(a.maxHealth, carried.health);
    out.push({ actor: a, point: spot });
  });
  return out;
}
