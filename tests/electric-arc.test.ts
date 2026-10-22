// Electric Arc Effect / Electric Arc (src/game/fx/electric-arc.ts, docs/game-logic.md §17.3.1):
// the template decode, the endpoint trees (bones, linked objects), the end picks and the arcs'
// life cycle as decoded from Suffering.rfl. The retail parts skip without game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { parseEntities, type EntityPackage } from '../src/formats/entities';
import { readDbId, readModel, type PackageSet } from '../src/formats/model';
import {
  ArcEffectSim,
  linkTree,
  modelSections,
  nextEndpoint,
  randomEndpoint,
  readArcEffect,
  sectionBow,
  treeFromParents,
  type ArcEffectTemplate,
  type ArcTemplate,
} from '../src/game/fx/electric-arc';

let pk: Map<number, EntityPackage> | undefined;
function pkgs() {
  if (pk) return pk;
  pk = new Map();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || pk.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (p: string) => (existsSync(join(DATA_ROOT, p)) ? readSrsc(p) : undefined);
    pk.set(id, { id, name: base, odu: ld(`${base}.odu`), xdu: ld(`${base}.xdu`), qdu: ld(`${base}.qdu`), mdu: ld(`${base}.mdu`), tdu: ld(`${base}.tdu`) } as EntityPackage);
  }
  return pk;
}

/** Deterministic random numbers. */
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const ARC: ArcTemplate = { near: 0.5, far: 3, bow: 60, jitter: [0.003, 0.01], life: [0.5, 1], width: [0.35, 0.55], model: { pkg: 3, id: 447 } };
const effect = (o: Partial<ArcEffectTemplate>): ArcEffectTemplate => ({ duration: 15, links: false, count: 1, arc: ARC, travel: true, loop: true, childrenOnly: false, damage: 0, ...o });

test('bone trees: first child / next sibling in index order', () => {
  //   0 - 1 - 2 - 3
  //        \- 4 - 5
  const t = treeFromParents([-1, 0, 1, 2, 1, 4]);
  assert.deepEqual([...t.firstChild], [1, 2, 3, -1, 5, -1]);
  assert.deepEqual([...t.nextSibling], [-1, -1, 4, -1, -1, -1]);
});

test('link trees follow the links recursively; an object met twice ends the effect', () => {
  const links = new Map<number, number[]>([[10, [11, 12]], [11, [13]], [12, []], [13, []]]);
  const lt = linkTree(10, (u) => links.get(u))!;
  assert.deepEqual(lt.uids, [10, 11, 13, 12]);
  assert.deepEqual([...lt.tree.firstChild], [1, 2, -1, -1]);
  assert.deepEqual([...lt.tree.nextSibling], [-1, 3, -1, -1]);
  links.set(13, [10]);
  assert.equal(linkTree(10, (u) => links.get(u)), undefined);
});

test('a random end lies within (p0, p1) of the start, else any endpoint (0x100aa7a0)', () => {
  const P = [V(0, 0, 0), V(0.2, 0, 0), V(1, 0, 0), V(5, 0, 0)];
  const rnd = lcg(3);
  for (let k = 0; k < 50; k++) assert.equal(randomEndpoint(P, 0, 0.5, 3, rnd), 2);
  // Nothing in range: any endpoint, the start itself included.
  const seen = new Set<number>();
  for (let k = 0; k < 200; k++) seen.add(randomEndpoint(P, 0, 10, 50, rnd));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test('the next end of a travelling arc is a descendant within range (0x100aa9d0)', () => {
  // A chain along x: 0 -> 1 (0.3) -> 2 (0.6) -> 3 (1.2), and a sibling branch 1 -> 4 (0.9).
  const P = [V(0, 0, 0), V(0.3, 0, 0), V(0.6, 0, 0), V(1.2, 0, 0), V(0, 0.9, 0)];
  const tree = treeFromParents([-1, 0, 1, 2, 1]);
  const rnd = lcg(5);
  const got = new Set<number>();
  for (let k = 0; k < 100; k++) got.add(nextEndpoint(P, tree, 0, 0.5, 3, false, rnd));
  // 1 is too near (0.3): the walk goes deeper with p1 - 0.3; 2 (0.6) and 4 (0.9) are in range,
  // 3 (1.2) too: 1.2 < 3 - 0.3 - 0.6.
  assert.deepEqual([...got].sort(), [2, 3, 4]);
  // Children only (p7 = 1): 1 is too near, nothing deeper.
  assert.equal(nextEndpoint(P, tree, 0, 0.5, 3, true, rnd), -1);
  // A leaf has no next end.
  assert.equal(nextEndpoint(P, tree, 3, 0.5, 3, false, rnd), -1);
});

test('travel: arc 0 slides from A->B to B->C over its life; the others copy it', () => {
  const P = [V(0, 0, 0), V(0, 0.2, 0), V(0, 1, 0), V(0, 2, 0), V(0, 3, 0)];
  const tree = treeFromParents([-1, 0, 1, 2, 3]);
  const sim = new ArcEffectSim(effect({ count: 3 }), tree, P, undefined, lcg(7));
  assert.equal(sim.dead, false);
  assert.equal(sim.arcs.length, 3);
  const a0 = sim.arcs[0];
  assert.equal(a0.a, 1);
  const S = new THREE.Vector3(), E = new THREE.Vector3();
  const w0 = sim.segment(0, P, S, E);
  assert.ok(w0 >= 0.35 && w0 <= 0.55);
  assert.deepEqual(S.toArray(), P[a0.a].toArray());
  assert.deepEqual(E.toArray(), P[a0.b].toArray());
  // Half its life: halfway along both legs.
  sim.step(a0.period / 2, P);
  sim.segment(0, P, S, E);
  const B = P[a0.b], C = a0.c >= 0 ? P[a0.c] : B;
  assert.ok(Math.abs(S.y - (P[a0.a].y + B.y) / 2) < 1e-6);
  assert.ok(Math.abs(E.y - (B.y + C.y) / 2) < 1e-6);
  // Life over: A <- B <- C, and arcs 1 and 2 take arc 0's ends and life.
  const [b, c] = [a0.b, a0.c];
  sim.step(a0.period, P);
  assert.equal(sim.arcs[0].a, b);
  assert.equal(sim.arcs[0].b, c);
  for (const o of sim.arcs.slice(1)) assert.deepEqual([o.a, o.b, o.c, o.t], [a0.a, a0.b, a0.c, a0.t]);
});

test('travel without a next end shrinks into B; p6 = 0 ends the effect at the end of the path', () => {
  const P = [V(0, 0, 0), V(0, 0.2, 0), V(0, 1, 0)];
  const tree = treeFromParents([-1, 0, 1]);
  const sim = new ArcEffectSim(effect({ loop: false }), tree, P, undefined, lcg(9));
  const x = sim.arcs[0];
  assert.deepEqual([x.a, x.b, x.c], [1, 2, -1]);
  const S = new THREE.Vector3(), E = new THREE.Vector3();
  sim.step(x.period * 0.75, P);
  const w = sim.segment(0, P, S, E);
  assert.ok(w <= 0.55 * Math.sqrt(0.25) + 1e-9, `width ${w} shrinks by sqrt(1 - k)`);
  assert.deepEqual(E.toArray(), P[2].toArray());
  sim.step(x.period, P);
  assert.equal(sim.dead, true);
  // p6 = 1: it starts again from bone 1.
  const again = new ArcEffectSim(effect({ loop: true }), tree, P, undefined, lcg(9));
  again.step(again.arcs[0].period + 0.01, P);
  again.step(again.arcs[0].period + 0.01, P);
  assert.equal(again.dead, false);
  assert.equal(again.arcs[0].a, 1);
});

test('the effect lasts p0 seconds (-1 forever) and needs two endpoints', () => {
  const P = [V(0, 0, 0), V(0, 1, 0), V(0, 2, 0)];
  const tree = treeFromParents([-1, 0, 1]);
  const sim = new ArcEffectSim(effect({ duration: 2, travel: false, links: true }), tree, P, undefined, lcg(2));
  for (let t = 0; t < 1.9; t += 0.1) sim.step(0.1, P);
  assert.equal(sim.dead, false);
  sim.step(0.2, P);
  assert.equal(sim.dead, true);
  const forever = new ArcEffectSim(effect({ duration: -1, travel: false, links: true }), tree, P, undefined, lcg(2));
  for (let t = 0; t < 100; t += 0.5) forever.step(0.5, P);
  assert.equal(forever.dead, false);
  assert.equal(new ArcEffectSim(effect({}), treeFromParents([-1]), [V(0, 0, 0)]).dead, true);
});

test('random arcs hop: the old end becomes the start (0x100aaf80)', () => {
  const P = [V(0, 0, 0), V(1, 0, 0), V(2, 0, 0), V(3, 0, 0)];
  const tree = treeFromParents([-1, 0, 0, 0]);
  const sim = new ArcEffectSim(effect({ travel: false, links: true, duration: -1 }), tree, P, undefined, lcg(4));
  for (let k = 0; k < 20; k++) {
    const b = sim.arcs[0].b;
    sim.step(sim.arcs[0].t + 1e-3, P);
    assert.equal(sim.arcs[0].a, b);
  }
});

test('section bow: sin(pi i / n) x U(p3, p4) x p2 x length', () => {
  const out = sectionBow(11, { bow: 60, jitter: [0.003, 0.01] }, 2, new Float32Array(11), lcg(1));
  assert.equal(out[0], 0);
  for (let i = 1; i < 11; i++) {
    const s = Math.sin((Math.PI * i) / 11) * 60 * 2;
    assert.ok(out[i] >= s * 0.003 - 1e-6 && out[i] <= s * 0.01 + 1e-6, `section ${i}: ${out[i]}`);
  }
});

test('retail: the 1a electrocution templates', { skip }, () => {
  const p = pkgs();
  // Guard 609e: 75dd's 3:2898 (with the light generator) and 8185's 3:2941.
  const g = readArcEffect(p, { pkg: 3, id: 2898 })!;
  assert.deepEqual([g.duration, g.generator, g.links, g.count, g.travel, g.loop], [15, { pkg: 3, id: 2940 }, false, 1, true, true]);
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const a = g.arc!;
  assert.deepEqual([a.near, a.far, a.bow, ...a.jitter, ...a.life, ...a.width].map(r4), [0.5, 3, 60, 0.003, 0.01, 0.5, 1, 0.35, 0.55]);
  assert.deepEqual(a.model, { pkg: 3, id: 447 });
  assert.equal(readArcEffect(p, { pkg: 3, id: 2941 })!.generator, undefined);
  // The door: 3:2893 hops between linked decorations (p2 = 1), 0.5 s; the chair room's 3:2909
  // bolts are five to seven times the model's width.
  const door = readArcEffect(p, { pkg: 3, id: 2893 })!;
  assert.deepEqual([door.duration, door.links, door.travel], [0.5, true, false]);
  assert.deepEqual(door.arc?.width.map(r4), [0.65, 1.25]);
  const room = readArcEffect(p, { pkg: 3, id: 2909 })!;
  assert.deepEqual(room.arc?.width.map(r4), [5, 7]);
  assert.deepEqual(room.arc?.model, { pkg: 3, id: 578 });
  // Horace's 3:2230: 999 s over his bones.
  const h = readArcEffect(p, { pkg: 3, id: 2230 })!;
  assert.deepEqual([h.duration, h.links, h.travel, h.arc?.bow], [999, false, true, 60]);
});

test('retail: the bolt model 3:447 is two crossed ribbons in 11 sections', { skip }, () => {
  const m = readModel(pkgs() as unknown as PackageSet, { pkg: 3, id: 447 })!;
  const s = modelSections(m.positions);
  assert.equal(s.z.length, 11);
  assert.equal(s.z[0], -1);
  assert.equal(s.z[10], 0);
  // The two centre vertices at the origin are not moved.
  let origin = 0;
  for (let j = 0; j < s.group.length; j++) if (s.group[j] < 0) origin++;
  assert.equal(origin, 2);
  const layer = m.submeshes[0].material?.layers[0];
  assert.equal(layer?.blend, 2);
  assert.equal(layer?.depthWrite, true, 'the glow mark');
});

test('retail: 1a door arcs are trees of linked decorations', { skip }, () => {
  const lvl = readSrsc('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl');
  const ents = parseEntities(lvl, pkgs());
  const by = new Map(ents.map((e) => [e.uid, e]));
  // 816e's first target 8175 (the door sill) links to seven points up the door frame.
  const lt = linkTree(0x8175, (u) => by.get(u)?.links)!;
  assert.equal(lt.tree.count, 8);
  let kids = 0;
  for (let c = lt.tree.firstChild[0]; c >= 0; c = lt.tree.nextSibling[c]) kids++;
  assert.equal(kids, 7);
  // 829d: a door point and a point on the floor in front of the door.
  assert.equal(linkTree(0x829d, (u) => by.get(u)?.links)!.tree.count, 2);
  // The guard's damage objects fire together from Timer 81d5.
  const t = by.get(0x81d5)!;
  assert.deepEqual(t.links, [0x75dd, 0x8185]);
});
