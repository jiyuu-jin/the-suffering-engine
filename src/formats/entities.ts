// Gameplay entities: typed view of the placed level objects (.lvl type 0x20 instances).
//
// See docs/game-logic.md for the full reference. Summary:
//
// * Every placed object references an object template (.odu type 2 group 1). The template
//   names its CLASS by a 32-bit class id (not a string hash we could invert - the ids are
//   constants in the class descriptor tables of Suffering.rfl / SUFFERING.EXE, from which
//   entity-classes.ts was generated: 388 classes, all retail templates resolve).
// * The class descriptor gives an ordered list of typed properties (PropType). A template
//   stores one u32 word per property in that order; list-valued properties (type & 0x1000)
//   store (count << 16 | wordOffset) pointing at their items later in the same word array.
// * A level instance overrides a subset: propIndices[k] = property index, propWords[k] = value
//   (lists point into the instance's propWords the same way).
// * Message slots: properties of type 0x11 often hold a MESSAGE id (MESSAGE_NAMES). Input
//   slots mean "when this message arrives, perform action X"; output slots mean "when event Y
//   happens, send this message to every object in my `links` list". Links are uids. The
//   complete slots (inherited ones included), fixed message ids and catch-all receivers come
//   from the classes' message maps (message-maps.ts, docs/re/object-model.md).

import type { SrscFile } from './srsc';
import { findEntry, ODU_OBJECT, type PackageSet, type ResRef, type RiotPackage } from './model';
import type { LevelObject } from './level';
import { parseLevelObjects, WORLD_SCALE } from './level';
import { parseObjectTemplate, parseXduString, XDU_STRING } from './sound';
import { CATEGORY_NAMES, CLASS_ROWS, MESSAGE_NAMES } from './entity-classes';
import { MESSAGE_MAP_ROWS, type CatchAll } from './message-maps';
import { RE_CLASS_NAMES, RE_FAMILY_NAMES } from './property-names';

export { CATEGORY_NAMES, MESSAGE_NAMES } from './entity-classes';

/** A package as needed for entities: the .odu is required, .xdu (strings) optional. */
export interface EntityPackage extends RiotPackage {
  xdu?: SrscFile;
  /** .qdu (STOMP sequences), optional. */
  qdu?: SrscFile;
}
export type EntityPackageSet = Map<number, EntityPackage> | PackageSet;

// ---------------------------------------------------------------------------
// Property types

/** Base property type = code & 0xff. Flags: 0x1000 list; 0x2000/0x4000 unknown qualifiers. */
export const PropType = {
  Int: 0x01,
  Float: 0x02,
  Template: 0x03, // .odu object (type 2)
  Model: 0x04, // .mdu
  Sound: 0x05, // .sdu
  Bool: 0x07, // 0/1; a few classes use it as a small enum
  SignedInt: 0x08, // -1 = unset
  Animation: 0x09, // .adu
  String: 0x0a, // .xdu
  Sequence: 0x0b, // .qdu (STOMP sequence)
  Texture: 0x0e, // .tdu
  Color: 0x0f, // 0xAARRGGBB
  Video: 0x10, // .vdu
  Enum: 0x11, // enum or MESSAGE id
  Waveform: 0x12, // .wdu (curves / rumble)
  Link: 0x13, // level-object uid
  Font: 0x14, // .fdu
} as const;
export const PROP_LIST = 0x1000;

const REF_TYPES = new Set<number>([0x03, 0x04, 0x05, 0x09, 0x0a, 0x0b, 0x0e, 0x10, 0x12, 0x14]);

export type PropScalar = number | ResRef | null;
export type PropValue = PropScalar | PropScalar[];

// ---------------------------------------------------------------------------
// Class table

export type ClassFamily = '' | 'GameObject' | 'PhysicalObject' | 'Item' | 'Character';

export interface ClassDef {
  hash: number;
  name: string;
  category: number;
  categoryName: string;
  flags: number;
  /** Property type codes in property-index order. */
  types: number[];
  /** Group sizes (the editor's property pages / C++ base-class property sets). */
  groups: number[];
  /**
   * Message-slot property indices. Classes with a recovered message map (message-maps.ts,
   * docs/re/object-model.md) list exactly the map's slots, inherited ones included; the rest
   * fall back to the static scan of entity-classes.ts plus schema names.
   */
  inputs: number[];
  outputs: number[];
  /** Message ids the class map handles whatever its properties hold (e.g. Player 400 / 401). */
  fixedInputs: number[];
  /** "Any message" hook (vtable +0x28): '' none, 'filter', 'behaviors', 'mailbox', 'handler'. */
  catchAll: CatchAll;
  /** RFL VAs of the class's message map and its parents (most derived first); [] = no map. */
  messageMaps: number[];
  /** True when the class's constructor was read (message-maps.ts): its slots are complete. */
  slotsKnown: boolean;
  /** Output fired to the links when a Destroy message removes the object (PhysicalObject p21), 0 = none. */
  destroyOutput: number;
  family: ClassFamily;
  module: 'rfl' | 'exe';
  /** Property names by index (schema names, else "p<index>"). */
  propNames: string[];
}

// Property names. Only names backed by code inspection or unambiguous data are given; every
// other property is "p<index>". Message slots use the prefix "in"/"out".
const FAMILY_NAMES: Record<string, Record<number, string>> = {
  GameObject: {
    0: 'health',
    1: 'maxHealth',
    7: 'attachments',
    11: 'inBlowUp',
    12: 'inDestroy',
    13: 'inInvulnerableOn',
    14: 'inInvulnerableOff',
    15: 'outOnDamaged',
  },
  // docs/game-logic.md §14.1: p18 spawned when it breaks (p19: face away from the attacker),
  // p21 fired to the links when it breaks or is destroyed. p22 / p23 / p28 / p29 belong to the
  // usable objects only (USABLE_OBJECT_NAMES below).
  PhysicalObject: { 18: 'breakSpawn', 19: 'breakFacesAttacker', 21: 'outOnBroken' },
  Item: {
    22: 'pickupName',
    23: 'pickupText2',
    24: 'inventoryFullText',
    28: 'animation',
    29: 'inventoryModel',
    46: 'sound0',
    47: 'sound1',
    48: 'pickupSound',
    49: 'sound3',
    53: 'outOnPickup',
    54: 'outOnPickup2',
  },
};

const CLASS_NAMES: Record<string, Record<number, string>> = {
  Detector: {
    0: 'startEnabled',
    1: 'detectFilter',
    2: 'destroyAfterTrigger',
    3: 'requireCheck',
    4: 'inEnable',
    5: 'inDisable',
    6: 'inDestroy',
    7: 'outOnEnter',
    8: 'outOnEnterAgain',
    9: 'outOnExit',
  },
  'Message Relay': { 0: 'enabled', 1: 'count', 4: 'inRelay', 5: 'inEnable', 6: 'inDisable', 7: 'inDestroy', 8: 'outRelay' },
  Timer: {
    0: 'autoStart',
    1: 'enabled',
    2: 'delay',
    3: 'delayRandom',
    4: 'loop',
    5: 'destroyAfterFire',
    6: 'inStart',
    7: 'inStop',
    8: 'inEnable',
    9: 'inDisable',
    10: 'inDestroy',
    11: 'outOnFire',
  },
  'Count Down To Zero': {
    0: 'count',
    1: 'destroyAtZero',
    2: 'p2',
    3: 'inIncrement',
    4: 'inDecrement',
    5: 'inReset',
    6: 'outOnZero',
  },
  'Level Transition': {
    0: 'targetLevel',
    1: 'targetSpawnNames',
    2: 'p2Template',
    3: 'chapter',
    6: 'enabled',
    7: 'carryOverObjects',
    10: 'inTransition',
    11: 'inEnable',
    12: 'inDisable',
  },
  'Player Spawn Point': { 0: 'fromLevel', 1: 'spawnName', 2: 'active', 4: 'links4', 5: 'links5', 6: 'p6Template' },
  Autosave: { 0: 'inSave' },
  'Unspeakable NPC': { 28: 'outOnDeath' },
  'STOMP Player': { 0: 'sequence', 4: 'inPrefetch', 5: 'inPlay', 6: 'inDestroy', 7: 'outOnFinished' },
  'Visibility Toggler': { 0: 'startHidden', 1: 'inShow', 2: 'inHide', 3: 'inToggle' },
  'Sound Effect': { 0: 'sounds', 3: 'playMode', 6: 'interval', 7: 'jitter', 9: 'positionMode', 12: 'stopFade', 13: 'fadeIn', 10: 'attachTo', 11: 'linkedObjects', 14: 'inPlay', 15: 'inStop', 16: 'inP16', 17: 'inDestroy', 18: 'outOnFinished' },
  'Object Generator': { 0: 'spawnTemplates', 31: 'inDestroy', 32: 'inStart', 33: 'inStop', 34: 'inToggle', 35: 'inPrefetch' },
  'Help Popup': { 7: 'guiTemplate', 8: 'text', 9: 'inShow', 10: 'inHide', 11: 'inDestroy', 12: 'outOnClosed' },
  'Movie Player': { 0: 'video', 1: 'sound', 8: 'fadeColor', 10: 'inPlay', 14: 'outOnFinished' },
  'Edge Passage': { 1: 'door', 2: 'nodeA', 3: 'nodeB' },
  'Ammo Box': { 55: 'itemTemplate', 56: 'amount' },
  'Health Bonus Item': { 55: 'healAmount', 56: 'p56Template', 57: 'p57' },
  Switch: { 57: 'angleA', 58: 'angleB', 61: 'inActivate', 62: 'inDeactivate' },
  Portal: { 3: 'p3Template', 4: 'link' },
  'Point Light': { 0: 'color', 1: 'enabled', 3: 'lightingTemplate', 4: 'inOn', 5: 'inOff', 6: 'onAtStart', 8: 'radius' },
  'Light Housing': { 32: 'onMaterials', 33: 'offMaterials', 44: 'inOn', 45: 'inOff' },
  'Particle Fountain': { 26: 'particlesPerSecond', 36: 'textures', 50: 'inOn', 51: 'inOff', 52: 'inDestroy' },
  'Security Monitor': { 47: 'cameraUid', 51: 'cameraFov', 70: 'inDisable', 71: 'inEnable' },
  Ladder: { 30: 'height' },
  'Spot Light': { 0: 'color', 1: 'enabled', 3: 'lightingTemplate' },
  'Directional Light': { 0: 'color', 1: 'enabled', 3: 'lightingTemplate' },
  'Ambient Light': { 0: 'color', 1: 'enabled', 3: 'lightingTemplate' },
  'Simple Material': { 0: 'surface', 1: 'texture' },
  'Advanced Material': { 0: 'surface', 1: 'texture' },
};

/**
 * The "usable object" message map (RFL 0x10178608, docs/re/object-model.md §1.4): p28 unlocks,
 * p29 locks (both set state bit 0x8 through vtable +0xd8). Only the classes whose map chain
 * holds it have these slots; other PhysicalObjects use p22 / p23 / p28 / p29 for other things
 * (an Animating Static's p23 is an animation list).
 */
export const USABLE_OBJECT_MAP = 0x10178608;
/** Classes registering the usable-object map (generated maps; tests keep the two in step). */
export const USABLE_OBJECT_CLASSES: ReadonlySet<string> = new Set([
  'Switch',
  'Light Housing',
  'Ladder',
  'Pushable',
  'Phone',
  'Toilet',
  'Mountable',
  'Security Monitor',
  'Clamber Point',
  'Quest Item Pickup',
]);
// p22: unlocked at start (state bit 0x8); p23: usable by the player at all (0 -> use code 3,
// RFL 0x100bae9d); p28 / p29 unlock / lock.
const USABLE_OBJECT_NAMES: Record<number, string> = { 22: 'unlocked', 23: 'usable', 28: 'inUnlock', 29: 'inLock' };

const FAMILY_SPAN: Record<string, string[]> = {
  GameObject: ['GameObject'],
  PhysicalObject: ['GameObject', 'PhysicalObject'],
  Item: ['GameObject', 'PhysicalObject', 'Item'],
  Character: ['GameObject'],
};

const MAP_BY_CLASS = new Map(MESSAGE_MAP_ROWS.map((r) => [r[0] >>> 0, r]));

function buildClass(row: (typeof CLASS_ROWS)[number]): ClassDef {
  const [hash, name, category, flags, groupStr, ins, outs, family, module] = row;
  const map = MAP_BY_CLASS.get(hash >>> 0);
  const groups = groupStr ? groupStr.split('|').map((g) => (g ? g.split('.').map((t) => parseInt(t, 16)) : [])) : [];
  const types = groups.flat();
  const names: Record<number, string> = {};
  // Reverse-engineered names (property-names.ts, docs/re/properties.md) under the hand-written ones.
  for (const f of FAMILY_SPAN[family] ?? []) Object.assign(names, RE_FAMILY_NAMES[f], FAMILY_NAMES[f]);
  if (map?.[2].includes(USABLE_OBJECT_MAP)) Object.assign(names, USABLE_OBJECT_NAMES);
  Object.assign(names, RE_CLASS_NAMES[name] ?? {}, CLASS_NAMES[name] ?? {});
  // Statically recovered slots are only trusted on Enum-typed properties. A recovered message
  // map is authoritative for the inputs (schema names do not add slots the map lacks).
  const mapped = !!map;
  const inputs = new Set(mapped ? map[3] : ins.filter((i) => types[i] === PropType.Enum));
  const outputs = new Set([...outs, ...(map?.[5] ?? [])].filter((i) => types[i] === PropType.Enum));
  for (const [k, v] of Object.entries(names)) {
    const i = Number(k);
    if (types[i] !== PropType.Enum) continue;
    if (v.startsWith('in') && !mapped) inputs.add(i);
    else if (v.startsWith('out')) outputs.add(i);
  }
  return {
    hash,
    name,
    category,
    categoryName: CATEGORY_NAMES[category] ?? `category ${category}`,
    flags,
    types,
    groups: groups.map((g) => g.length),
    inputs: [...inputs].sort((a, b) => a - b),
    outputs: [...outputs].sort((a, b) => a - b),
    fixedInputs: map ? [...map[4]] : [],
    catchAll: map?.[6] ?? '',
    messageMaps: map ? [...map[2]] : [],
    slotsKnown: !!map,
    destroyOutput: map?.[8] ?? 0,
    family: family as ClassFamily,
    module,
    propNames: types.map((_, i) => names[i] ?? `p${i}`),
  };
}

export const CLASSES: Map<number, ClassDef> = new Map(CLASS_ROWS.map((r) => [r[0] >>> 0, buildClass(r)]));
export const CLASS_BY_NAME: Map<string, ClassDef> = new Map([...CLASSES.values()].map((c) => [c.name, c]));

export const classByHash = (h: number) => CLASSES.get(h >>> 0);
export const className = (h: number) => CLASSES.get(h >>> 0)?.name ?? `class_${(h >>> 0).toString(16).padStart(8, '0')}`;

// ---------------------------------------------------------------------------
// Templates

export interface TemplateBounds {
  /** Bounding sphere centre + radius (model units, template space). */
  sphere: [number, number, number, number];
  /** Oriented box: corner + three edge vectors (model units). A unit cube is (-.5,-.5,-.5) + I. */
  boxOrigin: [number, number, number];
  boxAxes: [number, number, number, number, number, number, number, number, number];
}

export interface ObjectTemplateDef {
  ref: ResRef;
  classHash: number;
  modelRef?: ResRef;
  flags: number;
  bounds?: TemplateBounds;
  words: Uint32Array;
  propCount: number;
}

function readBounds(v: DataView, o: number): TemplateBounds {
  const f = (i: number) => v.getFloat32(o + 4 * i, true);
  return {
    sphere: [f(0), f(1), f(2), f(3)],
    boxOrigin: [f(4), f(5), f(6)],
    boxAxes: [f(7), f(8), f(9), f(10), f(11), f(12), f(13), f(14), f(15)],
  };
}

const templateCache = new WeakMap<SrscFile, Map<number, ObjectTemplateDef | null>>();

export function readObjectTemplate(pkgs: EntityPackageSet, ref: ResRef): ObjectTemplateDef | undefined {
  const f = pkgs.get(ref.pkg)?.odu;
  if (!f) return undefined;
  let cache = templateCache.get(f);
  if (!cache) templateCache.set(f, (cache = new Map()));
  const hit = cache.get(ref.id);
  if (hit !== undefined) return hit ?? undefined;
  const e = findEntry(f, ODU_OBJECT, ref.id);
  let out: ObjectTemplateDef | null = null;
  if (e && e.group === 1) {
    const v = f.data(e);
    const t = parseObjectTemplate(v);
    if (t) {
      out = {
        ref,
        classHash: t.classHash >>> 0,
        modelRef: t.model && t.model.pkg ? t.model : undefined,
        flags: v.getUint32(4, true),
        bounds: v.getUint16(12, true) ? readBounds(v, 14) : undefined,
        words: t.words,
        propCount: t.propCount,
      };
    }
  }
  cache.set(ref.id, out);
  return out ?? undefined;
}

// ---------------------------------------------------------------------------
// Property decoding

const toRef = (w: number): ResRef | null => (w ? { id: w & 0xffff, pkg: w >>> 16 } : null);
const f32buf = new DataView(new ArrayBuffer(4));
const toF32 = (w: number) => (f32buf.setUint32(0, w >>> 0, true), f32buf.getFloat32(0, true));

export function decodeScalar(type: number, w: number): PropScalar {
  const b = type & 0xff;
  w >>>= 0;
  if (b === PropType.Float) return toF32(w);
  if (b === PropType.SignedInt) return w | 0;
  if (REF_TYPES.has(b)) return toRef(w);
  return w; // int, bool, enum/message, color, link uid
}

/** Decode one property from a word array (template words, or instance override words). */
function decodeAt(type: number, words: ArrayLike<number>, k: number): PropValue {
  const w = words[k] >>> 0;
  if (type & PROP_LIST) {
    const n = w >>> 16, off = w & 0xffff;
    const out: PropScalar[] = [];
    for (let i = 0; i < n && off + i < words.length; i++) out.push(decodeScalar(type, words[off + i]));
    return out;
  }
  return decodeScalar(type, w);
}

/** Template defaults, by property index. */
export function decodeTemplateProps(cls: ClassDef | undefined, t: ObjectTemplateDef): PropValue[] {
  const n = t.propCount;
  const out: PropValue[] = [];
  for (let i = 0; i < n; i++) out.push(cls && i < cls.types.length ? decodeAt(cls.types[i], t.words, i) : t.words[i] >>> 0);
  return out;
}

// ---------------------------------------------------------------------------
// Entities

export interface MessageSlot {
  slot: number;
  name: string;
  message: number;
  messageName: string;
}

export interface Entity {
  index: number;
  uid: number;
  className: string;
  classHash: number;
  category: string;
  family: ClassFamily;
  template: ResRef;
  /** Engine units (2048 per model unit), engine space (Y up). */
  position: [number, number, number];
  /** Degrees about x, y, z (see level.ts instanceRotation). */
  rotation: [number, number, number];
  scale?: [number, number, number];
  flags: number;
  /** Outgoing links (uids). Output messages go to these. */
  links: number[];
  /** Effective properties by name (template defaults + instance overrides). */
  props: Record<string, unknown>;
  /** Same, by property index. */
  values: PropValue[];
  /** Property indices the instance overrides. */
  overridden: number[];
  inputs: MessageSlot[];
  outputs: MessageSlot[];
  /** Message ids the class handles regardless of its properties (ClassDef.fixedInputs). */
  fixedInputs: number[];
  /** The class's "any message" hook (ClassDef.catchAll). */
  catchAll: CatchAll;
  /** Output fired on a Destroy message (ClassDef.destroyOutput). */
  destroyOutput: number;
  /** Model drawn for this object (template model), if any. */
  modelRef?: ResRef;
  /** Template bounds (or the instance's own block when flags & 0x8000). */
  bounds?: TemplateBounds;
}

export interface EntityOptions {
  /** Resolve String properties to text when the package's .xdu is supplied. Default true. */
  resolveStrings?: boolean;
  /** Ignore the placed-object filter (setPlacedObjectFilter) and return every record. */
  all?: boolean;
}

/**
 * Runtime filter for placed objects the engine does not create. The engine skips every
 * instance whose flags hold `(0x10000 << difficulty) | 0x8` when it loads a level
 * (SUFFERING.EXE 0x45a63f; docs/campaign.md "Difficulty"). The campaign module installs
 * the filter for the current difficulty; tools leave it unset and see every record.
 */
let placedObjectFilter: ((o: LevelObject) => boolean) | null = null;
export function setPlacedObjectFilter(fn: ((o: LevelObject) => boolean) | null): void {
  placedObjectFilter = fn;
}

/** Read an .xdu string (u16 byte length + UTF-16LE). */
export function readXduString(pkgs: EntityPackageSet, ref: ResRef): string | undefined {
  const f = (pkgs.get(ref.pkg) as EntityPackage | undefined)?.xdu;
  const e = findEntry(f, XDU_STRING, ref.id);
  return f && e ? parseXduString(f.data(e)) : undefined;
}

export function messageName(id: number): string {
  return MESSAGE_NAMES[id] ?? (id ? `msg${id}` : '<none>');
}

export function entityFromObject(o: LevelObject, pkgs: EntityPackageSet, opts: EntityOptions = {}): Entity {
  const t = readObjectTemplate(pkgs, o.template);
  const cls = t ? classByHash(t.classHash) : undefined;
  const values: PropValue[] = t ? decodeTemplateProps(cls, t) : [];
  const overridden: number[] = [];
  const n = o.propIndices.length;
  for (let k = 0; k < n && k < o.propWords.length; k++) {
    const i = o.propIndices[k];
    const type = cls?.types[i];
    values[i] = type === undefined ? o.propWords[k] >>> 0 : decodeAt(type, o.propWords, k);
    overridden.push(i);
  }
  const props: Record<string, unknown> = {};
  const resolve = opts.resolveStrings ?? true;
  values.forEach((v, i) => {
    const name = cls?.propNames[i] ?? `p${i}`;
    const type = cls?.types[i] ?? 0;
    if (resolve && (type & 0xff) === PropType.String) {
      const str = (r: PropScalar) => (r && typeof r === 'object' ? (readXduString(pkgs, r) ?? r) : r);
      props[name] = Array.isArray(v) ? v.map(str) : str(v as PropScalar);
    } else props[name] = v;
  });
  const slot = (i: number): MessageSlot => {
    const m = typeof values[i] === 'number' ? (values[i] as number) : 0;
    return { slot: i, name: cls?.propNames[i] ?? `p${i}`, message: m, messageName: messageName(m) };
  };
  return {
    index: o.index,
    uid: o.uid,
    className: cls?.name ?? (t ? className(t.classHash) : 'unresolved'),
    classHash: t?.classHash ?? 0,
    category: cls?.categoryName ?? '',
    family: cls?.family ?? '',
    template: o.template,
    position: o.position,
    rotation: o.rotation,
    scale: o.scale,
    flags: o.flags,
    links: o.links,
    props,
    values,
    overridden,
    inputs: (cls?.inputs ?? []).filter((i) => i < values.length).map(slot),
    outputs: (cls?.outputs ?? []).filter((i) => i < values.length).map(slot),
    fixedInputs: cls?.fixedInputs ?? [],
    catchAll: cls?.catchAll ?? '',
    destroyOutput: cls?.destroyOutput ?? 0,
    modelRef: t?.modelRef,
    bounds: t?.bounds,
  };
}

/**
 * Typed gameplay entities for every placed object of a level.
 * `packages` must hold the .odu of every package the level references (see readLevelHeader)
 * - in particular System (2), Resources (4), NPCs (10), the chapter and the level package.
 */
export function parseEntities(lvl: SrscFile, packages: EntityPackageSet, opts: EntityOptions = {}): Entity[] {
  const objects = parseLevelObjects(lvl);
  const filter = opts.all ? null : placedObjectFilter;
  return (filter ? objects.filter(filter) : objects).map((o) => entityFromObject(o, packages, opts));
}

// ---------------------------------------------------------------------------
// Helpers for gameplay code

/** Entities by uid. */
export function indexEntities(ents: Entity[]): Map<number, Entity> {
  return new Map(ents.map((e) => [e.uid, e]));
}

/** uid -> uids linking to it. */
export function inboundLinks(ents: Entity[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const e of ents) for (const l of e.links) (m.get(l) ?? m.set(l, []).get(l)!).push(e.uid);
  return m;
}

/** How one link message (sender output slot -> linked target) is received. */
export type LinkReceipt = 'slot' | 'fixed' | 'catchAll' | 'ignored' | 'unknown';

export interface LinkCoverage {
  /** Messages sent along links from output slots (one per sender slot and target). */
  sent: number;
  slot: number;
  fixed: number;
  catchAll: number;
  /** Target has a recovered message map, no catch-all, and no entry for the message: the engine drops it. */
  ignored: number;
  /** Target class has no recovered map (engine classes such as lights, or classes without slots). */
  unknown: number;
  /** Messages to classes whose slots are not known, by `targetClass <- messageName`. */
  misses: Map<string, number>;
}

/** Classify a message arriving at an entity the way the engine dispatcher does. */
export function receiptOf(target: Entity, message: number): LinkReceipt {
  if (target.inputs.some((i) => i.message === message)) return 'slot';
  if (target.fixedInputs.includes(message)) return 'fixed';
  if (target.catchAll) return 'catchAll';
  return classByHash(target.classHash)?.slotsKnown ? 'ignored' : 'unknown';
}

/** Link-message coverage of a level (docs/re/object-model.md: before / after the maps). */
export function linkCoverage(ents: Entity[]): LinkCoverage {
  const byUid = indexEntities(ents);
  const c: LinkCoverage = { sent: 0, slot: 0, fixed: 0, catchAll: 0, ignored: 0, unknown: 0, misses: new Map() };
  for (const e of ents) {
    for (const s of e.outputs) {
      if (!s.message) continue;
      for (const l of e.links) {
        const t = byUid.get(l);
        if (!t) continue;
        c.sent++;
        const r = receiptOf(t, s.message);
        c[r]++;
        if (r === 'unknown') {
          const k = `${t.className} <- ${messageName(s.message)}`;
          c.misses.set(k, (c.misses.get(k) ?? 0) + 1);
        }
      }
    }
  }
  return c;
}

/**
 * World-space (engine units) corners of an entity's box volume (Detectors, Portals, fog,
 * trigger zones): template box scaled by the instance scale, rotated, translated.
 */
export function entityBoxCorners(e: Entity, rot: (r: [number, number, number]) => number[]): [number, number, number][] | undefined {
  const b = e.bounds;
  if (!b) return undefined;
  const s = e.scale ?? [1, 1, 1];
  const R = rot(e.rotation);
  const out: [number, number, number][] = [];
  for (let c = 0; c < 8; c++) {
    const t = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
    const p = [0, 1, 2].map((k) => b.boxOrigin[k] + t[0] * b.boxAxes[k] + t[1] * b.boxAxes[3 + k] + t[2] * b.boxAxes[6 + k]);
    const q = p.map((x, k) => x * s[k]);
    out.push([0, 1, 2].map((r) => e.position[r] + WORLD_SCALE * (R[3 * r] * q[0] + R[3 * r + 1] * q[1] + R[3 * r + 2] * q[2])) as [number, number, number]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// STOMP sequences (.qdu, entry type 0x11 group 3) - header only.
//
//   u32 flags, f32 length (seconds?), u32 a, u32 b, u16 len + name (padded so 2+len is a
//   multiple of 4), u32 trackCount, then tracks. The first track starts with the uid of the
//   level object it drives (u32), followed by a 16, a key count and a key/transform stream that
//   is not decoded yet (see docs/game-logic.md).

export const QDU_SEQUENCE = 0x11;

export interface SequenceHeader {
  id: number;
  flags: number;
  length: number;
  a: number;
  b: number;
  name: string;
  trackCount: number;
  /** uid of the level object driven by the first track. */
  firstTrackUid: number;
}

export function parseSequenceHeader(file: SrscFile, id: number): SequenceHeader | undefined {
  const e = findEntry(file, QDU_SEQUENCE, id);
  if (!e || e.size < 24) return undefined;
  const v = file.data(e);
  const len = v.getUint16(16, true);
  let name = '';
  for (let i = 0; i < len; i++) {
    const c = v.getUint8(18 + i);
    if (!c) break;
    name += String.fromCharCode(c);
  }
  const p = 18 + len;
  if (p + 8 > v.byteLength) return undefined;
  return {
    id,
    flags: v.getUint32(0, true),
    length: v.getFloat32(4, true),
    a: v.getUint32(8, true),
    b: v.getUint32(12, true),
    name,
    trackCount: v.getUint32(p, true),
    firstTrackUid: v.getUint32(p + 4, true),
  };
}
