// Usage: npx tsx tools/materials.ts [<.lvl path relative to the game root> ...] [--list] [--class <name>]
//                                   [--blend N] [--texture pkg:id] [--material pkg:id]
// Material / texture census of levels (default: chapter 1, 1a-1c), run against the local
// game data ($SUFFERING_DATA or ./game/app):
//   - every material used by placed models and floor layers, per material class
//   - blend mode x texture format, tint/animated/layered counts
//   - unresolved materials (no texture) and texture keys whose .tdu entry is missing
//   - --list: one line per material with its layers and the object classes using it
// The renderer's magenta checker marks exactly the "missing texture keys" reported here.
import { readLevelHeader, parseLevelObjects, parseFloorLayers } from '../src/formats/level';
import { loadPackages } from '../src/app/loader';
import { SrscFile } from '../src/formats/srsc';
import {
  findEntry,
  MATERIAL_CLASS_NAMES,
  readMaterial,
  readModel,
  readTemplateWords,
  refKey,
  TDU_TEXTURE,
  templateModelRef,
  type MaterialLayer,
  type PackageSet,
  type ResRef,
  type SurfaceMaterial,
} from '../src/formats/model';
import { formatName, readTextureHeader } from '../src/formats/texture';
import { className } from '../src/formats/entities';
import { hasSkeleton } from '../src/formats/skeleton';
import { nodeFS, hasData, DATA_ROOT } from '../tests/helpers';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const FLAGS_WITH_VALUE = new Set(['--class', '--blend', '--texture', '--material']);
const levels = args.filter((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUE.has(args[i - 1] ?? ''));
if (!levels.length) {
  for (const l of ['1a', '1b', '1c']) levels.push(`LEVELS/1 PrisonDeathRow/${l} PrisonDeathRow.lvl`);
}
if (!hasData) {
  console.error(`no game data at ${DATA_ROOT} (set SUFFERING_DATA)`);
  process.exit(1);
}

const BLEND_NAMES = ['opaque', 'alpha', 'add', 'opaque3', 'subtract', 'mulAlpha', 'mod2x', 'addOverAlpha', 'cutout'];
const fs = nodeFS();

interface MatUse {
  ref: ResRef;
  material?: SurfaceMaterial;
  submeshes: number;
  users: Map<string, number>;
}

function textureFormat(pkgs: PackageSet, key: string | undefined): string {
  if (!key) return 'none';
  const [pkg, id] = key.split(':').map(Number);
  const tdu = pkgs.get(pkg)?.tdu;
  const e = findEntry(tdu, TDU_TEXTURE, id);
  if (!tdu || !e) return pkgs.has(pkg) ? 'MISSING' : 'NO-PKG';
  return formatName(readTextureHeader(tdu, e));
}

const layerText = (pkgs: PackageSet, l: MaterialLayer) =>
  `${BLEND_NAMES[l.blend] ?? l.blend}:${l.texture ?? '-'}(${textureFormat(pkgs, l.texture)})` +
  (l.tint !== undefined ? ` tint#${l.tint.toString(16).padStart(6, '0')}` : '') +
  (l.frames ? ` frames=${l.frames.length}@${l.fps}` : '') +
  (l.depthWrite ? ' zw' : '') +
  (l.texGen ? ` texgen=${l.texGen}/in${l.texInput ?? 0}` : '') +
  (l.uvScale ? ` uv*${l.uvScale}` : '') +
  (l.uvOffset ? ` uv+${l.uvOffset.join(',')}` : '') +
  (l.scroll ? ` scroll=${l.scroll.key}` : '');

async function census(lvlPath: string) {
  const lvl = new SrscFile(await fs.read(lvlPath));
  const dir = lvlPath.slice(0, lvlPath.lastIndexOf('/'));
  const pkgs = await loadPackages(fs, dir, readLevelHeader(lvl).dependencies, () => {});
  const uses = new Map<string, MatUse>();
  const use = (ref: ResRef, user: string) => {
    const k = refKey(ref);
    let u = uses.get(k);
    if (!u) uses.set(k, (u = { ref, material: readMaterial(pkgs, ref), submeshes: 0, users: new Map() }));
    u.submeshes++;
    u.users.set(user, (u.users.get(user) ?? 0) + 1);
  };

  let objects = 0;
  for (const o of parseLevelObjects(lvl)) {
    const mr = templateModelRef(pkgs, o.template);
    if (!mr || mr.pkg === 2 || hasSkeleton(pkgs.get(mr.pkg)?.mdu, mr.id)) continue;
    const m = readModel(pkgs, mr);
    if (!m) continue;
    objects++;
    const tv = pkgs.get(o.template.pkg)?.odu;
    const te = findEntry(tv, 2, o.template.id);
    const cls = te && tv ? readTemplateWords(tv.data(te))?.cls : undefined;
    const user = cls !== undefined ? className(cls) : '?';
    for (const s of m.submeshes) {
      const r = m.materials[s.materialIndex ?? -1];
      if (r) use(r, user);
      else use({ id: 0, pkg: 0 }, `${user} (no material slot)`);
    }
  }
  for (const L of parseFloorLayers(lvl)) if (L.material) use(L.material, 'floor layer');

  // Summaries
  const byClass = new Map<string, number>();
  const byBlend = new Map<string, number>();
  const unresolved: string[] = [];
  const missingTex = new Map<string, string[]>();
  let tinted = 0, animated = 0, layered = 0;
  for (const [k, u] of uses) {
    const m = u.material;
    const cname = m ? (MATERIAL_CLASS_NAMES[m.cls] ?? (m.cls ? `0x${m.cls.toString(16)}` : 'texture')) : 'UNRESOLVED';
    byClass.set(cname, (byClass.get(cname) ?? 0) + 1);
    if (!m || !m.layers.length || !m.layers[0].texture) {
      unresolved.push(`${k} (${cname}) used by ${[...u.users.keys()].join(', ')}`);
      continue;
    }
    if (m.layers.length > 1) layered++;
    for (const l of m.layers) {
      const f = textureFormat(pkgs, l.texture);
      const bk = `${(BLEND_NAMES[l.blend] ?? String(l.blend)).padEnd(12)} ${f}`;
      byBlend.set(bk, (byBlend.get(bk) ?? 0) + 1);
      if (l.tint !== undefined && l.tint !== 0xffffff) tinted++;
      if (l.frames) animated++;
      for (const t of [l.texture, ...(l.frames ?? [])]) {
        if (t && /MISSING|NO-PKG/.test(textureFormat(pkgs, t))) {
          const list = missingTex.get(t) ?? [];
          list.push(k);
          missingTex.set(t, list);
        }
      }
    }
  }

  console.log(`\n=== ${lvlPath}: ${objects} placed models, ${uses.size} materials ===`);
  console.log('per class:   ' + [...byClass].map(([k, n]) => `${k}=${n}`).join('  '));
  console.log(`layered (multi-pass): ${layered}   tinted: ${tinted}   animated: ${animated}`);
  console.log('layers by blend mode x texture format:');
  for (const [k, n] of [...byBlend].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`unresolved materials: ${unresolved.length}`);
  for (const s of unresolved) console.log(`  ${s}`);
  console.log(`missing texture keys: ${missingTex.size}`);
  for (const [t, mats] of missingTex) console.log(`  ${t} <- ${mats.join(', ')}`);

  const blendFilter = flag('--blend');
  const texFilter = flag('--texture');
  const matFilter = flag('--material');
  const clsFilter = flag('--class')?.toLowerCase();
  if (args.includes('--list') || blendFilter || texFilter || matFilter || clsFilter) {
    console.log('materials:');
    for (const [k, u] of [...uses].sort((a, b) => b[1].submeshes - a[1].submeshes)) {
      const m = u.material;
      if (matFilter && k !== matFilter) continue;
      if (blendFilter && !m?.layers.some((l) => String(l.blend) === blendFilter)) continue;
      if (texFilter && !m?.layers.some((l) => l.texture === texFilter || l.frames?.includes(texFilter))) continue;
      const cname = m ? (MATERIAL_CLASS_NAMES[m.cls] ?? 'other') : 'UNRESOLVED';
      if (clsFilter && !cname.toLowerCase().includes(clsFilter)) continue;
      const users = [...u.users].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}x${c}`).join(', ');
      console.log(
        `  ${k.padEnd(9)} ${cname.padEnd(10)} x${String(u.submeshes).padEnd(4)} ` +
          (m ? m.layers.map((l) => layerText(pkgs, l)).join(' + ') : '') +
          (m?.fallback && m.layers.length > 1 ? `  [fallback ${layerText(pkgs, m.fallback)}]` : '') +
          `  <- ${users}`,
      );
    }
  }
}

for (const l of levels) await census(l);
