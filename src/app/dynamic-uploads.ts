// Vertex buffers marked DynamicDrawUsage are uploaded when they change, not on every draw.
//
// three.js r186's renderer (common/Attributes.js `update`) writes a DynamicDrawUsage attribute to
// the GPU every time an object using it is drawn, whether or not its version changed, and the
// whole array once the first write of the frame has consumed its update ranges. The port marks
// CPU-rewritten geometry that way (particle pools, rain, Enhanced blood films and droplets, the
// glow pass's mark batches; visibility.ts / prop-batch.ts read the mark to leave it alone), and
// every writer sets `needsUpdate` (with update ranges where it knows them) after writing. So the
// version is a reliable change signal: uploading on a version change only gives the GPU the same
// contents. Enhanced High's blood films alone were 2.9 MB of writeBuffer a frame in 1a's gas
// chamber (docs/perf.md). Storage and indirect buffers keep three.js's behaviour.

import * as THREE from 'three/webgpu';

/** three.js's AttributeType (renderers/common/Constants.js). */
const VERTEX = 1;
const INDEX = 2;

interface AttributesLike {
  update(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, type: number): void;
  get(attribute: object): { version?: number };
  _getBufferAttribute(attribute: object): { usage: number; version: number };
}

/** Install the upload-on-change rule on a renderer (no-op on a three.js without the hook). */
export function uploadDynamicOnChange(renderer: THREE.WebGPURenderer): boolean {
  const attrs = (renderer as unknown as { _attributes?: AttributesLike })._attributes;
  if (!attrs || typeof attrs.update !== 'function' || typeof attrs.get !== 'function' || typeof attrs._getBufferAttribute !== 'function') return false;
  const update = attrs.update.bind(attrs);
  attrs.update = (attribute, type) => {
    if (type === VERTEX || type === INDEX) {
      const buf = attrs._getBufferAttribute(attribute);
      if (buf.usage === THREE.DynamicDrawUsage) {
        const seen = attrs.get(attribute).version;
        // Already on the GPU at this version: nothing to write.
        if (seen !== undefined && seen >= buf.version) return;
      }
    }
    update(attribute, type);
  };
  return true;
}
