// CartWheeler (the blade-limbed "Slayer" creature): ceiling crawling, ceiling / floor
// transitions, the leap at its prey and its breakable head (docs/game-logic.md §15.7.5, §15.7.9;
// decoded numbers in cartwheeler-params.ts, the nav side in nav.ts, variants in variants.ts).
//
// What the original does [verified unless marked]:
//   * Surfaces are the floor and ceilings only (no wall mode): SetOnCeiling (Character vt 55,
//     0x100e2160) flips the physics (+0x72 flag 0x10), the animation controller and the up vector
//     (0, -1, 0), and sets condition bit 0. The ceiling clips hang below the origin (10:31 idle,
//     10:13 walk, 10:9 run, 10:91 / 10:92 turns): they are the ceiling variant (p1 = [0]) of the
//     MovementAnimBehavior. CartWheeler p180 = 1 starts on the ceiling (1a #64f8).
//   * Changing surface is a CeilingFloorTransitionBehavior, inserted by FollowPath when the next
//     path edge is a transition edge (type 3 on a ceiling, 2 on the floor; nav.ts): ceiling ->
//     floor plays p2 (let go: its root lowers the body 3.26 m), falls with gravity x p9 from
//     p10 m/s looping p3, lands with p4; floor -> ceiling plays p5, flies up at p8 (15) m/s with
//     gravity off looping p6 and catches the ceiling with p7; p11 s idle follow.
//   * Melee: on a ceiling the MeleeAttackBehavior is p179 (Attack 10:143: clip 10:8, 0..1.2 m
//     horizontally, at most p17 = 4 m of height), on the floor p87. After an attack the next one
//     waits CartWheelerKillMelee p2..p3 s (the ceiling variant 10:1880: 1..1.3 s; floor 10:141:
//     0.1..0.5 s).
//   * The leap (CartWheelerKillMelee update hook 0x10074c80, floor only): every p11 s, a target
//     p14..p15 (4..6.5 m) away within +-p16 (30) degrees ahead with a clear sweep (p17), rolled
//     at p13 (70) %; a failed roll or a finished leap waits p12 (4) s. JumpAttackBehavior p181:
//     launch Attack (10:960: clip 10:883, 3..6 m) carried by its root motion; touching the target
//     inside p7..p8 m of height sticks (stick Attack 10:1292: clip 10:87, springing back off),
//     else p9 (10:880); p10 after a stick.
//   * The close stance (condition bit 1) starts within p18 (5) m of the target and ends beyond p19
//     (7) m: MovementAnim variant 10:36 (walk 10:6), hit reactions p184, death p185.
//   * Head shot off (condition bit 2, 0x10072a30): headless variants (10:1418: attacks every
//     0.1..0.3 s, no leaps, no flight from the light) and once the AlertInfo p20 (10:1244, roar
//     10:1056) (0x10073080).
//   * Hit on a ceiling: p175 (10:451, it stays up); killed there: p177 (10:93 falls 3.8 m, loop
//     10:94, landing 10:95).
//   * Flashlight: CartWheelerKillMelee p21..p23 test the light the player's flashlight puts on
//     it (0x100747a0); then FleeLightBehavior p183 (AlertInfo 10:1311: 10:1237 backing off,
//     hiss 10:457), not again for p24..p25 s [inferred: the light model, the flight itself].
// Port [inferred]: ceiling movement keeps the origin on the ceiling found by rays over the body
// and stops at walls / height steps; without a ceiling route to the target a ceiling crawler lets
// go when the target is within 7 m (the old hanger rule); the transition point is between the
// two node areas; a floor crawler takes a ceiling route when the path search (transition edges at
// their horizontal length) starts with one.
//
// Raisable corpses (5b): a CartWheeler whose INITIAL behaviour (p68) is a DeathBehavior lies
// dead in its p2 pose from the start; Killjoy's RaiseDead brings it back (Resurrection, enum 0x4c:
// health back to p160 %, the DeathBehavior's p3 rise clip, then its active behaviour p69)
// [verified 0x100e7700 / 0x100eda03; the p3 rise clip: data].
//
// Debug: window.__specials.get(uid).move (info(), toCeiling(), placeOnCeiling(), letGo(), leap()).

import * as THREE from 'three/webgpu';
import type { Actor, ActorEnv } from '../actor';
import type { Behavior } from '../behaviors';
import type { ClipRef } from '../clipmap';
import { classByHash, readObjectTemplate } from '../../../formats/entities';
import { EDGE } from '../nav';
import { condBits, COND } from '../variants';
import { cartWheelerParams, type CartWheelerParams, type CwAttack, type Gait, type KillMeleeParams } from './cartwheeler-params';
import { installHead, type HeadState } from './head';
import { pickHitReact, reactionBlocks, type HitPick, type RunningReaction } from '../hit-react';
import { fightTarget } from './params';
import { drive, facing, flat, num, rand, ref, turnToward, wrapAngle, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';

/** What the controller is doing (null = the generic AI runs the actor). */
type Mode =
  | 'ceiling' // on a ceiling: idle / crawl / attack (the controller runs the actor)
  | 'down' // ceiling -> floor transition
  | 'up' // floor -> ceiling transition
  | 'toUp' // walking to a transition point to climb
  | 'leap' // jump attack
  | 'flee' // backing off from the flashlight
  | 'alert' // roar once the head is off
  | 'deathFall' // killed on a ceiling
  | 'placed'; // a placed CeilingFloorTransitionBehavior

/** Port: a ceiling crawler without a ceiling route lets go within this distance (the old hanger rule). */
const DROP_RANGE = 7;
/** Ceiling probe: rays up from this far under the origin, this long. */
const PROBE_UNDER = 1.0;
const PROBE_LEN = 1.8;
/** Port: a ceiling step the crawler takes (m); more is a wall. */
const CEIL_STEP = 0.6;
/** Port: the player's body radius (m) for reach tests. */
const PLAYER_R = 0.35;
const TURN = 6;

interface ClipIdx {
  idle: number;
  walk: number;
  run: number;
  turnL: number;
  turnR: number;
}

export class CartWheeler implements SpecialMove {
  readonly name = 'cartwheeler';
  readonly p: CartWheelerParams;
  surface: 'floor' | 'ceiling' = 'floor';
  mode: Mode | null = null;
  phase = '';
  private t = 0;
  private beh?: Behavior;
  private head?: HeadState;
  /** Initial DeathBehavior (placed corpse): pose clips p2, rise clip p3. */
  private corpse?: { pose: ClipRef[]; rise?: ClipRef };
  private corpseDone = false;
  private rising = 0;
  raised = 0;
  /** Condition word (variants.ts) and the KillMelee values it selects. */
  bits = 0;
  private close = false;
  private headless = false;
  km: KillMeleeParams;
  private gaitBits = -1;
  private ceilGait?: ClipIdx;
  /** Timers: next leap test, ceiling attack pause, next light flight, route replan. */
  private jumpTimer = 0;
  private attackDelay = 0;
  private lightTimer = 0;
  private routeTimer = 0;
  private route: number[] = [];
  private routeDown = -1;
  private stuck = 0;
  private lastHealth = 0;
  private alerted = false;
  private clip = -1;
  private hits = 0;
  /** Transition / leap scratch. */
  private ceilY = 0;
  private from = new THREE.Vector3();
  private dropY = 0;
  private leapHit = false;
  /** JumpAttackLaunch's stick target: the first body the leap touched (player or character). */
  private leapOn: Actor | 'player' | null = null;
  private leapTarget = new THREE.Vector3();
  private upAt?: { x: number; z: number; yaw: number };
  stats = { up: 0, down: 0, leaps: 0, sticks: 0, missed: 0, ceilingAttacks: 0, ceilingHits: 0, flees: 0, crawled: 0 };

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    this.head = installHead(a, rt);
    const t = readObjectTemplate(rt.pkgs, a.entity?.template ?? a.kind.template);
    const types = t ? classByHash(t.classHash)?.types ?? [] : [];
    const values = a.entity?.values ?? rt.template(a.kind.template)?.v ?? [];
    this.p = cartWheelerParams(rt.pkgs, values, types);
    this.km = this.p.killMelee(0);
    a.meleePause = this.km.attackPause;
    // A CeilingFloorTransition in transit consumes the attack stimulus (0x1010b060): no hit
    // reaction while letting go / flying up [verified]; the leap's flight neither [port: the
    // special drives the body through it].
    a.reactGate = () => !(this.mode === 'down' || this.mode === 'up' || this.mode === 'toUp' || this.mode === 'leap');
    const d = rt.template(ref(values[68]));
    if (d?.cls === 'DeathBehavior') this.corpse = { pose: refsOf(d.v[2]), rise: ref(d.v[3]) };
    // p180: on the ceiling from the start (its dormant clip already hangs it there, manager.ts).
    if (this.p.startOnCeiling) {
      this.surface = 'ceiling';
      this.mode = 'ceiling';
      a.crawler = true;
      if (!a.ceiling) a.hangFromCeiling(-1);
    }
    this.lastHealth = a.health;
  }

  /**
   * Save: the surface it is on (a transition counts as done: letting go / leaping is the floor,
   * climbing up the ceiling). A crawler that started on the ceiling (p180) and came down must
   * not hang there again after a restore; one that climbed up is hung again by update().
   */
  save() {
    const m = this.mode;
    const s = m === 'down' || m === 'leap' || m === 'deathFall' || m === 'toUp' ? 'floor' : m === 'up' ? 'ceiling' : this.surface;
    return { s };
  }

  load(state: unknown) {
    const s = (state as { s?: string } | null)?.s;
    const a = this.a;
    if (s === 'floor' && (this.surface === 'ceiling' || this.mode)) {
      this.surface = 'floor';
      this.set(null);
      a.crawler = false;
      a.ceiling = false;
    }
  }

  info() {
    return {
      cw: this.mode ?`${this.mode}${this.phase ? ':' + this.phase : ''}` : 'none',
      surface: this.surface,
      bits: this.bits,
      killMelee: this.km.ref ? `${this.km.ref.pkg}:${this.km.ref.id}` : '',
      transitions: this.stats.up + this.stats.down,
      raised: this.raised,
      ...this.stats,
      ...(this.head?.info() ?? {}),
    };
  }

  // --- small helpers -------------------------------------------------------------------

  private play(c: ClipRef | undefined, loop: boolean, speed = 1) {
    const env = this.rt.manager.env;
    const i = env ? env.clip(this.a, c) : -1;
    this.clip = i;
    if (i >= 0) {
      const act = this.a.playClip(i, loop, speed);
      if (act && !loop) act.time = 0;
    }
    return i >= 0;
  }

  private set(mode: Mode | null, phase = '') {
    if (mode !== this.mode || phase !== this.phase) this.rt.log(this.a, `${this.surface} ${mode ?? 'ai'}${phase ? ':' + phase : ''}`);
    this.mode = mode;
    this.phase = phase;
    this.t = 0;
  }

  /** Ceiling over (x, z) near height y: a down-facing surface hit by a ray up from under it. */
  private ceilingAt(env: ActorEnv, x: number, y: number, z: number, under = PROBE_UNDER, len = PROBE_LEN): number | null {
    const h = env.world.raycast(x, y - under, z, 0, 1, 0, len);
    return h && h.normal[1] < -0.3 ? h.point[1] : null;
  }

  /** Root translation of a clip from its start to time `t` (model units x scale, character space). */
  private rootAt(clip: number, t: number): [number, number, number] {
    const a = this.a, d = a.ch.clipData[clip];
    const skel = a.kind.skinned.skeleton;
    const tr = d?.tracks.find((x) => x.translations && skel.bones[skel.byHash.get(x.boneHash) ?? -1]?.parent === -1);
    if (!tr?.translations || tr.times.length < 2) return [0, 0, 0];
    const T = tr.times, v = tr.translations;
    let i = 0;
    while (i + 1 < T.length && T[i + 1] <= t) i++;
    const j = Math.min(T.length - 1, i + 1);
    const k = T[j] > T[i] ? Math.max(0, Math.min(1, (t - T[i]) / (T[j] - T[i]))) : 0;
    const at = (n: number) => v[i * 3 + n] + (v[j * 3 + n] - v[i * 3 + n]) * k;
    return [(at(0) - v[0]) * a.scale, (at(1) - v[1]) * a.scale, (at(2) - v[2]) * a.scale];
  }

  /**
   * Root-motion move (leap, spring back, backing off): the body goes where the clip puts it,
   * stopped by walls (a swept sphere at mid height) and kept on the floor under it.
   */
  private slideTo(env: ActorEnv, wx: number, wz: number) {
    const a = this.a, m = a.motor.position;
    let dx = wx - m.x, dz = wz - m.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-5) return 0;
    dx /= d;
    dz /= d;
    const r = Math.max(0.2, a.radius * 0.9);
    const y = m.y + Math.max(r + 0.05, 0.8 * a.scale);
    const hit = env.world.sphereCast(m.x, y, m.z, r, dx, 0, dz, d);
    const go = hit ? Math.max(0, hit.distance - 0.02) : d;
    m.x += dx * go;
    m.z += dz * go;
    const g = env.world.raycast(m.x, m.y + 0.6, m.z, 0, -1, 0, 1.6);
    if (g && g.normal[1] > 0.5) {
      m.y = g.point[1];
      a.motor.onGround = true;
      a.motor.velocity.x = a.motor.velocity.y = a.motor.velocity.z = 0;
    } else a.motor.step(1 / 60, { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false });
    return go;
  }

  /** Where a clip's root has carried the body since `from` (yaw-turned, horizontal). */
  private rootTarget(): [number, number] {
    const a = this.a;
    const [rx, , rz] = this.rootAt(this.clip, this.clipTime());
    const s = Math.sin(a.yaw), c = Math.cos(a.yaw);
    return [this.from.x + rx * c + rz * s, this.from.z - rx * s + rz * c];
  }

  private clipTime() {
    return this.a.ch.current?.time ?? this.t;
  }

  private clipLen(i = this.clip) {
    const d = i >= 0 ? this.a.ch.clipData[i] : undefined;
    return d ? d.duration / (d.rate || 1) : 0;
  }

  /** The target the generic AI picked (the player or a character, else an object's feet). */
  private target(env: ActorEnv): THREE.Vector3Like | undefined {
    const a = this.a;
    if (!a.inCombat) return undefined;
    return fightTarget(a, env)?.pos ?? a.targetFeet(env);
  }

  private gaitIdx(g: Gait | undefined, env: ActorEnv): ClipIdx | undefined {
    if (!g) return undefined;
    const c = (r?: ClipRef) => (r ? env.clip(this.a, r) : -1);
    const out = { idle: c(g.idle), walk: c(g.walk), run: c(g.run), turnL: c(g.turnLeft), turnR: c(g.turnRight) };
    return out.idle >= 0 && out.walk >= 0 ? out : undefined;
  }

  /** Condition word -> KillMelee and MovementAnim variants (variants.ts) [verified selection]. */
  private updateConditions(env: ActorEnv) {
    const a = this.a;
    const headOff = this.head?.info().head === 'off';
    if (headOff && !this.headless) this.headless = true;
    // The close stance: floor only (0x10074c80 tests it after the ceiling check).
    const tp = this.surface === 'floor' ? this.target(env) : undefined;
    if (tp) {
      const d = Math.hypot(tp.x - a.position.x, tp.y - a.position.y, tp.z - a.position.z);
      if (d <= this.km.closeIn) this.close = true;
      else if (d >= this.km.closeOut) this.close = false;
    }
    const bits = condBits({ ceiling: this.surface === 'ceiling', close: this.close, headless: this.headless });
    if (bits === this.bits && this.gaitBits === bits) return;
    this.bits = bits;
    this.gaitBits = bits;
    this.km = this.p.killMelee(bits);
    a.meleePause = this.km.attackPause;
    const g = this.gaitIdx(this.p.gait(bits), env);
    if (this.surface === 'ceiling') {
      this.ceilGait = g;
      a.gaitClips = undefined;
    } else {
      a.gaitClips = g ? { idle: g.idle, walk: g.walk, run: g.run >= 0 ? g.run : g.walk } : undefined;
    }
  }

  // --- update --------------------------------------------------------------------------

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    this.head?.update(dt, env);
    if (this.corpse && !this.corpseDone) {
      // A corpse from the start: dead in its pose until raised.
      this.corpseDone = true;
      a.makeCorpse(env, { cls: 'DeathBehavior', kind: 'death', next: [], clips: this.corpse.pose });
      return true;
    }
    if (!a.alive) return this.deadUpdate(dt, env);
    if (this.rising) {
      this.rising += dt;
      a.sync();
      if (!a.clipDone && this.rising < 4) return true;
      this.rising = 0;
      a.state = 'chase';
    }
    if (a.hidden || a.scripted) return false;
    // A restored save or a level script hung it on a ceiling while awake: it crawls from there.
    if (a.ceiling && this.surface === 'floor' && !this.mode && (this.p.startOnCeiling || a.behavior?.kind !== 'dormant')) this.attach(env, false);
    // A placed CeilingFloorTransitionBehavior (Behavior Changer).
    const b = a.behavior;
    if (b?.cls === 'CeilingFloorTransitionBehavior' && b !== this.beh && this.mode !== 'down' && this.mode !== 'up') {
      this.beh = b;
      const v = (b.uid ? env.entity(b.uid)?.values : undefined) ?? this.rt.template(ref(a.entity?.values[178]))?.v;
      if (v) Object.assign(this.p.transition, (({ letGo, fall, land, launch, rise, grab, upSpeed, gravity, downSpeed, hold }) => ({ letGo, fall, land, launch, rise, grab, upSpeed, gravity, downSpeed, hold }))(transitionOf(v)));
      if (this.surface === 'ceiling' || a.ceiling) this.startDown(env, 'placed behaviour');
      else if (!this.startUp(env, 'placed behaviour')) this.startDown(env, 'placed behaviour (hanging)');
      this.placedRun = true;
    }
    this.updateConditions(env);
    this.jumpTimer -= dt;
    this.attackDelay -= dt;
    this.lightTimer -= dt;
    this.routeTimer -= dt;
    this.t += dt;
    this.lastHealth = a.health;
    // Blows taken on the ceiling (actor.ts keeps them for us): the ceiling lists pick the
    // reaction like any hit reaction (hit-react.ts) [verified].
    const blow = a.blowsTaken;
    a.blowsTaken = undefined;
    const hurt = blow ? this.ceilingReaction(blow.amount, blow.special) : undefined;
    // A whole-body hit reaction (actor.ts) pauses the flee / alert act like the behaviour under it.
    if (a.state === 'hurt' && (this.mode === 'flee' || this.mode === 'alert')) this.set(null);
    switch (this.mode) {
      case 'down':
        return this.updateDown(dt, env);
      case 'up':
        return this.updateUp(dt, env);
      case 'toUp':
        return this.updateToUp(dt, env);
      case 'leap':
        return this.updateLeap(dt, env);
      case 'flee':
      case 'alert':
        return this.updateAct(dt, env);
      case 'ceiling':
        return this.updateCeiling(dt, env, hurt);
    }
    return this.floorDecide(dt, env);
  }

  private placedRun = false;

  // --- floor: what to do besides the generic chase / melee -------------------------------

  private floorDecide(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (a.state === 'hurt' || a.state === 'attack' || a.state === 'fall' || a.state === 'shoot' || a.state === 'door' || a.state === 'act') return false;
    // Head shot off: the AlertInfo p20 once the stagger is over (0x10073080).
    if (this.headless && !this.alerted) {
      this.alerted = true;
      if (this.km.alertClips.length && this.play(this.km.alertClips[0], false)) {
        if (this.km.alertSounds.length) this.rt.sound(this.km.alertSounds, { x: a.position.x, y: a.position.y + 1.2, z: a.position.z });
        a.state = 'act';
        this.set('alert');
        return true;
      }
    }
    // A Waypoint walk whose Waypoint hangs on the ceiling (3b's 2cc5: Waypoints 2cc8 / 2dfd / 2d00
    // at 102.6 m, 4.4 m over the south corridor's floor): its MoveTo is a crawler path that climbs
    // by a transition edge (routeCheck), else the body leaps up under the Waypoint and crawls on
    // from there (ceilingWaypoints) [inferred]. Before, it paced under 2cc8 for good.
    if (a.behavior?.kind === 'waypoint' && !a.inCombat) {
      const wp = env.entity(a.waypointNow);
      if (wp?.className === 'Waypoint') {
        const p = { x: wp.position[0] / 2048, y: wp.position[1] / 2048, z: wp.position[2] / 2048 };
        if (p.y - a.position.y > 2) {
          this.wp = wp.uid;
          if (this.routeCheck(env, p)) return true;
          if (Math.hypot(p.x - a.position.x, p.z - a.position.z) < 1.5 && this.ceilingAt(env, a.position.x, a.position.y, a.position.z) !== null && this.startUp(env, 'waypoint on the ceiling')) return true;
        }
      }
    }
    const tp = this.target(env);
    if (!tp) return false;
    if (this.lightCheck(env)) return true;
    if (this.leapCheck(env, tp)) return true;
    if (this.routeCheck(env, tp)) return true;
    return false;
  }

  /** CartWheelerKillMelee update hook (0x10074c80): the leap test [verified]. */
  private leapCheck(env: ActorEnv, tp: THREE.Vector3Like): boolean {
    const a = this.a, j = this.p.jump, k = this.km;
    // Whatever the KillMelee fights: no class test in 0x10074c80 [verified].
    const ft = fightTarget(a, env);
    if (!j?.launch?.clip || k.jumpChance <= 0 || this.jumpTimer > 0 || !ft || (ft.player && this.rt.holder)) return false;
    this.jumpTimer = k.jumpRecheck;
    const d = Math.hypot(tp.x - a.position.x, tp.y - a.position.y, tp.z - a.position.z);
    if (!(d > k.jumpBand[0] && d < k.jumpBand[1])) return false;
    if (facing(a, tp) < Math.cos((k.jumpCone * Math.PI) / 180)) return false;
    // The swept test must reach the target (0x100c6630).
    const r = Math.max(0.1, k.jumpSweep * 0.5 * a.scale);
    const y0 = a.position.y + 0.9, y1 = tp.y + 0.9;
    const dx = tp.x - a.position.x, dy = y1 - y0, dz = tp.z - a.position.z, len = Math.hypot(dx, dy, dz);
    const hit = env.world.sphereCast(a.position.x, y0, a.position.z, r, dx, dy, dz, len);
    if (hit && hit.distance < len - PLAYER_R - r) return false;
    if (Math.random() * 100 >= k.jumpChance) {
      this.jumpTimer = k.jumpWait;
      return false;
    }
    return this.leap(env, `${d.toFixed(1)} m`);
  }

  /** Start the jump attack at the target (debug: also from the console). */
  leap(env: ActorEnv | null = this.rt.manager.env, why = 'forced'): boolean {
    const a = this.a, j = this.p.jump;
    if (!env || !j?.launch?.clip || this.surface !== 'floor' || !a.alive) return false;
    const tp = this.target(env) ?? env.player.position;
    this.leapTarget.set(tp.x, tp.y, tp.z);
    this.leapHit = false;
    this.leapOn = null;
    this.stats.leaps++;
    a.state = 'act';
    this.set('leap', 'face');
    this.rt.log(a, `leaps (${why})`);
    return true;
  }

  private updateLeap(dt: number, env: ActorEnv): boolean {
    const a = this.a, j = this.p.jump!, p = env.player.position;
    a.state = 'act';
    switch (this.phase) {
      case 'face': {
        // JumpAttack: MoveTo within the launch Attack's reach (p5 s), face, check the band.
        const tp = this.target(env) ?? p;
        const d = flat(a.position, tp);
        const L = j.launch!, sc = L.scaled ? a.scale : 1;
        if (d > L.reach * sc && this.t < j.approach) {
          turnToward(a, yawTo(a.position, tp), TURN, dt);
          drive(a, dt, -Math.sin(a.yaw), -Math.cos(a.yaw), Math.max(2, a.kind.runSpeed));
          if (a.gaitClips) a.playClip(a.gaitClips.run, true);
          break;
        }
        const err = turnToward(a, yawTo(a.position, tp), TURN * 1.5, dt);
        if (Math.abs(err) > 0.15 && this.t < j.approach + 0.6) break;
        if (d < L.minReach * sc || d > L.reach * sc + 0.5) {
          this.rt.log(a, `leap called off (${d.toFixed(1)} m)`);
          return this.endLeap();
        }
        this.from.set(a.position.x, a.position.y, a.position.z);
        this.play(L.clip, false);
        this.set('leap', 'launch');
        break;
      }
      case 'launch': {
        // JumpAttackLaunch: the clip's root motion carries the body; a touch inside the height
        // window sticks (0x100743c0).
        const [wx, wz] = this.rootTarget();
        this.slideTo(env, wx, wz);
        // The stick target is the first body the leap touches: the player, or any character that
        // takes a jump attack (vt 0x134: all but a Mainliner's victim without p143) [verified
        // 0x100744f0..0x100745f7]; the window test is against it while they touch.
        this.leapOn ??= this.launchContact(env);
        const on = this.leapOn;
        const q = on === 'player' ? (env.playerAlive ? p : undefined) : on?.alive ? on.position : undefined;
        const d = q ? flat(a.position, q) : Infinity;
        const dy = q ? q.y - a.position.y : 0;
        const lateral = q ? Math.abs(-Math.cos(a.yaw) * (q.x - a.position.x) + Math.sin(a.yaw) * (q.z - a.position.z)) / Math.max(d, 1e-3) : 1;
        const touching = q && on ? d < a.radius + (on === 'player' ? PLAYER_R : on.radius) + 0.35 : false;
        if (q && on && touching && dy >= j.height[0] - 0.3 && dy <= j.height[1] + 0.3 && lateral <= Math.cos((j.cone * Math.PI) / 180) + 1e-6) {
          // The blades' blow (Arm / Disarm of the launch Attack) [inferred: one blow on contact].
          if (!this.leapHit) {
            this.leapHit = true;
            if (on === 'player') this.rt.hurtPlayer(j.launch!.damage, a, env);
            else this.rt.hurtActor(on, j.launch!.damage, a);
            if (on !== 'player') this.rt.log(a, `leap sticks to ${on.ch.root.name}: ${j.launch!.damage.toFixed(1)}`);
          }
          this.stats.sticks++;
          this.from.set(a.position.x, a.position.y, a.position.z);
          this.play(j.stick?.clip, false, 1);
          this.rt.shake(a.position, 0.3, 0.4);
          this.set('leap', 'stick');
          break;
        }
        if (a.clipDone || this.t > this.clipLen() + 0.3) {
          this.stats.missed++;
          this.from.set(a.position.x, a.position.y, a.position.z);
          this.play(j.missed, false);
          this.set('leap', 'missed');
        }
        break;
      }
      case 'stick': {
        // JumpAttackStick: the stick clip springs back off the target (its root motion).
        const [wx, wz] = this.rootTarget();
        this.slideTo(env, wx, wz);
        if (a.clipDone || this.t > this.clipLen() + 0.3) {
          this.from.set(a.position.x, a.position.y, a.position.z);
          this.play(j.recover, false);
          this.set('leap', 'recover');
        }
        break;
      }
      case 'missed':
      case 'recover': {
        // The landing / recovery clips travel too (10:880: 1.7 m on).
        const [wx, wz] = this.rootTarget();
        this.slideTo(env, wx, wz);
        if (a.clipDone || this.t > Math.max(0.5, this.clipLen()) + 0.2) return this.endLeap();
        break;
      }
    }
    a.sync();
    return true;
  }

  /** The launch's mover contact [port: the bodies' cylinders within 0.35 m]: player first. */
  private launchContact(env: ActorEnv): Actor | 'player' | null {
    const a = this.a;
    const touch = (q: THREE.Vector3Like, r: number) => flat(a.position, q) < a.radius + r + 0.35;
    if (env.playerAlive && touch(env.player.position, PLAYER_R)) return 'player';
    for (const o of env.actors) {
      if (o === a || !o.alive || o.hidden || o.kind.decor || o.template) continue;
      if (Math.abs(o.position.y - a.position.y) > Math.max(2, o.height)) continue;
      if (touch(o.position, o.radius)) return o;
    }
    return null;
  }

  private endLeap(): boolean {
    this.jumpTimer = this.km.jumpWait;
    this.a.state = 'chase';
    this.set(null);
    return false;
  }

  /**
   * Flashlight (0x100747a0 / FleeLight p183) [inferred light model]: lit by the beam close up
   * (intensity over p22) and the p23 roll -> back off playing the AlertInfo clip with its hiss.
   */
  private lightCheck(env: ActorEnv): boolean {
    const a = this.a, k = this.km;
    if (k.lightChance <= 0 || this.lightTimer > 0 || !this.p.fleeClips.length) return false;
    const fl = (this.rt.ctx.services.weapons as { flashlight?: { on: boolean } } | undefined)?.flashlight;
    if (!fl?.on) return false;
    const pl = env.player, p = pl.position;
    const cam = this.rt.ctx.view?.camera as THREE.Camera | undefined;
    const dir = new THREE.Vector3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    if (cam) cam.getWorldDirection(dir);
    const to = new THREE.Vector3(a.position.x - p.x, a.position.y + 0.9 - (p.y + 1.6), a.position.z - p.z);
    const d = to.length();
    if (d < 0.5) return false;
    const cos = to.dot(dir) / d;
    // Beam: full within 10 degrees of its axis, nothing past 25; fading to nothing at 10 m.
    const cone = Math.max(0, Math.min(1, (cos - Math.cos((25 * Math.PI) / 180)) / (Math.cos((10 * Math.PI) / 180) - Math.cos((25 * Math.PI) / 180))));
    const lit = cone * Math.max(0, 1 - d / 10);
    if (lit < k.lightFlee) return false;
    this.lightTimer = rand(k.lightWait[0], k.lightWait[1]);
    if (Math.random() * 100 >= k.lightChance) return false;
    this.stats.flees++;
    this.from.set(a.position.x, a.position.y, a.position.z);
    a.yaw = yawTo(a.position, p);
    this.play(this.p.fleeClips[0], false);
    if (this.p.fleeSounds.length) this.rt.sound(this.p.fleeSounds, { x: a.position.x, y: a.position.y + 1, z: a.position.z });
    a.state = 'act';
    this.set('flee', `lit ${lit.toFixed(2)}`);
    return true;
  }

  /** Flight from the light / the roar: the clip plays out (its root motion moves the body). */
  private updateAct(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    a.state = 'act';
    if (this.mode === 'flee') {
      const [wx, wz] = this.rootTarget();
      this.slideTo(env, wx, wz);
    } else drive(a, dt, 0, 0, 0.01);
    a.sync();
    if (a.clipDone || this.t > Math.max(0.5, this.clipLen()) + 0.2 || this.clip < 0) {
      a.state = 'chase';
      this.set(null);
      return false;
    }
    return true;
  }

  /**
   * FollowPath's transition edges (nav.ts) [verified insertion; inferred route choice]: a path
   * from here to the target over every node, transition edges at their horizontal length; when
   * it climbs within its first two edges, walk to the transition point and leap up.
   */
  private routeCheck(env: ActorEnv, tp: THREE.Vector3Like): boolean {
    const a = this.a, nav = env.nav;
    if (this.routeTimer > 0 || !nav?.hasCeiling || !this.p.transition.launch) return false;
    this.routeTimer = 1.2 + Math.random() * 0.6;
    const from = nav.nearest(a.position.x, a.position.y, a.position.z, env.world, 6, a.radius * 0.9);
    const to = nav.nearest(tp.x, tp.y, tp.z, env.world);
    if (from < 0 || to < 0) return false;
    const blocked = env.navBlocked ? (i: number, j: number) => env.navBlocked!(i, j, a) : undefined;
    const path = nav.path(from, to, blocked, { crawler: true });
    if (!path || path.length < 2) return false;
    for (let k = 0; k + 1 < path.length && k < 2; k++) {
      if (nav.edgeType(path[k], path[k + 1]) !== EDGE.up) continue;
      const tpt = nav.transitionPoint(path[k + 1], path[k]);
      const c = nav.nodes[path[k + 1]];
      if (flat(a.position, { x: tpt.x, y: 0, z: tpt.z }) > 12) return false;
      this.upAt = { ...tpt, yaw: yawTo({ x: tpt.x, y: 0, z: tpt.z }, c) };
      a.state = 'act';
      this.set('toUp');
      return true;
    }
    return false;
  }

  private updateToUp(dt: number, env: ActorEnv): boolean {
    const a = this.a, at = this.upAt!;
    a.state = 'act';
    const d = Math.hypot(at.x - a.position.x, at.z - a.position.z);
    if (d > 0.35 && this.t < 6) {
      turnToward(a, yawTo(a.position, { x: at.x, y: 0, z: at.z }), TURN, dt);
      const moved = drive(a, dt, at.x - a.position.x, at.z - a.position.z, Math.max(2, a.kind.runSpeed));
      if (a.gaitClips) a.playClip(a.gaitClips.run, true);
      else if (a.kind.run >= 0) a.playClip(a.kind.run, true);
      this.stuck = moved < dt * 0.3 ? this.stuck + dt : 0;
      if (this.stuck > 0.8) {
        this.stuck = 0;
        a.state = 'chase';
        this.set(null);
        return false;
      }
      a.sync();
      return true;
    }
    if (!this.startUp(env, 'path leads up')) {
      a.state = 'chase';
      this.set(null);
      return false;
    }
    return true;
  }

  // --- transitions ---------------------------------------------------------------------

  /** Floor -> ceiling (CeilingFloorTransition d = 1). False when there is no ceiling above. */
  startUp(env: ActorEnv | null = this.rt.manager.env, why = 'forced'): boolean {
    const a = this.a;
    if (!env || this.surface === 'ceiling') return false;
    const h = env.world.raycast(a.position.x, a.position.y + 1, a.position.z, 0, 1, 0, 25);
    if (!h || h.normal[1] > -0.3) return false;
    this.ceilY = h.point[1];
    if (this.upAt) a.yaw = this.upAt.yaw;
    this.upAt = undefined;
    this.stats.up++;
    a.state = 'act';
    this.set('up', 'launch');
    this.rt.log(a, `floor -> ceiling (${why}; ${(this.ceilY - a.position.y).toFixed(1)} m up)`);
    if (!this.play(this.p.transition.launch, false)) this.phase = 'rise';
    return true;
  }

  private updateUp(dt: number, env: ActorEnv): boolean {
    const a = this.a, tr = this.p.transition;
    a.state = 'act';
    switch (this.phase) {
      case 'launch':
        if (a.clipDone || this.t > 1.2) {
          // The launch clip's root rises in the pose: the flight starts where it ends.
          if (this.clip >= 0) a.motor.position.y += Math.max(0, this.rootAt(this.clip, a.ch.clipData[this.clip]?.duration ?? 0)[1]);
          a.occlusionTimer = 0;
          this.phase = 'rise';
          this.t = 0;
          this.play(tr.rise, true);
          // SetOnCeiling(1) comes here in the original (0x10110676), the body flies up at p8.
          this.rt.log(a, 'rises');
        }
        break;
      case 'rise': {
        // The body reaches the ceiling with its hands: the catching clip starts with the feet
        // this far under the origin.
        const grab = env.clip(a, tr.grab);
        const reach = grab >= 0 ? -this.rt.manager.kinds.jointRange(a.kind, grab).minY * a.scale : 3;
        a.motor.position.y += tr.upSpeed * dt;
        if (a.motor.position.y + reach >= this.ceilY || this.t > 3) this.attach(env, true);
        break;
      }
      case 'grab':
        if (a.clipDone || this.t > 1.5) {
          if (this.t < this.clipLen() + tr.hold) break;
          this.finishTransition(env);
          this.set('ceiling');
        }
        break;
    }
    a.sync();
    return true;
  }

  /** Onto the ceiling over the actor (SetOnCeiling(1)). `grab`: play the catching clip. */
  private attach(env: ActorEnv, grab: boolean) {
    const a = this.a;
    const y = grab ? this.ceilY : this.ceilingAt(env, a.position.x, a.position.y, a.position.z) ?? a.position.y;
    a.motor.position.y = y;
    a.motor.velocity.x = a.motor.velocity.y = a.motor.velocity.z = 0;
    a.occlusionTimer = 0;
    const idle = this.ceilGait?.idle ?? env.clip(a, this.p.gait(condBits({ ceiling: true }))?.idle);
    const bottom = idle >= 0 ? this.rt.manager.kinds.jointRange(a.kind, idle).minY - 0.2 : -1;
    a.hangFromCeiling(bottom);
    a.crawler = true;
    a.gaitClips = undefined;
    this.surface = 'ceiling';
    this.gaitBits = -1;
    this.updateConditions(env);
    if (grab) {
      this.set('up', 'grab');
      if (!this.play(this.p.transition.grab, false)) this.t = 99;
    } else {
      this.set('ceiling');
      if (this.ceilGait) a.playClip(this.ceilGait.idle, true);
    }
  }

  /** Ceiling -> floor (CeilingFloorTransition d = 0). */
  startDown(env: ActorEnv | null = this.rt.manager.env, why = 'forced') {
    const a = this.a;
    if (!env) return;
    this.stats.down++;
    a.state = 'act';
    this.set('down', 'letGo');
    this.rt.log(a, `ceiling -> floor (${why})`);
    if (!this.play(this.p.transition.letGo, false)) this.fallFromCeiling(env);
  }

  private fallFromCeiling(env: ActorEnv) {
    const a = this.a, tr = this.p.transition;
    // The let-go clip's root translation lowers the body: the fall starts where it ends.
    const lower = this.clip >= 0 && this.mode === 'down' && this.phase === 'letGo' ? -this.rootAt(this.clip, a.ch.clipData[this.clip]?.duration ?? 0)[1] : 0;
    const drop = lower > 0.2 ? lower : a.ceiling ? -a.bottom + a.position.y : 0;
    a.ceiling = false;
    a.crawler = false;
    a.motor.position.y -= Math.max(0, drop);
    // The body jumped: the occlusion verdict of the old place is stale (manager.ts cull).
    a.occlusionTimer = 0;
    a.motor.velocity.x = a.motor.velocity.z = 0;
    a.motor.velocity.y = -tr.downSpeed;
    a.motor.onGround = false;
    this.surface = 'floor';
    this.dropY = a.motor.position.y;
    this.set('down', 'fall');
    this.play(tr.fall, true);
    void env;
  }

  private updateDown(dt: number, env: ActorEnv): boolean {
    const a = this.a, tr = this.p.transition;
    a.state = 'act';
    switch (this.phase) {
      case 'letGo':
        if (a.clipDone || this.t > 2) this.fallFromCeiling(env);
        break;
      case 'fall': {
        // Gravity x p9 through the motor (its own gravity is 1 g).
        const steps = Math.max(1, Math.round(tr.gravity));
        for (let i = 0; i < steps; i++) a.motor.step(dt / steps, { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false });
        if (a.motor.onGround || this.t > 5) {
          this.rt.log(a, `lands (${(this.dropY - a.position.y).toFixed(1)} m fall)`);
          this.set('down', 'land');
          if (!this.play(tr.land, false)) this.t = 99;
        }
        break;
      }
      case 'land':
        if (a.clipDone || this.t > 2.5) {
          if (this.t < this.clipLen() + tr.hold) break;
          this.finishTransition(env);
          a.state = 'chase';
          this.set(null);
          a.sync();
          return false;
        }
        break;
    }
    a.sync();
    return true;
  }

  /** A placed CeilingFloorTransitionBehavior completes: its chain successor, else the active behaviour. */
  private finishTransition(env: ActorEnv) {
    this.gaitBits = -1;
    this.updateConditions(env);
    if (!this.placedRun) return;
    this.placedRun = false;
    const a = this.a, b = this.beh;
    if (a.behavior !== b) return;
    const next = b?.next.length ? env.behaviors?.fromPlaced(b.next[0]) : undefined;
    if (next) return a.setBehavior(next, env, true);
    const done = a.onChainDone;
    a.onChainDone = undefined;
    done?.();
    const act = a.profile.active;
    a.setBehavior(act && act.kind !== 'dormant' && act.kind !== 'death' ? act : undefined, env);
  }

  /** Debug / tests: leap up to the ceiling above, or put it there at once. */
  toCeiling(): boolean {
    return this.startUp(this.rt.manager.env, 'forced');
  }
  placeOnCeiling(): boolean {
    const env = this.rt.manager.env;
    if (!env) return false;
    const a = this.a;
    const h = env.world.raycast(a.position.x, a.position.y + 1, a.position.z, 0, 1, 0, 25);
    if (!h || h.normal[1] > -0.3) return false;
    this.ceilY = h.point[1];
    a.motor.position.y = this.ceilY;
    this.attach(env, false);
    return true;
  }
  letGo() {
    if (this.surface === 'ceiling') this.startDown(this.rt.manager.env, 'forced');
  }

  // --- on the ceiling ------------------------------------------------------------------

  /** Running ceiling flinch, as the interrupt test sees it (hit-react.ts reactionBlocks). */
  private ceilFlinch?: RunningReaction;

  /**
   * The ceiling hit reaction a blow picks (p176 by Special Hit Reaction, else p175 by damage),
   * undefined when none plays: below the band (10:1259 starts at 5: gas never flinches it) or
   * refused by the running flinch's p6 mode against the blow's whole points.
   */
  private ceilingReaction(amount: number, special?: ClipRef): HitPick | undefined {
    const pick = pickHitReact(this.p.ceilingHits.hits, amount, { specials: this.p.ceilingHits.specials, special });
    if (!pick) return undefined;
    if (this.phase === 'flinch' && this.ceilFlinch && reactionBlocks(this.ceilFlinch, Math.trunc(amount))) return undefined;
    return pick;
  }

  private updateCeiling(dt: number, env: ActorEnv, hurt: HitPick | undefined): boolean {
    const a = this.a;
    a.sense(dt, env);
    const g = this.ceilGait;
    // Dormant (1a #64f8 until its Behavior Changer): hangs playing its dormant clip.
    if (a.behavior?.kind === 'dormant') {
      a.state = 'idle';
      // Its dormant clip loops; after a catch (a play-once clip) the ceiling idle takes over.
      if (a.clipDone && g) a.playClip(g.idle, true);
      a.sync();
      return true;
    }
    // Hit while up there: p175's flinch, it stays (vt 64). It cuts the ceiling slash short:
    // the slash's Attack 10:143 has p39 = 1, so its MeleeAttack lets the reaction through
    // (0x10080290) [verified].
    const flinchClip = hurt ? (hurt.def.clips[0] ?? this.p.ceilingHit[0]) : undefined;
    if (hurt && flinchClip) {
      this.stats.ceilingHits++;
      this.play(flinchClip, false);
      this.ceilFlinch = { min: hurt.def.min, max: hurt.max, mode: hurt.def.mode };
      this.set('ceiling', 'flinch');
    }
    if (this.phase === 'flinch') {
      if (!a.clipDone && this.t < 1.5) return this.keep();
      this.set('ceiling');
    }
    if (this.phase === 'attack') return this.updateCeilingAttack(dt, env);
    // A ceiling waypoint walk (level 2 #2ed0) [port: straight to each waypoint].
    if (a.behavior?.kind === 'waypoint' && !a.inCombat) return this.ceilingWaypoints(dt, env, a.behavior);
    const tp = this.target(env);
    if (!tp) {
      a.state = 'idle';
      if (g) a.playClip(g.idle, true);
      return this.keep();
    }
    a.state = 'chase';
    // The ceiling melee (p179): the Attack's band and height limit [verified 0x10080180].
    const att = this.p.ceilingAttacks.find((x) => this.inReach(x, tp));
    if (att && this.attackDelay <= 0) {
      this.stats.ceilingAttacks++;
      this.hits = 0;
      this.ceilAttack = att;
      a.yaw = yawTo(a.position, tp);
      a.state = 'attack';
      this.play(att.clip, false);
      this.set('ceiling', 'attack');
      return this.keep();
    }
    this.crawlToward(dt, env, tp);
    return this.keep();
  }

  private ceilAttack?: CwAttack;

  private inReach(x: CwAttack, tp: THREE.Vector3Like, slack = 0) {
    const a = this.a, sc = x.scaled ? a.scale : 1;
    const d = flat(a.position, tp) - PLAYER_R;
    const dy = Math.abs(a.position.y - tp.y);
    return d >= x.minReach * sc - slack && d <= x.reach * sc + slack && (x.maxDy <= 0 || dy <= x.maxDy + slack);
  }

  private updateCeilingAttack(dt: number, env: ActorEnv): boolean {
    const a = this.a, x = this.ceilAttack!;
    a.state = 'attack';
    const tp = this.target(env);
    if (tp) turnToward(a, yawTo(a.position, tp), TURN * 0.6, dt);
    const ev = this.clip >= 0 ? a.kind.events[this.clip] : undefined;
    const times = ev?.hitTimes ?? [];
    const now = this.clipTime();
    while (this.hits < times.length && now >= times[this.hits]) {
      this.hits++;
      // The slash lands on the target, the player or a character (KillMelee's target).
      const ft = fightTarget(a, env);
      if (ft && this.inReach(x, ft.pos, 0.6)) {
        if (ft.player) this.rt.hurtPlayer(x.damage, a, env);
        else this.rt.hurtActor(ft.actor, x.damage, a);
        this.rt.log(a, `ceiling slash ${x.damage.toFixed(1)}${ft.player ? '' : ` on ${ft.actor.ch.root.name}`}`);
      }
    }
    if (a.clipDone || this.t > Math.max(0.5, this.clipLen()) + 0.3) {
      // KillMelee: the next attack waits p2..p3 (the ceiling variant) [verified].
      this.attackDelay = rand(this.km.attackPause[0], this.km.attackPause[1]);
      this.set('ceiling');
    }
    return this.keep();
  }

  private keep(): boolean {
    this.a.sync();
    return true;
  }

  /** Crawl over the ceiling: along the ceiling nodes to the transition down, else toward the target. */
  private crawlToward(dt: number, env: ActorEnv, tp: THREE.Vector3Like) {
    const a = this.a, nav = env.nav;
    if (this.routeTimer <= 0) {
      this.routeTimer = 0.6 + Math.random() * 0.3;
      this.route = [];
      this.routeDown = -1;
      if (nav?.hasCeiling) {
        const from = nav.nearest(a.position.x, a.position.y, a.position.z, env.world, 6, 0, 'ceiling');
        const to = nav.nearest(tp.x, tp.y, tp.z, env.world);
        const blocked = env.navBlocked ? (i: number, j: number) => env.navBlocked!(i, j, a) : undefined;
        const path = from >= 0 && to >= 0 && flat(nav.nodes[from], a.position) < 12 ? nav.path(from, to, blocked, { crawler: true }) : null;
        if (path) {
          // The ceiling stretch, up to its first way down.
          let k = 0;
          while (k + 1 < path.length && nav.edgeType(path[k], path[k + 1]) === EDGE.ceiling) k++;
          if (k + 1 < path.length && nav.edgeType(path[k], path[k + 1]) === EDGE.down) {
            this.route = path.slice(0, k + 1);
            this.routeDown = path[k + 1];
            // Already on the leg to the second node: do not crawl back to the first.
            if (this.route.length > 1) {
              const n0 = nav.nodes[this.route[0]], n1 = nav.nodes[this.route[1]];
              if (flat(n1, a.position) < flat(n1, n0)) this.route.shift();
            }
          }
        }
      }
    }
    if (nav && this.route.length) {
      // Drop reached nodes; the last ceiling node leads to the transition point.
      while (this.route.length > 1 && flat(nav.nodes[this.route[0]], a.position) < Math.max(0.6, Math.min(nav.nodes[this.route[0]].radius, 1.2))) this.route.shift();
      const last = this.route.length === 1;
      const goal = last ? nav.transitionPoint(this.route[0], this.routeDown) : nav.nodes[this.route[0]];
      if (last && Math.hypot(goal.x - a.position.x, goal.z - a.position.z) < 0.5) {
        this.route = [];
        this.startDown(env, 'path leads down');
        return;
      }
      this.crawl(dt, env, goal.x - a.position.x, goal.z - a.position.z, true);
      return;
    }
    // No ceiling route: close in over the target and let go within reach (port).
    const d = flat(a.position, tp);
    if (d < DROP_RANGE && a.targetInSight) {
      this.startDown(env, `no ceiling route, target ${d.toFixed(1)} m`);
      return;
    }
    if (!this.crawl(dt, env, tp.x - a.position.x, tp.z - a.position.z, true) && d < DROP_RANGE * 1.6) this.startDown(env, 'blocked on the ceiling');
  }

  /** One crawl step on the ceiling toward (dx, dz). False when the way is blocked. */
  private crawl(dt: number, env: ActorEnv, dx: number, dz: number, fast: boolean): boolean {
    const a = this.a, g = this.ceilGait;
    const err = turnToward(a, Math.atan2(-dx, -dz), TURN, dt);
    if (Math.abs(err) > 1.0) {
      // Turning in place: the ceiling turn clips.
      if (g) a.playClip(err > 0 ? (g.turnL >= 0 ? g.turnL : g.idle) : g.turnR >= 0 ? g.turnR : g.idle, true);
      return true;
    }
    const clip = g ? (fast && g.run >= 0 ? g.run : g.walk) : -1;
    const natural = clip >= 0 ? a.kind.speeds[clip] || 2.5 : 2.5;
    const speed = Math.min(fast ? 6.5 : 2.5, natural) * Math.max(0, Math.cos(err));
    if (clip >= 0) {
      const act = a.playClip(clip, true);
      if (act) act.timeScale = Math.max(0.5, Math.min(1.6, speed / natural)) * (a.ch.clipData[clip]?.rate || 1);
    }
    const step = speed * dt;
    if (step < 1e-4) return true;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const p = a.motor.position;
    // Walls: a sphere swept at the body's middle under the ceiling.
    const r = Math.min(0.4, a.radius);
    const hit = env.world.sphereCast(p.x, p.y - 0.5 * a.scale, p.z, r, fx, 0, fz, step + 0.05);
    if (hit && hit.distance < step) {
      this.stuck += dt;
      return this.stuck < 0.6;
    }
    const nx = p.x + fx * step, nz = p.z + fz * step;
    const cy = this.ceilingAt(env, nx, p.y, nz);
    if (cy === null || Math.abs(cy - p.y) > CEIL_STEP) {
      this.stuck += dt;
      return this.stuck < 0.6;
    }
    this.stuck = 0;
    this.stats.crawled += step;
    p.x = nx;
    p.z = nz;
    p.y = cy;
    return true;
  }

  private ceilingWaypoints(dt: number, env: ActorEnv, b: Extract<Behavior, { kind: 'waypoint' }>): boolean {
    const a = this.a;
    const uid = this.wp || b.first;
    const wp = env.entity(uid);
    if (!wp || wp.className !== 'Waypoint') return this.keep();
    const x = wp.position[0] / 2048, z = wp.position[2] / 2048;
    if (Math.hypot(x - a.position.x, z - a.position.z) < 0.6) {
      const msg = num(wp.values[0], 0);
      const next = wp.links.find((u) => env.entity(u)?.className === 'Waypoint');
      if (msg) for (const u of wp.links) if (u !== next) env.send(u, msg, wp.uid);
      this.wp = next ?? 0;
      if (!next) {
        this.wp = 0;
        const n = b.next.length ? env.behaviors?.fromPlaced(b.next[0]) : undefined;
        a.setBehavior(n ?? (a.profile.active?.kind === 'dormant' ? undefined : a.profile.active), env, !!n);
      }
      return this.keep();
    }
    a.state = 'move';
    this.crawl(dt, env, x - a.position.x, z - a.position.z, num(wp.values[1], 0) === 1);
    return this.keep();
  }

  private wp = 0;

  // --- death ---------------------------------------------------------------------------

  /** Killed on a ceiling: p177 (falls off, loop, landing) [verified slot]; else the generic death. */
  private deadUpdate(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    // A body off the ceiling crawls no more. (A restored body of a p180 ceiling starter: the
    // constructor hung it as a crawler, and the dead keep no special state in a save.)
    if (a.crawler && !a.ceiling && this.mode !== 'deathFall') a.crawler = false;
    if (this.mode === 'deathFall') {
      this.t += dt;
      switch (this.phase) {
        case 'drop':
          if (a.clipDone || this.t > 2.5) {
            const [, ry] = this.rootAt(this.clip, a.ch.clipData[this.clip]?.duration ?? 0);
            a.motor.position.y += ry;
            a.occlusionTimer = 0;
            a.motor.onGround = false;
            a.motor.velocity.y = 0;
            this.phase = 'fall';
            this.t = 0;
            this.play(this.p.ceilingDeath?.fall, true);
          }
          break;
        case 'fall':
          a.motor.step(dt, { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false });
          if (a.motor.onGround || this.t > 5) {
            this.phase = 'land';
            this.t = 0;
            if (!this.play(this.p.ceilingDeath?.land, false)) this.t = 99;
            this.rt.log(a, 'falls dead from the ceiling');
          }
          break;
        case 'land':
          if (a.clipDone || this.t > 3) {
            this.mode = null;
            this.phase = '';
            a.sync(false);
            return false;
          }
          break;
      }
      a.sync(false);
      return true;
    }
    if (this.surface === 'ceiling' && a.ceiling) {
      this.surface = 'floor';
      a.ceiling = false;
      a.crawler = false;
      a.gaitClips = undefined;
      this.mode = 'deathFall';
      this.phase = 'drop';
      this.t = 0;
      if (!this.play(this.p.ceilingDeath?.clips[0], false)) {
        // No clip: drop the body to where it hung.
        a.motor.position.y += a.bottom - a.position.y;
        this.phase = 'fall';
      }
      this.rt.log(a, 'killed on the ceiling');
      return true;
    }
    return false;
  }

  /** Resurrection: back on its feet with p160 % health, rise clip, then the active behaviour. */
  rise(env: ActorEnv): boolean {
    const a = this.a;
    if (a.alive) return false;
    const pct = num(a.entity?.values[160], 100);
    a.health = Math.max(1, (a.maxHealth * pct) / 100);
    a.state = 'act';
    a.hostile = true;
    a.provoked = true;
    const act = a.profile.active;
    a.setBehavior(act && act.kind !== 'death' && act.kind !== 'dormant' ? act : { cls: 'HostilityBehavior', kind: 'hostile', next: [] }, env);
    a.state = 'act';
    a.sync();
    const i = env.clip(a, this.corpse?.rise);
    if (i >= 0) a.playClip(i, false);
    this.rising = i >= 0 ? 0.001 : 0;
    this.raised++;
    this.rt.log(a, 'raised from the dead');
    return true;
  }

  dispose() {
    this.head?.dispose();
    this.a.gaitClips = undefined;
    this.a.meleePause = undefined;
    this.a.reactGate = undefined;
  }
}

function refsOf(v: unknown): ClipRef[] {
  return (Array.isArray(v) ? v : [v]).flatMap((x) => (x && typeof x === 'object' ? [{ pkg: (x as ClipRef).pkg, id: (x as ClipRef).id }] : []));
}

function transitionOf(v: readonly unknown[]) {
  const r = (x: unknown) => (x && typeof x === 'object' ? { pkg: (x as ClipRef).pkg, id: (x as ClipRef).id } : undefined);
  const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return { letGo: r(v[2]), fall: r(v[3]), land: r(v[4]), launch: r(v[5]), rise: r(v[6]), grab: r(v[7]), upSpeed: n(v[8], 15), gravity: n(v[9], 1), downSpeed: n(v[10], 0), hold: n(v[11], 0) };
}

export { COND, wrapAngle };
export const createCartWheeler = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => new CartWheeler(a, rt);
