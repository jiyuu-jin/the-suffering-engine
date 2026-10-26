// Effects & audio ambience game system (docs/game-logic.md §17).
//
// Runs: Camera Shake (placed + spawned, shake.ts), the effect templates the world FX runtime did
// not draw (Muzzle Flash, Fire, Decal, BloodPool, Blood Point Generator, Water Ripple, Electric
// Arc, Particle Smoke, spawned Point Lights: effects.ts), projected decals (decals.ts), per-surface
// impacts and footsteps (surfaces.ts, footsteps.ts), Ambient Sound zones + environment reverb
// (ambient.ts, reverb.ts), Flying Sounds (flying.ts) and the camera-relative rim light of
// Directional Lights (rim.ts). Debug: window.__fx.
//
// =============================================================================================
// services.fx: FxService  (look it up lazily: `ctx.services.fx as FxService | undefined`)
//
//   spawn(ref, M, ctx?)            spawn any effect template at the placement matrix M (output
//                                  space): Object Generator, Particle Fountain, BouncingObject,
//                                  Decorative FX, Sound Effect, Camera Shake, Muzzle Flash, Fire,
//                                  Decal, BloodPool, Blood Point Generator, Water Ripple, Electric
//                                  Arc, Particle Smoke, Point Light (also Breakable remains /
//                                  Radius Damage through the props runtime).
//                                  ctx.dir: direction away from the attacker, or the surface
//                                  normal for impacts / decals; ctx.parent: attach to an object
//                                  (M is then local to it - muzzle flashes on a weapon bone).
//   spawnAt(ref, point, normal?, ctx?)   same, oriented with +z along `normal` (default up).
//   impact({ point, normal, effects?, hit?, surface?, dir?, sound?, decal?, fx? }) -> { surface, entry }
//                                  per-surface hit effects: `effects` is a Missile Material
//                                  Effects list (Missile p41) or Melee Weapon Material Effects list
//                                  (Melee Weapon p77); the entry for the surface's Material Type
//                                  (else the untyped default) plays its sounds (p1), spawns its
//                                  generator (p3) and the extra template p5 (water ripples), and
//                                  projects its Decal (p6; Missile entries only). `hit` (a
//                                  CollisionWorld RayHit) or `surface` (Material Type "pkg:id")
//                                  selects the surface; without either it is looked up under / at
//                                  the point. Flags turn parts off (sound: false etc.).
//   blood(point, dir, { suite?, amount?, reputation? })   blood spray + splats on walls / floor
//                                  behind a hit on a character. suite: the weapon's Reputation
//                                  Point Based Blood Texture Set Suite (Ranged / Melee Weapon p61);
//                                  default: the player's (Player p66).
//   decal({ model? | material? }, point, normal, size, life?)  project a decal (model = Decal
//                                  template model, material = Simple / Advanced Material).
//   effect(kind, point, normal?, { scale?, dir? })   template-free effects:
//                                  'sparks' | 'dust' | 'smoke' | 'blood' | 'electric' | 'flash' | 'shake'
//   muzzleFlash(ref, parent, local?)   Muzzle Flash template on an object (weapon bone).
//   arcEffect(ref, target)        put an Electric Arc Effect (Damage Action Object p8) on a target:
//                                  its bones or the objects it links to (electric-arc.ts ArcTarget);
//                                  returns a handle (alive, stop()) or undefined when it cannot run.
//   shake({ a, b, time, fade?, inner?, outer?, at? })   camera shake (Camera Shake p0..p5 units)
//   surfaceAt(hitOrPoint)         { type: Material Type "pkg:id" | null, material? }
//   footstep(kind, feet, effects) play FootStep kind 0..5 (Light, Heavy, Scuff, Sneak, Land,
//                                  BodyFall) from a Player / NPC Material Effects list
//   reverb                        { key, depth, enabled } current environment
//   stats()                       counters for tests / the overlay
//
// Weapons (src/game/weapons): call spawn() for generators / muzzle flashes as before, impact()
// with the projectile's p41 list for wall hits (sounds, generator, decal by surface), blood()
// for hits on characters. Hits on actors by NPCs / hazards get blood here automatically
// (actors 'damage' events with a non-player source).
// =============================================================================================

import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { SrscFile } from '../../formats/srsc';
import { readModelBoundsBox } from '../../formats/model-spheres';
import type { SkeletonSphere } from '../../formats/skeleton';
import { modelHitSpheres, posedSpheres } from './gas-system';
import type { RayHit } from '../../app/physics';
import type { Character } from '../../app/character';
import type { WorldService } from '../world/world';
import { bounceKeep, readTemplate, type SpawnContext } from '../world/fx';
import { instanceMatrix } from '../world/dynamic';
import { loadSettings } from '../../app/menu/settings';
import { bakedGain } from '../../app/surface-material';
import { Surfaces, refKey, refsOf, waterSurfaces, type SurfaceInfo } from './surfaces';
import { Decals } from './decals';
import { gore } from './gore-bus';
import { CameraShaker, type ShakeParams } from './shake';
import { Effects } from './effects';
import type { ArcHandle, ArcTarget } from './electric-arc';
import { EnvironmentReverb, reverbParams } from './reverb';
import { AmbientZones } from './ambient';
import { FlyingSounds } from './flying';
import { Footsteps, FOOTSTEP, FP_STEP_INTERVAL } from './footsteps';
import { RUN_SPEED } from '../../app/player-rules';
import { RimLight } from './rim';
import { engineLights, type ShadowCaster } from '../../app/engine-light';
import { warmHooks, warmObjects } from '../../app/prewarm';
import { FALL_DAMAGE_TYPE, fallDamage } from '../../app/player-rules';
import type { PackageSet } from '../../formats/model';
import { hardpointBone } from '../weapons/hardpoints';
import { Attachments } from './attachments';
import { BodyParts, type BodyPartCarrier, type FaderSave } from './body-parts';
import { registerSave } from '../save/providers';

/** Saved state of the Characters' fades and body parts (fx.bodyParts provider). */
interface BodyPartsSave {
  faders?: FaderSave[];
  parts?: { uid: number; bones: number[] }[];
}
import { SpawnedBillboards } from './billboards';
import { DESTROY_REBIRTH_FX, Rebirth } from './rebirth';
import { LEGACY_LIGHTING, engineColor } from '../../app/engine-light';
import type { InventoryService } from '../world/inventory';

type V3 = THREE.Vector3Like;
const v3 = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);
const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);

export type FxKind = 'sparks' | 'dust' | 'smoke' | 'blood' | 'electric' | 'flash' | 'shake';

export interface ImpactOptions {
  point: V3;
  normal: V3;
  /** Missile Material Effects (Missile p41) or Melee Weapon Material Effects (Melee Weapon p77) list. */
  effects?: PropValue | ResRef[];
  hit?: Pick<RayHit, 'part' | 'dynamic' | 'point'>;
  /** Material Type "pkg:id" (overrides the lookup). */
  surface?: string | null;
  dir?: V3;
  sound?: boolean;
  decal?: boolean;
  fx?: boolean;
}

export interface FxService {
  spawn(ref: ResRef, M: THREE.Matrix4, ctx?: SpawnContext): void;
  spawnAt(ref: ResRef, point: V3, normal?: V3, ctx?: SpawnContext): void;
  impact(o: ImpactOptions): { surface: string | null; entry?: ResRef };
  blood(point: V3, dir?: V3, opts?: { suite?: ResRef; amount?: number; reputation?: number }): void;
  decal(look: { model?: ResRef; material?: ResRef }, point: V3, normal: V3, size: number, life?: number): boolean;
  effect(kind: FxKind, point: V3, normal?: V3, opts?: { scale?: number; dir?: V3 }): void;
  muzzleFlash(ref: ResRef, parent?: THREE.Object3D, local?: THREE.Matrix4): void;
  arcEffect(ref: ResRef, target: ArcTarget): ArcHandle | undefined;
  shake(p: Partial<ShakeParams> & { a: number; b: number; time: number }): void;
  surfaceAt(hitOrPoint: Pick<RayHit, 'part' | 'dynamic' | 'point'> | V3): SurfaceInfo;
  footstep(kind: number, feet: V3, effects: PropValue | undefined): void;
  readonly reverb: { key: string | null; depth: number; enabled: boolean };
  stats(): Record<string, unknown>;
}

interface ActorLike {
  entity?: { uid: number; values: PropValue[]; className?: string };
  alive: boolean;
  hidden?: boolean;
  position: THREE.Vector3Like;
  ch: Character;
  motor?: { onGround: boolean };
  bottom?: number;
  height?: number;
}
interface ActorsLike {
  list(): readonly ActorLike[];
  isVisible?(uid: number): boolean;
  playerBody?: { body?: Character; arms?: Character } | null;
  on?(ev: 'damage', fn: (a: ActorLike, info?: unknown) => void): () => void;
}
interface CombatLike {
  readonly player: { readonly health: number; readonly alive?: boolean };
  damagePlayer(amount: number, source?: unknown): void;
}

export async function createFxSystem(ctx: GameContext): Promise<GameSystem> {
  const ws = ctx.services.world as WorldService | undefined;
  const pkgs = ctx.loaded.packages;
  if (!ws?.fx || !pkgs) return { name: 'fx (no world)' };
  const { view, audio } = ctx;
  const world = ws.world;
  const wfx = ws.fx;
  const dyn = wfx.env.dyn;
  const collision = () => view.collision;
  const actors = () => ctx.services.actors as ActorsLike | undefined;
  const combat = () => ctx.services.combat as CombatLike | undefined;
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    if (logs.length > 200) logs.shift();
    console.info(m);
  };

  const surfaces = new Surfaces(wfx.env.packages, ctx.loaded.level, collision, dyn);
  // A surface without Game Material Properties takes the level's (Level Properties p17; 2:7 in
  // every retail level: no Material Type, so the effect lists' default entry; surfaces.ts).
  const lp17 = world.of('Level Properties')[0]?.e.values[17];
  if (isRef(lp17)) surfaces.setLevelDefault(lp17 as ResRef);
  // Decals lie on the drawn triangles, not the collision models (docs/game-logic.md §14.10).
  const decals = new Decals(() => view.drawn ?? view.collision, (p, parts) => {
    const c = surfaces.lightAt(p, parts, bakedGain.value as number);
    return new THREE.Color(c.r, c.g, c.b);
  });
  view.scene.add(decals.group);

  // --- Camera shake: applied right after the player / fly controller placed the camera.
  const shaker = new CameraShaker(view.camera, collision);
  const player = view.player as unknown as { update(dt: number): void };
  const controls = view.controls as unknown as { update(dt: number): void };
  const origPlayer = player.update, origControls = controls.update;
  player.update = function (dt: number) {
    shaker.remove();
    origPlayer.call(this, dt);
    shaker.apply();
  };
  controls.update = function (dt: number) {
    shaker.remove();
    origControls.call(this, dt);
    shaker.apply();
  };

  const fireTrees = new Map<string, SkeletonSphere[]>();
  const fireFpPlayer = world.of('Player').find((w) => !(w.e.flags & 0x8)) ?? world.of('Player')[0];
  const fireFpModel = ((v) => (v && typeof v === 'object' && 'pkg' in (v as object) ? (v as ResRef) : undefined))(fireFpPlayer?.e.values[227]);
  const effects = new Effects({
    fx: wfx,
    dyn,
    scene: view.scene,
    camera: view.camera,
    collision,
    decals,
    shaker,
    surfaces,
    player: () => (view.walking ? view.player.position.clone() : null),
    damagePlayer: (amount, kind, at) => {
      const c = combat();
      if (c) c.damagePlayer(amount, { kind, at });
    },
    boundsBox: (m) => {
      const mdu = (wfx.env.packages.get(m.pkg) as { mdu?: SrscFile } | undefined)?.mdu;
      return mdu ? readModelBoundsBox(mdu, m.id) : undefined;
    },
    // The model he shows: the Player template's (2:9) in third person, its first-person model
    // p227 (2:138) in first person (fx/gas-system.ts).
    playerSpheres: () => {
      const body = actors()?.playerBody?.body;
      if (!body) return [];
      const fp = (view.player as { mode?: string }).mode === 'fp';
      return posedSpheres(body, modelHitSpheres(wfx.env.packages as unknown as PackageSet, fp && fireFpModel ? fireFpModel : body.skinned.ref, fireTrees));
    },
    log,
  });
  view.scene.add(effects.group);
  wfx.spawners.push(effects.spawner);
  wfx.drawHooks.push((dt) => effects.drawSmoke(dt));
  // BouncingObject bounces keep 1 - the surface's Game Material Properties p4 % of their speed
  // (world/fx.ts bounceKeep; Suffering.rfl 0x1009ac0f).
  const gmpKeep = new Map<string, number>();
  wfx.surfaceKeep = (hit) => {
    const k = surfaces.atHit(hit).gmp;
    if (!k) return 1;
    let keep = gmpKeep.get(k);
    if (keep === undefined) {
      const [pkg, id] = k.split(':').map(Number);
      const p4 = readTemplate(pkgs, { pkg, id })?.values[4];
      keep = bounceKeep(0, typeof p4 === 'number' ? p4 : 0);
      gmpKeep.set(k, keep);
    }
    return keep;
  };

  // Blood splat look: the BloodPool material (BloodPool p0 = Advanced Material 4:1095, a blood
  // texture) [inferred: no retail template ties a texture to Blood Point Generator splats; the
  // "Reputation Point Based Blood Texture Set Suites" of weapons (p61) and the Player (p66/p67)
  // carry the template model they reskin (4:15 weapon, 2:9 player) - blood stains on the
  // weapon / body by reputation, not wall decals].
  const playerEnt = world.of('Player').find((w) => !(w.e.flags & 0x8)) ?? world.of('Player')[0];

  // --- Attached effects (docs/re/object-model.md §7 / §8): spawned Billboards (glows thrown by
  // generators), Animating Static attachment sets (SpawnAttachments 154 / p45 / p46), Ring Damage
  // and the Killjoy Rebirth Effect (Player DestroyRebirthFX 105).
  const billboards = new SpawnedBillboards((r) => wfx.texture(r));
  view.scene.add(billboards.group);
  wfx.spawners.push(billboards.spawner);
  type CarrierLike = { ch: Character; alive?: boolean };
  const carrier = (uid: number) => (actors() as { get?(uid: number): CarrierLike | undefined } | undefined)?.get?.(uid);
  // Attachment indices are bones of the carrier's model (retail data: p49 = 5 / 7 on models with
  // 2 / 3 channels, p21 = 35 the player's weapon bone; the engine bounds them by the bone count).
  const boneMatrix = (ch: Character | undefined, bone: number, out: THREE.Matrix4) => {
    if (!ch || bone < 0 || bone >= ch.skeleton.bones.length) return false;
    const b = hardpointBone(pkgs as PackageSet, ch, { bone });
    if (!b) return false;
    b.updateWorldMatrix(true, false);
    out.copy(b.matrixWorld);
    return true;
  };
  const attachments = new Attachments({
    wfx,
    classOf: (r) => readTemplate(pkgs, r)?.cls,
    // Point Light p0 colour (p1 = negative light), p8 strength, p9 hemisphere: as world/lights.ts.
    light: (r) => {
      const t = readTemplate(pkgs, r);
      if (t?.cls !== 'Point Light') return undefined;
      const v = t.values;
      const n = (i: number, d: number) => (typeof v[i] === 'number' ? (v[i] as number) : d);
      const c = engineColor(n(0, 0)).multiplyScalar(n(1, 0) ? -1 : 1);
      return { r: c.r, g: c.g, b: c.b, intensity: Math.max(0, n(8, 6)), hemi: n(9, 0) === 1 ? -1 : n(9, 0) === 2 ? 1 : 0 };
    },
    hardpoint: (uid, hp, out) => boneMatrix(carrier(uid)?.ch, hp, out),
    gone: (uid) => {
      const a = carrier(uid);
      return !!world.get(uid)?.destroyed || !a || a.alive === false;
    },
    shown: (uid) => actors()?.isVisible?.(uid) ?? true,
    log,
  });
  attachments.install(world);
  // Characters' clip item / fade events and messages (Hermes' gas body and fades;
  // docs/game-logic.md §15.7.12).
  const bodyParts = new BodyParts({ pkgs: pkgs as PackageSet, parts: attachments, fire: (uid, slot) => world.fire(uid, slot), log });
  const bodyCarrier = (uid: number, cls: string, values: PropValue[]): BodyPartCarrier | undefined => {
    const a = carrier(uid);
    return a?.ch ? { uid, cls, values, ch: a.ch } : undefined;
  };
  world.handlers.push((w, msg) => {
    if (w.e.family !== 'Character' || !BodyParts.handles(w.cls) || w.destroyed) return false;
    const c = bodyCarrier(w.uid, w.cls, w.e.values);
    return !!c && bodyParts.message(c, msg);
  });
  // Saved games: the carriers' faders and body-part bones (both are Character components the
  // original saves: +0x562, +0x31c). After the actors (priority 10): the bones must resolve.
  const offBodySave = registerSave(
    ctx.services,
    'fx.bodyParts',
    {
      save: (): BodyPartsSave => ({
        faders: bodyParts.save(),
        parts: [...bodyCarriers()].map((c) => ({ uid: c.uid, bones: attachments.partBones(c.uid) })).filter((p) => p.bones.length),
      }),
      load: (d: BodyPartsSave | undefined) => {
        bodyParts.load(d?.faders);
        for (const c of bodyCarriers()) {
          attachments.remove(c.uid);
          for (const b of d?.parts?.find((p) => p.uid === c.uid)?.bones ?? []) attachments.spawnParts(c.uid, c.values, b);
        }
      },
      // A level record without this entry was written before 45f4dd8, which made a sequence's
      // take show a Character and began saving the faders and parts: 1b's Hermes came back
      // hidden, at his creation fade (0) and without his gas, after "Camera" #247 had raised
      // him. Rebuild both from the sequences the level has played (docs/game-logic.md §15.7.12
      // "Saved games"): the takes show, and their 154 / 206..209 keys give the parts and the
      // fades' end.
      absent: () => {
        const shown = world.showTakenCharacters();
        const replayed: string[] = [];
        world.replayPlayedSequences({
          send: (uid, msg) => {
            const w = world.get(uid);
            if (!w || w.destroyed || w.e.family !== 'Character' || !BodyParts.handles(w.cls)) return;
            const c = bodyCarrier(uid, w.cls, w.e.values);
            if (c && bodyParts.replay(c, msg)) replayed.push(`${uid.toString(16)}:${msg}`);
          },
        });
        if (shown.length || replayed.length) log(`older save: shown ${shown.map((u) => u.toString(16)).join(',') || '-'}; replayed ${replayed.join(' ') || '-'}`);
      },
    },
    { scope: 'level', priority: 12 },
  );
  const bodyCarriers = function* (): Generator<BodyPartCarrier> {
    for (const a of actors()?.list() ?? []) {
      const e = a.entity;
      if (e && BodyParts.handles(e.className) && a.ch) yield { uid: e.uid, cls: e.className!, values: e.values, ch: a.ch };
    }
  };
  const offAttachedLights = LEGACY_LIGHTING ? () => {} : engineLights.addProvider((out) => attachments.lightsOut(out));
  const inventory = () => ctx.services.inventory as Pick<InventoryService, 'count' | 'add' | 'remove'> | undefined;
  const weapons = () => ctx.services.weapons as { give?(id: string, n?: number): void; stow?(): void; unstow?(): void } | undefined;
  const rebirth = new Rebirth({
    wfx,
    template: (r) => readTemplate(pkgs, r),
    player: () => (view.walking ? view.player.position.clone() : null),
    playerHardpoint: (hp, out) => {
      const pb = actors()?.playerBody;
      const arms = pb?.arms?.root.visible ? pb.arms : undefined;
      return boneMatrix(arms, hp, out) || boneMatrix(pb?.body, hp, out);
    },
    damagePlayer: (amount, kind, at) => combat()?.damagePlayer(amount, { kind, at }),
    // The grant goes through the weapons system's inventory routing (throwable caps, selection).
    items: {
      count: (r) => inventory()?.count(r) ?? 0,
      give: (r, n) => {
        const w = weapons();
        if (w?.give) w.give(`${r.pkg}:${r.id}`, n);
        else inventory()?.add(`${r.pkg}:${r.id}`, n, r);
      },
      removeAll: (r) => inventory()?.remove(r) ?? 0,
    },
    stow: () => weapons()?.stow?.(),
    unstow: () => weapons()?.unstow?.(),
    log,
  });
  wfx.spawners.push(rebirth.spawner);
  const offRebirth = world.subscribe(world.playerUid, (msg) => {
    if (msg === DESTROY_REBIRTH_FX) rebirth.destroy();
  });

  effects.defaultBlood = effects.lookOfMaterial({ pkg: 4, id: 1095 });
  // Decal pipelines compiled with the level (hidden stand-ins, src/app/prewarm.ts).
  const decalWarm = effects.defaultBlood?.map ? decals.warm(effects.defaultBlood.map, warmObjects) : [];

  // --- Placed Camera Shakes (p6 On) and Fires (p19 On / p20 Off / p21 BlowUp).
  const fires = new Map<number, ReturnType<Effects['addFire']>>();
  for (const w of world.of('Fire')) {
    const own = dyn.objects.get(w.uid);
    if (own) dyn.setVisible(w.uid, false);
    const f = effects.addFire(w.e.modelRef, w.e.values, instanceMatrix(w.e.position, w.e.rotation), w.uid);
    if (!f) continue;
    fires.set(w.uid, f);
    if (num(w.e.values[0]) !== 0 && w.e.flags & 1) f.setLit(true);
  }
  world.handlers.push((w, msg) => {
    if (w.cls === 'Camera Shake') {
      if (num(w.e.values[6], 1) !== msg) return false;
      shaker.start(CameraShaker.fromValues(w.e.values, new THREE.Vector3(...w.pos)));
      log(`[fx] camera shake ${w.uid.toString(16)} (${w.e.values.slice(0, 4).map((x) => num(x).toFixed(2)).join(', ')})`);
      return true;
    }
    if (w.cls === 'Fire') {
      const f = fires.get(w.uid);
      if (!f) return false;
      const v = w.e.values;
      if (num(v[19], 1) === msg) return f.setLit(true), true;
      if (num(v[20], 2) === msg || num(v[21], 11) === msg) return f.setLit(false), true;
      return false;
    }
    return false;
  });

  // --- Environment reverb + Ambient Sound zones + Flying Sounds.
  const reverb = new EnvironmentReverb(audio);
  const lp = world.of('Level Properties')[0]?.e.values;
  if (lp && isRef(lp[27])) {
    const t = surfaces.template(lp[27] as ResRef);
    if (t) reverb.set(reverbParams(refKey(lp[27] as ResRef), t.values), num(lp[28], 40) / 100, 0, 0.5);
  }
  // Reverb is opt-in: the retail PC build never applied it (docs/re/audio.md §5).
  const envFxOn = () => loadSettings().extra.environmentFx === 0;
  reverb.setEnabled(envFxOn());
  const feet = new THREE.Vector3();
  const zones = new AmbientZones({
    world,
    audio,
    reverb,
    template: (r) => surfaces.template(r)?.values,
    player: () => (view.walking ? feet.copy(view.player.position).setY(view.player.position.y + 1) : feet.copy(view.camera.position)),
    camera: () => view.camera.position,
    log,
  });
  const flying = new FlyingSounds({
    world,
    audio,
    listener: () => view.camera.position,
    combatMusic: () => !!(window as unknown as { __music?: { playing?: boolean } }).__music?.playing,
    log,
  });

  // --- Footsteps.
  // AI noise of each step (entry p7 InvestigateSound) goes to the actors system (services.actors.noise).
  const stepNoise = (r: ResRef, at: THREE.Vector3, who: string) => {
    const actors = ctx.services.actors as { noise?(at: THREE.Vector3Like, sound: ResRef, source?: unknown): void; get?(uid: number): unknown } | undefined;
    const m = /^actor ([0-9a-f]+)$/.exec(who);
    actors?.noise?.(at, r, who === 'player' ? 'player' : m ? actors.get?.(parseInt(m[1], 16)) : undefined);
  };
  const footsteps = new Footsteps({ pkgs: wfx.env.packages, audio, surfaces, spawn: (r, at) => wfx.spawn(r, new THREE.Matrix4().setPosition(at)), noise: stepNoise });
  const playerEffects = playerEnt?.e.values[145];
  const fpStepInterval = num(playerEnt?.e.values[156] as number, FP_STEP_INTERVAL) || FP_STEP_INTERVAL;
  const playerKey = {};
  let prevVy = 0;
  const offFrame = view.player.onUpdate((f) => {
    if (f.landed && prevVy < -4) {
      const p = view.player.position;
      if (footsteps.sinceStep(playerKey) > 0.3) footsteps.step('player', FOOTSTEP.land, p.clone(), playerEffects);
      // Hard landing jolt [port addition: no Camera Shake template is tied to landing].
      if (prevVy < -8) shaker.start({ a: 0.03, b: Math.min(0.2, -prevVy * 0.012), time: 0.25, fade: 0.25, inner: 1e9, outer: 1e9 });
    }
    // Fall damage (Player 0x1002db30): none up to 6.5 m, linear to lethal at 7.7 m of drop,
    // damage type 7 (docs/re/player.md section 5.3).
    if (f.landed && f.fall !== undefined && view.walking) {
      const c = combat() as (CombatLike & { player: { maxHealth?: number } }) | undefined;
      // In water: x (1 - p27 %)^depth (levels/water.ts waterFallFactor).
      const wp = (ctx.services.water as { player?: { inWater: boolean; depth: number }; rules?: { fallPct: number } } | undefined);
      const wf = wp?.player?.inWater && wp.rules ? Math.pow(1 - wp.rules.fallPct / 100, wp.player.depth) : 1;
      const dmg = c && c.player.alive !== false ? fallDamage(f.fall, c.player.maxHealth ?? 100, c.player.health, wf) : 0;
      if (dmg > 0) {
        log(`[fx] fall ${f.fall.toFixed(2)} m${wf < 1 ? ` (water x${wf.toFixed(2)})` : ''}: ${dmg.toFixed(1)} damage`);
        c!.damagePlayer(dmg, { kind: FALL_DAMAGE_TYPE, at: view.player.position.clone() });
      }
    }
    prevVy = f.onGround ? 0 : f.verticalSpeed;
  });

  // Blood on actors hit by NPCs / hazards (player hits: the weapons system calls blood()).
  const offDamage = actors()?.on?.('damage', (a, info) => {
    const i = info as { amount?: number; source?: unknown } | undefined;
    if (!i || i.source === 'player' || !(num(i.amount as number) > 0)) return;
    const p = new THREE.Vector3(a.position.x, (a.bottom ?? a.position.y) + (a.height ?? 1.6) * 0.6, a.position.z);
    // Enhanced mode's gore draws it (gore-bus.ts; never set in Original).
    if (gore.listener?.hit) {
      const by = (info as { by?: { position: THREE.Vector3Like } }).by?.position;
      const d = by ? new THREE.Vector3(p.x - by.x, 0, p.z - by.z) : new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5);
      if (gore.listener.hit(p, d.lengthSq() > 1e-6 ? d.normalize() : d.set(0, 0, 1), num(i.amount as number) / 15)) return;
    }
    effects.bloodSpray([5, 20, Math.min(3, 1 + num(i.amount as number) / 10), 360], new THREE.Matrix4().setPosition(p), null);
  });

  // --- Rim light (Directional Light + Rim Light template) for characters.
  const zoneBoxes = (ctx.loaded.level.visibility?.zones ?? []).map((z) => new THREE.Box3(new THREE.Vector3(z.box[0], z.box[1], z.box[2]), new THREE.Vector3(z.box[3], z.box[4], z.box[5])));
  const rim = new RimLight(world, (r) => surfaces.template(r)?.values, view.scene, view.camera, zoneBoxes, ctx.loaded.level.lightRegions);
  rim.targets = () => (actors()?.list() ?? []).flatMap((a) => (a.ch?.root ? [a.ch.root as THREE.Object3D] : []));

  // --- Projected character shadows (engine-light.ts renderShadows; docs/re/renderer.md §4).
  const casters: ShadowCaster[] = [];
  // (One caster record per character root, rewritten each frame: docs/perf.md.)
  const casterOf = new WeakMap<THREE.Object3D, ShadowCaster>();
  const caster = (root: THREE.Object3D, x: number, y: number, z: number, radius: number, player?: boolean) => {
    let c = casterOf.get(root);
    if (!c) casterOf.set(root, (c = { root, centre: new THREE.Vector3(), radius: 0, player: undefined }));
    c.centre.set(x, y, z);
    c.radius = radius;
    c.player = player;
    casters.push(c);
  };
  engineLights.shadowCasters = () => {
    casters.length = 0;
    for (const a of actors()?.list() ?? []) {
      // A projected figure casts none (Projector Effect On clears its caster bit, specials/projector.ts).
      if (!a.alive || a.hidden || !a.ch?.root.visible || a.ch.root.userData.noShadow) continue;
      const h = Math.max(0.5, a.height ?? 1.8);
      const y = (a.bottom ?? a.position.y) + h / 2;
      caster(a.ch.root, a.position.x, y, a.position.z, Math.max(0.5, h * 0.6));
    }
    const body = actors()?.playerBody?.body;
    if (body?.root.visible && view.walking) {
      const p = view.player.position;
      caster(body.root, p.x, p.y + 0.9, p.z, 1.1, true);
    }
    return casters;
  };
  // Every character's silhouette pass is compiled with the level (engine-light.ts
  // precompileShadows), placed hidden or dormant ones too.
  const warmShadows = () =>
    Promise.all(
      engineLights.precompileShadows(view.renderer, [
        ...(actors()?.list() ?? []).flatMap((a) => (a.ch?.root ? [a.ch.root as THREE.Object3D] : [])),
        ...(actors()?.playerBody?.body ? [actors()!.playerBody!.body!.root as THREE.Object3D] : []),
      ]),
    );
  warmHooks.add(warmShadows);

  // --- Service.
  const bloodNear = (point: THREE.Vector3, dir: THREE.Vector3, look: ReturnType<Effects['bloodLook']>, amount: number) => {
    if (gore.listener?.hit?.(point, dir, amount)) return;
    effects.bloodSpray([-5, 25, 1.5 + amount * 1.5, 120], new THREE.Matrix4().setPosition(point), look, dir);
    // A splat on the surface right behind the hit [inferred].
    const col = collision();
    const h = col?.raycast(point.x, point.y, point.z, dir.x, dir.y, dir.z, 2.5);
    if (h) effects.decal(look ?? effects.defaultBlood, new THREE.Vector3(...h.point), new THREE.Vector3(...h.normal), 0.4 + 0.4 * Math.random() * amount, 40, { fade: 4 });
  };

  // Enhanced mode's gore (gore-bus.ts): the level it draws into. Never set in Original.
  gore.listener?.attach({
    scene: view.scene,
    camera: view.camera,
    drawn: () => view.drawn ?? view.collision,
    collision,
    lightAt: (p, parts) => surfaces.lightAt(p, parts, 1),
    actors: () => (actors()?.list() ?? []) as never,
    player: () => {
      const c = combat() as (CombatLike & { player: { maxHealth?: number } }) | undefined;
      return c && view.walking ? { health: c.player.health, maxHealth: c.player.maxHealth ?? 100, alive: c.player.alive !== false } : null;
    },
  });

  const service: FxService = {
    spawn: (ref, M, sctx) => wfx.spawn(ref, M, sctx ?? {}),
    spawnAt: (ref, point, normal, sctx) => {
      const n = normal ? v3(normal).normalize() : new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      wfx.spawn(ref, new THREE.Matrix4().compose(v3(point), q, new THREE.Vector3(1, 1, 1)), { dir: n, ...sctx });
    },
    impact: (o) => {
      const point = v3(o.point), normal = v3(o.normal).normalize();
      let surface: string | null;
      if (o.surface !== undefined) surface = o.surface;
      else if (o.hit && (o.hit.part !== undefined || o.hit.dynamic !== undefined)) surface = surfaces.atHit(o.hit).type;
      else {
        const c = collision();
        const h = c?.raycast(point.x + normal.x * 0.05, point.y + normal.y * 0.05, point.z + normal.z * 0.05, -normal.x, -normal.y, -normal.z, 0.2);
        surface = h ? surfaces.atHit(h).type : null;
      }
      const entry = surfaces.pick(o.effects as PropValue, surface);
      if (!entry) return { surface };
      const v = entry.values;
      if (o.sound !== false) {
        const keys = refsOf(v[1]).map(refKey).filter((k) => audio.get(k));
        if (keys.length) audio.play3D(keys[Math.floor(Math.random() * keys.length)], [point.x, point.y, point.z], { bus: 'sfx' });
      }
      if (o.fx !== false) {
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        const M = new THREE.Matrix4().compose(point, q, new THREE.Vector3(1, 1, 1));
        if (isRef(v[3])) wfx.spawn(v[3] as ResRef, M, { dir: normal });
        if (entry.cls === 'Missile Material Effects' && isRef(v[5])) wfx.spawn(v[5] as ResRef, M, { dir: normal });
      }
      if (o.decal !== false && entry.cls === 'Missile Material Effects' && isRef(v[6])) {
        const d = surfaces.template(v[6] as ResRef);
        if (d) effects.decal(effects.lookOfModel(d.model), point, normal, Math.max(0.05, num(d.values[1], 0.15) + Math.random() * Math.max(0, num(d.values[2], 0.2) - num(d.values[1], 0.15))), num(d.values[0], 20));
      }
      return { surface, entry: entry.ref };
    },
    blood: (point, dir, opts = {}) => {
      // opts.suite (a weapon's blood stain suite) is accepted for API compatibility; splats use
      // the blood pool texture (see defaultBlood).
      const look = effects.defaultBlood;
      const d = dir ? v3(dir).normalize() : new THREE.Vector3(0, 0, 1);
      bloodNear(v3(point), d, look, Math.max(0.3, Math.min(3, opts.amount ?? 1)));
    },
    decal: (look, point, normal, size, life = 30) =>
      effects.decal(look.model ? effects.lookOfModel(look.model) : effects.lookOfMaterial(look.material), v3(point), v3(normal).normalize(), size, life),
    effect: (kind, point, normal, opts = {}) => {
      const p = v3(point), n = normal ? v3(normal).normalize() : new THREE.Vector3(0, 1, 0), s = opts.scale ?? 1;
      switch (kind) {
        case 'sparks':
          effects.sparks(p, n, Math.round(8 * s));
          break;
        case 'dust':
        case 'smoke': {
          const smoke = smokeTemplate();
          if (smoke) effects.smoke(kind === 'dust' ? { ...smoke, 0: Math.round(3 * s), 13: 6 * s, 16: 0x8a8070 } as unknown as PropValue[] : smoke, p);
          break;
        }
        case 'blood':
          bloodNear(p, opts.dir ? v3(opts.dir).normalize() : n.clone().negate(), effects.defaultBlood, s);
          break;
        case 'electric':
          effects.arc(p, 1.5 * s, 0.4);
          break;
        case 'flash':
          effects.flash(p, 0xffc070, 6 * s, 0.15, 25);
          break;
        case 'shake':
          shaker.start({ a: 0.1 * s, b: 0.1 * s, time: 0.4, fade: 0.3, inner: 4, outer: 20, at: p });
          break;
      }
    },
    arcEffect: (ref, target) => effects.arcs.start(ref, target),
    muzzleFlash: (ref, parent, local) => {
      const t = surfaces.template(ref);
      if (t?.cls === 'Muzzle Flash') effects.muzzleFlash(t.values, local ?? new THREE.Matrix4(), parent);
    },
    shake: (p) => shaker.start({ fade: 0, inner: 1e9, outer: 1e9, ...p, at: p.at ? v3(p.at) : undefined }),
    surfaceAt: (x) => {
      const h = x as Partial<Pick<RayHit, 'part' | 'dynamic' | 'point'>>;
      if (Array.isArray(h.point) && (h.part !== undefined || h.dynamic !== undefined)) return surfaces.atHit(h as RayHit);
      const p = Array.isArray(h.point) ? { x: h.point[0], y: h.point[1], z: h.point[2] } : (x as V3);
      return surfaces.below(p.x, p.y + 0.1, p.z) ?? { type: null };
    },
    footstep: (kind, at, list) => footsteps.step('api', kind, v3(at), list),
    get reverb() {
      return reverb.environment;
    },
    stats: () => ({
      decals: decals.count,
      shake: { ...shaker.amp, active: shaker.shaking },
      effects: effects.stats(),
      zones: { count: zones.count, current: zones.currentUid?.toString(16), playing: zones.playing(), events: zones.events.slice(-10) },
      flying: flying.state(),
      reverb: reverb.environment,
      reverbLog: reverb.log.slice(-10),
      footsteps: footsteps.recent.slice(-10),
      rim: rim.state(),
    }),
  };

  let smokeCache: PropValue[] | null | undefined;
  function smokeTemplate(): PropValue[] | null {
    if (smokeCache !== undefined) return smokeCache;
    // A retail puff of smoke (Particle Smoke 4:1032: 4 puffs, 30-frame flipbook) [data].
    smokeCache = surfaces.template({ pkg: 4, id: 1032 })?.values ?? null;
    return smokeCache;
  }

  ctx.services.fx = service;

  // --- Debug.
  Object.assign(window, { __fx: { service, shaker, decals, effects, zones, flying, footsteps, reverb, surfaces, waterSurfaces, rim, logs, attachments, bodyParts, billboards, rebirth } });
  log(`[fx] system: ${fires.size} fires, ${zones.count} ambient zones, ${flying.count} flying sounds, rim ${rim.state().source ?? 'none'}`);

  let settingsAcc = 0;
  let lastHealth = combat()?.player.health ?? 100;
  const system: GameSystem = {
    name: 'fx',
    update(dt) {
      shaker.update(dt);
      effects.update(dt);
      decals.update(dt);
      zones.update();
      flying.update(dt);
      footsteps.tick(dt);
      rim.update(dt);
      bodyParts.update(dt, bodyCarriers());
      attachments.update(dt);
      rebirth.update(dt * ((view as { timeScale?: number }).timeScale ?? 1));
      billboards.update(dt, view.camera);
      // Footsteps: player body / arms clip markers, actors' clip markers (footsteps.ts).
      if (view.walking) {
        const pb = actors()?.playerBody;
        const ch = pb?.body?.current ? pb.body : pb?.arms;
        footsteps.track(playerKey, 'player', ch, view.player.position, playerEffects);
        // First person: a light step every Player p156 s at full stick (RFL 0x10046312). The
        // stick magnitude is the ground speed over the full-stick speed [inferred mapping].
        const v = view.player.velocity;
        const speed = Math.hypot(v.x, v.z);
        if ((view.player as { mode?: string }).mode === 'fp' && view.player.onGround && speed > 0.05) {
          footsteps.firstPerson(playerKey, 'player', view.player.position, playerEffects, Math.min(1, speed / RUN_SPEED), dt, fpStepInterval);
        }
      }
      const cam = view.camera.position;
      for (const a of actors()?.list() ?? []) {
        if (!a.alive || a.hidden || !a.ch?.root.visible || !a.entity) continue;
        const p = a.position;
        const dx = p.x - cam.x, dz = p.z - cam.z;
        if (dx * dx + dz * dz > 40 * 40) continue;
        const f = new THREE.Vector3(p.x, a.bottom ?? p.y, p.z);
        footsteps.track(a, `actor ${a.entity.uid.toString(16)}`, a.ch, f, a.entity.values[49]);
      }
      // Heavy hit jolt on the player [port addition].
      const c = combat();
      if (c) {
        const h = c.player.health;
        if (h < lastHealth - 15 && h > 0) shaker.start({ a: 0.04, b: 0.04, time: 0.3, fade: 0.3, inner: 1e9, outer: 1e9 });
        lastHealth = h;
      }
      gore.listener?.update(dt);
      settingsAcc += dt;
      if (settingsAcc > 1) {
        settingsAcc = 0;
        reverb.setEnabled(envFxOn());
      }
    },
    dispose() {
      player.update = origPlayer;
      controls.update = origControls;
      shaker.remove();
      offFrame();
      offDamage?.();
      gore.listener?.detach();
      for (const sp of [effects.spawner, billboards.spawner, rebirth.spawner]) {
        const i = wfx.spawners.indexOf(sp);
        if (i >= 0) wfx.spawners.splice(i, 1);
      }
      offRebirth();
      offAttachedLights();
      offBodySave();
      attachments.dispose();
      bodyParts.dispose();
      rebirth.dispose();
      billboards.dispose();
      wfx.drawHooks.length = 0;
      zones.dispose();
      flying.dispose();
      reverb.dispose();
      effects.dispose();
      decals.dispose();
      rim.dispose();
      engineLights.shadowCasters = null;
      warmHooks.delete(warmShadows);
      for (const m of decalWarm) {
        m.removeFromParent();
        (m.material as THREE.Material).dispose();
      }
      if (ctx.services.fx === service) delete ctx.services.fx;
      delete (window as unknown as { __fx?: unknown }).__fx;
    },
  };
  Object.assign((window as unknown as { __fx: object }).__fx, { system });
  return system;
}
