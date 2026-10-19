// Inventory 3D icons: the rotating item models drawn in the inventory GUI cells (GUI Inventory
// Cell #158: p17 focused / p21 normal "3d Icon" templates #159 / #160).
//
// What the data says [templates]: a 3d Icon spins at p26 deg/s (30) and differs between the
// focused and the normal cell only in p25 (1 / 0.5), read here as the icon's brightness
// [inferred]. The model is the item template's own model (Ranged / Melee Weapon, Missile Item,
// Map Item...: the pickup model); the Item family's p30..p34 (1, 45, 50, 0, 1 on every item) are
// taken as scale 1 and a 45 deg starting yaw [guess].
//
// Port: a second, small renderer on its own canvas over the HUD canvas (the HUD is 2D; reading
// pixels back from the game renderer would lag a frame and stall). It renders only while the
// inventory strip is visible: one orthographic view in canvas pixels, each model scaled to fit
// its cell, lit by a key and a fill light. When the renderer can't start, the cells keep the
// item names (inventory.ts).

import * as THREE from 'three/webgpu';
import type { PackageSet, ResRef } from '../../formats/model';
import { readObjectTemplate, type EntityPackageSet } from '../../formats/entities';
import { buildStaticModel } from '../weapons/models';
import type { Rect } from '../../formats/gui';

export interface IconCell {
  id: string;
  /** Rect in the HUD's virtual 640 x 480 space. */
  rect: Rect;
  focused: boolean;
}

export interface IconStyle {
  /** Degrees per second (3d Icon p26). */
  spin: number;
  /** Brightness of the focused / normal icon (p25). */
  focused: number;
  normal: number;
}

interface IconModel {
  root: THREE.Group;
  radius: number;
  centre: THREE.Vector3;
  mats: THREE.MeshStandardNodeMaterial[];
}

const ICON_CSS = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:7;';

export class InventoryIcons {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  private failed = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -2000, 2000);
  private readonly models = new Map<string, IconModel | null>();
  private shown = new Set<IconModel>();
  private visible = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly pkgs: PackageSet,
    readonly style: IconStyle = { spin: 30, focused: 1, normal: 0.5 },
  ) {
    this.canvas.className = 'hud-icons';
    this.canvas.style.cssText = ICON_CSS;
    this.canvas.style.visibility = 'hidden';
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x202028, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.4, 0.8, 1);
    this.scene.add(key);
  }

  /** Whether icons are being drawn (else the cells show names). */
  get active(): boolean {
    return this.ready && !this.failed;
  }

  private start() {
    if (this.renderer || this.failed) return;
    try {
      this.container.append(this.canvas);
      const forceWebGL = new URLSearchParams(location.search).has('webgl');
      const r = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true, forceWebGL });
      r.setClearColor(0x000000, 0);
      this.renderer = r;
      r.init()
        .then(() => {
          this.ready = true;
          console.info('[hud] inventory 3D icons ready');
        })
        .catch((err) => {
          this.failed = true;
          console.warn('[hud] inventory 3D icons unavailable', err);
        });
    } catch (err) {
      this.failed = true;
      console.warn('[hud] inventory 3D icons unavailable', err);
    }
  }

  /** The icon model of an item template ("pkg:id"): its own model, lit materials. */
  private model(id: string): IconModel | null {
    if (this.models.has(id)) return this.models.get(id)!;
    let out: IconModel | null = null;
    try {
      const [pkg, n] = id.split(':').map(Number);
      const t = Number.isFinite(pkg) && Number.isFinite(n) ? readObjectTemplate(this.pkgs as unknown as EntityPackageSet, { pkg, id: n }) : undefined;
      const ref: ResRef | undefined = t?.modelRef;
      const g = ref ? buildStaticModel(this.pkgs, ref, { unlit: true }) : undefined;
      if (g) {
        const mats: THREE.MeshStandardNodeMaterial[] = [];
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const list = [m.material].flat() as THREE.MeshBasicNodeMaterial[];
          const lit = list.map((b) => {
            const s = new THREE.MeshStandardNodeMaterial({ map: b.map, roughness: 0.75, metalness: 0.15, side: THREE.DoubleSide, alphaTest: b.alphaTest });
            mats.push(s);
            b.dispose();
            return s;
          });
          m.material = Array.isArray(m.material) ? lit : lit[0];
        });
        const box = new THREE.Box3().setFromObject(g);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const root = new THREE.Group();
        g.position.copy(sphere.center).negate();
        root.add(g);
        root.visible = false;
        this.scene.add(root);
        // Fit by the longest side (a spinning gun barely leaves the cell; the sphere is too small).
        const size = box.getSize(new THREE.Vector3());
        out = { root, radius: Math.max(1e-3, Math.max(size.x, size.y, size.z) / 2), centre: sphere.center, mats };
      }
    } catch (err) {
      console.warn(`[hud] icon model ${id}`, err);
    }
    this.models.set(id, out);
    return out;
  }

  /** True when `id` has a model to draw (call before drawing the cell's text stand-in). */
  has(id: string): boolean {
    this.start();
    return this.active && !!this.model(id);
  }

  /**
   * Draws the icons of `cells` (virtual rects) with the HUD's transform: canvas pixel =
   * offset + virtual * scale. `alpha` is the inventory strip's fade; `t` seconds.
   */
  render(cells: IconCell[], alpha: number, t: number, view: { W: number; H: number; s: number; ox: number; oy: number }) {
    const r = this.renderer;
    const show = this.active && alpha > 0.01 && cells.length > 0;
    if (!show) {
      if (this.visible) {
        this.visible = false;
        this.canvas.style.visibility = 'hidden';
      }
      return;
    }
    if (!r) return;
    if (this.canvas.width !== view.W || this.canvas.height !== view.H) r.setSize(view.W, view.H, false);
    const cam = this.camera;
    cam.left = 0;
    cam.right = view.W;
    cam.top = view.H;
    cam.bottom = 0;
    cam.updateProjectionMatrix();
    for (const m of this.shown) m.root.visible = false;
    this.shown.clear();
    const yaw = THREE.MathUtils.degToRad(45 + this.style.spin * t);
    for (const c of cells) {
      const m = this.model(c.id);
      if (!m) continue;
      const size = Math.min(c.rect.w, c.rect.h) * view.s;
      m.root.visible = true;
      m.root.position.set(view.ox + (c.rect.x + c.rect.w / 2) * view.s, view.H - (view.oy + (c.rect.y + c.rect.h / 2) * view.s), 0);
      m.root.scale.setScalar((size * 0.42) / m.radius);
      m.root.rotation.set(THREE.MathUtils.degToRad(15), yaw, 0, 'XYZ');
      const k = c.focused ? this.style.focused : this.style.normal;
      for (const mat of m.mats) mat.color.setScalar(k);
      this.shown.add(m);
    }
    this.canvas.style.opacity = String(Math.min(1, alpha));
    if (!this.visible) {
      this.visible = true;
      this.canvas.style.visibility = 'visible';
    }
    r.render(this.scene, cam);
  }

  /** Hides the canvas (front end open, cinematics, death). */
  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.canvas.style.visibility = 'hidden';
  }

  dispose() {
    for (const m of this.models.values()) {
      if (!m) continue;
      m.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const mat of m.mats) mat.dispose();
    }
    this.models.clear();
    this.renderer?.dispose();
    this.canvas.remove();
  }
}
