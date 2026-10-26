// One speech channel per character: which line wins (docs/game-logic.md §15.4 "Speech
// priorities"). Decoded from Suffering.rfl [verified unless marked]:
//
// - Speak (speech component 0x1012d190; the Character's at +0x40e, the Player's at +0x248):
//   a new line may start when the character says nothing (no handle, or its sound has ended:
//   sound manager vt+0x10c) or when its priority is above 1 and at least the priority of the
//   line it is saying. Then the old line is stopped (vt+0xc8), the new priority kept (+0xb4) and
//   the sound played on the character. Otherwise the new line is dropped: nothing queues.
// - Character Say (0x100e1b40): a dead character says nothing (0x100a1ad0); else Speak.
// - Priorities the callers pass: 1 for every line (conversations' PlayDialog 0x100ffbc2, the
//   Speech Player 0x1012dab4, the Action Dialog's spotting barks 0x1008d7fa, the behaviours'
//   lines, the Player's own 0x10041320), 2 for the Action Dialog's answers to the player's hits
//   (the warning p16 0x1008d5ec, p13 0x1008df56, the turn p20 0x1008e065), 9 for a sound a STOMP
//   key hands the character (key flag 0x20: message 0x1011 with the sound, SUFFERING.EXE
//   0x450b10; the Character queues it, 0x100e3f53 -> 0x1012d370, and its speech update
//   0x1012d3b0 adopts it once it plays). So a priority-1 line never cuts another line, an
//   answer to a hit cuts a line or another answer, and a sequence's line cuts everything.

/** The priorities the original's callers pass to Speak. */
export const SPEECH_PRIORITY = { line: 1, hitAnswer: 2, sequence: 9 } as const;

/** Whether a line of `priority` may start on a channel saying a line of `current` (playing or not). */
export function speechAdmits(playing: boolean, current: number, priority: number): boolean {
  return !playing || (priority > 1 && priority >= current);
}
