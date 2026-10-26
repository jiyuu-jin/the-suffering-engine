// Enhanced mode: light volumes integrated per pixel (docs/enhanced.md "Light volumes").
//
// The level's light shafts (fitted by light-volume.ts takeLightShafts) and Killjoy's projector
// beams (projector.ts, dynamic volumes) are soft frusta. For each pixel the eye's ray is clipped
// to a volume's box and to the scene's depth (a body standing in the shaft hides the light
// behind it, not in front of it), and the light along the clipped segment is summed: density
// (a superellipse section fading over its outer `soft` part, both ends faded in) x the walls'
// own light profile x slowly drifting dust, times the volume's gain (its brightness budget:
// what its sheets added over a spread of views) and the fog to black the sheets had. So a shaft
// thins out to nothing at its sides, is brightest where the eye looks along it, and stops at
// whatever stands in it. Its own pass at half the render scale (LightVolumeNode), skipped in a
// frame with no volume in view; added to the HDR scene before TRAA (whose jitter then resolves
// the stratified steps). Cost: 0.28 ms at High in the 1b arena (four shafts, 796 x 539), none
// where no volume is in view (1a's gas chamber).

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  NodeUpdateType,
  context,
  passTexture,
  Loop,
  dot,
  float,
  getViewPosition,
  int,
  interleavedGradientNoise,
  max,
  min,
  mix,
  pow,
  renderGroup,
  screenCoordinate,
  smoothstep,
  step,
  texture,
  texture3D,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { engineLightInternals } from '../engine-light';
import { emptyLightVolume, lightVolumeScene, LIGHT_SHAFT, type LightVolumeShape } from './light-volume';
import { dust } from './volumetric';
import { DUST_PERIOD } from './dust-noise';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Volumes drawn at once (the nearest in view); vec4s per volume. */
export const LIGHT_VOLUME_SLOTS = 8;
const SLOT = 10;
/** Steps per volume along the clipped segment. */
export const LIGHT_VOLUME_STEPS = 8;
/** Default of lightVolumePass.gain (see there). */
export const LIGHT_VOLUME_GAIN = 1;
/** additiveEffectColor's Enhanced HDR gain on additive effects (engine-light.ts ADDITIVE_HDR). */
const ADDITIVE_HDR = 1.6;

const slotData = Array.from({ length: LIGHT_VOLUME_SLOTS * SLOT }, () => new THREE.Vector4());
const slots: N = uniformArray(slotData, 'vec4').setGroup(renderGroup);

/** Console tuning / QA: `(await import('/src/app/enhanced/light-volume-pass.ts')).lightVolumePass`. */
export const lightVolumePass = {
  count: uniform(0, 'int').setGroup(renderGroup),
  /**
   * Overall gain on the fitted budget (light-volume.ts fitLightShaft: the walls' sum without the
   * |N·V| fade), dust contrast, the dust's size (m). At 1, the 1b arena evidence pose gains +3.5
   * display luma over the frame where the faded sheets gained +2.6 (the fade took a quarter).
   */
  gain: uniform(LIGHT_VOLUME_GAIN).setGroup(renderGroup),
  dust: uniform(0.35).setGroup(renderGroup),
  dustScale: uniform(0.7).setGroup(renderGroup),
  time: uniform(0).setGroup(renderGroup),
  jitter: uniform(0).setGroup(renderGroup),
  rows: uniform(1).setGroup(renderGroup),
  /** Last frame's choice (QA). */
  drawn: 0,
};

/** The profiles of the level's volumes: 16 steps per row, one row per volume. */
let lutTexture = blankLut();
let lutVersion = -1;
const lutNode: N = texture(lutTexture);

function blankLut(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4 * LIGHT_SHAFT.profileSteps).fill(255), LIGHT_SHAFT.profileSteps, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function rebuildLut() {
  const vols = lightVolumeScene.level;
  const w = LIGHT_SHAFT.profileSteps, h = Math.max(1, vols.length);
  const data = new Uint8Array(4 * w * h).fill(255);
  vols.forEach((v, r) => {
    if (!v.profile) return;
    for (let i = 0; i < w; i++) for (let k = 0; k < 3; k++) data[4 * (r * w + i) + k] = Math.round(255 * Math.min(1, Math.max(0, v.profile[3 * i + k])));
  });
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  lutTexture.dispose();
  lutTexture = t;
  lutNode.value = t;
  lightVolumePass.rows.value = h;
  lutVersion = lightVolumeScene.version;
}

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _dyn: LightVolumeShape[] = [];
const _pick: { s: LightVolumeShape; row: number; d: number }[] = [];

/** Write one volume into slot `i` (`row`: its profile row, -1 none). */
function writeSlot(i: number, s: LightVolumeShape, row: number) {
  const o = i * SLOT;
  const rx = Math.max(s.r0[0], s.r1[0]), ry = Math.max(s.r0[1], s.r1[1]);
  slotData[o].set(s.origin[0], s.origin[1], s.origin[2], s.length);
  slotData[o + 1].set(s.axis[0], s.axis[1], s.axis[2], row);
  slotData[o + 2].set(s.e1[0], s.e1[1], s.e1[2], s.gain);
  slotData[o + 3].set(s.e2[0], s.e2[1], s.e2[2], s.exponent);
  slotData[o + 4].set(s.c0[0], s.c0[1], s.r0[0], s.r0[1]);
  slotData[o + 5].set(s.c1[0], s.c1[1], s.r1[0], s.r1[1]);
  slotData[o + 6].set(s.colour[0], s.colour[1], s.colour[2], s.soft);
  slotData[o + 7].set(Math.min(s.c0[0], s.c1[0]) - rx, Math.min(s.c0[1], s.c1[1]) - ry, Math.max(s.c0[0], s.c1[0]) + rx, Math.max(s.c0[1], s.c1[1]) + ry);
  slotData[o + 8].set(Math.max(1e-3, s.endFade), s.focus ?? 0, (Math.max(s.r0[0], s.r1[0]) + Math.max(s.r0[1], s.r1[1])) / 2, s.cap ?? 0);
  slotData[o + 9].set(s.near ?? 0, 0, 0, 0);
}

/** Per frame (EnhancedRenderer.draw): the nearest volumes in view into the slots. */
export function updateLightVolumes(camera: THREE.Camera, time: number, frame: number) {
  if (lutVersion !== lightVolumeScene.version) rebuildLut();
  lightVolumePass.time.value = time;
  lightVolumePass.jitter.value = (frame % 64) * 5.588238;
  camera.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const eye = camera.getWorldPosition(_v);
  _pick.length = 0;
  const consider = (s: LightVolumeShape, row: number) => {
    _sphere.center.set(s.centre[0], s.centre[1], s.centre[2]);
    _sphere.radius = s.radius;
    if (!_frustum.intersectsSphere(_sphere)) return;
    _pick.push({ s, row, d: Math.max(0, _sphere.center.distanceTo(eye) - s.radius) });
  };
  lightVolumeScene.level.forEach((s, r) => consider(s, s.profile ? r : -1));
  let k = 0;
  for (const d of lightVolumeScene.dynamic) {
    const s = (_dyn[k] ??= emptyLightVolume());
    if (d.update(s)) (consider(s, -1), k++);
  }
  if (_pick.length > LIGHT_VOLUME_SLOTS) _pick.sort((a, b) => a.d - b.d);
  const n = Math.min(LIGHT_VOLUME_SLOTS, _pick.length);
  for (let i = 0; i < n; i++) writeSlot(i, _pick[i].s, _pick[i].row);
  lightVolumePass.count.value = n;
  lightVolumePass.drawn = n;
}
const _v = new THREE.Vector3();

/**
 * The volumes' light (linear HDR, added to the scene colour) for the pixel at uv(), from the
 * scene pass's depth. `jitter`: stratified steps offset per pixel and frame (TRAA tiers).
 */
export function lightVolumeLight(depthNode: N, camera: THREE.PerspectiveCamera, opts: { jitter: boolean }): N {
  const { u } = engineLightInternals();
  const projInv = uniform(camera.projectionMatrixInverse);
  const camWorld = uniform(camera.matrixWorld);
  const P = lightVolumePass;
  return Fn(() => {
    const total = vec3(0).toVar();
    If(P.count.greaterThan(0), () => {
      const p = uv();
      const depth = depthNode.sample(p).r;
      const view = getViewPosition(p, depth, projInv);
      const eye = camWorld.mul(vec4(0, 0, 0, 1)).xyz.toVar();
      const ray = camWorld.mul(vec4(view, 1)).xyz.sub(eye);
      const sceneT = mix(ray.length(), float(1e6), step(0.99999, depth)).toVar();
      const dir = ray.normalize().toVar();
      const fwd = camWorld.mul(vec4(0, 0, -1, 0)).xyz.normalize();
      const viewK = dot(dir, fwd).toVar();
      const jit: N = opts.jitter ? interleavedGradientNoise(screenCoordinate.xy.add(P.jitter)) : float(0.5);
      const dustTex: N = texture3D(dust());
      const drift = vec3(P.time.mul(0.04), P.time.mul(-0.03), P.time.mul(0.025));
      Loop(P.count, ({ i }: { i: N }) => {
        const b = int(i).mul(SLOT);
        const A = slots.element(b), B = slots.element(b.add(1)), C = slots.element(b.add(2)), D = slots.element(b.add(3));
        const E = slots.element(b.add(4)), F = slots.element(b.add(5)), G = slots.element(b.add(6)), H = slots.element(b.add(7)), I = slots.element(b.add(8)), J = slots.element(b.add(9));
        const oW = eye.sub(A.xyz);
        const lo = vec3(dot(oW, C.xyz), dot(oW, D.xyz), dot(oW, B.xyz)).toVar();
        const ldRaw = vec3(dot(dir, C.xyz), dot(dir, D.xyz), dot(dir, B.xyz));
        // (No zero components: the slab test divides by them.)
        const ld = ldRaw.add(step(ldRaw.abs(), vec3(1e-6)).mul(1e-6)).toVar();
        const ta = vec3(H.x, H.y, 0).sub(lo).div(ld), tb = vec3(H.z, H.w, A.w).sub(lo).div(ld);
        const tn = min(ta, tb), tf = max(ta, tb);
        const t0 = max(max(tn.x, tn.y), max(tn.z, 0)).toVar();
        const t1 = min(min(tf.x, tf.y), min(tf.z, sceneT)).toVar();
        If(t1.greaterThan(t0), () => {
          const ds = t1.sub(t0).div(LIGHT_VOLUME_STEPS).toVar();
          const acc = vec3(0).toVar();
          const row = B.w;
          const rowV = row.add(0.5).div(P.rows);
          Loop(LIGHT_VOLUME_STEPS, ({ i: j }: { i: N }) => {
            const t = t0.add(float(j).add(jit).mul(ds));
            const q = lo.add(ld.mul(t));
            const f = q.z.div(A.w).clamp(0, 1);
            const c = mix(E.xy, F.xy, f);
            const r: N = mix(E.zw, F.zw, f).max(1e-3);
            const qq = q.xy.sub(c).div(r).abs().max(1e-4);
            // Superellipse norm of exponent D.w (2 round .. 4 boxy).
            const d = pow(pow(qq.x, D.w).add(pow(qq.y, D.w)), float(1).div(D.w));
            const edge = float(1).sub(smoothstep(float(1).sub(G.w), 1, d));
            const ends = smoothstep(0, I.x, q.z).mul(smoothstep(0, I.x, A.w.sub(q.z)));
            // (Focus: a beam's light per section is the same along it; I.y 0 = 1.)
            const focus = pow(I.z.div(r.x.add(r.y).mul(0.5)).clamp(1, 12), I.y);
            const prof = mix(vec3(1), lutNode.sample(vec2(f.mul((LIGHT_SHAFT.profileSteps - 1) / LIGHT_SHAFT.profileSteps).add(0.5 / LIGHT_SHAFT.profileSteps), rowV)).level(0).rgb, step(0, row));
            // (Beams: none within J.x metres of the eye.)
            const nearF = smoothstep(J.x.mul(0.25), J.x, t).max(step(J.x, 0));
            acc.addAssign(prof.mul(edge.mul(ends).mul(focus).mul(nearF)));
          });
          // Dust: one fetch per segment, at its middle (the noise is metres wide; per step it
          // cost a 3D fetch each and showed no more).
          const wp = eye.add(dir.mul(t0.add(t1).mul(0.5)));
          const n = dustTex.sample(wp.div(P.dustScale).add(drift).div(DUST_PERIOD)).level(0).r.mul(2).sub(1);
          acc.mulAssign(float(1).add(n.mul(P.dust)).max(0));
          // The sheets' fog to black, at the segment's middle.
          const vz = t0.add(t1).mul(0.5).mul(viewK);
          const fog = vz.sub(u.fogNear).div(float(u.fogFar).sub(u.fogNear).max(1e-3)).clamp(0, 1);
          const light = acc.mul(ds).mul(C.w).toVar();
          // (Beams: saturating towards I.w, light = cap (1 - e^(-x / cap)).)
          If(I.w.greaterThan(0), () => {
            light.assign(float(1).sub(light.div(I.w).negate().exp()).mul(I.w));
          });
          total.addAssign(light.mul(G.xyz).mul(float(1).sub(fog)));
        });
      });
    });
    return total.mul(P.gain.mul(ADDITIVE_HDR));
  })();
}

const _quad = new THREE.QuadMesh(undefined as unknown as THREE.NodeMaterial);
const _size = new THREE.Vector2();

/**
 * The volumes' light as a pass of its own (post.ts adds its texture to the scene): rendered at
 * `resolutionScale` of the drawing buffer (half the render scale: the light is smooth, and the
 * cost then scales with the resolution), and not at all in a frame without a volume in view, when
 * `on` is 0 and the chain ignores the stale texture (no fixed cost: 1a has none).
 */
export class LightVolumeNode extends THREE.TempNode {
  static get type() {
    return 'EnhancedLightVolumeNode';
  }
  resolutionScale = 0.5;
  /** 1 while the texture holds this frame's light. */
  readonly on = uniform(0);
  private built = false;
  private readonly rt = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly material = new THREE.NodeMaterial();
  private readonly textureNode: N;

  constructor(
    private readonly depthNode: N,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly jitter: boolean,
  ) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.rt.texture.name = 'enhanced-light-volumes';
    this.material.name = 'enhanced-light-volumes';
    this.textureNode = passTexture(this as unknown as THREE.PassNode, this.rt.texture);
  }

  getTextureNode(): N {
    return this.textureNode;
  }

  updateBefore(frame: THREE.NodeFrame): undefined {
    const n = lightVolumePass.count.value as number;
    this.on.value = n > 0 ? 1 : 0;
    // (Drawn once regardless, in the chain's probe behind the loading screen: the pipeline is
    // then built before the first volume comes into view.)
    if (!n && this.built) return undefined;
    this.built = true;
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const size = renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.round(size.x * this.resolutionScale)), h = Math.max(1, Math.round(size.y * this.resolutionScale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const prev = renderer.getRenderTarget();
    _quad.material = this.material;
    renderer.setRenderTarget(this.rt);
    _quad.render(renderer);
    renderer.setRenderTarget(prev);
    return undefined;
  }

  setup(builder: N): N {
    this.material.contextNode = context(builder.getSharedContext() as never);
    this.material.fragmentNode = vec4(lightVolumeLight(this.depthNode, this.camera, { jitter: this.jitter }), 1);
    this.material.needsUpdate = true;
    return this.textureNode;
  }

  dispose() {
    super.dispose();
    this.rt.dispose();
    this.material.dispose();
  }
}
