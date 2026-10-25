// The insanity morphs (Player state 19, docs/game-logic.md §13.10): the lead-in clip, the
// Character Morpher's cross-fade, the slowed clock, and the held gun kept through the creature
// form. Data checks use the local install (skipped without one) and assert decoded relations,
// not specific values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, readSrsc, skip } from './helpers';
import type { EntityPackage } from '../src/formats/entities';
import type { Character } from '../src/app/character';
import type { PackageSet } from '../src/formats/model';
import { readAnimation, readAnimEvents } from '../src/formats/animation';
import { readInsanityParams } from '../src/game/insanity/params';
import { defaultPersist, InsanityModel, morpherFade } from '../src/game/insanity/rules';
import { MORPH_CHARACTER } from '../src/game/insanity/creature';
import { HardpointAttacher } from '../src/game/weapons/hardpoints';

function systemPackages() {
  const pkgs = new Map<number, EntityPackage & { adu?: ReturnType<typeof readSrsc> }>();
  const base = 'COMMON/System/System';
  if (existsSync(join(DATA_ROOT, base + '.odu'))) pkgs.set(2, { id: 2, name: 'System', odu: readSrsc(base + '.odu'), adu: readSrsc(base + '.adu') } as never);
  return pkgs;
}

test('morph: the Character Morpher cross-fade (0x10010510): new form in to 0.5, then the old one out', () => {
  // Cosine ease (p5 = 1): e = 1 - (cos(pi u) + 1) / 2.
  assert.deepEqual(morpherFade(0, 1.2), { from: 1, to: 0, e: 0 });
  const q = morpherFade(0.3, 1.2);
  assert.equal(q.from, 1);
  assert.ok(Math.abs(q.to - (1 - (Math.cos(Math.PI * 0.25) + 1) / 2)) < 1e-9);
  const half = morpherFade(0.6, 1.2);
  assert.ok(Math.abs(half.to - 0.5) < 1e-9 && half.from === 1, 'at the middle: old 1, new 0.5');
  const late = morpherFade(0.9, 1.2);
  assert.equal(late.to, 1);
  assert.ok(Math.abs(late.from - (1 - late.e)) < 1e-9 && late.from < 0.5);
  assert.deepEqual(morpherFade(1.2, 1.2), { from: 0, to: 1, e: 1 });
  // Linear without p5.
  assert.ok(Math.abs(morpherFade(0.3, 1.2, false).to - 0.25) < 1e-9);
});

test('morph: lead-in clips carry the MorphCharacter marker; the lead-in ends with the morpher', { skip }, () => {
  const pkgs = systemPackages();
  const params = readInsanityParams(pkgs as never)!;
  const adu = pkgs.get(2)!.adu!;
  for (const [form, to] of [[params.human, params.creature!], [params.creature!, params.human]] as const) {
    assert.ok(form.morphLead, 'p254 names a clip');
    assert.ok(form.morph && form.morph.duration > 0 && form.morph.cosine, 'p255 Character Morpher with p4 and the cosine ease');
    assert.ok(form.morphClockDiv > 1, 'p272 slows the clock');
    const clip = readAnimation(adu, form.morphLead!.id)!;
    const mark = readAnimEvents(adu, form.morphLead!.id)!.events.find((e) => e.kind === 1 && e.param === MORPH_CHARACTER);
    assert.ok(mark, 'MorphCharacter (220) in the lead-in');
    // The lead-in runs on the old form's rig; its marker plus the morpher's p4 is the clip's
    // length: the old form ends its clip as the morpher swaps the model.
    assert.ok(Math.abs(mark!.time + form.morph!.duration - clip.duration / (clip.rate || 1)) < 0.02, `lead-in ${form.morphLead!.id}`);
    // The morpher's model is the other form's.
    assert.deepEqual(form.morph!.model, to.model);
  }
});

test('morph: real-time length (lead-in + p4), the clock at 1 / p272, no drain while morphing', { skip }, () => {
  const params = readInsanityParams(systemPackages() as never)!;
  const m = new InsanityModel(params, defaultPersist());
  m.morphLead.morphIn = 0.5;
  m.morphLead.morphOut = 2;
  const out = 2 + params.creature!.morph!.duration;
  assert.equal(m.clockRate, 1);
  m.forceTransform();
  assert.equal(m.form, 'morphIn');
  assert.ok(Math.abs(m.clockRate - 1 / params.human.morphClockDiv) < 1e-9);
  // Game time barely moves (dt x 1 / p272) but the morph runs on real time.
  const step = (form: string, seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) m.update(0.05 * m.clockRate, 0.05);
    assert.equal(m.form, form);
  };
  step('morphIn', 0.5 + params.human.morph!.duration - 0.1);
  step('creature', 0.2);
  assert.equal(m.clockRate, 1);
  m.setMeter(m.max);
  assert.equal(m.pressInsanity(), true);
  assert.equal(m.form, 'morphOut');
  assert.equal(m.morphLeft, out);
  const meter = m.s.meter;
  step('morphOut', out - 0.1);
  assert.equal(m.s.meter, meter, 'the meter does not drain during the morph (state 19)');
  step('human', 0.2);
  assert.equal(m.clockRate, 1);
  // A cinematic's change back is instant (0x10033440: morpher finished at once).
  m.forceTransform();
  m.revert(false, true);
  assert.equal(m.form, 'human');
});

function carrier(scene: THREE.Scene): Character {
  const root = new THREE.Group();
  const hand = new THREE.Bone();
  root.add(hand);
  scene.add(root);
  return { root, skeleton: { bones: [hand] } } as unknown as Character;
}

test('morph: the held gun stays attached while the creature form takes the body out of the player', () => {
  const scene = new THREE.Scene();
  const body = carrier(scene), npc = carrier(scene);
  const at = new HardpointAttacher(new Map() as unknown as PackageSet);
  const gun = new THREE.Object3D(), club = new THREE.Object3D();
  body.root.add(gun);
  scene.add(club);
  assert.ok(at.attach(gun, body, { bone: 0 }, undefined, { keep: true }));
  assert.ok(at.attach(club, npc, { bone: 0 }));
  // The creature form: the body leaves the player's root for a while (PlayerController.setModel).
  body.root.removeFromParent();
  npc.root.removeFromParent();
  at.update();
  assert.equal(at.isAttached(gun), true, 'kept');
  assert.equal(at.isAttached(club), false, 'a removed carrier still releases what it held');
  // Back to human: the hand's pose drives the gun again.
  scene.add(body.root);
  body.skeleton.bones[0].position.set(0.3, 1.1, -0.2);
  at.updateCarriers(body);
  gun.updateWorldMatrix(true, false);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(gun.matrixWorld).distanceTo(new THREE.Vector3(0.3, 1.1, -0.2)) < 1e-6);
});
