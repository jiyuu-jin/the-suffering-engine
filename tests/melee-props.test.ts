// The player's blade against props (src/game/weapons/melee-sweep.ts) and the props' Damage
// Resistance (world/props.ts -> fx/gas.ts resistanceMultiplier); docs/game-logic.md §14.1
// "Melee on props". The 1a crate the shiv could not break: Breakable 8153 (7:1842, 13 health).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bladePropContacts, bladeWallClear, blowsToBreak, sweptQuadSegments, type Vec3 } from '../src/game/weapons/melee-sweep';
import { resistanceMultiplier } from '../src/game/fx/gas';
import { weaponDef } from '../src/game/weapons/data';
import { readModelSphereNodes, weaponShape } from '../src/formats/model-spheres';
import { parseEntities, type EntityPackage } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

/** Axis-aligned box as a stand-in collision body: a segment cast returns the entry point. */
function boxCaster(boxes: { body: number; min: Vec3; max: Vec3 }[], wall?: { x: number }) {
  return (o: Vec3, e: Vec3) => {
    const d: Vec3 = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
    const len = Math.hypot(...d);
    let best: { distance: number; point: Vec3; normal: Vec3; body?: number } | null = null;
    if (wall && d[0] !== 0) {
      const t = (wall.x - o[0]) / d[0];
      if (t >= 0 && t <= 1) best = { distance: t * len, point: [wall.x, o[1] + d[1] * t, o[2] + d[2] * t], normal: [-Math.sign(d[0]), 0, 0] };
    }
    for (const b of boxes) {
      let t0 = 0, t1 = 1;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) {
          if (o[k] < b.min[k] || o[k] > b.max[k]) t0 = 2;
          continue;
        }
        let a = (b.min[k] - o[k]) / d[k], c = (b.max[k] - o[k]) / d[k];
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
      }
      if (t0 > t1 || t0 > 1) continue;
      const dist = t0 * len;
      if (!best || dist < best.distance) best = { distance: dist, point: [o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0], normal: [0, 1, 0], body: b.body };
    }
    return best;
  };
}

test('swept quad: the blade at points of the move, then the paths of its two ends', () => {
  const prev = { a: [0, 1, 0] as Vec3, b: [0, 1, -1] as Vec3 };
  const cur = { a: [0, 1, 0] as Vec3, b: [1, 1, 0] as Vec3 };
  const segs = sweptQuadSegments(prev, cur, 4);
  assert.equal(segs.length, 4 + 2);
  assert.deepEqual(segs[3], [cur.a, cur.b]);
  assert.deepEqual(segs[4], [prev.b, cur.b]);
  // A blade that did not move: its current place only.
  assert.equal(sweptQuadSegments(cur, cur).length, 1);
});

test('blade contacts: each body once a window, both cast directions, level geometry left out', () => {
  // A crate 1.4 m wide 0.6..2 m in front (-z); the blade swings across it from the side.
  const crate = { body: 5, min: [-0.7, 0, -2] as Vec3, max: [0.7, 1.3, -0.6] as Vec3 };
  const cast = boxCaster([crate]);
  const prev = { a: [-0.6, 1, -0.2] as Vec3, b: [-1.2, 1, -1.2] as Vec3 };
  const cur = { a: [0.1, 1, -0.3] as Vec3, b: [0.2, 1, -1.5] as Vec3 };
  const hits = bladePropContacts(sweptQuadSegments(prev, cur), cast);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].body, 5);
  // Struck already in this Arm window: nothing.
  assert.equal(bladePropContacts(sweptQuadSegments(prev, cur), cast, new Set([5])).length, 0);
  // A blade starting inside the body still finds it (the reverse cast).
  const inside = bladePropContacts([[[0, 1, -1], [0, 1, -0.2]]], cast);
  assert.equal(inside.length, 1);
  // A gate's bars (body 9) and a wall in front of the crate do not hide it: every object in the
  // swept volume is a candidate (the walls only block through the wall test).
  const gated = boxCaster([crate, { body: 9, min: [-1, 0, -0.5], max: [1, 2, -0.45] }], { x: -0.3 });
  const both = bladePropContacts([[[0.5, 1, 0], [-0.5, 1, -1.5]]], gated);
  assert.deepEqual(both.map((h) => h.body).sort(), [5, 9]);
  // Swung in the air beside it: nothing.
  assert.equal(bladePropContacts(sweptQuadSegments({ a: [2, 1, 0], b: [2, 1, -1] }, { a: [3, 1, 0], b: [3, 1, -1] }), cast).length, 0);
});

test('the wall test: a ray from the wielder at the contact height; the struck body itself does not block', () => {
  const crate = { body: 5, min: [-0.7, 0, -2] as Vec3, max: [0.7, 1.3, -0.6] as Vec3 };
  const first = (o: Vec3, dir: Vec3, len: number) => {
    const h = boxCaster([crate], { x: 1 })(o, [o[0] + dir[0] * len, o[1] + dir[1] * len, o[2] + dir[2] * len]);
    return h ? { distance: h.distance, body: h.body } : null;
  };
  const castNoWall = (o: Vec3, dir: Vec3, len: number) => {
    const h = boxCaster([crate])(o, [o[0] + dir[0] * len, o[1] + dir[1] * len, o[2] + dir[2] * len]);
    return h ? { distance: h.distance, body: h.body } : null;
  };
  assert.equal(bladeWallClear({ x: 0, z: 0 }, [0, 1, -0.6], 5, castNoWall), true);
  // A wall (x = 1) between the wielder at x 1.5 and a contact on the crate's +x face.
  assert.equal(bladeWallClear({ x: 1.5, z: -1 }, [0.7, 1, -1], 5, first), false);
  assert.equal(bladeWallClear({ x: 1.5, z: -1 }, [0.7, 1, -1], 5, castNoWall), true);
});

test('blows to break: shiv 8 x Attack p6, resistance multiplier', () => {
  assert.equal(blowsToBreak(13, [8, 9.6, 12]), 2);
  assert.equal(blowsToBreak(13, [12.8]), 2);
  assert.equal(blowsToBreak(10, [8, 9.6, 12]), 2);
  assert.equal(blowsToBreak(5, [8], 0), Infinity);
});

function loadPackages() {
  const packages = new Map<number, EntityPackage & { mdu?: ReturnType<typeof readSrsc> }>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || packages.has(id)) continue;
    const base = db.slice(0, -3);
    const load = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    packages.set(id, { id, name: base, odu: load(`${base}.odu`), xdu: load(`${base}.xdu`), qdu: load(`${base}.qdu`), mdu: load(`${base}.mdu`) });
  }
  return packages;
}

test('1a crate 8153: the shiv breaks it in two blows; the 9:5353 junk piles take only explosions and fire', { skip }, () => {
  const packages = loadPackages();
  const ents = parseEntities(readSrsc('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'), packages);
  const crate = ents.find((e) => e.uid === 0x8153)!;
  assert.equal(crate.className, 'Breakable');
  assert.deepEqual(crate.template, { pkg: 7, id: 1842 });
  assert.equal(crate.values[0], 13);
  assert.equal(crate.values[5], 0);
  // Shiv 4:79: p68 8, type 10; combo Attack p6 1 / 1.2 / 1.5, first person one strike x1.6.
  const shiv = weaponDef(packages, { pkg: 4, id: 79 })!;
  assert.equal(shiv.damageMin, 8);
  assert.equal(shiv.damageType, 10);
  const tp = shiv.pwp!.attacks.map((a) => shiv.damageMin * a.mult);
  const fp = shiv.pwp!.fpAttacks.map((a) => shiv.damageMin * a.mult);
  assert.deepEqual(tp.map((x) => +x.toFixed(2)), [8, 9.6, 12]);
  assert.deepEqual(fp.map((x) => +x.toFixed(2)), [12.8]);
  const m10 = resistanceMultiplier(packages, crate.values, 10);
  assert.equal(m10, 1);
  assert.equal(blowsToBreak(13, tp, m10), 2);
  assert.equal(blowsToBreak(13, fp, m10), 2);
  // Its blade: model 4:23's two nodes, a 1.2 m segment from the hilt along -z.
  const nodes = readModelSphereNodes(packages.get(4)!.mdu!, 23);
  const s = weaponShape(nodes)!;
  assert.ok(s.b);
  assert.ok(Math.abs(Math.hypot(s.a[0] - s.b![0], s.a[1] - s.b![1], s.a[2] - s.b![2]) - 1.195) < 0.01);
  // 9:5353 (p5 = 1, Damage Resistance 2:662 type 3 / 2:670 type 5, both x1).
  const junk = parseEntities(readSrsc('LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl'), packages).find((e) => e.uid === 0x843b)!;
  assert.deepEqual(junk.template, { pkg: 9, id: 5353 });
  assert.equal(resistanceMultiplier(packages, junk.values, 10), 0); // shiv
  assert.equal(resistanceMultiplier(packages, junk.values, 1), 0); // bullets
  assert.equal(resistanceMultiplier(packages, junk.values, 13), 0); // shotgun
  assert.equal(resistanceMultiplier(packages, junk.values, 3), 1); // explosion
  assert.equal(resistanceMultiplier(packages, junk.values, 5), 1); // fire
});
