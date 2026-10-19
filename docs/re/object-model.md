# Object model: message maps, instance flags, Switch / Detector details

Reverse-engineering notes for the open object-model items of `docs/game-logic.md` §10 (items 1, 2,
4 and 6) and §11.1 / §11.2. Addresses are virtual addresses in `Suffering.rfl` (0x10xxxxxx) or
`SUFFERING.EXE` (0x4xxxxx / 0x5xxxxx). Tags as in game-logic.md: **[verified]** read in the code
and checked against all retail data, **[strong]** code plus consistent data, **[inferred]**,
**[guess]**.

Generated data: `src/formats/message-maps.ts`, written by `tools/re/message_maps.py` (Python +
capstone + pefile; reads the install, writes only slot numbers, message ids and addresses).
`src/formats/entities.ts` merges it into `ClassDef` / `Entity`. Tests:
`tests/re-object-model.test.ts`, `tests/re-object-model-followups.test.ts` (§3 locked feedback,
§7..§10).

## 1. Message maps [verified]

### 1.1 Layout

A class registers its map in its constructor through the engine object's "register message
map" virtual: `mov ecx,[esi+4]; mov edx,[ecx]; push <map>; call [edx+0x34]`. Every constructor in
the chain registers its own map (base constructor first), and every map ends in a record that
points at the parent's map, so the most derived map plus its chain is the whole picture (true for
all 112 classes with a map: no class registers a map that is missing from its last map's chain).

The maps live in `.data` and are **filled by C++ static initialisers** (the pointer table at
RFL 0x10167004..0x101673f4, EXE 0x5b4000..0x5b5080): the file holds mostly -1 and 0. The
generator replays those straight-line initialisers to rebuild the section. A map is an array of
28-byte records:

| Words | Meaning |
|---|---|
| `i32 message, i32 property, handler, 4 words` | `message = -1`, `property = P`: an **input slot**; the handler runs when an arriving message equals the instance's value of property P. |
| same, `property = -1` | a **fixed input**: the handler runs when message `M` arrives, whatever the properties hold. Engine-internal ids (>= 0x1000) appear here too (animation markers, pickups, ...). |
| `-2, -2, 0, 0, 0, -1, parent` | **chain record**: continue with the parent class's map (last word). |
| `-1, -1, ...` | end, no parent. |

(§11 of game-logic.md described the first word as "-1" and the chain as following the first
word; it is the *first word of every record* that is -1, and the chain pointer is the *last word
of the -2 record*.) Every one of the 112 maps parses cleanly, and every property slot found lies
on an Enum-typed (0x11) property of its class.

### 1.2 Finding the class for a map

Class table (RFL 0x10171df8, 369 records; EXE 0x5bb358, 19 records) -> object factory: a compare
tree on the class id (RFL 0x10020000..0x10024000, EXE 0x4df000..0x4e0000) whose cases do
`push size; call alloc (RFL 0x10006400, EXE 0x401000); ...; call ctor`, sometimes through a
shared tail (`jmp`), or install a vtable inline for small objects. Template-only classes
(behaviours, property sets, GUI) go to a stub that returns a shared dummy object (RFL
0x1000b370), so they never receive link messages. Result: **387 of 388 classes resolved**
(only Advanced Material, a material that is never placed, has no factory case); 112 have a map.

### 1.3 Catch-all receivers

vtable slot 10 (+0x28) is the "any message" hook; the default (RFL 0x1001f750) returns 0.
Overrides found:

| Handler | Classes | Behaviour |
|---|---|---|
| 0x100cb7a0 | Instance / Inventory / Visiblity / Health / Insanity Mode / Insanity Meter / Reputation Points Message Filter | test the filter condition (vtable +0x4c), then forward the message to every link |
| 0x100e1e20 | NPC, Unspeakable NPC and the creature classes (not Slayer / Horace / Black One: own handlers) | hand the message to the behaviour stack (the root behaviour's slots decide) |
| 0x101369b0 | Level Transition Msg Handler | the cross-level mailbox (docs/campaign.md §2) |
| own code | Animating Static (fade messages 206..209), Health Threshold Trigger (engine HealthChange 0x2006), Slayer, Horace, Black One | |

### 1.4 Inherited maps worth knowing

| Map | Owner | Slots |
|---|---|---|
| 0x10178110 | GameObject | p13 -> vtable +0x7c (invulnerable on), p14 -> +0x80 (off), p11 -> +0x84 BlowUp (sets vulnerable, applies 1,000,000 damage: 0x100a2620), p12 -> +0x88 Destroy |
| 0x10177fe0 | PhysicalObject | empty, chains to GameObject |
| 0x10178608 | **usable object**: Switch, Light Housing, Ladder, Pushable, Phone, Toilet, Mountable, Security Monitor, Clamber Point, Quest Item Pickup | p28 -> unlock, p29 -> lock (both call vtable +0xd8, which sets state bit 0x8) |
| 0x101786d8 | Item family | fixed 4097 / 4098 (engine pickup events), p50, p51, p52 |
| 0x10178ca0 | Character | p26, p27, p136, p137, fixed 104 (DetachWeaponFX); chains to GameObject |
| 0x10174af0 | Player | p35 plus 42 fixed ids: animation markers (100..121, 200..205 footsteps, 220/221 morph, 230..232 throws, 0x3004 / 0x3005 interaction markers), 6, 15, 92, 94, 400 / 401, 451 |

Consequences the old table missed: Mechanism, Animating Static, Ambient Creature, Black One and
the items chain straight to PhysicalObject / GameObject, so **p28 / p29 are not inputs for them**
(the family names had suggested they were); **Crane's map has no parent**, so it ignores
Destroy / BlowUp; Object Cloner reuses the GameObject map (its p11..p14 are its own
On / Off / Triggered / Destroy, dispatched to its overrides of the same virtuals). Engine classes:
Point / Spot / Directional / Ambient Light p4 / p5, Lighting Effect p2..p4, Portal p5 / p6 plus
fixed 0x1031.

### 1.5 Outputs

`[0x1017bf54]->vt[1](ownHandle, propIndex, sender)` fires an output. The generator collects these
calls (own handle only) in each class's vtable functions and map handlers and two levels of
callees, resolves computed indices (`neg/sbb/add` and `and/or` pairs) and keeps Enum-typed
properties. Two helpers are added by hand: Mechanism 55..58 (a motion group g fires 55 + 2g or
56 + 2g, helper 0x100c8221) and Switch 68 / 69 (fired by the Player's code on the switch, §3).

### 1.6 Link-message coverage

Test: for every message an output slot sends along a link, how does the engine receive it? The
static-scan table only knew "heard by a slot" (81 % overall) and "target slots unknown" (699
messages). With the maps every message resolves:

| Level | old: heard | new: slot + fixed + catch-all | new: dropped by target | new: unknown |
|---|---|---|---|---|
| 0 Prelude Docks | 82.5 % | 86.5 % | 56 | 0 |
| 1a | 85.5 % | 91.8 % | 186 | 0 |
| 1b | 83.6 % | 91.7 % | 89 | 0 |
| 1c | 82.3 % | 77.7 % | 83 | 0 |
| 2 | 76.2 % | 86.4 % | 289 | 0 |
| 3a | 82.3 % | 84.9 % | 288 | 0 |
| 3b | 78.5 % | 88.1 % | 137 | 0 |
| 4a | 79.7 % | 86.1 % | 71 | 0 |
| 4b | 82.5 % | 88.9 % | 87 | 0 |
| 5a | 88.8 % | 96.9 % | 6 | 0 |
| 5b | 88.2 % | 95.5 % | 79 | 0 |
| 6a | 87.0 % | 91.0 % | 64 | 0 |
| 6b | 76.0 % | 86.2 % | 77 | 0 |
| 7 | 64.3 % | 100 % | 0 | 0 |
| 8a | 75.5 % | 81.9 % | 231 | 0 |
| 8b | 80.3 % | 82.4 % | 204 | 0 |
| 9 | 75.2 % | 80.0 % | 198 | 0 |
| 10 | 75.2 % | 76.1 % | 294 | 0 |
| **all** | 13,091 / 16,152 = 81.0 % | 16,032 / 18,471 = 86.8 % | 2,439 | **0** |

(More messages are counted now because the output lists grew, e.g. Character 30 / 31 / 34.)
"Dropped" is designed behaviour, not a gap: an object sends every output to every link, and each
target reacts only to the messages its slots hold (an NPC's Damaged / ISeeYou reaching a Count
Down To Zero that counts Died, a door's 68 = On reaching the relay that waits for 69 =
Triggered). `npx tsx tools/entities.ts <lvl> --validate` prints these numbers per level
(`linkCoverage` in entities.ts).

## 2. Instance flag bits [verified: SUFFERING.EXE instance loader 0x45a5c0]

The loader reads the flag word (0x45a63c) and keeps only derived engine-object bits; the template
flag word (template record +4, `tmpl` below) supplies every value the instance does not override.

| Bit | Meaning | Evidence |
|---|---|---|
| 0x1 | **shown at start**: SetVisible(flags & 1) on the engine object (vtable +0x128, the same call Visibility Toggler makes: 0x101372fc, toggle reads object +8 bit 0) | 0x45a667..0x45a68f |
| 0x8 | **never created** (with `0x10000 << difficulty`, the per-difficulty exclusions). The second Player instance in some levels carries it | 0x45a63f |
| 0x10 | own **draw distance** follows (f32, engine units; retail values are 40000..122880, mostly 40 m = 81920). Without it the template's value is used (template +0x3c bit 0x20000 -> f32 +0x40), else 70.71 x bounding radius x scale, unless template bit 0x10000 makes it unlimited (1e19). The renderer culls with it (0x491990: camera-to-sphere distance against distance + radius) | 0x45a8c3, 0x4584bf, 0x459661 |
| 0x100 | scale follows | 0x45aa37 |
| 0x8000 | own bounds block follows | 0x45abd9 |
| 0x1000 | **override** template bits 0 / 1 with instance bits 0x400 / 0x800 (object +8 bits 0x1000000 / 0x2000000); without 0x1000 the template's bits are used | 0x45a6dd..0x45a74f |
| 0x400, 0x800 | the editor's copies of template flag bits 0 and 1 (0x400 = tmpl bit 0 on 1086 of 1090 instances, the 4 others carry 0x1000; 0x800 = tmpl bit 1 on all 4984). Bit 0 is set on characters (NPCs, Player), bit 1 on static meshes, doors and pushables; the engine tests them in lighting / shadow code (0x4cd81b, 0x4ce716) [guess: dynamic-shadow caster / receiver] | data + loader |
| 0x2000 | override template bits 6 / 10 with instance bits 0x4000 / 0x1000000 (object +8 bits 0x80000 / 0x20000) | 0x45a752 |
| 0x800000 | override template bit 7 with instance bit 0x400000 (object +0x10 bit 0x20) | 0x45a7c7 |
| 0x300000 | when non-zero, replace template bits 8 / 9 (object +0x10 bits 0x8 / 0x10); with them 0x10000000 replaces template bit 0x800 (object +0x10 bit 0x4000) | 0x45a81f |
| 0x2000000 | object +0x10 bit 0x400 | 0x45a80d |
| 0x80, 0x200 | **not read by the loader**. 0x200 only occurs together with 0x80 (22,499 instances); neither matches the baked-lighting ref. Editor-side [inferred] | absence in 0x45a5c0 |

`src/formats/level.ts` now exposes `INSTANCE_FLAGS` and `LevelObject.drawDistance`.

## 3. Switch [verified unless marked]

- **68 / 69 are not about locking.** The Player's use code (0x1003675f) asks the switch for a use
  code (vtable +0xa4, 0x10131c30: 0 usable, 1 locked, 2 busy, 3 not usable). Then:
  - in **first person** (Player state 16, state bit 0x10000 at Player +0xa4) it calls the
    switch's "used" virtual (+0xec, fires **p27**), fires **69** (0x100367f1), and either plays the
    locked feedback (code 1: vtable +0xc8, which plays a sound when p39 is set) or opens it;
  - in **third person** it enters the Interact state (22) and fires **68** (0x100368f6); the
    Interact state code calls the same "used" virtual (0x100352c6).
  Both fire for locked and unlocked switches. Level exits use this: 68 = On -> Timer (waits for
  the walk-through animation) and 69 = Triggered -> a relay that goes straight on (16 switches
  in 1a..9 are wired that way).
- **p23** = the eye-ray test, not "usable at all" (corrected by the chapter 3 playthrough): the
  usable family's can-use 0x100bae80 reads p23 and returns 0 (usable) at once when it is 0; only
  with p23 set does it cast from the player's eye to the object and answer 3 (not usable) when
  that is blocked [verified: `xor esi, esi` ... `cmp [p23], 0; je` -> `mov eax, esi`]. Every
  retail Mountable, most Ladders (1b 82e2, 1c 7c2f), the light switches 7:5, the lockers 7:2250
  and many Security Monitors and Phones have p23 = 0 and are used by the player. **p22** is the
  starting lock state (unlocked), as before; p28 / p29 unlock / lock it. These four belong to the
  usable-object map (§1.4), see §10 for the names.
- **Locked feedback** (vtable +0xc8 = 0x10130030) [verified]: only when p39 is set. It asks the
  switch for its current interaction template (+0xd4 -> +0xa0 = 0x10131290: the one in use when
  an interaction runs, else the first entry of p30 - or of p31 when the switch is open and p34
  is set - that passes the template's own fit test, vtable +0x98) and hands that template's p23
  sound list (start + count) to the sound manager's list-pick call, then plays the result
  attached to the switch (manager +0x9c). No fitting template, no sound. Retail: 230 switches
  that start locked and usable have p39 = 1 (35 in 1a); on every one the open templates of both
  sides carry the same p23 (1a Switch#56dd: 2:395 / 2:396 -> 2:198), one in 4b has none.
- **Key**: when locked and the player owns the p38 template, one is taken from the inventory
  (0x1004ced0 subtracts 1), the switch unlocks for good (vtable +0xd8) and **p51** (sound list)
  plays (0x10131da5).
- **p27** (usable-object output "used", 0x100ba360): 12 retail switches use it, mostly locked
  doors whose p27 = On starts a timer for a rattle sound or remark (1a Switch#56dd -> Timer#7a5d
  -> Sound Effect#7a5a).
- **p36** = starts open: vtable slot 3 (post-create, 0x10132520) snaps the switch open without
  firing outputs (0x10132577). 112 retail switches.
- **p41 / p42 / p43** = auto-close: when it comes to rest open with p41 set, a p42-second timer
  starts (0x1013218a); when it runs out the switch closes unless the player is within p43 m
  (then it retries every 2 s) or an object blocks it (0x10132e73..0x10132f84). 46 switches.
- **p44** (damage reaction, 0x10132bf3): 0 lock, 1 unlock, 2 vtable +0x90.
- **p45 / p46**: open when the Player bumps it while closed / close when bumped while open
  (collision handler 0x10132a95..0x10132b0c) [strong]; no retail switch sets them.
- **State bit 0x4** (+0x46): "player interaction in progress": set and cleared by 0x101320b0
  (called with 1 when an interaction starts, 0 when it ends; also set while a Pushable is held,
  0x100bd62e) and read through vtable +0xe0. Bit 0x2 (vtable +0x100) is "moving", 0x8 unlocked,
  0x40 open, 0x80 a temporary "silent" flag while p36 snaps it open.
- Sound lists: p47..p51 are the five sound lists (type 0x1005), p52 / p53 template lists, p54 a
  template. Only p51 was traced to a call site (above); p47..p50 are read by shared helpers
  [open].

## 4. Detector p3 (`requireCheck`) [verified 0x100a7630, call 0x100a7dc0]

A one-way test. When a new object enters, it is added to the inside list first; if p3 is set the
Detector computes the centre of its box (template box transformed by the object matrix) and the
object's position relative to it, and fires 7 only when that vector points against the volume's
local Z axis (the dot product with matrix row +0x34 is negative). An object entering from the
front is taken in silently (later touches still fire 8, leaving fires 9). 5 retail detectors use
it; for the thin tripwire planes local Z is the plane normal.

## 5. PhysicalObject slot 21 [verified 0x1009b410]

The Destroy virtual (vtable +0x88) of PhysicalObject and the items: if health is above 0 it fires
**p21** to the links and then removes the object (0x100cb870); breaking calls the same path. So
p21 is "on destroyed" (broken or Destroy message), not only "on broken". 28 classes use this
virtual (`ClassDef.destroyOutput`).

## 6. Port

Implemented (src/game/world/logic.ts, world.ts):

- `World.useSwitch`: no p23 gate (above; the use picker neither, interact.ts `usable`), 68 then p27 on every use, no 69 (the port
  has no first-person use; firing both made level exits skip their timer), keys are spent and
  unlock the switch for good.
- `World.lockedFeedback`: a locked use with p39 set plays the p23 list of the switch's
  interaction template (p30, or p31 when open and p34 is set) at the switch (`playSound` with
  `effect: true`, no lip-sync). The fit test is replaced by "stand spot nearest to the player"
  (p15 sideways / p17 forward in the switch's frame) [inferred]; it cannot change the retail
  result because both sides of every such door share the sound. Checked in 1a (Switch#56dd plays
  2:198; tests/re-object-model-followups.test.ts and a browser run).
- Switch p36 starts open; p41 / p42 / p43 auto-close.
- Detector p3 one-way test (`behindVolume`).
- Destroy on a class with `destroyOutput` fires p21 first.
- Animating Static attachment sets (§7), Ring Damage and the Killjoy Rebirth Effect (§8), the
  Sound Effect / BouncingObject AI noises (§9), the usable-object property names (§10).

Proposed for files owned by other systems:

- **Draw distance** (props / visibility / prop batching): cull a placed object beyond
  `LevelObject.drawDistance / 2048` m, else the template's distance (template +0x3c bit 0x20000,
  f32 +0x40), else 70.71 x bounding radius x scale, unless template bit 0x10000 (never).

## 7. Animating Static attachment sets: SpawnAttachments (154) [verified unless marked]

The Animating Static constructor (0x100933a0) builds an attachment set at object +0x6e (the
same helper family the Slayer body parts use, 0x10095d10) over two property pairs: p49 / p50
(index list, template list: objects to spawn) and p51 / p52 (index list, link list: placed objects
to attach), with p53 as the "do it at creation" flag. Map 0x10177d20:

- **p45** (input slot) and the **fixed message 154 SpawnAttachments** share one handler
  (0x10093290). It walks the p49 / p50 pairs up to the shorter list and spawns template p50[i] at
  index p49[i] of the object's model (0x10095e80), attached there. A pair is skipped when either
  value is unset (-1), when the index is not below the model's count (model +0x10c), or when that
  slot already holds an object - so repeating the message does not stack copies.
- **p46** (input slot, 0x100932b0 -> 0x10096ba0) destroys every object of the set.
- **p53** set: at creation the set spawns p49 / p50 and links p51 / p52 (0x10096400, set flag 0x4).
  p47 / p48 are unrelated (they toggle the object's own animation state words).
- The index is a **bone** of the carrier's model, not a hardpoint channel [strong: the projector
  model 7:178 has 2 channels but its p49 is 5, the lamp model 7:744 has 3 and uses 7, the caged
  CartWheeler head entries name bone 18 like Character p187].
- **One mechanism with the Characters' lists.** The set object (0x10095d10) holds four
  (index list, template list) pairs and two flags; 0x10096400 spawns pair A when flag 0x2 is
  set, pairs B (spawned) and C (linked, 0x10096010) when flag 0x4 is set, and pair D with flag
  0x4 on its first call only; each pair goes through 0x10096220 -> 0x10095e80 (spawn the
  template, whatever its class, attached to the bone). The Animating Static constructor
  (0x10093419) passes A = none, B = p49 / p50, C = p51 / p52, flag 0x4 = p53; the Character
  constructor (0x100e52c6) passes A = p51 / p52 (hand weapons, flag 0x2 = p53), B = p54 / p55
  (body parts, flag 0x4 = p56), C = none, D = p57 / p58 [verified]. A Character's set is
  spawned from its update (0x100e1f50) once some state allows it; other paths that equip a
  Character's weapons were not traced (the port wears p51 / p52 / p54 / p55 regardless of the
  flags: many retail Characters have p53 / p56 = 0 but are seen holding their guns).

Retail: 12 projector Animating Statics in 5b (template 7:331, model 7:178, p53 = 0) are sent 154
by relays; their pair is bone 5 + Object Generator 3:2158 (a flickering Point Light, a lamp-glow
generator 3:2344 that re-throws three Billboards of texture 3:257 every 0.1..0.15 s, and a hum
Sound Effect); two more 5b projectors carry the pair without a relay to them, and one projector
each in 1a / 1b / 1c / 2 / 3b / 9 carries it too (their senders were not surveyed). p53 = 1 sets
(instance values, all levels): lamp Point Lights on bone 7 (7:357 / 7:526 / 7:347; 1b, 2, 3a,
3b, 4a, 4b, 5a, 5b, 8a, 8b, 9 - about 110; their p45 = 1 On / p46 = 2 Off spawn / remove the
light), the Slayer-head TargetableBreakable 10:965 on bone 18 of the caged CartWheelers
(10:635, model 10:2; 7 in 1a, 4 in 2), dead guards (10:604, model 10:22) with caps (Attachment
10:1729 / 10:1730 on bone 54 / 27; 1b, 8a) and guns (4:260 / 4:5 on bone 35; 8a), six Breakables
7:150 on the 2 Cellblocks body 10:978, and p51 / p52 links of placed NPC bodies (Unspeakable NPC
uids) to bone 6 / 7 of the rope models 7:308 / 7:661 (1b, 2, 3b, 4a, 4b; earlier notes said no
retail object used p51 / p52 - the survey had read templates only).

Port (src/game/fx/attachments.ts, billboards.ts, weapons/npc.ts; wired in fx/system.ts): the
154 / p45 / p46 path and the p53 creation path on skinned Animating Statics (the actors'
decoration actors give the bone; a creation set waits until its carrier's bones resolve). One
pair resolver (`attachmentPairs`) and one worn-class set (`WORN_CLASSES`: TargetableBreakable,
Attachment, Ranged / Melee Weapon) for both families: worn models are built by weapons/npc.ts
on the bone (Characters' p51 / p52 / p54 / p55 and Animating Statics' p49 / p50), so the
caged CartWheelers' heads come from there and nothing is spawned twice (attachments.ts only
records them, so a later 154 skips their slot). Point Lights are attached lights fed to the
engine lighting rig at the bone (colour p0 / p1, radius p8, hemisphere p9 as world/lights.ts).
Everything else spawns its template through the world FX runtime at a matrix that follows the
bone every frame; mode-1 generators it starts are owned by the attachment and are stopped when
p46 arrives or the carrier is destroyed or dies (projectors breaking). Fires thrown by such a
generator follow the matrix too (`followMatrices`). Spawned Billboards were not drawn before;
`SpawnedBillboards` draws them [inferred: p4 = life of a spawned one (0.1 s on the projector
glows), size p2..p3 by distance up to p9 as for placed ones]. Not ported: p51 / p52 links,
worn models spawned by a later 154 (no retail case), Breakables as worn models (7:150 here,
10:144 on the Character "Slayer"; purpose unverified), the caged heads being breakable (they
are drawn only), Lighting Effect flicker on attached lights (none in retail).

## 8. Ring Damage, Killjoy Rebirth Effect, DestroyRebirthFX (105) [verified unless marked]

**DestroyRebirthFX** (Player map, fixed 105 -> 0x100280d0): the Player keeps the handle of one
Killjoy Rebirth Effect (Player +0x786); 105 destroys that object if it still exists and clears
the handle. Senders: one relay in 5b (Relay#3284, reached from an NPC's Damaged and from a
one-shot Detector) and one in 10 (Relay#12ca).

**Ring Damage** (class 0x08cc221b, vtable 0x1014d898): spawned by generator 3:4515 (placed in 5b
and 10, started by timers / relays). It only tests the player. At age t it covers the
horizontal band from p0 + p3 t to p1 + p4 t (m) around its spawn point and heights from its own
up to p2 m above (0x10128ba0, run at creation and every frame); it disappears after p5 s
(0x10128de0) or at its first hit. A hit (0x101289f0) sends a damage message of p6 points, type
p10, and spawns the victim effect p7 with the player as its target. Retail 3:4555: 0.1 m wide,
growing 0.66 m/s for 3.5 s, 0.5 m tall, 0 damage, type 17, effect 4:1325.

**Killjoy Rebirth Effect** (class 0x37faf5d5, vtable 0x10154000): its post-create (slot 3,
0x1008b3a0) accepts only the player as target. If the player already holds a live one, that one
is refreshed and the new one goes away. Otherwise (unless two player state bits say the player
cannot take it) it registers itself in Player +0x786, sends the player an engine message (0x160),
puts his weapons away and refreshes (below). Refresh (0x1008af30): give item p19 until the
player has p18 of it (0x10039b10); if he had none before, spawn p20 and attach it to his model
index p21 (0x1008ac90). The destructor (0x1008ad80) removes every p19 item (0x1004cf60 =
subtract all), destroys what sits at index p21, takes the weapons out again and sends a second
engine message (0x161). Refresh runs only at take-hold and when another effect reaches the
player (the 5b / 10 rings keep coming): it is a top-up, not a continuous refill. Retail
4:1325: 8 x Missile Item 4:804 (a grenade variant with its own HUD meter 5:646 and thrown object
4:806), p20 = fire generator 4:896 (Fire 4:897), index 35 (the right-hand weapon bone of rig
2:9). Earlier notes called it "a BurnFX on the player"; it is the burning-hand state that
supplies those grenades until the level script ends it with 105.

Taking hold (post-create 0x1008b3a0, not deferred): the Player puts his held weapons away
(0x10038a50: their handles kept in +0x770 / count +0x774) and empties his throwing hand
(0x10038620: the object on bone Player p119 = 51 removed, its item kept in +0x77c), then the
effect refreshes. Refresh: held = count of p19 (0x1004cd80, per template); give p18 - held when
positive (0x10039b10); held = 0 -> 0x1008ac90. Giving a throwable while the throwing hand is
empty puts it there (0x10039b10 -> 0x10038ca0: its thrown object p55 on bone p119), so the
rebirth grenades become the selected throwable. The destructor (only for a registered effect)
then takes every p19 (0x1004cf60), clears +0x786, destroys the p21 attachment, removes what is
on bone p119 and takes the weapons (0x10039840 from +0x770) and the old throwable (0x100392d0
from +0x77c) out again [verified]. With player state bit 0x100000 set the take-hold part is
deferred to the effect's update (0x1008b130, flag 0x10); bit 0x80000 without 0x100000 rejects
the effect [verified for the bits, unknown meaning].

Port (src/game/fx/rebirth.ts): Ring Damage as above (player feet + 1.8 m body), the
one-per-player rule with refresh, p20 on bone p21 of the visible player body (arms first)
following it, and DestroyRebirthFX through a world subscription on the player. The item grant
goes through the template-keyed inventory (world/inventory.ts; 4:804 and 4:655 share the
name string 4:47 but are separate entries): each refresh tops the player up to p18 of p19
through the weapons system's routing (services.weapons.give), the destructor takes every p19;
weapons stow() / unstow() put the weapons and the throwable away / back. The rebirth grenade's
4:806 detonation 4:893 throws two Radius Damages (4:805: 21 / 21 over 3.75 m, type 17; 4:1439:
0 damage, victim effect 4:1327); the port applies every one (it used to keep the last, i.e. no
damage). Not ported: the deferral / rejection bits, the effect surviving a save. Checked in a
browser run in 5b (ring -> effect on, 8 x 4:804 next to the regular grenades, weapon put
away; 105 -> grenades gone, effect and its generator gone, weapon back).

## 9. AI noises of Sound Effect p8 and BouncingObject p64; bounce sounds [verified]

Both are InvestigateSound templates handed to the noise list (0x100e2e60) with no source:

- **Sound Effect** (play function 0x1012c9a0): when a sound actually starts and the play mode p3
  is 0, a noise p8 at the object (0x1012cb5a).
- **BouncingObject** (bounce code in 0x1009a8c0): when a bounce plays its sound, a noise p64 at
  the object (0x1009ad02).

No retail Sound Effect (template or instance override) sets p8 and no BouncingObject template
sets p64, so neither ever fires in the shipped game.

**Bounces** (0x1009a8c0). Every hit increments the bounce count (+0xba). When p49 > 0 and the
count reaches it: with p50 set, or when the hit normal is within 45 degrees of up (dot with
(0, 1, 0) > 0.7071), the object settles (its remaining life set to p54 s; no sound); otherwise
the count is decremented and it bounces on. A bounce that does not settle picks its sound list
from the surface's **Game Material Properties** (the material template's word 0; collision
record +0x34): **p63 when GMP p2 (hardness: 0.3 / 0.5 / 0.7 / 1) >= p56, else p62** (also with
no surface record). The list goes to the sound system (0x10019f60, the engine picks; duplicates
in the list weigh), played at the object with p65 [unknown: 6 on most, 1 on the shotgun shell];
when a sound comes back the p64 noise is made and the voice volume is scaled by k^(count - 1),
k = (1 - GMP p4 %) x (1 - p51 %) (GMP p4: 0 or 50). Retail sound lists: the casings (revolver
4:64 / tommy gun 4:258: 4:32, 4:50, 4:51 on both lists; shotgun shell 4:87: p63 4:209 / 4:210
only, so soft floors are silent), 4:349, 7:2079, 7:2119. **No throwable has bounce sounds**
(4:621, 4:806, the Molotov, TNT, Flash/Bang, flare objects: p62 / p63 empty).

Port: `WorldHooks.noise` (logic.ts playSoundEffect -> world.ts -> `services.actors.noise`);
weapons/system.ts runs thrown objects and spent casings (the weapon's p86 generator object) as
BouncingObjects: count / settle rule and sound selection as above (weapons/data.ts `bounceHit`,
`bounceSound`; the GMP comes from fx/surfaces.ts), the p64 noise only with a sound, casings gone
p54 s after settling (or after p12). The actors service has no "no source" value; these noises
go out with its default source.

## 10. Usable-object property names

`src/formats/entities.ts` names p22 `unlocked`, p23 `usable`, p28 `inUnlock`, p29 `inLock` on the
classes whose map chain holds the usable-object map 0x10178608 (`USABLE_OBJECT_CLASSES`: Switch,
Light Housing, Ladder, Pushable, Phone, Toilet, Mountable, Security Monitor, Clamber Point, Quest
Item Pickup). The old family-wide names (`usable` for p22, `inEnableUse` / `inDisableUse`) are
gone: other PhysicalObjects use these indices for other things (Animating Static p23 is an
animation list, the items' p22 is their name string).
