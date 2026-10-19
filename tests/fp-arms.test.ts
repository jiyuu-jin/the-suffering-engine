// First-person arms placement (src/game/actors/player-body.ts; docs/game-logic.md §4.5,
// docs/re/player.md §7): the decoded rules of the original and the port's picture.
//   - the camera: Player p106..p108 offset, turned by the spine share of the pitch around bone
//     p109 and by the rest around bone p112 (Suffering.rfl 0x10042ef0, state 16 per-frame);
//   - the pose: rotation-only (0xc0) tracks carry a constant translation the engine's sampler
//     uses (SUFFERING.EXE 0x46a180 / 0x46a290); the first-person sets move the collar bones with
//     it, which keeps the shoulders' open mesh ends out of the picture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as THREE from 'three/webgpu';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { PlayerController, type PlayerFrame } from '../src/app/player';
import { Character } from '../src/app/character';
import { readSkinnedModel } from '../src/formats/skeleton';
import { TRACK_ROTATION } from '../src/formats/animation';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet } from '../src/formats/entities';
import type { PackageSet, ResRef } from '../src/formats/model';
import { loadClip } from '../src/game/actors/clipmap';
import { PlayerBody, clipBonePosition, dropHelperVolumes, fpCameraInModel } from '../src/game/actors/player-body';
import { DATA_ROOT, nodeFS, readSrsc, skip } from './helpers';

const g = globalThis as unknown as { document?: unknown; window?: unknown };
const events = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null };
g.document ??= events;
g.window ??= events;

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
function peFloat(file: string, va: number): number {
  return Buffer.from(peBytes(file, va, 4), 'hex').readFloatLE(0);
}

test('the original first-person camera: p106..p108 offset, spine p109 then shoulder p112 pivots', { skip }, () => {
  const rfl = 'Suffering.rfl';
  // Offset: p108 (0x6c), p107 (0x6b), p106 (0x6a) read, each scaled by 2048 (0x1014b6e8).
  assert.equal(peBytes(rfl, 0x1004301f, 4), '6aff6a6c');
  assert.equal(peBytes(rfl, 0x10043055, 4), '6aff6a6a');
  assert.equal(peBytes(rfl, 0x1004306e, 6), 'd80de8b61410');
  assert.equal(peFloat(rfl, 0x1014b6e8), 2048);
  // First turn: the posed bone p109 (0x6d) is the pivot, the angle is +0x5a2 (the spine's share)
  // times -pi / 180 (0x1014b6e4).
  assert.equal(peBytes(rfl, 0x100432a5, 4), '6aff6a6d');
  assert.equal(peBytes(rfl, 0x10043308, 12), 'd985a2050000d80de4b61410');
  assert.ok(Math.abs(peFloat(rfl, 0x1014b6e4) + Math.PI / 180) < 1e-9);
  // Second turn: around bone p112 (0x70) by (+0x5a2 - +0x59a) * pi / 180 (0x1014b6ec): the rest
  // of the pitch, so the camera's total turn is the full view pitch.
  assert.equal(peBytes(rfl, 0x10043335, 4), '6aff6a70');
  assert.equal(peBytes(rfl, 0x1004335f, 6), 'd985a2050000');
  assert.equal(peBytes(rfl, 0x1004337a, 6), 'd80decb61410');
  assert.ok(Math.abs(peFloat(rfl, 0x1014b6ec) - Math.PI / 180) < 1e-9);
});

test("the engine's clip sampler uses a rotation-only track's constant translation", { skip }, () => {
  const exe = 'SUFFERING.EXE';
  // Single key: cmp ax, 0xc000; jne; ...; fld [edx + 0xc] (the track's constant translation).
  assert.equal(peBytes(exe, 0x46a3a5, 4), '663d00c0');
  assert.equal(peBytes(exe, 0x46a3ae, 3), 'd9420c');
  // Interpolated: cmp cx, 0xc000; jne; fld [edx + 0xc].
  assert.equal(peBytes(exe, 0x46a1b9, 10), '6681f900c0751bd9420c');
  // Any other track: the bone's bind translation (node +0x7c).
  assert.equal(peBytes(exe, 0x46a1db, 7), '8b4c241c8b517c');
  // Load: every track's constant is scaled by 2048 like the key translations (0x4737d0).
  assert.equal(peBytes(exe, 0x4737d0, 3), 'd946f8');
});

let pkgCache: PackageSet | undefined;
async function packages(): Promise<PackageSet> {
  const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  return (pkgCache ??= await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(readSrsc(L1A)).dependencies, () => {}));
}

test('Player p106..p112 and the first-person sets move the collar bones', { skip }, async () => {
  const pkgs = await packages();
  const epk = pkgs as unknown as EntityPackageSet;
  const t = readObjectTemplate(epk, { pkg: 2, id: 5 })!;
  const v = decodeTemplateProps(classByHash(t.classHash), t);
  assert.deepEqual([v[106], +(v[107] as number).toFixed(3), +(v[108] as number).toFixed(3)], [0, 1.85, -0.44]);
  assert.deepEqual([v[109], v[110], v[111], v[112]], [5, 48, 9, 29]);
  assert.equal(v[117], 50, 'p117: the flashlight hangs on chest bone 50, not in a hand');
  const arms = readSkinnedModel(pkgs, (v[227] as ResRef)!)!;
  const collar = 28; // right collar (parent of shoulder p112 = 29)
  // Revolver hold 2:270: bone 28 is a 0xc0 track whose constant differs from the bind.
  const clip = loadClip(pkgs, { pkg: 2, id: 270 })!;
  const tr = clip.tracks.find((x) => arms.skeleton.byHash.get(x.boneHash >>> 0) === collar)!;
  assert.equal(tr.format, TRACK_ROTATION);
  const bind = arms.skeleton.bones[collar].position;
  assert.ok(Math.hypot(tr.constantTranslation[0] - bind[0], tr.constantTranslation[1] - bind[1], tr.constantTranslation[2] - bind[2]) > 0.5, 'the clip moves the collar bone');
});

test('clipBonePosition matches the posed arms (constant translations on)', { skip }, async () => {
  const pkgs = await packages();
  const arms = dropHelperVolumes(readSkinnedModel(pkgs, { pkg: 2, id: 138 })!);
  for (const id of [217, 270, 305, 450, 484, 232]) {
    const clip = loadClip(pkgs, { pkg: 2, id })!;
    const ch = new Character(arms, [clip], new Map(), { constantTranslations: 'animation' });
    ch.play(0, { loop: true, fade: 0 });
    ch.update(0);
    ch.mesh.updateMatrixWorld(true);
    for (const bone of [9, 29, 34, 48]) {
      const posed = new THREE.Vector3().setFromMatrixPosition(ch.skeleton.bones[bone].matrixWorld);
      const p = clipBonePosition(clip, arms.skeleton, bone);
      assert.ok(p.distanceTo(posed) < 1e-3, `2:${id} bone ${bone}: ${p.toArray()} vs ${posed.toArray()}`);
    }
  }
});

test('fpCameraInModel: the eye at level, the full pitch, rigid with the p112 shoulder', () => {
  const eye = new THREE.Vector3(0, 1.85, 0.44);
  const spine = new THREE.Vector3(0, 1.38, -0.04), shoulder = new THREE.Vector3(0.26, 1.71, 0.56);
  assert.deepEqual(fpCameraInModel(eye, 0, 0, spine, shoulder).elements.map((x) => +x.toFixed(6)), new THREE.Matrix4().makeTranslation(0, 1.85, 0.44).elements);
  const D = Math.PI / 180;
  const hand0 = new THREE.Vector3(0.18, 1.65, -0.11);
  // A point of the right arm (bent like bone p112: spine share around the spine, the rest around
  // the shoulder) keeps its place in the camera's frame at any pitch.
  const inCam0 = hand0.clone().applyMatrix4(fpCameraInModel(eye, 0, 0, spine, shoulder).invert());
  for (const pitchDeg of [-65, -30, 20, 45, 75]) {
    const pitch = pitchDeg * D, a = pitch / 2;
    const X = new THREE.Vector3(1, 0, 0);
    const sh = shoulder.clone().sub(spine).applyAxisAngle(X, -a).add(spine);
    const bent = hand0.clone().sub(spine).applyAxisAngle(X, -a).add(spine).sub(sh).applyAxisAngle(X, -(pitch - a)).add(sh);
    const cam = fpCameraInModel(eye, pitch, a, spine, shoulder);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam);
    assert.ok(Math.abs(fwd.y + Math.sin(pitch)) < 1e-6, `${pitchDeg}: the camera looks ${pitchDeg} deg down`);
    const inCam = bent.applyMatrix4(cam.clone().invert());
    assert.ok(inCam.distanceTo(inCam0) < 1e-6, `${pitchDeg}: the right hand stays put in the view`);
  }
});

/** Open (boundary) edge vertices of the arms mesh, welded by bind position. */
function openVertices(mesh: THREE.SkinnedMesh): number[] {
  const P = mesh.geometry.attributes.position, idx = mesh.geometry.index!.array;
  const weld = new Map<string, number>(), wid = new Int32Array(P.count);
  for (let i = 0; i < P.count; i++) {
    const k = `${P.getX(i).toFixed(4)},${P.getY(i).toFixed(4)},${P.getZ(i).toFixed(4)}`;
    if (!weld.has(k)) weld.set(k, i);
    wid[i] = weld.get(k)!;
  }
  const edges = new Map<string, number>();
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const u = wid[idx[t + e]], w = wid[idx[t + ((e + 1) % 3)]];
      const k = u < w ? `${u},${w}` : `${w},${u}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  const out = new Set<number>();
  for (const [k, n] of edges) if (n === 1) for (const x of k.split(',')) out.add(Number(x));
  return [...out];
}

test('first person: no open end of the arms mesh on screen, hands in view, any pitch', { skip }, async () => {
  const pkgs = await packages();
  const p = new PlayerController(new THREE.PerspectiveCamera(), events as unknown as HTMLElement);
  const body = PlayerBody.create(p, new THREE.Scene(), pkgs, undefined, new THREE.Group())!;
  assert.ok(body?.arms);
  p.enabled = true;
  p.mode = 'fp';
  const mesh = body.arms!.mesh;
  const open = openVertices(mesh);
  assert.equal(open.length, 22, 'two 11-vertex cuts at the shoulders');
  const frame = (speed: number): PlayerFrame => ({ dt: 1 / 30, mode: 'fp', speed, localVelocity: { x: 0, z: speed }, verticalSpeed: 0, onGround: true, crouched: false, running: false, jumped: false, landed: false });
  const emit = (f: PlayerFrame) => {
    for (const fn of (p as unknown as { listeners: ((f: PlayerFrame) => void)[] }).listeners) fn(f);
  };
  // The engine lens on a 16:9 screen: 67.2 deg horizontal (the 4:3 one), 41 deg vertical.
  const tx = Math.tan((53 * Math.PI) / 360) * (4 / 3), ty = tx / (16 / 9);
  const D = Math.PI / 180;
  const sets: [string, ResRef | null, number[]][] = [
    ['unarmed', null, []],
    ['shiv', { pkg: 2, id: 303 }, [34]],
    ['revolver', { pkg: 2, id: 436 }, [14, 34]],
    ['dual', { pkg: 2, id: 111 }, [14, 34]],
    ['shotgun', { pkg: 2, id: 244 }, [14]],
    ['tommy', { pkg: 2, id: 475 }, [14, 34]],
  ];
  const v = new THREE.Vector3(), inv = new THREE.Matrix4();
  const inFrame = (x: THREE.Vector3, h: number) => x.z < -0.0156 && Math.abs(x.x / -x.z) <= tx && Math.abs(x.y / -x.z) <= h;
  // Open ends: none in the port's usual 16:9 picture. Hands (wrist bones): inside the original's
  // 4:3 picture (the dual revolvers' wrists sit just below a 16:9 frame, the guns above it).
  // At exactly 4:3 the shiv's right upper-arm cut touches the bottom-right corner (3 vertices).
  const onScreen = (x: THREE.Vector3) => inFrame(x, ty);
  const inView43 = (x: THREE.Vector3) => inFrame(x, tx * 0.75 * 1.1); // wrist bone: the hand reaches past it
  for (const [name, pwp, hands] of sets) {
    if (pwp) body.setStance({}, pwp, pwp);
    else body.setStance(null, null);
    for (const speed of [0, 3]) {
      for (const pitchDeg of [-65, -30, 0, 30, 60, 75]) {
        p.pitch = pitchDeg * D;
        for (let i = 0; i < 12; i++) emit(frame(speed));
        body.armsPivot.updateMatrixWorld(true);
        inv.copy(body.armsPivot.matrixWorld).invert();
        const at = `${name} ${speed ? 'walking' : 'standing'} pitch ${pitchDeg}`;
        const shown = open.filter((i) => onScreen(mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv)));
        assert.equal(shown.length, 0, `${at}: ${shown.length} open-end vertices on screen`);
        for (const h of hands) {
          const hp = v.setFromMatrixPosition(body.arms!.skeleton.bones[h].matrixWorld).applyMatrix4(inv);
          assert.ok(inView43(hp), `${at}: hand bone ${h} in view (${hp.toArray().map((x) => x.toFixed(2))})`);
        }
      }
    }
  }
});
