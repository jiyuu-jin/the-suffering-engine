// The Flare key (docs/game-logic.md §4.5 "Flare key"; src/game/weapons/system.ts throwFlare,
// back-throwable.ts, thrown-light.ts; the Unspeakable.cfg carry in src/app/menu/original-profile.ts).
// Decoded from Suffering.rfl: the default record {0x427, keyboard, DIK_T} (table 0x10167520), the
// input handler 0x10049c67 (Player p243 counted, +0x9c bit 0x40000), the Throw enter 0x10027b69,
// AttachThrownWeapon's flare branch 0x1002aed5, the state transition table 0x10175150.
// The data tests run against a local game install and skip without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { readDbId, type PackageSet, type ResRef } from '../src/formats/model';
import { SrscFile } from '../src/formats/srsc';
import type { EntityPackageSet } from '../src/formats/entities';
import { peOffset, readPe } from '../src/formats/pe';
import { bindingInput, bindingInputs, readDefaultBindings, RFL_DEFAULT_BINDINGS, withBindingInputs, type KeyBinding } from '../src/formats/save-original';
import { RETAIL_PC_KEYS } from '../src/app/player-rules';
import { ACTIONS, defaultBindings, padLayout, PAD_LAYOUT_COUNT } from '../src/game/hud/bindings';
import { ACTION_ORDER } from '../src/game/hud/actions';
import { carriedThrowable, stepThrowable, throwableAfterEmpty } from '../src/game/weapons/back-throwable';
import { tpl, weaponDef } from '../src/game/weapons/data';
import { thrownLightAt, thrownLightDefs } from '../src/game/weapons/thrown-light';
import { CARRIED_BINDINGS, exportedBindings, importedBindings } from '../src/app/menu/original-profile';
import { readFrontEnd } from '../src/formats/gui';
import { StringDb } from '../src/formats/strings';

const FLARE = 0x427;
const rec = (action: number, device: number, code: number): KeyBinding => ({ action, device, code, lo: -1, hi: 1 });

test('Flare key: bound to T on the keyboard, no pad cell (as the original), its own action', () => {
  const b = defaultBindings();
  assert.deepEqual(b.keys.flare, ['KeyT', '']);
  assert.equal(b.pad.flare, '');
  for (let i = 0; i < PAD_LAYOUT_COUNT; i++) assert.equal(padLayout(i).flare, undefined, `layout ${i}`);
  assert.equal(ACTIONS.indexOf('flare'), 21, 'the keyboard page row after Flashlight (p30[21])');
  assert.deepEqual(RETAIL_PC_KEYS.flare, { id: FLARE, keys: ['KeyT'] });
  // It throws: it is no longer a selection hotkey.
  assert.equal(ACTION_ORDER.flare, undefined);
});

test('the back: only the selected throwable, no fallback; Next / Prev Thrown skip the flare', () => {
  const owned = [{ key: '4:455' }, { key: '4:284' }, { key: '4:236' }];
  assert.equal(carriedThrowable(owned, null), null, 'nothing taken out: the back stays empty');
  assert.equal(carriedThrowable([{ key: '4:455' }], null), null, 'only flares left: empty');
  assert.equal(carriedThrowable(owned, '4:455')?.key, '4:455', 'a flare given onto an empty back is carried');
  assert.equal(carriedThrowable(owned, '4:249'), null, 'a selection no longer carried');
  const cycle = new Set(['4:284', '4:655', '4:236', '4:249']);
  assert.equal(stepThrowable(owned, '4:284', 1, cycle)?.key, '4:236');
  assert.equal(stepThrowable(owned, '4:236', 1, cycle)?.key, '4:284', 'wraps, skipping the flare');
  assert.equal(stepThrowable(owned, '4:284', -1, cycle)?.key, '4:236');
  assert.equal(stepThrowable(owned, '4:455', 1, cycle), null, 'from the flare: no step (0x10048c22)');
  assert.equal(stepThrowable(owned, null, 1, cycle), null, 'from an empty back: no step');
});

test('Unspeakable.cfg: DirectInput / mouse records as port codes; the Flare binding carried both ways', () => {
  assert.equal(bindingInput(rec(FLARE, 0, 0x14)), 'KeyT');
  assert.equal(bindingInput(rec(0x429, 1, 7)), 'Mouse2');
  assert.equal(bindingInput(rec(0x429, 0, 0x4e)), 'NumpadAdd');
  assert.equal(bindingInput(rec(0x40b, 1, 2)), '', 'mouse axes have no port code');
  const file = [rec(0x426, 0, 0x21), rec(FLARE, 0, 0x14), rec(0x40b, 1, 2), rec(0x429, 1, 7)];
  assert.deepEqual(CARRIED_BINDINGS, [['flare', FLARE]]);
  assert.deepEqual(importedBindings(file), { flare: ['KeyT', ''] });
  assert.deepEqual(importedBindings([rec(FLARE, 0, 0x22), rec(FLARE, 1, 8)]), { flare: ['KeyG', 'Mouse1'] });
  assert.deepEqual(importedBindings([rec(0x426, 0, 0x21)]), {}, 'a file without the action leaves the port row');
  // Export: the port's Flare row replaces the file's 0x427 records in place; the rest are kept.
  const out = exportedBindings(file, { flare: ['KeyY', 'Mouse3'] });
  assert.deepEqual(out, [rec(0x426, 0, 0x21), rec(FLARE, 0, 0x15), rec(FLARE, 1, 9), rec(0x40b, 1, 2), rec(0x429, 1, 7)]);
  assert.deepEqual(bindingInputs(out, FLARE), ['KeyY', 'Mouse3']);
  assert.deepEqual(exportedBindings(file, { flare: ['', ''] }).filter((b) => b.action === FLARE), [], 'unbound: no record');
  assert.deepEqual(exportedBindings([], { flare: ['KeyT', ''] }), [], 'no table to write into: left empty');
  assert.deepEqual(withBindingInputs([rec(0x426, 0, 0x21)], FLARE, ['KeyT']), [rec(0x426, 0, 0x21), rec(FLARE, 0, 0x14)], 'appended');
});

// ---------------------------------------------------------------------------------------------
// Data

let cache: Map<number, Record<string, unknown>> | undefined;
function packages() {
  if (cache) return cache;
  const out = new Map<number, Record<string, unknown>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || out.has(id)) continue;
    const base = join(DATA_ROOT, db.slice(0, -3));
    const p: Record<string, unknown> = { id };
    for (const ext of ['odu', 'xdu', 'mdu', 'adu', 'wdu']) {
      try {
        const b = readFileSync(`${base}.${ext}`);
        p[ext] = new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch {
        // missing container
      }
    }
    out.set(id, p);
  }
  return (cache = out);
}

const rfl = () => new Uint8Array(readFileSync(join(DATA_ROOT, 'Suffering.rfl')));
function rflBytes(va: number, n: number): string {
  const b = rfl();
  const o = peOffset(readPe(b), va);
  return Buffer.from(b.subarray(o, o + n)).toString('hex');
}

test('the RFL default table: every gameplay record translates to RETAIL_PC_KEYS; Flare is T', { skip }, () => {
  const b = rfl();
  const table = readDefaultBindings(b, peOffset(readPe(b), RFL_DEFAULT_BINDINGS));
  assert.equal(table.length, 110);
  assert.deepEqual(table.filter((r) => r.action === FLARE), [rec(FLARE, 0, 0x14)]);
  assert.ok(table.every((r) => r.device === 0 || r.device === 1), 'no pad records on PC');
  for (const [name, k] of Object.entries(RETAIL_PC_KEYS)) {
    const got = bindingInputs(table, k.id);
    assert.deepEqual([...got].sort(), [...k.keys].sort(), `${name} 0x${k.id.toString(16)}`);
  }
});

test('the Flare key in the code: p243 counted, bit 0x40000, the flare branch spawns p243', { skip }, () => {
  // Input handler: push 1; push 0x427 (pressed), then the Player p243 item count (0x100415d0).
  assert.equal(rflBytes(0x10049c6f, 7), '6a016827040000');
  assert.equal(rflBytes(0x10049c8b, 7), '8bcee83e79ffff');
  // Throw enter: test +0x9c 0x40000, then the same count.
  assert.equal(rflBytes(0x10027b69, 10), 'f7869c00000000000400');
  // AttachThrownWeapon: +0x9c bit 18 (0x40000) chooses Player p243 (push 0xf3) over the back.
  assert.equal(rflBytes(0x1002aed5, 9), '8b839c000000c1e812');
  assert.equal(rflBytes(0x1002aefb, 7), '6aff68f3000000');
});

test('the state table: what refuses the throw (Throw and Flare keys alike)', { skip }, () => {
  const b = rfl();
  const at = peOffset(readPe(b), 0x10175150);
  const v = (nw: number, old: number) => new DataView(b.buffer, b.byteOffset + at + 4 * (nw * 35 + old), 4).getUint32(0, true);
  const THROW = 21;
  // Refused while: death 0, Controlled 11, Landing 12, Jump Melee 14, Roll 15, Hit Reacting 17,
  // Morph 19, Insanity (creature form) 20, Throw 21, Interact 22, View Monitor 23, Equip 25,
  // Item Pickup 26, LadderClimb 27, Insanity Attack 29 / 30, Document View 31, Play Anim 33, Freak Out 34.
  const refused = [0, 11, 12, 14, 15, 17, 19, 20, 21, 22, 23, 25, 26, 27, 29, 30, 31, 33, 34];
  const ends = [3, 4, 7, 18, 24, 28, 32];
  for (let s = 0; s < 35; s++) assert.equal(v(THROW, s), refused.includes(s) ? 0 : ends.includes(s) ? 2 : 1, `throw during state ${s}`);
  // While it runs: no attack, strike, roll, reload, second throw, interaction, equip or ladder.
  for (const s of [3, 4, 15, 18, 21, 22, 25, 27, 32]) assert.equal(v(s, THROW), 0, `state ${s} during the throw`);
});

test('flare data: Player p243 / p248 / p283, the item, its thrown object and its light', { skip }, () => {
  const all = packages();
  const epk = all as unknown as EntityPackageSet, pkgs = all as unknown as PackageSet;
  const player = tpl(epk, { pkg: 2, id: 5 })!;
  assert.deepEqual(player.v[243], { pkg: 4, id: 455 }, 'the Flare key item');
  assert.equal(player.v[283], null, 'no flare count widget on the HUD');
  // The Next / Prev Thrown and hotkey lists (Quick Weapon Properties) never name the flare.
  const listed = new Set<string>();
  for (const q of player.v[248] as ResRef[]) for (const it of tpl(epk, q)!.v[0] as ResRef[]) listed.add(`${it.pkg}:${it.id}`);
  for (const k of ['4:284', '4:655', '4:236', '4:249']) assert.ok(listed.has(k), k);
  assert.ok(!listed.has('4:455'));
  const flare = weaponDef(epk, { pkg: 4, id: 455 })!;
  assert.equal(flare.kind, 'throwable');
  assert.equal(flare.maxCarry, 8, 'Item p44');
  assert.equal(tpl(epk, flare.template)!.v[37], 9, 'slot 9 (the throwables are 6)');
  assert.equal(throwableAfterEmpty([flare], (d) => tpl(epk, d.template)!.v[45] as number), null, 'p45 -1: never taken out at 0');
  assert.deepEqual(flare.thrown?.template, { pkg: 4, id: 452 });
  assert.equal(flare.thrown?.fuse, 20);
  assert.equal(flare.thrown?.explosion, undefined);
  // Its light: Point Light 4:941 by p36 generator 4:942, strength from Lighting Effect 4:943.
  const [l, ...more] = thrownLightDefs(pkgs, { pkg: 4, id: 452 });
  assert.equal(more.length, 0);
  assert.deepEqual([l.r, l.g, l.b].map((c) => Math.round(c * 255)), [0x83, 0x57, 0x45]);
  assert.ok(Math.abs(l.intensity - 1.8) < 1e-6 && l.hemi === 0);
  assert.ok(l.fx?.power && !l.fx.color);
  assert.ok(Math.abs(l.fx.power.a - 2.8125) < 1e-6 && l.fx.power.b === 45);
  const o = { x: 0, y: 0, z: 0, intensity: 0, r: 0, g: 0, b: 0, hemi: 0 };
  for (let t = 0; t < 20; t += 0.37) {
    const i = thrownLightAt(l, t, o).intensity;
    assert.ok(i >= 2.8 && i <= 45.01, `strength ${i} at ${t}`);
  }
  // No other retail throwable carries a light.
  for (const id of [280, 245, 81, 621, 806]) assert.equal(thrownLightDefs(pkgs, { pkg: 4, id }).length, 0, `4:${id}`);
});

test('the keyboard page names the Flare row from the data (p30[21])', { skip }, () => {
  const xdu = readSrsc('COMMON/Interface/Interface.xdu');
  const odu = readSrsc('COMMON/Interface/Interface.odu');
  const fe = readFrontEnd(new Map([[5, { id: 5, odu }]]));
  const p30 = fe.optionPages.keyboard!.node.props.p30 as string[];
  const strings = new StringDb();
  strings.addFile(xdu, 5);
  assert.match(strings.lookup(p30[ACTIONS.indexOf('flare')]) ?? '', /flare/i);
});
