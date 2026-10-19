// Gamepad aim assist: the console "Auto Targeting" / "Auto Pitch Correction" options
// (settings flag word bits 0x40 / 0x80, both off in the PC defaults; docs/re/player.md 2-3).
//
// The original (Suffering.rfl):
//   * Target search 0x1004ba30, every frame, only with a Ranged Weapon held: a pyramid from the
//     eye along the view, PWP p10 long (45 m for the guns), half-widths sin(p177 / p178 = 5 deg)
//     horizontally and sin(p176 = 3 deg) vertically. Selection 0x1004a250: characters whose
//     priority (template p128: creatures 10, a few 5, humans 1, bosses 0) is at least the best
//     so far (start p219 = 5), alive, in front, in range, a hit sphere inside the pyramid, line
//     of sight; score = p224 * angle (units of 1 deg) + p225 * distance / range (1, 0.1);
//     replaces the best when the score is lower or the priority higher (start score 1.1). No
//     hysteresis: picked again every frame.
//   * Turn (0x10046dc0) / Pitch (0x1003f930) with a target: stick turning is scaled by p182 0.13
//     standing, lerp(p184 0.55, p185 0.10) over 2..35 m while moving; pitch by p186 0.5 / p187
//     0.7. Without stick input, when the player or the target moved and the target is farther
//     than p188 / p189 = 3 m, the view is turned to keep the target centred (the full offset).
//   * Shots (0x10028490): with Auto Targeting on, a ranged shot goes to the target picked in a
//     1 deg pyramid (p220..p222) around the crosshair. Ranged Weapon p76 (45 deg) only cancels
//     the shot when the muzzle faces more than 45 deg away from the shot direction.
//   * Auto Pitch (Pitch per-frame 0x1003fc40): after p197 = 2.2 s of continuous third-person
//     movement (reset when stopping, firing, a target), the pitch returns to level at the pitch
//     rate (p190 = 42 deg/s).
//
// Port: gamepad play only (both options off by default, as in the original; never for the mouse). The
// weapons system publishes the candidates (with priority and the held weapon's range) through
// `aimAssist.provider`; the bindings layer (src/game/hud/bindings.ts) applies the look changes.

export interface AimCandidate {
  /** Aim point (world). */
  x: number;
  y: number;
  z: number;
  /** Body radius (angular size of the target). */
  radius: number;
  id: number;
  /** Auto-target priority: the character template's p128 (default 10, a creature). */
  priority?: number;
}

export interface AimProvider {
  /** View position (the camera: shots and the crosshair start there). */
  eye(): Vec3;
  /** Live characters near the player. */
  candidates(): AimCandidate[];
  /** True when level geometry blocks the line from the eye to the point. */
  blocked(eye: Vec3, p: Vec3): boolean;
  /** Search range (PWP p10 of the held weapon); 0 = no auto-targeting (no Ranged Weapon). */
  range?(): number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;

/** Search pyramid half-angles (Player p177 / p178, p176) and default range (PWP p10). */
export const ACQUIRE_H_DEG = 5;
export const ACQUIRE_V_DEG = 3;
export const MAX_DIST = 45;
/** Kept for callers of the earlier API: the horizontal half-angle. */
export const ACQUIRE_DEG = ACQUIRE_H_DEG;
/** Minimum priority / initial best (p219) and the score weights (p224, p225). */
export const MIN_PRIORITY = 5;
export const SCORE_ANGLE = 1;
export const SCORE_DIST = 0.1;
/** Shot snap pyramid (p220..p222). */
export const SHOT_DEG = 1;
/** Turn slowdown: standing p182, moving p184 (near) .. p185 (far) over p180..p181 m. */
export const SLOW_STANDING = 0.125;
export const SLOW_MOVING_NEAR = 0.55;
export const SLOW_MOVING_FAR = 0.1;
export const SLOW_NEAR_DIST = 2;
export const SLOW_FAR_DIST = 35;
/** Pitch slowdown: standing p186, moving p187. */
export const PITCH_SLOW_STANDING = 0.5;
export const PITCH_SLOW_MOVING = 0.7;
/** No tracking closer than p188 / p189 (m). */
export const TRACK_MIN_DIST = 3;
/** Tracking turn-rate cap (rad/s) [port: the original corrects the whole offset in a frame]. */
export const TRACK_MAX_RATE = 220 * DEG;
/** Earlier name of the standing slowdown. */
export const SLOWDOWN = SLOW_STANDING;
/** Auto Pitch Correction: delay (p197, s) and rate (p190, rad/s). */
export const AUTO_PITCH_DELAY = 2.2;
export const AUTO_PITCH_RATE = 42 * DEG;

export interface AimLock {
  target: AimCandidate;
  /** Angle from the crosshair to the target (rad) and its components. */
  angle: number;
  dYaw: number;
  dPitch: number;
  /** Target direction as yaw / pitch (same convention as PlayerController). */
  yaw: number;
  pitch: number;
  dist: number;
  /** Horizontal acquisition half-angle (rad, including the target's angular radius). */
  cone: number;
  /** View-space offsets: right, up, along the view (m). */
  vx: number;
  vy: number;
  vz: number;
  priority: number;
  score: number;
}

export function wrapAngle(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

/** Yaw / pitch of the direction from `eye` to `p` (yaw 0 looks down -Z, +pitch up). */
export function directionAngles(eye: Vec3, p: Vec3): { yaw: number; pitch: number; dist: number } {
  const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
  const h = Math.hypot(dx, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, h), dist: Math.hypot(h, dy) };
}

/** View-space offsets of `p` (camera rotation order YXZ: right, up, forward). */
function viewSpace(eye: Vec3, yaw: number, pitch: number, p: Vec3): { x: number; y: number; z: number } {
  const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  return {
    x: dx * cy - dz * sy,
    y: dx * sy * sp + dy * cp + dz * cy * sp,
    z: -dx * sy * cp + dy * sp - dz * cy * cp,
  };
}

/** True when a sphere (view-space centre, radius) touches the pyramid of half-angles h / v. */
function inPyramid(x: number, y: number, z: number, r: number, hRad: number, vRad: number): boolean {
  if (!(z > 0)) return false;
  return Math.abs(x) * Math.cos(hRad) - z * Math.sin(hRad) <= r && Math.abs(y) * Math.cos(vRad) - z * Math.sin(vRad) <= r;
}

/** The original's target selection (0x1004ba30 / 0x1004a250); null when nothing qualifies. */
export function pickTarget(
  eye: Vec3,
  yaw: number,
  pitch: number,
  list: readonly AimCandidate[],
  opts: { range?: number; hDeg?: number; vDeg?: number; acquireDeg?: number; maxDist?: number; minPriority?: number; blocked?: (eye: Vec3, p: Vec3) => boolean } = {},
): AimLock | null {
  const range = opts.range ?? opts.maxDist ?? MAX_DIST;
  if (!(range > 0)) return null;
  const hRad = (opts.hDeg ?? opts.acquireDeg ?? ACQUIRE_H_DEG) * DEG;
  const vRad = (opts.vDeg ?? ACQUIRE_V_DEG) * DEG;
  const unit = Math.sin(DEG); // score angle unit (p220..p222 = 1 deg)
  let best: AimLock | null = null;
  let bestScore = SCORE_ANGLE + SCORE_DIST;
  let bestPriority = opts.minPriority ?? MIN_PRIORITY;
  for (const t of list) {
    const priority = Number.isFinite(t.priority) ? (t.priority as number) : 10;
    if (priority < bestPriority) continue;
    const r = Number.isFinite(t.radius) ? Math.max(0, t.radius) : 0.4;
    const v = viewSpace(eye, yaw, pitch, t);
    const dist = Math.hypot(v.x, v.y, v.z);
    if (!(dist >= 0.3 && dist <= range)) continue; // also drops NaN positions
    if (!inPyramid(v.x, v.y, v.z, r, hRad, vRad)) continue;
    const score = SCORE_ANGLE * Math.hypot(v.x / (v.z * unit), v.y / (v.z * unit)) + (SCORE_DIST * v.z) / range;
    if (!(score < bestScore || priority > bestPriority)) continue;
    if (opts.blocked?.(eye, t)) continue;
    const d = directionAngles(eye, t);
    const dYaw = wrapAngle(d.yaw - yaw);
    const dPitch = d.pitch - pitch;
    bestScore = score;
    bestPriority = priority;
    best = {
      target: t,
      angle: Math.hypot(dYaw * Math.cos(pitch), dPitch),
      dYaw,
      dPitch,
      yaw: d.yaw,
      pitch: d.pitch,
      dist,
      cone: hRad + Math.atan2(r, dist),
      vx: v.x,
      vy: v.y,
      vz: v.z,
      priority,
      score,
    };
  }
  return best;
}

/**
 * Look rates (rad/s) with a target. `look` = the player's own stick rates, `steer` 0..1 = how
 * much the player is steering (stick deflection / walking). opts: `dt` (frame time, for the
 * tracking rate), `moving` (defaults to steer > 0), `targetMoved` (the target moved this frame).
 */
export function assistLook(
  lock: AimLock | null,
  look: { yaw: number; pitch: number },
  steer: number,
  _pitch: number,
  opts: { dt?: number; moving?: boolean; targetMoved?: boolean } = {},
): { yaw: number; pitch: number } {
  if (!lock) return look;
  const moving = opts.moving ?? steer > 0;
  const t = clamp((lock.dist - SLOW_NEAR_DIST) / (SLOW_FAR_DIST - SLOW_NEAR_DIST), 0, 1);
  const slowYaw = moving ? SLOW_MOVING_NEAR + (SLOW_MOVING_FAR - SLOW_MOVING_NEAR) * t : SLOW_STANDING;
  const slowPitch = moving ? PITCH_SLOW_MOVING : PITCH_SLOW_STANDING;
  let yaw = look.yaw * slowYaw;
  let pitch = look.pitch * slowPitch;
  // Tracking: no stick input on that axis, relative motion, not too close.
  if ((moving || opts.targetMoved) && lock.dist > TRACK_MIN_DIST) {
    const dt = opts.dt && opts.dt > 0 ? opts.dt : 1 / 60;
    if (Math.abs(look.yaw) < 1e-6) yaw = clamp(lock.dYaw / dt, -TRACK_MAX_RATE, TRACK_MAX_RATE);
    if (Math.abs(look.pitch) < 1e-6) pitch = clamp(lock.dPitch / dt, -TRACK_MAX_RATE, TRACK_MAX_RATE);
  }
  return { yaw, pitch };
}

/** Pitch rate (rad/s) of Auto Pitch Correction toward `goal` (level), never overshooting. */
export function autoPitchRate(pitch: number, goal = 0, dt = 1 / 60): number {
  const d = goal - pitch;
  if (Math.abs(d) < 1e-4) return 0;
  return Math.sign(d) * Math.min(AUTO_PITCH_RATE, Math.abs(d) / Math.max(1e-3, dt));
}

/** The shot snap (0x1004ad20): the locked target touches the 1 deg pyramid around the crosshair. */
export function shotTarget(lock: AimLock | null): AimLock | null {
  if (!lock) return null;
  const r = Number.isFinite(lock.target.radius) ? Math.max(0, lock.target.radius) : 0.4;
  return inPyramid(lock.vx, lock.vy, lock.vz, r, SHOT_DEG * DEG, SHOT_DEG * DEG) ? lock : null;
}

/**
 * Ranged Weapon p76 sanity check (fire routine 0x10127fed): the shot is cancelled when the muzzle
 * faces more than p76 deg away from the shot direction. The port has no muzzle axis, so it
 * compares the crosshair with the direction to the target.
 */
export function withinWeaponCone(lock: AimLock | null, coneDeg: number): boolean {
  if (!lock || !(coneDeg > 0)) return false;
  return Math.cos(lock.angle) >= Math.cos(coneDeg * DEG);
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Shared state: the weapons system sets the provider, the bindings layer the current lock. */
export const aimAssist: { provider: AimProvider | null; lock: AimLock | null; enabled: boolean } = {
  provider: null,
  lock: null,
  enabled: false,
};
