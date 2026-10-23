// The texture enhancement cache (docs/enhanced.md "Texture enhancement"): its manifest, file layout
// and the per-tier policy. Shared by tools/enhance-textures.ts (writes it) and maps/runtime.ts
// (reads it). The cache is made on the user's machine from the user's install and lives next to
// the converted media (default game/converted/enhanced/, gitignored with the rest of game/).

import type { QualityTier } from '../config';

/** Folder of the cache inside the converted-media root. */
export const ENHANCED_DIR = 'enhanced';
export const ENHANCED_MANIFEST = `${ENHANCED_DIR}/manifest.json`;
export const ENHANCED_MANIFEST_VERSION = 1;

/** One generated image: path relative to the converted root, size in texels. */
export interface MapFile {
  file: string;
  width: number;
  height: number;
  bytes: number;
}

export interface EnhancedEntry {
  /** Fingerprint: source payload hash + generator version + options (incremental bakes). */
  fp: string;
  /** Source size. */
  width: number;
  height: number;
  /** Material class (maps/generate.ts MaterialClass). */
  cls: string;
  /** The source has alpha (cut-outs, reflection masks). */
  alpha: boolean;
  /** Upscaled albedo (absent when the source is already large). */
  albedo?: MapFile;
  /** Tangent-space normal map (red +u, green +v in stored rows). */
  normal: MapFile;
  /** R roughness, G specular, B cavity. */
  surface: MapFile;
}

export interface EnhancedManifest {
  version: number;
  generator: string;
  /** Upscale factor of the albedo. */
  scale: number;
  /** Image codec of the files ('webp' or 'png'). */
  codec: string;
  /** Texture key "<pkg>:<id>" -> entry. */
  textures: Record<string, EnhancedEntry>;
}

export function isEnhancedManifest(x: unknown): x is EnhancedManifest {
  const m = x as EnhancedManifest;
  return !!m && typeof m === 'object' && m.version === ENHANCED_MANIFEST_VERSION && !!m.textures && typeof m.textures === 'object';
}

/** Cache file of one map: enhanced/tex/<pkg>/<id>.<kind>.<ext>. */
export function mapFileName(key: string, kind: 'a' | 'n' | 's', ext: string): string {
  const [pkg, id] = key.split(':');
  return `${ENHANCED_DIR}/tex/${pkg}/${id}.${kind}.${ext}`;
}

/** What each tier draws with (docs/enhanced.md "Texture enhancement"). */
export interface TierMaps {
  normal: boolean;
  /** Normal maps at this fraction of their cached size (½: the source's own resolution). */
  normalScale: number;
  /** Roughness / specular / cavity. */
  surface: boolean;
  /** The upscaled albedo. */
  albedo: boolean;
  /** Anisotropic filtering of the generated maps. */
  anisotropy: number;
  /**
   * GPU memory budget of the generated maps, bytes (RGBA8 with mips). A level's own surfaces may
   * take LEVEL_SHARE of it; the rest is kept for what is built later (characters, props, doors).
   */
  budget: number;
}

const MB = 1024 * 1024;
export const TIER_MAPS: Record<QualityTier, TierMaps> = {
  low: { normal: false, normalScale: 0.5, surface: false, albedo: false, anisotropy: 1, budget: 0 },
  medium: { normal: true, normalScale: 0.5, surface: false, albedo: false, anisotropy: 8, budget: 128 * MB },
  high: { normal: true, normalScale: 0.5, surface: true, albedo: true, anisotropy: 16, budget: 448 * MB },
  ultra: { normal: true, normalScale: 1, surface: true, albedo: true, anisotropy: 16, budget: 1024 * MB },
};

/** Share of the budget a level's own surfaces may take at load (prepare). */
export const LEVEL_SHARE = 0.8;

/** GPU bytes of an RGBA8 texture with its mip chain. */
export const gpuBytes = (w: number, h: number) => Math.ceil(w * h * 4 * 4 / 3);

/** The size a tier draws a normal map at (never below the source's). */
export function normalSize(e: EnhancedEntry, t: TierMaps): { width: number; height: number } {
  const k = Math.max(t.normalScale, e.width / e.normal.width);
  return { width: Math.max(1, Math.round(e.normal.width * k)), height: Math.max(1, Math.round(e.normal.height * k)) };
}

/** GPU bytes a tier spends on one entry (what TIER_MAPS draws). */
export function entryBytes(e: EnhancedEntry, t: TierMaps): number {
  let b = 0;
  if (t.normal) {
    const n = normalSize(e, t);
    b += gpuBytes(n.width, n.height);
  }
  if (t.surface) b += gpuBytes(e.surface.width, e.surface.height);
  if (t.albedo && e.albedo) b += gpuBytes(e.albedo.width, e.albedo.height);
  return b;
}

/** Optional CC0 detail maps (tools/enhance-detail.ts): relative to the converted root. */
export const DETAIL_MANIFEST = `${ENHANCED_DIR}/detail/detail.json`;

export interface DetailManifest {
  version: number;
  /** Source asset id, page and licence (recorded with the download). */
  asset: string;
  source: string;
  licence: string;
  /** Tangent-space normal map, OpenGL convention (+Y towards the image's top row). */
  normal: string;
  /** Roughness (grey). */
  roughness: string;
}

export function isDetailManifest(x: unknown): x is DetailManifest {
  const m = x as DetailManifest;
  return !!m && typeof m === 'object' && m.version === 1 && typeof m.normal === 'string' && typeof m.roughness === 'string';
}
