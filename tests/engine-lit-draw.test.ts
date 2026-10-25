// Objects without usable .ldu colours and the dynamic (per-vertex) lighting path
// (docs/re/renderer.md §1.11). The shader side (every lighting kind draws pixels with every
// light loop at 0) is a browser check: tools/smoke.mjs ENGINE_LIT_PROBE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nodeFS, skip } from './helpers';

test('engineLightFactor takes the vertex position and normal before any light loop', () => {
  // TSL emits positionLocal / normalLocal where they are first built: inside the Ambient Light
  // region loop they were never assigned when the level has no region (1b, 6b, 7), and every
  // dynamic-lit mesh collapsed onto its origin. The factor must build both first, as variables.
  const src = readFileSync(new URL('../src/app/engine-light.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function engineLightFactor'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  const p = fn.indexOf('positionWorld.toVar()'), n = fn.indexOf('normalWorld.toVar()');
  assert.ok(p > 0 && n > 0, 'position and normal taken as variables');
  for (const loop of ['bakedBase(', 'objectBase(', 'dynamicBase(', 'pointLights(', 'chosenPointLights(', 'spotLights(']) {
    const at = fn.indexOf(loop);
    assert.ok(at > p && at > n, `${loop} after them`);
  }
});

test('1b: a placed Switch whose .ldu record holds no colours gets the load-time pass (drawn as precomputed)', { skip }, async () => {
  const { DynamicObjects } = await import('../src/game/world/dynamic');
  const { findLevelDependencies, loadPackages } = await import('../src/app/loader');
  const { SrscFile } = await import('../src/formats/srsc');
  const { readLevelHeader } = await import('../src/formats/level');
  const { parseEntities } = await import('../src/formats/entities');
  const { parseSectorTree, lightRegions } = await import('../src/formats/visgraph');
  const { staticLightingFromEntities } = await import('../src/formats/static-light');
  const fs = nodeFS();
  const deps = await findLevelDependencies(fs, 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl');
  const lvl = new SrscFile(await fs.read(deps.lvl));
  const ldu = new SrscFile(await fs.read(deps.levelLdu!));
  const pkgs = await loadPackages(fs, dirname(deps.lvl), readLevelHeader(lvl).dependencies, () => {});
  const ents = parseEntities(lvl, pkgs, { resolveStrings: false });
  const tree = parseSectorTree(lvl)!;
  const regions = lightRegions(tree, ents.filter((e) => e.className === 'Ambient Light' || e.className === 'Directional Light').map((e) => e.uid));
  const sl = staticLightingFromEntities(ents, regions, tree);
  const dyn = new DynamicObjects(pkgs, null, ldu, sl);
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  // 7ea0..7ea5 and 81cc: their records name the model (7:1007, 228 vertices) but hold no colours.
  const uids = [0x7ea0, 0x7ea2, 0x7ea3, 0x7ea4, 0x7ea5, 0x81cc];
  dyn.build(lvl, byUid, uids);
  for (const uid of uids) {
    const d = dyn.objects.get(uid);
    assert.ok(d, `#${uid.toString(16)} built`);
    const meshes: { userData: Record<string, unknown>; geometry: { getAttribute(n: string): { array: ArrayLike<number> } } }[] = [];
    d.root.traverse((o) => void ((o as { isMesh?: boolean }).isMesh && meshes.push(o as unknown as (typeof meshes)[0])));
    assert.ok(meshes.length > 0);
    for (const m of meshes) {
      assert.equal(m.userData.baked, true, `#${uid.toString(16)}: precomputed (load-time pass), not the dynamic path`);
      const c = m.geometry.getAttribute('color').array;
      let lit = 0;
      for (let i = 0; i < c.length; i += 4) if (c[i] + c[i + 1] + c[i + 2] > 0) lit++;
      assert.ok(lit > 0, `#${uid.toString(16)}: load-time colours written`);
    }
  }
  dyn.dispose();
});

test('untinted passes of an object without colours fade as opacity² (oD0.a = opacity x opacity), tinted ones and baked ones once', async () => {
  const THREE = await import('three/webgpu');
  const { materialOpacity } = await import('three/tsl');
  const { createSurfaceMaterial } = await import('../src/app/surface-material');
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const src = { texture: () => white, missing: () => white, hasAlpha: () => true };
  // References to the material's opacity in the colour graph (three.js multiplies by it once more).
  const refs = (n: unknown, seen = new Set<unknown>()): number => {
    if (!n || typeof n !== 'object' || seen.has(n)) return 0;
    seen.add(n);
    const node = n as { isNode?: boolean; getChildren(): Iterable<unknown> };
    let c = n === materialOpacity ? 1 : 0;
    if (node.isNode) for (const ch of node.getChildren()) c += refs(ch, seen);
    return c;
  };
  const of = (tint: number | undefined, vertexColors: boolean, blend = 1) => {
    const material = { key: `o2-${tint}-${vertexColors}-${blend}`, cls: 0, layers: [{ texture: 't:1', blend, tint }] };
    return refs((createSurfaceMaterial({ material, textureKey: 't:1', vertexColors }, src).material as unknown as { colorNode: unknown }).colorNode);
  };
  assert.equal(of(undefined, false), 1, 'untinted, no colours: the opacity again in the alpha');
  assert.equal(of(0xffffff, false), 0, 'tinted: TFACTOR alpha, the opacity once (three.js)');
  assert.equal(of(undefined, true), 0, 'precomputed without vertex alpha: once');
});
