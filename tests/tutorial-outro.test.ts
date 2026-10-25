// 1b's first transformation (docs/game-logic.md §15.7.12 "The arena's end"): the speakers'
// lines and the Destroy, the Insanity Mode Message Filter's state-20 test, and the hallucination
// flash timer. Synthetic actors and objects; no game data needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import type { Entity } from '../src/formats/entities';
import { Character } from '../src/app/character';
import { Actor, type ActorEnv } from '../src/game/actors/actor';
import type { Behavior, DialogLine } from '../src/game/actors/behaviors';
import type { CreatureKind } from '../src/game/actors/kinds';
import { flashPeriod, insaneState, InsanityClasses, type ClassEnv } from '../src/game/insanity/classes';
import type { WorldEntity } from '../src/game/world/logic';
import { dirname } from '../src/app/gamefs';
import { loadPackages } from '../src/app/loader';
import { parseLevelObjects, readLevelHeader } from '../src/formats/level';
import { levelSoundEmitters, type SoundLookup } from '../src/formats/sound';
import { nodeFS, readSrsc, skip } from './helpers';

function rig(): SkinnedModel {
  const bones = [-1, 0].map((parent, index) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, index * 0.5, 0, 1]);
    return { index, hash: 0x1000 + index, name: `b${index}`, parent, children: [] as number[], inverseBind: m, bindWorld: m, position: [0, index ? 0.5 : 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
  });
  bones[0].children.push(1);
  const skeleton: Skeleton = { version: 1, vertexCount: 0, bones, byHash: new Map(bones.map((b) => [b.hash, b.index])), sphere: { center: [0, 0, 0], radius: 1 }, skinIndex: new Uint16Array(), skinWeight: new Float32Array() };
  return {
    ref: { pkg: 0, id: 0 },
    animSet: 0,
    model: { ref: { pkg: 0, id: 0 }, vertexCount: 0, source: new Uint32Array(), positions: new Float32Array([0, 0, 0, 0, 1.8, 0]), normals: new Float32Array(), uvs: new Float32Array(), submeshes: [], materials: [] },
    skeleton,
    skinIndex: new Uint16Array(),
    skinWeight: new Float32Array(),
  } as unknown as SkinnedModel;
}

const IDLE: AnimClipData = {
  id: 0, animSet: 0, duration: 1, flags: 0, blendTime: 0.2, rate: 1, links: [],
  tracks: [0, 1].map((b) => ({ boneHash: 0x1000 + b, format: 0xc0, times: new Float32Array([0, 1]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), constantTranslation: [0, b ? 0.5 : 0, 0] as [number, number, number] })),
};

function kind(): CreatureKind {
  const skinned = rig();
  return {
    key: 'test:hermes', template: { pkg: 0, id: 0 }, className: 'Hermes', skinned, proto: new Character(skinned, [IDLE]),
    idle: 0, walk: -1, run: -1, attacks: [], hits: [], deaths: [], fall: -1, land: -1,
    events: [{ hitTimes: [], sounds: [] } as never], speeds: [0],
    height: 1.8, bottom: 0, anchored: true, radius: 0.4, moveSpeed: 1.5, runSpeed: 3, hostile: false, maxHealth: 100, decor: false,
  };
}

const LINE = (s: string): DialogLine => ({ anims: [], pause: 0, sounds: [s], message: 0 });
const monologue = (lines: string[], stopOnExit = true): Behavior =>
  ({
    cls: 'SimpleConversationBehavior', next: [], kind: 'talk', toPlayer: false, target: 0,
    lines: lines.map(LINE), ambient: [], gapMin: -1, gapMax: -1,
    startRange: 999, rangeHeight: 999, approach: false, nearDist: 999, nearHeight: 999, doneMessage: 0, stopOnExit,
  }) as Behavior;
const idle = { cls: 'IdleBehavior', next: [], kind: 'idle', fidgetMin: 5, fidgetMax: 10 } as unknown as Behavior;

/** A fake sound handle playing `secs` of REAL time (independent of the game clock). */
class Line {
  stopped = false;
  constructor(readonly key: string, private readonly realEnd: number, private readonly real: () => number) {}
  get playing() {
    return !this.stopped && this.real() < this.realEnd;
  }
  stop() {
    this.stopped = true;
  }
}

/** A monologue speaker; `rate` is the game clock rate (1 / 128 during a morph). */
function speaker(b: Behavior, lineSecs = 7) {
  let real = 0;
  const lines: Line[] = [];
  const entity = { uid: 0x7eb4, links: [], values: [] } as unknown as Entity;
  const a = new Actor(kind(), { x: 462, y: 80, z: 497 }, 0, 1, entity, 0x7eb4);
  const env: ActorEnv = {
    world: null as never, nav: null, player: { position: new THREE.Vector3(470, 73.7, 484) } as never, playerAlive: true, playerUid: 0x5818, time: 0, actors: [],
    damagePlayer: () => {}, damageActor: () => {}, sound: () => {}, onDeath: () => {},
    clip: () => -1, entity: () => undefined, send: () => {},
    // As the actors system's speak: the handle becomes the character's speech.
    say: (who, line) => {
      const h = new Line(line.sounds[0], real + lineSecs, () => real);
      lines.push(h);
      who.speech = h;
      return lineSecs;
    },
  };
  a.setBehavior(b, env);
  const run = (secs: number, rate = 1) => {
    for (let t = 0; t < secs; t += 1 / 30) {
      real += 1 / 30;
      env.time += rate / 30;
      a.update(rate / 30, env);
    }
  };
  return { a, env, lines, run };
}

test('a conversation line lasts as long as its sound: a slowed clock does not hold it (0x1012cf40)', () => {
  const s = speaker(monologue(['12:220', '12:216']), 7);
  s.run(0.2);
  assert.deepEqual(s.lines.map((l) => l.key), ['12:220']);
  // 3 s into the line the morph slows the clock to 1 / 128 for 3.4 s (real), then 1 again.
  s.run(2.8);
  s.run(3.4, 1 / 128);
  s.run(1.4);
  // 7.6 s of real time: the line is over and the next one has started, though only ~4.2 s of
  // game time went by (the port waited for 7 s of game time: 3.4 s late).
  assert.deepEqual(s.lines.map((l) => l.key), ['12:220', '12:216']);
});

test('a Behavior Changer replacing the conversation stops its line when p3 is set (PlayDialog exit 0x100ffc70)', () => {
  const s = speaker(monologue(['12:223']), 5);
  s.run(1);
  assert.equal(s.lines[0].playing, true);
  s.a.setBehavior(idle, s.env);
  assert.equal(s.lines[0].stopped, true, 'cut at the change');
  const keep = speaker(monologue(['12:223'], false), 5);
  keep.run(1);
  keep.a.setBehavior(idle, keep.env);
  assert.equal(keep.lines[0].stopped, false, 'p3 = 0 lets the line run out');
});

test('Destroy (the actor removed) stops the line it is saying; death stops any line (0x100e59de)', () => {
  const s = speaker(monologue(['12:216']), 7);
  s.run(1);
  s.a.dispose();
  assert.equal(s.lines[0].stopped, true, 'Hermes removed by 7eda: his line goes with him');
  const d = speaker(monologue(['12:224']), 4);
  d.run(1);
  d.a.die(d.env);
  assert.equal(d.lines[0].stopped, true);
});

test('a line that ended on its own is not stopped again by the next behaviour', () => {
  const s = speaker(monologue(['12:211']), 1);
  s.run(2);
  const l = s.lines[0];
  assert.equal(l.playing, false);
  s.a.setBehavior(idle, s.env);
  assert.equal(l.stopped, false);
});

// ---------------------------------------------------------------------------------------------
// Insanity Mode Message Filter (vt +0x4c 0x10015830) and the hallucination flashes

function classes(form: string, rate = 1, meter = 100) {
  const passed: number[] = [];
  const world = { handlers: [], of: () => [], filterPass: (w: WorldEntity) => passed.push(w.uid), destroy: () => {}, fire: () => {} };
  const model = { form, s: { meter, noTransform: false, noGain: false }, max: 100 };
  const env = {
    world, model, director: { blurs: new Set(), faders: new Set(), clocks: new Set() }, textures: { get: () => null }, pkgs: new Map(),
    playSound: () => {}, playMovie: async () => {}, inCutscene: () => false, clockRate: () => rate, log: () => {},
  } as unknown as ClassEnv;
  const c = new InsanityClasses(env);
  return { c, passed, model };
}
const filter = (uid: number, p1: number) => ({ uid, cls: 'Insanity Mode Message Filter', e: { values: [1, p1] } }) as unknown as WorldEntity;

test('Insanity Mode Message Filter tests state 20 only: the morph-in is still human, the morph-out transformed', () => {
  assert.deepEqual(['human', 'morphIn', 'creature', 'morphOut'].map(insaneState), [false, false, true, true]);
  for (const [form, a, b] of [['human', false, true], ['morphIn', false, true], ['creature', true, false], ['morphOut', true, false]] as const) {
    const k = classes(form);
    k.c.receive(filter(0x7ed5, 0), 1, 0x5818);
    k.c.receive(filter(0x8ba4, 1), 1, 0x5818);
    assert.deepEqual(k.passed, [...(a ? [0x7ed5] : []), ...(b ? [0x8ba4] : [])], form);
  }
});

const FLASH = [1, 99.9999, 50, 50, 10, 1.8, [{ pkg: 3, id: 4578 }, { pkg: 3, id: 4575 }], 1, 2];

test('hallucination flash period: k = p2 + (p3 - p2)(meter - p1)/(max - p1), x a random 1..p4 or its inverse', () => {
  // Chapter 1 (p2 = p3 = 50, p4 = 10, p5 = 1.8): 90 s x f.
  assert.ok(Math.abs(flashPeriod(FLASH as never, 100, 100, () => 0) - 1.8 * 50 * 1) < 1e-9);
  // rand 0.999: f near 10, the coin (0.999 >= 0.5) keeps it.
  assert.ok(Math.abs(flashPeriod(FLASH as never, 100, 100, () => 0.999) - 1.8 * 50 * (1 + 0.999 * 9)) < 1e-6);
  // k spans p2..p3 over the meter between p1 and the maximum.
  const v = [1, 50, 20, 80, 1, 1, [], 1, 2];
  assert.ok(Math.abs(flashPeriod(v as never, 75, 100, () => 0) - 50) < 1e-9);
  // The average rate over the frame draws: one flash every ~31 s (the port flashed every 1.8 s).
  let x = 1;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  let rate = 0;
  for (let i = 0; i < 200000; i++) rate += 1 / flashPeriod(FLASH as never, 100, 100, rnd);
  const mean = 200000 / rate;
  assert.ok(mean > 28 && mean < 35, `mean period ${mean.toFixed(1)} s`);
});

test('no hallucination flash under a slowed clock (rate < 0.95), transformed or below p1', () => {
  const w = { uid: 0x81cb, cls: 'Insanity Screen Flash', e: { values: FLASH }, destroyed: false } as unknown as WorldEntity;
  const count = (form: string, rate: number, meter: number, secs: number) => {
    const k = classes(form, rate, meter);
    const fl = (k.c.flash = { w, timer: 1, order: [] as number[] });
    // Each flash puts the timer back to 1 (the fader itself needs the templates' package).
    let n = 0;
    for (let t = 0; t < secs; t += 1 / 30) {
      const before = fl.timer;
      k.c.updateFlash(1 / 30);
      if (fl.timer > before) n++;
    }
    return n;
  };
  assert.equal(count('human', 1 / 128, 100, 300), 0);
  assert.equal(count('creature', 1, 100, 300), 0);
  assert.equal(count('human', 1, 99, 300), 0);
  const n = count('human', 1, 100, 600);
  assert.ok(n >= 8 && n <= 40, `${n} flashes in 600 s (about one per 31 s)`);
});

// ---------------------------------------------------------------------------------------------
// The "intense music": Animating Static clips read as sounds

test('retail 1b: no level emitter plays an Animating Static clip (6600 / 6676 clip 7:17 is the music track 7:17)', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {});
    // Every key "exists" here: only which properties are read as sounds is under test.
    const sounds = { get: () => ({ maxDistance: 40 }) } as unknown as SoundLookup;
    const emitters = levelSoundEmitters(parseLevelObjects(lvl), packages, sounds);
    for (const uid of [0x6600, 0x6676]) {
      const e = emitters.find((x) => x.uid === uid);
      assert.ok(!e?.soundKeys.includes('7:17'), `Animating Static ${uid.toString(16)}: p37 / p40 are clips`);
    }
  } finally {
    console.warn = warn;
  }
});
