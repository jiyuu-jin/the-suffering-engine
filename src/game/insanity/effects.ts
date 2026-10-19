// Screen effects of the insanity system as a small post-processing chain for
// three/webgpu (TSL node materials on full-screen quads), installed through the
// renderer's `postProcess` hook only while an effect is visible.
//
//   1. scene -> sceneRT (MSAA; the renderer's back-buffer format: 8-bit gamma values, or
//      linear half float with ?lighting=legacy, engine-light.ts GAMMA_BACK_BUFFER)
//   2. screen blur (SUFFERING.EXE renderer vtable +0x4c, 0x49c270; docs/re/renderer.md §2):
//      the previous output frame (front-buffer ping-pong target) is drawn over the new frame
//      as a full-screen quad with alpha min(1.4·A, 225/255), UVs B .. 1 − B (a zoom towards
//      the centre) and the Screen Blur's blend mode p2: 1 alpha blend, 2 additive, 3 (→ 4)
//      reverse subtract. Direct3D 9 blends gamma-encoded colours, so the ping-pong targets
//      hold gamma values and the blend happens on them [verified arithmetic; the render
//      target ping-pong is only allocated when the renderer's front-buffer effects are on].
//   3. present: blurred frame + tint layer (untextured Screen Fader) + image layer (textured
//      Screen Fader: hallucination flashes, transformation flash), alpha-blended on gamma
//      values like the engine's 2D quads [inferred: SRCALPHA / INVSRCALPHA], plus the port's
//      edge darkening for the creature form [port], written as gamma (the back buffer's
//      values; decoded back to linear only with ?lighting=legacy).

import * as THREE from 'three/webgpu';
import { Fn, float, length, mix, smoothstep, sRGBTransferEOTF, sRGBTransferOETF, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { LevelRenderer } from '../../app/renderer';
import { BACK_BUFFER_TYPE, GAMMA_BACK_BUFFER } from '../../app/engine-light';
import { warmHooks, warmTargets } from '../../app/prewarm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const toSrgb = (c: N): N => (sRGBTransferOETF as N)(c);
const toLinear = (c: N): N => (sRGBTransferEOTF as N)(c);

export interface OverlayLayer {
  color: THREE.Color;
  alpha: number;
  texture: THREE.Texture | null;
}

const blank = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
})();

export class ScreenEffects {
  /** Screen blur: alpha of the previous frame (0..225/255), its UV inset B, blend mode (1 / 2 / 4). */
  blur = 0;
  inset = 0;
  blurMode = 1;
  /** Flat colour layer (tint / fade), alpha 0..1. */
  readonly tint: OverlayLayer = { color: new THREE.Color(0, 0, 0), alpha: 0, texture: null };
  /** Image layer (textured fader), alpha 0..1. */
  readonly image: OverlayLayer = { color: new THREE.Color(1, 1, 1), alpha: 0, texture: null };
  /** Edge darkening 0..1 (creature form) [inferred]. */
  vignette = 0;

  private sceneRT: THREE.RenderTarget;
  private fb: [THREE.RenderTarget, THREE.RenderTarget];
  private compMat = new THREE.NodeMaterial();
  private presentMat = new THREE.NodeMaterial();
  private quad = new THREE.QuadMesh(this.compMat);
  private sceneTex;
  private prevTex;
  private compTex;
  private imageTex;
  private u = {
    blur: uniform(0),
    inset: uniform(0),
    mode: uniform(1),
    tintColor: uniform(new THREE.Vector3()),
    tintAlpha: uniform(0),
    imageColor: uniform(new THREE.Vector3(1, 1, 1)),
    imageAlpha: uniform(0),
    vignette: uniform(0),
  };
  private size = new THREE.Vector2();
  private fresh = true;
  private installed = false;

  constructor(private readonly view: LevelRenderer) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    // The attachments and colour space of the renderer's own frame target (BACK_BUFFER_TYPE, 4
    // samples, linear working space): three.js shares a render context between the two, and a
    // render object that sees another colour space there rebuilds its pipeline at every switch
    // (docs/game-logic.md §18.8).
    this.sceneRT = new THREE.RenderTarget(1, 1, { type: BACK_BUFFER_TYPE, samples: 4, colorSpace: THREE.LinearSRGBColorSpace });
    this.fb = [new THREE.RenderTarget(1, 1, opts), new THREE.RenderTarget(1, 1, opts)];
    this.sceneTex = texture(this.sceneRT.texture);
    this.prevTex = texture(this.fb[0].texture);
    this.compTex = texture(this.fb[1].texture);
    this.imageTex = texture(blank);
    const u = this.u;

    this.compMat.fragmentNode = Fn(() => {
      const p = uv();
      // Gamma-encoded, like the engine's back buffer (the scene target holds gamma already).
      const scene = this.sceneTex.sample(p).rgb.max(0);
      const cur = GAMMA_BACK_BUFFER ? scene : toSrgb(scene);
      // Previous frame drawn with UVs B .. 1 − B (0x495750).
      const zp = vec2(u.inset).add(p.mul(float(1).sub(u.inset.mul(2))));
      const prev = this.prevTex.sample(zp).rgb;
      // SRCALPHA / INVSRCALPHA, SRCALPHA / ONE, or reverse-subtract SRCALPHA / ONE.
      const blended = mix(cur, prev, u.blur);
      const add = cur.add(prev.mul(u.blur)).min(1);
      const sub = cur.sub(prev.mul(u.blur)).max(0);
      const out = mix(mix(blended, add, u.mode.equal(2).select(1, 0)), sub, u.mode.equal(4).select(1, 0));
      return vec4(out, float(1));
    })();
    this.compMat.name = 'insanity-feedback';

    this.presentMat.fragmentNode = Fn(() => {
      const p = uv();
      // The blurred frame is gamma-encoded; the faders blend on gamma values too.
      const base = this.compTex.sample(p).rgb.toVar();
      base.assign(mix(base, toSrgb(vec3(u.tintColor)), u.tintAlpha));
      // Images are decoded top row first; three's quad uv matches that on both backends
      // (checked on WebGPU and the WebGL2 fallback).
      const img = this.imageTex.sample(p);
      base.assign(mix(base, toSrgb(img.rgb.mul(u.imageColor)), u.imageAlpha.mul(img.a)));
      const edge = smoothstep(0.3, 0.85, length(p.sub(0.5)).mul(1.35));
      base.mulAssign(float(1).sub(u.vignette.mul(edge)));
      return vec4(GAMMA_BACK_BUFFER ? base : toLinear(base), float(1));
    })();
    this.presentMat.name = 'insanity-present';
    // The scene drawn into sceneRT is another pass (own pipelines): compiled with the level
    // so the first fade / flash does not hitch (src/app/prewarm.ts).
    warmTargets.add(this.sceneRT);
    warmHooks.add(this.warm);
  }

  /** Draws both quads once (pipelines built at load, not on the first effect). */
  private readonly warm = () => {
    const r = this.view.renderer;
    const prevTarget = r.getRenderTarget();
    // Allocate the targets at the screen size now too (the first effect would otherwise create
    // three full-screen textures, one multisampled, in its frame).
    this.fit();
    try {
      // Clearing creates the scene target's textures (multisampled colour + depth) now.
      r.setRenderTarget(this.sceneRT);
      r.clear();
      this.quad.material = this.compMat;
      r.setRenderTarget(this.fb[1]);
      this.quad.render(r);
      this.quad.material = this.presentMat;
      r.setRenderTarget(prevTarget);
      this.quad.render(r);
    } finally {
      r.setRenderTarget(prevTarget);
    }
  };

  /** Anything visible this frame? */
  get active(): boolean {
    return this.blur > 0.002 || this.tint.alpha > 0.002 || this.image.alpha > 0.002 || this.vignette > 0.002;
  }

  /** Install / remove the renderer hook depending on `active` (call once per frame). */
  sync() {
    const want = this.active;
    if (want && !this.installed) {
      this.view.postProcess = this;
      this.installed = true;
      this.fresh = true;
    } else if (!want && this.installed) {
      if (this.view.postProcess === this) this.view.postProcess = null;
      this.installed = false;
    }
  }

  /** Targets at the drawing-buffer size. */
  private fit() {
    this.view.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
    if (this.sceneRT.width !== w || this.sceneRT.height !== h) {
      this.sceneRT.setSize(w, h);
      this.fb[0].setSize(w, h);
      this.fb[1].setSize(w, h);
      this.fresh = true;
    }
  }

  render() {
    const r = this.view.renderer;
    this.fit();
    const u = this.u;
    // A fresh trail starts from the current frame (no stale history).
    u.blur.value = this.fresh ? 0 : Math.min(225 / 255, this.blur);
    u.inset.value = this.inset;
    u.mode.value = this.blurMode;
    u.tintColor.value.set(this.tint.color.r, this.tint.color.g, this.tint.color.b);
    u.tintAlpha.value = this.tint.alpha;
    u.imageColor.value.set(this.image.color.r, this.image.color.g, this.image.color.b);
    u.imageAlpha.value = this.image.texture || this.image.alpha > 0 ? this.image.alpha : 0;
    u.vignette.value = this.vignette;
    this.imageTex.value = this.image.texture ?? blank;
    this.fresh = false;

    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.sceneRT);
    r.render(this.view.scene, this.view.camera);

    const [prev, cur] = this.fb;
    this.prevTex.value = prev.texture;
    this.quad.material = this.compMat;
    r.setRenderTarget(cur);
    this.quad.render(r);

    this.compTex.value = cur.texture;
    this.quad.material = this.presentMat;
    r.setRenderTarget(prevTarget);
    this.quad.render(r);
    this.fb = [cur, prev];
  }

  dispose() {
    warmTargets.delete(this.sceneRT);
    warmHooks.delete(this.warm);
    if (this.view.postProcess === this) this.view.postProcess = null;
    this.installed = false;
    this.sceneRT.dispose();
    this.fb[0].dispose();
    this.fb[1].dispose();
    this.compMat.dispose();
    this.presentMat.dispose();
  }
}
