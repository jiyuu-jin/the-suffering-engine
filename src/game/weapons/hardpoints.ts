// Hardpoints ("channels"): named attach points of a skinned model, and attaching objects to them.
//
// Format (decoded from SUFFERING.EXE's skeleton loader, 0x47ae80..0x47b450; docs/game-logic.md §7.1):
// the .mdu type-8 skeleton entry continues after the bone records with a trailer
//
//   20 bytes (v1) / 40 bytes (v2 = two LODs) of LOD / vertex-remap header (not needed here)
//   u32      ?                                      (stored at model +0x104)
//   u16      channelCount
//   channelCount x { u32 boneIndex, u16 n, n x u32 flags }   (v2 models: n = 2, one word per LOD;
//            the words are single bits 1, 2, 4, ... on a few channels - meaning unknown)
//   f32[3]   LOD switch distances (engine units: 20480, 40960, 81920)
//   ...      collision sphere tree (24-byte records: u16, f32 x y z r, u16 bone, u16, u16)
//
// The loader keeps the channels as 16-byte records {bone, flags list} at model +0xc8 and writes
// the channel index back into each bone (+0x40). A STOMP attach key's "hardpoint index" indexes
// this table (EXE 0x450c10: `table[hp * 16].bone` -> attach(bone, object)); weapon and character
// templates name bones directly (Player Weapon Properties p0 = 35, the right hand's weapon bone,
// p5 = 27, the left hand's; Ranged Weapon p78 / p80 = muzzle bones of the weapon model).
// The attached object's model space is put in the bone's frame with no offset (the engine passes
// no offset either), keeping the object's own instance scale. Decoded draw path: the skinned
// instance (vtable 0x591588) attaches with slot 6 (0x46d9d0, identity attachment matrix) and
// each frame sets the object to that matrix x the bone's posed matrix (0x4701c0), not the
// skinning matrix; slot 5, which would set an offset, is not used for weapons (§4.5 "Held
// weapon grip": the third-person idle / walk gap is the clips' open hand, not the placement).
//
// Player rig 2:9 (and the human NPC rigs): channel 16 = bone 35 (right-hand weapon bone, a leaf
// child of hand bone 34), channel 11 = bone 27 (left hand), 22 / 23 = bones 55 / 59 (feet).
// Guard rigs (10:44, 10:59, ...): channel 19 = bone 35 as well.

import * as THREE from 'three/webgpu';
import type { SrscFile } from '../../formats/srsc';
import { findEntry, type PackageSet, type ResRef } from '../../formats/model';
import { MDU_SKELETON } from '../../formats/skeleton';
import type { Character } from '../../app/character';

/** Channel table of a skinned model: hardpoint index -> bone index. */
export function readHardpoints(mdu: SrscFile, id: number): number[] {
  const e = findEntry(mdu, MDU_SKELETON, id);
  if (!e || e.size < 0x4c) return [];
  const v = mdu.data(e);
  const version = v.getUint32(0x40, true);
  const boneCount = v.getUint32(0x48, true);
  if (version < 1 || version > 2 || !boneCount || boneCount > 1024) return [];
  let p = 0x4c;
  for (let b = 0; b < boneCount; b++) {
    p += 60;
    for (let l = 0; l < version; l++) {
      if (p + 2 > v.byteLength) return [];
      p += 2 + 8 * v.getUint16(p, true);
    }
  }
  // The header before the table differs in size (20 / 40 bytes); find the first offset where
  // a well-formed table ends right before the three increasing LOD distances.
  for (let s = p; s + 6 <= Math.min(v.byteLength, p + 512); s += 2) {
    const table = tryTable(v, s, boneCount);
    if (table) return table;
  }
  return [];
}

function tryTable(v: DataView, start: number, boneCount: number): number[] | null {
  let o = start + 4;
  const count = v.getUint16(o, true);
  o += 2;
  if (count > 255) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 6 > v.byteLength) return null;
    const bone = v.getUint32(o, true);
    const n = v.getUint16(o + 4, true);
    o += 6;
    if (bone >= boneCount || n > 32 || o + 4 * n > v.byteLength) return null;
    o += 4 * n;
    out.push(bone);
  }
  if (o + 12 > v.byteLength) return null;
  const a = v.getFloat32(o, true), b = v.getFloat32(o + 4, true), c = v.getFloat32(o + 8, true);
  return a > 10 && b >= a && c >= b && c < 1e8 ? out : null;
}

const tables = new WeakMap<SrscFile, Map<number, number[]>>();

/** Cached channel table of a model ref (empty when the model has no skeleton). */
export function hardpointTable(pkgs: PackageSet, ref: ResRef): number[] {
  const mdu = pkgs.get(ref.pkg)?.mdu;
  if (!mdu) return [];
  let m = tables.get(mdu);
  if (!m) tables.set(mdu, (m = new Map()));
  let t = m.get(ref.id);
  if (!t) m.set(ref.id, (t = readHardpoints(mdu, ref.id)));
  return t;
}

/** Bone object of a character for a hardpoint index (STOMP) or, with `{ bone }`, a bone index. */
export function hardpointBone(pkgs: PackageSet, ch: Character, hp: number | { bone: number }): THREE.Bone | undefined {
  const bone = typeof hp === 'number' ? hardpointTable(pkgs, ch.skinned.ref)[hp] : hp.bone;
  return bone === undefined || bone < 0 ? undefined : ch.skeleton.bones[bone];
}

interface Attachment {
  obj: THREE.Object3D;
  bone: THREE.Bone;
  carrier: Character;
  /** Object scale kept from its placement. */
  scale: THREE.Vector3;
  /** Extra local transform in the bone frame (identity for engine attachments). */
  local: THREE.Matrix4;
  savedAuto: boolean;
  /** Kept while the carrier is out of the scene graph (released only by detach / clear). */
  keep: boolean;
}

const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Matrix4();
const tmpInv = new THREE.Matrix4();

/**
 * Keeps objects on character bones. Objects stay where they are in the scene graph (world
 * props under the dynamic-object group, actors under the scene); each `update()` writes their
 * matrix from the bone's world matrix. Call it after the carriers were animated this frame.
 */
export class HardpointAttacher {
  private readonly list = new Map<THREE.Object3D, Attachment>();

  constructor(private readonly pkgs: PackageSet) {}

  /**
   * Attach `obj` to hardpoint `hp` of `carrier` (a channel index as STOMP uses it, or
   * `{ bone }` for a bone index as the weapon templates use). Replaces whatever the
   * object was attached to. Returns false when the hardpoint does not exist.
   * `keep`: the attachment survives its carrier leaving the scene graph for a while (the player's
   * body while the creature form is shown); without it update() releases it then.
   */
  attach(obj: THREE.Object3D, carrier: Character, hp: number | { bone: number }, local?: THREE.Matrix4, opts?: { keep?: boolean }): boolean {
    const bone = hardpointBone(this.pkgs, carrier, hp);
    if (!bone) return false;
    this.detach(obj);
    obj.updateMatrix();
    const scale = new THREE.Vector3();
    obj.matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    this.list.set(obj, { obj, bone, carrier, scale, local: local?.clone() ?? new THREE.Matrix4(), savedAuto: obj.matrixAutoUpdate, keep: !!opts?.keep });
    obj.matrixAutoUpdate = false;
    this.place(this.list.get(obj)!);
    return true;
  }

  /** Release an object (it stays at its last pose). */
  detach(obj: THREE.Object3D) {
    const a = this.list.get(obj);
    if (!a) return;
    this.list.delete(obj);
    if (a.savedAuto) {
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
      obj.matrixAutoUpdate = true;
    }
  }

  /** Release everything attached to a bone of `carrier` (a hardpoint, or all when omitted). */
  clear(carrier: Character, hp?: number | { bone: number }) {
    const bone = hp === undefined ? undefined : hardpointBone(this.pkgs, carrier, hp);
    for (const a of [...this.list.values()]) if (a.carrier === carrier && (!bone || a.bone === bone)) this.detach(a.obj);
  }

  isAttached(obj: THREE.Object3D) {
    return this.list.has(obj);
  }

  /** Bone an object rides, if attached. */
  boneOf(obj: THREE.Object3D): THREE.Bone | undefined {
    return this.list.get(obj)?.bone;
  }

  /** Attached objects of a carrier. */
  attachedTo(carrier: Character): THREE.Object3D[] {
    return [...this.list.values()].filter((a) => a.carrier === carrier).map((a) => a.obj);
  }

  private place(a: Attachment) {
    a.bone.updateWorldMatrix(true, false);
    tmpM.copy(a.bone.matrixWorld).multiply(a.local).multiply(tmpS.makeScale(a.scale.x, a.scale.y, a.scale.z));
    const parent = a.obj.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      tmpM.premultiply(tmpInv.copy(parent.matrixWorld).invert());
    }
    a.obj.matrix.copy(tmpM);
    a.obj.matrixWorldNeedsUpdate = true;
  }

  update() {
    for (const a of this.list.values()) {
      if (!a.carrier.root.parent) {
        if (!a.keep) this.detach(a.obj);
        continue;
      }
      this.place(a);
    }
  }

  /**
   * Place only what `carriers` hold, from their bones as posed now. The player's body and arms
   * are posed in the player's update, before the frame is drawn, while update() runs with the
   * game systems after the draw: the weapons system calls this right before the draw
   * (LevelRenderer.onBeforeDraw), so a gun in the player's hand is not drawn at the previous
   * frame's hand pose (docs/game-logic.md §4.5 "Held weapon placement").
   */
  updateCarriers(...carriers: (Character | null | undefined)[]) {
    for (const a of this.list.values()) if (carriers.includes(a.carrier) && a.carrier.root.parent) this.place(a);
  }

  dispose() {
    for (const a of [...this.list.values()]) this.detach(a.obj);
  }
}
