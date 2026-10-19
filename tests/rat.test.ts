// Rat attack (src/game/actors/specials/rat.ts), decoded from Suffering.rfl: RatKillObjectBehavior
// (update 0x10086000) leaps within p2 m and p3 degrees; RatJumpAttackBehavior (update 0x100869b0)
// bites p4 once when the leap touches the player's hit spheres, then the rat dies after its chew
// clip; a leap touching any other live character just ends (no bite).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratContact, ratLeaps, ratParams, ratTouch, ratTouchResult, rootAt } from '../src/game/actors/specials/rat';
import { fightTarget } from '../src/game/actors/specials/params';

// Retail templates: RatKillObjectBehavior 10:518 (p2 4, p3 20), RatJumpAttackBehavior 10:519
// (p2 10:420 leap, p3 10:422 chew, p4 10, p5 10:520 Follower Object).
const kill: unknown[] = [[], [], 4, 20];
const jump: unknown[] = [[], [], { pkg: 10, id: 420 }, { pkg: 10, id: 422 }, 10, { pkg: 10, id: 520 }];

test('rat params: leap range p2 (m), cone p3 (deg); leap / chew clips, one bite of p4', () => {
  const p = ratParams(kill as never, jump as never);
  assert.equal(p.range, 4);
  assert.equal(p.cone, 20);
  assert.deepEqual(p.leap, { pkg: 10, id: 420 });
  assert.deepEqual(p.chew, { pkg: 10, id: 422 });
  assert.equal(p.bite, 10, 'p4 is the bite (p2 = 4 of the kill object is a range, not damage)');
});

test('the leap starts within p2 m (3D) and p3 degrees of the facing only', () => {
  const p = ratParams(kill as never, jump as never);
  const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);
  assert.equal(ratLeaps(p, 3.9, cos(0)), true);
  assert.equal(ratLeaps(p, 4.1, cos(0)), false, 'beyond p2: the MoveTo goes on');
  assert.equal(ratLeaps(p, 2, cos(19)), true);
  assert.equal(ratLeaps(p, 2, cos(25)), false, 'outside the cone: it turns first');
});

test('the bite needs a touch: the body sphere against a hit sphere', () => {
  const spheres = [
    { c: [0, 1.5, 0], r: 0.2 },
    { c: [0, 0.9, 0], r: 0.3 },
  ];
  assert.equal(ratTouch([0.4, 0.9, 0], 0.15, spheres), 1);
  assert.equal(ratTouch([0.5, 0.9, 0], 0.15, spheres), -1);
  assert.equal(ratTouch([0, 1.8, 0], 0.15, spheres), 0);
});

test('the leap follows the clip root: interpolated, relative to the first key', () => {
  // 10:420's root: 7.3 m forward (-Z) over 0.83 s, up to 1.56 m.
  const times = [0, 0.4, 0.83];
  const tr = [0, 0, 0, 0, 1.56, -3.3, 0, 0, -7.3];
  const o: [number, number, number] = [0, 0, 0];
  assert.deepEqual(rootAt(times, tr, 0, o), [0, 0, 0]);
  rootAt(times, tr, 0.2, o);
  assert.ok(Math.abs(o[1] - 0.78) < 1e-6 && Math.abs(o[2] + 1.65) < 1e-6);
  rootAt(times, tr, 2, o);
  assert.deepEqual(o, [0, 0, -7.3]);
});

test('only the player is bitten: a leap touching another character ends with no damage', () => {
  // RatJumpAttack update 0x100869b0: a live Character or the Player sets the touched flag; only
  // the Player goes on to the hit spheres, the latch and p4. The flag alone ends the leap.
  assert.deepEqual(ratTouchResult('player'), { bite: true, end: false });
  assert.deepEqual(ratTouchResult('character'), { bite: false, end: true });
});

test('the leap meets a character body moving toward it, within the radii and its height', () => {
  const clem = { x: 0, z: 0, bottom: 0, height: 1.8, radius: 0.4 };
  // Rat 0.5 m off on +x, its step pointing at him (-x).
  assert.equal(ratContact(0.5, 0.3, 0, 0.15, 0.3, -0.1, 0, [clem]), 0);
  // Moving away from him: no contact (bodies only push softly apart in the port).
  assert.equal(ratContact(0.5, 0.3, 0, 0.15, 0.3, 0.1, 0, [clem]), -1);
  // Too far for the two radii.
  assert.equal(ratContact(0.6, 0.3, 0, 0.15, 0.3, -0.1, 0, [clem]), -1);
  // Over his head on the arc.
  assert.equal(ratContact(0.5, 1.9, 0, 0.15, 0.3, -0.1, 0, [clem]), -1);
});

test('the kill objects work on the KillEnemies target: the player or a live, shown character', () => {
  const env = { playerAlive: true, player: { position: { x: 1, y: 2, z: 3 } } };
  const npc = { alive: true, hidden: false, position: { x: 4, y: 5, z: 6 } } as never;
  const base = { alive: true, inCombat: true };
  assert.deepEqual(fightTarget({ ...base, currentTarget: { player: true } }, env), { player: true, pos: env.player.position });
  assert.equal(fightTarget({ ...base, currentTarget: { player: true } }, { ...env, playerAlive: false }), undefined);
  const t = fightTarget({ ...base, currentTarget: { actor: npc } }, env);
  assert.equal(t?.player, false);
  assert.deepEqual(t?.pos, { x: 4, y: 5, z: 6 });
  assert.equal(fightTarget({ ...base, currentTarget: { actor: { ...(npc as object), alive: false } as never } }, env), undefined);
  assert.equal(fightTarget({ ...base, currentTarget: { prop: 0x1432 } }, env), undefined, 'object targets stay with the generic AI');
  assert.equal(fightTarget({ ...base, inCombat: false, currentTarget: { player: true } }, env), undefined);
});
