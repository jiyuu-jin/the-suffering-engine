// Views from another camera than the player's eye (security monitor feeds, cinematics):
// Torque's whole body is drawn and the first-person arms are not (PlayerController
// .setExternalView, PlayerBody; docs/re/player.md "External views"). The original leaves First
// Person (state 16) for View Monitor (23), Controlled (11), Interact (22), Play Anim (33),
// Document View (31) and Morph (19): its state table 0x10175150 (35 x 35 words) holds 2 ("end
// the other") in those rows, column 16.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as THREE from 'three/webgpu';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { PlayerController } from '../src/app/player';
import { PlayerBody } from '../src/game/actors/player-body';
import { DATA_ROOT, nodeFS, readSrsc, skip } from './helpers';

// PlayerController listens to the page; node has none.
const g = globalThis as unknown as { document?: unknown; window?: unknown };
const events = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null };
g.document ??= events;
g.window ??= events;

const controller = () => new PlayerController(new THREE.PerspectiveCamera(), events as unknown as HTMLElement);

test('an external view shows the body in first person and gives it back afterwards', () => {
  const p = controller();
  p.enabled = true;
  p.mode = 'fp';
  p.update(1 / 60);
  assert.equal(p.root.visible, false, 'first person: no third-person body');
  p.enabled = false;
  p.setExternalView('monitor', true);
  assert.equal(p.externalView, true);
  assert.equal(p.root.visible, true, 'seen by the monitor camera');
  p.setExternalView('cinematic', true);
  p.setExternalView('monitor', false);
  assert.equal(p.root.visible, true, 'still seen by the cinematic');
  p.setExternalView('cinematic', false);
  p.enabled = true;
  p.update(1 / 60);
  assert.equal(p.root.visible, false, 'back to the first-person eye');
  p.mode = 'tp';
  p.update(1 / 60);
  assert.equal(p.root.visible, true, 'third person draws the body as before');
});

test('the original ends First Person for the states that take the camera or the body', { skip }, () => {
  const rfl = readFileSync(join(DATA_ROOT, 'Suffering.rfl'));
  // PE: map the VA through the section table.
  const pe = rfl.readUInt32LE(0x3c);
  const sections = rfl.readUInt16LE(pe + 6);
  const optSize = rfl.readUInt16LE(pe + 20);
  const base = rfl.readUInt32LE(pe + 24 + 28);
  const fileOf = (va: number) => {
    for (let i = 0; i < sections; i++) {
      const s = pe + 24 + optSize + 40 * i;
      const vaddr = rfl.readUInt32LE(s + 12), vsize = rfl.readUInt32LE(s + 8), raw = rfl.readUInt32LE(s + 20);
      if (va - base >= vaddr && va - base < vaddr + vsize) return raw + (va - base - vaddr);
    }
    throw new Error(`va ${va.toString(16)}`);
  };
  const cell = (entering: number, current: number) => rfl.readInt32LE(fileOf(0x10175150 + 4 * (entering * 35 + current)));
  const FP = 16;
  for (const state of [23, 11, 22, 33, 31, 19]) assert.equal(cell(state, FP), 2, `state ${state} ends First Person`);
  for (const state of [23, 11]) assert.equal(cell(FP, state), 0, `no First Person during state ${state}`);
});

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

test('Torque through a monitor: whole body, third-person idle, no arms; first person after', { skip }, async () => {
  const lvl = readSrsc(L1A);
  const pkgs = await loadPackages(nodeFS(), dirname(L1A), readLevelHeader(lvl).dependencies, () => {});
  const p = controller();
  const scene = new THREE.Scene();
  const viewmodel = new THREE.Group();
  const body = PlayerBody.create(p, scene, pkgs, undefined, viewmodel)!;
  assert.ok(body?.arms, 'Torque and his first-person arms');
  p.enabled = true;
  p.mode = 'fp';
  p.update(1 / 60);
  body.tick(1 / 60);
  assert.equal(body.armsPivot.visible, true, 'first person: the arms');
  const fpClip = body.body.current?.getClip().name;

  // The monitor's view starts: the controller is disabled, frames stop, the actors tick on.
  p.enabled = false;
  p.setExternalView('monitor', true);
  for (let i = 0; i < 5; i++) body.tick(1 / 60);
  assert.equal(body.armsPivot.visible, false, 'no arms in the camera feed');
  assert.equal(p.root.visible, true, 'the body is drawn');
  const tpClip = body.body.current?.getClip().name;
  assert.notEqual(tpClip, fpClip, `the third-person idle (${tpClip}), not the first-person hold (${fpClip})`);

  p.setExternalView('monitor', false);
  p.enabled = true;
  p.update(1 / 60);
  body.tick(1 / 60);
  assert.equal(body.armsPivot.visible, true, 'the arms come back');
  assert.equal(p.root.visible, false);
  assert.equal(body.body.current?.getClip().name, fpClip, 'the first-person hold again');
  body.dispose();
});
