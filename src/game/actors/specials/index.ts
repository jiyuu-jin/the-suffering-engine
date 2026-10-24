// Creature special moves and bosses (docs/game-logic.md §15.7): registry by class name and
// the install hook the actors system calls (src/game/actors/system.ts).
//
//   installSpecials(ctx, manager, entities)  -> Specials
//     Creates the boss objects that are not Characters (Black One: a skinned Ground Object the
//     manager does not place), then gives every actor of a registered class its controller
//     through `Actor.special` (placed actors now, Object Cloner copies / spawned creatures when
//     the manager announces them).
//   specials.update(dt)      level-wide state (Ranged Targeting Positions, boss fights)
//   specials.died(actor)     true when the actor's special fired its own death outputs
//   specials.message(uid, msg, from)  level-logic message to a special (Black One inputs)
//
// Debug: window.__specials { runtime, events, list(), get(uid) }.

import type { GameContext } from '../../runtime';
import type { Entity, EntityPackageSet } from '../../../formats/entities';
import type { Actor } from '../actor';
import type { ActorManager } from '../manager';
import { SpecialRuntime, type SpecialFactory, type SpecialMove } from './runtime';
import { createNooseman } from './nooseman';
import { createBurrower } from './burrower';
import { createFester } from './fester';
import { createMainliner } from './mainliner';
import { createInferna } from './inferna';
import { createKilljoy } from './killjoy';
import { installProjectors } from './projector';
import { createHorace } from './horace';
import { createCartWheeler } from './cartwheeler';
import { createRat } from './rat';
import { placeBlackOnes } from './black-one';
import { RangedPositions } from './ranged-positions';

/** Special-move controllers by Character class name. */
export const SPECIAL_CLASSES: Readonly<Record<string, SpecialFactory>> = {
  Nooseman: createNooseman,
  Burrower: createBurrower,
  Fester: createFester,
  Mainliner: createMainliner,
  Inferna: createInferna,
  Killjoy: createKilljoy,
  Horace: createHorace,
  CartWheeler: createCartWheeler,
  Rat: createRat,
};

export interface Specials {
  readonly runtime: SpecialRuntime;
  update(dt: number): void;
  died(a: Actor): boolean;
  message(uid: number, msg: number, from: number): boolean;
  /** Saved state of the moves that keep one, by actor uid ('actors.specials' provider). */
  save(): SpecialsSaveState;
  load(state: SpecialsSaveState): void;
  dispose(): void;
}

/** [actor uid, the move's saved state] for every move with a save(). */
export type SpecialsSaveState = [number, unknown][];

export function installSpecials(ctx: GameContext, manager: ActorManager, entities: Entity[]): Specials {
  const pkgs = ctx.loaded.packages as EntityPackageSet;
  const byUid = new Map(entities.map((e) => [e.uid, e]));
  const rt = new SpecialRuntime(ctx, manager, pkgs, entities, byUid);
  const moves = new Map<Actor, SpecialMove>();
  const ranged = new RangedPositions(rt);

  const attach = (a: Actor, move: SpecialMove | undefined) => {
    if (!move) return;
    moves.set(a, move);
    rt.moves.set(a, move);
    if (move.rise) a.resurrect = (env) => !!move.rise?.(env);
    a.special = (dt, env) => {
      rt.time = env.time;
      return move.update(dt, env) || ranged.steer(a, dt, env);
    };
  };
  const adopt = (a: Actor) => {
    if (moves.has(a) || a.kind.decor || a.template) return;
    const make = SPECIAL_CLASSES[a.kind.className];
    if (make) attach(a, make(a, rt));
    else if (ranged.wants(a)) a.special = (dt, env) => ranged.steer(a, dt, env);
  };

  // Bosses that are not Characters: placed here and handed to the manager.
  for (const { actor, move } of placeBlackOnes(rt)) {
    manager.adopt(actor);
    attach(actor, move);
  }
  for (const a of manager.actors) adopt(a);
  const offProjectors = installProjectors(rt);
  const offSpawn = manager.on('spawn', (a) => adopt(a));

  const api = {
    runtime: rt,
    events: rt.events,
    ranged,
    list: () => [...moves].map(([a, m]) => ({ uid: a.uid, name: a.ch.root.name, alive: a.alive, ...m.info() })),
    of: (a: Actor) => moves.get(a)?.info(),
    get: (uid: number) => {
      const a = manager.get(uid);
      const m = a ? moves.get(a) : undefined;
      return a && m ? { actor: a, move: m, info: m.info() } : undefined;
    },
  };
  Object.assign(window, { __specials: api });

  return {
    runtime: rt,
    update(dt) {
      const env = manager.env;
      if (env) {
        rt.time = env.time;
        for (const t of rt.tickers) t(dt, env);
      }
      ranged.update(dt);
      // (Alive or dead: a placed character removed by a save's `removed` list, a body gibbed
      // before it, is never dead in the restored level, and its move must go too.)
      for (const [a, m] of moves) if (!manager.actors.includes(a)) {
        m.dispose?.();
        moves.delete(a);
        rt.moves.delete(a);
      }
    },
    died(a) {
      const m = rt.moves.get(a);
      const env = manager.env;
      return !!(m && env && m.died?.(env));
    },
    save() {
      const out: SpecialsSaveState = [];
      for (const [a, m] of rt.moves) {
        // (Removed actors are not the level's any more: save matrix, 1c / 2 gibs.)
        if (a.uid === undefined || !a.alive || !m.save || manager.get(a.uid) !== a) continue;
        const st = m.save();
        if (st !== undefined) out.push([a.uid, st]);
      }
      return out;
    },
    load(state) {
      for (const [uid, st] of state ?? []) {
        const a = manager.get(uid);
        const m = a ? rt.moves.get(a) : undefined;
        if (a?.alive) m?.load?.(st);
      }
    },
    message(uid, msg, from) {
      const a = manager.get(uid);
      const m = a ? rt.moves.get(a) : undefined;
      const env = manager.env;
      return !!(m && env && m.message?.(msg, from, env));
    },
    dispose() {
      offSpawn();
      offProjectors();
      for (const [a, m] of moves) {
        m.dispose?.();
        a.special = undefined;
      }
      moves.clear();
      if ((window as unknown as { __specials?: unknown }).__specials === api) delete (window as unknown as { __specials?: unknown }).__specials;
    },
  };
}
