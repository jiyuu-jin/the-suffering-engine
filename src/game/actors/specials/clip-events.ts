// Every marker event of a clip (.adu type 5; clipmap.ts readClipEvents keeps only sounds and
// the melee window starts). Marker params used by the specials [verified from the Black One
// event switch 0x1006f471; same ids as the weapons' events]: 100 Arm / 101 Disarm (melee
// damage window of the weapon at the event's bone), 114 AttackEffect (spawn the projectile),
// 151 SpawnItem (body-part effect at the bone).

import type { PackageSet } from '../../../formats/model';
import { findEntry } from '../../../formats/model';
import { ADU_EVENTS } from '../../../formats/animation';
import type { ClipRef } from '../clipmap';

export interface ClipMarker {
  time: number;
  param: number;
  /** Event word 2 (the bone / hardpoint the event refers to) [inferred]. */
  bone: number;
}

export const MARK_ARM = 100;
export const MARK_DISARM = 101;
export const MARK_ATTACK_EFFECT = 114;
export const MARK_SPAWN_ITEM = 151;

const cache = new Map<string, ClipMarker[]>();

export function clipMarkers(pkgs: PackageSet, ref: ClipRef | undefined): ClipMarker[] {
  if (!ref) return [];
  const k = `${ref.pkg}:${ref.id}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const out: ClipMarker[] = [];
  const adu = pkgs.get(ref.pkg)?.adu;
  const e = adu && findEntry(adu, ADU_EVENTS, ref.id);
  if (adu && e && e.size >= 4) {
    const v = adu.data(e);
    const n = v.getUint32(0, true);
    if (n <= 256 && 4 + 16 * n <= v.byteLength) {
      for (let i = 0; i < n; i++) {
        const o = 4 + 16 * i;
        if (v.getUint32(o, true) !== 1) continue;
        out.push({ time: v.getFloat32(o + 4, true), bone: v.getUint32(o + 8, true), param: v.getUint32(o + 12, true) });
      }
    }
  }
  out.sort((a, b) => a.time - b.time);
  cache.set(k, out);
  return out;
}

/** Times of one marker kind (close duplicates from several bones merged). */
export function markerTimes(markers: readonly ClipMarker[], param: number, merge = 0): number[] {
  const out: number[] = [];
  for (const m of markers) if (m.param === param && !out.some((t) => Math.abs(t - m.time) < merge)) out.push(m.time);
  return out;
}
