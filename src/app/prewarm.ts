// Pipeline pre-warming registry (docs/game-logic.md §18).
//
// WebGPU pipelines (and three's node shaders behind them) are built the first time an object
// is drawn with a material in a given pass; that costs from a few to a few hundred ms on the
// main thread and in the GPU process, i.e. a visible hitch. LevelRenderer.precompile() builds
// them ahead of time for the scene; systems that draw the scene into a target of their own
// (screen effects, security monitors) register it here so the scene is compiled for that pass
// too, and objects that appear only later (a material swapped in, a full-screen quad) can be
// parked in `warmObjects` (hidden; shown only while precompile gathers the scene).

import * as THREE from 'three/webgpu';

/**
 * Render targets the scene is also drawn into: precompile() compiles the scene for each, unless
 * the target has the frame target's attachments and colour space (then it shares the canvas
 * pass's shaders and pipelines; make new targets like that: docs/game-logic.md §18.8).
 */
export const warmTargets = new Set<THREE.RenderTarget>();

/**
 * Render passes of their own that draw the scene or the viewmodel (Enhanced mode's scene pass:
 * HDR colour + velocity; its viewmodel pass: MSAA colour + coverage): the target, the MRT outputs
 * it is drawn with and which scene. precompile() compiles them while the frame loop is suspended
 * (a level load), one at a time, holding the renderer's target and MRT until the pass's shaders
 * are built: three.js reads both when its asynchronous shader builds run, not when compileAsync()
 * is called, so a restored state built shaders without the pass's outputs (failed pipelines). The
 * compile uses the pass's own render context (`depth`): compileAsync() always takes the top-level
 * one, whose shaders a nested pass never reuses.
 */
export interface WarmPass {
  target: THREE.RenderTarget;
  mrt: THREE.MRTNode | null;
  viewmodel: boolean;
  /**
   * The render-call depth the pass is drawn at (a pass inside a post chain is a nested render);
   * three.js keys render contexts, and so every shader of the pass, by it. -1 until `probe` ran.
   */
  depth: number;
  /** Fills `depth` (e.g. draws the chain once with nothing in view). */
  probe?: () => void;
  /** The material the pass draws a scene material with (null: not drawn); default: its own. */
  material?: (m: THREE.Material) => THREE.Material | null;
}
export const warmPasses = new Set<WarmPass>();

/** Hidden objects (added to the scene by LevelRenderer) whose pipelines precompile() builds. */
export const warmObjects = new THREE.Group();
warmObjects.name = 'prewarm';
warmObjects.visible = false;

/** The same for the first-person viewmodel pass (added to its scene; no fog there). */
export const warmViewmodelObjects = new THREE.Group();
warmViewmodelObjects.name = 'prewarm-viewmodel';
warmViewmodelObjects.visible = false;

/** Extra work for precompile() (e.g. drawing a full-screen quad once); may return a promise. */
export const warmHooks = new Set<() => unknown>();
