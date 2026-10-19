// Sequence playback (src/game/world/stomp.ts StompRun, src/game/sequence/clips.ts):
// scenes where two scripted characters must meet, and objects a sequence removes at its end
// (docs/game-logic.md §7 / §11.4). The data test runs against a local game install and skips
// without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import type { EntityPackage, EntityPackageSet } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { readSkinnedModel } from '../src/formats/skeleton';
import { readAnimation } from '../src/formats/animation';
import { Character } from '../src/app/character';
import {
  parseStompSequence,
  sampleTrack,
  StompRun,
  TRACK_REMOVE_AT_END,
  type StompAnimKey,
  type StompSequence,
  type StompSink,
  type StompTrack,
} from '../src/game/world/stomp';
import { attachPointBones, makeScriptedClip, playScriptedClip } from '../src/game/sequence/clips';
import { sequencePropCandidate } from '../src/game/sequence/props';
import { fitsRig } from '../src/game/actors/kinds';

const track = (name: string, index: number, uid: number, flags: number, end: number): StompTrack => ({
  name,
  index,
  uid,
  flags,
  keyCount: 1,
  transforms: [],
  anims: [],
  sounds: [],
  attaches: [],
  controls: [],
  visibility: [],
  messages: [{ time: end, message: 0, param: 0, flags: 0 }],
  cameras: [],
});

test('tracks flagged 0x08 have their object removed when the sequence ends (played or skipped)', () => {
  const seq: StompSequence = {
    id: 1,
    flags: 0x46,
    length: 20,
    duration: 5,
    byteLength: 0,
    tracks: [track('stand-in', 1, 0x100, 0x10 | TRACK_REMOVE_AT_END, 5), track('kept', 2, 0x200, 0x10, 5)],
  };
  for (const skipIt of [false, true]) {
    const removed: number[] = [];
    const sink: StompSink = { send: () => {}, setVisible: () => {}, pose: () => {}, remove: (uid) => removed.push(uid) };
    const run = new StompRun(0x50, seq);
    if (skipIt) run.advance(Infinity, sink);
    else {
      for (let i = 0; i < 49; i++) run.advance(0.1, sink);
      assert.deepEqual(removed, [], 'nothing removed before the end');
      run.advance(0.2, sink);
    }
    assert.ok(run.finished);
    assert.deepEqual(removed, [0x100], skipIt ? 'skipped' : 'played');
  }
});

let cache: EntityPackageSet | undefined;
function packages(): EntityPackageSet {
  if (cache) return cache;
  const out = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu', 'adu', 'qdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p as unknown as EntityPackage);
  }
  return (cache = out as unknown as EntityPackageSet);
}

// 1a "Gaurd" #280 (12:280): the flashlight guard (10:46) stands at the cell bars and the
// CartWheeler (10:2) drops from the ceiling and drives its right blade through his head
// (HeadWoundGen fires at 4.87 s). Both play paired clips from 4.24 / 4.51 s (12:199 guard,
// 12:200 creature, 8.8 s each) from origins 0.5 m apart; the clips' body offsets carry the
// bodies 7 m to the bars. Played between two sequences, the guard's AI had started its idle:
// left running at weight 1 it averaged the scripted pose, and the guard stood 3.4 m short
// of the blade (3.7 m from the head).
test('1a "Gaurd" #280: the CartWheeler blade meets the guard\'s head', { skip }, () => {
  const pkgs = packages();
  const seq = parseStompSequence((pkgs.get(12) as { qdu: SrscFile }).qdu, 280)!;
  assert.ok(seq, 'sequence 12:280');
  const guardT = seq.tracks.find((t) => t.name === 'Gaurd')!;
  const cartT = seq.tracks.find((t) => t.name === 'CartWheeler')!;
  const make = (pkg: number, id: number) => new Character(readSkinnedModel(pkgs, { pkg, id })!);
  const guard = make(10, 46), cart = make(10, 2);
  // The guard's AI idle (as between "Guard" #230 and this sequence).
  const adu = (pkg: number) => (pkgs.get(pkg) as { adu: SrscFile }).adu;
  const aiGuard = new Character(guard.skinned, [readAnimation(adu(10), 70)!]);
  const ai = guard.mixer.clipAction(aiGuard.clips[0]);
  ai.play();
  guard.current = ai;
  guard.mixer.update(1);

  const bone = (ch: Character, hash: number) => ch.skeleton.bones.find((b) => b.name === `b_${hash.toString(16).padStart(8, '0')}`)!;
  const at = (ch: Character, hash: number) => bone(ch, hash).getWorldPosition(new THREE.Vector3());
  const segDist = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => {
    const d = b.clone().sub(a);
    const u = Math.max(0, Math.min(1, p.clone().sub(a).dot(d) / d.lengthSq()));
    return a.clone().addScaledVector(d, u).distanceTo(p);
  };
  const delivered = new Set<StompAnimKey>();
  const step = (ch: Character, t: StompTrack, time: number, dt: number) => {
    for (const k of t.anims) {
      if (k.channel !== 0 || k.time > time || delivered.has(k)) continue;
      delivered.add(k);
      const data = readAnimation(adu(k.clip.pkg), k.clip.id)!;
      playScriptedClip(ch, makeScriptedClip(data, ch.skinned), k, time - k.time);
    }
    const p = sampleTrack(t, time);
    if (p) {
      ch.root.position.set(p.position[0] / 2048, p.position[1] / 2048, p.position[2] / 2048);
      ch.root.quaternion.set(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
    }
    ch.mixer.update(dt);
    ch.root.updateMatrixWorld(true);
  };
  const dt = 1 / 30;
  let best = Infinity, bestAt = 0;
  for (let time = 0; time <= 5.5; time += dt) {
    step(guard, guardT, time, dt);
    step(cart, cartT, time, dt);
    if (time < 4.6) continue;
    const head = at(guard, 0x07c159a2);
    // Right blade: forearm blade bone -> its tip bone.
    const d = segDist(head, at(cart, 0xd61bd1ae), at(cart, 0xb16eb3a2));
    if (d < best) (best = d), (bestAt = time);
  }
  assert.ok(best < 0.1, `blade passes ${best.toFixed(3)} m from the head bone (at ${bestAt.toFixed(2)} s)`);
  assert.ok(bestAt > 4.75 && bestAt < 5.6, `closest at ${bestAt.toFixed(2)} s (HeadWoundGen fires at 4.87 s)`);
  // Only the scripted clip drives the guard; the body offset carries his hips ~7 m to the bars.
  assert.ok(!ai.isScheduled(), 'the AI idle was stopped');
  const hips = at(guard, 0xcf418bd0);
  assert.ok(hips.distanceTo(guard.root.position) > 6, `hips ${hips.distanceTo(guard.root.position).toFixed(2)} m from the origin`);
  guard.dispose();
  cart.dispose();
  aiGuard.dispose();
});

test('scripted clips place the rig\'s attach bones where the clip puts them (1a "Goose" photo)', { skip }, () => {
  const pkgs = packages();
  const torque = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!;
  const free = attachPointBones(torque);
  // Bone 35: the right hand's weapon bone (hardpoint channel 16), skins nothing.
  assert.ok(free.has(35), 'weapon bone 35 is an attach point');
  assert.ok(!free.has(34) && !free.has(0), 'the hand and the root are not');
  const adu = (pkgs.get(2) as { adu: SrscFile }).adu;
  for (const id of [395, 396]) {
    const data = readAnimation(adu, id)!;
    const t = data.tracks.find((k) => k.boneHash === torque.skeleton.bones[35].hash)!;
    assert.ok(!t.translations, `2:${id} bone 35 is a rotation-only track`);
    const ch = new Character(torque);
    playScriptedClip(ch, makeScriptedClip(data, torque), { offset: 0, blend: 0, speed: 1 }, 0);
    ch.mixer.update(0);
    const p = ch.skeleton.bones[35].position;
    // The clip moves the grip 7-12 cm from the bind position towards the fingertips.
    assert.ok(p.distanceTo(new THREE.Vector3(...t.constantTranslation)) < 1e-6, `2:${id}: bone 35 at the clip's translation`);
    assert.ok(p.distanceTo(new THREE.Vector3(...torque.skeleton.bones[35].position)) > 0.07, `2:${id}: not the bind position`);
    ch.dispose();
  }
});

test('a Behavior Changer\'s death pose of another clip set fits the rig (1a "Gaurd" #218)', { skip }, () => {
  const pkgs = packages();
  const guard = readSkinnedModel(pkgs, { pkg: 10, id: 22 })!;
  const adu = (pkg: number) => (pkgs.get(pkg) as { adu: SrscFile }).adu;
  // DeathBehavior 12:793's pose 12:195 (set 209; 19 of its 78 tracks bind to no bone of 10:22).
  assert.ok(fitsRig(readAnimation(adu(12), 195)!, guard), 'corpse pose 12:195');
  // A CartWheeler clip is not a human's.
  assert.ok(!fitsRig(readAnimation(adu(12), 10)!, guard), 'CartWheeler drag clip 12:10');
});

test('sequence props: plain prop classes whatever instance flag 0x80 (1a "Guard" #242 "Chain")', () => {
  assert.ok(sequencePropCandidate('Breakable', 0x1, 12), 'the Chain (flags 0x1)');
  assert.ok(sequencePropCandidate('Breakable', 0x281, 7), 'flag 0x80 as before');
  assert.ok(!sequencePropCandidate('Crane', 0x1, 23), 'cranes belong to levels/skinned-props.ts');
  assert.ok(!sequencePropCandidate('Breakable', 0x281, 2), 'editor proxies');
});
