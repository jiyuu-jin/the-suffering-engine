// Main-menu ambience as the game defines it (docs/frontend.md §5.5): looping
// beds plus a random one-shot every `delaySeconds`, moving around the listener
// along a random path of 4 points (random angle, radius in [r0, r1] model
// units), one path segment per `segmentSeconds`. Everything plays on the music
// bus so the music volume setting controls it.

import type { AudioSystem, SoundHandle, Vec3 } from '../audio';
import type { MenuModel } from './model';

type Config = NonNullable<MenuModel['mainMenu']['ambience']>;

interface Mover {
  handle: SoundHandle;
  points: Vec3[];
  t: number;
}

export class MenuAmbience {
  private loops: SoundHandle[] = [];
  private movers: Mover[] = [];
  private timer = 0;
  private running = false;

  constructor(
    private readonly audio: AudioSystem,
    private readonly cfg: Config,
    /** Current listener position (the camera), world units. */
    private readonly listener: () => Vec3,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = this.cfg.delaySeconds * 0.5;
    for (const key of this.cfg.loops) {
      try {
        this.loops.push(this.audio.play(key, { bus: 'music', loop: true, fadeIn: 1.5 }));
      } catch (err) {
        console.warn('[menu] ambience loop unavailable:', key, err);
      }
    }
  }

  stop(fade = this.cfg.fadeOutSeconds): void {
    if (!this.running) return;
    this.running = false;
    for (const h of this.loops) h.stop(fade);
    for (const m of this.movers) m.handle.stop(fade);
    this.loops = [];
    this.movers = [];
  }

  update(dt: number): void {
    if (!this.running) return;
    this.timer -= dt;
    if (this.timer <= 0 && this.cfg.oneShots.length) {
      this.timer = this.cfg.delaySeconds;
      this.spawn();
    }
    const seg = Math.max(0.1, this.cfg.segmentSeconds);
    this.movers = this.movers.filter((m) => {
      if (!m.handle.playing && m.t > 0.5) return false;
      m.t += dt;
      const f = Math.min(m.t / seg, m.points.length - 1.001);
      const i = Math.floor(f);
      const u = f - i;
      const a = m.points[i];
      const b = m.points[i + 1];
      const base = this.listener();
      m.handle.setPosition([base[0] + a[0] + (b[0] - a[0]) * u, base[1] + a[1] + (b[1] - a[1]) * u, base[2] + a[2] + (b[2] - a[2]) * u]);
      return true;
    });
  }

  private spawn(): void {
    const keys = this.cfg.oneShots;
    const key = keys[Math.floor(Math.random() * keys.length)];
    const [r0, r1] = this.cfg.radius;
    const points: Vec3[] = [];
    for (let i = 0; i < 4; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = r0 + Math.random() * (r1 - r0);
      points.push([Math.cos(ang) * r, (Math.random() - 0.5) * 2, Math.sin(ang) * r]);
    }
    const base = this.listener();
    try {
      const handle = this.audio.play(key, {
        bus: 'music',
        position: [base[0] + points[0][0], base[1] + points[0][1], base[2] + points[0][2]],
      });
      this.movers.push({ handle, points, t: 0 });
    } catch (err) {
      console.warn('[menu] ambience one-shot unavailable:', key, err);
    }
  }
}
