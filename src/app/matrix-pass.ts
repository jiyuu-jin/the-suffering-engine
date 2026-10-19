// The renderer's per-frame world-matrix update (LevelRenderer.frame) and objects it may skip.

let inPass = false;

/** Run the per-frame world-matrix update (`fn`). */
export function framePass(fn: () => void) {
  inPass = true;
  try {
    fn();
  } finally {
    inPass = false;
  }
}

/**
 * Let the per-frame world-matrix update skip `obj` and its subtree while `obj` is hidden: it is
 * not drawn, so its matrices only need to be current once it shows again (skinned characters
 * carry dozens of bones each). Explicit updateMatrixWorld / updateWorldMatrix calls made by the
 * game systems still update it, and the first pass after it is shown recomputes everything.
 */
export function skipMatricesWhileHidden(obj: { visible: boolean; updateMatrixWorld(force?: boolean): void }) {
  const update = obj.updateMatrixWorld;
  obj.updateMatrixWorld = function (this: typeof obj, force?: boolean) {
    if (inPass && !this.visible) return;
    update.call(this, force);
  };
}
