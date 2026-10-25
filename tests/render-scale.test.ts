// Render scale, dynamic resolution, frame pacing and RCAS sharpening (src/app/render-scale.ts,
// src/app/enhanced/sharpen.ts; docs/perf.md "Perf A").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicResolution, FramePacer, PACE_LATE_SHARE, PIXEL_BUDGET, RENDER_SCALES, RenderScaler, SCALE_MIN, budgetScale, floorScale, parseScale } from '../src/app/render-scale';
import { rcasPixel, sharpenFor } from '../src/app/enhanced/sharpen';
import { GRAPHICS_DEFAULTS } from '../src/app/menu/graphics';
import { RESOLUTION_SCALES } from '../src/app/menu/gui-adapter';

test('render scale: ?scale= and menu values', () => {
  assert.equal(parseScale(null), null);
  assert.equal(parseScale('auto'), 'auto');
  assert.equal(parseScale('0'), 'auto');
  assert.equal(parseScale('75'), 0.75);
  assert.equal(parseScale('67%'), 0.67);
  assert.equal(parseScale('0.85'), 0.85);
  assert.equal(parseScale('100'), 1);
  assert.equal(parseScale('400'), 1);
  assert.equal(parseScale('banana'), null);
  assert.equal(parseScale(0), 'auto');
  assert.equal(parseScale(0.5), 0.5);
  // The Resolution row: Auto first, the default.
  assert.deepEqual(RESOLUTION_SCALES, [0, 0.5, 0.67, 0.75, 0.85, 1]);
  assert.deepEqual(RENDER_SCALES, RESOLUTION_SCALES);
  assert.equal(GRAPHICS_DEFAULTS.renderScale, 0);
});

test('render scale: Auto budget and floor at the M1 Pro display (3456 x 2234) and at 1080p', () => {
  const [w, h] = [3456, 2234];
  assert.equal(floorScale(w, h), SCALE_MIN);
  // Original keeps native up to 4K: identical to the unscaled frame.
  assert.equal(budgetScale(w, h, PIXEL_BUDGET.original), 1);
  const med = budgetScale(w, h, PIXEL_BUDGET.medium);
  assert.ok(med < 1 && med >= 0.5 && w * h * med * med <= PIXEL_BUDGET.medium * 1e6, `medium ${med}`);
  assert.ok(budgetScale(w, h, PIXEL_BUDGET.high) <= med);
  // A 1080p display at DPR 1 is within Medium's and High's budgets.
  assert.equal(budgetScale(1920, 1080, PIXEL_BUDGET.medium), 1);
  assert.equal(budgetScale(1920, 1080, PIXEL_BUDGET.high), 1);
  // The floor never goes under 1280 x 720 pixels (nor above native).
  assert.equal(floorScale(1280, 720), 1);
  assert.ok(floorScale(1920, 1080) >= 0.67 && floorScale(1920, 1080) < 0.75);
});

/** Feed `secs` of frames at `fps` with the given CPU time and GPU lag; returns the decisions. */
function run(d: DynamicResolution, from: number, secs: number, fps: number, cpu: number, lag: number): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [];
  const dt = 1000 / fps;
  for (let t = from; t < from + secs * 1000; t += dt) {
    const s = d.sample(dt, cpu, lag, t);
    if (s !== null) out.push({ t, s });
  }
  return out;
}

test('dynamic resolution: drops when GPU-bound, in proportion, at least one step', () => {
  const d = new DynamicResolution(0.6, 0.6, 0.5);
  d.hold(0, 0);
  // 34 fps, main thread at 11 ms, the GPU 5 frames behind (Enhanced Medium at native).
  const r = run(d, 0, 1.2, 34, 11, 160);
  assert.equal(r.length, 1);
  assert.ok(r[0].s < 0.6 && r[0].s >= 0.5, `to ${r[0].s}`);
  assert.equal(d.scale, r[0].s);
});

test('dynamic resolution: a CPU-bound frame is never answered with a lower resolution', () => {
  const d = new DynamicResolution(1, 1, 0.5);
  d.hold(0, 0);
  // 45 fps with 22 ms of main-thread work (3a's yard in Original): the GPU keeps up.
  assert.deepEqual(run(d, 0, 10, 45, 22, 17), []);
  // Late frames with time to spare but no GPU backlog either: not the GPU.
  assert.deepEqual(run(d, 10_000, 10, 50, 8, 18), []);
});

test('dynamic resolution: probes up after good windows; a failed level is banned with back-off', () => {
  const d = new DynamicResolution(0.5, 0.6, 0.5);
  d.hold(0, 0);
  const up = run(d, 0, 4.5, 60, 10, 17);
  assert.equal(up.length, 1);
  assert.equal(up[0].s, 0.55);
  // 0.55 overloads: back down within 5 s, and 0.55 is not tried again for 20 s.
  const down = run(d, 4500, 2.5, 45, 10, 70);
  assert.equal(down.length, 1);
  assert.equal(down[0].s, 0.5);
  assert.deepEqual(run(d, 7000, 15, 60, 10, 17), []);
  const again = run(d, 22_000, 8, 60, 10, 17);
  assert.equal(again[0]?.s, 0.55);
  // Never above the cap.
  const capped = new DynamicResolution(0.6, 0.6, 0.5);
  capped.hold(0, 0);
  assert.deepEqual(run(capped, 0, 10, 60, 10, 17), []);
});

test('dynamic resolution: frames held back for the GPU backlog count as GPU-bound', () => {
  const d = new DynamicResolution(0.7, 0.7, 0.5);
  d.hold(0, 0);
  const out: number[] = [];
  for (let t = 0; t < 2000; t += 25) {
    d.skip();
    const s = d.sample(25, 9, 30, t);
    if (s !== null) out.push(s);
  }
  assert.equal(out.length, 1);
  assert.ok(out[0] < 0.7);
});

test('frame pacing: a 120 Hz display that misses frames is paced to 60, a 60 Hz one never', () => {
  const p = new FramePacer();
  // 120 Hz rAF; every other frame takes two intervals (CPU 10 ms).
  let t = 0;
  for (let i = 0; i < 400; i++) {
    t += 8.33;
    const late = i % 2 === 0;
    p.sample(8.33, late, late ? 16.67 : 0, 10, t);
  }
  assert.equal(p.hz, 120);
  assert.equal(p.cap, 60);
  // Light frames (3 ms) for long enough: back to every display frame (and it holds).
  for (let i = 0; i < 1400; i++) {
    t += 8.33;
    const paced = p.cap > 0;
    p.sample(8.33, !paced || i % 2 === 0, paced ? 16.67 : 8.33, 3, t);
  }
  assert.equal(p.cap, 0);
  const q = new FramePacer();
  t = 0;
  for (let i = 0; i < 300; i++) ((t += 16.67), q.sample(16.67, i % 2 === 0, 33.3, 20, t));
  assert.equal(q.hz, 60);
  assert.equal(q.cap, 0);
});

test('frame pacing: occasional in-flight skips at 120 Hz (an uneven 108 fps) are paced to 60; rare hitches are not', () => {
  // Every 10th display frame skipped by the frames-in-flight limit: 1 drawn frame in 9 comes
  // 16.7 ms after the previous one (11 %). Under the old 20 % threshold this judder never paced.
  const run = (skipEvery: number, seconds: number) => {
    const p = new FramePacer();
    let t = 0, last = 0;
    for (let i = 0; i < seconds * 120; i++) {
      t += 1000 / 120;
      const drawn = i % skipEvery !== skipEvery - 1;
      // Paced: only every other display frame is drawn.
      const gate = p.cap > 0 && t - last < 1000 / p.cap - 2;
      if (drawn && !gate) {
        p.sample(1000 / 120, true, t - last, 6, t);
        last = t;
      } else p.sample(1000 / 120, false, 0, 0, t);
    }
    return p;
  };
  const uneven = run(10, 4);
  assert.equal(uneven.hz, 120);
  assert.equal(uneven.cap, 60);
  assert.ok(PACE_LATE_SHARE < 1 / 9);
  // Two hitches a second (GC, a resize): 120 Hz stays.
  assert.equal(run(60, 4).cap, 0);
});

test('render scaler: Auto starts at the budget cap; a fixed setting is exact; ratios applied', () => {
  const ratios: number[] = [];
  const s = new RenderScaler({ setPixelRatio: (r) => ratios.push(r) }, 'auto');
  s.resize(1728, 1117, 2);
  assert.equal(s.scale, 1);
  assert.equal(ratios.at(-1), 2);
  s.setBudget('medium');
  assert.equal(s.scale, budgetScale(3456, 2234, PIXEL_BUDGET.medium));
  assert.ok(Math.abs(ratios.at(-1)! - 2 * s.scale) < 1e-9);
  assert.match(s.info(), /^\d+ x \d+ \(\d+ %, auto fixed\)$/);
  s.setSetting(0.75);
  assert.equal(s.scale, 0.75);
  assert.equal(ratios.at(-1), 1.5);
  // DPR above 2 is capped at 2 (as before).
  s.resize(1000, 800, 3);
  assert.equal(ratios.at(-1), 1.5);
});

test('RCAS: strength 0 and flat areas unchanged; an edge sharpens without leaving [0, 1]', () => {
  const g = (v: number) => [v, v, v];
  assert.deepEqual(rcasPixel(g(0.2), g(0.8), g(0.5), g(0.3), g(0.9), 0), g(0.5));
  const flat = rcasPixel(g(0.4), g(0.4), g(0.4), g(0.4), g(0.4), 1).map((v) => Math.round(v * 1e6) / 1e6);
  assert.deepEqual(flat, g(0.4));
  // A soft edge: the centre between dark and bright moves away from its neighbours' mean.
  const e = rcasPixel(g(0.5), g(0.1), g(0.5), g(0.9), g(0.5), 1);
  const side = rcasPixel(g(0.3), g(0.1), g(0.3), g(0.5), g(0.3), 1);
  assert.ok(side[0] >= 0 && side[0] <= 1 && e[0] >= 0 && e[0] <= 1);
  const bright = rcasPixel(g(0.6), g(0.6), g(0.8), g(0.6), g(0.6), 1)[0];
  assert.ok(bright > 0.8 && bright <= 1, `${bright}`);
  assert.equal(sharpenFor(1), 0);
  assert.ok(sharpenFor(0.6) > sharpenFor(0.85));
  assert.ok(sharpenFor(0.3) <= 0.8);
});
