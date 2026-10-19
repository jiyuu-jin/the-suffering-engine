// Object Generator runtime (Suffering.rfl vtable 0x10155710; docs/game-logic.md §14.2): run time
// p21, run count p22, spawn timer p7 ± p8, player range p28 / p29 / p30, p5 destroying its spawns,
// and the 1a chair-room fire chain (12:715 -> 12:779 -> 12:773 / 12:775) staying bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { nodeFS, readSrsc, skip } from './helpers';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { readLevelHeader } from '../src/formats/level';
import type { EntityPackageSet, PropValue } from '../src/formats/entities';
import { Emitter, Fx, Generator, generatorInRange, generatorInterval, GENERATOR_STOP_LIFE } from '../src/game/world/fx';

/** Generator values: p5, p6, p7, p8, p21, p22, p24, p28.. set by key. */
function gen(o: Record<number, PropValue>): PropValue[] {
  const v: PropValue[] = new Array(39).fill(0);
  v[0] = [{ pkg: 1, id: 1 }];
  v[6] = 2;
  for (const [k, x] of Object.entries(o)) v[Number(k)] = x;
  return v;
}

/** A stand-in Fx that counts firings (in range or not). */
function fakeFx() {
  const fired: boolean[] = [];
  const fx = {
    emitters: [] as Emitter[],
    generators: [] as Generator[],
    spawnList(_gv: PropValue[], _M: THREE.Matrix4, _ctx: unknown, _pick: unknown, inRange = true) {
      fired.push(inRange);
    },
  };
  return { fx: fx as unknown as Fx, fired, raw: fx };
}

function run(g: Generator, seconds: number, dt = 1 / 60, near = true, player?: [number, number, number]) {
  for (let t = 0; t < seconds - 1e-9; t += dt) g.update(dt, near, player);
}

test('Object Generator timer: p7 plus a uniform pick in [-p8, p8] (0x100b5ed0)', () => {
  const v = gen({ 7: 1, 8: 0.3 });
  assert.equal(generatorInterval(v, () => 0), 0.7);
  assert.ok(Math.abs(generatorInterval(v, () => 1) - 1.3) < 1e-9);
  assert.equal(generatorInterval(gen({ 7: 0.05 }), () => 0.5), 0.05);
});

test('Object Generator range: p28 m from the player, 3D; p29 / p30 make it a height window and horizontal', () => {
  assert.equal(generatorInRange(gen({}), [500, 0, 0]), true, 'no p28: anywhere');
  assert.equal(generatorInRange(gen({ 28: 50 }), undefined), true, 'no player: spawns');
  assert.equal(generatorInRange(gen({ 28: 50 }), [28, 28, 28]), true, '48.5 m');
  assert.equal(generatorInRange(gen({ 28: 50 }), [29, 29, 29]), false, '50.2 m');
  const w = gen({ 28: 10, 29: 2, 30: 1 });
  assert.equal(generatorInRange(w, [9, 1.9, 0]), true, 'height is not part of the distance');
  assert.equal(generatorInRange(w, [0, 2.1, 0]), false, 'above p29');
  assert.equal(generatorInRange(w, [0, -1.1, 0]), false, 'below p30');
  assert.equal(generatorInRange(w, [8, 0, 7]), false, 'horizontal 10.6 m');
});

test('Object Generator run: fires every p7 while its p21 run lasts, then p22 = 1 destroys it (12:779)', () => {
  const { fx, fired } = fakeFx();
  const g = new Generator(gen({ 6: 1, 7: 0.05, 21: 0.6, 22: 1, 24: 1 }), new THREE.Matrix4(), fx);
  assert.equal(g.endless, false);
  g.trigger();
  run(g, 2);
  // The timer is set afresh (no carry-over), so a 0.05 s timer fires every 3 or 4 frames at
  // 60 fps: 9 .. 12 firings in 0.6 s.
  assert.ok(fired.length >= 9 && fired.length <= 12, String(fired.length));
  assert.equal(g.dead, true, 'its only run is over: destroyed');
  assert.equal(g.running, false);
});

test('Object Generator run count: p22 0 stops after the run and starts again on On; mode 2 fires once a run', () => {
  const { fx, fired } = fakeFx();
  // 1a's STOMP blood generators 7489 / 7f1b: p6 2, p7 1, p21 0.1, p22 0.
  const g = new Generator(gen({ 6: 2, 7: 1, 21: 0.1, 22: 0 }), new THREE.Matrix4(), fx);
  g.trigger();
  run(g, 1);
  assert.equal(fired.length, 1, 'p21 0.1 s < p7 1 s: one firing');
  assert.equal(g.running, false);
  assert.equal(g.dead, false, 'p22 0: any number of runs');
  g.trigger();
  run(g, 1);
  assert.equal(fired.length, 2, 'a later On fires again');
  const two = new Generator(gen({ 7: 1, 21: 0.1, 22: 2 }), new THREE.Matrix4(), fx);
  two.trigger();
  run(two, 0.5);
  assert.equal(two.dead, false);
  two.trigger();
  run(two, 0.5);
  assert.equal(two.dead, true, 'p22 2: gone after the second run');
});

test('Object Generator Stop: life 1e-4 s, so the run ends at the next think (0x100b4350)', () => {
  const { fx, fired } = fakeFx();
  const g = new Generator(gen({ 6: 1, 7: 0.5, 21: 0, 22: 0 }), new THREE.Matrix4(), fx);
  assert.equal(g.endless, true);
  g.trigger();
  run(g, 1.2);
  assert.equal(fired.length, 3, 'endless: t 0, 0.5, 1.0');
  g.stop();
  g.update(1 / 60, true);
  assert.equal(g.running, false);
  assert.equal(GENERATOR_STOP_LIFE, 0.0001);
  run(g, 2);
  assert.equal(fired.length, 3, 'off');
  const once = new Generator(gen({ 6: 1, 7: 0.5, 21: 0, 22: 1 }), new THREE.Matrix4(), fx);
  once.trigger();
  once.update(1 / 60, true);
  once.stop();
  once.update(1 / 60, true);
  assert.equal(once.dead, true, 'stopping a one-run generator ends its only run');
});

test('Object Generator endless (p21 0): thinks only when seen (engine state 4); the range gates the spawns, not the timer', () => {
  const { fx, fired } = fakeFx();
  const g = new Generator(gen({ 6: 1, 7: 1, 21: 0, 22: 1, 28: 50 }), new THREE.Matrix4(), fx);
  g.trigger();
  run(g, 3, 1 / 60, false);
  assert.equal(fired.length, 0, 'not seen: no think');
  run(g, 2.5, 1 / 60, true, [60, 0, 0]);
  assert.deepEqual(fired, [false, false, false], 'out of range: the timer runs, nothing spawns');
  run(g, 1, 1 / 60, true, [10, 0, 0]);
  assert.equal(fired.at(-1), true);
  assert.equal(g.dead, false, 'never ends by itself');
});

test('Object Generator p5: destroying it destroys what it spawned (0x100b49e0); without p5 they stay', () => {
  for (const p5 of [1, 0]) {
    const { fx, raw } = fakeFx();
    const child = new Generator(gen({ 7: 1, 21: 0, 22: 0 }), new THREE.Matrix4(), fx);
    const em = { destroyed: 0, destroy() { this.destroyed++; } };
    raw.spawnList = () => {
      raw.generators.push(child);
      raw.emitters.push(em as unknown as Emitter);
    };
    const g = new Generator(gen({ 5: p5, 7: 1, 21: 0.1, 22: 1 }), new THREE.Matrix4(), fx);
    g.trigger();
    run(g, 0.5);
    assert.equal(g.dead, true);
    assert.equal(child.dead, p5 === 1);
    assert.equal(em.destroyed, p5);
  }
});

test('retail: a broken chair-room generator (12:715) leaves one endless 12:775 (and at most three Fires), not a flood', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(readSrsc(path)).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const made = new Map<string, number>();
  const fx = new Fx({
    packages,
    dyn: {} as never,
    collision: null,
    playSound: () => undefined,
    timeScale: () => 1,
    // Everything but generators is counted, not built.
    spawnOther: (t) => t.cls !== 'Object Generator' && (made.set(t.cls, (made.get(t.cls) ?? 0) + 1), true),
    playerPos: () => [3, 0, 0],
  });
  fx.spawn({ pkg: 12, id: 715 }, new THREE.Matrix4());
  assert.equal(made.get('Breakable'), 1, 'the broken generator 12:716');
  let most = 0;
  for (let t = 0; t < 30; t += 1 / 30) {
    fx.updateGenerators(1 / 30);
    most = Math.max(most, fx.generators.length);
  }
  // 12:779 takes its entries in order from entry 1; whether its 0.6 s reach entry 0 (12:773, three
  // Fires in its 0.65 s) depends on the frame times. 12:775 (entry 9) always comes.
  assert.ok([0, 3].includes(made.get('Fire') ?? 0), String(made.get('Fire')));
  assert.equal(fx.generators.filter((g) => g.endless).length, 1, 'one endless 12:775 is left');
  assert.ok(fx.generators.length <= 2, 'besides it at most the 12:768 it fired this frame');
  assert.ok(most <= 4, `at most a handful at once (${most})`);
  const fountains = made.get('Particle Fountain') ?? 0;
  assert.ok(fountains > 20 && fountains < 60, `12:775 -> 12:768 about once a second (${fountains})`);
});
