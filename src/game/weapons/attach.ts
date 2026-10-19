// Attach service: objects on character hardpoints, for the sequence presenter (STOMP attach
// keys) and for weapons in hands. See hardpoints.ts for the format.
//
//   weapons.attach(objectOrModel, actorOrPuppet, hardpointIndex) -> boolean
//     objectOrModel  level-object uid (world prop, actor or placed effect emitter), a THREE.Object3D,
//                    or a model ResRef
//                    (a mesh is built and added to the carrier's scene)
//     actorOrPuppet  a Character (the STOMP player puppet, an actor's .ch) or an actor uid
//     hardpointIndex channel index of the carrier's model (STOMP), or { bone } for a bone index
//   weapons.detachHardpoint(actorOrPuppet, hardpointIndex?)   clears what hangs there
//   weapons.detach(objectOrUid)

import * as THREE from 'three/webgpu';
import type { Character } from '../../app/character';
import type { PackageSet, ResRef } from '../../formats/model';
import { HardpointAttacher } from './hardpoints';
import { buildStaticModel } from './models';

export type Carrier = Character | number;
export type Attachable = number | THREE.Object3D | ResRef;
export type HardpointRef = number | { bone: number };

interface ActorsLike {
  get(uid: number): { ch: Character } | undefined;
}

export class AttachService {
  readonly attacher: HardpointAttacher;
  private built = new Map<THREE.Object3D, THREE.Object3D>();
  /** Attached actors (skinned props such as the 1a door guard's newspaper): their own culling
   * tests the placement position, so the mesh is re-shown while it rides a hardpoint. */
  private actorRoots = new Map<THREE.Object3D, Character>();

  constructor(
    private readonly pkgs: PackageSet,
    private readonly scene: THREE.Scene,
    private readonly actors: () => ActorsLike | undefined,
    /**
     * Stand-in object of a placed effect (Particle Fountain / Object Generator) that has no
     * mesh: world fx `anchor(uid)` (world/fx.ts). STOMP attach keys hang those on bones too.
     */
    private readonly effectAnchor?: (uid: number) => THREE.Object3D | undefined,
  ) {
    this.attacher = new HardpointAttacher(pkgs);
  }

  carrier(c: Carrier): Character | undefined {
    return typeof c === 'number' ? this.actors()?.get(c)?.ch : c;
  }

  /** Scene object of a level-object uid: an actor's root, else the world's dynamic prop root. */
  objectOf(uid: number): THREE.Object3D | undefined {
    const a = this.actors()?.get(uid);
    if (a) return a.ch.root;
    const fx = this.effectAnchor?.(uid);
    if (fx) return fx;
    let found: THREE.Object3D | undefined;
    this.scene.traverse((o) => {
      if (!found && (o as THREE.Mesh).isMesh && o.userData.uid === uid) found = o;
    });
    // Dynamic props: mesh -> pivot -> root (the child of the 'world-dynamic' group).
    let r = found;
    while (r?.parent && r.parent.name !== 'world-dynamic' && r.parent.type !== 'Scene') r = r.parent;
    return r;
  }

  attach(obj: Attachable, carrier: Carrier, hp: HardpointRef): boolean {
    const ch = this.carrier(carrier);
    if (!ch) return false;
    let o: THREE.Object3D | undefined;
    if (typeof obj === 'number') {
      o = this.objectOf(obj);
      const actor = this.actors()?.get(obj);
      if (actor && o) this.actorRoots.set(o, actor.ch);
    }
    else if (obj instanceof THREE.Object3D) o = obj;
    else {
      const m = buildStaticModel(this.pkgs, obj);
      if (m) {
        this.scene.add(m);
        this.built.set(m, m);
        o = m;
      }
    }
    if (!o) return false;
    return this.attacher.attach(o, ch, hp);
  }

  detach(obj: number | THREE.Object3D) {
    const o = typeof obj === 'number' ? this.objectOf(obj) : obj;
    if (!o) return;
    this.attacher.detach(o);
    if (this.built.has(o)) {
      this.built.delete(o);
      o.removeFromParent();
    }
  }

  detachHardpoint(carrier: Carrier, hp?: HardpointRef) {
    const ch = this.carrier(carrier);
    if (!ch) return;
    const before = new Set(this.attacher.attachedTo(ch));
    this.attacher.clear(ch, hp);
    for (const o of before) if (!this.attacher.isAttached(o) && this.built.has(o)) this.detach(o);
  }

  update() {
    this.attacher.update();
    for (const [o, ch] of this.actorRoots) {
      if (!this.attacher.isAttached(o)) this.actorRoots.delete(o);
      else ch.mesh.visible = true;
    }
  }

  dispose() {
    this.attacher.dispose();
    for (const o of this.built.keys()) o.removeFromParent();
    this.built.clear();
  }
}
