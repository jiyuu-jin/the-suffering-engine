// Enhanced mode post stack (docs/enhanced.md §Post stack), a three/webgpu RenderPipeline built per
// quality tier:
//
//   scene pass (HDR half float; MRT colour + velocity; MSAA, or TRAA jitter)
//     × GTAO                                 (ambient occlusion from depth)
//     + volumetric light                     (volumetric.ts: flashlight beam, lamp halos, moonlight)
//     → TRAA                                 (temporal AA: also resolves the AO / volumetric noise)
//     + first-person viewmodel pass          (arms and weapon, MSAA, composited over)
//     + bloom                                (lamps, fire, arcs, the flashlight's hot spot)
//     → depth of field                       (Ultra: focus on the centre of the view)
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
  agxToneMapping,
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
  smoothstep,
  sRGBTransferOETF,
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
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { TierFeatures } from './config';
import { VolumetricNode } from './volumetric';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Named points of the chain where another module may insert a node (docs/enhanced.md). */
export type EnhancedStage = 'sceneHDR' | 'beforeBloom' | 'beforeGrade' | 'final';
/** Receives the chain's colour node at a stage and returns the (possibly) modified one. */
export type EnhancedStageHook = (color: N, ctx: { depth: N; camera: THREE.Camera; features: TierFeatures }) => N;

/** Grade / lens parameters (uniforms: no rebuild). */
export const grade = {
  exposure: uniform(0.82),
  saturation: uniform(0.7),
  /** Shadow tint (cold) and highlight tint (sickly warm), multiplied in linear light. */
  shadowTint: uniform(new THREE.Vector3(0.82, 0.93, 1.12)),
  highlightTint: uniform(new THREE.Vector3(1.1, 1.03, 0.8)),
  /** Black level lift (cold), display space. */
  lift: uniform(new THREE.Vector3(0.0015, 0.0025, 0.0045)),
  contrast: uniform(1.08),
  vignette: uniform(0.42),
  grain: uniform(0.045),
  aberration: uniform(0.0025),
  /** Insanity 0..1: barrel distortion and more aberration. */
  insanity: uniform(0),
  bloomStrength: uniform(0.55),
  /** 1: encode sRGB (canvas); 0: linear (the insanity effects' scene target). */
  encode: uniform(1),
  time: uniform(0),
};

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
    if (useTraa) scenePass.setMRT(mrt({ output, velocity }));
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
      c = vec4(c.rgb.mul(mix(float(1), occl, 0.85)), c.a);
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
    vmPass.setMRT(mrt({ output, cover: vec4(1, 1, 1, 1) }));
    vmPass.setResolutionScale(f.renderScale);
    this.disposables.push(vmPass);
    const vm: N = vmPass.getTextureNode('output');
    const cover: N = vmPass.getTextureNode('cover').r.clamp(0, 1);
    c = (vec4 as N)((mix as N)(c.rgb, vm.rgb.div(cover.max(1e-3)), cover), 1);

    c = run('beforeBloom', c);
    if (f.bloom) {
      const b = bloom(c, 1, 0.55, 0.85);
      b.strength = grade.bloomStrength;
      this.disposables.push(b);
      c = c.add(b);
    }
    if (f.dof) {
      const viewZ = scenePass.getViewZNode();
      const d = dof(c, viewZ, uniform(6), uniform(4), uniform(1.2));
      this.disposables.push(d);
      c = d;
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

  dispose() {
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
    const rgb = vec3(hdr.sample(pd.add(ca)).r, hdr.sample(pd).g, hdr.sample(pd.sub(ca)).b).max(0).toVar();
    // Exposure, desaturation, split tone (in linear light, before the tone map).
    rgb.mulAssign(grade.exposure);
    const luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb.assign(mix(vec3(luma), rgb, grade.saturation));
    const t = smoothstep(0.02, 0.5, luma.pow(0.45));
    rgb.mulAssign(mix(grade.shadowTint as N, grade.highlightTint as N, t));
    // AgX filmic tone map (exposure applied above).
    const mapped = (agxToneMapping as N)(rgb, float(1)).toVar();
    // Contrast around mid grey, cold black lift.
    mapped.assign(mapped.sub(0.18).mul(grade.contrast).add(0.18).max(0).add(grade.lift as N));
    // Vignette (stronger while insane).
    const vig = smoothstep(0.25, 0.95, length(d).mul(1.35)).mul(grade.vignette.add(grade.insanity.mul(0.3)));
    mapped.mulAssign(float(1).sub(vig));
    // Film grain: luminance-weighted, changing every frame.
    const n = interleavedGradientNoise(screenCoordinate.xy.add(grade.time.mul(97.31).fract().mul(173))).sub(0.5);
    const l2 = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
    mapped.addAssign(n.mul(grade.grain).mul(float(1).sub(l2.mul(0.7)).max(0.15)));
    const enc = (sRGBTransferOETF as N)(mapped.clamp(0, 1));
    return (vec4 as N)(mix(mapped.clamp(0, 1) as N, enc, grade.encode), 1);
  })();
}
