// Archives viewer (UIP 16, GUI Archives #463; docs/frontend.md §8 "Archives").
//
// What the data says an entry is: the Archives hold two Archive Sets (Clem's notebook,
// Consuela's journal: 15 and 18 Archive Pages). Every page is a full-screen PICTURE of a book
// page drawn as 3 x 2 tiles of 256 px at native size in the 640x480 space (2.5 x 1.875 tiles
// visible), in two versions: p0 the blank page shown while the page is locked (the set's "page
// locked" text p2 is drawn on it) and p1 the written page. An unlocked page also has a
// NARRATION sound (p2) read when it is shown. There is no separate text, image or video entry
// type: pictures + narration only. The set's p0 videos are 0.4 s clips played when the page
// turns (random pick, duplicates weight [guess]); p5 are page-turn sounds, p6 / p7 single sounds
// played when a set opens / closes [guess].
//
// Unlocks: Archives Trigger objects in the levels (6 in chapter 1) name a set and pages; the
// unlocked page refs are kept by the profile (./profile.ts), across games.
//
// Input: Left / Right turn pages, Up / Down switch sets, Enter replays the narration, Esc
// closes (the footer string). Clicking the left / right half turns pages.

import type { AudioSystem } from '../../audio';
import type { SoundHandle } from '../../audio';
import type { ArchivesSpec, ArchiveSetSpec, CustomScreen, CustomUi, NavInput, Rect, VideoRef } from '../model';
import { profile } from '../profile';

export interface ArchivesHost {
  audio: AudioSystem;
  /** Plays a page-turn clip in the background layer (resolves when done; may be absent). */
  playClip?(ref: VideoRef): Promise<void>;
  /** Interface left / right arrow textures. */
  arrows: { left?: number; right?: number };
}

const TILE = 256;

export class ArchivesScreen implements CustomScreen {
  readonly opaque = true;
  private set = 0;
  private page = 0;
  private turning = false;
  private turnStarted = 0;
  private narration?: SoundHandle;
  private loadToken = 0;
  private hoverSide = 0;

  constructor(
    private readonly spec: ArchivesSpec,
    private readonly host: ArchivesHost,
  ) {}

  private get cur(): ArchiveSetSpec {
    return this.spec.sets[this.set];
  }

  open(ui: CustomUi): void {
    this.turning = false;
    // Start on the first unlocked page of the first set that has one.
    const s = this.spec.sets.findIndex((st) => st.pages.some((p) => profile.isUnlocked(p.ref)));
    this.set = Math.max(0, s);
    this.page = Math.max(0, this.cur.pages.findIndex((p) => profile.isUnlocked(p.ref)));
    this.playOne(this.cur.openSounds);
    void this.preload(ui).then(() => this.narrate());
  }

  close(): void {
    this.stopNarration();
    this.loadToken++;
    this.playOne(this.spec.closeSounds.length ? this.spec.closeSounds : this.cur.closeSounds);
  }

  private playOne(keys: string[]): void {
    if (!keys.length || this.host.audio.context.state !== 'running') return;
    try {
      this.host.audio.play(keys[Math.floor(Math.random() * keys.length)], { bus: 'sfx' });
    } catch {
      /* sound bank missing */
    }
  }

  private stopNarration(): void {
    this.narration?.stop(0.15);
    this.narration = undefined;
  }

  private narrate(): void {
    this.stopNarration();
    const pg = this.cur.pages[this.page];
    if (!pg?.narration || !profile.isUnlocked(pg.ref) || this.host.audio.context.state !== 'running') return;
    try {
      this.narration = this.host.audio.play(pg.narration, { bus: 'voice' });
    } catch {
      /* sound missing */
    }
  }

  /** Loads the current page's tiles (and its neighbours'). */
  private async preload(ui: CustomUi): Promise<void> {
    const token = ++this.loadToken;
    const pages = this.cur.pages;
    const ids = (i: number) => {
      const p = pages[i];
      if (!p) return [];
      return (profile.isUnlocked(p.ref) ? p.tiles : p.lockedTiles).filter((x): x is number => x !== undefined);
    };
    await ui.loadImages(ids(this.page));
    if (token !== this.loadToken) return;
    void ui.loadImages([...ids(this.page + 1), ...ids(this.page - 1)]);
  }

  private async turn(ui: CustomUi, set: number, page: number): Promise<void> {
    if (this.turning) return;
    const sets = this.spec.sets;
    set = (set + sets.length) % sets.length;
    const n = sets[set].pages.length;
    page = ((page % n) + n) % n;
    if (set === this.set && page === this.page) return;
    this.stopNarration();
    this.turning = true;
    this.turnStarted = performance.now();
    if (set !== this.set) this.playOne(sets[set].openSounds);
    this.playOne(sets[set].turnSounds);
    const clips = sets[set].turnVideos;
    this.set = set;
    this.page = page;
    const load = this.preload(ui);
    try {
      if (clips.length && this.host.playClip) await this.host.playClip(clips[Math.floor(Math.random() * clips.length)]);
      else await new Promise((r) => setTimeout(r, 250));
      await load;
    } finally {
      this.turning = false;
    }
    this.narrate();
  }

  nav(ui: CustomUi, a: NavInput): boolean {
    switch (a) {
      case 'left':
        void this.turn(ui, this.set, this.page - 1);
        return true;
      case 'right':
        void this.turn(ui, this.set, this.page + 1);
        return true;
      case 'up':
      case 'down': {
        // Another set: open it on its first unlocked page.
        const sets = this.spec.sets;
        if (sets.length < 2) return true;
        const s = (this.set + (a === 'up' ? -1 : 1) + sets.length) % sets.length;
        void this.turn(ui, s, Math.max(0, sets[s].pages.findIndex((p) => profile.isUnlocked(p.ref))));
        return true;
      }
      case 'accept':
        this.narrate();
        return true;
      default:
        return false;
    }
  }

  click(ui: CustomUi, index: number): void {
    if (index === 0) void this.turn(ui, this.set, this.page - 1);
    else if (index === 1) void this.turn(ui, this.set, this.page + 1);
  }

  hover(_ui: CustomUi, index: number): void {
    this.hoverSide = index;
  }

  draw(ui: CustomUi, time: number): void {
    const ctx = ui.ctx;
    const set = this.cur;
    const pg = set.pages[this.page];
    // Black behind everything (the page art has black margins); transparent while a clip plays.
    if (!this.turning) {
      ctx.fillStyle = '#000';
      ctx.fillRect(-2000, -2000, 4640, 4480);
    } else {
      // Fade the old page out quickly so the clip shows.
      const k = Math.min(1, (performance.now() - this.turnStarted) / 120);
      ctx.fillStyle = `rgba(0,0,0,${1 - k})`;
      ctx.fillRect(-2000, -2000, 4640, 4480);
      return;
    }
    const unlocked = !!pg && profile.isUnlocked(pg.ref);
    if (pg) {
      const tiles = unlocked ? pg.tiles : pg.lockedTiles;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 640, 480);
      ctx.clip();
      tiles.forEach((id, i) => {
        const c = id !== undefined ? ui.image(id) : undefined;
        // +0.5 overlap hides the seams between scaled tiles.
        if (c) ctx.drawImage(c, (i % 3) * TILE, Math.floor(i / 3) * TILE, TILE + 0.5, TILE + 0.5);
      });
      ctx.restore();
    }
    if (set.title) ui.placedText(set.title.place, ui.label(set.title.label), set.title.place.colors.normal);
    if (!unlocked && set.locked) ui.placedText(set.locked.place, ui.label(set.locked.label), set.locked.place.colors.normal);
    // Page counter and turn arrows (engine addition; the original's page indicator is not decoded).
    const n = set.pages.length;
    ui.text('ui', `${this.page + 1} / ${n}`, 626, 10, { align: 'right', color: '#a0a0a0', scale: 0.75, alpha: 0.85 });
    const bob = Math.sin(time * 6) * 1.5;
    const arrow = (id: number | undefined, x: number, side: number) => {
      const c = id !== undefined ? ui.image(id) : undefined;
      const a = this.hoverSide === side ? 1 : 0.7;
      if (c) {
        ctx.save();
        ctx.globalAlpha *= a;
        ctx.drawImage(c, x + (side === 0 ? -bob : bob), 232, 16, 16);
        ctx.restore();
      }
    };
    arrow(this.host.arrows.left, 10, 0);
    arrow(this.host.arrows.right, 614, 1);
    const left: Rect = { x: 0, y: 40, w: 160, h: 380 };
    const right: Rect = { x: 480, y: 40, w: 160, h: 380 };
    ui.hit(0, left);
    ui.hit(1, right);
    if (this.spec.footer) ui.placedText(this.spec.footer.place, ui.label(this.spec.footer.label), this.spec.footer.place.colors.normal);
  }
}
