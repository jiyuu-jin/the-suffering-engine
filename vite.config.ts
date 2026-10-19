import { defineConfig, type Connect, type Plugin } from 'vite';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

// Local game data (never copied into the repo or the build). Users of the
// deployed site bring their own install via the folder picker instead.
const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'game/app');
const FILE_PREFIX = '/game/';
const INDEX_URL = '/game-index';
// Media converted by `npm run bake` (manifest.json + video/*.mp4 + audio/*.m4a), also never in the repo.
const CONVERTED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'game/converted');
const CONVERTED_PREFIX = '/converted/';
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.json': 'application/json',
};

interface IndexEntry {
  path: string;
  size: number;
}

async function walk(dir: string, rel = '', out: IndexEntry[] = []): Promise<IndexEntry[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(abs, r, out);
    else if (e.isFile()) out.push({ path: r, size: (await fsp.stat(abs)).size });
  }
  return out;
}

function sendError(res: ServerResponse, code: number, msg: string) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(msg);
}

/** Resolve a URL path under `root`, rejecting anything that escapes it. */
function safeResolve(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.sep + decoded.replace(/\\/g, '/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function gameDataMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0];

    if (pathname === INDEX_URL) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
      try {
        await fsp.access(GAME_ROOT);
      } catch {
        return sendError(res, 404, 'No local game data (game/app missing)');
      }
      const files = await walk(GAME_ROOT);
      // Lets the client skip /converted/ entirely (no 404s) when `npm run bake` hasn't run.
      const converted = await fsp
        .access(path.join(CONVERTED_ROOT, 'manifest.json'))
        .then(() => true)
        .catch(() => false);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ root: 'game/app', files, converted }));
      return;
    }

    const prefix = pathname.startsWith(FILE_PREFIX) ? FILE_PREFIX : pathname.startsWith(CONVERTED_PREFIX) ? CONVERTED_PREFIX : null;
    if (prefix) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
      const abs = safeResolve(prefix === FILE_PREFIX ? GAME_ROOT : CONVERTED_ROOT, pathname.slice(prefix.length));
      if (!abs) return sendError(res, 400, 'Bad path');
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        return sendError(res, 404, 'Not found');
      }
      if (!stat.isFile()) return sendError(res, 404, 'Not found');
      // Batched ranges (DevServerFS): "X-Byte-Ranges: a-b,c-d,..." answers the slices back to
      // back in one 200 response, so indexing a sound bank is a few requests, not thousands.
      const multi = req.headers['x-byte-ranges'];
      if (typeof multi === 'string' && req.method === 'GET') {
        const ranges = multi.split(',').map((r) => r.split('-').map(Number));
        if (ranges.length > 4096 || ranges.some(([a, b]) => !(a >= 0 && b >= a && b < stat.size))) return sendError(res, 416, 'Bad ranges');
        const fh = await fsp.open(abs, 'r');
        try {
          const parts = await Promise.all(
            ranges.map(async ([a, b]) => {
              const buf = Buffer.alloc(b - a + 1);
              await fh.read(buf, 0, buf.length, a);
              return buf;
            }),
          );
          const body = Buffer.concat(parts);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('X-Byte-Ranges', 'concat');
          res.setHeader('Content-Length', String(body.length));
          res.setHeader('Cache-Control', 'no-cache');
          res.end(body);
        } finally {
          await fh.close();
        }
        return;
      }
      // Single byte ranges let the client read headers out of 100+ MB banks and let <video> seek.
      let start = 0;
      let end = stat.size - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          return sendError(res, 416, 'Range not satisfiable');
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader('Accept-Ranges', 'bytes');
      const type = prefix === CONVERTED_PREFIX ? CONTENT_TYPES[path.extname(abs).toLowerCase()] : undefined;
      res.setHeader('Content-Type', type ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'HEAD') return void res.end();
      const stream = createReadStream(abs, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    next();
  };
}

function gameData(): Plugin {
  return {
    name: 'suffering-game-data',
    // Registered directly (not via a returned post-hook) so it runs before Vite's own static handling.
    configureServer(server) {
      server.middlewares.use(gameDataMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(gameDataMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [gameData()],
  server: {
    watch: { ignored: ['**/game/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
