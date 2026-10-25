// Level logic runtime: entities, the message dispatcher and the behaviour of the logic
// classes (Detector, Timer, Message Relay, Switch, pickups, STOMP playback, ...).
//
// This module is renderer-free (no THREE) so it can be driven headless; everything visible
// or audible goes through WorldHooks, implemented by world.ts.
//
// Model (docs/game-logic.md §6): an object fires an OUTPUT slot by sending the message id
// stored in that property to every uid in its `links`; a receiver runs the action of every
// INPUT slot whose property value equals the message.

import type { Entity, EntityPackageSet } from '../../formats/entities';
import { classByHash, decodeTemplateProps, entityBoxCorners, messageName, readObjectTemplate, className as classNameOf } from '../../formats/entities';
import { instanceRotation, WORLD_SCALE } from '../../formats/level';
import type { ResRef } from '../../formats/model';
import { parseStompSequence, StompRun, type StompObserver, type StompSequence, type StompSink, type StompTransformKey } from './stomp';
import { sfxExhausted, sfxInterval, sfxPick, sfxRetriggers, SFX_MODE } from './sound-effect';

export type Vec3 = [number, number, number];

// Message ids used directly by the runtime.
export const MSG = {
  On: 1,
  Off: 2,
  Toggle: 3,
  Enable: 4,
  Disable: 5,
  Triggered: 6,
  Destroy: 12,
  AttemptInteract: 402,
} as const;

export interface SoundPlayback {
  /** Stop, fading out over `fade` seconds (default: a short click-free fade). */
  stop(fade?: number): void;
  readonly playing: boolean;
}

export interface PlayerView {
  /** Feet position (LevelData units). */
  feet: Vec3;
  eye: Vec3;
  /** Unit view direction. */
  forward: Vec3;
}

export interface ActorInfo {
  uid: number;
  position: Vec3;
  className: string;
  /** World-space bounds (min, max) of the object's body, where its shape is what touches (Pushables). */
  bounds?: [Vec3, Vec3];
}

/** Side effects of the logic (implemented by the Three/DOM layer). */
export interface WorldHooks {
  player(): PlayerView | null;
  /** NPC positions for Detector filters (provided by the actors system, optional). */
  actors?(): ActorInfo[];
  setVisible(uid: number, visible: boolean): void;
  /** Pose a dynamic object from a STOMP transform (null = back to its placement). */
  setTransform(uid: number, key: StompTransformKey | null): void;
  /** Switch moved: pose 0 closed .. 1 open; `moving` while in motion. */
  switchPose(uid: number, pose: number, moving: boolean): void;
  /**
   * `effect`: a sound effect of the object itself (no dialog lip-sync). `radius` overrides the
   * header's max distance (Sound Effects pass none: their range is the sound's own). `fadeIn`
   * (s) ramps the start; `listener` plays it 2D at the listener (Sound Effect p9 = 2).
   */
  playSound(uid: number, keys: string[], position: Vec3, opts: { radius?: number; loop?: boolean; effect?: boolean; fadeIn?: number; listener?: boolean }): SoundPlayback | undefined;
  /** AI noise (an InvestigateSound template: p0 radius, p1 level) at a position (actors system). */
  noise?(at: Vec3, sound: ResRef): void;
  toast(text: string, ms?: number): void;
  help(text: string | null): void;
  requestLevel(path: string, spawnName?: string): void;
  /** Entity destroyed (hide its mesh / collision). */
  destroyed?(uid: number): void;
  /** Ask whether the player owns an item template (for keys / inventory filters). */
  hasItem?(template: ResRef): boolean;
  /** Take one of an item template from the player's inventory (a key spent on a lock). */
  useItem?(template: ResRef): boolean;
  pickup?(item: WorldEntity): void;
  /**
   * Item CanPickUp (vt+0xa4, 0x100be240) [verified]: false at the carry cap, when the player
   * already holds Item p44 of the item's template. The item then stays where it is.
   */
  canPickUp?(item: WorldEntity): boolean;
  /** Text for the pickup text widget (the item's p22 name, or its p24 "full" message). */
  pickupText?(text: string): void;
  /** Pushable positions for Detectors with filter 3 (props.ts). */
  pushables?(): ActorInfo[];
  /** Spot Light Cones (searchlight.ts): sample points per cone for Detectors with filter 4. */
  lightCones?(): { uid: number; points: [number, number, number][] }[];
  /** Crane hooks (levels/skinned-props.ts): points per crane for Detectors with filter 5. */
  cranes?(): { uid: number; points: [number, number, number][] }[];
  /**
   * Where a point lies in the drawn view (the camera the frame is rendered with, a cutscene's
   * included): the camera position and the point's normalised screen position (-1..1 across
   * the width / height; `front` false behind the camera). Visiblity Message Filters.
   */
  view?(p: Vec3): ScreenView;
  /** Is the line from `from` to `to` clear of level geometry (hits within `slack` m of `to` ignored)? */
  lineOfSight?(from: Vec3, to: Vec3, slack: number): boolean;
}

/**
 * Item CanPickUp (0x100be240) [verified]: an Item / Health Bonus Item cannot be taken while the
 * player holds `held` >= its p44 of the item's template (p44 = 0: no cap).
 */
export function atCarryCap(cls: string, values: readonly unknown[], held: number): boolean {
  if (cls !== 'Health Bonus Item' && cls !== 'Item') return false;
  const cap = num(values[44]);
  return cap > 0 && held >= cap;
}

/** A point seen from the drawn camera (WorldHooks.view). */
export interface ScreenView {
  camera: Vec3;
  /** Normalised screen position: -1 .. 1 from edge to edge (x right, y up). */
  x: number;
  y: number;
  /** In front of the camera. */
  front: boolean;
}

/**
 * Instance Message Filter test (Suffering.rfl 0x100b8b10, its vtable +0x4c) [verified]: is the
 * sender one of the p1 objects; the message passes when that answer equals p2 (1 on every
 * retail instance: pass the listed senders; 0 would pass everyone else).
 */
export function instanceFilterPasses(values: readonly unknown[], from: number): boolean {
  const listed = (Array.isArray(values[1]) ? values[1] : []).includes(from);
  return listed === (num(values[2], 1) !== 0);
}

/**
 * After a message filter passed a message (catch-all 0x100cb7a0) [verified]: it destroys itself
 * when p0 is set or when no link is left (the link walk 0x10014e30 finds none alive). Every filter
 * class (Instance, Inventory, Visiblity, Health, Insanity Mode / Meter, Reputation Points) shares
 * this; p0 was read as "enabled" before, which left 2 Cellblocks' Instance Message Filters with
 * the template's p0 = 0 (905, 90d, ...) shut for good: the inmate's scenes never started.
 */
export function filterSpent(values: readonly unknown[], linksAlive: readonly boolean[]): boolean {
  return num(values[0], 1) !== 0 || !linksAlive.some(Boolean);
}

/** Visiblity Message Filter properties (decoded names). */
export interface VisibilityFilterParams {
  /** p1: >= 0 also asks for a clear line from the camera (its value: the ray's slack); < 0 none. */
  lineOfSight: number;
  /** p2 / p3: the share of the screen width / height (percent, centred) the object must lie in. */
  screenX: number;
  screenY: number;
  /** p4: the most the object may be from the camera (m). */
  maxDistance: number;
  /** p5: within this many metres of the player the filter always passes. */
  nearPlayer: number;
}

/**
 * Visiblity Message Filter test (Suffering.rfl 0x10136db0, the filter's vtable +0x4c, run by
 * the message-filter receiver 0x100cb7a0 before it forwards) [verified]:
 *   1. farther than p4 from the camera: blocked;
 *   2. the player within p5 of the object: passes;
 *   3. behind the camera: blocked;
 *   4. projected to the screen, it must lie in the centred p2 % of the width and p3 % of the
 *      height (|x - W/2| <= p2 * W / 200, likewise y): blocked otherwise;
 *   5. p1 < 0 passes; otherwise a ray from the camera to the object must be clear.
 * p2 / p3 are shares of the screen, not angles: 90 / 90 (most of chapter 1) means "on screen",
 * not "anywhere in front". Read as half-angles, 1a's way-out scene (Gaurd #86) and rubble
 * (#114) scenes started with the player looking elsewhere, and he never saw the guard.
 */
export function visibilityFilterPasses(f: VisibilityFilterParams, obj: Vec3, playerFeet: Vec3, view: ScreenView, clear: () => boolean): boolean {
  const c = view.camera;
  if (Math.hypot(obj[0] - c[0], obj[1] - c[1], obj[2] - c[2]) > f.maxDistance) return false;
  if (Math.hypot(obj[0] - playerFeet[0], obj[1] - playerFeet[1], obj[2] - playerFeet[2]) <= f.nearPlayer) return true;
  if (!view.front) return false;
  if (Math.abs(view.x) > f.screenX / 100 || Math.abs(view.y) > f.screenY / 100) return false;
  return f.lineOfSight < 0 || clear();
}

/**
 * Screen position without a renderer (tests, tools): the eye as the camera, the original's
 * 53 degree vertical lens on a 4:3 screen.
 */
export function approximateView(p: PlayerView, obj: Vec3): ScreenView {
  const f = p.forward;
  const dx = obj[0] - p.eye[0], dy = obj[1] - p.eye[1], dz = obj[2] - p.eye[2];
  // Camera basis: forward, right = forward x up, up = right x forward.
  let rx = -f[2], rz = f[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -f[1] * rz, uy = f[0] * rz - f[2] * rx, uz = f[1] * rx;
  const depth = dx * f[0] + dy * f[1] + dz * f[2];
  const tanY = Math.tan((53 / 2) * (Math.PI / 180));
  const tanX = tanY * (4 / 3);
  const d = Math.max(depth, 1e-6);
  return { camera: p.eye, front: depth > 1e-6, x: (dx * rx + dz * rz) / (d * tanX), y: (dx * ux + dy * uy + dz * uz) / (d * tanY) };
}

/**
 * Behaviour of classes implemented outside this module (props.ts, lights.ts, interact.ts):
 * called for every message delivered to a live entity; return true when it handled it.
 */
export type ClassHandler = (w: WorldEntity, msg: number, from: number) => boolean;

export interface MessageEvent {
  time: number;
  from: number;
  to: number;
  message: number;
  /** Receiver had a matching input slot (or a pass-through filter). */
  handled: boolean;
}

export interface WorldEntity {
  uid: number;
  e: Entity;
  cls: string;
  /** Output-space position (LevelData units). */
  pos: Vec3;
  destroyed: boolean;
  /** Generic enabled flag (Enable/Disable). */
  enabled: boolean;
  visible: boolean;
  /** Class-specific runtime state. */
  s: Record<string, unknown>;
  /** Detector / volume box (output space): centre, unit axes, half extents. */
  box?: { c: Vec3; ax: [Vec3, Vec3, Vec3]; h: Vec3 };
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);
const refs = (v: unknown): ResRef[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as ResRef[]) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Whether a sequence taking this object over shows it (docs/game-logic.md §7 "Control keys").
 * The control key sends the object 0x1001 (SUFFERING.EXE 0x450da0); a Character's catch-all
 * (0x100e1e20) offers it to the behaviour stack, which does not take a first 0x1001 (the
 * sequence behaviour on top takes a second one: 0x100e9dc0), then to the Character message
 * handler (vt +0x118, 0x100e3ab0; Burrower, Fester, Inferna, Killjoy and Rat override it and pass
 * 0x1001 on to it), whose 0x1001 case pushes the sequence behaviour and ends in SetVisible(1)
 * (0x100e19e0 -> vt +0x128) [verified]. The hand-back (0x1002) hides nothing.
 * So a hidden character (instance flag 0x1 clear) appears when a scene takes it: 1b's Hermes
 * 7eb4 rising from the valves in "Camera" #247, Killjoy there and in 1c / 5b, 2's Hargrave.
 * The Player has his own handler (the presenter's puppet) and other classes are no Characters.
 */
export function stompTakeShows(w: { cls: string; destroyed?: boolean; e: { family?: string } }): boolean {
  return w.e.family === 'Character' && w.cls !== 'Player' && !w.destroyed;
}

/** Item-family classes that can be picked up. */
export const PICKUP_CLASSES = new Set(['Ammo Box', 'Health Bonus Item', 'Item', 'Key', 'Map Pack', 'Flashlight', 'Family Picture', 'Map Item', 'Quest Item Pickup']);

// ---------------------------------------------------------------------------
// Switch motion (see docs/game-logic.md "Switch"): p55 kind (0 rotate, 1 slide, 2 none),
// p56 axis (0 x, 1 y, 2 z, model space), p57 travel (degrees mod 360 / model units),
// p58 speed (deg/s or units/s; the sign gives the direction).

export interface SwitchMotion {
  kind: 'rotate' | 'slide' | 'none';
  axis: 0 | 1 | 2;
  /** Signed travel at full open (radians for rotate, model units for slide). */
  travel: number;
  /** Seconds for a full open/close. */
  duration: number;
}

export function switchMotion(e: Entity): SwitchMotion {
  const v = e.values;
  const kindN = num(v[55]);
  const axis = (Math.min(2, Math.max(0, num(v[56], 1))) | 0) as 0 | 1 | 2;
  const amount = num(v[57]);
  const speed = num(v[58]);
  // Speed 0 with a travel: the door is never seen swinging, but its open pose still exists - a
  // p36 start-open door is snapped to it (1b: Switch 6433, 95° at speed 0, the exit of the
  // arrival room). Treated as an instant move [inferred]; before, it was 'none' and stayed shut.
  if (kindN === 0 && amount !== 0) {
    // Travel is stored as 0..360; the direction comes from the speed sign (265 at -90/s = -95°).
    let deg = ((amount % 360) + 360) % 360;
    if (speed < 0 && deg > 0) deg -= 360;
    return { kind: 'rotate', axis, travel: (deg * Math.PI) / 180, duration: speed ? Math.max(0.05, Math.abs(deg / speed)) : 0.05 };
  }
  if (kindN === 1 && amount !== 0) {
    return { kind: 'slide', axis, travel: (speed < 0 ? -1 : 1) * Math.abs(amount), duration: speed ? Math.max(0.05, Math.abs(amount / speed)) : 0.05 };
  }
  return { kind: 'none', axis, travel: 0, duration: 0.25 };
}

// ---------------------------------------------------------------------------

export interface WorldOptions {
  levelPath: string;
  /** Spawn requested by the previous level's transition. */
  spawnName?: string;
  /** Previous level (when entered through a Level Transition). */
  fromLevel?: string;
}

interface Scheduled {
  at: number;
  run: () => void;
}

export class World {
  readonly ents = new Map<number, WorldEntity>();
  readonly byClass = new Map<string, WorldEntity[]>();
  readonly log: MessageEvent[] = [];
  time = 0;
  /** Messages delivered in total (stats). */
  delivered = 0;
  private queue: { to: number; msg: number; from: number }[] = [];
  private scheduled: Scheduled[] = [];
  private stomps = new Map<number, StompRun>();
  private listeners = new Map<number | '*', ((msg: number, from: number, to: number) => void)[]>();
  private sounds = new Map<number, SoundPlayback>();
  /** Sound Effect runtime (sound-effect.ts): current sound, plays, shuffle round, re-trigger time. */
  private sfx = new Map<number, { key?: string; plays: number; used: Set<number>; next?: number }>();
  /** External class behaviours (see ClassHandler). */
  readonly handlers: ClassHandler[] = [];
  private helpUntil = 0;
  private helpOwner = 0;

  constructor(
    entities: Entity[],
    private readonly packages: EntityPackageSet,
    readonly hooks: WorldHooks,
    readonly opts: WorldOptions,
  ) {
    for (const e of entities) {
      const w: WorldEntity = {
        uid: e.uid,
        e,
        cls: e.className,
        pos: [e.position[0] / WORLD_SCALE, e.position[1] / WORLD_SCALE, e.position[2] / WORLD_SCALE],
        destroyed: false,
        enabled: true,
        visible: true,
        s: {},
      };
      this.ents.set(e.uid, w);
      (this.byClass.get(w.cls) ?? this.byClass.set(w.cls, []).get(w.cls)!).push(w);
    }
  }

  get(uid: number) {
    return this.ents.get(uid);
  }

  /**
   * An object created during play (a weapon an NPC drops on death): registered like a level
   * object and initialised. Not part of the save baseline: a reload of the level does not bring
   * it back [port].
   */
  addEntity(e: Entity): WorldEntity {
    const w: WorldEntity = {
      uid: e.uid,
      e,
      cls: e.className,
      pos: [e.position[0] / WORLD_SCALE, e.position[1] / WORLD_SCALE, e.position[2] / WORLD_SCALE],
      destroyed: false,
      enabled: true,
      visible: true,
      s: {},
    };
    this.ents.set(e.uid, w);
    (this.byClass.get(w.cls) ?? this.byClass.set(w.cls, []).get(w.cls)!).push(w);
    this.initEntity(w);
    return w;
  }

  of(cls: string): WorldEntity[] {
    return this.byClass.get(cls) ?? [];
  }

  // -------------------------------------------------------------------------
  // Setup

  /** Initialise class state. Call once after construction. */
  start() {
    for (const w of this.ents.values()) this.initEntity(w);
    // Instance flag 0x1 = present at start; objects without it are shown later by
    // Visibility Togglers or STOMP sequences.
    for (const w of this.ents.values()) {
      if (!(w.e.flags & 1) && w.e.modelRef && w.cls !== 'Player' && w.cls !== 'Camera') this.setVisible(w.uid, false);
    }
    // Visibility Togglers that hide their targets at start (value 2; 1 = shown).
    for (const w of this.of('Visibility Toggler')) {
      const h = num(w.e.values[0]);
      if (h === 2) for (const u of w.e.links) this.setVisible(u, false);
    }
    // Switches that start open (p36) are posed open.
    for (const w of this.of('Switch')) if (w.s.open) this.hooks.switchPose(w.uid, 1, false);
    // Level Transition Msg Handlers are not announced here: they are a cross-level mailbox
    // run by the campaign system (src/game/campaign, docs/campaign.md).
  }

  private initEntity(w: WorldEntity) {
    const v = w.e.values;
    switch (w.cls) {
      case 'Detector': {
        w.enabled = num(v[0], 1) !== 0;
        w.s.inside = new Set<number>();
        w.box = boxOf(w.e);
        break;
      }
      case 'Timer':
        // RFL init 0x10133a30: p1 enabled; thinking only with p0 (autoStart); the countdown is
        // set once here (0x101339b0: p2 ± p3) and again after each firing.
        w.enabled = num(v[1], 1) !== 0;
        w.s.running = num(v[0]) !== 0;
        w.s.left = timerDelay(v);
        w.s.sender = 0;
        break;
      case 'Message Relay':
        w.enabled = num(v[0], 1) !== 0;
        w.s.left = num(v[1]);
        break;
      case 'Count Down To Zero':
        w.s.count = num(v[0]);
        break;
      case 'Level Transition':
        // p6 = 1: enabled at start (RFL 0x100c2ed2); p11 enables, p12 disables (docs/campaign.md).
        w.enabled = num(v[6], 1) === 1;
        break;
      case 'Switch': {
        w.s.motion = switchMotion(w.e);
        // p36: starts open (RFL 0x10132577: snapped to the open state, no outputs fired).
        const open = num(v[36]) !== 0;
        w.s.pose = open ? 1 : 0;
        w.s.target = open ? 1 : 0;
        w.s.open = open;
        // Lock bit (state 0x8): p22 `unlocked` at start; p28 `inUnlock` / p29 `inLock` (usable-object map).
        w.s.unlocked = num(v[22], 1) !== 0;
        break;
      }
      case 'Pushable':
      case 'Phone':
      case 'Toilet':
      case 'Mountable':
      case 'Security Monitor':
        // Usable-object map: p22 `unlocked` at start, p28 inUnlock / p29 inLock (props.ts), the
        // Switch lock's rule (docs/re/object-model.md); `enabled` holds it. 2 Cellblocks' barricade
        // bed 18f1 starts locked; Count Down 18f6 unlocks it once the junk on it is smashed.
        w.enabled = num(v[22], 1) !== 0;
        break;
      default:
        if (PICKUP_CLASSES.has(w.cls)) {
          // p26: picked up by walking into it (else only with Use / an enabling message).
          w.s.auto = num(v[26], 1) !== 0;
          w.s.taken = false;
        }
    }
  }

  // -------------------------------------------------------------------------
  // Messaging

  /** Subscribe to messages delivered to a uid (or '*' for all). Returns an unsubscribe fn. */
  subscribe(uid: number | '*', fn: (msg: number, from: number, to: number) => void) {
    (this.listeners.get(uid) ?? this.listeners.set(uid, []).get(uid)!).push(fn);
    return () => {
      const l = this.listeners.get(uid);
      if (l) this.listeners.set(uid, l.filter((f) => f !== fn));
    };
  }

  /** Queue a message (delivered in order during update, or immediately when flushing). */
  send(to: number, msg: number, from = 0) {
    if (!msg) return;
    this.queue.push({ to, msg, from });
  }

  /** Fire an output slot of an entity: send its message to all links. */
  fire(w: WorldEntity | number, slot: number, from?: number) {
    const ent = typeof w === 'number' ? this.ents.get(w) : w;
    if (!ent || ent.destroyed) return;
    const m = num(ent.e.values[slot]);
    if (!m) return;
    for (const u of ent.e.links) this.send(u, m, from ?? ent.uid);
  }

  after(seconds: number, run: () => void) {
    this.scheduled.push({ at: this.time + seconds, run });
  }

  private flush() {
    let n = 0;
    while (this.queue.length && n < 20000) {
      const { to, msg, from } = this.queue.shift()!;
      n++;
      this.deliver(to, msg, from);
    }
    if (this.queue.length) {
      console.warn('[world] message storm, dropping', this.queue.length);
      this.queue.length = 0;
    }
  }

  private deliver(to: number, msg: number, from: number) {
    const w = this.ents.get(to);
    let handled = false;
    if (w && !w.destroyed) {
      for (const s of w.e.inputs) {
        if (s.message === msg) {
          handled = true;
          this.input(w, s.slot, msg, from);
        }
      }
      // Fixed message ids of the class map (message-maps.ts); the owning systems act on them.
      if (w.e.fixedInputs.includes(msg)) handled = true;
      // Pass-through filters and slots handled with extra runtime state.
      handled = this.extraInput(w, msg, from) || handled;
      for (const h of this.handlers) handled = h(w, msg, from) || handled;
    }
    this.delivered++;
    const ev: MessageEvent = { time: this.time, from, to, message: msg, handled };
    this.log.push(ev);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 300);
    for (const fn of this.listeners.get(to) ?? []) fn(msg, from, to);
    for (const fn of this.listeners.get('*') ?? []) fn(msg, from, to);
  }

  /** Handle an input slot (property index) of an entity. */
  private input(w: WorldEntity, slot: number, msg: number, from: number) {
    const v = w.e.values;
    // GameObject family: 12 = Destroy.
    if (w.e.family && slot === 12) {
      // PhysicalObject Destroy (RFL 0x1009b410, vtable +0x88): fires p21 to the links, then
      // removes the object (lamps take their lights, cameras their monitors with them).
      if (w.e.destroyOutput) this.fire(w, w.e.destroyOutput, from || w.uid);
      return this.destroy(w);
    }
    switch (w.cls) {
      case 'Detector':
        if (slot === 4) this.setDetector(w, true);
        else if (slot === 5) this.setDetector(w, false);
        else if (slot === 6) this.destroy(w);
        return;
      case 'Timer':
        if (slot === 6) this.timerStart(w, from);
        else if (slot === 7) w.s.running = false;
        else if (slot === 8) w.enabled = true;
        else if (slot === 9) w.enabled = false;
        else if (slot === 10) this.destroy(w);
        return;
      case 'Message Relay':
        // RFL message map 0x10178980: 4 relay, 5 enable (0x100cb880), 6 disable, 7 destroy.
        if (slot === 4) this.relay(w, from);
        else if (slot === 5) w.enabled = true;
        else if (slot === 6) w.enabled = false;
        else if (slot === 7) this.destroy(w);
        return;
      case 'Count Down To Zero': {
        if (slot === 3) w.s.count = num(w.s.count) + 1;
        else if (slot === 5) w.s.count = num(v[0]);
        else if (slot === 4) {
          w.s.count = num(w.s.count) - 1;
          if (num(w.s.count) === 0) {
            this.fire(w, 6, from);
            if (num(v[1])) this.destroy(w);
          }
        }
        return;
      }
      case 'Visibility Toggler':
        for (const u of w.e.links) {
          if (slot === 1) this.setVisible(u, true);
          else if (slot === 2) this.setVisible(u, false);
          else if (slot === 3) this.setVisible(u, !(this.ents.get(u)?.visible ?? true));
        }
        return;
      case 'Level Transition':
        if (slot === 10) this.transition(w);
        else if (slot === 11) w.enabled = true;
        else if (slot === 12) w.enabled = false;
        return;
      case 'Sound Effect':
        if (slot === 14) this.playSoundEffect(w);
        else if (slot === 15) this.stopSound(w.uid, Math.max(0, num(w.e.values[12])));
        else if (slot === 17) {
          this.stopSound(w.uid);
          this.destroy(w);
        }
        return;
      case 'Help Popup':
        if (slot === 9) this.showHelp(w);
        else if (slot === 10 && this.helpOwner === w.uid) this.closeHelp();
        else if (slot === 11) {
          if (this.helpOwner === w.uid) this.closeHelp();
          this.destroy(w);
        }
        return;
      case 'STOMP Player':
        if (slot === 5) this.playStomp(w);
        else if (slot === 6) this.destroy(w);
        return;
      case 'Autosave':
        // inSave: the save system (src/game/save/system.ts) subscribes to these messages,
        // takes the checkpoint and shows the game's checkpoint notice.
        return;
      case 'Switch':
        if (slot === 61) this.switchActivate(w, true);
        else if (slot === 62) this.switchActivate(w, false);
        return;
      case 'Level Transition Remover':
        return;
    }
  }

  /** Slots recovered for this runtime that the static class tables do not list. */
  private extraInput(w: WorldEntity, msg: number, from: number): boolean {
    const v = w.e.values;
    switch (w.cls) {
      case 'Switch':
        // Usable-object map (RFL 0x10178608): p28 inUnlock, p29 inLock (default Enable / Disable).
        if (num(v[28]) === msg) return (w.s.unlocked = true), true;
        if (num(v[29]) === msg) return (w.s.unlocked = false), true;
        return false;
      case 'Visiblity Message Filter':
        if (this.visibleToPlayer(w)) this.filterPass(w, msg, from);
        return true;
      case 'Instance Message Filter':
        if (instanceFilterPasses(v, from)) this.filterPass(w, msg, from);
        return true;
      case 'Inventory Message Filter': {
        const items = refs(v[1]);
        const has = items.length > 0 && items.every((r) => this.hooks.hasItem?.(r) ?? false);
        if (has) this.filterPass(w, msg, from);
        return true;
      }
      case 'Object Grouper':
        this.forward(w, msg, from);
        return true;
    }
    if (PICKUP_CLASSES.has(w.cls)) {
      // Item inputs: p50 disable, p51 enable (402 AttemptInteract on use-only items), p52 ?
      if (num(v[51]) === msg) {
        if (msg === MSG.AttemptInteract) this.pickup(w);
        else w.enabled = true;
        return true;
      }
      if (num(v[50]) === msg) return (w.enabled = false), true;
    }
    return false;
  }

  private forward(w: WorldEntity, msg: number, from: number) {
    for (const u of w.e.links) this.send(u, msg, from || w.uid);
  }

  /**
   * A message filter whose test passed (the filter catch-all, Suffering.rfl 0x100cb7a0): the
   * message goes to every link, then the filter destroys itself when p0 is set or none of its
   * links is left (filterSpent). Filters have no message map: p0 is not an enable flag.
   */
  filterPass(w: WorldEntity, msg: number, from: number) {
    if (w.destroyed) return;
    this.forward(w, msg, from);
    if (filterSpent(w.e.values, w.e.links.map((u) => !!this.ents.get(u) && !this.ents.get(u)!.destroyed))) this.destroy(w);
  }

  private visibleToPlayer(w: WorldEntity): boolean {
    const p = this.hooks.player();
    if (!p) return false;
    const v = w.e.values;
    const view = this.hooks.view?.(w.pos) ?? approximateView(p, w.pos);
    return visibilityFilterPasses(
      { lineOfSight: num(v[1], -1), screenX: num(v[2], 90), screenY: num(v[3], 90), maxDistance: num(v[4], 50), nearPlayer: num(v[5]) },
      w.pos,
      p.feet,
      view,
      () => this.hooks.lineOfSight?.(view.camera, w.pos, num(v[1])) ?? true,
    );
  }

  // -------------------------------------------------------------------------
  // Class behaviours

  destroy(w: WorldEntity) {
    if (w.destroyed) return;
    w.destroyed = true;
    w.s.running = false;
    if (w.cls === 'STOMP Player') {
      const r = this.stomps.get(w.uid);
      this.stomps.delete(w.uid);
      if (r && !r.finished) this.stompObserver?.end(r);
    }
    this.hooks.destroyed?.(w.uid);
  }

  setVisible(uid: number, visible: boolean) {
    const w = this.ents.get(uid);
    // A destroyed object is gone in the engine: a later Show (1a: Visibility Toggler 68aa shows
    // the booth door 512a at 5.5 s of the sequence that destroyed it at 0 s) finds no object.
    if (w?.destroyed && visible) return;
    if (w) w.visible = visible;
    this.hooks.setVisible(uid, visible);
  }

  private setDetector(w: WorldEntity, on: boolean) {
    w.enabled = on;
    if (!on) (w.s.inside as Set<number>).clear();
  }

  /**
   * inStart (RFL 0x10133b50): when enabled, the timer thinks (counts down) and keeps the sender.
   * It does not restart the countdown: a Start on a running timer changes nothing but the
   * sender, and a stopped timer goes on from where it stopped (inStop only stops thinking).
   * (Restarting it on every Start held 1b's arena Timer 8b9a back for as long as the player
   * stood transformed in Detector 7ed4, whose every-tick output starts it.)
   */
  private timerStart(w: WorldEntity, from: number) {
    if (!w.enabled || w.destroyed) return;
    if (typeof w.s.left !== 'number' || !Number.isFinite(w.s.left)) w.s.left = timerDelay(w.e.values);
    w.s.running = true;
    w.s.sender = from;
  }

  private relay(w: WorldEntity, from: number) {
    if (!w.enabled) return;
    // RFL 0x100cbc50 [code]: p2 = 0 sends p8 to every link; otherwise to p2 links picked by
    // p3: 0 the next in order, 1 a random one, 2 a random one not used yet (0 and 2 refill the
    // pool from the links once it is empty). Retail: one random Speech Player of a set (barks),
    // lights switched one after another (docs/re/properties.md).
    const pick = num(w.e.values[2]);
    if (pick <= 0) this.fire(w, 8, from || w.uid);
    else {
      const m = num(w.e.values[8]);
      const mode = num(w.e.values[3]);
      // A destroyed link is no pick: it leaves the pool and the pick is made again (0x100cbdc3 ->
      // 0x100a9e90, the loop counter taken back at 0x100cbdd7); the refill (0x100cb8f0) takes the
      // live links only [verified]. 8b's Relay 2413 picks the spot the next Hermes copy is cloned
      // at among the Relays of the gas jets the player has not blocked yet (each block destroys
      // its Relay): picking a destroyed one ended the cloning for good.
      const live = () => w.e.links.filter((u) => !this.ents.get(u)?.destroyed);
      let pool = Array.isArray(w.s.pool) ? (w.s.pool as number[]) : live();
      for (let k = 0; k < pick && m; k++) {
        if (!pool.length) pool = live();
        if (!pool.length) break;
        const i = mode === 0 ? 0 : Math.floor(Math.random() * pool.length);
        const to = pool[i];
        if (mode !== 1 || this.ents.get(to)?.destroyed) pool.splice(i, 1);
        if (this.ents.get(to)?.destroyed) {
          k--;
          continue;
        }
        this.send(to, m, from || w.uid);
      }
      w.s.pool = pool;
    }
    const limit = num(w.e.values[1]);
    if (limit > 0) {
      w.s.left = num(w.s.left, limit) - 1;
      if (num(w.s.left) <= 0) this.destroy(w);
    }
  }

  private transition(w: WorldEntity) {
    const target = str(w.e.props.targetLevel);
    if (!target || !w.enabled) return;
    const spawns = (w.e.props.targetSpawnNames as unknown[]) ?? [];
    const spawn = spawns.find((s) => typeof s === 'string') as string | undefined;
    this.hooks.toast(`Level transition → ${target.split(/[\\/]/).pop()?.replace(/\.lvl$/i, '')}${spawn ? ` (${spawn})` : ''}`, 3000);
    // No target spawn names: '' (the target picks its spawn point by the level arrived from).
    this.hooks.requestLevel(target, spawn ?? '');
  }

  /**
   * Sound Effect play (RFL 0x1012c9a0, sound-effect.ts): pick a sound by play mode p3, keep the
   * current voice when the pick is the sound already playing, else start it (fade-in p13) with
   * the header's own distance range; modes 2..4 schedule the next pick p6 +- p7 (+ p13) s on.
   */
  private playSoundEffect(w: WorldEntity) {
    const v = w.e.values;
    const keys = refs(v[0]).map((r) => `${r.pkg}:${r.id}`);
    if (!keys.length) return;
    const mode = num(v[3]);
    let st = this.sfx.get(w.uid);
    if (!st) this.sfx.set(w.uid, (st = { plays: 0, used: new Set() }));
    st.plays++;
    if (sfxExhausted(mode, st.plays, keys.length)) {
      this.stopSound(w.uid);
      this.destroy(w);
      return;
    }
    st.next = sfxRetriggers(mode) ? this.time + sfxInterval(num(v[6]), num(v[7]), num(v[13]), Math.random()) : undefined;
    const key = keys[sfxPick(mode, keys.length, st.used, Math.random())];
    if (st.key === key && this.sounds.get(w.uid)?.playing) return;
    // Another sound replaces the current one at once.
    this.sounds.get(w.uid)?.stop(0);
    this.sounds.delete(w.uid);
    st.key = key;
    let pos = w.pos;
    const attach = num(v[10]);
    if (attach && this.ents.get(attach)) pos = this.ents.get(attach)!.pos;
    const fadeIn = num(v[13]);
    // Mode 1 repeats the picked sound until stopped (voice flag 1): a loop.
    const h = this.hooks.playSound(w.uid, [key], pos, { loop: mode === SFX_MODE.repeat ? true : undefined, fadeIn: fadeIn > 0 ? fadeIn : undefined, listener: num(v[9]) === 2 });
    if (h) {
      this.sounds.set(w.uid, h);
      w.s.playing = true;
      // p8 InvestigateSound: an AI noise at the object when a sound starts in play mode p3 = 0
      // (RFL 0x1012cb5a, no source). No retail Sound Effect sets p8.
      const inv = ref(v[8]);
      if (inv && mode === SFX_MODE.once) this.hooks.noise?.(pos, inv);
    }
  }

  /** Stop a Sound Effect: its voice fades over p12 (0x1012c560) and re-triggers end. */
  private stopSound(uid: number, fade?: number) {
    const st = this.sfx.get(uid);
    if (st) (st.key = undefined), (st.next = undefined);
    this.sounds.get(uid)?.stop(fade);
    this.sounds.delete(uid);
  }

  private showHelp(w: WorldEntity) {
    const text = str(w.e.props.text);
    if (!text) return;
    this.helpOwner = w.uid;
    this.helpUntil = this.time + 7;
    this.hooks.help(text);
  }

  private closeHelp() {
    const owner = this.ents.get(this.helpOwner);
    this.helpOwner = 0;
    this.hooks.help(null);
    if (owner) this.fire(owner, 12);
  }

  // --- STOMP --------------------------------------------------------------

  private seqCache = new Map<string, StompSequence | null>();

  sequenceOf(w: WorldEntity): StompSequence | undefined {
    const r = ref(w.e.values[0]);
    if (!r) return undefined;
    const k = `${r.pkg}:${r.id}`;
    let s = this.seqCache.get(k);
    if (s === undefined) {
      const q = (this.packages.get(r.pkg) as { qdu?: import('../../formats/srsc').SrscFile } | undefined)?.qdu;
      s = (q && parseStompSequence(q, r.id)) || null;
      this.seqCache.set(k, s);
    }
    return s ?? undefined;
  }

  /** Presentation of running sequences (camera, animation, sound): src/game/sequence. */
  stompObserver?: StompObserver;

  private readonly stompSink: StompSink = {
    send: (uid, message, sender) => this.send(uid, message, sender),
    setVisible: (uid, visible) => this.setVisible(uid, visible),
    pose: (uid, key) => {
      const target = this.ents.get(uid);
      // The player and the camera are posed by the sequence presenter (src/game/sequence).
      if (!target || target.cls === 'Player' || target.cls === 'Camera') return;
      target.s.stompKey = key;
      this.hooks.setTransform(uid, key);
    },
    // [sequence agent] Tracks flagged TRACK_REMOVE_AT_END (stomp.ts): the object is removed
    // when the sequence finishes (1a "Goose": the escort guards and the door guard).
    remove: (uid) => {
      const w = this.ents.get(uid);
      if (w && w.cls !== 'Player' && w.cls !== 'Camera') this.destroy(w);
    },
    control: (uid, release) => {
      const w = this.ents.get(uid);
      if (!w) return;
      if (release) return void this.stompHeld.delete(uid);
      if (this.stompHeld.has(uid)) return;
      this.stompHeld.add(uid);
      if (stompTakeShows(w)) this.setVisible(uid, true);
    },
  };
  /** Characters a sequence holds (taken, not handed back): a second take is not a new one. */
  private readonly stompHeld = new Set<number>();

  private playStomp(w: WorldEntity) {
    if (this.stomps.has(w.uid)) return;
    // p1 (set on every retail STOMP Player): play once. Detectors that keep re-sending
    // On while the player stands inside must not restart a finished sequence.
    if (w.s.played && num(w.e.values[1], 1)) return;
    w.s.played = true;
    const seq = this.sequenceOf(w);
    if (!seq) {
      // Unknown sequence: finish right away so the chain continues.
      this.after(0.5, () => this.fire(w, 7));
      return;
    }
    const run = new StompRun(w.uid, seq);
    this.stomps.set(w.uid, run);
    this.stompObserver?.begin(run);
  }

  /** Sequences currently playing. */
  runningStomps(): StompRun[] {
    return [...this.stomps.values()];
  }

  /**
   * A sequence takes the view and the player's input only through a track on the Camera object
   * [verified, SUFFERING.EXE: the sequence start 0x44f497 sets run flag 0x200 when a track's
   * object is the view camera 0x5c8b08; the input mapper 0x4bccf1 drops input while any run has
   * it (0x44c6a0); the frame renders from that object, 0x48c521]. The header flag 0x40 is not
   * read by the run (the start copies the header flags without 0x40 / 0x80, 0x44f3fd): it only
   * answers "is a cinematic playing" (0x44c6e0, asked by the RFL's in-game menu events,
   * 0x100067c9). Eight retail sequences have 0x40 and no Camera track (1a "Guard" 7b08, 2
   * "Mainliner" 847, 3b "Guard 1" / "Lower Left (A)", ...): they play in the world while the
   * player keeps his own view and control.
   */
  takesCamera(r: StompRun): boolean {
    return r.cinematic && r.seq.tracks.some((t) => this.ents.get(t.uid)?.cls === 'Camera');
  }

  /** Cinematics currently playing: sequences that take the camera (takesCamera). */
  activeCutscenes(): { uid: number; name: string; t: number; duration: number }[] {
    return [...this.stomps.values()]
      .filter((r) => this.takesCamera(r))
      .map((r) => ({ uid: r.uid, name: r.seq.tracks[0]?.name ?? '', t: r.t, duration: r.seq.duration }));
  }

  /**
   * True while a cinematic drives the Player object: the engine moves Torque along the
   * sequence, so triggers ignore the (free-standing) player until it ends.
   */
  playerInCutscene(): boolean {
    const pu = this.playerUid;
    for (const r of this.stomps.values()) if (r.cinematic && r.seq.tracks.some((t) => t.uid === pu)) return true;
    return false;
  }

  /** Skip running cutscenes (takesCamera) to their end state (keys delivered in order, final poses). */
  skipCutscenes() {
    for (const r of [...this.stomps.values()]) if (this.takesCamera(r)) this.advanceStomp(r, Infinity);
    this.flush();
  }

  private advanceStomp(r: StompRun, dt: number) {
    if (r.advance(dt, this.stompSink, this.stompObserver)) {
      this.stomps.delete(r.uid);
      const w = this.ents.get(r.uid);
      if (w) this.fire(w, 7);
    }
  }

  // --- Switch ---------------------------------------------------------------

  private switchActivate(w: WorldEntity, open: boolean) {
    // Messages work on unlocked switches, or always when p63 ("scripted") is set.
    if (!w.s.unlocked && !num(w.e.values[63])) return;
    this.switchSet(w, open);
  }

  /** Start moving a switch towards open/closed. */
  switchSet(w: WorldEntity, open: boolean) {
    const target = open ? 1 : 0;
    if (w.s.target === target && (w.s.moving || w.s.open === open)) return;
    w.s.target = target;
    w.s.moving = true;
    // 67 on starting to open, 66 on starting to close.
    this.fire(w, open ? 67 : 66);
    this.hooks.switchPose(w.uid, num(w.s.pose), true);
  }

  private updateSwitch(w: WorldEntity, dt: number) {
    if (!w.s.moving) return;
    const m = w.s.motion as SwitchMotion;
    const target = num(w.s.target);
    let pose = num(w.s.pose);
    const step = dt / Math.max(0.05, m.duration);
    pose = target > pose ? Math.min(target, pose + step) : Math.max(target, pose - step);
    w.s.pose = pose;
    const done = pose === target;
    if (done) {
      w.s.moving = false;
      w.s.open = target === 1;
      // 64 when fully open, 65 when fully closed.
      this.fire(w, target === 1 ? 64 : 65);
      // p41 auto-close: p42 s after it stops open (RFL 0x1013218a).
      w.s.closeIn = target === 1 && num(w.e.values[41]) ? num(w.e.values[42], 7) : 0;
    }
    this.hooks.switchPose(w.uid, pose, !done);
  }

  /**
   * Auto-closing switch (p41) at rest and open: when its p42 timer runs out it closes, unless
   * the player is within p43 m, in which case it tries again 2 s later (RFL 0x10132e73).
   */
  private autoCloseSwitch(w: WorldEntity, dt: number) {
    if (w.destroyed || w.s.moving || !w.s.open || !(num(w.s.closeIn) > 0)) return;
    w.s.closeIn = num(w.s.closeIn) - dt;
    if (num(w.s.closeIn) > 0) return;
    const p = this.hooks.player();
    const reach = num(w.e.values[43], 10);
    if (p && Math.hypot(p.feet[0] - w.pos[0], p.feet[1] - w.pos[1], p.feet[2] - w.pos[2]) <= reach) {
      w.s.closeIn = 2;
      return;
    }
    w.s.closeIn = 0;
    this.switchSet(w, false);
  }

  /**
   * Whether the player can use a switch. NOT gated on p23: an earlier reading took p23 as
   * "usable by the player", but retail light switches (World Common 7:5, wired to Light
   * Housings) and lockers (7:2250, holding Ammo Boxes) all have p23 = 0 and are used by the
   * player in the original. tests/switch-use.test.ts guards this.
   */
  switchUsable(w: WorldEntity): boolean {
    return w.cls === 'Switch' && !w.destroyed;
  }

  /**
   * Locked feedback (Switch vtable +0xc8, RFL 0x10130030): with p39 set, the sound list p23 of
   * the interaction template the player is using (vtable +0xd4 -> +0xa0: the first entry of p30,
   * or p31 when the switch is open and p34 is set, that fits the player) goes to the sound
   * manager, attached to the switch. The port picks the template whose stand spot is nearest to
   * the player [inferred: the fit test is not ported]; retail doors use one sound for both sides.
   */
  lockedFeedback(w: WorldEntity): boolean {
    const v = w.e.values;
    if (!num(v[39])) return false;
    const list = refs(w.s.open && num(v[34]) ? v[31] : v[30]);
    const p = this.hooks.player();
    let best: ResRef[] = [];
    let bestD = Infinity;
    const [s, c] = [Math.sin((w.e.rotation[1] * Math.PI) / 180), Math.cos((w.e.rotation[1] * Math.PI) / 180)];
    for (const r of list) {
      const t = readObjectTemplate(this.packages, r);
      if (!t) continue;
      const iv = decodeTemplateProps(classByHash(t.classHash), t);
      const sounds = refs(iv[23]);
      if (!sounds.length) continue;
      // Stand spot: p15 sideways, p17 forward (m) in the switch's frame [inferred axes].
      const sx = num(iv[15]), sz = num(iv[17]);
      const at: Vec3 = [w.pos[0] + sx * c + sz * s, w.pos[1], w.pos[2] - sx * s + sz * c];
      const d = p ? Math.hypot(p.feet[0] - at[0], p.feet[2] - at[2]) : 0;
      if (d < bestD) (bestD = d), (best = sounds);
    }
    if (!best.length) return false;
    this.hooks.playSound(w.uid, best.map((r) => `${r.pkg}:${r.id}`), w.pos, { effect: true });
    return true;
  }

  /** Player pressed Use on a switch. Returns a short status for the HUD. */
  useSwitch(w: WorldEntity): string {
    const u = this.beginUseSwitch(w);
    if (!u) return '';
    if (u.locked) {
      this.lockedFeedback(w);
      this.flush();
      return 'Locked';
    }
    u.operate();
    return u.status;
  }

  /**
   * The use attempt on a switch (68, 27, lock and key) without moving it: `operate()` moves it
   * (useSwitch does at once; a third-person use animation at its StartInteract, interact.ts /
   * use-anim.ts). `locked`: the attempt failed (the caller gives lockedFeedback, at once or once
   * the player is in place for the rattle clip). Undefined when the switch is not usable.
   */
  beginUseSwitch(w: WorldEntity): { status: string; locked: boolean; open: boolean; operate(): void } | undefined {
    if (!this.switchUsable(w)) return undefined;
    const v = w.e.values;
    // The Player's use code (RFL 0x1003675f): in third person it enters its Interact state and
    // fires 68 on the switch (0x100368f6); in first person it fires 69 instead (0x100367f1).
    // Both happen whether the switch is locked or not. The port uses switches the third-person
    // way only, so 69 is never sent (firing both started level exits twice: 68 -> Timer for
    // the walk-through, 69 -> an immediate relay).
    this.fire(w, 68);
    // UsableObject "used" output p27 (vtable +0xec 0x100ba360), called by both use paths
    // before the lock decides: locked doors use it for their rattle sound / remark.
    this.fire(w, 27);
    if (!w.s.unlocked) {
      const key = ref(v[38]);
      if (!key || !this.hooks.hasItem?.(key)) {
        this.flush();
        return { status: 'Locked', locked: true, open: true, operate: () => {} };
      }
      // The key is spent (RFL 0x1004ced0 takes one) and unlocks the switch for good (0x10131d8f).
      this.hooks.useItem?.(key);
      w.s.unlocked = true;
    }
    const open = !(w.s.moving ? num(w.s.target) === 1 : !!w.s.open);
    // Doors without close interactions (p31 empty) can't be closed by the player.
    if (!open && refs(v[31]).length === 0 && (w.s.motion as SwitchMotion).kind !== 'none') {
      this.flush();
      return { status: '', locked: false, open, operate: () => {} };
    }
    this.flush();
    return {
      status: open ? 'Open' : 'Close',
      locked: false,
      open,
      operate: () => {
        if (w.destroyed) return;
        this.switchSet(w, open);
        this.flush();
      },
    };
  }

  // --- Pickups ---------------------------------------------------------------

  private questSpots?: Map<number, WorldEntity>;

  /** The live Quest Item Pickup whose p33 names item `uid` (built on first use). */
  questSpotFor(uid: number): WorldEntity | undefined {
    if (!this.questSpots) {
      this.questSpots = new Map();
      for (const q of this.of('Quest Item Pickup')) {
        const item = num(q.e.values[33]);
        if (item) this.questSpots.set(item, q);
      }
    }
    return this.questSpots.get(uid);
  }

  /**
   * What the player's pickup of item `w` (the port's Use on an item in view) goes through, or
   * undefined when the player cannot take it himself (docs/game-logic.md §11.3):
   * - an item a Quest Item Pickup grants (its p33) is taken only by using that pickup spot
   *   [verified: items are not usable objects; the spot's handler 0x10125820 hands its p33 item
   *   to the player, and the use fires its p27]. 1a: the Shiv in the stabbed inmate's back
   *   (Ammo Box 5bfb) is granted by Quest Item Pickup 8368, whose p27 starts the timers that kill
   *   the inmate (12:107). Picking the visible Shiv directly left him lying there untouched;
   * - an item not taken by touch (p26 = 0) that no message makes available (no p51 input) and no
   *   spot grants is scenery [inferred]: 1a's three Shivs in Goose's corpse (7cdc..7cde).
   */
  pickupVia(w: WorldEntity): WorldEntity | undefined {
    if (w.cls === 'Quest Item Pickup' || !PICKUP_CLASSES.has(w.cls)) return w;
    const spot = this.questSpotFor(w.uid);
    if (spot) return spot.destroyed || spot.s.taken || !spot.visible ? undefined : spot;
    const v = w.e.values;
    if (num(v[26], 1) === 0 && !num(v[51])) return undefined;
    return w;
  }

  /**
   * A Quest Item Pickup used through the player's use animation (use-anim.ts): taken, and p27
   * fired at once (the Interact state's enter, vt+0xec); grantSpot() hands the item over at the
   * clip's EndInteract (vt+0xbc 0x10125820) [verified]. pickup() does both at once.
   */
  beginSpot(w: WorldEntity) {
    if (w.destroyed || w.s.taken || !w.visible || w.cls !== 'Quest Item Pickup') return false;
    w.s.taken = true;
    this.fire(w, 27);
    this.flush();
    return true;
  }

  /** The item of a Quest Item Pickup (p33) to the player (after beginSpot). */
  grantSpot(w: WorldEntity) {
    if (w.cls !== 'Quest Item Pickup' || w.s.granted) return;
    w.s.granted = true;
    const item = this.ents.get(num(w.e.values[33]));
    if (item && !item.destroyed && !item.s.taken) {
      item.visible = true;
      this.pickup(item);
    }
    this.setVisible(w.uid, false);
    this.flush();
  }

  pickup(w: WorldEntity) {
    if (w.destroyed || w.s.taken || !w.visible) return;
    if (w.cls === 'Quest Item Pickup') {
      // Interactive pickup spot: grants the linked item (p33) and fires p27 to its links.
      w.s.taken = true;
      const item = this.ents.get(num(w.e.values[33]));
      if (item && !item.destroyed) {
        item.visible = true;
        this.pickup(item);
      }
      this.fire(w, 27);
      this.setVisible(w.uid, false);
      this.flush();
      return;
    }
    if (this.hooks.canPickUp && !this.hooks.canPickUp(w)) {
      this.pickupRefused(w);
      return;
    }
    w.s.taken = true;
    this.hooks.pickup?.(w);
    this.fire(w, 53);
    this.fire(w, 54);
    this.setVisible(w.uid, false);
    this.destroy(w);
    this.flush();
  }

  /** Items the player touched while full, by uid: world time of the last touch. */
  private readonly fullTouches = new Map<number, number>();

  /**
   * A touched item the player cannot carry more of (pickup touch 0x100bda00) [verified]. The
   * item's p24 message ("Xombium Full") goes to the pickup text widget (0x100bc260, as the p22
   * name on a pickup) unless the item was touched within the last Player p250 s (3): the player
   * keeps a list of (item, time) that the touch refreshes and that drops entries older than p250
   * (0x10037730 / 0x100377c0 / 0x100372a0). So it shows once on stepping up to the item, and
   * again after walking away for p250 s.
   */
  private pickupRefused(w: WorldEntity) {
    const window = num(this.playerEntity()?.e.values[250], 3);
    const last = this.fullTouches.get(w.uid);
    this.fullTouches.set(w.uid, this.time);
    if (last !== undefined && this.time - last < window) return;
    const text = str(w.e.props.inventoryFullText);
    if (text) (this.hooks.pickupText ?? ((t: string) => this.hooks.toast(t)))(text);
  }

  private playerEntity(): WorldEntity | undefined {
    return this.byClass.get('Player')?.[0];
  }

  // -------------------------------------------------------------------------
  // Per frame

  update(dt: number) {
    this.time += dt;
    // Scheduled callbacks.
    if (this.scheduled.length) {
      const due = this.scheduled.filter((s) => s.at <= this.time);
      if (due.length) {
        this.scheduled = this.scheduled.filter((s) => s.at > this.time);
        for (const s of due) s.run();
      }
    }
    for (const w of this.of('Timer')) {
      if (w.destroyed || !w.s.running) continue;
      w.s.left = num(w.s.left) - dt;
      if (num(w.s.left) <= 0) {
        // Think 0x10133a90: fire p11; p5 destroys the timer, else without p4 (loop) it stops;
        // the countdown is set again either way.
        const v = w.e.values;
        this.fire(w, 11, num(w.s.sender) || w.uid);
        if (num(v[5], 1)) {
          w.s.running = false;
          this.destroy(w);
        } else {
          if (!num(v[4])) w.s.running = false;
          w.s.left = timerDelay(v);
        }
      }
    }
    this.flush();
    for (const r of [...this.stomps.values()]) this.advanceStomp(r, dt);
    this.flush();
    this.updateDetectors();
    this.flush();
    this.updatePickups();
    for (const w of this.of('Switch')) {
      this.updateSwitch(w, dt);
      this.autoCloseSwitch(w, dt);
    }
    this.flush();
    // Sound Effect finished -> output 18 (play mode 0 only, RFL 0x1012ce0b).
    for (const [uid, h] of this.sounds) {
      if (!h.playing) {
        this.sounds.delete(uid);
        const w = this.ents.get(uid);
        const st = this.sfx.get(uid);
        if (st && !sfxRetriggers(num(w?.e.values[3]))) st.key = undefined;
        if (w && num(w.e.values[3]) === SFX_MODE.once) this.fire(w, 18);
      }
    }
    // Modes 2..4: the next pick when the interval ran out.
    for (const [uid, st] of this.sfx) {
      if (st.next === undefined || this.time < st.next) continue;
      const w = this.ents.get(uid);
      if (!w || w.destroyed) {
        this.sfx.delete(uid);
        continue;
      }
      this.sounds.get(uid)?.stop(0);
      this.sounds.delete(uid);
      st.key = undefined;
      this.playSoundEffect(w);
    }
    if (this.helpOwner && this.time > this.helpUntil) this.closeHelp();
    this.flush();
  }

  private occupants(filter: number): { uid: number; points: Vec3[]; bounds?: [Vec3, Vec3] }[] {
    const out: { uid: number; points: Vec3[]; bounds?: [Vec3, Vec3] }[] = [];
    if (filter === 0 || filter === 2) {
      const p = this.playerInCutscene() ? null : this.hooks.player();
      if (p) {
        const f = p.feet;
        out.push({ uid: this.playerUid, points: [[f[0], f[1] + 0.25, f[2]], [f[0], f[1] + 0.9, f[2]], [f[0], f[1] + 1.55, f[2]]] });
      }
    }
    if (filter === 1 || filter === 2) {
      for (const a of this.hooks.actors?.() ?? []) {
        const q = a.position;
        out.push({ uid: a.uid, points: [[q[0], q[1] + 0.5, q[2]], [q[0], q[1] + 1.2, q[2]]] });
      }
    }
    // 4: Spot Light Cones (the beams of searchlight Mountables, searchlight.ts).
    if (filter === 4) for (const c of this.hooks.lightCones?.() ?? []) out.push(c);
    // 5: Cranes, by the object hung on their hook bone p39 (Detector scan 0x100a7e40 asks the
    // Crane for it, 0x100121c0): 4b's crane controls swing the hook into Detectors 7da5 / 78af / 7e6e.
    if (filter === 5) for (const c of this.hooks.cranes?.() ?? []) out.push(c);
    // 3: Pushable objects (crates pushed onto a spot). The engine's touch is an overlap of the
    // object's shape with the volume (§11.2), so a crate counts by its box: 5a's front door is
    // barred by a crate whose Detectors 231c / 231e / 231f sit over the junk beside it, low enough
    // to touch only the crate's top when it is pushed or pulled into the junk (BlowUp).
    if (filter === 3) {
      for (const a of this.hooks.pushables?.() ?? []) {
        const q = a.position;
        out.push({ uid: a.uid, points: [[q[0], q[1] + 0.3, q[2]]], bounds: a.bounds });
      }
    }
    return out;
  }

  /** uid of the Player object (sender for player-caused events). */
  get playerUid(): number {
    return this.of('Player').find((w) => !(w.e.flags & 0x8))?.uid ?? 0;
  }

  /** Scratch for updateDetectors (occupants inside the detector being updated). */
  private readonly detectorNow = new Map<number, Vec3>();

  private updateDetectors() {
    // Occupants per filter, gathered once a frame rather than per detector (they do not depend
    // on it; per detector it was a steady stream of garbage, docs/game-logic.md §18).
    const byFilter = new Map<number, { uid: number; points: Vec3[]; bounds?: [Vec3, Vec3] }[]>();
    for (const w of this.of('Detector')) {
      if (w.destroyed || !w.enabled || !w.box) continue;
      const v = w.e.values;
      const inside = w.s.inside as Set<number>;
      const now = this.detectorNow;
      now.clear();
      const filter = num(v[1]);
      let occ = byFilter.get(filter);
      if (!occ) byFilter.set(filter, (occ = this.occupants(filter)));
      for (const o of occ) {
        if (o.bounds) {
          if (boxTouchesBounds(w.box, o.bounds)) now.set(o.uid, o.points[0]);
          continue;
        }
        for (const p of o.points) {
          if (!inBox(w.box, p, 0.3)) continue;
          now.set(o.uid, o.points[0]);
          break;
        }
      }
      const single = num(v[2], 1) !== 0;
      for (const [uid, at] of now) {
        if (inside.has(uid)) {
          this.fire(w, 8, uid);
          continue;
        }
        if (single && inside.size > 0) continue;
        inside.add(uid);
        // p3 one-way: only an object entering from the back of the volume (negative local Z,
        // RFL 0x100a7630) fires 7; one coming from the front is taken in silently.
        if (num(v[3]) && !behindVolume(w.box, at)) continue;
        this.fire(w, 7, uid);
        w.s.fired = num(w.s.fired) + 1;
        w.s.flash = this.time;
      }
      for (const uid of [...inside]) {
        if (now.has(uid)) continue;
        inside.delete(uid);
        this.fire(w, 9, uid);
        // p2: the detector is used up once its occupant leaves.
        if (single) {
          this.destroy(w);
          break;
        }
      }
    }
  }

  private updatePickups() {
    const p = this.hooks.player();
    if (!p) return;
    for (const [cls, list] of this.byClass) {
      if (!PICKUP_CLASSES.has(cls)) continue;
      for (const w of list) {
        if (w.destroyed || w.s.taken || !w.visible || !w.enabled || !w.s.auto) continue;
        const dx = w.pos[0] - p.feet[0], dz = w.pos[2] - p.feet[2];
        const dy = w.pos[1] - p.feet[1];
        if (dx * dx + dz * dz < 0.9 * 0.9 && dy > -0.5 && dy < 2.2) this.pickup(w);
      }
    }
  }

  /** Item name for HUD / inventory. */
  itemLabel(w: WorldEntity): string {
    // A Quest Item Pickup has no name of its own: the item it grants (p33).
    const granted = w.cls === 'Quest Item Pickup' ? this.ents.get(num(w.e.values[33])) : undefined;
    if (granted && granted !== w) return this.itemLabel(granted);
    return str(w.e.props.pickupName) || w.cls;
  }

  /** Recent messages for the overlay. */
  recent(n = 30) {
    return this.log.slice(-n);
  }

  describe(uid: number) {
    const w = this.ents.get(uid);
    return w ? `${w.cls}#${uid.toString(16)}` : uid ? `#${uid.toString(16)}` : 'engine';
  }

  // -------------------------------------------------------------------------
  // Save state (src/game/save/providers.ts). Entity state (destroyed / enabled / visible / s)
  // is public and saved by the provider; these cover the dispatcher's private runtime state.

  /** Dispatcher state: clock, running sequences, playing Sound Effects. */
  saveRuntime(): WorldRuntimeState {
    return {
      time: this.time,
      stomps: [...this.stomps.values()].filter((r) => !r.finished).map((r) => ({ uid: r.uid, t: r.t })),
      sounds: [...this.sounds.keys()],
      scheduled: this.scheduled.length,
    };
  }

  /**
   * Restore the dispatcher after the entity states were applied: drops queued/scheduled
   * start-up messages, restarts Sound Effects that were playing (from their start) and
   * fast-forwards running sequences to their saved time without re-sending their message /
   * visibility keys (their effects are part of the restored entity state).
   */
  loadRuntime(s: WorldRuntimeState) {
    this.queue.length = 0;
    this.scheduled = [];
    for (const uid of [...this.sounds.keys()]) this.stopSound(uid);
    for (const r of this.stomps.values()) if (!r.finished) this.stompObserver?.end(r);
    this.stomps.clear();
    if (this.helpOwner) {
      this.helpOwner = 0;
      this.hooks.help(null);
    }
    this.time = Number.isFinite(s.time) ? s.time : 0;
    for (const uid of s.sounds ?? []) {
      const w = this.ents.get(uid);
      if (w && !w.destroyed && w.cls === 'Sound Effect') this.playSoundEffect(w);
    }
    const quiet: StompSink = { send: () => {}, setVisible: () => {}, pose: (uid, key, track) => this.stompSink.pose(uid, key, track) };
    for (const st of s.stomps ?? []) {
      const w = this.ents.get(st.uid);
      const seq = w && !w.destroyed ? this.sequenceOf(w) : undefined;
      if (!w || !seq) continue;
      const run = new StompRun(w.uid, seq);
      this.stomps.set(w.uid, run);
      this.stompObserver?.begin(run);
      run.skipping = true;
      const done = run.advance(Math.max(0, st.t), quiet, this.stompObserver);
      run.skipping = false;
      if (done) this.stomps.delete(w.uid);
    }
  }

  static messageName = messageName;
}

/** World.saveRuntime() result (plain JSON). */
export interface WorldRuntimeState {
  time: number;
  /** Sequences still running: STOMP Player uid + sequence time. */
  stomps: { uid: number; t: number }[];
  /** Sound Effects playing (restarted on load). */
  sounds: number[];
  /** Pending after() callbacks (not restorable; informational). */
  scheduled: number;
}

// ---------------------------------------------------------------------------
// Volumes

function boxOf(e: Entity): WorldEntity['box'] {
  const c = entityBoxCorners(e, instanceRotation);
  if (!c) return undefined;
  const P = c.map((p) => p.map((x) => x / WORLD_SCALE) as Vec3);
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const edges = [sub(P[1], P[0]), sub(P[2], P[0]), sub(P[4], P[0])];
  const len = edges.map((d) => Math.hypot(...d));
  const ax = edges.map((d, i) => d.map((x) => x / (len[i] || 1)) as Vec3) as [Vec3, Vec3, Vec3];
  const center: Vec3 = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / 8) as Vec3;
  return { c: center, ax, h: [len[0] / 2, len[1] / 2, len[2] / 2] };
}

/**
 * Detector p3 test (RFL 0x100a7630): the point lies on the negative side of the volume's local
 * Z axis through its centre (the template box's third edge; unit cube scaled thin for planes).
 */
export function behindVolume(b: NonNullable<WorldEntity['box']>, p: Vec3): boolean {
  const z = b.ax[2];
  return (p[0] - b.c[0]) * z[0] + (p[1] - b.c[1]) * z[1] + (p[2] - b.c[2]) * z[2] < 0;
}

/** Timer countdown: p2 ± p3 seconds (RFL 0x101339b0). */
function timerDelay(v: readonly unknown[]): number {
  return Math.max(0, num(v[2] as number) + (Math.random() * 2 - 1) * num(v[3] as number));
}

export function inBox(b: NonNullable<WorldEntity['box']>, p: Vec3, margin = 0): boolean {
  const d: Vec3 = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
  for (let i = 0; i < 3; i++) {
    const a = b.ax[i];
    if (Math.abs(d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) > b.h[i] + margin) return false;
  }
  return true;
}

/**
 * Does an oriented volume (a Detector's box) overlap world-axis bounds (min, max)? Separating
 * axes: the three world axes, the box's three and their nine cross products.
 */
export function boxTouchesBounds(b: NonNullable<WorldEntity['box']>, bounds: [Vec3, Vec3]): boolean {
  const [mn, mx] = bounds;
  const e: Vec3 = [(mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2];
  const t: Vec3 = [b.c[0] - (mn[0] + mx[0]) / 2, b.c[1] - (mn[1] + mx[1]) / 2, b.c[2] - (mn[2] + mx[2]) / 2];
  const W: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const axes: Vec3[] = [...W, ...b.ax];
  for (const u of W) for (const a of b.ax) axes.push([u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]]);
  for (const L of axes) {
    if (Math.hypot(L[0], L[1], L[2]) < 1e-6) continue;
    const dot = (v: Vec3) => v[0] * L[0] + v[1] * L[1] + v[2] * L[2];
    const ra = e[0] * Math.abs(L[0]) + e[1] * Math.abs(L[1]) + e[2] * Math.abs(L[2]);
    const rb = b.h[0] * Math.abs(dot(b.ax[0])) + b.h[1] * Math.abs(dot(b.ax[1])) + b.h[2] * Math.abs(dot(b.ax[2]));
    if (Math.abs(dot(t)) > ra + rb) return false;
  }
  return true;
}

/** Class name of an object template (for item templates in the inventory). */
export function templateClassName(pkgs: EntityPackageSet, r: ResRef): string {
  const t = readObjectTemplate(pkgs, r);
  return t ? classNameOf(t.classHash) : '';
}
