// Map screen data (Map action; User Interface Properties 18 = Map GUI #200). The game side
// gathers what the screen shows and hands it to the menu flow (uiBridge.map), which draws it
// over the paused game (src/app/menu/screens/map.ts).
//
// What the data says [verified from the templates; behaviour of the list inferred]:
//   Map GUI (#200)        p16 / p17 instruction texts (select a map, zoom,
//                         center the map, <GUICancel> to exit), p18 / p22 more texts, p23 the no-maps text, p19 the Map
//                         Inventory GUI (#190: the list, x 3 % y 14 %, 32 x 31 %), p20 the Map
//                         Display GUI (#199: x 36 % y 8 %, 58 x 84 %; p15 / p16 zoom 1..300 %).
//   Map Item (class)      p22 name, p37 8 = map / 7 = note, p55 x p56 image size, p57 1 = map
//                         (zoomable) / 0 = note, p58 the image as 128-pixel texture tiles, row
//                         by row.
//   Sources               the level's map (Level Properties p45, switched by Map Switcher
//                         objects: the world system tracks it, __world.map()), the Player's own
//                         map p247 (4:807 "Carnate Island Map"), and every Map Item carried
//                         (maps and notes picked up).

import type { EntityPackageSet } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate, readXduString } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { Rect } from '../../formats/gui';
import { textWidget } from '../../formats/gui';
import type { HudAssets } from './assets';
import { rectOf } from './widgets';
import { currentBindings, expandHelpText } from './controls';

export interface MapEntry {
  id: string;
  name: string;
  /** The assembled image (null while tiles are missing). */
  image: HTMLCanvasElement | null;
  /** Map (zoomable) or note (Map Item p57). */
  zoomable: boolean;
}

export interface MapScreenData {
  maps: MapEntry[];
  selected: number;
  /** Zoom range in % (Map Display GUI p15..p16). */
  zoom: [number, number];
  list?: Rect;
  display?: Rect;
  texts: { text: string; rect: Rect; scale: number; align: 'left' | 'center' | 'right'; color: string }[];
}

const PLAYER: ResRef = { pkg: 2, id: 5 };
const MAP_GUI = '5:200';
const key = (r: ResRef) => `${r.pkg}:${r.id}`;
const isRef = (x: unknown): x is ResRef => !!x && typeof x === 'object' && 'pkg' in (x as object);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function props(pkgs: EntityPackageSet, r: ResRef | undefined, cls?: string) {
  if (!r) return undefined;
  const t = readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  return t && c && (!cls || c.name === cls) ? decodeTemplateProps(c, t) : undefined;
}

const images = new Map<string, HTMLCanvasElement | null>();

/** A Map Item's image, assembled from its p58 tiles (cached per template). */
function mapImage(pkgs: EntityPackageSet, assets: HudAssets, r: ResRef, v: unknown[]): HTMLCanvasElement | null {
  const k = key(r);
  if (images.has(k)) return images.get(k)!;
  const w = num(v[55]), h = num(v[56]);
  const tiles = (Array.isArray(v[58]) ? v[58] : []).filter(isRef);
  if (!w || !h || !tiles.length) return null;
  const first = assets.texture(key(tiles[0]));
  if (!first) return null;
  const tw = first.width, th = first.height;
  const cols = Math.max(1, Math.ceil(w / tw));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  tiles.forEach((t, i) => {
    const img = assets.texture(key(t));
    if (img) g.drawImage(img, (i % cols) * tw, Math.floor(i / cols) * th);
  });
  void pkgs;
  images.set(k, c);
  return c;
}

/** Everything the map screen shows, or null without a single map. */
export function buildMapData(pkgs: EntityPackageSet, assets: HudAssets, services: Record<string, unknown>): MapScreenData | null {
  const refs: ResRef[] = [];
  const add = (r: unknown) => {
    if (isRef(r) && !refs.some((x) => x.pkg === r.pkg && x.id === r.id)) refs.push(r);
  };
  // The level's current map first (selected), then the island map, then carried maps / notes.
  const world = (globalThis as { __world?: { map?(): ResRef | undefined } }).__world;
  const w = services.world as { world?: { of(cls: string): { e: { values: unknown[] } }[] } } | undefined;
  add(world?.map?.() ?? w?.world?.of('Level Properties')[0]?.e.values[45]);
  add(props(pkgs, PLAYER, 'Player')?.[247]);
  const inv = services.inventory as { items?: ReadonlyMap<string, { count: number; template?: ResRef; className?: string }> } | undefined;
  for (const it of inv?.items?.values() ?? []) if (it.count > 0 && it.className === 'Map Item') add(it.template);
  const maps: MapEntry[] = [];
  for (const r of refs) {
    const v = props(pkgs, r, 'Map Item');
    if (!v) continue;
    const name = (isRef(v[22]) && readXduString(pkgs, v[22])) || key(r);
    maps.push({ id: key(r), name, image: mapImage(pkgs, assets, r, v), zoomable: num(v[57], 1) !== 0 });
  }
  if (!maps.length) return null;

  const gui = assets.node(MAP_GUI);
  const bindings = currentBindings(services);
  const texts: MapScreenData['texts'] = [];
  const list = (k: string) => {
    const c = gui?.children[k];
    return !c ? [] : Array.isArray(c) ? c : [c];
  };
  // p23 is the "no maps" text (5:211): only without maps, which never reaches the screen.
  for (const n of [...list('p16'), ...list('p17'), ...list('p18'), ...list('p22')]) {
    const tw = textWidget(n);
    const rect = rectOf(n);
    const s = tw?.label ? assets.string(tw.label) : undefined;
    if (!tw || !rect || !s) continue;
    texts.push({
      text: expandHelpText(s, bindings),
      rect,
      scale: tw.scale[0] || 1,
      align: tw.hTextAlign === 'left' || tw.hTextAlign === 'right' ? tw.hTextAlign : 'center',
      color: `#${(tw.colors.normal & 0xffffff).toString(16).padStart(6, '0')}`,
    });
  }
  const disp = list('p20')[0];
  const dp = disp?.props ?? {};
  return {
    maps,
    selected: 0,
    // p16 = 300: the largest zoom in % of the fitted view [inferred]; p15 = 1 [unknown].
    zoom: [100, Math.max(100, num(dp.p16, 300))],
    list: rectOf(list('p19')[0]),
    display: rectOf(disp),
    texts,
  };
}
