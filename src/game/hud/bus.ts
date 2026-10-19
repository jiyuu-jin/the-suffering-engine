// Event/state hub between the systems that report HUD events and the HUD
// system that draws them. The legacy HUD factories (createCombatHud in
// src/game/actors/hud.ts, createWorldHud in src/game/world/hud.ts) keep their
// public calls and write here; src/game/hud/system.ts reads it every frame.
// Module-level so a level reload (new systems) keeps nothing stale: every
// level-scoped field is reset by `resetHudBus()` when the HUD system starts.

export type MessageKind = 'pickup' | 'message' | 'checkpoint';

export interface HudMessage {
  id: number;
  kind: MessageKind;
  text: string;
  /** Bus clock (seconds) when posted. */
  at: number;
  /** Seconds visible (before the fade-out), undefined = the widget's own duration. */
  hold?: number;
}

export interface HudBusState {
  /** Seconds of (unpaused) game time; advanced by the HUD system. */
  clock: number;
  messages: HudMessage[];
  help: { text: string; at: number } | null;
  /** Interaction prompt, as built by the world system ("<b>E</b> Open"). */
  prompt: string | null;
  banner: string | null;
  /** Health pushed by the combat system (services.combat is preferred when present). */
  health: { value: number; max: number } | null;
  /** Clock of the last damage taken / last hit landed (kill = red marker). */
  damageAt: number;
  hitAt: number;
  hitKill: boolean;
  dead: boolean;
  /** Free-form weapon label from the placeholder combat code (shown only without services.weapons). */
  weaponLabel: string;
  /** Set by actors/system.ts each frame: false while flying (noclip). */
  combatVisible: boolean;
  /**
   * Dialogue played outside sequences (phone calls): the sound key; the HUD shows its subtitle.
   * A new object per line (the HUD compares identity).
   */
  speech: { sound: string } | null;
}

let nextId = 1;

export const hudBus: HudBusState = {
  clock: 0,
  messages: [],
  help: null,
  prompt: null,
  banner: null,
  health: null,
  damageAt: -1e9,
  hitAt: -1e9,
  hitKill: false,
  dead: false,
  weaponLabel: '',
  combatVisible: true,
  speech: null,
};

export function resetHudBus(): void {
  hudBus.messages = [];
  hudBus.help = null;
  hudBus.prompt = null;
  hudBus.banner = null;
  hudBus.damageAt = hudBus.hitAt = -1e9;
  hudBus.dead = false;
  hudBus.speech = null;
}

export function postHudMessage(kind: MessageKind, text: string, hold?: number): void {
  const t = text.trim();
  if (!t) return;
  hudBus.messages.push({ id: nextId++, kind, text: t, at: hudBus.clock, hold });
  if (hudBus.messages.length > 24) hudBus.messages.splice(0, hudBus.messages.length - 24);
}

/**
 * Routes a world "toast" to the matching game widget: pickups to the pickup text
 * (Player 5:460), checkpoints to the checkpoint notice (UIP 28), the rest to the
 * game message list (UIP 26).
 */
export function routeToast(text: string, ms?: number): void {
  const hold = ms !== undefined ? ms / 1000 : undefined;
  if (/^checkpoint/i.test(text)) postHudMessage('checkpoint', text, hold);
  else if (/^picked up /i.test(text) || /\(\+\d+ health\)$/i.test(text)) postHudMessage('pickup', text.replace(/^picked up /i, ''), hold);
  else postHudMessage('message', text, hold);
}
