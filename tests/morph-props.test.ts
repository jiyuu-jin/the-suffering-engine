// Placed MorphingModels and DripMorphingModels (docs/game-logic.md §14.2): the decoded think,
// inputs and drops (Suffering.rfl MorphingModel 0x100d2c10 / 0x100d2e20 / map 0x10178a18,
// DripMorphingModel 0x100a8b40, Drip 0x100a88f0 / 0x100a8500 / 0x100a8730), the GPU blend
// targets and the retail census. The data tests skip without a game install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DATA_ROOT, filesWithExt, skip } from './helpers';
import { readDbId, readModel, type PackageSet, type ResRef } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import { parseEntities, type EntityPackage } from '../src/formats/entities';
import { MORPH_INPUTS, MorphMachine, MorphTargets, keyVertex, morphCrosses, morphKey, morphingModelDef, type MorphingModelDef } from '../src/game/world/morphing-model';
import { Drip, dripFrame, dripParams, type DripEnv } from '../src/game/world/drip';
import type { DynamicObject } from '../src/game/world/dynamic';

const r = (id: number, pkg = 3): ResRef => ({ pkg, id });

/** A MorphingModel template's values: p0 on, p1 loop, p2 remove at end, p3 keys, p4 times, p5 pause, p9 fade, p11 spawn time. */
function tpl(o: { on?: number; loop?: number; remove?: number; keys: number; times: number[]; pause?: number; fade?: number; at?: number }) {
  const v: unknown[] = new Array(25).fill(0);
  v[0] = o.on ?? 1;
  v[1] = o.loop ?? 0;
  v[2] = o.remove ?? 0;
  v[3] = Array.from({ length: o.keys }, (_, i) => r(100 + i));
  v[4] = o.times;
  v[5] = o.pause ?? 4294967295;
  v[9] = o.fade ?? 0;
  v[11] = o.at ?? 0;
  return morphingModelDef(v as never)!;
}

test('MorphMachine: a one-shot plays once, stops posed at its end (p15), On cannot restart it, Reset rewinds', () => {
  const d = tpl({ keys: 3, times: [1, 2] });
  const m = new MorphMachine(d);
  assert.equal(m.pose, undefined, 'drawn as placed until its first think');
  m.think(0.5);
  assert.deepEqual(m.pose, { a: 0, b: 1, f: 0.5 });
  let ev = m.think(1.75);
  assert.deepEqual([m.pose!.a, m.pose!.b, m.pose!.f], [1, 2, 0.625]);
  ev = m.think(1);
  assert.deepEqual(ev.fire, [15], 'the forward end fires p15');
  assert.equal(m.off, true);
  assert.equal(m.clock, 3);
  assert.deepEqual(m.pose, { a: 1, b: 2, f: 1 }, 'posed exactly at the last key');
  ev = m.input(16);
  assert.deepEqual(ev.fire, [15], 'On at the end: the clock is past the end at once');
  assert.equal(m.off, true);
  m.input(23);
  assert.equal(m.clock, 0);
  assert.equal(m.off, true);
  m.think(0.1);
  assert.ok(Math.abs(m.pose!.f - 0.1) < 1e-9, 'Reset forces one pass (the start pose)');
  assert.equal(m.off, true);
  m.think(0.1);
  assert.ok(Math.abs(m.clock - 0.1) < 1e-9, 'then it waits, off');
});

test('MorphMachine: Reverse / backward / forward inputs turn it on; the backward end fires p13', () => {
  const d = tpl({ on: 0, keys: 2, times: [2] });
  const m = new MorphMachine(d);
  m.think(0.5);
  assert.equal(m.clock, 0, 'off at start (p0 = 0): no clock');
  m.input(16);
  assert.equal(m.clock, 0.5, 'On thinks at once with the frame time');
  m.think(1);
  assert.equal(m.clock, 1.5);
  const ev = m.input(22);
  assert.equal(m.forward, false);
  m.think(1);
  assert.ok(Math.abs(m.clock - 0.5) < 1e-9);
  assert.deepEqual(m.think(1).fire, [13], 'back at 0: p13');
  assert.equal(m.off, true);
  m.input(18);
  assert.equal(m.forward, true);
  assert.equal(m.off, false, 'p18 forward also turns it on');
  void ev;
});

test('MorphMachine: the p5 pause fires p14 and holds until p20; p19 skips it; a loop re-arms it', () => {
  const d = tpl({ keys: 3, loop: 1, times: [1, 1, 1], pause: 1 });
  const m = new MorphMachine(d);
  assert.deepEqual(m.think(0.5).fire, []);
  assert.deepEqual(m.think(0.75).fire, [14], 'segment 1 reached');
  const c = m.clock;
  m.think(0.5);
  assert.equal(m.clock, c, 'held');
  m.input(20);
  m.think(0.5);
  assert.ok(m.clock > c, 'resumed');
  m.think(1.5);
  assert.ok(m.clock < 1, 'wrapped');
  assert.deepEqual(m.think(0.5).fire, [14], 'the wrap re-arms the pause');
  const n = new MorphMachine(d);
  n.input(19);
  n.think(0.5);
  assert.deepEqual(n.think(0.75).fire, [], 'p19: the pause skipped');
});

test('MorphMachine: p2 removes at the end, p24 removes, p11 crossings (with the wrap), p9 fades', () => {
  const gone = new MorphMachine(tpl({ keys: 2, times: [1], remove: 1 }));
  const ev = gone.think(2);
  assert.deepEqual(ev.fire, [15]);
  assert.equal(ev.remove, true);
  assert.equal(new MorphMachine(tpl({ keys: 2, times: [1] })).input(24).remove, true);
  const drip = new MorphMachine(tpl({ keys: 4, loop: 1, times: [0.6, 0.43, 0.06, 0.03], at: 1.1 }));
  let n = 0;
  for (let i = 0; i < 112 * 3; i++) n += drip.think(0.01).spawn;
  assert.equal(n, 3, 'one drop per 1.12 s cycle');
  assert.equal(morphCrosses(1.05, 1.11, 1.1), true);
  assert.equal(morphCrosses(1.11, 0.01, 1.1), false);
  assert.equal(morphCrosses(1.08, 0.01, 1.1), true, 'a wrap past it');
  const f = new MorphMachine(tpl({ keys: 4, times: [1, 1, 2], fade: 2 }));
  f.think(2.5);
  assert.equal(f.opacity, 1, 'the fade starts at its first think in segment 2');
  f.think(1);
  assert.ok(Math.abs(f.opacity - (1 - 1 / 1.5)) < 1e-9);
});

test('MorphMachine: shown again forces one pass; Off holds; the class map order; save / load', () => {
  const m = new MorphMachine(tpl({ on: 0, keys: 2, times: [1] }), false);
  m.think(0.2, false);
  assert.equal(m.pose, undefined);
  m.think(0.2, true);
  assert.ok(m.pose, 'the rising edge of shown');
  assert.deepEqual([...MORPH_INPUTS], [16, 21, 17, 18, 22, 23, 19, 20, 24]);
  const a = new MorphMachine(tpl({ keys: 3, times: [1, 1], pause: 1 }));
  a.think(1.2);
  const b = new MorphMachine(a.def);
  b.load(a.save());
  assert.deepEqual([b.clock, b.paused, b.passed, b.off, b.pose], [a.clock, a.paused, a.passed, a.off, a.pose]);
  a.input(21);
  a.think(0.3);
  assert.ok(Math.abs(a.clock - 1.2) < 1e-9, 'Off');
});

test('Drip: per-frame fall (velocity grows by p3 x dt x g per frame, the step is the velocity)', () => {
  const s = { v: 0, fallen: 0, y: 3 };
  let n = 0;
  while (!dripFrame(s, 0.04, 1 / 30, 10.41, 3)) n++;
  // 0.04 x 10.41 / 30 = 0.01388 m per frame per frame: n(n + 1) / 2 x 0.01388 >= 3 -> 21 frames.
  assert.equal(n + 1, 21);
  assert.deepEqual(dripParams([1, 2, 1, 0.04, null, r(2666), r(2667), r(1417)] as never), { fall: 0.04, splat: undefined, splash: r(2666), waterSplat: r(2667), waterSplash: r(1417) });
});

// ---------------------------------------------------------------------------
// Data

let cache: PackageSet | undefined;
function packages(): PackageSet {
  if (cache) return cache;
  const out = new Map<number, Record<string, unknown>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id, name: basename(base) };
    for (const ext of ['odu', 'xdu', 'mdu', 'qdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p);
  }
  return (cache = out as unknown as PackageSet);
}

function levels(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.toLowerCase().endsWith('.lvl')) out.push(p);
    }
  };
  walk(join(DATA_ROOT, 'LEVELS'));
  return out.sort();
}

/** A dynamic object like DynamicObjects.buildModel makes (one mesh per submesh, corners kept). */
function fakeObject(pkgs: PackageSet, model: ResRef, scale = [1, 1, 1]): DynamicObject {
  const m = readModel(pkgs, model)!;
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);
  for (const sm of m.submeshes) {
    const used = [...new Set(sm.indices)];
    const pos = new Float32Array(3 * used.length);
    used.forEach((ci, j) => {
      for (let x = 0; x < 3; x++) pos[3 * j + x] = m.positions[3 * ci + x] * scale[x];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.userData.corners = Uint32Array.from(used);
    pivot.add(new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial()));
  }
  return { uid: 1, root, pivot, model: m, visible: true } as unknown as DynamicObject;
}

test('retail census: 41 MorphingModels and 132 DripMorphingModels in 8 levels, every one valid and blendable', { skip }, () => {
  const pkgs = packages();
  const count: Record<string, number> = {};
  const families = new Set<string>();
  for (const L of levels()) {
    const lvl = new SrscFile(new Uint8Array(readFileSync(L)).buffer);
    for (const e of parseEntities(lvl, pkgs as unknown as Map<number, EntityPackage>)) {
      if (e.className !== 'MorphingModel' && e.className !== 'DripMorphingModel') continue;
      const name = `${basename(L, '.lvl')} ${e.className} ${e.uid.toString(16)}`;
      count[e.className] = (count[e.className] ?? 0) + 1;
      const def = morphingModelDef(e.values);
      assert.ok(def, `${name}: the create accepts it`);
      assert.ok(e.modelRef, `${name}: placed with a model`);
      const drawn = morphKey(pkgs, e.modelRef!)!;
      for (const f of def.frames) assert.equal(morphKey(pkgs, f)?.unique, drawn.unique, `${name}: key ${f.pkg}:${f.id} unique vertices`);
      families.add(def.frames.map((f) => f.id).join(','));
      if (e.className === 'DripMorphingModel') {
        // One drop a cycle: p11 inside it, or past it (3:1427: 0.55 of 0.533 s) crossed at the wrap.
        const m = new MorphMachine({ ...def, on: true });
        let n = 0;
        for (let i = 0; i < Math.round((def.total * 3) / 0.01) - 1; i++) n += m.think(0.01).spawn;
        assert.ok(n >= 2 && n <= 3, `${name}: ${n} drops in three cycles`);
      }
    }
  }
  assert.deepEqual(count, { DripMorphingModel: 132, MorphingModel: 41 });
  assert.equal(families.size, 13, "distinct key lists");
});

test('retail: the drips blend by unique vertex (49 / 41 / 49 vertices, 41 unique, 8 copies)', { skip }, () => {
  const pkgs = packages();
  const k160 = morphKey(pkgs, r(160))!, k148 = morphKey(pkgs, r(148))!, k149 = morphKey(pkgs, r(149))!;
  assert.deepEqual([k160.positions.length / 3, k148.positions.length / 3, k149.positions.length / 3], [49, 41, 49]);
  assert.deepEqual([k160.unique, k148.unique, k149.unique], [41, 41, 41]);
  assert.deepEqual([...k149.dup].slice(0, 2), [[41, 6], [42, 1]], 'entry 17 pairs: copy <- source');
  // A copy takes its source's blended position; the copies of 3:149 sit on their sources.
  for (const [dst, src] of k149.dup) {
    assert.equal(keyVertex(k148, k149, dst), src);
    for (let x = 0; x < 3; x++) assert.ok(Math.abs(k149.positions[3 * dst + x] - k149.positions[3 * src + x]) < 1e-6);
  }
  // The morph targets on a drawn 3:149 (DripMorphingModel 3:1414: 3:160, 3:148, 3:149, 3:148).
  const def = morphingModelDef([1, 1, 0, [r(160), r(148), r(149), r(148)], [0.6, 0.43, 0.06, 0.03]] as never)!;
  const obj = fakeObject(pkgs, r(149), [1, 2, 1]);
  const t = MorphTargets.attach(obj, pkgs, def, [1, 2, 1])!;
  assert.ok(t, 'blendable');
  const mesh = obj.pivot.children[0] as THREE.Mesh;
  const g = mesh.geometry as THREE.BufferGeometry;
  assert.equal(g.morphAttributes.position.length, 3, 'one target per distinct key model');
  const corners = g.userData.corners as Uint32Array;
  const v0 = obj.model!.source[corners[0]];
  const tgt = g.morphAttributes.position[0].array as Float32Array;
  const want = keyVertex(k160, k149, v0)!;
  assert.ok(Math.abs(tgt[1] - k160.positions[3 * want + 1] * 2) < 1e-6, 'scaled key position');
  t.apply({ a: 1, b: 2, f: 0.25 });
  assert.deepEqual(mesh.morphTargetInfluences, [0, 0.75, 0.25]);
  t.apply({ a: 3, b: 0, f: 0.5 });
  assert.deepEqual(mesh.morphTargetInfluences, [0.5, 0.5, 0], 'key 3 is 3:148 again');
  t.apply(undefined);
  assert.deepEqual(mesh.morphTargetInfluences, [0, 0, 0], 'as placed');
});

test('retail: a DripMorphingModel drop falls to the floor, restarts its splat and fires its generator', { skip }, () => {
  const pkgs = packages();
  const shown = new Map<number, boolean>();
  const spawned: string[] = [];
  let uid = 10;
  const env: DripEnv = {
    dyn: {
      spawnModel: (m: ResRef, M: THREE.Matrix4) => {
        const o = fakeObject(pkgs, m);
        (o as { uid: number }).uid = uid++;
        o.root.matrix.copy(M);
        return o;
      },
      setVisible: (u: number, v: boolean) => void shown.set(u, v),
      remove: (u: number) => void shown.delete(u),
    } as never,
    packages: pkgs as never,
    collision: { raycast: (_x: number, y: number) => ({ point: [0, y - 3, 0] }) } as never,
    gravity: () => 10.41,
    spawn: (t) => void spawned.push(`${t.pkg}:${t.id}`),
  };
  // DripMorphingModel 3:1427's drop 3:4111: splat MorphingModel 3:1424, generator 3:1423.
  const drip = Drip.spawn(env, r(4111), new THREE.Matrix4().makeTranslation(1, 4, 2))!;
  assert.ok(drip);
  drip.release();
  drip.update(1 / 30);
  assert.equal(shown.get(drip.d.uid), false, 'the first think prepares it and resets: no drop this cycle');
  assert.equal(drip.isFalling, false);
  drip.release();
  assert.equal(shown.get(drip.d.uid), true);
  let frames = 0;
  while (drip.isFalling && frames < 100) (drip.update(1 / 30), frames++);
  assert.equal(frames, 21, '3 m in 21 frames');
  assert.equal(shown.get(drip.d.uid), false);
  assert.deepEqual(spawned, ['3:1423']);
  const splat = [...shown].find(([u, v]) => u !== drip.d.uid && v);
  assert.ok(splat, 'the splat shown');
  // The splat (one-shot, 1.0 s, fading from segment 5) runs to its end and is hidden again.
  for (let i = 0; i < 40; i++) drip.update(1 / 30);
  assert.equal(shown.get(splat[0]), false);
  void (null as unknown as MorphingModelDef);
});
