// Save matrix: save, reload and compare across many game states.
//
//   node tools/save-matrix.mjs [--sessions 1a,2,route-1c ...] [--configs base,fight ...]
//        [--ctl 11500] [--tmp <dir>] [--out report.json] [--url http://localhost:5173]
//        [--no-reload] [--storage] [--menus] [--revisit] [--level <id> --configs a,b [--route <step>] [--difficulty n]]
//
// Each session starts a level through tools/playthrough.mjs (--keep: its control server on
// --ctl) - a deep link (`--direct`, no route steps) or the chapter route played up to a step
// (route-* sessions: a companion following, a fight under way). In the running level every
// configuration of the session is set up in turn (they build on each other, as play does), then:
//   1. take   a fingerprint (tools/playthrough-restore.js snap() plus the extras of
//             tools/save-matrix-page.js) and a save captured in the same frame;
//   2. store  the save written to the browser store and read back (JSON identical?);
//   3. load   the save restored in the same session (in place, as Load Game in the same level)
//             and the fingerprint compared 2 frames later; the save providers' own round trip
//             (a capture right after the restore against the save loaded);
//   4. play   on for a few seconds: W held, the player must move, nothing may throw.
// After the last configuration the page is reloaded (a fresh page: the store is all that is
// left) and every save of the session is read back from the store and restored and compared
// again. Configurations the original does not allow saving in (rules.ts: cinematic, ladder,
// morph...) check the veto, then capture anyway (what a checkpoint taken there would hold).
//
// --storage runs the storage robustness checks instead (IndexedDB / localStorage / memory,
// quota, corrupt entries, old versions, many saves, delete, blocked storage, two tabs): see
// storageChecks() below. --menus checks the menu flow's file rows (tools/save-matrix-menus.js:
// .json import / export, the original game's .rsg / Unspeakable.cfg, Continue after a reload).
// Results: docs/playthrough.md "Save matrix".

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const has = (k) => args.includes(k);
const TMP = opt('--tmp', tmpdir());
const CTL = Number(opt('--ctl', '11500'));
const OUT = opt('--out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = netServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Configurations: `setup` runs in the page (__sm.prep.* or any expression; may be async) before
// the save; `veto` = the original refuses a manual save there (the matrix checks that, then
// captures anyway); `kind` 'checkpoint' takes the save through the save system's own checkpoint.

const CONFIGS = {
  base: { what: 'the level as started, after a few seconds of play', setup: null },
  checkpoint: { what: 'a checkpoint (the in-memory restore point, written to the autosave slot)', kind: 'checkpoint' },
  flashlight: { what: 'flashlight on', setup: `__sm.prep.flashlight()` },
  lowHealth: { what: 'low health, blood on the skin', setup: `__sm.prep.lowHealth()` },
  fullInventory: { what: 'every weapon, ammo near full, throwables, Xombium', setup: `__sm.prep.fullInventory()` },
  shotgun: { what: 'shotgun equipped', setup: `__sm.prep.equipShotgun()` },
  repLow: { what: 'reputation -60 (evil)', setup: `__sm.prep.reputation(-60)` },
  repHigh: { what: 'reputation +60 (good)', setup: `__sm.prep.reputation(60)` },
  fight: { what: 'creatures cloned next to the player and fighting', setup: `__sm.prep.fight(2)` },
  dismember: { what: 'a creature cut and bleeding, another killed and cut', setup: `__sm.prep.dismember()` },
  gibs: { what: 'a body gibbed', setup: `__sm.prep.gib()` },
  npcDrop: { what: 'an armed NPC killed (dropped weapon)', setup: `__sm.prep.npcDrop()` },
  creature: { what: 'in creature form', setup: `__sm.prep.creature()` },
  morphing: { what: 'mid-morph (vetoed)', setup: `__sm.prep.morphing()`, veto: /morph/ },
  ladder: { what: 'on a ladder (vetoed)', setup: `__sm.prep.ladder()`, veto: /climb|airborne/ },
  human: { what: 'back to human form', setup: `__sm.prep.human()` },
  crane: { what: "at 4b's crane controls 7bd9, the crane turned (vetoed)", setup: `__sm.prep.mount(0x7bd9)`, veto: /climb|airborne/ },
  craneAfter: { what: 'off the crane controls: the crane as turned', setup: `__sm.prep.mount(0x7bd9).then((m) => (__sm.prep.dismount(), m))` },
  mounted: { what: 'on a mounted gun (vetoed)', setup: `__sm.prep.mount()`, veto: /climb|airborne/ },
  ride: { what: 'a Mainliner riding the player (vetoed)', setup: `__sm.prep.ride()`, veto: /climb|airborne|busy/ },
  thrown: { what: "a flare and an NPC's Molotov in the air", setup: `__sm.prep.thrown()`, expect: /in the air: [1-9]/ },
  rideCheckpoint: { what: 'a checkpoint requested while held: it waits for the release', setup: `__sm.prep.rideCheckpoint()`, expect: /riding the player: true; waited held for [1-9]\d* frames; taken while held: false/ },
  // A port option (a setting, never in a save): saves made with it on load the same; the option
  // keeps its own value across loads (src/game/port-options.ts).
  ignorePlayer: { what: '"Enemies ignore the player" on, creatures next to him', setup: `import('/src/game/port-options.ts').then(async (m) => { m.portOptions.ignorePlayer = true; const f = await __sm.prep.fight(2); return 'ignorePlayer ' + m.portOptions.ignorePlayer + '; ' + f; })` },
  cinematic: { what: 'a cinematic playing (vetoed)', setup: `__sm.prep.cinematic()`, veto: /cinematic/ },
};

// Sessions: one level start each. `configs` in order; `route`: play the route to that step
// first (playthrough.mjs --to); `query`: extra URL parameters (Enhanced mode).
const ALL_LEVELS = ['0', '1a', '1b', '1c', '2', '3a', '3b', '4a', '4b', '5a', '5b', '6a', '6b', '8a', '8b', '9', '10'];
const EXTRAS = [
  ['fight', 'dismember'],
  ['creature', 'lowHealth', 'human'],
  ['fullInventory', 'npcDrop'],
  ['flashlight', 'gibs'],
  ['repLow', 'shotgun'],
  ['ladder', 'repHigh'],
];
const SESSIONS = Object.fromEntries([
  ...ALL_LEVELS.map((l, i) => [l, { level: l, configs: ['base', 'checkpoint', ...EXTRAS[i % EXTRAS.length]] }]),
  // Difficulty: the same level on Easy and Impossible (the placed objects differ).
  ['1b-easy', { level: '1b', difficulty: 0, configs: ['base', 'fight', 'ignorePlayer'] }],
  ['3a-impossible', { level: '3a', difficulty: 3, configs: ['base', 'fight'] }],
  // Enhanced mode gore (decals are effects: not saved; the bodies' cuts are).
  ['1a-enhanced', { level: '1a', query: 'gfx=enhanced', configs: ['fight', 'dismember', 'gibs'] }],
  // Played to a point: companions following, a fight under way, a creature on the ceiling.
  ['route-1a', { level: '1a', route: '1a.cartwheeler', configs: ['base', 'fight', 'lowHealth', 'checkpoint'] }],
  ['route-1c', { level: '1c', route: '1c.companion', configs: ['base', 'fight', 'checkpoint'] }],
  ['route-2', { level: '2', route: '2.dallas', configs: ['base', 'creature', 'human', 'checkpoint'] }],
  ['route-6b', { level: '6b', route: '6b.clem', configs: ['base', 'fight', 'checkpoint'] }],
  ['route-9', { level: '9', route: '9.escort1', configs: ['base', 'fight', 'checkpoint'] }],
  // Gibs (a type 8 blow on a body), dropped weapons (an armed NPC killed), a CartWheeler body.
  ['gore-3b', { level: '3b', configs: ['fight', 'dismember', 'gibs'] }],
  ['gore-1c', { level: '1c', configs: ['fight', 'gibs', 'npcDrop'] }],
  ['drops-2', { level: '2', configs: ['npcDrop', 'gibs'] }],
  ['drops-10', { level: '10', configs: ['npcDrop', 'fight', 'dismember'] }],
  // Scripted locomotion and holds: the crane controls, a mounted gun, a Mainliner's ride.
  ['specials-4b', { level: '4b', configs: ['base', 'crane', 'craneAfter', 'checkpoint'] }],
  ['specials-3a', { level: '3a', configs: ['base', 'mounted', 'checkpoint'] }],
  ['specials-2', { level: '2', configs: ['base', 'ride', 'checkpoint'] }],
  ['held-2', { level: '2', configs: ['base', 'rideCheckpoint', 'thrown'] }],
]);

// ---------------------------------------------------------------------------------------------

const report = { started: new Date().toISOString(), sessions: [] };
const save = () => OUT && writeFileSync(OUT, JSON.stringify(report, null, 1));

let vite;
let viteCfg;
let child;
const cleanup = () => {
  try {
    child?.kill('SIGTERM');
  } catch {}
  try {
    if (vite) process.kill(-vite.pid, 'SIGTERM');
  } catch {}
  try {
    if (viteCfg) rmSync(viteCfg, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

async function startVite() {
  const url = opt('--url');
  if (url) return url;
  const port = await freePort();
  viteCfg = mkdtempSync(join(TMP, 'save-matrix-vite-'));
  const cfg = join(viteCfg, 'vite.config.mjs');
  writeFileSync(cfg, `import base from ${JSON.stringify(join(ROOT, 'vite.config.ts'))};\nexport default { ...base, root: ${JSON.stringify(ROOT)}, cacheDir: ${JSON.stringify(join(viteCfg, 'cache'))}, server: { ...(base.server ?? {}), hmr: false, watch: null } };\n`);
  vite = spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
  const base = `http://localhost:${port}`;
  await waitFor(async () => (await fetch(base)).ok, 180_000, 'dev server');
  return base;
}

/** The playthrough harness with its control server, at a level start (or a route step). */
async function startHarness(base, s) {
  const a = ['tools/playthrough.mjs', '--url', base, '--keep', '--ctl', String(CTL), '--tmp', TMP, '--invulnerable'];
  // (`menus`: New Game through the front end, as a player starts.)
  if (!s.menus) a.push('--level', s.level);
  if (s.route) a.push('--to', s.route);
  else a.push(...(s.menus ? [] : ['--direct']), '--to', 'none'); // (no such step: the route loop runs no step)
  if (s.difficulty !== undefined) a.push('--difficulty', String(s.difficulty));
  if (s.query) a.push('--query', s.query);
  child = spawn('node', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ready = await waitFor(async () => (/control server on/.test(out) ? 'ok' : child.exitCode !== null ? 'exit' : null), s.route ? 1_800_000 : 900_000, `harness for ${s.level}`).catch((e) => e.message);
  if (ready !== 'ok') return { error: `harness did not start: ${ready}; ${out.split('\n').slice(-8).join(' | ')}` };
  return { out: () => out };
}

async function ctl(path, body) {
  const r = await fetch(`http://127.0.0.1:${CTL}${path}`, { method: body === undefined ? 'GET' : 'POST', body });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function ev(js) {
  const v = await ctl('/eval', js);
  if (v && typeof v === 'object' && 'error' in v && Object.keys(v).length === 1) throw new Error(v.error);
  return v;
}
const key = (code, type) => ctl('/key', JSON.stringify({ code, type, key: code === 'KeyW' ? 'w' : code }));
const PAGES = [readFileSync(join(ROOT, 'tools/playthrough-restore.js'), 'utf8'), readFileSync(join(ROOT, 'tools/save-matrix-page.js'), 'utf8')];
async function inject() {
  await waitFor(() => ev(`!!(window.__world?.world && window.__actors?.combat && window.__view?.collision && window.__world.world.time > 0.5)`), 600_000, 'level systems');
  for (const p of PAGES) await ev(p);
  await ev(`(() => { __actors.combat.invulnerable = true; return 1; })()`);
}
/** The level's opening cinematic (or any running) skipped, as a player skips it with Enter. */
async function skipCinematics() {
  for (let i = 0; i < 12; i++) {
    const on = await ev(`!!window.__world && (__world.world.playerInCutscene() || __world.world.activeCutscenes().length > 0)`).catch(() => false);
    // A Movie Player's movie (3b's flashbacks): skipped with Enter, as a player does.
    const movie = await ev(`[...document.querySelectorAll('.cutscene-layer')].some((e) => e.style.display !== 'none')`).catch(() => false);
    if (!on && !movie) return i;
    if (movie) {
      await key('Enter', 'keyDown');
      await key('Enter', 'keyUp');
    }
    await ev(`(() => { __world.world.skipCutscenes(); return 1; })()`).catch(() => {});
    await sleep(1500);
  }
  return -1;
}

/** Console errors / exceptions since `n` (the harness's log of the page). */
async function errorsSince(n) {
  const l = await ctl(`/logs?since=${n}`);
  return { n: l.n, errors: (l.logs ?? []).filter((x) => /^(error|EXC)/.test(x)).map((x) => x.slice(0, 240)) };
}

/** Play on: a move key held 1.2 s (W, else S, A, D: a wall may be ahead); the player must move (unless a cinematic holds him) and live. */
async function playOn() {
  const a = await ev(`__sm.probe()`);
  // (A Level Transition walked into must not take the session to another level.)
  await ev(`__sm.holdTransitions(true)`);
  let b = a;
  let moved = 0;
  for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
    const p0 = await ev(`__sm.probe()`);
    await key(k, 'keyDown');
    await sleep(1200);
    await key(k, 'keyUp');
    await sleep(500);
    b = await ev(`__sm.probe()`);
    moved = Math.max(moved, Math.hypot(b.p[0] - p0.p[0], b.p[2] - p0.p[2]));
    if (moved >= 0.05 || b.cine || b.override) break;
  }
  const tried = await ev(`__sm.holdTransitions(false)`);
  const problems = [];
  if (!(b.t > a.t)) problems.push('level time stood still');
  if (!b.alive) problems.push('player dead');
  // (Disabled after walking: what he walked into took him, a scripted scene of the level.)
  if (!b.enabled && !b.cine && moved < 0.05) problems.push('player disabled');
  if (moved < 0.05 && !b.cine && !b.override) problems.push(`player did not move (${moved.toFixed(2)} m with W / S / A / D)`);
  return { moved: +moved.toFixed(2), problems, ...(tried ? { transitionHeld: tried } : {}) };
}

async function runConfig(sess, name, i) {
  const c = CONFIGS[name];
  const id = `matrix-${sess.id}-${i}-${name}`;
  const row = { config: name, what: c.what, id };
  const log0 = (await ctl('/logs?since=0')).n;
  try {
    if (c.setup) row.setup = await ev(`(async () => String(await (${c.setup})))()`);
    if (c.expect && !c.expect.test(row.setup ?? '')) row.error = `set-up check failed: ${row.setup}`;
    // Nothing to set up in this level (no ladder, no Mountable, no armed NPC near): n/a.
    if (/^no /.test(row.setup ?? '') && c.veto) {
      row.na = true;
      row.ok = true;
      console.log(`  n/a  ${name}: ${row.setup}`);
      return row;
    }
    // (A vetoed state is captured at once: a morph or a short sequence would be over.)
    await sleep(c.veto ? 0 : c.setup ? 800 : 3000);
    // A cinematic the last play-on walked into is skipped first (a player cannot save in one).
    if (!c.veto) row.skippedCinematics = await skipCinematics();
    let t;
    if (c.kind === 'checkpoint') {
      // The save system's own checkpoint (requested, taken once the logic settled), persisted.
      t = await ev(`(async () => {
        __saves.persist = true;
        const before = __saves.checkpoint?.createdAt ?? 0;
        __saves.requestCheckpoint('save matrix');
        await __sm.until(() => (__saves.checkpoint?.createdAt ?? 0) > before && __ptRestore.state.cpAt === __saves.checkpoint.createdAt, 20000);
        const cp = __saves.checkpoint;
        if (!cp || cp.createdAt === before) return { error: 'no checkpoint taken' };
        const d = { ...cp, id: ${JSON.stringify(id)} };
        __sm.S0[d.id] = { ...__ptRestore.state.cp, ...__sm.extra() };
        __sm.D[d.id] = d;
        await __sm.until(() => __sm.cpLive?.at === cp.createdAt && !!__sm.cpLive.c, 5000);
        if (__sm.cpLive?.at === cp.createdAt) (__sm.S0b[d.id] = __sm.cpLive.b, __sm.S0c[d.id] = __sm.cpLive.c);
        const auto = await __saves.get('autosave');
        return { veto: __saves.canSave(), bytes: JSON.stringify(d).length, autosave: !!auto && auto.createdAt === cp.createdAt, level: d.levelName };
      })()`);
    } else t = await ev(`__sm.take(${JSON.stringify(id)})`);
    if (t?.error) throw new Error(t.error);
    row.veto = t.veto;
    row.bytes = t.bytes;
    if (t.autosave !== undefined) row.autosave = t.autosave;
    if (c.veto) row.vetoOk = c.veto.test(t.veto ?? '');
    else if (t.veto && c.kind !== 'checkpoint') row.unexpectedVeto = t.veto;
    row.providers = t.providers;
    row.store = await ev(`__sm.persist(${JSON.stringify(id)})`);
    const r = await ev(`__sm.restore(${JSON.stringify(id)})`);
    row.same = r;
    await inject();
    row.play = await playOn();
    row.errors = (await errorsSince(log0)).errors;
  } catch (e) {
    row.error = String(e.message ?? e).slice(0, 400);
    await inject().catch(() => {});
  }
  // A vetoed state: the original refuses the save, so what a forced capture loses there (the
  // ladder's script, the morph's progress) is reported (`forced`) but is not a failure.
  const state = [...(row.same?.hard ?? []), ...(row.same?.extra ?? []), ...(row.same?.providers ?? [])];
  if (c.veto) row.forced = state;
  const bad = [row.error, ...(c.veto ? [] : state), ...(row.play?.problems ?? []), ...(row.errors ?? [])].filter(Boolean);
  row.ok = !bad.length && row.store?.same !== false && (c.veto ? row.vetoOk === true : true);
  console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${name}${row.setup ? ` (${row.setup})` : ''}: ${row.bytes ?? '?'} B, store ${row.store?.same ? 'same' : 'DIFF'}, hard ${row.same?.hard?.length ?? '?'}, extra ${row.same?.extra?.length ?? '?'}, providers ${row.same?.providers?.length ?? '?'}, play ${row.play?.problems?.join('; ') || 'ok'}${row.error ? ` ERROR ${row.error}` : ''}`);
  for (const x of [...(row.same?.hard ?? []).slice(0, 8), ...(row.same?.extra ?? []), ...(row.same?.providers ?? []).slice(0, 8), ...(row.errors ?? []).slice(0, 4)]) console.log(`         ${x}`);
  return row;
}

async function runSession(base, sid) {
  const s = { id: sid, ...SESSIONS[sid] };
  const only = sid === 'adhoc' ? null : opt('--configs')?.split(',');
  const configs = s.configs.filter((c) => !only || only.includes(c));
  const rec = { session: sid, level: s.level, route: s.route, difficulty: s.difficulty ?? 1, query: s.query, rows: [], reload: [] };
  report.sessions.push(rec);
  console.log(`session ${sid}: ${s.route ? `route to ${s.route}` : `level ${s.level}`}${s.difficulty !== undefined ? `, difficulty ${s.difficulty}` : ''}${s.query ? `, ${s.query}` : ''}`);
  const t0 = Date.now();
  const h = await startHarness(base, s);
  if (h.error) {
    rec.error = h.error;
    console.log(`  ${h.error}`);
    child?.kill('SIGTERM');
    return;
  }
  try {
    await inject();
    rec.skipped = await skipCinematics();
    rec.store = await ev(`__saves.store.kind`);
    let clean = null;
    for (let i = 0; i < configs.length; i++) {
      const row = await runConfig(s, configs[i], i);
      rec.rows.push(row);
      save();
      // A vetoed state (ladder, morph, cinematic) is left by going back to the last save made
      // in a state that allows saving.
      if (CONFIGS[configs[i]].veto && clean) {
        await ev(`__sm.restore(${JSON.stringify(clean)})`).catch(() => {});
        await inject().catch(() => {});
        await skipCinematics();
      } else if (!row.error) clean = row.id;
    }
    if (!has('--no-reload')) {
      // A fresh page: only the store is left.
      console.log('  page reload');
      const S0 = await ev(`JSON.stringify({ S0: __sm.S0, S0b: __sm.S0b, S0c: __sm.S0c })`);
      await ev(`(() => { setTimeout(() => location.reload(), 50); return 1; })()`).catch(() => {});
      await sleep(4000);
      await inject();
      await skipCinematics();
      await ev(`(() => { const x = JSON.parse(${JSON.stringify(S0)}); Object.assign(__sm.S0, x.S0); Object.assign(__sm.S0b, x.S0b); Object.assign(__sm.S0c, x.S0c); return 1; })()`);
      for (const row of rec.rows) {
        if (!row.id || row.error || row.na) continue;
        const log0 = (await ctl('/logs?since=0')).n;
        const r = { config: row.config, id: row.id };
        try {
          r.same = await ev(`__sm.restore(${JSON.stringify(row.id)}, { fromStore: true })`);
          await inject();
          r.play = await playOn();
          r.errors = (await errorsSince(log0)).errors;
        } catch (e) {
          r.error = String(e.message ?? e).slice(0, 400);
          await inject().catch(() => {});
        }
        const forced = !!CONFIGS[row.config]?.veto;
        const bad = [r.error, r.same?.error, ...(forced ? [] : [...(r.same?.hard ?? []), ...(r.same?.extra ?? []), ...(r.same?.providers ?? [])]), ...(r.play?.problems ?? []), ...(r.errors ?? [])].filter(Boolean);
        r.ok = !bad.length;
        rec.reload.push(r);
        console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} reload/${row.config}: hard ${r.same?.hard?.length ?? '?'}, extra ${r.same?.extra?.length ?? '?'}, providers ${r.same?.providers?.length ?? '?'}, play ${r.play?.problems?.join('; ') || 'ok'}${r.error || r.same?.error ? ` ERROR ${r.error ?? r.same.error}` : ''}`);
        for (const x of [...(r.same?.hard ?? []).slice(0, 8), ...(r.same?.extra ?? []), ...(r.same?.providers ?? []).slice(0, 8), ...(r.errors ?? []).slice(0, 4)]) console.log(`         ${x}`);
        save();
      }
    }
    // Leave the store as found.
    await ev(`(async () => { for (const s of await __saves.list()) if (s.id.startsWith('matrix-')) await __saves.delete(s.id); return 1; })()`).catch(() => {});
  } catch (e) {
    rec.error = String(e.message ?? e).slice(0, 400);
    console.log(`  session error: ${rec.error}`);
  } finally {
    rec.seconds = Math.round((Date.now() - t0) / 1000);
    await ctl('/quit').catch(() => {});
    await sleep(1500);
    try {
      child?.kill('SIGTERM');
    } catch {}
    child = null;
    save();
  }
}

// ---------------------------------------------------------------------------------------------
// Storage robustness (in the page; the store module is the app's own, through the dev server).

async function storageChecks(base) {
  const s = { id: 'storage', level: '1a', configs: [] };
  console.log('storage checks (level 1a)');
  const h = await startHarness(base, s);
  if (h.error) return void (report.storage = { error: h.error });
  try {
    await inject();
    report.storage = await ev(readFileSync(join(ROOT, 'tools/save-matrix-storage.js'), 'utf8'));
    for (const [k, v] of Object.entries(report.storage)) console.log(`  ${v?.ok ? 'ok  ' : 'FAIL'} ${k}: ${JSON.stringify(v).slice(0, 300)}`);
  } catch (e) {
    report.storage = { error: String(e.message ?? e) };
    console.log(`  error: ${e.message}`);
  } finally {
    await ctl('/quit').catch(() => {});
    await sleep(1500);
    child?.kill('SIGTERM');
    child = null;
    save();
  }
}

// ---------------------------------------------------------------------------------------------
// Revisits: 3a changed (creatures cloned and killed, a body cut), left for 3b through its
// transition, a save made in 3b, back to 3a through 3b's own Level Transition: 3a must be as it
// was left. Again after a page reload, from the 3b save in the store (its `levels` carry 3a).

async function revisitChecks(base) {
  console.log('revisit checks (3a -> 3b -> 3a)');
  const out = (report.revisit = {});
  const h = await startHarness(base, { id: 'revisit', level: '3a' });
  if (h.error) return void (out.error = h.error);
  const levelIs = (re) => waitFor(async () => re.test(await ev(`window.__world?.world?.opts.levelPath ?? ''`).catch(() => '')) && (await ev(`!!window.__actors?.combat && __world.world.time > 1`).catch(() => false)), 300_000, `level ${re}`);
  const back3a = async () => {
    const uid = await ev(`(__world.world.of('Level Transition').find((t) => /3a /i.test(String(t.e.props.targetLevel ?? ''))) ?? {}).uid ?? null`);
    if (!uid) throw new Error("3b has no Level Transition to 3a");
    await ev(`__campaign.service.fireTransition(${uid}, true)`);
    await levelIs(/3a /);
    await inject();
    await waitFor(() => ev(`!!__sm.back`), 30_000, 'the arrival fingerprint');
  };
  try {
    await inject();
    await skipCinematics();
    out.changes = [await ev(`__sm.prep.fight(2)`), await ev(`__sm.prep.dismember()`), await ev(`__sm.prep.npcDrop()`)];
    await ev(`__campaign.service.fireTransition(0x18dc, true)`);
    await levelIs(/3b /);
    const left = await ev(`JSON.stringify(__sm.left?.snap ?? null)`);
    await inject();
    await skipCinematics();
    const t = await ev(`__sm.take('matrix-revisit-3b')`);
    out.save = { bytes: t.bytes, levels: await ev(`Object.keys(__sm.D['matrix-revisit-3b'].levels)`), store: await ev(`__sm.persist('matrix-revisit-3b')`) };
    await back3a();
    // As left vs as found: what differs is the arrival's own doing (3b posts 31:1 to 3a's Level
    // Transition Msg Handler: the burnt walkway) or a save error; listed, then the decisive
    // check: the same trip from the stored 3b save after a page reload must find 3a the same.
    out.leftVsBack = await ev(`__sm.revisitDiff(JSON.parse(${JSON.stringify(left)}))`);
    const back1 = await ev(`JSON.stringify(__sm.back.snap)`);
    console.log(`  info revisit, 3a as left vs as found: ${out.leftVsBack.hard.length} differences${out.leftVsBack.hard.length ? `: ${out.leftVsBack.hard.slice(0, 6).join('; ')}` : ''}`);
    // A fresh page: the 3b save from the store, then back to 3a.
    await ev(`(() => { setTimeout(() => location.reload(), 50); return 1; })()`).catch(() => {});
    await sleep(4000);
    await inject();
    await ev(`__saves.get('matrix-revisit-3b').then((d) => __saves.host.restore(d))`);
    await levelIs(/3b /);
    await inject();
    await skipCinematics();
    await back3a();
    out.afterReload = await ev(`__sm.revisitDiff(JSON.parse(${JSON.stringify(back1)}))`);
    out.ok = !out.afterReload.hard.length;
    console.log(`  ${out.ok ? 'ok  ' : 'FAIL'} revisit from the stored 3b save after a page reload vs the same trip without: hard ${out.afterReload.hard.length}${out.afterReload.hard.length ? `: ${out.afterReload.hard.slice(0, 8).join('; ')}` : ''}`);
    out.play = await playOn();
    out.errors = (await errorsSince(0)).errors.slice(0, 10);
  } catch (e) {
    out.error = String(e.message ?? e).slice(0, 400);
    console.log(`  error: ${out.error}`);
  } finally {
    await ctl('/quit').catch(() => {});
    await sleep(1500);
    child?.kill('SIGTERM');
    child = null;
    save();
  }
}

// ---------------------------------------------------------------------------------------------
// The menu flow: file rows, imports / exports, an imported original save loaded, Continue after a
// page reload (tools/save-matrix-menus.js).

async function menuChecks(base) {
  console.log('menu flow checks (New Game through the menus)');
  const h = await startHarness(base, { id: 'menus', menus: true, level: '1a' });
  if (h.error) return void (report.menus = { error: h.error });
  const js = readFileSync(join(ROOT, 'tools/save-matrix-menus.js'), 'utf8');
  try {
    await waitFor(() => ev(`!!(window.__menu?.inGame && window.__world?.world && window.__world.world.time > 0.5)`), 600_000, 'the game through the menus');
    await skipCinematics();
    report.menus = await ev(`(${js})('files')`);
    await ev(`(() => { setTimeout(() => (location.href = '/?skipintro'), 50); return 1; })()`).catch(() => {});
    await sleep(5000);
    Object.assign(report.menus, await ev(`(${js})('continue')`));
    for (const [k, v] of Object.entries(report.menus)) console.log(`  ${v?.ok ? 'ok  ' : 'FAIL'} ${k}: ${JSON.stringify(v).slice(0, 400)}`);
  } catch (e) {
    report.menus = { ...(report.menus ?? {}), error: String(e.message ?? e) };
    console.log(`  error: ${e.message}`);
  } finally {
    await ctl('/quit').catch(() => {});
    await sleep(1500);
    child?.kill('SIGTERM');
    child = null;
    save();
  }
}

try {
  mkdirSync(TMP, { recursive: true });
  const base = await startVite();
  if (has('--storage')) await storageChecks(base);
  if (has('--menus')) await menuChecks(base);
  if (has('--revisit')) await revisitChecks(base);
  // --level <id> --configs a,b: an ad-hoc session of that level (--route <step>, --difficulty, --query).
  if (opt('--level')) SESSIONS.adhoc = { level: opt('--level'), route: opt('--route'), difficulty: opt('--difficulty') !== undefined ? Number(opt('--difficulty')) : undefined, query: opt('--query'), configs: opt('--configs', 'base').split(',') };
  const list = opt('--level') ? ['adhoc'] : (has('--storage') || has('--menus') || has('--revisit')) && !opt('--sessions') ? [] : (opt('--sessions')?.split(',') ?? Object.keys(SESSIONS));
  for (const sid of list) {
    if (!SESSIONS[sid]) {
      console.log(`no session ${sid}`);
      continue;
    }
    await runSession(base, sid);
  }
  const rows = report.sessions.flatMap((s) => [...s.rows, ...s.reload]);
  console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} ok`);
} catch (e) {
  console.error(e);
} finally {
  save();
  cleanup();
}
process.exit(0);
