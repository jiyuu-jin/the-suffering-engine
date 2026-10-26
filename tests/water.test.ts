// The player in water (src/game/levels/water.ts, docs/levels.md §4.2), decoded from Suffering.rfl:
// Water Volume contacts go to the Player's water-effects component, never to his mover, so
// nobody stands on water; the component's rules come from the Player template's p19..p31.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { dirname } from 'node:path';
import { CollisionWorld } from '../src/app/physics';
import { fallDamage } from '../src/app/player-rules';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../src/formats/entities';
import type { MeshPart } from '../src/formats/types';
import type { ResRef } from '../src/formats/model';
import {
  canRunAt,
  drownsAt,
  inWaterAt,
  readPlayerWaterRules,
  RETAIL_WATER_RULES as R,
  rippleStep,
  splashScale,
  wadingStep,
  waterFallFactor,
  WaterRuntime,
  type WaterEnv,
} from '../src/game/levels/water';
import { waterSurfaces } from '../src/game/fx/surfaces';
import { nodeFS, readSrsc, skip } from './helpers';

test('water rules: contact, run limit, drowning, fall factor, wading steps, splash scale', () => {
  // In water while the surface is above the feet and the proxy (2.24 m) still reaches it.
  assert.equal(inWaterAt(0, R), false);
  assert.equal(inWaterAt(0.01, R), true);
  assert.equal(inWaterAt(2.2, R), true);
  assert.equal(inWaterAt(2.3, R), false);
  // No running deeper than p25 (1.5 m); drowned deeper than p28 (2 m).
  assert.equal(canRunAt(true, 1.5, R), true);
  assert.equal(canRunAt(true, 1.51, R), false);
  assert.equal(canRunAt(false, 3, R), true);
  assert.equal(drownsAt(true, 2, R), false);
  assert.equal(drownsAt(true, 2.01, R), true);
  assert.equal(drownsAt(false, 3, R), false);
  // Fall damage x (1 - p27 %)^depth: a 7.7 m drop into 1.5 m of water is no longer lethal.
  assert.equal(waterFallFactor(false, 1, R), 1);
  assert.ok(Math.abs(waterFallFactor(true, 1.5, R) - Math.pow(0.9, 1.5)) < 1e-9);
  assert.equal(fallDamage(7.7, 100, 100), 100);
  assert.ok(Math.abs(fallDamage(7.7, 100, 100, waterFallFactor(true, 1.5, R)) - 100 * Math.pow(0.9, 1.5)) < 1e-9);
  // Footsteps: the surface's own step under p21 (0.5 m), p17 to p25 (1.5 m), p18 deeper.
  assert.equal(wadingStep(0.3, R), 'surface');
  assert.equal(wadingStep(0.5, R), 17);
  assert.equal(wadingStep(1.6, R), 18);
  // The entry splash of the Player is always scale 1 (p24 = 1).
  assert.equal(splashScale(10, 2, R), 1);
  assert.ok(Math.abs(splashScale(5, 0, { ...R, splashMax: 4 }) - 2) < 1e-9);
});

test('water rules: ripples every (1 + rand) p20, the running wake every p19, none running in the shallows', () => {
  assert.deepEqual(rippleStep(0, 0.016, 1, false, R, () => 0.5), { timer: 0.75, spawn: 15 });
  assert.deepEqual(rippleStep(0.75, 0.25, 1, false, R), { timer: 0.5, spawn: null });
  assert.deepEqual(rippleStep(0, 0.016, 1, true, R), { timer: 0.03, spawn: 16 });
  assert.deepEqual(rippleStep(0, 0.016, 0.3, true, R), { timer: 0, spawn: null });
  assert.deepEqual(rippleStep(0, 0.016, 0.3, false, R, () => 0), { timer: 0.5, spawn: 15 });
});

const plane = (y: number, s = 20): MeshPart => ({ positions: new Float32Array([0, y, 0, s, y, 0, 0, y, s, s, y, s]), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) }) as unknown as MeshPart;

/** `rand`: the ripple interval's random factor (deterministic: Math.random made this test flaky). */
function rig(rand: () => number = () => 0.5) {
  const surfaces = new CollisionWorld({ parts: [plane(84)] });
  const body = { position: new THREE.Vector3(10, 85, 10), pitch: 0, canRun: true, eyePosition: () => body.position.clone().add(new THREE.Vector3(0, 1.6, 0)) };
  const log: string[] = [];
  let alive = true, running = false;
  const entry = [] as unknown[];
  entry[15] = { pkg: 4, id: 1294 };
  entry[16] = { pkg: 4, id: 1288 };
  entry[19] = { pkg: 4, id: 1305 };
  const env: WaterEnv = {
    entry: () => entry as never,
    spawn: (r: ResRef) => log.push(`${r.pkg}:${r.id}`),
    alive: () => alive,
    running: () => running,
    speed: () => 3,
    drown: (clip) => {
      log.push(`drown ${clip}`);
      alive = false;
    },
    random: rand,
  };
  const w = new WaterRuntime(surfaces, body, () => true, R, env);
  return { w, body, log, set: (o: { alive?: boolean; running?: boolean }) => ((alive = o.alive ?? alive), (running = o.running ?? running)) };
}

test('water runtime: entry splash p19, ripples, the run limit and drowning with p29', () => {
  const { w, body, log, set } = rig();
  w.update(0.016);
  assert.equal(w.player.inWater, false, 'feet above the surface');
  assert.deepEqual(log, []);
  // Wading in 1 m: the entry splash, then ripples while standing.
  body.position.y = 83;
  w.update(0.016);
  assert.equal(w.player.inWater, true);
  assert.ok(Math.abs(w.player.depth - 1) < 1e-3);
  assert.deepEqual(log.slice(0, 2), ['4:1305', '4:1294']);
  assert.equal(body.canRun, true);
  // Running: once the ripple timer ((1 + 0.5) x 0.5 = 0.75 s) runs out, the wake p16 every p19
  // (0.03 s: every second 16 ms update). The timer expires in update 47; wakes in 47, 49 .. 79.
  set({ running: true });
  log.length = 0;
  for (let i = 0; i < 80; i++) w.update(0.016);
  assert.equal(log.length, 17, log.join(' '));
  assert.ok(log.every((k) => k === '4:1288'), log.join(' '));
  // 1.8 m: no running; 2.1 m: drowned, the view eased toward p31.
  body.position.y = 82.2;
  w.update(0.016);
  assert.equal(body.canRun, false);
  assert.equal(w.player.drowned, false);
  body.position.y = 81.9;
  log.length = 0;
  w.update(0.016);
  assert.deepEqual(log.filter((k) => k.startsWith('drown')), ['drown 325']);
  assert.equal(w.player.drowned, true);
  for (let i = 0; i < 60; i++) w.update(0.016);
  assert.ok(Math.abs(body.pitch - (15 * Math.PI) / 180) < 1e-6, `pitch ${body.pitch}`);
  // Out of reach of the surface (deeper than the proxy's top): no contact, nothing in water.
  set({ alive: true });
  body.position.y = 81;
  w.update(0.016);
  assert.equal(w.player.inWater, false);
  assert.equal(w.player.drowned, false);
  w.dispose();
  assert.equal(waterSurfaces.wade, undefined);
});

test('water runtime: the ripple interval uses the random factor it is given (no Math.random)', () => {
  const real = Math.random;
  Math.random = () => {
    throw new Error('Math.random');
  };
  try {
    // The longest interval (rand -> 1: 1 s): the wake starts in update 63, then 63, 65 .. 79.
    const { w, body, log, set } = rig(() => 0.999);
    w.update(0.016);
    body.position.y = 83;
    w.update(0.016);
    assert.deepEqual(log, ['4:1305', '4:1294']);
    set({ running: true });
    log.length = 0;
    for (let i = 0; i < 80; i++) w.update(0.016);
    assert.equal(log.length, 9, log.join(' '));
    w.dispose();
  } finally {
    Math.random = real;
  }
});

test('retail: the Player template 2:5 carries the water rules', { skip }, async () => {
  const L = 'LEVELS/8 Bluff/8a Bluff.lvl';
  const lvl = readSrsc(L);
  const warn = console.warn;
  console.warn = () => {};
  const pkgs = await loadPackages(nodeFS(), dirname(L), readLevelHeader(lvl).dependencies, () => {});
  console.warn = warn;
  const t = readObjectTemplate(pkgs as never, { pkg: 2, id: 5 })!;
  const v = decodeTemplateProps(classByHash(t.classHash), t);
  const r = readPlayerWaterRules(v, pkgs);
  assert.deepEqual(
    [r.wakeInterval, r.rippleInterval, r.shallow, r.splashSpeed, r.splashDepthPct, r.splashMax, r.deep, r.fallPct, r.drown, r.drownClip, r.drownPitchTime, r.drownPitch].map((x) => +x.toFixed(3)),
    [0.03, 0.5, 0.5, 0.4, 10, 1, 1.5, 10, 2, 325, 0.5, 15],
  );
  // The proxy (p91 = Collider 2:44): foot sphere r 0.6, top 2.239 m above the feet.
  assert.deepEqual(v[91], { pkg: 2, id: 44 });
  assert.ok(Math.abs(r.contactTop - 2.239) < 1e-3, `${r.contactTop}`);
  // The water entry of the Player Material Effects list (p145): p15 ripples, p16 the wake, p17 /
  // p18 the wading steps, p19 the entry splash (an Object Generator with the splash sounds).
  const entry = (v[145] as ResRef[]).map((x) => readObjectTemplate(pkgs as never, x)!).find((x) => JSON.stringify(decodeTemplateProps(classByHash(x.classHash), x)[0]) === JSON.stringify({ id: 879, pkg: 2 }))!;
  const ev = decodeTemplateProps(classByHash(entry.classHash), entry);
  assert.equal(classByHash(entry.classHash)?.name, 'Player Water Material Effects');
  assert.deepEqual([ev[15], ev[16], ev[19]], [{ pkg: 4, id: 1294 }, { pkg: 4, id: 1288 }, { pkg: 4, id: 1305 }].map((x) => ({ id: x.id, pkg: x.pkg })));
  assert.equal((ev[17] as unknown[]).length, 5);
  assert.equal((ev[18] as unknown[]).length, 4);
});
