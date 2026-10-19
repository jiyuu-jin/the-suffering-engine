// Levels system: classes and special cases that only appear outside chapter 1
// (docs/levels.md). Runs after the world system and the sequence presenter, and adds
// class handlers to the World through `world.handlers` instead of editing logic.ts.
//
//   * carrier-camera.ts  cinematic camera attached to a carrier hardpoint (Prelude Docks boat)
//   * water.ts           Water Volume: the player's water component (depth, splashes, wading, drowning)
//   * rain.ts            Volumetric Rain: rain streak volumes (static / camera-following)
//   * atmosphere.ts      the level's initial Sky Properties (fog colour / distance)
//   * logic.ts           Health Threshold Trigger, Inventory Add Remove, Attachment, Teleport Pad
//   * skinned-props.ts   skinned scenery no other system draws (hanging lamps, cranes, ...)
//   * sky.ts             sky dome colours from the level's Sky Properties
//
// Services: ctx.services.water (WaterService, when the level has water), ctx.services.skinnedProps
// (SkinnedProps: the sequence presenter plays STOMP animation keys on cranes through it).
//
// Debug: window.__levels.

import type { GameContext, GameSystem } from '../runtime';
import type { InventoryService, WorldService } from '../world/world';
import type { PackageSet, ResRef } from '../../formats/model';
import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { CarrierCamera } from './carrier-camera';
import { buildWaterWorld, groupedWaterUids, MovingWater, readPlayerWaterRules, waterMaterialType, waterSurfaceParts, WaterRuntime, type WaterEnv } from './water';
import { CollisionWorld } from '../../app/physics';
import { readTemplate } from '../world/fx';
import type { FxService } from '../fx/system';
import { Rain } from './rain';
import { applyLevelAtmosphere } from './atmosphere';
import { LevelLogic } from './logic';
import { SkinnedProps, type CranesSave } from './skinned-props';
import { registerSave } from '../save/providers';
import { SkyDome } from './sky';

interface CombatLike {
  readonly player: { alive?: boolean; health: number; maxHealth?: number };
  damagePlayer(amount: number, source?: unknown): void;
}
interface ActorsLike {
  get(uid: number): { ch: { root: import('three/webgpu').Object3D }; health?: number } | undefined;
}

export async function createLevelsSystem(ctx: GameContext): Promise<GameSystem> {
  const ws = ctx.services.world as WorldService | undefined;
  const packages = ctx.loaded.packages as PackageSet | undefined;
  if (!ws || !packages) return { name: 'levels (no world)' };
  const world = ws.world;
  const { view } = ctx;
  const combat = () => ctx.services.combat as CombatLike | undefined;
  const actors = () => ctx.services.actors as ActorsLike | undefined;

  const atmosphere = applyLevelAtmosphere(world, packages as EntityPackageSet, view, ctx.levelPath);

  const carrierCam = new CarrierCamera(world, packages, view, actors);

  // Grouped Water Volumes (dynamic objects) follow their Object Grouper's leader: their surfaces
  // are bodies of the water world that move with them (water.ts MovingWater).
  const groupedWater = ws.dynamicParts ? groupedWaterUids(world).filter((u) => !!ws.dynamicParts!(u)) : [];
  const waterParts = waterSurfaceParts(world, packages, new Set(groupedWater));
  const surfaces = buildWaterWorld(world, packages, waterParts) ?? (groupedWater.length ? new CollisionWorld({ parts: [] }) : undefined);
  const movingWater = surfaces && groupedWater.length ? new MovingWater(surfaces, (u) => ws.dynamicParts?.(u), groupedWater) : undefined;
  const waterType = surfaces ? waterMaterialType(world, packages) : undefined;
  // The player's entry for water in its Material Effects list (Player p145).
  let waterEntry: readonly PropValue[] | null | undefined;
  const playerValues = world.of('Player')[0]?.e.values;
  let running = false, speed = 0;
  const offFrame = surfaces
    ? view.player.onUpdate((f) => {
        running = f.running;
        speed = f.speed;
      })
    : undefined;
  const waterEnv: WaterEnv = {
    entry: () => {
      if (waterEntry === undefined) {
        waterEntry = null;
        const list = playerValues?.[145];
        for (const r of (Array.isArray(list) ? list : [list]) as unknown[]) {
          const t = r && typeof r === 'object' && 'pkg' in r ? readTemplate(packages as EntityPackageSet, r as ResRef) : undefined;
          const p0 = t?.values[0] as ResRef | null | undefined;
          if (p0 && typeof p0 === 'object' && `${p0.pkg}:${p0.id}` === waterType) waterEntry = t!.values;
        }
      }
      return waterEntry ?? undefined;
    },
    // The entry splash's scale is 1 for the Player (p24 = 1): spawned as placed.
    spawn: (ref, at) => (ctx.services.fx as FxService | undefined)?.spawnAt(ref, at),
    alive: () => combat()?.player.alive !== false,
    running: () => running,
    speed: () => speed,
    drown: () => {
      const c = combat();
      if (!c || c.player.alive === false) return;
      (ctx.services.actors as { playerBody?: { drowning?(): void } } | undefined)?.playerBody?.drowning?.();
      c.damagePlayer(c.player.maxHealth ?? 100, { kind: 'drown', at: view.player.position.clone() });
    },
  };
  const water = surfaces
    ? new WaterRuntime(surfaces, view.player, () => view.walking && view.player.enabled && !ws.inCutscene, readPlayerWaterRules(playerValues, packages), waterEnv, waterType)
    : undefined;
  if (water) ctx.services.water = water;

  const rain = new Rain(world, packages, () => view.collision);
  if (rain.count) view.scene.add(rain.group);

  const logic = new LevelLogic(world, packages as EntityPackageSet, () => ctx.services.inventory as InventoryService | undefined, {
    health: (uid) => {
      if (uid === world.playerUid) return combat()?.player.health;
      const h = actors()?.get(uid)?.health;
      return typeof h === 'number' ? h : undefined;
    },
  });

  const skinnedProps = new SkinnedProps(world, packages, ctx.levelPath, (fn) => ws.onStompTransform(fn), (keys, at, loop) => {
    const ok = keys.filter((k) => ctx.audio.get(k));
    if (!ok.length) return undefined;
    const h = ctx.audio.play3D(ok[Math.floor(Math.random() * ok.length)], at, { bus: 'sfx', loop });
    return { stop: () => h.stop(0.15) };
  }, () => view.collision);
  if (skinnedProps.count) view.scene.add(skinnedProps.group);
  // The cranes' hoists and slews (Crane save +0x28 / +0x2c, the Mountable's yaw +0xce).
  const unregisterCranes = skinnedProps.cranes.size
    ? registerSave<CranesSave>(ctx.services, 'cranes', { save: () => skinnedProps.save(), load: (d) => skinnedProps.load(d) }, { scope: 'level', priority: 5 })
    : undefined;
  // Hook for the sequence presenter: STOMP animation keys on this scenery (cranes).
  ctx.services.skinnedProps = skinnedProps;
  // Cranes: Detectors with filter 5 test their hooks; a Mountable whose p30 names one drives it.
  if (skinnedProps.cranes.size) {
    world.hooks.cranes = () => skinnedProps.craneHooks();
    if (ws.interact)
      ws.interact.craneControl = {
        drive: (mountable, crane, hoist, slew, dt) =>
          skinnedProps.driveCrane(mountable, crane, hoist, slew, dt, (at) => {
            const hit = view.collision?.raycast(at.x, at.y, at.z, 0, -1, 0, 40);
            return hit ? hit.distance : undefined;
          }),
      };
  }

  const sky = new SkyDome(world, packages as EntityPackageSet, view.scene, ws);

  const debug = { carrierCam, water, rain, logic, atmosphere, skinnedProps, sky };
  Object.assign(window, { __levels: debug });
  console.info(
    `[levels] water ${surfaces ? world.of('Water Volume').length : 0}, rain ${rain.count}, skinned props ${skinnedProps.count}, sky dome ${sky.meshes.length}, atmosphere ${atmosphere ? `${atmosphere.template} fog ${atmosphere.fogDistance} m` : 'default'}`,
  );

  return {
    name: 'levels',
    update(dt) {
      carrierCam.update();
      movingWater?.update();
      water?.update(dt);
      rain.update(dt, view.camera);
      logic.update();
      skinnedProps.update(dt);
      sky.update(dt);
    },
    dispose() {
      water?.dispose();
      offFrame?.();
      rain.dispose();
      if (ctx.services.skinnedProps === skinnedProps) delete ctx.services.skinnedProps;
      unregisterCranes?.();
      skinnedProps.dispose();
      sky.dispose();
      if (ctx.services.water === water) delete ctx.services.water;
      if ((window as { __levels?: unknown }).__levels === debug) delete (window as { __levels?: unknown }).__levels;
    },
  };
}
