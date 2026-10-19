// Native gameplay actions of the keyboard page that have no legacy key listener (see
// bindings.ts): weapon / throwable selection by name, previous throwable, health, and the
// death prompt. Installed per level by the HUD system; handlers use the services the weapons
// and world systems publish (all optional).
//
// Weapon selection follows the global cycle order (Item p38) of the retail templates [data]:
// shiv 1, fire axe 2, revolver 3, dual revolvers 4, tommy gun 5, shotgun 6, flamethrower 7;
// throwables flare 11, flash/bang 12, TNT 13, molotov 14, shrapnel 15.
//
// Roll Left / Right (Player state 15 "Roll", input 0x432 / 0x433, enter RFL 0x1003aa00): the held
// weapon's Player Weapon Properties p166 (left) / p167 (right) clip (unarmed: Player p143; every
// set names 2:95 / 2:106, 0.93 / 0.83 s, 3.9 m sideways in the clip's root motion). The port
// plays the clip in place on the body and moves the player sideways by the clip's root distance
// over its length through the motor (so walls stop it); on the ground, not while transformed.
//
// The Map action opens the map screen (hud/map.ts data, drawn by the menu flow's map screen
// through uiBridge.map).

import type { GameContext } from '../runtime';
import { input, type ActionId } from './bindings';
import type { ResRef } from '../../formats/model';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet } from '../../formats/entities';
import { loadClip } from '../actors/clipmap';
import { rootMotion } from '../../formats/animation';

export const ACTION_ORDER: Partial<Record<ActionId, number>> = {
  shiv: 1,
  fireAxe: 2,
  pistol: 3,
  dualPistols: 4,
  tommyGun: 5,
  shotgun: 6,
  flamethrower: 7,
  flare: 11,
  flashBang: 12,
  tnt: 13,
  molotov: 14,
  shrapnel: 15,
};

interface WeaponsLike {
  weapons?: readonly { id: string; order?: number; current?: boolean }[];
  throwable?: { id: string } | null;
  equip?(id: string): void;
  nextThrowable?(): void;
  def?(id: string): { kind?: string; order?: number } | undefined;
  /** Drink a Xombium bottle (weapons system): false when the original's rules refuse. */
  useHealthPack?(): boolean;
  current?: { id: string } | null;
}

interface InventoryLike {
  items?: ReadonlyMap<string, { count: number; template?: { pkg: number; id: number } }>;
  useHealth?(): void;
}

/** Owned throwables (inventory items whose weapon definition is a throwable), by order. */
export function ownedThrowables(services: Record<string, unknown>): { id: string; order: number; count: number }[] {
  const w = services.weapons as WeaponsLike | undefined;
  const inv = services.inventory as InventoryLike | undefined;
  const out: { id: string; order: number; count: number }[] = [];
  const seen = new Set<string>();
  for (const it of inv?.items?.values() ?? []) {
    if (!it.template || it.count <= 0) continue;
    const id = `${it.template.pkg}:${it.template.id}`;
    const d = w?.def?.(id);
    if (d?.kind !== 'throwable' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, order: d.order ?? 99, count: it.count });
  }
  return out.sort((a, b) => a.order - b.order);
}

export function installActions(ctx: GameContext, opts: { dead(): boolean }): () => void {
  const weapons = () => ctx.services.weapons as WeaponsLike | undefined;
  const off: (() => void)[] = [];

  /** Selects the owned throwable with `order` by cycling (the service has no direct select). */
  const selectThrowable = (order: number) => {
    const w = weapons();
    const list = ownedThrowables(ctx.services);
    const target = list.find((t) => t.order === order);
    if (!w?.nextThrowable || !target) return;
    for (let i = 0; i < list.length + 1 && w.throwable?.id !== target.id; i++) w.nextThrowable();
  };

  for (const [action, order] of Object.entries(ACTION_ORDER) as [ActionId, number][]) {
    off.push(
      input.onPress(action, () => {
        if (opts.dead()) return;
        if (order >= 11) return selectThrowable(order);
        const w = weapons();
        const hit = w?.weapons?.find((x) => x.order === order);
        if (hit && !hit.current) w?.equip?.(hit.id);
      }),
    );
  }
  off.push(
    input.onPress('prevThrown', () => {
      const w = weapons();
      const n = ownedThrowables(ctx.services).length;
      if (!w?.nextThrowable || n < 2) return;
      for (let i = 0; i < n - 1; i++) w.nextThrowable();
    }),
  );
  // --- Roll -----------------------------------------------------------------------------
  let rolling: (() => void) | null = null;
  const roll = (dir: -1 | 1) => {
    const view = ctx.view;
    const p = view.player;
    const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
    const pb = (ctx.services.actors as { playerBody?: { play(c: ResRef, o?: { inPlace?: boolean; fade?: number }): number; unarmedProps?: ResRef } | null } | undefined)?.playerBody;
    const ins = ctx.services.insanity as { transformed?: boolean } | undefined;
    const world = ctx.services.world as { inCutscene?: boolean } | undefined;
    if (rolling || opts.dead() || !pkgs || !pb || !view.walking || !p.enabled || !p.onGround || ins?.transformed || world?.inCutscene) return;
    // The held weapon's Player Weapon Properties (unarmed: Player p143).
    const w = weapons();
    const def = w?.current ? (w.def?.(w.current.id) as { pwp?: { ref: ResRef } } | undefined) : undefined;
    const pwp = def?.pwp?.ref ?? pb.unarmedProps;
    const t = pwp && readObjectTemplate(pkgs, pwp);
    const c = t && classByHash(t.classHash);
    const v = t && c?.name === 'Player Weapon Properties' ? decodeTemplateProps(c, t) : [];
    const clip = v[dir < 0 ? 166 : 167] as ResRef | null | undefined;
    const data = clip && typeof clip === 'object' ? loadClip(pkgs, clip) : undefined;
    if (!clip || !data) return;
    const seconds = pb.play(clip, { inPlace: true, fade: 0.08 });
    if (seconds <= 0) return;
    const dist = Math.abs(rootMotion(data)[0]) || 3.9;
    const cfg = p.motor.cfg;
    const saved = { run: cfg.runSpeed, walk: cfg.walkSpeed };
    cfg.runSpeed = cfg.walkSpeed = dist / seconds;
    p.setVirtualInput({ forward: 0, strafe: dir, run: true });
    let t0 = 0;
    const offFrame = p.onUpdate((f) => {
      t0 += f.dt;
      if (t0 >= seconds) rolling?.();
    });
    rolling = () => {
      offFrame();
      cfg.runSpeed = saved.run;
      cfg.walkSpeed = saved.walk;
      p.setVirtualInput(null);
      rolling = null;
    };
  };
  off.push(input.onPress('rollLeft', () => roll(-1)));
  off.push(input.onPress('rollRight', () => roll(1)));
  off.push(() => rolling?.());

  off.push(
    input.onPress('health', () => {
      // Health action 0x430: drink the first carried Health Bonus Item (weapons system,
      // useHealthPack; rules in src/app/player-rules.ts canDrinkHealth). Keyboard and pad alike.
      const w = weapons();
      if (w?.useHealthPack) w.useHealthPack();
      else (ctx.services.inventory as InventoryLike | undefined)?.useHealth?.();
    }),
  );
  return () => {
    for (const f of off) f();
  };
}
