// Mainliner: jump attack and ride (docs §15.7.4). Decoded from Suffering.rfl:
// MainlinerKillObjectBehavior 0x1007dc70 / 0x1007f4a0 (jump trigger 0x1007ee30), JumpAttack
// 0x10073b90 / 0x10073e50 / 0x10072c20, JumpAttackLaunch 0x100736b0 / 0x100743c0,
// MainlinerJumpAttackGrapple 0x1007e290 / 0x1007f9f0 / 0x1007f420 / 0x1007f3b0.
//
// Engaged with the player, every p24..p25 s (KillObject; at once on engaging) a Mainliner within
// the leap band (Attack p15..p16, 3..7.5 m, height within p26) and in clear sight leaps (clip
// 10:198, travelling its root motion). Touching the target inside +-p6 degrees and p7..p8 m of
// height it sticks: in front (p4, clip 10:228) or on the back (p11, 10:237) when both face the
// same way. The player is held and plays p304 / p305; from the clip's Unlock marker the ride
// clock t runs at dt x (1 +- p12) and every attack press (Player p303) takes 0.035 s off it.
// t past the clip's end -> the finisher: stick Attack p6 x p2 (30) and it jumps off (p178);
// t below 0 or p13 s after Unlock -> thrown off (p179) without damage. Missing the leap ->
// landing clip p9. Placed as a root behaviour (level 2 #870) it leaps at once.
// Port: the rider stands at the player's feet offset to the front / back; presses are attack
// presses (PlayerController.attackOverride), plus fresh movement / jump inputs [port]
// (PlayerHold).
//
// Characters: the KillObject leaps at whatever its KillEnemies fights; a character must have
// p143 set (jump trigger 0x1007ee30 -> vt 0x134 0x100870f0) and the launch sticks to the first
// body it touches that is the player or such a character (0x100744f0..). On a character the
// grapple start (0x1007e290) deals him his p141 / p142 incapacitate Attack (p6 x p2: 0 for the
// retail 10:205) and plays its clip p0 at rate 1; the update (0x1007f9f0) has no struggle for
// him: the clip ending (or his death) with the ride timer still running -> the finisher (stick
// Attack p6 x p2 = 30, 0x1007dc20 -> 0x10087160) and the jump off; the timer (p13 s [inferred:
// the start message's time]) out first -> thrown off, no damage [verified]. Clem and Dallas
// (p143 1) are ridden so. Port: the rider keeps its offset on his feet; his own AI goes on.

import * as THREE from 'three/webgpu';
import type { Actor, ActorEnv } from '../actor';
import type { Behavior } from '../behaviors';
import { clearLine } from '../nav';
import type { ClipRef } from '../clipmap';
import { PlayerHold } from './hold';
import { fightTarget, mainlinerJump, mainlinerParams, mainlinerVictim, PLAYER_RIDE, type FightTarget, type MainlinerJump, type MainlinerParams } from './params';
import { drive, facing, flat, rand, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';

type State = 'none' | 'leap' | 'missed' | 'ride' | 'rideNpc' | 'off';

class Mainliner implements SpecialMove {
  readonly name = 'mainliner';
  st: State = 'none';
  private p: MainlinerParams;
  private jump: MainlinerJump;
  private engaged = false;
  private cooldown = 0;
  private t = 0;
  private clipIdx = -1;
  private hold: PlayerHold;
  private side = 0;
  private ride = 0;
  private rideClock = 0;
  private unlocked = false;
  private presses = 0;
  private leapHit = false;
  private fromRoot?: Behavior;
  /** What the leap goes for, and the character ridden (NPC victim). */
  private leapAt: FightTarget | null = null;
  private victim: Actor | null = null;
  private npcTimer = 0;
  private stats = { leaps: 0, rides: 0, npcRides: 0, finishers: 0, thrown: 0, dealt: 0 };

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    const v = a.entity?.values ?? rt.template(a.kind.template)?.v ?? [];
    this.p = mainlinerParams(rt.pkgs, v);
    this.jump = this.p.jump;
    this.hold = new PlayerHold(rt, a);
  }

  info() {
    return { ml: this.st, ride: +this.ride.toFixed(2), cooldown: +this.cooldown.toFixed(1), held: this.hold.active, ...this.stats };
  }

  private play(c: ClipRef | undefined, loop = false, speed = 1) {
    const env = this.rt.manager.env;
    this.clipIdx = env ? env.clip(this.a, c) : -1;
    if (this.clipIdx >= 0) {
      const act = this.a.playClip(this.clipIdx, loop, speed);
      if (act) act.time = 0;
    }
    return this.clipIdx >= 0;
  }

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (!a.alive) {
      if (this.hold.active) this.release();
      this.victim = null;
      return false;
    }
    // Placed MainlinerJumpAttackBehavior (Behavior Changer): leap at once, then the chain goes on.
    if (this.st === 'none' && a.behavior?.cls === 'MainlinerJumpAttackBehavior' && a.behavior !== this.fromRoot) {
      this.fromRoot = a.behavior;
      const b = a.behavior;
      const v = b.uid ? env.entity(b.uid)?.values : undefined;
      if (v) this.jump = mainlinerJump(this.rt.pkgs, a.entity?.values ?? [], v);
      this.startLeap(env, 'root behaviour');
      return true;
    }
    if (this.st === 'none') return this.decide(dt, env);
    this.t += dt;
    a.state = 'act';
    switch (this.st) {
      case 'leap':
        this.leap(dt, env);
        break;
      case 'missed':
      case 'off':
        if (a.clipDone || this.t > 2.5) this.finish(env);
        break;
      case 'ride':
        this.rideUpdate(dt, env);
        break;
      case 'rideNpc':
        this.rideNpc(dt, env);
        break;
    }
    a.sync();
    return true;
  }

  private decide(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    const tgt = a.hidden ? undefined : fightTarget(a, env);
    if (!tgt) {
      this.engaged = false;
      return false;
    }
    if (!this.engaged) {
      this.engaged = true;
      this.cooldown = 0;
    }
    this.cooldown -= dt;
    if (this.cooldown > 0 || (a.state !== 'chase' && a.state !== 'idle')) return false;
    // The player is held by one creature at a time; a character only with p143 set.
    if (tgt.player ? this.rt.holder : !this.rideable(tgt.actor)) return false;
    const p = tgt.pos;
    const d = flat(a.position, p) - 0.35;
    if (d < Math.max(this.p.band[0], this.jump.leapRange[0]) || d >= Math.min(this.p.band[1], this.jump.leapRange[1])) return false;
    if (Math.abs(p.y - a.position.y) > this.p.maxRise) return false;
    if (!clearLine(env.world, a.position.x, a.position.y + 1, a.position.z, p.x, p.y + 1, p.z)) {
      this.cooldown = rand(this.p.cooldown[0], this.p.cooldown[1]);
      return false;
    }
    this.cooldown = rand(this.p.cooldown[0], this.p.cooldown[1]);
    this.startLeap(env, `${d.toFixed(1)} m${tgt.player ? '' : ` at ${tgt.actor.ch.root.name}`}`, tgt);
    return true;
  }

  /** Character p143: a Mainliner may jump at him [verified 0x100870f0]. */
  private rideable(o: Actor): boolean {
    return mainlinerVictim(this.rt.pkgs, o.entity?.values ?? this.rt.template(o.kind.template)?.v ?? []).rideable;
  }

  private startLeap(env: ActorEnv, why: string, tgt?: FightTarget) {
    const a = this.a;
    this.leapAt = tgt ?? fightTarget(a, env) ?? { player: true, pos: env.player.position };
    a.yaw = yawTo(a.position, this.leapAt.pos);
    this.st = 'leap';
    this.t = 0;
    this.leapHit = false;
    this.stats.leaps++;
    this.play(this.jump.leap);
    this.rt.log(a, `leaps (${why})`);
  }

  /** JumpAttackLaunch: travel the leap; grab on contact inside the cone / height window. */
  private leap(dt: number, env: ActorEnv) {
    const a = this.a, at = this.leapAt;
    const p = at && !at.player ? at.actor.position : env.player.position;
    const d = flat(a.position, p);
    const speed = this.clipIdx >= 0 ? a.kind.speeds[this.clipIdx] || 9 : 9;
    turnToward(a, yawTo(a.position, p), 2, dt);
    if (d > a.radius + (at && !at.player ? at.actor.radius + 0.25 : 0.6)) drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), speed);
    // Stick to the first body touched inside the cone / height window: the player, or a character
    // with p143 [verified 0x100744f0..0x10074715].
    const fits = (q: { x: number; y: number; z: number }, r: number) => {
      const dy = q.y - a.position.y;
      return flat(a.position, q) < a.radius + r + 0.55 && facing(a, q) >= Math.cos((this.jump.cone * Math.PI) / 180) && dy >= this.jump.height[0] && dy <= this.jump.height[1];
    };
    // (Port option "Enemies ignore the player": the leap passes him.)
    if (env.playerAlive && !env.ignorePlayer && !this.rt.holder && fits(env.player.position, 0.35)) return this.grab(env);
    for (const o of env.actors) {
      if (o === a || !o.alive || o.hidden || o.kind.decor || o.template || !fits(o.position, o.radius) || !this.rideable(o)) continue;
      return this.grabNpc(o);
    }
    if (a.clipDone || this.t > 2) {
      this.st = 'missed';
      this.t = 0;
      this.play(this.jump.missed);
      this.rt.log(a, 'misses the leap');
    }
  }

  /** MainlinerJumpAttackGrapple start: stick to the front or the back. */
  private grab(env: ActorEnv) {
    const a = this.a;
    if (!this.hold.start()) return;
    const g = { x: -Math.sin(env.player.yaw), z: -Math.cos(env.player.yaw) };
    this.side = -Math.sin(a.yaw) * g.x + -Math.cos(a.yaw) * g.z >= 0 ? 1 : 0;
    // The leap's blow (Arm / Disarm of the leap Attack) [inferred: normal melee damage].
    if (!this.leapHit) {
      this.leapHit = true;
      this.rt.hurtPlayer(this.jump.leapDamage, a, env);
      this.stats.dealt += this.jump.leapDamage;
    }
    this.st = 'ride';
    this.t = 0;
    this.ride = 0;
    this.rideClock = 0;
    this.unlocked = false;
    this.presses = 0;
    this.stats.rides++;
    this.play(this.jump.stick[this.side].clip, false, 0);
    this.rt.playerBody?.play(PLAYER_RIDE.stick[this.side], { lock: true, timeScale: 0 });
    this.rt.log(a, `sticks to the player (${this.side ? 'back' : 'front'})`);
  }

  /** Grapple start on a character (0x1007e290, the non-player branch). */
  private grabNpc(o: Actor) {
    const a = this.a;
    const g = { x: -Math.sin(o.yaw), z: -Math.cos(o.yaw) };
    this.side = -Math.sin(a.yaw) * g.x + -Math.cos(a.yaw) * g.z >= 0 ? 1 : 0;
    if (!this.leapHit) {
      this.leapHit = true;
      this.rt.hurtActor(o, this.jump.leapDamage, a);
      this.stats.dealt += this.jump.leapDamage;
    }
    const inc = mainlinerVictim(this.rt.pkgs, o.entity?.values ?? this.rt.template(o.kind.template)?.v ?? []).incapacitate[this.side];
    const dmg = inc.mult * this.jump.base;
    if (dmg > 0) {
      this.rt.hurtActor(o, dmg, a);
      this.stats.dealt += dmg;
    }
    this.rt.effect(inc.fx, { x: o.position.x, y: o.bottom + o.height * 0.6, z: o.position.z });
    this.victim = o;
    this.st = 'rideNpc';
    this.t = 0;
    this.npcTimer = this.jump.ride;
    this.stats.npcRides++;
    // The victim's incapacitate clip, else the side's stick clip (missing p141 / p142).
    if (!this.play(inc.clip ?? this.jump.stick[this.side].clip)) this.play(this.jump.stick[this.side].clip);
    this.rt.log(a, `sticks to ${o.ch.root.name} (${this.side ? 'back' : 'front'})`);
  }

  /** The ride on a character (0x1007f9f0 without the player's struggle). */
  private rideNpc(dt: number, env: ActorEnv) {
    const a = this.a, o = this.victim;
    this.npcTimer -= dt;
    if (o) {
      const fx = -Math.sin(o.yaw), fz = -Math.cos(o.yaw);
      const off = this.side ? -0.35 : 0.45;
      a.motor.position.x = o.position.x + fx * off;
      a.motor.position.y = o.position.y;
      a.motor.position.z = o.position.z + fz * off;
      a.yaw = this.side ? o.yaw : o.yaw + Math.PI;
    }
    if (this.npcTimer < 0) {
      this.stats.thrown++;
      this.rt.log(a, 'thrown off (ride time)');
      return this.leaveNpc(env, this.p.thrown);
    }
    if (!o?.alive || this.clipIdx < 0 || a.clipDone) {
      const j = this.jump, dmg = j.stick[this.side].mult * j.base;
      if (o?.alive) {
        this.rt.hurtActor(o, dmg, a);
        this.stats.dealt += dmg;
        this.rt.effect(j.stick[this.side].fx, { x: o.position.x, y: o.bottom + o.height * 0.6, z: o.position.z });
      }
      this.stats.finishers++;
      this.rt.log(a, `finisher ${dmg} on ${o?.ch.root.name ?? '?'}`);
      return this.leaveNpc(env, this.p.jumpOff);
    }
  }

  private leaveNpc(env: ActorEnv, clips: [ClipRef | undefined, ClipRef | undefined, ClipRef | undefined]) {
    const a = this.a, o = this.victim;
    this.victim = null;
    if (o) {
      const back = this.side ? 1.4 : -1.4;
      const fx = -Math.sin(o.yaw), fz = -Math.cos(o.yaw);
      const to = new THREE.Vector3(o.position.x - fx * back, o.position.y, o.position.z - fz * back);
      if (clearLine(env.world, o.position.x, o.position.y + 0.8, o.position.z, to.x, to.y + 0.8, to.z)) a.motor.teleport(to.x, to.y + 0.05, to.z);
      a.yaw = yawTo(a.position, o.position);
    }
    this.st = 'off';
    this.t = 0;
    this.play(clips[2] ?? clips[0]);
  }

  private rideUpdate(dt: number, env: ActorEnv) {
    const a = this.a, pl = env.player;
    // Ride on the player: at his feet, in front facing him or behind facing his way.
    const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    const off = this.side ? -0.35 : 0.45;
    a.motor.position.x = pl.position.x + fx * off;
    a.motor.position.y = pl.position.y;
    a.motor.position.z = pl.position.z + fz * off;
    a.yaw = this.side ? pl.yaw : pl.yaw + Math.PI;
    if (!this.rt.playerAlive) return this.jumpOff(env, 'the player died');
    if (env.ignorePlayer) return this.jumpOff(env, 'enemies ignore the player (port option)');
    const j = this.jump;
    const len = this.clipIdx >= 0 ? a.ch.clipData[this.clipIdx]?.duration ?? 2 : 2;
    this.ride += dt * (1 + (Math.random() * 2 - 1) * j.jitter);
    if (!this.unlocked && this.ride >= PLAYER_RIDE.unlock) {
      this.unlocked = true;
      this.presses = this.hold.presses;
    }
    if (this.unlocked) {
      this.rideClock += dt;
      const pressed = this.hold.presses - this.presses;
      this.presses = this.hold.presses;
      this.ride -= pressed * PLAYER_RIDE.press;
    }
    // Both clips show the ride clock.
    const act = a.ch.current;
    if (act) act.time = Math.max(0, Math.min(len, this.ride));
    const body = this.rt.playerBody?.body?.current;
    if (body) body.time = Math.max(0, Math.min(len, this.ride));
    if (this.ride >= len) {
      const dmg = j.stick[this.side].mult * j.base;
      this.rt.hurtPlayer(dmg, a, env);
      this.stats.dealt += dmg;
      this.stats.finishers++;
      this.rt.effect(j.stick[this.side].fx, { x: pl.position.x, y: pl.position.y + 1.2, z: pl.position.z });
      this.rt.log(a, `finisher ${dmg}`);
      return this.jumpOff(env, 'finisher');
    }
    if (this.ride < 0 || this.rideClock > j.ride) {
      this.stats.thrown++;
      this.rt.log(a, `thrown off (${this.ride < 0 ? 'struggle' : 'ride time'}, ${this.hold.presses} presses)`);
      return this.leave(env, this.p.thrown, PLAYER_RIDE.thrown[this.side], this.side ? 1.4 : -1.4);
    }
  }

  private jumpOff(env: ActorEnv, why: string) {
    this.rt.log(this.a, `jumps off (${why})`);
    this.leave(env, this.p.jumpOff, PLAYER_RIDE.jumpOff[this.side], this.side ? 1.6 : -1.6);
  }

  /** End the ride: the player is let go, the Mainliner lands a little away from him. */
  private leave(env: ActorEnv, clips: [ClipRef | undefined, ClipRef | undefined, ClipRef | undefined], playerClip: ClipRef, back: number) {
    const a = this.a, pl = env.player;
    this.release();
    if (this.rt.playerAlive) this.rt.playerBody?.play(playerClip, {});
    const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    const to = new THREE.Vector3(pl.position.x - fx * back, pl.position.y, pl.position.z - fz * back);
    if (clearLine(env.world, pl.position.x, pl.position.y + 0.8, pl.position.z, to.x, to.y + 0.8, to.z)) {
      a.motor.teleport(to.x, to.y + 0.05, to.z);
    }
    a.yaw = yawTo(a.position, pl.position);
    this.st = 'off';
    this.t = 0;
    this.play(clips[2] ?? clips[0]);
  }

  private release() {
    if (!this.hold.active) return;
    this.hold.release();
    this.rt.playerBody?.release(0.15);
  }

  private finish(env: ActorEnv) {
    const a = this.a;
    this.st = 'none';
    a.state = 'chase';
    // A placed jump-attack behaviour completes: its chain successor, else the active behaviour.
    if (this.fromRoot && a.behavior === this.fromRoot) {
      const next = this.fromRoot.next.length ? env.behaviors?.fromPlaced(this.fromRoot.next[0]) : undefined;
      a.setBehavior(next ?? (a.profile.active?.kind === 'dormant' ? undefined : a.profile.active), env);
    }
  }

  dispose() {
    this.release();
  }
}

export const createMainliner = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Mainliner(a, rt);
