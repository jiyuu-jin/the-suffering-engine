// Animation and STOMP reverse-engineering results (docs/re/animation.md): decoders checked
// against every retail file, plus the blending / layering rules the port implements.
// Data tests skip without a local game install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { filesWithExt, readSrsc, skip } from './helpers';
import {
  ADU_EVENTS,
  ADU_GROUP,
  ADU_HEADER,
  ADU_LINKS,
  ANIM_EVENT_MESSAGE,
  ANIM_MESSAGES,
  blendInto,
  eventsInWindow,
  readAnimation,
  readAnimEvents,
  readClipLinks,
  sampleTrackRotation,
  sampleTrackTranslation,
  type AnimClipData,
} from '../src/formats/animation';
import { boneSubtree, MDU_SKELETON, readSkeleton, readSkeletonTrailer, type Skeleton, type SkinnedModel } from '../src/formats/skeleton';
import { readHardpoints } from '../src/game/weapons/hardpoints';
import { ANIM_INDEPENDENT, ANIM_UNLOAD, decodeStompSequence, QDU_SEQUENCE, rootMotionModes } from '../src/game/world/stomp';
import { AimBones, Character, engineBlendWeight, layerBoneForClip, LookAtBone } from '../src/app/character';
import { buildAnimationClip } from '../src/app/character';
import { lensFov } from '../src/game/sequence/clips';
import { aimSlew } from '../src/game/actors/director';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT } from './helpers';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';

test('skeleton trailer (LODs, channel table, LOD distances, sphere tree) covers every rig exactly', { skip }, () => {
  let rigs = 0, withBits = 0;
  for (const path of filesWithExt('.mdu')) {
    const f = readSrsc(path);
    for (const e of f.entries) {
      if (e.type !== MDU_SKELETON) continue;
      const tr = readSkeletonTrailer(f, e.id);
      assert.ok(tr, `${path}#${e.id}: trailer`);
      assert.equal(tr.end, e.size, `${path}#${e.id}: decoded ${tr.end} of ${e.size}`);
      const sk = readSkeleton(f, e.id)!;
      const n = sk.bones.length;
      assert.deepEqual(tr.channels.map((c) => c.bone), readHardpoints(f, e.id), `${path}#${e.id}: channel bones`);
      for (const c of tr.channels) {
        assert.ok(c.bone < n);
        for (const w of c.bits) assert.ok(w === 0 || (w & (w - 1)) === 0, 'single bits');
      }
      // The bits are distinct per rig and ascend with the channel order.
      const bits = tr.channels.map((c) => c.bits[0]).filter(Boolean);
      if (bits.length) withBits++;
      for (let i = 1; i < bits.length; i++) assert.ok(bits[i] > bits[i - 1]);
      assert.ok(tr.lodDistances[0] > 0 && tr.lodDistances[1] >= tr.lodDistances[0]);
      for (const s of tr.spheres) {
        assert.ok(s.bone < n && s.radius >= 0, `${path}#${e.id}: sphere ${s.bone}/${n} r ${s.radius}`);
        // Out-of-range child indices occur; the engine resets them to 0 (0x482e96).
      }
      rigs++;
    }
  }
  assert.equal(rigs, 190);
  assert.ok(withBits >= 25, `${withBits} rigs with channel bits`);
});

test('.adu: headers, transition blends (type 4) and events (type 5) decode exactly', { skip }, () => {
  let clips = 0, linked = 0, events = 0, messages = 0;
  for (const path of filesWithExt('.adu')) {
    const f = readSrsc(path);
    const ids = new Set(f.entries.filter((e) => e.type === ADU_HEADER && e.group === ADU_GROUP).map((e) => e.id));
    for (const e of f.entries) {
      if (e.group !== ADU_GROUP) continue;
      if (e.type === ADU_HEADER) {
        assert.equal(e.size, 28);
        const h = f.data(e);
        assert.ok((h.getUint32(4, true) & ~3) === 0, 'header flags 0..3');
        clips++;
      } else if (e.type === ADU_LINKS) {
        const links = readClipLinks(f, e.id);
        assert.equal(e.size, 2 + 8 * links.length, `${path}#${e.id}: 8-byte links`);
        for (const l of links) {
          assert.ok(ids.has(l.id), `${path}#${e.id}: link to ${l.id}`);
          assert.ok(l.blend >= 0 && l.blend < 5);
        }
        const clip = readAnimation(f, e.id)!;
        assert.equal(blendInto(clip, links[0]), links[0].blend);
        assert.equal(blendInto(clip, { id: -1 }), clip.blendTime);
        linked++;
      } else if (e.type === ADU_EVENTS) {
        const ev = readAnimEvents(f, e.id);
        assert.ok(ev, `${path}#${e.id}: events`);
        assert.equal(ev.byteLength, e.size, `${path}#${e.id}: decoded ${ev.byteLength} of ${e.size}`);
        for (const x of ev.events) {
          assert.ok(x.kind === 0 || x.kind === 1, 'only sound / message events');
          if (x.kind === ANIM_EVENT_MESSAGE) {
            assert.ok(ANIM_MESSAGES[x.param], `${path}#${e.id}: message ${x.param}`);
            messages++;
          }
        }
        events += ev.events.length;
      }
    }
  }
  assert.equal(clips, 1924);
  assert.equal(linked, 35);
  assert.equal(events, 1543);
  assert.equal(messages, 1065);
});

test('STOMP animation keys: flag bits, root-motion modes and secondary channels', { skip }, () => {
  let keys = 0, unload = 0, secondary = 0;
  for (const path of filesWithExt('.qdu')) {
    const f = readSrsc(path);
    for (const e of f.entries) {
      if (e.type !== QDU_SEQUENCE) continue;
      for (const t of decodeStompSequence(f.data(e), e.id).tracks) {
        for (const k of t.anims) {
          keys++;
          assert.equal(k.flags & ~0x1ff, 0, 'only the root modes and 0x100 occur');
          assert.equal(k.flags & ANIM_INDEPENDENT, 0);
          if (k.flags & ANIM_UNLOAD) unload++;
          if (k.channel) secondary++;
        }
      }
    }
  }
  assert.equal(keys, 1433);
  assert.equal(unload, 517);
  assert.equal(secondary, 11);
  assert.deepEqual(rootMotionModes(0x20), { x: 0, y: 0, z: 2, rotation: 0 });
  assert.deepEqual(rootMotionModes(0x3f), { x: 2, y: 2, z: 2, rotation: 0 });
  assert.deepEqual(rootMotionModes(0x55), { x: 1, y: 1, z: 1, rotation: 1 });
});

test('engine cross-fade curve and event windows', () => {
  assert.equal(engineBlendWeight(0), 0);
  assert.equal(engineBlendWeight(1), 1);
  assert.equal(engineBlendWeight(0.5), 0.5);
  assert.ok(Math.abs(engineBlendWeight(0.25) - 0.125) < 1e-9);
  assert.ok(Math.abs(engineBlendWeight(0.75) - 0.875) < 1e-9);
  for (let x = 0; x < 1; x += 0.05) assert.ok(engineBlendWeight(x + 0.05) >= engineBlendWeight(x));
  const ev = [{ time: 0.1 }, { time: 0.5 }, { time: 0.9 }];
  assert.deepEqual(eventsInWindow(ev, 0.1, 0.5), [{ time: 0.1 }]);
  assert.deepEqual(eventsInWindow(ev, 0.8, 0.2), [{ time: 0.1 }, { time: 0.9 }]);
  assert.deepEqual(eventsInWindow(ev, 0.3, 0.3), []);
});

// ---------------------------------------------------------------------------
// Layers on a synthetic rig: root -> pelvis -> spine -> arm, pelvis -> leg.

function rig(): SkinnedModel {
  const parents = [-1, 0, 1, 2, 1];
  const bones = parents.map((parent, index) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, index * 0.2, 0, 1]);
    return { index, hash: 0x1000 + index, name: `b_${(0x1000 + index).toString(16).padStart(8, '0')}`, parent, children: [] as number[], inverseBind: m, bindWorld: m, position: [0, index ? 0.2 : 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
  });
  bones.forEach((b) => b.parent >= 0 && bones[b.parent].children.push(b.index));
  const skeleton: Skeleton = { version: 1, vertexCount: 0, bones, byHash: new Map(bones.map((b) => [b.hash, b.index])), sphere: { center: [0, 0, 0], radius: 1 }, skinIndex: new Uint16Array(), skinWeight: new Float32Array() };
  return {
    ref: { pkg: 0, id: 0 },
    animSet: 0,
    model: { ref: { pkg: 0, id: 0 }, vertexCount: 0, source: new Uint32Array(), positions: new Float32Array(), normals: new Float32Array(), uvs: new Float32Array(), submeshes: [], materials: [] },
    skeleton,
    skinIndex: new Uint16Array(),
    skinWeight: new Float32Array(),
  } as unknown as SkinnedModel;
}

/** A clip turning `bones` about Y to `angle` (at rest at t = 0, from t = 0.01 on), others at rest. */
function clip(id: number, angle: number, bones: number[], all = 5): AnimClipData {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
  return {
    id,
    animSet: 0,
    duration: 1,
    flags: 0,
    blendTime: 0.2,
    rate: 1,
    links: [],
    tracks: Array.from({ length: all }, (_, b) => ({
      boneHash: 0x1000 + b,
      format: 0xc0,
      times: new Float32Array([0, 0.01, 1]),
      rotations: bones.includes(b) ? new Float32Array([0, 0, 0, 1, q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]) : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      constantTranslation: [0, b ? 0.2 : 0, 0] as [number, number, number],
    })),
  };
}

test('layers own a bone subtree, blend in from the pose under them, and a whole-body clip takes them over', () => {
  const sk = rig();
  assert.deepEqual(boneSubtree(sk.skeleton, 2), [2, 3]);
  const walk = clip(1, 0, []);
  const shot = clip(2, Math.PI / 2, [2, 3]);
  const ch = new Character(sk, [walk, shot]);
  assert.equal(layerBoneForClip(shot, sk.skeleton), 2, 'upper-body root = spine');
  assert.equal(layerBoneForClip(clip(3, 1, [3, 4]), sk.skeleton), undefined, 'arm + leg: whole body');
  ch.play(0, { fade: 0 });
  ch.update(0.01);
  const yaw = (b: number) => 2 * Math.atan2(ch.skeleton.bones[b].quaternion.y, ch.skeleton.bones[b].quaternion.w);
  ch.playLayer(2, 1, { blend: 0.4 });
  ch.update(0.1);
  const mid = yaw(2);
  assert.ok(mid > 0.01 && mid < Math.PI / 2 - 0.01, `blending in (${mid})`);
  ch.update(0.4);
  assert.ok(Math.abs(yaw(2) - Math.PI / 2) < 1e-3 && Math.abs(yaw(3) - Math.PI / 2) < 1e-3, `subtree follows the layer (${yaw(2)}, ${yaw(3)})`);
  assert.ok(Math.abs(yaw(4)) < 1e-6 && Math.abs(yaw(1)) < 1e-6, 'the rest follows the whole-body clip');
  // A whole-body clip takes a (non-independent) layer over.
  ch.releaseLayers(0.2);
  ch.update(0.3);
  assert.equal(ch.layers.size, 0);
  ch.update(0.01);
  assert.ok(Math.abs(yaw(2)) < 1e-3, 'back to the whole-body pose');
  // An independent layer stays.
  ch.playLayer(2, 1, { blend: 0, independent: true });
  ch.releaseLayers(0.2);
  ch.update(0.3);
  assert.equal(ch.layers.size, 1);
  assert.ok(Math.abs(yaw(2) - Math.PI / 2) < 1e-3);
  ch.dispose();
});

test('root translation sampling and the engine blend curve on the main mixer', () => {
  const c = clip(5, 0, []);
  c.tracks[0] = { ...c.tracks[0], format: 0x80, times: new Float32Array([0, 1]), translations: new Float32Array([0, 0, 0, 0, 0, -2]) };
  assert.deepEqual(sampleTrackTranslation(c, 0.25, 0x1000), [0, 0, -0.5]);
  assert.deepEqual(sampleTrackTranslation(c, 2, 0x1000), [0, 0, -2]);
  const ch = new Character(rig(), [clip(1, 0, []), clip(2, 1, [1, 2, 3, 4])]);
  const a = ch.play(0, { fade: 0 })!;
  ch.update(0.01);
  const b = ch.play(1, { fade: 0.4 })!;
  ch.update(0.1);
  assert.ok(Math.abs(b.getEffectiveWeight() - engineBlendWeight(0.25)) < 1e-6);
  assert.ok(Math.abs(a.getEffectiveWeight() - (1 - engineBlendWeight(0.25))) < 1e-6);
  ch.update(0.4);
  assert.equal(b.getEffectiveWeight(), 1);
  assert.ok(!a.isRunning());
  ch.dispose();
});

test('model-space bone hooks: bend, look-at cone and aim elevation', () => {
  const ch = new Character(rig(), [clip(1, 0, [])]);
  ch.play(0, { fade: 0 });
  const world = (b: number) => {
    ch.root.updateMatrixWorld(true);
    return ch.skeleton.bones[b].getWorldPosition(new THREE.Vector3());
  };
  ch.update(0.01);
  const before = world(3);
  // Bend the spine (bone 2) forward / down: R(X, -angle) in model space (engine sign).
  ch.poseHooks.push((c) => c.rotateBoneModel(2, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5)));
  ch.update(0.01);
  const after = world(3);
  assert.ok(after.z < before.z - 0.05 && after.y < before.y, 'the arm moves forward (-Z) and down');
  ch.poseHooks.length = 0;

  const look = new LookAtBone(2, 45, 0, 1000, 0.01);
  look.target = new THREE.Vector3(10, 0.4, 0); // to the right, outside the 45 degree cone
  ch.poseHooks.push(look.apply);
  for (let i = 0; i < 10; i++) ch.update(0.05);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ch.skeleton.bones[2].getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(Math.abs(fwd.x - Math.SQRT1_2) < 0.02 && Math.abs(fwd.z + Math.SQRT1_2) < 0.02, `turned to the cone rim (${fwd.toArray()})`);
  ch.poseHooks.length = 0;

  const aim = new AimBones([3], 3, -45, 45, 1, 1000);
  aim.target = new THREE.Vector3(0, 100, -1); // far above: clamped to 45 degrees
  ch.poseHooks.push(aim.apply);
  for (let i = 0; i < 5; i++) ch.update(0.05);
  const up = new THREE.Vector3(0, 0, -1).applyQuaternion(ch.skeleton.bones[3].quaternion);
  assert.ok(Math.abs(Math.asin(up.y) - Math.PI / 4) < 0.02, `pitched up 45 degrees (${up.toArray()})`);
  ch.dispose();
});

test('camera-key FOV is the vertical angle of the 4:3 picture', () => {
  assert.ok(Math.abs(lensFov(53, 4 / 3) - 53) < 1e-9);
  // 16:9 keeps the 4:3 horizontal angle: tan(v/2) * 16/9 == tan(53/2) * 4/3.
  const v = lensFov(53, 16 / 9);
  const t = (d: number) => Math.tan((d * Math.PI) / 360);
  assert.ok(Math.abs(t(v) * (16 / 9) - t(53) * (4 / 3)) < 1e-9);
  assert.ok(Math.abs(lensFov(53, 1) - 53) < 1e-9, 'narrower screens keep the vertical angle');
});

test('root rotation sampling, and rotation mode 1 holds the start rotation in the pose', () => {
  const c = clip(6, 0, []);
  const h = Math.SQRT1_2;
  c.tracks[0] = { ...c.tracks[0], times: new Float32Array([0, 1]), rotations: new Float32Array([0, 0, 0, 1, 0, h, 0, h]) };
  const q = sampleTrackRotation(c, 0.5, 0x1000);
  const yaw = 2 * Math.atan2(q[1], q[3]);
  assert.ok(Math.abs(yaw - Math.PI / 4) < 1e-6, `slerp half way (${yaw})`);
  assert.deepEqual(sampleTrackRotation(c, 0, 0x1234), [0, 0, 0, 1], 'no track: identity');
  for (const rotation of [1, 2] as const) {
    const built = buildAnimationClip(c, rig().skeleton, { rootMotion: { x: 0, y: 0, z: 0, rotation } });
    const tr = built.tracks.find((t) => t.name.endsWith('.quaternion'))!;
    assert.deepEqual([...tr.values.slice(4, 8)], [0, 0, 0, 1], `mode ${rotation}: the pose keeps the start rotation`);
  }
  const keep = buildAnimationClip(c, rig().skeleton, { rootMotion: { x: 0, y: 0, z: 0, rotation: 0 } });
  assert.ok(Math.abs(keep.tracks.find((t) => t.name.endsWith('.quaternion'))!.values[5] - h) < 1e-6, 'mode 0 keeps it');
});

test('Aim Controller slew (0x1008eb60): accelerates, brakes to stop on the target, top speed by the caller', () => {
  // From rest toward +90 at accel / decel 90: speed grows by 90 * dt.
  assert.equal(aimSlew(0, 90, 0, 90, 90, 0.1), 9);
  // Moving away from the target: brakes, never past 0.
  assert.equal(aimSlew(0, 90, -5, 90, 90, 0.1), 0);
  // Stopping distance v^2 / (2 decel) = 50 >= 40 left: brakes.
  assert.equal(aimSlew(50, 90, 90, 90, 90, 0.1), 81);
  // On the target (within 0.001): brakes.
  assert.equal(aimSlew(90, 90.0005, 9, 90, 90, 0.1), 0);
  // Integrated with the p6 clamp the yaw settles on the target without overshooting far.
  let cur = 0, vel = 0;
  for (let i = 0; i < 400; i++) {
    vel = Math.max(-90, Math.min(90, aimSlew(cur, 60, vel, 90, 90, 1 / 60)));
    cur += vel / 60;
  }
  assert.ok(Math.abs(cur - 60) < 1.5, `settles (${cur})`);
});

let pk: EntityPackageSet | undefined;
function packages(): EntityPackageSet {
  if (pk) return pk;
  const out = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    try {
      const b = readFileSync(`${base}.odu`);
      p.odu = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    } catch {
      // no templates
    }
    out.set(id, p as unknown as EntityPackage);
  }
  return (pk = out as unknown as EntityPackageSet);
}
const props = (pkg: number, id: number): { cls: string; v: PropValue[] } | undefined => {
  const t = readObjectTemplate(packages(), { pkg, id });
  const c = t && classByHash(t.classHash);
  return t && c ? { cls: c.name, v: decodeTemplateProps(c, t) } : undefined;
};
const refId = (x: PropValue | undefined) => (x && typeof x === 'object' && !Array.isArray(x) ? `${x.pkg}:${x.id}` : undefined);

test('NPC ranged attacks: whole-body aim pose and firing clip, bursts (guard Attack 10:169)', { skip }, () => {
  // Every retail Attack plays its aim pose (p4) on channel p20 = -1, the whole body, except the
  // Mainliner's needle throw 10:210 (channel 5: aim pose on the upper body over MovementAnim).
  let attacks = 0;
  for (let id = 0; id < 4000; id++) {
    const a = props(10, id);
    if (a?.cls !== 'Attack') continue;
    attacks++;
    assert.equal(a.v[20], id === 210 ? 5 : -1, `10:${id} p20`);
  }
  assert.ok(attacks > 20, `${attacks} Attack templates`);
  const g = props(10, 169)!;
  assert.equal(refId(g.v[0]), '10:35', 'firing clip');
  assert.equal(refId(g.v[4]), '10:141', 'aim pose');
  assert.equal(g.v[1], 1);
  assert.ok(Math.abs((g.v[2] as number) - 0.15) < 1e-6, 'rate 1 +- 0.15');
  assert.equal(g.v[23], 6, 'six shots per attack');
  assert.ok(Math.abs((g.v[21] as number) - 0.15) < 1e-6 && Math.abs((g.v[22] as number) - 0.25) < 1e-6, '0.15..0.25 s between shots');
  assert.equal(g.v[30], 1, 'line-of-fire check');
});

test('Player Weapon Properties: action bones and the moving-aim heading sets (revolver 2:436)', { skip }, () => {
  const v = props(2, 436)!.v;
  assert.deepEqual([v[1], v[2], v[3], v[4], v[6]], [6, 5, 5, 5, 5], 'fire / fire 2 / reload / throw / draw bones');
  // Heading sets p116 + 7k: angle, run clip, speed, hold, fire, fire 2, throw.
  assert.deepEqual([116, 123, 130, 137, 144].map((i) => v[i]), [45, 120, 180, 240, 315]);
  assert.equal(refId(v[117]), refId(v[20]), 'set 0 runs with the armed run clip');
  assert.equal(refId(v[113]), '2:474', 'standing fire (k = -1)');
  assert.equal(refId(v[106]), '2:288', 'first-person fire (k = -2)');
  assert.equal(refId(v[120]), '2:278', 'moving fire, set 0');
  assert.equal(refId(v[97]), '2:284', 'standing reload');
  assert.equal(refId(v[96]), '2:271', 'first-person reload');
  assert.equal(refId(v[172]), '2:455', 'first-person draw');
  assert.equal(refId(v[173]), '2:289', 'standing draw');
});
