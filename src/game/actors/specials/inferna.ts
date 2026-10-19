// Inferna: the burning creature (docs §15.7.6). Decoded from Suffering.rfl: TakeDamage
// 0x10078400, class update 0x10078cf0, InfernaStartFlaming 0x1007a730 / 0x100794e0,
// InfernaKillObject 0x1007a550 / 0x10079bd0 / 0x1007a620, InfernaFlamingKill 0x1007a920 /
// 0x1007acb0 / 0x1007aa00, CircleTarget(Steering) 0x1007a120 / 0x1007afd0, FlameAttack
// 0x100799a0, InfernaAsh 0x1007adb0 / 0x1007b620.
//
// Modes: unlit -> igniting -> flaming -> collapsing -> ash -> reforming -> flaming ...
//   * It can only be hurt as an ash pile: damage while flaming only burns down its flame timer
//     (p187 s per point), and does nothing in the other modes.
//   * Ignites (StartFlaming: clip p2, model swap to p188, clip p3) on its p192 message, on
//     MorphCharacter (220) while dormant, or when its target comes within KillObject p2 (20 m);
//     p184 instances start alight. The flame lasts p185..p186 s.
//   * Flaming, it circles the target at KillObject p5 (4 m; clips p182 / p183, direction
//     reversed when blocked) while the target stays within p4 (11 m), and every FlamingKill
//     p4..p5 s attacks: within p6..p7 (0..5 m) a flame burst (p3 clip; at its Fire marker the p2
//     generator: fire, shake, screen fader and Radius Damage 20 -> 5 over 10 / 20 m); within
//     p8..p9 (6..30 m) a fireball (ProjectileAttack p88: the p55 BouncingObject, 12.2 m/s,
//     detonating Radius Damage); otherwise it repositions (p10 % toward the fireball band).
//   * Flame out: InfernaAsh collapses (p2), turns into the ash pile p190 with its ash effects
//     (p191) and plays p3; it is vulnerable for p6..p7 s, then reforms (p4, flaming model, p5).
// Port: the burn-on-hit effect (BurnFX 4:1335) is not applied; repositioning walks straight.

import * as THREE from 'three/webgpu';
import { readSkinnedModel } from '../../../formats/skeleton';
import { Character, decodeCharacterTextures } from '../../../app/character';
import type { Actor, ActorEnv } from '../actor';
import { clearLine } from '../nav';
import { loadClip, type ClipRef } from '../clipmap';
import { clipMarkers } from './clip-events';
import { fightTarget, infernaParams, type InfernaParams, type RadiusDamage } from './params';
import { drive, flat, rand, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';

const MARK_FIRE = 102;
const MARK_THROW = 230;
const MSG_MORPH = 220;

type Mode = 'unlit' | 'igniting' | 'flaming' | 'collapsing' | 'ash' | 'reforming';
type Act = 'none' | 'circle' | 'flame' | 'ball' | 'move';

interface Ball {
  from: THREE.Vector3;
  to: THREE.Vector3;
  at: number;
}

class Inferna implements SpecialMove {
  readonly name = 'inferna';
  mode: Mode = 'unlit';
  private act: Act = 'none';
  private p: InfernaParams;
  private flame = 0;
  private t = 0;
  private decide = 0;
  private circleDir = 1;
  private stuck = 0;
  private moveGoal = new THREE.Vector3();
  private fired = false;
  private ashLeft = 0;
  private phase = 0;
  private voiceAt = 0;
  private balls: Ball[] = [];
  private orig: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] } | null = null;
  private flameLook: Character | null = null;
  private ash: Character | null = null;
  private stats = { ignitions: 0, flames: 0, fireballs: 0, ashes: 0, reforms: 0, dealt: 0, absorbed: 0 };

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    this.p = infernaParams(rt.pkgs, a.entity?.values ?? rt.template(a.kind.template)?.v ?? []);
    a.damageFilter = (amount) => {
      if (this.mode === 'ash') return amount;
      if (this.mode === 'flaming') {
        this.flame -= this.p.burnPerDamage * amount;
        this.stats.absorbed += amount;
      }
      return 0;
    };
    if (this.p.startLit) {
      this.setFlaming(true);
      this.flame = rand(0, this.p.burn[1]);
    }
  }

  info() {
    return { inf: this.mode, act: this.act, flame: +this.flame.toFixed(1), ash: +this.ashLeft.toFixed(1), ...this.stats };
  }

  // --- looks --------------------------------------------------------------------------

  private setFlaming(on: boolean) {
    const mesh = this.a.ch.mesh;
    if (on) {
      this.mode = 'flaming';
      if (!this.flameLook && this.p.flameModel) {
        const sk = readSkinnedModel(this.rt.ctx.loaded.packages!, this.p.flameModel);
        if (sk && sk.skeleton.bones.length === this.a.kind.skinned.skeleton.bones.length) this.flameLook = new Character(sk, [], decodeCharacterTextures(sk, this.rt.ctx.loaded.packages!));
      }
      if (this.flameLook && !this.orig) {
        this.orig = { geometry: mesh.geometry, material: mesh.material };
        mesh.geometry = this.flameLook.mesh.geometry;
        mesh.material = this.flameLook.mesh.material;
      }
      this.flame = rand(this.p.burn[0], this.p.burn[1]);
    } else if (this.orig) {
      mesh.geometry = this.orig.geometry;
      mesh.material = this.orig.material;
      this.orig = null;
    }
  }

  /** The ash pile: a separate rig (p190) shown in place of the body. */
  private showAsh(on: boolean, clip?: ClipRef) {
    const a = this.a;
    if (on && !this.ash && this.p.ashModel) {
      const pk = this.rt.ctx.loaded.packages!;
      const sk = readSkinnedModel(pk, this.p.ashModel);
      if (sk) {
        const clips = [this.p.ash[1], this.p.ash[2]].map((c) => (c ? loadClip(pk, c) : undefined)).filter((c): c is NonNullable<typeof c> => !!c);
        this.ash = new Character(sk, clips, decodeCharacterTextures(sk, pk));
        a.ch.root.parent?.add(this.ash.root);
      }
    }
    // The body mesh is culled by the manager every frame: shrink it away instead of hiding it.
    a.ch.mesh.scale.setScalar(on ? 1e-4 : 1);
    if (!this.ash) return;
    this.ash.root.visible = on;
    this.ash.root.position.copy(a.ch.root.position);
    this.ash.root.rotation.copy(a.ch.root.rotation);
    if (on && clip) {
      const i = clip === this.p.ash[1] ? 0 : 1;
      this.ash.play(i, { loop: false, fade: 0 });
    }
  }

  private play(c: ClipRef | undefined, loop = false) {
    const env = this.rt.manager.env;
    const i = env ? env.clip(this.a, c) : -1;
    if (i >= 0) {
      const act = this.a.playClip(i, loop);
      if (act) act.time = 0;
    }
    return i >= 0;
  }

  // --- messages -----------------------------------------------------------------------

  message(msg: number): boolean {
    if (this.mode !== 'unlit') return false;
    if ((this.p.igniteMsg && msg === this.p.igniteMsg) || (msg === MSG_MORPH && this.a.behavior?.kind === 'dormant')) {
      this.ignite();
      return true;
    }
    return false;
  }

  private ignite() {
    if (this.mode !== 'unlit') return;
    this.mode = 'igniting';
    this.phase = 0;
    this.t = 0;
    this.stats.ignitions++;
    this.a.wake();
    if (!this.play(this.p.ignite[0])) this.phase = 1;
    this.rt.log(this.a, 'ignites');
  }

  // --- per frame ----------------------------------------------------------------------

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    this.balls.length && this.flyBalls(env);
    if (!a.alive) {
      if (this.ash) this.showAsh(true);
      return false;
    }
    this.t += dt;
    if (this.ash && this.mode === 'ash') this.ash.update(dt);
    switch (this.mode) {
      case 'unlit': {
        const tgt = fightTarget(a, env);
        if (tgt && flat(a.position, tgt.pos) <= this.p.igniteRange) this.ignite();
        return false;
      }
      case 'igniting':
        a.state = 'act';
        if (a.clipDone || this.t > 3) {
          if (this.phase === 0) {
            this.phase = 1;
            this.t = 0;
            this.setFlaming(true);
            this.mode = 'igniting';
            if (!this.play(this.p.ignite[1])) this.phase = 2;
          } else {
            this.mode = 'flaming';
            this.act = 'none';
            this.decide = rand(this.p.decide[0], this.p.decide[1]);
          }
        }
        a.sync();
        return true;
      case 'flaming':
        return this.flaming(dt, env);
      case 'collapsing':
        a.state = 'act';
        if (a.clipDone || this.t > 3) {
          this.mode = 'ash';
          this.t = 0;
          this.ashLeft = rand(this.p.ashTime[0], this.p.ashTime[1]);
          this.showAsh(true, this.p.ash[1]);
          for (const f of this.p.ashFx) this.rt.effect(f.fx, a.position);
          this.rt.log(a, `burns out: ash pile for ${this.ashLeft.toFixed(1)} s`);
        }
        a.sync();
        return true;
      case 'ash':
        a.state = 'act';
        this.ashLeft -= dt;
        if (this.ashLeft <= 0) {
          this.mode = 'reforming';
          this.phase = 0;
          this.t = 0;
          this.showAsh(true, this.p.ash[2]);
        }
        a.sync();
        return true;
      case 'reforming':
        a.state = 'act';
        if (this.phase === 0 && (this.t > 1.3 || !this.ash)) {
          this.phase = 1;
          this.t = 0;
          this.showAsh(false);
          this.setFlaming(true);
          this.play(this.p.ash[3]);
        } else if (this.phase === 1 && (a.clipDone || this.t > 2.5)) {
          this.mode = 'flaming';
          this.act = 'none';
          this.stats.reforms++;
          this.rt.log(a, 'reforms');
        }
        a.sync();
        return true;
    }
    return false;
  }

  private flaming(dt: number, env: ActorEnv): boolean {
    const a = this.a, tgt = fightTarget(a, env), p = tgt?.pos ?? env.player.position;
    // Burning voice lines now and then.
    if (env.time > this.voiceAt) {
      this.voiceAt = env.time + rand(this.p.voiceEvery[0], this.p.voiceEvery[1]);
      if (a.drawn) this.rt.sound(this.p.voices, a.position, 0.8);
    }
    if (this.act !== 'flame') this.flame -= dt; // the flame attack pauses the timer (flag 0x80000)
    if (this.flame <= 0 && this.act !== 'flame' && this.act !== 'ball') {
      this.mode = 'collapsing';
      this.t = 0;
      this.act = 'none';
      this.stats.ashes++;
      this.play(this.p.ash[0]);
      a.sync();
      return true;
    }
    const d = flat(a.position, p);
    if (this.act === 'none') {
      if (!tgt || d > this.p.circleLimit) return false; // generic chase closes in
      this.act = 'circle';
      this.circleDir = Math.random() < 0.5 ? 1 : -1;
      this.stuck = 0;
    }
    a.state = 'act';
    switch (this.act) {
      case 'circle': {
        if (d > this.p.circleLimit) {
          this.act = 'none';
          a.state = 'chase';
          return false;
        }
        this.decide -= dt;
        const clip = this.p.circle[this.circleDir > 0 ? 0 : 1];
        const i = env.clip(a, clip);
        if (i >= 0) a.playClip(i, true);
        // Tangent around the target with a radial correction toward the circle radius.
        const dx = a.position.x - p.x, dz = a.position.z - p.z;
        const r = Math.max(0.1, Math.hypot(dx, dz));
        const tx = -dz / r * this.circleDir, tz = dx / r * this.circleDir;
        const k = 1 - r / this.p.circleRadius;
        const wx = tx + (dx / r) * k, wz = tz + (dz / r) * k;
        turnToward(a, Math.atan2(-wx, -wz), 6, dt);
        const speed = i >= 0 ? Math.min(7, a.kind.speeds[i] || 5) : 5;
        const moved = drive(a, dt, wx, wz, speed);
        if (moved < 0.015 * speed * 10 * dt) {
          if (++this.stuck === 1) this.circleDir = -this.circleDir;
          else if (this.stuck > 20) this.decide = 0;
        } else this.stuck = 0;
        if (this.decide <= 0) this.chooseAttack(env);
        break;
      }
      case 'move': {
        const dm = flat(a.position, this.moveGoal);
        turnToward(a, yawTo(a.position, this.moveGoal), 6, dt);
        const i = a.kind.run >= 0 ? a.kind.run : a.kind.walk;
        if (i >= 0) a.playClip(i, true);
        drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), a.kind.runSpeed);
        this.t += dt;
        if (dm < 1 || this.t > 4) this.chooseAttack(env, true);
        break;
      }
      case 'flame':
      case 'ball': {
        turnToward(a, yawTo(a.position, p), 5, dt);
        this.t += dt;
        const at = this.act === 'flame' ? clipMarkers(this.rt.ctx.loaded.packages!, this.p.flame.clip).find((m) => m.param === MARK_FIRE)?.time ?? 1.26 : clipMarkers(this.rt.ctx.loaded.packages!, this.p.ball.clip).find((m) => m.param === MARK_THROW)?.time ?? 1.09;
        if (!this.fired && (a.ch.current?.time ?? this.t) >= at) {
          this.fired = true;
          if (this.act === 'flame') this.flameBurst(env);
          else this.throwBall(env);
        }
        if (a.clipDone || this.t > 4) {
          this.act = 'circle';
          this.decide = rand(this.p.decide[0], this.p.decide[1]);
        }
        break;
      }
    }
    a.sync();
    return true;
  }

  /** FlamingKill decision (0x1007aa00). */
  private chooseAttack(env: ActorEnv, afterMove = false) {
    const a = this.a, p = fightTarget(a, env)?.pos ?? env.player.position;
    const d = Math.hypot(p.x - a.position.x, p.y - a.position.y, p.z - a.position.z);
    const visible = clearLine(env.world, a.position.x, a.position.y + 1, a.position.z, p.x, p.y + 1, p.z);
    this.decide = rand(this.p.decide[0], this.p.decide[1]);
    this.t = 0;
    this.fired = false;
    if (d >= this.p.flameBand[0] && d <= this.p.flameBand[1] && (visible || !afterMove)) {
      this.act = 'flame';
      this.stats.flames++;
      this.play(this.p.flame.clip);
      this.rt.log(a, `flame attack at ${d.toFixed(1)} m`);
    } else if (d >= this.p.ballBand[0] && d <= this.p.ballBand[1] && visible) {
      this.act = 'ball';
      this.stats.fireballs++;
      this.play(this.p.ball.clip);
      this.rt.log(a, `fireball at ${d.toFixed(1)} m`);
    } else if (!afterMove) {
      // Reposition: p10 % into the fireball band, else into the flame band.
      const band = Math.random() * 100 < this.p.ballChance ? this.p.ballBand : this.p.flameBand;
      const want = rand(band[0], band[1]);
      const dx = a.position.x - p.x, dz = a.position.z - p.z, l = Math.hypot(dx, dz) || 1;
      this.moveGoal.set(p.x + (dx / l) * want, a.position.y, p.z + (dz / l) * want);
      this.act = 'move';
    } else this.act = 'circle';
  }

  /** Flame burst: the p2 generator's effects at the Inferna and its Radius Damage. */
  private flameBurst(env: ActorEnv) {
    const a = this.a;
    const at = { x: a.position.x, y: a.position.y + 1, z: a.position.z };
    for (const fx of this.p.flame.parts.effects) this.rt.effect(fx, at, { x: -Math.sin(a.yaw), y: 0, z: -Math.cos(a.yaw) });
    const r = this.p.flame.parts.radius;
    if (r) this.radius(r, at, env);
  }

  private throwBall(env: ActorEnv) {
    const a = this.a, p = fightTarget(a, env)?.pos ?? env.player.position;
    const b = a.ch.skeleton.bones[this.p.ball.boneFrom];
    const from = new THREE.Vector3();
    if (b) b.getWorldPosition(from);
    else from.set(a.position.x, a.position.y + 1.4, a.position.z);
    const to = new THREE.Vector3(p.x, p.y + 0.5, p.z);
    const hit = env.world.raycast(from.x, from.y, from.z, to.x - from.x, to.y - from.y, to.z - from.z, 1);
    if (hit && hit.distance < 1) to.lerpVectors(from, to, Math.max(0, hit.distance - 0.05));
    const speed = Math.max(4, this.p.ball.speed);
    env.shotFx?.(from, to, true, speed);
    this.balls.push({ from, to, at: env.time + from.distanceTo(to) / speed });
  }

  private flyBalls(env: ActorEnv) {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      if (env.time < b.at) continue;
      this.balls.splice(i, 1);
      for (const fx of this.p.ball.parts.effects) this.rt.effect(fx, b.to);
      const r = this.p.ball.parts.radius;
      if (r) this.radius(r, b.to, env);
    }
  }

  /**
   * Radius Damage: full to the inner radius, down to the minimum at the outer one, walls block.
   * It hurts every character in reach as well as the player (a Radius Damage has no target:
   * docs §8 throwables) [verified class rule]; the Inferna itself is left out [inferred].
   */
  private radius(r: RadiusDamage, at: THREE.Vector3Like, env: ActorEnv) {
    const amountAt = (d: number) => (d <= r.inner ? r.max : r.max - ((d - r.inner) / Math.max(1e-3, r.outer - r.inner)) * (r.max - r.min));
    const p = env.player.position;
    const d = Math.hypot(p.x - at.x, p.y + 1 - at.y, p.z - at.z);
    if (d < r.outer && env.playerAlive && clearLine(env.world, at.x, at.y + 0.2, at.z, p.x, p.y + 1, p.z)) {
      const amount = amountAt(d);
      this.rt.hurtPlayer(amount, this.a, env);
      this.stats.dealt += amount;
      this.rt.log(this.a, `fire ${amount.toFixed(1)} at ${d.toFixed(1)} m`);
    }
    for (const o of env.actors) {
      if (o === this.a || !o.alive || o.hidden || o.kind.decor || o.template) continue;
      const cy = o.bottom + o.height * 0.5;
      const dd = Math.hypot(o.position.x - at.x, cy - at.y, o.position.z - at.z);
      if (dd >= r.outer || !clearLine(env.world, at.x, at.y + 0.2, at.z, o.position.x, cy, o.position.z)) continue;
      const amount = amountAt(dd);
      this.rt.hurtActor(o, amount, this.a);
      this.stats.dealt += amount;
      this.rt.log(this.a, `fire ${amount.toFixed(1)} on ${o.ch.root.name} at ${dd.toFixed(1)} m`);
    }
  }

  dispose() {
    this.ash?.root.removeFromParent();
    this.ash?.dispose();
    if (this.orig) this.setFlaming(false);
    this.flameLook?.dispose();
  }
}

export const createInferna = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Inferna(a, rt);
