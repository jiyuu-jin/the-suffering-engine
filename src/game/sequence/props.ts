// Which sequence-track objects the sequence presenter shows as skinned props (system.ts), also
// used by the track audit (tools/stomp-audit.ts).
//
// Plain prop classes (the ones levels/skinned-props.ts leaves to the presenter when a sequence
// drives them) are shown whatever instance flag 0x80 says: the engine's instance loader never
// reads that bit (an editor flag; docs/re/object-model.md §2); whether they show is flag 0x1
// through the level logic. 1a "Guard" #242 drags the guard into a ceiling duct with "Chain"
// (Breakable #7faa, skinned model 12:636, flags 0x1): requiring 0x80 left the body rising on
// its own. Other classes keep the 0x80 rule (their own systems may draw them: cranes, weapons,
// projectors). Models of the system package are editor proxies.

/** Skinned prop classes no other system draws while a sequence track holds them. */
export const SEQUENCE_PROP_CLASSES: ReadonlySet<string> = new Set(['Breakable', 'Static Object', 'Light Housing', 'TargetableBreakable']);

/** Package of the engine's editor proxies (sound / light / trigger markers). */
const SYSTEM_PKG = 2;

/**
 * Candidate for a presenter-drawn skinned prop (the caller still checks that the model has a
 * skeleton and that the object is not a character, Animating Static or the player).
 */
export function sequencePropCandidate(cls: string, flags: number, modelPkg: number): boolean {
  return modelPkg !== SYSTEM_PKG && (SEQUENCE_PROP_CLASSES.has(cls) || !!(flags & 0x80));
}
