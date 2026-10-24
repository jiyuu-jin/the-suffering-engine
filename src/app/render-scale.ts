// Render scale, dynamic resolution and frame pacing (docs/perf.md "Perf A: resolution, pixel cost,
// pacing").
//
// The internal resolution is the renderer's drawing buffer: CSS size x min(devicePixelRatio, 2) x
// the render scale. Everything sized from the drawing buffer follows it (the Original frame and
// scene-glow targets, the insanity screen-effect targets, the Enhanced pipeline: scene, AO,
// volumetrics, TRAA history, bloom, grade); the browser's compositor scales the canvas to its CSS
// size (bilinear), and Enhanced sharpens the frame first (FSR 1 RCAS, enhanced/sharpen.ts).
//
//   Setting  Graphics "Resolution" row (`x.renderScale`: 0 = Auto, else 0.5 .. 1), or `?scale=`
//            (auto, 50, 67, 0.75, 85% ...) for the page load (it holds until the row changes).
//   Auto     the largest scale whose internal pixels fit the mode / tier budget (PIXEL_BUDGET),
//            then dynamic resolution between a floor and that cap (DynamicResolution).
//   Fixed    exactly that scale (no dynamic resolution).
//
// The GPU side is seen through `GPUQueue.onSubmittedWorkDone()` at the end of each frame's task
// (GpuBusy): frames in flight and how long after the task the GPU completed them. WebGPU
// timestamp queries are not usable on Apple GPUs (per-pass intervals overlap: three.js's sum read
// 60-90 ms for frames presented at 60 fps), and Chromium resolves the completion about one display
// frame late even on an idle GPU, so headroom is found by probing one step up.
//
// Pure parts (parse, budgets, the controllers) have tests: tests/render-scale.test.ts.

export type ScaleSetting = 'auto' | number;

/** Resolution row values (`x.renderScale`), in menu order: 0 = Auto. */
export const RENDER_SCALES: readonly number[] = [0, 0.5, 0.67, 0.75, 0.85, 1];
/**
 * Dynamic resolution ladder step and lower bound (per axis, x native: 0.4 of a 2x display is 0.8
 * CSS px per pixel). The menu's fixed choices start at 50 %.
 */
export const SCALE_STEP = 0.05;
export const SCALE_MIN = 0.4;
/** Dynamic resolution never goes below this many internal pixels (1280 × 720), nor above native. */
export const MIN_PIXELS = 1280 * 720;

/**
 * Auto's pixel budget (internal megapixels) per graphics mode / Enhanced tier: the cap below which
 * dynamic resolution works. Measured on an M1 Pro (16-core GPU) at 3456 x 2234, 1a's cell row,
 * frame rate unlimited (docs/perf.md "Perf A"): Original holds 60 fps at native (its cap: native up
 * to 4K); Enhanced Medium 79 fps at 2.8 Mpx, 68 at 3.8, 34 at 7.7; High 74-84 at 1.9, 73 at 2.3,
 * 43-57 at 2.8; Ultra 40 at 1.9; Low is CPU-bound (87 fps) at 3.8.
 */
export const PIXEL_BUDGET: Readonly<Record<'original' | 'low' | 'medium' | 'high' | 'ultra', number>> = {
  original: 8.3,
  low: 4.2,
  medium: 3.0,
  high: 2.2,
  ultra: 1.9,
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Snap down to the ladder (a tiny tolerance keeps 0.75 at 0.75). */
export const quantizeDown = (s: number) => Math.floor(s / SCALE_STEP + 1e-6) * SCALE_STEP;
const round3 = (s: number) => Math.round(s * 1000) / 1000;

/** `?scale=` / a menu value -> a setting; null when not given or not understood. */
export function parseScale(v: string | number | null | undefined): ScaleSetting | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 0 ? clamp(v, 0.25, 1) : 'auto';
  const s = v.trim().toLowerCase().replace(/%$/, '');
  if (s === 'auto' || s === '0') return 'auto';
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n <= 0) return null;
  return clamp(n > 2 ? n / 100 : n, 0.25, 1);
}

/** The lowest scale dynamic resolution uses for a native drawing buffer of w × h. */
export function floorScale(w: number, h: number): number {
  const px = w * h;
  if (!(px > 0)) return 1;
  return round3(clamp(Math.ceil(Math.sqrt(MIN_PIXELS / px) / SCALE_STEP - 1e-6) * SCALE_STEP, SCALE_MIN, 1));
}

/** Auto's cap: the largest ladder scale whose pixels fit `budgetMpx` (never under the floor). */
export function budgetScale(w: number, h: number, budgetMpx: number): number {
  const px = w * h;
  if (!(px > 0)) return 1;
  const s = Math.sqrt((budgetMpx * 1e6) / px);
  return round3(clamp(s >= 1 ? 1 : quantizeDown(s), floorScale(w, h), 1));
}

/**
 * Dynamic resolution: feed it every drawn frame (and every frame skipped for a GPU backlog); it
 * answers with a new scale when one is due. Windows of `windowMs`.
 *
 *   GPU-bound window: frames late (under 93 % of the target rate) while the main thread had time
 *     to spare (under 80 % of the frame) and the GPU fell behind: its completions came more than
 *     1.6 frames after the frame was handed over, or frames were held back for the backlog.
 *   Down: after two GPU-bound windows, in proportion to the rate (a GPU-bound frame rate is the
 *     GPU's), at least one step, at most 30 %.
 *   Up: after `upAfter` good windows (on target, no backlog) one step, as a probe: a level that
 *     has to be left within 5 s of being reached is not tried again for 20 s, doubling each time
 *     (up to 160 s). Chromium resolves `onSubmittedWorkDone` about a display frame late even on an
 *     idle GPU, so there is no GPU-time measure of headroom (and Apple GPUs' timestamp queries
 *     overlap pass by pass): the probe is the measure.
 *
 * After a change, `cooldownMs` without decisions (the resize hitch). Pure (tests).
 */
export class DynamicResolution {
  /** Frames per second to hold. */
  target = 60;
  readonly windowMs = 500;
  readonly cooldownMs = 1200;
  /** Good windows before a step up. */
  upAfter = 6;
  private acc = 0;
  private frames = 0;
  private cpu = 0;
  private lag = 0;
  private lagN = 0;
  private skips = 0;
  private slow = 0;
  private good = 0;
  private cooldownUntil = 0;
  private raisedAt = -1e9;
  private bans = new Map<number, { until: number; backoff: number }>();
  /** Last window: fps, mean GPU lag / CPU ms, frames held back (QA). */
  last = { fps: 0, lag: 0, cpu: 0, skips: 0 };
  log: string[] = [];

  constructor(
    public scale: number,
    public cap: number,
    public floor: number,
  ) {}

  /** Hold off decisions (a resize, a level load, a tier change). */
  hold(now: number, ms = this.cooldownMs) {
    this.cooldownUntil = Math.max(this.cooldownUntil, now + ms);
    this.reset();
    this.slow = this.good = 0;
  }

  private reset() {
    this.acc = this.frames = this.cpu = this.lag = this.lagN = this.skips = 0;
  }

  /** A display frame not drawn because the GPU had too many frames in flight. */
  skip() {
    this.skips++;
  }

  /**
   * One drawn frame: `dtMs` since the previous one, `cpuMs` its main-thread time, `lagMs` how long
   * after the end of its task the GPU completed the last resolved frame (< 0: unknown), `now`
   * performance.now(). Returns the new scale, or null.
   */
  sample(dtMs: number, cpuMs: number, lagMs: number, now: number): number | null {
    if (!(dtMs > 0) || dtMs > 250) return null;
    this.acc += dtMs;
    this.frames++;
    this.cpu += cpuMs;
    if (lagMs >= 0) (this.lag += lagMs), this.lagN++;
    if (this.acc < this.windowMs) return null;
    const fps = (this.frames * 1000) / this.acc;
    const cpu = this.cpu / this.frames;
    const lag = this.lagN ? this.lag / this.lagN : -1;
    const skips = this.skips;
    this.reset();
    this.last = { fps: Math.round(fps * 10) / 10, lag: Math.round(lag * 10) / 10, cpu: Math.round(cpu * 10) / 10, skips };
    if (now < this.cooldownUntil || lag < 0) return null;
    const T = 1000 / this.target;
    if (fps < this.target * 0.93 && cpu < T * 0.8 && (lag > T * 1.6 || skips > 0)) {
      this.good = 0;
      if (++this.slow < 2 || this.scale <= this.floor + 1e-6) return null;
      this.slow = 0;
      const ratio = clamp(Math.sqrt(fps / this.target) * 0.97, 0.7, 0.95);
      const next = round3(Math.max(this.floor, Math.min(quantizeDown(this.scale * ratio), this.scale - SCALE_STEP)));
      if (now - this.raisedAt < 5000) {
        const b = this.bans.get(this.scale);
        const backoff = Math.min(160_000, b ? b.backoff * 2 : 20_000);
        this.bans.set(this.scale, { until: now + backoff, backoff });
      }
      this.raisedAt = -1e9;
      return this.switch(next, now, `fps ${fps.toFixed(1)}, gpu lag ${lag.toFixed(1)} ms${skips ? `, ${skips} held` : ''}`);
    }
    this.slow = 0;
    const up = round3(Math.min(this.cap, this.scale + SCALE_STEP));
    if (up > this.scale + 1e-6 && fps >= this.target * 0.96 && lag < T * 1.35 && skips === 0) {
      if (++this.good < this.upAfter) return null;
      this.good = 0;
      const ban = this.bans.get(up);
      if (ban && now < ban.until) return null;
      this.raisedAt = now;
      return this.switch(up, now, `probe up, gpu lag ${lag.toFixed(1)} ms`);
    }
    this.good = 0;
    return null;
  }

  private switch(s: number, now: number, why: string): number {
    this.log.push(`${(now / 1000).toFixed(1)} s ${this.scale} -> ${s} (${why})`);
    if (this.log.length > 40) this.log.shift();
    this.scale = s;
    this.hold(now);
    return s;
  }
}

/**
 * GPU completion of each frame (`onSubmittedWorkDone()` at the end of the frame's task: WebGPU in
 * Chromium hands the commands over then): `pending` frames in flight, `last` how long after the
 * end of its task the last resolved frame completed (about one display frame on an idle GPU,
 * several when the GPU falls behind: the queue, and the input latency, grow).
 */
export class GpuBusy {
  /** Last resolved frame's completion after the end of its task (ms), -1 until known. */
  last = -1;
  /** Frames handed to the GPU and not yet complete. */
  pending = 0;
  /** QA: [start, end, done] of the last frames (performance.now()). */
  readonly trace: [number, number, number][] = [];
  constructor(public device: GPUDevice | null = null) {}
  get available() {
    return !!this.device;
  }
  /** At the end of the frame's task; `start`: performance.now() before its first submission. */
  frame(start: number) {
    const d = this.device;
    if (!d) return;
    this.pending++;
    const end = performance.now();
    d.queue.onSubmittedWorkDone().then(
      () => {
        this.pending--;
        const t = performance.now();
        this.last = t - end;
        if (this.trace.length >= 120) this.trace.shift();
        this.trace.push([start, end, t]);
      },
      () => this.pending--,
    );
  }
}

/** The saved Resolution row (localStorage, read before the settings module exists: dev pages). */
export function storedScale(): ScaleSetting {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('suffering.settings.v1') : null;
    const v = raw ? (JSON.parse(raw) as { extra?: Record<string, unknown> }).extra?.renderScale : undefined;
    return typeof v === 'number' ? (parseScale(v) ?? 'auto') : 'auto';
  } catch {
    return 'auto';
  }
}

/** `?scale=` of this page (null when absent). */
export const URL_SCALE: ScaleSetting | null = typeof location !== 'undefined' ? parseScale(new URLSearchParams(location.search).get('scale')) : null;

/**
 * Smooth pacing on high-refresh displays (ProMotion: 120 Hz rAF) with the frame-rate limit Off:
 * when frames keep missing the display's interval (over 20 % of a second's frames more than 1.5
 * intervals apart), render on every other display frame (a steady 60 instead of a 120 / 60
 * judder); back to every frame after 3 s whose frames took under 70 % of the interval on the main
 * thread. A return that fails within 5 s doubles the wait before the next (5 s .. 120 s): the GPU
 * side of the frame is not measurable (DynamicResolution). Displays at 75 Hz and below are never
 * paced. Pure (tests).
 */
export class FramePacer {
  /** Frame-rate cap in effect (0 = every display frame). */
  cap = 0;
  /** Display refresh estimate (Hz) from the rAF callbacks, 0 until known. */
  hz = 0;
  private raw: number[] = [];
  private acc = 0;
  private late = 0;
  private frames = 0;
  private work = 0;
  private fit = 0;
  private since = -1e9;
  private backoff = 5000;

  /**
   * Every rAF callback: `rawMs` since the previous callback, `rendered` whether a frame was drawn,
   * `intervalMs` since the previous drawn frame, `workMs` its main-thread time.
   */
  sample(rawMs: number, rendered: boolean, intervalMs: number, workMs: number, now: number): number {
    if (!(rawMs > 0) || rawMs > 250) return this.cap;
    this.raw.push(rawMs);
    if (this.raw.length > 90) this.raw.shift();
    if (this.raw.length >= 30 && this.raw.length % 15 === 0) {
      const s = [...this.raw].sort((a, b) => a - b);
      this.hz = Math.round(1000 / s[s.length >> 1]);
    }
    if (!rendered || !(intervalMs > 0) || intervalMs > 250) return this.cap;
    const vsync = 1000 / Math.max(1, this.hz);
    this.acc += intervalMs;
    this.frames++;
    this.work = Math.max(this.work, workMs);
    if (intervalMs > vsync * 1.5) this.late++;
    if (this.acc < 1000) return this.cap;
    const lateShare = this.late / this.frames, work = this.work;
    this.acc = this.late = this.frames = this.work = 0;
    if (this.hz <= 75) return (this.cap = 0);
    if (this.cap === 0) {
      if (lateShare > 0.2) {
        this.backoff = now - this.since < 5000 ? Math.min(120_000, this.backoff * 2) : 5000;
        this.cap = Math.round(this.hz / 2);
        this.since = now;
        this.fit = 0;
      }
    } else if (work < vsync * 0.7) {
      if (++this.fit >= 3 && now - this.since > this.backoff) ((this.cap = 0), (this.since = now), (this.fit = 0));
    } else this.fit = 0;
    return this.cap;
  }
}

/** What RenderScaler drives (LevelRenderer). */
export interface ScaleTarget {
  setPixelRatio(r: number): void;
}

/**
 * The render scale of one renderer: the setting (menu / `?scale=`), Auto's cap from the budget,
 * dynamic resolution, and the pixel ratio applied to the renderer.
 */
export class RenderScaler {
  setting: ScaleSetting;
  /** Scale in use (× native per axis). */
  scale = 1;
  cap = 1;
  floor = SCALE_MIN;
  budgetKey: keyof typeof PIXEL_BUDGET = 'original';
  readonly dyn = new DynamicResolution(1, 1, SCALE_MIN);
  /** Frames in flight and their completion lag (its device is set once the renderer is initialised). */
  readonly gpu = new GpuBusy();
  /** Native drawing buffer (CSS size × min(DPR, 2)) and the internal one. */
  native = { w: 0, h: 0 };
  internal = { w: 0, h: 0 };
  changes = 0;
  private dpr = 1;
  private css = { w: 0, h: 0 };
  private menuSeen: ScaleSetting | null = null;
  private applied = 0;

  constructor(
    private readonly target: ScaleTarget,
    setting: ScaleSetting = URL_SCALE ?? storedScale(),
  ) {
    this.setting = setting;
  }

  get dynamic(): boolean {
    return this.setting === 'auto' && this.gpu.available;
  }

  /** The Resolution row. A `?scale=` override holds until the row is actually changed. */
  setSetting(s: ScaleSetting) {
    if (URL_SCALE !== null && (this.menuSeen === null || this.menuSeen === s)) {
      this.menuSeen = s;
      return;
    }
    this.menuSeen = s;
    if (s === this.setting) return;
    this.setting = s;
    this.update(true);
  }

  /** Auto's budget (graphics mode / Enhanced tier). */
  setBudget(key: keyof typeof PIXEL_BUDGET) {
    if (key === this.budgetKey) return;
    this.budgetKey = key;
    this.update(true);
  }

  /** The canvas's CSS size and the display's pixel ratio. */
  resize(cssW: number, cssH: number, dpr: number) {
    this.css = { w: cssW, h: cssH };
    this.dpr = Math.min(Math.max(dpr || 1, 0.5), 2);
    this.update(false);
  }

  /** Recompute the cap / floor; `reset`: start Auto at its cap (a new setting or budget). */
  private update(reset: boolean) {
    const w = Math.round(this.css.w * this.dpr), h = Math.round(this.css.h * this.dpr);
    this.native = { w, h };
    this.floor = floorScale(w, h);
    if (this.setting === 'auto') {
      this.cap = budgetScale(w, h, PIXEL_BUDGET[this.budgetKey]);
      this.scale = reset || !this.applied ? this.cap : Math.min(Math.max(this.scale, this.floor), this.cap);
    } else this.cap = this.scale = this.setting;
    const d = this.dyn;
    d.cap = this.cap;
    d.floor = Math.min(this.floor, this.cap);
    d.scale = this.scale;
    d.hold(typeof performance !== 'undefined' ? performance.now() : 0);
    this.apply();
  }

  private apply() {
    const ratio = this.dpr * this.scale;
    this.internal = { w: Math.floor(this.css.w * ratio), h: Math.floor(this.css.h * ratio) };
    if (Math.abs(ratio - this.applied) < 1e-4) return;
    this.applied = ratio;
    this.changes++;
    this.target.setPixelRatio(ratio);
  }

  /** One drawn frame (after its submissions): dynamic resolution. */
  frame(dtMs: number, cpuMs: number, now: number, targetFps: number) {
    if (!this.dynamic) return;
    this.dyn.target = targetFps;
    const next = this.dyn.sample(dtMs, cpuMs, this.gpu.last, now);
    if (next !== null && Math.abs(next - this.scale) > 1e-6) {
      this.scale = next;
      this.apply();
    }
  }

  /** Hold dynamic resolution off for a moment (level load, tier change, tab shown again). */
  hold(ms?: number) {
    this.dyn.hold(performance.now(), ms);
  }

  /** "2000 x 1290 (58 %, auto)" (debug overlay, QA). */
  info(): string {
    const pct = Math.round(this.scale * 100);
    return `${this.internal.w} x ${this.internal.h} (${pct} %${this.setting === 'auto' ? (this.dynamic ? ', auto' : ', auto fixed') : ''})`;
  }
}
