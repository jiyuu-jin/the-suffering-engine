// Effects of the weapons system behind one helper, so the FX hookup stays in one place.
//
// With the FX system running (ctx.services.fx, src/game/fx/system.ts - its header documents
// the API) everything goes there:
//   spawn / spawnAt   generators (shotgun muzzle smoke, detonation generators of throwables)
//   muzzleFlash       Muzzle Flash template (Ranged Weapon p83) on the weapon's flash bone
//   impact            per-surface wall hits from the projectile's Missile Material Effects list
//                     (Missile p41) or the Melee Weapon's list (p77): sounds, generator, decal
//   blood             spray + splats behind a hit on a character (Ranged / Melee Weapon p61 suite)
// Without it, generators go to the world's effects runtime (services.world.fx.spawn) and the
// weapons system draws its own fallbacks (flash cards, puffs, decal cards, the first sound).
// Every method returns false when it did not handle the effect, so callers fall back.

import * as THREE from 'three/webgpu';
import type { ResRef } from '../../formats/model';

type Hit = { part?: number; dynamic?: number; point: [number, number, number]; normal?: [number, number, number]; distance?: number };

/** What this helper uses of services.fx (all optional; FxService in src/game/fx/system.ts). */
export interface FxServiceLike {
  spawn(r: ResRef, M: THREE.Matrix4, ctx?: { dir?: THREE.Vector3; parent?: THREE.Object3D }): unknown;
  spawnAt?(r: ResRef, point: THREE.Vector3Like, normal?: THREE.Vector3Like, ctx?: { dir?: THREE.Vector3 }): unknown;
  impact?(e: { point: THREE.Vector3Like; normal: THREE.Vector3Like; effects?: unknown; hit?: Hit; dir?: THREE.Vector3Like }): unknown;
  blood?(point: THREE.Vector3Like, dir: THREE.Vector3Like, opts?: { suite?: ResRef }): unknown;
  muzzleFlash?(r: ResRef, parent: THREE.Object3D, local?: THREE.Matrix4): unknown;
  surfaceAt?(hit: Hit | THREE.Vector3Like): { type: string | null; gmp?: string | null } | null | undefined;
}

export interface WeaponFx {
  /** The FX system (src/game/fx) is running. */
  readonly full: boolean;
  /** Spawn an effect template at `point` (+Z along `normal`). False when no runtime ran it. */
  spawn(r: ResRef | null | undefined, point: THREE.Vector3Like, normal?: THREE.Vector3Like): boolean;
  /** Muzzle Flash template on a bone (FX system only). */
  muzzleFlash(r: ResRef | null | undefined, parent: THREE.Object3D): boolean;
  /** Surface hit effects from a Material Effects list (FX system only). */
  impact(effects: ResRef[], point: THREE.Vector3Like, normal: THREE.Vector3Like, hit?: Hit, dir?: THREE.Vector3Like): boolean;
  /** Blood behind a hit on a character (FX system only). */
  blood(point: THREE.Vector3Like, dir: THREE.Vector3Like, suite?: ResRef): boolean;
  /** Material Type "pkg:id" of a ray hit, when the FX system can tell. */
  surfaceType(hit: Hit): string | null | undefined;
  /** Surface of a ray hit (Material Type and Game Material Properties "pkg:id"), when known. */
  surface(hit: Hit): { type: string | null; gmp?: string | null } | undefined;
}

const Z = new THREE.Vector3(0, 0, 1);

export function weaponFx(services: Record<string, unknown>): WeaponFx {
  const system = () => {
    const f = services.fx as FxServiceLike | undefined;
    return typeof f?.spawn === 'function' ? f : undefined;
  };
  const world = () => (services.world as { fx?: FxServiceLike } | undefined)?.fx;
  const guard = (fn: () => unknown): boolean => {
    try {
      fn();
      return true;
    } catch (err) {
      console.warn('[weapons] fx failed', err);
      return false;
    }
  };
  return {
    get full() {
      return !!system();
    },
    spawn(r, point, normal) {
      if (!r) return false;
      const s = system();
      if (s?.spawnAt) return guard(() => s.spawnAt!(r, point, normal ?? { x: 0, y: 1, z: 0 }));
      const f = s ?? world();
      if (!f) return false;
      const dir = normal ? new THREE.Vector3(normal.x, normal.y, normal.z).normalize() : undefined;
      const M = new THREE.Matrix4();
      if (dir) M.makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(Z, dir));
      M.setPosition(point.x, point.y, point.z);
      return guard(() => f.spawn(r, M, { dir }));
    },
    muzzleFlash(r, parent) {
      const s = system();
      if (!r || !s) return false;
      if (s.muzzleFlash) return guard(() => s.muzzleFlash!(r, parent));
      return guard(() => s.spawn(r, new THREE.Matrix4(), { parent }));
    },
    impact(effects, point, normal, hit, dir) {
      const s = system();
      if (!s?.impact || !effects.length) return false;
      return guard(() => s.impact!({ point, normal, effects, hit, dir }));
    },
    blood(point, dir, suite) {
      const s = system();
      if (!s?.blood) return false;
      return guard(() => s.blood!(point, dir, suite ? { suite } : undefined));
    },
    surfaceType(hit) {
      return this.surface(hit)?.type;
    },
    surface(hit) {
      const s = system();
      if (!s?.surfaceAt) return undefined;
      try {
        return s.surfaceAt(hit) ?? undefined;
      } catch {
        return undefined;
      }
    },
  };
}
