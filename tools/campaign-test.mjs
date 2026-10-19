// Campaign harness: walks the whole Level Transition chain in a headless Chromium-family
// browser and plays the ending for good / neutral / evil reputation.
//
//   node tools/campaign-test.mjs [--url http://localhost:5173] [--from 0] [--to 20]
//        [--difficulty 1] [--endings good,neutral,evil] [--no-chain] [--shots <dir>]
//        [--out report.json]
//
// Chain: starts in the Prelude (developer viewer, ?level=...), and for every hop of the
// route (src/game/campaign/graph.ts CAMPAIGN_ROUTE: the transition naming each next chapter)
// teleports the player to the transition's trigger (its Detector, else the transition
// itself), lets the trigger fire, and fires the transition through the campaign service
// when its level logic has not unlocked it yet. After each arrival it checks: the level
// loaded, the player stands within 1.5 m of the spawn point the transition names (same rule
// as the world system: fromLevel + spawnName), there is floor under the player, the player
// has not fallen after 2 s, and the chapter index advanced.
//
// Endings: loads 10 Docks once per reputation, sets the reputation, enables the reputation
// relays (Relay a87, as the level does on reaching the docks), starts the final Timer 12c8
// and lets the chain run with cutscenes / movies skipped, up to the GUI Launcher of the
// Game Finished screen. Checks which ending movie, boat sequence and ending picture ran.
//
// Browser: $SMOKE_BROWSER, else the first of Chrome / Brave / Edge / Chromium found.
// Game data is read by the dev server at runtime; nothing of it is written anywhere.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const has = (k) => args.includes(k);
const from = Number(opt('--from', '0'));
const to = Number(opt('--to', '19'));
const difficulty = Number(opt('--difficulty', '1'));
const endings = (opt('--endings', 'good,neutral,evil') || '').split(',').filter(Boolean);
const shotsDir = opt('--shots');
const outPath = opt('--out');

const ROUTE = [
  ['0 Prelude Docks', '1a PrisonDeathRow', 'West Spawn'],
  ['1a PrisonDeathRow', '1b PrisonDeathRow', 'South Spawn'],
  ['1b PrisonDeathRow', '1c PrisonDeathRow', 'West Spawn'],
  ['1c PrisonDeathRow', '2 Cellblocks', 'East Spawn'],
  ['2 Cellblocks', '3a YardCellBlock', 'NorthEast Spawn'],
  ['3a YardCellBlock', '3b YardCellBlock', 'West Spawn'],
  ['3b YardCellBlock', '3a YardCellBlock', 'East Spawn'],
  ['3a YardCellBlock', '4a Quarry', 'SouthWest Spawn'],
  ['4a Quarry', '4b Quarry', ''],
  ['4b Quarry', '5a Asylum', 'East Spawn'],
  ['5a Asylum', '5b Asylum', 'North Spawn'],
  ['5b Asylum', '6a Woods', 'West Spawn'],
  ['6a Woods', '6b Woods', 'NorthEast Spawn'],
  ['6b Woods', '1b PrisonDeathRow', 'North Spawn'],
  ['1b PrisonDeathRow', '1a PrisonDeathRow', 'South Spawn'],
  ['1a PrisonDeathRow', '3a YardCellBlock', 'North Spawn'],
  ['3a YardCellBlock', '8a Bluff', 'SouthEast Spawn'],
  ['8a Bluff', '8b Bluff', ''],
  ['8b Bluff', '9 Lighthouse', ''],
  ['9 Lighthouse', '10 Docks', ''],
];
const LEVEL_PATHS = {
  '0 Prelude Docks': 'LEVELS/0 Prelude Docks/0 Prelude Docks.lvl',
  '1a PrisonDeathRow': 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl',
  '1b PrisonDeathRow': 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl',
  '1c PrisonDeathRow': 'LEVELS/1 PrisonDeathRow/1c PrisonDeathRow.lvl',
  '2 Cellblocks': 'LEVELS/2 Cellblocks/2 Cellblocks.lvl',
  '3a YardCellBlock': 'LEVELS/3 YardCellBlock/3a YardCellBlock.lvl',
  '3b YardCellBlock': 'LEVELS/3 YardCellBlock/3b YardCellBlock.lvl',
  '4a Quarry': 'LEVELS/4 Quarry/4a Quarry.lvl',
  '4b Quarry': 'LEVELS/4 Quarry/4b Quarry.lvl',
  '5a Asylum': 'LEVELS/5 Asylum/5a Asylum.lvl',
  '5b Asylum': 'LEVELS/5 Asylum/5b Asylum.lvl',
  '6a Woods': 'LEVELS/6 Woods/6a Woods.lvl',
  '6b Woods': 'LEVELS/6 Woods/6b Woods.lvl',
  '8a Bluff': 'LEVELS/8 Bluff/8a Bluff.lvl',
  '8b Bluff': 'LEVELS/8 Bluff/8b Bluff.lvl',
  '9 Lighthouse': 'LEVELS/9 Lighthouse/9 Lighthouse.lvl',
  '10 Docks': 'LEVELS/10 Docks/10 Docks.lvl',
};
// Ending expectations (10 Docks data): Movie Player, final boat STOMP Player, picture launcher.
const ENDINGS = {
  good: { rep: 120, movie: 0xb39, boat: 0x1089, picture: 0x123b },
  neutral: { rep: 0, movie: 0xb26, boat: 0x108a, picture: 0x123e },
  evil: { rep: -120, movie: 0xb3a, boat: 0x108b, picture: 0x123f },
};

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = createServer();
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
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

const bin = BROWSERS.find((b) => existsSync(b));
if (!bin) throw new Error('No Chromium-family browser found; set SMOKE_BROWSER');
let server;
let base = opt('--url');
if (!base) {
  const port = await freePort();
  // No file watching / HMR: other edits in the tree would reload the page mid-run.
  const cfgDir = mkdtempSync(join(tmpdir(), 'suffering-campaign-vite-'));
  const cfg = join(cfgDir, 'vite.config.mjs');
  writeFileSync(cfg, `import base from ${JSON.stringify(join(process.cwd(), 'vite.config.ts'))};\nexport default { ...base, root: ${JSON.stringify(process.cwd())}, server: { ...(base.server ?? {}), hmr: false, watch: null } };\n`);
  server = spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { stdio: 'ignore', detached: true });
  process.on('exit', () => rmSync(cfgDir, { recursive: true, force: true }));
  base = `http://localhost:${port}`;
}
const profileDir = mkdtempSync(join(tmpdir(), 'suffering-campaign-'));
const debugPort = await freePort();
let browser;
const cleanup = () => {
  try {
    browser?.kill('SIGKILL');
  } catch {}
  try {
    if (server) process.kill(-server.pid, 'SIGTERM');
  } catch {}
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const report = { difficulty, chain: [], endings: [], problems: [] };
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};

try {
  await waitFor(async () => (await fetch(base)).ok, 60_000, 'dev server');
  browser = spawn(
    bin,
    ['--headless=new', '--disable-component-update', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--no-first-run', 'about:blank'],
    { stdio: 'ignore' },
  );
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 20_000, 'browser');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') {
      const t = d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text;
      report.problems.push(t);
      logs.push(`EXC ${t}`);
    } else if (d.method === 'Runtime.consoleAPICalled') {
      const t = d.params.args.map((a) => a.value ?? a.description).join(' ');
      logs.push(`${d.params.type} ${t}`);
      if (d.params.type === 'error') report.problems.push(t.slice(0, 300));
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const key = async (code, k = code) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 13 });
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await sleep(400);
    const png = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(png.result.data, 'base64'));
  };
  await send('Runtime.enable');
  await send('Page.enable');

  const levelNow = `(() => { const w = window.__world?.world; return w ? w.opts.levelPath : ''; })()`;
  const stem = (p) => (p.split(/[\\/]/).pop() ?? p).replace(/\.lvl$/i, '');
  const waitLevel = async (name, ms = 180_000) => {
    await waitFor(async () => stem(await ev(levelNow)) === name && (await ev(`(window.__world?.world.time ?? 0) > 1.2 && !!window.__campaign`)), ms, `level ${name}`);
    // A death would restore the last checkpoint and cancel a pending transition.
    await ev(`(() => { if (window.__actors?.combat) __actors.combat.invulnerable = true; return true; })()`);
  };
  const open = async (name) => {
    // ?difficulty: the difficulty decides which placed objects are created when the level is parsed.
    await send('Page.navigate', { url: `${base}/?difficulty=${difficulty}&level=${encodeURIComponent(LEVEL_PATHS[name]).replace(/%2F/g, '/')}` });
    await waitLevel(name);
  };
  // Page-side helpers: the expected arrival spawn (world system rule) and the floor check.
  const PAGE_HELPERS = `
    window.__ct = {
      norm: (p) => { const k = String(p || '').replace(/\\\\/g, '/').toLowerCase(); const i = k.indexOf('levels/'); return i >= 0 ? k.slice(i) : k; },
      expected(fromLevel, spawnName) {
        const w = __world.world;
        const pts = w.of('Player Spawn Point').map((e) => ({ uid: e.uid, from: String(e.e.props.fromLevel || ''), name: String(e.e.props.spawnName || ''), pos: e.pos }));
        const fromHere = (p) => p.from && this.norm(p.from) === this.norm(fromLevel);
        let named = pts.filter((p) => p.name.toLowerCase() === spawnName.toLowerCase());
        if (!named.length && !spawnName) named = pts.filter(fromHere);
        const sp = named.find(fromHere) || named[0];
        return sp ? { ...sp, exact: !!fromHere(sp) && sp.name.toLowerCase() === spawnName.toLowerCase() } : null;
      },
      player() { const p = __player.position; return [p.x, p.y, p.z]; },
      // Height of the supporting surface relative to the feet (0 = standing on it), or -99.
      floor() { const p = __player.position; const g = __view.collision?.groundQuery(p.x, p.y + 0.5, p.z, 0.2, 6); return g && Number.isFinite(g.height) ? +(g.height - p.y).toFixed(2) : -99; },
    };
    true;`;

  // --- Chain ---------------------------------------------------------------------------
  if (!has('--no-chain')) {
    console.log(`Chain ${from}..${to} (${['Easy', 'Medium', 'Hard', 'Impossible'][difficulty]})`);
    await open(ROUTE[from][0]);
    for (let i = from; i <= to && i < ROUTE.length; i++) {
      const [a, b, spawnName] = ROUTE[i];
      const row = { hop: i + 1, from: a, to: b, spawn: spawnName };
      report.chain.push(row);
      const t0 = Date.now();
      try {
        if (stem(await ev(levelNow)) !== a) await open(a);
        await ev(PAGE_HELPERS);
        const before = await ev(`__campaign.state.chapterIndex`);
        const mailBefore = await ev(`__campaign.state.deliveries.length`);
        // Leave no cinematic half-played (a revisit would resume it: 1a's intro would end by
        // putting the player back in the cell on the way through in chapter 15).
        await ev(`(() => { const w = __world.world; if (w.activeCutscenes().length) w.skipCutscenes(); return true; })()`);
        // The route's transition: the one naming the next chapter.
        const lt = await ev(`(() => {
          const s = __campaign.service; const want = s.chapters[${i + 1}]?.template;
          return s.transitions().find((t) => t.chapter === want) ?? null; })()`);
        if (!lt) throw new Error('route transition not found');
        row.transition = lt.uid.toString(16);
        // Teleport to the trigger: a Detector linked to the transition, else the transition.
        const trig = await ev(`(() => {
          const w = __world.world; const lt = ${lt.uid};
          const d = w.of('Detector').find((e) => e.e.links.includes(lt) && !e.destroyed);
          const p = d?.box?.c ?? w.get(lt).pos; return { detector: d ? d.uid : 0, enabled: d ? d.enabled : false, pos: p };
        })()`);
        // Mail the level's logic posts on the way out (Level Transition Msg Handler senders
        // fired by a Detector near this exit, for the level being entered): 6b -> 1b 12:0,
        // 1c -> 2 2:1, 9 -> 10 10:1 (3b -> 3a 31:1 fires from the exit Detector itself).
        const code = (name) => { const m = /^(\d+)([abc]?)/.exec(name); return m ? (m[2] ? Number(m[1]) * 10 + 'abc'.indexOf(m[2]) + 1 : Number(m[1])) : -1; };
        row.posted = await ev(`(() => {
          const w = __world.world; const at = ${JSON.stringify(trig.pos)}; const out = [];
          for (const h of w.of('Level Transition Msg Handler')) {
            if (h.e.values[0] !== ${code(b)} || h.e.links.length) continue;
            const det = w.of('Detector').find((d) => d.e.links.includes(h.uid));
            const p = det?.box?.c ?? det?.pos;
            if (!det || !p || Math.hypot(p[0] - at[0], p[2] - at[2]) > 30) continue;
            w.send(h.uid, 1, det.uid); out.push(h.e.values[0] + ':' + h.e.values[1]);
          }
          return out; })()`);
        // Only Detector triggers need the player there (a transition object's own position can
        // be anywhere, e.g. over the water in the Prelude).
        if (trig.detector) await ev(`(() => { __player.spawn({ x: ${trig.pos[0]}, y: ${trig.pos[1] - 0.8}, z: ${trig.pos[2]} }, 0); return true; })()`);
        let how = '';
        if (trig.detector && trig.enabled && lt.enabled) {
          const left = await waitFor(async () => stem(await ev(levelNow)) !== a || (await ev(`__campaign.state.history.length`)) > 0 && 'fired', 3_000, 'detector').catch(() => false);
          if (left) how = 'detector';
        }
        if (!how) {
          const ok = await ev(`__campaign.service.fireTransition(${lt.uid}, true)`);
          how = ok ? (lt.enabled ? 'fired' : 'forced (disabled at start)') : 'refused';
        }
        row.how = how;
        await waitLevel(b);
        await ev(PAGE_HELPERS);
        const exp = await ev(`__ct.expected(${JSON.stringify(LEVEL_PATHS[a])}, ${JSON.stringify(spawnName)})`);
        await sleep(300);
        // Where the world system put the player ("[world] spawn ... at x, y, z"), and where it is now.
        const spawnLog = [...logs].reverse().find((l) => /\[world\] spawn /.test(l));
        const placed = spawnLog ? (/at (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)/.exec(spawnLog) ?? []).slice(1).map(Number) : null;
        const p0 = await ev(`__ct.player()`);
        const floor0 = JSON.parse(await ev(`JSON.stringify((() => { try { return __ct.floor(); } catch (e) { return String(e); } })())`) ?? 'null');
        await sleep(2000);
        const p1 = await ev(`__ct.player()`);
        const chapter = await ev(`__campaign.state.chapterIndex`);
        row.delivered = await ev(`__campaign.state.deliveries.slice(${mailBefore}).map((d) => d.key + '>' + d.handler.toString(16))`);
        row.spawnPoint = exp ? exp.uid.toString(16) : null;
        row.exact = !!exp?.exact;
        row.dist = exp && placed?.length === 3 ? +Math.hypot(placed[0] - exp.pos[0], placed[2] - exp.pos[2]).toFixed(2) : null;
        row.moved = exp ? +Math.hypot(p0[0] - exp.pos[0], p0[2] - exp.pos[2]).toFixed(2) : null;
        row.floor = floor0;
        row.drop = +(p0[1] - p1[1]).toFixed(2);
        row.chapter = chapter;
        row.seconds = Math.round((Date.now() - t0) / 1000);
        const problems = [];
        if (!exp) problems.push('no spawn point');
        else if (!exp.exact) problems.push('spawn point not exact');
        if (row.dist === null || row.dist > 0.5) problems.push(`placed ${row.dist} m from the spawn point`);
        if (row.moved === null || row.moved > 4) problems.push(`player ${row.moved} m from the spawn point after arrival`);
        if (!(floor0 > -1.5)) problems.push(`no floor under the player (${floor0})`);
        if (row.drop > 1.5) problems.push(`player fell ${row.drop} m`);
        if (!(chapter > before) && chapter !== i + 1) problems.push(`chapter ${before} -> ${chapter}`);
        row.ok = !problems.length;
        console.log(`  ${String(i + 1).padStart(2)} ${a} -> ${b} "${spawnName}" via #${row.transition} (${how}): spawn #${row.spawnPoint} d=${row.dist}/${row.moved} floor=${floor0} drop=${row.drop} chapter ${chapter}${row.posted?.length ? ` posted ${row.posted}` : ''}${row.delivered?.length ? ` mail ${row.delivered}` : ''} ${row.seconds}s ${row.ok ? 'ok' : ''}`);
        for (const p of problems) fail(`${a} -> ${b}: ${p}`);
        row.problems = problems;
        if (i === to) await shot(`arrival-${i + 1}-${b.replace(/\W+/g, '_')}`);
      } catch (e) {
        row.ok = false;
        row.error = e.message;
        fail(`${a} -> ${b}: ${e.message}`);
        // Continue from the next level fresh.
        if (i < to) await open(b).catch(() => {});
      }
    }
  }

  // --- Endings ---------------------------------------------------------------------------
  for (const name of endings) {
    const e = ENDINGS[name];
    if (!e) continue;
    const row = { ending: name, reputation: e.rep };
    report.endings.push(row);
    const t0 = Date.now();
    try {
      await open('10 Docks');
      await ev(`(() => { __insanity.model.s.reputation = ${e.rep}; window.__seen = new Set(); __world.world.subscribe('*', (m, f, t) => __seen.add(t)); return true; })()`);
      // Reaching the docks: Relay a87 enables the reputation's relays (Enable through the
      // Reputation Points Message Filters); the final Timer 12c8 starts the ending movie.
      await ev(`(() => { const w = __world.world; w.send(0xa87, 1, 0); w.send(0x12c8, 1, 0); return true; })()`);
      // Skip cinematics and movies until the Game Finished launcher opens.
      const done = await waitFor(
        async () => {
          await ev(`(() => { const w = __world.world; if (w.activeCutscenes().length) w.skipCutscenes(); return true; })()`);
          await key('Escape', 'Escape');
          return ev(`(() => { const l = __campaign.launchers(); return !!l && l.events.some((x) => x.uid === 0x123c && x.action === 'open'); })()`);
        },
        240_000,
        'Game Finished launcher',
      );
      const info = await ev(`(() => {
        const w = __world.world; const l = __campaign.launchers();
        return {
          movies: [0xb26, 0xb39, 0xb3a].filter((u) => __seen.has(u)),
          boats: [0x1089, 0x108a, 0x108b].filter((u) => w.get(u)?.s.played),
          pictures: l.events.filter((x) => x.mode === 5 && x.action === 'open').map((x) => x.uid),
          closed: l.events.filter((x) => x.mode === 5 && x.action === 'closed').map((x) => x.uid),
          ending: __campaign.state.ending,
          finished: l.events.some((x) => x.uid === 0x123c && x.action === 'open'),
          // Impossible only: the bonus movie (Movie Player 13b2, 34:5) before Game Finished.
          bonusMovie: !!w.get(0x13b2) && __seen.has(0x13b2),
        }; })()`);
      Object.assign(row, info, { seconds: Math.round((Date.now() - t0) / 1000) });
      if (shotsDir) {
        // The ending picture as the boat sequence shows it (launch, hold, then close).
        await ev(`(() => { __world.world.send(${e.picture}, 1, 0); return true; })()`);
        await sleep(2500);
        await shot(`ending-${name}`);
        await ev(`(() => { __world.world.send(${e.picture}, 2, 0); return true; })()`);
      }
      const problems = [];
      if (!done) problems.push('no Game Finished');
      if (info.ending !== name) problems.push(`ending ${info.ending}`);
      if (info.bonusMovie !== (difficulty === 3)) problems.push(`bonus movie ${info.bonusMovie} on difficulty ${difficulty}`);
      if (!info.movies.includes(e.movie) || info.movies.length !== 1) problems.push(`movies ${info.movies.map((u) => u.toString(16))}`);
      if (!info.boats.includes(e.boat) || info.boats.length !== 1) problems.push(`boat sequences ${info.boats.map((u) => u.toString(16))}`);
      if (!info.pictures.includes(e.picture) || info.pictures.length !== 1) problems.push(`pictures ${info.pictures.map((u) => u.toString(16))}`);
      row.ok = !problems.length;
      row.problems = problems;
      console.log(`  ending ${name} (rep ${e.rep}): movie ${info.movies.map((u) => u.toString(16))} boat ${info.boats.map((u) => u.toString(16))} picture ${info.pictures.map((u) => u.toString(16))} -> ${info.ending}, Game Finished ${info.finished} ${row.seconds}s ${row.ok ? 'ok' : ''}`);
      for (const p of problems) fail(`ending ${name}: ${p}`);
    } catch (err) {
      row.ok = false;
      row.error = err.message;
      fail(`ending ${name}: ${err.message}`);
    }
  }
  report.campaignLog = logs.filter((l) => /\[campaign\]|\[world\] (spawn|no spawn|level transition)|\[save\]/.test(l)).slice(-400);
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 1));
  console.log(failed ? `${failed} failure(s)` : 'all ok');
} catch (e) {
  console.error(e);
  failed++;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
