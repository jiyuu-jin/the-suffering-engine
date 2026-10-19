// Gamepad support (src/app/gamepad.ts, src/game/weapons/aim-assist.ts, the pad parts of
// src/game/hud/bindings.ts and the calibration detector): id parsing, remap tables, dead zones
// and response curves, rumble-curve decoding and conversion, aim assist and pad layouts. Data
// checks (the retail rumble curves and the sounds that reference them) skip without the game.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrsc, skip } from './helpers';
import {
  GENERIC_MAPPING,
  REMAPS,
  RUN_THRESHOLD,
  curveToEffects,
  decodeHat,
  findRemap,
  mixRumble,
  normalizePad,
  padButtonName,
  padFamily,
  pads,
  parsePadId,
  parseRumbleCurve,
  radialDeadzone,
  readRumbleCurves,
  responseCurve,
  rumbleAt,
  rumbleDistanceGain,
  shapeStick,
  stickMove,
  type RawPad,
} from '../src/app/gamepad';
import { ACTIONS, DATA_ACTIONS, PAD_LAYOUT_COUNT, PAD_LAYOUT_CUSTOM, input, padLayout } from '../src/game/hud/bindings';
import { assistLook, directionAngles, pickTarget, withinWeaponCone } from '../src/game/weapons/aim-assist';
import { detectSource } from '../src/app/menu/screens/controller';
import { indexSounds } from '../src/formats/sound';

const raw = (buttons: number[], axes: number[]): Pick<RawPad, 'buttons' | 'axes'> => ({
  buttons: buttons.map((v) => ({ value: v, pressed: v > 0.5 })),
  axes,
});

test('gamepad ids: Chromium, Firefox and Safari formats', () => {
  assert.deepEqual(parsePadId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), { vendor: 0x054c, product: 0x0ce6, name: 'DualSense Wireless Controller' });
  assert.deepEqual(parsePadId('8BitDo SN30 Pro (Vendor: 2dc8 Product: 6101)'), { vendor: 0x2dc8, product: 0x6101, name: '8BitDo SN30 Pro' });
  assert.deepEqual(parsePadId('054c-09cc-Wireless Controller'), { vendor: 0x054c, product: 0x09cc, name: 'Wireless Controller' });
  assert.deepEqual(parsePadId('45e-2e0-Xbox Wireless Controller'), { vendor: 0x045e, product: 0x02e0, name: 'Xbox Wireless Controller' });
  assert.deepEqual(parsePadId('Pro Controller'), { name: 'Pro Controller' });
  assert.deepEqual(parsePadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), { name: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' });
});

test('gamepad families from vendor ids and names', () => {
  assert.equal(padFamily(parsePadId('DUALSHOCK 4 Wireless Controller')), 'playstation');
  assert.equal(padFamily(parsePadId('Wireless Controller')), 'playstation');
  assert.equal(padFamily(parsePadId('054c-0ce6-DualSense Wireless Controller')), 'playstation');
  assert.equal(padFamily(parsePadId('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')), 'xbox');
  assert.equal(padFamily(parsePadId('Xbox Wireless Controller')), 'xbox');
  assert.equal(padFamily(parsePadId('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')), 'nintendo');
  assert.equal(padFamily(parsePadId('8BitDo SN30 Pro (Vendor: 2dc8 Product: 6101)')), 'nintendo');
  assert.equal(padFamily(parsePadId('USB Gamepad (Vendor: 0079 Product: 0011)')), 'generic');
  assert.equal(padButtonName(0, 'playstation'), 'Cross');
  assert.equal(padButtonName(0, 'nintendo'), 'B');
  assert.equal(padButtonName(7, 'xbox'), 'RT');
  assert.equal(padButtonName(6, 'nintendo'), 'ZL');
});

test('remap tables: every table covers 17 buttons and 4 axes; lookups by vendor / product', () => {
  for (const r of REMAPS) {
    assert.equal(r.mapping.buttons.length, 17, r.mapping.name);
    assert.equal(r.mapping.axes.length, 4, r.mapping.name);
  }
  assert.equal(findRemap(parsePadId('054c-9cc-Wireless Controller'))?.name, 'Sony raw HID');
  assert.equal(findRemap(parsePadId('054c-ce6-DualSense Wireless Controller'))?.name, 'Sony raw HID');
  assert.equal(findRemap(parsePadId('57e-2009-Pro Controller'))?.name, 'Switch Pro raw HID');
  assert.equal(findRemap(parsePadId('45e-b13-Xbox Wireless Controller'))?.name, 'Xbox Bluetooth raw HID');
  assert.equal(findRemap(parsePadId('45e-2e0-Xbox Wireless Controller'))?.name, 'Xbox One S (BT classic) raw HID');
  assert.equal(findRemap(parsePadId('2dc8-6101-8BitDo SN30 Pro'))?.name, '8BitDo D-input raw HID');
  assert.equal(findRemap(parsePadId('Pro Controller')), undefined); // Safari: no ids (and it maps)
});

test('remap: DualShock 4 raw HID becomes the standard layout', () => {
  const ds4 = findRemap({ vendor: 0x054c, product: 0x09cc, name: '' })!;
  // Raw: Cross (1) pressed, L2 axis 3 fully pulled (rest -1), hat axis 9 = up, sticks LX 0.5, RY (axis 5) -1.
  const axes = [0.5, 0, 0, 1, -1, -1, 0, 0, 0, -1];
  const n = normalizePad(raw([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], axes), ds4);
  assert.equal(n.buttons[0], 1, 'Cross -> standard 0');
  assert.equal(n.buttons[2], 0, 'Square not pressed');
  assert.equal(n.buttons[6], 1, 'L2 axis at +1 -> trigger 1');
  assert.equal(n.buttons[7], 0, 'R2 axis at rest -1 -> 0');
  assert.equal(n.buttons[12], 1, 'hat up -> d-pad up');
  assert.equal(n.buttons[13], 0);
  assert.deepEqual(n.axes, [0.5, 0, 0, -1]);
  // Standard pads pass through.
  const std = normalizePad(raw([0, 0, 0, 0, 0, 0, 0.4, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0], [0.1, -0.2, 0.3, 0.4]), null);
  assert.equal(std.buttons[6], 0.4);
  assert.equal(std.buttons[15], 1);
  assert.deepEqual(std.axes, [0.1, -0.2, 0.3, 0.4]);
  // Generic fallback keeps indices.
  assert.equal(normalizePad(raw([0, 0, 1], [0, 0, 0, 0]), GENERIC_MAPPING).buttons[2], 1);
});

test('hat switch axis decoding (8 directions, centred outside [-1.1, 1.1])', () => {
  const step = 2 / 7;
  assert.deepEqual(decodeHat(-1), { up: true, down: false, left: false, right: false });
  assert.deepEqual(decodeHat(-1 + step), { up: true, down: false, left: false, right: true });
  assert.deepEqual(decodeHat(-1 + 2 * step), { up: false, down: false, left: false, right: true });
  assert.deepEqual(decodeHat(-1 + 4 * step), { up: false, down: true, left: false, right: false });
  assert.deepEqual(decodeHat(-1 + 6 * step), { up: false, down: false, left: true, right: false });
  assert.deepEqual(decodeHat(1), { up: true, down: false, left: true, right: false });
  assert.deepEqual(decodeHat(3.2857), { up: false, down: false, left: false, right: false });
});

test('stick math: radial dead zone, response curves, walk / run by deflection', () => {
  assert.deepEqual(radialDeadzone(0.1, 0.1, 0.2), [0, 0]);
  const [x, y] = radialDeadzone(0.95, 0, 0.2);
  assert.ok(Math.abs(x - 1) < 1e-9 && y === 0, 'outer edge = full');
  const [hx] = radialDeadzone(0.575, 0, 0.2);
  assert.ok(Math.abs(hx - 0.5) < 1e-9, 'half way between the zones = 0.5');
  // Radial: a diagonal keeps its direction.
  const [dx, dy] = radialDeadzone(0.5, 0.5, 0.2);
  assert.ok(Math.abs(dx - dy) < 1e-12 && dx > 0);
  assert.equal(responseCurve(0.5, 0), 0.5);
  assert.ok(Math.abs(responseCurve(0.5, 1) - Math.pow(0.5, 1.8)) < 1e-12);
  assert.ok(responseCurve(0.5, 2) < responseCurve(0.5, 1));
  assert.equal(responseCurve(1, 2), 1);
  const [sx, sy] = shapeStick(0, -0.95, 0.15, 1);
  assert.ok(sx === 0 && Math.abs(sy + 1) < 1e-9);
  const walk = stickMove(0, -0.5, 0.15);
  assert.equal(walk.run, false);
  assert.ok(walk.forward > 0 && walk.forward < 1, 'partial stick walks slower');
  const run = stickMove(0, -1, 0.15);
  assert.equal(run.run, true);
  assert.ok(Math.abs(run.forward - 1) < 1e-9);
  assert.ok(RUN_THRESHOLD > 0.5 && RUN_THRESHOLD < 1);
  assert.equal(stickMove(0.05, 0.05, 0.15).magnitude, 0);
});

/** A rumble entry: kind 0, 2 motors, 8 bits, `rate` Hz, then the bytes. */
function curveBytes(rate: number, bytes: number[], kind = 0, bits = 8): DataView {
  const b = new DataView(new ArrayBuffer(20 + bytes.length));
  b.setUint32(0, kind, true);
  b.setUint16(4, 2, true);
  b.setUint16(6, bits, true);
  b.setUint32(8, rate, true);
  b.setUint32(16, bytes.length, true);
  bytes.forEach((v, i) => b.setUint8(20 + i, v));
  return b;
}

test('rumble curves: decoding, sampling, mixing and dual-rumble effects', () => {
  const c = parseRumbleCurve(curveBytes(20, [127, 0, 127, 0, 0, 64, 255, 30]))!;
  assert.equal(c.rate, 20);
  assert.equal(c.frames.length, 4);
  assert.equal(c.duration, 0.2);
  assert.deepEqual(c.frames[0], [1, 0]);
  assert.ok(Math.abs(c.frames[2][1] - 64 / 127) < 1e-9);
  assert.equal(c.frames[3][0], 0, 'bytes above 127 read as off');
  assert.equal(parseRumbleCurve(curveBytes(30, [1, 2], 3)), null, 'other curve kinds are not rumble');
  // 16-bit headers with 8-bit pairs (two retail entries) decode as pairs.
  assert.equal(parseRumbleCurve(curveBytes(20, [0, 75, 0, 74], 0, 16))!.frames.length, 2);
  assert.deepEqual(rumbleAt(c, 0.06), [1, 0]);
  assert.deepEqual(rumbleAt(c, 0.25), [0, 0]);
  assert.deepEqual(rumbleAt(c, -0.1), [0, 0]);
  const other = parseRumbleCurve(curveBytes(10, [32, 127]))!;
  // t = 0.11: c is on frame 2 ([0, 64/127]), `other` (started 0.06 s) on frame 0 at half gain.
  const [s, w] = mixRumble([{ curve: c, start: 0, gain: 1 }, { curve: other, start: 0.06, gain: 0.5 }], 0.11);
  assert.ok(Math.abs(s - 16 / 127) < 1e-9 && Math.abs(w - 64 / 127) < 1e-9, 'per-motor maximum of the gained curves');
  const fx = curveToEffects(c);
  assert.deepEqual(fx[0], { startDelay: 0, duration: 100, strongMagnitude: 1, weakMagnitude: 0 }, 'equal frames merge');
  assert.equal(fx[1].startDelay, 100);
  assert.equal(fx[1].weakMagnitude, 0.504);
  assert.equal(fx.length, 3);
  assert.equal(curveToEffects(c, 0.5)[0].strongMagnitude, 0.5);
  assert.equal(rumbleDistanceGain(1, 2, 20), 1);
  assert.equal(rumbleDistanceGain(30, 2, 20), 0);
  assert.ok(Math.abs(rumbleDistanceGain(11, 2, 20) - 0.5) < 1e-9);
});

test('retail rumble curves (Resources.wdu) and the sounds that reference them', { skip }, () => {
  // 77 type-0x60 entries: 68 rumble curves, 2 empty ones (98, 102) and 7 curves of other kinds.
  const curves = readRumbleCurves(readSrsc('COMMON/Resources/Resources.wdu'));
  assert.equal(curves.size, 68);
  for (const [id, c] of curves) {
    assert.equal(c.motors, 2, `curve ${id}`);
    assert.ok([10, 15, 20, 30].includes(c.rate), `curve ${id} rate ${c.rate}`);
    for (const f of c.frames) assert.ok(f[0] >= 0 && f[0] <= 1 && f[1] >= 0 && f[1] <= 1);
  }
  // The tommy gun's and revolver's fire sounds carry curve 4:97; the shotgun's 4:104.
  const sounds = indexSounds(readSrsc('COMMON/Resources/Resources.sdu'), 4);
  const ref = (id: number) => sounds.find((x) => x.id === id)?.rumble;
  assert.deepEqual(ref(119), { pkg: 4, id: 97 });
  assert.deepEqual(ref(198), { pkg: 4, id: 97 });
  assert.deepEqual(ref(41), { pkg: 4, id: 104 });
  assert.ok(curves.has(97) && curves.has(104));
  // Every rumble reference of the package resolves to a curve.
  for (const x of sounds) if (x.rumble?.pkg === 4) assert.ok(curves.has(x.rumble.id), `sound 4:${x.id} -> curve ${x.rumble.id}`);
});

test('aim assist: target pick, slowdown / magnetism and the p76 cone', () => {
  const eye = { x: 0, y: 0, z: 0 };
  // Yaw 0 looks down -Z. A target 10 m ahead, 0.5 m to the left (about 2.9 deg).
  const t = { x: -0.5, y: 0, z: -10, radius: 0.4, id: 1 };
  const far = { x: 5, y: 0, z: -10, radius: 0.4, id: 2 }; // ~27 deg off
  const lock = pickTarget(eye, 0, 0, [far, t]);
  assert.equal(lock?.target.id, 1);
  assert.ok(lock!.dYaw > 0, 'target to the left = positive yaw');
  assert.equal(pickTarget(eye, 0, 0, [far]), null);
  assert.equal(pickTarget(eye, 0, 0, [t], { blocked: () => true }), null, 'no line of sight');
  assert.ok(Math.abs(directionAngles(eye, { x: 0, y: 10, z: -10 }).pitch - Math.PI / 4) < 1e-9);
  const free = assistLook(null, { yaw: 1, pitch: 0 }, 1, 0);
  assert.deepEqual(free, { yaw: 1, pitch: 0 });
  const slowed = assistLook({ ...lock!, angle: 0, dYaw: 0, dPitch: 0 }, { yaw: 1, pitch: 0 }, 0, 0);
  assert.ok(slowed.yaw < 1 && slowed.yaw > 0, 'slower on the target');
  const pulled = assistLook(lock, { yaw: 0, pitch: 0 }, 1, 0);
  assert.ok(pulled.yaw > 0, 'pulled toward the target while steering');
  assert.equal(assistLook(lock, { yaw: 0, pitch: 0 }, 0, 0).yaw, 0, 'no pull without steering');
  assert.ok(withinWeaponCone(lock, 45));
  assert.ok(!withinWeaponCone({ ...lock!, angle: (50 * Math.PI) / 180 }, 45));
  assert.ok(!withinWeaponCone(null, 45));
});

test('pad layouts: unique buttons, Custom keeps the player column, labels follow the device', () => {
  assert.equal(ACTIONS.length, DATA_ACTIONS + 1);
  assert.equal(ACTIONS[DATA_ACTIONS], 'crouch');
  for (let l = 0; l < PAD_LAYOUT_COUNT - 1; l++) {
    const codes = Object.values(padLayout(l)).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length, `layout ${l} binds a button twice`);
    assert.ok(!codes.includes('Pad9'), 'Start stays reserved');
    assert.equal(padLayout(l).fire, 'Pad7', 'RT fires');
  }
  assert.equal(padLayout(1).jump, 'Pad6');
  assert.equal(padLayout(4).jump, 'Pad3');
  input.resetDefaults();
  assert.equal(input.padLayout, 0);
  input.set('use', 'pad', 'Pad16');
  assert.equal(input.padLayout, PAD_LAYOUT_CUSTOM, 'editing a pad cell makes the layout Custom');
  input.setPadLayout(1);
  assert.equal(input.current.pad.use, 'Pad2');
  assert.equal(input.current.pad.throw, 'Pad0');
  input.setPadLayout(PAD_LAYOUT_CUSTOM);
  assert.equal(input.current.pad.use, 'Pad16', 'Custom restores the edited column');
  input.resetDefaults();
  // Labels: keys for keyboard play, pad names while a pad is in use.
  assert.equal(input.labelMap().Use, 'E');
  pads.lastDevice = 'pad';
  try {
    assert.equal(input.labelMap().Use, 'X');
    assert.equal(input.labelMap().GUISelect, 'A');
    assert.equal(input.labelMap().LadderMove, 'Left Stick');
    assert.equal(input.label('fire'), 'RT');
  } finally {
    pads.lastDevice = 'keyboard';
  }
  assert.equal(input.labelMap().Use, 'E');
});

test('calibration: raw button, trigger axis, hat and stick detection', () => {
  const rest = [0, 0, 0, -1, -1, 0, 0, 0, 0, 3.2857];
  const btn = { kind: 'button' as const, index: 0, text: '' };
  assert.deepEqual(detectSource(raw([0, 0, 1], rest), rest, btn), { b: 2 });
  const trig = detectSource(raw([0], [0, 0, 0, 1, -1, 0, 0, 0, 0, 3.2857]), rest, { kind: 'button', index: 6, text: '' });
  assert.deepEqual(trig, { a: 3, dir: 1, rest: -1 });
  const hat = detectSource(raw([0], [0, 0, 0, -1, -1, 0, 0, 0, 0, -1]), rest, { kind: 'button', index: 12, text: '' });
  assert.deepEqual(hat, { hat: 9, dir: 'up' });
  const stick = detectSource(raw([0], [0, 0, 0, -1, -1, -0.9, 0, 0, 0, 3.2857]), rest, { kind: 'axis', axis: 3, text: '' });
  assert.deepEqual(stick, { a: 5, invert: true });
  assert.equal(detectSource(raw([0], rest), rest, btn), null);
});
