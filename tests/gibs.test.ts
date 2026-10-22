// Corpse blows (src/game/actors/gibs.ts, docs/game-logic.md §15.16 "Gibs"), decoded from
// Suffering.rfl 0x100e6480 (the hit reaction on a dead body), 0x100e5d00 (the death reaction),
// 0x100e30d0 / 0x100e2f70 (the gib).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpseBlowKind, readGibRule, readThrownBody, throwDirection } from '../src/game/actors/gibs';
import { readDbId } from '../src/formats/model';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage } from '../src/formats/entities';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

const R = (pkg: number, id: number) => ({ pkg, id });

test('the dead hit reaction: types 3 / 8 with p117; explosions throw a body with p112, the rest gib', () => {
  const v: unknown[] = [];
  assert.equal(readGibRule(v as never), undefined, 'no p117: blows on the corpse do nothing');
  v[112] = R(10, 487);
  v[113] = R(10, 442);
  v[114] = 30;
  v[116] = 6;
  v[117] = R(3, 2834);
  const r = readGibRule(v as never)!;
  assert.deepEqual([r.bone, r.elevation, r.gib, r.body], [6, 30, R(3, 2834), R(10, 487)]);
  assert.equal(corpseBlowKind(r, 3, true), 'throw');
  assert.equal(corpseBlowKind(r, 3, false), undefined, 'the throw needs the attacker (0x100e5dc6)');
  assert.equal(corpseBlowKind(r, 8, true), 'gib', 'Gonzo / claws');
  assert.equal(corpseBlowKind(r, 1, true), undefined, 'bullets: nothing');
  assert.equal(corpseBlowKind({ ...r, body: undefined }, 3, true), 'gib', 'an explosion without p112 gibs');
});

test('throw direction: attacker -> body, raised to p114 above the horizontal when lower', () => {
  const d = throwDirection({ x: 0, y: 1, z: 0 }, { x: -5, y: 1, z: 0 }, 30);
  assert.ok(Math.abs(d.x - Math.cos(Math.PI / 6)) < 1e-9 && Math.abs(d.y - 0.5) < 1e-9 && Math.abs(d.z) < 1e-9);
  const up = throwDirection({ x: 0, y: 5, z: 0 }, { x: -1, y: 0, z: 0 }, 30);
  assert.ok(up.y > 0.9, 'steeper than p114: kept');
  assert.ok(Math.abs(up.length() - 1) < 1e-9);
});

function loadAllPackages(): Map<number, EntityPackage> {
  const pk = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`) } as EntityPackage);
  }
  return pk;
}

test('retail: the guard is thrown 12 m/s for 5 s and bursts into 3:2834 at his chest; CartWheelers likewise', { skip }, () => {
  const pk = loadAllPackages();
  const values = (pkg: number, id: number) => {
    const t = readObjectTemplate(pk, R(pkg, id))!;
    return decodeTemplateProps(classByHash(t.classHash)!, t);
  };
  const guard = readGibRule(values(10, 3))!;
  assert.deepEqual([guard.body, guard.bodyClip, guard.elevation, guard.bone, guard.gib], [R(10, 487), R(10, 442), 30, 6, R(3, 2834)]);
  const tb = readThrownBody(pk, guard.body)!;
  assert.ok(Math.abs(tb.speed - 25000 / 2048) < 1e-9);
  assert.deepEqual([tb.life, tb.burst, tb.bone], [5, [R(3, 2834)], 6]);
  const cw = readGibRule(values(10, 24))!;
  assert.deepEqual([cw.body, cw.bone, cw.gib], [R(10, 99), 3, R(3, 2966)]);
  assert.deepEqual(readThrownBody(pk, cw.body)!.burst, [R(3, 2966)]);
  // The Fester (2:922) has no p112: an explosion gibs it.
  const fester = readGibRule(values(2, 922))!;
  assert.equal(corpseBlowKind(fester, 3, true), 'gib');
});
