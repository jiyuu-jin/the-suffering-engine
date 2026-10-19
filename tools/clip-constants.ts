// Clip constant-translation audit: what the engine's sampler rule does to every character.
//
// Usage: npx tsx tools/clip-constants.ts [--levels "1a,1b,2 cell"] [--min 0.1] [--top 40]
//                                        [--sets] [--json out.json]
//
// A rotation-only clip track (format 0xc0) stores a constant translation that the engine uses
// as the bone's translation (SUFFERING.EXE 0x46a180 / 0x46a290; docs/re/animation.md §7). The
// port used the rig's bind translation for those bones (plus the hips' body offset for NPC and
// scripted clips) until it followed the engine. This poses every model / clip pair the levels
// really play both ways at three clip times and reports the difference:
//   - pairs: a placed object's model with every clip its template reaches (Animation
//     properties of the template and of the templates it references, three levels deep:
//     behaviours, attacks, hit reactions), and every STOMP animation key with the model of the
//     object its track drives; --sets instead pairs every skinned model with every clip of its
//     own animation set (an upper bound: sets are shared by models of different sizes, trees);
//   - bind: the largest move of a bone that skins vertices, root offset removed (metres),
//     against the bind translations; hips: the same against bind + the hips' body offset;
//   - ratio: median |constant| / |bind| over the clip's rotation-only non-root bones with a
//     bind length > 3 cm (1 = the proportions the rig is bound with);
// plus data checks: tracks with hash 0 (the engine binds those by position, 0x4793b0) and
// constants over 50 m (mis-scaled). Game data is read at runtime; nothing of it is stored.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { loadPackages } from '../src/app/loader';
import { readLevelHeader } from '../src/formats/level';
import { SrscFile } from '../src/formats/srsc';
import { listSkinnedModels, readSkinnedModel, type SkinnedModel } from '../src/formats/skeleton';
import { listAnimations, readAnimation, sampleTrackRotation, sampleTrackTranslation, TRACK_ROTATION, type AnimClipData } from '../src/formats/animation';
import type { PackageSet, ResRef } from '../src/formats/model';
import { classByHash, decodeTemplateProps, parseEntities, PropType, readObjectTemplate, type EntityPackageSet, type PropValue } from '../src/formats/entities';
import { parseStompSequence } from '../src/game/world/stomp';
import { DATA_ROOT, nodeFS } from '../tests/helpers';

export type ConstantRule = 'bind' | 'hips' | 'animation';

/**
 * Bone positions (model space) of `skinned` posed by `clip` at time t. 'animation' is the
 * engine's rule; 'bind' gives every rotation-only bone its bind translation; 'hips' is 'bind'
 * except for the hips (children of the root), which keep the clip's body offset.
 */
export function posePositions(skinned: SkinnedModel, clip: AnimClipData, t: number, rule: ConstantRule): THREE.Vector3[] {
  const skel = skinned.skeleton;
  const byBone = new Map<number, AnimClipData['tracks'][number]>();
  for (const tr of clip.tracks) {
    const bi = skel.byHash.get(tr.boneHash);
    if (bi !== undefined) byBone.set(bi, tr);
  }
  const world: THREE.Matrix4[] = [];
  const out: THREE.Vector3[] = [];
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  for (const b of skel.bones) {
    const tr = byBone.get(b.index);
    p.fromArray(b.position);
    q.fromArray(b.quaternion);
    if (tr) {
      q.fromArray(sampleTrackRotation(clip, t, tr.boneHash));
      if (tr.translations) p.fromArray(sampleTrackTranslation(clip, t, tr.boneHash));
      else if (rule === 'animation' || (rule === 'hips' && b.parent >= 0 && skel.bones[b.parent].parent < 0)) p.fromArray(tr.constantTranslation);
    }
    const m = new THREE.Matrix4().compose(p, q, one);
    world[b.index] = b.parent >= 0 ? world[b.parent].clone().multiply(m) : m;
    out[b.index] = new THREE.Vector3().setFromMatrixPosition(world[b.index]);
  }
  return out;
}

/** Bones that skin at least one vertex. */
export function skinningBones(skinned: SkinnedModel): Uint8Array {
  const skel = skinned.skeleton;
  const w = new Uint8Array(skel.bones.length);
  for (let i = 0; i < skel.skinIndex.length; i++) if (skel.skinWeight[i] > 0 && skel.skinIndex[i] < w.length) w[skel.skinIndex[i]] = 1;
  return w;
}

export interface PoseDelta {
  /** Largest move of a vertex-skinning bone with the root's move removed (m). */
  mesh: number;
  meshBone: number;
  /** Move of the root bone (m). */
  root: number;
}

/** Pose difference between an old rule and the engine's at the clip's start, middle and end. */
export function poseDelta(skinned: SkinnedModel, clip: AnimClipData, from: 'bind' | 'hips' = 'bind'): PoseDelta {
  const r: PoseDelta = { mesh: 0, meshBone: -1, root: 0 };
  const skins = skinningBones(skinned);
  for (const t of [0, clip.duration / 2, clip.duration]) {
    const a = posePositions(skinned, clip, t, from), b = posePositions(skinned, clip, t, 'animation');
    const rootD = b[0].clone().sub(a[0]);
    r.root = Math.max(r.root, rootD.length());
    for (let i = 0; i < a.length; i++) {
      const s = b[i].clone().sub(rootD).distanceTo(a[i]);
      if (skins[i] && s > r.mesh) (r.mesh = s), (r.meshBone = i);
    }
  }
  return r;
}

/** Median |constant| / |bind| over the clip's rotation-only non-root bones longer than 3 cm. */
export function lengthRatio(skinned: SkinnedModel, clip: AnimClipData): number {
  const skel = skinned.skeleton;
  const rs: number[] = [];
  for (const tr of clip.tracks) {
    if (tr.format !== TRACK_ROTATION) continue;
    const bi = skel.byHash.get(tr.boneHash);
    if (bi === undefined || skel.bones[bi].parent < 0) continue;
    const bl = Math.hypot(...skel.bones[bi].position);
    if (bl < 0.03) continue;
    rs.push(Math.hypot(...tr.constantTranslation) / bl);
  }
  rs.sort((x, y) => x - y);
  return rs.length ? rs[rs.length >> 1] : NaN;
}

/** Clip refs a template reaches through its Animation properties and referenced templates. */
export function templateClips(pkgs: EntityPackageSet, values: PropValue[], types: readonly number[], depth = 3, seen = new Set<string>()): ResRef[] {
  const out: ResRef[] = [];
  values.forEach((v, i) => {
    const base = (types[i] ?? 0) & 0xff;
    const refs = (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object' && 'pkg' in x && 'id' in x);
    for (const r of refs) {
      if (base === PropType.Animation) out.push(r);
      else if (base === PropType.Template && depth > 0) {
        const k = `${r.pkg}:${r.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const t = readObjectTemplate(pkgs, r);
        const cls = t && classByHash(t.classHash);
        if (t && cls) out.push(...templateClips(pkgs, decodeTemplateProps(cls, t), cls.types, depth - 1, seen));
      }
    }
  });
  return out;
}

interface Row {
  level: string;
  model: string;
  bones: number;
  clip: string;
  source: string;
  bind: PoseDelta;
  hips: PoseDelta;
  ratio: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.lvl')) out.push(p);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const levelFilter = (flag('--levels') ?? '0 prelude,1a,1b,1c,2 cell,3a,3b').split(',').map((s) => s.trimStart().toLowerCase());
  const MIN = Number(flag('--min') ?? 0.1);
  const TOP = Number(flag('--top') ?? 40);
  const bySet = args.includes('--sets');
  const levels = walk(join(DATA_ROOT, 'LEVELS')).filter((l) => levelFilter.some((f) => l.toLowerCase().split('/').pop()!.startsWith(f))).sort();
  const rows: Row[] = [];
  const seen = new Set<string>();
  let hash0 = 0, huge = 0, tracks = 0, rotTracks = 0;
  for (const lvlPath of levels) {
    const rel = lvlPath.slice(DATA_ROOT.length + 1);
    const lvl = new SrscFile(new Uint8Array(readFileSync(lvlPath)).buffer);
    const paths = new Map<number, string>();
    const pkgs: PackageSet = await loadPackages(nodeFS(), dirname(rel), readLevelHeader(lvl).dependencies, () => {}, paths);
    const epkgs = pkgs as unknown as EntityPackageSet;
    const level = rel.split('/').pop()!.replace(/\.lvl$/i, '');
    const clipCache = new Map<string, AnimClipData | null>();
    const clip = (r: ResRef) => {
      const k = `${r.pkg}:${r.id}`;
      if (!clipCache.has(k)) {
        const adu = pkgs.get(r.pkg)?.adu;
        const c = (adu && readAnimation(adu, r.id)) || null;
        clipCache.set(k, c);
        const ck = `clip ${paths.get(r.pkg)}#${r.id}`;
        if (c && !seen.has(ck)) {
          seen.add(ck);
          for (const t of c.tracks) {
            tracks++;
            if (t.boneHash === 0) hash0++;
            if (t.format === TRACK_ROTATION) {
              rotTracks++;
              if (Math.hypot(...t.constantTranslation) > 50) huge++;
            }
          }
        }
      }
      return clipCache.get(k) ?? undefined;
    };
    const models = new Map<string, SkinnedModel | null>();
    const model = (r: ResRef) => {
      const k = `${r.pkg}:${r.id}`;
      if (!models.has(k)) models.set(k, readSkinnedModel(pkgs, r) ?? null);
      return models.get(k) ?? undefined;
    };
    const pair = (m: ResRef, c: ResRef, source: string) => {
      const key = `${paths.get(m.pkg)}#${m.id}|${paths.get(c.pkg)}#${c.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sk = model(m), d = clip(c);
      if (!sk || !d || !d.tracks.some((t) => sk.skeleton.byHash.has(t.boneHash))) return;
      rows.push({ level, model: `${m.pkg}:${m.id}`, bones: sk.skeleton.bones.length, clip: `${c.pkg}:${c.id}`, source, bind: poseDelta(sk, d, 'bind'), hips: poseDelta(sk, d, 'hips'), ratio: lengthRatio(sk, d) });
    };
    if (bySet) {
      for (const [id, p] of pkgs) {
        if (!p.mdu || !p.adu) continue;
        for (const m of listSkinnedModels(p.mdu)) for (const c of listAnimations(p.adu, m.animSet)) pair({ pkg: id, id: m.id }, { pkg: id, id: c.id }, 'set');
      }
    } else {
      const ents = parseEntities(lvl, epkgs);
      const byUid = new Map(ents.map((e) => [e.uid, e]));
      for (const e of ents) {
        if (!e.modelRef || !model(e.modelRef)) continue;
        const cls = classByHash(e.classHash);
        for (const c of templateClips(epkgs, e.values, cls?.types ?? [])) pair(e.modelRef, c, e.className);
      }
      for (const e of ents.filter((x) => x.className === 'STOMP Player')) {
        const r = e.values[0] as ResRef | null;
        const q = r ? (pkgs.get(r.pkg) as { qdu?: SrscFile } | undefined)?.qdu : undefined;
        const seq = q && r ? parseStompSequence(q, r.id) : undefined;
        for (const t of seq?.tracks ?? []) {
          const m = byUid.get(t.uid)?.modelRef;
          if (m) for (const k of t.anims) pair(m, k.clip, `STOMP ${t.name}`);
        }
      }
    }
    console.error(`${level}: ${rows.length} pairs so far`);
  }

  const fmt = (n: number) => n.toFixed(3);
  console.log(`clip tracks ${tracks}, rotation-only ${rotTracks}, hash 0: ${hash0}, constants > 50 m: ${huge}`);
  console.log(`model / clip pairs: ${rows.length}`);
  console.log(`a vertex-skinning bone moves >= ${MIN} m: ${rows.filter((r) => r.bind.mesh >= MIN).length} against bind, ${rows.filter((r) => r.hips.mesh >= MIN).length} against bind + hips offset`);
  const odd = rows.filter((r) => r.ratio < 0.8 || r.ratio > 1.25);
  console.log(`pairs whose rotation-only lengths are off the rig's (median ratio outside 0.8..1.25): ${odd.length}`);
  for (const r of odd.slice(0, 20)) console.log(`  ${r.level} model ${r.model} clip ${r.clip} (${r.source}) ratio ${r.ratio.toFixed(2)} bind ${fmt(r.bind.mesh)}`);
  for (const k of ['bind', 'hips'] as const) {
    console.log(`\ntop ${TOP} pairs by the move against ${k === 'bind' ? 'bind' : 'bind + hips offset'}:`);
    console.log('level\tmodel\tbones\tclip\tsource\tmesh\tbone\troot\tratio');
    for (const r of [...rows].sort((a, b) => b[k].mesh - a[k].mesh).slice(0, TOP))
      console.log(`${r.level}\t${r.model}\t${r.bones}\t${r.clip}\t${r.source}\t${fmt(r[k].mesh)}\t${r[k].meshBone}\t${fmt(r[k].root)}\t${r.ratio.toFixed(2)}`);
  }
  const out = flag('--json');
  if (out) writeFileSync(out, JSON.stringify(rows));
}

if (process.argv[1]?.endsWith('clip-constants.ts')) {
  if (existsSync(join(DATA_ROOT, 'LEVELS'))) await main();
  else console.error(`no game data at ${DATA_ROOT}`);
}
