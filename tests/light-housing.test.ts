// Light Housing (lamp fixtures): the state rules decoded from Suffering.rfl (src/game/world/housing.ts,
// docs/game-logic.md §14.4), the props runtime applying them, and the retail data they rest on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUSING_BROKEN, HOUSING_OFF, HOUSING_ON, housingExtras, housingLights, housingLook, housingStartState } from '../src/game/world/housing';
import { filesWithExt, nodeFS, skip } from './helpers';

const R = (pkg: number, id: number) => ({ pkg, id });

/** A cell-block shade lamp like 1a's 9:2653: 4 materials, glow cone p40, remains p42. */
function lampValues(p31: number) {
  const v: unknown[] = [];
  v[31] = p31;
  v[32] = [R(7, 1860), R(7, 2140), R(4, 1374), R(7, 1863)];
  v[33] = [R(7, 1860), R(7, 2140), R(4, 1373), R(7, 1860)];
  v[34] = [];
  v[38] = 1;
  v[39] = 2;
  v[40] = [R(7, 1884)];
  v[41] = [];
  v[42] = [R(9, 3402)];
  v[43] = [0x7c28];
  v[44] = 1;
  v[45] = 2;
  return v as never[];
}

test('Light Housing state: p31 is the start state (init 0x100162b0), 1 on, else off', () => {
  assert.equal(housingStartState(lampValues(1)), HOUSING_ON);
  assert.equal(housingStartState(lampValues(0)), HOUSING_OFF);
});

test('Light Housing look per state (0x100166d0): tables p32 / p33, spawns p40 / p41 / p42, p38 / p39 to the lights, p43 shown / hidden / removed', () => {
  const v = lampValues(0);
  const on = housingLook(v, HOUSING_ON, 4);
  assert.deepEqual(on.materials, v[32]);
  assert.deepEqual(on.spawns, [R(7, 1884)]);
  assert.equal(on.message, 1);
  assert.equal(on.extras, 'show');
  const off = housingLook(v, HOUSING_OFF, 4);
  assert.deepEqual(off.materials, v[33]);
  assert.deepEqual(off.spawns, []);
  assert.equal(off.message, 2);
  assert.equal(off.extras, 'hide');
  // Broken: the table stays, the remains are spawned, the lights get no message (removed).
  const broken = housingLook(v, HOUSING_BROKEN, 4);
  assert.equal(broken.materials, undefined);
  assert.deepEqual(broken.spawns, [R(9, 3402)]);
  assert.equal(broken.message, undefined);
  assert.equal(broken.extras, 'remove');
  // A table is applied only when it has exactly as many entries as the model has materials
  // (0x100168f6); empty lists leave the model's own.
  assert.equal(housingLook(v, HOUSING_ON, 5).materials, undefined);
  assert.equal(housingLook(v, HOUSING_ON, undefined).materials, undefined);
  const bare = lampValues(1);
  bare[32] = [] as never;
  assert.equal(housingLook(bare, HOUSING_ON, 0).materials, undefined);
  assert.deepEqual(housingExtras(v), [0x7c28]);
});

test('Light Housing lights: only links of category Light Source (engine type 0xe)', () => {
  const ents = new Map([
    [1, { category: 'Light Source' }],
    [2, { category: 'Special Effect' }],
    [3, { category: 'System' }],
  ]);
  assert.deepEqual(housingLights([1, 2, 3, 4], (u) => ents.get(u)), [1]);
});

test('Light Housing runtime: starts in p31, On / Off swap the tables and switch the lights, breaking removes them', async () => {
  const THREE = await import('three/webgpu');
  const { Props } = await import('../src/game/world/props');
  const lamp = 0x5ee4, light = 0x5f30, pool = 0x7c28;
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  const pivot = new THREE.Group();
  root.add(pivot);
  const d = { uid: lamp, root, pivot, local: [], base: root.matrix.clone(), collides: true, visible: true, solid: true, model: { materials: [R(7, 1860), R(7, 2140), R(4, 1373), R(7, 1860)] } };
  const mk = (uid: number, cls: string, category: string, values: unknown[], links: number[] = []) => ({ uid, cls, e: { values, links, category, position: [0, 0, 0], rotation: [0, 0, 0] }, pos: [0, 0, 0], destroyed: false, enabled: true, visible: true, s: {} });
  const lv = Object.assign([], { 4: 1, 5: 2, 6: 1 });
  const ents = new Map([
    [lamp, mk(lamp, 'Light Housing', 'Ground Object', Object.assign(lampValues(0), { 0: 10, 11: 11, 12: 12 }), [light])],
    [light, mk(light, 'Point Light', 'Light Source', lv)],
    [pool, mk(pool, 'Decoration', 'Special Effect', [])],
  ]);
  const visible = new Map<number, boolean>();
  const world = {
    ents,
    of: () => [],
    get: (u: number) => ents.get(u),
    fire: () => {},
    send: () => {},
    handlers: [] as ((w: unknown, msg: number, from: number) => boolean)[],
    destroy: (w: { destroyed: boolean }) => void (w.destroyed = true),
    setVisible: (u: number, v: boolean) => void visible.set(u, v),
  };
  const tables: unknown[] = [];
  const dyn = {
    objects: new Map([[lamp, d]]),
    setMaterials: (_u: number, t: unknown) => void tables.push(t),
    warmMaterials: () => {},
    spawnModel: () => undefined,
    remove: () => {},
    setVisible: () => {},
  };
  const lights = new Map<number, boolean>([[light, true]]);
  const fx = { spawn: () => {} };
  const props = new Props({ world, dyn, fx, packages: new Map(), collision: null, damage: () => undefined, playSound: () => undefined, setLight: (u: number, on: boolean) => void lights.set(u, on), player: () => null, timeScale: () => 1 } as never);
  const h = props.housings.get(lamp)!;
  // p31 = 0: off at load although the light's own p6 is 1; the light pool is hidden.
  assert.equal(h.state, HOUSING_OFF);
  assert.deepEqual(tables.at(-1), lampValues(0)[33]);
  assert.equal(lights.get(light), false);
  assert.equal(visible.get(pool), false);
  const send = (msg: number) => world.handlers.forEach((fn) => fn(ents.get(lamp), msg, 0));
  send(1);
  assert.equal(h.state, HOUSING_ON);
  assert.deepEqual(tables.at(-1), lampValues(0)[32]);
  assert.equal(lights.get(light), true);
  assert.equal(visible.get(pool), true);
  // Save: only the change from the start state.
  const saved = props.save();
  assert.deepEqual(saved.housing, { [lamp]: HOUSING_ON });
  send(2);
  assert.equal(lights.get(light), false);
  props.load(JSON.parse(JSON.stringify(saved)));
  assert.equal(h.state, HOUSING_ON);
  assert.deepEqual(tables.at(-1), lampValues(0)[32]);
  // Shot to pieces (BlowUp p11): broken, its light removed for good, the pool removed.
  send(11);
  assert.equal(h.state, HOUSING_BROKEN);
  assert.equal(lights.get(light), false);
  assert.equal(ents.get(light)!.destroyed, true);
  assert.equal(ents.get(pool)!.destroyed, true);
  send(1);
  assert.equal(h.state, HOUSING_BROKEN, 'a broken lamp does not come back on');
});

test('retail Light Housings: p31 is 0 / 1, p38 / p39 are On / Off, the tables are index-matched, p43 names placed objects', { skip }, async () => {
  const { loadPackages } = await import('../src/app/loader');
  const { readLevelHeader } = await import('../src/formats/level');
  const { parseEntities } = await import('../src/formats/entities');
  const { SrscFile } = await import('../src/formats/srsc');
  const { dirname } = await import('../src/app/gamefs');
  const fs = nodeFS();
  let n = 0, off = 0, flippedOn = 0, deaf = 0;
  for (const path of filesWithExt('.lvl').filter((p) => p.startsWith('LEVELS/'))) {
    const lvl = new SrscFile(await fs.read(path));
    const packages = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, () => {});
    const ents = parseEntities(lvl, packages);
    const by = new Map(ents.map((e) => [e.uid, e]));
    for (const e of ents) {
      if (e.className !== 'Light Housing') continue;
      n++;
      const v = e.values;
      assert.ok(v[31] === 0 || v[31] === 1, `${path} ${e.uid.toString(16)} p31 ${v[31]}`);
      assert.equal(v[38], 1);
      assert.equal(v[39], 2);
      const a = (v[32] as unknown[]) ?? [], b = (v[33] as unknown[]) ?? [];
      assert.equal(a.length, b.length, `${e.uid.toString(16)}: on / off tables differ in length`);
      if (housingStartState(v) === HOUSING_OFF) off++;
      for (const u of housingLights(e.links, (x) => by.get(x))) {
        const l = by.get(u)!;
        // The lamp's On / Off are the light's own inputs (or the light has none).
        assert.ok(l.values[4] === 1 || l.values[4] === 0, `${l.uid.toString(16)} p4 ${l.values[4]}`);
        assert.ok(l.values[5] === 2 || l.values[5] === 0, `${l.uid.toString(16)} p5 ${l.values[5]}`);
        if (l.values[4] === 0) deaf++;
        if (housingStartState(v) === HOUSING_OFF && l.values[6] === 1) flippedOn++;
      }
      for (const u of housingExtras(v)) {
        const t = by.get(u);
        if (t) assert.ok(t.className === 'Decoration' || t.className === 'Light Housing', `${e.uid.toString(16)} p43 -> ${t.className}`);
      }
    }
  }
  assert.equal(n, 679);
  // About half the fixtures start off; 105 of their lights have p6 = 1 and are switched off by
  // the lamp's post-load apply (1a: the fluorescent rooms behind light switch 6847).
  assert.equal(off, 330);
  assert.equal(flippedOn, 105);
  // 28 linked lights have no On / Off inputs (p4 = p5 = 0): the lamp's messages do not reach them.
  assert.equal(deaf, 28);
});

test('1a fixtures: 5ee4 starts off behind switch 6847, cell lamp 5b9f on with its light pool 7c28, shade 62bb leaves remains 9:3402', { skip }, async () => {
  const { loadPackages } = await import('../src/app/loader');
  const { readLevelHeader } = await import('../src/formats/level');
  const { parseEntities } = await import('../src/formats/entities');
  const { readModel } = await import('../src/formats/model');
  const { SrscFile } = await import('../src/formats/srsc');
  const fs = nodeFS();
  const path = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
  const lvl = new SrscFile(await fs.read(path));
  const packages = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, () => {});
  const by = new Map(parseEntities(lvl, packages).map((e) => [e.uid, e]));
  const look = (uid: number, s: 0 | 1 | 2) => {
    const e = by.get(uid)!;
    return housingLook(e.values, s, e.modelRef ? readModel(packages, e.modelRef)?.materials.length : undefined);
  };
  const key = (r: { pkg: number; id: number } | null) => (r ? `${r.pkg}:${r.id}` : '-');
  // Fluorescent 5ee4: p31 overridden to 0; the bulb slot draws Simple 9:5743 off, Advanced 9:5742 on.
  const f = by.get(0x5ee4)!;
  assert.equal(housingStartState(f.values), HOUSING_OFF);
  assert.deepEqual(look(0x5ee4, HOUSING_OFF).materials!.map(key), ['9:4673', '9:5743']);
  assert.deepEqual(look(0x5ee4, HOUSING_ON).materials!.map(key), ['9:4673', '9:5742']);
  assert.deepEqual(housingLights(f.links, (u) => by.get(u)), [0x5f30]);
  assert.equal(by.get(0x5f30)!.values[6], 1);
  assert.ok(by.get(0x6847)!.links.includes(0x5ee4));
  // Cell lamp 5b9f: on, ceiling glow 9:4319 and the floor light pool 7c28 (a Decoration).
  assert.equal(housingStartState(by.get(0x5b9f)!.values), HOUSING_ON);
  assert.deepEqual(look(0x5b9f, HOUSING_ON).spawns.map(key), ['9:4319']);
  assert.deepEqual(housingExtras(by.get(0x5b9f)!.values), [0x7c28]);
  assert.equal(by.get(0x7c28)!.className, 'Decoration');
  // Shade 62bb: off at start (no light), the cone 7:1884 when on, the bulb-less shade when shot.
  assert.equal(housingStartState(by.get(0x62bb)!.values), HOUSING_OFF);
  assert.deepEqual(look(0x62bb, HOUSING_ON).spawns.map(key), ['7:1884']);
  assert.deepEqual(look(0x62bb, HOUSING_BROKEN).spawns.map(key), ['9:3402']);
  // Desk lamp 6829 (9:2991): its model carries neither table (bulb 4:1374); off is the dark 9:6031.
  assert.deepEqual(look(0x6829, HOUSING_OFF).materials!.map(key), ['9:4703', '9:6031']);
});
