// Engine-neutral data handed from the format parsers to the renderer.
// Parsers (src/formats/*) produce these; the app (src/app/*) consumes them.

import type { LandscapeSplat, SurfaceMaterial } from './model';
import type { LevelVisibility, LightRegion } from './visgraph';
import type { StaticLighting } from './static-light';

export interface DecodedTexture {
  /** Key used by meshes to reference this texture (SRSC entry id, or a name if one is found). */
  key: string;
  name?: string;
  width: number;
  height: number;
  /** Tightly packed RGBA8, top row first. */
  rgba: Uint8Array;
  hasAlpha: boolean;
}

export interface MeshPart {
  /** xyz per vertex, already converted to a Y-up right-handed space. */
  positions: Float32Array;
  normals?: Float32Array;
  /** Primary (diffuse) UVs. */
  uvs?: Float32Array;
  /** Secondary UVs, e.g. lightmaps. */
  uvs2?: Float32Array;
  /** RGBA per vertex, 0..1. */
  colors?: Float32Array;
  indices: Uint32Array;
  /** DecodedTexture.key of the diffuse texture, if known. */
  textureKey?: string;
  /**
   * How the surface is drawn (blend mode, tint, extra layers). Without it, the part draws
   * `textureKey` with the texture's alpha (if any) as cutout coverage.
   */
  material?: SurfaceMaterial;
  /**
   * Floor layers: full-resolution landscape textures blended over the baked atlas near the
   * camera, in order, each with its per-vertex weight from `splatWeights`.
   */
  splat?: LandscapeSplat[];
  /** 8 weights (0..1) per vertex, one per `splat` entry. */
  splatWeights?: Float32Array;
  lightmapKey?: string;
  /** Visibility zone (index into LevelData.visibility.zones); absent = not in any zone. */
  zone?: number;
  /** Spatial cell id within the zone (or within the unzoned geometry); absent = one cell. */
  cell?: number;
  /** false = drawn but not part of the collision world (water surfaces). */
  solid?: false;
  /**
   * false = in the collision world for sight, shots and the use ray, but movers (the player's and
   * the characters' motors) pass it: objects of a class that no mover's collide list names
   * (Decoration, docs/game-logic.md §14.9).
   */
  moveSolid?: false;
  /**
   * Collision parts (LevelData.collision): the COLLISION_LAYER bits of the part's triangles
   * (src/app/physics.ts), overriding the rule from `moveSolid` / `splat`.
   */
  layers?: number;
  /**
   * Collision parts: AI sight passes the part (engine object +8 bit 0x20000, template flag bit 10
   * or instance 0x1000000 under 0x2000; docs/game-logic.md §14.10).
   */
  sightPass?: true;
}

export interface LevelData {
  name: string;
  parts: MeshPart[];
  /**
   * The original's collision geometry when the loader asked for it (LevelExtras.collisionOf):
   * placed objects' type-7 collision models (formats/model-collision.ts) and the floor layers.
   * Absent: `parts` collide as drawn.
   */
  collision?: MeshPart[];
  /** Suggested camera spawn, if the parser can find a player start. */
  spawn?: { position: [number, number, number]; yaw: number };
  /** Zones and portals (formats/visgraph.ts); absent for levels without zones. */
  visibility?: LevelVisibility;
  /**
   * Regions of the level's Ambient and Directional Lights by uid (formats/visgraph.ts
   * lightRegions); absent when the level has no sector tree.
   */
  lightRegions?: Map<number, LightRegion>;
  /**
   * The lights that are on at load (formats/static-light.ts), for the load-time pass of objects
   * without .ldu colours that the world builds itself (world/dynamic.ts); absent with
   * `?lighting=legacy`.
   */
  loadLighting?: StaticLighting;
}
