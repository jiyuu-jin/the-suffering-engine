// Particle Fountain draw rules decoded from SUFFERING.EXE / Suffering.rfl (docs/game-logic.md
// §14.2): velocity-aligned p48 = 1 particles, light-coloured p46 = 3 particles, additive alpha,
// the level's gravity and the BouncingObject launch / bounce of 1a's "Hat Gen".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { nodeFS, readSrsc, skip } from './helpers';
import { engineLights } from '../src/app/engine-light';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import { decodeTexture, TEXTURE_ENTRY_TYPE } from '../src/formats/texture';
import { bounceKeep, bounceVelocity, bouncingLaunch, FOUNTAIN_GRAVITY, fountainStreak, levelGravity, litParticleColor, readTemplate, streakFrame } from '../src/game/world/fx';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('world gravity is Level Properties p19 x p18 units per s² (2048 units per output metre)', () => {
  close(levelGravity(), (9.8 * 2175) / 2048);
  close(FOUNTAIN_GRAVITY, 10.4077, 1e-3);
  const v: PropValue[] = [];
  v[18] = 2048;
  v[19] = 9.81;
  close(levelGravity(v), 9.81);
});

test('p48 = 1 streak frame: the quad turns along the screen-space motion, squashed in y towards the camera', () => {
  const v: PropValue[] = [];
  assert.equal(fountainStreak(v), false);
  v[48] = 1;
  assert.equal(fountainStreak(v), true);
  // Camera at the origin looking down -z (view = identity); particle 5 m ahead.
  const view = new THREE.Matrix4();
  const p = new THREE.Vector3(0, 0, -5);
  // Falling: the tail (where it came from) is up the screen: no turn, f = 0.99.
  let f = streakFrame(view, p, new THREE.Vector3(0, -3, 0), 0.05);
  close(f.angle, 0);
  close(f.squash, 0.99);
  // Moving right: the tail is to the left, the sprite's +y turns to -x (a quarter turn CCW).
  f = streakFrame(view, p, new THREE.Vector3(2, 0, 0), 0.05);
  close(f.angle, Math.PI / 2);
  // Flying at the camera: |n.z| = 1 flattens it completely.
  f = streakFrame(view, p, new THREE.Vector3(0, 0, 4), 0.05);
  close(f.squash, 0);
  // At rest the engine takes n = (1, 0, 0): the tail to the right.
  f = streakFrame(view, p, new THREE.Vector3(), 0.05);
  close(f.angle, -Math.PI / 2);
  close(f.squash, 0.99);
  // Diagonal (down-right on screen): tail up-left, angle atan2(-w.x, w.y) with w = (-1, 1).
  f = streakFrame(view, p, new THREE.Vector3(1, -1, 0), 0.05);
  close(f.angle, Math.atan2(1, 1), 1e-3);
});

test('p46 = 3: p33 bytes times the clamped light, in gamma space', () => {
  const c = litParticleColor(0x3f3f3f, new THREE.Color().setRGB(0.5, 1.4, -0.2, THREE.LinearSRGBColorSpace));
  const srgb = c.clone().convertLinearToSRGB();
  close(srgb.r, (0x3f / 255) * 0.5, 1e-4);
  close(srgb.g, 0x3f / 255, 1e-4);
  close(srgb.b, 0, 1e-4);
});

test('particle light: ambient + first directional + full colour of every point light whose cull sphere holds the point, clamped', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera();
  engineLights.setAmbient(new THREE.Color().setRGB(0.1, 0.1, 0.12, THREE.LinearSRGBColorSpace), []);
  const lights = [
    // 1 m away, reaches ~1.8 m: counted with its whole colour (no 1/d² term).
    { x: 1, y: 0, z: 0, intensity: 0.5, r: 0.3, g: 0.2, b: 0.1, hemi: 0, baked: false },
    // 30 m away: outside its cull sphere.
    { x: 30, y: 0, z: 0, intensity: 0.5, r: 1, g: 1, b: 1, hemi: 0, baked: false },
  ];
  const off = engineLights.addProvider((out) => out.push(...lights));
  const dir = engineLights.addDirectional();
  dir.on = true;
  dir.exclusive = true;
  dir.color.setRGB(0.05, 0, 0, THREE.LinearSRGBColorSpace);
  try {
    engineLights.update(scene, cam, null, null);
    const c = engineLights.particleLight(new THREE.Vector3(0, 0, 0), new THREE.Color());
    close(c.r, 0.1 + 0.05 + 0.3, 1e-5);
    close(c.g, 0.1 + 0.2, 1e-5);
    close(c.b, 0.12 + 0.1, 1e-5);
    // A strong light saturates at 1.
    lights[0].r = 2;
    engineLights.update(scene, cam, null, null);
    close(engineLights.particleLight(new THREE.Vector3(), new THREE.Color()).r, 1);
  } finally {
    off();
    dir.remove();
  }
});

test('BouncingObject own launch: -local Z x p1, gravity (p46 +- p47) %, lifetime p12; bounce keeps (1 - GMP p4)(1 - p51)', () => {
  const t: PropValue[] = [];
  t[1] = 20000;
  t[12] = 25;
  t[46] = 75;
  t[47] = 5;
  // Rotation 0 in the port's instance matrix: local Z is world -x, so the launch is +x.
  const M = new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(409.9, 101.68, 508.02);
  const l = bouncingLaunch(t, M, 10.4, 0.5);
  close(l.vel.x, 20000 / 2048, 1e-6);
  close(l.vel.z, 0, 1e-6);
  close(l.gravity, 0.75 * 10.4);
  close(bouncingLaunch(t, M, 10.4, 1).gravity, 0.8 * 10.4);
  assert.equal(l.life, 25);
  close(bounceKeep(35), 0.65);
  close(bounceKeep(35, 50), 0.325);
  const v = new THREE.Vector3(3, -4, 0);
  assert.equal(bounceVelocity(v, { x: 0, y: 1, z: 0 }, 0.5), true);
  close(v.x, 1.5);
  close(v.y, 2);
  // A contact it already moves away from is ignored.
  assert.equal(bounceVelocity(v, { x: 0, y: 1, z: 0 }, 0.5), false);
  close(v.y, 2);
});

test('retail: spark textures are white with their shape in the alpha (additive particles must use it)', { skip }, () => {
  const f = readSrsc('COMMON/Resources/Resources.tdu');
  for (const id of [1830, 1808]) {
    const e = f.byType(TEXTURE_ENTRY_TYPE).find((x) => x.id === id)!;
    const t = decodeTexture(f, e)!;
    const at = (x: number, y: number) => Array.from(t.rgba.slice(4 * (y * t.width + x), 4 * (y * t.width + x) + 4));
    let whiteSoft = 0;
    for (let i = 0; i < t.width * t.height; i++) {
      const [r, g, b, a] = at(i % t.width, Math.floor(i / t.width));
      if (r > 200 && g > 200 && b > 200 && a < 128) whiteSoft++;
    }
    assert.ok(whiteSoft > 0.05 * t.width * t.height, `4:${id}: ${whiteSoft} bright texels with a soft alpha`);
  }
});

test('retail: 1a gravity, the p48 sparks and lit blood, the hat generator and its cap', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  let ents: ReturnType<typeof parseEntities>;
  try {
    packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    ents = parseEntities(lvl, packages, { resolveStrings: false });
  } finally {
    console.warn = warn;
  }
  const lp = ents.find((e) => e.className === 'Level Properties')!;
  assert.deepEqual([lp.values[18], +(lp.values[19] as number).toFixed(2)], [2175, 9.8]);
  close(levelGravity(lp.values), 10.4077, 1e-3);
  // Metal impact sparks 4:1148 and the shiv blood 4:1141 are p48 streaks; the mouth blood is lit.
  assert.equal(fountainStreak(readTemplate(packages, { pkg: 4, id: 1148 })!.values), true);
  assert.equal(fountainStreak(readTemplate(packages, { pkg: 4, id: 1141 })!.values), true);
  // The 4:1162 sparks are not streaks: plain glows.
  for (const id of [1160, 1161, 1163, 1164, 1165, 1166]) assert.equal(fountainStreak(readTemplate(packages, { pkg: 4, id })!.values), false);
  const mouth = readTemplate(packages, { pkg: 3, id: 2358 })!.values;
  assert.deepEqual([mouth[46], mouth[33]], [3, 0x3f3f3f]);
  // Hat Gen 7047: rotation 0, generator 3:1480 hands its cap 3:1481 no launch of its own.
  const gen = ents.find((e) => e.uid === 0x7047)!;
  assert.deepEqual(gen.rotation, [0, 0, 0]);
  const cap = readTemplate(packages, { pkg: 3, id: 1481 })!.values;
  assert.deepEqual([cap[1], cap[2], cap[12], cap[46], cap[47], cap[49], cap[51], cap[58]], [20000, 20000, 25, 75, 5, 0, 35, 0]);
});
