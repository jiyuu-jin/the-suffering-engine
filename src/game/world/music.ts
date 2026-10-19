// Level music: "Combat Music" objects (class 0xcd739b63), driven by level-logic messages.
//
// Music never starts on its own at level load: each Combat Music object is a music
// configuration that becomes current when it receives its trigger message, or at start
// when its "starts active" flag is set (most levels have one such object; 1a has none, so
// its opening sequence plays without music). The current object is ticked once a second by
// the player (RFL 0x10042790 -> 0x100a0740) and plays only around fights [code; properties in
// docs/re/properties.md]:
//
//   p0   music list (category 2 looping tracks; one is picked at random)
//   p1   enemies needed to start: the music starts when at least p1 hostile creatures that
//        are after the player are within p2 m of it (only the object's linked characters
//        count when it has links; RFL 0x100a0550 / 0x100e4a50)
//   p2   radius (m) for that count
//   p3   the music keeps going while more than p3 such creatures are within p4 m ...
//   p4   ... radius (m)
//   p5   ... and for p5 s after the count drops (then it fades out)
//   p6   fade-in time (s) of a track, p7 fade-out time (s)
//   p8   fade-out time (s) of the playing track when p12 is set
//   p10  1 = current from the level start
//   p11  trigger message (input slot): makes this object the current one
//   p12  on trigger: fade the playing music out (p8 s) and start this one at once
//   (p9, p13: not read by the music code)
//
// The most recently triggered object is the current configuration. Debug: window.__music.

import type { GameContext, GameSystem } from '../runtime';
import type { WorldService } from './world';
import type { WorldEntity } from './logic';
import { soundKey } from '../../formats/sound';
import { registerSave } from '../save/providers';

interface ActorLike {
  readonly uid?: number;
  readonly entity?: { uid: number };
  readonly state: string;
  readonly hostile: boolean;
  readonly provoked?: boolean;
  readonly alive: boolean;
  readonly hidden?: boolean;
  readonly scripted?: boolean;
  readonly position: { x: number; y: number; z: number };
}
interface ActorsLike {
  list(): readonly ActorLike[];
}

interface MusicConfig {
  uid: number;
  keys: string[];
  startCount: number;
  startRadius: number;
  keepCount: number;
  keepRadius: number;
  linger: number;
  fadeIn: number;
  fadeOut: number;
  switchFade: number;
  replace: boolean;
  trigger: number;
  /** Linked characters: when present only they count. */
  links: number[];
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createMusicSystem(ctx: GameContext): GameSystem {
  const ws = ctx.services.world as WorldService | undefined;
  const { audio, view } = ctx;
  if (!ws) return { name: 'music (no world)' };
  const world = ws.world;

  const configs = new Map<number, MusicConfig>();
  for (const w of world.of('Combat Music') as WorldEntity[]) {
    const v = w.e.values;
    const list = Array.isArray(v[0]) ? v[0] : v[0] ? [v[0]] : [];
    const keys = list
      .filter((r): r is { pkg: number; id: number } => !!r && typeof r === 'object' && 'pkg' in r)
      .map((r) => soundKey(r.pkg, r.id))
      .filter((k) => audio.get(k));
    if (!keys.length) continue;
    configs.set(w.uid, {
      uid: w.uid,
      keys,
      startCount: num(v[1], 1),
      startRadius: num(v[2], 10),
      keepCount: num(v[3], 0),
      keepRadius: num(v[4], 22),
      linger: num(v[5], 5),
      fadeIn: num(v[6], 0),
      fadeOut: num(v[7], 4),
      switchFade: num(v[8], 0.06),
      replace: num(v[12]) !== 0,
      trigger: num(v[11], 1),
      links: [...(w.e.links ?? [])],
    });
  }

  let current: MusicConfig | null = null;
  let playing = false;
  /** Game time until which the music keeps going without a fight (p5 after the last one). */
  let hotUntil = 0;
  const log: { time: number; event: string; uid?: number; keys?: string[] }[] = [];
  let clock = 0;
  const note = (event: string, c?: MusicConfig) => {
    log.push({ time: +clock.toFixed(2), event, uid: c?.uid, keys: c?.keys });
    console.info(`[music] ${event}${c ? ` (Combat Music ${c.uid.toString(16)}: ${c.keys.join(', ')}, starts at ${c.startCount} within ${c.startRadius} m)` : ''}`);
  };

  const start = () => {
    if (!current) return;
    // Linear crossfade: the old track out over the new object's p7, the new one in over its p6.
    audio.playMusic(current.keys, { fadeIn: Math.max(0.05, current.fadeIn), fadeOut: Math.max(0.05, current.fadeOut) });
    playing = true;
    note('start', current);
  };
  const stop = (why: string, fade = current?.fadeOut ?? 3) => {
    if (!playing) return;
    audio.stopMusic(Math.max(0.05, fade));
    playing = false;
    note(`stop: ${why}`, current ?? undefined);
  };

  // RFL 0x100a0670: a newly triggered object becomes current; with p12 it replaces the music
  // that is playing at once (fading that out over p8 s), otherwise the playing track goes on
  // and the new object's counts decide from its next tick.
  const activate = (c: MusicConfig, why: string) => {
    current = c;
    note(`current (${why})`, c);
    if (c.replace && playing) {
      stop('replaced', c.switchFade);
      start();
      hotUntil = clock + c.linger;
    }
  };

  for (const c of configs.values()) {
    const w = world.get(c.uid);
    if (w && num(w.e.values[10]) !== 0) activate(c, 'active at start');
  }

  const unsubscribe = world.subscribe('*', (msg, _from, to) => {
    const c = configs.get(to);
    if (c && msg === c.trigger) activate(c, `message ${msg}`);
  });

  /** Hostile creatures after the player within `radius` m (only `links` when given). */
  const enemiesNear = (radius: number, links: number[]): number => {
    const actors = ctx.services.actors as ActorsLike | undefined;
    if (!actors) return 0;
    const p = view.player.position;
    let n = 0;
    for (const a of actors.list()) {
      if (!a.alive || a.hidden || a.scripted || !(a.hostile || a.provoked)) continue;
      if (a.state !== 'chase' && a.state !== 'attack') continue;
      if (links.length && !links.includes(a.uid ?? a.entity?.uid ?? -1)) continue;
      const dx = a.position.x - p.x, dy = a.position.y - p.y, dz = a.position.z - p.z;
      if (dx * dx + dy * dy + dz * dz < radius * radius) n++;
    }
    return n;
  };

  // Save state (src/game/save): the current configuration and whether it is playing.
  const unregisterSave = registerSave<{ current: number | null; playing: boolean }>(
    ctx.services,
    'music',
    {
      save: () => ({ current: current?.uid ?? null, playing }),
      load(d) {
        current = d.current !== null ? (configs.get(d.current) ?? null) : null;
        if (d.playing && current) start();
        else stop('restored');
        hotUntil = d.playing && current ? clock + current.linger : 0;
      },
    },
    { scope: 'level', priority: 40 },
  );

  Object.assign(window, {
    __music: {
      log,
      get current() {
        return current?.uid;
      },
      get playing() {
        return playing;
      },
      configs: [...configs.values()],
    },
  });

  let acc = 0;
  return {
    name: 'music',
    update(dt) {
      clock += dt;
      acc += dt;
      // The original ticks the current object once a second.
      if (acc < 1 || !current) return;
      acc = 0;
      // Cinematics own the soundtrack (the sequence plays its own cues).
      if (world.activeCutscenes().length) return;
      const c = current;
      if (!playing) {
        if (enemiesNear(c.startRadius, c.links) >= c.startCount) {
          start();
          hotUntil = clock + c.linger;
        }
      } else if (enemiesNear(c.keepRadius, c.links) > c.keepCount) hotUntil = clock + c.linger;
      else if (clock >= hotUntil) stop('fight over');
    },
    dispose() {
      unregisterSave();
      unsubscribe();
      if (playing) audio.stopMusic(1);
      delete (window as unknown as { __music?: unknown }).__music;
    },
  };
}
