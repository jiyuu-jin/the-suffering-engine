// Usage: npx tsx tools/entities.ts "<path to .lvl>" [--class <name>[,<name>...]] [--uid <hex>] [--limit N]
//                                                    [--graph] [--validate] [--classes]
// Prints an entity census of a level (counts per class) and, with filters, entity details.
//   --class   details for entities of these classes (case-insensitive substring match)
//   --uid     details for one entity (hex uid) plus its inbound/outbound links
//   --graph   message flow: for every logic entity, its output messages -> linked targets
//   --validate run sanity checks (template/class resolution, link targets, volumes)
//   --classes  dump the class table (name, hash, category, property types)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SrscFile } from '../src/formats/srsc';
import { readDbId } from '../src/formats/model';
import { instanceRotation, readLevelHeader } from '../src/formats/level';
import {
  CLASSES,
  entityBoxCorners,
  inboundLinks,
  indexEntities,
  linkCoverage,
  parseEntities,
  parseSequenceHeader,
  type Entity,
  type EntityPackage,
} from '../src/formats/entities';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? '') : undefined;
};
const has = (k: string) => args.includes(k);

if (has('--classes')) {
  for (const c of [...CLASSES.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(
      `${c.hash.toString(16).padStart(8, '0')} ${c.name.padEnd(36)} ${c.categoryName.padEnd(18)} ${c.family.padEnd(14)} [${c.types.length}] in:${c.inputs.join(',')} out:${c.outputs.join(',')}`,
    );
  }
  process.exit(0);
}

const lvlPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--graph' && args[i - 1] !== '--validate'));
if (!lvlPath || !existsSync(lvlPath)) {
  console.error('usage: npx tsx tools/entities.ts "<path to .lvl>" [--class name] [--uid hex] [--graph] [--validate]');
  process.exit(1);
}

// Game root = the folder holding LEVELS/ (walk up from the .lvl).
let root = dirname(lvlPath);
while (root !== dirname(root) && !existsSync(join(root, 'LEVELS'))) root = dirname(root);

// Load every package of the game (odu + xdu + qdu are small): ids from the .db files.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.db')) out.push(p);
  }
  return out;
}
const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer) : undefined);
const packages = new Map<number, EntityPackage>();
for (const db of walk(root)) {
  const id = readDbId(readFileSync(db, 'latin1'));
  if (id === undefined || packages.has(id)) continue;
  const base = db.slice(0, -3);
  packages.set(id, { id, name: basename(base), odu: load(base + '.odu'), xdu: load(base + '.xdu'), qdu: load(base + '.qdu') });
}

const lvl = new SrscFile(new Uint8Array(readFileSync(lvlPath)).buffer);
const header = readLevelHeader(lvl);
const ents = parseEntities(lvl, packages);
const byUid = indexEntities(ents);
const inbound = inboundLinks(ents);
const U = 2048;
const fmtPos = (p: number[]) => `(${p.map((x) => (x / U).toFixed(1)).join(', ')})`;
const label = (uid: number) => {
  const e = byUid.get(uid);
  return e ? `${e.className}#${uid.toString(16)}` : `?#${uid.toString(16)}`;
};
const fmtVal = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(fmtVal).join(', ')}]`;
  if (v && typeof v === 'object') return `${(v as { pkg: number }).pkg}:${(v as { id: number }).id}`;
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
};

console.log(`${basename(lvlPath)} — "${header.title}": ${ents.length} entities, ${packages.size} packages loaded`);

// Census
const census = new Map<string, number>();
for (const e of ents) census.set(e.className, (census.get(e.className) ?? 0) + 1);
console.log('\nCensus (class: count):');
const rows = [...census].sort((a, b) => b[1] - a[1]);
for (let i = 0; i < rows.length; i += 3) {
  console.log(
    rows
      .slice(i, i + 3)
      .map(([k, n]) => `${String(n).padStart(5)} ${k.padEnd(34)}`)
      .join(''),
  );
}

function details(e: Entity) {
  console.log(
    `\n${e.className} uid ${e.uid.toString(16)} [${e.category}] tpl ${e.template.pkg}:${e.template.id} pos ${fmtPos(e.position)} rot (${e.rotation.join(', ')})${e.scale ? ` scale (${e.scale.map((x) => x.toFixed(2)).join(', ')})` : ''} flags 0x${e.flags.toString(16)}${e.modelRef ? ` model ${e.modelRef.pkg}:${e.modelRef.id}` : ''}`,
  );
  const props = Object.entries(e.props)
    .map(([k, v], i) => `${e.overridden.includes(i) ? '*' : ''}${k}=${fmtVal(v)}`)
    .join(' ');
  console.log(`  props: ${props}`);
  if (e.inputs.length) console.log(`  inputs:  ${e.inputs.map((s) => `${s.name}<-${s.messageName}`).join(', ')}`);
  if (e.outputs.length) console.log(`  outputs: ${e.outputs.map((s) => `${s.name}->${s.messageName}`).join(', ')}`);
  if (e.links.length) console.log(`  links -> ${e.links.map(label).join(', ')}`);
  const inb = inbound.get(e.uid);
  if (inb?.length) console.log(`  linked from <- ${inb.map(label).join(', ')}`);
  if (e.className === 'STOMP Player') {
    const seq = e.props.sequence as { pkg: number; id: number } | null;
    const q = seq ? packages.get(seq.pkg)?.qdu : undefined;
    const h = q && seq ? parseSequenceHeader(q, seq.id) : undefined;
    if (h) console.log(`  sequence "${h.name}" length ${h.length} tracks ${h.trackCount} first track -> ${label(h.firstTrackUid)}`);
  }
}

const limit = Number(flag('--limit') ?? 20);
const classFilter = flag('--class');
if (classFilter) {
  const wanted = classFilter.toLowerCase().split(',');
  const sel = ents.filter((e) => wanted.some((w) => e.className.toLowerCase().includes(w)));
  console.log(`\n${sel.length} entities match "${classFilter}"${sel.length > limit ? ` (showing ${limit})` : ''}`);
  sel.slice(0, limit).forEach(details);
}
const uidFilter = flag('--uid');
if (uidFilter) {
  const e = byUid.get(parseInt(uidFilter, 16));
  if (e) details(e);
  else console.log(`no entity with uid ${uidFilter}`);
}

if (has('--graph')) {
  console.log('\nMessage flow (sender.slot message -> targets):');
  for (const e of ents) {
    if (!e.links.length) continue;
    const outs = e.outputs.filter((s) => s.message);
    if (!outs.length) continue;
    for (const s of outs) console.log(`  ${label(e.uid)}.${s.name} ${s.messageName} -> ${e.links.map(label).join(', ')}`);
  }
}

if (has('--validate')) {
  console.log('\nValidation:');
  const unresolved = ents.filter((e) => e.className === 'unresolved' || e.className.startsWith('class_'));
  console.log(`  templates/classes unresolved: ${unresolved.length}`);
  let dangling = 0, links = 0;
  for (const e of ents) for (const l of e.links) (links++, byUid.has(l) || dangling++);
  console.log(`  links: ${links}, dangling: ${dangling}`);
  // Messages sent along links, classified as the engine dispatcher receives them
  // (docs/re/object-model.md): input slot, fixed id, catch-all, dropped, or target slots unknown.
  const cov = linkCoverage(ents);
  console.log(
    `  link messages: ${cov.sent}; input slot ${cov.slot}, fixed id ${cov.fixed}, catch-all ${cov.catchAll}, dropped by the target ${cov.ignored}, target slots unknown ${cov.unknown}`,
  );
  for (const [k, n] of [...cov.misses].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    unknown: ${n} x ${k}`);
  // Player start vs spawn points.
  const player = ents.find((e) => e.className === 'Player');
  if (player) console.log(`  Player at ${fmtPos(player.position)} (level.ts currently spawns at template 2:6, which is the Camera object)`);
  for (const sp of ents.filter((e) => e.className === 'Player Spawn Point'))
    console.log(`  Spawn "${sp.props.spawnName}" from "${sp.props.fromLevel}" at ${fmtPos(sp.position)}`);
  for (const lt of ents.filter((e) => e.className === 'Level Transition'))
    console.log(`  Transition -> "${lt.props.targetLevel}" spawn ${fmtVal(lt.props.targetSpawnNames)} triggered by ${(inbound.get(lt.uid) ?? []).map(label).join(', ') || 'nothing'}`);
  // Detector volumes.
  const dets = ents.filter((e) => e.className === 'Detector');
  const sizes = dets
    .map((d) => entityBoxCorners(d, instanceRotation))
    .filter((c): c is [number, number, number][] => !!c)
    .map((c) => [0, 1, 2].map((k) => (Math.max(...c.map((p) => p[k])) - Math.min(...c.map((p) => p[k]))) / U));
  if (sizes.length) {
    const avg = [0, 1, 2].map((k) => sizes.reduce((s, v) => s + v[k], 0) / sizes.length);
    console.log(`  Detector volumes: ${sizes.length}, mean AABB extent (model units) ${avg.map((x) => x.toFixed(1)).join(' x ')}`);
  }
}
