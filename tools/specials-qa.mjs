// Special moves / bosses harness (src/game/actors/specials, docs/game-logic.md §15.7): loads a
// level per scenario in a headless Chromium-family browser, stages the move (places the player,
// wakes the creature), samples a state log while it plays and writes a screenshot strip.
//
//   node tools/specials-qa.mjs --scenario nooseman[,burrower,...] --out <dir> [--url http://localhost:5173]
//
// Per scenario <out>/<name>.json (state log, events of window.__specials, checks) and
// <out>/<name>-strip.jpg (frames in time order, 3 per row). Exit code 1 when a check fails.
// Browser: $SMOKE_BROWSER, else Brave / Chrome / Edge / Chromium; a fresh profile under <out>
// with caches disabled, deleted afterwards. Game data is read by the dev server at runtime.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = resolve(opt('--out', 'specials-qa'));
const names = (opt('--scenario', '') || '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

const L = {
  '1a': 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl',
  '1b': 'LEVELS/1 PrisonDeathRow/1b PrisonDeathRow.lvl',
  '2': 'LEVELS/2 Cellblocks/2 Cellblocks.lvl',
  '3a': 'LEVELS/3 YardCellBlock/3a YardCellBlock.lvl',
  '3b': 'LEVELS/3 YardCellBlock/3b YardCellBlock.lvl',
  '4a': 'LEVELS/4 Quarry/4a Quarry.lvl',
  '5b': 'LEVELS/5 Asylum/5b Asylum.lvl',
  '6b': 'LEVELS/6 Woods/6b Woods.lvl',
  '9': 'LEVELS/9 Lighthouse/9 Lighthouse.lvl',
  '10': 'LEVELS/10 Docks/10 Docks.lvl',
};

// Page-side helpers (window.__qa), installed after the level is up.
const HELPERS = `
window.__qa = {
  A: () => __actors.manager,
  actor(uid) { return __actors.manager.get(uid); },
  byClass(cls) { return __actors.manager.actors.filter((a) => a.kind.className === cls && !a.template); },
  nearestTo(cls, p) { let b, bd = 1e9; for (const a of this.byClass(cls)) { if (!a.alive) continue; const d = Math.hypot(a.position.x - p.x, a.position.z - p.z); if (d < bd) (bd = d), (b = a); } return b; },
  // Player feet at distance d from the actor along the actor's facing (or a free direction), facing it.
  stage(a, d, yawOff = 0) {
    const coll = __view.collision; const p = a.position; let best = null;
    for (let k = 0; k < 16; k++) {
      const ang = a.yaw + yawOff + (k * Math.PI) / 8; const fx = -Math.sin(ang), fz = -Math.cos(ang);
      const x = p.x + fx * d, z = p.z + fz * d;
      const g = coll.raycast(x, p.y + 1.5, z, 0, -1, 0, 6);
      if (!g) continue;
      const y = p.y + 1.5 - g.distance;
      const blocked = coll.raycast(p.x, p.y + 1, p.z, fx, 0, fz, d);
      if (blocked) continue;
      best = { x, y, z }; break;
    }
    if (!best) best = { x: p.x + 2, y: p.y, z: p.z };
    __player.spawn(best, Math.atan2(-(p.x - best.x), -(p.z - best.z)));
    return best;
  },
  // Fresh creature from a template at a placed actor's spot (Object Cloner templates sit in their
  // arenas), the player d m away facing it; the creature is woken and set on the player.
  spawnAt(tpl, uid, d, yawOff = 0) {
    const src = this.actor(uid); const p = src.position;
    const a = __actors.services.actors.spawn(tpl, { x: p.x, y: p.y + 0.1, z: p.z }, src.yaw);
    a.wake(); if (a.profile.active && a.profile.active.kind !== 'dormant') a.setBehavior(a.profile.active, __actors.env);
    a.provoked = true;
    this.stage(a, d, yawOff); __player.setMode('tp'); this.face(a);
    return a;
  },
  face(a) { const p = __player.position; __player.yaw = Math.atan2(-(a.position.x - p.x), -(a.position.z - p.z)); __player.pitch = -0.1; },
  r: (x) => Math.round(x * 100) / 100,
  st(a) { const s = window.__specials?.get(a.uid)?.info ?? {}; const p = a.position; return { uid: a.uid?.toString(16), act: a.activity, hp: this.r(a.health), alive: a.alive, hidden: a.hidden, inv: a.invulnerable, pos: [this.r(p.x), this.r(p.y), this.r(p.z)], special: s }; },
  player() { const p = __player.position; const c = __actors.services.combat.player; return { hp: this.r(c.health), alive: c.alive, pos: [this.r(p.x), this.r(p.y), this.r(p.z)], held: !!__player.motionOverride }; },
};
true;`;

// Scenarios: level, setup (page JS; may return info), duration (s), shots (times, s),
// sample (page JS -> state), act (optional page JS run every sample), checks (log -> problems).
const SCENARIOS = {};
export function scenario(name, s) {
  SCENARIOS[name] = s;
}
const mod = await import('./specials-scenarios.mjs');
mod.default(scenario);

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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
const work = mkdtempSync(join(OUT, 'run-'));
if (!base) {
  const port = await freePort();
  // No file watching / HMR: edits elsewhere in the tree would reload the page mid-run.
  const cfg = join(work, 'vite.config.mjs');
  writeFileSync(cfg, `import base from ${JSON.stringify(join(process.cwd(), 'vite.config.ts'))};\nexport default { ...base, root: ${JSON.stringify(process.cwd())}, cacheDir: ${JSON.stringify(join(work, 'vite-cache'))}, server: { ...(base.server ?? {}), hmr: false, watch: null } };\n`);
  server = spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { stdio: 'ignore', detached: true });
  base = `http://localhost:${port}`;
}
const profileDir = join(work, 'profile');
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
    rmSync(work, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

let failed = 0;
try {
  await waitFor(async () => (await fetch(base)).ok, 90_000, 'dev server');
  browser = spawn(
    bin,
    [
      '--headless=new', '--disable-component-update', '--disable-background-networking',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
      '--no-first-run',
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--disable-gpu-shader-disk-cache',
      '--disable-application-cache',
      // Keep the profile small: no component / extension / safe-browsing downloads.
      '--disable-component-update',
      '--disable-extensions',
      '--disable-background-networking',
      '--safebrowsing-disable-auto-update',
      '--disable-sync',
      '--disable-features=OptimizationHints,OnDeviceHeadSuggest,MediaRouter',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 20_000, 'browser');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  let logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') {
      logs.push(`EXC ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`);
    } else if (d.method === 'Runtime.consoleAPICalled') {
      const t = d.params.args.map((a) => a.value ?? a.description).join(' ');
      if (d.params.type === 'error' || /\[specials\]/.test(t)) logs.push(`${d.params.type} ${t}`.slice(0, 400));
    }
  };
  // Every call gives up after 30 s (a stalled page - e.g. a movie - must not hang the run).
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pending.delete(i)) r({ result: { exceptionDetails: { text: `${method} timed out` } } });
      }, 30_000);
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const frame = async () => {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.4 } });
    return r.result?.data;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  for (const name of names) {
    const s = SCENARIOS[name];
    if (!s) {
      console.log(`unknown scenario ${name}`);
      failed++;
      continue;
    }
    logs = [];
    const report = { scenario: name, level: s.level, samples: [], frames: [], problems: [] };
    const t0 = Date.now();
    try {
      const url = `${base}/?difficulty=${s.difficulty ?? 1}&level=${encodeURIComponent(L[s.level] ?? s.level).replace(/%2F/g, '/')}`;
      await send('Page.navigate', { url });
      await waitFor(async () => ev(`(window.__world?.world.time ?? 0) > 1.5 && !!window.__actors && !!window.__specials`), 240_000, `level ${s.level}`);
      await ev(HELPERS);
      // Cinematics would hold the actors; skip what plays at the start.
      await ev(`(() => { const w = __world.world; if (w.activeCutscenes().length) w.skipCutscenes(); return true; })()`);
      await sleep(500);
      report.setup = await ev(`(async () => { ${s.setup} })()`);
      const shots = [...(s.shots ?? [])].sort((a, b) => a - b);
      const frames = [];
      const start = Date.now();
      let next = 0;
      while ((Date.now() - start) / 1000 < s.duration) {
        const t = (Date.now() - start) / 1000;
        if (s.act) await ev(`(() => { ${s.act} })()`).catch((e) => report.problems.push(`act: ${e.message}`));
        const st = await ev(`(() => { ${s.sample} })()`).catch((e) => ({ error: e.message }));
        report.samples.push({ t: +t.toFixed(2), ...st });
        if (next < shots.length && t >= shots[next]) {
          next++;
          const f = await frame();
          if (f) frames.push({ t: +t.toFixed(2), data: f, label: st?.label ?? '' });
        }
        await sleep(s.every ?? 250);
      }
      report.events = await ev(`(window.__specials?.events ?? []).slice(-150)`);
      report.final = await ev(`(() => { ${s.final ?? s.sample} })()`).catch((e) => ({ error: e.message }));
      report.problems.push(...(s.check?.(report) ?? []));
      report.logs = logs.slice(-200);
      report.frames = frames.map((f) => ({ t: f.t, label: f.label }));
      // Strip: 3 frames per row, labelled with the sample time.
      if (frames.length) {
        const strip = await ev(`(async () => {
          const frames = ${JSON.stringify(frames.map((f) => ({ t: f.t, label: f.label, src: 'data:image/jpeg;base64,' + f.data })))};
          const imgs = await Promise.all(frames.map((f) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = f.src; })));
          const w = imgs[0].width, h = imgs[0].height, cols = Math.min(3, imgs.length), rows = Math.ceil(imgs.length / cols);
          const c = document.createElement('canvas'); c.width = w * cols; c.height = h * rows;
          const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
          imgs.forEach((im, k) => { const x = (k % cols) * w, y = Math.floor(k / cols) * h; g.drawImage(im, x, y);
            g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, w, 20); g.fillStyle = '#ff0'; g.font = '13px monospace';
            g.fillText(frames[k].t.toFixed(1) + 's ' + frames[k].label, x + 4, y + 14); });
          return c.toDataURL('image/jpeg', 0.8).split(',')[1]; })()`);
        writeFileSync(join(OUT, `${name}-strip.jpg`), Buffer.from(strip, 'base64'));
      }
      report.seconds = Math.round((Date.now() - t0) / 1000);
    } catch (e) {
      report.problems.push(e.message);
      report.logs = logs.slice(-200);
    }
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(report, null, 1));
    const ok = !report.problems.length;
    if (!ok) failed++;
    console.log(`${name} (${s.level}): ${ok ? 'ok' : 'FAIL ' + report.problems.join('; ')} [${report.seconds ?? '?'}s] -> ${join(OUT, name + '.json')}`);
  }
} catch (e) {
  console.error(e);
  failed++;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
