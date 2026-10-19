// Save providers for the systems that existed when the save system was written: level
// logic (world), inventory, actors, player combat (health) and the player transform.
// They are registered by their owning systems (world.ts, actors/system.ts, system.ts here);
// music registers its own in world/music.ts. See registry.ts for the API.

import type { World, WorldEntity, WorldRuntimeState } from '../world/logic';
import type { Actor, ActorEnv, ActorSaveState } from '../actors/actor';
import type { ActorManager } from '../actors/manager';
import type { ResRef } from '../../formats/model';
import type { LoadInfo, ProviderOptions, SaveProvider } from './registry';
import { decodeValue, encodeValue, stableJson } from './types';

/** What a system needs to register (ctx.services.save). Look it up as `ctx.services.save as SaveService | undefined`. */
export interface SaveService {
  register<T>(key: string, provider: SaveProvider<T>, opts?: ProviderOptions): () => void;
  /** Block manual saving while fn returns a reason. */
  addVeto(fn: () => string | null | undefined): () => void;
  /** Request a checkpoint (taken once no cinematic runs / the player is alive). */
  checkpoint(reason?: string): void;
}

/** Registers a provider when the save service exists (systems may run without it, e.g. in tests). */
export function registerSave<T>(services: Record<string, unknown>, key: string, provider: SaveProvider<T>, opts?: ProviderOptions): () => void {
  const s = services.save as SaveService | undefined;
  return s ? s.register(key, provider, opts) : () => {};
}

// ---------------------------------------------------------------------------
// World (level logic): per-entity destroyed / enabled / visible / class state, stored as a
// diff against the state right after World.start(), plus the dispatcher (World.saveRuntime).

interface EntityRecord {
  /** destroyed, enabled, visible (0/1). */
  d: number;
  e: number;
  v: number;
  /** Encoded WorldEntity.s (without derived keys). */
  s: unknown;
}

export interface WorldSaveState {
  rt: WorldRuntimeState;
  /** uid -> record, only entities that differ from the level's initial state. */
  ents: Record<string, EntityRecord>;
}

/** WorldEntity.s keys rebuilt from the entity on level load (not saved). */
const DERIVED_KEYS = new Set(['motion']);

function encodeState(s: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (!DERIVED_KEYS.has(k)) out[k] = v;
  return encodeValue(out) ?? {};
}

function recordOf(w: WorldEntity): EntityRecord {
  return { d: w.destroyed ? 1 : 0, e: w.enabled ? 1 : 0, v: w.visible ? 1 : 0, s: encodeState(w.s) };
}

/** NPCs / creatures (their visuals and death belong to the actors provider). */
const isActor = (w: WorldEntity) => w.e.family === 'Character';

/**
 * Provider for a World. Create it right after world.start() (the baseline is taken then).
 * Restoring works on a freshly started level and also in place: entities not in the save
 * are put back to the baseline.
 */
export function worldSaveProvider(world: World): SaveProvider<WorldSaveState> {
  const baseline = new Map<number, string>();
  for (const w of world.ents.values()) baseline.set(w.uid, stableJson(recordOf(w)));

  const apply = (w: WorldEntity, r: EntityRecord) => {
    const hooks = world.hooks;
    const actor = isActor(w);
    const prevKey = w.s.stompKey;
    const motion = w.s.motion;
    const s = (decodeValue(r.s) ?? {}) as Record<string, unknown>;
    if (motion !== undefined) s.motion = motion;
    w.s = s;
    w.enabled = !!r.e;
    // Destroyed first: World.setVisible will not show a destroyed object again.
    const wasDestroyed = w.destroyed;
    w.destroyed = !!r.d;
    if (w.visible !== !!r.v) world.setVisible(w.uid, !!r.v);
    if (w.destroyed !== wasDestroyed) {
      if (w.destroyed && !actor) hooks.destroyed?.(w.uid);
      else if (!w.destroyed && !actor) hooks.setVisible(w.uid, w.visible);
    }
    if (actor || w.cls === 'Player' || w.cls === 'Camera') return;
    if (w.cls === 'Switch') hooks.switchPose(w.uid, Number(s.pose) || 0, !!s.moving);
    if (s.stompKey || prevKey) hooks.setTransform(w.uid, (s.stompKey as Parameters<typeof hooks.setTransform>[1]) ?? null);
  };

  return {
    save() {
      const ents: Record<string, EntityRecord> = {};
      for (const w of world.ents.values()) {
        const r = recordOf(w);
        if (stableJson(r) !== baseline.get(w.uid)) ents[w.uid] = r;
      }
      return { rt: world.saveRuntime(), ents };
    },
    load(data) {
      for (const w of world.ents.values()) {
        const saved = data.ents?.[w.uid];
        const cur = stableJson(recordOf(w));
        const target = saved ? stableJson(saved) : baseline.get(w.uid);
        if (!target || target === cur) continue;
        apply(w, saved ?? (JSON.parse(target) as EntityRecord));
      }
      world.loadRuntime(data.rt ?? { time: 0, stomps: [], sounds: [], scheduled: 0 });
    },
  };
}

// ---------------------------------------------------------------------------
// Inventory (world.ts InventoryService; game scope: carried across levels)
//
// The inventory is keyed by item template ("pkg:id", world/inventory.ts). Saves store a list of
// entries, so they load into the template keys as they are. Older saves came from an inventory
// keyed by display name: an entry may lack its template (stored by name only), and entries of
// different templates sharing one name were merged under the first one's template. Loading
// migrates what is unambiguous: a name-only entry whose name belongs to exactly one item
// template gets that template; an entry named by its own "pkg:id" (Inventory Add Remove) is
// renamed by the inventory. Merged counts cannot be split and stay with their template.

interface InventoryLike {
  readonly items: ReadonlyMap<string, { name: string; count: number; template?: ResRef; className?: string }>;
  add(name: string, count: number, template?: ResRef, className?: string): void;
  health: number;
  maxHealth: number;
}

export interface InventorySaveItem {
  name: string;
  count: number;
  template?: ResRef;
  className?: string;
}

export interface InventorySaveState {
  items: InventorySaveItem[];
  health: number;
  maxHealth: number;
}

/** Item templates carrying a display name (for old name-keyed saves). */
export type ItemNameResolver = (name: string) => ResRef[];

/** Old name-keyed entries -> template-keyed (see above); name-only entries resolved when unique. */
export function migrateInventoryItems(items: readonly InventorySaveItem[], resolve?: ItemNameResolver): InventorySaveItem[] {
  return items.map((i) => {
    if (i.template || !resolve) return i;
    const refs = resolve(i.name);
    return refs.length === 1 ? { ...i, template: { pkg: refs[0].pkg, id: refs[0].id } } : i;
  });
}

const REF_KEY = /^\d+:\d+$/;

/**
 * A weapons-save key (weapon / throwable template "pkg:id"). Old saves keyed by display name are
 * mapped to the one template of that name; ambiguous or unknown names give null.
 */
export function migrateItemKey(k: string | null | undefined, resolve?: ItemNameResolver): string | null {
  if (!k) return null;
  if (REF_KEY.test(k)) return k;
  const refs = resolve?.(k) ?? [];
  return refs.length === 1 ? `${refs[0].pkg}:${refs[0].id}` : null;
}

export function inventorySaveProvider(inv: InventoryLike, clear: () => void, resolve?: ItemNameResolver): SaveProvider<InventorySaveState> {
  return {
    save: () => ({
      items: [...inv.items.values()].map((i) => ({ name: i.name, count: i.count, template: i.template, className: i.className })),
      health: inv.health,
      maxHealth: inv.maxHealth,
    }),
    load(d) {
      clear();
      for (const i of migrateInventoryItems(d.items ?? [], resolve)) inv.add(i.name, i.count, i.template, i.className);
      inv.maxHealth = d.maxHealth ?? inv.maxHealth;
      inv.health = d.health ?? inv.maxHealth;
    },
    reset() {
      clear();
      inv.health = inv.maxHealth = 100;
    },
  };
}

// ---------------------------------------------------------------------------
// Actors: placed ones by uid; spawned ones are re-created here (Object Cloner copies, the dead
// ones as bodies; living services.actors.spawn creatures). Actor.getState() / setState()
// (actors/actor.ts) define the record. Spawner counters / timers are not saved here: the actors system's 'spawners'
// provider (priority 12) restores them after this one has re-created the creatures.

export type ActorRecord = ActorSaveState;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface ActorsSaveState {
  actors: ActorRecord[];
  /** Placed characters (level uids) the level logic destroyed. */
  removed?: number[];
}

export function actorsSaveProvider(manager: ActorManager, env: () => ActorEnv | null): SaveProvider<ActorsSaveState> {
  return {
    save() {
      const actors: ActorRecord[] = [];
      const now = env()?.time ?? 0;
      for (const a of manager.actors) {
        if (a.kind.decor || a.template) continue;
        // Spawned creatures: dead Object Cloner copies are kept as the bodies they are (the
        // original keeps the object, and its Object Cloner counts the body against its limit
        // for its p4 seconds: director 'spawners'); dead template spawns are not.
        if (a.spawned && !a.alive && !a.entity) continue;
        actors.push(a.getState(now));
      }
      return { actors, removed: [...manager.removedPlaced] };
    },
    load(d) {
      const e = env();
      // Spawned creatures of the running level are replaced by the saved ones.
      for (const a of [...manager.actors]) if (a.spawned && !a.kind.decor) manager.remove(a);
      // Placed characters destroyed by the level logic (Destroy) before the save was made
      // must not come back with the freshly loaded level.
      for (const uid of d.removed ?? []) {
        const a = manager.get(uid);
        if (a && !a.spawned) manager.remove(a);
      }
      for (const r of d.actors ?? []) {
        let a: Actor | undefined;
        if (r.clone !== undefined) a = manager.clone(r.clone, r.u);
        else if (r.t) a = r.alive ? manager.spawn(r.t, { x: r.p[0], y: r.p[1], z: r.p[2] }, r.yaw) : undefined;
        else if (r.u !== undefined) a = manager.get(r.u);
        a?.setState(r, e);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Player health (actors/combat.ts PlayerCombat; game scope)

interface CombatLike {
  health: number;
  maxHealth: number;
  readonly alive: boolean;
  revive(): void;
  heal(amount: number): number;
}

export interface CombatSaveState {
  health: number;
  maxHealth: number;
}

export function combatSaveProvider(combat: CombatLike): SaveProvider<CombatSaveState> {
  return {
    save: () => ({ health: combat.health, maxHealth: combat.maxHealth }),
    load(d) {
      if (!combat.alive) combat.revive();
      combat.maxHealth = d.maxHealth || combat.maxHealth;
      // Saved while dead (should not happen): come back with full health.
      combat.health = Math.min(combat.maxHealth, d.health > 0 ? d.health : combat.maxHealth);
      combat.heal(0); // refreshes the HUD
    },
    reset() {
      if (!combat.alive) combat.revive();
      combat.health = combat.maxHealth;
      combat.heal(0);
    },
  };
}

// ---------------------------------------------------------------------------
// The player controller outlives the level's systems (an in-place restart after a death keeps
// it, src/app/main.ts restartLevel). What a system hands it while it runs - scripted locomotion
// (ladder, clamber, use animation), a held body clip's motion lock, a creature's hold on the
// attack button, a body facing lock, virtual input, a disabled player - would outlive that
// system and freeze the restored player (a death during a locked clip left the old body's
// lock in place: W did nothing after the restore). The original rebuilds the Player object
// from the save (docs/re/saves.md §4.1), so every level start begins with none of it.

export interface ControllerLike {
  motionOverride: unknown;
  bodyYawLock: number | null;
  enabled: boolean;
  attackOverride?: unknown;
  setVirtualInput?(v: null): void;
  readonly eyeOffset?: { set(x: number, y: number, z: number): unknown };
}

export function releasePlayerControl(p: ControllerLike, walking: boolean): void {
  p.motionOverride = null;
  p.bodyYawLock = null;
  if ('attackOverride' in p) p.attackOverride = null;
  p.setVirtualInput?.(null);
  p.eyeOffset?.set(0, 0, 0);
  p.enabled = walking;
}

// ---------------------------------------------------------------------------
// Player transform (level scope; not applied on transitions: the spawn point wins)

interface PlayerLike {
  readonly position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  mode: 'fp' | 'tp';
  spawn(feet: { x: number; y: number; z: number }, yaw: number): void;
  setMode(mode: 'fp' | 'tp'): void;
}

export interface PlayerSaveState {
  p: [number, number, number];
  yaw: number;
  pitch: number;
  mode: 'fp' | 'tp';
}

export function playerSaveProvider(player: PlayerLike, onPlaced?: (s: PlayerSaveState) => void): SaveProvider<PlayerSaveState> {
  return {
    save: () => ({
      p: [r3(player.position.x), r3(player.position.y), r3(player.position.z)],
      yaw: r3(player.yaw),
      pitch: r3(player.pitch),
      mode: player.mode,
    }),
    load(d, info: LoadInfo) {
      if (info.reason !== 'load') return;
      player.spawn({ x: d.p[0], y: d.p[1] + 0.02, z: d.p[2] }, d.yaw);
      player.pitch = d.pitch;
      if (d.mode === 'fp' || d.mode === 'tp') player.setMode(d.mode);
      onPlaced?.(d);
    },
  };
}
