// AudioSystem: WebAudio playback of The Suffering's .sdu sounds. Independent of
// the renderer; it only needs a camera (or pose) once per frame.
//
// Public API
// ----------
//   const audio = new AudioSystem(options?)
//     options.context        AudioContext to use (default: new AudioContext())
//     options.cacheBytes     decoded-buffer cache budget in bytes (default 256 MB)
//     options.maxVoices      simultaneous voices (default 48); when full, a new sound steals the first
//                            voice of strictly lower priority, else it is dropped (original rule)
//     options.panningModel   'equalpower' (default, like the original's plain DS3D panning) or 'HRTF'
//
//   Sound data (lazy: an index costs the directory + one 60-byte read per sound;
//   samples are fetched from the converted media (`npm run bake`, AAC) and decoded
//   per sound on first use, see sound-source.ts):
//     await audio.mountSdu(source, path, pkg)  -> SoundInfo[]
//         source: { read(path), readRange?(path, offset, length) } — a GameFS (whose converted
//         media provides the samples); without readRange the whole file is read once.
//     await audio.mountReader(read, pkg)       -> SoundInfo[]  (headers/lip-sync only: no samples)
//     audio.unmount(pkg)                       drop a package's index (and cached buffers)
//     audio.info(key) / audio.sounds()         lookup / all known SoundInfo ("pkg:id" keys)
//     audio.packagePath(pkg)                   the .sdu path a package was mounted from
//     audio.onPlay = (info, opts) => ...       hook called when play() starts a known sound
//                                              (gamepad rumble: src/app/gamepad.ts)
//     await audio.load(key)                    -> AudioBuffer (cached; concurrent calls share work)
//     audio.preload(keys)                      warm the cache in the background
//
//   Playback (returns a SoundHandle immediately; audio starts when the buffer is ready):
//     audio.play(key, opts?)                   2D unless opts.position is given
//       opts.bus        'music' | 'sfx' | 'voice' (default from the sound's category)
//       opts.volume     linear gain (default 1)
//       opts.loop       default: the sound's loop flag
//       opts.position   [x,y,z] in world (renderer / LevelData) units -> 3D via PannerNode
//       opts.minDistance / opts.maxDistance   default: the sound header's distances
//       opts.playbackRate, opts.offset (seconds), opts.fadeIn (seconds)
//     audio.play3D(key, position, opts?)       shorthand
//     audio.playMusic(key | keys, { fadeIn, fadeOut, fade })  single music track, linear crossfade
//     audio.fadeBus(bus, attenuation, seconds) per-bus duck stage (pause, cinematics, movies)
//     audio.stopMusic(fade?)
//     audio.stopAll(bus?)
//     handle.stop(fade?) / handle.setVolume(v) / handle.setPosition([x,y,z]) / handle.ended (Promise) / handle.playing
//     handle.position()                        seconds into the sound that are audible right now
//                                              (undefined until the buffer has started)
//     audio.audibleTime()                      context time of the sample reaching the speakers now
//     await audio.lipSync(key)                 dialog mouth envelope (.sdu type 5), cached; undefined if none
//
//   Mixing:
//     audio.setBusVolume('master' | 'music' | 'sfx' | 'voice', v) / audio.getBusVolume(bus)
//     audio.busNode(bus)                       the bus GainNode (route external sources through the mixer)
//     audio.setMuted(bool)
//     await audio.resume()                     call from a user gesture (autoplay policy)
//
//   Level ambience:
//     audio.setEmitters(emitters, { randomOneShots?, autoMusic? })
//         emitters from levelSoundEmitters() (src/formats/sound.ts). Looping emitters start
//         when the listener enters their radius and fade out when it leaves; with
//         autoMusic (default false) starts the first music object right away (viewer use;
//         in a running level, music objects are started by level-logic messages:
//         src/game/world/music.ts);
//         randomOneShots (default false) re-triggers non-looping emitters at random
//         intervals while in range.
//     audio.clearEmitters()
//
//   Per frame:
//     audio.update(camera)                     THREE.Camera (uses matrixWorld) or
//                                              { position: [x,y,z], forward: [x,y,z], up: [x,y,z] }
//
// Units: positions and distances are in the renderer's world units (model units,
// 1 unit ~ 0.85 m); sound header distances are in the same units.

import type { Camera } from 'three';
import { distanceGain, isPositionalSound, pickVoiceToSteal, soundPriority } from './audio-rules';
import {
  type RangeReader,
  type SoundEmitter,
  type SoundInfo,
  SoundCategory,
  indexSoundsLazy,
  parseLipSync,
  type LipSync,
} from '../formats/sound';
import { SoundSamples } from './sound-source';

export type Bus = 'master' | 'music' | 'sfx' | 'voice';
export type Vec3 = [number, number, number];

export interface SoundFileSource {
  read(path: string): Promise<ArrayBuffer>;
  readRange?(path: string, offset: number, length: number): Promise<ArrayBuffer>;
}

export interface PlayOptions {
  bus?: Exclude<Bus, 'master'>;
  volume?: number;
  loop?: boolean;
  position?: Vec3;
  minDistance?: number;
  maxDistance?: number;
  playbackRate?: number;
  offset?: number;
  fadeIn?: number;
}

export interface ListenerPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

export interface AudioSystemOptions {
  context?: AudioContext;
  cacheBytes?: number;
  maxVoices?: number;
  panningModel?: PanningModelType;
}

export interface EmitterOptions {
  randomOneShots?: boolean;
  /** Start the first music object at once (default false: level logic starts music). */
  autoMusic?: boolean;
  /** Seconds between random one-shots (default [6, 20]). */
  oneShotInterval?: [number, number];
}

/** Bus a sound plays on by default, from its header category. */
export function busForCategory(category: number): Exclude<Bus, 'master'> {
  switch (category) {
    case SoundCategory.Music:
    case SoundCategory.Movie:
      return 'music';
    case SoundCategory.Dialog:
    case SoundCategory.Interface5:
      return 'voice';
    default:
      return 'sfx';
  }
}

export class SoundHandle {
  private source?: AudioBufferSourceNode;
  private stopped = false;
  private resolveEnded!: () => void;
  readonly ended: Promise<void>;
  readonly gain: GainNode;
  readonly panner?: PannerNode;
  /** Engine distance attenuation for positional sounds (audio-rules.ts distanceGain). */
  readonly distance?: GainNode;
  readonly startedAt: number;
  /** Mixing priority 0..15 (header +0x0c); used for voice stealing. */
  priority = 5;
  /** Distance curve range and current position (positional sounds only). */
  range?: { min: number; max: number };
  pos?: Vec3;
  /** Playback clock once the buffer started: context time, buffer offset, rate, duration. */
  private clock?: { t: number; offset: number; rate: number; duration: number };

  constructor(
    private readonly sys: AudioSystem,
    readonly key: string,
    readonly bus: Exclude<Bus, 'master'>,
    readonly loop: boolean,
    output: AudioNode,
    panner?: PannerNode,
  ) {
    const ctx = sys.context;
    this.gain = ctx.createGain();
    this.panner = panner;
    if (panner) {
      this.distance = ctx.createGain();
      this.gain.connect(this.distance).connect(panner).connect(output);
    } else this.gain.connect(output);
    this.startedAt = ctx.currentTime;
    this.ended = new Promise((r) => (this.resolveEnded = r));
  }

  get playing(): boolean {
    return !this.stopped;
  }

  /** @internal */
  _start(buffer: AudioBuffer, opts: PlayOptions): void {
    if (this.stopped) return;
    const ctx = this.sys.context;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = this.loop;
    if (opts.playbackRate) src.playbackRate.value = opts.playbackRate;
    src.connect(this.gain);
    src.onended = () => this._finish();
    const t = ctx.currentTime;
    const v = opts.volume ?? 1;
    if (opts.fadeIn && opts.fadeIn > 0) {
      this.gain.gain.setValueAtTime(0, t);
      this.gain.gain.linearRampToValueAtTime(v, t + opts.fadeIn);
    } else this.gain.gain.value = v;
    const offset = Math.max(0, opts.offset ?? 0) % Math.max(buffer.duration, 1e-6);
    src.start(t, offset);
    this.source = src;
    this.clock = { t, offset, rate: opts.playbackRate || 1, duration: buffer.duration };
  }

  /**
   * Seconds into the sound that are audible right now (output latency accounted for), or
   * undefined before the buffer started / after the handle stopped. Wraps for looping sounds.
   */
  position(): number | undefined {
    const c = this.clock;
    if (!c || this.stopped) return undefined;
    const p = c.offset + Math.max(0, this.sys.audibleTime() - c.t) * c.rate;
    return this.loop ? p % Math.max(c.duration, 1e-6) : Math.min(p, c.duration);
  }

  /** @internal */
  _finish(): void {
    if (this.source) this.source.onended = null;
    this.stopped = true;
    try {
      this.gain.disconnect();
      this.distance?.disconnect();
      this.panner?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.sys._release(this);
    this.resolveEnded();
  }

  stop(fade = 0): void {
    if (this.stopped) return;
    const src = this.source;
    if (!src) return this._finish();
    const t = this.sys.context.currentTime;
    if (fade > 0) {
      const g = this.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + fade);
      src.stop(t + fade);
    } else src.stop();
  }

  setVolume(v: number, ramp = 0.05): void {
    const t = this.sys.context.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(v, t, ramp / 3);
  }

  setPosition(p: Vec3): void {
    const n = this.panner;
    if (!n) return;
    this.pos = p;
    const t = this.sys.context.currentTime;
    n.positionX.setValueAtTime(p[0], t);
    n.positionY.setValueAtTime(p[1], t);
    n.positionZ.setValueAtTime(p[2], t);
  }
}

interface CacheEntry {
  promise: Promise<AudioBuffer>;
  bytes: number;
}

interface EmitterState {
  e: SoundEmitter;
  handle?: SoundHandle;
  nextShot: number;
}

export class AudioSystem {
  readonly context: AudioContext;
  private readonly buses: Record<Bus, GainNode>;
  /** Per-bus duck stage after the user volume (manager +0x58): pause, cinematics, movies. */
  private readonly ducks: Record<Exclude<Bus, 'master'>, GainNode>;
  private readonly busLevels: Record<Bus, number> = { master: 1, music: 1, sfx: 1, voice: 1 };
  private muted = false;
  private readonly index = new Map<string, SoundInfo>();
  private readonly readers = new Map<number, RangeReader>();
  private readonly samples = new SoundSamples();
  private readonly cache = new Map<string, CacheEntry>(); // insertion order = LRU order
  private cacheBytes = 0;
  private readonly cacheLimit: number;
  private readonly maxVoices: number;
  private readonly panningModel: PanningModelType;
  private readonly voices = new Set<SoundHandle>();
  private music?: SoundHandle;
  private emitters: EmitterState[] = [];
  private emitterOpts: Required<EmitterOptions> = { randomOneShots: false, autoMusic: false, oneShotInterval: [6, 20] };
  private listener: Vec3 = [0, 0, 0];
  private readonly lipSyncs = new Map<string, Promise<LipSync | undefined>>();
  /** .sdu path of each package mounted with mountSdu (rumble curves live in the .wdu next to it). */
  private readonly paths = new Map<number, string>();
  /**
   * Called whenever play() starts a known sound (src/app/gamepad.ts plays the rumble curve a
   * sound header references).
   */
  onPlay?: (info: SoundInfo, opts: PlayOptions) => void;

  constructor(opts: AudioSystemOptions = {}) {
    this.context = opts.context ?? new AudioContext();
    this.cacheLimit = opts.cacheBytes ?? 256 * 1024 * 1024;
    this.maxVoices = opts.maxVoices ?? 48;
    this.panningModel = opts.panningModel ?? 'equalpower';
    const ctx = this.context;
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const duck = () => {
      const d = ctx.createGain();
      d.connect(master);
      return d;
    };
    this.ducks = { music: duck(), sfx: duck(), voice: duck() };
    const mk = (b: Exclude<Bus, 'master'>) => {
      const g = ctx.createGain();
      g.connect(this.ducks[b]);
      return g;
    };
    this.buses = { master, music: mk('music'), sfx: mk('sfx'), voice: mk('voice') };
  }

  // -------------------------------------------------------------------------
  // Data

  async mountSdu(source: SoundFileSource, path: string, pkg: number): Promise<SoundInfo[]> {
    let read: RangeReader;
    if (source.readRange) {
      const rr = source.readRange.bind(source);
      read = (o, n) => rr(path, o, n);
    } else {
      // Fallback: one whole-file read, kept for the lifetime of the mount.
      const whole = source.read(path);
      read = async (o, n) => (await whole).slice(o, o + n);
    }
    const list = await this.mountReader(read, pkg);
    this.samples.mount(pkg, source);
    this.paths.set(pkg, path);
    return list;
  }

  /** .sdu path a package was mounted from (mountSdu only). */
  packagePath(pkg: number): string | undefined {
    return this.paths.get(pkg);
  }

  /** Listener position of the last update(). */
  get listenerPosition(): Vec3 {
    return this.listener;
  }

  async mountReader(read: RangeReader, pkg: number): Promise<SoundInfo[]> {
    const list = await indexSoundsLazy(read, pkg);
    this.readers.set(pkg, read);
    for (const s of list) this.index.set(s.key, s);
    return list;
  }

  unmount(pkg: number): void {
    this.readers.delete(pkg);
    this.paths.delete(pkg);
    this.samples.unmount(pkg);
    for (const [k, s] of this.index) {
      if (s.pkg !== pkg) continue;
      this.index.delete(k);
      this.lipSyncs.delete(k);
      const c = this.cache.get(k);
      if (c) {
        this.cache.delete(k);
        this.cacheBytes -= c.bytes;
      }
    }
  }

  info(key: string): SoundInfo | undefined {
    return this.index.get(key);
  }

  /** Implements SoundLookup for levelSoundEmitters(). */
  get(key: string): SoundInfo | undefined {
    return this.index.get(key);
  }

  sounds(): SoundInfo[] {
    return [...this.index.values()];
  }

  load(key: string): Promise<AudioBuffer> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit.promise;
    }
    const info = this.index.get(key);
    if (!info) return Promise.reject(new Error(`Unknown sound ${key}`));
    const bytes = SoundSamples.decodedBytes(this.context, info);
    const promise = this.samples.load(this.context, info);
    const entry = { promise, bytes };
    this.cache.set(key, entry);
    this.cacheBytes += bytes;
    promise.catch(() => {
      if (this.cache.get(key) === entry) {
        this.cache.delete(key);
        this.cacheBytes -= bytes;
      }
    });
    this.evict();
    return promise;
  }

  /** Lip-sync envelope of a dialog sound (cached; undefined when the sound has none). */
  lipSync(key: string): Promise<LipSync | undefined> {
    const hit = this.lipSyncs.get(key);
    if (hit) return hit;
    const info = this.index.get(key);
    const read = info && this.readers.get(info.pkg);
    const loc = info?.lipsync;
    const p =
      read && loc
        ? read(loc.offset, loc.size).then(
            (b) => parseLipSync(new DataView(b)),
            () => undefined,
          )
        : Promise.resolve(undefined);
    this.lipSyncs.set(key, p);
    return p;
  }

  /**
   * Context time of the audio reaching the speakers right now: currentTime runs ahead of
   * what is heard by the output latency (getOutputTimestamp when available).
   */
  audibleTime(): number {
    const ctx = this.context;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : undefined;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      // contextTime was audible at performanceTime; extrapolate to now.
      return ts.contextTime + Math.max(0, performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  preload(keys: Iterable<string>): void {
    for (const k of keys) this.load(k).catch((e) => console.warn(`[audio] ${k}: ${e}`));
  }

  private evict(): void {
    for (const [k, c] of this.cache) {
      if (this.cacheBytes <= this.cacheLimit || this.cache.size <= 1) break;
      this.cache.delete(k);
      this.cacheBytes -= c.bytes;
    }
  }

  // -------------------------------------------------------------------------
  // Playback

  play(key: string, opts: PlayOptions = {}): SoundHandle {
    const info = this.index.get(key);
    const bus = opts.bus ?? busForCategory(info?.category ?? 0);
    const loop = opts.loop ?? info?.loop ?? false;
    let panner: PannerNode | undefined;
    let range: { min: number; max: number } | undefined;
    // Stereo sounds and Music / Movie / GUI sounds are never positional (original rule).
    const positional = !!opts.position && (!info || isPositionalSound(info));
    if (positional && opts.position) {
      const max = opts.maxDistance ?? (info && info.maxDistance > 0 ? info.maxDistance : 40);
      const min = Math.min(Math.max(opts.minDistance ?? info?.minDistance ?? 0, 0), max * 0.99);
      range = { min, max };
      // The engine disables DirectSound's own rolloff and applies its curve as volume; the
      // panner only pans (rolloffFactor 0), with no Doppler.
      panner = new PannerNode(this.context, {
        panningModel: this.panningModel,
        distanceModel: 'linear',
        refDistance: 1,
        maxDistance: 1e9,
        rolloffFactor: 0,
        positionX: opts.position[0],
        positionY: opts.position[1],
        positionZ: opts.position[2],
      });
    }
    const priority = soundPriority(info?.priority);
    if (!this.reserveVoice(priority)) {
      // No voice of strictly lower priority to steal: the new sound is dropped.
      const dropped = new SoundHandle(this, key, bus, loop, this.buses[bus]);
      dropped._finish();
      return dropped;
    }
    const h = new SoundHandle(this, key, bus, loop, this.buses[bus], panner);
    h.priority = priority;
    if (range && opts.position) {
      h.range = range;
      h.pos = opts.position;
      h.distance!.gain.value = this.distanceGainFor(h);
    }
    this.voices.add(h);
    if (!info) {
      console.warn(`[audio] unknown sound ${key}`);
      h._finish();
      return h;
    }
    if (this.onPlay) {
      try {
        this.onPlay(info, opts);
      } catch (err) {
        console.warn('[audio] onPlay hook failed', err);
      }
    }
    // The header volume (+0x04 / 10000) is the sound's default per-play volume.
    const headerVolume = Number.isFinite(info.volume) && info.volume > 0 ? info.volume : 1;
    const startOpts = headerVolume === 1 ? opts : { ...opts, volume: (opts.volume ?? 1) * headerVolume };
    this.load(key).then(
      (buf) => h._start(buf, startOpts),
      (e) => {
        console.warn(`[audio] ${key}: ${e}`);
        h._finish();
      },
    );
    return h;
  }

  play3D(key: string, position: Vec3, opts: PlayOptions = {}): SoundHandle {
    return this.play(key, { ...opts, position });
  }

  /**
   * Single music track: the old track fades out linearly over `fadeOut` and the new one fades in
   * from silence over `fadeIn` (Combat Music p7 / p6 of the NEW object); `fade` sets both.
   */
  playMusic(
    keys: string | string[],
    opts: { fade?: number; fadeIn?: number; fadeOut?: number; volume?: number } = {},
  ): SoundHandle | undefined {
    const list = typeof keys === 'string' ? [keys] : keys;
    if (!list.length) return undefined;
    const fadeIn = opts.fadeIn ?? opts.fade ?? 2;
    const fadeOut = opts.fadeOut ?? opts.fade ?? 2;
    if (this.music?.playing && list.includes(this.music.key)) return this.music;
    this.music?.stop(fadeOut);
    const key = list[Math.floor(Math.random() * list.length)];
    this.music = this.play(key, { bus: 'music', loop: true, fadeIn, volume: opts.volume });
    return this.music;
  }

  /**
   * Duck a bus by `attenuation` (0 = full volume, 1 = silent) with a linear ramp over
   * `seconds`; independent of the user's bus volume.
   */
  fadeBus(bus: Exclude<Bus, 'master'>, attenuation: number, seconds = 0): void {
    const g = this.ducks[bus].gain;
    const t = this.context.currentTime;
    const target = Math.min(1, Math.max(0, 1 - attenuation));
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (seconds > 0) g.linearRampToValueAtTime(target, t + seconds);
    else g.setValueAtTime(target, t);
  }

  stopMusic(fade = 2): void {
    this.music?.stop(fade);
    this.music = undefined;
  }

  stopAll(bus?: Exclude<Bus, 'master'>): void {
    for (const v of [...this.voices]) if (!bus || v.bus === bus) v.stop();
    if (!bus || bus === 'music') this.music = undefined;
    for (const s of this.emitters) if (s.handle && !s.handle.playing) s.handle = undefined;
  }

  /** @internal called by SoundHandle when it ends */
  _release(h: SoundHandle): void {
    this.voices.delete(h);
  }

  /**
   * Make room for a new voice: below the limit it always fits; otherwise it steals the first
   * voice (in start order) with strictly lower priority, or is dropped (returns false).
   */
  private reserveVoice(priority: number): boolean {
    if (this.voices.size < this.maxVoices) return true;
    const list = [...this.voices].filter((v) => v !== this.music);
    const i = pickVoiceToSteal(priority, list.map((v) => v.priority));
    if (i < 0) return false;
    list[i].stop();
    return true;
  }

  private distanceGainFor(h: SoundHandle): number {
    if (!h.range || !h.pos) return 1;
    const l = this.listener;
    const d = Math.hypot(h.pos[0] - l[0], h.pos[1] - l[1], h.pos[2] - l[2]);
    return distanceGain(d, h.range.min, h.range.max);
  }

  // -------------------------------------------------------------------------
  // Mixing

  setBusVolume(bus: Bus, v: number): void {
    this.busLevels[bus] = v;
    this.applyBus(bus);
  }

  getBusVolume(bus: Bus): number {
    return this.busLevels[bus];
  }

  /** A bus's gain node, for routing other sources (e.g. cutscene <video> sound) through the mixer. */
  busNode(bus: Bus): GainNode {
    return this.buses[bus];
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyBus('master');
  }

  private applyBus(bus: Bus): void {
    const v = bus === 'master' && this.muted ? 0 : this.busLevels[bus];
    this.buses[bus].gain.setTargetAtTime(v, this.context.currentTime, 0.02);
  }

  async resume(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
  }

  // -------------------------------------------------------------------------
  // Level emitters

  setEmitters(emitters: SoundEmitter[], opts: EmitterOptions = {}): void {
    this.clearEmitters();
    this.emitterOpts = { ...this.emitterOpts, ...opts };
    const now = this.context.currentTime;
    const positional: EmitterState[] = [];
    let music: SoundEmitter | undefined;
    for (const e of emitters) {
      if (e.kind === 'music') {
        music ??= e;
        continue;
      }
      positional.push({ e, nextShot: now + this.randomInterval() });
    }
    this.emitters = positional;
    if (music && this.emitterOpts.autoMusic) this.playMusic(music.soundKeys);
  }

  clearEmitters(): void {
    for (const s of this.emitters) s.handle?.stop(0.5);
    this.emitters = [];
  }

  private randomInterval(): number {
    const [a, b] = this.emitterOpts.oneShotInterval;
    return a + Math.random() * (b - a);
  }

  private updateEmitters(): void {
    const [lx, ly, lz] = this.listener;
    const now = this.context.currentTime;
    for (const s of this.emitters) {
      const { e } = s;
      const r = e.radius ?? this.index.get(e.soundKey)?.maxDistance ?? 40;
      const dx = e.position[0] - lx;
      const dy = e.position[1] - ly;
      const dz = e.position[2] - lz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (e.loop) {
        if (!s.handle && d2 < r * r * 1.1) {
          const key = pick(e.soundKeys);
          // Random start offset so identical beds placed side by side don't phase.
          const offset = Math.random() * (this.index.get(key)?.duration ?? 0);
          s.handle = this.play(key, { position: e.position, maxDistance: r, loop: true, fadeIn: 0.5, offset });
        } else if (s.handle && d2 > r * r * 1.5) {
          s.handle.stop(0.5);
          s.handle = undefined;
        } else if (s.handle && !s.handle.playing) s.handle = undefined;
      } else if (this.emitterOpts.randomOneShots && now >= s.nextShot) {
        s.nextShot = now + this.randomInterval();
        if (d2 < r * r) this.play(pick(e.soundKeys), { position: e.position, maxDistance: r, loop: false });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Listener

  update(cameraOrPose: Camera | ListenerPose): void {
    let pos: Vec3, fwd: Vec3, up: Vec3;
    if ('matrixWorld' in cameraOrPose) {
      const m = cameraOrPose.matrixWorld.elements;
      pos = [m[12], m[13], m[14]];
      fwd = norm([-m[8], -m[9], -m[10]]);
      up = norm([m[4], m[5], m[6]]);
    } else ({ position: pos, forward: fwd, up } = cameraOrPose);
    // A broken camera (NaN/Infinity) would make every AudioParam call throw each frame.
    if (![...pos, ...fwd, ...up].every(Number.isFinite)) return;
    this.listener = pos;
    const l = this.context.listener;
    const t = this.context.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos[0], t, 0.01);
      l.positionY.setTargetAtTime(pos[1], t, 0.01);
      l.positionZ.setTargetAtTime(pos[2], t, 0.01);
      l.forwardX.setTargetAtTime(fwd[0], t, 0.01);
      l.forwardY.setTargetAtTime(fwd[1], t, 0.01);
      l.forwardZ.setTargetAtTime(fwd[2], t, 0.01);
      l.upX.setTargetAtTime(up[0], t, 0.01);
      l.upY.setTargetAtTime(up[1], t, 0.01);
      l.upZ.setTargetAtTime(up[2], t, 0.01);
    } else {
      // Older Safari/Firefox: deprecated setters.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(...pos);
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(...fwd, ...up);
    }
    // The engine's distance curve, applied as volume on each positional voice.
    for (const v of this.voices) {
      if (!v.distance) continue;
      v.distance.gain.setTargetAtTime(this.distanceGainFor(v), t, 0.02);
    }
    if (this.emitters.length) this.updateEmitters();
  }
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}
