// The original game's profile (Unspeakable.cfg, docs/re/saves.md §2) and the port's settings:
// import (options, the Archives pages, the "finished" unlock) and export (the port's options
// written as an Unspeakable.cfg the original reads). The bindings, speaker setup and the fields
// the port does not use are kept from the imported file (localStorage, ORIGINAL_KEY) so an
// export gives the player's own file back with the options changed; without one the export
// carries the RFL's default key table read from the user's Suffering.rfl.
//
// One binding travels both ways: the Flare key (action 0x427, retail T). An import puts the
// file's keyboard / mouse inputs for it on the port's Flare row; an export writes the port's
// Flare row into the file's records. The other actions keep the port's own key set (its WASD
// layout differs from the original's on purpose: src/game/hud/bindings.ts).

import { bindingInputs, defaultOriginalSettings, originalSettingsToPort, portSettingsToOriginal, readDefaultBindings, RFL_DEFAULT_BINDINGS, withBindingInputs, writeOriginalSettings, type KeyBinding, type OriginalSettings, type PortSettingsFromOriginal } from '../../formats/save-original';
import { input, type ActionId } from '../../game/hud/bindings';
import { RETAIL_PC_KEYS } from '../player-rules';
import { peOffset, readPe } from '../../formats/pe';
import type { GameFS } from '../gamefs';
import type { ArchivesSpec } from './model';
import type { Settings } from './settings';
import { profile } from './profile';

const ORIGINAL_KEY = 'suffering.original-profile.v1';

/** Archive page refs ("5:467") of [set, page index] bits (Archive Set order = the bit index). */
export function archiveRefs(archives: ArchivesSpec | undefined, pages: readonly [number, number][]): string[] {
  const out: string[] = [];
  for (const [set, i] of pages) {
    const ref = archives?.sets[set]?.pages[i]?.ref;
    if (ref) out.push(ref);
  }
  return out;
}

/** [set, page index] of the unlocked refs. */
export function archiveBits(archives: ArchivesSpec | undefined, unlocked: Iterable<string>): [number, number][] {
  const want = new Set(unlocked);
  const out: [number, number][] = [];
  (archives?.sets ?? []).slice(0, 2).forEach((s, set) => s.pages.forEach((p, i) => want.has(p.ref) && out.push([set, i])));
  return out;
}

/** The actions whose binding an Unspeakable.cfg carries (port action, original action id). */
export const CARRIED_BINDINGS: readonly [ActionId, number][] = [['flare', RETAIL_PC_KEYS.flare.id]];

/** The port's two key / mouse slots for each carried action, from the file's records. */
export function importedBindings(bindings: readonly KeyBinding[]): Partial<Record<ActionId, [string, string]>> {
  const out: Partial<Record<ActionId, [string, string]>> = {};
  for (const [a, id] of CARRIED_BINDINGS) {
    const codes = bindingInputs(bindings, id);
    if (codes.length) out[a] = [codes[0], codes[1] ?? ''];
  }
  return out;
}

/** The file's records with each carried action's records replaced by the port's slots. */
export function exportedBindings(bindings: readonly KeyBinding[], keys: Partial<Record<ActionId, readonly [string, string]>>): KeyBinding[] {
  let out = bindings.map((b) => ({ ...b }));
  // No table to write into (no imported file, no readable Suffering.rfl): left empty, as the
  // original then falls back to its defaults; a file holding only these would unbind the rest.
  if (!out.length) return out;
  for (const [a, id] of CARRIED_BINDINGS) {
    const k = keys[a];
    if (k) out = withBindingInputs(out, id, k.filter((c) => !!c));
  }
  return out;
}

/** Imported profile -> the port's settings (in place) and the player profile. Returns what changed. */
export function applyOriginalProfile(s: OriginalSettings, settings: Settings, archives: ArchivesSpec | undefined): { pages: number; finished: boolean } {
  const p = originalSettingsToPort(s);
  settings.sfx = p.sfx;
  settings.voice = p.voice;
  settings.music = p.music;
  settings.mouseSensitivity = p.mouseSensitivity;
  settings.pitchSensitivity = p.pitchSensitivity;
  settings.invertY = p.invertY;
  settings.subtitles = p.subtitles;
  settings.extra.checkpoints = p.extra.checkpoints;
  // Port rows: choice 0 = On, 1 = Off.
  settings.extra.helpText = p.extra.helpText ? 0 : 1;
  settings.extra.environmentFx = p.extra.environmentFx;
  settings.extra.padVibration = p.extra.vibration;
  // The carried bindings (the Flare key) onto the port's rows.
  const keys = importedBindings(s.bindings);
  for (const [a, k] of Object.entries(keys) as [ActionId, [string, string]][]) {
    input.set(a, 0, k[0]);
    input.set(a, 1, k[1]);
  }
  if (Object.keys(keys).length) input.save();
  const fresh = profile.unlockPages(archiveRefs(archives, p.archivePages));
  if (p.gameFinished) profile.setGameFinished();
  try {
    localStorage.setItem(ORIGINAL_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: an export then starts from the defaults */
  }
  return { pages: fresh.length, finished: p.gameFinished };
}

/** The port's side of an export. */
export function portSide(settings: Settings, archives: ArchivesSpec | undefined): PortSettingsFromOriginal {
  const x = settings.extra;
  return {
    sfx: settings.sfx,
    voice: settings.voice,
    music: settings.music,
    mouseSensitivity: settings.mouseSensitivity,
    pitchSensitivity: settings.pitchSensitivity,
    invertY: settings.invertY,
    subtitles: settings.subtitles,
    extra: { checkpoints: typeof x.checkpoints === 'number' ? x.checkpoints : 2, helpText: x.helpText !== 1, environmentFx: typeof x.environmentFx === 'number' ? x.environmentFx : 1, vibration: x.padVibration !== false },
    gameFinished: profile.preludeUnlocked,
    archivePages: archiveBits(archives, profile.unlockedPages()),
  };
}

function storedOriginal(): OriginalSettings | null {
  try {
    const raw = localStorage.getItem(ORIGINAL_KEY);
    const s = raw ? (JSON.parse(raw) as OriginalSettings) : null;
    return s && Array.isArray(s.bindings) && Array.isArray(s.archives) ? s : null;
  } catch {
    return null;
  }
}

/** The RFL's default bindings from the game data, if Suffering.rfl can be read. */
async function rflBindings(fs: GameFS): Promise<OriginalSettings['bindings']> {
  try {
    const path = await fs.resolve('Suffering.rfl');
    if (!path) return [];
    const bytes = new Uint8Array(await fs.read(path));
    const off = peOffset(readPe(bytes), RFL_DEFAULT_BINDINGS);
    return off < 0 ? [] : readDefaultBindings(bytes, off);
  } catch {
    return [];
  }
}

/** Unspeakable.cfg bytes for the port's settings; `base` says where the rest came from. */
export async function buildOriginalProfile(settings: Settings, archives: ArchivesSpec | undefined, fs: GameFS): Promise<{ bytes: Uint8Array; base: 'imported' | 'defaults'; bindings: number }> {
  const stored = storedOriginal();
  const base = stored ?? { ...defaultOriginalSettings(), bindings: await rflBindings(fs) };
  const s = portSettingsToOriginal(portSide(settings, archives), base);
  s.bindings = exportedBindings(s.bindings, input.current.keys);
  return { bytes: writeOriginalSettings(s), base: stored ? 'imported' : 'defaults', bindings: s.bindings.length };
}
