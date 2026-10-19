// Clamber Point selection (RFL: Clamber Point vtable 0x1014c300, slot +0xa0 0x10011910 walks the
// p30 list of Clamber Interaction Properties and takes the first that passes slot +0x100
// 0x10011030 = the generic interaction test 0x100bbe20 -> 0x100bb4e0 plus a minimum ledge
// height; the anchor is the Clamber Point's own vt +0x94 0x100114f0) [verified unless marked]:
//   p3   side: 0 = +local x, 1 = +local z, 2 = -local x, 3 = -local z (bit 0 picks the axis,
//        bit 1 negates) [strong; row / column convention unchecked];
//   anchor (0x100114f0): the player's offset from the box centre projected on the edge (the
//        other horizontal axis), clamped to half the edge length less the Clamber Point's own
//        p31 (0.2 m), plus (half the box depth + p8) along the side normal, at the box top. A
//        long ledge is climbed where the player stands along it, not only at its middle (2
//        Cellblocks 80b: an 18 m wall top over the 3024 step);
//   p1   horizontal reach from the player to the anchor (<= p1 m);
//   p2   |feet - anchor| <= p2 m vertically;
//   p7   the box top at least p7 m above the feet (a minimum, 0x100110a1);
//   p6   the body faces the anchor within p6 degrees (the generic test's facing);
//   p4 / p5  the bearing of the player from the side normal within [p4, p5] degrees
//        (negatives + 360, 0x100bb8a2);
//   p8   offset along the side normal (-0.5: from the face to the box's middle line for a 1 m
//        deep marker); the port lands the player there.
// The box [verified]: the object matrix rows (unit, the object's rotation) times its scale
// (object +0x54), and the model box of 2:178 (a unit cube; engine vt +0x98 returns it in model
// space as a corner and three edges): half the edge = edge length x scale / 2, the top =
// (corner.y + edge.y) x scale y above the placement (0x10011030 / 0x100114f0). The rotation
// counts: 3b's 29fe (yaw 180, p3 = 3) faces -x in the world, not -z. Properties in metres are
// taken x 2048 (engine units); the port works in metres.
// Room on top (0x10011b30, "Player blocked from using the Clamber Point" when it fails, and the
// Clamber Point is then not usable) [verified]: only the template the selection picked is
// tested: a sphere of half the player's shape width swept up at the anchor from top + r +
// (H - 2r) / 4 by 3 (H - 2r) / 4 (H the shape's height) must hit nothing. No floor is asked for
// under the anchor (the port's earlier extra test refused 29fe). Pure maths (no three.js):
// interact.ts applies it.

type V3 = { x: number; y: number; z: number };
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface ClamberBox {
  centre: V3;
  /** Local x / z axes in world space, scaled by the instance scale (box half = 0.5 x). */
  ax: V3;
  az: V3;
  /** World y of the box top (the ledge). */
  top: number;
}

export interface ClamberPick {
  /** Point on the top edge of the side face (in line with the anchor), the side normal (horizontal unit) and the anchor. */
  edge: V3;
  normal: { x: number; z: number };
  anchor: V3;
}

/**
 * The side a Clamber Interaction Properties template allows, or null when the player fails its
 * tests. `margin` is the Clamber Point's p31: how far from the ends of the edge the anchor stays.
 */
export function clamberSide(ip: readonly unknown[], box: ClamberBox, feet: V3, look: { x: number; z: number }, margin = 0.2): ClamberPick | null {
  const side = num(ip[3], 0) & 3;
  const axis = side & 1 ? box.az : box.ax;
  const along = side & 1 ? box.ax : box.az;
  const len = Math.hypot(axis.x, axis.z);
  const lenA = Math.hypot(along.x, along.z);
  if (len < 1e-6 || lenA < 1e-6) return null;
  let nx = axis.x / len, nz = axis.z / len;
  if (side & 2) (nx = -nx), (nz = -nz);
  const ux = along.x / lenA, uz = along.z / lenA;
  // Along the edge: the player's projection, clamped (min(|t|, half - p31), sign kept).
  const t = (feet.x - box.centre.x) * ux + (feet.z - box.centre.z) * uz;
  const m = Math.sign(t) * Math.min(Math.abs(t), 0.5 * lenA - margin);
  const half = 0.5 * len;
  const off = half + num(ip[8], -0.5);
  const cx = box.centre.x + ux * m, cz = box.centre.z + uz * m;
  const edge = { x: cx + nx * half, y: box.top, z: cz + nz * half };
  const anchor = { x: cx + nx * off, y: box.top, z: cz + nz * off };
  if (box.top - feet.y < num(ip[7], 2.5)) return null;
  if (Math.abs(feet.y - anchor.y) > num(ip[2], 4.5) + 1e-9) return null;
  const tx = feet.x - anchor.x, tz = feet.z - anchor.z;
  const dist = Math.hypot(tx, tz);
  const reach = num(ip[1], 2.5);
  if (dist > reach + 1e-9) return null;
  if (dist > 1e-4) {
    const vx = tx / dist, vz = tz / dist;
    const ll = Math.hypot(look.x, look.z) || 1;
    if ((-(look.x * vx) - look.z * vz) / ll < Math.cos((num(ip[6], 45) * Math.PI) / 180) - 1e-9) return null;
    let b = (Math.atan2(nz * vx - nx * vz, nx * vx + nz * vz) * 180) / Math.PI;
    if (b < 0) b += 360;
    let lo = num(ip[4], -45), hi = num(ip[5], 45);
    if (lo < 0) lo += 360;
    if (hi < 0) hi += 360;
    const inRange = lo < hi ? b >= lo - 1e-9 && b <= hi + 1e-9 : b >= lo - 1e-9 || b <= hi + 1e-9;
    if (!inRange) return null;
  }
  return { edge, normal: { x: nx, z: nz }, anchor };
}

/**
 * The room test's swept body (0x10011b30) as a capsule at the anchor on the box top: a sphere of
 * radius r swept from top + r + (height - 2r) / 4 up to top + height - r.
 */
export function clamberRoom(anchor: { x: number; z: number }, top: number, height: number, radius: number) {
  const straight = Math.max(0, height - 2 * radius);
  return { x: anchor.x, z: anchor.z, y0: top + radius + 0.25 * straight, y1: top + height - radius, r: radius };
}
