// Enhanced gore: what each quality tier may spend (docs/enhanced.md "Gore"). Pure data (tests).

import type { QualityTier } from '../config';

export interface GoreTier {
  /** Spatter / drop / trail decals alive at once (one draw call: a ring of projected triangles). */
  decals: number;
  /** Vertices of the spatter ring (projected triangles × 3). */
  decalVerts: number;
  /** Growing pools alive at once (their own ring). */
  pools: number;
  poolVerts: number;
  /** Bodies with a wound overlay at once, and wounds per body. */
  bodies: number;
  woundsPerBody: number;
  /** Live blood droplets (one instanced draw). */
  droplets: number;
  /** Droplets thrown by a blow of amount 1 (scaled by the amount, the gibs and spurts). */
  dropletsPerHit: number;
  /** Droplets that paint a splat where they land (share 0..1). */
  landSplats: number;
  /** Drops left under bleeding characters. */
  trails: boolean;
  /** Relief of the blood film from its thickness (derivative bump). */
  bump: boolean;
}

export const GORE_TIERS: Record<QualityTier, GoreTier> = {
  low: { decals: 96, decalVerts: 6144, pools: 4, poolVerts: 3072, bodies: 3, woundsPerBody: 4, droplets: 96, dropletsPerHit: 6, landSplats: 0.35, trails: false, bump: false },
  medium: { decals: 192, decalVerts: 12288, pools: 8, poolVerts: 6144, bodies: 6, woundsPerBody: 6, droplets: 192, dropletsPerHit: 10, landSplats: 0.5, trails: true, bump: true },
  high: { decals: 320, decalVerts: 20480, pools: 12, poolVerts: 9216, bodies: 10, woundsPerBody: 8, droplets: 384, dropletsPerHit: 16, landSplats: 0.6, trails: true, bump: true },
  ultra: { decals: 512, decalVerts: 32768, pools: 16, poolVerts: 12288, bodies: 16, woundsPerBody: 8, droplets: 640, dropletsPerHit: 24, landSplats: 0.7, trails: true, bump: true },
};

/** The ring sizes are fixed for the page at the largest tier any setting may reach. */
export const MAX_WOUNDS = 8;
