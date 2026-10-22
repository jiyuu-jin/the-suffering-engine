// Level-logic classes that drive actors (docs/game-logic.md §15):
//
//   Behavior Changer      hands root behaviours / sub-behaviours to the characters it links to
//   Object Cloner         chapter 1's creature spawner: copies template characters (p5)
//   Speech Player         a linked character says one of its lines (subtitle + lip-sync)
//   Action Dialog         situational barks of the NPC it is attached to
//   Damage Action Object  damage (and an electric arc) to the trigger's sender or its links
//   (Reputation Points Sender belongs to the insanity system: src/game/insanity/classes.ts)
//   Nooseman Drop Position     where Noosemen hang and re-appear (Nooseman p185)
//   Ambient Creature           scurrying vermin running along Ambient Creature Waypoints
//   EdgeToggler                switches one Move Node edge on / off (nav.ts setEdge)
//   Aim Controller             turns an Animating Static (caged CartWheelers) toward its targets
//   Companion Spawn Point      arrival point for followers (no follower exists in chapter 1)
//
// classes.ts lists every class this system handles and how faithfully. Save state: the
// Object Cloner counters / timers are the 'spawners' provider (spawnerState), the rest
// (Behavior Changer uses, edge switches) goes with 'actors.logic' (snapshot); the creatures
// themselves are saved and re-created by the 'actors' provider (save/providers.ts).
//
// The world system (src/game/world) owns the message dispatcher; this module listens to
// every delivered message (services.world.subscribe('*')) and acts on the ones addressed to
// the classes above, firing their outputs back through services.world.send.

import type { Entity, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet } from '../../formats/entities';
import { toOutputSpace } from '../../formats/level';
import type { ResRef } from '../../formats/model';
import type { Actor, ActorEnv } from './actor';
import type { ActorManager } from './manager';
import type { Behavior } from './behaviors';
import type { ActorFx } from './fx';
import type { Character } from '../../app/character';
import { linkTree, treeFromParents, type ArcEndpoints, type ArcHandle, type ArcTarget } from '../fx/electric-arc';
import { dialogHit, dialogKillPoints, dialogRepRules, newDialogRepState, type DialogRepState } from '../insanity/reputation';
import * as THREE from 'three/webgpu';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');
const uids = (v: PropValue | undefined): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && x > 0);
const rand = (a: number, b: number) => a + Math.random() * Math.max(0, b - a);
const key = (r: ResRef) => `${r.pkg}:${r.id}`;

export interface DirectorHooks {
  send(uid: number, message: number, from: number): void;
  /** Player feet (output space) and whether a point is on screen. */
  player(): { x: number; y: number; z: number };
  visibleToPlayer(p: { x: number; y: number; z: number }): boolean;
  playerUid: number;
  damagePlayer(amount: number): void;
  /** Play a dialog sound for a speaker (subtitles + lip-sync); returns its length (s). */
  speak(keys: string[], speaker: Actor | undefined, at: { x: number; y: number; z: number }): number;
  isDestroyed(uid: number): boolean;
  log(msg: string): void;
  /** A positional sound (one of `keys`); returns its length (s), 0 when none played. */
  sound?(keys: string[], at: { x: number; y: number; z: number }): number;
  /** Put an Electric Arc Effect on a target (services.fx.arcEffect, src/game/fx/electric-arc.ts). */
  arcEffect?(ref: ResRef, target: ArcTarget): ArcHandle | undefined;
  /** The player's third-person body (the bones an effect on the player crackles over). */
  playerBody?(): Character | undefined;
}

interface Cloner {
  e: Entity;
  active: boolean;
  remaining: number;
  timer: number;
  alive: { a: Actor; deadFor: number }[];
  next: number;
  done: boolean;
}

interface Changer {
  e: Entity;
  enabled: boolean;
  uses: number;
}

interface Speech {
  e: Entity;
  until: number;
  playing: boolean;
  /** p4 = 0: the next line in order. */
  index: number;
  /** p4 = 2: lines already played this round (bit per line). */
  used?: number;
  /** The speaker (actor uid) of the line playing; undefined after a restore. */
  speaker?: number;
  /** The line playing is the round's last (p9 at its end), the last of this On (no next line), destroy at its end. */
  last?: boolean;
  done?: boolean;
  destroy?: boolean;
}

/**
 * The Speech Player's line choice (Suffering.rfl 0x1012db10) [verified]: p4 = 0 the lines in
 * order, all of them on one On (`done` only at the last); 1 one random line; 2 one random line
 * not yet played this round. `last` = the round is complete (p9 at the end of the line; the
 * order starts again, the used set is cleared). `index` / `used` are the state after the pick.
 */
export function speechPick(mode: number, count: number, index: number, used: number, rnd = Math.random): { line: number; index: number; used: number; last: boolean; done: boolean } {
  if (mode === 0) {
    const line = Math.min(index, count - 1);
    const last = line >= count - 1;
    return { line, index: last ? 0 : line + 1, used, last, done: last };
  }
  if (mode === 2) {
    const free: number[] = [];
    for (let i = 0; i < count; i++) if (!(used & (1 << i))) free.push(i);
    const line = free.length ? free[Math.floor(rnd() * free.length)] : 0;
    const last = free.length <= 1;
    return { line, index, used: last ? 0 : used | (1 << line), last, done: true };
  }
  return { line: Math.floor(rnd() * count), index, used, last: false, done: true };
}

interface Ambient {
  a: Actor;
  running: boolean;
  wp: number;
  prev: number;
  wait: number;
  speed: number;
  gone: boolean;
  /** Seconds to the next p28 sound (p29..p30). */
  sound: number;
}

/**
 * Ambient Creature sound timer (0x100910f0) [verified]: every p29 + U(0, 1) x (p30 - p29) s one
 * of the p28 sounds plays at the creature, unless p31 or more ambient sounds (any creature's)
 * still play. Returns whether to play one now and resets `sound`.
 */
/**
 * A blow on an Ambient Creature (PhysicalObject damage vt +0x58 0x1009b490 -> GameObject damage)
 * [verified]: nothing while invulnerable (p3 / messages 90 / 91), hidden or already dead; else
 * health -= amount ('hurt': p15 fires) and at 0 'killed' (vt +0x90: p26 for the player's kill,
 * then the Breakable break, p21, destroyed).
 */
export function ambientBlow(c: { health: number; invulnerable: boolean; shown: boolean }, amount: number): 'none' | 'hurt' | 'killed' {
  if (c.invulnerable || !c.shown || !(c.health > 0) || !(amount > 0)) return 'none';
  c.health -= amount;
  return c.health > 0 ? 'hurt' : 'killed';
}

export function ambientSoundDue(am: { sound: number }, v: readonly PropValue[], dt: number, playing: number, rnd = Math.random): boolean {
  am.sound -= dt;
  if (am.sound > 0) return false;
  am.sound = num(v[29], 3) + rnd() * (num(v[30], 7) - num(v[29], 3));
  return refs(v[28]).length > 0 && playing < num(v[31], 1);
}

interface ActionDialog {
  e: Entity;
  npc?: number;
  muted: boolean;
  next: number;
  /** Its count of the player's hits and whether its p22 reputation is paid (reputation.ts). */
  rep: DialogRepState;
  /** Game time its NPC's AttackedByPlayer warning ends (hits are not counted before). */
  warnUntil?: number;
}

export class Director {
  private changers = new Map<number, Changer>();
  private changerUids: number[] = [];
  private cloners = new Map<number, Cloner>();
  private clonerUids: number[] = [];
  private speech = new Map<number, Speech>();
  private dialogs = new Map<number, ActionDialog>();
  private damageObjs = new Map<number, Entity>();
  /** Electric Arc Effects started on targets (the fx system runs them; tests / overlay). */
  readonly arcEffects: { at: number; effect: string; target: number; handle?: ArcHandle }[] = [];
  private drops = new Map<number, { x: number; y: number; z: number }[]>();
  private noosemen: { a: Actor; group: number; timer: number }[] = [];
  private ambient = new Map<number, Ambient>();
  /** Aim Controller uid -> state (yaw offset from the controlled object's placement). */
  private aimers = new Map<number, Aimer>();
  /** EdgeToggler uid -> its two Move Nodes and whether the edge is on. */
  private edges = new Map<number, { e: Entity; a: number; b: number; on: boolean }>();
  /** Running log of what the director did (tests / debug overlay). */
  readonly events: string[] = [];
  time = 0;

  constructor(
    private readonly entities: Entity[],
    private readonly byUid: Map<number, Entity>,
    private readonly pkgs: EntityPackageSet,
    private readonly manager: ActorManager,
    private readonly hooks: DirectorHooks,
    private readonly fx: ActorFx,
  ) {
    for (const e of entities) {
      const v = e.values;
      switch (e.className) {
        case 'Behavior Changer':
          this.changers.set(e.uid, { e, enabled: num(v[0], 1) !== 0, uses: num(v[2], 0) });
          this.changerUids.push(e.uid);
          break;
        case 'Object Cloner':
          this.cloners.set(e.uid, newCloner(e));
          this.clonerUids.push(e.uid);
          break;
        case 'Speech Player':
          this.speech.set(e.uid, { e, until: 0, playing: false, index: 0 });
          break;
        case 'Action Dialog':
          this.dialogs.set(e.uid, { e, muted: false, next: 0, rep: newDialogRepState() });
          break;
        case 'Damage Action Object':
          this.damageObjs.set(e.uid, e);
          break;
        case 'Aim Controller':
          this.aimers.set(e.uid, { e, on: num(v[0]) !== 0, offset: 0, vel: 0 });
          break;
        case 'EdgeToggler':
          // [verified] init needs two links (the edge's Move Nodes); p0 = 1 starts enabled.
          if (e.links.length >= 2) this.edges.set(e.uid, { e, a: e.links[0], b: e.links[1], on: true });
          break;
        case 'Nooseman Drop Position':
          // A group is a root position linking to the others (Nooseman p185 names the root).
          if (e.links.length) this.drops.set(e.uid, [e, ...e.links.map((u) => byUid.get(u)).filter((x): x is Entity => !!x)].map(pos));
          break;
      }
    }
    for (const t of this.edges.values()) this.setEdge(t, num(t.e.values[0]) !== 0);
    // Action Dialogs with p0 = 1 attach to their NPC at once [verified].
    for (const d of this.dialogs.values()) if (num(d.e.values[0]) === 1) this.attachDialog(d);
    for (const a of manager.actors) {
      if (a.entity?.className === 'Ambient Creature' && a.uid !== undefined) this.ambient.set(a.uid, this.newAmbient(a));
      const g = a.entity?.className === 'Nooseman' ? num(a.entity.values[185]) : 0;
      if (g && this.drops.has(g)) this.noosemen.push({ a, group: g, timer: 1 + Math.random() });
    }
  }

  note(s: string) {
    this.events.push(`${this.time.toFixed(1)} ${s}`);
    if (this.events.length > 200) this.events.splice(0, 50);
    this.hooks.log(s);
  }

  /** A level-logic message was delivered to `to` (from the world dispatcher). */
  message(msg: number, from: number, to: number, env: ActorEnv) {
    const bc = this.changers.get(to);
    if (bc) return this.changerInput(bc, msg, env);
    const cl = this.cloners.get(to);
    if (cl) return this.clonerInput(cl, msg, env);
    const sp = this.speech.get(to);
    if (sp) return this.speechInput(sp, msg);
    const ad = this.dialogs.get(to);
    if (ad) return this.dialogInput(ad, msg);
    const am = this.ambient.get(to);
    if (am) return this.ambientInput(am, msg);
    const da = this.damageObjs.get(to);
    if (da) return this.damageInput(da, msg, from, env);
    const et = this.edges.get(to);
    if (et) return this.edgeInput(et, msg);
    const ai = this.aimers.get(to);
    if (ai) return this.aimInput(ai, msg);
  }

  // --- Aim Controller ----------------------------------------------------------
  //
  // [verified: Suffering.rfl update 0x10090850, slew 0x1008eb60; docs §15.3, docs/re/animation.md
  // §9] p9 the controlled object (all six in 1a: caged CartWheeler Animating Statics), p10 / p11
  // pitch / yaw bones (-1 = the whole object), p14 default targets (the player). Yaw: limit p5
  // (>= 180 wraps), top speed p6, acceleration p7, deceleration p8 (90 / 90 / 90 / 90 here),
  // through a second-order slew (aimSlew). Pitch: p1..p4 (all 0 here: no pitch). p18 / p19 are
  // the acquire / lose cones (30 degrees), not turn rates. Inputs p27 On, p28 Off, p29 Destroy.
  // Off at start (p0 = 0; a Relay turns all six on). The port turns the object about its
  // vertical axis toward the nearest p14 target (the cone / spotting rules p18..p26 and the
  // p30 / p31 outputs are not modelled).

  private aimInput(a: Aimer, msg: number) {
    const v = a.e.values;
    if (msg === num(v[27], 1)) a.on = true;
    else if (msg === num(v[28], 2)) a.on = false;
    else if (msg === num(v[29], 12)) this.aimers.delete(a.e.uid);
  }

  private updateAimers(dt: number) {
    const p = this.hooks.player();
    for (const a of this.aimers.values()) {
      if (!a.on) continue;
      const v = a.e.values;
      const obj = this.manager.get(num(v[9]));
      if (!obj || !obj.alive) continue;
      const root = obj.ch.root;
      a.base ??= root.quaternion.clone();
      // Nearest target: the player, or a placed object / actor.
      let best: { x: number; z: number } | undefined, bd = Infinity;
      for (const u of uids(v[14])) {
        const t = u === this.hooks.playerUid ? p : this.manager.get(u)?.position ?? (this.byUid.get(u) ? pos(this.byUid.get(u)!) : undefined);
        if (!t) continue;
        const d = Math.hypot(t.x - root.position.x, t.z - root.position.z);
        if (d < bd) (bd = d), (best = t);
      }
      if (!best) continue;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(a.base);
      const baseYaw = Math.atan2(-fwd.x, -fwd.z);
      const want = Math.atan2(-(best.x - root.position.x), -(best.z - root.position.z));
      // Degrees, like the original: the wanted yaw relative to the placement.
      const D = 180 / Math.PI;
      let off = (want - baseYaw) * D;
      off -= Math.round(off / 360) * 360;
      const lim = num(v[5], 90);
      const wraps = lim >= 180;
      if (wraps) {
        // Shortest way round from the current yaw.
        off = a.offset + (((off - a.offset + 540) % 360) - 180);
      } else off = Math.max(-lim, Math.min(lim, off));
      const top = Math.abs(num(v[6], 90));
      const vel = Math.max(-top, Math.min(top, aimSlew(a.offset, off, a.vel, num(v[7], 90), num(v[8], 90), dt)));
      let yaw = a.offset + vel * dt;
      a.vel = vel;
      if (wraps) yaw = ((((yaw + 540) % 360) + 360) % 360) - 180;
      else if (Math.abs(yaw) > lim) {
        yaw = Math.sign(yaw) * lim;
        a.vel = 0;
      }
      if (Math.abs(yaw - a.offset) < 1e-6) continue;
      a.offset = yaw;
      root.quaternion.copy(a.base).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a.offset / D));
    }
  }

  // --- EdgeToggler -----------------------------------------------------------
  //
  // [verified: ctor 0x100a9b10, init 0x100a9ac0, handlers 0x100a9a30 / 0x100a9a50] The
  // toggler resolves the nav edge between its two linked Move Nodes at init (fewer than two
  // links is an error) and sets (p0 = 1) or clears (p0 = 0) the edge's flag 0x80, the flag
  // every edge is constructed with (0x100d8490), i.e. "usable"; both directions change
  // together (0x100d9660 / 0x100d96b0). Input p1 sets it, p2 clears it. 1a: a Breakable's
  // BlowUp (p1 = 11) opens the edge its debris blocked; Switches / Relays toggle others.

  private edgeInput(t: { e: Entity; a: number; b: number; on: boolean }, msg: number) {
    const v = t.e.values;
    if (num(v[1]) && msg === num(v[1])) this.setEdge(t, true);
    else if (num(v[2]) && msg === num(v[2])) this.setEdge(t, false);
  }

  private setEdge(t: { e: Entity; a: number; b: number; on: boolean }, on: boolean) {
    t.on = on;
    const ok = this.manager.nav?.setEdge(t.a, t.b, on);
    if (this.time > 0) this.note(`EdgeToggler#${t.e.uid.toString(16)} ${on ? 'enables' : 'disables'} ${t.a.toString(16)}-${t.b.toString(16)}${ok ? '' : ' (no such edge)'}`);
  }

  // --- Behavior Changer ------------------------------------------------------
  //
  // p0 enabled at start, p2 uses (0 = unlimited; decremented per change, disabled at 0)
  // [verified], p3 drop links to dead NPCs [verified: log string], p5 root behaviour
  // templates, p6 placed root behaviour, p7 / p8 sub-behaviour templates [data], inputs p11
  // change (default On), p12 Disable, p13 Enable, p14 Destroy, p15 Prefetch [verified map],
  // p17 message to the non-character links after a change [data].

  private changerInput(bc: Changer, msg: number, env: ActorEnv) {
    const v = bc.e.values;
    if (msg === num(v[13], 4)) bc.enabled = true;
    if (msg === num(v[12], 5)) bc.enabled = false;
    if (msg === num(v[14], 12)) {
      this.changers.delete(bc.e.uid);
      return;
    }
    if (msg !== num(v[11], 1) || !bc.enabled) return;
    this.applyChanger(bc, env);
  }

  private applyChanger(bc: Changer, env: ActorEnv) {
    const e = bc.e, v = e.values;
    const B = this.manager.behaviors;
    const root: Behavior | undefined = uids(v[6]).length ? B.fromPlaced(uids(v[6])[0]) : refs(v[5]).length ? B.fromTemplate(refs(v[5])[0]) : undefined;
    const subs = [...refs(v[7]), ...refs(v[8])];
    const targets: Actor[] = [];
    for (const u of e.links) {
      const a = this.manager.get(u);
      if (!a) continue;
      if (a.template) targets.push(...(this.manager.clones.get(u) ?? []));
      else targets.push(a);
    }
    // p17 goes to the non-character links once the handed-out chain completes [data: it
    // starts the next Behavior Changer / Timer of a scripted scene].
    const notify = this.chainNotify(bc);
    let notified = false;
    for (const a of targets) {
      if (!a.alive) continue;
      for (const s of subs) this.applySub(a, s);
      if (root) a.setBehavior(root, env);
      else a.wake();
      if (notify && root && !notified) {
        notified = true;
        a.onChainDone = notify;
        a.chainOf = e.uid;
      }
    }
    if (notify && !notified) notify();
    this.note(`BC#${e.uid.toString(16)} -> ${targets.map((a) => a.ch.root.name).join(', ') || 'nobody'}: ${root ? `${root.cls}${root.uid ? '#' + root.uid.toString(16) : ''}` : 'wake'}${subs.length ? ` +${subs.length} sub` : ''}`);
    if (bc.uses > 0 && --bc.uses === 0) bc.enabled = false;
  }

  /** The p17 message of a Behavior Changer to its non-character links (chain completed). */
  private chainNotify(bc: Changer): (() => void) | undefined {
    const e = bc.e;
    const out = num(e.values[17]);
    return out
      ? () => {
          this.note(`BC#${e.uid.toString(16)} chain done -> ${out}`);
          for (const u of e.links) if (!this.manager.get(u)) this.hooks.send(u, out, e.uid);
        }
      : undefined;
  }

  /** Sub-behaviour templates replace the character's own of the same class [data]. */
  private applySub(a: Actor, r: ResRef) {
    const t = readObjectTemplate(this.pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || !c) return;
    const v = decodeTemplateProps(c, t);
    const clip = (x: PropValue | undefined) => (x && typeof x === 'object' && !Array.isArray(x) ? { pkg: x.pkg, id: x.id } : undefined);
    switch (c.name) {
      case 'OpenDoorBehavior':
        a.profile.openDoor = { front: clip(v[2]), back: clip(v[3]) };
        break;
      case 'KillEnemiesBehavior': {
        const k = this.manager.behaviors.fromTemplate(r);
        if (k?.kind === 'kill') a.profile.kill = k;
        break;
      }
      case 'IdleBehavior': {
        const b = this.manager.behaviors.fromTemplate(r);
        if (b) a.profile.active = a.profile.active?.kind === 'idle' || !a.profile.active ? b : a.profile.active;
        break;
      }
    }
  }

  // --- Object Cloner ---------------------------------------------------------
  //
  // [verified from the class code] p0 start active, p1 total clones (0 = endless), p2 most
  // alive at once, p3..p4 seconds between clones (random), p5 template characters, p6 pick
  // order, p7..p8 player distance band (m) the spawn point must be in, p9 spawn point must be
  // off screen, p10 no other clone within this radius; inputs p11 On (start), p12 Off, p13
  // spawn now, p14 Destroy; outputs p15 per clone, p16 when the last clone is made, p17 when
  // every clone is dead (without p17 the cloner goes away after the last clone); p18 a
  // message for the new clone. A dead clone keeps its slot for p4 seconds. The clone copies
  // the template's links, and objects linking to the template also reach the clone.

  private clonerInput(cl: Cloner, msg: number, env: ActorEnv) {
    const v = cl.e.values;
    if (msg === num(v[11], 1)) cl.active = true;
    else if (msg === num(v[12], 2)) cl.active = false;
    else if (msg === num(v[13], 6)) this.cloneOne(cl, env);
    else if (msg === num(v[14], 12)) cl.done = true;
  }

  private cloneOne(cl: Cloner, env: ActorEnv) {
    const v = cl.e.values;
    cl.timer = rand(num(v[3]), num(v[4]));
    const maxAlive = num(v[2]);
    if (maxAlive > 0 && cl.alive.length >= maxAlive) return;
    const list = uids(v[5]);
    if (!list.length) return;
    const p = this.hooks.player();
    const minD = num(v[7]), maxD = num(v[8]), space = num(v[10]);
    const ok = (u: number) => {
      const t = this.manager.get(u);
      if (!t?.entity) return false;
      const q = t.position;
      const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      if (maxD > 0 && (d < minD || d > maxD)) return false;
      if (num(v[9]) && this.hooks.visibleToPlayer({ x: q.x, y: q.y + 1, z: q.z })) return false;
      if (space > 0 && this.manager.actors.some((o) => o.alive && !o.hidden && Math.hypot(o.position.x - q.x, o.position.z - q.z) < space)) return false;
      return true;
    };
    // p6: 0/1 random, 2 in order [guess on which is which].
    const mode = num(v[6]);
    let pick = -1;
    if (mode === 2) {
      for (let k = 0; k < list.length; k++) {
        const i = (cl.next + k) % list.length;
        if (ok(list[i])) {
          pick = i;
          break;
        }
      }
      if (pick >= 0) cl.next = pick + 1;
    } else {
      const good = list.map((u, i) => (ok(u) ? i : -1)).filter((i) => i >= 0);
      if (good.length) pick = good[Math.floor(Math.random() * good.length)];
    }
    if (pick < 0) {
      cl.timer = 0.25;
      return;
    }
    const a = this.manager.clone(list[pick]);
    if (!a) return;
    cl.alive.push({ a, deadFor: 0 });
    this.note(`Cloner#${cl.e.uid.toString(16)} -> ${a.ch.root.name} at ${a.position.x.toFixed(1)},${a.position.y.toFixed(1)},${a.position.z.toFixed(1)}`);
    const out = num(v[15]);
    if (out) for (const u of cl.e.links) this.hooks.send(u, out, cl.e.uid);
    if (num(v[18])) for (const u of a.entity?.links ?? []) this.hooks.send(u, num(v[18]), a.uid ?? 0);
    if (num(v[1]) > 0 && --cl.remaining <= 0) {
      const last = num(v[16]);
      if (last) for (const u of cl.e.links) this.hooks.send(u, last, cl.e.uid);
      if (!num(v[17])) cl.done = true;
    }
  }

  private updateCloner(cl: Cloner, dt: number, env: ActorEnv) {
    const v = cl.e.values;
    const hold = num(v[4]);
    cl.alive = cl.alive.filter((x) => {
      if (this.manager.actors.indexOf(x.a) < 0) return false;
      if (x.a.alive) return true;
      x.deadFor += dt;
      return x.deadFor < hold;
    });
    if (cl.done || !cl.active) return;
    if (num(v[1]) > 0 && cl.remaining <= 0) {
      if (!cl.alive.length) {
        const out = num(v[17]);
        if (out) for (const u of cl.e.links) this.hooks.send(u, out, cl.e.uid);
        cl.done = true;
      }
      return;
    }
    cl.timer -= dt;
    if (cl.timer <= 0) this.cloneOne(cl, env);
  }

  // --- Speech Player ---------------------------------------------------------
  //
  // [verified, Suffering.rfl: On 0x1008e510, start 0x1012d970, update 0x1012db10, line
  // 0x1012da40, end 0x1012d820] p0 who speaks (0 the sender, 1 the player, 2 every linked
  // object in turn: retail is always 2); only a character (object category 7) or the player
  // is taken, the last one wins; p5 the lines, p4 their order (speechPick), p8 to the links
  // after every line, p9 after the round's last, p6 = 1 destroy after the round's last, 2 after
  // any line; inputs p1 play (On), p2 Destroy, p7 Prefetch. p3 = 2 runs an extra step when the
  // speaker is busy (port: the speaker turns to the player [guess]).
  // A dead speaker says nothing (the character's speak 0x100e1b40 returns at once when
  // 0x100a1ad0 "is dead" holds) but the Speech Player goes on: the line counts as played and
  // ends at once, so p8 / p9 / p6 follow on the next update. A speaker removed from the world
  // stops the Speech Player without any output.

  private speechInput(sp: Speech, msg: number) {
    const v = sp.e.values;
    if (msg === num(v[2], 12)) {
      this.speech.delete(sp.e.uid);
      return;
    }
    if (msg !== num(v[1], 1) || sp.playing) return;
    if (!refs(v[5]).length) return;
    let speaker: Actor | undefined;
    for (const u of sp.e.links) {
      const a = this.manager.get(u);
      if (a && !a.template) speaker = a;
    }
    if (!speaker || speaker.uid === undefined) return;
    sp.speaker = speaker.uid;
    this.speakLine(sp, speaker);
  }

  private speakLine(sp: Speech, speaker: Actor) {
    const v = sp.e.values;
    const sounds = refs(v[5]).map(key);
    const pick = speechPick(num(v[4]), sounds.length, sp.index, sp.used ?? 0);
    sp.index = pick.index;
    sp.used = pick.used;
    sp.last = pick.last;
    sp.done = pick.done;
    sp.destroy = num(v[6]) === 2 || (num(v[6]) === 1 && pick.last);
    const pickKey = sounds[pick.line];
    let len = 0;
    if (speaker.alive) {
      const at = { x: speaker.position.x, y: speaker.bottom + speaker.height * 0.9, z: speaker.position.z };
      if (num(v[3]) === 2) speaker.lookAtPlayer = 1.5;
      len = Math.max(0.5, this.hooks.speak([pickKey], speaker, at));
    }
    sp.playing = true;
    sp.until = this.time + len;
    this.note(`Speech#${sp.e.uid.toString(16)} ${pickKey} by ${speaker.ch.root.name}${speaker.alive ? '' : ' (dead: not spoken)'} (${len.toFixed(1)} s)`);
  }

  private updateSpeech(sp: Speech) {
    if (!sp.playing || this.time < sp.until) return;
    sp.playing = false;
    const speaker = sp.speaker !== undefined ? this.manager.get(sp.speaker) : undefined;
    if (sp.speaker !== undefined && !speaker) return;
    const v = sp.e.values;
    const send = (m: number) => {
      if (m) for (const u of sp.e.links) if (!this.manager.get(u)) this.hooks.send(u, m, sp.e.uid);
    };
    send(num(v[8]));
    if (sp.last) send(num(v[9]));
    if (sp.destroy) this.speech.delete(sp.e.uid);
    else if (!sp.done && speaker) this.speakLine(sp, speaker);
  }

  // --- Action Dialog -----------------------------------------------------------
  //
  // [verified from the class code] inputs p24 attach to the linked NPC, p25 detach, p26 /
  // p27 mute on / off, p28 the NPC is gone (detach and remove), p29 a flag; p0 = 1 attaches
  // at start. What the NPC says when [guess]: p6 lines on spotting an enemy (p5 % chance),
  // p8 lines when hurt (p7 %), at most one bark every p9 seconds.

  private attachDialog(d: ActionDialog) {
    d.npc = d.e.links.find((u) => !!this.manager.get(u));
    const a = d.npc !== undefined ? this.manager.get(d.npc) : undefined;
    // The NPC keeps one dialog handle (+0x5a2): the last attached [verified: attach / detach
    // 0x1008d840 compare it with the dialog].
    if (a && d.npc !== undefined) this.attached.set(d.npc, d);
    if (a) a.barks = { spot: refs(d.e.values[6]).map(key), spotChance: num(d.e.values[5], 100), hurt: refs(d.e.values[8]).map(key), hurtChance: num(d.e.values[7], 100), gap: Math.max(3, num(d.e.values[9], 20)), muted: false, next: 0 };
  }

  private dialogInput(d: ActionDialog, msg: number) {
    const v = d.e.values;
    const a = d.npc !== undefined ? this.manager.get(d.npc) : undefined;
    if (msg === num(v[24])) this.attachDialog(d);
    else if (msg === num(v[25]) && a) {
      a.barks = undefined;
      this.detachDialog(d);
    }
    else if (msg === num(v[26]) && a?.barks) a.barks.muted = true;
    else if (msg === num(v[27]) && a?.barks) a.barks.muted = false;
    else if (msg === num(v[28])) {
      if (a) a.barks = undefined;
      this.detachDialog(d);
      this.dialogs.delete(d.e.uid);
    }
  }

  /** NPC uid -> its attached Action Dialog (the NPC's dialog handle). */
  private attached = new Map<number, ActionDialog>();

  private detachDialog(d: ActionDialog) {
    if (d.npc !== undefined && this.attached.get(d.npc) === d) this.attached.delete(d.npc);
  }

  /**
   * A hit of the player's (damage > 0) on `a`: its attached Action Dialog counts it and pays its
   * p22 on the p18th counted hit (0x1008e130, reputation.ts dialogHit). Not counted while the
   * NPC's AttackedByPlayer runs (0x1008e1a7: its behaviour type 0x7c). A counted hit below p18
   * is answered by the warning (dialogWarn), the p18th and later by the turn (dialogTurn): the
   * dialog's update 0x1008dda0 reads the state the count left (flags 1 / 4). Returns the
   * reputation.
   */
  playerHit(a: Actor): number {
    const d = a.uid !== undefined ? this.attached.get(a.uid) : undefined;
    if (!d || this.time < (d.warnUntil ?? -Infinity)) return 0;
    const r = dialogRepRules(d.e.values);
    const last = d.rep.last;
    const pts = dialogHit(d.rep, r, this.time);
    if (d.rep.last === last) return pts;
    if (d.rep.count >= r.hits) this.dialogTurn(d, a);
    else this.dialogWarn(d, a);
    return pts;
  }

  /**
   * The warning of a counted hit below p18 (0x1008d4a0) [verified]: a random p16 line; with a
   * p17 clip the NPC's AttackedByPlayer behaviour (actor.ts attackedByPlayer: it faces the player
   * and plays the clip with the line), without one only the line. No fighting back.
   */
  private dialogWarn(d: ActionDialog, a: Actor) {
    const v = d.e.values;
    const lines = refs(v[16]).map(key);
    if (!lines.length || !a.alive) return;
    const env = this.manager.env;
    const clipRef = refs(v[17])[0];
    const clip = clipRef ? this.manager.kinds.clipIndex(a.kind, clipRef) : -1;
    const at = { x: a.position.x, y: a.bottom + a.height * 0.9, z: a.position.z };
    const said = this.hooks.speak([lines[Math.floor(Math.random() * lines.length)]], a, at);
    const played = env && clip >= 0 ? a.attackedByPlayer(clip, env) : 0;
    d.warnUntil = this.time + (played ? Math.max(played, said) : 0);
    this.note(`Action Dialog#${d.e.uid.toString(16)}: ${a.ch?.root.name ?? a.uid} warned (hit ${d.rep.count} of ${num(v[18], 3)})`);
  }

  /**
   * The turn at the p18th counted hit (update 0x1008dfba) [verified]: the dialog fires its p30 to
   * its links (the level logic: 1c 7edc -> Relay 7ede -> Behavior Changer 7edd -> FleeBehavior
   * 7ee0 from the player; 2's 1c77 the same to Flee 1c7c, after Waypoint 903 1c78 -> Hostility
   * 1c7e; 6b 1574 -> Behavior Changer 1575: Hostility + KillEnemies 10:213 with the player's
   * team as an enemy, Relay 1577 destroys the escort's changers), sets the NPC's speech level to
   * p21, says a random p20 line and, with p23 = 1, destroys itself (0x1008daf0).
   */
  private dialogTurn(d: ActionDialog, a: Actor) {
    const v = d.e.values;
    const out = num(v[30]);
    if (out) for (const u of d.e.links) if (!this.manager.get(u)) this.hooks.send(u, out, d.e.uid);
    const lines = refs(v[20]).map(key);
    if (lines.length && a.alive) this.hooks.speak([lines[Math.floor(Math.random() * lines.length)]], a, { x: a.position.x, y: (a.bottom ?? a.position.y) + (a.height ?? 1.8) * 0.9, z: a.position.z });
    this.note(`Action Dialog#${d.e.uid.toString(16)}: ${a.ch?.root.name ?? a.uid} turns (hit ${d.rep.count}) -> ${out} to ${d.e.links.filter((u) => !this.manager.get(u)).map((u) => u.toString(16)).join(', ')}`);
    if (num(v[23]) === 1) {
      a.barks = undefined;
      this.detachDialog(d);
      this.dialogs.delete(d.e.uid);
    }
  }

  /** The player killed `a`: its attached dialog's p22 unless paid (0x1008d300). */
  playerKill(a: Actor): number {
    const d = a.uid !== undefined ? this.attached.get(a.uid) : undefined;
    return d ? dialogKillPoints(d.rep, dialogRepRules(d.e.values)) : 0;
  }

  // --- Damage Action Object ---------------------------------------------------
  //
  // [verified from the class code, RFL 0x1008e910] p4 damage, p3 = 1 per second (scaled by
  // the frame time), p5 damage type, p6 impact force, p7 the attack stimulus template (an
  // InvestigateSound, 2:545) carried by the damage, p8 an effect template spawned on each target
  // (an Electric Arc Effect over its bones or its linked objects, fx/electric-arc.ts; the
  // decorations of 1a's door and chair room are such trees); inputs p1 (On) apply,
  // p2 Destroy. p0 picks the targets [data]: 0 the sender of the message (Detectors pass the
  // object that entered: the player falling into a death pit), 2 the linked objects (arcs at
  // Horace, a prisoner, a decoration), 1 both.

  private damageInput(e: Entity, msg: number, from: number, env: ActorEnv) {
    const v = e.values;
    if (msg === num(v[2]) && num(v[2])) {
      this.damageObjs.delete(e.uid);
      return;
    }
    if (msg !== num(v[1], 1)) return;
    const mode = num(v[0], 2);
    const targets = [...(mode !== 2 ? [from] : []), ...(mode !== 0 ? e.links : [])];
    const amount = num(v[4]) * (num(v[3]) === 1 ? 1 / 30 : 1);
    // p8: an effect template spawned on each target (0x1008e910 hands it the target twice):
    // the Electric Arc Effects (electric-arc.ts) [verified].
    const effect = refs(v[8]).find((r) => /Arc/.test(classByHash(readObjectTemplate(this.pkgs, r)?.classHash ?? 0)?.name ?? ''));
    const src = pos(e);
    for (const u of targets) {
      if (!u) continue;
      const a = this.manager.get(u);
      const isPlayer = u === this.hooks.playerUid;
      if (amount > 0) {
        if (isPlayer) this.hooks.damagePlayer(amount);
        // p7 rides on the damage as its Special Hit Reaction (2:545: a CartWheeler's
        // electrocution, hit-react.ts) [verified].
        else if (a && !a.template) this.manager.damage(a, amount, src, e.uid, { type: num(v[5]), special: refs(v[7])[0] });
      }
      if (effect && this.hooks.arcEffect) {
        // The effect stays on its target for its p0 whatever happens to it: a character the same
        // shock kills (1a guard 609e at the electrified door: Damage Action Objects 75dd and
        // 8185 at once) keeps crackling on the floor.
        const target = this.arcTarget(u, isPlayer);
        const handle = target ? this.hooks.arcEffect(effect, target) : undefined;
        this.arcEffects.push({ at: this.time, effect: key(effect), target: u, handle });
        if (this.arcEffects.length > 64) this.arcEffects.shift();
      }
    }
    this.note(`DamageAction#${e.uid.toString(16)} ${amount ? amount.toFixed(0) + ' dmg ' : ''}-> ${targets.map((u) => (u === this.hooks.playerUid ? 'player' : `#${u.toString(16)}`)).join(',')}`);
  }

  // --- Noosemen ------------------------------------------------------------------
  //
  // A Nooseman hangs at a Nooseman Drop Position of its group (p185 names the group's root
  // position, which links to the others). When the player stands under another position of
  // the group and the Nooseman can't reach him, it pulls up out of sight and drops down at
  // that position [guess: the relocation logic is in NoosemanScaleRope, not decoded].

  private updateNoosemen(dt: number) {
    const p = this.hooks.player();
    for (const n of this.noosemen) {
      const a = n.a;
      if (!a.alive || a.scripted || a.template || a.hidden) continue;
      n.timer -= dt;
      if (n.timer > 0 || a.state === 'attack' || a.relocating) continue;
      n.timer = 1.2;
      const reach = Math.max(1.5, num(a.entity?.values[183], 1.5) + 1);
      const here = Math.hypot(a.position.x - p.x, a.position.z - p.z);
      if (here < reach + 1.5) continue;
      const spots = this.drops.get(n.group) ?? [];
      let best: (typeof spots)[number] | undefined, bd = Infinity;
      for (const s of spots) {
        const d = Math.hypot(s.x - p.x, s.z - p.z);
        if (d < 3.5 && d < bd && Math.abs(s.y - a.position.y) < 6 && !this.noosemen.some((o) => o !== n && o.a.alive && (Math.hypot(o.a.position.x - s.x, o.a.position.z - s.z) < 1 || (!!o.a.relocationTarget && Math.hypot(o.a.relocationTarget.x - s.x, o.a.relocationTarget.z - s.z) < 1)))) {
          best = s;
          bd = d;
        }
      }
      if (best) {
        a.relocate(best);
        this.note(`${a.ch.root.name} drops at ${best.x.toFixed(1)},${best.z.toFixed(1)}`);
      }
    }
  }

  // --- Ambient Creature ---------------------------------------------------------
  //
  // [verified: class 0x36e88832, ctor 0x10091420, init 0x10091930, update 0x10091c90, map
  // 0x10177be0] A PhysicalObject (GameObject p0 health, 1 on every placed one; p3 invulnerable)
  // that runs an Ambient Creature Waypoint network. Init needs a waypoint link ("Not enough
  // waypoints": destroyed); with p22 = 0 it is left inactive and still (engine state 0), else it
  // plays p24 (its one animation: the run / flight loop) and goes. Inputs p32 On (plays p24,
  // active, runs on) and p33 Off (stops); p12 Destroy. p25 is its speed (m/s, x 2048 into the
  // mover); p28 sounds play every p29..p30 s, at most p31 ambient sounds at once
  // (ambientSoundDue). Waypoints link to their neighbours; at one with p1 = 1 it plays one of the
  // waypoint's p0 clips before going on [data]; out of waypoints it has reached its hole and
  // disappears [guess]. No flee rule: it starts running only on On (Detectors near the player).
  // Damage and death (system.ts ambientHit): 1 health; killed, it pays the player p26 (vt +0x90
  // 0x100916f0), breaks like a Breakable (p18 generator, p21) and is removed (0x1009ba20).

  /** Game times at which the ambient sounds playing now end (all Ambient Creatures: p31 caps them). */
  private ambientVoices: number[] = [];

  private newAmbient(a: Actor): Ambient {
    const v = a.entity!.values;
    const am: Ambient = { a, running: false, wp: 0, prev: 0, wait: 0, speed: num(v[25], 3), gone: false, sound: 0 };
    if (num(v[22]) !== 0) this.startAmbient(am);
    else a.playClip(0, true, 0);
    return am;
  }

  private startAmbient(am: Ambient) {
    if (am.gone) return;
    const v = am.a.entity!.values;
    am.running = true;
    am.wp ||= am.a.entity!.links.find((u) => this.byUid.get(u)?.className === 'Ambient Creature Waypoint') ?? 0;
    am.speed = num(v[25], 3);
    am.sound = num(v[29], 3) + Math.random() * (num(v[30], 7) - num(v[29], 3));
    am.a.playClip(0, true);
  }

  /** The creature was killed (system.ts): it stops and goes. */
  ambientGone(uid: number) {
    const am = this.ambient.get(uid);
    if (!am) return;
    am.gone = true;
    am.running = false;
    this.ambient.delete(uid);
  }

  private ambientInput(am: Ambient, msg: number) {
    const v = am.a.entity!.values;
    if (msg === num(v[12], 12)) {
      am.gone = true;
      am.a.ch.root.visible = false;
    } else if (msg === num(v[32], 1) && !am.running && !am.gone) {
      this.startAmbient(am);
      this.note(`${am.a.ch.root.name} scurries off`);
    } else if (msg === num(v[33], 2)) am.running = false;
  }

  private updateAmbient(am: Ambient, dt: number) {
    const a = am.a;
    if (!am.running || am.gone) return;
    const v = a.entity!.values;
    const voices = this.ambientVoices;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i] <= this.time) voices.splice(i, 1);
    if (ambientSoundDue(am, v, dt, voices.length)) {
      const keys = refs(v[28]).map(key);
      const len = this.hooks.sound?.(keys, a.ch.root.position) ?? 0;
      if (len > 0) voices.push(this.time + len);
    }
    if (am.wait > 0) {
      am.wait -= dt;
      if (am.wait > 0 && !a.clipDone) return;
      am.wait = 0;
      a.playClip(0, true);
    }
    const w = this.byUid.get(am.wp);
    if (!w) {
      am.gone = true;
      a.ch.root.visible = false;
      return;
    }
    const t = pos(w);
    const p = a.ch.root.position;
    const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.15) {
      const next = w.links.filter((u) => u !== am.prev && this.byUid.get(u)?.className === 'Ambient Creature Waypoint');
      am.prev = am.wp;
      am.wp = next.length ? next[Math.floor(Math.random() * next.length)] : 0;
      const clips = refs(w.values[0]);
      if (num(w.values[1]) && clips.length) {
        const c = this.manager.kinds.clipIndex(a.kind, clips[Math.floor(Math.random() * clips.length)]);
        if (c >= 0) {
          a.playClip(c, false);
          am.wait = 4;
        }
      }
      return;
    }
    const step = Math.min(d, am.speed * dt);
    p.x += (dx / d) * step;
    p.z += (dz / d) * step;
    p.y += dy * (step / d);
    a.ch.root.rotation.set(0, Math.atan2(-dx, -dz), 0, 'YXZ');
    a.motor.position.x = p.x;
    a.motor.position.y = p.y;
    a.motor.position.z = p.z;
  }

  update(dt: number, env: ActorEnv) {
    this.time += dt;
    if (this.pendingChains.length) this.reattachChains();
    for (const am of this.ambient.values()) this.updateAmbient(am, dt);
    for (const cl of this.cloners.values()) this.updateCloner(cl, dt, env);
    for (const sp of this.speech.values()) this.updateSpeech(sp);
    this.updateNoosemen(dt);
    if (this.aimers.size) this.updateAimers(dt);
  }

  /**
   * What an Electric Arc Effect crackles over (electric-arc.ts ArcTarget): a character's bones
   * (effect p2 = 0) and the object with the objects it links to, recursively (p2 = 1).
   */
  private arcTarget(u: number, isPlayer: boolean): ArcTarget | undefined {
    const a = this.manager.get(u);
    const ent = this.byUid.get(u);
    const ch = a?.ch ?? (isPlayer ? this.hooks.playerBody?.() : undefined);
    let bones: ArcEndpoints | undefined;
    if (ch?.skeleton) {
      const list = ch.skeleton.bones;
      const tree = treeFromParents(ch.skinned.skeleton.bones.map((b) => b.parent));
      bones = { ...tree, positions: (out) => list.forEach((b, i) => out[i]?.setFromMatrixPosition(b.matrixWorld)) };
    }
    let links: ArcEndpoints | undefined;
    if (ent) {
      const lt = linkTree(u, (x) => this.byUid.get(x)?.links);
      if (lt) {
        const at = lt.uids.map((x) => {
          const xe = this.byUid.get(x)!;
          const xa = this.manager.get(x);
          return () => (xa ? { x: xa.position.x, y: xa.bottom + xa.height * 0.5, z: xa.position.z } : xe ? pos(xe) : undefined);
        });
        links = { ...lt.tree, positions: (out) => at.forEach((f, i) => { const p = f(); if (p) out[i].set(p.x, p.y, p.z); }) };
      }
    }
    if (!bones && !links) return undefined;
    return {
      bones,
      links,
      label: isPlayer ? 'player' : `#${u.toString(16)}`,
      visible: () => (a ? !a.hidden && a.ch.root.visible : ch ? ch.root.visible : true),
      // A character goes with its actor (a death swaps the body's parent for a moment).
      alive: () => (a ? this.manager.get(u) === a : isPlayer ? true : !this.hooks.isDestroyed(u)),
    };
  }

  /**
   * A loaded save's running chains: the actor got its behaviour back from the 'actors'
   * provider; the completion callback (a closure) is made again [1b: Hermes' conversation p17
   * starts the arena; without it a checkpoint restore left the arena idle].
   */
  private reattachChains() {
    for (const [uid, bcUid] of this.pendingChains) {
      const a = this.manager.get(uid);
      const bc = this.changers.get(bcUid);
      if (!a || !bc || !a.alive || a.needsInit) continue;
      a.onChainDone = this.chainNotify(bc);
      a.chainOf = bcUid;
    }
    this.pendingChains = this.pendingChains.filter(([uid]) => this.manager.get(uid)?.needsInit);
  }

  /** Save state of the non-spawner classes (per level; 'actors.logic' provider). */
  snapshot(): DirectorSave {
    return {
      changers: [...this.changers.values()].map((c) => [c.e.uid, c.enabled ? 1 : 0, c.uses]),
      gone: [...this.changerUids].filter((u) => !this.changers.has(u)),
      edges: [...this.edges.values()].map((t) => [t.e.uid, t.on ? 1 : 0]),
      aim: [...this.aimers.values()].map((a) => [a.e.uid, a.on ? 1 : 0]),
      // Chains still running: [actor uid, Behavior Changer uid] (its p17 is still to come).
      chains: this.manager.actors.filter((a) => a.onChainDone && a.chainOf !== undefined && a.uid !== undefined).map((a) => [a.uid!, a.chainOf!]),
      // Speech Players: the next line in order and a line still playing (its p8 / p9 to the
      // links are still to come when it ends); removed ones (Destroy, p6) in speechGone.
      speech: [...this.speech.values()].filter((sp) => sp.index || sp.playing).map((sp) => [sp.e.uid, sp.index, sp.playing ? +Math.max(0, sp.until - this.time).toFixed(3) : -1]),
      speechGone: this.entities.filter((e) => e.className === 'Speech Player' && !this.speech.has(e.uid)).map((e) => e.uid),
      // Action Dialogs: attached to their NPC or not, muted; removed ones (p28) in dialogsGone.
      dialogs: [...this.dialogs.values()].map((d) => {
        const a = d.npc !== undefined ? this.manager.get(d.npc) : undefined;
        // + its hit count: paid, count, seconds since the last counted hit (-1: none).
        const since = Number.isFinite(d.rep.last) ? +(this.time - d.rep.last).toFixed(3) : -1;
        return [d.e.uid, a?.barks ? 1 : 0, a?.barks?.muted ? 1 : 0, d.rep.paid ? 1 : 0, d.rep.count, since];
      }),
      dialogsGone: this.entities.filter((e) => e.className === 'Action Dialog' && !this.dialogs.has(e.uid)).map((e) => e.uid),
    };
  }

  /** Chains of a loaded save, re-attached once the 'actors' provider has set the behaviours. */
  private pendingChains: number[][] = [];

  restore(s: Partial<DirectorSave>) {
    this.pendingChains = s.chains ?? [];
    for (const uid of s.speechGone ?? []) this.speech.delete(uid);
    for (const [uid, index, left] of s.speech ?? []) {
      const sp = this.speech.get(uid);
      if (!sp) continue;
      sp.index = index;
      // The line itself is not played again; its end (p8 / p9) comes when it would have. In
      // order (p4 = 0), the line playing was the round's last when the next index is 0.
      sp.playing = left >= 0;
      sp.until = this.time + Math.max(0, left);
      const ordered = num(sp.e.values[4]) === 0;
      sp.last = ordered && index === 0;
      sp.done = !ordered || index === 0;
      sp.destroy = num(sp.e.values[6]) === 2 || (num(sp.e.values[6]) === 1 && sp.last);
      sp.speaker = undefined;
    }
    for (const uid of s.dialogsGone ?? []) this.dialogs.delete(uid);
    for (const [uid, on, muted, paid, count, since] of s.dialogs ?? []) {
      const d = this.dialogs.get(uid);
      if (!d) continue;
      d.rep = { paid: !!paid, count: count ?? 0, last: since !== undefined && since >= 0 ? this.time - since : -Infinity };
      if (!on) this.detachDialog(d);
      if (on) this.attachDialog(d);
      const a = d.npc !== undefined ? this.manager.get(d.npc) : undefined;
      if (a && !on) a.barks = undefined;
      if (a?.barks) a.barks.muted = !!muted;
    }
    for (const [uid, en, uses] of s.changers ?? []) {
      const c = this.changers.get(uid);
      if (c) (c.enabled = !!en), (c.uses = uses);
    }
    for (const uid of s.gone ?? []) this.changers.delete(uid);
    for (const [uid, on] of s.edges ?? []) {
      const t = this.edges.get(uid);
      if (t) this.setEdge(t, !!on);
    }
    if (s.aim) {
      const keep = new Set(s.aim.map(([u]) => u));
      for (const uid of [...this.aimers.keys()]) if (!keep.has(uid)) this.aimers.delete(uid);
      for (const [uid, on] of s.aim) {
        const a = this.aimers.get(uid);
        if (a) a.on = !!on;
      }
    }
  }

  /**
   * Object Cloner counters and timers ('spawners' provider, loaded after the 'actors'
   * provider has re-created the living copies): per cloner its state, the copies it still
   * counts (by uid) and how long dead ones have held their slot.
   */
  spawnerState(): SpawnerSave {
    return {
      cloners: [...this.clonerUids].map((uid) => {
        const c = this.cloners.get(uid);
        if (!c) return { uid, gone: 1 };
        return {
          uid,
          active: c.active ? 1 : 0,
          remaining: c.remaining,
          done: c.done ? 1 : 0,
          timer: +c.timer.toFixed(3),
          next: c.next,
          alive: c.alive.filter((x) => x.a.uid !== undefined).map((x) => [x.a.uid!, +x.deadFor.toFixed(2)] as [number, number]),
        };
      }),
    };
  }

  setSpawnerState(s: Partial<SpawnerSave>) {
    for (const r of s.cloners ?? []) {
      const c = this.cloners.get(r.uid);
      if (!c) continue;
      if (r.gone) {
        this.cloners.delete(r.uid);
        continue;
      }
      c.active = !!r.active;
      c.remaining = r.remaining ?? c.remaining;
      c.done = !!r.done;
      c.timer = r.timer ?? 0;
      c.next = r.next ?? 0;
      c.alive = [];
      // The copies were re-created by the 'actors' provider (same uids), the dead ones as
      // bodies: a dead copy holds its slot for the rest of its time, as it did when saved.
      for (const [uid, deadFor] of r.alive ?? []) {
        const a = this.manager.get(uid);
        if (a) c.alive.push({ a, deadFor });
      }
    }
  }

  /** Spawners back to the level's initial state (new game / level restart). */
  resetSpawners() {
    for (const e of this.entities) if (e.className === 'Object Cloner') this.cloners.set(e.uid, newCloner(e));
  }
}

export interface DirectorSave {
  /** [uid, enabled, uses] per Behavior Changer; destroyed ones listed in `gone`. */
  changers: number[][];
  gone: number[];
  /** [EdgeToggler uid, on]. */
  edges: number[][];
  /** [Aim Controller uid, on] (destroyed ones left out). */
  aim?: number[][];
  /** [actor uid, Behavior Changer uid]: chains still running (their p17 is still to come). */
  chains?: number[][];
  /** [Speech Player uid, next index, seconds left of the line playing or -1]; removed ones. */
  speech?: number[][];
  speechGone?: number[];
  /** [Action Dialog uid, attached, muted, p22 paid, hit count, s since the last counted hit]; removed ones. */
  dialogs?: number[][];
  dialogsGone?: number[];
}

interface Aimer {
  e: Entity;
  on: boolean;
  /** Current yaw offset (degrees) from the controlled object's placement rotation. */
  offset: number;
  /** Yaw speed (degrees / s), the slew's state. */
  vel: number;
  base?: THREE.Quaternion;
}

/**
 * The Aim Controller's second-order slew (Suffering.rfl 0x1008eb60), in degrees: returns the
 * new speed toward `target` from `cur` at speed `vel`. Within 0.001 of the target, moving away
 * from it, or when the stopping distance vel^2 / (2 decel) reaches what is left, the speed
 * falls by `decel` per second (never past 0); otherwise it grows by `accel` per second toward
 * the target. The caller clamps it to the top speed (p6) and integrates.
 */
export function aimSlew(cur: number, target: number, vel: number, accel: number, decel: number, dt: number): number {
  const diff = target - cur;
  const brake = () => {
    if (!vel) return 0;
    const v = vel - Math.sign(vel) * Math.abs(decel) * dt;
    return Math.sign(v) !== Math.sign(vel) ? 0 : v;
  };
  if (Math.abs(diff) <= 1e-3) return brake();
  if (vel && Math.sign(vel) !== Math.sign(diff)) return brake();
  if (vel && decel > 0 && (vel * vel) / (2 * decel) >= Math.abs(diff)) return brake();
  return vel + Math.sign(diff) * Math.abs(accel) * dt;
}

export interface SpawnerSave {
  cloners: { uid: number; gone?: number; active?: number; remaining?: number; done?: number; timer?: number; next?: number; alive?: [number, number][] }[];
}

function newCloner(e: Entity): Cloner {
  return { e, active: num(e.values[0]) !== 0, remaining: num(e.values[1]), timer: 0, alive: [], next: 0, done: false };
}

function pos(e: Entity) {
  const [x, y, z] = toOutputSpace(e.position);
  return { x, y, z };
}

