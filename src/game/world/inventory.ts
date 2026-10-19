// The player's inventory store (services.inventory; world.ts creates it, it travels with the
// player between levels and is saved by the 'inventory' provider, src/game/save/providers.ts).
//
// Items are keyed by their item TEMPLATE ("pkg:id"), like the original's inventory, which
// holds item objects and counts them per template (Player +0x108: 0x1004cd80 count of a
// template, 0x10039b10 give, 0x1004cf60 take every one of a template) [verified]. Display
// names (Item p22) are for the HUD only: different templates may share one (the Killjoy
// Rebirth grenade 4:804 and the Shrapnel Grenade 4:655 both use the string 4:47), and
// merging by name would mix them. Items given without a template (a drunk Xombium bottle
// noted when no weapons system stores bottles) are keyed by `name:<display name>`.

import type { ResRef } from '../../formats/model';
import { classByHash, decodeTemplateProps, readObjectTemplate, readXduString, type EntityPackageSet } from '../../formats/entities';

export interface InventoryItem {
  /** Display name (HUD). */
  name: string;
  count: number;
  /** Item template (the key of the entry). */
  template?: ResRef;
  className?: string;
}

/** An item given by template ref, by inventory key ("pkg:id" / "name:..."), or by display name. */
export type ItemSelector = ResRef | string;

export interface InventoryService {
  /** Entries by inventory key (`inventoryKey`). */
  readonly items: ReadonlyMap<string, InventoryItem>;
  add(name: string, count: number, template?: ResRef, className?: string): void;
  /** Owns at least one of an item. */
  has(item: ItemSelector): boolean;
  /** Number held of an item (summed over entries when a display name matches several). */
  count(item: ItemSelector): number;
  /** Take up to `n` (default all) of an item; returns how many were taken. */
  remove(item: ItemSelector, n?: number): number;
  /** Health when no combat service is present (otherwise services.combat is authoritative). */
  health: number;
  maxHealth: number;
}

export const refKey = (r: ResRef) => `${r.pkg}:${r.id}`;
const REF_KEY = /^\d+:\d+$/;

/** Inventory key of an item: its template "pkg:id", else `name:<display name>`. */
export function inventoryKey(template: ResRef | undefined, name: string): string {
  return template ? refKey(template) : `name:${name}`;
}

/** "pkg:id" -> ref (undefined for anything else). */
export function parseRefKey(k: string): ResRef | undefined {
  if (!REF_KEY.test(k)) return undefined;
  const [pkg, id] = k.split(':').map(Number);
  return { pkg, id };
}

/**
 * Inventory over `items` (the caller keeps the map so it can outlive one level).
 * `displayName(template)` names entries added under a bare "pkg:id" (Inventory Add Remove).
 */
export function createInventory(items: Map<string, InventoryItem>, displayName?: (r: ResRef) => string | undefined): InventoryService {
  const entries = (sel: ItemSelector): InventoryItem[] => {
    if (typeof sel !== 'string') {
      const it = items.get(refKey(sel));
      return it ? [it] : [];
    }
    const it = items.get(sel);
    if (it) return [it];
    // A display name: every entry carrying it (HUD / debug callers).
    return [...items.values()].filter((x) => x.name === sel);
  };
  const inv: InventoryService = {
    items,
    health: 100,
    maxHealth: 100,
    add(name, count, template, className) {
      if (template && name === refKey(template)) name = displayName?.(template) ?? name;
      const key = inventoryKey(template, name);
      let it = items.get(key);
      if (!it) items.set(key, (it = { name, count: 0, template: template ? { pkg: template.pkg, id: template.id } : undefined, className }));
      else if (!it.className && className) it.className = className;
      it.count += count;
    },
    has: (sel) => entries(sel).some((it) => it.count > 0),
    count: (sel) => entries(sel).reduce((n, it) => n + Math.max(0, it.count), 0),
    remove(sel, n = Infinity) {
      let taken = 0;
      for (const it of entries(sel)) {
        if (taken >= n) break;
        const k = Math.min(n - taken, Math.max(0, it.count));
        it.count -= k;
        taken += k;
        if (it.count <= 0) items.delete(inventoryKey(it.template, it.name));
      }
      return taken;
    },
  };
  return inv;
}

/** Display name (Item p22) of an item template; undefined for other classes. */
export function itemTemplateName(pkgs: EntityPackageSet, r: ResRef): string | undefined {
  const t = readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  if (!t || !c || c.family !== 'Item') return undefined;
  const n = decodeTemplateProps(c, t)[22];
  return n && typeof n === 'object' && !Array.isArray(n) ? readXduString(pkgs, n as ResRef) || undefined : undefined;
}

/** Item templates by display name, over every package loaded (old name-keyed saves). */
export function itemTemplatesByName(pkgs: EntityPackageSet): Map<string, ResRef[]> {
  const out = new Map<string, ResRef[]>();
  for (const [pkg, p] of pkgs as Map<number, { odu?: { entries: { type: number; group: number; id: number }[] } }>) {
    for (const e of p.odu?.entries ?? []) {
      if (e.type !== 2 || e.group !== 1) continue;
      const r = { pkg, id: e.id };
      const n = itemTemplateName(pkgs, r);
      if (!n) continue;
      const l = out.get(n) ?? [];
      l.push(r);
      out.set(n, l);
    }
  }
  return out;
}

/** Name -> templates resolver for the save providers' migration, built on first use. */
export function byNameOnce(pkgs: EntityPackageSet): (name: string) => ResRef[] {
  let m: Map<string, ResRef[]> | undefined;
  return (name) => (m ??= itemTemplatesByName(pkgs)).get(name) ?? [];
}
