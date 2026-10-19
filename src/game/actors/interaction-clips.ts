// Player-body clips for the continuous interactions (ladders, pushing): src/game/world/interact.ts
// drives the movement; this picks the clips the original names in each interactable's templates
// and plays them through the player-body clip API, player-body.ts. The one-shot use animations
// (phone, monitor, toilet, switches, quest item spots) are the Interact state in
// src/game/world/use-anim.ts. docs/game-logic.md §14.5.
//
// Clip slots [data: template layout; roles inferred from each clip's root motion and the
// hand / head heights of the posed rig (rig 328), see the doc]:
//   Ladder p32 = [bottom, top] Ladder Interaction Properties: p13 mount clip (bottom: up 0.5 m
//     onto the rungs; top: turn and climb down 1.5 m onto them).
//   Ladder p33 Ladder Animation Set: p0 / p1 one rung up (0.5 m, alternate hands), p2 / p3 one
//     rung down, p4 / p5 hold still (after p0 / p1), p6 step off at the top, p7 step off at
//     the bottom, p8 slide down, p9 / p10 let go / jump off [p8..p10 unused here].
//   Pushable p32 Pushable Interaction Properties (one per side, same clips): p22 grab pose,
//     p23 push forward (1 m per cycle), p24 lean on it (idle), p25 pull back, p26 strain.

import type { PropValue, EntityPackageSet } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

/** The parts of services.actors.playerBody used here (player-body.ts). */
export interface PlayerBodyClips {
  play(clip: ResRef | string, o?: { loop?: boolean; fade?: number; lock?: boolean; timeScale?: number; inPlace?: boolean; onEnd?: () => void }): number;
  release(fade?: number): void;
  setRate(ts: number): void;
  readonly overriding: boolean;
  readonly dead?: boolean;
}

const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? { pkg: v.pkg, id: v.id } : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');

/** One rung (Ladder Animation Set p0..p3): 0.5 m per clip. */
const RUNG = 0.5;

export class InteractionClips {
  private cache = new Map<string, PropValue[] | null>();
  private mode: 'none' | 'ladder' | 'push' = 'none';
  private ladder?: { set: PropValue[]; hand: 0 | 1; moving: number; exiting: boolean };
  private pushClip = '';

  constructor(
    private readonly pkgs: EntityPackageSet,
    private readonly body: () => PlayerBodyClips | null | undefined,
  ) {}

  private tpl(r: ResRef | undefined): PropValue[] | undefined {
    if (!r) return undefined;
    const k = `${r.pkg}:${r.id}`;
    if (!this.cache.has(k)) {
      const t = readObjectTemplate(this.pkgs, r);
      const c = t ? classByHash(t.classHash) : undefined;
      this.cache.set(k, t && c ? decodeTemplateProps(c, t) : null);
    }
    return this.cache.get(k) ?? undefined;
  }

  /** Stop whatever interaction clip runs (back to locomotion). */
  end() {
    if (this.mode !== 'none') this.body()?.release(0.2);
    this.mode = 'none';
    this.ladder = undefined;
    this.pushClip = '';
  }

  // --- Ladder ------------------------------------------------------------------

  /** Getting onto a ladder (Ladder entity values); `top`: from the landing above. */
  ladderMount(ladder: PropValue[], top: boolean) {
    const b = this.body();
    const set = this.tpl(ref(ladder[33]));
    if (!b || !set) return;
    this.mode = 'ladder';
    this.ladder = { set, hand: 0, moving: 0, exiting: false };
    const ip = this.tpl(refs(ladder[32])[top ? 1 : 0]);
    const mount = ref(ip?.[13]);
    const hold = () => this.ladderHold();
    if (!mount || !b.play(mount, { inPlace: true, fade: 0.1, onEnd: hold })) hold();
  }

  private ladderHold() {
    const l = this.ladder;
    const r = l && ref(l.set[4 + l.hand]);
    if (l && r) this.body()?.play(r, { loop: true, fade: 0.1, inPlace: true });
  }

  /**
   * Called every climbing frame with the climb direction (+1 up, -1 down, 0 still) and the
   * climbing speed (m/s): one rung clip per 0.5 m, alternating hands.
   */
  ladderClimb(dir: number, speed: number) {
    const l = this.ladder;
    const b = this.body();
    if (!l || !b || l.exiting || this.mode !== 'ladder') return;
    const d = Math.sign(dir);
    if (d === l.moving) return;
    l.moving = d;
    if (!d) return this.ladderHold();
    const step = () => {
      if (!this.ladder || this.ladder.moving !== d || this.ladder.exiting) return;
      const r = ref(l.set[(d > 0 ? 0 : 2) + l.hand]);
      l.hand = l.hand ? 0 : 1;
      const len = r ? b.play(r, { inPlace: true, fade: 0.08, onEnd: step }) : 0;
      // Rate so one clip covers one rung at the climbing speed.
      if (len > 0) b.setRate(Math.max(0.5, Math.min(3, (speed * len) / RUNG)));
    };
    step();
  }

  /** Stepping off at the top (p6) or bottom (p7); the clip plays out into locomotion. */
  ladderExit(top: boolean) {
    const l = this.ladder;
    const r = l && ref(l.set[top ? 6 : 7]);
    if (l) l.exiting = true;
    this.mode = 'none';
    this.ladder = undefined;
    if (r) this.body()?.play(r, { inPlace: true, fade: 0.1 });
    else this.body()?.release(0.2);
  }

  // --- Pushable --------------------------------------------------------------------

  /**
   * Every frame: `pushable` = the grabbed Pushable's values (undefined when none), `along` =
   * the player's speed towards the crate (m/s; negative = pulling back).
   */
  push(pushable: PropValue[] | undefined, along: number) {
    if (!pushable) {
      if (this.mode === 'push') this.end();
      return;
    }
    const b = this.body();
    const ip = this.tpl(refs(pushable[32])[0]);
    if (!b || !ip) return;
    if (this.mode !== 'push') this.end();
    this.mode = 'push';
    const slot = along > 0.15 ? 23 : along < -0.15 ? 25 : 24;
    const r = ref(ip[slot]);
    if (!r) return;
    const key = `${slot}`;
    if (key !== this.pushClip) {
      this.pushClip = key;
      b.play(r, { loop: true, fade: 0.2 });
    }
    // Forward / back cycles travel ~0.73 m/s (1 m per 1.37 s clip).
    if (slot !== 24) b.setRate(Math.max(0.4, Math.min(2.5, Math.abs(along) / 0.73)));
  }

  /** Per frame (nothing time-based left here; kept for the caller). */
  update() {}
}
