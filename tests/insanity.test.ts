// Insanity rules against the local game install's Player templates (skipped without one).
// Checks the decoded behaviour, not specific data values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, readSrsc, skip } from './helpers';
import type { EntityPackage } from '../src/formats/entities';
import { readInsanityParams } from '../src/game/insanity/params';
import { defaultPersist, InsanityModel } from '../src/game/insanity/rules';

function systemPackages() {
  const pkgs = new Map<number, EntityPackage>();
  const base = 'COMMON/System/System';
  if (existsSync(join(DATA_ROOT, base + '.odu'))) pkgs.set(2, { id: 2, name: 'System', odu: readSrsc(base + '.odu') } as EntityPackage);
  return pkgs;
}

test('insanity: meter fills from kills, transform needs a full meter, drains while transformed', { skip }, () => {
  const params = readInsanityParams(systemPackages());
  assert.ok(params?.creature, 'Player template with a creature form');
  const m = new InsanityModel(params!, defaultPersist());
  const h = params!.human;
  // Not full: the key does nothing.
  m.setMeter(h.meterMax - 5);
  assert.equal(m.pressInsanity(), false);
  // A kill adds p66 x reputation scale (neutral reputation: midpoint of p80/p81).
  const before = m.s.meter;
  const gain = m.onKill({ points: 4, reputation: 0 });
  assert.ok(Math.abs(gain - 4 * (h.gainScale[0] + h.gainScale[1]) / 2) < 1e-6);
  assert.equal(m.s.meter, Math.min(h.meterMax, before + gain));
  // Second kill inside the combo window gets the x2 multiplier (p260).
  m.setMeter(0);
  const g2 = m.onKill({ points: 4, reputation: 0 });
  assert.ok(Math.abs(g2 - gain * h.combo2) < 1e-6);
  // Gain blocked by the Allow object bit, reputation still counts.
  m.s.noGain = true;
  assert.equal(m.onKill({ points: 10, reputation: -3 }), 0);
  assert.equal(m.s.reputation, -3);
  m.s.noGain = false;
  m.s.reputation = 0;
  // Full meter: transform, morph, drain, change back on the key.
  m.setMeter(h.meterMax);
  assert.equal(m.available, true);
  assert.equal(m.pressInsanity(), true);
  assert.equal(m.form, 'morphIn');
  m.update(h.morph!.duration + 0.01);
  assert.equal(m.form, 'creature');
  const full = m.s.meter;
  m.update(1);
  assert.ok(Math.abs(full - m.s.meter - m.drainRate) < 1e-6, 'drains p82..p83 per second');
  assert.equal(m.pressInsanity(), true);
  assert.equal(m.form, 'morphOut');
  m.update(params!.creature!.morph!.duration + 0.01);
  assert.equal(m.form, 'human');
  // Empty meter while transformed drains health at the creature template's p257.
  let drained = 0;
  m.events.drainHealth = (a) => (drained += a);
  m.forceTransform();
  m.update(h.morph!.duration + 0.01);
  m.setMeter(0);
  m.update(1);
  assert.ok(Math.abs(drained - params!.creature!.healthDrain) < 1e-6);
});

test('insanity: kills in the air get the p262 multiplier', { skip }, () => {
  const params = readInsanityParams(systemPackages())!;
  const h = params.human;
  const m = new InsanityModel(params, defaultPersist());
  const ground = m.onKill({ points: 4, reputation: 0 });
  m.comboTimer = 0;
  m.comboCount = 0;
  const air = m.onKill({ points: 4, reputation: 0, airborne: true });
  assert.ok(Math.abs(air - ground * h.flagMult) < 1e-6);
});

test('insanity: kills while transformed acquire the p276 attacks in order and persist', { skip }, () => {
  const params = readInsanityParams(systemPackages())!;
  const m = new InsanityModel(params, defaultPersist());
  const attacks = m.attacks;
  assert.ok(attacks.length >= 2, 'Insanity Attack Templates');
  assert.ok(attacks.every((a, i) => i === 0 || a.threshold >= attacks[i - 1].threshold), 'thresholds rise');
  const got: number[] = [];
  m.events.acquire = (a) => got.push(a.index);
  m.forceTransform();
  m.update(params.human.morph!.duration + 0.01);
  assert.equal(m.form, 'creature');
  assert.equal(m.currentAttack, undefined);
  // Points below the first threshold do not acquire anything (first threshold is 1 in retail data).
  m.onKill({ points: attacks[0].threshold, reputation: 0 });
  assert.equal(m.s.attackIndex, 0);
  assert.equal(m.s.attackPoints, 0, 'acquisition resets the points');
  assert.equal(m.currentAttack, attacks[0]);
  m.onKill({ points: attacks[1].threshold - 1, reputation: 0 });
  assert.equal(m.s.attackIndex, 0);
  // The points survive a change back and a new transformation.
  m.revert(false, true);
  m.forceTransform();
  m.update(params.human.morph!.duration + 0.01);
  m.onKill({ points: 1, reputation: 0 });
  assert.equal(m.s.attackIndex, 1);
  assert.deepEqual(got, [0, 1]);
  // Human kills fill the meter instead.
  m.revert(false, true);
  m.onKill({ points: 1000, reputation: 0 });
  assert.equal(m.s.attackIndex, 1);
});

test('insanity: put-away delays the morph; the low-meter event fires once', { skip }, () => {
  const params = readInsanityParams(systemPackages())!;
  const m = new InsanityModel(params, defaultPersist());
  let putAway = 0;
  const events: number[] = [];
  m.events.putAway = (s) => (putAway = s);
  m.events.playerEvent = (n) => events.push(n);
  m.setMeter(m.max);
  assert.equal(m.pressInsanity({ putAway: 2 }), true);
  assert.equal(putAway, 2);
  assert.equal(m.form, 'human');
  m.update(1.9);
  assert.equal(m.form, 'human');
  m.update(0.2);
  assert.equal(m.form, 'morphIn');
  m.update(params.human.morph!.duration + 0.01);
  m.setMeter(m.max);
  m.update(1000);
  assert.deepEqual(events, [9]);
  m.setMeter(m.max);
  m.update(1000);
  assert.deepEqual(events, [9], 'one-shot');
});
