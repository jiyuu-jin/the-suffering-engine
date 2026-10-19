// Burrower: travels under the floor and surfaces to strike (docs §15.7.2). Decoded from
// Suffering.rfl: think 0x10070b50 (underground 0x10070950 / surfaced 0x10070aa0), event
// handler 0x10071040 (Emerge / Recede / Collideable), BurrowerKillMeleeBehavior 0x10071ad0,
// BurrowerFlyBy 0x100719e0 / 0x10071530 / 0x10071700.
//
//   * Underground by default: not solid and not targetable (flag 0x10000000); its idle / move
//     clips keep the body below the floor and every heavy footstep raises a dirt mound
//     (Burrower Material Effects p9). It surfaces for the whole of a melee attack, a hit
//     reaction and death; the attack clips rise (Emerge marker: p15 dirt burst) and sink back
//     (Recede: a Hole p187).
//   * Fly-by (BurrowerKillMelee p11..p17): every p11..p12 s, p13 % of the time, it makes p17
//     passes under the target, each to a point p16 m past him on a 45-degree line (side picked
//     at random), then comes back toward him, stopping p14..p15 m away; underground throughout.
//   * Killed underground (only area damage reaches it) it pops out dead (p186, clip 10:1258).
// The fly-by works on the KillMelee's target, the player or a character (no class test in
// 0x10071ad0 / 0x10071530) [verified].
// Port: underground, direct hits (a hit point) do nothing and area damage still counts; the
// dirt trail is the default material entry's mound; the kill-player finisher (p188 / p189) is
// not played.

import * as THREE from 'three/webgpu';
import type { Actor, ActorEnv } from '../actor';
import type { ClipRef } from '../clipmap';
import { clipMarkers, type ClipMarker } from './clip-events';
import { burrowerParams, fightTarget, type BurrowerParams } from './params';
import { drive, flat, rand, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';

const MARK_EMERGE = 455;
const MARK_RECEDE = 458;

class Burrower implements SpecialMove {
  readonly name = 'burrower';
  private p: BurrowerParams;
  private under = true;
  private engaged = false;
  private flyTimer = 0;
  /** Fly-by: remaining passes (-1 = final approach), side, goal. */
  private fly: { passes: number; side: number; goal: THREE.Vector3; t: number; stop: number } | null = null;
  private trailT = 0;
  private known = new Map<THREE.AnimationClip, ClipMarker[]>();
  private curClip: THREE.AnimationClip | null = null;
  private next = 0;
  private deadDone = false;
  private stats = { flyBys: 0, emerges: 0, recedes: 0, mounds: 0, blocked: 0 };

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    this.p = burrowerParams(rt.pkgs, a.entity?.values ?? rt.template(a.kind.template)?.v ?? []);
    a.damageFilter = (amount, hit) => {
      if (this.under && hit?.point) {
        this.stats.blocked++;
        return 0;
      }
      return amount;
    };
  }

  info() {
    return { bw: this.fly ? (this.fly.passes >= 0 ? `flyby ${this.fly.passes}` : 'flyby final') : this.under ? 'underground' : 'surfaced', ...this.stats };
  }

  private markers() {
    const a = this.a;
    const cur = a.ch.current?.getClip() ?? null;
    if (cur !== this.curClip) {
      this.curClip = cur;
      this.next = 0;
      if (cur && !this.known.has(cur)) {
        const env = this.rt.manager.env;
        const ref = this.p.surfacing.find((c) => env && a.ch.clips[env.clip(a, c)] === cur);
        this.known.set(cur, clipMarkers(this.rt.ctx.loaded.packages!, ref));
      }
    }
    const list = cur ? this.known.get(cur) ?? [] : [];
    const time = a.ch.current?.time ?? 0;
    if (this.next > 0 && time < (list[this.next - 1]?.time ?? 0) - 0.05) this.next = 0; // looped / restarted
    while (this.next < list.length && list[this.next].time <= time) {
      const m = list[this.next++];
      const at = { x: a.position.x, y: a.position.y, z: a.position.z };
      if (m.param === MARK_EMERGE) {
        this.stats.emerges++;
        this.rt.effect(this.p.emerge, at);
      } else if (m.param === MARK_RECEDE) {
        this.stats.recedes++;
        for (const g of this.p.hole) this.rt.effect(g, at);
      }
    }
  }

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (!a.alive) {
      if (!this.deadDone) {
        this.deadDone = true;
        // Killed underground: it pops out of the ground dead (p186) [verified vt[64] 0x100708bd].
        if (this.under) {
          const i = env.clip(a, this.p.deathUnder);
          if (i >= 0) a.playClip(i, false);
          this.rt.log(a, 'killed underground: pops out');
        }
        this.under = false;
      }
      return false;
    }
    // Surfaced for attacks, hit reactions (and death); underground otherwise.
    this.under = !(a.state === 'attack' || a.state === 'hurt');
    this.markers();
    // Dirt trail while it moves underground.
    const v = a.motor.velocity;
    this.trailT -= dt;
    if (this.under && Math.hypot(v.x, v.z) > 1 && this.trailT <= 0 && a.drawn) {
      this.trailT = 0.33;
      this.stats.mounds++;
      this.rt.effect(this.p.trail, { x: a.position.x, y: a.position.y, z: a.position.z });
    }
    if (this.fly) return this.flyBy(dt, env);
    if (a.hidden || !fightTarget(a, env)) {
      this.engaged = false;
      return false;
    }
    if (!this.engaged) {
      this.engaged = true;
      this.flyTimer = 0; // the first check fires on the first update [verified 0x10071180]
    }
    this.flyTimer -= dt;
    if (this.flyTimer > 0 || a.state !== 'chase') return false;
    this.flyTimer = rand(this.p.flyByEvery[0], this.p.flyByEvery[1]);
    if (Math.random() * 100 >= this.p.flyByChance) return false;
    this.stats.flyBys++;
    this.fly = { passes: this.p.flyByPasses, side: Math.random() < 0.5 ? 1 : -1, goal: new THREE.Vector3(), t: 0, stop: 0 };
    this.nextPass(env);
    this.rt.log(a, `fly-by: ${this.p.flyByPasses} passes`);
    return true;
  }

  /** Next pass point: p16 m past the target on a 45-degree line (0x10071530). */
  private nextPass(env: ActorEnv) {
    const f = this.fly!, a = this.a, p = fightTarget(a, env)?.pos ?? f.goal;
    f.t = 0;
    if (f.passes <= 0) {
      f.passes = -1;
      f.goal.set(p.x, p.y, p.z);
      f.stop = rand(this.p.flyByFinal[0], this.p.flyByFinal[1]);
      return;
    }
    f.passes--;
    let dx = p.x - a.position.x, dz = p.z - a.position.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // d + s * perp(d), normalised: 45 degrees off the line to the target.
    let ox = dx + f.side * -dz, oz = dz + f.side * dx;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    f.goal.set(p.x + ox * this.p.flyByOffset, p.y, p.z + oz * this.p.flyByOffset);
    f.stop = 0.6;
  }

  private flyBy(dt: number, env: ActorEnv): boolean {
    const a = this.a, f = this.fly!;
    f.t += dt;
    a.state = 'act';
    this.under = true;
    const move = a.kind.run >= 0 ? a.kind.run : a.kind.walk;
    if (move >= 0) a.playClip(move, true);
    const tp = fightTarget(a, env)?.pos;
    if (f.passes < 0 && tp) f.goal.set(tp.x, tp.y, tp.z);
    turnToward(a, yawTo(a.position, f.goal), 6, dt);
    const speed = move >= 0 ? Math.min(8.5, a.kind.speeds[move] || a.kind.runSpeed) : a.kind.runSpeed;
    const moved = drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), speed);
    const d = flat(a.position, f.goal);
    if (d <= f.stop || f.t > 5 || (f.t > 0.5 && moved < 0.2 * speed * dt)) {
      if (f.passes < 0) {
        this.fly = null;
        a.state = 'chase';
        this.rt.log(a, 'fly-by done');
        a.sync();
        return true;
      }
      this.nextPass(env);
    }
    a.sync();
    return true;
  }
}

export const createBurrower = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Burrower(a, rt);
