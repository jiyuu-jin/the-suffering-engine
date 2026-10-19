// Ambient Sound (class 0xe6ec6c84; docs/game-logic.md §17.4) - crossfade zones for the level's
// ambient beds, reverb environment and "you left this area" messages.
//
// Verified from Suffering.rfl (ctor 0x10092b00, think 0x10092c20, helpers 0x10092320 .. 0x10092a80):
//   - The zone is the template's unit cube x instance scale (contains: 0x10092320).
//   - p0: who is tested - 1 = the player object, else the camera.
//   - Four global ambient channels (shared by all zones). Channel k has sound A = p(1+k) and
//     sound B = p(5+k). Inside the zone the position along the zone's local z gives
//     t = clamp(0.5 - z, 0, 1) (t = 1 at the -z face, 0 at the +z face) and every channel
//     crossfades equal-power between A (gain sin(t·90°)) and B (cos(t·90°)); A == B plays A.
//   - One zone is "current" (global). Entering another zone first runs the old one's exit.
//   - Leaving the current zone: the environment changes to p9 (depth p10 %, fades p11 / p12 s)
//     when leaving on the A side (t >= 0.5), else to p14 (depth p15 %, fades p16 / p17 s); then
//     the exit runs: the channels keep only that side's sounds, p21 (A side) or p22 (B side) is
//     sent to the links, and p13 / p18 set or clear a flag (bit 8 at +0x9c) on the player
//     [meaning unknown, not modelled].
//   - p19 / p20 are message inputs (0 = unused on every chapter-1 instance; not modelled).
// In 1a this is what sends Off to Combat Music 78a4 (zone 802d, p22 = Off) and On / Off to the
// Flying Sound 78a6 (outdoor thunder etc.) as the player moves between indoors and the yard.

import * as THREE from 'three/webgpu';
import type { AudioSystem, SoundHandle } from '../../app/audio';
import type { Entity, PropValue } from '../../formats/entities';
import { entityBoxCorners } from '../../formats/entities';
import { instanceRotation, WORLD_SCALE } from '../../formats/level';
import type { ResRef } from '../../formats/model';
import type { World, WorldEntity } from '../world/logic';
import { EnvironmentReverb, reverbParams } from './reverb';
import { refKey } from './surfaces';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);
const soundKey = (v: PropValue | undefined): string | null => (isRef(v) ? refKey(v) : null);

interface Zone {
  w: WorldEntity;
  o: THREE.Vector3;
  ax: THREE.Vector3[];
  len2: number[];
  center: THREE.Vector3;
  radius2: number;
  usePlayer: boolean;
  a: (string | null)[];
  b: (string | null)[];
  used: boolean[];
}

interface Channel {
  key: string | null;
  h?: SoundHandle;
  key2: string | null;
  h2?: SoundHandle;
}

export interface AmbientEnv {
  world: World;
  audio: AudioSystem;
  reverb: EnvironmentReverb;
  /** Decoded template values (Reverb Effect Template). */
  template(r: ResRef): PropValue[] | undefined;
  /** Listener positions: the player object (feet + 1) and the camera. */
  player(): THREE.Vector3;
  camera(): THREE.Vector3;
  log?(msg: string): void;
}

export class AmbientZones {
  private zones: Zone[] = [];
  private current: Zone | null = null;
  private readonly channels: Channel[] = Array.from({ length: 4 }, () => ({ key: null, key2: null }));
  private readonly tmp = new THREE.Vector3();
  /** Recent events (tests). */
  readonly events: string[] = [];

  constructor(private readonly env: AmbientEnv) {
    for (const w of env.world.of('Ambient Sound')) {
      const z = this.makeZone(w.e, w);
      if (z) this.zones.push(z);
      // The environments a zone switches to are built now, not on the zone change (reverb.ts).
      for (const base of [9, 14]) {
        const tpl = w.e.values[base];
        const t = isRef(tpl) ? env.template(tpl) : undefined;
        if (t) env.reverb.prepare(reverbParams(refKey(tpl as ResRef), t));
      }
    }
  }

  get count() {
    return this.zones.length;
  }

  get currentUid() {
    return this.current?.w.uid;
  }

  private makeZone(e: Entity, w: WorldEntity): Zone | null {
    const c = entityBoxCorners(e, instanceRotation);
    if (!c) return null;
    const P = c.map((p) => new THREE.Vector3(p[0] / WORLD_SCALE, p[1] / WORLD_SCALE, p[2] / WORLD_SCALE));
    const ax = [P[1].clone().sub(P[0]), P[2].clone().sub(P[0]), P[4].clone().sub(P[0])];
    const center = P.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / 8);
    const v = e.values;
    const a: (string | null)[] = [], b: (string | null)[] = [], used: boolean[] = [];
    for (let k = 0; k < 4; k++) {
      // The ctor treats a stored 1 as "none" (sentinel) [verified].
      const sa = num(v[1 + k] as number) === 1 ? null : soundKey(v[1 + k]);
      const sb = num(v[5 + k] as number) === 1 ? null : soundKey(v[5 + k]);
      a.push(sa && this.env.audio.get(sa) ? sa : null);
      b.push(sb && this.env.audio.get(sb) ? sb : null);
      used.push(!!(v[1 + k] || v[5 + k]));
    }
    return { w, o: P[0], ax, len2: ax.map((x) => Math.max(1e-9, x.lengthSq())), center, radius2: P[0].distanceToSquared(center) * 1.0001, usePlayer: num(v[0]) === 1, a, b, used };
  }

  /** Local box coordinates (0..1 per axis) of a point. */
  private local(z: Zone, p: THREE.Vector3): [number, number, number] {
    const d = this.tmp.copy(p).sub(z.o);
    return [d.dot(z.ax[0]) / z.len2[0], d.dot(z.ax[1]) / z.len2[1], d.dot(z.ax[2]) / z.len2[2]];
  }

  private contains(z: Zone, p: THREE.Vector3) {
    if (p.distanceToSquared(z.center) > z.radius2) return false;
    const [u, v, w] = this.local(z, p);
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 && w >= 0 && w <= 1;
  }

  /** t = clamp(0.5 - zLocal) with zLocal in [-0.5, 0.5] -> 1 at the -z face. */
  private frac(z: Zone, p: THREE.Vector3) {
    const w = this.local(z, p)[2];
    return Math.min(1, Math.max(0, 1 - w));
  }

  private listener(z: Zone) {
    return z.usePlayer ? this.env.player() : this.env.camera();
  }

  update() {
    for (const z of this.zones) {
      if (z === this.current || z.w.destroyed) continue;
      if (!this.contains(z, this.listener(z))) continue;
      if (this.current) this.exit(this.current, this.frac(this.current, this.listener(this.current)), false);
      this.current = z;
      this.events.push(`enter ${z.w.uid.toString(16)}`);
      this.env.log?.(`[fx] ambient zone ${z.w.uid.toString(16)} entered`);
      break;
    }
    const z = this.current;
    if (!z) return;
    const p = this.listener(z);
    const t = this.frac(z, p);
    if (this.contains(z, p) && !z.w.destroyed) {
      this.crossfade(z, t);
      return;
    }
    this.exit(z, t, true);
    this.current = null;
  }

  /** Inside: equal-power crossfade A (t = 1) <-> B (t = 0) on the four global channels. */
  private crossfade(z: Zone, t: number) {
    const ga = Math.sin((t * Math.PI) / 2), gb = Math.cos((t * Math.PI) / 2);
    for (let k = 0; k < 4; k++) {
      if (!z.used[k]) continue;
      if (z.a[k] === z.b[k]) this.setChannel(k, z.a[k], 1, null, 0);
      else this.setChannel(k, z.a[k], ga, z.b[k], gb);
    }
  }

  /** Leaving (or replaced by another zone): environment change, final channel sounds, output. */
  private exit(z: Zone, t: number, left: boolean) {
    const sideA = t > 0.5;
    const v = z.w.e.values;
    if (left) {
      // Reverb environment of the side the listener left on (A: p9.., B: p14..).
      const base = sideA ? 9 : 14;
      const tpl = v[base];
      if (isRef(tpl)) {
        const t2 = this.env.template(tpl);
        if (t2) this.env.reverb.set(reverbParams(refKey(tpl), t2), num(v[base + 1], 100) / 100, num(v[base + 2], 0.5), num(v[base + 3], 0.5));
      }
    }
    for (let k = 0; k < 4; k++) if (z.used[k]) this.setChannel(k, sideA ? z.a[k] : z.b[k], 1, null, 0);
    const slot = sideA ? 21 : 22;
    const msg = num(v[slot]);
    this.events.push(`exit ${z.w.uid.toString(16)} side ${sideA ? 'A' : 'B'} p${slot}=${msg}`);
    this.env.log?.(`[fx] ambient zone ${z.w.uid.toString(16)} exit (${sideA ? 'A' : 'B'} side) -> p${slot} message ${msg}`);
    if (msg) this.env.world.fire(z.w.uid, slot);
  }

  private setChannel(k: number, key: string | null, gain: number, key2: string | null, gain2: number) {
    const c = this.channels[k];
    const ensure = (want: string | null, have: string | null, h: SoundHandle | undefined): SoundHandle | undefined => {
      if (want === have && h?.playing) return h;
      h?.stop(1);
      if (!want) return undefined;
      const info = this.env.audio.info(want);
      return this.env.audio.play(want, { loop: true, volume: 0, fadeIn: 0, offset: Math.random() * (info?.duration ?? 0), bus: 'sfx' });
    };
    // Keep handles in place when the pair is just swapped.
    if (c.key === key2 && c.key2 === key && key !== key2) {
      [c.key, c.key2, c.h, c.h2] = [c.key2, c.key, c.h2, c.h];
    }
    c.h = ensure(key, c.key, c.h);
    c.key = key;
    c.h2 = ensure(key2, c.key2, c.h2);
    c.key2 = key2;
    c.h?.setVolume(gain, 0.15);
    c.h2?.setVolume(gain2, 0.15);
  }

  /** Playing ambient channel sounds (tests / overlay). */
  playing() {
    return this.channels.flatMap((c) => [c.h?.playing ? c.key : null, c.h2?.playing ? c.key2 : null]).filter(Boolean) as string[];
  }

  dispose() {
    for (const c of this.channels) {
      c.h?.stop(0.5);
      c.h2?.stop(0.5);
    }
  }
}
