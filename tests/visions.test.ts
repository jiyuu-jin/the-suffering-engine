// Vision creatures, the security-monitor view, Hermes' material and the phone receivers
// (docs/game-logic.md §13.3 / §14.5 / §15.2 / §16; docs/re/renderer.md §3.7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopEventCrossed, waypointRuns } from '../src/game/actors/actor';
import { monitorFov, screenDistance, warpGradient } from '../src/game/world/monitor-view';
import { characterSurfaceBlend } from '../src/app/character';
import { loadPackages } from '../src/app/loader';
import { SrscFile } from '../src/formats/srsc';
import { readLevelHeader } from '../src/formats/level';
import { Blend, readModel, type PackageSet } from '../src/formats/model';
import { classByHash, decodeTemplateProps, parseEntities, readObjectTemplate, type EntityPackageSet } from '../src/formats/entities';
import { readSkinnedModel } from '../src/formats/skeleton';
import { nodeFS, skip } from './helpers';

test('Waypoint p1 = 1 is walked at a run (move mode 3), anything else at a walk', () => {
  assert.equal(waypointRuns([12, 1, 0.7]), true);
  assert.equal(waypointRuns([0, 0, 1]), false);
  assert.equal(waypointRuns([0, [], 1]), false);
});

test('looping clip events fire in [t0, t1), wrapping at the loop', () => {
  assert.equal(loopEventCrossed(0.3, 0.2, 0.4), true);
  assert.equal(loopEventCrossed(0.4, 0.2, 0.4), false);
  assert.equal(loopEventCrossed(0, 0.7, 0.05), true); // the loop restarted: a cue at 0 fires
  assert.equal(loopEventCrossed(0.5, 0.7, 0.05), false);
  assert.equal(loopEventCrossed(0.3, 0.3, 0.3), false);
});

test('warp gradient: forward differences, wrapping like the original', () => {
  // 3 x 2 height map.
  const h = [0, 0.5, 1, 0.25, 0.25, 0.25];
  const g = warpGradient(h, 3, 2);
  assert.deepEqual(Array.from(g.slice(0, 6)), [0.5, 0.25, 0.5, -0.25, -1, -0.75]);
  // Last row wraps down to row 0: (x 0) 0 - 0.25.
  assert.equal(g[7], 0 - 0.25);
});

test('monitor view: p51 is the 4:3 vertical angle, the glass fills the height', () => {
  assert.ok(Math.abs(monitorFov(60, 16 / 9) - 60) < 1e-9);
  assert.ok(Math.abs(monitorFov(60, 4 / 3) - 60) < 1e-9);
  assert.ok(monitorFov(60, 1) > 60);
  // The 0.38 m of the templates fits the 0.329 m glass to a 16:9 frame with the 4:3 width.
  const vfov169 = (2 * Math.atan(Math.tan(Math.PI / 6) * (4 / 3) * (9 / 16)) * 180) / Math.PI;
  assert.ok(Math.abs(screenDistance(0.1645, vfov169) - 0.38) < 0.01);
});

async function level(name: string) {
  const fs = nodeFS();
  const path = `LEVELS/1 PrisonDeathRow/${name} PrisonDeathRow.lvl`;
  const lvl = new SrscFile(await fs.read(path));
  const pkgs = await loadPackages(fs, 'LEVELS/1 PrisonDeathRow', readLevelHeader(lvl).dependencies, () => {});
  return { lvl, pkgs, ents: parseEntities(lvl, pkgs as unknown as EntityPackageSet) };
}
const tpl = (pkgs: PackageSet, r: { pkg: number; id: number }) => {
  const t = readObjectTemplate(pkgs as unknown as EntityPackageSet, r);
  return t ? { cls: classByHash(t.classHash)?.name, values: decodeTemplateProps(classByHash(t.classHash), t), model: t.modelRef } : undefined;
};

test('1a / 1b vision creatures (model 2:124) run their Waypoint chains, with a run clip that growls', { skip }, async () => {
  for (const name of ['1a', '1b']) {
    const { pkgs, ents } = await level(name);
    const creatures = ents.filter((e) => e.className === 'Unspeakable NPC' && e.modelRef?.pkg === 2 && e.modelRef.id === 124);
    assert.ok(creatures.length > 0, name);
    for (const c of creatures) {
      // Its Waypoints (those linking to it) are all run.
      const wps = ents.filter((e) => e.className === 'Waypoint' && e.links.includes(c.uid));
      for (const w of wps) assert.ok(waypointRuns(w.values), `${name} waypoint ${w.uid.toString(16)}`);
    }
    // MovementAnimBehavior 10:597: p3 walk 2:96, p5 run 2:137; the run carries a pool sound cue.
    const mab = tpl(pkgs, { pkg: 10, id: 597 });
    assert.equal(mab?.cls, 'MovementAnimBehavior');
    assert.deepEqual(mab?.values[5], { pkg: 2, id: 137 });
  }
});

test('Hermes (10:92) draws additive passes tinted 0x4b4b4b; ordinary skins stay opaque', { skip }, async () => {
  const { pkgs } = await level('1a');
  const hermes = readSkinnedModel(pkgs, { pkg: 10, id: 92 });
  assert.ok(hermes);
  for (const s of hermes!.model.submeshes) {
    assert.equal(s.material?.layers[0].blend, Blend.Add);
    assert.equal(s.material?.layers[0].tint, 0x4b4b4b);
    assert.ok(characterSurfaceBlend(s.material));
  }
  const torque = readSkinnedModel(pkgs, { pkg: 2, id: 9 });
  assert.ok(torque!.model.submeshes.every((s) => !characterSurfaceBlend(s.material)));
});

test('every chapter-1 Phone p30 is a Breakable receiver modelled over the phone', { skip }, async () => {
  for (const name of ['1a', '1b']) {
    const { pkgs, ents } = await level(name);
    for (const e of ents.filter((x) => x.className === 'Phone')) {
      const r = e.values[30] as { pkg: number; id: number };
      const t = tpl(pkgs, r);
      assert.equal(t?.cls, 'Breakable', `phone ${e.uid.toString(16)}`);
      const rx = readModel(pkgs, t!.model!)!;
      const base = readModel(pkgs, e.modelRef!)!;
      const top = (m: typeof rx) => Math.max(...Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[3 * i + 1]));
      const bottom = Math.min(...Array.from({ length: rx.positions.length / 3 }, (_, i) => rx.positions[3 * i + 1]));
      // The receiver sits up on the body, not at the floor of the model.
      assert.ok(bottom > 0.1 && bottom < top(base), `receiver ${r.pkg}:${r.id} at ${bottom}`);
    }
  }
});
