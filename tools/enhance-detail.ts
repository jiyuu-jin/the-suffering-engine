// npm run enhance-detail
//
// Optional CC0 detail maps for the Enhanced mode's texture enhancement (docs/enhanced.md
// "Detail maps"): a fine concrete relief and roughness, blended at a small scale over the
// generated maps on High / Ultra to break up low-resolution surfaces. Downloaded from Poly Haven
// (every asset CC0 1.0, https://polyhaven.com/license; no account) into the texture cache:
//   <out>/enhanced/detail/<file>   the images, checked against the MD5 the Poly Haven API lists
//   <out>/enhanced/detail/detail.json   what was downloaded, from where, under which licence
// Not committed (game/ is gitignored); the runtime draws without them when they are missing.
//
// Options: --out DIR (converted root, default game/converted), --force (download again).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DETAIL_MANIFEST, type DetailManifest } from '../src/app/enhanced/maps/manifest';

/** The pinned sources (Poly Haven API: https://api.polyhaven.com/files/<asset>). */
const ASSET = {
  id: 'concrete_wall_008',
  page: 'https://polyhaven.com/a/concrete_wall_008',
  licence: 'CC0 1.0 (https://polyhaven.com/license)',
  files: {
    normal: {
      url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_008/concrete_wall_008_nor_gl_1k.jpg',
      md5: 'ea22029834a78f549981196b3263aa78',
    },
    roughness: {
      url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_008/concrete_wall_008_rough_1k.jpg',
      md5: '1f6d5b02c58aff38a69f07a62a4cc231',
    },
  },
};

const argv = process.argv.slice(2);
const OUT = resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'game/converted');
const FORCE = argv.includes('--force');
const dir = join(OUT, DETAIL_MANIFEST, '..');
mkdirSync(dir, { recursive: true });

const manifest: DetailManifest = { version: 1, asset: ASSET.id, source: ASSET.page, licence: ASSET.licence, normal: '', roughness: '' };
for (const [kind, f] of Object.entries(ASSET.files) as [keyof typeof ASSET.files, { url: string; md5: string }][]) {
  const name = f.url.split('/').pop()!;
  const abs = join(dir, name);
  const ok = (b: Uint8Array) => createHash('md5').update(b).digest('hex') === f.md5;
  if (FORCE || !existsSync(abs) || !ok(readFileSync(abs))) {
    console.log(`[detail] ${f.url}`);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!ok(bytes)) throw new Error(`${name}: MD5 mismatch`);
    writeFileSync(`${abs}.part`, bytes);
    renameSync(`${abs}.part`, abs);
  }
  manifest[kind] = `${DETAIL_MANIFEST.slice(0, DETAIL_MANIFEST.lastIndexOf('/'))}/${name}`;
}
writeFileSync(join(OUT, DETAIL_MANIFEST), JSON.stringify(manifest, null, 1));
console.log(`[detail] ${ASSET.id} (${ASSET.licence}) -> ${dir}`);
