// Frame-time work (docs/game-logic.md §18): the frame probe's statistics and the environment
// reverb's prepared convolvers (a zone change must not build an impulse response).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameProbe } from '../src/app/frame-probe';
import { EnvironmentReverb, reverbParams } from '../src/game/fx/reverb';
import type { AudioSystem } from '../src/app/audio';

test('frame probe: interval distribution, slow frames with their sections, skipped windows', () => {
  const p = new FrameProbe();
  let t = 1000;
  const frame = (dt: number, work?: string) => {
    t += dt;
    p.begin(t);
    if (work) p.note(work);
    p.lap('render');
    p.end();
  };
  for (let i = 0; i < 200; i++) frame(16.7);
  frame(120, 'spike');
  for (let i = 0; i < 99; i++) frame(16.7);
  const s = p.stats();
  assert.equal(s.frames, 299); // the first frame has no interval
  assert.equal(s.p50, 16.7);
  assert.equal(s.over50, 1);
  assert.equal(s.over33, 1);
  assert.equal(s.max, 120);
  assert.equal(p.slow.length, 1);
  assert.equal(p.slow[0].dt, 120);
  assert.equal(p.slow[0].note, 'spike');
  // A window around the spike (e.g. a test harness's own long task) leaves it out.
  const at = p.at[200];
  assert.equal(p.stats([[at - 1, at + 1]]).over50, 0);
  p.reset();
  assert.equal(p.stats().frames, 0);
  assert.equal(p.slow.length, 0);
});

/** Minimal Web Audio stand-in: counts convolver buffers set and tracks connections. */
function fakeAudio() {
  const built: string[] = [];
  class Node {
    out = new Set<Node>();
    connect(n: Node) {
      this.out.add(n);
      return n;
    }
    disconnect(n?: Node) {
      if (n) this.out.delete(n);
      else this.out.clear();
    }
  }
  class Gain extends Node {
    gain = { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
  }
  class Convolver extends Node {
    private b: unknown = null;
    get buffer() {
      return this.b;
    }
    set buffer(v: unknown) {
      built.push('buffer');
      this.b = v;
    }
  }
  const context = {
    sampleRate: 8000,
    currentTime: 0,
    createGain: () => new Gain(),
    createConvolver: () => new Convolver(),
    createBuffer: (ch: number, n: number) => {
      const data = Array.from({ length: ch }, () => new Float32Array(n));
      return { getChannelData: (c: number) => data[c] };
    },
  };
  const buses = { master: new Gain(), sfx: new Gain(), voice: new Gain() };
  const audio = { context, busNode: (b: keyof typeof buses) => buses[b] } as unknown as AudioSystem;
  return { audio, built, buses };
}

test('environment reverb: responses are built once per environment, only the current one is fed', () => {
  const { audio, built, buses } = fakeAudio();
  const r = new EnvironmentReverb(audio);
  const a = reverbParams('1:1', [0, 100, -1000, -100, 0, 0.5]);
  const b = reverbParams('1:2', [0, 100, -1000, -100, 0, 0.8]);
  const ca = r.prepare(a);
  r.prepare(b);
  assert.equal(built.length, 2);
  r.set(a, 1, 0, 0);
  // Zone changes back and forth: no new responses.
  for (let i = 0; i < 4; i++) {
    r.set(b, 1, 0, 0);
    r.set(a, 1, 0, 0);
  }
  assert.equal(built.length, 2);
  // The send of the sfx bus feeds exactly one convolver: the current environment's.
  const send = [...(buses.sfx as unknown as { out: Set<{ out: Set<unknown> }> }).out][0];
  assert.equal(send.out.size, 1);
  assert.ok(send.out.has(ca as unknown as { out: Set<unknown> }));
  assert.equal(r.environment.key, '1:1');
});
