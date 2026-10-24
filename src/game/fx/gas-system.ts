// Game system for the Particle Fountain damage volumes (fx/gas.ts): the gas chamber's gas hurts
// the player when his hit spheres reach into it and characters when their mover does, through
// their Damage Resistance.
//
// The player's hit spheres: the leaves of the skeleton sphere tree of the model he shows
// (formats/skeleton.ts trailer), each posed by its bone (bone world x inverse bind x centre,
// radius x the bone's scale): the Player template's model (2:9) in third person, its first-
// person model p227 (2:138) in first person; both are the same rig, so the body's posed skeleton
// places either tree. Characters touch with their mover (port: the capsule).
//
// Uses services.world (fountains, messages), services.actors (characters, damage, the player's
// body) and services.combat (the player). Debug: window.__gas.

import * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import type { PropValue } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import { readSkeletonTrailer, type SkeletonSphere } from '../../formats/skeleton';
import type { Character } from '../../app/character';
import type { WorldService } from '../world/world';
import { fountainStartsOn } from '../world/fx';
import { registerSave } from '../save/providers';
import type { ActorsService, CombatService } from '../actors/system';
import { FountainHazards, leafSpheres, type GasTarget, type HitSphere } from './gas';

/** The player's capsule: the coarse pass before the hit spheres (and their stand-in). */
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.35;

/** Leaf hit spheres of a skinned model's sphere tree (cached per model). */
export function modelHitSpheres(pkgs: PackageSet, ref: ResRef | undefined, cache: Map<string, SkeletonSphere[]>): SkeletonSphere[] {
  if (!ref) return [];
  const k = `${ref.pkg}:${ref.id}`;
  let s = cache.get(k);
  if (!s) {
    const mdu = pkgs.get(ref.pkg)?.mdu;
    const tr = mdu ? readSkeletonTrailer(mdu, ref.id) : undefined;
    // In node index order: the order the engine tests them in (a blade's first touched leaf is
    // the struck one, actors/npc-melee.ts sweepHit; 0x100c9680).
    cache.set(k, (s = tr ? leafSpheres(tr.spheres).sort((x, y) => tr.spheres.indexOf(x) - tr.spheres.indexOf(y)) : []));
  }
  return s;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
/** The spheres posed by a character's current skeleton (output space). */
export function posedSpheres(ch: Pick<Character, 'root' | 'skeleton'>, leaves: readonly SkeletonSphere[]): HitSphere[] {
  if (!leaves.length) return [];
  ch.root.updateWorldMatrix(true, true);
  const out: HitSphere[] = [];
  const { bones, boneInverses } = ch.skeleton;
  for (const n of leaves) {
    const bone = bones[n.bone];
    if (!bone) continue;
    _m.multiplyMatrices(bone.matrixWorld, boneInverses[n.bone]);
    _v.set(n.center[0], n.center[1], n.center[2]).applyMatrix4(_m);
    const e = _m.elements;
    const scale = Math.hypot(e[0], e[1], e[2]);
    out.push({ c: [_v.x, _v.y, _v.z], r: n.radius * scale, bone: n.bone });
  }
  return out;
}

const refOf = (v: unknown): ResRef | undefined => (v && typeof v === 'object' && 'pkg' in (v as object) ? (v as ResRef) : undefined);

export function createGasSystem(ctx: GameContext): GameSystem {
  const ws = ctx.services.world as WorldService | undefined;
  const pkgs = ctx.loaded.packages;
  if (!ws?.world || !pkgs) return { name: 'gas (no world)' };
  const world = ws.world;
  const hazards = new FountainHazards(pkgs);
  const initial: number[] = [];
  for (const w of world.of('Particle Fountain')) {
    const on = w.visible && fountainStartsOn(w.e.values);
    if (hazards.add(w.e, on) && on) initial.push(w.uid);
  }
  if (!hazards.size) return { name: 'gas (none)' };
  world.handlers.push((w, msg) => {
    if (w.cls === 'Particle Fountain') hazards.message(w.uid, w.e.values, msg);
    return false;
  });
  const offSave = registerSave(
    ctx.services,
    'gas',
    {
      save: () => ({ on: hazards.onList() }),
      load: (d: { on?: number[] }) => hazards.setOnList(d?.on ?? []),
      reset: () => hazards.setOnList(initial),
    },
    { scope: 'level', priority: 2 },
  );

  const view = ctx.view;
  const playerEnt = world.of('Player').find((w) => !(w.e.flags & 0x8)) ?? world.of('Player')[0];
  const playerValues: readonly PropValue[] = playerEnt?.e.values ?? [];
  const actors = () => ctx.services.actors as ActorsService | undefined;
  const combat = () => ctx.services.combat as CombatService | undefined;
  const targets: GasTarget[] = [];
  const trees = new Map<string, SkeletonSphere[]>();
  const modelPkgs = ctx.loaded.packages as unknown as PackageSet;
  // First-person model (Player p227, 2:138 in retail), shown while the view is first person.
  const fpModel = refOf(playerValues[227]);

  Object.assign(window, { __gas: hazards });
  return {
    name: 'gas',
    update(dt) {
      targets.length = 0;
      const c = combat();
      if (view.walking && c?.player.alive) {
        targets.push({
          key: 'player',
          feet: view.player.position,
          height: PLAYER_HEIGHT,
          radius: PLAYER_RADIUS,
          values: playerValues,
          spheres: () => {
            const body = actors()?.playerBody?.body;
            if (!body) return [];
            const fp = (view.player as { mode?: string }).mode === 'fp';
            return posedSpheres(body, modelHitSpheres(modelPkgs, fp && fpModel ? fpModel : body.skinned.ref, trees));
          },
          hit: (n, type, at) => c.damagePlayer(n, { kind: type, at }),
        });
      }
      const svc = actors();
      for (const a of svc?.list() ?? []) {
        // A switched-off character (DormantBehavior mode 2) is inert and touches nothing.
        if (!a.alive || a.template || a.dormantHidden || !a.entity) continue;
        const p = a.position;
        targets.push({
          key: a.id,
          feet: { x: p.x, y: a.bottom, z: p.z },
          height: a.height,
          radius: a.radius,
          values: a.entity.values,
          // The fountain is the source: a hazard, so the victim credits nobody (manager.ts).
          hit: (n, type, at, uid, frame) => svc!.damage(a, n, at, uid, { type, frameAmount: frame }),
        });
      }
      hazards.update(dt * ((view as { timeScale?: number }).timeScale ?? 1), targets);
    },
    dispose() {
      offSave();
      delete (window as unknown as { __gas?: unknown }).__gas;
    },
  };
}
