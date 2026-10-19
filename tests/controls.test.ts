// Controls fidelity (docs/re/player.md §6, §8, §12 and docs/game-logic.md §13): the Health
// action's rules and amount, the Xombium hint, the pad look rates, and the creature form's melee
// hits. Pure rules, plus template / clip checks against the local install (skipped without one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, readSrsc, skip } from './helpers';
import { HEALTH_HINT_EVENT, PITCH_INPUT_SCALE, PITCH_RATE_DEG, SENSITIVITY_MAX, SENSITIVITY_MIN, TURN_RATE_DEG, canDrinkHealth, healAmount, healthHintDue, lookRates, sensitivityOfSlider } from '../src/app/player-rules';
import { PAD_DEFAULTS, pads } from '../src/app/gamepad';
import { input } from '../src/game/hud/bindings';
import { DEFAULT_SETTINGS, applySettings } from '../src/app/menu/settings';
import { PLAYER_TEAM } from '../src/game/actors/behaviors';
import type { EntityPackage } from '../src/formats/entities';
import { readAnimEvents } from '../src/formats/animation';
import { readInsanityParams } from '../src/game/insanity/params';
import { CREATURE_WEAPON_SHAPES, armWindows, creatureBlowOutcome, meleeDamage, reputationDamageScale, segmentDistance, sweepCapsule, sweepSpheres, type Vec3 } from '../src/game/insanity/melee';

const gate = { alive: true, health: 50, maxHealth: 100, transformed: false, scripted: false, bottles: 1 };

test('Health action gate (RFL 0x10049a28): alive, human form, not scripted, a bottle, > 1 point missing', () => {
  assert.equal(canDrinkHealth(gate), true);
  assert.equal(canDrinkHealth({ ...gate, alive: false }), false, 'dead');
  assert.equal(canDrinkHealth({ ...gate, health: 0 }), false, 'no health left');
  assert.equal(canDrinkHealth({ ...gate, transformed: true }), false, 'states 19 / 20: morphing or transformed');
  assert.equal(canDrinkHealth({ ...gate, scripted: true }), false, 'script control / Controlled');
  assert.equal(canDrinkHealth({ ...gate, bottles: 0 }), false, 'no Health Bonus Item');
  assert.equal(canDrinkHealth({ ...gate, health: 99 }), false, 'max - health = 1.0 is not > 1');
  assert.equal(canDrinkHealth({ ...gate, health: 98.9 }), true, 'more than 1 point missing');
  assert.equal(canDrinkHealth({ ...gate, health: 100 }), false, 'full health');
});

test('Health amount (0x100b6cd0): p55 x Difficulty Modifier x reputation factor 0.5..1.5', () => {
  assert.equal(healAmount(20, 1, 0), 20, 'neutral reputation, medium');
  assert.equal(healAmount(20, 2, 0), 40, 'easy modifier 2');
  assert.equal(healAmount(20, 1, -150), 10, 'evil end: p76 = 0.5');
  assert.equal(healAmount(20, 1, 150), 30, 'good end: p77 = 1.5');
  assert.equal(healAmount(20, 1, 999), 30, 'clamped past p71');
  assert.equal(healAmount(20, 1, 75), 25, 'linear between');
  assert.equal(healAmount(20, 0, 0), 20, 'a missing modifier counts as 1');
});

test('Xombium hint (player event 6, Player p298): pickup below 50 %, damage below 80 % with a bottle', () => {
  assert.equal(HEALTH_HINT_EVENT, 6);
  assert.equal(healthHintDue('pickup', 49, 100, 1), true);
  assert.equal(healthHintDue('pickup', 50, 100, 1), false);
  assert.equal(healthHintDue('damage', 79, 100, 1), true);
  assert.equal(healthHintDue('damage', 79, 100, 0), false, 'no bottle carried');
  assert.equal(healthHintDue('damage', 80, 100, 3), false);
});

// ---------------------------------------------------------------------------------------------
// Look rates (Turn per-frame 0x10046dc0, Pitch per-frame 0x1003f930, sliders 0x10056d70)


const DEG = Math.PI / 180;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test('look rates: 220 deg/s turn x Turn sensitivity, 2 x 42 deg/s pitch x Pitch sensitivity, invert', () => {
  assert.equal(TURN_RATE_DEG, 220);
  assert.equal(PITCH_RATE_DEG * PITCH_INPUT_SCALE, 84);
  const r = lookRates(1, 1);
  assert.ok(near(r.yaw, 220 * DEG) && near(r.pitch, 84 * DEG));
  const half = lookRates(0.5, -0.5, { turnSens: 2, pitchSens: 0.5 });
  assert.ok(near(half.yaw, 220 * DEG) && near(half.pitch, -21 * DEG), 'linear in the axis and the sensitivity');
  assert.ok(near(lookRates(0, 1, { invert: true }).pitch, -84 * DEG), 'Invert Pitch (flag 0x10) negates the pitch input');
});

test('sensitivity sliders: 2^(4s - 2) clamped to 0.25..4, default 1 at mid', () => {
  assert.equal(sensitivityOfSlider(0), SENSITIVITY_MIN);
  assert.equal(sensitivityOfSlider(0.5), 1);
  assert.equal(sensitivityOfSlider(1), SENSITIVITY_MAX);
  assert.equal(sensitivityOfSlider(0.75), 2);
});

test('pad defaults follow the original: linear response, Auto Targeting / Auto Pitch off', () => {
  assert.equal(PAD_DEFAULTS.curve, 0);
  assert.equal(PAD_DEFAULTS.aimAssist, false);
  assert.equal(PAD_DEFAULTS.autoPitch, false);
});

test('right stick through the bindings layer: decoded rates, Gameplay sensitivities, invert, no boost', () => {
  const st = { axes: [0, 0, 0, 0] as number[] };
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, 'getGamepads');
  Object.defineProperty(nav, 'getGamepads', {
    configurable: true,
    value: () => [{ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })), axes: [...st.axes] }],
  });
  const saved = { ...pads.options };
  Object.assign(pads.options, PAD_DEFAULTS);
  const p = { enabled: true, yaw: 0, pitch: 0, sensitivity: 0.0022, turnScale: 1, pitchScale: 1, invertY: false, mode: 'fp' as const, clampPitch: (x: number) => Math.max(-1.5, Math.min(1.5, x)), setVirtualInput() {}, setAnalogInput() {} };
  input.attachPlayer(p);
  try {
    const run = (axes: number[], secs: number) => {
      st.axes = axes;
      const y0 = p.yaw, p0 = p.pitch;
      // Frames of 1/60 s (the poll is throttled to ~4 ms of wall time: force a fresh one per frame).
      for (let t = 0; t < secs - 1e-9; t += 1 / 60) {
        pads.poll(true);
        input.update(1 / 60);
      }
      return { yaw: (p.yaw - y0) / DEG / secs, pitch: (p.pitch - p0) / DEG / secs };
    };
    run([0, 0, 1, 0], 1 / 60); // first frame: the pad becomes the active device
    const full = run([0, 0, 1, 0], 1);
    assert.ok(Math.abs(full.yaw + 220) < 1, `full right: -220 deg/s, got ${full.yaw}`);
    const held = run([0, 0, 1, 0], 2);
    assert.ok(Math.abs(held.yaw + 220) < 1, `no turn boost when held, got ${held.yaw}`);
    // Half deflection past the 0.15 dead zone (outer edge 0.95): linear 0.4375.
    const half = run([0, 0, 0.5, 0], 1);
    assert.ok(Math.abs(half.yaw + 220 * 0.4375) < 1, `half: ${half.yaw}`);
    p.pitch = 0;
    const up = run([0, 0, 0, -1], 0.5);
    assert.ok(Math.abs(up.pitch - 84) < 1, `stick up: +84 deg/s, got ${up.pitch}`);
    p.turnScale = 2;
    p.pitchScale = 0.5;
    p.invertY = true;
    p.pitch = 0;
    const scaled = run([0, 0, 1, -1], 0.25);
    // Diagonal: radial dead zone keeps the direction (each axis 1 / sqrt 2 of full).
    assert.ok(Math.abs(scaled.yaw + 440 / Math.SQRT2) < 2, `Turn sensitivity 2: ${scaled.yaw}`);
    assert.ok(Math.abs(scaled.pitch + 42 / Math.SQRT2) < 2, `Pitch sensitivity 0.5, inverted: ${scaled.pitch}`);
  } finally {
    st.axes = [0, 0, 0, 0];
    input.update(1 / 60);
    input.attachPlayer(undefined);
    Object.assign(pads.options, saved);
    if (had) Object.defineProperty(nav, 'getGamepads', had);
    else delete nav.getGamepads;
  }
});

// ---------------------------------------------------------------------------------------------
// Creature-form melee (Melee Weapon sweep 0x100caff0, damage 0x100ca920, docs/game-logic.md §13.9)

const ev = (time: number, param: number, boneHash = 0) => ({ kind: 1, time, boneHash, param });

test('Arm windows: Arm (100) to the next Disarm (101) on the same bone; none without Arm', () => {
  const w = armWindows([ev(0.2, 100, 22), ev(0.43, 101, 22), ev(0.05, 200), { kind: 0, time: 0.1, boneHash: 0, param: 5 }], 1);
  assert.deepEqual(w, [{ bone: 22, t0: 0.2, t1: 0.43 }]);
  const both = armWindows([ev(0.04, 100, 22), ev(0.18, 100, 31), ev(0.27, 101, 22), ev(0.59, 101, 31)], 1);
  assert.deepEqual(both.map((x) => [x.bone, x.t0, x.t1]), [[22, 0.04, 0.27], [31, 0.18, 0.59]]);
  assert.deepEqual(armWindows([ev(0.3, 100, 7)], 0.9), [{ bone: 7, t0: 0.3, t1: 0.9 }], 'no Disarm: armed to the end');
  assert.deepEqual(armWindows([ev(0.3, 230)], 1), [], 'a clip without Arm markers deals no damage');
});

test('sweep: the claw segment / swept sphere against a target capsule', () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const d = segmentDistance([0, 0, 0], [1, 0, 0], [0.5, 1, -1], [0.5, 1, 1]);
  assert.ok(near(d.d, 1) && near(d.s, 0.5) && near(d.t, 0.5));
  const cap = { x: 2, z: 0, y0: 0, y1: 1.8, r: 0.4 };
  const a: Vec3 = [0, 1, 0], b: Vec3 = [1.2, 1, 0];
  assert.equal(sweepCapsule(a, b, a, b, 0, cap), null, 'the 1.2 m claw stops 0.4 m short');
  // The arm swings round: the blade passes through the target between frames.
  const hit = sweepCapsule([0, 1, -1.2], [0, 1, -2.4], [0, 1, 0], [2.4, 1, 0], 0, cap);
  assert.ok(hit, 'a swept quad crossing the capsule hits even when both end poses miss');
  assert.equal(sweepCapsule([0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], 0.65, { ...cap, x: 1.2 }), null, 'sphere 0.65 + body 0.4 < 1.2');
  assert.ok(sweepCapsule([0, 1, 0], [0, 1, 0], [0.5, 1, 0], [0.5, 1, 0], 0.65, { ...cap, x: 1.4 }), 'the swept sphere reaches');
  assert.equal(sweepCapsule(a, b, a, b, 0, { ...cap, x: 1, y0: 2.5, y1: 4 }), null, 'above the head');
});

test('creature blow damage: p68 flat x Attack p6, NPC reputation scale p78..p79', () => {
  assert.equal(meleeDamage(35, 1), 35);
  assert.equal(meleeDamage(35, 1.5), 52.5);
  assert.equal(reputationDamageScale(0), 1);
  assert.equal(reputationDamageScale(-150), 0.75);
  assert.equal(reputationDamageScale(300), 1.25);
  assert.equal(meleeDamage(35, 2, reputationDamageScale(150)), 87.5);
});

test('creature blow targets: own team skipped, p167 = 2 visions reflect, the dead skipped', () => {
  const t = { alive: true };
  assert.equal(creatureBlowOutcome(t, PLAYER_TEAM), 'hit');
  assert.equal(creatureBlowOutcome({ ...t, team: '10:119' }, PLAYER_TEAM), 'hit', 'CartWheelers');
  assert.equal(creatureBlowOutcome({ ...t, team: PLAYER_TEAM }, PLAYER_TEAM), 'skip', 'companions');
  assert.equal(creatureBlowOutcome({ ...t, vision: 2 }, PLAYER_TEAM), 'reflect');
  assert.equal(creatureBlowOutcome({ ...t, vision: 1 }, PLAYER_TEAM), 'hit', 'the human-self vision only takes blows in creature form');
  assert.equal(creatureBlowOutcome({ alive: false }, PLAYER_TEAM), 'skip');
  // A corpse with Part Caps left still takes the blow (its Character damage runs the part-cap
  // test, actors/dismember.ts); a claw (type 8) cuts heads, arms, torsos.
  assert.equal(creatureBlowOutcome({ alive: false, cuttable: true }, PLAYER_TEAM), 'hit');
  assert.equal(creatureBlowOutcome({ alive: false, cuttable: true, team: PLAYER_TEAM }, PLAYER_TEAM), 'skip');
  assert.equal(creatureBlowOutcome({ ...t, decor: true }, PLAYER_TEAM), 'skip');
});

test('creature blows on a body on the floor: the leaf hit sphere the claw comes deepest into', () => {
  const head = { c: [0, 0.1, 1] as Vec3, r: 0.15 }, chest = { c: [0, 0.15, 0.4] as Vec3, r: 0.25 };
  // A claw sweeping across at 0.2 m over the head.
  assert.deepEqual(sweepSpheres([-1, 0.2, 1], [-0.5, 0.2, 1], [0.5, 0.2, 1], [1, 0.2, 1], 0.05, [chest, head]), head.c);
  assert.equal(sweepSpheres([-1, 1.5, 1], [-0.5, 1.5, 1], [0.5, 1.5, 1], [1, 1.5, 1], 0.05, [chest, head]), null, 'passing 1.5 m over it: no blow');
  assert.equal(sweepSpheres([-1, 0.2, 1], [-0.5, 0.2, 1], [0.5, 0.2, 1], [1, 0.2, 1], 0.05, []), null);
});

function packages() {
  const pkgs = new Map<number, EntityPackage>();
  for (const [id, base] of [[2, 'COMMON/System/System'], [4, 'COMMON/Resources/Resources']] as const) {
    if (existsSync(join(DATA_ROOT, base + '.odu'))) pkgs.set(id, { id, name: base, odu: readSrsc(base + '.odu') } as EntityPackage);
  }
  return pkgs;
}

test('creature form data: arm weapons 35 / type 8 on bones 31 / 22, combo p6, strike Arm windows', { skip }, () => {
  const p = readInsanityParams(packages())!;
  const c = p.creature!;
  assert.deepEqual(c.armWeapons.map((w) => [`${w.template.pkg}:${w.template.id}`, w.bone, w.damage, w.type]), [['4:155', 31, 35, 8], ['4:832', 22, 35, 8]]);
  for (const w of c.armWeapons) assert.ok(CREATURE_WEAPON_SHAPES[`${w.template.pkg}:${w.template.id}`], 'a sweep shape for each arm weapon');
  assert.deepEqual(c.npcDamageScale, [0.75, 1.25]);
  assert.deepEqual(c.attacks!.combo.map((a) => a.scale), [1, 1, 1, 1, 1.5]);
  const adu = readSrsc('COMMON/System/System.adu');
  const win = (id: number) => armWindows(readAnimEvents(adu, id)?.events ?? [], 9);
  const w354 = win(354);
  assert.equal(w354.length, 1);
  assert.ok(Math.abs(w354[0].t0 - 0.202) < 0.01 && Math.abs(w354[0].t1 - 0.429) < 0.01, JSON.stringify(w354));
  assert.equal(win(350).length, 2, 'the finisher arms both claws');
  assert.equal(win(370).length, 0, 'alternate 2:370 has no Arm markers');
});

test('Gameplay settings reach the pad: Turn sensitivity -> turnScale, Pitch -> pitchScale, invert', () => {
  const look = { sensitivity: 0, pitchScale: 1, turnScale: 1, invertY: false };
  const audio = { setBusVolume() {} } as unknown as Parameters<typeof applySettings>[1]['audio'];
  applySettings({ ...DEFAULT_SETTINGS, mouseSensitivity: 2.5, pitchSensitivity: 0.5, invertY: true, extra: {} }, { audio, look: [look] });
  assert.equal(look.turnScale, 2.5);
  assert.equal(look.pitchScale, 0.5);
  assert.equal(look.invertY, true);
});
