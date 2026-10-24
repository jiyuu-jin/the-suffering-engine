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
//   * Movement (docs §15.7.6, "How it moves"): the KillObject walks a MoveTo on the Move Node
//     graph to within p3 (8 m) of the target; then the FlamingKill circles it at KillObject p5
//     (4 m; clips p182 / p183) by steering alone while the target stays within p4 (11 m), and
//     every FlamingKill p4..p5 s attacks: within p6..p7 (0..5 m) a flame burst (p3 clip; at its
//     Fire marker the p2 generator: fire, shake, screen fader and Radius Damage 20 -> 5 over 10 /
//     20 m); within p8..p9 (6..30 m) a fireball (ProjectileAttack p88: the p55 BouncingObject,
//     12.2 m/s, detonating Radius Damage); otherwise it repositions by a MoveTo (p10 % toward the
//     fireball band). The circling steering has no graph or ground test.
//   * Flame out: InfernaAsh collapses (p2), turns into the ash pile p190 with its ash effects
//     (p191) and plays p3; it is vulnerable for p6..p7 s, then reforms (p4, flaming model, p5).
// Port: the burn-on-hit effect (BurnFX 4:1335) is not applied.

import * as THREE from 'three/webgpu';
import { readSkinnedModel } from '../../../formats/skeleton';
import { Character, decodeCharacterTextures } from '../../../app/character';
import type { Actor, ActorEnv } from '../actor';
import { loadClip, type ClipRef } from '../clipmap';
import { clipMarkers } from './clip-events';
import { fightTarget, infernaParams, noTargetAim, type InfernaParams, type RadiusDamage } from './params';
import { drive, flat, rand, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';
import { clearLine, groundAlong } from '../nav';

const MARK_FIRE = 102;
const MARK_THROW = 230;
const MSG_MORPH = 220;

type Mode = 'unlit' | 'igniting' | 'flaming' | 'collapsing' | 'ash' | 'reforming';
/** 'chase': the KillObject's MoveTo; 'circle': the FlamingKill's CircleTarget; 'move': its reposition MoveTo. */
type Act = 'none' | 'chase' | 'circle' | 'flame' | 'ball' | 'move';

/** InfernaCircleTargetSteering's stuck window (s), 0x1007afd0 / 0x1007b0f0 [verified]. */
export const CIRCLE_STUCK_WINDOW = 0.15;
/** Stuck: the window's positions within this x the steering speed (m per m/s) [verified]. */
export const CIRCLE_STUCK_SPREAD = 0.015;

/**
 * InfernaCircleTargetSteering's wish (0x100796d0) [verified]: n is the unit vector from the
 * Inferna to the target on the ground plane, the tangent (n.z, -n.x) for direction flag 0 and
 * (-n.z, n.x) for 1 (the flag is drawn 50 / 50 when the steering starts); inside the radius
 * k = 1 - d / R, outside k = R / d - 1, and the wish tangent x (1 - |k|) - n x k is scaled to the
 * steering's speed (the circle clip's, movement mode 3). Returns the unit direction (x, z).
 */
export function circleWish(ax: number, az: number, tx: number, tz: number, radius: number, flag: 0 | 1): [number, number] {
  const dx = tx - ax, dz = tz - az, d = Math.hypot(dx, dz);
  if (d < 1e-4) return [0, 0];
  const nx = dx / d, nz = dz / d;
  const [ux, uz] = flag === 0 ? [nz, -nx] : [-nz, nx];
  const k = d < radius ? 1 - d / radius : radius / d - 1;
  const w = 1 - Math.abs(k);
  const x = ux * w - nx * k, z = uz * w - nz * k, l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : [0, 0];
}

/**
 * The steering's stuck test (0x1007b0f0) [verified]: over each 0.15 s window it keeps a circle
 * round the body's ground positions (a position outside it moves the centre towards it and the
 * radius to the mean of the two); at the window's end the body is stuck when that radius is under
 * 0.015 x the steering's speed (a tenth of the window's travel). Stuck once, the direction
 * reverses; stuck in the next window too, the steering gives up ('end': the circle goes on without
 * it, the body stands until the FlamingKill's next decision [inferred: the CircleTarget's
 * child-end handler 0x10101530 does nothing]); a free window clears the reversal.
 */
export class CircleStuck {
  private left = CIRCLE_STUCK_WINDOW;
  private cx = 0;
  private cz = 0;
  private r = 0;
  private reversed = false;
  reset(x: number, z: number) {
    this.left = CIRCLE_STUCK_WINDOW;
    this.cx = x;
    this.cz = z;
    this.r = 0;
    this.reversed = false;
  }
  step(dt: number, x: number, z: number, speed: number): 'reverse' | 'end' | undefined {
    this.left -= dt;
    if (this.left > 0) {
      const dx = x - this.cx, dz = z - this.cz, d = Math.hypot(dx, dz);
      if (d > this.r) {
        const r = (d + this.r) * 0.5;
        this.cx = x - (dx / d) * r;
        this.cz = z - (dz / d) * r;
        this.r = r;
      }
      return undefined;
    }
    this.left = CIRCLE_STUCK_WINDOW;
    const stuck = CIRCLE_STUCK_SPREAD * speed > this.r;
    if (stuck && this.reversed) return 'end';
    this.reversed = stuck;
    this.cx = x;
    this.cz = z;
    this.r = 0;
    return stuck ? 'reverse' : undefined;
  }
}

/**
 * The FlamingKill's reposition MoveTo (0x1007abc5) [verified]: towards the target, to a distance
 * drawn from the band; nearer than now it is the MoveTo's arrival distance (request +0x1c), farther
 * its least distance (+0x20). Done when the body is there.
 */
export function repositionDone(d: number, want: number, away: boolean) {
  return away ? d >= want : d <= want;
}

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
  /** The circling steering runs (it gives up when stuck twice; CircleStuck). */
  private steering = true;
  private stuck = new CircleStuck();
  private moveGoal = new THREE.Vector3();
  private moveWant = 0;
  private moveAway = false;
  /** The reposition's attack, drawn with its band (FlamingKill +0x40: the fireball band). */
  private moveBall = false;
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
      a.specialWalk = undefined;
      if (this.ash) this.showAsh(true);
      return false;
    }
    if (this.mode !== 'flaming' && this.mode !== 'unlit') a.specialWalk = undefined;
    this.t += dt;
    if (this.ash && this.mode === 'ash') this.ash.update(dt);
    switch (this.mode) {
      case 'unlit': {
        // The KillObject's MoveTo runs from its start, lit or not; the KillObject ignites the
        // body once the target is within p2 (0x1007a620).
        const tgt = fightTarget(a, env);
        const d = tgt ? flat(a.position, tgt.pos) : Infinity;
        this.walk(tgt && d > this.p.approach ? tgt.pos : this.holdStill(), 'none');
        if (tgt && d <= this.p.igniteRange) {
          a.specialWalk = undefined;
          this.ignite();
        }
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
    const a = this.a, tgt = fightTarget(a, env), p = tgt?.pos ?? noTargetAim(a, env);
    // Burning voice lines now and then.
    if (env.time > this.voiceAt) {
      this.voiceAt = env.time + rand(this.p.voiceEvery[0], this.p.voiceEvery[1]);
      if (a.drawn) this.rt.sound(this.p.voices, a.position, 0.8);
    }
    if (this.act !== 'flame') this.flame -= dt; // the flame attack pauses the timer (flag 0x80000)
    if (this.flame <= 0 && this.act !== 'flame' && this.act !== 'ball') {
      this.walk(undefined, 'none');
      this.mode = 'collapsing';
      this.t = 0;
      this.act = 'none';
      this.stats.ashes++;
      this.play(this.p.ash[0]);
      a.sync();
      return true;
    }
    const d = flat(a.position, p);
    if (this.act === 'none' || this.act === 'chase') {
      // The KillObject's MoveTo: on the graph to within p3 of the target, then the FlamingKill.
      if (!tgt) return this.walk(this.holdStill(), 'none');
      if (d > this.p.approach) return this.walk(p, 'chase');
      this.walk(undefined, 'none');
      this.startCircle();
    }
    a.state = 'act';
    switch (this.act) {
      case 'circle': {
        // The CircleTarget ends with the target beyond p4 (horizontally, 0x10079660); the
        // FlamingKill then ends and the KillObject walks its MoveTo again.
        if (!tgt || d > this.p.circleLimit) {
          a.state = 'chase';
          return this.walk(tgt ? p : this.holdStill(), tgt ? 'chase' : 'none');
        }
        this.decide -= dt;
        if (this.decide <= 0) {
          this.chooseAttack(env);
          break;
        }
        if (!this.steering) {
          if (a.kind.idle >= 0) a.playClip(a.kind.idle, true);
          turnToward(a, yawTo(a.position, p), 3, dt);
          drive(a, dt, 0, 0, 0.01);
          break;
        }
        const clip = this.p.circle[this.circleDir > 0 ? 0 : 1];
        const i = env.clip(a, clip);
        if (i >= 0) a.playClip(i, true);
        const [wx, wz] = circleWish(a.position.x, a.position.z, p.x, p.z, this.p.circleRadius, this.circleDir > 0 ? 0 : 1);
        if (wx || wz) turnToward(a, Math.atan2(-wx, -wz), 6, dt);
        const speed = i >= 0 ? Math.min(7, a.kind.speeds[i] || 5) : 5;
        drive(a, dt, wx, wz, speed);
        const s = this.stuck.step(dt, a.position.x, a.position.z, speed);
        if (s === 'reverse') this.circleDir = -this.circleDir;
        else if (s === 'end') this.steering = false;
        break;
      }
      case 'move': {
        const d3 = Math.hypot(p.x - a.position.x, p.y - a.position.y, p.z - a.position.z);
        if (repositionDone(d3, this.moveWant, this.moveAway)) {
          // Arrived (0x1007acb0): the attack drawn with the band when the target is in sight,
          // else the circle again.
          this.walk(undefined, 'none');
          if (clearLine(env.world, a.position.x, a.position.y + 1, a.position.z, p.x, p.y + 1, p.z)) this.startAttack(this.moveBall);
          else this.startCircle();
          break;
        }
        // A MoveTo that gets nowhere fails: the circle again [port: the original's MoveTo
        // failure rule is the path's; the port gives it 4 s].
        if (this.t > 4) {
          this.walk(undefined, 'none');
          this.startCircle();
          break;
        }
        if (this.moveAway) {
          const dx = a.position.x - p.x, dz = a.position.z - p.z, l = Math.hypot(dx, dz) || 1;
          this.moveGoal.set(p.x + (dx / l) * this.moveWant, a.position.y, p.z + (dz / l) * this.moveWant);
          // Off the ground (over a drop): the goal is the graph's node there instead (the
          // MoveTo walks the graph's areas) [inferred].
          if (!groundAlong(env.world, a.position.x, a.position.y, a.position.z, this.moveGoal.x, this.moveGoal.y, this.moveGoal.z, a.radius)) {
            const nav = env.nav, k = nav?.nearest(this.moveGoal.x, this.moveGoal.y, this.moveGoal.z, env.world, 6, 0, 'floor', undefined, true) ?? -1;
            if (nav && k >= 0) this.moveGoal.set(nav.nodes[k].x, nav.nodes[k].y, nav.nodes[k].z);
            else this.moveGoal.set(a.position.x, a.position.y, a.position.z);
          }
        } else this.moveGoal.set(p.x, p.y, p.z);
        a.state = 'chase';
        return this.walk(this.moveGoal, 'move');
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
        // FlameAttack / ProjectileAttack done: the circle again (0x1007ad96).
        if (a.clipDone || this.t > 4) this.startCircle();
        break;
      }
    }
    a.sync();
    return true;
  }

  /**
   * In a fight with no target yet (the generic perception picks it): the KillObject is not
   * running, and the generic combat (a ProjectileAttack throw, keeping its distance) is not the
   * Inferna's; it stands where it is (a MoveTo to its own feet).
   */
  private holdStill(): THREE.Vector3Like | undefined {
    return this.a.inCombat ? this.a.position : undefined;
  }

  /**
   * A MoveTo child walked by the generic AI (Actor.specialWalk): returns false so that the tick's
   * generic update moves the body; `goal` undefined ends the walk.
   */
  private walk(goal: THREE.Vector3Like | undefined, act: Act): false {
    this.act = act;
    if (goal) {
      this.a.specialWalk = { x: goal.x, y: goal.y, z: goal.z };
      if (this.a.state === 'act') this.a.state = 'chase';
    } else this.a.specialWalk = undefined;
    return false;
  }

  /**
   * InfernaCircleTarget (0x10079e50 -> 0x1007a120): a fresh steering, its direction drawn 50 / 50
   * (0x1007afd0), and the FlamingKill's decision timer p4..p5 drawn again (0x1011f020 on +0x2c).
   */
  private startCircle() {
    const a = this.a;
    this.act = 'circle';
    this.circleDir = Math.random() < 0.5 ? 1 : -1;
    this.steering = true;
    this.stuck.reset(a.position.x, a.position.z);
    this.decide = rand(this.p.decide[0], this.p.decide[1]);
  }

  private startAttack(ball: boolean) {
    const a = this.a;
    this.t = 0;
    this.fired = false;
    if (ball) {
      this.act = 'ball';
      this.stats.fireballs++;
      this.play(this.p.ball.clip);
    } else {
      this.act = 'flame';
      this.stats.flames++;
      this.play(this.p.flame.clip);
    }
    this.rt.log(a, ball ? 'fireball' : 'flame attack');
  }

  /**
   * FlamingKill decision (0x1007aa00) [verified]: on its timer while the circle runs. Within the
   * flame band a flame burst, within the fireball band a fireball (no sight test here); in
   * neither, p10 % picks the fireball band, else the flame band, and a MoveTo to a distance drawn
   * from it follows (repositionDone).
   */
  private chooseAttack(env: ActorEnv) {
    const a = this.a, p = fightTarget(a, env)?.pos ?? noTargetAim(a, env);
    const d = Math.hypot(p.x - a.position.x, p.y - a.position.y, p.z - a.position.z);
    const inFlame = d >= this.p.flameBand[0] && d <= this.p.flameBand[1];
    const inBall = d >= this.p.ballBand[0] && d <= this.p.ballBand[1];
    if (inFlame !== inBall) {
      this.rt.log(a, `${inBall ? 'fireball' : 'flame attack'} at ${d.toFixed(1)} m`);
      return this.startAttack(inBall);
    }
    this.moveBall = Math.random() * 100 < this.p.ballChance;
    if (inFlame && inBall) return this.startAttack(this.moveBall);
    const band = this.moveBall ? this.p.ballBand : this.p.flameBand;
    this.moveWant = rand(band[0], band[1]);
    this.moveAway = this.moveWant > d;
    this.act = 'move';
    this.t = 0;
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
    const a = this.a, p = fightTarget(a, env)?.pos ?? noTargetAim(a, env);
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
