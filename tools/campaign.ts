// Usage: npx tsx tools/campaign.ts [<game app dir>] [--all] [--json]
// Prints the campaign: the chapter list (User Interface Properties p83), the route (the
// transition naming each next chapter), every Level Transition of every level with the
// spawn point it arrives at, the transition mailbox handlers, and the difficulty-masked
// objects per level. Reads the user's install at runtime; prints refs, no game text.
//   --all   every transition, not only the route
//   --json  machine-readable dump
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { SrscFile } from '../src/formats/srsc';
import { readDbId } from '../src/formats/model';
import { parseEntities, type Entity, type EntityPackage } from '../src/formats/entities';
import { parseLevelObjects } from '../src/formats/level';
import { readChapters } from '../src/game/campaign/chapters';
import { campaignRoute, exactSpawn, levelSpawns, levelTransitions, normLevel, resolveSpawn, stemOf, type GraphSpawn, type GraphTransition } from '../src/game/campaign/graph';
import { createdOnDifficulty, DIFFICULTY_NAMES } from '../src/game/campaign/difficulty';
import { keyLabel, handlerKey } from '../src/game/campaign/mailbox';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--')) ?? 'game/app';
const has = (k: string) => args.includes(k);
if (!existsSync(join(root, 'LEVELS'))) {
  console.error(`usage: npx tsx tools/campaign.ts [<game app dir>]  (no LEVELS/ in ${root})`);
  process.exit(1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(root);
const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer as ArrayBuffer) : undefined);
const packages = new Map<number, EntityPackage>();
for (const db of files.filter((f) => f.toLowerCase().endsWith('.db'))) {
  const id = readDbId(readFileSync(db, 'latin1'));
  if (id === undefined || packages.has(id)) continue;
  const base = db.slice(0, -3);
  packages.set(id, { id, name: basename(base), odu: load(`${base}.odu`), xdu: load(`${base}.xdu`), qdu: load(`${base}.qdu`) });
}

const levels = files.filter((f) => f.toLowerCase().endsWith('.lvl')).map((f) => relative(root, f)).sort();
const ents = new Map<string, Entity[]>();
const objs = new Map<string, ReturnType<typeof parseLevelObjects>>();
for (const l of levels) {
  const lvl = new SrscFile(new Uint8Array(readFileSync(join(root, l))).buffer as ArrayBuffer);
  ents.set(l, parseEntities(lvl, packages, { all: true }));
  objs.set(l, parseLevelObjects(lvl));
}
const byNorm = new Map(levels.map((l) => [normLevel(l), l]));
const spawns = new Map<string, GraphSpawn[]>(levels.map((l) => [normLevel(l), levelSpawns(l, ents.get(l)!)]));
const transitions: GraphTransition[] = levels.flatMap((l) => levelTransitions(l, ents.get(l)!));
const chapters = readChapters(packages);
const route = campaignRoute(
  transitions,
  chapters.map((c) => c.template),
);

const arrive = (t: GraphTransition) => {
  const target = byNorm.get(normLevel(t.target));
  const sp = target ? resolveSpawn(spawns.get(normLevel(target)) ?? [], t.level, t.spawn) : undefined;
  return { target, sp, exact: exactSpawn(sp, t.level, t.spawn) };
};
const fmtT = (t: GraphTransition) => {
  const a = arrive(t);
  return `${stemOf(t.level).padEnd(20)} #${t.uid.toString(16).padEnd(5)} -> ${stemOf(t.target).padEnd(20)} ${JSON.stringify(t.spawn).padEnd(18)} ch ${(t.chapter ?? '-').padEnd(6)} ${t.enabled ? 'on ' : 'off'}  spawn ${a.sp ? `#${a.sp.uid.toString(16)} (${a.sp.position.map((x) => x.toFixed(1)).join(', ')})${a.exact ? '' : ' INEXACT'}` : 'NONE'}`;
};

if (has('--json')) {
  console.log(JSON.stringify({ chapters, route: route.map((t) => t && { ...t, arrival: arrive(t).sp }), transitions: transitions.map((t) => ({ ...t, arrival: arrive(t).sp })) }, null, 1));
  process.exit(0);
}

console.log(`Chapters (UIP p83): ${chapters.length}`);
chapters.forEach((c) => console.log(`  ${String(c.index).padStart(2)} ${c.template.padEnd(6)} title ${c.title ?? '-'} loading ${c.loadingScreen ?? '-'}`));
console.log(`\nRoute (transition naming each next chapter):`);
route.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)} ${t ? fmtT(t) : `missing chapter ${chapters[i + 1]?.template}`}`));
if (has('--all')) {
  console.log(`\nAll Level Transitions (${transitions.length}):`);
  for (const t of transitions) console.log(`  ${fmtT(t)}`);
}
console.log(`\nTransition mailbox (Level Transition Msg Handler p0:p1):`);
for (const l of levels) {
  for (const e of ents.get(l)!.filter((x) => x.className === 'Level Transition Msg Handler')) {
    const from = ents.get(l)!.some((x) => x.links.includes(e.uid));
    console.log(`  ${stemOf(l).padEnd(20)} #${e.uid.toString(16).padEnd(5)} ${keyLabel(handlerKey(e.values)).padEnd(6)} ${e.links.length ? `reader -> ${e.links.length} links` : ''}${from ? 'sender' : ''}`);
  }
}
console.log(`\nObjects not created per difficulty (${DIFFICULTY_NAMES.join(' / ')}):`);
for (const l of levels) {
  const o = objs.get(l)!;
  const n = [0, 1, 2, 3].map((d) => o.filter((x) => (x.flags & 0xf0000) && !createdOnDifficulty(x.flags, d)).length);
  if (n.some(Boolean)) console.log(`  ${stemOf(l).padEnd(20)} ${n.join(' / ')}`);
}
