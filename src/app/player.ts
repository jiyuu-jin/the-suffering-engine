// Walking player: first-/third-person controller on top of the physics
// CharacterMotor (see physics.ts).
//
// Input: WASD/arrows move (walk, hold Shift to run; the Always Run option gives the retail Run/Walk), C or Ctrl
// crouch (hold), Space jump,
// V toggles first/third person, mouse looks while the pointer is locked
// (FlyControls owns the click-to-lock), wheel zooms the third-person camera.
// Gamepad sticks (src/game/hud/bindings.ts) feed setAnalogInput(): analog forward / strafe
// (walk speed scales with the stick, full deflection runs), added to the keys. Look is applied
// to yaw / pitch directly. setVirtualInput() stays the scripted override (it wins over both).
//
// Hooks for a character model (another module builds skinned characters):
//   player.setModel(obj)   - parent obj under player.root (feet origin, facing -Z
//                            in local space, i.e. Three's default forward); hidden in FP.
//   player.onUpdate(fn)    - per-frame PlayerFrame (speed, onGround, crouched...) to
//                            drive animation state.
// `root` is positioned at the feet and rotated by `bodyYaw` every frame.

import * as THREE from 'three/webgpu';
import { CharacterMotor, COLLISION_LAYER, type CollisionWorld, type MotorConfig } from './physics';
import { engineLightMaterial } from './engine-light';
import { FP_AIR_CONTROL, FP_JUMP_SPEED, FallTracker, PLAYER_GRAVITY, PORT_WALK_SPEED, RUN_SPEED, TP_JUMP_SPEED, WALK_SPEED } from './player-rules';

export type ViewMode = 'fp' | 'tp';

export interface PlayerFrame {
  dt: number;
  mode: ViewMode;
  /** Horizontal speed (m/s). */
  speed: number;
  /** Horizontal velocity in the body's local frame: +x right, +z forward. */
  localVelocity: { x: number; z: number };
  verticalSpeed: number;
  onGround: boolean;
  crouched: boolean;
  running: boolean;
  /** True on the frame a jump started / the player landed. */
  jumped: boolean;
  landed: boolean;
  /** On the landing frame: the drop height (highest airborne feet height - landing height). */
  fall?: number;
}

const KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'KeyC', 'ControlLeft', 'ControlRight', 'Space',
]);

export interface PlayerOptions {
  eyeHeight?: number;
  crouchEyeHeight?: number;
  motor?: Partial<MotorConfig>;
}

export class PlayerController {
  readonly motor: CharacterMotor;
  /** Feet position (synced from the motor each update). */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Attach point for a character model: at the feet, rotated by bodyYaw. */
  readonly root = new THREE.Group();

  mode: ViewMode = 'fp';
  /**
   * First person suspended by a player state while it runs (Hit Reacting 17 ends First Person
   * and gives it back when it is over: game/actors/player-states.ts). What remembers a view to
   * give back later (the creature form, death, a save) takes `chosenMode()`, not this third person.
   */
  stateTp = false;
  /** When false the controller ignores input and doesn't touch the camera. */
  enabled = false;
  /** Camera yaw/pitch (radians). yaw 0 looks down -Z (same convention as FlyControls). */
  yaw = 0;
  pitch = 0;
  /** Facing of the body/model (follows the camera yaw while moving). */
  bodyYaw = 0;
  sensitivity = 0.0022;
  /** Gameplay options (set by the menu settings): mouse pitch multiplier and inverted pitch. */
  pitchScale = 1;
  /** Gameplay "Turn sensitivity" (0.25..4): scales the gamepad / turn-key turn rate (bindings.ts). */
  turnScale = 1;
  /**
   * Gameplay option "Always Run": run by default and walk with Shift at the original's walk
   * speed (the retail behaviour). Off (default): a brisk port walk, Shift runs.
   */
  private _alwaysRun = false;
  get alwaysRun(): boolean {
    return this._alwaysRun;
  }
  set alwaysRun(v: boolean) {
    this._alwaysRun = v;
    if (this.motor) this.motor.cfg.walkSpeed = v ? WALK_SPEED : PORT_WALK_SPEED;
  }
  invertY = false;
  /**
   * Running allowed. Off in water deeper than Player p25 (1.5 m; RFL 0x10046230, set each frame
   * by src/game/levels/water.ts): he walks.
   */
  canRun = true;
  eyeHeight: number;
  crouchEyeHeight: number;
  /** Third-person camera distance and shoulder offset. */
  tpDistance = 3.2;
  tpShoulder = 0.45;
  tpCameraRadius = 0.2;
  /** Called when the player falls out of the world; default respawns. */
  onFellOut: () => void = () => this.respawn();
  onModeChange: (mode: ViewMode) => void = () => {};

  private keys = new Set<string>();
  private jumpQueued = false;
  private listeners: ((f: PlayerFrame) => void)[] = [];
  private model: THREE.Object3D | null = null;
  private placeholder: THREE.Mesh;
  private eyeSmooth: number;
  /** Visual-only vertical offset that hides step-up/snap pops. */
  private stepSmooth = 0;
  private tpCurrent = 3.2;
  private spawnPoint = { x: 0, y: 0, z: 0, yaw: 0 };
  private world: CollisionWorld | null = null;
  private wasGrounded = false;
  private readonly fallTracker = new FallTracker();
  /** Airborne after a first-person jump (air control at FP_AIR_CONTROL). */
  private fpJump = false;
  private virtual: { forward: number; strafe: number; run?: boolean; crouch?: boolean } | null = null;
  private analog: { forward: number; strafe: number; run?: boolean } | null = null;
  /**
   * Scripted locomotion (ladders, clambering, mounted guns: src/game/world/interact.ts). While
   * set it replaces the motor step: it gets the movement input, places the feet with setFeet()
   * and returns false to hand control back. The camera still follows yaw / pitch.
   */
  motionOverride: ((dt: number, input: { forward: number; strafe: number; jump: boolean; crouch: boolean }) => boolean) | null = null;
  /**
   * While a creature holds the player (src/game/actors/specials/hold.ts): the attack button is a
   * struggle press, not a swing or a shot (the original counts attack presses against the
   * Mainliner's ride clock and the Nooseman's grip). Returns true when it took the press.
   */
  attackOverride: (() => boolean) | null = null;
  /**
   * While a motionOverride runs: the body's facing (radians) independent of the view yaw (use
   * animations, src/game/world/use-anim.ts: the body holds the approach facing while the
   * third-person camera may orbit). null: the body faces the view.
   */
  bodyYawLock: number | null = null;
  /**
   * Third-person camera turned about the player by this angle (radians) on top of the view yaw;
   * the body and the controls keep the view yaw (the insanity morph's camera orbit: Player
   * +0x4aa read by the camera at 0x1000419a, src/game/insanity/creature.ts).
   */
  viewOrbit = 0;
  /**
   * Root motion for the next update (world metres): the feet move by it through the motor, with
   * that step's own move, so walls stop it and the ground probe follows (the original adds a
   * clip's extracted root to the same pending move as the gait: weapons/melee-lunge.ts). Spent
   * (zeroed) by every update.
   */
  readonly rootMove = { x: 0, y: 0, z: 0 };
  /**
   * While true a clip's root carries the feet vertically too (`rootMove.y`, no gravity): the
   * third-person jump (actors/player-states.ts).
   */
  rootFly = false;
  /**
   * Player states that end Move and keep it from starting besides the strike (`holdMove`): Hit
   * Reacting, Jump and Landing (actors/player-states.ts). The stick is still read (`moveInput`).
   */
  stateHold = false;
  /** This frame's movement input before any hold (forward / strafe in [-1, 1]). */
  readonly moveInput = { forward: 0, strafe: 0 };
  /**
   * While set the view is held there: mouse, pad and turn keys do not look (Hit Reacting refuses
   * the Turn and Pitch states; actors/player-states.ts turns it toward the attacker).
   */
  viewLock: { yaw: number; pitch: number } | null = null;
  /** No shooting, striking, throwing, reloading or weapon change (Hit Reacting refuses them). */
  actionsLocked = false;
  /** While set the body keeps this facing (radians) whatever the view does (player-states.ts). */
  bodyYawHold: number | null = null;
  /**
   * The third-person jump (actors/player-states.ts): called on the jump press with this frame's
   * movement input; true when it took the press (the motor does not jump then).
   */
  jumpOverride: ((input: { forward: number; strafe: number }) => boolean) | null = null;
  /**
   * While true the movement input is ignored and the feet move only by `rootMove` and the fall
   * (Player states that end Move and keep it from starting: the third-person strike, state 4).
   */
  holdMove = false;
  /**
   * Extra eye offset in the body's frame (x right, y up, z back), added by eyePosition(): use
   * animations move the first-person eye to the original's rigid eye (Player p106..p108).
   */
  readonly eyeOffset = new THREE.Vector3();
  /**
   * Third-person gait (PlayerBody, src/game/actors/gait.ts): given the stick angle (degrees
   * clockwise from the view's forward), the run input and the configured walk speed, the ground
   * speed of the heading set it falls in and the body's facing offset from the view yaw (radians;
   * the body turns into diagonal movement so it runs along a clip's direction) with the rate to
   * turn at (rad/s). null: the plain walk / run speeds, the body faces the view.
   */
  gait: ((angleDeg: number, run: boolean, walkSpeed: number) => { speed: number; offset: number; turnRate: number } | null) | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    opts: PlayerOptions = {},
  ) {
    // Retail player motion (docs/re/player.md): fall gravity p214, the PWP walk / run speeds;
    // the jump speed is set per view mode in update().
    // layers: the player's filter of Invisible Static Objects (player clips, physics.ts COLLISION_LAYER).
    this.motor = new CharacterMotor(null, { gravity: PLAYER_GRAVITY, walkSpeed: PORT_WALK_SPEED, runSpeed: RUN_SPEED, jumpSpeed: TP_JUMP_SPEED, layers: COLLISION_LAYER.player, ...opts.motor });
    this.eyeHeight = opts.eyeHeight ?? 1.6;
    this.crouchEyeHeight = opts.crouchEyeHeight ?? 0.95;
    this.eyeSmooth = this.eyeHeight;

    // Placeholder body for third person until a real model is attached.
    const { radius, height } = this.motor.cfg;
    const geo = new THREE.CapsuleGeometry(radius, height - 2 * radius, 4, 12);
    geo.translate(0, height / 2, 0);
    const mat = engineLightMaterial(new THREE.MeshStandardNodeMaterial({ color: 0x8a7a66, roughness: 0.8 }), { precomputed: false });
    this.placeholder = new THREE.Mesh(geo, mat);
    this.placeholder.name = 'player-placeholder';
    // Nose marker so facing is visible.
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.25), mat);
    nose.position.set(0, this.eyeHeight, -radius);
    this.placeholder.add(nose);
    this.root.add(this.placeholder);
    this.root.name = 'player';
    this.root.visible = false;

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return;
      this.yaw -= e.movementX * this.sensitivity;
      const dy = e.movementY * this.sensitivity * this.pitchScale * (this.invertY ? -1 : 1);
      this.pitch = this.clampPitch(this.pitch - dy);
    });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      if (KEYS.has(e.code)) {
        if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
        this.keys.add(e.code);
        e.preventDefault();
      } else if (e.code === 'KeyV' && !e.repeat) {
        this.setMode(this.mode === 'fp' ? 'tp' : 'fp');
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.analog = null;
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.dom) this.keys.clear();
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled || this.mode !== 'tp') return;
        this.tpDistance = THREE.MathUtils.clamp(this.tpDistance * (e.deltaY > 0 ? 1.12 : 1 / 1.12), 1.2, 10);
      },
      { passive: true },
    );
  }

  // -------------------------------------------------------------------------
  // Public API

  get onGround() {
    return this.motor.onGround;
  }

  get crouched() {
    return this.motor.crouched;
  }

  setWorld(world: CollisionWorld | null) {
    this.world = world;
    this.motor.setWorld(world);
  }

  /** Set the respawn point (feet position) and teleport there. */
  spawn(feet: THREE.Vector3Like, yaw: number) {
    this.spawnPoint = { x: feet.x, y: feet.y, z: feet.z, yaw };
    this.respawn();
  }

  respawn() {
    const s = this.spawnPoint;
    this.teleport(s, s.yaw);
  }

  /** Place the feet at a point (dropped onto the ground below if close). */
  teleport(feet: THREE.Vector3Like, yaw = this.yaw, pitch = 0) {
    this.motor.teleport(feet.x, feet.y, feet.z);
    this.fallTracker.reset();
    this.fpJump = false;
    this.rootMove.x = this.rootMove.y = this.rootMove.z = 0;
    // A placed view (checkpoint, cinematic hand-back) is not held back by a state's view lock.
    this.viewLock = null;
    this.yaw = this.bodyYaw = yaw;
    this.pitch = pitch;
    this.stepSmooth = 0;
    this.tpCurrent = this.tpDistance;
    this.eyeSmooth = this.eyeHeight;
    this.sync();
  }

  /**
   * Look limits from the Player template: p200/p201 = 75° up / 65° down in first person,
   * 50° / 50° in third person (docs/game-logic.md §4.5). Positive pitch looks up.
   */
  clampPitch(pitch: number): number {
    const D = Math.PI / 180;
    return this.mode === 'fp'
      ? THREE.MathUtils.clamp(pitch, -65 * D, 75 * D)
      : THREE.MathUtils.clamp(pitch, -50 * D, 50 * D);
  }

  /** The view the player is in apart from a player state's third person (`stateTp`). */
  chosenMode(): ViewMode {
    return this.stateTp ? 'fp' : this.mode;
  }

  setMode(mode: ViewMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.pitch = this.clampPitch(this.pitch);
    this.tpCurrent = 0.5;
    this.onModeChange(mode);
  }

  /**
   * Another camera shows the player (a security monitor's feed, a cinematic): reason -> on.
   * The original leaves first person for those (Player states View Monitor 23, Controlled 11,
   * Interact 22, Play Anim 33, Document View 31 and Morph 19 all end First Person 16 in the
   * state table 0x10175150; its leave handler 0x100433b0 puts the full body model back), so
   * the whole body is drawn and the first-person arms are not (player-body.ts). The view
   * returns to first person afterwards (+0x98 bit 0x8000 stays set; 0x100499c8 re-enters it).
   */
  setExternalView(reason: string, on: boolean) {
    if (on === this.externalViews.has(reason)) return;
    if (on) this.externalViews.add(reason);
    else this.externalViews.delete(reason);
    if (on) (this.model ?? this.placeholder).visible = true;
    this.root.visible = this.bodyShown;
  }
  private readonly externalViews = new Set<string>();

  /** True while some other camera than the player's own view shows him (setExternalView). */
  get externalView(): boolean {
    return this.externalViews.size > 0;
  }

  /** The body is drawn: third person while playing, or seen through another camera. */
  get bodyShown(): boolean {
    return this.externalView || (this.enabled && this.mode === 'tp');
  }

  /** Attach a character model (replaces the placeholder). Pass null to restore it. */
  setModel(obj: THREE.Object3D | null) {
    if (this.model) this.root.remove(this.model);
    this.model = obj;
    this.placeholder.visible = !obj;
    if (obj) this.root.add(obj);
  }

  onUpdate(fn: (f: PlayerFrame) => void) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }

  /**
   * Scripted/virtual input (tests, touch, gamepad): overrides the keyboard
   * while set. forward/strafe in [-1, 1]. Pass null to clear.
   */
  setVirtualInput(v: { forward: number; strafe: number; run?: boolean; crouch?: boolean } | null) {
    this.virtual = v;
  }

  /**
   * Analog movement (gamepad left stick), combined with the keyboard: forward / strafe in
   * [-1, 1] (magnitude below 1 walks slower), `run` at full deflection. Null clears it.
   */
  setAnalogInput(v: { forward: number; strafe: number; run?: boolean } | null) {
    this.analog = v;
  }

  jump() {
    this.jumpQueued = true;
  }

  /** Put the feet somewhere without the teleport's ground snap (scripted moves). */
  setFeet(x: number, y: number, z: number) {
    const m = this.motor;
    m.position.x = x;
    m.position.y = y;
    m.position.z = z;
    m.velocity.x = m.velocity.y = m.velocity.z = 0;
    this.sync();
  }

  /** Eye position in world space (feet + eye height, smoothed). */
  eyePosition(out = new THREE.Vector3()) {
    out.set(this.position.x, this.position.y + this.eyeSmooth + this.stepSmooth, this.position.z);
    const o = this.eyeOffset;
    if (o.x || o.y || o.z) {
      const s = Math.sin(this.bodyYaw), c = Math.cos(this.bodyYaw);
      out.x += o.x * c + o.z * s;
      out.y += o.y;
      out.z += -o.x * s + o.z * c;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Per frame

  update(dt: number) {
    if (!this.enabled) return;
    const k = this.keys;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    // Default: walk, hold Shift to run. With `alwaysRun` (Gameplay option "Always Run") the
    // original retail behaviour applies instead: running is the default and the Run/Walk key
    // walks (Move per-frame uses 1 - Run/Walk as the stick magnitude: docs/re/player.md §6).
    const keyMove = fwd !== 0 || strafe !== 0;
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    let run = this.alwaysRun ? !shift : shift;
    let crouch = k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight');
    const a = this.analog;
    if (a) {
      fwd = Math.max(-1, Math.min(1, fwd + a.forward));
      strafe = Math.max(-1, Math.min(1, strafe + a.strafe));
      if (!keyMove) run = !!a.run;
    }
    if (this.virtual) {
      fwd = this.virtual.forward;
      strafe = this.virtual.strafe;
      run = !!this.virtual.run;
      crouch = !!this.virtual.crouch;
    }
    if (!this.canRun) run = false;
    this.moveInput.forward = fwd;
    this.moveInput.strafe = strafe;
    if (this.viewLock) (this.yaw = this.viewLock.yaw), (this.pitch = this.viewLock.pitch);
    if (this.jumpQueued && !this.motionOverride && this.jumpOverride?.({ forward: fwd, strafe })) this.jumpQueued = false;
    if (this.holdMove || this.stateHold) fwd = strafe = 0;
    const rmx = this.rootMove.x, rmy = this.rootMove.y, rmz = this.rootMove.z;
    this.rootMove.x = this.rootMove.y = this.rootMove.z = 0;
    if (this.motionOverride) {
      const keep = this.motionOverride(dt, { forward: fwd, strafe, jump: this.jumpQueued, crouch });
      this.jumpQueued = false;
      this.fallTracker.reset();
      if (!keep) this.motionOverride = null;
      this.motor.onGround = !keep;
      this.bodyYaw = this.bodyYawLock ?? this.yaw;
      this.sync();
      this.updateCamera(dt);
      return;
    }
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    let wx = -s * fwd + c * strafe;
    let wz = -c * fwd - s * strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) (wx /= wl), (wz /= wl);

    // First person jumps straight up at p215 with stick air control (p216); the third-person
    // jump is a clip in the original (TP_JUMP_SPEED keeps the port's apex).
    const cfg = this.motor.cfg;
    cfg.jumpSpeed = this.mode === 'fp' ? FP_JUMP_SPEED : TP_JUMP_SPEED;
    const baseAir = cfg.airAccel, baseWalk = cfg.walkSpeed, baseRun = cfg.runSpeed;
    // Third person: the heading set's own speed (strafes run at 5.1, the backpedal is 4.1).
    const moving = fwd !== 0 || strafe !== 0;
    const gait = this.mode === 'tp' && moving && this.gait && !this.motor.crouched ? this.gait((Math.atan2(strafe, fwd) * 180) / Math.PI, run, baseWalk) : null;
    if (gait) cfg.walkSpeed = cfg.runSpeed = gait.speed;
    if (this.fpJump && !this.motor.onGround) {
      cfg.airAccel = Math.max(baseAir, 12);
      cfg.walkSpeed = cfg.runSpeed = Math.max(baseRun, FP_AIR_CONTROL);
    }

    // Large dt (tab switch) -> substep to keep the physics stable.
    const steps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 50))));
    const h = dt / steps;
    let jumped = false;
    for (let i = 0; i < steps; i++) {
      const vy0 = this.motor.velocity.y;
      this.motor.step(h, { wishX: wx, wishZ: wz, run, crouch, jump: this.jumpQueued, moveX: rmx / steps, moveZ: rmz / steps, moveY: rmy / steps, fly: this.rootFly });
      if (this.jumpQueued && this.motor.velocity.y > vy0 + 1) (jumped = true), (this.fpJump = this.mode === 'fp');
      this.jumpQueued = false;
      // Hide step pops: offset the camera by the snap and decay it.
      this.stepSmooth -= this.motor.stepOffset;
    }
    cfg.airAccel = baseAir;
    cfg.walkSpeed = baseWalk;
    cfg.runSpeed = baseRun;
    if (this.motor.onGround) this.fpJump = false;
    this.stepSmooth = THREE.MathUtils.clamp(this.stepSmooth, -0.6, 0.6) * Math.exp(-dt * 14);

    const targetEye = this.motor.crouched ? this.crouchEyeHeight : this.eyeHeight;
    this.eyeSmooth += (targetEye - this.eyeSmooth) * (1 - Math.exp(-dt * 12));

    // Body faces the camera yaw while moving (strafe-style, like the game's aiming). In third
    // person with a gait it turns into diagonal movement by the heading set's offset (gait.ts)
    // and otherwise turns with the view; coasting to a stop it keeps its offset.
    const v = this.motor.velocity;
    const hs = Math.hypot(v.x, v.z);
    if (this.mode === 'fp' || (hs > 0.2 && !gait && moving)) {
      const d = wrapAngle(this.yaw - this.bodyYaw);
      this.bodyYaw = wrapAngle(this.bodyYaw + d * (1 - Math.exp(-dt * 10)));
    } else if (gait || hs > 0.2) {
      let o = wrapAngle(this.bodyYaw - this.yaw);
      if (gait) {
        const d = wrapAngle(gait.offset - o);
        // The set's turn rate; faster for a large gap (the camera orbited while standing).
        const step = Math.max(gait.turnRate * dt, Math.abs(d) * (1 - Math.exp(-dt * 10)));
        o += Math.sign(d) * Math.min(Math.abs(d), step);
      }
      this.bodyYaw = wrapAngle(this.yaw + o);
    }
    if (this.bodyYawHold !== null) this.bodyYaw = this.bodyYawHold;

    this.sync();

    if (this.world && this.position.y < this.world.bounds.min[1] - 30) this.onFellOut();

    this.updateCamera(dt);

    const landed = this.motor.onGround && !this.wasGrounded;
    const drop = this.fallTracker.step(this.position.y, this.motor.onGround, dt);
    this.wasGrounded = this.motor.onGround;
    if (this.listeners.length) {
      const bs = Math.sin(this.bodyYaw), bc = Math.cos(this.bodyYaw);
      const frame: PlayerFrame = {
        dt,
        mode: this.mode,
        speed: hs,
        localVelocity: { x: v.x * bc - v.z * bs, z: -v.x * bs - v.z * bc },
        verticalSpeed: v.y,
        onGround: this.motor.onGround,
        crouched: this.motor.crouched,
        running: run && hs > this.motor.cfg.walkSpeed + 0.2,
        jumped,
        landed,
        fall: drop !== null && drop > 0 ? drop : undefined,
      };
      for (const fn of this.listeners) fn(frame);
    }
  }

  private sync() {
    const p = this.motor.position, v = this.motor.velocity;
    this.position.set(p.x, p.y, p.z);
    this.velocity.set(v.x, v.y, v.z);
    this.root.position.copy(this.position);
    this.root.position.y += this.stepSmooth;
    this.root.rotation.set(0, this.bodyYaw, 0);
    this.root.visible = this.bodyShown;
  }

  private readonly tmpEye = new THREE.Vector3();

  private updateCamera(dt: number) {
    const cam = this.camera;
    cam.rotation.order = 'YXZ';
    const yaw = this.mode === 'fp' ? this.yaw : this.yaw + this.viewOrbit;
    cam.rotation.set(this.pitch, yaw, 0);
    const eye = this.eyePosition(this.tmpEye);
    if (this.mode === 'fp') {
      cam.position.copy(eye);
      return;
    }
    // Third person: orbit behind an over-the-shoulder pivot, pulled in when blocked.
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fx = -s * cp, fy = sp, fz = -c * cp; // camera forward
    const rx = c, rz = -s; // camera right (horizontal)
    // Pivot: from the head, move out to the shoulder (blocked by walls too).
    const head = { x: eye.x, y: eye.y - 0.1, z: eye.z };
    let sh = this.tpShoulder;
    if (this.world) {
      const hit = this.world.sphereCast(head.x, head.y, head.z, this.tpCameraRadius, rx, 0, rz, sh);
      if (hit) sh = Math.max(0, hit.distance - 0.02);
    }
    const px = head.x + rx * sh, py = head.y, pz = head.z + rz * sh;
    let want = this.tpDistance;
    if (this.world) {
      const hit = this.world.sphereCast(px, py, pz, this.tpCameraRadius, -fx, -fy, -fz, want);
      if (hit) want = Math.max(0.25, hit.distance - 0.05);
    }
    // Pull in instantly, ease back out.
    if (want < this.tpCurrent) this.tpCurrent = want;
    else this.tpCurrent += (want - this.tpCurrent) * (1 - Math.exp(-dt * 4));
    cam.position.set(px - fx * this.tpCurrent, py - fy * this.tpCurrent, pz - fz * this.tpCurrent);
    // Too close to see past the body: hide it (like most TPS games).
    const body = this.model ?? this.placeholder;
    body.visible = this.tpCurrent > 0.6;
    if (!this.model) this.placeholder.visible = body.visible;
  }
}

function wrapAngle(a: number) {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
