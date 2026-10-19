// Lip-sync system: while a sound with a mouth envelope plays for a character, its jaw
// follows the envelope on the AudioSystem's playback clock (src/app/lipsync.ts has the
// jaw setup and the mapping; docs/game-logic.md "Lip-sync" the original's rules).
//
// Service published on ctx.services:
//
//   services.lipsync: LipSyncService
//     speak(handle, uid?, ch?)   `handle` (AudioSystem.play result) is spoken by the actor
//                                placed with `uid` (or by `ch` when given, e.g. the sequence
//                                puppet). No-op when the sound has no envelope or the
//                                character has no jaw. A new line replaces the previous one.
//     speakNear(handle, pos, r)  same, for the nearest actor within r (sound objects placed
//                                at a speaker)
//
// Registered after the actors and sequence systems so the jaw offset lands on top of the
// pose their animation mixers wrote this frame. Stops (jaw closes) when the sound stops,
// is skipped or ends.
//
// Debug: window.__lipsync { active(), trace (set .tracing = true; per-frame entries) }.

import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import type { SoundHandle } from '../../app/audio';
import type { Character } from '../../app/character';
import type { Entity } from '../../formats/entities';
import type { LipSync } from '../../formats/sound';
import { JawDriver, jawConfig, sampleEnvelope } from '../../app/lipsync';

export interface LipSyncService {
  speak(handle: SoundHandle, uid?: number, ch?: Character): boolean;
  speakNear(handle: SoundHandle, pos: THREE.Vector3Like, radius: number): boolean;
}

interface ActorLike {
  readonly ch: Character;
  readonly entity?: Entity;
  readonly hidden?: boolean;
}
interface ActorsLike {
  get(uid: number): ActorLike | undefined;
  list(): readonly ActorLike[];
}
interface WorldLike {
  world?: { get(uid: number): { e: Entity } | undefined };
}

interface Line {
  driver: JawDriver;
  handle: SoundHandle;
  env?: LipSync;
}

export interface LipSyncTrace {
  /** performance.now() when the jaw was posed. */
  now: number;
  key: string;
  /** Audible position in the sound (s); the envelope is sampled at audio + lead. */
  audio: number;
  lead: number;
  /** Envelope value used (0..1) and resulting angle (degrees). */
  value: number;
  degrees: number;
}

export function lipSyncService(ctx: GameContext): LipSyncService | undefined {
  return ctx.services.lipsync as LipSyncService | undefined;
}

export function createLipSyncSystem(ctx: GameContext): GameSystem {
  const { audio } = ctx;
  const actors = () => ctx.services.actors as ActorsLike | undefined;
  const world = () => ctx.services.world as WorldLike | undefined;
  const drivers = new WeakMap<Character, JawDriver | null>();
  const lines = new Map<Character, Line>();
  const trace: LipSyncTrace[] = [];
  let tracing = false;

  const driverFor = (ch: Character, entity?: Entity): JawDriver | null => {
    let d = drivers.get(ch);
    if (d === undefined) {
      const cfg = jawConfig(ch.skinned.skeleton, entity);
      d = cfg ? new JawDriver(ch, cfg) : null;
      drivers.set(ch, d);
    }
    return d;
  };

  const start = (handle: SoundHandle, ch: Character, entity?: Entity): boolean => {
    if (!audio.info(handle.key)?.lipsync || !handle.playing) return false;
    const driver = driverFor(ch, entity);
    if (!driver) return false;
    lines.get(ch)?.driver.reset();
    const line: Line = { driver, handle };
    lines.set(ch, line);
    void audio.lipSync(handle.key).then((env) => (line.env = env));
    return true;
  };

  const service: LipSyncService = {
    speak(handle, uid, ch) {
      const actor = uid !== undefined ? actors()?.get(uid) : undefined;
      const target = ch ?? actor?.ch;
      if (!target) return false;
      const entity = actor?.entity ?? (uid !== undefined ? world()?.world?.get(uid)?.e : undefined);
      return start(handle, target, entity);
    },
    speakNear(handle, pos, radius) {
      if (!audio.info(handle.key)?.lipsync) return false;
      let best: ActorLike | undefined;
      let bestD = radius;
      const p = new THREE.Vector3();
      for (const a of actors()?.list() ?? []) {
        if (a.hidden || !a.ch.root.visible) continue;
        a.ch.root.getWorldPosition(p);
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        if (d < bestD && driverFor(a.ch, a.entity)) {
          best = a;
          bestD = d;
        }
      }
      return !!best && start(handle, best.ch, best.entity);
    },
  };
  ctx.services.lipsync = service;

  Object.assign(window, {
    __lipsync: {
      trace,
      get tracing() {
        return tracing;
      },
      set tracing(v: boolean) {
        tracing = v;
      },
      active: () => [...lines.values()].map((l) => ({ key: l.handle.key, character: l.driver.ch.root.name, degrees: (l.driver.angle * 180) / Math.PI })),
      /** Live line objects (driver, handle, envelope) for in-page inspection. */
      lines: () => [...lines.values()],
    },
  });

  return {
    name: 'lipsync',
    update(dt) {
      // The pose posed now is seen at the next display refresh: sample the envelope that
      // far ahead (one frame, capped) so mouth and voice line up at the screen.
      const lead = Math.min(Math.max(dt, 0), 0.05);
      for (const [ch, line] of lines) {
        const { driver, handle, env } = line;
        const pos = handle.position();
        if (!handle.playing) {
          driver.reset();
          lines.delete(ch);
          continue;
        }
        const value = env && pos !== undefined ? sampleEnvelope(env, pos + lead) : 0;
        driver.apply(value);
        if (tracing && pos !== undefined && env) {
          trace.push({ now: performance.now(), key: handle.key, audio: pos, lead, value, degrees: (driver.angle * 180) / Math.PI });
          if (trace.length > 20000) trace.splice(0, 10000);
        }
      }
    },
    dispose() {
      for (const line of lines.values()) line.driver.reset();
      lines.clear();
      if (ctx.services.lipsync === service) delete ctx.services.lipsync;
      delete (window as unknown as { __lipsync?: unknown }).__lipsync;
    },
  };
}
