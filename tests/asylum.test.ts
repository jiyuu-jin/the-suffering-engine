// Chapter 5 (5a / 5b Asylum) rules found by the playthrough (docs/playthrough.md "5 Asylum"):
// rotated Clamber Points, see-through (blend 7) surfaces that collide, pushables touching
// Detectors by their shape, KilljoyRoot / RaiseDead, immunity to unlisted damage types,
// Animating Statics the level logic breaks. Data tests are skipped without game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { clamberSide } from '../src/game/world/clamber';
import { clamberMatrix } from '../src/game/world/interact';
import { boxTouchesBounds } from '../src/game/world/logic';
import { lightOnly } from '../src/app/physics';
import { parseEntities, type Entity, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { readMaterial } from '../src/formats/model';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { BehaviorLibrary, CHAR, templateProp } from '../src/game/actors/behaviors';
import { classByHash } from '../src/formats/entities';
import { resistanceMultiplier } from '../src/game/fx/gas';
import { readTemplate } from '../src/game/world/fx';
import { nodeFS, readSrsc, skip } from './helpers';

const LEVEL_5A = 'LEVELS/5 Asylum/5a Asylum.lvl';
const LEVEL_5B = 'LEVELS/5 Asylum/5b Asylum.lvl';

async function level(path: string) {
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    const ents = parseEntities(lvl, packages);
    return { packages, ents, byUid: new Map(ents.map((e) => [e.uid, e])) };
  } finally {
    console.warn = warn;
  }
}

const boxOf = (e: Entity) => {
  const R = clamberMatrix(e.position, e.rotation, e.scale);
  const c = new THREE.Vector3().setFromMatrixPosition(R);
  return {
    centre: { x: c.x, y: c.y, z: c.z },
    ax: new THREE.Vector3().setFromMatrixColumn(R, 0),
    az: new THREE.Vector3().setFromMatrixColumn(R, 2),
    top: c.y + 0.5 * new THREE.Vector3().setFromMatrixColumn(R, 1).length(),
  };
};

test('Clamber Point boxes turn with their placement (5a garden wall: 209c at 19 degrees, 203c at 110)', { skip }, async () => {
  const { packages, byUid } = await level(LEVEL_5A);
  const tpl = (r: unknown) => readTemplate(packages, r as never)!.values;
  const step = byUid.get(0x209c)!;
  assert.deepEqual(step.rotation, [0, 19, 0]);
  const box = boxOf(step);
  // A 1.5 m step: its local x runs mostly along world z once turned.
  assert.ok(Math.abs(box.ax.z) > Math.abs(box.ax.x), `axis ${box.ax.x}, ${box.ax.z}`);
  const ip = tpl((step.values[30] as unknown[])[0]);
  const feet = { x: 519.97, y: 88.8, z: 402.44 };
  const toAnchor = (look: { x: number; z: number }) => clamberSide(ip, box, feet, look, 0.2);
  let pick = null;
  for (let a = 0; a < 36 && !pick; a++) pick = toAnchor({ x: Math.cos((a * Math.PI) / 18), z: Math.sin((a * Math.PI) / 18) });
  assert.ok(pick, 'the rubble step is climbed from the foot of the wall');
  // The unrotated box (the port's earlier fallback) offers nothing from there.
  const flat = { ...box, ax: { x: step.scale![0], y: 0, z: 0 }, az: { x: 0, y: 0, z: step.scale![2] } };
  let none = null;
  for (let a = 0; a < 36 && !none; a++) none = clamberSide(ip, flat, feet, { x: Math.cos((a * Math.PI) / 18), z: Math.sin((a * Math.PI) / 18) }, 0.2);
  assert.equal(none, null);
});

test('collision: blend 7 (src + dst x srcAlpha) surfaces are solid, additive ones are not', { skip }, async () => {
  const { packages } = await level(LEVEL_5B);
  // 5b's glass lobby floor: one Advanced layer, blend 7.
  const glass = readMaterial(packages as never, { pkg: 29, id: 571 });
  assert.ok(glass);
  assert.deepEqual(glass.layers.map((l) => l.blend), [7]);
  assert.equal(lightOnly({ material: glass }), false, 'the glass floor collides');
  // Additive light stays non-solid (1b's sloped shaft 9:5841, bug 20).
  assert.equal(lightOnly({ material: { key: 'x', cls: 0, layers: [{ blend: 2 }] } as never }), true);
  assert.equal(lightOnly({ material: { key: 'x', cls: 0, layers: [{ blend: 2 }, { blend: 7 }] } as never }), false, 'a glass pane with a reflection layer');
});

test('Detector vs a pushable box: oriented volume / bounds overlap', () => {
  // 5a's Detector 231f (0.9 m cube turned 59 degrees) over the junk 230e and the door crate.
  const a = (59 * Math.PI) / 180;
  const det = { c: [455.88, 97.744, 265.558] as [number, number, number], ax: [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]] as [[number, number, number], [number, number, number], [number, number, number]], h: [0.45, 0.45, 0.45] as [number, number, number] };
  // The crate's top reaches 97.35, 6 cm into the volume, beside it.
  assert.equal(boxTouchesBounds(det, [[455.6, 95.75, 265.0], [457.2, 97.35, 266.6]]), true);
  // Lower by 10 cm: no contact.
  assert.equal(boxTouchesBounds(det, [[455.6, 95.65, 265.0], [457.2, 97.25, 266.6]]), false);
  // Far off in x.
  assert.equal(boxTouchesBounds(det, [[458.6, 95.75, 265.0], [460.2, 97.35, 266.6]]), false);
});

test('Killjoy: KilljoyRoot runs his FleeBehavior p77 and RaiseDead p175 (5b #1500)', { skip }, async () => {
  const { packages, ents, byUid } = await level(LEVEL_5B);
  const B = new BehaviorLibrary(packages, byUid);
  const root = B.fromPlaced(0x1508);
  assert.ok(root && root.kind === 'killjoy');
  assert.deepEqual(root.corpses, [0x150f, 0x1512, 0x1510, 0x1511]);
  const kj = ents.find((e) => e.uid === 0x1500)!;
  const types = classByHash(kj.classHash)!.types;
  const flee = B.fromTemplate(templateProp(kj.values, types, CHAR.flee));
  assert.ok(flee && flee.kind === 'flee');
  // 10:568: the player's team is the threat; nothing ends it (p2, p10, p13, p15 all 0).
  assert.deepEqual(flee.flee.threatTeams, ['2:384']);
  assert.equal(flee.flee.runs, 0);
  assert.equal(flee.flee.doneWhenSafe, false);
  assert.equal(flee.flee.doneWhenNone, false);
  const rd = B.fromTemplate(templateProp(kj.values, types, CHAR.raiseDead));
  assert.ok(rd && rd.kind === 'raiseDead');
  assert.deepEqual(rd.clip, { pkg: 10, id: 510 });
  assert.equal(rd.near, 1);
});

test('immune to unlisted damage: the 5b insanity creature 2c3b takes only type 17', { skip }, async () => {
  const { packages, byUid } = await level(LEVEL_5B);
  const v = byUid.get(0x2c3b)!.values;
  assert.equal(v[5], 1, 'GameObject p5');
  assert.equal(resistanceMultiplier(packages, v, 17), 1, 'the rebirth grenade (Radius Damage 4:805, type 17)');
  for (const t of [0, 1, 3, 10, 13]) assert.equal(resistanceMultiplier(packages, v, t), 0, `type ${t}`);
});

test('5b: the Animating Statics the level listens to breaking are the three projectors before the theatre', { skip }, async () => {
  const { ents } = await level(LEVEL_5B);
  const listened = ents.filter((e) => e.className === 'Animating Static' && typeof e.values[21] === 'number' && e.values[21] !== 0 && (e.values[0] as number) > 0);
  const uids = new Set(listened.map((e) => e.uid));
  for (const u of [0x2c4e, 0x2c4f, 0x2c50]) assert.ok(uids.has(u), `#${u.toString(16)}`);
  // Their p21 (Off) counts Count Down 12ab down, whose zero unlocks the theatre doors 12ac / 12ad.
  for (const u of [0x2c4e, 0x2c4f, 0x2c50]) assert.equal(listened.find((e) => e.uid === u)!.values[21], 2);
});
