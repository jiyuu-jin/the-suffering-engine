// MenuFlow: boot sequence and menu <-> game transitions, following the game's
// own front-end definitions (docs/frontend.md §4-6):
//
//   game data available
//     -> click-to-start gate (engine addition: browsers need a user gesture for audio)
//     -> ONE opening logo reel, picked at random (skippable)
//     -> copyright screen (~5 s, while the menu assets finish loading)
//     -> main menu over the background videos, with the menu ambience
//        (after `idleSeconds` without input the attract movie plays)
//   New Game -> difficulty (cross-fade) -> transition video -> loading screen -> level
//   In game: Esc (or losing pointer lock, or gamepad Start) -> pause menu
//   Pause: Resume / Save / Load / Revert to checkpoint / Options / Archives / Quit
//   In game, without the pause menu: GUI Launcher alerts / credits / Game Finished, the
//   Archives / Documents keys (src/game/hud/ui-bridge.ts) open their screen over the paused game.
//
// Input bindings (src/game/hud/bindings.ts) are installed here, before the front end's own
// listeners; gameplay input is suspended while any menu (or a full-screen movie) is open.
// Gamepads (src/app/gamepad.ts): Start pauses (or skips a running cinematic, like Esc); losing
// the pad in use during play pauses with the console's "controller removed" string (5:169); the
// Controller page's options and layout are settings (`x.pad*`), the layout mirroring the
// bindings' pad column. Settings apply to the audio buses, the PlayerController (sensitivity,
// pitch, invert), the gamepad options and the renderer (./graphics.ts).
// New Game starts the Prelude level instead of 1a once the game was finished (./profile.ts).
//
// Saves (src/game/save, `saves`): Continue loads the newest save; Load Game / Save Game open
// the LoadSave lists (rows built here from the save store); Revert and the player's death
// restore the last checkpoint (in place when it is in the current level). Save Game is
// disabled while saves.canSave() gives a reason; Continue while no save exists (Load Game stays
// open: its list has the file rows, ./save-files.ts: .json export / import, the original game's
// .rsg saves and Unspeakable.cfg).
//
// `skipIntro` (URL ?skipintro) goes straight to the main menu: no gate, no
// movies, no copyright screen. Audio then starts on the first click/key.

import type { GameFS } from '../gamefs';
import { normalizePath } from '../gamefs';
import type { AudioSystem, Vec3 } from '../audio';
import { loadMenuAssets, type MenuAssets } from './assets';
import { MenuAmbience } from './ambience';
import { FrontEnd } from './frontend';
import { GamepadNav } from './input';
import { PROVISIONAL_MODEL, confirmScreen, type Label, type MenuAction, type MenuItem, type MenuModel, type MenuScreen, type VideoRef } from './model';
import { saves } from '../../game/save/manager';
import type { SaveData, SaveSummary } from '../../game/save/types';
import { applySettings, loadSettings, saveSettings, type Settings } from './settings';
import { ignorePlayerOverride } from '../../game/port-options';
import type { FrontEndVideos } from './videos';
import { GRAPHICS_DEFAULTS, applyGraphics, resetGraphics, type GraphicsView } from './graphics';
import { profile } from './profile';
import { ArchivesScreen } from './screens/archives';
import { MapScreen } from './screens/map';
import { campaign } from '../../game/campaign/state';
import { INTERFACE_PKG } from '../../formats/gui';
import { CreditsScreen } from './screens/credits';
import { KeyboardScreen } from './screens/keyboard';
import { input, type PadPlayer } from '../../game/hud/bindings';
import { uiBridge } from '../../game/hud/ui-bridge';
import { padButtonName, pads } from '../gamepad';
import { CutscenePlayer } from '../cutscene';
import { CALIBRATE_SCREEN, CalibrationScreen, PAD_SETTING_DEFAULTS } from './screens/controller';
import { pickJson, pickOriginal, readOriginalFiles, saveToDisk, type PickedFile } from './save-files';
import { applyOriginalProfile, buildOriginalProfile } from './original-profile';
import { bundleFileName, makeBundle, parseBundle } from '../../game/save/transfer';

export interface MenuFlowHost {
  fs: GameFS;
  audio: AudioSystem;
  /** Objects with a `sensitivity` field to keep in sync with the setting (PlayerController first). */
  look: { sensitivity: number; pitchScale?: number; invertY?: boolean }[];
  /** Renderer for the graphics options (optional: without it only gamma applies). */
  view?: GraphicsView;
  /** Loads a level; resolves true on success. Progress messages go to `progress`. `restore`: apply a save after loading. */
  startLevel(path: string, spawnName: string | undefined, progress: (msg: string) => void, restore?: SaveData): Promise<boolean>;
  /** Restarts the current level's game systems in place and applies a save of it (no reload). */
  restartLevel?(restore: SaveData): Promise<boolean>;
  /** Unloads/stops the running level (systems, emitters, pointer lock). */
  leaveLevel(): void;
  setPaused(paused: boolean): void;
  /** Leave the menu flow for the developer level viewer (optionally opening the procedural scene). */
  enterDevViewer(demo: boolean): void;
  /** Element to pointer-lock when resuming. */
  lockTarget: HTMLElement;
  /** Listener (camera) position for positional menu ambience. */
  listenerPosition(): Vec3;
  toast(msg: string, ms?: number): void;
}

export class MenuFlow {
  readonly settings: Settings = loadSettings();
  readonly frontend: FrontEnd;
  private assets?: MenuAssets;
  private videos?: FrontEndVideos;
  private assetsReady?: Promise<MenuAssets | undefined>;
  private ambience?: MenuAmbience;
  private _inGame = false;
  private paused = false;
  private busy = false;
  private currentLevel?: { path: string; spawnName?: string };
  /** Set while we release pointer lock ourselves (so it doesn't open the pause menu). */
  private ownUnlock = false;
  private readonly pad = new GamepadNav();
  private lastFrame = performance.now();
  /** Cached save list (newest first), refreshed whenever the store changes. */
  private saveList: SaveSummary[] = [];
  /** The map screen (filled by uiBridge.map). */
  private readonly mapScreen = new MapScreen();
  /** Screen opened over the paused game without the pause menu (alerts, archives...). */
  private overlay: { resolve?: (button: number) => void } | null = null;

  constructor(
    private readonly host: MenuFlowHost,
    readonly model: MenuModel = PROVISIONAL_MODEL,
  ) {
    // Bindings first: their capture listeners must run before the front end's and the game's.
    input.install();
    // Also while a modal movie plays over the game (Movie Player): it takes the pad itself.
    input.suspended = () => this.frontend.visible || !this._inGame || this.paused || CutscenePlayer.modal > 0;
    input.attachPlayer(host.look.find((l): l is typeof l & PadPlayer => 'setVirtualInput' in l));
    input.onPress('archives', () => this.openOverlay('archives'));
    input.onPress('documents', () => this.openOverlay('archives'));
    // Controller page options: defaults, and the layout row mirrors the bindings' pad layout.
    // The look defaults became the original's (linear, no Auto Targeting / Auto Pitch:
    // docs/re/player.md §12); values seeded from the earlier defaults are reset once.
    if (this.settings.extra.padLookRev !== 1) {
      for (const k of ['padCurve', 'padAimAssist', 'padAutoPitch']) delete this.settings.extra[k];
      this.settings.extra.padLookRev = 1;
    }
    for (const [k, v] of Object.entries(PAD_SETTING_DEFAULTS)) if (typeof this.settings.extra[k] !== typeof v) this.settings.extra[k] = v;
    this.settings.extra.padLayout = input.padLayout;
    input.onChange(() => {
      if (this.settings.extra.padLayout === input.padLayout) return;
      this.settings.extra.padLayout = input.padLayout;
      saveSettings(this.settings);
    });
    this.installPads();
    // `?ignorePlayer=1` / `=0` (testing): the port option for this page load, over the saved value.
    const ignore = ignorePlayerOverride();
    if (ignore !== undefined) this.settings.extra.ignorePlayer = ignore;
    applySettings(this.settings, { audio: host.audio, look: host.look });
    applyGraphics(this.settings, host.view);
    this.frontend = new FrontEnd(model, host.audio, this.settings, {
      action: (a) => void this.onAction(a),
      settingsChanged: (s, save) => {
        applySettings(s, { audio: host.audio, look: host.look });
        applyGraphics(s, host.view);
        if (save) saveSettings(s);
      },
    });
    this.attachScreens();
    this.installBridge();
    if (model.mainMenu.ambience) this.ambience = new MenuAmbience(host.audio, model.mainMenu.ambience, () => host.listenerPosition());
    // Gameplay option "Checkpoints" (Off / Prompt / On): On unless the player changed it.
    if (typeof this.settings.extra.checkpoints !== 'number') this.settings.extra.checkpoints = 2;
    // Graphics rows show the values the renderer uses.
    for (const [k, v] of Object.entries(GRAPHICS_DEFAULTS)) if (typeof this.settings.extra[k] !== 'number') this.settings.extra[k] = v;
    saves.persist = true;
    saves.host = {
      restore: (d) => this.restoreSave(d),
      label: (ref) => {
        // Chapter Properties refs resolve to the chapter title.
        const ch = this.model.chapters?.list.find((c) => c.template === ref);
        if (ch) return this.label(ch.name) || undefined;
        const [pkg, id] = ref.split(':').map(Number);
        const t = this.assets?.label({ str: { pkg, id }, fallback: '' });
        return t || undefined;
      },
      checkpointsMode: () => Number(this.settings.extra.checkpoints ?? 2),
    };
    saves.onChange = () => void this.refreshSaves();
  }

  get inGame(): boolean {
    return this._inGame;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Package id of the mounted interface sound bank (kept mounted across levels). */
  get interfacePkg(): number | undefined {
    return this.assets?.pkg;
  }

  private loadAssets(): Promise<MenuAssets | undefined> {
    this.assetsReady ??= (async () => {
      try {
        const a = await loadMenuAssets(this.host.fs, this.host.audio, this.model);
        this.assets = a;
        this.frontend.setAssets(a);
        await this.refreshSaves();
        try {
          // Loaded lazily; the menus still work without it. Movie sound follows the master and
          // music bus levels (live gain values, so mute/fades apply too).
          const { FrontEndVideos } = await import('./videos');
          const au = this.host.audio;
          const mixer = () => au.busNode('master').gain.value * au.busNode('music').gain.value;
          this.videos = new FrontEndVideos(this.host.fs, au.context, this.frontend.bgLayer, a.uiFont, mixer);
        } catch (err) {
          console.error('[menu] video playback unavailable:', err);
        }
        return a;
      } catch (err) {
        console.error('[menu] interface assets failed to load:', err);
        this.host.toast(`Menu data unavailable: ${(err as Error).message}`, 5000);
        return undefined;
      }
    })();
    return this.assetsReady;
  }

  /** Runs the boot sequence up to the main menu. */
  async boot(opts: { skipIntro?: boolean } = {}): Promise<void> {
    if (opts.skipIntro) {
      this.frontend.showBlank();
      await this.loadAssets();
      this.mainMenu();
      return;
    }
    const gate = this.frontend.showGate();
    this.frontend.setGateReady(false);
    const assets = await this.loadAssets();
    this.frontend.setGateReady(true);
    await gate;
    // resume() stays pending without a real user gesture (e.g. synthetic events): don't block on it.
    await Promise.race([this.host.audio.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
    // Browsers do not count gamepad buttons as a user gesture: started from a pad, sound waits
    // for the first click or key press (main.ts resumes the context on either).
    if (pads.usingPad && this.host.audio.context.state !== 'running') this.host.toast('Sound starts after one mouse click or key press (browsers do not let a gamepad start audio)', 6000);
    const reels = this.model.boot.logoReels;
    if (assets && this.videos && reels.length) {
      this.frontend.showBlank();
      const reel = reels[Math.floor(Math.random() * reels.length)];
      for (const ref of reel) {
        const r = await this.videos.playMovie(ref);
        if (r === 'skipped') break;
      }
    }
    await this.copyright();
    this.mainMenu();
  }

  private async copyright(): Promise<void> {
    const c = this.model.boot.copyright;
    if (c) await this.frontend.showCopyright(c.seconds);
  }

  /** Shows the main menu over the background video, with the menu ambience. */
  mainMenu(): void {
    this.paused = false;
    this.applySaveFlags();
    this.frontend.openMenu(this.model.mainScreen, this.videos ? 'video' : 'black');
    this.frontend.lastInputAt = performance.now();
    this.videos?.startBackground(this.model.mainMenu.backgrounds);
    this.ambience?.start();
  }

  private leaveMenu(): void {
    this.videos?.stopBackground();
    this.ambience?.stop();
  }

  // -------------------------------------------------------------------------
  // Per frame

  /** Called every frame by the app: gamepad Start in game, attract timer, ambience. */
  update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.ambience?.update(dt);
    if (this._inGame && !this.frontend.visible) {
      // Pad Start pauses; during a cinematic Start / A / B skip it instead (as Esc does).
      const acts = this.pad.poll();
      const skipKey = acts.includes('start') || acts.includes('accept') || acts.includes('back');
      if (CutscenePlayer.modal === 0 && !(skipKey && uiBridge.skipCutscene?.()) && acts.includes('start')) this.pause();
      input.update(dt);
      return;
    }
    input.update(dt);
    // Attract mode: the intro movie after idleSeconds on the main menu's root screen.
    const attract = this.model.mainMenu.attract;
    if (
      attract &&
      !this.busy &&
      this.videos &&
      this.frontend.currentMode === 'menu' &&
      this.frontend.rootScreenId === this.model.mainScreen &&
      this.frontend.stackDepth === 1 &&
      !this._inGame &&
      now - this.frontend.lastInputAt > attract.idleSeconds * 1000 &&
      this.host.audio.context.state === 'running'
    ) {
      void this.playAttract(attract.video);
    }
  }

  /** Gamepad hot-plug: toasts, and a pause when the pad in use drops out during play. */
  private installPads(): void {
    pads.install();
    pads.on('connect', (p) => this.host.toast(`Controller connected: ${p.name}`, 2500));
    pads.on('disconnect', (p) => {
      const playing = this._inGame && !this.frontend.visible && !this.busy;
      if (playing && p.wasActive && pads.usingPad) {
        this.pause();
        // Interface string 5:169 (console "controller removed" notice; UIP 32 / 33).
        const msg = this.label({ str: { pkg: this.interfacePkg ?? 5, id: 169 }, fallback: 'Controller %d was disconnected. Reconnect it and press <GUISelect> to continue.' })
          .replace('%d', String(p.index + 1))
          .replace(/<GUISelect>/g, padButtonName(0, pads.family));
        this.host.toast(msg, 7000);
      } else this.host.toast(`Controller disconnected: ${p.name}`, 2500);
    });
  }

  private async playAttract(ref: VideoRef): Promise<void> {
    this.busy = true;
    this.leaveMenu();
    try {
      await this.videos?.playMovie(ref, { subtitles: this.settings.subtitles });
    } finally {
      this.busy = false;
      this.mainMenu();
    }
  }

  // -------------------------------------------------------------------------
  // In-game

  /** Opens the pause menu (no-op outside a level or when a menu is already open). */
  pause(): void {
    if (!this._inGame || this.frontend.visible) return;
    this.paused = true;
    this.host.setPaused(true);
    if (document.pointerLockElement) {
      this.ownUnlock = true;
      document.exitPointerLock();
    }
    this.applySaveFlags();
    this.frontend.openMenu(this.model.pauseScreen, 'game');
  }

  resume(): void {
    if (!this.paused) return;
    const ov = this.overlay;
    this.overlay = null;
    ov?.resolve?.(-1);
    this.paused = false;
    this.frontend.hide();
    this.host.setPaused(false);
    // Needs a user gesture; browsers also refuse right after Esc released the lock.
    // If it fails, clicking the view locks again.
    try {
      const p = this.host.lockTarget.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* ignored */
    }
  }

  /** Called by the app on pointerlockchange. */
  onPointerLockChange(): void {
    const locked = !!document.pointerLockElement;
    if (this.ownUnlock && !locked) {
      this.ownUnlock = false;
      return;
    }
    if (!locked && this._inGame && !this.frontend.visible) this.pause();
  }

  /** Called by the app on Escape when no menu is open. Returns true if handled. */
  onEscape(): boolean {
    if (!this._inGame || this.frontend.visible) return false;
    this.pause();
    return true;
  }

  // -------------------------------------------------------------------------
  // Actions

  private async onAction(a: MenuAction): Promise<void> {
    if (this.busy) return;
    switch (a.kind) {
      case 'push':
        // Only pushes with a transition video reach the flow.
        await this.transition();
        this.frontend.pushScreen(a.screen);
        if (!this._inGame) this.videos?.startBackground(this.model.mainMenu.backgrounds);
        break;
      case 'newGame':
        if (a.difficulty !== undefined) {
          this.settings.difficulty = a.difficulty;
          saveSettings(this.settings);
        }
        if (a.transition) await this.transition();
        await this.newGame();
        break;
      case 'resume':
        this.resume();
        break;
      case 'quitToMenu':
        this.quitToMenu();
        break;
      case 'quitApp':
        // A browser tab can't exit: return to the copyright screen and the main menu.
        this.leaveMenu();
        await this.copyright();
        this.mainMenu();
        break;
      case 'revertCheckpoint':
        await this.revertCheckpoint();
        break;
      case 'continue':
        await this.continueGame(!!a.transition);
        break;
      case 'openSaves':
        await this.openSaves(a.screen, !!a.transition);
        break;
      case 'loadSave':
        await this.loadSave(a.id, !!a.confirmed);
        break;
      case 'saveTo':
        await this.saveTo(a.id, !!a.confirmed);
        break;
      case 'deleteSave':
        await this.deleteSave(a.id, !!a.confirmed);
        break;
      case 'exportSave':
      case 'exportSaves':
        await this.exportSaves(a.kind === 'exportSave' ? a.id : undefined);
        break;
      case 'importSaves':
        await this.importSaves();
        break;
      case 'importOriginal':
        await this.importOriginal(a.from);
        break;
      case 'exportOriginalSettings':
        await this.exportOriginalSettings();
        break;
      case 'graphicsDefaults':
        // Applied live; the page's Accept keeps it, Cancel restores the snapshot.
        resetGraphics(this.settings);
        applyGraphics(this.settings, this.host.view);
        this.frontend.sound('value');
        break;
      case 'bindingsDefaults':
        if (!a.confirmed) {
          this.confirm('confirmBindingsDefaults', this.model.keyboard?.strings.resetConfirm, 'Reset all keys to their defaults?', { kind: 'bindingsDefaults', confirmed: true });
          if (this.model.alerts?.yesNo) this.model.screens.confirmBindingsDefaults.alert = this.model.alerts.yesNo;
        } else {
          input.resetDefaults();
          this.frontend.popScreen();
        }
        break;
      case 'gameFinished':
        this.finishGame(a.save);
        break;
      case 'closeAlert': {
        const ov = this.overlay;
        this.overlay = null;
        this.resumeFromOverlay();
        ov?.resolve?.(a.index);
        break;
      }
      case 'devViewer':
      case 'devDemo':
        this.leaveMenu();
        this.frontend.hide();
        this._inGame = false;
        this.host.enterDevViewer(a.kind === 'devDemo');
        break;
    }
  }

  /** Plays a random menu transition clip in the background layer (items hidden). */
  private async transition(): Promise<void> {
    const list = this.model.mainMenu.transitions;
    if (!this.videos || !list.length || this._inGame) return;
    this.busy = true;
    this.frontend.setItemsHidden(true);
    this.frontend.onSkip = () => this.videos?.stopBackground();
    try {
      await this.videos.playTransition(list[Math.floor(Math.random() * list.length)]);
    } finally {
      this.frontend.setItemsHidden(false);
      this.frontend.onSkip = undefined;
      this.busy = false;
    }
  }

  private async resolveNewGameLevel(): Promise<string | undefined> {
    // Once the game was finished, New Game starts the Prelude (Main Menu p18; engine flag 0x400).
    const prelude = profile.preludeUnlocked ? this.model.preludeLevel : undefined;
    if (prelude && this.assets) {
      const p = await this.host.fs.resolve(normalizePath(this.assets.label(prelude)));
      if (p) return p;
    }
    const l = this.model.newGame.level;
    const candidates = [this.assets ? this.assets.label(l) : '', 'text' in l ? l.text : l.fallback].filter(Boolean);
    for (const c of candidates) {
      const p = await this.host.fs.resolve(normalizePath(c));
      if (p) return p;
    }
    return undefined;
  }

  async newGame(): Promise<void> {
    this.leaveMenu();
    saves.newGame(this.settings.difficulty);
    saves.session.chapter = this.model.chapters?.newGame;
    const path = await this.resolveNewGameLevel();
    if (!path) {
      this.host.toast('Could not find the first level in the game data', 5000);
      this.mainMenu();
      return;
    }
    await this.load(path, this.model.newGame.spawnName, 'newGame');
  }

  private async load(path: string, spawnName: string | undefined, variant: 'newGame' | 'default', restore?: SaveData, tiles?: (number | undefined)[]): Promise<void> {
    if (document.pointerLockElement) {
      this.ownUnlock = true;
      document.exitPointerLock();
    }
    this.busy = true;
    this.paused = false;
    this.host.setPaused(false);
    this.frontend.showLoading(variant, tiles);
    let ok = false;
    try {
      ok = await this.host.startLevel(path, spawnName, (m) => this.frontend.setLoadingMessage(m), restore);
    } finally {
      this.busy = false;
    }
    if (!ok) {
      this.host.toast('Failed to load the level', 5000);
      this._inGame = false;
      this.mainMenu();
      return;
    }
    this.currentLevel = { path, spawnName };
    this._inGame = true;
    this.frontend.hide();
  }

  /**
   * Level-to-level transition while playing. The loading screen is the current chapter's
   * Progress GUI (Chapter Properties p1 -> p18 Screen Background; RFL 0x100c2849): the newest
   * chapter reached (services.campaign.chapter, updated by the transition just taken), else
   * the default loading screen (UIP 39).
   */
  async travel(path: string, spawnName?: string): Promise<void> {
    // The campaign system's transition subscriber may run after the request: let it.
    await Promise.resolve();
    const tiles = await this.chapterTiles();
    await this.load(path, spawnName, 'default', undefined, tiles);
  }

  /** The current chapter's loading-screen tiles (Interface textures), loaded; undefined = none. */
  private async chapterTiles(): Promise<(number | undefined)[] | undefined> {
    const keys = campaign.chapter?.tiles ?? [];
    const pkg = INTERFACE_PKG;
    const ids = keys.map((k) => {
      const [p, id] = (k ?? '').split(':').map(Number);
      return k && p === pkg ? id : undefined;
    });
    const want = ids.filter((x): x is number => x !== undefined);
    if (!want.length || !this.assets) return undefined;
    try {
      await this.assets.loadImages(want);
    } catch {
      return undefined;
    }
    return ids;
  }

  /** Revert to the last checkpoint (falls back to restarting the level if there is none). */
  private async revertCheckpoint(): Promise<void> {
    if (saves.checkpoint) {
      await this.restoreSave(saves.checkpoint);
      return;
    }
    const cur = this.currentLevel;
    if (!cur) return;
    this.host.leaveLevel();
    await this.load(cur.path, cur.spawnName, 'default');
  }

  // -------------------------------------------------------------------------
  // Saves

  private async refreshSaves(): Promise<void> {
    this.saveList = await saves.list();
    this.applySaveFlags();
    for (const sc of Object.values(this.model.screens)) if (sc.layout === 'saves' && sc.saves) sc.items = this.saveRows(sc);
    this.frontend.refresh();
  }

  /** Continue / Load (no saves) and Save Game (saves.canSave()) enabled states. */
  private applySaveFlags(): void {
    const none = !this.saveList.some((s) => !s.damaged);
    const cannot = !this._inGame || saves.canSave() !== null;
    for (const sc of Object.values(this.model.screens)) {
      for (const it of sc.items) {
        if (it.type !== 'button' || !it.disabledWhen) continue;
        // Load Game stays open without saves (port: its list has the import rows, the way to
        // bring saves in); Continue needs one.
        it.disabled = it.disabledWhen === 'noSaves' ? none && it.action.kind !== 'openSaves' : cannot;
      }
    }
  }

  private label(l: Label | undefined, fallback = ''): string {
    if (!l) return fallback;
    return (this.assets ? this.assets.label(l) : 'text' in l ? l.text : l.fallback) || fallback;
  }

  /** Rows of a Load / Save list. */
  private saveRows(sc: MenuScreen): MenuItem[] {
    const spec = sc.saves!;
    const rows: MenuItem[] = [];
    if (spec.mode === 'save') {
      const newLabel: Label = spec.strings.newSave ?? { text: 'New save' };
      rows.push({ type: 'button', label: newLabel, action: { kind: 'saveTo' }, save: { id: '', title: '', detail: '', date: '', isNew: true } });
    }
    for (const s of this.saveList) {
      if (spec.mode === 'save' && s.kind === 'auto') continue; // the autosave slot is written by checkpoints only
      const mins = Math.floor(s.playtime / 60);
      const time = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
      const detail = s.damaged ? '' : [s.levelName !== s.title ? s.levelName : '', s.kind === 'auto' ? 'Checkpoint' : '', time].filter(Boolean).join('  ·  ');
      const date = s.createdAt ? new Date(s.createdAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      rows.push({
        type: 'button',
        label: { text: s.title || s.levelName },
        action: spec.mode === 'load' ? { kind: 'loadSave', id: s.id } : { kind: 'saveTo', id: s.id },
        save: { id: s.id, title: s.title || s.levelName, detail, date, thumbnail: s.thumbnail, damaged: s.damaged },
        deleteAction: { kind: 'deleteSave', id: s.id },
        exportAction: s.damaged ? undefined : { kind: 'exportSave', id: s.id },
      });
    }
    // File rows (engine wording: the game's LoadSave GUI has no file items): import / export
    // on the player's disk, and the original game's saves and profile (save-files.ts).
    const tool = (text: string, action: MenuAction, disabled = false): MenuItem => ({ type: 'button', label: { text }, action, disabled, save: { id: '', title: text, detail: '', date: '', tool: true } });
    const any = this.saveList.some((x) => !x.damaged);
    if (spec.mode === 'load') {
      rows.push(tool('Import saves from a file…', { kind: 'importSaves' }));
      rows.push(tool('Import from the original game (folder)…', { kind: 'importOriginal', from: 'folder' }));
      rows.push(tool('Import original files (.rsg, Unspeakable.cfg)…', { kind: 'importOriginal', from: 'files' }));
    }
    rows.push(tool('Export all saves to a file…', { kind: 'exportSaves' }, !any));
    if (spec.mode === 'save') rows.push(tool('Export settings as Unspeakable.cfg…', { kind: 'exportOriginalSettings' }));
    return rows;
  }

  private async openSaves(screen: string, transition: boolean): Promise<void> {
    await this.refreshSaves();
    if (transition) await this.transition();
    this.frontend.pushScreen(screen);
    if (!this._inGame) this.videos?.startBackground(this.model.mainMenu.backgrounds);
  }

  /** A Yes/No alert (game strings) that runs `yes` (screen id reused per kind). */
  private confirm(id: string, message: Label | undefined, fallback: string, yes: MenuAction): void {
    this.model.screens[id] = confirmScreen(id, message ?? { text: fallback }, yes, {
      yes: { str: { pkg: 5, id: 31 }, fallback: 'Yes' },
      no: { str: { pkg: 5, id: 32 }, fallback: 'No' },
    });
    this.model.screens[id].alert = this.model.alerts?.yesNo;
    this.frontend.pushScreen(id);
  }

  private specOf(mode: 'load' | 'save') {
    return Object.values(this.model.screens).find((sc) => sc.saves?.mode === mode)?.saves;
  }

  private async continueGame(transition: boolean): Promise<void> {
    const s = (await saves.newest()) ?? undefined;
    if (!s) return;
    if (transition) await this.transition();
    await this.loadSave(s.id, true);
  }

  private async loadSave(id: string, confirmed: boolean): Promise<void> {
    const strings = this.specOf('load')?.strings ?? {};
    // In game the current progress is lost: ask first (LoadSave p47).
    if (this._inGame && !confirmed) {
      this.confirm('confirmLoadSave', strings.loadConfirm, 'Load this game?', { kind: 'loadSave', id, confirmed: true });
      return;
    }
    const data = await saves.get(id);
    if (!data) {
      this.host.toast(this.label(strings.loadFailed, 'Load failed'), 3000);
      if (this._inGame) this.frontend.popScreen();
      return;
    }
    this.settings.difficulty = data.difficulty;
    await this.restoreSave(data);
  }

  private async saveTo(id: string | undefined, confirmed: boolean): Promise<void> {
    const strings = this.specOf('save')?.strings ?? {};
    if (id && !confirmed) {
      this.confirm('confirmOverwrite', strings.overwriteConfirm, 'Overwrite this save?', { kind: 'saveTo', id, confirmed: true });
      return;
    }
    const why = saves.canSave();
    const data = why ? null : await saves.saveManual(id);
    await this.refreshSaves();
    this.host.toast(this.label(data ? strings.saved : strings.saveFailed, data ? 'Saved' : 'Save failed'), 2200);
    // Back to the pause menu.
    this.frontend.popTo(this.model.pauseScreen);
  }

  private async deleteSave(id: string, confirmed: boolean): Promise<void> {
    if (!confirmed) {
      const strings = this.specOf('load')?.strings ?? {};
      this.confirm('confirmDeleteSave', strings.deleteConfirm, 'Delete this save?', { kind: 'deleteSave', id, confirmed: true });
      return;
    }
    await saves.delete(id);
    if (saves.checkpoint?.id === id) saves.checkpoint = null;
    this.frontend.popScreen();
    await this.refreshSaves();
  }

  // -------------------------------------------------------------------------
  // Save files on the player's disk (save-files.ts; what an original save carries over:
  // src/game/save/transfer.ts, docs/re/saves.md §8)

  /** One save (`id`) or every save to a .json bundle. */
  private async exportSaves(id?: string): Promise<void> {
    const list = id ? [await saves.get(id)].filter((d): d is SaveData => !!d) : await saves.exportAll();
    if (!list.length) return this.host.toast('No saves to export', 2500);
    const ok = await saveToDisk(bundleFileName(list), new Blob([JSON.stringify(makeBundle(list))], { type: 'application/json' }), { description: 'Saved games', mime: 'application/json', ext: '.json' });
    if (ok) this.host.toast(`Exported ${list.length} save${list.length === 1 ? '' : 's'}`, 2500);
  }

  /** .json export files back into the list (same saves skipped, taken ids renamed). */
  private async importSaves(): Promise<void> {
    const files = await pickJson();
    if (files.length) await this.importSaveFiles(files);
  }

  /** (The picked files; tools/save-matrix.mjs --menus calls it with synthetic ones.) */
  async importSaveFiles(files: readonly PickedFile[]): Promise<{ added: number; skipped: number; rejected: number; bad: number }> {
    let added = 0, skipped = 0, rejected = 0, bad = 0;
    for (const f of files) {
      const b = parseBundle(new TextDecoder().decode(await f.bytes()));
      if (b.error) bad++;
      rejected += b.rejected;
      const r = await saves.importSaves(b.saves);
      added += r.added;
      skipped += r.skipped;
      rejected += r.failed;
    }
    await this.refreshSaves();
    const parts = [`Imported ${added} save${added === 1 ? '' : 's'}`, skipped ? `${skipped} already there` : '', rejected ? `${rejected} unusable` : '', bad ? `${bad} file${bad === 1 ? '' : 's'} not a save export` : ''];
    this.host.toast(parts.filter(Boolean).join(', '), 4000);
    return { added, skipped, rejected, bad };
  }

  /** The original game's .rsg saves (as level-start saves) and Unspeakable.cfg (options, unlocks). */
  private async importOriginal(from: 'folder' | 'files'): Promise<void> {
    const files = await pickOriginal(from);
    if (!files.length) return this.host.toast('No .rsg or Unspeakable.cfg found there', 3500);
    await this.importOriginalFiles(files);
  }

  /** (The picked files; tools/save-matrix.mjs --menus calls it with synthetic ones.) */
  async importOriginalFiles(files: readonly PickedFile[]): Promise<{ added: number; skipped: number; settings: boolean; unknown: number; errors: string[] }> {
    const fs = this.host.fs;
    // The header's level path is the engine's (backslashes, maybe a drive or the install path
    // in front): matched from its LEVELS folder on.
    const resolveLevel = async (p: string) => {
      const n = normalizePath(p);
      const i = n.toLowerCase().lastIndexOf('levels/');
      for (const c of [n, i >= 0 ? n.slice(i) : '']) if (c) {
        const r = await fs.resolve(c).catch(() => undefined);
        if (r) return r;
      }
      return undefined;
    };
    const r = await readOriginalFiles(files, resolveLevel, this.settings.difficulty);
    const res = r.saves.length ? await saves.importSaves(r.saves) : { added: 0, skipped: 0, failed: 0 };
    let prof = '';
    if (r.settings) {
      const a = applyOriginalProfile(r.settings, this.settings, this.model.archives);
      applySettings(this.settings, { audio: this.host.audio, look: this.host.look });
      saveSettings(this.settings);
      prof = `options${a.pages ? `, ${a.pages} Archive page${a.pages === 1 ? '' : 's'}` : ''}${a.finished ? ', the Prelude unlock' : ''} from Unspeakable.cfg`;
    }
    await this.refreshSaves();
    for (const e of r.errors) console.warn('[saves] original import:', e);
    const parts = [
      res.added || !prof ? `Imported ${res.added} original save${res.added === 1 ? '' : 's'} (each starts at its level's start)` : '',
      res.skipped ? `${res.skipped} already there` : '',
      prof,
      r.unknownLevels.length ? `${r.unknownLevels.length} of an unknown level` : '',
      r.errors.length ? `${r.errors.length} unreadable` : '',
    ];
    this.host.toast(parts.filter(Boolean).join('; '), 6000);
    return { added: res.added, skipped: res.skipped, settings: !!r.settings, unknown: r.unknownLevels.length, errors: r.errors };
  }

  /** The settings and unlocks as an Unspeakable.cfg for the original game. */
  private async exportOriginalSettings(): Promise<void> {
    const r = await buildOriginalProfile(this.settings, this.model.archives, this.host.fs);
    const ok = await saveToDisk('Unspeakable.cfg', new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), { description: 'The Suffering profile', mime: 'application/octet-stream', ext: '.cfg' });
    if (ok) this.host.toast(r.base === 'imported' ? 'Exported Unspeakable.cfg (key bindings from the imported one)' : `Exported Unspeakable.cfg (default keys${r.bindings ? '' : ': none found, import your own Unspeakable.cfg first'})`, 4500);
  }

  /** Load a save: in place when it is in the running level, else through the loading screen. */
  async restoreSave(data: SaveData): Promise<boolean> {
    if (this.busy) return false;
    if (this._inGame && this.currentLevel?.path === data.levelPath && this.host.restartLevel) {
      this.busy = true;
      let ok = false;
      try {
        ok = await this.host.restartLevel(data);
      } finally {
        this.busy = false;
      }
      if (ok) {
        if (this.frontend.visible) {
          this.frontend.hide();
          this.paused = false;
          this.host.setPaused(false);
          try {
            const p = this.host.lockTarget.requestPointerLock?.() as unknown as Promise<void> | undefined;
            p?.catch?.(() => undefined);
          } catch {
            /* ignored */
          }
        }
        return true;
      }
    }
    this.leaveMenu();
    if (this._inGame) this.host.leaveLevel();
    await this.load(data.levelPath, data.spawnName, 'default', data);
    return this._inGame;
  }

  // -------------------------------------------------------------------------
  // Custom screens, overlays over the game, Game Finished

  /** Attaches the custom screen objects (archives viewer, credits roll, keyboard page). */
  private attachScreens(): void {
    const m = this.model;
    if (m.archives && m.screens.archives) {
      m.screens.archives.custom = new ArchivesScreen(m.archives, {
        audio: this.host.audio,
        playClip: async (ref) => {
          if (!this.videos) return;
          this.frontend.showVideoLayer(true);
          try {
            await this.videos.playTransition(ref);
          } finally {
            this.frontend.showVideoLayer(false);
            // Back on the main menu the looping background resumes under the archives.
            if (!this._inGame) this.videos.startBackground(m.mainMenu.backgrounds);
          }
        },
        arrows: { left: m.images.arrowLeft, right: m.images.arrowRight },
      });
    }
    if (m.credits && m.screens.credits) {
      m.screens.credits.custom = new CreditsScreen(m.credits, {
        fs: this.host.fs,
        base: m.interfacePackage,
        startVideo: () => {
          if (!m.credits?.video || !this.videos) return;
          this.frontend.showVideoLayer(true);
          void this.videos.playLoop(m.credits.video);
        },
        stopVideo: () => {
          this.videos?.stopLoop();
          this.frontend.showVideoLayer(false);
          if (!this._inGame && this.frontend.rootScreenId === m.mainScreen) this.videos?.startBackground(m.mainMenu.backgrounds);
        },
      });
    }
    if (m.keyboard && m.screens['page.keyboard']) m.screens['page.keyboard'].custom = new KeyboardScreen(m.keyboard);
    if (m.screens[CALIBRATE_SCREEN]) m.screens[CALIBRATE_SCREEN].custom = new CalibrationScreen();
  }

  /** Fills the game-to-menu bridge (GUI Launcher, archives keys, death). */
  private installBridge(): void {
    uiBridge.alert = (box, text) => this.openAlert(box, text);
    uiBridge.credits = () =>
      new Promise<void>((resolve) => {
        if (!this.model.screens.credits) return resolve();
        this.openOverlay('credits', () => resolve());
      });
    uiBridge.gameFinished = () => this.openGameFinished();
    uiBridge.archives = () => this.openOverlay('archives');
    uiBridge.map = (data) => {
      // Map screen (UIP 18, Map GUI #200) over the paused game; the Map key closes it too.
      this.mapScreen.data = data;
      this.mapScreen.closeCodes = input.current.keys.map.filter(Boolean);
      this.model.screens.map ??= { id: 'map', layout: 'list', items: [], custom: this.mapScreen };
      return this.openOverlay('map');
    };
    uiBridge.revert = () => void this.revertCheckpoint();
    uiBridge.label = (ref) => {
      const [pkg, id] = ref.split(':').map(Number);
      return this.assets?.label({ str: { pkg, id }, fallback: '' }) || undefined;
    };
  }

  /** Pauses the game and opens `screenId` as the only screen (closing it resumes). */
  private openOverlay(screenId: string, onClose?: (button: number) => void): boolean {
    if (!this._inGame || this.frontend.visible || this.busy || !this.model.screens[screenId]) return false;
    this.paused = true;
    this.host.setPaused(true);
    if (document.pointerLockElement) {
      this.ownUnlock = true;
      document.exitPointerLock();
    }
    this.overlay = { resolve: onClose };
    this.frontend.openMenu(screenId, 'game');
    return true;
  }

  private resumeFromOverlay(): void {
    this.paused = true; // resume() requires it
    this.resume();
  }

  /** GUI Launcher alert: the Alert Box template `box` with `text`, over the paused game. */
  private openAlert(box: string | undefined, text: string): Promise<number> {
    const spec = (box && this.model.alerts?.byRef[box]) || this.model.alerts?.ok;
    const buttons = spec?.buttons.length ? spec.buttons : [{ str: { pkg: 5, id: 33 }, fallback: 'OK' } as Label];
    const id = 'launcherAlert';
    this.model.screens[id] = {
      id,
      layout: 'list',
      font: 'title',
      dialog: true,
      message: { text },
      alert: spec,
      defaultFocus: spec?.defaultButton ?? 0,
      items: buttons.map((label, index) => ({ type: 'button' as const, label, action: { kind: 'closeAlert' as const, index }, group: 'alert' })),
    };
    return new Promise((resolve) => {
      if (!this.openOverlay(id, resolve)) resolve(-1);
    });
  }

  /** All archive page refs (finishing the game unlocks the archive pages [guess: all]). */
  private allArchivePages(): string[] {
    return (this.model.archives?.sets ?? []).flatMap((s) => s.pages.map((p) => p.ref));
  }

  /** Game Finished (UIP 19): leaves the level and shows the unlock notice. */
  private openGameFinished(): void {
    if (!this.model.screens.gameFinished) {
      profile.setGameFinished(this.allArchivePages());
      this.quitToMenu();
      return;
    }
    if (document.pointerLockElement) {
      this.ownUnlock = true;
      document.exitPointerLock();
    }
    this._inGame = false;
    this.paused = false;
    this.currentLevel = undefined;
    this.host.setPaused(false);
    this.host.leaveLevel();
    this.frontend.openMenu('gameFinished', 'black');
  }

  private finishGame(save: boolean): void {
    // "Save settings" keeps the unlocks; "Don't save" (after its confirmation) drops them, as
    // the original only kept them in the settings file it was about to write.
    if (save) profile.setGameFinished(this.allArchivePages());
    // The original's Game Finished screen rolls the credits after Save / Don't Save.
    // The level is gone here, so the in-game overlay (openOverlay needs a level) cannot show
    // them: the credits go over the main menu, which closing them returns to.
    this.mainMenu();
    if (this.model.screens.credits) this.frontend.pushScreen('credits');
  }

  quitToMenu(): void {
    this._inGame = false;
    this.paused = false;
    this.currentLevel = undefined;
    if (document.pointerLockElement) {
      this.ownUnlock = true;
      document.exitPointerLock();
    }
    this.host.setPaused(false);
    this.host.leaveLevel();
    this.mainMenu();
  }

  /** Returns from the developer viewer to the main menu. */
  backToMenu(): void {
    this._inGame = false;
    this.host.leaveLevel();
    void this.loadAssets().then(() => this.mainMenu());
  }
}
