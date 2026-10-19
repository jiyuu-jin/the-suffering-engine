// Shared plumbing for the creature special moves and bosses (src/game/actors/specials/*,
// docs/game-logic.md §15.7).
//
// A special is a per-actor controller created by class name (registry in index.ts). The
// actors system gives every actor of a registered class an `Actor.special` hook; the actor
// calls it at the top of its AI update and skips its generic AI for that tick when it returns
// true. A special therefore only takes over while its move runs (a Nooseman's grab, a
// Burrower underground, a Fester's charge) and leaves everything else - perception, chasing,
// plain melee, hit reactions, death - to the generic AI. Bosses (Black One) own the actor
// for good.
//
// Everything a special touches outside its actor goes through the runtime below: the
// player (position, movement override, body clips), damage (services.combat for the player,
// services.actors / services.damage for others), effects (services.fx), sounds (audio),
// level-logic messages (services.world) and the difficulty (services.difficulty).

import * as THREE from 'three/webgpu';
import type { GameContext } from '../../runtime';
import type { Entity, EntityPackageSet, PropValue } from '../../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../../formats/entities';
import type { ResRef } from '../../../formats/model';
import type { PlayerController } from '../../../app/player';
import type { Actor, ActorEnv } from '../actor';
import type { ActorManager } from '../manager';
import type { PlayerBody } from '../player-body';

/** One running special-move controller (one per actor). */
export interface SpecialMove {
  /** Short name for logs ("nooseman", "black-one", ...). */
  readonly name: string;
  /**
   * Called by the actor before its generic AI every AI tick (also while it is dormant-hidden,
   * so an underground Burrower keeps moving). Return true when the special ran the actor this
   * tick (the generic AI is skipped), false to let the generic AI run.
   */
  update(dt: number, env: ActorEnv): boolean;
  /** The actor died. Return true when the special fired the death outputs itself. */
  died?(env: ActorEnv): boolean;
  /** Level-logic message to this actor (before the manager's generic handling); true = consumed. */
  message?(msg: number, from: number, env: ActorEnv): boolean;
  /** Debug / test snapshot. */
  info(): Record<string, unknown>;
  dispose?(): void;
  /**
   * The move's own state for a save (plain JSON; undefined = nothing to keep) and its restore
   * onto the freshly created move of the restored actor (the 'actors.specials' provider, after
   * the actors provider placed the actor). The original saves every character component with
   * the character (Character save 0x100e2b60; docs/re/saves.md §4.1).
   */
  save?(): unknown;
  load?(state: unknown): void;
  /**
   * Resurrection (Character vt 22, 0x100e7700): a dead body of this kind stands up again
   * (CartWheeler: p160 % health and its rise clip). Killjoy's RaiseDead calls it (actor.ts runKilljoy).
   */
  rise?(env: ActorEnv): boolean;
}

export type SpecialFactory = (a: Actor, rt: SpecialRuntime) => SpecialMove | undefined;

interface FxLike {
  spawnAt?(ref: ResRef, point: THREE.Vector3Like, normal?: THREE.Vector3Like): void;
  effect?(kind: string, point: THREE.Vector3Like, normal?: THREE.Vector3Like, opts?: { scale?: number; dir?: THREE.Vector3Like }): void;
  shake?(p: { a: number; b: number; time: number; fade?: number; inner?: number; outer?: number; at?: THREE.Vector3Like }): void;
  blood?(point: THREE.Vector3Like, dir?: THREE.Vector3Like, opts?: { amount?: number }): void;
}
interface CombatLike {
  readonly player: { readonly health: number; readonly maxHealth: number; readonly alive: boolean };
  damagePlayer(amount: number, source?: unknown): void;
}
interface DamageLike {
  apply(e: { point: THREE.Vector3Like; amount: number; kind?: string | number; source?: unknown; radius?: number; actor?: unknown }): unknown;
}
interface WorldLike {
  send?(uid: number, message: number, senderUid?: number): void;
  subscribe?(uid: number | '*', fn: (message: number, from: number, to: number) => void): () => void;
  isDestroyed?(uid: number): boolean;
  readonly inCutscene?: boolean;
}
interface DifficultyLike {
  readonly level: number;
  modifier(ref: ResRef | null | undefined): number;
}
interface WeaponsLike {
  readonly current?: unknown;
}

/** Event log entry (window.__specials.events). */
export interface SpecialEvent {
  t: number;
  who: string;
  what: string;
}

export class SpecialRuntime {
  readonly events: SpecialEvent[] = [];
  time = 0;
  /** Level-wide per-frame work (projectiles in flight, boss fights): installSpecials runs them. */
  readonly tickers: ((dt: number, env: ActorEnv) => void)[] = [];
  /** Controllers by actor (installSpecials keeps it). */
  readonly moves = new Map<Actor, SpecialMove>();
  /** The player is held by a special (grab, jump attack): only one at a time. */
  holder: Actor | null = null;

  constructor(
    readonly ctx: GameContext,
    readonly manager: ActorManager,
    readonly pkgs: EntityPackageSet,
    readonly entities: readonly Entity[],
    readonly byUid: ReadonlyMap<number, Entity>,
  ) {}

  get player(): PlayerController {
    return this.ctx.view.player;
  }
  get playerBody(): PlayerBody | null {
    return (this.ctx.services.actors as { playerBody?: PlayerBody | null } | undefined)?.playerBody ?? null;
  }
  get playerAlive(): boolean {
    return this.combat?.player.alive ?? true;
  }
  get playerUid(): number {
    return this.manager.env?.playerUid ?? 0;
  }
  get combat(): CombatLike | undefined {
    return this.ctx.services.combat as CombatLike | undefined;
  }
  get fx(): FxLike | undefined {
    return this.ctx.services.fx as FxLike | undefined;
  }
  get world(): WorldLike | undefined {
    return this.ctx.services.world as WorldLike | undefined;
  }
  get weapons(): WeaponsLike | undefined {
    return this.ctx.services.weapons as WeaponsLike | undefined;
  }
  /** 0 easy .. 3 impossible (services.difficulty, medium without it). */
  get difficulty(): number {
    return (this.ctx.services.difficulty as DifficultyLike | undefined)?.level ?? 1;
  }
  /** Difficulty Modifier value of a template (1 without one). */
  modifier(ref: ResRef | null | undefined): number {
    return (this.ctx.services.difficulty as DifficultyLike | undefined)?.modifier(ref) ?? 1;
  }

  log(a: Actor | string, what: string) {
    const who = typeof a === 'string' ? a : a.ch.root.name;
    this.events.push({ t: +this.time.toFixed(2), who, what });
    if (this.events.length > 400) this.events.splice(0, 100);
    console.debug(`[specials] ${who}: ${what}`);
  }

  /** Damage the player (services.combat; the attacking actor for hit sounds / reactions). */
  hurtPlayer(amount: number, by: Actor, env: ActorEnv) {
    if (amount <= 0 || !env.playerAlive) return;
    env.damagePlayer(amount, by);
  }

  /** Damage an actor (services.actors.damage path: events, outputs, reputation). */
  hurtActor(target: Actor, amount: number, by: Actor | 'player' | number) {
    return this.manager.damage(target, amount, typeof by === 'object' ? by.position : undefined, by);
  }

  /** Splash damage through services.damage (props and actors). */
  splash(point: THREE.Vector3Like, amount: number, radius: number, kind: string, source: number | 'player') {
    (this.ctx.services.damage as DamageLike | undefined)?.apply({ point, amount, radius, kind, source });
  }

  send(uid: number, msg: number, from: number) {
    this.world?.send?.(uid, msg, from);
  }

  /** Spawn an effect template (Object Generator, Particle Fountain, ...) through services.fx. */
  effect(ref: ResRef | null | undefined, at: THREE.Vector3Like, normal?: THREE.Vector3Like) {
    if (!ref) return;
    try {
      this.fx?.spawnAt?.(ref, at, normal ?? { x: 0, y: 1, z: 0 });
    } catch (err) {
      console.debug('[specials] effect', err);
    }
  }

  /** Generic effect kinds of services.fx ('dust', 'sparks', 'flash', 'shake', 'electric', ...). */
  kindEffect(kind: string, at: THREE.Vector3Like, scale = 1) {
    try {
      this.fx?.effect?.(kind, at, undefined, { scale });
    } catch {
      /* optional */
    }
  }

  shake(at: THREE.Vector3Like, a: number, time: number) {
    try {
      this.fx?.shake?.({ a, b: a, time, fade: time * 0.6, inner: 3, outer: 20, at });
    } catch {
      /* optional */
    }
  }

  /** Play one of the sound refs ("pkg:id") at a position. */
  sound(keys: readonly string[], at: THREE.Vector3Like, volume = 1) {
    const audio = this.ctx.audio;
    const ok = keys.filter((k) => audio.get(k));
    if (!ok.length) return;
    audio.play3D(ok[Math.floor(Math.random() * ok.length)], [at.x, at.y, at.z], { volume, bus: 'sfx' });
  }

  /** Model of a template (its .odu model ref). */
  templateModel(ref: ResRef | null | undefined): ResRef | undefined {
    return ref ? readObjectTemplate(this.pkgs, ref)?.modelRef : undefined;
  }

  /** Decoded template (class name + property values), cached. */
  template(ref: ResRef | null | undefined): { cls: string; v: PropValue[] } | undefined {
    return readTemplate(this.pkgs, ref);
  }
}

const tplCache = new WeakMap<object, Map<string, { cls: string; v: PropValue[] } | null>>();
export function readTemplate(pkgs: EntityPackageSet, ref: ResRef | null | undefined): { cls: string; v: PropValue[] } | undefined {
  if (!ref) return undefined;
  let m = tplCache.get(pkgs);
  if (!m) tplCache.set(pkgs, (m = new Map()));
  const k = `${ref.pkg}:${ref.id}`;
  if (!m.has(k)) {
    const t = readObjectTemplate(pkgs, ref);
    const c = t ? classByHash(t.classHash) : undefined;
    m.set(k, t && c ? { cls: c.name, v: decodeTemplateProps(c, t) } : null);
  }
  return m.get(k) ?? undefined;
}

// --- property helpers ----------------------------------------------------------------

export const num = (v: PropValue | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const ref = (v: PropValue | undefined): ResRef | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? { pkg: x.pkg, id: x.id } : undefined;
};
export const refs = (v: PropValue | undefined): ResRef[] =>
  (Array.isArray(v) ? v : [v]).flatMap((x) => (x && typeof x === 'object' ? [{ pkg: x.pkg, id: x.id }] : []));
export const keys = (v: PropValue | undefined): string[] => refs(v).map((r) => `${r.pkg}:${r.id}`);
export const nums = (v: PropValue | undefined): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number');

// --- geometry helpers ----------------------------------------------------------------

/** Horizontal distance. */
export function flat(a: THREE.Vector3Like, b: THREE.Vector3Like) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Yaw (three.js convention, 0 = facing -Z) that faces from `a` toward `b`. */
export function yawTo(a: THREE.Vector3Like, b: THREE.Vector3Like) {
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

export function wrapAngle(a: number) {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

/** Turn `a.yaw` toward `want` by at most `rate * dt`; returns the remaining error. */
export function turnToward(a: Actor, want: number, rate: number, dt: number) {
  const err = wrapAngle(want - a.yaw);
  const step = Math.max(-rate * dt, Math.min(rate * dt, err));
  a.yaw = wrapAngle(a.yaw + step);
  return wrapAngle(want - a.yaw);
}

/**
 * Move an actor through its motor toward world direction (dx, dz) at `speed` m/s (gravity and
 * collision apply). Returns the distance actually moved.
 */
export function drive(a: Actor, dt: number, dx: number, dz: number, speed: number) {
  const l = Math.hypot(dx, dz);
  const m = a.motor;
  const x0 = m.position.x, z0 = m.position.z;
  const keep = m.cfg.walkSpeed;
  m.cfg.walkSpeed = m.cfg.runSpeed = Math.max(0.01, speed);
  const steps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 30))));
  for (let i = 0; i < steps; i++) m.step(dt / steps, { wishX: l > 1e-6 ? dx / l : 0, wishZ: l > 1e-6 ? dz / l : 0, run: false, crouch: false, jump: false });
  m.cfg.walkSpeed = m.cfg.runSpeed = keep;
  return Math.hypot(m.position.x - x0, m.position.z - z0);
}

/** Facing dot product: 1 = `b` straight ahead of `a`. */
export function facing(a: Actor, b: THREE.Vector3Like) {
  const dx = b.x - a.position.x, dz = b.z - a.position.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return 1;
  return (-Math.sin(a.yaw) * dx - Math.cos(a.yaw) * dz) / d;
}

export function rand(a: number, b: number) {
  return a + Math.random() * Math.max(0, b - a);
}
