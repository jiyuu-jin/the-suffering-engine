// Enhanced mode volumetric light (docs/enhanced.md §Volumetrics): light scattered towards the eye by
// the level's own fog. Materials already apply the level's fog (its colour over its start / end
// distances, linearised: shading.ts fog); this pass adds what that fog would glow with:
//
//   - the flashlight's beam, shadowed by its shadow map (the bars of a cell door cut the beam);
//   - halos and shafts around the lamps (the engine's point lights, flicker included), the
//     cube-shadowed ones with their shadows;
//   - moonlight shafts (the dominant Directional Light, through its orthographic shadow map):
//     windows, the yard at night, the trees of the woods.
//
// Ray-marched per pixel from the camera to the depth buffer (or the fog end), at a reduced
// resolution with interleaved-gradient jitter that the temporal AA resolves. Density follows the
// level's fog distance (thicker fog, denser air) and a slowly drifting 3D noise: dust.

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  array,
  inverseSqrt,
  Loop,
  NodeUpdateType,
  dot,
  float,
  getViewPosition,
  int,
  interleavedGradientNoise,
  mix,
  passTexture,
  pow,
  screenCoordinate,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  context,
  texture3D,
} from 'three/tsl';
import { engineLightInternals } from '../engine-light';
import { EU, FLASH, FLASH_NEAR, LAMP_SHADOW_RANGE, lampArray, lampLit } from './lights';
import { shadowTextures } from './shadows';
import { DUST_PERIOD, DUST_SIZE, bakeDustNoise } from './dust-noise';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const _quad = new THREE.QuadMesh(undefined as unknown as THREE.NodeMaterial);

/** The dust noise, baked once per page (dust-noise.ts): one trilinear fetch per step (also light-volume-pass.ts). */
let dustTexture: THREE.Data3DTexture | null = null;
export function dust(): THREE.Data3DTexture {
  if (!dustTexture) {
    const t = new THREE.Data3DTexture(bakeDustNoise(), DUST_SIZE, DUST_SIZE, DUST_SIZE);
    t.format = THREE.RedFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.name = 'enhanced-dust';
    t.needsUpdate = true;
    dustTexture = t;
  }
  return dustTexture;
}
const _size = new THREE.Vector2();

/** Henyey-Greenstein phase function. */
const phaseHG = (cosT: N, g: number): N => {
  const g2 = g * g;
  const x = float(1 + g2).sub(cosT.mul(2 * g));
  return float((1 - g2) / (4 * Math.PI)).div(x.mul(x.sqrt()));
};

export class VolumetricNode extends THREE.TempNode {
  static get type() {
    return 'EnhancedVolumetricNode';
  }
  resolutionScale = 0.5;
  /** Ray-march steps (rebuilds the shader when changed). */
  steps = 16;
  /** Scattering scale (× 1 / fog end), dust noise strength. */
  readonly density = uniform(1);
  readonly dust = uniform(0.6);
  readonly flashScatter = uniform(0.1);
  readonly lampScatter = uniform(0.25);
  readonly moonScatter = uniform(0.25);
  private readonly rt = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly material = new THREE.NodeMaterial();
  private readonly projInv: N;
  private readonly camWorld: N;
  private readonly frameJitter = uniform(0);
  private readonly textureNode: N;
  private built = -1;
  private sharedContext: unknown = null;
  private fragment: (() => N) | null = null;

  constructor(
    private readonly depthNode: N,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.rt.texture.name = 'enhanced-volumetric';
    this.material.name = 'enhanced-volumetric';
    this.projInv = uniform(camera.projectionMatrixInverse);
    this.camWorld = uniform(camera.matrixWorld);
    this.textureNode = passTexture(this as unknown as THREE.PassNode, this.rt.texture);
  }

  getTextureNode(): N {
    return this.textureNode;
  }

  updateBefore(frame: THREE.NodeFrame): undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const size = renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.round(size.x * this.resolutionScale)), h = Math.max(1, Math.round(size.y * this.resolutionScale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.frameJitter.value = ((frame.frameId ?? 0) % 64) * 5.588238;
    if (this.built !== this.steps && this.fragment) {
      this.built = this.steps;
      this.material.contextNode = context(this.sharedContext as never);
      this.material.fragmentNode = this.fragment();
      this.material.needsUpdate = true;
    }
    const prev = renderer.getRenderTarget();
    _quad.material = this.material;
    renderer.setRenderTarget(this.rt);
    _quad.render(renderer);
    renderer.setRenderTarget(prev);
    return undefined;
  }

  setup(builder: N): N {
    const { u } = engineLightInternals();
    const camera = this.camera;
    this.fragment = () =>
      Fn(() => {
        const p = uv();
        const depth = this.depthNode.sample(p).r;
        const view = getViewPosition(p, depth, this.projInv);
        const world = this.camWorld.mul(vec4(view, 1)).xyz;
        const eye = this.camWorld.mul(vec4(0, 0, 0, 1)).xyz;
        const ray = world.sub(eye);
        const sky = step(0.99999, depth);
        const fogEnd = float(u.fogFar).max(4);
        const fogStart = float(u.fogNear);
        const len = mix(ray.length(), fogEnd, sky).min(fogEnd).min(60);
        const dir = ray.normalize();
        const n = this.steps;
        const stepLen = len.div(n);
        const jitter = interleavedGradientNoise(screenCoordinate.xy.add(this.frameJitter));
        const sigma = this.density.mul(1.4).div(fogEnd);
        const acc = vec3(0).toVar();
        // Each step's dens × T × length, kept for the lamp loop (lampHalos).
        const weights: N = array('float', n).toVar();
        const dustTex: N = texture3D(dust());
        const drift = vec3(EU.time.mul(0.05), EU.time.mul(0.02), EU.time.mul(-0.03));
        Loop(n, ({ i }: { i: N }) => {
          const t = float(i).add(jitter).mul(stepLen);
          const P = eye.add(dir.mul(t));
          // The authored fog's transmittance to this point (linear ramp, start .. end).
          const T = float(1).sub(t.sub(fogStart).div(fogEnd.sub(fogStart).max(1e-3)).clamp(0, 1));
          // (MaterialX Perlin noise, baked: dust-noise.ts.)
          const noise = dustTex.sample(P.mul(0.45).add(drift).div(DUST_PERIOD)).level(0).r.mul(2).sub(1);
          const dens = sigma.mul(float(1).add(noise.mul(this.dust)).max(0.05));
          const light = vec3(0).toVar();
          // Flashlight beam (its shadow lookup only inside the beam: outside it adds nothing).
          const fl = EU.flPos.sub(P);
          const fd2 = dot(fl, fl).max(0.04);
          const fd = fd2.sqrt();
          const fdir = fl.div(fd);
          const c = dot(fdir.negate(), EU.flDir);
          const cone = smoothstep(EU.flCone.x, EU.flCone.y, c);
          const win = float(1).sub(pow(fd.div(EU.flRange).clamp(0, 1), 4)).clamp(0, 1);
          const beam = cone.mul(win).mul(smoothstep(EU.flStart.x, EU.flStart.y, dot(fl.negate(), EU.flDir))).toVar();
          If(beam.greaterThan(0), () => {
            const sp = EU.flShadowMatrix.mul(vec4(P, 1));
            const ndc = sp.xyz.div(sp.w.max(1e-4));
            const suv = vec2(ndc.x.mul(0.5).add(0.5), mix(ndc.y.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5), EU.flipY));
            const occ = step(fd.div(FLASH.range).sub(0.004), shadowTextures.flash.sample(suv).level(0).r);
            const shadow = mix(float(1), occ, EU.flShadowOn.mul(step(ndc.x.abs(), 1)).mul(step(ndc.y.abs(), 1)));
            light.addAssign(EU.flColor.mul(beam.mul(shadow).div(fd2.add(FLASH_NEAR))).mul(phaseHG(dot(dir.negate(), fdir), 0.35)).mul(this.flashScatter));
          });
          // (The lamps' halos and shafts: lampHalos, after the march, from the kept weights.)
          // Moonlight shafts (none without a moonlight shadow map: a uniform branch).
          If(EU.moonOn.greaterThan(0.5), () => {
            const mp = EU.moonMatrix.mul(vec4(P, 1));
            const muv = vec2(mp.x.mul(0.5).add(0.5), mix(mp.y.mul(0.5).add(0.5), mp.y.mul(-0.5).add(0.5), EU.flipY));
            const mStored = shadowTextures.moon.sample(muv).level(0).r;
            const mDepth = P.sub(eye).dot(EU.moonDir.negate()).add(80).div(160);
            const mLit = step(mDepth.sub(0.002), mStored).mul(step(mp.x.abs(), 1)).mul(step(mp.y.abs(), 1)).mul(EU.moonOn);
            // Fade towards the map's edges (no hard wall where the box ends).
            const edge = smoothstep(1, 0.8, mp.x.abs().max(mp.y.abs()));
            light.addAssign(EU.moonColor.mul(mLit.mul(edge)).mul(phaseHG(dot(dir, EU.moonDir), 0.55)).mul(this.moonScatter).mul(1.2));
          });
          const w = dens.mul(T).mul(stepLen);
          weights.element(i).assign(w);
          acc.addAssign(light.mul(w));
        });
        acc.addAssign(this.lampHalos(eye, dir, stepLen, jitter, weights));
        return vec4(acc, 1);
      })();
    void camera;
    void builder;
    this.sharedContext = builder.getSharedContext();
    this.built = this.steps;
    this.material.contextNode = context(this.sharedContext as never);
    this.material.fragmentNode = this.fragment();
    this.material.needsUpdate = true;
    return this.textureNode;
  }

  /**
   * Halos around the lamps (engine point lights), shafts for the cube-shadowed ones: Σ over lamps
   * of colour × Σ over steps of weight × min(I / max(d², 0.02), 2) × shadow × HG phase. The same
   * sum, steps and jitter as a lamp loop inside each step, reordered (docs/perf.md Perf D): the
   * lamp loop outside the step loop, its offset from the eye taken once, so that a step is a few
   * scalar operations (|v|² from the ray parameter, two inverse square roots; the colour, the
   * scatter gain and the phase constant multiply the lamp's sum once), and the shadowed / plain
   * choice is made per lamp, not per step. At High (6 lamps × 24 steps) the pass took 16.6 ms at
   * 3456 x 2234 before, 11.3 after.
   */
  private lampHalos(eye: N, dir: N, stepLen: N, jitter: N, weights: N): N {
    const n = this.steps;
    const g = 0.25;
    const total = vec3(0).toVar();
    Loop(EU.lampCount, ({ i: k }: { i: N }) => {
      const a = lampArray.element(int(k).mul(2));
      const b = lampArray.element(int(k).mul(2).add(1));
      const w0 = eye.sub(a.xyz).toVar();
      const I = a.w.toVar();
      // |v|² = |w0 + dir t|² = c0 + t (2 c1 + t) and v·dir = c1 + t (dir is unit length).
      const c1 = dot(w0, dir).toVar();
      const c0 = dot(w0, w0).toVar();
      const c2 = c1.mul(2).toVar();
      const sum = float(0).toVar();
      // One step of lamp k: weight × min(I / max(d², 0.02), 2) × HG phase (without its
      // constant: x^-1.5 with x = 1 + g² − 2g cos) × `lit`.
      const term = (i: N, lit: ((v: N, vv: N) => N) | null) => {
        const t = float(i).add(jitter).mul(stepLen);
        const vv = t.add(c2).mul(t).add(c0).max(1e-8);
        const r = inverseSqrt(vv);
        const rx = inverseSqrt(float(1 + g * g).sub(c1.add(t).mul(r).mul(2 * g)));
        let s: N = weights.element(i).mul(I.mul(r.mul(r).min(50)).min(2)).mul(rx.mul(rx).mul(rx));
        if (lit) s = s.mul(lit(w0.add(dir.mul(t)), vv));
        sum.addAssign(s);
      };
      const shadowed = (cube: N) => (v: N, vv: N) => lampLit(vv.max(0.02).sqrt().div(LAMP_SHADOW_RANGE).sub(0.006), cube.sample(v).level(float(0)).r);
      If(b.w.lessThan(-0.5), () => {
        Loop(n, ({ i }: { i: N }) => term(i, null));
      })
        .ElseIf(b.w.lessThan(0.5), () => {
          Loop(n, ({ i }: { i: N }) => term(i, shadowed(shadowTextures.lamp0)));
        })
        .Else(() => {
          Loop(n, ({ i }: { i: N }) => term(i, shadowed(shadowTextures.lamp1)));
        });
      total.addAssign(b.xyz.max(0).mul(sum));
    });
    return total.mul(this.lampScatter.mul(0.6 * ((1 - g * g) / (4 * Math.PI))));
  }

  dispose() {
    super.dispose();
    this.rt.dispose();
    this.material.dispose();
  }
}
