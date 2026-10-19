// The player's use animations: the original's Interact state (player state 22, Suffering.rfl
// enter 0x10035040, per frame 0x100369a0, leave 0x10035580) for every usable object whose
// Interaction Properties name a clip. docs/game-logic.md §14.5 "Use animations".
//
// Interaction Properties templates (base class 0x027fbd01 and its Switch / Phone / Pushable /
// Mountable / Ladder kinds share p0..p21) [verified reads unless marked]:
//   p0   1: the approach is relative to the object's placement (+0x4a, saved at load), 0: to its
//        current transform (a swinging door) (0x100ba5b0).
//   p1..p6  reach / height / side / bearing / facing tests of the shared interaction test
//        0x100bb4e0 (see clamber.ts) [the port picks the nearest approach instead, inferred].
//   p11  the side the player faces: 0 +x, 1 +z, 2 -x, 3 -z of the object; used with p12 = 1
//        (p12 = 0: the player faces the object's origin).
//   p13  the clip (usable vt+0xcc; a Phone reads its own p22 instead, Pushable its p23..).
//   p14  the Switch's locked-attempt clip (Switch vt+0xb4: rattle the handle).
//   p15..p17  where the player stands: object origin + p15·x + p16·y + p17·z (its axes).
//   p18  the player's yaw from the p11 side, degrees (0x100ba380: p18 · k, then 0x1000c6a0).
//        Sign [strong]: with the port's frames a positive p18 turns counter-clockwise seen from
//        above; it puts 1a's Shiv grip 0.22 m from the hand at StartInteract (the other sign 0.52).
//   p19  seconds to slide and turn the player onto that spot (0.2; vt+0xc4, player +0x374).
//   p20  read by vt+0xac (== 1) [role not traced].
//   p21  weapons during the use (0x10037530): 1 holster when the weapon's PWP p171 says so,
//        2 the off-hand weapon only, 3 both [reads verified, roles inferred; not modelled].
//
// The state [verified]:
//   1. Enter: the usable's p27 fires at once (vt+0xec 0x100ba360) - before the walk-up, so
//      level logic keyed on p27 runs on the use, not on the clip (1a's Shiv spot: BlowUp to the
//      inmate 0.831 + 0.15 s after the use). The view pitch is zeroed (+0x5ae), the start
//      transform saved, and the held weapon's idle p13 plays while the player is moved.
//   2. Align: over p19 s the player's transform is interpolated from the start to the approach
//      (position lerp, rotation slerp, 0x10036c0f..0x10036ca2); movement input is ignored (the
//      Move state is not running), the camera may orbit (Camera Yaw state 24, third person).
//   3. Arrive (timer crosses 0): the usable's vt+0xe8 runs (Switch without a clip starts
//      moving, Quest Item Pickup / Phone mark themselves busy); next frame the clip plays
//      (0x1004cb20(clip, bone 0, blend -1, start -1, rate 1)).
//   4. Clip events (Player message map 0x10174af0): StartInteract (400) -> usable vt+0xb8(bone)
//      (0x10034910), EndInteract (401) -> vt+0xbc (0x10034a10). The bone is the event's bone.
//   5. The clip ends (0x10034850): leave the state (Security Monitor: View Monitor state 23).
//      Phones stage their own clips (0x10035ba0). Leaving calls vt+0xdc(0), which completes a
//      use the clip did not (a Quest Item Pickup hands its item over if EndInteract never came).
//
// First person [verified, 0x1003675f]: Switches and Toilets are used at once, with no walk-up
// and no clip (p69 / 68 on the switch, StartInteract and EndInteract run back to back); every
// other usable enters the Interact state as in third person and the first-person model (2:138,
// same rig) plays the same clip, filmed from the rigid first-person eye (Player p106..p108:
// 1.85 up, 0.44 behind the model's origin; pitch zeroed).
//
// Root motion [inferred]: the clip is started without root extraction flags, but door clips end
// up to 1.2 m from where they start (2:200 / 2:196) and none returns, so the port moves the feet
// by the clip's horizontal root translation (the body drops it from the pose, like locomotion).

import * as THREE from 'three/webgpu';
import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import { readAnimEvents, sampleTrackTranslation, type AnimClipData } from '../../formats/animation';
import { loadClip } from '../actors/clipmap';

/** Animation event messages (ANIM_MESSAGES). */
export const START_INTERACT = 400;
export const END_INTERACT = 401;

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? { pkg: v.pkg, id: v.id } : undefined);
export const refList = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');

/** An Interaction Properties template (any kind), decoded. */
export interface InteractionProps {
  ref: ResRef;
  cls: string;
  values: PropValue[];
  /** p0: approach relative to the placement (else the current transform). */
  fromPlacement: boolean;
  /** p12 / p11: face along an object side (0 +x, 1 +z, 2 -x, 3 -z) instead of its origin. */
  faceSide: number | null;
  /** p15..p17: the player's feet in the object's frame. */
  offset: [number, number, number];
  /** p18: the player's yaw from the facing direction (degrees, counter-clockwise from above). */
  yaw: number;
  /** p19: seconds to move the player onto the approach. */
  align: number;
  /** p13 / p14: the clip and the Switch's locked-attempt clip. */
  clip?: ResRef;
  lockedClip?: ResRef;
}

const tplCache = new WeakMap<object, Map<string, InteractionProps | null>>();

/** Decode an Interaction Properties template (cached per package set). */
export function readInteractionProps(pkgs: EntityPackageSet, r: ResRef | undefined): InteractionProps | undefined {
  if (!r) return undefined;
  let cache = tplCache.get(pkgs);
  if (!cache) tplCache.set(pkgs, (cache = new Map()));
  const k = `${r.pkg}:${r.id}`;
  if (!cache.has(k)) {
    const t = readObjectTemplate(pkgs, r);
    const c = t ? classByHash(t.classHash) : undefined;
    if (!t || !c || !/Interaction Properties$/.test(c.name) || c.name === 'Clamber Interaction Properties' || c.name === 'NPC Interaction Properties') cache.set(k, null);
    else {
      const v = decodeTemplateProps(c, t);
      cache.set(k, {
        ref: r,
        cls: c.name,
        values: v,
        fromPlacement: num(v[0], 1) !== 0,
        faceSide: num(v[12], 1) !== 0 ? num(v[11], 1) & 3 : null,
        offset: [num(v[15]), num(v[16]), num(v[17])],
        yaw: num(v[18]),
        align: Math.max(0, num(v[19], 0.2)),
        clip: ref(v[13]),
        lockedClip: ref(v[14]),
      });
    }
  }
  return cache.get(k) ?? undefined;
}

/** Where the player stands and faces for an interaction. `yaw`: the port's yaw (0 looks down -Z). */
export interface Approach {
  feet: THREE.Vector3;
  yaw: number;
}

/**
 * The approach of an Interaction Properties template (0x100ba380 -> 0x100ba5b0): `placement` is
 * the object's placement matrix, `current` its current one (a door's swing included).
 */
export function approachOf(ip: InteractionProps, placement: THREE.Matrix4, current: THREE.Matrix4 = placement): Approach {
  const M = ip.fromPlacement ? placement : current;
  const o = new THREE.Vector3().setFromMatrixPosition(M);
  const ax = new THREE.Vector3().setFromMatrixColumn(M, 0);
  const ay = new THREE.Vector3().setFromMatrixColumn(M, 1);
  const az = new THREE.Vector3().setFromMatrixColumn(M, 2);
  const [x, y, z] = ip.offset;
  const feet = o.clone().addScaledVector(ax, x).addScaledVector(ay, y).addScaledVector(az, z);
  // Facing before p18: an object side (p12 = 1) or the object's origin.
  let fx: number, fz: number;
  if (ip.faceSide !== null) {
    const a = ip.faceSide & 1 ? az : ax;
    const s = ip.faceSide & 2 ? -1 : 1;
    (fx = a.x * s), (fz = a.z * s);
  } else (fx = o.x - feet.x), (fz = o.z - feet.z);
  const l = Math.hypot(fx, fz) || 1;
  (fx /= l), (fz /= l);
  const t = (ip.yaw * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const rx = fx * c + fz * s, rz = -fx * s + fz * c;
  return { feet, yaw: Math.atan2(-rx, -rz) };
}

/**
 * The template of `list` the player uses: the one whose approach is nearest the feet [inferred;
 * the original takes the first that passes 0x100bb4e0's side / reach tests, which for the
 * retail two-sided lists is the side the player stands on].
 */
export function nearestInteraction(pkgs: EntityPackageSet, list: readonly ResRef[], placement: THREE.Matrix4, current: THREE.Matrix4, feet: THREE.Vector3Like): { ip: InteractionProps; approach: Approach } | undefined {
  let best: { ip: InteractionProps; approach: Approach } | undefined;
  let bestD = Infinity;
  for (const r of list) {
    const ip = readInteractionProps(pkgs, r);
    if (!ip) continue;
    const a = approachOf(ip, placement, current);
    const d = Math.hypot(a.feet.x - feet.x, a.feet.z - feet.z);
    if (d < bestD) (bestD = d), (best = { ip, approach: a });
  }
  return best;
}

/**
 * The Switch fit test of an Interaction Properties template (vt +0x98 0x100bbe20 ->
 * 0x100bb4e0, the can-use test's template choice) [verified]: whether the player, feet `feet`
 * and body facing `forward` (horizontal), may use the object through this template.
 *   anchor  M.translation + R_current x (p7, p8, p9), M the placement (p0 = 1) or the current
 *           transform; the offset always turns with the current rotation (a swinging door);
 *   p1      horizontal reach feet -> anchor (<=), p2 the height difference (<=);
 *   p6      the body faces the anchor within p6 degrees;
 *   p3      the side normal (0 +x, 1 +z, 2 -x, 3 -z of M, flattened), p4..p5 the bearing of the
 *           player from it, degrees counter-clockwise (negatives + 360; p4 > p5 wraps round).
 * The clamber variant (clamber.ts) has its own anchor; p10 (an eye ray to the anchor) is 0 on
 * every door template and not tested here.
 */
const unitCol = (m: ArrayLike<number>, i: number) => {
  const x = m[i * 4], y = m[i * 4 + 1], z = m[i * 4 + 2];
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
};

/** The fit test's anchor (0x100bb4c0): M.translation + R_current x (p7, p8, p9). */
export function switchAnchor(ip: InteractionProps, placement: THREE.Matrix4, current: THREE.Matrix4): THREE.Vector3 {
  const v = ip.values;
  const e = (ip.fromPlacement ? placement : current).elements, c = current.elements;
  const cx = unitCol(c, 0), cy = unitCol(c, 1), cz = unitCol(c, 2);
  const ox = num(v[7]), oy = num(v[8]), oz = num(v[9]);
  return new THREE.Vector3(e[12] + cx.x * ox + cy.x * oy + cz.x * oz, e[13] + cx.y * ox + cy.y * oy + cz.y * oz, e[14] + cx.z * ox + cy.z * oy + cz.z * oz);
}

export function switchFit(ip: InteractionProps, placement: THREE.Matrix4, current: THREE.Matrix4, feet: THREE.Vector3Like, forward: { x: number; z: number }): boolean {
  const v = ip.values;
  const M = ip.fromPlacement ? placement : current;
  const e = M.elements;
  const col = unitCol;
  const { x: ax, y: ay, z: az } = switchAnchor(ip, placement, current);
  const dx = feet.x - ax, dy = feet.y - ay, dz = feet.z - az;
  const reach = num(v[1], 2);
  if (dx * dx + dz * dz > reach * reach + 1e-9) return false;
  if (Math.abs(dy) > num(v[2], 1.75) + 1e-9) return false;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return true;
  const vx = dx / d, vz = dz / d;
  // Facing: the body's forward against the way from the player to the anchor.
  const fl = Math.hypot(forward.x, forward.z) || 1;
  const cosF = (-(forward.x * vx) - forward.z * vz) / fl;
  if (cosF < Math.cos((num(v[6], 75) * Math.PI) / 180) - 1e-9) return false;
  // Bearing from the side normal.
  const side = num(v[3], 0);
  if (side < 0 || side > 3) return true;
  const a = col(e, side & 1 ? 2 : 0);
  let nx = a.x, nz = a.z;
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-6) return true;
  (nx /= nl), (nz /= nl);
  if (side & 2) (nx = -nx), (nz = -nz);
  let b = (Math.atan2(nz * vx - nx * vz, nx * vx + nz * vz) * 180) / Math.PI;
  if (b < 0) b += 360;
  let lo = num(v[4], -90), hi = num(v[5], 90);
  if (lo < 0) lo += 360;
  if (hi < 0) hi += 360;
  return lo < hi ? b >= lo - 1e-9 && b <= hi + 1e-9 : b >= lo - 1e-9 || b <= hi + 1e-9;
}

/** StartInteract / EndInteract of a clip (clip seconds) with their bones (name hashes). */
export interface ClipInteract {
  data: AnimClipData;
  start?: { time: number; bone: number };
  end?: { time: number; bone: number };
}

export function clipInteract(pkgs: PackageSet, clip: ResRef): ClipInteract | undefined {
  const data = loadClip(pkgs, clip);
  if (!data) return undefined;
  const ev = readAnimEvents(pkgs.get(clip.pkg)?.adu as Parameters<typeof readAnimEvents>[0], clip.id)?.events ?? [];
  const find = (m: number) => {
    const e = ev.find((x) => x.kind === 1 && x.param === m);
    return e ? { time: e.time, bone: e.boneHash } : undefined;
  };
  return { data, start: find(START_INTERACT), end: find(END_INTERACT) };
}

// ---------------------------------------------------------------------------
// The state machine

/** The player-body calls this module needs (PlayerBody, src/game/actors/player-body.ts). */
export interface UseBody {
  play(clip: ResRef, o?: { loop?: boolean; fade?: number; onEnd?: () => void }): number;
  release(fade?: number): void;
  boneWorld?(hash: number, out: THREE.Matrix4): boolean;
  readonly firstPersonEye?: THREE.Vector3;
  holdNeck?: boolean;
}

/** The player-controller fields this module drives (PlayerController, src/app/player.ts). */
export interface UsePlayer {
  readonly position: THREE.Vector3;
  mode: 'fp' | 'tp';
  yaw: number;
  pitch: number;
  bodyYaw: number;
  bodyYawLock?: number | null;
  eyeHeight: number;
  readonly eyeOffset?: THREE.Vector3;
  motionOverride: ((dt: number, input: { forward: number; strafe: number; jump: boolean; crouch: boolean }) => boolean) | null;
  setFeet(x: number, y: number, z: number): void;
}

/** One clip of a use. */
export interface UseStep {
  clip?: ResRef;
  /** Repeat until `hold()` turns false (the phone's listening loop). */
  hold?: () => boolean;
  /** StartInteract / EndInteract (bone name hash). */
  onStart?(bone: number): void;
  onEnd?(bone: number): void;
}

export interface UseRequest {
  /** Where to stand; null: no walk-up. */
  approach: Approach | null;
  /** p19 seconds. */
  align: number;
  /** The usable's vt+0xe8 when the player is in place. */
  onArrive?(): void;
  first: UseStep;
  /** The step after `prev` (the phone's stages); null ends the use. */
  next?(prev: UseStep): UseStep | null;
  /** After the last clip, or on cancel (`cancelled`). */
  onDone?(cancelled: boolean): void;
  /** Keys while in use (phone: Use / Jump hang up). True: handled. */
  onKey?(code: string): boolean;
  /** Floor height under a point (approach y snaps to it). */
  floor?(x: number, y: number, z: number): number | undefined;
}

const D_EYE_BLEND = 0.2;

/** Runs one use animation at a time (the Interact state). */
export class UseAnimator {
  private req: UseRequest | null = null;
  private phase: 'align' | 'clip' | 'done' = 'done';
  private t = 0;
  private from = { feet: new THREE.Vector3(), yaw: 0, body: 0 };
  private to: Approach | null = null;
  private step: UseStep | null = null;
  private info: ClipInteract | undefined;
  private clock = 0;
  private fired = { start: false, end: false };
  private rootBase = new THREE.Vector3();
  private rootYaw = 0;
  /** The body plays the step's clip (its onEnd ends the step). */
  private playing = false;
  /** First-person eye blend (0 = the port's eye, 1 = the original's rigid eye). */
  private eyeBlend = 0;
  private fp = false;

  constructor(
    private readonly pkgs: PackageSet,
    private readonly player: UsePlayer,
    private readonly body: () => UseBody | null | undefined,
  ) {}

  get active(): boolean {
    return this.req !== null;
  }

  /** Can a use start now (none running, nothing else drives the feet)? */
  get free(): boolean {
    return !this.req && !this.player.motionOverride;
  }

  /** Start a use; false when one is already running or something else drives the feet. */
  start(req: UseRequest): boolean {
    if (!this.free) return false;
    const pl = this.player;
    this.req = req;
    this.fp = pl.mode === 'fp';
    this.from = { feet: pl.position.clone(), yaw: pl.yaw, body: pl.bodyYaw };
    this.to = req.approach ? { feet: req.approach.feet.clone(), yaw: req.approach.yaw } : null;
    if (this.to) {
      const g = req.floor?.(this.to.feet.x, this.to.feet.y, this.to.feet.z);
      this.to.feet.y = g ?? pl.position.y;
    }
    this.t = 0;
    this.phase = 'align';
    pl.motionOverride = this.override;
    // Enter: the view pitch is zeroed (+0x5ae).
    if (this.fp) pl.pitch = 0;
    const b = this.body();
    if (b && 'holdNeck' in b) b.holdNeck = false;
    if (!this.to || req.align <= 0) this.arrive();
    return true;
  }

  /** Abort (level change, death): no more callbacks except onDone(true). */
  cancel() {
    const r = this.req;
    if (!r) return;
    this.finish(true);
  }

  /** Keys while in use: the request's handler, else swallowed (the Move state is not running). */
  onKey(code: string): boolean {
    if (!this.req) return false;
    return this.req.onKey ? this.req.onKey(code) : true;
  }

  /** End the current clip now, without its remaining events, and go on (the phone's hang-up). */
  cut() {
    if (!this.req || !this.step || this.phase !== 'clip') return;
    this.fired = { start: true, end: true };
    this.advance();
  }

  /** Per frame (after the player moved). */
  update(dt: number) {
    // The eye moves back to the port's after the use.
    if (!this.req && this.eyeBlend > 0) {
      this.eyeBlend = Math.max(0, this.eyeBlend - dt / D_EYE_BLEND);
      this.applyEye();
    }
    if (!this.req || this.phase !== 'clip' || !this.step) return;
    const s = this.step;
    const info = this.info;
    if (!info) return this.advance();
    if (s.hold) {
      if (!s.hold()) this.advance();
      return;
    }
    const prev = this.clock;
    this.clock += dt * (info.data.rate || 1);
    this.events(prev, this.clock);
    // Without a body (tests) the clock ends the clip; with one, its onEnd does (begin()).
    if (this.step === s && !this.playing && this.clock >= info.data.duration) this.advance();
  }

  // -------------------------------------------------------------------------

  private drive(dt: number): boolean {
    if (!this.req) return false;
    const pl = this.player;
    if (this.phase === 'align' && this.to) {
      const r = this.req;
      this.t = Math.min(1, this.t + dt / Math.max(1e-3, r.align));
      const k = this.t;
      const f = this.from.feet, g = this.to.feet;
      pl.setFeet(f.x + (g.x - f.x) * k, f.y + (g.y - f.y) * k, f.z + (g.z - f.z) * k);
      const body = lerpAngle(this.from.body, this.to.yaw, k);
      pl.bodyYawLock = body;
      if (this.fp) pl.yaw = body;
      this.eyeBlend = this.fp ? Math.max(this.eyeBlend, k) : 0;
      if (this.t >= 1) this.arrive();
    } else if (this.phase === 'clip' && this.info && !this.step?.hold) {
      // Root motion moved onto the feet (horizontal; the pose drops it).
      const tr = sampleTrackTranslation(this.info.data, Math.min(this.clock, this.info.data.duration));
      const dx = tr[0] - this.rootBase.x, dz = tr[2] - this.rootBase.z;
      const c = Math.cos(this.rootYaw), s = Math.sin(this.rootYaw);
      const base = this.rootOrigin;
      pl.setFeet(base.x + dx * c + dz * s, pl.position.y, base.z - dx * s + dz * c);
    }
    if (this.fp) {
      pl.pitch = 0;
      pl.yaw = pl.bodyYawLock ?? pl.yaw;
    }
    this.applyEye();
    return true;
  }

  private rootOrigin = new THREE.Vector3();
  private readonly override = (dt: number) => this.drive(dt);

  private applyEye() {
    const e = this.player.eyeOffset;
    if (!e) return;
    const fp = this.body()?.firstPersonEye;
    const k = this.eyeBlend;
    if (!fp || k <= 0) return void e.set(0, 0, 0);
    // The original's eye: Player p106..p108 above / behind the model's origin.
    e.set(fp.x * k, (fp.y - this.player.eyeHeight) * k, fp.z * k);
  }

  private arrive() {
    const r = this.req;
    if (!r) return;
    const pl = this.player;
    if (this.to) {
      pl.setFeet(this.to.feet.x, this.to.feet.y, this.to.feet.z);
      pl.bodyYawLock = this.to.yaw;
      if (this.fp) pl.yaw = this.to.yaw;
    } else pl.bodyYawLock = pl.bodyYaw;
    if (this.fp) this.eyeBlend = 1;
    this.phase = 'clip';
    r.onArrive?.();
    if (this.req === r) this.begin(r.first);
  }

  private begin(s: UseStep) {
    this.step = s;
    this.fired = { start: false, end: false };
    this.clock = 0;
    this.playing = false;
    this.info = s.clip ? clipInteract(this.pkgs, s.clip) : undefined;
    const pl = this.player;
    this.rootOrigin.copy(pl.position);
    this.rootYaw = pl.bodyYawLock ?? pl.bodyYaw;
    if (this.info) {
      const t0 = sampleTrackTranslation(this.info.data, 0);
      this.rootBase.set(t0[0], t0[1], t0[2]);
    }
    const b = this.body();
    if (!this.info || !b) return;
    // The body ends the clip (a play() from its onEnd chains without a blend to locomotion).
    const len = b.play(s.clip!, { loop: !!s.hold, fade: 0.15, onEnd: () => void (this.step === s && this.advance()) });
    if (len > 0) this.playing = true;
    // A clip this rig cannot play: its events happen at once.
    else this.info = undefined;
  }

  /** The step's StartInteract / EndInteract whose time lies in [t0, t1) (clip seconds). */
  private events(t0: number, t1: number) {
    const s = this.step, i = this.info;
    if (!s || !i) return;
    const due = (e: { time: number } | undefined) => !!e && e.time >= t0 && e.time < t1;
    if (!this.fired.start && due(i.start)) {
      this.fired.start = true;
      s.onStart?.(i.start!.bone);
    }
    if (this.step === s && !this.fired.end && due(i.end)) {
      this.fired.end = true;
      s.onEnd?.(i.end!.bone);
    }
  }

  /**
   * End the step: events the clip did not reach (cut short, or a clip without them) run now,
   * in order [inferred for clips without events; the original completes a use on leaving the
   * state, vt+0xdc(0)]; then the next step or the end.
   */
  private advance() {
    const r = this.req, s = this.step;
    if (!r || !s) return;
    this.playing = false;
    if (!this.fired.start) {
      this.fired.start = true;
      s.onStart?.(this.info?.start?.bone ?? 0);
    }
    if (this.req === r && this.step === s && !this.fired.end) {
      this.fired.end = true;
      s.onEnd?.(this.info?.end?.bone ?? 0);
    }
    if (this.req !== r || this.step !== s) return;
    const n = r.next?.(s) ?? null;
    if (n && this.req === r) return this.begin(n);
    this.finish(false);
  }

  private finish(cancelled: boolean) {
    const r = this.req;
    if (!r) return;
    this.req = null;
    this.step = null;
    this.info = undefined;
    this.phase = 'done';
    const pl = this.player;
    if (pl.motionOverride === this.override) pl.motionOverride = null;
    pl.bodyYawLock = null;
    const b = this.body();
    if (b) {
      b.release(0.2);
      if ('holdNeck' in b) b.holdNeck = true;
    }
    r.onDone?.(cancelled);
  }
}

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return a + d * k;
}

/**
 * Feet heights (relative to a Ladder's base) from which walking into it mounts it: its bottom
 * Ladder Interaction Properties (p32[0]) fit test, the feet within p2 of the anchor p8 above the
 * base (generic fit 0x100bb4e0) [verified]; capped at 0.6 m above the base (the top template
 * serves from above). Without a template: -0.3 .. 0.6 (port).
 */
export function ladderFootWindow(bottom: readonly unknown[] | undefined): [number, number] {
  if (!bottom) return [-0.3, 0.6];
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const y = n(bottom[8], 0), r = n(bottom[2], 1);
  return [y - r, Math.min(y + r, 0.6)];
}
