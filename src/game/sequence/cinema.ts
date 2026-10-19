// Cinematic presentation: the letterbox bars and the subtitle box of in-engine sequences.
//
// Letterbox (SUFFERING.EXE view manager, vtable 0x594940, object [0x5c5d7c]) [verified]:
//   * bars: frame end (0x48c729) calls 0x4b0b30, which, while the bars are on (+0x34), fills two
//     rectangles in the colour at +0x3c: (0, 0, width, h) and (0, height − h, width, height) with
//     h = ftol(height × size × 0.01), size the float at +0x38;
//   * size and colour: slot +0x14 (0x4b1480) stores them; Suffering.rfl calls it once at level
//     start (0x100b239f) with Level Properties p36 (size %) and p37 (colour), next to the lens
//     (p16, 0x100b2364). Every retail level inherits System 2:9: p36 = 10, p37 = 0 (black);
//   * on / off: slot +0x18 (0x4b14a0). A sequence with header flag 0x04 switches the bars on when
//     a control key takes the player and off when one releases it (0x450ea6); destroying the run
//     switches them off (0x44fa55). No fade: the flag is read every frame.
//   82 of the 186 retail sequences carry the flag (most cinematics, 1a "Goose" included); their
//   player track takes the player (mostly at 0 s) and releases it at the end
//   (tests/cinema.test.ts).
//
// Subtitle box (Interface 5:317 "Subtitle Textbox", User Interface Properties child; text
// 5:318 "Simple Text GUI") [verified data, tests/cinema.test.ts]:
//   box x centred, y 85.2 %, w 100 %, h 10 % of the 640×480 GUI screen; text 71 % wide,
//   10 % high, scale 0.9 × 0.91, white, centred; the default font (5:2).
// Paging (Suffering.rfl 0x10069d80 / 0x10069964) [verified arithmetic]: the line is wrapped to
//   the text width (L lines); with M = lines the text box holds, P = ceil(L / M) pages, the box
//   shows L / P lines per page (accumulated: 5 lines over 3 pages go 1, 2, 2), each line
//   holding the box for D / L seconds of the sound's duration D; the box closes D + 1 s after
//   the start (0x10069e79). M is not read here: 2 for this box (two lines of 22 × 0.91 GUI px
//   in its 48) [inferred from the box height; matches the two-line pages of the original].

/** Level Properties p36 / p37 defaults (System 2:9) [verified data]. */
export const LETTERBOX_SIZE = 10;
export const LETTERBOX_COLOR = 0x000000;

/** Height of one letterbox bar in pixels (0x4b0b30: ftol(height × size × 0.01)). */
export function letterboxBar(height: number, sizePercent = LETTERBOX_SIZE): number {
  return Math.max(0, Math.trunc(height * sizePercent * 0.01));
}

/** The level's letterbox size / colour from Level Properties values (p36 / p37). */
export function levelLetterbox(values: readonly unknown[] | undefined): { size: number; color: number } {
  const size = values?.[36];
  const color = values?.[37];
  return {
    size: typeof size === 'number' && size >= 0 && size < 50 ? size : LETTERBOX_SIZE,
    color: typeof color === 'number' ? color & 0xffffff : LETTERBOX_COLOR,
  };
}

/** GUI screen the subtitle box is laid out in (fitted 4:3 into the view, like the HUD). */
export const GUI_W = 640;
export const GUI_H = 480;

/** Interface 5:317 / 5:318 layout (percent of the GUI screen) [verified data]. */
export const SUBTITLE_BOX = {
  /** Box top / height (5:317 layout). */
  y: 85.2,
  h: 10,
  /** Text width / height (5:318 layout). */
  textW: 71,
  textH: 10,
  /** Font scale (5:318 text scale x / y). */
  scaleX: 0.9,
  scaleY: 0.91,
  /** Text colour (5:318 normal colour). */
  color: 0xffffff,
} as const;

/**
 * Vertical centre of the subtitle lines, in GUI px: the original's pages (one or two lines)
 * are centred on the same height, 88.2 % of the screen, inside the box's upper half [measured
 * from captures of the PC version; the text renderer's placement code was not traced].
 */
export const SUBTITLE_CENTRE_Y = 0.882 * GUI_H;

/** Lines a text box of `boxHeight` GUI px holds with lines of `lineHeight` px (≥ 1). */
export function subtitleMaxLines(lineHeight: number, boxHeight = (SUBTITLE_BOX.textH / 100) * GUI_H): number {
  return Math.max(1, Math.floor(boxHeight / Math.max(1e-6, lineHeight)));
}

/** One page of a subtitle: its first line, line count, start offset (s). */
export interface SubtitlePage {
  first: number;
  count: number;
  at: number;
}

/**
 * Pages of a subtitle of `lines` wrapped lines spoken over `duration` s, with `maxLines` per
 * box (Suffering.rfl 0x10069e16 setup, 0x10069964 per frame): P = ceil(L / M) pages; each step
 * adds L / P to an accumulator and shows one more line per whole unit in it (float compare
 * with a 0.001 tolerance, 0x10001ba0); each line shown adds D / L s before the next step.
 */
export function subtitlePages(lines: number, duration: number, maxLines: number): SubtitlePage[] {
  if (lines <= 0) return [];
  const m = Math.max(1, Math.floor(maxLines));
  const pages = Math.ceil(lines / m);
  const perPage = Math.fround(lines / pages);
  const perLine = Math.max(0, duration) / lines;
  const out: SubtitlePage[] = [];
  let acc = 0;
  let next = 0;
  let at = 0;
  while (next < lines) {
    acc = Math.fround(acc + perPage);
    const first = next;
    while (acc >= 1 - 0.001 && next < lines) {
      acc = Math.fround(acc - 1);
      next++;
    }
    if (next === first) {
      // Below one line this step (cannot happen with L / P ≥ 1); take one to make progress.
      next++;
    }
    out.push({ first, count: next - first, at });
    at += (next - first) * perLine;
  }
  return out;
}

/** The subtitle box closes this long after the sound's duration (0x10069e79: + 1.0). */
export const SUBTITLE_HOLD = 1;
