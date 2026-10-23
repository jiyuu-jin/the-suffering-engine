// Enhanced mode shadow maps (docs/enhanced.md §Shadows): the flashlight (perspective), up to two
// lamps (cube maps) and the moonlight (orthographic, around the camera; volumetric shafts only).
//
// Each map stores the distance to the light as a fraction of its range (cleared to 1), drawn with
// one shared distance material; alpha-tested surfaces (bars, grates, foliage) use a cut-out copy
// that reads their texture's alpha, and blended / sprite / line objects cast nothing. The scene is
// drawn with the zone culler's choice of the frame (only what the camera's zones show), through
// the renderer's render-object hook, so nothing in the scene graph is touched.
//
// Lamps do not move, and most of what they light does not either. Each shadowed lamp keeps a cube
// of its static casters, drawn again only on the faces where something static changed (the
// culler's zones, a door, an object that came to rest). Characters and moving objects are drawn
// every frame into the faces they touch, over a copy of the static face, by a MIN blend. (Drawing
// all six faces of two lamps every frame cost Ultra 30 ms of main-thread time: 2300 draws.)

import * as THREE from 'three/webgpu';
import { cubeTexture, float, materialReference, positionWorld, texture, uniform, vec4 } from 'three/tsl';
import { FLASH, LAMP_SHADOW_RANGE, MAX_SHADOW_LAMPS, EU, enhancedLights } from './lights';
import type { TierFeatures } from './config';
import { warmPasses } from '../prewarm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const distTarget = (size: number) => {
  const rt = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: true });
  rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  rt.texture.generateMipmaps = false;
  rt.texture.name = 'enhanced-shadow';
  return rt;
};
const cubeTarget = (size: number, name = 'enhanced-lamp-shadow') => {
  const rt = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: true });
  rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  rt.texture.generateMipmaps = false;
  rt.texture.name = name;
  return rt;
};

const targets = {
  flash: distTarget(1),
  /** The maps the shading samples: the static cube's faces plus the moving casters. */
  lamps: [cubeTarget(1), cubeTarget(1)],
  /** Static casters only. */
  still: [cubeTarget(1, 'enhanced-lamp-still'), cubeTarget(1, 'enhanced-lamp-still')],
  moon: distTarget(1),
};

/** Texture nodes the shading samples (their targets are resized per tier). */
// (The lamp maps are cube texture nodes whose value is swapped when a tier recreates the targets:
// samples taken with `.sample(dir)` follow their base node.)
export const shadowTextures: { flash: N; lamp0: N; lamp1: N; moon: N } = {
  flash: texture(targets.flash.texture),
  lamp0: cubeTexture(targets.lamps[0].texture),
  lamp1: cubeTexture(targets.lamps[1].texture),
  moon: texture(targets.moon.texture),
};

// Distance material: |P - origin| / range (perspective), or the depth along `fwd` / range (ortho).
const origin = uniform(new THREE.Vector3());
const fwd = uniform(new THREE.Vector3(0, 0, -1));
const range = uniform(20);
const ortho = uniform(0);
const stored: N = (() => {
  const d = positionWorld.sub(origin);
  return ortho.greaterThan(0.5).select(d.dot(fwd), d.length()).div(range).clamp(0, 1);
})();
// (`min`: the moving casters' pass over a copied static face. The nearer distance wins by a MIN
// blend, so it needs no depth buffer.)
// Every cut-out copy shares one graph that reads its texture from the material drawn (a graph
// per texture compiled a pipeline per texture on first sight: about a hundred in 5a).
const solidNode: N = vec4(stored, 0, 0, float(1));
const cutNode: N = vec4(stored, 0, 0, (materialReference('cutoutMap', 'texture') as N).a);
const makeDistMaterial = (map?: THREE.Texture, alphaTest = 0, min = false) => {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  if (map) (m as unknown as { cutoutMap: THREE.Texture }).cutoutMap = map;
  m.colorNode = map ? cutNode : solidNode;
  m.fog = false;
  m.alphaTest = alphaTest;
  m.name = (map ? 'enhanced-shadow-cut' : 'enhanced-shadow') + (min ? '-min' : '');
  if (min) {
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.MinEquation;
    m.blendSrc = m.blendDst = THREE.OneFactor;
    m.depthTest = m.depthWrite = false;
  }
  return m;
};
const solid = [makeDistMaterial(), makeDistMaterial(undefined, 0, true)];
const cutouts = new Map<string, THREE.Material>();
const castsShadow = (m: THREE.Material) => !m.transparent && !(m as { userData: { noShadow?: boolean } }).userData.noShadow;
function casterMaterial(m: THREE.Material, min = false): THREE.Material | null {
  if (!castsShadow(m)) return null;
  const i = min ? 1 : 0;
  if (!(m.alphaTest > 0)) return solid[i];
  const map = (m as THREE.MeshStandardMaterial).map ?? (m as { surfaceSlots?: { t: THREE.Texture[] } }).surfaceSlots?.t[0];
  if (!map) return solid[i];
  const k = `${map.uuid}|${m.alphaTest}|${i}`;
  let c = cutouts.get(k);
  if (!c) cutouts.set(k, (c = makeDistMaterial(map, m.alphaTest, min)));
  return c;
}

/**
 * Casters farther than this from the flashlight (m) are not drawn into its shadow map (receivers
 * there read lit). The beam is down to 0.14 there (30 / (d² + 18)), a sixteenth of its strength
 * at arm's length, and the far casters were a third of the map's draws.
 */
export const FLASH_SHADOW_REACH = 14;

/** Frames an object must hold still before it counts as static again (lamp cube caches). */
export const STILL_FRAMES = 30;
/** Extra radius (m) around a skinned mesh's bind-pose sphere: the animated limbs leave it. */
const SKIN_MARGIN = 0.6;
/**
 * Casters smaller than this (m, bounding radius) are left out of the lamp cubes: drips, the
 * morphing drip models (a mesh per frame) and shell casings came and went every frame and kept
 * the static faces being drawn again, for shadows a few centimetres across.
 */
const MIN_CASTER = 0.1;
/** The moonlight map (volumetric shafts only) is drawn every this many frames. */
export const MOON_EVERY = 2;
const ALL_FACES = 63;

/**
 * Bit k set when a sphere at `v` from a cube map's centre (radius `r`) can show in face k, whose
 * view axis is `axes[k]` (0..2 = +x, +y, +z; 3..5 = −x, −y, −z): it reaches into the face's 90°
 * pyramid and lies within `range`. Conservative.
 */
export function cubeFaceMask(v: { x: number; y: number; z: number }, r: number, range: number, axes: readonly number[]): number {
  const c = [v.x, v.y, v.z];
  if (Math.hypot(c[0], c[1], c[2]) - r > range) return 0;
  let mask = 0;
  for (let k = 0; k < 6; k++) {
    const a = axes[k] % 3;
    const ahead = axes[k] >= 3 ? -c[a] : c[a];
    let inside = true;
    // The pyramid's side planes through the centre, normals (axis ± side) / √2.
    for (let j = 0; j < 3 && inside; j++) if (j !== a && (ahead - Math.abs(c[j])) * Math.SQRT1_2 < -r) inside = false;
    if (inside) mask |= 1 << k;
  }
  return mask;
}

/** A static caster near a shadowed lamp: what was drawn of it, and the faces it showed in. */
interface CubeEntry {
  sig: number;
  mask: number;
  seen: number;
}
/** One shadowed lamp's cube cache. */
interface CubeCache {
  key: string;
  /** Faces whose static content must be drawn again; faces to rebuild from the static cube. */
  stale: number;
  fresh: number;
  /** Faces with moving casters this frame and the last (their old shadow must be taken out). */
  dynMask: number;
  dynPrev: number;
  dyn: Set<THREE.Object3D>;
  /** Camera layers the static content was drawn with (the zone culler's choice). */
  layers: number;
  objs: Map<THREE.Object3D, CubeEntry>;
  /** View axis of each face camera (cubeFaceMask). */
  axes: number[];
  next: number;
}
const newCache = (): CubeCache => ({ key: '', stale: ALL_FACES, fresh: 0, dynMask: 0, dynPrev: 0, dyn: new Set(), layers: -1, objs: new Map(), axes: [0, 3, 1, 4, 2, 5], next: 0 });

export class EnhancedShadows {
  private readonly flashCam = new THREE.PerspectiveCamera(2 * THREE.MathUtils.radToDeg(FLASH.outer) * 1.25, 1, 0.1, FLASH.range);
  private readonly cubeCams = [new THREE.CubeCamera(0.05, LAMP_SHADOW_RANGE, targets.lamps[0]), new THREE.CubeCamera(0.05, LAMP_SHADOW_RANGE, targets.lamps[1])];
  private readonly moonCam = new THREE.OrthographicCamera(-40, 40, 40, -40, 0, 160);
  private readonly caches = [newCache(), newCache()];
  /** Per object: its world transform's signature and the frame it last changed. */
  private readonly motion = new WeakMap<THREE.Object3D, { sig: number; at: number }>();
  private readonly inited = new WeakSet<THREE.RenderTarget>();
  /** Casters under MIN_CASTER: not in the lamp cubes. */
  private readonly tiny = new WeakSet<THREE.Object3D>();
  /** Which casters the current draw takes: every one, the static ones, or one lamp's moving ones. */
  private pass: 'all' | 'static' | Set<THREE.Object3D> = 'all';
  private frame = 0;
  private moonValid = false;
  private readonly clear = new THREE.Color();
  private readonly region = new THREE.Box3();
  private readonly at = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  /** Per frame: maps drawn, static lamp faces drawn, faces rebuilt (copy + moving casters), moving casters. */
  stats = { flash: 0, lampFaces: 0, lampCopies: 0, moving: 0, moon: 0 };

  constructor() {
    // Precompile (prewarm.ts): every caster's distance material, plain and MIN-blended, at load.
    // All the shadow maps share one render state (a red half-float target with depth, drawn at the
    // top level), so compiling into the flashlight's map builds the pipelines of them all.
    for (const min of [false, true]) warmPasses.add({ target: targets.flash, mrt: null, viewmodel: false, depth: 0, material: (m) => casterMaterial(m, min) });
  }

  /** Resize the maps for a tier (cheap when unchanged). */
  configure(f: TierFeatures) {
    const fs = Math.max(1, f.flashShadowSize);
    if (targets.flash.width !== fs) targets.flash.setSize(fs, fs);
    const ls = Math.max(1, f.lampShadowSize);
    for (let i = 0; i < MAX_SHADOW_LAMPS; i++) {
      if (targets.lamps[i].width !== ls) {
        // A new target: three r186's WebGPU backend never draws into a cube target resized with
        // setSize (it stayed all 0, so every lamp lookup read "occluded" and High / Ultra took the
        // shadowed lamps' light out of whole rooms: 1a's corridors and the electrocution room).
        targets.lamps[i].dispose();
        targets.still[i].dispose();
        targets.lamps[i] = cubeTarget(ls);
        targets.still[i] = cubeTarget(ls, 'enhanced-lamp-still');
        (i ? shadowTextures.lamp1 : shadowTextures.lamp0).value = targets.lamps[i].texture;
        (this.cubeCams[i] as { renderTarget: unknown }).renderTarget = targets.lamps[i];
        this.caches[i] = newCache();
      }
    }
    const ms = Math.max(1, f.moonShadowSize);
    if (targets.moon.width !== ms) (targets.moon.setSize(ms, ms), (this.moonValid = false));
    EU.flShadowTexel.value = 1 / fs;
    EU.taps.value = f.shadowTaps;
  }

  /** Draw this frame's shadow maps (after the culler and the light rig, before the scene). */
  render(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, f: TierFeatures) {
    this.frame++;
    this.stats.flash = this.stats.lampFaces = this.stats.lampCopies = this.stats.moving = this.stats.moon = 0;
    const prevTarget = renderer.getRenderTarget();
    const prevFn = renderer.getRenderObjectFunction();
    const prevBg = scene.background;
    const prevClear = renderer.getClearColor(this.clear).clone();
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    // Casters only, in the distance material.
    renderer.setRenderObjectFunction((object, sc, cam, geometry, material, group, lightsNode, clipping, passId) => {
      const o = object as THREE.Mesh;
      if (!o.isMesh || (o as unknown as { isSprite?: boolean }).isSprite) return;
      const pass = this.pass;
      if (pass !== 'all' && (pass === 'static' ? this.tiny.has(o) || this.isMoving(o) : !pass.has(o))) return;
      const m = casterMaterial(material, pass !== 'all' && pass !== 'static');
      if (m) renderer.renderObject(object, sc, cam, geometry, m, group, lightsNode, clipping, passId);
    });
    scene.background = null;
    renderer.setClearColor(0xffffff, 1);
    EU.flipY.value = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? 1 : 0;
    try {
      // Flashlight: from the lamp, along the view axis.
      this.pass = 'all';
      EU.flShadowOn.value = 0;
      const lit = EU.flColor.value.lengthSq() > 0;
      if (f.flashShadowSize > 0 && lit) {
        const cam = this.flashCam;
        cam.position.copy(EU.flPos.value);
        cam.lookAt(this.tmpV.copy(EU.flPos.value).add(EU.flDir.value));
        cam.far = FLASH_SHADOW_REACH;
        cam.layers.mask = camera.layers.mask;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        origin.value.copy(cam.position);
        range.value = FLASH.range;
        ortho.value = 0;
        renderer.setRenderTarget(targets.flash);
        renderer.render(scene, cam);
        EU.flShadowMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        EU.flShadowOn.value = 1;
        this.stats.flash = 1;
      }
      this.renderLamps(renderer, scene, camera, f);
      // Moonlight: an orthographic box around the camera, snapped to its texels. Its map and
      // matrix change together, so a map kept for a frame is still consistent.
      this.pass = 'all';
      EU.moonOn.value = 0;
      if (f.moonShadowSize > 0 && enhancedLights.moon) {
        if (!this.moonValid || this.frame % MOON_EVERY === 0) {
          const cam = this.moonCam;
          const eye = camera.getWorldPosition(this.tmpV);
          const dir = EU.moonDir.value as THREE.Vector3;
          cam.position.copy(eye).addScaledVector(dir, 80);
          cam.up.set(0, 1, 0);
          if (Math.abs(dir.y) > 0.99) cam.up.set(0, 0, 1);
          cam.lookAt(eye);
          cam.updateMatrixWorld();
          // Texel snapping keeps the shafts from crawling as the camera moves.
          const texel = 80 / Math.max(1, f.moonShadowSize);
          const ls = eye.clone().applyMatrix4(cam.matrixWorldInverse);
          cam.position.add(new THREE.Vector3(Math.round(ls.x / texel) * texel - ls.x, Math.round(ls.y / texel) * texel - ls.y, 0).applyQuaternion(cam.quaternion));
          cam.updateMatrixWorld();
          cam.layers.mask = camera.layers.mask;
          cam.updateProjectionMatrix();
          origin.value.copy(cam.position);
          fwd.value.copy(dir).negate();
          range.value = 160;
          ortho.value = 1;
          renderer.setRenderTarget(targets.moon);
          renderer.render(scene, cam);
          EU.moonMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
          this.moonValid = true;
          this.stats.moon = 1;
        }
        EU.moonOn.value = 1;
      } else this.moonValid = false;
    } finally {
      this.pass = 'all';
      renderer.autoClear = prevAuto;
      renderer.setRenderObjectFunction(prevFn);
      renderer.setRenderTarget(prevTarget);
      scene.background = prevBg;
      renderer.setClearColor(prevClear, prevAlpha);
    }
  }

  /** Moving (or animated) this frame: drawn by the per-frame pass, not into the static cube. */
  private isMoving(o: THREE.Object3D): boolean {
    for (const c of this.caches) if (c.dyn.has(o)) return true;
    return false;
  }

  /**
   * Lamp cube maps: static faces drawn again where something changed (at most
   * `lampFacesPerFrame` per lamp and frame, all six for a newly chosen lamp), then every face
   * that changed or holds moving casters rebuilt: the static face copied in, the moving casters
   * drawn over it.
   */
  private renderLamps(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, f: TierFeatures) {
    const active: { s: number; p: THREE.Vector3; cache: CubeCache; full: boolean }[] = [];
    for (let s = 0; s < MAX_SHADOW_LAMPS; s++) {
      const pick = s < f.lampShadows ? enhancedLights.shadowed[s] : null;
      const cache = this.caches[s];
      if (!pick) {
        cache.key = '';
        cache.dyn.clear();
        continue;
      }
      const cc = this.cubeCams[s];
      const key = `${pick.x.toFixed(2)},${pick.y.toFixed(2)},${pick.z.toFixed(2)}`;
      let full = false;
      if (cc.coordinateSystem !== renderer.coordinateSystem) {
        cc.coordinateSystem = renderer.coordinateSystem;
        cc.updateCoordinateSystem();
        cache.key = '';
      }
      if (key !== cache.key) {
        Object.assign(cache, newCache(), { key });
        cc.position.set(pick.x, pick.y, pick.z);
        cc.updateMatrixWorld(true);
        (cc.children as THREE.Camera[]).forEach((c, k) => {
          const d = c.getWorldDirection(this.tmpV);
          const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
          const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
          cache.axes[k] = i + ([d.x, d.y, d.z][i] < 0 ? 3 : 0);
        });
        full = true;
      }
      if (cache.layers !== camera.layers.mask) {
        cache.layers = camera.layers.mask;
        cache.stale = ALL_FACES;
      }
      for (const rt of [targets.lamps[s], targets.still[s]]) {
        if (!this.inited.has(rt)) (renderer.initRenderTarget(rt), this.inited.add(rt));
      }
      active.push({ s, p: cc.position, cache, full });
    }
    if (!active.length) return;
    this.scan(scene, camera, active);
    range.value = LAMP_SHADOW_RANGE;
    ortho.value = 0;
    for (const { s, p, cache, full } of active) {
      origin.value.copy(p);
      const cams = this.cubeCams[s].children as THREE.PerspectiveCamera[];
      for (const c of cams) c.layers.mask = camera.layers.mask;
      // Static faces, round robin.
      const cap = full ? 6 : Math.max(1, f.lampFacesPerFrame);
      this.pass = 'static';
      renderer.autoClear = true;
      for (let k = 0, n = 0; k < 6 && n < cap; k++) {
        const face = (cache.next + k) % 6;
        if (!(cache.stale & (1 << face))) continue;
        renderer.setRenderTarget(targets.still[s], face);
        renderer.render(scene, cams[face]);
        cache.stale &= ~(1 << face);
        cache.fresh |= 1 << face;
        cache.next = (face + 1) % 6;
        n++;
        this.stats.lampFaces++;
      }
      // The live faces: static copy, then the moving casters (MIN blend, no clear).
      const rebuild = cache.fresh | cache.dynMask | cache.dynPrev;
      const size = targets.still[s].width;
      this.pass = cache.dyn;
      renderer.autoClear = false;
      // (The moving pass walks only the moving casters: the scene's own children are swapped out
      // for the draw, which three.js's projection walk allows because the scene's world matrices
      // are updated by the renderer, not by render(). Walking the whole scene cost 0.65 ms a face.)
      const kids = scene.children;
      const swap = !scene.matrixWorldAutoUpdate;
      try {
        if (swap) scene.children = [...cache.dyn];
        for (let face = 0; face < 6; face++) {
          if (!(rebuild & (1 << face))) continue;
          this.region.min.set(0, 0, face);
          this.region.max.set(size, size, face + 1);
          renderer.copyTextureToTexture(targets.still[s].texture, targets.lamps[s].texture, this.region, this.at.set(0, 0, face));
          this.stats.lampCopies++;
          if (cache.dynMask & (1 << face)) {
            renderer.setRenderTarget(targets.lamps[s], face);
            renderer.render(scene, cams[face]);
          }
        }
      } finally {
        scene.children = kids;
        renderer.autoClear = true;
      }
      this.stats.moving += cache.dyn.size;
      cache.dynPrev = cache.dynMask;
      cache.fresh = 0;
    }
  }

  /**
   * Once per frame: the casters within reach of the shadowed lamps. Moving ones (skinned, or
   * transformed within STILL_FRAMES) go to each lamp's per-frame set with the faces they touch;
   * a static one that appeared, changed (drawn range, index, geometry, transform) or went away
   * marks the faces it showed in, before and after, to be drawn again.
   */
  private scan(scene: THREE.Scene, camera: THREE.Camera, active: { p: THREE.Vector3; cache: CubeCache }[]) {
    const frame = this.frame;
    for (const a of active) (a.cache.dyn.clear(), (a.cache.dynMask = 0));
    const c = this.tmpC, v = this.tmpV;
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (o as unknown as { isSprite?: boolean }).isSprite || !o.layers.test(camera.layers)) return;
      const mat = mesh.material;
      if (Array.isArray(mat) ? !mat.some(castsShadow) : !castsShadow(mat)) return;
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const bs = g.boundingSphere;
      if (!bs || !(bs.radius >= 0) || !Number.isFinite(bs.radius)) return;
      const skinned = (o as THREE.SkinnedMesh).isSkinnedMesh === true;
      c.copy(bs.center).applyMatrix4(o.matrixWorld);
      const r = bs.radius * o.matrixWorld.getMaxScaleOnAxis() + (skinned ? SKIN_MARGIN : 0);
      if (r < MIN_CASTER) return void this.tiny.add(o);
      let near = false;
      for (const a of active) if (c.distanceTo(a.p) - r <= LAMP_SHADOW_RANGE) near = true;
      if (!near) return;
      const e = o.matrixWorld.elements;
      const motion = e[0] + e[1] * 3.1 + e[2] * 5.7 + e[4] * 7.3 + e[5] * 11.9 + e[6] * 13.1 + e[8] * 17.3 + e[9] * 19.7 + e[10] * 23.1 + e[12] * 29.3 + e[13] * 31.7 + e[14] * 37.1;
      let mv = this.motion.get(o);
      if (!mv) this.motion.set(o, (mv = { sig: motion, at: -1e9 }));
      else if (mv.sig !== motion) (mv.sig = motion), (mv.at = frame);
      const moving = skinned || frame - mv.at < STILL_FRAMES;
      const m0 = Array.isArray(mat) ? mat[0] : mat;
      const content = motion + g.id * 1.618 + g.drawRange.start * 0.37 + Math.min(g.drawRange.count, 1e9) * 0.013 + (g.index?.version ?? 0) * 0.71 + ((m0 as unknown as { id?: number })?.id ?? 0) * 0.29;
      for (const { p, cache } of active) {
        const mask = cubeFaceMask(v.subVectors(c, p), r, LAMP_SHADOW_RANGE, cache.axes);
        const prev = cache.objs.get(o);
        if (moving || !mask) {
          if (moving && mask) (cache.dyn.add(o), (cache.dynMask |= mask));
          if (prev) (cache.stale |= prev.mask), cache.objs.delete(o);
          continue;
        }
        if (!prev) {
          cache.objs.set(o, { sig: content, mask, seen: frame });
          cache.stale |= mask;
        } else {
          if (prev.sig !== content) (cache.stale |= prev.mask | mask), (prev.sig = content), (prev.mask = mask);
          prev.seen = frame;
        }
      }
    });
    for (const { cache } of active)
      for (const [o, en] of cache.objs)
        if (en.seen !== frame) {
          cache.stale |= en.mask;
          cache.objs.delete(o);
        }
  }
}
