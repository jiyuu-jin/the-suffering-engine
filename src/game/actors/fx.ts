// Short-lived combat effects of the actors system: NPC muzzle flashes + bullet tracers, and
// the jagged electric arcs of Damage Action Objects (Electric Arc Effect templates).

import * as THREE from 'three/webgpu';

interface Item {
  obj: THREE.Object3D;
  life: number;
  max: number;
  update?: (k: number) => void;
}

export class ActorFx {
  readonly group = new THREE.Group();
  private items: Item[] = [];
  private tracerMat = new THREE.LineBasicNodeMaterial({ color: 0xffe2a0, transparent: true, depthWrite: false });
  private arcMat = new THREE.LineBasicNodeMaterial({ color: 0xbfe0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

  /** Pooled lights (adding / removing lights would recompile every lit material). */
  private lights: THREE.PointLight[] = [];
  private nextLight = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'actor-fx';
    scene.add(this.group);
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffc070, 0, 7, 1.6);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  private light(color: number, x: number, y: number, z: number) {
    const l = this.lights[this.nextLight++ % this.lights.length];
    l.color.setHex(color);
    l.position.set(x, y, z);
    return l;
  }

  /** Muzzle flash light at `from` and a faint tracer to `to`. */
  shot(from: THREE.Vector3Like, to: THREE.Vector3Like) {
    const light = this.light(0xffc070, from.x, from.y, from.z);
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z)]);
    const line = new THREE.Line(g, this.tracerMat.clone());
    const mat = line.material as THREE.LineBasicNodeMaterial;
    this.add(line, 0.07, (k) => {
      mat.opacity = 0.8 * (1 - k);
      light.intensity = k >= 1 ? 0 : 6 * (1 - k);
    });
  }

  /** A slow projectile (thrown needle) flying from `from` to `to` at `speed` m/s: a short streak. */
  missile(from: THREE.Vector3Like, to: THREE.Vector3Like, speed: number) {
    const a = new THREE.Vector3(from.x, from.y, from.z), b = new THREE.Vector3(to.x, to.y, to.z);
    const len = a.distanceTo(b);
    const g = new THREE.BufferGeometry().setFromPoints([a.clone(), a.clone()]);
    const line = new THREE.Line(g, this.tracerMat.clone());
    const mat = line.material as THREE.LineBasicNodeMaterial;
    mat.color.setHex(0xd8e8ff);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const head = new THREE.Vector3(), tail = new THREE.Vector3();
    this.add(line, Math.max(0.05, len / Math.max(1, speed)), (k) => {
      head.lerpVectors(a, b, k);
      tail.lerpVectors(a, b, Math.max(0, k - 0.35 / Math.max(0.35, len)));
      pos.setXYZ(0, tail.x, tail.y, tail.z);
      pos.setXYZ(1, head.x, head.y, head.z);
      pos.needsUpdate = true;
      mat.opacity = k >= 1 ? 0 : 0.9;
    });
  }

  /** Flickering electric arc between two points for `seconds`. */
  arc(from: THREE.Vector3Like, to: () => THREE.Vector3Like | undefined, seconds: number) {
    const N = 12;
    const pos = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const line = new THREE.Line(g, this.arcMat.clone());
    const mat = line.material as THREE.LineBasicNodeMaterial;
    const light = this.light(0x9fc8ff, from.x, from.y, from.z);
    line.frustumCulled = false;
    let acc = 1;
    this.add(line, seconds, (k) => {
      const b = to();
      if (!b) return;
      acc += 1;
      if (acc < 2) return; // re-jag every other frame
      acc = 0;
      const len = Math.hypot(b.x - from.x, b.y - from.y, b.z - from.z);
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const j = i === 0 || i === N - 1 ? 0 : Math.sin(t * Math.PI) * Math.min(0.6, len * 0.08);
        pos[i * 3] = from.x + (b.x - from.x) * t + (Math.random() - 0.5) * j;
        pos[i * 3 + 1] = from.y + (b.y - from.y) * t + (Math.random() - 0.5) * j;
        pos[i * 3 + 2] = from.z + (b.z - from.z) * t + (Math.random() - 0.5) * j;
      }
      g.attributes.position.needsUpdate = true;
      light.position.set((from.x + b.x) / 2, (from.y + b.y) / 2, (from.z + b.z) / 2);
      mat.opacity = 0.6 + 0.4 * Math.random() * (1 - k * 0.5);
      light.intensity = k >= 1 ? 0 : 2 + Math.random() * 2;
    });
  }

  private add(obj: THREE.Object3D, max: number, update?: (k: number) => void) {
    this.group.add(obj);
    this.items.push({ obj, life: 0, max, update });
    update?.(0);
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += dt;
      const k = Math.min(1, it.life / it.max);
      it.update?.(k);
      if (it.life >= it.max) {
        this.remove(it);
        this.items.splice(i, 1);
      }
    }
  }

  private remove(it: Item) {
    it.obj.removeFromParent();
    const m = it.obj as THREE.Mesh;
    m.geometry?.dispose?.();
    (m.material as THREE.Material | undefined)?.dispose?.();
  }

  dispose() {
    for (const it of this.items) this.remove(it);
    for (const l of this.lights) l.dispose();
    this.items = [];
    this.tracerMat.dispose();
    this.arcMat.dispose();
    this.group.removeFromParent();
  }
}
