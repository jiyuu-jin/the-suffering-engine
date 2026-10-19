// Environment reverb ("Environment FX" audio option; docs/game-logic.md §17.5).
//
// Reverb Effect Template (EXE class 0xf7bb7912, category Sound Effect). Its p1..p13 line up,
// name for name and type for type, with the EXE's sound debug menu strings
// ("Reverb Depth", "Room", "RoomHF", "Room Rolloff", "Decay Time", "Decay HF Ratio",
// "Reflections", "Reflections Delay", "Reverb", "Reverb Delay", "Diffusion", "Density",
// "HF Reference") - the I3DL2 / EAX 2 listener parameters [strong]:
//   p0 environment preset id, p1 depth (%), p2 Room (mB), p3 RoomHF (mB), p4 room rolloff,
//   p5 decay time (s), p6 decay HF ratio, p7 Reflections (mB), p8 reflections delay (s),
//   p9 Reverb (mB), p10 reverb delay (s), p11 diffusion (%), p12 density (%), p13 HF reference (Hz),
//   p14..p17 unknown.
// Who sets it: Level Properties p27 / p28 (the level's environment and depth %), Ambient Sound
// zones (p9 / p10 and p14 / p15, see ambient.ts).
//
// Port: Web Audio has no EAX, so each environment becomes a generated impulse response
// (inferred): early reflections (a few taps between the reflections delay and the reverb delay
// at the Reflections level) and a late tail of decaying noise with a 60 dB decay of Decay Time
// below HF Reference and Decay Time x Decay HF Ratio above it, scaled by RoomHF; the wet level is
// Room x depth. The convolver is fed from the sfx and voice buses (music stays dry) and returns
// into the master bus. Changing environment fades the wet level out, swaps the response and fades
// it back in (every zone's response is built at level load, see EnvironmentReverb.prepare).
// The "Environment FX" audio option (menu row 'x.environmentFx', choice 1 = Off)
// mutes the wet path.

import type { AudioSystem } from '../../app/audio';
import type { PropValue } from '../../formats/entities';

export interface ReverbParams {
  key: string;
  room: number;
  roomHF: number;
  decay: number;
  hfRatio: number;
  reflections: number;
  reflectionsDelay: number;
  reverb: number;
  reverbDelay: number;
  diffusion: number;
  hfReference: number;
}

const int = (v: PropValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? (v > 0x7fffffff ? v - 0x100000000 : v) : d);
const flt = (v: PropValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const mB = (x: number) => Math.pow(10, Math.max(-10000, Math.min(1000, x)) / 2000);

export function reverbParams(key: string, v: PropValue[]): ReverbParams {
  return {
    key,
    room: int(v[2], -1000),
    roomHF: int(v[3], -100),
    decay: Math.max(0.1, Math.min(20, flt(v[5], 1.5))),
    hfRatio: Math.max(0.1, Math.min(2, flt(v[6], 0.8))),
    reflections: int(v[7], -1000),
    reflectionsDelay: Math.max(0, Math.min(0.3, flt(v[8], 0.02))),
    reverb: int(v[9], -500),
    reverbDelay: Math.max(0, Math.min(0.1, flt(v[10], 0.03))),
    diffusion: Math.max(0, Math.min(100, flt(v[11], 100))),
    hfReference: Math.max(1000, Math.min(20000, flt(v[13], 5000))),
  };
}

/** Stereo impulse response for an environment (deterministic per key). */
export function impulseResponse(ctx: BaseAudioContext, p: ReverbParams): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.min(6, p.decay * 1.1 + p.reflectionsDelay + p.reverbDelay + 0.05);
  const n = Math.max(1, Math.floor(len * sr));
  const buf = ctx.createBuffer(2, n, sr);
  let seed = 0;
  for (const ch of p.key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const refl = mB(p.reflections), late = mB(p.reverb), hfLevel = mB(p.roomHF);
  const lateStart = p.reflectionsDelay + p.reverbDelay;
  const kLow = 6.91 / p.decay, kHigh = 6.91 / (p.decay * p.hfRatio);
  // One-pole low-pass at the HF reference splits the noise into two bands.
  const a = Math.exp((-2 * Math.PI * p.hfReference) / sr);
  // Diffusion: fewer, sparser early taps when low.
  const taps = Math.round(4 + (p.diffusion / 100) * 8);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (t < lateStart) continue;
      const x = rand();
      lp = (1 - a) * x + a * lp;
      const hp = x - lp;
      const tt = t - lateStart;
      // Short fade-in so the tail does not start with a click.
      const onset = Math.min(1, tt / 0.01);
      d[i] = late * onset * (lp * Math.exp(-kLow * tt) + hfLevel * hp * Math.exp(-kHigh * tt));
    }
    for (let k = 0; k < taps; k++) {
      const t = p.reflectionsDelay + (k / taps) * Math.max(0.005, p.reverbDelay + 0.01) + Math.abs(rand()) * 0.004;
      const i = Math.floor(t * sr);
      if (i < n) d[i] += refl * (rand() < 0 ? -1 : 1) * (0.9 - 0.5 * (k / taps));
    }
  }
  return buf;
}

export class EnvironmentReverb {
  /**
   * One convolver per environment, its response set once (prepare()): setting a ConvolverNode's
   * buffer prepares the FFT kernels on the main thread (~15 ms) and generating the response
   * takes about as long, which hitched the frame on every zone change (docs/game-logic.md §18).
   * Only the current environment's convolver is fed (sends -> convolver -> wet).
   */
  private readonly convolvers = new Map<string, ConvolverNode>();
  private active?: ConvolverNode;
  private readonly wet: GainNode;
  private readonly sends: GainNode[] = [];
  private current?: string;
  private level = 0;
  private enabled = true;
  private pending?: ReturnType<typeof setTimeout>;
  /** Log of environment changes (tests / overlay). */
  readonly log: { t: number; key: string | null; depth: number }[] = [];

  constructor(private readonly audio: AudioSystem) {
    const ctx = audio.context;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.wet.connect(audio.busNode('master'));
    for (const bus of ['sfx', 'voice'] as const) {
      const s = ctx.createGain();
      s.gain.value = 1;
      audio.busNode(bus).connect(s);
      this.sends.push(s);
    }
  }

  /** Builds an environment's convolver ahead of use (level load: every zone's environment). */
  prepare(p: ReverbParams): ConvolverNode {
    this.params.set(p.key, p);
    let c = this.convolvers.get(p.key);
    if (!c) {
      c = this.audio.context.createConvolver();
      c.buffer = impulseResponse(this.audio.context, p);
      c.connect(this.wet);
      this.convolvers.set(p.key, c);
    }
    return c;
  }

  private feed(c: ConvolverNode) {
    if (this.active === c) return;
    for (const s of this.sends) {
      if (this.active) s.disconnect(this.active);
      s.connect(c);
    }
    this.active = c;
  }

  get environment() {
    return { key: this.current ?? null, depth: this.level, enabled: this.enabled };
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.ramp(on ? this.target() : 0, 0.3);
  }

  private target() {
    const p = this.current ? this.params.get(this.current) : undefined;
    return p ? Math.min(1.5, mB(p.room) * this.level * 2) : 0;
  }

  private params = new Map<string, ReverbParams>();

  private ramp(v: number, secs: number) {
    const g = this.wet.gain, t = this.audio.context.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.enabled ? v : 0, t + Math.max(0.02, secs));
  }

  /**
   * Switch to an environment (null = dry). depth is 0..1 (template % / 100). fadeOut / fadeIn
   * are the zone's transition times (s).
   */
  set(p: ReverbParams | null, depth: number, fadeOut = 0.5, fadeIn = 0.5) {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.log.push({ t: this.audio.context.currentTime, key: p?.key ?? null, depth });
    if (!p) {
      this.current = undefined;
      this.ramp(0, fadeOut);
      return;
    }
    this.params.set(p.key, p);
    if (p.key === this.current) {
      this.level = depth;
      this.ramp(this.target(), fadeIn);
      return;
    }
    const swap = () => {
      this.feed(this.prepare(p));
      this.current = p.key;
      this.level = depth;
      this.ramp(this.target(), fadeIn);
    };
    if (!this.current || this.wet.gain.value < 1e-3) swap();
    else {
      this.ramp(0, fadeOut);
      this.pending = setTimeout(swap, Math.max(20, fadeOut * 1000));
    }
  }

  dispose() {
    if (this.pending) clearTimeout(this.pending);
    try {
      for (const s of this.sends) s.disconnect();
      for (const c of this.convolvers.values()) c.disconnect();
      this.wet.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}
