// Campaign game system: the parts of the level-to-level flow that are not one level's logic.
//
//   * Level Transition Msg Handler mailbox (mailbox.ts): handlers store what reaches them,
//     arrivals through a Level Transition deliver it (RFL 0x101369b0 / 0x10136af0).
//   * Level Transition Remover (p0 level paths, p1 input): forgets the stored state of those
//     levels ("Deleted transition: %s"), so a later visit starts them fresh.
//   * Chapters (chapters.ts): the forward-only chapter index, Level Properties p23 for a new
//     game; mirrored into saves.session.chapter (save names) and exposed for the loading
//     screen (campaign.chapter).
//   * GUI Launcher / Archives Trigger (launcher.ts): ending pictures, Game Finished, credits.
//   * Difficulty (difficulty.ts): services.difficulty, the per-level template lookups.
//
// Level Transition enable / disable (p6, p11, p12) and the transition itself are in
// src/game/world/logic.ts; the spawn point choice is in src/game/world/world.ts.
//
// Services: ctx.services.campaign (CampaignService), ctx.services.difficulty
// (DifficultyService). Save provider 'campaign' (scope 'game'). Debug: window.__campaign.

import type { GameContext, GameSystem } from '../runtime';
import type { WorldService } from '../world/world';
import type { WorldEntity } from '../world/logic';
import type { EntityPackageSet } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import { registerSave } from '../save/providers';
import { saves } from '../save/manager';
import { levelKey } from '../save/types';
import { difficulty } from './difficulty';
import { advanceChapter, chapterIndexOf, readChapters, type ChapterInfo } from './chapters';
import { campaign, type CampaignSaveState, type Ending } from './state';
import { LevelLaunchers } from './launcher';
import { keyLabel } from './mailbox';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refOf = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) && 'pkg' in (v as object) ? (v as ResRef) : null);

export interface TransitionInfo {
  uid: number;
  /** Target level (engine path, backslashes). */
  target: string;
  /** First target spawn name ('' = chosen by the level arrived from). */
  spawn: string;
  enabled: boolean;
  /** Chapter Properties ref ("pkg:id") named in p3, if any. */
  chapter?: string;
  /** Message that starts the transition (input slot 10). */
  message: number;
  position: [number, number, number];
}

export interface CampaignService {
  readonly chapters: readonly ChapterInfo[];
  readonly chapterIndex: number;
  /** Current chapter (its loading screen is the one the next transition shows). */
  readonly chapter: ChapterInfo | undefined;
  /** Entered through a Level Transition (not New Game / Load). */
  readonly arrival: boolean;
  readonly ending: Ending | undefined;
  transitions(): TransitionInfo[];
  /** Fire a Level Transition as its trigger would (tests / debug). Returns false when disabled. */
  fireTransition(uid: number, force?: boolean): boolean;
}

/** Ending from the reputation, with the bounds of the level's Reputation Points Message
 * Filters when it has a set of three (10 Docks: <= -90 evil, <= 70 neutral, else good). */
export function endingFor(reputation: number, filters: { lo: number; hi: number }[] = []): Ending {
  const sorted = [...filters].sort((a, b) => a.lo - b.lo);
  if (sorted.length === 3) {
    const i = sorted.findIndex((f) => reputation > f.lo && reputation <= f.hi);
    if (i >= 0) return (['evil', 'neutral', 'good'] as const)[i];
  }
  return reputation <= -90 ? 'evil' : reputation <= 70 ? 'neutral' : 'good';
}

export function createCampaignSystem(ctx: GameContext): GameSystem {
  const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
  difficulty.packages = pkgs;
  const chapters = readChapters(pkgs);
  if (chapters.length) campaign.chapters = chapters;
  const arrival = ctx.spawnName !== undefined;
  const log = (msg: string) => console.info(`[campaign] ${msg}`);
  const world = () => (ctx.services.world as WorldService | undefined)?.world;

  const unregister = registerSave<CampaignSaveState>(
    ctx.services,
    'campaign',
    {
      save: () => campaign.save(),
      load: (d) => campaign.load(d),
      reset: () => campaign.reset(),
    },
    { scope: 'game', priority: 2 },
  );

  const transitions = (): TransitionInfo[] =>
    (world()?.of('Level Transition') ?? []).map((t) => {
      const spawns = (t.e.props.targetSpawnNames as unknown[]) ?? [];
      const ch = refOf(t.e.values[3]);
      return {
        uid: t.uid,
        target: String(t.e.props.targetLevel ?? ''),
        spawn: (spawns.find((s) => typeof s === 'string') as string | undefined) ?? '',
        enabled: t.enabled && !t.destroyed,
        chapter: ch ? `${ch.pkg}:${ch.id}` : undefined,
        message: t.e.inputs.find((s) => s.slot === 10)?.message ?? 0,
        position: t.pos,
      };
    });

  const service: CampaignService = {
    get chapters() {
      return campaign.chapters;
    },
    get chapterIndex() {
      return campaign.chapterIndex;
    },
    get chapter() {
      return campaign.chapter;
    },
    arrival,
    get ending() {
      return campaign.ending;
    },
    transitions,
    fireTransition(uid, force = false) {
      const w = world();
      const t = w?.get(uid);
      if (!w || !t || t.cls !== 'Level Transition') return false;
      if (force) t.enabled = true;
      if (!t.enabled) return false;
      const m = t.e.inputs.find((s) => s.slot === 10)?.message || 1;
      w.send(uid, m, w.playerUid);
      return true;
    },
  };
  ctx.services.campaign = service;
  ctx.services.difficulty = difficulty;

  // --- Hooked into the world on the first update (the world system starts after us). ----
  let launchers: LevelLaunchers | null = null;
  const unhook: (() => void)[] = [];
  let started = false;

  const levelChapter = (): number => {
    const lp = world()?.of('Level Properties')[0];
    return chapterIndexOf(campaign.chapters, refOf(lp?.e.values[23]));
  };

  const start = () => {
    const w = world();
    if (started || !w) return;
    started = true;
    const container = ctx.view.renderer.domElement.parentElement ?? document.body;

    // Mailbox + Level Transition Remover.
    const handler = (e: WorldEntity, msg: number) => {
      if (e.cls === 'Level Transition Msg Handler') {
        campaign.mailbox.store(e.e, msg);
        log(`mailbox ${keyLabel(campaign.mailbox.entries[campaign.mailbox.entries.length - 1].key)} <- message ${msg} (#${e.uid.toString(16)})`);
        return true;
      }
      if (e.cls === 'Level Transition Remover' && msg === num(e.e.values[1], 1)) {
        for (const p of (Array.isArray(e.e.props.p0) ? e.e.props.p0 : Object.values(e.e.props)[0]) as unknown[]) {
          if (typeof p !== 'string') continue;
          const k = levelKey(p);
          if (saves.session.levels[k]) log(`deleted transition: ${p}`);
          delete saves.session.levels[k];
        }
        return true;
      }
      return false;
    };
    w.handlers.push(handler);
    unhook.push(() => {
      const i = w.handlers.indexOf(handler);
      if (i >= 0) w.handlers.splice(i, 1);
    });

    // Level Transitions: forward-only chapter, history.
    for (const t of w.of('Level Transition')) {
      const go = t.e.inputs.find((s) => s.slot === 10)?.message;
      unhook.push(
        w.subscribe(t.uid, (msg) => {
          if (go === undefined || msg !== go || !t.enabled || t.destroyed) return;
          const next = chapterIndexOf(campaign.chapters, refOf(t.e.values[3]));
          campaign.chapterIndex = advanceChapter(campaign.chapterIndex, next);
          const spawns = (t.e.props.targetSpawnNames as unknown[]) ?? [];
          campaign.history.push({
            from: ctx.levelPath,
            to: String(t.e.props.targetLevel ?? ''),
            spawn: (spawns.find((s) => typeof s === 'string') as string | undefined) ?? '',
            uid: t.uid,
            chapter: campaign.chapterIndex,
            at: Date.now(),
          });
          syncChapter();
        }),
      );
    }

    // GUI Launchers (ending pictures, Game Finished, credits) and Archives Triggers.
    launchers = new LevelLaunchers({
      world: w,
      pkgs: pkgs ?? new Map(),
      container,
      log,
      hud: () => ctx.services.hud as { notice?(text: string, template?: string): void } | undefined,
      onGameFinished: () => {
        const rep = num((ctx.services.insanity as { reputation?: number } | undefined)?.reputation);
        const filters = w.of('Reputation Points Message Filter').map((f) => ({ lo: num(f.e.values[1]), hi: num(f.e.values[2]) }));
        campaign.ending = endingFor(rep, filters.length === 3 ? filters : []);
        log(`game finished: reputation ${rep} -> ${campaign.ending} ending (${difficulty.name})`);
      },
    });
    launchers.start();

    // The chapter: a new game starts with the level's own (Level Properties p23).
    if (campaign.chapterIndex < 0) campaign.chapterIndex = Math.max(-1, levelChapter());
    syncChapter();

    // Arrival through a transition: the mailbox goes to this level's handlers.
    if (arrival) {
      const handlers = w.of('Level Transition Msg Handler').filter((h) => !h.destroyed);
      const sent = campaign.mailbox.deliver(
        handlers.map((h) => ({ uid: h.uid, values: h.e.values, links: h.e.links })),
        (to, m, from) => w.send(to, m, from),
      );
      for (const s of sent) {
        campaign.deliveries.push({ level: ctx.levelPath, key: keyLabel(s.key), handler: s.handler });
        log(`mailbox ${keyLabel(s.key)} -> #${s.handler.toString(16)} links (message ${s.message})`);
      }
    }
    log(`${ctx.levelPath}: chapter ${campaign.chapterIndex} (${campaign.chapter?.template ?? '-'}), ${difficulty.name}, ${arrival ? 'arrival' : 'start'}, mailbox [${campaign.mailbox.entries.map((e) => keyLabel(e.key)).join(', ')}]`);
  };

  /** Save names use the chapter title (saves.session.chapter is the Chapter Properties ref). */
  function syncChapter() {
    const ch = campaign.chapter;
    if (ch) {
      saves.session.chapter = ch.template;
      saves.nextChapter = undefined;
    }
  }

  Object.assign(window, { __campaign: { state: campaign, service, difficulty, launchers: () => launchers } });

  let synced = false;
  return {
    name: 'campaign',
    update(dt) {
      start();
      // levelReady (after every system started) may have restored the session's chapter:
      // keep the forward-only one.
      if (!synced && started) {
        synced = true;
        syncChapter();
      }
      launchers?.update(dt);
    },
    dispose() {
      for (const f of unhook) f();
      launchers?.dispose();
      unregister();
      if (ctx.services.campaign === service) delete ctx.services.campaign;
      if (ctx.services.difficulty === difficulty) delete ctx.services.difficulty;
    },
  };
}
