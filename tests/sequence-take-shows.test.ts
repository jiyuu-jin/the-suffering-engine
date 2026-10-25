// A sequence taking a hidden character over shows it (docs/game-logic.md §7 "Control keys"):
// the STOMP control key sends the object 0x1001, and the Character message handler's case for it
// ends in SetVisible(1) (Suffering.rfl 0x100e3ab0 -> 0x100e19e0 -> vt +0x128). 1b's Hermes 7eb4
// (instance flags 0: hidden) rises from the valves in "Camera" #247 (STOMP Player 7f41) with no
// hide / show key on his track; the port never showed him. Synthetic checks run everywhere; the
// retail one needs the game data. Also: a saved game keeps a Character's fade (fx/body-parts.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { StompRun, type StompSequence, type StompSink, type StompTrack } from '../src/game/world/stomp';
import { stompTakeShows, World, type WorldHooks } from '../src/game/world/logic';
import { nodeFS, readSrsc, skip } from './helpers';
import * as THREE from 'three/webgpu';
import type { PropValue } from '../src/formats/entities';
import type { Character } from '../src/app/character';
import { BodyParts, START_FADE_IN, STOP_FADE_IN } from '../src/game/fx/body-parts';

const track = (uid: number, controls: { time: number; release: boolean }[]): StompTrack => ({
  name: 't',
  index: 1,
  uid,
  flags: 0x10,
  keyCount: controls.length,
  transforms: [],
  anims: [],
  sounds: [],
  attaches: [],
  controls,
  visibility: [],
  messages: [],
  cameras: [],
});

test('control keys reach the sink in time order, played or skipped', () => {
  const seq: StompSequence = {
    id: 1,
    flags: 0x46,
    length: 20,
    duration: 4,
    byteLength: 0,
    tracks: [track(0x100, [{ time: 0, release: false }, { time: 4, release: true }])],
  };
  for (const skipIt of [false, true]) {
    const got: [number, boolean][] = [];
    const sink: StompSink = { send: () => {}, setVisible: () => {}, pose: () => {}, control: (uid, release) => got.push([uid, release]) };
    const run = new StompRun(0x50, seq);
    if (skipIt) run.advance(Infinity, sink);
    else {
      run.advance(0.01, sink);
      assert.deepEqual(got, [[0x100, false]], 'taken at 0 s');
      for (let i = 0; i < 50; i++) run.advance(0.1, sink);
    }
    assert.deepEqual(got, [[0x100, false], [0x100, true]], skipIt ? 'skipped' : 'played');
  }
});

test('a take shows Characters (not the Player, not other classes, not destroyed ones)', () => {
  const w = (cls: string, family: string, destroyed = false) => ({ cls, destroyed, e: { family } });
  assert.equal(stompTakeShows(w('Hermes', 'Character')), true);
  assert.equal(stompTakeShows(w('Killjoy', 'Character')), true);
  assert.equal(stompTakeShows(w('Unspeakable NPC', 'Character')), true);
  assert.equal(stompTakeShows(w('Player', 'Character')), false);
  assert.equal(stompTakeShows(w('Animating Static', 'PhysicalObject')), false);
  assert.equal(stompTakeShows(w('Switch', 'PhysicalObject')), false);
  assert.equal(stompTakeShows(w('Hermes', 'Character', true)), false);
});

test('retail 1b "Camera" #247: Hermes 7eb4 starts hidden and is shown when the scene takes him', { skip }, async () => {
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
  const shown: [number, boolean][] = [];
  const hooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: (uid: number, v: boolean) => shown.push([uid, v]),
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  } as unknown as WorldHooks;
  const world = new World(parseEntities(lvl, packages, { resolveStrings: false }), packages, hooks, { levelPath: path });
  world.start();
  world.update(0);
  const hermes = world.get(0x7eb4)!;
  assert.equal(hermes.cls, 'Hermes');
  assert.equal(hermes.e.flags & 1, 0, 'placed hidden (instance flag 0x1 clear)');
  assert.equal(hermes.visible, false);
  const seq = world.sequenceOf(world.get(0x7f41)!)!;
  const t = seq.tracks.find((x) => x.uid === 0x7eb4)!;
  assert.deepEqual(t.visibility, [], 'no hide / show key on his track');
  assert.deepEqual(t.controls.map((c) => c.release), [false, true], 'taken, then handed back');
  assert.equal(t.controls[0].time, 0);
  shown.length = 0;
  world.send(0x7f41, 1);
  for (let i = 0; i < 3; i++) world.update(1 / 30);
  assert.ok(world.activeCutscenes().some((c) => c.uid === 0x7f41), 'scene running');
  assert.equal(hermes.visible, true, 'shown by the take at 0 s');
  assert.ok(shown.some(([u, v]) => u === 0x7eb4 && v), 'the actors system is told');
  // Killjoy 7eb5 (hidden too) is taken at 0 s as well; the scene hides him through "Projector OFF"
  // at 6.15 s and its projector shows him again at 59.09 s (actors/specials/projector.ts).
  assert.equal(world.get(0x7eb5)!.visible, true);
  // The hand-back hides nothing: he stays for the arena.
  world.skipCutscenes();
  for (let i = 0; i < 5; i++) world.update(0.1);
  assert.equal(hermes.visible, true, 'still shown after the scene');
});

test('a saved game keeps a Character\'s fade (Hermes at 85 %, not his creation 0 %)', () => {
  const parts = { spawnParts: () => 0, removeAt: () => 0 };
  const values: PropValue[] = [];
  values[180] = 0;
  values[181] = 85;
  values[182] = 0; // 1b's Hermes: created faded out
  const carrier = () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial());
    return { uid: 0x7eb4, cls: 'Hermes', values, ch: { mesh, current: undefined } as unknown as Character };
  };
  const a = new BodyParts({ pkgs: new Map(), parts });
  const c1 = carrier();
  a.update(0, [c1]);
  assert.equal(a.opacityOf(0x7eb4), 0, 'created invisible');
  // The scene's 206 / 207: faded in to p181.
  a.message(c1, START_FADE_IN);
  a.message(c1, STOP_FADE_IN);
  assert.ok(Math.abs(a.opacityOf(0x7eb4)! - 0.85) < 1e-6);
  const saved = JSON.parse(JSON.stringify(a.save()));
  // A restore: the level's objects are made again, then the save is applied.
  const b = new BodyParts({ pkgs: new Map(), parts });
  const c2 = carrier();
  b.load(saved);
  b.update(0, [c2]);
  assert.ok(Math.abs(b.opacityOf(0x7eb4)! - 0.85) < 1e-6);
  assert.ok(Math.abs((c2.ch.mesh.material as THREE.Material).opacity - 0.85) < 1e-6, 'drawn at 85 %');
});
