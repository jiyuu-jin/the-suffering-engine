// 9 Lighthouse's buried Infernas and the 9 -> 10 run (docs/game-logic.md §14.9, §15.7.11, §15.10):
// movers pass Decorations (the class lists of the movers' collision filters), the ground follower's
// Landscape fallback, and the Black Ones' saved state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { CharacterMotor, COLLISION_LAYER, CollisionWorld, landscapeGround, LANDSCAPE_PROBE } from '../src/app/physics';
import { loadPackages } from '../src/app/loader';
import { parseLevel, readLevelHeader } from '../src/formats/level';
import { parseEntities } from '../src/formats/entities';
import type { MeshPart } from '../src/formats/types';
import type { ModelSphereNode } from '../src/formats/model-spheres';
import { moverVolume, npcMotorConfig } from '../src/game/actors/mover';
import { decorationUids } from '../src/game/world/blockers';
import { BlackOne, Fight } from '../src/game/actors/specials/black-one';
import type { BlackOneStage } from '../src/game/actors/specials/params';
import { nodeFS, readSrsc, skip } from './helpers';

const node = (first: number, next: number, y: number, r: number): ModelSphereNode => ({ first, next, center: [0, y, 0], radius: r });
// The Inferna's Collider 10:1221 (model 10:126): foot r 0.4 at 0, one sphere r 0.4 at 0.865; p46 45, p48 1.
const INFERNA = npcMotorConfig(moverVolume([node(2, 0, 0.526, 1), node(0, 0, 0, 0.4), node(0, 1, 0.865, 0.4)], 1, 1, 45)!);

/** A horizontal quad at height y over [x0, x1] x [z0, z1] (both windings: seen from above and below). */
function quad(x0: number, z0: number, x1: number, z1: number, y: number, extra: Partial<MeshPart> = {}): MeshPart {
  return {
    positions: new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    ...extra,
  } as unknown as MeshPart;
}
const LAND = { splat: [{ texture: '6:1', tiling: 1, fade: 1 }] } as unknown as Partial<MeshPart>;
const idle = { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false };

function settle(m: CharacterMotor, x: number, y: number, z: number, secs = 1, wishX = 0) {
  m.position.x = x; m.position.y = y; m.position.z = z;
  m.velocity.x = m.velocity.y = m.velocity.z = 0;
  m.onGround = true;
  for (let i = 0; i < secs * 60; i++) m.step(1 / 60, { ...idle, wishX });
  return m.position;
}

test('Decorations: movers pass them, sight and shots still see them (the movers\' collide lists name no Decoration)', () => {
  // 9's burial ground: the terrain at 0 and a 12 m fog quad (Decoration 3:2181, model 3:440) 0.478 m over it.
  const col = new CollisionWorld({ parts: [quad(-20, -20, 20, 20, 0, LAND), quad(-6, -6, 6, 6, 0.478, { moveSolid: false })] });
  assert.equal(col.triLayers[0] & COLLISION_LAYER.landscape, COLLISION_LAYER.landscape);
  const hit = col.raycast(0, 2, 0, 0, -1, 0, 5);
  assert.ok(hit && Math.abs(hit.point[1] - 0.478) < 1e-4, 'a plain ray stops on the fog quad');
  // An Inferna placed under the quad (c9d) and walking out from under it stays on the terrain.
  const m = new CharacterMotor(col, INFERNA);
  const p = settle(m, 0, 0, 0, 3, 1);
  assert.ok(p.x > 6 && Math.abs(p.y) < 1e-3, `walked out on the terrain (${p.x.toFixed(2)}, ${p.y.toFixed(3)})`);
  // Walking in from outside: it passes under it (before: its capsule, from 0.465 m, met the quad's
  // edge as a wall, and where the terrain rose under it, stood on the quad).
  const back = settle(new CharacterMotor(col, INFERNA), 10, 0, 0, 8, -1);
  assert.ok(back.x < -6 && Math.abs(back.y) < 1e-3, `walked through under it (${back.x.toFixed(2)}, ${back.y.toFixed(3)})`);
  // The same quad solid (the old rule) stops it.
  const solid = new CollisionWorld({ parts: [quad(-20, -20, 20, 20, 0, LAND), quad(-6, -6, 6, 6, 0.478)] });
  const stuck = settle(new CharacterMotor(solid, INFERNA), 10, 0, 0, 8, -1);
  assert.ok(stuck.x > 6, `the solid quad's edge held it (${stuck.x.toFixed(2)})`);
});

test('the ground follower\'s Landscape fallback: a body under the terrain stands on it; not under other floors', () => {
  // bd5: placed 0.663 m under the terrain; its probe (from the foot radius, 0.4 m) is under the surface.
  const land = new CollisionWorld({ parts: [quad(-20, -20, 20, 20, 0.663, LAND)] });
  assert.equal(LANDSCAPE_PROBE, 2);
  assert.ok(Math.abs((landscapeGround(land, 0, 0, 0, 1, 0.7)?.height ?? NaN) - 0.663) < 1e-4);
  assert.equal(landscapeGround(land, 0, -1.5, 0, 1, 0.7), null, 'more than 2 m under it: out of the probe');
  const m = new CharacterMotor(land, INFERNA);
  m.teleport(0, 0, 0);
  assert.ok(m.onGround && Math.abs(m.position.y - 0.663) < 1e-3, `lifted onto the terrain (${m.position.y.toFixed(3)})`);
  // A walkable floor that is not the Landscape (an interior under the terrain) is not a fallback.
  const floor = new CollisionWorld({ parts: [quad(-20, -20, 20, 20, 0.663), quad(-20, -20, 20, 20, -5)] });
  const f = new CharacterMotor(floor, INFERNA);
  f.teleport(0, 0, 0);
  for (let i = 0; i < 120; i++) f.step(1 / 60, idle);
  assert.ok(!f.onGround && f.position.y < 0.6, `not lifted onto it (${f.position.y.toFixed(3)})`);
  // Mover ground present: it wins over the Landscape below it (a bridge over the terrain).
  const bridge = new CollisionWorld({ parts: [quad(-20, -20, 20, 20, 0, LAND), quad(-2, -2, 2, 2, 0.3)] });
  assert.ok(Math.abs(settle(new CharacterMotor(bridge, INFERNA), 0, 0.3, 0).y - 0.3) < 1e-3);
});

const L9 = 'LEVELS/9 Lighthouse/9 Lighthouse.lvl';

test('retail 9: the burial ground\'s fog quads are Decorations movers pass; c9d stands on the terrain, bd5 on it too', { skip }, async () => {
  const lvl = readSrsc(L9);
  const fs = nodeFS();
  const packages = await loadPackages(fs, dirname(L9), readLevelHeader(lvl).dependencies, () => {});
  const deco = new Set(decorationUids(lvl, packages));
  for (const u of [0x24d, 0x253, 0x8ed, 0x8f0]) assert.ok(deco.has(u), `fog quad ${u.toString(16)} (Decoration 3:2181)`);
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  assert.equal(ents.filter((e) => e.className === 'Decoration').length, deco.size);
  const ldu = readSrsc('LEVELS/9 Lighthouse/9 Lighthouse_level.ldu');
  const level = parseLevel(lvl, '9', { ldu, packages, moverPassUids: deco });
  const col = new CollisionWorld(level);
  // c9d (301, 112.305, 269): the quad 0.478 m over it for sight, the terrain for its motor.
  const sight = col.raycast(301, 115, 269, 0, -1, 0, 5);
  assert.ok(sight && Math.abs(sight.point[1] - 112.782) < 0.01, `sight hits the quad (${sight?.point[1]})`);
  const c9d = new CharacterMotor(col, INFERNA);
  c9d.teleport(301, 112.3047, 269);
  assert.ok(c9d.onGround && Math.abs(c9d.position.y - 112.305) < 0.01, `c9d on the terrain (${c9d.position.y.toFixed(3)})`);
  // bd5 (327, 112.926, 229): 0.663 m under the terrain.
  const bd5 = new CharacterMotor(col, INFERNA);
  bd5.teleport(327, 112.9263, 229);
  assert.ok(bd5.onGround && Math.abs(bd5.position.y - 113.589) < 0.01, `bd5 lifted onto the terrain (${bd5.position.y.toFixed(3)})`);
  // The companion bc9 (template 10:1020) regains 4 health a second (Character p161).
  const bc9 = ents.find((e) => e.uid === 0xbc9)!;
  assert.equal(bc9.values[161], 4);
  assert.equal(bc9.values[1], 100);
});

test('Black One save / load: the fight resumes (state, timers, stage, heart, holder) instead of sleeping', () => {
  const stage = (n: number): BlackOneStage =>
    ({
      ref: { pkg: 10, id: 1024 + n }, nearTimer: [10, 12], farTimer: [5, 6], nearRadius: 15, teleportWait: [2, 3], taunts: [], tauntsAfter: [], retreat: [], attacks: [],
      heartBone: 5, tintFull: 0xffffff, tintEmpty: 0, hurtFlash: 0.2, hurtSounds: [], stageHealth: n === 0 ? 100 : 80,
      msg: { on: 1, include: 0, exclude: 0, pull: 4, release: 5, triggered: 0, stage: 0, died: 0, appear: 0, vanish: 0 }, weaponBones: [], blowDamage: 20,
    }) as unknown as BlackOneStage;
  const logs: string[] = [];
  const rt = {
    template: () => undefined, modifier: () => 1, templateModel: () => undefined, log: (_a: unknown, s: string) => logs.push(s),
    manager: { env: undefined }, player: { position: { x: 0, y: 0, z: 0 } }, send: () => {}, sound: () => {}, ctx: { loaded: { packages: new Map() } },
  };
  const mk = (fight: Fight, uid: number) => {
    const a = { position: { x: 0, y: 0, z: 10 }, yaw: 0, ch: { root: { visible: false }, current: undefined, skeleton: { bones: [] } }, dormantHidden: true, state: 'idle', sync() {}, invulnerable: false } as never;
    return new BlackOne(a, { uid, links: [] } as never, fight, []);
  };
  const f1 = new Fight(rt as never, [stage(0), stage(1), stage(2)]);
  const [a1, b1] = [mk(f1, 0x822), mk(f1, 0x7f4)];
  f1.members.push(a1, b1);
  a1.activate();
  f1.stage = 1;
  f1.hp = 30;
  assert.equal(a1.st, 'fight');
  const saved = [a1.save(), b1.save()];
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, 'plain JSON');

  const f2 = new Fight(rt as never, [stage(0), stage(1), stage(2)]);
  const [a2, b2] = [mk(f2, 0x822), mk(f2, 0x7f4)];
  f2.members.push(a2, b2);
  a2.load(saved[0]);
  b2.load(saved[1]);
  const env = { player: { position: { x: 0, y: 0, z: 0 } }, time: 0, playerAlive: true } as never;
  a2.update(1 / 30, env);
  b2.update(1 / 30, env);
  assert.equal(f2.stage, 1);
  assert.equal(f2.hp, 30);
  assert.equal(f2.holder, a2, 'the holder keeps the heart');
  assert.ok(a2.st === 'fight' || a2.st === 'attack', `the holder fights (${a2.st})`);
  assert.equal((a2.a as unknown as { ch: { root: { visible: boolean } } }).ch.root.visible, true, 'shown');
  assert.equal(b2.st, 'hidden', 'the others stay hidden');
});

test('grouped Water Volumes: dynamic objects whose surfaces follow the group (10\'s 11aa / 11ab on Mechanisms 32d / 341)', async () => {
  const { MovingWater } = await import('../src/game/levels/water');
  const surfaces = new CollisionWorld({ parts: [] });
  let y = 98.387;
  const plane = () => [{ positions: new Float32Array([260, y, 260, 270, y, 260, 270, y, 270, 260, y, 270]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) }];
  const moving = new MovingWater(surfaces, (u) => (u === 0x11aa ? plane() : undefined), [0x11aa, 0x11ab]);
  assert.equal(moving.size, 1, 'only objects with parts');
  const at = () => surfaces.raycast(265, y + 5, 265, 0, -1, 0, 20)?.point[1];
  assert.ok(Math.abs((at() ?? 0) - 98.387) < 1e-3);
  y += 0.211; // Mechanism 32d's travel (p25)
  moving.update();
  assert.ok(Math.abs((at() ?? 0) - 98.598) < 1e-3, `the surface rose with it (${at()})`);
});

test('retail 10: Object Grouper members are dynamic objects (the pipe-yard water surfaces)', { skip }, async () => {
  const { dynamicObjectUids } = await import('../src/game/world/dynamic');
  const L10 = 'LEVELS/10 Docks/10 Docks.lvl';
  const lvl = readSrsc(L10);
  const packages = await loadPackages(nodeFS(), dirname(L10), readLevelHeader(lvl).dependencies, () => {});
  const dyn = dynamicObjectUids(lvl, packages);
  assert.ok(dyn.has(0x11aa) && dyn.has(0x11ab), 'the grouped water surfaces');
});
