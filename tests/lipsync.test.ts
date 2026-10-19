// Lip-sync: envelope sampling / angle mapping (pure) and, with game data, that every
// Character template's jaw property resolves to the jaw bone of its model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_ROOT, readSrsc, skip } from './helpers';
import { JAW_BONE_HASH, jawAngle, jawConfig, sampleEnvelope } from '../src/app/lipsync';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage } from '../src/formats/entities';
import { ODU_OBJECT, readDbId } from '../src/formats/model';
import { readSkeleton } from '../src/formats/skeleton';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('envelope sampling interpolates between frame centres and closes after the end', () => {
  const env = { fps: 25, values: Float32Array.from([0, 1, 0.5]) };
  assert.equal(sampleEnvelope(env, 0), 0);
  assert.equal(sampleEnvelope(env, 0.06), 1); // centre of frame 1
  assert.ok(Math.abs(sampleEnvelope(env, 0.04) - 0.5) < 1e-6);
  assert.equal(sampleEnvelope(env, 0.11), 0.5);
  assert.equal(sampleEnvelope(env, 0.13), 0);
  assert.equal(sampleEnvelope(env, -1), 0);
});

test('jaw angle follows the engine mapping (raw * 4e-5 * max degrees)', () => {
  const deg = (jawAngle(1, 10) * 180) / Math.PI;
  assert.ok(Math.abs(deg - 0x7fff * 4e-5 * 10) < 1e-6);
  assert.equal(jawAngle(0, 10), 0);
});

test('Character templates with a jaw point at the jaw bone of their model', { skip }, () => {
  const base = 'COMMON/NPCs/NPCs';
  const id = readDbId(readFileSync(join(DATA_ROOT, `${base}.db`), 'latin1'))!;
  const pkg: EntityPackage = { id, mdu: readSrsc(`${base}.mdu`), odu: readSrsc(`${base}.odu`) };
  const pkgs = new Map([[id, pkg]]);
  let withJaw = 0;
  for (const e of pkg.odu!.entries) {
    if (e.type !== ODU_OBJECT) continue;
    const t = readObjectTemplate(pkgs, { pkg: id, id: e.id });
    const cls = t && classByHash(t.classHash);
    if (!t || !cls || cls.family !== 'Character' || t.modelRef?.pkg !== id) continue;
    const skel = readSkeleton(pkg.mdu!, t.modelRef.id);
    if (!skel) continue;
    const values = decodeTemplateProps(cls, t);
    const cfg = jawConfig(skel, { family: 'Character', className: cls.name, values });
    if ((values[0x76] as number) < 0) {
      assert.equal(cfg, null);
      continue;
    }
    if (!cfg) continue;
    withJaw++;
    assert.equal(skel.bones[cfg.bone].hash, JAW_BONE_HASH);
    assert.ok(cfg.axis >= 0 && cfg.axis <= 2);
    assert.ok(cfg.maxDegrees >= 5 && cfg.maxDegrees <= 20);
  }
  assert.ok(withJaw >= 30, `only ${withJaw} templates with a jaw`);
});
