// Rat: the sewer / cell swarm creature's attack, decoded from Suffering.rfl (docs/game-logic.md
// §15.7.13). A Rat has no melee weapon and no MeleeAttackBehavior: its KillEnemies child is the
// class's own kill-object slot (Rat 0x100854b0: behaviour kind 0x44 -> Rat p182, kind 0x43 ->
// Rat p181), RatKillObjectBehavior (runtime vtable 0x10158768) and RatJumpAttackBehavior
// (0x101587c8) [verified]:
//
//   * RatKillObjectBehavior (start 0x10085f50, update 0x10086000, child events 0x10085dd0):
//     a MoveTo after the target (stopping 0.25 m short); every frame, the target alive and no
//     leap running, a leap starts once the 3D distance between the two positions is below p2 m
//     and the way to the target is within p3 degrees of the rat's facing (dot > cos p3). A leap
//     that ends without a bite leaves it running (p178 sound) and it checks again.
//   * RatJumpAttackBehavior (start 0x100863f0, update 0x100869b0, child events 0x100861b0):
//     the leap clip p2 (10:420: 0.83 s, its root carries the body 7.3 m forward on a 1.56 m
//     arc). While it flies, the first touch of a live character's hit sphere latches it there
//     (a p5 Follower Object on that sphere, 0x10086500), deals p4 damage once (the target's
//     TakeDamage, vt+0x58) and plays the chew clip p3 (10:422) hanging on. When the chew clip
//     ends the rat dies (Rat vt+0x128 0x10085c80: the death, its p117 effect) and the follower
//     goes. A leap clip that ends without a touch ends the behaviour (back to the kill object).
//   * After a missed leap nothing moves the rat again: the kill object's update only tests the
//     leap (its MoveTo child was replaced by the leap and is not restarted; the leap's end event
//     0x43 only plays p178) and it does not complete, so KillEnemies (p12 -1: one pick) keeps it.
//     The rat waits where it landed until the target is in front of it within p2 again [verified].
//
//   * Who is bitten (the leap update's contact loop 0x10086a20..0x10086b5e): every frame it walks
//     the rat mover's contacts. A contact that is a live Character (object type 7) or the Player
//     (class 0xc8bc44e1) sets the leap's "touched" flag (+0x70 bit 0x80000); only a Player contact
//     goes on to the hit-sphere test (0x10001330 answers the Player alone), the latch and the
//     bite. With the flag set and no bite the update ends the behaviour (0x100973e0(1, 0), the
//     same end as a leap clip without a touch); the end (vt[19] 0x100862e0) clears the flag.
//     So a rat never hurts another character: a leap at an NPC (Clem, the 1c inmate, Dallas)
//     stops on his body and the rat waits / leaps again like after any miss [verified].
//
// So a rat bites once: p4 (10) per rat that lands its leap on the player, then it is gone. The
// port's guess before was a melee clip repeating 4-damage bites (a swarm killed the player in
// seconds, and about 30 of them killed Clem on 6b's beach).
// Port: the rat works on its KillEnemies target, the player or a character (params.fightTarget).
// The touch is the rat's body sphere against the player's hit spheres (env.hitSpheres); a mover
// contact with a character is the two bodies' cylinders meeting while the leap moves toward it
// (bodies only push softly apart in the port, so bodies it overlapped when it leapt do not
// count); the latch keeps the rat at its touch offset from
// the player, turned with him [port]. A player contact without a hit-sphere overlap is not
// modelled (the spheres decide).

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../../formats/entities';
import type { Actor, ActorEnv } from '../actor';
import type { ClipRef } from '../clipmap';
import { fightTarget, type FightTarget } from './params';
import { drive, facing, num, readTemplate, ref, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';
import type { EntityPackageSet } from '../../../formats/entities';

/** Rat p181 / p182 (RatJumpAttackBehavior / RatKillObjectBehavior templates). */
export const RAT_JUMP_SLOT = 181;
export const RAT_KILL_SLOT = 182;

export interface RatParams {
  /** RatKillObject p2: leap when the target is nearer than this (m, 3D) [verified 0x100860e2]. */
  range: number;
  /** RatKillObject p3: ... and within this many degrees of the facing [verified 0x10086167]. */
  cone: number;
  /** RatJumpAttack p2: the leap clip (its root moves the body). */
  leap?: ClipRef;
  /** RatJumpAttack p3: the chew clip played latched on. */
  chew?: ClipRef;
  /** RatJumpAttack p4: the bite, dealt once when the leap touches [verified 0x10086cb7]. */
  bite: number;
}

/** Decoded from the two templates' values (retail 10:518 p2 4 / p3 20; 10:519 10:420 / 10:422 / 10). */
export function ratParams(kill: PropValue[] | undefined, jump: PropValue[] | undefined): RatParams {
  return {
    range: num(kill?.[2], 4),
    cone: num(kill?.[3], 20),
    leap: ref(jump?.[2]),
    chew: ref(jump?.[3]),
    bite: num(jump?.[4], 10),
  };
}

export function ratParamsOf(pkgs: EntityPackageSet, rat: PropValue[]): RatParams {
  const k = readTemplate(pkgs, ref(rat[RAT_KILL_SLOT]));
  const j = readTemplate(pkgs, ref(rat[RAT_JUMP_SLOT]));
  return ratParams(k?.cls === 'RatKillObjectBehavior' ? k.v : undefined, j?.cls === 'RatJumpAttackBehavior' ? j.v : undefined);
}

/** The leap test of RatKillObject's update: 3D distance below p2, bearing within p3 degrees. */
export function ratLeaps(p: RatParams, distance3d: number, facingDot: number): boolean {
  return distance3d < p.range && facingDot > Math.cos((p.cone * Math.PI) / 180);
}

/** First hit sphere a body sphere touches (index), or -1. */
export function ratTouch(c: readonly [number, number, number], r: number, spheres: readonly { c: readonly number[]; r: number }[]): number {
  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i];
    const d = Math.hypot(s.c[0] - c[0], s.c[1] - c[1], s.c[2] - c[2]);
    if (d <= s.r + r) return i;
  }
  return -1;
}

/** A character's body for the leap's mover contact (feet position, cylinder). */
export interface RatBody {
  x: number;
  z: number;
  bottom: number;
  height: number;
  radius: number;
}

/**
 * The leap's mover contact with a character [port]: the rat's body (feet `x`, `y`, `z`, radius
 * `r`) meets the other's cylinder while the leap's step (`dx`, `dz`) moves toward it. Index of
 * the first such body, or -1.
 */
export function ratContact(x: number, y: number, z: number, r: number, h: number, dx: number, dz: number, bodies: readonly RatBody[]): number {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const ox = b.x - x, oz = b.z - z;
    if (Math.hypot(ox, oz) > r + b.radius) continue;
    if (y > b.bottom + b.height || y + h < b.bottom) continue;
    if (ox * dx + oz * dz <= 0) continue;
    return i;
  }
  return -1;
}

/**
 * What a leap touch does (0x10086a20..): the player is latched and bitten (p4 once); any other
 * live character ends the leap with no damage [verified].
 */
export function ratTouchResult(who: 'player' | 'character'): { bite: boolean; end: boolean } {
  return who === 'player' ? { bite: true, end: false } : { bite: false, end: true };
}

/** Root translation of a clip at time t (character space, -Z forward), linear between keys. */
export function rootAt(times: ArrayLike<number>, tr: ArrayLike<number>, t: number, out: [number, number, number]) {
  const n = times.length;
  if (!n) return out.fill(0) as [number, number, number];
  let i = 0;
  while (i < n - 1 && times[i + 1] <= t) i++;
  const j = Math.min(n - 1, i + 1);
  const span = times[j] - times[i];
  const k = span > 1e-6 ? Math.max(0, Math.min(1, (t - times[i]) / span)) : 0;
  for (let a = 0; a < 3; a++) out[a] = tr[3 * i + a] + (tr[3 * j + a] - tr[3 * i + a]) * k - tr[a];
  return out;
}

type Phase = { kind: 'leap'; clip: number; t: number; dur: number; from: THREE.Vector3; yaw: number; times: ArrayLike<number>; tr: ArrayLike<number>; skip: Set<Actor> } | { kind: 'chew'; clip: number; off: THREE.Vector3; yaw0: number } | { kind: 'spent' };

class Rat implements SpecialMove {
  readonly name = 'rat';
  private p: RatParams;
  private phase: Phase | null = null;
  private stats = { leaps: 0, bites: 0, misses: 0, stopped: 0 };
  private readonly root: [number, number, number] = [0, 0, 0];

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    this.p = ratParamsOf(rt.pkgs, a.entity?.values ?? rt.template(a.kind.template)?.v ?? []);
  }

  info() {
    return { rat: this.phase?.kind ?? 'none', ...this.stats };
  }

  save() {
    return undefined;
  }

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (!a.alive) {
      this.phase = null;
      return false;
    }
    if (this.phase?.kind === 'leap') return this.leap(dt, env);
    if (this.phase?.kind === 'chew') return this.chew(env);
    // The kill object works on the KillEnemies target: the player or a character.
    const tgt = a.hidden || a.state === 'hurt' || a.state === 'fall' ? undefined : fightTarget(a, env);
    if (!tgt) return false;
    const pp = tgt.pos;
    const d3 = Math.hypot(pp.x - a.position.x, pp.y - a.position.y, pp.z - a.position.z);
    // Missed once: it stays put (idle) and only leaps again at a target in front of it.
    if (this.phase?.kind === 'spent') {
      if (ratLeaps(this.p, d3, facing(a, pp))) return this.startLeap(env, tgt);
      if (a.kind.idle >= 0) a.playClip(a.kind.idle, true);
      a.state = 'idle';
      // Standing still, under gravity (a leap stopped by a wall ends in the air).
      drive(a, dt, 0, 0, 0.01);
      a.sync();
      return true;
    }
    // Out of leaping range: the generic chase is the kill object's MoveTo.
    if (d3 >= this.p.range) return false;
    if (ratLeaps(this.p, d3, facing(a, pp))) return this.startLeap(env, tgt);
    // In range but not facing: the MoveTo keeps turning it onto the target (no melee: a rat has
    // no other attack).
    turnToward(a, yawTo(a.position, pp), 8, dt);
    const run = a.kind.run >= 0 ? a.kind.run : a.kind.walk;
    if (run >= 0) a.playClip(run, true);
    if (Math.hypot(pp.x - a.position.x, pp.z - a.position.z) > 0.25) drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), a.kind.runSpeed);
    else drive(a, dt, 0, 0, 0.01);
    a.state = 'chase';
    a.sync();
    return true;
  }

  private startLeap(env: ActorEnv, tgt: FightTarget): boolean {
    const a = this.a;
    const clip = env.clip(a, this.p.leap);
    const data = clip >= 0 ? a.ch.clipData[clip] : undefined;
    const bones = a.kind.skinned.skeleton;
    const track = data?.tracks.find((x) => x.translations && bones.bones[bones.byHash.get(x.boneHash) ?? -1]?.parent === -1);
    if (clip < 0 || !data || !track?.translations) return false;
    a.state = 'fall'; // airborne: carried by the leap / hanging on the target
    a.playClip(clip, false);
    this.stats.leaps++;
    // Bodies it already overlaps (the port's soft separation lets a swarm overlap; the original's
    // movers do not): not a contact of this leap [port].
    const rad = Math.max(0.15, a.radius);
    const skip = new Set(env.actors.filter((o) => o !== a && o.alive && Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z) <= rad + o.radius));
    this.phase = { kind: 'leap', clip, t: 0, dur: Math.max(0.05, data.duration), from: new THREE.Vector3(a.position.x, a.position.y, a.position.z), yaw: a.yaw, times: track.times, tr: track.translations, skip };
    if (!tgt.player) this.rt.log(a, `leaps at ${tgt.actor.ch.root.name}`);
    return true;
  }

  private leap(dt: number, env: ActorEnv): boolean {
    const a = this.a, ph = this.phase as Extract<Phase, { kind: 'leap' }>;
    ph.t = Math.min(ph.dur, ph.t + dt);
    const r = rootAt(ph.times, ph.tr, ph.t, this.root);
    const s = Math.sin(ph.yaw), c = Math.cos(ph.yaw), k = a.scale;
    const tx = ph.from.x + (r[0] * c + r[2] * s) * k, tz = ph.from.z + (-r[0] * s + r[2] * c) * k;
    const dx = tx - a.position.x, dz = tz - a.position.z, want = Math.hypot(dx, dz);
    // Horizontally through the motor (walls stop it), the arc set on top.
    const moved = want > 1e-4 ? drive(a, dt, dx, dz, want / Math.max(dt, 1e-3)) : 0;
    a.motor.position.y = Math.max(a.motor.position.y, ph.from.y + r[1] * k);
    a.state = 'fall'; // airborne: carried by the leap / hanging on the target
    // The touch: the rat's body sphere against the player's hit spheres.
    const rad = Math.max(0.15, a.radius);
    const centre: [number, number, number] = [a.position.x, a.position.y + rad, a.position.z];
    const spheres = env.hitSpheres?.('player') ?? [];
    // (Port option "Enemies ignore the player": a leap that reaches him does not latch on.)
    if (env.playerAlive && !env.ignorePlayer && ratTouch(centre, rad, spheres) >= 0) {
      this.stats.bites++;
      this.rt.hurtPlayer(this.p.bite, a, env);
      this.rt.log(a, `leap landed on the player: ${this.p.bite}`);
      const pp = env.player.position;
      const chew = env.clip(a, this.p.chew);
      if (chew >= 0) a.playClip(chew, false);
      this.phase = { kind: 'chew', clip: chew, off: new THREE.Vector3(a.position.x - pp.x, a.position.y - pp.y, a.position.z - pp.z), yaw0: env.player.yaw };
      a.sync();
      return true;
    }
    // A live character in the way: the leap ends there, no bite (only the Player is latched).
    const others = env.actors.filter((o) => o !== a && o.alive && !o.hidden && !o.kind.decor && !o.template && !ph.skip.has(o));
    const hit = ratContact(a.position.x, a.position.y, a.position.z, rad, 2 * rad, dx, dz, others.map((o) => ({ x: o.position.x, z: o.position.z, bottom: o.bottom, height: o.height, radius: o.radius })));
    if (hit >= 0) {
      this.stats.misses++;
      this.stats.stopped++;
      this.rt.log(a, `leap stopped on ${others[hit].ch.root.name}: no bite`);
      this.phase = { kind: 'spent' };
      a.state = 'idle';
      a.motor.onGround = false;
      a.sync();
      return true;
    }
    if (ph.t >= ph.dur || (want > 0.05 && moved < want * 0.2)) {
      this.stats.misses++;
      this.phase = { kind: 'spent' };
      a.state = 'idle';
      a.motor.onGround = false;
    }
    a.sync();
    return true;
  }

  private chew(env: ActorEnv): boolean {
    const a = this.a, ph = this.phase as Extract<Phase, { kind: 'chew' }>;
    const pp = env.player.position;
    const turn = env.player.yaw - ph.yaw0;
    const s = Math.sin(turn), c = Math.cos(turn), o = ph.off;
    a.motor.position.x = pp.x + o.x * c + o.z * s;
    a.motor.position.y = pp.y + o.y;
    a.motor.position.z = pp.z - o.x * s + o.z * c;
    a.motor.velocity.x = a.motor.velocity.y = a.motor.velocity.z = 0;
    a.yaw = yawTo(a.position, pp);
    a.state = 'fall'; // airborne: carried by the leap / hanging on the target
    a.sync();
    if (env.ignorePlayer && env.playerAlive) {
      // Port option "Enemies ignore the player": it drops off him.
      this.phase = { kind: 'spent' };
      a.state = 'idle';
      a.motor.onGround = false;
      return true;
    }
    if (ph.clip < 0 || a.clipDone || !env.playerAlive) {
      // The chew is over: the rat dies (Rat vt+0x128), not by the player's hand.
      this.phase = null;
      this.rt.hurtActor(a, a.health + 1, a);
    }
    return true;
  }
}

export const createRat = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Rat(a, rt);
