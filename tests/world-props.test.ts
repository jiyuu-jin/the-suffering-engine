// World props: damage routing (src/game/world/damage.ts) and the chapter-1 breakable data
// the prop runtime relies on (every Breakable's p18 is an Object Generator or empty).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDamageService, damageTypeIndex, type DamageablePropSet } from '../src/game/world/damage';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { parseEntities, readObjectTemplate, className, type EntityPackage } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function fakeProps(): DamageablePropSet & { log: string[] } {
  const log: string[] = [];
  const pos = new Map([
    [1, { x: 0, y: 0, z: 0 }],
    [2, { x: 3, y: 0, z: 0 }],
  ]);
  return {
    log,
    has: (uid) => pos.has(uid),
    uidOfBody: (b) => (b === 7 ? 2 : undefined),
    propAt: (p) => (Math.hypot(p.x, p.y, p.z) < 0.5 ? 1 : undefined),
    propsNear: (p, r) =>
      [...pos]
        .map(([uid, q]) => ({ uid, distance: Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) }))
        .filter((x) => x.distance < r),
    damage: (uid, amount, type) => {
      log.push(`${uid}:${amount.toFixed(1)}:${type}`);
      return { damage: amount, killed: amount >= 10 };
    },
  };
}

test('damage routes to props by target, body, point and radius; actors through services.actors', () => {
  const props = fakeProps();
  const hitActors: string[] = [];
  const actor = { entity: { uid: 99 }, position: { x: 1, y: 0, z: 0 }, alive: true };
  const svc = createDamageService(props, () => ({
    list: () => [actor],
    get: (uid: number) => (uid === 99 ? actor : undefined),
    damage: (_a: unknown, amount: number) => (hitActors.push(amount.toFixed(1)), false),
  }));
  svc.apply({ point: { x: 9, y: 9, z: 9 }, amount: 12, kind: 'bullet', targetUid: 1 });
  svc.apply({ point: { x: 9, y: 9, z: 9 }, amount: 5, kind: 'melee', body: 7 });
  svc.apply({ point: { x: 0.1, y: 0, z: 0 }, amount: 3 });
  svc.apply({ point: { x: 9, y: 9, z: 9 }, amount: 4, targetUid: 99 });
  const r = svc.apply({ point: { x: 0, y: 0, z: 0 }, amount: 20, kind: 'explosion', radius: 4 });
  // Damage types per DAMAGE_TYPE (decoded from weapon templates): bullet 1, melee 10, explosion 3.
  assert.deepEqual(props.log, ['1:12.0:1', '2:5.0:10', '1:3.0:0', '1:20.0:3', '2:5.0:3']);
  assert.equal(hitActors[0], '4.0');
  assert.equal(r.hits.filter((h) => h.kind === 'actor').length, 1);
  assert.equal(damageTypeIndex(6), 6);
});

test('damage to actors carries its source: player, attacking actor or hazard uid', () => {
  const victim = { entity: { uid: 99 }, position: { x: 0, y: 0, z: 0 }, alive: true };
  const shooter = { entity: { uid: 50 }, position: { x: 5, y: 0, z: 0 }, alive: true };
  const seen: unknown[] = [];
  const svc = createDamageService(fakeProps(), () => ({
    list: () => [victim, shooter],
    get: (uid: number) => (uid === 99 ? victim : uid === 50 ? shooter : undefined),
    damage: (_a: unknown, _n: number, _from?: unknown, by?: unknown) => (seen.push(by), false),
  }));
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 1, targetUid: 99 });
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 1, targetUid: 99, source: 'player' });
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 1, targetUid: 99, source: 50 });
  svc.apply({ point: { x: 0, y: 1, z: 0 }, amount: 1, targetUid: 99, source: 0x1234 });
  assert.deepEqual(seen, ['player', 'player', shooter, 0x1234]);
});

test('chapter 1 breakables: p18 spawns an Object Generator (or nothing)', { skip }, () => {
  const packages = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || packages.has(id)) continue;
    const base = db.slice(0, -3);
    const load = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    packages.set(id, { id, name: base, odu: load(`${base}.odu`), xdu: load(`${base}.xdu`), qdu: load(`${base}.qdu`) } as EntityPackage);
  }
  let n = 0;
  for (const l of ['1a', '1b', '1c']) {
    const lvl = readSrsc(`LEVELS/1 PrisonDeathRow/${l} PrisonDeathRow.lvl`);
    for (const e of parseEntities(lvl, packages)) {
      if (e.className !== 'Breakable') continue;
      n++;
      const r = e.values[18] as { pkg: number; id: number } | null;
      if (!r) continue;
      const t = readObjectTemplate(packages, r);
      assert.equal(t && className(t.classHash), 'Object Generator', `Breakable ${e.uid.toString(16)} p18`);
    }
  }
  assert.equal(n, 676);
});
