// Gamepad polling for the menus, on the normalised active pad of src/app/gamepad.ts (any
// supported controller; non-standard pads go through its remap / calibration): d-pad or left
// stick navigate with key-repeat, bottom face button (A / Cross / Nintendo B) accepts, right
// face button (B / Circle / Nintendo A) goes back, top face button (Y / Triangle / Nintendo X)
// is the "alt" action (delete a save, clear a binding), Start / Options / Plus is start.
// Positions, not labels: the accept / back buttons are where each family's own console puts
// confirm / cancel in the West (Nintendo's labels sit swapped on the same positions).

import { pads } from '../gamepad';

export type NavAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'start' | 'alt';

const REPEAT_DELAY = 0.4;
const REPEAT_RATE = 0.12;

export class GamepadNav {
  private held = new Map<NavAction, number>(); // action -> seconds until next repeat
  private last = performance.now();

  /** Returns the actions triggered since the previous poll. */
  poll(): NavAction[] {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const st = pads.poll();
    const down = new Set<NavAction>();
    if (st) {
      const b = (i: number) => !!st.pressed[i];
      const ax = st.axes[0] ?? 0;
      const ay = st.axes[1] ?? 0;
      if (b(12) || ay < -0.6) down.add('up');
      if (b(13) || ay > 0.6) down.add('down');
      if (b(14) || ax < -0.6) down.add('left');
      if (b(15) || ax > 0.6) down.add('right');
      if (b(0)) down.add('accept');
      if (b(1)) down.add('back');
      if (b(3)) down.add('alt');
      if (b(9)) down.add('start');
    }
    const out: NavAction[] = [];
    for (const a of down) {
      const t = this.held.get(a);
      if (t === undefined) {
        out.push(a);
        this.held.set(a, REPEAT_DELAY);
      } else if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
        const next = t - dt;
        if (next <= 0) {
          out.push(a);
          this.held.set(a, REPEAT_RATE);
        } else this.held.set(a, next);
      }
    }
    for (const a of [...this.held.keys()]) if (!down.has(a)) this.held.delete(a);
    return out;
  }

  /** Forget held buttons (so a press that closed one screen doesn't trigger the next). */
  reset(): void {
    this.poll();
  }
}
