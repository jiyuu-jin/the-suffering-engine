// One draw for a double-sided blended surface whose result does not depend on draw order.
//
// three.js draws a transparent DoubleSide material in two passes, back faces then front faces
// (Renderer.renderObject), so a blended closed shape composites its far side first. That doubles
// the draw calls of every such mesh: 3a's 59 burning barrels (three flame cards each) cost 177
// extra draws a frame, a fight's blood and bullet decals another 96 (docs/perf.md). When the blend
// is a pure sum (destination + or - source x a factor that does not read the destination) and
// the surface writes no depth, the order of its triangles cannot change the result: one draw with
// culling off (`forceSinglePass`) gives the same pixels. The engine itself draws two-sided
// surfaces in one pass (D3D9 CULL_NONE, docs/re/renderer.md).

import * as THREE from 'three/webgpu';

const ORDER_FREE_SRC = new Set<number>([THREE.OneFactor, THREE.ZeroFactor, THREE.SrcAlphaFactor, THREE.SrcColorFactor]);
const SUM_EQUATIONS = new Set<number>([THREE.AddEquation, THREE.ReverseSubtractEquation]);

/** Does `m` blend as an order-independent sum (and write no depth)? */
export function blendIsOrderFree(m: THREE.Material): boolean {
  if (!m.transparent || m.depthWrite) return false;
  if (m.blending === THREE.AdditiveBlending) return true;
  if (m.blending !== THREE.CustomBlending) return false;
  const sum = (eq: number, src: number, dst: number) => SUM_EQUATIONS.has(eq) && dst === THREE.OneFactor && ORDER_FREE_SRC.has(src);
  return (
    sum(m.blendEquation, m.blendSrc, m.blendDst) &&
    sum(m.blendEquationAlpha ?? m.blendEquation, m.blendSrcAlpha ?? m.blendSrc, m.blendDstAlpha ?? m.blendDst)
  );
}

/** Draw `m` in one pass when it is double-sided and its blend is order-free. Returns whether it was. */
export function singlePassIfOrderFree(m: THREE.Material): boolean {
  if (m.side !== THREE.DoubleSide || !blendIsOrderFree(m)) return false;
  m.forceSinglePass = true;
  return true;
}
