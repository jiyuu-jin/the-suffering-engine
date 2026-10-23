// What the player sees while looking through a Security Monitor (docs/game-logic.md §14.5,
// "View Monitor" in Suffering.rfl; the view code is 0x1001b4a0 start, 0x1001b080 per frame).
//
// The original renders the camera's view as the normal frame, with the player's view matrix set
// to the camera Mechanism's (p47, offset p48..p50) and the field of view set to p51 through the
// view manager (0x1001b5cb). Two templated objects ride in front of that view:
//
//   - the screen (p57; p58 instead while the camera is gone or the monitor is "Disabled"), a
//     Breakable model posed p59 (0.38 m) in front of the camera every frame: model 3:251 is the
//     curved CRT glass (Animating Material 3:2560, frames 3:226..229 at 60 fps, alpha blend: a
//     milky pane with a rolling scan bar) inside a black bezel (3:4988) that reaches past the 4:3
//     screen to the sides; model 3:252 is the same bezel round an opaque noise texture (3:299)
//     whose UVs jump at random 30 times a second (waveform 3:12): no signal;
//   - a Warp Effect (p55, 3:1658), posed p56 (0.38 m) in front: a card (model 3:249) that the
//     engine draws from the frame behind it, its lookup bent by the gradient of the height map
//     p1 (3:202, a dark rounded rectangle with soft white surroundings) times p7 (0.14). The
//     gradient field (Suffering.rfl 0x10139de0: per texel h[x+1] - h[x] and h[y+1] - h[y], bytes
//     / 255) is flat inside the screen and non-zero only round its rounded edges, so the picture
//     bends at the edges like the glass of a tube.
//
// The Disable / Enable inputs (p70 / p71) set and clear the "no signal" flag (0x1001a970 /
// 0x1001a980) [verified]: they do not end the view. 1a uses them for the scares: Horace walks up
// to the camera of monitor 6dec and his last Waypoint disables the monitor (static and a sound)
// for 0.5 s while he is removed; monitor 66f5 flickers to static every 1.5 +- 0.5 s.
//
// Screens are not render targets: the renderer's InitRenderTarget (vtable +0x30, 0x49af40) has a
// single caller, the shadow pass (0x4cd8c2), so the monitors in the world only ever show their own
// Animating Material [verified].
//
// Port: the overlay objects are built once from the templates through the dynamic objects'
// model builder (their surface materials: Animating frames, scroll waveforms), hung under the
// camera while a view is on and parked in the pre-warm group otherwise. They draw after the
// scene without depth test (in the original they sit 0.38 m in front of the eye and walls are
// never that close to a camera). The warp card samples the frame through the viewport texture
// with the decoded gradient field [the use of the field as a screen-UV offset is inferred: the
// per-frame consumer of the field was not traced].

import * as THREE from 'three/webgpu';
import { screenUV, texture, uv, vec4, viewportSharedTexture } from 'three/tsl';
import { findEntry, TDU_TEXTURE, type PackageSet, type ResRef } from '../../formats/model';
import { decodeTexture } from '../../formats/texture';
import type { EntityPackageSet, PropValue } from '../../formats/entities';
import type { DynamicObjects } from './dynamic';
import { readTemplate } from './fx';
import { warmObjects } from '../../app/prewarm';
import { cloneWithGlowMark } from '../../app/glow-mark';
import { GAMMA_BACK_BUFFER, gammaDecode } from '../../app/engine-light';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);

/**
 * Gradient field of a warp height map (Suffering.rfl 0x10139de0): for every texel the forward
 * differences along x and y of the height (0..1), the last column / row wrapping to the first
 * texel of the row / map as the original does. Returns interleaved (dx, dy) floats.
 */
export function warpGradient(height: ArrayLike<number>, width: number, rows: number): Float32Array {
  const out = new Float32Array(width * rows * 2);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const h = height[i];
      const right = x + 1 < width ? height[i + 1] : height[y * width];
      const down = y + 1 < rows ? height[i + width] : height[x];
      out[2 * i] = right - h;
      out[2 * i + 1] = down - h;
    }
  }
  return out;
}

/**
 * The camera's vertical field of view (degrees) for a monitor lens of `deg`: the engine's lens is
 * a vertical angle of the 4:3 picture (SUFFERING.EXE 0x4b21f0 / 0x4b1f30: 48 / tan(fov / 2) on a
 * 96-unit-high film). The monitor view is pillarboxed by its bezel, so wider frames keep the full
 * height (more of the sides goes under the bezel) instead of the cropped height the main view
 * uses (renderer.ts lensFov); taller frames keep the 4:3 width.
 */
export function monitorFov(deg: number, aspect: number): number {
  const t = Math.tan((deg * Math.PI) / 360) * Math.max(1, 4 / 3 / Math.max(aspect, 1e-3));
  return (2 * Math.atan(t) * 180) / Math.PI;
}

/**
 * Distance in front of the eye at which a screen of half-height `halfHeight` (m) spans a
 * vertical field of view of `vfovDeg`. The original poses the screen p59 = 0.38 m out with the
 * view at p51 = 60 degrees; the 0.329 m tall glass then covers 75 % of a 4:3 picture's height,
 * and exactly all of it when the 4:3 horizontal angle is kept on a 16:9 frame (0.165 /
 * tan(23.3 deg) = 0.38 m). The port poses it so that the glass always fills the height, with the
 * bezel at the sides of wider frames [inferred: which projection the 0.38 m was made for is
 * not known].
 */
export function screenDistance(halfHeight: number, vfovDeg: number): number {
  return halfHeight / Math.tan((Math.max(1, Math.min(179, vfovDeg)) * Math.PI) / 360);
}

interface Piece {
  root: THREE.Object3D;
  /** Template distance in front of the eye (m) and the model's half-height. */
  dist: number;
  halfHeight: number;
  dispose(): void;
}

export class MonitorOverlay {
  private screen?: Piece;
  private noSignal?: Piece;
  private warp?: Piece;
  private shown?: 'screen' | 'noSignal';
  private host?: THREE.Object3D;

  constructor(
    private readonly pkgs: EntityPackageSet,
    private readonly dyn: DynamicObjects,
    values: PropValue[],
  ) {
    const modelOf = (r: ResRef | null) => (r ? readTemplate(pkgs, r)?.model : undefined);
    this.screen = this.piece(modelOf(ref(values[57])), num(values[59], 0.38), 'monitor-screen');
    this.noSignal = this.piece(modelOf(ref(values[58])), num(values[59], 0.38), 'monitor-no-signal');
    const w = ref(values[55]) ? readTemplate(pkgs, ref(values[55])!) : undefined;
    if (w?.cls === 'Warp Effect') this.warp = this.warpPiece(w.model, ref(w.values[1]), num(w.values[7], 0.14), num(values[56], 0.38));
    // Parked in the pre-warm group (hidden) so their pipelines are built at load.
    for (const p of [this.screen, this.noSignal, this.warp]) if (p) warmObjects.add(p.root);
  }

  /**
   * Hang the overlay under `camera` (or take it off with null); `signal` picks the screen,
   * `vfov` (degrees) is the camera's vertical field of view (the screens are posed to fill it).
   */
  show(camera: THREE.Object3D | null, signal = true, vfov = 46.6) {
    const want = camera ? (signal ? 'screen' : 'noSignal') : undefined;
    const glass = this.screen ?? this.noSignal;
    if (glass) {
      const k = screenDistance(glass.halfHeight, vfov) / glass.dist;
      for (const p of [this.screen, this.noSignal, this.warp]) {
        if (!p) continue;
        const z = -p.dist * k;
        if (p.root.matrix.elements[14] !== z) (p.root.matrix.makeTranslation(0, 0, z), (p.root.matrixWorldNeedsUpdate = true));
      }
    }
    if (want === this.shown && camera === this.host) return;
    for (const p of [this.screen, this.noSignal, this.warp]) if (p) warmObjects.add(p.root);
    this.shown = want;
    this.host = camera ?? undefined;
    if (!camera || !want) return;
    const piece = want === 'screen' ? this.screen ?? this.noSignal : this.noSignal ?? this.screen;
    if (piece) camera.add(piece.root);
    // The warp card bends the picture behind the glass; the noise screen is opaque anyway.
    if (this.warp && want === 'screen') camera.add(this.warp.root);
  }

  dispose() {
    for (const p of [this.screen, this.noSignal, this.warp]) {
      p?.root.removeFromParent();
      p?.dispose();
    }
  }

  /** One templated model posed `dist` in front of the eye, drawn over the scene. */
  private piece(model: ResRef | undefined, dist: number, name: string): Piece | undefined {
    if (!model) return undefined;
    const d = this.dyn.spawnModel(model, new THREE.Matrix4(), { collides: false, name });
    if (!d) return undefined;
    // Not a world object: out of the dynamic objects' bookkeeping (culling, batching, saving).
    this.dyn.objects.delete(d.uid);
    d.root.removeFromParent();
    d.root.matrix.makeTranslation(0, 0, -dist);
    d.root.matrixWorldNeedsUpdate = true;
    const owned: THREE.Material[] = [];
    let order = 0;
    let halfHeight = 0;
    d.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) halfHeight = Math.max(halfHeight, Math.abs(pos.getY(i)));
      const mat = cloneWithGlowMark(m.material as THREE.Material);
      // Drawn after the scene, in model order (glass, then the bezel round it), always on top.
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.transparent = true;
      m.material = mat;
      m.renderOrder = 10001 + order++;
      m.frustumCulled = false;
      owned.push(mat);
    });
    return {
      root: d.root,
      dist,
      halfHeight: halfHeight || 0.165,
      dispose: () => {
        for (const m of owned) m.dispose();
        d.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      },
    };
  }

  /** The Warp Effect card: the frame behind it, looked up through the height map's gradient. */
  private warpPiece(model: ResRef | undefined, heightRef: ResRef | null, strength: number, dist: number): Piece | undefined {
    const base = this.piece(model, dist, 'monitor-warp');
    if (!base) return undefined;
    const field = heightRef ? this.gradientTexture(heightRef) : undefined;
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    mat.name = 'monitor-warp';
    const offset = field ? texture(field, uv()).xy.mul(2).sub(1).mul(strength) : undefined;
    const frame = viewportSharedTexture(offset ? screenUV.add(offset) : screenUV);
    // The frame holds gamma values (engine-light.ts GAMMA_BACK_BUFFER); the material's output is
    // encoded again, so decode it first: the card copies the frame unchanged.
    mat.colorNode = GAMMA_BACK_BUFFER ? vec4(gammaDecode(frame.rgb), frame.a) : frame;
    base.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      (m.material as THREE.Material).dispose();
      m.material = mat;
      m.renderOrder = 10000;
    });
    return {
      ...base,
      dispose: () => {
        base.dispose();
        mat.dispose();
        field?.dispose();
      },
    };
  }

  private gradientTexture(r: ResRef): THREE.DataTexture | undefined {
    const tdu = (this.pkgs as PackageSet).get(r.pkg)?.tdu;
    const e = findEntry(tdu, TDU_TEXTURE, r.id);
    const t = tdu && e ? decodeTexture(tdu, e) : null;
    if (!t) return undefined;
    const h = new Float32Array(t.width * t.height);
    for (let i = 0; i < h.length; i++) h[i] = t.rgba[i * 4] / 255;
    const g = warpGradient(h, t.width, t.height);
    // Stored biased in 8 bits (x 0.5 + 0.5; a difference of two bytes / 255 fits exactly).
    const px = new Uint8Array(t.width * t.height * 4);
    for (let i = 0; i < t.width * t.height; i++) {
      px[4 * i] = Math.round((g[2 * i] * 0.5 + 0.5) * 255);
      px[4 * i + 1] = Math.round((g[2 * i + 1] * 0.5 + 0.5) * 255);
      px[4 * i + 3] = 255;
    }
    const tex = new THREE.DataTexture(px, t.width, t.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }
}
