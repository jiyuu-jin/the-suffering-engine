// Runtime of the screen-effect classes: Screen Blur, Screen Fader and Time Scale, as
// decoded from Suffering.rfl (docs/game-logic.md §13.4). Level entities and the
// player's own templates (transformation blur / tint / flash, hallucination flashes)
// all run through these; the director folds them into one ScreenEffects state and the
// renderer's clock rate each frame.

import * as THREE from 'three/webgpu';
import { findEntry, TDU_TEXTURE, type PackageSet, type ResRef } from '../../formats/model';
import { decodeTexture } from '../../formats/texture';
import type { ScreenEffects } from './effects';
import type { BlurParams, FaderParams } from './params';
import { screenBlurPass } from '../../formats/render-data';

/**
 * Screen Blur: three phases (in / hold / out). Each phase eases the strength A and the
 * spread B linearly to the phase target over the phase duration; a hold of -1 lasts
 * until Off. Off jumps to the fade-out (p11 s, to 0). At the end: destroyed when p1 is
 * set, else back to idle (can be started again).
 */
export class BlurRun {
  phase = -1;
  t = 0;
  a = 0;
  b = 0;
  c = 1;
  done = false;
  constructor(readonly p: BlurParams, readonly onEnd?: () => void) {}

  get active() {
    return this.phase >= 0;
  }

  start() {
    if (this.phase === 0 || this.phase === 1) return;
    this.phase = 0;
    this.t = this.p.phases[0].duration;
  }

  stop() {
    if (this.phase < 0 || this.phase === 2) return;
    this.phase = 2;
    this.t = this.p.phases[2].duration;
  }

  update(dt: number) {
    if (this.phase < 0) return;
    const ph = this.p.phases[this.phase];
    const infinite = this.phase === 1 && ph.duration < 0;
    // Ease towards the phase target so it is reached when the phase ends (an infinite
    // hold eases over 1 s).
    const span = infinite ? 1 : Math.max(this.t, 1e-4);
    const k = Math.min(1, dt / span);
    this.a += (ph.a - this.a) * k;
    this.b += (ph.b - this.b) * k;
    this.c += (ph.c - this.c) * k;
    if (infinite) return;
    this.t -= dt;
    if (this.t > 0) return;
    if (this.phase < 2) {
      this.phase++;
      this.t = this.p.phases[this.phase].duration;
      return;
    }
    this.phase = -1;
    this.a = this.b = 0;
    this.c = 1;
    if (this.p.destroyAtEnd) this.done = true;
    this.onEnd?.();
  }
}

/**
 * Screen Fader: on start it fires its output (p17) and fades a full-screen colour (p7),
 * optionally textured (p6), to alpha p8 over p0 s, holds p1 s and fades out over p2 s.
 * The sound p9 plays at the start (p10 = 0), on reaching the hold (1) or when the fade
 * out begins (2). At the end it is destroyed when p4 is set (else idle again).
 */
export class FaderRun {
  phase = 0;
  t = 0;
  alpha = 0;
  done = false;
  private started = false;
  readonly color: THREE.Color;
  constructor(
    readonly p: FaderParams,
    readonly hooks: { fire?(): void; sound?(r: ResRef): void; end?(): void } = {},
    readonly texture: THREE.Texture | null = null,
  ) {
    this.color = new THREE.Color((p.color >> 16) & 255, (p.color >> 8) & 255, p.color & 255).multiplyScalar(1 / 255);
    this.color.convertSRGBToLinear();
  }

  get active() {
    return this.phase > 0;
  }

  start() {
    if (this.phase === 1 || this.phase === 2) return;
    this.phase = 1;
    this.t = this.p.fadeIn;
    this.started = false;
  }

  stop() {
    if (this.phase === 1 || this.phase === 2) {
      this.phase = 3;
      this.t = this.p.fadeOut;
      this.sound(2);
    }
  }

  private sound(at: number) {
    if (this.p.soundAt === at && this.p.sound) this.hooks.sound?.(this.p.sound);
  }

  update(dt: number) {
    if (this.phase === 0) return;
    if (!this.started) {
      this.started = true;
      this.hooks.fire?.();
      this.sound(0);
    }
    const p = this.p;
    if (this.phase === 1) {
      this.t -= dt;
      if (this.t <= 0) {
        this.phase = 2;
        this.t = p.hold;
        this.alpha = p.alpha;
        this.sound(1);
      } else this.alpha = (1 - this.t / Math.max(p.fadeIn, 1e-4)) * p.alpha;
      return;
    }
    if (this.phase === 2) {
      this.alpha = p.alpha;
      if (p.hold < 0) return;
      this.t -= dt;
      if (this.t <= 0) {
        this.phase = 3;
        this.t = p.fadeOut;
        this.sound(2);
      }
      return;
    }
    this.t -= dt;
    if (this.t <= 0) {
      this.phase = 0;
      this.alpha = 0;
      if (p.destroyAtEnd) this.done = true;
      this.hooks.end?.();
    } else this.alpha = (this.t / Math.max(p.fadeOut, 1e-4)) * p.alpha;
  }
}

/**
 * Time Scale: On eases the game clock to p0 % (p0 * 0.01) over p1 s, Off back to 1 over
 * p2 s. The clock is reset to 1 when the object goes away.
 */
export class TimeScaleRun {
  current = 1;
  target = 1;
  rate = 5;
  constructor(readonly percent: number, readonly inTime: number, readonly outTime: number) {}

  on() {
    this.target = this.percent * 0.01;
    this.rate = Math.abs(this.target - 1) / Math.max(this.inTime, 1e-3);
  }

  off() {
    this.target = 1;
    this.rate = Math.abs(this.percent * 0.01 - 1) / Math.max(this.outTime, 1e-3);
  }

  /** Steps with real (unscaled) time so a slowed clock can still recover. */
  update(realDt: number) {
    const d = this.target - this.current;
    const step = this.rate * realDt;
    this.current = Math.abs(d) <= step ? this.target : this.current + Math.sign(d) * step;
  }

  get active() {
    return this.current !== 1 || this.target !== 1;
  }
}

/** Decoded textures for faders, cached per ref. */
export class TextureCache {
  private map = new Map<string, THREE.DataTexture | null>();
  constructor(private readonly pkgs: PackageSet) {}

  get(r: ResRef | null): THREE.DataTexture | null {
    if (!r) return null;
    const k = `${r.pkg}:${r.id}`;
    if (this.map.has(k)) return this.map.get(k)!;
    let tex: THREE.DataTexture | null = null;
    const tdu = this.pkgs.get(r.pkg)?.tdu;
    const e = findEntry(tdu, TDU_TEXTURE, r.id);
    const d = tdu && e ? decodeTexture(tdu, e) : null;
    if (d) {
      tex = new THREE.DataTexture(d.rgba, d.width, d.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
    }
    this.map.set(k, tex);
    return tex;
  }

  dispose() {
    for (const t of this.map.values()) t?.dispose();
    this.map.clear();
  }
}

/** Folds every running blur / fader / time scale into the screen and the clock. */
export class EffectDirector {
  readonly blurs = new Set<BlurRun>();
  readonly faders = new Set<FaderRun>();
  readonly clocks = new Set<TimeScaleRun>();
  /** Extra edge darkening (creature form). */
  vignette = 0;
  /** Strength scale of the screen blur's A (1 = the engine's mapping, docs/re/renderer.md §2). */
  blurScale = 1;
  /**
   * Game sound level from the running blurs' C values (p6 / p10 / out 1): the lowest wins.
   * The RFL hands C to the sound mixer; which buses it scales was not traced, the system
   * applies it to the effects and music buses (dialogue stays audible in the visions) [inferred].
   */
  audioLevel = 1;

  constructor(
    readonly fx: ScreenEffects,
    private readonly setClock: (rate: number) => void,
  ) {}

  update(dt: number, realDt: number) {
    for (const b of this.blurs) {
      b.update(dt);
      if (b.done) this.blurs.delete(b);
    }
    for (const f of this.faders) {
      f.update(dt);
      if (f.done) this.faders.delete(f);
    }
    let rate = 1;
    for (const c of this.clocks) {
      c.update(realDt);
      if (c.active) rate = Math.min(rate, c.current);
    }
    this.setClock(rate);

    // One blur state in the engine (the last update of the frame wins); here: the strongest.
    let a = 0, b = 0, mode = 1;
    for (const r of this.blurs) if (r.active && r.a > a) (a = r.a), (b = r.b), (mode = r.p.mode);
    const pass = screenBlurPass(a * this.blurScale, b, mode);
    this.fx.blur = pass.alpha;
    this.fx.inset = pass.inset;
    this.fx.blurMode = pass.blend;
    let level = 1;
    for (const r of this.blurs) if (r.active) level = Math.min(level, Math.max(0, r.c));
    this.audioLevel = level;

    // Untextured faders tint (most opaque wins); the newest textured one is the image.
    let tint: FaderRun | null = null;
    let image: FaderRun | null = null;
    for (const f of this.faders) {
      if (!f.active || f.alpha <= 0) continue;
      if (f.texture) image = f;
      else if (!tint || f.alpha > tint.alpha) tint = f;
    }
    this.fx.tint.alpha = tint ? Math.min(1, tint.alpha) : 0;
    if (tint) this.fx.tint.color.copy(tint.color);
    this.fx.image.alpha = image ? Math.min(1, image.alpha) : 0;
    this.fx.image.texture = image?.texture ?? null;
    if (image) this.fx.image.color.copy(image.color);
    this.fx.vignette = this.vignette;
    this.fx.sync();
  }

  /**
   * Let `seconds` of effect time pass at once (a skipped cinematic: its Screen Faders / Blurs
   * must show their state at the end of the sequence, not the one at the skip). Phase by
   * phase, so each phase change happens; infinite holds stay until Off. [sequence presenter]
   */
  fastForward(seconds: number) {
    for (const r of [...this.blurs, ...this.faders]) {
      let left = seconds;
      for (let i = 0; i < 8 && left > 0 && r.active && !r.done; i++) {
        const step = Math.min(left, Math.max(r.t, 1e-4));
        r.update(step);
        left -= step;
      }
    }
    this.update(0, 0);
  }

  clear() {
    this.blurs.clear();
    this.faders.clear();
    this.clocks.clear();
    this.setClock(1);
    this.fx.blur = 0;
    this.fx.tint.alpha = 0;
    this.fx.image.alpha = 0;
    this.fx.vignette = 0;
    this.audioLevel = 1;
    this.fx.sync();
  }
}
