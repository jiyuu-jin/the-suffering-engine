// User settings (volumes, mouse, subtitles, difficulty, gameplay and graphics options),
// persisted in localStorage. Every storage access is wrapped: private windows and blocked
// site data must not break the game, they just lose persistence.
//
// Hooks into other modules:
//   - AudioSystem.setBusVolume for the four buses.
//   - PlayerController.sensitivity / pitchScale / invertY and FlyControls.sensitivity
//     (public fields; any `look` target that has them).
//   - Graphics options (`x.<row id>` in `extra`) are applied by ./graphics.ts.
//   - Key bindings are not settings: they live in src/game/hud/bindings.ts. The Controller
//     page's layout choice (`x.padLayout`) mirrors the bindings' pad layout.
//   - Controller page options (`x.pad*`): src/app/gamepad.ts `pads.options`.
//   - Port option `x.ignorePlayer` (Gameplay pages, "Enemies Ignore Player"): the live flag in
//     src/game/port-options.ts (`?ignorePlayer=1` / `=0` overrides it per page load: MenuFlow).

import type { AudioSystem } from '../audio';
import { PAD_DEFAULTS, pads } from '../gamepad';
import { input } from '../../game/hud/bindings';
import { portOptions } from '../../game/port-options';

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  voice: number;
  /** Multiplier on the default mouse sensitivity (0.25..3). */
  mouseSensitivity: number;
  /** Multiplier on the pitch part of mouse look (gameplay "Pitch Sensitivity"). */
  pitchSensitivity: number;
  invertY: boolean;
  subtitles: boolean;
  /** Difficulty of the last new game (0 easy .. 3 impossible). */
  difficulty: number;
  /**
   * Options the game's pages expose that the engine stores but does not act on
   * yet (pitch sensitivity, help text, checkpoints, graphics...). Keyed by row id.
   */
  extra: Record<string, number | boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.9,
  music: 0.7,
  sfx: 0.9,
  voice: 1,
  mouseSensitivity: 1,
  pitchSensitivity: 1,
  invertY: false,
  subtitles: true,
  difficulty: 1,
  // Environment FX defaults to Off (choice 1): the retail PC build never applied reverb
  // (docs/re/audio.md §5); the port's generated reverb is an opt-in extra.
  extra: { environmentFx: 1 },
};

const KEY = 'suffering.settings.v1';
/** Default look sensitivity of PlayerController/FlyControls (radians per pixel). */
export const BASE_SENSITIVITY = 0.0022;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const out: Settings = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (k === 'extra') continue;
        if (typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) (out as unknown as Record<string, unknown>)[k] = parsed[k];
      }
      out.extra = { ...DEFAULT_SETTINGS.extra };
      if (parsed.extra && typeof parsed.extra === 'object') {
        for (const [k, v] of Object.entries(parsed.extra)) if (typeof v === 'number' || typeof v === 'boolean') out.extra[k] = v;
      }
      return out;
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return { ...DEFAULT_SETTINGS, extra: { ...DEFAULT_SETTINGS.extra } };
}

export function cloneSettings(s: Settings): Settings {
  return { ...s, extra: { ...s.extra } };
}

/** Reads a menu setting key: a Settings field, or "x.<id>" in `extra`. */
export function getSetting(s: Settings, key: string): number | boolean | undefined {
  if (key.startsWith('x.')) return s.extra[key.slice(2)];
  return (s as unknown as Record<string, number | boolean>)[key];
}

export function setSetting(s: Settings, key: string, v: number | boolean): void {
  if (key.startsWith('x.')) s.extra[key.slice(2)] = v;
  else (s as unknown as Record<string, number | boolean>)[key] = v;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export interface SettingsTargets {
  audio: AudioSystem;
  /** Objects with a public `sensitivity` field (PlayerController, FlyControls); `pitchScale` / `invertY` when present. */
  look: { sensitivity: number; pitchScale?: number; turnScale?: number; invertY?: boolean; alwaysRun?: boolean }[];
}

export function applySettings(s: Settings, t: SettingsTargets): void {
  t.audio.setBusVolume('master', s.master);
  t.audio.setBusVolume('music', s.music);
  t.audio.setBusVolume('sfx', s.sfx);
  t.audio.setBusVolume('voice', s.voice);
  for (const l of t.look) {
    l.sensitivity = BASE_SENSITIVITY * s.mouseSensitivity;
    if ('pitchScale' in l) l.pitchScale = s.pitchSensitivity;
    // The original's Turn sensitivity scales every turn input (mouse, keys, and here the pad).
    if ('turnScale' in l) l.turnScale = s.mouseSensitivity;
    if ('invertY' in l) l.invertY = s.invertY;
    if ('alwaysRun' in l) l.alwaysRun = !!s.extra.alwaysRun;
  }
  applyPadSettings(s);
  portOptions.ignorePlayer = s.extra.ignorePlayer === true;
}

/** Controller page options -> the gamepad manager and the bindings' pad layout. */
export function applyPadSettings(s: Settings): void {
  const x = s.extra;
  const n = (k: string, d: number) => (typeof x[k] === 'number' && Number.isFinite(x[k]) ? (x[k] as number) : d);
  const b = (k: string, d: boolean) => (typeof x[k] === 'boolean' ? (x[k] as boolean) : d);
  const o = pads.options;
  o.sensitivity = Math.max(0.1, Math.min(4, n('padSensitivity', PAD_DEFAULTS.sensitivity)));
  o.deadZone = Math.max(0, Math.min(0.6, n('padDeadZone', PAD_DEFAULTS.deadZone)));
  o.curve = Math.round(n('padCurve', PAD_DEFAULTS.curve));
  o.triggerThreshold = Math.max(0.05, Math.min(0.95, n('padTrigger', PAD_DEFAULTS.triggerThreshold)));
  o.vibration = b('padVibration', PAD_DEFAULTS.vibration);
  o.aimAssist = b('padAimAssist', PAD_DEFAULTS.aimAssist);
  o.autoPitch = b('padAutoPitch', PAD_DEFAULTS.autoPitch);
  if (!o.vibration) pads.stopRumble();
  const layout = n('padLayout', input.padLayout);
  if (layout !== input.padLayout) {
    input.setPadLayout(layout);
    input.save();
  }
}
