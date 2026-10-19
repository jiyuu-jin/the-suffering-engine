// Level QA harness: static checks (node) plus a headless-browser pass per level.
//
//   npx tsx tools/levelqa.ts                       every level outside chapter 1, static + browser
//   npx tsx tools/levelqa.ts --static              static checks only (no browser)
//   npx tsx tools/levelqa.ts --levels "0 Prelude,10 Docks"   substring filter on the .lvl path
//   npx tsx tools/levelqa.ts --all                 include chapter 1 (1a/1b/1c)
//   npx tsx tools/levelqa.ts --url http://localhost:5173     use a running dev server
//   npx tsx tools/levelqa.ts --out <dir>           screenshots + JSON (default $TMPDIR/levelqa)
//   npx tsx tools/levelqa.ts --doc                 (re)write the status table in docs/levels.md
//   npx tsx tools/levelqa.ts --reuse --doc         static checks again, browser results from <out>/levelqa.json
//
// Static (node, no renderer):
//   - packages listed in the .lvl header that do not resolve, texture keys not in any .tdu
//   - unresolved classes: placed classes not referenced by engine code (same heuristic as
//     tools/coverage.ts: the class name appears as a string literal in src/game or src/app)
//   - spawn validity: ray down from the Player object and every Player Spawn Point against
//     the level's static geometry (drop to ground, no ground, buried)
//   - Level Transitions: target .lvl resolves, and the target has a Player Spawn Point with
//     the requested spawn name coming from this level
// Browser (headless Chromium-family, $SMOKE_BROWSER or Brave/Chrome/Edge/Chromium):
//   - console errors / exceptions / warnings during load and the first seconds of play
//   - backend, fps, draw calls, triangles; whether the player is on the ground after 4 s
//     and how far it fell from its start
//   - screenshots: spawn view, overview from above
//
// The game data stays local; screenshots go to --out (never into the repo).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEntities, type Entity } from '../src/formats/entities';
import { instanceRotation, parseLevel, readLevelHeader } from '../src/formats/level';
import { decodeReferencedTextures, findLevelDependencies, loadPackages, stem } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { CollisionWorld } from '../src/app/physics';
import { SrscFile } from '../src/formats/srsc';
import { filesWithExt, hasData, nodeFS } from '../tests/helpers';
import { CLASS_ROWS } from '../src/formats/entity-classes';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const staticOnly = args.includes('--static');
const reuse = args.includes('--reuse');
const writeDoc = args.includes('--doc');
const includeCh1 = args.includes('--all');
const filter = opt('--levels')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const OUT = opt('--out') ?? join(tmpdir(), 'levelqa');
const urlArg = opt('--url');

const CH1 = /\/1 PrisonDeathRow\//;

export interface StaticReport {
  level: string;
  path: string;
  title: string;
  entities: number;
  parts: number;
  missingPackages: string[];
  textureKeys: number;
  missingTextures: string[];
  unresolvedClasses: { name: string; count: number }[];
  classes: Record<string, number>;
  spawns: { what: string; pos: [number, number, number]; drop: number | null; headroom: number | null }[];
  transitions: { uid: string; target: string; spawnNames: string[]; resolves: boolean; spawnFound: boolean | null }[];
  error?: string;
}

export interface BrowserReport {
  level: string;
  loaded: boolean;
  loadMs: number;
  backend?: string;
  errors: string[];
  warnings: string[];
  fps?: number;
  drawCalls?: number;
  triangles?: number;
  onGround?: boolean;
  fell?: number;
  start?: number[];
  end?: number[];
  shots: string[];
  world?: string;
  cutscenes?: string[];
  /** Errors while the harness flew the overview camera (not counted as level errors). */
  overviewErrors?: string[];
}

// ---------------------------------------------------------------------------
// Static checks

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const code = [...sources('src/game'), ...sources('src/app')].map((f) => readFileSync(f, 'utf8')).join('\n');
// As tools/coverage.ts: a class is also referenced by its class id (Portal: the visibility
// code finds it by 0x5b0bad74 and was listed here as unimplemented).
const idCode = [code, ...sources('src/formats').filter((f) => !f.endsWith('entity-classes.ts') && !f.endsWith('message-maps.ts')).map((f) => readFileSync(f, 'utf8'))].join('\n').toLowerCase();
const classIds = new Map(CLASS_ROWS.map((r) => [r[1] as string, r[0] as number]));
const hexId = (id: number) => '0x' + (id >>> 0).toString(16).padStart(8, '0');
const referenced = (name: string) => code.includes(`'${name}'`) || code.includes(`"${name}"`) || (classIds.has(name) && idCode.includes(hexId(classIds.get(name)!)));
/** Classes that need no runtime (editor / baked-only data). */
const PASSIVE = new Set(['Static Object', 'Move Node Object', 'Directional Light', 'Ambient Light', 'Camera', 'Player']);

const fs = nodeFS();

async function staticLevel(path: string): Promise<StaticReport> {
  const level = stem(path);
  const rep: StaticReport = {
    level,
    path,
    title: '',
    entities: 0,
    parts: 0,
    missingPackages: [],
    textureKeys: 0,
    missingTextures: [],
    unresolvedClasses: [],
    classes: {},
    spawns: [],
    transitions: [],
  };
  try {
    const deps = await findLevelDependencies(fs, path);
    const lvl = new SrscFile(await fs.read(deps.lvl));
    const header = readLevelHeader(lvl);
    rep.title = header.title;
    for (const dep of header.dependencies) {
      if (!(await fs.resolve(`${join(dirname(path), dep.replace(/\\/g, '/'))}.db`))) rep.missingPackages.push(dep);
    }
    const packages = await loadPackages(fs, dirname(deps.lvl), header.dependencies, () => {});
    const ldu = deps.levelLdu ? new SrscFile(await fs.read(deps.levelLdu)) : undefined;
    const data = parseLevel(lvl, level, { ldu, packages });
    rep.parts = data.parts.length;
    const warn = console.warn;
    let missing: string[] = [];
    console.warn = (...a: unknown[]) => {
      if (String(a[0]).includes('texture keys not found')) missing = a[1] as string[];
    };
    const tex = decodeReferencedTextures(data, packages);
    console.warn = warn;
    rep.textureKeys = tex.length + missing.length;
    rep.missingTextures = missing;

    const ents = parseEntities(lvl, packages);
    rep.entities = ents.length;
    for (const e of ents) rep.classes[e.className] = (rep.classes[e.className] ?? 0) + 1;
    rep.unresolvedClasses = Object.entries(rep.classes)
      .filter(([n]) => !PASSIVE.has(n) && !referenced(n))
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    // Spawn validity against the static geometry.
    const world = new CollisionWorld(data);
    const probe = (what: string, e: Entity) => {
      const p: [number, number, number] = [e.position[0] / 2048, e.position[1] / 2048, e.position[2] / 2048];
      const down = world.raycast(p[0], p[1] + 0.5, p[2], 0, -1, 0, 200);
      const up = world.raycast(p[0], p[1] + 0.1, p[2], 0, 1, 0, 50);
      rep.spawns.push({ what, pos: p, drop: down ? +(down.distance - 0.5).toFixed(2) : null, headroom: up ? +(up.distance + 0.1).toFixed(2) : null });
    };
    const player = ents.find((e) => e.className === 'Player' && !(e.flags & 8));
    if (player) probe('Player', player);
    for (const e of ents.filter((x) => x.className === 'Player Spawn Point')) {
      probe(`Spawn "${e.props.spawnName ?? ''}" from ${String(e.props.fromLevel ?? '').split('\\').pop()}`, e);
    }

    // Level transitions.
    for (const e of ents.filter((x) => x.className === 'Level Transition')) {
      const target = String(e.props.targetLevel ?? '');
      const names = (Array.isArray(e.props.targetSpawnNames) ? e.props.targetSpawnNames : [e.props.targetSpawnNames]).filter((x) => typeof x === 'string') as string[];
      const resolved = target ? await fs.resolve(target.replace(/\\/g, '/')) : undefined;
      let spawnFound: boolean | null = null;
      if (resolved) {
        try {
          const tl = new SrscFile(await fs.read(resolved));
          const tp = await loadPackages(fs, dirname(resolved), readLevelHeader(tl).dependencies, () => {});
          const points = parseEntities(tl, tp).filter((x) => x.className === 'Player Spawn Point');
          const me = path.toLowerCase().split('/').pop()!;
          const fromMe = (sp: Entity) => String(sp.props.fromLevel ?? '').toLowerCase().replace(/\\/g, '/').endsWith(me);
          // No target spawn names: the target picks the point by the level arrived from.
          const want = names.length ? names : [''];
          spawnFound = want.every((n) => points.some((sp) => String(sp.props.spawnName ?? '').toLowerCase() === n.toLowerCase() && fromMe(sp)));
          if (!spawnFound) {
            const loose = want.every((n) => points.some((sp) => (n ? String(sp.props.spawnName ?? '').toLowerCase() === n.toLowerCase() : fromMe(sp))));
            spawnFound = loose ? null : false;
          }
        } catch {
          spawnFound = false;
        }
      }
      rep.transitions.push({ uid: e.uid.toString(16), target, spawnNames: names, resolves: !!resolved, spawnFound });
    }
  } catch (err) {
    rep.error = (err as Error).stack ?? String(err);
  }
  return rep;
}

// ---------------------------------------------------------------------------
// Browser pass (Chrome DevTools Protocol over the browser's own WebSocket)

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((b): b is string => !!b);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class Page {
  private id = 0;
  private pending = new Map<number, (d: { result?: { result?: { value?: unknown }; data?: string }; error?: unknown }) => void>();
  errors: string[] = [];
  warnings: string[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id && this.pending.has(d.id)) {
        this.pending.get(d.id)!(d);
        this.pending.delete(d.id);
      } else if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params.exceptionDetails;
        this.errors.push(`exception: ${ex.exception?.description ?? ex.text}`);
      } else if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map((a: { value?: unknown; description?: string }) => (typeof a.value === 'object' ? JSON.stringify(a.value) : (a.value ?? a.description))).join(' ');
        if (d.params.type === 'error') this.errors.push(text.slice(0, 400));
        else if (d.params.type === 'warning') this.warnings.push(text.slice(0, 400));
      } else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
        const e = d.params.entry;
        if (!/favicon/i.test(e.url ?? '')) this.errors.push(`log: ${e.text} ${e.url ?? ''}`);
      }
    };
  }
  /** CDP call; resolves `{ error }` after `timeoutMs` (a stalled page must not hang the run). */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
    return new Promise<{ result?: { result?: { value?: unknown }; data?: string }; error?: unknown }>((r) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.errors.push(`harness: ${method} timed out`);
        r({ error: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, (d) => {
        clearTimeout(timer);
        r(d);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value as T;
  }
  async shot(file: string) {
    const res = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    if (res.result?.data) writeFileSync(file, Buffer.from(res.result.data, 'base64'));
  }
}

async function browserPass(paths: string[]): Promise<BrowserReport[]> {
  const bin = BROWSERS.find((b) => existsSync(b));
  if (!bin) throw new Error('No Chromium-family browser found; set SMOKE_BROWSER');
  const reports: BrowserReport[] = [];
  // Own dev server without HMR or file watching: other edits in the tree must not reload the
  // page in the middle of a level (modules are transformed from disk on first request).
  let server: { close(): Promise<void> } | undefined;
  let base = urlArg;
  if (!base) {
    const port = await freePort();
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({ configFile: 'vite.config.ts', logLevel: 'silent', server: { port, strictPort: true, hmr: false, watch: null } });
    await vite.listen();
    server = vite;
    base = `http://localhost:${port}`;
    await waitFor(async () => (await fetch(base!)).ok, 30_000, 'dev server');
  }
  const profile = mkdtempSync(join(tmpdir(), 'suffering-levelqa-'));
  const debugPort = await freePort();
  const browser = spawn(
    bin,
    [
      '--headless=new', '--disable-component-update', '--disable-background-networking',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=960,540',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    const target = await waitFor(
      async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page'),
      20_000,
      'browser',
    );
    const ws = new WebSocket(target!.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');

    for (const path of paths) {
      const level = stem(path);
      const slug = level.replace(/[^a-z0-9]+/gi, '_');
      const rep: BrowserReport = { level, loaded: false, loadMs: 0, errors: [], warnings: [], shots: [] };
      let overviewFrom = Infinity;
      page.errors = [];
      page.warnings = [];
      await page.send('Page.navigate', { url: 'about:blank' });
      await sleep(300);
      const t0 = Date.now();
      await page.send('Page.navigate', { url: `${base}/?level=${encodeURIComponent(path)}` });
      try {
        await waitFor(() => page.eval<boolean>(`!!(window.__world && window.__view && window.__view.renderer.info.render.triangles > 0)`), 120_000, `${level} load`);
        rep.loaded = true;
      } catch (err) {
        rep.errors.push(String((err as Error).message));
      }
      rep.loadMs = Date.now() - t0;
      if (rep.loaded) {
        // Clean frames: dev sidebar collapsed (the stats corner stays).
        await page.eval(`document.getElementById('app')?.classList.add('collapsed')`);
        await sleep(3000);
        const startShot = join(OUT, `${slug}-start.jpg`);
        await page.shot(startShot);
        rep.shots.push(startShot);
        // Skip the intro cutscene(s), then judge the gameplay start.
        rep.cutscenes = [];
        for (let i = 0; i < 6; i++) {
          const names = await page.eval<string[]>(`(() => { const w = window.__world?.world; const a = w ? w.activeCutscenes().map((c) => c.name) : []; if (a.length) w.skipCutscenes(); return a; })()`);
          if (!names?.length) break;
          rep.cutscenes.push(...names);
          await sleep(700);
        }
        await sleep(500);
        const start = await page.eval<number[]>(`(() => { const p = __view.player.position; return [p.x, p.y, p.z]; })()`);
        rep.start = start?.map((x) => +x.toFixed(2));
        await sleep(3000);
        const stats = await page.eval<{ backend: string; fps: number; draws: number; tris: number; onGround: boolean; end: number[]; world: string }>(`(async () => {
          const v = window.__view;
          let n = 0; const t = performance.now();
          await new Promise((res) => { const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
          const fps = n / ((performance.now() - t) / 1000);
          const info = v.renderer.info.render;
          const p = v.player.position;
          const w = window.__world;
          return { backend: v.backend, fps, draws: info.drawCalls, tris: info.triangles, onGround: !!v.player.onGround, end: [p.x, p.y, p.z],
            world: w ? w.world.ents.size + ' ents, ' + w.dyn.objects.size + ' dyn' : '' };
        })()`);
        if (stats) {
          rep.backend = stats.backend;
          rep.fps = +stats.fps.toFixed(1);
          rep.drawCalls = stats.draws;
          rep.triangles = Math.round(stats.tris);
          rep.onGround = stats.onGround;
          rep.end = stats.end.map((x) => +x.toFixed(2));
          rep.fell = rep.start ? +(rep.start[1] - stats.end[1]).toFixed(2) : undefined;
          rep.world = stats.world;
        }
        const spawnShot = join(OUT, `${slug}-spawn.jpg`);
        await page.shot(spawnShot);
        rep.shots.push(spawnShot);
        // Errors after this point come from the harness's free camera, not from play.
        overviewFrom = page.errors.length;
        // Overview: fly camera above the level centre looking down at an angle (no fog).
        await page.eval(`(() => {
          const v = window.__view; const T = v.camera.position.constructor;
          v.setWalking(false);
          // Level bounds from the static collision world; zone culling off for the far view.
          const bb = v.collision?.bounds ?? { min: [-50, -10, -50], max: [50, 10, 50] };
          const min = bb.min, max = bb.max;
          if (v.culler) v.culler.enabled = false;
          const c = new T((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
          const s = Math.max(max[0] - min[0], max[2] - min[2], 1);
          window.__qaFog = v.scene.fog; v.scene.fog = null;
          v.camera.far = Math.max(v.camera.far, s * 4); v.camera.updateProjectionMatrix();
          v.controls.lookFrom(new T(c.x + s * 0.3, max[1] + s * 0.35, c.z + s * 0.3), c);
        })()`);
        await sleep(1200);
        const overShot = join(OUT, `${slug}-overview.jpg`);
        await page.shot(overShot);
        rep.shots.push(overShot);
      }
      await sleep(300);
      // Per-frame errors repeat: keep each distinct message once, with its count.
      const uniq = (list: string[]) => {
        const m = new Map<string, number>();
        for (const e of list) m.set(e, (m.get(e) ?? 0) + 1);
        return [...m].map(([e, n]) => (n > 1 ? `${e} (x${n})` : e));
      };
      rep.errors.push(...uniq(page.errors.slice(0, overviewFrom)));
      rep.overviewErrors = uniq(page.errors.slice(overviewFrom));
      rep.warnings.push(...uniq(page.warnings));
      reports.push(rep);
      console.log(
        `${rep.loaded ? 'ok  ' : 'FAIL'} ${level}: ${rep.loadMs} ms, ${rep.backend ?? '-'}, ${rep.fps ?? '-'} fps, ${rep.drawCalls ?? '-'} draws, ground ${rep.onGround}, fell ${rep.fell}, ${rep.errors.length} errors, ${rep.warnings.length} warnings`,
      );
      for (const e of rep.errors.slice(0, 6)) console.log(`     error: ${e.slice(0, 300)}`);
    }
    ws.close();
  } finally {
    browser.kill('SIGKILL');
    await server?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Report

function statusOf(s: StaticReport, b?: BrowserReport): string {
  if (s.error || (b && !b.loaded)) return 'broken';
  const badSpawn = s.spawns.some((x) => x.drop === null || x.drop > 3);
  const errs = b ? b.errors.length : 0;
  if (errs || badSpawn || s.transitions.some((t) => !t.resolves)) return 'issues';
  if (b && b.onGround === false) return 'issues';
  return 'loads';
}

function docTable(stat: StaticReport[], br: Map<string, BrowserReport>): string {
  const rows = stat.map((s) => {
    const b = br.get(s.level);
    const spawn = s.spawns[0];
    const tr = s.transitions.map((t) => `${t.target.split('\\').pop()?.replace(/\.lvl$/i, '')}${t.resolves ? (t.spawnFound === false ? ' (no spawn)' : '') : ' (MISSING)'}`).join(', ');
    const unres = s.unresolvedClasses.map((c) => `${c.name} ${c.count}`).join(', ');
    return `| ${s.level} | ${s.title} | ${statusOf(s, b)} | ${s.entities} | ${s.missingTextures.length}/${s.textureKeys} | ${spawn ? (spawn.drop === null ? 'no ground' : `${spawn.drop} m`) : '-'} | ${b ? `${b.onGround ? 'yes' : 'no'} (${b.fell ?? '-'} m)` : '-'} | ${b ? (b.errors.length ? b.errors.length : 0) : '-'} | ${b?.fps ?? '-'} / ${b?.drawCalls ?? '-'} | ${tr || '-'} | ${unres || '-'} |`;
  });
  return [
    '| Level | Title | Status | Entities | Missing tex | Spawn drop | On ground (fell) | Errors | fps / draws | Transitions | Unreferenced classes |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

async function main() {
  if (!hasData) throw new Error('No game data (set SUFFERING_DATA or extract to game/app)');
  mkdirSync(OUT, { recursive: true });
  const paths = filesWithExt('.lvl')
    .filter((p) => includeCh1 || !CH1.test(p))
    .filter((p) => !filter || filter.some((f) => p.toLowerCase().includes(f)))
    .sort(new Intl.Collator(undefined, { numeric: true }).compare);

  const quiet = console.warn;
  console.warn = () => {};
  const stat: StaticReport[] = [];
  for (const p of paths) {
    const r = await staticLevel(p);
    stat.push(r);
    const sp = r.spawns.map((s) => `${s.what}: ${s.drop === null ? 'NO GROUND' : s.drop + 'm'}`).join('; ');
    quiet(`static ${r.level} [${r.title}] ents ${r.entities}, tex missing ${r.missingTextures.length}/${r.textureKeys}, pkgs missing ${r.missingPackages.length}${r.error ? ' ERROR ' + r.error.split('\n')[0] : ''}`);
    quiet(`   spawns: ${sp}`);
    for (const t of r.transitions) quiet(`   transition ${t.uid} -> ${t.target} [${t.spawnNames.join(', ')}] resolves ${t.resolves} spawn ${t.spawnFound}`);
    quiet(`   unreferenced: ${r.unresolvedClasses.map((c) => `${c.name} ${c.count}`).join(', ')}`);
  }
  console.warn = quiet;

  const br = new Map<string, BrowserReport>();
  if (reuse) {
    const prev = JSON.parse(readFileSync(join(OUT, 'levelqa.json'), 'utf8')) as { browser: BrowserReport[] };
    for (const r of prev.browser) if (paths.some((p) => stem(p) === r.level)) br.set(r.level, r);
  } else if (!staticOnly) for (const r of await browserPass(paths)) br.set(r.level, r);

  writeFileSync(join(OUT, 'levelqa.json'), JSON.stringify({ static: stat, browser: [...br.values()] }, null, 1));
  const table = docTable(stat, br);
  console.log('\n' + table);
  console.log(`\nwrote ${join(OUT, 'levelqa.json')}`);
  if (writeDoc) {
    const doc = 'docs/levels.md';
    const begin = '<!-- levelqa:begin -->';
    const end = '<!-- levelqa:end -->';
    const block = `${begin}\n${table}\n${end}`;
    const prev = existsSync(doc) ? readFileSync(doc, 'utf8') : `# Levels\n\n${begin}\n${end}\n`;
    writeFileSync(doc, prev.includes(begin) ? prev.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block) : `${prev}\n${block}\n`);
    console.log(`updated ${doc}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
