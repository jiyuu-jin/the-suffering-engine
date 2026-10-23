// Enhanced mode, texture enhancement at run time (docs/enhanced.md "Texture enhancement"): loads the
// maps tools/enhance-textures.ts generated (the cache next to the converted media) and hands them to
// the surface materials through surface-material.ts `enhancedTextures`. Silent fallback: no cache,
// a missing entry, a failed fetch, the Low tier or an exhausted budget leave a surface as it was.
//
// Per tier (manifest.ts TIER_MAPS): Low nothing; Medium normal maps; High / Ultra the upscaled
// albedo, normal maps and the roughness / specular / cavity maps. The tier at a level's load
// decides (the maps are part of a material's shader structure); a later tier change applies from
// the next level.
//
// Loading: `prepare(fs, keys)` (main.ts, before the level's meshes are built) fetches and decodes
// the level's own textures, so they are drawn enhanced from the first frame. Textures of objects
// built later (characters, props, doors) load on first use: their maps start as neutral 1×1
// stand-ins and their albedo as a copy of the original, and each is swapped in place when its file
// arrives (three.js recreates a disposed texture at its new size on the next draw).

import * as THREE from 'three/webgpu';
import { float, mix, normalWorld, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { coverageMipmaps } from '../../../formats/texture';
import { enhancedShading, type EnhancedMaps } from '../../engine-light';
import { DevServerFS, LocalFolderFS, type GameFS } from '../../gamefs';
import { CUTOUT_ALPHA_TEST, enhancedTextures, meshUvLayer } from '../../surface-material';
import { Blend } from '../../../formats/model';
import type { LevelData } from '../../../formats/types';
import type { QualityTier } from '../config';
import { EU } from '../lights';
import type { EnhancedSurfaceNodes } from '../shading';
import { DETAIL_MANIFEST, ENHANCED_MANIFEST, LEVEL_SHARE, TIER_MAPS, entryBytes, isDetailManifest, isEnhancedManifest, normalSize, type EnhancedEntry, type EnhancedManifest, type MapFile, type TierMaps } from './manifest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Tuning without a rebuild (`__enhanced.maps.uniforms`). */
export const mapUniforms = {
  /** Normal map strength (0 = flat: the A/B switch of the comparison shots). */
  normal: uniform(1),
  /** Roughness factor of up-facing surfaces (wet floors), as shading.ts's floorRoughness / roughness. */
  wetFloor: uniform(0.38 / 0.68),
  /** CC0 detail maps (High / Ultra): weight, and repeats per repeat of the surface's texture. */
  detail: uniform(0.5),
  detailTile: uniform(4),
};

/** Neutral values of the stand-ins: flat normal; roughness / specular at the global defaults. */
const FLAT_NORMAL = [128, 128, 255, 255];
const NEUTRAL_SURFACE = [Math.round(0.68 * 255), Math.round(0.55 * 255), 255, 255];

/** Textures the detail maps add to a surface's shader (normal, roughness). */
export const DETAIL_TEXTURES = 2;

/** `?texmaps=0` (QA: the before / after shots): the cache is not used. */
const URL_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('texmaps') === '0';

/** Reads files of the converted root (dev server or picked folder); null when there is none. */
type FileReader = (file: string) => Promise<Blob>;

function readerFor(fs: GameFS): FileReader | null {
  if (URL_OFF) return null;
  if (fs instanceof DevServerFS)
    return async (file) => {
      const res = await fetch(`${fs.base}/converted/${file.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    };
  if (fs instanceof LocalFolderFS && fs.hasConvertedMedia)
    return async (file) => {
      const f = await fs.convertedFile(file);
      if (!f) throw new Error('not in the picked folder');
      return f;
    };
  return null;
}

const MIME: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' };

async function decodeBitmap(blob: Blob, file: string, size?: { width: number; height: number }): Promise<ImageBitmap> {
  const typed = new Blob([blob], { type: MIME[file.split('.').pop()!] ?? blob.type });
  // Straight alpha, no colour management: the files hold data (normals) and the engine's colours.
  const opts: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  if (size) Object.assign(opts, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
  return createImageBitmap(typed, opts);
}

/** RGBA8 pixels of a bitmap (cut-out albedo: its coverage-preserving mip chain needs them). */
function pixelsOf(bmp: ImageBitmap): Uint8Array {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return new Uint8Array(g.getImageData(0, 0, bmp.width, bmp.height).data.buffer);
}

function canvasOf(rgba: ArrayLike<number>, w: number, h: number): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  img.data.set(rgba as ArrayLike<number>);
  g.putImageData(img, 0, 0);
  return c;
}

function setup(t: THREE.Texture, colour: boolean, anisotropy: number): void {
  t.flipY = false; // the cache keeps the engine's stored row order, like toDataTexture
  t.premultiplyAlpha = false;
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
}

/** Swap a loaded image into a texture already bound by materials. */
function swapImage(t: THREE.Texture, image: TexImageSource): void {
  t.dispose(); // three.js recreates it at the new size on its next use
  t.image = image;
  t.needsUpdate = true;
}

interface Slot {
  entry: EnhancedEntry;
  /** Level generation that last asked for it (released when a new level does not). */
  gen: number;
  bytes: number;
  normal?: THREE.Texture;
  surface?: THREE.Texture;
  albedo?: THREE.Texture;
  albedoCut?: THREE.DataTexture;
  /** The decoded upscaled albedo (cut-out copies are made from it). */
  albedoBitmap?: ImageBitmap;
  maps?: EnhancedMaps;
  loads: Map<string, Promise<void>>;
}

export class EnhancedTextureMaps {
  tier: QualityTier = 'medium';
  private policy: TierMaps = TIER_MAPS.medium;
  /** The tier the current level was prepared with. */
  private levelPolicy: TierMaps = TIER_MAPS.medium;
  private manifest: EnhancedManifest | null = null;
  private reader: FileReader | null = null;
  private attached: GameFS | null = null;
  private attaching: Promise<void> | null = null;
  private readonly slots = new Map<string, Slot>();
  private gen = 0;
  /** GPU bytes held (estimate: RGBA8 with mips). */
  bytes = 0;
  readonly uniforms = mapUniforms;
  /** Loaded files and failures; textures (and their GPU bytes) the level's budget turned away. */
  readonly stats = { entries: 0, loaded: 0, failed: 0, files: 0, overBudget: 0, overBudgetBytes: 0 };
  private readonly rejected = new Set<string>();
  /** The detail maps in use (QA), or null. */
  detail: string | null = null;

  constructor() {
    installSurfaceHook();
    enhancedTextures.maps = (key) => this.maps(key);
    enhancedTextures.texture = (key, cutout, base) => this.texture(key, cutout, base);
    enhancedTextures.layout = () => this.layout();
    enhancedTextures.bind = (material, key) => this.bind(material, key);
    installMaterialMaps();
  }

  /**
   * The map layout of engineLightMaterial's graph (characters) at this level's tier: undefined
   * without a cache or at Low; no detail maps (they are concrete relief, not cloth or skin).
   */
  layout(): EnhancedMaps | undefined {
    const p = this.levelPolicy;
    if (!this.manifest || (!p.normal && !p.surface)) return undefined;
    const n = neutralMaps();
    return { normal: p.normal ? n.normal : undefined, roughness: p.surface ? n.surface : undefined, specular: p.surface ? n.surface : undefined };
  }

  /** A material's maps for its texture key (`enhancedMapTextures`, sampled by the shared graph). */
  bind(material: THREE.Material, key: string | undefined): void {
    const m = key ? this.maps(key) : undefined;
    const n = neutralMaps();
    (material as MaterialMaps).enhancedMapTextures = { normal: m?.normal ?? n.normal, surface: m?.roughness ?? m?.specular ?? n.surface };
  }

  setTier(t: QualityTier) {
    this.tier = t;
    this.policy = TIER_MAPS[t];
    // (Before the first level the tier applies at once.)
    if (this.gen === 0) this.levelPolicy = this.policy;
  }

  /** Whether a cache was found (QA). */
  get available(): boolean {
    return !!this.manifest;
  }

  /** Find the cache of this game data source (once per source). */
  attach(fs: GameFS): Promise<void> {
    if (this.attached === fs && this.attaching) return this.attaching;
    this.attached = fs;
    this.manifest = null;
    this.reader = readerFor(fs);
    this.release(() => true);
    const reader = this.reader;
    this.attaching = (async () => {
      if (!reader) return;
      try {
        const json: unknown = JSON.parse(await (await reader(ENHANCED_MANIFEST)).text());
        if (!isEnhancedManifest(json)) throw new Error('unsupported manifest');
        this.manifest = json;
        this.stats.entries = Object.keys(json.textures).length;
        console.info(`[enhanced] texture cache: ${this.stats.entries} textures (${json.codec}, ×${json.scale})`);
      } catch {
        // No cache (npm run enhance-textures has not run): the surfaces stay as they are.
        this.manifest = null;
        return;
      }
      void this.loadDetail(reader);
    })();
    return this.attaching;
  }

  /** The optional CC0 detail maps (npm run enhance-detail), swapped into the shared stand-ins. */
  private async loadDetail(reader: FileReader) {
    try {
      const m: unknown = JSON.parse(await (await reader(DETAIL_MANIFEST)).text());
      if (!isDetailManifest(m)) return;
      const d = detailTextures();
      const [n, r] = await Promise.all([m.normal, m.roughness].map(async (f) => decodeBitmap(await reader(f), f)));
      swapImage(d.normal, n);
      swapImage(d.roughness, r);
      this.detail = `${m.asset} (${m.licence})`;
    } catch {
      // No detail maps: the stand-ins change nothing.
    }
  }

  /**
   * A level is about to be built with these texture keys: release what it does not use, then load
   * its maps (waits at most `timeoutMs`; the rest swaps in as it arrives).
   */
  async prepare(fs: GameFS, keys: { maps: string[]; albedo: string[] }, timeoutMs = 6000): Promise<void> {
    await this.attach(fs);
    this.gen++;
    this.levelPolicy = this.policy;
    const want = new Set([...keys.maps, ...keys.albedo]);
    this.release((key) => !want.has(key));
    this.rejected.clear();
    this.stats.overBudget = this.stats.overBudgetBytes = 0;
    const m = this.manifest;
    if (!m || !this.policy.budget) return;
    const loads: Promise<void>[] = [];
    // Largest first so a tight budget keeps the surfaces that cover the most.
    const area = (k: string) => m.textures[k].width * m.textures[k].height;
    const ordered = (list: string[]) => [...new Set(list)].filter((k) => m.textures[k]).sort((a, b) => area(b) - area(a));
    const limit = this.levelPolicy.budget * LEVEL_SHARE;
    for (const key of ordered(keys.maps)) {
      const s = this.slot(key, limit);
      if (!s) continue;
      if (this.levelPolicy.normal) loads.push(this.load(s, 'normal'));
      if (this.levelPolicy.surface) loads.push(this.load(s, 'surface'));
    }
    if (this.levelPolicy.albedo)
      for (const key of ordered(keys.albedo)) {
        const s = this.slot(key, limit);
        if (s) loads.push(this.load(s, 'albedo'));
      }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(loads), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }

  /** Drop slots (dispose their GPU textures; materials still using one re-upload it). */
  private release(drop: (key: string) => boolean) {
    for (const [key, s] of this.slots) {
      if (!drop(key)) continue;
      for (const t of [s.normal, s.surface, s.albedo, s.albedoCut]) t?.dispose();
      this.bytes -= s.bytes;
      this.slots.delete(key);
    }
  }

  /** The slot of a key (null: no cache entry, or over the budget). */
  private slot(key: string, limit = this.levelPolicy.budget): Slot | null {
    let s = this.slots.get(key);
    if (s) {
      s.gen = this.gen;
      return s;
    }
    const entry = this.manifest?.textures[key];
    // (Turned away once, turned away for the level: what is left is kept for later objects.)
    if (!entry || !this.levelPolicy.budget || this.rejected.has(key)) return null;
    const bytes = entryBytes(entry, this.levelPolicy);
    if (this.bytes + bytes > limit) {
      if (!this.rejected.has(key)) (this.rejected.add(key), this.stats.overBudget++, (this.stats.overBudgetBytes += bytes));
      return null;
    }
    this.bytes += bytes;
    s = { entry, gen: this.gen, bytes, loads: new Map() };
    this.slots.set(key, s);
    return s;
  }

  private file(s: Slot, kind: 'normal' | 'surface' | 'albedo'): MapFile | undefined {
    return kind === 'albedo' ? s.entry.albedo : s.entry[kind];
  }

  /** Fetch + decode one map into the slot's texture (created as a stand-in when absent). */
  private load(s: Slot, kind: 'normal' | 'surface' | 'albedo'): Promise<void> {
    const f = this.file(s, kind);
    if (!f || !this.reader) return Promise.resolve();
    let p = s.loads.get(kind);
    if (p) return p;
    const reader = this.reader;
    const aniso = this.levelPolicy.anisotropy;
    p = (async () => {
      try {
        // (Normal maps at the tier's size: the browser's decoder scales them down.)
        const size = kind === 'normal' ? normalSize(s.entry, this.levelPolicy) : undefined;
        const bmp = await decodeBitmap(await reader(f.file), f.file, size && size.width !== f.width ? size : undefined);
        this.stats.files++;
        if (kind === 'albedo') {
          s.albedoBitmap = bmp;
          if (s.albedo) swapImage(s.albedo, bmp);
          else setup((s.albedo = new THREE.Texture(bmp as never)), true, aniso);
          if (s.albedoCut) this.fillCutout(s.albedoCut, bmp);
        } else {
          const t = s[kind];
          if (t) swapImage(t, bmp);
          else setup((s[kind] = new THREE.Texture(bmp as never)), false, aniso);
        }
        this.stats.loaded++;
      } catch (err) {
        this.stats.failed++;
        if (this.stats.failed <= 3) console.warn(`[enhanced] texture map ${f.file}:`, (err as Error).message);
      }
    })();
    s.loads.set(kind, p);
    return p;
  }

  /** Cut-out albedo: RGBA data with the coverage-preserving mip chain (toDataTexture's rule). */
  private fillCutout(t: THREE.DataTexture, bmp: ImageBitmap) {
    const px = pixelsOf(bmp);
    t.dispose();
    t.image = { data: px, width: bmp.width, height: bmp.height } as never;
    const pow2 = (n: number) => (n & (n - 1)) === 0;
    if (pow2(bmp.width) && pow2(bmp.height)) {
      t.mipmaps = coverageMipmaps(px, bmp.width, bmp.height, CUTOUT_ALPHA_TEST);
      t.generateMipmaps = false;
    } else {
      t.mipmaps = [];
      t.generateMipmaps = true;
    }
    t.needsUpdate = true;
  }

  /** prepare() for a level: the keys its surfaces will ask for (createSurfaceMaterial's rule). */
  prepareLevel(fs: GameFS, level: LevelData, timeoutMs?: number): Promise<void> {
    return this.prepare(fs, levelTextureKeys(level), timeoutMs);
  }

  /** enhancedTextures.maps: the generated maps of a texture key for this level's tier. */
  maps(key: string): EnhancedMaps | undefined {
    const p = this.levelPolicy;
    if (!p.normal && !p.surface) return undefined;
    const s = this.slot(key);
    if (!s) return undefined;
    if (!s.maps) {
      const out: EnhancedMaps = {};
      if (p.normal) {
        if (!s.normal) setup((s.normal = new THREE.Texture(canvasOf(FLAT_NORMAL, 1, 1) as never)), false, p.anisotropy);
        out.normal = s.normal;
        void this.load(s, 'normal');
      }
      if (p.surface) {
        if (!s.surface) setup((s.surface = new THREE.Texture(canvasOf(NEUTRAL_SURFACE, 1, 1) as never)), false, p.anisotropy);
        // One texture: roughness in R, specular in G (installSurfaceHook reads both from one sample).
        out.roughness = out.specular = s.surface;
        // (The CC0 detail maps come with the surface map: two more textures in the shader.)
        out.detail = DETAIL_TEXTURES;
        void this.load(s, 'surface');
      }
      s.maps = out;
    }
    return s.maps;
  }

  /** enhancedTextures.texture: the upscaled albedo in place of `base` (High / Ultra). */
  texture(key: string, cutout: boolean, base: THREE.Texture | null): THREE.Texture | null {
    if (!base || !this.levelPolicy.albedo) return base;
    const entry = this.manifest?.textures[key];
    if (!entry?.albedo) return base;
    const s = this.slot(key);
    if (!s) return base;
    if (cutout) {
      if (!s.albedoCut) {
        // Stand-in: the original's own data and mip chain until the upscaled file is decoded.
        const src = base as THREE.DataTexture;
        if (!src.isDataTexture || !src.image?.data) return base;
        const t = new THREE.DataTexture(src.image.data as Uint8Array, src.image.width, src.image.height, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.mipmaps = src.mipmaps;
        setup(t, true, this.levelPolicy.anisotropy);
        t.generateMipmaps = src.generateMipmaps;
        s.albedoCut = t;
        if (s.albedoBitmap) this.fillCutout(t, s.albedoBitmap);
        else void this.load(s, 'albedo');
      }
      return s.albedoCut;
    }
    if (!s.albedo) {
      const src = base as THREE.DataTexture;
      if (!src.isDataTexture || !src.image?.data) return base;
      setup((s.albedo = new THREE.Texture(canvasOf(src.image.data as Uint8Array, src.image.width, src.image.height) as never)), true, this.levelPolicy.anisotropy);
      void this.load(s, 'albedo');
    }
    return s.albedo;
  }
}

const unlitBlend = (b: number) => b === Blend.Add || b === Blend.Subtract || b === Blend.MulAlpha || b === Blend.Modulate2x;

/**
 * Texture keys a level's surfaces ask enhancedTextures for: per part, the maps of its first lit
 * mesh-UV layer (surface-material.ts createSurfaceMaterial), and the albedo of every layer and splat.
 */
export function levelTextureKeys(level: LevelData): { maps: string[]; albedo: string[] } {
  const maps = new Set<string>(), albedo = new Set<string>();
  for (const part of level.parts) {
    let layers = part.material?.layers.filter((l) => l.texture || l.frames) ?? [];
    if (!layers.length && part.textureKey) layers = [{ texture: part.textureKey, blend: Blend.Opaque }];
    if (!layers.length) continue;
    if (!unlitBlend(layers[0].blend)) {
      const l = layers.find((x) => x.texture && !x.frames && !unlitBlend(x.blend) && meshUvLayer(x));
      if (l) maps.add(l.texture!);
    }
    for (const l of layers) if (l.texture && !l.frames) albedo.add(l.texture);
    for (const sp of part.splat ?? []) if (sp.texture) albedo.add(sp.texture);
  }
  return { maps: [...maps], albedo: [...albedo] };
}

let hooked = false;

type MaterialMaps = THREE.Material & { enhancedMapTextures: { normal: THREE.Texture; surface: THREE.Texture } };
let neutral: { normal: THREE.Texture; surface: THREE.Texture } | null = null;
/** Flat normal, the default roughness / specular: a surface without maps looks as without the graph. */
function neutralMaps() {
  if (!neutral) {
    neutral = { normal: new THREE.Texture(canvasOf(FLAT_NORMAL, 1, 1) as never), surface: new THREE.Texture(canvasOf(NEUTRAL_SURFACE, 1, 1) as never) };
    setup(neutral.normal, false, 1);
    setup(neutral.surface, false, 1);
  }
  return neutral;
}

/**
 * `material.enhancedMapTextures` on every material (Enhanced only): the neutral maps until
 * `bind` sets its own. A clone (three.js copies no custom fields) reads the neutral ones instead
 * of nothing.
 */
function installMaterialMaps() {
  if (Object.getOwnPropertyDescriptor(THREE.Material.prototype, 'enhancedMapTextures')) return;
  Object.defineProperty(THREE.Material.prototype, 'enhancedMapTextures', {
    configurable: true,
    get(this: { _enhancedMapTextures?: unknown }) {
      return this._enhancedMapTextures ?? neutralMaps();
    },
    set(this: { _enhancedMapTextures?: unknown }, v: unknown) {
      this._enhancedMapTextures = v;
    },
  });
}

/**
 * The optional CC0 detail maps (tools/enhance-detail.ts), shared by every surface graph: neutral
 * 1×1 stand-ins (no change) until the files are loaded.
 */
const detail = {
  normal: null as THREE.Texture | null,
  roughness: null as THREE.Texture | null,
};
function detailTextures() {
  if (!detail.normal) {
    setup((detail.normal = new THREE.Texture(canvasOf(FLAT_NORMAL, 1, 1) as never)), false, 16);
    setup((detail.roughness = new THREE.Texture(canvasOf([191, 191, 191, 255], 1, 1) as never)), false, 16);
  }
  return detail as { normal: THREE.Texture; roughness: THREE.Texture };
}

/**
 * Wraps shading.ts's surface hook (once): the normal map through a strength uniform, and roughness /
 * specular from the one surface map (R, G) relative to the global defaults, so the lighting's own
 * tuning (EU.roughness, EU.specular) still applies, with the wet-floor drop on up-facing surfaces
 * that shading.ts's heuristic gives surfaces without maps. With the surface map (High / Ultra) the
 * detail maps add a fine relief (whiteout blend in tangent space) and roughness breakup at
 * `detailTile` repeats per texture repeat, weighted by `detail` and by the surface's roughness
 * (rough stone and earth take it fully, glossy metal and skin less).
 */
function installSurfaceHook() {
  if (hooked || !enhancedShading.surface) return;
  hooked = true;
  const inner = enhancedShading.surface;
  enhancedShading.surface = (maps, sample, coords) => {
    const surf = maps.roughness ?? maps.specular;
    const s: N = surf ? sample(surf) : null;
    let dn: N = null, dr: N = null, w: N = null;
    // (Only when the maps declare them: surface-material.ts drops them from layered surfaces to stay
    // within the fragment stage's texture limit.)
    if (s && maps.detail) {
      const d = detailTextures();
      const dc: N = vec2(coords).mul(mapUniforms.detailTile);
      // (OpenGL green is towards the image's top row, i.e. −v here: flipped.)
      dn = texture(d.normal, dc).xyz.mul(2).sub(1).mul(vec3(1, -1, 1));
      dr = texture(d.roughness, dc).r;
      w = mapUniforms.detail.mul(smoothstep(0.35, 0.75, s.r));
    }
    const nodes = (maps.normal
      ? inner({ normal: maps.normal, normalScale: maps.normalScale }, (t) => {
          const n: N = mix(vec3(0.5, 0.5, 1), sample(t).xyz, mapUniforms.normal).mul(2).sub(1);
          const b: N = dn ? vec3(n.xy.add(dn.xy.mul(w)), n.z).normalize() : n;
          return vec4(b.mul(0.5).add(0.5), 1);
        }, coords)
      : {}) as EnhancedSurfaceNodes;
    if (s) {
      const up: N = smoothstep(0.65, 0.92, normalWorld.y);
      const breakup: N = dr ? mix(float(1), dr.div(0.75).clamp(0.6, 1.4), w) : float(1);
      if (maps.roughness) nodes.roughness = s.r.mul(EU.roughness.div(0.68)).mul(mix(float(1), mapUniforms.wetFloor, up)).mul(breakup).clamp(0.05, 1);
      if (maps.specular) nodes.specular = s.g.mul(EU.specular.div(0.55));
    }
    return nodes;
  };
}
