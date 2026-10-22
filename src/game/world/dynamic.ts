// Dynamic level objects: placed objects the world system renders and collides itself
// (doors and other switches, pickups, objects shown/hidden or moved by the level logic)
// instead of baking them into the merged static level geometry.

import * as THREE from 'three/webgpu';
import { LEGACY_LIGHTING, engineLightMaterial } from '../../app/engine-light';
import { texture, uniform, vec3, vertexColor } from 'three/tsl';
import type { SrscFile } from '../../formats/srsc';
import { parseEntities, readObjectTemplate, type Entity } from '../../formats/entities';
import { instanceRotation, LDU_COLORS, parseLevelObjects, WORLD_SCALE, type LevelObject } from '../../formats/level';
import { findEntry, readMaterial, readModel, singlePassTexture, templateModelRef, TDU_TEXTURE, type PackageSet, type ResRef, type RiotModel, type SurfaceMaterial } from '../../formats/model';
import { SurfaceMaterialCache } from '../../app/surface-material';
import { hasSkeleton } from '../../formats/skeleton';
import { decodeTexture } from '../../formats/texture';
import { COLLISION_LAYER, type CollisionWorld, type DynamicParts } from '../../app/physics';
import type { StaticLighting } from '../../formats/static-light';
import { parseStompSequence } from './stomp';
import { PICKUP_CLASSES } from './logic';
import { materialSeeThrough } from '../actors/sight';
import { warmObjects } from '../../app/prewarm';
import { housingExtras } from './housing';
import { moverCollisionMesh, rayOnlyCollisionMesh, readModelCollision, type CollisionMesh } from '../../formats/model-collision';
import type { ObjectCollision } from '../../formats/level';
import { collisionForClass } from './object-collision';
import { switchBaseMaterials, switchBaseSwaps, switchPart, type SwitchPart } from './switch-part';

const SYSTEM_PKG = 2;

/** Never collide (effects, lights, sound, volumes). */
// Water Volume: water holds no one up (its contacts go to the water-effects component; docs/levels.md);
// a dynamic one is a grouped surface that rises (10's 11aa / 11ab, see dynamicObjectUids).
const NON_SOLID = new Set(['Water Volume', 'Particle Fountain', 'Object Generator', 'Fire', 'Volumetric Fog', 'Billboard', 'Point Light', 'Spot Light', 'Sound Effect', 'Animating Static', 'DripMorphingModel', 'MorphingModel', 'Spot Light Cone', 'Projector Effect', 'Electric Shield', 'Sky / Sun']);

/**
 * Classes rendered dynamically whenever they have a (static, non-skinned) model: doors,
 * pickups, and the props the world system breaks, moves, morphs or re-materials
 * (breakables, pushables, mechanisms, interactables, lamps, drips - see props.ts).
 */
export const PROP_CLASSES = new Set([
  'Breakable', 'TargetableBreakable', 'Pushable', 'Mechanism', 'Phone', 'Security Monitor', 'Toilet', 'Ladder',
  'Clamber Point', 'Mountable', 'Light Housing', 'DripMorphingModel', 'MorphingModel', 'Sky / Sun',
]);
/** Built even when the static renderer would not draw them (no flag 0x80 / baked colours). */
const ALWAYS_DYNAMIC = new Set(['Switch', ...PICKUP_CLASSES, 'Mountable']);

/**
 * Pushables the player can grab (p23 usable) are built without flag 0x80 too: 1a's three
 * statues (9:3359, flags 0x801) are its sally-port puzzle (pushed into Detector 8b3d they start
 * the booth CartWheeler scene; 8a46 stands in gate 4f0d's swing). Scripted ones (p23 = 0, e.g.
 * 1b's untextured 9:3561 / 9:5416 sheets of Object Grouper 8298) stay out (docs/playthrough.md).
 */
function usablePushable(e: Entity): boolean {
  return e.className === 'Pushable' && e.values[23] !== 0;
}

/**
 * `before` index of a placed object's load-time light pass (static-light.ts setFor): which
 * lights it sees. In SUFFERING.EXE the pass (0x4ca3a0) runs at the object's first draw: scene
 * object vtable +0x84 (0x4ca6c0) is called only by the draw functions 0x4930f0 / 0x492950, once
 * the frame's gather (+0x164) has filled an upload with at least one light [verified]. An object
 * hidden at start (instance flag 0x1 clear: SetVisible(0) clears scene object +8 bit 0,
 * 0x4541a0) is not drawn before the logic shows it, so its pass sees every light that is on then:
 * undefined (every static light on at load, below) [port: the lights on at load stand for those on at the
 * reveal]. 1a: the Shiv in the stabbed inmate's back (Ammo Box 5bfb, index 419) precedes its
 * cell's lamp (5c06, 427) and the root Ambient Light (3206); with the order rule it was black.
 * An object shown at start keeps the lights created before it (its level index): the 1a cell
 * doors, shown at start like the start-visible pickups and drawn the same way, have black
 * colours in the PC captures, which every light at their first draw cannot give (rendered: bars
 * at 255 against 180) [inferred from data; the code path that makes it so was not found,
 * docs/re/renderer.md §1.9]. Either way only static lights go into the colours; switchable
 * ones light the object per frame, so its colours do not stay lit when a lamp goes out
 * (static-light.ts) [port].
 * An object created during play (a dead guard's dropped revolver, world.ts placeDrop: no level
 * index, -1) is first drawn long after every light exists: every light too. (With its -1 as
 * the order it saw no light at all and was drawn black, lit only by the flashlight.)
 */
export function loadPassBefore(e: Pick<Entity, 'flags' | 'index'> | undefined): number | undefined {
  return e && e.flags & 1 && e.index >= 0 ? e.index : undefined;
}

/** Synthetic uids for objects spawned at runtime (debris, broken remains). */
let nextSpawnUid = 0x40000000;

/**
 * Which placed objects the world system takes over (registered with the loader so they
 * are left out of the static merge): switches/doors, pickups, Visibility Toggler targets
 * and objects moved by STOMP sequences.
 */
/**
 * A Breakable of the system package (template 2:489, model 2:180, a plain box): a hit target the
 * level logic hangs on something, drawn by nothing (the system package holds editor proxies).
 * 2 Cellblocks' 18ce sits at the foot of the raised ladder 18cb; breaking it (health 1) sends
 * Relay 1a0d, which lowers the ladder (Mechanism 18cc, Object Grouper 18cd). Built for its body
 * (hits, shots), its meshes hidden [inferred: nothing in the level shows a box there].
 */
export function hiddenTarget(e: Pick<Entity, 'className' | 'template'>): boolean {
  return e.className === 'Breakable' && e.template.pkg === SYSTEM_PKG;
}

/**
 * Is a part of a placed object looked and shot through (WorldService.seeThrough, the port's
 * see-through rule: cut-out bars, glass)? Not a hidden hit target's box: it is drawn by nothing
 * and stands there to be hit. Its model (2:180) carries the cut-out texture 2:164, which read as
 * see-through let every bullet pass: 8a's paddy wagon engine box 1b80 (20 health, the shot that
 * sends the wagon through the gate, "PaddyWagon" 1b7c) took no shot [inferred: the level places
 * it as the wagon's hit target, with its fire on it].
 */
export function partSeeThrough(e: Pick<Entity, 'className' | 'template'> | undefined, material: THREE.Material | THREE.Material[] | undefined): boolean {
  if (e && hiddenTarget(e)) return false;
  return materialSeeThrough(material);
}

export function dynamicObjectUids(lvl: SrscFile, packages: PackageSet): Set<number> {
  const ents = parseEntities(lvl, packages, { resolveStrings: false });
  const byUid = new Map(ents.map((e) => [e.uid, e]));
  const want = new Set<number>();
  for (const e of ents) {
    // Fire draws its own model, grown from p3..p5 to p6..p8 when lit (fx/effects.ts addFire), and
    // is a touch volume, not a solid (docs/game-logic.md §14.2: the player's movement query
    // leaves Fire out). Fires with baked colours were merged into the static level as well: an
    // unlit fire card stood drawn and solid in 3a's fence gap (Fire 3762, lit on the revisit).
    if (ALWAYS_DYNAMIC.has(e.className) || PROP_CLASSES.has(e.className) || e.className === 'Fire') want.add(e.uid);
    // Instance flag 0x1 clear = not present at start (shown later by the logic).
    else if (!(e.flags & 1) && e.className !== 'Player') want.add(e.uid);
    else if (e.className === 'Visibility Toggler') for (const u of e.links) want.add(u);
    else if (e.className === 'STOMP Player') {
      const r = e.values[0] as ResRef | null;
      const q = r && (packages.get(r.pkg) as { qdu?: SrscFile } | undefined)?.qdu;
      const seq = q && r ? parseStompSequence(q, r.id) : undefined;
      for (const t of seq?.tracks ?? []) want.add(t.uid);
    }
    // Object Grouper: its members move with the first link (props.ts moveGrouped), so they are
    // dynamic objects. 10's pipe-yard water surfaces 11aa / 11ab ride the Mechanisms 32d / 341
    // (Groupers 11ac / 11ad); merged into the static level they stayed put.
    if (e.className === 'Object Grouper') for (const u of e.links) want.add(u);
  }
  // Light Housing p43: placed objects the lamp shows and hides with its state (housing.ts; the
  // light pools under the 1a cell lamps). None carries flag 0x80, which the engine does not read
  // (docs/re/object-model.md §2), so they are built whatever it says.
  const extras = new Set<number>();
  for (const e of ents) if (e.className === 'Light Housing') for (const u of housingExtras(e.values)) (extras.add(u), want.add(u));
  // Only objects with a static model (skinned characters belong to the actors system), and
  // apart from switches / pickups only those the static renderer would draw (flag 0x80 or
  // baked lighting) - effect emitters and editor proxies stay invisible.
  const refs = new Map(parseLevelObjects(lvl).map((o) => [o.uid, o.ref]));
  const out = new Set<number>();
  for (const uid of want) {
    const e = byUid.get(uid);
    const m = e?.modelRef;
    if (!e || !m || ((m.pkg === SYSTEM_PKG || e.template.pkg === SYSTEM_PKG) && !hiddenTarget(e))) continue;
    if (!ALWAYS_DYNAMIC.has(e.className) && !usablePushable(e) && !extras.has(uid) && !(e.flags & 0x80) && !refs.get(uid)?.pkg) continue;
    // Mounted guns and pickups (Item family: the skinned revolver 4:15 / shotgun 4:26 / 4:88
    // weapon pickups, Ammo Boxes 4:282 / 4:115) are skinned but no other system draws them: shown
    // in their bind pose (docs/game-logic.md §14.8).
    if (e.className !== 'Mountable' && e.family !== 'Item' && hasSkeleton(packages.get(m.pkg)?.mdu, m.id)) continue;
    out.add(uid);
  }
  return out;
}

export interface DynamicObject {
  uid: number;
  entity: Entity;
  /** Root placed at the instance transform; `pivot` carries switch motion. */
  root: THREE.Group;
  pivot: THREE.Group;
  /** Local-space drawn triangles per submesh (model units, scale applied). */
  local: { positions: Float32Array; indices: Uint32Array }[];
  /**
   * Local-space collision triangles (scale applied) of the body: the model's collision tree
   * (formats/model-collision.ts, docs/game-logic.md §14.10), or `local` for a skinned prop.
   */
  collisionLocal?: { positions: Float32Array; indices: Uint32Array }[];
  /** AI sight (and shots) pass the body (engine +8 bit 0x20000, object-collision.ts). */
  sightPass?: boolean;
  /** Base instance matrix (placement). */
  base: THREE.Matrix4;
  collides: boolean;
  body?: number;
  visible: boolean;
  /** Collision enabled by logic (doors at rest, not hidden). */
  solid: boolean;
  /** Model drawn (for morphs / material swaps). */
  model?: RiotModel;
  /** Created at runtime (spawned template), removed with remove(). */
  spawned?: boolean;
  /**
   * A Switch with a p37 part (switch-part.ts): the object draws the part, which its motion moves,
   * and `stand` is the base it was placed with, a separate object that stays put.
   */
  stand?: DynamicObject;
}

const bakedGain = uniform(3.0);

/** Builds meshes for dynamic objects, sharing textures/materials. */
export class DynamicObjects {
  readonly group = new THREE.Group();
  readonly objects = new Map<number, DynamicObject>();
  private textures = new Map<string, THREE.DataTexture | null>();
  private materials = new Map<string, THREE.MeshStandardNodeMaterial>();
  private disposables: { dispose(): void }[] = [];
  /** Pre-warm stand-ins (warmGlow). */
  private standIns: THREE.Mesh[] = [];
  private models = new Map<string, RiotModel | null>();
  private bodyUids = new Map<number, number>();
  private ldu = new Map<number, { model: ResRef; colors: Uint8Array }>();
  private unlit: [number, number, number] = [0.3, 0.3, 0.3];
  private levelPkg?: number;
  private readonly housingExtras = new Set<number>();

  constructor(
    private readonly packages: PackageSet,
    private readonly collision: CollisionWorld | null,
    lduFile: SrscFile | undefined,
    /**
     * The level's lights for the load-time pass (formats/static-light.ts): placed objects
     * without .ldu colours get their colours from the engine's pass (the lights it sees:
     * loadPassBefore, in the object's groups). Absent: lit as dynamic objects (`?lighting=legacy`, tests).
     */
    private readonly loadLighting?: StaticLighting,
  ) {
    this.group.name = 'world-dynamic';
    // Identity, never moves: objects recompute their world matrices only when flagged
    // (matrixWorldNeedsUpdate), not every frame.
    this.group.matrixAutoUpdate = false;
    if (lduFile) {
      for (const e of lduFile.entries) {
        if (e.type !== LDU_COLORS || e.size < 12) continue;
        const v = lduFile.data(e);
        const count = v.getUint32(8, true);
        if (12 + 4 * count > e.size) continue;
        this.ldu.set(e.id, { model: { id: v.getUint16(0, true), pkg: v.getUint16(2, true) }, colors: new Uint8Array(lduFile.buffer, e.offset + 12, 4 * count) });
      }
      // Median baked brightness for unlit objects (same idea as level.ts).
      const samples: number[] = [];
      for (const { colors } of this.ldu.values()) for (let i = 0; i < colors.length && samples.length < 50000; i += 4 * 11) samples.push((colors[i] + colors[i + 1] + colors[i + 2]) / 3);
      samples.sort((a, b) => a - b);
      const g = samples.length ? samples[samples.length >> 1] / 255 : 0.3;
      this.unlit = [g, g, g];
    }
  }

  /** Build every requested object. `levelPkg` = package id of the .ldu refs. */
  build(lvl: SrscFile, entities: Map<number, Entity>, uids: Iterable<number>) {
    const objs = new Map<number, LevelObject>();
    for (const o of parseLevelObjects(lvl)) objs.set(o.uid, o);
    // Level package: the ref package most .ldu-backed instances use.
    const score = new Map<number, number>();
    for (const o of objs.values()) if (o.ref.pkg && this.ldu.has(o.ref.id)) score.set(o.ref.pkg, (score.get(o.ref.pkg) ?? 0) + 1);
    this.levelPkg = [...score].sort((a, b) => b[1] - a[1])[0]?.[0];
    // A lamp's p43 objects (flat light pools, housing.ts) are effects: no body.
    for (const e of entities.values()) if (e.className === 'Light Housing') for (const u of housingExtras(e.values)) this.housingExtras.add(u);
    for (const uid of uids) {
      const o = objs.get(uid);
      const e = entities.get(uid);
      if (!o || !e) continue;
      try {
        const d = this.buildOne(o, e);
        if (d) this.objects.set(uid, d);
      } catch (err) {
        console.warn(`[world] object ${uid.toString(16)} not built`, err);
      }
    }
  }

  private model(r: ResRef) {
    const k = `${r.pkg}:${r.id}`;
    let m = this.models.get(k);
    if (m === undefined) this.models.set(k, (m = readModel(this.packages, r) ?? null));
    return m;
  }

  private buildOne(o: LevelObject, e: Entity): DynamicObject | undefined {
    let lit = this.levelPkg !== undefined && o.ref.pkg === this.levelPkg ? this.ldu.get(o.ref.id) : undefined;
    let modelRef = lit?.model.pkg ? lit.model : templateModelRef(this.packages, o.template);
    // Some .ldu records name a model that does not decode (1a "Box Of Stuff" 7b1b: ldu 1680 ->
    // 4:106); fall back to the template's model (without baked colours) instead of dropping the
    // object, which the static geometry already left out. [weapons agent: hardpoint props]
    if (modelRef && lit && !this.model(modelRef)) {
      modelRef = templateModelRef(this.packages, o.template);
      lit = undefined;
    }
    if (!modelRef) return undefined;
    // Props block movement unless the PhysicalObject p17 ("solid" [guess]) is clear; small
    // breakables keep a body anyway so shots and explosions can find them (they were part of
    // the static collision before).
    const collides = !PICKUP_CLASSES.has(e.className) && !NON_SOLID.has(e.className) && !this.housingExtras.has(e.uid);
    // A skinned model carries no collision record (docs/game-logic.md §14.7 [strong: data]): it
    // blocks no movement. The skinned Mountables (the mounted guns and searchlights) keep a body
    // for shots only, as damageable props (2 Cellblocks: the south-yard gunner 7f4 stood inside
    // the bind-pose triangles of his gun 2dbf and could not walk away from it).
    const skinned = hasSkeleton(this.packages.get(modelRef.pkg)?.mdu, modelRef.id);
    if (hiddenTarget(e)) {
      const d = this.buildModel(e.uid, `${e.className}#${e.uid.toString(16)}`, modelRef, instanceMatrix(o.position, o.rotation), { scale: o.scale, entity: e, collides: true });
      if (d) d.pivot.traverse((c) => ((c as THREE.Mesh).isMesh ? (c.visible = false) : undefined));
      return d;
    }
    // How the object collides: its class (the movers' collide lists) and its sight flag.
    const how = collisionForClass(e.className, o.flags, readObjectTemplate(this.packages, o.template)?.flags ?? 0);
    // A Switch with a p37 part wears the part's model and leaves its own to a base object at the
    // placement (switch-part.ts, Suffering.rfl 0x101313b0): the lever turns, the box stays.
    const part = skinned ? undefined : switchPart(e, this.packages);
    if (part && this.model(part.model)) return this.buildSwitchWithPart(o, e, part, modelRef, lit?.colors, how);
    return this.buildModel(e.uid, `${e.className}#${e.uid.toString(16)}`, modelRef, instanceMatrix(o.position, o.rotation), {
      scale: o.scale,
      colors: lit?.colors,
      how: skinned ? undefined : how,
      // No .ldu colours: the engine's load-time pass (static-light.ts); the sky dome is drawn
      // unlit by lights.ts.
      lightAtLoad: !lit && e.className !== 'Sky / Sun',
      entity: e,
      collides,
      layers: skinned ? COLLISION_LAYER.projectile : undefined,
      cullDistance: placedCullDistance(o, e, this.packages),
    });
  }

  /**
   * A Switch and its p37 part (switch-part.ts): the switch object draws and collides with the
   * part's model (its pivot carries the motion); the base, its own model, is a separate object at
   * the placement with the p37 template's collision rule, registered under a new uid. The base
   * keeps the instance's .ldu colours (they are its model's) [port]; the part is lit by the
   * load-time pass. The base is pre-warmed in both state colours (world.ts switchPose sets them).
   */
  private buildSwitchWithPart(o: LevelObject, e: Entity, part: SwitchPart, own: ResRef, colors: Uint8Array | undefined, how: ObjectCollision | null): DynamicObject | undefined {
    const M = instanceMatrix(o.position, o.rotation);
    const name = `${e.className}#${e.uid.toString(16)}`;
    const cullDistance = placedCullDistance(o, e, this.packages);
    const collides = !this.housingExtras.has(e.uid);
    const d = this.buildModel(e.uid, name, part.model, M, { scale: o.scale, how, lightAtLoad: true, entity: e, collides, cullDistance });
    if (!d) return undefined;
    const uid = nextSpawnUid++;
    const stand = this.buildModel(uid, `${name}:base`, own, M, {
      scale: o.scale,
      colors,
      lightAtLoad: !colors,
      entity: e,
      collides,
      how: collisionForClass(part.cls, 0, part.flags),
      cullDistance,
    });
    if (stand) {
      this.objects.set(uid, stand);
      d.stand = stand;
      const slots = stand.model?.materials.length ?? 0;
      if (switchBaseSwaps(e.values)) this.warmMaterials(uid, [switchBaseMaterials(e.values, true, slots), switchBaseMaterials(e.values, false, slots)]);
    }
    return d;
  }

  /**
   * Build a mesh + optional collision body for a model at a placement matrix (output space).
   * `colors` = baked .ldu colours. Without them, `lightAtLoad` (placed objects) runs the engine's
   * load-time pass at the placement (formats/static-light.ts: the lights of loadPassBefore in the
   * object's groups, stored unhalved, then drawn as precomputed: 2 × colour + the switchable lights per frame,
   * docs/re/renderer.md §1.6); otherwise the mesh is lit like a dynamic object (the colour
   * attribute, the level's median brightness, is read only by the legacy look) [port: spawned
   * remains, debris and effect models, which the engine lights at their own load].
   */
  buildModel(
    uid: number,
    name: string,
    modelRef: ResRef,
    base: THREE.Matrix4,
    opts: {
      scale?: [number, number, number];
      colors?: Uint8Array;
      lightAtLoad?: boolean;
      entity?: Entity;
      collides?: boolean;
      spawned?: boolean;
      cullDistance?: number;
      layers?: number;
      /**
       * The class rule (object-collision.ts): with it, or for a spawned model, the body is the
       * model's collision tree; null = no body. Skinned props pass undefined (drawn triangles).
       */
      how?: ObjectCollision | null;
    } = {},
  ): DynamicObject | undefined {
    const m = this.model(modelRef);
    if (!m) return undefined;
    const colors = opts.colors && opts.colors.length === 4 * m.vertexCount ? opts.colors : undefined;
    const load = !colors && opts.lightAtLoad && this.loadLighting && !LEGACY_LIGHTING ? this.loadTimeSet(m, base, opts.scale, loadPassBefore(opts.entity), opts.entity?.uid) : undefined;

    const root = new THREE.Group();
    root.name = name;
    root.matrixAutoUpdate = false;
    const pivot = new THREE.Group();
    pivot.matrixAutoUpdate = false;
    root.add(pivot);
    const local: DynamicObject['local'] = [];
    const s = opts.scale ?? [1, 1, 1];
    const flip = s[0] * s[1] * s[2] < 0;

    for (const sm of m.submeshes) {
      if (!sm.indices.length) continue;
      const remap = new Map<number, number>();
      const used: number[] = [];
      for (const ci of sm.indices) if (!remap.has(ci)) (remap.set(ci, used.length), used.push(ci));
      const n = used.length;
      const pos = new Float32Array(3 * n), nrm = new Float32Array(3 * n), uv = new Float32Array(2 * n), col = new Float32Array(4 * n);
      for (let j = 0; j < n; j++) {
        const ci = used[j];
        // Scale applied here so the pivot rotates the scaled model.
        pos[3 * j] = m.positions[3 * ci] * s[0];
        pos[3 * j + 1] = m.positions[3 * ci + 1] * s[1];
        pos[3 * j + 2] = m.positions[3 * ci + 2] * s[2];
        nrm.set(m.normals.subarray(3 * ci, 3 * ci + 3), 3 * j);
        uv[2 * j] = m.uvs[2 * ci];
        uv[2 * j + 1] = m.uvs[2 * ci + 1];
        if (colors) {
          const sv = 4 * m.source[ci];
          col[4 * j] = colors[sv + 2] / 255;
          col[4 * j + 1] = colors[sv + 1] / 255;
          col[4 * j + 2] = colors[sv] / 255;
          col[4 * j + 3] = 1;
        } else if (load) {
          load.shade(pos, nrm, j, col);
          col[4 * j + 3] = 1;
        } else col.set([...this.unlit, 1], 4 * j);
      }
      const idx = new Uint32Array(sm.indices.length);
      for (let t = 0; t + 2 < sm.indices.length; t += 3) {
        idx[t] = remap.get(sm.indices[t])!;
        idx[t + 1] = remap.get(sm.indices[flip ? t + 1 : t + 2])!;
        idx[t + 2] = remap.get(sm.indices[flip ? t + 2 : t + 1])!;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.userData.corners = Uint32Array.from(used);
      this.disposables.push(geo);
      // Without .ldu or load-time colours the object is lit like a dynamic one (ambient + every light).
      const pre = !!colors || !!load;
      const mesh = new THREE.Mesh(geo, this.material(sm.textureKey, sm.material, pre));
      // Moves only with root / pivot (their matrices).
      mesh.matrixAutoUpdate = false;
      mesh.userData.surface = sm.material;
      mesh.userData.baked = pre;
      mesh.name = root.name;
      mesh.userData.uid = uid;
      mesh.userData.tex = sm.textureKey;
      // Slot in the model's material table (Light Housing material lists, setMaterials).
      mesh.userData.matIndex = sm.materialIndex;
      // Placed objects' draw distance (culled in visibility.ts / prop-batch.ts).
      if (opts.cullDistance !== undefined && Number.isFinite(opts.cullDistance)) mesh.userData.cullDistance = opts.cullDistance;
      pivot.add(mesh);
      local.push({ positions: pos, indices: idx });
    }

    root.matrix.copy(base);
    root.matrixWorldNeedsUpdate = true;
    this.group.add(root);
    let collides = opts.collides ?? false;
    const d: DynamicObject = { uid, entity: opts.entity as Entity, root, pivot, local, base: base.clone(), collides, visible: true, solid: true, model: m, spawned: opts.spawned };
    let layers = opts.layers;
    // The original's collision geometry (docs/game-logic.md §14.10): placed objects by their
    // class rule, spawned models (remains, debris) as solids.
    const how = opts.how !== undefined ? opts.how : opts.spawned ? { layers: COLLISION_LAYER.solid, rayLayers: COLLISION_LAYER.decor, sightPass: false } : undefined;
    if (collides && how !== undefined) {
      const mdu = this.packages.get(modelRef.pkg)?.mdu;
      const tree = how && mdu && readModelCollision(mdu, modelRef.id) ? mdu : undefined;
      const sMax = Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
      const mover = tree ? moverCollisionMesh(tree, modelRef.id, sMax) : undefined;
      const ray = tree && !mover ? rayOnlyCollisionMesh(tree, modelRef.id) : undefined;
      const mesh = mover ?? ray;
      if (how && mesh) {
        d.collisionLocal = [scaledMesh(mesh, s)];
        d.sightPass = how.sightPass;
        layers = mover ? how.layers : how.rayLayers;
      } else collides = d.collides = false;
    }
    if (collides && this.collision) {
      d.body = this.collision.addDynamic(this.collisionParts(d), true, layers);
      this.bodyUids.set(d.body, uid);
    }
    return d;
  }

  /**
   * The load-time pass of a placed model (formats/static-light.ts): its light list at its
   * bounding-sphere centre (loadPassBefore, the object's groups), and a shader of its (scaled, local)
   * vertices at the placement.
   */
  private loadTimeSet(m: RiotModel, base: THREE.Matrix4, scale: [number, number, number] | undefined, index: number | undefined, uid?: number) {
    const L = this.loadLighting!;
    const s = scale ?? [1, 1, 1];
    const e = base.elements;
    // Bounding sphere of the placed model (world space).
    let cx = 0, cy = 0, cz = 0;
    const n = m.positions.length / 3;
    const world = (x: number, y: number, z: number, out: number[]) => {
      out[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    };
    const p = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      world(m.positions[3 * i] * s[0], m.positions[3 * i + 1] * s[1], m.positions[3 * i + 2] * s[2], p);
      cx += p[0] / n;
      cy += p[1] / n;
      cz += p[2] / n;
    }
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      world(m.positions[3 * i] * s[0], m.positions[3 * i + 1] * s[1], m.positions[3 * i + 2] * s[2], p);
      r2 = Math.max(r2, (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2);
    }
    // The lights the pass sees (loadPassBefore), of the groups holding the object (static-light.ts).
    const set = L.setFor(cx, cy, cz, Math.sqrt(r2), index, uid);
    const nm = new THREE.Matrix3().getNormalMatrix(base).elements;
    const q = [0, 0, 0];
    return {
      /** Colour of vertex j of a submesh (pos: scaled local positions, nrm: local normals). */
      shade(pos: Float32Array, nrm: Float32Array, j: number, col: Float32Array) {
        world(pos[3 * j], pos[3 * j + 1], pos[3 * j + 2], q);
        // Normals of a scaled model: n / s, then the placement's rotation.
        const ax = nrm[3 * j] / s[0], ay = nrm[3 * j + 1] / s[1], az = nrm[3 * j + 2] / s[2];
        let nx = nm[0] * ax + nm[3] * ay + nm[6] * az, ny = nm[1] * ax + nm[4] * ay + nm[7] * az, nz = nm[2] * ax + nm[5] * ay + nm[8] * az;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        L.shadeSet(set, q[0], q[1], q[2], nx, ny, nz, col, 4 * j);
      },
    };
  }

  /** Object for a template spawned at runtime (broken remains, debris); registered under a new uid. */
  spawnModel(modelRef: ResRef, base: THREE.Matrix4, opts: { scale?: [number, number, number]; collides?: boolean; name?: string } = {}): DynamicObject | undefined {
    const uid = nextSpawnUid++;
    const d = this.buildModel(uid, opts.name ?? `spawn:${modelRef.pkg}:${modelRef.id}`, modelRef, base, { scale: opts.scale, collides: opts.collides, spawned: true });
    if (d) this.objects.set(uid, d);
    return d;
  }

  /** Model for an object created during play from a synthetic level record (no baked colours). */
  spawnEntity(o: LevelObject, e: Entity): DynamicObject | undefined {
    const d = this.buildOne(o, e);
    if (d) this.objects.set(e.uid, d);
    return d;
  }

  /** Remove an object (mesh + collision). */
  remove(uid: number) {
    const d = this.objects.get(uid);
    if (!d) return;
    if (d.body !== undefined) {
      this.collision?.removeDynamic(d.body);
      this.bodyUids.delete(d.body);
    }
    d.root.removeFromParent();
    if (d.spawned) for (const c of d.pivot.children) (c as THREE.Mesh).geometry?.dispose();
    this.objects.delete(uid);
  }

  /**
   * Meshes of the level's placed objects that may be drawn from a static batch while they do not
   * change (src/app/prop-batch.ts decides, per frame). Runtime spawns (debris, drips) are left
   * out, and so are the morph frames other systems hang under an object's pivot (uid 0).
   */
  batchCandidates(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const d of this.objects.values()) {
      if (d.spawned) continue;
      for (const c of d.pivot.children) if ((c as THREE.Mesh).isMesh && c.userData.uid === d.uid) out.push(c as THREE.Mesh);
    }
    return out;
  }

  /** uid of the object owning a dynamic collision body (RayHit.dynamic). */
  uidOfBody(body: number): number | undefined {
    return this.bodyUids.get(body);
  }

  /**
   * Is submesh `part` of an object (RayHit.part of a hit on its body) drawn see-through
   * (cut-out bars, glass)? Sight tests pass through it (src/game/actors/sight.ts).
   */
  seeThrough(uid: number, part: number): boolean {
    const d = this.objects.get(uid);
    // A collision-tree body: the object's sight flag (docs/game-logic.md §14.10).
    if (d?.collisionLocal) return !!d.sightPass;
    return partSeeThrough(d?.entity, (d?.pivot.children[part] as THREE.Mesh | undefined)?.material);
  }

  /** Retexture submeshes: texture key -> replacement texture key (material swaps). Empty map restores. */
  swapTextures(uid: number, map: ReadonlyMap<string, string>) {
    const d = this.objects.get(uid);
    if (!d) return;
    d.pivot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const orig = mesh.userData.tex as string | undefined;
      const to = orig !== undefined ? (map.get(orig) ?? orig) : undefined;
      mesh.material = this.material(to, to === orig ? (mesh.userData.surface as SurfaceMaterial | undefined) : undefined, mesh.userData.baked !== false);
    });
  }

  /**
   * Replace an object's material table slot by slot (Light Housing p32 / p33, housing.ts):
   * submeshes of slot i draw `table[i]` (a null entry or a missing table keeps the model's own),
   * through the same engine materials as the model's own (an Advanced material's tint draws
   * unlit, docs/re/renderer.md §3.5).
   */
  setMaterials(uid: number, table: readonly (ResRef | null)[] | undefined) {
    const d = this.objects.get(uid);
    if (!d) return;
    d.pivot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.uid !== uid) return;
      mesh.material = this.slotMaterial(mesh, table);
    });
  }

  /**
   * Hidden stand-ins drawing every material table an object can switch to (src/app/prewarm.ts),
   * so the load-time precompile builds them: a lamp switched mid-game otherwise compiled its
   * materials in that frame (docs/game-logic.md §18).
   */
  warmMaterials(uid: number, tables: readonly ((ResRef | null)[] | undefined)[]) {
    const d = this.objects.get(uid);
    if (!d) return;
    d.pivot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.uid !== uid) return;
      const seen = new Set<THREE.Material>([mesh.material as THREE.Material]);
      for (const t of [undefined, ...tables]) {
        const m = this.slotMaterial(mesh, t);
        if (seen.has(m)) continue;
        seen.add(m);
        const s = new THREE.Mesh(mesh.geometry, m);
        warmObjects.add(s);
        this.standIns.push(s);
      }
    });
  }

  private slotMaterial(mesh: THREE.Mesh, table: readonly (ResRef | null)[] | undefined): THREE.Material {
    const baked = mesh.userData.baked !== false;
    const i = mesh.userData.matIndex as number | undefined;
    const r = table && i !== undefined ? table[i] : undefined;
    const surface = r ? readMaterial(this.packages, r) : undefined;
    if (surface) return this.material(singlePassTexture(surface), surface, baked);
    return this.material(mesh.userData.tex as string | undefined, mesh.userData.surface as SurfaceMaterial | undefined, baked);
  }

  /** Shared (cached) texture for effects (particles, fog sprites). */
  textureByKey(key: string): THREE.DataTexture | null {
    return this.texture(key);
  }

  /** Decoded model (cached). */
  modelByRef(r: ResRef): RiotModel | null {
    return this.model(r);
  }

  /** Engine materials (blend mode, layers, tint) for submeshes that carry a decoded material. */
  private surfaces?: SurfaceMaterialCache;

  /**
   * `baked`: the mesh has .ldu colours (precomputed lighting: switchable lights only at run
   * time); otherwise it is lit like a dynamic object, from the ambient and every light
   * (docs/game-logic.md §19.1). The legacy look keeps the old precomputed path for all.
   */
  private material(key: string | undefined, surface?: undefined, baked?: boolean): THREE.MeshStandardNodeMaterial;
  private material(key: string | undefined, surface: SurfaceMaterial | undefined, baked?: boolean): THREE.Material;
  private material(key: string | undefined, surface?: SurfaceMaterial, baked = true): THREE.Material {
    const pre = baked || LEGACY_LIGHTING;
    if (surface) return (this.surfaces ??= new SurfaceMaterialCache(this.packages)).get({ textureKey: key, material: surface }, { vertexColors: pre });
    const k = `${key ?? ''}${pre ? '' : '|dyn'}`;
    let mat = this.materials.get(k);
    if (mat) return mat;
    const map = key ? this.texture(key) : null;
    const hasAlpha = !!map?.userData.hasAlpha;
    mat = new THREE.MeshStandardNodeMaterial({
      color: map ? 0xffffff : 0x6a6a66,
      map,
      vertexColors: pre,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: hasAlpha ? 0.5 : 0,
    });
    // Engine lighting: baked .ldu colours + switchable lights, else ambient + every light.
    if (!LEGACY_LIGHTING) engineLightMaterial(mat, { precomputed: pre });
    else if (map) mat.emissiveNode = texture(map).rgb.mul(vec3(vertexColor())).mul(bakedGain);
    mat.name = `world:${k}`;
    this.materials.set(k, mat);
    this.disposables.push(mat);
    return mat;
  }

  private texture(key: string): THREE.DataTexture | null {
    let t = this.textures.get(key);
    if (t !== undefined) return t;
    t = null;
    const [pkg, id] = key.split(':').map(Number);
    const tdu = this.packages.get(pkg)?.tdu;
    const entry = findEntry(tdu, TDU_TEXTURE, id);
    const src = tdu && entry ? decodeTexture(tdu, entry, { rowOrder: 'stored' }) : null;
    if (src) {
      t = new THREE.DataTexture(src.rgba, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
      t.userData.hasAlpha = src.hasAlpha;
      t.needsUpdate = true;
      this.disposables.push(t);
    }
    this.textures.set(key, t);
    return t;
  }

  /** World-space drawn triangles at the object's current pose (grouped water surfaces). */
  worldParts(d: DynamicObject): DynamicParts {
    return this.posed(d, d.local);
  }

  /** World-space collision triangles of the object's body at its current pose. */
  collisionParts(d: DynamicObject): DynamicParts {
    return this.posed(d, d.collisionLocal ?? d.local);
  }

  private posed(d: DynamicObject, local: readonly { positions: Float32Array; indices: Uint32Array }[]): DynamicParts {
    d.root.updateMatrixWorld(true);
    const M = new THREE.Matrix4().multiplyMatrices(d.root.matrix, d.pivot.matrix).elements;
    return local.map(({ positions: P, indices }) => {
      const out = new Float32Array(P.length);
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
        out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
        out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      }
      return { positions: out, indices };
    });
  }

  /** Re-sync collision with the current pose / visibility. */
  refreshCollision(d: DynamicObject, rebuild: boolean) {
    if (!this.collision || d.body === undefined) return;
    if (rebuild) this.collision.updateDynamic(d.body, this.collisionParts(d));
    this.collision.setDynamicEnabled(d.body, d.visible && d.solid);
  }

  setVisible(uid: number, visible: boolean) {
    const d = this.objects.get(uid);
    if (!d) return;
    d.visible = visible;
    d.root.visible = visible;
    this.refreshCollision(d, false);
  }

  /** World-space AABB of an object (current pose). */
  bounds(d: DynamicObject, out = new THREE.Box3()) {
    d.root.updateMatrixWorld(true);
    return out.setFromObject(d.pivot);
  }

  dispose() {
    for (const m of this.standIns) m.removeFromParent();
    this.standIns = [];
    for (const d of this.objects.values()) {
      if (d.body !== undefined) this.collision?.removeDynamic(d.body);
      if (d.spawned) for (const c of d.pivot.children) (c as THREE.Mesh).geometry?.dispose();
    }
    this.bodyUids.clear();
    this.objects.clear();
    for (const x of this.disposables) x.dispose();
    this.surfaces?.dispose();
    this.disposables = [];
    this.group.removeFromParent();
  }
}

/**
 * How far from the camera a placed object is still drawn (metres from its centre, the engine's
 * draw distance + bounding radius; docs/re/object-model.md §2, SUFFERING.EXE 0x45a8c3 / 0x491990).
 * The instance's own distance (flags 0x10, engine units) wins; template flag 0x10000 means never
 * culled; otherwise 70.71 x the scaled bounding radius. (A template's own distance, template bit
 * 0x20000, is not mapped to a record field yet; no retail template sets that bit.) Infinity when
 * unknown.
 */
export function placedCullDistance(o: LevelObject, e: Entity, packages: PackageSet): number {
  const t = readObjectTemplate(packages, o.template);
  const s = o.scale ? Math.max(Math.abs(o.scale[0]), Math.abs(o.scale[1]), Math.abs(o.scale[2])) : 1;
  const r = e.bounds && e.bounds.sphere[3] > 0 ? e.bounds.sphere[3] * s : undefined;
  if (o.drawDistance !== undefined && o.drawDistance > 0) return o.drawDistance / WORLD_SCALE + (r ?? 0);
  if (t && t.flags & 0x10000) return Infinity;
  return r !== undefined ? 70.71 * r + r : Infinity;
}

/** A collision mesh with the instance scale applied (dynamic objects keep scale out of the matrix). */
function scaledMesh(mesh: CollisionMesh, s: readonly number[]): { positions: Float32Array; indices: Uint32Array } {
  const P = new Float32Array(mesh.positions.length);
  for (let i = 0; i < P.length; i += 3) {
    P[i] = mesh.positions[i] * s[0];
    P[i + 1] = mesh.positions[i + 1] * s[1];
    P[i + 2] = mesh.positions[i + 2] * s[2];
  }
  return { positions: P, indices: mesh.indices };
}

/** Placement matrix (output space) of an instance: T(pos) · R(engine rotation). */
export function instanceMatrix(position: [number, number, number], rotation: [number, number, number]) {
  const R = instanceRotation(rotation);
  return new THREE.Matrix4().set(
    R[0], R[1], R[2], position[0] / WORLD_SCALE,
    R[3], R[4], R[5], position[1] / WORLD_SCALE,
    R[6], R[7], R[8], position[2] / WORLD_SCALE,
    0, 0, 0, 1,
  );
}
