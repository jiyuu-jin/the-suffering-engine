// Enhanced mode "Auto" quality (docs/enhanced.md §Tiers): a starting tier from the WebGPU adapter
// (limits, features, a short GPU timing probe), then a governor that steps the tier down when the
// measured frame rate stays under the target and back up when there is headroom.

import * as THREE from 'three/webgpu';
import { Fn, Loop, float, sin, uv, vec4 } from 'three/tsl';
import { TIERS, WEBGL_MAX_TIER, capTier, stepTier, type QualityTier } from './config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface AdapterProbe {
  backend: 'WebGPU' | 'WebGL2';
  vendor: string;
  architecture: string;
  fallback: boolean;
  maxTexture2D: number;
  maxStorageBuffer: number;
  features: string[];
  /** Milliseconds per probe frame (lower is faster); -1 when not measured. */
  probeMs: number;
  /** Score points from limits / features (0..4). */
  score: number;
  tier: QualityTier;
}

/** Probe frames: a 1024² half-float target, a fixed ALU loop per pixel. */
const PROBE_SIZE = 1024;
const PROBE_FRAMES = 6;

/** Starting tier from adapter limits / features and the timing probe. Pure (tests). */
export function tierFromProbe(p: Pick<AdapterProbe, 'backend' | 'fallback' | 'score' | 'probeMs'>): QualityTier {
  if (p.fallback) return 'low';
  let t: QualityTier;
  // Calibrated on an Apple M-series GPU (≈ 2..4 ms here = High). Faster = higher.
  if (p.probeMs < 0) t = p.score >= 3 ? 'medium' : 'low';
  else if (p.probeMs <= 1.5) t = 'ultra';
  else if (p.probeMs <= 5) t = 'high';
  else if (p.probeMs <= 12) t = 'medium';
  else t = 'low';
  if (p.score <= 1) t = capTier(t, 'medium');
  return p.backend === 'WebGL2' ? capTier(t, WEBGL_MAX_TIER) : t;
}

export async function probeAdapter(renderer: THREE.WebGPURenderer, backend: 'WebGPU' | 'WebGL2'): Promise<AdapterProbe> {
  const out: AdapterProbe = { backend, vendor: '', architecture: '', fallback: false, maxTexture2D: 0, maxStorageBuffer: 0, features: [], probeMs: -1, score: 0, tier: 'low' };
  const device = (renderer.backend as { device?: GPUDevice }).device;
  if (device) {
    const l = device.limits;
    out.maxTexture2D = l.maxTextureDimension2D;
    out.maxStorageBuffer = l.maxStorageBufferBindingSize;
    out.features = [...device.features].map(String);
    try {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      const info = (adapter as unknown as { info?: GPUAdapterInfo })?.info;
      out.vendor = info?.vendor ?? '';
      out.architecture = info?.architecture ?? '';
      out.fallback = !!(adapter as unknown as { isFallbackAdapter?: boolean })?.isFallbackAdapter || !!(info as unknown as { isFallbackAdapter?: boolean })?.isFallbackAdapter;
    } catch {
      /* adapter info unavailable */
    }
    if (out.maxTexture2D >= 16384) out.score++;
    if (out.maxStorageBuffer >= 1 << 30) out.score++;
    if (out.features.includes('shader-f16')) out.score++;
    if (out.features.includes('timestamp-query') || out.features.includes('float32-filterable')) out.score++;
    out.probeMs = await timingProbe(renderer, device);
  }
  out.tier = tierFromProbe(out);
  return out;
}

/** GPU time of a fixed full-screen workload (ms per frame, best of PROBE_FRAMES). */
async function timingProbe(renderer: THREE.WebGPURenderer, device: GPUDevice): Promise<number> {
  const rt = new THREE.RenderTarget(PROBE_SIZE, PROBE_SIZE, { type: THREE.HalfFloatType, depthBuffer: false });
  const mat = new THREE.NodeMaterial();
  mat.fragmentNode = Fn(() => {
    const p = uv().toVar();
    const acc = float(0).toVar();
    Loop(96, ({ i }: { i: N }) => {
      acc.addAssign(sin(p.x.mul(float(i).add(1.3)).add(p.y.mul(7.1)).add(acc)));
    });
    return vec4(acc, p.x, p.y, 1);
  })();
  const quad = new THREE.QuadMesh(mat);
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(rt);
    quad.render(renderer); // compile + warm
    await device.queue.onSubmittedWorkDone();
    let best = Infinity;
    for (let i = 0; i < PROBE_FRAMES; i++) {
      const t0 = performance.now();
      quad.render(renderer);
      await device.queue.onSubmittedWorkDone();
      best = Math.min(best, performance.now() - t0);
    }
    return Math.round(best * 100) / 100;
  } catch {
    return -1;
  } finally {
    renderer.setRenderTarget(prev);
    rt.dispose();
    mat.dispose();
  }
}

/**
 * Progressive tier adjustment from measured frame times. Feed it every frame's interval; it
 * answers with a new tier when one is due. Drops quickly (two slow windows), raises slowly (three
 * fast windows with room under the frame budget) and remembers a raise that had to be undone.
 */
export class TierGovernor {
  /** Frames per second to hold (the display rate, or the frame cap). */
  target = 60;
  readonly windowMs = 1500;
  private acc = 0;
  private frames = 0;
  private busy = 0;
  private slow = 0;
  private fast = 0;
  private cooldownUntil = 0;
  /** A tier that could not be held, and until when it is not tried again. */
  private banned: { tier: QualityTier; until: number } | null = null;
  private lastRaiseAt = -1e9;
  log: string[] = [];

  constructor(
    public tier: QualityTier,
    public max: QualityTier = 'ultra',
  ) {}

  /**
   * One frame: `dtMs` since the last frame, `workMs` the CPU time the frame took (frame probe), `now`
   * performance.now(). Returns the tier to switch to, or null.
   */
  sample(dtMs: number, workMs: number, now: number): QualityTier | null {
    if (!(dtMs > 0) || dtMs > 500) return null;
    this.acc += dtMs;
    this.busy += workMs;
    this.frames++;
    if (this.acc < this.windowMs) return null;
    const fps = (this.frames * 1000) / this.acc;
    const busyShare = this.busy / this.acc;
    this.acc = this.busy = this.frames = 0;
    if (now < this.cooldownUntil) return null;
    if (fps < this.target * 0.85) {
      this.fast = 0;
      if (++this.slow >= 2 && this.tier !== 'low') {
        this.slow = 0;
        // A raise undone within 8 s: do not try that tier again for a minute.
        if (now - this.lastRaiseAt < 8000) this.banned = { tier: this.tier, until: now + 60_000 };
        return this.switch(stepTier(this.tier, -1), now, `fps ${fps.toFixed(1)} < ${(this.target * 0.85).toFixed(0)}`);
      }
      return null;
    }
    this.slow = 0;
    if (fps >= this.target * 0.97 && busyShare < 0.45) {
      if (++this.fast >= 3 && this.tier !== this.max) {
        this.fast = 0;
        const up = stepTier(this.tier, 1, this.max);
        if (this.banned && this.banned.tier === up && now < this.banned.until) return null;
        this.lastRaiseAt = now;
        return this.switch(up, now, `fps ${fps.toFixed(1)}, busy ${(busyShare * 100).toFixed(0)} %`);
      }
    } else this.fast = 0;
    return null;
  }

  private switch(t: QualityTier, now: number, why: string): QualityTier {
    this.log.push(`${(now / 1000).toFixed(1)} s ${this.tier} -> ${t} (${why})`);
    if (this.log.length > 40) this.log.shift();
    this.tier = t;
    this.cooldownUntil = now + 3000;
    return t;
  }
}

export { TIERS };
