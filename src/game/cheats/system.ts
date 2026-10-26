// The original game's cheats (rules.ts, docs/game-logic.md §15.18) as a game system.
//
// Input: the chord and the 25 key sequences are read from the user's Suffering.rfl once per page
// (rules.ts readCheatInput); the keys down are tracked from the window's key events (capture
// phase, nothing consumed: the keys keep doing what they are bound to, as in the original) and
// the matcher is polled on every change, also while the pause menu is open (the original polls
// from the game frame whether paused or not).
//
// Effects go through the port's services: insanity (reputation, meter, insanity attacks, the
// clock), repskin (blood), combat (health, the blow), world (item lists: giveItem), weapons
// (ammo, throwables, flashlight), the HUD's pickup text (the cheat's name) and the audio (p33..p36).
// The two screen-effect toggles keep their state for the page session (the original's state
// object is a static of Suffering.rfl): the grey-film toggle (case 20) greys the frame with the shader's weights (an SVG
// colour matrix on the canvas, on its gamma values like the original's blit) and runs the clock
// at 1.3; the glow toggle (case 21) lets the whole frame into the scene glow (Original look; Enhanced: the
// bloom threshold at 0) and runs the clock at 0.7.
//
// Nothing marks a game as cheated: the dispatcher writes the Player's state and the two toggles
// only, so saves, reputation, the ending and unlocks work as with any other change [verified].
//
// Service: services.cheats = { names, apply(index, announce?), toggles }; the pause menu's port
// page reaches it through bridge.ts. Debug: window.__cheats.

import type { GameContext, GameSystem } from '../runtime';
import type { EntityPackageSet } from '../../formats/entities';
import { readXduString } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { SoundHandle } from '../../app/audio';
import { keyOf, num, ref, refs, templateValues } from '../insanity/params';
import { postHudMessage } from '../hud/bus';
import { cheatsBridge, type CheatEntry } from './bridge';
import {
  CHEAT_CASES,
  CHEAT_COUNT,
  CheatInput,
  DIK,
  GREY_WEIGHTS,
  PLAYER_CHEATS_PROP,
  PLAYER_TEMPLATE,
  TOGGLES,
  confirmSoundProp,
  giveListSource,
  readCheatInput,
  type CheatInputData,
} from './rules';

/** The Flashlight class's template (the only one in the retail data) [verified]. */
const FLASHLIGHT_TEMPLATE: ResRef = { pkg: 4, id: 72 };

/** Read once per page: the user's Suffering.rfl does not change. */
let inputData: Promise<CheatInputData | null> | null = null;

/** Game Cheats state +0xd4 / +0xdc: statics of the RFL, kept across levels and loads. */
const toggles = { greyFilm: false, fullGlow: false };

interface InsanityLike {
  readonly transformed: boolean;
  readonly mode: 'normal' | 'morphing' | 'insane' | 'reverting';
  readonly reputationRange?: readonly [number, number];
  addReputation(points: number): void;
  setReputation?(points: number): void;
  setMeter(fraction: number): void;
  acquireNextAttack?(): boolean;
  setClockRate?(rate: number): void;
}
interface RepSkinLike {
  readonly maxBlood: number;
  addBlood(n: number): void;
  setBlood?(n: number): void;
}
interface CombatLike {
  readonly player: { readonly health: number; readonly maxHealth: number; readonly alive: boolean };
  damagePlayer(amount: number): void;
  healPlayer(amount: number): number;
}
interface WeaponsLike {
  readonly current: { id: string; ranged: boolean } | null;
  readonly throwable: { id: string; count: number } | null;
  give(id: string, amount?: number): void;
}
interface InventoryLike {
  readonly items: ReadonlyMap<string, { count: number; className?: string; template?: ResRef }>;
  count(item: ResRef): number;
}
interface WorldLike {
  giveItem?(template: ResRef): boolean;
}

const GREY_FILTER_ID = 'suffering-grey-film';

/** The SVG colour matrix of xpsBW_PC.psh (installed once per page). */
function greyFilter(): string {
  if (typeof document === 'undefined') return '';
  if (!document.getElementById(GREY_FILTER_ID)) {
    const [r, g, b] = GREY_WEIGHTS;
    const row = `${r} ${g} ${b} 0 0`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    // sRGB: the matrix works on the displayed (gamma) values, as ps.1.0 did on the back buffer.
    svg.innerHTML = `<filter id="${GREY_FILTER_ID}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${row} ${row} ${row} 0 0 0 1 0"/></filter>`;
    document.body.appendChild(svg);
  }
  return `url(#${GREY_FILTER_ID})`;
}

export async function createCheatsSystem(ctx: GameContext): Promise<GameSystem> {
  const { view, audio } = ctx;
  const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
  if (!pkgs) return { name: 'cheats (no packages)' };
  const log = (msg: string) => console.info(`[cheats] ${msg}`);

  const insanity = () => ctx.services.insanity as InsanityLike | undefined;
  const repskin = () => ctx.services.repskin as RepSkinLike | undefined;
  const combat = () => ctx.services.combat as CombatLike | undefined;
  const weapons = () => ctx.services.weapons as WeaponsLike | undefined;
  const inventory = () => ctx.services.inventory as InventoryLike | undefined;
  const world = () => ctx.services.world as WorldLike | undefined;

  // The Player's template: the creature form's while transformed (its p253; the engine reads the
  // object's current template, e.g. p315 is empty on the creature).
  const human = templateValues(pkgs, PLAYER_TEMPLATE);
  const creatureRef = ref(human?.values[253]);
  const playerValues = () => (insanity()?.transformed && creatureRef ? templateValues(pkgs, creatureRef)?.values : undefined) ?? human?.values ?? [];
  const cheatsRef = ref(human?.values[PLAYER_CHEATS_PROP]);
  const cheats = cheatsRef ? templateValues(pkgs, cheatsRef)?.values : undefined;
  const nameOf = (prop: number): string => {
    const r = ref(cheats?.[prop]);
    return (r && readXduString(pkgs, r)) || `Cheat ${prop}`;
  };
  const soundKey = (prop: number) => {
    const r = ref(cheats?.[prop]);
    const k = r ? keyOf(r) : '';
    return k && audio.get(k) ? k : '';
  };

  // --- Effects ------------------------------------------------------------------------------
  const loops: Partial<Record<keyof typeof toggles, SoundHandle>> = {};
  let enhancedThreshold: number | null = null;
  /** The glow flag was set here (a level's own HDR Scene Glow template keeps its p3 otherwise). */
  let glowSet = false;

  const giveList = (n: number) => {
    const src = giveListSource(n);
    if (!src) return 0;
    const list = refs((src.from === 'player' ? playerValues() : cheats)?.[src.prop]);
    let given = 0;
    for (const t of list) if (world()?.giveItem?.(t)) given++;
    return given;
  };

  const holdsFlashlight = () => {
    for (const it of inventory()?.items.values() ?? []) {
      if (it.count <= 0) continue;
      if (it.className === 'Flashlight' || (it.template && templateValues(pkgs, it.template)?.cls === 'Flashlight')) return true;
    }
    return false;
  };

  /** Applies the screen side of the toggles (every frame: the Pixel Shaders option may change). */
  const applyScreen = () => {
    const canvas = view.renderer?.domElement as HTMLCanvasElement | undefined;
    // The grey blit needs the front-buffer path (the Pixel Shaders option) in the Original look.
    const grey = toggles.greyFilm && (!!view.enhanced || view.postEffects);
    if (canvas) {
      const want = grey ? greyFilter() : '';
      if (canvas.style.filter !== want) canvas.style.filter = want;
    }
    if (view.glow && (toggles.fullGlow || glowSet)) {
      view.glow.state.flag = toggles.fullGlow ? 1 : 0;
      glowSet = toggles.fullGlow;
    }
  };
  const applyEnhanced = async () => {
    if (!view.enhanced) return;
    const { grade } = await import('../../app/enhanced/post');
    if (toggles.fullGlow) {
      enhancedThreshold ??= grade.bloomThreshold.value as number;
      grade.bloomThreshold.value = 0;
    } else if (enhancedThreshold !== null) {
      grade.bloomThreshold.value = enhancedThreshold;
      enhancedThreshold = null;
    }
  };

  const toggle = (which: keyof typeof toggles) => {
    const on = (toggles[which] = !toggles[which]);
    const t = TOGGLES[which];
    insanity()?.setClockRate?.(on ? t.clock : 1);
    if (on) {
      const k = soundKey(t.sound);
      if (k && cheats) loops[which] = audio.play(k, { bus: 'sfx' });
    } else {
      loops[which]?.stop(1);
      delete loops[which];
    }
    applyScreen();
    void applyEnhanced();
    log(`${which} ${on ? 'on' : 'off'}`);
  };

  /** The dispatcher (0x100013c0). Returns false when nothing was announced. */
  const apply = (index: number, announce = true): boolean => {
    const c = CHEAT_CASES[index];
    if (!c) return false;
    const e = c.effect;
    switch (e.kind) {
      case 'reputationAdd':
        insanity()?.addReputation(e.amount);
        break;
      case 'reputationSet': {
        const v = playerValues();
        const n = e.end === 'evil' ? num(v[70], insanity()?.reputationRange?.[0] ?? -150) : num(v[71], insanity()?.reputationRange?.[1] ?? 150);
        insanity()?.setReputation?.(n);
        break;
      }
      case 'bloodFill': {
        const r = repskin();
        if (r) r.addBlood(r.maxBlood);
        break;
      }
      case 'bloodClear':
        repskin()?.setBlood?.(0);
        break;
      case 'suicide':
        combat()?.damagePlayer(e.amount);
        break;
      case 'give':
        giveList(e.list);
        break;
      case 'flashlight': {
        const w = weapons();
        if (!w) break;
        // As items of their own templates (names, the weapons' supply caps); weapons.give without a world.
        const give = (t: ResRef, n: number) => {
          for (let k = 0; k < n; k++) if (!world()?.giveItem?.(t)) return k ? undefined : w.give(keyOf(t), n - k);
        };
        if (!holdsFlashlight()) give(FLASHLIGHT_TEMPLATE, 1);
        const battery = ref(templateValues(pkgs, FLASHLIGHT_TEMPLATE)?.values[69]);
        if (battery) give(battery, e.batteries);
        break;
      }
      case 'ammo': {
        const w = weapons();
        const cur = w?.current;
        if (!w || !cur) break;
        const [pkg, id] = cur.id.split(':').map(Number);
        const t = templateValues(pkgs, { pkg, id });
        const ammo = t?.cls === 'Ranged Weapon' ? ref(t.values[68]) : null;
        if (ammo) w.give(keyOf(ammo), e.amount);
        break;
      }
      case 'throwables': {
        const w = weapons();
        const th = w?.throwable;
        if (!w || !th) break;
        const [pkg, id] = th.id.split(':').map(Number);
        const have = inventory()?.count({ pkg, id }) ?? th.count;
        if (e.count - have > 0) w.give(th.id, e.count - have);
        break;
      }
      case 'insanityAttack':
        // Not transformed (state 20): the dispatcher leaves at once, no sound, no name (0x100015b4).
        if (insanity()?.mode !== 'insane') return false;
        insanity()?.acquireNextAttack?.();
        break;
      case 'meterFull':
        insanity()?.setMeter(1);
        break;
      case 'healthFull': {
        const c2 = combat();
        if (c2) c2.healPlayer(c2.player.maxHealth);
        break;
      }
      case 'combo':
        for (const k of e.cases) apply(k, false);
        break;
      case 'toggle':
        toggle(e.effect);
        break;
    }
    log(`case ${index} (${nameOf(c.name)})${announce ? '' : ' (part of a combination)'}`);
    if (!announce || !cheats) return true;
    const k = soundKey(confirmSoundProp(index));
    if (k) audio.play(k, { bus: 'sfx' });
    postHudMessage('pickup', nameOf(c.name));
    return true;
  };

  // --- Input ----------------------------------------------------------------------------------
  inputData ??= (async () => {
    try {
      const path = await ctx.fs.resolve('Suffering.rfl');
      if (!path) return null;
      return readCheatInput(new Uint8Array(await ctx.fs.read(path)));
    } catch {
      return null;
    }
  })();
  const data = await inputData;
  const input = data ? new CheatInput(data) : null;
  const down = new Set<number>();
  const poll = () => {
    if (!input) return;
    const hit = input.poll(down);
    if (hit >= 0) apply(hit);
  };
  const onKey = (ev: KeyboardEvent) => {
    const k = DIK[ev.code];
    if (k === undefined) return;
    if (ev.type === 'keydown') {
      if (down.has(k)) return;
      down.add(k);
    } else if (!down.delete(k)) return;
    poll();
  };
  const onBlur = () => {
    down.clear();
    poll();
  };
  if (input && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
  }
  log(data ? `ready: ${data.sequences.length} sequences, chord of ${data.chord.length} keys` : 'Suffering.rfl not readable: typed cheats off (the menu page still works)');

  // --- Service, bridge, the toggles carried in from the last level -----------------------------
  const list = (): CheatEntry[] =>
    Array.from({ length: CHEAT_COUNT }, (_, i) => {
      const c = CHEAT_CASES[i];
      const on = c.effect.kind === 'toggle' ? toggles[c.effect.effect] : undefined;
      return { index: i, name: nameOf(c.name), ...(on !== undefined ? { on } : {}) };
    });
  const service = {
    get names() {
      return CHEAT_CASES.map((c) => nameOf(c.name));
    },
    get toggles() {
      return { ...toggles };
    },
    get chordHeld() {
      return !!input?.held;
    },
    apply,
  };
  ctx.services.cheats = service;
  cheatsBridge.list = list;
  cheatsBridge.apply = (i) => void apply(i);
  for (const which of Object.keys(toggles) as (keyof typeof toggles)[]) {
    if (!toggles[which]) continue;
    insanity()?.setClockRate?.(TOGGLES[which].clock);
    const k = soundKey(TOGGLES[which].sound);
    if (k) loops[which] = audio.play(k, { bus: 'sfx' });
  }
  applyScreen();
  void applyEnhanced();
  if (typeof window !== 'undefined') Object.assign(window, { __cheats: { service, input, data: () => data, list, toggles } });

  return {
    name: 'cheats',
    update() {
      applyScreen();
    },
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keyup', onKey, true);
        window.removeEventListener('blur', onBlur);
      }
      for (const h of Object.values(loops)) h?.stop(0);
      const canvas = view.renderer?.domElement as HTMLCanvasElement | undefined;
      if (canvas) canvas.style.filter = '';
      if (view.glow && glowSet) view.glow.state.flag = 0;
      if (cheatsBridge.apply && ctx.services.cheats === service) {
        cheatsBridge.list = null;
        cheatsBridge.apply = null;
      }
    },
  };
}
