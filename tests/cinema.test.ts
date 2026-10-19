// Cinematic presentation constants (src/game/sequence/cinema.ts): letterbox bars, subtitle box
// layout and paging. Pure checks, plus data checks against a local install (skipped without one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import {
  letterboxBar,
  levelLetterbox,
  LETTERBOX_COLOR,
  LETTERBOX_SIZE,
  SUBTITLE_BOX,
  SUBTITLE_HOLD,
  subtitleMaxLines,
  subtitlePages,
} from '../src/game/sequence/cinema';
import { wrapLines } from '../src/game/sequence/subtitles';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackage, type EntityPackageSet } from '../src/formats/entities';
import { readDbId } from '../src/formats/model';
import { readFrontEnd } from '../src/formats/gui';
import { readFonts } from '../src/formats/font';
import { decodeStompSequence, QDU_SEQUENCE, SEQ_CINEMATIC, SEQ_LETTERBOX } from '../src/game/world/stomp';

test('letterbox bars: ftol(height × size %) each, level defaults 10 % black', () => {
  assert.equal(letterboxBar(720), 72);
  assert.equal(letterboxBar(1080, 10), 108);
  assert.equal(letterboxBar(583, 10), 58);
  assert.equal(letterboxBar(480, 0), 0);
  assert.deepEqual(levelLetterbox(undefined), { size: LETTERBOX_SIZE, color: LETTERBOX_COLOR });
  const v: unknown[] = [];
  v[36] = 12.5;
  v[37] = 0x102030;
  assert.deepEqual(levelLetterbox(v), { size: 12.5, color: 0x102030 });
});

test('subtitle pages: ceil(L / M) pages, L / P lines each (accumulated), D / L s per line', () => {
  assert.deepEqual(subtitlePages(0, 3, 2), []);
  assert.deepEqual(subtitlePages(1, 3, 2), [{ first: 0, count: 1, at: 0 }]);
  assert.deepEqual(subtitlePages(2, 4, 2), [{ first: 0, count: 2, at: 0 }]);
  // 6 lines, 2 per box: 3 pages of 2, each 1/3 of the time.
  const six = subtitlePages(6, 12, 2);
  assert.deepEqual(six.map((p) => p.count), [2, 2, 2]);
  assert.deepEqual(six.map((p) => p.at), [0, 4, 8]);
  // 5 lines over 3 pages: 1.67 per step -> 1, 2, 2.
  const five = subtitlePages(5, 10, 2);
  assert.deepEqual(five.map((p) => p.count), [1, 2, 2]);
  assert.deepEqual(five.map((p) => p.first), [0, 1, 3]);
  assert.deepEqual(five.map((p) => p.at), [0, 2, 6]);
  // 3 lines: 1.5 per step -> 1, 2.
  assert.deepEqual(subtitlePages(3, 6, 2).map((p) => p.count), [1, 2]);
  assert.equal(SUBTITLE_HOLD, 1);
  // Two lines of the default font (22 px) at scale 0.91 fit the 48 px text box.
  assert.equal(subtitleMaxLines(22 * SUBTITLE_BOX.scaleY), 2);
  assert.equal(subtitleMaxLines(40), 1);
});

test('subtitle wrap: greedy by words at the width, newlines kept', () => {
  const m = (s: string) => s.length;
  assert.deepEqual(wrapLines('aa bb cc dd', 5, m), ['aa bb', 'cc dd']);
  assert.deepEqual(wrapLines('aa bb\ncc', 20, m), ['aa bb', 'cc']);
  assert.deepEqual(wrapLines('averyveryverylongword x', 5, m), ['averyveryverylongword', 'x']);
});

function systemAndInterface(): Map<number, EntityPackage> {
  const pkgs = new Map<number, EntityPackage>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if ((id !== 2 && id !== 5) || pkgs.has(id)) continue;
    pkgs.set(id, { id, name: id === 2 ? 'System' : 'Interface', odu: readSrsc(db.slice(0, -3) + '.odu') } as EntityPackage);
  }
  return pkgs;
}

test('data: Level Properties (System 2:9) p36 / p37 are the letterbox size and colour', { skip }, () => {
  const pkgs = systemAndInterface() as EntityPackageSet;
  const t = readObjectTemplate(pkgs, { pkg: 2, id: 9 })!;
  const cls = classByHash(t.classHash);
  assert.equal(cls?.name, 'Level Properties');
  const v = decodeTemplateProps(cls!, t);
  assert.equal(v[16], 53, 'p16 lens (set next to the letterbox, Suffering.rfl 0x100b2364)');
  assert.equal(v[36], LETTERBOX_SIZE);
  assert.equal(v[37], LETTERBOX_COLOR);
});

test('data: the subtitle box template (Interface 5:317 / 5:318) matches SUBTITLE_BOX', { skip }, () => {
  const iface = allFiles().find((f) => /interface\/interface\.odu$/i.test(f));
  const system = allFiles().find((f) => /system\/system\.odu$/i.test(f));
  const fe = readFrontEnd(new Map([[5, { odu: readSrsc(iface!) }], [2, { odu: readSrsc(system!) }]]) as never);
  const box = fe.hud?.subtitles;
  assert.ok(box?.layout, 'subtitle box');
  assert.equal(box!.className, 'Subtitle Textbox');
  assert.ok(Math.abs(box!.layout!.y - SUBTITLE_BOX.y) < 1e-4);
  assert.equal(box!.layout!.h, SUBTITLE_BOX.h);
  const text = Object.values(box!.children ?? {})[0];
  assert.equal(text?.className, 'Simple Text GUI');
  assert.equal(text!.layout!.w, SUBTITLE_BOX.textW);
  assert.equal(text!.layout!.h, SUBTITLE_BOX.textH);
  const p = text!.props as Record<string, number>;
  assert.ok(Math.abs(p.scaleX - SUBTITLE_BOX.scaleX) < 1e-6 && Math.abs(p.scaleY - SUBTITLE_BOX.scaleY) < 1e-6);
  assert.equal(p.color, SUBTITLE_BOX.color);
  // The default font's line height gives two lines per box.
  const fdu = allFiles().find((f) => /interface\/interface\.fdu$/i.test(f));
  const font = readFonts(readSrsc(fdu!), 5).find((f) => f.id === 2);
  assert.ok(font);
  assert.equal(subtitleMaxLines(font!.lineHeight * SUBTITLE_BOX.scaleY), 2);
});

test('data: chapter 1 cinematics mostly carry the letterbox flag; flagged ones take the player', { skip }, () => {
  const qdu = filesWithExt('.qdu').find((f) => /1 PrisonDeathRow\.qdu$/i.test(f));
  assert.ok(qdu);
  const file = readSrsc(qdu!);
  let cinematic = 0, letterboxed = 0, goose = false;
  for (const e of file.entries) {
    if (e.type !== QDU_SEQUENCE) continue;
    const seq = decodeStompSequence(file.data(e), e.id);
    if (!(seq.flags & SEQ_CINEMATIC)) continue;
    cinematic++;
    if (!(seq.flags & SEQ_LETTERBOX)) continue;
    letterboxed++;
    if (seq.tracks[0]?.name === 'Goose') goose = true;
    const torque = seq.tracks.find((t) => t.name === 'Torque');
    if (torque) assert.ok(torque.controls.some((c) => !c.release), `#${e.id} takes the player`);
  }
  assert.ok(goose, 'the opening ("Goose") is letterboxed');
  assert.ok(letterboxed > cinematic / 2, `${letterboxed} of ${cinematic}`);
});
