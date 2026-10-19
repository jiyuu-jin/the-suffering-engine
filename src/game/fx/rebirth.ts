// Ring Damage and the Killjoy Rebirth Effect; the Player's DestroyRebirthFX message (105).
// docs/re/object-model.md §8.
//
// Ring Damage (RFL vtable 0x1014d898) [verified]: an expanding ring around the point it was
// spawned at, tested against the player only. At age t (s) it covers horizontal distances
// between p0 + p3 t and p1 + p4 t (m) and heights from its own up to p2 m above it (0x10128ba0,
// run at creation and every frame); it is removed after p5 s (0x10128de0) or on its first hit.
// A hit (0x101289f0) deals p6 damage of type p10 and spawns its victim effect p7 on the player.
// Retail: 3:4555 (thrown by generator 3:4515 in 5b and 10): 0.1 m wide, growing 0.66 m/s for
// 3.5 s, 0.5 m tall, no damage, victim effect 4:1325 Killjoy Rebirth Effect.
//
// Killjoy Rebirth Effect (vtable 0x10154000) [verified]: only takes on the player. One at a time:
// the player keeps its handle (Player +0x786); a second one hitting the player refreshes the
// first (0x1008af30) and goes away. Taking hold (post-create 0x1008b3a0), it puts the player's
// weapons away and empties his throwing hand (0x10038a50 / 0x10038620; weapons/system.ts
// stow()), then refreshes. Refresh: held = the player's count of item p19 (0x1004cd80); he is
// given p18 - held more when that is positive (0x10039b10), i.e. topped up to p18; when held
// was 0, p20 is spawned and attached to his hardpoint p21 (0x1008ac90). The Player's fixed
// message 105 DestroyRebirthFX (0x100280d0) destroys the effect; its destructor (0x1008ad80)
// takes every p19 item away (0x1004cf60), destroys the p21 attachment and takes the weapons
// and the throwable out again (0x10039840 / 0x100392d0; weapons unstow()). Retail 4:1325:
// 8 of Missile Item 4:804 (a grenade variant: own HUD meter 5:646 and thrown object 4:806,
// whose blast is Radius Damage 4:805, 21 / 3.75 m, type 17) and the fire generator 4:896 on
// hardpoint 35. 4:804 shares its name string 4:47 with the Shrapnel Grenade 4:655; the
// inventory keys items by template (world/inventory.ts), so the two stay apart.
//
// Port: all of the above. Not ported: the deferral while two player state bits are set
// (0x1008b130 runs the take-hold part later) and the rejection on one of them.

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { Fx, Generator, TemplateInfo } from '../world/fx';
import { followMatrices, killOwned, spawnOwned } from './attachments';

/** Player fixed message: destroy the player's Killjoy Rebirth Effect. */
export const DESTROY_REBIRTH_FX = 105;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);
const firstRef = (v: PropValue | undefined): ResRef | undefined => (Array.isArray(v) ? v.find(isRef) : isRef(v) ? v : undefined);

/** Ring Damage band at age t (s): inner / outer horizontal radius and height (m). */
export function ringBand(v: PropValue[], t: number) {
  return { inner: num(v[0]) + num(v[3]) * t, outer: num(v[1]) + num(v[4]) * t, height: num(v[2]), life: num(v[5]) };
}

/** Does the ring (centre c, age t) touch a body standing at feet p with height h? */
export function ringHits(v: PropValue[], t: number, c: THREE.Vector3Like, p: THREE.Vector3Like, h: number): boolean {
  const b = ringBand(v, t);
  const d2 = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
  if (!(d2 < b.outer * b.outer) || !(d2 > b.inner * b.inner)) return false;
  return p.y < c.y + b.height && p.y + h > c.y;
}

export interface RebirthEnv {
  wfx: Pick<Fx, 'spawn' | 'generators'>;
  /** Template class + values. */
  template(r: ResRef): TemplateInfo | undefined;
  /** Player feet (output space) or null when there is no walking player. */
  player(): THREE.Vector3 | null;
  /** World matrix of the player's hardpoint `hp` (hand) into `out`; false when unknown. */
  playerHardpoint(hp: number, out: THREE.Matrix4): boolean;
  damagePlayer?(amount: number, type: number, at: THREE.Vector3): void;
  /** The player's inventory: count / give / take every one of an item template. */
  items?: { count(item: ResRef): number; give(item: ResRef, n: number): void; removeAll(item: ResRef): number };
  /** Weapons away (and the throwing hand emptied) while the effect holds the player; back after. */
  stow?(): void;
  unstow?(): void;
  log?(m: string): void;
}

interface Ring {
  v: PropValue[];
  c: THREE.Vector3;
  t: number;
}

const PLAYER_HEIGHT = 1.8;

export class Rebirth {
  private readonly rings: Ring[] = [];
  private active: { v: PropValue[]; M: THREE.Matrix4 | null; gens: Generator[] } | null = null;
  /** Hits / refreshes / removals for tests and the overlay. */
  readonly events: string[] = [];

  constructor(private readonly env: RebirthEnv) {}

  /** World FX spawner: Ring Damage templates become rings. */
  readonly spawner = (t: TemplateInfo, M: THREE.Matrix4): boolean => {
    if (t.cls !== 'Ring Damage') return false;
    this.rings.push({ v: t.values, c: new THREE.Vector3().setFromMatrixPosition(M), t: 0 });
    return true;
  };

  get ringCount() {
    return this.rings.length;
  }

  get effectActive() {
    return !!this.active;
  }

  private note(m: string) {
    this.events.push(m);
    if (this.events.length > 30) this.events.shift();
    this.env.log?.(`[fx] ${m}`);
  }

  update(dt: number) {
    const feet = this.rings.length ? this.env.player() : null;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      if (r.t >= ringBand(r.v, r.t).life) {
        this.rings.splice(i, 1);
        continue;
      }
      if (feet && ringHits(r.v, r.t, r.c, feet, PLAYER_HEIGHT)) {
        this.rings.splice(i, 1);
        this.hit(r.v, feet);
      }
    }
    const a = this.active;
    if (a?.M) this.env.playerHardpoint(num(a.v[21], -1), a.M);
  }

  private hit(v: PropValue[], at: THREE.Vector3) {
    const dmg = num(v[6]);
    if (dmg > 0) this.env.damagePlayer?.(dmg, num(v[10]), at);
    const fx = firstRef(v[7]);
    if (!fx) return;
    const t = this.env.template(fx);
    if (t?.cls === 'Killjoy Rebirth Effect') this.apply(t.values);
    else this.env.wfx.spawn(fx, new THREE.Matrix4().setPosition(at));
  }

  /** A Killjoy Rebirth Effect reached the player: take hold, or refresh the one he has. */
  apply(v: PropValue[]) {
    if (this.active) {
      this.note('rebirth effect refreshed');
      this.refresh(this.active.v);
      return;
    }
    this.active = { v, M: null, gens: [] };
    this.note('rebirth effect on the player');
    this.env.stow?.();
    this.refresh(v);
  }

  /** Top the player up to p18 of p19; the p20 effect on bone p21 when he held none (0x1008af30). */
  private refresh(v: PropValue[]) {
    const item = firstRef(v[19]);
    const inv = this.env.items;
    const held = item && inv ? inv.count(item) : 0;
    const more = num(v[18]) - held;
    if (item && inv && more > 0) {
      inv.give(item, more);
      this.note(`rebirth: +${more} ${item.pkg}:${item.id}`);
    }
    const a = this.active;
    const fx = firstRef(v[20]);
    if (!a || a.M || !fx || held >= 1) return;
    const M = new THREE.Matrix4();
    if (!this.env.playerHardpoint(num(v[21], -1), M)) {
      const p = this.env.player();
      if (!p) return;
      M.setPosition(p.x, p.y + 1.2, p.z);
    }
    followMatrices.add(M);
    a.M = M;
    a.gens = spawnOwned(this.env.wfx, fx, M);
  }

  /** DestroyRebirthFX: remove the player's effect (no-op without one). */
  destroy(): boolean {
    const a = this.active;
    if (!a) return false;
    this.active = null;
    killOwned(this.env.wfx, a.gens);
    const item = firstRef(a.v[19]);
    const taken = item ? (this.env.items?.removeAll(item) ?? 0) : 0;
    this.env.unstow?.();
    this.note(`rebirth effect destroyed (-${taken})`);
    return true;
  }

  dispose() {
    this.rings.length = 0;
    if (this.active) killOwned(this.env.wfx, this.active.gens);
    this.active = null;
  }
}
