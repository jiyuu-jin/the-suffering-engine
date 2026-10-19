// Level Transition Msg Handler: a cross-level mailbox (Suffering.rfl, docs/campaign.md).
//
// The class has two properties, p0 and p1; key = p0 << 16 | p1. By convention p0 names the
// level the message is meant for (11 = 1a, 12 = 1b, 13 = 1c, 2 = Cellblocks, 31 = 3a,
// 10 = Docks) and p1 is a channel number, but the engine only compares keys:
//
//   * receive (vt[10], RFL 0x101369b0): any message delivered to a handler is stored in a
//     global list under the handler's key (replacing an entry with the same key). The list
//     lives in the game state (saved with the game, 0x10136940 / 0x10136cc0).
//   * deliver (RFL 0x10136af0, called by the transition code at 0x100c2df1 once the new
//     level is loaded): for every handler of the new level that has links, every stored
//     entry with its key is re-sent to the handler's links and removed from the list.
//
// So level A posts "message for level B" by sending anything to its handler (p0 = B), and
// level B's handler with the same key fires its links when the player next arrives in B
// through a Level Transition (not on New Game / Load: the list was restored with the save).

export interface MailboxEntry {
  key: number;
  message: number;
}

export interface MailboxHandler {
  uid: number;
  values: readonly unknown[];
  links: readonly number[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function handlerKey(values: readonly unknown[]): number {
  return ((num(values[0]) & 0xffff) << 16 | (num(values[1]) & 0xffff)) >>> 0;
}

/** "11:0" style label of a key (p0:p1). */
export function keyLabel(key: number): string {
  return `${key >>> 16}:${key & 0xffff}`;
}

export class TransitionMailbox {
  entries: MailboxEntry[] = [];

  /** A message reached a handler: keep it for the level the handler names. */
  store(h: Pick<MailboxHandler, 'values'>, message: number): void {
    if (!message) return;
    const key = handlerKey(h.values);
    this.entries = this.entries.filter((e) => e.key !== key);
    this.entries.push({ key, message });
  }

  /**
   * Arrival through a transition: re-send stored messages to the links of matching
   * handlers that have links; delivered entries are removed. Returns what was delivered.
   */
  deliver(handlers: readonly MailboxHandler[], send: (to: number, message: number, from: number) => void): { handler: number; key: number; message: number }[] {
    const out: { handler: number; key: number; message: number }[] = [];
    for (const h of handlers) {
      if (!h.links.length) continue;
      const key = handlerKey(h.values);
      const hits = this.entries.filter((e) => e.key === key);
      if (!hits.length) continue;
      for (const e of hits) {
        for (const u of h.links) send(u, e.message, h.uid);
        out.push({ handler: h.uid, key, message: e.message });
      }
      this.entries = this.entries.filter((e) => e.key !== key);
    }
    return out;
  }

  save(): MailboxEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  load(list: unknown): void {
    this.entries = Array.isArray(list)
      ? list.filter((e): e is MailboxEntry => !!e && typeof e === 'object' && Number.isFinite((e as MailboxEntry).key) && Number.isFinite((e as MailboxEntry).message)).map((e) => ({ key: e.key >>> 0, message: e.message }))
      : [];
  }

  clear(): void {
    this.entries = [];
  }
}
