// Browser side of the STOMP track audit (tools/stomp-audit.ts): plays a level's sequences in a
// headless Chromium-family browser and records what every track's object actually shows at
// the audit's sample times (window.__stomp.probe), plus the delivery of message keys.
//
//   npx tsx tools/stomp-audit.ts "<.lvl>" --json exp.json            expectations
//   node tools/stomp-sample.mjs --expect exp.json --out actual.json [--level LEVELS/...lvl]
//        [--seq <name filter>] [--speed 3] [--shots <dir> --at "Goose#284:166,193.8"]
//        [--after <s>] [--settle <s>] [--url http://localhost:5173]
//   npx tsx tools/stomp-audit.ts "<.lvl>" --actual actual.json        diff + discrepancy report
//
// Each selected sequence is started through its STOMP Player (input "Play") unless the level
// started it already, and played to its end at `--speed` x game speed. Frames are not drawn
// while sampling (the GPU is the bottleneck headless) except for screenshots (--shots: PNGs of
// the given sequence times, and `--after` seconds after each sequence ends). `--settle` (default
// 3 game seconds) records the end state again after each sequence (__stomp.snapshot). Level
// transitions reached through forced sequences are blocked. Game data is read
// by the dev server at runtime; nothing of it is written to the repo.
//
// Browser: $SMOKE_BROWSER, else the first of Chrome / Brave / Edge / Chromium found.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const expectPath = opt('--expect');
const outPath = opt('--out', 'stomp-actual.json');
const level = opt('--level', 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl');
const filter = opt('--seq', '').toLowerCase();
const speed = Number(opt('--speed', '3'));
const shotsDir = opt('--shots');
const after = Number(opt('--after', '0'));
const shotAt = new Map(
  (opt('--at', '') || '')
    .split(';')
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(':');
      return [s.slice(0, i), s.slice(i + 1).split(',').map(Number)];
    }),
);
if (!expectPath || !existsSync(expectPath)) {
  console.error('usage: node tools/stomp-sample.mjs --expect exp.json --out actual.json [--level ...] [--seq name] [--speed 3]');
  process.exit(1);
}

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
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (/level gone/.test(e?.message)) throw new Error('the level was unloaded (page reloaded?)');
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const raw = JSON.parse(readFileSync(expectPath, 'utf8'));
const expectations = Array.isArray(raw) ? raw : raw.tracks;
const indirect = Array.isArray(raw) ? [] : (raw.indirect ?? []);
const times = new Map();
const extra = new Map();
const addTime = (seq, t) => (times.get(seq) ?? times.set(seq, new Set()).get(seq)).add(t);
for (const x of expectations) {
  if (filter && !x.seq.toLowerCase().includes(filter)) continue;
  addTime(x.seq, x.t);
}
// Indirect targets (objects reached through relays / togglers / timers): sampled half a
// second after each effect, at the sampled times of the sequence and after its end.
for (const x of indirect) {
  if (!times.has(x.seq)) continue;
  (extra.get(x.seq) ?? extra.set(x.seq, new Set()).get(x.seq)).add(x.uid);
  addTime(x.seq, +(x.t + 0.5).toFixed(2));
}
const afterEnd = Number(opt('--settle', '3'));
const seqNames = [...times.keys()];

const bin = BROWSERS.find((b) => existsSync(b));
if (!bin) throw new Error('No Chromium-family browser found; set SMOKE_BROWSER');
let server;
let cfgDir;
let base = opt('--url');
if (!base) {
  const port = await freePort();
  // Own dev server without file watching / HMR: other edits to the tree must not reload the
  // page in the middle of a long sampling run.
  cfgDir = mkdtempSync(join(tmpdir(), 'suffering-stomp-vite-'));
  const cfg = join(cfgDir, 'vite.config.mjs');
  writeFileSync(
    cfg,
    `import base from ${JSON.stringify(join(process.cwd(), 'vite.config.ts'))};\nexport default { ...base, server: { ...base.server, hmr: false, watch: null } };\n`,
  );
  server = spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { stdio: 'ignore', detached: true });
  base = `http://localhost:${port}`;
}
const profile = mkdtempSync(join(tmpdir(), 'suffering-stomp-'));
const debugPort = await freePort();
let browser;
const cleanup = () => {
  try {
    browser?.kill('SIGKILL');
  } catch {}
  try {
    if (server) process.kill(-server.pid, 'SIGTERM');
  } catch {}
};
process.on('exit', cleanup);

try {
  await waitFor(async () => (await fetch(base)).ok, 30_000, 'dev server');
  browser = spawn(
    bin,
    ['--headless=new', '--disable-component-update', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--no-first-run', '--disk-cache-size=1', '--disable-gpu-shader-disk-cache', 'about:blank'],
    { stdio: 'ignore' },
  );
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 20_000, 'browser');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
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
  const drawing = (on) =>
    ev(`(() => { const r = __view.renderer; r.__render ??= r.render; r.render = ${on} ? r.__render : () => {}; return true; })()`);
  const shot = async (name) => {
    await ev(`window.__sampleTs = 0, true`);
    await drawing(true);
    await sleep(500);
    const png = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(png.result.data, 'base64'));
    await drawing(false);
    await ev(`window.__sampleTs = ${speed}, true`);
  };
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${base}/?skipintro&level=${encodeURIComponent(level).replace(/%2F/g, '/')}` });
  await waitFor(() => ev(`!!window.__stomp && !!window.__world && __world.world.time > 1`), 120_000, 'level').catch((e) => {
    throw new Error(`${e.message}${problems.length ? `; page exceptions: ${problems.slice(0, 3).join(' | ')}` : ''}`);
  });
  // Sequences are forced out of their level order: keep their side effects in this level
  // (a Level Transition reached through a sequence's message keys would reload the page).
  await ev(`(() => { const h = __world.world.hooks; h.requestLevel = (t) => console.info('[stomp-sample] level transition blocked:', t); return true; })()`);
  await ev(
    `__stomp.probe(${JSON.stringify(Object.fromEntries([...times].map(([k, v]) => [k, [...v]])))}, ${JSON.stringify(Object.fromEntries([...extra].map(([k, v]) => [k, [...v]])))}), true`,
  );
  await drawing(false);
  // The game sets the clock rate every frame (insanity system: Screen Clock effects, 1 when
  // none runs): the sampler's rate wins (game writes are ignored while sampling).
  await ev(`(() => { window.__sampleTs = ${speed}; Object.defineProperty(__view, 'timeScale', { configurable: true, get: () => window.__sampleTs, set: () => {} }); return true; })()`);
  // Sequence time of a running sequence, -1 when it is not running. Throws when the level is
  // gone (page reloaded), instead of waiting for the sequence until the timeout.
  const runT = (name) =>
    `(() => { if (!window.__stomp) throw new Error('level gone'); return __stomp.runs.find((r) => \`\${r.seq.tracks[0]?.name ?? ''}#\${r.seq.id}\` === ${JSON.stringify(name)})?.t ?? -1; })()`;
  const alive = async () => {
    if (!(await ev(`!!window.__stomp`).catch(() => false))) throw new Error('the level was unloaded (page reloaded?)');
  };
  // Sequences the level started itself (1a: the intro "Goose") come first; each forced one
  // starts only once no other sequence runs (a second cinematic would find the camera and the
  // player's puppet taken, and two sequences drive the same Player track).
  const running = await ev(`JSON.stringify(__stomp.runs.map((r) => \`\${r.seq.tracks[0]?.name ?? ''}#\${r.seq.id}\`))`).then(JSON.parse);
  seqNames.sort((a, b) => +running.includes(b) - +running.includes(a));
  for (const name of seqNames) {
    const t0 = Date.now();
    let t = await ev(runT(name));
    if (t < 0) await waitFor(() => ev(`__stomp.runs.length === 0`), 600_000, `other sequences before ${name}`);
    t = await ev(runT(name));
    // Already played by the level itself (a chain from an earlier sequence): a forced replay
    // would run against objects the first run destroyed.
    if (t < 0 && (await ev(`__stomp.probeSeen.includes(${JSON.stringify(name)})`))) {
      console.log(`played ${name} (started by the level)`);
      continue;
    }
    if (t < 0) {
      // Start it: the first STOMP Player of the level holding this sequence.
      const uid = await ev(`(() => { const w = __world.world; for (const e of w.of('STOMP Player')) { const s = w.sequenceOf(e); if (s && \`\${s.tracks[0]?.name ?? ''}#\${s.id}\` === ${JSON.stringify(name)}) { e.s.played = false; const slot = e.e.inputs.find((i) => i.slot === 5); w.send(e.uid, slot ? slot.message : 1, 0); return e.uid; } } return 0; })()`);
      if (!uid) {
        console.log(`skip ${name}: no STOMP Player`);
        continue;
      }
      t = await waitFor(async () => {
        const v = await ev(runT(name));
        return v >= 0 ? v + 1e-9 : 0;
      }, 10_000, `${name} start`).catch(() => -1);
      if (t < 0) {
        console.log(`skip ${name}: did not start`);
        continue;
      }
    }
    for (const at of shotAt.get(name) ?? []) {
      if (!shotsDir) break;
      await waitFor(async () => (await ev(runT(name))) >= at || (await ev(runT(name))) < 0, 1_800_000, `${name} @${at}`);
      await shot(`${name.replace(/[^\w]+/g, '_')}-${String(at).replace('.', '_')}`);
    }
    await waitFor(async () => (await ev(runT(name))) < 0, 1_800_000, `${name} end`);
    await alive();
    // End state: a few (game) seconds after the end, the objects must keep it.
    if (afterEnd > 0) {
      const w0 = await ev(`__world.world.time`);
      await waitFor(async () => (await ev(`__world.world.time`)) >= w0 + afterEnd, 120_000, `${name} settle`);
      await ev(`__stomp.snapshot(${JSON.stringify(name)}, ${afterEnd})`);
    }
    if (shotsDir && after > 0) {
      await sleep((after * 1000) / speed);
      await shot(`${name.replace(/[^\w]+/g, '_')}-after`);
    }
    console.log(`played ${name} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const rows = await ev(`JSON.stringify({ rows: __stomp.probeRows, messages: __stomp.probeMessages })`);
  writeFileSync(outPath, rows);
  console.log(`wrote ${outPath}${problems.length ? `; page exceptions: ${problems.slice(0, 3).join(' | ')}` : ''}`);
  ws.close();
} finally {
  const exited = browser && browser.exitCode === null ? new Promise((r) => browser.once('exit', r)) : null;
  cleanup();
  await Promise.race([exited, sleep(5000)]);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
}
process.exit(0);
