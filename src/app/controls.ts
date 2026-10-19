// Noclip fly camera: click to pointer-lock, WASD + mouse look, Space/C up/down,
// Shift fast, wheel changes speed. Touch: drag to look, two-finger drag to move.

import * as THREE from 'three/webgpu';

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight',
  'ControlLeft',
]);

export class FlyControls {
  /** Base speed in world units per second. */
  speed = 5;
  speedMultiplier = 1;
  sensitivity = 0.0022;
  /** When false (walk mode), mouse look, wheel and movement are ignored. */
  enabled = true;
  yaw = 0;
  pitch = 0;
  onLockChange: (locked: boolean) => void = () => {};
  onSpeedChange: (speed: number) => void = () => {};

  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private touch: { x: number; y: number; n: number } | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {
    camera.rotation.order = 'YXZ';

    dom.addEventListener('click', () => {
      if (!this.locked) void dom.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.keys.clear();
      this.onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.look(e.movementX, e.movementY);
    });
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (MOVE_KEYS.has(e.code)) {
        this.keys.add(e.code);
        if (this.locked || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.enabled) return;
        this.speedMultiplier = THREE.MathUtils.clamp(this.speedMultiplier * (e.deltaY > 0 ? 1 / 1.2 : 1.2), 0.02, 50);
        this.onSpeedChange(this.currentSpeed);
      },
      { passive: false },
    );

    // Minimal touch support.
    dom.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      this.touch = { x: t.clientX, y: t.clientY, n: e.touches.length };
    });
    dom.addEventListener(
      'touchmove',
      (e) => {
        if (!this.touch || !this.enabled) return;
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - this.touch.x, dy = t.clientY - this.touch.y;
        if (e.touches.length >= 2) {
          const fwd = new THREE.Vector3();
          this.camera.getWorldDirection(fwd);
          this.camera.position.addScaledVector(fwd, (-dy / 200) * this.currentSpeed * 0.25);
        } else {
          this.look(dx * 1.5, dy * 1.5);
        }
        this.touch = { x: t.clientX, y: t.clientY, n: e.touches.length };
      },
      { passive: false },
    );
    dom.addEventListener('touchend', () => (this.touch = null));
  }

  get locked() {
    return document.pointerLockElement === this.dom;
  }

  get currentSpeed() {
    return this.speed * this.speedMultiplier;
  }

  private look(dx: number, dy: number) {
    this.yaw -= dx * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sensitivity, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    this.applyRotation();
  }

  private applyRotation() {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  /** yaw: radians about +Y, 0 = looking down -Z. */
  setPose(position: THREE.Vector3, yaw: number, pitch: number) {
    this.camera.position.copy(position);
    this.yaw = yaw;
    this.pitch = pitch;
    this.velocity.set(0, 0, 0);
    this.speedMultiplier = 1;
    this.applyRotation();
  }

  lookFrom(eye: THREE.Vector3, target: THREE.Vector3) {
    const d = target.clone().sub(eye).normalize();
    this.setPose(eye, Math.atan2(-d.x, -d.z), Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)));
  }

  update(dt: number) {
    if (!this.enabled) {
      this.velocity.set(0, 0, 0);
      return;
    }
    const k = this.keys;
    const input = new THREE.Vector3(
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('KeyC') || k.has('KeyQ') || k.has('ControlLeft') ? 1 : 0),
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0),
    );
    let speed = this.currentSpeed;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) speed *= 4;

    const target = new THREE.Vector3();
    if (input.lengthSq() > 0) {
      // Horizontal input follows the full view direction (noclip), vertical is world-up.
      const local = new THREE.Vector3(input.x, 0, input.z).applyQuaternion(this.camera.quaternion);
      target.copy(local).add(new THREE.Vector3(0, input.y, 0)).normalize().multiplyScalar(speed);
    }
    // Critically-damped-ish smoothing for a less twitchy feel.
    const a = 1 - Math.exp(-dt * 12);
    this.velocity.lerp(target, a);
    this.camera.position.addScaledVector(this.velocity, dt);
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
