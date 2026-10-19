// Reputation census: every object and message in the game's levels that changes the player's
// reputation, with its amount, by the original's rules (src/game/insanity/reputation.ts,
// docs/game-logic.md §13.2 "Reputation sources").
//
//   npx tsx tools/reputation-census.ts [game/app] [--level <id>] [--json]
//
// Per level:
//   Sender      Reputation Points Sender: its amount (p3) x the times it applies (p0 target mode),
//               the message that fires it (p1) and what sends that message to it (the linked
//               objects' outputs carrying it, or class code: a Waypoint's arrival p0 ...);
//   Kill        placed characters whose death by the player's hand changes the reputation:
//               p166 (Characters), p26 (Ambient Creatures), the attached Action Dialog's p22;
//   Dialog      Action Dialogs with a p22: paid once on the p18th counted hit of the player's
//               (p14 / p19 timing) or on the kill;
//   Filter      Reputation Points Message Filters (p1 < reputation <= p2) and what they gate;
//   Part Cap    characters whose body-part caps pay p5 for a part cut from a body dead > p4 s
//               (actors/dismember.ts).
// Then the templates of every package that carry a reputation (spawned characters).
//
// Reads the user's own install at runtime; prints derived numbers and object ids only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SrscFile } from '../src/formats/srsc';
import { readDbId } from '../src/formats/model';
import {
  classByHash,
  decodeTemplateProps,
  inboundLinks,
  indexEntities,
  parseEntities,
  readObjectTemplate,
  type Entity,
  type EntityPackage,
  type PropValue,
} from '../src/formats/entities';
import { dialogRepRules, killReputation, KILLED_BY_PLAYER_OUTPUT, senderApplications } from '../src/game/insanity/reputation';

const args = process.argv.slice(2);
const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const root = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--level')) ?? 'game/app';
const onlyLevel = flag('--level');
const asJson = args.includes('--json');
if (!existsSync(join(root, 'LEVELS'))) {
  console.error(`no LEVELS under ${root}: npx tsx tools/reputation-census.ts [game/app] [--level <id>] [--json]`);
  process.exit(1);
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}
const load = (p: string) => (existsSync(p) ? new SrscFile(new Uint8Array(readFileSync(p)).buffer) : undefined);
const packages = new Map<number, EntityPackage>();
for (const db of walk(root, '.db')) {
  const id = readDbId(readFileSync(db, 'latin1'));
  if (id === undefined || packages.has(id)) continue;
  const base = db.slice(0, -3);
  packages.set(id, { id, name: basename(base), odu: load(base + '.odu'), xdu: load(base + '.xdu'), qdu: load(base + '.qdu') });
}

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const hex = (n: number) => n.toString(16);
const sign = (n: number) => `${n > 0 ? '+' : ''}${n}`;
const refs = (v: PropValue | undefined) => (Array.isArray(v) ? v : [v]).filter((x): x is { pkg: number; id: number } => !!x && typeof x === 'object');

/** What sends `msg` to `to`: the linked objects' outputs carrying it, else their class code. */
function triggers(to: Entity, msg: number, byUid: Map<number, Entity>, inbound: Map<number, number[]>): string[] {
  return (inbound.get(to.uid) ?? []).map((u) => {
    const s = byUid.get(u)!;
    const outs = s.outputs.filter((o) => o.message === msg).map((o) => `p${o.slot}${o.slot === KILLED_BY_PLAYER_OUTPUT && s.values.length > 166 ? ' (killed by the player)' : ''}`);
    // Classes that send a value property rather than an output slot.
    const code = s.className === 'Waypoint' && num(s.values[0]) === msg ? 'arrival p0' : '';
    return `${s.className} #${hex(u)}${outs.length ? ` ${outs.join('/')}` : code ? ` ${code}` : ' (class code)'}`;
  });
}

/**
 * Where a chain of messages ending at `uid` starts: walking the links backwards through relays,
 * timers, filters and counters to the characters, waypoints, sequences, detectors, switches,
 * breakables and cloners that start it (at most 6 hops).
 */
const ORIGIN = new Set(['Waypoint', 'STOMP Player', 'Detector', 'Switch', 'Breakable', 'Object Cloner', 'Level Transition Msg Handler', 'Movie Player', 'Use Message Generator']);
function origins(uid: number, byUid: Map<number, Entity>, inbound: Map<number, number[]>): string[] {
  const out = new Set<string>();
  const seen = new Set<number>([uid]);
  let front = [uid];
  for (let hop = 0; hop < 6 && front.length && out.size < 8; hop++) {
    const next: number[] = [];
    for (const u of front)
      for (const f of inbound.get(u) ?? []) {
        if (seen.has(f)) continue;
        seen.add(f);
        const e = byUid.get(f);
        if (!e) continue;
        if (e.values.length > 166 || ORIGIN.has(e.className)) out.add(`${e.className} #${hex(f)}`);
        else next.push(f);
      }
    front = next;
  }
  return [...out];
}

interface Row {
  level: string;
  kind: 'sender' | 'kill' | 'dialog' | 'filter' | 'partcap';
  uid: number;
  amount: number;
  text: string;
}
const rows: Row[] = [];
/** Part Cap templates' rule, read once. */
const partCaps = new Map<string, { p4: number; p5: number }>();
const partCap = (r: { pkg: number; id: number }) => {
  const k = `${r.pkg}:${r.id}`;
  if (!partCaps.has(k)) {
    const t = readObjectTemplate(packages, r);
    const c = t && classByHash(t.classHash);
    const v = c && t ? decodeTemplateProps(c, t) : [];
    partCaps.set(k, c?.name === 'Part Cap' ? { p4: num(v[4], 5), p5: num(v[5]) } : { p4: 0, p5: 0 });
  }
  return partCaps.get(k)!;
};

const levels = walk(join(root, 'LEVELS'), '.lvl')
  .map((p) => ({ p, id: basename(p).split(' ')[0] }))
  .filter((l) => !onlyLevel || l.id === onlyLevel)
  .sort((a, b) => a.p.localeCompare(b.p, undefined, { numeric: true }));
for (const { p, id } of levels) {
  const ents = parseEntities(new SrscFile(new Uint8Array(readFileSync(p)).buffer), packages);
  const byUid = indexEntities(ents);
  const inbound = inboundLinks(ents);
  const add = (kind: Row['kind'], uid: number, amount: number, text: string) => rows.push({ level: id, kind, uid, amount, text });
  // Attached-at-start / attachable dialogs per NPC.
  const dialogOf = new Map<number, Entity[]>();
  for (const e of ents) if (e.className === 'Action Dialog') for (const u of e.links) if ((byUid.get(u)?.values.length ?? 0) > 166) (dialogOf.get(u) ?? dialogOf.set(u, []).get(u)!).push(e);
  let capChars = 0;
  const capAmounts = new Set<string>();
  for (const e of ents) {
    const v = e.values;
    switch (e.className) {
      case 'Reputation Points Sender': {
        const n = senderApplications(num(v[0], 1), e.links.length);
        const amount = num(v[3]) * n;
        const from = triggers(e, num(v[1]), byUid, inbound);
        const start = origins(e.uid, byUid, inbound);
        add('sender', e.uid, amount, `Reputation Points Sender #${hex(e.uid)}: ${sign(num(v[3]))}${n !== 1 ? ` x${n} (p0 ${num(v[0], 1)}, ${e.links.length} links)` : ''} on message ${num(v[1])} <- ${from.join(', ') || 'nothing links to it'}${start.length ? ` [from ${start.join(', ')}]` : ''}`);
        break;
      }
      case 'Reputation Points Message Filter':
        add('filter', e.uid, 0, `Reputation Points Message Filter #${hex(e.uid)}: ${num(v[1], -999)} < rep <= ${num(v[2], 999)} -> ${e.links.map((u) => `${byUid.get(u)?.className ?? '?'} #${hex(u)}`).join(', ')}`);
        break;
      case 'Action Dialog': {
        const r = dialogRepRules(v);
        if (!r.points) break;
        const npc = e.links.map((u) => byUid.get(u)).find((x) => !!x && x.values.length > 166);
        add('dialog', e.uid, r.points, `Action Dialog #${hex(e.uid)} on ${npc ? `${npc.className} #${hex(npc.uid)}` : 'no NPC'}: ${sign(r.points)} once, on the ${r.hits}${r.hits === 1 ? 'st' : 'th'} counted hit of the player's (${r.minGap} s apart, count restarts after ${r.resetAfter} s) or on his kill; attached ${num(v[0]) === 1 ? 'at start' : `on message ${num(v[24])}`}`);
        break;
      }
    }
    if (e.className === 'Player') continue;
    const k = killReputation(e.className, v);
    const kp = e.values.length > 166 ? num(v[KILLED_BY_PLAYER_OUTPUT]) : 0;
    const dlg = (dialogOf.get(e.uid) ?? []).filter((d) => num(d.values[22]));
    if (k || (kp && e.links.length)) {
      const extra = dlg.length ? ` (+ its Action Dialog ${dlg.map((d) => `#${hex(d.uid)} ${sign(num(d.values[22]))}`).join(' / ')} unless paid)` : '';
      const out = kp && e.links.length ? `; output p169 (killed by the player) sends ${kp} to ${e.links.map((u) => `${byUid.get(u)?.className ?? '?'} #${hex(u)}`).join(', ')}` : '';
      add('kill', e.uid, k, `${e.className} #${hex(e.uid)} killed by the player: ${k ? sign(k) : 'no own reputation'}${extra}${out}`);
    }
    if (v.length > 166) {
      const caps = refs(v[16]).map(partCap).filter((c) => c.p5);
      if (caps.length) {
        capChars++;
        for (const c of caps) capAmounts.add(`${sign(c.p5)} after ${c.p4} s`);
      }
    }
  }
  if (capChars) add('partcap', 0, 0, `${capChars} characters with Part Caps paying ${[...capAmounts].join(', ')} per part cut from their corpse`);
}

// Templates with a reputation (spawned characters, cloned ambient creatures, dialog templates).
const tpl: string[] = [];
for (const pkg of [...packages.keys()].sort((a, b) => a - b))
  for (let id = 0; id < 9000; id++) {
    let t;
    try {
      t = readObjectTemplate(packages, { pkg, id });
    } catch {
      continue;
    }
    const c = t && classByHash(t.classHash);
    if (!t || !c || c.name === 'Player') continue;
    const v = decodeTemplateProps(c, t);
    const k = killReputation(c.name, v);
    if (k) tpl.push(`${pkg}:${id} ${c.name}: kill ${sign(k)}`);
    if (c.name === 'Action Dialog' && num(v[22])) tpl.push(`${pkg}:${id} Action Dialog: p22 ${sign(num(v[22]))}`);
  }

if (asJson) {
  console.log(JSON.stringify({ rows, templates: tpl }, null, 1));
} else {
  let level = '';
  for (const r of rows) {
    if (r.level !== level) {
      level = r.level;
      const s = rows.filter((x) => x.level === level && x.kind === 'sender');
      console.log(`\n${level}  (senders: ${sign(s.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0))} / ${sign(s.filter((x) => x.amount < 0).reduce((a, x) => a + x.amount, 0))})`);
    }
    console.log(`  ${r.kind.padEnd(7)} ${r.text}`);
  }
  console.log(`\nTemplates with a reputation (${tpl.length}):`);
  for (const t of tpl) console.log(`  ${t}`);
}
