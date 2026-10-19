// Visibility data (sector tree, zone graph, portals) against a local game install
// (skipped without one). Structural assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesWithExt, nodeFS, readSrsc, skip } from './helpers';
import { parseFloorLayers, parseLevel, parseLevelObjects, readLevelHeader } from '../src/formats/level';
import { buildLevelZoning, lightRegions, OPEN_LINK, parseSectorTree, parseZoneGraph } from '../src/formats/visgraph';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';

test('sector trees parse to the end and their leaves are the level objects and floor layers', { skip }, () => {
  for (const f of filesWithExt('.lvl')) {
    const lvl = readSrsc(f);
    const tree = parseSectorTree(lvl)!;
    assert.ok(tree && tree.nodes.length > 100, f);
    // h1 = number of group nodes (kinds 0 and 1).
    assert.equal(tree.header[1], tree.nodes.filter((n) => n.kind <= 1).length, f);
    const uids = new Set(parseLevelObjects(lvl).map((o) => o.uid));
    const layers = new Set(parseFloorLayers(lvl).map((l) => l.uid));
    for (const n of tree.nodes) {
      assert.ok(n.parent < n.index || (n.index === 1 && n.parent === 0), `${f}: node ${n.index} parent ${n.parent}`);
      if (n.kind === 2) assert.ok(uids.has(n.id), `${f}: leaf ${n.index} uid ${n.id}`);
      if (n.kind === 3) assert.ok(layers.has(n.id), `${f}: layer leaf ${n.index} uid ${n.id}`);
    }
  }
});

test('zone graphs: zones are named groups, portals are listed from both sides', { skip }, () => {
  let zoned = 0;
  for (const f of filesWithExt('.lvl')) {
    const lvl = readSrsc(f);
    const tree = parseSectorTree(lvl)!;
    const zones = parseZoneGraph(lvl);
    if (!zones.length) continue;
    zoned++;
    const sides = new Map<number, number>();
    zones.forEach((z, i) => {
      assert.equal(tree.nodes[z.node - 1]?.kind, 1, `${f}: zone ${i} node ${z.node}`);
      assert.ok(z.pvs.includes(i), `${f}: zone ${i} visibility list lacks itself`);
      for (const l of z.links) {
        assert.ok(l.zone < zones.length, `${f}: zone ${i} link to ${l.zone}`);
        if (l.portal === OPEN_LINK) assert.ok(l.flags & 2, `${f}: open link without flag 2`);
        else sides.set(l.portal, (sides.get(l.portal) ?? 0) + 1);
      }
    });
    for (const [uid, n] of sides) assert.equal(n, 2, `${f}: portal ${uid.toString(16)} listed ${n} times`);
  }
  assert.equal(zoned, 13);
});

test('zoned levels resolve their portals and bucket geometry per zone', { skip }, async () => {
  const fs = nodeFS();
  for (const f of filesWithExt('.lvl').filter((p) => /1a |5b /.test(p))) {
    const lvl = readSrsc(f);
    const packages = await loadPackages(fs, dirname(f), readLevelHeader(lvl).dependencies, () => {});
    const zoning = buildLevelZoning(lvl, packages)!;
    const { zones, portals } = zoning.visibility;
    assert.ok(zones.length > 50 && portals.length > 50, f);
    // Every portal link resolved to a Portal object with a real box.
    for (const z of zones) for (const l of z.links) assert.ok(l.portal < portals.length, f);
    for (const p of portals) {
      const xs = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => p.corners[3 * k]);
      assert.ok(Math.max(...xs) - Math.min(...xs) > 0.2, `${f}: portal ${p.uid.toString(16)} is flat`);
    }
    assert.ok(portals.some((p) => p.startsClosed && p.link), `${f}: no door portals`);
    const level = parseLevel(lvl, f, { packages, zoneOf: zoning.zoneOf });
    const zoned = level.parts.filter((p) => p.zone !== undefined).length;
    assert.ok(zoned > level.parts.length * 0.8, `${f}: ${zoned}/${level.parts.length} parts zoned`);
  }
});

test('light regions: an Ambient / Directional Light applies in its parent group, the root group everywhere (1a)', { skip }, () => {
  const f = filesWithExt('.lvl').find((p) => /1a /.test(p))!;
  const r = lightRegions(parseSectorTree(readSrsc(f))!, [0x7f89, 0x7f8a, 0x88f1, 0x88f2, 0x88f8, 0x88f9]);
  // The cell block's ambient (0x1c1e20) and its black base light are under the root group.
  for (const uid of [0x7f89, 0x7f8a]) assert.equal(r.get(uid)?.box, null, uid.toString(16));
  assert.equal(r.get(0x7f89)?.volume, Infinity);
  for (const [uid, name] of [[0x88f1, 'Outdoor East'], [0x88f2, 'Outdoor East'], [0x88f8, 'Backstage'], [0x88f9, 'Backstage']] as const) {
    const g = r.get(uid)!;
    assert.equal(g.name, name);
    assert.ok(g.box && g.volume > 0 && g.box[3] > g.box[0], `${uid.toString(16)} box`);
  }
  // Output space (engine units / 2048): Backstage holds ~1.1e5 m³.
  assert.ok(Math.abs(r.get(0x88f8)!.volume / 1.11e5 - 1) < 0.02, `${r.get(0x88f8)!.volume}`);
});
