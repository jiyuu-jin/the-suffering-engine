// Player melee root motion (src/game/weapons/melee-lunge.ts; docs/game-logic.md §14.1 "Player
// melee: root motion"): the strike clip's root moves the player through the motor, its forward
// part scaled by the swung Player Weapon Properties' p85 when no target is picked on the ground.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { MeleeLunge, lungeToWorld, meleeRootScale, readLungeScale } from '../src/game/weapons/melee-lunge';
import { CharacterMotor, CollisionWorld } from '../src/app/physics';
import { PlayerController } from '../src/app/player';
import { ROOT_BONE_HASH, readAnimation, rootMotion, type AnimClipData } from '../src/formats/animation';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage, type EntityPackageSet } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';
import type { MeshPart } from '../src/formats/types';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';

/** A once-clip whose root goes `dz` along z (and `dx` along x) linearly over `dur` seconds. */
const clip = (dur: number, dz: number, dx = 0, rate = 1): AnimClipData => ({
  id: 1,
  animSet: 0,
  duration: dur,
  flags: 1,
  blendTime: 0,
  rate,
  links: [],
  tracks: [
    {
      boneHash: ROOT_BONE_HASH,
      format: 0x80,
      times: new Float32Array([0, dur]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      translations: new Float32Array([0, 0, 0, dx, 0, dz]),
      constantTranslation: [0, 0, 0],
    },
  ],
});

test('z scale (MeleeAttack per frame 0x10029ff0): p85 only on the ground, with no target, outside the p89 class', () => {
  assert.equal(meleeRootScale({ onGround: true, target: false, alternate: false, p85: 0.5 }), 0.5);
  assert.equal(meleeRootScale({ onGround: true, target: true, alternate: false, p85: 0.5 }), 1, 'a live target: the full lunge');
  assert.equal(meleeRootScale({ onGround: false, target: false, alternate: false, p85: 0.5 }), 1, 'in the air');
  assert.equal(meleeRootScale({ onGround: true, target: false, alternate: true, p85: 0.5 }), 1, 'class 3 (p89)');
  assert.equal(readLungeScale([...Array(85).fill(0), 0.5]), 0.5);
  assert.equal(readLungeScale([]), 1);
  assert.equal(readLungeScale(undefined), 1);
});

test('the clip root is sampled on its own clock, scaled on z, and held at the end', () => {
  const l = new MeleeLunge();
  assert.equal(l.active, false);
  l.start(clip(0.2, -0.8, 0.1));
  let z = 0, x = 0;
  for (let i = 0; i < 30; i++) {
    const d = l.step(1 / 60, i < 6 ? 1 : 0.5);
    x += d.x;
    z += d.z;
  }
  // 0.1 s at scale 1 then 0.1 s at 0.5: -0.4 - 0.2; x is never scaled.
  assert.ok(Math.abs(z + 0.6) < 1e-6, `z ${z}`);
  assert.ok(Math.abs(x - 0.1) < 1e-6, `x ${x}`);
  assert.ok(Math.abs(l.moved.z + 0.6) < 1e-6);
  assert.deepEqual(l.step(1 / 60, 1), { x: 0, z: 0 }, 'held at the end');
  // The clip's rate speeds its clock (2:212 plays at 1.6).
  l.start(clip(0.4, -1, 0, 2));
  l.step(0.1, 1);
  assert.ok(Math.abs(l.moved.z + 0.5) < 1e-6, `${l.moved.z}`);
  l.stop();
  assert.equal(l.active, false);
  assert.deepEqual(l.step(0.1, 1), { x: 0, z: 0 });
});

test('model space to world: the clip forward (-Z) is the body yaw forward', () => {
  const f = lungeToWorld(0, -1, 0);
  assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.z + 1) < 1e-9);
  const l = lungeToWorld(0, -1, Math.PI / 2); // yaw 90: looking down -X
  assert.ok(Math.abs(l.x + 1) < 1e-9 && Math.abs(l.z) < 1e-9);
  const r = lungeToWorld(1, 0, Math.PI / 2); // the right of a body looking down -X is -Z
  assert.ok(Math.abs(r.x) < 1e-9 && Math.abs(r.z + 1) < 1e-9);
});

const floor = (x0: number, x1: number, z0: number, z1: number, y = 0): MeshPart =>
  ({ positions: new Float32Array([x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1]), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) }) as unknown as MeshPart;
const wall = (z: number): MeshPart =>
  ({ positions: new Float32Array([-5, -1, z, 5, -1, z, -5, 4, z, 5, 4, z]), indices: new Uint32Array([0, 1, 2, 1, 3, 2]) }) as unknown as MeshPart;
const idle = { wishX: 0, wishZ: 0, run: false, crouch: false, jump: false };

test('motor: root motion moves the feet like the step itself (walls stop it, ledges drop)', () => {
  // Open floor: the whole displacement.
  const open = new CharacterMotor(new CollisionWorld({ parts: [floor(-5, 5, -5, 5)] }));
  open.teleport(0, 0, 0);
  for (let i = 0; i < 10; i++) open.step(1 / 60, { ...idle, moveZ: -0.08 });
  assert.ok(Math.abs(open.position.z + 0.8) < 1e-3, `z ${open.position.z}`);
  assert.ok(open.onGround);
  // A wall 0.6 m ahead: the capsule stops at it.
  const walled = new CharacterMotor(new CollisionWorld({ parts: [floor(-5, 5, -5, 5), wall(-0.6)] }));
  walled.teleport(0, 0, 0);
  for (let i = 0; i < 20; i++) walled.step(1 / 60, { ...idle, moveZ: -0.1 });
  assert.ok(walled.position.z > -0.6 + walled.cfg.radius - 0.05, `stopped at ${walled.position.z}`);
  // The floor ends 0.3 m ahead over a 2 m drop: carried off the edge, the player falls.
  const ledge = new CharacterMotor(new CollisionWorld({ parts: [floor(-5, 5, -0.3, 5), floor(-5, 5, -5, -0.3, -2)] }));
  ledge.teleport(0, 0, 0);
  for (let i = 0; i < 12; i++) ledge.step(1 / 60, { ...idle, moveZ: -0.1 });
  assert.equal(ledge.onGround, false);
  assert.ok(ledge.position.z < -1, `${ledge.position.z}`);
});

// PlayerController listens to the page; node has none.
const g = globalThis as unknown as { document?: unknown; window?: unknown };
const events = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null };
g.document ??= events;
g.window ??= events;

test('player: holdMove ignores the stick, rootMove is spent by the next update', () => {
  const p = new PlayerController(new THREE.PerspectiveCamera(), events as unknown as HTMLElement);
  p.enabled = true;
  p.setWorld(new CollisionWorld({ parts: [floor(-20, 20, -20, 20)] }));
  p.teleport(new THREE.Vector3(0, 0, 0), 0);
  for (let i = 0; i < 5; i++) p.update(1 / 60);
  p.holdMove = true;
  p.setVirtualInput({ forward: 1, strafe: 0, run: true });
  p.rootMove.z = -0.5;
  p.update(1 / 60);
  assert.equal(p.rootMove.z, 0, 'spent');
  for (let i = 0; i < 30; i++) p.update(1 / 60);
  assert.ok(Math.abs(p.position.z + 0.5) < 0.02, `only the root moved: ${p.position.z}`);
  p.holdMove = false;
  for (let i = 0; i < 30; i++) p.update(1 / 60);
  assert.ok(p.position.z < -1.5, `walking again: ${p.position.z}`);
});

function systemPackages(): EntityPackageSet {
  const pkgs = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id !== 2 || pkgs.has(id)) continue;
    const base = db.slice(0, -3);
    pkgs.set(2, { id: 2, name: 'System', odu: readSrsc(base + '.odu'), adu: readSrsc(base + '.adu') } as unknown as EntityPackage);
  }
  return pkgs;
}

test('data: p85 of the melee sets, and which strike clips carry a root', { skip }, () => {
  const pkgs = systemPackages();
  const vals = (r: ResRef) => {
    const t = readObjectTemplate(pkgs, r)!;
    return decodeTemplateProps(classByHash(t.classHash)!, t) as unknown[];
  };
  const adu = (pkgs.get(2) as unknown as { adu: ReturnType<typeof readSrsc> }).adu;
  const fwd = (id: number) => rootMotion(readAnimation(adu, id)!)[2];
  // Shiv 2:303, fire axe 2:431, creature 2:241: 0.5; the empty hand 2:409 (p10 0.01, never a target): 1.
  for (const id of [303, 431, 241]) assert.equal(readLungeScale(vals({ pkg: 2, id })), 0.5, `2:${id}`);
  assert.equal(readLungeScale(vals({ pkg: 2, id: 409 })), 1);
  // Third-person strikes move forward (-Z): shiv 2:124 0.80 m, 2:210 0.87, 2:209 1.18; axe 2:523 0.82.
  for (const [id, d] of [[124, 0.798], [210, 0.87], [209, 1.179], [523, 0.822], [354, 1.241], [366, 4.838]] as const) assert.ok(Math.abs(fwd(id) + d) < 0.005, `2:${id} ${fwd(id)}`);
  // First-person strikes (2:218 shiv / unarmed, 2:269 axe): a rotation-only root, no motion.
  for (const id of [218, 269]) {
    const c = readAnimation(adu, id)!;
    const t = c.tracks.find((x) => x.boneHash === ROOT_BONE_HASH)!;
    assert.equal(t.translations, undefined, `2:${id}`);
    assert.deepEqual([...t.constantTranslation], [0, 0, 0]);
  }
});

test('data: the creature form reads its PWP 2:241 p85 (insanity/params.ts readForm)', { skip }, async () => {
  const { readForm } = await import('../src/game/insanity/params');
  const pkgs = systemPackages();
  assert.equal(readForm(pkgs, { pkg: 2, id: 240 })?.lungeScale, 0.5);
  assert.equal(readForm(pkgs, { pkg: 2, id: 5 })?.lungeScale, 1, 'the human form: the empty hand 2:409');
});
