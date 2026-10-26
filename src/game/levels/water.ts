// Water Volume (class 0x029e9104, Ground Object, 4 bool properties): water surfaces.
//
// Data [verified over all 327 placed instances]: every Water Volume places a flat (or gently
// sloped) surface model of the World Common / chapter packages (7:600.., 25:111.., 28:194,
// 34:31..) at the water level, drawn with a layered water material (7:836..7:840: a base
// texture plus additive layers 7:393 / 7:394). A few (6b "The Beach" 7:501..) add skirts down
// to the bed. Beneath the open sea of 0 Prelude Docks / 10 Docks the bed is ~5.6 m down, the
// Quarry ponds 1.3..7.5 m, the Woods streams and the Beach surf 0.1..1.5 m.
//
// Code [verified, Suffering.rfl]: the class has no constructor or message map of its own (the
// factory, 0x10020451, makes a 12-byte data holder); the game tests "is a Water Volume" by class
// id in the bullet impact routine (0x100d1687: water hit flag), the BouncingObject touch code
// (0x1009a956: water does not count as a bounce), a touch handler at 0x10115103 and a scene
// trace that skips Detectors and Water Volumes (0x100c9548).
//
// The player in water [verified, Suffering.rfl; docs/levels.md §4.2]:
//   * Water does not hold anyone up. The player's per-frame query (0x1002cb50) collects his
//     movement proxy's contacts with the 20 classes of 0x101509c0 (Water Volume among them, the
//     filter 0x1002c340(1) only asks the narrow phase for a real contact). A contact whose object
//     is a Water Volume goes to his water-effects component (Player +0x66: 0x1002cefb ->
//     0x1013b330) and the loop moves on (jmp 0x1002d1b0): it is never dispatched (listener +0x3c /
//     +0x44), so the touch handler 0x1002bde0 that hands solid contacts to the EXE mover (proxy
//     vt+0x18 = 0x41ee40) never sees it. Characters do the same (0x10115103 -> 0x1013b330, then
//     out, before their mover component's 0x1009f480): they sink too (10 Docks kills Ground
//     Enemies on its sea bed, Detector 130c).
//   * The component (vtable 0x10150c28 on the Player, 0x10150c4c on Characters; owner props
//     p19..p24, the Player adds p25..p31):
//       - in water while a contact reports the surface (a ray from 100 m above the owner down the
//         water model, 0x1013ab60) above the feet: depth = surface - feet > 0 (0x1013b330); with no
//         water contact in a frame it is cleared, depth and timer too (0x1002d321). The contact
//         needs the proxy (Player p91 = Collider 2:44: foot sphere r 0.6, top 2.24 m) to cross
//         the surface;
//       - entering: the water Material Effects entry's p19 (an Object Generator, 4:1305 with its
//         splash sounds) at the surface, scale max(1, min(p24, |v| p22 (1 + p23 %)^depth)) = 1 for
//         the Player (p24 = 1) (0x1013aea0);
//       - per frame (0x1013b050): shallower than p21 (0.5 m) while running, nothing; else a
//         timer: running, every p19 (0.03 s) the entry's p16 (4:1288, the wake), otherwise every
//         (1 + rand) p20 (0.5..1 s) its p15 (4:1294, ripples), at the surface;
//       - footsteps (0x10042cd0): shallower than p21 the step is the water surface's own (the
//         entry's p1..p13 at the surface); deeper, only the sound p17 (to p25 = 1.5 m, 0x10120be0)
//         or p18 (deeper) at the feet;
//       - deeper than p25 he cannot run (0x10046230);
//       - deeper than p28 (2 m) he drowns: damage of his maximum health (vt+0x8c, so not while
//         invulnerable), the death clip p29 (System clip 325) instead of the collapse (0x1002e5c3),
//         the view pitch eased to p31 (15 deg) at p31 / p30 deg/s (0x10120a50);
//       - a landing in water scales the fall damage by (1 - p27 %)^depth (0x1002dbc4).
//   * Water Volume p0..p3 are read by no code of Suffering.rfl: the object is a 12-byte holder
//     (factory 0x10020451, vtable 0x1014e5c0 of default virtuals) [verified]. p1 = 1 marks the
//     sea / ocean volumes (Prelude, Docks, Beach, Bluff, Lighthouse, one in 5b), 0 the ponds and
//     streams [data]; what reads it, if anything, was not found [unknown]. The original draws
//     nothing under water (no such string or renderer path) [inferred].
//
// Port:
//   * the surfaces stay in the merged static geometry but are left out of its collision
//     (nonSolidObjectProviders -> MeshPart.solid = false): the player, NPCs, sight, shots and the
//     use ray pass them;
//   * WaterRuntime runs the Player's component above from his template (readPlayerWaterRules):
//     depth, splashes, ripples, the run limit (PlayerController.canRun), drowning;
//   * footsteps (fx/footsteps.ts) take the wading thresholds from `waterSurfaces.wade`; fall
//     damage (fx/system.ts) the depth from services.water.player.
//   * the contact is a vertical ray at the player's position against the surface meshes
//     [port: the original tests the proxy's spheres, 0.6 m wide at the feet].

import * as THREE from 'three/webgpu';
import type { SrscFile } from '../../formats/srsc';
import { instanceRotation, parseLevelObjects, WORLD_SCALE } from '../../formats/level';
import { readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import { findEntry, ODU_OBJECT, readModel, readTemplateWords, refKey, type PackageSet, type ResRef } from '../../formats/model';
import { waterSurfaces } from '../fx/surfaces';
import { nonSolidObjectProviders } from '../../app/loader';
import { CollisionWorld, type DynamicParts } from '../../app/physics';
import type { MeshPart } from '../../formats/types';
import type { World } from '../world/logic';
import { readMoverVolume } from '../actors/mover';

export const WATER_VOLUME = 0x029e9104;

/** The Player's water rules: his template's p19..p31 (2:5 values in brackets) [verified]. */
export interface PlayerWaterRules {
  /** p19: wake interval while running (s) [0.03]. */
  wakeInterval: number;
  /** p20: ripple interval standing / walking, times 1 + rand (s) [0.5]. */
  rippleInterval: number;
  /** p21: shallow water (m): surface footsteps, no ripples while running [0.5]. */
  shallow: number;
  /** p22..p24: entry splash scale: |v| p22 (1 + p23 %)^depth, clamped to 1..p24 [0.4, 10, 1]. */
  splashSpeed: number;
  splashDepthPct: number;
  splashMax: number;
  /** p25: deeper, no running and the deep wading step p18 (m) [1.5]. */
  deep: number;
  /** p27: fall damage x (1 - p27 %)^depth when landing in water [10]. */
  fallPct: number;
  /** p28: deeper, the player drowns (m) [2]. */
  drown: number;
  /** p29: the drowning death clip (System clip id) [325]. */
  drownClip: number;
  /** p30 / p31: the view pitch is eased to p31 deg at p31 / p30 deg/s [0.5, 15]. */
  drownPitchTime: number;
  drownPitch: number;
  /** Top of the movement proxy above the feet (Player p91, Collider 2:44): the contact ends deeper. */
  contactTop: number;
}

export const RETAIL_WATER_RULES: PlayerWaterRules = {
  wakeInterval: 0.03,
  rippleInterval: 0.5,
  shallow: 0.5,
  splashSpeed: 0.4,
  splashDepthPct: 10,
  splashMax: 1,
  deep: 1.5,
  fallPct: 10,
  drown: 2,
  drownClip: 325,
  drownPitchTime: 0.5,
  drownPitch: 15,
  contactTop: 2.239,
};

/** The rules from the Player's values (template 2:5 or the placed Player); retail defaults. */
export function readPlayerWaterRules(values: readonly PropValue[] | undefined, pkgs?: PackageSet): PlayerWaterRules {
  const n = (i: number, d: number) => (typeof values?.[i] === 'number' && Number.isFinite(values[i] as number) ? (values[i] as number) : d);
  const R = RETAIL_WATER_RULES;
  const clip = values?.[29];
  // Player p91 is his movement proxy (0x1002c6c0), a Collider like Character p42.
  let contactTop = R.contactTop;
  const proxy = values?.[91];
  if (pkgs && proxy && typeof proxy === 'object' && !Array.isArray(proxy) && 'pkg' in proxy) {
    const v: PropValue[] = [];
    v[42] = proxy;
    v[46] = 45;
    v[48] = 0;
    const m = readMoverVolume(pkgs, v);
    if (m && m.top > 0) contactTop = m.top;
  }
  return {
    wakeInterval: n(19, R.wakeInterval),
    rippleInterval: n(20, R.rippleInterval),
    shallow: n(21, R.shallow),
    splashSpeed: n(22, R.splashSpeed),
    splashDepthPct: n(23, R.splashDepthPct),
    splashMax: n(24, R.splashMax),
    deep: n(25, R.deep),
    fallPct: n(27, R.fallPct),
    drown: n(28, R.drown),
    drownClip: clip && typeof clip === 'object' && !Array.isArray(clip) && 'id' in clip ? (clip as ResRef).id : R.drownClip,
    drownPitchTime: n(30, R.drownPitchTime),
    drownPitch: n(31, R.drownPitch),
    contactTop,
  };
}

/**
 * The component's contact (0x1002cefb -> 0x1013b330): in water while the surface is above the
 * feet and the proxy still reaches it. `depth` = surface - feet.
 */
export function inWaterAt(depth: number, rules: Pick<PlayerWaterRules, 'contactTop'>): boolean {
  return depth > 0 && depth <= rules.contactTop;
}

/** Running is refused deeper than p25 (0x10046230). */
export function canRunAt(inWater: boolean, depth: number, rules: Pick<PlayerWaterRules, 'deep'>): boolean {
  return !(inWater && depth > rules.deep);
}

/** Drowned: in water deeper than p28 (0x10120a00). */
export function drownsAt(inWater: boolean, depth: number, rules: Pick<PlayerWaterRules, 'drown'>): boolean {
  return inWater && depth > rules.drown;
}

/** Fall damage factor of a landing in water (0x1002dbc4): (1 - p27 %)^depth, 1 out of water. */
export function waterFallFactor(inWater: boolean, depth: number, rules: Pick<PlayerWaterRules, 'fallPct'> = RETAIL_WATER_RULES): number {
  return inWater && depth > 0 ? Math.pow(1 - rules.fallPct / 100, depth) : 1;
}

/**
 * The step a footstep plays in water (0x10042cd0): the surface's own step (the entry's p1..p13
 * at the surface) in shallow water, else only the wading sound p17 (to p25) or p18 (deeper).
 */
export function wadingStep(depth: number, rules: Pick<PlayerWaterRules, 'shallow' | 'deep'>): 'surface' | 17 | 18 {
  return depth < rules.shallow ? 'surface' : depth > rules.deep ? 18 : 17;
}

/** Entry splash scale (0x1013aea0): max(1, min(p24, |v| p22 (1 + p23 %)^depth)). */
export function splashScale(speed: number, depth: number, rules: Pick<PlayerWaterRules, 'splashSpeed' | 'splashDepthPct' | 'splashMax'>): number {
  const x = Math.abs(speed) * rules.splashSpeed * Math.pow(1 + rules.splashDepthPct / 100, depth);
  return Math.max(1, Math.min(rules.splashMax, x));
}

/**
 * The ripple timer (0x1013b050), one frame: returns the entry property spawned now (15 ripples,
 * 16 the running wake) or null, and the new timer. Not in water the timer is 0 (0x1002d327).
 */
export function rippleStep(timer: number, dt: number, depth: number, running: boolean, rules: Pick<PlayerWaterRules, 'shallow' | 'wakeInterval' | 'rippleInterval'>, rand = Math.random): { timer: number; spawn: 15 | 16 | null } {
  if (depth < rules.shallow && running) return { timer, spawn: null };
  timer -= dt;
  if (timer > 0) return { timer, spawn: null };
  if (running) return { timer: rules.wakeInterval, spawn: 16 };
  return { timer: (1 + rand()) * rules.rippleInterval, spawn: 15 };
}

/** Placed Water Volume uids (cheap: one template read per distinct template). */
export function waterVolumeUids(lvl: SrscFile, packages: PackageSet): number[] {
  const isWater = new Map<string, boolean>();
  const out: number[] = [];
  for (const o of parseLevelObjects(lvl)) {
    const k = `${o.template.pkg}:${o.template.id}`;
    let w = isWater.get(k);
    if (w === undefined) isWater.set(k, (w = readObjectTemplate(packages as EntityPackageSet, o.template)?.classHash === WATER_VOLUME));
    if (w) out.push(o.uid);
  }
  return out;
}

if (!nonSolidObjectProviders.includes(waterVolumeUids)) nonSolidObjectProviders.push(waterVolumeUids);

export interface WaterService {
  /** Water surface height above (x, y, z) (within 12 m), if any. */
  surfaceAt(x: number, y: number, z: number): number | undefined;
  /**
   * Player state this frame: in water (the component's flag), depth of the feet below the
   * surface (0 when not in water), eyes under the surface, drowned.
   */
  readonly player: { inWater: boolean; depth: number; underwater: boolean; drowned: boolean };
  /** The Player's water rules (his template's p19..p31). */
  readonly rules: PlayerWaterRules;
}

/** Water's Material Type [data: every water material's Game Material Properties names 2:879]. */
export const WATER_MATERIAL_TYPE = '2:879';

const templateWords = (pkgs: PackageSet, r: ResRef) => {
  const f = pkgs.get(r.pkg)?.odu;
  const e = findEntry(f, ODU_OBJECT, r.id);
  return f && e ? readTemplateWords(f.data(e))?.words : undefined;
};

/**
 * Material Type of the level's water surfaces: material word 0 is its Game Material
 * Properties template, whose p0 is the Material Type (docs/game-logic.md §17.1).
 */
export function waterMaterialType(world: World, packages: PackageSet): string {
  for (const w of world.of('Water Volume')) {
    const m = w.e.modelRef && readModel(packages, w.e.modelRef);
    for (const r of m?.materials ?? []) {
      const gmp = templateWords(packages, r)?.[0];
      const g = gmp && gmp >>> 16 ? { id: gmp & 0xffff, pkg: gmp >>> 16 } : undefined;
      const type = g && templateWords(packages, g)?.[0];
      if (type && type >>> 16) return refKey({ id: type & 0xffff, pkg: type >>> 16 });
    }
  }
  return WATER_MATERIAL_TYPE;
}

/** Surfaces of the level's Water Volumes (output space), but those in `skip` (moving ones). */
export function waterSurfaceParts(world: World, packages: PackageSet, skip?: ReadonlySet<number>): MeshPart[] {
  const parts: MeshPart[] = [];
  for (const w of world.of('Water Volume')) {
    if (skip?.has(w.uid)) continue;
    const ref = w.e.modelRef;
    const m = ref && readModel(packages, ref);
    if (!m) continue;
    const R = instanceRotation(w.e.rotation);
    const s = w.e.scale ?? [1, 1, 1];
    const [ox, oy, oz] = [w.e.position[0] / WORLD_SCALE, w.e.position[1] / WORLD_SCALE, w.e.position[2] / WORLD_SCALE];
    const pos = new Float32Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i += 3) {
      const px = m.positions[i] * s[0], py = m.positions[i + 1] * s[1], pz = m.positions[i + 2] * s[2];
      pos[i] = ox + R[0] * px + R[1] * py + R[2] * pz;
      pos[i + 1] = oy + R[3] * px + R[4] * py + R[5] * pz;
      pos[i + 2] = oz + R[6] * px + R[7] * py + R[8] * pz;
    }
    const idx: number[] = [];
    for (const sm of m.submeshes) idx.push(...sm.indices);
    if (idx.length) parts.push({ positions: pos, indices: Uint32Array.from(idx) });
  }
  return parts;
}

/**
 * Water Volumes an Object Grouper moves with its first link (10's pipe-yard water 11aa / 11ab on
 * the Mechanisms 32d / 341, 5b's 3280 on 2d44): they are dynamic objects (world/dynamic.ts), and
 * their surfaces are bodies of the water world that follow them (MovingWater).
 */
export function groupedWaterUids(world: World): number[] {
  const out: number[] = [];
  for (const g of world.of('Object Grouper')) for (const u of g.e.links.slice(1)) if (world.get(u)?.cls === 'Water Volume') out.push(u);
  return out;
}

/** The grouped surfaces as bodies of the water world, re-placed when their object moves. */
export class MovingWater {
  private readonly bodies = new Map<number, { id: number; key: string }>();
  constructor(
    private readonly surfaces: CollisionWorld,
    private readonly parts: (uid: number) => DynamicParts | undefined,
    uids: readonly number[],
  ) {
    for (const u of uids) {
      const p = this.parts(u);
      if (p?.length) this.bodies.set(u, { id: surfaces.addDynamic(p), key: MovingWater.key(p) });
    }
  }
  get size() {
    return this.bodies.size;
  }
  private static key(p: DynamicParts) {
    const v = p[0].positions;
    return `${v[0]},${v[1]},${v[2]}`;
  }
  /** Follow the objects (a rising surface lifts with its Mechanism). */
  update() {
    for (const [u, b] of this.bodies) {
      const p = this.parts(u);
      if (!p?.length) continue;
      const k = MovingWater.key(p);
      if (k === b.key) continue;
      b.key = k;
      this.surfaces.updateDynamic(b.id, p);
    }
  }
}

/** Surfaces of the level's Water Volumes as one query world (output space). */
export function buildWaterWorld(world: World, packages: PackageSet, parts = waterSurfaceParts(world, packages)): CollisionWorld | undefined {
  return parts.length ? new CollisionWorld({ parts }) : undefined;
}

interface PlayerLike {
  readonly position: THREE.Vector3;
  eyePosition(): THREE.Vector3;
  pitch: number;
  /** Running allowed (PlayerController: deeper than p25 he walks). */
  canRun: boolean;
}

/** What the runtime needs from the game around it. */
export interface WaterEnv {
  /** Values of the player's water Material Effects entry (Player p145, p0 = the water's type). */
  entry(): readonly PropValue[] | undefined;
  /** Spawn an effect template at a point (scale: the entry splash's). */
  spawn(ref: ResRef, at: THREE.Vector3, scale?: number): void;
  /** The player is alive / running this frame (the gait's run flag, PlayerFrame.running). */
  alive(): boolean;
  running(): boolean;
  /** Horizontal speed (m/s), for the entry splash. */
  speed(): number;
  /** Drown the player: damage of his maximum health with the drowning death clip. */
  drown(clip: number): void;
  /** The ripple interval's random factor (0..1); Math.random when absent (tests pass a fixed one). */
  random?(): number;
}

const refOf = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in v ? (v as ResRef) : undefined);

/** Per-frame player-in-water logic: the Player's water-effects component (see the header). */
export class WaterRuntime implements WaterService {
  readonly player = { inWater: false, depth: 0, underwater: false, drowned: false };
  private timer = 0;
  private clock = 0;
  private drownPitch: { target: number; rate: number } | null = null;
  /** Event log (tests / debug). */
  readonly events: { t: number; kind: 'enter' | 'leave' | 'ripple' | 'wake' | 'drown'; at: number[]; depth: number }[] = [];

  constructor(
    private readonly surfaces: CollisionWorld,
    private readonly body: PlayerLike,
    private readonly active: () => boolean,
    readonly rules: PlayerWaterRules = RETAIL_WATER_RULES,
    private readonly env?: WaterEnv,
    materialType = WATER_MATERIAL_TYPE,
  ) {
    waterSurfaces.at = (x, y, z) => this.surfaceAt(x, y, z);
    waterSurfaces.type = materialType;
    waterSurfaces.wade = { shallow: rules.shallow, deep: rules.deep };
  }

  surfaceAt(x: number, y: number, z: number): number | undefined {
    // Highest surface within 12 m above the point (deepest sea bed is ~6 m down).
    const hit = this.surfaces.raycast(x, y + 12, z, 0, -1, 0, 12.05);
    return hit ? hit.point[1] : undefined;
  }

  update(dt: number) {
    this.clock += dt;
    const p = this.body.position;
    const pl = this.player;
    const on = this.active();
    const s = on ? this.surfaceAt(p.x, p.y, p.z) : undefined;
    const depth = s !== undefined ? s - p.y : 0;
    const was = pl.inWater;
    const inWater = s !== undefined && inWaterAt(depth, this.rules);
    pl.inWater = inWater;
    pl.depth = inWater ? depth : 0;
    const at = new THREE.Vector3(p.x, s ?? p.y, p.z);
    if (inWater && !was) {
      // 0x1013aea0: the entry's p19 at the surface.
      this.log('enter', at, depth);
      const fx = refOf(this.env?.entry()?.[19]);
      if (fx) this.env!.spawn(fx, at, splashScale(this.env!.speed(), depth, this.rules));
    } else if (!inWater && was && on) this.log('leave', at, depth);
    if (!inWater) this.timer = 0;
    else if (this.env?.alive()) {
      const r = rippleStep(this.timer, dt, depth, this.env.running(), this.rules, this.env.random ?? Math.random);
      this.timer = r.timer;
      if (r.spawn) {
        this.log(r.spawn === 16 ? 'wake' : 'ripple', at, depth);
        const fx = refOf(this.env.entry()?.[r.spawn]);
        if (fx) this.env.spawn(fx, at);
      }
    }
    this.body.canRun = canRunAt(inWater, depth, this.rules);
    if (on && drownsAt(inWater, depth, this.rules) && this.env?.alive()) {
      // 0x10120a50: every frame while deeper than p28; an invulnerable player takes nothing and
      // gets no pitch ease (bit 0x2f is set only when neither +0x1e nor +0xe is).
      this.env.drown(this.rules.drownClip);
      if (!this.env.alive()) {
        pl.drowned = true;
        this.log('drown', at, depth);
        const D = Math.PI / 180;
        this.drownPitch = { target: this.rules.drownPitch * D, rate: this.rules.drownPitchTime > 0 ? (this.rules.drownPitch / this.rules.drownPitchTime) * D : Infinity };
      }
    } else if (pl.drowned && this.env?.alive()) {
      // Revived (a checkpoint restore): the drowning is over.
      pl.drowned = false;
      this.drownPitch = null;
    }
    if (this.drownPitch) {
      const d = this.drownPitch.target - this.body.pitch;
      const step = this.drownPitch.rate * dt;
      this.body.pitch = Math.abs(d) <= step ? this.drownPitch.target : this.body.pitch + Math.sign(d) * step;
    }
    const eye = this.body.eyePosition();
    pl.underwater = s !== undefined && eye.y < s - 0.05 && p.y < s;
  }

  private log(kind: WaterRuntime['events'][number]['kind'], at: THREE.Vector3, depth: number) {
    this.events.push({ t: +this.clock.toFixed(2), kind, at: at.toArray().map((x) => +x.toFixed(2)), depth: +depth.toFixed(2) });
    if (this.events.length > 40) this.events.shift();
  }

  dispose() {
    this.body.canRun = true;
    if (waterSurfaces.at) {
      delete waterSurfaces.at;
      delete waterSurfaces.type;
      delete waterSurfaces.wade;
    }
  }
}
