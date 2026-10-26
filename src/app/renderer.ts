// Three.js (WebGPU, with automatic WebGL2 fallback) renderer for LevelData.

import * as THREE from 'three/webgpu';
import type { DecodedTexture, LevelData, MeshPart } from '../formats/types';
import { materialSignature } from '../formats/model';
import { createSurfaceMaterial, missingTexture, toArrayTexture, toDataTexture } from './surface-material';
import { FlyControls } from './controls';
import { CollisionWorld, type PartFilter } from './physics';
import { PlayerController } from './player';
import { ZoneCuller, type VisChunk } from './visibility';
import type { StaticBatch } from './prop-batch';
import { framePass } from './matrix-pass';
import { context } from 'three/tsl';
import { BACK_BUFFER_TYPE, EngineFog, GAMMA_BACK_BUFFER, LEGACY_LIGHTING, backBufferOutput, engineFogNode, engineLights } from './engine-light';
import { frameProbe } from './frame-probe';
import { uploadDynamicOnChange } from './dynamic-uploads';
import { NO_GLOW, SceneGlow } from './scene-glow';
import { warmObjects, warmTargets, warmHooks, warmViewmodelObjects, warmPasses, type WarmPass } from './prewarm';
import { ENHANCED } from './enhanced/config';
import { LIGHT_VOLUME_SHEETS, lightVolumeScene, takeLightShafts } from './enhanced/light-volume';
import type { EnhancedRenderer } from './enhanced';
import { FramePacer, RenderScaler, type ScaleSetting } from './render-scale';
import { HELD_AXIS, heldLampPose, LAMP_AIM, LAMP_OFFSET } from './held-lamp';


export type BackendName = 'WebGPU' | 'WebGL2';

export interface LevelStats {
  parts: number;
  meshes: number;
  vertices: number;
  triangles: number;
  textures: number;
  missingTextures: string[];
  collisionTriangles?: number;
  collisionMs?: number;
  /** Visibility chunks (zone x cell groups) and zones (visibility.ts). */
  chunks?: number;
  zones?: number;
}

const FOG_COLOR = 0x040506;

/**
 * A scene background colour for the gamma back buffer (engine-light.ts GAMMA_BACK_BUFFER).
 * three.js clears the frame with `getRGB()` in the working (linear) space, which the output pass
 * used to encode; the back buffer holds gamma values, so the clear takes the sRGB-encoded
 * components (the colour set with setHex is what the screen shows). Everything else (fog
 * colour comparisons, setHex from the level atmosphere) sees an ordinary Color.
 */
class BackBufferColor extends THREE.Color {
  override getRGB(target: THREE.RGB): THREE.RGB {
    return super.getRGB(target, THREE.SRGBColorSpace);
  }
}
/** Concurrent precompile lanes per pass (LevelRenderer.precompile). */
const PRECOMPILE_LANES = 4;
/** `?gputime`: WebGPU timestamp queries, each frame's GPU time to the frame probe (QA). */
const GPU_TIME = new URLSearchParams(location.search).has('gputime');
/**
 * Frames handed to the GPU and not yet complete at most (render-scale.ts GpuBusy): a display frame
 * is not drawn while this many are in flight. A GPU-bound frame otherwise queued up to five frames
 * behind (Enhanced Medium at 3456 x 2234: 160 ms from the frame's task to its completion, all of
 * it input lag). `?inflight=0` turns the limit off (comparisons).
 */
const MAX_IN_FLIGHT = (() => {
  const v = new URLSearchParams(location.search).get('inflight');
  return v !== null && Number.isFinite(Number(v)) ? Number(v) : 3;
})();
/** `?legacymerge`: no visibility chunks, every level triangle always drawn (profiling baseline). */
const LEGACY_MERGE = new URLSearchParams(location.search).has('legacymerge');

// Gain applied to baked per-vertex lighting: see bakedGain in surface-material.ts.

/** Engine lens (vertical degrees at 4:3) -> three.js vertical FOV for `aspect` (width / height). */
export function lensFov(deg: number, aspect: number): number {
  const t = Math.tan(THREE.MathUtils.degToRad(deg) / 2) * Math.min(1, 4 / 3 / Math.max(aspect, 1e-3));
  return THREE.MathUtils.radToDeg(2 * Math.atan(t));
}

export class LevelRenderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
  readonly controls: FlyControls;
  /** Walking player (first/third person). Active when `walking` is true. */
  readonly player: PlayerController;
  /** Static collision for the current level (null until a level is set). */
  collision: CollisionWorld | null = null;
  /**
   * The level's drawn triangles as a query world (decal projection, the actors' draw occlusion);
   * the same object as `collision` when the level has no collision parts (LevelData.collision).
   */
  drawn: CollisionWorld | null = null;
  /**
   * Which parts collide, built per level (applied on the next setLevel).
   * Default null = everything collides. e.g. `(lvl, tex) => cutoutAlphaFilter(tex)`.
   */
  collisionFilter: ((level: LevelData, textures: DecodedTexture[]) => PartFilter) | null = null;
  /** Walk (player physics) vs fly (noclip FlyControls). */
  walking = false;
  readonly flashlight: THREE.SpotLight;
  /**
   * First-person viewmodel layer (e.g. the player's arms). Add objects to `viewmodel`;
   * they are drawn after the level in a second pass with a cleared depth buffer and
   * a tiny near plane, so they never clip into walls or the camera's near plane.
   * Coordinates are world space (the pass camera copies the main camera each frame).
   */
  readonly viewmodel = new THREE.Group();
  private readonly fpScene = new THREE.Scene();
  /** Enhanced graphics mode (docs/enhanced.md); null in Original mode. */
  enhanced: EnhancedRenderer | null = null;
  /** The viewmodel's scene and camera (the Enhanced pipeline draws them as a pass). */
  get viewmodelPass(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
    return { scene: this.fpScene, camera: this.fpCamera };
  }
  /** Same lens as the world camera; near plane 32 engine units (1.6 cm, SUFFERING.EXE 0x49c400). */
  private readonly fpCamera = new THREE.PerspectiveCamera(70, 1, 32 / 2048, 50);
  /**
   * The engine lens (setLens): vertical field of view of the 4:3 picture, degrees; 0 until a
   * level sets it (the camera keeps its 70 deg default).
   */
  private lens = 0;
  private readonly fpLamp: THREE.SpotLight;
  /** Linear fog (engine-light.ts EngineFog: near / far; `density` = 2.5 / far for the culler). */
  readonly fog: EngineFog = new EngineFog(FOG_COLOR, 37.5, 62.5);
  backend: BackendName = 'WebGL2';

  private levelGroup = new THREE.Group();
  /** Zone / portal culling of the level chunks (visibility.ts); null until a level is set. */
  culler: ZoneCuller | null = null;
  /** Merged static props (prop-batch.ts), updated every frame after culling. */
  readonly batches = new Set<StaticBatch>();
  /** Level meshes whose index buffer is packed to the visible chunks (compactLevel). */
  private compact: { mesh: THREE.Mesh; full: Uint32Array; segs: Int32Array; hash: number; count: number }[] = [];
  private compactVersion = -1;
  private disposables: { dispose(): void }[] = [];
  private fogEnabled = true;
  private baseFogDensity = 0.04;
  private cullBackfaces = false;
  private materials: THREE.Material[] = [];
  private timer = new THREE.Timer();
  private frameListeners: ((dt: number) => void)[] = [];
  private drawListeners: (() => void)[] = [];
  /**
   * Post-processing hook (src/game/insanity/effects.ts): when set, `render()` draws the
   * scene with its screen effects instead of the plain `renderer.render(scene, camera)`.
   * The first-person viewmodel pass is drawn on top afterwards either way.
   */
  postProcess: { render(): void } | null = null;
  /**
   * The engine's HDR scene glow (scene-glow.ts) in the Original look; null in Enhanced mode,
   * with `?lighting=legacy` or `?noglow`. Screen effects apply it to their own scene target.
   */
  glow: SceneGlow | null = null;
  /**
   * Game clock rate (Time Scale objects, src/game/insanity): scales the dt handed to the
   * player and to every frame listener (game systems). 1 = normal.
   */
  timeScale = 1;
  /**
   * Graphics options (src/app/menu/graphics.ts): `postEffects` false bypasses postProcess
   * ("Pixel Shaders: No"); `frameCap` limits rendered frames per second (0 = every display
   * frame); `textureFilter` applies to the level textures (setTextureFiltering re-applies it).
   */
  postEffects = true;
  frameCap = 0;
  textureFilter: 'off' | 'bilinear' | 'trilinear' = 'trilinear';
  private levelTextures: THREE.Texture[] = [];
  private lastFrameAt = -1e9;
  private lastRawAt = -1;
  /**
   * Render scale and dynamic resolution (render-scale.ts): the drawing buffer is the internal
   * resolution, CSS size × min(DPR, 2) × scale. `?scale=` / the Graphics Resolution row.
   */
  readonly scaler: RenderScaler;
  /** Smooth pacing with the frame-rate limit Off on high-refresh displays (render-scale.ts). */
  readonly pacer = new FramePacer();
  /**
   * Set while a level loads (src/app/main.ts): frame() draws nothing. Drawing the new level
   * behind the loading screen compiled its pipelines synchronously, frame after frame, racing
   * (and duplicating) the precompile; it also made the load slower.
   */
  suspended = false;
  /** The compile jobs of precompile() calls still running. */
  private compiling: Promise<void> = Promise.resolve();
  /** precompile() calls of this page (QA: load time spent compiling). */
  readonly precompiles: { objects: number; passes: number; ms: number }[] = [];
  /** Drawables precompile() requested, with the material they had (prewarm.ts). */
  private warmed = new WeakMap<THREE.Object3D, unknown>();
  private warmedTargets = new WeakSet<THREE.RenderTarget>();
  /** Per own pass (prewarm.ts warmPasses): drawables compiled for it, with their material. */
  private passWarmedMap = new WeakMap<WarmPass, WeakMap<THREE.Object3D, unknown>>();
  /** With own passes (Enhanced mode): precompile() calls run one after another. */
  private serial: Promise<unknown> = Promise.resolve();
  private passWarmed(t: WarmPass) {
    let m = this.passWarmedMap.get(t);
    if (!m) this.passWarmedMap.set(t, (m = new WeakMap()));
    return m;
  }

  private constructor(private readonly container: HTMLElement, forceWebGL: boolean) {
    // The frame target is the engine's back buffer: 8-bit, holding gamma values (engine-light.ts
    // GAMMA_BACK_BUFFER, docs/re/renderer.md §5.1).
    // (Enhanced mode draws only full-screen quads to the canvas, after its own TRAA / FXAA: no
    // MSAA there. Perf C, docs/perf.md.)
    this.renderer = new THREE.WebGPURenderer({ antialias: !ENHANCED, forceWebGL, trackTimestamp: GPU_TIME, outputBufferType: BACK_BUFFER_TYPE });
    this.scaler = new RenderScaler(this.renderer);
    // The engine writes gamma-space colours straight to the screen (Direct3D 9 fixed function):
    // no tone mapping. `?lighting=legacy` keeps the previous ACES look.
    this.renderer.toneMapping = LEGACY_LIGHTING ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = LEGACY_LIGHTING ? 1.15 : 1;
    if (GAMMA_BACK_BUFFER) {
      // Every material encodes its output to gamma before it is blended, as the engine's passes
      // blend gamma bytes; the frame target then already holds what the screen shows, and the
      // output pass only copies it: no colour-space conversion, and LinearToneMapping at exposure
      // 1, which is a saturate (and keeps the frame target: its passes are shared with the
      // screen-effect target, game/insanity/effects.ts).
      this.renderer.contextNode = context({ getOutput: backBufferOutput });
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      this.renderer.toneMapping = THREE.LinearToneMapping;
    }
    // Engine lighting (engine-light.ts) feeds every light through its own uniforms and its
    // materials have `lights = false`: three.js's per-scene light list would only add cache-key
    // variants. Its key holds the id of every visible light, so the flashlight toggling, a
    // muzzle flash, an explosion's or a fire's PointLight (a new instance each time) or a
    // switched level light made every visible material build its shaders again (hitches of
    // 100 ms to seconds; docs/game-logic.md §18). With the list off it never changes.
    if (!LEGACY_LIGHTING) this.renderer.lighting.enabled = false;
    container.appendChild(this.renderer.domElement);

    this.scene.background = GAMMA_BACK_BUFFER ? new BackBufferColor(FOG_COLOR) : new THREE.Color(FOG_COLOR);
    // Updated once per frame in frame(), before culling. The scene and the level never move:
    // with matrixAutoUpdate on, the scene would recompose its own matrix every frame and so
    // force a world-matrix recomputation of the whole graph (every prop, bone and mesh); this
    // way only subtrees that changed (or whose root auto-updates) are recomputed.
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.matrixAutoUpdate = false;
    this.levelGroup.matrixAutoUpdate = false;
    this.scene.fog = this.fog;
    // Engine fog: linear in view depth, blended on gamma-encoded colours (engine-light.ts).
    if (!LEGACY_LIGHTING) (this.scene as THREE.Scene & { fogNode: unknown }).fogNode = engineFogNode;
    this.scene.add(this.levelGroup);
    this.scene.add(warmObjects);

    // Very low ambient: the game is dark, you rely on the flashlight and baked light.
    this.scene.add(new THREE.AmbientLight(0x4a5260, 0.7));
    this.scene.add(new THREE.HemisphereLight(0x2c3440, 0x0c0a08, 0.9));

    // Player-held flashlight (decay 0 + distance cutoff keeps it scale-independent).
    this.flashlight = new THREE.SpotLight(0xfff1d6, 6, 30, THREE.MathUtils.degToRad(24), 0.55, 0);
    this.flashlight.position.set(LAMP_OFFSET.x, LAMP_OFFSET.y, LAMP_OFFSET.z);
    this.flashlight.target.position.set(LAMP_AIM.x, LAMP_AIM.y, LAMP_AIM.z);
    this.camera.add(this.flashlight, this.flashlight.target);
    this.scene.add(this.camera);

    // Viewmodel pass: same ambient as the level plus a copy of the flashlight (renderViewmodel
    // mirrors its settings each frame), so the arms are lit like the world in front of them:
    // hands and weapon in the beam, the shoulders at the screen's bottom corners outside it.
    this.viewmodel.name = 'viewmodel';
    this.fpScene.add(this.viewmodel);
    this.fpScene.add(warmViewmodelObjects);
    this.fpScene.add(new THREE.AmbientLight(0x4a5260, 0.7));
    this.fpScene.add(new THREE.HemisphereLight(0x2c3440, 0x0c0a08, 0.9));
    this.fpLamp = new THREE.SpotLight();
    this.fpCamera.add(this.fpLamp, this.fpLamp.target);
    this.fpScene.add(this.fpCamera);

    this.controls = new FlyControls(this.camera, this.renderer.domElement);
    this.player = new PlayerController(this.camera, this.renderer.domElement);
    this.scene.add(this.player.root);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    // A display with another pixel ratio (the window moved, the browser zoomed).
    const watchDpr = () => matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => (this.resize(), watchDpr()), { once: true });
    watchDpr();
    // Back from a hidden tab: no decisions on the first frames' intervals.
    document.addEventListener('visibilitychange', () => document.hidden || this.scaler.hold(2000));
  }

  /** The Graphics Resolution row (render-scale.ts): Auto or a fixed scale. */
  setRenderScale(s: ScaleSetting) {
    this.scaler.setSetting(s);
  }

  /** Internal resolution and scale, e.g. "2000 x 1290 (58 %, auto)" (debug overlay). */
  renderInfo(): string {
    return this.scaler.info();
  }

  static async create(container: HTMLElement): Promise<LevelRenderer> {
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    // Enhanced graphics mode (docs/enhanced.md): its shading hooks must be in before any
    // material is built (the player's, in the constructor). Original never loads it.
    const enhanced = ENHANCED ? await import('./enhanced') : null;
    const r = new LevelRenderer(container, forceWebGL);
    await r.renderer.init();
    r.scaler.gpu.device = (r.renderer.backend as { device?: GPUDevice }).device ?? null;
    coalesceNodeBuilds(r.renderer);
    // CPU-rewritten vertex buffers: written when they change, not on every draw (dynamic-uploads.ts).
    uploadDynamicOnChange(r.renderer);
    r.backend = (r.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    r.timer.connect(document);
    if (GAMMA_BACK_BUFFER && !ENHANCED && !NO_GLOW) r.glow = new SceneGlow(r.renderer, r.scene, r.camera);
    if (enhanced) r.enhanced = await enhanced.createEnhanced(r);
    r.renderer.setAnimationLoop((t) => r.frame(t));
    return r;
  }

  onFrame(fn: (dt: number) => void) {
    this.frameListeners.push(fn);
  }

  /**
   * Run `fn` right before each frame is drawn, with the camera where the frame shows it (the
   * player moves it after the game systems ran): last-moment culling (actors/manager.ts).
   * Returns the unsubscribe function.
   */
  onBeforeDraw(fn: () => void): () => void {
    this.drawListeners.push(fn);
    return () => {
      const i = this.drawListeners.indexOf(fn);
      if (i >= 0) this.drawListeners.splice(i, 1);
    };
  }

  /**
   * The engine's lens, Level Properties p16 (53 deg): a vertical angle of the 4:3 picture
   * (48 / tan(fov / 2) on a 128 x 96 film, SUFFERING.EXE 0x4b21f0). Wider screens keep its
   * 4:3 horizontal angle (vertical shrinks), taller ones its vertical. Sets the world camera
   * (the viewmodel pass copies it); docs/game-logic.md §4.5 "Lens".
   */
  setLens(deg: number) {
    if (!(deg > 1 && deg < 179)) return;
    this.lens = deg;
    this.camera.fov = lensFov(deg, this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.scaler.resize(w, h, window.devicePixelRatio);
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    if (this.lens > 0 && cam.aspect !== w / h) {
      // Keep any zoom on top of the lens (heartbeat pulse, scripted lens, monitor view).
      const half = (d: number) => Math.tan(THREE.MathUtils.degToRad(d) / 2);
      const k = half(lensFov(this.lens, w / h)) / half(lensFov(this.lens, cam.aspect));
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(half(cam.fov) * k));
    }
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }

  private frame(t: number) {
    const raw = this.lastRawAt < 0 ? 0 : t - this.lastRawAt;
    this.lastRawAt = t;
    // The frame-rate limit, or (Off) the pacer's every-other-display-frame on fast displays.
    const cap = this.frameCap > 0 ? this.frameCap : this.pacer.cap;
    if (cap > 0 && t - this.lastFrameAt < 1000 / cap - 2) {
      this.pacer.sample(raw, false, 0, 0, t);
      return;
    }
    // The GPU's backlog (never held for more than 100 ms: a lost completion cannot stop the game).
    if (MAX_IN_FLIGHT > 0 && !this.suspended && this.scaler.gpu.pending >= MAX_IN_FLIGHT && t - this.lastFrameAt < 100) {
      this.scaler.dyn.skip();
      this.pacer.sample(raw, false, 0, 0, t);
      return;
    }
    const interval = t - this.lastFrameAt;
    this.lastFrameAt = t;
    this.timer.update(t);
    const dt = Math.min(this.timer.getDelta(), 0.1) * this.timeScale;
    if (this.suspended) {
      // Loading: nothing is drawn (the loading screen covers the canvas) or moved.
      frameProbe.pause();
      this.scaler.hold();
      for (const fn of this.frameListeners) fn(dt);
      return;
    }
    const probe = frameProbe;
    const t0 = performance.now();
    probe.begin(t);
    if (this.walking) this.player.update(dt);
    else this.controls.update(dt);
    probe.lap('player');
    // Auto's pixel budget follows the Enhanced tier (the menu, Auto quality's governor).
    this.scaler.setBudget(this.enhanced ? this.enhanced.tier : 'original');
    const drawAt = performance.now();
    this.draw();
    this.renderViewmodel();
    probe.lap('viewmodel');
    for (const fn of this.frameListeners) fn(dt);
    probe.end();
    this.scaler.gpu.frame(drawAt);
    const now = performance.now();
    const hz = this.pacer.hz;
    this.scaler.frame(interval, now - t0, now, this.frameCap > 0 ? this.frameCap : hz > 0 && hz < 60 ? hz : 60);
    this.pacer.sample(raw, true, interval, now - t0, t);
    if (GPU_TIME && !this.gpuPending) {
      // The passes of the last frame resolved (one read-back at a time).
      this.gpuPending = true;
      void this.renderer
        .resolveTimestampsAsync('render')
        .then((ms) => typeof ms === 'number' && ms > 0 && probe.gpuSample(ms))
        .finally(() => (this.gpuPending = false));
    }
  }
  private gpuPending = false;

  /** Draw the frame: matrices, culling, lights, shadows, the scene (with any screen effects). */
  private draw() {
    const probe = frameProbe;
    for (const fn of this.drawListeners) fn();
    this.holdLamp();
    // World matrices first, so the culler sees objects where they are this frame (systems and
    // sequences move them after the previous render); render() skips its own update
    // (scene.matrixWorldAutoUpdate is off).
    framePass(() => this.scene.updateMatrixWorld());
    probe.lap('matrices');
    if (this.culler) {
      // Fog distance culling only while the fog fades to the background colour.
      const fog = this.scene.fog, bg = this.scene.background;
      this.culler.update(this.camera, fog instanceof THREE.FogExp2 && bg instanceof THREE.Color && fog.color.equals(bg) ? fog.density : 0, this.scene, this.levelGroup);
      this.compactLevel();
    }
    for (const b of this.batches) b.update(this.culler);
    probe.lap('cull');
    // Engine lighting: choose this frame's point / spot / rim lights and the fog uniforms.
    if (!LEGACY_LIGHTING) {
      engineLights.update(this.scene, this.camera, this.flashlight, this.scene.fog);
      probe.lap('lights');
      // Projected character shadows from the flashlight (docs/re/renderer.md §4).
      engineLights.renderShadows(this.renderer, this.camera, this.flashlight);
      probe.lap('shadows');
    }
    if (this.enhanced) this.enhanced.draw(this.postProcess && this.postEffects ? this.postProcess : null);
    else if (this.postProcess && this.postEffects) this.postProcess.render();
    // The HDR scene glow runs with the front-buffer effects, i.e. the Pixel Shaders option
    // (scene-glow.ts, docs/re/renderer.md §3.2).
    else if (this.glow && this.postEffects) this.glow.render();
    else this.renderer.render(this.scene, this.camera);
    probe.lap('render');
  }

  /**
   * The flashlight belongs to the player (held-lamp.ts): while another camera shows him (a
   * security monitor's feed) it stays at his eye instead of riding on the view camera.
   */
  private holdLamp() {
    const fl = this.flashlight, p = this.player;
    if (this.walking && p.externalView) {
      this.camera.updateMatrixWorld();
      heldLampPose(this.camera.matrixWorld, p.eyePosition(this.lampEye), p.yaw, p.pitch, fl.position, fl.target.position, this.lampAxis);
      fl.userData[HELD_AXIS] = this.lampAxis;
      this.lampHeld = true;
    } else if (this.lampHeld) {
      fl.position.set(LAMP_OFFSET.x, LAMP_OFFSET.y, LAMP_OFFSET.z);
      fl.target.position.set(LAMP_AIM.x, LAMP_AIM.y, LAMP_AIM.z);
      delete fl.userData[HELD_AXIS];
      this.lampHeld = false;
    }
  }
  private lampHeld = false;
  private readonly lampEye = new THREE.Vector3();
  private readonly lampAxis = new THREE.Vector3();

  private renderViewmodel() {
    if (!this.viewmodel.children.some((c) => c.visible)) return;
    const cam = this.camera, fp = this.fpCamera;
    cam.updateMatrixWorld();
    cam.matrixWorld.decompose(fp.position, fp.quaternion, fp.scale);
    if (fp.fov !== cam.fov || fp.aspect !== cam.aspect) {
      fp.fov = cam.fov;
      fp.aspect = cam.aspect;
      fp.updateProjectionMatrix();
    }
    const fl = this.flashlight, lamp = this.fpLamp;
    lamp.visible = fl.visible;
    if (fl.visible) {
      lamp.color.copy(fl.color);
      lamp.intensity = fl.intensity;
      lamp.distance = fl.distance;
      lamp.angle = fl.angle;
      lamp.penumbra = fl.penumbra;
      lamp.decay = fl.decay;
      lamp.position.copy(fl.position);
      lamp.target.position.copy(fl.target.position);
    }
    // Enhanced mode draws the viewmodel as a pass of its pipeline (enhanced/post.ts).
    if (this.enhanced) return;
    const r = this.renderer;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.fpScene, fp);
    r.autoClear = true;
  }

  /**
   * Pack each level mesh's index buffer with the triangles of its visible chunks (only for
   * meshes whose visible set changed since the last frame) and draw just that range.
   */
  private compactLevel() {
    const c = this.culler;
    if (!c || c.chunkVersion === this.compactVersion) return;
    this.compactVersion = c.chunkVersion;
    const chunks = c.chunks;
    for (const e of this.compact) {
      const segs = e.segs;
      let hash = 0, count = 0;
      for (let i = 0; i < segs.length; i += 3) {
        if (!chunks[segs[i]].visible) continue;
        hash = (Math.imul(hash ^ (segs[i] + 1), 0x9e3779b1) + 0x7f4a7c15) | 0;
        count += segs[i + 2];
      }
      if (hash === e.hash && count === e.count) continue;
      e.hash = hash;
      e.count = count;
      const index = e.mesh.geometry.index!;
      const out = index.array as Uint32Array;
      let o = 0;
      for (let i = 0; i < segs.length; i += 3) {
        if (!chunks[segs[i]].visible) continue;
        out.set(e.full.subarray(segs[i + 1], segs[i + 1] + segs[i + 2]), o);
        o += segs[i + 2];
      }
      e.mesh.geometry.setDrawRange(0, count);
      index.clearUpdateRanges();
      index.addUpdateRange(0, count);
      index.needsUpdate = true;
      e.mesh.visible = count > 0;
    }
  }

  /**
   * Compile the render pipelines of everything in the scene now, hidden zones and objects
   * included (legacy lighting: with the flashlight both on and off), for every pass that draws the scene (the
   * canvas, the screen-effect / monitor targets registered in prewarm.ts) and for the
   * first-person viewmodel, so that walking into a new zone, toggling the light, a screen
   * fade or a weapon switch does not stall on shader compilation (docs/game-logic.md §18).
   * The scene is gathered synchronously (every object temporarily shown, unculled, on the
   * camera's layer); the compilation itself then runs in the background, yielding between
   * objects. Meshes already requested by an earlier call with the same material are skipped,
   * so later calls (a sequence starting, actors spawned) only compile what is new; resolves
   * with the number of meshes requested. `hooks` runs prewarm.ts's warmHooks too (they may draw
   * to the canvas: only behind the loading screen); `lanes` splits each pass in concurrent lanes
   * (worth it for the full load-time job only).
   */
  async precompile(opts: { full?: boolean; hooks?: boolean; lanes?: boolean; serial?: boolean } = {}): Promise<number> {
    // With own passes (prewarm.ts warmPasses: Enhanced mode) one call at a time: three.js's
    // asynchronous shader builds read the renderer's target and MRT when they run, and two calls
    // at once (the load's and the visibility system's first update) set them under each other.
    if (warmPasses.size && !opts.serial) {
      const run = this.serial.then(() => this.precompile({ ...opts, serial: true }));
      this.serial = run.catch(() => undefined);
      return run;
    }
    const r = this.renderer;
    const t0 = performance.now();
    // A target registered since the last call: everything has to be compiled for it.
    // (With own passes, Enhanced mode, the scene is drawn into those only: the screen-effect
    // target then receives the finished frame, never the scene, so it needs no scene shaders.)
    const targets = warmPasses.size ? [] : [...warmTargets];
    // Own passes (prewarm.ts warmPasses): only while the frame loop is suspended (a level load).
    const passes = this.suspended ? [...warmPasses] : [];
    const full = !!opts.full || [...targets, ...passes.map((p) => p.target)].some((t) => !this.warmedTargets.has(t));
    for (const t of [...targets, ...passes.map((p) => p.target)]) this.warmedTargets.add(t);
    const drawable = (o: THREE.Object3D) => (o as THREE.Mesh).isMesh || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine;
    const fresh: THREE.Object3D[] = [];
    const ownFresh = new Set<THREE.Object3D>();
    // Each pass is split in PRECOMPILE_LANES lanes by material: three.js compiles a lane one
    // object at a time, waiting for each pipeline, and the GPU process compiles several lanes'
    // pipelines at once. Objects of one shader in different lanes build it once
    // (coalesceNodeBuilds); materials of one structure share a shader (docs/game-logic.md §18.8).
    const lane = (o: THREE.Object3D) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
      const first = (Array.isArray(m) ? m[0] : m) as unknown as { id?: number } | undefined;
      return (first?.id ?? 0) % PRECOMPILE_LANES;
    };
    // (`seen`: an own pass's record of what it compiled, in place of `warmed`; `hold` keeps the
    // target set for the caller, who restores it once the shaders are built.)
    // (`swap`: an own pass's material for each drawn one, null = not drawn: shadow maps.)
    const gather = (scene: THREE.Scene, camera: THREE.Camera, target: THREE.RenderTarget | null, part = -1, hold = false, seen?: WeakMap<THREE.Object3D, unknown>, swap?: WarmPass['material']): Promise<void> | null => {
      const warmed = seen ?? this.warmed;
      const saved: [THREE.Object3D, boolean, boolean, number][] = [];
      const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
      const included: THREE.Object3D[] = [];
      let n = 0;
      scene.traverse((o) => {
        saved.push([o, o.visible, o.frustumCulled, o.layers.mask]);
        o.visible = true;
        o.frustumCulled = false;
        let d: boolean = drawable(o);
        // Already compiled, or another lane's: off every layer (its children are still visited).
        if (d && ((!full && warmed.get(o) === (o as THREE.Mesh).material) || (part >= 0 && lane(o) !== part))) o.layers.mask = 0;
        else {
          if (d && swap) {
            const m = o as THREE.Mesh;
            const list = [m.material].flat().map((x) => ((m as { isMesh?: boolean }).isMesh && !(o as THREE.Sprite).isSprite ? swap(x) : null));
            if (list.some(Boolean)) (swapped.push([m, m.material]), (m.material = Array.isArray(m.material) ? list.map((x) => x ?? list.find(Boolean)!) : list[0]!));
            else d = false;
          }
          o.layers.mask = d || !drawable(o) ? o.layers.mask | camera.layers.mask : 0; // zone-culled objects (visibility.ts)
          if (d) (n++, included.push(o));
        }
      });
      let p: Promise<void> | null = null;
      const prev = r.getRenderTarget();
      try {
        if (n) {
          r.setRenderTarget(target);
          p = r.compileAsync(scene, camera);
        }
      } finally {
        if (!hold) r.setRenderTarget(prev);
        for (const [m, mat] of swapped) m.material = mat;
        for (const [o, v, f, l] of saved) {
          o.visible = v;
          o.frustumCulled = f;
          o.layers.mask = l;
        }
        if (p && seen) for (const o of included) (seen.set(o, (o as THREE.Mesh).material), ownFresh.add(o));
        else if (p) fresh.push(...included);
      }
      return p;
    };
    const jobs: Promise<void>[] = [];
    const add = (p: Promise<void> | null) => p && jobs.push(p);
    // The flashlight's on / off states only make different pipelines with three.js lighting
    // (`?lighting=legacy`; see the constructor).
    const light = this.flashlight.visible;
    for (const on of LEGACY_LIGHTING ? [light, !light] : [light]) {
      this.flashlight.visible = on;
      // Lanes only for the big load-time job (each lane gathers the whole scene again). (With own
      // passes, Enhanced mode, the scene is never drawn to the canvas itself.)
      for (const target of [...(passes.some((p) => !p.viewmodel) ? [] : [null]), ...targets.filter((t) => !this.sharesCanvasPass(t))]) {
        if (opts.lanes) for (let k = 0; k < PRECOMPILE_LANES; k++) add(gather(this.scene, this.camera, target, k));
        else add(gather(this.scene, this.camera, target));
      }
      // The viewmodel pass (its lamp mirrors the flashlight; drawn by an own pass in Enhanced mode).
      this.fpLamp.visible = on;
      if (!passes.some((p) => p.viewmodel)) add(gather(this.fpScene, this.fpCamera, null));
    }
    this.flashlight.visible = light;
    this.fpLamp.visible = light;
    for (const o of fresh) this.warmed.set(o, (o as THREE.Mesh).material);
    for (const hook of opts.hooks ? warmHooks : []) {
      try {
        const p = hook();
        if (p instanceof Promise) jobs.push(p as Promise<void>);
      } catch (err) {
        console.warn('[renderer] warm hook failed:', err);
      }
    }
    // Own passes, one at a time with their target and MRT held (prewarm.ts warmPasses), after
    // the jobs above (their asynchronous builds read the renderer's state too).
    const own = passes.length
      ? (async () => {
          await Promise.all(jobs);
          // (compileAsync() takes the render context of a top-level call; the pass's own is that of
          // its nested call depth: three.js's RenderContexts.get(target, mrt, depth), overridden for
          // the pass's target while it compiles.)
          const rc = (r as unknown as { _renderContexts: { get(t: unknown, m: unknown, d?: number): unknown } })._renderContexts;
          const ownGet = Object.prototype.hasOwnProperty.call(rc, 'get');
          const get = rc.get;
          for (const pass of passes) {
            if (pass.depth < 0) pass.probe?.();
            const prevTarget = r.getRenderTarget(), prevMRT = r.getMRT();
            r.setRenderTarget(pass.target);
            r.setMRT(pass.mrt);
            rc.get = (t, m, d = 0) => get.call(rc, t, m, t === pass.target && pass.depth >= 0 ? pass.depth : d);
            try {
              const [scene, camera] = pass.viewmodel ? [this.fpScene, this.fpCamera] : [this.scene, this.camera];
              const ps: Promise<void>[] = [];
              const lanes = opts.lanes && !pass.viewmodel ? PRECOMPILE_LANES : 1;
              for (let k = 0; k < lanes; k++) {
                const p = gather(scene, camera, pass.target, lanes > 1 ? k : -1, true, this.passWarmed(pass), pass.material);
                if (p) ps.push(p);
              }
              await Promise.all(ps);
            } finally {
              if (ownGet) rc.get = get;
              else delete (rc as { get?: unknown }).get;
              r.setRenderTarget(prevTarget);
              r.setMRT(prevMRT);
            }
          }
        })()
      : null;
    if (own) jobs.push(own);
    // Also wait for the jobs of earlier calls still running (their objects count as requested).
    const prior = this.compiling;
    const mine = Promise.all(jobs);
    this.compiling = Promise.all([prior, mine.catch(() => undefined)]).then(() => undefined);
    await prior;
    await mine;
    const n = new Set([...fresh, ...ownFresh]).size;
    this.precompiles.push({ objects: n, passes: targets.length + 2 + passes.length, ms: Math.round(performance.now() - t0) });
    if (n) console.info(`[renderer] pipelines precompiled for ${n} objects, ${targets.length + 1} passes + viewmodel in ${(performance.now() - t0).toFixed(0)} ms`);
    return n;
  }

  /**
   * Does `target` draw with the canvas pass's render state? three.js keys render contexts (and so
   * shaders, pipelines and render objects) by the target's attachments; the screen-effect and
   * security-monitor targets are made with the frame target's on purpose, so compiling the scene
   * for them again only repeated the canvas pass's work item by item (docs/game-logic.md §18.8).
   */
  private sharesCanvasPass(target: THREE.RenderTarget): boolean {
    const r = this.renderer as unknown as { needsFrameBufferTarget?: boolean; _getFrameBufferTarget?(): THREE.RenderTarget | null };
    const canvas = r.needsFrameBufferTarget && r._getFrameBufferTarget ? r._getFrameBufferTarget() : null;
    const key = (t: THREE.RenderTarget) => `${t.textures.length}:${t.texture.format}:${t.texture.type}:${t.samples}:${t.depthBuffer}:${t.stencilBuffer}:${t.texture.colorSpace}`;
    return !!canvas && key(canvas) === key(target);
  }

  /**
   * Keep every shader three.js has built (node builder states, shader modules, pipelines) in its
   * caches until the returned function is called, also when the objects drawn with them are
   * disposed meanwhile. A level change disposes the old level's objects before the new level is
   * compiled, which used to empty the caches; levels share most shader structures (characters,
   * surface graphs, effects), so the next level now finds them built (docs/game-logic.md §18.8).
   */
  holdShaderCaches(): () => void {
    type Entry = { usedTimes: number };
    const r = this.renderer as unknown as {
      _nodes?: { nodeBuilderCache?: Map<unknown, Entry> };
      _pipelines?: { caches?: Map<unknown, Entry>; programs?: Record<string, Map<unknown, Entry>>; _releaseProgram?(p: Entry): void };
    };
    const held: [Map<unknown, Entry>, unknown, Entry, boolean][] = [];
    const hold = (m: Map<unknown, Entry> | undefined, program = false) => {
      if (!(m instanceof Map)) return;
      for (const [k, v] of m) {
        if (typeof v?.usedTimes !== 'number') continue;
        v.usedTimes++;
        held.push([m, k, v, program]);
      }
    };
    const pipes = r._pipelines;
    hold(r._nodes?.nodeBuilderCache);
    hold(pipes?.caches);
    hold(pipes?.programs?.vertex, true);
    hold(pipes?.programs?.fragment, true);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const [m, k, v, program] of held) {
        if (--v.usedTimes > 0 || m.get(k) !== v) continue;
        if (program && pipes?._releaseProgram) pipes._releaseProgram(v);
        else m.delete(k);
      }
    };
  }

  /**
   * Draw one frame and wait until the GPU has finished all queued work (texture uploads,
   * pipelines, the frame itself), still behind the loading screen: the first frame after a load
   * otherwise waited ~400 ms for that queue (docs/game-logic.md §18).
   */
  async settle(): Promise<void> {
    // Exactly what the first frame will draw (camera, culling, shadows, screen effects).
    this.draw();
    this.renderViewmodel();
    const device = (this.renderer.backend as { device?: GPUDevice }).device;
    if (device) await device.queue.onSubmittedWorkDone();
    else await new Promise((r) => requestAnimationFrame(r));
  }

  // -------------------------------------------------------------------------
  // Walk / fly

  /**
   * Switch between walking (player physics) and noclip flying. Entering walk
   * mode drops the player at the current camera position; leaving it puts the
   * fly camera at the player's eye.
   */
  setWalking(on: boolean): boolean {
    if (on && !this.collision) on = false;
    if (on === this.walking) return on;
    this.walking = on;
    this.player.enabled = on;
    this.controls.enabled = !on;
    if (on) {
      const p = this.camera.position;
      this.player.teleport({ x: p.x, y: p.y - this.player.eyeHeight, z: p.z }, this.controls.yaw, this.controls.pitch);
      this.player.update(0);
    } else {
      // Fly from where the camera is now (also works from the 3rd-person camera).
      this.controls.setPose(this.camera.position.clone(), this.player.yaw, this.player.pitch);
    }
    this.player.root.visible = on && this.player.mode === 'tp';
    return on;
  }

  toggleWalking(): boolean {
    return this.setWalking(!this.walking);
  }

  // -------------------------------------------------------------------------
  // Toggles

  /**
   * Whether the player has a flashlight to switch (set by the weapons system: a Flashlight item
   * in the inventory, docs/re/renderer.md §2.1); null = always (the developer viewer).
   */
  flashlightAvailable: (() => boolean) | null = null;

  toggleFlashlight(): boolean {
    if (this.flashlightAvailable && !this.flashlightAvailable()) return (this.flashlight.visible = false);
    this.flashlight.visible = !this.flashlight.visible;
    return this.flashlight.visible;
  }

  toggleFog(): boolean {
    this.fogEnabled = !this.fogEnabled;
    this.scene.fog = this.fogEnabled ? this.fog : null;
    if (!LEGACY_LIGHTING) (this.scene as THREE.Scene & { fogNode: unknown }).fogNode = this.fogEnabled ? engineFogNode : null;
    return this.fogEnabled;
  }

  scaleFog(factor: number) {
    this.fog.density *= factor;
  }

  toggleBackfaceCulling(): boolean {
    this.cullBackfaces = !this.cullBackfaces;
    for (const m of this.materials) {
      m.side = this.cullBackfaces ? THREE.FrontSide : THREE.DoubleSide;
      m.needsUpdate = true;
    }
    return this.cullBackfaces;
  }

  // -------------------------------------------------------------------------
  // Level building

  /** Applies `textureFilter` to every texture of the current level. */
  setTextureFiltering(mode: 'off' | 'bilinear' | 'trilinear') {
    this.textureFilter = mode;
    for (const t of this.levelTextures) {
      this.filterTexture(t);
      t.needsUpdate = true;
    }
  }

  private filterTexture(t: THREE.Texture) {
    // Lightmaps / unfiltered helper textures keep their own nearest filtering.
    if (t.magFilter === THREE.NearestFilter && t.minFilter === THREE.NearestFilter && !t.userData.filtered) return;
    t.userData.filtered = true;
    const mode = this.textureFilter;
    t.magFilter = mode === 'off' ? THREE.NearestFilter : THREE.LinearFilter;
    t.minFilter = mode === 'off' ? THREE.NearestMipmapNearestFilter : mode === 'bilinear' ? THREE.LinearMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
    t.anisotropy = mode === 'trilinear' ? 8 : 1;
  }

  clear() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.levelTextures = [];
    this.materials = [];
    this.levelGroup.clear();
    this.culler = null;
    this.compact = [];
  }

  setLevel(level: LevelData, textures: DecodedTexture[]): LevelStats {
    this.clear();

    const texMap = new Map<string, DecodedTexture>();
    for (const t of textures) texMap.set(t.key, t);
    const gpuTextures = new Map<string, THREE.Texture | null>();
    const cache = <T extends THREE.Texture>(id: string, make: () => T | null): T | null => {
      if (gpuTextures.has(id)) return gpuTextures.get(id) as T | null;
      const tex = make();
      gpuTextures.set(id, tex);
      if (tex) {
        this.disposables.push(tex);
        this.levelTextures.push(tex);
        this.filterTexture(tex);
      }
      return tex;
    };
    const getTexture = (key: string, kind: 'tx' | 'cut' | 'lm'): THREE.DataTexture | null =>
      cache(`${kind}:${key}`, () => {
        const src = texMap.get(key);
        return src ? toDataTexture(src, { lightmap: kind === 'lm', cutout: kind === 'cut' }) : null;
      });
    let missingTex: THREE.DataTexture | null = null;
    const textureSource = {
      texture: (key: string, cutout: boolean) => getTexture(key, cutout ? 'cut' : 'tx'),
      frames: (keys: string[]) =>
        cache(`arr:${keys.join(',')}`, () => {
          const frames = keys.map((k) => texMap.get(k));
          return frames.every((f) => f) ? toArrayTexture(frames as DecodedTexture[]) : null;
        }),
      missing: () => (missingTex ??= makeMissingTexture(this.disposables)),
      hasAlpha: (key: string) => !!texMap.get(key)?.hasAlpha,
    };

    // One mesh per material (surface signature + attribute layout) for the whole level, its
    // triangles ordered by visibility chunk (zone x cell, see formats/level.ts groupOf). The
    // culler marks the chunks it can see each frame and compactLevel() packs their triangles
    // to the front of each mesh's index buffer: one draw call per material, as with a plain
    // merge, while hidden zones cost no triangles.
    const bySig = new Map<string, Map<number, MeshPart[]>>();
    const chunkIndex = new Map<string, number>();
    const chunks: VisChunk[] = [];
    // Enhanced: the light shafts leave the sheet geometry and are drawn as volumes (enhanced/light-volume.ts).
    let levelParts = level.parts;
    if (ENHANCED && !LIGHT_VOLUME_SHEETS) {
      const shafts = takeLightShafts(level.parts, (k) => texMap.get(k));
      levelParts = shafts.parts;
      lightVolumeScene.setLevel(shafts.volumes);
    }
    for (const part of levelParts) {
      if (!part.positions.length || !part.indices.length) continue;
      const sig = [
        part.textureKey ?? '-',
        materialSignature(part.material),
        part.lightmapKey ?? '-',
        part.normals ? 'n' : '',
        part.uvs ? 'u' : '',
        part.uvs2 ? 'l' : '',
        part.colors ? 'c' : '',
        part.vertexAlpha ? 'va' : '',
        part.translucent ? 'tr' : '',
        part.splat?.map((x) => `${x.texture}/${x.tiling}/${x.fade}`).join(',') ?? '',
      ].join('|');
      const zone = LEGACY_MERGE ? -1 : (part.zone ?? -1);
      const key = LEGACY_MERGE ? 'all' : `${zone}:${part.cell ?? 0}`;
      let ci = chunkIndex.get(key);
      if (ci === undefined) {
        chunkIndex.set(key, (ci = chunks.length));
        chunks.push({ name: key, zone, box: new THREE.Box3(), triangles: 0, visible: true });
      }
      const chunk = chunks[ci];
      chunk.triangles += part.indices.length / 3;
      const pos = part.positions;
      const bmin = chunk.box.min, bmax = chunk.box.max;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (x < bmin.x) bmin.x = x;
        if (y < bmin.y) bmin.y = y;
        if (z < bmin.z) bmin.z = z;
        if (x > bmax.x) bmax.x = x;
        if (y > bmax.y) bmax.y = y;
        if (z > bmax.z) bmax.z = z;
      }
      let byChunk = bySig.get(sig);
      if (!byChunk) bySig.set(sig, (byChunk = new Map()));
      let list = byChunk.get(ci);
      if (!list) byChunk.set(ci, (list = []));
      list.push(part);
    }

    const missing = new Set<string>();
    const stats: LevelStats = {
      parts: level.parts.length,
      meshes: 0,
      vertices: 0,
      triangles: 0,
      textures: 0,
      missingTextures: [],
    };

    for (const byChunk of bySig.values()) {
      const parts: MeshPart[] = [];
      const segs: number[] = [];
      let start = 0;
      for (const [ci, list] of byChunk) {
        let n = 0;
        for (const p of list) (parts.push(p), (n += p.indices.length));
        segs.push(ci, start, n);
        start += n;
      }
      const first = parts[0];
      const geometry = mergeParts(parts);
      this.disposables.push(geometry);

      const built = createSurfaceMaterial(
        {
          material: first.material,
          textureKey: first.textureKey,
          vertexColors: !!first.colors,
          vertexAlpha: !!first.vertexAlpha,
          translucent: !!first.translucent,
          hasUvs: !!first.uvs,
          splat: first.splatWeights ? first.splat : undefined,
          side: this.cullBackfaces ? THREE.FrontSide : THREE.DoubleSide,
          levelGeometry: true,
        },
        textureSource,
      );
      for (const k of built.missing) missing.add(k);
      const material = built.material;
      if (first.lightmapKey !== undefined && first.uvs2 && material instanceof THREE.MeshStandardNodeMaterial) {
        material.lightMap = getTexture(first.lightmapKey, 'lm');
        material.lightMapIntensity = 1.6;
        if (!material.lightMap) missing.add(first.lightmapKey);
      }
      this.materials.push(material);
      this.disposables.push(material);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = first.textureKey ?? material.name;
      mesh.matrixAutoUpdate = false;
      this.levelGroup.add(mesh);
      if (segs.length > 3) {
        const index = geometry.index!;
        // Not DynamicDrawUsage: three.js's WebGPU backend uploads such a buffer whole on every
        // render() that draws it (every pass, every frame: ~3.7 MB a frame in 1a). compactLevel
        // bumps its version with an update range when the packing changes (docs/game-logic.md §18).
        this.compact.push({ mesh, full: (index.array as Uint32Array).slice(), segs: Int32Array.from(segs), hash: 0, count: index.count });
      }

      stats.meshes++;
      stats.vertices += geometry.getAttribute('position').count;
      stats.triangles += (geometry.index?.count ?? 0) / 3;
    }
    stats.textures = [...gpuTextures.values()].filter((t) => t).length;
    this.culler = new ZoneCuller(level.visibility, chunks);
    this.compactVersion = -1;
    stats.chunks = chunks.length;
    stats.zones = level.visibility?.zones.length ?? 0;
    stats.missingTextures = [...missing];
    if (missing.size) console.warn(`[renderer] ${missing.size} missing texture keys`, stats.missingTextures);

    // The level never moves: compute its matrices once and keep it out of the per-frame
    // scene-graph update (thousands of meshes).
    this.levelGroup.updateMatrixWorld(true);
    this.levelGroup.matrixWorldAutoUpdate = false;
    this.frameLevel(level);

    // Collision: the original's collision geometry when the loader built it (LevelData.collision,
    // docs/game-logic.md §14.10), else everything drawn unless a filter is set (PartFilter).
    this.collision = level.collision
      ? new CollisionWorld({ parts: level.collision })
      : new CollisionWorld(level, { filter: this.collisionFilter?.(level, textures) });
    this.drawn = level.collision ? new CollisionWorld(level) : this.collision;
    this.player.setWorld(this.collision);
    stats.collisionTriangles = this.collision.stats.triangles;
    stats.collisionMs = this.collision.stats.ms;
    console.info('[physics] BVH', this.collision.stats);
    if (level.spawn) {
      const [x, y, z] = level.spawn.position;
      // LevelData.spawn.position is the eye (player object + 1.6).
      this.player.spawn({ x, y: y - 1.6, z }, level.spawn.yaw);
    }
    // Levels with a player start begin in walk mode (?fly starts in noclip).
    const walk = !!level.spawn && !new URLSearchParams(location.search).has('fly');
    this.walking = walk;
    this.player.enabled = walk;
    this.controls.enabled = !walk;
    this.player.root.visible = walk && this.player.mode === 'tp';
    return stats;
  }

  /** Fit camera planes, fog, flashlight range and fly speed to the level; place the camera. */
  private frameLevel(level: LevelData) {
    this.levelGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.levelGroup);
    if (box.isEmpty()) box.set(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const diag = Math.max(size.length(), 1e-3);

    this.camera.near = diag * 2e-4;
    this.camera.far = diag * 4;
    this.camera.updateProjectionMatrix();

    // Fog: ~37% visibility at 1/2.5 of the level diagonal, clamped for huge levels.
    this.baseFogDensity = 2.5 / diag;
    this.fog.density = this.baseFogDensity;
    this.flashlight.distance = 2.2 / this.fog.density;
    this.controls.speed = diag / 12;

    if (level.spawn) {
      // Game levels are in ~metres: walk at roughly player pace in thick fog.
      this.controls.speed = 5;
      this.baseFogDensity = Math.max(this.baseFogDensity, 0.025);
      this.fog.density = this.baseFogDensity;
      this.flashlight.distance = 2.2 / this.fog.density;
      const [x, y, z] = level.spawn.position;
      this.controls.setPose(new THREE.Vector3(x, y, z), level.spawn.yaw, 0);
    } else {
      // Look at the level centre from a raised diagonal.
      const eye = center.clone().add(new THREE.Vector3(size.x * 0.45, size.y * 0.6 + diag * 0.1, size.z * 0.45));
      this.controls.lookFrom(eye, center);
      // Seeing the whole layout is more useful than fog when auto-framing.
      this.fog.density = 0.6 / diag;
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * One node build per shader cache key, also when several compiles run at once.
 *
 * three.js stores a built material (its NodeBuilderState) under the render object's cache key
 * only when the build has finished. Precompile lanes, per-caster shadow compiles and the
 * systems' own compileAsync calls run concurrently, so objects with the same key that were in
 * flight together each built the same shader again: 1a's load made 1,886 builds for 1,024
 * keys, almost all of it main-thread time (docs/game-logic.md §18.8). An async build for a key
 * that is already being built now waits for that build and takes it from the cache.
 */
function coalesceNodeBuilds(renderer: THREE.WebGPURenderer) {
  type State = unknown;
  const nodes = (renderer as unknown as { _nodes?: {
    getForRender(ro: unknown, useAsync?: boolean): State | Promise<State>;
    getForRenderCacheKey(ro: unknown): unknown;
    get(ro: unknown): { nodeBuilderState?: State };
    nodeBuilderCache: Map<unknown, State>;
  } })._nodes;
  if (!nodes || typeof nodes.getForRender !== 'function' || !(nodes.nodeBuilderCache instanceof Map)) return;
  const pending = new Map<unknown, Promise<unknown>>();
  const getForRender = nodes.getForRender.bind(nodes);
  nodes.getForRender = (ro: unknown, useAsync = false) => {
    if (!useAsync || nodes.get(ro).nodeBuilderState !== undefined) return getForRender(ro, useAsync);
    const key = nodes.getForRenderCacheKey(ro);
    if (nodes.nodeBuilderCache.has(key)) return getForRender(ro, true);
    const busy = pending.get(key);
    // Afterwards the key is in the cache (or, if that build failed, this one builds it).
    if (busy) return busy.then(() => getForRender(ro, true), () => getForRender(ro, true));
    const p = getForRender(ro, true);
    if (p instanceof Promise) {
      pending.set(key, p);
      const done = () => pending.delete(key);
      p.then(done, done);
    }
    return p;
  };
}

function makeMissingTexture(disposables: { dispose(): void }[]): THREE.DataTexture {
  const tex = missingTexture();
  disposables.push(tex);
  return tex;
}

/** Concatenate parts (all with the same attribute layout) into one indexed geometry. */
function mergeParts(parts: MeshPart[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const p of parts) {
    vCount += p.positions.length / 3;
    iCount += p.indices.length;
  }
  const first = parts[0];
  const positions = new Float32Array(vCount * 3);
  const normals = first.normals ? new Float32Array(vCount * 3) : null;
  const uvs = first.uvs ? new Float32Array(vCount * 2) : null;
  const uvs2 = first.uvs2 ? new Float32Array(vCount * 2) : null;
  const colorSize = first.colors ? Math.round(first.colors.length / (first.positions.length / 3)) || 4 : 4;
  const colors = first.colors ? new Float32Array(vCount * colorSize) : null;
  const splat = first.splatWeights ? new Float32Array(vCount * 8) : null;
  const indices = new Uint32Array(iCount);

  let v = 0;
  let i = 0;
  for (const p of parts) {
    const n = p.positions.length / 3;
    positions.set(p.positions, v * 3);
    if (normals && p.normals) normals.set(p.normals, v * 3);
    if (uvs && p.uvs) uvs.set(p.uvs, v * 2);
    if (uvs2 && p.uvs2) uvs2.set(p.uvs2, v * 2);
    if (colors && p.colors) colors.set(p.colors.subarray(0, n * colorSize), v * colorSize);
    if (splat && p.splatWeights) splat.set(p.splatWeights.subarray(0, n * 8), v * 8);
    for (let k = 0; k < p.indices.length; k++) indices[i + k] = p.indices[k] + v;
    v += n;
    i += p.indices.length;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (uvs2) geo.setAttribute('uv1', new THREE.BufferAttribute(uvs2, 2));
  if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, colorSize));
  if (splat) {
    // Floor-layer splat weights: two vec4 attributes from one interleaved 8-float buffer.
    const ib = new THREE.InterleavedBuffer(splat, 8);
    geo.setAttribute('splat0', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    geo.setAttribute('splat1', new THREE.InterleavedBufferAttribute(ib, 4, 4));
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
