// A faded figure's glow mark (docs/re/renderer.md §3.2 / §5.1; port src/app/scene-glow.ts
// glowMarkOf, surface-material.ts glowMarkMaterial): the marking pass's alpha test sees texture
// alpha x the object's opacity, so 1b's flickering Killjoy marks nothing in his faintest updates
// (docs/game-logic.md §15.7.8, docs/playthrough.md bug 86).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import * as THREE from 'three/webgpu';
import { glowMarked, glowMarkWritten } from '../src/formats/render-data';
import { setGlowMark } from '../src/app/glow-mark';
import { glowMarkOf } from '../src/app/scene-glow';
import { projectorOpacity, projectorParams } from '../src/game/actors/specials/projector';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readSkinnedModel } from '../src/formats/skeleton';
import type { PackageSet } from '../src/formats/model';
import { nodeFS, readSrsc, skip } from './helpers';

test('glow mark of a faded object: texture alpha x opacity against the pass alpha test', () => {
  // A glow-flagged additive pass (mode 2, > 32 / 255) of an opaque texel.
  assert.equal(glowMarkWritten(2, 1, 1), true);
  assert.equal(glowMarkWritten(2, 1, 0.13), true, '0.13 x 255 = 33 > 32');
  assert.equal(glowMarkWritten(2, 1, 0.12), false, '0.12 x 255 = 30.6');
  assert.equal(glowMarkWritten(2, 0.5, 0.2), false, 'texture alpha counts too');
  // Alpha blend (> 2 / 255) and cut-out (> 200 / 255); an opaque pass marks every pixel.
  assert.equal(glowMarkWritten(1, 1, 0.01), true);
  assert.equal(glowMarkWritten(8, 1, 0.7), false);
  assert.equal(glowMarkWritten(0, 0, 0), true);
});

test('glowMarkOf: a faded material gets a mark of its own carrying its opacity', () => {
  const mark = new THREE.MeshBasicNodeMaterial();
  mark.name = 'mark';
  const a = new THREE.MeshBasicNodeMaterial();
  setGlowMark(a, mark);
  assert.equal(glowMarkOf(a), mark, 'unfaded: the shared mark');
  a.opacity = 0.3;
  const m1 = glowMarkOf(a) as THREE.Material;
  assert.notEqual(m1, mark);
  assert.equal(m1.opacity, 0.3);
  assert.equal(mark.opacity, 1, 'the shared mark is untouched');
  a.opacity = 0.7;
  assert.equal(glowMarkOf(a), m1, 'one clone per material, kept');
  assert.equal(m1.opacity, 0.7);
  // A second faded material sharing the mark has a clone of its own.
  const b = new THREE.MeshBasicNodeMaterial();
  setGlowMark(b, mark);
  b.opacity = 0.1;
  const arr = glowMarkOf([a, b, new THREE.MeshBasicNodeMaterial()]) as THREE.Material[];
  assert.equal(arr[0], m1);
  assert.notEqual(arr[1], m1);
  assert.equal(arr[1].opacity, 0.1);
  assert.equal(arr[2].name, 'glow-nomark');
  a.opacity = 1;
  assert.equal(glowMarkOf(a), mark);
});

test("1b's Killjoy: glow-flagged skin under a 0.4 +- 0.5 projector; about a fifth of the updates mark nothing", { skip }, async () => {
  const L = 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl';
  const lvl = readSrsc(L);
  const pkgs = (await loadPackages(nodeFS(), dirname(L), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
  const fx = parseEntities(lvl, pkgs, { resolveStrings: false }).find((e) => e.uid === 0x7edb)!;
  const p = projectorParams(fx.values);
  const sk = readSkinnedModel(pkgs as unknown as PackageSet, { pkg: 10, id: 90 })!;
  // The body passes 10:782..784: texture x 0x414141, then the flagged additive 10:428 (alpha 1).
  for (const i of [2, 3, 4]) {
    const layers = sk.model.submeshes[i].material!.layers;
    assert.equal(glowMarked(layers), true);
    const flagged = layers.find((l) => l.depthWrite)!;
    assert.equal(flagged.blend, 2);
  }
  // Share of updates (r uniform in -1..1, all five projectors standing) that write no mark.
  let none = 0;
  const n = 2000;
  for (let k = 0; k < n; k++) if (!glowMarkWritten(2, 1, projectorOpacity(p, 1, -1 + (2 * (k + 0.5)) / n))) none++;
  assert.ok(Math.abs(none / n - 0.225) < 0.01, `${none / n}`);
});
