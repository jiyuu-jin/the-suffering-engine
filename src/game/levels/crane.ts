// Crane (class 0xf67a582e, PhysicalObject family; Prelude 11d, 4a 7c6e, 4b 7a26 / 7a2f / 7a37,
// 10 Docks): the hoist of a skinned crane, decoded from Suffering.rfl (vtable 0x1014c478,
// constructor 0x100132f0, init 0x10012270, update 0x10012730, control 0x10012b90 on the
// interface at +0xc, map 0x101694b8, motor sounds 0x100122e0, save / load 0x10012110 /
// 0x100120d0) [verified unless marked]:
//
//   * Init plays the pose clip p41 on the crane's rig (and again when the hook stops: 0x10012060).
//   * First update with a posed skeleton: the cable runs from bone p26 to bone p27; its length L
//     in the bind / pose frame is the distance between the two bones' translations. The hoist
//     works in ratios of L: min = p28 / L, max = p29 / L and the current ratio = p30 / L (unless
//     a save restored it); the target starts at the current ratio. Bone p26 gets a uniform scale
//     matrix of the current ratio and bone p27 its inverse (0x10012180), so the cable stretches
//     to `ratio x L` while the hook on p27 keeps its size.
//   * The same update creates one object of each template in p36 and attaches it to the bone of
//     the same index in p35 (4a / 4b: the hook block, Breakable 23:856, on bone 3).
//   * Every later update moves the ratio towards the target at p31 m/s while it grows (the hook
//     goes down) and p32 m/s while it shrinks (up), both divided by L, and stops on the target;
//     stopping replays the pose clip. While it moves the hoist motor plays: p44 when it starts,
//     the p45 loop meanwhile, p46 when it stops (p47..p49: the same for the slew, which only a
//     controlling player drives).
//   * Inputs p37 (Increment) and p38 (Decrement) both run the control with hoist -1, slew 0:
//     the hook goes up to the minimum. (A positive hoist would lower it to p29, shortened to
//     where a sweep of radius p40 down from bone p39 meets something; no retail level sends one.)
//   * Crane's message map has no parent (docs/re/object-model.md): Destroy / BlowUp do nothing.
//   * Save / load keep the current and target ratios (+0x28 / +0x2c).
//
// In 4a / 4b nothing sends Increment / Decrement, so the cranes hang their hook block at p30 m
// (4b: 5 / 4.1 / 4 m, 4a: 15 m) and are otherwise moved by their "Crane" sequences.

import type { ResRef } from '../../formats/model';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ref = (v: unknown): ResRef | null => (v && typeof v === 'object' && 'pkg' in v && 'id' in v ? (v as ResRef) : null);
const refs = (v: unknown): ResRef[] => (Array.isArray(v) ? v : [v]).map(ref).filter((r): r is ResRef => !!r);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number');

export interface CraneParams {
  /** Cable top / bottom bones (p26 / p27). */
  cableTop: number;
  cableEnd: number;
  /** Cable length limits and start (m: p28 / p29 / p30). */
  minLen: number;
  maxLen: number;
  startLen: number;
  /** Hoist speeds (m/s): down (p31), up (p32). */
  downSpeed: number;
  upSpeed: number;
  /** Objects hung on bones: p35[i] bone, p36[i] template. */
  hung: { bone: number; template: ResRef }[];
  /** Pose clip (p41). */
  pose: ResRef | null;
  /** Hoist motor sounds: start, loop, stop (p44 / p45 / p46). */
  hoistSounds: [ResRef[], ResRef[], ResRef[]];
  /** Increment / Decrement message ids (p37 / p38). */
  inputs: number[];
}

/** The Crane's properties, by index (entity values). */
export function craneParams(v: readonly unknown[]): CraneParams {
  const bones = ints(v[35]);
  const tpls = refs(v[36]);
  return {
    cableTop: num(v[26], 2),
    cableEnd: num(v[27], 3),
    minLen: num(v[28], 1),
    maxLen: num(v[29], 5),
    startLen: num(v[30], 1),
    downSpeed: num(v[31], 2.5),
    upSpeed: num(v[32], 1.5),
    hung: tpls.map((template, i) => ({ bone: bones[i] ?? -1, template })).filter((h) => h.bone >= 0),
    pose: ref(v[41]),
    hoistSounds: [refs(v[44]), refs(v[45]), refs(v[46])],
    inputs: [v[37], v[38]].filter((x): x is number => typeof x === 'number' && x > 0),
  };
}

/** The hoist state: ratios of the bind cable length (0x10012730). */
export class CraneHoist {
  current: number;
  target: number;
  readonly min: number;
  readonly max: number;
  private readonly down: number;
  private readonly up: number;
  moving = false;

  constructor(
    readonly p: CraneParams,
    /** The cable's length in the posed rig (m): bone p26 to bone p27. */
    readonly length: number,
    restored?: { current: number; target: number },
  ) {
    const L = length > 1e-6 ? length : 1;
    this.min = p.minLen / L;
    this.max = p.maxLen / L;
    this.down = p.downSpeed / L;
    this.up = p.upSpeed / L;
    this.current = restored?.current ?? p.startLen / L;
    this.target = restored?.target ?? this.current;
  }

  /** The cable's length now (m). */
  get cable() {
    return this.current * this.length;
  }

  /**
   * Control (0x10012b90) with hoist < 0: up to the minimum; > 0: down to `lowest` (ratio) at
   * most; 0 leaves the target alone (the hook goes on to it).
   */
  control(hoist: number, lowest = this.max) {
    if (hoist < 0) this.target = this.min;
    else if (hoist > 0) this.target = Math.min(this.max, Math.max(this.min, lowest));
  }

  /** Advance by dt; returns 'start' / 'stop' on motor changes. */
  update(dt: number): 'start' | 'stop' | undefined {
    if (this.current === this.target) {
      if (this.moving) {
        this.moving = false;
        return 'stop';
      }
      return undefined;
    }
    const was = this.moving;
    this.moving = true;
    const lowering = this.current < this.target;
    const step = (lowering ? this.down : -this.up) * dt;
    const next = this.current + step;
    if (lowering ? next >= this.target : next <= this.target) {
      this.current = this.target;
      this.moving = false;
      return was ? 'stop' : undefined;
    }
    this.current = next;
    return was ? undefined : 'start';
  }
}
