// Checkpoint restore (docs/re/saves.md §4.1): the original reverts by rebuilding every object of
// the level from the checkpoint stream, so what the port's systems hand out while they run must
// not survive a restore, and what an object's own save keeps (a behaviour's progress, a special
// move's surface) must come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releasePlayerControl, type ControllerLike } from '../src/game/save/providers';
import { behaviorProgress, resumeProgress } from '../src/game/actors/actor';
import { CartWheeler } from '../src/game/actors/specials/cartwheeler';

test('restore: nothing the old systems handed the player controller survives a level start', () => {
  let virtual: unknown = { forward: 1, strafe: 0 };
  const eye = { x: 0.1, y: -0.2, z: 0.3, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }); return this; } };
  const p: ControllerLike & { attackOverride: unknown } = {
    // A held body clip's lock of the disposed player body (the frozen-player case).
    motionOverride: () => true,
    bodyYawLock: 1.2,
    enabled: false,
    attackOverride: () => true,
    setVirtualInput: (v) => (virtual = v),
    eyeOffset: eye,
  };
  releasePlayerControl(p, true);
  assert.equal(p.motionOverride, null);
  assert.equal(p.bodyYawLock, null);
  assert.equal(p.attackOverride, null);
  assert.equal(virtual, null);
  assert.deepEqual([eye.x, eye.y, eye.z], [0, 0, 0]);
  assert.equal(p.enabled, true);
  // Fly mode (no walking player): stays disabled.
  releasePlayerControl(p, false);
  assert.equal(p.enabled, false);
});

test('restore: a behaviour goes on from its saved progress, timers relative to the clock', () => {
  // A WaypointBehavior on its third waypoint, waiting for the escorted player (phase 1).
  const saved = behaviorProgress('waypoint', { phase: 1, i: 0, wp: 0x7581, until: 0 }, 120);
  assert.deepEqual(saved, { k: 'waypoint', ph: 1, i: 0, wp: 0x7581 });
  const b = { phase: 0, i: 0, wp: 0, until: 0 };
  assert.equal(resumeProgress('waypoint', b, saved, 3), true);
  assert.deepEqual(b, { phase: 1, i: 0, wp: 0x7581, until: 0 });

  // A conversation two lines in, 1.5 s left of the gap: the clock restarts at 0 with the level.
  const talk = behaviorProgress('talk', { phase: 1, i: 2, wp: 0, until: 101.5 }, 100);
  assert.deepEqual(talk, { k: 'talk', ph: 1, i: 2, wp: 0, t: 1.5 });
  const t = { phase: 0, i: 0, wp: 0, until: 0 };
  resumeProgress('talk', t, talk, 0.25);
  assert.deepEqual(t, { phase: 1, i: 2, wp: 0, until: 1.75 });

  // Nothing to keep: a behaviour not started yet, or one whose set-up is its state.
  assert.equal(behaviorProgress('waypoint', { phase: 0, i: 0, wp: 0, until: 0 }, 5), undefined);
  assert.equal(behaviorProgress('jump', { phase: 2, i: 0, wp: 0, until: 9 }, 5), undefined);
  assert.equal(behaviorProgress(undefined, { phase: 1, i: 1, wp: 0, until: 0 }, 5), undefined);
  // Another behaviour runs by the time it resumes: the progress is not forced onto it.
  const other = { phase: 0, i: 0, wp: 0, until: 0 };
  assert.equal(resumeProgress('idle', other, talk, 0), false);
  assert.deepEqual(other, { phase: 0, i: 0, wp: 0, until: 0 });
});

test('restore: a CartWheeler that came down from its start ceiling stays on the floor', () => {
  const actor = { crawler: true, ceiling: false };
  const cw = Object.create(CartWheeler.prototype) as CartWheeler;
  Object.assign(cw, { a: actor, rt: { log() {} }, surface: 'ceiling', mode: 'ceiling', phase: '', t: 0 });
  // Saved mid let-go (a transition counts as done): the floor.
  Object.assign(cw, { mode: 'down' });
  assert.deepEqual(cw.save(), { s: 'floor' });
  Object.assign(cw, { mode: 'up', surface: 'floor' });
  assert.deepEqual(cw.save(), { s: 'ceiling' });
  // The restored copy starts on the ceiling again (template p180): the save puts it down.
  Object.assign(cw, { mode: 'ceiling', surface: 'ceiling' });
  cw.load({ s: 'floor' });
  assert.equal(cw.surface, 'floor');
  assert.equal(cw.mode, null);
  assert.equal(actor.crawler, false);
  assert.equal(actor.ceiling, false);
});

test('restore: a dead Object Cloner copy comes back as a body (its cloner still counts it)', async () => {
  const { actorsSaveProvider } = await import('../src/game/save/providers');
  type Fake = { uid: number; spawned: boolean; alive: boolean; entity?: { uid: number }; kind: { decor: boolean; template?: unknown }; template?: unknown; state?: unknown; getState(): Record<string, unknown>; setState(r: Record<string, unknown>): void };
  const mk = (uid: number, alive: boolean, entity?: { uid: number }): Fake => ({
    uid,
    spawned: true,
    alive,
    entity,
    kind: { decor: false, template: entity ? undefined : { pkg: 10, id: 1 } },
    getState() {
      return { u: uid, clone: entity?.uid, t: entity ? undefined : { pkg: 10, id: 1 }, alive, h: alive ? 30 : 0, p: [0, 0, 0], yaw: 0 };
    },
    setState(r) {
      this.state = r;
    },
  });
  const deadCopy = mk(0x7f000000, false, { uid: 0x671a });
  const deadSpawn = mk(0x7f000001, false);
  const manager = {
    actors: [deadCopy, deadSpawn] as Fake[],
    removedPlaced: new Set<number>(),
    cloned: [] as [number, number][],
    get: (u: number) => manager.actors.find((a) => a.uid === u),
    remove: (a: Fake) => (manager.actors = manager.actors.filter((x) => x !== a)),
    clone(t: number, u: number) {
      manager.cloned.push([t, u]);
      const a = mk(u, true, { uid: t });
      manager.actors.push(a);
      return a;
    },
    spawn: () => undefined,
  };
  const prov = actorsSaveProvider(manager as never, () => null);
  const saved = prov.save();
  assert.deepEqual(saved.actors.map((r) => r.u), [0x7f000000]);
  prov.load(saved, { reason: 'load', levelPath: 'x', version: 1 });
  assert.deepEqual(manager.cloned, [[0x671a, 0x7f000000]]);
  assert.equal((manager.get(0x7f000000)?.state as { alive: boolean }).alive, false);
});
