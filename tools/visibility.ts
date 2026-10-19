// Visibility report: zones, portals and how the static geometry splits across them.
//
//   npx tsx tools/visibility.ts                 every level: one summary line each
//   npx tsx tools/visibility.ts 1a --zones      one level (name substring), zone + portal list
//
// Load-time phases (parse / zoning / geometry / textures) are timed in Node, which is a
// rough stand-in for the browser's main-thread cost.

import { performance } from 'node:perf_hooks';
import { readLevelHeader, parseLevel } from '../src/formats/level';
import { buildLevelZoning, parseSectorTree } from '../src/formats/visgraph';
import { decodeReferencedTextures, loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { filesWithExt, hasData, nodeFS, readSrsc } from '../tests/helpers';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const showZones = args.includes('--zones');

async function main() {
  if (!hasData) throw new Error('No game data (set SUFFERING_DATA or extract to game/app)');
  console.warn = () => {};
  const fs = nodeFS();
  const levels = filesWithExt('.lvl').filter((l) => !filter || l.includes(filter));
  for (const path of levels) {
    const t0 = performance.now();
    const lvl = readSrsc(path);
    const packages = await loadPackages(fs, dirname(path), readLevelHeader(lvl).dependencies, () => {});
    const t1 = performance.now();
    const zoning = buildLevelZoning(lvl, packages);
    const t2 = performance.now();
    const level = parseLevel(lvl, path, { packages, zoneOf: zoning?.zoneOf, ldu: undefined });
    const t3 = performance.now();
    const textures = decodeReferencedTextures(level, packages);
    const t4 = performance.now();
    const tree = parseSectorTree(lvl);

    const zones = zoning?.visibility.zones ?? [];
    const tris = new Float64Array(zones.length + 1);
    const groups = new Set<string>();
    let total = 0;
    for (const p of level.parts) {
      const n = p.indices.length / 3;
      total += n;
      tris[p.zone ?? zones.length] += n;
      groups.add(`${p.zone ?? -1}:${p.cell ?? 0}`);
    }
    const texBytes = textures.reduce((s, t) => s + t.rgba.byteLength * 4 / 3, 0);
    const name = path.split('/').pop()!.replace('.lvl', '');
    const portals = zoning?.visibility.portals ?? [];
    const zoned = total - tris[zones.length];
    console.log(
      `${name.padEnd(22)} zones ${String(zones.length).padStart(3)} portals ${String(portals.length).padStart(3)} ` +
        `(${portals.filter((p) => p.startsClosed).length} start closed) parts ${String(level.parts.length).padStart(5)} groups ${String(groups.size).padStart(4)} ` +
        `tris ${(total / 1000).toFixed(0).padStart(4)}k zoned ${((100 * zoned) / Math.max(1, total)).toFixed(0).padStart(3)}% ` +
        `tex ${textures.length} ${(texBytes / 2 ** 20).toFixed(0)} MB | ms: pkgs ${(t1 - t0).toFixed(0)} zoning ${(t2 - t1).toFixed(0)} ` +
        `geometry ${(t3 - t2).toFixed(0)} textures ${(t4 - t3).toFixed(0)} | tree ${tree?.nodes.length ?? 0} nodes`,
    );
    if (showZones) {
      zones.forEach((z, i) => {
        const b = z.box.map((v) => v.toFixed(0)).join(',');
        const links = z.links.map((l) => `${l.zone}${l.portal < 0 ? '(open)' : `#${portals[l.portal].uid.toString(16)}${portals[l.portal].startsClosed ? '*' : ''}`}`);
        console.log(`  zone ${String(i).padStart(3)} ${z.name.padEnd(34)} ${(tris[i] / 1000).toFixed(1).padStart(6)}k tris box [${b}] -> ${links.join(' ')}`);
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
