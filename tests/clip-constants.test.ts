// The engine's clip sampler rule for every character (src/app/character.ts buildAnimationClip;
// docs/re/animation.md §7): a rotation-only (0xc0) track poses its bone at the track's constant
// translation (SUFFERING.EXE 0x46a180 / 0x46a290), bones without a track keep the bind
// translation, tracks bind to bones by hash (0x4793b0), and the root-motion axes a key extracts
// or locks are cleared on the root's sampled translation whichever way it got it (0x478c07).
// Every Character follows it: NPCs, creatures, the third-person player body, STOMP puppets,
// skinned props (tools/clip-constants.ts audits the pairs the levels play).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as THREE from 'three/webgpu';
import { buildAnimationClip, Character } from '../src/app/character';
import type { AnimClipData } from '../src/formats/animation';
import type { Skeleton, SkinnedModel } from '../src/formats/skeleton';
import { readSkinnedModel } from '../src/formats/skeleton';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import type { PackageSet } from '../src/formats/model';
import { loadClip } from '../src/game/actors/clipmap';
import { scriptedClip } from '../src/game/sequence/clips';
import { blendCycle } from '../src/game/actors/gait';
import { KindLibrary, type CreatureKind } from '../src/game/actors/kinds';
import { posePositions } from '../tools/clip-constants';
import { DATA_ROOT, nodeFS, readSrsc, skip } from './helpers';

/** Bytes at a virtual address of a PE image (file offset through the section table). */
function peBytes(file: string, va: number, n: number): string {
  const b = readFileSync(join(DATA_ROOT, file));
  const pe = b.readUInt32LE(0x3c);
  const sections = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), base = b.readUInt32LE(pe + 24 + 28);
  for (let i = 0; i < sections; i++) {
    const s = pe + 24 + optSize + 40 * i;
    const vaddr = b.readUInt32LE(s + 12), vsize = b.readUInt32LE(s + 8), raw = b.readUInt32LE(s + 20);
    if (va - base >= vaddr && va - base < vaddr + vsize) return b.subarray(raw + (va - base - vaddr), raw + (va - base - vaddr) + n).toString('hex');
  }
  throw new Error(`va ${va.toString(16)}`);
}

test('the engine binds clip tracks by bone hash and clears extracted / locked root axes after sampling', { skip }, () => {
  const exe = 'SUFFERING.EXE';
  // Bone -> track table (0x4793b0): for each bone (model +0xe8 bones of 0x90 bytes), the first
  // track whose hash (track +0) equals the bone's hash (bone +0x8c): cmp [edx + 0x8c], eax.
  assert.equal(peBytes(exe, 0x4793c9, 6), '8bb5e8000000');
  assert.equal(peBytes(exe, 0x479445, 4), '8b0085c0');
  assert.equal(peBytes(exe, 0x47944b, 6), '39828c000000');
  // A bone without a track (index -1) gets its bind rotation and translation (node +0x7c).
  assert.equal(peBytes(exe, 0x46a26d, 3), '8b4e7c');
  // Root motion (0x478b90): flag 0x10 / 0x100 (x extracted / locked) zeroes the root matrix's
  // x translation as sampled - key or constant alike: mov dword [edi + 0x30], 0; y +0x34, z +0x38.
  assert.equal(peBytes(exe, 0x478c0a, 2), 'a810');
  assert.equal(peBytes(exe, 0x478c13, 7), 'c7473000000000');
  assert.equal(peBytes(exe, 0x478c26, 7), 'c7473400000000');
  assert.equal(peBytes(exe, 0x478c39, 7), 'c7473800000000');
});

// ---------------------------------------------------------------------------
// Synthetic rig: root -> hips -> spine -> arm, hips -> leg; bind lengths 0.2 up.

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

/** Rotation-only tracks for `bones` with the given constants (identity rotations, 1 s). */
function clip(id: number, constants: Record<number, [number, number, number]>): AnimClipData {
  return {
    id,
    animSet: 0,
    duration: 1,
    flags: 0,
    blendTime: 0.2,
    rate: 1,
    links: [],
    tracks: Object.entries(constants).map(([b, c]) => ({
      boneHash: 0x1000 + Number(b),
      format: 0xc0,
      times: new Float32Array([0, 1]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      constantTranslation: c,
    })),
  };
}

const posTrack = (c: THREE.AnimationClip, bone: number) => c.tracks.find((t) => t.name === `b_${(0x1000 + bone).toString(16).padStart(8, '0')}.position`);

test("every clip build poses rotation-only bones at the track's constant translation", () => {
  const sk = rig();
  // Hips 0.65 back and 0.23 down (a seated pose), arm 0.35 long, leg keeps its bind; spine untracked.
  const c = clip(1, { 0: [0, 0, 0], 1: [0, -0.03, 0.65], 3: [0, 0.35, 0], 4: [0, 0.2, 0] });
  const built = buildAnimationClip(c, sk.skeleton);
  assert.deepEqual([...posTrack(built, 1)!.values], [0, -0.03, 0.65].map((v) => Math.fround(v)));
  assert.deepEqual([...posTrack(built, 3)!.values], [0, 0.35, 0].map((v) => Math.fround(v)));
  assert.equal(posTrack(built, 2), undefined, 'a bone without a track keeps the bind translation');
  // The deviation stays available for comparisons only.
  const bind = buildAnimationClip(c, sk.skeleton, { constantTranslations: 'bind' });
  assert.equal(posTrack(bind, 3), undefined);
  // Scripted clips are the same build: one position track per bone (the hips / attach-point
  // extras are part of the rule now, not added twice).
  const sc = scriptedClip(c, sk);
  const names = sc.tracks.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate tracks');
  assert.deepEqual([...posTrack(sc, 3)!.values], [...posTrack(built, 3)!.values]);
});

test('extracted / locked root axes are cleared on a rotation-only root too; in place keeps it', () => {
  const sk = rig();
  const c = clip(2, { 0: [0.3, 0.4, -0.5], 1: [0, 0.2, 0] });
  const axes = buildAnimationClip(c, sk.skeleton, { rootMotion: { x: 1, y: 0, z: 2, rotation: 0 } });
  assert.deepEqual([...posTrack(axes, 0)!.values], [0, Math.fround(0.4), 0]);
  const inPlace = buildAnimationClip(c, sk.skeleton);
  assert.deepEqual([...posTrack(inPlace, 0)!.values], [0.3, 0.4, -0.5].map((v) => Math.fround(v)), 'no motion to strip in a constant');
});

test('the mixer, layers and gait blends carry the constants', () => {
  const sk = rig();
  const a = clip(3, { 1: [0, 0.2, 0], 2: [0, 0.2, 0], 3: [0, 0.5, 0] });
  const b = clip(4, { 1: [0, 0.2, 0], 2: [0, 0.2, 0], 3: [0, 0.3, 0] });
  const ch = new Character(sk, [a, b]);
  ch.play(0, { fade: 0 });
  ch.update(0.01);
  assert.ok(Math.abs(ch.skeleton.bones[3].position.y - 0.5) < 1e-6, 'whole-body clip');
  ch.playLayer(2, 1, { blend: 0 });
  ch.update(0.01);
  assert.ok(Math.abs(ch.skeleton.bones[3].position.y - 0.3) < 1e-4, `layer on the spine subtree (${ch.skeleton.bones[3].position.y})`);
  ch.dispose();
  const cyc = blendCycle('cyc', { clip: buildAnimationClip(a, sk.skeleton), phase: 0, rate: 1, speed: 1 }, { clip: buildAnimationClip(b, sk.skeleton), phase: 0, rate: 1, speed: 1 }, 0.5, sk.skeleton, 4);
  assert.ok(Math.abs(posTrack(cyc.clip, 3)!.values[1] - 0.4) < 1e-6, 'a blended gait cycle lerps the constants');
});

// ---------------------------------------------------------------------------
// Retail data

let pkgCache: PackageSet | undefined;
async function packages(): Promise<PackageSet> {
  const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  return (pkgCache ??= await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(readSrsc(L1A)).dependencies, () => {}));
}

/** Model-space position of a bone (by hash) of a Character posed by its clip 0 at time t. */
function posed(sk: SkinnedModel, data: AnimClipData, hash: number, t = 0): THREE.Vector3 {
  const ch = new Character(sk, [data]);
  const a = ch.play(0, { fade: 0, loop: false })!;
  a.time = t;
  ch.update(0);
  ch.mesh.updateMatrixWorld(true);
  const p = new THREE.Vector3().setFromMatrixPosition(ch.skeleton.bones[sk.skeleton.byHash.get(hash)!].matrixWorld);
  ch.dispose();
  return p;
}

test("Torque's third-person knockdown lies on the floor: the hips at the clip's body offset", { skip }, async () => {
  const pkgs = await packages();
  const torque = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!;
  const knock = loadClip(pkgs, { pkg: 2, id: 129 })!; // Hit Reaction 2:334 knockdown pose
  const HIPS = 0xcf418bd0, HEAD = 0x07c159a2;
  const bindY = torque.skeleton.bones[torque.skeleton.byHash.get(HIPS)!].bindWorld[13];
  assert.ok(bindY > 1.1, `bind hips ${bindY}`);
  const hips = posed(torque, knock, HIPS), head = posed(torque, knock, HEAD);
  assert.ok(hips.y < 0.3 && head.y < 0.8, `hips ${hips.y.toFixed(2)} / head ${head.y.toFixed(2)} near the floor`);
  // The Character pose is the engine's: the audit tool's sampler agrees bone for bone.
  const ref = posePositions(torque, knock, 0, 'animation');
  assert.ok(ref[torque.skeleton.byHash.get(HEAD)!].distanceTo(head) < 1e-3);
});

test("the insanity creature's morph clip starts at the human lengths (clips pose any rig with their own)", { skip }, async () => {
  const pkgs = await packages();
  const creature = readSkinnedModel(pkgs, { pkg: 2, id: 124 })!;
  const morph = loadClip(pkgs, { pkg: 2, id: 163 })!;
  const FOREARM = 0x22e5591b; // left forearm (bone 12): bind 0.55, the clip's constant 0.32
  const bi = creature.skeleton.byHash.get(FOREARM)!;
  const tr = morph.tracks.find((t) => t.boneHash === FOREARM)!;
  assert.equal(tr.format, 0xc0);
  assert.ok(Math.hypot(...creature.skeleton.bones[bi].position) > 0.5 && Math.hypot(...tr.constantTranslation) < 0.35);
  const ch = new Character(creature, [morph]);
  ch.play(0, { fade: 0, loop: false });
  ch.update(0);
  assert.ok(Math.abs(ch.skeleton.bones[bi].position.length() - Math.hypot(...tr.constantTranslation)) < 1e-4);
  ch.dispose();
});

test('the joint height range of a kind (ceiling grabs, culling) is posed with the constants', { skip }, async () => {
  const pkgs = await packages();
  const torque = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!;
  const knock = loadClip(pkgs, { pkg: 2, id: 129 })!;
  const idle = loadClip(pkgs, { pkg: 2, id: 27 })!;
  const kind = { skinned: torque, proto: { clipData: [knock, idle] } } as unknown as CreatureKind;
  const lib = new KindLibrary(pkgs);
  const lying = lib.jointRange(kind, 0), standing = lib.jointRange(kind, 1);
  assert.ok(standing.maxY > 1.6, `standing: highest joint ${standing.maxY.toFixed(2)}`);
  assert.ok(lying.maxY < 1.1, `lying (a leg up): highest joint ${lying.maxY.toFixed(2)}`);
});
