// Inventory keyed by item template (src/game/world/inventory.ts) and the migration of old
// name-keyed saves (src/game/save/providers.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory, inventoryKey, parseRefKey, type InventoryItem } from '../src/game/world/inventory';
import { inventorySaveProvider, migrateInventoryItems, migrateItemKey, type InventorySaveState } from '../src/game/save/providers';
import { skip, readSrsc, nodeFS } from './helpers';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import type { EntityPackageSet } from '../src/formats/entities';
import { itemTemplateName, itemTemplatesByName } from '../src/game/world/inventory';
import { weaponDef } from '../src/game/weapons/data';

const G655 = { pkg: 4, id: 655 }; // Shrapnel Grenade
const G804 = { pkg: 4, id: 804 }; // Killjoy Rebirth grenade: same display name

test('inventory keys: template "pkg:id", name-only entries under name:', () => {
  assert.equal(inventoryKey(G655, 'Shrapnel Grenade'), '4:655');
  assert.equal(inventoryKey(undefined, 'Xombium Bottle'), 'name:Xombium Bottle');
  assert.deepEqual(parseRefKey('4:804'), G804);
  assert.equal(parseRefKey('Shrapnel Grenade'), undefined);
});

test('inventory: templates sharing a display name stay apart', () => {
  const items = new Map<string, InventoryItem>();
  const inv = createInventory(items);
  inv.add('Shrapnel Grenade', 3, G655, 'Missile Item');
  inv.add('Shrapnel Grenade', 8, G804, 'Missile Item');
  assert.equal(items.size, 2);
  assert.equal(inv.count(G655), 3);
  assert.equal(inv.count(G804), 8);
  assert.equal(inv.count('4:804'), 8, 'by key');
  assert.equal(inv.count('Shrapnel Grenade'), 11, 'a display name sums the entries carrying it');
  // Taking every 4:804 leaves the regular grenades.
  assert.equal(inv.remove(G804), 8);
  assert.equal(inv.has(G804), false);
  assert.equal(items.has('4:804'), false, 'an emptied entry is dropped');
  assert.equal(inv.count(G655), 3);
  assert.equal(inv.remove(G655, 1), 1);
  assert.equal(inv.count(G655), 2);
  assert.equal(inv.remove(G804, 5), 0);
  // Template-less entries (noted pickups) count by name.
  inv.add('Xombium Bottle', 1);
  assert.equal(inv.count('Xombium Bottle'), 1);
  assert.ok(items.has('name:Xombium Bottle'));
});

test('inventory: a bare "pkg:id" name gets the template display name', () => {
  const inv = createInventory(new Map(), (r) => (r.id === 655 ? 'Shrapnel Grenade' : undefined));
  inv.add('4:655', 1, G655, 'Missile Item');
  assert.equal(inv.items.get('4:655')?.name, 'Shrapnel Grenade');
  inv.add('4:999', 1, { pkg: 4, id: 999 });
  assert.equal(inv.items.get('4:999')?.name, '4:999', 'unknown templates keep the key as name');
});

const resolver = (table: Record<string, { pkg: number; id: number }[]>) => (name: string) => table[name] ?? [];
const NAMES = resolver({ 'Shrapnel Grenade': [G655, G804], 'Xombium Bottle': [{ pkg: 4, id: 207 }], Revolver: [{ pkg: 4, id: 5 }] });

test('migration: name-only entries get their template when the name is unique', () => {
  const out = migrateInventoryItems(
    [
      { name: 'Xombium Bottle', count: 2, className: 'Health Bonus Item' },
      { name: 'Shrapnel Grenade', count: 4 },
      { name: 'Revolver', count: 1, template: { pkg: 4, id: 5 } },
      { name: 'Mystery', count: 1 },
    ],
    NAMES,
  );
  assert.deepEqual(out[0].template, { pkg: 4, id: 207 });
  assert.equal(out[1].template, undefined, 'ambiguous name: left as is');
  assert.deepEqual(out[2].template, { pkg: 4, id: 5 });
  assert.equal(out[3].template, undefined);
});

test('migration: weapons-save keys ("pkg:id" kept, unique names mapped, ambiguous dropped)', () => {
  assert.equal(migrateItemKey('4:655', NAMES), '4:655');
  assert.equal(migrateItemKey('Revolver', NAMES), '4:5');
  assert.equal(migrateItemKey('Shrapnel Grenade', NAMES), null);
  assert.equal(migrateItemKey(null, NAMES), null);
  assert.equal(migrateItemKey('Revolver'), null, 'no resolver: names are not guessed');
});

test('inventory provider: an old name-keyed save loads into template keys', () => {
  const items = new Map<string, InventoryItem>();
  const inv = createInventory(items);
  // An old save: the map was keyed by display name, so one entry per name.
  const old: InventorySaveState = {
    items: [
      { name: 'Xombium Bottle', count: 2, className: 'Health Bonus Item' },
      { name: 'Shrapnel Grenade', count: 5, template: G655, className: 'Missile Item' },
      { name: '4:804', count: 1, template: G804 },
    ],
    health: 80,
    maxHealth: 100,
  };
  const p = inventorySaveProvider(inv, () => items.clear(), NAMES);
  p.load(old, { reason: 'load' } as never);
  assert.deepEqual([...items.keys()].sort(), ['4:207', '4:655', '4:804']);
  assert.equal(inv.count({ pkg: 4, id: 207 }), 2);
  assert.equal(inv.count(G655), 5);
  assert.equal(inv.count(G804), 1);
  assert.equal(inv.health, 80);
  // Round trip.
  const saved = p.save();
  items.clear();
  p.load(saved, { reason: 'load' } as never);
  assert.equal(inv.count(G804), 1);
  assert.equal(items.size, 3);
});

test('retail: 4:804 and 4:655 share a display name, both are throwables with their own meters', { skip }, async () => {
  const path = 'LEVELS/5 Asylum/5b Asylum.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const pkgs = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  assert.equal(itemTemplateName(pkgs, G655), itemTemplateName(pkgs, G804));
  const byName = itemTemplatesByName(pkgs).get(itemTemplateName(pkgs, G655)!)!.map((r) => `${r.pkg}:${r.id}`);
  assert.ok(byName.includes('4:655') && byName.includes('4:804'), byName.join(','));
  const a = weaponDef(pkgs, G655)!, b = weaponDef(pkgs, G804)!;
  assert.equal(a.kind, 'throwable');
  assert.equal(b.kind, 'throwable');
  assert.notEqual(`${a.meter?.pkg}:${a.meter?.id}`, `${b.meter?.pkg}:${b.meter?.id}`);
  // The rebirth grenade's blast: Radius Damage 4:805 (21 at the centre and edge, 3.75 m, type 17)
  // besides the zero-damage 4:1439 that carries the victim effect.
  assert.deepEqual(
    b.thrown!.explosions.map((e) => [e.maxDamage, e.outerRadius, e.damageType]),
    [
      [21, 3.75, 17],
      [0, 1, 17],
    ],
  );
  assert.equal(b.thrown!.explosion?.maxDamage, 21);
});
