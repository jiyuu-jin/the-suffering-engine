// Killjoy: the 5b fight (docs/game-logic.md §15.7.8). Decoded from Suffering.rfl:
// KilljoyRootBehavior 0x1007bd70 / 0x1007bea0 / 0x1007c000, KilljoyRaiseDeadBehavior 0x1007c170 /
// 0x1007bcc0 / 0x1007c330, Projector Effect vt[4] 0x1008c080 / vt[8] 0x1008c4c0.
//
// Killjoy has no attack of his own. Under KilljoyRootBehavior (placed, p2 = the corpses he
// tends) he runs his FleeBehavior (Character p77) with a LookAt on the player; whenever one of
// his corpses is dead (scanning the list from the end) he stops, runs to it (MoveTo), plays
// RaiseDead p2 (10:510) and brings it back (Resurrection: CartWheeler p160 % health, its rise
// clip). The behaviour itself is generic actor code (actor.ts runKilljoy, behaviours 'killjoy' /
// 'raiseDead' decoded in behaviors.ts); this move only reports it.
// He is a projection: his Projector Effect (projector.ts; 5b #1501, p0 = Killjoy) shows him,
// draws him at opacity p6 % + (p5 % - p6 %) x f + rand(-1, 1) x p4 %, f = share of its projectors
// (p10, Animating Statics with 15 HP) still standing, stretches the light cones of his model to
// their lenses, and when the last one breaks it deals him 10000 damage.
// The level does the rest (each break -> Relay #164c -> a taunt conversation chained back to
// KilljoyRoot; the fifth -> Relay #1bf8 -> Destroy, Archives Trigger, STOMP 28:21).

import type { Actor } from '../actor';
import type { SpecialMove, SpecialRuntime } from './runtime';

class Killjoy implements SpecialMove {
  readonly name = 'killjoy';

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {}

  info() {
    const a = this.a as unknown as { behavior?: { kind: string }; b?: { kj?: { list: number[]; raise?: { corpse: Actor; phase: string } } } };
    const kj = a.b?.kj;
    return {
      kj: a.behavior?.kind === 'killjoy' ? (kj?.raise ? kj.raise.phase : 'flee') : 'off',
      targets: kj?.list.length ?? 0,
      corpse: kj?.raise?.corpse.uid?.toString(16),
    };
  }

  /** The generic AI runs him (actor.ts runKilljoy). */
  update(): boolean {
    return false;
  }
}

export const createKilljoy = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Killjoy(a, rt);
