// Enhanced mode shadow maps (docs/enhanced.md §Shadows): the flashlight (perspective), up to two
// lamps (cube maps, a few faces per frame round robin: lamps do not move, characters do) and the
// moonlight (orthographic, around the camera; volumetric shafts only).
//
// Each map stores the distance to the light as a fraction of its range (cleared to 1), drawn with
// one shared distance material; alpha-tested surfaces (bars, grates, foliage) use a cut-out copy
// that reads their texture's alpha, and blended / sprite / line objects cast nothing. The scene is
// drawn with the zone culler's choice of the frame (only what the camera's zones show), through
// the renderer's render-object hook, so nothing in the scene graph is touched.

import * as THREE from 'three/webgpu';
import { float, positionWorld, texture, uniform, uv, vec4 } from 'three/tsl';
import { FLASH, LAMP_SHADOW_RANGE, MAX_SHADOW_LAMPS, EU, enhancedLights } from './lights';
import type { TierFeatures } from './config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const distTarget = (size: number) => {
  const rt = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: true });
  rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  rt.texture.generateMipmaps = false;
  rt.texture.name = 'enhanced-shadow';
  return rt;
};
const cubeTarget = (size: number) => {
  const rt = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: true });
  rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  rt.texture.generateMipmaps = false;
  rt.texture.name = 'enhanced-lamp-shadow';
  return rt;
};

const targets = {
  flash: distTarget(1),
  lamps: [cubeTarget(1), cubeTarget(1)],
  moon: distTarget(1),
};

/** Texture nodes the shading samples (their targets are resized per tier). */
export const shadowTextures: { flash: N; lamp0: THREE.Texture; lamp1: THREE.Texture; moon: N } = {
  flash: texture(targets.flash.texture),
  lamp0: targets.lamps[0].texture,
  lamp1: targets.lamps[1].texture,
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
const makeDistMaterial = (map?: THREE.Texture, alphaTest = 0) => {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.colorNode = vec4(stored, 0, 0, map ? texture(map, uv()).a : float(1));
  m.fog = false;
  m.alphaTest = alphaTest;
  m.name = map ? 'enhanced-shadow-cut' : 'enhanced-shadow';
  return m;
};
const solid = makeDistMaterial();
const cutouts = new Map<string, THREE.Material>();
function casterMaterial(m: THREE.Material): THREE.Material | null {
  if (m.transparent || (m as { userData: { noShadow?: boolean } }).userData.noShadow) return null;
  if (!(m.alphaTest > 0)) return solid;
  const map = (m as THREE.MeshStandardMaterial).map ?? (m as { surfaceSlots?: { t: THREE.Texture[] } }).surfaceSlots?.t[0];
  if (!map) return solid;
  const k = `${map.uuid}|${m.alphaTest}`;
  let c = cutouts.get(k);
  if (!c) cutouts.set(k, (c = makeDistMaterial(map, m.alphaTest)));
  return c;
}

export class EnhancedShadows {
  private readonly flashCam = new THREE.PerspectiveCamera(2 * THREE.MathUtils.radToDeg(FLASH.outer) * 1.25, 1, 0.1, FLASH.range);
  private readonly cubeCams = [new THREE.CubeCamera(0.05, LAMP_SHADOW_RANGE, targets.lamps[0]), new THREE.CubeCamera(0.05, LAMP_SHADOW_RANGE, targets.lamps[1])];
  private readonly moonCam = new THREE.OrthographicCamera(-40, 40, 40, -40, 0, 160);
  /** Which lamp each cube currently holds, and the next face to draw. */
  private readonly cubeKey = ['', ''];
  private readonly nextFace = [0, 0];
  private readonly clear = new THREE.Color();
  stats = { flash: 0, lampFaces: 0, moon: 0 };

  /** Resize the maps for a tier (cheap when unchanged). */
  configure(f: TierFeatures) {
    const fs = Math.max(1, f.flashShadowSize);
    if (targets.flash.width !== fs) targets.flash.setSize(fs, fs);
    const ls = Math.max(1, f.lampShadowSize);
    for (let i = 0; i < MAX_SHADOW_LAMPS; i++) {
      if (targets.lamps[i].width !== ls) {
        targets.lamps[i].setSize(ls, ls);
        this.cubeKey[i] = '';
      }
    }
    const ms = Math.max(1, f.moonShadowSize);
    if (targets.moon.width !== ms) targets.moon.setSize(ms, ms);
    EU.flShadowTexel.value = 1 / fs;
    EU.taps.value = f.shadowTaps;
  }

  /** Draw this frame's shadow maps (after the culler and the light rig, before the scene). */
  render(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, f: TierFeatures) {
    this.stats.flash = this.stats.lampFaces = this.stats.moon = 0;
    const prevTarget = renderer.getRenderTarget();
    const prevFn = renderer.getRenderObjectFunction();
    const prevBg = scene.background;
    const prevClear = renderer.getClearColor(this.clear).clone();
    const prevAlpha = renderer.getClearAlpha();
    // Casters only, in the distance material.
    renderer.setRenderObjectFunction((object, sc, cam, geometry, material, group, lightsNode, clipping, passId) => {
      const o = object as THREE.Mesh;
      if (!o.isMesh || (o as unknown as { isSprite?: boolean }).isSprite) return;
      const m = casterMaterial(material);
      if (m) renderer.renderObject(object, sc, cam, geometry, m, group, lightsNode, clipping, passId);
    });
    scene.background = null;
    renderer.setClearColor(0xffffff, 1);
    EU.flipY.value = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? 1 : 0;
    try {
      // Flashlight: from the lamp, along the view axis.
      EU.flShadowOn.value = 0;
      const lit = EU.flColor.value.lengthSq() > 0;
      if (f.flashShadowSize > 0 && lit) {
        const cam = this.flashCam;
        cam.position.copy(EU.flPos.value);
        cam.lookAt(this.tmpTarget.copy(EU.flPos.value).add(EU.flDir.value));
        cam.far = FLASH.range;
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
      // Lamps: faces round robin (all six when the lamp changed).
      for (let s = 0; s < MAX_SHADOW_LAMPS; s++) {
        const p = s < f.lampShadows ? enhancedLights.shadowed[s] : null;
        if (!p) {
          this.cubeKey[s] = '';
          continue;
        }
        const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
        const cc = this.cubeCams[s];
        let faces = f.lampFacesPerFrame;
        if (key !== this.cubeKey[s]) {
          this.cubeKey[s] = key;
          faces = 6;
          cc.position.set(p.x, p.y, p.z);
          cc.updateMatrixWorld(true);
        }
        if (cc.coordinateSystem !== renderer.coordinateSystem) {
          cc.coordinateSystem = renderer.coordinateSystem;
          cc.updateCoordinateSystem();
        }
        origin.value.set(p.x, p.y, p.z);
        range.value = LAMP_SHADOW_RANGE;
        ortho.value = 0;
        const cams = cc.children as THREE.PerspectiveCamera[];
        for (let k = 0; k < faces; k++) {
          const face = this.nextFace[s];
          this.nextFace[s] = (face + 1) % 6;
          const c = cams[face];
          c.layers.mask = camera.layers.mask;
          renderer.setRenderTarget(targets.lamps[s], face);
          renderer.render(scene, c);
          this.stats.lampFaces++;
        }
      }
      // Moonlight: an orthographic box around the camera, snapped to its texels.
      EU.moonOn.value = 0;
      if (f.moonShadowSize > 0 && enhancedLights.moon) {
        const cam = this.moonCam;
        const eye = camera.getWorldPosition(this.tmpTarget);
        const dir = EU.moonDir.value as THREE.Vector3;
        cam.position.copy(eye).addScaledVector(dir, 80);
        cam.up.set(0, 1, 0);
        if (Math.abs(dir.y) > 0.99) cam.up.set(0, 0, 1);
        cam.lookAt(eye);
        cam.updateMatrixWorld();
        // Texel snapping keeps the shafts from crawling as the camera moves.
        const texel = 80 / Math.max(1, f.moonShadowSize);
        const ls = eye.clone().applyMatrix4(cam.matrixWorldInverse);
        cam.position.add(new THREE.Vector3((Math.round(ls.x / texel) * texel - ls.x), (Math.round(ls.y / texel) * texel - ls.y), 0).applyQuaternion(cam.quaternion));
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
        EU.moonOn.value = 1;
        this.stats.moon = 1;
      }
    } finally {
      renderer.setRenderObjectFunction(prevFn);
      renderer.setRenderTarget(prevTarget);
      scene.background = prevBg;
      renderer.setClearColor(prevClear, prevAlpha);
    }
  }
  private readonly tmpTarget = new THREE.Vector3();
}
