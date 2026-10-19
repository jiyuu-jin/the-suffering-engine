// Load-time lighting of geometry that has no .ldu colours (docs/re/renderer.md §1.6, §1.9).
//
// SUFFERING.EXE gives an object with precomputed colours only the lights with flag 2
// (switchable) at run time; static lights reach it through those colours. For .ldu geometry the
// colours are the editor's bake (static lights only, stored at half the light). An object
// WITHOUT .ldu colours gets them from a CPU pass instead (0x4ca3a0, reached only through scene
// object vtable +0x84 = 0x4ca6c0): the shader's equation over the object's uploaded light list
// (0x4c0a40 / 0x4c0900):
//
//   colour = ambient + Σ dir colour × max(N·L, 0) + Σ point colour × min(I / d², 2) × max(N·L̂, 0)
//                                                            (d < cull radius, no hemisphere test)
//
// stored clamped to 0..1, not halved (0x4c0480), into a run-time colour resource that 0x4cb1f0
// creates and names at object +0x6c. From then on the object counts as precomputed (0x4cade0:
// +0x6c names a loaded type-9 resource): drawn by xvsLightPrecomputed (2 × colour) plus the
// switchable lights per frame, never lit again, no rim, no per-frame ambient or directional
// light [verified code]. A switchable light that was in the pass counts three times (twice
// through the colours, once per frame) and the ambient twice.
//
// When it runs [verified code]: +0x84 is called only by the draw functions 0x4930f0 / 0x492950,
// so at the object's first draw, right after the frame's gather (+0x164 = 0x4cade0). The light
// set is created by that first gather (0x457810, marked dirty), so the gather is a full one
// (0x4ca730): every light the light manager returns for the object's box, of which point and
// spot lights must be on (light +0xc bit 0; turning a light off removes it from every light set,
// 0x4c8320 → 0x4c7d00), ambient and directional lights by region; at most 5 point lights and 8
// entries in all are uploaded (0x4cff10). Every light also has to belong to a group that holds
// the object (`group`, below). Once the colours exist the pass does not run again: switching
// lights only adds them to or removes them from light sets (0x4c8ea0 / 0x4c7d00), which reach a
// precomputed object per frame, switchable ones only.
//
// What the port bakes [port decision, inferred]: only lights that are not switchable (no flag 2),
// with the ambient and the directional base lights. By the code a switchable lamp that is on at
// the first draw goes into the colours (the upload only drops non-switchable lights once the
// object is precomputed, 0x4cff10). But no capture shows a lamp in such colours. Colours that
// hold a lamp also stay lit after the lamp goes out: the 1a fallen cell door 848d (hidden at
// start) stayed bright in the dark. Switchable lights reach these objects per frame (lights.ts,
// engine-light.ts), so they still follow switching.
//
// Which lights that is for an object visible from the start is an open question: the code puts
// the pass at the first draw, when every light exists, yet the 1a cell doors (shown at start,
// created before every cell lamp and the root Ambient Light) are drawn in the PC captures with
// black colours (lamps per frame only, no ambient), and rendering them with every light blows
// them out (docs/re/renderer.md §1.9). The port keeps the lights created before such an object
// (`before`: its level object index), which reproduces the doors [inferred from data; no code
// path found]. An object hidden at start is first drawn after the logic shows it and gets every
// static light that is on at load (world/dynamic.ts loadPassBefore) [port: the lights on at load
// stand for those on when it is shown].
//
// Floor layers without .ldu colours take the same path (0x4c1900: a grid of colours from the
// layer's own gather, all lights, 0x4c1f8a). Their pass expects the root Ambient Light to exist
// ("Layer: No ambient light - most likely missing from ROOT NODE!"), so it is taken to see every
// light [inferred], static ones only as above [port].
//
// Pure arithmetic over parsed entities: no three.js.

import { entityBoxCorners, type Entity } from './entities';
import { instanceRotation } from './level';
import {
  applicableDirectionals,
  applicableRegions,
  directionalRole,
  pointLightCullRadius,
  pointLightInfluence,
  pointLightLevel,
  pointLightSwitchable,
  SHADER_POINT_LIGHTS,
} from './render-data';
import type { LightRegion, SectorTree } from './visgraph';

/** A Point Light that is on when the level loads (output space: model units, engine axes). */
export interface StaticPointLight {
  x: number;
  y: number;
  z: number;
  /** Strength I = p8 (m²): level min(I / d², 2). */
  intensity: number;
  /** Engine colour: bytes / 255, negated when p1 is set. */
  rgb: [number, number, number];
  /** Cull radius (pointLightCullRadius): no light at or beyond it. */
  cull: number;
  /**
   * Switchable (light flag 2): also lights precomputed geometry per frame (engine-light.ts), on
   * top of what the load-time pass put into the colours. Static lights: false / absent.
   */
  switchable?: boolean;
  /** Creation order: the light's index among the level's objects (absent: before everything). */
  order?: number;
  /**
   * Sector-tree record of the light's group (its nearest named-group ancestor, sectorGroups):
   * the light reaches only objects inside that group (absent: everywhere).
   */
  group?: number;
}

/**
 * The group rule of the light gather [verified: 0x4ca730 → 0x4b5930 / 0x4b5aa0, groups from the
 * sector tree reader 0x4b9af0]. A light is registered under the nearest group (kind-1 node, node
 * flag 2) above it (0x4c91b0 → 0x4b5930 → 0x4b6570), and the object gather keeps a light only
 * when that group is the object's node or one of its ancestors (unless the object has +8 bit 18
 * or +0xc bit 13 set; neither is set on placed props). So a lamp under "cell 4" lights nothing in
 * "cell 6" through the gather, while one under the level's root group reaches everything.
 * `groupOf(uid)`: that group of a placed object / light; `chain(uid)`: every group above it.
 */
export function sectorGroups(tree: SectorTree): { groupOf(uid: number): number | undefined; chain(uid: number): readonly number[] } {
  const leaf = new Map<number, number>();
  for (const n of tree.nodes) if (n.kind >= 2 && !leaf.has(n.id)) leaf.set(n.id, n.index);
  const memo = new Map<number, number[]>();
  const above = (index: number): number[] => {
    const known = memo.get(index);
    if (known) return known;
    const out: number[] = [];
    for (let p = tree.nodes[index - 1]?.parent ?? 0, guard = 0; p && guard < 4096; p = tree.nodes[p - 1]?.parent ?? 0, guard++) {
      if (tree.nodes[p - 1]?.kind === 1) out.push(p);
    }
    memo.set(index, out);
    return out;
  };
  return {
    groupOf: (uid) => {
      const i = leaf.get(uid);
      return i === undefined ? undefined : above(i)[0];
    },
    chain: (uid) => {
      const i = leaf.get(uid);
      return i === undefined ? [] : above(i);
    },
  };
}

/**
 * An Ambient Light with a region: its parent group's box in the sector tree (output space), or
 * its scaled box on levels without a tree, with its colour.
 */
export interface AmbientRegion {
  min: [number, number, number];
  max: [number, number, number];
  rgb: [number, number, number];
  /** p8 (flag 0x400): hides the larger regions (default true, every retail Ambient Light). */
  exclusive?: boolean;
  /** Creation order (level object index; absent: before everything). */
  order?: number;
}

/**
 * A Directional Light's own (base) light that is on when the level loads: colour × max(N·dir, 0)
 * (xvsLightDir.vsh, 0x4c0a40), in its parent group's box (no box: everywhere). Rim lights are
 * left out: the gather takes them only for dynamic objects (0x4cab22).
 */
export interface StaticDirectional {
  /** Unit vector towards the light (the object's local +Z, 0x4c9890). */
  dir: [number, number, number];
  rgb: [number, number, number];
  min?: [number, number, number];
  max?: [number, number, number];
  /** p8 (flag 0x400): hides the directional lights of larger regions. */
  exclusive: boolean;
  /** Creation order (level object index; absent: before everything). */
  order?: number;
}

/** Default ambient when a level has no unscaled Ambient Light (engine-light rig, lights.ts). */
export const DEFAULT_AMBIENT: [number, number, number] = [0.15, 0.15, 0.15];

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isRef = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && !!((v as { pkg?: number }).pkg || (v as { id?: number }).id);
const engineRgb = (v: unknown, negative: boolean): [number, number, number] => {
  const c = num(v) >>> 0;
  const s = negative ? -1 : 1;
  return [(((c >> 16) & 255) / 255) * s, (((c >> 8) & 255) / 255) * s, ((c & 255) / 255) * s];
};
const boxVolume = (min: readonly number[], max: readonly number[]) => (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);

/** Switchable test of a parsed Point Light entity (render-data.ts pointLightSwitchable). */
export function isSwitchablePointLight(e: Pick<Entity, 'values' | 'links'>): boolean {
  const v = e.values;
  return pointLightSwitchable({ links: e.links?.length ?? 0, p2: num(v[2]), p3: isRef(v[3]), p4: num(v[4]), p5: num(v[5]), p6: num(v[6], 1), p7: num(v[7]) });
}

/**
 * Colour the load-time pass stores for a light sum (0x4c0480): each channel clamped to 0..1,
 * not halved. Drawn through xvsLightPrecomputed it lights the surface with 2 × this.
 */
export function loadTimeColor(sum: number): number {
  return Math.min(1, Math.max(0, sum));
}

/** Does a light created at `order` exist when the object at index `before` loads? */
const exists = (order: number | undefined, before: number | undefined) => before === undefined || order === undefined || order < before;

export class StaticLighting {
  constructor(
    /** Point Lights on at load (static and switchable). */
    readonly lights: StaticPointLight[],
    readonly ambient: [number, number, number],
    readonly regions: AmbientRegion[],
    readonly directionals: StaticDirectional[] = [],
    /** Creation order of the global Ambient Light (absent: before everything). */
    readonly ambientOrder?: number,
    /** Groups above a placed object (sectorGroups chain), for the lights' `group`. */
    readonly groupsOf?: (uid: number) => readonly number[],
  ) {}

  /** May a light of `group` reach the object `uid` (the gather's group rule, sectorGroups)? */
  private reaches(group: number | undefined, uid: number | undefined): boolean {
    if (group === undefined || uid === undefined || !this.groupsOf) return true;
    const chain = this.groupsOf(uid);
    return !chain.length || chain.includes(group);
  }

  /**
   * The point lights an object with this bounding sphere gets at load: those whose cull sphere
   * touches it (0x4c8ea0), strongest at its centre first (0x4c7ed0), at most 5 (0x4cff10); with
   * `uid` (the object's) only lights whose group holds it (sectorGroups). Switchable lights are
   * left out: they light the object per frame (see the header) [port].
   */
  lightsFor(cx: number, cy: number, cz: number, r: number, before?: number, uid?: number): StaticPointLight[] {
    const hit: { l: StaticPointLight; k: number }[] = [];
    for (const l of this.lights) {
      if (l.switchable || !exists(l.order, before) || !this.reaches(l.group, uid)) continue;
      const d2 = (l.x - cx) ** 2 + (l.y - cy) ** 2 + (l.z - cz) ** 2;
      const reach = l.cull + r;
      if (!(l.cull > 0) || d2 >= reach * reach) continue;
      hit.push({ l, k: pointLightInfluence(l.intensity, l.rgb, d2, l.cull) });
    }
    hit.sort((a, b) => b.k - a.k);
    return hit.slice(0, SHADER_POINT_LIGHTS).map((h) => h.l);
  }

  /**
   * Directional base lights of an object at (x, y, z) (0x4ca730, render-data.ts
   * applicableDirectionals for a non-dynamic object): those whose region holds it, smallest
   * first, up to and including the first exclusive one.
   */
  directionalsAt(x: number, y: number, z: number, before?: number): StaticDirectional[] {
    const hit: (StaticDirectional & { volume: number; rim: false })[] = [];
    for (const d of this.directionals) {
      if (!exists(d.order, before)) continue;
      if (d.min && d.max && (x < d.min[0] || x > d.max[0] || y < d.min[1] || y > d.max[1] || z < d.min[2] || z > d.max[2])) continue;
      hit.push({ ...d, volume: d.min && d.max ? boxVolume(d.min, d.max) : Infinity, rim: false });
    }
    return applicableDirectionals(hit, false);
  }

  /**
   * Ambient of an object at (x, y, z) (0x4ca730, render-data.ts applicableRegions): the Ambient
   * Light regions holding it, smallest first, summed up to the first exclusive one, which with
   * every retail light exclusive is the smallest; the global ambient (root group) is the largest.
   */
  ambientAt(x: number, y: number, z: number, before?: number): [number, number, number] {
    const global: [number, number, number] = exists(this.ambientOrder, before) ? this.ambient : [0, 0, 0];
    const hit: { volume: number; exclusive: boolean; rgb: [number, number, number] }[] = [];
    for (const b of this.regions) {
      if (!exists(b.order, before)) continue;
      if (x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1] || z < b.min[2] || z > b.max[2]) continue;
      hit.push({ volume: boxVolume(b.min, b.max), exclusive: b.exclusive !== false, rgb: b.rgb });
    }
    if (!hit.length) return global;
    const use = applicableRegions(hit);
    if (use.length === 1 && use[0].exclusive) return use[0].rgb;
    const out: [number, number, number] = [0, 0, 0];
    for (const h of use) for (let k = 0; k < 3; k++) out[k] += h.rgb[k];
    if (!use[use.length - 1].exclusive) for (let k = 0; k < 3; k++) out[k] += global[k];
    return out;
  }

  /**
   * The load-time light list of an object with this bounding sphere (0x4cade0 before its
   * colours exist): ambient, directional base lights and point lights at its centre, of the
   * lights created before it (`before`: its level object index; absent: every light) and, given
   * the object's `uid`, in a group that holds it.
   */
  setFor(cx: number, cy: number, cz: number, r: number, before?: number, uid?: number): LoadTimeSet {
    return { lights: this.lightsFor(cx, cy, cz, r, before, uid), ambient: this.ambientAt(cx, cy, cz, before), directionals: this.directionalsAt(cx, cy, cz, before) };
  }

  /**
   * Vertex colour (0..1, rgb into out[o..o+2]) of a vertex lit by `ambient` + `directionals` +
   * `lights`, as the load-time pass stores it (loadTimeColor: the sum clamped, not halved).
   */
  shade(
    lights: readonly StaticPointLight[],
    ambient: readonly number[],
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    out: Float32Array | number[],
    o: number,
    directionals: readonly StaticDirectional[] = [],
  ) {
    let r = ambient[0], g = ambient[1], b = ambient[2];
    for (const d of directionals) {
      const k = nx * d.dir[0] + ny * d.dir[1] + nz * d.dir[2];
      if (!(k > 0)) continue;
      r += d.rgb[0] * k;
      g += d.rgb[1] * k;
      b += d.rgb[2] * k;
    }
    for (const l of lights) {
      const dx = l.x - px, dy = l.y - py, dz = l.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!(d2 < l.cull * l.cull)) continue;
      const d = Math.sqrt(d2);
      const ndl = d > 0 ? (nx * dx + ny * dy + nz * dz) / d : 0;
      if (!(ndl > 0)) continue;
      const k = pointLightLevel(l.intensity, d2) * ndl;
      r += l.rgb[0] * k;
      g += l.rgb[1] * k;
      b += l.rgb[2] * k;
    }
    out[o] = loadTimeColor(r);
    out[o + 1] = loadTimeColor(g);
    out[o + 2] = loadTimeColor(b);
  }

  /** shade() with a LoadTimeSet. */
  shadeSet(set: LoadTimeSet, px: number, py: number, pz: number, nx: number, ny: number, nz: number, out: Float32Array | number[], o: number) {
    this.shade(set.lights, set.ambient, px, py, pz, nx, ny, nz, out, o, set.directionals);
  }
}

/** What an object's load-time pass is computed from (StaticLighting.setFor). */
export interface LoadTimeSet {
  lights: StaticPointLight[];
  ambient: readonly number[];
  directionals: StaticDirectional[];
}

/**
 * Load-time lighting of a level from its parsed entities: the Point Lights that are on at start
 * and created (instance flag 0x8 objects never are), static and switchable; the Directional
 * Lights' base lights that are on at start; the Ambient Lights; each with its creation order
 * (entity index, setFor's `before`). With `lightRegions`
 * (visgraph.ts) an Ambient / Directional Light applies within its parent group's box and one
 * under the root group everywhere (docs/re/renderer.md §1.4); without (no sector tree) the
 * unscaled Ambient Light is global, scaled ones are boxes, and Directional Lights are left out.
 * With the sector `tree` every Point Light carries its group and setFor(…, uid) applies the
 * group rule (sectorGroups).
 */
export function staticLightingFromEntities(ents: readonly Entity[], lightRegions?: ReadonlyMap<number, LightRegion>, tree?: SectorTree): StaticLighting {
  const groups = tree ? sectorGroups(tree) : undefined;
  const lights: StaticPointLight[] = [];
  const regions: AmbientRegion[] = [];
  const directionals: StaticDirectional[] = [];
  let ambient: [number, number, number] | undefined;
  let ambientOrder: number | undefined;
  for (const e of ents) {
    if (e.flags & 0x8) continue;
    const order = e.index;
    const v = e.values;
    if (e.className === 'Point Light') {
      // Off at start (p6 = 0): not in the load-time gather.
      if (num(v[6], 1) === 0) continue;
      const rgb = engineRgb(v[0], !!num(v[1]));
      const intensity = num(v[8]);
      const cull = pointLightCullRadius(intensity, rgb);
      if (!(cull > 0)) continue;
      const l: StaticPointLight = { x: e.position[0] / 2048, y: e.position[1] / 2048, z: e.position[2] / 2048, intensity, rgb, cull, order };
      if (isSwitchablePointLight(e)) l.switchable = true;
      const group = groups?.groupOf(e.uid);
      if (group !== undefined) l.group = group;
      lights.push(l);
    } else if (e.className === 'Directional Light') {
      const role = directionalRole({ p2: num(v[2]), p3: isRef(v[3]), p4: num(v[4]), p5: num(v[5]), p6: num(v[6], 1), rim: isRef(v[9]), links: e.links?.length ?? 0 });
      const reg = lightRegions?.get(e.uid);
      if (!role.base || !role.on || !reg) continue;
      const rgb = engineRgb(v[0], !!num(v[1]));
      const exclusive = num(v[8], 1) !== 0;
      if (!exclusive && !rgb[0] && !rgb[1] && !rgb[2]) continue;
      const m = instanceRotation(e.rotation);
      const len = Math.hypot(m[2], m[5], m[8]) || 1;
      const d: StaticDirectional = { dir: [m[2] / len, m[5] / len, m[8] / len], rgb, exclusive, order };
      if (reg.box) (d.min = [reg.box[0], reg.box[1], reg.box[2]]), (d.max = [reg.box[3], reg.box[4], reg.box[5]]);
      directionals.push(d);
    } else if (e.className === 'Ambient Light') {
      const rgb = engineRgb(v[0], false);
      const exclusive = num(v[8], 1) !== 0;
      const reg = lightRegions?.get(e.uid);
      if (reg) {
        if (!reg.box) {
          if (!ambient) (ambient = rgb), (ambientOrder = order);
        } else regions.push({ min: [reg.box[0], reg.box[1], reg.box[2]], max: [reg.box[3], reg.box[4], reg.box[5]], rgb, exclusive, order });
        continue;
      }
      const corners = e.scale ? entityBoxCorners(e as Entity, instanceRotation) : undefined;
      if (!corners) {
        if (!ambient) (ambient = rgb), (ambientOrder = order);
        continue;
      }
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const c of corners) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], c[k] / 2048);
          max[k] = Math.max(max[k], c[k] / 2048);
        }
      }
      regions.push({ min, max, rgb, exclusive, order });
    }
  }
  return new StaticLighting(lights, ambient ?? DEFAULT_AMBIENT, regions, directionals, ambient ? ambientOrder : undefined, groups?.chain);
}
