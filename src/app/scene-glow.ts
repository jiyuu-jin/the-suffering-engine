// HDR scene glow ("HDR ScreenBlur", SUFFERING.EXE 0x48d0a0; docs/re/renderer.md §3.2) for the
// Original look. The engine runs it at the end of every frame with its default state (white,
// full strength, additive: 0x5ba0a4), whenever the front-buffer effects are on (the port's
// "Pixel Shaders" option, as for the screen blur) and engine property 0x39 is set (default 1):
//
//   1. mask: every pass of a flagged material (Advanced p5 / Animating p7) wrote stencil 1, an
//      opaque first pass without the flag 0, the rest kept it; 0x49c030 clears the frame's
//      alpha and writes alpha 1 where the stencil is 1. Port: the frame is drawn into a target
//      of its own, its alpha cleared by a quad, and the visible meshes whose material carries a
//      mark (surface-material.ts glowMarkMaterial) are drawn again over the scene's depth (equal
//      or nearer) writing alpha 1 only. Opaque surfaces in front hide the mark as the engine's
//      ZERO does; blended ones drawn over it keep it.
//   2. four levels at 256, 128, 64, 32 texels (render-data.ts GLOW_LEVELS): down-sample × 0.5
//      (level 0: the frame where alpha > 5 / 255; later levels: the previous level's blur), blur
//      with seven additive taps (GLOW_TAPS, weights summing to 480 / 255), each pass saturated
//      on 8-bit gamma values;
//   3. accumulate the levels into one 256² target (level 0 copied, the others added) and add it
//      over the whole back buffer (blend 2 with the glow colour's alpha: full strength).
//
// The lamps owe it their look: the frosted glass (7:1863, texture × 0x8a8a75) and the bulb
// (4:1374, × 0xffd67e) are flagged, so their pixels come back about 3.4 times over, blurred:
// glass that glows milky white around a blown-out bulb, and a halo over the cage and the shade.
//
// `?noglow` turns it off (comparisons).

import * as THREE from 'three/webgpu';
import { Fn, float, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import { DEFAULT_GLOW, GLOW_DOWNSAMPLE, GLOW_LEVELS, GLOW_MASK_REF, GLOW_TAPS, type SceneGlow as GlowState } from '../formats/render-data';
import { BACK_BUFFER_TYPE } from './engine-light';
import { warmHooks, warmTargets } from './prewarm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** `?noglow`: no scene glow (comparisons). */
export const NO_GLOW = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noglow');

/** Layer the mark pass draws (set on the marked meshes for that pass only). */
export const GLOW_LAYER = 30;

/** The mark material of a mesh's current material (surface-material.ts), if it has one. */
export function glowMarkOf(m: THREE.Material | THREE.Material[] | undefined): THREE.Material | THREE.Material[] | null {
  if (!m) return null;
  if (!Array.isArray(m)) return (m.userData.glowMark as THREE.Material | undefined) ?? null;
  if (!m.some((x) => x?.userData.glowMark)) return null;
  return m.map((x) => (x?.userData.glowMark as THREE.Material | undefined) ?? noMark);
}

/** Group slots of a multi-material mesh that do not mark: drawn without touching anything. */
const noMark = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorWrite = false;
  m.depthWrite = false;
  m.name = 'glow-nomark';
  return m;
})();

const targetOpts = { type: THREE.UnsignedByteType, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false } as const;

export class SceneGlow {
  /** Glow state (HDR Scene Glow template; the engine default unless a template replaces it). */
  state: GlowState = { ...DEFAULT_GLOW };
  /** Marked meshes drawn last frame (QA). */
  marked = 0;

  /** The frame target: the renderer's back-buffer attachments, so the scene shares its pipelines. */
  readonly frameRT: THREE.RenderTarget;
  private readonly B: THREE.RenderTarget[];
  private readonly A: THREE.RenderTarget[];
  private readonly quad = new THREE.QuadMesh(new THREE.NodeMaterial());
  private readonly clearAlphaMat = new THREE.NodeMaterial();
  private readonly downMat: THREE.NodeMaterial[] = [];
  private readonly blurMat: THREE.NodeMaterial[] = [];
  private readonly addMat = new THREE.NodeMaterial();
  private readonly presentMat = new THREE.NodeMaterial();
  private readonly frameTex: N;
  private readonly glowColor = uniform(new THREE.Vector3(1, 1, 1));
  private readonly size = new THREE.Vector2();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly saved: (THREE.Material | THREE.Material[])[] = [];
  private readonly masks: number[] = [];

  constructor(
    private readonly r: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {
    this.frameRT = new THREE.RenderTarget(1, 1, { type: BACK_BUFFER_TYPE, samples: 4, colorSpace: THREE.LinearSRGBColorSpace });
    this.frameTex = texture(this.frameRT.texture);
    this.B = GLOW_LEVELS.map((f) => new THREE.RenderTarget(f, f, targetOpts));
    this.A = GLOW_LEVELS.map((f) => new THREE.RenderTarget(f, f, targetOpts));
    for (const t of [...this.B, ...this.A]) t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;

    // 0x49c030 first quad: alpha only, 0 (xpsSetAlpha00).
    const ca = this.clearAlphaMat;
    ca.fragmentNode = vec4(0, 0, 0, 0);
    ca.blending = THREE.CustomBlending;
    ca.blendSrc = THREE.ZeroFactor;
    ca.blendDst = THREE.OneFactor;
    ca.blendSrcAlpha = THREE.ZeroFactor;
    ca.blendDstAlpha = THREE.ZeroFactor;
    ca.depthTest = ca.depthWrite = false;
    ca.name = 'glow-clear-alpha';

    GLOW_LEVELS.forEach((f, l) => {
      // Down-sample at vertex colour 0x80. Level 0 reads the frame through the mask's alpha test
      // (2 x 2 bilinear taps per texel: the frame is several times the 256² target); later levels
      // read the previous level's blur at the centre of each 2 x 2.
      const down = new THREE.NodeMaterial();
      if (l === 0) {
        const src = this.frameTex;
        down.fragmentNode = Fn(() => {
          const p = uv();
          const d = vec2(0.25 / f, 0.25 / f);
          let sum: N = null;
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const t: N = src.sample(p.add(d.mul(vec2(sx, sy))));
            const c: N = t.rgb.mul(t.a.greaterThan(GLOW_MASK_REF).select(1, 0));
            sum = sum ? sum.add(c) : c;
          }
          return vec4(sum.mul(0.25 * GLOW_DOWNSAMPLE).clamp(0, 1), 1);
        })();
      } else {
        const prev = texture(this.A[l - 1].texture);
        down.fragmentNode = Fn(() => vec4(prev.sample(uv()).rgb.mul(GLOW_DOWNSAMPLE), 1))();
      }
      down.depthTest = down.depthWrite = false;
      down.name = `glow-down-${f}`;
      this.downMat.push(down);

      // Seven additive taps; a quad drawn at offset o reads B at p - o (pixels of this level).
      const b = texture(this.B[l].texture);
      const blur = new THREE.NodeMaterial();
      blur.fragmentNode = Fn(() => {
        const p = uv();
        let acc: N = vec4(0, 0, 0, 0).rgb;
        for (const t of GLOW_TAPS) {
          // (The tap set is symmetric in y, so the quad's v direction does not matter.)
          const q = p.sub(vec2(t.dx / f, t.dy / f));
          const inside: N = q.x.greaterThanEqual(0).and(q.x.lessThanEqual(1)).and(q.y.greaterThanEqual(0)).and(q.y.lessThanEqual(1));
          acc = acc.add(b.sample(q).rgb.mul(inside.select(t.weight / 255, 0))).min(1);
        }
        return vec4(acc, 1);
      })();
      blur.depthTest = blur.depthWrite = false;
      blur.name = `glow-blur-${f}`;
      this.blurMat.push(blur);
    });

    // Accumulation (level 0 copied, the others added, saturated per add) and the composite over
    // the back buffer: blend 2 (SRCALPHA, ONE) with the glow colour; alpha = the strength.
    const levels = this.A.map((t) => texture(t.texture));
    const gc = this.glowColor;
    const am = this.addMat;
    am.fragmentNode = Fn(() => {
      const p = uv();
      let c: N = levels[0].sample(p).rgb.mul(gc);
      for (let l = 1; l < levels.length; l++) c = c.add(levels[l].sample(p).rgb.mul(gc)).min(1);
      return vec4(c, 1);
    })();
    am.blending = THREE.CustomBlending;
    am.blendSrc = am.blendSrcAlpha = THREE.OneFactor;
    am.blendDst = am.blendDstAlpha = THREE.OneFactor;
    am.depthTest = am.depthWrite = false;
    am.name = 'glow-composite';

    // The frame target to the canvas, unchanged (gamma values: written as they are).
    const pm = this.presentMat;
    const ft = this.frameTex;
    pm.fragmentNode = Fn(() => vec4(ft.sample(uv()).rgb, float(1)))();
    pm.depthTest = pm.depthWrite = false;
    pm.name = 'glow-present';

    warmTargets.add(this.frameRT);
    warmHooks.add(this.warm);
  }

  /** The frame target at the drawing-buffer size. */
  private fit() {
    this.r.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
    if (this.frameRT.width !== w || this.frameRT.height !== h) this.frameRT.setSize(w, h);
  }

  /** Draw the frame: the scene into the frame target, its glow over it, then to the canvas. */
  render() {
    const r = this.r;
    this.fit();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.frameRT);
    r.render(this.scene, this.camera);
    this.apply(this.frameRT);
    this.quad.material = this.presentMat;
    r.setRenderTarget(prev);
    this.quad.render(r);
  }

  /**
   * Add the glow of the scene just drawn into `target` (the frame target, or the screen
   * effects' scene target: game/insanity/effects.ts) to it. Nothing happens when no marked
   * mesh is drawn this frame.
   */
  apply(target: THREE.RenderTarget) {
    if (!this.collect(false)) return;
    const r = this.r;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    try {
      r.autoClear = false;
      r.setRenderTarget(target);
      // 1. the mask in the frame's alpha.
      this.quad.material = this.clearAlphaMat;
      this.quad.render(r);
      this.drawMarks();
      // 2. the levels.
      const src = this.frameTex;
      const saved = src.value;
      src.value = target.texture;
      for (let l = 0; l < GLOW_LEVELS.length; l++) {
        r.setRenderTarget(this.B[l]);
        this.quad.material = this.downMat[l];
        this.quad.render(r);
        r.setRenderTarget(this.A[l]);
        this.quad.material = this.blurMat[l];
        this.quad.render(r);
      }
      src.value = saved;
      // 3. accumulate and add over the frame.
      const s = this.state;
      const k = s.alpha;
      this.glowColor.value.set((((s.color >> 16) & 255) / 255) * k, (((s.color >> 8) & 255) / 255) * k, ((s.color & 255) / 255) * k);
      r.setRenderTarget(target);
      this.quad.material = this.addMat;
      this.quad.render(r);
    } finally {
      this.restoreMarks();
      r.autoClear = autoClear;
      r.setRenderTarget(prev);
    }
  }

  /**
   * The meshes drawn this frame whose material marks (`all`: every one, for the precompile),
   * switched to their mark material on the glow layer. Returns how many.
   */
  private collect(all: boolean): number {
    const meshes = this.meshes;
    meshes.length = 0;
    const visit = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (all || m.layers.mask !== 0) && glowMarkOf(m.material)) meshes.push(m);
    };
    if (all) this.scene.traverse(visit);
    else this.scene.traverseVisible(visit);
    this.marked = meshes.length;
    return meshes.length;
  }

  private swapMarks() {
    for (const m of this.meshes) {
      this.saved.push(m.material);
      this.masks.push(m.layers.mask);
      m.material = glowMarkOf(m.material)!;
      m.layers.mask |= 1 << GLOW_LAYER;
    }
  }

  private drawMarks() {
    this.swapMarks();
    const cam = this.camera, mask = cam.layers.mask, bg = this.scene.background;
    cam.layers.set(GLOW_LAYER);
    this.scene.background = null;
    try {
      this.r.render(this.scene, cam);
    } finally {
      cam.layers.mask = mask;
      this.scene.background = bg;
    }
  }

  private restoreMarks() {
    const meshes = this.meshes;
    for (let i = 0; i < this.saved.length; i++) {
      meshes[i].material = this.saved[i];
      meshes[i].layers.mask = this.masks[i];
    }
    this.saved.length = 0;
    this.masks.length = 0;
  }

  /** Precompile: the passes' quads and every marked mesh's mark pipeline (load time). */
  private readonly warm = () => {
    const r = this.r;
    const prev = r.getRenderTarget();
    this.fit();
    try {
      r.setRenderTarget(this.frameRT);
      r.clear();
      if (this.collect(true)) {
        // Hidden meshes (other zones, the lamps' other material tables) are compiled too.
        const vis = this.meshes.map((m) => {
          const v: boolean[] = [];
          for (let o: THREE.Object3D | null = m; o; o = o.parent) (v.push(o.visible), (o.visible = true));
          return v;
        });
        this.swapMarks();
        const cam = this.camera, mask = cam.layers.mask;
        cam.layers.set(GLOW_LAYER);
        let p: Promise<void> | undefined;
        try {
          p = r.compileAsync(this.scene, cam, this.scene);
        } finally {
          cam.layers.mask = mask;
          this.restoreMarks();
          this.meshes.forEach((m, i) => {
            let k = 0;
            for (let o: THREE.Object3D | null = m; o; o = o.parent) o.visible = vis[i][k++];
          });
        }
        void p?.catch(() => undefined);
      }
      this.quad.material = this.clearAlphaMat;
      this.quad.render(r);
      for (let l = 0; l < GLOW_LEVELS.length; l++) {
        r.setRenderTarget(this.B[l]);
        this.quad.material = this.downMat[l];
        this.quad.render(r);
        r.setRenderTarget(this.A[l]);
        this.quad.material = this.blurMat[l];
        this.quad.render(r);
      }
      r.setRenderTarget(this.frameRT);
      this.quad.material = this.addMat;
      this.quad.render(r);
      this.quad.material = this.presentMat;
      r.setRenderTarget(prev);
      this.quad.render(r);
    } finally {
      r.setRenderTarget(prev);
    }
  };

  dispose() {
    warmTargets.delete(this.frameRT);
    warmHooks.delete(this.warm);
    this.frameRT.dispose();
    for (const t of [...this.A, ...this.B]) t.dispose();
    for (const m of [this.clearAlphaMat, ...this.downMat, ...this.blurMat, this.addMat, this.presentMat]) m.dispose();
  }
}
