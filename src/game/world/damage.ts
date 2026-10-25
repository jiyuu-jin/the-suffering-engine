// Damage routing for the world: `ctx.services.damage`.
//
// Interface (published by the world system; weapons, hazards and explosions call it):
//
//   services.damage.apply({ point, normal?, amount, kind?, source?, targetUid?, body?, radius?, innerRadius?,
//                           minAmount?, actor?, dir? })
//       -> { hits: { uid, kind: 'prop' | 'actor', damage, killed }[] }
//
//   point      world-space hit point (LevelData units, output space)
//   normal     surface normal at the hit (optional; used to orient debris)
//   amount     damage before resistances (props: health is the GameObject p0, e.g. 10 for a bottle)
//   kind       'bullet' | 'melee' | 'explosion' | 'fire' | 'generic' or an engine damage-type number
//   source     'player', an actor/entity uid, or anything identifying the attacker
//   targetUid  level-object uid when the caller already knows what it hit (wins over the point)
//   body       CollisionWorld dynamic body id from a RayHit (`hit.dynamic`): resolved to its prop
//   radius     splash radius (m): every prop and actor within it takes amount * (1 - d / radius)
//   innerRadius / minAmount   Radius Damage falloff instead (weapons): `amount` up to innerRadius,
//              then linear down to `minAmount` at `radius`, nothing beyond
//   actor      the actor object itself (an entry of services.actors.list()) for hits on actors
//              without a level uid (spawned creatures); wins like targetUid
//   dir        attack direction (unit), used for debris when no attacker position is known
//   bone       the struck hit sphere's bone (damage record +0x20), when the blow knows it (a
//              blade swept against the target's leaf spheres): Part Caps cut by it
//              (actors/dismember.ts); without it the leaf nearest the point stands in
//   force / minForce   impact force (damage record +0x1c: Missile p28..p31, Melee Weapon p69 x
//              Attack p7, Radius Damage p2 at the centre to p3 at the edge, falling off as the
//              amount does): what a character's hit reaction is picked by (actors/hit-react.ts);
//              absent: the reaction reads the damage
//
// Routing: props the world system owns (Breakable, Light Housing, Security Monitor, Phone, ...,
// see props.ts) take the damage themselves; character targets are forwarded to
// services.actors.damage(actor, amount, from, by), `by` from `source`: 'player' (also when
// the source is a position or missing), an actor's uid (the actor is the attacker), or any
// other uid (a hazard: the victim is provoked but credits nobody; actors/manager.ts events
// report it as the kill source). A point hit with no target resolves to the prop
// whose bounds contain the point (+ 15 cm). Radius damage hits both props and actors.
//
// Damage types: the engine identifies damage by an enum index (Damage Resistance p0). The
// string kinds map to those indices as decoded from the weapon templates (see DAMAGE_TYPE):
// bullet 1, explosion 3, fire 5, melee 10 (shiv), generic 0.

import type * as THREE from 'three/webgpu';

export type DamageKind = 'bullet' | 'melee' | 'explosion' | 'fire' | 'generic' | number;

export interface DamageEvent {
  point: { x: number; y: number; z: number };
  normal?: { x: number; y: number; z: number };
  amount: number;
  kind?: DamageKind;
  source?: unknown;
  targetUid?: number;
  body?: number;
  radius?: number;
  innerRadius?: number;
  minAmount?: number;
  actor?: unknown;
  dir?: { x: number; y: number; z: number };
  force?: number;
  minForce?: number;
  bone?: number;
}

/** Damage at distance `d` of a radius event: Radius Damage falloff (inner / min) or linear. */
export function splashAmount(e: DamageEvent, d: number): number {
  const r = e.radius ?? 0;
  if (r <= 0 || d >= r) return 0;
  if (e.innerRadius === undefined && e.minAmount === undefined) return e.amount * (1 - d / r);
  const inner = Math.min(r, Math.max(0, e.innerRadius ?? 0));
  if (d <= inner) return e.amount;
  const min = e.minAmount ?? 0;
  return e.amount - ((d - inner) / Math.max(1e-6, r - inner)) * (e.amount - min);
}

/** Impact force at distance `d` of a radius event: p2 at the centre to p3 at the edge, as the amount. */
export function splashForce(e: DamageEvent, d: number): number | undefined {
  if (e.force === undefined) return undefined;
  return splashAmount({ ...e, amount: e.force, minAmount: e.minForce ?? e.force }, d);
}

export interface DamageHit {
  uid: number;
  kind: 'prop' | 'actor';
  damage: number;
  killed: boolean;
}

export interface DamageResult {
  hits: DamageHit[];
}

export interface DamageService {
  apply(e: DamageEvent): DamageResult;
}

// Corrected from the weapon templates (src/game/weapons/data.ts): Missile p32 = 1 for revolver /
// tommy gun bullets, 13 shotgun pellets; Radius Damage p10 = 3 TNT / shrapnel, 5 Molotov (fire),
// 19 flash/bang; Melee Weapon p70 = 10 shiv, 2 fire axe. The weapons system passes these numbers
// directly; the string kinds below map to the same enum.
export const DAMAGE_TYPE: Record<string, number> = { generic: 0, bullet: 1, explosion: 3, fire: 5, melee: 10 };

export function damageTypeIndex(kind: DamageKind | undefined): number {
  if (typeof kind === 'number') return kind;
  return DAMAGE_TYPE[kind ?? 'generic'] ?? 0;
}

/** What the damage router needs from the prop runtime (props.ts). */
export interface DamageablePropSet {
  /** Prop uid for a dynamic collision body. */
  uidOfBody(body: number): number | undefined;
  /** Live prop containing the point (within margin), if any. */
  propAt(p: THREE.Vector3Like, margin: number): number | undefined;
  /** Live props within a radius: uid + distance from the centre of their bounds. */
  propsNear(p: THREE.Vector3Like, radius: number): { uid: number; distance: number }[];
  has(uid: number): boolean;
  /** Apply damage; returns the damage taken (after resistances) and whether it broke. */
  damage(uid: number, amount: number, type: number, e: DamageEvent): { damage: number; killed: boolean };
}

interface ActorLike {
  entity?: { uid: number };
  position: { x: number; y: number; z: number };
  dead?: boolean;
  alive?: boolean;
  /** A corpse an explosion still throws or gibs (Character p117: actors/gibs.ts). */
  corpseBlows?: boolean;
}
interface ActorsLike {
  list(): readonly ActorLike[];
  get(uid: number): ActorLike | undefined;
  damage(actor: ActorLike, amount: number, from?: { x: number; y: number; z: number }, by?: unknown, hit?: { point?: { x: number; y: number; z: number }; type?: number; force?: number; bone?: number }): boolean;
}

export function createDamageService(props: DamageablePropSet, actors: () => ActorsLike | undefined): DamageService {
  const fromOf = (e: DamageEvent) => {
    const s = e.source as { x?: number; y?: number; z?: number } | undefined;
    if (s && typeof s === 'object' && typeof s.x === 'number') return s as { x: number; y: number; z: number };
    if (e.dir) return { x: e.point.x - e.dir.x, y: e.point.y - e.dir.y, z: e.point.z - e.dir.z };
    return undefined;
  };
  return {
    apply(e) {
      const hits: DamageHit[] = [];
      const type = damageTypeIndex(e.kind);
      const hitProp = (uid: number, amount: number) => {
        const r = props.damage(uid, amount, type, e);
        hits.push({ uid, kind: 'prop', damage: r.damage, killed: r.killed });
      };
      const hitActor = (a: ActorLike, amount: number, force = e.force) => {
        const svc = actors();
        if (!svc) return;
        // Attacker: an actor by uid, a hazard uid, else the player.
        const by = typeof e.source === 'number' ? (svc.get(e.source) ?? e.source) : 'player';
        // The hit point and damage type let specials route blows (heads, weak spots: actors/specials).
        // A blast throws a corpse away from its centre (actors/gibs.ts).
        const from = e.radius && (a.dead || a.alive === false) ? e.point : (fromOf(e) ?? (by && typeof by === 'object' ? by.position : undefined));
        const killed = svc.damage(a, amount, from, by, { point: e.radius ? undefined : e.point, type, force, ...(e.bone !== undefined && !e.radius ? { bone: e.bone } : {}) });
        hits.push({ uid: a.entity?.uid ?? 0, kind: 'actor', damage: amount, killed });
      };

      if (e.radius && e.radius > 0) {
        for (const { uid, distance } of props.propsNear(e.point, e.radius)) {
          const amount = splashAmount(e, distance);
          if (amount > 0) hitProp(uid, amount);
        }
        for (const a of actors()?.list() ?? []) {
          // Corpses only when the blast still does something to them (thrown, gibbed).
          if ((a.dead || a.alive === false) && !a.corpseBlows) continue;
          const d = Math.hypot(a.position.x - e.point.x, a.position.y + 0.9 - e.point.y, a.position.z - e.point.z);
          const amount = splashAmount(e, d);
          // A blast of no damage at that distance still pushes (a hit reaction by its force).
          const force = splashForce(e, d);
          if (amount > 0 || (force !== undefined && force > 0 && d < (e.radius ?? 0))) hitActor(a, Math.max(0, amount), force);
        }
        return { hits };
      }

      if (e.actor && typeof e.actor === 'object') {
        hitActor(e.actor as ActorLike, e.amount);
        return { hits };
      }

      let uid = e.targetUid;
      if (uid === undefined && e.body !== undefined) uid = props.uidOfBody(e.body);
      if (uid !== undefined) {
        if (props.has(uid)) hitProp(uid, e.amount);
        else {
          const a = actors()?.get(uid);
          if (a) hitActor(a, e.amount);
        }
        return { hits };
      }
      const near = props.propAt(e.point, 0.15);
      if (near !== undefined) hitProp(near, e.amount);
      return { hits };
    },
  };
}
