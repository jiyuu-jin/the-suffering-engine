// Physical props run by the world system (PhysicalObject family, docs/game-logic.md §14):
//
//   * health, damage, Damage Resistance attachments, breaking (Breakable, TargetableBreakable,
//     Light Housing, Security Monitor, Phone, Toilet, Pushable, Mechanism, breakable doors):
//     the GameObject p18 Object Generator is spawned at the object (debris, the broken
//     model as a new Breakable, particles, sounds, radius damage), p21 is fired to the links,
//     the object and its collision go away
//   * Mechanism: rotating movers (security cameras sweeping, fans, hatches)
//   * Pushable: crates the player grabs (Use) and pushes along their axes
//   * Light Housing: lamp fixtures, off / on / broken (housing.ts): material tables, glow
//     decorations, broken remains and the linked lights
//   * DripMorphingModel / MorphingModel: vertex blends between key models (morphing-model.ts),
//     the drops a DripMorphingModel lets fall (drip.ts)
//   * Instance Rendered Object: scattered model instances
//
// Renderer-light: meshes come from DynamicObjects (dynamic.ts), effects from Fx (fx.ts).

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { COLLISION_LAYER, type CollisionWorld } from '../../app/physics';
import { instanceMatrix, type DynamicObject, type DynamicObjects } from './dynamic';
import type { Emitter, Fx, TemplateInfo, SpawnContext } from './fx';
import { HOUSING_BROKEN, HOUSING_OFF, HOUSING_ON, housingExtras, housingLights, housingLook, housingStartState, type HousingState } from './housing';
import { readTemplate } from './fx';
import type { World, WorldEntity, ActorInfo } from './logic';
import type { DamageEvent, DamageService, DamageablePropSet } from './damage';
import type { EntityPackageSet } from '../../formats/entities';
import type { PropTargetInfo } from '../actors/actor';
import { resistanceMultiplier } from '../fx/gas';
import { MORPH_INPUTS, MorphMachine, MorphTargets, morphEvents, morphingModelDef, type MorphEvents, type MorphingModelDef } from './morphing-model';
import { Drip } from './drip';
import { waterSurfaces } from '../fx/surfaces';
import type { PackageSet } from '../../formats/model';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);
const refList = (v: unknown): (ResRef | null)[] => (Array.isArray(v) ? (v as unknown[]).map((x) => ref(x)) : []);
const keyOf = (r: ResRef) => `${r.pkg}:${r.id}`;

/** Classes whose damage / break / messages this module runs. */
export const DAMAGEABLE = new Set(['Breakable', 'TargetableBreakable', 'Light Housing', 'Security Monitor', 'Phone', 'Toilet', 'Pushable', 'Mechanism', 'Mountable']);

export interface PropRec {
  uid: number;
  cls: string;
  values: PropValue[];
  w?: WorldEntity;
  d?: DynamicObject;
  health: number;
  invulnerable: boolean;
  broken: boolean;
  /** Damage type -> multiplier (the first Damage Resistance p0 -> p1); damage() applies the full
   *  rule (resistanceMultiplier: also p5 and the global list). */
  resist: Map<number, number>;
  spawned?: boolean;
  /** Spawned from this template (save). */
  template?: ResRef;
}

export interface PropsEnv {
  world: World;
  dyn: DynamicObjects;
  fx: Fx;
  packages: EntityPackageSet;
  collision: CollisionWorld | null;
  damage(): DamageService | undefined;
  playSound(keys: string[], pos: [number, number, number], opts?: { radius?: number; loop?: boolean }): { stop(): void; readonly playing?: boolean } | undefined;
  /** A lamp's linked Point / Spot Light on or off (lights.ts). */
  setLight(uid: number, on: boolean): void;
  player(): { position: THREE.Vector3; motor: { position: { x: number; y: number; z: number } } } | null;
  timeScale(): number;
}

// ---------------------------------------------------------------------------
// Mechanism (docs §14.3): rotation group p32..p41. Motion [verified: group init
// Suffering.rfl 0x100c8fd0, base index 32]: p32 the time of one full move (s), p33 / p34 the
// accelerate / decelerate times (each at least 0.01 s; both dropped to 0.01 / 0 when their
// sum exceeds p32), p35 the travel (deg; negative turns the other way): top speed
// = |p35| / (p32 - (p33 + p34) / 2), reached after p33 and shed over p34. The port used to read
// p32 as deg/s: the 1a gas chamber door (1 s for 120 deg) took two minutes, security cameras
// swept at half speed and fans (5e7 s for 3.6e9 deg = 72 deg/s) spun absurdly fast.
// [inferred from the retail values]: |travel| >= 3600 = endless spin, p36 axis (0 x, 1 y, 2 z,
// model space), p37 runs at start, p38 = 2 sweep back and forth (security cameras). Sounds p79
// start, p80 stop.
// The translation group p22..p31 has the same layout (p22 time, p23 / p24 accelerate /
// decelerate, p25 travel in metres, p26 axis, p27 runs at start, p28 = 2 sweep): the mover
// 0x100c86b0 adds its position along the axis to the placement and the rotation group's angle
// turns the object [verified]. Inputs [verified: map 0x10178878]: p59 / p60 / p61 / p62 the
// translation group back to its start / forward to its travel / stop / toggle (0x100c7ec0 with
// 0 / 1; the toggle goes forward from the start, else back), p63 / p64 / p65 / p66 the same for
// the rotation group. (The port read p59 as reset and p60 as reverse, p62 / p61 on the rotation
// group: 2 Cellblocks' ladder catch 18cc, On -> p60, never lowered its ladder.)

/**
 * The output a Mechanism's motion group sends when it comes to rest at an end (Suffering.rfl
 * 0x100c81fb..0x100c8254, the group's state switch at 0x100c84b8) [verified code; that it runs
 * at the arrival inferred from the state switch]: 55 + 2 g, plus 1 when the position is the
 * group's travel (within the engine epsilon), g = (base - 22) / 10 (0 the translation group,
 * 1 the rotation group). So p55 / p56: the slide back at its start / at its travel; p57 / p58:
 * the rotation at its start / at its travel. 8b's gas valves: Switch 213d -> Disarm (the
 * rotation group's p64, forward) -> Mechanism 2728 turns 160 deg -> p58 Off -> Relay 1faf ->
 * Count Down 1fa9.
 */
export function mechArrivalOutput(base: number, position: number, travel: number): number {
  const g = Math.round((base - 22) / 10);
  return 55 + 2 * g + (Math.abs(position - travel) < 1e-3 && travel !== 0 ? 1 : 0);
}

interface Mech {
  rec: PropRec;
  angle: number;
  dir: number;
  running: boolean;
  /** Top speed (deg/s), acceleration and deceleration (deg/s²): mechMotion. */
  speed: number;
  accel: number;
  decel: number;
  /** Current speed (deg/s, >= 0) along `dir`. */
  vel: number;
  travel: number;
  axis: number;
  sweep: boolean;
  endless: boolean;
  /** First property of the group: 22 translation, 32 rotation (its arrival outputs). */
  base: number;
  colAcc: number;
  /** The translation group (p22..p31): `angle` is its position (m) along `axis`. */
  slide?: Mech;
}

/**
 * A rotation group's motion (Suffering.rfl 0x100c8fd0): top speed, acceleration and
 * deceleration from the move time `time`, the accelerate / decelerate times and the travel.
 */
export function mechMotion(time: number, accelTime: number, decelTime: number, travel: number): { speed: number; accel: number; decel: number } {
  let a = accelTime, d = decelTime;
  if (a + d > time) (a = 0.01), (d = 0);
  a = Math.max(0.01, a);
  d = Math.max(0.01, d);
  const span = time - (a + d) * 0.5;
  const speed = Math.abs(travel) / Math.max(1e-3, span);
  return { speed, accel: speed / a, decel: speed / d };
}

/** Next speed of a mechanism `left` degrees short of its end: speed up, cruise, brake in time. */
export function mechStep(vel: number, left: number, dt: number, m: { speed: number; accel: number; decel: number }): number {
  let v = Math.min(m.speed, vel + m.accel * dt);
  // Brake so as to stop at the end (v² = 2 · decel · distance left), but keep creeping.
  v = Math.min(v, Math.sqrt(2 * m.decel * Math.max(0, left)));
  return Math.max(v, Math.min(m.speed, m.decel * dt), 1e-3);
}

// Pushable [inferred]: p45 push speed (m/s; <= 0 = 1), p51 scrape sound, outputs p53 start, p55 stop.
interface Push {
  rec: PropRec;
  grabbed: boolean;
  axis: THREE.Vector3;
  offset: number;
  moving: boolean;
  sound?: { stop(): void };
  fallV: number;
  /** Seconds since the last support check while it rests (see updatePush). */
  restAcc?: number;
  /** Grabbed at least once: only a crate the player has moved can fall (updatePush). */
  handled?: boolean;
}

// Placed MorphingModels / DripMorphingModels (morphing-model.ts, drip.ts; docs §14.2): the
// object's own drawn model blended on the GPU between its p3 key models by the decoded think.
interface Morph {
  rec: PropRec;
  def: MorphingModelDef;
  m: MorphMachine;
  /** Morph targets on the drawn meshes (undefined: nothing to blend). */
  targets?: MorphTargets;
  /** DripMorphingModel p25 and its live Drip. */
  dripTpl?: ResRef;
  drip?: Drip;
}

/** A lamp (Light Housing, housing.ts). */
export interface Housing {
  rec: PropRec;
  state: HousingState;
  on: boolean;
  /** Material count of the drawn model (undefined: no model). */
  mats?: number;
  /** Linked Light Source objects it switches (removed when it breaks). */
  lights: number[];
  /** Models spawned for the current state (dynamic uids) and effect emitters. */
  spawned: number[];
  emitters: Emitter[];
}

export interface PropsSaveState {
  broken: number[];
  health: Record<string, number>;
  pushed: Record<string, [number, number, number]>;
  mech: Record<string, [number, number, number] | [number, number, number, number, number, number]>;
  /** Lamps not in their start state (Light Housing p31): 0 off, 1 on. */
  housing: Record<string, number>;
  morph: Record<string, number>;
  /** MorphingModels not in their start state: MorphMachine.save() (clock, flags, fade). */
  morphRun?: Record<string, number[]>;
  /** Invulnerability changed from the start state (GameObject p3; messages p13 / p14). */
  inv?: Record<string, number>;
  /** Phones whose receiver (p30) was broken off. */
  receivers?: number[];
  /** Pushables the player has taken hold of once (they may fall from then on: pushableMayFall). */
  handled?: number[];
}

/** A Pushable falls only once the player has moved it (updatePush) [no think: verified; fall: inferred]. */
export const pushableMayFall = (p: { grabbed: boolean; handled?: boolean }): boolean => p.grabbed || !!p.handled;

export class Props implements DamageablePropSet {
  readonly recs = new Map<number, PropRec>();
  /** Phone uid -> its receiver (the p30 Breakable resting on the cradle). */
  private receivers = new Map<number, PropRec>();
  readonly mechs = new Map<number, Mech>();
  readonly pushes = new Map<number, Push>();
  readonly morphs: Morph[] = [];
  readonly housings = new Map<number, Housing>();
  readonly scatter = new THREE.Group();
  private readonly box = new THREE.Box3();
  private readonly v3 = new THREE.Vector3();

  constructor(readonly env: PropsEnv) {
    this.scatter.name = 'world-scatter';
    const { world } = env;
    for (const w of world.ents.values()) {
      const isDoor = w.cls === 'Switch' && !!ref(w.e.values[18]);
      if (!DAMAGEABLE.has(w.cls) && !isDoor) continue;
      const rec = this.register(w.uid, w.cls, w.e.values, env.dyn.objects.get(w.uid), w);
      if (w.cls === 'Mechanism') this.initMech(rec);
      else if (w.cls === 'Pushable') this.pushes.set(w.uid, { rec, grabbed: false, axis: new THREE.Vector3(1, 0, 0), offset: 0, moving: false, fallV: 0 });
      else if (w.cls === 'Light Housing') this.initHousing(rec);
      else if (w.cls === 'Phone') this.initReceiver(rec);
    }
    for (const cls of ['DripMorphingModel', 'MorphingModel']) for (const w of world.of(cls)) this.initMorph(w);
    for (const w of world.of('Instance Rendered Object')) this.initScatter(w);
    world.handlers.push((w, msg, from) => this.onMessage(w, msg, from));
  }

  private register(uid: number, cls: string, values: PropValue[], d: DynamicObject | undefined, w?: WorldEntity, template?: ResRef): PropRec {
    const resist = new Map<number, number>();
    for (const r of refList(values[7])) {
      if (!r) continue;
      const t = readTemplate(this.env.packages, r);
      if (t?.cls === 'Damage Resistance' && !resist.has(num(t.values[0]))) resist.set(num(t.values[0]), num(t.values[1], 1));
    }
    // GameObject p3 = 1: invulnerable from the start (init 0x100a3166 calls the invulnerability
    // setter with p3 == 1, the one the p13 / p14 messages use) [verified].
    const rec: PropRec = { uid, cls, values, w, d, health: num(values[0], 100), invulnerable: startsInvulnerable(values), broken: false, resist, spawned: !w, template };
    this.recs.set(uid, rec);
    return rec;
  }

  // -------------------------------------------------------------------------
  // DamageablePropSet

  has(uid: number) {
    const r = this.recs.get(uid);
    return !!r && !r.broken;
  }

  uidOfBody(body: number) {
    const uid = this.env.dyn.uidOfBody(body);
    return uid !== undefined && this.has(uid) ? uid : undefined;
  }

  private live() {
    const out: PropRec[] = [];
    for (const r of this.recs.values()) if (!r.broken && r.d && r.d.visible && !(r.w && r.w.destroyed)) out.push(r);
    return out;
  }

  propAt(p: THREE.Vector3Like, margin: number) {
    let best: number | undefined;
    let bestD = Infinity;
    const q = this.v3.set(p.x, p.y, p.z);
    for (const r of this.live()) {
      const c = r.d!.root.matrix.elements;
      if ((c[12] - q.x) ** 2 + (c[13] - q.y) ** 2 + (c[14] - q.z) ** 2 > 36) continue;
      this.env.dyn.bounds(r.d!, this.box);
      this.box.expandByScalar(margin);
      if (!this.box.containsPoint(q)) continue;
      const d = this.box.distanceToPoint(q) + this.box.getCenter(new THREE.Vector3()).distanceTo(q) * 0.01;
      if (d < bestD) (bestD = d), (best = r.uid);
    }
    return best;
  }

  propsNear(p: THREE.Vector3Like, radius: number) {
    const out: { uid: number; distance: number }[] = [];
    const q = this.v3.set(p.x, p.y, p.z);
    for (const r of this.live()) {
      this.env.dyn.bounds(r.d!, this.box);
      const d = this.box.distanceToPoint(q);
      if (d < radius) out.push({ uid: r.uid, distance: d });
    }
    return out;
  }

  private targetCache = new Map<number, { at: number; info: PropTargetInfo }>();

  /**
   * A standing damageable object as a character's target (a KillEnemiesBehavior p3 entry): its
   * bounds centre, bottom and horizontal radius, GameObject p4 / p8 and health fraction;
   * undefined once broken, destroyed or hidden. Bounds are re-read at most every 0.2 s.
   */
  targetInfo(uid: number): PropTargetInfo | undefined {
    const r = this.recs.get(uid);
    if (!r || r.broken || (r.w && r.w.destroyed)) return undefined;
    if (r.d ? !r.d.visible : !r.w?.visible) return undefined;
    const now = performance.now();
    const c = this.targetCache.get(uid);
    if (c && now - c.at < 200) return c.info;
    // A model-less one (the System "Invisible Bounding Box" Breakables 2:702 that 3a's tower
    // guards shoot at in the yard): its placement, as a half-metre box [inferred size].
    if (r.d) this.env.dyn.bounds(r.d, this.box);
    else this.box.setFromCenterAndSize(new THREE.Vector3(r.w!.pos[0], r.w!.pos[1] + 0.25, r.w!.pos[2]), new THREE.Vector3(0.5, 0.5, 0.5));
    const ctr = this.box.getCenter(new THREE.Vector3());
    const v = r.values;
    const max = num(v[1], num(v[0], 100));
    const info: PropTargetInfo = {
      x: ctr.x,
      y: ctr.y,
      z: ctr.z,
      bottom: this.box.min.y,
      radius: Math.max(0.05, Math.min(this.box.max.x - this.box.min.x, this.box.max.z - this.box.min.z) / 2),
      priority: num(v[4], 0.5),
      maxAttackers: num(v[8], 4),
      healthFrac: max > 0 ? Math.max(0, r.health) / max : 1,
      body: r.d?.body,
    };
    this.targetCache.set(uid, { at: now, info });
    return info;
  }

  damage(uid: number, amount: number, type: number, e: DamageEvent) {
    const r = this.recs.get(uid);
    if (!r || r.broken || r.invulnerable || (r.w && r.w.destroyed)) return { damage: 0, killed: false };
    // Damage Resistance as GameObject damage applies it (0x100a31b0 -> 0x100a2dc0) [verified]:
    // x1, or x0 with p5 (immune to unlisted types); the first p7 attachment of the type replaces
    // it with its p1, else the global list. 9:5353 (the 2 m junk piles of 1a / 1b / 3a / 3b: p5,
    // types 3 and 5 only) takes nothing from bullets or blades, only explosions and fire.
    const mult = resistanceMultiplier(this.env.packages, r.values, type);
    const dmg = Math.max(0, amount * mult);
    if (dmg <= 0) return { damage: 0, killed: false };
    r.health -= dmg;
    if (r.w) this.env.world.fire(r.w, 15);
    if (r.health <= 0) {
      const from = e.source && typeof e.source === 'object' && typeof (e.source as THREE.Vector3Like).x === 'number' ? (e.source as THREE.Vector3Like) : undefined;
      const dir = e.dir ? new THREE.Vector3(e.dir.x, e.dir.y, e.dir.z) : from ? new THREE.Vector3(e.point.x - from.x, e.point.y - from.y, e.point.z - from.z) : undefined;
      this.breakProp(r, dir?.lengthSq() ? dir.normalize() : undefined);
      return { damage: dmg, killed: true };
    }
    return { damage: dmg, killed: false };
  }

  // -------------------------------------------------------------------------
  // Breaking

  /** Break a prop: spawn its p18 generator, fire p21, remove it. */
  breakProp(r: PropRec, dir?: THREE.Vector3, silent = false) {
    if (r.broken) return;
    r.broken = true;
    r.health = 0;
    const M = r.d ? r.d.root.matrix.clone().multiply(r.d.pivot.matrix) : r.w ? instanceMatrix(r.w.e.position, r.w.e.rotation) : undefined;
    if (!silent && M) {
      const gen = ref(r.values[18]);
      if (gen) this.env.fx.spawn(gen, M, { dir });
    }
    // A lamp shows its broken state first (0x10017010): p42 remains, its lights removed.
    if (r.cls === 'Light Housing') this.applyHousing(r.uid, HOUSING_BROKEN);
    // A phone that goes takes its receiver with it [inferred].
    const rx = r.cls === 'Phone' ? this.receivers.get(r.uid) : undefined;
    if (rx && !rx.broken) this.breakProp(rx, dir, silent);
    const p = this.pushes.get(r.uid);
    if (p) this.release(p);
    this.mechs.delete(r.uid);
    if (r.w) {
      // p21: sent to the links when destroyed (lamps take their lights, cameras their monitors).
      if (!silent) this.env.world.fire(r.w, 21);
      this.env.world.destroy(r.w);
    }
    if (r.spawned) this.env.dyn.remove(r.uid);
    else if (r.d) this.env.dyn.setVisible(r.uid, false);
  }

  /** World destroyed an entity (Destroy message, save restore). */
  onDestroyed(uid: number) {
    const r = this.recs.get(uid);
    if (!r || r.broken) return;
    r.broken = true;
    // Destroy (GameObject vtable +0x88) removes the lamp and what it spawned; its linked lights
    // are other objects and stay as they are [inferred: no state change on this path].
    if (r.cls === 'Light Housing') this.clearHousingSpawns(uid);
    this.mechs.delete(uid);
  }

  /** Fx hook: templates spawned by generators that are props (broken remains), or damage. */
  spawnOther(t: TemplateInfo, M: THREE.Matrix4, ctx: SpawnContext): boolean {
    if (t.cls === 'Breakable' || t.cls === 'TargetableBreakable' || t.cls === 'Pushable' || t.cls === 'Animating Static') {
      if (!t.model) return true;
      const d = this.env.dyn.spawnModel(t.model, M, { collides: num(t.values[17], 1) !== 0, name: `${t.cls}:${keyOf(t.ref)}` });
      if (d) this.register(d.uid, t.cls, t.values, d, undefined, t.ref);
      return true;
    }
    if (t.cls === 'Radius Damage') {
      // p0 damage at the centre falling to p1 at the edge, p5 radius (m), p10 damage type
      // (p2 / p3 are the impact force at the centre / edge, what hit reactions read).
      const p = new THREE.Vector3().setFromMatrixPosition(M);
      const v = t.values;
      // Defer one frame so the source prop is gone before the blast is applied.
      // p4: the Special Hit Reaction (2:736) the blast carries (the player's 2:835 reaction).
      const special = v[4] && typeof v[4] === 'object' && !Array.isArray(v[4]) && 'pkg' in (v[4] as object) ? (v[4] as { pkg: number; id: number }) : undefined;
      setTimeout(() => this.env.damage()?.apply({ point: p, amount: num(v[0]), minAmount: num(v[1]), innerRadius: 0, radius: num(v[5]), kind: num(v[10]), force: num(v[2]), minForce: num(v[3]), special }), 0);
      return true;
    }
    void ctx;
    return false;
  }

  // -------------------------------------------------------------------------
  // Messages

  private onMessage(w: WorldEntity, msg: number, _from: number): boolean {
    const r = this.recs.get(w.uid);
    let handled = false;
    if (r && !r.broken) {
      const v = r.values;
      if (num(v[11]) === msg) (this.breakProp(r), (handled = true));
      else if (num(v[13]) === msg) (r.invulnerable = true), (handled = true);
      else if (num(v[14]) === msg) (r.invulnerable = false), (handled = true);
      if (!r.broken) {
        if (r.cls === 'Light Housing') {
          if (num(v[44]) === msg) (this.setHousing(r.uid, true), (handled = true));
          else if (num(v[45]) === msg) (this.setHousing(r.uid, false), (handled = true));
        } else if (r.cls === 'Mechanism') handled = this.mechMessage(r, msg) || handled;
        else if (r.cls === 'Pushable' || r.cls === 'Phone' || r.cls === 'Toilet' || r.cls === 'Mountable') {
          // Interactable group: p28 Enable / p29 Disable (usable flag p22).
          if (num(v[28]) === msg) (w.enabled = true), (handled = true);
          else if (num(v[29]) === msg) (w.enabled = false), (handled = true);
        }
      }
    }
    const m = this.morphOf.get(w.uid);
    if (m) {
      // Every slot holding the message runs, in the class map's order (0x10178a18).
      const ev = morphEvents();
      for (const slot of MORPH_INPUTS) if (num(m.rec.values[slot]) === msg) (m.m.input(slot, ev), (handled = true));
      if (handled) this.morphResult(m, ev);
    }
    return handled;
  }

  // -------------------------------------------------------------------------
  // Phone receiver [verified data, inferred spawn]: Phone p30 is a Breakable template (7:2077 on
  // the desk phones, 7:2076 on the wall phones) whose model (7:836 / 7:837, World Common
  // material 7:2086) is the handset, modelled in the phone's own frame resting on the cradle
  // (desk: 0.18..0.27 m up, right over the cradle prongs of 7:842, whose top ends at 0.24 m); it
  // breaks on its own (p18, generator 7:2072 of handset pieces), the phone itself has no break
  // generator. No level places it: the phone puts it there, so it stands at the phone's
  // transform as a breakable prop of its own. (It was taken for the "broken phone" before, which
  // left the desk phones' cradles bare.)

  private initReceiver(phone: PropRec) {
    const t = ref(phone.values[30]) ? readTemplate(this.env.packages, ref(phone.values[30])!) : undefined;
    if (!t?.model || !phone.d || (t.cls !== 'Breakable' && t.cls !== 'TargetableBreakable')) return;
    const M = phone.d.root.matrix.clone().multiply(phone.d.pivot.matrix);
    const d = this.env.dyn.spawnModel(t.model, M, { collides: num(t.values[17], 1) !== 0, name: `Phone receiver:${keyOf(t.ref)}` });
    if (d) this.receivers.set(phone.uid, this.register(d.uid, t.cls, t.values, d, undefined, t.ref));
  }

  /** The unbroken receiver of a phone (its p30 prop), for the pick-up animation (interact.ts). */
  receiverOf(phoneUid: number): DynamicObject | undefined {
    const r = this.receivers.get(phoneUid);
    return r && !r.broken && r.d && r.d.visible ? r.d : undefined;
  }

  // -------------------------------------------------------------------------
  // Light Housing (housing.ts, Suffering.rfl 0x100166d0) [verified]: state p31 at start (0 off,
  // 1 on; 2 broken); p32 / p33 material tables, p40 / p41 / p42 spawns, p38 / p39 to the linked
  // lights, p43 objects shown / hidden; p44 On / p45 Off inputs.

  private initHousing(r: PropRec) {
    const h: Housing = {
      rec: r,
      state: housingStartState(r.values),
      on: false,
      mats: r.d?.model?.materials.length,
      lights: r.w ? housingLights(r.w.e.links, (u) => this.env.world.get(u)?.e) : [],
      spawned: [],
      emitters: [],
    };
    this.housings.set(r.uid, h);
    // Both tables are compiled at load (a lamp switched mid-game would build them in that frame).
    if (r.d) this.env.dyn.warmMaterials(r.uid, [housingLook(r.values, HOUSING_ON, h.mats).materials, housingLook(r.values, HOUSING_OFF, h.mats).materials]);
    // The post-load apply (vtable +0x1c): the start state's look, and its message to the lights.
    this.applyHousing(r.uid, h.state, true);
  }

  /**
   * Put a lamp in a state (0x100166d0): material table, the state's spawns in place of the
   * previous ones, the message to its lights (`lights` false: a save restore, where the lights
   * restore their own state) or their removal when broken, and its p43 objects.
   */
  private applyHousing(uid: number, state: HousingState, lights = true) {
    const h = this.housings.get(uid);
    if (!h) return;
    const r = h.rec;
    const look = housingLook(r.values, state, h.mats);
    h.state = state;
    h.on = state === HOUSING_ON;
    if (look.materials && r.d) this.env.dyn.setMaterials(uid, look.materials);
    this.clearHousingSpawns(uid);
    const M = r.d ? r.d.root.matrix.clone().multiply(r.d.pivot.matrix) : r.w ? instanceMatrix(r.w.e.position, r.w.e.rotation) : undefined;
    if (M) for (const t of look.spawns) this.spawnForHousing(h, t, M);
    const { world } = this.env;
    if (state === HOUSING_BROKEN) {
      // Removed with the list (vtable +0x30): a broken lamp's light stays off.
      for (const u of h.lights) {
        this.env.setLight(u, false);
        const w = world.get(u);
        if (w) world.destroy(w);
      }
      h.lights = [];
    } else if (lights && look.message !== undefined) for (const u of h.lights) this.lightInput(u, look.message, uid);
    for (const u of housingExtras(r.values)) {
      const w = world.get(u);
      if (!w) continue;
      if (look.extras === 'remove') world.destroy(w);
      else world.setVisible(u, look.extras === 'show');
    }
  }

  /** A message to a linked light: a Point / Spot Light's p4 On / p5 Off at once, others queued. */
  private lightInput(u: number, msg: number, from: number) {
    const w = this.env.world.get(u);
    if (!w || w.destroyed) return;
    if (w.cls === 'Point Light' || w.cls === 'Spot Light') {
      if (num(w.e.values[4]) === msg) this.env.setLight(u, true);
      else if (num(w.e.values[5]) === msg) this.env.setLight(u, false);
    } else this.env.world.send(u, msg, from);
  }

  /**
   * One of a lamp's state spawns at its transform: a Breakable (the p42 remains) becomes a prop
   * of its own; a model (glow cone, light pool) is drawn with the lamp's scale and no body;
   * effects go to the fx system.
   */
  private spawnForHousing(h: Housing, r: ResRef, M: THREE.Matrix4) {
    const t = readTemplate(this.env.packages, r);
    if (!t) return;
    const scale = h.rec.w?.e.scale;
    if (t.cls === 'Breakable' || t.cls === 'TargetableBreakable') {
      if (!t.model) return;
      const d = this.env.dyn.spawnModel(t.model, M, { scale, collides: num(t.values[17], 1) !== 0, name: `${t.cls}:${keyOf(t.ref)}` });
      if (d) this.register(d.uid, t.cls, t.values, d, undefined, t.ref);
      return;
    }
    if (t.model && (t.cls === 'Decoration' || t.cls === 'MorphingModel' || t.cls === 'Static Object')) {
      const d = this.env.dyn.spawnModel(t.model, M, { scale, collides: false, name: `${h.rec.cls}#${h.rec.uid.toString(16)}:${t.cls}:${keyOf(t.ref)}` });
      if (d) h.spawned.push(d.uid);
      return;
    }
    this.env.fx.spawn(r, M, { owner: h.emitters });
  }

  /** Remove a lamp's state spawns (decorations, effects); broken remains are props of their own. */
  private clearHousingSpawns(uid: number) {
    const h = this.housings.get(uid);
    if (!h) return;
    for (const u of h.spawned) this.env.dyn.remove(u);
    for (const em of h.emitters) em.stop();
    h.spawned = [];
    h.emitters = [];
  }

  setHousing(uid: number, on: boolean) {
    const h = this.housings.get(uid);
    if (!h || h.rec.broken) return;
    const state = on ? HOUSING_ON : HOUSING_OFF;
    // On / Off only act on a change (0x10017050 / 0x10017070).
    if (h.state !== state) this.applyHousing(uid, state);
  }

  // -------------------------------------------------------------------------
  // Mechanism

  /** One motion group from its base property (22 translation, 32 rotation). */
  private mechGroup(r: PropRec, base: number): Mech {
    const v = r.values;
    const travel = num(v[base + 3]);
    const motion = mechMotion(num(v[base], 5), num(v[base + 1], 1), num(v[base + 2], 1), travel);
    return {
      rec: r,
      base,
      angle: 0,
      dir: 1,
      running: num(v[base + 5]) !== 0,
      ...motion,
      vel: 0,
      travel,
      axis: Math.min(2, Math.max(0, num(v[base + 4], 1))),
      sweep: num(v[base + 6]) === 2,
      endless: base === 32 && Math.abs(travel) >= 3600,
      colAcc: 0,
    };
  }

  private initMech(r: PropRec) {
    const m = this.mechGroup(r, 32);
    if (num(r.values[25])) m.slide = this.mechGroup(r, 22);
    this.mechs.set(r.uid, m);
  }

  private mechMessage(r: PropRec, msg: number): boolean {
    const m = this.mechs.get(r.uid);
    if (!m) return false;
    const v = r.values;
    const is = (i: number) => num(v[i]) !== 0 && num(v[i]) === msg;
    let h = false;
    // 0x100c7ec0: forward (to the travel) or back (to the start); a toggle picks by where the
    // group is heading now.
    const go = (g: Mech | undefined, fwd: boolean) => {
      if (!g) return;
      const dir = fwd ? 1 : -1;
      if (g.dir !== dir) g.vel = 0;
      g.dir = dir;
      g.running = true;
      this.mechSound(r, 79);
    };
    const stop = (g: Mech | undefined) => {
      if (!g) return;
      if (g.running) this.mechSound(r, 80);
      g.running = false;
    };
    const groups: [Mech | undefined, number][] = [[m.slide, 59], [m, 63]];
    for (const [g, b] of groups) {
      if (is(b)) (go(g, false), (h = true));
      if (is(b + 1)) (go(g, true), (h = true));
      if (is(b + 2)) (stop(g), (h = true));
      if (is(b + 3)) {
        if (g) go(g, !(g.dir > 0 && (g.running || g.angle !== 0)));
        h = true;
      }
    }
    return h;
  }

  private mechSound(r: PropRec, slot: number) {
    const keys = refList(r.values[slot]).filter((x): x is ResRef => !!x).map(keyOf);
    if (keys.length && r.w) this.env.playSound(keys, r.w.pos);
  }

  private poseMech(m: Mech) {
    const d = m.rec.d;
    const a = THREE.MathUtils.degToRad(m.angle);
    const p = d ? d.pivot.matrix : new THREE.Matrix4();
    if (m.axis === 0) p.makeRotationX(a);
    else if (m.axis === 1) p.makeRotationY(a);
    else p.makeRotationZ(a);
    // The translation group moves the object along its axis (model space).
    const sl = m.slide;
    if (sl && sl.angle) p.elements[12 + sl.axis] += sl.angle;
    if (d) d.pivot.matrixWorldNeedsUpdate = true;
    // (A mechanism without a model, 2 Cellblocks' ladder catch 18cc, still carries its group.)
    // The root's matrix is the placement itself (set directly, not composed from position /
    // rotation): recomposing it (updateMatrix) put a moving Mechanism with a model at the world
    // origin, 5b's hoist 2b42 / pulley 2b43 the moment their rope was shot.
    const at = d ? d.root.matrix : m.rec.w ? instanceMatrix(m.rec.w.e.position, m.rec.w.e.rotation) : undefined;
    if (at) this.moveGrouped(m.rec.uid, at, p);
  }

  private updateMech(m: Mech, dt: number) {
    const moving = this.stepGroup(m, dt);
    const sliding = !!m.slide && this.stepGroup(m.slide, dt);
    if (!moving && !sliding) return;
    this.poseMech(m);
    const d = m.rec.d;
    if (d && d.body !== undefined) {
      m.colAcc += dt;
      // A slide is a lift or a ladder: its body follows it at once.
      if (m.colAcc > 0.2 || sliding) {
        m.colAcc = 0;
        this.env.dyn.refreshCollision(d, true);
      }
    }
  }

  /** Advance one motion group; false when it is at rest. */
  private stepGroup(m: Mech, dt: number): boolean {
    if (!m.running) {
      m.vel = 0;
      return false;
    }
    if (m.endless) {
      m.vel = Math.min(m.speed, m.vel + m.accel * dt);
      m.angle = (m.angle + m.vel * dt * m.dir * (Math.sign(m.travel) || 1)) % 360;
    } else {
      const lo = Math.min(0, m.travel), hi = Math.max(0, m.travel);
      // dir +1 moves towards `travel`, -1 back to 0.
      const sgn = Math.sign(m.travel) || 1;
      const left = m.dir > 0 ? Math.abs(m.travel) - Math.abs(m.angle) : Math.abs(m.angle);
      m.vel = mechStep(m.vel, left, dt, m);
      m.angle += m.vel * dt * m.dir * sgn;
      if (m.angle >= hi || m.angle <= lo) {
        m.angle = Math.min(hi, Math.max(lo, m.angle));
        m.vel = 0;
        if (m.sweep) m.dir = -m.dir;
        else {
          m.running = false;
          this.mechSound(m.rec, 80);
          if (m.rec.w) this.env.world.fire(m.rec.w, mechArrivalOutput(m.base, m.angle, m.travel));
        }
      }
    }
    return true;
  }

  /**
   * Object Grouper [inferred from its init 0x101173c0 (it takes its first link as the leader
   * and keeps the others' offsets) and the data]: the objects linked after the first follow the
   * first one's motion. 2 Cellblocks 18cd: Mechanism 18cc (a 4.2 m drop) carries the Ladder 18cb.
   * Groupers have no message map: they receive nothing.
   */
  private moveGrouped(leader: number, at: THREE.Matrix4, pivot: THREE.Matrix4) {
    for (const g of this.env.world.of('Object Grouper')) {
      if (g.e.links[0] !== leader) continue;
      const motion = new THREE.Matrix4().multiplyMatrices(at, pivot).multiply(new THREE.Matrix4().copy(at).invert());
      for (const u of g.e.links.slice(1)) {
        const F = this.env.dyn.objects.get(u);
        if (!F) continue;
        // follower pivot = F^-1 * motion * F
        F.pivot.matrix.copy(F.root.matrix).invert().multiply(motion).multiply(F.root.matrix);
        F.pivot.matrixWorldNeedsUpdate = true;
        if (F.body !== undefined) this.env.dyn.refreshCollision(F, true);
      }
    }
  }

  /** World-space pose of a mechanism (security camera view). */
  mechMatrix(uid: number, out = new THREE.Matrix4()) {
    const r = this.recs.get(uid);
    if (r?.d) return out.multiplyMatrices(r.d.root.matrix, r.d.pivot.matrix);
    if (r?.w) return out.copy(instanceMatrix(r.w.e.position, r.w.e.rotation));
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Pushable

  /** Use on a pushable: grab / let go. */
  toggleGrab(uid: number): boolean {
    const p = this.pushes.get(uid);
    const pl = this.env.player();
    if (!p || !pl || !p.rec.d || p.rec.broken || (p.rec.w && !p.rec.w.enabled)) return false;
    if (p.grabbed) {
      this.release(p);
      return false;
    }
    // Push along the crate's local x or z axis, whichever points most at the crate from the player.
    const M = p.rec.d.root.matrix.elements;
    const c = new THREE.Vector3(M[12], M[13], M[14]);
    const to = c.clone().sub(pl.position).setY(0);
    const ax = new THREE.Vector3(M[0], 0, M[2]).normalize();
    const az = new THREE.Vector3(M[8], 0, M[10]).normalize();
    const axis = Math.abs(to.dot(ax)) > Math.abs(to.dot(az)) ? ax : az;
    if (to.dot(axis) < 0) axis.negate();
    p.axis.copy(axis);
    p.offset = to.dot(axis);
    p.grabbed = true;
    p.handled = true;
    // The crate's own collision would stop the player; the push test keeps it out of walls.
    if (p.rec.d.body !== undefined) this.env.collision?.setDynamicEnabled(p.rec.d.body, false);
    return true;
  }

  release(p: Push) {
    if (!p.grabbed) return;
    p.grabbed = false;
    p.restAcc = 1; // check its support on the next update
    p.sound?.stop();
    p.sound = undefined;
    if (p.moving && p.rec.w) this.env.world.fire(p.rec.w, 55);
    p.moving = false;
    if (p.rec.d) this.env.dyn.refreshCollision(p.rec.d, true);
  }

  grabbed(): number | undefined {
    for (const p of this.pushes.values()) if (p.grabbed) return p.rec.uid;
    return undefined;
  }

  private updatePush(p: Push, dt: number) {
    const d = p.rec.d;
    if (!d) return;
    // The Pushable class has no think of its own (vtable +0x18 is the empty 0x10128410; +0x20
    // runs the player's grab) [verified], so a crate nobody has moved stays where it was placed:
    // 9's lamp crank 9e1 rests inside the lamp mechanism, hidden (no collision) until the
    // player climbs up, and fell 33 m to the cave floor. One the player has moved still falls
    // off a ledge [inferred, the port's rule].
    if (!pushableMayFall(p)) return;
    // A resting crate (not held, not falling) checks its support 4 times a second, not every
    // frame: 32 crates' rays a frame were the largest garbage source left in 1b (§18).
    if (!p.grabbed && p.fallV === 0) {
      p.restAcc = (p.restAcc ?? 1) + dt;
      if (p.restAcc < 0.25) return;
      p.restAcc = 0;
    }
    const M = d.root.matrix.elements;
    const c = new THREE.Vector3(M[12], M[13], M[14]);
    const col = this.env.collision;
    // Falling off ledges.
    if (col && !p.grabbed) {
      const g = col.raycast(c.x, c.y + 0.3, c.z, 0, -1, 0, 0.3 + Math.max(0.05, p.fallV * dt + 0.05));
      if (!g) {
        p.fallV += 9.8 * dt;
        c.y -= p.fallV * dt;
        d.root.matrix.setPosition(c);
        d.root.matrixWorldNeedsUpdate = true;
        this.env.dyn.refreshCollision(d, true);
        return;
      }
      if (p.fallV > 0) {
        p.fallV = 0;
        c.y = g.point[1];
        d.root.matrix.setPosition(c);
        d.root.matrixWorldNeedsUpdate = true;
        this.env.dyn.refreshCollision(d, true);
      }
    }
    if (!p.grabbed) return;
    const pl = this.env.player();
    if (!pl) return this.release(p);
    const rel = c.clone().sub(pl.position).setY(0);
    const along = rel.dot(p.axis);
    const side = rel.clone().addScaledVector(p.axis, -along).length();
    if (side > 1.4 || Math.abs(along) > 3) return this.release(p);
    // The player walking into the crate pushes it; walking away pulls it.
    let delta = p.offset - along;
    delta = -delta;
    const speed = num(p.rec.values[45]) > 0 ? num(p.rec.values[45]) * 2 : 1.2;
    const max = speed * dt;
    let step = THREE.MathUtils.clamp(-delta, -max, max);
    if (Math.abs(step) < 1e-4) step = 0;
    if (step !== 0 && col) {
      // Sweep the crate's bounds (rays from its face) against the world.
      this.env.dyn.bounds(d, this.box);
      const size = this.box.getSize(new THREE.Vector3());
      const half = Math.abs(p.axis.x) * size.x * 0.5 + Math.abs(p.axis.z) * size.z * 0.5;
      const dir = p.axis.clone().multiplyScalar(Math.sign(step));
      const lateral = new THREE.Vector3(-dir.z, 0, dir.x);
      const lat = (Math.abs(lateral.x) * size.x + Math.abs(lateral.z) * size.z) * 0.45;
      let free = Math.abs(step);
      // Invisible Static Objects with p3 stop pushables (blockers.ts): the pushable layer.
      const layers = col.queryLayers;
      col.queryLayers = layers | COLLISION_LAYER.pushable;
      for (const sy of [0.15, 0.5, 0.85]) for (const sl of [-1, 0, 1]) {
        const o = c.clone().addScaledVector(dir, half - 0.02).addScaledVector(lateral, sl * lat);
        o.y = this.box.min.y + size.y * sy;
        const h = col.raycast(o.x, o.y, o.z, dir.x, 0, dir.z, free + 0.05);
        if (h) free = Math.min(free, Math.max(0, h.distance - 0.05));
      }
      col.queryLayers = layers;
      step = Math.sign(step) * free;
    }
    if (step !== 0) {
      c.addScaledVector(p.axis, step);
      d.root.matrix.setPosition(c);
      d.root.matrixWorldNeedsUpdate = true;
      if (!p.moving) {
        p.moving = true;
        if (p.rec.w) this.env.world.fire(p.rec.w, 53);
        const keys = refList(p.rec.values[51]).filter((x): x is ResRef => !!x).map(keyOf);
        if (keys.length) p.sound = this.env.playSound(keys, [c.x, c.y, c.z], { loop: true });
      }
    } else if (p.moving) {
      p.moving = false;
      p.sound?.stop();
      p.sound = undefined;
      if (p.rec.w) this.env.world.fire(p.rec.w, 55);
    }
    // Keep the player at the grab distance: not through the crate when pushing, and not running
    // off when pulling (the crate follows at its own speed, so walking away outran it and the
    // grab let go after 3 m: 1a's sally-port statue 8a46 could not be pulled out of the gate).
    const nowAlong = c.clone().sub(pl.position).setY(0).dot(p.axis);
    if (Math.abs(nowAlong - p.offset) > 0.02) {
      const fix = p.offset - nowAlong;
      pl.motor.position.x -= p.axis.x * fix;
      pl.motor.position.z -= p.axis.z * fix;
    }
    if (p.rec.w) p.rec.w.pos = [c.x, c.y, c.z];
  }

  pushablePositions(): ActorInfo[] {
    const out: ActorInfo[] = [];
    for (const p of this.pushes.values()) {
      if (p.rec.broken || !p.rec.d) continue;
      const e = p.rec.d.root.matrix.elements;
      // Held, or moved from its placement, the crate counts by its shape: it touches what it
      // overlaps (logic.ts occupants, filter 3), also where it is pressed against something that
      // stops it (5a's door crate against the junk under Detectors 231c / 231e / 231f) and where
      // it is left (5b: the caged projector 32f6 dragged into Detectors 3376 / 32fc keeps the
      // beam off while it stands there) [inferred]. Untouched, it counts by its middle.
      let bounds: ActorInfo['bounds'];
      const b0 = p.rec.d.base.elements;
      if (p.grabbed || Math.hypot(e[12] - b0[12], e[13] - b0[13], e[14] - b0[14]) > 0.01) {
        const b = this.env.dyn.bounds(p.rec.d, this.box);
        if (!b.isEmpty()) bounds = [[b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z]];
      }
      out.push({ uid: p.rec.uid, position: [e[12], e[13], e[14]], className: 'Pushable', bounds });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Morphing models

  private initMorph(w: WorldEntity) {
    const v = w.e.values;
    const def = morphingModelDef(v);
    // A template the create refuses (0x100d2c10) stays as placed.
    if (!def) return;
    let d = this.env.dyn.objects.get(w.uid);
    // No model of its own: the engine makes one from the current key model (0x100d2990).
    if (!d) {
      d = this.env.dyn.buildModel(w.uid, `${w.cls}#${w.uid.toString(16)}`, def.frames[0], instanceMatrix(w.e.position, w.e.rotation), { scale: w.e.scale, collides: false, lightAtLoad: true });
      if (d) this.env.dyn.objects.set(w.uid, d);
    }
    if (!d) return;
    const rec = this.recs.get(w.uid) ?? { uid: w.uid, cls: w.cls, values: v, w, d, health: 1, invulnerable: true, broken: false, resist: new Map<number, number>() };
    const targets = MorphTargets.attach(d, this.env.packages as unknown as PackageSet, def, w.e.scale);
    const m: Morph = { rec, def, m: new MorphMachine(def, w.visible), targets, dripTpl: w.cls === 'DripMorphingModel' ? (ref(v[25]) ?? undefined) : undefined };
    this.morphs.push(m);
    this.morphOf.set(w.uid, m);
  }

  private readonly morphOf = new Map<number, Morph>();

  private updateMorph(m: Morph, dt: number) {
    if (m.m.removed) return;
    const w = m.rec.w;
    const shown = !!w && w.visible && !w.destroyed && (!m.rec.d || m.rec.d.visible);
    const ev = m.m.think(dt, shown);
    this.morphResult(m, ev);
    m.drip?.update(dt);
    if (m.drip?.removed) m.drip = undefined;
  }

  /** Pose, outputs, spawns and removal after a think or an input. */
  private morphResult(m: Morph, ev: MorphEvents) {
    const w = m.rec.w;
    if (!m.m.removed) m.targets?.apply(m.m.pose, m.m.opacity);
    if (w) for (const slot of ev.fire) this.env.world.fire(w, slot);
    for (let i = 0; i < ev.spawn; i++) this.morphSpawn(m);
    if (ev.remove) {
      m.m.removed = true;
      m.drip?.remove();
      m.drip = undefined;
      if (w) this.env.world.destroy(w);
      else if (m.rec.d) this.env.dyn.setVisible(m.rec.d.uid, false);
    }
  }

  /** vt +0x4c: p12 at the object (0x100d25f0); a DripMorphingModel's drip (0x100a8b40). */
  private morphSpawn(m: Morph) {
    const d = m.rec.d;
    if (!d) return;
    d.root.updateMatrixWorld(true);
    if (m.def.spawn) this.env.fx.spawn(m.def.spawn, d.root.matrixWorld.clone());
    if (!m.dripTpl) return;
    if (!m.drip) {
      m.drip = Drip.spawn(
        {
          dyn: this.env.dyn,
          packages: this.env.packages,
          collision: this.env.collision,
          gravity: () => this.env.fx.gravity,
          waterAt: waterSurfaces.at ? (x, y, z) => waterSurfaces.at?.(x, y, z) : undefined,
          spawn: (r, M) => void this.env.fx.spawn(r, M),
        },
        m.dripTpl,
        d.root.matrixWorld,
      );
    }
    m.drip?.release();
  }

  // -------------------------------------------------------------------------
  // Instance Rendered Object [inferred]: p2 instance count, p1 random seed, p5..p6 scale range,
  // p7..p8 yaw range (deg), drawn with the object's model, scattered over its footprint
  // (template bounds x instance scale) and dropped onto the ground below.

  private initScatter(w: WorldEntity) {
    const e = w.e;
    if (!e.modelRef) return;
    const v = e.values;
    const n = Math.min(200, Math.max(0, num(v[2], 10)));
    if (!n) return;
    const proto = this.env.dyn.buildModel(0, `Instance Rendered Object#${w.uid.toString(16)}`, e.modelRef, new THREE.Matrix4(), { collides: false });
    if (!proto) return;
    proto.root.removeFromParent();
    let seed = num(v[1], 1) >>> 0 || 1;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const s = e.scale ?? [1, 1, 1];
    const b = e.bounds;
    const half = b ? [0, 1, 2].map((k) => Math.abs(b.boxAxes[k] + b.boxAxes[3 + k] + b.boxAxes[6 + k]) * 0.5 * s[k]) : [s[0] * 0.5, 0, s[2] * 0.5];
    const base = instanceMatrix(e.position, e.rotation);
    const o = new THREE.Vector3().setFromMatrixPosition(base);
    const R = new THREE.Matrix4().extractRotation(base);
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i++) {
      const local = new THREE.Vector3((rand() * 2 - 1) * half[0], 0, (rand() * 2 - 1) * half[2]).applyMatrix4(R);
      const p = o.clone().add(local);
      const g = this.env.collision?.raycast(p.x, p.y + 2, p.z, 0, -1, 0, 6);
      if (g) p.y = g.point[1];
      const yaw = THREE.MathUtils.degToRad(num(v[7]) + rand() * (num(v[8], 360) - num(v[7])));
      const sc = num(v[5], 1) + rand() * (num(v[6], 1) - num(v[5], 1));
      mats.push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sc, sc, sc)));
    }
    proto.pivot.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, mats.length);
      mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = proto.root.name;
      this.scatter.add(im);
    });
  }

  // -------------------------------------------------------------------------

  update(dt: number) {
    dt *= this.env.timeScale();
    for (const m of this.mechs.values()) this.updateMech(m, dt);
    for (const p of this.pushes.values()) if (!p.rec.broken) this.updatePush(p, dt);
    for (const m of this.morphs) this.updateMorph(m, dt);
  }

  // -------------------------------------------------------------------------
  // Save (provider 'props', level scope)

  save(): PropsSaveState {
    const s: PropsSaveState = { broken: [], health: {}, pushed: {}, mech: {}, housing: {}, morph: {}, inv: {} };
    for (const r of this.recs.values()) {
      if (r.spawned) continue;
      if (r.invulnerable !== startsInvulnerable(r.values)) s.inv![r.uid] = r.invulnerable ? 1 : 0;
      if (r.broken) s.broken.push(r.uid);
      else if (r.health !== num(r.values[0], 100)) s.health[r.uid] = Math.round(r.health * 100) / 100;
    }
    for (const p of this.pushes.values()) {
      if (p.rec.broken || !p.rec.d) continue;
      const e = p.rec.d.root.matrix.elements;
      const b = p.rec.d.base.elements;
      if (Math.hypot(e[12] - b[12], e[13] - b[13], e[14] - b[14]) > 0.01) s.pushed[p.rec.uid] = [e[12], e[13], e[14]];
      if (p.handled) (s.handled ??= []).push(p.rec.uid);
    }
    for (const m of this.mechs.values()) {
      const sl = m.slide;
      const slid = !!sl && (sl.angle !== 0 || sl.running !== (num(m.rec.values[27]) !== 0));
      if (m.angle || m.running !== (num(m.rec.values[37]) !== 0) || slid) s.mech[m.rec.uid] = sl ? [m.angle, m.dir, m.running ? 1 : 0, sl.angle, sl.dir, sl.running ? 1 : 0] : [m.angle, m.dir, m.running ? 1 : 0];
    }
    for (const [uid, h] of this.housings) if (!h.rec.broken && h.state !== housingStartState(h.rec.values)) s.housing[uid] = h.state;
    for (const m of this.morphs) {
      if (m.m.pristine) continue;
      s.morph[m.rec.uid] = m.m.off ? 0 : 1;
      (s.morphRun ??= {})[m.rec.uid] = m.m.save();
    }
    const gone = [...this.receivers].filter(([, r]) => r.broken).map(([uid]) => uid);
    if (gone.length) s.receivers = gone;
    return s;
  }

  load(s: PropsSaveState) {
    for (const r of this.recs.values()) if (!r.spawned) r.invulnerable = s.inv?.[r.uid] !== undefined ? !!s.inv[r.uid] : startsInvulnerable(r.values);
    for (const uid of s.broken ?? []) {
      const r = this.recs.get(uid);
      if (r && !r.broken) this.breakProp(r, undefined, true);
    }
    for (const [k, h] of Object.entries(s.health ?? {})) {
      const r = this.recs.get(Number(k));
      if (r) r.health = h;
    }
    // (Held once: it may fall from then on. The save matrix found it lost on a restore, route 2.)
    const handled = new Set(s.handled ?? []);
    for (const p of this.pushes.values()) {
      if (handled.has(p.rec.uid)) p.handled = true;
      else delete p.handled;
    }
    for (const [k, p] of Object.entries(s.pushed ?? {})) {
      const x = this.pushes.get(Number(k));
      if (!x?.rec.d) continue;
      x.rec.d.root.matrix.setPosition(p[0], p[1], p[2]);
      x.rec.d.root.matrixWorldNeedsUpdate = true;
      this.env.dyn.refreshCollision(x.rec.d, true);
      if (x.rec.w) x.rec.w.pos = [p[0], p[1], p[2]];
    }
    for (const [k, m] of Object.entries(s.mech ?? {})) {
      const x = this.mechs.get(Number(k));
      if (!x) continue;
      [x.angle, x.dir] = [m[0], m[1]];
      x.running = !!m[2];
      if (x.slide && m.length === 6) [x.slide.angle, x.slide.dir, x.slide.running] = [m[3], m[4], !!m[5]];
      this.poseMech(x);
      if (x.rec.d) this.env.dyn.refreshCollision(x.rec.d, true);
    }
    // Lamps: the saved state, else the start one; the lights restore their own (lights.ts load).
    for (const [uid, h] of this.housings) {
      if (h.rec.broken) continue;
      const v = s.housing?.[uid];
      const want = v === HOUSING_ON ? HOUSING_ON : v === HOUSING_OFF ? HOUSING_OFF : housingStartState(h.rec.values);
      if (h.state !== want) this.applyHousing(uid, want, false);
    }
    // Morphs: the saved state, else the start one (older saves hold only the on flag).
    for (const m of this.morphs) {
      if (m.m.removed) continue;
      m.drip?.remove();
      m.drip = undefined;
      m.m = new MorphMachine(m.def, m.m.shown);
      const run = s.morphRun?.[m.rec.uid];
      const on = s.morph?.[m.rec.uid];
      if (run) m.m.load(run);
      else if (on !== undefined) m.m.off = !on;
      m.targets?.apply(m.m.pose, m.m.opacity);
    }
    for (const uid of s.receivers ?? []) {
      const r = this.receivers.get(uid);
      if (r && !r.broken) this.breakProp(r, undefined, true);
    }
  }

  stats() {
    let broken = 0;
    for (const r of this.recs.values()) if (r.broken && !r.spawned) broken++;
    return { props: this.recs.size, broken, mechanisms: this.mechs.size, pushables: this.pushes.size, morphs: this.morphs.length, housings: this.housings.size };
  }

  dispose() {
    for (const p of this.pushes.values()) p.sound?.stop();
    this.scatter.removeFromParent();
  }
}

/** GameObject p3 = 1: the object starts invulnerable (RFL 0x100a3166) [verified]. */
export function startsInvulnerable(values: readonly unknown[]): boolean {
  return values[3] === 1;
}
