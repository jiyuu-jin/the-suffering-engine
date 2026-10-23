// Enhanced mode post stack (docs/enhanced.md §Post stack), a three/webgpu RenderPipeline built per
// quality tier:
//
//   scene pass (HDR half float; MRT colour + velocity; MSAA, or TRAA jitter)
//     × GTAO                                 (ambient occlusion from depth)
//     + volumetric light                     (volumetric.ts: flashlight beam, lamp halos, moonlight)
//     → TRAA                                 (temporal AA: also resolves the AO / volumetric noise)
//     + first-person viewmodel pass          (arms and weapon, MSAA, composited over)
//     + bloom                                (lamps, fire, arcs, the flashlight's hot spot)
//     → soft focus                           (Ultra: a slight blur away from the focus distance)
//     → lens (insanity: barrel distortion; chromatic aberration at the edges)
//     → horror grade: exposure, desaturation, cold shadows / sickly warm lamps, AgX filmic
//       tone map, vignette, film grain
//     → sRGB to the canvas (or linear into the insanity screen effects' scene target)
//
// Extension points (later work: gore, decals, texture enhancement): `stages` hooks let another
// module insert a node at a named point of the chain (see EnhancedStageHook).

import * as THREE from 'three/webgpu';
import {
  Fn,
  convertToTexture,
  dot,
  float,
  interleavedGradientNoise,
  length,
  mix,
  mrt,
  output,
  pass,
  screenCoordinate,
  screenSize,
  smoothstep,
  sRGBTransferEOTF,
  sRGBTransferOETF,
  max,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { TierFeatures } from './config';
import { warmPasses, type WarmPass } from '../prewarm';
import { VolumetricNode } from './volumetric';
import { TONE } from './tone';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Named points of the chain where another module may insert a node (docs/enhanced.md). */
export type EnhancedStage = 'sceneHDR' | 'beforeBloom' | 'beforeGrade' | 'final';
/** Receives the chain's colour node at a stage and returns the (possibly) modified one. */
export type EnhancedStageHook = (color: N, ctx: { depth: N; camera: THREE.Camera; features: TierFeatures }) => N;

/** Grade / lens parameters (uniforms: no rebuild). Defaults: tone.ts TONE. */
export const grade = {
  exposure: uniform(TONE.exposure),
  saturation: uniform(TONE.saturation),
  /** Shadow tint (cold) and highlight tint (sickly warm), multiplied in linear light at unit luminance. */
  shadowTint: uniform(new THREE.Vector3(0.86, 0.96, 1.12)),
  highlightTint: uniform(new THREE.Vector3(1.08, 1.02, 0.84)),
  /** Tone curve (tone.ts toneCurve): linear to `knee`, shoulder to 1; whitening between whiteStart / whiteEnd. */
  knee: uniform(TONE.knee),
  whiteStart: uniform(TONE.whiteStart),
  whiteEnd: uniform(TONE.whiteEnd),
  /** Black level lift (cold), display space. */
  lift: uniform(new THREE.Vector3(0.004, 0.006, 0.011)),
  /** Display-space power about `pivot`. */
  contrast: uniform(TONE.contrast),
  pivot: uniform(TONE.pivot),
  vignette: uniform(0.3),
  grain: uniform(0.035),
  aberration: uniform(0.0025),
  /** Insanity 0..1: barrel distortion and more aberration. */
  insanity: uniform(0),
  bloomStrength: uniform(TONE.bloomStrength),
  /** Scene-linear luminance above which energy blooms (lamps, fire, glow marks; not diffuse white). */
  bloomThreshold: uniform(TONE.bloomThreshold),
  /** GTAO share multiplied in. */
  ao: uniform(TONE.ao),
  /** 1: encode sRGB (canvas); 0: linear (the insanity effects' scene target). */
  encode: uniform(1),
  time: uniform(0),
};

const LUMA = vec3(0.2126, 0.7152, 0.0722);

export interface PipelineParts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  viewmodelScene: THREE.Scene;
  viewmodelCamera: THREE.PerspectiveCamera;
}

export class EnhancedPipeline {
  readonly pipeline: THREE.RenderPipeline;
  readonly stages = new Map<EnhancedStage, EnhancedStageHook[]>();
  volumetric: VolumetricNode | null = null;
  /** QA: show one buffer instead of the graded frame ('scene', 'ao', 'volumetric', 'hdr'); null = off. */
  debugView: string | null = null;
  private features: TierFeatures | null = null;
  private disposables: { dispose(): void }[] = [];

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly parts: PipelineParts,
  ) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
  }

  /** Insert a node at a stage (rebuilds the chain). Returns the remover. */
  addStage(stage: EnhancedStage, hook: EnhancedStageHook): () => void {
    let list = this.stages.get(stage);
    if (!list) this.stages.set(stage, (list = []));
    list.push(hook);
    if (this.features) this.build(this.features);
    return () => {
      const l = this.stages.get(stage);
      const i = l?.indexOf(hook) ?? -1;
      if (l && i >= 0) l.splice(i, 1);
      if (this.features) this.build(this.features);
    };
  }

  /** (Re)build the chain for a tier. */
  build(f: TierFeatures) {
    this.features = f;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    const { scene, camera, viewmodelScene, viewmodelCamera } = this.parts;
    const useTraa = f.aa === 'traa';
    // No MSAA: AO, volumetrics and TRAA read the depth texture (FXAA on the lower tiers).
    const scenePass = pass(scene, camera, { samples: 0 });
    scenePass.setResolutionScale(f.renderScale);
    const sceneMRT = useTraa ? mrt({ output, velocity }) : null;
    if (sceneMRT) scenePass.setMRT(sceneMRT);
    this.disposables.push(scenePass);
    const color: N = scenePass.getTextureNode('output');
    const depth: N = scenePass.getTextureNode('depth');
    const ctx = { depth, camera, features: f };
    const run = (stage: EnhancedStage, c: N): N => {
      for (const h of this.stages.get(stage) ?? []) c = h(c, ctx);
      return c;
    };

    let c: N = run('sceneHDR', color);
    let aoTex: N = null;
    if (f.aoSamples > 0) {
      const aoNode = (ao as N)(depth, null, camera);
      aoNode.resolutionScale = f.aoScale;
      aoNode.samples.value = f.aoSamples;
      aoNode.radius.value = 0.6;
      aoNode.thickness.value = 0.8;
      aoNode.useTemporalFiltering = useTraa;
      this.disposables.push(aoNode);
      const occl: N = aoNode.getTextureNode().r;
      aoTex = occl;
      // (Half strength: the baked light already carries its contact darkening.)
      c = vec4(c.rgb.mul(mix(float(1), occl, grade.ao)), c.a);
    }
    this.volumetric = null;
    if (f.volumetricSteps > 0) {
      const vol = new VolumetricNode(depth, camera);
      vol.steps = f.volumetricSteps;
      vol.resolutionScale = f.volumetricScale * f.renderScale;
      this.volumetric = vol;
      this.disposables.push(vol);
      c = vec4(c.rgb.add(vol.getTextureNode().rgb), c.a);
    }
    if (useTraa) {
      const t = traa(c, depth, scenePass.getTextureNode('velocity'), camera);
      this.disposables.push(t);
      c = t;
    }
    // First-person viewmodel over the world, by its coverage (an MRT target the clear leaves black
    // and every drawn fragment writes white; MSAA resolves it to the edge coverage).
    const vmPass = pass(viewmodelScene, viewmodelCamera, { samples: 4 });
    const vmMRT = mrt({ output, cover: vec4(1, 1, 1, 1) });
    vmPass.setMRT(vmMRT);
    vmPass.setResolutionScale(f.renderScale);
    this.disposables.push(vmPass);
    const vm: N = vmPass.getTextureNode('output');
    const cover: N = vmPass.getTextureNode('cover').r.clamp(0, 1);
    // Precompile (prewarm.ts): the scene and viewmodel are drawn into these passes' targets, not
    // the canvas, so their pipelines (attachments, MRT outputs) are built for them at load, and
    // zones first seen in play do not compile on sight. (The colour and velocity / coverage
    // textures exist now: the texture nodes above asked for them.)
    // (PassNode sets its target's sample count only in its first setup: set here for the precompile.)
    scenePass.renderTarget.samples = 0;
    vmPass.renderTarget.samples = 4;
    this.warm(scenePass.renderTarget, sceneMRT, vmPass.renderTarget, vmMRT);
    c = (vec4 as N)((mix as N)(c.rgb, vm.rgb.div(cover.max(1e-3)), cover), 1);

    c = run('beforeBloom', c);
    if (f.bloom) {
      // Only the energy above the threshold blooms (hue kept): lamps, fire, glow-marked emitters,
      // the flashlight's hot spot up close. A bright albedo under its light stays a surface.
      const lum = dot(c.rgb, LUMA);
      const excess = c.rgb.mul(lum.sub(grade.bloomThreshold).max(0).div(lum.max(1e-4)));
      const b = bloom(vec4(excess, 1), 1, 0.55, 0);
      b.strength = grade.bloomStrength;
      this.disposables.push(b);
      c = c.add(b);
    }
    if (f.dof) {
      const src: N = convertToTexture(c);
      this.disposables.push(src);
      c = softFocus(src, scenePass.getViewZNode());
    }
    c = run('beforeGrade', c);
    const hdr: N = convertToTexture(c);
    this.disposables.push(hdr);
    let out: N = gradeNode(hdr);
    const dbg = this.debugView;
    if (dbg === 'scene') out = vec4((sRGBTransferOETF as N)(color.rgb.clamp(0, 1)), 1);
    else if (dbg === 'hdr') out = vec4((sRGBTransferOETF as N)(hdr.rgb.clamp(0, 1)), 1);
    else if (dbg === 'volumetric' && this.volumetric) out = vec4((sRGBTransferOETF as N)(this.volumetric.getTextureNode().rgb.mul(4).clamp(0, 1)), 1);
    else if (dbg === 'ao' && aoTex) out = vec4(vec3(aoTex), 1);
    else if (dbg === 'vm') out = vec4(cover, vm.rgb.r, 0, 1);
    if (f.aa === 'fxaa') {
      const fx = fxaa(out);
      this.disposables.push(fx);
      out = fx;
    }
    out = run('final', out);
    this.pipeline.outputNode = out;
    this.pipeline.needsUpdate = true;
  }

  render() {
    this.pipeline.render();
  }

  private warmed: WarmPass[] = [];
  /** Register the passes for the pipeline precompile (prewarm.ts warmPasses), replacing the last build's. */
  private warm(sceneRT: THREE.RenderTarget, sceneMRT: THREE.MRTNode | null, vmRT: THREE.RenderTarget, vmMRT: THREE.MRTNode) {
    this.unwarm();
    const probe = () => this.probe();
    this.warmed = [
      { target: sceneRT, mrt: sceneMRT, viewmodel: false, depth: -1, probe },
      { target: vmRT, mrt: vmMRT, viewmodel: true, depth: -1, probe },
    ];
    for (const p of this.warmed) warmPasses.add(p);
  }

  /**
   * Draw the chain once with nothing in view (the cameras on no layer): records the render-call
   * depth of the scene and viewmodel passes for the precompile (prewarm.ts WarmPass.depth) and
   * builds the post passes' own pipelines (AO, volumetrics, TRAA, bloom, grade) behind the
   * loading screen.
   */
  probe() {
    const rc = (this.renderer as unknown as { _renderContexts: { get(t: unknown, m: unknown, d?: number): unknown } })._renderContexts;
    const ownGet = Object.prototype.hasOwnProperty.call(rc, 'get');
    const get = rc.get;
    const want = new Map(this.warmed.map((p) => [p.target as unknown, p]));
    rc.get = (t, m, d = 0) => {
      const p = want.get(t);
      if (p && p.depth < 0) p.depth = d;
      return get.call(rc, t, m, d);
    };
    const { camera, viewmodelCamera } = this.parts;
    const masks = [camera.layers.mask, viewmodelCamera.layers.mask];
    camera.layers.mask = viewmodelCamera.layers.mask = 0;
    try {
      this.pipeline.render();
    } finally {
      if (ownGet) rc.get = get;
      else delete (rc as { get?: unknown }).get;
      [camera.layers.mask, viewmodelCamera.layers.mask] = masks;
    }
  }
  private unwarm() {
    for (const p of this.warmed) warmPasses.delete(p);
    this.warmed = [];
  }

  dispose() {
    this.unwarm();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.pipeline.dispose();
  }
}

/**
 * Lens + grade + tone map + grain, from the HDR frame (a texture node, sampled per channel for the
 * aberration and the insanity distortion).
 */
function gradeNode(hdr: N): N {
  return Fn(() => {
    const p = uv();
    const d = p.sub(0.5);
    const r2 = dot(d, d);
    // Barrel distortion while insane; chromatic aberration growing towards the edges.
    const k = grade.insanity.mul(0.22);
    const pd = vec2(0.5).add(d.mul(float(1).add(k.mul(r2))).div(float(1).add(k.mul(0.25))));
    const ca = d.mul(r2.mul(grade.aberration.add(grade.insanity.mul(0.012))));
    const rgb: N = vec3(hdr.sample(pd.add(ca)).r, hdr.sample(pd).g, hdr.sample(pd.sub(ca)).b).max(0).toVar();
    // Exposure, saturation, split tone (in linear light, before the tone map). The tints are
    // normalised to unit luminance: they shift hue, they do not darken.
    rgb.mulAssign(grade.exposure);
    const luma = dot(rgb, LUMA);
    rgb.assign(mix(vec3(luma), rgb, grade.saturation).max(0));
    const t = smoothstep(0.02, 0.5, luma.pow(0.45));
    const tint: N = mix(grade.shadowTint as N, grade.highlightTint as N, t);
    rgb.mulAssign(tint.div(dot(tint, LUMA)));
    // Tone curve on the brightest channel (tone.ts toneCurve), so hue survives: linear in the
    // darks (they read as in the original), an exponential shoulder above the knee; only hot
    // sources (far above diffuse white) whiten.
    const m = max(rgb.r, max(rgb.g, rgb.b)).max(1e-5);
    const kn = grade.knee;
    const over = m.sub(kn).max(0);
    const fm = m.min(kn).add(float(1).sub(kn).mul(float(1).sub(over.div(float(1).sub(kn)).negate().exp())));
    const mapped: N = rgb.mul(fm.div(m)).toVar();
    mapped.assign(mix(mapped, vec3(fm), smoothstep(grade.whiteStart, grade.whiteEnd, m).mul(0.9)));
    // Display space: contrast as a power about the pivot (black stays black), cold black lift.
    const enc: N = (sRGBTransferOETF as N)(mapped.clamp(0, 1)).toVar();
    enc.assign(grade.pivot.mul(enc.div(grade.pivot).pow(grade.contrast)).min(1));
    enc.assign(enc.mul(vec3(1).sub(grade.lift as N)).add(grade.lift as N));
    // Vignette (stronger while insane).
    const vig = smoothstep(0.25, 0.95, length(d).mul(1.35)).mul(grade.vignette.add(grade.insanity.mul(0.3)));
    enc.mulAssign(float(1).sub(vig));
    // Film grain: strongest in the mid tones, changing every frame.
    const n = interleavedGradientNoise(screenCoordinate.xy.add(grade.time.mul(97.31).fract().mul(173))).sub(0.5);
    const l2 = dot(enc, LUMA);
    enc.addAssign(n.mul(grade.grain).mul(float(1).sub(l2.mul(0.7)).max(0.15)).mul(smoothstep(0, 0.08, l2).max(0.3)));
    const out = enc.clamp(0, 1);
    return (vec4 as N)(mix((sRGBTransferEOTF as N)(out), out, grade.encode), 1);
  })();
}

/** Soft focus (Ultra): focus distance and the range (m) over which the blur grows; blur radius (px). */
export const focus = { distance: uniform(6), range: uniform(4), radius: uniform(2.4) };
const FOCUS_TAPS = 12;

/**
 * A slight lens blur away from the focus distance, in one pass: a Vogel disc of FOCUS_TAPS taps
 * whose radius grows with the circle of confusion (three.js's CoC: smoothstep(0, range, |z −
 * focus|)). It replaces DepthOfFieldNode, which drew the same subtle look (a bokeh of at most
 * 1.2 px over a half-resolution copy) through six passes and two 64- and 16-tap blurs, the
 * most expensive pass of Ultra (about 10 ms of GPU time on the development Mac).
 */
function softFocus(src: N, viewZ: N): N {
  return Fn(() => {
    const p = uv();
    const coc = smoothstep(0, focus.range, viewZ.negate().sub(focus.distance).abs());
    const step = vec2(1).div(screenSize).mul(focus.radius.mul(coc));
    const acc = vec3(src.sample(p).rgb).toVar();
    for (let i = 1; i < FOCUS_TAPS; i++) {
      const r = Math.sqrt(i / (FOCUS_TAPS - 1));
      const th = i * 2.39996323;
      acc.addAssign(src.sample(p.add(step.mul(vec2(r * Math.cos(th), r * Math.sin(th))))).rgb);
    }
    return vec4(acc.div(FOCUS_TAPS), 1);
  })();
}
