// Player combat: health, death / revive, and the hook through which the weapons system
// (src/game/weapons) drives attacks.
//
// The weapon controls (fire / reload / switch / throw / melee) live in src/game/weapons/system.ts
// (services.weapons); this class keeps the player's health API (services.combat.player,
// damagePlayer / healPlayer) and forwards services.combat.attack() to the weapons system
// through `combatLink`. Weapon sounds are read from the templates there (Melee Weapon p71 /
// p74, Ranged Weapon p79); `resolveWeaponSounds` is kept for the damage-taken cue.

import * as THREE from 'three/webgpu';
import type { AudioSystem } from '../../app/audio';
import type { LevelRenderer } from '../../app/renderer';
import type { PackageSet, ResRef } from '../../formats/model';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { ActorManager } from './manager';
import type { PlayerBody } from './player-body';
import type { CombatHud } from './hud';
import type { Actor } from './actor';
import { difficulty } from '../campaign/difficulty';

export interface WeaponSounds {
  swing: string[];
  impact: string[];
  fire: string[];
}

const SHIV: ResRef = { pkg: 4, id: 79 };
const REVOLVER: ResRef = { pkg: 4, id: 5 };

/** Sound refs of a template property (single or list) as "pkg:id" keys. */
function soundKeys(pkgs: PackageSet, tpl: ResRef, prop: number): string[] {
  const t = readObjectTemplate(pkgs, tpl);
  const cls = t ? classByHash(t.classHash) : undefined;
  if (!t || !cls) return [];
  const v = decodeTemplateProps(cls, t)[prop];
  return (Array.isArray(v) ? v : [v]).flatMap((r) => (r && typeof r === 'object' ? [`${r.pkg}:${r.id}`] : []));
}

export function resolveWeaponSounds(pkgs: PackageSet): WeaponSounds {
  const fire = soundKeys(pkgs, REVOLVER, 79);
  return {
    swing: soundKeys(pkgs, SHIV, 71),
    impact: soundKeys(pkgs, SHIV, 74),
    fire: fire.length > 1 ? fire.slice(-1) : fire,
  };
}

/**
 * Link between the actors system's PlayerCombat and the weapons system (which starts later):
 * the weapons system reads `combat` / `body` and installs `attack`.
 */
export const combatLink: {
  combat: PlayerCombat | null;
  body: PlayerBody | null;
  attack: ((kind: 'melee' | 'fire') => boolean) | null;
} = { combat: null, body: null, attack: null };

export class PlayerCombat {
  health = 100;
  maxHealth = 100;
  invulnerable = false;
  /** The death clip the next death plays (the killer's: system.ts playerDeathClip), then its start / length. */
  deathClip?: ResRef;
  deathClipLength = 0;
  private savedMode: 'fp' | 'tp' | null = null;
  private off: (() => void)[] = [];

  constructor(
    private readonly view: LevelRenderer,
    private readonly audio: AudioSystem,
    _actors: ActorManager,
    private readonly body: PlayerBody | null,
    private readonly hud: CombatHud | null,
    private readonly sounds: WeaponSounds,
    _onHit: (a: Actor, amount: number, killed: boolean) => void,
  ) {
    // Difficulty: Player p1 x the p2 Difficulty Modifier (Easy 200 .. Impossible 60).
    this.maxHealth = this.health = difficulty.playerMaxHealth();
    this.hud?.setHealth(this.health, this.maxHealth);
    combatLink.combat = this;
    combatLink.body = body;
    // Death is handled by the death screen, which reverts to the last checkpoint
    // (src/game/hud + src/game/save); there is no instant revive key.
  }

  get alive() {
    return this.health > 0;
  }

  private play(keys: string[], pos?: THREE.Vector3Like, volume = 1) {
    const ok = keys.filter((k) => this.audio.get(k));
    if (!ok.length) return;
    const k = ok[Math.floor(Math.random() * ok.length)];
    if (pos) this.audio.play3D(k, [pos.x, pos.y, pos.z], { volume, bus: 'sfx' });
    else this.audio.play(k, { volume, bus: 'sfx' });
  }

  /** Trigger a player attack through the weapons system (also used by tests). */
  attack(kind: 'melee' | 'fire'): boolean {
    if (!this.alive) return false;
    return combatLink.attack?.(kind) ?? false;
  }

  damage(amount: number, from?: Actor) {
    if (!this.alive || this.invulnerable || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.hud?.setHealth(this.health, this.maxHealth);
    this.hud?.damageFlash();
    if (from) this.play(this.sounds.impact, this.view.player.position, 0.6);
    if (!this.alive) this.die();
  }

  heal(amount: number): number {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    this.hud?.setHealth(this.health, this.maxHealth);
    return this.health - before;
  }

  private die() {
    const p = this.view.player;
    this.deathClipLength = this.body?.die(this.deathClip) ?? 0;
    this.deathClip = undefined;
    p.setVirtualInput({ forward: 0, strafe: 0 });
    // The view to give back: the chosen one, not a hit reaction's third person (stateTp).
    this.savedMode = p.chosenMode();
    p.setMode('tp');
    this.hud?.setDead(true);
  }

  revive() {
    const p = this.view.player;
    this.health = this.maxHealth;
    this.hud?.setHealth(this.health, this.maxHealth);
    this.hud?.setDead(false);
    this.body?.revive();
    p.setVirtualInput(null);
    if (this.savedMode) p.setMode(this.savedMode);
    this.savedMode = null;
  }

  update(_dt: number) {}

  dispose() {
    for (const f of this.off) f();
    if (combatLink.combat === this) {
      combatLink.combat = null;
      combatLink.body = null;
    }
    if (!this.alive) this.view.player.setVirtualInput(null);
  }
}
