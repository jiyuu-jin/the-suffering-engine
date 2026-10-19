// npm run bake [-- options]
//
// One-time offline conversion of the game's media into browser-native files
// (format notes: src/formats/converted.ts):
//   .vdu videos (WMV2 in ASF)  -> <out>/video/<pkg>/<id>.mp4  H.264 + paired soundtrack (AAC)
//   .sdu sounds (raw PCM16)    -> <out>/audio/<pkg>/<id>.m4a  AAC-LC
//   <out>/manifest.json         keys "pkg:id" -> file, duration, ...
// The app keeps reading .vdu/.sdu headers at runtime; only the payloads come from here.
//
// Options:
//   --only a,b    only items matching any pattern: a key ("5:16"), a package id ("5:"),
//                 "audio" / "video", or a substring of the container path ("Docks")
//   --force       re-encode even when the output is up to date
//   --jobs N      parallel ffmpeg processes (default: CPU count; videos use min(N, 3))
//   --data DIR    game install (default $SUFFERING_DATA or game/app)
//   --out DIR     output folder (default: "converted" next to the install's app folder)
//
// ffmpeg is taken from $FFMPEG, else from PATH; it needs the wmv2 decoder and
// the libx264 + aac encoders. Inputs are piped (no temp copies of game data);
// each output is written as <file>.part and renamed when complete.
// Idempotent: an output is skipped when its manifest fingerprint (source file,
// entry location, encoder settings) is unchanged and the file is present.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { readDbId } from '../src/formats/model';
import { indexSoundsLazy, readSrscDirectory, type SoundInfo } from '../src/formats/sound';
import { ASF_HEADER_PROBE, asfPlayDuration, asfStream, findSoundtrack, pairVideoEntries, videoInfoFromHeader, type VideoInfo } from '../src/formats/video';
import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  isManifest,
  soundFile,
  videoFile,
  type ConvertedManifest,
  type ConvertedSound,
  type ConvertedVideo,
} from '../src/formats/converted';
import { readMp4 } from './mp4';

// Encoder settings. Bump a version to re-encode everything of that kind.
const AUDIO_VERSION = 'a1';
const VIDEO_VERSION = 'v1';
/** Sample rates the AAC encoder accepts; lower originals (2 and 6 kHz effects) are resampled to 8 kHz. */
const AAC_MIN_RATE = 7350;
const audioBitrate = (rate: number, channels: number) =>
  channels * (rate >= 32000 ? 64 : rate >= 22050 ? 56 : rate >= 16000 ? 48 : 32);
const VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '60'];

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DATA = resolve(opt('--data') ?? process.env.SUFFERING_DATA ?? 'game/app');
const OUT = resolve(opt('--out') ?? join(dirname(DATA), 'converted'));
const FORCE = argv.includes('--force');
const JOBS = Math.max(1, Number(opt('--jobs') ?? cpus().length));
const ONLY = (opt('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const matches = (kind: 'audio' | 'video', key: string, path: string) =>
  !ONLY.length ||
  ONLY.some((p) => p === kind || p === key || (p.endsWith(':') && key.startsWith(p)) || path.toLowerCase().includes(p.toLowerCase()));

// ---------------------------------------------------------------------------
// Helpers

function checkFfmpeg(): void {
  const run = (...a: string[]) => spawnSync(FFMPEG, ['-hide_banner', ...a], { encoding: 'utf8' });
  const v = run('-version');
  if (v.error || v.status !== 0) {
    console.error(`ffmpeg not found ("${FFMPEG}"). Install it or set FFMPEG=/path/to/ffmpeg.`);
    process.exit(2);
  }
  const enc = run('-encoders').stdout;
  const dec = run('-decoders').stdout;
  const missing = [
    !/\blibx264\b/.test(enc) && 'libx264 encoder',
    !/^\s*A\S*\s+aac\s/m.test(enc) && 'aac encoder',
    !/\bwmv2\b/.test(dec) && 'wmv2 decoder',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`${FFMPEG} lacks: ${missing.join(', ')}`);
    process.exit(2);
  }
  console.log(`ffmpeg: ${v.stdout.split('\n')[0]} (${FFMPEG})`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

class Reader {
  private readonly fd: number;
  readonly size: number;
  readonly mtime: number;
  constructor(readonly path: string) {
    this.fd = openSync(path, 'r');
    const st = statSync(path);
    this.size = st.size;
    this.mtime = Math.round(st.mtimeMs);
  }
  bytes(offset: number, length: number): Uint8Array {
    const b = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = readSync(this.fd, b, got, length - got, offset + got);
      if (!n) break;
      got += n;
    }
    return b.subarray(0, got);
  }
  read = async (offset: number, length: number): Promise<ArrayBuffer> => {
    const b = this.bytes(offset, length);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  close() {
    closeSync(this.fd);
  }
}

const fingerprint = (...parts: (string | number)[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);

function packageId(containerPath: string): number | undefined {
  const want = containerPath.replace(/\.[^./]+$/, '.db').split('/').pop()!.toLowerCase();
  const db = readdirSync(dirname(containerPath)).find((f) => f.toLowerCase() === want);
  return db ? readDbId(readFileSync(join(dirname(containerPath), db), 'latin1')) : undefined;
}

/** Runs ffmpeg with byte inputs on pipe:0 / pipe:3. Rejects with its stderr on failure. */
function ffmpeg(args: string[], inputs: Uint8Array[]): Promise<void> {
  return new Promise((res, rej) => {
    const stdio: ('pipe' | 'ignore')[] = ['pipe', 'ignore', 'pipe'];
    if (inputs.length > 1) stdio.push('pipe');
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio });
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    const feed = (i: number, data: Uint8Array | undefined) => {
      const s = p.stdio[i] as NodeJS.WritableStream | null;
      if (!s) return;
      s.on('error', () => undefined); // EPIPE if ffmpeg exits early; reported via exit code
      if (data) s.end(data);
      else s.end();
    };
    feed(0, inputs[0]);
    if (inputs.length > 1) feed(3, inputs[1]);
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 800)}`))));
  });
}

async function encodeTo(file: string, args: string[], inputs: Uint8Array[]): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const part = file + '.part';
  try {
    await ffmpeg([...args, '-f', 'mp4', part], inputs);
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

const pcmInput = (s: SoundInfo) => ['-f', 's16le', '-ar', String(s.sampleRate), '-ac', String(s.channels)];
const aacArgs = (s: SoundInfo) => {
  const rate = s.sampleRate < AAC_MIN_RATE ? 8000 : s.sampleRate;
  return { rate, args: [...(rate !== s.sampleRate ? ['-ar', String(rate)] : []), '-c:a', 'aac', '-b:a', `${audioBitrate(rate, s.channels)}k`] };
};

const freeBytes = (p: string) => {
  const s = statfsSync(p);
  return s.bavail * s.bsize;
};
const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// Main

interface Job {
  kind: 'audio' | 'video';
  key: string;
  label: string;
  /** Rough work estimate (seconds of media) for the ETA. */
  weight: number;
  run(): Promise<void>;
}

async function main() {
  if (!existsSync(join(DATA, 'LEVELS')) && !readdirSync(DATA).some((f) => f.toLowerCase() === 'levels')) {
    console.error(`No game install at ${DATA} (use --data or SUFFERING_DATA)`);
    process.exit(2);
  }
  checkFfmpeg();
  mkdirSync(OUT, { recursive: true });
  console.log(`data ${DATA}\nout  ${OUT}\nfree ${mb(freeBytes(OUT))}`);

  const manifestPath = join(OUT, MANIFEST_FILE);
  let old: ConvertedManifest | undefined;
  try {
    const j = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (isManifest(j)) old = j;
  } catch {
    /* first run */
  }
  const manifest: ConvertedManifest = {
    version: MANIFEST_VERSION,
    created: new Date().toISOString(),
    audio: { codec: 'aac', container: 'mp4', mime: 'audio/mp4' },
    video: { codec: 'h264', container: 'mp4', mime: 'video/mp4' },
    packages: {},
    sounds: {},
    videos: {},
  };

  const files = walk(DATA);
  const sdus = files.filter((f) => /\.sdu$/i.test(f)).sort();
  const vdus = files.filter((f) => /\.vdu$/i.test(f)).sort();
  const readers: Reader[] = [];
  const jobs: Job[] = [];
  const upToDate = (prev: { file: string; bytes: number; source: string } | undefined, src: string) =>
    !FORCE && prev && prev.source === src && existsSync(join(OUT, prev.file)) && statSync(join(OUT, prev.file)).size === prev.bytes;

  // --- sounds ---
  const soundsByPkg = new Map<number, { reader: Reader; sounds: SoundInfo[] }>();
  for (const path of sdus) {
    const pkg = packageId(path);
    if (pkg === undefined) {
      console.warn(`skip ${path}: no package id`);
      continue;
    }
    const rel = relative(DATA, path).replace(/\\/g, '/');
    manifest.packages[pkg] = rel.replace(/\.[^./]+$/, '');
    const reader = new Reader(path);
    readers.push(reader);
    const sounds = await indexSoundsLazy(reader.read, pkg);
    soundsByPkg.set(pkg, { reader, sounds });
    for (const s of sounds) {
      const { rate, args } = aacArgs(s);
      const src = fingerprint(AUDIO_VERSION, rel, reader.size, reader.mtime, s.dataOffset, s.dataSize, s.sampleRate, s.channels, args.join(' '));
      const prev = old?.sounds[s.key];
      if (upToDate(prev, src) || !matches('audio', s.key, rel)) {
        if (prev && existsSync(join(OUT, prev.file))) manifest.sounds[s.key] = prev;
        continue;
      }
      const file = soundFile(pkg, s.id);
      jobs.push({
        kind: 'audio',
        key: s.key,
        label: `audio ${s.key} ${s.duration.toFixed(1)} s`,
        weight: 0.05 + s.duration / 40,
        run: async () => {
          await encodeTo(join(OUT, file), [...pcmInput(s), '-i', 'pipe:0', ...args, '-movflags', '+faststart'], [
            reader.bytes(s.dataOffset, s.dataSize),
          ]);
          const info = readMp4(readFileSync(join(OUT, file)));
          const t = info.tracks.find((x) => x.handler === 'soun')!;
          manifest.sounds[s.key] = {
            file,
            duration: t.duration,
            frames: Math.round(t.duration * rate),
            rate,
            channels: s.channels,
            priming: t.editStart,
            bytes: statSync(join(OUT, file)).size,
            source: src,
          } satisfies ConvertedSound;
        },
      });
    }
  }

  // --- videos ---
  for (const path of vdus) {
    const pkg = packageId(path);
    if (pkg === undefined) {
      console.warn(`skip ${path}: no package id`);
      continue;
    }
    const rel = relative(DATA, path).replace(/\\/g, '/');
    manifest.packages[pkg] = rel.replace(/\.[^./]+$/, '');
    const reader = new Reader(path);
    readers.push(reader);
    const entries = await readSrscDirectory(reader.read);
    const videos: (VideoInfo & { durationSec: number })[] = pairVideoEntries(entries).map(([h, d]) => {
      const info = videoInfoFromHeader(new DataView(Uint8Array.from(reader.bytes(h.offset, h.size)).buffer), h, d, pkg);
      const dur = asfPlayDuration(reader.bytes(d.offset, Math.min(d.size, ASF_HEADER_PROBE)));
      if (dur === undefined) throw new Error(`${rel} ${info.key}: unreadable ASF header`);
      return { ...info, durationSec: dur };
    });
    const sounds = soundsByPkg.get(pkg);
    for (const v of videos) {
      const pick = sounds ? findSoundtrack(v, videos, sounds.sounds) : null;
      const sync = pick?.mode === 'sync' ? pick.sound : undefined;
      const src = fingerprint(
        VIDEO_VERSION,
        rel,
        reader.size,
        reader.mtime,
        v.data.offset,
        v.data.size,
        VIDEO_ARGS.join(' '),
        sync ? `${sync.key}@${sync.dataOffset}+${sync.dataSize}/${aacArgs(sync).args.join(' ')}` : '-',
      );
      const prev = old?.videos[v.key];
      const meta = {
        group: v.group,
        soundtrack: pick?.sound.key,
        soundtrackMode: pick?.mode,
        pairing: pick?.pairing,
      };
      if (upToDate(prev, src) || !matches('video', v.key, rel)) {
        if (prev && existsSync(join(OUT, prev.file))) manifest.videos[v.key] = { ...prev, ...meta };
        continue;
      }
      const file = videoFile(pkg, v.id);
      jobs.push({
        kind: 'video',
        key: v.key,
        label: `video ${v.key} ${v.durationSec.toFixed(1)} s${sync ? ` + ${sync.key}` : ''}`,
        weight: v.durationSec * 2.5,
        run: async () => {
          const stream = asfStream(reader.bytes(v.data.offset, v.data.size));
          const args = ['-f', 'asf', '-i', 'pipe:0'];
          const inputs: Uint8Array[] = [stream];
          if (sync) {
            args.push(...pcmInput(sync), '-i', 'pipe:3');
            inputs.push(sounds!.reader.bytes(sync.dataOffset, sync.dataSize));
          }
          args.push('-map', '0:v:0', ...VIDEO_ARGS, '-fps_mode', 'passthrough', '-video_track_timescale', '1000');
          if (sync) args.push('-map', '1:a:0', ...aacArgs(sync).args);
          args.push('-movflags', '+faststart');
          await encodeTo(join(OUT, file), args, inputs);
          const info = readMp4(readFileSync(join(OUT, file)));
          const t = info.tracks.find((x) => x.handler === 'vide')!;
          manifest.videos[v.key] = {
            file,
            duration: t.duration,
            mediaDuration: Math.max(...info.tracks.map((x) => x.duration)),
            frames: t.samples,
            width: v.width,
            height: v.height,
            ...meta,
            bytes: statSync(join(OUT, file)).size,
            source: src,
          } satisfies ConvertedVideo;
        },
      });
    }
  }

  const total = jobs.length;
  const skipped = Object.keys(manifest.sounds).length + Object.keys(manifest.videos).length;
  console.log(`${total} to encode (${jobs.filter((j) => j.kind === 'video').length} videos), ${skipped} up to date`);
  const save = () => {
    const sorted = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => {
        const [ap, ai] = a.split(':').map(Number);
        const [bp, bi] = b.split(':').map(Number);
        return ap - bp || ai - bi;
      }));
    const m = { ...manifest, sounds: sorted(manifest.sounds), videos: sorted(manifest.videos) };
    writeFileSync(manifestPath + '.part', JSON.stringify(m, null, 1));
    renameSync(manifestPath + '.part', manifestPath);
  };

  const t0 = performance.now();
  const totalWeight = jobs.reduce((s, j) => s + j.weight, 0) || 1;
  let doneWeight = 0;
  let done = 0;
  let failed = 0;
  let lastSave = performance.now();
  let lastLine = 0;
  const tty = process.stdout.isTTY;
  const progress = (j: Job, err?: Error) => {
    done++;
    doneWeight += j.weight;
    const el = (performance.now() - t0) / 1000;
    const eta = doneWeight > 0 ? (el * (totalWeight - doneWeight)) / doneWeight : 0;
    const line = `[${done}/${total}] ${j.label}${err ? ' FAILED' : ''}  ${el.toFixed(0)} s elapsed, ~${eta.toFixed(0)} s left`;
    if (err) {
      if (tty) process.stdout.write('\n');
      console.error(`${line}\n  ${err.message}`);
    } else if (tty) process.stdout.write(`\r${line.padEnd(100).slice(0, 100)}`);
    else if (done === total || performance.now() - lastLine > 5000) {
      lastLine = performance.now();
      console.log(line);
    }
    if (performance.now() - lastSave > 10000) {
      lastSave = performance.now();
      save();
    }
  };
  const runPool = async (list: Job[], n: number) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, list.length) }, async () => {
        while (next < list.length) {
          const j = list[next++];
          try {
            await j.run();
            progress(j);
          } catch (e) {
            failed++;
            progress(j, e as Error);
          }
        }
      }),
    );
  };
  // Long videos first (x264 is multi-threaded), then the many small sounds.
  await runPool(jobs.filter((j) => j.kind === 'video').sort((a, b) => b.weight - a.weight), Math.min(JOBS, 3));
  await runPool(jobs.filter((j) => j.kind === 'audio'), JOBS);
  if (tty && total) process.stdout.write('\n');
  for (const r of readers) r.close();
  save();

  const all = [...Object.values(manifest.sounds), ...Object.values(manifest.videos)];
  const bytes = (l: { bytes: number }[]) => l.reduce((s, x) => s + x.bytes, 0);
  console.log(
    `done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${Object.keys(manifest.sounds).length} sounds (${mb(bytes(Object.values(manifest.sounds)))}), ` +
      `${Object.keys(manifest.videos).length} videos (${mb(bytes(Object.values(manifest.videos)))}), total ${mb(bytes(all))}; free ${mb(freeBytes(OUT))}` +
      (failed ? `; ${failed} FAILED` : ''),
  );
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
