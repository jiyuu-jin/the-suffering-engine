// Spawned Billboard templates (glow sprites thrown by Object Generators; placed Billboards are
// drawn by world/fx.ts). [inferred, from the values]: p0 texture, size p2 (near) .. p3 (far)
// growing with the distance up to p9 m and fading beyond it (as the placed ones), p4 seconds of
// life for a spawned one. The retail spawned billboards (3:2156 / 3:2167 / 3:2168, the projector
// lamp of 3:2158) live 0.1 s and are re-thrown every 0.1..0.15 s by their generator, which gives
// the flicker.

import * as THREE from 'three/webgpu';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { FxSpawner, TemplateInfo } from '../world/fx';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const firstRef = (v: PropValue | undefined): ResRef | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as ResRef) : null;
};

const CAP = 96;

interface Live {
  s: THREE.Sprite;
  life: number;
  age: number;
  size: [number, number];
  far: number;
}

/** Life (s), sizes and fade distance of a spawned Billboard template. */
export function billboardParams(v: PropValue[]) {
  return {
    life: Math.max(0.05, num(v[4], 0.1)),
    size: [Math.max(0.02, num(v[2], 0.5)), Math.max(0.05, num(v[3], 2))] as [number, number],
    far: Math.max(5, num(v[9], 40)),
  };
}

export class SpawnedBillboards {
  readonly group = new THREE.Group();
  private readonly live: Live[] = [];
  private readonly free = new Map<string, THREE.Sprite[]>();
  private readonly mats = new Map<string, THREE.SpriteMaterial>();
  private readonly cam = new THREE.Vector3();
  spawned = 0;

  constructor(private readonly texture: (r: ResRef | null) => THREE.Texture | null) {
    this.group.name = 'fx-spawned-billboards';
  }

  readonly spawner: FxSpawner = (t: TemplateInfo, M: THREE.Matrix4) => {
    if (t.cls !== 'Billboard') return false;
    const tex = firstRef(t.values[0]);
    const map = this.texture(tex);
    if (!map || !tex) return true;
    if (this.live.length >= CAP) this.release(0);
    const key = `${tex.pkg}:${tex.id}`;
    let mat = this.mats.get(key);
    if (!mat) this.mats.set(key, (mat = new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    const s = this.free.get(key)?.pop() ?? new THREE.Sprite(mat);
    s.userData.key = key;
    s.renderOrder = 4;
    s.position.setFromMatrixPosition(M);
    s.visible = true;
    this.group.add(s);
    const p = billboardParams(t.values);
    this.live.push({ s, life: p.life, age: 0, size: p.size, far: p.far });
    this.spawned++;
    return true;
  };

  private release(i: number) {
    const x = this.live[i];
    this.live.splice(i, 1);
    x.s.visible = false;
    x.s.removeFromParent();
    const key = x.s.userData.key as string;
    (this.free.get(key) ?? this.free.set(key, []).get(key)!).push(x.s);
  }

  update(dt: number, camera: THREE.Camera) {
    camera.getWorldPosition(this.cam);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.age += dt;
      if (b.age >= b.life) {
        this.release(i);
        continue;
      }
      const d = this.cam.distanceTo(b.s.position);
      const k = Math.min(1, d / b.far);
      b.s.scale.setScalar(b.size[0] + (b.size[1] - b.size[0]) * k);
    }
  }

  get count() {
    return this.live.length;
  }

  dispose() {
    for (let i = this.live.length - 1; i >= 0; i--) this.release(i);
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.free.clear();
    this.group.removeFromParent();
  }
}
