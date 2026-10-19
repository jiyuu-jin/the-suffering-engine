// Weapons, hardpoints and NPC hand weapons (src/game/weapons; docs/game-logic.md §4.4 / §7.1).
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import type { EntityPackage, EntityPackageSet } from '../src/formats/entities';
import { readDbId, type PackageSet } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { splashAmount } from '../src/game/world/damage';
import { bounceHit, bounceSound, explosionDamage, flashlightLampOn, holdsFlashlight, projectileDamage, projectileForce, weaponDef } from '../src/game/weapons/data';
import { hardpointTable } from '../src/game/weapons/hardpoints';
import { npcWeaponSlots } from '../src/game/weapons/npc';

let cache: EntityPackageSet | undefined;
function packages(): EntityPackageSet {
  if (cache) return cache;
  const out = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu']) {
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

test('radius damage: Radius Damage falloff (inner / min) and the linear default', () => {
  const tnt = { point: { x: 0, y: 0, z: 0 }, amount: 40, minAmount: 10, innerRadius: 8, radius: 20 };
  assert.equal(splashAmount(tnt, 0), 40);
  assert.equal(splashAmount(tnt, 8), 40);
  assert.equal(splashAmount(tnt, 14), 25);
  assert.equal(splashAmount(tnt, 20), 0);
  const linear = { point: { x: 0, y: 0, z: 0 }, amount: 30, radius: 6 };
  assert.equal(splashAmount(linear, 3), 15);
  assert.equal(splashAmount(linear, 7), 0);
});

test('hardpoint (channel) tables of the player and guard rigs', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  const player = hardpointTable(pkgs, { pkg: 2, id: 9 });
  assert.equal(player[16], 35, 'player channel 16 = right-hand weapon bone');
  assert.equal(player[11], 27, 'player channel 11 = left-hand bone');
  assert.deepEqual([player[22], player[23]], [55, 59], 'feet (Torque\'s shoes)');
  const guard = hardpointTable(pkgs, { pkg: 10, id: 44 });
  assert.equal(guard[19], 35, 'guard channel 19 = right-hand weapon bone (door guard magazine)');
});

test('chapter 1 weapon stats decode from the templates', { skip }, () => {
  const pkgs = packages();
  const d = (id: number) => {
    const w = weaponDef(pkgs, { pkg: 4, id });
    assert.ok(w, `weapon 4:${id}`);
    return w;
  };
  const rev = d(5);
  assert.equal(rev.kind, 'ranged');
  assert.equal(rev.clipSize, 6);
  assert.deepEqual(rev.ammo, { pkg: 4, id: 230 });
  // Missile p26 is the damage (RFL 0x100d1921), p28..p31 the impact force falloff.
  assert.equal(rev.projectile?.damage, 6);
  assert.deepEqual(rev.upgrade, { pkg: 4, id: 12 }, 'second revolver -> Dual Revolvers');
  const sg = d(84);
  assert.equal(sg.projectile?.count, 6);
  assert.equal(projectileDamage(sg.projectile!, 2), 4, 'shotgun pellet: 4 damage at any range');
  assert.equal(projectileDamage(sg.projectile!, 30), 4);
  assert.equal(projectileForce(sg.projectile!, 2), 20, 'pellet force 20 up to 4 m');
  assert.equal(projectileForce(sg.projectile!, 30), 2, 'pellet force 2 from 20 m');
  assert.equal(d(260).projectile?.damage, 4.5, 'tommy gun round');
  assert.equal(d(826).projectile?.damage, 200, 'Gonzogun round');
  const tg = d(260);
  assert.equal(tg.auto, true);
  assert.equal(tg.clipSize, 48);
  const shiv = d(79);
  assert.equal(shiv.kind, 'melee');
  // Melee Weapon p68 damage, p69 impact force (RFL 0x100ca920).
  assert.deepEqual([shiv.damageMin, shiv.damageMax, shiv.force, shiv.damageType], [8, 8, 10, 10]);
  assert.deepEqual(shiv.pwp?.attacks.map((a) => +a.mult.toFixed(3)), [1, 1.2, 1.5]);
  assert.equal(shiv.pwp?.attacks.length, 3);
  const tnt = d(236);
  assert.equal(tnt.kind, 'throwable');
  // Radius Damage (RFL 0x10125c70): p0 40 at the centre to p1 10 at p5 13 m; force p2 20 -> p3 8.
  const ex = tnt.thrown!.explosion!;
  assert.deepEqual([ex.outerRadius, ex.maxDamage, ex.minDamage, ex.maxForce, ex.minForce, ex.damageType], [13, 40, 10, 20, 8, 3]);
  assert.equal(explosionDamage(ex, 6.5), 25);
  assert.equal(explosionDamage(ex, 13), 0);
  assert.deepEqual([tnt.thrown?.bounces, tnt.thrown?.settleDelay, tnt.thrown?.hitDetonates], [3, 0, true]);
  const molotov = d(249).thrown!;
  assert.deepEqual([molotov.bounces, molotov.anySurfaceBounces, molotov.settleDelay, molotov.explosion?.outerRadius], [1, true, 0, 4], 'the Molotov breaks on its first impact');
  assert.equal(d(455).thrown?.explosion, undefined, 'the flare has no Radius Damage');
});

test('NPC hand weapons: guards hold the revolver on bone 35 (Character p51 / p52)', { skip }, () => {
  const pkgs = packages() as unknown as PackageSet;
  const guard = npcWeaponSlots(pkgs, { kind: { template: { pkg: 10, id: 447 } } } as never);
  assert.deepEqual(guard.map((s) => [s.bone, `${s.weapon.pkg}:${s.weapon.id}`, s.model && `${s.model.pkg}:${s.model.id}`]), [[35, '10:1802', '4:15']]);
  const ernesto = npcWeaponSlots(pkgs, { kind: { template: { pkg: 10, id: 1020 } } } as never);
  assert.deepEqual(ernesto.map((s) => `${s.weapon.pkg}:${s.weapon.id}`), ['4:260']);
});

// ---------------------------------------------------------------------------------------------
// BouncingObject bounces and their sounds (RFL 0x1009a8c0; data.ts bounceHit / bounceSound)

const BO = { bounces: 3, anySurfaceBounces: false, bounceSounds: ['4:32', '4:50'], hardBounceSounds: ['4:51'], hardSurface: 0.5, restitution: 0.3 };

test('bounce rule: every hit counts; at p49 a floor (or any hit with p50) settles, a wall is taken back', () => {
  assert.deepEqual(bounceHit(BO, 0, 0), { count: 1, settle: false }, 'walls count before p49');
  assert.deepEqual(bounceHit(BO, 1, 1), { count: 2, settle: false });
  assert.deepEqual(bounceHit(BO, 2, 0.2), { count: 2, settle: false }, 'the p49th hit on a wall is taken back');
  assert.deepEqual(bounceHit(BO, 2, 0.75), { count: 3, settle: true }, 'floor: normal within 45 degrees of up');
  assert.deepEqual(bounceHit(BO, 2, 0.7), { count: 2, settle: false }, 'steeper than 45 degrees is a wall');
  assert.deepEqual(bounceHit({ ...BO, anySurfaceBounces: true }, 2, 0), { count: 3, settle: true });
  assert.deepEqual(bounceHit({ ...BO, bounces: 0 }, 9, 1), { count: 10, settle: false }, 'p49 = 0 never settles');
});

test('bounce sound: p63 on surfaces at least p56 hard, else p62; volume k^(count - 1)', () => {
  assert.deepEqual(bounceSound(BO, undefined, 1), { keys: ['4:32', '4:50'], volume: 1 }, 'no surface record: p62');
  assert.deepEqual(bounceSound(BO, { hardness: 0.3, damping: 0 }, 1).keys, ['4:32', '4:50']);
  assert.deepEqual(bounceSound(BO, { hardness: 0.5, damping: 0 }, 1).keys, ['4:51']);
  assert.deepEqual(bounceSound(BO, { hardness: 1, damping: 0 }, 1).keys, ['4:51']);
  // k = (1 - p4 %) x (1 - p51 %): 0.5 x 0.3 on a 50 % surface.
  assert.ok(Math.abs(bounceSound(BO, { hardness: 1, damping: 50 }, 3).volume - 0.15 ** 2) < 1e-9);
  assert.equal(bounceSound({ ...BO, bounceSounds: [], hardBounceSounds: [] }, undefined, 1).keys.length, 0, 'no list: silent (and no p64 noise)');
});

test('retail bounce sounds: the casings clink, no throwable has bounce sounds', { skip }, () => {
  const pkgs = packages();
  const d = (id: number) => weaponDef(pkgs, { pkg: 4, id })!;
  const revolverCasing = d(5).casingObject!;
  assert.deepEqual(revolverCasing.bounceSounds, ['4:32', '4:50', '4:51', '4:50', '4:51']);
  assert.equal(revolverCasing.hardSurface, 0.5);
  assert.deepEqual([revolverCasing.bounces, revolverCasing.anySurfaceBounces, revolverCasing.settleDelay, revolverCasing.gravityPct], [3, true, 1, 50]);
  assert.deepEqual(d(84).casingObject!.hardBounceSounds, ['4:209', '4:210'], 'shotgun shells: p63 only');
  assert.deepEqual(d(84).casingObject!.bounceSounds, []);
  for (const id of [284, 249, 655, 236, 455, 804]) {
    const t = d(id).thrown!;
    assert.deepEqual([...t.bounceSounds, ...t.hardBounceSounds], [], `throwable 4:${id}`);
    assert.equal(t.bounceNoise, undefined);
  }
});

test('flashlight: no lamp without a Flashlight item; switched on when received (RFL 0x10007d50, 0x10038fee)', () => {
  const classOf = (r: { pkg: number; id: number }) => (r.pkg === 4 && r.id === 72 ? 'Flashlight' : r.pkg === 4 && r.id === 203 ? 'Item' : undefined);
  const batteries = { name: 'Flashlight Batteries', count: 2, template: { pkg: 4, id: 203 } };
  const lamp = { name: 'Flashlight', count: 1, template: { pkg: 4, id: 72 } };
  assert.equal(holdsFlashlight([], classOf), false);
  assert.equal(holdsFlashlight([batteries], classOf), false, 'batteries are not a flashlight');
  assert.equal(holdsFlashlight([batteries, lamp], classOf), true);
  assert.equal(holdsFlashlight([{ name: 'Flashlight', count: 1, className: 'Flashlight' }], classOf), true);
  assert.equal(holdsFlashlight([{ ...lamp, count: 0 }], classOf), false);
  // 1a: the level starts without one -> off, whatever the renderer's default.
  assert.equal(flashlightLampOn(false, null, true), false);
  // Picked up: on.
  assert.equal(flashlightLampOn(true, false, false), true);
  // Held already: the player's choice stays (switched off stays off).
  assert.equal(flashlightLampOn(true, true, false), false);
  assert.equal(flashlightLampOn(true, true, true), true);
  // Carried in / loaded on the first frame: its state is kept.
  assert.equal(flashlightLampOn(true, null, false), false);
});
