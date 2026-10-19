// Skinned placed objects no other system draws (src/game/levels/skinned-props.ts,
// docs/game-logic.md §14.8): the audit over every level, and the chapter 1 projector targets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { hasSkeleton } from '../src/formats/skeleton';
import { parseStompSequence } from '../src/game/world/stomp';
import { sequencePropCandidate } from '../src/game/sequence/props';
import { skinnedPropDrawn } from '../src/game/levels/skinned-props';
import { allFiles, nodeFS, readSrsc, skip } from './helpers';

test('drawn here: prop classes, whatever flag 0x80, unless the sequence presenter takes them', () => {
  assert.equal(skinnedPropDrawn('Breakable', 0x0, 12, false), true, 'hidden at start: shown by the logic later');
  assert.equal(skinnedPropDrawn('Switch', 0x0, 7, false), true);
  assert.equal(skinnedPropDrawn('Breakable', 0x281, 9, true), false, 'a STOMP track: the presenter draws it');
  assert.equal(skinnedPropDrawn('Switch', 0x1, 7, true), true, 'a track the presenter does not take');
  assert.equal(skinnedPropDrawn('Crane', 0x1, 23, true), true);
  assert.equal(skinnedPropDrawn('Breakable', 0x1, 2, false), false, 'editor proxies');
  assert.equal(skinnedPropDrawn('Waypoint', 0x1, 10, false), false);
});

/** Which system draws a skinned placed object (the port's rules). */
function drawnBy(cls: string, family: string, flags: number, pkg: number, track: boolean): string | undefined {
  if (family === 'Character' || cls === 'Animating Static' || cls === 'Ambient Creature' || cls === 'Player') return 'actors';
  if (cls === 'Mountable') return 'dynamic';
  if (track && sequencePropCandidate(cls, flags, pkg)) return 'sequence';
  if (skinnedPropDrawn(cls, flags, pkg, track)) return 'skinned-props';
  return undefined;
}

test('chapter 1: every skinned PhysicalObject placed in 1a / 1b / 1c is drawn by some system', { skip }, async () => {
  const missing: string[] = [];
  const seen = new Map<string, string>();
  for (const L of allFiles().filter((f) => /1 PrisonDeathRow\/1[abc] /.test(f) && f.endsWith('.lvl'))) {
    const lvl = readSrsc(L);
    const pkgs = (await loadPackages(nodeFS(), dirname(L), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    const ents = parseEntities(lvl, pkgs, { resolveStrings: false });
    const tracks = new Set<number>();
    for (const e of ents) {
      if (e.className !== 'STOMP Player') continue;
      const r = e.values[0] as { pkg: number; id: number } | null;
      const q = r && (pkgs.get(r.pkg) as { qdu?: never } | undefined)?.qdu;
      for (const t of (q && parseStompSequence(q, r!.id))?.tracks ?? []) tracks.add(t.uid);
    }
    for (const e of ents) {
      const m = e.modelRef;
      if (!m || m.pkg === 2 || e.family !== 'PhysicalObject') continue;
      if (!hasSkeleton((pkgs.get(m.pkg) as { mdu?: never } | undefined)?.mdu, m.id)) continue;
      const by = drawnBy(e.className, e.family, e.flags, m.pkg, tracks.has(e.uid));
      const tag = `${L.split('/').pop()!.slice(0, 2)} ${e.className} ${e.uid.toString(16)}`;
      if (!by) missing.push(tag);
      else seen.set(tag, by);
    }
  }
  assert.deepEqual(missing, []);
  // The projected figures of the Projector Effects (§15.7.8) are among them.
  assert.equal(seen.get('1a Breakable 8897'), 'skinned-props');
  assert.equal(seen.get('1c Switch 808d'), 'skinned-props');
});
