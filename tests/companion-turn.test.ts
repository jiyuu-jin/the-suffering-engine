// Companions and their Action Dialog (docs/game-logic.md §15.10 "Scripted protection", §13.2):
// a player's hit no longer turns the NPC at once. The dialog counts the hits (0x1008e130), warns
// at each counted one below p18 (AttackedByPlayer 0x1008d4a0: face the player, the p17 clip, a
// p16 line) and at the p18th fires its p30 to the level logic (update 0x1008dda0), says a p20
// line and, with p23 = 1, destroys itself. Also the Ambient Creature's sound timer (0x100910f0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attackStartsFight, type Behavior } from '../src/game/actors/behaviors';
import { ambientBlow, ambientSoundDue } from '../src/game/actors/director';

test('attackStartsFight: an attached Action Dialog never makes its NPC fight back (follow, waypoint, idle)', () => {
  const o = { hostileKind: false, actionDialog: true, byPlayer: true };
  const follow = { kind: 'follow', fights: true } as unknown as Behavior;
  const walk = { kind: 'waypoint', fight: 2 } as unknown as Behavior;
  const idle = { kind: 'idle' } as unknown as Behavior;
  assert.equal(attackStartsFight(follow, o), false, '1c inmate / 2 Dallas / 6b Clem following the player');
  assert.equal(attackStartsFight(walk, o), false, 'a WaypointBehavior p3 = 2 walk');
  assert.equal(attackStartsFight(idle, o), false);
  assert.equal(attackStartsFight({ kind: 'waypoint', fight: 1 } as unknown as Behavior, o), true, 'p3 = 1 fights when attacked, dialog or not');
});

/** 2's dialog 1c77 on Dallas 868: p14 3, p16 [line], p17 clip, p18 3, p19 30, p20 [line], p22 -5, p23 1, p30 1. */
function dallas() {
  const values: unknown[] = new Array(31).fill(0);
  Object.assign(values, { 0: 1, 14: 3, 16: [{ pkg: 10, id: 94 }], 17: { pkg: 10, id: 1575 }, 18: 3, 19: 30, 20: [{ pkg: 10, id: 95 }], 21: 10, 22: -5, 23: 1, 24: 4, 25: 5, 26: 6, 27: 7, 28: 8, 30: 1 });
  return { uid: 0x1c77, className: 'Action Dialog', values, links: [0x868, 0x1c7f], position: [0, 0, 0] };
}

async function setup() {
  const { Director } = await import('../src/game/actors/director');
  const e = dallas();
  const gestures: number[] = [];
  const npc = {
    uid: 0x868,
    alive: true,
    template: false,
    position: { x: 0, y: 0, z: 0 },
    bottom: 0,
    height: 1.8,
    kind: {},
    ch: { root: { name: 'Dallas' } },
    attackedByPlayer: (clip: number) => (gestures.push(clip), 2.4),
  };
  const sent: [number, number][] = [];
  const said: string[] = [];
  const manager = { actors: [], env: {}, kinds: { clipIndex: (_k: unknown, r: { id: number }) => (r.id === 1575 ? 7 : -1) }, get: (u: number) => (u === 0x868 ? npc : undefined) };
  const hooks = { send: (u: number, m: number) => sent.push([u, m]), speak: (k: string[]) => (said.push(k[0]), 1.5), log: () => {}, player: () => ({ x: 0, y: 0, z: 0 }) };
  const d = new Director([e] as never, new Map([[e.uid, e]]) as never, new Map() as never, manager as never, hooks as never, {} as never);
  const at = (t: number) => d.update(t - d.time, {} as never);
  return { d, npc, gestures, sent, said, at };
}

test('Action Dialog: a counted hit below p18 warns (p16 line + the p17 clip); hits during the warning do not count', async () => {
  const { d, npc, gestures, sent, said, at } = await setup();
  at(10);
  assert.equal(d.playerHit(npc as never), 0);
  assert.deepEqual(gestures, [7], 'AttackedByPlayer plays p17 (10:1575)');
  assert.deepEqual(said, ['10:94'], 'with a p16 line');
  assert.deepEqual(sent, [], 'no turn yet');
  at(11);
  d.playerHit(npc as never);
  assert.equal(gestures.length, 1, 'during the warning (2.4 s): not counted, no second warning');
  at(13.5);
  d.playerHit(npc as never);
  assert.equal(gestures.length, 2, 'second counted hit, second warning');
});

test('Action Dialog: the p18th counted hit turns the NPC through the level logic (p30 to the links), p20 line, p23 destroys it', async () => {
  const { d, npc, sent, said, at } = await setup();
  at(10);
  d.playerHit(npc as never);
  at(14);
  d.playerHit(npc as never);
  at(18);
  assert.equal(d.playerHit(npc as never), -5, 'p22 on the third counted hit');
  assert.deepEqual(sent, [[0x1c7f, 1]], 'On to Relay 1c7f (-> Behavior Changer 1c7b -> FleeBehavior 1c7c), not to the NPC');
  assert.equal(said.at(-1), '10:95', 'the p20 line');
  at(22);
  assert.equal(d.playerHit(npc as never), 0, 'p23 = 1: the dialog is gone');
  assert.equal(sent.length, 1);
  assert.equal(d.playerKill(npc as never), 0, 'no dialog share with the kill any more');
  assert.ok((d.snapshot().dialogsGone ?? []).includes(0x1c77), 'saved as removed');
});

test('Action Dialog: a gap over p19 starts the count again (no turn after 3 spaced-out hits)', async () => {
  const { d, npc, sent, at } = await setup();
  at(10);
  d.playerHit(npc as never);
  at(14);
  d.playerHit(npc as never);
  at(50);
  d.playerHit(npc as never);
  assert.deepEqual(sent, [], '36 s gap: the third hit is the first again');
});

test('Ambient Creature sound timer (0x100910f0): every p29..p30 s one p28 sound, at most p31 playing', () => {
  const v: unknown[] = new Array(34).fill(0);
  Object.assign(v, { 28: [{ pkg: 10, id: 532 }], 29: 3, 30: 7, 31: 2 });
  const am = { sound: 0.5 };
  assert.equal(ambientSoundDue(am, v as never, 0.2, 0, () => 0.5), false);
  assert.equal(ambientSoundDue(am, v as never, 0.4, 0, () => 0.5), true, 'due: plays');
  assert.equal(am.sound, 5, 'next in p29 + 0.5 x (p30 - p29)');
  am.sound = 0;
  assert.equal(ambientSoundDue(am, v as never, 0.1, 2, () => 0), false, 'two ambient sounds play already (p31 2): skipped');
  assert.equal(am.sound, 3, 'the timer restarts all the same');
  const mute = Object.assign([...v], { 28: [] });
  assert.equal(ambientSoundDue({ sound: 0 }, mute as never, 0.1, 0), false, 'no sounds listed');
});

test('Ambient Creature blow (0x1009b490): 1 health, any blow kills; invulnerable or hidden: nothing', () => {
  const rat = { health: 1, invulnerable: false, shown: true };
  assert.equal(ambientBlow(rat, 0.5), 'hurt', 'p15 fires');
  assert.equal(ambientBlow(rat, 6), 'killed', 'then p26 (killReputation), the p18 break, p21, destroyed');
  assert.equal(ambientBlow(rat, 6), 'none', 'already dead');
  assert.equal(ambientBlow({ health: 1, invulnerable: true, shown: true }, 50), 'none', "8b's rats (p3 1)");
  assert.equal(ambientBlow({ health: 1, invulnerable: false, shown: false }, 50), 'none', 'not shown');
  assert.equal(ambientBlow({ health: 1, invulnerable: false, shown: true }, 0), 'none');
});
