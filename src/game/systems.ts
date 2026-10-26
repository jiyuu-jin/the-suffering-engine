// Ordered list of game systems started for every real level.
import type { GameSystemFactory } from './runtime';
import { createSaveSystem } from './save/system';
import { createActorsSystem } from './actors/system';
import { createWorldSystem } from './world/world';
import { createSequenceSystem } from './sequence/system';
import { createVisibilitySystem } from './visibility/system';
import { createMusicSystem } from './world/music';
import { createLipSyncSystem } from './actors/lipsync';
import { createHudSystem } from './hud/system';
import { createInsanitySystem } from './insanity/system';
import { createWeaponsSystem } from './weapons/system';
import { createFxSystem } from './fx/system';
import { createGasSystem } from './fx/gas-system';
import { createCampaignSystem } from './campaign/system';
import { createLevelsSystem } from './levels/system';
import { createReputationSkinSystem } from './actors/reputation-skin-system';
import { createCheatsSystem } from './cheats/system';

export const systemFactories: GameSystemFactory[] = [
  // First: publishes ctx.services.save so the systems below can register save providers.
  createSaveSystem,
  // Campaign flow (src/game/campaign): services.difficulty / services.campaign before the
  // actors are placed; hooks the world on its first update, before the world's own update
  // (transition mailbox delivery, chapters, GUI Launchers).
  createCampaignSystem,
  createActorsSystem,
  createWorldSystem,
  // Portal culling driven by doors / level logic (needs services.world).
  createVisibilitySystem,
  // After the world system: presents the STOMP sequences it runs.
  createSequenceSystem,
  // Classes / special cases outside chapter 1 (src/game/levels, docs/levels.md): water,
  // weather, carrier cameras. After the presenter: it may replace this frame's camera pose.
  createLevelsSystem,
  // Effects & audio ambience (services.fx: camera shake, impacts, decals, fire, footsteps,
  // ambient zones, reverb). After the world (extends its FX runtime); before weapons, which
  // look services.fx up lazily anyway.
  createFxSystem,
  // Damage volumes of Particle Fountains (the 1a gas chamber's gas, fx/gas.ts): after the world
  // and the actors (services.world / actors / combat).
  createGasSystem,
  // After the sequence presenter: hardpoint attachments follow the poses animated above;
  // player weapons, inventory, projectiles (services.weapons).
  createWeaponsSystem,
  // Level music (Combat Music objects), started by level-logic messages.
  createMusicSystem,
  // Last: jaw offsets go on top of the poses the systems above animated this frame.
  createLipSyncSystem,
  // Insanity meter, creature form, screen effects (after world/actors: hooks their services).
  createInsanitySystem,
  // Torque's / his weapons' skins by reputation and blood level (actors/reputation-skin*.ts):
  // after the systems that create the meshes it retextures (player body, puppet, held weapons).
  createReputationSkinSystem,
  // The original's cheats (src/game/cheats): typed key sequences and the pause menu's port page.
  createCheatsSystem,
  createHudSystem,
];
