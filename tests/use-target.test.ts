// The Use target as the original chooses it (docs/game-logic.md §14.5 "Use target"): a Switch
// is usable only from where its Interaction Properties fit (use-anim.ts switchFit, Suffering.rfl
// 0x100bb4e0: reach / height to the anchor, facing, side bearing), and pickups never compete
// with usables. The 1a office case: the open door 561b was offered instead of the flashlight
// 6978 the player looked at (docs/playthrough.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { approachOf, readInteractionProps, refList, switchFit, type InteractionProps } from '../src/game/world/use-anim';
import { instanceMatrix } from '../src/game/world/dynamic';
import { nodeFS, readSrsc, skip } from './helpers';

const ip = (v: unknown[]): InteractionProps => ({ ref: { pkg: 0, id: 0 }, cls: 'Switch Interaction Properties', values: v as never, fromPlacement: v[0] === 1, faceSide: null, offset: [0, 0, 0], yaw: 0, align: 0.2 });
// Door template 2:391's fit fields: reach 2, height 1.75, side 0 (+x), bearing -90..90, facing 75, anchor (0.1, 1.2, -2).
const DOOR = ip([0, 2, 1.75, 0, -90, 90, 75, 0.1, 1.2, -2]);
const I = new THREE.Matrix4();
const fwd = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const towards = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

test('switch fit: reach, height and facing to the anchor', () => {
  const anchor = { x: 0.1, z: -2 };
  const at = (x: number, z: number, y = 0) => ({ x, y, z });
  // 1.5 m in front (+x side), facing the anchor.
  const p = at(1.6, -2);
  assert.ok(switchFit(DOOR, I, I, p, fwd(towards(p, anchor))));
  // Facing away.
  assert.ok(!switchFit(DOOR, I, I, p, fwd(towards(p, anchor) + Math.PI)));
  // 76 degrees off: out; 74: in.
  assert.ok(!switchFit(DOOR, I, I, p, fwd(towards(p, anchor) + (76 * Math.PI) / 180)));
  assert.ok(switchFit(DOOR, I, I, p, fwd(towards(p, anchor) + (74 * Math.PI) / 180)));
  // 2.1 m away: out of reach (2 m, equality passes).
  const far = at(2.2, -2);
  assert.ok(!switchFit(DOOR, I, I, far, fwd(towards(far, anchor))));
  const edge = at(2.1, -2);
  assert.ok(switchFit(DOOR, I, I, edge, fwd(towards(edge, anchor))));
  // Feet 1.8 m below the anchor's height (1.2): out.
  assert.ok(!switchFit(DOOR, I, I, at(1.6, -2, -0.6), fwd(towards(p, anchor))));
});

test('switch fit: the side bearing (p3 / p4..p5, wrapping ranges)', () => {
  const anchor = { x: 0.1, z: -2 };
  // Behind the door (-x side): the +x template does not fit.
  const back = { x: -1.4, y: 0, z: -2 };
  assert.ok(!switchFit(DOOR, I, I, back, fwd(towards(back, anchor))));
  const BACK = ip([0, 2, 1.75, 2, -90, 90, 75, 0.1, 1.2, -2]);
  assert.ok(switchFit(BACK, I, I, back, fwd(towards(back, anchor))));
  // 0..90 only (2:860): one quarter. Counter-clockwise from the normal.
  const Q = ip([0, 2, 1.75, 0, 0, 90, 90, 0, 0, 0]);
  const a = { x: 1, y: 0, z: -1 }, b = { x: 1, y: 0, z: 1 };
  const fa = switchFit(Q, I, I, a, fwd(towards(a, { x: 0, z: 0 })));
  const fb = switchFit(Q, I, I, b, fwd(towards(b, { x: 0, z: 0 })));
  assert.notEqual(fa, fb, 'one side of the normal only');
});

test('switch fit: the anchor turns with a swinging door', () => {
  // Swung 90 degrees about its origin: the anchor (0.1, 1.2, -2) moves to (2, 1.2, 0.1) and the
  // side normal (+x, current transform for p0 = 0) to +z.
  const swung = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  const anchor = { x: 2, z: 0.1 };
  const front = { x: 2, y: 0, z: 1.4 };
  assert.ok(switchFit(DOOR, I, swung, front, fwd(towards(front, anchor))));
  assert.ok(!switchFit(DOOR, I, I, front, fwd(towards(front, anchor))), 'closed, the same spot is out of reach');
  const before = { x: 1.6, y: 0, z: -2 };
  assert.ok(!switchFit(DOOR, I, swung, before, fwd(towards(before, { x: 0.1, z: -2 }))));
});

test('1a office: the door 561b does not fit from where the flashlight 6978 is taken', { skip }, async () => {
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  console.warn = warn;
  const ents = parseEntities(lvl, packages);
  const door = ents.find((e) => e.uid === 0x561b)!;
  const lamp = ents.find((e) => e.uid === 0x6978)!;
  const list = refList(door.values[30]).map((r) => readInteractionProps(packages, r)!);
  assert.deepEqual(list.map((t) => `${t.ref.pkg}:${t.ref.id}`), ['2:391', '2:389']);
  const M = instanceMatrix(door.position, door.rotation);
  const fits = (feet: THREE.Vector3Like, yaw: number, cur = M) => list.some((t) => switchFit(t, M, cur, feet, fwd(yaw)));
  // Every template fits from its own approach point facing the way the use clip starts.
  for (const t of list) {
    const a = approachOf(t, M);
    assert.ok(switchFit(t, M, M, a.feet, fwd(a.yaw)), `${t.ref.id} from its approach`);
  }
  // Taking the flashlight: 1 to 2 m from it, looking at it, from every side; the door is closed
  // or open 95 degrees (angleA) about its origin.
  const L = new THREE.Vector3(lamp.position[0], lamp.position[1], lamp.position[2]).multiplyScalar(1 / 2048);
  const open = M.clone().multiply(new THREE.Matrix4().makeRotationY((95 * Math.PI) / 180));
  const openOther = M.clone().multiply(new THREE.Matrix4().makeRotationY((-95 * Math.PI) / 180));
  const floor = M.elements[13];
  let n = 0;
  for (let k = 0; k < 16; k++)
    for (const r of [1, 1.5, 2]) {
      const a = (k / 16) * Math.PI * 2;
      const feet = { x: L.x + Math.cos(a) * r, y: floor, z: L.z + Math.sin(a) * r };
      const yaw = towards(feet, L);
      for (const cur of [M, open, openOther]) {
        n++;
        assert.ok(!fits(feet, yaw, cur), `door offered from (${feet.x.toFixed(1)}, ${feet.z.toFixed(1)}) looking at the flashlight`);
      }
    }
  assert.equal(n, 144);
});
