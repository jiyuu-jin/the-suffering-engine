// Surface ("Material Type") lookup for impacts and footsteps (docs/game-logic.md §17.1).
//
// Every engine material template (Simple / Advanced / Layered / Animating / Landscape) has a
// **Game Material Properties** template in word 0 [verified: the EXE warns "Material [0x%0x]
// refers to Material TYPE instead of Material PROPERTY!"]; its p0 is the **Material Type**, an
// empty marker template (33 of them in System pkg 2) that the per-material effect tables key on:
// Player / NPC Material Effects (footsteps), Missile / Melee Weapon Material Effects (impacts).
// The type names are not in the data; the port works with the refs.
//
// Where the material comes from:
//   - static level triangles: CollisionWorld.triPart -> LevelData.parts[i].material.key;
//   - floor layers (no material, landscape splats): the splat with the largest weight at the
//     nearest vertex; splat texture -> the Landscape Material template that uses it;
//   - dynamic bodies (props, doors): the model's first submesh material.

import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { LevelData } from '../../formats/types';
import type { ResRef } from '../../formats/model';
import type { CollisionWorld, RayHit } from '../../app/physics';
import type { DynamicObjects } from '../world/dynamic';

export const refKey = (r: ResRef) => `${r.pkg}:${r.id}`;
const isRef = (v: unknown): v is ResRef => !!v && typeof v === 'object' && !Array.isArray(v);
export const refsOf = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter(isRef);

/**
 * Water surfaces of the level (set by the levels system, src/game/levels/water.ts): surface
 * height above a point and the water's Material Type ("pkg:id").
 */
export const waterSurfaces: {
  at?: (x: number, y: number, z: number) => number | undefined;
  type?: string;
  /** The player's wading thresholds (Player p21 / p25, levels/water.ts wadingStep). */
  wade?: { shallow: number; deep: number };
} = {};

export interface SurfaceInfo {
  /** Material Type template "pkg:id", or null when unknown (effect tables then use their default entry). */
  type: string | null;
  /** Engine material template "pkg:id" the type came from. */
  material?: string;
  /**
   * Its Game Material Properties template "pkg:id" (material word 0): p2 hardness, p4 % of
   * speed a bounce loses on it (BouncingObject, RFL 0x1009a8c0).
   */
  gmp?: string | null;
}

export interface MaterialEffectsEntry {
  ref: ResRef;
  cls: string;
  values: PropValue[];
  /** Template model (Decal quads, effect models). */
  model?: ResRef;
}

const LANDSCAPE = new Set([0xb13556e7, 0x8c84cce7]);

export class Surfaces {
  private typeByMaterial = new Map<string, string | null>();
  private gmpByMaterial = new Map<string, string | null>();
  private typeByLandTexture?: Map<string, string>;
  private materialByLandTexture = new Map<string, string>();
  private templates = new Map<string, MaterialEffectsEntry | null>();

  constructor(
    private readonly pkgs: EntityPackageSet,
    private readonly level: LevelData | undefined,
    private readonly collision: () => CollisionWorld | null,
    private readonly dyn?: DynamicObjects,
  ) {}

  /** Decoded template (cached). */
  template(r: ResRef | null | undefined): MaterialEffectsEntry | undefined {
    if (!r) return undefined;
    const k = refKey(r);
    let t = this.templates.get(k);
    if (t === undefined) {
      const o = readObjectTemplate(this.pkgs, r);
      const c = o && classByHash(o.classHash);
      t = o && c ? { ref: r, cls: c.name, values: decodeTemplateProps(c, o), model: o.modelRef } : null;
      this.templates.set(k, t);
    }
    return t ?? undefined;
  }

  /** Material template "pkg:id" -> Material Type "pkg:id" (word 0 -> Game Material Properties p0). */
  typeOfMaterial(key: string | undefined): string | null {
    if (!key) return null;
    let t = this.typeByMaterial.get(key);
    if (t !== undefined) return t;
    t = null;
    const [pkg, id] = key.split(':').map(Number);
    const m = this.template({ pkg, id });
    const gmp = m && isRef(m.values[0]) ? this.template(m.values[0] as ResRef) : undefined;
    if (gmp?.cls === 'Game Material Properties' && isRef(gmp.values[0])) t = refKey(gmp.values[0] as ResRef);
    else if (gmp?.cls === 'Material Type') t = refKey(gmp.ref);
    this.typeByMaterial.set(key, t);
    return t;
  }

  /** Material template "pkg:id" -> its Game Material Properties "pkg:id" (word 0), or null. */
  gmpOfMaterial(key: string | undefined): string | null {
    if (!key) return null;
    let g = this.gmpByMaterial.get(key);
    if (g !== undefined) return g;
    const [pkg, id] = key.split(':').map(Number);
    const m = Number.isFinite(pkg) && Number.isFinite(id) ? this.template({ pkg, id }) : undefined;
    const w0 = m && isRef(m.values[0]) ? this.template(m.values[0] as ResRef) : undefined;
    g = w0?.cls === 'Game Material Properties' ? refKey(w0.ref) : null;
    this.gmpByMaterial.set(key, g);
    return g;
  }

  /** Landscape splat texture -> Material Type, from every Landscape Material template loaded. */
  private landTypes(): Map<string, string> {
    if (this.typeByLandTexture) return this.typeByLandTexture;
    const m = new Map<string, string>();
    for (const [pkg, p] of this.pkgs as Map<number, { odu?: { entries: { type: number; id: number }[] } }>) {
      for (const e of p.odu?.entries ?? []) {
        if (e.type !== 2) continue;
        const o = readObjectTemplate(this.pkgs, { pkg, id: e.id });
        if (!o || !LANDSCAPE.has(o.classHash >>> 0)) continue;
        const v = decodeTemplateProps(classByHash(o.classHash), o);
        const tex = v[3], type = this.typeOfMaterial(`${pkg}:${e.id}`);
        if (isRef(tex) && type && !m.has(refKey(tex))) {
          m.set(refKey(tex), type);
          this.materialByLandTexture.set(refKey(tex), `${pkg}:${e.id}`);
        }
      }
    }
    return (this.typeByLandTexture = m);
  }

  /** Surface of a collision hit. */
  atHit(hit: Pick<RayHit, 'part' | 'dynamic' | 'point'>): SurfaceInfo {
    if (hit.dynamic !== undefined) {
      const uid = this.dyn?.uidOfBody(hit.dynamic);
      const d = uid !== undefined ? this.dyn?.objects.get(uid) : undefined;
      // (A model spawned during play, broken remains or debris, has no level entity: its own model.)
      const model = d?.entity?.modelRef ? this.dyn?.modelByRef(d.entity.modelRef) : d?.model;
      const mat = model?.materials[0];
      const key = mat ? refKey(mat) : undefined;
      return { type: this.typeOfMaterial(key), material: key, gmp: this.gmpOfMaterial(key) };
    }
    // Static hits index the collision parts when the level has them (docs/game-logic.md §14.10).
    const part = (this.level?.collision ?? this.level?.parts)?.[hit.part];
    if (!part) return { type: null };
    if (part.material?.key) {
      const t = this.typeOfMaterial(part.material.key);
      if (t) return { type: t, material: part.material.key, gmp: this.gmpOfMaterial(part.material.key) };
    }
    if (part.splat?.length && part.splatWeights) {
      // Nearest vertex of the part, then its heaviest splat.
      const P = part.positions, [x, y, z] = hit.point;
      let best = -1, bd = Infinity;
      for (let i = 0, n = P.length / 3; i < n; i++) {
        const dx = P[3 * i] - x, dy = P[3 * i + 1] - y, dz = P[3 * i + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) (bd = d), (best = i);
      }
      if (best >= 0) {
        let k = 0, w = -1;
        for (let s = 0; s < part.splat.length; s++) {
          const ws = part.splatWeights[8 * best + s];
          if (ws > w) (w = ws), (k = s);
        }
        const t = this.landTypes().get(part.splat[k].texture);
        if (t) return { type: t, material: `splat:${part.splat[k].texture}`, gmp: this.gmpOfMaterial(this.materialByLandTexture.get(part.splat[k].texture)) };
      }
    }
    return { type: null, material: part.material?.key, gmp: this.gmpOfMaterial(part.material?.key) };
  }

  /**
   * Baked light (vertex colour x the static gain) around a point on the given level parts:
   * inverse-distance average of the part vertices within 1.5 units.
   */
  lightAt(point: { x: number; y: number; z: number }, parts: Iterable<number>, gain = 3): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0, wsum = 0;
    for (const i of parts) {
      const part = this.level?.parts[i];
      const C = part?.colors;
      if (!part || !C) continue;
      const P = part.positions;
      const cs = C.length / (P.length / 3);
      for (let v = 0, n = P.length / 3; v < n; v++) {
        const dx = P[3 * v] - point.x, dy = P[3 * v + 1] - point.y, dz = P[3 * v + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 2.25) continue;
        const w = 1 / (d2 + 0.05);
        r += C[cs * v] * w;
        g += C[cs * v + 1] * w;
        b += C[cs * v + 2] * w;
        wsum += w;
      }
    }
    if (!wsum) return { r: 1, g: 1, b: 1 };
    const k = gain / wsum;
    return { r: Math.min(1.5, r * k), g: Math.min(1.5, g * k), b: Math.min(1.5, b * k) };
  }

  /**
   * Surface under a point (ray straight down, up to `maxDrop` units). A point under a Water
   * Volume surface (src/game/levels/water.ts, waterSurfaces) stands on water: its Material
   * Type, at the water level, so footsteps pick the Player / NPC Water Material Effects entry.
   */
  below(x: number, y: number, z: number, maxDrop = 1.5): (SurfaceInfo & { y: number }) | null {
    const wy = waterSurfaces.type ? waterSurfaces.at?.(x, y, z) : undefined;
    if (wy !== undefined && wy >= y - 0.25) return { type: waterSurfaces.type!, y: wy };
    const c = this.collision();
    const h = c?.raycast(x, y + 0.3, z, 0, -1, 0, maxDrop + 0.3);
    if (!h) return null;
    return { ...this.atHit(h), y: h.point[1] };
  }

  /**
   * Entry of a per-material effects list (Player / NPC / Missile / Melee Weapon Material Effects,
   * p0 = Material Type) for a surface: the entry for that type, else the entry with no type
   * (the table's default), else none [verified for footsteps: RFL 0x100b05b0 matches the type,
   * falling back to the untyped entry].
   */
  pick(list: PropValue | undefined, type: string | null): MaterialEffectsEntry | undefined {
    let fallback: MaterialEffectsEntry | undefined;
    for (const r of refsOf(list)) {
      const t = this.template(r);
      if (!t) continue;
      const tt = isRef(t.values[0]) ? refKey(t.values[0] as ResRef) : null;
      if (type && tt === type) return t;
      if (!tt && !fallback) fallback = t;
    }
    return fallback;
  }
}
