// Builds the MenuModel from the game's own front-end definitions
// (src/formats/gui.ts readFrontEnd; docs/frontend.md): screens, widget
// layout, labels, fonts, colours, videos, sounds, boot sequence and loading
// screens. Falls back to PROVISIONAL_MODEL if the definitions can't be read.
//
// Engine additions on top of the data (all marked in the code):
//   - a "Developer" item under the main menu items (level viewer / procedural scene),
//   - a master volume row on the audio pages (the game has none),
//   - a frame-rate cap row on the graphics page (browsers always present in sync with the
//     display, so the game's Vertical Sync row alone could not limit the frame rate),
//   - Load / Save lists (LoadSave GUI, layout 'saves'): rows are filled by the flow from the
//     save store (src/game/save), with a thumbnail per save.
// Archives, Credits and the keyboard page are custom screens (./screens/*): the adapter
// decodes their data (ArchivesSpec, CreditsSpec, KeyboardSpec) and the flow attaches the
// screen objects. Alert boxes (#228 / #229 / #247 ...) become AlertSpec layouts.

import type { GameFS } from '../gamefs';
import { SrscFile } from '../../formats/srsc';
import type { EntityPackage } from '../../formats/entities';
import {
  imageWidget,
  readFrontEnd,
  readGuiNode,
  resolveRect,
  textWidget,
  type FrontEnd,
  type GuiLayout,
  type GuiNode,
  type ImageWidget,
  type MenuItemDef,
  type MenuScreenDef,
  type OptionPageDef,
  type RefKey,
  type ScreenBackgroundDef,
  type TextWidget,
} from '../../formats/gui';
import {
  PROVISIONAL_MODEL,
  confirmScreen,
  defaultSaveSpec,
  developerScreen,
  stubScreen,
  type AlertSpec,
  type ArchivesSpec,
  type BorderSpec,
  type CreditsSpec,
  type KeyboardSpec,
  type ImageSpec,
  type Label,
  type MenuAction,
  type MenuItem,
  type MenuModel,
  type MenuScreen,
  type MeterSpec,
  type Placed,
  type Rect,
  type SaveListSpec,
  type VideoRef,
} from './model';
import { CALIBRATE_SCREEN, CONTROLLER_SCREEN, controllerItems, decorateController } from './screens/controller';
import { RENDER_SCALES } from '../render-scale';

const INTERFACE = 'COMMON/Interface/Interface';
const SYSTEM = 'COMMON/System/System';
const SCREEN: Rect = { x: 0, y: 0, w: 640, h: 480 };

async function readPackageId(fs: GameFS, base: string): Promise<number | undefined> {
  const db = await fs.resolve(`${base}.db`);
  if (!db) return undefined;
  const m = /^\s*id\s+(\d+)/m.exec(new TextDecoder().decode(await fs.read(db)));
  return m ? Number(m[1]) : undefined;
}

async function loadOdu(fs: GameFS, base: string): Promise<EntityPackage | undefined> {
  const [id, path] = await Promise.all([readPackageId(fs, base), fs.resolve(`${base}.odu`)]);
  if (id === undefined || !path) return undefined;
  return { id, name: base.split('/').pop(), odu: new SrscFile(await fs.read(path)) };
}

export async function buildMenuModel(fs: GameFS): Promise<MenuModel> {
  try {
    const pkgs = new Map<number, EntityPackage>();
    const iface = await loadOdu(fs, INTERFACE);
    if (!iface) throw new Error(`${INTERFACE}.odu not found`);
    pkgs.set(iface.id, iface);
    const sys = await loadOdu(fs, SYSTEM).catch(() => undefined);
    if (sys) pkgs.set(sys.id, sys);
    const fe = readFrontEnd(pkgs, { interfacePkg: iface.id, systemPkg: sys?.id });
    if (!fe.mainMenu) throw new Error('no main menu in the interface definitions');
    return fromFrontEnd(fe, (r) => readGuiNode(pkgs, r));
  } catch (err) {
    console.warn('[menu] using the provisional menu model:', err);
    return PROVISIONAL_MODEL;
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers

const refId = (k: RefKey | undefined): number | undefined => {
  if (!k) return undefined;
  const id = Number(k.split(':')[1]);
  return Number.isFinite(id) ? id : undefined;
};

/** Engine wording from an item id ("quitGame" -> "Quit game"), used only if a string is missing. */
const words = (id: string) => {
  const w = id.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

function label(k: RefKey | undefined, fallback: string): Label {
  if (!k) return { text: fallback };
  const [pkg, id] = k.split(':').map(Number);
  return { str: { pkg, id }, fallback };
}

const css = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

function rectOf(l: GuiLayout, parent: Rect = SCREEN): Rect {
  return resolveRect(l, parent, { width: 640, height: 480 });
}

function placed(w: TextWidget, defaultFont: number): Placed {
  return {
    rect: rectOf(w.layout),
    font: refId(w.font) ?? defaultFont,
    scale: w.scale[0] || 1,
    hAlign: w.hTextAlign,
    vAlign: w.vTextAlign,
    colors: { normal: css(w.colors.normal), disabled: css(w.colors.disabled), focused: css(w.colors.focused) },
    margins: {
      top: (w.margins.top * 480) / 100,
      bottom: (w.margins.bottom * 480) / 100,
      left: (w.margins.left * 640) / 100,
      right: (w.margins.right * 640) / 100,
    },
  };
}

function image(w: ImageWidget): ImageSpec | undefined {
  const tex = refId(w.texture);
  if (tex === undefined) return undefined;
  const uv = w.uv.w > 0 && w.uv.h > 0 ? { ...w.uv } : undefined;
  return { texture: tex, uv, rect: rectOf(w.layout) };
}

const images = (ws: ImageWidget[]) => ws.map(image).filter((x): x is ImageSpec => !!x);

function meter(n: GuiNode | undefined): MeterSpec | undefined {
  if (!n?.layout) return undefined;
  const p = n.props;
  const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
  const fill = typeof p.p25 === 'number' ? css(p.p25) : '#afaf00';
  const frameTex = refId(typeof p.p37 === 'string' ? p.p37 : undefined);
  return {
    rect: rectOf(n.layout),
    fill,
    frame:
      frameTex !== undefined
        ? { texture: frameTex, uv: { x: num(p.p38), y: num(p.p39), w: num(p.p40), h: num(p.p41) } }
        : undefined,
  };
}

function tiles(bg: ScreenBackgroundDef | undefined) {
  return bg ? { tiles: bg.tiles.map(refId) } : undefined;
}

const video = (k: RefKey | undefined): VideoRef | undefined => {
  const id = refId(k);
  return id === undefined ? undefined : { container: INTERFACE, id };
};
const videos = (ks: RefKey[]) => ks.map(video).filter((v): v is VideoRef => !!v);

// ---------------------------------------------------------------------------

function fromFrontEnd(fe: FrontEnd, readNode: (r: RefKey) => GuiNode | undefined = () => undefined): MenuModel {
  const mm = fe.mainMenu!;
  const defaultFont = refId(fe.defaultFont) ?? 2;
  const titleFont = 3;
  const screens: Record<string, MenuScreen> = {};
  const yes = label('5:31', 'Yes');
  const no = label('5:32', 'No');
  const confirm = (id: string, msg: RefKey | undefined, yesAction: MenuAction) => {
    screens[id] = confirmScreen(id, label(msg, 'Are you sure?'), yesAction, { yes, no });
    return id;
  };

  /** Converts a screen's items. `map` returns the engine action for an item (or null to drop it). */
  const items = (
    def: MenuScreenDef,
    map: (it: MenuItemDef) => { action: MenuAction; disabled?: boolean; disabledWhen?: 'noSaves' | 'cannotSave' } | null,
  ): MenuItem[] =>
    def.items
      .filter((it) => !it.platform)
      .map((it) => {
        const r = map(it);
        if (!r) return undefined;
        return {
          type: 'button' as const,
          label: label(it.widget.label, words(it.id)),
          action: r.action,
          disabled: r.disabled,
          ...(r.disabledWhen ? { disabledWhen: r.disabledWhen } : {}),
          place: placed(it.widget, titleFont),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  const focusOf = (def: MenuScreenDef) => {
    const visible = def.items.filter((it) => !it.platform);
    return Math.max(0, visible.indexOf(def.items[def.defaultFocus]));
  };
  const footer = (def: { footers: TextWidget[] }) => {
    const f = def.footers.find((w) => w.label);
    return f ? { footer: label(f.label, ''), footerPlace: placed(f, defaultFont) } : {};
  };

  // Stubs for screens the engine doesn't implement yet.
  const stub = (id: string, title: Label | undefined, titleImages?: ImageSpec[]) => {
    screens[id] = stubScreen(id, title, { text: 'This screen is not available yet.' }, titleImages);
    return id;
  };

  // --- Load / Save lists (LoadSave GUI) ------------------------------------
  const saveScreen = (id: string, node: GuiNode | undefined, mode: 'load' | 'save'): string => {
    if (screens[id]) return id;
    const spec = node?.layout ? saveListSpec(node, mode, defaultFont, readNode) : undefined;
    const titles = node ? images(kids(node, mode === 'load' ? 'p15' : 'p16').map(imageWidget).filter((w): w is ImageWidget => !!w)) : [];
    screens[id] = {
      id,
      layout: 'saves',
      titleImages: titles,
      title: titles.length ? undefined : label(mode === 'load' ? '5:8' : '5:9', mode === 'load' ? 'Load Game' : 'Save Game'),
      items: [],
      saves: spec ?? defaultSaveSpec(mode),
      dim: node?.layout ? dimOf(node.layout) : 0.85,
    };
    return id;
  };

  // --- Archives (custom screen; the flow attaches the viewer) ----------------
  const archivesScreen = (it: MenuItemDef): string => {
    if (!screens.archives) {
      const spec = fe.screens.archives ? archivesSpec(fe.screens.archives, defaultFont) : undefined;
      screens.archives = spec ? { id: 'archives', layout: 'placed', items: [] } : stubScreen('archives', label(it.widget.label, 'Archives'), { text: 'Archives unavailable.' });
      archives = spec;
    }
    return 'archives';
  };
  let archives: ArchivesSpec | undefined;

  // --- Main menu ---------------------------------------------------------
  const mainItems = items(mm, (it) => {
    const a = it.action;
    const transition = !!a.transitionVideo;
    switch (a.kind) {
      case 'openDifficulty':
        return { action: { kind: 'push', screen: 'difficulty' } };
      case 'continue':
        // Enabled by the flow once a save exists (the engine disables it without saves).
        return { action: { kind: 'continue', transition }, disabled: true, disabledWhen: 'noSaves' };
      case 'loadGame':
        return { action: { kind: 'openSaves', screen: saveScreen('loadGame', fe.screens.loadGameFrontEnd, 'load'), transition }, disabled: true, disabledWhen: 'noSaves' };
      case 'options':
        return { action: { kind: 'push', screen: 'optionsFrontEnd' } };
      case 'archives':
        return { action: { kind: 'push', screen: archivesScreen(it), transition } };
      case 'quitApp':
        return { action: { kind: 'push', screen: confirm('confirmQuitApp', a.confirm ?? mm.strings.quitConfirm, { kind: 'quitApp' }) } };
      default:
        return { action: { kind: 'none' } };
    }
  });
  // Engine addition: developer tools, below the game's items in the hint font.
  const last = mainItems[mainItems.length - 1]?.place;
  mainItems.push({
    type: 'button',
    label: { text: 'Developer' },
    action: { kind: 'push', screen: 'developer' },
    place: last
      ? { ...last, font: defaultFont, scale: 1, rect: { ...last.rect, y: Math.min(480 - last.rect.h, last.rect.y + last.rect.h * 1.1) } }
      : undefined,
  });
  screens.main = {
    id: 'main',
    layout: 'placed',
    images: images(mm.logo),
    items: mainItems,
    defaultFocus: focusOf(mm),
    dim: dimOf(mm.layout),
  };
  screens.developer = developerScreen();

  // --- Difficulty (cross-fades in place of the main items) ---------------
  const diff = mm.difficulty;
  screens.difficulty = {
    id: 'difficulty',
    layout: 'placed',
    titleImages: images(diff.titles),
    items: items(diff, (it) => ({ action: { kind: 'newGame', difficulty: it.action.difficulty, transition: !!it.action.transitionVideo } })),
    defaultFocus: focusOf(diff),
    fadeIn: mm.submenuFadeSeconds || 0.5,
    ...footer(diff),
  };

  // --- Options menus and pages ---------------------------------------------
  const optionsMenu = (def: MenuScreenDef | undefined, id: string) => {
    if (!def) return;
    screens[id] = {
      id,
      layout: 'placed',
      titleImages: images(def.titles),
      items: items(def, (it) => {
        switch (it.action.kind) {
          case 'openPage': {
            const pageId = it.action.screen ?? '';
            const page = fe.optionPages[pageId];
            return { action: { kind: 'push', screen: page ? optionPage(page) : stub(pageId, label(it.widget.label, words(pageId))) } };
          }
          case 'credits':
            if (!screens.credits) {
              if (credits) screens.credits = { id: 'credits', layout: 'placed', items: [] };
              else stub('credits', label(it.widget.label, 'Credits'));
            }
            return { action: { kind: 'push', screen: 'credits' } };
          case 'back':
            return { action: { kind: 'back' } };
          default:
            return { action: { kind: 'none' } };
        }
      }),
      defaultFocus: focusOf(def),
      dim: dimOf(def.layout),
      ...footer(def),
    };
  };

  const optionPage = (page: OptionPageDef): string => {
    const id = `page.${page.id}`;
    if (screens[id]) return id;
    if (page.id === 'keyboard') {
      // Custom screen (screens/keyboard.ts): the rows are the 40 bindable actions.
      keyboard = keyboardSpec(page, defaultFont, titleFont);
      screens[id] = { id, layout: 'placed', items: [], titleImages: images(page.titles) };
      return id;
    }
    const rows: MenuItem[] = [];
    for (const row of page.rows) {
      if (row.platform) continue;
      const lab = label(row.label.label, words(row.id));
      const place = placed(row.label, titleFont);
      const known = SETTING_ROWS[row.id];
      const help = row.help?.label ? { help: { label: label(row.help.label, ''), place: placed(row.help, defaultFont) } } : {};
      if (row.kind === 'slider') {
        const k = known && 'min' in known ? known : { setting: `x.${row.id}`, min: 0, max: 1, step: 0.1 };
        rows.push({ type: 'slider', label: lab, setting: k.setting, min: k.min, max: k.max, step: k.step, place, meter: meter(row.meter), ...help });
      } else if (row.kind === 'choice') {
        const values = known && 'values' in known ? known.values : row.choices.map((_, i) => i);
        if (row.id === 'resolution' && row.choices[0]) {
          // One value text filled at runtime: the render size at each resolution scale (Auto: the
          // internal size in use). Engine choice: the render scale (src/app/render-scale.ts).
          const vp = placed(row.choices[0], titleFont);
          rows.push({
            type: 'choice',
            label: lab,
            setting: 'x.renderScale',
            place,
            format: 'resolution',
            choices: RESOLUTION_SCALES.map((v) => ({ label: { text: v ? `${Math.round(v * 100)}%` : 'Auto' }, value: v, place: vp })),
            ...help,
          });
          continue;
        }
        rows.push({
          type: 'choice',
          label: lab,
          setting: known?.setting ?? `x.${row.id}`,
          place,
          choices: row.choices.map((c, i) => ({ label: label(c.label, String(i)), value: values[i] ?? i, place: placed(c, titleFont) })),
          ...help,
        });
      } else {
        const action: MenuAction = row.id === 'useDefaults' ? { kind: 'graphicsDefaults' } : { kind: 'none' };
        rows.push({ type: 'button', label: lab, action, place, ...help });
      }
    }
    // Engine addition: frame-rate cap on the graphics page, under the vsync row's value column.
    if (page.id === 'graphics') {
      const vs = rows.find((r) => r.type === 'choice' && r.setting === 'x.vsync');
      const last = page.rows.filter((r) => !r.platform && r.kind !== 'button').reduce((m, r) => Math.max(m, r.label.layout.y), 0);
      if (vs && vs.type === 'choice' && vs.place) {
        const dy = ((last + 8 - (vs.place.rect.y * 100) / 480) * 480) / 100;
        const shift = (p: Placed): Placed => ({ ...p, rect: { ...p.rect, y: p.rect.y + dy } });
        const useDefaults = rows.findIndex((r) => r.type === 'button' && r.action.kind === 'graphicsDefaults');
        const capRow: MenuItem = {
          type: 'choice',
          label: { text: 'Frame Rate Limit' },
          setting: 'x.frameCap',
          place: shift(vs.place),
          choices: FRAME_CAPS.map((v) => ({ label: { text: v ? `${v}` : 'Off' }, value: v, place: vs.choices[0]?.place ? shift(vs.choices[0].place) : undefined })),
        };
        // Engine addition (docs/enhanced.md): Graphics Mode (Original / Enhanced, applied on the
        // next start) and the Enhanced quality tier, 5.5 % apart under the frame cap.
        const gap = (5.5 * 480) / 100;
        const at = (p: Placed, k: number): Placed => ({ ...p, rect: { ...p.rect, y: p.rect.y + dy + k * gap } });
        const valuePlace = (k: number) => (vs.choices[0]?.place ? at(vs.choices[0].place, k) : undefined);
        const modeRow: MenuItem = {
          type: 'choice',
          label: { text: 'Graphics Mode' },
          setting: 'x.gfxMode',
          place: at(vs.place, 1),
          choices: ['Original', 'Enhanced'].map((t, i) => ({ label: { text: t }, value: i, place: valuePlace(1) })),
        };
        const tierRow: MenuItem = {
          type: 'choice',
          label: { text: 'Enhanced Quality' },
          setting: 'x.gfxTier',
          place: at(vs.place, 2),
          choices: ['Auto', 'Low', 'Medium', 'High', 'Ultra'].map((t, i) => ({ label: { text: t }, value: i, place: valuePlace(2) })),
        };
        if (useDefaults >= 0) rows.splice(useDefaults, 0, capRow, modeRow, tierRow);
        else rows.push(capRow, modeRow, tierRow);
        // Nine value rows do not fit the game's 8 % spacing above Accept / Cancel (84 %): the
        // rows keep their first row's place and close up to 6 % apart; Use Defaults follows
        // 7.5 % below the last one.
        const values = rows.filter((r) => (r.type === 'choice' || r.type === 'slider') && r.place);
        const y0 = values[0]?.place?.rect.y ?? 0;
        const step = (6 * 480) / 100;
        const move = <T extends { rect: Rect }>(q: T | undefined, d: number): T | undefined => (q ? { ...q, rect: { ...q.rect, y: q.rect.y + d } } : q);
        values.forEach((r, k) => {
          const d = y0 + k * step - r.place!.rect.y;
          r.place = move(r.place, d);
          if (r.type === 'choice') r.choices = r.choices.map((c) => ({ ...c, place: move(c.place, d) }));
          if (r.type === 'slider') r.meter = move(r.meter, d);
        });
        const ud = rows.find((r) => r.type === 'button' && r.action.kind === 'graphicsDefaults');
        if (ud?.place) ud.place = { ...ud.place, rect: { ...ud.place.rect, y: y0 + (values.length - 1) * step + (7.5 * 480) / 100 } };
      }
    }
    // Engine addition: master volume on the audio pages, below the game's rows.
    if (page.id.startsWith('audio')) {
      const ref = page.rows.find((r) => r.kind === 'slider' && !r.platform);
      const lowest = Math.max(...page.rows.filter((r) => !r.platform).map((r) => r.label.layout.y));
      if (ref && ref.kind === 'slider') {
        const dy = ((lowest + 9 - ref.label.layout.y) * 480) / 100;
        const p = placed(ref.label, titleFont);
        const m = meter(ref.meter);
        rows.push({
          type: 'slider',
          label: { text: 'Master Volume' },
          setting: 'master',
          min: 0,
          max: 1,
          step: 0.1,
          place: { ...p, rect: { ...p.rect, y: p.rect.y + dy } },
          meter: m ? { ...m, rect: { ...m.rect, y: m.rect.y + dy } } : undefined,
        });
      }
    }
    // Engine addition: "Always Run" on the gameplay pages, below the game's rows (Off = walk,
    // hold Shift to run; On = the original's run-by-default with Shift to walk).
    if (page.id.startsWith('gameplay')) {
      const ref = page.rows.find((r) => r.kind === 'choice' && !r.platform);
      const lowest = Math.max(...page.rows.filter((r) => !r.platform).map((r) => r.label.layout.y));
      if (ref && ref.kind === 'choice') {
        const dy = ((lowest + 9 - ref.label.layout.y) * 480) / 100;
        const p = placed(ref.label, titleFont);
        const shift = <T extends { rect: { y: number } }>(q: T): T => ({ ...q, rect: { ...q.rect, y: q.rect.y + dy } });
        rows.push({
          type: 'choice',
          label: { text: 'Always Run' },
          setting: 'x.alwaysRun',
          place: shift(p),
          choices: [
            { label: { text: 'Off' }, value: false, place: ref.choices[0] ? shift(placed(ref.choices[0], titleFont)) : undefined },
            { label: { text: 'On' }, value: true, place: ref.choices[1] ? shift(placed(ref.choices[1], titleFont)) : undefined },
          ],
        });
        // Port option (not in the original: its 25 cheats have none; src/game/port-options.ts),
        // 8 % below Always Run, its help line under Accept / Cancel while focused.
        const dy2 = dy + (8 * 480) / 100;
        const shift2 = <T extends { rect: { y: number } }>(q: T): T => ({ ...q, rect: { ...q.rect, y: q.rect.y + dy2 } });
        rows.push({
          type: 'choice',
          label: { text: IGNORE_PLAYER_LABEL },
          setting: IGNORE_PLAYER_SETTING,
          place: shift2(p),
          choices: [
            { label: { text: 'Off' }, value: false, place: ref.choices[0] ? shift2(placed(ref.choices[0], titleFont)) : undefined },
            { label: { text: 'On' }, value: true, place: ref.choices[1] ? shift2(placed(ref.choices[1], titleFont)) : undefined },
          ],
          help: {
            label: { text: IGNORE_PLAYER_HELP },
            place: { ...p, font: defaultFont, scale: 0.8, hAlign: 'center', vAlign: 'top', margins: undefined, rect: { x: 48, y: (92 * 480) / 100, w: 544, h: 36 } },
          },
        });
      }
    }
    const message: Label | undefined = undefined;
    const buttons: MenuItem[] = [];
    if (page.accept) buttons.push({ type: 'button', label: label(page.accept.label, 'Accept'), action: { kind: 'pageAccept' }, place: placed(page.accept, titleFont), group: 'ac' });
    if (page.cancel) buttons.push({ type: 'button', label: label(page.cancel.label, 'Cancel'), action: { kind: 'pageCancel' }, place: placed(page.cancel, titleFont), group: 'ac' });
    screens[id] = {
      id,
      layout: 'placed',
      page: true,
      titleImages: images(page.titles),
      message,
      items: [...rows, ...buttons],
      dim: dimOf(page.layout),
      ...footer(page),
    };
    return id;
  };

  let keyboard: KeyboardSpec | undefined;
  const credits: CreditsSpec | undefined = fe.screens.credits ? creditsSpec(fe.screens.credits, defaultFont) : undefined;
  optionsMenu(fe.options.frontEnd, 'optionsFrontEnd');
  optionsMenu(fe.options.inGame, 'optionsInGame');

  // --- Controller page (engine page in the style of the console's GUI Controller Settings
  // #855: its heading plate, Accept / Cancel and row / value text styles) ----------------------
  {
    const cs = readNode('5:855');
    const rowW = textWidget(kids(cs, 'p24')[0]);
    const valW = textWidget(kids(cs, 'p25')[0]);
    const acceptW = textWidget(kids(cs, 'p15')[0]);
    const cancelW = textWidget(kids(cs, 'p16')[0]);
    const title = imageWidget(kids(cs, 'p17')[0]);
    const gp = fe.optionPages.gameplay;
    const sliderRow = gp?.rows.find((r) => r.kind === 'slider');
    const meterSpec = sliderRow && sliderRow.kind === 'slider' ? meter(sliderRow.meter) : undefined;
    const fallbackText = (hAlign: Placed['hAlign']): Placed => ({
      rect: { x: 0, y: 0, w: 100, h: 28 },
      font: titleFont,
      scale: 0.85,
      hAlign,
      vAlign: 'middle',
      colors: { normal: '#404040', disabled: '#404040', focused: '#808080' },
    });
    const rowStyle = rowW ? placed(rowW, titleFont) : fallbackText('left');
    const valStyle = valW ? placed(valW, titleFont) : fallbackText('center');
    const at = (st: Placed, xPct: number, wPct: number, yPct: number, hPct: number): Placed => ({
      ...st,
      rect: { x: (xPct * 640) / 100, y: (yPct * 480) / 100, w: (wPct * 640) / 100, h: (hPct * 480) / 100 },
    });
    const items = controllerItems((i) => {
      const y = 20 + i * 6;
      const label = at(rowStyle, 10, 42, y, 6);
      const value = at(valStyle, 52, 36, y, 6);
      const mh = meterSpec ? Math.min(meterSpec.rect.h, 14) : 10;
      const m: MeterSpec = {
        fill: meterSpec?.fill ?? '#808080',
        frame: meterSpec?.frame,
        rect: { x: (55 * 640) / 100, y: ((y + 3) * 480) / 100 - mh / 2, w: meterSpec ? Math.min(meterSpec.rect.w, 200) : 190, h: mh },
      };
      return { label, value, meter: m };
    });
    const buttons: MenuItem[] = [];
    buttons.push({ type: 'button', label: label(acceptW?.label ?? '5:340', 'Accept'), action: { kind: 'pageAccept' }, place: acceptW ? placed(acceptW, titleFont) : at(valStyle, 33, 14, 84, 9), group: 'ac' });
    buttons.push({ type: 'button', label: label(cancelW?.label ?? '5:341', 'Cancel'), action: { kind: 'pageCancel' }, place: cancelW ? placed(cancelW, titleFont) : at(valStyle, 53, 14, 84, 9), group: 'ac' });
    const titleImg = title ? image(title) : undefined;
    screens[CONTROLLER_SCREEN] = {
      id: CONTROLLER_SCREEN,
      layout: 'placed',
      page: true,
      titleImages: titleImg ? [titleImg] : undefined,
      title: titleImg ? undefined : { text: 'Controller' },
      items: [...items, ...buttons],
      dim: cs?.layout ? dimOf(cs.layout) : 0.65,
      decorate: (ui) => decorateController(ui),
    };
    screens[CALIBRATE_SCREEN] = { id: CALIBRATE_SCREEN, layout: 'placed', items: [] };
    // Options menus: a Controller item under Audio (Credits, front end only, moves down).
    for (const id of ['optionsFrontEnd', 'optionsInGame']) {
      const sc = screens[id];
      if (!sc) continue;
      const audio = sc.items.find((it) => it.type === 'button' && it.action.kind === 'push' && it.action.screen.startsWith('page.audio'));
      const ref = audio ?? sc.items[sc.items.length - 2];
      if (!ref?.place) continue;
      const dy = (10 * 480) / 100;
      const item: MenuItem = { type: 'button', label: { text: 'Controller' }, action: { kind: 'push', screen: CONTROLLER_SCREEN }, place: { ...ref.place, rect: { ...ref.place.rect, y: ref.place.rect.y + dy } } };
      const credits = sc.items.find((it) => it.type === 'button' && it.action.kind === 'push' && it.action.screen === 'credits');
      if (credits?.place) credits.place = { ...credits.place, rect: { ...credits.place.rect, y: credits.place.rect.y + dy * 0.9 } };
      sc.items.splice(sc.items.indexOf(ref) + 1, 0, item);
    }
  }

  // --- Pause -------------------------------------------------------------------
  const pause = fe.pause;
  if (pause) {
    screens.pause = {
      id: 'pause',
      layout: 'placed',
      titleImages: images(pause.titles),
      items: items(pause, (it) => {
        const a = it.action;
        switch (a.kind) {
          case 'resume':
            return { action: { kind: 'resume' } };
          case 'saveGame':
            // Disabled where saving isn't allowed (flow: saves.canSave()).
            return { action: { kind: 'openSaves', screen: saveScreen('saveGame', fe.screens.saveGame, 'save') }, disabledWhen: 'cannotSave' };
          case 'loadGame':
            return { action: { kind: 'openSaves', screen: saveScreen('loadGameInGame', fe.screens.loadGameInGame, 'load') }, disabledWhen: 'noSaves' };
          case 'revertCheckpoint':
            return { action: { kind: 'push', screen: confirm('confirmRevert', a.confirm, { kind: 'revertCheckpoint' }) } };
          case 'options':
            return { action: { kind: 'push', screen: screens.optionsInGame ? 'optionsInGame' : 'optionsFrontEnd' } };
          case 'archives':
            return { action: { kind: 'push', screen: archivesScreen(it) } };
          case 'quitToMainMenu':
            return { action: { kind: 'push', screen: confirm('confirmQuitGame', a.confirm ?? fe.strings.quitGameConfirm, { kind: 'quitToMenu' }) } };
          default:
            return { action: { kind: 'none' } };
        }
      }),
      defaultFocus: focusOf(pause),
      dim: dimOf(pause.layout),
    };
  } else {
    screens.pause = PROVISIONAL_MODEL.screens.pause;
    screens.confirmQuitGame = PROVISIONAL_MODEL.screens.confirmQuitGame;
  }

  // --- Alert boxes -----------------------------------------------------------------
  const alertCache: Record<string, AlertSpec> = {};
  const alertOf = (n: GuiNode | undefined): AlertSpec | undefined => {
    if (!n) return undefined;
    if (!alertCache[n.template]) {
      const a = alertSpec(n, defaultFont, readNode);
      if (a) alertCache[n.template] = a;
    }
    return alertCache[n.template];
  };
  const alerts = {
    yesNo: alertOf(Object.values(fe.alerts).find((n) => Array.isArray(n.props.buttons) && (n.props.buttons as unknown[]).length === 2)),
    ok: alertOf(Object.values(fe.alerts).find((n) => Array.isArray(n.props.buttons) && (n.props.buttons as unknown[]).length === 1)),
    byRef: alertCache,
  };
  for (const n of Object.values(fe.alerts)) alertOf(n);
  // Launcher alert boxes live in the Interface package too (1a: #247).
  for (const sc of Object.values(screens)) if (sc.dialog && alerts.yesNo) sc.alert = alerts.yesNo;

  // --- Game Finished (UIP 19, #698) -----------------------------------------------------
  const gf = fe.screens.gameFinished;
  if (gf) {
    const t = (k: string) => textWidget(kids(gf, k)[0]);
    const notice = t('p16');
    const save = t('p17');
    const noSave = t('p18');
    const noSaveConfirm = typeof gf.props.p21 === 'string' ? (gf.props.p21 as RefKey) : undefined;
    const confirmId = confirm('confirmFinishNoSave', noSaveConfirm, { kind: 'gameFinished', save: false });
    if (alerts.yesNo) screens[confirmId].alert = alerts.yesNo;
    const btn = (w: TextWidget | undefined, fallback: string, action: MenuAction): MenuItem[] =>
      w ? [{ type: 'button', label: label(w.label, fallback), action, place: placed(w, titleFont) }] : [];
    screens.gameFinished = {
      id: 'gameFinished',
      layout: 'placed',
      message: notice ? label(notice.label, '') : undefined,
      messagePlace: notice ? placed(notice, defaultFont) : undefined,
      items: [...btn(save, 'Save', { kind: 'gameFinished', save: true }), ...btn(noSave, "Don't save", { kind: 'push', screen: confirmId })],
      dim: 0.8,
    };
  }

  // --- Boot, videos, sounds, loading ------------------------------------------------
  const reels: VideoRef[][] = [];
  let copyright: MenuModel['boot']['copyright'];
  for (const step of fe.boot) {
    if (step.kind === 'openingMovies') for (const c of step.choices) reels.push(videos(c.movies.map((m) => m.video)));
    if (step.kind === 'copyright' && step.background) copyright = { tiles: step.background.tiles.map(refId), seconds: step.seconds || 5 };
  }
  const v = mm.videos;
  const backgrounds = videos([...(v.first ? [v.first] : []), ...v.backgrounds]);
  const attract = video(v.attract?.video);
  const loadMeter = meter(fe.loading.newGame?.progressMeter ?? fe.loading.default?.progressMeter);

  return {
    interfacePackage: INTERFACE,
    fonts: { ui: defaultFont, title: titleFont },
    images: {
      logo: images(mm.logo),
      arrowLeft: PROVISIONAL_MODEL.images.arrowLeft,
      arrowRight: PROVISIONAL_MODEL.images.arrowRight,
      cursor: refId(fe.cursorTexture),
    },
    boot: { logoReels: reels.filter((r) => r.length), copyright },
    mainMenu: {
      backgrounds,
      transitions: videos(v.transition),
      attract: attract ? { video: attract, idleSeconds: v.idleSeconds || 30 } : undefined,
      ambience: {
        loops: mm.ambience.loops,
        oneShots: mm.ambience.oneShots,
        delaySeconds: mm.ambience.delaySeconds || 12,
        segmentSeconds: mm.ambience.pathSegmentSeconds || 4.8,
        radius: mm.ambience.radius,
        fadeOutSeconds: mm.ambience.fadeOutSeconds || 1,
      },
    },
    sounds: { move: fe.sounds.navigate, select: fe.sounds.select, back: fe.sounds.cancel, value: fe.sounds.valueChange },
    newGame: { level: label(mm.newGame.level, 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl') },
    loading: {
      newGame: tiles(fe.loading.newGame?.background),
      default: tiles(fe.loading.default?.background),
      meter: loadMeter,
      label: label('5:314', 'Loading...'),
    },
    screens,
    chapters: {
      list: fe.loading.chapters.filter((c) => c.name).map((c) => ({ template: c.template, name: label(c.name, '') })),
      newGame: fe.loading.chapters.find((c) => c.loadingScreen && c.loadingScreen.template === fe.loading.newGame?.template)?.template,
    },
    mainScreen: 'main',
    pauseScreen: 'pause',
    preludeLevel: mm.newGame.unlockedLevel ? label(mm.newGame.unlockedLevel, '') : undefined,
    archives,
    credits,
    keyboard,
    alerts,
  };
}

/** Black dim from a screen's background transparency (100 = none, 15 = 85 % black). */
function dimOf(l: GuiLayout): number | undefined {
  return l.backgroundTransparency < 99.9 ? Math.max(0, Math.min(1, 1 - l.backgroundTransparency / 100)) : undefined;
}

/**
 * Option rows by row id: the Settings key and range they edit. Rows not listed are stored as
 * `x.<id>` with their choice index as the value (graphics.ts / the HUD read those).
 */
/** Gameplay pages' port option row "Enemies Ignore Player" (src/game/port-options.ts). */
export const IGNORE_PLAYER_SETTING = 'x.ignorePlayer';
export const IGNORE_PLAYER_LABEL = 'Enemies Ignore Player';
export const IGNORE_PLAYER_HELP =
  'Port option, not in the original game: enemies never target, grab or hear you. Stray shots, blasts, gas and fire still hurt.';

const SETTING_ROWS: Record<string, { setting: string; min: number; max: number; step: number } | { setting: string; values: (number | boolean)[] }> = {
  effectsVolume: { setting: 'sfx', min: 0, max: 1, step: 0.1 },
  dialogVolume: { setting: 'voice', min: 0, max: 1, step: 0.1 },
  musicVolume: { setting: 'music', min: 0, max: 1, step: 0.1 },
  // The original's range (0x10056d70: 0.25..4, default 1; its slider is exponential).
  turnSensitivity: { setting: 'mouseSensitivity', min: 0.25, max: 4, step: 0.25 },
  pitchSensitivity: { setting: 'pitchSensitivity', min: 0.25, max: 4, step: 0.25 },
  subtitles: { setting: 'subtitles', values: [true, false] }, // On / Off
  invertPitch: { setting: 'invertY', values: [true, false] }, // Yes / No
  gamma: { setting: 'x.gamma', min: 0.5, max: 1.5, step: 0.05 },
};

/** Graphics "Resolution" values: render scale of the native size, 0 = Auto (render-scale.ts). */
export const RESOLUTION_SCALES = RENDER_SCALES;
/** Engine "Frame Rate Limit" values (0 = off). */
export const FRAME_CAPS = [0, 30, 60];

// ---------------------------------------------------------------------------
// LoadSave GUI (#145 front end, #244 in game, #694 save; docs/frontend.md §8)

const kids = (n: GuiNode | undefined, name: string): GuiNode[] => {
  const c = n?.children[name];
  return !c ? [] : Array.isArray(c) ? c : [c];
};

/** Row text style: size from the widget (percent of the screen), placed relative to the row. */
function rowPlaced(w: TextWidget | undefined, defaultFont: number): Placed | undefined {
  if (!w) return undefined;
  const p = placed(w, defaultFont);
  return { ...p, rect: { x: 0, y: 0, w: (w.layout.w * 640) / 100, h: (w.layout.h * 480) / 100 } };
}

function saveListSpec(node: GuiNode, mode: 'load' | 'save', defaultFont: number, readNode: (r: RefKey) => GuiNode | undefined): SaveListSpec {
  const one = (k: string) => kids(node, k)[0];
  const p = node.props;
  const str = (k: string, fallback: string): Label | undefined => (typeof p[k] === 'string' ? label(p[k] as RefKey, fallback) : undefined);
  const listNode = one('p20');
  const list = listNode?.layout ? rectOf(listNode.layout) : { x: 64, y: 120, w: 512, h: 178 };
  const name = rowPlaced(textWidget(one('p31')), defaultFont);
  const date = rowPlaced(textWidget(one('p35')), defaultFont);
  const center = rowPlaced(textWidget(one('p29')), defaultFont);
  const newSave = textWidget(one('p28'));
  const damaged = textWidget(one('p32'));
  // GUI Border: texture p0, source rect p1..p4, edge sizes p5..p8.
  let border: SaveListSpec['border'];
  const borderRef = listNode?.props.border;
  const b = typeof borderRef === 'string' ? readNode(borderRef as RefKey) : undefined;
  const bt = b && typeof b.props.p0 === 'string' ? refId(b.props.p0 as RefKey) : undefined;
  if (b && bt !== undefined) {
    const n = (k: string) => (typeof b.props[k] === 'number' ? (b.props[k] as number) : 0);
    border = { texture: bt, uv: { x: n('p1'), y: n('p2'), w: n('p3'), h: n('p4') }, edge: n('p5') || 5 };
  }
  const arrow = (k: string): ImageSpec | undefined => {
    const w = imageWidget(kids(listNode, k)[0]);
    const tex = refId(w?.texture);
    return w && tex !== undefined ? { texture: tex, uv: { ...w.uv }, rect: { x: 0, y: 0, w: 16, h: 16 } } : undefined;
  };
  const hintNodes = mode === 'load' ? [kids(node, 'p17')[0], kids(node, 'p17')[1], kids(node, 'p18')[2]] : [kids(node, 'p21')[0], kids(node, 'p17')[1], kids(node, 'p18')[2]];
  const hints = hintNodes
    .map((n) => textWidget(n))
    .filter((w): w is TextWidget => !!w && !!w.label)
    .map((w) => ({ label: label(w.label, ''), place: placed(w, defaultFont) }));
  const rowBox = one('p26');
  const listBg = listNode?.layout ? `rgba(${rgb(listNode.layout.background.normal)},${1 - listNode.layout.backgroundTransparency / 100})` : 'rgba(0,0,0,1)';
  return {
    mode,
    list,
    listBg,
    border,
    rowHeight: name?.rect.h ?? 43,
    name,
    date,
    center,
    rowFocusBg: rowBox?.layout ? css(rowBox.layout.background.focused) : '#7f7f7f',
    rule: typeof one('p27')?.props.p15 === 'number' ? css(one('p27')!.props.p15 as number) : undefined,
    arrows: { up: arrow('p20'), down: arrow('p21') },
    hints,
    strings: {
      saved: str('p43', 'Saved'),
      loadFailed: str('p44', 'Load failed'),
      saveFailed: str('p45', 'Save failed'),
      empty: str('p46', 'No saved games'),
      loadConfirm: str('p47', 'Load this game?'),
      overwriteConfirm: str('p48', 'Overwrite this save?'),
      deleteConfirm: str('p49', 'Delete this save?'),
      newSave: newSave?.label ? label(newSave.label, 'New save') : undefined,
      damaged: damaged?.label ? label(damaged.label, 'Damaged save') : undefined,
    },
  };
}

const rgb = (c: number) => `${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}`;

export { defaultSaveSpec } from './model';

// ---------------------------------------------------------------------------
// GUI Border, Alert Box, Archives, Credits, keyboard page

function borderOf(ref: unknown, readNode: (r: RefKey) => GuiNode | undefined): BorderSpec | undefined {
  // GUI Border: texture p0, source rect p1..p4, edge sizes p5..p8.
  const b = typeof ref === 'string' ? readNode(ref as RefKey) : undefined;
  const bt = b && typeof b.props.p0 === 'string' ? refId(b.props.p0 as RefKey) : undefined;
  if (!b || bt === undefined) return undefined;
  const n = (k: string) => (typeof b.props[k] === 'number' ? (b.props[k] as number) : 0);
  return { texture: bt, uv: { x: n('p1'), y: n('p2'), w: n('p3'), h: n('p4') }, edge: n('p5') || 5 };
}

/**
 * Alert Box (class 0xaccfdfca): base rect (50 x 50 % centred), panel colour, GUI Border,
 * p15 button strings, p16 default button, p18 message / p19 button text styles. The children
 * are sized relative to the box (87.5 x 40 % message at the top, 30 x 10 % buttons at the
 * bottom) [guess: parent-relative here, unlike screen-level widgets].
 */
function alertSpec(n: GuiNode, defaultFont: number, readNode: (r: RefKey) => GuiNode | undefined): AlertSpec | undefined {
  if (!n.layout) return undefined;
  const rect = rectOf(n.layout);
  const box = { width: rect.w, height: rect.h };
  const inBox = (w: TextWidget): Placed => {
    const p = placed(w, defaultFont);
    const r = resolveRect(w.layout, rect, box);
    return { ...p, rect: r, margins: undefined };
  };
  const msg = textWidget(kids(n, 'message')[0]);
  const btn = textWidget(kids(n, 'button')[0]);
  if (!msg || !btn) return undefined;
  const l = n.layout;
  const buttons = (Array.isArray(n.props.buttons) ? n.props.buttons : []).filter((x): x is string => typeof x === 'string').map((k) => label(k, ''));
  return {
    rect,
    background: `rgba(${rgb(l.background.normal)},${Math.max(0, Math.min(1, 1 - l.backgroundTransparency / 100))})`,
    border: borderOf(l.border, readNode),
    message: inBox(msg),
    button: inBox(btn),
    buttons,
    defaultButton: typeof n.props.defaultButton === 'number' ? n.props.defaultButton : 0,
  };
}

const textAndPlace = (w: TextWidget | undefined, defaultFont: number) => (w?.label ? { label: label(w.label, ''), place: placed(w, defaultFont) } : undefined);
const refList = (v: unknown): RefKey[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/**
 * GUI Archives (#463): p16 footer text, p17 Archive Sets, p19 sound. Archive Set: p0 page-turn
 * videos, p1 title text, p2 "page locked" text, p3 Archive Pages, p4 (float, 1), p5 page-turn
 * sounds, p6 / p7 single sounds (open / close [guess]). Archive Page: p0 blank page tiles (6),
 * p1 content tiles (6), p2 narration sound. Pages are drawn at 256 px per tile in the 640x480
 * space (2.5 x 1.875 tiles visible), not stretched like a Screen Background.
 */
export function archivesSpec(n: GuiNode, defaultFont: number): ArchivesSpec | undefined {
  const sets = kids(n, 'p17');
  if (!sets.length) return undefined;
  const tiles = (v: unknown) => refList(v).map(refId);
  return {
    footer: textAndPlace(textWidget(kids(n, 'p16')[0]), defaultFont),
    closeSounds: refList(n.props.p19),
    sets: sets.map((set) => ({
      template: set.template,
      title: textAndPlace(textWidget(kids(set, 'p1')[0]), defaultFont),
      locked: textAndPlace(textWidget(kids(set, 'p2')[0]), defaultFont),
      turnVideos: videos(refList(set.props.p0)),
      turnSounds: refList(set.props.p5),
      openSounds: refList(set.props.p6),
      closeSounds: refList(set.props.p7),
      pages: kids(set, 'p3').map((pg) => ({
        ref: pg.template,
        lockedTiles: tiles(pg.props.p0),
        tiles: tiles(pg.props.p1),
        narration: typeof pg.props.p2 === 'string' ? (pg.props.p2 as string) : undefined,
      })),
    })),
  };
}

/**
 * GUI Credits (#535): p15 video, p16 its soundtrack (paired by the cutscene library), p17 the
 * credits text (.wdu entry), p18 four text styles (company, department, title, names), p19
 * weights, p20..p22 scroll parameters.
 */
export function creditsSpec(n: GuiNode, defaultFont: number): CreditsSpec | undefined {
  const styles = kids(n, 'p18').map(textWidget).filter((w): w is TextWidget => !!w).map((w) => placed(w, defaultFont));
  if (!styles.length) return undefined;
  const p = n.props;
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
  return {
    video: video(typeof p.p15 === 'string' ? (p.p15 as RefKey) : undefined),
    textEntry: refId(typeof p.p17 === 'string' ? (p.p17 as RefKey) : undefined),
    styles,
    weights: Array.isArray(p.p19) ? (p.p19 as unknown[]).map((x) => num(x, 1)) : [],
    speed: num(p.p20, 50),
    p21: num(p.p21, 0),
    p22: num(p.p22, 0),
  };
}

/** Control Settings GUI (#906): listbox #904, row box #905, name / key texts #898 / #899. */
function keyboardSpec(page: OptionPageDef, defaultFont: number, titleFont: number): KeyboardSpec {
  const n = page.node;
  const one = (k: string) => kids(n, k)[0];
  const listNode = one('p18');
  const list = listNode?.layout ? rectOf(listNode.layout) : { x: 64, y: 108, w: 512, h: 288 };
  const rowBox = one('p19');
  const name = rowPlaced(textWidget(one('p20')), defaultFont);
  const key = rowPlaced(textWidget(one('p21')), defaultFont);
  const arrow = (k: string): ImageSpec | undefined => {
    const w = imageWidget(kids(listNode, k)[0]);
    const tex = refId(w?.texture);
    return w && tex !== undefined ? { texture: tex, uv: { ...w.uv }, rect: { x: 0, y: 0, w: 16, h: 16 } } : undefined;
  };
  const btn = (w: TextWidget | undefined) => (w?.label ? { label: label(w.label, ''), place: placed(w, titleFont) } : undefined);
  const prompt = textWidget(one('p26'));
  const str = (k: string) => (page.strings[k] ? label(page.strings[k], '') : undefined);
  const lb = listNode?.layout;
  return {
    titles: images(page.titles),
    actions: refList(n.props.p30).map((k) => label(k, '')),
    list,
    listBg: lb ? `rgba(${rgb(lb.background.normal)},${Math.max(0, Math.min(1, 1 - lb.backgroundTransparency / 100))})` : 'rgba(0,0,0,0.15)',
    rowHeight: rowBox?.layout ? (rowBox.layout.h * 480) / 100 : 24,
    rowFocusBg: rowBox?.layout ? css(rowBox.layout.background.focused) : '#7f7f7f',
    name,
    key,
    arrows: { up: arrow('p20'), down: arrow('p21') },
    accept: btn(page.accept),
    cancel: btn(page.cancel),
    reset: btn(page.rows.find((r) => r.id === 'resetDefaults')?.label),
    prompt: prompt ? placed(prompt, defaultFont) : undefined,
    strings: { pressKey: str('pressKey'), reserved: str('reservedKey'), resetConfirm: str('resetConfirm') },
  };
}
