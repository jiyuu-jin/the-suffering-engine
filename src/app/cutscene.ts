// Cutscene playback with a plain <video> element. The game's .vdu videos
// (WMV2/ASF) are converted once by `npm run bake` into H.264 MP4 files with
// their soundtrack muxed in (src/formats/converted.ts), so decoding and A/V
// sync are the browser's job. The .vdu files are still read for the catalog
// (keys, groups, durations) and the .sdu headers for the soundtrack pairing.
//
// Usage (overlay cutscene, modal, skippable):
//   const lib = new CutsceneLibrary(fs);
//   const player = new CutscenePlayer({ mixerVolume: () => musicBusGain });
//   const src = await lib.load(5, 16);                 // package id 5 (Interface), video 16 = intro
//   const src = await lib.load('COMMON/Interface/Interface.vdu', 16);   // same, by path
//   const result = await player.play(src);             // 'ended' | 'skipped' | 'stopped'
//
// Usage (looping menu background, behind DOM/canvas UI):
//   const bg = new CutscenePlayer({ container: menuRoot });     // menuRoot: position:relative (or omit = body)
//   void bg.play(await lib.load(5, 32), { background: true });  // loops, no chrome/skip, z-index 0
//   ... bg.stop();                                              // resolves play() with 'stopped'
//
// API
//   CutsceneLibrary(fs)
//     load(pkgOrPath, id, opts?)          -> CutsceneSource. pkgOrPath: package id (number) or .vdu path.
//                                            opts: { withAudio?, requireMedia? } or a boolean (withAudio).
//     list(pkgOrPath)                     -> VideoInfo[]
//     catalog()                           -> every video of every .vdu: { path, pkg, videos }[]
//     soundtrackFor(pkgOrPath, id)        -> the paired CutsceneSoundtrack (or null) without loading video
//     packageId(containerPath)            -> package id from the sibling .db
//   CutscenePlayer(opts?: { container, aspect, subtitleFont, mixerVolume, audioContext, destination })
//     play(src, opts?)                    -> Promise<'ended' | 'skipped' | 'stopped'>
//       opts.loop (false), opts.skippable (true), opts.skipDelay (0.25 s), opts.volume (1)
//       opts.background  menu-background mode: implies loop, no skip/keyboard/cursor handling,
//                        pointer-events: none, z-index opts.zIndex (default 0), fit 'cover'.
//                        Silent unless opts.volume is given (menu music usually plays separately).
//       opts.fit         'contain' (default; letterbox) | 'cover' (fill + crop)
//       opts.startAt     start position in seconds
//       opts.zIndex      CSS z-index of the layer (default 1000 overlay / 0 background)
//     seek(seconds), currentTime / duration (seconds; currentTime is continuous across loops)
//     skip() / stop() / dispose()      (gamepad A / B / Start skip too: polled while playing)
//     isPlaying, element (the layer's root element), stats (PlayerStats)
//
// Audio: the element plays its muxed soundtrack itself at volume x mixerVolume()
// (re-read every frame, so mixer changes apply live). It is deliberately not
// routed through WebAudio (MediaElementAudioSourceNode): the browser's media
// clock doesn't see the AudioContext's output latency, and in Chromium that
// put the sound ~55 ms behind the picture. A soundtrack in 'bed' mode (5:32's
// looping music) isn't muxed: it loops independently through `audioContext`
// (-> `destination`) from the converted sound file.
// Missing converted media: play() resolves 'ended' at once (and the app shows
// a one-time "run npm run bake" notice, see media.ts).

import type { GameFS } from './gamefs';
import { layoutText, type Font, type FontAtlas } from '../formats/font';
import { readDbId } from '../formats/model';
import { parseSoundHeader, readSrscDirectory, SDU_DATA, SDU_GROUP, SDU_HEADER, type RangeReader, type SoundInfo } from '../formats/sound';
import type { SrscEntry } from '../formats/srsc';
import { ASF_HEADER_PROBE, asfPlayDuration, findSoundtrack, pairVideoEntries, videoInfoFromHeader, type VideoInfo } from '../formats/video';
import { convertedMedia, reportMissingMedia } from './media';
import { SoundSamples } from './sound-source';
import { GamepadNav } from './menu/input';

export { findSoundtrack } from '../formats/video';

export interface SubtitleCue {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

/** A converted video (built by CutsceneLibrary). */
export interface CutsceneVideo {
  readonly info: VideoInfo;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Picture duration, seconds. */
  readonly durationSec: number;
  /** Media URL of the converted file, or null when it hasn't been converted. */
  readonly url: string | null;
  /** True if the file carries the synced soundtrack. */
  readonly muxedAudio: boolean;
}

export interface CutsceneSoundtrack {
  info: SoundInfo;
  /**
   * 'sync': muxed into the converted video (cutscenes).
   * 'bed': independent looping music under a looping video (menu background 5:32).
   */
  mode: 'sync' | 'bed';
  /** Human-readable reason for the pairing (debugging / docs). */
  pairing: string;
  /** Decodes the soundtrack on its own (used for 'bed' mode). */
  load(ctx: BaseAudioContext): Promise<AudioBuffer>;
}

export interface CutsceneSource {
  video: CutsceneVideo;
  /** Soundtrack; omit or null for a silent video (a muxed track is then muted). */
  sound?: CutsceneSoundtrack | null;
  subtitles?: SubtitleCue[];
}

export interface CutscenePlayOptions {
  /** Loop until skipped/stopped. Default false (true in background mode). */
  loop?: boolean;
  /** Allow Esc/Space/Enter/click to skip. Default true (false in background mode). */
  skippable?: boolean;
  /** Seconds before input can skip (avoids skipping with the key that started it). Default 0.25. */
  skipDelay?: number;
  /** 0..1, default 1 (background mode: default 0 = silent). */
  volume?: number;
  /** Menu-background layer: loop, no skip handling, no cursor hiding, pointer-events none. */
  background?: boolean;
  /** 'contain' letterboxes (default), 'cover' fills and crops (default in background mode). */
  fit?: 'contain' | 'cover';
  /** Start position, seconds. */
  startAt?: number;
  /** CSS z-index of the layer. Default 1000 (overlay) / 0 (background). */
  zIndex?: number;
}

export type CutsceneResult = 'ended' | 'skipped' | 'stopped';

export interface CutscenePlayerOptions {
  /** Element the layer is appended to (default document.body). */
  container?: HTMLElement;
  /**
   * Display aspect ratio. The videos are encoded at 512x512 but were shown
   * stretched to the 4:3 screen, so the default is 4/3. 'native' keeps square pixels.
   */
  aspect?: number | 'native';
  /** Use the game's bitmap font for subtitles (otherwise a CSS font is used). */
  subtitleFont?: { font: Font; atlases: FontAtlas[] };
  /** Mixer level applied on top of `volume` (e.g. master x music bus gain). Default 1. */
  mixerVolume?: () => number;
  /** Context for a separately looping music bed ('bed' soundtracks). Without one, beds are skipped. */
  audioContext?: AudioContext;
  /** Output node for the bed (e.g. a mixer bus). Default: context.destination. */
  destination?: AudioNode;
}

/** Counters of the current/last playback. */
export interface PlayerStats {
  /** Pictures presented (requestVideoFrameCallback, else the element's playback quality). */
  framesShown: number;
  /** Pictures the browser dropped. */
  framesDropped: number;
  /** Mean / max main-thread cost of the per-frame bookkeeping (subtitles, loop tracking), ms. */
  mainMs: number;
  mainMaxMs: number;
  /** Presented pictures per second over the playback. */
  fps: number;
  seeks: number;
  /** Time from play() to the first presented picture, ms. */
  startupMs: number;
  /** Animation-frame ticks more than 40 ms apart. */
  longTicks: number;
}

const freshStats = (): PlayerStats => ({
  framesShown: 0,
  framesDropped: 0,
  mainMs: 0,
  mainMaxMs: 0,
  fps: 0,
  seeks: 0,
  startupMs: 0,
  longTicks: 0,
});

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(cb: () => void): number;
  cancelVideoFrameCallback?(id: number): void;
};

// ---------------------------------------------------------------------------
// Player

export class CutscenePlayer {
  /**
   * Number of modal (non-background) movies playing. Gameplay input (src/app/menu/flow.ts) is
   * suspended meanwhile; gamepad A / B / Start skip the movie (polled here).
   */
  static modal = 0;
  private readonly root: HTMLDivElement;
  private readonly video: FrameCallbackVideo;
  private readonly subtitleEl: HTMLDivElement;
  private readonly subtitleCanvas: HTMLCanvasElement;
  private finish?: (r: CutsceneResult) => void;
  private playing = false;
  private fit: 'contain' | 'cover' = 'contain';
  private current?: CutsceneSource;
  private loops = 0;
  /** Element time at the last tick (detects the native loop's wrap-around). */
  private lastT = 0;
  private loopMode = false;
  private bedCache?: { key: string; buffer: AudioBuffer };
  private readonly onResize = () => this.layout();
  /** Counters of the current (or last) playback. */
  stats: PlayerStats = freshStats();

  constructor(private readonly opts: CutscenePlayerOptions = {}) {
    this.root = document.createElement('div');
    this.root.className = 'cutscene-layer';
    Object.assign(this.root.style, {
      inset: '0',
      background: '#000',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.disablePictureInPicture = true;
    Object.assign(this.video.style, { display: 'block', flex: 'none', objectFit: 'fill', background: '#000' });
    this.subtitleEl = document.createElement('div');
    Object.assign(this.subtitleEl.style, {
      position: 'absolute',
      left: '5%',
      right: '5%',
      bottom: '6%',
      textAlign: 'center',
      color: '#fff',
      font: '600 clamp(14px, 2.6vh, 28px) system-ui, sans-serif',
      textShadow: '0 0 4px #000, 0 2px 2px #000',
      whiteSpace: 'pre-line',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.subtitleCanvas = document.createElement('canvas');
    Object.assign(this.subtitleCanvas.style, { imageRendering: 'pixelated', maxWidth: '100%' });
    this.root.append(this.video, this.subtitleEl);
    (opts.container ?? document.body).append(this.root);
    window.addEventListener('resize', this.onResize);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** The layer's root element (e.g. to reorder it among menu layers). */
  get element(): HTMLElement {
    return this.root;
  }

  /** Playback position, seconds (continuous across loops). */
  get currentTime(): number {
    if (!this.playing) return 0;
    const len = this.video.duration;
    return (this.loopMode && Number.isFinite(len) ? this.loops * len : 0) + this.video.currentTime;
  }

  /** Picture duration of the current video, seconds. */
  get duration(): number {
    return this.current?.video.durationSec ?? 0;
  }

  /** Jumps to `seconds`. */
  seek(seconds: number): void {
    if (!this.playing) return;
    const len = this.video.duration;
    let t = Math.max(0, seconds);
    if (this.loopMode && Number.isFinite(len) && len > 0) {
      this.loops = Math.floor(t / len);
      t -= this.loops * len;
    } else if (Number.isFinite(len)) t = Math.min(t, Math.max(0, len - 0.05));
    this.stats.seeks++;
    this.video.currentTime = t;
    this.lastT = t;
  }

  /** Plays a cutscene; resolves when it ends, is skipped, or stop() is called. */
  async play(src: CutsceneSource, opts: CutscenePlayOptions = {}): Promise<CutsceneResult> {
    if (this.playing) this.stop();
    const t0 = performance.now();
    const stats = (this.stats = freshStats());
    const background = !!opts.background;
    const loop = opts.loop ?? background;
    const skippable = !background && (opts.skippable ?? true);
    const skipDelay = opts.skipDelay ?? 0.25;
    const volume = opts.volume ?? (background ? 0 : 1);
    const url = src.video.url;
    if (!url) {
      reportMissingMedia(`video ${src.video.info.key} not converted`);
      // Resolve on a later task so callers that loop over play() can't spin.
      return new Promise((r) => setTimeout(() => r('ended'), 0));
    }
    this.fit = opts.fit ?? (background ? 'cover' : 'contain');
    this.current = src;
    this.loops = 0;
    this.loopMode = loop;
    this.playing = true;

    const inBody = (this.opts.container ?? document.body) === document.body;
    Object.assign(this.root.style, {
      position: background && !inBody ? 'absolute' : 'fixed',
      zIndex: String(opts.zIndex ?? (background ? 0 : 1000)),
      cursor: background ? '' : 'none',
      pointerEvents: background ? 'none' : 'auto',
    });
    this.root.style.display = 'flex';
    this.showSubtitle('');

    const v = this.video;
    const sound = volume > 0 ? src.sound : null;
    const audible = sound?.mode === 'sync' && src.video.muxedAudio;
    v.loop = loop;
    v.muted = !audible;
    const level = () => Math.max(0, Math.min(1, volume * (this.opts.mixerVolume?.() ?? 1)));
    v.volume = level();
    if (v.getAttribute('src') !== url) v.src = url;
    this.layout();

    let result: CutsceneResult | undefined;
    let resolvePlay!: (r: CutsceneResult) => void;
    const promise = new Promise<CutsceneResult>((r) => (resolvePlay = r));
    let raf = 0;
    let vfc = 0;
    let bed: { node: AudioBufferSourceNode; gain: GainNode } | undefined;
    const onKey = (e: KeyboardEvent) => {
      // The cutscene is modal: keep keys away from the game while it plays.
      e.stopPropagation();
      if (!skippable || performance.now() - t0 < skipDelay * 1000) return;
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        done('skipped');
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!skippable || performance.now() - t0 < skipDelay * 1000) return;
      e.preventDefault();
      e.stopPropagation();
      done('skipped');
    };
    // Gamepad skip (buttons already held when the movie starts don't count).
    let padRaf = 0;
    if (skippable) {
      const nav = new GamepadNav();
      nav.reset();
      const pollPad = () => {
        padRaf = requestAnimationFrame(pollPad);
        const acts = nav.poll();
        if (performance.now() - t0 < skipDelay * 1000) return;
        if (acts.includes('accept') || acts.includes('back') || acts.includes('start')) done('skipped');
      };
      padRaf = requestAnimationFrame(pollPad);
    }
    if (!background) CutscenePlayer.modal++;
    const onEnded = () => done('ended');
    const onError = () => {
      console.warn(`cutscene ${src.video.info.key}: media error`, v.error?.message ?? v.error?.code);
      done('ended');
    };
    const done = (r: CutsceneResult) => {
      if (result) return;
      result = r;
      this.finish = undefined;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(padRaf);
      if (!background) CutscenePlayer.modal = Math.max(0, CutscenePlayer.modal - 1);
      if (vfc) v.cancelVideoFrameCallback?.(vfc);
      if (!background) {
        window.removeEventListener('keydown', onKey, true);
        this.root.removeEventListener('pointerdown', onClick);
      }
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
      try {
        bed?.node.stop();
      } catch {
        /* not started */
      }
      bed?.gain.disconnect();
      v.pause();
      const q = v.getVideoPlaybackQuality?.();
      if (q) stats.framesDropped = q.droppedVideoFrames;
      // Release the decoder unless the next play() reuses the same file right away.
      queueMicrotask(() => {
        if (!this.playing) {
          v.removeAttribute('src');
          v.load();
        }
      });
      this.root.style.display = 'none';
      this.showSubtitle('');
      this.playing = false;
      resolvePlay(r);
    };
    this.finish = done;
    if (!background) {
      window.addEventListener('keydown', onKey, true);
      this.root.addEventListener('pointerdown', onClick);
    }
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);

    // Start position (the element accepts currentTime before metadata and applies it once loaded).
    const startAt = Math.max(0, opts.startAt ?? 0);
    if (startAt > 0 || v.currentTime > 0) v.currentTime = startAt;

    // Presented-frame counting.
    if (v.requestVideoFrameCallback) {
      const onFrame = () => {
        if (result) return;
        if (!stats.framesShown) stats.startupMs = performance.now() - t0;
        stats.framesShown++;
        vfc = v.requestVideoFrameCallback!(onFrame);
      };
      vfc = v.requestVideoFrameCallback(onFrame);
    }

    try {
      await v.play();
    } catch (err) {
      if (result) return promise;
      // Autoplay with sound refused (no user gesture yet): play silently.
      if ((err as DOMException).name === 'NotAllowedError' && !v.muted) {
        console.warn('cutscene: autoplay with sound refused; playing silently');
        v.muted = true;
        try {
          await v.play();
        } catch (e2) {
          console.warn('cutscene: playback failed', e2);
          done('ended');
          return promise;
        }
      } else if ((err as DOMException).name !== 'AbortError') {
        console.warn('cutscene: playback failed', err);
        done('ended');
        return promise;
      } else return promise;
    }
    if (result) return promise;

    // Looping music bed (5:32): decoded separately, loops on its own.
    const ctx = this.opts.audioContext;
    if (sound?.mode === 'bed' && ctx) {
      void this.loadBed(ctx, sound).then((buffer) => {
        if (result || !buffer) return;
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        node.connect(gain).connect(this.opts.destination ?? ctx.destination);
        node.start(ctx.currentTime + 0.02, (this.currentTime % buffer.duration) || 0);
        bed = { node, gain };
      });
    }

    const pictureEnd = src.video.durationSec;
    const playStart = performance.now();
    let prevWall = 0;
    this.lastT = v.currentTime;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const m0 = performance.now();
      if (prevWall && m0 - prevWall > 40) stats.longTicks++;
      prevWall = m0;
      const t = v.currentTime;
      // A backwards jump not made by seek() is the native loop wrapping around.
      if (loop && t + 0.5 < this.lastT) this.loops++;
      this.lastT = t;
      if (audible) {
        const l = level();
        if (Math.abs(v.volume - l) > 1e-3) v.volume = l;
      }
      // Without sound, don't wait for a soundtrack that runs past the picture.
      if (!loop && !audible && t >= pictureEnd) {
        done('ended');
        return;
      }
      if (src.subtitles) {
        const cue = src.subtitles.find((c) => t >= c.start && t < c.end);
        this.showSubtitle(cue?.text ?? '');
      }
      if (!v.requestVideoFrameCallback) {
        const q = v.getVideoPlaybackQuality?.();
        if (q) stats.framesShown = q.totalVideoFrames - q.droppedVideoFrames;
        if (!stats.startupMs && t > 0) stats.startupMs = performance.now() - t0;
      }
      const el = (performance.now() - playStart) / 1000;
      if (el > 0) stats.fps = stats.framesShown / el;
      const dt = performance.now() - m0;
      stats.mainMs += dt;
      stats.mainMaxMs = Math.max(stats.mainMaxMs, dt);
    };
    raf = requestAnimationFrame(tick);
    return promise;
  }

  private async loadBed(ctx: AudioContext, sound: CutsceneSoundtrack): Promise<AudioBuffer | undefined> {
    if (this.bedCache?.key === sound.info.key) return this.bedCache.buffer;
    try {
      const buffer = await sound.load(ctx);
      this.bedCache = { key: sound.info.key, buffer };
      return buffer;
    } catch (err) {
      console.warn('cutscene: soundtrack unavailable:', err);
      return undefined;
    }
  }

  /** Skips the current cutscene (resolves play() with 'skipped'). */
  skip(): void {
    this.finish?.('skipped');
  }

  /** Stops playback (resolves play() with 'stopped'). */
  stop(): void {
    this.finish?.('stopped');
  }

  dispose(): void {
    this.stop();
    this.bedCache = undefined;
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  private layout(): void {
    const info = this.current?.video;
    const vw = info?.width || 512;
    const vh = info?.height || 512;
    const aspect = this.opts.aspect === 'native' ? vw / Math.max(1, vh) : (this.opts.aspect ?? 4 / 3);
    const box = this.root.style.position === 'absolute' ? this.root.getBoundingClientRect() : undefined;
    const w = box?.width || window.innerWidth;
    const h = box?.height || window.innerHeight;
    const cw = this.fit === 'cover' ? Math.max(w, h * aspect) : Math.min(w, h * aspect);
    this.video.style.width = `${Math.round(cw)}px`;
    this.video.style.height = `${Math.round(cw / aspect)}px`;
  }

  private lastSubtitle = '';
  private showSubtitle(text: string): void {
    if (text === this.lastSubtitle) return;
    this.lastSubtitle = text;
    const sf = this.opts.subtitleFont;
    if (!sf || !text) {
      this.subtitleEl.textContent = text;
      return;
    }
    // Bitmap-font subtitles: rasterise with the game's font atlas.
    const lay = layoutText(sf.font, text, { maxWidth: 600, align: 'center' });
    const c = this.subtitleCanvas;
    c.width = Math.max(1, lay.width);
    c.height = Math.max(1, lay.height);
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    for (const pg of lay.glyphs) {
      const a = sf.atlases[pg.glyph.page];
      if (!a) continue;
      for (let y = 0; y < pg.glyph.height; y++)
        for (let x = 0; x < pg.glyph.width; x++) {
          const dx = pg.x + x;
          const dy = pg.y + y;
          if (dx < 0 || dy < 0 || dx >= c.width || dy >= c.height) continue;
          const cov = a.rgba[((pg.glyph.y + y) * a.width + pg.glyph.x + x) * 4 + 3];
          const o = (dy * c.width + dx) * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
          img.data[o + 3] = Math.max(img.data[o + 3], cov);
        }
    }
    g.putImageData(img, 0, 0);
    c.style.height = `${Math.round(lay.height * 2)}px`;
    this.subtitleEl.replaceChildren(c);
  }
}

// ---------------------------------------------------------------------------
// Library

/** Reads the `id N` line of a package .db (the package id used in cross-file refs). */
export const parsePackageId = readDbId;

export interface LoadOptions {
  /** Play the soundtrack. Default true. */
  withAudio?: boolean;
  /** Throw MissingMediaError when the video has no converted file (default: return a source with url null). */
  requireMedia?: boolean;
}

/** The video has not been converted (`npm run bake`). */
export class MissingMediaError extends Error {
  constructor(readonly key: string) {
    super(`video ${key} has no converted file (run npm run bake)`);
    this.name = 'MissingMediaError';
  }
}

interface Container {
  path: string;
  read: RangeReader;
  entries: SrscEntry[];
}

/**
 * Builds cutscene sources from a GameFS plus its converted media. Only SRSC
 * directories, the small video/sound headers and the first 64 KB of an ASF
 * stream (when no converted duration is known) are read.
 */
export class CutsceneLibrary {
  private readonly containers = new Map<string, Promise<Container | null>>();
  private readonly pkgIds = new Map<string, Promise<number>>();
  private readonly videoLists = new Map<string, Promise<VideoInfo[]>>();
  private readonly durations = new Map<string, Promise<number>>();
  private readonly soundHeads = new Map<string, Promise<SoundInfo[]>>();
  private readonly samples = new SoundSamples();
  private pkgPaths?: Promise<Map<number, string>>;

  constructor(private readonly fs: GameFS) {}

  private open(path: string): Promise<Container | null> {
    let p = this.containers.get(path.toLowerCase());
    if (!p) {
      p = (async () => {
        const real = await this.fs.resolve(path);
        if (!real) return null;
        const read: RangeReader = (o, n) => this.fs.readRange(real, o, n);
        return { path: real, read, entries: await readSrscDirectory(read) };
      })();
      this.containers.set(path.toLowerCase(), p);
    }
    return p;
  }

  /** Package id from the .db next to a container (0 if missing). */
  packageId(containerPath: string): Promise<number> {
    const db = containerPath.replace(/\.[^./]+$/, '.db');
    let p = this.pkgIds.get(db);
    if (!p) {
      p = (async () => {
        const real = await this.fs.resolve(db);
        if (!real) return 0;
        return readDbId(new TextDecoder('latin1').decode(await this.fs.read(real))) ?? 0;
      })();
      this.pkgIds.set(db, p);
    }
    return p;
  }

  /** Every .vdu in the file system by package id. */
  private vduPaths(): Promise<Map<number, string>> {
    this.pkgPaths ??= (async () => {
      const files = (await this.fs.list()).filter((f) => /\.vdu$/i.test(f));
      const m = new Map<number, string>();
      await Promise.all(files.map(async (f) => m.set(await this.packageId(f), f)));
      return m;
    })();
    return this.pkgPaths;
  }

  private async resolveVdu(pkgOrPath: number | string): Promise<string> {
    if (typeof pkgOrPath === 'string' && !/^\d+$/.test(pkgOrPath)) return pkgOrPath;
    const path = (await this.vduPaths()).get(Number(pkgOrPath));
    if (!path) throw new Error(`cutscene: no .vdu for package ${pkgOrPath}`);
    return path;
  }

  /** Every video of every .vdu (for pickers / dev tools). */
  async catalog(): Promise<{ path: string; pkg: number; videos: VideoInfo[] }[]> {
    const paths = await this.vduPaths();
    const out = await Promise.all([...paths].map(async ([pkg, path]) => ({ path, pkg, videos: await this.list(path) })));
    return out.sort((a, b) => a.pkg - b.pkg);
  }

  /** Lists the videos of a .vdu (keys are "pkg:id"). */
  async list(pkgOrPath: number | string): Promise<VideoInfo[]> {
    const path = await this.resolveVdu(pkgOrPath);
    let p = this.videoLists.get(path);
    if (!p) {
      p = (async () => {
        const c = await this.open(path);
        if (!c) return [];
        const pkg = await this.packageId(path);
        const out = await Promise.all(
          pairVideoEntries(c.entries).map(async ([h, d]) => videoInfoFromHeader(new DataView(await c.read(h.offset, h.size)), h, d, pkg)),
        );
        return out.sort((a, b) => a.id - b.id);
      })();
      this.videoLists.set(path, p);
    }
    return p;
  }

  /** Picture duration in seconds: the converted file's, else the ASF header's. */
  private playDuration(c: Container, info: VideoInfo): Promise<number> {
    const k = `${c.path}#${info.id}`;
    let p = this.durations.get(k);
    if (!p) {
      p = (async () => {
        const conv = (await convertedMedia(this.fs))?.video(info.key);
        if (conv) return conv.duration;
        const head = new Uint8Array(await c.read(info.data.offset, Math.min(info.data.size, ASF_HEADER_PROBE)));
        return asfPlayDuration(head) ?? info.durationMs / 1000;
      })();
      this.durations.set(k, p);
    }
    return p;
  }

  /** Sound headers of the .sdu next to `vduPath` whose group is one of `groups` (only those are read). */
  private async sounds(vduPath: string, groups: Set<number>): Promise<SoundInfo[] | null> {
    const c = await this.open(vduPath.replace(/\.vdu$/i, '.sdu'));
    if (!c) return null;
    const pkg = await this.packageId(vduPath);
    const data = new Map<number, SrscEntry>();
    for (const e of c.entries) if (e.group === SDU_GROUP && e.type === SDU_DATA) data.set(e.id, e);
    const heads = c.entries.filter((e) => e.group === SDU_GROUP && e.type === SDU_HEADER && groups.has(e.extra));
    const sounds = await Promise.all(
      heads.map((e) => {
        const k = `${c.path}#${e.id}`;
        let p = this.soundHeads.get(k);
        if (!p) {
          p = c.read(e.offset, e.size).then((b) => [parseSoundHeader(new DataView(b), pkg, e.id, data.get(e.id), undefined, e.extra)]);
          this.soundHeads.set(k, p);
        }
        return p;
      }),
    );
    this.samples.mount(pkg, this.fs);
    return sounds.flat();
  }

  /** The soundtrack paired with video `id` (null for silent videos). */
  async soundtrackFor(pkgOrPath: number | string, id: number): Promise<CutsceneSoundtrack | null> {
    const path = await this.resolveVdu(pkgOrPath);
    const c = await this.open(path);
    if (!c) throw new Error(`cutscene: ${path} not found`);
    const videos = await this.list(path);
    const info = videos.find((v) => v.id === id);
    if (!info) throw new Error(`cutscene: video ${id} not in ${path}`);
    const sounds = await this.sounds(path, new Set([info.group]));
    if (!sounds?.length) return null;
    const peers = await Promise.all(
      videos
        .filter((v) => v.group === info.group)
        .map(async (v) => ({ id: v.id, group: v.group, durationSec: await this.playDuration(c, v) })),
    );
    const r = findSoundtrack(peers.find((v) => v.id === id)!, peers, sounds);
    return r && { info: r.sound, mode: r.mode, pairing: r.pairing, load: (ctx) => this.samples.load(ctx, r.sound) };
  }

  /**
   * Builds a playable source for video `id` of a package (id from its .db,
   * e.g. 5 = Interface) or .vdu path. The soundtrack plays unless `withAudio` is false.
   */
  async load(pkgOrPath: number | string, id: number, opts: LoadOptions | boolean = {}): Promise<CutsceneSource> {
    const withAudio = typeof opts === 'boolean' ? opts : (opts.withAudio ?? true);
    const path = await this.resolveVdu(pkgOrPath);
    const c = await this.open(path);
    if (!c) throw new Error(`cutscene: ${path} not found`);
    const info = (await this.list(path)).find((v) => v.id === id);
    if (!info) throw new Error(`cutscene: video ${id} not in ${path}`);
    const media = await convertedMedia(this.fs);
    const conv = media?.video(info.key);
    if (!conv && opts && typeof opts === 'object' && opts.requireMedia) throw new MissingMediaError(info.key);
    const [durationSec, sound, url] = await Promise.all([
      this.playDuration(c, info),
      withAudio ? this.soundtrackFor(path, id) : Promise.resolve(null),
      conv && media ? media.url(conv.file) : Promise.resolve(null),
    ]);
    const video: CutsceneVideo = {
      info,
      width: conv?.width ?? info.width,
      height: conv?.height ?? info.height,
      fps: info.fps,
      durationSec,
      url,
      muxedAudio: conv?.soundtrackMode === 'sync',
    };
    return { video, sound };
  }
}
