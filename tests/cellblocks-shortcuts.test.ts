// 2 Cellblocks: the rules decoded to play the level's last part without logged shortcuts
// (docs/playthrough.md "2 Cellblocks").
// - Clamber anchor (Suffering.rfl 0x100114f0): the player's place along the ledge, clamped to
//   the edge less the Clamber Point's p31; a long wall top (80b, 18 m) is climbed from the step
//   3024 below it, not only at its middle.
// - Cinematics: only a track on the Camera object takes the view and the input (SUFFERING.EXE
//   0x44f497 / 0x44f71a run flag 0x200, input mapper 0x4bccf1); header flag 0x40 alone ("Mainliner"
//   847) plays in the world while the player keeps control.
// - Locked doors: an Edge Passage with p4 = 1 lets characters through (0x10130e50 / 0x100a8d50):
//   the south-yard gunner walks out of his nest through be4. Skinned models have no collision
//   record: the gun 2dbf no longer traps him.
// - Speech Player (0x1012d970 / 0x1012db10 / 0x1012da40): a dead speaker says nothing, but the
//   line counts as played (p8 / p9 / p6 follow); a removed speaker stops it silently; p4 picks
//   the order, p6 the destroy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamberSide, type ClamberBox } from '../src/game/world/clamber';
import { World, type WorldHooks } from '../src/game/world/logic';
import { Director, speechPick, type DirectorHooks } from '../src/game/actors/director';
import type { ActorManager } from '../src/game/actors/manager';
import type { ActorFx } from '../src/game/actors/fx';
import { parseEntities, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { nodeFS, readSrsc, skip } from './helpers';
import { lockPassDoors } from '../src/game/actors/nav';
import { hasSkeleton } from '../src/formats/skeleton';
import { findEntry, type PackageSet } from '../src/formats/model';

// Retail Clamber Interaction Properties 2:455..2:458 (p3 0..3) and 2:641 (side 1, p7 1 m).
const ip = (side: number, minH = 2.5) => [0, 2.5, 4.5, side, -45, 45, 45, minH, -0.5, null, 0.5, 0.2];
// 80b: unit box x (1, 0.95, 18) at (127.75, 100.4, 243): an 18 m wall top along z, side 0 (+x).
const wall: ClamberBox = { centre: { x: 127.75, y: 100.4, z: 243 }, ax: { x: 1, y: 0, z: 0 }, az: { x: 0, y: 0, z: 18 }, top: 100.875 };
// 3024: (3, 0.5, 0.6) at (129.3, 96.53, 236.09), side 1 (+z), p7 1 m: the step below it.
const step: ClamberBox = { centre: { x: 129.3, y: 96.53, z: 236.09 }, ax: { x: 3, y: 0, z: 0 }, az: { x: 0, y: 0, z: 0.6 }, top: 96.78 };
const west = { x: -1, z: 0 };
const north = { x: 0, z: -1 };

test('clamber anchor: the player\'s place along the edge, clamped short of its ends by p31', () => {
  // On the step 3024 (feet 96.78, 4.1 m under the wall top), 7 m from the wall's middle.
  const feet = { x: 129, y: 96.78, z: 235.9 };
  const pick = clamberSide(ip(0), wall, feet, west, 0.2);
  assert.ok(pick, 'the wall top is in reach from the step');
  assert.deepEqual([pick.anchor.x, pick.anchor.z, pick.anchor.y], [127.75, 235.9, 100.875], 'anchor in line with the player, on the middle line (0.5 + p8)');
  assert.deepEqual([pick.edge.x, pick.edge.z], [128.25, 235.9]);
  // Past the south end the anchor stays 0.2 m (p31) inside it: 243 - 9 + 0.2.
  const end = clamberSide(ip(0), wall, { x: 129, y: 96.78, z: 233.9 }, west, 0.2);
  assert.ok(end);
  assert.ok(Math.abs(end.anchor.z - 234.2) < 1e-9, `clamped to 234.2 (${end.anchor.z})`);
  // The old face-centre anchor (243) is 7 m away: no reach.
  assert.equal(clamberSide(ip(0), { ...wall, az: { x: 0, y: 0, z: 1 } }, feet, west, 0.2), null, 'a 1 m wall at the same middle is out of reach');
  // From the pit floor (94.7) the wall top is 6.2 m up: more than p2 (4.5).
  assert.equal(clamberSide(ip(0), wall, { x: 129, y: 94.7, z: 235.9 }, west, 0.2), null, 'too high from the pit');
  // Facing away from the anchor fails p6.
  assert.equal(clamberSide(ip(0), wall, feet, { x: 1, z: 0 }, 0.2), null, 'facing away');
});

test('clamber chain: pit -> step 3024 (p7 1 m) -> wall top 80b', () => {
  // From the pit floor north of the step, facing south... the step's +z side faces the pit.
  const pit = { x: 129.5, y: 94.7, z: 237.6 };
  const up = clamberSide(ip(1, 1), step, pit, north, 0.2);
  assert.ok(up, 'the step (2.1 m) from the pit');
  assert.ok(Math.abs(up.anchor.z - 235.89) < 1e-6 && Math.abs(up.anchor.x - 129.5) < 1e-9, `anchor ${up.anchor.x}, ${up.anchor.z}`);
  // Landed on the step at its anchor: the wall's side 0 is 1.75 m west and 4.1 m up.
  const top = clamberSide(ip(0), wall, { x: up.anchor.x, y: step.top, z: up.anchor.z }, west, 0.2);
  assert.ok(top, 'then the wall top from the step');
  // The step's own 2.5 m templates would not take a 2.1 m ledge: 2:641 has p7 1.
  assert.equal(clamberSide(ip(1), step, pit, north, 0.2), null);
});

test('Speech Player order (p4): in order through all lines, random, random without repeats', () => {
  let s = { index: 0, used: 0 };
  const lines: number[] = [];
  for (let k = 0; k < 4; k++) {
    const p = speechPick(0, 3, s.index, s.used);
    lines.push(p.line);
    assert.equal(p.done, p.last, 'in order: one On plays on until the last line');
    s = p;
  }
  assert.deepEqual(lines, [0, 1, 2, 0]);
  let r = 0;
  const seq = [0.9, 0.0, 0.5];
  let st = { index: 0, used: 0 };
  const got: number[] = [];
  for (let k = 0; k < 3; k++) {
    const p = speechPick(2, 3, st.index, st.used, () => seq[r++]);
    got.push(p.line);
    assert.equal(p.last, k === 2, 'the round ends with the third line');
    st = p;
  }
  assert.deepEqual([...got].sort(), [0, 1, 2], 'no line twice in a round');
  assert.equal(st.used, 0, 'a new round');
  const one = speechPick(1, 5, 0, 0, () => 0.5);
  assert.deepEqual([one.line, one.done, one.last], [2, true, false]);
});

function speechDirector(alive: boolean) {
  // Speech Player 310f: [2, 1, 12, 2, 0, [20:202], 1, 13, 0, 0], linked to the inmate 868 and a relay.
  const values = [2, 1, 12, 2, 0, [{ pkg: 20, id: 202 }, { pkg: 20, id: 203 }], 1, 13, 7, 9];
  const e = { uid: 0x310f, className: 'Speech Player', values, links: [0x868, 0x77], position: [0, 0, 0] } as unknown as Entity;
  let actor: object | undefined = { uid: 0x868, alive, template: false, position: { x: 0, y: 0, z: 0 }, bottom: 0, height: 1.8, ch: { root: { name: 'inmate' } } };
  const spoken: string[] = [];
  const sent: string[] = [];
  const manager = { actors: [], get: (u: number) => (u === 0x868 ? actor : undefined) } as unknown as ActorManager;
  const hooks = {
    send: (uid: number, m: number) => sent.push(`${uid.toString(16)}:${m}`),
    speak: (keys: string[]) => (spoken.push(keys[0]), 2),
    log: () => {},
    player: () => ({ x: 0, y: 0, z: 0 }),
  } as unknown as DirectorHooks;
  const d = new Director([e], new Map([[e.uid, e]]), new Map() as unknown as EntityPackageSet, manager, hooks, {} as ActorFx);
  return { d, spoken, sent, remove: () => (actor = undefined) };
}

test('Speech Player: a dead speaker says nothing, but the line counts (p8, p9 and p6 follow)', () => {
  const env = {} as never;
  const live = speechDirector(true);
  live.d.message(1, 0, 0x310f, env);
  assert.deepEqual(live.spoken, ['20:202']);
  live.d.update(1, env);
  assert.deepEqual(live.sent, [], 'still speaking');
  live.d.update(1.5, env);
  assert.deepEqual(live.sent, ['77:7'], 'p8 after the first line (in order, not the last: no p9)');
  live.d.update(2.5, env);
  assert.deepEqual(live.spoken, ['20:202', '20:203'], 'in order: the next line on the same On');
  assert.deepEqual(live.sent, ['77:7', '77:7', '77:9'], 'p8, then p9 after the last line');

  const dead = speechDirector(false);
  dead.d.message(1, 0, 0x310f, env);
  dead.d.update(0.01, env);
  dead.d.update(0.01, env);
  assert.deepEqual(dead.spoken, [], 'the dead say nothing');
  assert.deepEqual(dead.sent, ['77:7', '77:7', '77:9'], 'the lines still end, one per update');
  dead.d.message(1, 0, 0x310f, env);
  dead.d.update(0.01, env);
  assert.equal(dead.sent.length, 3, 'p6 1 destroyed it after the round');

  const gone = speechDirector(true);
  gone.d.message(1, 0, 0x310f, env);
  gone.remove();
  gone.d.update(3, env);
  assert.deepEqual(gone.sent, [], 'a speaker removed from the world: no output');

  const none = speechDirector(true);
  none.remove();
  none.d.message(1, 0, 0x310f, env);
  none.d.update(3, env);
  assert.deepEqual([none.spoken, none.sent], [[], []], 'no character linked: nothing starts');
});

const LEVEL_2 = 'LEVELS/2 Cellblocks/2 Cellblocks.lvl';
async function world2() {
  const lvl = readSrsc(LEVEL_2);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(LEVEL_2), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_2 });
  world.start();
  world.update(0);
  return world;
}

test('2 Cellblocks: "Mainliner" 847 (flag 0x40, no Camera track) plays in the world; "Camera" 2e01 takes the view', { skip }, async () => {
  const world = await world2();
  world.send(0x847, 1, 0);
  world.update(0.1);
  const run = world.runningStomps().find((r) => r.uid === 0x847);
  assert.ok(run && run.cinematic, '847 runs with the header flag 0x40');
  assert.equal(world.takesCamera(run), false, 'no Camera track');
  assert.deepEqual(world.activeCutscenes(), [], 'not a cinematic for the player: view and control stay his');
  world.skipCutscenes();
  assert.ok(world.runningStomps().some((r) => r.uid === 0x847), 'Enter does not skip it');
  world.send(0x2e01, 1, 0);
  world.update(0.1);
  assert.deepEqual(world.activeCutscenes().map((c) => c.uid), [0x2e01], 'the south-yard Camera scene takes the view');
});

test('2 Cellblocks: the gunner\'s locked door be4 lets characters through (Edge Passage 2e0f p4 = 1); the gate c36 opens from the lever 1356', { skip }, async () => {
  const lvl = readSrsc(LEVEL_2);
  const warn = console.warn;
  console.warn = () => {};
  let packages: EntityPackageSet;
  try {
    packages = (await loadPackages(nodeFS(), dirname(LEVEL_2), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
  const ents = parseEntities(lvl, packages);
  const by = new Map(ents.map((e) => [e.uid, e]));
  const pass = lockPassDoors(ents);
  assert.ok(pass.has(0xbe4), 'be4');
  assert.ok(pass.has(0x24b8));
  assert.equal(pass.size, 2, 'two in the level');
  assert.equal(by.get(0xbe4)!.values[22], 0, 'be4 starts locked and nothing unlocks it');
  assert.ok(!pass.has(0xc36), 'c36 has no passage: characters do not open it');
  // The lever 1356 (unlocked, usable by the player) sends c36 On when it opens (p64) and Off
  // when it closes (p65); Timer 314e on the inmate's way (Waypoint 314b) pulls it for him.
  const lever = by.get(0x1356)!;
  assert.deepEqual([lever.values[22], lever.values[23], lever.links[0]], [1, 1, 0xc36]);
  assert.equal(by.get(0x314e)!.links[0], 0x1356);
  // The mounted gun 2dbf is skinned (no collision record): the gunner stands inside its bind pose.
  const gun = by.get(0x2dbf)!;
  assert.ok(gun.modelRef && hasSkeleton((packages as unknown as PackageSet).get(gun.modelRef.pkg)?.mdu, gun.modelRef.id), 'skinned');
  assert.equal(findEntry((packages as unknown as PackageSet).get(gun.modelRef!.pkg)?.mdu, 7, gun.modelRef!.id), undefined, 'no type-7 collision record');
});
