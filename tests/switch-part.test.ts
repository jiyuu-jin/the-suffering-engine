// A Switch's p37 part (src/game/world/switch-part.ts, docs/game-logic.md §11.1 "Moving part"):
// the switch wears the p37 template's model and moves it; its own model stays put as a base that
// takes the p32 / p33 state colours. The basement breaker levers (7:12 / 7:13 / 7:1420, base
// 7:557 / 7:492, lever 7:556) used to tumble whole, box and all, and the lever was never drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFS, readSrsc, skip } from './helpers';
import { switchBaseMaterials, switchBaseSwaps, switchPart } from '../src/game/world/switch-part';

const LEVELS = {
  '1a': 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl',
  '1b': 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl',
  '3b': 'LEVELS/3 YardCellBlock/3b YardCellBlock.lvl',
  '4b': 'LEVELS/4 Quarry/4b Quarry.lvl',
  '8b': 'LEVELS/8 Bluff/8b Bluff.lvl',
} as const;

async function level(path: string) {
  const { loadPackages } = await import('../src/app/loader');
  const { readLevelHeader } = await import('../src/formats/level');
  const { parseEntities } = await import('../src/formats/entities');
  const { dirname } = await import('../src/app/gamefs');
  const lvl = readSrsc(path);
  const pkgs = await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {});
  return { lvl, pkgs, ents: parseEntities(lvl, pkgs) };
}

const key = (r: { pkg: number; id: number } | undefined) => (r ? `${r.pkg}:${r.id}` : '-');

test('base materials: p32 open, p33 closed, only when the list covers the model table', () => {
  const v: unknown[] = [];
  v[32] = [{ pkg: 7, id: 1417 }, { pkg: 7, id: 1730 }, { pkg: 7, id: 1418 }];
  v[33] = [{ pkg: 7, id: 1729 }, { pkg: 7, id: 1419 }, { pkg: 7, id: 1418 }];
  assert.deepEqual(switchBaseMaterials(v, true, 3)?.map((r) => key(r ?? undefined)), ['7:1417', '7:1730', '7:1418']);
  assert.deepEqual(switchBaseMaterials(v, false, 3)?.map((r) => key(r ?? undefined)), ['7:1729', '7:1419', '7:1418']);
  // 0x101308a0 writes the table only when the list is as long as the model's.
  assert.equal(switchBaseMaterials(v, true, 2), undefined);
  assert.equal(switchBaseSwaps(v), true);
  assert.equal(switchBaseSwaps([]), false);
});

test('retail p37 parts: the switch moves the part, not its base', { skip }, async () => {
  // [level, switch uid, base model, part model]: the 1b basement breaker lever, the 1a door
  // lever (opens 4ed8) and chair switch, the 3b basement breaker, the 4b plunger (slides).
  const cases: [keyof typeof LEVELS, number, string, string][] = [
    ['1b', 0x66bf, '7:557', '7:556'],
    ['1b', 0x7b5b, '7:557', '7:556'],
    ['1a', 0x5e1d, '7:2', '7:3'],
    ['1a', 0x8588, '12:603', '7:3'],
    ['1a', 0x74f9, '7:4', '7:5'],
    ['3b', 0x2177, '7:557', '7:556'],
    ['4b', 0x7507, '7:60', '7:109'],
  ];
  const byLevel = new Map<string, Awaited<ReturnType<typeof level>>>();
  for (const [l, uid, base, part] of cases) {
    if (!byLevel.has(l)) byLevel.set(l, await level(LEVELS[l]));
    const { pkgs, ents } = byLevel.get(l)!;
    const e = ents.find((x) => x.uid === uid)!;
    assert.ok(e, `${l} ${uid.toString(16)}`);
    assert.equal(key(e.modelRef), base, `${l} ${uid.toString(16)} base`);
    const p = switchPart(e, pkgs);
    assert.equal(p?.cls, 'Breakable', `${l} ${uid.toString(16)} part class`);
    assert.equal(key(p?.model), part, `${l} ${uid.toString(16)} part model`);
  }
  // No other class has a p37 part: Mechanisms (p42, no swap; none set in retail) move their own
  // model, e.g. 8b's valve wheel 2728 (7:1287).
  const { pkgs, ents } = byLevel.get('8b') ?? (await level(LEVELS['8b']));
  const valve = ents.find((x) => x.uid === 0x2728)!;
  assert.equal(valve.className, 'Mechanism');
  assert.equal(switchPart(valve, pkgs), undefined);
});

test('dynamic objects: the lever turns about the switch origin, the box stays and changes colours', { skip }, async () => {
  const THREE = await import('three/webgpu');
  const { DynamicObjects, dynamicObjectUids } = await import('../src/game/world/dynamic');
  const { lvl, pkgs, ents } = await level(LEVELS['1b']);
  const dyn = new DynamicObjects(pkgs, null, undefined);
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  const uids = dynamicObjectUids(lvl, pkgs);
  assert.ok(uids.has(0x66bf));
  dyn.build(lvl, byUid, [0x66bf]);
  const d = dyn.objects.get(0x66bf)!;
  assert.equal(key(d.model?.ref), '7:556', 'the switch draws the lever');
  assert.ok(d.stand, 'the base is built');
  assert.equal(key(d.stand!.model?.ref), '7:557', 'the base draws the breaker box');
  assert.equal(dyn.objects.get(d.stand!.uid), d.stand, 'the base is an object of its own');
  assert.ok(d.stand!.collides && d.collides, 'both collide');

  const box = (o: typeof d) => dyn.bounds(o, new THREE.Box3());
  const base0 = box(d.stand!), lever0 = box(d);
  // Open pose: p55 0 rotate, p56 0 (x), p57 180 at p58 -180: -180 deg about the switch's x.
  d.pivot.matrix.makeRotationX(-Math.PI);
  d.pivot.matrixWorldNeedsUpdate = true;
  const base1 = box(d.stand!), lever1 = box(d);
  assert.ok(base1.min.distanceTo(base0.min) < 1e-6 && base1.max.distanceTo(base0.max) < 1e-6, 'the box does not move');
  // The lever (7:556: 0 .. 0.68 up from the pivot) points down once open.
  const y = d.root.matrix.elements[13];
  assert.ok(lever0.max.y > y + 0.5 && lever0.min.y > y - 0.1, `lever up when closed (${lever0.min.y - y} .. ${lever0.max.y - y})`);
  assert.ok(lever1.min.y < y - 0.5 && lever1.max.y < y + 0.1, `lever down when open (${lever1.min.y - y} .. ${lever1.max.y - y})`);

  // State colours on the base: p32 open swaps the two lamps (7:1729 / 7:1419 -> 7:1417 / 7:1730).
  const e = byUid.get(0x66bf)!;
  const mats = () =>
    d.stand!.pivot.children
      .map((m) => [(m as THREE.Mesh).userData.matIndex as number, ((m as THREE.Mesh).material as THREE.Material).name] as const)
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1]);
  const closed = mats();
  dyn.setMaterials(d.stand!.uid, switchBaseMaterials(e.values, true, d.stand!.model!.materials.length));
  const open = mats();
  assert.notDeepEqual(open, closed, 'the open table differs');
  dyn.setMaterials(d.stand!.uid, switchBaseMaterials(e.values, false, d.stand!.model!.materials.length));
  assert.deepEqual(mats(), closed, 'closed again: the model own table');
  dyn.dispose();
});
