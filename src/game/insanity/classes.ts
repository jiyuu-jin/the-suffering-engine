// Level classes of the insanity system, hooked into the world dispatcher through
// World.handlers (no edits to the world system). Slots and behaviour were decoded
// from the classes' message maps in Suffering.rfl (docs/game-logic.md §13.3):
//
//   Allow Player Insanity Object   p3 allow transforming, p4 allow meter gain, p5 forbid both
//   Toggle Player Insanity Object  p3 fill the meter, p4 transform (no meter needed),
//                                  p5 change back and empty the meter
//   Insanity Screen Flash          p0 on at start, p7 on, p8 off; while on and the meter is full
//                                  (>= p1), the player flashes the p6 Screen Fader templates
//   Insanity Mode Message Filter   forwards when p1 = 0 and transformed, or p1 = 1 and not
//   Insanity Meter Message Filter  forwards when meter% >= p2 (p1 = 0) or <= p2 (p1 != 0)
//   Reputation Points Msg Filter   forwards when p1 < reputation <= p2
//                                  (every filter: p0 = destroy once passed, World.filterPass)
//   Reputation Points Sender       on p1: reputation += p3 per p0 target (reputation.ts); p2 destroys
//   Adrenaline Sender              on p1: apply Adrenaline Template p3; p2 destroys
//   Screen Blur                    p0 on at start, p12 on, p13 off (fade out), p14 destroy
//   Screen Fader                   p3 on at start, p15 on, p14 destroy, p17 output at start
//   Time Scale                     p3 on, p4 off, p5 destroy
//   Movie Player                   p10 play (p0 video), p12 stop, p14 output when finished,
//                                  p3 destroy after playing

import type { ResRef } from '../../formats/model';
import type { World, WorldEntity } from '../world/logic';
import { blurParams, faderParams, num, readAdrenalineTemplate, ref, refs, templateValues, type FaderParams } from './params';
import type { InsanityModel } from './rules';
import { senderApplications } from './reputation';
import { BlurRun, FaderRun, TimeScaleRun, type EffectDirector, type TextureCache } from './screen';
import type { EntityPackageSet, PropValue } from '../../formats/entities';

export interface ClassEnv {
  world: World;
  model: InsanityModel | null;
  director: EffectDirector;
  textures: TextureCache;
  pkgs: EntityPackageSet;
  playSound(r: ResRef): void;
  playMovie(video: ResRef): Promise<void>;
  inCutscene(): boolean;
  /** The game clock rate (Time Scale runs x the morph's slow-down); 1 when absent. */
  clockRate?(): number;
  log(msg: string): void;
}

export const INSANITY_CLASSES = new Set([
  'Allow Player Insanity Object',
  'Toggle Player Insanity Object',
  'Insanity Screen Flash',
  'Insanity Mode Message Filter',
  'Insanity Meter Message Filter',
  'Reputation Points Message Filter',
  'Reputation Points Sender',
  'Adrenaline Sender',
  'Screen Blur',
  'Screen Fader',
  'Time Scale',
  'Movie Player',
]);

interface FlashState {
  w: WorldEntity;
  timer: number;
  order: number[];
}

export class InsanityClasses {
  private blurs = new Map<number, BlurRun>();
  private faders = new Map<number, FaderRun>();
  private clocks = new Map<number, TimeScaleRun>();
  private movies = new Set<number>();
  /** The active Insanity Screen Flash (the player keeps one, like [player+0x4a0]). */
  flash: FlashState | null = null;
  private off: () => void = () => {};

  constructor(private readonly env: ClassEnv) {}

  start() {
    const { world } = this.env;
    const handler = (w: WorldEntity, msg: number, from: number) => (INSANITY_CLASSES.has(w.cls) ? this.receive(w, msg, from) : false);
    world.handlers.push(handler);
    this.off = () => {
      const i = world.handlers.indexOf(handler);
      if (i >= 0) world.handlers.splice(i, 1);
    };
    // Objects that start running with the level.
    for (const w of world.of('Insanity Screen Flash')) if (num(w.e.values[0]) === 1) this.setFlash(w, true);
    for (const w of world.of('Screen Blur')) if (num(w.e.values[0]) !== 0) this.blur(w).start();
    for (const w of world.of('Screen Fader')) if (num(w.e.values[3]) !== 0) this.fader(w).start();
  }

  private slot(w: WorldEntity, i: number) {
    return num(w.e.values[i]);
  }

  private destroy(w: WorldEntity) {
    this.blurs.get(w.uid)?.stop();
    this.faders.get(w.uid)?.stop();
    const c = this.clocks.get(w.uid);
    if (c) this.env.director.clocks.delete(c);
    if (this.flash?.w === w) this.flash = null;
    this.env.world.destroy(w);
  }

  receive(w: WorldEntity, msg: number, from: number): boolean {
    const m = this.env.model;
    const is = (i: number) => this.slot(w, i) === msg && msg !== 0;
    switch (w.cls) {
      case 'Allow Player Insanity Object': {
        if (!m) return true;
        if (is(3)) m.s.noTransform = false;
        if (is(4)) m.s.noGain = false;
        if (is(5)) m.s.noTransform = m.s.noGain = true;
        return true;
      }
      case 'Toggle Player Insanity Object': {
        if (!m) return true;
        if (is(3)) m.setMeter(m.max);
        if (is(4)) m.forceTransform();
        if (is(5) && m.transformed) m.revert(true);
        return true;
      }
      case 'Insanity Screen Flash':
        if (is(7)) this.setFlash(w, true);
        if (is(8)) this.setFlash(w, false);
        return true;
      case 'Insanity Mode Message Filter': {
        // Filters (0x100cb7a0): p0 destroys the filter once a message passed, not an enable flag.
        if (!m) return true;
        // The test (vt +0x4c, 0x10015830) [verified] reads Player state 20 (+0xa4 bit 0x100000)
        // only: p1 = 0 passes with it set, p1 = 1 without. State 20 is entered when the
        // morph-in ends and left when the morph-out ends (0x10044625..0x10044646; the start
        // 0x100334b0 keeps it), so the morph-in still counts as human and the morph-out as
        // transformed. The port passed p1 = 0 from the first frame of the morph-in: 1b's
        // 7ed5 removed Hermes and Horace and started Killjoy's line under the slowed clock.
        const mode = num(w.e.values[1]);
        const insane = insaneState(m.form);
        if ((mode === 0 && insane) || (mode === 1 && !insane)) this.env.world.filterPass(w, msg, from);
        return true;
      }
      case 'Insanity Meter Message Filter': {
        if (!m) return true;
        const pct = m.fraction * 100, lim = num(w.e.values[2]);
        if (num(w.e.values[1]) === 0 ? pct >= lim : pct <= lim) this.env.world.filterPass(w, msg, from);
        return true;
      }
      case 'Reputation Points Message Filter': {
        if (!m) return true;
        const r = m.s.reputation;
        if (r > num(w.e.values[1], -999) && r <= num(w.e.values[2], 999)) this.env.world.filterPass(w, msg, from);
        return true;
      }
      case 'Reputation Points Sender':
        // p0 is the target mode (0 the sender, 1 the player, 2 each link), not an enable flag:
        // p3 is added once per target found (0x1008e510, reputation.ts). Every placed sender
        // has p0 1 (once).
        if (is(1) && m) {
          const live = w.e.links.filter((u) => {
            const t = this.env.world.get(u);
            return !!t && !t.destroyed;
          }).length;
          const n = senderApplications(num(w.e.values[0], 1), live);
          const pts = num(w.e.values[3]);
          for (let k = 0; k < n; k++) m.s.reputation += pts;
          if (n) this.env.log(`reputation ${pts >= 0 ? '+' : ''}${pts}${n > 1 ? ` x${n}` : ''} (sender #${w.uid.toString(16)}) -> ${m.s.reputation}`);
        }
        if (is(2)) this.destroy(w);
        return true;
      case 'Adrenaline Sender':
        if (is(1) && num(w.e.values[0], 1) !== 0 && m) {
          const t = readAdrenalineTemplate(this.env.pkgs, ref(w.e.values[3]));
          if (t) m.applyAdrenaline(t);
        }
        if (is(2)) this.destroy(w);
        return true;
      case 'Screen Blur':
        if (is(12)) this.blur(w).start();
        if (is(13)) this.blurs.get(w.uid)?.stop();
        if (is(14)) this.destroy(w);
        return true;
      case 'Screen Fader':
        if (is(15)) this.fader(w).start();
        if (is(13)) this.faders.get(w.uid)?.stop();
        if (is(14)) this.destroy(w);
        return true;
      case 'Time Scale': {
        if (is(3)) this.clock(w).on();
        if (is(4)) this.clock(w).off();
        if (is(5)) this.destroy(w);
        return true;
      }
      case 'Movie Player':
        if (is(10)) this.movie(w);
        return true;
    }
    return false;
  }

  private blur(w: WorldEntity): BlurRun {
    let b = this.blurs.get(w.uid);
    if (!b) {
      b = new BlurRun(blurParams(w.e.values), () => {
        if (b!.done) {
          this.blurs.delete(w.uid);
          if (!w.destroyed) this.env.world.destroy(w);
        }
      });
      this.blurs.set(w.uid, b);
    }
    if (!this.env.director.blurs.has(b)) this.env.director.blurs.add(b);
    return b;
  }

  /** A fader for a level entity (fires its p17 output at the start). */
  private fader(w: WorldEntity): FaderRun {
    let f = this.faders.get(w.uid);
    if (!f) {
      const p = faderParams(w.e.values);
      f = new FaderRun(
        p,
        {
          fire: () => this.env.world.fire(w, 17),
          sound: (r) => this.env.playSound(r),
          end: () => {
            if (f!.done) {
              this.faders.delete(w.uid);
              if (!w.destroyed) this.env.world.destroy(w);
            }
          },
        },
        this.env.textures.get(p.texture),
      );
      this.faders.set(w.uid, f);
    }
    if (!this.env.director.faders.has(f)) this.env.director.faders.add(f);
    return f;
  }

  /** A one-shot fader from a template (player effects, hallucination flashes). */
  spawnFader(p: FaderParams): FaderRun {
    const f = new FaderRun(p, { sound: (r) => this.env.playSound(r) }, this.env.textures.get(p.texture));
    this.env.director.faders.add(f);
    f.start();
    return f;
  }

  private clock(w: WorldEntity): TimeScaleRun {
    let c = this.clocks.get(w.uid);
    if (!c) {
      const v = w.e.values;
      c = new TimeScaleRun(num(v[0], 100), num(v[1], 0.1), num(v[2], 0.1));
      this.clocks.set(w.uid, c);
      this.env.director.clocks.add(c);
    }
    return c;
  }

  private movie(w: WorldEntity) {
    if (this.movies.has(w.uid)) return;
    const video = ref(w.e.values[0]);
    const done = () => {
      this.movies.delete(w.uid);
      this.env.world.fire(w, 14);
      if (num(w.e.values[3]) !== 0) this.env.world.destroy(w);
    };
    if (!video) return done();
    this.movies.add(w.uid);
    this.env.log(`movie ${video.pkg}:${video.id}`);
    this.env.playMovie(video).then(done, (err) => {
      console.warn('[insanity] movie failed', err);
      done();
    });
  }

  private setFlash(w: WorldEntity, on: boolean) {
    if (on) {
      if (this.flash?.w !== w) this.flash = { w, timer: 1, order: [] };
    } else if (this.flash?.w === w) this.flash = null;
  }

  /**
   * Hallucination flashes (player per-frame code 0x10043b50, docs/game-logic.md §13.3)
   * [verified]: while a flash object is registered (+0x4a0), no cutscene runs, the game clock
   * runs at 0.95 or more (not during a morph or a Time Scale slow-down), the player is not
   * transformed (state 20) and the meter is at least p1, a timer (+0x494, 1 at the start)
   * counts down each frame by dt / (p5 x k x f) with
   *   k = p2 + (p3 - p2) x (meter - p1) / (max - p1)   (chapter 1: p2 = p3 = 50, so 50)
   *   f = a random 1..p4, inverted half of the time      (drawn every frame)
   * and at 0 one of the p6 Screen Fader templates is spawned (a shuffled bag, no repeat
   * until all were shown) and the timer goes back to 1. With p5 = 1.8 and p4 = 10 a flash
   * comes every 31 s on average (9..900 s per frame draw); the port used k = 1, f = 0.9..1.1,
   * a flash every 1.8 s.
   */
  updateFlash(dt: number, rand: () => number = Math.random) {
    const fl = this.flash;
    const m = this.env.model;
    if (!fl || fl.w.destroyed || !m) return;
    const v = fl.w.e.values;
    const list = refs(v[6]);
    if (!list.length || m.form !== 'human' || this.env.inCutscene()) return;
    if ((this.env.clockRate?.() ?? 1) < 0.95) return;
    const p1 = num(v[1], 100);
    if (m.s.meter < Math.min(p1, m.max - 1e-3)) return;
    fl.timer -= dt / flashPeriod(v, m.s.meter, m.max, rand);
    if (fl.timer > 0) return;
    fl.timer = 1;
    if (!fl.order.length) {
      fl.order = list.map((_, i) => i).sort(() => rand() - 0.5);
    }
    const tpl = list[fl.order.pop()!];
    const t = templateFader(this.env.pkgs, tpl);
    if (t) this.spawnFader(t);
  }

  dispose() {
    this.off();
    this.blurs.clear();
    this.faders.clear();
    this.clocks.clear();
  }
}


/** Player state 20 (Insanity, +0xa4 bit 0x100000) for a form: from the morph-in's end to the morph-out's. */
export function insaneState(form: string): boolean {
  return form === 'creature' || form === 'morphOut';
}

/**
 * One frame's p5 x k x f of an Insanity Screen Flash (0x10043c59..0x10043d1e) [verified]:
 * k = p2 + (p3 - p2) x (meter - p1) / (max - p1), f uniform in 1..p4 and inverted with
 * chance 1/2. The timer loses dt / this each frame.
 */
export function flashPeriod(v: readonly PropValue[], meter: number, max: number, rand: () => number = Math.random): number {
  const p1 = num(v[1], 100), p2 = num(v[2], 50), p3 = num(v[3], 50), p4 = num(v[4], 10), p5 = num(v[5], 1.8);
  const span = max - p1;
  const k = p2 + (span > 1e-6 ? ((p3 - p2) * Math.min(span, Math.max(0, meter - p1))) / span : 0);
  let f = 1 + rand() * Math.max(0, p4 - 1);
  if (rand() < 0.5) f = 1 / f;
  return Math.max(1e-3, p5 * k * f);
}

export function templateFader(pkgs: EntityPackageSet, r: ResRef | null | undefined): FaderParams | undefined {
  const t = templateValues(pkgs, r);
  return t && t.cls === 'Screen Fader' ? faderParams(t.values) : undefined;
}

export function templateBlur(pkgs: EntityPackageSet, r: ResRef | null | undefined) {
  const t = templateValues(pkgs, r);
  return t && t.cls === 'Screen Blur' ? blurParams(t.values) : undefined;
}
