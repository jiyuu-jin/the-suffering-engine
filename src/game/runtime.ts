// Game systems plug into the app here instead of editing main.ts.
//
// A GameSystem is created once per loaded level (after geometry, collision and
// audio are ready) and disposed when the level unloads. Systems communicate
// through the shared GameContext; register them in src/game/systems.ts.

import type { GameFS } from '../app/gamefs';
import type { LoadedLevel } from '../app/loader';
import type { LevelRenderer } from '../app/renderer';
import type { AudioSystem } from '../app/audio';

export interface GameContext {
  fs: GameFS;
  view: LevelRenderer;
  audio: AudioSystem;
  loaded: LoadedLevel;
  /** Path of the .lvl currently loaded. */
  levelPath: string;
  /** Ask the app to load another level (e.g. from a Level Transition). */
  requestLevel(path: string, options?: { spawnName?: string }): void;
  /** Spawn name requested by the previous level's transition, if any. */
  spawnName?: string;
  /** How the level was entered: New Game / direct start, a Level Transition, or a loaded save. */
  startKind?: 'new' | 'transition' | 'load';
  /** For a loaded save: the spawn name the save's level was entered with (undefined = a direct start). */
  savedSpawnName?: string;
  /** Typed bag for cross-system services (e.g. ctx.services.world). */
  services: Record<string, unknown>;
}

export interface GameSystem {
  readonly name: string;
  /** Called every frame while the level is active (dt in seconds). */
  update?(dt: number): void;
  dispose?(): void;
}

export type GameSystemFactory = (ctx: GameContext) => GameSystem | Promise<GameSystem>;

/** Create systems in registration order; failures are logged and skipped. */
export async function startSystems(ctx: GameContext, factories: GameSystemFactory[]): Promise<GameSystem[]> {
  const systems: GameSystem[] = [];
  for (const make of factories) {
    try {
      systems.push(await make(ctx));
    } catch (err) {
      console.error('[game] system failed to start:', err);
    }
  }
  return systems;
}
