// Player rules from the RFL (docs/re/player.md): fall damage, the drop tracker, the console
// auto-aim selection / assist, Auto Pitch and the retail key table. The template checks read the
// local install's System package (skipped without one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, readSrsc, skip } from './helpers';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage } from '../src/formats/entities';
import {
  AUTO_PITCH_DELAY,
  FALL_DAMAGE_MAX,
  FALL_DAMAGE_MIN,
  FP_AIR_CONTROL,
  FP_JUMP_SPEED,
  FallTracker,
  PITCH_RATE_DEG,
  PLAYER_GRAVITY,
  RETAIL_PC_KEYS,
  RUN_SPEED,
  TURN_RATE_DEG,
  WALK_SPEED,
  fallDamage,
} from '../src/app/player-rules';
import { AUTO_PITCH_RATE, SLOW_STANDING, assistLook, autoPitchRate, pickTarget, shotTarget, type AimCandidate } from '../src/game/weapons/aim-assist';

const DEG = Math.PI / 180;

test('fall damage: nothing to 6.5 m, linear to lethal at 7.7 m', () => {
  assert.equal(fallDamage(3, 100, 100), 0);
  assert.equal(fallDamage(FALL_DAMAGE_MIN, 100, 100), 0);
  assert.ok(Math.abs(fallDamage(7.1, 100, 100) - 50) < 1e-9);
  assert.equal(fallDamage(FALL_DAMAGE_MAX, 100, 40), 100);
  assert.equal(fallDamage(30, 60, 60), 60, 'lethal');
  // max(maxHealth * f, health * f)
  assert.ok(Math.abs(fallDamage(7.1, 100, 120) - 60) < 1e-9);
  assert.equal(fallDamage(NaN, 100, 100), 0);
});

test('fall tracker: drop from the highest airborne point, teleports reset', () => {
  const t = new FallTracker();
  const dt = 1 / 60;
  assert.equal(t.step(10, true, dt), null);
  // Jump: up 0.7, then down 8.
  let y = 10;
  for (let i = 0; i < 10; i++) assert.equal(t.step((y += 0.07), false, dt), null);
  for (let i = 0; i < 40; i++) t.step((y -= 0.2), false, dt);
  const drop = t.step(y, true, dt);
  assert.ok(drop !== null && Math.abs(drop - 8) < 1e-6);
  assert.equal(t.step(y, true, dt), null, 'only on the landing frame');
  // Teleport down 50 m while "airborne": no fall.
  t.step(y, false, dt);
  assert.equal(t.step(y - 50, true, dt), null);
});

const eye = { x: 0, y: 0, z: 0 };
const at = (x: number, y: number, z: number, priority = 10, id = 1, radius = 0.4): AimCandidate => ({ x, y, z, radius, id, priority });

test('auto-aim selection: 5 x 3 deg pyramid, range, priority >= 5, best centred', () => {
  // 10 m ahead (yaw 0 looks down -Z).
  assert.equal(pickTarget(eye, 0, 0, [at(-0.5, 0, -10)])?.target.id, 1, '2.9 deg left');
  assert.equal(pickTarget(eye, 0, 0, [at(-1.6, 0, -10)]), null, '9 deg left is outside +-5 deg (+radius)');
  assert.ok(pickTarget(eye, 0, 0, [at(0, 0.8, -10)]), '4.6 deg up touches the 3 deg plane with its radius');
  assert.equal(pickTarget(eye, 0, 0, [at(0, 1.4, -10)]), null, '8 deg up');
  assert.equal(pickTarget(eye, 0, 0, [at(0, 0, -50)]), null, 'beyond the 45 m default range');
  assert.ok(pickTarget(eye, 0, 0, [at(0, 0, -50)], { range: 60 }));
  assert.equal(pickTarget(eye, 0, 0, [at(0, 0, -10)], { range: 0 }), null, 'no Ranged Weapon');
  assert.equal(pickTarget(eye, 0, 0, [at(0, 0, 10)]), null, 'behind');
  assert.equal(pickTarget(eye, 0, 0, [at(0, 0, -10, 1)]), null, 'human NPC priority 1');
  // Priority 5 must beat the 1.1 starting score (about 1 deg); priority 10 always qualifies.
  assert.equal(pickTarget(eye, 0, 0, [at(-0.4, 0, -10, 5)]), null);
  assert.ok(pickTarget(eye, 0, 0, [at(-0.1, 0, -10, 5)]));
  // Higher priority wins over a better-centred one; equal priority: the better-centred one.
  const a = at(-0.6, 0, -10, 10, 1), b = at(0, 0, -10, 5, 2), c = at(-0.2, 0, -10, 10, 3);
  assert.equal(pickTarget(eye, 0, 0, [b, a])?.target.id, 1);
  assert.equal(pickTarget(eye, 0, 0, [a, c, b])?.target.id, 3);
  assert.equal(pickTarget(eye, 0, 0, [a], { blocked: () => true }), null, 'line of sight');
  // Pitched view: the pyramid follows the camera.
  assert.ok(pickTarget(eye, 0, 30 * DEG, [at(0, Math.tan(30 * DEG) * 10, -10)]));
});

test('auto-aim assist: slowdown, tracking, shot snap, Auto Pitch', () => {
  const lock = pickTarget(eye, 0, 0, [at(-0.5, 0, -10)])!;
  const stand = assistLook(lock, { yaw: 1, pitch: 1 }, 0, 0, { moving: false });
  assert.ok(Math.abs(stand.yaw - SLOW_STANDING) < 1e-9 && Math.abs(stand.pitch - 0.5) < 1e-9);
  const near = assistLook({ ...lock, dist: 2 }, { yaw: 1, pitch: 1 }, 1, 0, { moving: true });
  const far = assistLook({ ...lock, dist: 35 }, { yaw: 1, pitch: 1 }, 1, 0, { moving: true });
  assert.ok(Math.abs(near.yaw - 0.55) < 1e-9 && Math.abs(far.yaw - 0.1) < 1e-9 && Math.abs(far.pitch - 0.7) < 1e-9);
  // Tracking: no stick input + relative motion + farther than 3 m -> the offset in one frame.
  const tr = assistLook(lock, { yaw: 0, pitch: 0 }, 0.5, 0, { dt: 1 / 60, moving: true });
  assert.ok(Math.abs(tr.yaw / 60 - lock.dYaw) < 1e-9);
  assert.equal(assistLook(lock, { yaw: 0, pitch: 0 }, 0, 0, { moving: false }).yaw, 0, 'still: no tracking');
  assert.ok(assistLook(lock, { yaw: 0, pitch: 0 }, 0, 0, { moving: false, targetMoved: true }).yaw > 0, 'moving target');
  assert.equal(assistLook({ ...lock, dist: 2.5 }, { yaw: 0, pitch: 0 }, 1, 0, { moving: true }).yaw, 0, 'too close');
  // Shot snap: within 1 deg (+radius) only.
  assert.ok(shotTarget(pickTarget(eye, 0, 0, [at(-0.2, 0, -10)])));
  assert.equal(shotTarget(pickTarget(eye, 0, 0, [at(-0.9, 0, -10)])), null, '5 deg off: acquired, no snap');
  // Auto Pitch toward level at 42 deg/s, no overshoot.
  assert.ok(Math.abs(autoPitchRate(0.5) + AUTO_PITCH_RATE) < 1e-9);
  assert.ok(Math.abs(autoPitchRate(0.001, 0, 1 / 60) + 0.06) < 1e-9);
  assert.equal(AUTO_PITCH_DELAY, 2.2);
  assert.ok(Math.abs(AUTO_PITCH_RATE - PITCH_RATE_DEG * DEG) < 1e-12);
});

test('retail PC key table: one entry per keyboard-page action', () => {
  const ids = Object.values(RETAIL_PC_KEYS).map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 40);
  assert.deepEqual(RETAIL_PC_KEYS.health.keys.slice(0, 1), ['Tab']);
  assert.equal(RETAIL_PC_KEYS.insanity.id, 0x42d);
});

function systemPlayer(): unknown[] | undefined {
  const base = 'COMMON/System/System';
  if (!existsSync(join(DATA_ROOT, base + '.odu'))) return undefined;
  const pkgs = new Map<number, EntityPackage>([[2, { id: 2, name: 'System', odu: readSrsc(base + '.odu') } as EntityPackage]]);
  const t = readObjectTemplate(pkgs, { pkg: 2, id: 5 });
  const c = t && classByHash(t.classHash);
  return t && c ? decodeTemplateProps(c, t) : undefined;
}

test('player template 2:5 carries the decoded constants', { skip }, () => {
  const v = systemPlayer();
  assert.ok(v, 'Player template');
  const n = (i: number) => v![i] as number;
  assert.ok(Math.abs(n(214) - PLAYER_GRAVITY) < 1e-5);
  assert.equal(n(215), FP_JUMP_SPEED);
  assert.equal(n(216), FP_AIR_CONTROL);
  assert.equal(n(212), FALL_DAMAGE_MIN);
  assert.ok(Math.abs(n(213) - FALL_DAMAGE_MAX) < 1e-6);
  assert.ok(Math.abs(n(197) - AUTO_PITCH_DELAY) < 1e-6);
  assert.equal(n(190), PITCH_RATE_DEG);
  assert.equal(n(158), TURN_RATE_DEG);
  assert.deepEqual([n(176), n(177), n(178), n(219)], [3, 5, 5, 5]);
  assert.ok(n(182) === 0.125 && n(183) === 0.125 && Math.abs(n(184) - 0.55) < 1e-6 && Math.abs(n(185) - 0.1) < 1e-6);
  assert.ok(WALK_SPEED < RUN_SPEED);
});
