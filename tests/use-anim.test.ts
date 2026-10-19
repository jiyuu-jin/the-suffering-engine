// The player's use animations (src/game/world/use-anim.ts: the original's Interact state):
// where the player stands (Interaction Properties p15..p18), the clip events, and the timing of
// what a use does - 1a's Shiv spot keeps its 0.98 s BlowUp, the Shiv comes at EndInteract, the
// phone's receiver is taken at the pick-up's StartInteract. docs/game-logic.md §14.5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { parseEntities, type EntityPackageSet } from '../src/formats/entities';
import { readLevelHeader } from '../src/formats/level';
import { readSkinnedModel } from '../src/formats/skeleton';
import { loadPackages } from '../src/app/loader';
import { dirname } from '../src/app/gamefs';
import { buildAnimationClip } from '../src/app/character';
import { instanceMatrix } from '../src/game/world/dynamic';
import { World, type WorldHooks } from '../src/game/world/logic';
import { UseAnimator, approachOf, clipInteract, nearestInteraction, readInteractionProps, type InteractionProps, type UsePlayer } from '../src/game/world/use-anim';
import type { PackageSet, ResRef } from '../src/formats/model';
import { nodeFS, readSrsc, skip } from './helpers';

const LEVEL_1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';
const D = Math.PI / 180;

const ip = (o: Partial<InteractionProps>): InteractionProps => ({ ref: { pkg: 0, id: 0 }, cls: 'Interaction Properties', values: [], fromPlacement: true, faceSide: 1, offset: [0, 0, 0], yaw: 0, align: 0.2, ...o });

test('approach: p15..p17 in the object frame, facing the p11 side turned by p18', () => {
  // A phone 1 m in front (+z) and 1.09 m above the feet, turned to face it: the frame itself.
  const M = new THREE.Matrix4().makeRotationY(30 * D).setPosition(10, 2, 5);
  const a = approachOf(ip({ offset: [0, -1.09, 1], faceSide: 1, yaw: 180 }), M);
  const want = new THREE.Vector3(0, -1.09, 1).applyMatrix4(M);
  assert.ok(a.feet.distanceTo(want) < 1e-6);
  // The player's forward (-Z at yaw 0) is the object's -z: same yaw as the object.
  assert.ok(Math.abs(Math.sin(a.yaw - 30 * D)) < 1e-6 && Math.cos(a.yaw - 30 * D) > 0);
  // p18 turns counter-clockwise seen from above: +z turned by 90 is +x, so the yaw looks down +x.
  const b = approachOf(ip({ faceSide: 1, yaw: 90 }), new THREE.Matrix4());
  assert.ok(Math.abs(-Math.sin(b.yaw) - 1) < 1e-6 && Math.abs(-Math.cos(b.yaw)) < 1e-6);
  // p12 = 0: facing the object's origin.
  const c = approachOf(ip({ faceSide: null, offset: [2, 0, 0] }), new THREE.Matrix4());
  assert.ok(Math.abs(-Math.sin(c.yaw) + 1) < 1e-6);
  // p0 = 0: the current transform (a swung door), p0 = 1: the placement.
  const cur = new THREE.Matrix4().makeTranslation(0, 0, 3);
  assert.equal(approachOf(ip({ fromPlacement: false }), new THREE.Matrix4(), cur).feet.z, 3);
  assert.equal(approachOf(ip({ fromPlacement: true }), new THREE.Matrix4(), cur).feet.z, 0);
});

// ---------------------------------------------------------------------------------------------

let cached: { pkgs: EntityPackageSet; lvl: ReturnType<typeof readSrsc> } | undefined;
async function load1a() {
  if (cached) return cached;
  const lvl = readSrsc(LEVEL_1A);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const pkgs = (await loadPackages(nodeFS(), dirname(LEVEL_1A), readLevelHeader(lvl).dependencies, () => {})) as EntityPackageSet;
    return (cached = { pkgs, lvl });
  } finally {
    console.warn = warn;
  }
}

/** World matrix of a bone of Torque's rig (2:9) posed by `clip` at `t`, the feet at `feet`. */
function boneAt(pkgs: PackageSet, clip: ResRef, t: number, boneHash: number, feet: THREE.Vector3, yaw: number): THREE.Matrix4 {
  const sk = readSkinnedModel(pkgs, { pkg: 2, id: 9 })!.skeleton;
  const data = clipInteract(pkgs, clip)!.data;
  const c = buildAnimationClip(data, sk, { rootMotion: {} as never });
  const s = new Map<string, (t: number) => ArrayLike<number>>();
  for (const tr of c.tracks) {
    const i = (tr as unknown as { createInterpolant(): { evaluate(t: number): ArrayLike<number> } }).createInterpolant();
    s.set(tr.name, (x) => i.evaluate(x));
  }
  const chain: number[] = [];
  for (let b = sk.byHash.get(boneHash)!; b >= 0; b = sk.bones[b].parent) chain.unshift(b);
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(feet);
  const one = new THREE.Vector3(1, 1, 1), q = new THREE.Quaternion(), p = new THREE.Vector3(), mm = new THREE.Matrix4();
  for (const b of chain) {
    const bone = sk.bones[b];
    const qq = s.get(`${bone.name}.quaternion`)?.(t), pp = s.get(`${bone.name}.position`)?.(t);
    q.set(...((qq ? [qq[0], qq[1], qq[2], qq[3]] : bone.quaternion) as [number, number, number, number]));
    p.set(...((pp ? [pp[0], pp[1], pp[2]] : bone.position) as [number, number, number]));
    m.multiply(mm.compose(p, q, one));
  }
  return m;
}

test('1a phones: at the pick-up StartInteract the event bone holds the phone frame (the receiver leaves the cradle there)', { skip }, async () => {
  const { pkgs, lvl } = await load1a();
  let n = 0;
  for (const e of parseEntities(lvl, pkgs).filter((x) => x.className === 'Phone')) {
    const M = instanceMatrix(e.position, e.rotation);
    const list = (Array.isArray(e.values[31]) ? e.values[31] : [e.values[31]]) as ResRef[];
    const sel = nearestInteraction(pkgs, list, M, M, new THREE.Vector3().setFromMatrixPosition(M));
    assert.ok(sel, `phone ${e.uid.toString(16)} has Phone Interaction Properties`);
    const pick = sel.ip.values[22] as ResRef;
    const ev = clipInteract(pkgs as PackageSet, pick)!;
    assert.ok(ev.start, `pick-up clip ${pick.pkg}:${pick.id} has StartInteract`);
    const hand = boneAt(pkgs as PackageSet, pick, ev.start.time, ev.start.bone, sel.approach.feet, sel.approach.yaw);
    const d = new THREE.Vector3().setFromMatrixPosition(hand).distanceTo(new THREE.Vector3().setFromMatrixPosition(M));
    // The bone's axes are the phone's (within 16 degrees; the desk pick-up is tilted 15) and it is near its origin (within 20 cm: the desk pick-up 2:560 holds it 0.16 m above).
    const q1 = new THREE.Quaternion().setFromRotationMatrix(hand), q2 = new THREE.Quaternion().setFromRotationMatrix(M);
    assert.ok(d < 0.2, `phone ${e.uid.toString(16)}: bone ${d.toFixed(3)} m from the phone origin`);
    assert.ok(q1.angleTo(q2) < 16 * D, `phone ${e.uid.toString(16)}: bone turned ${(q1.angleTo(q2) / D).toFixed(1)} deg`);
    n++;
  }
  assert.ok(n >= 10);
});

test('1a Shiv spot: at StartInteract the hand reaches the Shiv grip in the inmate', { skip }, async () => {
  const { pkgs, lvl } = await load1a();
  const ents = parseEntities(lvl, pkgs);
  const spot = ents.find((e) => e.uid === 0x8368)!, shiv = ents.find((e) => e.uid === 0x5bfb)!;
  const M = instanceMatrix(spot.position, spot.rotation);
  const p = readInteractionProps(pkgs, (spot.values[31] as ResRef[])[0])!;
  assert.deepEqual(p.clip, { pkg: 2, id: 511 });
  const a = approachOf(p, M);
  const ev = clipInteract(pkgs as PackageSet, p.clip!)!;
  assert.ok(Math.abs(ev.start!.time - 0.79) < 0.01 && Math.abs(ev.end!.time - 0.79) < 0.01);
  const hand = new THREE.Vector3().setFromMatrixPosition(boneAt(pkgs as PackageSet, p.clip!, ev.start!.time, ev.start!.bone, a.feet, a.yaw));
  const grip = new THREE.Vector3(...shiv.position).divideScalar(2048);
  assert.ok(hand.distanceTo(grip) < 0.3, `hand ${hand.distanceTo(grip).toFixed(2)} m from the grip`);
});

// ---------------------------------------------------------------------------------------------

class FakePlayer implements UsePlayer {
  readonly position = new THREE.Vector3();
  mode: 'fp' | 'tp' = 'tp';
  yaw = 0;
  pitch = 0.3;
  bodyYaw = 0;
  bodyYawLock: number | null = null;
  eyeHeight = 1.6;
  readonly eyeOffset = new THREE.Vector3();
  motionOverride: UsePlayer['motionOverride'] = null;
  setFeet(x: number, y: number, z: number) {
    this.position.set(x, y, z);
  }
  /** PlayerController.update's override branch. */
  frame(dt: number) {
    if (!this.motionOverride) return;
    const keep = this.motionOverride(dt, { forward: 1, strafe: 0, jump: false, crouch: false });
    if (!keep) this.motionOverride = null;
    this.bodyYaw = this.bodyYawLock ?? this.yaw;
  }
}

async function world1a() {
  const { pkgs, lvl } = await load1a();
  const picked: number[] = [];
  const hooks: WorldHooks = {
    player: () => ({ feet: [0, -1000, 0], eye: [0, -998, 0], forward: [0, 0, 1] }),
    setVisible: () => {},
    setTransform: () => {},
    switchPose: () => {},
    playSound: () => undefined,
    toast: () => {},
    help: () => {},
    requestLevel: () => {},
    pickup: (w) => void picked.push(w.uid),
  };
  const world = new World(parseEntities(lvl, pkgs), pkgs, hooks, { levelPath: LEVEL_1A });
  world.start();
  world.update(0);
  world.send(0x7653, 1, 0); // "Goose": the corpse doubles and the Shiv appear
  world.update(0);
  return { world, picked, pkgs };
}

test('1a Shiv spot through the use animation: p27 at the use (BlowUp 0.98 s), the Shiv at EndInteract', { skip }, async () => {
  const { world, picked, pkgs } = await world1a();
  const spot = world.get(0x8368)!;
  const pl = new FakePlayer();
  pl.position.set(390.5, 97.7, 498.5);
  const anim = new UseAnimator(pkgs as PackageSet, pl, () => null);
  const p = readInteractionProps(pkgs, (spot.e.values[31] as ResRef[])[0])!;
  const approach = approachOf(p, instanceMatrix(spot.e.position, spot.e.rotation));
  let t = 0, blowUp = -1, granted = -1;
  world.subscribe(0x7652, (msg) => void (msg === 11 && blowUp < 0 && (blowUp = t)));
  assert.equal(world.beginSpot(spot), true);
  assert.deepEqual(picked, [], 'the Shiv is not in the hand yet');
  anim.start({ approach, align: p.align, first: { clip: p.clip, onEnd: () => ((granted = t), world.grantSpot(spot)) }, onDone: () => world.grantSpot(spot) });
  assert.equal(anim.active, true);
  assert.equal(pl.motionOverride !== null, true, 'movement is the use\'s');
  for (let i = 0; i < 6 * 60; i++) {
    t += 1 / 60;
    pl.frame(1 / 60);
    anim.update(1 / 60);
    world.update(1 / 60);
  }
  assert.ok(blowUp > 0.95 && blowUp < 1.05, `BlowUp at ${blowUp.toFixed(2)} s`);
  assert.ok(Math.abs(granted - (0.2 + 0.79)) < 0.05, `the Shiv at ${granted.toFixed(2)} s (0.2 s walk-up + EndInteract 0.79)`);
  assert.deepEqual(picked, [0x5bfb]);
  assert.equal(anim.active, false, 'the 4.2 s clip ended');
  assert.equal(pl.motionOverride, null);
  assert.ok(Math.hypot(pl.position.x - approach.feet.x, pl.position.z - approach.feet.z) < 1e-3, 'stands on the approach');
  assert.ok(Math.abs(Math.sin(pl.bodyYaw - approach.yaw)) < 1e-6 || pl.bodyYawLock === null);
});

test('use steps: chained clips, StartInteract / EndInteract times, cut() skips the rest of a clip', { skip }, async () => {
  const { pkgs } = await load1a();
  const pl = new FakePlayer();
  pl.mode = 'fp';
  const anim = new UseAnimator(pkgs as PackageSet, pl, () => null);
  const log: string[] = [];
  let t = 0, talking = true;
  const pick = { clip: { pkg: 2, id: 560 }, onStart: () => log.push(`start ${t.toFixed(2)}`) };
  const listen = { clip: { pkg: 2, id: 552 }, hold: () => talking };
  const hang = { clip: { pkg: 2, id: 551 }, onEnd: () => log.push(`end ${t.toFixed(2)}`) };
  anim.start({
    approach: { feet: new THREE.Vector3(1, 0, 0), yaw: 1 },
    align: 0.2,
    first: pick,
    next: (prev) => (prev === pick ? listen : prev === listen ? hang : null),
    onDone: () => log.push(`done ${t.toFixed(2)}`),
  });
  const run = (secs: number) => {
    for (let i = 0; i < secs * 60; i++) {
      t += 1 / 60;
      pl.frame(1 / 60);
      anim.update(1 / 60);
    }
  };
  run(0.1);
  assert.equal(pl.pitch, 0, 'first person: the view pitch is zeroed');
  assert.ok(pl.eyeOffset.length() === 0, 'no body: the eye stays');
  run(4);
  assert.ok(/^start 1\.4/.test(log[0]), `pick-up StartInteract at 0.2 + 1.20 s: ${log[0]}`);
  assert.equal(log.length, 1, 'listening while the line plays');
  assert.equal(pl.yaw, 1, 'first person: the view holds the approach yaw');
  talking = false;
  run(2);
  assert.ok(/^end /.test(log[1]) && /^done /.test(log[2]), log.join(', '));
  // cut(): straight on, the cut clip's events skipped.
  log.length = 0;
  const a = { clip: { pkg: 2, id: 560 }, onStart: () => log.push('a start') };
  const b = { clip: { pkg: 2, id: 551 }, onEnd: () => log.push('b end') };
  anim.start({ approach: null, align: 0, first: a, next: (p) => (p === a ? b : null) });
  run(0.5);
  anim.cut();
  run(2);
  assert.deepEqual(log, ['b end']);
});
