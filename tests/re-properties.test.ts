// Reverse-engineered property names and meanings (src/formats/property-names.ts,
// docs/re/properties.md). The name tests run without game data; the value tests read the
// retail templates and skip without a local install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import { CLASS_BY_NAME, classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { weaponDef } from '../src/game/weapons/data';

const name = (cls: string, i: number) => CLASS_BY_NAME.get(cls)?.propNames[i];

test('RE property names land in the class table', () => {
  assert.equal(name('Missile', 26), 'damage');
  assert.equal(name('Missile', 28), 'forceNear');
  assert.equal(name('BouncingObject', 26), 'damage', 'BouncingObject shares the projectile base');
  assert.equal(name('BouncingObject', 49), 'settleBounces');
  assert.equal(name('Radius Damage', 5), 'radius');
  assert.equal(name('Radius Damage', 2), 'forceCentre');
  assert.equal(name('Melee Weapon', 68), 'damage');
  assert.equal(name('Melee Weapon', 69), 'force');
  assert.equal(name('Combat Music', 1), 'startEnemies');
  assert.equal(name('Combat Music', 11), 'inMakeCurrent');
  assert.equal(name('Message Relay', 3), 'pickMode');
  assert.equal(name('RootPlayAnimBehavior', 4), 'playCount');
  assert.equal(name('Flashlight', 67), 'fullChargeSeconds');
  // Family names reach every member; hand-written names still win.
  assert.equal(name('Breakable', 5), 'immuneToUnlisted');
  assert.equal(name('Unspeakable NPC', 2), 'difficultyModifier');
  assert.equal(name('Message Relay', 8), 'outRelay');
  // Message slots keep working with the new names.
  assert.ok(CLASS_BY_NAME.get('Combat Music')!.inputs.includes(11));
});

let cache: EntityPackageSet | undefined;
function packages(): EntityPackageSet {
  if (cache) return cache;
  const out = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p as unknown as EntityPackage);
  }
  return (cache = out as unknown as EntityPackageSet);
}

function values(pkg: number, id: number): { cls: string; v: PropValue[] } {
  const t = readObjectTemplate(packages(), { pkg, id } as ResRef)!;
  const c = classByHash(t.classHash)!;
  return { cls: c.name, v: decodeTemplateProps(c, t) };
}

test('projectile damage is Missile p26, the falloff is force (RFL 0x100d1921)', { skip }, () => {
  // Revolver 6, tommy gun 4.5, shotgun pellet 4 (x6), Gonzogun 200; guards' bullets 3.
  for (const [id, dmg] of [[6, 6], [256, 4.5], [85, 4], [828, 200]] as const) {
    const m = values(4, id);
    assert.equal(m.cls, 'Missile');
    assert.equal(m.v[26], dmg, `4:${id}`);
  }
  assert.equal(values(10, 1741).v[26], 3);
  const pellet = values(4, 85).v;
  assert.deepEqual([pellet[28], pellet[29], pellet[30], pellet[31], pellet[32]], [20, 2, 4, 20, 13]);
  assert.equal(weaponDef(packages(), { pkg: 4, id: 84 } as ResRef)?.projectile?.damage, 4);
});

test('Radius Damage: p5 radius, p0 / p1 damage, p2 / p3 force (RFL 0x10125c70)', { skip }, () => {
  const rd = (id: number) => values(4, id).v.map((x) => (typeof x === 'number' ? +x.toFixed(3) : x));
  const pick = (v: PropValue[]) => [v[0], v[1], v[2], v[3], v[5], v[10]];
  assert.deepEqual(pick(rd(215)), [40, 10, 20, 8, 13, 3], 'TNT');
  assert.deepEqual(pick(rd(622)), [65, 15, 24, 12, 18, 3], 'Shrapnel Grenade');
  assert.deepEqual(pick(rd(248)), [10, 6, 20, 13, 4, 5], 'Molotov');
  assert.deepEqual(pick(rd(282)), [4, 1, 30, 16, 13, 19], 'Flash/Bang');
});

test('thrown objects: bounce / settle rules (RFL 0x1009a8c0)', { skip }, () => {
  const b = (id: number) => {
    const v = values(4, id).v;
    return [v[49], v[50], v[51], v[54], v[60]];
  };
  assert.deepEqual(b(245), [1, 1, 50, 0, 0], 'Molotov: settles (and goes off) on the first impact');
  assert.deepEqual(b(81), [3, 1, 70, 0, 1], 'TNT: third bounce, or on hitting a character');
  assert.deepEqual(b(621), [2, 1, 75, 0, 1], 'Shrapnel Grenade');
});

test('Combat Music, Flashlight, RootPlayAnimBehavior, Horace: decoded fields', { skip }, () => {
  const pk = packages();
  const all = (cls: string) => {
    const out: PropValue[][] = [];
    for (const [pid, p] of pk as Map<number, EntityPackage>) {
      for (const e of p.odu?.entries ?? []) {
        if (e.type !== 2 || e.group !== 1) continue;
        const t = readObjectTemplate(pk, { pkg: pid, id: e.id } as ResRef);
        const c = t && classByHash(t.classHash);
        if (c?.name === cls) out.push(decodeTemplateProps(c, t!));
      }
    }
    return out;
  };
  // Combat Music: enemy counts are small integers, radii in metres, keep radius >= start radius.
  for (const v of all('Combat Music')) {
    assert.ok([1, 2].includes(v[1] as number));
    assert.ok((v[4] as number) >= (v[2] as number));
    assert.equal(v[3], 0);
  }
  const fl = values(4, 72).v;
  assert.deepEqual([fl[61], fl[67], fl[68]], [0.25, 105, 3], 'dead level, full charge s, dimming s');
  // RootPlayAnimBehavior: p3 in order, p4 plays, p5 time limit.
  for (const v of all('RootPlayAnimBehavior')) assert.ok([0, 1].includes(v[3] as number));
  const h = all('HoraceKillPlayerBehavior')[0];
  assert.deepEqual([h[2], h[3], h[6], h[7]], [6, 350, 21, 21], 'messages Triggered / QuestStart, 21 s');
});
