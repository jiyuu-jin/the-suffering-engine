// MenuModel: the data the front end is driven by (screens, widgets, labels,
// layout, videos, sounds, boot sequence). The renderer and boot flow only read
// this interface, never game data directly.
//
// The real model is built from the game's own menu definitions
// (src/formats/gui.ts, docs/frontend.md) by ./gui-adapter.ts. PROVISIONAL_MODEL
// below is a minimal hand-written fallback (auto layout, string ids observed in
// Interface.xdu) used only if those definitions can't be read.
//
// No game text is stored here: labels are string references into the game's
// .xdu tables. `text` labels are the engine's own neutral wording, used only
// where the data has no string (developer items, stubs for unimplemented screens).

import { CALIBRATE_SCREEN, CONTROLLER_SCREEN, controllerItems, decorateController } from './screens/controller';

/** Reference to a localized string: package id (from the .db) + string id. */
export interface StrRef {
  pkg: number;
  id: number;
}

/** A label: a game string, or engine wording when the data has none. */
export type Label = { str: StrRef; fallback: string } | { text: string };

/** Video reference: container path (without extension) + entry id. */
export interface VideoRef {
  container: string;
  id: number;
}

/** Rectangle in 640x480 virtual units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** CSS colours per widget state. */
export interface StateColors {
  normal: string;
  disabled: string;
  focused: string;
}

/** A text widget's placement and style (from the game's GUI templates). */
export interface Placed {
  rect: Rect;
  /** .fdu font id (Interface package). */
  font: number;
  /** Glyph scale on top of the 640x480 virtual size. */
  scale: number;
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'top' | 'middle' | 'bottom';
  colors: StateColors;
  /** Inner margins in virtual units. */
  margins?: { top: number; bottom: number; left: number; right: number };
}

/** A textured image (sub-rect of an Interface texture) placed on screen. */
export interface ImageSpec {
  texture: number;
  /** Source rect in texels; omitted = whole texture. */
  uv?: Rect;
  rect: Rect;
}

/** A progress/slider meter (HUD Meter). */
export interface MeterSpec {
  rect: Rect;
  /** Fill colour (CSS). */
  fill: string;
  /** Frame image stretched over the rect. */
  frame?: { texture: number; uv: Rect };
}

export type MenuAction =
  | { kind: 'push'; screen: string; transition?: boolean }
  | { kind: 'back' }
  | { kind: 'newGame'; difficulty?: number; transition?: boolean }
  | { kind: 'resume' }
  | { kind: 'quitToMenu' }
  | { kind: 'quitApp' }
  | { kind: 'revertCheckpoint' }
  | { kind: 'pageAccept' }
  | { kind: 'pageCancel' }
  | { kind: 'devViewer' }
  | { kind: 'devDemo' }
  // Save system (src/game/save; handled by the flow):
  | { kind: 'continue'; transition?: boolean }
  /** Refresh the save list, then open a 'saves' screen. */
  | { kind: 'openSaves'; screen: string; transition?: boolean }
  | { kind: 'loadSave'; id: string; confirmed?: boolean }
  /** Save into a new slot (no id) or over an existing save (confirmation first). */
  | { kind: 'saveTo'; id?: string; confirmed?: boolean }
  | { kind: 'deleteSave'; id: string; confirmed?: boolean }
  /** Graphics page "Use Defaults". */
  | { kind: 'graphicsDefaults' }
  /** Keyboard page "Default" (after its confirmation). */
  | { kind: 'bindingsDefaults'; confirmed?: boolean }
  /** Game Finished: keep the unlocks (save the profile) or drop them. */
  | { kind: 'gameFinished'; save: boolean }
  /** Close an in-game alert box (GUI Launcher) with button `index`. */
  | { kind: 'closeAlert'; index: number }
  | { kind: 'none' };

/** One row of a Load / Save list (filled by the flow from the save store). */
export interface SaveRowView {
  id: string;
  /** Chapter / level name (runtime text). */
  title: string;
  /** Second line (level, play time). */
  detail: string;
  /** Right column: date and time. */
  date: string;
  /** JPEG data URL. */
  thumbnail?: string;
  damaged?: boolean;
  /** The "New Save" row of the save screen. */
  isNew?: boolean;
}

/** Layout of the game's LoadSave GUI (Interface #145 / #244 / #694, docs/frontend.md §8). */
export interface SaveListSpec {
  mode: 'load' | 'save';
  /** Listbox rect (#144). */
  list: Rect;
  /** Listbox background (CSS) and its GUI Border (nine-slice of an Interface texture). */
  listBg: string;
  border?: { texture: number; uv: Rect; edge: number };
  /** Row height (the row text widgets' height). */
  rowHeight: number;
  /** Row text styles; rects are relative to the row's top-left. */
  name?: Placed;
  date?: Placed;
  /** Centered text (empty list message). */
  center?: Placed;
  /** Focused row background (Horizontal Box focus colour). */
  rowFocusBg: string;
  /** Separator between rows (Horizontal Rule p27 colour). */
  rule?: string;
  /** Scroll arrows (HUD Textures of the listbox). */
  arrows?: { up?: ImageSpec; down?: ImageSpec };
  /** Key hints (Return / Esc / Delete). */
  hints: { label: Label; place: Placed }[];
  /** Status / confirmation strings of the LoadSave GUI (p43..p49). */
  strings: Partial<Record<'saved' | 'loadFailed' | 'saveFailed' | 'empty' | 'loadConfirm' | 'overwriteConfirm' | 'deleteConfirm' | 'newSave' | 'damaged', Label>>;
}

/**
 * Setting a menu row edits: a known Settings key, or `x.<id>` for options the
 * engine stores but does not act on yet (graphics, help text, checkpoints...).
 */
export type SettingKey = string;

/** Per-row help text (graphics page: shown at the bottom for the focused row). */
export interface ItemHelp {
  help?: { label: Label; place: Placed };
}

export type MenuItem = (
  | {
      type: 'button';
      label: Label;
      action: MenuAction;
      disabled?: boolean;
      place?: Placed;
      group?: string;
      /** Re-evaluated by the flow: no saves exist / saving not allowed right now. */
      disabledWhen?: 'noSaves' | 'cannotSave';
      /** Row of a 'saves' screen. */
      save?: SaveRowView;
      /** Delete key on this item (save rows). */
      deleteAction?: MenuAction;
    }
  | { type: 'slider'; label: Label; setting: SettingKey; min: number; max: number; step: number; place?: Placed; meter?: MeterSpec }
  | {
      type: 'choice';
      label: Label;
      setting: SettingKey;
      choices: { label: Label; value: number | boolean; place?: Placed }[];
      place?: Placed;
      /** Runtime value text instead of the choice labels ('resolution': render size). */
      format?: 'resolution';
    }
) &
  ItemHelp;

export interface MenuScreen {
  id: string;
  /** Heading text (fallback layout) — data screens use titleImages. */
  title?: Label;
  /** Heading plates (HUD Textures). */
  titleImages?: ImageSpec[];
  /** Other images (e.g. the main menu logo). */
  images?: ImageSpec[];
  /** Paragraph (dialogs, stubs). */
  message?: Label;
  items: MenuItem[];
  footer?: Label;
  footerPlace?: Placed;
  /** 'placed': every widget has a rect from the data; 'list'/'form': automatic layout; 'saves': a Load/Save list. */
  layout: 'placed' | 'list' | 'form' | 'saves';
  /** Load / Save list layout (layout 'saves'; items are the rows). */
  saves?: SaveListSpec;
  /** Font role for automatic layouts. */
  font?: 'title' | 'ui';
  /** Show the logo above automatic-layout items. */
  logo?: boolean;
  /** Black dim drawn over the game/video behind this screen (0..1). */
  dim?: number;
  /** Fade-in seconds when the screen opens (the difficulty sub-menu cross-fades). */
  fadeIn?: number;
  /** Item focused when the screen opens. */
  defaultFocus?: number;
  /** Centered alert box (confirmations, notices). */
  dialog?: boolean;
  /** Options page: edits apply live; Accept keeps them, Cancel/Esc restores. */
  page?: boolean;
  /** Placed paragraph (Game Finished notice) instead of the centred `message`. */
  messagePlace?: Placed;
  /** Data-driven alert box layout for `dialog` screens (Alert Box templates). */
  alert?: AlertSpec;
  /** Screens with their own drawing and input (archives, credits, keyboard page). */
  custom?: CustomScreen;
  /** Extra drawing over a 'placed' screen (Controller page: the connected pad's name). */
  decorate?: (ui: CustomUi, time: number, focused: number) => void;
}

/** Alert Box template (#228 Yes/No, #229 / #247 OK...): box, border, message and button styles. */
export interface AlertSpec {
  rect: Rect;
  /** Box background (CSS) from the template's panel colour / transparency. */
  background: string;
  border?: BorderSpec;
  message: Placed;
  /** Button text style; buttons share the row at the bottom of the box. */
  button: Placed;
  /** Button labels (Alert Box p15) and the default one (p16). */
  buttons: Label[];
  defaultButton: number;
}

/** GUI Border nine-slice: texture, source rect, edge size (virtual px). */
export interface BorderSpec {
  texture: number;
  uv: Rect;
  edge: number;
}

export type NavInput = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'start' | 'alt';

/** Drawing / input services the front end lends to custom screens. */
export interface CustomUi {
  readonly ctx: CanvasRenderingContext2D;
  /** Seconds since the screen opened. */
  readonly age: number;
  label(l: Label | undefined): string;
  text(font: number | 'ui' | 'title', s: string, x: number, y: number, o?: { color?: string; align?: 'left' | 'center' | 'right'; scale?: number; alpha?: number; glow?: string; maxWidth?: number; shadow?: string | null }): { width: number; height: number };
  placedText(p: Placed, s: string, color: string, o?: { alpha?: number; glow?: string }): Rect;
  lineHeight(font: number | 'ui' | 'title'): number;
  measure(font: number | 'ui' | 'title', s: string): number;
  image(id: number): HTMLCanvasElement | undefined;
  drawImage(img: ImageSpec, alpha?: number): void;
  drawBorder(b: BorderSpec, r: Rect): void;
  /** Loads Interface textures not preloaded by the model (archive pages). */
  loadImages(ids: number[]): Promise<void>;
  sound(kind: 'move' | 'select' | 'back' | 'value'): void;
  /** Closes this screen (with the cancel sound unless `silent`). */
  close(silent?: boolean): void;
  /** Runs a flow action / opens another screen. */
  action(a: MenuAction): void;
  push(id: string): void;
  /** Registers a clickable rect (index passed back to click()). */
  hit(index: number, r: Rect): void;
}

export interface CustomScreen {
  open?(ui: CustomUi): void;
  close?(): void;
  draw(ui: CustomUi, time: number): void;
  /** Navigation input; return true when handled (unhandled 'back' closes the screen). */
  nav?(ui: CustomUi, a: NavInput): boolean;
  /** Raw key (before navigation mapping); return true to consume it. */
  key?(ui: CustomUi, e: KeyboardEvent): boolean;
  /** Click on a registered hit rect (or anywhere: index -1). */
  click?(ui: CustomUi, index: number, x: number, y: number): void;
  /** Mouse wheel over the screen (virtual coordinates); return true when handled. */
  wheel?(ui: CustomUi, deltaY: number, x: number, y: number): boolean;
  hover?(ui: CustomUi, index: number): void;
  /** Hide the menu backdrop dim / vignette (screens that draw full-screen pictures). */
  opaque?: boolean;
}

/** Archives (UIP 16, GUI Archives #463; docs/frontend.md §8). */
export interface ArchivesSpec {
  footer?: { label: Label; place: Placed };
  /** Archives p19: sound played when the archives close [guess]. */
  closeSounds: string[];
  sets: ArchiveSetSpec[];
}

export interface ArchiveSetSpec {
  template: string;
  title?: { label: Label; place: Placed };
  locked?: { label: Label; place: Placed };
  /** p0: page-turn clips (0.4 s; random pick, duplicates weight). */
  turnVideos: VideoRef[];
  /** p5: page-turn sounds (random); p6 / p7: open / close sounds [guess]. */
  turnSounds: string[];
  openSounds: string[];
  closeSounds: string[];
  pages: ArchivePageSpec[];
}

export interface ArchivePageSpec {
  /** Archive Page template ref ("5:467"): the unlock key (Archives Trigger p1). */
  ref: string;
  /** p0: the blank page (shown while locked); p1: the page content. 3x2 tiles of 256 px. */
  lockedTiles: (number | undefined)[];
  tiles: (number | undefined)[];
  /** p2: narration read when the unlocked page is shown. */
  narration?: string;
}

/** Credits (UIP 15, GUI Credits #535). */
export interface CreditsSpec {
  video?: VideoRef;
  /** Credits text: Interface .wdu entry (UTF-16 tab-separated: Company, Department, Title, Names). */
  textEntry?: number;
  /** Text styles per column (p18): font, scale, colours; rect height = line pitch. */
  styles: Placed[];
  /** p19 per-column weights (unknown role; kept for reference). */
  weights: number[];
  /** p20 scroll speed (virtual px / s) [guess]; p21 / p22 [unknown]. */
  speed: number;
  p21: number;
  p22: number;
}

/** Keyboard page (Control Settings GUI #906). */
export interface KeyboardSpec {
  titles: ImageSpec[];
  /** p30: action names, in binding order. */
  actions: Label[];
  list: Rect;
  listBg: string;
  rowHeight: number;
  /** Row focus background (Horizontal Box #905 focused colour). */
  rowFocusBg: string;
  name?: Placed;
  key?: Placed;
  arrows?: { up?: ImageSpec; down?: ImageSpec };
  accept?: { label: Label; place: Placed };
  cancel?: { label: Label; place: Placed };
  reset?: { label: Label; place: Placed };
  /** Prompt line (#907) for the key capture and messages. */
  prompt?: Placed;
  strings: { pressKey?: Label; reserved?: Label; resetConfirm?: Label };
}

export interface MenuModel {
  /** Path of the interface package without extension (fonts, strings, textures, sounds, videos). */
  interfacePackage: string;
  fonts: { ui: number; title: number };
  images: {
    /** Logo pieces for the gate / loading fallback. */
    logo: ImageSpec[];
    arrowLeft?: number;
    arrowRight?: number;
    /** Mouse pointer image (used as the CSS cursor). */
    cursor?: number;
  };
  boot: {
    /** One reel is picked at random; its videos play in order. */
    logoReels: VideoRef[][];
    /** Copyright screen: 3x2 background tiles, shown for `seconds`. */
    copyright?: { tiles: (number | undefined)[]; seconds: number };
  };
  mainMenu: {
    /** Looping backgrounds; the first plays first, later picks are random (duplicates weight). */
    backgrounds: VideoRef[];
    /** Played before actions marked `transition`. */
    transitions: VideoRef[];
    /** Attract movie after `idleSeconds` without input. */
    attract?: { video: VideoRef; idleSeconds: number };
    ambience?: {
      loops: string[];
      oneShots: string[];
      delaySeconds: number;
      segmentSeconds: number;
      radius: [number, number];
      fadeOutSeconds: number;
    };
  };
  sounds: { move?: string; select?: string; back?: string; value?: string };
  newGame: {
    /** Level path for New Game (a game string holding the .lvl path). */
    level: Label;
    spawnName?: string;
  };
  loading: {
    newGame?: { tiles: (number | undefined)[] };
    default?: { tiles: (number | undefined)[] };
    meter?: MeterSpec;
    label: Label;
  };
  screens: Record<string, MenuScreen>;
  mainScreen: string;
  pauseScreen: string;
  /**
   * Chapters (UIP p83, Chapter Properties): template ref ("pkg:id", what Level Transitions
   * name in p3) -> title. `newGame` = the chapter whose loading screen New Game shows.
   */
  chapters?: { list: { template: string; name: Label }[]; newGame?: string };
  /** Prelude level path (Main Menu p18), used for New Game once the game was finished. */
  preludeLevel?: Label;
  archives?: ArchivesSpec;
  credits?: CreditsSpec;
  keyboard?: KeyboardSpec;
  /** Alert Box layouts by template ref ("5:228"); `yesNo` / `ok` are the UIP alert slots. */
  alerts?: { yesNo?: AlertSpec; ok?: AlertSpec; byRef: Record<string, AlertSpec> };
}

// ---------------------------------------------------------------------------
// Provisional fallback (automatic layout).

const IF = 5; // Interface package id (COMMON/Interface/Interface.db: "id 5")
const s = (id: number, fallback: string): Label => ({ str: { pkg: IF, id }, fallback });
const t = (text: string): Label => ({ text });
const V = (id: number): VideoRef => ({ container: 'COMMON/Interface/Interface', id });

const BACK = s(342, 'Back');
const YES = s(31, 'Yes');
const NO = s(32, 'No');

export const PROVISIONAL_MODEL: MenuModel = {
  interfacePackage: 'COMMON/Interface/Interface',
  fonts: { ui: 2, title: 3 },
  images: {
    logo: [
      { texture: 231, uv: { x: 0, y: 64, w: 256, h: 128 }, rect: { x: 64, y: 0, w: 256, h: 144 } },
      { texture: 230, uv: { x: 0, y: 64, w: 256, h: 128 }, rect: { x: 320, y: 0, w: 256, h: 144 } },
    ],
    arrowLeft: 925,
    arrowRight: 926,
    cursor: 1122,
  },
  boot: { logoReels: [[V(31)], [V(30)]], copyright: { tiles: [344, 345, 346, 347, 348, 343], seconds: 5 } },
  mainMenu: { backgrounds: [V(15)], transitions: [V(20)], attract: { video: V(16), idleSeconds: 30 } },
  sounds: { move: `${IF}:2`, select: `${IF}:1`, back: `${IF}:3`, value: `${IF}:71` },
  newGame: { level: s(26, 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl') },
  loading: { label: s(314, 'Loading...') },
  mainScreen: 'main',
  pauseScreen: 'pause',
  screens: {
    main: {
      id: 'main',
      layout: 'list',
      font: 'title',
      logo: true,
      items: [
        { type: 'button', label: s(4, 'New Game'), action: { kind: 'push', screen: 'difficulty' } },
        { type: 'button', label: s(5, 'Continue'), action: { kind: 'continue' }, disabled: true, disabledWhen: 'noSaves' },
        { type: 'button', label: s(6, 'Load Game'), action: { kind: 'openSaves', screen: 'loadGame' }, disabled: true, disabledWhen: 'noSaves' },
        { type: 'button', label: s(7, 'Options'), action: { kind: 'push', screen: 'options' } },
        { type: 'button', label: t('Developer'), action: { kind: 'push', screen: 'developer' } },
        { type: 'button', label: s(162, 'Quit'), action: { kind: 'push', screen: 'confirmQuit' } },
      ],
    },
    difficulty: {
      id: 'difficulty',
      title: s(4, 'New Game'),
      layout: 'list',
      font: 'title',
      defaultFocus: 1,
      items: [0, 1, 2, 3].map((d) => ({
        type: 'button' as const,
        label: [s(16, 'Easy'), s(18, 'Medium'), s(17, 'Hard'), s(19, 'Impossible')][d],
        action: { kind: 'newGame' as const, difficulty: d },
      })),
    },
    options: {
      id: 'options',
      title: s(7, 'Options'),
      layout: 'form',
      font: 'ui',
      page: true,
      items: [
        { type: 'slider', label: t('Master Volume'), setting: 'master', min: 0, max: 1, step: 0.1 },
        { type: 'slider', label: s(331, 'Music Volume'), setting: 'music', min: 0, max: 1, step: 0.1 },
        { type: 'slider', label: s(329, 'Effects Volume'), setting: 'sfx', min: 0, max: 1, step: 0.1 },
        { type: 'slider', label: s(330, 'Dialog Volume'), setting: 'voice', min: 0, max: 1, step: 0.1 },
        { type: 'choice', label: s(337, 'Subtitles'), setting: 'subtitles', choices: [{ label: s(338, 'On'), value: true }, { label: s(339, 'Off'), value: false }] },
        { type: 'slider', label: s(350, 'Mouse Sensitivity'), setting: 'mouseSensitivity', min: 0.25, max: 4, step: 0.25 },
        { type: 'choice', label: s(359, 'Invert Mouse'), setting: 'invertY', choices: [{ label: s(358, 'Yes'), value: true }, { label: s(360, 'No'), value: false }] },
        { type: 'button', label: t('Controller'), action: { kind: 'push', screen: CONTROLLER_SCREEN } },
        { type: 'button', label: s(340, 'Accept'), action: { kind: 'pageAccept' } },
        { type: 'button', label: s(341, 'Cancel'), action: { kind: 'pageCancel' } },
      ],
    },
    developer: developerScreen(),
    [CONTROLLER_SCREEN]: {
      id: CONTROLLER_SCREEN,
      title: t('Controller'),
      layout: 'form',
      font: 'ui',
      page: true,
      items: [...controllerItems(), { type: 'button', label: s(340, 'Accept'), action: { kind: 'pageAccept' } }, { type: 'button', label: s(341, 'Cancel'), action: { kind: 'pageCancel' } }],
      decorate: (ui) => decorateController(ui),
    },
    [CALIBRATE_SCREEN]: { id: CALIBRATE_SCREEN, layout: 'placed', items: [] },
    confirmQuit: confirmScreen('confirmQuit', s(495, 'Quit?'), { kind: 'quitApp' }),
    pause: {
      id: 'pause',
      title: s(377, 'Pause'),
      layout: 'list',
      font: 'title',
      dim: 0.85,
      items: [
        { type: 'button', label: s(210, 'Resume'), action: { kind: 'resume' } },
        { type: 'button', label: s(9, 'Save Game'), action: { kind: 'openSaves', screen: 'saveGame' }, disabledWhen: 'cannotSave' },
        { type: 'button', label: s(8, 'Load Game'), action: { kind: 'openSaves', screen: 'loadGameInGame' }, disabledWhen: 'noSaves' },
        { type: 'button', label: s(187, 'Revert to checkpoint'), action: { kind: 'push', screen: 'confirmRevert' } },
        { type: 'button', label: s(12, 'Options'), action: { kind: 'push', screen: 'options' } },
        { type: 'button', label: s(10, 'Quit'), action: { kind: 'push', screen: 'confirmQuitGame' } },
      ],
    },
    confirmQuitGame: confirmScreen('confirmQuitGame', s(170, 'Quit to the main menu?'), { kind: 'quitToMenu' }),
    confirmRevert: confirmScreen('confirmRevert', s(188, 'Revert to the last checkpoint?'), { kind: 'revertCheckpoint' }),
    loadGame: savesScreen('loadGame', 'load', s(27, 'Load Game')),
    loadGameInGame: savesScreen('loadGameInGame', 'load', s(27, 'Load Game'), 0.85),
    saveGame: savesScreen('saveGame', 'save', s(28, 'Save Game'), 0.85),
  },
};

/** Load / Save list screen with the automatic layout (rows filled by the flow). */
export function savesScreen(id: string, mode: 'load' | 'save', title: Label, dim?: number): MenuScreen {
  return { id, layout: 'saves', title, items: [], saves: defaultSaveSpec(mode), dim };
}

/** Automatic Load / Save list layout when the LoadSave GUI can't be read (provisional model). */
export function defaultSaveSpec(mode: 'load' | 'save'): SaveListSpec {
  const text = (w: number, h: number, hAlign: Placed['hAlign']): Placed => ({
    rect: { x: 0, y: 0, w, h },
    font: 2,
    scale: 0.9,
    hAlign,
    vAlign: 'middle',
    colors: { normal: '#8d8a84', disabled: '#3a3836', focused: '#000000' },
  });
  return {
    mode,
    list: { x: 64, y: 120, w: 512, h: 178 },
    listBg: 'rgba(0,0,0,0.85)',
    rowHeight: 43,
    name: text(333, 43, 'left'),
    date: text(154, 43, 'right'),
    center: text(506, 115, 'center'),
    rowFocusBg: '#7f7f7f',
    hints: [],
    strings: {},
  };
}

/** Developer tools screen (engine-only, not part of the game's menus). */
export function developerScreen(): MenuScreen {
  return {
    id: 'developer',
    title: t('Developer'),
    layout: 'list',
    font: 'ui',
    items: [
      { type: 'button', label: t('Level viewer'), action: { kind: 'devViewer' } },
      { type: 'button', label: t('Procedural test scene'), action: { kind: 'devDemo' } },
      { type: 'button', label: BACK, action: { kind: 'back' } },
    ],
    footer: t('F1 toggles the developer sidebar at any time'),
  };
}

/** Yes/No alert box. "No" is focused by default. */
export function confirmScreen(id: string, message: Label, yes: MenuAction, labels = { yes: YES, no: NO }): MenuScreen {
  return {
    id,
    message,
    layout: 'list',
    font: 'title',
    dialog: true,
    defaultFocus: 1,
    items: [
      { type: 'button', label: labels.yes, action: yes, group: 'yn' },
      { type: 'button', label: labels.no, action: { kind: 'back' }, group: 'yn' },
    ],
  };
}

/** Notice for screens that exist in the game but are not implemented by the engine yet. */
export function stubScreen(id: string, title: Label | undefined, message: Label, titleImages?: ImageSpec[]): MenuScreen {
  return {
    id,
    title: titleImages?.length ? undefined : title,
    titleImages,
    message,
    layout: 'list',
    font: 'title',
    items: [{ type: 'button', label: BACK, action: { kind: 'back' } }],
  };
}
