// GameFS: read-only access to a The Suffering install ("app" folder contents).
//
// All paths are relative to the game's app/ directory and use forward slashes,
// e.g. "LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl". Lookups are
// case-insensitive because the game's own .db files reference "Common" while
// the folder on disk is "COMMON" (it was a Windows game).

export interface GameFS {
  readonly label: string;
  list(): Promise<string[]>;
  read(path: string): Promise<ArrayBuffer>;
  /** Read `length` bytes at `offset` without loading the whole file (sound banks are 100+ MB). */
  readRange(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  /** Size in bytes if known, without reading the file. */
  size(path: string): Promise<number | undefined>;
  /** Case-insensitive existence check; returns the canonical path or undefined. */
  resolve(path: string): Promise<string | undefined>;
}

export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

/** Shared case-insensitive index over a list of (path, size). */
abstract class IndexedFS implements GameFS {
  abstract readonly label: string;
  private index?: Promise<Map<string, { path: string; size: number }>>;

  protected abstract loadIndex(): Promise<{ path: string; size: number }[]>;
  protected abstract readCanonical(path: string): Promise<ArrayBuffer>;
  protected abstract readCanonicalRange(path: string, offset: number, length: number): Promise<ArrayBuffer>;

  private getIndex() {
    this.index ??= this.loadIndex().then((files) => {
      const m = new Map<string, { path: string; size: number }>();
      for (const f of files) m.set(f.path.toLowerCase(), f);
      return m;
    });
    return this.index;
  }

  async list(): Promise<string[]> {
    return [...(await this.getIndex()).values()].map((f) => f.path).sort();
  }

  async resolve(path: string): Promise<string | undefined> {
    return (await this.getIndex()).get(normalizePath(path).toLowerCase())?.path;
  }

  async size(path: string): Promise<number | undefined> {
    return (await this.getIndex()).get(normalizePath(path).toLowerCase())?.size;
  }

  async read(path: string): Promise<ArrayBuffer> {
    const canonical = await this.resolve(path);
    if (!canonical) throw new Error(`File not found in game data: ${path}`);
    return this.readCanonical(canonical);
  }

  async readRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    const canonical = await this.resolve(path);
    if (!canonical) throw new Error(`File not found in game data: ${path}`);
    return this.readCanonicalRange(canonical, offset, length);
  }
}

// ---------------------------------------------------------------------------
// Dev server (vite.config.ts middleware serving ./game/app)

export class DevServerFS extends IndexedFS {
  readonly label = 'dev server (game/app)';

  /** URL prefix of the dev server (converted media is served under `${base}/converted/`). */
  constructor(readonly base = '') {
    super();
  }

  /** Returns a DevServerFS if the /game-index endpoint answers, else null. */
  static async probe(base = ''): Promise<DevServerFS | null> {
    try {
      const res = await fetch(`${base}/game-index`, { method: 'HEAD', cache: 'no-store' });
      const ct = res.headers.get('content-type') ?? '';
      if (!res.ok || !ct.includes('json')) return null;
      return new DevServerFS(base);
    } catch {
      return null;
    }
  }

  private convertedFlag?: boolean;

  protected async loadIndex() {
    const res = await fetch(`${this.base}/game-index`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`/game-index: HTTP ${res.status}`);
    const json = (await res.json()) as { files: { path: string; size: number }[]; converted?: boolean };
    this.convertedFlag = json.converted ?? true;
    return json.files;
  }

  /** Whether the server has converted media (`npm run bake`) at /converted/. */
  async hasConvertedMedia(): Promise<boolean> {
    await this.list();
    return this.convertedFlag ?? true;
  }

  private url(path: string): string {
    return `${this.base}/game/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  protected async readCanonical(path: string): Promise<ArrayBuffer> {
    const res = await fetch(this.url(path));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  /** Range reads queued this tick, per file: sent together as one batched request. */
  private pendingRanges = new Map<string, { offset: number; length: number; resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }[]>();
  private batchedRanges = true;

  protected readCanonicalRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    if (length <= 0) return Promise.resolve(new ArrayBuffer(0));
    if (!this.batchedRanges) return this.fetchRange(path, offset, length);
    return new Promise((resolve, reject) => {
      let q = this.pendingRanges.get(path);
      if (!q) {
        this.pendingRanges.set(path, (q = []));
        setTimeout(() => void this.flushRanges(path), 0);
      }
      q.push({ offset, length, resolve, reject });
    });
  }

  private async flushRanges(path: string) {
    const q = this.pendingRanges.get(path) ?? [];
    this.pendingRanges.delete(path);
    for (let i = 0; i < q.length; i += 512) {
      const batch = q.slice(i, i + 512);
      if (batch.length === 1) {
        const r = batch[0];
        this.fetchRange(path, r.offset, r.length).then(r.resolve, r.reject);
        continue;
      }
      void (async () => {
        try {
          const res = await fetch(this.url(path), { headers: { 'X-Byte-Ranges': batch.map((r) => `${r.offset}-${r.offset + r.length - 1}`).join(',') } });
          if (!res.ok || res.headers.get('X-Byte-Ranges') !== 'concat') {
            // Server without batching (or the ranges are wrong): fall back to single requests.
            if (res.ok) this.batchedRanges = false;
            for (const r of batch) this.fetchRange(path, r.offset, r.length).then(r.resolve, r.reject);
            return;
          }
          const buf = await res.arrayBuffer();
          let o = 0;
          for (const r of batch) {
            r.resolve(buf.slice(o, o + r.length));
            o += r.length;
          }
        } catch (err) {
          for (const r of batch) r.reject(err);
        }
      })();
    }
  }

  private async fetchRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    const res = await fetch(this.url(path), { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A server that ignores Range answers 200 with the whole file.
    return res.status === 206 ? buf : buf.slice(offset, offset + length);
  }
}

// ---------------------------------------------------------------------------
// User-selected local folder (File System Access API or <input webkitdirectory>)

/** Minimal File System Access API typings (not in TS's DOM lib). */
interface FsDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FsDirHandle | FsFileHandle>;
}
interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}
type ShowDirectoryPicker = (opts?: { id?: string; mode?: 'read' }) => Promise<FsDirHandle>;

/** A file reachable either through a handle (lazy) or as an already-picked File. */
type LocalSource = { file: File } | { handle: FsFileHandle; size: number };

export class LocalFolderFS extends IndexedFS {
  readonly label: string;

  private constructor(
    label: string,
    private readonly files: Map<string, LocalSource>,
    /** Files of a converted-media folder (`npm run bake`) found with the install, by relative path. */
    private readonly converted: Map<string, LocalSource>,
  ) {
    super();
    this.label = label;
  }

  static get supportsDirectoryPicker(): boolean {
    return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  }

  /** Prompt with showDirectoryPicker(). Throws AbortError if the user cancels. */
  static async pickDirectory(): Promise<LocalFolderFS> {
    const pick = (window as unknown as { showDirectoryPicker: ShowDirectoryPicker }).showDirectoryPicker;
    const root = await pick({ id: 'the-suffering', mode: 'read' });
    const raw: [string, LocalSource][] = [];
    const walk = async (dir: FsDirHandle, prefix: string, media: boolean) => {
      for await (const h of dir.values()) {
        const rel = prefix ? `${prefix}/${h.name}` : h.name;
        if (h.kind === 'directory') {
          // Skip big irrelevant folders to keep the walk quick.
          if (/^(__support|_nvi|saves|xvsh|\.)/i.test(h.name)) continue;
          await walk(h, rel, media || h.name.toLowerCase() === 'converted');
        } else {
          // Size is needed for the game index; getFile() is cheap (no read). Converted media needs none.
          raw.push([rel, { handle: h, size: media ? 0 : (await h.getFile()).size }]);
        }
      }
    };
    await walk(root, '', false);
    return LocalFolderFS.fromEntries(root.name, raw);
  }

  /** From an <input type=file webkitdirectory> selection. */
  static fromFileList(list: FileList | File[]): LocalFolderFS {
    const raw: [string, LocalSource][] = [];
    let rootName = 'folder';
    for (const file of Array.from(list)) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      // webkitRelativePath includes the picked folder's name as first segment; keep it,
      // fromEntries() strips everything above the detected app root anyway.
      rootName = rel.split('/')[0] || rootName;
      raw.push([rel, { file }]);
    }
    return LocalFolderFS.fromEntries(rootName, raw);
  }

  /**
   * Accept either the install root, its app/ subfolder, or anything above it:
   * find the directory that directly contains LEVELS/ and re-root there.
   */
  private static fromEntries(rootName: string, raw: [string, LocalSource][]): LocalFolderFS {
    const paths = raw.map(([p]) => normalizePath(p));
    let prefix: string | null = null;
    for (const p of paths) {
      const segs = p.split('/');
      const i = segs.findIndex((s) => s.toLowerCase() === 'levels');
      if (i >= 0 && /\.lvl$/i.test(p)) {
        const cand = segs.slice(0, i).join('/');
        if (prefix === null || cand.length < prefix.length) prefix = cand;
      }
    }
    if (prefix === null) {
      throw new Error(
        `"${rootName}" doesn't look like a The Suffering install (no LEVELS/*.lvl found). ` +
          'Pick the install folder or its "app" subfolder.',
      );
    }
    const files = new Map<string, LocalSource>();
    // Converted media: "converted/" next to the app folder (where `npm run bake` writes it), else inside it.
    const app = prefix;
    const mediaRoots = [...(app ? [joinPath(dirname(app), 'converted')] : []), joinPath(app, 'converted')].map((r) => r.toLowerCase() + '/');
    const converted = new Map<string, LocalSource>();
    let mediaRoot: string | undefined;
    for (const r of mediaRoots)
      if (paths.some((p) => p.toLowerCase() === r + 'manifest.json')) {
        mediaRoot = r;
        break;
      }
    raw.forEach(([, src], i) => {
      const p = paths[i];
      if (mediaRoot && p.toLowerCase().startsWith(mediaRoot)) converted.set(p.slice(mediaRoot.length), src);
      else if (!app || p.startsWith(app + '/')) files.set(app ? p.slice(app.length + 1) : p, src);
    });
    return new LocalFolderFS(`local folder (${app ? `${rootName}/${app}` : rootName})`, files, converted);
  }

  /** True if the picked folder came with converted media (manifest.json present). */
  get hasConvertedMedia(): boolean {
    return this.converted.size > 0;
  }

  /** A file of the converted-media folder, by path relative to it. */
  async convertedFile(rel: string): Promise<File | undefined> {
    const src = this.converted.get(normalizePath(rel));
    return src && ('file' in src ? src.file : src.handle.getFile());
  }

  protected async loadIndex() {
    return [...this.files].map(([path, src]) => ({
      path,
      size: 'file' in src ? src.file.size : src.size,
    }));
  }

  protected async readCanonical(path: string): Promise<ArrayBuffer> {
    return (await this.file(path)).arrayBuffer();
  }

  protected async readCanonicalRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    return (await this.file(path)).slice(offset, offset + length).arrayBuffer();
  }

  private async file(path: string): Promise<File> {
    const src = this.files.get(path);
    if (!src) throw new Error(`File not found: ${path}`);
    return 'file' in src ? src.file : src.handle.getFile();
  }
}
