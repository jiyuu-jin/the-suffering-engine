// Front-end video playback on top of the public CutscenePlayer /
// CutsceneLibrary API (src/app/cutscene.ts): skippable full-screen movies, the
// looping menu background and menu transition clips. All cutscene API use is
// kept in this file.

import type { GameFS } from '../gamefs';
import { CutsceneLibrary, CutscenePlayer, MissingMediaError, type CutsceneResult, type CutsceneSource } from '../cutscene';
import type { Font, FontAtlas } from '../../formats/font';
import type { VideoRef } from './model';

export class FrontEndVideos {
  readonly lib: CutsceneLibrary;
  private movie?: CutscenePlayer;
  private bg?: CutscenePlayer;
  private bgRun = 0;
  private bgSeq = 0;

  constructor(
    fs: GameFS,
    private readonly audioContext: AudioContext,
    private readonly bgContainer: HTMLElement,
    private readonly subtitleFont?: { font: Font; atlases: FontAtlas[] },
    /** Mixer level for movie soundtracks (e.g. master x music bus gain), read live. */
    private readonly mixerVolume?: () => number,
  ) {
    this.lib = new CutsceneLibrary(fs);
  }

  private load(ref: VideoRef, withAudio: boolean): Promise<CutsceneSource> {
    return this.lib.load(`${ref.container}.vdu`, ref.id, { withAudio, requireMedia: true });
  }

  private safeLoad(ref: VideoRef, withAudio: boolean): Promise<CutsceneSource | null> {
    return this.load(ref, withAudio).catch((err) => {
      // Missing converted media was already reported once (media.ts); stay quiet per video.
      if (!(err instanceof MissingMediaError)) console.warn('[menu] video unavailable:', ref, err);
      return null;
    });
  }

  get moviePlaying(): boolean {
    return !!this.movie?.isPlaying;
  }

  /**
   * Plays a full-screen movie with its soundtrack (at `volume` x mixerVolume(), so the
   * mixer's levels apply; skippable with
   * Esc/Space/Enter/click or a gamepad button). Resolves 'missing' if the
   * video can't be loaded.
   */
  async playMovie(ref: VideoRef, opts: { volume?: number; subtitles?: boolean } = {}): Promise<CutsceneResult | 'missing'> {
    let src = await this.safeLoad(ref, true);
    if (!src) return 'missing';
    this.movie ??= new CutscenePlayer({ audioContext: this.audioContext, mixerVolume: this.mixerVolume, subtitleFont: this.subtitleFont });
    const player = this.movie;
    if (opts.subtitles === false) src = { ...src, subtitles: undefined };
    // Keyboard, mouse and gamepad skipping are handled by the player.
    return await player.play(src, { volume: opts.volume ?? 1, skipDelay: 0.4 });
  }

  stopMovie(): void {
    this.movie?.stop();
  }

  /**
   * Starts the menu background: refs[0] first, then random picks from the
   * whole list (duplicates act as weights), as the game does.
   */
  startBackground(refs: VideoRef[]): void {
    if (!refs.length || this.bgRun) return;
    const run = ++this.bgSeq;
    this.bgRun = run;
    this.bg ??= new CutscenePlayer({ container: this.bgContainer, audioContext: this.audioContext });
    const player = this.bg;
    const pick = () => refs[Math.floor(Math.random() * refs.length)];
    const single = new Set(refs.map((r) => r.id)).size === 1;
    void (async () => {
      let next = this.safeLoad(refs[0], false);
      let failures = 0;
      while (this.bgRun === run) {
        const src = await next;
        if (this.bgRun !== run) return;
        next = this.safeLoad(pick(), false);
        if (!src) {
          if (++failures >= refs.length * 2) return;
          continue;
        }
        // Background mode: no input handling, pointer-events none, silent (ambience plays separately).
        const r = await player.play(src, { background: true, loop: single, fit: 'cover', zIndex: 0 });
        if (r === 'stopped' || this.bgRun !== run) return;
      }
    })();
  }

  stopBackground(): void {
    this.bgRun = 0;
    this.bg?.stop();
  }

  private loopPlayer?: CutscenePlayer;

  /**
   * Plays a looping video with its soundtrack in the background layer (the credits video and
   * its music bed), replacing the menu background until stopLoop().
   */
  async playLoop(ref: VideoRef): Promise<void> {
    this.stopBackground();
    const src = await this.safeLoad(ref, true);
    if (!src) return;
    this.loopPlayer ??= new CutscenePlayer({ container: this.bgContainer, audioContext: this.audioContext, mixerVolume: this.mixerVolume });
    void this.loopPlayer.play(src, { background: true, loop: true, fit: 'cover', zIndex: 0, volume: 1 });
  }

  stopLoop(): void {
    this.loopPlayer?.stop();
  }

  /** Plays a clip once in the background layer (menu transition), replacing the loop. */
  async playTransition(ref: VideoRef): Promise<void> {
    this.stopBackground();
    const src = await this.safeLoad(ref, false);
    if (!src) return;
    this.bg ??= new CutscenePlayer({ container: this.bgContainer, audioContext: this.audioContext });
    await this.bg.play(src, { background: true, loop: false, fit: 'cover', zIndex: 0 });
  }
}
