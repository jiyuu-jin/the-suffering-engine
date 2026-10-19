// The Black One, final boss of 10 Docks (class 0xffaeb496, a skinned Ground Object; docs
// §15.7.8). Decoded from Suffering.rfl: ctor 0x1006f6e0, init 0x1006f100, update 0x10070310,
// heart events 0x1006f260, teleport 0x1006fa80, attack choice 0x1006fcf0; Teleport Effect
// 0x1008cf70.
//
// The four placed Black Ones are one boss [verified]:
//   * Their bodies cannot be hurt (PhysicalObject +0x1e set by the ctor). The only hit points
//     are one shared "heart" (p62 Breakable 10:1563: 60 x Difficulty Modifier) that rides
//     bone p63 of whichever Black One is up.
//   * Only one is up at a time. It fights from its spot (the bodies never move), retreats
//     after a timer (p39..p42, by the player's distance p43), sinks (p51), waits p44..p45 s and
//     hands over to a random other one - never the one nearest the player (0x1006fb20).
//   * Breaking the heart moves to the next stage template (p46: 10:1024 -> 10:1699 -> 10:1700:
//     faster attacks, shorter timers, heart back at p68 % of its max); on the last stage the
//     holder plays its death clip and fires p76 Died -> Relay b25 -> the ending chain.
//   * Attacks (Black One Attack: clip, speed range, distance range, bearing arc): slot 0
//     melee, 2 three-limb strike, 3 three fireballs (p60), 4 a teleport missile (p61) whose
//     Teleport Effect puts the player on the shooter's Teleport Pad and sends it Enable, which
//     starts a slot-5 close attack and fires p74 (the level blurs / slows time).
// Port: blows land at the clip's Arm markers when the player is in the attack's distance
// range (+1 m) and arc; the heart takes every hit on the Black One that holds it [inferred:
// the original only counts hits on the heart mesh].
//
// Saved state [verified: the class's save / load pair, vtable 0x10152d90 +0x34 = 0x1006e3e0 writes,
// +0x30 = 0x1006e340 reads]: after the PhysicalObject base (0x1009b480) and three components
// (+0x72, +0xb6, +0x1ac), u32 +0x4a the chosen attack (-1 none) and its template +0x4e, f32 +0x5a
// the hand-over wait, +0x5e / +0x62 the near / far retreat timers, +0x66 the hurt flash, u32 +0x6a
// the state (0..7) and u32 +0x6e the flags (1 active, 2 pull-in, 4 ...). The heart is its own
// Breakable (its health saved with it) and the stage is the object's current template. Port
// (`BlackOne.save / load`, the 'actors.specials' provider): each one's state, timers and pull /
// exclude flags, and the shared fight (stage, heart, holder, done). A state in the middle of a
// clip resumes at its stable point: appear / attack / taunt -> the fight (a new attack), retreat
// -> the hand-over wait, a broken heart -> the stage change. Before, a capture taken after
// "Camera" 1082 restored the four asleep and the boss never woke.

import * as THREE from 'three/webgpu';
import { instanceRotation, toOutputSpace } from '../../../formats/level';
import type { Entity } from '../../../formats/entities';
import type { ResRef } from '../../../formats/model';
import { buildStaticModel } from '../../weapons/models';
import { Actor, type ActorEnv } from '../actor';
import { clearLine } from '../nav';
import type { ClipRef } from '../clipmap';
import { clipMarkers, markerTimes, MARK_ARM, MARK_ATTACK_EFFECT, type ClipMarker } from './clip-events';
import { blackOneStages, generatorMissile, type BlackOneAttack, type BlackOneStage, type MissileInfo } from './params';
import { flat, num, rand, readTemplate, type SpecialMove, type SpecialRuntime } from './runtime';

type BOState = 'hidden' | 'retreat' | 'wait' | 'appear' | 'fight' | 'attack' | 'taunt' | 'stage' | 'death' | 'dead';

interface Shot {
  kind: 'fireball' | 'teleport';
  owner: BlackOne;
  from: THREE.Vector3;
  to: THREE.Vector3;
  at: number;
  info: MissileInfo;
}

/** State shared by the four Black Ones (the boss). */
export class Fight {
  stage = 0;
  hp = 0;
  max = 0;
  vulnerable = false;
  holder: BlackOne | null = null;
  /** Taunt pair index shared by all Black Ones (0x1017a81c). */
  taunt = 0;
  shots: Shot[] = [];
  done = false;
  members: BlackOne[] = [];
  heartMesh: THREE.Object3D | null = null;
  heartMats: THREE.Material[] = [];

  constructor(
    readonly rt: SpecialRuntime,
    readonly stages: BlackOneStage[],
  ) {
    const s0 = stages[0];
    const h = rt.template(s0?.heart);
    this.max = num(h?.v[1], 60) * rt.modifier(h ? (h.v[2] as ResRef | null) : null);
    this.hp = this.max;
    if (s0?.heart) {
      const model = rt.templateModel(s0.heart);
      const mesh = model ? buildStaticModel(rt.ctx.loaded.packages!, model) : undefined;
      if (mesh) {
        this.heartMesh = mesh;
        mesh.traverse((o) => {
          const m = (o as THREE.Mesh).material;
          if (m) this.heartMats.push(...(Array.isArray(m) ? m : [m]));
        });
      }
    }
    this.newTaunt();
  }

  get s() {
    return this.stages[Math.min(this.stage, this.stages.length - 1)];
  }

  newTaunt() {
    this.taunt = Math.floor(Math.random() * Math.max(1, this.s?.taunts.length ?? 1));
  }

  /** Heart tint: p65 + (p64 - p65) x health / max per channel, halved (0x1006eb40). */
  tint(flash: boolean) {
    const s = this.s;
    if (!s) return;
    const k = this.max > 0 ? Math.max(0, this.hp / this.max) : 0;
    const ch = (sh: number) => {
      const a = (s.tintEmpty >> sh) & 0xff, b = (s.tintFull >> sh) & 0xff;
      return ((a + (b - a) * k) >> 1) / 255;
    };
    const c = new THREE.Color(ch(16), ch(8), ch(0));
    if (flash) c.setRGB(1, 1, 1);
    for (const m of this.heartMats) {
      const e = (m as THREE.MeshStandardMaterial).emissive;
      if (e) e.copy(c).multiplyScalar(2);
    }
  }
}

export class BlackOne implements SpecialMove {
  readonly name = 'black-one';
  st: BOState = 'hidden';
  private timerA = 0;
  private timerB = 0;
  private countdown = 0;
  private attack?: BlackOneAttack;
  private attackTarget = new THREE.Vector3();
  private markers: ClipMarker[] = [];
  private nextMarker = 0;
  private blowsDone = new Set<number>();
  private clipIdx = -1;
  private secondTaunt = false;
  private flash = 0;
  pull = false;
  exclude = false;
  private hits = 0;
  /** A loaded state, applied on the first update (clips need the frame environment). */
  private restored?: BlackOneSave;

  constructor(
    readonly a: Actor,
    readonly e: Entity,
    readonly fight: Fight,
    readonly pads: { x: number; y: number; z: number; yaw: number }[],
  ) {}

  private get rt() {
    return this.fight.rt;
  }
  private get s() {
    return this.fight.s;
  }

  info() {
    const f = this.fight;
    return {
      bo: this.st,
      stage: f.stage,
      heart: Math.round(f.hp * 10) / 10,
      heartMax: Math.round(f.max * 10) / 10,
      vulnerable: f.vulnerable,
      holder: f.holder === this,
      attack: this.attack ? `${this.attack.slot}:${this.attack.ref.id}` : '',
      hits: this.hits,
      done: f.done,
    };
  }

  // --- presentation ------------------------------------------------------------------

  private play(c: ClipRef | undefined, speed = 1, loop = false): boolean {
    const env = this.rt.manager.env;
    const i = env ? env.clip(this.a, c) : -1;
    this.clipIdx = i;
    this.markers = clipMarkers(this.rt.ctx.loaded.packages!, c);
    this.nextMarker = 0;
    this.blowsDone.clear();
    if (i < 0) return false;
    const act = this.a.playClip(i, loop, speed);
    if (act) act.time = 0;
    return true;
  }

  private get clipTime() {
    return this.a.ch.current?.time ?? 0;
  }

  private show() {
    const a = this.a;
    a.dormantHidden = false;
    a.ch.root.visible = true;
    a.state = 'act';
  }

  private fire(msg: number) {
    if (!msg) return;
    for (const u of this.e.links) this.rt.send(u, msg, this.e.uid);
  }

  // --- the boss logic ------------------------------------------------------------------

  /** Activate (input On, p69): show, fire p77, straight into the fight (0x100702d0). */
  activate() {
    if (this.fight.done || this.st === 'dead') return;
    this.show();
    this.fire(this.s.msg.appear);
    this.takeHeart();
    this.enterFight();
    this.rt.log(this.a, 'activated (On)');
  }

  /** Appear (0x1006e880): emerge clip, fire p77, heart vulnerable, hurt sound. */
  appear() {
    this.show();
    this.st = 'appear';
    this.play(this.s.appear);
    this.fire(this.s.msg.appear);
    this.takeHeart();
    this.fight.vulnerable = true;
    this.rt.sound(this.s.hurtSounds, this.a.position);
    this.rt.log(this.a, 'appears');
  }

  /** Vanish (0x1006dff0): hide, drop the heart, fire p78. */
  private vanish() {
    this.st = 'hidden';
    this.a.dormantHidden = true;
    this.a.state = 'idle';
    if (this.fight.holder === this) this.fight.holder = null;
    this.fire(this.s.msg.vanish);
  }

  private takeHeart() {
    const f = this.fight;
    f.holder = this;
    const h = f.heartMesh;
    if (!h) return;
    const bone = this.a.ch.skeleton.bones[this.s.heartBone] ?? this.a.ch.root;
    if (h.parent !== bone) bone.add(h);
  }

  private enterFight() {
    const s = this.s;
    this.st = 'fight';
    this.timerA = rand(s.nearTimer[0], s.nearTimer[1]);
    this.timerB = rand(s.farTimer[0], s.farTimer[1]);
    this.fight.vulnerable = true;
    this.chooseAttack(0, 5);
  }

  private retreatDue(env: ActorEnv) {
    const d = flat(env.player.position, this.a.position);
    return (d <= this.s.nearRadius && this.timerA < 0) || (d > this.s.nearRadius && this.timerB < 0);
  }

  private retreat() {
    this.st = 'retreat';
    this.attack = undefined;
    const r = this.s.retreat;
    this.play(r[Math.floor(Math.random() * r.length)]);
    this.fight.vulnerable = false;
    this.rt.log(this.a, 'retreats');
  }

  /** Hand over to another Black One (0x1006fa80). */
  private teleport() {
    const f = this.fight;
    const p = this.rt.player.position;
    let c = f.members.filter((m) => m !== this && !m.exclude && m.st !== 'dead');
    if (c.length > 1) {
      let near = c[0], nd = Infinity;
      for (const m of c) {
        const d = flat(m.a.position, p);
        if (d < nd) (nd = d), (near = m);
      }
      c = c.filter((m) => m !== near);
    }
    if (!c.length) return this.appear();
    const next = c[Math.floor(Math.random() * c.length)];
    this.rt.log(this.a, `teleports to #${next.e.uid.toString(16)}`);
    next.appear();
    this.vanish();
  }

  /** Random valid attack of slots [lo, hi) for the player's distance / bearing (0x1006fcf0). */
  private chooseAttack(lo: number, hi: number): boolean {
    const p = this.rt.player.position;
    const d = flat(p, this.a.position);
    const dx = p.x - this.a.position.x, dz = p.z - this.a.position.z;
    // Bearing of the player relative to the facing (degrees, sign irrelevant for the
    // symmetric retail arcs).
    const bearing = (Math.atan2(-(dx * Math.cos(this.a.yaw) - dz * Math.sin(this.a.yaw)), -(dx * Math.sin(this.a.yaw) + dz * Math.cos(this.a.yaw))) * 180) / Math.PI;
    const ok = this.s.attacks.filter((t) => t.slot >= lo && t.slot < hi && d >= t.range[0] && d <= t.range[1] && bearing >= t.arc[0] && bearing <= t.arc[1] && !!t.clip);
    if (!ok.length) return false;
    const t = ok[Math.floor(Math.random() * ok.length)];
    this.attack = t;
    this.st = 'attack';
    this.attackTarget.set(p.x, p.y + 1, p.z);
    this.play(t.clip, rand(t.speed[0], t.speed[1]));
    this.rt.log(this.a, `attack slot ${t.slot} (${t.ref.pkg}:${t.ref.id}) at ${d.toFixed(1)} m`);
    return true;
  }

  private taunt(): boolean {
    const s = this.s, k = this.fight.taunt;
    const c = this.secondTaunt ? s.tauntsAfter[k] : s.taunts[k];
    if (!c) return false;
    this.st = 'taunt';
    this.play(c);
    return true;
  }

  /** Heart damage (the heart's p15 / p21 outputs, 0x1006f40c / 0x1006f2ca). */
  hurt(amount: number, env: ActorEnv) {
    const f = this.fight;
    if (!f.vulnerable || f.holder !== this || f.done || amount <= 0) return;
    f.hp -= amount;
    this.hits++;
    this.flash = this.s.hurtFlash;
    this.rt.sound(this.s.hurtSounds, this.a.position);
    this.rt.log(this.a, `heart hit ${amount.toFixed(1)} -> ${Math.max(0, f.hp).toFixed(1)} / ${f.max.toFixed(1)}`);
    if (f.hp > 0) return;
    f.hp = 0;
    f.vulnerable = false;
    this.attack = undefined;
    if (f.stage < f.stages.length - 1) {
      this.st = 'stage';
      this.play(this.s.stageChange);
      this.rt.log(this.a, `heart broken: stage ${f.stage + 1} -> ${f.stage + 2}`);
    } else {
      this.st = 'death';
      f.done = true;
      this.rt.log(this.a, 'heart broken on the last stage: dies');
      const d = this.s.death;
      this.a.die(env, { cls: 'DeathBehavior', kind: 'death', next: [], clips: d ? [d] : [] });
      this.markers = clipMarkers(this.rt.ctx.loaded.packages!, d);
    }
  }

  /** Stage change done (0x10070090): next templates for all, teleport, heart at p68 %. */
  private nextStage() {
    const f = this.fight;
    f.stage++;
    this.fire(this.s.msg.stage);
    this.teleport();
    f.vulnerable = true;
    f.hp = (this.s.stageHealth / 100) * f.max;
    f.newTaunt();
    this.rt.log(this.a, `stage ${f.stage + 1}: heart ${f.hp.toFixed(1)}`);
  }

  died(_env: ActorEnv) {
    this.fire(this.s.msg.died);
    this.rt.log(this.a, 'Died (p76) fired');
    return true;
  }

  message(msg: number, _from: number, _env: ActorEnv): boolean {
    const m = this.s.msg;
    if (msg === m.on) this.activate();
    else if (m.include && msg === m.include) this.exclude = false;
    else if (m.exclude && msg === m.exclude) this.exclude = true;
    else if (msg === m.pull) {
      // Pull-in (0x10070060): only slot 5, fire p74, flag 1.
      if (this.st === 'hidden' || this.st === 'dead' || this.fight.done) return true;
      this.chooseAttack(5, 6);
      this.fire(m.triggered);
      this.pull = true;
      this.rt.log(this.a, 'pull-in (Enable)');
    } else if (msg === m.release) this.pull = false;
    else return false;
    return true;
  }

  // --- save ------------------------------------------------------------------------

  save(): BlackOneSave {
    const f = this.fight;
    return {
      st: this.st,
      timers: [this.timerA, this.timerB, this.countdown],
      pull: this.pull,
      exclude: this.exclude,
      fight: { stage: f.stage, hp: f.hp, vulnerable: f.vulnerable, done: f.done, holder: f.holder === this },
    };
  }

  load(state: unknown) {
    const s = state as BlackOneSave | null;
    if (!s || typeof s.st !== 'string') return;
    const f = this.fight;
    f.stage = Math.max(0, Math.min(f.stages.length - 1, s.fight.stage | 0));
    f.hp = s.fight.hp;
    f.vulnerable = s.fight.vulnerable;
    f.done = s.fight.done;
    if (s.fight.holder) f.holder = this;
    else if (f.holder === this) f.holder = null;
    this.pull = !!s.pull;
    this.exclude = !!s.exclude;
    [this.timerA, this.timerB, this.countdown] = s.timers;
    this.attack = undefined;
    this.restored = s;
  }

  /** Apply a loaded state (first update after the load). */
  private resume(s: BlackOneSave) {
    const a = this.a;
    const st = s.st as BOState;
    if (st === 'hidden') {
      this.st = 'hidden';
      a.dormantHidden = true;
      return;
    }
    if (st === 'dead' || st === 'death') {
      this.st = 'dead';
      a.ch.root.visible = false;
      a.dormantHidden = true;
      if (this.fight.holder === this) this.fight.heartMesh?.removeFromParent();
      return;
    }
    this.show();
    if (this.fight.holder === this) this.takeHeart();
    if (st === 'retreat' || st === 'wait') {
      this.st = 'wait';
      if (!(this.countdown > 0)) this.countdown = rand(this.s.teleportWait[0], this.s.teleportWait[1]);
    } else if (st === 'stage') {
      this.st = 'stage';
      this.play(this.s.stageChange);
    } else {
      // appear / fight / attack / taunt: back in the fight with the saved retreat timers.
      this.st = 'fight';
      this.fight.vulnerable = true;
      this.chooseAttack(0, 5);
    }
    this.rt.log(a, `restored (${st} -> ${this.st}), stage ${this.fight.stage + 1}, heart ${this.fight.hp.toFixed(1)}`);
  }

  // --- per frame ----------------------------------------------------------------------

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    a.invulnerable = true; // the body never takes damage; hits go to the heart (see hurt()).
    if (this.restored) {
      const s = this.restored;
      this.restored = undefined;
      this.resume(s);
    }
    if (this.st === 'hidden') {
      a.dormantHidden = true;
      return true;
    }
    if (this.st === 'dead') return true;
    a.ch.root.visible = true;
    if (this.flash > 0) this.flash -= dt;
    if (this.fight.holder === this) this.fight.tint(this.flash > 0);
    if (this.st !== 'death' && a.state !== 'act') a.state = 'act';
    this.timerA -= dt;
    this.timerB -= dt;
    a.sync();

    if (this.st === 'attack') this.attackEvents(env);
    if (this.st === 'fight' && this.retreatDue(env)) this.retreat();
    if (this.st === 'wait') {
      this.countdown -= dt;
      if (this.countdown < 0) this.teleport();
      return true;
    }
    if (this.st === 'fight') return true;
    if (!a.clipDone && this.clipIdx >= 0) return true;
    switch (this.st) {
      case 'retreat':
        this.st = 'wait';
        this.countdown = rand(this.s.teleportWait[0], this.s.teleportWait[1]);
        break;
      case 'appear':
        this.enterFight();
        break;
      case 'attack':
        if (this.retreatDue(env)) this.retreat();
        else if (this.clipIdx >= 0 && this.attack) {
          this.attack = undefined;
          this.secondTaunt = false;
          if (!this.taunt()) this.chooseAttack(0, 5);
        } else this.chooseAttack(0, 5); // nothing valid: retry every frame
        break;
      case 'taunt':
        if (!this.secondTaunt && this.taunt2()) break;
        this.secondTaunt = false;
        this.fight.newTaunt();
        if (this.retreatDue(env)) this.retreat();
        else if (!this.chooseAttack(0, 5)) {
          this.st = 'attack';
          this.clipIdx = -1;
        }
        break;
      case 'stage':
        this.nextStage();
        break;
      case 'death':
        // PhysicalObject Break: the body goes away after the clip [inferred].
        this.st = 'dead';
        a.ch.root.visible = false;
        a.dormantHidden = true;
        this.fight.heartMesh?.removeFromParent();
        break;
    }
    return true;
  }

  private taunt2(): boolean {
    this.secondTaunt = true;
    return this.taunt();
  }

  /** Melee windows and projectile events of the running attack clip. */
  private attackEvents(env: ActorEnv) {
    const t = this.attack;
    if (!t) return;
    const time = this.clipTime;
    while (this.nextMarker < this.markers.length && this.markers[this.nextMarker].time <= time) {
      const m = this.markers[this.nextMarker++];
      if (m.param === MARK_ARM) this.blow(t, m, env);
      else if (m.param === MARK_ATTACK_EFFECT) this.launch(t, env);
    }
  }

  private blow(t: BlackOneAttack, m: ClipMarker, env: ActorEnv) {
    // One blow per window start (several bones arm together: merged within 0.1 s).
    const key = Math.round(m.time * 10);
    if (this.blowsDone.has(key)) return;
    this.blowsDone.add(key);
    const p = env.player.position;
    const d = flat(p, this.a.position);
    if (d > t.range[1] + 1 || !env.playerAlive) return;
    this.rt.hurtPlayer(this.s.blowDamage, this.a, env);
    this.rt.shake(p, 0.15, 0.4);
    this.rt.log(this.a, `blow ${this.s.blowDamage} at ${d.toFixed(1)} m`);
  }

  private launch(t: BlackOneAttack, env: ActorEnv) {
    const slot = t.slot;
    if (slot !== 3 && slot !== 4) return;
    const gen = slot === 3 ? this.s.fireball : this.s.teleport;
    const info = generatorMissile(this.rt.pkgs, gen);
    if (!info || info.speed <= 0) return;
    const a = this.a;
    const from = new THREE.Vector3(a.position.x, a.position.y + a.height * 0.75, a.position.z);
    const p = env.player.position;
    // Slot 3 aims at the player now, slot 4 where he stood when the attack started [verified 0x1006ea2f].
    const to = slot === 3 ? new THREE.Vector3(p.x, p.y + 1, p.z) : this.attackTarget.clone();
    const hit = env.world.raycast(from.x, from.y, from.z, to.x - from.x, to.y - from.y, to.z - from.z, 1);
    if (hit && hit.distance < 1) to.lerpVectors(from, to, Math.max(0, hit.distance - 0.05));
    const dist = from.distanceTo(to);
    env.shotFx?.(from, to, true, info.speed);
    this.rt.sound(info.sounds, from);
    this.fight.shots.push({ kind: slot === 3 ? 'fireball' : 'teleport', owner: this, from, to, at: env.time + dist / info.speed, info });
    this.rt.log(a, `${slot === 3 ? 'fireball' : 'teleport missile'} -> ${dist.toFixed(1)} m`);
  }

  /** Projectiles arriving (SpecialRuntime tick, once per frame). */
  static shots(f: Fight, env: ActorEnv) {
    for (let i = f.shots.length - 1; i >= 0; i--) {
      const s = f.shots[i];
      if (env.time < s.at) continue;
      f.shots.splice(i, 1);
      s.owner.arrive(s, env);
    }
  }

  private arrive(s: Shot, env: ActorEnv) {
    const rt = this.rt;
    const p = env.player.position;
    const chest = { x: p.x, y: p.y + 1, z: p.z };
    if (s.kind === 'fireball') {
      // Impact: the generator's effects (all but the Radius Damage) and the radius damage:
      // props / actors through services.damage, the player here (full to the inner radius,
      // down to the minimum at the outer one; blocked by walls).
      for (const g of s.info.impact) {
        for (const c of (readTemplate(rt.pkgs, g)?.v[0] as (ResRef | null)[] | undefined) ?? []) if (c && readTemplate(rt.pkgs, c)?.cls !== 'Radius Damage') rt.effect(c, s.to);
      }
      const r = s.info.radius;
      if (!r) return;
      rt.splash(s.to, r.max, r.outer, 'fire', this.e.uid);
      const d = Math.hypot(chest.x - s.to.x, chest.y - s.to.y, chest.z - s.to.z);
      if (d >= r.outer || !env.playerAlive) return;
      if (!clearLine(env.world, s.to.x, s.to.y + 0.3, s.to.z, chest.x, chest.y, chest.z)) return;
      const amount = d <= r.inner ? r.max : r.max - ((d - r.inner) / Math.max(1e-3, r.outer - r.inner)) * (r.max - r.min);
      rt.hurtPlayer(amount, this.a, env);
      rt.log(this.a, `fireball ${amount.toFixed(1)} at ${d.toFixed(1)} m`);
      return;
    }
    // Teleport missile: hits a player still near the aim point; puts him on the shooter's
    // Teleport Pad and sends the shooter the Teleport Effect's p0 (Enable) [verified 0x1008cf70].
    if (Math.hypot(chest.x - s.to.x, chest.z - s.to.z) > 1.5 || !env.playerAlive || !this.pads.length) return;
    const pad = this.pads[Math.floor(Math.random() * this.pads.length)];
    rt.player.teleport(pad, pad.yaw);
    rt.kindEffect('flash', { x: pad.x, y: pad.y + 1, z: pad.z }, 1.5);
    rt.log(this.a, `teleport missile hit: player on pad ${pad.x.toFixed(1)},${pad.z.toFixed(1)}`);
    rt.send(this.e.uid, s.info.teleportMessage ?? this.s.msg.pull, 0);
  }
}

/** A Black One's saved state ('actors.specials'), see the header. */
export interface BlackOneSave {
  st: string;
  /** Near / far retreat timers and the hand-over wait (s). */
  timers: [number, number, number];
  pull: boolean;
  exclude: boolean;
  fight: { stage: number; hp: number; vulnerable: boolean; done: boolean; holder: boolean };
}

/** Create the placed Black Ones (actors handed to the manager) and their shared fight. */
export function placeBlackOnes(rt: SpecialRuntime): { actor: Actor; move: SpecialMove }[] {
  const ents = rt.entities.filter((e) => e.className === 'Black One' && !(e.flags & 0x8));
  if (!ents.length) return [];
  const stages = blackOneStages(rt.pkgs, ents[0].template);
  if (!stages.length) return [];
  const fight = new Fight(rt, stages);
  const out: { actor: Actor; move: SpecialMove }[] = [];
  for (const e of ents) {
    const kind = rt.manager.kinds.creature(e.template);
    if (!kind) continue;
    // The rig's bind pose lies below its origin (it rises out of the water with the appear
    // clip), so the bounds KindLibrary derives from the mesh put the body under the floor: the
    // draw culling's sight lines and the hit capsule then miss it. A standing pillar instead.
    kind.bottom = 0;
    kind.height = 7;
    kind.radius = 1.2;
    const [x, y, z] = toOutputSpace(e.position);
    const R = instanceRotation(e.rotation);
    const a = new Actor(kind, { x, y, z }, Math.atan2(R[2], R[8]), e.scale?.[0] ?? 1, e);
    a.maxHealth = a.health = 1e6;
    a.hostile = false;
    a.profile = { team: 'black-one' };
    a.dormantHidden = true;
    a.needsPlacement = false;
    const pads = e.links
      .map((u) => rt.byUid.get(u))
      .filter((p): p is Entity => p?.className === 'Teleport Pad')
      .map((p) => {
        const [px, py, pz] = toOutputSpace(p.position);
        const PR = instanceRotation(p.rotation);
        return { x: px, y: py, z: pz, yaw: Math.atan2(PR[2], PR[8]) };
      });
    const b = new BlackOne(a, e, fight, pads);
    fight.members.push(b);
    // Preload the stage clips (clip indices are added to the kind on first use).
    for (const s of stages) for (const c of [s.appear, s.stageChange, s.death, ...s.retreat, ...s.taunts, ...s.tauntsAfter, ...s.attacks.map((t) => t.clip)]) if (c) rt.manager.kinds.clipIndex(kind, c);
    out.push({ actor: a, move: b });
  }
  // Damage on a Black One goes to the heart it holds.
  rt.manager.on('damage', (a, info) => {
    const b = fight.members.find((m) => m.a === a);
    const env = rt.manager.env;
    if (b && env) b.hurt((info as { amount?: number })?.amount ?? 0, env);
  });
  // Projectiles in flight arrive in the level-wide tick.
  rt.tickers.push((_dt, env) => BlackOne.shots(fight, env));
  rt.log('black-one', `${fight.members.length} Black Ones, ${stages.length} stages, heart ${fight.max.toFixed(1)}`);
  (rt as { blackOne?: Fight }).blackOne = fight;
  return out;
}
