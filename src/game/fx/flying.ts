// Flying Sound (class 0xbd83621b) and Flying Sound Waypoint (0x38641eaf); docs/game-logic.md §17.4.
//
// Verified from Suffering.rfl (init 0x100af460, next point 0x100af210, think 0x100af500):
//   p0 thinking at start (else waits for On), p1 positions are relative to the listener (else to
//   the object), p2 1 = play p3 in list order (else random, no immediate repeat), p3 sounds,
//   p5 combat music: 0 ignore, 1 no new sound while Combat Music plays, 2 also stop the current
//   one, p6 seconds between sounds +- p7 (counted from the start of the last sound; a sound
//   never overlaps itself), p8 path speed, p9..p10 ring radius for random points (model units),
//   inputs p11 On (think on), p12 Off (think off), p13 Destroy.
//   The sound moves along a spline that starts at the origin (the object / the listener):
//     - with a linked Flying Sound Waypoint: through the chain of waypoints (a random onward
//       link at each); when the chain ends the object destroys itself (one-shot fly-by);
//     - without: through random points at p9..p10 units in a random horizontal direction,
//       appended as the path is used up (4 at the start).
//   p4 (float, 1..3) is not read by the code paths above [unknown].
// In 1a: 78a6 (7:3003) circles the listener with ten storm / prison sounds every 38 +- 5 s and is
// switched On / Off by the Ambient Sound zones; 8486 / 84b6 (10:1276) are one-shot fly-bys over
// the waypoints, started by Detectors.

import * as THREE from 'three/webgpu';
import type { AudioSystem, SoundHandle } from '../../app/audio';
import type { PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';
import type { World, WorldEntity } from '../world/logic';
import { refKey } from './surfaces';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);

export interface FlyingEnv {
  world: World;
  audio: AudioSystem;
  listener(): THREE.Vector3;
  /** True while Combat Music is playing (music.ts). */
  combatMusic(): boolean;
  log?(msg: string): void;
}

class Flyer {
  on: boolean;
  dead = false;
  private timer = 0;
  private handle?: SoundHandle;
  private last = -1;
  private seq = 0;
  /** Path points relative to the origin; seg = current segment start index, u in [0, 1). */
  private pts: THREE.Vector3[] = [new THREE.Vector3()];
  private seg = 0;
  private u = 0;
  private wp: WorldEntity | null = null;
  private wpEnd = false;
  readonly pos = new THREE.Vector3();
  readonly keys: string[];
  readonly relative: boolean;
  played = 0;

  constructor(readonly w: WorldEntity, private readonly env: FlyingEnv) {
    const v = w.e.values;
    this.keys = (Array.isArray(v[3]) ? v[3] : []).filter(isRef).map(refKey).filter((k) => env.audio.get(k));
    this.relative = num(v[1]) !== 0;
    this.on = num(v[0]) !== 0;
    this.wp = this.linkedWaypoint(w);
    if (this.wp) for (let i = 0; i < 3 && !this.dead; i++) this.next();
    else for (let i = 0; i < 4; i++) this.next();
  }

  private linkedWaypoint(from: WorldEntity): WorldEntity | null {
    const c = from.e.links.map((u) => this.env.world.get(u)).filter((x): x is WorldEntity => !!x && x.cls === 'Flying Sound Waypoint');
    return c.length ? c[Math.floor(Math.random() * c.length)] : null;
  }

  private get origin(): THREE.Vector3 {
    return this.relative ? this.env.listener() : new THREE.Vector3(...this.w.pos);
  }

  /** Append the next path point (0x100af210). */
  private next() {
    const v = this.w.e.values;
    if (this.wp) {
      const n = this.linkedWaypoint(this.wp);
      if (n) {
        this.wp = n;
        this.pts.push(new THREE.Vector3(...n.pos).sub(new THREE.Vector3(...this.w.pos)));
      } else if (!this.wpEnd) {
        this.wpEnd = true;
        this.pts.push(new THREE.Vector3(...this.wp.pos).sub(new THREE.Vector3(...this.w.pos)));
      }
      return;
    }
    const a = Math.random() * Math.PI * 2;
    const r0 = num(v[9], 3), r1 = num(v[10], r0);
    const r = r0 + Math.random() * (r1 - r0);
    this.pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }

  private sample(out: THREE.Vector3) {
    const P = this.pts, i = this.seg;
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[Math.min(P.length - 1, i + 1)], p3 = P[Math.min(P.length - 1, i + 2)];
    const t = this.u, t2 = t * t, t3 = t2 * t;
    // Catmull-Rom.
    for (const k of ['x', 'y', 'z'] as const) {
      out[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
    }
    return out;
  }

  update(dt: number) {
    if (this.dead) return;
    const v = this.w.e.values;
    // Everything below is the think function: it only runs while On (p0 / p11).
    if (!this.on) return;
    // Path.
    const speed = Math.max(0.1, num(v[8], 3));
    let step = speed * dt;
    while (step > 0 && this.seg + 1 < this.pts.length) {
      const len = Math.max(1e-3, this.pts[this.seg].distanceTo(this.pts[this.seg + 1]));
      const du = step / len;
      if (this.u + du < 1) {
        this.u += du;
        step = 0;
      } else {
        step -= (1 - this.u) * len;
        this.u = 0;
        this.seg++;
      }
      if (this.seg + 2 >= this.pts.length) this.next();
    }
    if (this.wp && this.wpEnd && this.seg + 1 >= this.pts.length) {
      // End of the waypoint chain: the object destroys itself.
      this.dead = true;
      this.env.world.destroy(this.w);
      this.env.log?.(`[fx] flying sound ${this.w.uid.toString(16)} reached the end of its path`);
      return;
    }
    this.sample(this.pos).add(this.origin);
    this.handle?.setPosition([this.pos.x, this.pos.y, this.pos.z]);
    // Combat music.
    const mode = num(v[5]);
    if (mode !== 0 && this.env.combatMusic()) {
      if (mode === 2 && this.handle?.playing) this.handle.stop(0.3);
      return;
    }
    this.timer -= dt;
    if (this.handle?.playing || this.timer > 0 || !this.keys.length) return;
    let i: number;
    if (num(v[2]) !== 0) i = this.seq++ % this.keys.length;
    else {
      i = Math.floor(Math.random() * this.keys.length);
      if (i === this.last && this.keys.length > 1) i = (i + 1) % this.keys.length;
    }
    this.last = i;
    this.handle = this.env.audio.play3D(this.keys[i], [this.pos.x, this.pos.y, this.pos.z], { loop: false });
    this.played++;
    this.env.log?.(`[fx] flying sound ${this.w.uid.toString(16)} plays ${this.keys[i]}`);
    const jit = num(v[7]);
    this.timer = num(v[6], 10) + (Math.random() * 2 - 1) * jit;
  }

  stop() {
    this.handle?.stop(0.3);
  }
}

export class FlyingSounds {
  private list: Flyer[] = [];
  private byUid = new Map<number, Flyer>();

  constructor(private readonly env: FlyingEnv) {
    for (const w of env.world.of('Flying Sound')) {
      const f = new Flyer(w, env);
      this.list.push(f);
      this.byUid.set(w.uid, f);
    }
    env.world.handlers.push((w, msg) => {
      const f = this.byUid.get(w.uid);
      if (!f) return false;
      const v = w.e.values;
      if (num(v[11], 1) === msg) return (f.on = true), true;
      if (num(v[12], 2) === msg) return (f.on = false), true;
      if (num(v[13], 12) === msg) {
        f.dead = true;
        f.stop();
        env.world.destroy(w);
        return true;
      }
      return false;
    });
  }

  get count() {
    return this.list.length;
  }

  state() {
    return this.list.map((f) => ({ uid: f.w.uid.toString(16), on: f.on, dead: f.dead, played: f.played, pos: f.pos.toArray().map((x) => +x.toFixed(1)) }));
  }

  update(dt: number) {
    for (const f of this.list) f.update(dt);
  }

  dispose() {
    for (const f of this.list) f.stop();
  }
}
