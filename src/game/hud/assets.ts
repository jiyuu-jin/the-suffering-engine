// HUD resources: the interface font (shared with the sequence subtitles and the
// menus), Interface strings, HUD textures as canvases, and the decoded HUD
// widget templates (Player template 2:5 + User Interface Properties slots).

import type { GameContext } from '../runtime';
import type { EntityPackageSet } from '../../formats/entities';
import { SrscFile } from '../../formats/srsc';
import { StringDb, normalizeNewlines } from '../../formats/strings';
import { decodeTexture, TEXTURE_ENTRY_TYPE } from '../../formats/texture';
import {
  findUiPropertiesTemplate,
  INTERFACE_PKG,
  parseRefKey,
  readGuiNode,
  readHud,
  type GuiNode,
  type GuiReader,
  type HudDef,
  type RefKey,
} from '../../formats/gui';
import { readSrscSubset } from '../../app/menu/assets';
import type { BitmapFont } from '../../app/menu/text';
import { loadSubtitleFont } from '../sequence/subtitles';

const INTERFACE = 'COMMON/Interface/Interface';

export interface HudAssets {
  font: BitmapFont | null;
  strings: StringDb;
  /** Decoded GUI template by key (any package the level loaded). */
  node(key: RefKey | undefined): GuiNode | undefined;
  hud?: HudDef;
  uip?: GuiNode;
  /** Texture canvas by "pkg:id" (undefined until loaded; loads on first request). */
  texture(key: RefKey | undefined): HTMLCanvasElement | undefined;
  /** Interface string by "pkg:id", newlines normalised and trimmed. */
  string(key: RefKey | undefined): string | undefined;
}

// Texture canvases are game data: cache them for the session.
const texCache = new Map<RefKey, HTMLCanvasElement | null>();
let interfaceStrings: Promise<SrscFile | null> | undefined;

function toCanvas(t: { width: number; height: number; rgba: Uint8Array }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = t.width;
  c.height = t.height;
  const g = c.getContext('2d')!;
  const img = g.createImageData(t.width, t.height);
  img.data.set(t.rgba);
  g.putImageData(img, 0, 0);
  return c;
}

export async function loadHudAssets(ctx: GameContext): Promise<HudAssets> {
  const packages = ctx.loaded.packages as EntityPackageSet | undefined;
  const fontP = loadSubtitleFont(ctx.fs);

  const strings = new StringDb();
  let xdu = packages?.get(INTERFACE_PKG) && (packages.get(INTERFACE_PKG) as { xdu?: SrscFile }).xdu;
  if (!xdu) {
    interfaceStrings ??= ctx.fs
      .resolve(`${INTERFACE}.xdu`)
      .then(async (p) => (p ? new SrscFile(await ctx.fs.read(p)) : null))
      .catch(() => null);
    xdu = (await interfaceStrings) ?? undefined;
  }
  if (xdu) strings.addFile(xdu, INTERFACE_PKG);

  const rd: GuiReader | undefined = packages ? { packages, cache: new Map() } : undefined;
  let uip: GuiNode | undefined;
  let hud: HudDef | undefined;
  if (rd) {
    try {
      const u = findUiPropertiesTemplate(packages!);
      uip = u ? readGuiNode(rd, u) : undefined;
      hud = readHud(rd, undefined, uip);
    } catch (err) {
      console.warn('[hud] HUD templates not decoded', err);
    }
  }

  // Textures: from the level's packages (Interface is a dependency of every level), else
  // read by range from the interface .tdu.
  const pending = new Set<RefKey>();
  const texture = (key: RefKey | undefined): HTMLCanvasElement | undefined => {
    if (!key) return undefined;
    const hit = texCache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const { pkg, id } = parseRefKey(key);
    const tdu = packages?.get(pkg)?.tdu;
    const entry = tdu?.entries.find((e) => e.type === TEXTURE_ENTRY_TYPE && e.id === id);
    if (tdu && entry) {
      let c: HTMLCanvasElement | null = null;
      try {
        const t = decodeTexture(tdu, entry);
        c = t ? toCanvas(t) : null;
      } catch (err) {
        console.warn(`[hud] texture ${key}`, err);
      }
      texCache.set(key, c);
      return c ?? undefined;
    }
    if (pkg === INTERFACE_PKG && !pending.has(key)) {
      pending.add(key);
      void (async () => {
        try {
          const path = await ctx.fs.resolve(`${INTERFACE}.tdu`);
          if (!path) return texCache.set(key, null);
          const sub = await readSrscSubset(ctx.fs, path, (e) => e.type === TEXTURE_ENTRY_TYPE && e.id === id);
          const t = sub.entries[0] ? decodeTexture(sub, sub.entries[0]) : null;
          texCache.set(key, t ? toCanvas(t) : null);
        } catch {
          texCache.set(key, null);
        }
      })();
    } else if (pkg !== INTERFACE_PKG) texCache.set(key, null);
    return undefined;
  };

  return {
    font: await fontP,
    strings,
    hud,
    uip,
    node: (key) => (key && rd ? readGuiNode(rd, key) : undefined),
    texture,
    string(key) {
      const s = key ? strings.lookup(key) : undefined;
      return s !== undefined ? normalizeNewlines(s).trim() : undefined;
    },
  };
}
