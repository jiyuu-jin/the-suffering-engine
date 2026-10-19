// Actor AI rules (src/game/actors; docs/game-logic.md §15.2, §15.8 - §15.10): DormantBehavior
// waking, AI noises and InvestigateBehavior hearing, FollowBehavior, companions carried through
// level transitions, and the 1a first-room creature (the intro's CartWheeler stand-in) as the data defines it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { indexEntities, inboundLinks, parseEntities, type Entity, type EntityPackage } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { BehaviorLibrary, CHAR, noiseHeard, templateProp } from '../src/game/actors/behaviors';
import { applyCarry, clearCarry, pendingCarry, recordCarry } from '../src/game/actors/companions';
import { parseStompSequence, TRACK_REMOVE_AT_END } from '../src/game/world/stomp';
import { classByHash } from '../src/formats/entities';
import { toOutputSpace } from '../src/formats/level';

// --- pure rules ------------------------------------------------------------------

test('hearing: level at least p4, distance within radius + p2, louder noises win', () => {
  const guard = { extra: 1, minLevel: 1, linger: 10 };
  const shot = { radius: 27, level: 2 }; // Missile p16 of the guards' and the player's bullets
  const footstep = { radius: 12.5, level: 0 }; // Player Material Effects p7
  assert.ok(noiseHeard(guard, shot, 27.9));
  assert.ok(!noiseHeard(guard, shot, 28.1));
  assert.ok(!noiseHeard(guard, footstep, 2), 'footsteps (level 0) are below every retail p4');
  assert.ok(noiseHeard({ ...guard, minLevel: 0 }, footstep, 13));
  // While following up a level-2 noise, a level-1 impact does not distract.
  assert.ok(!noiseHeard(guard, { radius: 20, level: 1 }, 5, 2));
});

// --- data ------------------------------------------------------------------------

let cache: { packages: Map<number, EntityPackage>; levels: Map<string, Entity[]> } | undefined;
function load() {
  if (cache) return cache;
  const packages = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || packages.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    packages.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`) } as EntityPackage);
  }
  const levels = new Map<string, Entity[]>();
  levels.set('1a', parseEntities(readSrsc('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'), packages));
  levels.set('2', parseEntities(readSrsc('LEVELS/2 Cellblocks/2 Cellblocks.lvl'), packages));
  return (cache = { packages, levels });
}
const types = (e: Entity) => classByHash(e.classHash)?.types ?? [];

test('1a first-room creature: the intro CartWheeler stand-in, removed when "Goose" ends', { skip }, () => {
  const { packages, levels } = load();
  const ents = levels.get('1a')!;
  const by = indexEntities(ents);
  const cw = by.get(0x8916)!;
  assert.equal(cw.className, 'CartWheeler');
  // Nothing in the level logic reaches it (no Behavior Changer, Detector, Relay or cloner).
  assert.equal(inboundLinks(ents).get(0x8916)?.length ?? 0, 0);
  assert.equal(cw.links.length, 0);
  // Its initial behaviour: shown dormant, woken only by On (p12) or an attack (p6).
  const B = new BehaviorLibrary(packages, by);
  const d = B.fromTemplate(templateProp(cw.values, types(cw), CHAR.initial));
  assert.equal(d?.kind, 'dormant');
  if (d?.kind === 'dormant') {
    assert.equal(d.mode, 1);
    assert.equal(d.wakeMessage, 1);
    assert.ok(d.wakeOnAttack);
  }
  // Driven by the intro "Goose" (STOMP Player 7509): transform / clip keys only - no control,
  // no message (no On) - and the track is flagged to remove the object at the end.
  const player = by.get(0x7509)!;
  const seqRef = player.values[0] as { pkg: number; id: number };
  const seq = parseStompSequence(packages.get(seqRef.pkg)!.qdu!, seqRef.id)!;
  const track = seq.tracks.find((t) => t.uid === 0x8916)!;
  assert.ok(track, 'Goose has a track for the CartWheeler');
  assert.ok(track.flags & TRACK_REMOVE_AT_END);
  assert.equal(track.messages.length, 0);
  assert.equal(track.controls.length, 0);
  // It lands in Floyd's cell (the crucified inmate 0x7b38 is shown on its back wall).
  const last = track.transforms[track.transforms.length - 1];
  const [x, , z] = last.position.map((v) => v / 2048);
  const [fx, , fz] = toOutputSpace(by.get(0x7b38)!.position);
  assert.ok(Math.hypot(x - fx, z - fz) < 3, `lands ${Math.hypot(x - fx, z - fz).toFixed(1)} m from the crucified inmate`);
});

test('1a: the first Slayer met in play (6207) is woken by its sequence and unlocks the archive', { skip }, () => {
  const { packages, levels } = load();
  const ents = levels.get('1a')!;
  const by = indexEntities(ents);
  const seqRef = by.get(0x5dac)!.values[0] as { pkg: number; id: number };
  const seq = parseStompSequence(packages.get(seqRef.pkg)!.qdu!, seqRef.id)!;
  const track = seq.tracks.find((t) => t.uid === 0x6207)!;
  assert.ok(track.controls.some((c) => c.release), 'control is handed back');
  assert.ok(track.messages.some((m) => m.message === 1), 'On wakes it at the end');
  assert.ok(by.get(0x6207)!.links.some((u) => by.get(u)?.className === 'Archives Trigger'));
});

test('DormantBehavior p6: Slayers wake when attacked, Horace and Noosemen do not', { skip }, () => {
  const { packages, levels } = load();
  const ents = levels.get('1a')!;
  const B = new BehaviorLibrary(packages, indexEntities(ents));
  const dormant = (cls: string) =>
    ents
      .filter((e) => e.className === cls)
      .map((e) => B.fromTemplate(templateProp(e.values, types(e), CHAR.initial)))
      .filter((b) => b?.kind === 'dormant');
  const horace = dormant('Horace');
  assert.ok(horace.length > 0 && horace.every((b) => b?.kind === 'dormant' && !b.wakeOnAttack));
  const noose = dormant('Nooseman');
  assert.ok(noose.length > 0 && noose.every((b) => b?.kind === 'dormant' && !b.wakeOnAttack));
  const slayers = dormant('CartWheeler');
  assert.ok(slayers.length > 5 && slayers.every((b) => b?.kind === 'dormant' && b.wakeOnAttack && b.wakeMessage === 1));
});

test('InvestigateBehavior on the 1a guards, InvestigateSound of their bullets', { skip }, () => {
  const { packages, levels } = load();
  const ents = levels.get('1a')!;
  const B = new BehaviorLibrary(packages, indexEntities(ents));
  const guard = ents.find((e) => e.uid === 0x609e)!;
  const inv = B.investigate(templateProp(guard.values, types(guard), CHAR.investigate));
  const { chance, ...rest } = inv!;
  assert.deepEqual(rest, { extra: 1, minLevel: 1, linger: 10 });
  // p3: percent chance a noise is noticed (docs/re/audio.md §8).
  assert.ok(chance >= 0 && chance <= 100, `chance ${chance}`);
  // Missile 10:1741 (a guard bullet): p16 shot 27 m / level 2, p14 impact 20 m / level 1.
  assert.deepEqual(B.noise({ pkg: 2, id: 441 }), { radius: 27, level: 2 });
  assert.deepEqual(B.noise({ pkg: 2, id: 442 }), { radius: 20, level: 1 });
  // CartWheelers have no InvestigateBehavior (template p97 empty): noises don't draw them.
  const cw = ents.find((e) => e.uid === 0x6207)!;
  assert.equal(B.investigate(templateProp(cw.values, types(cw), CHAR.investigate)), undefined);
});

test('level 2: FollowBehavior decodes and the 1c companion arrives at the Companion Spawn Point', { skip }, () => {
  const { packages, levels } = load();
  const ents = levels.get('2')!;
  const by = indexEntities(ents);
  const B = new BehaviorLibrary(packages, by);
  const follows = ents.filter((e) => e.className === 'FollowBehavior').map((e) => B.fromPlaced(e.uid));
  assert.ok(follows.length >= 7);
  for (const f of follows) {
    assert.equal(f?.kind, 'follow');
    if (f?.kind === 'follow') {
      assert.equal(f.target, 1);
      assert.equal(f.near, 2);
      assert.ok(f.far >= 6 && f.combatFar >= f.far && f.giveUp < 0);
      assert.ok(f.stop > 0 && f.stop < f.far, 'the run stops (p4) short of the length it waits on (p5)');
    }
  }
  // Dallas's first FollowBehavior 902 (template 10:288): waits fighting (p3 = 1), runs once the
  // way to the player is longer than 10 m (20 m while he has a target), stops 7 m short.
  const f902 = B.fromPlaced(0x902);
  assert.ok(f902?.kind === 'follow');
  if (f902?.kind === 'follow') assert.deepEqual([f902.fights, f902.stop, f902.far, f902.combatFar, f902.giveUp], [true, 7, 10, 20, -1]);
  // A minimal stand-in for the manager: the placed copy 0x868 of the companion.
  const copy = by.get(0x868)!;
  const moved: number[][] = [];
  const actor = {
    entity: copy,
    alive: true,
    health: 100,
    maxHealth: 100,
    yaw: 0,
    needsPlacement: false,
    ch: { root: { name: 'companion' } },
    motor: { teleport: (x: number, y: number, z: number) => moved.push([x, y, z]) },
    sync() {},
  };
  const manager = { get: (uid: number) => (uid === 0x868 || uid === 0x7569 ? actor : undefined), remove() {} } as never;
  // 1c's transition to 2 carries its companion (0x7569, same template as 0x868), hurt.
  actor.health = 40;
  const transition = { values: Object.assign([], { 7: [0x7569] }) } as unknown as Entity;
  recordCarry('LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl', transition, manager);
  assert.equal(pendingCarry()?.objects.length, 1);
  actor.health = 100;
  const arrived = applyCarry('East Spawn', ents, manager);
  assert.equal(arrived.length, 1);
  const [cx, cy, cz] = toOutputSpace(by.get(0x1bf0)!.position);
  assert.deepEqual(moved[0].map((v) => +v.toFixed(2)), [cx, cy, cz].map((v) => +v.toFixed(2)));
  assert.equal(actor.health, 40, 'the carried health comes along');
  assert.equal(pendingCarry(), null, 'used up');
  // Without a carry (a save, the developer viewer) nothing moves.
  assert.equal(applyCarry('East Spawn', ents, manager).length, 0);
  clearCarry();
});
