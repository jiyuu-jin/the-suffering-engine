// Insanity game system: the insanity meter, the player's creature form, reputation,
// adrenaline, the insanity-related level classes and the screen effects (blur, faders,
// hallucination flashes, slow motion) for chapter 1. Rules: docs/game-logic.md §13.
//
// Service published on ctx.services:
//
//   services.insanity: InsanityService
//     meter: number         0..1 (meter / Player p258)
//     transformed: boolean  creature form, including the morph animations
//     available: boolean    meter full and transforming allowed (Insanity key works)
//     reputation: number    good (+) / evil (-) points; carried between levels and saved
//     enabled: boolean      meter shown (false while the level forbids both transforming and gain)
//     mode: 'normal' | 'morphing' | 'insane' | 'reverting'
//     adrenaline: number    0..100 (Adrenaline Senders, heartbeat rate)
//     setMeter(fraction), transform(), revert(), addReputation(points, fromUid?)
//
// Consumed (all optional): services.world (World handlers, messages, inCutscene),
// services.actors (list, damage, 'damage' events for kill credit), services.combat
// (health drain, player death), services.weapons (setEnabled(false) / enabled = false while
// transformed), services.save (game-scope provider 'insanity').
//
// Keys: Q = Insanity (the HUD's control table binds <Insanity> to Q). While transformed the
// left mouse button attacks (jump + attack = slam), the right one uses the alternate attack;
// the mouse never reaches the human weapons then (capture-phase listener). Jump (Space) while
// transformed performs the acquired insanity attack (input 0x42a -> state 29, 0x10049e63), a
// plain jump while none is acquired.
//
// Also (docs/game-logic.md §13): with a weapon in hand the p256 put-away clip plays before the
// morph; kills while transformed count towards the p276 insanity attacks (acquired at their
// p0 thresholds with the p275 clip, saved); kills made in the air get the p262 multiplier; the
// low-meter warning is player event 9 (creature p301: a Help Popup, shown once per game); the
// Screen Blurs' C values scale the effects / music buses; changing back after blood was added
// while transformed fills the blood level (services.repskin.changedBack()).
//
// Debug: window.__insanity { service, model, director, setMeter(0..1), transform(),
// revert(), flash(), blur(), fade(), slowmo(), attack(), unlock(n) }.

import { padPlaying } from '../hud/bindings';
import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import type { EntityPackageSet } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { World } from '../world/logic';
import { CutsceneLibrary, CutscenePlayer } from '../../app/cutscene';
import { MOVIE_DIALOG_FADE } from '../../app/audio-rules';
import { registerSave } from '../save/providers';
import { readInsanityParams, readAdrenalineTemplate, num, ref, templateValues, keyOf, type InsanityParams } from './params';
import { defaultPersist, InsanityModel, type Form, type InsanityPersist } from './rules';
import { ScreenEffects } from './effects';
import { BlurRun, EffectDirector, TextureCache, TimeScaleRun, type FaderRun } from './screen';
import { InsanityClasses, templateBlur, templateFader } from './classes';
import { CreatureBody, type ActorLike } from './creature';
import { PLAYER_TEAM } from '../actors/behaviors';
import { readXduString } from '../../formats/entities';
import { hudBus } from '../hud/bus';
import { weaponFx } from '../weapons/fx';
import { clipMarks } from '../weapons/system';
import { LEGACY_LIGHTING, engineLights } from '../../app/engine-light';
import type { PackageSet } from '../../formats/model';
import { MorphLight, morphLightDefs } from './morph-light';
import { loadClip } from '../actors/clipmap';
import type { InsanityAttackDef } from './params';

export interface InsanityService {
  readonly meter: number;
  readonly transformed: boolean;
  readonly available: boolean;
  readonly reputation: number;
  readonly enabled: boolean;
  readonly mode: 'normal' | 'morphing' | 'insane' | 'reverting';
  readonly adrenaline: number;
  setMeter(fraction: number): void;
  transform(): boolean;
  revert(): void;
  /** Reputation change from game code; calls naming a Reputation Points Sender are ignored (handled here). */
  addReputation(points: number, fromUid?: number): void;
  /** Advance running Screen Faders / Blurs by `seconds` (skipped cinematics end in their end state). */
  fastForwardScreen(seconds: number): void;
  /** The current form's reputation range p70 / p71 (evil, good). */
  readonly reputationRange?: readonly [number, number];
  /** Reputation set outright (Game Cheats cases 9 / 10: Player 0x100414b0 / 0x10041480). */
  setReputation?(points: number): void;
  /** Game Cheats case 14: the next insanity attack while transformed (rules.ts acquireNext). */
  acquireNextAttack?(): boolean;
  /** The engine clock outside Time Scale runs (Game Cheats 20 / 21: 1.3 / 0.7 / 1; screen.ts baseRate). */
  setClockRate?(rate: number): void;
  /**
   * Player event n (0x10041740): the current form's Help Popup p292 + n, once per game (+0xa0
   * bit n). Event 6 (p298) is the Xombium hint (a <Health> control placeholder).
   */
  playerEvent?(n: number): void;
}

/** Carried across level loads when no save service restores it. */
const carried: InsanityPersist = defaultPersist();

interface WorldLike {
  world: World;
  readonly inCutscene: boolean;
}
interface ActorsLike {
  list(): readonly (ActorLike & { entity?: { values: unknown[] }; kind?: { template?: ResRef; className?: string } })[];
  damage(a: ActorLike, amount: number, from?: THREE.Vector3Like): boolean;
  on(ev: 'damage' | 'death', fn: (a: ActorLike, info?: unknown) => void): () => void;
}
interface CombatLike {
  readonly player: { readonly health: number; readonly alive: boolean };
  damagePlayer(amount: number, source?: unknown): void;
}

export async function createInsanitySystem(ctx: GameContext): Promise<GameSystem> {
  const { view, audio } = ctx;
  const pkgs = ctx.loaded.packages as EntityPackageSet | undefined;
  if (!pkgs) return { name: 'insanity (no packages)' };
  const params: InsanityParams | undefined = readInsanityParams(pkgs);
  const log = (msg: string) => console.info(`[insanity] ${msg}`);

  const model = params ? new InsanityModel(params, carried) : null;
  const fx = new ScreenEffects(view);
  // The clock: the Time Scale runs' rate times the morph's slow-down (1 / p272 while morphing).
  // The morph sets the engine clock and then 1, so a cheat's clock (director.baseRate) ends there.
  const director: EffectDirector = new EffectDirector(fx, (rate) => {
    const morph = model?.clockRate ?? 1;
    if (morph !== 1) director.baseRate = 1;
    view.timeScale = rate * morph;
  });
  const textures = new TextureCache(pkgs);
  // The morph's light (the form's Player p274 at the player, morph-light.ts): a point light of
  // the engine light rig, so the first morph rebuilds no lit material.
  const morphLight = new MorphLight();
  const offMorphLight = LEGACY_LIGHTING ? () => {} : engineLights.addProvider((out) => morphLight.write(out));
  const startMorphLight = (gen: ResRef | undefined) => morphLight.start(morphLightDefs(pkgs as unknown as PackageSet, gen), view.player.position);
  const world = () => ctx.services.world as WorldLike | undefined;
  const actors = () => ctx.services.actors as ActorsLike | undefined;
  const combat = () => ctx.services.combat as CombatLike | undefined;
  const inCutscene = () => !!world()?.inCutscene;

  const play2D = (r: ResRef | string, volume = 1, rate = 1) => {
    const k = typeof r === 'string' ? r : keyOf(r);
    if (!audio.get(k)) return;
    audio.play(k, { bus: 'sfx', volume, playbackRate: rate });
  };

  // --- Movies (Movie Player): the cutscene player's public API only. --------------------
  let movies: { lib: CutsceneLibrary; player: CutscenePlayer } | null = null;
  const playMovie = async (video: ResRef) => {
    movies ??= { lib: new CutsceneLibrary(ctx.fs), player: new CutscenePlayer() };
    const wasEnabled = view.player.enabled;
    view.player.enabled = false;
    // A movie mutes effects and music at once and fades dialog out over 1 s; all come back at
    // once afterwards (original rule, docs/re/audio.md §7).
    ctx.audio.fadeBus('sfx', 1, 0);
    ctx.audio.fadeBus('music', 1, 0);
    ctx.audio.fadeBus('voice', 1, MOVIE_DIALOG_FADE);
    try {
      await movies.player.play(await movies.lib.load(video.pkg, video.id));
    } finally {
      view.player.enabled = wasEnabled && view.walking;
      ctx.audio.fadeBus('sfx', 0, 0);
      ctx.audio.fadeBus('music', 0, 0);
      ctx.audio.fadeBus('voice', 0, 0);
    }
  };

  // --- Level classes. ---------------------------------------------------------------------
  let classes: InsanityClasses | null = null;
  const hookWorld = () => {
    const w = world();
    if (classes || !w?.world) return;
    classes = new InsanityClasses({
      world: w.world,
      model,
      director,
      textures,
      pkgs,
      playSound: (r) => play2D(r),
      playMovie,
      inCutscene,
      clockRate: () => view.timeScale,
      log,
    });
    classes.start();
  };

  // The world system starts before this one: register the classes now, so messages its
  // first update delivers (Timers with no delay) already reach them.
  hookWorld();

  // --- Creature form. --------------------------------------------------------------------
  const body = params?.creature ? CreatureBody.create(pkgs, params.creature, params.human) : null;
  if (body && model) {
    // The morph's timing: each lead-in clip up to its MorphCharacter marker, then the morpher.
    model.morphLead.morphIn = body.leadSeconds('in');
    model.morphLead.morphOut = body.leadSeconds('out');
    // The lead-in clips' sound cues (one of the clip's pool, as the player's own sounds).
    body.onSound = (keys) => {
      const ok = keys.filter((k) => audio.get(k));
      if (ok.length) play2D(ok[Math.floor(Math.random() * ok.length)]);
    };
  }
  let humanModel: THREE.Object3D | null = null;
  let savedMode: 'fp' | 'tp' | null = null;
  let savedSpeeds: { walk: number; run: number } | null = null;
  let viewmodelHidden = false;
  let weaponsOff = false;
  const formRuns: { blur?: BlurRun; tint?: FaderRun; morphBlur?: BlurRun } = {};

  const setWeapons = (on: boolean) => {
    const w = ctx.services.weapons as { setEnabled?(on: boolean): void; enabled?: boolean } | undefined;
    if (!w) return;
    if (typeof w.setEnabled === 'function') w.setEnabled(on);
    else if ('enabled' in w) w.enabled = on;
  };

  const showModel = (obj: THREE.Object3D | null) => {
    const p = view.player;
    if (!humanModel) humanModel = p.root.children.find((c) => c.name === 'player-body') ?? null;
    p.setModel(obj ?? humanModel);
    // The forms' rigs stay under the player (hidden) while human: the reputation skin's scene
    // scan keeps the morph's human rig in Torque's current skin before it is first shown.
    if (!obj && body && body.group.parent !== p.root) p.root.add(body.group);
  };
  if (body) view.player.root.add(body.group);

  const enterCreature = () => {
    const p = view.player;
    // The view to give back: the chosen one, not a hit reaction's third person (stateTp).
    if (!savedMode) savedMode = p.chosenMode();
    p.setMode('tp');
    if (!savedSpeeds && body) {
      savedSpeeds = { walk: p.motor.cfg.walkSpeed, run: p.motor.cfg.runSpeed };
      p.motor.cfg.walkSpeed = savedSpeeds.walk * body.speedScale;
      p.motor.cfg.runSpeed = savedSpeeds.run * body.speedScale;
    }
    if (!weaponsOff) (weaponsOff = true), setWeapons(false);
  };

  const leaveCreature = () => {
    const p = view.player;
    if (savedSpeeds) {
      p.motor.cfg.walkSpeed = savedSpeeds.walk;
      p.motor.cfg.runSpeed = savedSpeeds.run;
      savedSpeeds = null;
    }
    if (savedMode) p.setMode(savedMode), (savedMode = null);
    if (weaponsOff) (weaponsOff = false), setWeapons(true);
    p.setVirtualInput(null);
  };

  /** A save's creature form being put back (insanity provider): no flash, no morph wait. */
  let restoringForm = false;
  const onForm = (form: Form, prev: Form) => {
    log(`form ${prev} -> ${form} (meter ${model?.s.meter.toFixed(1)})`);
    const human = params!.human;
    if (form === 'morphIn') {
      putAwayHidden = false;
      enterCreature();
      view.player.setVirtualInput({ forward: 0, strafe: 0 });
      if (body) {
        showModel(body.group);
        // (A loaded save in creature form: the creature at once, no morph.)
        if (restoringForm) body.showCreature();
        else body.startMorph('in', human.morph);
      }
      if (!restoringForm) startMorphLight(human.morphEffect);
      // The morph-in's Screen Blur (p273, 0x100441f5..0x1004426f; on the game clock, so it
      // mostly runs once the morph has given the clock back).
      const mb = restoringForm ? undefined : templateBlur(pkgs, human.morphBlur);
      if (mb) {
        formRuns.morphBlur = new BlurRun({ ...mb, destroyAtEnd: true });
        director.blurs.add(formRuns.morphBlur);
        formRuns.morphBlur.start();
      }
      // Transformation flash (p267) and the creature-form blur / tint (p265 / p266).
      const flash = restoringForm ? undefined : templateFader(pkgs, human.flash);
      if (flash && classes) classes.spawnFader(flash);
      const bp = templateBlur(pkgs, human.blur);
      if (bp) {
        formRuns.blur = new BlurRun({ ...bp, destroyAtEnd: true });
        director.blurs.add(formRuns.blur);
        formRuns.blur.start();
      }
      const tint = templateFader(pkgs, human.tint);
      if (tint && classes) formRuns.tint = classes.spawnFader({ ...tint, destroyAtEnd: true });
    } else if (form === 'creature') {
      body?.endMorph();
      morphLight.stop();
      view.player.viewOrbit = 0;
      view.player.setVirtualInput(null);
    } else if (form === 'morphOut') {
      view.player.setVirtualInput({ forward: 0, strafe: 0 });
      if (body) {
        showModel(body.group);
        body.startMorph('out', params!.creature?.morph);
      }
      startMorphLight(params!.creature?.morphEffect ?? human.morphEffect);
      formRuns.blur?.stop();
      formRuns.tint?.stop();
    } else if (form === 'human') {
      // Changing back: blood added while transformed fills the level (message 221 -> 0x100444c0,
      // sent by the morpher's end; the instant change back of a cinematic runs it too, 0x10033346).
      (ctx.services.repskin as { changedBack?(): void } | undefined)?.changedBack?.();
      body?.endMorph();
      morphLight.stop();
      body?.hide();
      view.player.viewOrbit = 0;
      showModel(null);
      formRuns.blur?.stop();
      formRuns.tint?.stop();
      formRuns.blur = formRuns.tint = undefined;
      leaveCreature();
    }
  };

  if (model) {
    model.events = {
      form: onForm,
      heartbeat: (vol, pitch) => {
        if (model.s.adrenaline < 1 && !model.transformed) return;
        const k = params!.human.heartSounds;
        if (k.length) play2D(k[Math.floor(Math.random() * k.length)], Math.min(1, vol * 2), pitch);
      },
      breath: () => {
        if (model.s.adrenaline < 25) return;
        const k = model.current.breathSounds;
        if (k.length) play2D(k[Math.floor(Math.random() * k.length)], 0.5);
      },
      lowMeter: () => log('meter low'),
      drainHealth: (amount) => combat()?.damagePlayer(amount, 'insanity'),
      playerEvent: (n) => showPlayerEvent(n),
      acquire: (a) => {
        log(`insanity attack ${a.index} acquired (${keyOf(a.template)}, threshold ${a.threshold})`);
        // State 30: the acquisition clip (p275) on the creature.
        body?.special(params!.creature?.acquireClip);
      },
      putAway: (seconds) => {
        log(`putting the weapon away (${seconds.toFixed(2)} s)`);
        const pb = (ctx.services.actors as { playerBody?: { play(c: ResRef, o?: { lock?: boolean }): number } | null } | undefined)?.playerBody;
        if (params!.human.putAway) pb?.play(params!.human.putAway, { lock: true });
        // The weapon leaves the hands during the clip [inferred: 2:711 has no Stow marker].
        timers.push({
          at: clock + seconds * 0.4,
          fn: () => {
            if (model.putAwayLeft <= 0) return;
            setWeapons(false);
            putAwayHidden = true;
          },
        });
      },
    };
  }

  /** The put-away hid the weapons; undone if the transformation is cancelled before the morph. */
  let putAwayHidden = false;

  // --- Player events (Help Popups of the current form, p292 + n; 0x10041740). ----------------
  let helpUntil = 0;
  let helpText: string | null = null;
  const showPlayerEvent = (n: number) => {
    const t = templateValues(pkgs, ref(model?.current.values[292 + n]));
    if (!t || t.cls !== 'Help Popup') return;
    const text = readXduString(pkgs, ref(t.values[8]) ?? { pkg: 0, id: 0 });
    if (!text) return;
    log(`player event ${n}: help "${text}"`);
    helpText = text;
    hudBus.help = { text, at: hudBus.clock };
    helpUntil = clock + 7;
  };

  // --- Insanity attacks (state 29, 0x10033e00 / 0x10034566). ------------------------------
  const timers: { at: number; fn: () => void }[] = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const radiusDamage = (gen: ResRef | undefined) => {
    const out: { max: number; min: number; outer: number; inner: number; type: number }[] = [];
    const g = templateValues(pkgs, gen);
    for (const c of Array.isArray(g?.values[0]) ? (g!.values[0] as (ResRef | null)[]) : []) {
      const t = c && templateValues(pkgs, c);
      if (t && t.cls === 'Radius Damage') out.push({ max: num(t.values[0]), min: num(t.values[1]), outer: num(t.values[5]), inner: 0, type: num(t.values[10]) }); // p5 radius, linear from the centre; p2 / p3 are force (RFL 0x10125c70)
    }
    return out;
  };
  const strike = (a: InsanityAttackDef) => {
    const at = new THREE.Vector3(view.player.position.x, view.player.position.y + 1, view.player.position.z);
    const fx = weaponFx(ctx.services);
    // Effects of the attack generator (shake, particles, sounds): everything but the damage.
    const g = templateValues(pkgs, a.generator);
    for (const c of Array.isArray(g?.values[0]) ? (g!.values[0] as (ResRef | null)[]) : []) {
      if (c && templateValues(pkgs, c)?.cls !== 'Radius Damage') fx.spawn(c, at, UP);
    }
    // Radius Damage: full to the inner radius, down to the minimum at the outer one.
    const dmg = ctx.services.damage as { apply(e: Record<string, unknown>): { hits: unknown[] } } | undefined;
    const rd = radiusDamage(a.generator);
    for (const r of rd) dmg?.apply({ point: at, amount: r.max, minAmount: r.min, radius: r.outer, innerRadius: r.inner, kind: r.type, source: 'player' });
    // p4 at each target in reach, after a random p8..p9 s delay.
    const reach = Math.max(0, ...rd.map((r) => r.outer));
    for (const t of actors()?.list() ?? []) {
      if (!t.alive || t.hidden || t.kind?.decor || !a.targetGenerator) continue;
      if (Math.hypot(t.position.x - at.x, t.position.z - at.z) > reach) continue;
      const delay = a.delay[0] + Math.random() * Math.max(0, a.delay[1] - a.delay[0]);
      const p = new THREE.Vector3(t.position.x, t.position.y + 1, t.position.z);
      timers.push({ at: clock + delay, fn: () => void fx.spawn(a.targetGenerator, p, UP) });
    }
    log(`insanity attack ${a.index}: ${rd.length} radius damage, reach ${reach} m`);
  };
  const performAttack = (): boolean => {
    const a = model?.currentAttack;
    if (!a || !body || model?.form !== 'creature' || body.busy) return false;
    const dur = body.special(a.clip);
    if (dur <= 0) return false;
    // The strike lands at the clip's first marker (2:389: 0.76 s), else halfway.
    const marks = a.clip ? clipMarks(pkgs as never, a.clip) : [];
    const hit = marks.length ? Math.min(...marks.map((m) => m.time)) : dur * 0.5;
    timers.push({ at: clock + Math.min(dur, hit), fn: () => model?.form === 'creature' && strike(a) });
    return true;
  };

  // --- Kill credit. ----------------------------------------------------------------------
  let lastMelee = -1e9;
  let clock = 0;
  const playerPos = view.player.position;
  const valuesOf = (a: ActorLike & { entity?: { values: unknown[] }; kind?: { template?: ResRef } }) => {
    const tv = templateValues(pkgs, a.kind?.template)?.values ?? [];
    const ev = (a.entity?.values ?? []) as (number | null)[];
    return { points: num((ev[66] as number) ?? tv[66]), rep: num((ev[166] as number) ?? tv[166]) };
  };
  let unhookActors: (() => void) | undefined;
  /** Idle fidgets of the player body: reputation and the "creature nearby" check (p241). */
  const hookFidgets = () => {
    const pb = (ctx.services.actors as { playerBody?: { fidgetContext?: unknown } | null } | undefined)?.playerBody;
    if (!pb || !model || pb.fidgetContext) return;
    pb.fidgetContext = {
      reputation: () => model.s.reputation,
      threatNear: (radius: number) => {
        const p = view.player.position;
        for (const a of actors()?.list() ?? []) {
          const x = a as ActorLike & { hostile?: boolean; provoked?: boolean };
          if (!x.alive || x.hidden || x.kind?.decor) continue;
          if (x.hostile === false && !x.provoked) continue;
          if (Math.hypot(a.position.x - p.x, a.position.y - p.y, a.position.z - p.z) <= radius) return true;
        }
        return false;
      },
    };
  };
  const hookActors = () => {
    hookFidgets();
    const ac = actors();
    if (unhookActors || !ac || !model) return;
    unhookActors = ac.on('damage', (a, info) => {
      const ev = info as { killed?: boolean; source?: unknown } | undefined;
      if (!ev?.killed) return;
      // Only the player's kills fill the meter. Older event sources without `source` fall
      // back to the 30 m proximity rule [inferred].
      if (ev.source !== undefined ? ev.source !== 'player' : Math.hypot(a.position.x - playerPos.x, a.position.y - playerPos.y, a.position.z - playerPos.z) > 30) return;
      const v = valuesOf(a as never);
      const melee = model.transformed || clock - lastMelee < 1.2;
      // Kill reputation (victim p166) is added by the actors system via addReputation;
      // pass 0 here so it isn't counted twice.
      const gain = model.onKill({ points: v.points, reputation: 0, melee, meleeWeapon: melee && !model.transformed, airborne: !view.player.onGround });
      if (v.points || v.rep) log(`kill +${gain.toFixed(1)} (p66 ${v.points}) -> ${model.s.meter.toFixed(1)} / ${model.max}`);
    });
  };

  // --- Input. ----------------------------------------------------------------------------
  const dom = view.renderer.domElement;
  const canAct = () => view.walking && view.player.enabled && !inCutscene() && (combat()?.player.alive ?? true);
  /** The put-away clip's length when a weapon is in hand (p256), else 0. */
  const putAwaySeconds = () => {
    const w = ctx.services.weapons as { current?: unknown } | undefined;
    const r = params?.human.putAway;
    if (!w?.current || !r) return 0;
    const c = loadClip(pkgs as never, r);
    return c ? c.duration / (c.rate || 1) : 0;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || !model || !canAct()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
      // Jump while transformed: the acquired insanity attack (else the jump goes through).
      if (model.form === 'creature' && model.currentAttack && performAttack()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.code !== 'KeyQ') return;
    if (model.pressInsanity(model.form === 'human' ? { putAway: putAwaySeconds() } : {})) e.preventDefault();
  };
  const onMouse = (e: MouseEvent) => {
    if (e.button === 0) lastMelee = clock;
    // Pointer lock for mouse play; a pad (synthetic Fire / Throw buttons) acts without it.
    if (!model || model.form === 'human' || (document.pointerLockElement !== dom && !padPlaying()) || !view.walking) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (model.form !== 'creature' || !body || !canAct()) return;
    // No attack in the air: the creature form's air-attack clip (PWP p164) is empty.
    if (!view.player.onGround) return;
    if (e.button === 0) body.attack('combo', meleeWorld(), view.player);
    else if (e.button === 2) body.attack('alt', meleeWorld(), view.player);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);

  // Creature animation + hits ride on the player's frame (same dt as the motor). The swept arm
  // weapons (creature.ts / melee.ts) report each blow with its contact point.
  const meleeWorld = () => ({
    actors: actors()?.list() ?? [],
    blocked: (a: number[], b: number[]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], d = Math.hypot(dx, dy, dz);
      if (d < 1e-3) return false;
      const h = view.collision?.raycast(a[0], a[1], a[2], dx / d, dy / d, dz / d, d);
      return !!h && h.distance < d - 0.05;
    },
    reputation: model?.s.reputation ?? 0,
    playerTeam: PLAYER_TEAM,
    spheres: (a: unknown) => (actors() as { hitSpheres?(x: unknown): { c: [number, number, number]; r: number }[] } | undefined)?.hitSpheres?.(a) ?? [],
    priority: (a: unknown) => templatePriority((a as { kind?: { template?: ResRef } }).kind?.template),
  });
  // Auto-target priority: the character template's p128 (the melee auto-face pick, melee-face.ts).
  const priorities = new Map<string, number>();
  const templatePriority = (r: ResRef | undefined): number => {
    if (!r) return 10;
    const k = keyOf(r);
    let v = priorities.get(k);
    if (v === undefined) {
      const n = pkgs ? templateValues(pkgs, r)?.values[128] : undefined;
      v = typeof n === 'number' && Number.isFinite(n) ? n : 10;
      priorities.set(k, v);
    }
    return v;
  };
  const unsubFrame = view.player.onUpdate((f) => {
    if (!body || !model || model.form === 'human') return;
    // The frame's real time: a morph runs on it while the clock is slowed (rules.ts clockRate).
    const rate = view.timeScale;
    const hits = body.update(f, view.player, meleeWorld(), model.form === 'creature', rate > 0 ? f.dt / rate : f.dt);
    // The morph's camera orbit (Player +0x4aa).
    view.player.viewOrbit = model.form === 'morphIn' || model.form === 'morphOut' ? body.orbit : 0;
    const ac = actors();
    if (!ac) return;
    const dmg = ctx.services.damage as { apply(e: Record<string, unknown>): unknown } | undefined;
    for (const h of hits)
      for (const a of h.actors) {
        // A Torque vision struck while transformed: the blow lands on the player (0x10087010).
        if (h.reflect) {
          combat()?.damagePlayer(h.damage, 'insanity');
          continue;
        }
        const point = h.point ? { x: h.point[0], y: h.point[1], z: h.point[2] } : { x: a.position.x, y: a.position.y + 1, z: a.position.z };
        // Through the damage router when it runs (kill credit, resistances by type), like the weapons.
        const uid = (a as { uid?: number; entity?: { uid: number } }).uid ?? (a as { entity?: { uid: number } }).entity?.uid;
        // The struck leaf's bone and the impact force go with it (Part Caps, the hit reaction).
        if (dmg) dmg.apply({ point, amount: h.damage, kind: h.kind, force: h.force, bone: h.bone, source: view.player.position.clone(), ...(uid !== undefined ? { targetUid: uid } : { actor: a }) });
        else ac.damage(a, h.damage, view.player.position);
      }
  });

  // --- Save / carry-over. ----------------------------------------------------------------
  const offSave = model
    ? registerSave(
        ctx.services,
        'insanity',
        {
          // `form`: the creature form is part of the save. The original allows saving while
          // transformed (its can-save predicate refuses Morph, state 19, not Transformed, 20:
          // docs/re/saves.md §5) and a load rebuilds the Player in that state; mid-morph saves
          // (checkpoints) keep the form the morph goes to.
          // `combo`: the kill-combo window and count (Player +0x45c / +0x464), so a kill right
          // after a load still counts as the combo's next one.
          save: () => ({ ...model.s, form: model.form === 'morphIn' || model.form === 'creature' ? 'creature' : 'human', combo: [Math.round(model.comboTimer * 1000) / 1000, model.comboCount] }),
          load: (d: InsanityPersist & { form?: string; combo?: number[] }, info) => {
            const { form, combo, ...persist } = d ?? {};
            Object.assign(model.s, defaultPersist(), persist);
            // A loaded save only (a level transition starts the next level as it always did).
            if (info.reason !== 'load') return;
            if (Array.isArray(combo)) [model.comboTimer, model.comboCount] = [Number(combo[0]) || 0, Number(combo[1]) || 0];
            if (form === 'creature') {
              restoringForm = true;
              try {
                model.restoreCreature();
              } finally {
                restoringForm = false;
              }
            }
            else if (model.form !== 'human') model.revert(false, true);
          },
          reset: () => Object.assign(model.s, defaultPersist()),
        },
        { scope: 'game', priority: 25 },
      )
    : () => {};
  // No manual saving while the weapon is being put away for the morph (the morph itself is
  // refused by the save system's original rule, rules.ts: Morph state 19).
  const save = ctx.services.save as { addVeto?(fn: () => string | null): () => void } | undefined;
  const offVeto = model && typeof save?.addVeto === 'function' ? save.addVeto(() => (model.putAwayLeft > 0 ? 'morphing' : null)) : () => {};

  // --- Service. --------------------------------------------------------------------------
  const service: InsanityService = {
    fastForwardScreen: (seconds) => director.fastForward(seconds),
    playerEvent: (n) => model?.fireEvent(n),
    get meter() {
      return model?.fraction ?? 0;
    },
    get transformed() {
      return !!model?.transformed;
    },
    get available() {
      return !!model?.available;
    },
    get reputation() {
      return model?.s.reputation ?? 0;
    },
    get enabled() {
      return !!model && !(model.s.noTransform && model.s.noGain && model.s.meter <= 0);
    },
    get mode() {
      const f = model?.form ?? 'human';
      return f === 'human' ? 'normal' : f === 'morphIn' ? 'morphing' : f === 'creature' ? 'insane' : 'reverting';
    },
    get adrenaline() {
      return model?.s.adrenaline ?? 0;
    },
    setMeter: (fraction) => model?.setMeter(fraction * model.max),
    get reputationRange() {
      return model ? model.current.reputationRange : undefined;
    },
    setReputation: (n) => {
      if (!model) return;
      model.s.reputation = n;
      log(`reputation set to ${n}`);
    },
    acquireNextAttack: () => !!model?.acquireNext(),
    setClockRate: (rate) => {
      director.baseRate = rate;
    },
    transform: () => !!model && (model.form === 'human' ? model.pressInsanity() : false),
    revert: () => model?.revert(),
    addReputation: (n, fromUid) => {
      // Reputation Points Senders are handled by this system's own class handler (classes.ts);
      // the actors system's director reports them too, so those calls are ignored.
      if (fromUid !== undefined && world()?.world.get(fromUid)?.cls === 'Reputation Points Sender') return;
      if (!model || !n) return;
      model.s.reputation += n;
      log(`reputation ${n >= 0 ? '+' : ''}${n}${fromUid !== undefined ? ` (#${fromUid.toString(16)})` : ''} -> ${model.s.reputation}`);
    },
  };
  ctx.services.insanity = service;

  // FOV pulse with the heartbeat (p270/p271), scaled by adrenaline [amplitude inferred].
  let fovFactor = 1;
  let fovApplied = view.camera.fov;
  const applyFov = (factor: number) => {
    const cam = view.camera;
    if (cam.fov !== fovApplied) fovFactor = 1; // someone else set the lens
    const base = cam.fov / fovFactor;
    cam.fov = base * factor;
    fovFactor = factor;
    fovApplied = cam.fov;
    cam.updateProjectionMatrix();
  };

  // Screen Blur C (sound mixer level): scales the effects / music buses on top of the
  // player's volume settings; restored when no blur runs.
  let ducked = 1;
  const applyAudioLevel = (level: number) => {
    if (Math.abs(level - ducked) < 1e-3) return;
    ducked = level;
    const a = audio as unknown as { busNode?(b: string): GainNode; getBusVolume?(b: string): number; context?: AudioContext };
    if (!a.busNode || !a.getBusVolume || !a.context) return;
    for (const bus of ['sfx', 'music']) a.busNode(bus).gain.setTargetAtTime(a.getBusVolume(bus) * level, a.context.currentTime, 0.05);
  };

  const debug = {
    morphLight,
    service,
    model,
    director,
    effects: fx,
    body,
    get classes() {
      return classes;
    },
    setMeter: (v: number) => service.setMeter(v),
    transform: () => model?.pressInsanity(),
    revert: () => model?.revert(),
    flash: () => {
      const fl = classes?.flash?.w.e.values[6] as ResRef[] | undefined;
      const t = templateFader(pkgs, fl?.[Math.floor(Math.random() * (fl?.length ?? 1))] ?? params?.human.flash);
      return t && classes?.spawnFader(t);
    },
    blur: (on = true) => {
      const bp = templateBlur(pkgs, params?.human.values[357] as ResRef);
      if (!bp) return;
      const run = new BlurRun({ ...bp, destroyAtEnd: true });
      director.blurs.add(run);
      if (on) run.start();
      return run;
    },
    fade: (color = 0x000000, alpha = 1, hold = 1) =>
      classes?.spawnFader({ fadeIn: 0.3, hold, fadeOut: 0.6, autoStart: true, destroyAtEnd: true, p5: 0, texture: null, color, alpha, sound: null, soundAt: 0 }),
    slowmo: (percent = 20, seconds = 3) => {
      const c = new TimeScaleRun(percent, 0.1, 0.1);
      director.clocks.add(c);
      c.on();
      setTimeout(() => c.off(), seconds * 1000);
      setTimeout(() => director.clocks.delete(c), seconds * 1000 + 1000);
      return c;
    },
    /** Perform the acquired insanity attack (as the Jump key while transformed). */
    attack: () => performAttack(),
    /** Acquire insanity attacks up to index n (debug: the thresholds need later chapters). */
    unlock: (n = 0) => {
      if (!model) return;
      model.s.attackIndex = Math.max(model.s.attackIndex, Math.min(n, model.attacks.length - 1));
      model.s.attackPoints = 0;
    },
    adrenaline: (r: ResRef = { pkg: 2, id: 534 }) => {
      const t = readAdrenalineTemplate(pkgs, r);
      if (t) model?.applyAdrenaline(t);
    },
  };
  Object.assign(window, { __insanity: debug });
  log(
    params
      ? `ready: max ${params.human.meterMax}, drain ${params.creature ? `${params.creature.drainRate.join('..')}/s` : '-'}, creature body ${body ? `ok (speed x${body.speedScale.toFixed(2)}, attacks ${JSON.stringify(body.attackCount)})` : 'missing'}`
      : 'Player template not found - meter disabled',
  );

  return {
    name: 'insanity',
    update(dt: number) {
      hookWorld();
      hookActors();
      const realDt = view.timeScale > 0 ? dt / view.timeScale : dt;
      clock += dt;
      morphLight.step(dt);
      if (model) {
        // Cutscenes and death end the transformation at once [inferred from the cinematic
        // entry points that call the revert routine].
        const alive = combat()?.player.alive ?? true;
        if (model.transformed && (!alive || inCutscene())) model.revert(false, true);
        model.update(dt, realDt);
        if (putAwayHidden && model.form === 'human' && model.putAwayLeft <= 0) {
          putAwayHidden = false;
          setWeapons(true);
        }
        classes?.updateFlash(dt);
        if (model.transformed) {
          if (view.player.mode !== 'tp') view.player.setMode('tp');
        }
        // FOV pulse.
        const t = model.s.adrenaline / 100;
        const [f0, f1] = model.current.fovPulse;
        const amp = f0 > 0 ? ((f1 - f0) / f0) * Math.min(1, t) * 0.5 : 0;
        const pulse = Math.abs(Math.sin((Math.PI * model.sinceBeat) / model.heartPeriod));
        applyFov(inCutscene() || amp <= 0 ? 1 : 1 + amp * pulse);
        director.vignette = model.form === 'creature' ? 0.35 : model.transformed ? 0.2 : 0;
      }
      director.update(dt, realDt);
      for (let i = timers.length - 1; i >= 0; i--) if (clock >= timers[i].at) timers.splice(i, 1)[0].fn();
      if (helpText && clock > helpUntil) {
        if (hudBus.help?.text === helpText) hudBus.help = null;
        helpText = null;
      }
      applyAudioLevel(director.audioLevel);
      // The first-person layer (arms, weapons) is hidden while transformed and under
      // opaque full-screen images.
      const hide = !!model?.transformed || fx.image.alpha > 0.5 || fx.tint.alpha > 0.9;
      if (hide !== viewmodelHidden) {
        viewmodelHidden = hide;
        view.viewmodel.visible = !hide;
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      unsubFrame();
      offMorphLight();
      morphLight.stop();
      unhookActors?.();
      offSave();
      offVeto();
      classes?.dispose();
      if (model?.transformed) model.revert(false, true);
      // The transformation never survives a level change; the meter does.
      if (model) Object.assign(carried, model.s);
      leaveCreature();
      if (viewmodelHidden) view.viewmodel.visible = true;
      director.clear();
      applyAudioLevel(1);
      applyFov(1);
      fx.dispose();
      textures.dispose();
      body?.dispose();
      movies?.player.dispose();
      view.timeScale = 1;
      if (ctx.services.insanity === service) delete ctx.services.insanity;
      delete (window as unknown as { __insanity?: unknown }).__insanity;
    },
  };
}
