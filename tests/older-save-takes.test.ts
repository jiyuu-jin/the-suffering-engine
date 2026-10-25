// Saves written before a sequence's take showed a Character (before 45f4dd8) are repaired on
// load (docs/game-logic.md §15.7.12 "Saved games"): such a level record has no fx.bodyParts
// entry, so that provider's `absent` runs; it shows the Characters played sequences took
// (World.showTakenCharacters) and gives them what the sequences' 154 / 206..209 keys left
// (BodyParts.replay). 1b's Hermes 7eb4 after "Camera" #247 came back hidden, at his creation
// fade (0) and without his gas from a checkpoint made after the scene on 8fb255e.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { parseEntities, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World, type WorldHooks } from '../src/game/world/logic';
import { SaveRegistry, type LoadInfo } from '../src/game/save/registry';
import { worldSaveProvider } from '../src/game/save/providers';
import { BodyParts, SPAWN_ATTACHMENTS, START_FADE_IN, STOP_FADE_IN } from '../src/game/fx/body-parts';
import type { Character } from '../src/app/character';
import { nodeFS, readSrsc, skip } from './helpers';

const info: LoadInfo = { reason: 'load', levelPath: 'x', version: 1 };

test('a provider missing from a save gets absent(), in priority order; present ones get load()', () => {
  const r = new SaveRegistry();
  const calls: string[] = [];
  r.register('a', { save: () => 1, load: () => calls.push('load a'), absent: () => calls.push('absent a') }, { priority: 0 });
  r.register('c', { save: () => 1, load: () => calls.push('load c'), absent: () => calls.push('absent c') }, { priority: 12 });
  r.register('b', { save: () => 1, load: () => calls.push('load b') }, { priority: 10 });
  r.register('g', { save: () => 1, load: () => calls.push('load g'), absent: () => calls.push('absent g') }, { scope: 'game' });
  assert.deepEqual(r.apply({ a: 1, b: 2 }, 'level', info), ['a', 'b']);
  assert.deepEqual(calls, ['load a', 'load b', 'absent c']);
  calls.length = 0;
  r.apply(undefined, 'level', info);
  assert.deepEqual(calls, [], 'no record of the level: nothing to rebuild');
  r.apply({ a: 1, b: 2, c: 3 }, 'level', info);
  assert.deepEqual(calls, ['load a', 'load b', 'load c']);
  calls.length = 0;
  // One provider failing does not stop the others.
  r.register('a', { save: () => 1, load: () => {}, absent: () => { throw new Error('x'); } }, { priority: 0 });
  const err = console.error;
  console.error = () => {};
  try {
    r.apply({ b: 2 }, 'level', info);
  } finally {
    console.error = err;
  }
  assert.deepEqual(calls, ['load b', 'absent c']);
});

test('replayed sequence keys leave a fade\'s end and the gas set, and fire nothing', () => {
  const spawned: number[] = [];
  const fired: number[] = [];
  const parts = { spawnParts: (uid: number) => (spawned.push(uid), 6), removeAt: () => 0 };
  const values: PropValue[] = [];
  values[180] = 0;
  values[181] = 85;
  values[182] = 0; // 1b's Hermes: created faded out
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial());
  const c = { uid: 0x7eb4, cls: 'Hermes', values, ch: { mesh, current: undefined } as unknown as Character };
  const b = new BodyParts({ pkgs: new Map(), parts, fire: (_u, slot) => fired.push(slot) });
  b.update(0, [c]);
  assert.equal(b.opacityOf(0x7eb4), 0);
  // #247's keys in order: 154, then 206 (alone it would take the clip's time), then 207.
  assert.equal(b.replay(c, SPAWN_ATTACHMENTS), true);
  assert.equal(b.replay(c, START_FADE_IN), true);
  assert.ok(Math.abs(b.opacityOf(0x7eb4)! - 0.85) < 1e-6, 'a fade start alone is replayed to its end');
  assert.equal(b.replay(c, STOP_FADE_IN), true);
  assert.ok(Math.abs(b.opacityOf(0x7eb4)! - 0.85) < 1e-6);
  assert.ok(Math.abs((mesh.material as THREE.Material).opacity - 0.85) < 1e-6, 'drawn at 85 %');
  assert.deepEqual(spawned, [0x7eb4]);
  assert.deepEqual(fired, [], '206\'s output p34 went out when the key played');
  assert.equal(b.replay(c, 1), false, 'other messages are not this repair\'s');
  assert.equal(b.replay(c, 151), false, 'SpawnItem needs a bone a sequence key has not got');
});

async function load1b() {
  const path = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const hooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  } as unknown as WorldHooks;
  return () => {
    const world = new World(parseEntities(lvl, packages, { resolveStrings: false }), packages, hooks, { levelPath: path });
    world.start();
    world.update(0);
    return world;
  };
}

test('retail 1b: a save from before take-shows brings Hermes back after "Camera" #247', { skip }, async () => {
  const make = await load1b();
  // The save as 8fb255e wrote it after the scene: 7f41 played, Hermes still hidden.
  const old = make();
  const oldSaves = worldSaveProvider(old); // the baseline: right after start
  old.get(0x7f41)!.s.played = true;
  assert.equal(old.get(0x7eb4)!.visible, false);
  const saved = JSON.parse(JSON.stringify(oldSaves.save()));
  const world = make();
  worldSaveProvider(world).load(saved, info);
  assert.equal(world.get(0x7eb4)!.visible, false, 'as saved');
  const msgs: [number, number][] = [];
  world.replayPlayedSequences({ send: (uid, msg) => uid === 0x7eb4 && msgs.push([uid, msg]) });
  assert.deepEqual(
    msgs.filter(([, m]) => m === 154 || (m >= 206 && m <= 209)).map(([, m]) => m),
    [154, 206, 207],
    'the scene gives him his gas and the fade in',
  );
  assert.deepEqual(world.showTakenCharacters(), [0x7eb4], 'Hermes; not Killjoy 7eb5, whom his projector shows and hides');
  assert.equal(world.get(0x7eb4)!.visible, true);
  assert.deepEqual(world.showTakenCharacters(), [], 'once');

  // A save that has the take's result: nothing to change.
  const now = make();
  now.send(0x7f41, 1);
  now.update(1 / 30);
  now.skipCutscenes();
  now.update(0.1);
  assert.equal(now.get(0x7eb4)!.visible, true);
  assert.deepEqual(now.showTakenCharacters(), []);

  // The scene not played yet: nothing taken.
  assert.deepEqual(make().showTakenCharacters(), []);

  // After the transformation the arena's Relay 7eda destroys Hermes: he stays gone.
  const gone = make();
  gone.get(0x7f41)!.s.played = true;
  gone.send(0x7eda, 1);
  gone.update(0.1);
  assert.equal(gone.get(0x7eb4)!.destroyed, true);
  assert.deepEqual(gone.showTakenCharacters(), []);
  assert.equal(gone.get(0x7eb4)!.visible, false);
});
