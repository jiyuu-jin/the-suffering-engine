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
