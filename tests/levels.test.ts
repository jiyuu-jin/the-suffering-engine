// Levels outside chapter 1 (src/game/levels, docs/levels.md): carrier-camera attach keys,
// Health Threshold Trigger crossings, and data checks over the retail levels (water surfaces
// are left out of collision, rain volumes decode, every Level Transition finds its spawn).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachedHardpoint } from '../src/game/levels/carrier-camera';
import { LevelLogic } from '../src/game/levels/logic';
import { waterVolumeUids } from '../src/game/levels/water';
import { skyStrip, skyStripAt } from '../src/game/levels/sky';
import { lerpColor, skyFog } from '../src/game/levels/atmosphere';
import { loadClip } from '../src/game/actors/clipmap';
import { hasSkeleton } from '../src/formats/skeleton';
import type { StompTrack } from '../src/game/world/stomp';
import type { World, WorldEntity } from '../src/game/world/logic';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { parseLevel, readLevelHeader } from '../src/formats/level';
import { readModel } from '../src/formats/model';
import { findLevelDependencies, loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { CollisionWorld } from '../src/app/physics';
import { SrscFile } from '../src/formats/srsc';
import { filesWithExt, nodeFS, skip } from './helpers';

const track = (index: number, attaches: [number, number, number][] = []): StompTrack =>
  ({ name: `t${index}`, index, uid: index, flags: 0, keyCount: 0, transforms: [], anims: [], sounds: [], attaches: attaches.map(([time, t, hardpoint]) => ({ time, track: t, hardpoint })), controls: [], visibility: [], messages: [], cameras: [] }) as StompTrack;

test('carrier camera: the hardpoint a track hangs on follows the attach keys', () => {
  // The Prelude boat: camera (#1) on 12, then 13, then 14; 12 / 13 / 14 cleared later.
  const cam = track(1);
  const boat = track(2, [[0.03, 1, 12], [9.32, 1, 13], [10.02, 0, 12], [14.72, 1, 14], [15.35, 0, 13], [19.1, 0, 14]]);
  assert.equal(attachedHardpoint(boat, cam, 0), undefined);
  assert.equal(attachedHardpoint(boat, cam, 5), 12);
  assert.equal(attachedHardpoint(boat, cam, 9.5), 13);
  assert.equal(attachedHardpoint(boat, cam, 12), 13);
  assert.equal(attachedHardpoint(boat, cam, 16), 14);
  assert.equal(attachedHardpoint(boat, cam, 19.2), undefined);
});

test('Health Threshold Trigger fires on crossing below p0 only; the starting health is no event (previous starts at 0)', () => {
  // The Prelude's four variants, one per difficulty: Easy 170 (health 200), Medium 120 (100),
  // Hard 70 (75), Impossible 40 (60). Blows of 10 / 10 / 10 / 10 / 20.
  const run = (p0: number, start: number, blows: number[]) => {
    const fired: number[] = [];
    const t = { uid: 1, cls: 'Health Threshold Trigger', destroyed: false, visible: true, enabled: true, s: {}, pos: [0, 0, 0], e: { links: [9], values: [p0, 0, 1, 1], family: '' } } as unknown as WorldEntity;
    const player = { uid: 9, e: { family: 'Character' } };
    const world = {
      handlers: [],
      of: (cls: string) => (cls === 'Health Threshold Trigger' ? [t] : []),
      get: (uid: number) => (uid === 9 ? player : t),
      fire: (w: WorldEntity) => fired.push(w.uid),
      destroy: (w: WorldEntity) => (w.destroyed = true),
    } as unknown as World;
    let health = start;
    const logic = new LevelLogic(world, new Map() as EntityPackageSet, () => undefined, { health: () => health });
    logic.update();
    let at = -1;
    blows.forEach((b, i) => {
      health -= b;
      logic.update();
      if (fired.length && at < 0) at = i;
    });
    return at; // index of the blow that fired it, -1 none
  };
  // Easy: 200 -> 190 compares with 0 and only arms it (rising side); 190 -> 160 fires.
  assert.equal(run(170, 200, [10, 30, 10]), 1);
  // Medium: 120 lies above the health of 100: never.
  assert.equal(run(120, 100, [10, 10, 10, 10, 20]), -1);
  // Hard: the first blow takes 75 below 70 while the previous value is 0: same side, never after.
  assert.equal(run(70, 75, [10, 10, 10, 10]), -1);
  // Impossible: 60 -> 50 arms it, 50 -> 30 fires.
  assert.equal(run(40, 60, [10, 20]), 1);
});

test('Water Volumes: surfaces are drawn but left out of collision', { skip }, async () => {
  const fs = nodeFS();
  const path = filesWithExt('.lvl').find((p) => p.includes('0 Prelude Docks'))!;
  const deps = await findLevelDependencies(fs, path);
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const water = new Set(waterVolumeUids(lvl, packages));
  assert.equal(water.size, 79);
  const ldu = deps.levelLdu ? new SrscFile(await fs.read(deps.levelLdu)) : undefined;
  const level = parseLevel(lvl, 'prelude', { ldu, packages, nonSolidUids: water });
  assert.ok(level.parts.some((p) => p.solid === false), 'water parts are flagged');
  const cw = new CollisionWorld(level);
  // A point of the sea surface west of the docks (7:600 covers x 409..432, z 143..197 at y 89.8).
  const hit = cw.raycast(420, 95, 170, 0, -1, 0, 50);
  assert.ok(hit && hit.point[1] < 88, `the ray reaches the sea bed (hit at ${hit?.point[1]})`);
  const solid = new CollisionWorld(parseLevel(lvl, 'prelude', { ldu, packages }));
  const top = solid.raycast(420, 95, 170, 0, -1, 0, 50);
  assert.ok(top && Math.abs(top.point[1] - 89.8) < 0.3, 'without the flag the surface is solid');
});

test('levels outside chapter 1: rain volumes decode, transitions find their spawn points', { skip }, async () => {
  const fs = nodeFS();
  const levels = filesWithExt('.lvl').filter((p) => !p.includes('/1 PrisonDeathRow/'));
  const spawns = new Map<string, { from: string; name: string }[]>();
  const transitions: { from: string; target: string; name: string }[] = [];
  let rain = 0;
  for (const path of levels) {
    const lvl = new SrscFile(await fs.read(path));
    const packages = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, () => {});
    for (const e of parseEntities(lvl, packages)) {
      if (e.className === 'Volumetric Rain') {
        rain++;
        const m = e.modelRef && readModel(packages, e.modelRef);
        assert.ok(m && m.positions.length, `rain ${e.uid.toString(16)} has its volume model`);
        assert.ok((e.values[11] as number) > 0 && (e.values[2] as number) > 0, 'speed and drop count');
      }
      if (e.className === 'Player Spawn Point') {
        const list = spawns.get(path.toLowerCase()) ?? spawns.set(path.toLowerCase(), []).get(path.toLowerCase())!;
        list.push({ from: String(e.props.fromLevel ?? '').replace(/\\/g, '/').toLowerCase(), name: String(e.props.spawnName ?? '').toLowerCase() });
      }
      if (e.className === 'Level Transition') {
        const names = (Array.isArray(e.props.targetSpawnNames) ? e.props.targetSpawnNames : []).filter((x) => typeof x === 'string') as string[];
        transitions.push({ from: path, target: String(e.props.targetLevel ?? ''), name: (names[0] ?? '').toLowerCase() });
      }
    }
  }
  assert.equal(rain, 53);
  assert.equal(transitions.length, 30);
  for (const t of transitions) {
    const target = await fs.resolve(t.target.replace(/\\/g, '/'));
    assert.ok(target, `${t.from} -> ${t.target} resolves`);
    if (/\/1 PrisonDeathRow\//.test(target!) || /7 ReturnToPrison/.test(t.from)) continue;
    const me = t.from.toLowerCase().split('/').pop()!;
    const pts = spawns.get(target!.toLowerCase()) ?? [];
    const ok = pts.some((p) => p.name === t.name && p.from.endsWith(me));
    assert.ok(ok, `${me} -> ${target} "${t.name}" has a spawn point from ${me}`);
  }
});

test('Sky Properties: dome strip and fog colour as the engine writes them', () => {
  // Prelude 7:2541: p4 0x251210, p5 0x362f46, p6 0.07, p7 0.15, p8 0.
  const v = [90, 0.65, 240, 0.6, 0x251210, 0x362f46, 0.07, 0.15, 0];
  const st = skyStrip(v);
  assert.equal(skyStripAt(st, 0), 0x251210, 'horizon band');
  assert.equal(skyStripAt(st, 0.06), 0x251210);
  assert.equal(skyStripAt(st, 0.5), 0x362f46, 'above the gradient: sky colour');
  const mid = skyStripAt(st, 0.07 + 0.075);
  assert.ok(mid !== 0x251210 && mid !== 0x362f46, 'inside the gradient');
  assert.equal(skyFog(v).color, 0x251210, 'p8 = 0: fog = p4');
  // p8 = 0.4 (7:144 / 7:145 / 7:794): the fog colour moves 40 % towards p5.
  assert.equal(skyFog([90, 0.65, 45, 0.6, 0x000000, 0x646464, 0, 0.4, 0.4]).color, 0x282828);
  assert.equal(lerpColor(0x000000, 0xffffff, 0.5), 0x808080);
  // p4 == p5: one colour everywhere.
  const flat = skyStrip([90, 0.65, 45, 0.6, 0x1f1816, 0x1f1816, 0.15, 0.05, 0]);
  assert.equal(skyStripAt(flat, 0.9), 0x1f1816);
});

test('Cranes: Prelude / Quarry cranes are skinned, flag 0x80 clear, posed by p41', { skip }, async () => {
  const fs = nodeFS();
  for (const [path, n] of [['LEVELS/0 Prelude Docks/0 Prelude Docks.lvl', 1], ['LEVELS/4 Quarry/4b Quarry.lvl', 3]] as const) {
    const lvl = new SrscFile(await fs.read(path));
    const pkgs = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, () => {});
    const cranes = parseEntities(lvl, pkgs as EntityPackageSet).filter((e) => e.className === 'Crane');
    assert.equal(cranes.length, n, path);
    for (const c of cranes) {
      assert.equal(c.flags & 0x80, 0, 'not drawn by the flag-0x80 rule');
      assert.ok(c.modelRef && hasSkeleton(pkgs.get(c.modelRef.pkg)?.mdu, c.modelRef.id), 'skinned');
      const pose = c.values[41] as { pkg: number; id: number };
      assert.ok(pose && loadClip(pkgs, pose), 'p41 is a clip of the crane rig');
    }
  }
});
