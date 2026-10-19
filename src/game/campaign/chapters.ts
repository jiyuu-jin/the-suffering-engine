// Chapters (User Interface Properties p83: 21 Chapter Properties templates, Interface pkg 5).
//
// A chapter is { p0 title string, p1 Progress GUI (loading screen: p18 Screen Background,
// p16 progress meter) }. The engine tracks the current chapter as an index into the p83
// list (RFL global 0x10178660):
//
//   * New Game resets it to -1 (0x10062274); when a level starts with -1 it takes the
//     level's own chapter, Level Properties p23 (0x100b24d0).
//   * A Level Transition names a chapter in its p3. The index only moves forward: the
//     transition updates it when the named chapter comes later in the list (0x100bc5f0,
//     called from the transition handler 0x100c2812). Going back to an earlier level keeps
//     the later chapter.
//   * The loading screen shown for a transition is the current chapter's Progress GUI
//     (0x100c2849 / 0x100bc570), so it is the newest chapter reached, not the one named by
//     a backtracking transition (those have no p3).
//   * The title is not displayed on entering a chapter: the only reader of Chapter
//     Properties p0 is the Load / Save GUI (save names, 0x1005f364). The chapter's loading
//     screen artwork carries its title and quote.
//   * Loading a save restores the index from the save (0x10062530).

import { decodeTemplateProps, classByHash, readObjectTemplate, type EntityPackageSet } from '../../formats/entities';
import { findUiPropertiesTemplate } from '../../formats/gui';
import type { ResRef } from '../../formats/model';

export interface ChapterInfo {
  index: number;
  /** Chapter Properties template "pkg:id" (what Level Transition p3 / Level Properties p23 name). */
  template: string;
  /** Title string "pkg:id" (Chapter Properties p0). */
  title?: string;
  /** Progress GUI "pkg:id" (Chapter Properties p1). */
  loadingScreen?: string;
  /** Loading-screen picture tiles (Progress GUI p18 Screen Background p0..p5, "pkg:id"). */
  tiles: (string | undefined)[];
}

const key = (r: unknown): string | undefined => (r && typeof r === 'object' && 'pkg' in (r as object) ? `${(r as ResRef).pkg}:${(r as ResRef).id}` : undefined);
const refOf = (k: string): ResRef => {
  const [pkg, id] = k.split(':').map(Number);
  return { pkg, id };
};

function props(pkgs: EntityPackageSet, r: ResRef | string | undefined): unknown[] {
  if (!r) return [];
  const t = readObjectTemplate(pkgs, typeof r === 'string' ? refOf(r) : r);
  return t ? decodeTemplateProps(classByHash(t.classHash), t) : [];
}

/** The chapter list from the Interface package (empty when it isn't loaded). */
export function readChapters(pkgs: EntityPackageSet | undefined): ChapterInfo[] {
  if (!pkgs) return [];
  const uip = findUiPropertiesTemplate(pkgs);
  if (!uip) return [];
  const list = props(pkgs, uip)[83];
  if (!Array.isArray(list)) return [];
  return list.map((r, index) => {
    const template = key(r) ?? '';
    const p = props(pkgs, template || undefined);
    const loadingScreen = key(p[1]);
    const bg = key(props(pkgs, loadingScreen)[18]);
    const tiles = props(pkgs, bg)
      .slice(0, 6)
      .map((x) => key(x));
    return { index, template, title: key(p[0]), loadingScreen, tiles };
  });
}

/** Index of a Chapter Properties ref in the list (-1 when absent). */
export function chapterIndexOf(chapters: readonly ChapterInfo[], ref: ResRef | string | null | undefined): number {
  const k = typeof ref === 'string' ? ref : key(ref);
  return k ? chapters.findIndex((c) => c.template === k) : -1;
}

/** The engine's forward-only update: the named chapter replaces `current` only when later. */
export function advanceChapter(current: number, next: number): number {
  return next > current ? next : current;
}
