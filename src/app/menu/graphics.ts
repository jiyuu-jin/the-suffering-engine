// Graphics options (GUI Graphics #888 rows, stored as `x.<row id>` in Settings.extra) applied
// to the renderer:
//   vsync          0 Yes / 1 No: stored only. Browsers always present in sync with the
//                  display (requestAnimationFrame); the engine's frame cap row limits the rate.
//   resolution     render scale of the window size (RESOLUTION_SCALES), via the pixel ratio.
//   pixelShaders   0 Yes / 1 No: post effects on/off (LevelRenderer.postEffects, the insanity
//                  screen effects).
//   gamma          0.5..1.5: a gamma ramp (SVG feComponentTransfer) on the game view and the
//                  front end; 1 = no filter.
//   shadows        0 All Characters / 1 Player Only / 2 Off: the engine's projected character
//                  shadows from the flashlight (engine-light.ts renderShadows, docs/re/renderer.md
//                  §4), drawn without three.js shadow maps (those broke three r186's WebGPU
//                  backend when skinned casters were created / disposed).
//   textureFiltering 0 Off (point) / 1 Bilinear / 2 Trilinear (+ anisotropy) on level textures.
//   frameCap       engine addition: 0 off, 30, 60 fps (LevelRenderer.frameCap).
// Use Defaults restores GRAPHICS_DEFAULTS.

import type { Settings } from './settings';
import { engineLights } from '../engine-light';
import { ShadowMode } from '../../formats/render-data';

export const GRAPHICS_DEFAULTS: Record<string, number> = {
  vsync: 0,
  resolution: 1,
  pixelShaders: 0,
  gamma: 1,
  shadows: 0,
  textureFiltering: 2,
  frameCap: 0,
};

/** The parts of LevelRenderer the options touch (see renderer.ts graphics hooks). */
export interface GraphicsView {
  readonly renderer: { setPixelRatio(r: number): void };
  postEffects: boolean;
  frameCap: number;
  textureFilter: 'off' | 'bilinear' | 'trilinear';
  setTextureFiltering(mode: 'off' | 'bilinear' | 'trilinear'): void;
}

export function graphicsValue(s: Settings, id: string): number {
  const v = s.extra[id];
  return typeof v === 'number' ? v : GRAPHICS_DEFAULTS[id];
}

export function resetGraphics(s: Settings): void {
  for (const [k, v] of Object.entries(GRAPHICS_DEFAULTS)) s.extra[k] = v;
}

const FILTERS = ['off', 'bilinear', 'trilinear'] as const;
const GAMMA_ID = 'suffering-gamma';
const GAMMA_TARGETS = ['#viewport', '#frontend'];

/** Applies every graphics option (cheap when nothing changed). */
export function applyGraphics(s: Settings, view: GraphicsView | undefined): void {
  applyGamma(graphicsValue(s, 'gamma'));
  // 0x5c6d00: 3 all characters, 1 player only, 0 off.
  engineLights.shadowMode = [ShadowMode.All, ShadowMode.PlayerOnly, ShadowMode.Off][graphicsValue(s, 'shadows')] ?? ShadowMode.Off;
  if (!view) return;
  const scale = graphicsValue(s, 'resolution');
  const ratio = Math.min(window.devicePixelRatio || 1, 2) * Math.max(0.25, Math.min(1, scale));
  if (Math.abs(ratio - currentRatio) > 1e-3) {
    currentRatio = ratio;
    view.renderer.setPixelRatio(ratio);
  }
  view.postEffects = graphicsValue(s, 'pixelShaders') === 0;
  view.frameCap = graphicsValue(s, 'frameCap');
  const filter = FILTERS[graphicsValue(s, 'textureFiltering')] ?? 'trilinear';
  if (filter !== view.textureFilter) view.setTextureFiltering(filter);
}

let currentRatio = 0;

function applyGamma(gamma: number): void {
  const g = Math.max(0.3, Math.min(3, gamma || 1));
  let svg = document.getElementById(GAMMA_ID + '-svg');
  if (Math.abs(g - 1) < 1e-3) {
    for (const sel of GAMMA_TARGETS) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.style.filter.includes(GAMMA_ID)) el.style.filter = '';
    }
    return;
  }
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as HTMLElement;
    svg.id = GAMMA_ID + '-svg';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `<filter id="${GAMMA_ID}" color-interpolation-filters="sRGB"><feComponentTransfer>${['R', 'G', 'B']
      .map((c) => `<feFunc${c} type="gamma" amplitude="1" exponent="1" offset="0"/>`)
      .join('')}</feComponentTransfer></filter>`;
    document.body.append(svg);
  }
  for (const f of svg.querySelectorAll('feFuncR, feFuncG, feFuncB')) f.setAttribute('exponent', (1 / g).toFixed(3));
  for (const sel of GAMMA_TARGETS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && !el.style.filter.includes(GAMMA_ID)) el.style.filter = `url(#${GAMMA_ID})`;
  }
}
