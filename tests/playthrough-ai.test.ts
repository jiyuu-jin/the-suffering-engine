// Regressions for the second round of chapter 1 playthrough fixes (docs/playthrough.md): the
// KillEnemiesBehavior sight rules, JumpBehavior launch, melee attack ranges, GameObject p3
// invulnerability, Clamber Interaction Properties and the 1b / 1c route data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classByHash, decodeTemplateProps, parseEntities, readObjectTemplate, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { World, type WorldHooks } from '../src/game/world/logic';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { BehaviorLibrary, inSight, jumpParams, jumpVelocity, sightRules } from '../src/game/actors/behaviors';
import { deathDrops, deathWeaponMode } from '../src/game/actors/drops';
import { resolveCreatureClips } from '../src/game/actors/clipmap';
import { startsInvulnerable } from '../src/game/world/props';
import { clamberSide, type ClamberBox } from '../src/game/world/clamber';
import { readMaterial } from '../src/formats/model';
import { lightOnly } from '../src/app/physics';
import { nodeFS, readSrsc, skip } from './helpers';

async function level(name: string) {
  const path = `LEVELS/1 PrisonDeathRow/${name} PrisonDeathRow.lvl`;
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    const ents = parseEntities(lvl, packages);
    const byUid = new Map<number, Entity>(ents.map((e) => [e.uid, e]));
    return { packages, byUid };
  } finally {
    console.warn = warn;
  }
}

function template(packages: EntityPackageSet, pkg: number, id: number) {
  const t = readObjectTemplate(packages, { pkg, id });
  assert.ok(t, `template ${pkg}:${id}`);
  return decodeTemplateProps(classByHash(t.classHash), t);
}

test('sight: no vertical limit, the full view angle is p11, the acquire range p7', () => {
  const r = { range: 45, alwaysSee: 0, fov: 360 };
  // A target 10 m below (the 1b wall holes above the arena floor), 12 m away horizontally.
  assert.equal(inSight(r, Math.hypot(12, 10), 0.2), true);
  // All round: straight behind is seen.
  assert.equal(inSight(r, 5, -1), true);
  assert.equal(inSight(r, 46, 1), false, 'beyond the acquire range');
  // A 90 degree cone (p11 = 90): 45 degrees each side.
  const narrow = { range: 45, alwaysSee: 3, fov: 90 };
  assert.equal(inSight(narrow, 10, Math.cos((40 * Math.PI) / 180)), true);
  assert.equal(inSight(narrow, 10, Math.cos((50 * Math.PI) / 180)), false);
  assert.equal(inSight(narrow, 2, -1), true, 'within the always-see radius');
});

test('CartWheeler KillEnemiesBehavior 10:102 decodes to 45 m, all round, line of sight on', { skip }, async () => {
  const { packages } = await level('1b');
  const r = sightRules(template(packages, 10, 102));
  assert.deepEqual([r.range, r.fov, r.keep, r.alwaysSee, r.los, r.reevalMin, r.reevalRand], [45, 360, 50, 0, true, 2, 2]);
});

test('JumpBehavior: launch velocity p7 forward / p8 up, gravity x p9; the 1b wall-hole drops', { skip }, async () => {
  const { packages } = await level('1c');
  // 10:129 (1c yard CartWheelers off the walls): 8 m/s out, 3 up, half gravity, 3 s timer.
  const out = jumpParams(template(packages, 10, 129));
  assert.deepEqual([out.timer, out.speed, out.up, out.gravity, out.toward], [3, 8, 3, 0.5, 0]);
  const v = jumpVelocity(out, 0, -2);
  assert.deepEqual([v.x, v.y, +v.z.toFixed(6)], [0, 3, -8]);
  // 10:175 (1b wall holes): a drop after the climb-down clip.
  const drop = jumpParams(template(packages, 10, 175));
  assert.deepEqual([drop.speed, +drop.up.toFixed(3), +drop.gravity.toFixed(3)], [0, -0.25, 0.6]);
});

test('melee: CartWheeler attacks start within Attack p16 (p6 is a damage multiplier), height limit p17', { skip }, async () => {
  const { packages } = await level('1b');
  const map = resolveCreatureClips(packages as never, { pkg: 10, id: 24 }, 10, 5);
  // Attacks 10:955 / 10:87 / 10:88 / 10:958 of the MeleeAttackBehavior slot p87 (p16 1.5 / 1.75,
  // p17 -1, p14 1). The ceiling slash (p179: 10:143, 1.2 m, 4 m of height) is used on a ceiling
  // only (specials/cartwheeler.ts) and is not among the floor attacks [verified 0x100720c0].
  const got = map.attacks.map((a) => [+a.reach.toFixed(2), a.minReach, a.maxDy, a.scaled]);
  assert.deepEqual(got, [[1.5, 0, 0, true], [1.75, 0, 0, true], [1.5, 0, 0, true], [1.75, 0, 0, true]]);
  // 10:958's p6 (2.5) is the damage multiplier, not its reach.
  assert.ok(!map.attacks.some((a) => a.reach > 1.75));
});

test('GameObject p3: the 1c inmate and the locked exit doors start invulnerable, 1b door 53c2 does not', { skip }, async () => {
  const c = await level('1c');
  assert.equal(startsInvulnerable(c.byUid.get(0x7569)!.values), true, 'inmate 7569');
  assert.equal(startsInvulnerable(c.byUid.get(0x57e9)!.values), true, 'exit door 57e9');
  // Waypoint 756a turns it off when he comes out of his cell (p0 = 91 InvulnerabilityOff).
  assert.equal(c.byUid.get(0x756a)!.values[0], 91);
  const b = await level('1b');
  assert.equal(startsInvulnerable(b.byUid.get(0x52b6)!.values), true, 'exit door 52b6');
  assert.equal(startsInvulnerable(b.byUid.get(0x53c2)!.values), false, 'breakable door 53c2');
  assert.equal(b.byUid.get(0x53c2)!.values[0], 30);
});

test('clamber: a 3.5 m ledge is in range (p7 2.5 minimum, p2 4.5 maximum), sides by p3', () => {
  // The 1b ledge 7f85: box 1 x 0.5 x 2 at (471, 79.51, 428.5), rotated 90 degrees (local x is
  // world z). Retail templates 2:455..2:458 differ only in p3.
  const ip = (side: number) => [0, 2.5, 4.5, side, -45, 45, 45, 2.5, -0.5, null, 0.5, 0.2];
  const box: ClamberBox = { centre: { x: 471, y: 79.51, z: 428.5 }, ax: { x: 0, y: 0, z: -1 }, az: { x: 2, y: 0, z: 0 }, top: 79.76 };
  const feet = { x: 471.75, y: 76.23, z: 428.5 }; // on the ledge of 8004, east of 7f85
  const west = { x: -1, z: 0 };
  // +local z = +x world: the east side.
  const pick = clamberSide(ip(1), box, feet, west);
  assert.ok(pick, 'east side');
  assert.deepEqual([pick.normal.x, pick.anchor.x, pick.anchor.y], [1, 471.5, 79.76]);
  assert.equal(clamberSide(ip(3), box, feet, west), null, 'west side template');
  assert.equal(clamberSide(ip(1), box, feet, { x: 1, z: 0 }), null, 'facing away');
  assert.equal(clamberSide(ip(1), box, { ...feet, y: 77.4 }, west), null, 'below the 2.5 m minimum');
  assert.equal(clamberSide(ip(1), box, { ...feet, y: 75.1 }, west), null, 'more than 4.5 m');
  assert.equal(clamberSide(ip(1), box, { ...feet, x: 474.5 }, west), null, 'out of reach');
});

test('1b route: the hall door breaks, a crate keeps 653a locked, the exit is tried locked', { skip }, async () => {
  const { byUid } = await level('1b');
  // Detector 7fe9 (pushables) locks 653a while the crate 7fde stands in it, unlocks on exit.
  const det = byUid.get(0x7fe9)!;
  assert.deepEqual([det.values[1], det.values[7], det.values[9], det.links[0]], [3, 5, 4, 0x653a]);
  // The exit 52b6 stays locked (p3 1, nothing unlocks it): the player's use fires its p68 (On)
  // whether locked or not (RFL 0x100368f6), Timer 79c2 starts on On and fires the transition.
  const exit = byUid.get(0x52b6)!;
  assert.equal(exit.values[68], 1);
  assert.deepEqual(exit.links.slice(0, 2), [0x79c2, 0x8c0e]);
  assert.equal(byUid.get(0x79c2)!.values[6], 1, 'Timer 79c2 inStart');
  assert.deepEqual(byUid.get(0x79c2)!.links, [0x79c3]);
  // 8282 / 8283 (the sewer-end scene) belong to the revisit from 6b: Detector 8282 is never
  // created (flag 0x8) and the arrival handler 8933 is the other way in.
  assert.ok(byUid.get(0x8282) === undefined || (byUid.get(0x8282)!.flags & 0x8) !== 0);
});

test('collision: light-only surfaces (additive, no depth write) are not solid; 1b arena light shaft 9:5841', { skip }, async () => {
  const { packages } = await level('1b');
  const m = readMaterial(packages as never, { pkg: 9, id: 5841 });
  assert.ok(m, 'material 9:5841');
  // A sloped light shaft across the Move Node edges 727b / 7280 -> 727c: creatures pathed into it.
  assert.equal(lightOnly({ material: m }), true);
  assert.equal(lightOnly({ material: { key: 'x', cls: 0, layers: [{ blend: 0 }] } as never }), false, 'opaque');
  assert.equal(lightOnly({ material: { key: 'x', cls: 0, layers: [{ blend: 2, depthWrite: true }] } as never }), false, 'depth writing');
  assert.equal(lightOnly({}), false, 'no material');
});

test('Timer: a Start on a running timer does not restart it (1b arena Timer 8b9a, started every tick)', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
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
    const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: path });
    world.start();
    world.update(0);
    const count = () => Number(world.get(0x80a5)!.s.count);
    assert.equal(count(), 2);
    // Detector 7ed4 -> 7ed5 -> 7ed8 -> 8b99 starts the 6.5 s Timer 8b9a on every tick while the
    // player stands transformed in the arena; it still fires 6.5 s after the first Start.
    for (let t = 0; t < 7; t += 0.1) {
      world.send(0x8b9a, 1, 0x7ed8);
      world.update(0.1);
    }
    assert.equal(count(), 1, 'Timer 8b9a fired (Decrement to Count Down 80a5)');
  } finally {
    console.warn = warn;
  }
});

test('death drops: p53 hand weapons, p109 1 drops them, Item p27 is the pickup (1a guard 609e -> Ammo Box 4:1404)', { skip }, async () => {
  const { packages, byUid } = await level('1a');
  const drops = deathDrops(packages, byUid.get(0x609e)!.values);
  assert.deepEqual(drops, [{ pkg: 4, id: 1404 }]);
  // Only characters created holding their p52 weapons (p53) drop them: none of 1a's posed
  // corpses on the way to him; the gas chamber guards past him and the office guards that a
  // script destroys (Relay 7af4) do.
  const droppers = [...byUid.values()]
    .filter((e) => deathDrops(packages, e.values).length)
    .map((e) => e.uid.toString(16))
    .sort();
  assert.deepEqual(droppers, ['609e', '782b', '7831', '7832', '7833', '7acd', '7ace', '7acf']);
  for (const u of [0x781c, 0x7fdf, 0x855f, 0x8b32, 0x791c]) assert.equal(deathWeaponMode(byUid.get(u)!.values), 'keep');
  // The pickup grants the Revolver 4:5, one of it (Ammo Box p55 / p56).
  const box = template(packages, 4, 1404);
  assert.deepEqual([box[55], box[56]], [{ pkg: 4, id: 5 }, 1]);
});

test('talks: p11 / p12 talking distance and height, p5 walks up however far (1a guard 7528 / 7522)', { skip }, async () => {
  const { packages, byUid } = await level('1a');
  const lib = new BehaviorLibrary(packages, byUid);
  for (const [uid, near] of [[0x7528, 5], [0x7522, 7]] as const) {
    const b = lib.fromPlaced(uid);
    assert.equal(b?.kind, 'talk');
    if (b?.kind !== 'talk') continue;
    assert.equal(b.approach, true);
    assert.equal(b.nearDist, near);
    assert.equal(b.nearHeight, 2);
  }
  // The guard's escort leg: WaypointBehavior 7524 escorts the player (p8), p9 10 m / p10 20 m.
  const w = lib.fromPlaced(0x7524);
  assert.ok(w?.kind === 'waypoint' && w.escort.length === 1 && w.near === 10 && w.far === 20);
});
