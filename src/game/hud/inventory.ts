// Inventory GUI (Player p246 -> GUI Inventory #157; class "GUI Inventory"):
//
//   GUI Inventory   base rect (full screen, 99 % high); p16 row template (#450), p17 / p18
//                   fade in / out seconds [guess], p19 display seconds (10) [guess], p20 item
//                   name text (#455: x 5 %, y 2 %, x0.75, left), p21..p23 sounds.
//   Inventory Row   (#450: 100 x 15 %) p15 cell template, p16 (0.2), p17 cell spacing (2.5 %)
//                   [guess], p18 left margin (5 %) [guess], p19 sound (5:5).
//   Inventory Cell  (#158: 11 x 12.5 %) p15 / p16 focused panel colour + transparency %
//                   (#bf0005, 50), p19 / p20 normal panel colour + transparency (#121207, 50),
//                   p17 / p21 the focused / normal 3D icon (3d Icon: rotating item model, p26
//                   30 deg/s [guess]), p18 focused scale 1.25, p22 count text (#181, bottom
//                   right, x0.75), p24 corner markers (5:222 texel rect 0,0,5,5).
//
// Rows (engine reading): weapons (owned, by cycle order), throwables, other carried items. The
// focused cell is the equipped weapon / selected throwable. The Inventory key toggles the
// display; it also shows for p19 / 4 s when the selection changes. The 3D icons (the item models
// spinning in the cells) are drawn by icons3d.ts on a canvas over the HUD; a cell without one
// (no model, or that renderer unavailable) shows the item's name instead.

import type { GuiNode, Rect } from '../../formats/gui';
import { textWidget } from '../../formats/gui';
import { css, drawImage, drawText, rectOf, VH, VW, type Painter } from './widgets';
import { ownedThrowables } from './actions';
import type { IconCell } from './icons3d';

export interface InvCell {
  id: string;
  name: string;
  count?: number;
  focused: boolean;
}

interface CellDef {
  w: number;
  h: number;
  focusBg: string;
  normalBg: string;
  focusScale: number;
  countText?: ReturnType<typeof textWidget>;
  marker?: { tex: string; uv: Rect; size: number };
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const kid = (n: GuiNode | undefined, k: string): GuiNode | undefined => {
  const c = n?.children[k];
  return Array.isArray(c) ? c[0] : c;
};
const kids = (n: GuiNode | undefined, k: string): GuiNode[] => {
  const c = n?.children[k];
  return !c ? [] : Array.isArray(c) ? c : [c];
};

export class InventoryGui {
  private shownAt = -1e9;
  private hideAt = -1e9;
  private toggled = false;
  private lastKey = '';
  private readonly fadeIn: number;
  private readonly fadeOut: number;
  private readonly display: number;
  private readonly row?: GuiNode;
  private readonly cell?: CellDef;
  private readonly nameText?: ReturnType<typeof textWidget>;
  private readonly nameRect?: Rect;
  private readonly spacing: number;
  private readonly margin: number;
  /** Cells drawn this frame that get a 3D icon (virtual rects) and the strip's opacity. */
  iconCells: IconCell[] = [];
  iconAlpha = 0;

  constructor(node: GuiNode | undefined) {
    const p = node?.props ?? {};
    this.fadeIn = num(p.p17, 0.2);
    this.fadeOut = num(p.p18, 0.5);
    this.display = num(p.p19, 10);
    this.row = kid(node, 'p16');
    const name = kid(node, 'p20');
    this.nameText = textWidget(name);
    this.nameRect = rectOf(name);
    const rp = this.row?.props ?? {};
    this.spacing = (num(rp.p17, 2.5) * VW) / 100;
    this.margin = (num(rp.p18, 5) * VW) / 100;
    const c = kid(this.row, 'p15');
    if (c?.layout) {
      const cp = c.props;
      const marker = kids(c, 'p24')[0];
      const mtex = typeof marker?.props.texture === 'string' ? (marker.props.texture as string) : undefined;
      this.cell = {
        w: (c.layout.w * VW) / 100,
        h: (c.layout.h * VH) / 100,
        focusBg: css(num(cp.p15, 0xbf0005), 1 - num(cp.p16, 50) / 100),
        normalBg: css(num(cp.p19, 0x121207), 1 - num(cp.p20, 50) / 100),
        focusScale: num(cp.p18, 1.25),
        countText: textWidget(kid(c, 'p22')),
        marker: mtex && marker?.layout ? { tex: mtex, uv: { x: num(marker.props.u), y: num(marker.props.v), w: num(marker.props.uw, 5), h: num(marker.props.vh, 5) }, size: (marker.layout.w * VW) / 100 } : undefined,
      };
    }
  }

  get available(): boolean {
    return !!this.cell;
  }

  /** Inventory key: toggles the display. */
  toggle(t: number): void {
    if (this.visibleAt(t) > 0.5 && this.toggled) {
      this.toggled = false;
      this.hideAt = t;
    } else {
      this.toggled = true;
      this.shownAt = t;
      this.hideAt = t + this.display;
    }
  }

  /** Opacity now (0 = hidden); other top-left HUD texts give way while it shows. */
  visible(t: number): number {
    return this.cell ? this.visibleAt(t) : 0;
  }

  private visibleAt(t: number): number {
    if (t < this.shownAt) return 0;
    const fin = Math.min(1, (t - this.shownAt) / Math.max(0.01, this.fadeIn));
    const fout = t > this.hideAt ? Math.max(0, 1 - (t - this.hideAt) / Math.max(0.01, this.fadeOut)) : 1;
    return Math.min(fin, fout);
  }

  /** The rows from the services. */
  static rows(services: Record<string, unknown>): InvCell[][] {
    const w = services.weapons as
      | { weapons?: readonly { id: string; name?: string; order?: number; current?: boolean; clip?: number; reserve?: number; kind?: string }[]; throwable?: { id: string } | null; def?(id: string): unknown }
      | undefined;
    const inv = services.inventory as { items?: ReadonlyMap<string, { name: string; count: number; template?: { pkg: number; id: number }; className?: string }> } | undefined;
    const weapons = [...(w?.weapons ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((x) => ({ id: x.id, name: x.name ?? x.id, count: x.kind === 'ranged' ? (x.clip ?? 0) + (x.reserve ?? 0) : undefined, focused: !!x.current }));
    const names = new Map<string, string>();
    for (const it of inv?.items?.values() ?? []) if (it.template) names.set(`${it.template.pkg}:${it.template.id}`, it.name);
    const thrown = ownedThrowables(services).map((t) => ({ id: t.id, name: names.get(t.id) ?? t.id, count: t.count, focused: w?.throwable?.id === t.id }));
    const skip = new Set(['Ammo Box', 'Health Bonus Item']);
    const items: InvCell[] = [];
    for (const it of inv?.items?.values() ?? []) {
      if (it.count <= 0 || (it.className && skip.has(it.className))) continue;
      const id = it.template ? `${it.template.pkg}:${it.template.id}` : it.name;
      if (it.template && w?.def?.(id)) continue; // weapons / throwables are in their rows
      items.push({ id, name: it.name, count: it.count > 1 ? it.count : undefined, focused: false });
    }
    return [weapons, thrown, items].filter((r) => r.length);
  }

  /** `icons.has(id)`: whether a 3D icon is drawn for the item (else its name is). */
  draw(p: Painter, t: number, rows: InvCell[][], icons?: { has(id: string): boolean }): void {
    this.iconCells = [];
    this.iconAlpha = 0;
    if (!this.cell) return;
    // Selection changes show the strip briefly.
    const focusKey = rows.map((r) => r.find((c) => c.focused)?.id ?? '').join('|');
    if (this.lastKey && focusKey !== this.lastKey && this.visibleAt(t) < 0.01) {
      this.toggled = false;
      this.shownAt = t;
      this.hideAt = t + this.display / 4;
    } else if (this.lastKey && focusKey !== this.lastKey) this.hideAt = Math.max(this.hideAt, t + this.display / 4);
    this.lastKey = focusKey;
    const a = this.visibleAt(t);
    if (a <= 0.01 || !rows.length) return;
    this.iconAlpha = a;
    const g = p.g;
    const c = this.cell;
    const rowH = this.row?.layout ? (this.row.layout.h * VH) / 100 : 72;
    const top = this.nameRect ? this.nameRect.y + this.nameRect.h : 48;
    let focusedName = '';
    rows.forEach((row, r) => {
      const y0 = top + r * rowH + (rowH - c.h) / 2;
      row.forEach((cell, i) => {
        const x0 = this.margin + i * (c.w + this.spacing);
        if (x0 + c.w > VW) return;
        const s = cell.focused ? c.focusScale : 1;
        const rect = { x: x0 + (c.w - c.w * s) / 2, y: y0 + (c.h - c.h * s) / 2, w: c.w * s, h: c.h * s };
        g.save();
        g.globalAlpha = a;
        g.fillStyle = cell.focused ? c.focusBg : c.normalBg;
        g.fillRect(rect.x, rect.y, rect.w, rect.h);
        g.restore();
        if (c.marker) drawImage(p, c.marker.tex, c.marker.uv, { x: rect.x + rect.w - c.marker.size, y: rect.y, w: c.marker.size, h: c.marker.size }, a);
        // The 3D icon (icons3d.ts), else the item's name as a stand-in.
        const iconText = this.nameText ?? c.countText;
        if (icons?.has(cell.id)) this.iconCells.push({ id: cell.id, rect: { x: rect.x + 2, y: rect.y + 2, w: rect.w - 4, h: rect.h - 4 }, focused: cell.focused });
        else if (iconText) drawText(p, { ...iconText, hTextAlign: 'center', vTextAlign: 'middle', scale: [0.55 * s, 0.55 * s], margins: { top: 0, bottom: 0, left: 0, right: 0 } }, { x: rect.x + 3, y: rect.y + 2, w: rect.w - 6, h: rect.h - 12 }, cell.name, { alpha: a * (cell.focused ? 1 : 0.75), align: 'center' });
        if (cell.count !== undefined && c.countText) drawText(p, c.countText, { x: rect.x, y: rect.y + rect.h - 16, w: rect.w - 3, h: 14 }, String(cell.count), { alpha: a, align: 'right' });
        if (cell.focused && r === 0) focusedName = cell.name;
        else if (cell.focused && !focusedName) focusedName = cell.name;
      });
    });
    if (this.nameText && this.nameRect && focusedName) drawText(p, this.nameText, this.nameRect, focusedName, { alpha: a });
  }
}
