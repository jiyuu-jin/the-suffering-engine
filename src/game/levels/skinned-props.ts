// Skinned scenery that no other system draws.
//
// The static level geometry skips skinned models (level.ts), the actors system takes
// characters and Animating Statics, the sequence presenter draws skinned plain props that are
// STOMP tracks (sequence/props.ts), and dynamic.ts skips skinned props. That leaves placed
// skinned Light Housings / Breakables / Static Objects / Switches that are not STOMP tracks
// invisible: 23:170 hanging lamps (6a, 6b x2, 8a, 10 Docks), 25:4 (6b, 7), 34:86 (10 Docks), the
// Projector Effect targets (1a #8897 12:624 and 1c #808d / 5b 7:653..655, projected figures whose
// one beam vertex follows a projector lens: actors/specials/projector.ts) and a few parked ones
// in chapter 1 (1a / 1b / 1c 7337, 734e, 7350, the cell doors 69ec / 58b3 / 68a8 / 702e that
// 1a's intro animates, 4b 7829 / 782a). Audit: docs/game-logic.md §14.8.
//
// Shown by the engine's visibility only: instance flag 0x1 at load (SetVisible(flags & 1),
// docs/re/object-model.md §2) and then the level logic; flag 0x80 is an editor bit the instance
// loader never reads [verified there]. Posed in the rig's bind pose: PhysicalObject classes start
// no clip [inferred: no clip property, and the projected figures' anim sets hold one 2-frame
// pose]. Moved by STOMP transform keys (WorldService.onStompTransform) and posed by STOMP
// animation keys (the sequence presenter plays them on these Characters through
// ctx.services.skinnedProps.character(uid), src/game/sequence/system.ts); update(dt) advances
// their mixers. Breaking is the world's (props.ts: health, p18 generator, p21, destroy); a
// destroyed object is hidden here. They have no collision, as no skinned model carries a
// collision record (§14.7).
//
// Cranes (class 0xf67a582e "Crane", PhysicalObject family): Prelude 11d, 4b 7a26 / 7a2f /
// 7a37 (Outdoor Common 23:649 / 23:630: an 18 m tower with a 17 m jib, 5 bones, anim set 140)
// and the 4a one. Every placement has instance flags 0x1, never 0x80, and the model is skinned,
// so the static level, dynamic.ts (skips skinned models) and the sequence presenter (skips
// tracks without flag 0x80) all left them out [verified on the data]. Here: drawn whatever
// their flags are, posed with Crane p41 (a pose clip of set 140: 23:57 in 4b, 23:58 in the
// Prelude) [inferred: p41..p43 are three clip refs, all the same].
// The hoist (cable length on bones p26 / p27, the hook block of p36 hung on bone p35, Increment /
// Decrement raising it, the motor sounds) is crane.ts, decoded from the class code.
//
// Collision of a crane (docs/levels.md §4.6) [verified unless marked]: the Crane's own model is
// skinned (23:630) and carries no collision record, so the tower and jib block nothing. The objects
// it hangs are created from their templates as ordinary engine objects (object manager create
// 0x45a0e0, called from the crane update 0x10012951) and attached to the bone (engine vt +0x18);
// nothing sets their no-collision bit (+8 0x400000), so they collide like any placed object whose
// model has a collision record: the collision gather (0x425a80) takes every object with a
// collision model (+0x64) that is shown and lacks that bit. 4a / 4b hang the "Crane Palette"
// (Breakable 23:856, static model 23:580 with its type-7 record): a stone pallet that blocks and
// the player can stand on wherever the hoist and the slew put it. Port: one dynamic body per hung
// object (its model's triangles, COLLISION_LAYER.solid as for placed props), moved with the bone
// (rebuilt when its world matrix changes) and off while the crane is hidden.
// Saves: the Crane keeps its current / target ratios (save 0x10012110 / load 0x100120d0: +0x28 /
// +0x2c), and the slew is the driving Mountable's yaw matrix (+0xce, written and read by its own
// save / load, 0x10018fc0) [verified]; the port keeps both per crane (`save` / `load`).

import * as THREE from 'three/webgpu';
import type { CollisionWorld, DynamicParts } from '../../app/physics';
import { Character, decodeCharacterTextures } from '../../app/character';
import { readSkinnedModel, hasSkeleton } from '../../formats/skeleton';
import { moverCollisionMesh } from '../../formats/model-collision';
import type { PackageSet, ResRef } from '../../formats/model';
import { loadClip } from '../actors/clipmap';
import { instanceMatrix } from '../world/dynamic';
import { sequencePropCandidate } from '../sequence/props';
import type { World } from '../world/logic';
import type { StompTransformKey } from '../world/stomp';
import { buildStaticModel } from '../weapons/models';
import { readTemplate } from '../world/fx';
import type { EntityPackageSet } from '../../formats/entities';
import { CraneHoist, craneParams } from './crane';

/** Plays one of the sound refs ("pkg:id") at a position; `loop` keeps it going until stopped. */
export type PropSound = (keys: string[], at: [number, number, number], loop?: boolean) => { stop(): void } | undefined;

interface CraneRig {
  hoist: CraneHoist;
  top: THREE.Bone;
  end: THREE.Bone;
  /** The bone the hook hangs on (p39): Detectors with filter 5 test it. */
  hook?: THREE.Bone;
  /** The objects hung on the rig (p36 on p35): 4a / 4b hang a boulder (23:856) on bone 3. */
  hung: THREE.Object3D[];
  /** The slew (rad) of the bone p22 a Mountable's controls turn (0x100183e0). */
  slew: number;
  /** Collision of the hung objects (see the header). */
  bodies: HungBody[];
  loop?: { stop(): void };
}

/** A hung object's collision: its model's triangles in its own space and the body built from them. */
export interface HungBody {
  obj: THREE.Object3D;
  local: DynamicParts;
  body?: number;
  /** The world matrix the body was last built at. */
  at: THREE.Matrix4;
}

/** Per crane (uid in hex): the hoist's current / target ratios and the slew (rad). */
export type CranesSave = Record<string, { current: number; target: number; slew: number }>;

/** Triangles of a built model in the space of its root (the meshes' own transforms applied). */
export function hungLocalParts(model: THREE.Object3D): DynamicParts {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const out: DynamicParts = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  model.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const a = g?.attributes.position;
    if (!g || !a) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    const positions = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) {
      v.fromBufferAttribute(a, i).applyMatrix4(m);
      positions[3 * i] = v.x;
      positions[3 * i + 1] = v.y;
      positions[3 * i + 2] = v.z;
    }
    const indices = g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : Uint32Array.from({ length: a.count }, (_, i) => i);
    out.push({ positions, indices });
  });
  return out;
}

/** `local` placed at world matrix `m`. */
export function hungWorldParts(local: DynamicParts, m: THREE.Matrix4): DynamicParts {
  const e = m.elements;
  return local.map(({ positions: P, indices }) => {
    const positions = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      positions[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      positions[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      positions[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return { positions, indices };
  });
}

const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((x, i) => Math.abs(x - b.elements[i]) < 1e-5);

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const CLASSES = new Set(['Light Housing', 'Breakable', 'Static Object', 'TargetableBreakable', 'Switch', 'Crane']);
/** Drawn whatever the instance flags (see the header). */
const ALWAYS = new Set(['Crane']);

/**
 * Drawn here: a skinned placed object of a prop class that the sequence presenter does not
 * draw (a STOMP track it takes as a prop, sequence/props.ts). Models of the system package are
 * editor proxies.
 */
export function skinnedPropDrawn(cls: string, flags: number, modelPkg: number, isTrack: boolean): boolean {
  if (!CLASSES.has(cls) || modelPkg === 2) return false;
  if (ALWAYS.has(cls)) return true;
  return !(isTrack && sequencePropCandidate(cls, flags, modelPkg));
}

export class SkinnedProps {
  readonly group = new THREE.Group();
  private readonly props = new Map<number, Character>();
  /** Crane hoists by uid (crane.ts). */
  readonly cranes = new Map<number, CraneRig>();

  private unsubscribe?: () => void;

  constructor(
    private readonly world: World,
    packages: PackageSet,
    _levelPath: string,
    onStompTransform?: (fn: (uid: number, key: StompTransformKey | null) => void) => () => void,
    private readonly sound?: PropSound,
    /** The collision world the hung objects' bodies go into (absent: no collision). */
    private readonly collision?: () => CollisionWorld | null | undefined,
  ) {
    this.group.name = 'levels-skinned-props';
    const tracks = new Set<number>();
    for (const sp of world.of('STOMP Player')) for (const t of world.sequenceOf(sp)?.tracks ?? []) tracks.add(t.uid);
    for (const w of world.ents.values()) {
      const e = w.e;
      const m = e.modelRef;
      const always = ALWAYS.has(w.cls);
      if (!m || !skinnedPropDrawn(w.cls, e.flags, m.pkg, tracks.has(w.uid))) continue;
      if (!hasSkeleton(packages.get(m.pkg)?.mdu, m.id)) continue;
      const skinned = readSkinnedModel(packages, m);
      if (!skinned) continue;
      const pose = always ? (e.values[41] as ResRef | null | undefined) : undefined;
      const clip = pose && typeof pose === 'object' && 'pkg' in pose ? loadClip(packages, pose) : undefined;
      const ch = new Character(skinned, clip ? [clip] : [], decodeCharacterTextures(skinned, packages));
      if (clip) {
        ch.play(0, { fade: 0 });
        ch.update(0);
      }
      ch.root.name = `levels-prop:${w.cls}#${w.uid.toString(16)}`;
      const s = new THREE.Vector3();
      instanceMatrix(e.position, e.rotation).decompose(ch.root.position, ch.root.quaternion, s);
      if (e.scale) ch.root.scale.set(e.scale[0], e.scale[1], e.scale[2]);
      ch.root.visible = w.visible && !w.destroyed;
      this.group.add(ch.root);
      this.props.set(w.uid, ch);
      ch.root.updateMatrix();
      ch.root.userData.base = ch.root.matrix.clone();
      if (w.cls === 'Crane') this.rigCrane(w.uid, ch, e.values, packages);
    }
    // Increment / Decrement (p37 / p38): the hoist goes up to its minimum (crane.ts).
    if (this.cranes.size)
      this.unsubscribeMsgs = world.subscribe('*', (msg, _from, to) => {
        const c = this.cranes.get(to);
        if (c && c.hoist.p.inputs.includes(msg)) c.hoist.control(-1);
      });
    // Sequence-driven ones follow the STOMP transform keys (engine units, as world.ts applies them).
    if (onStompTransform && this.props.size) {
      const q = new THREE.Quaternion();
      this.unsubscribe = onStompTransform((uid, key) => {
        const ch = this.props.get(uid);
        if (!ch) return;
        if (!key) {
          const base = ch.root.userData.base as THREE.Matrix4 | undefined;
          base?.decompose(ch.root.position, ch.root.quaternion, ch.root.scale);
          return;
        }
        q.set(key.quat[0], key.quat[1], key.quat[2], key.quat[3]);
        ch.root.position.set(key.position[0] / 2048, key.position[1] / 2048, key.position[2] / 2048);
        ch.root.quaternion.copy(q);
      });
    }
  }

  private unsubscribeMsgs?: () => void;

  /**
   * The crane's hoist (crane.ts, 0x10012730): the cable from bone p26 to p27 in the pose of p41,
   * scaled by the hoist ratio on p26 and its inverse on p27 after every pose; the p36 objects
   * hung on their p35 bones.
   */
  private rigCrane(uid: number, ch: Character, values: readonly unknown[], packages: PackageSet) {
    const p = craneParams(values);
    const bones = ch.skeleton.bones;
    const top = bones[p.cableTop];
    const end = bones[p.cableEnd];
    if (!top || !end) return;
    ch.root.updateMatrixWorld(true);
    const a = top.getWorldPosition(new THREE.Vector3());
    const b = end.getWorldPosition(new THREE.Vector3());
    const hoist = new CraneHoist(p, a.distanceTo(b));
    const yawBone = typeof values[22] === 'number' ? values[22] : -1;
    const rig: CraneRig = { hoist, top, end, hook: bones[typeof values[39] === 'number' ? values[39] : -1], slew: 0, hung: [], bodies: [] };
    this.cranes.set(uid, rig);
    ch.poseHooks.push(() => {
      // The controls' yaw matrix on bone p22 (Mountable +0xce, an axis-angle about +Y) [verified
      // matrix and bone; applied in model space about the bone's pivot, inferred].
      if (yawBone >= 0 && rig.slew) ch.rotateBoneModel(yawBone, _q.setFromAxisAngle(_up, rig.slew));
      top.scale.setScalar(hoist.current);
      end.scale.setScalar(1 / hoist.current);
    });
    for (const h of p.hung) {
      const t = readTemplate(packages as EntityPackageSet, h.template);
      const model = t?.model ? buildStaticModel(packages, t.model) : undefined;
      const bone = bones[h.bone];
      if (!model || !bone) continue;
      model.name = `crane-hung:${h.template.pkg}:${h.template.id}`;
      // Its body is the model's collision tree (docs/game-logic.md §14.10): the "Crane Palette"
      // 23:580 is one box under the pallet, not its cables.
      const mdu = t?.model ? packages.get(t.model.pkg)?.mdu : undefined;
      const tree = mdu && t?.model ? moverCollisionMesh(mdu, t.model.id) : undefined;
      const local: DynamicParts = tree ? [{ positions: tree.positions, indices: tree.indices }] : [];
      bone.add(model);
      rig.hung.push(model);
      if (local.length) rig.bodies.push({ obj: model, local, at: new THREE.Matrix4() });
    }
    ch.update(0);
    this.syncBodies();
  }

  /**
   * The hung objects' bodies follow their bones and the crane's visibility; a body is rebuilt
   * only when its object moved (the hoist or the slew).
   */
  private syncBodies() {
    const col = this.collision?.();
    if (!col) return;
    for (const [uid, c] of this.cranes) {
      const ch = this.props.get(uid);
      const on = !!ch?.root.visible;
      for (const b of c.bodies) {
        b.obj.updateWorldMatrix(true, false);
        const m = b.obj.matrixWorld;
        if (b.body === undefined) {
          b.body = col.addDynamic(hungWorldParts(b.local, m), on);
          b.at.copy(m);
        } else if (!sameMatrix(b.at, m)) {
          col.updateDynamic(b.body, hungWorldParts(b.local, m));
          b.at.copy(m);
        }
        col.setDynamicEnabled(b.body, on);
      }
    }
  }

  /** The crane hoists and slews (Crane save 0x10012110, Mountable save: its yaw +0xce). */
  save(): CranesSave {
    const out: CranesSave = {};
    for (const [uid, c] of this.cranes) out[uid.toString(16)] = { current: c.hoist.current, target: c.hoist.target, slew: c.slew };
    return out;
  }

  load(d: CranesSave) {
    for (const [k, s] of Object.entries(d ?? {})) {
      const c = this.cranes.get(parseInt(k, 16));
      if (!c || !s) continue;
      const fin = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
      c.hoist.current = fin(s.current, c.hoist.current);
      c.hoist.target = fin(s.target, c.hoist.current);
      c.hoist.moving = false;
      c.slew = fin(s.slew, 0);
      c.loop?.stop();
      c.loop = undefined;
      this.props.get(parseInt(k, 16))?.update(0);
    }
    this.syncBodies();
  }

  /**
   * A Mountable's crane controls (aim 0x100183e0 with the crane flag; Crane input clamp
   * 0x100125d0, control 0x10012b90) [verified unless marked]: the larger of the two inputs
   * counts, the other is dropped; Mountable p36 inverts the slew; the slew turns at p40 deg/s
   * times the input, within +-p38 deg of the rest pose; a hoist input sets the hook's target
   * (up to p28, or down to p29 / what lies under the hook).
   */
  driveCrane(mountable: { e: { values: readonly unknown[] } }, uid: number, hoist: number, slew: number, dt: number, below?: (at: THREE.Vector3) => number | undefined) {
    const c = this.cranes.get(uid);
    if (!c) return;
    const v = mountable.e.values;
    const n = (i: number, d: number) => (typeof v[i] === 'number' ? (v[i] as number) : d);
    if (Math.abs(hoist) >= Math.abs(slew)) slew = 0;
    else hoist = 0;
    if (n(36, 0)) slew = -slew;
    const range = THREE.MathUtils.degToRad(n(38, 360));
    c.slew = THREE.MathUtils.clamp(c.slew + THREE.MathUtils.degToRad(n(40, 0)) * dt * slew, -range, range);
    if (hoist > 0) {
      // Down to p29, or to what a sweep down meets first (radius p40; a ray here). The control
      // sweeps the object hung on bone p39 (it asks the rig for that attachment and its bounds
      // first, 0x10012e40) [strong]: the ray starts under the hung object's bottom, with the
      // crane's own hung bodies out of the query.
      const at = (c.hook ?? c.end).getWorldPosition(new THREE.Vector3());
      for (const o of c.hung) {
        const box = new THREE.Box3().setFromObject(o);
        if (!box.isEmpty()) at.y = Math.min(at.y, box.min.y);
      }
      const col = this.collision?.();
      // The object's bounds are its collision model's (type-7 box; docs/game-logic.md §14.10).
      for (const b of c.bodies) {
        const bb = b.body !== undefined ? col?.dynamicBounds(b.body) : undefined;
        if (bb) at.y = Math.min(at.y, bb.min[1]);
      }
      const own = c.bodies.filter((b) => b.body !== undefined && col?.isDynamicEnabled(b.body));
      for (const b of own) col!.setDynamicEnabled(b.body!, false);
      const d = below?.(at);
      for (const b of own) col!.setDynamicEnabled(b.body!, true);
      c.hoist.control(1, d === undefined ? c.hoist.max : c.hoist.current + d / c.hoist.length);
    } else if (hoist < 0) c.hoist.control(-1);
  }

  /** Hook points of the cranes for Detectors with filter 5 (Detector scan 0x100a7e40). */
  craneHooks(): { uid: number; points: [number, number, number][] }[] {
    const out: { uid: number; points: [number, number, number][] }[] = [];
    for (const [uid, c] of this.cranes) {
      const ch = this.props.get(uid);
      if (!ch?.root.visible) continue;
      const pts: [number, number, number][] = [];
      const q = (c.hook ?? c.end).getWorldPosition(new THREE.Vector3());
      pts.push([q.x, q.y, q.z]);
      // The hung object touches the Detector (its collision against the volume, 0x100a7f98):
      // sampled on a 3 x 3 x 3 grid over its box, a little inside it [port].
      for (const o of c.hung) {
        const box = new THREE.Box3().setFromObject(o);
        if (box.isEmpty()) continue;
        const lo = box.min, hi = box.max;
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++) {
              const f = (a: number, b: number, t: number) => a + (b - a) * (0.1 + 0.4 * t);
              pts.push([f(lo.x, hi.x, i), f(lo.y, hi.y, j), f(lo.z, hi.z, k)]);
            }
      }
      out.push({ uid, points: pts });
    }
    return out;
  }

  get count() {
    return this.props.size;
  }

  /** The Character drawn for object `uid` (the sequence presenter plays its animation keys). */
  character(uid: number): Character | undefined {
    return this.props.get(uid);
  }

  update(dt = 0) {
    for (const [uid, c] of this.cranes) {
      const ev = c.hoist.update(dt);
      if (!ev || !this.sound) continue;
      const at = c.end.getWorldPosition(new THREE.Vector3());
      const pos: [number, number, number] = [at.x, at.y, at.z];
      const keys = (i: number) => c.hoist.p.hoistSounds[i].map((r) => `${r.pkg}:${r.id}`);
      if (ev === 'start') {
        this.sound(keys(0), pos);
        c.loop = this.sound(keys(1), pos, true);
      } else {
        c.loop?.stop();
        c.loop = undefined;
        this.sound(keys(2), pos);
      }
      // Stopping replays the pose clip (0x10012060).
      const ch = this.props.get(uid);
      if (ev === 'stop' && ch?.current) ch.current.reset().play();
    }
    for (const [uid, ch] of this.props) {
      const w = this.world.get(uid);
      ch.root.visible = !!w && w.visible && !w.destroyed;
      if (ch.root.visible && dt > 0 && ch.current) ch.update(dt);
    }
    if (this.cranes.size) this.syncBodies();
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribeMsgs?.();
    const col = this.collision?.();
    for (const c of this.cranes.values()) {
      c.loop?.stop();
      for (const b of c.bodies) if (b.body !== undefined) col?.removeDynamic(b.body);
    }
    this.group.removeFromParent();
    for (const ch of this.props.values()) ch.dispose();
  }
}
