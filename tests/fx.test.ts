// Effects & audio ambience (src/game/fx): reverb template decoding and the chapter-1 data the
// fx system relies on (material -> Material Type lookups, footstep / impact tables, Ambient
// Sound reverb templates, Camera Shake templates).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reverbParams } from '../src/game/fx/reverb';
import { Surfaces, refKey } from '../src/game/fx/surfaces';
import { parseEntities, type EntityPackage, type PropValue } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

test('Reverb Effect Template words decode as I3DL2 values (signed mB, seconds)', () => {
  // 3:3714 as stored: p2 = -1000 mB, p3 = -476, p7 = -789, p9 = -289 (u32 words).
  const v: PropValue[] = [7, 75, 4294966296, 4294966820, 0, 4.3, 0.59, 4294966507, 0.02, 4294967007, 0.03, 100, 100, 5000];
  const p = reverbParams('3:3714', v);
  assert.equal(p.room, -1000);
  assert.equal(p.roomHF, -476);
  assert.equal(p.reflections, -789);
  assert.equal(p.reverb, -289);
  assert.equal(p.decay, 4.3);
  assert.equal(p.hfReference, 5000);
});

function packages() {
  const pk = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const load = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: load(`${base}.odu`), xdu: load(`${base}.xdu`), qdu: load(`${base}.qdu`) } as EntityPackage);
  }
  return pk;
}

test('chapter 1 fx data: footstep / impact tables, zones, shakes', { skip }, () => {
  const pk = packages();
  const s = new Surfaces(pk, undefined, () => null);
  const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);
  // Player p145: Player Material Effects keyed by Material Type, with an untyped default.
  const player = s.template({ pkg: 2, id: 5 })!;
  const list = player.values[145];
  assert.ok(Array.isArray(list) && list.length >= 10);
  assert.ok(s.pick(list, null), 'default entry');
  assert.equal(s.pick(list, '2:900')?.cls, 'Player Material Effects');
  // Materials resolve to a Material Type through Game Material Properties (word 0).
  assert.equal(s.typeOfMaterial('2:577'), '2:888');
  let zones = 0, shakes = 0, flying = 0;
  for (const l of ['1a', '1b', '1c']) {
    const lvl = readSrsc(`LEVELS/1 PrisonDeathRow/${l} PrisonDeathRow.lvl`);
    for (const e of parseEntities(lvl, pk)) {
      if (e.className === 'Ambient Sound') {
        zones++;
        for (const i of [9, 14]) if (e.values[i]) assert.equal(s.template(e.values[i] as ResRef)?.cls, 'Reverb Effect Template', `${e.uid.toString(16)} p${i}`);
        assert.ok(e.scale, 'zone has a box (instance scale)');
      } else if (e.className === 'Camera Shake') {
        shakes++;
        assert.ok((e.values[2] as number) > 0, 'shake duration');
      } else if (e.className === 'Flying Sound') {
        flying++;
        assert.ok(Array.isArray(e.values[3]) && (e.values[3] as unknown[]).length > 0);
      } else if (e.className === 'Level Properties' && isRef(e.values[27])) {
        assert.equal(s.template(e.values[27] as ResRef)?.cls, 'Reverb Effect Template');
      }
    }
  }
  assert.ok(zones >= 23 && shakes >= 10 && flying >= 3, `${zones} zones, ${shakes} shakes, ${flying} flying`);
  // Bullet impacts: the revolver projectile's Missile Material Effects (p41) has typed entries.
  const missile = s.template({ pkg: 4, id: 6 })!;
  const entry = s.pick(missile.values[41], '2:891');
  assert.equal(entry?.cls, 'Missile Material Effects');
  assert.equal(refKey(entry!.values[0] as ResRef), '2:891');
});
