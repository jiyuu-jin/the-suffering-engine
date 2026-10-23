// Enhanced gore: the decal budget (docs/enhanced.md "Gore"). Every splat of a kind lives in one
// vertex buffer drawn in one call; this ring hands out vertex ranges and recycles the oldest
// splats when the buffer or the tier's budget is full. Pure bookkeeping (tests).

export interface RingRecord {
  id: number;
  start: number;
  count: number;
}

export class DecalRing {
  /** Live records, oldest first. */
  readonly records: RingRecord[] = [];
  private head = 0;
  private nextId = 1;
  /** Records recycled so far (stats). */
  recycled = 0;

  constructor(
    /** Vertices the buffer holds (fixed). */
    readonly size: number,
    /** Vertices in use at this tier (≤ size). */
    private capacity: number,
    /** Records alive at once at this tier. */
    private budget: number,
  ) {
    this.capacity = Math.min(capacity, size);
  }

  get limit() {
    return { capacity: this.capacity, budget: this.budget };
  }

  /**
   * Room for `n` vertices: returns the range and the records it recycled (their ranges must be
   * cleared unless the new splat overwrites them). Null when a splat can never fit.
   */
  alloc(n: number): { id: number; start: number; evicted: RingRecord[] } | null {
    if (n <= 0 || n > this.capacity || this.budget <= 0) return null;
    const evicted: RingRecord[] = [];
    if (this.head + n > this.capacity) this.head = 0;
    const lo = this.head, hi = this.head + n;
    // Recycle what the range overwrites (always the oldest: the ring writes in order).
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.start < hi && r.start + r.count > lo) evicted.push(...this.records.splice(i, 1));
    }
    // Then the oldest beyond the budget.
    while (this.records.length >= this.budget) evicted.push(this.records.shift()!);
    const rec = { id: this.nextId++, start: lo, count: n };
    this.records.push(rec);
    this.head = hi;
    this.recycled += evicted.length;
    return { id: rec.id, start: lo, evicted };
  }

  /** A new tier: records outside the capacity or beyond the budget go (oldest first). */
  resize(capacity: number, budget: number): RingRecord[] {
    this.capacity = Math.min(capacity, this.size);
    this.budget = budget;
    const out: RingRecord[] = [];
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.start + r.count > this.capacity) out.push(...this.records.splice(i, 1));
    }
    while (this.records.length > this.budget) out.push(this.records.shift()!);
    if (this.head > this.capacity) this.head = 0;
    this.recycled += out.length;
    return out;
  }

  clear(): RingRecord[] {
    const out = this.records.splice(0);
    this.head = 0;
    return out;
  }

  /** Vertices in use. */
  get used(): number {
    let n = 0;
    for (const r of this.records) n += r.count;
    return n;
  }
}
