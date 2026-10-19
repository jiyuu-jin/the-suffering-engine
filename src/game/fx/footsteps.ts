// Footsteps and landings per surface (docs/game-logic.md §17.6, docs/re/audio.md §13).
//
// Verified from Suffering.rfl: animation markers (.adu type 5, kind 1) with the messages
// 200 FootStep_Light, 201 FootStep_Heavy, 202 FootStep_Scuff, 203 FootStep_Sneak,
// 204 FootStep_Land, 205 FootStep_BodyFall are handled by the Player (0x10042cd0) and the NPC
// classes (0x100e4ca0) while the marker's clip is channel 0's current clip: kind = message - 200,
// then (0x100b0ba0 / 0x100b0c10)
//   - the Material Effects entry for the surface under the character is picked from the
//     Player's p145 / the NPC's p49 list (Player / NPC Material Effects: p0 Material Type;
//     the untyped entry is the default) [0x100b05b0];
//   - one sound of list p(1 + kind) is played at the character (no immediate repeat) at the
//     sound's header volume, no pitch change (header pitch variation is dead on PC) and no rate
//     limit [0x100b04a0];
//   - except for Sneak, the entry's p7 InvestigateSound makes an AI noise at the character
//     (0x100e2e60; FootstepEnv.noise -> services.actors.noise, docs/game-logic.md §15.8);
//   - the effect template p(8 + kind) is spawned at the feet (dust, splashes; mostly empty).
// First person (Move per-frame 0x10046312): while moving, a timer counts down by the stick
// magnitude x dt and at 0 posts FootStep_Light to the player and restarts at Player p156
// (0.4 s): a light step every 0.4 s at full stick, walking or running. Nothing else plays
// footsteps: no distance-based stepping; NPC clips without markers are silent.
//
// Port: markers are read from the clip the character is playing (Character.current) - the
// player body (services.actors.playerBody) and every actor. A third-person gait cycle
// (actors/gait.ts) fires the markers of the retail clip it stands for, re-timed onto the cycle
// (clipEventSource). A landing after a fall plays FootStep_Land when the landing clip did not
// [port addition].

import * as THREE from 'three/webgpu';
import type { AudioSystem } from '../../app/audio';
import type { Character } from '../../app/character';
import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { findEntry, type ResRef } from '../../formats/model';
import { ADU_EVENTS } from '../../formats/animation';
import type { Surfaces } from './surfaces';
import { clipEventSource, cycleEventTime } from '../actors/gait';
import { refKey, refsOf, waterSurfaces } from './surfaces';

export const FOOTSTEP = { light: 0, heavy: 1, scuff: 2, sneak: 3, land: 4, bodyFall: 5 } as const;
export const FOOTSTEP_NAMES = ['Light', 'Heavy', 'Scuff', 'Sneak', 'Land', 'BodyFall'];

export interface Marker {
  time: number;
  kind: number;
}

interface Tracker {
  clip?: THREE.AnimationClip;
  t: number;
  markers: Marker[];
  lastStep: number;
  lastKey?: string;
  /** First-person step timer (s at full stick; fpStepTimer). */
  fpTimer?: number;
}

/** Player p156: seconds between first-person steps at full stick (retail 0.4). */
export const FP_STEP_INTERVAL = 0.4;

/**
 * First-person step timer (RFL 0x10046312): the timer drops by |stick| x dt; when it reaches 0
 * a FootStep_Light is posted and it restarts at `interval` (Player p156).
 */
export function fpStepTimer(timer: number, stick: number, dt: number, interval: number): { timer: number; step: boolean } {
  const t = timer - Math.abs(stick) * dt;
  return t <= 0 ? { timer: interval, step: true } : { timer: t, step: false };
}

/** Markers of a source clip placed on a re-timed cycle (gait.ts cycleEventTime), sorted. */
export function retimeMarkers(markers: readonly Marker[], sourceDuration: number, phase: number, cycleDuration: number): Marker[] {
  return markers.map((m) => ({ time: cycleEventTime(m.time, sourceDuration, phase, cycleDuration), kind: m.kind })).sort((a, b) => a.time - b.time);
}

export interface FootstepEnv {
  pkgs: EntityPackageSet;
  audio: AudioSystem;
  surfaces: Surfaces;
  spawn(ref: ResRef, at: THREE.Vector3): void;
  /** AI noise of a step: the entry's p7 InvestigateSound at the feet (`who` as in step()). */
  noise?(sound: ResRef, at: THREE.Vector3, who: string): void;
  log?(msg: string): void;
}

export class Footsteps {
  private trackers = new WeakMap<object, Tracker>();
  private markerCache = new Map<string, Marker[]>();
  private clipIndex?: Map<string, number>;
  private clock = 0;
  /** Recent steps (tests / overlay). */
  readonly recent: { t: number; who: string; kind: string; surface: string | null; sound: string | null }[] = [];

  constructor(private readonly env: FootstepEnv) {}

  /** Footstep markers of a clip (by id + animation set; package found through its header entry). */
  private markersOf(id: number, animSet: number): Marker[] {
    const k = `${animSet}:${id}`;
    let m = this.markerCache.get(k);
    if (m) return m;
    m = [];
    if (!this.clipIndex) {
      this.clipIndex = new Map();
      for (const [pkg, p] of this.env.pkgs as Map<number, { adu?: { entries: { type: number; id: number; extra: number }[] } }>) {
        for (const e of p.adu?.entries ?? []) if (e.type === 2) this.clipIndex.set(`${e.extra}:${e.id}`, pkg);
      }
    }
    const pkg = this.clipIndex.get(k);
    const adu = pkg !== undefined ? (this.env.pkgs.get(pkg) as { adu?: Parameters<typeof findEntry>[0] }).adu : undefined;
    const e = adu && findEntry(adu, ADU_EVENTS, id);
    if (adu && e && e.size >= 4) {
      const v = adu.data(e);
      const n = v.getUint32(0, true);
      for (let i = 0; i < n && n <= 256 && 4 + 16 * i + 16 <= v.byteLength; i++) {
        const o = 4 + 16 * i;
        const kind = v.getUint32(o, true), param = v.getUint32(o + 12, true);
        if (kind === 1 && param >= 200 && param <= 205) m.push({ time: v.getFloat32(o + 4, true), kind: param - 200 });
      }
      m.sort((a, b) => a.time - b.time);
    }
    this.markerCache.set(k, m);
    return m;
  }

  /**
   * Per frame for one character: fire the footstep markers its current clip crossed.
   * `effects`: its Player / NPC Material Effects list. Returns the number of steps played.
   */
  track(key: object, who: string, ch: Character | undefined, feet: THREE.Vector3, effects: PropValue | undefined) {
    const tr = this.tracker(key);
    let steps = 0;
    const action = ch?.current;
    const clip = action?.getClip();
    if (ch && action && clip) {
      if (clip !== tr.clip) {
        const src = clipEventSource(clip);
        if (src) tr.markers = retimeMarkers(this.markersOf(src.id, src.animSet), src.duration, src.phase, clip.duration);
        else {
          const i = ch.clips.indexOf(clip);
          const d = i >= 0 ? ch.clipData[i] : undefined;
          tr.markers = d ? this.markersOf(d.id, d.animSet) : [];
        }
        tr.clip = clip;
        tr.t = action.time;
      } else if (action.isRunning() || action.enabled) {
        const t = action.time, prev = tr.t;
        const dur = clip.duration;
        const fire = (a: number, b: number) => {
          for (const m of tr.markers) if (m.time > a && m.time <= b) (this.step(who, m.kind, feet, effects, tr), steps++);
        };
        if (t >= prev) fire(prev, t);
        else if (action.loop !== THREE.LoopOnce) (fire(prev, dur + 1e-6), fire(-1, t));
        tr.t = t;
      }
    }
    return steps;
  }

  /**
   * First-person stepping (fpStepTimer): call every frame the player moves on the ground in
   * first person with the stick magnitude 0..1; returns whether a step played.
   */
  firstPerson(key: object, who: string, feet: THREE.Vector3, effects: PropValue | undefined, stick: number, dt: number, interval = FP_STEP_INTERVAL) {
    const tr = this.tracker(key);
    const r = fpStepTimer(tr.fpTimer ?? interval, stick, dt, interval);
    tr.fpTimer = r.timer;
    if (r.step) this.step(who, FOOTSTEP.light, feet, effects, tr);
    return r.step;
  }

  private tracker(key: object): Tracker {
    let tr = this.trackers.get(key);
    if (!tr) this.trackers.set(key, (tr = { t: 0, markers: [], lastStep: -1 }));
    return tr;
  }

  /** Play one footstep event of a kind (0..5) at the feet. */
  step(who: string, kind: number, feet: THREE.Vector3, effects: PropValue | undefined, tr?: Tracker) {
    const surf = this.env.surfaces.below(feet.x, feet.y + 0.2, feet.z, 1.2);
    const entry = this.env.surfaces.pick(effects, surf?.type ?? null);
    let sound: string | null = null;
    // The player wading deeper than p21 (levels/water.ts wadingStep, 0x10042cd0): only the
    // entry's sound p17 (to p25) or p18 (deeper), at the feet; no effect, no noise.
    const wade = who === 'player' ? waterSurfaces.wade : undefined;
    const depth = surf && surf.type === waterSurfaces.type ? surf.y - feet.y : 0;
    if (entry && wade && depth >= wade.shallow) {
      const keys = refsOf(entry.values[depth > wade.deep ? 18 : 17]).map(refKey).filter((k) => this.env.audio.get(k));
      if (keys.length) {
        sound = keys[Math.floor(Math.random() * keys.length)];
        this.env.audio.play3D(sound, [feet.x, feet.y + 0.1, feet.z], { bus: 'sfx' });
      }
      if (tr) tr.lastStep = this.clock;
      this.recent.push({ t: +this.clock.toFixed(2), who, kind: depth > wade.deep ? 'wade-deep' : 'wade', surface: surf?.type ?? null, sound });
      if (this.recent.length > 60) this.recent.shift();
      return;
    }
    // Wading: sounds and splashes at the water level, not on the bed (surfaces.ts waterSurfaces).
    if (surf && surf.y > feet.y + 0.05) feet = feet.clone().setY(surf.y);
    if (entry) {
      const keys = refsOf(entry.values[1 + kind]).map(refKey).filter((k) => this.env.audio.get(k));
      if (keys.length) {
        let k = keys[Math.floor(Math.random() * keys.length)];
        if (k === tr?.lastKey && keys.length > 1) k = keys[(keys.indexOf(k) + 1) % keys.length];
        sound = k;
        if (tr) tr.lastKey = k;
        this.env.audio.play3D(k, [feet.x, feet.y + 0.1, feet.z], { bus: 'sfx' });
      }
      const fx = entry.values[8 + kind];
      if (fx && typeof fx === 'object' && !Array.isArray(fx)) this.env.spawn(fx as ResRef, feet);
      const inv = entry.values[7];
      if (kind !== FOOTSTEP.sneak && inv && typeof inv === 'object' && !Array.isArray(inv)) this.env.noise?.(inv as ResRef, feet, who);
    }
    if (tr) tr.lastStep = this.clock;
    this.recent.push({ t: +this.clock.toFixed(2), who, kind: FOOTSTEP_NAMES[kind] ?? String(kind), surface: surf?.type ?? null, sound });
    if (this.recent.length > 60) this.recent.shift();
  }

  /** Seconds since this character's last step (landing de-duplication). */
  sinceStep(key: object) {
    const tr = this.trackers.get(key);
    return tr && tr.lastStep >= 0 ? this.clock - tr.lastStep : Infinity;
  }

  tick(dt: number) {
    this.clock += dt;
  }
}
