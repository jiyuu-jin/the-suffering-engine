// Usage: npx tsx tools/dump.ts <file> [--png <outdir>] [--wav <outdir> [--id N]] [--quiet]
// Prints the SRSC directory of any Riot Engine container; per-extension
// handlers add format-specific output (add new ones to HANDLERS).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { readDbId } from '../src/formats/model';
import { decodeSound, encodeWav, indexSounds } from '../src/formats/sound';
import { SrscFile } from '../src/formats/srsc';
import { decodeTexture, formatName, readTextureHeader, readTextureNames, TEXTURE_ENTRY_TYPE } from '../src/formats/texture';
import { readFonts } from '../src/formats/font';
import { StringTable } from '../src/formats/strings';
import { asfPlayDuration, listVideos } from '../src/formats/video';
import { videoFrameRGBA } from './ffmpeg';
import { encodePng } from './png';
import { listSkinnedModels, readSkeleton } from '../src/formats/skeleton';
import { guessClipLabel, listAnimations, readAnimation, rootMotion } from '../src/formats/animation';

export interface DumpArgs {
  file: string;
  flags: Map<string, string | true>;
}

const hex = (n: number, w = 2) => '0x' + n.toString(16).padStart(w, '0');

function dumpDirectory(file: SrscFile, quiet: boolean): void {
  console.log(`SRSC version ${hex(file.version, 4)}, ${file.entries.length} entries`);
  if (!quiet) {
    console.log('  idx  type group     id  extra     offset       size');
    for (const e of file.entries) {
      console.log(
        `${String(e.index).padStart(5)} ${hex(e.type).padStart(5)} ${String(e.group).padStart(5)} ${String(e.id).padStart(6)} ${String(e.extra).padStart(6)} ${hex(e.offset, 8)} ${String(e.size).padStart(10)}`,
      );
    }
  }
  const hist = new Map<string, { count: number; bytes: number }>();
  for (const e of file.entries) {
    const k = `type ${hex(e.type)} group ${e.group}`;
    const h = hist.get(k) ?? { count: 0, bytes: 0 };
    h.count++;
    h.bytes += e.size;
    hist.set(k, h);
  }
  console.log('Type histogram:');
  for (const [k, h] of [...hist].sort()) console.log(`  ${k}: ${h.count} entries, ${h.bytes} bytes`);
}

function dumpTdu(file: SrscFile, args: DumpArgs): void {
  const names = readTextureNames(file);
  const formats = new Map<string, number>();
  const outDir = args.flags.get('--png');
  if (typeof outDir === 'string') mkdirSync(outDir, { recursive: true });
  const stem = basename(args.file, extname(args.file));
  let written = 0;
  console.log('Textures:');
  for (const e of file.byType(TEXTURE_ENTRY_TYPE)) {
    const h = readTextureHeader(file, e);
    const fmt = formatName(h);
    formats.set(fmt, (formats.get(fmt) ?? 0) + 1);
    const name = names.get(e.id)?.name;
    if (!args.flags.has('--quiet')) {
      console.log(
        `  id ${String(e.id).padStart(5)} ${String(h.width).padStart(4)}x${String(h.height).padEnd(4)} ${fmt.padEnd(6)} alpha ${h.alphaMode} flags ${hex(h.flags, 8)} scale ${h.scale}${name ? ` "${name}"` : ''}`,
      );
    }
    if (typeof outDir === 'string') {
      const t = decodeTexture(file, e, { name });
      if (!t) continue;
      writeFileSync(join(outDir, `${stem}_${e.id}${name ? '_' + name : ''}.png`), encodePng(t.width, t.height, t.rgba));
      written++;
    }
  }
  console.log('Formats: ' + [...formats].map(([k, v]) => `${k}=${v}`).join(' '));
  if (typeof outDir === 'string') console.log(`Wrote ${written} PNGs to ${outDir}`);
}

function dumpSdu(file: SrscFile, args: DumpArgs): void {
  const db = args.file.replace(/\.sdu$/i, '.db');
  const pkg = (existsSync(db) && readDbId(readFileSync(db, 'latin1'))) || 0;
  const sounds = indexSounds(file, pkg);
  const outDir = args.flags.get('--wav');
  const only = args.flags.get('--id');
  if (typeof outDir === 'string') mkdirSync(outDir, { recursive: true });
  const fmts = new Map<string, number>();
  const cats = new Map<string, number>();
  let seconds = 0;
  let written = 0;
  console.log(`Sounds (package ${pkg}):`);
  for (const s of sounds) {
    const fmt = `${s.codec} ${s.channels}ch ${s.sampleRate}Hz`;
    fmts.set(fmt, (fmts.get(fmt) ?? 0) + 1);
    cats.set(s.categoryName, (cats.get(s.categoryName) ?? 0) + 1);
    seconds += s.duration;
    if (!args.flags.has('--quiet')) {
      const extra = [
        s.loop ? 'loop' : '',
        s.subtitle ? `sub ${s.subtitle.pkg}:${s.subtitle.id}` : '',
        s.rumble ? `rumble ${s.rumble.pkg}:${s.rumble.id}` : '',
        s.lipsync ? 'lipsync' : '',
      ].filter(Boolean);
      console.log(
        `  ${s.key.padEnd(9)} ${s.categoryName.padEnd(9)} ${fmt.padEnd(20)} ${s.duration.toFixed(2).padStart(7)}s dist ${s.minDistance}-${s.maxDistance} vol ${s.volume.toFixed(2)} flags ${hex(s.flags, 5)} grp ${s.group} ${extra.join(' ')}`,
      );
    }
    if (typeof outDir === 'string' && (only === undefined || String(s.id) === only)) {
      writeFileSync(join(outDir, `${pkg}_${s.id}_${s.categoryName}.wav`), encodeWav(decodeSound(file, s)));
      written++;
    }
  }
  console.log(`${sounds.length} sounds, ${(seconds / 60).toFixed(1)} min`);
  console.log('Formats: ' + [...fmts].map(([k, v]) => `${k}=${v}`).join(', '));
  console.log('Categories: ' + [...cats].map(([k, v]) => `${k}=${v}`).join(' '));
  if (typeof outDir === 'string') console.log(`Wrote ${written} WAVs to ${outDir}`);
}

// .vdu: prints the catalog; --png <dir> writes sample frames through ffmpeg ($FFMPEG);
// --frames a,b,c picks frame indices (default: 4 evenly spaced); --id N limits to one video.
function dumpVdu(file: SrscFile, args: DumpArgs): void {
  const outDir = args.flags.get('--png');
  if (typeof outDir === 'string') mkdirSync(outDir, { recursive: true });
  const only = args.flags.get('--id');
  const pick = args.flags.get('--frames');
  const stem = basename(args.file, extname(args.file));
  console.log('Videos:');
  for (const info of listVideos(file)) {
    if (typeof only === 'string' && info.id !== Number(only)) continue;
    const entry = file.bytes(info.data);
    const dur = asfPlayDuration(entry) ?? info.durationMs / 1000;
    console.log(
      `  id ${String(info.id).padStart(4)} group ${String(info.group).padStart(4)} ${info.width}x${info.height} ${info.fps} fps, ${dur.toFixed(2)} s (~${Math.round(dur * info.fps)} frames), ${info.streamBytes} bytes`,
    );
    if (typeof outDir !== 'string') continue;
    const n = Math.round(dur * info.fps);
    const want = typeof pick === 'string' ? pick.split(',').map(Number) : [0, 1, 2, 3].map((k) => Math.floor(((k + 0.5) * n) / 4));
    const t0 = performance.now();
    for (const f of want) {
      const img = videoFrameRGBA(entry, f, info.width, info.height);
      writeFileSync(join(outDir, `${stem}_${info.id}_f${f}.png`), encodePng(img.width, img.height, img.rgba));
    }
    console.log(`    wrote ${want.length} PNGs in ${(performance.now() - t0).toFixed(0)} ms`);
  }
}

/** Skinned models (type 8 skeletons); `--bones <id>` prints one hierarchy. */
function dumpMdu(file: SrscFile, args: DumpArgs): void {
  const models = listSkinnedModels(file);
  console.log(`Skinned models: ${models.length}`);
  for (const m of models) console.log(`  model ${String(m.id).padStart(5)} animSet ${String(m.animSet).padStart(5)} bones ${String(m.bones).padStart(3)} vertices ${m.vertices}`);
  const one = args.flags.get('--bones');
  if (typeof one === 'string') {
    const sk = readSkeleton(file, Number(one));
    if (!sk) return console.log(`model ${one}: no skeleton`);
    const depth = (i: number): number => (sk.bones[i].parent < 0 ? 0 : 1 + depth(sk.bones[i].parent));
    for (const b of sk.bones) {
      const p = b.position.map((x) => x.toFixed(3)).join(' ');
      console.log(`  ${'  '.repeat(depth(b.index))}${b.index} ${b.name} pos (${p})`);
    }
  }
}

/** Animation clips; `--set <animSet>` filters by animation-set id. */
function dumpAdu(file: SrscFile, args: DumpArgs): void {
  const set = args.flags.get('--set');
  const list = listAnimations(file, typeof set === 'string' ? Number(set) : undefined);
  console.log(`Clips: ${list.length}`);
  console.log('     id   set   dur   flags tracks keys  root motion (x y z)   label');
  for (const c of list) {
    const clip = readAnimation(file, c.id);
    if (!clip) continue;
    const keys = clip.tracks.reduce((n, t) => n + t.times.length, 0);
    const rm = rootMotion(clip).map((x) => x.toFixed(2).padStart(6)).join(' ');
    console.log(
      `  ${String(c.id).padStart(5)} ${String(c.animSet).padStart(5)} ${c.duration.toFixed(2).padStart(5)} ${String(c.flags).padStart(5)} ${String(clip.tracks.length).padStart(6)} ${String(keys).padStart(5)}  ${rm}   ${guessClipLabel(clip)}`,
    );
  }
}

function dumpFdu(file: SrscFile): void {
  for (const f of readFonts(file)) {
    const pages = f.textures.map((t) => `${t.pkg}:${t.id}`).join(', ');
    console.log(
      `Font id ${f.id}: line height ${f.lineHeight}, baseline ${f.baseline}, ${f.glyphs.size} glyphs, ${f.rows.length} rows, atlases [${pages}]`,
    );
    const chars = [...f.glyphs.keys()].sort((a, b) => a - b);
    console.log('  chars: ' + String.fromCharCode(...chars).replace(/[\x00-\x1f]/g, '·'));
  }
}

// .xdu: prints every string (--quiet: counts only).
function dumpXdu(file: SrscFile, args: DumpArgs): void {
  const t = new StringTable(file);
  const groups = new Set([...t.entries.values()].map((s) => s.group));
  console.log(`Strings: ${t.entries.size} in ${groups.size} groups`);
  if (args.flags.has('--quiet')) return;
  for (const s of [...t.entries.values()].sort((a, b) => a.id - b.id))
    console.log(`  ${String(s.id).padStart(5)} [${s.group}] ${JSON.stringify(s.text)}`);
}

// .qdu: keyframed animation sequences (camera paths / scripted object motion).
function dumpQdu(file: SrscFile): void {
  console.log('Sequences (type 0x11): f32 at +4, u32 at +12, first track name:');
  for (const e of file.entries) {
    if (e.type !== 0x11 || e.size < 20) continue;
    const v = file.data(e);
    const n = v.getUint16(16, true);
    const name = n < 64 && 18 + n <= e.size ? String.fromCharCode(...file.bytes(e).subarray(18, 18 + n)) : '?';
    console.log(`  id ${String(e.id).padStart(4)} group ${String(e.extra).padStart(4)} ${String(e.size).padStart(6)} bytes  f32@4 ${v.getFloat32(4, true)}  u32@12 ${v.getUint32(12, true)}  "${name}"`);
  }
}

/** Extension-specific handlers, run after the generic directory dump. */
const HANDLERS: Record<string, (file: SrscFile, args: DumpArgs) => void> = {
  '.tdu': dumpTdu,
  '.mdu': dumpMdu,
  '.adu': dumpAdu,
  '.vdu': dumpVdu,
  '.fdu': dumpFdu,
  '.xdu': dumpXdu,
  '.qdu': dumpQdu,
  '.sdu': dumpSdu,
};

function parseArgs(argv: string[]): DumpArgs {
  const flags = new Map<string, string | true>();
  let file = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && a !== '--quiet') {
        flags.set(a, next);
        i++;
      } else flags.set(a, true);
    } else if (!file) file = a;
  }
  return { file, flags };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: npx tsx tools/dump.ts <file> [--png <outdir>] [--wav <outdir> [--id N]] [--quiet]');
    process.exit(1);
  }
  const buf = readFileSync(args.file);
  const file = new SrscFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  dumpDirectory(file, args.flags.has('--quiet'));
  HANDLERS[extname(args.file).toLowerCase()]?.(file, args);
}

main();
