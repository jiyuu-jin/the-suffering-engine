// Chapter 3 (3a / 3b YardCellBlock): the rules decoded to play the chapter without logged
// shortcuts (docs/playthrough.md "3 YardCellBlock").
// - Clamber Point box (Suffering.rfl 0x100114f0 / 0x10011030 / 0x10011b30): the object's
//   rotation and scale make the box; only room for the body on top is tested, no floor.
// - Slayer 10:527: one shot per Fire (102) marker of the firing clip (0x100e3c0a), its kick
//   (clip 10:1554, no Arm marker, no Melee Weapon) does no damage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamberRoom, clamberSide, type ClamberBox } from '../src/game/world/clamber';
import { instanceRotation, readLevelHeader } from '../src/formats/level';
import { readClipEvents } from '../src/game/actors/clipmap';
import { ladderFootWindow } from '../src/game/world/use-anim';
import { generatedOf, spotDefOf } from '../src/game/world/searchlight';
import { readTemplate } from '../src/game/world/fx';
import { readMeleeWeapons } from '../src/game/actors/npc-melee';
import { readObjectTemplate, classByHash, decodeTemplateProps, type EntityPackageSet } from '../src/formats/entities';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { nodeFS, readSrsc, skip } from './helpers';

// Retail Clamber Interaction Properties 2:639 (side 3 = -local z, p7 1 m).
const ip639 = [0, 2.5, 4.5, 3, -45, 45, 45, 1, -0.5, null, 0.5, 0.2];

/** A Clamber Point's box from its placement (unit cube model 2:178 x scale, rotated). */
function placed(pos: [number, number, number], rot: [number, number, number], s: [number, number, number]): ClamberBox {
  const R = instanceRotation(rot); // row-major 3x3, columns = local axes in the world
  return {
    centre: { x: pos[0], y: pos[1], z: pos[2] },
    ax: { x: R[0] * s[0], y: R[3] * s[0], z: R[6] * s[0] },
    az: { x: R[2] * s[2], y: R[5] * s[2], z: R[8] * s[2] },
    top: pos[1] + 0.5 * s[1],
  };
}

test('clamber box: 3b 29fe (yaw 180, side 3) faces west, its 3 m edge runs along z', () => {
  const box = placed([413.9, 90.9, 377.9], [0, 180, 0], [3, 1, 1]);
  const feet = { x: 413, y: 88.87, z: 376.8 };
  const east = { x: 1, z: 0 };
  const pick = clamberSide(ip639, box, feet, east, 0.2);
  assert.ok(pick, 'climbed from the foot west of the ledge, facing east');
  assert.ok(Math.abs(pick.normal.x + 1) < 1e-9 && Math.abs(pick.normal.z) < 1e-9, `normal ${JSON.stringify(pick.normal)}`);
  // On the middle line (x 413.9, where the ledge's floor is: it starts at x 413.6), in line with
  // the player along the edge (z 376.8, inside 377.9 +- 1.3).
  assert.ok(Math.abs(pick.anchor.x - 413.9) < 1e-9 && Math.abs(pick.anchor.z - 376.8) < 1e-9, `anchor ${pick.anchor.x}, ${pick.anchor.z}`);
  // Read unrotated (the port before), the edge ran along x and the side faced south: from the
  // south the anchor fell east of x 413.3 by the rock face with no floor; facing north now fails.
  assert.equal(clamberSide(ip639, box, feet, { x: 0, z: 1 }, 0.2), null, 'facing north is 90 degrees off the anchor');
  const unrotated: ClamberBox = { ...box, ax: { x: 3, y: 0, z: 0 }, az: { x: 0, y: 0, z: 1 } };
  assert.ok(clamberSide(ip639, unrotated, feet, { x: 0, z: 1 }, 0.2), 'the old reading faced south');
});

test('clamber room (0x10011b30): the swept body on the box top, no floor asked for', () => {
  // Player shape 1.8 m x 0.35 m radius: the sphere sweeps from top + 0.35 + 0.275 to top + 1.45.
  const c = clamberRoom({ x: 413.9, z: 376.8 }, 91.4, 1.8, 0.35);
  assert.equal(c.r, 0.35);
  assert.ok(Math.abs(c.y0 - (91.4 + 0.625)) < 1e-9 && Math.abs(c.y1 - (91.4 + 1.45)) < 1e-9, `${c.y0}..${c.y1}`);
  assert.deepEqual([c.x, c.z], [413.9, 376.8]);
});

async function level3a() {
  const LEVEL = 'LEVELS/3 YardCellBlock/3a YardCellBlock.lvl';
  const lvl = readSrsc(LEVEL);
  const warn = console.warn;
  console.warn = () => {};
  try {
    return (await loadPackages(nodeFS(), dirname(LEVEL), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  } finally {
    console.warn = warn;
  }
}

test('retail Slayer 10:527: five shots a firing clip, no damage from its kick', { skip }, async () => {
  const packages = await level3a();
  const adu = readSrsc('COMMON/NPCs/NPCs.adu');
  // Attack 10:1506 (weight 0.8, 2 clips) fires 10:1359, 10:1505 (0.2, 6 clips) 10:1370: one Fire
  // marker per arm gun (bones 33 / 36 / 39 / 42 / 45 hold five Ranged Weapons 10:1746 / 10:1747).
  assert.equal(readClipEvents(adu, 1359).fireTimes?.length, 5);
  assert.equal(readClipEvents(adu, 1370).fireTimes?.length, 5);
  // The kick 10:1554 (MeleeAttack 10:1566 -> Attack 10:1568) has no Arm (100) marker, and the
  // Slayer holds no Melee Weapon: no blow in the original.
  const kick = readClipEvents(adu, 1554);
  assert.deepEqual([kick.hitTimes.length, kick.fireTimes?.length ?? 0], [0, 0]);
  const t = readObjectTemplate(packages, { pkg: 10, id: 527 })!;
  const v = decodeTemplateProps(classByHash(t.classHash)!, t);
  assert.equal(readMeleeWeapons(packages as never, v).length, 0);
});

test('ladder mount window: Ladder Interaction Properties 2:427 takes the shack ladder 1593 from 1.2 m below its base', () => {
  // 2:427: anchor p8 -0.4 under the base, p2 1 m: feet from 1.4 m below to 0.6 m above.
  const [lo, hi] = ladderFootWindow([0, 2, 1, 3, 0, 360, 90, 0, -0.4, 0]);
  assert.ok(Math.abs(lo + 1.4) < 1e-9 && hi === 0.6, `${lo}..${hi}`);
  assert.ok(-1.2 >= lo, '3a shack floor (97.66) under the ladder base (98.86)');
  assert.deepEqual(ladderFootWindow(undefined), [-0.3, 0.6]);
});

test('retail searchlight Spot Light 7:2895: start 1 m, length 12 m, radius 45 m, light colour', { skip }, async () => {
  const packages = await level3a();
  // 3a walkway lights: p49 Object Generator 7:2896 spawns Spot Light 7:2895 with its cone.
  const spot = generatedOf(packages, { pkg: 7, id: 2896 }, 'Spot Light');
  assert.deepEqual(spot, { pkg: 7, id: 2895 });
  const { def, sign } = spotDefOf(readTemplate(packages, spot!)!.values);
  assert.deepEqual([def.start, def.length, def.radius, def.color, sign], [1, 12, 45, 0xf7f5f2, 1]);
});
