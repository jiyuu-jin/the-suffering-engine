// Full-screen tint driven by a special move (the Nooseman grapple's Screen Fader 10:217:
// the view darkens with the strangle meter, up to p16 %). A plain element over the canvas,
// independent of the level's own Screen Fader objects (src/game/insanity/screen.ts).

import type { GameContext } from '../../runtime';

export class ScreenTint {
  private el: HTMLDivElement | null = null;

  constructor(private readonly ctx: GameContext) {}

  /** Show `color` (0xRRGGBB) at opacity `alpha` (0..1); 0 hides it. */
  set(alpha: number, color = 0x000000) {
    if (alpha <= 0.001) {
      if (this.el) this.el.style.opacity = '0';
      return;
    }
    if (!this.el) {
      const host = this.ctx.view.renderer.domElement.parentElement ?? document.body;
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;opacity:0';
      host.appendChild(el);
      this.el = el;
    }
    this.el.style.background = `#${color.toString(16).padStart(6, '0')}`;
    this.el.style.opacity = Math.min(1, alpha).toFixed(3);
  }

  dispose() {
    this.el?.remove();
    this.el = null;
  }
}
