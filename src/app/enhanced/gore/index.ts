// Enhanced mode blood and gore (docs/enhanced.md "Gore"). Opt-in with Enhanced mode; Original
// never loads this (the listener slot game/fx/gore-bus.ts stays null there).
//
// It keeps to what the game already depicts — the blood of blows, Blood Point Generators,
// BloodPools, Part Cap stumps, gibs and blood fountains — and makes it physically grounded:
//
//   decals.ts   wet blood films on the level (spatters shaped by their impact, drops, trails,
//               pools spreading over the floor), drying from glossy red to matte brown-black
//   droplets.ts heavy drops in flight with drag, streaked by their motion, glinting in the beam
//   wounds.ts   wounds on bodies where they were struck, soaking into the clothes
//   screen.ts   the edges of the view closing in red-black when the player is badly hurt
//   blood.ts    the blood model (colours, drying, pool spreading, impact shapes): CPU twins
//   splats.ts   the procedural splat atlas
//   ring.ts     the decal budget (one ring buffer per kind, oldest recycled)
//   config.ts   per-tier budgets
//
// Game events arrive through the gore listener (fx/system.ts, fx/effects.ts, world/fx.ts,
// actors/dismember.ts, actors/system.ts); per frame it follows the actors (pools under the dead,
// trails under the bleeding), the stump spurts and the blood fountains' drips.

import * as THREE from 'three/webgpu';
import { Decals } from '../../../game/fx/decals';
import { gore, type GoreActor, type GoreEnv, type GoreFountain, type GoreListener } from '../../../game/fx/gore-bus';
import { warmObjects } from '../../prewarm';
import type { QualityTier } from '../config';
import type { EnhancedStage, EnhancedStageHook } from '../post';
import { impactShape, stainSize } from './blood';
import { GORE_TIERS, type GoreTier } from './config';
import { FilmBatch, atlasTexture, filmMaterial, goreBump, goreTime } from './decals';
import { Droplets } from './droplets';
import { hurt, hurtLevel, hurtStage } from './screen';
import { SPLAT_TILES, buildSplatAtlas, type SplatKind } from './splats';
import { Wounds } from './wounds';

const MAX = GORE_TIERS.ultra;
const GORE_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gore') === '0';

interface ActorState {
  alive: boolean;
  /** Game time of the last blood drawn on it. */
  bloodied: number;
  /** Game time of the last blow drawn (shotgun pellets, hazards every frame: merged). */
  hitAt: number;
  diedAt: number;
  pooled: boolean;
  cut: boolean;
  lastDrop: THREE.Vector3;
  dropAt: number;
  /** Drops left standing in one place (a few, then the trail waits for it to move). */
  still: number;
}

interface Spurt {
  bone: THREE.Object3D;
  start: number;
  until: number;
  next: number;
}

interface FountainDrips {
  f: GoreFountain;
  floor: { y: number; n: THREE.Vector3; part: number } | null;
  probeAt: number;
  dripAt: number;
  drips: number;
  pool: boolean;
  /** The body it bleeds from got its wound. */
  wounded: boolean;
}

export interface GoreHost {
  readonly tier: QualityTier;
  addStage(stage: EnhancedStage, hook: EnhancedStageHook): () => void;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const UP = new THREE.Vector3(0, 1, 0);

export class EnhancedGore implements GoreListener {
  private env: GoreEnv | null = null;
  private tierName: QualityTier;
  tier: GoreTier;
  time = 0;
  private atlas: THREE.DataTexture | null = null;
  private material: THREE.Material | null = null;
  spatter: FilmBatch | null = null;
  pools: FilmBatch | null = null;
  droplets: Droplets | null = null;
  readonly wounds: Wounds;
  private readonly group = new THREE.Group();
  private readonly actors = new Map<GoreActor, ActorState>();
  private spurts: Spurt[] = [];
  private fountains: FountainDrips[] = [];
  private readonly landed = new WeakSet<object>();
  private readonly redTex = new Map<string, number>();
  private warm: THREE.Object3D[] = [];
  private playerHealth = -1;
  private attachedAt = 0;
  readonly stats = { hits: 0, sprays: 0, pools: 0, cuts: 0, gibs: 0, wounds: 0, splats: 0, fountains: 0, drips: 0, deathPools: 0, trails: 0 };

  constructor(private readonly host: GoreHost) {
    this.tierName = host.tier;
    this.tier = GORE_TIERS[this.tierName];
    this.wounds = new Wounds(this.tier.bodies, this.tier.woundsPerBody);
    this.group.name = 'gore';
    // `?gore=0` (QA, before / after frames): Enhanced without its gore, the faithful blood as is.
    if (GORE_OFF) return;
    host.addStage('beforeGrade', (c) => hurtStage(c));
    gore.listener = this;
  }

  // ---------------------------------------------------------------------------------------------
  // Level

  attach(env: GoreEnv) {
    this.detach();
    this.env = env;
    if (!this.atlas) {
      this.atlas = atlasTexture(buildSplatAtlas());
      this.material = filmMaterial(this.atlas);
      this.spatter = new FilmBatch('gore-spatter', this.material, MAX.decalVerts, this.tier.decalVerts, this.tier.decals);
      this.pools = new FilmBatch('gore-pools', this.material, MAX.poolVerts, this.tier.poolVerts, this.tier.pools);
      this.droplets = new Droplets(MAX.droplets, this.tier.droplets);
      this.droplets.onLand = (p, n, v, r) => this.land(p, n, v, r);
      this.group.add(this.pools.mesh, this.spatter.mesh, this.droplets.mesh);
      this.warmUp();
    }
    this.applyTier(true);
    this.attachedAt = this.time;
    env.scene.add(this.group);
  }

  /** Hidden stand-ins so the film and droplet pipelines compile with the level (prewarm.ts). */
  private warmUp() {
    const g = new THREE.BufferGeometry();
    const tri = [0, 0, 0, 0.01, 0, 0, 0, 0, 0.01];
    g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    g.setAttribute('gore', new THREE.Float32BufferAttribute(new Array(12).fill(0), 4));
    const film = new THREE.Mesh(g, this.material!);
    film.name = 'gore-warm';
    this.warm = [film];
    for (const o of this.warm) warmObjects.add(o);
  }

  detach() {
    this.group.removeFromParent();
    this.spatter?.clear();
    this.pools?.clear();
    this.droplets?.clear();
    this.wounds.clear();
    this.actors.clear();
    this.spurts = [];
    this.fountains = [];
    this.playerHealth = -1;
    hurt.level.value = 0;
    hurt.pulse.value = 0;
    this.env = null;
  }

  private applyTier(force = false) {
    const t = this.host.tier;
    if (!force && t === this.tierName) return;
    this.tierName = t;
    this.tier = GORE_TIERS[t];
    this.spatter?.resize(this.tier.decalVerts, this.tier.decals);
    this.pools?.resize(this.tier.poolVerts, this.tier.pools);
    if (this.droplets) this.droplets.limit = Math.min(this.tier.droplets, this.droplets.cap);
    this.wounds.setBudget(this.tier.bodies, this.tier.woundsPerBody);
    goreBump.value = this.tier.bump ? 1 : 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers

  /** Baked light C near a point (the level part under it); a dim default where none is found. */
  private lightNear(p: THREE.Vector3Like): { r: number; g: number; b: number } {
    const env = this.env!;
    const col = env.collision();
    const h = col?.raycast(p.x, p.y + 0.05, p.z, 0, -1, 0, 4);
    const c = h ? env.lightAt(p, [h.part]) : null;
    if (!c || (c.r === 1 && c.g === 1 && c.b === 1)) return { r: 0.22, g: 0.22, b: 0.22 };
    return c;
  }

  /**
   * Project a film of `kind` onto the level at `point` (normal `n`): `w` along the decal's +U
   * (the way the blood travelled, `angle`), `h` across.
   */
  private paint(batch: FilmBatch | null, kind: SplatKind, point: THREE.Vector3, n: THREE.Vector3, w: number, h: number, angle: number, o: { tau?: number; opacity?: number; relief?: number; depth?: number } = {}): boolean {
    const drawn = this.env?.drawn();
    if (!batch || !drawn) return false;
    const parts = new Set<number>();
    const geo = Decals.project(drawn, point, n, w, h, angle, o.depth ?? Math.max(0.05, Math.min(w, h) * 0.5), parts);
    if (!geo) return false;
    let light = this.env!.lightAt(point, parts);
    if (light.r === 1 && light.g === 1 && light.b === 1) light = this.lightNear(point);
    const ok = batch.add({ positions: geo.getAttribute('position').array, uvs: geo.getAttribute('uv').array }, pick(SPLAT_TILES[kind]), light, n, [this.time, o.tau ?? 0, o.opacity ?? 1, o.relief ?? 0.0015]);
    geo.dispose();
    if (ok) this.stats.splats++;
    return ok;
  }

  /** A drop landed: a stain elongated by its impact angle, pointing the way it flew. */
  private land(p: THREE.Vector3, n: THREE.Vector3, v: THREE.Vector3, r: number) {
    const s = impactShape(v, n, 4);
    const size = stainSize(r, v.length()) * 1.6;
    this.paint(this.spatter, s.elongation > 1.6 ? 'impact' : 'drop', p, n, size * (s.elongation > 1.6 ? 0.55 + 0.45 * s.elongation : 1), size, s.angle, { relief: 0.0012 });
  }

  /** Throw `count` drops from `at` around `dir` (cone half-angle `spread`, speeds, radius scale). */
  private throwDrops(at: THREE.Vector3, dir: THREE.Vector3, count: number, spread: number, speed: [number, number], rScale = 1) {
    const d = this.droplets;
    if (!d || !this.env) return;
    const light = this.lightNear(at);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    for (let i = 0; i < count; i++) {
      // Uniform in the cone.
      const ct = 1 - Math.random() * (1 - Math.cos(spread));
      const st = Math.sqrt(1 - ct * ct), ph = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(st * Math.cos(ph), st * Math.sin(ph), ct).applyQuaternion(q).multiplyScalar(rnd(speed[0], speed[1]));
      // Mostly small drops, a few heavy ones (0.7-6 mm).
      const r = (0.0007 + 0.0053 * Math.pow(Math.random(), 2)) * rScale;
      d.spawn({ p: at, v, r, light, splat: Math.random() < this.tier.landSplats || r > 0.003 });
    }
  }

  /** The nearest body (alive or dead) whose skin is near `p`. */
  private bodyNear(p: THREE.Vector3): GoreActor | undefined {
    let best: GoreActor | undefined, bd = 1.2;
    for (const a of this.env?.actors() ?? []) {
      if (a.hidden || !a.ch?.root.visible || !(a.ch.mesh as THREE.SkinnedMesh).isSkinnedMesh) continue;
      const lo = a.bottom ?? a.position.y - 0.1, hi = lo + (a.height ?? 1.9) + 0.2;
      if (p.y < lo - 0.3 || p.y > hi) continue;
      const d = Math.hypot(p.x - a.position.x, p.z - a.position.z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  private stateOf(a: GoreActor): ActorState {
    let s = this.actors.get(a);
    if (!s) this.actors.set(a, (s = { alive: a.alive, bloodied: -1e9, hitAt: -1e9, diedAt: NaN, pooled: !a.alive, cut: false, lastDrop: new THREE.Vector3(a.position.x, a.position.y, a.position.z), dropAt: 0, still: 0 }));
    return s;
  }

  private wound(p: THREE.Vector3, radius: number, strength: number): GoreActor | undefined {
    const a = this.bodyNear(p);
    if (!a) return undefined;
    if (this.wounds.add(a.ch.mesh as THREE.SkinnedMesh, p, radius, strength, this.time)) this.stats.wounds++;
    this.stateOf(a).bloodied = this.time;
    return a;
  }

  // ---------------------------------------------------------------------------------------------
  // Events (gore-bus.ts)

  hit(point: THREE.Vector3, dir: THREE.Vector3, amount: number): boolean {
    if (!this.env) return false;
    this.stats.hits++;
    // Blows on the same body within 0.15 s (pellets, a hazard every frame) add less.
    const body = this.bodyNear(point);
    const st = body ? this.stateOf(body) : null;
    const share = st && this.time - st.hitAt < 0.15 ? 0.25 : 1;
    if (st) st.hitAt = this.time;
    const k = Math.max(0.3, Math.min(3, amount));
    const d = dir.clone().setY(0);
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
    d.normalize();
    this.wound(point, 0.045 + 0.025 * Math.min(2, k), 0.6 + 0.3 * Math.min(2, k));
    // The exit spray (away from the attacker, slightly up) and a little back-spatter.
    const fwd = d.clone().add(new THREE.Vector3(0, rnd(0.05, 0.3), 0)).normalize();
    const n = Math.round(this.tier.dropletsPerHit * k * share);
    this.throwDrops(point, fwd, n, 0.45, [1.5, 5.5]);
    this.throwDrops(point, d.clone().negate().add(new THREE.Vector3(0, 0.3, 0)).normalize(), Math.max(1, Math.round(n * 0.15)), 0.6, [0.6, 2]);
    // The stain on what is right behind (fx/system.ts bloodNear's ray, 2.5 m): an impact spatter
    // stretched by the angle it arrives at.
    const col = this.env.collision();
    const h = share < 1 && Math.random() > 0.3 ? null : col?.raycast(point.x, point.y, point.z, d.x, d.y, d.z, 2.5);
    let painted = false;
    if (h) {
      const p = new THREE.Vector3(...h.point), nn = new THREE.Vector3(...h.normal);
      const s = impactShape(fwd.clone().multiplyScalar(4), nn, 3);
      const size = (0.32 + 0.22 * k) * (1 - 0.35 * Math.min(1, h.distance / 2.5));
      painted = this.paint(this.spatter, 'impact', p, nn, size * (0.7 + 0.3 * s.elongation), size, s.angle, { relief: 0.0015 });
    }
    if (!painted && share === 1 && col) {
      // Nothing right behind (or a door, a prop: no films on dynamic bodies, as the original's
      // decals): the bulk of the spray comes down on the floor a metre or two on,
      // its stain stretched the way it flew.
      const reach = rnd(0.8, 1.6) * Math.min(1.5, 0.7 + 0.3 * k);
      const f = col.raycast(point.x + d.x * reach, point.y, point.z + d.z * reach, 0, -1, 0, 3);
      if (f) {
        const nn = new THREE.Vector3(...f.normal);
        const s = impactShape(new THREE.Vector3(d.x * 3, -3, d.z * 3), nn, 3);
        const size = 0.3 + 0.15 * k;
        this.paint(this.spatter, 'impact', new THREE.Vector3(...f.point), nn, size * (0.7 + 0.3 * s.elongation), size, s.angle, { relief: 0.0015 });
      }
    }
    // What runs off the wound drips straight down under it.
    const u = share === 1 ? col?.raycast(point.x, point.y, point.z, 0, -1, 0, 2.5) : null;
    if (u) {
      const size = rnd(0.07, 0.13) * Math.min(1.5, k);
      this.paint(this.spatter, 'drop', new THREE.Vector3(...u.point), new THREE.Vector3(...u.normal), size, size, Math.random() * 7, { relief: 0.0012 });
    }
    return true;
  }

  spray(v: readonly unknown[], M: THREE.Matrix4): boolean {
    if (!this.env) return false;
    this.stats.sprays++;
    const num = (x: unknown, dv: number) => (typeof x === 'number' && Number.isFinite(x) ? x : dv);
    const at = new THREE.Vector3().setFromMatrixPosition(M);
    const fwd = new THREE.Vector3().setFromMatrixColumn(M, 2).negate();
    const el = THREE.MathUtils.degToRad((num(v[0], 5) + num(v[1], 10)) / 2);
    const reach = Math.max(0.5, Math.min(6, num(v[2], 3)));
    const spread = THREE.MathUtils.degToRad(Math.min(360, num(v[3], 360)));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize().multiplyScalar(Math.cos(el)).add(new THREE.Vector3(0, Math.sin(el), 0)).normalize();
    const speed = Math.sqrt(reach * 9.8);
    this.wound(at, 0.05, 0.8);
    this.throwDrops(at, fwd, Math.round(this.tier.dropletsPerHit * Math.min(2, reach / 2)), Math.min(Math.PI, spread / 2), [speed * 0.4, speed]);
    return true;
  }

  pool(point: THREE.Vector3, normal: THREE.Vector3, size: number, grow: number, opacity: number): boolean {
    if (!this.env) return false;
    this.stats.pools++;
    return this.paint(this.pools, 'pool', point, normal, size, size, Math.random() * Math.PI * 2, { tau: Math.max(2, grow / 2.5), opacity, relief: 0.003, depth: 0.25 }) || true;
  }

  cut(bone: THREE.Object3D, body: THREE.Object3D) {
    if (!this.env) return;
    this.stats.cuts++;
    for (const a of this.env.actors()) if (a.ch.root === body) this.stateOf(a).cut = true;
    const p = bone.getWorldPosition(new THREE.Vector3());
    this.wound(p, 0.09, 1.3);
    this.spurts.push({ bone, start: this.time, until: this.time + 7, next: this.time });
  }

  gib(M: THREE.Matrix4) {
    if (!this.env) return;
    this.stats.gibs++;
    const at = new THREE.Vector3().setFromMatrixPosition(M);
    this.throwDrops(at, UP, this.tier.dropletsPerHit * 4, Math.PI * 0.55, [2.5, 8], 1.3);
    const col = this.env.collision();
    // Spatter on what is around (mostly the floor and the walls near it).
    for (let i = 0; i < 9; i++) {
      const dir = new THREE.Vector3(rnd(-1, 1), rnd(-1, 0.25), rnd(-1, 1)).normalize();
      const h = col?.raycast(at.x, at.y, at.z, dir.x, dir.y, dir.z, 3.2);
      if (!h) continue;
      const nn = new THREE.Vector3(...h.normal);
      const s = impactShape(dir, nn, 3);
      const size = rnd(0.45, 0.85) * (1 - 0.4 * h.distance / 3.2);
      this.paint(this.spatter, i % 3 === 2 ? 'castoff' : 'impact', new THREE.Vector3(...h.point), nn, size * (0.7 + 0.3 * s.elongation), size, s.angle, { relief: 0.002 });
    }
    const f = col?.raycast(at.x, at.y + 0.3, at.z, 0, -1, 0, 4);
    if (f) this.paint(this.pools, 'pool', new THREE.Vector3(...f.point), new THREE.Vector3(...f.normal), rnd(1.1, 1.5), rnd(1.1, 1.5), Math.random() * 7, { tau: 6, relief: 0.003, depth: 0.25 });
  }

  fountain(f: GoreFountain, textures: readonly (THREE.Texture | null)[]) {
    if (!this.isBlood(f, textures)) return;
    this.stats.fountains++;
    // Heavier, darker blood: the lit colour (p33 × the light) is pulled down and towards red.
    f.goreTint = new THREE.Color(0.7, 0.5, 0.5);
    this.fountains.push({ f, floor: null, probeAt: 0, dripAt: 0, drips: 0, pool: false, wounded: false });
  }

  /** A blood fountain: p33 × its texture's mean colour is clearly red [inferred]. */
  private isBlood(f: GoreFountain, textures: readonly (THREE.Texture | null)[]): boolean {
    const c = (typeof f.v[33] === 'number' ? f.v[33] : 0xffffff) >>> 0;
    const pr = ((c >> 16) & 255) / 255, pg = ((c >> 8) & 255) / 255, pb = (c & 255) / 255;
    let r = 0, g = 0, b = 0, n = 0;
    for (const t of textures) {
      const m = t ? this.meanColour(t) : null;
      if (!m) continue;
      r += m[0]; g += m[1]; b += m[2]; n++;
    }
    if (!n) return false;
    r = (r / n) * pr; g = (g / n) * pg; b = (b / n) * pb;
    return r > 0.06 && r > 2.5 * g && r > 2.5 * b;
  }

  private meanColour(t: THREE.Texture): [number, number, number] | null {
    const img = t.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
    const d = img?.data;
    if (!d || !img?.width || !img.height) return null;
    const key = t.source.uuid;
    const cached = this.redTex.get(key);
    if (cached !== undefined) return [((cached >> 16) & 255) / 255, ((cached >> 8) & 255) / 255, (cached & 255) / 255];
    const step = Math.round(d.length / (img.width * img.height));
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += step * 4) {
      const a = step === 4 ? d[i + 3] / 255 : 1;
      r += d[i] * a; g += d[i + 1] * a; b += d[i + 2] * a; w += a;
    }
    if (!w) return null;
    const out: [number, number, number] = [r / w / 255, g / w / 255, b / w / 255];
    this.redTex.set(key, (Math.round(out[0] * 255) << 16) | (Math.round(out[1] * 255) << 8) | Math.round(out[2] * 255));
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame

  update(dt: number) {
    if (!this.env) return;
    this.applyTier();
    this.time += dt;
    goreTime.value = this.time;
    if (dt > 0) {
      this.updateActors();
      this.updateSpurts();
      this.updateFountains();
      this.droplets?.update(Math.min(dt, 0.05), this.env.collision());
    }
    this.wounds.update();
    this.spatter?.flush();
    this.pools?.flush();
    this.updateHurt(dt);
    const cam = this.env.camera as THREE.PerspectiveCamera;
    const H = typeof window !== 'undefined' ? Math.max(1, window.innerHeight) : 720;
    if (this.droplets && cam.isPerspectiveCamera) this.droplets.pxScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / H;
  }

  private updateHurt(dt: number) {
    const p = this.env?.player();
    if (!p) return;
    if (this.playerHealth >= 0 && p.health < this.playerHealth - 0.5) hurt.pulse.value = Math.min(1, (hurt.pulse.value as number) + (this.playerHealth - p.health) / 30);
    this.playerHealth = p.health;
    hurt.pulse.value = (hurt.pulse.value as number) * Math.exp(-dt / 0.45);
    const target = p.alive ? hurtLevel(p.health, p.maxHealth) : 1;
    hurt.level.value = (hurt.level.value as number) + (target - (hurt.level.value as number)) * Math.min(1, dt * 3);
  }

  private updateActors() {
    const env = this.env!;
    const col = env.collision();
    for (const a of env.actors()) {
      const s = this.stateOf(a);
      if (s.alive && !a.alive) {
        s.alive = false;
        s.diedAt = this.time;
      } else if (!s.alive && a.alive) {
        // Resurrected (Killjoy): a new body as far as the blood goes.
        s.alive = true;
        s.pooled = false;
      }
      // A pool under the dead: blood drawn on it lately, a cut, or a scripted kill (no blow).
      // Bodies placed dead (they turn into corpses as the level starts) keep the level's own
      // blood decorations.
      if (!a.alive && !s.pooled && this.time - s.diedAt > 1.2 && a.ch.root.visible && !a.hidden) {
        s.pooled = true;
        if (s.diedAt - this.attachedAt > 3 && (this.time - s.bloodied < 15 || s.cut || s.bloodied < -1e8)) this.deathPool(a);
      }
      // Trails: the bleeding (Part Cap bleed, or bloodied and below a third of their health);
      // posed bodies do not bleed (dismember.ts).
      const bleeding = a.behavior?.kind !== 'dormant' && ((a.bleed ?? 0) > 0 || (this.time - s.bloodied < 30 && (a.health ?? 1) / Math.max(1, a.maxHealth ?? 1) < 0.34));
      if (a.alive && this.tier.trails && bleeding && col) {
        const moved = Math.hypot(a.position.x - s.lastDrop.x, a.position.z - s.lastDrop.z);
        if (moved > 0.45) s.still = 0;
        if (moved > 0.45 || (this.time - s.dropAt > 1.6 && s.still < 4 && (a.bleed ?? 0) > 0)) {
          if (moved <= 0.45) s.still++;
          s.lastDrop.set(a.position.x, a.position.y, a.position.z);
          s.dropAt = this.time;
          const x = a.position.x + rnd(-0.12, 0.12), z = a.position.z + rnd(-0.12, 0.12);
          const h = col.raycast(x, (a.bottom ?? a.position.y) + 0.6, z, 0, -1, 0, 2);
          if (h) {
            const size = rnd(0.05, 0.1) * (moved > 0.45 ? 1 : 1.5);
            this.paint(this.spatter, 'drop', new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), size, size, Math.random() * 7, { relief: 0.001 });
            this.stats.trails++;
          }
        }
      }
    }
    for (const a of this.actors.keys()) if (!a.ch.root.parent) this.actors.delete(a);
  }

  /** The pool under a dead body, centred under its bones, spreading over a minute. */
  private deathPool(a: GoreActor) {
    const col = this.env!.collision();
    const bones = a.ch.skeleton?.bones ?? [];
    const c = new THREE.Vector3();
    let n = 0;
    const v = new THREE.Vector3();
    for (const b of bones) {
      b.getWorldPosition(v);
      c.add(v);
      n++;
    }
    if (n) c.divideScalar(n);
    else c.set(a.position.x, a.position.y, a.position.z);
    const top = Math.max(c.y, (a.bottom ?? a.position.y)) + 0.5;
    const h = col?.raycast(c.x, top, c.z, 0, -1, 0, 3);
    if (!h) return;
    const size = rnd(1.0, 1.35) * Math.min(1.2, Math.max(0.7, (a.height ?? 1.8) / 1.8));
    if (this.paint(this.pools, 'pool', new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), size, size, Math.random() * 7, { tau: rnd(14, 22), relief: 0.003, depth: 0.25 })) this.stats.deathPools++;
  }

  private updateSpurts() {
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    this.spurts = this.spurts.filter((s) => s.until > this.time && !!s.bone.parent);
    for (const s of this.spurts) {
      if (this.time < s.next) continue;
      // A heartbeat: pulses about 1.2 s apart, weakening as the pressure falls.
      const t = this.time - s.start;
      const k = Math.exp(-t / 2.5);
      s.next = this.time + 0.75 + t * 0.08;
      s.bone.getWorldPosition(p);
      (s.bone.parent as THREE.Object3D).getWorldPosition(q);
      const dir = p.clone().sub(q);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      dir.normalize().add(new THREE.Vector3(0, 0.4, 0)).normalize();
      this.throwDrops(p, dir, Math.max(2, Math.round(this.tier.dropletsPerHit * 0.7 * (0.3 + k))), 0.25, [1 + 3 * k, 1.5 + 4.5 * k], 1.2);
    }
  }

  private updateFountains() {
    const col = this.env!.collision();
    this.fountains = this.fountains.filter((d) => !d.f.dead && !d.f.done);
    for (const d of this.fountains) {
      if (!d.f.particles.length) continue;
      // A fountain on a body (a hardpoint: the 1a guard's mouth) marks the skin it pours from;
      // the stain runs down from there.
      if (!d.wounded) {
        d.wounded = true;
        this.wound(d.f.origin, 0.05, 1);
      }
      if (this.time >= d.probeAt) {
        d.probeAt = this.time + 0.5;
        const o = d.f.origin;
        const h = col?.raycast(o.x, o.y, o.z, 0, -1, 0, 4);
        d.floor = h ? { y: h.point[1], n: new THREE.Vector3(...h.normal), part: h.part } : null;
      }
      const fl = d.floor;
      if (!fl) continue;
      // Particles pass through the floor (no ground test in the original: world/fx.ts); where
      // one crosses it a drop is left, a few per second.
      for (const pt of d.f.particles) {
        if (pt.p.y > fl.y || this.landed.has(pt)) continue;
        this.landed.add(pt);
        if (this.time < d.dripAt) continue;
        d.dripAt = this.time + 0.12;
        const size = Math.min(0.09, Math.max(0.025, pt.size0 * 1.2));
        if (this.paint(this.spatter, 'drop', new THREE.Vector3(pt.p.x, fl.y, pt.p.z), fl.n, size, size, Math.random() * 7, { relief: 0.0012 })) {
          d.drips++;
          this.stats.drips++;
        }
        if (d.drips >= 8 && !d.pool) {
          d.pool = true;
          this.paint(this.pools, 'pool', new THREE.Vector3(pt.p.x, fl.y, pt.p.z), fl.n, 0.45, 0.45, Math.random() * 7, { tau: 20, relief: 0.003, depth: 0.25 });
        }
      }
    }
  }

  /** QA (`__enhanced.gore`): counts. */
  info() {
    return {
      tier: this.tierName,
      time: +this.time.toFixed(1),
      spatter: this.spatter ? { n: this.spatter.count, verts: this.spatter.ring.used, recycled: this.spatter.ring.recycled } : null,
      poolFilms: this.pools ? { n: this.pools.count, verts: this.pools.ring.used, recycled: this.pools.ring.recycled } : null,
      droplets: this.droplets?.count ?? 0,
      bodies: this.wounds.bodies.size,
      spurts: this.spurts.length,
      bloodFountains: this.fountains.length,
      hurt: +(hurt.level.value as number).toFixed(2),
      ...this.stats,
    };
  }

  dispose() {
    this.detach();
    for (const o of this.warm) o.removeFromParent();
    this.spatter?.dispose();
    this.pools?.dispose();
    this.droplets?.dispose();
    this.material?.dispose();
    this.atlas?.dispose();
    if (gore.listener === this) gore.listener = null;
  }
}
