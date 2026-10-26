// The insanity rules as a renderer-free state machine (unit-testable, no THREE).
//
// Decoded from Suffering.rfl (Player class code around 0x10032a70-0x10033ae0, the input
// handler at 0x10049850 and the Allow / Toggle Player Insanity Object handlers at
// 0x1000fc10-0x1000ff30); see docs/game-logic.md §13 for the rules and how sure each is.
// All tuning comes from the Player templates (params.ts).

import type { AdrenalineTemplate, FormParams, InsanityAttackDef, InsanityParams } from './params';

export type Form = 'human' | 'morphIn' | 'creature' | 'morphOut';

/** State that travels with the player between levels (saved with the game). */
export interface InsanityPersist {
  meter: number;
  reputation: number;
  adrenaline: number;
  /** Allow Player Insanity Object bits: transformation (0x80) / meter gain (0x100) disallowed. */
  noTransform: boolean;
  noGain: boolean;
  /**
   * Insanity attacks: index of the last one acquired in Player p276 (-1 = none, [+0x46c]) and
   * the points of kills made while transformed since then ([+0x468]). Both persist across
   * transformations and levels (only an acquisition resets the points, 0x10033ae0).
   */
  attackIndex: number;
  attackPoints: number;
  /** One-shot player events already fired ([+0xa0] bit n; event 9 = the low-meter help). */
  events: number;
}

export interface KillInfo {
  /** Victim template p66 (insanity points for the kill). */
  points: number;
  /** Victim template p166 plus the killing weapon's p22 (reputation change). */
  reputation: number;
  /** Damage type 3 of the killing blow (melee) [inferred meaning]. */
  melee?: boolean;
  /** The player held a Melee Weapon. */
  meleeWeapon?: boolean;
  /**
   * The player was off the ground ([+0x98] bit 0 clear: cleared by the jump / fall states,
   * set by the landing code 0x1003a8d0): the gain is multiplied by p262 [strong].
   */
  airborne?: boolean;
}

export interface InsanityEvents {
  form?(form: Form, prev: Form): void;
  heartbeat?(volume: number, pitch: number): void;
  breath?(): void;
  lowMeter?(): void;
  /** Player event n (Help Popup p292 + n of the current form) fired for the first time. */
  playerEvent?(n: number): void;
  /** An insanity attack was acquired (state 30): the template now usable. */
  acquire?(attack: InsanityAttackDef): void;
  /** The weapon is being put away before the transformation (p256, `seconds` long). */
  putAway?(seconds: number): void;
  /** Health drain while transformed with an empty meter (amount for this frame). */
  drainHealth?(amount: number): void;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function defaultPersist(): InsanityPersist {
  return { meter: 0, reputation: 0, adrenaline: 0, noTransform: false, noGain: false, attackIndex: -1, attackPoints: 0, events: 0 };
}

/**
 * The Character Morpher's cross-fade (update 0x10010510) at `elapsed` of its p4 `duration`:
 * u = elapsed / p4, eased by 1 - (cos(pi u) + 1) / 2 when p5 = 1. Up to e = 0.5 the new form
 * fades in to e over the old one (drawn at 1); past it the new form is at 1 and the old one fades
 * out at 1 - e. Opacities of the old form (`from`, the player's model) and the new (`to`).
 */
export function morpherFade(elapsed: number, duration: number, cosine = true): { from: number; to: number; e: number } {
  const u = duration > 0 ? clamp01(elapsed / duration) : 1;
  const e = cosine ? 1 - (Math.cos(Math.PI * u) + 1) * 0.5 : u;
  return e <= 0.5 ? { from: 1, to: clamp01(e), e } : { from: clamp01(1 - e), to: 1, e };
}

export class InsanityModel {
  form: Form = 'human';
  /** Seconds left of the morph animation (morphIn / morphOut), real time (the clock is slowed). */
  morphLeft = 0;
  /** Real seconds since the morph started. */
  morphElapsed = 0;
  /**
   * Seconds of the lead-in (the current form's p254 clip up to its MorphCharacter event) before
   * the Character Morpher starts, per direction; set by the system from the clips' events.
   */
  readonly morphLead = { morphIn: 0, morphOut: 0 };
  /** Kill-combo window and count ([0x45c] / [0x464]). */
  comboTimer = 0;
  comboCount = 0;
  /** Seconds left of the weapon put-away clip before the morph starts (0 = none). */
  putAwayLeft = 0;
  heartTimer = 0;
  breathTimer = 0;
  /** Seconds since the last heartbeat (drives the FOV pulse). */
  sinceBeat = 0;
  private warnedLow = false;

  constructor(
    readonly params: InsanityParams,
    readonly s: InsanityPersist = defaultPersist(),
    public events: InsanityEvents = {},
  ) {}

  /** The property set in effect: the creature template from the end of morph-in to the end of morph-out. */
  get current(): FormParams {
    return (this.form === 'creature' || this.form === 'morphOut') && this.params.creature ? this.params.creature : this.params.human;
  }

  get max() {
    return this.params.human.meterMax;
  }

  /** 0..1 */
  get fraction() {
    return clamp01(this.s.meter / this.max);
  }

  get transformed() {
    return this.form !== 'human';
  }

  /** Meter full and transformation allowed (what the input handler checks). */
  get available() {
    return this.form === 'human' && this.putAwayLeft <= 0 && !this.s.noTransform && this.s.meter >= this.max && !!this.params.creature;
  }

  /** Insanity points of kills made while transformed since the last acquisition ([+0x468]). */
  get creatureKills() {
    return this.s.attackPoints;
  }

  /** Insanity attacks of the human template's p276 list (the creature's names the same). */
  get attacks(): InsanityAttackDef[] {
    return this.params.human.insanityAttackDefs.length ? this.params.human.insanityAttackDefs : (this.params.creature?.insanityAttackDefs ?? []);
  }

  /** The acquired attack the Jump key performs while transformed (0x10033f20), if any. */
  get currentAttack(): InsanityAttackDef | undefined {
    return this.s.attackIndex >= 0 ? this.attacks[this.s.attackIndex] : undefined;
  }

  /** The next attack to acquire (0x10033ec0: index + 1, at most 5), if any. */
  get nextAttack(): InsanityAttackDef | undefined {
    const i = this.s.attackIndex + 1;
    return i < 5 ? this.attacks[i] : undefined;
  }

  /**
   * The next insanity attack at once (Game Cheats case 14, Player 0x10042100): only transformed
   * (state 20) and while index + 1 < 5, it enters state 30 as a threshold reached does. Returns
   * whether one was acquired.
   */
  acquireNext(): boolean {
    if (this.form !== 'creature') return false;
    const next = this.nextAttack;
    if (!next) return false;
    this.s.attackIndex++;
    this.s.attackPoints = 0;
    this.events.acquire?.(next);
    return true;
  }

  /** Reputation-weighted value: a at p70 (evil, -150), b at p71 (good, +150), clamped. */
  byReputation(a: number, b: number, f: FormParams = this.current): number {
    const [r0, r1] = f.reputationRange;
    const t = r1 !== r0 ? clamp01((this.s.reputation - r0) / (r1 - r0)) : 0.5;
    return lerp(a, b, t);
  }

  /** Meter drain per second while transformed. */
  get drainRate() {
    const f = this.current;
    return this.byReputation(f.drainRate[0], f.drainRate[1], f);
  }

  setMeter(v: number) {
    this.s.meter = Math.min(this.max, Math.max(0, v));
    if (this.s.meter > this.max * (this.current.lowMeterPct / 100)) this.warnedLow = false;
  }

  /** A creature killed by the player. Returns the meter gain. */
  onKill(k: KillInfo): number {
    // Reputation first, unconditionally (0x10041460).
    this.s.reputation += k.reputation;
    if (this.form !== 'human') {
      // Transformed: the points count towards the next insanity attack (0x100338b3); reaching
      // its p0 threshold enters the acquisition state, which resets the points (0x10033ae0).
      this.s.attackPoints += k.points;
      const next = this.nextAttack;
      if (next && next.threshold <= this.s.attackPoints) {
        this.s.attackIndex++;
        this.s.attackPoints = 0;
        this.events.acquire?.(next);
      }
      return 0;
    }
    if (this.s.noGain) return 0;
    const f = this.params.human;
    let mult = 1;
    if (k.melee) mult *= f.meleeKillMult;
    if (k.meleeWeapon) mult *= f.meleeWeaponMult;
    if (k.airborne) mult *= f.flagMult;
    if (this.comboTimer > 0) {
      this.comboCount++;
      if (this.comboCount === 2) mult *= f.combo2;
      else if (this.comboCount >= 3) mult *= f.combo3;
    } else {
      this.comboCount = 1;
    }
    const gain = this.byReputation(f.gainScale[0], f.gainScale[1], f) * mult * k.points;
    this.setMeter(this.s.meter + gain);
    this.comboTimer = f.comboWindow;
    return gain;
  }

  /**
   * The Insanity key: transform when the meter is full, or change back while transformed.
   * `putAway` (s): a weapon is in hand, so the p256 clip plays first (0x10049954: Play Anim
   * state 33) and the morph starts when it ends [the hand-over to the morph is inferred].
   */
  pressInsanity(opts: { putAway?: number } = {}): boolean {
    if (this.form === 'human') {
      if (!this.available) return false;
      this.setMeter(this.s.meter - 1);
      const d = opts.putAway ?? 0;
      if (d > 0) {
        this.putAwayLeft = d;
        this.events.putAway?.(d);
      } else this.begin('morphIn');
      return true;
    }
    if (this.form === 'creature') {
      if (this.s.noTransform) return false;
      this.begin('morphOut');
      return true;
    }
    return false;
  }

  /** Toggle Player Insanity Object "on": transform regardless of the meter. */
  forceTransform() {
    if (this.form === 'human' && this.params.creature) this.begin('morphIn');
  }

  /**
   * A loaded save in creature form: transformed at once (the morph-in runs its first frame for
   * the form's start-up: body, blur and tint) instead of the morph's full length.
   */
  restoreCreature() {
    if (!this.params.creature || this.form === 'creature') return;
    this.putAwayLeft = 0;
    if (this.form !== 'morphIn') this.begin('morphIn');
    this.morphLeft = 0;
    this.setForm('creature');
  }

  /** Change back (Toggle object "off", cutscenes, death). `empty` also clears the meter. */
  revert(empty = false, instant = false) {
    if (empty) this.setMeter(0);
    this.putAwayLeft = 0;
    if (this.form === 'human') return;
    if (instant) return this.setForm('human');
    if (this.form === 'creature' || this.form === 'morphIn') this.begin('morphOut');
  }

  /** The Character Morpher of a morph (p255 of the form it starts from). */
  morpher(form: 'morphIn' | 'morphOut') {
    return (form === 'morphIn' ? this.params.human : (this.params.creature ?? this.params.human)).morph;
  }

  /**
   * Length of a morph (real seconds): the lead-in clip up to its MorphCharacter event, then the
   * morpher's p4 (its end swaps the model; the Morph state then leaves, 0x100448a0).
   */
  morphSeconds(form: 'morphIn' | 'morphOut') {
    return Math.max(0.1, this.morphLead[form] + (this.morpher(form)?.duration ?? 1));
  }

  /**
   * Game clock rate (the morph's slow-down): while morphing the clock runs at 1 / p272 of the form
   * that started it (0x100440f0 sets it, 0x10044280 at the Morph leave sets 1 again).
   */
  get clockRate() {
    if (this.form !== 'morphIn' && this.form !== 'morphOut') return 1;
    const from = this.form === 'morphIn' ? this.params.human : (this.params.creature ?? this.params.human);
    return from.morphClockDiv > 0 ? 1 / from.morphClockDiv : 1;
  }

  private begin(form: 'morphIn' | 'morphOut') {
    this.morphLeft = this.morphSeconds(form);
    this.morphElapsed = 0;
    this.setForm(form);
  }

  private setForm(form: Form) {
    const prev = this.form;
    if (prev === form) return;
    this.form = form;
    this.events.form?.(form, prev);
  }

  /** Adrenaline Sender / template (0x100427f0); ignored while transformed. */
  applyAdrenaline(t: AdrenalineTemplate, dt = 1) {
    if (this.form !== 'human') return;
    const amount = t.perSecond ? t.amount * dt : t.amount;
    let a = this.s.adrenaline;
    if (a < t.cap && amount > 0) a = Math.min(a + amount, t.cap);
    else if (a > t.cap && amount < 0) a = Math.max(a + amount, t.cap);
    if (t.clampMax) a = Math.min(a, t.cap);
    if (t.clampMin) a = Math.max(a, t.floor);
    this.s.adrenaline = a;
  }

  /** `realDt`: the frame's unscaled time (the morph runs on it while the game clock is slowed). */
  update(dt: number, realDt = dt) {
    if (dt <= 0 && realDt <= 0) return;
    // Kill-combo window.
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.comboCount = 0;
    }
    // Weapon put away: then the morph.
    if (this.putAwayLeft > 0) {
      this.putAwayLeft -= dt;
      if (this.putAwayLeft <= 0) {
        this.putAwayLeft = 0;
        if (this.form === 'human') this.begin('morphIn');
      }
    }
    // Morph animation.
    if (this.form === 'morphIn' || this.form === 'morphOut') {
      this.morphLeft -= realDt;
      this.morphElapsed += realDt;
      if (this.morphLeft <= 0) this.setForm(this.form === 'morphIn' ? 'creature' : 'human');
    }
    if (dt <= 0) return;
    const f = this.current;
    // Drain while transformed (not while morphing), warning, health drain at empty.
    if (this.form === 'creature') {
      const low = this.max * (f.lowMeterPct / 100);
      const wasAbove = this.s.meter > low;
      this.s.meter = Math.max(0, this.s.meter - this.drainRate * dt);
      if (wasAbove && this.s.meter <= low && !this.warnedLow) {
        this.warnedLow = true;
        this.events.lowMeter?.();
        // Player event 9 (0x10032e2a -> 0x10041740): fired once, its bit stays set.
        this.fireEvent(9);
      }
      if (this.s.meter <= 0 && f.healthDrain > 0) this.events.drainHealth?.(f.healthDrain * dt);
    }
    // Adrenaline: decay, clamp, and while transformed it follows the meter.
    let a = this.s.adrenaline - f.adrenalineDecay * dt;
    a = Math.max(f.adrenalineMin, Math.min(f.adrenalineMax, a));
    if (this.form === 'creature' || this.form === 'morphOut') a = (1 - this.s.meter / this.max) * 100;
    this.s.adrenaline = a;
    const t = a / 100;
    // Heartbeat and breathing.
    this.sinceBeat += dt;
    this.heartTimer += dt;
    const heart = Math.max(0.2, lerp(f.heartPeriod[0], f.heartPeriod[1], t));
    if (this.heartTimer >= heart) {
      this.heartTimer = 0;
      this.sinceBeat = 0;
      this.events.heartbeat?.(lerp(f.heartVolume[0], f.heartVolume[1], t) / 100, lerp(f.heartPitch[0], f.heartPitch[1], t));
    }
    this.breathTimer += dt;
    const breath = Math.max(0.3, lerp(f.breathPeriod[0], f.breathPeriod[1], t));
    if (this.breathTimer >= breath) {
      this.breathTimer = 0;
      this.events.breath?.();
    }
  }

  /** A one-shot player event (0x10041740): the first time only ([+0xa0] bit n). */
  fireEvent(n: number) {
    const bit = 1 << n;
    if (this.s.events & bit) return;
    this.s.events |= bit;
    this.events.playerEvent?.(n);
  }

  /** Heartbeat period at the current adrenaline (s). */
  get heartPeriod() {
    const f = this.current;
    return Math.max(0.2, lerp(f.heartPeriod[0], f.heartPeriod[1], this.s.adrenaline / 100));
  }
}
