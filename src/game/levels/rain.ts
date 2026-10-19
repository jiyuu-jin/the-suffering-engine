// Volumetric Rain (class 0xd61bc46f, Special Effect, 24 properties): falling rain streaks in a
// box. 53 placed in 3a/3b YardCellBlock, 4a Quarry, 5a/5b Asylum, 6a Woods, 10 Docks.
//
// Data [verified over every placed instance; meanings inferred from the values]:
//   model    3:400 = a 12 x 12 x 12 m box (x, z -6..6, y 0..12) or 3:1009 = a unit box (drips
//            under the 5b roof holes); x the instance scale = the rain volume. Not drawn.
//   p0       streak texture (3:313)            p1  colour (0x505050 yard, 0x727272 storm)
//   p2       drop count (16..500)               p6  streak length (m: 0.1..0.5) [guess]
//   p8       streak width (0.11..0.25) [guess]  p11 fall speed (m/s: 7.5 yard, 20 storm)
//   p12      speed variation (0.2 / 0.5)       p13 on at start
//   p14      volume follows the camera (the yard / courtyard-wide rain; Ambient Sound zones
//            switch it Off indoors and On outdoors through their p21 / p22 links) [inferred]
//   p15/p16  On / Off input messages (instances that start off swap them: 2 / 1)
//   p17      Destroy input [guess]              p18..p20 fall direction (wind slant, y = -1)
//   p3 p4 p5 p7 p9 p10 p21..p23  not interpreted.
//
// Port: CPU-simulated additive line streaks per volume (one draw each); drops wrap inside the
// volume (camera-following volumes wrap around the camera). Each drop stops at the first solid
// surface on its path (a ray along the fall direction from where it starts, cast once per drop
// and fall), so rain does not fall through roofs, awnings or ceilings inside a volume and
// lands on whatever is below; where it stops, a small additive splash ring grows and fades
// (~0.2 s) [port: the splash look is not decoded; p3 = 1 / p5 = 20 / p21..p23 may be splash
// settings]. Camera-following volumes also skip drops whose start point has a surface above it
// (indoors, under a roof) [port]. Volumes more than CULL_DISTANCE from the camera are not
// simulated.

import * as THREE from 'three/webgpu';
import { instanceRotation, WORLD_SCALE } from '../../formats/level';
import { readModel, type PackageSet } from '../../formats/model';
import type { CollisionWorld } from '../../app/physics';
import type { World, WorldEntity } from '../world/logic';

/** Static volumes farther than this (m, from the box) are neither simulated nor drawn. */
const CULL_DISTANCE = 70;
/** Splash rings alive at once (oldest reused). */
const SPLASHES = 384;
/** Splash life (s) and final radius (m). */
const SPLASH_LIFE = 0.22;
const SPLASH_SIZE = 0.16;
/** Camera-following rain: a spawn point with a surface this close above it is under cover. */
const COVER_CHECK = 30;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

interface RainVolume {
  w: WorldEntity;
  on: boolean;
  follow: boolean;
  /** World-space AABB (static volumes) / half extents + y range around the camera (follow). */
  min: THREE.Vector3;
  max: THREE.Vector3;
  size: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  spread: number;
  len: number;
  n: number;
  drops: Float32Array;
  speeds: Float32Array;
  /** World y where each drop stops (first surface on its path, else the volume floor). */
  stop: Float32Array;
  /** World x / z the stop height was found for (camera-following volumes move under it). */
  stopXZ: Float32Array;
  /** Colour (linear) of the splashes. */
  color: THREE.Color;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  line: THREE.LineSegments;
}

export class Rain {
  readonly group = new THREE.Group();
  private readonly volumes: RainVolume[] = [];
  private readonly mats = new Map<number, THREE.LineBasicNodeMaterial>();
  private readonly tmp = new THREE.Vector3();
  private splashMesh?: THREE.InstancedMesh;
  private readonly splashT = new Float32Array(SPLASHES).fill(-1);
  private readonly splashC: THREE.Color[] = [];
  private splashNext = 0;
  private readonly m4 = new THREE.Matrix4();
  /** Counters (tests / debug): rays cast, splashes spawned, drops stopped above the volume floor. */
  readonly stats = { rays: 0, splashes: 0, blocked: 0 };

  constructor(
    private readonly world: World,
    packages: PackageSet,
    private readonly collision: () => CollisionWorld | null | undefined = () => null,
  ) {
    this.group.name = 'levels-rain';
    for (const w of world.of('Volumetric Rain')) {
      try {
        const v = this.build(w, packages);
        if (v) this.volumes.push(v);
      } catch (err) {
        console.warn('[levels] rain volume not built', w.uid.toString(16), err);
      }
    }
    world.handlers.push((w, msg) => this.onMessage(w, msg));
    if (this.volumes.length) this.initSplashes();
  }

  private initSplashes() {
    const geo = new THREE.RingGeometry(0.45, 1, 10).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // Additive effects fade to black, not to the fog colour (engine rule for blend 2).
    mat.fog = false;
    const mesh = new THREE.InstancedMesh(geo, mat, SPLASHES);
    mesh.name = 'rain-splashes';
    mesh.frustumCulled = false;
    mesh.count = SPLASHES;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SPLASHES; i++) {
      mesh.setMatrixAt(i, zero);
      mesh.setColorAt(i, new THREE.Color(0, 0, 0));
      this.splashC.push(new THREE.Color());
    }
    this.splashMesh = mesh;
    this.group.add(mesh);
  }

  private splash(x: number, y: number, z: number, c: THREE.Color) {
    if (!this.splashMesh) return;
    const i = this.splashNext;
    this.splashNext = (i + 1) % SPLASHES;
    this.splashT[i] = 0;
    this.splashC[i].copy(c);
    this.m4.makeScale(0.01, 0.01, 0.01).setPosition(x, y + 0.02, z);
    this.splashMesh.setMatrixAt(i, this.m4);
    this.stats.splashes++;
  }

  private updateSplashes(dt: number) {
    const mesh = this.splashMesh;
    if (!mesh) return;
    let any = false;
    for (let i = 0; i < SPLASHES; i++) {
      let t = this.splashT[i];
      if (t < 0) continue;
      any = true;
      t += dt;
      mesh.getMatrixAt(i, this.m4);
      const x = this.m4.elements[12], y = this.m4.elements[13], z = this.m4.elements[14];
      if (t >= SPLASH_LIFE) {
        this.splashT[i] = -1;
        this.m4.makeScale(0, 0, 0);
        mesh.setColorAt(i, this.splashC[i].setRGB(0, 0, 0));
      } else {
        this.splashT[i] = t;
        const k = t / SPLASH_LIFE;
        const r = SPLASH_SIZE * (0.3 + 0.7 * k);
        this.m4.makeScale(r, r, r);
        mesh.setColorAt(i, this.tmpColor.copy(this.splashC[i]).multiplyScalar(1 - k));
      }
      this.m4.setPosition(x, y, z);
      mesh.setMatrixAt(i, this.m4);
    }
    if (any) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private readonly tmpColor = new THREE.Color();

  /** Is there a surface above (x, y, z) within COVER_CHECK m (roof, ceiling)? */
  private covered(x: number, y: number, z: number): boolean {
    const col = this.collision();
    if (!col) return false;
    this.stats.rays++;
    return !!col.raycast(x, y, z, 0, 1, 0, COVER_CHECK);
  }

  /** World y where a drop starting at (x, y, z) stops (first surface along `dir`, else `floor`). */
  private stopAt(x: number, y: number, z: number, dir: THREE.Vector3, floor: number): number {
    const col = this.collision();
    if (!col) return floor;
    const len = (y - floor) / Math.max(0.05, -dir.y);
    if (!(len > 0)) return floor;
    this.stats.rays++;
    const h = col.raycast(x, y, z, dir.x, dir.y, dir.z, len);
    if (!h) return floor;
    this.stats.blocked++;
    return h.point[1];
  }

  get count() {
    return this.volumes.length;
  }

  private material(color: number) {
    let m = this.mats.get(color);
    if (!m) {
      m = new THREE.LineBasicNodeMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
      this.mats.set(color, m);
    }
    return m;
  }

  private build(w: WorldEntity, packages: PackageSet): RainVolume | undefined {
    const v = w.e.values;
    // Volume box: the template model's bounds (12 m cube by default), instance scale, rotation.
    const lo = new THREE.Vector3(-6, 0, -6), hi = new THREE.Vector3(6, 12, 6);
    const m = w.e.modelRef ? readModel(packages, w.e.modelRef) : undefined;
    if (m && m.positions.length) {
      lo.set(Infinity, Infinity, Infinity);
      hi.set(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < m.positions.length; i += 3) {
        lo.min(this.tmp.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
        hi.max(this.tmp);
      }
    }
    const s = w.e.scale ?? [1, 1, 1];
    const R = instanceRotation(w.e.rotation);
    const o = [w.e.position[0] / WORLD_SCALE, w.e.position[1] / WORLD_SCALE, w.e.position[2] / WORLD_SCALE];
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let k = 0; k < 8; k++) {
      const px = (k & 1 ? hi.x : lo.x) * s[0], py = (k & 2 ? hi.y : lo.y) * s[1], pz = (k & 4 ? hi.z : lo.z) * s[2];
      this.tmp.set(o[0] + R[0] * px + R[1] * py + R[2] * pz, o[1] + R[3] * px + R[4] * py + R[5] * pz, o[2] + R[6] * px + R[7] * py + R[8] * pz);
      min.min(this.tmp);
      max.max(this.tmp);
    }
    const follow = num(v[14]) !== 0;
    if (follow) {
      // Around the camera: the box's horizontal size, from a few metres below to above it.
      const hx = (max.x - min.x) / 2, hz = (max.z - min.z) / 2, h = max.y - min.y;
      min.set(-hx, -h * 0.35, -hz);
      max.set(hx, h * 0.65, hz);
    }
    const size = new THREE.Vector3().subVectors(max, min);
    if (!(size.x > 0 && size.y > 0 && size.z > 0)) return undefined;
    const n = Math.max(1, Math.min(2000, Math.round(num(v[2], 100))));
    const dir = new THREE.Vector3(num(v[18], 0), num(v[19], -1), num(v[20], 0));
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0);
    dir.normalize();
    const drops = new Float32Array(3 * n);
    const speeds = new Float32Array(n);
    const speed = Math.max(0.5, num(v[11], 10));
    const spread = Math.min(0.9, Math.max(0, num(v[12], 0.3)));
    for (let i = 0; i < n; i++) {
      drops[3 * i] = Math.random() * size.x;
      drops[3 * i + 1] = Math.random() * size.y;
      drops[3 * i + 2] = Math.random() * size.z;
      speeds[i] = speed * (1 - spread + 2 * spread * Math.random());
    }
    const stop = new Float32Array(n).fill(-Infinity);
    const stopXZ = new Float32Array(2 * n).fill(NaN);
    const pos = new Float32Array(6 * n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const line = new THREE.LineSegments(geo, this.material(num(v[1], 0x505050) & 0xffffff));
    line.name = `rain#${w.uid.toString(16)}`;
    line.frustumCulled = false;
    line.matrixAutoUpdate = false;
    const on = num(v[13], 1) !== 0;
    line.visible = on;
    this.group.add(line);
    const color = new THREE.Color().setHex(num(v[1], 0x505050) & 0xffffff, THREE.SRGBColorSpace);
    return { w, on, follow, min, max, size, dir, speed, spread, len: Math.max(0.12, num(v[6], 0.4)), n, drops, speeds, stop, stopXZ, color, geo, pos, line };
  }

  private onMessage(w: WorldEntity, msg: number): boolean {
    if (w.cls !== 'Volumetric Rain') return false;
    const vol = this.volumes.find((x) => x.w === w);
    if (!vol) return false;
    const v = w.e.values;
    if (num(v[15], 1) === msg) vol.on = true;
    else if (num(v[16], 2) === msg) vol.on = false;
    else if (num(v[17], 0) === msg) {
      vol.on = false;
      this.world.destroy(w);
    } else return false;
    vol.line.visible = vol.on;
    return true;
  }

  update(dt: number, camera: THREE.Camera) {
    const step = Math.min(dt, 0.1);
    const cam = camera.position;
    for (const vol of this.volumes) {
      if (!vol.on || vol.w.destroyed || !vol.w.visible) {
        vol.line.visible = false;
        continue;
      }
      if (!vol.follow) {
        const dx = Math.max(vol.min.x - cam.x, 0, cam.x - vol.max.x);
        const dy = Math.max(vol.min.y - cam.y, 0, cam.y - vol.max.y);
        const dz = Math.max(vol.min.z - cam.z, 0, cam.z - vol.max.z);
        if (dx * dx + dy * dy + dz * dz > CULL_DISTANCE * CULL_DISTANCE) {
          vol.line.visible = false;
          continue;
        }
      }
      vol.line.visible = true;
      const { drops, speeds, pos, size, dir, len, stop, stopXZ } = vol;
      // Origin of the wrap box in world space.
      let ox = vol.min.x, oy = vol.min.y, oz = vol.min.z;
      if (vol.follow) {
        ox += cam.x;
        oy += cam.y;
        oz += cam.z;
      }
      const wrapX = (x: number) => (vol.follow ? ox + ((((x - ox) % size.x) + size.x) % size.x) : ox + x);
      const wrapZ = (z: number) => (vol.follow ? oz + ((((z - oz) % size.z) + size.z) % size.z) : oz + z);
      for (let i = 0; i < vol.n; i++) {
        const j = 3 * i;
        const d = speeds[i] * step;
        let x = drops[j] + dir.x * d, y = drops[j + 1] + dir.y * d, z = drops[j + 2] + dir.z * d;
        // World position: camera-following volumes wrap around the moving camera (drops keep
        // world positions modulo the box size: no swimming with the camera).
        let wx = wrapX(x), wz = wrapZ(z);
        let wy = oy + y;
        // A drop of a camera-following volume can wrap onto another spot: find its stop again.
        if (vol.follow && Math.abs(wx - stopXZ[2 * i]) + Math.abs(wz - stopXZ[2 * i + 1]) > 1.5) stop[i] = -Infinity;
        if (stop[i] === -Infinity) {
          const top = oy + size.y;
          const back = (top - wy) / Math.max(0.05, -dir.y);
          const sx = wx - dir.x * back, sz = wz - dir.z * back;
          stop[i] = vol.follow && this.covered(sx, top, sz) ? Infinity : this.stopAt(sx, top, sz, dir, oy);
          stopXZ[2 * i] = wx;
          stopXZ[2 * i + 1] = wz;
        }
        if (stop[i] === Infinity) {
          // Hidden (covered) drop: no streak until it respawns.
          if (y < 0) stop[i] = -Infinity;
          drops[j] = x;
          drops[j + 1] = y < 0 ? y + size.y : y;
          drops[j + 2] = z;
          pos.fill(0, 6 * i, 6 * i + 6);
          continue;
        }
        if (y < 0 || wy <= stop[i]) {
          // Splash only where a surface stopped the drop.
          if (wy <= stop[i] && stop[i] > oy + 0.01) this.splash(wx, stop[i], wz, vol.color);
          // Back to the top at a new spot.
          y = size.y - Math.random() * Math.min(size.y, d);
          x = Math.random() * size.x;
          z = Math.random() * size.z;
          wx = wrapX(x);
          wz = wrapZ(z);
          wy = oy + y;
          // Camera-following rain under a roof (the spawn point has cover above it within
          // COVER_CHECK m): the drop falls hidden this time (stop = Infinity) [port].
          stop[i] = vol.follow && this.covered(wx, wy, wz) ? Infinity : this.stopAt(wx, wy, wz, dir, oy);
          stopXZ[2 * i] = wx;
          stopXZ[2 * i + 1] = wz;
        }
        drops[j] = x;
        drops[j + 1] = y;
        drops[j + 2] = z;
        const k = 6 * i;
        pos[k] = wx;
        pos[k + 1] = wy;
        pos[k + 2] = wz;
        pos[k + 3] = wx - dir.x * len;
        pos[k + 4] = wy - dir.y * len;
        pos[k + 5] = wz - dir.z * len;
      }
      (vol.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    this.updateSplashes(step);
  }

  dispose() {
    this.group.removeFromParent();
    for (const v of this.volumes) v.geo.dispose();
    for (const m of this.mats.values()) m.dispose();
    if (this.splashMesh) {
      this.splashMesh.geometry.dispose();
      (this.splashMesh.material as THREE.Material).dispose();
      this.splashMesh.dispose();
    }
  }
}
