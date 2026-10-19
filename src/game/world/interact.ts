// Player interactions with world objects beyond doors and pickups (docs/game-logic.md §14.5):
//
//   Phone            Use: answer - pick-up, listen and hang-up clips with the receiver in the
//                    hand (use-anim.ts), the dialog line p35 once the receiver is at the ear, or
//                    the dial tone p34 when nobody calls; p39 message rings it (p38 every p32 s,
//                    0x1001a180), p40 / p44 stop ringing.
//   Security Monitor Use: look through the camera (Mechanism p47, offset p48..p50 in its frame,
//                    FOV p51 across a 4:3 screen) full screen until Use / Esc / a movement key,
//                    behind the CRT glass / no-signal screen and the Warp Effect card
//                    (monitor-view.ts); p70 / p71 switch the no-signal screen on / off; p72 fired
//                    when the view starts, p73 when it ends [guess]. The monitors in the world
//                    show only their own Animating Material (the original has no render-to-texture
//                    feed: monitor-view.ts).
//   Toilet           Use: flush - the p32 Object Generator and the p31 swirl model for a while
//                    (third person: at the clip's StartInteract; first person: at once).
//   Switch           Use (world.ts -> useSwitch): first person at once; third person walks up,
//                    plays the template's clip and moves the switch at its StartInteract.
//   Quest Item Pickup Use (world.ts -> useSpot): p27 at once, the item at the clip's EndInteract.
//   Ladder           Use (or walking into it facing it) near the bottom / top attaches; W/S climb,
//                    Space lets go; the top exit puts the player on the landing (p30 = height).
//   Clamber Point    Jump (or Use) facing the ledge climbs onto it where the player stands along
//                    it (clamber.ts: Clamber Interaction Properties reach, height, side tests).
//   Mountable        Use: mount the gun (yaw ±p38/2, pitch -p43..p42), left mouse fires
//                    (p40 rounds per minute, p45 damage per round through services.damage /
//                    services.actors, p55 / p50 generators for the muzzle and casings), Use
//                    dismounts. p62 On / p63 Off enable it.
//   Pushable         Use: grab / let go (props.ts moves it).
//
// Interaction Properties templates place the player relative to the object (p15..p17 in its
// frame, p18 yaw) and name the clips; use-anim.ts runs the original's Interact state (walk-up,
// clip, StartInteract / EndInteract events) for phones, monitors, toilets, switches and quest
// item spots. Ladder rungs and push / pull clips play through actors/interaction-clips.ts.

import * as THREE from 'three/webgpu';
import type { ResRef } from '../../formats/model';
import type { EntityPackageSet } from '../../formats/entities';
import type { PlayerController } from '../../app/player';
import type { CollisionWorld } from '../../app/physics';
import type { World, WorldEntity } from './logic';
import type { DynamicObjects } from './dynamic';
import type { Props } from './props';
import type { Fx } from './fx';
import { readTemplate } from './fx';
import { clamberRoom, clamberSide } from './clamber';
import type { DamageService } from './damage';
import { InteractionClips, type PlayerBodyClips } from '../actors/interaction-clips';
import { UseAnimator, ladderFootWindow, approachOf, nearestInteraction, readInteractionProps, switchAnchor, switchFit, type UseBody, type UseStep } from './use-anim';
import { instanceMatrix } from './dynamic';
import { hudBus } from '../hud/bus';
import { MonitorOverlay, monitorFov } from './monitor-view';
import { hardpointLocal } from './searchlight';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ResRef) : null);
const refList = (v: unknown): ResRef[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is ResRef => !!x && typeof x === 'object') : []);
const keyOf = (r: ResRef) => `${r.pkg}:${r.id}`;

/** A Clamber Point's object matrix from its placement: position, rotation, instance scale. */
/**
 * The view on a modelless usable's anchor (6a's truck jack a08: a Switch with no model, so no
 * box for the port's look-at prompt): within `reach` m ahead and 0.6 m of the view ray [port].
 */
/**
 * Mountable aim limits (0x100183e0) [verified]: the turn from the placement within +-p38 degrees,
 * the pitch within +-p42 degrees (360 / none: unlimited). `dyaw` / `pitch` in radians.
 */
/** The climbing face of a ladder from its Ladder Interaction Properties p3: +1 along the frame's fwd (local -z), -1 against it, 0 unknown. */
export function ladderFaceSide(ip: readonly unknown[] | undefined): number {
  const v = ip?.[3];
  if (typeof v !== 'number') return 0;
  const sd = v & 3;
  return sd === 3 ? 1 : sd === 1 ? -1 : 0;
}

export function mountedAimLimits(v: readonly unknown[], dyaw: number, pitch: number): { yaw: number; pitch: number } {
  const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  let dy = dyaw - Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
  const yawRange = THREE.MathUtils.degToRad(n(v[38], 360));
  if (yawRange < Math.PI) dy = THREE.MathUtils.clamp(dy, -yawRange, yawRange);
  const pr = THREE.MathUtils.degToRad(n(v[42], 55));
  return { yaw: dy, pitch: THREE.MathUtils.clamp(pitch, -pr, pr) };
}

export function viewOnAnchor(eye: THREE.Vector3Like, dir: THREE.Vector3Like, anchors: readonly THREE.Vector3Like[], reach: number): boolean {
  return anchors.some((a) => {
    const vx = a.x - eye.x, vy = a.y - eye.y, vz = a.z - eye.z;
    const t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t <= 0 || t > reach) return false;
    return Math.hypot(vx - dir.x * t, vy - dir.y * t, vz - dir.z * t) <= 0.6;
  });
}

export function clamberMatrix(position: [number, number, number], rotation: [number, number, number], scale?: [number, number, number] | null) {
  const s = scale ?? [1, 1, 1];
  return instanceMatrix(position, rotation).scale(new THREE.Vector3(s[0], s[1], s[2]));
}

export interface InteractEnv {
  world: World;
  pkgs: EntityPackageSet;
  dyn: DynamicObjects;
  props: Props;
  fx: Fx;
  player: PlayerController;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  collision: () => CollisionWorld | null;
  walking: () => boolean;
  playSound(keys: string[], pos: [number, number, number], opts?: { radius?: number; loop?: boolean; voice?: boolean }): { stop(): void; readonly playing: boolean } | undefined;
  toast(text: string, ms?: number): void;
  banner(text: string | null): void;
  damage(): DamageService | undefined;
  actors():
    | {
        raycast(o: THREE.Vector3Like, d: THREE.Vector3Like, max: number): { actor: unknown; distance: number; point: THREE.Vector3 } | null;
        damage(a: unknown, amount: number, from?: THREE.Vector3Like): boolean;
        readonly playerBody?: PlayerBodyClips | null;
      }
    | undefined;
}

export interface UseTarget {
  uid: number;
  w: WorldEntity;
  prompt: string;
  use(): void;
}

const USE_CLASSES = new Set(['Phone', 'Security Monitor', 'Toilet', 'Mountable', 'Pushable', 'Ladder']);

interface ClimbState {
  kind: 'ladder';
  w: WorldEntity;
  base: THREE.Vector3;
  up: number;
  height: number;
  /** Horizontal spot on the ladder (feet). */
  spot: THREE.Vector3;
  /** Exit at the top (landing). */
  top: THREE.Vector3;
  y: number;
  exiting?: { from: THREE.Vector3; to: THREE.Vector3; t: number };
}

export class Interactions {
  /** Ringing phones: seconds to the next ring (p38 every p32 s). */
  private ringing = new Map<number, { next: number; sound?: { stop(): void } }>();
  private talking?: { stop(): void; readonly playing: boolean };
  private monitorView?: { w: WorldEntity; t: number; fov: number };
  /** What rides in front of the eye during a monitor view, per monitor template. */
  private overlays = new Map<string, MonitorOverlay>();
  climb?: ClimbState;
  /** A mounted object's view pitch (searchlight beams follow it, searchlight.ts). */
  onMountedPitch?: (uid: number, pitch: number) => void;
  /**
   * Crane controls (levels/crane.ts): a Mountable whose p30 names a Crane drives it. Set by the
   * levels system; `drive` gets the hoist (vertical look) and slew (horizontal look) inputs.
   */
  craneControl?: {
    drive(mountable: WorldEntity, crane: number, hoist: number, slew: number, dt: number): void;
  };
  /** Fire pressed on a mounted searchlight. */
  onMountedToggle?: (uid: number) => void;
  private clamber?: { from: THREE.Vector3; mid: THREE.Vector3; to: THREE.Vector3; t: number };
  mounted?: { w: WorldEntity; yaw0: number; fireAcc: number; firing: boolean; base: THREE.Matrix4; light?: boolean; crane?: number };
  /** Each Mountable's placement matrix (its turn is measured from it: Mountable +0xce). */
  private mountPlacement = new Map<number, THREE.Matrix4>();
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();
  /** Player-body clips of the interactions (actors/interaction-clips.ts). */
  private readonly clips: InteractionClips;
  /** The Interact state: walk-up, use clip and its events (use-anim.ts). */
  private readonly use: UseAnimator;
  /** A phone receiver in the hand: follows the clip's StartInteract bone until EndInteract. */
  private heldReceiver?: { uid: number; bone: number; home: THREE.Matrix4; solid: boolean };

  constructor(readonly env: InteractEnv) {
    this.clips = new InteractionClips(env.pkgs, () => env.actors()?.playerBody);
    this.use = new UseAnimator(env.pkgs as unknown as ConstructorParameters<typeof UseAnimator>[0], env.player, () => env.actors()?.playerBody as unknown as UseBody | undefined);
    // Overlays built at load (their pipelines are pre-warmed); all retail monitors share one.
    for (const w of env.world.of('Security Monitor')) this.overlayOf(w);
    env.world.handlers.push((w, msg) => this.onMessage(w, msg));
    window.addEventListener('mousedown', this.onMouse);
    window.addEventListener('mouseup', this.onMouse);
  }

  private onMouse = (e: MouseEvent) => {
    if (!this.mounted || e.button !== 0) return;
    // A searchlight: each press switches it lit / dark (searchlight.ts).
    if (this.mounted.light && e.type === 'mousedown') this.onMountedToggle?.(this.mounted.w.uid);
    this.mounted.firing = e.type === 'mousedown';
  };

  private onMessage(w: WorldEntity, msg: number): boolean {
    const v = w.e.values;
    if (w.cls === 'Phone') {
      if (num(v[39]) === msg) return this.ring(w, true), true;
      if (num(v[40]) === msg || num(v[44]) === msg) return this.ring(w, false), true;
      if (num(v[41]) === msg) return (w.s.armed = true), true;
      return false;
    }
    if (w.cls === 'Security Monitor') {
      // Disable / Enable: the no-signal flag (0x1001a970 / 0x1001a980), not the use lock.
      if (num(v[70]) === msg) return (w.s.noSignal = true), true;
      if (num(v[71]) === msg) return (w.s.noSignal = false), true;
      return false;
    }
    if (w.cls === 'Mountable') {
      if (num(v[62]) === msg) return (w.enabled = true), true;
      if (num(v[63]) === msg) return (w.enabled = false), true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Targets

  /** Object under the crosshair that can be used (ray must hit its box before any wall). */
  pick(eye: THREE.Vector3, dir: THREE.Vector3, limit: number): UseTarget | null {
    if (this.climb || this.mounted || this.monitorView || this.clamber || this.use.active) return null;
    const ray = new THREE.Ray(eye, dir);
    let best: UseTarget | null = null;
    let bestT = Infinity;
    for (const cls of USE_CLASSES) {
      for (const w of this.env.world.of(cls)) {
        if (w.destroyed || !w.visible) continue;
        const d = this.env.dyn.objects.get(w.uid);
        if (!d || !d.visible) continue;
        const c = d.root.matrix.elements;
        // A ladder's origin is its foot: from the top of 3a's 8.5 m ladder 157b (the manhole in
        // the west walkway) it is 10 m below the eye, so its box decides instead.
        if (cls !== 'Ladder' && (c[12] - eye.x) ** 2 + (c[13] - eye.y) ** 2 + (c[14] - eye.z) ** 2 > 49) continue;
        this.env.dyn.bounds(d, this.box);
        if (cls === 'Ladder' && this.box.distanceToPoint(eye) > 7) continue;
        this.box.expandByScalar(cls === 'Ladder' ? 0.3 : 0.05);
        const p = ray.intersectBox(this.box, this.hit);
        if (!p) continue;
        const t = p.distanceTo(eye);
        if (t > limit + (cls === 'Ladder' ? 0.6 : 0) || t >= bestT) continue;
        const target = this.targetFor(w);
        if (target) (bestT = t), (best = target);
      }
    }
    return best;
  }

  private usable(w: WorldEntity) {
    // `enabled` is the lock bit: p22 `unlocked` at start, p28 inUnlock / p29 inLock (logic.ts
    // initEntity, props.ts). p23 is not "usable at all": the usable family's can-use
    // (Suffering.rfl 0x100bae80) returns 0 (usable) at once when p23 is 0 and only with p23 set
    // runs the eye-to-object ray test (blocked: 3, not usable) [verified]. Every retail
    // Mountable, most Ladders and many Security Monitors / Phones have p23 = 0 (3a's searchlights,
    // 3b's monitors); the port's pick is itself a view ray against the object's box.
    return w.enabled;
  }

  private targetFor(w: WorldEntity): UseTarget | null {
    const u = (prompt: string, use: () => void): UseTarget => ({ uid: w.uid, w, prompt: `<b>E</b> ${prompt}`, use });
    switch (w.cls) {
      case 'Phone':
        return u(this.ringing.has(w.uid) ? 'Answer phone' : 'Use phone', () => this.usePhone(w));
      case 'Security Monitor':
        return this.usable(w) ? u('View monitor', () => this.viewMonitor(w)) : null;
      case 'Toilet':
        return u('Flush', () => this.useToilet(w));
      case 'Mountable':
        return this.usable(w) ? u(this.env.world.get(num(w.e.values[30], 0))?.cls === 'Crane' ? 'Use crane' : 'Use gun', () => this.mount(w)) : null;
      case 'Pushable':
        return this.usable(w) ? u(this.env.props.grabbed() === w.uid ? 'Let go' : 'Push', () => this.env.props.toggleGrab(w.uid)) : null;
      case 'Ladder':
        return u('Climb ladder', () => this.startLadder(w));
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Phone

  /** Ringing (0x1001a180): p38 plays every p32 seconds, starting at once. */
  private ring(w: WorldEntity, on: boolean) {
    this.ringing.get(w.uid)?.sound?.stop();
    this.ringing.delete(w.uid);
    w.s.ringing = on;
    if (on) this.ringing.set(w.uid, { next: 0 });
  }

  private updateRinging(dt: number) {
    for (const [uid, r] of this.ringing) {
      const w = this.env.world.get(uid);
      if (!w || w.destroyed) {
        this.ring(w ?? ({ uid, s: {} } as WorldEntity), false);
        continue;
      }
      r.next -= dt;
      if (r.next > 0) continue;
      r.next += Math.max(0.5, num(w.e.values[32], 3));
      const keys = refList(w.e.values[38]).map(keyOf);
      if (keys.length) r.sound = this.env.playSound(keys, w.pos, { radius: 25 });
    }
  }

  /** The object's placement and current matrices (a quest spot has no model: its placement). */
  private frames(w: WorldEntity): { placement: THREE.Matrix4; current: THREE.Matrix4 } {
    const d = this.env.dyn.objects.get(w.uid);
    if (!d) {
      const M = instanceMatrix(w.e.position, w.e.rotation);
      return { placement: M, current: M };
    }
    return { placement: d.root.matrix.clone(), current: d.root.matrix.clone().multiply(d.pivot.matrix) };
  }

  /** The Interaction Properties of `list` the player uses, with its approach. */
  private interaction(w: WorldEntity, list: unknown) {
    const f = this.frames(w);
    return nearestInteraction(this.env.pkgs, refList(list), f.placement, f.current, this.env.player.position);
  }

  /**
   * The original's can-use test for a Switch (0x10131c30 -> template choice vt +0xa0): the first
   * Interaction Properties of its list that passes the fit test (use-anim.ts switchFit) from the
   * player's feet and facing. Returns the distance from the feet to that template's
   * approach point (the original ranks usables by it), null when none fits, undefined when the
   * Switch has no template list (the port's view test alone decides then).
   */
  switchReach(w: WorldEntity): number | null | undefined {
    const v = w.e.values;
    const list = refList(w.s.open && num(v[34]) ? v[31] : v[30]);
    if (!list.length) return undefined;
    const f = this.frames(w);
    const p = this.env.player;
    const feet = p.position;
    // The body's facing in the original; the mouse turns the body there, while the port's body
    // lags the view standing still, so the view yaw stands for it [port].
    const fwd = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
    let any = false;
    for (const r of list) {
      const ip = readInteractionProps(this.env.pkgs, r);
      if (!ip) continue;
      any = true;
      if (!switchFit(ip, f.placement, f.current, feet, fwd)) continue;
      const a = approachOf(ip, f.placement, f.current);
      return Math.hypot(a.feet.x - feet.x, a.feet.y - feet.y, a.feet.z - feet.z);
    }
    return any ? null : undefined;
  }

  /** The fit-test anchors of a Switch's templates (where the original wants the player to face; harness / debug). */
  switchAnchors(w: WorldEntity): THREE.Vector3[] {
    const v = w.e.values;
    const f = this.frames(w);
    const out: THREE.Vector3[] = [];
    for (const r of refList(w.s.open && num(v[34]) ? v[31] : v[30])) {
      const ip = readInteractionProps(this.env.pkgs, r);
      if (ip) out.push(switchAnchor(ip, f.placement, f.current));
    }
    return out;
  }

  /** Where each of a Switch's templates wants the player's feet (approach points; harness / debug). */
  switchApproaches(w: WorldEntity): THREE.Vector3[] {
    const v = w.e.values;
    const f = this.frames(w);
    const out: THREE.Vector3[] = [];
    for (const r of refList(w.s.open && num(v[34]) ? v[31] : v[30])) {
      const ip = readInteractionProps(this.env.pkgs, r);
      if (ip) out.push(new THREE.Vector3().copy(approachOf(ip, f.placement, f.current).feet));
    }
    return out;
  }

  /** Floor under an approach point (the player stands on it), if near. */
  private floorAt = (x: number, y: number, z: number): number | undefined => {
    const hit = this.env.collision()?.raycast(x, y + 1, z, 0, -1, 0, 2.5);
    return hit && Math.abs(hit.point[1] - y) < 0.75 ? hit.point[1] : undefined;
  };

  /**
   * Answer a phone (docs/game-logic.md §14.5 "Use animations"): the ring stops, p27 fires, the
   * player walks up (Phone Interaction Properties p31) and plays p22 (lift the receiver: at its
   * StartInteract the receiver goes to the event's bone), p23 while the line plays (listening,
   * looped), p24 (hang up: at EndInteract the receiver is back on the cradle and the line stops).
   * Use or Jump hangs up early (0x10035ba0). With no line the dial tone p34 plays until then.
   */
  private usePhone(w: WorldEntity) {
    if (!this.use.free) return;
    const v = w.e.values;
    const wasRinging = this.ringing.has(w.uid);
    this.ring(w, false);
    const lines = refList(v[35]).map(keyOf);
    const line = lines.length && (wasRinging || w.s.armed || !w.s.used) ? lines[0] : undefined;
    this.talking?.stop();
    this.talking = undefined;
    this.env.world.fire(w, 27);
    const sel = this.interaction(w, v[31]);
    const ip = sel?.ip.values;
    const clip = (i: number) => (ip?.[i] && typeof ip[i] === 'object' && !Array.isArray(ip[i]) ? (ip[i] as ResRef) : undefined);
    let hangUp = false;
    const startTalk = () => {
      if (line) {
        this.talking = this.env.playSound([line], w.pos, { voice: true });
        // Subtitle of the line (the sound's own .sdu subtitle string): drawn by the HUD system.
        if (this.talking) hudBus.speech = { sound: line };
        w.s.used = true;
      } else {
        const tone = refList(v[34]).map(keyOf);
        this.talking = tone.length ? this.env.playSound(tone, w.pos, { radius: 8 }) : undefined;
      }
    };
    const pickUp: UseStep = { clip: clip(22), onStart: (bone) => this.holdReceiver(w, bone) };
    const listen: UseStep = { clip: clip(23), hold: () => !hangUp && !!this.talking?.playing };
    const hang: UseStep = {
      clip: clip(24),
      onEnd: () => {
        this.releaseReceiver();
        this.talking?.stop();
      },
    };
    this.use.start({
      approach: sel?.approach ?? null,
      align: sel?.ip.align ?? 0,
      floor: this.floorAt,
      first: pickUp,
      next: (prev) => {
        if (prev === pickUp && !hangUp) {
          startTalk();
          return listen;
        }
        return prev === hang ? null : hang;
      },
      onKey: (code) => {
        if (code !== 'KeyE' && code !== 'Space') return true;
        if (!hangUp) {
          hangUp = true;
          // Straight to the hang-up clip (the stage flags switch to 0x200 at once).
          this.use.cut();
        }
        return true;
      },
      onDone: () => {
        this.releaseReceiver();
        this.talking?.stop();
      },
    });
  }

  /** StartInteract of the pick-up: the receiver follows `bone` (0x1001c830). */
  private holdReceiver(w: WorldEntity, bone: number) {
    const d = this.env.props.receiverOf(w.uid);
    if (!d || this.heldReceiver) return;
    this.heldReceiver = { uid: d.uid, bone, home: d.root.matrix.clone(), solid: d.solid };
    d.solid = false;
    this.env.dyn.refreshCollision(d, false);
    this.followReceiver();
  }

  private readonly boneM = new THREE.Matrix4();

  private followReceiver() {
    const h = this.heldReceiver;
    const d = h && this.env.dyn.objects.get(h.uid);
    const body = this.env.actors()?.playerBody as unknown as UseBody | undefined;
    if (!h || !d || !body?.boneWorld?.(h.bone, this.boneM)) return;
    d.root.matrix.copy(this.boneM);
    d.root.matrixWorldNeedsUpdate = true;
  }

  /** EndInteract of the hang-up: back on the cradle (its placement, +0x4a). */
  private releaseReceiver() {
    const h = this.heldReceiver;
    if (!h) return;
    this.heldReceiver = undefined;
    const d = this.env.dyn.objects.get(h.uid);
    if (!d) return;
    d.root.matrix.copy(h.home);
    d.root.matrixWorldNeedsUpdate = true;
    d.solid = h.solid;
    this.env.dyn.refreshCollision(d, true);
  }

  // -------------------------------------------------------------------------
  // Security Monitor

  private cameraMatrix(w: WorldEntity): THREE.Matrix4 | undefined {
    const v = w.e.values;
    const camUid = num(v[47]) || num(v[54]);
    if (!camUid) return undefined;
    const M = this.env.props.mechMatrix(camUid);
    if (!M) return undefined;
    const off = new THREE.Matrix4().makeTranslation(num(v[48]), num(v[49]), num(v[50]));
    return M.multiply(off);
  }

  private poseCamera(cam: THREE.PerspectiveCamera, w: WorldEntity) {
    const M = this.cameraMatrix(w);
    if (!M) return false;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(p, q, s);
    cam.position.copy(p);
    // The camera model looks down its local -Z (like every placed object) [guess]; the view is
    // kept level (the sweep turns about the tilted body's own axis, which would roll it).
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    cam.up.set(0, 1, 0);
    cam.lookAt(p.clone().add(fwd));
    // p51 is set as the view's lens (a vertical angle of the 4:3 picture, 0x1001b5cb).
    cam.fov = monitorFov(num(w.e.values[51], 60), cam.aspect);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return true;
  }

  private viewMonitor(w: WorldEntity) {
    if (!this.cameraMatrix(w)) {
      this.env.toast('No signal', 1500);
      return;
    }
    if (!this.use.free) return;
    // The Interact state: p27, the walk-up and the reach clip (Interaction Properties p30),
    // then the view (state 23 when the clip ends, 0x10036e45). The player controller leaves the
    // camera alone while disabled; the view is posed here.
    this.env.world.fire(w, 27);
    const sel = this.interaction(w, w.e.values[30]);
    this.use.start({
      approach: sel?.approach ?? null,
      align: sel?.ip.align ?? 0,
      floor: this.floorAt,
      first: { clip: sel?.ip.clip },
      onDone: (cancelled) => {
        if (cancelled || this.monitorView || w.destroyed) return;
        this.monitorView = { w, t: 0, fov: this.env.camera.fov };
        this.env.player.enabled = false;
        // The feed shows Torque's whole body, not the first-person arms (player.ts setExternalView).
        this.env.player.setExternalView('monitor', true);
        this.env.world.fire(w, 72);
      },
    });
  }

  endMonitor() {
    const m = this.monitorView;
    if (!m) return;
    this.monitorView = undefined;
    this.env.camera.fov = m.fov;
    this.env.camera.updateProjectionMatrix();
    this.env.player.enabled = this.env.walking();
    this.env.player.setExternalView('monitor', false);
    this.overlayOf(m.w)?.show(null);
    this.env.world.fire(m.w, 73);
  }

  get viewingMonitor() {
    return !!this.monitorView;
  }

  private overlayOf(w: WorldEntity): MonitorOverlay | undefined {
    const t = w.e.template;
    const key = t ? keyOf(t) : `uid:${w.uid}`;
    let o = this.overlays.get(key);
    if (!o) this.overlays.set(key, (o = new MonitorOverlay(this.env.pkgs, this.env.dyn, w.e.values)));
    return o;
  }

  /** The camera's object is gone (broken / destroyed): the view shows no signal. */
  private cameraLost(w: WorldEntity) {
    const cam = this.env.world.get(num(w.e.values[47]) || num(w.e.values[54]));
    return !cam || cam.destroyed;
  }

  // -------------------------------------------------------------------------
  // Toilet

  /**
   * Use a toilet: first person flushes at once (0x10036772, no p27); third person fires p27,
   * walks up (Interaction Properties p30) and flushes at the clip's StartInteract (0x1001cf40).
   */
  private useToilet(w: WorldEntity) {
    if (!this.use.free) return;
    if (this.env.player.mode === 'fp') return this.flush(w);
    this.env.world.fire(w, 27);
    const sel = this.interaction(w, w.e.values[30]);
    if (!sel?.ip.clip) return this.flush(w);
    this.use.start({ approach: sel.approach, align: sel.ip.align, floor: this.floorAt, first: { clip: sel.ip.clip, onStart: () => this.flush(w) } });
  }

  private flush(w: WorldEntity) {
    const d = this.env.dyn.objects.get(w.uid);
    const M = d ? d.root.matrix.clone() : undefined;
    if (!M) return;
    const gen = ref(w.e.values[32]);
    if (gen) this.env.fx.spawn(gen, M);
    const swirl = ref(w.e.values[31]);
    const t = swirl ? readTemplate(this.env.pkgs, swirl) : undefined;
    const model = t ? (refList(t.values[3])[0] ?? t.model) : undefined;
    if (model && !w.s.flushing) {
      const o = this.env.dyn.spawnModel(model, M.clone(), { collides: false, name: 'toilet-swirl' });
      w.s.flushing = true;
      setTimeout(() => {
        if (o) this.env.dyn.remove(o.uid);
        w.s.flushing = false;
      }, 3000);
    }
  }

  // -------------------------------------------------------------------------
  // Switch, Quest Item Pickup (targets picked by world.ts)

  /**
   * Use a switch (door, lever, locker...). First person: at once (the original's 0x1003675f
   * first-person branch, logic.ts useSwitch). Third person: the attempt (68, 27, lock, key)
   * at once; then the walk-up to the switch's Switch Interaction Properties (p30 to open, p31 to
   * close an open switch with p34) and its clip p13, the switch moving at StartInteract
   * (0x10130da0; at once without a clip, 0x10132c50). Locked: the rattle clip p14 when the
   * template has one, the locked sound once the player is in place. Returns the HUD status.
   */
  useSwitch(w: WorldEntity): string {
    const world = this.env.world;
    if (this.use.active) return '';
    // First person, or the feet driven by something else (ladder, mounted gun): at once.
    if (this.env.player.mode === 'fp' || !this.use.free || !this.env.walking()) return world.useSwitch(w);
    const u = world.beginUseSwitch(w);
    if (!u) return '';
    const v = w.e.values;
    const sel = this.interaction(w, w.s.open && num(v[34]) ? v[31] : v[30]);
    if (u.locked) {
      const clip = sel?.ip.lockedClip;
      if (!sel || !clip) world.lockedFeedback(w);
      else this.use.start({ approach: sel.approach, align: sel.ip.align, floor: this.floorAt, onArrive: () => void world.lockedFeedback(w), first: { clip } });
      return 'Locked';
    }
    if (!u.status) return '';
    if (!sel) {
      u.operate();
      return u.status;
    }
    const clip = sel.ip.clip;
    this.use.start({
      approach: sel.approach,
      align: sel.ip.align,
      floor: this.floorAt,
      onArrive: clip ? undefined : () => u.operate(),
      first: { clip, onStart: clip ? () => u.operate() : undefined },
    });
    return u.status;
  }

  /**
   * Use a Quest Item Pickup (1a's Shiv in the inmate): p27 at once (the inmate's BlowUp timers
   * keep their 0.98 s), the walk-up to its Interaction Properties (p31) and clip, the item at
   * the clip's EndInteract (0x10125820) - or when the use ends without one (vt+0xdc(0)).
   */
  useSpot(w: WorldEntity) {
    const world = this.env.world;
    if (this.use.active) return;
    if (!this.use.free || !this.env.walking()) return world.pickup(w);
    if (!world.beginSpot(w)) return;
    const sel = this.interaction(w, w.e.values[31]);
    if (!sel?.ip.clip) return world.grantSpot(w);
    this.use.start({
      approach: sel.approach,
      align: sel.ip.align,
      floor: this.floorAt,
      first: { clip: sel.ip.clip, onEnd: () => world.grantSpot(w) },
      onDone: () => world.grantSpot(w),
    });
  }

  /** A use animation is running (the Interact state). */
  get using(): boolean {
    return this.use.active;
  }

  // -------------------------------------------------------------------------
  // Ladder

  private ladderFrame(w: WorldEntity) {
    const d = this.env.dyn.objects.get(w.uid);
    // Placement times the pivot: a ladder an Object Grouper carries (2 Cellblocks 18cb, lowered
    // by Mechanism 18cc) stands where it was moved.
    const M = d ? new THREE.Matrix4().multiplyMatrices(d.root.matrix, d.pivot.matrix) : undefined;
    if (!M) return undefined;
    const e = M.elements;
    const base = new THREE.Vector3(e[12], e[13], e[14]);
    // Ladder face normal: model -Z, horizontal.
    const fwd = new THREE.Vector3(-e[8], 0, -e[10]).normalize();
    return { base, fwd, height: Math.max(1, num(w.e.values[30], 4)) };
  }

  /**
   * Where the player steps off at the top. Ladders lead onto a ledge, usually on the far
   * side of the ladder from the climber but not always, and at varying distances: probe
   * both sides with downward rays and take the first spot with floor near the ladder's
   * top and head room above it. Falls back to 0.6 m past the ladder.
   */
  private ladderLanding(f: { base: THREE.Vector3; fwd: THREE.Vector3; height: number }, side: number) {
    const topY = f.base.y + f.height;
    const world = this.env.collision();
    if (world) {
      for (const dir of [-side, side]) {
        for (const dist of [0.6, 0.9, 1.2, 1.5]) {
          const x = f.base.x + f.fwd.x * dir * dist;
          const z = f.base.z + f.fwd.z * dir * dist;
          const down = world.raycast(x, topY + 1.2, z, 0, -1, 0, 2.4);
          if (!down) continue;
          const floorY = down.point[1];
          if (Math.abs(floorY - topY) > 0.7) continue;
          const up = world.raycast(x, floorY + 0.05, z, 0, 1, 0, 1.7);
          if (up) continue;
          return new THREE.Vector3(x, floorY, z);
        }
      }
    }
    return f.base.clone().addScaledVector(f.fwd, -side * 0.6).setY(topY);
  }

  startLadder(w: WorldEntity) {
    const f = this.ladderFrame(w);
    if (!f || this.climb) return;
    const pl = this.env.player;
    const p = pl.position;
    // The climbing face: the Ladder Interaction Properties' side p3 (the bottom template p32[0]
    // and the top one p32[1] both name it): 3 = the ladder's local -z (fwd), 1 = +z [the side
    // convention of the generic fit test, clamber.ts; strong]. From the top the player stands on
    // the landing behind the ladder, and was put on that side to climb down: 9's lamp room
    // ladder 9da left him over the stairwell. Other sides: the side he stands on (port).
    const side = ladderFaceSide(readTemplate(this.env.pkgs, refList(w.e.values[32])[0])?.values) || Math.sign(p.clone().sub(f.base).setY(0).dot(f.fwd)) || 1;
    const spot = f.base.clone().addScaledVector(f.fwd, side * 0.45);
    const top = this.ladderLanding(f, side);
    const atTop = p.y > f.base.y + f.height * 0.6;
    const y = atTop ? f.height - 1.0 : Math.max(0, Math.min(f.height - 1.2, p.y - f.base.y + 0.05));
    this.climb = { kind: 'ladder', w, base: f.base, up: 1, height: f.height, spot, top, y };
    pl.motionOverride = (dt, input) => this.stepLadder(dt, input);
    this.clips.ladderMount(w.e.values, atTop);
  }

  private stepLadder(dt: number, input: { forward: number; jump: boolean }): boolean {
    const c = this.climb;
    const pl = this.env.player;
    if (!c) return false;
    if (c.exiting) {
      const x = c.exiting;
      x.t = Math.min(1, x.t + dt / 0.45);
      const k = x.t;
      const p = x.from.clone().lerp(x.to, k);
      p.y = Math.max(x.from.y, x.to.y) + Math.sin(k * Math.PI) * 0.1;
      if (k < 0.5) p.y = x.from.y + (x.to.y - x.from.y) * Math.min(1, k * 2);
      pl.setFeet(p.x, p.y, p.z);
      if (x.t >= 1) {
        this.climb = undefined;
        pl.setFeet(x.to.x, x.to.y + 0.02, x.to.z);
        return false;
      }
      return true;
    }
    if (input.jump) {
      this.climb = undefined;
      this.clips.end();
      return false;
    }
    // W climbs up, S down (looking down the ladder reverses nothing: the original maps forward to up).
    c.y += input.forward * 2.0 * dt;
    this.clips.ladderClimb(input.forward, 2.0 * Math.abs(input.forward));
    if (c.y > c.height - 0.9 && input.forward > 0) {
      c.exiting = { from: new THREE.Vector3(c.spot.x, c.base.y + c.y, c.spot.z), to: c.top.clone(), t: 0 };
      this.clips.ladderExit(true);
      return true;
    }
    if (c.y < 0) {
      this.clips.ladderExit(false);
      this.climb = undefined;
      pl.setFeet(c.spot.x, c.base.y + 0.02, c.spot.z);
      return false;
    }
    pl.setFeet(c.spot.x, c.base.y + c.y, c.spot.z);
    return true;
  }

  /** Walking into a ladder while facing it attaches (like the original's auto-mount). */
  private autoLadder() {
    if (this.climb || !this.env.walking()) return;
    const pl = this.env.player;
    const p = pl.position;
    for (const w of this.env.world.of('Ladder')) {
      if (w.destroyed) continue;
      const f = this.ladderFrame(w);
      if (!f) continue;
      const rel = p.clone().sub(f.base);
      // The bottom template's fit window (use-anim.ts ladderFootWindow): 2:427 takes 3a's shack
      // ladder 1593 from the floor 1.2 m below its base.
      const [lo, hi] = ladderFootWindow(refList(w.e.values[32]).map((r) => readTemplate(this.env.pkgs, r)?.values)[0]);
      if (rel.y < lo || rel.y > hi) continue;
      const along = rel.clone().setY(0);
      if (along.length() > 0.75) continue;
      const look = new THREE.Vector3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
      if (look.dot(along.clone().negate().normalize()) < 0.7) continue;
      const v = pl.velocity;
      if (Math.hypot(v.x, v.z) < 0.5) continue;
      this.startLadder(w);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Clamber Point

  /**
   * Try to clamber onto a ledge in front of the player (Space / E). Returns true when it
   * started. The side tests are clamber.ts (clamberSide); no room on top: "Blocked" (0x10011f30).
   */
  tryClamber(): boolean {
    if (this.clamber || this.climb || this.mounted || !this.env.walking()) return false;
    const pl = this.env.player;
    const col = this.env.collision();
    if (!col) return false;
    const p = pl.position.clone();
    const look = { x: -Math.sin(pl.yaw), z: -Math.cos(pl.yaw) };
    let blocked = false;
    for (const w of this.env.world.of('Clamber Point')) {
      if (w.destroyed || !w.enabled) continue;
      // The marker's object matrix: the built object's, else (a Clamber Point without a drawn
      // model: instance flag 0x80 clear, as every 5a / 3b one) its placement, rotation included
      // (0x100114f0 reads the object matrix rows; the unrotated scale turned 5a's rubble steps
      // 203c .. 20a7, placed at 19..110 degrees, onto the wrong sides).
      // A built object's root matrix carries no scale (buildModel scales the vertices): put the
      // instance scale back, as the original's matrix rows times the object scale (+0x54).
      const dynR = this.env.dyn.objects.get(w.uid)?.root.matrix;
      const sc = w.e.scale ?? [1, 1, 1];
      const R = dynR ? dynR.clone().scale(new THREE.Vector3(sc[0], sc[1], sc[2])) : clamberMatrix(w.e.position, w.e.rotation, w.e.scale);
      const centre = new THREE.Vector3().setFromMatrixPosition(R);
      if (Math.hypot(centre.x - p.x, centre.z - p.z) > 12) continue;
      const box = {
        centre,
        ax: new THREE.Vector3().setFromMatrixColumn(R, 0),
        az: new THREE.Vector3().setFromMatrixColumn(R, 2),
        top: centre.y + 0.5 * new THREE.Vector3().setFromMatrixColumn(R, 1).length(),
      };
      // The first template of p30 that fits (vt +0xa0 0x10011910), then the room test on it alone
      // (0x10011b30): no floor is asked for under the anchor, only room for the body on the box top.
      const margin = typeof w.e.values[31] === 'number' ? w.e.values[31] : 0.2;
      const pick = refList(w.e.values[30])
        .map((r) => readTemplate(this.env.pkgs, r)?.values)
        .reduce<ReturnType<typeof clamberSide>>((hit, ip) => hit ?? (ip ? clamberSide(ip, box, p, look, margin) : null), null);
      if (!pick) continue;
      const { edge, normal: n, anchor } = pick;
      if (col.capsuleOverlaps(clamberRoom(anchor, box.top, pl.motor.cfg.height, pl.motor.cfg.radius), 0.01)) {
        blocked = true;
        continue;
      }
      // The clamber animation ends on the ledge (scaled to its height, 0x100119e0): the port
      // lands on the floor under the anchor when there is one near the box top, else on the top.
      const land = new THREE.Vector3(anchor.x, box.top, anchor.z);
      const g = col.raycast(land.x, box.top + 1.0, land.z, 0, -1, 0, 1.6);
      if (g && g.normal[1] >= 0.6) land.y = g.point[1];
      // Up at the edge first, then over it.
      const mid = new THREE.Vector3(edge.x + n.x * 0.35, land.y + 0.1, edge.z + n.z * 0.35);
      this.clamber = { from: p, mid, to: land, t: 0 };
      pl.motionOverride = (dt) => this.stepClamber(dt);
      this.env.world.fire(w, 27);
      return true;
    }
    if (blocked) this.env.toast('Blocked', 1000);
    return false;
  }

  private stepClamber(dt: number): boolean {
    const c = this.clamber;
    if (!c) return false;
    c.t = Math.min(1, c.t + dt / 0.9);
    const pl = this.env.player;
    // Up first (60 %), then over the edge.
    const k = c.t;
    const p = k < 0.6 ? c.from.clone().lerp(c.mid, k / 0.6) : c.mid.clone().lerp(c.to, (k - 0.6) / 0.4);
    pl.setFeet(p.x, p.y, p.z);
    if (c.t >= 1) {
      this.clamber = undefined;
      pl.setFeet(c.to.x, c.to.y + 0.02, c.to.z);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Mountable (mounted gun)

  private mount(w: WorldEntity) {
    const d = this.env.dyn.objects.get(w.uid);
    if (!d) return;
    const e = d.root.matrix.elements;
    const pl = this.env.player;
    const ip = refList(w.e.values[31]).map((r) => readTemplate(this.env.pkgs, r)?.values).find(Boolean) ?? [];
    // The barrel / beam runs along the model's +Z: the gun 7:2918's muzzle hardpoint 3 sits at
    // z +1.55 and the searchlight 7:1244's lamp hardpoint is turned to shine that way
    // (searchlight.ts) [data]. The player stands at the Mountable Interaction Properties'
    // approach offset p15..p17 (2:438 / 2:833: 1.4 / 1.7 m behind) facing p18 (180: along +Z).
    // Mountable p30 names the object it drives (init 0x10017730: a Crane sets the crane flag,
    // 0x80 in +0x46); the camera then rides the Crane's p24 hardpoint, not the Mountable's p45
    // (0x100182f3) [verified]. 4b's crane controls 7bd9 / 7c1d / 7c2f drive 7a26 / 7a2f / 7a37,
    // whose p24 is -1: the view stays at the controls.
    const driven = this.env.world.get(num(w.e.values[30], 0));
    const crane = driven?.cls === 'Crane' ? driven.uid : undefined;
    const back = Math.abs(num(ip[17], -1.7));
    const fwd = new THREE.Vector3(e[8], 0, e[10]).normalize();
    const feet = new THREE.Vector3(e[12], e[13], e[14]).addScaledVector(fwd, -back);
    const g = this.env.collision()?.raycast(feet.x, feet.y + 1, feet.z, 0, -1, 0, 4);
    if (g) feet.y = g.point[1];
    pl.setFeet(feet.x, feet.y, feet.z);
    // Model forward is -Z; three yaw 0 looks down -Z: yaw = atan2(-fx, -fz).
    pl.yaw = Math.atan2(-fwd.x, -fwd.z);
    pl.pitch = 0;
    // Crane controls: the player stands in the cab; the view is turned to the crane it drives (its
    // p24 camera hardpoint is -1 in 4b, so the engine leaves the player's own view) [inferred:
    // the cab's window faces the crane].
    if (driven?.cls === 'Crane') pl.yaw = Math.atan2(-(driven.pos[0] - feet.x), -(driven.pos[2] - feet.z));
    // The view rides the Mountable's hardpoint p45 (the mounted update 0x10019ae0 places the
    // camera there; 7:1244 hardpoint 4: 1.81 m up, 0.82 m behind the lamp, above its housing),
    // so the lamp or gun does not fill the screen [verified slot, inferred camera use].
    const eye = crane === undefined ? hardpointLocal(this.env.pkgs, w.e.modelRef, num(w.e.values[45], -1)) : undefined;
    if (eye) {
      const ey = e[13] + eye.elements[13];
      const ez = eye.elements[14];
      pl.eyeOffset.set(0, ey - (feet.y + pl.eyeHeight), -(ez + back));
    }
    // A searchlight (p49: an Object Generator, searchlight.ts) is steered, not fired [inferred:
    // its template has no muzzle flash or shell templates].
    const light = !!ref(w.e.values[49]);
    // The turn is kept from the placement (Mountable aim 0x100183e0: the yaw it adds to is the
    // Mountable's own, +0xce, limited to +-p38 degrees of the placement) [verified]: a searchlight
    // left turned is mounted again where it was, its limits still those of the placement.
    let place = this.mountPlacement.get(w.uid);
    if (!place) this.mountPlacement.set(w.uid, (place = d.root.matrix.clone()));
    const pf = new THREE.Vector3(place.elements[8], 0, place.elements[10]).normalize();
    const yaw0 = crane === undefined ? Math.atan2(-pf.x, -pf.z) : pl.yaw;
    this.mounted = { w, yaw0, fireAcc: 0, firing: false, base: crane === undefined ? place.clone() : d.root.matrix.clone(), light, crane };
    pl.motionOverride = (dt, input) => this.stepMounted(dt, input);
    this.env.toast(crane !== undefined ? 'Crane: look left / right to swing it, up / down to raise / lower the hook, E to leave' : light ? 'Searchlight: look to aim, E to leave' : 'Mounted gun: left mouse to fire, E to leave', 2500);
  }

  dismount() {
    const m = this.mounted;
    if (!m) return;
    this.mounted = undefined;
    this.env.player.motionOverride = null;
    this.env.player.eyeOffset.set(0, 0, 0);
    const d = this.env.dyn.objects.get(m.w.uid);
    // A searchlight stays turned where it was left, its beam where the player put it [inferred:
    // nothing in the dismount turns it back]; guns keep the port's reset.
    if (d && !m.light) {
      d.root.matrix.copy(m.base);
      d.root.matrixWorldNeedsUpdate = true;
    }
  }

  private stepMounted(dt: number, input: { jump: boolean }): boolean {
    const m = this.mounted;
    if (!m) return false;
    if (input.jump || m.w.destroyed) {
      this.dismount();
      return false;
    }
    const pl = this.env.player;
    const v = m.w.e.values;
    if (m.crane !== undefined) {
      // The crane's controls (aim 0x100183e0, crane branch): the look input turns the crane, not
      // the view. Horizontal look = the slew input, vertical = the hoist input (looking up
      // raises the hook) [inferred: the input source of the aim call was not traced]; inputs as
      // rates, 1 rad/s of look = full input, clamped to -1..1 [inferred].
      const dYaw = pl.yaw - m.yaw0;
      const dPitch = pl.pitch;
      pl.yaw = m.yaw0;
      pl.pitch = 0;
      const k = 1 / Math.max(1e-3, dt);
      const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));
      this.craneControl?.drive(m.w, m.crane, clamp1(-dPitch * k), clamp1(-(dYaw - Math.round(dYaw / (2 * Math.PI)) * 2 * Math.PI) * k), dt);
      return true;
    }
    // Mountable aim (0x100183e0) [verified]: the turn stays within +-p38 degrees of the
    // placement and the pitch within +-p42 degrees (p43 / p40 are the yaw / pitch rates in
    // degrees per second of input, p36 inverts it; the port turns with the view itself).
    const { yaw, pitch } = mountedAimLimits(v, pl.yaw - m.yaw0, pl.pitch);
    pl.yaw = m.yaw0 + yaw;
    pl.pitch = pitch;
    this.onMountedPitch?.(m.w.uid, pl.pitch);
    // Turn the gun with the view (yaw about its origin).
    const d = this.env.dyn.objects.get(m.w.uid);
    if (d) {
      const R = new THREE.Matrix4().makeRotationY(pl.yaw - m.yaw0);
      const p = new THREE.Vector3().setFromMatrixPosition(m.base);
      d.root.matrix.copy(m.base).setPosition(0, 0, 0).premultiply(R).setPosition(p);
      d.root.matrixWorldNeedsUpdate = true;
    }
    if (m.firing && !m.light) {
      m.fireAcc += dt;
      const interval = 60 / Math.max(60, num(v[40], 220));
      while (m.fireAcc >= interval) {
        m.fireAcc -= interval;
        this.fireMounted(m.w);
      }
    } else m.fireAcc = Math.min(m.fireAcc, 0);
    return true;
  }

  private fireMounted(w: WorldEntity) {
    const cam = this.env.camera;
    const o = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    dir.x += (Math.random() - 0.5) * 0.02;
    dir.y += (Math.random() - 0.5) * 0.02;
    dir.normalize();
    const v = w.e.values;
    const dmg = Math.max(1, num(v[45], 5)) * 3;
    const col = this.env.collision();
    const wall = col?.raycast(o.x, o.y, o.z, dir.x, dir.y, dir.z, 120);
    const actors = this.env.actors();
    const ah = actors?.raycast(o, dir, wall?.distance ?? 120);
    if (ah && (!wall || ah.distance < wall.distance)) actors!.damage(ah.actor, dmg, o);
    else if (wall) {
      const p = new THREE.Vector3(...wall.point);
      this.env.damage()?.apply({ point: p, normal: new THREE.Vector3(...wall.normal), amount: dmg, kind: 'bullet', source: o, body: wall.dynamic, dir });
    }
    const d = this.env.dyn.objects.get(w.uid);
    if (d) {
      const M = d.root.matrix.clone();
      const muzzle = ref(v[55]);
      if (muzzle) this.env.fx.spawn(muzzle, M);
      const shells = ref(v[50]);
      if (shells && Math.random() < 0.5) this.env.fx.spawn(shells, M);
    }
  }

  // -------------------------------------------------------------------------

  /** Esc / movement keys end the monitor view; E toggles mounted gun / ladder off. */
  onKey(code: string): boolean {
    if (this.use.active) return this.use.onKey(code);
    if (this.monitorView && (code === 'KeyE' || code === 'Escape' || code === 'KeyW' || code === 'KeyS' || code === 'KeyA' || code === 'KeyD')) {
      this.endMonitor();
      return true;
    }
    if (this.mounted && code === 'KeyE') {
      this.dismount();
      return true;
    }
    if (this.climb && code === 'KeyE') {
      this.climb = undefined;
      this.env.player.motionOverride = null;
      this.clips.end();
      return true;
    }
    const held = this.env.props.grabbed();
    if (code === 'KeyE' && held !== undefined) {
      this.env.props.toggleGrab(held);
      return true;
    }
    if (code === 'Space' && !this.climb && !this.mounted) return this.tryClamber();
    if (code === 'KeyE') return this.tryClamber();
    return false;
  }

  update(dt: number) {
    if (this.monitorView) {
      const m = this.monitorView;
      m.t += dt;
      this.poseCamera(this.env.camera, m.w);
      this.overlayOf(m.w)?.show(this.env.camera, !m.w.s.noSignal && !this.cameraLost(m.w), this.env.camera.fov);
      if (m.t > 20 || m.w.destroyed) this.endMonitor();
    }
    this.clips.update();
    // A cinematic takes the player (or he dies): the use ends where it is (the state is left).
    if (this.use.active && (!this.env.player.enabled || !this.env.walking() || this.env.actors()?.playerBody?.dead)) this.use.cancel();
    this.use.update(dt);
    this.followReceiver();
    this.updateRinging(dt);
    if (this.talking && !this.talking.playing && !this.use.active) this.talking = undefined;
    const grabbed = this.env.props.grabbed();
    const pl = this.env.player;
    this.clips.push(grabbed !== undefined ? this.env.world.get(grabbed)?.e.values : undefined, -(pl.velocity.x * Math.sin(pl.yaw) + pl.velocity.z * Math.cos(pl.yaw)));
    this.autoLadder();
  }

  dispose() {
    this.use.cancel();
    for (const h of this.ringing.values()) h.sound?.stop();
    this.talking?.stop();
    this.endMonitor();
    this.dismount();
    for (const o of this.overlays.values()) o.dispose();
    this.overlays.clear();
    window.removeEventListener('mousedown', this.onMouse);
    window.removeEventListener('mouseup', this.onMouse);
  }
}
