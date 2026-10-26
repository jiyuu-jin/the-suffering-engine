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
import { glowMark } from './glow-mark';
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
  if (!Array.isArray(m)) return markFor(m) ?? null;
  if (!m.some((x) => glowMark(x))) return null;
  return m.map((x) => markFor(x) ?? noMark);
}

/**
 * The mark of one material. A faded object (material opacity below 1: Killjoy under his
 * Projector Effect, a fading Hermes) marks only where its pass's alpha, texture alpha x the
 * object's opacity (TFACTOR alpha, SUFFERING.EXE 0x498a5c / 0x48fcd7), clears the pass's alpha
 * test, > 32 / 255 for a glow-flagged additive pass (renderer.md §5.1, §5.2) [verified]. Marks
 * are shared by every material of a surface, so a faded material gets a clone of its own that
 * carries its opacity (the mark graph multiplies the alpha by it). Before this, the mark used
 * the texture alpha alone: Killjoy's silhouette glowed at full strength while the projector's
 * flicker had him at 0..12 % (the engine draws no mark then), a white blob over the wall.
 */
function markFor(x: THREE.Material): THREE.Material | undefined {
  const mark = glowMark(x);
  if (!mark || !(x.opacity < 1)) return mark;
  let c = fadedMarks.get(x);
  if (!c || c.base !== mark) {
    const m = mark.clone();
    m.name = `${mark.name}:faded`;
    fadedMarks.set(x, (c = { base: mark, m }));
  }
  c.m.opacity = x.opacity;
  return c.m;
}
const fadedMarks = new WeakMap<THREE.Material, { base: THREE.Material; m: THREE.Material }>();

/** Group slots of a multi-material mesh that do not mark: drawn without touching anything. */
const noMark = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorWrite = false;
  m.depthWrite = false;
  m.name = 'glow-nomark';
  return m;
})();

/** The parts of three.js's RenderList the mark pass reads (r186). */
interface RenderListLike {
  opaque: { object: THREE.Object3D }[];
  transparent: { object: THREE.Object3D }[];
  transparentDoublePass?: { object: THREE.Object3D }[];
}

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
  /** 1: no mask test (glow flag p3 / state +0xc set: the whole frame glows). */
  private readonly noMask = uniform(0);
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
            const c: N = t.rgb.mul(t.a.greaterThan(GLOW_MASK_REF).or(this.noMask.greaterThan(0)).select(1, 0));
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
    // The state's flag (+0xc: an HDR Scene Glow p3, or the Game Cheats toggle through engine slot
    // +0x24, 0x48cde0) drops the level-0 alpha test (0x48d232..0x48d2e9): every frame texel enters.
    const all = !!this.state.flag;
    this.noMask.value = all ? 1 : 0;
    if (!this.collect(false) && !all) return;
    const r = this.r;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    try {
      r.autoClear = false;
      r.setRenderTarget(target);
      // 1. the mask in the frame's alpha (not read with the flag set).
      if (!all) {
        this.quad.material = this.clearAlphaMat;
        this.quad.render(r);
        this.drawMarks();
      }
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
    else if (!this.collectDrawn()) this.scene.traverseVisible(visit);
    this.marked = meshes.length;
    return meshes.length;
  }

  /**
   * The marked meshes of the scene render just made with this camera, read from three's render
   * list for it (docs/perf.md): exactly the meshes that pass drew (shown, on the camera's layer,
   * in the frustum), without walking the scene graph again. A marked mesh outside the frustum
   * drew no mark before either (the mark pass culls it). False when the list is not reachable
   * (another three.js version): the caller walks the scene.
   */
  private collectDrawn(): boolean {
    const r = this.r as unknown as { _renderLists?: { get(scene: THREE.Object3D, camera: THREE.Camera, lighting: unknown): RenderListLike | undefined }; lighting?: unknown };
    const list = r._renderLists?.get(this.scene, this.camera, r.lighting);
    if (!list || !Array.isArray(list.opaque) || !Array.isArray(list.transparent)) return false;
    const seen = this.stamps, stamp = ++this.stamp;
    for (const items of [list.opaque, list.transparent, list.transparentDoublePass]) {
      if (!items) continue;
      for (let i = 0; i < items.length; i++) {
        const m = items[i].object as THREE.Mesh;
        if (!m?.isMesh || seen.get(m) === stamp) continue;
        seen.set(m, stamp);
        if (glowMarkOf(m.material)) this.meshes.push(m);
      }
    }
    return true;
  }
  /** Per-object stamps of the current walk (no per-frame Set: its storage was garbage each frame). */
  private readonly stamps = new WeakMap<THREE.Object3D, number>();
  private stamp = 0;

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
    // Only the marked meshes' branches of the scene graph are walked by the mark render: the
    // other children of their ancestors are hidden for it (docs/perf.md). Nothing else is on
    // the glow layer, so what is drawn is the same; the scene's full walk cost as much as the
    // main pass's own (3a: about 1 ms a frame).
    const hidden = this.pruneForMarks();
    // Small marked meshes (fire cards: 3a has 59 fires of three cards) drawn as one mesh per
    // mark material (MarkBatches below); added after the pruning, removed after the render.
    const batched = this.batches.build(this.meshes);
    if (batched) this.scene.add(this.batches.group);
    try {
      this.r.render(this.scene, cam);
    } finally {
      if (batched) this.scene.remove(this.batches.group);
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
      cam.layers.mask = mask;
      this.scene.background = bg;
    }
  }
  private readonly batches = new MarkBatches();

  /** Hide every shown object that neither is nor holds a marked mesh; returns them. */
  private pruneForMarks(): THREE.Object3D[] {
    const keep = this.keep, hidden = this.hidden, kept = this.stamps, stamp = ++this.stamp;
    keep.length = 0;
    for (const m of this.meshes) {
      for (let o: THREE.Object3D | null = m; o && kept.get(o) !== stamp; o = o.parent) {
        kept.set(o, stamp);
        keep.push(o);
      }
    }
    for (let k = 0; k < keep.length; k++) {
      const ch = keep[k].children;
      for (let i = 0; i < ch.length; i++) {
        const c = ch[i];
        // (Lights stay: they are part of the lights node every material's pipeline is keyed by.)
        if (c.visible && kept.get(c) !== stamp && !(c as THREE.Light).isLight) {
          c.visible = false;
          hidden.push(c);
        }
      }
    }
    keep.length = 0;
    return hidden;
  }
  private readonly keep: THREE.Object3D[] = [];
  private readonly hidden: THREE.Object3D[] = [];

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
        // Hidden meshes (other zones, the lamps' other material tables) are compiled too. Each
        // object's own flag is kept once: meshes share parents, and a parent shown for the first
        // mesh read as shown for the next one, so the restore left it shown (hidden objects with
        // glow marks were drawn after every level load: 2's Fire models, 3a's toggled statics).
        const restoreShown = showWithParents(this.meshes);
        this.swapMarks();
        const cam = this.camera, mask = cam.layers.mask;
        cam.layers.set(GLOW_LAYER);
        let p: Promise<void> | undefined;
        try {
          p = r.compileAsync(this.scene, cam, this.scene);
        } finally {
          cam.layers.mask = mask;
          this.restoreMarks();
          restoreShown();
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

/**
 * Show objects and all their parents (a precompile that must see hidden ones); returns the
 * restore. Each object's flag is kept once, so parents shared by several objects come back as
 * they were (scene-glow's warm: a shared parent shown for the first mesh read as shown for the
 * next, and stayed shown).
 */
export function showWithParents(objects: Iterable<THREE.Object3D>): () => void {
  const vis = new Map<THREE.Object3D, boolean>();
  for (const m of objects) for (let o: THREE.Object3D | null = m; o; o = o.parent) if (!vis.has(o)) (vis.set(o, o.visible), (o.visible = true));
  return () => {
    for (const [o, v] of vis) o.visible = v;
  };
}

/** Marked meshes up to this many vertices are drawn merged in the mark pass. */
const SMALL_MARK = 64;

interface MarkBatch {
  mesh: THREE.Mesh;
  /** Builds since it last drew (a batch long unused is disposed: its material may be gone). */
  idle: number;
  /** Attribute names of the members, in order (the merged geometry has the same layout). */
  names: string[];
  vertices: number;
  indices: number;
}

/**
 * The mark pass's small meshes merged per mark material (docs/perf.md). Every mark writes the
 * same value (alpha 1, colour kept, no depth write), so the order of the marks does not matter
 * and one draw can hold them all: the members' triangles are copied into a world-space buffer
 * each frame (positions and normals through their world matrices, a mirroring matrix flipping
 * the winding as three.js does) and the members themselves are left off the glow layer. The
 * merged geometry keeps the members' attribute layout, so it draws with their pipeline.
 */
class MarkBatches {
  readonly group = new THREE.Group();
  private readonly byKey = new Map<string, MarkBatch>();
  private readonly layouts = new WeakMap<THREE.BufferGeometry, string | null>();

  constructor() {
    this.group.name = 'glow-mark-batches';
    this.group.matrixAutoUpdate = false;
    this.group.matrixWorldAutoUpdate = false;
  }

  /** Attribute layout key of a geometry that can be merged, or null. */
  private layout(g: THREE.BufferGeometry): string | null {
    let k = this.layouts.get(g);
    if (k !== undefined) return k;
    k = null;
    const pos = g.attributes.position as THREE.BufferAttribute | undefined;
    const plain = Object.values(g.attributes).every((a) => (a as THREE.BufferAttribute).isBufferAttribute && !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute);
    if (pos && plain && pos.count <= SMALL_MARK && !g.groups.length && !Object.keys(g.morphAttributes).length && g.drawRange.start === 0 && g.drawRange.count === Infinity) {
      k = Object.keys(g.attributes)
        .sort()
        .map((n) => {
          const a = g.attributes[n] as THREE.BufferAttribute;
          return `${n}:${a.itemSize}:${a.array.constructor.name}:${a.normalized ? 1 : 0}`;
        })
        .join(',');
    }
    this.layouts.set(g, k);
    return k;
  }

  /**
   * Take the eligible marked meshes (already on their mark material and the glow layer) into
   * the batches. Returns whether any batch has something to draw.
   */
  build(meshes: readonly THREE.Mesh[]): boolean {
    for (const b of this.byKey.values()) (b.vertices = 0), (b.indices = 0);
    let any = false;
    const bit = 1 << GLOW_LAYER;
    for (const m of meshes) {
      if ((m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || m.morphTargetInfluences?.length || Array.isArray(m.material)) continue;
      const lay = this.layout(m.geometry);
      if (!lay) continue;
      const mat = m.material as THREE.Material;
      const key = `${mat.uuid}|${lay}`;
      let b = this.byKey.get(key);
      if (!b) this.byKey.set(key, (b = this.create(m.geometry, mat)));
      this.append(b, m);
      m.layers.mask &= ~bit;
      any = true;
    }
    for (const [key, b] of this.byKey) {
      const g = b.mesh.geometry;
      b.mesh.visible = b.indices > 0;
      if (!b.indices) {
        if (++b.idle > 600) {
          this.byKey.delete(key);
          b.mesh.removeFromParent();
          g.dispose();
        }
        continue;
      }
      b.idle = 0;
      g.setDrawRange(0, b.indices);
      for (const n of b.names) {
        const a = g.attributes[n] as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, b.vertices * a.itemSize);
        a.needsUpdate = true;
      }
      const ix = g.index!;
      ix.clearUpdateRanges();
      ix.addUpdateRange(0, b.indices);
      ix.needsUpdate = true;
    }
    return any;
  }

  private create(src: THREE.BufferGeometry, material: THREE.Material): MarkBatch {
    const geo = new THREE.BufferGeometry();
    const names = Object.keys(src.attributes).sort();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `glow-mark-batch:${material.name}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(GLOW_LAYER);
    const b: MarkBatch = { mesh, idle: 0, names, vertices: 0, indices: 0 };
    this.allocate(b, src, 256, 768);
    this.group.add(mesh);
    return b;
  }

  /** (Re)allocate the merged buffers with room for `v` vertices and `i` indices, keeping the content. */
  private allocate(b: MarkBatch, layoutOf: THREE.BufferGeometry, v: number, i: number) {
    const old = b.mesh.geometry;
    const geo = new THREE.BufferGeometry();
    for (const n of b.names) {
      const a = (old.attributes[n] ?? layoutOf.attributes[n]) as THREE.BufferAttribute;
      const Ctor = a.array.constructor as new (n: number) => THREE.TypedArray;
      const arr = new Ctor(v * a.itemSize);
      const prev = old.attributes[n] as THREE.BufferAttribute | undefined;
      if (prev) arr.set((prev.array as THREE.TypedArray).subarray(0, b.vertices * a.itemSize));
      geo.setAttribute(n, new THREE.BufferAttribute(arr, a.itemSize, a.normalized).setUsage(THREE.DynamicDrawUsage));
    }
    const idx = new Uint32Array(i);
    if (old.index) idx.set((old.index.array as Uint32Array).subarray(0, b.indices));
    geo.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
    b.mesh.geometry = geo;
    if (old !== geo) old.dispose();
  }

  private append(b: MarkBatch, m: THREE.Mesh) {
    const src = m.geometry;
    const pos = src.attributes.position as THREE.BufferAttribute;
    const n = pos.count;
    const idx = src.index;
    const count = idx ? idx.count : n;
    let geo = b.mesh.geometry;
    if (b.vertices + n > (geo.attributes.position as THREE.BufferAttribute).count || b.indices + count > geo.index!.count) {
      this.allocate(b, src, Math.max(2 * (b.vertices + n), 256), Math.max(2 * (b.indices + count), 768));
      geo = b.mesh.geometry;
    }
    const e = m.matrixWorld.elements;
    const v0 = b.vertices;
    for (const name of b.names) {
      const a = src.attributes[name] as THREE.BufferAttribute;
      const out = (geo.attributes[name] as THREE.BufferAttribute).array as THREE.TypedArray;
      const s = a.itemSize, arr = a.array as THREE.TypedArray;
      if (name === 'position' && s === 3) {
        for (let k = 0; k < n; k++) {
          const x = arr[3 * k], y = arr[3 * k + 1], z = arr[3 * k + 2];
          const o = 3 * (v0 + k);
          out[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
      } else if (name === 'normal' && s === 3 && !a.normalized) {
        const N = _nm.getNormalMatrix(m.matrixWorld).elements;
        for (let k = 0; k < n; k++) {
          const x = arr[3 * k], y = arr[3 * k + 1], z = arr[3 * k + 2];
          let nx = N[0] * x + N[3] * y + N[6] * z, ny = N[1] * x + N[4] * y + N[7] * z, nz = N[2] * x + N[5] * y + N[8] * z;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          const o = 3 * (v0 + k);
          out[o] = nx;
          out[o + 1] = ny;
          out[o + 2] = nz;
        }
      } else out.set(arr.subarray(0, n * s), v0 * s);
    }
    const flip = m.matrixWorld.determinant() < 0;
    const outI = geo.index!.array as Uint32Array;
    const ia = idx?.array;
    let w = b.indices;
    for (let t = 0; t + 2 < count; t += 3) {
      const a = ia ? ia[t] : t, c1 = ia ? ia[t + 1] : t + 1, c2 = ia ? ia[t + 2] : t + 2;
      outI[w++] = v0 + a;
      outI[w++] = v0 + (flip ? c2 : c1);
      outI[w++] = v0 + (flip ? c1 : c2);
    }
    b.vertices += n;
    b.indices = w;
  }
}

const _nm = new THREE.Matrix3();
