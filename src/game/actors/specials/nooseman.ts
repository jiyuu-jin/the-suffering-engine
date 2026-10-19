// Nooseman: drop-and-strangle attack (docs §15.7.1). Decoded from Suffering.rfl:
// NooseManKillObjectBehavior 0x10082560 / 0x100820a0 / 0x10084a50, NoosemanGrabAttackBehavior
// 0x10084c30 / 0x10082c60 / 0x10082e60, NoosemanGrabAttackGrappleBehavior 0x100833c0 /
// 0x10083a20 / 0x100841a0, rope setter 0x10081650, drop-position groups 0x10084ed0..0x10085280.
//
// The Nooseman is hidden between attacks (init hides it) and never climbs: for each attack it
// picks a free Drop Position of its group within 0.5 m of where the player will be when the
// rope reaches him, teleports there unseen (x / z of that point, y of the position), shows
// itself, drops on its rope at p2 m/s, bounces on waveform p3, and grabs the player when its low
// bone p175 comes within p3 (0.8 m) vertically / p2 (1 m) horizontally of his feet + p186.
// The grapple lifts the player at p6 m/s for up to p8 s while a strangle meter fills (1 / s up
// to p7); past the grace p5 it costs p9..p10 HP / s and darkens the view (Screen Fader p15, up
// to p16 %); every struggle press takes the Player p316 (1 s) off the meter and an empty meter
// breaks free. Then it reels up (p8 clip, p6 m/s, p9 loop), hides and waits p4 (after a hold) or
// p5 (after a miss / escape) before the next try (0.3 s between failed searches).
// Port: the rope is stretched by moving the rope bones (2..p181) along their length; struggle
// presses are Fire / Throw / Jump / Use presses (PlayerHold: the decoded Mainliner ride input,
// assumed the same here).
//
// Characters: the KillObject drops on its KillEnemies target, the player or a character. On a
// character the grapple (start 0x100833c0's non-player branch) plays his p144 / p145 clip, sends
// him a token hit (1e-4, type p17: the attack stimulus) and holds him p18 (3) s with no meter
// and no struggle (update 0x10083a20: the timer [+0x34]); its end (0x100841a0 0x100843db..) deals
// him p19 (30), type p17 [verified]. Port: the target comes from the generic perception
// (Actor.sense) while hidden, the player when it has none; the victim keeps his own AI and is not
// lifted [port].

import * as THREE from 'three/webgpu';
import { readWaveform, waveformAt, type Waveform } from '../../../formats/model';
import { toOutputSpace } from '../../../formats/level';
import type { Actor, ActorEnv } from '../actor';
import { clearLine } from '../nav';
import type { ClipRef } from '../clipmap';
import { PlayerHold } from './hold';
import { fightTarget, noosemanParams, PLAYER_GRAPPLE, type NoosemanParams } from './params';
import { flat, yawTo, type SpecialMove, type SpecialRuntime } from './runtime';
import { ScreenTint } from './screen';

type State = 'hidden' | 'appear' | 'drop' | 'bounce' | 'grapple' | 'grappleNpc' | 'release' | 'kill' | 'reelStart' | 'reel' | 'dead';

interface DropPos {
  uid: number;
  x: number;
  y: number;
  z: number;
  busy: boolean;
}

/** Drop Position groups (links made two-way, connected components) per runtime. */
const groups = new WeakMap<SpecialRuntime, Map<number, DropPos[]>>();
function groupOf(rt: SpecialRuntime, uid: number): DropPos[] {
  let g = groups.get(rt);
  if (!g) {
    g = new Map();
    groups.set(rt, g);
    const all = rt.entities.filter((e) => e.className === 'Nooseman Drop Position');
    const nodes = new Map<number, DropPos>();
    for (const e of all) {
      const [x, y, z] = toOutputSpace(e.position);
      nodes.set(e.uid, { uid: e.uid, x, y, z, busy: false });
    }
    const adj = new Map<number, Set<number>>();
    for (const e of all) for (const l of e.links) if (nodes.has(l)) {
      (adj.get(e.uid) ?? adj.set(e.uid, new Set()).get(e.uid)!).add(l);
      (adj.get(l) ?? adj.set(l, new Set()).get(l)!).add(e.uid);
    }
    const seen = new Set<number>();
    for (const u of nodes.keys()) {
      if (seen.has(u)) continue;
      const comp: DropPos[] = [];
      const stack = [u];
      seen.add(u);
      while (stack.length) {
        const v = stack.pop()!;
        comp.push(nodes.get(v)!);
        for (const w of adj.get(v) ?? []) if (!seen.has(w)) seen.add(w), stack.push(w);
      }
      for (const p of comp) g.set(p.uid, comp);
    }
  }
  return g.get(uid) ?? [];
}

class Nooseman implements SpecialMove {
  readonly name = 'nooseman';
  st: State = 'hidden';
  private p: NoosemanParams;
  private rope: number;
  private target = 0;
  private t = 0;
  private cooldown = 0.5;
  private pos?: DropPos;
  private wave?: Waveform;
  private hold: PlayerHold;
  private side = 0;
  private meter = 0;
  private holdLeft = 0;
  private faded = false;
  private presses = 0;
  private result = 2;
  private grabFeet = new THREE.Vector3();
  private grabRope = 0;
  private dealt = 0;
  private grabs = 0;
  /** The character this attack goes for (null: the player), and the one held. */
  private victim: Actor | null = null;
  private held: Actor | null = null;
  private npcGrabs = 0;
  private attempts = 0;
  private escapes = 0;
  private ropeBase: { bone: THREE.Bone; x: number }[] = [];
  private tint: ScreenTint;
  private fall = { v: 0, left: 0, done: false };
  private group: DropPos[];

  constructor(
    readonly a: Actor,
    readonly rt: SpecialRuntime,
  ) {
    this.p = noosemanParams(rt.pkgs, a.entity?.values ?? []);
    this.rope = this.p.ropeStart;
    this.wave = this.p.bounce ? readWaveform(rt.ctx.loaded.packages!, this.p.bounce) : undefined;
    this.hold = new PlayerHold(rt, a);
    this.tint = new ScreenTint(rt.ctx);
    this.group = this.p.drops ? groupOf(rt, this.p.drops) : [];
    // Rope bones: every bone from the rope root's child down to the body-attach bone p181
    // carries one segment along its local x (5 x 0.88 m = the native p182 length).
    const bones = a.ch.skeleton.bones;
    for (let i = this.p.bodyBone; i > this.p.ropeBone + 1 && bones[i]; i--) this.ropeBase.push({ bone: bones[i], x: bones[i].position.x });
    // The rope length is applied after the mixer posed the skeleton.
    const update = a.ch.update.bind(a.ch);
    a.ch.update = (dt: number) => {
      update(dt);
      this.applyRope();
    };
    // Init hides it until its first drop [verified 0x10081b40].
    a.dormantHidden = true;
    a.ceiling = false;
  }

  info() {
    return { nm: this.st, rope: +this.rope.toFixed(2), meter: +this.meter.toFixed(2), dealt: +this.dealt.toFixed(1), grabs: this.grabs, npcGrabs: this.npcGrabs, attempts: this.attempts, escapes: this.escapes, held: this.hold.active, pos: this.pos?.uid.toString(16) };
  }

  private applyRope() {
    const s = Math.max(0.001, this.rope / this.p.ropeNative);
    const k = this.st === 'dead' ? 1 : s;
    for (const r of this.ropeBase) r.bone.position.x = r.x * k;
  }

  private play(c: ClipRef | undefined, loop: boolean) {
    const env = this.rt.manager.env;
    const i = env ? env.clip(this.a, c) : -1;
    if (i >= 0) this.a.playClip(i, loop);
    return i >= 0;
  }

  private bone(i: number) {
    const b = this.a.ch.skeleton.bones[i];
    const v = new THREE.Vector3();
    if (!b) return v.set(this.a.position.x, this.a.bottom, this.a.position.z);
    b.updateWorldMatrix(true, false);
    return b.getWorldPosition(v);
  }

  /** Vertical extent of the body: bone p181 (rope end) above bone p175 (low point). */
  private bodyLength() {
    const d = this.bone(this.p.bodyBone).y - this.bone(this.p.lowBone).y;
    return d > 0.001 ? d : 1.8;
  }

  /** Awake: its DormantBehavior (p68) ended - woken by its p12 message (On); nothing wakes it by
   *  sight and p6 = 0 means hits do not either [verified 0x100ecdf0, decoded with the AI work]. */
  private get active() {
    return this.a.behavior?.kind !== 'dormant';
  }

  // --- attack search (KillObject update 0x10084a50) -----------------------------------

  private tryAttack(env: ActorEnv): boolean {
    const a = this.a, o = this.victim;
    const p = o ? o.position : env.player.position, v = o ? o.motor.velocity : env.player.motor.velocity;
    const body = this.bodyLength();
    const lead = Math.max(0, a.position.y - p.y) / this.p.dropSpeed + this.p.showDelay;
    const px = p.x + v.x * lead, pz = p.z + v.z * lead;
    const reach = 0.5 / Math.max(0.01, a.scale);
    for (const d of this.group) {
      if (d.busy || Math.hypot(d.x - px, d.z - pz) > reach) continue;
      if (Math.abs(d.y - p.y) > this.p.maxDrop + this.p.clearance + body || d.y < p.y) continue;
      if (!clearLine(env.world, d.x, d.y - 0.5, d.z, px, p.y + 1, pz)) continue;
      return this.start(d, px, pz, body, env);
    }
    return false;
  }

  /** GrabAttack start (0x10084c30): teleport unseen above the lead point, measure the drop. */
  private start(d: DropPos, x: number, z: number, body: number, env: ActorEnv): boolean {
    const a = this.a, p = this.victim ? this.victim.position : env.player.position;
    const L = d.y - p.y - body - this.p.clearance;
    if (L > this.p.maxDrop) return false;
    this.attempts++;
    d.busy = true;
    this.pos = d;
    this.target = L;
    a.motor.position.x = x;
    a.motor.position.y = d.y;
    a.motor.position.z = z;
    a.yaw = yawTo(a.position, p);
    a.sync();
    this.rope = 0;
    this.rt.effect(this.p.appearFx, { x, y: d.y, z });
    this.st = 'appear';
    this.t = 0;
    this.rt.log(a, `drops at #${d.uid.toString(16)} (rope ${L.toFixed(2)} m)`);
    return true;
  }

  // --- per frame ----------------------------------------------------------------------

  update(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (!a.alive) return this.dead(dt, env);
    this.t += dt;
    if (this.st !== 'hidden') a.state = 'attack';
    switch (this.st) {
      case 'hidden':
        a.dormantHidden = true;
        a.state = 'idle';
        this.cooldown -= dt;
        if (this.active) a.sense(dt, env);
        if (this.cooldown > 0 || !this.active) break;
        {
          // Its KillEnemies' pick: a character, else the player (the port's default).
          const ft = fightTarget(a, env);
          this.victim = ft && !ft.player ? ft.actor : null;
        }
        if (!this.victim && (!env.playerAlive || this.rt.holder)) break;
        if (flat(this.victim ? this.victim.position : env.player.position, a.position) > 40) {
          this.cooldown = 1;
          break;
        }
        if (!this.tryAttack(env)) this.cooldown = 0.3;
        break;
      case 'appear':
        if (this.t < this.p.showDelay) break;
        a.dormantHidden = false;
        this.rt.sound(this.p.dropSounds, a.position);
        this.play(this.p.dropClip, true);
        this.st = 'drop';
        this.t = 0;
        break;
      case 'drop':
        this.rope = Math.min(this.target, this.rope + this.p.dropSpeed * dt);
        a.yaw = yawTo(a.position, this.victim?.alive ? this.victim.position : env.player.position);
        if (this.rope >= this.target) {
          this.play(this.p.landClip, false);
          this.st = 'bounce';
          this.t = 0;
        }
        this.tryGrab(env);
        break;
      case 'bounce': {
        const w = this.wave;
        this.rope = this.target + (w && this.t < w.duration ? waveformAt(w, this.t, 0) : 0);
        if (this.tryGrab(env)) break;
        if (this.t >= Math.max(w?.duration ?? 0, 0.5) && a.clipDone) this.retract(2);
        break;
      }
      case 'grapple':
        this.grapple(dt, env);
        break;
      case 'grappleNpc':
        this.grappleNpc(dt);
        break;
      case 'release':
        if (a.clipDone || this.t > 1.5) this.retract(2);
        break;
      case 'kill':
        // The player is dead: the Nooseman keeps him (never ends) until the game reloads.
        if (this.rt.playerAlive) {
          this.endHold();
          this.retract(1);
        }
        break;
      case 'reelStart':
        if (a.clipDone || this.t > 2) {
          this.play(this.p.reelClip, true);
          this.st = 'reel';
          this.t = 0;
        }
        break;
      case 'reel':
        this.rope -= this.p.reelSpeed * dt;
        if (this.rope <= 0) this.vanish();
        break;
    }
    a.sync();
    return true;
  }

  /** Grab test (state 1, 0x10081430): low bone near the victim's feet. */
  private tryGrab(env: ActorEnv): boolean {
    if (this.victim) return this.tryGrabNpc(this.victim);
    if (!env.playerAlive || this.rt.holder) return false;
    const b = this.bone(this.p.lowBone), p = env.player.position;
    if (Math.abs(b.y - (p.y + this.p.clearance)) > this.p.grabHeight || Math.hypot(b.x - p.x, b.z - p.z) > this.p.grabRadius) return false;
    if (!this.hold.start(() => this.feet())) return false;
    const a = this.a;
    // Behind the victim when both face the same way [verified 0x10083437].
    const f = { x: -Math.sin(a.yaw), z: -Math.cos(a.yaw) }, g = { x: -Math.sin(env.player.yaw), z: -Math.cos(env.player.yaw) };
    this.side = f.x * g.x + f.z * g.z >= 0 ? 1 : 0;
    this.grabFeet.set(p.x, p.y, p.z);
    this.grabRope = this.rope;
    this.meter = 0;
    this.holdLeft = this.p.grapple.hold;
    this.faded = false;
    this.presses = 0;
    this.grabs++;
    this.st = 'grapple';
    this.t = 0;
    this.play(this.p.grapple.loop[this.side], true);
    this.rt.playerBody?.play(PLAYER_GRAPPLE.loop[this.side], { loop: true, lock: true });
    this.rt.log(a, `grabs the player (${this.side ? 'back' : 'front'})`);
    return true;
  }

  /** The grab test on a character, and the grapple's non-player start (0x100833c0). */
  private tryGrabNpc(o: Actor): boolean {
    if (!o.alive || o.hidden) return false;
    const b = this.bone(this.p.lowBone), p = o.position;
    if (Math.abs(b.y - (p.y + this.p.clearance)) > this.p.grabHeight || Math.hypot(b.x - p.x, b.z - p.z) > this.p.grabRadius) return false;
    const a = this.a;
    const f = { x: -Math.sin(a.yaw), z: -Math.cos(a.yaw) }, g = { x: -Math.sin(o.yaw), z: -Math.cos(o.yaw) };
    this.side = f.x * g.x + f.z * g.z >= 0 ? 1 : 0;
    this.held = o;
    this.holdLeft = this.p.grapple.npcHold;
    this.grabs++;
    this.npcGrabs++;
    this.st = 'grappleNpc';
    this.t = 0;
    this.play(this.p.grapple.loop[this.side], true);
    // The token hit: the attack stimulus (1e-4 damage).
    this.rt.hurtActor(o, 1e-4, a);
    this.rt.log(a, `grabs ${o.ch.root.name} (${this.side ? 'back' : 'front'})`);
    return true;
  }

  /** Holding a character: p18 s, then the end deals p19. */
  private grappleNpc(dt: number) {
    this.holdLeft -= dt;
    if (this.holdLeft > 0 && this.held?.alive) return;
    this.letGoNpc();
    this.retract(1);
  }

  /** The grapple's end on a character (0x100843db): p19 damage. */
  private letGoNpc() {
    const o = this.held;
    this.held = null;
    if (!o?.alive) return;
    const dmg = this.p.grapple.npcDamage;
    this.dealt += dmg;
    this.rt.hurtActor(o, dmg, this.a);
    this.rt.log(this.a, `lets ${o.ch.root.name} go: ${dmg}`);
  }

  /** The held player's feet: lifted with the body as the rope shortens. */
  private feet() {
    return { x: this.grabFeet.x, y: this.grabFeet.y + (this.grabRope - this.rope), z: this.grabFeet.z };
  }

  /** Grapple update (0x10083a20). */
  private grapple(dt: number, env: ActorEnv) {
    const g = this.p.grapple;
    this.rope = Math.max(0, this.rope - g.lift * dt);
    if (!this.rt.playerAlive) {
      this.st = 'kill';
      this.play(g.kill[this.side], false);
      this.rt.playerBody?.play(PLAYER_GRAPPLE.death[this.side], { lock: true });
      this.rt.log(this.a, 'strangled the player');
      return;
    }
    this.meter = Math.min(this.meter + dt, g.meterMax);
    this.holdLeft -= dt;
    if (this.holdLeft <= 0) {
      this.rt.log(this.a, 'lets go after the full hold');
      this.endHold();
      return this.retract(1);
    }
    if (this.meter <= g.grace) return;
    if (!this.faded) this.faded = true;
    const pressed = this.hold.presses - this.presses;
    this.presses = this.hold.presses;
    this.meter -= pressed * PLAYER_GRAPPLE.press;
    if (this.meter <= 0) {
      this.escapes++;
      this.rt.log(this.a, `player breaks free (${this.hold.presses} presses)`);
      this.endHold();
      this.play(g.release[this.side], false);
      this.rt.playerBody?.play(PLAYER_GRAPPLE.escape[this.side], {});
      this.st = 'release';
      this.t = 0;
      return;
    }
    const k = Math.max(0, Math.min(1, (this.meter - g.grace) / Math.max(1e-3, g.meterMax - g.grace)));
    const dmg = (g.dps[0] + (g.dps[1] - g.dps[0]) * k) * dt;
    this.dealt += dmg;
    this.rt.hurtPlayer(dmg, this.a, env);
    this.tint.set((g.darken / 100) * Math.max(0.15, k));
  }

  private endHold() {
    this.hold.release();
    this.tint.set(0);
    this.rt.playerBody?.release(0.2);
  }

  /** GrabAttack retract (0x10082e60): reel-up clip, then reel up and hide. */
  private retract(result: number) {
    this.result = result;
    this.st = 'reelStart';
    this.t = 0;
    if (!this.play(this.p.reelStartClip, false)) {
      this.play(this.p.reelClip, true);
      this.st = 'reel';
    }
  }

  private vanish() {
    const a = this.a;
    this.rope = 0;
    this.rt.effect(this.p.vanishFx, a.position);
    this.rt.sound(this.p.vanishSounds, a.position);
    a.dormantHidden = true;
    a.state = 'idle';
    if (this.pos) this.pos.busy = false;
    this.pos = undefined;
    this.st = 'hidden';
    this.cooldown = this.result === 1 ? this.p.cooldownHit : this.p.cooldownMiss;
    this.rt.log(a, `hides (cooldown ${this.cooldown} s)`);
  }

  /** Dead: the rope lets go and the body drops to the floor below its low bone (0x10081860). */
  private dead(dt: number, env: ActorEnv): boolean {
    const a = this.a;
    if (this.st !== 'dead') {
      if (this.hold.active) this.endHold();
      // A held character: the grapple's end runs and deals p19 [inferred: the end on any exit].
      if (this.st === 'grappleNpc') this.letGoNpc();
      if (this.pos) this.pos.busy = false;
      const b = this.bone(this.p.lowBone);
      this.st = 'dead';
      const hit = env.world.raycast(b.x, b.y + 0.2, b.z, 0, -1, 0, 40);
      this.fall = { v: 0, left: hit ? Math.max(0, hit.distance - 0.2) : 0, done: false };
      this.rt.log(a, `dies; the body falls ${this.fall.left.toFixed(2)} m`);
    }
    if (!this.fall.done) {
      this.fall.v += 9.8 * dt;
      const s = Math.min(this.fall.left, this.fall.v * dt);
      this.fall.left -= s;
      a.motor.position.y -= s;
      if (this.fall.left <= 0) this.fall.done = true;
      a.sync();
    }
    return true;
  }

  died() {
    return false;
  }

  dispose() {
    if (this.hold.active) this.endHold();
    this.tint.dispose();
  }
}

export const createNooseman = (a: Actor, rt: SpecialRuntime): SpecialMove | undefined => (a.entity || a.spawned ? new Nooseman(a, rt) : undefined);
