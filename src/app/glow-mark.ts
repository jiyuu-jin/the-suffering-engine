// The scene-glow mark of a material (surface-material.ts glowMarkMaterial, scene-glow.ts): the
// material the glow pass swaps in for the mesh's own to write the frame's glow mask.
//
// It lives in the material's userData, but `Material.copy` / `clone` deep-copies userData with
// JSON.stringify / parse: a material stored there is serialised through `Material.toJSON`
// (textures and all) and comes back a plain object, which the glow pass would hand to the
// renderer as a material (`customProgramCacheKey is not a function`, chapter 5 in 1c6b915). So
// the mark is a non-enumerable property (JSON skips it; a plain clone simply has no mark), only
// a real material counts as a mark, and `cloneWithGlowMark` / `copyGlowMark` carry it over where
// a clone should keep glowing.

import type * as THREE from 'three/webgpu';

const KEY = 'glowMark';

/** Sets (or with `undefined` clears) the glow mark of `m`, out of reach of userData's JSON copy. */
export function setGlowMark(m: THREE.Material, mark: THREE.Material | undefined): void {
  Object.defineProperty(m.userData, KEY, { value: mark, enumerable: false, writable: true, configurable: true });
}

/** The glow mark of `m`, if it has one (anything that is not a material is no mark). */
export function glowMark(m: THREE.Material | null | undefined): THREE.Material | undefined {
  const v = (m?.userData as Record<string, unknown> | undefined)?.[KEY] as THREE.Material | undefined;
  return v?.isMaterial === true && typeof v.customProgramCacheKey === 'function' ? v : undefined;
}

/** Gives `to` the glow mark of `from` (a clone that should keep glowing). */
export function copyGlowMark(from: THREE.Material, to: THREE.Material): void {
  const mark = glowMark(from);
  if (mark) setGlowMark(to, mark);
}

/**
 * `m.clone()` that keeps the glow mark (the mark material is shared, as for the cache) and the
 * alpha test: three r186's NodeMaterial.copy copies only the setters of the subclass's own
 * prototype and skips `_` fields, so `Material.alphaTest` (backed by `_alphaTest`) came back 0
 * and a cloned cut-out pass drew its discarded texels (6a's figure 2135: black cone fans).
 */
export function cloneWithGlowMark<T extends THREE.Material>(m: T): T {
  const c = m.clone() as T;
  if (c.alphaTest !== m.alphaTest) c.alphaTest = m.alphaTest;
  copyGlowMark(m, c);
  return c;
}
