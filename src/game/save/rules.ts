// The original game's rules for when the player may save and when an Autosave object takes a
// checkpoint (docs/re/saves.md). Pure functions: the save system (system.ts) fills the state.
//
// Pause menu "Save Game" (RFL 0x10065d0c..0x10065dbe): the item is disabled when the player's
// can-save predicate (0x100438a0) is false. It is false while the player
//   * is dead (0x100a1ad0),
//   * has state bit 0 set (+0xa4 bit 0, no named state) [meaning unknown],
//   * is under script control (+0x9c bit 1: set when a cinematic takes the player, 0x10042650,
//     cleared at 0x100426d0),
//   * is in one of the states Interact (22), LadderClimb (27), Item Pickup (26), View Monitor (23),
//     Document View (31), Morph (19), Freak Out (34), Jump (8), Fall (9), Jump Melee Attack (14).
// Nothing else is checked: no enemy-proximity rule, and being transformed (state 20) is allowed.
//
// Autosave inSave (0x100970a0): with a live Player whose recent-damage value (+0x448) is spent
// (0x100415a0) and whose health is at least 5, the Gameplay "Checkpoints" option (or the
// object's own p1 when non-zero) decides: 0 Off = nothing, 1 Prompt = a Yes/No box (UIP p61),
// 2 On = the checkpoint notice (UIP p28) and the save. The checkpoint is kept in memory only
// (EXE 0x42edb0); dying with checkpoints not Off and a checkpoint present posts the same
// "revert to checkpoint" event as the pause menu (0x1002d780).

/** Minimum health for an Autosave checkpoint (0x1009712a). */
export const CHECKPOINT_MIN_HEALTH = 5;

export interface PlayerSaveState {
  alive: boolean;
  /** A cinematic / STOMP sequence controls the player (+0x9c bit 1). */
  controlled: boolean;
  /** Jump / Fall / Jump Melee Attack: the player is off the ground. */
  airborne: boolean;
  /** Morph (either direction); being transformed is allowed. */
  morphing: boolean;
  /** LadderClimb, or another scripted locomotion (Interact). */
  climbing: boolean;
  /** Interact, Item Pickup, View Monitor, Document View, Freak Out. */
  busy?: boolean;
}

/** Why the pause menu's Save Game is disabled, or null when saving is allowed. */
export function originalSaveVeto(s: PlayerSaveState): string | null {
  if (!s.alive) return 'dead';
  if (s.controlled) return 'cinematic';
  if (s.morphing) return 'morphing';
  if (s.airborne) return 'airborne';
  if (s.climbing) return 'climbing';
  if (s.busy) return 'busy';
  return null;
}

export const CheckpointMode = { Off: 0, Prompt: 1, On: 2 } as const;

/**
 * What an Autosave inSave does: 'skip' (no checkpoint), 'prompt' or 'save'.
 * `objectMode` is the Autosave instance's p1 (0 = use the option).
 */
export function autosaveAction(opts: {
  alive: boolean;
  health: number;
  /** True while the player took damage recently (the original's +0x448 value not spent). */
  recentlyHurt?: boolean;
  option: number;
  objectMode?: number;
}): 'skip' | 'prompt' | 'save' {
  if (!opts.alive || opts.recentlyHurt) return 'skip';
  if (!(opts.health >= CHECKPOINT_MIN_HEALTH)) return 'skip';
  const mode = opts.objectMode ? opts.objectMode : opts.option;
  return mode === CheckpointMode.On ? 'save' : mode === CheckpointMode.Prompt ? 'prompt' : 'skip';
}
