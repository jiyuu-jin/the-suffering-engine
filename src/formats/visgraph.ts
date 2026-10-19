// Riot Engine visibility data: the sector tree (.lvl type 0x26), the zone / portal graph
// (.lvl type 0x27) and the Portal objects that link zones. See docs/game-logic.md §18.
//
// Sector tree (type 0x26) [verified: all 18 retail levels parse to the exact end]
// ------------------------------------------------------------------------------
//   u32 h0 (20..40), u32 h1 (= number of kind 0/1 nodes), u32 h2, u32 h3, u32 h4 (unknown)
//   then records until the end, numbered from 1 in file order:
//     u32 kind      0 = automatic split node ("Node 0, 0 [1B]"), 1 = named editor group
//                   ("Backstage", "1st floor"), 2 = placed object leaf, 3 = floor-layer leaf
//     u32 flags     0x18, sometimes | 1 (meaning unknown)
//     u16 parent, u16 firstChild, u16 nextSibling     record numbers (0 = none)
//     f32[6] box    max xyz, then min xyz (engine units, engine space) of everything below
//     u32 id        kind 2: object uid; kind 3: floor-layer uid; kind 0/1: editor id
//     kind 0/1 only: u16 len + name (NUL padded)
//   Every renderable object (statics, lights, props, NPCs, detectors...) and every floor layer
//   is a leaf. Pure logic objects (relays, timers, move nodes, portals...) are not in the tree.
//
// Zone graph (type 0x27) [verified]
// ---------------------------------
//   u32 zoneCount
//   zoneCount x { u32 node (sector tree record number of a kind-1 group = the zone),
//                 u32 n, n x { u32 portalUid, u16 neighbourZone, u16 flags } }
//       portalUid 0xffffffff with flags & 2: open adjacency without a portal object
//       flags & 4: which side of the portal box this zone is on (each portal is listed by
//       both of its zones, once with 4 and once without)
//   u32 wordCount, then zoneCount x { u16 n, n x u16 zone }: per zone, the zones that can be
//       seen from it through portals (precomputed; always includes the zone itself; open
//       adjacencies are not followed).
//   Levels without zones store 8 bytes (zoneCount 0, wordCount 0).
//
// Portal object (class 0x5b0bad74, engine class in SUFFERING.EXE) [strong]
// ----------------------------------------------------------------------
//   Volume = template box (unit cube) x instance scale, like Detectors.
//   p0 starts closed (doors: 1), p1 / p2 / p3 flags + Sound Occlusion Template (sound),
//   p4 linked object (the door Switch), p5 input that opens it (default Enable),
//   p6 input that closes it (default Disable). Doors send Enable when they start to open
//   and Disable when they have closed.

import type { SrscFile } from './srsc';
import { instanceRotation, parseLevelObjects, WORLD_SCALE, type LevelObject } from './level';
import { entityFromObject, readObjectTemplate, type EntityPackageSet } from './entities';

export const LVL_SECTOR_TREE = 0x26;
export const LVL_ZONE_GRAPH = 0x27;
export const PORTAL_CLASS = 0x5b0bad74;
/** portalUid of a zone link that has no portal object (always open). */
export const OPEN_LINK = 0xffffffff;

export interface SectorNode {
  /** Record number (1-based, file order): what parent / child / sibling refer to. */
  index: number;
  kind: 0 | 1 | 2 | 3;
  flags: number;
  parent: number;
  firstChild: number;
  nextSibling: number;
  /** Engine units: [minX, minY, minZ, maxX, maxY, maxZ]. */
  box: [number, number, number, number, number, number];
  /** Object uid (kind 2), floor-layer uid (kind 3) or editor id (kind 0/1). */
  id: number;
  name?: string;
}

export interface SectorTree {
  header: number[];
  /** nodes[i] has index i + 1. */
  nodes: SectorNode[];
}

export function parseSectorTree(lvl: SrscFile): SectorTree | undefined {
  const e = lvl.entries.find((x) => x.type === LVL_SECTOR_TREE);
  if (!e || e.size < 20) return undefined;
  const v = lvl.data(e);
  const header = [0, 1, 2, 3, 4].map((i) => v.getUint32(4 * i, true));
  const nodes: SectorNode[] = [];
  let p = 20;
  while (p + 42 <= v.byteLength) {
    const kind = v.getUint32(p, true);
    if (kind > 3) throw new Error(`sector tree: unknown node kind ${kind} at ${p}`);
    const f = (i: number) => v.getFloat32(p + 14 + 4 * i, true);
    const node: SectorNode = {
      index: nodes.length + 1,
      kind: kind as SectorNode['kind'],
      flags: v.getUint32(p + 4, true),
      parent: v.getUint16(p + 8, true),
      firstChild: v.getUint16(p + 10, true),
      nextSibling: v.getUint16(p + 12, true),
      box: [f(3), f(4), f(5), f(0), f(1), f(2)],
      id: v.getUint32(p + 38, true),
    };
    p += 42;
    if (kind <= 1) {
      const len = v.getUint16(p, true);
      let s = '';
      for (let i = 0; i < len; i++) {
        const c = v.getUint8(p + 2 + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      node.name = s;
      p += 2 + len;
    }
    nodes.push(node);
  }
  return { header, nodes };
}

/**
 * Where an Ambient / Directional Light applies (docs/re/renderer.md §1.4) [strong]: the light
 * is registered with its parent node of the sector tree, and the object-side gather (0x4ca730)
 * takes the lights whose node box overlaps the object, ordering them by that box's volume
 * (comparator 0x4c9bc0 → 0x4d51b0). A light under the root node applies everywhere.
 */
export interface LightRegion {
  /** Output-space box [minX, minY, minZ, maxX, maxY, maxZ] of the parent node; null = root (everywhere). */
  box: [number, number, number, number, number, number] | null;
  /** Volume of `box` (output units³); Infinity for the root. */
  volume: number;
  /** Name of the parent group ("Backstage", "Node 0, 0"). */
  name: string;
}

/** Regions of the objects `uids` (all leaves when omitted) from their parent node in the sector tree. */
export function lightRegions(tree: SectorTree, uids?: Iterable<number>): Map<number, LightRegion> {
  const want = uids ? new Set(uids) : undefined;
  const S = 1 / WORLD_SCALE;
  const out = new Map<number, LightRegion>();
  for (const n of tree.nodes) {
    if (n.kind !== 2 || (want && !want.has(n.id))) continue;
    const p = tree.nodes[n.parent - 1];
    if (!p) continue;
    if (!p.parent) {
      out.set(n.id, { box: null, volume: Infinity, name: p.name ?? '' });
      continue;
    }
    const box = p.box.map((x) => x * S) as NonNullable<LightRegion['box']>;
    out.set(n.id, { box, volume: (box[3] - box[0]) * (box[4] - box[1]) * (box[5] - box[2]), name: p.name ?? '' });
  }
  return out;
}

export interface ZoneLink {
  /** Portal object uid, or OPEN_LINK. */
  portal: number;
  zone: number;
  flags: number;
}

export interface ZoneDef {
  /** Sector tree record number of the zone's group node. */
  node: number;
  name: string;
  links: ZoneLink[];
  /** Zones visible from this one through portals (includes itself). */
  pvs: number[];
}

export function parseZoneGraph(lvl: SrscFile): ZoneDef[] {
  const e = lvl.entries.find((x) => x.type === LVL_ZONE_GRAPH);
  if (!e || e.size < 8) return [];
  const v = lvl.data(e);
  let p = 0;
  const n = v.getUint32(p, true);
  p += 4;
  const zones: ZoneDef[] = [];
  for (let i = 0; i < n; i++) {
    const node = v.getUint32(p, true);
    const k = v.getUint32(p + 4, true);
    p += 8;
    const links: ZoneLink[] = [];
    for (let j = 0; j < k; j++, p += 8) {
      links.push({ portal: v.getUint32(p, true), zone: v.getUint16(p + 4, true), flags: v.getUint16(p + 6, true) });
    }
    zones.push({ node, name: '', links, pvs: [] });
  }
  if (p + 4 <= v.byteLength) {
    p += 4;
    for (const z of zones) {
      if (p + 2 > v.byteLength) break;
      const c = v.getUint16(p, true);
      p += 2;
      for (let j = 0; j < c; j++, p += 2) z.pvs.push(v.getUint16(p, true));
    }
  }
  return zones;
}

/** A portal between two zones, in output space (model units, see level.ts). */
export interface PortalDef {
  uid: number;
  /** The two zones it joins (from the zone graph). */
  zones: [number, number];
  /** 8 box corners, output space: x, y, z interleaved (24 numbers). */
  corners: number[];
  /** Closed at level start (p0: doors). */
  startsClosed: boolean;
  /** Message ids that open (p5) and close (p6) it. */
  openMessage: number;
  closeMessage: number;
  /** Linked object (p4), usually the door Switch; 0 if none. */
  link: number;
}

/** A zone in output space, ready for the renderer. */
export interface VisZone {
  name: string;
  /** Output-space AABB [minX, minY, minZ, maxX, maxY, maxZ] of the zone's contents. */
  box: [number, number, number, number, number, number];
  /** Links: neighbour zone + portal index into LevelVisibility.portals (-1 = open adjacency). */
  links: { zone: number; portal: number }[];
  pvs: number[];
}

export interface LevelVisibility {
  zones: VisZone[];
  portals: PortalDef[];
}

export interface LevelZoning {
  /** Object uid / floor-layer uid -> zone index (absent = not in any zone). */
  zoneOf: Map<number, number>;
  visibility: LevelVisibility;
}

/**
 * Zones of a level: which zone every placed object / floor layer belongs to (its nearest
 * zone ancestor in the sector tree) plus the portal graph, in output space. Returns
 * undefined when the level has no zones (the outdoor levels 0, 5a, 6b, 7, 10).
 */
export function buildLevelZoning(lvl: SrscFile, packages: EntityPackageSet, objects?: LevelObject[]): LevelZoning | undefined {
  const tree = parseSectorTree(lvl);
  const defs = parseZoneGraph(lvl);
  if (!tree || !defs.length) return undefined;
  const nodes = tree.nodes;
  const zoneByNode = new Map<number, number>();
  defs.forEach((z, i) => {
    z.name = nodes[z.node - 1]?.name ?? '';
    zoneByNode.set(z.node, i);
  });

  // Nearest zone ancestor of every leaf (memoised per node).
  const memo = new Int32Array(nodes.length + 1).fill(-2);
  const zoneAbove = (index: number): number => {
    let k = nodes[index - 1]?.parent ?? 0;
    const path: number[] = [];
    let z = -1;
    while (k) {
      if (memo[k] !== -2) {
        z = memo[k];
        break;
      }
      path.push(k);
      const own = zoneByNode.get(k);
      if (own !== undefined) {
        z = own;
        break;
      }
      k = nodes[k - 1]?.parent ?? 0;
    }
    for (const q of path) memo[q] = zoneByNode.get(q) ?? z;
    return z;
  };
  const zoneOf = new Map<number, number>();
  const S = 1 / WORLD_SCALE;
  const boxes = defs.map(() => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (const n of nodes) {
    if (n.kind < 2) continue;
    const z = zoneAbove(n.index);
    if (z < 0) continue;
    zoneOf.set(n.id, z);
    const b = boxes[z];
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], n.box[k] * S);
      b[3 + k] = Math.max(b[3 + k], n.box[3 + k] * S);
    }
  }

  // Portal objects referenced by the graph.
  const portalIndex = new Map<number, number>();
  const portals: PortalDef[] = [];
  const objs = objects ?? parseLevelObjects(lvl);
  const byUid = new Map<number, LevelObject>(objs.map((o) => [o.uid, o]));
  const portalDef = (uid: number, a: number, b: number): number => {
    const known = portalIndex.get(uid);
    if (known !== undefined) return known;
    const o = byUid.get(uid);
    if (!o) return -1;
    const t = readObjectTemplate(packages, o.template);
    if (!t || t.classHash !== PORTAL_CLASS) return -1;
    const e = entityFromObject(o, packages, { resolveStrings: false });
    const num = (i: number, d: number) => (typeof e.values[i] === 'number' ? (e.values[i] as number) : d);
    portals.push({
      uid,
      zones: [a, b],
      corners: boxCorners(o, t.bounds?.boxOrigin, t.bounds?.boxAxes),
      startsClosed: num(0, 0) !== 0,
      link: num(4, 0),
      openMessage: num(5, 4),
      closeMessage: num(6, 5),
    });
    portalIndex.set(uid, portals.length - 1);
    return portals.length - 1;
  };

  const zones: VisZone[] = defs.map((z, i) => {
    const b = boxes[i];
    const box = (b[0] <= b[3] ? b : [0, 0, 0, 0, 0, 0]) as VisZone['box'];
    const links: VisZone['links'] = [];
    for (const l of z.links) {
      if (l.zone >= defs.length || l.zone === i) continue;
      const portal = l.portal === OPEN_LINK ? -1 : portalDef(l.portal, i, l.zone);
      // A link naming a portal we cannot resolve is treated as open (never hide geometry).
      links.push({ zone: l.zone, portal });
    }
    return { name: z.name, box, links, pvs: z.pvs };
  });
  return { zoneOf, visibility: { zones, portals } };
}

const UNIT_ORIGIN: [number, number, number] = [-0.5, -0.5, -0.5];
const UNIT_AXES = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Output-space corners of an object's box volume (template box x scale, rotated, placed). */
function boxCorners(o: LevelObject, origin: number[] = UNIT_ORIGIN, axes: number[] = UNIT_AXES): number[] {
  const s = o.scale ?? [1, 1, 1];
  const R = instanceRotation(o.rotation);
  const out: number[] = [];
  for (let c = 0; c < 8; c++) {
    const t = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
    const q = [0, 1, 2].map((k) => (origin[k] + t[0] * axes[k] + t[1] * axes[3 + k] + t[2] * axes[6 + k]) * s[k]);
    for (let r = 0; r < 3; r++) out.push(o.position[r] / WORLD_SCALE + R[3 * r] * q[0] + R[3 * r + 1] * q[1] + R[3 * r + 2] * q[2]);
  }
  return out;
}
