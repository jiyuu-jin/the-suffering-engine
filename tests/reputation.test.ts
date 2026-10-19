// Reputation rules (src/game/insanity/reputation.ts, docs/game-logic.md §13.2 "Reputation
// sources") and the census of the game's reputation objects (tools/reputation-census.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  dialogHit,
  dialogKillPoints,
  dialogRepRules,
  killReputation,
  KILLED_BY_PLAYER_OUTPUT,
  newDialogRepState,
  partCapReputation,
  senderApplications,
} from '../src/game/insanity/reputation';
import { DATA_ROOT, skip } from './helpers';

test('Reputation Points Sender: p0 is the target mode, p3 is added once per target (0x1008e510)', () => {
  assert.equal(senderApplications(1, 0), 1, 'p0 1: the player, once (every placed sender)');
  assert.equal(senderApplications(1, 3), 1, 'links do not matter for the player');
  assert.equal(senderApplications(1, 0, false), 0, 'no player: nothing');
  assert.equal(senderApplications(0, 0), 1, 'p0 0: the message sender, once (not "disabled")');
  assert.equal(senderApplications(2, 3), 3, 'p0 2: once per link');
  assert.equal(senderApplications(2, 0), 0);
  assert.equal(senderApplications(7, 2), 0, 'other modes: no target');
});

test('kill reputation: Characters p166, Ambient Creatures p26 (0x100e7519, 0x100916f0)', () => {
  const v = (n: number, at: number, x: number) => Object.assign(new Array(n).fill(0), { [at]: x });
  assert.equal(killReputation('Unspeakable NPC', v(196, 166, -10)), -10, '1a guard 609e / 1c inmate 7569');
  assert.equal(killReputation('CartWheeler', v(196, 166, 0)), 0);
  assert.equal(killReputation('Ambient Creature', v(34, 26, -2)), -2, 'rats and crows');
  assert.equal(killReputation('Player', v(300, 166, 3000)), 0, 'the Player template p166 is no kill reputation');
  assert.equal(killReputation('Breakable', v(40, 26, 5)), 0);
  assert.equal(KILLED_BY_PLAYER_OUTPUT, 169);
});

test('Action Dialog count: p22 once at the p18th counted hit, p14 apart, reset after p19 (0x1008e130)', () => {
  const r = dialogRepRules(Object.assign(new Array(30).fill(0), { 14: 3, 18: 3, 19: 30, 22: -5 }));
  assert.deepEqual(r, { minGap: 3, resetAfter: 30, hits: 3, points: -5 });
  const s = newDialogRepState();
  assert.equal(dialogHit(s, r, 10), 0);
  assert.equal(dialogHit(s, r, 11), 0, 'within p14 of the last counted hit: not counted');
  assert.equal(s.count, 1);
  assert.equal(dialogHit(s, r, 13), 0, 'exactly p14 later counts');
  assert.equal(s.count, 2);
  assert.equal(dialogHit(s, r, 16), -5, 'third counted hit pays p22');
  assert.equal(s.paid, true);
  assert.equal(dialogHit(s, r, 20), 0, 'paid once');
  assert.equal(dialogKillPoints(s, r), 0, 'the kill pays nothing more');

  const t = newDialogRepState();
  dialogHit(t, r, 0);
  dialogHit(t, r, 5);
  assert.equal(dialogHit(t, r, 40), 0, 'a gap over p19 starts the count again');
  assert.equal(t.count, 1);
  assert.equal(dialogKillPoints(t, r), -5, 'killed before the count: the kill pays p22');
  assert.equal(dialogKillPoints(t, r), 0);

  // 9's guard bc9 (dialog e6e, p18 1): the first hit pays.
  const one = dialogRepRules(Object.assign(new Array(30).fill(0), { 14: 3, 18: 1, 19: 30, 22: -5 }));
  assert.equal(dialogHit(newDialogRepState(), one, 0), -5);
});

test('Part Cap: a part cut from a body dead more than p4 s pays p5 (0x1011961f)', () => {
  const v = Object.assign(new Array(20).fill(0), { 4: 5, 5: -2 });
  assert.equal(partCapReputation(v, 4.9), 0);
  assert.equal(partCapReputation(v, 5), 0);
  assert.equal(partCapReputation(v, 6), -2);
});

test('census: every reputation object of the game, with its amount', { skip }, () => {
  const out = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'tools/reputation-census.ts', DATA_ROOT, '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 })) as {
    rows: { level: string; kind: string; uid: number; amount: number; text: string }[];
    templates: string[];
  };
  const row = (level: string, kind: string, uid: number) => out.rows.find((r) => r.level === level && r.kind === kind && r.uid === uid);
  const senders = out.rows.filter((r) => r.kind === 'sender');
  // Every placed sender targets the player (p0 1) and has no links: each applies once.
  assert.equal(senders.length, 46);
  assert.ok(senders.every((r) => !/ x\d/.test(r.text)));
  // The 10 Docks escort: his farewell +20 (Timer 10dd), his death by the player -10 (Timer 10d8).
  assert.equal(row('10', 'sender', 0x119d)?.amount, 20);
  assert.match(row('10', 'sender', 0x119d)!.text, /Timer #10dd p11/);
  assert.equal(row('10', 'sender', 0x119c)?.amount, -10);
  assert.match(row('10', 'kill', 0x7b8)!.text, /p169 \(killed by the player\) sends 350 to Timer #10d8/);
  // 1b: the two CartWheelers' p169 feed Sender 8b63 (-5 each).
  assert.match(row('1b', 'sender', 0x8b63)!.text, /CartWheeler #8b46 p169 \(killed by the player\), CartWheeler #8b47 p169/);
  // Only 1a's guard and 1c's inmate carry a kill reputation of their own.
  const own = out.rows.filter((r) => r.kind === 'kill' && r.amount && !/Ambient Creature/.test(r.text));
  assert.deepEqual(own.map((r) => [r.level, r.uid, r.amount]), [['1a', 0x609e, -10], ['1c', 0x7569, -10]]);
  // Ambient Creatures: -2 each, 74 placed.
  const amb = out.rows.filter((r) => r.kind === 'kill' && /Ambient Creature/.test(r.text));
  assert.equal(amb.length, 74);
  assert.ok(amb.every((r) => r.amount === -2));
  // Action Dialogs with a reputation: -5 each.
  const dialogs = out.rows.filter((r) => r.kind === 'dialog');
  assert.equal(dialogs.length, 11);
  assert.ok(dialogs.every((r) => r.amount === -5));
  // The endings' filters (10 Docks a86 / a88 / a89).
  assert.match(row('10', 'filter', 0xa86)!.text, /70 < rep <= 999/);
  assert.match(row('10', 'filter', 0xa89)!.text, /-999 < rep <= -90/);
  // No spawned character template carries a kill reputation.
  assert.ok(out.templates.every((t) => !/kill/.test(t) || /Ambient Creature/.test(t)));
});

test('Director: the attached Action Dialog counts the player\'s hits and pays p22 once; saved', async () => {
  const { Director } = await import('../src/game/actors/director');
  // 1c's dialog 7edc on the inmate 7569: p0 1 (attached at start), p14 3, p18 3, p19 30, p22 -5,
  // p24 / p25 attach / detach messages.
  const values: unknown[] = new Array(30).fill(0);
  Object.assign(values, { 0: 1, 14: 3, 18: 3, 19: 30, 22: -5, 24: 4, 25: 5, 26: 6, 27: 7, 28: 8 });
  const e = { uid: 0x7edc, className: 'Action Dialog', values, links: [0x7569], position: [0, 0, 0] };
  const npc = { uid: 0x7569, alive: true, template: false, position: { x: 0, y: 0, z: 0 } };
  const other = { uid: 0x1234, alive: true };
  const manager = { actors: [], get: (u: number) => (u === 0x7569 ? npc : undefined) };
  const hooks = { send: () => {}, speak: () => 0, log: () => {}, player: () => ({ x: 0, y: 0, z: 0 }) };
  const make = () => new Director([e] as never, new Map([[e.uid, e]]) as never, new Map() as never, manager as never, hooks as never, {} as never);
  const d = make();
  const env = {} as never;
  const at = (t: number) => d.update(t - d.time, env);
  assert.equal(d.playerHit(other as never), 0, 'no dialog on that NPC');
  at(10);
  assert.equal(d.playerHit(npc as never), 0);
  at(11);
  assert.equal(d.playerHit(npc as never), 0, 'too soon: not counted');
  at(13.5);
  assert.equal(d.playerHit(npc as never), 0);
  const saved = JSON.parse(JSON.stringify(d.snapshot()));
  at(17);
  assert.equal(d.playerHit(npc as never), -5, 'third counted hit');
  assert.equal(d.playerKill(npc as never), 0, 'paid: the kill adds nothing');

  // The save holds the count: restored, the third hit pays.
  const r = make();
  r.update(13.5, env);
  r.restore(saved);
  r.update(3.5, env);
  assert.equal(r.playerHit(npc as never), -5, 'the count survived the save');

  // Detached (p25): no count, no kill share.
  const x = make();
  x.message(5, 0, 0x7edc, env);
  assert.equal(x.playerKill(npc as never), 0, 'detached: nothing');
  const k = make();
  assert.equal(k.playerKill(npc as never), -5, 'killed before the count: p22 with the kill');
});
