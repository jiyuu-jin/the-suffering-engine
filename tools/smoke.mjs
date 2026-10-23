// Browser smoke test: boots the app in a headless Chromium-family browser and
// fails on any uncaught page exception or console error.
//
//   npm run smoke                       start a Vite dev server on a free port
//   npm run smoke -- --url http://localhost:5173   test an already-running server
//
// Browser: $SMOKE_BROWSER, else the first of Chrome / Brave / Edge / Chromium found.
// Needs the local game data (./game/app) for the level checks; without it only
// the boot page is checked.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : undefined;
const LEVEL = 'LEVELS/1%20PrisonDeathRow/1a%20PrisonDeathRow.lvl';

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

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.problems = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) {
        this.pending.get(d.id)(d);
        this.pending.delete(d.id);
      } else if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params.exceptionDetails;
        this.problems.push(`exception: ${ex.exception?.description ?? ex.text}`);
      } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
        this.problems.push(`console.error: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
        const e = d.params.entry;
        // Missing favicons are harmless noise.
        if (!/favicon/i.test(e.url ?? '')) this.problems.push(`log: ${e.text} ${e.url ?? ''}`);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((r) => {
      const id = ++this.id;
      this.pending.set(id, r);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  }
}

// Page-side check of the static prop batches (src/app/prop-batch.ts): every shown member is
// drawn where it is (its world matrix matches its ancestors' transforms, and a merged member's
// batch copy matches it) and once (merged: only through the batch; unmerged: only on its own).
// Returns { n, pickups, bad: [...] } or undefined before the batch is built.
const BATCH_PROBE = `(() => {
  const b = window.__world?.batch?.();
  if (!b) return undefined;
  const view = window.__view, M4 = view.camera.matrixWorld.constructor;
  const local = new M4();
  const world = (o) => {
    const chain = [];
    for (let p = o; p; p = p.parent) chain.push(p);
    const out = new M4();
    for (let i = chain.length - 1; i >= 0; i--) { const p = chain[i]; out.multiply(p.matrixAutoUpdate ? local.compose(p.position, p.quaternion, p.scale) : p.matrix); }
    return out.elements;
  };
  const diff = (a, b) => { let d = 0; for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };
  const shown = (o) => { for (let p = o; p; p = p.parent) { if (!p.visible) return false; if (p === view.scene) return true; } return false; };
  const bad = [];
  let n = 0, pickups = 0;
  for (const m of b.members) {
    const mesh = m.mesh;
    if (!shown(mesh)) continue;
    n++;
    if (/^(Ammo Box|Health Bonus Item|Item|Key|Map Pack|Flashlight|Family Picture|Map Item|Quest Item Pickup)#/.test(mesh.name)) pickups++;
    const w = world(mesh);
    // Drawn where it is: the matrices the frame pass gave it, and the batch's copy of it.
    // (A moving member's matrices are a frame behind between frames; merged ones are at rest.)
    if (m.merged && diff(w, mesh.matrixWorld.elements) > 1e-3) bad.push('stale matrix ' + mesh.name);
    else if (m.merged && diff(w, m.matrix) > 1e-3) bad.push('batched elsewhere ' + mesh.name);
    // Drawn once: merged = only through the batch, else only on its own.
    if (m.merged && mesh.layers.mask !== 0) bad.push('drawn twice ' + mesh.name);
    if (!m.merged && m.included) bad.push('in the batch while unmerged ' + mesh.name);
    if (m.included && !m.batch.mesh.visible) bad.push('batch not drawn ' + mesh.name);
  }
  return { n, pickups, bad };
})()`;

// Page-side per-frame draw probe for the culling checks: drawProbe(fn, sight) calls fn with one
// entry per character (actors, the player's sequence puppet, skinned sequence props) right
// after each frame is drawn: key, on (skinned bones of its true pose inside the view; the pose
// is composed from the bones' local transforms, since hidden meshes keep stale matrices),
// clear (with `sight`: of those, bones with a clear sight line from the camera, looking past
// see-through surfaces), shown (not hidden by level logic: root, dormancy) and drawn (its mesh
// rendered with the view camera).
const DRAW_PROBE = `
  const drawProbe = (fn, sight) => {
    const view = window.__view, mgr = window.__actors.manager, cam = view.camera;
    const M4 = cam.matrixWorld.constructor, V3 = cam.position.constructor;
    const pv = new M4(), p = new V3(), drawn = new Map(), skinned = new WeakMap();
    let cache = new Map(), list = [];
    const worldOf = (o) => {
      let m = cache.get(o);
      if (m) return m;
      m = o.matrixAutoUpdate ? new M4().compose(o.position, o.quaternion, o.scale) : o.matrix.clone();
      if (o.parent) m.premultiply(worldOf(o.parent));
      cache.set(o, m);
      return m;
    };
    const weighted = (mesh, n) => {
      let w = skinned.get(mesh.geometry);
      if (w) return w;
      w = new Uint8Array(n);
      const si = mesh.geometry.getAttribute('skinIndex'), sw = mesh.geometry.getAttribute('skinWeight');
      for (let i = 0; si && i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.1) w[si.getComponent(i, k)] = 1;
      skinned.set(mesh.geometry, w);
      return w;
    };
    const blocked = (tx, ty, tz) => {
      const o = cam.position;
      let dx = tx - o.x, dy = ty - o.y, dz = tz - o.z;
      const len = Math.hypot(dx, dy, dz);
      dx /= len; dy /= len; dz /= len;
      for (let i = 0, start = 0; i < 32; i++) {
        const hit = mgr.world.raycast(o.x + dx * start, o.y + dy * start, o.z + dz * start, dx, dy, dz, len - start);
        if (!hit || start + hit.distance >= len - 0.05) return false;
        if (!mgr.seeThrough?.(hit)) return true;
        start += hit.distance + 1e-3;
      }
      return false;
    };
    const chars = () => {
      const out = [];
      for (const a of mgr.actors) if (!a.template) out.push({ key: (a.uid ?? a.id).toString(16), a, root: a.ch.root, mesh: a.ch.mesh });
      const pup = window.__stomp.puppet;
      if (pup) out.push({ key: 'puppet', root: pup.root, mesh: pup.mesh });
      for (const o of view.scene.children) if (o.name?.startsWith('stomp-prop:')) { const m = o.children.find((c) => c.isSkinnedMesh); if (m) out.push({ key: o.name, root: o, mesh: m }); }
      return out;
    };
    const shown = (c) => { for (let o = c.root; o; o = o.parent) if (!o.visible) return false; return !c.a?.dormantHidden; };
    const draw = view.draw.bind(view);
    view.draw = function () {
      cache = new Map();
      cam.updateMatrixWorld();
      pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      list = [];
      for (const c of chars()) {
        const bones = c.mesh.skeleton?.bones ?? [];
        const w = weighted(c.mesh, bones.length);
        let on = 0, clear = 0;
        for (let i = 1; i < bones.length; i++) {
          if (!w[i]) continue;
          const bw = worldOf(bones[i]);
          // In front of the camera, then inside the picture.
          if (p.setFromMatrixPosition(bw).applyMatrix4(cam.matrixWorldInverse).z > -cam.near) continue;
          p.setFromMatrixPosition(bw).applyMatrix4(pv);
          if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
          on++;
          if (sight) { p.setFromMatrixPosition(bw); if (!blocked(p.x, p.y, p.z)) clear++; }
        }
        if (!on) continue;
        if (!drawn.has(c.mesh)) {
          const before = c.mesh.onBeforeRender;
          c.mesh.onBeforeRender = function (r, s, camera, ...rest) { if (camera === cam) drawn.set(c.mesh, 1); return before.call(this, r, s, camera, ...rest); };
        }
        drawn.set(c.mesh, 0);
        list.push({ c, on, clear });
      }
      draw();
      const run = window.__stomp.runs.find((r) => r.seq.id === 284);
      const f = list.map(({ c, on, clear }) => ({ key: c.key, on, clear, shown: shown(c), drawn: drawn.get(c.mesh) === 1 }));
      f.t = run ? run.t : -1;
      fn(f);
    };
  };`;

async function main() {
  const bin = BROWSERS.find((b) => existsSync(b));
  if (!bin) throw new Error('No Chromium-family browser found; set SMOKE_BROWSER');

  let server;
  let base = urlArg;
  if (!base) {
    const port = await freePort();
    server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
    base = `http://localhost:${port}`;
    await waitFor(async () => (await fetch(base)).ok, 30_000, 'dev server');
  }
  const hasData = await fetch(`${base}/game-index`, { method: 'HEAD' })
    .then((r) => r.ok)
    .catch(() => false);

  const profile = mkdtempSync(join(tmpdir(), 'suffering-smoke-'));
  const debugPort = await freePort();
  const browser = spawn(
    bin,
    [
      '--headless=new', '--disable-component-update', '--disable-background-networking',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const failures = [];
  try {
    const target = await waitFor(
      async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'),
      20_000,
      'browser',
    );
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');

    const check = async (name, path, waitMs, assertJs) => {
      // SMOKE_ONLY=<text>: run only the checks whose name contains it.
      if (process.env.SMOKE_ONLY && !name.includes(process.env.SMOKE_ONLY)) return;
      page.problems = [];
      await page.send('Page.navigate', { url: base + path });
      let ok = true;
      let detail = '';
      try {
        await waitFor(() => page.eval(assertJs), waitMs, name);
      } catch (err) {
        ok = false;
        detail = err.message;
      }
      // Let late errors surface.
      await sleep(1500);
      if (page.problems.length) {
        ok = false;
        detail += (detail ? '; ' : '') + page.problems.slice(0, 5).join(' | ');
      }
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failures.push(name);
    };

    // The app must get as far as creating its renderer canvas.
    await check('boot page renders', '/', 20_000, `!!document.querySelector('canvas')`);
    if (hasData) {
      await check(
        'level 1a loads and renders',
        `/?skipintro&level=${LEVEL}`,
        60_000,
        `(() => { const v = window.__view; return !!v && v.renderer.info.render.triangles > 10000; })()`,
      );
      // Graphics Mode (docs/enhanced.md): the default page is the faithful Original renderer:
      // no Enhanced module loaded, the engine's 8-bit gamma back buffer (LinearToneMapping: a saturate).
      await check(
        'Original graphics mode by default (no Enhanced pipeline)',
        `/?skipintro&level=${LEVEL}`,
        60_000,
        `(() => { const v = window.__view; if (!v || !(v.renderer.info.render.triangles > 10000)) return false; return !window.__enhanced && v.enhanced === null && v.renderer.toneMapping === 1 && window.__lighting && !window.__lighting.legacy; })()`,
      );
      // Enhanced mode boots, renders through its pipeline and logs no errors (?gfx= override).
      await check(
        'Enhanced graphics mode renders (gfx=enhanced&tier=low)',
        `/?skipintro&gfx=enhanced&tier=low&level=${LEVEL}`,
        90_000,
        `(() => { const v = window.__view; return !!v && !!window.__enhanced && v.enhanced?.tier === 'low' && v.renderer.info.render.triangles > 10000; })()`,
      );
      // Enhanced Ultra with the texture cache's maps (when built): every pipeline of the level is
      // compiled at load and none may fail. A shader over WebGPU's 16 sampled textures per stage
      // (layered surfaces + generated maps + shadow maps) failed to build: three.js logs it, and
      // any WebGPU validation error, as an error, which fails the check.
      await check(
        'Enhanced Ultra: every pipeline builds, no WebGPU errors (gfx=enhanced&tier=ultra)',
        `/?skipintro&gfx=enhanced&tier=ultra&level=${LEVEL}`,
        120_000,
        `(() => {
          const v = window.__view;
          if (!v || v.enhanced?.tier !== 'ultra' || !(v.renderer.info.render.triangles > 10000) || !v.precompiles.length) return false;
          const st = (window.__smokeUltra ??= { at: performance.now() });
          return performance.now() - st.at > 3000;
        })()`,
      );
      // Levels outside chapter 1 render too, with the scene glow on and in Enhanced mode
      // (1c6b915 shipped chapter 5 throwing from the renderer on every frame: a cloned
      // material's glow mark came back a plain object). Two seconds of frames after the first
      // one, any exception fails the check (above); something must still be drawn.
      for (const [name, path] of [
        ['5a', 'LEVELS/5%20Asylum/5a%20Asylum.lvl'],
        ['3a', 'LEVELS/3%20YardCellBlock/3a%20YardCellBlock.lvl'],
        ['5a enhanced', 'LEVELS/5%20Asylum/5a%20Asylum.lvl&gfx=enhanced&tier=low'],
      ]) {
        await check(
          `level ${name} loads and renders`,
          `/?skipintro&level=${path}`,
          90_000,
          `(() => {
            const v = window.__view, info = v?.renderer.info.render;
            if (!v || !(info.triangles > 10000)) return false;
            const st = (window.__smokeLevel ??= { at: performance.now() });
            return performance.now() - st.at > 2000 && info.drawCalls > 0 && info.triangles > 10000;
          })()`,
        );
      }
      await check(
        'player spawns on the ground',
        `/?skipintro&level=${LEVEL}`,
        60_000,
        `(() => { const p = window.__player; return !!p && window.__view?.walking && p.onGround; })()`,
      );
      // Static batching (docs/game-logic.md §18.6): every pickup and other batched prop drawn
      // where it lies, exactly once (1a and 1b; batching once copied every pickup to the level
      // origin, so none showed).
      for (const lv of ['1a', '1b']) {
        await check(
          `batched props drawn in place, once: ${lv}`,
          `/?skipintro&level=LEVELS/1%20PrisonDeathRow/${lv}%20PrisonDeathRow.lvl`,
          90_000,
          `(() => {
            if (!window.__world?.batch?.()) return false;
            const st = (window.__smokeBatch ??= { at: performance.now() });
            if (performance.now() - st.at < 3000) return false;
            const r = ${BATCH_PROBE};
            if (!r) return false;
            if (r.bad.length && !st.reported) console.error(r.bad.length + ' of ' + r.n + ' batched props wrong: ' + r.bad.slice(0, 6).join(', '));
            st.reported = true;
            return r.n > 500 && r.pickups > 50;
          })()`,
        );
      }
      // Draw-culling regression (docs/game-logic.md §15.5 "Actor draw culling"): every
      // character on screen is drawn. Cinematic: the whole opening sequence of 1a ("Goose",
      // .qdu 12:284, 216 s at 3x speed), every frame; a character counts as on screen when a
      // skinned bone of its true pose projects into the view, as drawn when its mesh is
      // rendered with the view camera that frame; only level logic (hidden root, dormant
      // creature) may hide it. Gameplay: the player is put at points of the death row and
      // turned round; a character with a clear sight line to at least 3 of its on-screen bones
      // (and a quarter of them) must be drawn.
      await check(
        'characters on screen stay drawn: every frame of the 1a "Goose" cinematic',
        `/?skipintro&level=${LEVEL}`,
        240_000,
        `(() => {
          ${DRAW_PROBE}
          const st = window.__smokeCine ??= (() => {
            if (!window.__view || !window.__actors || !window.__stomp?.runs.some((r) => r.seq.id === 284)) return undefined;
            const s = { frames: 0, drops: [], seen: new Set(), done: false };
            const v = window.__view;
            Object.defineProperty(v, 'timeScale', { get: () => (s.done ? 1 : 3), set() {}, configurable: true });
            drawProbe((f) => {
              if (s.done) return;
              if (!window.__stomp.runs.some((r) => r.seq.id === 284)) return void (s.done = s.frames > 0);
              // Frames drawn with the sequence camera (posed by the sequence system).
              const m = window.__actors.manager;
              if (!(m.frame - m.cinematicFrame <= 1)) return;
              s.frames++;
              for (const c of f) {
                if (c.on) s.seen.add(c.key);
                if (c.on && c.shown && !c.drawn) s.drops.push(c.key + '@' + f.t.toFixed(2));
              }
            });
            return s;
          })();
          if (!st?.done) return false;
          if (st.drops.length && !st.reported) console.error('characters on screen not drawn on ' + st.drops.length + ' of ' + st.frames + ' frames: ' + st.drops.slice(0, 8).join(' '));
          st.reported = true;
          return st.frames > 1000 && st.seen.size >= 8;
        })()`,
      );
      await check(
        'characters on screen stay drawn: 1a gameplay sweep',
        `/?skipintro&level=${LEVEL}`,
        180_000,
        `(() => {
          ${DRAW_PROBE}
          const st = window.__smokeGame ??= (() => {
            if (!window.__view || !window.__actors || !window.__world || !window.__stomp?.runs.some((r) => r.seq.id === 284)) return undefined;
            window.__world.world.skipCutscenes();
            const pts = [[399, 97.7, 507.5], [393, 97.7, 504.4], [404, 97.7, 508], [400, 97.7, 514], [432.4, 97.7, 538], [426.3, 97.7, 537.9]];
            const s = { frames: 0, drops: [], run: new Map(), seen: new Set(), i: -1, t: 0, done: false };
            const v = window.__view, pl = window.__player;
            v.onFrame((dt) => {
              if (s.done || window.__stomp.cinematic || !v.walking) return;
              s.t -= dt;
              if (s.t <= 0) {
                if (++s.i >= pts.length) return void (s.done = true);
                const [x, y, z] = pts[s.i];
                pl.teleport({ x, y, z }, 0, 0);
                s.t = 3;
              }
              pl.yaw += dt * 2.1;
              pl.pitch = Math.sin(pl.yaw * 2) * 0.25;
            });
            drawProbe((f) => {
              if (s.done || s.i < 0 || window.__stomp.cinematic) return;
              s.frames++;
              for (const c of f) {
                const seen = c.on && c.shown && c.clear >= 3 && c.clear * 4 >= c.on;
                if (seen) s.seen.add(c.key);
                const n = seen && !c.drawn ? (s.run.get(c.key) ?? 0) + 1 : 0;
                s.run.set(c.key, n);
                if (n === 1) s.drops.push((s.cur ??= new Map()).set(c.key, { at: c.key + '@' + s.i + ':' + (3 - s.t).toFixed(2), clear: c.clear + '/' + c.on, n: 1 }).get(c.key));
                else if (n > 1) s.cur.get(c.key).n = n;
              }
            }, true);
            return s;
          })();
          if (!st?.done) return false;
          if (st.drops.length && !st.reported) console.error('characters in sight not drawn ' + st.drops.length + ' times in ' + st.frames + ' frames: ' + st.drops.slice(0, 8).map((d) => d.at + ' (' + d.n + ' frames, ' + d.clear + ' bones clear)').join(' '));
          st.reported = true;
          return st.frames > 300 && st.seen.size >= 3;
        })()`,
      );
    } else {
      console.log('skip level checks — dev server has no game data');
    }
    ws.close();
  } finally {
    browser.kill('SIGKILL');
    server?.kill('SIGTERM');
    // The browser may still be releasing profile files right after it's killed.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  if (failures.length) {
    console.error(`\n${failures.length} smoke check(s) failed`);
    process.exit(1);
  }
  console.log('\nall smoke checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
