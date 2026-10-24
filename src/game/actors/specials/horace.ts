// Horace: the 1a electric-chair fight (docs §15.7.7). Decoded from Suffering.rfl:
// HoraceKillPlayerBehavior 0x10077e00 / 0x10077ca0 / 0x10077f60 / 0x100780a0, Horace class
// stage table vt[45] 0x10077bc0, stage input 0x10077c00.
//
// HoraceKillPlayerBehavior has no reach or damage of its own: p2 / p3 are MESSAGE ids. Each
// cycle Horace idles looking at the player; after p4..p5 s he sends p2 (6 Triggered) to his
// links unless he is at his last stage (1a: Relay #83ae raises the shields, makes the five
// Breakables invulnerable, arcs...); after p6..p7 s, or at once when he receives p3 (350
// QuestStart, from the Speech Players), he attacks with the ProjectileAttack of his current
// stage (Horace p175[stage]), which sends its p16 (350) to his links (Relay #8591: shields
// down, Breakables vulnerable). Receiving p176 (6 Triggered: each Breakable broken, Relay
// #8593) moves him to the next stage, clamped to the last. The fight ends from the level:
// CountDown #8592 -> ... Switch #8588 -> STOMP #8399 -> Relay #839d BlowUp.
// Port: a stage's volley fires Attack p23 shots (5, 4, 3, 2, 1, 99 over the stages) at the clip's
// Fire marker, p19..p20 s apart, and sends p16 as it starts, so the shields are down while he
// shoots; a Behavior Changer handing the behaviour out again (each break: Relay #8b39) restarts
// the cycle [inferred: p23 as the shot count and the moment p16 is sent]. Shots use his Ranged Weapon (p55 10:1795, 30 damage) like the generic shooter.

import * as THREE from 'three/webgpu';
import type { Actor, ActorEnv } from '../actor';
import { clearLine } from '../nav';
import type { ClipRef } from '../clipmap';
import { clipMarkers } from './clip-events';
import { num, rand, readTemplate, ref, refs, turnToward, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';

const MARK_FIRE = 102;

interface Stage {
  clip?: ClipRef;
  reload?: ClipRef;
  shots: number;
  gap: [number, number];
  done: number;
  fireAt: number;
}

type State = 'idle' | 'volley' | 'gap';

class Horace implements SpecialMove {
  readonly name = 'horace';
  private stages: Stage[] = [];
  private stage = 0;
  private stageMsg: number;
  private st: State = 'idle';
  private d1 = 0;
  private d2 = 0;
  private sent = false;
  private shotsLeft = 0;
  private fired = false;
  private t = 0;
  private running = false;
  /** Behavior Changers handing out his HoraceKillPlayerBehavior (a re-hand restarts the cycle). */
  private changers: { uid: number; msg: number }[] = [];
  private hooked = false;
  private kp = { trigger: 6, attackNow: 350, d1: [0.01, 0.5] as [number, number], d2: [21, 21] as [number, number] };
  private stats = { volleys: 0, shots: 0, hits: 0, triggered: 0, stageUps: 0 };

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    const v = a.entity?.values ?? rt.template(a.kind.template)?.v ?? [];
    this.stageMsg = num(v[176], 0);
    for (const r of refs(v[175])) {
      const pa = readTemplate(rt.pkgs, r);
      if (pa?.cls !== 'ProjectileAttackBehavior') continue;
      const at = readTemplate(rt.pkgs, refs(pa.v[2])[0])?.v ?? [];
      const c = ref(at[0]);
      const fire = clipMarkers(rt.ctx.loaded.packages!, c).find((m) => m.param === MARK_FIRE);
      this.stages.push({ clip: c, reload: ref(pa.v[18]), shots: num(at[23], 1), gap: [num(pa.v[19], 1.5), num(pa.v[20], 1.5)], done: num(pa.v[16], 0), fireAt: fire?.time ?? 0.9 });
    }
  }

  info() {
    return { hz: this.running ? this.st : 'off', stage: this.stage, stages: this.stages.length, ...this.stats };
  }

  /** HoraceKillPlayer parameters: from the Behavior Changer that handed it out (p5 template). */
  private readParams(env: ActorEnv) {
    const uid = this.a.uid;
    for (const e of this.rt.entities) {
      if (e.className !== 'Behavior Changer' || uid === undefined || !e.links.includes(uid)) continue;
      const t = readTemplate(this.rt.pkgs, ref(e.values[5]));
      if (t?.cls !== 'HoraceKillPlayerBehavior') continue;
      this.kp = { trigger: num(t.v[2], 6), attackNow: num(t.v[3], 350), d1: [num(t.v[4], 0.01), num(t.v[5], 0.5)], d2: [num(t.v[6], 21), num(t.v[7], 21)] };
      this.changers.push({ uid: e.uid, msg: num(e.values[11], 1) });
    }
    void env;
  }

  /** A Behavior Changer handing the behaviour out again restarts it: Idle, timers rolled. */
  private hook() {
    if (this.hooked || !this.rt.world?.subscribe || !this.changers.length) return;
    this.hooked = true;
    for (const c of this.changers)
      this.rt.world.subscribe(c.uid, (msg) => {
        if (msg !== c.msg || !this.running) return;
        this.st = 'idle';
        this.rollTimers();
        this.rt.log(this.a, 'HoraceKillPlayer restarted');
      });
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

  private fireLinks(msg: number) {
    const e = this.a.entity;
    if (!e || !msg) return;
    for (const u of e.links) this.rt.send(u, msg, e.uid);
  }

  private rollTimers() {
    this.d1 = rand(this.kp.d1[0], this.kp.d1[1]);
    this.d2 = rand(this.kp.d2[0], this.kp.d2[1]);
    this.sent = false;
  }

  message(msg: number, _from: number, env: ActorEnv): boolean {
    if (this.stageMsg && msg === this.stageMsg) {
      this.stage = Math.min(this.stage + 1, Math.max(0, this.stages.length - 1));
      this.stats.stageUps++;
      this.rt.log(this.a, `stage ${this.stage + 1}`);
      return false;
    }
    if (this.running && msg === this.kp.attackNow && this.st === 'idle') {
      this.startVolley(env);
      return true;
    }
    return false;
  }

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (!a.alive || a.behavior?.kind !== 'horace') {
      this.running = false;
      return false;
    }
    if (!this.running) {
      this.running = true;
      this.readParams(env);
      this.st = 'idle';
      this.rollTimers();
      this.rt.log(a, 'HoraceKillPlayer starts');
    }
    this.hook();
    turnToward(a, yawTo(a.position, env.player.position), 2, dt);
    a.state = 'act';
    switch (this.st) {
      case 'idle':
        a.playClip(a.kind.idle, true);
        this.d1 -= dt;
        this.d2 -= dt;
        if (!this.sent && this.d1 <= 0) {
          this.sent = true;
          if (this.stage < this.stages.length - 1) {
            this.fireLinks(this.kp.trigger);
            this.stats.triggered++;
          }
        }
        // (Port option "Enemies ignore the player": no volley at him.)
        if (this.d2 <= 0 && !env.ignorePlayer) this.startVolley(env);
        break;
      case 'volley':
        this.t += dt;
        if (!this.fired && (a.ch.current?.time ?? this.t) >= this.s.fireAt) {
          this.fired = true;
          this.shoot(env);
        }
        if (a.clipDone || this.t > 6) {
          this.shotsLeft--;
          if (this.shotsLeft <= 0) this.endVolley();
          else {
            this.st = 'gap';
            this.t = rand(this.s.gap[0], this.s.gap[1]);
            this.play(this.s.reload);
          }
        }
        break;
      case 'gap':
        this.t -= dt;
        if (this.t <= 0) this.nextShot();
        break;
    }
    a.sync();
    return true;
  }

  private get s(): Stage {
    return this.stages[Math.min(this.stage, this.stages.length - 1)] ?? { shots: 1, gap: [1.5, 1.5], done: 350, fireAt: 0.9 };
  }

  private startVolley(_env: ActorEnv) {
    this.stats.volleys++;
    this.shotsLeft = Math.max(1, Math.min(99, this.s.shots));
    this.rt.log(this.a, `volley: ${this.shotsLeft} shots (stage ${this.stage + 1}), sends ${this.s.done}`);
    this.fireLinks(this.s.done);
    this.nextShot();
  }

  private nextShot() {
    this.st = 'volley';
    this.t = 0;
    this.fired = false;
    this.play(this.s.clip);
  }

  private endVolley() {
    this.rt.log(this.a, 'volley done');
    this.st = 'idle';
    this.rollTimers();
  }

  private shoot(env: ActorEnv) {
    const a = this.a, p = env.player.position;
    const r = a.profile.ranged;
    const from = new THREE.Vector3(a.position.x - Math.sin(a.yaw) * 0.5, a.bottom + a.height * 0.7, a.position.z - Math.cos(a.yaw) * 0.5);
    const aim = new THREE.Vector3(p.x, p.y + 1.2, p.z);
    const d = from.distanceTo(aim);
    const clear = clearLine(env.world, from.x, from.y, from.z, aim.x, aim.y, aim.z);
    const hit = clear && env.playerAlive && !env.ignorePlayer && Math.random() < Math.max(0.3, 0.9 - d * 0.02);
    const end = hit ? aim : aim.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, (Math.random() - 0.3), (Math.random() - 0.5) * 1.5));
    env.shotFx?.(from, end, hit, r && r.speed < 60 ? r.speed : undefined);
    this.rt.kindEffect('electric', end, 0.6);
    this.stats.shots++;
    if (!hit) return;
    this.stats.hits++;
    this.rt.hurtPlayer(r?.damage ?? 30, a, env);
  }
}

export const createHorace = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new Horace(a, rt);
