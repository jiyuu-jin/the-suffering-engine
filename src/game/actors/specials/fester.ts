// Fester: charge attack, rat release and its armour (docs §15.7.3). Decoded from
// Suffering.rfl: FesterKillMeleeBehavior 0x10075b20 / 0x10076030 / 0x10075cd0,
// FesterChargeAttackBehavior 0x100765d0 / 0x10076810 / 0x10075e20, class message handler
// 0x10075900 (StartVulnerable / EndVulnerable / SpawnRat / DropItem), hit test 0x10075a60.
//
//   * Armour: Damage Resistance p7 zeroes damage types 13, 12 and 1 (bullets) except on the
//     bone a clip opened with StartVulnerable (456) until EndVulnerable (457) - the belly that
//     opens while it releases rats [verified 0x10075a60, caller 0x100e77c3].
//   * Rat release (KillMelee p13..p16): first p15 s after engaging, then every p15..p16 s, when
//     the target is farther than p13: plays p14 (10:413) whose SpawnRat (460) markers each create
//     a p177 Rat at the event bone; they drop (DropItem) and run their RatSpawnBehavior. The
//     death clip (10:401) releases six the same way.
//   * Charge (KillMelee p19..p23, ChargeAttack p2..p7): every p22..p23 s, when the target is
//     5..20 m away within +-p19 degrees and the way is clear: wind-up p2, then run p3 at its
//     root-motion speed, steering toward the target position taken at the start until within
//     p6 m; touching the target -> strike (Attack p5: blow x p6); the target more than p7 m to
//     the side, or blocked -> skid p4.
//   * Whose: KillMelee works on its KillEnemies target, the player or a character (no class test in
//     0x10075b20 / 0x10076030), and the charge's contact loop (0x10076880..) strikes on the first
//     mover contact that is the Player or any Character (object type 7) [verified]. So Clem on
//     6b's beach is charged and released on like the player.

import * as THREE from 'three/webgpu';
import type { Actor, ActorEnv } from '../actor';
import { clearWide } from '../nav';
import type { ClipRef } from '../clipmap';
import { clipMarkers, MARK_ARM, type ClipMarker } from './clip-events';
import { fightTarget, festerParams, type FesterParams } from './params';
import { drive, flat, rand, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';

const MARK_SPAWN_RAT = 460;
const MARK_START_VULNERABLE = 456;
const MARK_END_VULNERABLE = 457;
const BULLET_PROOF = new Set([1, 12, 13]);

type State = 'none' | 'release' | 'windup' | 'charge' | 'strike' | 'skid';

class Fester implements SpecialMove {
  readonly name = 'fester';
  st: State = 'none';
  private p: FesterParams;
  private engaged = false;
  private releaseTimer = 0;
  private chargeCooldown = 0;
  private t = 0;
  private goal = new THREE.Vector3();
  private markers: ClipMarker[] = [];
  private next = 0;
  private clipIdx = -1;
  private vulnerable: number | null = null;
  private rats = 0;
  private charges = 0;
  private strikes = 0;
  private dealt = 0;
  private deathDone = false;
  private blocked = 0;
  /** Whom the charge struck: the player or a character. */
  private struck: Actor | 'player' | null = null;

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    this.p = festerParams(rt.pkgs, a.entity?.values ?? rt.template(a.kind.template)?.v ?? []);
    a.damageFilter = (amount, hit) => this.filter(amount, hit);
  }

  info() {
    return { fs: this.st, rats: this.rats, charges: this.charges, strikes: this.strikes, dealt: this.dealt, vulnerable: this.vulnerable !== null, release: +this.releaseTimer.toFixed(1), cooldown: +this.chargeCooldown.toFixed(1) };
  }

  /** Armour: bullets (and types 12 / 13) only hurt on the open weak spot. */
  private filter(amount: number, hit: { point?: THREE.Vector3Like; type?: number } | undefined) {
    if (hit?.type === undefined || !BULLET_PROOF.has(hit.type)) return amount;
    if (this.vulnerable === null || !hit.point) return 0;
    const b = this.bonePos(this.vulnerable);
    const d = Math.hypot(hit.point.x - b.x, hit.point.y - b.y, hit.point.z - b.z);
    return d < 0.6 * this.a.scale ? amount : 0;
  }

  private bonePos(i: number) {
    const b = this.a.ch.skeleton.bones[i] ?? this.a.ch.root;
    b.updateWorldMatrix(true, false);
    return b.getWorldPosition(new THREE.Vector3());
  }

  private play(c: ClipRef | undefined, loop = false) {
    const env = this.rt.manager.env;
    this.clipIdx = env ? env.clip(this.a, c) : -1;
    this.markers = clipMarkers(this.rt.ctx.loaded.packages!, c);
    this.next = 0;
    if (this.clipIdx >= 0) {
      const act = this.a.playClip(this.clipIdx, loop);
      if (act) act.time = 0;
    }
    return this.clipIdx >= 0;
  }

  /** Clip markers up to the current clip time: SpawnRat, the weak-spot window, Arm. */
  private markersDue(onArm?: () => void) {
    const time = this.a.ch.current?.time ?? 0;
    while (this.next < this.markers.length && this.markers[this.next].time <= time) {
      const m = this.markers[this.next++];
      if (m.param === MARK_SPAWN_RAT) this.spawnRat(m);
      else if (m.param === MARK_START_VULNERABLE) this.vulnerable = this.boneOf(m.bone);
      else if (m.param === MARK_END_VULNERABLE) this.vulnerable = null;
      else if (m.param === MARK_ARM) onArm?.();
    }
  }

  /** Marker bone word: a bone index when small, else a bone name hash. */
  private boneOf(w: number): number {
    const skel = this.a.kind.skinned.skeleton;
    if (w < skel.bones.length) return w;
    return skel.byHash.get(w >>> 0) ?? 0;
  }

  private spawnRat(m: ClipMarker) {
    if (!this.p.rat) return;
    const at = this.bonePos(this.boneOf(m.bone));
    const r = this.rt.manager.spawn(this.p.rat, { x: at.x, y: at.y, z: at.z }, this.a.yaw + (Math.random() - 0.5) * 2);
    if (r) {
      this.rats++;
      this.rt.log(this.a, `releases a rat (${this.rats})`);
    }
  }

  private finish() {
    this.st = 'none';
    this.vulnerable = null;
    this.a.state = 'chase';
  }

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (!a.alive) {
      // The death clip releases its rats too (10:401).
      if (!this.deathDone) {
        this.deathDone = true;
        this.vulnerable = null;
        const cur = a.ch.current?.getClip();
        const ref = this.p.deathClips.find((c) => {
          const i = env.clip(a, c);
          return i >= 0 && a.ch.clips[i] === cur;
        });
        this.markers = clipMarkers(this.rt.ctx.loaded.packages!, ref);
        this.next = 0;
      }
      this.markersDue();
      return false;
    }
    if (this.st === 'none') return this.decide(dt, env);
    this.t += dt;
    a.state = 'act';
    const tgt = fightTarget(a, env);
    const p = tgt?.pos ?? this.goal;
    switch (this.st) {
      case 'release':
        this.markersDue();
        if (a.clipDone || this.t > 6) {
          this.releaseTimer = rand(this.p.releaseEvery[0], this.p.releaseEvery[1]);
          this.finish();
        }
        break;
      case 'windup':
        turnToward(a, yawTo(a.position, this.goal), 4, dt);
        if (a.clipDone || this.t > 3) {
          this.st = 'charge';
          this.t = 0;
          this.blocked = 0;
          this.play(this.p.run, true);
        }
        break;
      case 'charge': {
        if (flat(a.position, this.goal) > this.p.steerStop) turnToward(a, yawTo(a.position, this.goal), 3, dt);
        const speed = this.clipIdx >= 0 ? Math.max(4, a.kind.speeds[this.clipIdx] || 8) : 8;
        const moved = drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), speed);
        // Contact with the player or a character, the target off to the side, or blocked.
        const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
        const dx = p.x - a.position.x, dz = p.z - a.position.z;
        const side = Math.abs(dx * fz - dz * fx);
        const hit = this.contact(env, fx, fz);
        if (hit) {
          this.st = 'strike';
          this.t = 0;
          this.strikes++;
          this.struck = hit;
          this.play(this.p.strike?.clip);
          this.rt.log(a, `charge connects (${hit === 'player' ? 'the player' : hit.ch.root.name})`);
        } else if (side > this.p.sideLimit || this.t > 4 || (moved < 0.5 * speed * dt ? ++this.blocked > 3 : (this.blocked = 0) > 0)) {
          this.st = 'skid';
          this.t = 0;
          this.play(this.p.skid);
          this.rt.log(a, `charge ends in a skid (${side > this.p.sideLimit ? 'missed' : 'blocked'})`);
        }
        break;
      }
      case 'strike': {
        const who = this.struck;
        const at = who === 'player' ? (env.playerAlive ? env.player.position : undefined) : who?.alive ? who.position : undefined;
        if (at) turnToward(a, yawTo(a.position, at), 4, dt);
        this.markersDue(() => {
          if (at && flat(a.position, at) - a.radius <= (this.p.strike?.reach ?? 2) + 0.5) {
            if (who === 'player') this.rt.hurtPlayer(this.p.strikeDamage, a, env, this.p.strike?.force);
            else if (who) this.rt.hurtActor(who, this.p.strikeDamage, a);
            this.dealt += this.p.strikeDamage;
            this.rt.log(a, `charge strike ${this.p.strikeDamage}`);
          }
        });
        if (a.clipDone || this.t > 3) this.finish();
        break;
      }
      case 'skid':
        if (this.clipIdx >= 0 && !a.clipDone) drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), Math.max(0, 3 * (1 - this.t / 1.9)));
        if (a.clipDone || this.t > 3) this.finish();
        break;
    }
    a.sync();
    return true;
  }

  /**
   * The charge's mover contact (0x10076880..): the player or any live character close in front
   * [verified: Player or object type 7]; the body test is the port's (within the radii + 0.9 m,
   * not behind).
   */
  private contact(env: ActorEnv, fx: number, fz: number): Actor | 'player' | null {
    const a = this.a;
    const near = (q: THREE.Vector3Like, r: number) => {
      const dx = q.x - a.position.x, dz = q.z - a.position.z;
      return Math.hypot(dx, dz) < a.radius + r + 0.55 && dx * fx + dz * fz > -0.2 && Math.abs(q.y - a.position.y) < 1.8;
    };
    if (env.playerAlive && near(env.player.position, 0.35)) return 'player';
    for (const o of env.actors) if (o !== a && o.alive && !o.hidden && !o.kind.decor && !o.template && near(o.position, o.radius)) return o;
    return null;
  }

  /** KillMelee update: rat release first, then the charge. */
  private decide(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    const tgt = a.hidden ? undefined : fightTarget(a, env);
    if (!tgt) {
      this.engaged = false;
      return false;
    }
    if (!this.engaged) {
      this.engaged = true;
      this.releaseTimer = this.p.releaseEvery[0];
      this.chargeCooldown = rand(this.p.chargeEvery[0], this.p.chargeEvery[1]);
    }
    this.releaseTimer -= dt;
    this.chargeCooldown -= dt;
    if (a.state !== 'chase' && a.state !== 'idle') return false;
    const p = tgt.pos;
    const d = flat(a.position, p);
    if (this.releaseTimer <= 0 && d > this.p.releaseMinDist && this.p.releaseClip) {
      this.st = 'release';
      this.t = 0;
      this.play(this.p.releaseClip);
      this.rt.log(a, 'starts a rat release');
      return true;
    }
    if (this.chargeCooldown > 0) return false;
    this.chargeCooldown = rand(this.p.chargeEvery[0], this.p.chargeEvery[1]);
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const facing = ((p.x - a.position.x) * fx + (p.z - a.position.z) * fz) / Math.max(1e-3, d);
    if (d <= this.p.chargeRange[0] || d >= this.p.chargeRange[1] || facing < Math.cos((this.p.chargeCone * Math.PI) / 180)) return false;
    if (!clearWide(env.world, a.position.x, a.position.y + 0.9, a.position.z, p.x, p.y + 0.9, p.z, a.radius)) return false;
    if (Math.abs(p.y - a.position.y) > 1.5) return false;
    this.goal.set(p.x, p.y, p.z);
    this.st = 'windup';
    this.t = 0;
    this.charges++;
    this.play(this.p.windup);
    this.rt.log(a, `charges from ${d.toFixed(1)} m`);
    return true;
  }
}

export const createFester = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Fester(a, rt);
