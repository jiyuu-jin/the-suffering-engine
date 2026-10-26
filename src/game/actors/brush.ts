// An Animating Static plays one of its p37 clips when the player brushes against it (docs/game-logic.md
// §14.5 "Brushing an Animating Static"). Decoded from Suffering.rfl [verified unless marked]:
//
// - Touch handler (Animating Static vt +0x24, 0x10093d10): with p37 empty nothing happens. The
//   contact must come from a Collider (class 0xfa5951fc) owned by the Player (0xc8bc44e1): the
//   player's movement proxy (Player p91, 2:44: spheres r 0.6 at 0 (the foot, the origin), 0.9,
//   1.306 and 1.639 m up), whose per-frame query collides with the Animating Static class
//   (docs/game-logic.md §14.2 "Who touches it"). An NPC, a thrown object or the player's own body
//   does not count.
// - Every touch stores the game time (+0x66); a clip plays only when the touch before was 0.2 s
//   ago or longer, so it plays as the player walks into the object, not again while he stays in
//   contact. The clip is a random entry of p37 (0x1002d380), played on channel 0 with the same
//   request as p40 (flags 4, 0x100935b0).
// - When channel 0's clip has finished the think (vt +0x18, 0x10093e70 -> 0x100938f0) picks the
//   next idle clip (p23, or p24 with p25 set; p26 random / shuffled / in order), so the object
//   goes back to its idle.
// - The contact [verified code path, §14.2]: leaf spheres of the two sphere trees (the proxy's
//   chain, the Animating Static's skeleton tree posed by its bones), sphere against sphere, no
//   allowance.
//
// Retail: 1 251 Animating Statics carry p37, the shrubs, ferns and trees of the outdoor levels
// (23:94 / 23:98 / 23:99 ...), the plants of 1b / 2 / 3b / 5b (7:1950 / 7:1953) and four in 1a
// (23:157) [data]. Port: the touches are tested here each frame from the player's feet (the
// proxy's origin) [port: the engine's contacts come from the mover's sweep, the port tests the
// spheres where the frame leaves them].

import type { PropValue } from '../../formats/entities';
import { classByHash, decodeTemplateProps, readObjectTemplate } from '../../formats/entities';
import type { PackageSet, ResRef } from '../../formats/model';
import { readModelSphereNodes } from '../../formats/model-spheres';
import type { SkeletonSphere } from '../../formats/skeleton';
import type { HitSphere } from '../fx/gas';
import { modelHitSpheres, posedSpheres } from '../fx/gas-system';
import { colliderSpheres } from './mover';
import type { Actor } from './actor';

/** Seconds a touch must follow the previous one by for the clip to play (0x10150dd0). */
export const BRUSH_GAP = 0.2;

/** The touch stamp rule: plays when the previous touch is BRUSH_GAP or more ago; the stamp moves on. */
export function brushTouch(last: number, now: number): { play: boolean; last: number } {
  return { play: !(now - last < BRUSH_GAP), last: now };
}

/** Does any sphere of `a` overlap any of `b` (sphere / sphere, 0x4d2a00: no allowance)? */
export function spheresTouch(a: readonly HitSphere[], b: readonly HitSphere[]): boolean {
  for (const s of a)
    for (const t of b) {
      const dx = s.c[0] - t.c[0], dy = s.c[1] - t.c[1], dz = s.c[2] - t.c[2], r = s.r + t.r;
      if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
  return false;
}

/** The leaf spheres of the player's movement proxy (Player p91 Collider): offset up from the origin, radius. */
export function playerProxySpheres(pkgs: PackageSet, values: readonly PropValue[] | undefined): { y: number; r: number }[] {
  const ref = values?.[91];
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !('pkg' in ref)) return [];
  const t = readObjectTemplate(pkgs as never, ref as ResRef);
  if (!t || classByHash(t.classHash)?.name !== 'Collider' || !t.modelRef) return [];
  const mdu = pkgs.get(t.modelRef.pkg)?.mdu;
  const nodes = mdu ? readModelSphereNodes(mdu, t.modelRef.id) : [];
  const foot = decodeTemplateProps(classByHash(t.classHash), t)[0];
  const spheres = colliderSpheres(nodes);
  // The foot sphere's centre is the origin (docs/game-logic.md §14.9).
  const f = spheres.find((s) => s.node === (typeof foot === 'number' ? foot : 1)) ?? spheres[0];
  return spheres.map((s) => ({ y: s.y - (f?.y ?? 0), r: s.r }));
}

interface Brushable {
  a: Actor;
  clips: number[];
  leaves: SkeletonSphere[];
  /** Touch stamp (+0x66). */
  last: number;
  /** A brush clip is on channel 0 (back to the idle when it is done). */
  playing: boolean;
  /** Reach of its spheres from its origin (coarse test). */
  reach: number;
}

export class BrushAnimations {
  private items: Brushable[] = [];
  private readonly trees = new Map<string, SkeletonSphere[]>();
  readonly log: { t: number; uid: number; clip: number }[] = [];

  constructor(
    private readonly pkgs: PackageSet,
    private readonly proxy: readonly { y: number; r: number }[],
    clipIndex: (a: Actor, ref: ResRef) => number,
    actors: readonly Actor[],
  ) {
    for (const a of actors) {
      if (!a.kind.decor || a.template || !a.entity) continue;
      const v = a.entity.values[37];
      const refs = (Array.isArray(v) ? v : v ? [v] : []).filter((r): r is ResRef => !!r && typeof r === 'object' && 'pkg' in (r as object));
      if (!refs.length) continue;
      const clips = refs.map((r) => clipIndex(a, r)).filter((i) => i >= 0);
      const leaves = modelHitSpheres(this.pkgs, a.kind.skinned.ref, this.trees);
      if (!clips.length || !leaves.length) continue;
      let reach = 0;
      for (const s of leaves) reach = Math.max(reach, Math.hypot(s.center[0], s.center[1], s.center[2]) + s.radius);
      this.items.push({ a, clips, leaves, last: 0, playing: false, reach: reach * Math.max(1, a.scale) });
    }
  }

  get size() {
    return this.items.length;
  }

  /** One frame: `feet` the player's origin (undefined: no player in the world), `now` the game clock. */
  update(now: number, feet: { x: number; y: number; z: number } | undefined) {
    let proxy: HitSphere[] | undefined;
    let top = 0;
    for (const s of this.proxy) top = Math.max(top, s.y + s.r);
    for (const it of this.items) {
      const a = it.a;
      if (it.playing && a.clipDone) {
        it.playing = false;
        if (a.kind.idle >= 0) a.playClip(a.kind.idle, true);
      }
      if (!feet || a.hidden || !a.alive) continue;
      const p = a.position;
      const dx = p.x - feet.x, dz = p.z - feet.z;
      const lim = it.reach + 0.6 + 0.1;
      if (dx * dx + dz * dz > lim * lim || p.y - feet.y > top + it.reach || feet.y - p.y > it.reach + 1) continue;
      proxy ??= this.proxy.map((s) => ({ c: [feet.x, feet.y + s.y, feet.z] as [number, number, number], r: s.r }));
      if (!spheresTouch(proxy, posedSpheres(a.ch, it.leaves))) continue;
      const r = brushTouch(it.last, now);
      it.last = r.last;
      if (!r.play) continue;
      const clip = it.clips[Math.floor(Math.random() * it.clips.length)];
      a.playClip(clip, false);
      it.playing = true;
      this.log.push({ t: +now.toFixed(2), uid: a.entity?.uid ?? 0, clip });
      if (this.log.length > 50) this.log.shift();
    }
  }
}
