// Enhanced mode: Killjoy's projector beams as a soft fan of light (docs/enhanced.md "Projector
// beams"). Original keeps the decoded draw: five additive cones of thin rays from each lens to
// his outline (docs/game-logic.md §15.7.8, game/actors/specials/projector.ts).
//
// Each standing beam becomes a light volume (light-volume-pass.ts): a soft elliptical cone from
// the lens to the outline its rays reach, its light per section the same along it (focus 1), so
// the gaps between the rays fill in and the edges fade out like a projector's beam in a dusty
// room; the volume stops on his body by the scene's depth. The original rays stay at
// `rayKeep` of their light for the streaks of the film, and a few dust motes drift in the beam,
// catching the light now and then. All of it flickers with his opacity (Projector Effect p4).

import * as THREE from 'three/webgpu';
import { float, instancedDynamicBufferAttribute, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { lightVolumeScene, type DynamicLightVolume, type LightVolumeShape } from './light-volume';
import { warmObjects } from '../prewarm';

/** The look (QA / tuning: `(await import('/src/app/enhanced/projector-beam.ts')).PROJECTOR_BEAM`). */
export const PROJECTOR_BEAM = {
  /** Share of the original rays' light kept over the volume. */
  rayKeep: 0.5,
  /** Light per metre at full opacity (linear HDR, before the 1.6 additive gain), and its tint. */
  gain: 0.07,
  colour: [1, 0.9, 0.74] as [number, number, number],
  /** Half width (m) at the lens; side fade share; length fade (m). */
  apex: 0.04,
  soft: 0.55,
  endFade: 0.3,
  /** No light within `near` m of the eye; each beam's light at a pixel saturates towards `cap` (light-volume.ts). */
  near: 2.5,
  cap: 0.08,
  /** Dust motes per beam, their size (m) and peak brightness (linear). */
  motes: 22,
  moteSize: 0.012,
  moteLight: 0.55,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _m = new THREE.Vector3();

/** A beam's cone in world space (lens, axis frame, length, far half extents and centre). */
interface Cone {
  apex: THREE.Vector3;
  axis: THREE.Vector3;
  e1: THREE.Vector3;
  e2: THREE.Vector3;
  length: number;
  rx: number;
  ry: number;
  cx: number;
  cy: number;
}

/** Fit the cone from the lens to the points its rays end on (world). Null when degenerate. */
export function fitBeamCone(apex: THREE.Vector3, far: readonly THREE.Vector3[], out?: Cone): Cone | null {
  if (far.length < 3) return null;
  _m.set(0, 0, 0);
  for (const f of far) _m.add(f);
  _m.multiplyScalar(1 / far.length);
  const axis = (out?.axis ?? new THREE.Vector3()).subVectors(_m, apex);
  const len0 = axis.length();
  if (len0 < 0.05) return null;
  axis.multiplyScalar(1 / len0);
  let L = 0;
  for (const f of far) L = Math.max(L, _v.subVectors(f, apex).dot(axis));
  if (L < 0.05) return null;
  // Cross frame: the principal direction of the far points about the axis.
  const ref = Math.abs(axis.y) < 0.9 ? _a.set(0, 1, 0) : _a.set(1, 0, 0);
  const u1 = new THREE.Vector3().crossVectors(ref, axis).normalize();
  const u2 = new THREE.Vector3().crossVectors(axis, u1);
  const pts: [number, number][] = [];
  let sxx = 0, sxy = 0, syy = 0, mx = 0, my = 0;
  for (const f of far) {
    _v.subVectors(f, apex);
    const z = Math.max(1e-3, _v.dot(axis));
    // (Projected along its ray to the far end: the outline as the cone's section there.)
    const x = (_v.dot(u1) * L) / z, y = (_v.dot(u2) * L) / z;
    pts.push([x, y]);
    mx += x / far.length;
    my += y / far.length;
  }
  for (const [x, y] of pts) (sxx += (x - mx) ** 2), (sxy += (x - mx) * (y - my)), (syy += (y - my) ** 2);
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(ang), s = Math.sin(ang);
  const e1 = (out?.e1 ?? new THREE.Vector3()).copy(u1).multiplyScalar(c).addScaledVector(u2, s);
  const e2 = (out?.e2 ?? new THREE.Vector3()).crossVectors(axis, e1);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    const a = x * c + y * s, b = -x * s + y * c;
    (x0 = Math.min(x0, a)), (x1 = Math.max(x1, a)), (y0 = Math.min(y0, b)), (y1 = Math.max(y1, b));
  }
  const cone = out ?? ({ apex: new THREE.Vector3(), axis, e1, e2 } as Cone);
  cone.apex.copy(apex);
  cone.length = L;
  cone.rx = Math.max(0.05, (x1 - x0) / 2);
  cone.ry = Math.max(0.05, (y1 - y0) / 2);
  cone.cx = (x0 + x1) / 2;
  cone.cy = (y0 + y1) / 2;
  return cone;
}

/** The cone as a light volume of the pass (light-volume.ts LightVolumeShape). */
export function beamVolume(k: Cone, opacity: number, out: LightVolumeShape): LightVolumeShape {
  const B = PROJECTOR_BEAM;
  out.origin = [k.apex.x, k.apex.y, k.apex.z];
  out.axis = [k.axis.x, k.axis.y, k.axis.z];
  out.e1 = [k.e1.x, k.e1.y, k.e1.z];
  out.e2 = [k.e2.x, k.e2.y, k.e2.z];
  out.length = k.length;
  out.c0 = [0, 0];
  out.r0 = [B.apex, B.apex];
  out.c1 = [k.cx, k.cy];
  out.r1 = [k.rx, k.ry];
  out.exponent = 2;
  out.soft = B.soft;
  out.endFade = Math.min(B.endFade, 0.2 * k.length);
  out.focus = 1;
  out.near = B.near;
  out.cap = B.cap;
  out.profile = null;
  out.colour = [B.colour[0] * opacity, B.colour[1] * opacity, B.colour[2] * opacity];
  out.gain = B.gain;
  const h = k.length / 2;
  out.centre = [k.apex.x + k.axis.x * h, k.apex.y + k.axis.y * h, k.apex.z + k.axis.z * h];
  out.radius = Math.hypot(h, Math.abs(k.cx) + k.rx, Math.abs(k.cy) + k.ry);
  return out;
}

/** The motes' instanced sprite (one draw for every speck of a figure's beams). */
function motesSprite(posAttr: THREE.InstancedBufferAttribute, colAttr: THREE.InstancedBufferAttribute): THREE.Sprite {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.positionNode = instancedDynamicBufferAttribute(posAttr, 'vec3');
  mat.scaleNode = float(PROJECTOR_BEAM.moteSize);
  const glow: N = instancedDynamicBufferAttribute(colAttr, 'float');
  // A soft round speck (no texture): 1 at the centre, 0 at the quad's rim.
  const d: N = uv().sub(0.5).length().mul(2);
  const dot: N = float(1).sub(smoothstep(0.15, 1, d));
  mat.colorNode = vec4(vec3(...PROJECTOR_BEAM.colour).mul(dot.mul(dot).mul(glow)), float(1));
  mat.fog = false;
  mat.name = 'enhanced-projector-motes';
  const sprite = new THREE.Sprite(mat);
  sprite.name = 'enhanced-projector-motes';
  sprite.frustumCulled = false;
  sprite.count = 0;
  sprite.renderOrder = 3;
  return sprite;
}

let warmed = false;
/**
 * Park one motes sprite in the precompile's objects (prewarm.ts warmObjects) so the pipeline is
 * built with the level, not when the first projected figure shows (projector.ts, at its creation).
 */
export function warmProjectorMotes() {
  if (warmed) return;
  warmed = true;
  const s = motesSprite(new THREE.InstancedBufferAttribute(new Float32Array(3), 3), new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
  s.count = 1;
  warmObjects.add(s);
}

const emptyCone = (): Cone => ({ apex: new THREE.Vector3(), axis: new THREE.Vector3(), e1: new THREE.Vector3(), e2: new THREE.Vector3(), length: 1, rx: 0.1, ry: 0.1, cx: 0, cy: 0 });

interface Mote {
  /** Fraction along the beam, position in the unit section, twinkle phase / rate. */
  s: number;
  a: number;
  b: number;
  ph: number;
  rate: number;
  va: number;
  vb: number;
  vs: number;
}

/** The fan of one projected figure: a volume per beam plus the motes. */
export class ProjectorBeamFx {
  private readonly cones: (Cone | null)[];
  private readonly on: boolean[];
  /** Each beam's lens and ray ends this frame, and the merged cone of a lens's beams. */
  private readonly apex: THREE.Vector3[] = [];
  private readonly far: THREE.Vector3[][] = [];
  private readonly merged: (Cone | undefined)[] = [];
  private readonly mergedPts: THREE.Vector3[] = [];
  private readonly volumes: DynamicLightVolume[] = [];
  private opacity = 0;
  private readonly motes: Mote[][];
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly colAttr: THREE.InstancedBufferAttribute;
  readonly sprite: THREE.Sprite;
  private time = 0;
  private rand = 0x9e3779b9;

  constructor(
    private readonly parent: THREE.Object3D,
    count: number,
  ) {
    const B = PROJECTOR_BEAM;
    this.cones = Array.from({ length: count }, () => null);
    this.on = Array.from({ length: count }, () => false);
    this.motes = Array.from({ length: count }, () => Array.from({ length: B.motes }, () => this.mote()));
    for (let i = 0; i < count; i++) {
      const vol: DynamicLightVolume = {
        update: (out) => {
          if (!this.on[i] || !this.cones[i] || this.opacity <= 0.01) return false;
          // Beams from one lens (1b: all five p10 entries are the same projector) are one volume,
          // fitted to all their rays' ends: drawn by the first of them, its light x sqrt(n) for
          // the cones the original sums there (one fifth of the per-pixel cost).
          const lens = this.apex[i];
          for (let j = 0; j < i; j++) if (this.on[j] && this.apex[j].distanceToSquared(lens) < 1e-4) return false;
          const pts = this.mergedPts;
          pts.length = 0;
          let n = 0;
          for (let j = i; j < this.on.length; j++)
            if (this.on[j] && this.apex[j].distanceToSquared(lens) < 1e-4) {
              n++;
              for (const f of this.far[j]) pts.push(f);
            }
          const k = n > 1 ? fitBeamCone(lens, pts, (this.merged[i] ??= emptyCone())) : this.cones[i];
          if (!k) return false;
          beamVolume(k, this.opacity, out);
          out.gain *= Math.sqrt(n);
          return true;
        },
      };
      this.volumes.push(vol);
      lightVolumeScene.dynamic.add(vol);
    }
    const n = count * B.motes;
    this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.colAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sprite = motesSprite(this.posAttr, this.colAttr);
    parent.add(this.sprite);
  }

  private rnd(): number {
    // xorshift32: the motes' own sequence (Math.random stays the game's).
    let x = this.rand;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rand = x >>> 0;
    return this.rand / 4294967296;
  }

  private mote(): Mote {
    const r = Math.sqrt(this.rnd()) * 0.85, t = this.rnd() * Math.PI * 2;
    return { s: 0.12 + this.rnd() * 0.8, a: r * Math.cos(t), b: r * Math.sin(t), ph: this.rnd() * 6.28, rate: 0.6 + this.rnd() * 1.6, va: 0, vb: 0, vs: 0 };
  }

  /** Beam i this frame: its lens and the (world) points its rays end on, or off. */
  set(i: number, apex: THREE.Vector3 | null, far: readonly THREE.Vector3[]) {
    if (i >= this.cones.length) return;
    if (!apex) {
      this.on[i] = false;
      return;
    }
    const k = fitBeamCone(apex, far, this.cones[i] ?? undefined);
    this.cones[i] = k ?? this.cones[i];
    this.on[i] = !!k;
    (this.apex[i] ??= new THREE.Vector3()).copy(apex);
    const keep = (this.far[i] ??= []);
    keep.length = far.length;
    far.forEach((f, j) => (keep[j] ??= new THREE.Vector3()).copy(f));
  }

  /** Every beam off (the effect is not running, or its figure is hidden). */
  clear() {
    this.on.fill(false);
  }

  setOpacity(op: number) {
    this.opacity = Math.max(0, Math.min(1, op));
  }

  /** Drift the motes and write them (once per frame). */
  step(dt: number) {
    const B = PROJECTOR_BEAM;
    this.time += dt;
    const pos = this.posAttr.array as Float32Array, col = this.colAttr.array as Float32Array;
    let n = 0;
    this.cones.forEach((k, i) => {
      if (!k || !this.on[i] || this.opacity <= 0.01) return;
      for (const m of this.motes[i]) {
        // Brownian drift in the beam's section, slow along it; re-seeded when it leaves.
        m.va += (this.rnd() - 0.5) * dt * 0.6;
        m.vb += (this.rnd() - 0.5) * dt * 0.6;
        m.vs += (this.rnd() - 0.5) * dt * 0.05;
        m.va *= 0.98;
        m.vb *= 0.98;
        m.vs *= 0.98;
        m.a += m.va * dt;
        m.b += m.vb * dt;
        m.s += m.vs * dt;
        if (m.a * m.a + m.b * m.b > 0.8 || m.s < 0.08 || m.s > 0.95) Object.assign(m, this.mote());
        const z = m.s * k.length;
        const f = m.s;
        const rx = B.apex + (k.rx - B.apex) * f, ry = B.apex + (k.ry - B.apex) * f;
        const x = k.cx * f + m.a * rx, y = k.cy * f + m.b * ry;
        const j = 3 * n;
        pos[j] = k.apex.x + k.axis.x * z + k.e1.x * x + k.e2.x * y;
        pos[j + 1] = k.apex.y + k.axis.y * z + k.e1.y * x + k.e2.y * y;
        pos[j + 2] = k.apex.z + k.axis.z * z + k.e1.z * x + k.e2.z * y;
        // A speck catches the light now and then; nearer the lens the beam is denser.
        const tw = Math.max(0, Math.sin(this.time * m.rate + m.ph));
        col[n] = B.moteLight * this.opacity * tw * tw * tw * (1.4 - 0.6 * f);
        n++;
      }
    });
    this.sprite.count = n;
    this.sprite.visible = n > 0;
    if (n) {
      for (const a of [this.posAttr, this.colAttr]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const v of this.volumes) lightVolumeScene.dynamic.delete(v);
    this.sprite.removeFromParent();
    // (The sprite geometry is three.js's shared quad: not disposed.)
    (this.sprite.material as THREE.Material).dispose();
    void this.parent;
  }
}
