// npm run enhance-textures [-- options]
//
// Enhanced graphics mode, texture enhancement (docs/enhanced.md "Texture enhancement"): reads the
// textures of the user's own install and writes, for every world and character texture,
//   <out>/enhanced/tex/<pkg>/<id>.a.<ext>   albedo upscaled 2x (edge-aware; sources ≥ 512 kept)
//   <out>/enhanced/tex/<pkg>/<id>.n.<ext>   tangent-space normal map from the albedo's relief
//   <out>/enhanced/tex/<pkg>/<id>.s.<ext>   R roughness, G specular, B cavity
//   <out>/enhanced/manifest.json             key "pkg:id" -> files, sizes, class, fingerprint
// Generators: src/app/enhanced/maps/generate.ts. Nothing is downloaded, nothing leaves the
// machine, and the output is derived from the game's data: never commit it (it lives under
// game/, which is gitignored).
//
// Options:
//   --data DIR     game install (default $SUFFERING_DATA or game/app)
//   --out DIR      converted root (default: "converted" next to the install's app folder)
//   --scale N      albedo upscale factor, 2 (default) or 4
//   --codec C      webp (default when cwebp is found: $CWEBP or PATH) or png
//   --jobs N       worker threads (default: half the CPUs, at most 6)
//   --only a,b     only keys / package ids ("9:" ) / substrings of the package path
//   --force        regenerate even when the fingerprint is unchanged
//   --limit N      stop after N textures (trial runs)
//
// Incremental: an entry is skipped when its fingerprint (source payload hash, generator version,
// scale, codec, usage flags) is unchanged and its files exist. Files are written as .part and
// renamed. Prints the time and the cache's size at the end.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SrscFile } from '../src/formats/srsc';
import { Blend, ODU_OBJECT, TDU_TEXTURE, TexInput, readDbId, readMaterial, type PackageSet, type SurfaceMaterial } from '../src/formats/model';
import { listSkinnedModels, readSkinnedGeometry } from '../src/formats/skeleton';
import { decodeTextureJob } from '../src/app/texture-decode';
import { GENERATOR_VERSION, enhanceTexture, type Rgba, type TextureUsage } from '../src/app/enhanced/maps/generate';
import {
  ENHANCED_DIR,
  ENHANCED_MANIFEST,
  ENHANCED_MANIFEST_VERSION,
  isEnhancedManifest,
  mapFileName,
  type EnhancedEntry,
  type EnhancedManifest,
  type MapFile,
} from '../src/app/enhanced/maps/manifest';
import { encodePngFiltered } from './enhance/png';

// ---------------------------------------------------------------------------
// Worker: decode, generate, encode, write.

interface Job {
  key: string;
  type: number;
  id: number;
  bytes: Uint8Array;
  usage: TextureUsage;
  fp: string;
}
interface MapOut {
  kind: 'a' | 'n' | 's';
  width: number;
  height: number;
  /** PNG bytes (png codec), or the PAM the main thread pipes into cwebp (webp codec). */
  payload: Uint8Array;
}
interface JobResult {
  key: string;
  meta?: Omit<EnhancedEntry, 'albedo' | 'normal' | 'surface'>;
  maps?: MapOut[];
  error?: string;
  ms: number;
}
interface WorkerInit {
  scale: number;
  codec: 'webp' | 'png';
}

function pam(img: Rgba, channels: 3 | 4): Buffer {
  const head = Buffer.from(`P7\nWIDTH ${img.width}\nHEIGHT ${img.height}\nDEPTH ${channels}\nMAXVAL 255\nTUPLTYPE ${channels === 4 ? 'RGB_ALPHA' : 'RGB'}\nENDHDR\n`, 'ascii');
  if (channels === 4) return Buffer.concat([head, img.data]);
  const n = img.width * img.height;
  const body = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    body[i * 3] = img.data[i * 4];
    body[i * 3 + 1] = img.data[i * 4 + 1];
    body[i * 3 + 2] = img.data[i * 4 + 2];
  }
  return Buffer.concat([head, body]);
}

/** WebP settings per map: lossy (the shader renormalises normals), alpha lossless, -exact keeps
 *  the colour under transparent texels (the upscaler fills it so cut-out edges have no fringe). */
const WEBP_ARGS: Record<'a' | 'n' | 's', string[]> = {
  a: ['-q', '90', '-m', '4', '-sharp_yuv', '-exact'],
  n: ['-q', '92', '-m', '4', '-sharp_yuv'],
  s: ['-q', '90', '-m', '4'],
};

function runJob(init: WorkerInit, job: Job): JobResult {
  const t0 = performance.now();
  try {
    const tex = decodeTextureJob({ key: job.key, type: job.type, id: job.id, bytes: job.bytes });
    if (!tex) return { key: job.key, error: 'undecodable', ms: performance.now() - t0 };
    const img: Rgba = { width: tex.width, height: tex.height, data: tex.rgba };
    const alpha = tex.hasAlpha || img.data.some((v, i) => (i & 3) === 3 && v !== 255);
    const set = enhanceTexture(img, job.usage, init.scale);
    const out = (kind: MapOut['kind'], m: Rgba, a: boolean): MapOut => ({
      kind,
      width: m.width,
      height: m.height,
      payload: init.codec === 'png' ? encodePngFiltered(m.width, m.height, m.data, a ? 4 : 3) : pam(m, a ? 4 : 3),
    });
    const maps = [out('n', set.normal, false), out('s', set.surface, false)];
    if (set.albedo) maps.push(out('a', set.albedo, alpha));
    return { key: job.key, meta: { fp: job.fp, width: tex.width, height: tex.height, cls: set.cls, alpha }, maps, ms: performance.now() - t0 };
  } catch (err) {
    return { key: job.key, error: (err as Error).message, ms: performance.now() - t0 };
  }
}

/** Write one map (cwebp runs asynchronously from the main thread: spawnSync in worker threads hung). */
function writeMap(out: string, codec: 'webp' | 'png', cwebp: string, key: string, m: MapOut): Promise<MapFile> {
  const file = mapFileName(key, m.kind, codec);
  const abs = join(out, file);
  mkdirSync(dirname(abs), { recursive: true });
  const part = `${abs}.part`;
  const done = (): MapFile => {
    renameSync(part, abs);
    return { file, width: m.width, height: m.height, bytes: statSync(abs).size };
  };
  if (codec === 'png') {
    writeFileSync(part, m.payload);
    return Promise.resolve(done());
  }
  return new Promise((res, rej) => {
    const p = spawn(cwebp, ['-quiet', ...WEBP_ARGS[m.kind], '-o', part, '--', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 && existsSync(part) ? res(done()) : rej(new Error(`cwebp ${m.kind}: ${err.trim() || code}`))));
    p.stdin.on('error', () => undefined);
    p.stdin.end(m.payload);
  });
}

if (!isMainThread) {
  const init = workerData as WorkerInit;
  parentPort!.on('message', (job: Job) => parentPort!.postMessage(runJob(init, job)));
} else {
  await main();
}

// ---------------------------------------------------------------------------
// Main thread

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const DATA = resolve(opt('--data') ?? process.env.SUFFERING_DATA ?? 'game/app');
  const OUT = resolve(opt('--out') ?? join(dirname(DATA), 'converted'));
  const SCALE = Number(opt('--scale') ?? 2);
  const FORCE = argv.includes('--force');
  const LIMIT = Number(opt('--limit') ?? Infinity);
  const JOBS = Math.max(1, Number(opt('--jobs') ?? Math.min(6, Math.max(1, Math.floor(cpus().length / 2)))));
  const ONLY = (opt('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (SCALE !== 2 && SCALE !== 4) throw new Error('--scale must be 2 or 4');
  const cwebp = process.env.CWEBP || 'cwebp';
  const hasCwebp = spawnSync(cwebp, ['-version']).status === 0;
  const codec = (opt('--codec') ?? (hasCwebp ? 'webp' : 'png')) as 'webp' | 'png';
  if (codec === 'webp' && !hasCwebp) throw new Error(`cwebp not found ("${cwebp}"): install libwebp or pass --codec png`);
  if (codec !== 'webp' && codec !== 'png') throw new Error('--codec must be webp or png');
  if (codec === 'png') console.warn('[enhance] PNG output: about six times the disk of WebP (install libwebp for cwebp).');
  if (!existsSync(DATA)) throw new Error(`no install at ${DATA} (--data or $SUFFERING_DATA)`);

  const t0 = performance.now();
  // Packages: every .db with its .tdu / .odu / .mdu.
  const pkgs: PackageSet = new Map();
  const pkgPath = new Map<number, string>();
  const walk = (d: string, out: string[] = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.db$/i.test(e.name)) out.push(p);
    }
    return out;
  };
  const srsc = (p: string) => {
    if (!existsSync(p)) return undefined;
    const b = readFileSync(p);
    return new SrscFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  };
  for (const db of walk(DATA)) {
    const id = readDbId(readFileSync(db, 'latin1'));
    if (id === undefined || pkgs.has(id)) continue;
    const base = db.slice(0, -3);
    const tdu = srsc(`${base}.tdu`);
    if (!tdu && !existsSync(`${base}.mdu`)) continue;
    pkgs.set(id, { id, name: base.split('/').pop()!, tdu, odu: srsc(`${base}.odu`), mdu: srsc(`${base}.mdu`) });
    pkgPath.set(id, relative(DATA, base));
  }

  // Usage scan: how each texture is drawn (materials, skinned models).
  const usage = new Map<string, TextureUsage & { lit?: boolean; other?: boolean }>();
  const use = (key: string) => {
    let u = usage.get(key);
    if (!u) usage.set(key, (u = {}));
    return u;
  };
  const unlit = (b: number) => b === Blend.Add || b === Blend.Subtract || b === Blend.MulAlpha || b === Blend.Modulate2x;
  const scanMaterial = (m: SurfaceMaterial | undefined, character: boolean) => {
    if (!m) return;
    let reflective = false;
    for (const l of [...m.layers, ...(m.fallback ? [m.fallback] : [])]) {
      const keys = l.frames ?? (l.texture ? [l.texture] : []);
      const envmap = !!l.texGen || (l.texInput !== undefined && l.texInput !== TexInput.Uv);
      for (const k of keys) {
        const u = use(k);
        if (character) u.character = true;
        if (envmap || unlit(l.blend) || l.frames) u.other = true;
        else {
          u.lit = true;
          if (reflective && l.blend === Blend.AddOverAlpha) u.reflectMasked = true;
        }
      }
      if (envmap) reflective = true;
    }
  };
  for (const [id, p] of pkgs) {
    for (const e of p.odu?.entries ?? []) if (e.type === ODU_OBJECT) scanMaterial(readMaterial(pkgs, { pkg: id, id: e.id }), false);
    if (pkgPath.get(id)!.toLowerCase().includes('landscape')) for (const e of p.tdu?.byType(TDU_TEXTURE) ?? []) use(`${id}:${e.id}`).ground = true;
  }
  for (const [id, p] of pkgs) {
    if (!p.mdu) continue;
    for (const s of listSkinnedModels(p.mdu)) {
      let model;
      try {
        model = readSkinnedGeometry(pkgs, { pkg: id, id: s.id });
      } catch {
        continue;
      }
      for (const sm of model?.submeshes ?? []) {
        if (sm.textureKey) {
          const u = use(sm.textureKey);
          u.character = true;
          if (!sm.material || !unlit(sm.material.layers[0]?.blend ?? 0)) u.lit = true;
        }
        scanMaterial(sm.material, true);
      }
    }
  }

  // Jobs: every texture of every package but the interface's, minus the ones only ever drawn as
  // effects / environment maps / animation frames.
  const old = (() => {
    try {
      const m: unknown = JSON.parse(readFileSync(join(OUT, ENHANCED_MANIFEST), 'utf8'));
      return isEnhancedManifest(m) ? m : null;
    } catch {
      return null;
    }
  })();
  const partial = ONLY.length > 0 || LIMIT !== Infinity;
  // (A partial run keeps the other entries of the previous manifest.)
  const manifest: EnhancedManifest = { version: ENHANCED_MANIFEST_VERSION, generator: GENERATOR_VERSION, scale: SCALE, codec, textures: partial && old ? { ...old.textures } : {} };
  const jobs: Job[] = [];
  let skippedUse = 0, upToDate = 0, sourcePixels = 0;
  for (const [id, p] of pkgs) {
    const path = pkgPath.get(id)!;
    if (/(^|\/)interface\//i.test(path + '/') || !p.tdu) continue;
    for (const e of p.tdu.byType(TDU_TEXTURE)) {
      const key = `${id}:${e.id}`;
      if (ONLY.length && !ONLY.some((o) => o === key || (o.endsWith(':') && key.startsWith(o)) || path.toLowerCase().includes(o.toLowerCase()))) continue;
      const u = usage.get(key);
      if (u && !u.lit && u.other) {
        skippedUse++;
        continue;
      }
      const bytes = p.tdu.bytes(e);
      if (bytes.byteLength >= 0x24) sourcePixels += new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) * new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
      const flags: TextureUsage = { character: u?.character || undefined, reflectMasked: u?.reflectMasked || undefined, ground: u?.ground || undefined };
      const fp = createHash('sha1').update(bytes).update(`${GENERATOR_VERSION}|${SCALE}|${codec}|${JSON.stringify(flags)}`).digest('hex').slice(0, 20);
      const prev = old?.textures[key];
      if (!FORCE && prev && prev.fp === fp && [prev.albedo, prev.normal, prev.surface].every((f) => !f || existsSync(join(OUT, f.file)))) {
        manifest.textures[key] = prev;
        upToDate++;
        continue;
      }
      if (jobs.length < LIMIT) jobs.push({ key, type: e.type, id: e.id, bytes: bytes.slice(), usage: flags, fp });
    }
  }
  const scanMs = performance.now() - t0;
  console.log(`[enhance] ${pkgs.size} packages, usage scan ${(scanMs / 1000).toFixed(1)} s; ${jobs.length} to generate, ${upToDate} up to date, ${skippedUse} skipped (effects / environment maps); codec ${codec}, scale ${SCALE}, ${JOBS} workers`);

  // Disk: rough estimate (bytes per source texel measured on the prison sets) + 500 MB margin.
  const free = (() => {
    try {
      const s = statfsSync(OUT.startsWith(DATA) ? DATA : existsSync(OUT) ? OUT : dirname(OUT));
      return s.bavail * s.bsize;
    } catch {
      return Infinity;
    }
  })();
  const estimate = (sourcePixels * (codec === 'webp' ? 1.3 : 7.5) * jobs.length) / Math.max(1, jobs.length + upToDate);
  if (free < estimate + 500e6) throw new Error(`not enough free disk: about ${(estimate / 1e6).toFixed(0)} MB needed, ${(free / 1e6).toFixed(0)} MB free`);

  mkdirSync(join(OUT, ENHANCED_DIR), { recursive: true });
  const saveManifest = () => {
    const sorted: EnhancedManifest = { ...manifest, textures: Object.fromEntries(Object.entries(manifest.textures).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) };
    writeFileSync(join(OUT, `${ENHANCED_MANIFEST}.part`), JSON.stringify(sorted));
    renameSync(join(OUT, `${ENHANCED_MANIFEST}.part`), join(OUT, ENHANCED_MANIFEST));
  };

  const t1 = performance.now();
  let done = 0, failed = 0, cpuMs = 0;
  if (jobs.length) {
    const init: WorkerInit = { scale: SCALE, codec };
    const self = fileURLToPath(import.meta.url);
    // Largest first: the pool finishes together.
    jobs.sort((a, b) => b.bytes.byteLength - a.bytes.byteLength);
    let next = 0;
    let lastSave = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(JOBS, jobs.length) }, () =>
        new Promise<void>((res, rej) => {
          const w = new Worker(self, { workerData: init, execArgv: process.execArgv });
          const feed = () => {
            if (next >= jobs.length) {
              void w.terminate();
              res();
              return;
            }
            const job = jobs[next++];
            w.postMessage(job);
          };
          w.on('message', async (r: JobResult) => {
            done++;
            cpuMs += r.ms;
            try {
              if (!r.meta || !r.maps) throw new Error(r.error ?? 'no output');
              const files = await Promise.all(r.maps.map((m) => writeMap(OUT, codec, cwebp, r.key, m)));
              const get = (k: MapOut['kind']) => files[r.maps!.findIndex((m) => m.kind === k)];
              const entry: EnhancedEntry = { ...r.meta, normal: get('n'), surface: get('s') };
              if (r.maps.some((m) => m.kind === 'a')) entry.albedo = get('a');
              manifest.textures[r.key] = entry;
            } catch (err) {
              failed++;
              console.warn(`[enhance] ${r.key}: ${(err as Error).message}`);
            }
            if (done % 200 === 0 || done === jobs.length) {
              const el = (performance.now() - t1) / 1000;
              console.log(`[enhance] ${done}/${jobs.length}  ${el.toFixed(0)} s, ~${((el / done) * (jobs.length - done)).toFixed(0)} s left`);
            }
            if (performance.now() - lastSave > 15000) (saveManifest(), (lastSave = performance.now()));
            feed();
          });
          w.on('error', rej);
          feed();
        }),
      ),
    );
  }
  saveManifest();

  // Stale files (entries no longer in the manifest).
  const keep = new Set<string>();
  for (const e of Object.values(manifest.textures)) for (const f of [e.albedo, e.normal, e.surface]) if (f) keep.add(f.file);
  let removed = 0;
  const texDir = join(OUT, ENHANCED_DIR, 'tex');
  if (!partial && existsSync(texDir))
    for (const pkg of readdirSync(texDir))
      for (const f of readdirSync(join(texDir, pkg))) {
        const rel = `${ENHANCED_DIR}/tex/${pkg}/${f}`;
        if (!keep.has(rel)) (rmSync(join(texDir, pkg, f)), removed++);
      }

  // Report.
  const entries = Object.values(manifest.textures);
  const sum = (k: 'albedo' | 'normal' | 'surface') => entries.reduce((s, e) => s + (e[k]?.bytes ?? 0), 0);
  const total = sum('albedo') + sum('normal') + sum('surface');
  const byClass: Record<string, number> = {};
  for (const e of entries) byClass[e.cls] = (byClass[e.cls] ?? 0) + 1;
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  console.log(
    `[enhance] done: ${entries.length} textures (${done - failed} generated, ${failed} failed, ${removed} stale files removed) in ${((performance.now() - t0) / 1000).toFixed(1)} s ` +
      `(${(cpuMs / 1000).toFixed(0)} s of worker time)\n` +
      `[enhance] cache ${mb(total)}: albedo ${mb(sum('albedo'))}, normal ${mb(sum('normal'))}, surface ${mb(sum('surface'))}  -> ${join(OUT, ENHANCED_DIR)}\n` +
      `[enhance] classes ${JSON.stringify(byClass)}`,
  );
}
