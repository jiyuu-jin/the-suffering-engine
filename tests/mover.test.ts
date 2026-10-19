// The character mover (src/game/actors/mover.ts, docs/game-logic.md §14.9): a template's Collider
// spheres, the ground under the feet point, p46 / p48.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { CharacterMotor, CollisionWorld, centreGround } from '../src/app/physics';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../src/formats/entities';
import type { MeshPart } from '../src/formats/types';
import type { ModelSphereNode } from '../src/formats/model-spheres';
import { colliderSpheres, moverVolume, npcMotorConfig, readMoverVolume } from '../src/game/actors/mover';
import { nodeFS, readSrsc, skip } from './helpers';

const node = (first: number, next: number, y: number, r: number): ModelSphereNode => ({ first, next, center: [0, y, 0], radius: r });
// The CartWheeler's Collider 10:77 (model 10:9): a bounding sphere, then the chain 2 -> 3 -> 4 -> 1.
const CW = [node(2, 0, 0.85, 1.25), node(0, 0, 0, 0.4), node(0, 3, 1.704, 0.4), node(0, 4, 1.225, 0.4), node(0, 1, 0.791, 0.4)];

test('a Collider: node 0 is the bounds, its chain the spheres; the foot sphere is left out of the blocking hull', () => {
  assert.deepEqual(colliderSpheres(CW).map((s) => s.node), [2, 3, 4, 1]);
  const v = moverVolume(CW, 1, 0.4, 45)!;
  assert.equal(v.footRadius, 0.4);
  assert.equal(v.radius, 0.4);
  assert.ok(Math.abs(v.bottom - 0.391) < 1e-6 && Math.abs(v.top - 2.104) < 1e-6, `${v.bottom} .. ${v.top}`);
  assert.equal(moverVolume(CW, 7, 0.4, 45), undefined, 'no such foot sphere');
  // Positions are relative to the foot sphere (10:1429 has its foot at -0.5).
  const low = [node(1, 0, 0, 0.75), node(0, 3, -0.5, 0.25), node(0, 0, 0, 0.25), node(0, 2, 0.5, 0.25)];
  const w = moverVolume(low, 1, 0.2, 40)!;
  assert.ok(Math.abs(w.bottom - 0.25) < 1e-6 && Math.abs(w.top - 1.25) < 1e-6);
  // A lone foot sphere blocks too.
  const one = moverVolume([node(1, 0, 0, 1), node(0, 0, 0, 0.3)], 1, 0.2, 45)!;
  assert.equal(one.bottom, 0);
  assert.equal(one.top, 0.3);
});

test('the NPC motor: the capsule is the hull above the foot radius, the probe starts at the foot radius, p48 the snap, p46 the slope; instance values win', () => {
  const m = moverVolume(CW, 1, 0.4, 45)!;
  const c = npcMotorConfig(m);
  assert.equal(c.groundProbe, 'centre');
  assert.equal(c.radius, 0.4);
  assert.equal(c.stepHeight, 0.4, 'the capsule starts at the foot radius (the hull bottom is 0.391)');
  assert.equal(c.height, m.top);
  assert.equal(c.probeTop, 0.4);
  // A Rat (10:521): foot r 0.2, one blocking sphere r 0.3 at 0.394 (its bottom 0.094): climbs 0.2.
  const rat = npcMotorConfig(moverVolume([node(1, 0, 0.266, 0.5), node(0, 2, 0, 0.2), node(0, 0, 0.394, 0.3)], 1, 0.2, 75)!);
  assert.equal(rat.probeTop, 0.2);
  assert.equal(rat.stepHeight, 0.2);
  assert.ok(Math.abs((rat.height ?? 0) - 0.8) < 1e-6, 'a capsule of two radii at least');
  assert.equal(c.snapDistance, 0.4);
  assert.equal(c.slopeLimitDeg, 45);
  const v: (number | null)[] = [];
  v[46] = 30;
  v[48] = 0.1;
  const o = npcMotorConfig(m, v);
  assert.equal(o.snapDistance, 0.1);
  assert.equal(o.slopeLimitDeg, 30);
  // The spheres scale with the character; p48 does not.
  const big = npcMotorConfig(m, undefined, 1.5);
  assert.ok(Math.abs((big.radius ?? 0) - 0.6) < 1e-9 && Math.abs((big.height ?? 0) - 2.104 * 1.5) < 1e-9 && Math.abs((big.probeTop ?? 0) - 0.6) < 1e-9);
  assert.equal(big.snapDistance, 0.4);
});

// ---------------------------------------------------------------------------
// Ground rules on simple geometry.

/** Axis-aligned box as triangles facing out. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): MeshPart {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [3, 2, 6, 7], // top (+y)
    [0, 4, 5, 1], // bottom
    [0, 3, 7, 4], // -x
    [1, 5, 6, 2], // +x
    [0, 1, 2, 3], // -z
    [4, 7, 6, 5], // +z
  ];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a, b, c, a, c, d);
  return { positions: new Float32Array(p.flat()), indices: new Uint32Array(idx) } as unknown as MeshPart;
}

const FLOOR = box(-20, -1, -20, 20, 0, 20);
const idle = { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false };
const cw = () => npcMotorConfig(moverVolume(CW, 1, 0.4, 45)!);

function settle(m: CharacterMotor, x: number, y: number, z: number, secs = 1.5) {
  m.position.x = x; m.position.y = y; m.position.z = z;
  m.velocity.x = m.velocity.y = m.velocity.z = 0;
  m.onGround = true;
  for (let i = 0; i < secs * 60; i++) m.step(1 / 60, idle);
  return m.position;
}

test('ledge rims: a body whose centre is over the drop falls off', () => {
  // A platform 1 m high, its rim at x = 0.
  const col = new CollisionWorld({ parts: [FLOOR, box(-5, 0, -5, 0, 1, 5)] });
  const p = settle(new CharacterMotor(col, cw()), 0.25, 1, 0);
  assert.ok(p.y < 0.05, `fell to the floor (y ${p.y.toFixed(2)})`);
  assert.ok(p.x > 0.3, `slid off the rim (x ${p.x.toFixed(2)})`);
  // Centre over the platform: stands.
  assert.ok(Math.abs(settle(new CharacterMotor(col, cw()), -0.05, 1, 0).y - 1) < 0.01, 'stands on the rim with its centre over it');
  // The 1.5 cm nudge: a point within 1.5 cm of the rim still stands.
  assert.ok(Math.abs(settle(new CharacterMotor(col, cw()), 0.01, 1, 0, 0.2).y - 1) < 0.01, 'within the nudge');
});

test('the ground under the point: the first walkable surface below (steep faces are passed through)', () => {
  const ramp = {
    // A 60 degree face from (0, 0) up to (1, 1.732) across z, above the floor.
    positions: new Float32Array([0, 0.5, -2, 1, 2.232, -2, 0, 0.5, 2, 1, 2.232, 2]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
  } as unknown as MeshPart;
  const col = new CollisionWorld({ parts: [FLOOR, ramp] });
  const g = centreGround(col, 0.5, 3, 0, 5, Math.cos((45 * Math.PI) / 180))!;
  assert.ok(g.walkable && Math.abs(g.height) < 1e-4, 'the floor under the steep face');
  assert.equal(centreGround(col, 0.5, 3, 0, 2, Math.cos((45 * Math.PI) / 180))?.walkable, false, 'only the steep face in reach');
  assert.equal(centreGround(col, 30, 3, 0, 5, 0.7), null, 'nothing under the point');
});

test('step up to the foot radius, down to p48; deeper drops are falls', () => {
  // A 0.3 m step and a 0.6 m one ahead along +x.
  const up = new CollisionWorld({ parts: [FLOOR, box(1, 0, -5, 10, 0.3, 5)] });
  const m = new CharacterMotor(up, cw());
  settle(m, 0, 0, 0, 0.2);
  for (let i = 0; i < 120; i++) m.step(1 / 60, { ...idle, wishX: 1 });
  assert.ok(m.position.x > 1.5 && Math.abs(m.position.y - 0.3) < 0.01, `climbed the 0.3 m step (${m.position.x.toFixed(2)}, ${m.position.y.toFixed(2)})`);
  const high = new CollisionWorld({ parts: [FLOOR, box(1, 0, -5, 10, 0.6, 5)] });
  const h = new CharacterMotor(high, cw());
  settle(h, 0, 0, 0, 0.2);
  for (let i = 0; i < 120; i++) h.step(1 / 60, { ...idle, wishX: 1 });
  assert.ok(h.position.x < 1 && h.position.y < 0.01, `stopped by the 0.6 m step (${h.position.x.toFixed(2)})`);

  // Down: 0.3 m below the feet is within p48 (0.4): the feet follow it without leaving the ground.
  const down = new CollisionWorld({ parts: [FLOOR, box(-10, 0, -5, 0, 0.3, 5)] });
  const d = new CharacterMotor(down, cw());
  settle(d, -1, 0.3, 0, 0.2);
  let airborne = 0;
  for (let i = 0; i < 90; i++) {
    d.step(1 / 60, { ...idle, wishX: 1 });
    if (!d.onGround) airborne++;
  }
  assert.ok(d.position.x > 0.5 && d.position.y < 0.01 && airborne === 0, `followed the 0.3 m drop (${airborne} frames airborne)`);
  // 0.6 m below: the fall starts.
  const cliff = new CollisionWorld({ parts: [FLOOR, box(-10, 0, -5, 0, 0.6, 5)] });
  const f = new CharacterMotor(cliff, cw());
  settle(f, -1, 0.6, 0, 0.2);
  airborne = 0;
  for (let i = 0; i < 90; i++) {
    f.step(1 / 60, { ...idle, wishX: 1 });
    if (!f.onGround) airborne++;
  }
  assert.ok(airborne > 0 && f.position.y < 0.01, 'fell the 0.6 m drop');
});

test('the Slayer fits under a 3.3 m log its bind-pose capsule (3.8 m) did not; a 0.72 Slayer stands in a 2.7 m room', () => {
  // Slayer Collider 10:1389: spheres r 0.65 at 0 (foot), 1.3 and 2.5.
  const slayer = npcMotorConfig(moverVolume([node(1, 0, 1.2, 1.95), node(0, 3, 0, 0.65), node(0, 0, 2.5, 0.65), node(0, 2, 1.3, 0.65)], 1, 0.8, 75)!);
  assert.ok(Math.abs((slayer.height ?? 0) - 3.15) < 1e-6);
  const col = new CollisionWorld({ parts: [FLOOR, box(2, 3.3, -5, 3, 4, 5)] });
  const walk = (cfg: ConstructorParameters<typeof CharacterMotor>[1]) => {
    const m = new CharacterMotor(col, cfg);
    settle(m, 0, 0, 0, 0.2);
    for (let i = 0; i < 180; i++) m.step(1 / 60, { ...idle, wishX: 1 });
    return m.position.x;
  };
  assert.ok(walk(slayer) > 4, 'passes under');
  assert.ok(walk({ radius: 0.6, height: 3.8, stepHeight: 0.4 }) < 2, 'the old capsule stopped');
  // 1b's Slayer 7ffc (scale 0.72) under a 2.72 m ceiling: unscaled (3.15 m) the ceiling pressed it
  // into the floor; scaled (2.27 m) it stands on it.
  const room = new CollisionWorld({ parts: [FLOOR, box(-20, 2.72, -20, 20, 3.5, 20)] });
  const nodes = [node(1, 0, 1.2, 1.95), node(0, 3, 0, 0.65), node(0, 0, 2.5, 0.65), node(0, 2, 1.3, 0.65)];
  const small = new CharacterMotor(room, npcMotorConfig(moverVolume(nodes, 1, 0.8, 75)!, undefined, 0.72));
  settle(small, 0, 0, 0, 0.5);
  for (let i = 0; i < 60; i++) small.step(1 / 60, { ...idle, wishX: 1 });
  assert.ok(Math.abs(small.position.y) < 1e-3, `on the floor (${small.position.y.toFixed(3)})`);
});

const L3A = 'LEVELS/3 YardCellBlock/3a YardCellBlock.lvl';

test('retail: the characters\' Colliders (Character p42, p46, p48)', { skip }, async () => {
  const lvl = readSrsc(L3A);
  const pkgs = await loadPackages(nodeFS(), dirname(L3A), readLevelHeader(lvl).dependencies, () => {});
  const tpl = (pkg: number, id: number) => {
    const t = readObjectTemplate(pkgs as never, { pkg, id })!;
    return decodeTemplateProps(classByHash(t.classHash), t);
  };
  // CartWheeler 10:24: Collider 10:77, p46 45, p47 60, p48 0.4.
  const cw = readMoverVolume(pkgs, tpl(10, 24))!;
  assert.ok(Math.abs(cw.footRadius - 0.4) < 1e-6);
  assert.ok(Math.abs(cw.bottom - 0.391) < 1e-4 && Math.abs(cw.top - 2.104) < 1e-4);
  assert.ok(Math.abs(cw.stepDown - 0.4) < 1e-6);
  assert.equal(cw.slopeDeg, 45);
  // Slayer 10:527: Collider 10:1389, p46 75, p48 0.8.
  const sl = readMoverVolume(pkgs, tpl(10, 527))!;
  assert.ok(Math.abs(sl.footRadius - 0.65) < 1e-6);
  assert.ok(Math.abs(sl.top - 3.15) < 1e-4 && Math.abs(sl.bottom - 0.65) < 1e-4);
  assert.ok(Math.abs(sl.stepDown - 0.8) < 1e-6);
  // People 10:3 (Unspeakable NPC): Collider 10:149, spheres r 0.45 at 0, 0.865, 1.703.
  const npc = readMoverVolume(pkgs, tpl(10, 3))!;
  assert.ok(Math.abs(npc.radius - 0.45) < 1e-6);
  assert.ok(Math.abs(npc.top - 2.153) < 1e-4 && Math.abs(npc.bottom - 0.415) < 1e-4);
});

test('a push on the player is a sweep of his capsule: a sill under the waist stops it (5b theatre fall)', () => {
  // A 0.7 m sill from x = 1 and a floor beyond it 3 m lower: a waist-high ray (0.9 m) passes over
  // the sill; the old push moved the feet onto / into it.
  const col = new CollisionWorld({ parts: [box(-20, -1, -20, 1, 0, 20), box(1, 0, -5, 1.2, 0.7, 5), box(1.2, -4, -20, 20, -3, 20)] });
  const m = new CharacterMotor(col, { radius: 0.35, height: 1.8, stepHeight: 0.4 });
  settle(m, 0.5, 0, 0, 0.2);
  assert.equal(col.raycast(0.5, 0.9, 0, 1, 0, 0, 2), null, 'the waist ray sees nothing');
  m.shove(1.5, 0);
  assert.ok(m.position.x <= 1 - 0.35 + 0.01, `stopped at the sill (x ${m.position.x.toFixed(3)})`);
  assert.equal(m.position.y, 0);
  // Along the sill it slides.
  m.shove(0.3, 1);
  assert.ok(Math.abs(m.position.z - 1) < 1e-3 && m.position.x <= 0.66);
});
