// Gamepad end-to-end test: boots the app in a headless Chromium-family browser with a fake
// gamepad (navigator.getGamepads is replaced in the page before any script runs) and plays the
// front end and the first level with it only:
//
//   gate -> logo movie skipped with A -> main menu (cursor hidden) -> Options -> Controller page
//   and keyboard page (screenshots) -> back -> New Game -> difficulty -> level 1a ->
//   skip a running cinematic with Start -> move (walk vs run) -> look -> fire a revolver
//   (rumble from the fire sound's curve) -> Use -> pause with Start -> resume -> pad
//   disconnect pauses with the console notice -> reconnect -> resume.
//
//   node tools/gamepad-e2e.mjs [--url http://localhost:5173] [--shots <dir>] [--profile <dir>]
//        [--family xbox|playstation]
//
// Browser: $SMOKE_BROWSER, else Brave / Chrome / Edge / Chromium. Needs the local game data
// (./game/app, served by the dev server); nothing of it is written anywhere. The browser profile
// (--profile, default a temp dir) is deleted afterwards.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const urlArg = opt('--url');
const shotsDir = opt('--shots');
const profileArg = opt('--profile');
const family = opt('--family', 'xbox');
const PAD_IDS = {
  xbox: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  playstation: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
};

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
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

/** Runs before any page script: a scriptable standard-mapping pad with a logging actuator. */
const FAKE_PAD = (id) => `(() => {
  const st = { connected: true, id: ${JSON.stringify(id)}, mapping: 'standard', buttons: new Array(17).fill(0), axes: [0, 0, 0, 0], ts: 0 };
  const log = [];
  const act = {
    type: 'dual-rumble',
    effects: ['dual-rumble'],
    playEffect(type, p) { log.push({ type, ...p, t: performance.now() }); return Promise.resolve('complete'); },
    reset() { log.push({ reset: true, t: performance.now() }); return Promise.resolve('complete'); },
  };
  const snap = () => ({ id: st.id, index: 0, connected: true, mapping: st.mapping, timestamp: ++st.ts,
    buttons: st.buttons.map((v) => ({ value: v, pressed: v > 0.5, touched: v > 0 })), axes: [...st.axes],
    vibrationActuator: act, hapticActuators: [] });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value() { return st.connected ? [snap(), null, null, null] : [null, null, null, null]; } });
  window.__fakePad = st;
  window.__rumbleLog = log;
  window.__seen = [];
  for (const t of ['keydown', 'mousedown']) window.addEventListener(t, (e) => window.__seen.push(e.code || 'Mouse' + e.button), true);
})();`;

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
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'eval failed');
    return res.result?.result?.value;
  }
}

async function main() {
  const bin = BROWSERS.find((b) => existsSync(b));
  if (!bin) throw new Error('No Chromium-family browser found; set SMOKE_BROWSER');
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });

  let server;
  let base = urlArg;
  const profile = profileArg ?? mkdtempSync(join(tmpdir(), 'suffering-pad-'));
  mkdirSync(profile, { recursive: true });
  let browser;
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  try {
    if (!base) {
      const port = await freePort();
      server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
      base = `http://localhost:${port}`;
      await waitFor(async () => (await fetch(base)).ok, 30_000, 'dev server');
    }
    const debugPort = await freePort();
    browser = spawn(
      bin,
      [
        '--headless=new', '--disable-component-update', '--disable-background-networking',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        '--enable-unsafe-webgpu',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,720',
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 20_000, 'browser');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_PAD(PAD_IDS[family] ?? PAD_IDS.xbox) });

    const shot = async (name) => {
      if (!shotsDir) return;
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      if (r.result?.data) writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    };
    const press = async (i, ms = 140) => {
      await page.eval(`__fakePad.buttons[${i}] = 1`);
      await sleep(ms);
      await page.eval(`__fakePad.buttons[${i}] = 0`);
      await sleep(260);
    };
    const axes = (a) => page.eval(`__fakePad.axes = ${JSON.stringify(a)}`);
    const top = () => page.eval(`(() => { const s = __menu.frontend.stack; const t = s[s.length - 1]; return t ? { id: t.screen.id, sel: t.sel } : null; })()`);
    /** Moves the focus with the d-pad to the item whose action matches, then presses A. */
    const choose = async (match) => {
      const idx = await page.eval(`(() => { const s = __menu.frontend.stack; const t = s[s.length - 1]; return t.screen.items.findIndex((it) => ${match}); })()`);
      if (idx < 0) throw new Error(`no item matching ${match}`);
      for (let n = 0; n < 20 && (await top()).sel !== idx; n++) await press(13, 90);
      await press(0);
    };

    // --- Boot: gate, logo movie, copyright, main menu (pad only) --------------------------
    await page.send('Page.navigate', { url: `${base}/` });
    await waitFor(() => page.eval(`window.__menu?.frontend.currentMode === 'gate' && __menu.frontend.gateReady`), 60_000, 'start gate');
    await press(0);
    // Logo movie (if converted media exists): A skips it.
    const movie = await waitFor(() => page.eval(`(() => { const m = document.querySelector('video'); const fe = __menu.frontend.currentMode; return (m && !m.paused && m.currentTime > 0.2) ? 'movie' : fe === 'copyright' || fe === 'menu' ? fe : ''; })()`), 30_000, 'logo movie or copyright');
    if (movie === 'movie') {
      await sleep(700);
      await press(0);
      const after = await waitFor(() => page.eval(`['copyright', 'menu'].includes(__menu.frontend.currentMode) ? __menu.frontend.currentMode : ''`), 10_000, 'movie skipped');
      check('logo movie skipped with A', !!after);
    } else check('logo movie skipped with A', true, 'no movie playing (media not converted?)');
    if ((await page.eval(`__menu.frontend.currentMode`)) === 'copyright') {
      await sleep(1200);
      await press(0);
    }
    await waitFor(() => page.eval(`__menu.frontend.currentMode === 'menu' && __menu.frontend.screenId === __menu.model.mainScreen`), 20_000, 'main menu');
    check('pad device detected, cursor hidden', await page.eval(`__pads.usingPad && document.documentElement.classList.contains('pad-active') && getComputedStyle(document.querySelector('.fe-canvas')).cursor === 'none'`));
    await shot('01-main-menu');

    // --- Options -> Controller page, keyboard page ------------------------------------------
    await choose(`it.action?.kind === 'push' && it.action.screen.startsWith('options')`);
    await waitFor(async () => (await top()).id.startsWith('options'), 5000, 'options');
    await choose(`it.action?.kind === 'push' && it.action.screen === 'page.controller'`);
    await waitFor(async () => (await top()).id === 'page.controller', 5000, 'controller page');
    // Change the layout row (right on "Controller Setting") and cancel: restored.
    const layoutRow = await page.eval(`__menu.frontend.stack.at(-1).screen.items.findIndex((it) => it.setting === 'x.padLayout')`);
    for (let n = 0; n < 20 && (await top()).sel !== layoutRow; n++) await press(13, 90);
    await press(15);
    const changed = await page.eval(`__menu.settings.extra.padLayout === 1 && __pads && window.__menu && true`);
    await shot('02-controller-page');
    await press(1); // B: cancel the page
    const restored = await page.eval(`__menu.settings.extra.padLayout === 0`);
    check('controller page: layout row edits live, B cancels', changed && restored);
    await choose(`it.action?.kind === 'push' && it.action.screen === 'page.keyboard'`);
    await waitFor(async () => (await top()).id === 'page.keyboard', 5000, 'keyboard page');
    await press(15);
    await press(15); // to the pad column
    await shot('03-keyboard-page');
    await press(1); // cancel keyboard page
    await press(1); // back from options
    await waitFor(async () => (await top()).id === (await page.eval('__menu.model.mainScreen')), 5000, 'main menu again');
    check('menus navigated with the pad', true);

    // --- New Game ------------------------------------------------------------------------------
    await choose(`it.action?.kind === 'push' && it.action.screen === 'difficulty'`);
    // A transition clip may play first (items hidden): A skips it.
    await sleep(600);
    if (await page.eval(`__menu.frontend.itemsHidden`)) await press(0);
    await waitFor(async () => (await top())?.id === 'difficulty', 15_000, 'difficulty');
    await sleep(700);
    await press(0);
    await sleep(800);
    if (await page.eval(`__menu.frontend.itemsHidden`)) await press(0);
    await waitFor(() => page.eval(`__menu.inGame && !__menu.frontend.visible && window.__view?.walking`), 120_000, 'level loaded');
    check('New Game started from the pad', true);
    await sleep(1500);

    // Cinematic at the start: Start skips it (and does not pause).
    const cine = await page.eval(`!!window.__stomp?.cinematic`);
    if (cine) {
      await press(9);
      await waitFor(() => page.eval(`!window.__stomp?.cinematic`), 8000, 'cinematic skipped');
      check('Start skips the running cinematic (no pause)', !(await page.eval(`__menu.isPaused`)));
    } else check('Start skips the running cinematic (no pause)', true, 'no cinematic running at the start');
    await waitFor(() => page.eval(`__player.enabled`), 30_000, 'player control');
    await sleep(500);
    await shot('04-in-game');

    // --- Move: half stick walks, full stick runs ------------------------------------------------
    const pose = () => page.eval(`({ x: __player.position.x, z: __player.position.z, yaw: __player.yaw, pitch: __player.pitch })`);
    const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
    console.log('     pose after load', JSON.stringify(await pose()));
    // Face the longest free direction (the level starts in a cell), level the view.
    await page.eval(`(() => { const p = __player.position; let best = 0, yaw = __player.yaw; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; const dx = -Math.sin(a), dz = -Math.cos(a); const h = __view.collision?.raycast(p.x, p.y + 1, p.z, dx, 0, dz, 40); const d = h ? h.distance : 40; if (d > best) { best = d; yaw = a; } } __player.yaw = yaw; __player.pitch = 0; return best; })()`);
    // Peak speed of each phase from the player's own frames.
    await page.eval(`window.__speed = 0; __player.onUpdate((f) => { window.__speed = Math.max(window.__speed, f.speed); })`);
    const phase = async (stick, ms) => {
      await page.eval(`window.__speed = 0`);
      await axes([0, stick, 0, 0]);
      await sleep(ms);
      await axes([0, 0, 0, 0]);
      const v = await page.eval(`window.__speed`);
      await sleep(500);
      return v;
    };
    const p0 = await pose();
    const walkSpeed = await phase(-0.5, 500);
    await page.eval(`__player.yaw += Math.PI`); // back the other way
    const runSpeed = await phase(-1, 500);
    const p1 = await pose();
    check('left stick moves (analog walk < run)', walkSpeed > 0.3 && runSpeed > walkSpeed + 0.5, `walk peak ${fmt(walkSpeed)} m/s, run peak ${fmt(runSpeed)} m/s, pose ${JSON.stringify(p1)}`);
    void p0;

    // --- Look: the original's rates (docs/re/player.md §12): 220 deg/s turn, 84 deg/s pitch at
    // full deflection and sensitivity 1, linear past the dead zone, no turn boost ---------------
    // Measured over page time (performance.now) so the CDP round trips don't count.
    const rate = (axes, ms) => page.eval(`(async () => { __player.pitch = 0; const y0 = __player.yaw, p0 = __player.pitch, t0 = performance.now(); __fakePad.axes = ${JSON.stringify(axes)}; await new Promise((r) => setTimeout(r, ${ms})); __fakePad.axes = [0, 0, 0, 0]; const dt = (performance.now() - t0) / 1000; return { yaw: (__player.yaw - y0) * 180 / Math.PI / dt, pitch: (__player.pitch - p0) * 180 / Math.PI / dt }; })()`);
    const yawFull = await rate([0, 0, 1, 0], 1200);
    const yawHalf = await rate([0, 0, 0.55, 0], 800);
    const pitchUp = await rate([0, 0, 0, -1], 400);
    const near = (v, want, tol) => Math.abs(v - want) <= tol;
    check('right stick turns at 220 deg/s (no boost when held)', near(yawFull.yaw, -220, 22), `${fmt(yawFull.yaw)} deg/s`);
    check('half stick is linear past the dead zone', near(yawHalf.yaw, -220 * 0.5, 22), `${fmt(yawHalf.yaw)} deg/s (want ${fmt(-220 * 0.5)})`);
    check('right stick pitches at 84 deg/s', near(pitchUp.pitch, 84, 10), `${fmt(pitchUp.pitch)} deg/s`);
    // The Gameplay page's Turn / Pitch sensitivity and Invert Pitch apply to the pad (the fields
    // applySettings sets on the PlayerController: tests/controls.test.ts).
    await page.eval(`(() => { __player.turnScale = 2; __player.pitchScale = 0.5; __player.invertY = true; })()`);
    const yawSens = await rate([0, 0, 1, 0], 600);
    const pitchInv = await rate([0, 0, 0, -1], 400);
    check('Turn sensitivity 2 doubles the pad turn', near(yawSens.yaw, -440, 44), `${fmt(yawSens.yaw)} deg/s`);
    check('Pitch sensitivity 0.5 + Invert Pitch apply to the pad', near(pitchInv.pitch, -42, 8), `${fmt(pitchInv.pitch)} deg/s`);
    await page.eval(`(() => { __player.turnScale = 1; __player.pitchScale = 1; __player.invertY = false; })()`);
    await page.eval(`__player.pitch = 0`);

    // --- Fire (revolver) + rumble ---------------------------------------------------------------
    const gave = await page.eval(`(() => { const s = window.__weapons?.service; if (!s?.give) return false; s.give('4:5'); s.give('4:230', 24); s.equip?.('4:5'); return true; })()`);
    await sleep(1500);
    const clip = `(window.__weapons?.service?.weapons?.find((w) => w.id === '4:5')?.clip ?? -1)`;
    const shots0 = await page.eval(clip);
    await page.eval(`__rumbleLog.length = 0`);
    await page.eval(`__fakePad.buttons[7] = 0.9`); // analog right trigger past the threshold
    await sleep(160);
    await page.eval(`__fakePad.buttons[7] = 0`);
    await sleep(900);
    const shots1 = await page.eval(clip);
    check('RT fires the revolver', gave && shots1 === shots0 - 1, `clip ${shots0} -> ${shots1}`);
    const rumble = await page.eval(`__rumbleLog.filter((e) => e.type === 'dual-rumble' && (e.strongMagnitude > 0 || e.weakMagnitude > 0)).length`);
    check('fire sound rumble curve reaches the actuator', rumble > 0, `${rumble} dual-rumble effects`);

    // --- Use (X -> the Use action's canonical key) ------------------------------------------------
    await page.eval(`__seen.length = 0`);
    await press(2);
    check('X triggers Use', await page.eval(`__seen.includes('KeyE')`));
    await press(0);
    check('A jumps (Space)', await page.eval(`__seen.includes('Space')`));
    await shot('05-after-fire');

    // --- Health (D-pad down): drinks a Xombium bottle (docs/re/player.md §8.1) -----------------
    const heal = await page.eval(`(async () => { const ws = __weapons.service, c = __actors.combat; const tpl = { pkg: 4, id: 207 }; ws.storeHealthPack('Xombium Bottle', tpl, 20); const n0 = ws.healthPacks; c.damage(40); const h0 = c.health; return { n0, h0 }; })()`);
    await press(13);
    await sleep(200);
    const healed = await page.eval(`({ n: __weapons.service.healthPacks, h: __actors.combat.health })`);
    check('D-pad down drinks a Xombium bottle', healed.n === heal.n0 - 1 && healed.h > heal.h0, `bottles ${heal.n0} -> ${healed.n}, health ${fmt(heal.h0)} -> ${fmt(healed.h)}`);

    // --- Pause / resume -------------------------------------------------------------------------------
    await press(9);
    await waitFor(() => page.eval(`__menu.isPaused && __menu.frontend.screenId === __menu.model.pauseScreen`), 5000, 'pause menu');
    await shot('06-pause');
    await sleep(300);
    await press(9); // Start on the pause root resumes
    await waitFor(() => page.eval(`!__menu.isPaused && !__menu.frontend.visible`), 5000, 'resumed');
    check('Start pauses and resumes', true);

    // --- Disconnect / reconnect ---------------------------------------------------------------------
    await page.eval(`__fakePad.connected = false`);
    await waitFor(() => page.eval(`__menu.isPaused`), 5000, 'pause on disconnect');
    const toast = await page.eval(`document.getElementById('toast')?.textContent ?? ''`);
    check('disconnect during play pauses with the controller notice', /removed/i.test(toast), toast.slice(0, 80));
    await shot('07-disconnected');
    await page.eval(`__fakePad.connected = true`);
    await sleep(400);
    await press(0); // A on Resume (default focus)
    await waitFor(() => page.eval(`!__menu.isPaused`), 5000, 'resume after reconnect');
    check('reconnect + A resumes', true);

    // --- HUD glyphs: interaction prompt, help text, death prompt (forced for the screenshot) -----
    // The world rewrites the prompt every frame: pin it for the screenshot.
    await page.eval(`(() => { Object.defineProperty(__hud.bus, 'prompt', { configurable: true, get: () => '<b>E</b> Open', set: () => {} }); __hud.services.hud.help('Test hint: <Use> and <Insanity> placeholders.'); })()`);
    await sleep(600);
    await shot('08-hud-prompt-help');
    const helpText = await page.eval(`(() => { const m = __input.labelMap(); return m.Use + '|' + m.Insanity; })()`);
    check('help placeholders use pad names', /^(X|Square)\|(LB|L1)$/.test(helpText), helpText);
    await page.eval(`(() => { delete __hud.bus.prompt; __hud.bus.prompt = null; __hud.services.hud.help(null); __hud.bus.dead = true; })()`);
    await sleep(2200);
    await shot('09-death-prompt');
    await page.eval(`__hud.bus.dead = false`);
    await sleep(300);

    // --- Unmapped pad: the DualShock 4 raw HID layout goes through the remap table -----------------
    await page.eval(`(() => { const p = __fakePad; p.id = '054c-09cc-Wireless Controller'; p.mapping = ''; p.buttons = new Array(14).fill(0); p.axes = [0, 0, 0, -1, -1, 0, 0, 0, 0, 3.2857]; })()`);
    await sleep(300);
    await page.eval(`__fakePad.buttons[1] = 1; __fakePad.axes[9] = -1`); // raw Cross + hat up
    await sleep(100);
    const remap = await page.eval(`(() => { const s = __pads.poll(true); return s ? { src: s.source, fam: s.family, a: s.pressed[0], up: s.pressed[12], sq: s.pressed[2] } : null; })()`);
    await page.eval(`__fakePad.buttons[1] = 0; __fakePad.axes[9] = 3.2857`);
    check('non-standard DualShock 4 (raw HID) remapped', !!remap && remap.src === 'remap' && remap.fam === 'playstation' && remap.a && remap.up && !remap.sq, JSON.stringify(remap));

    const problems = page.problems.filter((p) => !/WebGPU|favicon/i.test(p));
    check('no page exceptions', problems.length === 0, problems.slice(0, 3).join(' | '));
    ws.close();
  } catch (err) {
    check('run', false, err.message);
  } finally {
    browser?.kill('SIGKILL');
    server?.kill('SIGTERM');
    await sleep(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gamepad checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
