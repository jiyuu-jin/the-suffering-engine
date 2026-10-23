// Enhanced graphics mode comparison set (docs/enhanced.md "Image checks"): Original against
// Enhanced at fixed camera poses, with an automatic exposure check per pose and frame-rate samples.
//
//   npx tsx tools/enhanced-compare.ts [--url http://localhost:5173] [--cdp <port>] [--tmp <dir>]
//        [--out <dir>] [--levels 1a,3a,6a] [--poses cell,gas] [--tiers medium,high,ultra]
//        [--fps <seconds>] [--settle <seconds>] [--no-fail]
//
// Without --url it starts its own dev server (no file watching), without --cdp its own headless
// browser (Brave / Chrome; throw-away profile, caches off, deleted at exit). Each level is loaded
// once in Original (`?fly`) and once in Enhanced (`&gfx=enhanced`, tiers switched live); the
// flashlight is given and its battery refilled before every frame (a drained battery dimmed the
// later tiers of the first evidence strips). Per pose and mode it writes <out>/<level>-<pose>-
// <mode>.png and the metrics to <out>/metrics.json; it prints a table and exits 1 when a check
// fails (tools/image-metrics.ts LIMITS) unless --no-fail. The frames are made from the game's
// data: keep them outside the repository.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFrame, decodePng, frameMetrics, type FrameMetrics, type PoseCheck } from './image-metrics';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k: string, d?: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const TMP = opt('--tmp', tmpdir())!;
const OUT = opt('--out', join(TMP, 'enhanced-compare'))!;
const TIERS = opt('--tiers', 'medium,high,ultra')!.split(',');
const FPS_SECS = Number(opt('--fps', '0'));
const SETTLE = Number(opt('--settle', '3'));

/** Evidence poses (docs/enhanced.md): position, yaw / pitch in degrees, flashlight on. */
interface Pose {
  name: string;
  at: [number, number, number];
  yaw: number;
  pitch: number;
  flash: boolean;
  what: string;
  /** Camera 0.8 m in front of the player model's head (external view) instead of `at`. */
  face?: boolean;
}
const POSES: Record<string, Pose[]> = {
  '1a': [
    { name: 'cell-row', at: [395, 99.3, 504.4], yaw: 270, pitch: 0, flash: true, what: 'death row cell block, corridor lamp, cell bars' },
    { name: 'lamp-white', at: [401, 99.3, 504.4], yaw: 270, pitch: 12, flash: false, what: 'bright white: the lamp shade and the wall under the corridor lamp' },
    { name: 'guard', at: [434, 99.3, 520], yaw: 27, pitch: 2, flash: true, what: 'guard post hall, red alarm' },
    { name: 'gas-wall', at: [418.7, 90.3, 450.2], yaw: 0, pitch: -5, flash: true, what: 'bright white: pale tiled wall in the flashlight (before the gas chamber scene: the chamber then moves into this spot)' },
    { name: 'gas', at: [417, 90.3, 447], yaw: 270, pitch: -5, flash: true, what: 'gas chamber room (the window, until its scene has played)' },
    { name: 'electro', at: [431, 90.3, 528.5], yaw: 115, pitch: -8, flash: true, what: 'electrocution controls' },
    { name: 'cell-dark', at: [395, 99.8, 500.5], yaw: 180, pitch: -10, flash: false, what: 'dark room: inside a cell, flashlight off' },
    { name: 'close-floor', at: [395, 99.3, 504.4], yaw: 270, pitch: -55, flash: true, what: 'close-up: the cell row floor in the flashlight' },
    { name: 'close-bars', at: [395, 99.3, 503.6], yaw: 0, pitch: 0, flash: true, what: 'close-up: cell bars at arm\'s length' },
    { name: 'close-face', at: [0, 0, 0], yaw: 0, pitch: 0, flash: true, face: true, what: "close-up: Torque's face (external view), 0.8 m from the head" },
  ],
  '3a': [
    { name: 'yard', at: [470, 99.3, 420], yaw: 90, pitch: 4, flash: true, what: 'yard at night, lamps' },
    { name: 'yard2', at: [457.5, 99.3, 413.5], yaw: 60, pitch: 2, flash: true, what: 'yard at night, away from the lamps' },
  ],
  '6a': [
    { name: 'woods', at: [238, 100.4, 672], yaw: 270, pitch: 6, flash: true, what: 'woods at night in the rain' },
    { name: 'woods2', at: [205, 101.2, 655], yaw: 45, pitch: 4, flash: true, what: 'woods, foliage close to the flashlight' },
  ],
};
const LEVELS = opt('--levels', Object.keys(POSES).join(','))!.split(',');
const ONLY = opt('--poses')?.split(',');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
async function waitFor<T>(fn: () => Promise<T>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const levelPath = (id: string) => {
  const dir = join(ROOT, 'game/app/LEVELS');
  const num = id.match(/^\d+/)?.[0];
  const sub = readdirSync(dir).find((d) => d.split(' ')[0] === num);
  const file = sub && readdirSync(join(dir, sub)).find((f) => f.toLowerCase().endsWith('.lvl') && f.split(' ')[0] === id);
  if (!file) throw new Error(`no level ${id}`);
  return `LEVELS/${sub}/${file}`;
};

const procs: ChildProcess[] = [];
const cleanup: string[] = [];
const quit = () => {
  for (const p of procs) {
    try {
      if (p.pid) process.kill(-p.pid);
    } catch {
      p.kill();
    }
  }
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
};
process.on('exit', quit);
process.on('SIGINT', () => process.exit(130));

let base = opt('--url');
if (!base) {
  const port = await freePort();
  const dir = mkdtempSync(join(TMP, 'enhanced-vite-'));
  cleanup.push(dir);
  const cfg = join(dir, 'vite.config.mjs');
  writeFileSync(cfg, `import base from ${JSON.stringify(join(ROOT, 'vite.config.ts'))};\nexport default { ...base, root: ${JSON.stringify(ROOT)}, cacheDir: ${JSON.stringify(join(dir, 'cache'))}, server: { ...(base.server ?? {}), hmr: false, watch: null } };\n`);
  procs.push(spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true }));
  base = `http://localhost:${port}`;
}
await waitFor(async () => (await fetch(base!)).ok, 180_000, 'dev server');
let cdp = Number(opt('--cdp', '0'));
if (!cdp) {
  const bin = [process.env.SMOKE_BROWSER, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((b) => {
    try {
      return !!b && readdirSync(dirname(b)).includes(b.split('/').pop()!);
    } catch {
      return false;
    }
  });
  if (!bin) throw new Error('no browser (set SMOKE_BROWSER)');
  cdp = await freePort();
  const profile = mkdtempSync(join(TMP, 'enhanced-profile-'));
  cleanup.push(profile);
  procs.push(
    spawn(bin, ['--headless=new', '--disable-component-update', '--disable-background-networking', '--disk-cache-size=1', '--media-cache-size=1', '--disable-gpu-shader-disk-cache', `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true }),
  );
}
const target = await waitFor(async () => ((await (await fetch(`http://127.0.0.1:${cdp}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page'), 90_000, 'browser');
const ws = new WebSocket(target!.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map<number, (d: { result?: Record<string, unknown>; error?: unknown }) => void>();
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  if (d.id && pending.has(d.id)) (pending.get(d.id)!(d), pending.delete(d.id));
};
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<{ result?: Record<string, unknown>; error?: unknown }>((r) => {
    const i = ++msgId;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = async (expr: string): Promise<any> => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const res = r.result as { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } } | undefined;
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res?.result?.value;
};
const key = async (code: string) => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code, key: code, windowsVirtualKeyCode: code === 'Enter' ? 13 : 0 });
};

/** Load a level in fly mode, skip its opening scenes, hide every overlay but the frame. */
async function load(level: string, query: string) {
  await send('Page.navigate', { url: `${base}/?level=${encodeURI(levelPath(level))}&fly&${query}` });
  await sleep(4000);
  await waitFor(
    async () => {
      const c = await ev(`(() => { const w = window.__world?.world; if (!w || !(w.time > 2) || document.querySelector('#loading:not([hidden])')) return 'wait'; return String(w.activeCutscenes().length); })()`);
      if (c === '0') return true;
      if (c !== 'wait') await key('Enter');
      await sleep(1000);
      return false;
    },
    300_000,
    `level ${level}`,
  );
  // (Subtitles, HUD and menus are DOM over the frame: everything but the frame is hidden.)
  await ev(`(() => { const c = __view.renderer.domElement; c.dataset.frame = '1'; const st = document.createElement('style'); st.textContent = '#sidebar{display:none!important} body *{visibility:hidden!important} canvas[data-frame]{visibility:visible!important}'; document.head.append(st); try { __weapons.service.give('4:72', 1); } catch {} return 1; })()`);
}

/**
 * Set the pose, refill the battery, wait for fresh frames (zones first seen compile first). A
 * scripted scene or an insanity vision that takes the camera (1a's gas chamber) is skipped and the
 * pose set again, so every mode is shot from the same place.
 */
const FACE = `(() => { const p = __player; p.setExternalView('qa', true); p.root.visible = true; const m = p.model; m.updateMatrixWorld(true);
  const V = p.root.position.constructor; let top = null, ty = -1e9; m.traverse((o) => { if (o.isBone) { const w = o.getWorldPosition(new V()); if (w.y > ty) { ty = w.y; top = w; } } });
  const f = new V(); m.getWorldDirection(f); f.y = 0; f.normalize().multiplyScalar(-1);
  const eye = top.clone().add(new V(0, 0.02, 0)).add(f.multiplyScalar(0.8));
  const v = __view; if (v.walking) v.setWalking(false);
  const d = top.clone().add(new V(0, -0.02, 0)).sub(eye); v.controls.setPose(eye, Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))); v.flashlight.visible = true; try { __weapons.persist.battery = 1; } catch {} return 1; })()`;
async function pose(p: Pose) {
  const set = p.face ? FACE : `(() => { const v = __view; if (v.walking) v.setWalking(false); v.controls.setPose(v.camera.position.clone().set(${p.at.join(',')}), ${(p.yaw * Math.PI) / 180}, ${(p.pitch * Math.PI) / 180}); v.flashlight.visible = ${p.flash}; try { __weapons.persist.battery = 1; } catch {} return 1; })()`;
  const at = `(() => { const c = __view.camera.getWorldPosition(__view.camera.position.clone()); const busy = __world.world.activeCutscenes().length > 0 || [...document.querySelectorAll('.cutscene-layer')].some((e) => e.style.display !== 'none'); return !busy && (${!!p.face} || c.distanceTo(c.clone().set(${p.at.join(',')})) < 0.05); })()`;
  for (let tries = 0; ; tries++) {
    const before = (await ev(`__frames.stats().frames`)) as number;
    await ev(set);
    await waitFor(async () => ((await ev(`__frames.stats().frames`)) as number) > before + 30, 180_000, `frames at ${p.name}`);
    await sleep(SETTLE * 1000);
    if (await ev(at)) break;
    if (tries > 20) throw new Error(`pose ${p.name}: the camera is taken (scripted scene)`);
    await key('Enter');
    await sleep(1500);
  }
  await ev(`(() => { try { __weapons.persist.battery = 1; } catch {} return 1; })()`);
}

async function shot(file: string): Promise<FrameMetrics> {
  const [x, y, w, h] = (await ev(`(() => { const r = __view.renderer.domElement.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`)) as number[];
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale: 1 } });
  const png = Buffer.from(String(r.result?.data), 'base64');
  writeFileSync(file, png);
  return frameMetrics(decodePng(png));
}

async function fps(): Promise<number | null> {
  if (!(FPS_SECS > 0)) return null;
  await ev(`(() => { __frames.reset(); return 1; })()`);
  await sleep(FPS_SECS * 1000);
  return (await ev(`__frames.stats().fps`)) as number;
}

interface Row {
  level: string;
  pose: string;
  mode: string;
  metrics: FrameMetrics;
  fps: number | null;
  check?: PoseCheck;
}
const rows: Row[] = [];
mkdirSync(OUT, { recursive: true });
try {
  for (const level of LEVELS) {
    const poses = (POSES[level] ?? []).filter((p) => !ONLY || ONLY.includes(p.name));
    if (!poses.length) continue;
    await load(level, 'gfx=original');
    const orig = new Map<string, FrameMetrics>();
    for (const p of poses) {
      await pose(p);
      const m = await shot(join(OUT, `${level}-${p.name}-original.png`));
      orig.set(p.name, m);
      rows.push({ level, pose: p.name, mode: 'original', metrics: m, fps: await fps() });
    }
    await load(level, `gfx=enhanced&tier=${TIERS[0]}`);
    for (const p of poses) {
      for (const t of TIERS) {
        await ev(`(() => { __enhanced.setTier('${t}'); return 1; })()`);
        await pose(p);
        const m = await shot(join(OUT, `${level}-${p.name}-${t}.png`));
        rows.push({ level, pose: p.name, mode: t, metrics: m, fps: await fps(), check: checkFrame(orig.get(p.name)!, m) });
      }
    }
  }
} finally {
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(rows, null, 1));
  ws.close();
}

const pct = (v: number) => `${(v * 100).toFixed(1)}`;
console.log('| Level | Pose | Mode | Mean | Ratio | Clipped % | Near black % | fps | Check |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const c = r.check;
  console.log(`| ${r.level} | ${r.pose} | ${r.mode} | ${r.metrics.mean.toFixed(1)} | ${c ? c.ratio.toFixed(2) : '1'} | ${pct(r.metrics.clipped)} | ${pct(r.metrics.black)} | ${r.fps ?? ''} | ${c ? (c.ok ? 'ok' : c.failures.join('; ')) : ''} |`);
}
const failed = rows.filter((r) => r.check && !r.check.ok).length;
console.log(`${failed} of ${rows.filter((r) => r.check).length} Enhanced frames fail the image check; frames and metrics.json in ${OUT}`);
process.exit(failed && !args.includes('--no-fail') ? 1 : 0);
