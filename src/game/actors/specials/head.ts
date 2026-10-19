// Breakable heads of the CartWheeler ("Slayer") creatures (docs §15.7.9). Decoded from
// Suffering.rfl: body-part manager 0x10095d10 / 0x10096400 (Character p54 / p55, spawned when
// p56 is set), TargetableBreakable 0x1001d190 (= Breakable: damage 0x1009b490 / 0x100a31b0,
// resistance lookup 0x100a2dc0, break 0x1009ba20), CartWheeler update 0x10072a80 ("head gone"
// 0x100721c0, decapitation 0x10072960, final-death test 0x10072210).
//
//   * The head is its own object on bone p187 (18) with its own health (p0: 3). A blow that
//     lands on it damages only the head; body hits never reach it, and it never passes damage
//     on to the body.
//   * Damage on it = amount x its Damage Resistance entry for the blow's type (p7: bullets 1,
//     shotgun 13, shiv 10, Black One claws 11, 12, fire 5 at x1); types it does not list do
//     nothing because p5 is set (explosions, blades) [verified 0x100a2df9].
//   * At 0 it breaks: the p18 generator (gibs + particles) spawns and the head goes away.
//   * The living Slayer is not killed by it: it staggers once (p186 HitReact, clip 10:51), drops
//     the attack it was in, keeps its health and can never revive; its next death is final.
// Port: the head volume is a sphere around bone p187 (hits with a known point inside it go to
// the head); the creature's hit capsule is raised to cover the head; the worn head model
// (weapons/npc.ts) is hidden through the actor's `brokenParts` bones.

import * as THREE from 'three/webgpu';
import type { Actor, ActorEnv } from '../actor';
import { npcBodyPartSlots } from '../../weapons/npc';
import type { ClipRef } from '../clipmap';
import { num, readTemplate, ref, refs, type SpecialRuntime } from './runtime';

/** Global Damage Resistance fallback (Level Properties 2:9 p46: types 14 and 6 at x0) [data]. */
const GLOBAL_ZERO = new Set([14, 6]);

export interface HeadState {
  update(dt: number, env: ActorEnv): void;
  info(): Record<string, unknown>;
  dispose(): void;
}

/** Head parameters of a TargetableBreakable template. */
export interface HeadParams {
  bone: number;
  health: number;
  /** p5: immune to every type its p7 does not list. */
  strict: boolean;
  /** p7: damage type -> multiplier (Damage Resistance p0 / p1). */
  resist: Map<number, number>;
  /** p18 break generator. */
  gibs?: { pkg: number; id: number };
}

export function headParams(rt: Pick<SpecialRuntime, 'pkgs'>, part: { pkg: number; id: number }, bone: number): HeadParams | undefined {
  const t = readTemplate(rt.pkgs, part);
  if (t?.cls !== 'TargetableBreakable') return undefined;
  const resist = new Map<number, number>();
  for (const r of refs(t.v[7])) {
    const d = readTemplate(rt.pkgs, r);
    if (d?.cls === 'Damage Resistance') resist.set(num(d.v[0], -1), num(d.v[1], 1));
  }
  return { bone, health: num(t.v[0], 3), strict: num(t.v[5], 0) !== 0, resist, gibs: ref(t.v[18]) };
}

/** Damage a head takes from a blow of `type` (resistance lookup 0x100a2dc0). */
export function headDamage(h: HeadParams, amount: number, type: number | undefined): number {
  const ty = type ?? 0;
  const m = h.resist.get(ty) ?? (GLOBAL_ZERO.has(ty) ? 0 : h.strict ? 0 : 1);
  return amount * m;
}

const raised = new WeakSet<object>();

export function installHead(a: Actor, rt: SpecialRuntime): HeadState | undefined {
  const pk = rt.ctx.loaded.packages;
  if (!pk) return undefined;
  const v = a.entity?.values ?? rt.template(a.kind.template)?.v ?? [];
  const headBone = num(v[187], -1);
  const slot = npcBodyPartSlots(pk, a).find((s) => s.bone === headBone);
  const p = slot ? headParams(rt, slot.part, slot.bone) : undefined;
  if (!p || !a.ch.skeleton.bones[p.bone]) return undefined;
  const stagger: ClipRef | undefined = refs(readTemplate(rt.pkgs, refs(v[186])[0])?.v[7])[0];
  let hp = p.health;
  let gone = false;
  let hits = 0;
  const parts = a as Actor & { brokenParts?: Set<number> };
  const center = () => {
    const b = a.ch.skeleton.bones[p.bone];
    b.updateWorldMatrix(true, false);
    return b.getWorldPosition(new THREE.Vector3());
  };
  const radius = 0.32 * a.scale;

  a.damageFilter = (amount, hit) => {
    if (gone || !hit?.point) return amount;
    const c = center();
    if (c.distanceTo(hit.point as THREE.Vector3) > radius + 0.12) return amount;
    // A head shot: the head alone takes it.
    const dmg = headDamage(p, amount, hit.type);
    hits++;
    if (dmg <= 0) return 0;
    hp -= dmg;
    rt.log(a, `head hit ${dmg} (type ${hit.type ?? 0}) -> ${Math.max(0, hp)}`);
    if (hp <= 0) breakHead(c);
    return 0;
  };

  const breakHead = (at: THREE.Vector3) => {
    gone = true;
    (parts.brokenParts ??= new Set()).add(p.bone);
    rt.effect(p.gibs, at);
    rt.log(a, a.alive ? 'head shot off: staggers' : 'head shot off');
    if (!a.alive) return;
    // Decapitation (0x10072960): one stagger, the running attack is dropped, health unchanged.
    const env = rt.manager.env;
    const i = env && stagger ? env.clip(a, stagger) : -1;
    if (i >= 0) a.playClip(i, false);
    a.state = 'hurt';
  };

  // The worn head sits above the body's mesh bounds: raise the hit capsule over it.
  if (!raised.has(a.kind)) {
    raised.add(a.kind);
    a.ch.update(0);
    const top = (center().y - a.bottom) / Math.max(0.01, a.scale) + 0.3;
    if (top > a.kind.height && top < a.kind.height + 1.2) a.kind.height = top;
  }

  return {
    update() {},
    info: () => ({ head: gone ? 'off' : `${hp}/${p.health}`, headHits: hits }),
    dispose() {},
  };
}
