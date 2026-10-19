// Cinematic camera riding a carrier's hardpoint (STOMP attach keys on the Camera track).
//
// 0 Prelude Docks' intro ("Camera#1", 41.7 s) attaches the Camera track to hardpoints 12, 13 and
// 14 of the PoliceBoat (a skinned Breakable, model 55:1) for its three opening shots
// (0.03-10.02 s, 9.32-15.35 s, 14.72-19.10 s). While attached, the engine puts the camera in
// the hardpoint bone's frame with no offset (EXE 0x450c10, docs/game-logic.md §7.1); the
// Camera track's own transform keys only matter once it is detached again (19.10 s). The boat
// clips (55:2..55:5) animate those bones, so the camera follows the boat (or watches it pass).
//
// The sequence presenter (src/game/sequence/system.ts) poses the camera from the Camera
// track's keys; this runs after it in the same frame and replaces the pose while the track
// hangs on a carrier. Carrier = an actor's character or the presenter's skinned prop
// ("stomp-prop:<class>#<uid hex>" in the scene).

import * as THREE from 'three/webgpu';
import type { LevelRenderer } from '../../app/renderer';
import type { World } from '../world/logic';
import type { StompRun, StompTrack } from '../world/stomp';
import { hardpointTable } from '../weapons/hardpoints';
import type { PackageSet } from '../../formats/model';

interface ActorsLike {
  get(uid: number): { ch: { root: THREE.Object3D } } | undefined;
}

/** Hardpoint the child track hangs on (latest attach key of the carrier at run.t). */
export function attachedHardpoint(carrier: StompTrack, child: StompTrack, t: number): number | undefined {
  let hp: number | undefined;
  for (const k of carrier.attaches) {
    if (k.time > t) break;
    if (k.track === child.index) hp = k.hardpoint;
    else if (hp !== undefined && k.hardpoint === hp) hp = undefined; // cleared / replaced
  }
  return hp;
}

function skeletonOf(root: THREE.Object3D): THREE.Skeleton | undefined {
  let sk: THREE.Skeleton | undefined;
  root.traverse((o) => {
    if (!sk && (o as THREE.SkinnedMesh).isSkinnedMesh) sk = (o as THREE.SkinnedMesh).skeleton;
  });
  return sk;
}

export class CarrierCamera {
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  /** Camera model space -> bone frame (the engine applies none). */
  readonly fix = new THREE.Quaternion();
  active = false;

  constructor(
    private readonly world: World,
    private readonly packages: PackageSet,
    private readonly view: LevelRenderer,
    private readonly actors: () => ActorsLike | undefined,
  ) {}

  private carrierRoot(uid: number): THREE.Object3D | undefined {
    const a = this.actors()?.get(uid);
    if (a) return a.ch.root;
    const w = this.world.get(uid);
    return w ? this.view.scene.getObjectByName(`stomp-prop:${w.cls}#${uid.toString(16)}`) : undefined;
  }

  update() {
    this.active = false;
    for (const run of this.world.runningStomps()) {
      if (!run.cinematic) continue;
      if (this.apply(run)) return;
    }
  }

  private apply(run: StompRun): boolean {
    const cam = run.seq.tracks.find((t) => this.world.get(t.uid)?.cls === 'Camera' && t.transforms.length);
    if (!cam) return false;
    const carrier = run.carrierOf(cam);
    if (!carrier) return false;
    const hp = attachedHardpoint(carrier, cam, run.t);
    const w = this.world.get(carrier.uid);
    const root = this.carrierRoot(carrier.uid);
    if (hp === undefined || !w?.e.modelRef || !root) return false;
    const bone = skeletonOf(root)?.bones[hardpointTable(this.packages, w.e.modelRef)[hp] ?? -1];
    if (!bone) return false;
    root.updateMatrixWorld(true);
    this.m.copy(bone.matrixWorld);
    const cam3 = this.view.camera;
    this.m.decompose(cam3.position, cam3.quaternion, this.s);
    cam3.quaternion.multiply(this.fix);
    cam3.updateMatrixWorld(true);
    this.active = true;
    return true;
  }
}
