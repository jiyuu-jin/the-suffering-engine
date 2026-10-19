import { DevServerFS, LocalFolderFS, type GameFS } from './gamefs';
import { DEMO_LEVEL_PATH, groupLevels, loadLevel, stem, type LoadedLevel } from './loader';
import { LevelRenderer, type LevelStats } from './renderer';
import { AudioSystem } from './audio';
import { MUSIC_PAUSE_FADE } from './audio-rules';
import { onConvertedMediaMissing } from './media';
import { levelSoundEmitters } from '../formats/sound';
import { parseLevelObjects } from '../formats/level';
import { startSystems, type GameSystem } from '../game/runtime';
import { systemFactories } from '../game/systems';
import { MenuFlow } from './menu/flow';
import { buildMenuModel } from './menu/gui-adapter';
import { saves, type LevelEntry } from '../game/save/manager';
import { openSaveStore } from '../game/save/store';
import type { SaveData } from '../game/save/types';
import { attachAudioRumble, pads } from './gamepad';
import { input } from '../game/hud/bindings';
import { frameProbe } from './frame-probe';

// URL flags:
//   ?level=<path>  dev deep link: open that level directly in the developer viewer (no menus)
//   ?demo          open the procedural test scene in the developer viewer
//   ?dev           developer viewer (level sidebar) without menus
//   ?skipintro     menu flow without the start gate, logo/intro movies and title screen
// Without any of these the game boots into the front end (gate -> movies -> title -> main menu).
const params = new URLSearchParams(location.search);
const menuMode = !params.has('level') && !params.has('demo') && !params.has('dev');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  app: $('app'),
  viewport: $('viewport'),
  levels: $('levels'),
  sourceLabel: $('source-label'),
  changeFolder: $<HTMLButtonElement>('change-folder'),
  sidebarToggle: $<HTMLButtonElement>('sidebar-toggle'),
  stats: $('stats'),
  levelInfo: $('level-info'),
  hint: $('hint'),
  toast: $('toast'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  picker: $('picker'),
  pickFolder: $<HTMLButtonElement>('pick-folder'),
  folderInput: $<HTMLInputElement>('folder-input'),
  pickerError: $('picker-error'),
  pickDemo: $<HTMLButtonElement>('pick-demo'),
  toMenu: $<HTMLButtonElement>('to-menu'),
};

let fs: GameFS | null = null;
let view: LevelRenderer;
let currentPath: string | null = null;
/** The loaded level data of currentPath (kept for in-place restarts: revert to checkpoint). */
let currentLoaded: LoadedLevel | null = null;
let loadToken = 0;
const audio = new AudioSystem();
// Cutscenes and sound need `npm run bake`; without it the app runs silent (told once).
onConvertedMediaMissing((msg) => toast(msg, 8000));
/** Package ids whose .sdu is currently mounted. */
let mountedSounds = new Set<number>();
let systems: GameSystem[] = [];
/** Front end (menus); null in developer-viewer mode until the game data is known. */
let flow: MenuFlow | null = null;
/** While set, loader progress goes to the menu loading screen instead of #loading. */
let loadingSink: ((msg: string) => void) | null = null;
/** Pause menu open: game systems are not updated. */
let gamePaused = false;

async function main() {
  try {
    view = await LevelRenderer.create(ui.viewport);
  } catch (err) {
    showFatal(`Could not initialise WebGPU or WebGL2: ${(err as Error).message}`);
    return;
  }
  wireUi();
  startStats();
  // Saves (src/game/save): thumbnails from the game view; storage opens in the background.
  saves.attachView(view);
  saves.host = { restore: (d) => restoreSave(d) };
  void openSaveStore().then((s) => {
    saves.store = s;
    saves.onChange?.();
  });
  // Browsers only start audio after a user gesture.
  const unlock = () => void audio.resume();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  view.onFrame((dt) => {
    if (!gamePaused)
      for (const sys of systems) {
        sys.update?.(dt);
        frameProbe.lap(sys.name);
      }
    audio.update(view.camera);
    frameProbe.lap('audio');
    flow?.update();
    frameProbe.lap('menu');
    // Gamepad rumble (the game's curves, started by sounds that reference one): in game only.
    pads.rumbleAllowed = !!flow?.inGame && !gamePaused && !flow.frontend.visible;
    pads.updateRumble();
  });
  attachAudioRumble(audio, {
    active: () => pads.rumbleAllowed,
    read: (path) => (fs ? fs.read(path) : Promise.reject(new Error('no game data'))),
  });
  // Debug/test hooks (headless screenshots, console tinkering).
  Object.assign(window, { __view: view, __player: view.player, __audio: audio, __saves: saves, __pads: pads, __input: input, __frames: frameProbe });

  const dev = await DevServerFS.probe();
  const requested = params.get('level');
  if (menuMode) {
    ui.app.classList.add('menu-flow');
    renderLevelList([]);
    if (dev) {
      await setFS(dev);
      await startMenuFlow();
    } else {
      showPicker();
    }
  } else if (dev) {
    await setFS(dev);
    await openLevel(requested ?? DEMO_LEVEL_PATH);
  } else {
    renderLevelList([]);
    await openLevel(DEMO_LEVEL_PATH);
    if (!new URLSearchParams(location.search).has('demo')) showPicker();
  }
}

// ---------------------------------------------------------------------------
// Front end (menus)

async function startMenuFlow() {
  if (!fs || flow) return;
  flow = new MenuFlow(
    {
      fs,
      audio,
      look: [view.player, view.controls],
      view, // graphics options (src/app/menu/graphics.ts)
      lockTarget: view.renderer.domElement,
      listenerPosition: () => [view.camera.position.x, view.camera.position.y, view.camera.position.z],
      toast,
      startLevel: async (path, spawnName, progress, restore) => {
        loadingSink = progress;
        try {
          // A restored save places the player itself (no spawn point / arrival messages).
          return await openLevel(path, restore ? undefined : spawnName, { updateUrl: false, restore });
        } finally {
          loadingSink = null;
        }
      },
      restartLevel,
      leaveLevel,
      setPaused,
      enterDevViewer: (demo) => {
        setDevTools(true);
        if (demo || !currentPath) void openLevel(DEMO_LEVEL_PATH);
      },
    },
    await buildMenuModel(fs),
  );
  Object.assign(window, { __menu: flow });
  ui.toMenu.hidden = false;
  await flow.boot({ skipIntro: params.has('skipintro') });
}

function setDevTools(on: boolean) {
  ui.app.classList.toggle('dev-tools', on);
  if (on) ui.app.classList.remove('collapsed');
}

/** Pause/unpause the running level (systems and player input). */
function setPaused(paused: boolean) {
  // The original fades the music out over 1 s on pause and back in on resume.
  if (paused !== gamePaused) audio.fadeBus('music', paused ? 1 : 0, MUSIC_PAUSE_FADE);
  gamePaused = paused;
  if (paused) {
    view.player.enabled = false;
    view.controls.enabled = false;
  } else {
    view.player.enabled = view.walking;
    view.controls.enabled = !view.walking;
  }
}

/** Stops the running level's game logic and sound (the geometry stays until the next load). */
function leaveLevel() {
  loadToken++;
  stopSystems();
  audio.clearEmitters();
  audio.stopAll();
  setLoading(null);
}

// ---------------------------------------------------------------------------
// Game data source

async function setFS(next: GameFS) {
  fs = next;
  ui.sourceLabel.textContent = next.label;
  ui.sourceLabel.title = next.label;
  const files = await next.list();
  renderLevelList(files);
}

function showPicker(error?: string) {
  ui.picker.hidden = false;
  ui.pickerError.hidden = !error;
  ui.pickerError.textContent = error ?? '';
}

async function acceptLocal(make: () => Promise<LocalFolderFS> | LocalFolderFS) {
  try {
    const local = await make();
    ui.picker.hidden = true;
    await setFS(local);
    toast(`Loaded ${(await local.list()).length} files`);
    if (menuMode && !ui.app.classList.contains('dev-tools')) await startMenuFlow();
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    showPicker((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Level list + loading

function renderLevelList(files: string[]) {
  ui.levels.replaceChildren();
  const add = (label: string, path: string, title = path) => {
    const b = document.createElement('button');
    b.className = 'level';
    b.textContent = label;
    b.title = title;
    b.dataset.path = path;
    b.onclick = () => void openLevel(path);
    ui.levels.append(b);
  };
  const heading = (text: string) => {
    const h = document.createElement('div');
    h.className = 'chapter';
    h.textContent = text;
    ui.levels.append(h);
  };

  heading('Test');
  add('Procedural test level', DEMO_LEVEL_PATH, 'Built-in scene, no game files needed');

  const groups = groupLevels(files);
  if (!groups.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = fs ? 'No .lvl files found.' : 'No game folder selected.';
    ui.levels.append(e);
  }
  for (const g of groups) {
    heading(g.chapter);
    for (const p of g.levels) add(stem(p), p);
  }
  markActive();
}

function markActive() {
  for (const b of ui.levels.querySelectorAll<HTMLButtonElement>('button.level')) {
    b.classList.toggle('active', b.dataset.path === currentPath);
  }
}

/** Loads a level; resolves true when it finished loading (false if it failed or was superseded). */
async function openLevel(path: string, spawnName?: string, opts: { updateUrl?: boolean; restore?: SaveData } = {}): Promise<boolean> {
  const token = ++loadToken;
  let ok = false;
  // The shaders of the level being left stay built until the new one has compiled its own: what
  // the two share is not built again (docs/game-logic.md §18.8).
  const releaseShaders = view.holdShaderCaches();
  stopSystems();
  // The loading screen covers the canvas from here on: nothing to draw (LevelRenderer.suspended).
  view.suspended = true;
  currentPath = path;
  currentLoaded = null;
  markActive();
  setLoading(`Loading ${path === DEMO_LEVEL_PATH ? 'demo scene' : stem(path)}…`);
  frameProbe.mark('start', true);
  // The save's difficulty decides which placed objects exist (src/game/campaign/difficulty.ts):
  // it must be current before the level is parsed.
  if (opts.restore) saves.session.difficulty = opts.restore.difficulty;
  try {
    const loaded = await loadLevel(fs, path, (msg) => token === loadToken && (frameProbe.mark(msg), setLoading(msg)));
    if (token !== loadToken) return false;
    frameProbe.mark('level data');
    setLoading('Building meshes…');
    // The sound banks' indexes are read (network / disk) while the meshes are built (CPU).
    const audioReady = startLevelAudio(loaded, token);
    audioReady.catch(() => undefined); // (awaited below; no unhandled-rejection report meanwhile)
    await nextFrame();
    const stats = view.setLevel(loaded.level, loaded.textures);
    frameProbe.mark('level meshes');
    showLevelInfo(loaded, stats);
    await audioReady;
    frameProbe.mark('audio');
    currentLoaded = loaded;
    if (fs && path !== DEMO_LEVEL_PATH && token === loadToken) {
      const entry: LevelEntry = opts.restore ? { kind: 'load', data: opts.restore } : spawnName !== undefined ? { kind: 'transition' } : { kind: 'new' };
      await startGame(loaded, path, spawnName, token, entry);
    }
    if (opts.updateUrl !== false) {
      const url = new URL(location.href);
      if (path === DEMO_LEVEL_PATH) url.searchParams.delete('level');
      else url.searchParams.set('level', path);
      history.replaceState(null, '', url);
    }
    ok = token === loadToken;
  } catch (err) {
    console.error(err);
    if (token === loadToken) toast(`Failed: ${(err as Error).message}`, 5000);
  } finally {
    releaseShaders();
    if (token === loadToken) {
      view.suspended = false;
      setLoading(null);
    }
  }
  return ok;
}

/** Starts the game systems of a loaded level, then lets the save system apply `entry`. */
async function startGame(loaded: LoadedLevel, path: string, spawnName: string | undefined, token: number, entry: LevelEntry, warm = true) {
  if (!fs) return;
  const started = await startSystems(
    {
      fs,
      view,
      audio,
      loaded,
      levelPath: path,
      spawnName,
      startKind: entry.kind,
      savedSpawnName: entry.kind === 'load' ? entry.data.spawnName : undefined,
      requestLevel: (next, opts) => {
        // Keep this level's state (revisits) and the player's state for the next level.
        saves.leavingLevel();
        void (flow?.inGame ? flow.travel(next, opts?.spawnName) : openLevel(next, opts?.spawnName));
      },
      services: {},
    },
    // (Each system's start is a load phase of its own: frameProbe.load.)
    systemFactories.map((make) => async (ctx: Parameters<typeof make>[0]) => {
      const sys = await make(ctx);
      frameProbe.mark(`system ${sys.name}`);
      return sys;
    }),
  );
  frameProbe.mark('systems');
  if (token !== loadToken) {
    for (const sys of started) sys.dispose?.();
    return;
  }
  // Every pipeline the level's objects need (all passes, flashlight on and off), compiled
  // while the loading screen is still up: compiling them during play hitches the frame
  // (docs/game-logic.md §18). The visibility system tops it up on the first update (and is
  // all there is for an in-place restart, which has no loading screen to hide the wait).
  if (warm) {
    setLoading('Compiling shaders…');
    await view.precompile({ hooks: true, lanes: true }).catch((err) => console.warn('[renderer] precompile failed:', err));
    frameProbe.mark('compile');
  }
  if (token !== loadToken) {
    for (const sys of started) sys.dispose?.();
    return;
  }
  try {
    saves.levelReady(entry);
  } catch (err) {
    console.error('[save] restoring the level state failed:', err);
  }
  if (warm) {
    // The systems' first update builds more (the static prop batch, NPC gear, the visibility
    // top-up, the first sequence keys): it runs here, still behind the loading screen, with the
    // sound held until the first frame, followed by the pipelines of what it built and a GPU
    // flush. Otherwise the first frames after a load took 100-450 ms (docs/game-logic.md §18).
    const ac = audio.context;
    const hold = ac.state === 'running';
    if (hold) await ac.suspend().catch(() => undefined);
    for (const sys of started) {
      try {
        sys.update?.(FIRST_UPDATE_DT);
      } catch (err) {
        console.error(`[game] ${sys.name} first update failed:`, err);
      }
    }
    frameProbe.mark('first update');
    await view.precompile().catch((err) => console.warn('[renderer] precompile failed:', err));
    frameProbe.mark('compile 2');
    await view.settle().catch(() => undefined);
    frameProbe.mark('settle');
    // A few real frames (drawn, nothing updated) before the loading screen goes.
    view.suspended = false;
    for (let i = 0; i < 3 && token === loadToken; i++) await nextFrame();
    if (hold) void ac.resume().catch(() => undefined);
    frameProbe.mark('shown');
  }
  view.suspended = false;
  if (token !== loadToken) {
    for (const sys of started) sys.dispose?.();
    return;
  }
  systems = started;
}

/** Game time the load-time first update advances (s): short of a frame, never zero. */
const FIRST_UPDATE_DT = 1 / 240;

/**
 * Revert / load within the current level without reloading it: the game systems are
 * recreated on the loaded level data and the save is applied (no loading screen).
 */
async function restartLevel(restore: SaveData): Promise<boolean> {
  if (!fs || !currentLoaded || !currentPath || currentPath !== restore.levelPath) return false;
  // Another difficulty has other placed objects: reload the level (src/game/campaign/difficulty.ts).
  if (restore.difficulty !== saves.session.difficulty) return false;
  const token = ++loadToken;
  // The recreated systems draw with the shaders the old ones used: kept built (see openLevel)
  // until the first frames have compiled what they need.
  const releaseShaders = view.holdShaderCaches();
  stopSystems();
  audio.clearEmitters();
  audio.stopAll();
  try {
    await startGame(currentLoaded, currentPath, undefined, token, { kind: 'load', data: restore }, false);
  } finally {
    setTimeout(releaseShaders, 5000);
  }
  return token === loadToken;
}

/** Developer viewer (no menu flow): restore in place or load the save's level. */
async function restoreSave(d: SaveData): Promise<boolean> {
  if (d.levelPath === currentPath && (await restartLevel(d))) return true;
  return openLevel(d.levelPath, undefined, { restore: d, updateUrl: false });
}

function stopSystems() {
  for (const sys of systems.reverse()) {
    try {
      sys.dispose?.();
    } catch (err) {
      console.error('[game] dispose failed:', err);
    }
  }
  systems = [];
}

/**
 * Mount the level's sound banks and start its ambience. Music is not started here: the
 * level's Combat Music objects are triggered by level-logic messages (src/game/world/music.ts).
 */
async function startLevelAudio(loaded: LoadedLevel, token: number) {
  audio.clearEmitters();
  audio.stopAll();
  const needed = new Set<number>();
  const source = fs;
  if (source && loaded.lvl && loaded.packages && loaded.packagePaths) {
    // All banks at once (each index is a few batched range reads).
    await Promise.all(
      [...loaded.packagePaths].map(async ([id, base]) => {
        const sdu = await source.resolve(`${base}.sdu`);
        if (!sdu) return;
        needed.add(id);
        if (!mountedSounds.has(id) && id !== flow?.interfacePkg) await audio.mountSdu(source, sdu, id);
      }),
    );
  }
  // The menu's interface bank stays mounted (it may also be a level dependency).
  for (const id of mountedSounds) if (!needed.has(id) && id !== flow?.interfacePkg) audio.unmount(id);
  mountedSounds = needed;
  if (token !== loadToken || !loaded.lvl || !loaded.packages) return;
  try {
    audio.setEmitters(levelSoundEmitters(parseLevelObjects(loaded.lvl), loaded.packages, audio), { autoMusic: false });
  } catch (err) {
    console.warn('[audio] no level ambience:', err);
  }
}

function showLevelInfo(loaded: LoadedLevel, s: LevelStats) {
  const lines = [
    loaded.level.name,
    `${s.parts} parts → ${s.meshes} meshes · ${s.vertices.toLocaleString()} verts · ${s.textures} textures`,
  ];
  if (s.collisionTriangles !== undefined) {
    lines.push(`collision: ${s.collisionTriangles.toLocaleString()} tris, BVH ${s.collisionMs!.toFixed(0)} ms`);
  }
  if (s.missingTextures.length) lines.push(`${s.missingTextures.length} missing texture keys`);
  if (loaded.deps) {
    const d = loaded.deps;
    const n = (p?: string) => (p ? '✓' : '✗');
    lines.push(
      `deps: tdu ${n(d.levelTdu)} ldu ${n(d.levelLdu)} chapter ${n(d.chapterTdu)} · +${d.dependencyTdus.length} common tdu`,
    );
    if (d.missing.length) lines.push(`unresolved: ${d.missing.join(', ')}`);
  }
  for (const note of loaded.notes) lines.push(note);
  ui.levelInfo.textContent = lines.join('\n');
}

function setLoading(msg: string | null) {
  if (loadingSink) {
    if (msg) loadingSink(msg);
    ui.loading.hidden = true;
    return;
  }
  ui.loading.hidden = msg === null;
  if (msg) ui.loadingText.textContent = msg;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

// ---------------------------------------------------------------------------
// HUD / input

function startStats() {
  let frames = 0;
  let acc = 0;
  view.onFrame((dt) => {
    frames++;
    acc += dt;
    if (acc < 0.5) return;
    const fps = frames / acc;
    frames = 0;
    acc = 0;
    const info = view.renderer.info.render;
    ui.stats.innerHTML =
      `<span class="backend">${view.backend}</span><br>` +
      `${fps.toFixed(0)} fps<br>` +
      `${info.drawCalls} draws · ${Math.round(info.triangles).toLocaleString()} tris<br>` +
      (view.walking ? walkStatus() : `fly · speed ${view.controls.currentSpeed.toPrecision(3)}`) +
      (view.flashlight.visible ? '' : ' · light off');
  });
}

function walkStatus() {
  const p = view.player;
  const v = p.velocity;
  return (
    `walk ${p.mode === 'fp' ? '1st' : '3rd'} · ${p.onGround ? 'ground' : 'air'}${p.crouched ? ' · crouch' : ''}<br>` +
    `${Math.hypot(v.x, v.z).toFixed(1)} m/s · ${p.position.x.toFixed(1)}, ${p.position.y.toFixed(1)}, ${p.position.z.toFixed(1)}`
  );
}

function wireUi() {
  ui.sidebarToggle.onclick = () => ui.app.classList.toggle('collapsed');
  ui.changeFolder.onclick = () => showPicker();
  ui.pickDemo.onclick = () => {
    ui.picker.hidden = true;
    if (menuMode) setDevTools(true);
    void openLevel(DEMO_LEVEL_PATH);
  };
  ui.toMenu.onclick = () => {
    setDevTools(false);
    flow?.backToMenu();
  };
  document.addEventListener('pointerlockchange', () => flow?.onPointerLockChange());
  ui.pickFolder.onclick = () => {
    if (LocalFolderFS.supportsDirectoryPicker) void acceptLocal(() => LocalFolderFS.pickDirectory());
    else ui.folderInput.click();
  };
  ui.folderInput.onchange = () => {
    const files = ui.folderInput.files;
    if (files?.length) void acceptLocal(() => LocalFolderFS.fromFileList(files));
  };

  view.controls.onLockChange = (locked) => ui.hint.classList.toggle('hidden', locked);
  view.controls.onSpeedChange = (s) => toast(`Speed ${s.toPrecision(3)}`);
  view.player.onModeChange = (m) => toast(m === 'fp' ? 'First person' : 'Third person');

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.repeat) return;
    // While playing through the menus (no developer sidebar) only F1, Esc and the flashlight
    // are app keys: the developer keys below share codes with game actions (R reload, G next
    // throwable, [ ] weapons, Tab inventory), also when a gamepad button emits them.
    const devKeys = !menuMode || ui.app.classList.contains('dev-tools') || !flow?.inGame;
    if (!devKeys && !['F1', 'Escape', 'KeyF'].includes(e.code)) return;
    switch (e.code) {
      case 'F1':
        // Developer sidebar + HUD (menu flow only; the dev viewer always shows them).
        if (menuMode) {
          e.preventDefault();
          setDevTools(!ui.app.classList.contains('dev-tools'));
        }
        break;
      case 'Escape':
        if (flow?.onEscape()) e.preventDefault();
        break;
      case 'KeyF':
        toast(`Flashlight ${view.toggleFlashlight() ? 'on' : 'off'}`);
        break;
      case 'KeyG':
        toast(`Fog ${view.toggleFog() ? 'on' : 'off'}`);
        break;
      case 'KeyN':
        toast(view.toggleWalking() ? 'Walk' : 'Fly (noclip)');
        break;
      case 'KeyR':
        if (view.walking) {
          view.player.respawn();
          toast('Respawn');
        }
        break;
      case 'BracketLeft':
        view.scaleFog(1 / 1.3);
        toast('Fog thinner');
        break;
      case 'BracketRight':
        view.scaleFog(1.3);
        toast('Fog thicker');
        break;
      case 'KeyB':
        toast(view.toggleBackfaceCulling() ? 'Backface culling on' : 'Double-sided');
        break;
      case 'Tab':
        e.preventDefault();
        ui.app.classList.toggle('collapsed');
        break;
    }
  });
  if (window.matchMedia('(max-width: 700px)').matches) ui.app.classList.add('collapsed');
}

let toastTimer = 0;
function toast(msg: string, ms = 1400) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), ms);
}

function showFatal(msg: string) {
  setLoading(null);
  ui.viewport.innerHTML = `<div style="padding:40px;color:#d8432f">${msg.replace(/</g, '&lt;')}</div>`;
}

void main();
