// Enhanced gore: the view when the player is badly hurt (docs/enhanced.md "Gore"). A post-stack
// stage before the grade (scene-linear HDR): the edges of the view darken towards a deep red-black
// with a ragged, slowly drifting rim, beating with a slow pulse at low health, plus a short flare
// on each blow. No drops on the lens, no full-screen red: it stays at the edges and fades as the
// player heals (hurtLevel).

import { float, length, mix, mx_noise_float, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { goreTime } from './decals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export const hurt = {
  /** 0 (healthy) .. 1 (near death): hurtLevel. */
  level: uniform(0) as N,
  /** A blow's flare, decaying. */
  pulse: uniform(0) as N,
};

/** Health fraction at which the edges start to close in. */
export const HURT_FROM = 0.4;

/** 0..1 from the player's health share (0 above HURT_FROM, 1 at 0). */
export function hurtLevel(health: number, maxHealth: number): number {
  const f = maxHealth > 0 ? Math.max(0, health) / maxHealth : 1;
  return Math.min(1, Math.max(0, (HURT_FROM - f) / HURT_FROM));
}

/** The stage hook ('beforeGrade'). */
export function hurtStage(color: N): N {
  const p: N = screenUV;
  const d: N = p.sub(0.5).mul(vec2(1.2, 1));
  const r: N = length(d);
  const n: N = mx_noise_float(vec3(p.mul(vec2(4.2, 2.6)), goreTime.mul(0.04)));
  const beat: N = goreTime.mul(Math.PI * 2 * 1.15).sin().mul(0.5).add(0.5).pow(4);
  const k: N = hurt.level.mul(float(0.75).add(beat.mul(0.25))).add(hurt.pulse.mul(0.6)).clamp(0, 1);
  // The rim closes in from 0.62 (a scratch) to 0.42 (near death) of the half diagonal.
  const inner: N = mix(float(0.62), float(0.4), hurt.level);
  const edge: N = smoothstep(inner, inner.add(0.38), r.add(n.mul(0.07))).mul(k);
  const tint: N = vec3(0.34, 0.035, 0.03);
  const rgb: N = mix(color.rgb, color.rgb.mul(tint), edge.mul(0.9)).mul(float(1).sub(hurt.level.mul(0.1)));
  return vec4(rgb, color.a);
}
