// Graphics Mode (Original / Enhanced) and Enhanced quality tiers (docs/enhanced.md).
//
// Original is the default and the faithful renderer: the engine's gamma back buffer, its vertex
// lighting and fog, no post stack (engine-light.ts). Enhanced is an optional modern look built on
// the same lights and fog (src/app/enhanced/*). The mode is chosen once per page load, before the
// renderer exists, because it decides the back-buffer format and every material's shader:
//
//   1. URL: `?gfx=enhanced|original` and `?tier=low|medium|high|ultra|auto` (testing, QA shots);
//   2. the saved settings (Graphics page rows `x.gfxMode`, `x.gfxTier` in Settings.extra,
//      localStorage `suffering.settings.v1`, src/app/menu/settings.ts);
//   3. Original / Auto.
//
// The tier can change at run time (menu, Auto's frame-time governor): it only switches post
// passes and uniforms (TIER_FEATURES). Changing the mode takes effect on the next load.
//
// This module has no imports so that engine-light.ts can read ENHANCED at its own load.

export type GraphicsMode = 'original' | 'enhanced';
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type TierSetting = QualityTier | 'auto';

export const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];
/** Menu choice order of the Quality row (`x.gfxTier` holds the index). */
export const TIER_SETTINGS: readonly TierSetting[] = ['auto', 'low', 'medium', 'high', 'ultra'];
/** Menu choice order of the Graphics Mode row (`x.gfxMode` holds the index). */
export const MODES: readonly GraphicsMode[] = ['original', 'enhanced'];

/** localStorage key of the user settings (src/app/menu/settings.ts KEY). */
export const SETTINGS_KEY = 'suffering.settings.v1';

/**
 * What each tier turns on. Every Enhanced feature is gated here; docs/enhanced.md has the table.
 * Sizes are texels, counts per frame.
 */
export interface TierFeatures {
  /** Render scale of the scene pass (× the menu's resolution scale). */
  renderScale: number;
  /** Flashlight shadow map (0 = no shadow). */
  flashShadowSize: number;
  /** PCF taps of shadow lookups (1, 4, 9 or 16). */
  shadowTaps: number;
  /** Point lamps with cube shadow maps (the strongest near the camera). */
  lampShadows: number;
  /** Face size of a lamp's cube shadow map. */
  lampShadowSize: number;
  /** Cube faces re-rendered per frame (round robin over the shadowed lamps). */
  lampFacesPerFrame: number;
  /** Moonlight (dominant directional light) shadow map for light shafts (0 = none). */
  moonShadowSize: number;
  /** Lamps whose specular highlight is evaluated per pixel. */
  specularLights: number;
  /** Volumetric light raymarch steps (0 = no volumetrics) and its resolution scale. */
  volumetricSteps: number;
  volumetricScale: number;
  /** Ground-truth ambient occlusion (0 = off) samples and resolution scale. */
  aoSamples: number;
  aoScale: number;
  bloom: boolean;
  /** Anti-aliasing of the post stack. */
  aa: 'fxaa' | 'traa';
  /** Screen-space reflections on wet floors. */
  ssr: boolean;
  /** Depth of field (focus on what is in the middle of the view). */
  dof: boolean;
}

export const TIER_FEATURES: Record<QualityTier, TierFeatures> = {
  low: {
    renderScale: 0.75,
    flashShadowSize: 512,
    shadowTaps: 1,
    lampShadows: 0,
    lampShadowSize: 0,
    lampFacesPerFrame: 0,
    moonShadowSize: 0,
    specularLights: 2,
    volumetricSteps: 8,
    volumetricScale: 0.5,
    aoSamples: 0,
    aoScale: 0.5,
    bloom: true,
    aa: 'fxaa',
    ssr: false,
    dof: false,
  },
  medium: {
    renderScale: 1,
    flashShadowSize: 1024,
    shadowTaps: 4,
    lampShadows: 0,
    lampShadowSize: 0,
    lampFacesPerFrame: 0,
    moonShadowSize: 1024,
    specularLights: 4,
    volumetricSteps: 16,
    volumetricScale: 0.5,
    aoSamples: 8,
    aoScale: 0.5,
    bloom: true,
    aa: 'fxaa',
    ssr: false,
    dof: false,
  },
  high: {
    renderScale: 1,
    flashShadowSize: 2048,
    shadowTaps: 9,
    lampShadows: 1,
    lampShadowSize: 512,
    lampFacesPerFrame: 2,
    moonShadowSize: 2048,
    specularLights: 6,
    volumetricSteps: 24,
    volumetricScale: 0.5,
    aoSamples: 12,
    aoScale: 0.5,
    bloom: true,
    aa: 'traa',
    ssr: false,
    dof: false,
  },
  ultra: {
    renderScale: 1,
    flashShadowSize: 2048,
    shadowTaps: 16,
    lampShadows: 2,
    lampShadowSize: 1024,
    lampFacesPerFrame: 6,
    moonShadowSize: 4096,
    specularLights: 8,
    volumetricSteps: 40,
    volumetricScale: 0.5,
    aoSamples: 16,
    aoScale: 1,
    bloom: true,
    aa: 'traa',
    ssr: true,
    dof: true,
  },
};

/** Highest tier on the WebGL2 fallback (no timestamp queries, slower fill). */
export const WEBGL_MAX_TIER: QualityTier = 'medium';

export interface GraphicsChoice {
  mode: GraphicsMode;
  tier: TierSetting;
  /** Where the mode came from (logged; QA). */
  source: 'url' | 'settings' | 'default';
}

const asMode = (v: unknown): GraphicsMode | null => (v === 'enhanced' || v === 'original' ? v : null);
const asTier = (v: unknown): TierSetting | null => (typeof v === 'string' && (TIER_SETTINGS as readonly string[]).includes(v) ? (v as TierSetting) : null);

/**
 * The mode and tier for a page: URL parameters first, then the saved settings (`extra.gfxMode`
 * / `extra.gfxTier` as menu choice indices), then Original / Auto. Pure (tests).
 */
export function resolveGraphics(search: string, stored: { gfxMode?: unknown; gfxTier?: unknown } | null): GraphicsChoice {
  const q = new URLSearchParams(search);
  const urlMode = asMode(q.get('gfx'));
  const urlTier = asTier(q.get('tier'));
  const savedMode = typeof stored?.gfxMode === 'number' ? (MODES[stored.gfxMode] ?? null) : null;
  const savedTier = typeof stored?.gfxTier === 'number' ? (TIER_SETTINGS[stored.gfxTier] ?? null) : null;
  return {
    mode: urlMode ?? savedMode ?? 'original',
    tier: urlTier ?? savedTier ?? 'auto',
    source: urlMode ? 'url' : savedMode ? 'settings' : 'default',
  };
}

/** The saved Graphics rows, read straight from localStorage (no settings module at this point). */
function readStored(): { gfxMode?: unknown; gfxTier?: unknown } | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    const extra = raw ? (JSON.parse(raw) as { extra?: Record<string, unknown> }).extra : null;
    return extra && typeof extra === 'object' ? { gfxMode: extra.gfxMode, gfxTier: extra.gfxTier } : null;
  } catch {
    return null;
  }
}

/** This page's choice (fixed for the page's life; the tier is only the starting point). */
export const GRAPHICS: GraphicsChoice = resolveGraphics(typeof location !== 'undefined' ? location.search : '', readStored());

/** Enhanced mode for this page. False = the faithful renderer, untouched. */
export const ENHANCED = GRAPHICS.mode === 'enhanced';

/** One tier down / up (clamped). */
export function stepTier(t: QualityTier, d: -1 | 1, max: QualityTier = 'ultra'): QualityTier {
  const i = Math.max(0, Math.min(TIERS.indexOf(max), TIERS.indexOf(t) + d));
  return TIERS[i];
}

/** Clamp a tier to a maximum (WebGL2: WEBGL_MAX_TIER). */
export function capTier(t: QualityTier, max: QualityTier): QualityTier {
  return TIERS.indexOf(t) > TIERS.indexOf(max) ? max : t;
}
