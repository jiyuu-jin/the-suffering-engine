// Effect templates the world FX runtime (world/fx.ts) did not handle, spawned from Object
// Generators, weapons and the fx service (docs/game-logic.md §17.3). Tags: [verified] read in
// Suffering.rfl, [data] follows from the retail values / where the templates are used,
// [inferred] behaviour chosen to match the values.
//
//   Camera Shake        see shake.ts [verified]
//   Muzzle Flash        p0 card models (one at random), shown p1 seconds [verified, §4.4]
//   Point Light         (spawned by explosion generators) p0 colour, p8 radius; a 0.25 s flash
//                       from a pooled light [inferred]
//   Fire                model scaled from p3..p5 to p6..p8 when lit and back when put out,
//                       p1 turns it to the camera, p15 damage per second of type p16 to the player
//                       inside it [ctor / think read p1, p3..p5, p11, p15, p18: verified; the
//                       rates and the damage use inferred], inputs p19 On, p20 Off, p21 BlowUp
//   Decal               model = the decal quad (its texture / blend), p0 seconds, p1..p2 size
//                       (model units) [inferred]; projected (decals.ts)
//   BloodPool           p0 material (Advanced Material: texture), grows from p1 to p3 / 100
//                       model units over p2 s, opacity p4 %, stays p6 s [inferred]
//   Blood Point Generator  blood drops thrown at p0..p1 degrees elevation, p3 degrees around,
//                       reaching up to p2 units, each leaving a splat where it lands [inferred]
//   Water Ripple        model grown from p2 to p1 times its size over p3 s, fading; p4 repeats
//                       [inferred]
//   Electric Arc        a bare bolt template: the arc model crackling between a point and a few
//                       around it for its longest life (electric-arc.ts burst) [port]; Electric Arc
//                       Effects on targets are electric-arc.ts (ElectricArcs, decoded)
//   Particle Smoke      p0 puffs (<= 24) of the p19 flipbook (frame by age), life p4..p5 ms,
//                       colour p16, size p13 / 10 m [inferred]

import { sphereTouchesBox, type GasBox } from './gas';
import * as THREE from 'three/webgpu';
import { LEGACY_LIGHTING } from '../../app/engine-light';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { CollisionWorld } from '../../app/physics';
import type { DynamicObject, DynamicObjects } from '../world/dynamic';
import { followMatrices } from './attachments';
import type { Fx, SpawnContext, TemplateInfo } from '../world/fx';
import { colorOf } from '../world/fx';
import type { Decals } from './decals';
import { gore } from './gore-bus';
import type { CameraShaker } from './shake';
import { CameraShaker as Shaker } from './shake';
import type { Surfaces } from './surfaces';
import { refKey, refsOf } from './surfaces';
import { arcTemplateFrom, ElectricArcs } from './electric-arc';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export interface EffectsEnv {
  fx: Fx;
  dyn: DynamicObjects;
  scene: THREE.Scene;
  camera: THREE.Camera;
  collision(): CollisionWorld | null;
  decals: Decals;
  shaker: CameraShaker;
  surfaces: Surfaces;
  /** Player feet position (fire damage) and damage to the player. */
  player(): THREE.Vector3 | null;
  damagePlayer(amount: number, kind: number, at: THREE.Vector3): void;
  /** A model's type-7 bounding box (corner + edge vectors, model units): a fire's contact shape. */
  boundsBox?(model: ResRef): { corner: [number, number, number]; edges: [[number, number, number], [number, number, number], [number, number, number]] } | undefined;
  /** The player's posed hit spheres (output space): what touches a fire (as the gas, fx/gas.ts). */
  playerSpheres?(): readonly { c: readonly number[]; r: number }[];
  log?(msg: string): void;
}

interface Timed {
  life: number;
  max: number;
  update(k: number, dt: number): void;
  done(): void;
}

/** Look of a decal / pool: texture key + blend mode of a material or a model's first submesh. */
interface Look {
  map: THREE.Texture | null;
  blend: number;
  color?: number;
}

export class Effects {
  readonly group = new THREE.Group();
  private timed: Timed[] = [];
  private lights: THREE.PointLight[] = [];
  private lightBusy: number[] = [];
  private looks = new Map<string, Look | null>();
  readonly fires: FireObj[] = [];
  /** Electric Arc Effects on their targets and template-free bursts (electric-arc.ts). */
  readonly arcs: ElectricArcs;
  private bloodDrops: { p: THREE.Vector3; v: THREE.Vector3; life: number; look: Look | null; size: number }[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly env: EffectsEnv) {
    this.group.name = 'fx-effects';
    this.arcs = new ElectricArcs({ pkgs: env.fx.env.packages, dyn: env.dyn, texture: (r) => env.fx.texture(r), camera: env.camera, group: this.group, log: env.log });
    // Fixed light pool: adding / removing lights recompiles every lit material.
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 6, 1.6);
      this.lights.push(l);
      this.lightBusy.push(0);
      this.group.add(l);
    }
  }

  stats() {
    return { timed: this.timed.length, fires: this.fires.filter((f) => f.lit).length, drops: this.bloodDrops.length, arcs: this.arcs.count, spawned: Object.fromEntries(this.counts) };
  }

  private count(cls: string) {
    this.counts.set(cls, (this.counts.get(cls) ?? 0) + 1);
  }

  private add(max: number, update: Timed['update'], done: Timed['done'] = () => {}) {
    const t = { life: 0, max, update, done };
    this.timed.push(t);
    update(0, 0);
    return t;
  }

  /** A pooled light flash (colour, radius, seconds, peak intensity). */
  flash(at: THREE.Vector3, color: number, radius: number, seconds: number, intensity = 30) {
    let i = this.lightBusy.indexOf(Math.min(...this.lightBusy));
    if (i < 0) i = 0;
    const l = this.lights[i];
    l.color.setHex(color);
    l.distance = Math.max(1, radius);
    l.position.copy(at);
    const until = performance.now() + seconds * 1000;
    this.lightBusy[i] = until;
    this.add(seconds, (k) => {
      if (this.lightBusy[i] === until) l.intensity = intensity * (1 - k) * (1 - k);
    }, () => {
      if (this.lightBusy[i] === until) (l.intensity = 0), (this.lightBusy[i] = 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Looks (textures of decal models / materials)

  /** Texture + blend of a model's first textured submesh. */
  lookOfModel(r: ResRef | undefined): Look | null {
    if (!r) return null;
    const k = `m${refKey(r)}`;
    if (this.looks.has(k)) return this.looks.get(k)!;
    const m = this.env.dyn.modelByRef(r);
    const sm = m?.submeshes.find((s) => s.textureKey);
    const look = sm?.textureKey ? { map: this.env.fx.texture(parseKey(sm.textureKey)), blend: sm.material?.layers[0]?.blend ?? 1 } : null;
    this.looks.set(k, look);
    return look;
  }

  /** Texture + blend of a material template (Simple / Advanced: p1 texture, p2 blend; tint p3/p4). */
  lookOfMaterial(r: ResRef | undefined): Look | null {
    if (!r) return null;
    const k = `t${refKey(r)}`;
    if (this.looks.has(k)) return this.looks.get(k)!;
    const t = this.env.surfaces.template(r);
    let look: Look | null = null;
    if (t && isRef(t.values[1])) {
      look = { map: this.env.fx.texture(t.values[1] as ResRef), blend: num(t.values[2], 1) };
      if (t.cls === 'Advanced Material' && num(t.values[3]) !== 0) look.color = num(t.values[4], 0xffffff) & 0xffffff;
    }
    this.looks.set(k, look);
    return look;
  }

  /** Blood decal look from a Reputation Point Based Blood Texture Set Suite (or a Blood Texture Set). */
  bloodLook(suite: ResRef | undefined, reputation = 0): Look | null {
    const t = this.env.surfaces.template(suite);
    if (!t) return null;
    let sets = t.cls === 'Blood Texture Set' ? [t] : refsOf(t.values[0]).map((r) => this.env.surfaces.template(r)).filter((x) => !!x);
    // Blood Texture Set p1 = reputation threshold: the highest one reached [data].
    sets = sets.sort((a, b) => num(a!.values[1]) - num(b!.values[1]));
    let pick = sets[0];
    for (const s of sets) if (s && reputation >= num(s.values[1])) pick = s;
    const mats = refsOf(pick?.values[0]);
    return this.lookOfMaterial(mats[Math.floor(Math.random() * mats.length)]);
  }

  // ---------------------------------------------------------------------------
  // Spawner hooked into the world Fx

  readonly spawner = (t: TemplateInfo, M: THREE.Matrix4, ctx: SpawnContext): boolean => {
    const at = new THREE.Vector3().setFromMatrixPosition(M);
    const v = t.values;
    switch (t.cls) {
      case 'Camera Shake':
        this.env.shaker.start(Shaker.fromValues(v, at));
        break;
      case 'Muzzle Flash':
        this.muzzleFlash(v, M, ctx.parent);
        break;
      case 'Point Light':
        this.flash(at, colorOf(v[0]).getHex(), Math.max(3, num(v[8], 1) * 6), 0.25, 20);
        break;
      case 'Fire': {
        const f = this.addFire(t.model, v, M, 0);
        if (f) {
          f.setLit(true);
          // Thrown by an attached generator (attachments.ts): the fire rides along.
          if (followMatrices.has(M)) f.follow = M;
          // Spawned fires burn their p2 seconds like placed ones (FireObj).
        }
        break;
      }
      case 'Decal': {
        const n = ctx.dir?.clone().normalize() ?? new THREE.Vector3().setFromMatrixColumn(M, 2).normalize();
        this.decal(this.lookOfModel(t.model), at, n, rnd(num(v[1], 0.15), num(v[2], num(v[1], 0.2))), num(v[0], 20));
        break;
      }
      case 'BloodPool':
        this.bloodPool(v, at);
        break;
      case 'Blood Point Generator':
        // Enhanced mode's gore throws its own drops (gore-bus.ts; never set in Original).
        if (!gore.listener?.spray?.(v, M)) this.bloodSpray(v, M, null);
        break;
      case 'Water Ripple':
        this.ripple(t.model, v, M);
        break;
      case 'Electric Arc': {
        // A bare bolt template spawned at a point (no target to put it on) [port].
        const arc = arcTemplateFrom(v, t.model);
        this.arcs.burst(at, arc, arc.life[1]);
        break;
      }
      case 'Particle Smoke':
        this.smoke(v, at);
        break;
      default:
        return false;
    }
    this.count(t.cls);
    return true;
  };

  // ---------------------------------------------------------------------------

  private spawnModel(model: ResRef | undefined, M: THREE.Matrix4, name: string): DynamicObject | undefined {
    if (!model) return undefined;
    return this.env.dyn.spawnModel(model, M, { collides: false, name });
  }

  muzzleFlash(v: PropValue[], M: THREE.Matrix4, parent?: THREE.Object3D) {
    const models = refsOf(v[0]);
    const r = models[Math.floor(Math.random() * models.length)];
    const local = M.clone().multiply(new THREE.Matrix4().makeRotationZ(Math.random() * Math.PI * 2));
    const d = this.spawnModel(r, local, 'muzzle-flash');
    if (d && parent) {
      parent.add(d.root);
      d.root.matrix.copy(local);
    }
    const at = new THREE.Vector3();
    (d?.root ?? this.group).getWorldPosition(at);
    if (!d) at.setFromMatrixPosition(M);
    this.flash(at, 0xffc878, 6, Math.max(0.05, num(v[1], 0.12)), 18);
    if (d) this.add(Math.max(0.03, num(v[1], 0.12)), () => {}, () => this.env.dyn.remove(d.uid));
  }

  decal(look: Look | null, at: THREE.Vector3, normal: THREE.Vector3, size: number, life = 20, extra: { opacity?: number; growFrom?: number; grow?: number; fade?: number } = {}) {
    if (!look?.map) return false;
    return this.env.decals.add(look.map, at, normal, { width: size, blend: look.blend, color: look.color, life, fade: extra.fade ?? 2, opacity: extra.opacity, growFrom: extra.growFrom, grow: extra.grow });
  }

  private bloodPool(v: PropValue[], at: THREE.Vector3) {
    const col = this.env.collision();
    const h = col?.raycast(at.x, at.y + 0.3, at.z, 0, -1, 0, 3);
    if (!h) return;
    const look = this.lookOfMaterial(isRef(v[0]) ? (v[0] as ResRef) : undefined);
    const size = Math.max(0.2, (num(v[3], 45) / 100) * 2);
    const start = Math.min(1, num(v[1], 0.25) / size);
    if (gore.listener?.pool?.(new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), size, Math.max(0.5, num(v[2], 4)), Math.min(1, num(v[4], 80) / 100))) return;
    this.decal(look, new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), size, Math.min(600, num(v[6], 1000)), { opacity: Math.min(1, num(v[4], 80) / 100), growFrom: start, grow: Math.max(0.5, num(v[2], 4)), fade: 4 });
  }

  /**
   * Blood drops flying from M: elevation p0..p1 (deg), spread p3 (deg) around M's -z (the
   * direction away from the attacker), up to p2 units; each leaves a splat where it lands.
   */
  bloodSpray(v: PropValue[], M: THREE.Matrix4, look: Look | null, dirHint?: THREE.Vector3) {
    const at = new THREE.Vector3().setFromMatrixPosition(M);
    const fwd = dirHint?.clone() ?? new THREE.Vector3().setFromMatrixColumn(M, 2).negate();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const reach = Math.max(0.5, Math.min(6, num(v[2], 3)));
    const n = Math.min(10, 3 + Math.round(reach));
    const spread = THREE.MathUtils.degToRad(Math.min(360, num(v[3], 360)));
    for (let i = 0; i < n; i++) {
      const az = (Math.random() - 0.5) * spread;
      const el = THREE.MathUtils.degToRad(rnd(num(v[0], 5), num(v[1], 10)));
      const d = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
      d.multiplyScalar(Math.cos(el)).add(new THREE.Vector3(0, Math.sin(el), 0)).normalize();
      const speed = rnd(0.4, 1) * Math.sqrt(reach * 9.8);
      this.bloodDrops.push({ p: at.clone(), v: d.multiplyScalar(speed), life: 2, look, size: rnd(0.12, 0.35) });
    }
  }

  private updateDrops(dt: number) {
    const col = this.env.collision();
    for (let i = this.bloodDrops.length - 1; i >= 0; i--) {
      const b = this.bloodDrops[i];
      b.life -= dt;
      b.v.y -= 9.8 * dt;
      const step = b.v.clone().multiplyScalar(dt);
      const len = step.length();
      const h = col && len > 1e-5 ? col.raycast(b.p.x, b.p.y, b.p.z, step.x, step.y, step.z, len) : null;
      if (h || b.life <= 0) {
        if (h) this.decal(b.look ?? this.defaultBlood, new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), b.size, 40, { fade: 4 });
        this.bloodDrops.splice(i, 1);
        continue;
      }
      b.p.add(step);
    }
  }

  /** Fallback blood look (set by the system from the player's own blood suite). */
  defaultBlood: Look | null = null;

  private ripple(model: ResRef | undefined, v: PropValue[], M: THREE.Matrix4) {
    const d = this.spawnModel(model, M, 'water-ripple');
    if (!d) return;
    const s0 = Math.max(0.05, num(v[2], 0.5)), s1 = Math.max(s0, num(v[1], 3));
    const life = Math.max(0.3, num(v[3], 1));
    const base = d.root.matrix.clone();
    const S = new THREE.Matrix4();
    this.add(life, (k) => {
      const s = s0 + (s1 - s0) * Math.sqrt(k);
      d.root.matrix.copy(base).multiply(S.makeScale(s, 1, s));
      d.root.matrixWorldNeedsUpdate = true;
    }, () => this.env.dyn.remove(d.uid));
  }

  /**
   * Crackling bolts at a point for `seconds` (template-free 'electric' hits: Horace's shots): the
   * retail bolt of the Lightning projectile's impact effect (3:2209 -> Electric Arc 3:2210) between
   * the point and a few points around it [port: the original puts that effect on the target hit].
   */
  arc(at: THREE.Vector3, length: number, seconds: number) {
    this.arcs.burst(at, { pkg: 3, id: 2210 }, seconds, Math.max(0.3, length / 1.5));
    this.flash(at, 0x9fc8ff, 5, seconds, 8);
  }

  /** Template-free sparks: short additive streaks thrown off a surface with gravity. */
  sparks(at: THREE.Vector3, normal: THREE.Vector3, n: number) {
    const count = Math.max(1, Math.min(24, n));
    const pos = new Float32Array(count * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicNodeMaterial({ color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const lines = new THREE.LineSegments(g, mat);
    lines.frustumCulled = false;
    this.group.add(lines);
    const ps = Array.from({ length: count }, () => ({ p: at.clone(), v: normal.clone().multiplyScalar(rnd(1.5, 4)).add(new THREE.Vector3().randomDirection().multiplyScalar(rnd(0.5, 2.5))) }));
    this.flash(at, 0xffb060, 3, 0.08, 10);
    this.add(rnd(0.25, 0.4), (k, dt) => {
      ps.forEach((s, i) => {
        s.v.y -= 9.8 * dt;
        s.p.addScaledVector(s.v, dt);
        pos.set([s.p.x, s.p.y, s.p.z, s.p.x - s.v.x * 0.02, s.p.y - s.v.y * 0.02, s.p.z - s.v.z * 0.02], i * 6);
      });
      g.attributes.position.needsUpdate = true;
      mat.opacity = 1 - k;
    }, () => (lines.removeFromParent(), g.dispose(), mat.dispose()));
  }

  /** Smoke puffs drawn through the world FX sprite pools, one pool per flipbook frame. */
  smoke(v: PropValue[], at: THREE.Vector3) {
    const frames = refsOf(v[19]);
    if (!frames.length) return;
    const pools = frames.map((r) => {
      const tex = this.env.fx.texture(r);
      return tex ? this.env.fx.pool(tex, refKey(r), 1) : null;
    });
    const n = Math.max(1, Math.min(24, Math.round(num(v[0], 4))));
    const c = colorOf(v[16] ?? 0xffffff);
    const size = Math.max(0.3, num(v[13], 10) / 10);
    const puffs = Array.from({ length: n }, () => ({
      p: at.clone().add(new THREE.Vector3(rnd(-0.2, 0.2), rnd(0, 0.2), rnd(-0.2, 0.2))),
      v: new THREE.Vector3(rnd(-0.3, 0.3), rnd(0.3, 0.9), rnd(-0.3, 0.3)),
      life: rnd(num(v[4], 1200), Math.max(num(v[4], 1200), num(v[5], 3000))) / 1000,
      rot: Math.random() * Math.PI * 2,
    }));
    const max = Math.max(...puffs.map((p) => p.life));
    let t = 0;
    this.smokes.push({
      update: (dt) => {
        t += dt;
        for (const p of puffs) {
          if (t >= p.life) continue;
          p.p.addScaledVector(p.v, dt);
          p.v.multiplyScalar(Math.max(0, 1 - dt * 0.8));
          const k = t / p.life;
          const pool = pools[Math.min(pools.length - 1, Math.floor(k * pools.length))];
          const a = Math.min(1, k / 0.1) * (1 - k);
          pool?.push(p.p.x, p.p.y, p.p.z, size * (0.6 + 0.8 * k), p.rot, c.r, c.g, c.b, a * 0.8);
        }
        return t < max;
      },
    });
  }

  private smokes: { update(dt: number): boolean }[] = [];

  /** Called by the world FX between its pool begin / end (Fx.onDraw). */
  drawSmoke(dt: number) {
    for (let i = this.smokes.length - 1; i >= 0; i--) if (!this.smokes[i].update(dt)) this.smokes.splice(i, 1);
  }

  // ---------------------------------------------------------------------------
  // Fire

  addFire(model: ResRef | undefined, v: PropValue[], M: THREE.Matrix4, uid: number): FireObj | undefined {
    const d = this.spawnModel(model, M, `fire:${uid.toString(16)}`);
    if (!d) return undefined;
    const f = new FireObj(d, v, M, uid);
    if (model) f.bounds = this.env.boundsBox?.(model);
    this.fires.push(f);
    return f;
  }

  update(dt: number) {
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const t = this.timed[i];
      t.life += dt;
      const k = Math.min(1, t.life / t.max);
      t.update(k, dt);
      if (t.life >= t.max) {
        t.done();
        this.timed.splice(i, 1);
      }
    }
    this.updateDrops(dt);
    this.arcs.update(dt);
    // Fires: scale ramps, camera facing, damage, the nearest two burning ones get a light.
    // (The player's posed hit spheres are taken once for all fires this update: docs/perf.md.)
    this.spheres = undefined;
    const cam = this.env.camera.position;
    const player = this.env.player();
    const lit: FireObj[] = [];
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.update(dt, cam);
      if (f.gone) {
        this.env.dyn.remove(f.d.uid);
        this.fires.splice(i, 1);
        continue;
      }
      if (f.lit && f.k > 0.05) lit.push(f);
      // The touch handler (0x100ad320) burns whoever touches a lit fire, p15 x dt a frame.
      if (player && f.lit && f.k > 0) {
        const dmg = num(f.v[15]);
        if (dmg > 0 && this.fireTouchesPlayer(f, player)) {
          f.dmgAcc += dmg * dt;
          if (f.dmgAcc >= 1) {
            const n = Math.floor(f.dmgAcc);
            f.dmgAcc -= n;
            this.env.damagePlayer(n, num(f.v[16], 5), f.pos);
          }
        }
      }
    }
    lit.sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam));
    // The Fire class has no light of its own (Suffering.rfl 0x100ac6e0): placed fires are lit
    // by the level's orange Point Lights (0xea8c40, Lighting Effect 7:968) that the same
    // scripts switch on. The port's own fire light is kept for the legacy look only.
    if (!LEGACY_LIGHTING) lit.length = 0;
    for (let i = 0; i < 2; i++) {
      const l = this.lights[2 + i];
      if (this.lightBusy[2 + i] > performance.now()) continue;
      const f = lit[i];
      if (!f || f.pos.distanceTo(cam) > 25) {
        l.intensity = 0;
        continue;
      }
      l.color.setHex(0xff8a30);
      l.distance = 4 + 3 * f.size;
      l.position.copy(f.pos).y += 0.5 * f.size;
      l.intensity = (6 + Math.random() * 3) * f.k;
    }
  }

  /**
   * The player touches a burning fire: one of his hit spheres reaches into the fire model's box
   * as it is drawn (grown, turned to the camera) [contact rule as the gas (fx/gas.ts), verified;
   * a tree-less model's contact by its bounding box: inferred]. Without them: `contains`.
   */
  private fireTouchesPlayer(f: FireObj, feet: THREE.Vector3): boolean {
    if (!f.bounds) return f.contains(feet);
    const sp = this.playerSpheres();
    if (!sp) return f.contains(feet);
    // Sphere / box contact needs the box within reach of the spheres' bound (exact reject:
    // every box point lies within reach() of the fire's origin).
    const M = f.d.root.matrix.elements;
    const dx = sp.x - M[12], dy = sp.y - M[13], dz = sp.z - M[14];
    const reach = f.reach() + sp.r;
    if (dx * dx + dy * dy + dz * dz > reach * reach * 1.0001 + 1e-6) return false;
    const box = f.worldBox()!;
    return sp.list.some((h) => sphereTouchesBox(box, h.c, h.r));
  }

  /** The player's posed hit spheres this update and a sphere holding them all (null: none). */
  private playerSpheres() {
    if (this.spheres !== undefined) return this.spheres;
    const list = this.env.playerSpheres?.();
    if (!list?.length) return (this.spheres = null);
    let x = 0, y = 0, z = 0;
    for (const h of list) (x += h.c[0]), (y += h.c[1]), (z += h.c[2]);
    x /= list.length;
    y /= list.length;
    z /= list.length;
    let r = 0;
    for (const h of list) r = Math.max(r, Math.hypot(h.c[0] - x, h.c[1] - y, h.c[2] - z) + h.r);
    return (this.spheres = { list, x, y, z, r });
  }
  private spheres: { list: readonly { c: readonly number[]; r: number }[]; x: number; y: number; z: number; r: number } | null | undefined;

  dispose() {
    for (const t of this.timed) t.done();
    this.timed = [];
    for (const f of this.fires) this.env.dyn.remove(f.d.uid);
    this.fires.length = 0;
    this.arcs.dispose();
    this.group.removeFromParent();
  }
}

export class FireObj {
  lit = false;
  gone = false;
  /** 0..1 progress between the start and the full size. */
  k = 0;
  burnFor = Infinity;
  dmgAcc = 0;
  /** Placement to follow every frame (fires of attached generators). */
  follow?: THREE.Matrix4;
  /** The model's type-7 bounding box (model units): the contact shape. */
  bounds?: { corner: [number, number, number]; edges: [[number, number, number], [number, number, number], [number, number, number]] };
  readonly pos = new THREE.Vector3();
  private readonly s0: THREE.Vector3;
  private readonly s1: THREE.Vector3;
  private readonly base: THREE.Matrix4;
  private readonly S = new THREE.Matrix4();
  private burnt = 0;

  constructor(
    readonly d: DynamicObject,
    readonly v: PropValue[],
    M: THREE.Matrix4,
    readonly uid: number,
  ) {
    this.base = M.clone();
    this.pos.setFromMatrixPosition(M);
    this.s0 = new THREE.Vector3(num(v[3], 0.001), num(v[4], 0.001), num(v[5], 0.001));
    this.s1 = new THREE.Vector3(num(v[6], 1), num(v[7], 1), num(v[8], 1));
    d.root.visible = false;
    // p2: seconds a lit fire burns (0: until put out) [verified, 0x100acd00 / 0x100ac6e0].
    this.burnFor = num(v[2]) > 0 ? num(v[2]) : Infinity;
  }

  get size() {
    return Math.max(this.s1.x, this.s1.z);
  }

  setLit(on: boolean) {
    this.lit = on;
    if (on) (this.d.root.visible = true), (this.burnt = 0);
  }

  /** The bounding box as drawn now (the model matrix: placement, camera turn, growth). */
  worldBox(): GasBox | null {
    const b = this.bounds;
    if (!b) return null;
    const M = this.d.root.matrix;
    const c = new THREE.Vector3(...b.corner).applyMatrix4(M);
    const ax: [number, number, number][] = [];
    const h: number[] = [];
    const centre = c.clone();
    for (const e of b.edges) {
      const w = new THREE.Vector3(...e).transformDirection(M);
      const len = new THREE.Vector3(...e).applyMatrix4(M).sub(new THREE.Vector3().applyMatrix4(M)).length();
      ax.push([w.x, w.y, w.z]);
      h.push(len / 2);
      centre.addScaledVector(w, len / 2);
    }
    return { c: [centre.x, centre.y, centre.z], ax: ax as GasBox['ax'], h: h as GasBox['h'] };
  }

  /**
   * How far from the model matrix's origin the drawn bounding box reaches at most: the box's
   * farthest corner (model units) times the matrix's Frobenius norm, which bounds its stretch.
   */
  reach(): number {
    const b = this.bounds;
    if (!b) return 0;
    if (this.cornerReach < 0) {
      let m = 0;
      for (let i = 0; i < 8; i++) {
        let x = b.corner[0], y = b.corner[1], z = b.corner[2];
        for (let k = 0; k < 3; k++) if (i & (1 << k)) (x += b.edges[k][0]), (y += b.edges[k][1]), (z += b.edges[k][2]);
        m = Math.max(m, Math.hypot(x, y, z));
      }
      this.cornerReach = m;
    }
    const e = this.d.root.matrix.elements;
    const f = e[0] * e[0] + e[1] * e[1] + e[2] * e[2] + e[4] * e[4] + e[5] * e[5] + e[6] * e[6] + e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    return this.cornerReach * Math.sqrt(f);
  }
  private cornerReach = -1;

  /** Player feet inside the burning footprint (half the scaled model unit, 2 units high). */
  contains(p: THREE.Vector3) {
    const r = 0.5 * Math.max(this.s1.x, this.s1.z) * this.k;
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    return dx * dx + dz * dz < r * r && p.y > this.pos.y - 0.5 && p.y < this.pos.y + 2 * this.s1.y;
  }

  update(dt: number, cam: THREE.Vector3) {
    if (this.follow) {
      this.base.copy(this.follow);
      this.pos.setFromMatrixPosition(this.follow);
    }
    // Lit (0x100acd00 / update 0x100ac6e0) [verified]: the model grows from p3..p5 to p6..p8 over
    // p9 s (at once when 0); a fire with a p2 time shrinks back to p3..p5 over its last p10 s and,
    // its time out, is destroyed when p19 (its On message) is 0 (spawned fires), else put out.
    // Put out by a message: shrinks at the largest of p12..p14 per second [inferred].
    const rate = Math.max(0.2, num(this.v[12], 1), num(this.v[13], 1), num(this.v[14], 1));
    if (this.lit) {
      this.burnt += dt;
      const left = this.burnFor - this.burnt;
      const p9 = num(this.v[9]), p10 = num(this.v[10]);
      if (left <= 0) {
        this.lit = false;
        this.k = 0;
        this.d.root.visible = false;
        if (num(this.v[19]) === 0) this.gone = true;
        return;
      }
      if (left <= p10) this.k = Math.max(0, this.k - dt / p10);
      else this.k = p9 > 0 ? Math.min(1, this.k + dt / p9) : 1;
    } else {
      this.k = Math.max(0, this.k - rate * dt);
      if (this.k <= 0) {
        this.d.root.visible = false;
        if (num(this.v[19]) === 0) this.gone = true;
      }
    }
    if (!this.d.root.visible) return;
    const s = new THREE.Vector3().lerpVectors(this.s0, this.s1, this.k);
    // Flame flicker in height.
    s.y *= 0.92 + 0.08 * Math.sin(performance.now() * 0.013 + this.uid);
    const M = this.d.root.matrix.copy(this.base);
    if (num(this.v[1]) !== 0) {
      // p1: turn about the vertical to face the camera.
      const yaw = Math.atan2(cam.x - this.pos.x, cam.z - this.pos.z);
      M.makeRotationY(yaw).setPosition(this.pos);
    }
    M.multiply(this.S.makeScale(s.x, s.y, s.z));
    this.d.root.matrixWorldNeedsUpdate = true;
  }
}

function parseKey(k: string): ResRef {
  const [pkg, id] = k.split(':').map(Number);
  return { pkg, id };
}
