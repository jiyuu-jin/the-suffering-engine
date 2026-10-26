// Enhanced graphics mode: entry point (docs/enhanced.md). Loaded by LevelRenderer.create only when
// the page runs in Enhanced mode (config.ts ENHANCED); Original mode never imports any of this.
//
//   shading.ts     engine-light hooks: per-pixel PBR flashlight, lamp specular / shadows, HDR, fog
//   lights.ts      per-frame light choice from the engine's own light rig + shared uniforms
//   shadows.ts     flashlight / lamp cube / moonlight shadow maps
//   volumetric.ts  ray-marched scattering in the level's fog (beam, halos, shafts, dust)
//   post.ts        the RenderPipeline: AO, volumetrics, TRAA, bloom, DOF, lens, horror grade
//   auto-tier.ts   Auto quality: adapter probe + frame-time governor
//   config.ts      mode / tier choice (URL, saved settings) and the per-tier feature table
//   maps/          texture enhancement: the generated cache's maps and upscaled albedo per tier
//   gore/          blood and gore: wet films, droplets, wounds, the hurt view (opt-in with Enhanced)

import * as THREE from 'three/webgpu';
import { GRAPHICS, TIERS, TIER_FEATURES, WEBGL_MAX_TIER, capTier, type QualityTier, type TierFeatures, type TierSetting } from './config';
import { installEnhancedShading } from './shading';
import { EU, enhancedLights } from './lights';
import { EnhancedShadows } from './shadows';
import { EnhancedTextureMaps } from './maps/runtime';
import { EnhancedGore } from './gore';
import { EnhancedPipeline, grade, type EnhancedStage, type EnhancedStageHook } from './post';
import { sharpenFor } from './sharpen';
import { TierGovernor, probeAdapter, type AdapterProbe } from './auto-tier';
import { engineLights } from '../engine-light';
import { updateLightVolumes } from './light-volume-pass';

/** The page was given `?tier=` (QA): the menu's saved tier does not override it. */
const URL_TIER = typeof location !== 'undefined' && new URLSearchParams(location.search).has('tier');

// Shading hooks first: materials are built from here on.
installEnhancedShading();

/** What the Enhanced renderer needs from LevelRenderer. */
export interface EnhancedHost {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly flashlight: THREE.SpotLight;
  readonly backend: 'WebGPU' | 'WebGL2';
  readonly viewmodelPass: { scene: THREE.Scene; camera: THREE.PerspectiveCamera };
  frameCap: number;
  /**
   * Render scale (src/app/render-scale.ts RenderScaler): its scale sets the sharpening (sharpen.ts);
   * Auto quality's tier steps wait for dynamic resolution.
   */
  readonly scaler?: { scale: number; cap: number; floor: number; readonly dynamic: boolean; setBudget(tier: QualityTier): void };
}

/** Something drawing screen effects over the scene (game/insanity/effects.ts ScreenEffects). */
interface ScreenEffectsLike {
  render(): void;
  blur?: number;
  vignette?: number;
  image?: { alpha: number };
}

export class EnhancedRenderer {
  readonly mode = 'enhanced' as const;
  /** The Quality setting (Auto or a fixed tier). */
  setting: TierSetting;
  /** The tier in use. */
  tier: QualityTier;
  features: TierFeatures;
  readonly maxTier: QualityTier;
  probe: AdapterProbe | null = null;
  private menuSeen: TierSetting | null = null;
  readonly governor: TierGovernor;
  readonly shadows = new EnhancedShadows();
  /** Generated texture maps (maps/runtime.ts, docs/enhanced.md "Texture enhancement"). */
  readonly maps = new EnhancedTextureMaps();
  readonly pipeline: EnhancedPipeline;
  /** Blood and gore (gore/index.ts, docs/enhanced.md "Gore"). */
  readonly gore: EnhancedGore;
  private lastDraw = -1;
  private frames = 0;
  private readonly clock = performance.now();
  stats = { drawMs: 0, tierChanges: 0 };
  /** Shared uniforms (QA / tuning from the console: `__enhanced.uniforms.grade.exposure.value`). */
  readonly uniforms = { lights: EU, grade };

  constructor(private readonly host: EnhancedHost) {
    this.maxTier = host.backend === 'WebGL2' ? WEBGL_MAX_TIER : 'ultra';
    this.setting = GRAPHICS.tier;
    this.tier = capTier(this.setting === 'auto' ? 'medium' : this.setting, this.maxTier);
    this.features = TIER_FEATURES[this.tier];
    this.governor = new TierGovernor(this.tier, this.maxTier);
    engineLights.perPixelFlashlight = true;
    // The viewmodel pass is composited by its coverage: it clears to transparent black.
    host.renderer.setClearAlpha(0);
    this.pipeline = new EnhancedPipeline(host.renderer, { scene: host.scene, camera: host.camera, viewmodelScene: host.viewmodelPass.scene, viewmodelCamera: host.viewmodelPass.camera });
    this.gore = new EnhancedGore(this);
    this.apply();
  }

  /** Probe the adapter (Auto's starting tier). */
  async init(): Promise<void> {
    if (this.setting !== 'auto') return;
    try {
      this.probe = await probeAdapter(this.host.renderer, this.host.backend);
      console.info(`[enhanced] adapter ${this.probe.vendor || '?'} ${this.probe.architecture || ''} score ${this.probe.score} probe ${this.probe.probeMs} ms -> ${this.probe.tier}`);
      this.setTier(this.probe.tier);
    } catch (err) {
      console.warn('[enhanced] adapter probe failed:', err);
    }
  }

  /** The Quality menu row (Auto or a tier). */
  setTierSetting(s: TierSetting) {
    // A `?tier=` URL override holds until the menu row is actually changed.
    if (URL_TIER) {
      if (this.menuSeen === null || this.menuSeen === s) {
        this.menuSeen = s;
        return;
      }
    }
    this.menuSeen = s;
    if (s === this.setting) return;
    this.setting = s;
    if (s === 'auto') this.governor.tier = this.tier;
    else this.setTier(s);
  }

  setTier(t: QualityTier) {
    t = capTier(t, this.maxTier);
    if (t === this.tier && this.pipeline.pipeline.outputNode) return;
    this.tier = t;
    this.governor.tier = t;
    this.stats.tierChanges++;
    this.apply();
  }

  private apply() {
    const f = (this.features = TIER_FEATURES[this.tier]);
    // The tier's pixel budget first. The RCAS pass is always in the chain (strength 0 at native:
    // the frame unchanged), so a change of the scale never rebuilds the pipeline.
    const sc = this.host.scaler;
    sc?.setBudget(this.tier);
    this.pipeline.sharpen = !!sc;
    this.shadows.configure(f);
    this.maps.setTier(this.tier);
    // Real shadow maps replace the engine's projected character shadows from High up.
    EU.projected.value = f.lampShadows > 0 ? 0.5 : 1;
    this.pipeline.build(f);
    console.info(`[enhanced] tier ${this.tier}${this.setting === 'auto' ? ' (auto)' : ''}`);
  }

  /** A post-stack stage hook (gore, decals, texture work: docs/enhanced.md "Extension points"). */
  addStage(stage: EnhancedStage, hook: EnhancedStageHook): () => void {
    return this.pipeline.addStage(stage, hook);
  }

  /**
   * Draw the frame (LevelRenderer.draw, after culling and the light rig): shadow maps, then the
   * pipeline to the canvas, or through the screen effects (which call renderInto for the scene).
   */
  draw(effects: ScreenEffectsLike | null) {
    const t0 = performance.now();
    const h = this.host;
    const time = (t0 - this.clock) / 1000;
    enhancedLights.update(h.camera, h.flashlight, this.features, time);
    updateLightVolumes(h.camera, time, this.frames++);
    this.shadows.render(h.renderer, h.scene, h.camera, this.features);
    grade.time.value = time;
    // Insanity: the screen effects' hallucination blur / vignette / flashes bend the lens.
    const fx = effects ? Math.min(1, (effects.blur ?? 0) * 1.4 + (effects.vignette ?? 0) * 0.6 + (effects.image?.alpha ?? 0) * 0.5) : 0;
    grade.insanity.value += (fx - grade.insanity.value) * 0.15;
    const sc = h.scaler;
    if (sc) grade.sharpen.value = sharpenFor(sc.scale);
    if (effects) effects.render();
    else {
      grade.encode.value = 1;
      this.pipeline.render();
    }
    const now = performance.now();
    this.stats.drawMs = now - t0;
    if (this.setting === 'auto' && this.lastDraw > 0) {
      this.governor.target = h.frameCap > 0 ? h.frameCap : 60;
      let next = this.governor.sample(now - this.lastDraw, now - t0, now);
      // Dynamic resolution acts first: a tier down only once it is at its floor, up at its cap.
      if (next && sc?.dynamic && (TIERS.indexOf(next) < TIERS.indexOf(this.tier) ? sc.scale > sc.floor + 1e-3 : sc.scale < sc.cap - 1e-3)) {
        this.governor.tier = this.tier;
        next = null;
      }
      if (next && next !== this.tier) {
        console.info(`[enhanced] auto: ${this.governor.log[this.governor.log.length - 1]}`);
        this.setTier(next);
      }
    }
    this.lastDraw = now;
  }

  /** The Enhanced scene (graded, linear) into the current render target: the screen effects' scene pass. */
  renderInto() {
    grade.encode.value = 0;
    this.pipeline.render();
    grade.encode.value = 1;
  }
}

export async function createEnhanced(host: EnhancedHost): Promise<EnhancedRenderer> {
  const e = new EnhancedRenderer(host);
  await e.init();
  if (typeof window !== 'undefined') Object.assign(window, { __enhanced: e });
  return e;
}
