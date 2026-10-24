// Actors game system: player body, NPC/creature actors with their behaviours, the level-logic
// classes that drive them (director.ts) and basic combat with a minimal HUD.
//
// Services published on ctx.services (look them up lazily; systems start in order):
//
//   services.actors: ActorsService
//     list()                      all actors (creatures, NPCs, skinned decorations); Object
//                                 Cloner templates are left out
//     get(uid)                    actor placed from the level object with this uid (or a
//                                 clone's synthetic uid)
//     spawn(template, feet, yaw)  create a creature from an .odu template ref (feet in output
//                                 space, yaw three.js convention: 0 = facing -Z); it takes its
//                                 template's initial / active behaviours
//     damage(actor, amount, from?, by?) -> killed   `by`: attacking actor, 'player' (default:
//                                 the actor fights back against the player) or a hazard's uid
//     receive(uid, message)       level-logic message to an actor (BlowUp, Destroy, Gib,
//                                 invulnerability, On = wake; template uids reach their clones)
//     setVisible(uid, visible)    show/hide a placed actor (Visibility Toggler, STOMP visibility
//                                 keys). Showing also ends dormancy (drop-ins start falling).
//     isVisible(uid)              shown and not dormant-hidden
//     wake(uid)                   end dormancy (reveal, ceiling hangers let go, drop-ins fall)
//     setBehavior(uid, behaviorUid)  hand a placed behaviour object to an actor (tests / tools)
//     raycast(origin, dir, max, includeDead?)  nearest live actor on a ray (world occlusion
//                                 applied); 'cuttable' adds bodies with Part Caps left
//     playerBody                  the player's body: play(clipRefOrRole, { loop?, fade?, lock?,
//                                 onEnd?, ... }) / release() / setRate() for interaction clips
//                                 (documented at the top of player-body.ts)
//     on('death'|'damage'|'spawn', fn) -> unsubscribe   (manager.ts ActorDeathInfo / ActorDamageInfo)
//                                 death:  { source: 'player' | uid, killer?: Actor }
//                                 damage: { amount, killed, source: 'player' | uid, by?: Actor }
//                                 source = who dealt the blow: the player, an actor's uid, or a
//                                 hazard object's uid (Damage Action Object)
//
//   services.combat: CombatService
//     player { health, maxHealth, alive }
//     damagePlayer(amount, source?)   e.g. hazards, falls
//     healPlayer(amount) -> applied   e.g. Health Bonus Item pickups
//     attack('melee' | 'fire')        trigger a player attack
//
// Consumed (optional): services.world (send / subscribe / door state / passages / STOMP
// poses), services.lipsync (jaw), services.insanity.addReputation(points, victimUid) for
// kill reputation (victim p166 when the player kills it), services.save (save providers).
//
// Debug: window.__actors { manager, director, env, services, ... }.

import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import { parseEntities, readXduString, type Entity, type EntityPackageSet } from '../../formats/entities';
import { instanceRotation, toOutputSpace } from '../../formats/level';
import type { ResRef } from '../../formats/model';
import { SoundCategory } from '../../formats/sound';
import type { RayHit, Vec3Like } from '../../app/physics';
import { loadSettings } from '../../app/menu/settings';
import { ActorManager, type ActorHitInfo, type ActorDeathInfo, type ActorEvent, type ActorHit } from './manager';
import type { Actor, ActorEnv, DamageSource, PropTargetInfo } from './actor';
import { engineLens, PlayerBody, PLAYER_MODEL } from './player-body';
import { PlayerCombat, resolveWeaponSounds } from './combat';
import { createCombatHud } from './hud';
import { lipSyncService } from './lipsync';
import { ambientBlow, Director, type DirectorSave, type SpawnerSave } from './director';
import { portOptions } from '../port-options';
import { ActorFx } from './fx';
import { clearLine, ladderEdgeOpen, lockPassDoors } from './nav';
import { fleeGroups, type FleeSpot } from './flee';
import { loadSubtitleFont, SubtitleOverlay } from '../sequence/subtitles';
import { actorsSaveProvider, combatSaveProvider, registerSave } from '../save/providers';
import { installSpecials, type SpecialsSaveState } from './specials';
import { hardpointTable } from '../weapons/hardpoints';
import { deathDropPairs } from './drops';
import { handDropPose } from '../world/drop-fall';
import { applyCarry, pendingCarry, recordCarry, type ArrivedCompanion } from './companions';
import type { NoiseSpec } from './behaviors';
import { modelHitSpheres, posedSpheres } from '../fx/gas-system';
import { KILLED_BY_PLAYER_OUTPUT, killReputation } from '../insanity/reputation';
import { readSkeletonTrailer, type SkeletonSphere } from '../../formats/skeleton';
import { bleedsOutBeforeUp, CAP_LIMB, characterValues, Dismemberment, readPartCapRef, refsOf, segmentBonesOf, templateClass, type PartActor, type PartCapRule, type PartsSave } from './dismember';
import { corpseBlowKind, readGibRule, readThrownBody, throwDirection, type GibRule } from './gibs';
import { ANIM_EVENT_MESSAGE, readAnimEvents } from '../../formats/animation';
import { buildHeldModel } from '../weapons/models';
import type { ArcHandle, ArcTarget } from '../fx/electric-arc';
import { gore } from '../fx/gore-bus';

export interface ActorsService {
  list(): readonly Actor[];
  get(uid: number): Actor | undefined;
  spawn(template: ResRef, feet: Vec3Like, yaw?: number): Actor | undefined;
  damage(actor: Actor, amount: number, from?: Vec3Like, by?: DamageSource, hit?: ActorHitInfo): boolean;
  receive(uid: number, message: number): boolean;
  setVisible(uid: number, visible: boolean): boolean;
  isVisible(uid: number): boolean;
  wake(uid: number): boolean;
  setBehavior(uid: number, behaviorUid: number): boolean;
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number, includeDead?: boolean | 'cuttable'): ActorHit | null;
  /** An actor's leaf hit spheres as posed now (world space): what creature blows test on bodies. */
  hitSpheres(a: Actor): { c: [number, number, number]; r: number }[];
  /** The player's body: play(clip, opts) / release() for interaction clips (player-body.ts). */
  readonly playerBody: PlayerBody | null;
  /**
   * Cinematic camera posed after this frame's actor update: the sequence system calls it once it
   * has set one. Marks the camera as cinematic (draw culling by frustum only, no occlusion:
   * docs/game-logic.md §15.5) and redoes the culling for it.
   */
  refreshVisibility(camera: THREE.PerspectiveCamera): void;
  /**
   * AI noise (docs/game-logic.md §15.8): `sound` is an InvestigateSound template (p0 radius m,
   * p1 level; e.g. a footstep's Material Effects p7, a Missile's p16 shot / p14 impact) or the
   * values themselves; `source` 'player' (default) or an actor. Characters with an
   * InvestigateBehavior come to look.
   */
  noise(at: Vec3Like, sound: ResRef | NoiseSpec | null | undefined, source?: 'player' | Actor): void;
  on(ev: ActorEvent, fn: (a: Actor, info?: unknown) => void): () => void;
}

export interface CombatService {
  readonly player: { readonly health: number; readonly maxHealth: number; readonly alive: boolean };
  damagePlayer(amount: number, source?: unknown): void;
  healPlayer(amount: number): number;
  attack(kind: 'melee' | 'fire'): boolean;
}

/** The parts of services.world (src/game/world) used here; all optional. */
interface WorldMessaging {
  send?(uid: number, message: number, senderUid?: number): void;
  subscribe?(uid: number | '*', fn: (message: number, from: number, to: number) => void): () => void;
  isVisible?(uid: number): boolean;
  isDestroyed?(uid: number): boolean;
  readonly inCutscene?: boolean;
  readonly passages?: readonly { door: number; nodeA: number; nodeB: number }[];
  door?(uid: number): { open: boolean; moving: boolean; locked: boolean } | undefined;
  openDoor?(uid: number): void;
  dropItem?(template: ResRef, at: [number, number, number], yawDeg?: number, opts?: { fall?: boolean }): number | undefined;
  propTarget?(uid: number): PropTargetInfo | undefined;
  onStompTransform?(
    fn: (uid: number, key: { quat: [number, number, number, number]; position: [number, number, number] } | null) => void,
  ): () => void;
  readonly world?: { readonly playerUid?: number };
  /** Collision hits the eye passes through (cut-out bars, glass): occlusion looks past them. */
  seeThrough?(hit: RayHit): boolean;
  /** Does the eye see through a hit on the drawn triangles (LevelRenderer.drawn)? */
  eyeThrough?(hit: RayHit): boolean;
  /** Does a shot pass a collision hit (docs/game-logic.md §14.10)? */
  shotThrough?(hit: RayHit): boolean;
}

interface WeaponsLike {
  npcWeapons?(a: Actor): THREE.Object3D[];
  npcWeaponsInHand?(a: Actor): boolean;
  throwObject?(template: ResRef, from: THREE.Vector3Like, vel: THREE.Vector3Like, by?: Actor): boolean;
}
interface FxLike {
  muzzleFlash?(r: ResRef, parent: THREE.Object3D): unknown;
}

interface InsanityLike {
  addReputation?(points: number, fromUid?: number): void;
}


export async function createActorsSystem(ctx: GameContext): Promise<GameSystem> {
  const { view, audio } = ctx;
  /** The director's Action Dialog reputation (set once the director exists, below). */
  let repHooks: { hit(a: Actor): number; kill(a: Actor): number } | undefined;
  const { lvl, packages } = ctx.loaded;
  if (!lvl || !packages) return { name: 'actors (no level data)' };
  const pkgs = packages as EntityPackageSet;

  const t0 = performance.now();
  let entities: Entity[] = [];
  try {
    entities = parseEntities(lvl, packages, { resolveStrings: false });
  } catch (err) {
    console.warn('[actors] entity parse failed', err);
  }
  const byUid = new Map(entities.map((e) => [e.uid, e]));

  const playerEnt = entities.find((e) => e.className === 'Player' && !(e.flags & 0x8));
  const body = PlayerBody.create(view.player, view.scene, packages, playerEnt?.modelRef ?? PLAYER_MODEL, view.viewmodel);
  // The level's lens (Level Properties p16), set at level start like the original (0x100b2346).
  view.setLens(engineLens(packages));

  const manager = new ActorManager(packages, view.scene, view.collision);
  manager.populate(entities, packages);
  // Present-at-start flag (docs/game-logic.md §11.3): without 0x1 an object appears later.
  for (const a of manager.actors) if (a.entity && !(a.entity.flags & 1)) a.ch.root.visible = false;
  // Draw culling against the camera the frame is drawn with (the player moves it after us).
  const offDraw = view.onBeforeDraw(() => manager.visibilityPass(view.camera));
  manager.zoneVisible = (x, y, z, r) => view.culler?.objectVisible(x, y, z, r) ?? true;

  const container = view.renderer.domElement.parentElement ?? document.body;
  const hud = createCombatHud(container);
  const fx = new ActorFx(view.scene);
  const subs = new SubtitleOverlay(container, null);
  void loadSubtitleFont(ctx.fs).then((f) => subs.setFont(f));
  let clock = 0;

  const worldSvc = () => ctx.services.world as WorldMessaging | undefined;
  /** Fire a Character output slot (property index) to the actor's links. */
  const fireSlot = (a: Actor, slot: number) => {
    const e = a.entity;
    const msg = e?.values[slot];
    const w = worldSvc();
    if (!e || typeof msg !== 'number' || !msg || typeof w?.send !== 'function') return;
    for (const uid of e.links) w.send(uid, msg, a.uid ?? e.uid);
  };

  const combat = new PlayerCombat(view, audio, manager, body, hud, resolveWeaponSounds(packages), () => {});

  const playSound = (keys: string[], pos: THREE.Vector3Like, volume = 1, from?: Actor) => {
    const ok = keys.filter((k) => audio.get(k));
    if (!ok.length) return;
    const h = audio.play3D(ok[Math.floor(Math.random() * ok.length)], [pos.x, pos.y, pos.z], { volume, bus: 'sfx' });
    if (from) lipSyncService(ctx)?.speak(h, from.uid, from.ch);
    return h;
  };

  /** Dialog line: positional voice, jaw, subtitle (when enabled). Returns its length (s). */
  const speakLog: { t: number; key: string; who: string; subtitle?: string }[] = [];
  const speak = (keys: string[], speaker: Actor | undefined, at: { x: number; y: number; z: number }): number => {
    const ok = keys.filter((k) => audio.get(k));
    if (!ok.length) return 0;
    const k = ok[Math.floor(Math.random() * ok.length)];
    const info = audio.get(k)!;
    const dialog = info.category === SoundCategory.Dialog;
    const h = audio.play(k, { position: [at.x, at.y, at.z], bus: dialog ? 'voice' : undefined });
    if (speaker) lipSyncService(ctx)?.speak(h, speaker.uid, speaker.ch);
    const text = info.subtitle ? readXduString(pkgs, info.subtitle) : undefined;
    if (text && loadSettings().subtitles) subs.show(text, clock, Math.max(1.5, info.duration));
    speakLog.push({ t: +clock.toFixed(2), key: k, who: speaker?.ch.root.name ?? '-', subtitle: text });
    if (speakLog.length > 100) speakLog.shift();
    return info.duration || 2;
  };

  // Doors on Move Node edges (Edge Passage): node-index pair -> Switch uid.
  const doorOf = new Map<string, number>();
  const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  /** Edge Passage nodeA (node index) per edge: the passage's forward direction (Ladder p34). */
  const passageFrom = new Map<string, number>();
  const doorState = (d: number) => worldSvc()?.door?.(d);
  // A locked door is passed (as an unlocked one: with an OpenDoorBehavior) when its Edge Passage
  // has p4 = 1 (nav.ts lockPassDoors): 1c's companion through 5262 to his waypoint, the 2
  // Cellblocks gunner out of his locked nest (be4). Locked door kind 6 (OpenDoorBehavior p6 = 1
  // breaks a destructible door) is not modelled.
  const lockPass = lockPassDoors(entities);
  const passesLocks = (d: number, who: Actor) => lockPass.has(d) && who.profile.openDoor !== null;
  // Flee Positions: linked ones form a group (flee.ts fleeGroups); p0 > 0 limits the height
  // difference (m) [verified, 0x100adaa0].
  const fleeEnts = entities.filter((e) => e.className === 'Flee Position');
  const fleeGroup = fleeGroups(fleeEnts);
  const fleePositions: FleeSpot[] = fleeEnts.map((e) => {
    const [x, y, z] = toOutputSpace(e.position);
    const dy = e.values[0];
    const node = manager.nav?.size ? manager.nav.nearest(x, y, z, view.collision ?? null) : -1;
    return { uid: e.uid, x, y, z, group: fleeGroup.get(e.uid) ?? -1, maxDy: typeof dy === 'number' ? dy : -1, failedAt: -Infinity, node };
  });

  const sphereTrees = new Map<string, SkeletonSphere[]>();
  const fpModel = ((v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : undefined))(playerEnt?.values[227]);
  const env: ActorEnv = {
    world: view.collision!,
    nav: manager.nav,
    player: view.player,
    playerAlive: true,
    playerUid: playerEnt?.uid ?? 0,
    // Hit spheres the NPC weapon sweep tests (npc-melee.ts): skeleton sphere tree leaves as posed
    // now; the player's of the model he shows (fx/gas-system.ts does the same for gas).
    hitSpheres: (who) => {
      // The sphere tree skips the spheres of cut nodes (SUFFERING.EXE 0x4271fd: dismember.ts).
      if (who !== 'player') return posedSpheres(who.ch, modelHitSpheres(packages, who.kind.skinned.ref, sphereTrees).filter((n) => !parts.isGone(who, n.bone)));
      const b = body?.body;
      if (!b) return [];
      const fp = (view.player as { mode?: string }).mode === 'fp';
      return posedSpheres(b, modelHitSpheres(packages, fp && fpModel ? fpModel : b.skinned.ref, sphereTrees));
    },
    // The player as other characters' target: Player GameObject p4 / p8 (2:5: 0.5 / 4) [data].
    playerTarget: {
      priority: typeof playerEnt?.values[4] === 'number' ? playerEnt.values[4] : 0.5,
      maxAttackers: typeof playerEnt?.values[8] === 'number' ? playerEnt.values[8] : 4,
      healthFrac: () => (combat.maxHealth > 0 ? Math.max(0, combat.health) / combat.maxHealth : 1),
    },
    time: 0,
    actors: manager.actors,
    behaviors: manager.behaviors,
    damagePlayer: (amount, from, hit) => playerBlow(amount, from, hit),
    damageActor: (t, amount, from, hit) => {
      manager.damage(t, amount, from.position, from, hit && { point: hit.point, type: hit.type, bone: hit.bone });
    },
    propTarget: (uid) => worldSvc()?.propTarget?.(uid),
    // A KillEnemies object target (a fence Breakable) hit by a character: through services.damage
    // like the player's hits, the attacker's uid as the source.
    damageProp: (uid, amount, from, at) => {
      const dmg = ctx.services.damage as { apply?(e: { point: THREE.Vector3Like; amount: number; source?: unknown; targetUid?: number }): unknown } | undefined;
      dmg?.apply?.({ point: { x: at.x, y: at.y, z: at.z }, amount, source: from.uid ?? from.entity?.uid, targetUid: uid });
    },
    sound: playSound,
    onDeath: (a) => {
      // source: 'player' or the killer's uid (insanity credits player kills exactly).
      const info: ActorDeathInfo = { source: a.lastHitBy, killer: a.killedBy };
      manager.emit('death', a, info);
      // Specials (bosses with their own outputs, e.g. Black One p76) fire their death outputs themselves.
      if (!specials.died(a)) fireSlot(a, 28);
      // A Character's death (0x100e2620, once each by the flags 0x800 / 0x1000) fires its output
      // p28, then sends the message held in p29 to its links (vt +0xc: a plain message, not an
      // output slot) [verified]. 10's dark selves a46 / a48 (p28 none, p29 19 Died) end their
      // waves that way: Relays a49 / a8c take 19 and stop the cloners b32 / b2d.
      if (a.entity?.family === 'Character') fireSlot(a, 29);
      // The weapon in its hand falls as its pickup (drops.ts: only when it holds one, p53 or a
      // SpawnWeapons event, and its p109 drops it) from where the hand holds it, turned upright
      // (world/drop-fall.ts); the hand model goes with it (weapons/npc.ts).
      const wpn = ctx.services.weapons as WeaponsLike | undefined;
      const inHand = wpn?.npcWeaponsInHand ? wpn.npcWeaponsInHand(a) : undefined;
      const drops = a.entity ? deathDropPairs(packages, a.entity.values, inHand) : [];
      if (drops.length && typeof worldSvc()?.dropItem === 'function') {
        const held = wpn?.npcWeapons?.(a) ?? [];
        drops.forEach(({ weapon, drop }, i) => {
          const m = held.find((o) => o.name === `npc-weapon ${weapon.pkg}:${weapon.id}`);
          const pose = m ? handDropPose(m) : undefined;
          const at: [number, number, number] = pose ? pose.at : [a.position.x + 0.5 * Math.cos(a.yaw + i), a.bottom + 0.05, a.position.z - 0.5 * Math.sin(a.yaw + i)];
          worldSvc()!.dropItem!(drop, at, pose ? pose.yawDeg : (-a.yaw * 180) / Math.PI, { fall: !!pose });
        });
      }
      // Kill reputation (insanity/reputation.ts): a Character's p166 plus its attached Action
      // Dialog's p22 when not paid yet, an Ambient Creature's p26, when the player killed it
      // (insanity rules own the value; Reputation Points Senders are handled there). Then a
      // Character fires its output p169 ("killed by the player", 0x100e75fa: 1b's CartWheelers
      // 8b46 / 8b47 -> Reputation Points Sender 8b63, -5 each).
      if (info.source === 'player' && a.entity) {
        const ins = ctx.services.insanity as InsanityLike | undefined;
        const pts = killReputation(a.entity.className, a.entity.values) + (repHooks?.kill(a) ?? 0);
        if (pts && typeof ins?.addReputation === 'function') ins.addReputation(pts, a.uid ?? a.entity.uid);
        if (a.entity.className !== 'Ambient Creature') fireSlot(a, KILLED_BY_PLAYER_OUTPUT);
      }
    },
    clip: (a, r) => (r ? manager.kinds.clipIndex(a.kind, r) : -1),
    channelBone: (a, c) => hardpointTable(packages, a.kind.skinned.ref)[c],
    entity: (uid) => byUid.get(uid),
    send: (uid, msg, from) => worldSvc()?.send?.(uid, msg, from),
    say: (a, line) => speak(line.sounds, a, { x: a.position.x, y: a.bottom + a.height * 0.9, z: a.position.z }),
    weaponMuzzle: (a, r) => {
      // NPC weapons ride the hands (src/game/weapons/npc.ts); fire from the held model.
      const held = (ctx.services.weapons as WeaponsLike | undefined)?.npcWeapons?.(a)?.[0];
      if (!held) return undefined;
      held.updateWorldMatrix(true, false);
      const fxs = ctx.services.fx as FxLike | undefined;
      // The model is hidden while the actor is culled (or a STOMP key holds the hand).
      if (r.flash && held.visible && typeof fxs?.muzzleFlash === 'function') {
        try {
          fxs.muzzleFlash(r.flash, held);
        } catch {
          /* optional */
        }
      }
      return held.getWorldPosition(new THREE.Vector3());
    },
    shotFx: (from, to, _hit, speed) => (speed ? fx.missile(from, to, speed) : fx.shot(from, to)),
    throwObject: (t, from, vel, by) => void (ctx.services.weapons as WeaponsLike | undefined)?.throwObject?.(t, from, vel, by),
    spawnFx: (t, at, n) => (ctx.services.fx as { spawnAt?(r: ResRef, p: THREE.Vector3Like, n?: THREE.Vector3Like): void } | undefined)?.spawnAt?.(t, at, n ?? { x: 0, y: 1, z: 0 }),
    fleePositions,
    seeThrough: null,
    noise: (at, spec, from) => manager.noise(at, spec, from),
    ladder: (a, b) => {
      const d = doorOf.get(edgeKey(a, b));
      const e = d === undefined ? undefined : byUid.get(d);
      if (!e || e.className !== 'Ladder') return undefined;
      const [x, y, z] = toOutputSpace(e.position);
      // Facing: the ladder model's -Z, flattened (as the player's ladder, interact.ts).
      const R = instanceRotation(e.rotation);
      const l = Math.hypot(R[2], R[8]) || 1;
      const h = e.values[30];
      return { uid: e.uid, x, y, z, fx: -R[2] / l, fz: -R[8] / l, height: Math.max(1, typeof h === 'number' ? h : 4) };
    },
    closedDoor: (a, b) => {
      const d = doorOf.get(edgeKey(a, b));
      if (d === undefined) return undefined;
      const st = doorState(d);
      return st && !st.open ? d : undefined;
    },
    navBlocked: (a, b, who) => {
      const d = doorOf.get(edgeKey(a, b));
      if (d === undefined) return false;
      // A ladder edge: only for characters with a LadderClimbBehavior (nav.ts ladderEdgeOpen).
      const le = byUid.get(d);
      if (le?.className === 'Ladder') {
        const st = (worldSvc() as { world?: { get?(uid: number): { s: { unlocked?: boolean } } | undefined } } | undefined)?.world?.get?.(d)?.s;
        return !ladderEdgeOpen({ climber: !!who.profile.ladder, unlocked: st?.unlocked !== false, oneWay: Number(le.values[34]) || 0, forward: passageFrom.get(edgeKey(a, b)) === a });
      }
      const st = doorState(d);
      if (!st || st.open) return false;
      // Locked doors only open for scripts (Switch p63) and for people on the player's side;
      // creatures without an OpenDoorBehavior can't open doors at all.
      if (st.locked && !Number(byUid.get(d)?.values[63] ?? 0) && !passesLocks(d, who)) return true;
      return who.profile.openDoor === null;
    },
    openDoor: (d, who) => {
      const st = doorState(d);
      if (!st || st.open || st.moving) return;
      if (st.locked && !Number(byUid.get(d)?.values[63] ?? 0) && passesLocks(d, who)) {
        worldSvc()?.openDoor?.(d);
        director.note(`${who.ch.root.name} opens locked door #${d.toString(16)}`);
        return;
      }
      const msg = byUid.get(d)?.values[61];
      worldSvc()?.send?.(d, typeof msg === 'number' && msg ? msg : 1, who.uid ?? 0);
      director.note(`${who.ch.root.name} opens door #${d.toString(16)}`);
    },
    doorOpen: (d) => {
      const st = doorState(d);
      return !st || st.open;
    },
  };
  manager.env = env;
  // Arrived through a transition that carried companions (companions.ts).
  const strOf = (v: unknown) =>
    typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) ? (readXduString(pkgs, v as ResRef) ?? '') : '';
  const arrived: ArrivedCompanion[] = applyCarry(ctx.spawnName, entities, manager, strOf);
  for (const c of arrived) console.info(`[actors] companion ${c.actor.ch.root.name} placed at the Companion Spawn Point`);
  // Special moves and bosses by class name (specials/index.ts; docs/game-logic.md §15.7).
  const specials = installSpecials(ctx, manager, entities);
  manager.on('damage', (a, info) => {
    if (!(info as { killed?: boolean })?.killed) fireSlot(a, 15);
    // A hit of the player's on an NPC with an attached Action Dialog: the dialog's count, p22 on
    // the p18th counted hit (reputation.ts dialogHit). Not when the hit did nothing (invulnerable).
    const hit = info as { source?: unknown; amount?: number } | undefined;
    // Not while the body bleeds from a cut (0x100e74f2 -> 0x10040d10: the Part Cap component's bleed).
    if (hit?.source === 'player' && (hit.amount ?? 0) > 0 && !a.invulnerable && repHooks && !parts.bleeding(a)) {
      const pts = repHooks.hit(a);
      const ins = ctx.services.insanity as InsanityLike | undefined;
      if (pts && typeof ins?.addReputation === 'function') ins.addReputation(pts, a.uid ?? a.entity?.uid);
    }
  });

  const camDir = new THREE.Vector3();
  const director = new Director(entities, byUid, pkgs, manager, {
    send: (uid, msg, from) => worldSvc()?.send?.(uid, msg, from),
    player: () => view.player.position,
    visibleToPlayer: (p) => {
      const c = view.camera.position;
      view.camera.getWorldDirection(camDir);
      const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-3) return true;
      if ((dx * camDir.x + dy * camDir.y + dz * camDir.z) / d < Math.cos(((view.camera.fov * 0.5 + 10) * Math.PI) / 180) * 0.9) return false;
      return !env.world || clearLine(env.world, c.x, c.y, c.z, p.x, p.y, p.z);
    },
    get playerUid() {
      return worldSvc()?.world?.playerUid ?? env.playerUid;
    },
    damagePlayer: (amount) => combat.damage(amount),
    speak,
    isDestroyed: (uid) => !!worldSvc()?.isDestroyed?.(uid),
    log: (s) => console.debug(`[actors] ${s}`),
    sound: (keys, at) => {
      const ok = keys.filter((k) => audio.get(k));
      if (!ok.length) return 0;
      const k = ok[Math.floor(Math.random() * ok.length)];
      audio.play3D(k, [at.x, at.y, at.z], { bus: 'sfx' });
      return audio.get(k)?.duration || 1;
    },
    arcEffect: (ref, target) => (ctx.services.fx as { arcEffect?(r: ResRef, t: ArcTarget): ArcHandle | undefined } | undefined)?.arcEffect?.(ref, target),
    playerBody: () => body?.body,
  }, fx);
  repHooks = { hit: (a) => director.playerHit(a), kill: (a) => director.playerKill(a) };

  // Dismemberment (dismember.ts; docs/game-logic.md §15.16): the Characters' Part Caps (p16), the
  // parts placed bodies are created without (p17 when p18 = 0), cuts by blows, the bleed.
  const insanity = () => ctx.services.insanity as InsanityLike | undefined;
  const fxSvc = () => ctx.services.fx as { spawn?(r: ResRef, M: THREE.Matrix4, c?: object): void } | undefined;
  const parts = new Dismemberment({
    time: () => env.time,
    spawn: (r, M, o) => fxSvc()?.spawn?.(r, M, o),
    buildCap: (r) => {
      const m = buildHeldModel(packages, r);
      if (!m) return undefined;
      m.root.traverse((o) => (o.frustumCulled = false));
      m.root.userData.dispose = () => m.dispose();
      return m.root;
    },
    spheres: (a) => partSpheres(a as Actor),
    addReputation: (pts, uid) => insanity()?.addReputation?.(pts, uid),
    log: (msg) => console.debug(`[actors] ${(msg)}`),
  });
  const _sm = new THREE.Matrix4(), _sv = new THREE.Vector3();
  const partSpheres = (a: Actor) => {
    // The player's part actor (playerPart, below) is his body's Character, not an Actor.
    const ref = (a as Partial<Actor>).kind?.skinned.ref ?? (a.ch as { skinned?: { ref: ResRef } }).skinned?.ref;
    if (!ref) return [];
    const leaves = modelHitSpheres(packages, ref, sphereTrees);
    const out: { c: number[]; r: number; bone: number }[] = [];
    const { bones, boneInverses } = a.ch.skeleton;
    a.ch.root.updateWorldMatrix(true, true);
    for (const n of leaves) {
      const bone = bones[n.bone];
      if (!bone) continue;
      _sm.multiplyMatrices(bone.matrixWorld, boneInverses[n.bone]);
      _sv.set(n.center[0], n.center[1], n.center[2]).applyMatrix4(_sm);
      const e = _sm.elements;
      out.push({ c: [_sv.x, _sv.y, _sv.z], r: n.radius * Math.hypot(e[0], e[1], e[2]), bone: n.bone });
    }
    return out;
  };
  /** Character p112..p117 of the bodies that gib (gibs.ts). */
  const gibRules = new WeakMap<Actor, GibRule>();
  const setupParts = (a: Actor) => {
    const v = characterValues(pkgs, a);
    if (!v) return;
    const capsOf = (x: unknown) => refsOf(x).map((r) => readPartCapRef(pkgs, r)).filter((c): c is PartCapRule => !!c);
    const rules = capsOf(v[16]);
    const listed = capsOf(v[17]);
    const g = readGibRule(v);
    if (g) {
      gibRules.set(a, g);
      (a as PartActor).corpseBlows = true;
      (a as PartActor).cuttable = true;
    }
    if (!rules.length && !listed.length) return;
    const sk = a.kind.skinned;
    const mdu = packages.get(sk.ref.pkg)?.mdu;
    const tr = mdu ? readSkeletonTrailer(mdu, sk.ref.id) : undefined;
    const channels = tr?.channels.map((c) => c.bone) ?? [];
    parts.setup(a, rules, sk.skeleton.bones.map((b) => b.parent), channels, listed, tr ? segmentBonesOf(tr.channels) : [], v[18] === 0);
  };
  // Before the first setupParts: it records each actor's gib rule (gibs below).
  for (const a of manager.actors) if (!a.template) setupParts(a);
  manager.on('spawn', (a) => !a.template && setupParts(a));
  manager.on('death', (a) => parts.died(a));
  manager.partHit = (a, amount, from, by, hit) =>
    void parts.hit(a, { amount, type: hit?.type, point: hit?.point, bone: hit?.bone, from, byPlayer: by === undefined || by === 'player', attackerClass: by instanceof Object && 'kind' in by ? classOf(by as Actor) : undefined });
  manager.cuttable = (a) => parts.cuttable(a);
  manager.capLimb = (a) => void parts.capLimb(a);
  env.resurrected = (a) => void parts.regrow(a);
  // HitReactBehavior's knockdown (0x100ef7a8): bleeding out before the get-up clip ends, the body
  // dies on the floor (the rest of its health as the bleed: the player's kill when he cut it).
  env.bleedsOut = (a, len) => {
    if (!bleedsOutBeforeUp(a.health, parts.bleedRate(a), len)) return false;
    manager.damage(a, a.health + 1, undefined, parts.bleedByPlayer(a) ? 'player' : (a.uid ?? 0));
    return !a.alive;
  };

  // Corpse blows (gibs.ts; docs/game-logic.md §15.16 "Gibs"): an explosion throws a dead body
  // with p112 / p113, Gonzo and claw blows burst it into p117 at bone p116; either way the death
  // outputs that have not fired go, then p30, and the body is removed.
  const deathFired = new WeakSet<Actor>();
  manager.on('death', (a) => deathFired.add(a));
  const going = new Set<Actor>();
  const thrown: { a: Actor; until: number; burst: ResRef[]; bone: number }[] = [];
  const boneMatrix = (a: Actor, bone: number) => {
    const b = bone >= 0 ? a.ch.skeleton.bones[bone] : undefined;
    const o = b ?? a.ch.root;
    o.updateWorldMatrix(true, false);
    return o.matrixWorld.clone();
  };
  const goneOutputs = (a: Actor) => {
    if (!deathFired.has(a)) {
      deathFired.add(a);
      fireSlot(a, 28);
      if (a.entity?.family === 'Character') fireSlot(a, 29);
    }
    fireSlot(a, 30);
  };
  const gibBody = (a: Actor, gib: readonly ResRef[], bone: number) => {
    const M = boneMatrix(a, bone);
    for (const g of gib) fxSvc()?.spawn?.(g, M.clone());
    // Enhanced mode's gore (gore-bus.ts; never set in Original).
    gore.listener?.gib?.(M, a.ch.root);
    a.ch.root.visible = false;
    going.add(a);
  };
  manager.corpseHit = (a, _amount, from, by, hit) => {
    if (going.has(a) || thrown.some((t) => t.a === a)) return true;
    const r = gibRules.get(a);
    const at = from ?? (by instanceof Object && 'kind' in by ? (by as Actor).position : by === undefined || by === 'player' ? view.player.position : undefined);
    const kind = corpseBlowKind(r, hit?.type, !!at);
    if (!kind || !r) return false;
    if (kind === 'throw' && at) {
      const tb = readThrownBody(pkgs, r.body);
      const c = { x: a.position.x, y: a.bottom + a.height * 0.5, z: a.position.z };
      const v = throwDirection(c, at, r.elevation).multiplyScalar(tb?.speed || 12);
      a.throwCorpse(r.bodyClip ? manager.kinds.clipIndex(a.kind, r.bodyClip) : -1, v);
      thrown.push({ a, until: env.time + (tb?.life ?? 5), burst: tb?.burst.length ? tb.burst : [r.gib], bone: tb && tb.bone >= 0 ? tb.bone : r.bone });
      console.debug(`[actors] ${a.ch.root.name} #${(a.uid ?? 0).toString(16)} thrown by the blast at ${v.length().toFixed(1)} m/s`);
    } else {
      gibBody(a, [r.gib], r.bone);
      console.debug(`[actors] ${a.ch.root.name} #${(a.uid ?? 0).toString(16)} gibbed (${r.gib.pkg}:${r.gib.id} at bone ${r.bone})`);
    }
    goneOutputs(a);
    return true;
  };
  /** Thrown bodies burst at the end of their life; gibbed ones leave (outside the actors' update). */
  const updateGibs = () => {
    for (let i = thrown.length - 1; i >= 0; i--) {
      const t = thrown[i];
      if (env.time < t.until && t.a.ch.root.parent) continue;
      thrown.splice(i, 1);
      if (t.a.ch.root.parent) gibBody(t.a, t.burst, t.bone);
    }
    for (const a of going) manager.remove(a);
    going.clear();
  };
  const classOf = (a: Actor) => a.entity?.className ?? templateClass(pkgs, a.kind.template);

  // Torque's own Part Caps (Player p16 on the Player's +0x448 component; his damage 0x1002e036
  // runs the same blow test): a CartWheeler's blow on his head at 20 % health or less (2:625),
  // a Fester's type-11 blow on his waist (2:675). His death clip is the killer's (0x1002e3f0:
  // Mainliner p330, Slayer p332, Burrower p335, Inferna p337); the Slayer's 2:562 carries the
  // CapLimb events that take his arms and head (2:766 / 2:765 / 2:770, beyond any blow's p6).
  const playerPart: PartActor | undefined = body
    ? {
        get ch() {
          return body.body as unknown as PartActor['ch'];
        },
        get alive() {
          return combat.alive;
        },
        get health() {
          return combat.health;
        },
        set health(_v: number) {},
        get maxHealth() {
          return combat.maxHealth;
        },
        set maxHealth(_v: number) {},
        uid: playerEnt?.uid,
        get position() {
          return view.player.position;
        },
      }
    : undefined;
  const setupPlayerParts = () => {
    if (!body || !playerPart) return;
    const v = playerEnt?.values ?? characterValues(pkgs, { kind: { template: { pkg: 2, id: 5 } } }) ?? [];
    const rules = refsOf(v[16]).map((r) => readPartCapRef(pkgs, r)).filter((c): c is PartCapRule => !!c);
    if (!rules.length) return;
    const sk = body.body.skinned;
    const tr = packages.get(sk.ref.pkg)?.mdu ? readSkeletonTrailer(packages.get(sk.ref.pkg)!.mdu!, sk.ref.id) : undefined;
    parts.setup(playerPart, rules, sk.skeleton.bones.map((b) => b.parent), tr?.channels.map((c) => c.bone) ?? [], [], tr ? segmentBonesOf(tr.channels) : []);
  };
  setupPlayerParts();
  const PLAYER_DEATH_CLIPS: [string, number][] = [['Mainliner', 330], ['Slayer', 332], ['Burrower', 335], ['Inferna', 337]];
  /** The killer's death clip and its CapLimb events (bone index, clip time). */
  const playerDeathClip = (killer: Actor | undefined): ResRef | undefined => {
    const cls = killer && classOf(killer);
    const k = PLAYER_DEATH_CLIPS.find(([c]) => c === cls)?.[1];
    const v = k === undefined ? undefined : playerEnt?.values[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : undefined;
  };
  const capLimbEvents = (clip: ResRef) => {
    const adu = packages.get(clip.pkg)?.adu;
    const ev = adu ? readAnimEvents(adu, clip.id) : undefined;
    const byHash = body?.body.skinned.skeleton.byHash;
    return (ev?.events ?? [])
      .filter((e) => e.kind === ANIM_EVENT_MESSAGE && e.param === CAP_LIMB)
      .map((e) => ({ time: e.time, bone: byHash?.get(e.boneHash) ?? -1 }))
      .filter((e) => e.bone >= 0);
  };
  function playerBlow(amount: number, from: Actor, hit?: { point?: THREE.Vector3Like; type?: number }) {
    const was = combat.alive;
    const human = !(insanity() as { transformed?: boolean } | undefined)?.transformed;
    const clip = was ? playerDeathClip(from) : undefined;
    if (clip) combat.deathClip = clip;
    combat.damage(amount, from);
    combat.deathClip = undefined;
    if (!playerPart || !human) return;
    if (amount > 0 && hit?.point) parts.hit(playerPart, { amount, type: hit.type, point: hit.point, from: from.position, byPlayer: false, attackerClass: classOf(from) });
    if (was && !combat.alive && clip && combat.deathClipLength > 0) parts.schedule(playerPart, capLimbEvents(clip));
  }
  let playerDown = false;
  /** A revived player (checkpoint) is whole again. */
  const checkPlayerParts = () => {
    if (!playerPart) return;
    if (!combat.alive) playerDown = true;
    else if (playerDown) {
      playerDown = false;
      parts.forget(playerPart);
      setupPlayerParts();
    }
  };

  // Ambient Creatures take damage as PhysicalObjects [verified: vtable 0x101544b0: damage vt +0x58
  // 0x1009b490, death vt +0x90 0x100916f0 -> 0x1009ba20]: health p0 (1), invulnerable p3 / the
  // 90 / 91 messages; every blow above 0 fires p15; killed, the player's kill pays p26
  // (reputation.ts killReputation), then it breaks as a Breakable does (0x1009b6d0: the p18
  // generator at its placement, thrown away from the attacker with p19), fires p21 and is
  // destroyed. No meter gain (not a Character: 0x10033890 is not called).
  manager.ambientHit = (a, amount, from, by) => {
    if (!a.alive || !a.entity) return false;
    const c = { health: a.health, invulnerable: a.invulnerable, shown: a.ch.root.visible };
    const blow = ambientBlow(c, amount);
    a.health = c.health;
    if (blow === 'none') return false;
    fireSlot(a, 15);
    if (blow === 'hurt') return false;
    const v = a.entity.values;
    const byPlayer = by === undefined || by === 'player';
    const pts = byPlayer ? killReputation(a.entity.className, v) : 0;
    if (pts) insanity()?.addReputation?.(pts, a.uid ?? a.entity.uid);
    const gen = refsOf(v[18])[0];
    if (gen) {
      a.ch.root.updateWorldMatrix(true, false);
      const p = a.ch.root.getWorldPosition(new THREE.Vector3());
      const dir = from && v[19] ? new THREE.Vector3(p.x - from.x, 0, p.z - from.z) : undefined;
      fxSvc()?.spawn?.(gen, a.ch.root.matrixWorld.clone(), dir && dir.lengthSq() > 1e-6 ? { dir: dir.normalize() } : {});
    }
    fireSlot(a, 21);
    console.debug(`[actors] ${a.ch.root.name} killed${byPlayer ? ' by the player' : ''}${pts ? ` (reputation ${pts})` : ''}`);
    if (a.uid !== undefined) director.ambientGone(a.uid);
    manager.remove(a);
    return true;
  };

  const actorsService: ActorsService = {
    refreshVisibility: (camera) => manager.refreshVisibility(camera),
    noise: (at, sound, source = 'player') => {
      if (!sound) return;
      const spec = 'radius' in sound ? sound : manager.behaviors.noise(sound);
      manager.noise(at, spec, source);
    },
    list: () => manager.actors.filter((a) => !a.template),
    get: (uid) => manager.get(uid),
    spawn: (template, feet, yaw = 0) => manager.spawn(template, feet, yaw),
    damage: (a, amount, from, by, hit) => manager.damage(a, amount, from, by, hit),
    receive: (uid, message) => manager.receive(uid, message, env),
    setVisible: (uid, visible) => {
      const a = manager.get(uid);
      if (!a || a.template) return false;
      a.ch.root.visible = visible;
      if (visible) a.reveal();
      return true;
    },
    isVisible: (uid) => {
      const a = manager.get(uid);
      return !!a && !a.hidden;
    },
    wake: (uid) => {
      const a = manager.get(uid);
      if (!a) return false;
      a.wake();
      return true;
    },
    setBehavior: (uid, bUid) => {
      const a = manager.get(uid);
      const b = manager.behaviors.fromPlaced(bUid);
      if (!a || !b) return false;
      a.setBehavior(b, env);
      return true;
    },
    raycast: (o, d, max, includeDead) => manager.raycast(o, d, max, includeDead),
    hitSpheres: (a) => (env.hitSpheres?.(a) ?? []).map((h) => ({ c: [h.c[0], h.c[1], h.c[2]] as [number, number, number], r: h.r })),
    playerBody: body,
    on: (ev, fn) => manager.on(ev, fn),
  };
  const combatService: CombatService = {
    get player() {
      return { health: combat.health, maxHealth: combat.maxHealth, alive: combat.alive };
    },
    damagePlayer: (amount) => combat.damage(amount),
    healPlayer: (amount) => combat.heal(amount),
    attack: (kind) => combat.attack(kind),
  };
  ctx.services.actors = actorsService;
  ctx.services.combat = combatService;

  // Save state (src/game/save), all per level except the player's health:
  //   'actors.logic'  (9)  Behavior Changer uses, EdgeToggler switches (director.ts)
  //   'actors'        (10) every actor via Actor.getState / setState; re-creates the living
  //                        Object Cloner copies and spawned creatures (save/providers.ts)
  //   'spawners'      (12) Object Cloner counters, timers and the copies each one counts
  //                        (after 'actors' so the copies exist again)
  const unregisterSave = [
    registerSave(ctx.services, 'actors.logic', { save: () => director.snapshot(), load: (s: DirectorSave) => director.restore(s ?? {}) }, { scope: 'level', priority: 9 }),
    registerSave(ctx.services, 'actors', actorsSaveProvider(manager, () => manager.env), { scope: 'level', priority: 10 }),
    // The special moves' own state (a CartWheeler on the ceiling), after the actors provider
    // re-created and placed the actors.
    registerSave(ctx.services, 'actors.specials', { save: () => specials.save(), load: (s: SpecialsSaveState) => specials.load(s ?? []) }, { scope: 'level', priority: 11 }),
    // Cut parts (dismember.ts), after the actors provider re-created the bodies.
    registerSave(ctx.services, 'actors.parts', { save: () => parts.save(), load: (s: PartsSave) => parts.load(s, (uid) => manager.get(uid)) }, { scope: 'level', priority: 11 }),
    registerSave(
      ctx.services,
      'spawners',
      { save: () => director.spawnerState(), load: (s: SpawnerSave) => director.setSpawnerState(s ?? {}), reset: () => director.resetSpawners() },
      { scope: 'level', priority: 12 },
    ),
    registerSave(ctx.services, 'combat', combatSaveProvider(combat), { scope: 'game', priority: 10 }),
  ];
  // Debug/test hook, like window.__view.
  Object.assign(window, {
    __actors: { manager, director, parts, gibs: { thrown, going, rule: (a: Actor) => gibRules.get(a) }, playerPart, combat, body, env, fx, speakLog, services: { actors: actorsService, combat: combatService }, companions: { pending: pendingCarry, arrived, spawnName: ctx.spawnName, levelPath: ctx.levelPath } },
  });

  const kinds = manager.kinds.all();
  console.info(
    `[actors] ${manager.actors.length} actors (${kinds.length} kinds, ${manager.templates.size} cloner templates, ${manager.nav?.size ?? 0} nav nodes) in ${(performance.now() - t0).toFixed(0)} ms` +
      (body ? '' : ' - player body unavailable'),
  );

  // Hook into the level-logic system once it is up (it may start after us).
  let worldHooked = false;
  let unhookStomp: (() => void) | undefined;
  let unhookMsg: (() => void) | undefined;
  const hookWorld = () => {
    const w = worldSvc();
    if (worldHooked || !w) return;
    worldHooked = true;
    if (w.world?.playerUid) env.playerUid = w.world.playerUid;
    if (typeof w.seeThrough === 'function') manager.seeThrough = (hit) => w.seeThrough!(hit);
    // Draw occlusion looks at the drawn triangles (docs/game-logic.md §14.10).
    if (typeof w.shotThrough === 'function') manager.shotThrough = (hit) => w.shotThrough!(hit);
    if (typeof w.eyeThrough === 'function' && view.drawn !== view.collision) manager.occlusion = { world: () => view.drawn, seeThrough: (hit) => w.eyeThrough!(hit) };
    // NPC sight and shots pass what the eye passes (bars, grates, chain-link, glass).
    env.seeThrough = manager.seeThrough;
    // Companions carried here: their Companion Spawn Point passes its p0 message on [inferred].
    for (const c of arrived) {
      const m = c.point?.values[0];
      if (c.point && typeof m === 'number' && m) for (const u of c.point.links) w.send?.(u, m, c.point.uid);
    }
    // Visibility the world applied before we were listening.
    if (typeof w.isVisible === 'function') for (const a of manager.actors) if (a.entity && !a.spawned && !w.isVisible(a.entity.uid)) a.ch.root.visible = false;
    unhookMsg = w.subscribe?.('*', (msg, from, to) => {
      // A Level Transition carrying objects (p7) fires: keep their state for the next level.
      const lt = byUid.get(to);
      if (lt?.className === 'Level Transition' && msg === (Number(lt.values[10]) || 1)) recordCarry(ctx.levelPath, lt, manager);
      specials.message(to, msg, from);
      director.message(msg, from, to, env);
      // Clones are not level objects: the world doesn't forward their messages.
      const a = manager.get(to);
      if (a?.spawned) manager.receive(to, msg, env);
    });
    unhookStomp = w.onStompTransform?.((uid, key) => {
      const a = manager.get(uid);
      if (!a) return;
      if (!key) a.setScriptPose(null);
      else {
        const [x, y, z] = key.position;
        // Undecoded transform blocks come through as the origin (e.g. 10 Docks "Bart").
        if (x === 0 && y === 0 && z === 0) return;
        a.setScriptPose({ x: x / 2048, y: y / 2048, z: z / 2048 }, new THREE.Quaternion(...key.quat));
      }
    });
    const nav = manager.nav;
    for (const p of w.passages ?? []) {
      const a = nav?.byUid.get(p.nodeA), b = nav?.byUid.get(p.nodeB);
      if (a !== undefined && b !== undefined && p.door) doorOf.set(edgeKey(a, b), p.door), passageFrom.set(edgeKey(a, b), a);
    }
  };

  return {
    name: 'actors',
    update(dt: number) {
      hookWorld();
      const w = worldSvc();
      env.time += dt;
      clock += dt;
      env.world = view.collision ?? env.world;
      // Nobody attacks during cutscenes or while flying (noclip).
      env.playerAlive = combat.alive && view.walking && !w?.inCutscene;
      // Port option "Enemies ignore the player" (menu Gameplay page; src/game/port-options.ts).
      env.ignorePlayer = portOptions.ignorePlayer;
      hud.setVisible(view.walking);
      if (env.world) {
        director.update(dt, env);
        specials.update(dt);
        // The bleed of cut bodies (0x10118680): the player's when a cut was his.
        parts.update(dt, (a, amount, byPlayer) => {
          if (a === playerPart) combat.damage(amount);
          else manager.damage(a as Actor, amount, undefined, byPlayer ? 'player' : ((a as Actor).uid ?? 0));
        });
        updateGibs();
        checkPlayerParts();
        manager.drawDistance = view.culler?.fogDistance ?? Infinity;
        manager.update(dt, env, view.camera);
      }
      if (view.walking && combat.alive) manager.pushPlayer(view.player.motor, !!view.player.motionOverride);
      body?.tick(dt);
      combat.update(dt);
      fx.update(dt);
      subs.update(clock);
    },
    dispose() {
      for (const off of unregisterSave) off();
      unhookStomp?.();
      unhookMsg?.();
      offDraw();
      combat.dispose();
      hud.dispose();
      fx.dispose();
      subs.dispose();
      specials.dispose();
      parts.dispose();
      manager.dispose();
      body?.dispose();
      if (ctx.services.actors === actorsService) delete ctx.services.actors;
      if (ctx.services.combat === combatService) delete ctx.services.combat;
      delete (window as unknown as { __actors?: unknown }).__actors;
    },
  };
}
