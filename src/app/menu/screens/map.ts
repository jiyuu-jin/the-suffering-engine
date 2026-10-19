// Map screen (Map key; UIP 18 = Map GUI #200). The game side (src/game/hud/map.ts) gathers the
// maps and notes and the screen's texts; this draws them over the paused game:
//
//   * the list of maps / notes (Map Inventory GUI rect): click or Up / Down selects;
//   * the selected image in the Map Display GUI rect, fitted at 100 %: the mouse wheel (or
//     Page Up / Page Down, + / -) zooms up to the display's p16 (300 %), a click centres the
//     view on the clicked point, the arrow keys pan; notes (Map Item p57 = 0) do not zoom;
//   * the Map GUI's instruction texts at their template rects;
//   * Esc (GUICancel) or the Map key again closes.
//
// The original's own drawing of the list cells (Map Inventory GUI p15 cell template #185) and
// of the display frame (#199 p18..p21) is not reproduced: a plain list and a thin frame.

import type { MapScreenData } from '../../../game/hud/map';
import type { CustomScreen, CustomUi, NavInput, Rect } from '../model';

const LIST: Rect = { x: 19, y: 67, w: 205, h: 149 };
const DISPLAY: Rect = { x: 230, y: 38, w: 371, h: 403 };
const ROW = 20;

export class MapScreen implements CustomScreen {
  readonly opaque = true;
  data: MapScreenData | null = null;
  private sel = 0;
  private zoom = 100;
  /** View centre in image pixels. */
  private cx = 0;
  private cy = 0;
  /** Codes of the Map action (closes the screen). */
  closeCodes: string[] = [];

  constructor(private readonly host: { sound?(kind: 'move' | 'select' | 'back' | 'value'): void } = {}) {}

  open(): void {
    this.sel = Math.min(this.data?.selected ?? 0, Math.max(0, (this.data?.maps.length ?? 1) - 1));
    this.reset();
  }

  private get map() {
    return this.data?.maps[this.sel];
  }

  private reset() {
    this.zoom = 100;
    const img = this.map?.image;
    this.cx = (img?.width ?? 0) / 2;
    this.cy = (img?.height ?? 0) / 2;
  }

  private get display(): Rect {
    return this.data?.display ?? DISPLAY;
  }

  /** Scale (screen px per image px) at the current zoom. */
  private scale(): number {
    const img = this.map?.image;
    if (!img) return 1;
    const d = this.display;
    return Math.min(d.w / img.width, d.h / img.height) * (this.zoom / 100);
  }

  private setZoom(z: number) {
    const [lo, hi] = this.data?.zoom ?? [100, 300];
    if (!this.map?.zoomable) z = 100;
    this.zoom = Math.max(lo, Math.min(hi, z));
    this.clampView();
  }

  private clampView() {
    const img = this.map?.image;
    if (!img) return;
    const s = this.scale(), d = this.display;
    const hw = d.w / 2 / s, hh = d.h / 2 / s;
    this.cx = hw * 2 >= img.width ? img.width / 2 : Math.max(hw, Math.min(img.width - hw, this.cx));
    this.cy = hh * 2 >= img.height ? img.height / 2 : Math.max(hh, Math.min(img.height - hh, this.cy));
  }

  private select(i: number, ui: CustomUi) {
    const n = this.data?.maps.length ?? 0;
    if (!n) return;
    const next = (i + n) % n;
    if (next === this.sel) return;
    this.sel = next;
    this.reset();
    ui.sound('move');
  }

  nav(ui: CustomUi, a: NavInput): boolean {
    const step = 40 / this.scale();
    switch (a) {
      case 'up':
        this.select(this.sel - 1, ui);
        return true;
      case 'down':
        this.select(this.sel + 1, ui);
        return true;
      case 'left':
        this.cx -= step;
        this.clampView();
        return true;
      case 'right':
        this.cx += step;
        this.clampView();
        return true;
      case 'accept':
        this.setZoom(this.zoom >= (this.data?.zoom[1] ?? 300) ? 100 : this.zoom + 50);
        return true;
      default:
        return false;
    }
  }

  key(ui: CustomUi, e: KeyboardEvent): boolean {
    if (this.closeCodes.includes(e.code)) {
      ui.close();
      return true;
    }
    if (e.code === 'PageUp' || e.code === 'Equal' || e.code === 'NumpadAdd') return this.setZoom(this.zoom + 25), true;
    if (e.code === 'PageDown' || e.code === 'Minus' || e.code === 'NumpadSubtract') return this.setZoom(this.zoom - 25), true;
    return false;
  }

  wheel(_ui: CustomUi, deltaY: number): boolean {
    this.setZoom(this.zoom * (deltaY < 0 ? 1.15 : 1 / 1.15));
    return true;
  }

  click(ui: CustomUi, index: number, x: number, y: number): void {
    if (index >= 0) return this.select(index, ui);
    const d = this.display;
    const img = this.map?.image;
    if (!img || x < d.x || y < d.y || x > d.x + d.w || y > d.y + d.h) return;
    // Centre the view on the clicked point.
    const s = this.scale();
    this.cx += (x - (d.x + d.w / 2)) / s;
    this.cy += (y - (d.y + d.h / 2)) / s;
    this.clampView();
  }

  draw(ui: CustomUi): void {
    const ctx = ui.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.88)';
    ctx.fillRect(-2000, -2000, 4640, 4480);
    const data = this.data;
    if (!data) return;
    // The list.
    const L = data.list ?? LIST;
    data.maps.forEach((m, i) => {
      const r: Rect = { x: L.x, y: L.y + i * ROW, w: L.w, h: ROW - 2 };
      if (r.y + r.h > L.y + Math.max(L.h, ROW * data.maps.length)) return;
      if (i === this.sel) {
        ctx.fillStyle = 'rgba(191,0,5,0.45)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ui.text('ui', m.name, r.x + 6, r.y + 3, { color: i === this.sel ? '#ffffff' : '#b8b0a0', scale: 0.7, maxWidth: r.w - 10 });
      ui.hit(i, r);
    });
    // The display.
    const d = this.display;
    ctx.save();
    ctx.strokeStyle = 'rgba(200,190,170,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(d.x - 1.5, d.y - 1.5, d.w + 3, d.h + 3);
    ctx.beginPath();
    ctx.rect(d.x, d.y, d.w, d.h);
    ctx.clip();
    const img = this.map?.image;
    if (img) {
      const s = this.scale();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, d.x + d.w / 2 - this.cx * s, d.y + d.h / 2 - this.cy * s, img.width * s, img.height * s);
    } else ui.text('ui', '...', d.x + d.w / 2, d.y + d.h / 2, { align: 'center', color: '#a0a0a0' });
    ctx.restore();
    if (this.map?.zoomable) ui.text('ui', `${Math.round(this.zoom)}%`, d.x + d.w - 4, d.y + d.h + 4, { align: 'right', color: '#a0a0a0', scale: 0.6 });
    // The Map GUI's texts.
    for (const t of data.texts) {
      const x = t.align === 'left' ? t.rect.x : t.align === 'right' ? t.rect.x + t.rect.w : t.rect.x + t.rect.w / 2;
      ui.text('ui', t.text, x, t.rect.y, { align: t.align, color: t.color, scale: t.scale, maxWidth: Math.max(t.rect.w, 120) });
    }
  }
}
