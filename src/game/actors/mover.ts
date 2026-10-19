// A character's mover volume and ground rules, from its template (docs/game-logic.md §14.9).
//
// Decoded from Suffering.rfl / SUFFERING.EXE [verified unless marked]:
// - The Character constructor (0x100e5030) builds its mover component +0x1ae (0x1009fa60) with
//   cos(p46), cos(p47) and p48 x 2048, and its ground follower +0x26c (0x100b6680) with the same
//   three. p42 (0x100e56d9 -> 0x1009f1a0) is the template of the movement proxy, a "Collider"
//   (class 0xfa5951fc) that 0x1009efb0 creates on the character and hands to the EXE mover (class
//   vtable 0x58eb08, vt+0xc). Collider p0 is the mover's foot sphere (mover +0x10).
// - The proxy's collision is its model's sphere tree (.mdu type 7): node 0 is the bounding sphere,
//   its `first` starts the chain of leaf spheres the mover collides with (0x41ac00 walks them).
//   Every retail Collider is a vertical stack of spheres with the foot sphere (node 1) at the
//   character's origin (the mover's commit 0x41c0b0 puts the foot sphere's centre on the origin).
// - Scale: 0x1009efb0 builds the proxy's matrix from 1 / the character's scale and the sweep
//   (0x41ac00) multiplies the radii by the proxy's own scale; how the two combine is not traced.
//   The data says the spheres scale with the character [inferred]: designers shrink Slayers for
//   indoor levels (0.66 in 8a, 0.72 in 1b), and 1b's Slayer 7ffc (0.72) lives in a 2.7 m high
//   room its unscaled 3.15 m stack does not fit (the port pressed it 0.43 m into the floor).
// - Contacts (0x41ee40): a walkable contact of the foot sphere is a ground candidate, not an
//   obstacle; a non-walkable one is ignored when the collider has other spheres. The other spheres
//   ignore walkable contacts (0x41c7db) and block on the rest. Walkable: contact normal . up >
//   cos(p46) (0x41f6e5 / 0x42a440). The 45..60 degree band of p47 also counts only for a mover with
//   flag 8, which no character sets [inferred: no setter found].
// - The ground (0x41e4b0): of the candidates, the triangle that lies under the foot sphere's
//   centre (the vertical projection inside it, the test point moved 30 units = 1.5 cm towards the
//   triangle's centroid: 0x421500) and whose plane there is within the foot radius of the centre
//   (above or below while descending, any height above otherwise); the highest wins. A body whose
//   centre is over a drop has no ground, however much of the foot sphere rests on the rim.
// - The follower (0x100b6730): while grounded, ground no more than p48 below the feet is snapped
//   to (and ground above); deeper, the fall starts (follower flag 2). The follower keeps the ground
//   triangle while the feet stay over it or a walkable neighbour (0x42adf0 / 0x42a570).
// - Step up: a ground candidate is a surface the foot sphere touches, so a ledge up to the foot
//   radius is climbed [inferred from the contact rule]; the next sphere up blocks higher ones.
//
// The port: the spheres other than the foot become the motor's capsule (their hull); the foot is
// the motor's centre ground probe (physics.ts MotorConfig.groundProbe 'centre').

import type { SrscFile } from '../../formats/srsc';
import { readModelSphereNodes, type ModelSphereNode } from '../../formats/model-spheres';
import { classByHash, decodeTemplateProps, readObjectTemplate, type PropValue } from '../../formats/entities';
import type { PackageSet } from '../../formats/model';
import type { MotorConfig } from '../../app/physics';

/** A character's mover, in metres relative to its origin (the foot sphere's centre). */
export interface MoverVolume {
  /** Radius of the foot sphere (Collider p0): the step-up limit. */
  footRadius: number;
  /** Radius of the blocking spheres (the largest of them). */
  radius: number;
  /** Lowest and highest point of the blocking spheres. */
  bottom: number;
  top: number;
  /** p48: the deepest drop the feet are snapped down (the fall starts below it). */
  stepDown: number;
  /** p46 in degrees: the steepest walkable surface. */
  slopeDeg: number;
}

/** The leaf spheres of a Collider model, in chain order (node 0's `first`, then each `next`). */
export function colliderSpheres(nodes: readonly ModelSphereNode[]): { node: number; y: number; r: number }[] {
  const out: { node: number; y: number; r: number }[] = [];
  const seen = new Set<number>();
  for (let i = nodes[0]?.first ?? 0; i > 0 && i < nodes.length && !seen.has(i); i = nodes[i].next) {
    seen.add(i);
    out.push({ node: i, y: nodes[i].center[1], r: nodes[i].radius });
  }
  return out;
}

/**
 * The mover volume of a Collider's spheres with `foot` (Collider p0) as the foot sphere, p48
 * `stepDown` and p46 `slopeDeg`. Undefined when the foot sphere is not in the chain.
 */
export function moverVolume(nodes: readonly ModelSphereNode[], foot: number, stepDown: number, slopeDeg: number): MoverVolume | undefined {
  const spheres = colliderSpheres(nodes);
  const f = spheres.find((s) => s.node === foot);
  if (!f) return undefined;
  // A lone foot sphere blocks as well (the non-walkable rule only drops it beside other spheres).
  const blocking = spheres.length > 1 ? spheres.filter((s) => s !== f) : spheres;
  let bottom = Infinity, top = -Infinity, radius = 0;
  for (const s of blocking) {
    bottom = Math.min(bottom, s.y - f.y - s.r);
    top = Math.max(top, s.y - f.y + s.r);
    radius = Math.max(radius, s.r);
  }
  return { footRadius: f.r, radius, bottom: Math.max(0, bottom), top, stepDown: Math.max(0, stepDown), slopeDeg };
}

const cache = new Map<string, MoverVolume | null>();

/**
 * The mover volume of a character from its property values (template, or instance values with
 * the template's underneath): p42 Collider, p46 walkable slope, p48 step down.
 */
export function readMoverVolume(pkgs: PackageSet, values: readonly PropValue[]): MoverVolume | undefined {
  const ref = values[42];
  const slope = values[46], drop = values[48];
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !('pkg' in ref)) return undefined;
  if (typeof slope !== 'number' || typeof drop !== 'number') return undefined;
  const key = `${ref.pkg}:${ref.id}`;
  let base = cache.get(key);
  if (base === undefined) {
    base = null;
    const t = readObjectTemplate(pkgs as never, ref);
    if (t && classByHash(t.classHash)?.name === 'Collider' && t.modelRef) {
      const mdu: SrscFile | undefined = pkgs.get(t.modelRef.pkg)?.mdu;
      const foot = decodeTemplateProps(classByHash(t.classHash), t)[0];
      const nodes = mdu ? readModelSphereNodes(mdu, t.modelRef.id) : [];
      base = moverVolume(nodes, typeof foot === 'number' ? foot : 1, 0, 0) ?? null;
    }
    cache.set(key, base);
  }
  return base ? { ...base, stepDown: Math.max(0, drop), slopeDeg: slope } : undefined;
}

/**
 * The NPC motor for a mover volume at the character's `scale` (the spheres scale with it; p48, a
 * distance, does not). The instance's p46 / p48 (`values`) override the template's.
 * The blocking spheres become the capsule (their hull: radius, up to their top), the foot sphere
 * the centre ground probe from its radius down to p48 below the feet. The capsule starts no lower
 * than the foot radius: a ledge the foot sphere climbs only touches the lower spheres with a
 * walkable contact, which they ignore (0x41c7db), so it must not stop the capsule either.
 */
export function npcMotorConfig(m: MoverVolume, values?: readonly PropValue[], scale = 1): Partial<MotorConfig> {
  const slope = values?.[46], drop = values?.[48];
  const k = scale > 0 ? scale : 1;
  const bottom = Math.max(m.bottom, m.footRadius) * k;
  return {
    radius: m.radius * k,
    stepHeight: bottom,
    height: Math.max(m.top * k, bottom + 2 * m.radius * k),
    probeTop: m.footRadius * k,
    snapDistance: typeof drop === 'number' ? Math.max(0, drop) : m.stepDown,
    slopeLimitDeg: typeof slope === 'number' ? slope : m.slopeDeg,
    groundProbe: 'centre',
  };
}
