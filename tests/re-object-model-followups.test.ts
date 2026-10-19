// Follow-ups of the object-model work (docs/re/object-model.md §6..§9): usable-object property
// names, the Switch's locked feedback sound, Animating Static attachment sets (SpawnAttachments),
// Ring Damage + Killjoy Rebirth Effect (Player DestroyRebirthFX) and the Sound Effect /
// BouncingObject AI noises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { readSrsc, nodeFS, skip } from './helpers';
import { CLASSES, CLASS_BY_NAME, USABLE_OBJECT_CLASSES, USABLE_OBJECT_MAP, parseEntities, readObjectTemplate, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import type { ResRef } from '../src/formats/model';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World, type WorldHooks } from '../src/game/world/logic';
import { readTemplate, type Generator } from '../src/game/world/fx';
import { Attachments, SPAWN_ATTACHMENTS, attachmentPairs, followMatrices, killOwned } from '../src/game/fx/attachments';
import { DESTROY_REBIRTH_FX, Rebirth, ringBand, ringHits } from '../src/game/fx/rebirth';
import { billboardParams } from '../src/game/fx/billboards';
import { createInventory } from '../src/game/world/inventory';
import { npcBodyPartSlots } from '../src/game/weapons/npc';

async function loadLevel(path: string) {
  const lvl = readSrsc(path);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const packages = (await loadPackages(nodeFS(), dirname(path), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return { lvl, packages };
  } finally {
    console.warn = warn;
  }
}

// ---------------------------------------------------------------------------------------------
// Names (no game data needed)

test('usable objects: p22 unlocked, p23 usable, p28 / p29 inUnlock / inLock on exactly the usable-object map classes', () => {
  const withMap = [...CLASSES.values()].filter((c) => c.messageMaps.includes(USABLE_OBJECT_MAP)).map((c) => c.name);
  assert.deepEqual(new Set(withMap), USABLE_OBJECT_CLASSES);
  for (const name of USABLE_OBJECT_CLASSES) {
    const c = CLASS_BY_NAME.get(name)!;
    assert.deepEqual([22, 23, 28, 29].map((i) => c.propNames[i]), ['unlocked', 'usable', 'inUnlock', 'inLock'], name);
    assert.ok(c.inputs.includes(28) && c.inputs.includes(29), name);
  }
  // Other PhysicalObjects use these indices for other things (Animating Static p23: animations).
  const as = CLASS_BY_NAME.get('Animating Static')!;
  assert.deepEqual([22, 23, 28, 29].map((i) => as.propNames[i]), ['p22', 'p23', 'p28', 'p29']);
  assert.ok(!as.inputs.includes(28));
  assert.equal(CLASS_BY_NAME.get('Ammo Box')!.propNames[22], 'pickupName');
  for (const c of CLASSES.values()) assert.ok(!c.propNames.includes('inEnableUse') && !c.propNames.includes('inDisableUse'), c.name);
});

// ---------------------------------------------------------------------------------------------
// Attachment sets (synthetic)

type FakeFx = { generators: Generator[]; spawned: string[]; spawn(r: ResRef, M: THREE.Matrix4): void };
function fakeFx(): FakeFx {
  const fx: FakeFx = {
    generators: [],
    spawned: [],
    spawn(r) {
      fx.spawned.push(`${r.pkg}:${r.id}`);
      // Templates with id 1 leave a running generator behind.
      if (r.id === 1) fx.generators.push({ dead: false, running: true, stop() { this.running = false; } } as unknown as Generator);
    },
  };
  return fx;
}

test('attachment pairs: p49 hardpoints with p50 templates, -1 / missing entries dropped, order kept', () => {
  const v: PropValue[] = [];
  v[49] = [5, -1, 7, 9];
  v[50] = [{ pkg: 3, id: 1 }, { pkg: 3, id: 2 }, null, { pkg: 3, id: 4 }];
  assert.deepEqual(attachmentPairs(v), [
    { hp: 5, ref: { pkg: 3, id: 1 } },
    { hp: 9, ref: { pkg: 3, id: 4 } },
  ]);
  const w: PropValue[] = [];
  w[49] = [5];
  w[50] = [{ pkg: 3, id: 1 }, { pkg: 3, id: 2 }];
  assert.equal(attachmentPairs(w).length, 1, 'pairs stop at the shorter list');
});

test('Attachments: 154 / p45 spawn on free hardpoints, p46 and a gone carrier remove them', () => {
  const fx = fakeFx();
  let gone = false;
  const att = new Attachments({
    wfx: fx,
    classOf: (r) => (r.id === 9 ? 'Point Light' : 'Object Generator'),
    hardpoint: (_uid, hp, out) => (hp < 8 ? (out.makeTranslation(hp, 0, 0), true) : false),
    gone: () => gone,
  });
  const v: PropValue[] = [];
  v[45] = 1;
  v[46] = 2;
  v[49] = [5, 6, 20, 7];
  v[50] = [{ pkg: 3, id: 1 }, { pkg: 3, id: 3 }, { pkg: 3, id: 1 }, { pkg: 3, id: 9 }];
  const w = { uid: 0x13f3, cls: 'Animating Static', destroyed: false, e: { values: v } } as never;
  assert.equal(att.handler(w, SPAWN_ATTACHMENTS), true);
  // hp 20 is beyond the model, the Point Light is not attached.
  assert.deepEqual(fx.spawned, ['3:1', '3:3']);
  assert.deepEqual(att.held(0x13f3).map((a) => [a.hp, a.generators]), [[5, 1], [6, 0]]);
  assert.equal(fx.generators.length, 1);
  // Occupied hardpoints are skipped: p45 (On) again spawns nothing new.
  assert.equal(att.handler(w, 1), true);
  assert.equal(fx.spawned.length, 2);
  // p46 (Off) removes them and stops their generators.
  const g = fx.generators[0];
  assert.equal(att.handler(w, 2), true);
  assert.equal(att.held(0x13f3).length, 0);
  assert.equal(fx.generators.length, 0);
  assert.equal(g.dead, true);
  // Spawn again; the carrier breaking takes them away.
  att.handler(w, SPAWN_ATTACHMENTS);
  assert.equal(att.held(0x13f3).length, 2);
  gone = true;
  att.update();
  assert.equal(att.held(0x13f3).length, 0);
  // Not an Animating Static / unrelated message: not handled.
  assert.equal(att.handler({ ...(w as object), cls: 'Switch' } as never, SPAWN_ATTACHMENTS), false);
  assert.equal(att.handler(w, 7), false);
});

test('Attachments p53: the set is created once the carrier resolves; lights attached, worn models only recorded', () => {
  const fx = fakeFx();
  let ready = false;
  const cls: Record<number, string> = { 1: 'Object Generator', 9: 'Point Light', 965: 'TargetableBreakable' };
  const att = new Attachments({
    wfx: fx,
    classOf: (r) => cls[r.id],
    light: (r) => (r.id === 9 ? { r: 0.7, g: 0.6, b: 0.4, intensity: 3.2, hemi: 0 } : undefined),
    hardpoint: (_uid, hp, out) => ready && hp < 20 && (out.makeTranslation(hp, 2, 0), true),
    gone: () => false,
  });
  const v: PropValue[] = [];
  v[45] = 1;
  v[46] = 2;
  v[49] = [7, 18, 5];
  v[50] = [{ pkg: 7, id: 9 }, { pkg: 10, id: 965 }, { pkg: 3, id: 1 }];
  v[53] = 1;
  const w = { uid: 0x6430, cls: 'Animating Static', destroyed: false, e: { values: v } };
  const off = { uid: 0x6431, cls: 'Animating Static', destroyed: false, e: { values: [...v.slice(0, 53), 0] } };
  const world = { handlers: [] as unknown[], of: (c: string) => (c === 'Animating Static' ? [w, off] : []) };
  att.install(world as never);
  assert.equal(att.pendingCount, 1, 'only p53 sets are created');
  att.update(0.1);
  assert.equal(att.held(0x6430).length, 0, 'carrier not there yet');
  ready = true;
  att.update(0.1);
  assert.equal(att.pendingCount, 0);
  assert.deepEqual(
    att.held(0x6430).map((a) => [a.hp, a.light, a.worn, a.generators]),
    [
      [7, true, false, 0],
      [18, false, true, 0],
      [5, false, false, 1],
    ],
  );
  assert.deepEqual(fx.spawned, ['3:1'], 'the head is not spawned through the FX runtime (weapons/npc.ts wears it)');
  const out: { x: number; y: number; intensity: number }[] = [];
  att.lightsOut(out as never);
  assert.deepEqual(out.map((l) => [l.x, l.y, l.intensity]), [[7, 2, 3.2]], 'the light sits on its bone');
  // 154 again: every slot is taken, nothing doubles.
  assert.equal(att.handler(w as never, SPAWN_ATTACHMENTS), true);
  assert.equal(att.held(0x6430).length, 3);
  assert.equal(fx.spawned.length, 1);
  // p46 (Off) removes the light with the rest; p45 (On) brings the light and generator back.
  att.handler(w as never, 2);
  assert.equal(att.lightCount, 0);
  att.handler(w as never, 1);
  assert.equal(att.lightCount, 1);
  assert.deepEqual(att.held(0x6430).map((a) => a.hp), [7, 5], 'worn models are not spawned by message');
});

test('retail: caged CartWheelers wear the Slayer head through their p53 set (1a), lamps carry Point Lights (1b)', { skip }, async () => {
  const { lvl, packages } = await loadLevel('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl');
  const caged = parseEntities(lvl, packages, { resolveStrings: false }).filter((e) => e.className === 'Animating Static' && e.template?.pkg === 10 && e.template.id === 635);
  assert.equal(caged.length, 7);
  for (const e of caged) {
    const slots = npcBodyPartSlots(packages as never, { entity: e, kind: { template: e.template! } } as never);
    assert.deepEqual(slots.map((s) => [s.bone, `${s.part.pkg}:${s.part.id}`]), [[18, '10:965']]);
  }
  // 1b lamps: their Point Lights belong to fx/attachments.ts, not to the worn models.
  const b = await loadLevel('LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl');
  const lamps = parseEntities(b.lvl, b.packages, { resolveStrings: false }).filter((e) => e.className === 'Animating Static' && e.values[53] === 1 && attachmentPairs(e.values).some((p) => readTemplate(b.packages, p.ref)?.cls === 'Point Light'));
  assert.ok(lamps.length >= 15, String(lamps.length));
  for (const e of lamps) assert.equal(npcBodyPartSlots(b.packages as never, { entity: e, kind: { template: e.template! } } as never).length, 0, 'lights are not worn models');
});

test('killOwned stops generators and drops them from the runtime list', () => {
  const fx = fakeFx();
  fx.spawn({ pkg: 1, id: 1 }, new THREE.Matrix4());
  fx.spawn({ pkg: 1, id: 1 }, new THREE.Matrix4());
  const mine = [fx.generators[1]];
  killOwned(fx, mine);
  assert.equal(fx.generators.length, 1);
  assert.equal(mine.length, 0);
});

test('spawned Billboard: life p4, size p2..p3 up to p9 m', () => {
  const v: PropValue[] = [[{ pkg: 3, id: 257 }], 10, 0.1, 7, 0.1, 100, 0, 0, 35, 40];
  assert.deepEqual(billboardParams(v), { life: 0.1, size: [0.1, 7], far: 40 });
});

// ---------------------------------------------------------------------------------------------
// Ring Damage / Killjoy Rebirth Effect (synthetic)

const RING: PropValue[] = [0, 0.1, 0.5, 0.66, 0.66, 3.5, 0, [{ pkg: 4, id: 1325 }], null, 0, 17]; // 3:4555
const REBIRTH: PropValue[] = [];
REBIRTH[18] = 8;
REBIRTH[19] = [{ pkg: 4, id: 804 }];
REBIRTH[20] = { pkg: 4, id: 1 };
REBIRTH[21] = 35;

test('Ring Damage: an annulus p0 + p3 t .. p1 + p4 t wide, p2 m tall, gone after p5 s', () => {
  assert.deepEqual(ringBand(RING, 1), { inner: 0.66, outer: 0.76, height: 0.5, life: 3.5 });
  const c = { x: 0, y: 0, z: 0 };
  assert.equal(ringHits(RING, 1, c, { x: 0.7, y: 0, z: 0 }, 1.8), true);
  assert.equal(ringHits(RING, 1, c, { x: 0.5, y: 0, z: 0 }, 1.8), false, 'inside the ring');
  assert.equal(ringHits(RING, 1, c, { x: 0.9, y: 0, z: 0 }, 1.8), false, 'outside the ring');
  assert.equal(ringHits(RING, 1, c, { x: 0.7, y: 0.6, z: 0 }, 1.8), false, 'jumped over it');
  assert.equal(ringHits(RING, 1, c, { x: 0, y: 0, z: 0.7 }, 1.8), true);
});

test('Killjoy Rebirth Effect: ring hit puts one on the player, a second refreshes, DestroyRebirthFX removes it', () => {
  assert.equal(DESTROY_REBIRTH_FX, 105);
  const fx = fakeFx();
  // The player's inventory, keyed by template: 3 regular Shrapnel Grenades 4:655 share the
  // display name of the effect's 4:804.
  const inv = createInventory(new Map());
  inv.add('Shrapnel Grenade', 3, { pkg: 4, id: 655 }, 'Missile Item');
  const stows: string[] = [];
  const player = new THREE.Vector3(1.5, 0, 0);
  const g804 = { pkg: 4, id: 804 };
  const rb = new Rebirth({
    wfx: fx,
    template: (r) => (r.id === 1325 ? { ref: r, cls: 'Killjoy Rebirth Effect', values: REBIRTH } : undefined),
    player: () => player,
    playerHardpoint: (hp, out) => (hp === 35 ? (out.makeTranslation(player.x, 1.2, player.z), true) : false),
    items: { count: (r) => inv.count(r), give: (r, n) => inv.add('Shrapnel Grenade', n, r, 'Missile Item'), removeAll: (r) => inv.remove(r) },
    stow: () => void stows.push('stow'),
    unstow: () => void stows.push('unstow'),
  });
  const ringTpl = { ref: { pkg: 3, id: 4555 }, cls: 'Ring Damage', values: RING };
  assert.equal(rb.spawner(ringTpl, new THREE.Matrix4()), true);
  assert.equal(rb.spawner({ ...ringTpl, cls: 'Fire' }, new THREE.Matrix4()), false);
  for (let i = 0; i < 80 && rb.ringCount; i++) rb.update(0.05);
  // 1.5 m away: reached after ~2.1 s.
  assert.equal(rb.ringCount, 0);
  assert.equal(rb.effectActive, true);
  assert.deepEqual(fx.spawned, ['4:1'], 'p20 spawned on the hand');
  assert.equal(inv.count(g804), 8, 'topped up to p18');
  assert.equal(inv.count({ pkg: 4, id: 655 }), 3, 'the regular grenades stay apart');
  assert.deepEqual(stows, ['stow']);
  // Two thrown, then a second ring: refresh tops up to 8 again (no second hand effect).
  inv.remove(g804, 2);
  rb.spawner(ringTpl, new THREE.Matrix4());
  for (let i = 0; i < 80 && rb.ringCount; i++) rb.update(0.05);
  assert.deepEqual(fx.spawned, ['4:1']);
  assert.equal(inv.count(g804), 8);
  assert.equal(fx.generators.length, 1);
  assert.deepEqual(stows, ['stow'], 'a refresh does not stow again');
  // A ring the player is not on expires after p5 s.
  player.set(10, 0, 0);
  rb.spawner(ringTpl, new THREE.Matrix4());
  for (let i = 0; i < 80; i++) rb.update(0.05);
  assert.equal(rb.ringCount, 0);
  assert.equal(inv.count(g804), 8);
  // DestroyRebirthFX: every 4:804 taken, the 4:655 kept, weapons out again.
  assert.equal(rb.destroy(), true);
  assert.equal(rb.effectActive, false);
  assert.equal(fx.generators.length, 0);
  assert.equal(inv.count(g804), 0);
  assert.equal(inv.has(g804), false);
  assert.equal(inv.count({ pkg: 4, id: 655 }), 3);
  assert.deepEqual(stows, ['stow', 'unstow']);
  assert.equal(rb.destroy(), false, 'no effect: nothing to destroy');
});

test('followMatrices marks the live matrices of attachments', () => {
  const fx = fakeFx();
  const att = new Attachments({ wfx: fx, classOf: () => 'Object Generator', hardpoint: (_u, _h, out) => (out.identity(), true), gone: () => false });
  let seen: THREE.Matrix4 | undefined;
  fx.spawn = (_r, M) => void (seen = M);
  const v: PropValue[] = [];
  v[49] = [1];
  v[50] = [{ pkg: 3, id: 2 }];
  att.spawn(1, v);
  assert.ok(seen && followMatrices.has(seen));
});

// ---------------------------------------------------------------------------------------------
// Retail data

const LEVEL_1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

function hooks1a(over: Partial<WorldHooks> = {}): WorldHooks {
  return {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    hasItem: () => false,
    ...over,
  };
}

test('Switch locked feedback: p39 plays the interaction template p23 sound at the door (1a)', { skip }, async () => {
  const { lvl, packages } = await loadLevel(LEVEL_1A);
  const played: { uid: number; keys: string[]; effect?: boolean }[] = [];
  const world = new World(parseEntities(lvl, packages), packages, hooks1a({ playSound: (uid, keys, _p, o) => void played.push({ uid, keys, effect: o.effect }) }), { levelPath: LEVEL_1A });
  world.start();
  world.update(0);
  // Switch#56dd: locked, usable, p39 = 1; open interactions 2:395 / 2:396 both name sound 2:198.
  const door = world.get(0x56dd)!;
  assert.equal(door.s.unlocked, false);
  assert.equal(door.e.props.unlocked, 0);
  assert.equal(door.e.props.p39, 1);
  played.length = 0;
  assert.equal(world.useSwitch(door), 'Locked');
  assert.deepEqual(played.filter((p) => p.uid === 0x56dd), [{ uid: 0x56dd, keys: ['2:198'], effect: true }]);
  // Unlocked: no locked sound.
  played.length = 0;
  door.s.unlocked = true;
  world.useSwitch(door);
  assert.equal(played.filter((p) => p.uid === 0x56dd).length, 0);
  // Every locked, usable door with p39 in 1a has interaction sounds, and both sides share them.
  let n = 0;
  for (const w of world.of('Switch')) {
    const v = w.e.values;
    if (!w.e.props.usable || w.e.props.unlocked || !v[39]) continue;
    const sounds = new Set(
      (v[30] as ResRef[]).map((r) => {
        const t = readTemplate(packages, r)!;
        return JSON.stringify(t.values[23]);
      }),
    );
    assert.equal(sounds.size, 1, `Switch#${w.uid.toString(16)}`);
    n++;
  }
  assert.ok(n >= 8, String(n));
});

test('Sound Effect p8: AI noise when it starts in play mode p3 = 0 (synthetic values on a 1a object)', { skip }, async () => {
  const { lvl, packages } = await loadLevel(LEVEL_1A);
  const noises: [number[], string][] = [];
  const world = new World(
    parseEntities(lvl, packages),
    packages,
    hooks1a({ playSound: () => ({ stop() {}, playing: true }), noise: (at, r) => void noises.push([at, `${r.pkg}:${r.id}`]) }),
    { levelPath: LEVEL_1A },
  );
  world.start();
  world.update(0);
  const se = world.of('Sound Effect').find((w) => Array.isArray(w.e.values[0]) && (w.e.values[0] as unknown[]).length)!;
  const inPlay = se.e.values[14] as number;
  se.e.values[8] = { pkg: 2, id: 441 };
  se.e.values[3] = 0;
  noises.length = 0;
  world.send(se.uid, inPlay, 0);
  world.update(0);
  assert.deepEqual(noises.map((n) => n[1]), ['2:441']);
  se.e.values[3] = 2;
  noises.length = 0;
  world.send(se.uid, inPlay, 0);
  world.update(0);
  assert.equal(noises.length, 0, 'other play modes make no noise');
});

test('retail: 5b SpawnAttachments targets, DestroyRebirthFX senders; no template sets the noise properties', { skip }, async () => {
  const { lvl, packages } = await loadLevel('LEVELS/5 Asylum/5b Asylum.lvl');
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  const targets = new Set<number>();
  let rebirth = 0;
  for (const e of ents) {
    for (const o of e.outputs) {
      for (const u of e.links) {
        const t = byUid.get(u);
        if (o.message === SPAWN_ATTACHMENTS && t) targets.add(u);
        if (o.message === DESTROY_REBIRTH_FX && t?.className === 'Player') rebirth++;
      }
    }
  }
  assert.equal(targets.size, 12); // projectors (model 7:178) driven by relays
  for (const u of targets) {
    const e = byUid.get(u)!;
    assert.equal(e.className, 'Animating Static');
    assert.ok(e.fixedInputs.includes(SPAWN_ATTACHMENTS));
    assert.deepEqual(attachmentPairs(e.values).map((p) => [p.hp, `${p.ref.pkg}:${p.ref.id}`]), [[5, '3:2158']]);
  }
  assert.equal(rebirth, 1);
  // Ring Damage 3:4555 -> victim effect 4:1325 (Killjoy Rebirth Effect).
  const ring = readTemplate(packages, { pkg: 3, id: 4555 })!;
  assert.equal(ring.cls, 'Ring Damage');
  assert.equal(readTemplate(packages, (ring.values[7] as ResRef))!.cls, 'Killjoy Rebirth Effect');
  // Sound Effect p8 / BouncingObject p64 are unset in every loaded template.
  let checked = 0;
  for (const [pkg, p] of packages as Map<number, { odu?: { entries: { type: number; group: number; id: number }[] } }>) {
    for (const en of p.odu?.entries ?? []) {
      if (en.group !== 1) continue;
      const t = readObjectTemplate(packages, { pkg, id: en.id });
      const cls = t && CLASSES.get(t.classHash);
      if (!t || (cls?.name !== 'Sound Effect' && cls?.name !== 'BouncingObject')) continue;
      const tv = readTemplate(packages, { pkg, id: en.id })!.values;
      assert.equal(tv[cls.name === 'Sound Effect' ? 8 : 64] ?? null, null, `${cls.name} ${pkg}:${en.id}`);
      checked++;
    }
  }
  assert.ok(checked > 100, String(checked));
});
