// Contrast-adaptive sharpening for a reduced render scale (src/app/render-scale.ts): AMD FidelityFX
// FSR 1's RCAS ("robust contrast-adaptive sharpening", MIT licence), written in TSL from its
// published formula. The frame is drawn at the internal resolution and the browser's compositor
// scales the canvas up (bilinear); sharpening the graded frame first gives back the edge contrast
// the upscale softens. Strength 0 returns the input unchanged.
//
// Per channel over the 5-tap cross b (up), d (left), e (centre), f (right), h (down):
//   lobe = max(-hitMin, hitMax), hitMin = min(mn4, e) / (4 mx4), hitMax = (1 - max(mx4, e)) / (4 mn4 - 4)
//   w    = clamp(max over the channels of lobe, -(1/4 - 1/16), 0) × strength
//   out  = (w (b + d + f + h) + e) / (4 w + 1)
// The limit keeps the kernel from inverting; the lobe is the largest negative weight that cannot
// push any channel of the neighbourhood out of [0, 1] (no halos, no clipping).

import { Fn, float, max, min, screenSize, uv, vec2, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** FSR 1 RCAS limit: 1/4 - 1/16. */
export const RCAS_LIMIT = 0.25 - 1 / 16;

/** Sharpening strength for a render scale (0 at native; the compositor's upscale is 1 / scale). */
export function sharpenFor(scale: number): number {
  return Math.min(0.8, Math.max(0, (1 - scale) * 2));
}

/** Reference RCAS of one pixel (tests): channels in [0, 1]; returns the sharpened centre. */
export function rcasPixel(b: number[], d: number[], e: number[], f: number[], h: number[], strength: number): number[] {
  let lobe = -Infinity;
  for (let i = 0; i < e.length; i++) {
    const mn4 = Math.min(b[i], d[i], f[i], h[i]), mx4 = Math.max(b[i], d[i], f[i], h[i]);
    const hitMin = Math.min(mn4, e[i]) / Math.max(4 * mx4, 1e-4);
    const hitMax = (1 - Math.max(mx4, e[i])) / Math.min(4 * mn4 - 4, -1e-4);
    lobe = Math.max(lobe, Math.max(-hitMin, hitMax));
  }
  const w = Math.max(-RCAS_LIMIT, Math.min(lobe, 0)) * strength;
  return e.map((c, i) => (w * (b[i] + d[i] + f[i] + h[i]) + c) / (4 * w + 1));
}

/** RCAS over `src` (a texture node at the output size), strength `amount` (a uniform, 0..1). */
export function rcas(src: N, amount: N): N {
  return Fn(() => {
    const p = uv();
    const t = vec2(1).div(screenSize);
    const e: N = src.sample(p).toVar();
    const b: N = src.sample(p.add(vec2(0, t.y.negate()))).rgb;
    const d: N = src.sample(p.add(vec2(t.x.negate(), 0))).rgb;
    const f: N = src.sample(p.add(vec2(t.x, 0))).rgb;
    const h: N = src.sample(p.add(vec2(0, t.y))).rgb;
    const c: N = e.rgb.clamp(0, 1);
    const mn4: N = min(min(b, d), min(f, h)).clamp(0, 1);
    const mx4: N = max(max(b, d), max(f, h)).clamp(0, 1);
    const hitMin: N = min(mn4, c).div(mx4.mul(4).max(1e-4));
    const hitMax: N = float(1).sub(max(mx4, c)).div(mn4.mul(4).sub(4).min(-1e-4));
    const l: N = max(hitMin.negate(), hitMax);
    const w: N = max(l.x, max(l.y, l.z)).min(0).max(-RCAS_LIMIT).mul(amount);
    const out: N = w.mul(b.add(d).add(f).add(h)).add(c).div(w.mul(4).add(1));
    return vec4(out, e.a);
  })();
}
