// Census of the lamp fixtures (Light Housing) placed in every level and the look each one starts
// with under the original's rules (src/game/world/housing.ts, docs/game-logic.md §14.4).
//
//   npx tsx tools/fixtures.ts                  every level, one row per fixture type and start state
//   npx tsx tools/fixtures.ts --level 1a       one level (id prefix of the .lvl name)
//   npx tsx tools/fixtures.ts --each           one row per placed fixture
//   npx tsx tools/fixtures.ts --json           machine-readable
//
// Columns:
//   start     p31: the state the lamp starts in (on / off)
//   shows     the material table it starts with: "on" (p32), "off" (p33), or "model" when the
//             list does not fit the model's material count (the model keeps its own table)
//   model=    which list the model's own material table equals (what a renderer that ignores
//             the state draws): on, off, both (the lists agree), or neither
//   spawns    templates created at the lamp in the start state (p40 on / p41 off), by class
//   broken    the remains p42 a shot lamp leaves (class:model), "-" when it leaves none
//   p43       placed objects shown with the lamp (light pools)
//   lights    linked Light Source objects; "flipped" counts those whose own p6 differs from the
//             lamp's start state (the lamp's post-load message wins)
// Game data is read from the local install ($SUFFERING_DATA or ./game/app); nothing is written.

import { parseEntities, readObjectTemplate, className, type Entity } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { readModel, type ResRef } from '../src/formats/model';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { SrscFile } from '../src/formats/srsc';
import { HOUSING_OFF, HOUSING_ON, housingExtras, housingLights, housingLook, housingStartState } from '../src/game/world/housing';
import { filesWithExt, hasData, nodeFS } from '../tests/helpers';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const only = opt('--level');
const each = args.includes('--each');
const asJson = args.includes('--json');

if (!hasData) {
  console.error('no game data (set SUFFERING_DATA or put the install at ./game/app)');
  process.exit(1);
}

const key = (r: ResRef | null | undefined) => (r ? `${r.pkg}:${r.id}` : '-');
const sameList = (a: (ResRef | null)[], b: readonly ResRef[]) => a.length === b.length && a.every((x, i) => key(x) === key(b[i]));

export interface FixtureRow {
  level: string;
  uid?: string;
  count: number;
  template: string;
  model: string;
  start: 'on' | 'off';
  shows: 'on' | 'off' | 'model';
  modelTable: 'on' | 'off' | 'both' | 'neither' | 'none';
  spawns: string[];
  broken: string[];
  extras: number;
  lights: number;
  flipped: number;
}

const fs = nodeFS();
const levels = filesWithExt('.lvl')
  .filter((p) => p.startsWith('LEVELS/'))
  .filter((p) => !only || (p.split('/').pop() ?? '').toLowerCase().startsWith(only.toLowerCase() + ' '))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const rows: FixtureRow[] = [];
for (const path of levels) {
  const lvl = new SrscFile(await fs.read(path));
  const packages = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, () => {});
  const ents = parseEntities(lvl, packages);
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  const level = (path.split('/').pop() ?? path).split(' ')[0];
  const tplDesc = (r: ResRef) => {
    const t = readObjectTemplate(packages, r);
    return t ? `${className(t.classHash)}:${t.modelRef ? key(t.modelRef) : key(r)}` : `?:${key(r)}`;
  };
  const grouped = new Map<string, FixtureRow>();
  for (const e of ents) {
    if (e.className !== 'Light Housing') continue;
    const v = e.values;
    const model = e.modelRef ? readModel(packages, e.modelRef) : undefined;
    const count = model?.materials.length;
    const start = housingStartState(v);
    const look = housingLook(v, start, count);
    const on = housingLook(v, HOUSING_ON, count).materials;
    const off = housingLook(v, HOUSING_OFF, count).materials;
    const own = model?.materials ?? [];
    const isOn = !!on && sameList(on, own), isOff = !!off && sameList(off, own);
    const lights = housingLights(e.links, (u) => byUid.get(u));
    const flipped = lights.filter((u) => {
      const l = byUid.get(u) as Entity;
      return (l.className === 'Point Light' || l.className === 'Spot Light') && (l.values[6] === 0 ? HOUSING_OFF : HOUSING_ON) !== start;
    }).length;
    const row: FixtureRow = {
      level,
      count: 1,
      template: key(e.template),
      model: key(e.modelRef),
      start: start === HOUSING_ON ? 'on' : 'off',
      shows: look.materials ? (start === HOUSING_ON ? 'on' : 'off') : 'model',
      modelTable: !model ? 'none' : isOn && isOff ? 'both' : isOn ? 'on' : isOff ? 'off' : 'neither',
      spawns: look.spawns.map(tplDesc),
      broken: housingLook(v, 2, count).spawns.map(tplDesc),
      extras: housingExtras(v).length,
      lights: lights.length,
      flipped,
    };
    if (each) rows.push({ ...row, uid: e.uid.toString(16) });
    else {
      const k = `${row.template}|${row.start}`;
      const g = grouped.get(k);
      if (g) (g.count++, (g.lights += row.lights), (g.flipped += row.flipped), (g.extras += row.extras));
      else grouped.set(k, row);
    }
  }
  rows.push(...[...grouped.values()].sort((a, b) => b.count - a.count));
}

if (asJson) console.log(JSON.stringify(rows, null, 1));
else {
  const head = ['level', each ? 'uid' : 'n', 'template', 'model', 'start', 'shows', 'model=', 'spawns', 'broken', 'p43', 'lights', 'flipped'];
  const cells = rows.map((r) => [r.level, each ? r.uid! : String(r.count), r.template, r.model, r.start, r.shows, r.modelTable, r.spawns.join(' ') || '-', r.broken.join(' ') || '-', String(r.extras), String(r.lights), String(r.flipped)]);
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd();
  console.log(line(head));
  for (const c of cells) console.log(line(c));
  const n = rows.reduce((s, r) => s + r.count, 0);
  const off = rows.filter((r) => r.start === 'off').reduce((s, r) => s + r.count, 0);
  const flipped = rows.reduce((s, r) => s + r.flipped, 0);
  const wrong = rows.filter((r) => r.shows !== 'model' && r.modelTable !== 'both' && r.modelTable !== r.shows).reduce((s, r) => s + r.count, 0);
  console.log(`\n${n} fixtures in ${levels.length} level(s): ${n - off} start on, ${off} start off; ${wrong} start in a look their model's own materials do not have; ${flipped} linked lights switched by their lamp at load`);
}
