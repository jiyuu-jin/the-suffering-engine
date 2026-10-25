// The selected throwable carried on the player's body (docs/game-logic.md §4.5 "Carried
// throwable"). Decoded from Suffering.rfl [verified unless marked]:
//
// - Taking a throwable out (0x10038ca0, a Missile Item): what sits on bone Player p119 (51, at the
//   right of the back, a child of spine bone 3) is put away (0x10038430), then the item's p55
//   thrown object (a BouncingObject whose template p0 is 1) is spawned and attached to that bone
//   with the plain bone attach `(bone, object, 0, 0)` (skinned-instance slot 6, identity matrix).
//   It is the same object the throw later launches: there is no separate holstered model.
//   Selecting a throwable (0x100395f0) and getting one while the bone is empty (0x10039b10)
//   both take it out; the HUD's throwable is the item of what is on that bone (0x10037ce0).
// - AttachThrownWeapon (clip message 231, 0x1002ae40, e.g. throw clip 2:534 at 0.184 s on bone
//   35): what the marker's bone holds (the gun) is detached and hidden; the object on the back
//   moves to the marker's bone; the item count drops by one; then another of the same item is
//   taken out onto the back, or, at 0, the carried Missile Item with the highest p45 (> -1)
//   (`throwableAfterEmpty`); none: the back stays empty. (Not while a Killjoy Rebirth effect
//   holds the player: it tops the grenades up itself.)
// - ThrowWeapon (230, 0x10029310) detaches the object from the marker's bone and launches it.
//   Leaving the throw state (0x1002ac50) launches one still in the hand and puts the hidden gun
//   back on its bone.
// - Creature form takes it off (morph 0x10044e70 -> 0x10038620, the item kept in +0x77c) and the
//   change back takes it out again (0x10033170 -> 0x100392d0). Nothing else removes it: not
//   death, grapples or weapon switches (0x10038620 has those two callers and the Rebirth effect).
// - First person keeps it: the model swap to 2:138 keeps the animator's attachments when the
//   bone count is unchanged (SUFFERING.EXE 0x46d3bd; 2:9 and 2:138 both have 62 bones), so the
//   object rides bone 51 of the arms model, as the gun rides its bone 35.
//
// Port: nothing here is saved. The pieces are rebuilt from the selected throwable (persist.
// throwable, already in the save) every frame by the weapons system.

import type * as THREE from 'three/webgpu';
import type { Character } from '../../app/character';
import type { ResRef } from '../../formats/model';
import type { HardpointAttacher } from './hardpoints';

/** Player p119: the bone the selected throwable rides (Player 2:5). */
export const THROWABLE_BONE = 51;

/**
 * The throwable taken out once the selected one runs out (0x1002b1a4..0x1002b24b): the owned
 * one with the highest Missile Item p45, a signed value that must beat -1 (the flare's p45 is
 * -1: never); a tie keeps the first. Retail p45: Shrapnel 5, Molotov 4, TNT 3, Flash/Bang 2.
 */
export function throwableAfterEmpty<T>(owned: readonly T[], priority: (d: T) => number): T | null {
  let best: T | null = null;
  let top = -1;
  for (const d of owned) {
    const p = priority(d) | 0;
    if (p > top) {
      top = p;
      best = d;
    }
  }
  return best;
}

/** The player's rig the pieces hang on: the body (third person) and the arms (first person). */
export interface CarryRig {
  body: Character;
  arms?: Character;
  /** Parent of the first-person copies (the arms' pivot in the viewmodel pass). */
  armsParent?: THREE.Object3D;
}

/** One carried object: a mesh on the body and one on the arms. */
interface Piece {
  key: string;
  rig: CarryRig;
  meshes: { obj: THREE.Object3D; carrier: Character }[];
}

/**
 * The throwable on the back and the one moved into the hand by AttachThrownWeapon. Meshes are
 * attached with the HardpointAttacher (bone index, identity matrix), the third-person copy under
 * the body's root and the first-person one under the arms' parent, like the held weapon.
 */
export class ThrowableCarry {
  private back: Piece | null = null;
  private hand: Piece | null = null;

  constructor(
    private readonly attacher: HardpointAttacher,
    private readonly build: (model: ResRef) => THREE.Object3D | undefined,
  ) {}

  /** Key of what is on the back (null: nothing). */
  get backKey(): string | null {
    return this.back?.key ?? null;
  }

  /** Key of what is in the throwing hand (null: nothing). */
  get handKey(): string | null {
    return this.hand?.key ?? null;
  }

  /** Meshes on the back (body copy first). */
  get backMeshes(): THREE.Object3D[] {
    return this.back?.meshes.map((m) => m.obj) ?? [];
  }

  /** Meshes in the hand (body copy first). */
  get handMeshes(): THREE.Object3D[] {
    return this.hand?.meshes.map((m) => m.obj) ?? [];
  }

  /**
   * Make the back hold `want` (a throwable key and its thrown object's model) on `bone`, or
   * nothing. Cheap when nothing changed; rebuilt when the rig changes (a new level's body).
   */
  syncBack(rig: CarryRig | null, want: { key: string; model: ResRef } | null, bone = THROWABLE_BONE) {
    if (this.back && (!rig || !want || this.back.key !== want.key || this.back.rig.body !== rig.body || this.back.rig.arms !== rig.arms)) {
      this.drop(this.back);
      this.back = null;
    }
    if (this.back || !rig || !want) return;
    this.back = this.make(rig, want.key, want.model, bone);
  }

  /**
   * AttachThrownWeapon: the back's object moves to `bone` (the marker's bone, the throwing hand).
   * Returns false when the back was empty. The back is empty after this until syncBack.
   */
  toHand(bone: number): boolean {
    const p = this.back;
    if (!p) return false;
    this.releaseHand();
    this.back = null;
    const kept: Piece['meshes'] = [];
    for (const m of p.meshes) {
      if (this.attacher.attach(m.obj, m.carrier, { bone })) kept.push(m);
      else this.dispose1(m.obj);
    }
    this.hand = { key: p.key, rig: p.rig, meshes: kept };
    return kept.length > 0;
  }

  /** ThrowWeapon: the hand's object leaves (the launched one stands in for it). */
  releaseHand() {
    if (this.hand) this.drop(this.hand);
    this.hand = null;
  }

  dispose() {
    this.releaseHand();
    if (this.back) this.drop(this.back);
    this.back = null;
  }

  private make(rig: CarryRig, key: string, model: ResRef, bone: number): Piece | null {
    const meshes: Piece['meshes'] = [];
    const add = (carrier: Character | undefined, parent: THREE.Object3D | undefined) => {
      if (!carrier || !parent) return;
      const m = this.build(model);
      if (!m) return;
      m.name = `carried-throwable ${key}`;
      parent.add(m);
      if (this.attacher.attach(m, carrier, { bone })) meshes.push({ obj: m, carrier });
      else this.dispose1(m);
    };
    add(rig.body, rig.body.root);
    add(rig.arms, rig.armsParent);
    return meshes.length ? { key, rig, meshes } : null;
  }

  private drop(p: Piece) {
    for (const m of p.meshes) this.dispose1(m.obj);
    p.meshes.length = 0;
  }

  private dispose1(m: THREE.Object3D) {
    this.attacher.detach(m);
    m.removeFromParent();
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat?.dispose();
    });
  }
}
