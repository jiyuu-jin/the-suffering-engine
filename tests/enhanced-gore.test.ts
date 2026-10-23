// Enhanced mode gore (docs/enhanced.md "Gore"): the decal budget and its recycling, the blood
// model (drying, pools, impact shapes), the splat atlas, and the Original guard (the listener slot
// stays empty and every call site is a no-op without it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { DecalRing } from '../src/app/enhanced/gore/ring';
import { DRY, DRY_TAU, POOL_DELAY, POOL_TAU, ROUGH_DRY, ROUGH_WET, SPEC_DRY, SPEC_WET, WET_THICK, bloodLook, decalFrame, dryness, impactShape, poolReach, soakRadius, stainSize } from '../src/app/enhanced/gore/blood';
import { GORE_TIERS, MAX_WOUNDS } from '../src/app/enhanced/gore/config';
import { ATLAS, GRID, MARGIN, SPLAT_TILES, TILE, buildSplatAtlas, tileCoverage, tileRect } from '../src/app/enhanced/gore/splats';
import { stepDrop, terminalSpeed } from '../src/app/enhanced/gore/droplets';
import { hurtLevel } from '../src/app/enhanced/gore/screen';
import { FilmBatch } from '../src/app/enhanced/gore/decals';
import { gore } from '../src/game/fx/gore-bus';
import { TIERS } from '../src/app/enhanced/config';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- Budget and recycling -------------------------------------------------------------------

test('decal ring: the budget is never exceeded and the oldest splat goes first', () => {
  const r = new DecalRing(1000, 1000, 4);
  const ids: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = r.alloc(6)!;
    ids.push(a.id);
    assert.ok(r.records.length <= 4);
    if (i >= 4) assert.deepEqual(a.evicted.map((e) => e.id), [ids[i - 4]]);
    else assert.equal(a.evicted.length, 0);
  }
  assert.deepEqual(r.records.map((x) => x.id), ids.slice(-4));
  assert.equal(r.recycled, 6);
});

test('decal ring: a full buffer wraps and recycles exactly the splats it overwrites', () => {
  const r = new DecalRing(100, 100, 1000);
  const a = r.alloc(40)!, b = r.alloc(40)!;
  assert.deepEqual([a.start, b.start], [0, 40]);
  // 80 + 30 > 100: wraps to 0 and overwrites the first splat only.
  const c = r.alloc(30)!;
  assert.equal(c.start, 0);
  assert.deepEqual(c.evicted.map((e) => e.id), [a.id]);
  assert.deepEqual(r.records.map((x) => x.id), [b.id, c.id]);
  // Ranges never overlap.
  for (let i = 0; i < 200; i++) {
    r.alloc(1 + ((i * 7) % 33));
    const s = [...r.records].sort((x, y) => x.start - y.start);
    for (let k = 1; k < s.length; k++) assert.ok(s[k - 1].start + s[k - 1].count <= s[k].start);
    assert.ok(r.used <= 100);
  }
  assert.equal(r.alloc(101), null);
});

test('decal ring: a lower tier drops what no longer fits (oldest first)', () => {
  const r = new DecalRing(1000, 1000, 100);
  for (let i = 0; i < 20; i++) r.alloc(40);
  const out = r.resize(400, 5);
  assert.ok(r.records.length <= 5);
  for (const x of r.records) assert.ok(x.start + x.count <= 400);
  assert.ok(out.length >= 15);
  assert.ok(r.alloc(40));
});

test('film batch: one buffer per kind, recycled splats are cleared, budgets per tier', () => {
  const b = new FilmBatch('t', new THREE.MeshBasicMaterial(), 60, 60, 3);
  const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], uvs: [0.5, 0.5, 1, 0.5, 0.5, 1] };
  const light = { r: 0.3, g: 0.3, b: 0.3 };
  for (let i = 0; i < 5; i++) assert.ok(b.add(tri, 0, light, { x: 0, y: 1, z: 0 }, [i, 0, 1, 0.001]));
  assert.equal(b.count, 3);
  const g = b.mesh.geometry.getAttribute('gore').array as Float32Array;
  // Live splats keep their birth times; nothing older is left in the buffer.
  const births = new Set<number>();
  for (const r of b.ring.records) births.add(g[4 * r.start]);
  assert.deepEqual([...births].sort(), [2, 3, 4]);
  // Normals face the decal normal (+y here: the triangle is wound to -y).
  const n = b.mesh.geometry.getAttribute('normal').array as Float32Array;
  assert.ok(n[b.ring.records[0].start * 3 + 1] > 0.99);
  // Lowering the budget clears the dropped ranges (degenerate, transparent).
  b.resize(60, 1);
  assert.equal(b.count, 1);
  const P = b.mesh.geometry.getAttribute('position').array as Float32Array;
  const live = b.ring.records[0];
  for (let v = 0; v < 60; v++) if (v < live.start || v >= live.start + live.count) assert.equal(g[4 * v + 2], 0);
  assert.equal(P.length, 180);
  // Tier budgets grow with the tier; the buffers are sized for the largest.
  for (let i = 1; i < TIERS.length; i++) {
    const lo = GORE_TIERS[TIERS[i - 1]], hi = GORE_TIERS[TIERS[i]];
    for (const k of ['decals', 'decalVerts', 'pools', 'poolVerts', 'bodies', 'droplets'] as const) assert.ok(hi[k] >= lo[k], `${k} ${TIERS[i]}`);
    assert.ok(hi.woundsPerBody <= MAX_WOUNDS);
  }
});

// --- Drying ---------------------------------------------------------------------------------

test('blood dries over minutes: darker, matte, thin films first', () => {
  assert.equal(dryness(0, 1), 0);
  let prev = -1;
  for (let t = 0; t <= 1800; t += 30) {
    const d = dryness(t, 0.5);
    assert.ok(d >= prev);
    prev = d;
  }
  // A thin spatter is mostly dry within two minutes; a pool's centre is still wet after one.
  assert.ok(dryness(120, 0.1) > 0.9);
  assert.ok(dryness(60, 1) < 0.4);
  assert.ok(dryness(20 * 60, 1) > 0.99);
  assert.ok(near(dryness(DRY_TAU * 1.25, 1), 1 - Math.exp(-1)));
  const fresh = bloodLook(0, 1), old = bloodLook(3600, 1);
  assert.ok(near(fresh.roughness, ROUGH_WET) && near(fresh.specular, SPEC_WET));
  assert.ok(near(old.roughness, ROUGH_DRY, 1e-3) && near(old.specular, SPEC_DRY, 1e-3));
  assert.ok(near(fresh.albedo[0], WET_THICK[0]) && near(old.albedo[0], DRY[0], 1e-3));
  // Dark red, never bright: no channel of the film above 0.25 linear; red dominates while wet.
  for (const t of [0, 30, 120, 600]) {
    for (const th of [0.05, 0.3, 1]) {
      const l = bloodLook(t, th);
      assert.ok(Math.max(...l.albedo) <= 0.25);
      if (t <= 30) assert.ok(l.albedo[0] > 5 * l.albedo[1]);
      assert.ok(l.alpha >= 0 && l.alpha <= 1);
    }
  }
  // Thin dried films fade a little; thick crusts stay.
  assert.ok(bloodLook(3600, 0.15).alpha < bloodLook(0, 0.15).alpha);
  assert.ok(near(bloodLook(3600, 1).alpha, 1, 1e-6));
});

test('pools spread over a minute; wounds soak outwards', () => {
  assert.equal(poolReach(0), 0);
  assert.equal(poolReach(POOL_DELAY), 0);
  assert.ok(near(poolReach(POOL_DELAY + POOL_TAU), 1 - Math.exp(-1)));
  assert.ok(poolReach(60) > 0.95);
  assert.ok(near(poolReach(POOL_DELAY + 5, 5), 1 - Math.exp(-1)));
  assert.equal(soakRadius(0), 1);
  assert.ok(soakRadius(30) > 1.3 && soakRadius(600) < 1.71);
});

// --- Shapes and flight ---------------------------------------------------------------------

test('a splat stretches by 1 / sin of its impact angle and points the way the blood flew', () => {
  const n = { x: 0, y: 1, z: 0 };
  assert.ok(near(impactShape({ x: 0, y: -5, z: 0 }, n).elongation, 1));
  const s30 = impactShape({ x: Math.cos(Math.PI / 6), y: -Math.sin(Math.PI / 6), z: 0 }, n);
  assert.ok(near(s30.elongation, 2, 1e-9));
  assert.ok(near(s30.alpha, Math.PI / 6, 1e-9));
  assert.equal(impactShape({ x: 1, y: -0.001, z: 0 }, n, 4).elongation, 4);
  // +U of the decal frame (t cos a + b sin a) is the tangential direction of travel.
  for (const [vel, nn] of [
    [{ x: 0.3, y: -1, z: 0.8 }, n],
    [{ x: 1, y: 0.2, z: 0.4 }, { x: -1, y: 0, z: 0 }],
    [{ x: -0.5, y: -0.5, z: 1 }, { x: 0, y: 0, z: -1 }],
  ] as const) {
    const s = impactShape(vel, nn);
    const { t, b } = decalFrame(nn);
    const U = { x: t.x * Math.cos(s.angle) + b.x * Math.sin(s.angle), y: t.y * Math.cos(s.angle) + b.y * Math.sin(s.angle), z: t.z * Math.cos(s.angle) + b.z * Math.sin(s.angle) };
    const vn = vel.x * nn.x + vel.y * nn.y + vel.z * nn.z;
    const T = { x: vel.x - vn * nn.x, y: vel.y - vn * nn.y, z: vel.z - vn * nn.z };
    const tl = Math.hypot(T.x, T.y, T.z);
    assert.ok(near((U.x * T.x + U.y * T.y + U.z * T.z) / tl, 1, 1e-9));
  }
  assert.ok(stainSize(0.002, 6) > stainSize(0.002, 1));
});

test('drops fall with drag towards their terminal speed', () => {
  for (const r of [0.0005, 0.002, 0.004]) {
    const v = { x: 3, y: 0, z: 0 };
    for (let i = 0; i < 600; i++) stepDrop(v, r, 1 / 60);
    assert.ok(near(Math.hypot(v.x, v.y, v.z), terminalSpeed(r), 0.05 * terminalSpeed(r)), `r ${r}`);
    assert.ok(Math.abs(v.x) < 0.05);
  }
  assert.ok(terminalSpeed(0.004) > terminalSpeed(0.0005));
});

// --- Atlas ------------------------------------------------------------------------------------

test('the splat atlas is generated in code, deterministic, with clear tile margins', () => {
  const a = buildSplatAtlas(7), b = buildSplatAtlas(7);
  assert.equal(a.data.length, ATLAS * ATLAS * 4);
  assert.deepEqual(a.data.slice(0, 4096 * 16), b.data.slice(0, 4096 * 16));
  for (const [kind, tiles] of Object.entries(SPLAT_TILES)) {
    for (const t of tiles) {
      const c = tileCoverage(a, t);
      assert.ok(c > 0.03 && c < 0.7, `${kind} ${t} coverage ${c}`);
      const tx = (t % GRID) * TILE, ty = Math.floor(t / GRID) * TILE;
      for (let i = 0; i < TILE; i++) {
        for (const [x, y] of [[i, 0], [i, TILE - 1], [0, i], [TILE - 1, i], [i, MARGIN - 1]]) assert.equal(a.data[((ty + y) * ATLAS + tx + x) * 4], 0);
      }
    }
  }
  // Pools carry an arrival order: the centre first, the rim last.
  const t = SPLAT_TILES.pool[0];
  const [u0, v0, du, dv] = tileRect(t);
  const at = (u: number, v: number) => a.data[(Math.floor((v0 + v * dv) * ATLAS) * ATLAS + Math.floor((u0 + u * du) * ATLAS)) * 4 + 1];
  assert.ok(at(0.5, 0.5) < 60);
});

test('the hurt view closes in only below 40 % health', () => {
  assert.equal(hurtLevel(100, 100), 0);
  assert.equal(hurtLevel(40, 100), 0);
  assert.ok(near(hurtLevel(20, 100), 0.5));
  assert.equal(hurtLevel(0, 100), 1);
  assert.equal(hurtLevel(-5, 100), 1);
});

// --- Original guard ---------------------------------------------------------------------------

test('Original guard: the gore listener is empty and only Enhanced code fills it', () => {
  assert.equal(gore.listener, null);
  const bus = readFileSync('src/game/fx/gore-bus.ts', 'utf8');
  assert.doesNotMatch(bus, /^import (?!type)/m, 'gore-bus imports types only');
  assert.doesNotMatch(bus, /from '[^']*enhanced/);
  // Nothing outside src/app/enhanced imports the gore modules.
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk('src');
  for (const f of files) {
    if (f.startsWith(join('src', 'app', 'enhanced'))) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /(from|import\()\s*'[^']*enhanced\/gore/, f);
  }
  // Every game call site goes through the optional slot (a no-op while it is null).
  const sites = ['src/game/fx/system.ts', 'src/game/fx/effects.ts', 'src/game/world/fx.ts', 'src/game/actors/dismember.ts', 'src/game/actors/system.ts'];
  for (const f of sites) {
    const s = readFileSync(f, 'utf8');
    const uses = s.match(/gore\.listener[^;\n]*/g) ?? [];
    assert.ok(uses.length > 0, f);
    for (const u of uses) assert.match(u, /^gore\.listener(\?\.|\.hit\()/, `${f}: ${u}`);
  }
  // The one non-optional use is guarded by its own test of the slot.
  assert.match(readFileSync('src/game/fx/system.ts', 'utf8'), /if \(gore\.listener\?\.hit\) \{[\s\S]{0,400}gore\.listener\.hit\(/);
  // The fountain tint only ever multiplies when the listener set it.
  assert.match(readFileSync('src/game/world/fx.ts', 'utf8'), /if \(lit && this\.goreTint\) lit\.multiply\(this\.goreTint\);/);
});

test('the gore listener: blood fountains are told apart by colour; dispose empties the slot', async () => {
  const { EnhancedGore } = await import('../src/app/enhanced/gore/index');
  const stages: string[] = [];
  const g = new EnhancedGore({ tier: 'high', addStage: (s) => (stages.push(s), () => {}) });
  try {
    assert.equal(gore.listener, g);
    assert.deepEqual(stages, ['beforeGrade']);
    const tex = (r: number, gg: number, b: number) => {
      const t = new THREE.DataTexture(new Uint8Array([r, gg, b, 255, r, gg, b, 255, r, gg, b, 255, r, gg, b, 255]), 2, 2);
      return t;
    };
    const fountain = (p33: number) => ({ v: Object.assign([], { 33: p33 }), origin: new THREE.Vector3(), particles: [], dead: false, done: false }) as unknown as Parameters<typeof g.fountain>[0];
    // The 1a mouth blood: a grey p33 times a red drip texture.
    const mouth = fountain(0x3f3f3f);
    g.fountain(mouth, [tex(152, 1, 4)]);
    assert.ok(mouth.goreTint);
    // A red p33 on a grey texture is blood too; grey dust is not.
    const red = fountain(0x7d0000);
    g.fountain(red, [tex(170, 170, 170)]);
    assert.ok(red.goreTint);
    const dust = fountain(0x868686);
    g.fountain(dust, [tex(179, 181, 163)]);
    assert.equal(dust.goreTint, undefined);
    // Without a level attached, events do nothing (the faithful effects run).
    assert.equal(g.hit(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), 1), false);
    assert.equal(g.spray([], new THREE.Matrix4()), false);
  } finally {
    g.dispose();
  }
  assert.equal(gore.listener, null);
});
