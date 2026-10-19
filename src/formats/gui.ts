// Front-end / GUI definitions (main menu, pause, options, loading screens, HUD templates).
//
// The Suffering's whole user interface is data driven: every screen and widget is an object
// template in COMMON/Interface/Interface.odu (package 5), of a GUI class from Suffering.rfl
// ("Main Menu", "Simple Text GUI", "HUD Texture", ...). One "User Interface Properties"
// template (class 0xa3165141, Interface.odu #1) is the root: its properties name the default
// font, the boot movies, every screen, the UI sounds and the loading screens. The C++ classes
// only add behaviour (which property is which button, what pressing it does). That behaviour
// was recovered from the class code in Suffering.rfl and is encoded below as property-index
// tables; see docs/frontend.md for the evidence and confidence of each mapping.
//
// Everything this module returns is a REFERENCE ("pkg:id" keys): labels are .xdu string refs
// (resolve with StringDb.lookup), textures .tdu ids, fonts .fdu ids, videos .vdu ids, sounds
// .sdu keys. No game text or asset data is embedded here.
//
// Layout model (see resolveRect): x / y / w / h are PERCENT of the screen; text and glyph
// pixel sizes are authored for a 640x480 virtual screen (the engine scales them by
// screenWidth / 640 and screenHeight / 480).

import { classByHash, decodeTemplateProps, readObjectTemplate, type ClassDef, type EntityPackageSet, type PropValue } from './entities';
import type { ResRef } from './model';

// ===========================================================================
// Public types
// ===========================================================================

/** "pkg:id" reference (package id from the .db file, entry id in the typed container). */
export type RefKey = string;

/** Virtual resolution the GUI pixel sizes (fonts, text scale) are authored for. */
export const GUI_VIRTUAL_WIDTH = 640;
export const GUI_VIRTUAL_HEIGHT = 480;

/** Interface package id (COMMON/Interface/Interface.db) and System package id. */
export const INTERFACE_PKG = 5;
export const SYSTEM_PKG = 2;

/** Class ids of the GUI classes this module interprets (Suffering.rfl class table). */
export const GuiClass = {
  UserInterfaceProperties: 0xa3165141,
  MainMenu: 0x079152d1,
  PauseGameMenu: 0x2ace3c6a,
  Options: 0x2a387296,
  OpeningMovies: 0x13a1be1a,
  Copyright: 0x26d1c396,
  SimpleText: 0x9b31ae5d,
  SimpleRadio: 0xcb52fb94,
  HudTexture: 0x1265cb3f,
  HudMeter: 0xe35e393f,
  ScreenBackground: 0x7a97bf69,
  ProgressGui: 0x7325fff4,
  AlertBox: 0xaccfdfca,
  ChapterProperties: 0x576bfe0e,
  GuiAudio: 0xc09c0276,
  GuiGameplay: 0x599cd937,
  GuiGraphics: 0x91edb1ea,
  ControlSettings: 0x42d3905a,
  ScreenAdjust: 0xddf9130e,
  LoadSave: 0x1584b393,
  Credits: 0xbb1a596f,
  Archives: 0xb346e18b,
  GameFinished: 0x23774d5c,
  GuiLauncher: 0x2ab838a7,
  Player: 0xc8bc44e1,
} as const;

/**
 * Horizontal / vertical anchoring of a widget (base GUI properties 0 and 2), relative to its
 * parent widget's rectangle. 'screen': the percent position is taken as is (absolute);
 * 'start': offset from the parent's left/top; 'center': centred in the parent, position is an
 * offset; 'end': right/bottom aligned in the parent, position is an offset.
 */
export type GuiAlign = 'screen' | 'start' | 'center' | 'end';

/** Widget states (engine SetState values). Colours are chosen per state. */
export const GuiState = { Pressed: 1, Normal: 2, Disabled: 3, Hidden: 4, Focused: 5 } as const;
export type GuiStateValue = (typeof GuiState)[keyof typeof GuiState];

/** Per-state colours, 0xRRGGBB (the data's alpha byte is 0; opacity comes from the widget). */
export interface GuiColors {
  /** States Normal / Hidden / Pressed. */
  normal: number;
  disabled: number;
  focused: number;
}

/** Base properties 0..14 shared by every GUI class (the engine's CGUI base). */
export interface GuiLayout {
  hAlign: GuiAlign;
  /** Percent of screen width. */
  x: number;
  vAlign: GuiAlign;
  /** Percent of screen height. */
  y: number;
  w: number;
  h: number;
  /** Property 6 (bool; meaning not confirmed, usually 1). */
  p6: number;
  /** Property 7 (bool, sets engine flag 2; 1 on every shipped widget; probably "enabled/visible"). */
  enabled: boolean;
  /** Background panel colour per state (drawn only when backgroundTransparency < 99.9). */
  background: GuiColors;
  /** Optional background texture (stretched over the rect). */
  backgroundTexture?: RefKey;
  /** 0..100: 100 = no background panel, 0 = opaque, 15 = 85 % black dim (pause menu). */
  backgroundTransparency: number;
  /** Optional "GUI Border" template drawn around the rect. */
  border?: RefKey;
  /** Property 14 (float, always 1; unconfirmed). */
  p14: number;
}

/** A decoded value: numbers stay numbers, references become "pkg:id" keys, lists arrays. */
export type GuiScalar = number | RefKey | null;
export type GuiValue = GuiScalar | GuiScalar[];

/** Any GUI template, generically decoded (full tree of template-typed properties). */
export interface GuiNode {
  template: RefKey;
  classId: number;
  className: string;
  /** Present when the class derives from the CGUI base (properties 0..14). */
  layout?: GuiLayout;
  /** Every property by name (see PROP_NAMES; unnamed ones are "p<index>"). */
  props: Record<string, GuiValue>;
  /** Template-typed properties decoded recursively, keyed like `props`. */
  children: Record<string, GuiNode | GuiNode[]>;
}

/** "Simple Text GUI" (also the label part of "Simple Radio GUI"). */
export interface TextWidget {
  kind: 'text';
  template: RefKey;
  layout: GuiLayout;
  /** String ref, resolve with StringDb.lookup. Absent = text is filled in at runtime. */
  label?: RefKey;
  /** Font ref (.fdu); absent = UI default font (User Interface Properties p0). */
  font?: RefKey;
  /** Text alignment inside the rect (p19 / p20). */
  hTextAlign: 'left' | 'center' | 'right';
  vTextAlign: 'top' | 'middle' | 'bottom';
  /** Glyph scale (p21 / p22), on top of the 640x480 -> screen scale. */
  scale: [number, number];
  /** Text colour per state (p29 normal, p30 disabled, p31 focused). */
  colors: GuiColors;
  /** Inner margins, percent of screen (p25 top, p26 bottom, p27 left, p28 right). */
  margins: { top: number; bottom: number; left: number; right: number };
  /** p18 (int, 1 everywhere; text mode, probably word wrap). */
  mode: number;
}

/** "HUD Texture": a sub-rectangle of a texture. */
export interface ImageWidget {
  kind: 'image';
  template: RefKey;
  layout: GuiLayout;
  texture?: RefKey;
  /** Source rect in texels (p24..p27); w = h = 0 means the whole texture. */
  uv: { x: number; y: number; w: number; h: number };
}

/** "Screen Background": a full-screen picture made of 6 tiles of 256x256, 3 columns x 2 rows. */
export interface ScreenBackgroundDef {
  kind: 'background';
  template: RefKey;
  /** Row-major: [row0col0, row0col1, row0col2, row1col0, row1col1, row1col2]. */
  tiles: (RefKey | undefined)[];
  cols: 3;
  rows: 2;
}

/** Video + its separately stored soundtrack (the .vdu streams carry no audio). */
export interface MovieRef {
  video: RefKey;
  soundtrack?: RefKey;
}

export type BootStep =
  /** Pick ONE entry of `choices` at random, then play its movies in order (skippable). */
  | { kind: 'openingMovies'; choices: { template: RefKey; movies: MovieRef[] }[] }
  /** Legal screen: a background shown for `seconds` while `preloadPackages` load. */
  | { kind: 'copyright'; template: RefKey; background?: ScreenBackgroundDef; seconds: number; preloadPackages: RefKey[] }
  | { kind: 'mainMenu'; template: RefKey };

export type MenuActionKind =
  | 'openDifficulty' // main menu New Game: show the difficulty sub-menu (fade)
  | 'newGame' // difficulty chosen: start MainMenuDef.newGame.level with `difficulty`
  | 'continue' // load the most recent save
  | 'loadGame' // open the load screen (screen id in `screen`)
  | 'saveGame'
  | 'options'
  | 'archives'
  | 'credits'
  | 'quitApp' // confirm with `confirm`, then exit
  | 'resume'
  | 'revertCheckpoint' // confirm with `confirm`
  | 'quitToMainMenu' // confirm with `confirm`
  | 'openPage' // options sub-page (`screen`)
  | 'back';

export interface MenuAction {
  kind: MenuActionKind;
  /** ScreenId (or options page id) opened by the action. */
  screen?: string;
  difficulty?: number;
  /** Yes/No confirmation string shown first. */
  confirm?: RefKey;
  /** Main menu only: the engine first plays a transition video (MainMenuDef.videos.transition). */
  transitionVideo?: boolean;
}

export interface MenuItemDef {
  /** Stable id, e.g. 'newGame', 'continue', 'easy'. */
  id: string;
  /** Property index of the item in its screen template. */
  prop: number;
  widget: TextWidget;
  action: MenuAction;
  /** Runtime condition under which the engine shows the item disabled (state 3). */
  disabledWhen?: 'noSaves' | 'cannotSaveHere';
  /** Items that only exist on another platform build (not created by the PC classes). */
  platform?: 'console';
}

export interface MenuScreenDef {
  id: string;
  template: RefKey;
  className: string;
  layout: GuiLayout;
  /** Heading images (HUD Textures, e.g. the pause plate from the Interface atlas). */
  titles: ImageWidget[];
  /** Footer / hint texts (often empty strings filled at runtime with key hints). */
  footers: TextWidget[];
  /** Items in vertical (navigation) order. */
  items: MenuItemDef[];
  /** Index into `items` focused when the screen opens. */
  defaultFocus: number;
  /** "GUI Effects" template driving the focus glow/flicker. */
  focusEffect?: RefKey;
}

export interface MainMenuDef extends MenuScreenDef {
  /** Logo pieces (HUD Textures) shown above the main items. */
  logo: ImageWidget[];
  /** Fallback background picture (not drawn while a background video plays). */
  background?: ScreenBackgroundDef;
  difficulty: MenuScreenDef;
  /** Seconds of the cross-fade between the main items and the difficulty sub-menu (p37). */
  submenuFadeSeconds: number;
  newGame: {
    /** String ref holding the first level's .lvl path (p17). */
    level: RefKey;
    /** Used instead once the game has been finished (the prelude level is unlocked, p18). */
    unlockedLevel?: RefKey;
    /** Optional brightness screen template (p19). */
    screenAdjust?: RefKey;
  };
  videos: {
    /** Played first, looping. */
    first?: RefKey;
    /** Looping background videos; duplicates are weights (engine: random pick). */
    backgrounds: RefKey[];
    /** Played (random pick) when an item with transitionVideo is chosen. */
    transition: RefKey[];
    /** Third video state (p40), likely the return transition. */
    back: RefKey[];
    /** Attract movie after `idleSeconds` without input on the main menu. */
    attract?: MovieRef;
    idleSeconds: number;
  };
  ambience: {
    /** Positional looping beds (p41). */
    loops: RefKey[];
    /** Random one-shots (p42), one every `delaySeconds`, moving on a random path. */
    oneShots: RefKey[];
    delaySeconds: number;
    pathSegmentSeconds: number;
    /** Random path radius (engine units / 2048 = model units). */
    radius: [number, number];
    /** Fade-out when the menu closes. */
    fadeOutSeconds: number;
  };
  strings: { quitConfirm?: RefKey; loadFailed?: RefKey };
}

/** Option page row. */
export type OptionRow =
  | { kind: 'slider'; id: string; label: TextWidget; meter: GuiNode; help?: TextWidget; platform?: 'console' }
  | { kind: 'choice'; id: string; label: TextWidget; choices: TextWidget[]; help?: TextWidget; platform?: 'console' }
  | { kind: 'button'; id: string; label: TextWidget; help?: TextWidget; platform?: 'console' };

export interface OptionPageDef {
  id: string;
  template: RefKey;
  className: string;
  layout: GuiLayout;
  titles: ImageWidget[];
  footers: TextWidget[];
  rows: OptionRow[];
  accept?: TextWidget;
  cancel?: TextWidget;
  extraTexts: TextWidget[];
  /** Strings used by the page (confirmations, prompts), by role. */
  strings: Record<string, RefKey>;
  /** Raw tree, for anything not modelled. */
  node: GuiNode;
}

export interface LoadingScreenDef {
  template: RefKey;
  background?: ScreenBackgroundDef;
  /** Status texts by role (p21..p23 strings), and the text widget (p15). */
  text?: TextWidget;
  progressMeter?: GuiNode;
  node: GuiNode;
}

export interface ChapterDef {
  /** The Chapter Properties template; Level Transition objects reference it (their p3). */
  template: RefKey;
  /** Chapter title string ref. */
  name: RefKey;
  loadingScreen?: LoadingScreenDef;
}

/** UI sounds from User Interface Properties (Interface.sdu keys). */
export interface UiSounds {
  /** Focus moved to another item (UIP p47). */
  navigate?: RefKey;
  /** Radio / slider value changed (UIP p48). */
  valueChange?: RefKey;
  /** Item activated (UIP p49). */
  select?: RefKey;
  /** Back / cancel (UIP p50). */
  cancel?: RefKey;
  /** UIP p51: the long looping interface ambience (same sound as the main menu's ambient bed) [guess: menu music]. */
  menuLoop?: RefKey;
}

/** In-game HUD elements configured on the Player template (System package). */
export interface HudDef {
  health?: GuiNode;
  insanity?: GuiNode;
  insanityFrame?: GuiNode;
  flashlight?: GuiNode;
  ammo?: GuiNode;
  pickupMessage?: GuiNode;
  inventory?: GuiNode;
  messageList?: GuiNode;
  subtitles?: GuiNode;
  checkpointText?: GuiNode;
}

export interface FrontEnd {
  interfacePkg: number;
  uiProperties: RefKey;
  virtualResolution: { width: number; height: number };
  defaultFont?: RefKey;
  defaultTextRenderer?: RefKey;
  /** Mouse pointer texture (UIP p34). */
  cursorTexture?: RefKey;
  /** Plain white texture used for solid fills (UIP p2). */
  whiteTexture?: RefKey;
  boot: BootStep[];
  mainMenu?: MainMenuDef;
  pause?: MenuScreenDef;
  options: { frontEnd?: MenuScreenDef; inGame?: MenuScreenDef };
  /** Options sub-pages: keyboard, gameplay (front/in-game), graphics, audio (front/in-game), brightness. */
  optionPages: Record<string, OptionPageDef>;
  loading: {
    default?: LoadingScreenDef;
    /** UIP p40 (the chapter-0 loading screen; used when starting a new game). */
    newGame?: LoadingScreenDef;
    /** Small saving/loading indicator (UIP p41). */
    indicator?: ImageWidget;
    /** Generic loading backgrounds (UIP p42). */
    backgrounds: ScreenBackgroundDef[];
    chapters: ChapterDef[];
  };
  sounds: UiSounds;
  /** Confirmation / status strings by role. */
  strings: Record<string, RefKey>;
  /** Alert box templates by UIP slot role. */
  alerts: Record<string, GuiNode>;
  /** Every screen named by User Interface Properties, generically decoded. */
  screens: Record<string, GuiNode>;
  hud?: HudDef;
}

// ===========================================================================
// Property names per class (indices recovered from the class code; see docs/frontend.md)
// ===========================================================================

const BASE_NAMES = [
  'hAlign', 'x', 'vAlign', 'y', 'w', 'h', 'p6', 'enabled',
  'bgColor', 'bgColorDisabled', 'bgColorFocused', 'bgTexture', 'bgTransparency', 'border', 'p14',
];

const TEXT_NAMES: Record<number, string> = {
  15: 'label', 16: 'font', 17: 'textRenderer', 18: 'mode', 19: 'hTextAlign', 20: 'vTextAlign',
  21: 'scaleX', 22: 'scaleY', 25: 'marginTop', 26: 'marginBottom', 27: 'marginLeft', 28: 'marginRight',
  29: 'color', 30: 'colorDisabled', 31: 'colorFocused',
};

/** User Interface Properties slot names (UIP template, Interface.odu #1). */
export const UIP_SLOTS: Record<number, string> = {
  0: 'defaultFont', 1: 'defaultTextRenderer', 2: 'whiteTexture', 3: 'defaultLevelPackage', 4: 'p4',
  5: 'openingMovies', 6: 'copyright', 7: 'mainMenu', 8: 'levelSelect', 9: 'pause',
  10: 'loadGameFrontEnd', 11: 'loadGameInGame', 12: 'saveGame', 13: 'optionsFrontEnd', 14: 'optionsInGame',
  15: 'credits', 16: 'archives', 17: 'dvdExtra', 18: 'map', 19: 'gameFinished',
  20: 'alert20', 21: 'alert21', 22: 'alert22', 23: 'alert23', 24: 'alert24', 25: 'alert25',
  26: 'messageList', 27: 'subtitles', 28: 'checkpointText', 29: 'saveDeviceSelect', 30: 'formatProgress',
  31: 'quitGameConfirm', 32: 'controllerRemoved', 33: 'controllerRemoved2', 34: 'cursorTexture',
  39: 'loadingScreen', 40: 'newGameLoadingScreen', 41: 'loadingIndicator', 42: 'loadingBackgrounds',
  44: 'quote0', 45: 'quote1', 46: 'quote2',
  47: 'soundNavigate', 48: 'soundValueChange', 49: 'soundSelect', 50: 'soundCancel', 51: 'soundMenuLoop',
  61: 'checkpointSavePrompt', 83: 'chapters',
};

const MAIN_MENU_NAMES: Record<number, string> = {
  15: 'logo', 16: 'difficultyTitle', 17: 'newGameLevel', 18: 'unlockedNewGameLevel', 19: 'screenAdjust',
  20: 'itemNewGame', 21: 'itemOptions', 22: 'itemContinue', 23: 'itemLoadGame', 24: 'itemArchives',
  25: 'itemP25', 26: 'quitConfirm', 27: 'itemConsoleNewGame', 28: 'itemConsoleOptions', 29: 'itemQuit',
  30: 'defaultDifficulty', 31: 'itemEasy', 32: 'itemMedium', 33: 'itemHard', 34: 'itemImpossible',
  35: 'difficultyFooter', 36: 'focusEffect', 37: 'submenuFadeSeconds', 38: 'backgroundVideos',
  39: 'transitionVideos', 40: 'backVideos', 41: 'ambientLoops', 42: 'ambientOneShots',
  43: 'ambientDelay', 44: 'ambientPathSeconds', 45: 'ambientRadiusMin', 46: 'ambientRadiusMax',
  47: 'soundFadeSeconds', 48: 'attractVideo', 49: 'attractSoundtrack', 50: 'idleSeconds',
  51: 'loadFailed', 52: 'background',
};

const PAUSE_NAMES: Record<number, string> = {
  15: 'title', 16: 'footer', 17: 'itemResume', 18: 'itemSaveGame', 19: 'itemLoadGame',
  20: 'itemRevertCheckpoint', 21: 'itemOptions', 22: 'itemQuitGame', 23: 'itemArchives',
  24: 'focusEffect', 25: 'revertConfirm', 26: 'soundOpen', 27: 'soundClose',
};

const OPTIONS_NAMES: Record<number, string> = {
  15: 'title', 16: 'footer', 17: 'itemKeyboard', 18: 'itemGameplay', 19: 'itemGraphics',
  20: 'itemBrightness', 21: 'itemAudio', 22: 'itemLoadSettings', 23: 'itemSaveSettings', 24: 'itemCredits',
  25: 'itemBack', 26: 'focusEffect', 27: 'pageKeyboard', 28: 'pageGameplay', 29: 'pageGraphics',
  30: 'pageBrightness', 31: 'pageAudio', 32: 'pageLoadSettings', 33: 'pageSaveSettings',
};

const HUD_TEXTURE_NAMES: Record<number, string> = { 23: 'texture', 24: 'u', 25: 'v', 26: 'uw', 27: 'vh' };

const OPENING_MOVIES_NAMES: Record<number, string> = { 15: 'videos', 16: 'soundtracks' };
const COPYRIGHT_NAMES: Record<number, string> = { 15: 'background', 16: 'seconds', 17: 'preloadPackages' };
const PROGRESS_NAMES: Record<number, string> = {
  15: 'text', 16: 'progressMeter', 17: 'okButton', 18: 'background', 21: 'textBusy', 22: 'textDone', 23: 'textFailed',
};
const CHAPTER_NAMES: Record<number, string> = { 0: 'name', 1: 'loadingScreen' };
const RADIO_NAMES: Record<number, string> = { ...TEXT_NAMES, 32: 'markerOn', 33: 'markerOff' };
const ALERT_NAMES: Record<number, string> = { 15: 'buttons', 16: 'defaultButton', 17: 'p17', 18: 'message', 19: 'button' };
const LAUNCHER_NAMES: Record<number, string> = { 0: 'mode', 1: 'alertBox', 2: 'p2', 3: 'overlay', 4: 'text', 5: 'inLaunch', 6: 'inP6', 7: 'p7' };

/** Property names by class id (indices not listed are "p<index>"). */
export const PROP_NAMES: Record<number, Record<number, string>> = {
  [GuiClass.UserInterfaceProperties]: UIP_SLOTS,
  [GuiClass.MainMenu]: MAIN_MENU_NAMES,
  [GuiClass.PauseGameMenu]: PAUSE_NAMES,
  [GuiClass.Options]: OPTIONS_NAMES,
  [GuiClass.SimpleText]: TEXT_NAMES,
  [GuiClass.SimpleRadio]: RADIO_NAMES,
  [GuiClass.HudTexture]: HUD_TEXTURE_NAMES,
  [GuiClass.OpeningMovies]: OPENING_MOVIES_NAMES,
  [GuiClass.Copyright]: COPYRIGHT_NAMES,
  [GuiClass.ProgressGui]: PROGRESS_NAMES,
  [GuiClass.ChapterProperties]: CHAPTER_NAMES,
  [GuiClass.AlertBox]: ALERT_NAMES,
  [GuiClass.GuiLauncher]: LAUNCHER_NAMES,
};

/** GUI Launcher (level object) `mode` values -> what it opens. */
export const LAUNCHER_MODES: Record<number, string> = {
  0: 'message', 1: 'message', 2: 'credits', 3: 'engineEvent', 4: 'alertBox', 5: 'overlay', 6: 'gameFinished',
};

// ===========================================================================
// Generic decoding
// ===========================================================================

const BASE_TYPES = [7, 2, 7, 2, 2, 2, 7, 7, 0xf, 0xf, 0xf, 0xe, 2, 3, 2];

/** True when the class starts with the CGUI base property block (0..14). */
export function hasGuiBase(cls: ClassDef | undefined): boolean {
  if (!cls || cls.types.length < 15) return false;
  return BASE_TYPES.every((t, i) => (cls.types[i] & 0xff) === t);
}

const ALIGN: GuiAlign[] = ['screen', 'start', 'center', 'end'];
const key = (r: ResRef): RefKey => `${r.pkg}:${r.id}`;
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && 'pkg' in (v as object);

function toValue(v: PropValue): GuiValue {
  if (Array.isArray(v)) return v.map((x) => (isRef(x) ? key(x) : (x as number | null)));
  return isRef(v) ? key(v) : (v as number | null);
}

const num = (v: GuiValue | undefined, d = 0): number => (typeof v === 'number' ? v : d);
const ref = (v: GuiValue | undefined): RefKey | undefined => (typeof v === 'string' ? v : undefined);
const refs = (v: GuiValue | undefined): RefKey[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];

export function parseRefKey(k: RefKey): ResRef {
  const [pkg, id] = k.split(':').map(Number);
  return { pkg, id };
}

function propName(classId: number, cls: ClassDef | undefined, i: number, base: boolean): string {
  if (base && i < 15) return BASE_NAMES[i];
  return PROP_NAMES[classId]?.[i] ?? cls?.propNames[i] ?? `p${i}`;
}

function layoutFrom(v: GuiValue[]): GuiLayout {
  return {
    hAlign: ALIGN[num(v[0])] ?? 'screen',
    x: num(v[1]),
    vAlign: ALIGN[num(v[2])] ?? 'screen',
    y: num(v[3]),
    w: num(v[4]),
    h: num(v[5]),
    p6: num(v[6]),
    enabled: num(v[7]) !== 0,
    background: { normal: num(v[8]) & 0xffffff, disabled: num(v[9]) & 0xffffff, focused: num(v[10]) & 0xffffff },
    backgroundTexture: ref(v[11]),
    backgroundTransparency: num(v[12], 100),
    border: ref(v[13]),
    p14: num(v[14], 1),
  };
}

export interface GuiReader {
  packages: EntityPackageSet;
  /** Decoded nodes by template key (shared sub-templates are decoded once). */
  cache: Map<RefKey, GuiNode>;
}

/** Decodes any GUI (or other) template and its template-typed properties, recursively. */
export function readGuiNode(packages: EntityPackageSet | GuiReader, r: ResRef | RefKey): GuiNode | undefined {
  const rd: GuiReader = 'cache' in packages && 'packages' in packages ? (packages as GuiReader) : { packages: packages as EntityPackageSet, cache: new Map() };
  const rr = typeof r === 'string' ? parseRefKey(r) : r;
  const k = key(rr);
  const hit = rd.cache.get(k);
  if (hit) return hit;
  const t = readObjectTemplate(rd.packages, rr);
  if (!t) return undefined;
  const cls = classByHash(t.classHash);
  const raw = decodeTemplateProps(cls, t).map(toValue);
  const base = hasGuiBase(cls);
  const node: GuiNode = {
    template: k,
    classId: t.classHash >>> 0,
    className: cls?.name ?? `class_${(t.classHash >>> 0).toString(16)}`,
    layout: base ? layoutFrom(raw) : undefined,
    props: {},
    children: {},
  };
  rd.cache.set(k, node); // before recursing: templates are shared, never cyclic in the data, but be safe
  raw.forEach((v, i) => {
    const name = propName(node.classId, cls, i, base);
    node.props[name] = v;
    const ty = (cls?.types[i] ?? 0) & 0xff;
    if (ty !== 3 || (base && i === 13)) return; // template refs (border templates stay refs)
    if (Array.isArray(v)) {
      const kids = v.filter((x): x is string => typeof x === 'string').map((x) => readGuiNode(rd, x)).filter((x): x is GuiNode => !!x);
      if (kids.length) node.children[name] = kids;
    } else if (typeof v === 'string') {
      const kid = readGuiNode(rd, v);
      if (kid) node.children[name] = kid;
    }
  });
  return node;
}

// ===========================================================================
// Typed views
// ===========================================================================

const H_TEXT: TextWidget['hTextAlign'][] = ['left', 'center', 'right'];
const V_TEXT: TextWidget['vTextAlign'][] = ['top', 'middle', 'bottom'];

/** Text view of a Simple Text GUI / Simple Radio GUI / Simple Text HUD node. */
export function textWidget(n: GuiNode | undefined): TextWidget | undefined {
  if (!n || !n.layout) return undefined;
  if (n.classId !== GuiClass.SimpleText && n.classId !== GuiClass.SimpleRadio) return undefined;
  const p = n.props;
  return {
    kind: 'text',
    template: n.template,
    layout: n.layout,
    label: ref(p.label),
    font: ref(p.font),
    hTextAlign: H_TEXT[num(p.hTextAlign, 1)] ?? 'center',
    vTextAlign: V_TEXT[num(p.vTextAlign, 1)] ?? 'middle',
    scale: [num(p.scaleX, 1), num(p.scaleY, 1)],
    colors: { normal: num(p.color) & 0xffffff, disabled: num(p.colorDisabled) & 0xffffff, focused: num(p.colorFocused) & 0xffffff },
    margins: { top: num(p.marginTop), bottom: num(p.marginBottom), left: num(p.marginLeft), right: num(p.marginRight) },
    mode: num(p.mode, 1),
  };
}

export function imageWidget(n: GuiNode | undefined): ImageWidget | undefined {
  if (!n || !n.layout || n.classId !== GuiClass.HudTexture) return undefined;
  const p = n.props;
  return { kind: 'image', template: n.template, layout: n.layout, texture: ref(p.texture), uv: { x: num(p.u), y: num(p.v), w: num(p.uw), h: num(p.vh) } };
}

export function screenBackground(n: GuiNode | undefined): ScreenBackgroundDef | undefined {
  if (!n || n.classId !== GuiClass.ScreenBackground) return undefined;
  return { kind: 'background', template: n.template, tiles: [0, 1, 2, 3, 4, 5].map((i) => ref(n.props[`p${i}`])), cols: 3, rows: 2 };
}

const child = (n: GuiNode | undefined, name: string): GuiNode | undefined => {
  const c = n?.children[name];
  return Array.isArray(c) ? c[0] : c;
};
const childList = (n: GuiNode | undefined, name: string): GuiNode[] => {
  const c = n?.children[name];
  return !c ? [] : Array.isArray(c) ? c : [c];
};
const textAt = (n: GuiNode | undefined, prop: number | string) =>
  textWidget(child(n, typeof prop === 'number' ? nameOf(n, prop) : prop));
const nameOf = (n: GuiNode | undefined, i: number) => (n ? propName(n.classId, classByHash(n.classId), i, !!n.layout) : `p${i}`);

function item(n: GuiNode | undefined, prop: number, id: string, action: MenuAction, extra: Partial<MenuItemDef> = {}): MenuItemDef | undefined {
  const w = textAt(n, prop);
  return w ? { id, prop, widget: w, action, ...extra } : undefined;
}
const defined = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined);
const byY = (a: MenuItemDef, b: MenuItemDef) => a.widget.layout.y - b.widget.layout.y;

// ---------------------------------------------------------------------------
// Screens

/**
 * Main Menu (class 0x079152d1). Item -> action mapping from the class code (Suffering.rfl:
 * item creation at 0x100627b0, activation at 0x10063610, deferred actions at 0x10063e3f with
 * the "needs transition video" table at 0x1017730c).
 */
export function readMainMenu(n: GuiNode): MainMenuDef {
  const p = n.props;
  const quitConfirm = ref(p.quitConfirm);
  const items = defined([
    item(n, 20, 'newGame', { kind: 'openDifficulty', screen: 'difficulty' }),
    item(n, 22, 'continue', { kind: 'continue', transitionVideo: true }, { disabledWhen: 'noSaves' }),
    item(n, 23, 'loadGame', { kind: 'loadGame', screen: 'loadGameFrontEnd', transitionVideo: true }, { disabledWhen: 'noSaves' }),
    item(n, 21, 'options', { kind: 'options', screen: 'optionsFrontEnd' }),
    item(n, 24, 'archives', { kind: 'archives', screen: 'archives', transitionVideo: true }),
    item(n, 29, 'quit', { kind: 'quitApp', confirm: quitConfirm }),
  ]).sort(byY);
  const diffItems = defined(
    [31, 32, 33, 34].map((prop, d) =>
      item(n, prop, ['easy', 'medium', 'hard', 'impossible'][d], { kind: 'newGame', difficulty: d, transitionVideo: true }),
    ),
  );
  const difficulty: MenuScreenDef = {
    id: 'difficulty',
    template: n.template,
    className: n.className,
    layout: n.layout!,
    titles: defined(childList(n, 'difficultyTitle').map(imageWidget)),
    footers: defined(childList(n, 'difficultyFooter').map(textWidget)),
    items: diffItems,
    defaultFocus: Math.max(0, Math.min(diffItems.length - 1, num(p.defaultDifficulty, 1))),
    focusEffect: ref(p.focusEffect),
  };
  const attractVideo = ref(p.attractVideo);
  const bg = refs(p.backgroundVideos);
  return {
    id: 'mainMenu',
    template: n.template,
    className: n.className,
    layout: n.layout!,
    titles: [],
    footers: [],
    items,
    defaultFocus: 0,
    focusEffect: ref(p.focusEffect),
    logo: defined(childList(n, 'logo').map(imageWidget)),
    background: screenBackground(child(n, 'background')),
    difficulty,
    submenuFadeSeconds: num(p.submenuFadeSeconds, 0.5),
    newGame: { level: ref(p.newGameLevel) ?? '', unlockedLevel: ref(p.unlockedNewGameLevel), screenAdjust: ref(p.screenAdjust) },
    videos: {
      first: bg[0],
      backgrounds: bg,
      transition: refs(p.transitionVideos),
      back: refs(p.backVideos),
      attract: attractVideo ? { video: attractVideo, soundtrack: ref(p.attractSoundtrack) } : undefined,
      idleSeconds: num(p.idleSeconds, 30),
    },
    ambience: {
      loops: refs(p.ambientLoops),
      oneShots: refs(p.ambientOneShots),
      delaySeconds: num(p.ambientDelay),
      pathSegmentSeconds: num(p.ambientPathSeconds),
      radius: [num(p.ambientRadiusMin), num(p.ambientRadiusMax)],
      fadeOutSeconds: num(p.soundFadeSeconds),
    },
    strings: { quitConfirm, loadFailed: ref(p.loadFailed) },
  };
}

/** Pause Game Menu (class 0x2ace3c6a; item creation at Suffering.rfl 0x10065a56). */
export function readPauseMenu(n: GuiNode, uip?: GuiNode): MenuScreenDef {
  const quit = ref(uip?.props.quitGameConfirm);
  const items = defined([
    item(n, 17, 'resume', { kind: 'resume' }),
    item(n, 18, 'saveGame', { kind: 'saveGame', screen: 'saveGame' }, { disabledWhen: 'cannotSaveHere' }),
    item(n, 19, 'loadGame', { kind: 'loadGame', screen: 'loadGameInGame' }),
    item(n, 20, 'revertCheckpoint', { kind: 'revertCheckpoint', confirm: ref(n.props.revertConfirm) }),
    item(n, 21, 'options', { kind: 'options', screen: 'optionsInGame' }),
    item(n, 23, 'archives', { kind: 'archives', screen: 'archives' }),
    item(n, 22, 'quitGame', { kind: 'quitToMainMenu', confirm: quit }),
  ]).sort(byY);
  return {
    id: 'pause',
    template: n.template,
    className: n.className,
    layout: n.layout!,
    titles: defined(childList(n, 'title').map(imageWidget)),
    footers: defined(childList(n, 'footer').map(textWidget)),
    items,
    defaultFocus: 0,
    focusEffect: ref(n.props.focusEffect),
  };
}

/**
 * GUI Options (class 0x2a387296; Suffering.rfl 0x10064630). The PC class creates Keyboard,
 * Gameplay, Graphics, Audio, Credits (only if p24 is set) and Back; Brightness and the
 * load/save-settings items overlap other items and are console-only.
 */
export function readOptionsMenu(n: GuiNode, id: string): MenuScreenDef {
  const items = defined([
    item(n, 17, 'keyboard', { kind: 'openPage', screen: 'keyboard' }),
    item(n, 18, 'gameplay', { kind: 'openPage', screen: id === 'optionsInGame' ? 'gameplayInGame' : 'gameplay' }),
    item(n, 19, 'graphics', { kind: 'openPage', screen: 'graphics' }),
    item(n, 21, 'audio', { kind: 'openPage', screen: id === 'optionsInGame' ? 'audioInGame' : 'audio' }),
    item(n, 24, 'credits', { kind: 'credits', screen: 'credits' }),
    item(n, 25, 'back', { kind: 'back' }),
    item(n, 20, 'brightness', { kind: 'openPage', screen: 'brightness' }, { platform: 'console' }),
    item(n, 22, 'loadSettings', { kind: 'openPage', screen: 'loadSettings' }, { platform: 'console' }),
    item(n, 23, 'saveSettings', { kind: 'openPage', screen: 'saveSettings' }, { platform: 'console' }),
  ]);
  const pc = items.filter((i) => !i.platform).sort(byY);
  return {
    id,
    template: n.template,
    className: n.className,
    layout: n.layout!,
    titles: defined(childList(n, 'title').map(imageWidget)),
    footers: defined(childList(n, 'footer').map(textWidget)),
    items: [...pc, ...items.filter((i) => i.platform)],
    defaultFocus: 0,
    focusEffect: ref(n.props.focusEffect),
  };
}

// ---------------------------------------------------------------------------
// Option pages. Row structure = property indices of each class (label, value widgets).

type RowSpec =
  | ['slider', string, number, number, (number | undefined)?]
  | ['choice', string, number, number[], number | undefined, ('console' | undefined)?]
  | ['button', string, number, number | undefined];

const PAGE_SPECS: Record<number, { accept?: number; cancel?: number; titles: number; footers: number; rows: RowSpec[]; strings?: Record<string, number> }> = {
  [GuiClass.GuiAudio]: {
    accept: 15, cancel: 16, titles: 17, footers: 18,
    rows: [
      ['slider', 'effectsVolume', 19, 20],
      ['slider', 'dialogVolume', 23, 24],
      ['slider', 'musicVolume', 21, 22],
      ['choice', 'subtitles', 30, [31, 32], undefined],
      // Speaker Setup (26: Mono/Stereo/Surround) and Environment FX (33) share y = 63; which one
      // the PC build shows is not confirmed (Environment FX is the PC/EAX option) [guess].
      ['choice', 'environmentFx', 33, [34, 35], undefined],
      ['choice', 'speakerSetup', 26, [27, 28, 29], undefined, 'console'],
    ],
  },
  [GuiClass.GuiGameplay]: {
    accept: 15, cancel: 16, titles: 17, footers: 18,
    rows: [
      ['slider', 'turnSensitivity', 26, 27],
      ['slider', 'pitchSensitivity', 29, 30],
      ['choice', 'invertPitch', 31, [32, 33], undefined],
      ['choice', 'helpText', 23, [24, 25], undefined],
      ['choice', 'checkpoints', 19, [20, 21, 22], undefined],
      // Overlap invertPitch / helpText on consoles [guess on which build shows which].
      ['choice', 'autoPitch', 40, [41, 42], undefined, 'console'],
      ['choice', 'autoTargeting', 37, [38, 39], undefined, 'console'],
    ],
  },
  [GuiClass.GuiGraphics]: {
    accept: 15, cancel: 16, titles: 18, footers: 19,
    rows: [
      ['choice', 'vsync', 20, [21, 22], 23],
      ['choice', 'resolution', 24, [25], 26],
      ['choice', 'pixelShaders', 27, [28, 29], 30],
      ['slider', 'gamma', 31, 32, 34],
      ['choice', 'shadows', 35, [36, 38, 37], 39],
      ['choice', 'textureFiltering', 40, [41, 42, 43], 44],
      ['button', 'useDefaults', 45, 46],
    ],
  },
  [GuiClass.ControlSettings]: {
    accept: 25, cancel: 22, titles: 15, footers: 16,
    rows: [['button', 'resetDefaults', 23, undefined]],
    strings: { resetConfirm: 24, pressKey: 27, reservedKey: 28 },
  },
  [GuiClass.ScreenAdjust]: { titles: 15, footers: 16, rows: [] },
};

function readOptionPage(n: GuiNode, id: string): OptionPageDef {
  const spec = PAGE_SPECS[n.classId];
  const at = (i: number | undefined) => (i === undefined ? undefined : textAt(n, i));
  const rows: OptionRow[] = [];
  const used = new Set<string>();
  for (const r of spec?.rows ?? []) {
    const label = at(r[2]);
    if (!label) continue;
    used.add(nameOf(n, r[2]));
    if (r[0] === 'slider') {
      const meter = child(n, nameOf(n, r[3]));
      used.add(nameOf(n, r[3]));
      if (r[4] !== undefined) used.add(nameOf(n, r[4]));
      if (meter) rows.push({ kind: 'slider', id: r[1], label, meter, help: at(r[4]) });
    } else if (r[0] === 'choice') {
      r[3].forEach((i) => used.add(nameOf(n, i)));
      if (r[4] !== undefined) used.add(nameOf(n, r[4]));
      rows.push({ kind: 'choice', id: r[1], label, choices: defined(r[3].map(at)), help: at(r[4]), platform: r[5] });
    } else {
      if (r[3] !== undefined) used.add(nameOf(n, r[3]));
      rows.push({ kind: 'button', id: r[1], label, help: at(r[3]) });
    }
  }
  const strings: Record<string, RefKey> = {};
  for (const [k, i] of Object.entries(spec?.strings ?? {})) {
    const v = ref(n.props[nameOf(n, i)]);
    if (v) strings[k] = v;
  }
  const accept = spec?.accept !== undefined ? at(spec.accept) : undefined;
  const cancel = spec?.cancel !== undefined ? at(spec.cancel) : undefined;
  const skip = new Set([...used, spec ? nameOf(n, spec.titles) : '', spec ? nameOf(n, spec.footers) : '']);
  if (spec?.accept !== undefined) skip.add(nameOf(n, spec.accept));
  if (spec?.cancel !== undefined) skip.add(nameOf(n, spec.cancel));
  const extraTexts: TextWidget[] = [];
  for (const [k, c] of Object.entries(n.children)) {
    if (skip.has(k)) continue;
    for (const x of Array.isArray(c) ? c : [c]) {
      const t = textWidget(x);
      if (t) extraTexts.push(t);
    }
  }
  return {
    id,
    template: n.template,
    className: n.className,
    layout: n.layout!,
    titles: spec ? defined(childList(n, nameOf(n, spec.titles)).map(imageWidget)) : [],
    footers: spec ? defined(childList(n, nameOf(n, spec.footers)).map(textWidget)) : [],
    rows,
    accept,
    cancel,
    extraTexts,
    strings,
    node: n,
  };
}

function readLoadingScreen(n: GuiNode | undefined): LoadingScreenDef | undefined {
  if (!n) return undefined;
  return {
    template: n.template,
    background: screenBackground(child(n, 'background')),
    text: textWidget(child(n, 'text')),
    progressMeter: child(n, 'progressMeter'),
    node: n,
  };
}

// ===========================================================================
// Entry points
// ===========================================================================

/** Finds the User Interface Properties template of a package (Interface.odu #1 in retail). */
export function findUiPropertiesTemplate(packages: EntityPackageSet, pkg = INTERFACE_PKG): ResRef | undefined {
  const odu = packages.get(pkg)?.odu;
  if (!odu) return undefined;
  for (const e of odu.entries) {
    if (e.type !== 2 || e.group !== 1) continue;
    const t = readObjectTemplate(packages, { pkg, id: e.id });
    if (t && t.classHash >>> 0 === GuiClass.UserInterfaceProperties) return { pkg, id: e.id };
  }
  return undefined;
}

export interface ReadFrontEndOptions {
  interfacePkg?: number;
  /** Package holding the Player template (HUD wiring). Default 2 (System); skipped if absent. */
  systemPkg?: number;
}

/**
 * Decodes the whole front end. `packages` needs at least the Interface package's .odu
 * (id 5); add System (id 2) for the HUD. Strings are NOT resolved (use StringDb).
 */
export function readFrontEnd(packages: EntityPackageSet, opts: ReadFrontEndOptions = {}): FrontEnd {
  const pkg = opts.interfacePkg ?? INTERFACE_PKG;
  const rd: GuiReader = { packages, cache: new Map() };
  const uipRef = findUiPropertiesTemplate(packages, pkg);
  const uip = uipRef ? readGuiNode(rd, uipRef) : undefined;
  const fe: FrontEnd = {
    interfacePkg: pkg,
    uiProperties: uipRef ? key(uipRef) : '',
    virtualResolution: { width: GUI_VIRTUAL_WIDTH, height: GUI_VIRTUAL_HEIGHT },
    boot: [],
    options: {},
    optionPages: {},
    loading: { backgrounds: [], chapters: [] },
    sounds: {},
    strings: {},
    alerts: {},
    screens: {},
  };
  if (!uip) return fe;
  const p = uip.props;
  fe.defaultFont = ref(p.defaultFont);
  fe.defaultTextRenderer = ref(p.defaultTextRenderer);
  fe.whiteTexture = ref(p.whiteTexture);
  fe.cursorTexture = ref(p.cursorTexture);

  for (const [i, name] of Object.entries(UIP_SLOTS)) {
    const c = uip.children[name];
    if (!c || Number(i) === 1 || Number(i) === 83 || Number(i) === 42 || Number(i) === 5) continue;
    if (!Array.isArray(c)) fe.screens[name] = c;
  }

  // Boot: one random opening-movies template -> copyright -> main menu (Suffering.rfl 0x100b2080).
  const choices = childList(uip, 'openingMovies').map((m) => {
    const vids = refs(m.props.videos);
    const snds = refs(m.props.soundtracks);
    return { template: m.template, movies: vids.map((v, k) => ({ video: v, soundtrack: snds[k] })) };
  });
  if (choices.length) fe.boot.push({ kind: 'openingMovies', choices });
  const cr = child(uip, 'copyright');
  if (cr) {
    fe.boot.push({
      kind: 'copyright',
      template: cr.template,
      background: screenBackground(child(cr, 'background')),
      seconds: num(cr.props.seconds, 5),
      preloadPackages: refs(cr.props.preloadPackages),
    });
  }
  const mm = child(uip, 'mainMenu');
  if (mm) {
    fe.boot.push({ kind: 'mainMenu', template: mm.template });
    fe.mainMenu = readMainMenu(mm);
    const sa = child(mm, 'screenAdjust');
    if (sa) fe.optionPages.brightness = readOptionPage(sa, 'brightness');
  }
  const pause = child(uip, 'pause');
  if (pause) fe.pause = readPauseMenu(pause, uip);

  const optPages = (o: GuiNode, inGame: boolean) => {
    const suffix = inGame ? 'InGame' : '';
    const pages: [string, string][] = [
      ['pageKeyboard', 'keyboard'],
      ['pageGameplay', 'gameplay' + suffix],
      ['pageGraphics', 'graphics'],
      ['pageAudio', 'audio' + suffix],
      ['pageBrightness', 'brightness'],
    ];
    for (const [prop, id] of pages) {
      const c = child(o, prop);
      if (c && !fe.optionPages[id]) fe.optionPages[id] = readOptionPage(c, id);
    }
  };
  const of = child(uip, 'optionsFrontEnd');
  if (of) {
    fe.options.frontEnd = readOptionsMenu(of, 'optionsFrontEnd');
    optPages(of, false);
  }
  const oi = child(uip, 'optionsInGame');
  if (oi) {
    fe.options.inGame = readOptionsMenu(oi, 'optionsInGame');
    optPages(oi, true);
  }

  // Loading screens.
  fe.loading.default = readLoadingScreen(child(uip, 'loadingScreen'));
  fe.loading.newGame = readLoadingScreen(child(uip, 'newGameLoadingScreen'));
  fe.loading.indicator = imageWidget(child(uip, 'loadingIndicator'));
  fe.loading.backgrounds = defined(childList(uip, 'loadingBackgrounds').map(screenBackground));
  fe.loading.chapters = childList(uip, 'chapters').map((c) => ({
    template: c.template,
    name: ref(c.props.name) ?? '',
    loadingScreen: readLoadingScreen(child(c, 'loadingScreen')),
  }));

  fe.sounds = {
    navigate: ref(p.soundNavigate),
    valueChange: ref(p.soundValueChange),
    select: ref(p.soundSelect),
    cancel: ref(p.soundCancel),
    menuLoop: ref(p.soundMenuLoop),
  };
  for (const k of ['quitGameConfirm', 'controllerRemoved', 'checkpointSavePrompt', 'quote0', 'quote1', 'quote2', 'defaultLevelPackage']) {
    const v = ref(p[k]);
    if (v) fe.strings[k] = v;
  }
  if (fe.mainMenu?.strings.quitConfirm) fe.strings.quitAppConfirm = fe.mainMenu.strings.quitConfirm;
  if (fe.mainMenu?.strings.loadFailed) fe.strings.loadFailed = fe.mainMenu.strings.loadFailed;
  for (let i = 20; i <= 25; i++) {
    const c = child(uip, UIP_SLOTS[i]);
    if (c) fe.alerts[UIP_SLOTS[i]] = c;
  }

  // HUD wiring on the Player template (System package, template 2:5).
  const sys = opts.systemPkg ?? SYSTEM_PKG;
  if (packages.get(sys)?.odu) fe.hud = readHud(rd, sys, uip);
  return fe;
}

/** HUD elements referenced by the Player template's properties (System.odu 2:5). */
export function readHud(packages: EntityPackageSet | GuiReader, systemPkg = SYSTEM_PKG, uip?: GuiNode): HudDef | undefined {
  const rd: GuiReader = 'cache' in packages && 'packages' in packages ? (packages as GuiReader) : { packages: packages as EntityPackageSet, cache: new Map() };
  const odu = rd.packages.get(systemPkg)?.odu;
  if (!odu) return undefined;
  let player: ResRef | undefined;
  for (const e of odu.entries) {
    if (e.type !== 2 || e.group !== 1) continue;
    const t = readObjectTemplate(rd.packages, { pkg: systemPkg, id: e.id });
    if (t && t.classHash >>> 0 === GuiClass.Player) {
      player = { pkg: systemPkg, id: e.id };
      break; // the first Player template (2:5) is the one levels place
    }
  }
  if (!player) return undefined;
  const t = readObjectTemplate(rd.packages, player)!;
  const vals = decodeTemplateProps(classByHash(t.classHash), t);
  const at = (i: number) => {
    const v = vals[i];
    return isRef(v) ? readGuiNode(rd, v) : undefined;
  };
  return {
    // Player property indices from the Player template; roles from position/colour [strong].
    health: at(277),
    insanity: at(278),
    insanityFrame: at(279),
    flashlight: at(281),
    ammo: at(282),
    pickupMessage: at(284),
    inventory: at(246),
    messageList: child(uip, 'messageList'),
    subtitles: child(uip, 'subtitles'),
    checkpointText: child(uip, 'checkpointText'),
  };
}

// ===========================================================================
// Layout
// ===========================================================================

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pixel rect of a widget, following the engine (Suffering.rfl 0x1004ecb0 / 0x1004f190):
 * size and position are percent of the SCREEN; the alignment then places the widget relative
 * to its parent's rect ('screen' keeps the absolute position).
 */
export function resolveRect(l: GuiLayout, parent: Rect, screen: { width: number; height: number } = { width: GUI_VIRTUAL_WIDTH, height: GUI_VIRTUAL_HEIGHT }): Rect {
  const w = (screen.width * l.w) / 100;
  const h = (screen.height * l.h) / 100;
  const ox = (screen.width * l.x) / 100;
  const oy = (screen.height * l.y) / 100;
  const place = (a: GuiAlign, off: number, size: number, pPos: number, pSize: number) =>
    a === 'start' ? pPos + off : a === 'center' ? pPos + (pSize - size) / 2 + off : a === 'end' ? pPos + pSize - size + off : off;
  return { x: place(l.hAlign, ox, w, parent.x, parent.w), y: place(l.vAlign, oy, h, parent.y, parent.h), w, h };
}

/** Engine text scale for a screen size (glyph pixels are authored for 640x480). */
export function guiPixelScale(screen: { width: number; height: number }): [number, number] {
  return [screen.width / GUI_VIRTUAL_WIDTH, screen.height / GUI_VIRTUAL_HEIGHT];
}

/** Colour of a text widget in a given state (engine: Disabled -> p30, Focused -> p31, else p29). */
export function textColor(w: TextWidget, state: GuiStateValue): number {
  return state === GuiState.Disabled ? w.colors.disabled : state === GuiState.Focused ? w.colors.focused : w.colors.normal;
}
