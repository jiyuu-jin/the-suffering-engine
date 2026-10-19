// Control placeholders in game text (e.g. "... <Use> ...") expanded with
// the player's key bindings. The bindings live in ./bindings.ts (the keyboard page's 40
// actions + Crouch, rebindable and persisted); labelMap() turns them into placeholder labels
// (key names, or the connected pad's button names while a pad is in use) and the HUD system
// publishes those as `services.input.bindings` (Record<placeholder, label>).
// DEFAULT_BINDINGS only covers placeholders no action maps to. Other systems may still add
// entries to `services.input.bindings` or `window.__bindings`; the live bindings win.

import { expandControls } from '../../formats/strings';
import { input } from './bindings';

export const DEFAULT_BINDINGS: Record<string, string> = {
  Use: 'E',
  Attack: 'Left Mouse',
  Throw: 'Right Mouse',
  Jump: 'Space',
  Crouch: 'C',
  Run: 'Shift',
  LadderMove: 'W / S',
  Flashlight: 'F',
  FirstPerson: 'V',
  Insanity: 'Q',
  Reload: 'R',
  Health: 'H',
  UseHealth: 'H',
  Inventory: 'Tab',
  Map: 'M',
  GUISelect: 'Enter',
  GUICancel: 'Esc',
};

/** Current bindings: defaults overlaid with any published by other systems. */
export function currentBindings(services: Record<string, unknown>): Record<string, string> {
  const fromService = (services.input as { bindings?: Record<string, string> } | undefined)?.bindings;
  const fromWindow = (globalThis as { __bindings?: Record<string, string> }).__bindings;
  return { ...DEFAULT_BINDINGS, ...(fromWindow ?? {}), ...(fromService ?? {}), ...input.labelMap() };
}

/** Expands <Action> placeholders; unknown names become the bare action name. */
export function expandHelpText(text: string, bindings: Record<string, string>): string {
  return expandControls(text, bindings)
    .replace(/<([A-Za-z][A-Za-z0-9]*)>/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * The interaction prompt as the world system builds it ("<b>E</b> Open") -> key + action
 * text. Placeholder form ("<Use> Open") is accepted too.
 */
export function parsePrompt(html: string, bindings: Record<string, string>): { key?: string; text: string } {
  const m = /^\s*<b>([^<]*)<\/b>\s*(.*)$/s.exec(html);
  const strip = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/·/g, '-')
      .trim();
  if (m) return { key: strip(m[1]), text: strip(m[2]) };
  const p = /^\s*<([A-Za-z][A-Za-z0-9]*)>\s*(.*)$/s.exec(html);
  if (p) return { key: bindings[p[1]] ?? p[1], text: strip(p[2]) };
  return { text: strip(html) };
}
