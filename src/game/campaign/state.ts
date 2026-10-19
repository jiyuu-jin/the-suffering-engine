// App-wide campaign state (one instance, like `saves`): what outlives a level and travels
// with the player. Saved with the game through the 'campaign' provider (scope 'game').

import type { ChapterInfo } from './chapters';
import { TransitionMailbox, type MailboxEntry } from './mailbox';

export type Ending = 'good' | 'neutral' | 'evil';

export interface TransitionRecord {
  /** Level the transition was taken in. */
  from: string;
  /** Target level path as stored in the Level Transition (engine path). */
  to: string;
  spawn: string;
  /** Level Transition uid. */
  uid: number;
  /** Chapter index after the transition. */
  chapter: number;
  at: number;
}

export interface CampaignSaveState {
  /** Index into User Interface Properties p83 (-1 = take the level's own, Level Properties p23). */
  chapter: number;
  mailbox: MailboxEntry[];
  ending?: Ending;
}

export class CampaignState {
  /** Current chapter index (forward only, see chapters.ts). */
  chapterIndex = -1;
  /** Chapter list of the Interface package (filled by the first level that loads). */
  chapters: ChapterInfo[] = [];
  readonly mailbox = new TransitionMailbox();
  /** Set when the ending's Game Finished launcher fires (from the reputation at that time). */
  ending: Ending | undefined;
  /** Transitions taken this session (debug / tests; not saved). */
  readonly history: TransitionRecord[] = [];
  /** Mailbox deliveries this session: level, "p0:p1", handler uid (debug / tests; not saved). */
  readonly deliveries: { level: string; key: string; handler: number }[] = [];

  get chapter(): ChapterInfo | undefined {
    return this.chapterIndex >= 0 ? this.chapters[this.chapterIndex] : undefined;
  }

  save(): CampaignSaveState {
    return { chapter: this.chapterIndex, mailbox: this.mailbox.save(), ending: this.ending };
  }

  load(d: Partial<CampaignSaveState> | undefined): void {
    this.chapterIndex = Number.isInteger(d?.chapter) ? (d!.chapter as number) : -1;
    this.mailbox.load(d?.mailbox);
    this.ending = d?.ending === 'good' || d?.ending === 'neutral' || d?.ending === 'evil' ? d.ending : undefined;
  }

  /** New Game. */
  reset(): void {
    this.chapterIndex = -1;
    this.mailbox.clear();
    this.ending = undefined;
  }
}

export const campaign = new CampaignState();
