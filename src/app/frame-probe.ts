// Frame-time probe (QA / profiling, always on, allocation-free per frame).
//
// LevelRenderer.frame() calls begin() / lap() / end() around its parts (player, matrices,
// culling, lights, shadows, render, game systems by name); the probe keeps a ring buffer of
// frame intervals (rAF timestamps) and the main-thread time spent in frame(), and a short list
// of slow frames (interval or CPU over `slowMs`) with that breakdown. A Long Animation Frame
// observer (Chromium) adds script attribution for long frames whose time went elsewhere
// (promise callbacks, decoders, input handlers).
//
// window.__frames: stats() -> { frames, fps, p50, p95, p99, max, over33, over50, cpuP99, cpuMean,
// gpu* }, reset(), slow, loaf, load. With `?gputime` the renderer also records the GPU time of
// each frame's render passes (WebGPU timestamp queries; off by default: the queries cost a little).
// `load`: the phases of the last level load, [name, ms since the load began] (src/app/main.ts).
// QA scripts read it per scenario (docs/game-logic.md §18).

export interface SlowFrame {
  /** performance.now() at the frame's start. */
  t: number;
  /** Interval since the previous frame (ms). */
  dt: number;
  /** Main-thread time inside frame() (ms). */
  cpu: number;
  /** Section -> ms (sections over 1 ms). */
  parts: Record<string, number>;
  /** Free-form note set by code that knows why (e.g. a sequence start). */
  note?: string;
}

export interface LoafEntry {
  t: number;
  dur: number;
  blocking: number;
  render: number;
  scripts: string[];
}

const SIZE = 1 << 15;

export class FrameProbe {
  /** Frames whose interval or CPU time exceeds this go to `slow`. */
  slowMs = 34;
  readonly dt = new Float32Array(SIZE);
  /** performance.now() at each frame's start. */
  readonly at = new Float64Array(SIZE);
  readonly cpu = new Float32Array(SIZE);
  /** Frames recorded since the last reset (the ring keeps the last SIZE). */
  n = 0;
  slow: SlowFrame[] = [];
  loaf: LoafEntry[] = [];
  private last = -1;
  private start = 0;
  private lapAt = 0;
  private names: string[] = [];
  private slot = new Map<string, number>();
  private acc = new Float64Array(64);
  private notes: string[] = [];
  /** GPU time (ms) of sampled frames (`?gputime`), since the last reset. */
  readonly gpu = new Float32Array(SIZE);
  gpuN = 0;
  /** Phases of the last level load: [name, ms since its start] (mark()). */
  load: [string, number][] = [];
  private loadAt = 0;

  constructor() {
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { blockingDuration: number; renderStart: number; scripts: { invoker: string; sourceFunctionName: string; sourceURL: string; duration: number }[] })[]) {
        if (e.duration < 50) continue;
        if (this.loaf.length >= 400) this.loaf.shift();
        const short = (u: string) => u.replace(/^.*\/src\//, '').replace(/\?.*$/, '');
        this.loaf.push({
          t: Math.round(e.startTime),
          dur: Math.round(e.duration),
          blocking: Math.round(e.blockingDuration),
          render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
          scripts: e.scripts.filter((s) => s.duration >= 5).map((s) => `${Math.round(s.duration)}ms ${s.invoker} ${s.sourceFunctionName || ''} ${short(s.sourceURL)}`),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  }

  /** Start of a frame (rAF timestamp `t`). */
  begin(t: number) {
    const now = performance.now();
    if (this.last >= 0) this.dt[this.n & (SIZE - 1)] = t - this.last;
    else this.dt[this.n & (SIZE - 1)] = 0;
    this.last = t;
    this.at[this.n & (SIZE - 1)] = now;
    this.start = this.lapAt = now;
    this.acc.fill(0);
  }

  /** Time since the previous lap goes to `name`. */
  lap(name: string) {
    const now = performance.now();
    let i = this.slot.get(name);
    if (i === undefined) {
      i = this.names.length;
      if (i >= this.acc.length) return;
      this.names.push(name);
      this.slot.set(name, i);
    }
    this.acc[i] += now - this.lapAt;
    this.lapAt = now;
  }

  /** No frame this display frame (loading): the next interval starts over. */
  pause() {
    this.last = -1;
  }

  /** Attach a note to the current frame (shown with it when it is slow). */
  note(s: string) {
    if (this.notes.length < 8) this.notes.push(s);
  }

  end() {
    const k = this.n & (SIZE - 1);
    const cpu = performance.now() - this.start;
    this.cpu[k] = cpu;
    const dt = this.dt[k];
    if ((dt > this.slowMs || cpu > this.slowMs) && this.n > 0) {
      const parts: Record<string, number> = {};
      for (let i = 0; i < this.names.length; i++) if (this.acc[i] >= 1) parts[this.names[i]] = Math.round(this.acc[i] * 10) / 10;
      if (this.slow.length >= 400) this.slow.shift();
      this.slow.push({ t: Math.round(this.start), dt: Math.round(dt), cpu: Math.round(cpu), parts, note: this.notes.length ? this.notes.join('; ') : undefined });
    }
    this.notes.length = 0;
    this.n++;
  }

  /** A level load begins (`begin`) or reaches the phase `name`. */
  mark(name: string, begin = false) {
    const now = performance.now();
    if (begin) {
      this.load = [];
      this.loadAt = now;
    }
    this.load.push([name, Math.round(now - this.loadAt)]);
  }

  /** GPU time of one frame (ms). */
  gpuSample(ms: number) {
    this.gpu[this.gpuN++ & (SIZE - 1)] = ms;
  }

  reset() {
    this.n = 0;
    this.gpuN = 0;
    this.last = -1;
    this.slow = [];
    this.loaf = [];
  }

  /**
   * Frame-time distribution since the last reset (the last 32768 frames at most); `skip`:
   * [from, to] performance.now() windows whose frames are left out (a test harness's own work).
   */
  stats(skip: [number, number][] = []) {
    const m = Math.min(this.n, SIZE);
    const keep = (i: number) => !skip.some(([a, b]) => this.at[i] >= a && this.at[i] - this.dt[i] <= b);
    const d: number[] = [];
    const c: number[] = [];
    for (let i = 0; i < m; i++) {
      if (!keep(i)) continue;
      if (this.dt[i] > 0) d.push(this.dt[i]);
      c.push(this.cpu[i]);
    }
    d.sort((a, b) => a - b);
    c.sort((a, b) => a - b);
    const q = (a: number[], p: number) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 10) / 10 : 0);
    const sum = d.reduce((a, b) => a + b, 0);
    const g = Array.from(this.gpu.subarray(0, Math.min(this.gpuN, SIZE))).sort((a, b) => a - b);
    return {
      frames: d.length,
      fps: sum ? Math.round((d.length / sum) * 10000) / 10 : 0,
      p50: q(d, 0.5),
      p95: q(d, 0.95),
      p99: q(d, 0.99),
      max: q(d, 1),
      over33: d.filter((x) => x > 33.4).length,
      over50: d.filter((x) => x > 50).length,
      cpuP99: q(c, 0.99),
      cpuMax: q(c, 1),
      cpuMean: c.length ? Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 100) / 100 : 0,
      gpuFrames: g.length,
      gpuMean: g.length ? Math.round((g.reduce((a, b) => a + b, 0) / g.length) * 100) / 100 : 0,
      gpuP50: q(g, 0.5),
      gpuP95: q(g, 0.95),
    };
  }
}

export const frameProbe = new FrameProbe();
