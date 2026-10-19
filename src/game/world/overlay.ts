// Dev overlay (toggle with the backquote key): trigger volumes, entity markers, links
// around the player, live message traffic and labels.

import * as THREE from 'three/webgpu';
import type { World, WorldEntity } from './logic';
import { messageName } from '../../formats/entities';

const LOGIC_COLORS: Record<string, number> = {
  Detector: 0x40e070,
  Timer: 0x4aa8ff,
  'Message Relay': 0xc080ff,
  'Count Down To Zero': 0xff70c0,
  'Visibility Toggler': 0xffe060,
  'Level Transition': 0xff3030,
  'Player Spawn Point': 0x30ffff,
  Switch: 0xff9a30,
  'STOMP Player': 0xff60a0,
  'Sound Effect': 0x80c0c0,
  'Help Popup': 0xffffff,
  Autosave: 0x30ff30,
  'Ammo Box': 0xffd000,
  'Health Bonus Item': 0xff4040,
};
const SKIP = new Set(['Static Object', 'Decoration', 'Move Node Object', 'Point Light', 'Breakable', 'Light Housing', 'Invisible Static Object', 'Animating Static', 'Instance Rendered Object', 'DripMorphingModel', 'Waypoint', 'Flee Position', 'Ranged Targeting Position']);

const CSS = `
.wov-panel { position:absolute; right:10px; top:10px; width:min(430px, 46vw); max-height:70vh; overflow:hidden; background:rgba(0,0,0,.72); color:#cfe; font:11px/1.3 ui-monospace, monospace; padding:6px 8px; border-radius:3px; pointer-events:none; z-index:6; white-space:pre; }
.wov-panel .h { color:#ffd27a; }
.wov-panel .u { color:#888; }
.wov-label { position:absolute; transform:translate(-50%, -100%); font:10px/1.1 ui-monospace, monospace; color:#fff; background:rgba(0,0,0,.55); padding:1px 3px; border-radius:2px; pointer-events:none; white-space:nowrap; z-index:6; }
`;

export class DevOverlay {
  readonly group = new THREE.Group();
  enabled = false;
  private boxes: THREE.LineSegments;
  private boxColors: THREE.BufferAttribute;
  private detectors: WorldEntity[];
  private logic: WorldEntity[];
  private nearDetectors: WorldEntity[] = [];
  /** Range (m) of the volumes / markers drawn. */
  range = 30;
  private links: THREE.LineSegments;
  private markers: THREE.InstancedMesh;
  private panel: HTMLDivElement;
  private labels: HTMLDivElement[] = [];
  private style: HTMLStyleElement;
  private acc = 1;
  private disposables: { dispose(): void }[] = [];

  constructor(
    private readonly world: World,
    private readonly camera: THREE.Camera,
    private readonly container: HTMLElement,
    private readonly playerPos: () => THREE.Vector3,
  ) {
    this.group.name = 'world-overlay';
    this.group.visible = false;
    this.group.renderOrder = 999;

    // Detector volumes (the ones near the player; rebuilt periodically).
    this.detectors = world.of('Detector').filter((d) => d.box);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.detectors.length * 24 * 3), 3));
    this.boxColors = new THREE.BufferAttribute(new Float32Array(this.detectors.length * 24 * 3), 3);
    g.setAttribute('color', this.boxColors);
    g.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false, transparent: true });
    this.boxes = new THREE.LineSegments(g, lineMat);
    this.boxes.frustumCulled = false;
    this.boxes.renderOrder = 999;
    this.group.add(this.boxes);

    // Links / message traffic near the player (rebuilt periodically).
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4096), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 4096), 3));
    lg.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(lg, lineMat);
    this.links.frustumCulled = false;
    this.links.renderOrder = 999;
    this.group.add(this.links);

    // Entity markers.
    this.logic = [...world.ents.values()].filter((w) => !SKIP.has(w.cls) && w.e.family !== 'Character');
    const mg = new THREE.OctahedronGeometry(0.08);
    const mm = new THREE.MeshBasicNodeMaterial({ depthTest: false, transparent: true, opacity: 0.85 });
    this.markers = new THREE.InstancedMesh(mg, mm, Math.max(1, this.logic.length));
    this.markers.count = 0;
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 999;
    this.group.add(this.markers);
    this.disposables.push(g, lg, lineMat, mg, mm);

    this.style = document.createElement('style');
    this.style.textContent = CSS;
    this.panel = document.createElement('div');
    this.panel.className = 'wov-panel';
    this.panel.hidden = true;
    container.append(this.style, this.panel);
  }

  toggle(on = !this.enabled) {
    this.enabled = on;
    this.group.visible = on;
    this.panel.hidden = !on;
    if (!on) for (const l of this.labels) l.hidden = true;
    return on;
  }

  update(dt: number) {
    if (!this.enabled) return;
    const w = this.world;
    // Detector colours: grey disabled, green armed, yellow occupied, white flash on fire, red used up.
    const col = this.boxColors.array as Float32Array;
    const c = new THREE.Color();
    this.nearDetectors.forEach((d, i) => {
      if (d.destroyed) c.setRGB(0.55, 0.1, 0.1);
      else if (!d.enabled) c.setRGB(0.35, 0.35, 0.35);
      else if (w.time - Number(d.s.flash ?? -9) < 0.6) c.setRGB(1, 1, 1);
      else if ((d.s.inside as Set<number>)?.size) c.setRGB(1, 0.85, 0.1);
      else c.setRGB(0.15, 0.85, 0.35);
      for (let k = 0; k < 24; k++) col.set([c.r, c.g, c.b], (i * 24 + k) * 3);
    });
    this.boxColors.needsUpdate = true;

    this.acc += dt;
    const p = this.playerPos();
    if (this.acc > 0.2) {
      this.acc = 0;
      this.rebuildVolumes(p);
      this.rebuildLinks(p);
      this.writePanel(p);
    }
    this.placeLabels(p);
  }

  private rebuildVolumes(p: THREE.Vector3) {
    const r2 = this.range * this.range;
    const near = (e: WorldEntity) => (e.pos[0] - p.x) ** 2 + (e.pos[1] - p.y) ** 2 + (e.pos[2] - p.z) ** 2 < r2;
    this.nearDetectors = this.detectors.filter((d) => near(d) || (d.box && (d.box.c[0] - p.x) ** 2 + (d.box.c[2] - p.z) ** 2 < r2));
    const pos = this.boxes.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    this.nearDetectors.forEach((d, i) => {
      const b = d.box!;
      const corner = (c: number) => [0, 1, 2].map((k) => b.c[k] + [0, 1, 2].reduce((s, a) => s + (((c >> a) & 1) * 2 - 1) * b.h[a] * b.ax[a][k], 0));
      EDGES.forEach(([a, c], j) => {
        pa.set(corner(a), (i * 24 + 2 * j) * 3);
        pa.set(corner(c), (i * 24 + 2 * j + 1) * 3);
      });
    });
    pos.needsUpdate = true;
    this.boxes.geometry.setDrawRange(0, this.nearDetectors.length * 24);
    // Markers.
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let n = 0;
    for (const e of this.logic) {
      if (e.destroyed || !near(e)) continue;
      m.makeTranslation(e.pos[0], e.pos[1] + 0.3, e.pos[2]);
      this.markers.setMatrixAt(n, m);
      this.markers.setColorAt(n, c.setHex(LOGIC_COLORS[e.cls] ?? 0x9090a0));
      n++;
    }
    this.markers.count = n;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }

  private nearby(p: THREE.Vector3, r: number) {
    const out: WorldEntity[] = [];
    for (const e of this.world.ents.values()) {
      if (SKIP.has(e.cls) || e.destroyed) continue;
      const dx = e.pos[0] - p.x, dy = e.pos[1] - p.y, dz = e.pos[2] - p.z;
      if (dx * dx + dy * dy + dz * dz < r * r) out.push(e);
    }
    return out;
  }

  private rebuildLinks(p: THREE.Vector3) {
    const g = this.links.geometry;
    const P = g.getAttribute('position') as THREE.BufferAttribute;
    const C = g.getAttribute('color') as THREE.BufferAttribute;
    const pa = P.array as Float32Array, ca = C.array as Float32Array;
    let n = 0;
    const push = (a: number[], b: number[], r: number, gg: number, bb: number) => {
      if (n + 2 > 4096) return;
      pa.set(a, 3 * n); ca.set([r, gg, bb], 3 * n); n++;
      pa.set(b, 3 * n); ca.set([r, gg, bb], 3 * n); n++;
    };
    const lift = (v: number[]) => [v[0], v[1] + 0.3, v[2]];
    for (const e of this.nearby(p, 8)) {
      for (const u of e.e.links) {
        const t = this.world.get(u);
        if (t) push(lift(e.pos), lift(t.pos), 0.25, 0.3, 0.55);
      }
    }
    // Message traffic in the last 1.5 s.
    const now = this.world.time;
    for (const m of this.world.log) {
      if (now - m.time > 1.5) continue;
      const a = this.world.get(m.from), b = this.world.get(m.to);
      if (a && b) push(lift(a.pos), lift(b.pos), 1, m.handled ? 0.9 : 0.3, 0.2);
    }
    g.setDrawRange(0, n);
    P.needsUpdate = true;
    C.needsUpdate = true;
  }

  private writePanel(p: THREE.Vector3) {
    const w = this.world;
    const lines: string[] = [];
    lines.push(`<span class="h">WORLD</span> t=${w.time.toFixed(1)}s  msgs=${w.delivered}  pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`);
    const cs = w.activeCutscenes();
    if (cs.length) lines.push(`cutscene: ${cs.map((c) => `${c.name} ${c.t.toFixed(0)}/${c.duration.toFixed(0)}s`).join(', ')}`);
    lines.push('<span class="h">messages</span>');
    for (const m of w.recent(18).reverse()) {
      const line = `${m.time.toFixed(1).padStart(6)} ${w.describe(m.from)} → ${w.describe(m.to)} ${messageName(m.message)}`;
      lines.push(m.handled ? esc(line) : `<span class="u">${esc(line)} ·</span>`);
    }
    this.panel.innerHTML = lines.join('\n');
  }

  private placeLabels(p: THREE.Vector3) {
    const near = this.nearby(p, 9).slice(0, 40);
    const rect = this.container.getBoundingClientRect();
    const v = new THREE.Vector3();
    while (this.labels.length < near.length) {
      const l = document.createElement('div');
      l.className = 'wov-label';
      this.container.append(l);
      this.labels.push(l);
    }
    this.labels.forEach((l, i) => {
      const e = near[i];
      if (!e) return void (l.hidden = true);
      v.set(e.pos[0], e.pos[1] + 0.45, e.pos[2]).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return void (l.hidden = true);
      l.hidden = false;
      l.style.left = `${((v.x + 1) / 2) * rect.width}px`;
      l.style.top = `${((1 - v.y) / 2) * rect.height}px`;
      const st = e.cls === 'Switch' ? (e.s.open ? ' open' : e.s.unlocked ? '' : ' locked') : e.cls === 'Timer' && e.s.running ? ` ${Number(e.s.left).toFixed(1)}s` : !e.enabled ? ' off' : '';
      const text = `${e.cls}#${e.uid.toString(16)}${st}`;
      if (l.textContent !== text) l.textContent = text;
    });
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
    this.panel.remove();
    this.style.remove();
    for (const l of this.labels) l.remove();
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
