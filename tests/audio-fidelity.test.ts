// Footsteps, Sound Effect play modes and STOMP sound keys (docs/re/audio.md §12-§14): the
// original's rules as pure functions, and the retail 1a data they act on (metal detectors,
// the Horace scene's electric hum).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { nodeFS, readSrsc, skip } from './helpers';
import { fpStepTimer, FP_STEP_INTERVAL, retimeMarkers } from '../src/game/fx/footsteps';
import { cycleEventTime } from '../src/game/actors/gait';
import { sfxExhausted, sfxInterval, sfxPick, sfxRetriggers } from '../src/game/world/sound-effect';
import { stompKeyGain, stompVoiceEnd } from '../src/app/audio-rules';
import { World, type SoundPlayback, type WorldHooks, type Vec3 } from '../src/game/world/logic';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { indexSoundsLazy, type SoundInfo } from '../src/formats/sound';

test('first-person steps: a Light step every p156 s at full stick, slower with a half stick', () => {
  const run = (stick: number, secs: number) => {
    let timer = FP_STEP_INTERVAL, n = 0;
    for (let f = 0; f < Math.round(secs * 60) + 1; f++) {
      const r = fpStepTimer(timer, stick, 1 / 60, FP_STEP_INTERVAL);
      timer = r.timer;
      if (r.step) n++;
    }
    return n;
  };
  assert.equal(run(1, 4.2), 10, '0.4 s apart, walking or running');
  assert.equal(run(0.5, 4.2), 5);
  assert.equal(run(0, 4.2), 0, 'standing still never steps');
  // The timer keeps its remainder between moves.
  assert.deepEqual(fpStepTimer(0.1, 1, 0.05, 0.4), { timer: 0.05, step: false });
  assert.deepEqual(fpStepTimer(0.05, 1, 0.05, 0.4), { timer: 0.4, step: true });
});

test('gait cycles fire their source clip markers at the source footfalls, re-timed', () => {
  // Run 328:28 (0.733 s, Heavy at 0.168 / 0.527) as a 0.70 s cycle starting at phase 0.2.
  const m = retimeMarkers([{ time: 0.168, kind: 1 }, { time: 0.527, kind: 1 }], 0.733, 0.2, 0.7);
  assert.equal(m.length, 2);
  for (const x of m) assert.equal(x.kind, 1);
  const expect = [0.168, 0.527].map((t) => ((((t / 0.733 - 0.2) % 1) + 1) % 1) * 0.7).sort((a, b) => a - b);
  assert.ok(Math.abs(m[0].time - expect[0]) < 1e-9 && Math.abs(m[1].time - expect[1]) < 1e-9);
  // Half a cycle apart in the source stays half a cycle apart (no bunched pairs).
  assert.ok(Math.abs(m[1].time - m[0].time - ((0.527 - 0.168) / 0.733) * 0.7) < 1e-9);
  assert.equal(cycleEventTime(0.2 * 0.733, 0.733, 0.2, 0.7), 0, 'the cycle starts at the source phase');
});

test('Sound Effect play modes: interval p6 +- p7 + p13, shuffle rounds, mode 4 exhaustion', () => {
  assert.equal(sfxInterval(6, 1.5, 0, 0.5), 6);
  assert.equal(sfxInterval(6, 1.5, 0, 0), 4.5);
  assert.equal(sfxInterval(6, 1.5, 0.8, 1), 8.3);
  assert.equal(sfxInterval(1, 3, 0, 0), 0, 'never negative');
  assert.deepEqual([0, 1, 2, 3, 4].map(sfxRetriggers), [false, false, true, true, true]);
  // Shuffle: every sound once per round, whatever the rolls.
  const used = new Set<number>();
  const picks = [0.1, 0.1, 0.1, 0.1].map((r) => sfxPick(3, 4, used, r));
  assert.deepEqual([...picks].sort(), [0, 1, 2, 3]);
  assert.equal(sfxPick(3, 4, used, 0.9), 3, 'a new round starts once all were played');
  assert.equal(sfxPick(0, 4, new Set(), 0.99), 3);
  assert.equal(sfxExhausted(4, 3, 3), false);
  assert.equal(sfxExhausted(4, 4, 3), true);
  assert.equal(sfxExhausted(2, 99, 3), false);
});

test('STOMP sound keys: key x header volume clamped to 1; a voice is cut after one pass', () => {
  assert.equal(stompKeyGain(1, 0.5), 0.5);
  assert.equal(stompKeyGain(2.5, 0.8), 1);
  assert.equal(stompKeyGain(-1, 1), 0);
  assert.equal(stompVoiceEnd(10, 6.79), 16.79);
});

async function data1a() {
  const LEVEL = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const fs = nodeFS();
  const lvl = readSrsc(LEVEL);
  const warn = console.warn;
  console.warn = () => {};
  const paths = new Map<number, string>();
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(fs, dirname(LEVEL), readLevelHeader(lvl).dependencies, () => {}, paths)) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const sounds = new Map<string, SoundInfo>();
  for (const [id, base] of paths) {
    const sdu = await fs.resolve(`${base}.sdu`);
    if (sdu) for (const s of await indexSoundsLazy((o, n) => fs.readRange!(sdu, o, n), id)) sounds.set(s.key, s);
  }
  return { LEVEL, lvl, packages, sounds };
}

test('1a metal detectors: walking through gate Detector 8957 starts Sound Effect 8147 (3:297, repeating, header range)', { skip }, async () => {
  const { LEVEL, lvl, packages, sounds } = await data1a();
  let feet: Vec3 = [0, -1000, 0];
  const plays: { uid: number; keys: string[]; opts: { radius?: number; loop?: boolean } }[] = [];
  const stops: number[] = [];
  const hooks: WorldHooks = {
    player: () => ({ feet, eye: [feet[0], feet[1] + 1.6, feet[2]], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: (uid, keys, _p, opts) => {
      plays.push({ uid, keys, opts });
      let on = true;
      const pb: SoundPlayback = {
        stop: () => void ((on = false), stops.push(uid)),
        get playing() {
          return on;
        },
      };
      return pb;
    },
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL });
  world.start();
  world.update(0);
  // Let the level's opening sequence run out (Detectors skip a player held by a cutscene).
  world.skipCutscenes();
  for (let i = 0; i < 20; i++) world.update(0.1);
  assert.equal(world.activeCutscenes().length, 0);
  const gate = world.get(0x8957)!;
  feet = [gate.pos[0], gate.pos[1] - 1.4, gate.pos[2]];
  for (let i = 0; i < 4; i++) world.update(1 / 30);
  const alarm = plays.find((p) => p.uid === 0x8147);
  assert.ok(alarm, `alarm started (plays: ${plays.map((p) => p.uid.toString(16)).join(',')})`);
  assert.deepEqual(alarm.keys, ['3:297']);
  assert.equal(alarm.opts.radius, undefined, 'p6 = 1 is the re-trigger interval, not a range');
  assert.equal(alarm.opts.loop, true, 'play mode 1 repeats the sound until the Count Down stops it');
  const s = sounds.get('3:297')!;
  assert.ok(s.maxDistance >= 40, `header range reaches the gate 7 units below (max ${s.maxDistance})`);
  // Standing in the gate does not restart it every tick.
  const n = plays.filter((p) => p.uid === 0x8147).length;
  for (let i = 0; i < 30; i++) world.update(1 / 30);
  assert.equal(plays.filter((p) => p.uid === 0x8147).length, n);
});

test('1a Horace scene: the STOMP that starts it keys the looping electric hum 10:695', { skip }, async () => {
  const { LEVEL, lvl, packages, sounds } = await data1a();
  const hooks = { player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }), setVisible: () => {}, setTransform: () => {}, switchPose: () => {}, playSound: () => undefined, toast: () => {}, help: () => {}, requestLevel: () => {} } as WorldHooks;
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL });
  const seq = world.sequenceOf(world.get(0x80d2)!)!;
  const keys = seq.tracks.flatMap((t) => t.sounds).filter((k) => `${k.sound.pkg}:${k.sound.id}` === '10:695');
  assert.ok(keys.length >= 1);
  const hum = sounds.get('10:695')!;
  assert.equal(hum.loop, true);
  assert.equal(hum.volume, 1);
  // Played as the original does it, the loop stops after one pass (6.79 s), not forever.
  assert.ok(Math.abs(stompVoiceEnd(0, hum.duration) - 6.79) < 0.01);
});
