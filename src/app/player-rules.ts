// Player rules of the original (Suffering.rfl Player class, template 2:5), as decoded in
// docs/re/player.md. Pure data and helpers (no THREE): PlayerController (player.ts), the fx
// system (fall damage) and the tests use them. Distances are model units (= port metres).

/** Fall gravity: Player p214 (Fall per-frame 0x1003ab30) [verified]. */
export const PLAYER_GRAVITY = 24.4;
/** First-person jump: straight into Fall with vy = p215 (input handler 0x1004982a) [verified]. */
export const FP_JUMP_SPEED = 10;
/**
 * Third-person jump launch speed. The original's third-person jump is the PWP p151..p153 clip's
 * root motion (Jump enter 0x1003adf0), not a velocity; this keeps the port's earlier 0.75 m
 * apex under the retail gravity [port value].
 */
export const TP_JUMP_SPEED = 6.05;
/** First-person jump air control: stick x p216 per second (0x1003a6e0) [verified]. */
export const FP_AIR_CONTROL = 7.5;
/** Forward walk / run reference speeds: PWP p19 / p21 of every human set [strong]. */
export const WALK_SPEED = 1.63;
/**
 * Port default walk (walk by default, Shift runs): a brisk walk. The original's 1.63 m/s walk
 * suits its run-by-default scheme (Always Run uses it) but feels sluggish as the default pace.
 * No retail clip is animated for it: third person plays the walk and run poses blended at a
 * shared phase (src/game/actors/gait.ts), at rate 1.
 */
export const PORT_WALK_SPEED = 3.0;
export const RUN_SPEED = 6.64;
/** Fall damage ramp: none up to p212, lethal from p213 (0x1002db30) [verified]. */
export const FALL_DAMAGE_MIN = 6.5;
export const FALL_DAMAGE_MAX = 7.7;
/** Damage type of the fall damage record [verified 0x1002dcd2]. */
export const FALL_DAMAGE_TYPE = 7;
/** Added to the fall reference height for a first-person jump (0x1003b927, 2764.8 / 2048). */
export const FP_JUMP_FALL_BONUS = 1.35;
/** Turn rate (deg/s, x turn axis): p158 standing, p161 moving, p167 FP, p170 airborne. */
export const TURN_RATE_DEG = 220;
/** Pitch rate (deg/s): p190 third person / p191 first person; also the Auto Pitch rate. */
export const PITCH_RATE_DEG = 42;
/** Pitch input scale (Pitch per-frame 0x1003f930): the axis x pitch sensitivity x 2 [verified]. */
export const PITCH_INPUT_SCALE = 2;
/**
 * Sensitivity range of the Gameplay page's Turn / Pitch sliders (0x10056d70): sens = 2^(4s - 2)
 * for the slider position s in 0..1, clamped to [0.25, 4]; s = 0.5 gives the default 1 [verified].
 */
export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 4;
export function sensitivityOfSlider(s: number): number {
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, Math.pow(2, 4 * s - 2)));
}

/**
 * Look rates (rad/s) of the Turn and Look axes, as the original's Turn (0x10046dc0) and Pitch
 * (0x1003f930) per-frame handlers apply them [verified]: yaw = axis x turn sensitivity x 220 deg/s
 * (p158 / p161 / p164 / p167 / p170), pitch = axis x pitch sensitivity x 2 x 42 deg/s (p190 /
 * p191), negated by Invert Pitch (flag 0x10). No ramp, no boost: the applied rate follows the
 * input at once (+0x182 = 1e6). `turn` > 0 turns left, `look` > 0 looks up.
 */
export function lookRates(turn: number, look: number, o: { turnSens?: number; pitchSens?: number; invert?: boolean } = {}): { yaw: number; pitch: number } {
  const D = Math.PI / 180;
  const ts = o.turnSens ?? 1, ps = o.pitchSens ?? 1;
  return { yaw: turn * ts * TURN_RATE_DEG * D, pitch: look * ps * PITCH_INPUT_SCALE * PITCH_RATE_DEG * D * (o.invert ? -1 : 1) };
}
/** Auto Pitch Correction delay: p197 (s of continuous third-person movement). */
export const AUTO_PITCH_DELAY = 2.2;

/**
 * Health action 0x430 (input handler block RFL 0x10049a28..0x10049aed) [verified]: one bottle
 * per press, only while alive, neither morphing nor transformed (states 19 / 20), not under
 * script control (+0x9c bit 1) nor Controlled (state 11), carrying a Health Bonus Item, and only
 * when more than 1 point of health is missing (max - health > 1.0). No state, clip or lock:
 * the heal is immediate.
 */
export const HEAL_MIN_MISSING = 1;

export interface HealGate {
  alive: boolean;
  health: number;
  maxHealth: number;
  /** Morphing or transformed (insanity). */
  transformed: boolean;
  /** Under script / sequence control (a cinematic) or the Controlled state. */
  scripted: boolean;
  /** Health Bonus Items carried. */
  bottles: number;
}

export function canDrinkHealth(g: HealGate): boolean {
  return g.alive && g.health > 0 && !g.transformed && !g.scripted && g.bottles > 0 && g.maxHealth - g.health > HEAL_MIN_MISSING;
}

/**
 * Health a bottle restores (use routine 0x100b6cd0) [verified]: Health Bonus Item p55 x its p56
 * Difficulty Modifier x a reputation factor (0x1002d5d0 -> 0x10041f30): Player p76 (0.5) at the
 * evil end of p70..p71 (-150..150) to p77 (1.5) at the good end, linear and clamped, so 1 at
 * neutral. The result is added and clamped to the maximum (0x1002daa0).
 */
export function healAmount(p55: number, difficultyModifier: number, reputation: number, repRange: readonly [number, number] = [-150, 150], scale: readonly [number, number] = [0.5, 1.5]): number {
  const [lo, hi] = repRange;
  const t = hi > lo ? Math.min(1, Math.max(0, (reputation - lo) / (hi - lo))) : 0.5;
  const dm = Number.isFinite(difficultyModifier) && difficultyModifier > 0 ? difficultyModifier : 1;
  return p55 * dm * (scale[0] + (scale[1] - scale[0]) * t);
}

/**
 * The Xombium hint, player event 6 (Player p298, a Help Popup with a <Health> control
 * placeholder, once per game) [verified]: on picking a bottle up below
 * half health (0x10039e0e), or on taking damage below 80 % while a bottle is carried
 * (0x1002dfb4).
 */
export const HEALTH_HINT_EVENT = 6;
export function healthHintDue(on: 'pickup' | 'damage', health: number, maxHealth: number, bottles: number): boolean {
  if (!(maxHealth > 0)) return false;
  const f = health / maxHealth;
  return on === 'pickup' ? f < 0.5 : f < 0.8 && bottles > 0;
}

/**
 * Fall damage of a drop of `height` (0x1002db30): f = (h - 6.5) / (7.7 - 6.5) clamped to 0..1,
 * damage = max(maxHealth * f, health * f) - linear from 6.5, lethal from 7.7. A landing in water
 * scales f by `water` = (1 - p27 %)^depth (0x1002dbc4, levels/water.ts waterFallFactor).
 */
export function fallDamage(height: number, maxHealth: number, health: number, water = 1): number {
  if (!(height > FALL_DAMAGE_MIN)) return 0;
  const f = Math.min(1, (height - FALL_DAMAGE_MIN) / (FALL_DAMAGE_MAX - FALL_DAMAGE_MIN)) * water;
  return Math.max(maxHealth * f, health * f);
}

/**
 * Drop-height tracker. The original measures from the Y on entering Fall (+1.35 for a
 * first-person jump); the port measures from the highest feet position reached while airborne
 * (the same for walking off a ledge, close to it for jumps). Vertical jumps larger than any
 * fall in one frame (teleports, respawns) reset it.
 */
export class FallTracker {
  private top: number | null = null;
  private prevY: number | null = null;

  reset(): void {
    this.top = null;
    this.prevY = null;
  }

  /** Feed one frame; returns the drop height on the landing frame, else null. */
  step(y: number, onGround: boolean, dt: number): number | null {
    if (!Number.isFinite(y)) return this.reset(), null;
    if (this.prevY !== null && Math.abs(y - this.prevY) > Math.max(2, 60 * Math.max(0, dt))) this.top = null;
    this.prevY = y;
    if (!onGround) {
      this.top = this.top === null ? y : Math.max(this.top, y);
      return null;
    }
    if (this.top === null) return null;
    const drop = this.top - y;
    this.top = null;
    return drop;
  }
}

/**
 * Retail PC default keys (RFL main control table 0x10167520, records {action, device, code,
 * -1, 1}; docs/re/player.md section 9), translated to KeyboardEvent.code / Mouse<button> /
 * Wheel<Up|Down>. Mouse axes (turn / look) are left out. The port keeps its own defaults
 * (src/game/hud/bindings.ts); this table is the reference.
 */
export const RETAIL_PC_KEYS: Readonly<Record<string, { id: number; keys: readonly string[] }>> = {
  map: { id: 0x3ff, keys: ['KeyG'] },
  documents: { id: 0x400, keys: ['KeyV'] },
  archives: { id: 0x401, keys: ['KeyB'] },
  forward: { id: 0x409, keys: ['ArrowUp', 'KeyW'] },
  backward: { id: 0x40a, keys: ['ArrowDown', 'KeyS'] },
  turnLeft: { id: 0x40b, keys: ['Numpad4'] },
  turnRight: { id: 0x40c, keys: ['Numpad6'] },
  strafeLeft: { id: 0x40f, keys: ['ArrowLeft', 'KeyA'] },
  strafeRight: { id: 0x410, keys: ['ArrowRight', 'KeyD'] },
  run: { id: 0x411, keys: ['ShiftLeft'] },
  lookUp: { id: 0x41c, keys: ['Numpad8'] },
  lookDown: { id: 0x41d, keys: ['Numpad2'] },
  fire: { id: 0x428, keys: ['Mouse0', 'Numpad0'] },
  throw: { id: 0x429, keys: ['Mouse2', 'NumpadAdd'] },
  jump: { id: 0x42a, keys: ['Space'] },
  use: { id: 0x42b, keys: ['AltLeft', 'Mouse3', 'Enter'] },
  firstPerson: { id: 0x42c, keys: ['ControlLeft'] },
  health: { id: 0x430, keys: ['Tab', 'Mouse4'] },
  insanity: { id: 0x42d, keys: ['KeyC'] },
  reload: { id: 0x425, keys: ['KeyR'] },
  flashlight: { id: 0x426, keys: ['KeyF'] },
  flare: { id: 0x427, keys: ['KeyT'] },
  rollLeft: { id: 0x432, keys: ['KeyQ'] },
  rollRight: { id: 0x433, keys: ['KeyE'] },
  shiv: { id: 0x434, keys: ['Digit1'] },
  fireAxe: { id: 0x435, keys: ['Digit2'] },
  pistol: { id: 0x436, keys: ['Digit3'] },
  dualPistols: { id: 0x437, keys: ['Digit4'] },
  shotgun: { id: 0x438, keys: ['Digit5'] },
  tommyGun: { id: 0x439, keys: ['Digit6'] },
  flamethrower: { id: 0x43a, keys: ['Digit7'] },
  flashBang: { id: 0x43b, keys: ['Digit8'] },
  shrapnel: { id: 0x43c, keys: ['Digit9'] },
  tnt: { id: 0x43d, keys: ['Digit0'] },
  molotov: { id: 0x43e, keys: ['Backquote'] },
  prevWeapon: { id: 0x43f, keys: ['BracketLeft', 'Numpad7'] },
  nextWeapon: { id: 0x440, keys: ['BracketRight', 'Numpad9'] },
  prevThrown: { id: 0x441, keys: ['Numpad1', 'Period'] },
  nextThrown: { id: 0x442, keys: ['Numpad3', 'Comma'] },
  inventory: { id: 0x42f, keys: ['KeyI'] },
};
