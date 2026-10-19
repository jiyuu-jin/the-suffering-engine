// Hermes' gaseous body: body-part sets of Characters (p54 / p55: SpawnAttachments 154, clip
// events SpawnItem 151 / DestroyItem 152), the Character fader (206..209) and the attached gas
// fountains that follow their bone (docs/game-logic.md §15.7.12; fx/body-parts.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { nodeFS, readSrsc, skip } from './helpers';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import type { PackageSet, ResRef } from '../src/formats/model';
import { readSkinnedModel } from '../src/formats/skeleton';
import { Emitter, readTemplate, type Generator } from '../src/game/world/fx';
import { parseStompSequence } from '../src/game/world/stomp';
import { Attachments, bodyPartAt } from '../src/game/fx/attachments';
import {
  BodyParts,
  CharacterFader,
  DESTROY_ITEM,
  SPAWN_ATTACHMENTS,
  SPAWN_ITEM,
  START_FADE_IN,
  START_FADE_OUT,
  STOP_FADE_IN,
  STOP_FADE_OUT,
  crossedEvents,
  fadeDuration,
  fadeValue,
  hermesFader,
  type BodyPartCarrier,
  type ItemEvent,
} from '../src/game/fx/body-parts';

const close = (a: number | undefined, b: number, eps = 1e-6) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------------------------------------------------------------------------------------------
// Fader (0x100ac380 / 0x100ac4f0 / 0x100ac550), synthetic

test('fader curve: from + (to - from) x (sin((t - 0.5) pi) + 1) / 2, reversed for a fade-out', () => {
  close(fadeValue(0, 0.85, 0, 1, 1), 0);
  close(fadeValue(0, 0.85, 0.5, 1, 1), 0.425);
  close(fadeValue(0, 0.85, 1, 1, 1), 0.85);
  close(fadeValue(0, 1, 0.25, 1, 1), (Math.sin(-0.25 * Math.PI) + 1) / 2);
  // Mode 2 runs the curve backwards: starts at `to`, ends at `from`.
  close(fadeValue(0, 0.85, 0, 1, 2), 0.85);
  close(fadeValue(0, 0.85, 1, 1, 2), 0);
  // Clamped: past the end holds, a zero duration is the end.
  close(fadeValue(0, 1, 3, 1, 1), 1);
  close(fadeValue(0, 1, 0, 0, 1), 1);
});

test('fader: Start sets the mode and restarts, step advances to the end, Stop jumps there', () => {
  const f = new CharacterFader();
  f.from = 0;
  f.to = 0.85;
  assert.equal(f.opacity, undefined, 'nothing applied until a fade (Character default)');
  f.start(START_FADE_IN, 0.44);
  close(f.opacity, 0);
  f.step(0.22);
  close(f.opacity, 0.425);
  f.step(1);
  close(f.opacity, 0.85);
  assert.equal(f.mode, 0);
  f.start(START_FADE_OUT, 0.52);
  close(f.opacity, 0.85);
  f.stop();
  close(f.opacity, 0);
  // Stop with no fade running changes nothing.
  f.stop();
  close(f.opacity, 0);
});

test('Hermes starts at the end of a fade-in (p182 != 0) or a fade-out (p182 = 0) over p180..p181 %', () => {
  const v: PropValue[] = [];
  v[180] = 0;
  v[181] = 85;
  v[182] = 1;
  close(hermesFader(v).opacity, 0.85);
  v[182] = 0;
  close(hermesFader(v).opacity, 0);
  assert.equal(hermesFader(v).mode, 0, 'idle after the initial apply');
});

test('fade length: to the matching Stop event of the playing clip, else to its end, from its time', () => {
  const evs: ItemEvent[] = [
    { msg: START_FADE_IN, time: 0.42, bone: 0 },
    { msg: STOP_FADE_IN, time: 0.86, bone: 0 },
  ];
  close(fadeDuration(evs, STOP_FADE_IN, 1.2, 0.43), 0.43);
  close(fadeDuration(evs, STOP_FADE_OUT, 1.2, 0.43), 0.77);
  close(fadeDuration([], STOP_FADE_IN, 1.2, 2), 0);
});

test('clip events fire in [t0, t1), wrapping loops, restarting one-shots, the end once reached', () => {
  const evs: ItemEvent[] = [0, 0.19, 0.69, 1.01].map((time, i) => ({ msg: 151, time, bone: i }));
  const bones = (x: ItemEvent[]) => x.map((e) => e.bone);
  assert.deepEqual(bones(crossedEvents(evs, 0, 0.2, 1.2, false)), [0, 1]);
  assert.deepEqual(bones(crossedEvents(evs, 0.19, 0.69, 1.2, false)), [1]);
  assert.deepEqual(bones(crossedEvents(evs, 0.7, 0.7, 1.2, false)), []);
  assert.deepEqual(bones(crossedEvents(evs, 0.9, 0.1, 1.2, true)), [3, 0], 'loop wrapped');
  assert.deepEqual(bones(crossedEvents(evs, 0.9, 0.1, 1.2, false)), [0], 'one-shot restarted');
  const end: ItemEvent[] = [{ msg: 209, time: 4.37, bone: 0 }];
  assert.deepEqual(bones(crossedEvents(end, 4.3, 4.37, 4.37, false, true)), [0], 'a Stop at the very end fires');
  assert.deepEqual(bones(crossedEvents(end, 4.3, 4.37, 4.37, false)), []);
});

// ---------------------------------------------------------------------------------------------
// Body-part sets and attached fountains, synthetic

test('a fountain spawned by an attached generator follows its matrix; origin and axes from p22..p24', () => {
  const v: PropValue[] = [];
  v[17] = 1;
  v[22] = 1;
  v[26] = 14;
  const M = new THREE.Matrix4().makeTranslation(1, 2, 3);
  const em = new Emitter(v, M, [], null);
  em.followM = M;
  M.makeRotationZ(Math.PI / 2).setPosition(5, 6, 7);
  em.update(0.01, 1);
  assert.deepEqual(em.origin.toArray(), [5, 6, 7]);
  // Without followM a fountain stays where it was spawned.
  const fixed = new Emitter(v, new THREE.Matrix4().makeTranslation(1, 2, 3), [], null);
  fixed.update(0.01, 1);
  assert.deepEqual(fixed.origin.toArray(), [1, 2, 3]);
});

function fakeAttachments() {
  const spawned: { ref: string; owner?: Emitter[] }[] = [];
  const fx = {
    generators: [] as Generator[],
    spawn(r: ResRef, _M: THREE.Matrix4, ctx?: { owner?: Emitter[] }) {
      spawned.push({ ref: `${r.pkg}:${r.id}`, owner: ctx?.owner });
      ctx?.owner?.push(new Emitter([], new THREE.Matrix4(), [], null));
    },
  };
  let visible = true;
  const att = new Attachments({
    wfx: fx as never,
    classOf: (r) => (r.pkg === 3 ? 'Object Generator' : 'Attachment'),
    hardpoint: (_uid, hp, out) => (out.makeTranslation(hp, 0, 0), true),
    gone: () => false,
    shown: () => visible,
  });
  return { att, spawned, setVisible: (v: boolean) => (visible = v) };
}

function hermesValues(): PropValue[] {
  const v: PropValue[] = [];
  v[54] = [35, 7, 1, 16, 44, 29, 54];
  v[55] = [...[0, 1, 2].map(() => ({ pkg: 3, id: 3309 })), ...[0, 1, 2].map(() => ({ pkg: 3, id: 3311 })), { pkg: 10, id: 1729 }];
  return v;
}

test('body parts: 154 spawns every effect pair, SpawnItem the first pair on a bone, DestroyItem clears it', () => {
  const { att, spawned, setVisible } = fakeAttachments();
  const v = hermesValues();
  assert.equal(att.spawnParts(1, v), 6, 'the worn model (Attachment) is left to weapons/npc.ts');
  assert.deepEqual(spawned.map((s) => s.ref), ['3:3309', '3:3309', '3:3309', '3:3311', '3:3311', '3:3311']);
  assert.ok(spawned.every((s) => s.owner), 'fountains are owned by the set');
  assert.equal(att.spawnParts(1, v), 0, 'occupied bones are skipped');
  assert.deepEqual(bodyPartAt(v, 1), { hp: 1, ref: { pkg: 3, id: 3309 } });
  assert.equal(att.removeAt(1, 7), 1);
  assert.deepEqual(att.held(1).map((a) => a.hp), [35, 1, 16, 44, 29]);
  assert.equal(att.spawnParts(1, v, 7), 1);
  assert.equal(att.spawnParts(1, v, 0), 0, 'no pair on bone 0');
  // A hidden carrier's fountains pause, and emit again once shown.
  const em = (att as unknown as { sets: Map<number, { emitters: Emitter[] }[]> }).sets.get(1)![0].emitters[0];
  setVisible(false);
  att.update(0);
  assert.equal(em.on, false);
  setVisible(true);
  att.update(0);
  assert.equal(em.on, true);
  // Removing the set stops its fountains (they finish their live particles).
  att.remove(1);
  assert.equal(em.on, false);
  assert.equal(em.oneShot, true);
});

test('BodyParts: clip events drive the set and the fade; messages from links too', () => {
  const log: string[] = [];
  const bp = new BodyParts({
    pkgs: new Map(),
    parts: {
      spawnParts: (uid, _v, bone) => (log.push(`spawn ${bone ?? 'all'}`), 1),
      removeAt: (uid, bone) => (log.push(`remove ${bone}`), 1),
    },
    fire: (uid, slot) => log.push(`fire p${slot}`),
  });
  const clip = new THREE.AnimationClip('appear#1732', 1.2, []);
  const action = { time: 0, loop: THREE.LoopOnce, getClip: () => clip };
  const mats = [new THREE.MeshBasicMaterial()];
  const ch = { current: action, clips: [] as THREE.AnimationClip[], clipData: [], skinned: { animSet: 261 }, mesh: { material: mats } };
  const v: PropValue[] = [];
  v[180] = 0;
  v[181] = 85;
  v[182] = 0;
  const c: BodyPartCarrier = { uid: 0x84ff, cls: 'Hermes', values: v, ch: ch as never };
  // 10:1732's events, as eventsOf decodes them (retail data checked below).
  (bp as unknown as { eventCache: WeakMap<object, ItemEvent[]> }).eventCache.set(clip, [
    { msg: SPAWN_ITEM, time: 0, bone: 0 },
    { msg: START_FADE_IN, time: 0.42, bone: 0 },
    { msg: STOP_FADE_IN, time: 0.86, bone: 0 },
    { msg: DESTROY_ITEM, time: 1.09, bone: 1 },
  ]);
  bp.update(0, [c]);
  close(bp.opacityOf(0x84ff), 0, 1e-9);
  action.time = 0.02;
  bp.update(0.02, [c]);
  assert.deepEqual(log, ['spawn 0']);
  action.time = 0.43;
  bp.update(0.41, [c]);
  assert.deepEqual(log, ['spawn 0', 'fire p34']);
  close(bp.opacityOf(0x84ff), 0, 1e-9);
  // Half way through the 0.43 s fade.
  action.time = 0.645;
  bp.update(0.215, [c]);
  close(bp.opacityOf(0x84ff), 0.425, 1e-6);
  action.time = 1.2;
  bp.update(0.555, [c]);
  close(bp.opacityOf(0x84ff), 0.85, 1e-9);
  assert.deepEqual(log.slice(2), ['remove 1']);
  // Own material copies carry the opacity; the kind's shared ones are untouched.
  const own = ch.mesh.material as unknown as THREE.Material;
  assert.notEqual(own, mats[0]);
  close(own.opacity, 0.85, 1e-9);
  assert.equal(mats[0].opacity, 1);
  // Link / STOMP messages: 154 spawns every pair, 208 / 209 fade out (no Stop event: to the end).
  assert.equal(bp.message(c, SPAWN_ATTACHMENTS), true);
  assert.equal(log.at(-1), 'spawn all');
  assert.equal(bp.message(c, SPAWN_ITEM), false, 'SpawnItem needs the bone of a clip event');
  bp.message(c, START_FADE_OUT);
  bp.message(c, STOP_FADE_OUT);
  close(bp.opacityOf(0x84ff), 0, 1e-9);
  assert.equal(bp.message(c, 1), false);
  bp.dispose();
});

// ---------------------------------------------------------------------------------------------
// Retail data

async function level(name: string) {
  const path = `LEVELS/1 PrisonDeathRow/${name} PrisonDeathRow.lvl`;
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages, ents: parseEntities(lvl, packages, { resolveStrings: false }) };
  } finally {
    console.warn = warn;
  }
}

test('retail: Hermes carries six gas generators on shoulders, pelvis, hands and head; 85 % opaque in 1a, invisible in 1b', { skip }, async () => {
  for (const [name, uid, startsFaded] of [['1a', 0x84ff, false], ['1b', 0x7eb4, true]] as const) {
    const { packages, ents } = await level(name);
    const h = ents.find((e) => e.uid === uid)!;
    assert.equal(h.className, 'Hermes');
    assert.deepEqual(h.values[54], [35, 7, 1, 16, 44, 29]);
    assert.deepEqual((h.values[55] as ResRef[]).map((r) => `${r.pkg}:${r.id}`), ['3:3309', '3:3309', '3:3309', '3:3311', '3:3311', '3:3311']);
    assert.equal(h.values[56], 0, 'not spawned at creation: a SpawnAttachments does it');
    close(hermesFader(h.values).opacity, startsFaded ? 0 : 0.85);
    for (const id of [3309, 3311]) {
      const g = readTemplate(packages, { pkg: 3, id })!;
      assert.equal(g.cls, 'Object Generator');
      assert.equal(g.values[6], 2, 'spawns its list once');
      assert.equal(readTemplate(packages, g.values[25] as ResRef)?.cls, 'Follower Object', 'what it spawns follows it');
      for (const r of g.values[0] as ResRef[]) {
        const f = readTemplate(packages, r)!;
        assert.equal(f.cls, 'Particle Fountain');
        assert.equal(f.values[10], 0, 'emits until destroyed');
        assert.equal(f.values[46], 1, 'alpha-blended puffs');
        assert.equal(f.values[33], 0x819c56, 'grey-green gas');
      }
    }
    // The bones: right / left shoulder, pelvis, left / right hand, head (bind pose heights).
    const m = readSkinnedModel(packages as unknown as PackageSet, h.modelRef!)!;
    const y = (b: number) => m.skeleton.bones[b].bindWorld[13];
    assert.ok(y(35) > 1.9 && y(7) > 1.9 && y(29) > 2.3 && y(1) > 1.2 && y(16) > 1.2 && y(44) > 1.2);
  }
});

test('retail: 1a scene STOMP 12:283 sends SpawnAttachments to Hermes; Hermes clips carry the item / fade events', { skip }, async () => {
  const { packages } = await level('1a');
  const seq = parseStompSequence((packages as unknown as PackageSet).get(12)!.qdu!, 283)!;
  const track = seq.tracks.find((t) => t.uid === 0x84ff)!;
  assert.deepEqual(track.messages.map((m) => m.message), [SPAWN_ATTACHMENTS]);
  // Events as the runtime reads them off Hermes' rig (animation set 261).
  const skinned = readSkinnedModel(packages as unknown as PackageSet, { pkg: 10, id: 92 })!;
  const bp = new BodyParts({ pkgs: packages as never, parts: { spawnParts: () => 0, removeAt: () => 0 } });
  const evs = (id: number) => bp.eventsOf({ clips: [], clipData: [], skinned } as never, new THREE.AnimationClip(`x#${id}`, 1, [])).map((e) => [e.msg, +e.time.toFixed(2), e.bone]);
  // Disappear (CeilingFloorTransition p5): fade out, the pelvis gas comes, the root item goes.
  assert.deepEqual(evs(1733), [[START_FADE_OUT, 0.17, 0], [SPAWN_ITEM, 0.19, 1], [STOP_FADE_OUT, 0.69, 0], [DESTROY_ITEM, 1.01, 0]]);
  // Appear (p4): the root item, fade in, the pelvis gas goes.
  assert.deepEqual(evs(1732), [[SPAWN_ITEM, 0, 0], [START_FADE_IN, 0.42, 0], [STOP_FADE_IN, 0.86, 0], [DESTROY_ITEM, 1.09, 1]]);
  // 10:751: the shoulders and pelvis gas while he fades out.
  assert.deepEqual(evs(751).filter((e) => e[0] === SPAWN_ITEM).map((e) => e[2]).sort((a, b) => a - b), [1, 7, 35]);
});
