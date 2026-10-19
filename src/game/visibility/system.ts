// Visibility game system: drives the renderer's portal culling (src/app/visibility.ts) from
// level logic.
//
//   * Portal objects open on their p5 message (default Enable) and close on p6 (Disable);
//     doors send Enable when they start opening and Disable once shut (docs §18).
//   * A portal whose linked door (p4) is open or moving counts as open whatever the
//     messages said, so a door opened by other means (save restore, STOMP) never hides
//     the room behind it.
//   * On its first update, the render pipelines of objects built since the load-time
//     precompile (src/app/main.ts; first-update objects, an in-place restart's new meshes) are
//     compiled ahead of time (LevelRenderer.precompile) so new zones / the flashlight never stall.
//   * Fog distance culling is turned off in levels with a Sky / Sun object: the sky is drawn
//     without fog, so fully fogged geometry still shows as a silhouette against it.

import type { GameContext, GameSystem } from '../runtime';
import type { WorldService } from '../world/world';

export function createVisibilitySystem(ctx: GameContext): GameSystem {
  const culler = ctx.view.culler;
  const vis = ctx.loaded.level.visibility;
  const world = ctx.services.world as WorldService | undefined;
  if (!culler || !world) return { name: 'visibility' };

  const portals = vis?.portals ?? [];
  // Message state per portal (1 = open), starting from p0.
  const byMessage = Uint8Array.from(portals, (p) => (p.startsClosed ? 0 : 1));
  const unsubscribe = portals.map((p, i) =>
    world.subscribe(p.uid, (msg) => {
      if (msg === p.openMessage) byMessage[i] = 1;
      else if (msg === p.closeMessage) byMessage[i] = 0;
    }),
  );
  // Levels with a sky dome keep everything (the dome is drawn without fog).
  culler.fogCull = world.world.of('Sky / Sun').length === 0;

  let precompiled = false;

  return {
    name: 'visibility',
    update() {
      // Once every system has built its objects: compile what the load-time pass has not.
      if (!precompiled) {
        precompiled = true;
        ctx.view.precompile().catch((err) => console.warn('[visibility] precompile failed:', err));
      }
      for (let i = 0; i < portals.length; i++) {
        let open = byMessage[i] === 1;
        if (!open && portals[i].link) {
          const d = world.door(portals[i].link);
          open = !!d && (d.open || d.moving);
        }
        culler.setPortalOpen(i, open);
      }
    },
    dispose() {
      for (const u of unsubscribe) u();
    },
  };
}
