// Corpse blows: what an explosion or a Gonzo / creature-claw blow does to a dead Character
// (docs/game-logic.md §15.16, "Gibs"). Decoded from Suffering.rfl [verified unless marked]:
//
//   The attack stimulus (0x2001, sent by the Character damage 0x100e7390 after the health change,
//   before the Part Cap test) reaches the hit reaction vt 72 (0x100e6480). For a dead character
//   (0x100a1ad0: health <= 0, so the killing blow as well as any blow on a corpse) with damage
//   type 8 (Gonzogun, the creature's claws) or 3 (explosions) and p117 set it calls the death
//   reaction vt +0x128 (0x100e5d00) and plays nothing else:
//     - type 3 with p112 set (and the attacker known): the body is thrown. p112 is a
//       BouncingObject of the body's own model (guards 10:487, CartWheelers 10:99), created at
//       the body with its -Z along the throw direction: from the attacker to the body, raised to
//       p114 degrees above the horizontal when it was lower (0x100e5e24..0x100e5e9b). The new
//       object takes the body's cuts (every p16 cap whose channel is cut: request 0x100010 on
//       it, 0x100e5f76..0x100e6040) and plays clip p113 (0x100e6081). It flies at its p1 / 2048
//       m/s, lives p12 s and then bursts into its p34 generators at its bone p35 (the guards'
//       3:2834 at the chest bone 6) [inferred: the throwables' fuse / detonation fields];
//     - otherwise (types 7 / 8, or 3 without p112): the gib (0x100e30d0 -> 0x100e2f70): p117 is
//       spawned at bone p116's matrix (the object's own matrix without one).
//   Either way the death outputs fire if they have not (p28 as an output, p29 as a message to
//   the links: flags +0x70 0x800 / 0x1000), then output p30, and the body is removed (engine
//   object vt +0x128(0), vt +0x30). Retail: 41 Characters set p117 (guards 3:2834 / prisoners
//   3:2859 / 3:2845, CartWheelers 3:2966 / 3:2998, Mainliner, Nooseman, Burrower, Rat, Inferna,
//   Fester and the Player's own CartWheeler / Fester copies).
//
// Port: the thrown body is the actor itself (its motor launched, the clip p113 played, the cuts
// kept); type 7 (no hit reaction found) is left out [not traced: its users].

import * as THREE from 'three/webgpu';
import { classByHash, decodeTemplateProps, readObjectTemplate, type EntityPackageSet, type PropValue } from '../../formats/entities';
import type { ResRef } from '../../formats/model';

const num = (v: PropValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: PropValue | undefined): ResRef | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const refs = (v: PropValue | undefined): ResRef[] => (Array.isArray(v) ? v : [v]).filter((x): x is ResRef => !!x && typeof x === 'object');

/** Damage types the dead hit reaction handles (0x100e64fe..0x100e6509). */
export const GIB_TYPES: ReadonlySet<number> = new Set([3, 8]);
export const EXPLOSION_TYPE = 3;

/** Character p112..p117. */
export interface GibRule {
  /** p112: BouncingObject of the body thrown by an explosion. */
  body?: ResRef;
  /** p113: its clip. */
  bodyClip?: ResRef;
  /** p114: least elevation of the throw (degrees). */
  elevation: number;
  /** p116: bone the gibs start at (-1: the object). */
  bone: number;
  /** p117: the gib template (an Object Generator). */
  gib: ResRef;
}

/** Character values -> the gib rule; undefined without p117 (blows on the corpse do nothing). */
export function readGibRule(v: readonly PropValue[]): GibRule | undefined {
  const gib = ref(v[117]);
  if (!gib) return undefined;
  return { body: ref(v[112]), bodyClip: ref(v[113]), elevation: num(v[114], 30), bone: num(v[116], -1), gib };
}

/** What a blow of `type` does to a dead body with this rule (0x100e6480 -> 0x100e5d00). */
export function corpseBlowKind(r: GibRule | undefined, type: number | undefined, attackerKnown: boolean): 'throw' | 'gib' | undefined {
  if (!r || type === undefined || !GIB_TYPES.has(type)) return undefined;
  if (type === EXPLOSION_TYPE && r.body) return attackerKnown ? 'throw' : undefined;
  return 'gib';
}

/**
 * Throw direction (0x100e5df2..0x100e5e9b): attacker -> body, normalised; below `elevationDeg`
 * above the horizontal it is laid flat and raised to exactly that angle.
 */
export function throwDirection(body: THREE.Vector3Like, attacker: THREE.Vector3Like, elevationDeg: number): THREE.Vector3 {
  const d = new THREE.Vector3(body.x - attacker.x, body.y - attacker.y, body.z - attacker.z);
  if (d.lengthSq() < 1e-8) d.set(0, 0, 1);
  d.normalize();
  const a = THREE.MathUtils.degToRad(elevationDeg);
  if (d.y < Math.sin(a)) {
    d.y = 0;
    if (d.lengthSq() < 1e-8) d.set(0, 0, 1);
    d.normalize();
    d.multiplyScalar(Math.cos(a));
    d.y = Math.sin(a);
  }
  return d;
}

/** The thrown body's BouncingObject: launch speed, life, the generators it bursts into and where. */
export interface ThrownBody {
  /** p1 (engine units / s) / 2048: m/s. */
  speed: number;
  /** p12 (s). */
  life: number;
  /** p46: % of the world gravity. */
  gravity: number;
  /** p34 generators, at bone p35. */
  burst: ResRef[];
  bone: number;
}

export function readThrownBody(pkgs: EntityPackageSet, r: ResRef | undefined): ThrownBody | undefined {
  const t = r && readObjectTemplate(pkgs, r);
  const c = t && classByHash(t.classHash);
  if (!t || c?.name !== 'BouncingObject') return undefined;
  const v = decodeTemplateProps(c, t);
  return { speed: num(v[1]) / 2048, life: num(v[12], 5), gravity: num(v[46], 100), burst: refs(v[34]), bone: num(v[35], -1) };
}
