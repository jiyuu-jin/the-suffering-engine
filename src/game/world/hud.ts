// World HUD calls (messages, help popups, the interaction prompt, banner). The
// HUD system (src/game/hud/system.ts) draws them with the game's widgets; this
// adapter keeps the world system's calls and forwards them to the HUD bus.
//   toast  -> pickup text (5:460), checkpoint notice (5:426) or message list (5:172)
//   help   -> Help Popup text (5:411), <Action> placeholders expanded with key bindings
//   prompt -> interaction prompt under the crosshair ("<b>E</b> Open" or "<Use> Open")
//   status -> ignored (inventory/health readout of the placeholder HUD; the meters show it)

import { hudBus, postHudMessage, routeToast } from '../hud/bus';

export interface WorldHud {
  toast(text: string, ms?: number): void;
  help(text: string | null): void;
  prompt(text: string | null): void;
  banner(text: string | null): void;
  status(html: string): void;
  /** Pickup notification (item name), shown in the pickup text widget. */
  pickup(text: string): void;
  dispose(): void;
}

export function createWorldHud(_container?: HTMLElement): WorldHud {
  return {
    toast: (text, ms) => routeToast(text, ms),
    help(text) {
      hudBus.help = text ? { text, at: hudBus.clock } : null;
    },
    prompt(text) {
      hudBus.prompt = text || null;
    },
    banner(text) {
      hudBus.banner = text || null;
    },
    status() {},
    pickup: (text) => postHudMessage('pickup', text),
    dispose() {
      hudBus.help = null;
      hudBus.prompt = null;
      hudBus.banner = null;
    },
  };
}
