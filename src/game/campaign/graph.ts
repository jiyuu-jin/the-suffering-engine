// The level graph: every Level Transition of every level, and the Player Spawn Point each
// one arrives at. Renderer-free (tools/campaign.ts prints it, tests/campaign.test.ts checks
// it, the browser harness tools/campaign-test.mjs walks it).
//
// Spawn choice (engine: the spawn point whose p0 "from level" is the level left and whose
// p1 name is one of the transition's target spawn names; transitions without names arrive
// at the point that names the level left): same rule as src/game/world/world.ts.

import type { Entity } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { levelKey } from '../save/types';

export interface GraphTransition {
  level: string;
  uid: number;
  target: string;
  spawn: string;
  /** Chapter Properties ref ("pkg:id") in p3. */
  chapter?: string;
  /** p6: enabled at start. */
  enabled: boolean;
  /** Message of input p10 (the trigger) and who sends it. */
  message: number;
  triggers: number[];
}

export interface GraphSpawn {
  level: string;
  uid: number;
  fromLevel: string;
  name: string;
  position: [number, number, number];
}

/** Normalised level path for comparisons ("levels/1 prisondeathrow/1a prisondeathrow.lvl"). */
export function normLevel(p: string): string {
  const k = levelKey(p);
  const i = k.indexOf('levels/');
  return i >= 0 ? k.slice(i) : k;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const refKey = (v: unknown) => (v && typeof v === 'object' && 'pkg' in (v as object) ? `${(v as ResRef).pkg}:${(v as ResRef).id}` : undefined);

export function levelTransitions(level: string, ents: readonly Entity[]): GraphTransition[] {
  const inbound = new Map<number, number[]>();
  for (const e of ents) for (const u of e.links) (inbound.get(u) ?? inbound.set(u, []).get(u)!).push(e.uid);
  return ents
    .filter((e) => e.className === 'Level Transition')
    .map((e) => {
      const spawns = (e.props.targetSpawnNames as unknown[]) ?? [];
      return {
        level,
        uid: e.uid,
        target: str(e.props.targetLevel),
        spawn: (spawns.find((s) => typeof s === 'string') as string | undefined) ?? '',
        chapter: refKey(e.values[3]),
        enabled: (typeof e.values[6] === 'number' ? e.values[6] : 1) === 1,
        message: e.inputs.find((s) => s.slot === 10)?.message ?? 0,
        triggers: inbound.get(e.uid) ?? [],
      };
    });
}

export function levelSpawns(level: string, ents: readonly Entity[]): GraphSpawn[] {
  return ents
    .filter((e) => e.className === 'Player Spawn Point')
    .map((e) => ({
      level,
      uid: e.uid,
      fromLevel: str(e.props.fromLevel),
      name: str(e.props.spawnName),
      position: [e.position[0] / 2048, e.position[1] / 2048, e.position[2] / 2048],
    }));
}

/** The spawn point a transition from `fromLevel` with `spawnName` ('' = none) arrives at. */
export function resolveSpawn<T extends Pick<GraphSpawn, 'fromLevel' | 'name'>>(points: readonly T[], fromLevel: string, spawnName: string): T | undefined {
  const from = normLevel(fromLevel);
  const fromHere = (p: T) => !!p.fromLevel && normLevel(p.fromLevel) === from;
  let named = points.filter((p) => p.name.toLowerCase() === spawnName.toLowerCase());
  if (!named.length && !spawnName) named = points.filter(fromHere);
  return named.find(fromHere) ?? named[0];
}

/** Is the arrival exact (the point names both the level left and the spawn name)? */
export function exactSpawn(p: Pick<GraphSpawn, 'fromLevel' | 'name'> | undefined, fromLevel: string, spawnName: string): boolean {
  return !!p && normLevel(p.fromLevel) === normLevel(fromLevel) && p.name.toLowerCase() === spawnName.toLowerCase();
}

/**
 * The retail campaign order (New Game -> ending) as Level Transition hops. Every hop of the
 * route is the one transition that names the next chapter of User Interface Properties p83
 * in its p3 (5:579 is the Prelude's own chapter): the chapter list order IS the route.
 * Which exit of a level the player takes depends on its logic (later chapters re-enter 3a,
 * 1b and 1a through other doors); docs/campaign.md "Transition chain".
 */
export function campaignRoute(transitions: readonly GraphTransition[], chapters: readonly string[]): (GraphTransition | undefined)[] {
  let at: string | undefined;
  return chapters.slice(1).map((c) => {
    const all = transitions.filter((t) => t.chapter === c);
    // Several (the unused test level 7 copies 6b's exit): the one leaving where we are.
    const t = all.find((x) => at !== undefined && normLevel(x.level) === at) ?? all[0];
    if (t) at = normLevel(t.target);
    return t;
  });
}

/** Expected route (level stems, target spawn name), for tests and the browser harness. */
export const CAMPAIGN_ROUTE: { from: string; to: string; spawn: string }[] = [
  { from: '0 Prelude Docks', to: '1a PrisonDeathRow', spawn: 'West Spawn' },
  { from: '1a PrisonDeathRow', to: '1b PrisonDeathRow', spawn: 'South Spawn' },
  { from: '1b PrisonDeathRow', to: '1c PrisonDeathRow', spawn: 'West Spawn' },
  { from: '1c PrisonDeathRow', to: '2 Cellblocks', spawn: 'East Spawn' },
  { from: '2 Cellblocks', to: '3a YardCellBlock', spawn: 'NorthEast Spawn' },
  { from: '3a YardCellBlock', to: '3b YardCellBlock', spawn: 'West Spawn' },
  { from: '3b YardCellBlock', to: '3a YardCellBlock', spawn: 'East Spawn' },
  { from: '3a YardCellBlock', to: '4a Quarry', spawn: 'SouthWest Spawn' },
  { from: '4a Quarry', to: '4b Quarry', spawn: '' },
  { from: '4b Quarry', to: '5a Asylum', spawn: 'East Spawn' },
  { from: '5a Asylum', to: '5b Asylum', spawn: 'North Spawn' },
  { from: '5b Asylum', to: '6a Woods', spawn: 'West Spawn' },
  { from: '6a Woods', to: '6b Woods', spawn: 'NorthEast Spawn' },
  { from: '6b Woods', to: '1b PrisonDeathRow', spawn: 'North Spawn' },
  { from: '1b PrisonDeathRow', to: '1a PrisonDeathRow', spawn: 'South Spawn' },
  { from: '1a PrisonDeathRow', to: '3a YardCellBlock', spawn: 'North Spawn' },
  { from: '3a YardCellBlock', to: '8a Bluff', spawn: 'SouthEast Spawn' },
  { from: '8a Bluff', to: '8b Bluff', spawn: '' },
  { from: '8b Bluff', to: '9 Lighthouse', spawn: '' },
  { from: '9 Lighthouse', to: '10 Docks', spawn: '' },
];

/** Level stem ("1a PrisonDeathRow") of a path. */
export function stemOf(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.lvl$/i, '');
}
