// Enhanced mode: the scene depth at the ambient occlusion's resolution (docs/perf.md "Perf C").
//
// GTAO runs at half resolution (TierFeatures.aoScale) but read the full-resolution depth for
// its 20-odd taps per pixel; its kernel (0.6 m) spans much of the screen near the camera, and the
// taps scattered over a 23 MB depth texture (2896 x 1960, 32-bit) made the pass bound by cache
// misses: 5.0 ms at Medium at 1a's cell row, 3.1 ms with half the radius. This pass copies the
// depth once, at the AO's own size, into a depth texture of its own (the nearest full-resolution
// texel at each texel centre, the one the AO's centre tap read), and the AO samples that: a
// quarter of the bytes, the same values.

import * as THREE from 'three/webgpu';
import { NodeUpdateType, passTexture, uv, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const _quad = new THREE.QuadMesh(undefined as unknown as THREE.NodeMaterial);
const _size = new THREE.Vector2();

export class HalfDepthNode extends THREE.TempNode {
  static get type() {
    return 'EnhancedHalfDepthNode';
  }
  /** Fraction of the drawing buffer (the AO's resolutionScale). */
  resolutionScale = 0.5;
  private readonly rt: THREE.RenderTarget;
  private readonly material = new THREE.NodeMaterial();
  private readonly textureNode: N;

  constructor(private readonly depthNode: N) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.FloatType;
    this.rt = new THREE.RenderTarget(1, 1, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, depthTexture });
    this.rt.texture.name = 'enhanced-half-depth';
    this.material.name = 'enhanced-half-depth';
    this.material.depthTest = true;
    this.material.depthWrite = true;
    this.material.depthFunc = THREE.AlwaysDepth;
    this.textureNode = passTexture(this as unknown as THREE.PassNode, depthTexture);
  }

  getTextureNode(): N {
    return this.textureNode;
  }

  updateBefore(frame: THREE.NodeFrame): undefined {
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

  setup(): N {
    this.material.colorNode = vec4(0);
    this.material.depthNode = this.depthNode.sample(uv()).r;
    this.material.needsUpdate = true;
    return this.textureNode;
  }

  dispose() {
    super.dispose();
    this.rt.dispose();
    this.material.dispose();
  }
}
