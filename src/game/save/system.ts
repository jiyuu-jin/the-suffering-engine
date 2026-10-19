// Save game system (first in src/game/systems.ts): the per-level half of the save system.
//
//   * creates the level's SaveRegistry and publishes ctx.services.save (SaveService, see
//     providers.ts) before the other systems start, so they can register providers;
//   * registers the player-transform provider;
//   * Autosave objects (class "Autosave", input 0 inSave) request a checkpoint when they
//     receive their message; Level Transitions announce their chapter (p3, Chapter
//     Properties) for the save names;
//   * takes requested checkpoints once the logic settled (2 frames) and no cinematic runs;
//   * shows the game's checkpoint notice (HUD text UIP p28: Simple Text HUD #426, string
//     5:107, centred at y 25 %) in the interface font;
//   * vetoes manual saving with the original's rule (rules.ts, docs/re/saves.md: dead, under
//     cinematic control, morphing, jumping / falling, climbing / scripted locomotion); Autosave
//     objects follow the original's checks too (alive, health >= 5, Checkpoints option or the
//     object's p1; "Prompt" saves like "On": the port has no prompt box);
//   * the player's death: after DEATH_RESTART_SECONDS the last checkpoint is restored (the
//     original restarts from the checkpoint; it has no death menu in the front-end data).
//
// Debug: window.__save { saves, registry }.

import type { GameContext, GameSystem } from '../runtime';
import type { WorldService } from '../world/world';
import type { ResRef } from '../../formats/model';
import { loadSubtitleFont } from '../sequence/subtitles';
import type { BitmapFont } from '../../app/menu/text';
import { SaveRegistry } from './registry';
import { playerSaveProvider, releasePlayerControl, type SaveService } from './providers';
import { saves } from './manager';
import { autosaveAction, originalSaveVeto } from './rules';

/** Checkpoint notice text (Interface string of HUD text #426). */
const CHECKPOINT_TEXT = '5:107';
const NOTICE_SECONDS = 2.6;
const DEATH_RESTART_SECONDS = 4;

interface CombatLike {
  readonly player: { readonly alive: boolean; readonly health?: number };
}
interface InsanityLike {
  readonly mode?: string;
}

export function createSaveSystem(ctx: GameContext): GameSystem {
  const { view } = ctx;
  const registry = new SaveRegistry();
  const service: SaveService = {
    register: (key, provider, opts) => registry.register(key, provider, opts),
    addVeto: (fn) => registry.addVeto(fn),
    checkpoint: (reason = 'script') => saves.requestCheckpoint(reason),
  };
  ctx.services.save = service;
  saves.bindLevel(registry, ctx.levelPath, ctx.spawnName);
  // First system of every level start (and of every checkpoint restore): nothing the previous
  // run's systems handed the player controller survives them (providers.ts).
  releasePlayerControl(view.player, view.walking);

  registry.register(
    'player',
    playerSaveProvider(view.player, (s) => {
      // Fly mode: put the camera where the player is.
      if (!view.walking) {
        const p = view.player.eyePosition();
        view.controls.setPose(p, s.yaw, s.pitch);
      }
    }),
    { scope: 'level', priority: 20 },
  );

  const world = () => ctx.services.world as WorldService | undefined;
  const combat = () => ctx.services.combat as CombatLike | undefined;
  const cinematic = () => {
    const w = world()?.world;
    return !!w && (w.playerInCutscene() || w.activeCutscenes().length > 0);
  };
  // The original's can-save predicate (RFL 0x100438a0, docs/re/saves.md): no enemy-proximity
  // rule; dead, cinematic control, morphing, airborne and ladder / scripted locomotion block.
  registry.addVeto(() => {
    const mode = (ctx.services.insanity as InsanityLike | undefined)?.mode;
    return originalSaveVeto({
      alive: combat()?.player.alive ?? true,
      controlled: cinematic(),
      morphing: mode === 'morphing' || mode === 'reverting',
      airborne: view.walking && !view.player.onGround,
      climbing: view.walking && !!view.player.motionOverride,
    });
  });

  // --- Autosave / Level Transition hooks (world starts after us: hooked on the first update)
  const unhook: (() => void)[] = [];
  let hooked = false;
  const hookWorld = () => {
    const ws = world();
    if (hooked || !ws) return;
    hooked = true;
    const w = ws.world;
    for (const a of w.of('Autosave')) {
      const save = a.e.inputs.find((s) => s.slot === 0)?.message ?? 1;
      unhook.push(
        w.subscribe(a.uid, (msg) => {
          if (msg !== save || a.destroyed) return;
          // Autosave inSave (0x100970a0): alive, health >= 5, Checkpoints option / p1.
          const p = combat()?.player;
          const objectMode = Number(a.e.values[1] ?? 0) || 0;
          const act = autosaveAction({ alive: p?.alive ?? true, health: p?.health ?? 100, option: saves.host?.checkpointsMode?.() ?? 2, objectMode });
          if (act === 'skip') {
            console.info(`[save] Autosave #${a.uid.toString(16)} skipped (checkpoints off, low health or dead)`);
            return;
          }
          saves.requestCheckpoint(`Autosave #${a.uid.toString(16)}`);
        }),
      );
    }
    for (const t of w.of('Level Transition')) {
      const go = t.e.inputs.find((s) => s.slot === 10)?.message;
      unhook.push(
        w.subscribe(t.uid, (msg) => {
          if (go !== undefined && msg !== go) return;
          const ch = t.e.values[3] as ResRef | null | undefined;
          if (ch && typeof ch === 'object' && 'pkg' in ch) saves.nextChapter = `${ch.pkg}:${ch.id}`;
        }),
      );
    }
  };

  // --- Checkpoint notice
  const container = view.renderer.domElement.parentElement ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.className = 'save-notice';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6';
  container.append(canvas);
  let font: BitmapFont | null = null;
  void loadSubtitleFont(ctx.fs).then((f) => (font = f));
  let noticeLeft = 0;
  let noticeText = '';
  const drawNotice = () => {
    const w = container.clientWidth, h = container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (noticeLeft <= 0 || !noticeText) return;
    const age = NOTICE_SECONDS - noticeLeft;
    const alpha = Math.min(1, age / 0.25, noticeLeft / 0.5);
    // 640x480 virtual space, letterboxed like the menus.
    const s = Math.min(w / 640, h / 480) * dpr;
    g.setTransform(s, 0, 0, s, (canvas.width - 640 * s) / 2, (canvas.height - 480 * s) / 2);
    const y = 480 * 0.25;
    if (font) font.draw(g, noticeText, 320, y + (24 - font.lineHeight * 0.85) / 2, { align: 'center', scale: 0.85, color: '#e8e8e8', alpha });
    else {
      g.globalAlpha = alpha;
      g.font = '16px Georgia, serif';
      g.fillStyle = '#e8e8e8';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(noticeText, 320, y + 12);
    }
  };
  saves.onNotice = () => {
    noticeText = saves.host?.label?.(CHECKPOINT_TEXT) ?? '';
    noticeLeft = noticeText ? NOTICE_SECONDS : 0;
  };

  let dead = 0;
  let reverting = false;
  Object.assign(window, { __save: { saves, registry } });

  return {
    name: 'save',
    update(dt) {
      hookWorld();
      const alive = combat()?.player.alive ?? true;
      saves.tick(dt, cinematic() ? 'cinematic' : !alive ? 'dead' : null);
      if (noticeLeft > 0 || canvas.width) {
        noticeLeft = Math.max(0, noticeLeft - dt);
        drawNotice();
        if (noticeLeft <= 0) canvas.width = 0;
      }
      // Death: back to the last checkpoint.
      dead = alive ? 0 : dead + dt;
      if (dead > DEATH_RESTART_SECONDS && !reverting && saves.checkpoint) {
        reverting = true;
        void saves.revert().finally(() => (reverting = false));
      }
    },
    dispose() {
      for (const f of unhook) f();
      canvas.remove();
      if (saves.onNotice) saves.onNotice = undefined;
      saves.unbindLevel(registry);
      if (ctx.services.save === service) delete ctx.services.save;
    },
  };
}
