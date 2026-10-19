// Static lights and the precomputed colours (src/formats/static-light.ts, render-data.ts
// pointLightSwitchable; docs/re/renderer.md §1.6). Pure checks, plus a data check of the .ldu
// bake against a local install (skipped without one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { nodeFS, skip } from './helpers';
import { pointLightCullRadius, pointLightLevel, pointLightSwitchable } from '../src/formats/render-data';
import { StaticLighting, isSwitchablePointLight, loadTimeColor, staticLightingFromEntities, type StaticPointLight } from '../src/formats/static-light';
import { findLevelDependencies, loadPackages } from '../src/app/loader';
import { SrscFile } from '../src/formats/srsc';
import { parseLevel, readLevelHeader } from '../src/formats/level';
import { parseEntities, type Entity } from '../src/formats/entities';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
/** Unclamped Σ over channels of the lights at a vertex (light units; the bake stores half). */
const rawSum = (ls: readonly StaticPointLight[], P: ArrayLike<number>, N: ArrayLike<number>, i: number) => {
  let s = 0;
  for (const l of ls) {
    const dx = l.x - P[3 * i], dy = l.y - P[3 * i + 1], dz = l.z - P[3 * i + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!(d2 < l.cull * l.cull)) continue;
    const ndl = (N[3 * i] * dx + N[3 * i + 1] * dy + N[3 * i + 2] * dz) / Math.sqrt(d2);
    if (ndl > 0) s += (l.rgb[0] + l.rgb[1] + l.rgb[2]) * pointLightLevel(l.intensity, d2) * ndl;
  }
  return s;
};
const light = (x: number, y: number, z: number, intensity: number, rgb: [number, number, number]): StaticPointLight => ({ x, y, z, intensity, rgb, cull: pointLightCullRadius(intensity, rgb) });

test('point light switchable: links, Lighting Effect, off at start, p2 / p4 / p5, p7 > 0 (0x4c6ca0)', () => {
  const base = { links: 0, p2: 0, p3: false, p4: 0, p5: 0, p6: 1, p7: 0 };
  assert.equal(pointLightSwitchable(base), false, 'on at start with no inputs: static');
  assert.equal(pointLightSwitchable({ ...base, links: 1 }), true);
  assert.equal(pointLightSwitchable({ ...base, p3: true }), true);
  assert.equal(pointLightSwitchable({ ...base, p6: 0 }), true);
  assert.equal(pointLightSwitchable({ ...base, p4: 7 }), true);
  assert.equal(pointLightSwitchable({ ...base, p5: 7 }), true);
  assert.equal(pointLightSwitchable({ ...base, p2: 1 }), true);
  assert.equal(pointLightSwitchable({ ...base, p7: 0.5 }), true);
  assert.equal(pointLightSwitchable({ ...base, p7: -1 }), false);
  // Entity form: values by property index, a template ref on p3.
  assert.equal(isSwitchablePointLight({ links: [], values: [0xffffff, 0, 0, null, 0, 0, 1, 0, 4, 0] }), false);
  assert.equal(isSwitchablePointLight({ links: [], values: [0xffffff, 0, 0, { pkg: 4, id: 9 }, 0, 0, 1, 0, 4, 0] }), true);
});

test('ambient: smallest region holding the point, summed up to the first exclusive, else the global one (0x4ca730)', () => {
  const g: [number, number, number] = [0.1, 0.1, 0.1];
  const sl = new StaticLighting([], g, [
    { min: [0, 0, 0], max: [10, 10, 10], rgb: [0.2, 0, 0] },
    { min: [0, 0, 0], max: [2, 2, 2], rgb: [0, 0.3, 0] },
    { min: [20, 0, 0], max: [22, 2, 2], rgb: [0, 0, 0.4], exclusive: false },
  ]);
  assert.deepEqual(sl.ambientAt(1, 1, 1), [0, 0.3, 0]);
  assert.deepEqual(sl.ambientAt(5, 5, 5), [0.2, 0, 0]);
  assert.deepEqual(sl.ambientAt(50, 5, 5), g);
  // A non-exclusive region adds the larger ones (here the global ambient).
  sl.ambientAt(21, 1, 1).forEach((v, k) => close(v, [0.1, 0.1, 0.5][k]));
});

test('load-time pass: ambient + colour × min(I/d², 2) × N·L, cut at the cull radius, clamped, not halved (0x4c0900, 0x4c0480)', () => {
  const white = light(0, 2, 0, 1, [1, 1, 1]);
  const sl = new StaticLighting([white], [0.1, 0.1, 0.1], []);
  const out = [0, 0, 0];
  // Facing the light 2 m below it: 0.1 + 1 × 1/4 × 1, stored as is.
  sl.shade([white], sl.ambient, 0, 0, 0, 0, 1, 0, out, 0);
  close(out[0], 0.1 + 0.25);
  // Facing away: ambient only.
  sl.shade([white], sl.ambient, 0, 0, 0, 0, -1, 0, out, 0);
  close(out[0], 0.1);
  // Very close: min(I/d², 2), then clamped to 1.
  sl.shade([white], [0, 0, 0], 0, 1.9, 0, 0, 1, 0, out, 0);
  close(out[0], 1);
  // Beyond the cull radius (white, I = 1: sqrt(10) m): nothing, although I/d² > 0.
  sl.shade([white], [0, 0, 0], 0, 2 - 3.2, 0, 0, 1, 0, out, 0);
  close(out[0], 0);
  // No hemisphere test in the CPU pass; negative lights subtract.
  const neg = light(0, 2, 0, 1, [-1, -1, -1]);
  neg.cull = white.cull;
  sl.shade([neg], [0.5, 0.5, 0.5], 0, 0, 0, 0, 1, 0, out, 0);
  close(out[0], 0.5 - 0.25);
});

test('CPU light pass: the object gets its 5 strongest static lights; smallest ambient box wins', () => {
  const ls = [0, 1, 2, 3, 4, 5, 6].map((i) => light(i, 0, 0, 4 + i * 0.4, [1, 1, 1]));
  const far = light(100, 0, 0, 1, [1, 1, 1]);
  const sl = new StaticLighting([...ls, far], [0.2, 0.2, 0.2], [
    { min: [-10, -10, -10], max: [10, 10, 10], rgb: [0.3, 0, 0] },
    { min: [-1, -1, -1], max: [1, 1, 1], rgb: [0, 0.4, 0] },
  ]);
  const got = sl.lightsFor(6, 0, 0, 0.5);
  assert.equal(got.length, 5);
  assert.ok(!got.includes(far));
  assert.equal(got[0], ls[6], 'strongest at the centre first');
  assert.deepEqual(sl.ambientAt(0, 0, 0), [0, 0.4, 0]);
  assert.deepEqual(sl.ambientAt(5, 0, 0), [0.3, 0, 0]);
  assert.deepEqual(sl.ambientAt(50, 0, 0), [0.2, 0.2, 0.2]);
});

test('1a: the .ldu bake holds the static point lights, not the switchable ones', { skip }, async () => {
  const fs = nodeFS();
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const deps = await findLevelDependencies(fs, path);
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const ldu = new SrscFile(await fs.read(deps.levelLdu!));
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  const statics = staticLightingFromEntities(ents).lights.filter((l) => !l.switchable);
  const switchable: StaticPointLight[] = [];
  for (const e of ents) {
    const v = e.values;
    if (e.className !== 'Point Light' || e.flags & 8 || !isSwitchablePointLight(e) || v[6] === 0) continue;
    const c = (v[0] as number) >>> 0;
    switchable.push(light(e.position[0] / 2048, e.position[1] / 2048, e.position[2] / 2048, v[8] as number, [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]));
  }
  assert.ok(statics.length > 50 && switchable.length > 100, `${statics.length} static, ${switchable.length} switchable on`);
  const data = parseLevel(lvl, path, { ldu, packages, includeUnlit: false, includeLayers: false });
  const lumaOnly: Record<'static' | 'switchable', number[]> = { static: [], switchable: [] };
  for (const part of data.parts) {
    if (!part.colors || !part.normals) continue;
    const P = part.positions, N = part.normals, C = part.colors;
    for (let i = 0; i < P.length / 3; i += 7) {
      // Σ over channels above 3: about 1 light unit or more.
      const s = rawSum(statics, P, N, i) / 2, w = rawSum(switchable, P, N, i) / 2;
      const luma = (C[4 * i] + C[4 * i + 1] + C[4 * i + 2]) / 3;
      if (s > 1.5 && w === 0) lumaOnly.static.push(luma);
      if (w > 1.5 && s === 0) lumaOnly.switchable.push(luma);
    }
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const st = median(lumaOnly.static), sw = median(lumaOnly.switchable);
  // Strongly lit by switchable lights only: the flat ambient fill (13/255); by static ones: brighter.
  assert.ok(lumaOnly.switchable.length > 1000 && sw < 16 / 255, `switchable-only median ${sw * 255}`);
  assert.ok(lumaOnly.static.length > 50 && st > 2 * sw, `static-only median ${st * 255} vs ${sw * 255}`);
});

test('1a / 1b: the .ldu bake around static lights follows I = p8 (p8 / d²), not p8² (0x4c60b0)', { skip }, async () => {
  const fs = nodeFS();
  for (const path of ['LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl', 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl']) {
    const deps = await findLevelDependencies(fs, path);
    const lvl = new SrscFile(await fs.read(deps.lvl));
    const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
    const ldu = new SrscFile(await fs.read(deps.levelLdu!));
    const ents = parseEntities(lvl, packages, { resolveStrings: false });
    const statics = staticLightingFromEntities(ents).lights.filter((l) => !l.switchable);
    // The same lights read as I = p8² (the old reading of p8 as a radius).
    const squared = statics.map((l) => light(l.x, l.y, l.z, l.intensity * l.intensity, l.rgb));
    const data = parseLevel(lvl, path, { ldu, packages, includeUnlit: false, includeLayers: false });
    // Mean light units over the channels.
    const sum = (ls: StaticPointLight[], P: ArrayLike<number>, N: ArrayLike<number>, i: number) => rawSum(ls, P, N, i) / 3;
    const unlit: number[] = [];
    const byLinear: [number, number][] = [], bySq: [number, number][] = [];
    for (const part of data.parts) {
      if (!part.colors || !part.normals) continue;
      const P = part.positions, N = part.normals, C = part.colors;
      for (let i = 0; i < P.length / 3; i += 5) {
        const bake = (2 * (C[4 * i] + C[4 * i + 1] + C[4 * i + 2])) / 3;
        const linear = sum(statics, P, N, i), sq = sum(squared, P, N, i);
        if (linear === 0 && sq === 0) unlit.push(bake);
        // Vertices each reading predicts to be clearly lit (0.6–1.5 light units): bake / prediction.
        if (linear > 0.6 && linear < 1.5) byLinear.push([bake, linear]);
        if (sq > 0.6 && sq < 1.5) bySq.push([bake, sq]);
      }
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const fill = median(unlit);
    // The bake above the flat fill of unlit vertices, over each reading's prediction.
    const ratio = (v: [number, number][]) => median(v.map(([bake, pred]) => (bake - fill) / pred));
    const rLinear = ratio(byLinear), rSq = ratio(bySq);
    assert.ok(byLinear.length > 200 && bySq.length > 200, `${path}: ${byLinear.length} / ${bySq.length} samples`);
    assert.ok(rLinear > 0.8 && rLinear < 1.25, `${path}: bake / (p8 / d²) = ${rLinear}`);
    assert.ok(rSq < 0.3, `${path}: bake / (p8² / d²) = ${rSq}`);
  }
});

test('load-time lights: every Point Light on at start is kept, but the pass bakes only static ones; not off-at-start or flag-0x8 ones', () => {
  const ent = (uid: number, cls: string, values: unknown[], extra: Partial<Entity> = {}) =>
    ({ uid, className: cls, values, links: [], flags: 0x281, position: [0, 4096, 0], rotation: [0, 0, 0], ...extra }) as unknown as Entity;
  const lamp = [0xdaac67, 0, 0, null, 1, 2, 1, 0, 4.05, 0];
  const ents = [
    ent(1, 'Point Light', lamp), // switchable (p4 / p5 inputs), on
    ent(2, 'Point Light', [0xffffff, 0, 0, null, 0, 0, 1, 0, 2, 0]), // static
    ent(3, 'Point Light', [...lamp.slice(0, 6), 0, 0, 4.05, 0]), // off at start
    ent(4, 'Point Light', lamp, { flags: 0x289 }), // never created
  ];
  const sl = staticLightingFromEntities(ents);
  assert.equal(sl.lights.length, 2);
  assert.equal(sl.lights[0].switchable, true);
  assert.ok(!sl.lights[1].switchable);
  // Only the static one goes into the colours; the switchable lamp lights the object per frame.
  assert.deepEqual(sl.lightsFor(0, 1, 0, 0.5), [sl.lights[1]]);
});

test('load-time pass: directional base lights of the region (exclusive cut, no rims) add colour × N·dir (0x4c0a40)', () => {
  const g: [number, number, number] = [0, 0, 0];
  const sl = new StaticLighting([], g, [], [
    { dir: [0, 1, 0], rgb: [0.5, 0.25, 0], exclusive: true, min: [0, 0, 0], max: [2, 2, 2] },
    { dir: [1, 0, 0], rgb: [0.3, 0.3, 0.3], exclusive: true },
  ]);
  // Inside the small region: its light only (exclusive hides the root one).
  const inside = sl.setFor(1, 1, 1, 0.1);
  assert.equal(inside.directionals.length, 1);
  const out = [0, 0, 0];
  sl.shadeSet(inside, 1, 1, 1, 0, 1, 0, out, 0);
  assert.deepEqual(out, [0.5, 0.25, 0]);
  // Outside: the root light, N·dir = 0.5.
  const outside = sl.setFor(10, 1, 1, 0.1);
  sl.shadeSet(outside, 10, 1, 1, 0.5, Math.sqrt(0.75), 0, out, 0);
  out.forEach((v) => close(v, 0.15));
});

test('load-time colour: the light sum clamped to 0..1, not halved; precomputed drawing doubles it (0x4c0480, xvsLightPrecomputed)', () => {
  assert.equal(loadTimeColor(0.4), 0.4);
  assert.equal(loadTimeColor(1.7), 1);
  assert.equal(loadTimeColor(-0.2), 0);
  // A switchable lamp at level k on such an object: 2k through the colours + k per frame.
  const k = 0.3;
  assert.equal(2 * loadTimeColor(k) + k, 3 * k);
});

test('load-time pass with `before`: only the lights created before the object (objects shown at start, renderer.md §1.9)', () => {
  const lamp = { ...light(0, 2, 0, 4, [0.855, 0.675, 0.404]), order: 50 };
  const early = { ...light(1, 2, 0, 4, [1, 1, 1]), order: 5 };
  const sl = new StaticLighting([lamp, early], [0.1, 0.1, 0.1], [{ min: [-5, -5, -5], max: [5, 5, 5], rgb: [0.2, 0.2, 0.2], order: 40 }], [], 30);
  // An object at index 20: only the early light; neither ambient exists yet.
  const at20 = sl.setFor(0, 0, 0, 0.5, 20);
  assert.deepEqual(at20.lights, [early]);
  assert.deepEqual(at20.ambient, [0, 0, 0]);
  // At index 35: the global ambient exists, the region's not yet.
  assert.deepEqual(sl.setFor(0, 0, 0, 0.5, 35).ambient, [0.1, 0.1, 0.1]);
  // At index 60: both lights, the region's ambient.
  const at60 = sl.setFor(0, 0, 0, 0.5, 60);
  assert.equal(at60.lights.length, 2);
  assert.deepEqual(at60.ambient, [0.2, 0.2, 0.2]);
  // No index: every light (floor layers).
  assert.equal(sl.setFor(0, 0, 0, 0.5).lights.length, 2);
});

test('load-time pass of an object hidden at start sees every light: it runs at the first draw (0x4ca6c0 from 0x4930f0 / 0x492950)', async () => {
  const { loadPassBefore } = await import('../src/game/world/dynamic');
  assert.equal(loadPassBefore({ flags: 0x81, index: 12 }), 12, 'shown at start: creation order');
  assert.equal(loadPassBefore({ flags: 0x80, index: 12 }), undefined, 'hidden at start: every light');
  assert.equal(loadPassBefore(undefined), undefined, 'spawned: every light');
  // A pickup placed during play (world.ts placeDrop: flags 0x81, no level index) is drawn after
  // every light exists; -1 as the order saw none (1a: the electrocuted guard's revolver black).
  assert.equal(loadPassBefore({ flags: 0x81, index: -1 }), undefined, 'dropped during play: every light');
});

test('1a: the Shiv in the stabbed inmate (Ammo Box 5bfb, hidden until "Goose" shows it) gets the ambient; its switchable cell lamp only per frame', { skip }, async () => {
  const fs = nodeFS();
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const deps = await findLevelDependencies(fs, path);
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  const { loadPassBefore } = await import('../src/game/world/dynamic');
  const shiv = ents.find((e) => e.uid === 0x5bfb)!;
  const lamp = ents.find((e) => e.uid === 0x5c06)!;
  assert.equal(shiv.className, 'Ammo Box');
  assert.equal(shiv.flags & 1, 0, 'hidden at start (shown by Visibility Toggler 7653)');
  assert.ok(lamp.index > shiv.index, 'its cell lamp is created after it');
  const sl = staticLightingFromEntities(ents);
  const at = [shiv.position[0] / 2048, shiv.position[1] / 2048, shiv.position[2] / 2048] as const;
  // Creation order alone: no light, no ambient (drawn black but for the switchable lamp per frame).
  const ordered = sl.setFor(at[0], at[1], at[2], 0.4, shiv.index);
  assert.equal(ordered.lights.length, 0);
  assert.deepEqual(ordered.ambient, [0, 0, 0]);
  const set = sl.setFor(at[0], at[1], at[2], 0.4, loadPassBefore(shiv));
  assert.ok(sl.lights.some((l) => l.switchable && Math.abs(l.x - lamp.position[0] / 2048) < 1e-3 && Math.abs(l.z - lamp.position[2] / 2048) < 1e-3), 'the cell lamp 5c06 is a switchable light');
  assert.ok(!set.lights.some((l) => l.switchable), 'no switchable light in the colours');
  assert.ok(set.ambient[0] > 0.05, `ambient ${set.ambient}`);
});

test('group rule: a light reaches only objects inside its nearest named group (0x4ca730 → 0x4b5930 / 0x4b5aa0)', async () => {
  const { sectorGroups } = await import('../src/formats/static-light');
  const node = (index: number, kind: 0 | 1 | 2 | 3, parent: number, id: number, name?: string) =>
    ({ index, kind, flags: 0x18, parent, firstChild: 0, nextSibling: 0, box: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number], id, name });
  // root group 1 > split 2 > groups "cell 4" (3) / "cell 6" (4); cell 6 has a split node 5.
  const tree = {
    header: [],
    nodes: [
      node(1, 1, 0, 0, 'Node 0, 0'),
      node(2, 0, 1, 0, 'Node 0, 0 [0A]'),
      node(3, 1, 2, 0, 'cell 4'),
      node(4, 1, 2, 0, 'cell 6'),
      node(5, 0, 4, 0, 'cell 6 [0B]'),
      node(6, 2, 3, 0x5c06), // lamp in cell 4
      node(7, 2, 5, 0x587a), // door in cell 6 (below a split node)
      node(8, 2, 3, 0x5bfb), // object in cell 4
      node(9, 2, 1, 0x7f89), // light under the root group
    ],
  };
  const g = sectorGroups(tree);
  assert.equal(g.groupOf(0x5c06), 3);
  assert.equal(g.groupOf(0x587a), 4, 'split nodes are skipped');
  assert.deepEqual(g.chain(0x587a), [4, 1]);
  assert.equal(g.groupOf(0x7f89), 1);
  assert.equal(g.groupOf(0x1234), undefined);
  const lamp = { ...light(0, 2, 0, 4, [1, 1, 1]), group: 3 };
  const root = { ...light(0, 2, 0, 4, [1, 1, 1]), group: 1 };
  const sl = new StaticLighting([lamp, root], [0, 0, 0], [], [], undefined, g.chain);
  assert.deepEqual(sl.lightsFor(0, 0, 0, 0.5, undefined, 0x5bfb).length, 2, 'same group: both');
  assert.deepEqual(sl.lightsFor(0, 0, 0, 0.5, undefined, 0x587a), [root], 'another group: only the root one');
  assert.equal(sl.lightsFor(0, 0, 0, 0.5).length, 2, 'no uid (floor layers): every light');
  assert.equal(sl.lightsFor(0, 0, 0, 0.5, undefined, 0x1234).length, 2, 'object outside the tree: every light');
});

test('1a: group rule and the pass of objects shown at start (cell doors) / hidden at start (Shiv)', { skip }, async () => {
  const fs = nodeFS();
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const deps = await findLevelDependencies(fs, path);
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const packages = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  const { parseSectorTree, lightRegions } = await import('../src/formats/visgraph');
  const { loadPassBefore } = await import('../src/game/world/dynamic');
  const tree = parseSectorTree(lvl)!;
  const regions = lightRegions(tree, ents.filter((e) => e.className === 'Ambient Light' || e.className === 'Directional Light').map((e) => e.uid));
  const sl = staticLightingFromEntities(ents, regions, tree);
  const by = new Map(ents.map((e) => [e.uid, e]));
  const at = (e: Entity) => [e.position[0] / 2048, e.position[1] / 2048, e.position[2] / 2048] as const;
  const isLamp = (l: StaticPointLight, e: Entity) => Math.abs(l.x - e.position[0] / 2048) < 1e-3 && Math.abs(l.z - e.position[2] / 2048) < 1e-3;
  const lamp4 = by.get(0x5c06)!; // switchable Point Light under "cell 4"
  const l4 = sl.lights.find((l) => isLamp(l, lamp4))!;
  assert.ok(l4.group !== undefined && l4.switchable, 'the cell 4 lamp: a group, switchable');
  // The Shiv (hidden at start, cell 4): the ambient and every static light on at load; its
  // switchable cell lamp reaches it per frame only.
  const shiv = by.get(0x5bfb)!;
  const s = sl.setFor(...at(shiv), 0.4, loadPassBefore(shiv), shiv.uid);
  assert.ok(!s.lights.some((l) => l.switchable));
  assert.ok(s.ambient[0] > 0.05);
  // The fallen cell door (Static Object 848d, hidden until the CartWheeler scene) keeps no lamp
  // in its colours, so it goes dark with the lamps.
  const fallen = by.get(0x848d)!;
  assert.equal(fallen.flags & 1, 0);
  assert.ok(!sl.setFor(...at(fallen), 1, loadPassBefore(fallen), fallen.uid).lights.some((l) => l.switchable));
  // Cell 6's door (shown at start, index before every cell lamp and the root ambient): no
  // load-time light, so only its switchable lamps per frame (PC capture, renderer.md §1.9).
  const door = by.get(0x587a)!;
  assert.equal(door.flags & 1, 1);
  const d = sl.setFor(...at(door), 1, loadPassBefore(door), door.uid);
  assert.equal(d.lights.length, 0);
  assert.deepEqual(d.ambient, [0, 0, 0]);
  // The group rule (static lights here; the lamps are switchable): a light in reach under
  // another group is left out.
  const g = new StaticLighting(sl.lights.map((l) => ({ ...l, switchable: false })), sl.ambient, sl.regions, sl.directionals, sl.ambientOrder, sl.groupsOf);
  const all = g.lightsFor(...at(door), 1, undefined, door.uid);
  assert.ok(all.length > 0 && !all.some((l) => isLamp(l, lamp4)), 'never the cell 4 lamp in cell 6');
  const crate = by.get(0x7b16)!; // Breakable in cell 5
  const r = (crate.bounds?.sphere[3] ?? 1024) / 2048;
  assert.ok(g.lightsFor(...at(crate), r, undefined, crate.uid).length < g.lightsFor(...at(crate), r).length);
});
