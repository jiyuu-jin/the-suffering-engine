// Skinned sequence props drawn with every pass of a Layered material (src/app/character.ts
// characterLayeredSurface): 1a's booth door that the CartWheeler tears off in "CartWheeler" #223
// (STOMP Player 5db4), docs/game-logic.md §11.4 "Torn-off doors", docs/playthrough.md bug 75.
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Blend, type PackageSet, type SurfaceMaterial } from '../src/formats/model';
import { Character, characterLayeredSurface, characterSurfaceBlend, decodeCharacterTextures } from '../src/app/character';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { SrscFile } from '../src/formats/srsc';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readSkinnedModel } from '../src/formats/skeleton';
import { readAnimation, sampleTrackRotation, sampleTrackTranslation } from '../src/formats/animation';
import { parseStompSequence, sampleTrack } from '../src/game/world/stomp';
import { instanceMatrix } from '../src/game/world/dynamic';
import { readModel } from '../src/formats/model';
import { nodeFS, skip } from './helpers';

const mat = (layers: SurfaceMaterial['layers']): SurfaceMaterial => ({ key: 't:1', layers }) as SurfaceMaterial;

test('Layered lit materials take the surface material on skinned models; single passes and effects do not', () => {
  // Reflection base (texGen 4) + mode-7 diffuse + modulate-2x detail (the prison doors' 7:764).
  const door = mat([
    { texture: '7:257', blend: Blend.Opaque, texGen: 4 },
    { texture: '7:256', blend: Blend.AddOverAlpha },
    { texture: '7:734', blend: Blend.Modulate2x, tint: 0xffffff },
  ]);
  assert.equal(characterLayeredSurface(door), true);
  assert.equal(characterSurfaceBlend(door), false);
  // One opaque pass: the plain lit skin.
  assert.equal(characterLayeredSurface(mat([{ texture: '2:1', blend: Blend.Opaque }])), false);
  // Effects (additive / tinted base) stay on the effect path.
  assert.equal(characterLayeredSurface(mat([{ texture: '10:1', blend: Blend.Add }, { texture: '10:2', blend: Blend.Add }])), false);
  assert.equal(characterLayeredSurface(mat([{ texture: '10:1', blend: Blend.Opaque, tint: 0x414141 }, { texture: '10:2', blend: Blend.Add }])), false);
  // Layers without a texture do not count.
  assert.equal(characterLayeredSurface(mat([{ texture: '2:1', blend: Blend.Opaque }, { blend: Blend.Alpha }])), false);
  assert.equal(characterLayeredSurface(undefined), false);
});

async function level1a() {
  const fs = nodeFS();
  const lvl = new SrscFile(await fs.read('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'));
  const pkgs = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, () => {});
  return { pkgs, ents: parseEntities(lvl, pkgs as unknown as EntityPackageSet) };
}

const box = (pos: ArrayLike<number>, m: THREE.Matrix4) => {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) b.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m));
  return b;
};
const near = (a: THREE.Box3, b: THREE.Box3, tol: number, what: string) => {
  for (const k of ['min', 'max'] as const) for (const ax of ['x', 'y', 'z'] as const) assert.ok(Math.abs(a[k][ax] - b[k][ax]) < tol, `${what} ${k}.${ax}: ${a[k][ax].toFixed(3)} vs ${b[k][ax].toFixed(3)}`);
};

test('1a booth door (#223): the torn door is the door model\'s own clip, from the real door to the thrown one', { skip }, async () => {
  const { pkgs, ents } = await level1a();
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  const p = pkgs as unknown as PackageSet & Map<number, { qdu?: SrscFile; adu?: SrscFile }>;
  const seq = parseStompSequence((pkgs.get(12) as { qdu: SrscFile }).qdu, 223)!;
  const track = (uid: number) => seq.tracks.find((t) => t.uid === uid)!;
  const door = byUid.get(0x68a8)!, real = byUid.get(0x512a)!;
  // No attach key: the door is not carried by a bone; its own two-bone rig plays clip 9:43.
  assert.equal(seq.tracks.reduce((n, t) => n + t.attaches.length, 0), 0);
  const dt = track(0x68a8);
  assert.deepEqual(dt.anims.map((k) => [k.time, k.clip.pkg, k.clip.id, k.flags]), [[0, 9, 43, 0]]);
  const sm = readSkinnedModel(p, door.modelRef!)!;
  assert.equal(sm.skeleton.bones.length, 2);
  const clip = readAnimation(p.get(9)!.adu!, 43)!;
  const b0 = sm.skeleton.bones[0], b1 = sm.skeleton.bones[1];
  const at = (t: number) => {
    const k = sampleTrack(dt, Math.min(t, 5.52))!;
    const R = new THREE.Matrix4().compose(new THREE.Vector3(...k.position.map((v) => v / 2048) as [number, number, number]), new THREE.Quaternion(...k.quat), new THREE.Vector3(1, 1, 1));
    const B0 = new THREE.Matrix4().compose(new THREE.Vector3(...b0.position), new THREE.Quaternion(...b0.quaternion), new THREE.Vector3(1, 1, 1));
    const B1 = new THREE.Matrix4().compose(new THREE.Vector3(...sampleTrackTranslation(clip, t, b1.hash)), new THREE.Quaternion(...sampleTrackRotation(clip, t, b1.hash)), new THREE.Vector3(1, 1, 1));
    return box(sm.model.positions, R.multiply(B0).multiply(B1).multiply(new THREE.Matrix4().fromArray(b1.inverseBind)));
  };
  const realModel = readModel(p, real.modelRef!)!;
  // At 0 s the animated door stands exactly where the real door (Switch 512a, destroyed and
  // hidden by the same sequence at 0 s) stood.
  near(at(0), box(realModel.positions, instanceMatrix(real.position, real.rotation)), 0.03, 'start');
  // From 3.5 s it lies where StaticDoor 693c (the same door model) is keyed at 5.53 s.
  const sk = sampleTrack(track(0x693c), 5.54)!;
  const sdM = new THREE.Matrix4().compose(new THREE.Vector3(...sk.position.map((v) => v / 2048) as [number, number, number]), new THREE.Quaternion(...sk.quat), new THREE.Vector3(1, 1, 1));
  near(at(3.5), box(realModel.positions, sdM), 0.12, 'end');
  // Drawn: its slab's material is Layered (reflection + mode-7 diffuse + detail), so the
  // surface material draws it with no alpha test; the fallback texture's alpha (the reflection
  // mask) cut it to a few strips before.
  const ch = new Character(sm, [], decodeCharacterTextures(sm, p));
  const slab = sm.model.submeshes.findIndex((s) => characterLayeredSurface(s.material));
  assert.ok(slab >= 0);
  const m = (ch.mesh.material as THREE.Material[])[slab];
  assert.equal(m.name, sm.model.submeshes[slab].material!.key);
  assert.equal(m.alphaTest, 0);
  assert.equal(m.transparent, false);
  ch.dispose();
});
