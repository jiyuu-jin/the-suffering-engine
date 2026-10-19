// Small level-logic classes that only appear outside chapter 1 (world.handlers + per-frame).
//
// Health Threshold Trigger (0x96144939; 4 in 0 Prelude Docks) [verified, Suffering.rfl
//   vtable 0x1014c620, event handler 0x10015019]: watches the health of the object it is linked
//   to (the Prelude's Player links to all four and they link back). On every health event it
//   compares the new health h and the previous one with the threshold p0: when they lie on
//   different sides it fires output p3 to its links if p1 = 0 and h < p0 (dropping below) or
//   p1 = 1 and h > p0 (rising above); p2 set = destroy itself after firing. The previous health
//   starts at 0, so a threshold above the starting health never fires (the Prelude's 170 / 120
//   only matter with the Easy health of 200). Port: polled each frame on the player's health
//   (services.combat), NPC targets through services.actors when they expose `health`.
//
// Inventory Add Remove (0x744df9ea; 3a x2, 6a, 9) [inferred from all 4 instances]: p1 input
//   (On) applies the change, p2 input Destroy; p0 = 1 removes the p4 item templates from the
//   inventory, 0 adds them [guess for 0: never used]; p3 unknown. Every instance hangs off an
//   "Urgent Note / Tickertape" pickup and removes the previous note (Map Item), so the newest
//   note replaces the last one.
//
// Attachment (0xbb1fc4a1; 0 Prelude Docks "Hat!!") : p2 On shows, p3 Off hides; the hat rides a
//   hardpoint through STOMP attach keys (sequence presenter). Port: visibility only.
//
// Teleport Pad (0xe66d645e; Prelude x4, 10 Docks x4): no properties; markers the Black One boss
//   teleports between (Black One links one pad each). Nothing to run here (docs/levels.md).
//
// Sky Properties (0x4f594492; one placed in 10 Docks): fog / sky settings read as a template by
//   Level Properties p10 (atmosphere.ts) and Fog / Sky Switchers (lights.ts); a placed one has
//   no inputs or outputs. Nothing to run.

import type { World, WorldEntity } from '../world/logic';
import type { InventoryService } from '../world/world';
import type { ResRef } from '../../formats/model';
import { templateClassName } from '../world/logic';
import type { EntityPackageSet } from '../../formats/entities';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const refs = (v: unknown): ResRef[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as ResRef[]) : []);

interface HealthSource {
  /** Health of a linked object (player or actor), undefined when unknown. */
  health(uid: number): number | undefined;
}

export class LevelLogic {
  private readonly thresholds: { w: WorldEntity; target: number; prev: number }[] = [];

  constructor(
    private readonly world: World,
    private readonly pkgs: EntityPackageSet,
    private readonly inventory: () => InventoryService | undefined,
    private readonly health: HealthSource,
  ) {
    for (const w of world.of('Health Threshold Trigger')) {
      // The watched object: the first link that is a character (the Player in the Prelude).
      const target = w.e.links.find((u) => world.get(u)?.e.family === 'Character') ?? w.e.links[0];
      if (target !== undefined) this.thresholds.push({ w, target, prev: 0 });
    }
    world.handlers.push((w, msg) => this.onMessage(w, msg));
  }

  private onMessage(w: WorldEntity, msg: number): boolean {
    const v = w.e.values;
    switch (w.cls) {
      case 'Inventory Add Remove': {
        if (num(v[2], 12) === msg) {
          this.world.destroy(w);
          return true;
        }
        if (num(v[1], 1) !== msg) return false;
        const inv = this.inventory();
        if (!inv) return true;
        // Items by template (world/inventory.ts); a bare "pkg:id" name gets the template's
        // display name from the inventory.
        for (const r of refs(v[4])) {
          if (num(v[0], 1) !== 0) inv.remove(r);
          else inv.add(`${r.pkg}:${r.id}`, 1, r, templateClassName(this.pkgs, r));
        }
        return true;
      }
      case 'Attachment': {
        const show = num(v[2], 1) === msg ? true : num(v[3], 2) === msg ? false : undefined;
        if (show === undefined) return false;
        this.world.setVisible(w.uid, show);
        return true;
      }
      case 'Health Threshold Trigger':
      case 'Teleport Pad':
      case 'Sky Properties':
        // Health events are polled (update); pads and sky settings are passive data.
        return false;
    }
    return false;
  }

  update() {
    for (const t of this.thresholds) {
      const { w } = t;
      if (w.destroyed) continue;
      const h = this.health.health(t.target);
      if (h === undefined || h === t.prev) continue;
      const v = w.e.values;
      const p0 = num(v[0]);
      const before = Math.sign(t.prev - p0), now = Math.sign(h - p0);
      if (before !== now) {
        const rising = num(v[1]) === 1;
        if ((!rising && h < p0) || (rising && h > p0)) {
          this.world.fire(w, 3);
          if (num(v[2]) !== 0) this.world.destroy(w);
        }
      }
      t.prev = h;
    }
  }
}
