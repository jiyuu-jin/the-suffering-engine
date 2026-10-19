// HudModel: everything the HUD reads each frame, gathered defensively from the
// services other systems publish on ctx.services. Every source is optional.
//
// Contract with the systems built alongside the HUD (fields read, all optional):
//
//   services.combat      (src/game/actors/system.ts, exists)
//     player: { health: number; maxHealth: number; alive: boolean }
//
//   services.weapons     (src/game/weapons/*)
//     current?: {
//       name?: string;
//       ammoMeter?: RefKey | ResRef | null;   // HUD Ammo Meter template (Ranged Weapon p89, e.g. "5:102")
//       clip?: number; clipSize?: number;     // rounds in the weapon / per clip (fills the meter)
//       reserve?: number;                     // rounds carried besides the clip (count text)
//       crosshair?: RefKey | ResRef | null;   // HUD Texture (Player Weapon Properties p7..9), default 5:202
//       ranged?: boolean;                     // false for melee (no ammo meter)
//     } | null
//     throwable?: { name?: string; meter?: RefKey | ResRef | null; count: number } | null   // Missile Item p56
//     healthPacks?: number                    // Xombium bottles carried (Player HUD Ammo Meter 5:457)
//     flashlight?: { on: boolean; battery: number /* 0..1 */ } | null
//     targeting?: boolean                     // crosshair over an enemy (red crosshair 5:442)
//
//   services.insanity    (src/game/insanity/*)
//     meter: number                           // 0..1
//     enabled?: boolean                       // false until the level allows insanity (default: shown)
//     mode?: string                           // 'normal' | 'insane' | ...; anything else than 'normal' = transformed
//     transformed?: boolean
//     available?: boolean                     // can transform now (the meter flashes)
//
//   services.flashlight  (optional, overrides weapons.flashlight) { on: boolean; battery: number }
//   services.inventory   (src/game/world, exists) items: Map<template "pkg:id", { name, count, className }>, health, maxHealth
//   services.world       (exists) inCutscene: boolean
//
// Without services.weapons.healthPacks the bottle counter stays hidden (Health Bonus Items
// heal on pickup in the world system). Without a flashlight source the battery meter shows
// (full) only while the renderer's lamp is on.

import type { ResRef } from '../../formats/model';
import type { RefKey } from '../../formats/gui';
import { hudBus } from './bus';

export interface HudWeapon {
  name?: string;
  ammoMeter?: RefKey;
  clip: number;
  clipSize: number;
  reserve?: number;
  crosshair?: RefKey;
  ranged: boolean;
}

export interface HudModel {
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Insanity 0..1; undefined = no insanity meter. */
  insanity?: number;
  insane: boolean;
  /** Insanity meter full / transformation available (flashing frame). */
  insanityReady: boolean;
  weapon?: HudWeapon;
  throwable?: { name?: string; meter?: RefKey; count: number };
  /** Xombium bottles; undefined = counter hidden. */
  healthPacks?: number;
  /** Flashlight battery 0..1 and state; undefined = meter hidden. */
  flashlight?: { on: boolean; battery: number };
  targeting: boolean;
  inCutscene: boolean;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function toRefKey(v: unknown): RefKey | undefined {
  if (typeof v === 'string' && /^\d+:\d+$/.test(v)) return v;
  if (v && typeof v === 'object' && 'pkg' in v && 'id' in v) {
    const r = v as ResRef;
    return `${r.pkg}:${r.id}`;
  }
  return undefined;
}

/** Reads the services into a HudModel. `flashlightOn` is the renderer's lamp state. */
export function readHudModel(services: Record<string, unknown>, flashlightOn: boolean): HudModel {
  const combat = services.combat as { player?: { health?: number; maxHealth?: number; alive?: boolean } } | undefined;
  const inv = services.inventory as { health?: number; maxHealth?: number; items?: ReadonlyMap<string, { count: number; className?: string }> } | undefined;
  const p = combat?.player;
  const bus = hudBus.health;
  const maxHealth = Math.max(1, num(p?.maxHealth, bus?.max ?? num(inv?.maxHealth, 100)));
  const health = num(p?.health, bus?.value ?? num(inv?.health, maxHealth));
  const alive = p?.alive ?? health > 0;

  const m: HudModel = { health, maxHealth, alive, insane: false, insanityReady: false, targeting: false, inCutscene: false };

  const ins = services.insanity as { meter?: number; enabled?: boolean; mode?: string; transformed?: boolean; available?: boolean } | undefined;
  if (ins && ins.enabled !== false && typeof ins.meter === 'number') {
    m.insanity = Math.max(0, Math.min(1, ins.meter));
    m.insane = !!ins.transformed || (typeof ins.mode === 'string' && ins.mode !== 'normal');
    m.insanityReady = !!ins.available || m.insanity >= 0.999;
  }

  const w = services.weapons as
    | {
        current?: Record<string, unknown> | null;
        throwable?: { name?: string; meter?: unknown; count?: number } | null;
        healthPacks?: number;
        flashlight?: { on?: boolean; battery?: number } | null;
        targeting?: boolean;
      }
    | undefined;
  const cur = w?.current;
  if (cur) {
    const clipSize = num(cur.clipSize, 0);
    m.weapon = {
      name: typeof cur.name === 'string' ? cur.name : undefined,
      ammoMeter: toRefKey(cur.ammoMeter),
      clip: num(cur.clip, 0),
      clipSize,
      reserve: typeof cur.reserve === 'number' ? cur.reserve : undefined,
      crosshair: toRefKey(cur.crosshair),
      ranged: typeof cur.ranged === 'boolean' ? cur.ranged : !!toRefKey(cur.ammoMeter) || clipSize > 0,
    };
  }
  if (w?.throwable && num(w.throwable.count) >= 0) m.throwable = { name: w.throwable.name, meter: toRefKey(w.throwable.meter), count: num(w.throwable.count) };
  if (typeof w?.healthPacks === 'number') m.healthPacks = w.healthPacks;
  m.targeting = !!w?.targeting;

  const fl = (services.flashlight as { on?: boolean; battery?: number } | undefined) ?? w?.flashlight ?? undefined;
  if (fl) m.flashlight = { on: fl.on ?? flashlightOn, battery: Math.max(0, Math.min(1, num(fl.battery, 1))) };
  else if (flashlightOn) m.flashlight = { on: true, battery: 1 };

  const world = services.world as { inCutscene?: boolean } | undefined;
  m.inCutscene = !!world?.inCutscene;
  return m;
}
