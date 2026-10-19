// GUI Launcher and Archives Trigger: the level objects that open front-end screens. They
// are what the ending runs through (docs/campaign.md "Endings").
//
// GUI Launcher (class 0x2ab838a7; Suffering.rfl ctor 0x10014ca0, message map 0x10169588):
//   p5 input "launch" (default On, RFL 0x10014910), p6 input "close" (0x10014ba0).
//   p0 mode (jump table 0x10014b78):
//     0 / 1  message box with text p4 (0 also passes p2)
//     2      Credits (User Interface Properties p15, GUI Credits #535)
//     3      engine event 11 (no visible UI; ignored)
//     4      alert box p1 with text p4
//     5      overlay: GUI template p3 shown over the game (10 Docks: the three ending pictures,
//            HUD Multi Texture 34:162 / 163 / 164); "close" fades it out (0x10069510)
//     6      Game Finished (UIP p19, #698)
//   When the launched screen closes, the launcher sends message p7 to its links (callback
//   0x10014d30). In 10 Docks that is how the ending continues after the ending picture:
//   overlay closed -> Relay 1242 -> Timer 1241 (3 s) -> Relay 13b3 -> GUI Launcher 123c
//   (mode 6, Game Finished).
//
// Archives Trigger (class 0x2fb36366): p4 input; unlocks the Archive Pages p1 (set p0) and
// shows the notice p3 (in Simple Text HUD style p2).
//
// The screens themselves belong to the front end (src/app/menu, reached through
// src/game/hud/ui-bridge.ts); without the menu flow (developer viewer) the launcher logs and
// continues the chain, so level logic never stalls.

import type { World, WorldEntity } from '../world/logic';
import { readObjectTemplate, decodeTemplateProps, classByHash, type EntityPackageSet } from '../../formats/entities';
import { findEntry, TDU_TEXTURE, type ResRef } from '../../formats/model';
import { decodeTexture } from '../../formats/texture';
import { uiBridge } from '../hud/ui-bridge';
import { postHudMessage } from '../hud/bus';
import { profile } from '../../app/menu/profile';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refOf = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in (v as object) ? (v as ResRef) : null);
const key = (r: ResRef) => `${r.pkg}:${r.id}`;
/** Resolved string property i (entities.ts resolves String refs into `props`, in index order). */
const textProp = (w: WorldEntity, i: number): string => {
  const v = Object.values(w.e.props)[i];
  return typeof v === 'string' ? v : '';
};

export interface LauncherEnv {
  world: World;
  pkgs: EntityPackageSet;
  container: HTMLElement;
  log(msg: string): void;
  /** Mode 6 reached (the ending), before the screen opens. */
  onGameFinished?(): void;
  /** services.hud (src/game/hud/system.ts): notices in a Simple Text HUD template. */
  hud?(): { notice?(text: string, template?: string): void } | undefined;
}

export interface LauncherEvent {
  uid: number;
  mode: number;
  action: 'open' | 'close' | 'closed' | 'unlock';
  detail?: string;
}

/**
 * A full-screen picture overlay from a GUI template (HUD Multi Texture: p23 textures laid out
 * p24 columns x p25 rows over the widget rect; HUD Texture: p23 texture; Screen Background:
 * p0..p5 as 3 x 2 tiles). Fades in / out over p27 seconds [guess: HUD Multi Texture p27 =
 * 1.5 on every retail instance].
 */
export class PictureOverlay {
  readonly canvas: HTMLCanvasElement;
  private alpha = 0;
  private target = 1;
  private readonly fade: number;
  private readonly tiles: { img: HTMLCanvasElement | null; x: number; y: number; w: number; h: number }[] = [];
  private closed?: () => void;

  constructor(pkgs: EntityPackageSet, template: ResRef, container: HTMLElement) {
    const t = readObjectTemplate(pkgs, template);
    const cls = t ? classByHash(t.classHash) : undefined;
    const v = t ? decodeTemplateProps(cls, t) : [];
    const rect = { x: num(v[1]), y: num(v[3]), w: num(v[4], 100), h: num(v[5], 100) };
    let refs: (ResRef | null)[] = [];
    let cols = 1;
    let rows = 1;
    if (cls?.name === 'HUD Multi Texture') {
      refs = (Array.isArray(v[23]) ? v[23] : []).map(refOf);
      cols = Math.max(1, num(v[24], 1));
      rows = Math.max(1, num(v[25], 1));
    } else if (cls?.name === 'Screen Background') {
      refs = [0, 1, 2, 3, 4, 5].map((i) => refOf(v[i]));
      cols = 3;
      rows = 2;
    } else refs = [refOf(v[23])];
    this.fade = cls?.name === 'HUD Multi Texture' ? Math.max(0.05, num(v[27], 1.5)) : 0.5;
    refs.forEach((r, i) => {
      const c = i % cols;
      const row = Math.floor(i / cols);
      this.tiles.push({ img: r ? textureCanvas(pkgs, r) : null, x: rect.x + (rect.w * c) / cols, y: rect.y + (rect.h * row) / rows, w: rect.w / cols, h: rect.h / rows });
    });
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'campaign-overlay';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:8';
    container.append(this.canvas);
  }

  /** Fade out; resolves when gone. */
  close(): Promise<void> {
    this.target = 0;
    return new Promise((r) => (this.closed = r));
  }

  get done(): boolean {
    return this.target === 0 && this.alpha <= 0;
  }

  update(dt: number): void {
    const step = dt / this.fade;
    this.alpha = this.target > this.alpha ? Math.min(this.target, this.alpha + step) : Math.max(this.target, this.alpha - step);
    const c = this.canvas;
    const host = c.parentElement;
    const w = host?.clientWidth || window.innerWidth;
    const h = host?.clientHeight || window.innerHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    // 4:3 virtual screen, letterboxed like the menus.
    const s = Math.min(w / 640, h / 480);
    const ox = (w - 640 * s) / 2;
    const oy = (h - 480 * s) / 2;
    g.globalAlpha = this.alpha;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    for (const t of this.tiles) {
      if (!t.img) continue;
      // +0.5 px overlap hides seams between the 256 x 256 tiles.
      g.drawImage(t.img, ox + (t.x / 100) * 640 * s, oy + (t.y / 100) * 480 * s, (t.w / 100) * 640 * s + 0.5, (t.h / 100) * 480 * s + 0.5);
    }
    g.globalAlpha = 1;
    if (this.done && this.closed) {
      const f = this.closed;
      this.closed = undefined;
      f();
    }
  }

  dispose(): void {
    this.canvas.remove();
    this.closed?.();
    this.closed = undefined;
  }
}

function textureCanvas(pkgs: EntityPackageSet, r: ResRef): HTMLCanvasElement | null {
  const tdu = (pkgs.get(r.pkg) as { tdu?: import('../../formats/srsc').SrscFile } | undefined)?.tdu;
  const e = findEntry(tdu, TDU_TEXTURE, r.id);
  const d = tdu && e ? decodeTexture(tdu, e) : null;
  if (!d) return null;
  const c = document.createElement('canvas');
  c.width = d.width;
  c.height = d.height;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(d.width, d.height);
  img.data.set(d.rgba.subarray(0, img.data.length));
  g.putImageData(img, 0, 0);
  return c;
}

export class LevelLaunchers {
  /** Open overlays by launcher uid (mode 5). */
  private overlays = new Map<number, PictureOverlay>();
  readonly events: LauncherEvent[] = [];
  private off: () => void = () => {};

  constructor(private readonly env: LauncherEnv) {}

  start(): void {
    const handler = (w: WorldEntity, msg: number) => this.receive(w, msg);
    this.env.world.handlers.push(handler);
    this.off = () => {
      const i = this.env.world.handlers.indexOf(handler);
      if (i >= 0) this.env.world.handlers.splice(i, 1);
    };
  }

  private note(e: LauncherEvent) {
    this.events.push(e);
    if (this.events.length > 64) this.events.shift();
    this.env.log(e.mode < 0 ? `${e.action} Archives Trigger#${e.uid.toString(16)} (${e.detail ?? ''})` : `${e.action} GUI Launcher#${e.uid.toString(16)} mode ${e.mode}${e.detail ? ` (${e.detail})` : ''}`);
  }

  private receive(w: WorldEntity, msg: number): boolean {
    if (w.destroyed) return false;
    const v = w.e.values;
    if (w.cls === 'Archives Trigger') {
      if (msg !== num(v[4], 1)) return false;
      const pages = (Array.isArray(v[1]) ? v[1] : []).map(refOf).filter((r): r is ResRef => !!r).map(key);
      const fresh = profile.unlockPages(pages);
      const text = textProp(w, 3);
      if (fresh.length && text) {
        // In the trigger's own text style (p2 Simple Text HUD, 5:660), else the message list.
        const style = refOf(v[2]);
        const hud = this.env.hud?.();
        if (hud?.notice) hud.notice(text, style ? key(style) : undefined);
        else postHudMessage('message', text);
      }
      this.note({ uid: w.uid, mode: -1, action: 'unlock', detail: pages.join(',') });
      return true;
    }
    if (w.cls !== 'GUI Launcher') return false;
    const mode = num(v[0]);
    if (msg === num(v[5], 1)) {
      this.launch(w, mode);
      return true;
    }
    if (num(v[6]) && msg === num(v[6])) {
      this.close(w, mode);
      return true;
    }
    return false;
  }

  /** The launched screen closed: p7 to the links (RFL 0x10014d30). */
  private finished(w: WorldEntity, mode: number) {
    this.note({ uid: w.uid, mode, action: 'closed' });
    const m = num(w.e.values[7]);
    if (m) for (const u of w.e.links) this.env.world.send(u, m, w.uid);
  }

  private launch(w: WorldEntity, mode: number) {
    const v = w.e.values;
    const text = textProp(w, 4);
    this.note({ uid: w.uid, mode, action: 'open' });
    switch (mode) {
      case 0:
      case 1:
      case 4: {
        const box = mode === 4 ? refOf(v[1]) : null;
        if (uiBridge.alert) void uiBridge.alert(box ? key(box) : undefined, text).then(() => this.finished(w, mode));
        else {
          if (text) postHudMessage('message', text);
          this.finished(w, mode);
        }
        return;
      }
      case 2:
        if (uiBridge.credits) void uiBridge.credits().then(() => this.finished(w, mode));
        else this.finished(w, mode);
        return;
      case 5: {
        const t = refOf(v[3]);
        if (!t) {
          // No overlay template (1a / 3b title card: every value a template default, alert
          // box p1 5:247 + text p4): shown as that alert box over the game.
          const box = refOf(v[1]);
          if (uiBridge.alert && (box || text)) void uiBridge.alert(box ? key(box) : undefined, text).then(() => this.finished(w, mode));
          else {
            if (text) postHudMessage('message', text);
            this.finished(w, mode);
          }
          return;
        }
        if (this.overlays.has(w.uid)) return;
        this.overlays.set(w.uid, new PictureOverlay(this.env.pkgs, t, this.env.container));
        return;
      }
      case 6:
        this.env.onGameFinished?.();
        if (uiBridge.gameFinished) uiBridge.gameFinished();
        else this.env.log('Game Finished (no front end: developer viewer)');
        return;
      default:
        // 3: engine event 11 - nothing visible.
        return;
    }
  }

  private close(w: WorldEntity, mode: number) {
    this.note({ uid: w.uid, mode, action: 'close' });
    const o = this.overlays.get(w.uid);
    if (!o) return;
    void o.close().then(() => {
      o.dispose();
      this.overlays.delete(w.uid);
      this.finished(w, mode);
    });
  }

  /** Open overlay templates (for tests / the debug hook). */
  openOverlays(): number[] {
    return [...this.overlays.keys()];
  }

  update(dt: number): void {
    for (const o of this.overlays.values()) o.update(dt);
  }

  dispose(): void {
    this.off();
    for (const o of this.overlays.values()) o.dispose();
    this.overlays.clear();
  }
}
