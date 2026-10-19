// Ranged Targeting Positions: shooting stands for ranged NPCs and creatures (docs §15.7.10).
// Decoded from Suffering.rfl: Ranged Targeting Position ctor 0x10126d10, inputs 0x101263a0 /
// 0x101263b0 (map 0x10179de8), FindTargettingPosition 0x101265c0 (spawned by the Character's
// p98 RangedCombatRepositionBehavior), sight test 0x101263f0, give-up 0x100f609e.
//
// A stand is enabled at start; its p2 message (On) enables and p1 (Off by default; Died /
// Disable on some) disables it; p0 may name a cover object. An NPC fighting with a ranged
// attack looks for a stand every p0..p1 s: an NPC that links to a stand takes its first one at
// once; otherwise every enabled, unreserved stand not given up in the last 7 s, within p2 m of
// it and whose distance to the target lies in the attack's range band narrowed by p9, is scored
// p4 x closeness + p3 x band centring + p5 x cover (the cover object between stand and target),
// and with p6 the best one that sees the target wins. The stand is reserved until the NPC picks
// again or stops; one it cannot reach is given up for 7 s.
// The target is the KillObject's, whoever it is (the search takes the target handle from the
// RangedCombatReposition request, 0x100f74f0 -> 0x101265c0) [verified]: a companion fighting
// creatures takes stands too. Port: the NPC walks there in a straight line (a stand it cannot
// walk straight to counts as unreachable) and the generic AI shoots once it arrives.

import * as THREE from 'three/webgpu';
import { toOutputSpace } from '../../../formats/level';
import type { Actor, ActorEnv } from '../actor';
import { clearLine, clearWide } from '../nav';
import { fightingPlayer, repositionParams, standBand, standScore, type RepositionParams } from './params';
import { drive, flat, num, rand, ref, turnToward, yawTo, type SpecialRuntime } from './runtime';

/**
 * Where a stand user's fight target is: the player or a character (its KillObject's target),
 * else null (not fighting, a prop target) [verified: the target comes with the request].
 */
export function standTarget(
  a: Pick<Actor, 'alive' | 'hidden' | 'inCombat' | 'activity' | 'currentTarget' | 'behavior'>,
  player: THREE.Vector3Like | null,
): THREE.Vector3Like | null {
  if (!a.alive || a.hidden) return null;
  if (fightingPlayer(a)) return player;
  const t = a.currentTarget;
  // A follower fights from its waiting HostilityBehavior (FollowBehavior p3 = 1).
  if (!t?.actor?.alive || !(a.inCombat || a.behavior?.kind === 'follow')) return null;
  return t.actor.position;
}

interface Stand {
  uid: number;
  pos: THREE.Vector3;
  enabled: boolean;
  on: number;
  off: number;
  cover?: THREE.Vector3;
  reserved: Actor | null;
  givenUp: number;
}

interface User {
  p: RepositionParams;
  band: [number, number];
  stand: Stand | null;
  next: number;
  walking: boolean;
  t: number;
  own: Stand[];
}

export class RangedPositions {
  readonly stands: Stand[] = [];
  private byUid = new Map<number, Stand>();
  private users = new WeakMap<Actor, User | null>();
  private hooked = false;
  stats = { picks: 0, arrivals: 0, givenUp: 0 };

  constructor(readonly rt: SpecialRuntime) {
    for (const e of rt.entities) {
      if (e.className !== 'Ranged Targeting Position') continue;
      const [x, y, z] = toOutputSpace(e.position);
      const coverUid = num(Array.isArray(e.values[0]) ? e.values[0][0] : e.values[0], 0);
      const c = coverUid ? rt.byUid.get(coverUid) : undefined;
      const s: Stand = {
        uid: e.uid,
        pos: new THREE.Vector3(x, y, z),
        enabled: true,
        on: num(e.values[2], 1),
        off: num(e.values[1], 2),
        cover: c ? new THREE.Vector3(...toOutputSpace(c.position)) : undefined,
        reserved: null,
        givenUp: -1e9,
      };
      this.stands.push(s);
      this.byUid.set(e.uid, s);
    }
  }

  /** Character with a ranged attack and a RangedCombatRepositionBehavior (p98). */
  private user(a: Actor): User | null {
    let u = this.users.get(a);
    if (u !== undefined) return u;
    u = null;
    const r = a.profile.ranged;
    const v = a.entity?.values ?? this.rt.template(a.kind.template)?.v ?? [];
    const p = r && this.stands.length ? repositionParams(this.rt.pkgs, ref(v[98])) : undefined;
    if (p && r) {
      const own = (a.entity?.links ?? []).map((l) => this.byUid.get(l)).filter((s): s is Stand => !!s);
      u = { p, band: standBand(0, r.range, p.margin), stand: null, next: 0, walking: false, t: 0, own };
    }
    this.users.set(a, u);
    return u;
  }

  wants(a: Actor) {
    return !!this.user(a);
  }

  update(_dt: number) {
    if (this.hooked || !this.rt.world?.subscribe || !this.stands.length) return;
    this.hooked = true;
    for (const s of this.stands)
      this.rt.world.subscribe(s.uid, (msg) => {
        if (msg === s.on) s.enabled = true;
        else if (msg === s.off) s.enabled = false;
      });
  }

  private release(u: User) {
    if (u.stand && u.stand.reserved) u.stand.reserved = null;
    u.stand = null;
    u.walking = false;
  }

  /** Called from the actor's special hook: true while it walks to its stand. */
  steer(a: Actor, dt: number, env: ActorEnv): boolean {
    const u = this.user(a);
    if (!u) return false;
    const target = this.targetOf(a, env);
    if (!target) {
      if (u.stand) this.release(u);
      return false;
    }
    if (a.state === 'shoot' || a.state === 'attack' || a.state === 'hurt' || a.state === 'fall') return false;
    if (!u.walking && env.time >= u.next) {
      u.next = env.time + rand(u.p.stay[0], u.p.stay[1]);
      const s = this.pick(a, u, env, target);
      if (s && s !== u.stand) {
        this.release(u);
        s.reserved = a;
        u.stand = s;
        u.walking = flat(a.position, s.pos) > 0.6;
        u.t = 0;
        this.stats.picks++;
        this.rt.log(a, `takes stand #${s.uid.toString(16)} (${flat(a.position, s.pos).toFixed(1)} m away)`);
      }
    }
    if (!u.walking || !u.stand) return false;
    const s = u.stand;
    u.t += dt;
    const d = flat(a.position, s.pos);
    if (d < 0.5 || u.t > 10) {
      u.walking = false;
      if (d < 0.5) this.stats.arrivals++;
      a.state = 'chase';
      return false;
    }
    // A stand it cannot walk straight to is given up for 7 s.
    if (u.t > 1.5 && !clearWide(env.world, a.position.x, a.position.y + 0.5, a.position.z, s.pos.x, s.pos.y + 0.5, s.pos.z, a.radius)) {
      s.givenUp = env.time;
      this.stats.givenUp++;
      this.release(u);
      u.next = env.time;
      return false;
    }
    a.state = 'move';
    turnToward(a, yawTo(a.position, s.pos), 6, dt);
    const run = a.kind.run >= 0 ? a.kind.run : a.kind.walk;
    if (run >= 0) a.playClip(run, true);
    drive(a, dt, s.pos.x - a.position.x, s.pos.z - a.position.z, a.kind.runSpeed);
    a.sync();
    return true;
  }

  private targetOf(a: Actor, env: ActorEnv): THREE.Vector3Like | null {
    return standTarget(a, env.playerAlive ? env.player.position : null);
  }

  /** FindTargettingPosition (0x101265c0). */
  private pick(a: Actor, u: User, env: ActorEnv, t: THREE.Vector3Like): Stand | null {
    if (u.own.length) return u.own[0];
    const scored: { s: Stand; score: number }[] = [];
    for (const s of this.stands) {
      if (!s.enabled || (s.reserved && s.reserved !== a) || env.time - s.givenUp < 7) continue;
      const dSelf = flat(a.position, s.pos);
      const dTarget = flat(s.pos, t);
      if (dSelf > u.p.radius || dTarget < u.band[0] || dTarget > u.band[1] || Math.abs(s.pos.y - a.position.y) > 3) continue;
      let cover = false;
      if (s.cover) {
        // Cover: the object lies between stand and target (angle at the object > 135 degrees).
        const ax = s.pos.x - s.cover.x, az = s.pos.z - s.cover.z, bx = t.x - s.cover.x, bz = t.z - s.cover.z;
        cover = (ax * bx + az * bz) / Math.max(1e-6, Math.hypot(ax, az) * Math.hypot(bx, bz)) < -0.707;
      }
      scored.push({ s, score: standScore(u.p, dSelf, dTarget, u.band, cover) });
    }
    scored.sort((x, y) => y.score - x.score);
    for (const { s } of scored.slice(0, 6)) {
      if (!u.p.sight || clearLine(env.world, s.pos.x, s.pos.y + 1.5, s.pos.z, t.x, t.y + 1.2, t.z)) return s;
    }
    return null;
  }
}
