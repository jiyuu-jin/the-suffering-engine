// Combat HUD calls (health, weapon, hit marker, damage flash, death). The HUD is
// drawn by the HUD system (src/game/hud/system.ts) from the game's own HUD
// templates; this adapter keeps the calls the combat code makes and forwards
// them to the HUD bus.

import { hudBus } from '../hud/bus';

export interface CombatHud {
  setHealth(health: number, max: number): void;
  setWeapon(label: string): void;
  hitMarker(kill?: boolean): void;
  damageFlash(): void;
  setDead(dead: boolean): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export function createCombatHud(_container?: HTMLElement): CombatHud {
  return {
    setHealth(h, max) {
      hudBus.health = { value: h, max };
    },
    setWeapon(label) {
      hudBus.weaponLabel = label;
    },
    hitMarker(kill = false) {
      hudBus.hitAt = hudBus.clock;
      hudBus.hitKill = kill;
    },
    damageFlash() {
      hudBus.damageAt = hudBus.clock;
    },
    setDead(d) {
      hudBus.dead = d;
    },
    setVisible(v) {
      hudBus.combatVisible = v;
    },
    dispose() {
      hudBus.health = null;
      hudBus.dead = false;
    },
  };
}
