// Object model facts recovered from Suffering.rfl / SUFFERING.EXE (docs/re/object-model.md):
// message maps with their inherited slots, catch-all receivers, link-message coverage, instance
// flag bits, and the Switch / Detector runtime behaviour built on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, nodeFS, readSrsc, skip } from './helpers';
import { INSTANCE_FLAGS, parseLevelObjects, readLevelHeader } from '../src/formats/level';
import { CLASS_BY_NAME, CLASSES, PropType, linkCoverage, parseEntities, readObjectTemplate, type EntityPackageSet } from '../src/formats/entities';
import { MESSAGE_MAP_ROWS } from '../src/formats/message-maps';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { World, behindVolume, type WorldHooks } from '../src/game/world/logic';

const cls = (name: string) => {
  const c = CLASS_BY_NAME.get(name);
  assert.ok(c, name);
  return c;
};

// ---------------------------------------------------------------------------------------------
// Generated tables (no game data needed)

test('message maps: every class the factories create has a row; map slots are Enum properties', () => {
  const unknown = [...CLASSES.values()].filter((c) => !c.slotsKnown).map((c) => c.name);
  assert.deepEqual(unknown, ['Advanced Material']); // a material: never placed, never created by the factory
  for (const r of MESSAGE_MAP_ROWS) {
    const c = CLASSES.get(r[0] >>> 0)!;
    for (const i of r[3]) assert.equal(c.types[i], PropType.Enum, `${c.name} p${i}`);
    // A recovered map is authoritative: the class's inputs are exactly its slots.
    if (r[2].length) assert.deepEqual(c.inputs, r[3], c.name);
  }
});

test('message maps: inherited slots through the parent chain', () => {
  // GameObject map 0x10178110: p11 BlowUp, p12 Destroy, p13 / p14 invulnerability on / off.
  // Usable-object map 0x10178608: p28 unlock, p29 lock (vtable +0xd8).
  const sw = cls('Switch');
  assert.deepEqual(sw.messageMaps, [0x1017a218, 0x10178608, 0x10177fe0, 0x10178110]);
  assert.deepEqual(sw.inputs, [11, 12, 13, 14, 28, 29, 61, 62]);
  assert.deepEqual(cls('Light Housing').inputs, [11, 12, 13, 14, 28, 29, 44, 45]);
  // Mechanism and the items chain straight to GameObject: no p28 / p29 inputs.
  assert.deepEqual(cls('Mechanism').inputs, [11, 12, 13, 14, 59, 60, 61, 62, 63, 64, 65, 66]);
  assert.deepEqual(cls('Ammo Box').inputs, [11, 12, 13, 14, 50, 51, 52]);
  // Crane's map has no parent: it ignores Destroy / BlowUp.
  assert.deepEqual(cls('Crane').inputs, [37, 38]);
  // Own-only maps.
  assert.deepEqual(cls('Message Relay').inputs, [4, 5, 6, 7]);
  assert.deepEqual(cls('Detector').inputs, [4, 5, 6]);
  assert.deepEqual(cls('Timer').inputs, [6, 7, 8, 9, 10]);
  // Engine classes (SUFFERING.EXE maps).
  assert.deepEqual(cls('Point Light').inputs, [4, 5]);
  assert.deepEqual(cls('Portal').inputs, [5, 6]);
  assert.deepEqual(cls('Portal').fixedInputs, [0x1031]);
});

test('message maps: fixed message ids, catch-all receivers, outputs', () => {
  const player = cls('Player');
  for (const m of [6, 15, 400, 401, 4097, 4098]) assert.ok(player.fixedInputs.includes(m), `Player fixed ${m}`);
  assert.deepEqual(cls('Animating Static').fixedInputs, [151, 152, 154]);
  assert.equal(cls('Instance Message Filter').catchAll, 'filter');
  assert.equal(cls('Unspeakable NPC').catchAll, 'behaviors');
  assert.equal(cls('Level Transition Msg Handler').catchAll, 'mailbox');
  assert.equal(cls('Teleport Pad').slotsKnown, true);
  assert.deepEqual(cls('Teleport Pad').inputs, []); // the factory returns a shared dummy object
  // Outputs: Switch 64..67 (motion), 68 / 69 (fired by the Player's use code), 27 (used).
  for (const o of [21, 27, 64, 65, 66, 67, 68, 69]) assert.ok(sw().outputs.includes(o), `Switch out ${o}`);
  for (const o of [7, 8, 9]) assert.ok(cls('Detector').outputs.includes(o));
  for (const o of [55, 56, 57, 58]) assert.ok(cls('Mechanism').outputs.includes(o));
  // Destroy (vtable +0x88 = 0x1009b410) fires p21 first on the PhysicalObject classes.
  assert.equal(cls('Breakable').destroyOutput, 21);
  assert.equal(cls('Ammo Box').destroyOutput, 21);
  assert.equal(cls('Unspeakable NPC').destroyOutput, 0);
  assert.equal(cls('Crane').destroyOutput, 0);
});
const sw = () => cls('Switch');

test('behindVolume: the Detector p3 side test uses the negative local Z half-space', () => {
  const box = { c: [0, 0, 0] as [number, number, number], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [[number, number, number], [number, number, number], [number, number, number]], h: [5, 3, 0.5] as [number, number, number] };
  assert.equal(behindVolume(box, [0, 0, -0.2]), true);
  assert.equal(behindVolume(box, [0, 0, 0.2]), false);
  const turned = { ...box, ax: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] as typeof box.ax };
  assert.equal(behindVolume(turned, [0.3, 0, 0]), true);
});

// ---------------------------------------------------------------------------------------------
// Retail data

function levelFiles(): string[] {
  const out: string[] = [];
  const root = join(DATA_ROOT, 'LEVELS');
  for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d))) if (f.toLowerCase().endsWith('.lvl')) out.push(`LEVELS/${d}/${f}`);
  return out.sort();
}

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

test('link messages: every one resolves to a known receiver in all 18 levels', { skip }, async () => {
  const files = levelFiles();
  assert.equal(files.length, 18);
  let sent = 0, handled = 0;
  for (const f of files) {
    const { lvl, packages } = await loadLevel(f);
    const c = linkCoverage(parseEntities(lvl, packages, { resolveStrings: false }));
    assert.equal(c.unknown, 0, `${f}: ${[...c.misses.keys()].join('; ')}`);
    assert.equal(c.slot + c.fixed + c.catchAll + c.ignored, c.sent);
    sent += c.sent;
    handled += c.slot + c.fixed + c.catchAll;
  }
  // Was 81 % heard / 4 % to targets of unknown slots with the static-scan table.
  assert.ok(handled / sent > 0.85, `${handled}/${sent}`);
});

test('instance flags: 0x400 / 0x800 mirror template flag bits 0 / 1; 0x200 only with 0x80', { skip }, async () => {
  let n = 0, bit0 = 0, bit0Same = 0, bit1 = 0, bit1Same = 0, dd = 0;
  for (const f of levelFiles()) {
    const { lvl, packages } = await loadLevel(f);
    for (const o of parseLevelObjects(lvl)) {
      n++;
      if (o.flags & 0x200) assert.ok(o.flags & 0x80, 'flag 0x200 without 0x80');
      if (o.flags & INSTANCE_FLAGS.drawDistance) {
        dd++;
        assert.ok(o.drawDistance! > 0);
      } else assert.equal(o.drawDistance, undefined);
      if (o.flags & INSTANCE_FLAGS.overrideTmpl01) continue;
      const t = readObjectTemplate(packages, o.template);
      if (!t) continue;
      if (o.flags & INSTANCE_FLAGS.tmplBit0 || t.flags & 1) (bit0++, ((o.flags >> 10) & 1) === (t.flags & 1) && bit0Same++);
      if (o.flags & INSTANCE_FLAGS.tmplBit1 || t.flags & 2) (bit1++, ((o.flags >> 11) & 1) === ((t.flags >> 1) & 1) && bit1Same++);
    }
  }
  assert.ok(n > 50000);
  assert.ok(dd > 1000);
  assert.ok(bit0Same / bit0 > 0.98, `bit0 ${bit0Same}/${bit0}`);
  assert.ok(bit1Same / bit1 > 0.98, `bit1 ${bit1Same}/${bit1}`);
});

// ---------------------------------------------------------------------------------------------
// Runtime (level 1a)

const LEVEL_1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

async function world1a(far = true) {
  const { lvl, packages } = await loadLevel(LEVEL_1A);
  const poses: [number, number][] = [];
  const hooks: WorldHooks = {
    player: () => (far ? { feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] } : null),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: (uid, pose) => void poses.push([uid, pose]),
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    hasItem: () => false,
  };
  const world = new World(parseEntities(lvl, packages), packages, hooks, { levelPath: LEVEL_1A });
  world.start();
  world.update(0);
  const got: [number, number][] = [];
  world.subscribe('*', (msg, _from, to) => void got.push([to, msg]));
  return { world, got, poses };
}

test('Switch use: 68 and p27 fire (locked or not), 69 never; a scripted door stays shut (locked)', { skip }, async () => {
  const { world, got } = await world1a();
  // Locked door with p27 = On -> Timer#7a5d (its rattle sound).
  assert.equal(world.useSwitch(world.get(0x56dd)!), 'Locked');
  assert.ok(got.some(([to, m]) => to === 0x7a5d && m === 1), 'p27 reached the timer');
  // Exit to 1b: 68 (On) -> Timer#79b3 only; 69 (Triggered) -> Relay#8b44 must not be sent.
  got.length = 0;
  world.get(0x79b2)!.s.unlocked = true;
  world.useSwitch(world.get(0x79b2)!);
  assert.ok(got.some(([to, m]) => to === 0x79b3 && m === 1));
  assert.ok(!got.some(([to, m]) => m === 6 && to === 0x8b44), 'first-person output 69 (Triggered) was sent');
  // Scripted door: p23 is NOT a usability flag (light switches and lockers have p23 = 0 too);
  // this door starts locked (p22 = 0), so a player use reports Locked and it stays shut.
  const scripted = world.get(0x56f3)!;
  assert.equal(world.useSwitch(scripted), 'Locked');
  assert.equal(scripted.s.open, false);
});

test('Switch: p36 starts open; p41 closes again after p42 s once the player is away', { skip }, async () => {
  const { world, poses } = await world1a();
  const open = world.get(0x49ef)!;
  assert.equal(open.s.open, true);
  assert.ok(poses.some(([uid, p]) => uid === 0x49ef && p === 1));
  const auto = world.get(0x4a5d)!;
  assert.equal(auto.s.open, false);
  world.switchSet(auto, true);
  for (let i = 0; i < 200 && !auto.s.open; i++) world.update(0.05);
  assert.equal(auto.s.open, true);
  assert.ok((auto.s.closeIn as number) > 6.5 && (auto.s.closeIn as number) <= 7, String(auto.s.closeIn));
  for (let i = 0; i < 150; i++) world.update(0.05); // 7.5 s
  assert.equal(auto.s.target, 0, 'auto-close started');
});

test('Destroy on a PhysicalObject fires p21 to its links first', { skip }, async () => {
  const { world, got } = await world1a();
  // Breakable#7c73: p12 Destroy, p21 = Destroy -> Object Generator#7c74 + two relays.
  world.send(0x7c73, 12, 0);
  world.update(0);
  assert.equal(world.get(0x7c73)!.destroyed, true);
  assert.ok(got.some(([to, m]) => to === 0x8a60 && m === 12));
});
