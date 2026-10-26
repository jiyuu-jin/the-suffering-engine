// Fades on faded objects (docs/re/renderer.md §5.4, §5.1): below 0.99 opacity the draw is
// translucent; an opaque or cut-out first pass is drawn as mode 1 with the > 2 / 255 test
// (SUFFERING.EXE 0x48fb08..0x48fb2e) and keeps its depth write (0x48fc70); its alpha is the
// pass's texture alpha x ALPHAARG2 (oD0.a untinted: opacity² without colours; TFACTOR tinted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blend, type SurfaceMaterial } from '../src/formats/model';
import { BLEND_ALPHA_REF, TRANSLUCENT_OPACITY, translucentPassState } from '../src/formats/render-data';
import { createSurfaceMaterial, missingTexture, toDataTexture } from '../src/app/surface-material';

test('translucent pass state: modes 0 and 8 alike blend with the > 2 test and keep their depth write', () => {
  const cutout = { transparent: false, depthWrite: true, alphaTest: 200 / 255 };
  assert.deepEqual(translucentPassState(cutout, 0.5), { transparent: true, depthWrite: true, alphaTest: BLEND_ALPHA_REF });
  assert.deepEqual(translucentPassState(cutout, TRANSLUCENT_OPACITY), cutout, 'at 0.99 the own state is back');
  const opaque = { transparent: false, depthWrite: true, alphaTest: 0 };
  assert.deepEqual(translucentPassState(opaque, 0.98), { transparent: true, depthWrite: true, alphaTest: BLEND_ALPHA_REF });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;
/** Every node reachable from `root` through node-valued fields. */
function nodes(root: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  const seen = new Set<AnyNode>();
  const walk = (n: AnyNode, depth: number) => {
    if (!n || typeof n !== 'object' || seen.has(n) || depth > 200) return;
    seen.add(n);
    if (n.isNode) out.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'parent' || k.startsWith('_')) continue;
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
      else if (v && typeof v === 'object' && (v.isNode || k.endsWith('Node') || k === 'node')) walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const tex = toDataTexture({ key: '9:1', width: 4, height: 4, rgba: new Uint8Array(64).fill(200), hasAlpha: true });
const src = { texture: () => tex, missing: missingTexture };
const mat = (layers: SurfaceMaterial['layers']): SurfaceMaterial => ({ key: '9:901', cls: 0, layers });

test('an opaque first pass takes its pass alpha once the object fades (a select on the opacity)', () => {
  const opaque = createSurfaceMaterial({ material: mat([{ texture: '9:1', blend: Blend.Opaque }]), vertexColors: false, hasUvs: true }, src).material;
  const conds = nodes(opaque.colorNode).filter((n) => n.type === 'ConditionalNode' || n.constructor?.name === 'ConditionalNode');
  assert.ok(conds.length >= 1, 'the opaque pass alpha switches on the opacity');
  // A blended first pass already carries its alpha: no switch.
  const blended = createSurfaceMaterial({ material: mat([{ texture: '9:1', blend: Blend.Alpha }]), vertexColors: false, hasUvs: true }, src).material;
  assert.equal(nodes(blended.colorNode).filter((n) => n.type === 'ConditionalNode' || n.constructor?.name === 'ConditionalNode').length, 0);
});
