// World game system: level logic for the playable slice.
//
//   * entities + message dispatcher + logic classes (logic.ts)
//   * doors / switches / pickups / toggled props as dynamic meshes with collision (dynamic.ts)
//   * player start selection by the transition's spawn name
//   * Use key (E) on the switch or item under the crosshair; Enter skips cutscenes
//   * dev overlay on the backquote key (overlay.ts)
//   * props (props.ts: breakables, pushables, mechanisms, lamps, morphs), effects (fx.ts),
//     light changes / sky / fog (lights.ts), interactions (interact.ts: phones, monitors,
//     toilets, ladders, clamber points, mounted guns)
//
// Services published on ctx.services:
//   services.world: WorldService      messaging + state for other systems (see below)
//   services.inventory: InventoryService  items picked up, keyed by item template (inventory.ts)
//   services.damage: DamageService    damage to props / actors (damage.ts has the interface)
//   services.time: { scale }          world clock rate (read-only; Time Scale objects are run by
//                                     the insanity system, which already scales every frame dt)

import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import { entityFromObject, parseEntities, type Entity, type EntityPackageSet } from '../../formats/entities';
import { instanceRotation, parseLevelObjects, WORLD_SCALE, type LevelObject } from '../../formats/level';
import type { ResRef } from '../../formats/model';
import { levelSoundEmitters } from '../../formats/sound';
import { dynamicObjectProviders } from '../../app/loader';
import { World, PICKUP_CLASSES, atCarryCap, templateClassName, type SoundPlayback, type SwitchMotion, type Vec3, type WorldEntity } from './logic';
import { DynamicObjects, dynamicObjectUids, type DynamicObject } from './dynamic';
import { InvisibleBlockers } from './blockers';
import { switchBaseMaterials, switchBaseSwaps } from './switch-part';
// Registers how placed objects collide with the loader (docs/game-logic.md §14.10).
import './object-collision';
import { NO_BATCH, StaticBatch } from '../../app/prop-batch';
import { createWorldHud } from './hud';
import { lipSyncService } from '../actors/lipsync';
import { DevOverlay } from './overlay';
import type { StompTransformKey } from './stomp';
import { stepDropFall, type DropFall } from './drop-fall';
import type { PropTargetInfo } from '../actors/actor';
import { inventorySaveProvider, registerSave, worldSaveProvider } from '../save/providers';
import { byNameOnce, createInventory, itemTemplateName, type InventoryItem, type InventoryService } from './inventory';
import { Fx } from './fx';
import { Props, type PropsSaveState } from './props';
import { Searchlights, type SearchlightsSave } from './searchlight';
import { Lights, type LightsSaveState } from './lights';
import { Interactions, viewOnAnchor, type UseTarget } from './interact';
import { createDamageService, type DamageService } from './damage';
import { seeThroughParts, sightBlocked } from '../actors/sight';
import type { DynamicParts, RayHit } from '../../app/physics';
import { difficulty } from '../campaign/difficulty';

/** uids of objects placed during play (dropped weapons): above any level uid. */
let nextDropUid = 0x7d000000;
/** A pickup placed during play (saved by the 'drops' provider). */
interface DropRecord {
  uid: number;
  template: ResRef;
  at: Vec3;
  yaw: number;
}

// Claim doors, pickups and scripted props before the loader bakes the static geometry.
if (!dynamicObjectProviders.includes(dynamicObjectUids)) dynamicObjectProviders.push(dynamicObjectUids);

export type { InventoryItem, InventoryService } from './inventory';

export interface WorldService {
  readonly world: World;
  /** Player interactions (the levels system hooks the crane controls in: levels/crane.ts). */
  readonly interact?: Interactions;
  /** Deliver a level-logic message (e.g. NPC outOnDeath to its links). */
  send(uid: number, message: number, senderUid?: number): void;
  /** Fire an entity's output slot (property index) to its links. */
  fire(uid: number, slot: number): void;
  /** Messages delivered to a uid ('*' = all). Returns an unsubscribe function. */
  subscribe(uid: number | '*', fn: (message: number, from: number, to: number) => void): () => void;
  isVisible(uid: number): boolean;
  /** World-space triangles of a dynamic object at its current pose (undefined: not one). */
  dynamicParts?(uid: number): DynamicParts | undefined;
  isDestroyed(uid: number): boolean;
  /** Door state for AI (Edge Passage doors): open, moving, locked. */
  door(uid: number): { open: boolean; moving: boolean; locked: boolean } | undefined;
  /** Swing a door open whatever its lock (an NPC that may pass it: actors/system.ts). */
  openDoor(uid: number): void;
  /**
   * Place a pickup of an item template during play (a weapon an NPC drops when it dies);
   * returns its uid.
   */
  dropItem(template: ResRef, at: Vec3, yawDeg?: number, opts?: { fall?: boolean }): number | undefined;
  /** A damageable level object as a character's target (KillEnemies p3; props.ts targetInfo). */
  propTarget(uid: number): PropTargetInfo | undefined;
  /** Edge Passages: door uid between two move nodes. */
  readonly passages: readonly { door: number; nodeA: number; nodeB: number }[];
  /** STOMP poses for objects this system does not render (NPCs): uid -> latest key. */
  onStompTransform(fn: (uid: number, key: StompTransformKey | null) => void): () => void;
  /** True while a cutscene drives the player. */
  readonly inCutscene: boolean;
  /** World effects runtime (fx.ts); the fx system (src/game/fx) extends it and wraps it as services.fx. */
  readonly fx: Fx;
  /**
   * Is a collision hit (view.collision raycast) on a surface the eye passes through: cut-out
   * bars / grates, glass and other blended surfaces of the level or of a dynamic object?
   * For sight tests (src/game/actors/sight.ts).
   */
  seeThrough(hit: RayHit): boolean;
  /**
   * Does a shot pass a collision hit? With collision trees (docs/game-logic.md §14.10) nothing:
   * the sight flag (template bit 10) is a line-of-sight query flag (0x800) that the
   * BouncingObject sweep never passes [verified for it; bullets inferred] - 3a's gas tank 13c3
   * carries it and is shot. Without collision parts: the see-through surfaces, as sight.
   */
  shotThrough(hit: RayHit): boolean;
  /** Does the eye see through a hit on the drawn triangles (LevelRenderer.drawn: see-through surfaces)? */
  eyeThrough(hit: RayHit): boolean;
}

// Carried across level loads: entries by item template ("pkg:id", inventory.ts).
const inventoryItems = new Map<string, InventoryItem>();
let lastLevelPath: string | undefined;
/** Display names of item templates (Item p22) in the running level's packages. */
let itemNames: ((r: ResRef) => string | undefined) | undefined;

const inventory: InventoryService = createInventory(inventoryItems, (r) => itemNames?.(r));
/** The same items without the systems' hooks on `add` (the weapons' pickup rules): save loads. */
const rawInventory: InventoryService = createInventory(inventoryItems, (r) => itemNames?.(r));

interface CombatLike {
  readonly player: { readonly health: number; readonly maxHealth: number };
  healPlayer(amount: number): number;
}
interface ActorsLike {
  list(): readonly { entity?: Entity; uid?: number; template?: boolean; position: { x: number; y: number; z: number }; ch: { root: THREE.Object3D }; kind?: { className?: string } }[];
  get(uid: number): { ch: { root: THREE.Object3D } } | undefined;
  receive(uid: number, message: number): boolean;
}

export async function createWorldSystem(ctx: GameContext): Promise<GameSystem> {
  const { view, audio, loaded } = ctx;
  const { lvl, packages } = loaded;
  if (!lvl || !packages) return { name: 'world (no level data)' };
  const pkgs = packages as EntityPackageSet;
  const t0 = performance.now();
  const entities = parseEntities(lvl, pkgs);
  const byUid = new Map(entities.map((e) => [e.uid, e]));
  const fromLevel = lastLevelPath;
  lastLevelPath = ctx.levelPath;
  itemNames = (r) => itemTemplateName(pkgs, r);

  const container = view.renderer.domElement.parentElement ?? document.body;
  const hud = createWorldHud(container);

  // Dynamic objects (meshes + collision bodies).
  const dyn = new DynamicObjects(packages, view.collision, loaded.ldu, loaded.level?.loadLighting);
  dyn.build(lvl, byUid, loaded.dynamicUids ?? dynamicObjectUids(lvl, packages));
  view.scene.add(dyn.group);

  const actors = () => ctx.services.actors as ActorsLike | undefined;
  const combat = () => ctx.services.combat as CombatLike | undefined;
  const stompListeners: ((uid: number, key: StompTransformKey | null) => void)[] = [];
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const sfxKeys = (keys: string[]) => keys.filter((k) => audio.get(k));

  const poseSwitch = (d: DynamicObject, pose: number, motion: SwitchMotion) => {
    const p = d.pivot.matrix;
    if (motion.kind === 'rotate') {
      const a = motion.travel * pose;
      if (motion.axis === 0) p.makeRotationX(a);
      else if (motion.axis === 1) p.makeRotationY(a);
      else p.makeRotationZ(a);
    } else if (motion.kind === 'slide') {
      const t = motion.travel * pose;
      p.makeTranslation(motion.axis === 0 ? t : 0, motion.axis === 1 ? t : 0, motion.axis === 2 ? t : 0);
    } else p.identity();
    d.pivot.matrixWorldNeedsUpdate = true;
  };

  // Effects / props / lights / interactions are created right after the World (they need it);
  // the hooks below reach them through these.
  let props: Props | undefined;
  let searchlights: Searchlights | undefined;
  let fx: Fx | undefined;
  // World clock: Time Scale objects are run by the insanity system (src/game/insanity), which
  // scales the frame dt itself (LevelRenderer.timeScale); services.time reads it back.
  const timeService = {
    get scale() {
      return (view as { timeScale?: number }).timeScale ?? 1;
    },
  };

  // Scratch for the Visiblity Message Filter view hook.
  const vmfPoint = new THREE.Vector3(), vmfLocal = new THREE.Vector3(), vmfCam = new THREE.Vector3();
  const world = new World(
    entities,
    pkgs,
    {
      player: () => {
        if (!view.walking && !view.player.enabled) {
          // Fly mode: use the camera as the player.
          const c = view.camera.position;
          const f = view.camera.getWorldDirection(new THREE.Vector3());
          return { feet: [c.x, c.y - 1.6, c.z], eye: [c.x, c.y, c.z], forward: [f.x, f.y, f.z] };
        }
        const p = view.player.position;
        const e = view.player.eyePosition();
        const f = view.camera.getWorldDirection(new THREE.Vector3());
        return { feet: [p.x, p.y, p.z], eye: [e.x, e.y, e.z], forward: [f.x, f.y, f.z] };
      },
      // Each copy an Object Cloner made is its own object (its own uid: a Detector's sender, the
      // target of a Damage Action Object with p0 0 - 3a's pit Detector 1b7c kills the Slayers
      // that fall in); cloner templates are not in the world.
      actors: () =>
        (actors()?.list() ?? [])
          .filter((a) => a.entity && !a.template)
          .map((a) => ({ uid: a.uid ?? a.entity!.uid, position: [a.position.x, a.position.y, a.position.z] as Vec3, className: a.entity!.className })),
      setVisible: (uid, visible) => {
        fx?.setVisible(uid, visible);
        if (dyn.objects.has(uid)) dyn.setVisible(uid, visible);
        else {
          const a = actors()?.get(uid);
          if (a) a.ch.root.visible = visible;
        }
      },
      setTransform: (uid, key) => {
        const d = dyn.objects.get(uid);
        if (!d) {
          for (const fn of stompListeners) fn(uid, key);
          return;
        }
        if (!key) d.root.matrix.copy(d.base);
        else {
          tmpQ.set(key.quat[0], key.quat[1], key.quat[2], key.quat[3]);
          d.root.matrix.compose(new THREE.Vector3(key.position[0] / 2048, key.position[1] / 2048, key.position[2] / 2048), tmpQ, new THREE.Vector3(1, 1, 1));
        }
        d.root.matrixWorldNeedsUpdate = true;
        dyn.refreshCollision(d, true);
      },
      switchPose: (uid, pose, moving) => {
        const d = dyn.objects.get(uid);
        const w = world.get(uid);
        if (!d || !w) return;
        poseSwitch(d, pose, w.s.motion as SwitchMotion);
        // Collision follows the door at rest; off while it swings so it can't shove the player.
        d.solid = !moving;
        dyn.refreshCollision(d, !moving);
        // A p37 base shows the state at rest: p32 open, p33 closed (switch-part.ts, 0x101308a0).
        if (d.stand && !moving && switchBaseSwaps(w.e.values)) dyn.setMaterials(d.stand.uid, switchBaseMaterials(w.e.values, !!w.s.open, d.stand.model?.materials.length ?? 0));
      },
      playSound: (uid, keys, position, opts) => {
        const ok = sfxKeys(keys);
        if (!ok.length) return undefined;
        const key = ok[Math.floor(Math.random() * ok.length)];
        // Sound Effect p9 = 2 plays at the listener (2D); p13 fades it in (docs/re/audio.md §12).
        const h = audio.play(key, { position: opts.listener ? undefined : position, maxDistance: opts.radius, loop: opts.loop, fadeIn: opts.fadeIn });
        // Voiced lines: lip-sync the actor the sound is attached to (p10), else one standing on it.
        const ls = opts.effect ? undefined : lipSyncService(ctx);
        const attach = world.get(uid)?.e.values[10];
        if (ls && !(typeof attach === 'number' && attach && ls.speak(h, attach))) {
          ls.speakNear(h, { x: position[0], y: position[1], z: position[2] }, 1);
        }
        const pb: SoundPlayback = {
          stop: (fade) => h.stop(fade ?? 0.15),
          get playing() {
            return h.playing;
          },
        };
        return pb;
      },
      noise: (at, sound) => (ctx.services.actors as { noise?(at: THREE.Vector3Like, sound: ResRef): void } | undefined)?.noise?.({ x: at[0], y: at[1], z: at[2] }, sound),
      toast: (text, ms) => hud.toast(text, ms),
      help: (text) => hud.help(text),
      requestLevel: (path, spawn) => {
        // Engine paths are "Levels\\1 PrisonDeathRow\\1b PrisonDeathRow.lvl", relative to the game root.
        const rel = path.replace(/\\/g, '/');
        void ctx.fs.resolve(rel).then((found) => {
          const target = found ?? rel;
          console.info(`[world] level transition -> ${target} (${spawn ?? 'default spawn'})`);
          setTimeout(() => ctx.requestLevel(target, { spawnName: spawn }), 600);
        });
      },
      destroyed: (uid) => {
        props?.onDestroyed(uid);
        fx?.setVisible(uid, false);
        if (dyn.objects.has(uid)) dyn.setVisible(uid, false);
        if (actors()?.get(uid)) actors()!.receive(uid, 12);
      },
      hasItem: (r) => inventory.has(r),
      useItem: (r) => inventory.remove(r, 1) > 0,
      pickup: (w) => onPickup(w),
      // Item CanPickUp 0x100be240 [verified]: Items and Health Bonus Items carried up to Item
      // p44 of their template (9 Xombium bottles, 9 batteries) stay in the world at the cap.
      canPickUp: (w) => !atCarryCap(w.cls, w.e.values, w.e.template ? inventory.count(w.e.template) : 0),
      pickupText: (text) => hud.pickup(text),
      pushables: () => props?.pushablePositions() ?? [],
      lightCones: () => searchlights?.occupants() ?? [],
      // The drawn camera (a cutscene's included), as the engine's camera object: Visiblity
      // Message Filters test what is on screen (logic.ts visibilityFilterPasses).
      view: (q) => {
        const cam = view.camera;
        cam.updateMatrixWorld();
        const v = vmfPoint.set(q[0], q[1], q[2]);
        const front = vmfLocal.copy(v).applyMatrix4(cam.matrixWorldInverse).z < 0;
        v.project(cam);
        const c = cam.getWorldPosition(vmfCam);
        return { camera: [c.x, c.y, c.z], x: v.x, y: v.y, front };
      },
      lineOfSight: (a, b, slack) => !view.collision || !sightBlocked(view.collision, a[0], a[1], a[2], b[0], b[1], b[2], Math.max(0, slack), (hit) => service.seeThrough(hit)),
    },
    { levelPath: ctx.levelPath, spawnName: ctx.spawnName, fromLevel },
  );

  // Messages to actors are forwarded to the actors system (Destroy / BlowUp / ...).
  world.subscribe('*', (msg, from, to) => {
    const w = world.get(to);
    if (w && w.e.family === 'Character' && w.cls !== 'Player') actors()?.receive(to, msg);
  });

  function onPickup(w: WorldEntity) {
    const name = world.itemLabel(w);
    const v = w.e.values;
    // Xombium bottles are carried (Item p44 = 9) and drunk with the Health key: the weapons
    // system stores them when it runs (services.weapons.storeHealthPack, src/game/weapons).
    const packs = ctx.services.weapons as { storeHealthPack?(name: string, template: ResRef, amount: number): boolean } | undefined;
    // Heal p55 x the p56 Difficulty Modifier (src/game/campaign/difficulty.ts).
    const healAmount = (typeof v[55] === 'number' ? (v[55] as number) : 20) * difficulty.healScale(w.e);
    if (w.cls === 'Health Bonus Item' && w.e.template && packs?.storeHealthPack?.(name, w.e.template, healAmount)) {
      hud.toast(`Picked up ${name}`);
    } else if (w.cls === 'Health Bonus Item') {
      const amount = healAmount;
      const c = combat();
      if (c) c.healPlayer(amount);
      else inventory.health = Math.min(inventory.maxHealth, inventory.health + amount);
      inventory.add(name, 1);
      hud.toast(`${name} (+${Math.round(amount)} health)`);
    } else {
      const tpl = (v[55] && typeof v[55] === 'object' ? (v[55] as ResRef) : undefined) ?? w.e.template;
      const amount = w.cls === 'Ammo Box' && typeof v[56] === 'number' ? Math.max(1, v[56] as number) : 1;
      inventory.add(name, amount, tpl, templateClassName(pkgs, tpl));
      hud.toast(amount > 1 ? `Picked up ${name} ×${amount}` : `Picked up ${name}`);
    }
    const snd = v[48] as ResRef | null;
    if (snd && typeof snd === 'object') {
      const k = sfxKeys([`${snd.pkg}:${snd.id}`]);
      if (k.length) audio.play(k[0], { bus: 'sfx' });
    }
    console.info(`[world] picked up ${name} (${w.cls}#${w.uid.toString(16)})`);
  }

  // Player start: the spawn point matching the transition's spawn name (and source level).
  // An empty name (transition without target spawn names) picks the point by source level.
  const spawnName = ctx.spawnName;
  if (spawnName !== undefined) {
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    const all = world.of('Player Spawn Point');
    const fromHere = (w: WorldEntity) => !!fromLevel && norm(String(w.e.props.fromLevel ?? '')).endsWith(norm(fromLevel).replace(/^.*?levels\//, 'levels/'));
    let points = all.filter((w) => String(w.e.props.spawnName ?? '').toLowerCase() === spawnName.toLowerCase());
    if (!points.length && !spawnName) points = all.filter(fromHere);
    const sp = points.find(fromHere) ?? points[0];
    if (sp) {
      const R = instanceRotation(sp.e.rotation);
      const yaw = Math.atan2(R[2], R[8]);
      view.player.spawn({ x: sp.pos[0], y: sp.pos[1] + 0.05, z: sp.pos[2] }, yaw);
      if (!view.walking) view.controls.setPose(new THREE.Vector3(sp.pos[0], sp.pos[1] + 1.6, sp.pos[2]), yaw, 0);
      console.info(`[world] spawn "${spawnName}" at ${sp.pos.map((x) => x.toFixed(1)).join(', ')}`);
    } else console.warn(`[world] no spawn point named "${spawnName}"`);
  }

  // The pickups linked from the level's own Player object (its direct-start position) are a
  // start kit for playing the level on its own: 1b's six and 1c's seventeen (a Tommy Gun among
  // them) lie around the transition arrival. Entered through a transition (or a save of such a
  // visit) they are not there [inferred: a chapter-1 playthrough otherwise finds an early
  // revolver and a Tommy Gun on the floor; docs/playthrough.md].
  const arrivedByTransition = spawnName !== undefined || (ctx.startKind === 'load' && ctx.savedSpawnName !== undefined);
  if (arrivedByTransition) {
    const start = world.get(world.playerUid);
    let n = 0;
    for (const u of start?.e.links ?? []) {
      const w = world.get(u);
      if (!w || w.destroyed || !PICKUP_CLASSES.has(w.cls)) continue;
      world.setVisible(u, false);
      world.destroy(w);
      n++;
    }
    if (n) console.info(`[world] start kit of the level's Player object left out (${n} pickups)`);
  }

  // Message-driven Sound Effects are played by the logic, not as ambient emitters.
  try {
    const driven = new Set<number>();
    for (const e of entities) for (const u of e.links) driven.add(u);
    for (const w of world.of('STOMP Player')) for (const t of world.sequenceOf(w)?.tracks ?? []) driven.add(t.uid);
    // Ambient Sound (crossfade zones) and Flying Sound objects are run by the fx system
    // (src/game/fx/ambient.ts, flying.ts), not as positional loops.
    const emitters = levelSoundEmitters(parseLevelObjects(lvl), packages, audio).filter((e) => !(e.kind === 'sound' && driven.has(e.uid)) && e.kind !== 'loop' && e.kind !== 'ambient-set');
    audio.setEmitters(emitters);
  } catch (err) {
    console.warn('[world] emitters not filtered', err);
  }

  // Invisible Static Objects: the level's invisible collision boxes (blockers.ts), On / Off by
  // message from the start.
  const blockers = new InvisibleBlockers(world, packages, view.collision);

  world.start();
  // Pickups dropped during play (a dead character's weapon: actors/drops.ts). They have no
  // level object, so saves list them and a load places them again (or removes ones dropped
  // after the save) before the world provider restores their taken / destroyed state.
  const drops: DropRecord[] = [];
  // Drops falling out of a dead character's hand (drop-fall.ts): moved until they rest.
  const falling = new Map<number, DropFall>();
  const fallCast = (from: THREE.Vector3, to: THREE.Vector3) => {
    const c = view.collision;
    if (!c) return null;
    const d = to.clone().sub(from);
    const len = d.length();
    if (len < 1e-6) return null;
    const hit = c.raycast(from.x, from.y, from.z, d.x / len, d.y / len, d.z / len, len);
    if (!hit) return null;
    const n = new THREE.Vector3(hit.normal[0], hit.normal[1], hit.normal[2]);
    // Two-sided level triangles: the side the drop comes from.
    if (n.dot(d) > 0) n.negate();
    return { point: new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]), normal: n };
  };
  const updateFalling = (dt: number) => {
    for (const [uid, f] of falling) {
      const moving = stepDropFall(f, dt, fx?.gravity ?? 10.41, fallCast);
      const d = dyn.objects.get(uid);
      const w = world.get(uid);
      const rec = drops.find((x) => x.uid === uid);
      if (!d || !w || !rec) {
        falling.delete(uid);
        continue;
      }
      d.root.matrix.setPosition(f.pos);
      d.root.matrixWorldNeedsUpdate = true;
      w.pos[0] = f.pos.x;
      w.pos[1] = f.pos.y;
      w.pos[2] = f.pos.z;
      rec.at = [f.pos.x, f.pos.y, f.pos.z];
      if (!moving) falling.delete(uid);
    }
  };
  const placeDrop = (d: DropRecord, fall = false): number | undefined => {
    const o: LevelObject = {
      index: -1,
      uid: d.uid,
      template: d.template,
      position: [d.at[0] * WORLD_SCALE, d.at[1] * WORLD_SCALE, d.at[2] * WORLD_SCALE],
      flags: 0x81,
      links: [],
      rotation: [0, d.yaw, 0],
      propWords: new Uint32Array(0),
      propIndices: new Uint16Array(0),
      ref: { pkg: 0, id: 0 },
    };
    const e = entityFromObject(o, packages);
    if (!PICKUP_CLASSES.has(e.className)) return undefined;
    byUid.set(d.uid, e);
    world.addEntity(e);
    dyn.spawnEntity(o, e);
    drops.push(d);
    nextDropUid = Math.max(nextDropUid, d.uid + 1);
    if (fall) falling.set(d.uid, { pos: new THREE.Vector3(d.at[0], d.at[1], d.at[2]), vel: new THREE.Vector3(), t: 0, resting: false });
    return d.uid;
  };
  const dropsProvider = {
    save: (): DropRecord[] => drops.map((d) => ({ ...d, at: [...d.at] as Vec3 })),
    load: (data: DropRecord[]) => {
      const keep = new Set((data ?? []).map((d) => d.uid));
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        if (keep.has(d.uid)) continue;
        world.ents.delete(d.uid);
        byUid.delete(d.uid);
        dyn.remove(d.uid);
        drops.splice(i, 1);
      }
      for (const d of data ?? []) if (!world.get(d.uid)) placeDrop(d);
    },
  };

  // Save state (src/game/save): level logic per level, the inventory travels with the player.
  const unregisterSave = [
    registerSave(ctx.services, 'drops', dropsProvider, { scope: 'level', priority: -1 }),
    registerSave(ctx.services, 'world', worldSaveProvider(world), { scope: 'level', priority: 0 }),
    registerSave(ctx.services, 'inventory', inventorySaveProvider(inventory, () => inventoryItems.clear(), byNameOnce(pkgs), (i) => rawInventory.add(i.name, i.count, i.template, i.className)), { scope: 'game', priority: 5 }),
  ];

  // --- Props, effects, lights, interactions -------------------------------------------
  const playKeys = (keys: string[], pos: Vec3, opts: { radius?: number; loop?: boolean; voice?: boolean } = {}) => {
    const ok = sfxKeys(keys);
    if (!ok.length) return undefined;
    const h = audio.play3D(ok[Math.floor(Math.random() * ok.length)], pos, { maxDistance: opts.radius, loop: opts.loop, bus: opts.voice ? 'voice' : undefined });
    return {
      stop: () => h.stop(0.15),
      get playing() {
        return h.playing;
      },
    };
  };
  let damage: DamageService | undefined;
  fx = new Fx({
    packages: pkgs,
    dyn,
    collision: view.collision,
    playSound: (keys, pos, opts) => playKeys(keys, pos, opts),
    // dt is already scaled by the renderer clock.
    timeScale: () => 1,
    spawnOther: (t, M, sctx) => props?.spawnOther(t, M, sctx) ?? false,
    // Object Generator p28 range: the player (the camera in fly mode).
    playerPos: () => {
      const p = view.walking ? view.player.position : view.camera.position;
      return [p.x, p.y, p.z];
    },
  });
  view.scene.add(fx.group);
  const lights = new Lights(world, pkgs, dyn, view.fog, loaded.level?.lightRegions);
  view.scene.add(lights.group);
  props = new Props({
    world,
    dyn,
    fx,
    packages: pkgs,
    collision: view.collision,
    damage: () => damage,
    playSound: (keys, pos, opts) => playKeys(keys, pos, opts),
    setLight: (uid, on) => lights.setLight(uid, on),
    player: () => (view.walking ? view.player : null),
    timeScale: () => 1,
  });
  view.scene.add(props.scatter);
  fx.placeLevel(world);
  damage = createDamageService(props, () => ctx.services.actors as Parameters<typeof createDamageService>[1] extends () => infer A ? A : never);
  const interact = new Interactions({
    world,
    pkgs,
    dyn,
    props,
    fx,
    player: view.player,
    camera: view.camera,
    renderer: view.renderer,
    scene: view.scene,
    collision: () => view.collision,
    walking: () => view.walking,
    playSound: (keys, pos, opts) => playKeys(keys, pos, opts),
    toast: (text, ms) => hud.toast(text, ms),
    banner: (text) => hud.banner(text),
    damage: () => damage,
    actors: () => ctx.services.actors as ReturnType<ConstructorParameters<typeof Interactions>[0]['actors']>,
  });

  // Searchlight Mountables (searchlight.ts): their beams, steered by the mounted player.
  searchlights = new Searchlights(world, dyn, pkgs);
  interact.onMountedPitch = (uid, pitch) => searchlights?.setPitch(uid, pitch);
  interact.onMountedToggle = (uid) => void searchlights?.toggle(uid);
  // Lit / dark and the beam's pitch go with the level's save (searchlight.ts).
  const unregisterSearchlights = registerSave<SearchlightsSave>(ctx.services, 'searchlights', { save: () => searchlights!.save(), load: (d) => searchlights?.load(d) }, { scope: 'level', priority: 3 });

  world.handlers.push((w, msg) => {
    if (w.cls === 'Map Switcher') {
      // The level map shown by the map screen (Map Item template p0); On (p1).
      if ((typeof w.e.values[1] === 'number' ? w.e.values[1] : 1) !== msg) return false;
      currentMap = (w.e.values[0] as ResRef | null) ?? currentMap;
      return true;
    }
    // Prefetchers only warm caches in the original; Level Transition Remover (p1 On) and
    // Object Grouper (logic.ts) need nothing here.
    return w.cls === 'Node Prefetcher' || w.cls === 'Instance Prefetcher' || w.cls === 'Level Transition Remover';
  });
  let currentMap: ResRef | undefined = (world.of('Level Properties')[0]?.e.values[45] as ResRef | null) ?? undefined;

  const unregisterProps = registerSave<{ props: PropsSaveState; lights: LightsSaveState }>(
    ctx.services,
    'props',
    {
      save: () => ({ props: props!.save(), lights: lights.save() }),
      load: (d) => {
        if (d.props) props!.load(d.props);
        if (d.lights) lights.load(d.lights);
      },
    },
    { scope: 'level', priority: 3 },
  );

  // Overlay + input.
  const overlay = new DevOverlay(world, view.camera, container, () => view.player.position.clone());
  view.scene.add(overlay.group);

  const ray = new THREE.Ray();
  const box = new THREE.Box3();
  const standBox = new THREE.Box3();
  const hit = new THREE.Vector3();
  let target: { w: WorldEntity; d: DynamicObject | undefined; use?: UseTarget } | null = null;

  const pickTarget = () => {
    const eye = view.walking ? view.player.eyePosition() : view.camera.position.clone();
    const dir = view.camera.getWorldDirection(new THREE.Vector3());
    ray.set(eye, dir);
    const reach = 3;
    const wall = view.collision?.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, reach);
    const limit = Math.min(reach, (wall?.distance ?? reach) + 0.15);
    // The original never ranks pickups against usables (docs/game-logic.md §14.5 "Use
    // target"): a pickup is taken by touch (the Item touch handler 0x100bda00, within Player
    // p239 / p240 = 2 m), the Use key only goes to usables. The port takes items with E instead
    // of touch, so an item offered here comes first: the original would have taken it anyway.
    // Items: the one closest to the view direction (within ~22 deg, 2.8 m, not behind a wall).
    // An item granted by a Quest Item Pickup targets that spot, scenery items nothing (logic.ts
    // pickupVia: 1a's Shiv in the inmate's back is taken through spot 8368, which kills him).
    let item: typeof target = null;
    let itemScore = Infinity;
    const v = new THREE.Vector3();
    for (const cls of PICKUP_CLASSES) {
      for (const seen of world.of(cls)) {
        if (seen.destroyed || !seen.visible || seen.s.taken) continue;
        const w = world.pickupVia(seen);
        if (!w) continue;
        v.set(seen.pos[0], seen.pos[1] + 0.1, seen.pos[2]).sub(eye);
        const dist = v.length();
        if (dist > 2.8 || dist < 1e-3) continue;
        const cos = v.dot(dir) / dist;
        if (cos < 0.93) continue;
        const occ = view.collision?.raycast(eye.x, eye.y, eye.z, v.x, v.y, v.z, dist);
        if (occ && occ.distance < dist - 1.0) continue;
        const score = (1 - cos) * 10 + dist * 0.1;
        if (score < itemScore) (itemScore = score), (item = { w, d: dyn.objects.get(seen.uid), use: undefined });
      }
    }
    if (item) return item;
    const used = interact.pick(eye, dir, limit);
    if (used) return { w: used.w, d: dyn.objects.get(used.uid), use: used };
    // Switches / doors: looked at (the ray hits their box before any wall: the port's prompt),
    // and usable from where the player stands as the original tests it (Interactions
    // switchReach: the template fit test, reach / height / facing / side); the nearest
    // approach point wins, as the original ranks usables [verified].
    let best: typeof target = null;
    let bestScore = Infinity;
    for (const d of dyn.objects.values()) {
      if (!d.visible) continue;
      const w = world.get(d.uid);
      // p23 = 0: the player cannot use it (scripted doors); the engine never offers it.
      if (!w || !world.switchUsable(w)) continue;
      const c = d.root.matrix.elements;
      const dx = c[12] - eye.x, dy = c[13] - eye.y, dz = c[14] - eye.z;
      if (dx * dx + dy * dy + dz * dz > 36) continue;
      dyn.bounds(d, box);
      // A lever's box (its p37 base) is looked at as the switch.
      if (d.stand?.visible) box.union(dyn.bounds(d.stand, standBox));
      const p = ray.intersectBox(box, hit);
      if (!p) continue;
      const t = p.distanceTo(eye);
      if (t > limit) continue;
      const reach = view.walking ? interact.switchReach(w) : undefined;
      if (reach === null) continue;
      const score = reach ?? t;
      if (score < bestScore) (bestScore = score), (best = { w, d: d as DynamicObject | undefined, use: undefined });
    }
    // A Switch without a model (the only one: 6a's truck jack a08, Interaction Properties 2:924,
    // whose use drops the truck into the creek, the way out of the level) has no box to look at.
    // The original lists usables by touch and the fit test, not by the view (§14.5 "Use target");
    // the port offers it when a template fits and the view passes within 0.6 m of its anchor
    // [inferred: its touch volume is not decoded].
    if (view.walking) {
      for (const w of world.of('Switch')) {
        if (w.destroyed || !w.visible || dyn.objects.has(w.uid) || !world.switchUsable(w)) continue;
        const dx = w.pos[0] - eye.x, dy = w.pos[1] - eye.y, dz = w.pos[2] - eye.z;
        if (dx * dx + dy * dy + dz * dz > 36) continue;
        if (!viewOnAnchor(eye, dir, interact.switchAnchors(w), reach)) continue;
        const r = interact.switchReach(w);
        if (typeof r !== 'number') continue;
        if (r < bestScore) (bestScore = r), (best = { w, d: undefined, use: undefined });
      }
    }
    return best;
  };

  const promptFor = (w: WorldEntity): string => {
    if (PICKUP_CLASSES.has(w.cls)) return `<b>E</b> Pick up ${world.itemLabel(w)}`;
    const m = w.s.motion as SwitchMotion;
    if (!w.s.unlocked) return `<b>E</b> Try door · locked`;
    if (m.kind === 'none') return `<b>E</b> Use`;
    const opening = !(w.s.moving ? Number(w.s.target) === 1 : !!w.s.open);
    return `<b>E</b> ${opening ? 'Open' : 'Close'}`;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || (e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    // A use animation, mounted gun / ladder / monitor view take their keys first.
    if ((interact.using || interact.viewingMonitor || interact.mounted || interact.climb || props!.grabbed() !== undefined) && interact.onKey(e.code)) return;
    if (e.code === 'Space') {
      interact.onKey('Space');
      return;
    }
    if (e.code === 'KeyE') {
      // Held by a creature: Use is a struggle press (specials/hold.ts).
      if (view.player.attackOverride?.()) return;
      const t = pickTarget();
      if (!t) {
        interact.onKey('KeyE');
        return;
      }
      if (t.use) t.use.use();
      else if (PICKUP_CLASSES.has(t.w.cls)) {
        world.send(t.w.uid, 402, world.playerUid);
        // A Quest Item Pickup is a usable object: its use animation hands the item over.
        if (t.w.cls === 'Quest Item Pickup') interact.useSpot(t.w);
        else world.pickup(t.w);
      } else {
        const r = interact.useSwitch(t.w);
        if (r === 'Locked') hud.toast('Locked', 1200);
      }
    } else if (e.code === 'Enter') {
      if (world.activeCutscenes().length) {
        world.skipCutscenes();
        hud.toast('Cutscene skipped', 1200);
      }
    } else if (e.code === 'Backquote') {
      hud.toast(overlay.toggle() ? 'Dev overlay on' : 'Dev overlay off', 1000);
    }
  };
  window.addEventListener('keydown', onKey);

  // Level parts drawn see-through, by part index (static RayHit.part); built on first use.
  let staticSeeThrough: Uint8Array | undefined;
  const seeThroughStatic = () => {
    if (!staticSeeThrough) {
      const alpha = new Set((loaded.textures ?? []).filter((t) => t.hasAlpha).map((t) => t.key));
      // Collision parts: AI sight passes an object with engine +8 bit 0x20000 (MeshPart.sightPass,
      // docs/game-logic.md §14.10); the drawn parts (no collision parts): see-through surfaces.
      const col = loaded.level?.collision;
      staticSeeThrough = col ? Uint8Array.from(col, (p) => (p.sightPass ? 1 : 0)) : seeThroughParts(loaded.level?.parts ?? [], (k) => alpha.has(k));
    }
    return staticSeeThrough;
  };
  // Drawn parts the eye sees through (LevelRenderer.drawn hits; the actors' draw occlusion).
  let drawnSeeThrough: Uint8Array | undefined;
  const seeThroughDrawn = () => {
    if (!drawnSeeThrough) {
      const alpha = new Set((loaded.textures ?? []).filter((t) => t.hasAlpha).map((t) => t.key));
      drawnSeeThrough = seeThroughParts(loaded.level?.parts ?? [], (k) => alpha.has(k));
    }
    return drawnSeeThrough;
  };
  const service: WorldService = {
    world,
    interact,
    send: (uid, message, sender = 0) => world.send(uid, message, sender),
    fire: (uid, slot) => world.fire(uid, slot),
    subscribe: (uid, fn) => world.subscribe(uid, fn),
    isVisible: (uid) => world.get(uid)?.visible ?? true,
    dynamicParts: (uid) => {
      const d = dyn.objects.get(uid);
      return d ? dyn.worldParts(d) : undefined;
    },
    isDestroyed: (uid) => world.get(uid)?.destroyed ?? false,
    door: (uid) => {
      const w = world.get(uid);
      if (!w || w.cls !== 'Switch') return undefined;
      return { open: !!w.s.open, moving: !!w.s.moving, locked: !w.s.unlocked };
    },
    openDoor: (uid) => {
      const w = world.get(uid);
      if (w && w.cls === 'Switch' && !w.destroyed) world.switchSet(w, true);
    },
    dropItem: (template, at, yawDeg = 0, opts) => placeDrop({ uid: nextDropUid, template, at: [at[0], at[1], at[2]], yaw: yawDeg }, !!opts?.fall),
    propTarget: (uid) => props?.targetInfo(uid),
    passages: world.of('Edge Passage').map((w) => ({ door: Number(w.e.values[1]) || 0, nodeA: Number(w.e.values[2]) || 0, nodeB: Number(w.e.values[3]) || 0 })),
    onStompTransform: (fn) => {
      stompListeners.push(fn);
      return () => stompListeners.splice(stompListeners.indexOf(fn), 1);
    },
    get inCutscene() {
      return world.playerInCutscene();
    },
    fx: fx!,
    seeThrough: (hit) => {
      if (hit.dynamic !== undefined) {
        const uid = dyn.uidOfBody(hit.dynamic);
        return uid !== undefined && dyn.seeThrough(uid, hit.part);
      }
      return !!seeThroughStatic()[hit.part];
    },
    shotThrough: (hit) => {
      if (hit.dynamic !== undefined) {
        const uid = dyn.uidOfBody(hit.dynamic);
        const d = uid !== undefined ? dyn.objects.get(uid) : undefined;
        return d?.collisionLocal ? false : service.seeThrough(hit);
      }
      return loaded.level?.collision ? false : service.seeThrough(hit);
    },
    eyeThrough: (hit) => (hit.dynamic !== undefined ? service.seeThrough(hit) : !!seeThroughDrawn()[hit.part]),
  };
  ctx.services.world = service;
  ctx.services.inventory = inventory;
  ctx.services.damage = damage;
  ctx.services.time = timeService;
  // Static props drawn merged per material (src/app/prop-batch.ts). Built on the first update,
  // once the level logic, lights and props have set up their initial state.
  let batch: StaticBatch | null = null;
  const buildBatch = () => {
    // Levels without zones: batches split on a 64-unit grid so they still frustum-cull.
    batch = new StaticBatch(dyn.batchCandidates(), view.scene, { cell: view.culler?.hasZones ? 0 : 64 });
    view.scene.add(batch.group);
    view.batches.add(batch);
    view.culler?.refreshObjects();
  };
  Object.assign(window, { __world: { world, dyn, blockers, overlay, service, inventory, pickTarget, props, fx, lights, interact, damage, searchlights: () => searchlights, time: timeService, map: () => currentMap, batch: () => batch } });

  console.info(
    `[world] ${entities.length} entities, ${dyn.objects.size} dynamic objects, ${world.of('Detector').length} detectors, props ${JSON.stringify(props.stats())}, fx ${JSON.stringify(fx.stats())} (${(performance.now() - t0).toFixed(0)} ms)`,
  );

  let statusAcc = 1;
  return {
    name: 'world',
    update(dt) {
      if (falling.size) updateFalling(dt);
      world.update(dt);
      props!.update(dt);
      fx!.update(dt, view.camera);
      lights.update(dt, view.camera);
      interact.update(dt);
      searchlights?.update();
      blockers.update();
      target = interact.using ? null : pickTarget();
      hud.prompt(target ? (target.use ? target.use.prompt : promptFor(target.w)) : null);
      overlay.update(dt);
      if (!batch && !NO_BATCH) buildBatch();
      statusAcc += dt;
      if (statusAcc > 0.25) {
        statusAcc = 0;
        const c = combat();
        // The combat HUD (actors system) shows health when present.
        const hp = c ? '' : `Health ${Math.round(inventory.health)}/${inventory.maxHealth}`;
        const items = [...inventory.items.values()].filter((i) => i.count > 0).map((i) => (i.count > 1 ? `${i.name} ×${i.count}` : i.name));
        hud.status([hp, items.length ? `Inventory: ${items.join(' · ')}` : ''].filter(Boolean).join('<br>'));
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      for (const off of unregisterSave) off();
      unregisterProps();
      unregisterSearchlights();
      searchlights?.dispose();
      interact.dispose();
      props?.dispose();
      fx?.dispose();
      lights.dispose();
      if (ctx.services.damage === damage) delete ctx.services.damage;
      if (ctx.services.time === timeService) delete ctx.services.time;
      overlay.dispose();
      if (batch) {
        view.batches.delete(batch);
        batch.dispose();
        batch = null;
      }
      dyn.dispose();
      blockers.dispose();
      hud.dispose();
      if (ctx.services.world === service) delete ctx.services.world;
    },
  };
}
