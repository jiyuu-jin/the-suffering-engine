# Original save system (SUFFERING.EXE / Suffering.rfl)

Reverse-engineered from the writer and reader code. The retail `Saves/` folder is empty, so
nothing here was checked against a real save file. Addresses are VAs (EXE base 0x400000, RFL
base 0x10000000).

Tags:
- **[verified]**: read in the code.
- **[strong]**: the code plus the data or the names agree.
- **[inferred]**: a reading that fits.

Code:
- `src/formats/save-original.ts`: the container, the chunk stream, `Unspeakable.cfg` read and
  write, the `.rsg` header and the start of its body.
- `src/game/save/rules.ts`: the original's rules for when the player can save and when a
  checkpoint is taken.
- `src/game/save/transfer.ts`, `src/app/menu/save-files.ts`, `src/app/menu/original-profile.ts`:
  import and export on the player's disk (§8).
- Tests: `tests/re-saves-audio-player.test.ts` and `tests/save-files.test.ts`. They use
  synthetic data only (one checks the user's own `Suffering.rfl` when it is there).

## 1. Layers

### 1.1 Engine interfaces

The RFL receives a table of EXE interface pointers in `0x10128480`, filled by the EXE at
`0x4050b0`. Four of them matter here:

| RFL global | EXE object | vtable | Role |
|---|---|---|---|
| `0x1017bf4c` | `0x5c6ff0` | `0x58eed8` | Save manager. It holds the slot list, the checkpoint and the transition saves. |
| `0x1017bf50` | `0x5c7558` | `0x58ef38` | Profile / settings file (`Unspeakable.cfg`). |
| `0x1017bf38` | `0x5c6910` | `0x58ec60` | World. `+0x48` saves the level into a stream (`0x42d7f0`) and `+0x4c` loads one (`0x42d8d0`). |
| `0x1017bf3c` | `0x5c6dc4` | `0x58c7b8` | Paths. `+0x3c` returns the root folder `0x5ca6d0`. |

### 1.2 Chunk stream [verified]

The chunk stream is EXE class vtable `0x590fc0`, constructor `0x465f70(mode, store)`.

Mode:
- 0 opens it for reading (`inflateInit_`, `0x4e4c10`).
- 1 opens it for writing (`deflateInit_ "1.1.3"`, `0x4e6750`).

The level is the default unless the store flag `0x40` is set, which gives level 0. Saves and
settings always use the default level.

Data passes through 8 KB pages. A chunk starts with `0x464ed0(tag, id)` and ends with
`0x465bd0`. Ending a chunk runs `deflate(Z_FINISH)`, writes the pages and calls `deflateReset`
(`0x4e63f0`), so **every chunk is its own zlib stream** with a header and an adler32.

Primitives (write slot / read slot):

| Slot | Value |
|---|---|
| `+0x48` / `+0x20` | u8 |
| `+0x40` / `+0x1c` | u16 |
| `+0x44` / `+0x24` | u32 |
| `+0x3c` / `+0x18` | f32 |
| `+0x38` / `+0x14` | f64 |
| `+0x2c` / `+0x08` | raw bytes |
| `+0x34` / `+0x10` | string: u16 length, then the bytes, no terminator |
| `+0x30` / `+0x0c` | wide string: u16 byte length **including** the UTF-16 NUL, then UTF-16LE |

All values are little-endian.

### 1.3 File [verified]

The file object is vtable `0x58ed30`, on the SRSC base class `0x596468`. Every save and
settings file is an **SRSC container**: the same format as the `.?du` packages
(`src/formats/srsc.ts`).

- Header: "SRSC", version 0x0101, directory offset, entry count (`0x4e06e0`). It is rewritten
  when the file is closed (`0x4df980`).
- One directory entry per chunk: `{u16 tag, u16 id, u16 extra, u32 offset, u32 size}`
  (`0x4e03e0`). The tag's low byte is the SRSC "type" and its high byte the "group".
- Payloads are aligned to 8 bytes (vt+0xc0, `+0x13c` = 8).
- Tags in use: 0x0000 (header) and 0x0401 (body).

## 2. Settings / profile: `<root>\Unspeakable.cfg`

`<root>` is the folder in `0x5ca6d0`, set up at `0x407630`. It is the PC version of a console
memory-card file named "UnspeakableSettings".

- Write: `0x10007690`, through EXE `0x430a60` and `0x4308a0`.
- Read: `0x100077f0`, through `0x4306e0`.
- Defaults: `0x10007400`.
- Apply: `0x10007310`.

The file is written at startup when no valid file exists (`0x100b202e`), when the options are
accepted, and after every manual save (`0x1005f48f`). The RFL keeps the settings in memory at
`0x1017ac3c`.

**Payload** [verified order and types; names from the users]. It is one chunk, tag 0x0401,
id 0:

| Offset in object | Type | Default | Meaning |
|---|---|---|---|
| +0x04 | u32 | 0 | not referenced outside load and save [unknown] |
| +0x08 / +0x0c | u32 | 0 | passed to the display interface `[0x1017bf30]` vt+0xac / +0xb0 [names unknown] |
| +0x10 | f32 | 1 | **Effects volume**. The sound interface applies it to categories 0, 1, 4 and 5 (`vt+0x50(cat, v)`). |
| +0x14 | f32 | 1 | **Dialog volume**: categories 3 (movie) and 6 (dialog) |
| +0x18 | f32 | 1 | **Music volume**: category 2 |
| +0x1c | f32 | 1 | **Turn sensitivity**. It scales the strafe and turn axes (0x10035933). |
| +0x20 | f32 | 1 | **Pitch sensitivity** (0x10035904, 0x1003f933 with action 0x41d) |
| +0x24 | u32 | 2 | **Checkpoints**: 0 Off, 1 Prompt, 2 On |
| +0x28 / +0x2c | u32 ×2 | 1 / 1 | **Unlocked Archive pages**. One bit per page index for Archive Set 0 and Set 1 (GUI Archives 0x100515b6; Archives Trigger sets them at 0x10051f54). Page 0 of each set starts unlocked. |
| +0x30 | u32 | see below | flags |
| +0x34 | u32 | | number of key bindings |
| | 20 B each | | `{u32 action, u32 device, u32 code, f32 lo, f32 hi}`. This is the record of the RFL default table `0x10167520`, for example {0x3ea Pause, 0 keyboard, DIK 1 Esc, -1, 1}. After loading, the list is handed to the input interface (`[0x1017bf90]` vt+0). |
| | u32 | | trailer **0x600D**, written by the profile close (`0x4308a0`). On read, a missing trailer clears `+0x31c` "valid". The game then reports error -13 and uses the defaults. |

**Flags** (+0x30). Each meaning comes from the bit's readers:

| Bit | Meaning | Default |
|---|---|---|
| 0x001 / 0x002 | Speaker Setup: none set = Mono, 0x1 = Stereo, 0x1 + 0x2 = Surround. The audio page reads them at 0x10053f54 and writes them at 0x10052c70; sound interface vt+0x68 / +0x6c. | Surround |
| 0x004 | Subtitles on. The subtitle box shows only when it is set (0x10069942). | off |
| 0x008 | In-game help text (help popups 0x100152e6) | on |
| 0x010 | Invert pitch (×−1 at 0x10012608, 0x10035a99, 0x1003f967) | off |
| 0x020 | Controller vibration (handed to the input interface at 0x100b1b23 / 0x100b2856) | on |
| 0x040 | read by the player and weapon code (0x1001920e, 0x100284e6, 0x1004baa3). Probably the console Auto Targeting [inferred]. | off |
| 0x080 | unused [unknown] | off |
| 0x100 | **Environment FX** (EAX), sound interface vt+0x134. The default is on only when the sound device reports support (`[0x1017bf70]+0x178 & 2`). | on if supported |
| 0x200 | The file was read successfully (0x100079b4). The boot movie can then be skipped. | – |
| 0x400 | **Game finished**: set by the Game Finished screen (0x100562e1). The main menu's New Game then starts the Prelude (p18 instead of p17), and 0x100066e0 unlocks extras. | off |

So the profile holds the options, the key bindings, the Archives unlocks and the "finished"
unlock. There is no separate unlocks file. Difficulty is not in the profile.

## 3. Saved games

### 3.1 Where [strong]

The save manager's configuration is built by RFL `0x100b0e30` and copied to manager +0x250.
It holds the folder `"Saves\"` and the name `"UnspeakableSave"`.

A new save, written by `0x42f530` (save manager vt+0x18):

1. It creates a folder named after `time(NULL) + 1` in hex, bumped until the name is unused
   (0x42f6d9).
2. It writes **one file `<LevelName>.rsg`** into that folder (0x42f92f, `"%s%s.rsg"`).

Slot list entries are 0x188 bytes at manager +0x234 (count +0x23c):

| Offset | Content |
|---|---|
| +0 | file path |
| +0x104 | wide name |
| +0x154 | chapter handle |
| +0x158 | slot number |
| +0x15c | `struct tm` |
| +0x184 | thumbnail texture |

- The slot number is the lowest positive number not already used (0x42f850).
- The time shown comes from the file, not the payload [inferred: no time field is written].
- Deleting a slot removes `*.rsg` and `*.rlt`, then the folder (0x431170). Copying a slot
  copies its files (0x4313e0).

### 3.2 `.rsg` header chunk (tag 0, id 0) [verified]

Writer 0x42cf00, reader 0x42b490.

| Type | Value |
|---|---|
| u32 | version = **2**. The loader refuses anything else. |
| u32 | 1. The loader stores it in `0x5b9a04`. |
| u32 | slot number |
| u32 | id of the object the save is named after: the chapter object `[0x10178660]` passed by the save GUI (0x1005f366). The loader resolves it back to a handle. |
| string | level path |
| wstring | save name. The GUI passes the chapter's title. The checkpoint uses "Autosave". |
| u32 | 1 when a thumbnail follows, else 0 (0x42b3f0) |
| u32 ×4 | thumbnail width, height, engine texture format and byte size |
| bytes | the locked surface, pitch × height. The loader recreates the texture at 0x42b59c. |

The thumbnail is the texture in RFL `0x1017ba9c`: the screenshot the pause menu keeps.

### 3.3 `.rsg` body chunk (tag 0x0401, id 0) [verified order; most contents opaque]

Writer 0x42d010:

1. u32 N, then N u32: one per entry of the loaded-database table at `0x5cbe40` (12-byte
   entries).
2. u32 object count (world +0x328 + +0x31c).
3. u32 from `0x5c6e98`.
4. u32 id of the current level-info object's +0x24.
5. f32 from its +0x28.
6. Subsystem blocks, in this order:
   - `0x5c89d0`: `0x42c1d0`, which writes a u32 and then `0x5c5ed4` and `0x5c5c00`.
   - `0x5c6fb0`: `0x4c29d0`.
7. **Pass 1 over every object** (`0x42c2f0` → world vt+0x58 = `0x42d620`): a u32 from the
   object's template, then the engine's base record `0x456ba0`. The base record holds the
   flags, ids, the transform (`0x4d8bb0`), a u16, link and message lists, an f32 and more.
8. The game DLL's global block (`[0x5c5d80]` vt+0x58).
9. **Pass 2** (`0x42c390` → `0x42b9a0` → `0x4540e0`): per object, a u32 "has game object",
   then the RFL class's own save method (game object vt+0x30). The blood-skin component
   (0x10099ba0) is one example.
10. The database blocks (`0x42c210`): a count, then index + payload pairs.
11. Two more subsystems (`0x5c9478`, `0x5c9010`).
12. **Stored transition saves** (`0x42ef80`, "Output Stored Transition Saves"):
    - u32 count.
    - For each level: its in-memory chunk stream (`0x4648d0`: u32 directory count, 14-byte
      entries {u16 tag, u32 size, u32 page offset, u32 page index}, u32 page count, then
      u32 length + compressed bytes per page), followed by the level name string.
    - Each embedded stream is a full level save: a header chunk and a body chunk.

Records have **no length prefixes**, and every class serializes itself. An importer must
reimplement every class's save routine before it can read past item 7. `parseOriginalSave()`
decodes items 1–5 and keeps the rest as bytes.

### 3.4 Transitions and revisits [verified]

The level being left is saved into an in-memory stream kept in the manager's transition list
(+0x240, count +0x248, name at the entry start, stream at +0x104). Entering a level looks the
list up by name (0x42ec90). When the level is found, its stream is loaded instead of a fresh
start (0x42ee90, "Attempting transition to"). A save game embeds the whole list (item 12
above). This matches the port's per-level `levels[path]` state.

## 4. Checkpoints [verified]

- **Storage.** The checkpoint is **kept in memory only** (0x42edb0). It is a compressed
  stream at manager +0x24c, named "Autosave", with no thumbnail. The manager sets flag 8 on
  +8. Reverting loads it (0x42ed20). Discarding it clears the flag (0x42ed70). Checkpoints
  are never written to disk.
- **Autosave `inSave`** (message map 0x10177ec0, handler 0x100970a0). Nothing happens unless
  all of these hold:
  - there is a live Player;
  - the player's recent-damage value is spent: `0x100415a0` requires the component at
    +0x448 to be ≤ 0. Damage feeds that component (0x1002e030), and its decay was not
    traced.
  - the player's health is at least **5** (vt+0x4c compared with 5.0).
- **Mode.** The instance's p1 decides when it is non-zero; otherwise the Checkpoints option
  (+0x24) does:
  - 0 Off: nothing.
  - 1 Prompt: a Yes/No box with UIP p61's text (0x10096f10). If the game is busy it retries
    later through a delayed message. Yes runs the save (0x10097040 → 0x10096fe0).
  - 2 On: shows UIP p28 (the checkpoint notice) and saves.
- **The save itself** (0x10096fe0) happens only with the option not Off and while no load or
  save is running. It mutes the sound around the call (`[0x1017bf40]` vt+0x54).
- **Death.** When the player dies (0x1002d780) with the option not Off and a checkpoint
  present, the engine posts UI event 24. That is the same event as the pause menu's
  confirmed "Revert to last checkpoint" (0x1006557d). Otherwise it posts event 12, which was
  not traced. It is probably the game-over path [inferred].

### 4.1 What a checkpoint holds and what a revert puts back

- **Capture** [verified]. Save manager vt+0x4c is `0x42edb0`. On the first checkpoint it creates
  the in-memory chunk stream (`0x465f70`) and keeps it at +0x24c. Each checkpoint rewinds that
  stream (`0x4649c0`) and calls world vt+0x48 (`0x42d7f0`) with the wide name "Autosave", then
  closes it (`0x4643c0`) and sets flag 8. World vt+0x48 writes the same level save as a save
  game: the header and the body of §3.2 / §3.3 (`0x42d010`), so every object's base record
  (pass 1) and its class's own save (pass 2) go in. A later checkpoint overwrites the earlier
  one: there is only ever one.
- **When** [verified, with one step inferred]. The Autosave `inSave` handler (`0x100970a0`) in
  mode On shows the notice and then posts a message to its own engine object (vt+0xfc(8)).
  The handler of that message (`0x100972a0`) calls the save (`0x10096fe0`), which mutes the
  sound and calls manager vt+0x4c. So the checkpoint is taken in the message pump right after
  the Autosave fired, and it is the level as it is at that moment, whatever is running [the
  message being delivered in the same or the next frame is inferred]. The other callers of
  `0x10096fe0` are the GUI's save paths.
- **Revert** [verified]. Manager vt+0x50 is `0x42ed20`. With a checkpoint present (+0x24c set,
  flag 8) it marks itself busy (+4), rewinds the stream (`0x464a20`) and calls world vt+0x4c
  (`0x42d8d0`), which is the same loader as Load Game:
  1. It frees the loaded-database table (`0x42cb80`) and the object table (+0x314).
  2. It reads the header, then reloads the level file through `0x4670b0`. It passes flag 3 when
     the path equals the running level, which keeps its resources, else flag 1.
  3. It creates every object of the save again (`0x45c3f0` per slot, `0x454070` for the
     database objects).
  4. Pass 1 (`0x42b7c0`, log "Loading Objects from save file") gives each object its base
     record through world vt+0x64. Pass 2 (`0x42b890`, the same log) gives it its class state
     through world vt+0x68. Then the "minimally saved objects" are read (`0x42d1f0`).

  So a death restore is **not** a partial reset. Nothing that happened after the checkpoint
  survives, and no object keeps its level-start state unless it had that state when the
  checkpoint was taken.
- **Class state** [verified for the classes named; the rest follow the same slots]. Each class
  writes its own state. Some examples:
  - **Timer** (vtable `0x10159f30`): save +0x30 `0x10133890` writes the countdown (f32 +0xe)
    and the sender (u32 +0x12). Load +0x2c `0x101338c0` reads them back.
  - **Count Down To Zero** (vtable `0x10154988`): save `0x10137150` writes the count (+0xc).
  - **Detector** (vtable `0x10154c20`): save `0x100a7870` writes a u32 (+0x10), the number of
    objects inside (+0x20) and each one's handle (+0x18 list). So a restored Detector knows who
    is already inside, and its On / Exit come only on real changes.
  - **STOMP Player** (vtable `0x10159d58`): save `0x1012eaf0` writes u32 +0x10, the sequence
    time (f32 +0x14) and u32 +0x18. A sequence that was playing goes on from where it was.
  - **Message Relay** (vtable `0x10155f50`): save `0x10119840` only chains to the base class.
  - **Character** (vtables with catch-all `0x100e1e20`, e.g. `0x10152e38`): save +0x30
    `0x100e2b60` writes three u32s and then its components one after the other: the mover / navigation
    block at +0x90 (`0x100dca30`, about 40 values: positions, speeds and the current path), the touch
    component +0x1ae, and the components at +0x2c0, +0x222, +0x26c, +0x31c, +0x562, +0x360,
    +0x40e, +0x536, +0x542 and +0x5a2.
  - **Behaviours** have their own save and load: behaviour vtable +0x44 / +0x48. FleeBehavior
    (vtable `0x10157640`) uses `0x1010b420` / `0x1010b4b0`, which write and read its fields
    (+0x2a, +0x2c, +0x62, +0x4a, +0x36, +0x2e, +0x32, +0x3a, +0x46, ...).

  So a restored character goes on with the behaviour it ran, at the point it had reached
  [inferred from the slots; the mid-walk and mid-line cases were not traced].
- The Player is an object of the level like any other. A revert therefore brings back its
  health, inventory and state as they were at the checkpoint [inferred: Player save not
  traced].

## 5. "Cannot save here" [verified]

The pause menu (0x10065d0c..0x10065dbe) disables the Save Game item (state 3) when the
Player's can-save predicate `0x100438a0` returns false. The predicate returns false when the
player:

- is dead (0x100a1ad0);
- has bit 0 of the state set +0xa4 set [unnamed];
- is under script control: +0x9c bit 1. The cinematic entry point 0x10042650 sets it while
  entering state 11 Controlled, and 0x100426d0 clears it.
- is in Interact (22) or LadderClimb (27), via the mask 0x8400000;
- is in Item Pickup (26), View Monitor (23), Document View (31), Morph (19), Freak Out (34),
  Jump (8), Fall (9) or Jump Melee Attack (14).

There is **no enemy-proximity rule**, and saving while transformed (state 20) is allowed.

## 6. What the port does now

- `src/game/save/system.ts` now uses `originalSaveVeto()`. It blocks saving while the player
  is dead, under cinematic control, morphing, airborne (not on the ground), on scripted
  locomotion (ladders, mounted guns: `PlayerController.motionOverride`) or busy. Busy means a
  Security Monitor's feed is showing (View Monitor, state 23) or a modal Movie Player movie is
  playing (3b's flashbacks: the port's sign of the original's script control, [inferred]). It dropped the
  previous rule that blocked saving while hostile creatures within 30 m were fighting.
- Autosave objects go through `autosaveAction()`: alive, health ≥ 5, the object's p1 or the
  Checkpoints option. "Prompt" saves like "On" because the port has no prompt box, and the
  recent-damage check is not modelled.
- Port additions kept on purpose:
  - checkpoints at level start and after transitions;
  - the persistent `autosave` slot;
  - the automatic revert 4 s after death;
  - a requested checkpoint waits while the player is on scripted locomotion (ladder, clamber,
    use animation, mounted gun or crane controls, a creature holding him). The controller's
    script is not saved, so a restore there would leave him standing in mid-air. The original
    rebuilds the Player in that state. Manual saves are refused there anyway (§5).
- Saving while transformed is allowed, as in the original (§5). The creature form is saved
  with the insanity state, and a load in creature form transforms at once. A mid-morph
  checkpoint keeps the form the morph goes to. The kill-combo window is saved too.
- **Revert / death restore** (§4.1). The port does not rebuild from a stream. It restarts the
  level's systems on the level data it already has loaded (`main.ts restartLevel`), then
  hands every save provider its part of the checkpoint. So the restore is only as exact as
  the providers are complete. What they cover:
  - world entities: destroyed, enabled, visible and class state, plus the dispatcher (§3.3
    pass 1 and pass 2);
  - props (with the Pushables the player has held), lights and drops;
  - thrown objects in flight or burning (`weapons.thrown`: the player's throwables and NPC throws);
  - actors: placement, health, dormancy, hostility, the behaviour and how far it got, plus
    special moves' own state (`actors.specials`);
  - the director's Behavior Changers, chains, EdgeTogglers, Aim Controllers, Speech Players
    and Action Dialogs;
  - Object Cloners, insanity (with the creature form), weapons (with the flashlight on / off),
    inventory, health, music and the player transform.

  A save without a game-scope provider's entry (an imported original save, §8.2) gets that
  provider's new-game state. A provider missing from a record is not loaded; its optional
  `absent` runs instead (`save/registry.ts`), for a record older than the provider: the
  `fx.bodyParts` one rebuilds what saves from before it lack, Characters shown by a sequence's
  take and their fades and gas, from the sequences the level has played (game-logic.md §15.7.12). The inventory is restored as saved, not through the systems'
  pickup rules (before the fix, every load and transition added a gun pickup's ammo).

  The player controller outlives the systems. Every level start therefore releases what the
  old systems handed it (`releasePlayerControl`): scripted locomotion, a held clip's motion
  lock, facing lock, virtual input, attack hold and the enabled state. In the original these
  go with the Player object the restore rebuilds.
- Known gaps: the AI's momentary state (target, path, attack under way) starts from idle; a
  line of speech or dialogue under way is not played again (its end messages still come);
  bodies of `services.actors.spawn` creatures are not kept (dead Object Cloner copies are); Electric Arc Effects running on a target end.
- Checks:
  - `node tools/playthrough.mjs --deaths ch1` (docs/playthrough.md) compares the restored level
    with a fingerprint taken in the frame the checkpoint was captured.
  - `node tools/save-matrix.mjs` (docs/playthrough.md "Save matrix") does the same for every
    level and many states (creature form, fights, cuts, low health, a full inventory,
    difficulties, reputations, vetoed states), in the same session and after a page reload,
    and also checks the save providers' own round trip and revisits.

### Proposed follow-ups (not done)

- Loading the original's `.rsg` saves with their state. It needs the per-class readers from
  §3.3 (every class's save routine). §8 imports their header only.

## 7. Open

- Settings +0x04 / +0x08 / +0x0c.
- Flag 0x40 (probably Auto Targeting).
- UI event 12.
- The decay of the +0x448 damage value.
- The thumbnail's texture-format codes.
- The meaning of the body's prefix values 3–5.

## 8. Saves on the player's disk (port)

Saves live in the browser (§9). The Load Game and Save Game lists also have file rows, in the
port's own wording because the game's LoadSave GUI has no file items. The code is
`src/app/menu/save-files.ts` (pickers and downloads), `src/game/save/transfer.ts` (pure) and
`src/app/menu/original-profile.ts`.

Pickers:
- Where the browser has the File System Access API (Chromium), the port uses
  `showOpenFilePicker`, `showDirectoryPicker` and `showSaveFilePicker`.
- Elsewhere it uses `<input type=file>` (with `webkitdirectory` for a folder) and a download
  link.
- Files are read inside the page. Nothing is uploaded.

The rows:

| List | Row | What it does |
|---|---|---|
| Load | X key on a save | Exports that save to a `.json` file. |
| Load | Import saves from a file… | Reads `.json` exports back. |
| Load | Import from the original game (folder)… | Reads the game folder, its `Saves` folder or one save's folder, three levels deep, for `*.rsg` and `Unspeakable.cfg`. |
| Load | Import original files (.rsg, Unspeakable.cfg)… | Reads the same files picked one by one. |
| Load, Save | Export all saves to a file… | Writes every usable save to one `.json` bundle. |
| Save | Export settings as Unspeakable.cfg… | Writes the port's options in the original's profile format. |

Load Game stays enabled without saves, because its list is where saves come in. Continue is
still disabled until a save exists.

### 8.1 The port's own saves (.json)

A bundle is `{ format: "the-suffering-web/saves", version: 1, exportedAt, saves: SaveData[] }`.
A file holding one SaveData, or an array of them, is accepted too.

On import:
- Every entry goes through `migrateSave()`, the store's own validation. What it refuses
  (damaged, or from a newer version) is counted and skipped.
- A save already in the store with the same content is skipped.
- A save whose id is taken by a different save gets a new id.
- The autosave slot comes in as a manual save. The checkpoint slot is never overwritten.

### 8.2 The original game's saves (.rsg) [header: verified; mapping: port]

`readOriginalFiles()` reads each `.rsg` header (§3.2) and the start of its world chunk (§3.3,
items 1–5). The rest of the world chunk cannot be read. Its records have no lengths and every
class writes its own layout, so reading past the first object needs every class's reader.

What carries over:

| Original | Port save |
|---|---|
| Header level path | `levelPath`, matched against the game data from its `LEVELS` folder on. A level the data does not have is not imported, and the toast counts it. |
| Header save name (the chapter's title, UTF-16) | `title` |
| Folder name: hex of `time(NULL) + 1` (§3.1) | `createdAt`. The file's own time is used when the name is not a plausible time. |
| Header thumbnail | `thumbnail`, a 160×120 JPEG. The engine's format codes are not mapped (§7). The layout is guessed from the pitch: 4 bytes a pixel read as B, G, R, A (Direct3D A8R8G8B8 / X8R8G8B8), 2 bytes as R5G6B5 [inferred]. |
| Slot number, chapter object id, object count | Kept in `imported` for reference. They are not used. |

What does not carry over: everything in the world chunk past its prefix. That covers the
player (health, inventory, weapons and ammo, insanity, reputation, position), every object's
state and the stored transition saves (the visited levels, §3.3 item 12). Difficulty is not in
the header either; the import uses the difficulty of the port's last New Game.

So an imported save is a save of the start of its level. The level loads fresh at its Player
Spawn Point, with a new game's game-scope state: providers the save has no entry for are
reset (`SaveRegistry.reset(scope, except)`), whatever the session played before.

There is no `.rsg` export. The original refuses anything but a version 2 header followed by a
complete world chunk (§3.2), and the port cannot write the per-class records.

### 8.3 The original profile (Unspeakable.cfg) [layout: verified; mapping: port]

Import (`applyOriginalProfile()`, through `originalSettingsToPort()`) takes:
- the three volumes, the turn and pitch sensitivities, and invert pitch;
- subtitles, help text, Checkpoints, Environment FX and controller vibration;
- the Archive pages: bit *i* of set *s* is page *i* of the menu data's Archive Set *s*;
- the "game finished" flag, which gives the Prelude unlock.

A file without the 0x600D trailer is skipped, because the game itself would use its defaults.

The imported file is kept (localStorage `suffering.original-profile.v1`). That holds its key
bindings, speaker setup and the fields the port has no use for (+0x04..+0x0c, flags 0x40 and
0x80).

Export (`portSettingsToOriginal()`) writes the port's options over that kept file. Archive pages
and the "finished" flag are the union of both. The "read successfully" flag 0x200 is cleared,
because the reader sets it, not the file.

Without an imported file, the export starts from the defaults (`0x10007400`) and the RFL's
default key table:
- The table is at `0x10167520`, read from the user's own `Suffering.rfl` through its section
  table (`formats/pe.ts`).
- It has 20-byte records up to action `0xFFFFFFFF` [verified: `0x10006c8b` walks it so]. The
  retail table has 110 records, the first one Pause on Esc.
- The routine that builds the live defaults (`0x10006c80`) also adds controller entries of its
  own, so a profile written from the table alone may lack the pad bindings [inferred]. Importing
  the player's own file first avoids this.

## 9. Browser storage (port)

`src/game/save/store.ts`:
- **Backends.** IndexedDB (`suffering-saves` / `saves`, key `id`), else localStorage
  (`suffering.save.<id>`), else memory. `?storage=localStorage` or `?storage=memory` forces
  one.
- **Memory only.** When only memory works (a private window, blocked site data), the game says
  so once: saves last until the tab closes. Export them to a file before closing it.
- **Failed writes.** A failed write reports why (`lastError`: `quota`, `unavailable`, `failed`).
  A full quota fails that one save, and the store keeps working.
- **Damaged entries.** An entry that is not JSON, not a save, or from a newer version is listed
  as damaged and can be deleted. `delete` reports whether it worked.
- **Persistence.** The first manual save asks the browser to keep the site's storage
  (`navigator.storage.persist`).
- **Several tabs.** Another tab deleting or upgrading the database closes this tab's connection
  (`versionchange`), and the next call opens it again. Every write and delete is announced on a
  BroadcastChannel (`suffering-saves`), so the other tabs' save lists refresh. Ids carry a random
  part, so two tabs saving in the same millisecond do not collide. The autosave slot is shared:
  the last checkpoint taken in any tab wins.

Checks: `node tools/save-matrix.mjs --storage` and `tests/save-files.test.ts` (docs/playthrough.md
"Save matrix").
