// Player melee auto-face (src/game/weapons/melee-face.ts; docs/game-logic.md §14.1 "Player
// melee: facing and auto-face"): the target pick 0x1004b350, the Turn state's auto-face
// (0x10046dc0) and the swing-start body alignment, with the templates' values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import type { EntityPackage, EntityPackageSet } from '../src/formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../src/formats/entities';
import { readDbId, type ResRef } from '../src/formats/model';
import {
  CREATURE_MELEE_FACE,
  HUMAN_MELEE_FACE,
  MAX_GAIT_OFFSET_DEG,
  MeleeAutoFace,
  alignBodyForMelee,
  faceStep,
  pickMeleeTarget,
  readMeleeFaceParams,
  yawTo,
  type FaceCandidate,
  type FacePlayer,
} from '../src/game/weapons/melee-face';

const DEG = Math.PI / 180;
const O = { x: 0, y: 0, z: 0 };
/** A candidate `d` m away at `deg` degrees to the right of -Z (yaw 0), priority `pr`. */
const at = (deg: number, d: number, pr = 10, ref = `${deg}/${d}`): FaceCandidate<string> => ({ x: Math.sin(deg * DEG) * d, y: 0, z: -Math.cos(deg * DEG) * d, priority: pr, ref });

test('pick: characters within p223 of the body facing and the weapon range only', () => {
  const p = HUMAN_MELEE_FACE;
  // 90 deg cone: the front half; 4 m range (shiv / axe PWP p10).
  assert.equal(pickMeleeTarget(O, 0, 4, [at(120, 2)], p), undefined);
  assert.equal(pickMeleeTarget(O, 0, 4, [at(85, 2)], p)?.ref, '85/2');
  assert.equal(pickMeleeTarget(O, 0, 4, [at(0, 4.2)], p), undefined);
  // The facing is the body's: turned 180 deg, the one behind the view is in front.
  assert.equal(pickMeleeTarget(O, Math.PI, 4, [at(180, 2)], p)?.ref, '180/2');
  // The empty hand's PWP 2:409 has p10 = 0.01: nothing is ever picked.
  assert.equal(pickMeleeTarget(O, 0, 0.01, [at(0, 0.5)], p), undefined);
  // Humans (p128 = 1) are below p219 = 5: never picked; a priority-5 creature is.
  assert.equal(pickMeleeTarget(O, 0, 4, [at(0, 1, 1)], p), undefined);
  assert.equal(pickMeleeTarget(O, 0, 4, [at(0, 1, 5)], p)?.ref, '0/1');
  // Height counts in the angle (the 3D direction against the horizontal forward): 45 deg up.
  const narrow = { ...p, coneDeg: 30 };
  assert.equal(pickMeleeTarget(O, 0, 4, [{ x: 0, y: 1, z: -1, priority: 10, ref: 'up' }], narrow), undefined);
  assert.equal(pickMeleeTarget(O, 0, 4, [{ x: 0, y: 0.3, z: -1, priority: 10, ref: 'up' }], narrow)?.ref, 'up');
  // Line of sight.
  assert.equal(pickMeleeTarget(O, 0, 4, [at(0, 2)], p, () => true), undefined);
});

test('pick: the human weighs the angle, the creature the distance; higher priority wins', () => {
  const near = at(60, 1), centred = at(5, 3.5);
  // Human: 1 * angle / 90 + 0.1 * d / 4 -> the centred one (0.14) beats the near one (0.69).
  assert.equal(pickMeleeTarget(O, 0, 4, [near, centred], HUMAN_MELEE_FACE)?.ref, centred.ref);
  // Creature (2:240): 0.1 * angle / 105 + 1 * d / 6 -> the near one; 6 m (PWP 2:241 p10).
  assert.equal(pickMeleeTarget(O, 0, 6, [centred, near], CREATURE_MELEE_FACE)?.ref, near.ref);
  // A creature with p128 = 10 beats a better-placed priority 5, whatever the order.
  const low = at(0, 1, 5, 'low'), high = at(80, 3.9, 10, 'high');
  assert.equal(pickMeleeTarget(O, 0, 4, [low, high], HUMAN_MELEE_FACE)?.ref, 'high');
  assert.equal(pickMeleeTarget(O, 0, 4, [high, low], HUMAN_MELEE_FACE)?.ref, 'high');
});

test('turn: closes the angle at the rate without overshooting, the short way round', () => {
  assert.ok(Math.abs(faceStep(0, 90 * DEG, 350, 0.1) - 35 * DEG) < 1e-9);
  assert.ok(Math.abs(faceStep(0, -90 * DEG, 350, 0.1) + 35 * DEG) < 1e-9);
  assert.ok(Math.abs(faceStep(0, 10 * DEG, 350, 0.1) - 10 * DEG) < 1e-9);
  assert.ok(Math.abs(faceStep(170 * DEG, -170 * DEG, 350, 0.01) - 3.5 * DEG) < 1e-9);
  assert.equal(yawTo(O, { x: -1, y: 0, z: 0 }), Math.PI / 2);
});

const player = (yaw: number, bodyYaw: number, mode: 'fp' | 'tp' = 'tp'): FacePlayer & { root: { rotation: { y: number } } } => ({ yaw, bodyYaw, position: { x: 0, y: 0, z: 0 }, mode, root: { rotation: { y: bodyYaw } } });

test('swing start: a standing body takes the view, a moving one keeps at most the gait offset', () => {
  for (const off of [30, 90, 150]) {
    const pl = player(0.3, 0.3 + off * DEG);
    alignBodyForMelee(pl, false);
    assert.ok(Math.abs(pl.bodyYaw - 0.3) < 1e-9, `${off}`);
    assert.equal(pl.root.rotation.y, pl.bodyYaw);
  }
  const moving = player(0, 150 * DEG);
  alignBodyForMelee(moving, true);
  assert.ok(Math.abs(moving.bodyYaw - MAX_GAIT_OFFSET_DEG * DEG) < 1e-9);
  const diag = player(0, 40 * DEG);
  alignBodyForMelee(diag, true);
  assert.ok(Math.abs(diag.bodyYaw - 40 * DEG) < 1e-9);
  // First person: the body is the view already; nothing changes.
  const fp = player(0, 1, 'fp');
  alignBodyForMelee(fp, false);
  assert.equal(fp.bodyYaw, 1);
});

test('auto-face: the view and the body turn together to the target, only without turn input', () => {
  const p = HUMAN_MELEE_FACE;
  const target = [at(80, 2)];
  const pl = player(0, 90 * DEG);
  const f = new MeleeAutoFace();
  f.start(pl, false);
  assert.equal(pl.bodyYaw, 0);
  // 350 deg/s: 35 deg in 0.1 s toward the target at 80 deg right (yaw -80 deg).
  f.step(pl, 0.1, p, 4, target);
  assert.ok(Math.abs(pl.yaw + 35 * DEG) < 1e-9 && Math.abs(pl.bodyYaw + 35 * DEG) < 1e-9);
  // The player turns (mouse / stick): that frame nothing is auto-faced.
  pl.yaw += 5 * DEG;
  const y = pl.yaw, b = pl.bodyYaw;
  f.step(pl, 0.1, p, 4, target);
  assert.equal(pl.yaw, y);
  assert.equal(pl.bodyYaw, b);
  // Then it carries on until the target is faced, and stays.
  for (let i = 0; i < 10; i++) f.step(pl, 0.1, p, 4, target);
  assert.ok(Math.abs(pl.bodyYaw + 80 * DEG) < 1e-9);
  assert.ok(Math.abs(pl.yaw - pl.bodyYaw - 5 * DEG) < 1e-9);
  // No target (a prop, a human, out of range): no turn.
  const q = player(0.5, 0.5);
  f.start(q, false);
  f.step(q, 0.1, p, 4, [at(150, 2), at(0, 1, 1)]);
  assert.equal(q.yaw, 0.5);
  // First person turns at p167 = 220 deg/s.
  const r = player(0, 0, 'fp');
  f.start(r, false);
  f.step(r, 0.1, p, 4, target);
  assert.ok(Math.abs(r.yaw + 22 * DEG) < 1e-9);
  f.stop();
  assert.equal(f.active, false);
  assert.equal(f.step(r, 0.1, p, 4, target), undefined);
});

function systemPackages(): EntityPackageSet {
  const pkgs = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id !== 2 || pkgs.has(id)) continue;
    pkgs.set(2, { id: 2, name: 'System', odu: readSrsc(db.slice(0, -3) + '.odu') } as EntityPackage);
  }
  return pkgs;
}
const props = (pkgs: EntityPackageSet, r: ResRef) => {
  const t = readObjectTemplate(pkgs, r)!;
  return decodeTemplateProps(classByHash(t.classHash), t);
};

test('data: the Player templates, the swung PWPs and every Attack entering Aim', { skip }, () => {
  const pkgs = systemPackages();
  const r = (id: number): ResRef => ({ pkg: 2, id });
  const h = readMeleeFaceParams(props(pkgs, r(5)));
  for (const k of Object.keys(HUMAN_MELEE_FACE) as (keyof typeof h)[]) assert.ok(Math.abs(h[k] - HUMAN_MELEE_FACE[k]) < 1e-6, k);
  const c = readMeleeFaceParams(props(pkgs, r(240)), CREATURE_MELEE_FACE);
  assert.equal(c.coneDeg, 105);
  assert.ok(Math.abs(c.angleWeight - 0.1) < 1e-6 && c.distWeight === 1 && c.rateDeg === 350 && c.minPriority === 5);
  // p133: the body offset's return rate once the player stops.
  assert.equal(props(pkgs, r(5))[133], 170);
  // PWP p10: shiv 2:303 and axe 2:431 4 m, the empty hand 2:409 0.01, the creature 2:241 6.
  const p10 = (id: number) => props(pkgs, r(id))[10] as number;
  assert.equal(p10(303), 4);
  assert.equal(p10(431), 4);
  assert.ok(p10(409) < 0.02);
  assert.equal(p10(241), 6);
  // Every human strike (p86 / p91 of the shiv, axe and empty hand) has Attack p9 = 1 (Aim on).
  for (const id of [376, 377, 378, 393, 432, 653, 654, 433]) assert.equal(props(pkgs, r(id))[9], 1, `2:${id}`);
});
