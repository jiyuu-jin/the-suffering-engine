# The Suffering: game logic reference

This document covers the object and class system, entity properties, the message (event) system,
STOMP sequences, and what has been decoded for a first playable slice of level 1a.

The code is in `src/formats/entities.ts` (parser), `src/formats/entity-classes.ts` (generated class
table) and `tools/entities.ts` (CLI). Every statement below is labeled with one of these confidence tags:

- **[verified]** checked against every retail file, or against the code
- **[strong]** consistent data plus code evidence
- **[guess]**

---

## 1. Where the game logic lives

| File | Role |
|---|---|
| `SUFFERING.EXE` | Riot Engine runtime. It holds the engine classes (materials, lights, portals, reverb, "Engine Properties") and the message dispatcher. It loads the game module through `Suffering.gdf` (`RFL1=Suffering.rfl`). |
| `Suffering.rfl` | A PE DLL (1.7 MB) that holds **all game classes**: 369 classes, from NPCs, items and doors to triggers, GUI and behaviors. Exports: `RiotDllGetID`, `RiotDllType`, `GetBaseRFLInterface`, `GetObjTypeInterface`, `GetObjectDefInterface`, `GetMessageInterface`, `IsObjectStatic`, `IsObjectMoveNode`. |
| `SSAPI/SSSCC/SSUS/SSVB.DLL`, `__support/scriptinterpreter.exe` | Not game logic. These are installer and runtime support libraries (the scriptinterpreter is Inno Setup). The game does not import them. **There is no script language.** |
| `*.qdu` | STOMP sequences: keyframed scripted scenes and cutscenes that drive level objects by uid (§7). |
| `Suffering.gdf` | Build configuration. It references `Classes\Unspeakable.rcdx`, the editor class-definition file with property names. That file was **not shipped**, so property names are not recoverable from data (§4.3). |

The game is data-driven. A level is a set of placed objects, wired together by **links** and
**messages**. Behavior comes from the C++ classes in the RFL, configured by template and instance
properties. Logic objects such as Detector, Timer, Message Relay, Count Down To Zero and Switch
form an event graph. This replaces scripting.

## 2. Class system

### 2.1 Class ids [verified]

The u32 that `model.ts` calls the "class hash" is a **class id**: an arbitrary 32-bit constant.
It is not a hash of the class name. CRC32, FNV, djb2, sdbm, ELF and x31 were tried on every
string in the binaries, with no match. The ids sit as constants in the class descriptor tables:

- **RFL table** at VA `0x10171df8`: 369 records of 28 bytes, sorted by id.
- **EXE table** near VA `0x5bb4a8`: same record layout, 19 engine classes.

Each record holds:

| Field | Meaning |
|---|---|
| `u32 classId` | The class id. |
| `u32 category` | Index into the category table at RFL `0x10174978`, for example 3 Player, 4 System, 7 Ground Enemy, 8 Ground Object, 10 Item, 14 Light Source, 17 Behavior, 20 Material. |
| `u32 flags` | Unknown. |
| `char* name` | The class name. |
| `u32 propertyCount` | Number of properties. |
| `u32 groupCount` | Number of property groups. |
| `ptr groups` | Points to `groupCount` pointers. Each one points to `{u32 n, u32* typeCodes}`. |

The groups, flattened in order, give one type code per property, and the property index is the
position in that list. **Group pointers are shared between classes.** A shared group prefix is
a C++ base class (§4.1).

`entity-classes.ts` contains all 388 classes: id, name, category, flags, grouped type codes, the
statically found message slots, and the family. **Every one of the 13,586 retail templates and
every placed object in all 18 levels resolves to a class.** All templates decode to exactly their
word count.

The material ids that `model.ts` already uses map to these names:

| Id | Class |
|---|---|
| `0xad99e79b` | Simple Material |
| `0x7e3ad512` | Advanced Material |
| `0x03656e9f` | Layered Material |
| `0xb13556e7` | Landscape Material |
| `0xd58d8e2c` | Animating Material |

Useful gameplay ids:

| Id | Class |
|---|---|
| `0xc8bc44e1` | Player |
| `0x56ca8ad4` | Player Spawn Point |
| `0x10bd8382` | Level Transition |
| `0x3f0d4eb2` | Detector |
| `0xca9f664a` | Timer |
| `0xd44b5953` | Message Relay |
| `0x10c956b7` | Count Down To Zero |
| `0x3f4c759c` | Switch (doors, levers, buttons) |
| `0x1589a3e3` | Mechanism (movers) |
| `0x202383e5` | Ammo Box (generic pickup) |
| `0x19f64171` | Health Bonus Item |
| `0xbe08b1a0` | Object Generator |
| `0x38acc9a1` | STOMP Player |
| `0x4286a498` | Edge Passage |
| `0x08a4de62` | Autosave |
| `0xed6b2ff8` | Sound Effect |
| `0x5b0bad74` | Portal |

The audio code's `CLASS_ZONE 0x86a01249` is **Animating Static**, which is not a zone class.
`0xcd739b63` is Combat Music, `0xe6ec6c84` is **Ambient Sound** (a crossfade zone, §17.4), and
`0xbd83621b` is **Flying Sound** (§17.4). Run
`npx tsx tools/entities.ts --classes` for the full list.

### 2.2 Templates (.odu type 2, group 1) [verified]

| Offset | Content |
|---|---|
| `+0` | Model ref (u16 id, u16 pkg). 0:0 means no model. |
| `+4` | u32 flags |
| `+8` | u32 |
| `+12` | u16 hasBounds |
| `+14` | If hasBounds: 64-byte bounds block (below). |
| next | u32 classId, u16 ?, u32 propCount, u32 wordCount, then wordCount u32 words |

The bounds block is 16 f32 values, in model units in template space:

| Floats | Content |
|---|---|
| 0–2 | Bounding sphere centre |
| 3 | Bounding sphere radius |
| 4–6 | Oriented-box corner |
| 7–9 | Box edge vector X |
| 10–12 | Box edge vector Y |
| 13–15 | Box edge vector Z |

The trigger-volume templates (Detector, Portal, Volumetric Fog) are the unit cube
`(-0.5,-0.5,-0.5) + I`, so **the volume size comes from the instance scale** (§5).
Instances with `flags & 0x8000` carry their own 64-byte block of the same layout.

The template words are one word per property, in type-list order. A **list** property holds
`count << 16 | wordOffset`, which points at its items later in the same word array. 0 means an
empty list. This matches the audio agent's `parseObjectTemplate`/`resolveObjectProperties`;
`entities.ts` reuses `parseObjectTemplate`.

### 2.3 Instance overrides [verified]

A `LevelObject` has `propIndices[k]`, a property index, and `propWords[k]`, its value. A list
override points into the instance's own `propWords` with the same `count << 16 | offset` encoding,
for example a Sound Effect with `0x00010005` followed by the sound ref at word 5. The effective
value is the instance override if present, otherwise the template word.

## 3. Property types [verified for the base type, guess for the qualifiers]

The low byte is the base type. `0x1000` means list. `0x2000` and `0x4000` are qualifiers on
references, probably a class filter or editor hint. They do not change decoding.

| Code | Type | Value |
|---|---|---|
| 0x01 | int | u32 |
| 0x02 | float | f32 |
| 0x03 | template | ref → .odu type 2 (any class) |
| 0x04 | model | ref → .mdu |
| 0x05 | sound | ref → .sdu |
| 0x07 | bool / small enum | 0/1, sometimes 2–3 |
| 0x08 | signed int | -1 = unset |
| 0x09 | animation | ref → .adu |
| 0x0a | string | ref → .xdu (u16 byte length + UTF-16LE) |
| 0x0b | STOMP sequence | ref → .qdu type 0x11 |
| 0x0e | texture | ref → .tdu type 0x40 (the Simple Material texture word is `+32`, matching model.ts) |
| 0x0f | color | 0xAARRGGBB |
| 0x10 | video | ref → .vdu |
| 0x11 | enum **or message id** | u32 (§6) |
| 0x12 | waveform | ref → .wdu (curves / rumble) |
| 0x13 | object link | level-object **uid** |
| 0x14 | font | ref → .fdu |

A ref word is `pkg << 16 | id`, using the `.db` package ids that model.ts already uses.

## 4. Gameplay classes and their properties

### 4.1 Base-class families [verified by shared group pointers]

| Family | Properties | Classes |
|---|---|---|
| **GameObject** | 0–15 | Every damageable actor or prop |
| **PhysicalObject** | 0–21 | Breakable, Switch, Mechanism, Pushable, Ladder, Light Housing, Security Monitor, Phone, Crane, … |
| **Item** | 0–54 | Ammo Box, Health Bonus Item, Item, Key, Map Pack, Flashlight, Melee/Ranged Weapon, Missile Item, Insanity Attack Item, Family Picture, Map Item |
| **Character** | 0–24 | Player, NPC, Unspeakable NPC, Hermes, Rat, Mainliner, Burrower, Nooseman, Killjoy, Slayer, CartWheeler, Fester, Horace, Inferna |

GameObject properties:

| Index | Name | Default |
|---|---|---|
| 0 | `health` (f32) | 100 |
| 1 | `maxHealth` (f32) | 100 |
| 7 | `attachments` (template list) | |
| 11 | input `inBlowUp` | BlowUp |
| 12 | input `inDestroy` | Destroy |
| 13 | input `inInvulnerableOn` | InvulnerabilityOn |
| 14 | input `inInvulnerableOff` | InvulnerabilityOff |
| 15 | output | |

Slot 15 is sent by Breakable, Mechanism, Switch and the NPCs. NPC templates set it to "Damaged", so
it is named `outOnDamaged` [strong]. Unspeakable NPC sends `p28`, which is set to "Died"
(`outOnDeath`). PhysicalObject adds slot 21, an output with unknown meaning.

### 4.2 Classes needed for 1a (names in `entities.ts`)

Each entry gives the class, then its properties: name, type, meaning, confidence.

**Player Spawn Point** [verified]
- `0 fromLevel` (string): path of the level the player arrives from, for example `Levels\0 Prelude Docks\0 Prelude Docks.lvl`.
- `1 spawnName` (string): "West Spawn" and similar.
- `2 active` (bool).
- `6`: a template.
- To use: when you enter level L from level P with spawn name N, pick the spawn point where `fromLevel == P` and `spawnName == N`. If none matches, use the `Player` object's own position, which is the new-game start.

**Level Transition** [verified for 0, 1, 3, 6, 10–12; see `docs/campaign.md` §1]
- `0 targetLevel` (string path).
- `1 targetSpawnNames` (string list).
- `3 chapter`: Chapter Properties (title + loading screen; forward-only, `docs/campaign.md` §3).
- `7`: list of uids, likely objects carried over.
- `6`: 1 = enabled at start (0 on 1c → 2, 2 → 1c, 9 → 10, 10 → 9).
- `10 inTransition` (default On), `11` enable, `12` disable (the class table's `inEnable`
  name on 12 is wrong).
- It has no volume. Other logic sends it a message: in 1a, a Detector for the exit to 3a, and a Switch → Timer → Relay chain for the door to 1b.

**Player** (`0xc8bc44e1`, template 2:5, model 2:9) [verified]
- 358 properties: movement, combat and camera tuning.
- **Note for level.ts:** `PLAYER_TEMPLATE = {id:6, pkg:2}` is the **Camera** class, not the Player. The Player is template **2:5**. Both exist once per level, but they are in different places. In 1a the Camera is at (437, 97.7, 537) and the Player at (399, 97.7, 516), which matches the "West Spawn" coming from 0 Prelude Docks. The fix is to match the class id `0xc8bc44e1` (or template 2:5).
- Some levels have a second Player instance with `flags & 0x8`, possibly a disabled or editor copy. Use the first instance without bit 0x8 [guess].

**Detector** (trigger volume) [strong; see §11.2 for the decoded touch logic]
- Volume: template unit cube × instance scale, in model units, rotated like any instance. Typical sizes are 19×6×1 (tripwire planes) to 6×3×1.
- `0 startEnabled` (default 1).
- `1 detectFilter` (enum → table `[1,1,1,0,1,0,0]` of who counts; 0 = default) [guess on meaning].
- `2 destroyAfterTrigger` (default 1, one-shot).
- `3 requireCheck` (bool, extra test before firing) [guess].
- Inputs: `4 inEnable` (Enable), `5 inDisable` (Disable), `6 inDestroy` (Destroy).
- Outputs: `7 outOnEnter` (default On), `8 outOnEnterAgain`, `9 outOnExit`. Code sends 7 on the first object entering, 8 on later entries, and 9 when an object leaves [strong on 7 and 9].

**Timer** [verified from code]
- `0 autoStart`, `1 enabled`, `2 delay` (s), `3 delayRandom` (±), `4 loop`, `5 destroyAfterFire` (default 1).
- Inputs: `6 inStart` (On), `7 inStop`, `8 inEnable`, `9 inDisable`, `10 inDestroy`.
- Output: `11 outOnFire`.
- The sender that started the timer is kept and passed along when the timer fires.
- [verified: init 0x10133a30, think 0x10133a90, inStart 0x10133b50] The countdown (p2 ± p3) is
  drawn at init and again after each firing; `inStart` only makes the timer count (when
  enabled) and keeps the sender: a Start on a running timer does not restart it, and `inStop`
  pauses it. On firing, p5 destroys it, else without p4 it stops.

**Message Relay** [strong]
- `0 enabled`, `1 count` (int; ≤0 means unlimited).
- Inputs: `4 inRelay`, `5 inEnable`, `6 inDisable`, `7 inDestroy` [verified: message map 0x10178980, slot 5 sets the enabled flag (0x100cb880), slot 6 clears it; the data agrees: disabled relays set p5 = Enable, p6 = Disable].
- Output: `8 outRelay` (the message forwarded to the links).
- Message Relay is the most common logic object (367 in 1a). Treat it as "on receiving X, send Y to all links".

**Count Down To Zero** [verified]
- `0 count`, `1 destroyAtZero` (actually "on zero: destroy self"), `2` (on zero: alternative action).
- Inputs: `3 inIncrement`, `4 inDecrement`, `5 inReset` (count = p0).
- Output: `6 outOnZero`, sent when the counter reaches 0 after a decrement.

**Visibility Toggler** [strong]
- `0 startHidden`.
- Inputs: `1 inShow` (On), `2 inHide` (Off), `3 inToggle`.
- Acts on its links.

**Switch: doors, levers, buttons** (70 properties, PhysicalObject family) [strong for doors; §11.1 supersedes the guesses below]
- In 1a, all 121 doors and levers are Switch instances with a door model, for example template 9:3496 with model 9:1997.
- `57/58`: angles. The values come in pairs such as 265/-270 [guess: open/closed yaw].
- `61 inActivate` (On), `62 inDeactivate` (Off).
- `63–69`: further enums, likely lock and unlock (5/4 = Disable/Enable) [guess].
- A door usually **links to a Portal**, the visibility portal toggled with the door.
- **Edge Passage** (AI navigation) records each doorway: `1 door` (Switch uid), `2 nodeA`, `3 nodeB` (Move Node uids). In every case checked, the door sits halfway between the two nodes, which are about 1.2 units apart on either side.

**Mechanism**: movers and elevators. Properties 22–53 are motion parameters, for example a 120° rotation. Inputs 55–66, sound lists from 67 [guess on layout].

**Item family: pickups** [strong]
- `22 pickupName` (string, for example "Revolver Ammo 24", "Shiv", "Flashlight").
- `24 inventoryFullText` (the "ammo full" pickup message).
- `28 animation`, `29 inventoryModel`, `46–49` sounds (`48 pickupSound`).
- `53/54`: outputs sent on pickup.
- **Ammo Box** is the generic "give item" pickup: `55 itemTemplate` (the item, weapon or ammo class granted, such as Melee Weapon for the Shiv, Missile Item for revolver ammo, Flashlight) and `56 amount` (24 rounds, 2 batteries, …).
- **Health Bonus Item**: `55 healAmount` (f32, for example 20 for the Xombium Bottle).

**Object Generator** (spawner) [strong]
- `0 spawnTemplates` (template list; in 1a mostly Particle Fountains, used as FX spawners).
- Run rules [verified, §14.2 Object Generator]: `21 runTime`, `22 runs`, `24 startOn`, `7` / `8` interval, `28..30` player range.
- Inputs: `31 inDestroy`, `32 inStart` (On), `33 inStop` (Off), `34 inToggle`, `35 inPrefetch`.
- Enemies in 1a are mostly placed directly (69 Unspeakable NPC) and woken by Behavior Changers.

**Behavior Changer**
- Points at NPCs (`6`, link) and gives them behavior templates (`8`, list).
- AI behaviors are their own classes ("WaypointBehavior", "KillEnemiesBehavior", "IdleBehavior", …), configured as templates in NPCs.odu (pkg 10).

**STOMP Player** [verified]
- `0 sequence` (.qdu ref).
- Inputs: `4 inPrefetch` (Prefetch), `5 inPlay` (On), `6 inDestroy`.
- Output: `7 outOnFinished`.
- The sequence's first track names the object it drives (§7).

**Other classes**
- **Sound Effect**: `0 sounds`, `3 playMode`, `6 interval` / `7 jitter` (re-trigger, not a radius), `9 positionMode`, `10 attachTo` (uid), `12 stopFade`, `13 fadeIn`, `14 inPlay`, `15 inStop`, `17 inDestroy`, `18 outOnFinished` (docs/re/audio.md §12).
- **Help Popup**: `8 text`, `9 inShow`.
- **Movie Player**: `0 video`, `10 inPlay`, `14 outOnFinished`.
- **Autosave**: `0 inSave` (On).

**Lights** (EXE classes)
- Point, Spot, Directional and Ambient Light share the start `0 color` (0xAARRGGBB), `1 enabled`, `3 lightingTemplate`. Point Light also has `8 radius`.
- Lights receive On/Off from relays. They are toggled through Light Housing and Lighting Effect.

### 4.3 Property names

Real names are not available, because `Unspeakable.rcdx` is missing. Unnamed properties are
called `p<index>`. Names are given only where code or data supports them, and the confidence
tags above apply. The `in`/`out` prefixes are used only for message slots.

### 4.4 Weapons, ammo and throwables [code = read in Suffering.rfl; data = all retail templates compared]

Chapter 1 pickups (Ammo Box `p55` item, `p56` amount): Shiv (Melee Weapon 4:79), Revolver (Ranged
Weapon 4:5; a second one gives Dual Revolvers 4:12 through `p67`), Shotgun 4:84 (1a), Tommy Gun
4:260 (1b, 1c), Gonzogun 4:826 (1b, one secret box); ammo Missile Items 4:230 revolver (24 / 48
rounds), 4:231 shells (28), 4:255 tommy gun (96 / 192); throwables Flash/Bang 4:284, Molotov 4:249,
Shrapnel Grenade 4:655, TNT 4:236, Flare 4:455; also Gas Can 4:517 (flamethrower fuel), flashlight
batteries 4:203, Xombium (Health Bonus Item).

**Item family** (all of them): `p37` slot (1 melee, 2 pistols, 3 shotgun, 4 tommy gun,
5 flamethrower, 6 throwables, 9 flare), `p38` cycle order (shiv 1, axe 2, revolver 3, dual 4,
tommy 5, shotgun 6, flamethrower 7, gonzo 8, flare 11, flash/bang 12, TNT 13, molotov 14,
shrapnel 15), `p44` maximum carried (ammo items: 200 revolver / tommy rounds, 40 shells, 300 fuel;
throwables 8) [data].

**Ranged Weapon** (fire routine RFL 0x10127b30 [code] unless marked):

| p | Meaning | Revolver | Shotgun | Tommy gun |
|---|---|---|---|---|
| 64 | Adrenaline Template | 2:528 | 2:530 | 2:529 |
| 65 / 66 | Player Weapon Properties (clips, hand bones) / second hand set | 2:436 | 2:244 | 2:475 |
| 67 | weapon given by a second pickup [data] | Dual Revolvers | - | - |
| 68 | ammo item | 4:230 | 4:231 | 4:255 |
| 69 | clip size [data] | 6 | 7 | 48 |
| 70 | rounds in a picked-up weapon [data] | 6 | 21 | 48 |
| 71 | automatic [data] | 0 | 0 | 1 |
| 75 | spread, degrees (random cone around the aim) | 0.25 | 0.25 | 3 |
| 76 | aim-assist cone, degrees (cos test against targets) | 45 | 45 | 45 |
| 77 / 87 | fire / reload clip of the weapon model's own rig | 4:6 / 4:9 | 4:5 / - | 4:15 / 4:17 |
| 78 / 80 / 88 | projectile / muzzle-flash / casing bone of the weapon model | 11 / 11 / 0 | 3 / 3 / 2 | 1 / 1 / 0 |
| 79 | fire sounds (all played) | 4:206, 4:198 | 4:205, 4:41 | 4:119, 4:200 |
| 81 | projectile generator (Object Generator: `p0` Missile, `p2` per shot) | 4:8 (1 x 4:6) | 4:86 (6 x 4:85) | 4:257 (1 x 4:256) |
| 82 | extra generator at the muzzle (smoke) | - | 4:879 | - |
| 83 | Muzzle Flash (`p0` card models, `p1` seconds) | 4:963 (0.12 s) | 4:877 | 4:861 |
| 85 | fire from the muzzle bone (else the eye) | 1 | 1 | 1 |
| 86 | casing generator (BouncingObject) | 4:71 | 4:88 | 4:259 |
| 89 | HUD Ammo Meter (`p23` HUD Texture = weapon icon in atlas 5:222) | 5:102 | 5:164 | 5:118 |

**Missile** (impact routine RFL 0x100d1450 [code]): `p1` speed in engine units / s (200000 =
98 m/s for all three guns); distance travelled is accumulated; damage = `p28` up to `p30` model
units, `p29` from `p31` units on, linear between (revolver 6 flat, tommy gun 5 flat, shotgun
pellet 20 at <= 4 m falling to 2 at 20 m); `p32` damage type (1 bullets, 13 shotgun);
`p26` impact force [guess]; `p40` Missile Tracer (width 0.025, length 0.15); `p41` per-material
Missile Material Effects (`p0` Material Type, `p1` sounds, `p3` FX generator, `p6` Decal).

**Melee Weapon**: `p68` / `p69` damage min / max [guess] (shiv 8 / 10, fire axe 15 / 15), `p70`
damage type (10 shiv, 2 axe), `p74` swing sounds, `p71` hit sounds (§13.9), `p77` per-material
hit effects. The combo is the wielder's Player Weapon Properties `p86` list of **Attack** templates
(`p0` strike clip, `p3` recovery clip, `p6` damage multiplier, `p7` [unknown]): shiv 2:376 (x1),
2:377 (x1.2), 2:378 (x1.5). The list is `p86` + 5 × (first person) + an attack class
(0x1002a1a7: player +0x408, 0 / 1 / 2 by the time since the last strike against Player `p229` /
`p230`), so `p86..p90` serve third person and `p91..p95` first person: `p91` 2:393 (strike 2:218,
x1.6, no recovery) is the **first-person** strike of the unarmed set and the shiv, not a running
attack [verified; earlier read as a running attack]. The damage window is the strike clip's Arm
(100) .. Disarm (101) animation markers.

**Throwables** (Missile Item `p55` thrown BouncingObject, `p56` HUD meter): BouncingObject `p1`
70000 units / s, `p12` fuse (2 s; flare 20 s burn), `p34` detonation generators whose
**Radius Damage** gives `p0` max / `p1` min damage, `p3` inner / `p2` outer radius and `p10`
damage type: TNT 40 / 10, 8 / 20 m, type 3; Shrapnel 65 / 15, 12 / 24 m, type 3; Molotov 10 / 6,
13 / 20 m, type 5 (+ Fire); Flash/Bang 4 / 1, 16 / 30 m, type 19 (+ blinding Screen Fader). The
flare has no Radius Damage. Radius units [inferred]: model units (≈ m), the unit of the Missile
falloff distances; the RFL holds no feet / inch conversion constant and the world's explosive
props read the same class in metres. Damage is `p0` inside the inner radius, falling linearly
to `p1` at the outer one (port: `services.damage.apply({ radius, innerRadius, minAmount })`).
Bounces (RFL 0x1009a8c0, docs/re/object-model.md §9): every hit counts; at `p49` the object
settles on a floor hit (normal within 45 degrees of up) or on any hit when `p50` is set, else
that hit is taken back. Non-settling bounces play `p62`, or `p63` when the surface's Game
Material Properties `p2` (hardness) >= `p56`, at k^(bounces - 1) volume (k = (1 - GMP `p4` %) x
(1 - `p51` %)); the AI noise `p64` rides on that sound. Retail: only the casings (`p86`
generators' objects) have bounce sounds; throwables bounce silently. A detonation generator may
throw several Radius Damages: each applies (the Killjoy Rebirth grenade 4:806: 4:805 21 / 3.75 m
type 17 + 4:1439 0 damage with a victim effect).

**Inventory identity.** The original's inventory counts items per template (Player +0x108:
0x1004cd80 count, 0x10039b10 give, 0x1004cf60 take all). The port's inventory
(src/game/world/inventory.ts) is keyed by item template "pkg:id"; display names (`p22`) are
for the HUD only - different templates share names (Shrapnel Grenade 4:655 and the Killjoy
Rebirth grenade 4:804, both string 4:47). Old name-keyed saves are migrated where the name
belongs to one template (src/game/save/providers.ts).

**Player Weapon Properties** (per weapon, rig 2:9): `p0` / `p5` hand bones, `p7`..`p9` crosshair
HUD Textures, `p13` idle, `p17..p36` four (heading, walk clip, walk speed, run clip, run speed)
sets, `p37..p60` the same block shifted by 24 (a second stance), `p61..p84` the same block
shifted by 48 = the **first-person** stance (hold `p61`, four walk / run sets `p65..p84`; `p62`
fidgets, empty), `p86..p95` strike lists (§4.4 Melee), `p96..p102` reload by heading set k
(`p98` + k: `p96` first person, `p97` standing, `p98..p102` moving sets), `p103` / `p104`
(0 / the first-person hold played on entering first person), `p105..p108` first-person hold /
fire / fire 2 / throw (heading set k = −2), `p109..p115` the standing set (k = −1: `p113` fire,
revolver 2:474 0.27 s, shotgun 2:99 1.2 s with the pump, tommy gun 2:309 0.1 s), `p116..p150`
five moving-aim sets (k = 0..4), `p151..p167` hit reactions (not played in first person,
0x1003a548), `p172..p174` draw (`p172` first person; Equip 108 marker), `p175..p177` put away.
Clip roles come from the clips' animation markers (.adu type 5, kind 1: the param is a message id -
102 Fire, 103 AmmoEject, 104 DetachWeaponFX, 107 Stow, 108 Equip, 100 / 101 Arm / Disarm, 230
ThrowWeapon, 231 AttachThrownWeapon).

**Chapter 1 arsenal as decoded** (src/game/weapons/data.ts; fire interval = the standing fire clip,
reload = the reload clip):

| Weapon (template) | Slot / order | Damage | Clip / per pickup / ammo item (max) | Spread | Fire | Notes |
|---|---|---|---|---|---|---|
| Shiv (Melee 4:79, model 4:23) | 1 / 1 | 8-10 x 1 / 1.2 / 1.5 combo (first person: one strike x1.6), type 10 | - | - | strike clips | melee, reach port 2.1 m |
| Revolver (Ranged 4:5, model 4:15) | 2 / 3 | 6 per bullet, type 1 | 6 / 6 / 4:230 (200) | 0.25° | 0.27 s | hitscan-like bullet 98 m/s |
| Dual Revolvers (4:12, from a 2nd revolver) | 2 / 4 | 6, type 1 | 6 / 6 / 4:230 | 0.4° | clip 2:452 | second hand set `p66` |
| Shotgun (4:84, model 4:26) | 3 / 6 | 6 pellets x 20 (≤ 4 m) → 2 (≥ 20 m), type 13 | 7 / 21 / 4:231 (40) | 0.25° (port ≥ 3° for pellets) | 1.2 s (pump) | 1a |
| Tommy Gun (4:260, model 4:88) | 4 / 5 | 5, type 1 | 48 / 48 / 4:255 (200) | 3° | 0.1 s, automatic | 1b, 1c |
| Gonzogun (4:826, model 4:282) | 2 / 8 | 30, type 8, projectile 37 m/s | 40 / 20 / 4:1396 | 0.1° | revolver clips | 1b secret box |
| Flash/Bang (Missile Item 4:284) | 6 / 12 | 4 → 1, 16 / 30 m, type 19 | carried 8 | - | fuse 2 s | + Screen Fader |
| Molotov (4:249) | 6 / 14 | 10 → 6, 13 / 20 m, type 5 | 8 | - | breaks on impact [guess] | + Fire |
| Shrapnel Grenade (4:655) | 6 / 15 | 65 → 15, 12 / 24 m, type 3 | 8 | - | fuse 2 s | 1b |
| TNT Stick (4:236) | 6 / 13 | 40 → 10, 8 / 20 m, type 3 | 8 | - | fuse 2 s | 1b |
| Flare (4:455) | 6 / 11 | - | 8 | - | burns 20 s | red light |

Ammo items (Missile Item without HUD meter): 4:230 revolver rounds (boxes of 24 / 48), 4:231 shells
(28), 4:255 tommy gun rounds (96 / 192); Gas Can 4:517 (flamethrower fuel, 50, max 300 - the
flamethrower itself is not in chapter 1).

**Supplies.** Xombium Bottle (Health Bonus Item 4:207): `p55` health restored (20), `p56` the
player's Difficulty Modifier 2:642 (applies to it), Item `p44` = 9 carried, `p48` pickup sound.
Bottles are carried and drunk with the Health action (HUD bottle meter 5:457), not used on
pickup. Flashlight (4:72) properties after the Item block: `p55` / `p56` Spot Light templates
(4:123, 4:669), `p60` Decoration 4:1319, `p61` 0.25, `p62` 60, `p63` 100, `p64` 8, `p65` 2.9,
`p66` 5, `p67` 105, `p68` 3, `p69` the battery item 4:203 (Item, `p44` = 9 carried; boxes of 2),
`p70` Difficulty Modifier 4:1414 (2 / 1 / 0.85 / 0.58), `p71` / `p72` HUD Ammo Meters 5:133 /
5:541. Port reading [guess]: a charge lasts `p62` s, drops below `p61` flicker, recharges at
`p68` / `p63` per s while off, and a battery is used up automatically when the charge runs out.

**Weapons in NPC hands** [data]: Character templates list their weapons in `p52` and, position for
position, the bone that holds each in `p51` (bone indices, not channels): guards `[35]` with the
guard revolver 10:1802 / 10:1801 (Ranged Weapon, model 4:15), Ernesto 10:1020 `[35]` with the Tommy
Gun 4:260, CartWheeler `[10 15 23 27]`, Fester `[23 14]`, Mainliner `[17]`, Nooseman `[40 64]`,
Slayer `[33 36 39 42 45]`, Burrower `[15 26 37]`, the creature-form template 10:593 `[31 22]`. The
creature weapons' models (10:177..193, 4:36, 4:135) carry no geometry: invisible attack volumes.
`p53` is 1 on all the templates (instances override it; see below). No chapter 1 character holds the shiv (4:79 / model 4:23):
it is only referenced by pickups, the Player's Quick Weapon Properties 2:945 and Ammo Box 4:226.
**Held and dropped** [verified: Character init 0x100e5288 -> body-part sets 0x10095d10, spawn
0x10096400; death 0x100e5d00 -> 0x100e12f0; item drop 0x10096c20 -> 0x100be330 -> 0x100bd300]:
the p51 / p52 weapons are put in the hand at creation only when `p53` is set (as `p56` does for
p54 / p55); otherwise only a SpawnWeapons clip event (153) puts them there. At death `p109` says
what becomes of them (1 drop, 2 destroy, 0 stay; `p110` the same for p54 / p55, one pass when
equal). A dropped Item whose `p27` names a template is replaced by it at its position (guard
revolvers 10:1801 / 10:1802 -> Ammo Box 4:1404, the Revolver 4:5); otherwise it falls as itself.
1a's posed corpses have p53 = 0: no gun, nothing dropped (`actors/drops.ts`).

**When the sets are in the hand** [verified unless marked]:
- Character init 0x100e5288 passes p53 and p56 to the set object (0x10095d10). The think's spawn
  0x100e1f50 -> 0x10096400 creates the p51 / p52 weapons only with p53, and the p54 / p55 and
  p57 / p58 parts only with p56. That happens on the first think the character runs: p43 = 0,
  revealed, or active.
- The Character message handler 0x100e3ab0 runs clip event SpawnWeapons (153) through 0x100966f0
  and SpawnAttachments (154) through 0x10096710. Both create their set whatever p53 / p56 say.
- Retail SpawnWeapons events: the dormant creatures' rise clips 10:1423 / 10:1778 / 10:1779
  (0.75 s) and the player's 2:389. No retail clip has SpawnAttachments for a Character.
- 1a examples: 609f at the office bars has p53 = 0 (no gun) and p56 = 1 (his cap). 609e has a gun
  but no cap. The posed corpses with p53 = p56 = 0 hold nothing and wear nothing.
- A weapon set that a SpawnWeapons event put in the hand follows p109 at death like a p53 one.

**The drop** [verified: 0x10096c20 -> 0x100be330 -> 0x100bd300]:
- The item is detached at its attached pose.
- An item of engine type 10 is turned upright: 0x1000c6a0 applies the smallest rotation that takes
  its Y axis to world up, about Y x up by acos(Y . up), so its heading is kept.
- It is given a body: collision interface vt+0x10 with 0.766 and 0.4 (SUFFERING.EXE 0x42aae0, a
  rigid body of three points under gravity (0, 1, 0), stepped by 0x42adf0). Its p27 template
  (guard revolver -> Ammo Box 4:1404) is spawned at its matrix and replaces it.
- Not traced: the body's integration.

**Port**:
- `weapons/npc.ts`: sets from creation by p53 / p56; a 153 / 154 event crossed by the playing
  clip adds the set later.
- `actors/drops.ts`: `inHand` for the drop rule.
- `world/drop-fall.ts`: the pickup starts at the hand model's world position with the upright
  heading. It falls from rest under the level's gravity, reading 0.4 as restitution and 0.766 as
  friction [inferred], and rests on the floor.
- Checked in the browser: guard 7acd's revolver went from the hand at y 98.69 to an Ammo Box
  resting on the floor at 97.66 under it.

**Controls.** The keyboard page (Control Settings GUI 5:906 `p30`) lists 40 actions in this order:
Map, Documents, Archives, Forward, Backward, Turn Left / Right, Left, Right, Run/Walk, Look Up / Down,
Fire, Throw, Jump, Use, First Person, Health, Insanity, Reload, Flashlight, Flare, Roll Left / Right,
Shiv, Fire Axe, Pistol, Dual Pistols, Shotgun, Tommy Gun, Flamethrower, Flash/Bang Grenade,
Shrapnel Grenade, TNT, Molotov Cocktail, Prev / Next Weapon, Prev / Next Thrown, Inventory. The
default keys are not stored as a scan-code or virtual-key table in the EXE or RFL (searched for
both orders and for key-name strings); the port's choices are in src/game/weapons/system.ts.

Open: the scale between template damage and creature health (revolver 6 vs Slayer 78 x
difficulty modifier 1.6 in GameObject `p2`, so 13+ shots; creature-side multipliers were not found),
the aim-assist behaviour, the Adrenaline Template, the flashlight property meanings.

**Difficulty Modifier** (GameObject `p2`, four floats by difficulty): creatures 10:238
(0.45 / 1.6 / 2.2 / 2.6), the player 2:642 (2 / 1 / 0.75 / 0.6, also the Xombium heal); applied to
health [strong for the reference, guess for the use].

### 4.5 First-person view [code: Suffering.rfl unless marked]

The First Person action (0x42c, debounced by the `p228` = 0.3 s timer at `+0x61c`) enters player
state 16 (`+0xa4` bit 16; state table 0x10176488, entries of 0x3c bytes: enter 0x10042400,
per-frame 0x10042ef0, leave 0x100433b0). There is no separate weapon viewmodel, but there is a
first-person clip set (see "First-person clips" below):

- **Model swap.** Entering the state replaces the player's model with Player `p227` = **2:138**
  (arms and hands only, rig 2:9 / anim set 328, texture 2:70; also re-applied after a load,
  0x1003e9ac). It is drawn in the world at the player's transform and plays the first-person
  entries of the held weapon's Player Weapon Properties (below). The model's extra 8-triangle box
  (texture 2:129) is a helper volume.
- **Camera.** Every frame the camera copies the player's transform and moves by
  (`p106`, `p107`, −`p108`) × 2048 in the player's local frame = (0, 1.85, 0.44) model units: 1.85
  up and **0.44 behind** the model's origin (the model faces −Z; the crosshair pick 0x1004ad20
  shoots along −row 2 of the same camera matrix), plus a small random shake [verified].
- **Arm pose** [verified: SUFFERING.EXE sampler 0x46a180 / 0x46a290, clip data]. A rotation-only
  (0xc0) clip track stores a constant translation, and the engine's sampler uses it as the bone's
  translation (0x80 tracks interpolate their key translations; bones without a track keep the
  bind; every constant is scaled by 2048 at load, 0x4737d0). The first-person sets rely on it:
  the collar bones 8 / 28 move to local (0.341, 0.554) in the revolver / dual / shotgun sets
  (bind (0.216, 0)), bone 28 to (0.256, 0.193) in the shiv / unarmed sets, and the upper-arm
  bones 10 / 30 get offsets too. That puts the shoulders 0.12 behind the eye (revolver: z 0.56
  against the eye's 0.44) or level with it, so the forearms come in from the screen edges and
  the open ends of the 2:138 mesh (two 11-vertex cuts at the shoulders) stay out of the
  picture. Posed with bind translations instead, the shoulders sit 0.44 in front of the eye
  and the camera looks straight into those cuts. Per set [measured on the posed clips]: the
  revolver, tommy gun and shotgun hold both hands in front, the dual revolvers one at each side,
  the shiv only the right hand (the left arm hangs by the hip, 80° below the view axis), and the
  unarmed hold shows no arm at all. The flashlight is a chest light on Player `p117` = bone 50
  (attached at 0x10038fd7): no clip or arm pose changes with it.
- **Pitch** [verified: 0x10043294..0x10043393]. View pitch (`+0x59a`, degrees) is clamped to
  `p200` / `p201` = 75 / 65 in first person (`p198` / `p199` = 50 / 50 in third person). Half of it
  (`p194` = 50 %, `+0x5a2`) bends the spine bone `p109` = 5, and the camera turns about its own
  right axis by that angle around the posed `p109` bone; then by the rest (`+0x5a2` − `+0x59a`,
  × π / 180) around the posed shoulder `p112` = 29. The model's shoulders `p111` = 9 / `p112` and
  neck `p110` = 48 take that rest through the same procedural controllers (0x10030030). The right
  arm therefore stays framed the same way at any pitch; the left one turns about its own
  shoulder, which only differs where the two shoulders are not level (the shiv / unarmed sets,
  where that arm is out of view anyway). No pitch-specific clips exist.
- **Lens.** No first-person field of view: the arms are drawn by the world camera. That camera's
  lens is **Level Properties (2:9) p16 = 53**: at level start the RFL reads it and passes it to the
  lens interface as both the current and the default field of view (0x100b2346: lens +0x28 / +0x30)
  [verified]. Leaving the heartbeat state restores that default (+0x34, 0x100330d1); the heartbeat
  pulses between p270 / p271 = 55 / 62 around it. A view keeps 48 / tan(fov / 2) on a 128 × 96 film
  (setter 0x4b21f0, projection 0x49c400: x scale = focal / 64, y scale = focal / (64 × r)), so the angle
  is the **vertical** one of the 4:3 picture: 53° vertical, 67° horizontal [verified for the film
  constants; r = height / width inferred from undistorted output]. The constructor default of 80
  (0x4b1433) is overwritten. The near plane is 32 engine units (1.6 cm, projection `_43` = −32).
  [verified unless marked]

Port (src/game/actors/player-body.ts, `LevelRenderer.viewmodel`): the arms are drawn in a
second pass (cleared depth, 1.6 cm near plane as in the original, the world camera's lens) and parented to a pivot at
the eye that turns with the full yaw and pitch. The arms play their clips with the 0xc0 tracks'
constant translations, the engine's rule that every character follows (docs/re/animation.md
§7). They are bent like the original
(spine p109 by `p194` % of the pitch, p111 / p112 / p110 by the rest, no rate), and the arms root
is the inverse of the original's camera in the model (`fpCameraInModel`: the `p106..p108` eye
turned around the posed p109 and p112 bones). Earlier versions used bind translations,
which put the shoulder cuts of the mesh on screen ("the end of the right arm" at the bottom
right, the left arm a stump at the bottom); the test `tests/fp-arms.test.ts` checks that no
open-edge vertex reaches a 16:9 picture for any set, pitch (−65..75°) or gait. At exactly 4:3
three vertices of the shiv's right upper-arm cut touch the bottom-right corner, which the data
gives the original as well [inferred]. The port's eye is not the
original's (1.6 above the feet, 0.95 crouched, following the physics jump arc), so the unbent
neck (bone 48) is held at its height in the weapon's first-person hold clip relative to the eye:
the clips' own body rise / drop (jump 2:234 lifts the body 0.4, crouch 2:249 lowers it 0.35) does
not swing the arms through the view; the first-person sets, whose neck height equals their
hold's, are drawn exactly as posed. The arms are lit by the engine light rig like every character (§19:
ambient box / global ambient, rim, level and effect point lights; their positions are world space).
The flashlight does not reach them: its spots only begin `start` = r × p8 / (p10 − p8) = 2 m along
the beam (4:123: 10 × 1 / 5), in the original as in the port [measured: arm pixels identical with the
lamp on and off, the wall in front changes]. The pass's three.js lamp copy only matters with
`?lighting=legacy`.
Earlier versions pinned the head 0.22 above / 0.04 in front of the eye: the arms sat 0.4 closer
than in the original and filled the screen (forearms blown up, revolver arms "spread wide").

Lens (port): the actors system hands Level Properties p16 (`engineLens()` in player-body.ts) to
`LevelRenderer.setLens()`. It is used as the vertical angle of a 4:3 picture. On wider screens the 4:3
horizontal angle is kept, so a 16:9 view is 41.0° vertical / 67.2° horizontal; on taller ones the
vertical angle is kept (`lensFov()` in renderer.ts; camera-key FOVs use the same rule, `lensFov` in
sequence/system.ts). It applies to the world camera, and the viewmodel pass copies that camera.
Zooms on top of the lens (heartbeat pulse 55 / 62, camera keys, the monitor view) still act on
`camera.fov`, and a window resize rescales the current FOV by the lens ratio so that a zoom
survives it. The port used 70° vertical before (102° horizontal at 16:9).

Close-range fade [verified]: the original has none for the arms. The Player p353 routine
(0x1003cb20, called from 0x1003d231) adds up a measure over objects within Level Properties
p48 = 35 m of the camera. It returns a number that its caller compares to choose a Player
animation (p355 / p356). It does not change the visibility or material of any model. Entering
first person only clears bit 0x1000000 at engine object +8. Bit 0 of the template flags maps to
that bit (docs/re/object-model.md §2), and the lighting / shadow code tests it (0x4cd81b): in first
person the player stops casting the projected shadow. The enter routine also sets 0x20000000 on
the model object (+0xec); what reads it was not found [open]. Nothing hides the shoulders: the
clips' constant translations keep them behind or beside the eye (see "Arm pose" above).

Why the lens matters [measured; written before the constant-translation fix, when the
shoulders were posed at the bind]: with the world lens on the arms pass the arms took the wrong
place in the frame. With bind translations the eye is 0.44 behind the shoulders, so the upper arms and deltoids are 0.3–0.5 from the lens,
29–34° off to the side and about 19° below the axis. The original's 67° × 53° picture puts
them at or past the bottom corners. The port's 102° × 70° picture brought them into the lower
middle of the screen, as two flat, untextured-looking brown masses. These are the low-poly
backs of the upper arms seen from behind, and at the 1a spawn (unarmed idle, arms hanging) they
were all that was visible. The hands and weapon sat small in the lower middle. With the
engine lens, the hands of the revolver / tommy gun ready poses sit just below the crosshair, the
upper arms come in from the bottom corners, and the unarmed idle shows at most the tops of the
shoulders at the bottom edge. Skinning, texture (2:70, 128 px, stored rows) and the model are
correct: a CPU rasterisation of the posed model from the same eye gives the same picture. What
was still wrong was the pose: those deltoids were the open cuts of the mesh, which the clips'
constant translations move out of view.

**First-person clips** [verified: code; clip lists = all retail sets]. Which Player Weapon
Properties set: the player keeps two (+0x3e8 from the weapon's `p65`, +0x3ec from `p66`,
0x100391bf / 0x100391e2; both = Player `p143` 2:409 empty-handed, 0x1003db3b). Locomotion,
fidgets and the k = −2 clips read +0x3ec (the Dual Revolvers' 2:111); the Dual Revolvers' shots
alternate between the two sets, bone and clips from the same one (0x10029bd0, +0x98 bit 3).

- **Locomotion.** The stance helper 0x100456e0 returns its argument + 48 while the first-person
  flag is set (before its crouch-like +24 branch), so the idle `p13` becomes `p61`, the sets
  `p17..p36` become `p65..p84` and the fidget list `p14` becomes `p62` (0 = none on every set:
  no fidgets in first person, 0x10048f70). The aim-state sets (`p116` + 7k) are skipped in first
  person (0x10045e6c). The clip plays on the whole body at rate 1, synchronised to the old clip's
  time (0x10046cc7); the set's speed (6 for every first-person set) only drives the movement.
  While moving, footsteps come from a timer (Player `p156`, 0x10046312) instead of clip markers.
- **Entering** (0x10042400): reloading → `p96` continues on bone `p3` at the reload's time;
  otherwise `p13` snaps in (blend 0) and `p104` blends over it on the whole body. Leaving a
  reload in first person puts `p104` on bone `p3` (0x10027ab7). `p104` = `p105` = `p61` on every
  retail set.
- **Actions** (heading set k = −2, docs/re/animation.md §9): fire `p106` on bone `p1` (+ `p107`
  on `p2`, unset in retail), then the hold `p105`; reload `p96`; throw `p108`; draw `p172`; no
  whole-body copy. Melee: strike list `p91` (above).

| Set | hold `p61` | walk = run fwd / right / back / left (`p66` / `p71` / `p76` / `p81`) | fire `p106` | reload `p96` | throw `p108` | draw `p172` | melee `p91` |
|---|---|---|---|---|---|---|---|
| unarmed 2:409 | 2:232 | 2:232 (all) | - | - | 2:704 | - | 2:393 (2:218) |
| shiv 2:303 | 2:217 | 2:485 / 2:221 / 2:485 / 2:220 | 2:218 | - | 2:534 | 2:459 | 2:393 (2:218) |
| revolver, Gonzogun 2:436 | 2:270 | 2:476 / 2:273 / 2:476 / 2:272 | 2:288 | 2:271 | 2:534 | 2:455 | - |
| dual 2:109 (`p65`) | 2:127 | - | 2:103 | 2:127 | 2:534 | 2:454 | - |
| dual 2:111 (`p66`) | 2:484 | 2:477 / 2:116 / 2:477 / 2:102 | 2:105 | 2:127 | 2:534 | 2:454 | - |
| shotgun 2:244 | 2:450 | 2:482 / 2:230 / 2:482 / 2:231 | 2:188 | 2:216 | 2:534 | 2:458 | - |
| tommy gun 2:475 | 2:305 | 2:483 / 2:308 / 2:483 / 2:307 | 2:321 | 2:306 | 2:534 | 2:457 | - |

Throwables use the held weapon's set (empty-handed: 2:409). The walk and run clip of each set are
the same; none has root motion. Jumping, landing and the 2:138 model's own clips were not traced
(the port keeps the third-person jump / land clips there).

Port: `PlayerBody.setFirstPerson` (the `p61..p84` sets of the weapon's `p66` set, else `p65`,
else Player `p143`) and the first-person branch of `chooseLocomotion` (four heading sectors, run
clip when running, rate 1, no fidgets); `weaponAction` with k = −2; weapons/system.ts: strikes
from `p91` in first person (`PlayerWeaponProps.fpAttacks`) and `p86` in third person (the old
"running attack" is gone), the Dual Revolvers' alternating sets, empty-handed throws from 2:409.

Measured in the port (1a, camera space, x right / y up / −z forward, pitch 0): shiv hold 2:217
right hand (0.01, −0.11, −1.02), shiv walk 2:485 / 2:221 (0.13, −0.02, −0.91), shiv / unarmed
strike 2:218 (0.32, −0.24, −1.14); unarmed 2:232 right hand (0.09, −0.61, −0.23) — below the
picture; revolver 2:270 hands (0.15, −0.20, −1.10) / (0.16, −0.21, −0.95), walk 2:476 (0.15, −0.19,
−1.23); tommy gun 2:305 (0.20, −0.08, −1.07); Dual Revolvers 2:484 (±0.24, −0.21, −1.11); shotgun
2:450 left hand (0.10, −0.12, −0.97), right hand (0.49, −0.28, −0.19) at the right edge. Before,
the port played the third-person sets in first person: the generic walk 2:30 / per-weapon run
(arms swinging, weapon out of view), the unarmed idle 2:27, the third-person shiv combo 2:124 /
2:210 / 2:209 and idle fidgets.

Stance notes [data]: every weapon's third-person walk (`p18`) is the generic walk 2:30 (arms
swinging, weapon out of view); the per-weapon runs (2:28, 2:413, 2:416, 2:408) lean the torso 0.45
forward and keep the weapon low in view. The shotgun's ready pose 2:450 turns the torso (right
shoulder back): in first person only the left hand is in view at rest. The Dual Revolvers' first
hand set (2:109) names its reload clip 2:127 as the ready idle (`p61` = `p96`); the second set
(2:111) holds the two-gun aim 2:484, which is the original's first-person set (+0x3ec).

Third person [verified code]: standing plays `p13` (2:27 in every set), not the first-person hold
`p61`; moving plays the heading sets `p17..p36` at rate 1 with each set's own ground speed (walk
1.626, run 6.637 forward / 5.110 sideways, backpedal 4.109 either way) and the body turned into
diagonal movement. Rules, data and the port (`src/game/actors/gait.ts`): docs/re/animation.md §9
"Third-person locomotion".

## 5. Placement, links, volumes [verified]

- The position is in engine units, which are 2048 per model unit. Rotation and the axis convention
  are as in `level.ts`.
- To get a volume, transform the template oriented box: scale it by the instance scale, rotate
  it, then multiply by 2048 and add the position. `entityBoxCorners()` does this.
- `links` are uids of other instances. In all 18 levels, **0 of 31,008 links dangle**.
  Links are the **message routes**: when an object fires an output slot, it sends that slot's
  message to every uid in its links.
- Placement checks on 1a:
  - Every NPC and the Player stands exactly on a floor layer (median height 0.00).
  - Pickups sit about 1.1 units above the floor, which is table or shelf height.
  - Doors sit centred between their Edge Passage nodes.

## 6. The message system [strong]

- A message is a small integer. The table at RFL `0x10174658` gives `MESSAGE_NAMES` (98 entries):
  - 1 On, 2 Off, 3 Toggle, 4 Enable, 5 Disable, 6 Triggered, 7 Reverse, 8 Increment, 9 Decrement, 10 Reset
  - 11 BlowUp, 12 Destroy, 13 Prefetch, 14 Lock, 15 Unlock, 16 Pause, 17 Test, 18 ISeeYou, 19 Died, 20 Damaged
  - …, 90/91 InvulnerabilityOn/Off, 150+ items, 300 HealthChange, 301/302 conversation, 350/351 Quest start/complete, 400–402 interaction, 454 TriggerSwitch, …
- **Input slots.** Each class registers a message map in its constructor: entries of
  `{propertyIndex, handler}`. At runtime, when a message M arrives, every entry whose property
  value equals M runs its handler. The level designer chooses which message triggers which
  action by setting the property. For example, a Message Relay's `inRelay` is usually set to On.
- **Output slots.** Class code calls the dispatcher with a *property index*. The engine reads that
  property's message id and sends it to every link. A value of 0 means nothing is sent.
- **Coverage.** Input and output slots were found statically for 111 classes. Family and schema
  names add more. Test: for every message sent along a link in a level, does the target have an
  input slot holding that message? This holds for **80–90 %** of link messages in every level. The
  rest go to classes whose slots are not yet mapped. `--validate` prints these numbers.
- **Reimplementation model.**
  ```
  receive(target, msg, sender):
    for slot in target.class.inputs where target.values[slot] == msg: run action(slot)
  fire(obj, outSlot): m = obj.values[outSlot]; if m: for uid in obj.links: receive(uid, m, obj)
  ```
- **Common handler semantics:**
  - Destroy removes the object.
  - Enable and Disable set a per-object disabled flag. Disabled objects ignore triggers.
  - The engine's "think on/off" call starts or stops the per-frame update of timers and detectors.
- **Level 1a examples:**
  - The exit to 3a is `Detector#7a12.outOnEnter (On) → Level Transition#7a13.inTransition`.
  - The door exit to 1b is `Switch#79b2 → Timer#79b3 → Message Relay#8642 → Level Transition#79b4`.

## 7. STOMP sequences (.qdu) [verified: layout covers every byte of all 186 retail sequences]

`.qdu` entries are type 0x11, one per sequence, referenced by type-0xb properties (STOMP
Player `p0`). "STOMP" is Surreal's in-engine sequencer (EXE debug menu category "Stomp"; the
player code lives in `SUFFERING.EXE` around `0x44dd70`-`0x4512a0`). Parser and sampling:
`src/game/world/stomp.ts`; presentation: `src/game/sequence/`.

**Header** (16 bytes): `u32 flags` (bit 0x40 = cinematic: camera takeover, player input off;
0x02 / 0x04 / 0x08 unknown), `f32` editor timeline length (20 by default; *not* the playing time),
`u32` next free track index, `u32 trackCount`.

**Track**: `u16 nameLen` + name (NUL padded to `nameLen`), `u32 index` (increasing, gaps left by
deleted editor tracks; attach keys refer to tracks by this index), `u32 uid` of the driven level
object, `u32` track flags, `u32 keyCount`, then the keys.

**Track flags** [code path verified in `SUFFERING.EXE`; meaning of the final call inferred from
the data]. The sequence loader (0x44c0c0) keeps the flags with the track; when a sequence starts
(0x44f4ed) they become the initial value of that track's play state (the same word later gets
per-key-type "already delivered" bits for saved games: 1 animation, 2 attach, 4 control,
0x10 message; 0x8000 = handed back). 0x10 is set on every track. 0x01 occurs on three tracks
(a Camera, an NPC, a Fog / Sky Switcher) and 0x02 on one Camera track (unknown). **0x08 = the object only
exists for this sequence**: when the sequence reaches its end (0x4512c0, also after a skip), the
runtime walks the tracks and, for each whose state has 0x08, looks the object up and calls one of
its virtual methods (0x45135a). All 26 retail 0x08 tracks are stand-ins or scene props that must
not outlive the scene: 1a "Goose" uses it for the two escort guards (`8914`, `8915`), the door
guard at his desk (`8913`), his chair, his magazine, the CartWheeler that kills Floyd (`8916`)
and the shoe decorations (all of them taken over by a control key and never handed back, most
placed in the off-map storage); elsewhere Horace, Hermes, Killjoy, Hargrave, the Mainliner, the
1a flashlight and the shells and shotguns of scripted scenes, several of which also get an
explicit Destroy key at the very end. The port removes these objects (World `destroy`) when the
sequence finishes. Without it the escort guards stood idle in the vestibule past the death-row
door (409.5, 503.9) and the door guard sat at his desk for the rest of the level.

**Keys** start with `u16 tag`, `f32 time` (seconds from the start). Keys of a track are stored in
time order; the sequence ends at its last key (the 1a intro "Goose", `12:284`, at 216.5 s).

| Tag | Size | Body | Runtime meaning |
|---|---|---|---|
| 0 | 54 | quat (x,y,z,w), f32[3] position (engine units), u32 0, u32 flags, f32[3] scale | object transform (below) |
| 1 | 30 | u32 channel, ref clip (u16 id, u16 pkg), f32 start offset (s), f32 blend-in (s), f32 speed, u32 flags | play an animation on the object |
| 3 | 14 | ref sound, u16 volume (/10000), u16 flags | play a sound |
| 4 | 14 | u32 track index (0 = clear), u32 hardpoint index | attach that track's object to a hardpoint of this character |
| 5 | 10 | u32 0/1 | 0 = the sequence takes the object over (AI off; for the player also input off), 1 = control handed back |
| 6 | 10 | u32 0/1 | hide / show |
| 7 | 18 | u32 message, u32 parameter, u32 flags | send the message to the object (with a parameter when non-zero) |
| 9 | 18 | f32 time scale, u32 field of view (deg), u32 interpolation (low 3 bits) | camera lens |
| 10 | 6 | — | marker; ignored by the runtime (6 uses, all on Camera tracks) |

Tags 2 and 8 have runtime handlers but never occur in retail data.

**Transform keys.** The stored quaternion is the *inverse* of the object's engine rotation
(world → object, the engine's row-vector convention), for every kind of object alike; the
decoder conjugates it so `StompTransformKey.quat` is the object rotation in the same basis as
level placements (`instanceRotation`, model-axis fix included). Position / 2048 is output space.
Evidence (both checked in `tests/stomp.test.ts`):

- Objects keyed exactly at their placement (1a "Goose": Light1-3, Floyd, the cell doors) get
  `conj(q) == instanceRotation(rot)`; the raw quaternion matches none of the yawed ones.
- Characters playing a forward walk / run clip (labelled from the clip's root motion) travel
  along `conj(q)·(model −Z)`: 72 of 72 such segments over all retail sequences agree (cos > 0.7);
  the raw quaternion agreed on 16 (22 %) and pointed backwards on 27 (38 %): the "characters
  walk backwards" bug. Over all 522 moving segments of animated tracks (any clip, carts,
  creatures backing off, carried bodies) the agreement is 65 % vs 33 %.
- The Camera, which looks down its −Z like a model, faces the speaking character with it.
- A Switch door's final key (1a "Entrance Door" at 26.67 s) is its own open angle (+90°, p57/p58).

The flags of the key being moved **to**
control the segment from the previous key:

- `0x10` linear, `0x20` Catmull-Rom (through the key before, the two keys of the segment and the
  key after); neither = step (the pose jumps when the key is reached). Segments shorter than 1 ms
  are steps. Editors often place a linear key and a step key at the same time to re-snap.
- `0xc0` easing of the parameter: `0x40` ease-out `1-(u-1)^2`, `0x80` ease-in `u^2`, `0xc0`
  ease-in-out `(1-cos(pi u))/2`.
- `0x800`: position moves at constant speed (easing only applies to rotation).
- `0x100` / `0x200` / `0x400`: leave position / rotation / scale alone. Rotation is slerped,
  scale is linear (uniform in practice).
- Before a track's first transform key the object keeps its level placement.

**Animation keys.** All 1433 clip refs resolve to clips in the referenced package's `.adu`.
Channel 0 is the full body (other channels — 5, 17, 20, 21 — appear 11 times). The clip starts at
`offset + (now - keyTime) * speed`; `speed 0` freezes a pose; `blend` is the cross-fade.
Whether a clip loops comes from the clip, not the key: clips with header flag 1 play once (the
next key comes exactly at their end: median hold / duration = 1.00), clips without it loop
(median 2.3). Key flags: the low 8 bits are four 2-bit root-motion modes passed to the
character (x, y, z translation, rotation: 0 off, 1 / 2 two different "on" modes);
`0x100` / `0x200` map to animation-player flags 0x80 / 0x08 (not identified).
Scripted clips also carry the **body offset**: the hips bone (child of the root) has a constant
translation that differs from the rig's bind position in posed clips — the seated door guard's
clips (1a "DoorGuard", `12:144` / `12:114` / `12:101` / `12:174`) put the hips 0.65 m behind and
0.23 m below the object origin (the root bone itself is a fixed 180° yaw). Without that offset
the guard sits in front of his chair (the chair back crosses his body) and his button-press hand
(`12:101`, 15.51 s; the buzzer sound is a Camera-track key at 16.18 s) stops ~0.8 m short of the
desk console; with it the finger lands on the console at 16.0-16.2 s. The Entrance Door (a
Switch) then swings open from its own transform keys (16.52 → 18.38 s, settling at its +90° open
angle at 26.67 s); no message is involved.

**Paired scenes (kills)** [verified numerically]. There is no separate kill-move or
paired-animation mechanism: when two characters must meet, each track gets its own clip from the
same key time, both objects are keyed (nearly) at the same origin, and the clips' body offsets
carry the whole relative placement. 1a "Gaurd" #280 (`12:280`, the flashlight guard at the cell
bars): from 4.24 s (held, speed 0) and 4.51 s (playing) the guard (`10:46`) plays `12:199` and the
CartWheeler (`10:2`) `12:200` (both 8.8 s, clip sets 209 / 208 of the level package); the two
objects stand at (416.3, 505.3) yaw 180° and (416.4, 505.8) yaw 176°, and the clips' hips start
6.6-7.3 m away, at the bars (≈409.5, 508). The creature's right forearm blade (bones `d61bd1ae` →
tip `b16eb3a2`) passes 2-4 cm from the guard's head bone (`07c159a2`) from 4.9 s on, its tip
22 cm beyond (down through the head), while the HeadWoundGen emitter fires at 4.87 s at
(409.40, 99.56, 508.09), 5 cm from the blade. The hips then rise 4 m (both bodies are pulled
into the ceiling; the blood drips start at 10.2 s from the ceiling). Exact alignment needs only
what is decoded above: transform keys (step / linear), clip time `offset + elapsed · speed ·
rate`, root translation stripped, hips offset kept, the full object rotation (tilt included).
The secondary-channel key in this scene (channel 21, `12:94`, a 0.07 s whole-body pose at 6.82 s
with key flags 0x3f) does not take part in the hit. 1a "Gaurd" #218 (the guard dragged at the
office bars) works the same way with body offsets of 15-17 m (`12:148` / `12:10`).

**Sound keys.** All 1839 sound refs resolve. Volume is linear /10000. Flag `0x10` = not
positional (otherwise the sound follows the track's object); `0x20` also raises an AI
"heard a sound" stimulus; `0x08` unknown. Dialog sounds (category 6, 305 keys) carry their
subtitle `.xdu` ref in the sound header. The runtime does not start sounds while skipping, and
skips a sound whose end would already lie in the past.

**Camera keys.** FOV is in degrees (15-90; the port treats it as horizontal at 4:3) and
interpolates between camera keys with the *next* key's mode (0 step, 1/3/5 linear, 2 ease-out,
4 ease-in, 6 ease-in-out); a 0 FOV leaves the lens unchanged. The time-scale field (1.0, three
keys at 0.25) sets the game clock rate; the original value is restored when the sequence ends.
The upper bits of the third field are uninitialised editor memory.

**Attach keys** index the carrier model's hardpoint ("channel") table (§7.1) and parent the other
track's object to that channel's bone; track 0 clears the hardpoint (the box, photo and shoes
Torque carries in the 1a intro, the door guard's magazine, a camera riding the 10 Docks boat).
Of the transform keys that attached objects receive while attached, 55 are world-space and 2
(10 Docks "Bart" on the boat, both at the exact origin) are local to the carrier. The port keeps
attached objects on the bone every frame (src/game/weapons/attach.ts, called by the sequence
presenter) and composes keys within 20 m of the origin with the carrier's pose. A transform
key on an attached object is overwritten by the bone in the same frame (key handler 0x450470
writes the world matrix; the attachment pass 0x46b890 runs later in the frame, 0x45c900)
[verified], and the end of a sequence (0x4512c0 / 0x44f730, finished or skipped) detaches
nothing: a link lasts until a track-0 key or the attached object's death (0x46b8d3) [verified].
1a "Goose" leaves the Dumbell (Breakable 7b16) in Goose's hand at the staging area; its one key
(150.12 s, the cell floor) never shows. The links still in place are saved
(`sequence/system.ts`, provider `sequence.attach`) and hung again on a checkpoint restore;
before, the restore drew the Dumbell at that key.

### 7.1 Hardpoints (channels) [verified from the EXE loader; checked visually on the 1a intro]

The engine calls them channels ("Invalid Channel For Attachment #%d!"). The skeleton loader
(`SUFFERING.EXE` 0x47ae80..0x47b450) reads, after the bone records of the .mdu type-8 entry: a
LOD table (one 20-byte record per LOD; see "Skinned LODs" below), a u32 (kept at model +0x104), then
`u16 channelCount` and per channel `u32 boneIndex, u16 n, n x u32` (n = 1 on v1, 2 on v2 - one word
per LOD; non-zero words are single bits 1, 2, 4, ... on a few channels, meaning unknown), then
the three LOD distances (f32 20480 / 40960 / 81920) and the collision sphere tree. The table is
kept as 16-byte records `{bone, list}` at model +0xc8 and each bone gets its channel index back
(+0x40). The table parses this way on all 190 retail skeletons.

- STOMP attach (0x450c10): `bone = table[hp].bone`, then `obj->vt[0x18](bone, attached, 0, 0)` -
  no offset: the attached object's model space sits in the bone's frame, keeping its own
  instance scale.
- Templates name **bones** directly: Player `p251` attachments + `p252` bone list (empty on the
  player), Player Weapon Properties `p0` (35) / `p5` (27) hand bones, Ranged Weapon `p78` / `p80` /
  `p88` bones of the *weapon's* rig (muzzle, flash, casing port).
- Player / human rigs (2:9, guards 10:44 / 10:46 / 10:59, ...): channel 16 (player) / 19 (guards)
  = bone 35, the leaf "weapon" bone under the right hand (34); channel 11 = bone 27 under the left
  hand (14); player channels 22 / 23 = bones 55 / 59 (feet: Torque's shoes). Horace (10:91):
  channels 9 / 13 / 18 / 19 = hands, head, waist (the electric arcs).
- 1a "Goose" (12:284): DoorGuard (10:44) hp 19 <- "Pornomag" (skinned Animating Static 10:174,
  an actor) at 3.73 s, never cleared; Torque hp 16 <- "Box Of Stuff" 3.73..56.72 s, hp 23 / 22 <-
  shoes 0.04..57.5 s, hp 16 <- "Photo" 106.68..216.5 s; the inmate Goose (10:59) hp 19 <- "Dumbell"
  (Breakable 12:285) from 40.15 s (posed on the floor at 150.12 s when he dies in the dark).
  These are all of Goose's attach keys: no track of 12:284 (nor of any 1a sequence) carries the
  shiv, and no chapter 1 character template has it among its weapons (§4.4).
- Other 1a attach keys: "Gaurd#280" (the flashlight guard) hp 19 <- FlashLight 0.01..11.53 s,
  hp 22 <- MouthBloodGen at 1.06 s (see "Effect objects on hardpoints" below), hp 15 <- track #26 11.54..12.13 s; "Gaurd#218" hp 5 / 4 <-
  tracks #15 / #14. Tracks #26, #14 and #15 do not exist in those sequences (deleted in the
  editor): the keys attach nothing. Horace's chair (Camera#262) carries the four arc ends.
- **Effect objects on hardpoints** [attach verified from the data and EXE 0x450c10, which makes
  no class distinction; emission point verified in the RFL]. An attach key can hang a placed
  Particle Fountain or Object Generator on a bone; the effect then emits from there. 1a "Gaurd"
  #280 (STOMP Player `5824`, sequence 12:280; the flashlight guard stabbed in the head through
  the bars by CartWheeler `6208`): at 1.06 s the guard (`5a57`, rig 10:46) takes "MouthBloodGen"
  (Particle Fountain `7c2d`, template 3:2358, model 3:478) on hardpoint 22 = bone 50, the jaw
  (`0x30cb6f7d`, child of head bone `0x07c159a2`); its track keys On at 6.90 s (the blade is in
  his head from 4.9 s, HeadWoundGen fires at 4.87 s), Off at 9.74 s and BlowUp at 9.75 s. The
  fountain has p0 = 1, so particles start inside the box of its own model (a 5 cm box 5-10 cm
  in front of the jaw pivot), which rides the jaw: the blood comes out of the mouth and follows
  the head as the body is pulled up (drop size, lifetime and fall: §14.2). Port: world fx
  `anchor(uid)` gives placed emitters / generators a scene stand-in that the hardpoint attacher (weapons/attach.ts) places on the
  bone; the emitter re-reads origin, axes and box from it every frame, a generator its spawn
  matrix. Checked in the browser (frozen frames of #280): the emitter origin equals the jaw bone
  position at every sample 1.3-9.7 s, particles appear 5-10 cm from it from 6.97 s, none before
  6.90 s; they run down from the mouth over the shirt (up to ~0.6 m below the jaw), emission
  stops at 9.74 s and the live drops finish (p17). Before, the attach found no mesh for the uid and did nothing, and
  the fountain (wrongly started at load, see §14.2) sprayed on the floor by the bars.
- NPC hand weapons use bone indices from the Character template (p51, §4.4), not channels.
  A sequence attachment on the bone that holds an NPC's weapon replaces it while attached (port:
  the weapon is hidden - the door guard's revolver gives way to his magazine).
- Body parts: Character `p54` (bones) / `p55` (templates) are a second parallel list. Entries
  whose template is a TargetableBreakable or Attachment with a model are worn on that bone like
  a weapon. The blade-limbed Slayer (class CartWheeler, models 10:2 / 10:94) is modelled
  as a body whose neck ends in a bloody stump between two bolt rods; its **head** is a separate
  TargetableBreakable on head bone 18 (one of four head models: 10:24 -> 10:121, 10:1320 ->
  10:157, 10:1321 -> 10:119, 10:627 -> 10:158; instances override it, e.g. 1a CartWheeler 63f8
  wears 10:1637; 3 hit points, the "decapitate to kill" target).
  Guards / inmates wear their cap as an Attachment (10:1726 -> 10:168, 10:1727 / 10:1728) on bone
  54. The class "Slayer" 10:527 lists a Breakable (10:144, a 5-unit trunk) on bone 59; what it is
  for is unverified and the port does not wear it. The other `p55`
  kinds are effect generators on bones (Object Generator, Particle Fountain, Decorative FX) or
  projectiles (BouncingObject, Missile) that throw keys attach; the port does not wear those.
  Before the port wore these parts, Slayers rendered headless and guards capless.

**Skinned LODs.** The LOD table at the start of the trailer has one record per LOD (the skeleton
version, 1 or 2, is the LOD count): `f32 switch distance` (0 for LOD0; LOD1 at 20480 / 24576 /
30720 / 47104 engine units), `u32 firstVertex, u32 vertexCount, u32 firstFace, u32 faceCount`.
The records slice the type-3 vertex array and the type-4 face array contiguously and exactly
(checked on all 190 skeletons). LOD1 face indices and the second per-bone weight list are relative
to LOD1's first vertex. The port draws LOD0 only. (It used to guess the face split from index
ranges and edge lengths, which was off by one or two faces on 12 of the 26 two-LOD models.)

Port note: an attached actor (the magazine) is culled by the actors system at its placement
position, so the attach service re-shows its mesh while attached. The box (Breakable 7b1b) was not
built at all before: its .ldu record names model 4:106, which does not decode; dynamic.ts now falls
back to the template model.

**Message keys.** Parameter 0 sends the plain message (engine message type 0x0a); otherwise a
parameterised message (type 0x12) is sent. Flag bits 0/1 control redelivery when a saved game
resumes a sequence.

## 8. Save system and checkpoints

- **Autosave** objects (`inSave` = On) are triggered by message.
- The EXE contains "Loading minimally saved objects", "LOAD/SAVE: Invalid Object Pointer Table
  Index", "SaveGame() failed when saving original level!" and "Output Stored Transition Saves".
  The engine therefore serializes object state per level and keeps transition saves, so a level
  revisited through a Level Transition keeps its state [strong].
- Not decoded: `Saves/` is empty in this install.
- **Recommendation for the port:** persist the per-level set of {destroyed uids, overridden
  values, disabled flags}, keyed by level path.

### 8.1 The port's save system (`src/game/save`)

- **Save data** (`types.ts`, versioned `SAVE_VERSION`, `migrateSave()` validates/upgrades):
  level path, spawn name, chapter (Chapter Properties ref of the transition that led here),
  display title / level name, difficulty, play time, a 160×120 JPEG thumbnail, and provider
  state in two scopes: `game` (travels with the player) and `levels[path]` (every level visited
  this session, so revisits keep their state).
- **Storage** (`store.ts`): IndexedDB `suffering-saves`/`saves`, else localStorage
  (`suffering.save.<id>`), else memory. Manual saves get their own ids; checkpoints are written
  to the single `autosave` slot (Gameplay option *Checkpoints* not Off); the last checkpoint is
  also kept in memory for *Revert to last checkpoint* and the death restart.
- **Checkpoints** are requested by Autosave objects (input 0 `inSave`), on arrival through a
  Level Transition and at New Game. They are taken 2 frames later (queued start-up messages
  delivered) and only while no cinematic runs and the player is alive.
- **Save registry** (`registry.ts`): each system persists itself through
  `ctx.services.save` (`SaveService` in `providers.ts`):

  ```ts
  const save = ctx.services.save as SaveService | undefined;   // or registerSave(ctx.services, ...)
  const off = save?.register('weapons', {
    save: () => ({ ammo }),              // plain JSON
    load: (data, info) => { ... },       // info.reason: 'load' | 'transition'
    reset: () => { ... },                // New Game (game scope)
  }, { scope: 'game', priority: 30 });  // scope 'level' (default) | 'game'; priority: load order
  save?.addVeto(() => busy ? 'reason' : null);   // disables pause "Save Game" while set
  save?.checkpoint('reason');                     // request a checkpoint
  ```

  `load` runs after every system of the freshly started level was created, before its first
  update. Level-scope providers also get `load(..., {reason: 'transition'})` when a visited
  level is re-entered; game-scope providers get it on every transition. Built-in providers:
  `world` (0: entity destroyed/enabled/visible/class state as a diff against the post-start
  state, plus the dispatcher: clock, running sequences fast-forwarded without their message
  keys, playing Sound Effects restarted), `inventory` (game), `actors.logic` (9: Behavior
  Changer uses, EdgeToggler switches), `actors` (10: every actor through `Actor.getState()` /
  `setState()` — alive/dead pose, health, position, dormancy, visibility, the placed behaviour
  it runs; the living spawned ones are **re-created** here: Object Cloner copies by template uid
  and synthetic uid, `services.actors.spawn` creatures by template ref), `spawners` (12: Object
  Cloner counters, timers and the copies each one still counts, re-linked by uid after
  `actors`), `combat` (game: player health), `player` (20: transform; skipped on transitions), `music`
  (40). State kept in `WorldEntity.s` is saved automatically; only state outside it needs a
  provider. Pending `World.after()` callbacks cannot be saved.
- **Saving is disabled** (pause menu) during cinematics, while dead, and while hostile
  creatures within 30 m are chasing/attacking the player — our reading of the engine's
  "cannot save here" state (0x10065da7, not decoded).
- **Death**: 4 s after the player dies the last checkpoint is restored (no death menu exists in
  the front-end data).
- **Revert / load in the current level** restarts the game systems on the already loaded level
  data (no reload, no loading screen) and applies the save; other levels load normally.

## 9. Level 1a ("Death House") for a first playable slice

5512 objects:

| Count | Class | Count | Class | Count | Class |
|---|---|---|---|---|---|
| 1540 | Static Object | 595 | Decoration | 426 | Move Node Object |
| 367 | Message Relay | 258 | Point Light | 225 | Breakable |
| 187 | Timer | 179 | Detector | 148 | Light Housing |
| 123 | Sound Effect | 121 | Switch | 111 | Portal |
| 98 | Object Generator | 83 | Behavior Changer | 78 | Waypoint |
| 69 | Unspeakable NPC | 35 | Ammo Box | 33 | Health Bonus Item |
| 23 | STOMP Player | 17 | Edge Passage | 17 | Count Down To Zero |
| 4 | Autosave | 3 | Player Spawn Point | 2 | Level Transition |

**Minimum implementation order:**
1. Spawn: Player object, or a spawn point by fromLevel/spawnName.
2. Message dispatcher (§6) with Detector, Timer, Message Relay, Count Down To Zero, Visibility Toggler.
3. Switch doors (activate → open animation, Portal on).
4. Pickups: Ammo Box and Health Bonus Item on touch or use.
5. Level Transition.
6. NPC placement, plus Behavior Changer as "wake up".

## 10. Open questions and next RE targets

Saves, profile and checkpoints, the audio engine and the player rules have their own references: [docs/re/saves.md](re/saves.md), [docs/re/audio.md](re/audio.md), [docs/re/player.md](re/player.md).

Items 1, 2, 4 and 6 (complete message maps with inherited slots, instance flag bits, Switch / Detector leftovers) are answered in [docs/re/object-model.md](re/object-model.md).
Class properties named from the code (weapon / projectile / Radius Damage damage and force, Flashlight, Combat Music, Message Relay picks, RootPlayAnim, Horace; corrections to §4.4, §11.6, §14.1, §15.2): [docs/re/properties.md](re/properties.md).
Renderer: per-object light choice and cull radius, spot constants, screen blur / glow, shadows, effect tint (corrections to §13.4, §17.7, §19): [docs/re/renderer.md](re/renderer.md).

1. **Switch** internals: mostly done (§11.1). Still open: bit 0x4 of the state flags, p36/p41/p46, the sound slots 47–53, and the exact player-use code path (which of 68/69 is "locked").
2. The **Detector filter** enum: done (§11.2). `requireCheck` (p3) calls a helper not yet read.
3. **STOMP**: the key stream is fully decoded (§7), including the transform rotation convention (stored inverted). Hardpoints are decoded (§7.1). Still open: the animation flags 0x100/0x200, secondary animation channels, track flags 0x01/0x02 (0x08 = removed at the end, §7).
4. Remaining message maps. The base-class maps (chained through the first word of each map) are not followed yet, which accounts for most of the unmapped 10–20 %. The extraction method:
   1. Follow factory `cmp ecx, classId` → constructor.
   2. Read the `vt[0x34](map)` registration in the constructor.
   3. Read the map entries, 28 bytes each: `{propIndex, handler, …}`, ending at -1.
   4. Handlers are often filled in by static initializers.
5. Weapon and NPC stat properties (Melee/Ranged Weapon, Character groups 25+). The values are decoded; they still need names.
6. Instance flag bits: 0x80 = visible static model, 0x100 = scale, 0x10 = extra f32, 0x8000 = own bounds block; 0x1, 0x8, 0x200, 0x400, 0x800 are unknown.
7. **Combat Music** fields p2-p9 (§11.6): only p0, p1, p10, p11 are certain.

Animation system, STOMP animation / camera key flags, channels and layers, clip events and the skeleton trailer: see [re/animation.md](re/animation.md).

## 11. Runtime findings for the world system (src/game/world)

Found while implementing the level runtime. Method: the factory `cmp ecx, classId` gives the
allocation size and constructor; the constructor registers a message map with `vt[0x34]`.
A map is filled by a static initializer: it starts with `-1`, holds 28-byte entries
`{u32 propIndex, u32 handler, ...}`, ends with `-2`, and is followed by a pointer to the parent
class's map. Class code fires an output with `[0x1017bf54]->vt[1](objectHandle, propIndex, sender)`.
Property reads look like `props->vt[2](propIndex, -1)`.

### 11.1 Switch [strong unless marked]

- **State flags** (`+0x46` in the object): `0x2` moving, `0x8` unlocked, `0x40` open.
- **Lock**: `p22` is the initial unlocked state. The parent class map handles `p28` (default
  Enable) → unlock and `p29` (default Disable) → lock.
- **Inputs** (own map): only `61 inActivate` and `62 inDeactivate`. They act when the switch is
  unlocked **or** `p63` is set (`p63` = "scripted": messages open it even while locked), and
  reverse a door that is moving the other way.
- **Key**: when locked, the player-use path checks the player's inventory for the template in
  `p38` [strong].
- **Motion** (from the constructor and the per-frame mover):
  - `p55` kind: 0 rotate, 1 slide, 2 no motion (buttons, levers, animated).
  - `p56` axis in model space: 0 x, 1 y, 2 z. Doors use 1 (hinge).
  - `p57` travel: degrees stored as 0–360 for rotation, model units for sliding. 265 at a
    speed of -90 means -95°; the constructor flags values above 180.
  - `p58` speed in degrees (or units) per second; the sign is the direction.
- **Outputs** (fired with the property index):
  - `67` on starting to open, `66` on starting to close.
  - `64` on reaching open, `65` on reaching closed.
  - Doors in 1a link to their Portal with `67 = Enable` and `65 = Disable`; levers send `64 = On`, `65 = Off`.
  - `68` and `69` are fired by the **player** code when it uses the switch. The locked exit
    door to 1b (`Switch#79b2`: `68 = On`, `69 = Triggered`) starts its Level Transition through
    68 [strong for "use attempt", guess for which one means "locked"].
- **Interaction**: `p30` and `p31` are lists of *Switch Interaction Properties* templates (pkg 2),
  for opening and closing respectively (one entry per side of the door). Their properties include
  a reach (`p2` ≈ 1.75), facing limits (`p4`/`p5` ±90°), the player's push animations
  (`p13`/`p14`) and the player's position and yaw relative to the door (`p15`–`p18`). An empty `p31`
  means the player cannot close the door. In-game help: a door hint with a <Use> control placeholder.
- **Damage hook**: when damaged by the Player, an unlocked closed door opens; `p44` selects what
  happens on a hit (0 lock, 1 unlock, 2 another action) [guess on the names].
- **Moving part: p37** [verified, Suffering.rfl]. The post-create (vtable slot 3, 0x10132520)
  keeps the switch's own model (engine +0x64 -> Switch +0xba). The post-load hook (slot 7, +0x1c:
  0x101314d0 -> 0x101313b0) creates the p37 template at the saved placement (+0x4a) and the two
  swap models through the engine's set-model (vt +0xb8, as the Phone does, 0x10015d30): the
  switch wears the p37 model, the new object (handle at Switch +0xb8) the switch's own. The
  motion (p55..p58) moves the switch object, so only the part turns or slides; the base stays.
  **p32 / p33** are the base's material tables, open / closed: with p32 non-empty, state flag
  0x100 (set by the post-create 0x101325cd and by the arrival 0x101314e0 -> 0x101317f8) makes the
  think (0x10132e00) call 0x101308a0, which writes the table slot by slot into the object at
  +0xb8, only when the list is as long as its model's table. So the breaker boxes' lamps change
  when the lever comes to rest (7:557: red 7:1729 / 7:1419 closed, 7:1417 / 7:1730 green open).
  Census (all 18 levels): 46 switches of 10 templates carry a p37, each a Breakable whose model is
  the moving part: levers 7:3 on the 7:2 boxes (7:4 / 7:11, 1a 704a / 5e1d, 2, 3b, 4b, 5b) and on
  12:603 (1a's chair switch 8588), lever 7:556 on the breaker boxes 7:557 / 7:492 (7:12 / 7:13 /
  7:1420: 1b 6413 / 66bf / 7474 / 7476 / 7b5b, 3b 1bc7 / 2177, 4a, 4b, 5b, 8b, 10), buttons 7:5 /
  7:644 / 7:1172 (7:6 / 7:1690 / 7:789: p57 0, they do not move), the 4b plunger 7:109 (7:141,
  slides 0.26 along y: 7507 / 7d7c). No other switch, and no Mechanism, has a sub-part: the
  Mechanism post-create (0x100c84f0) spawns its p42 template without a swap and no retail
  Mechanism sets p42; their models are the moving part alone (8b's valve wheel 7:1287, cameras,
  fans, doors). The light switches 7:5 (model 7:7) have no p37 and p57 = 0: nothing moves.
  Port: `world/switch-part.ts`, `dynamic.ts buildSwitchWithPart` (the switch object draws and
  collides with the part; the base is an object of its own with the p37 class's collision rule
  and the instance's .ldu colours [port: the colours are the base model's]), `world.ts
  switchPose` (base tables at rest; the use prompt looks at the base too). Before, the whole
  switch model turned (the 1b basement breaker box tumbled 180° into the wall, its lever never
  drawn). The base does not break (the p37 Breakable's health is not modelled) [port]. Checked in
  headless Brave (before / after frames): 1b 66bf, 1a 704a and 8588, 8b's valve 2728. Tests:
  `tests/switch-part.test.ts`.

### 11.2 Detector [strong]

- The engine sends a touch event for every overlapping object. The Detector keeps a list of the
  objects inside, each with a timestamp:
  - A new object passes the filter `p1` and, if `p3` is set, a further check. The Detector then
    fires `7 outOnEnter` with that object as the sender.
  - An object already inside fires `8 outOnEnterAgain` on **every touch**, which is every tick
    while it stays inside. It is used for "while inside" logic such as Visibility Message Filters
    and Prefetch.
  - A stale object fires `9 outOnExit` and is removed.
- `p2` (default 1): while one object is inside, others are ignored. When that object leaves, the
  Detector clears itself and is removed, so it is single-use.
- `p1` filter: 0 Player (object category 3), 1 Ground Enemy (category 7), 2 either, 3 class
  Pushable, 4 Spot Light Cone, 5 Crane. The table at `0x101781bc` (`1,1,1,0,1,0,0`) chooses which
  filters need the per-frame scan.
- Pushables touch by their shape [inferred from the touch rule above and 5a / 5b data]: a crate
  pressed against junk under a Detector set 1.6 m above the floor (5a's door crate: 231c /
  231e / 231f over the junk 2309 / 230a / 230e) or dragged into a wide one (5b's caged projector
  32f6 into 32fc) counts while its box overlaps the volume. Port (`logic.ts boxTouchesBounds`,
  `props.ts pushablePositions`): a pushable held or moved from its placement counts by its
  bounds; an untouched one by its middle (a crate placed overlapping a volume would otherwise
  fire it at load). For a Crane the Detector tests the object hung on the crane's
  bone p39 (0x100a7e40 -> 0x100121c0: 4b's boulders; docs/levels.md §4.6) [verified].
  Each object an Object Cloner makes is an object of its own: inside a Detector it is the sender
  of the Detector's messages, so a Damage Action Object with p0 = 0 hits that copy (3a's west-yard
  pit: Detector 1b7c at the bottom, filter 2, -> 1b7d, 200 damage, kills the cloned Slayers that
  fall in). Cloner templates are not in the world [inferred; port: `world.ts` hook `actors()`
  passes the actor's own uid and leaves templates out].

### 11.3 Object visibility and items

- **Instance flag `0x1` = present at start.** Every object without it is shown later. For
  example, Visibility Toggler targets with `startHidden = 2` (the Shiv and the NPCs in the cell
  opposite the player), and the "fallen door" props that STOMP sequences reveal.
- Visibility Toggler `p0`: 2 means hide the linked objects at start. No 1a instance uses 1.
- Item family:
  - `p26` (default 1) is picked up by touch. 0 means picked up only through Use or a message.
  - `p50` input (default Disable), `p51` input (default Enable). The Shiv uses `p51 = 402`
    (AttemptInteract) [strong].
- **Quest Item Pickup**: `p33` is the uid of the item granted. On use, the item is picked up and
  `p27` (On) is sent to the links: timers for the "Use <Attack>" help, the next scripted
  scene, and so on. `p28` and `p29` are Enable and Disable, as for Switch [strong].
  - **The spot, not the item, is what the player uses** [verified in Suffering.rfl]. Items are
    not usable objects (their map chain lacks the usable-object map 0x10178608); the spot's
    vtable (0x10159870) hands the p33 object to the player in 0x10125820 (looked up by uid, or
    spawned from p34 when missing; for an item, its vt +0x9c with the player), and the use fires
    p27 through the usable-object path (vt +0xec, 0x100ba360). The spot's p31 names its
    Interaction Properties (1a: 2:626, player clip 2:511, 4.2 s, StartInteract / EndInteract
    events at 0.79 s) [data]. The item changes hands at that EndInteract, about 1 s after the use,
    while p27 fires at the use itself (§14.5 "Use animations") [verified].
  - Port rule (`World.pickupVia`, used by the Use target in `world.ts`): looking at an item that
    a live spot grants targets the spot; the prompt names the granted item. Before, the visible
    item was itself a Use target, so taking it skipped p27. Only 1a has a spot (8368 → Shiv 5bfb).
  - An item with `p26 = 0`, no `p51` input and no spot granting it is scenery: never offered to
    Use [inferred from the data: nothing can make it available]. Only 1a's three Shivs in Goose's
    corpse double (`7cdc`, `7cdd`, `7cde`) are like this; locker items (`p26 = 0`, Enable on
    `p51`) are unchanged.
- **Message filters** have no own slots. They pass whatever message arrives on to their links
  when a condition holds:
  - Visiblity Message Filter (sic) [verified: test function 0x10136db0, the filter's vtable
    +0x4c, asked by the filter receiver 0x100cb7a0 before it forwards]: `p0` enabled. The test
    runs against the engine's current camera (the one the frame is drawn with, a cutscene's
    included), in this order:
    1. farther than `p4` m from the camera: blocked;
    2. the nearest player within `p5` m of the filter object: passes (whatever the view);
    3. behind the camera: blocked;
    4. the object is projected to the screen; it must lie within the centred `p2` % of the
       screen width and `p3` % of its height (`|x - W/2| <= p2 * W / 200`, the same for y with
       `p3` and the height): blocked otherwise;
    5. `p1 < 0` passes; otherwise a ray from the camera to the object (some object kinds masked
       out first) must come through; `p1` is handed to the ray (port: the slack near the target).
    So `p2` / `p3` are shares of the screen, not angles. Chapter 1 uses 90 / 90 nearly everywhere
    ("on screen") and 10..70 for a few that want the object near the middle. The port read them
    as half-angles, so 90 meant "anywhere in front", and scenes started with the player looking
    elsewhere (1a guard post, §11.5 item 5). Port: `logic.ts visibilityFilterPasses`, the view
    from `WorldHooks.view` (the drawn camera, `world.ts`); `approximateView` (the eye and a 53°
    4:3 lens) stands in where there is no renderer. Test: `tests/scripted-scenes.test.ts`.
  - Instance Message Filter: passes when "the sender is listed in `p1`" equals `p2` (1 on every
    retail instance: the listed senders pass) [verified: test 0x100b8b10, its vtable +0x4c].
  - Inventory Message Filter: passes when the player owns the `p1` item templates.
  - Every filter class (Instance, Inventory, Visiblity, Health, Insanity Mode / Meter,
    Reputation Points) shares one catch-all (0x100cb7a0): test, forward to every link, then the
    filter **destroys itself when `p0` is set** or when none of its links is left (the link walk
    0x10014e30 finds none alive) [verified]. Filters have no message map, so `p0` is not an
    enable flag; the port read it as one, which left the filters whose template has `p0` = 0
    shut for good: 2 Cellblocks' Instance Message Filters 905 / f9e / fcd / 12ab (the inmate's
    scenes), two Visiblity filters and two Insanity Mode filters in 10 Docks, 4b's Reputation
    filters. Port: `World.filterPass`, `instanceFilterPasses`, `filterSpent` (logic.ts), the
    insanity filters in `insanity/classes.ts`; tests `tests/cellblocks.test.ts`.
- **Level Transition Msg Handler**: a cross-level mailbox keyed by p0 / p1 (the level a
  message is meant for, and a channel): a message sent to a handler is stored; arriving through
  a transition re-sends it to the links of the target level's handler with the same key
  [verified, see `docs/campaign.md` §2]. (Relay `79e0` in 1a, which enables the exit Detector
  to 3a, only runs when 1b posts 11:0, i.e. on the way back from 6b.)

### 11.4 STOMP playback in the port [strong]

- The full key format is in §7. `src/game/world/stomp.ts` decodes it (`decodeStompSequence`,
  exact byte coverage on all retail files, tested in `tests/stomp.test.ts`) and samples poses as
  the engine does (`sampleTrack`, `sampleCamera`).
- `StompRun` plays one sequence: every non-transform key of every track is merged into one
  time-ordered list. Message and visibility keys go into the level logic; animation, sound,
  attach and control keys go to the `StompObserver` (the sequence presenter); every transform
  track is re-sampled each frame and posed when its pose changes.
- **Scripted clips own the character** (`src/game/sequence/clips.ts`): an animation key starts
  its clip and fades out every other action still active on the character's mixer over the
  key's blend time (at once without one), whoever started it. three.js averages active actions
  by weight: before, only the sequence's own previous action was stopped, so an AI idle started
  between two sequences (control handed back by 1a "Guard" #230, taken again by "Gaurd" #280
  the same frame) kept running at weight 1 and halved the scripted pose, body offset included:
  the flashlight guard stood 3.4 m short of the bars and the CartWheeler's blade missed his head
  by 3.7 m. Now it passes 2-4 cm from the head bone (browser measurement, 4.9-8 s).
- **Culling around the body**: while scripted, an actor is frustum- and occlusion-culled around
  its hips bone instead of its origin (actors/manager.ts `cull`), since a clip's body offset can
  put the body metres away (7 m in #280, whose origin was behind the camera: the guard was not
  drawn at all; 16 m in #218).
- **Objects removed at the end**: tracks with flag 0x08 (§7) have their object destroyed when the
  run finishes or is skipped (`StompSink.remove`, World `destroy`: actors are removed, props
  hidden). The world save keeps `destroyed`; after a checkpoint revert the 1a "Goose" stand-ins
  stay gone (checked in the browser: after the skip, after the revert, after the guard scenes).
- `World` (logic.ts) owns the runs (`playStomp`, `skipCutscenes`, `runningStomps`) and fires the
  STOMP Player's `outOnFinished` (slot 7) at the end. The Player and Camera tracks are posed by
  the presenter, props by the world system, NPCs through `onStompTransform` (actors system).
- STOMP Player `p1` (1 on every 1a instance) is treated as "play once". Detectors re-send On
  every tick, and the guard scene would otherwise loop.
- The presenter (`src/game/sequence/system.ts`): for cinematic runs it takes the camera
  (the Camera track's pose, FOV), disables player input and hides the HUD and
  first-person arms, drives a third-person puppet of the player model with the Player track's
  pose and clips, plays sound keys (dialog on the voice bus, with subtitles in the interface
  font when enabled), pauses / resumes actor AI on control keys, and on the end puts the player
  at the Player track's final pose. Enter (world system) or Esc skips: all remaining keys are
  delivered in order without sounds, poses jump to the end and each character shows the end of
  its last clip. Clips get the hips' body offset from the clip (see §7 animation keys).
- **What takes the view and the input** [verified, SUFFERING.EXE]: a track on the Camera object.
  The sequence start sets run flag 0x200 when a track's object is the view camera (global
  0x5c8b08, 0x44f497 / 0x44f71a); while any run has it the input mapper drops input (0x44c6a0
  from 0x4bccf1), and the frame renders from that object (0x48c521). A track on the player
  ducks the music (0x1400, 0x44f6cb). The header flag 0x40 is not read by the run (the start
  copies the header flags without 0x40 / 0x80, 0x44f3fd); it only answers "is a cinematic
  playing" (manager vt +0x64 0x44c6e0, asked by an in-game menu event of the RFL, 0x100067c9).
  The STOMP Player's skip (0x1012eb50: input actions 0x443 / 0x444 after p3 s) needs the player
  held (0x10043600). Eight retail sequences have 0x40 and no Camera track (1a "Guard" 7b08, 2
  "Mainliner" 847, 3b "Guard 1" 1ea3 / "Lower Left (A)" 266f / 2672, 4b "EXPL1" 7bdc, 8b "Door"
  24ff, 10 "Inferna 1" a29): they play in the world while the player keeps his view and control.
  Port: `World.takesCamera`; `activeCutscenes` / `skipCutscenes` (Enter) are those runs only.
- Music is not part of a sequence: the sequence's own sound keys play, and level music only
  comes from Combat Music objects (below).
- Scripted actors (between control keys 0 and 1) keep animating while off screen, so a camera
  cut shows their clip at the keyed time (the actors system otherwise freezes idle actors out of
  view).
- **Skinned props.** Sequence tracks can drive non-character objects with a skinned model
  (1a "Goose": Torque's shoes `Breakable#7b18` and box `#7cb3`, posed by animation keys). The
  static renderer skips skinned models and the actors system only takes characters / Animating
  Statics, so the presenter shows them (placement, then transform / animation keys, level-logic
  visibility, hidden once destroyed).
- **Corpse doubles** [data, 1a]: the inmates killed during "Goose" are not left as the scripted
  actors — at 216.5 s every inmate track parks its actor in the off-map actor storage
  (≈ 258-261, 318), and at 193.67 s the "Turn All Lights On" relay (`5f1b`) shows Visibility
  Toggler `7653`'s set: doubles of the inmates placed in their death poses (`7b36` Goose,
  `7b37` Muhammad, `7b38` Floyd: p69 DeathBehavior = corpse), the blood decorations, the Shiv
  (`Ammo Box#5bfb`, stuck in the body) and the stabbed inmate `7652` (Slick's template). `7652`
  is still alive: p69 is an IdleBehavior holding pose `10:367` (lying on his bed, hips 0.6 m off
  the origin), and its instance p72 (death behaviours) is DeathBehavior `12:287` with clip
  `12:107` (3 s, starts and ends in the bed pose). Using the Shiv (Quest Item Pickup `8368`) →
  Timer `8369` → Timer `836c` (0.15 s) → BlowUp → he dies on the bed. Two port rules make this
  work: a character's own p72 DeathBehavior clips are played on death (instance overrides of the
  template's list), and a clip of another animation set is accepted for a rig when every track
  hits a bone and ≥ 90 % of the bones are animated (level packages carry scripted clips for
  shared rigs under their own set id: `12:107` is set 209, the inmate rig is set 52). Without
  either, the generic death clip played from the actor origin in front of the bed.
  What "Goose" itself shows of the inmate (track "Slick", same template): he is never killed on
  screen. All his clips are standing ones; the lights go out at 153.98 s, the CartWheeler drops
  into his cell (158.8-165.1 s, attack clip at 163.1 s) while he stands at the bars, a spotlight
  lights the cell 166.03-167.84 s and the camera cuts away at 167.84 s. No death clip, Destroy /
  BlowUp or visibility key reaches him; he is parked off-map at 216.5 s. His double appears on
  the bed at 193.67 s, when no camera shot frames the cell. No track attaches the Shiv
  (`4:79` / model `4:23`); the Shiv pickup is simply placed in the double's back.
- Message keys with message id 0 (24 in "Goose", e.g. on walls and posters) send nothing.
- **Track audit**: `tools/stomp-audit.ts` lists every track of a level's sequences (target
  class / template / model, how the port presents it, keys by type, expected state at key
  times); `tools/stomp-sample.mjs` plays them in a headless browser and records the actual state
  through `window.__stomp.probe`; `stomp-audit.ts --actual` diffs the two (position / yaw error,
  wrong clip or clip time, visibility, unrendered objects, unhandled messages) and lists what is
  not modelled (secondary animation channels, id-0 message keys, transform keys on attached
  props). It also follows every message key through Message Relays, Timers and Visibility
  Togglers to the objects it reaches indirectly ("indirect targets", e.g. the corpse doubles
  above) and checks their state (shown / hidden / killed / destroyed) and, for characters, the
  rest pose of their start behaviour (idle / dormant clip, corpse death clip), and it checks the
  end state again a few seconds after each sequence (`__stomp.snapshot`: corpses stay dead,
  objects stay hidden, actors still held by the sequence stay put, objects of 0x08 tracks are
  gone). The sampler blocks level transitions reached through the forced sequences and pins the
  clock rate it asks for (the insanity system resets `view.timeScale` every frame).
- **Control hand-back timing**: a control release key takes effect after the poses of the frame
  that reaches it (a transform key just before the release, 1a guard scene 20.09 / 20.10 s,
  would otherwise take the actor over again for the rest of the sequence).
- **Attach bones follow the clip** [data, 1a "Goose"]: rotation-only clip tracks carry a
  constant bone translation, which the engine uses as the bone's translation for every bone
  (docs/re/animation.md §7). That includes the attach points, the bones whose subtree skins no
  vertex, e.g. the hand weapon bone 35 (hardpoint 16 / 19). Animators
  move that bone to where the held object belongs: Torque's photo clips 2:395 / 2:396 put it
  7-12 cm from its bind position towards the fingertips. With the bind position the photo
  (model 7:1250, origin at its centre) sat in the middle of his fist and the hand covered the
  picture; now he holds it by the corner with the thumb on the front, as in the original
  (`app/character.ts buildAnimationClip`).
- **Animation keys are posed at once**: actors animate before the world system delivers the
  frame's keys, so a key that starts a clip together with a transform key that re-places the
  object showed the previous clip at the new origin for a frame. In paired scenes the clips'
  body offsets are metres long (1a "Gaurd" #218 at 11.95 s: both objects re-keyed 16 m away from
  the bodies), so both bodies jumped to the bare origins; culled around those hips they then
  froze there for up to 0.2 s, because hidden actors only re-animated at 5 Hz. The presenter now
  evaluates the pose when it starts a clip, and a scripted actor always animates at full rate.
  Measured over the scene: no hips jump above 0.53 m (the designed hard cuts), before 16 m.
- **Hand-back keeps the last pose** [inferred from the data]: when control returns, the
  character stays in the clip the sequence left it in until its AI plays something itself
  (moving, fighting, a new behaviour). Designers key that pose on purpose: "Gaurd" #86 keys idle
  10:70 before its release, #218 keys the guard's corpse pose 12:195 at 20.09 s and releases him
  at 20.10 s. The port used to re-pick the idle at once (10:70, standing): the dead guard got up
  behind the bars. A held play-once clip stays; a looping one gives way to the idle as before.
- **Hand-back keeps the place** [inferred: the engine moves the object itself while a sequence
  holds it, and no relocation on release was found; the data needs it]: the released character
  stays exactly where the last key left it and stands on whatever is under its feet. 1b's Horace
  (`7eb2`, the "electric" ghost in his cabinet over the arena) is placed and keyed by "Camera"
  #247 at y 80.25 on a 20 cm beam inside a niche whose walls come closer to his axis than his
  0.49 m radius; #247 releases him at 86.6 s, and he speaks his arena lines from there. His
  behaviours [verified: data + browser]. He starts in DormantBehavior 10:636 (mode 2, hidden).
  The crossing that starts #247 (Detector `671c` -> Relay `7ecd`) also wakes him, at 9.5 s, into
  his p69 IdleBehavior 10:623 (clip 10:1363), so he is idle when released. #247's finish sends
  him On again, which changes nothing. Behavior Changers `7ec1` / `7f5d` / `7f5f` / `7f61` /
  `7f63` later give him SimpleConversationBehaviors aimed at the player: no walking up (p5 0),
  ranges 999. None of these moves him, so he holds the cinematic's last pose (10:1314) until his
  first line plays 10:1363. The port re-placed the body with the motor's teleport, which first
  pushes the capsule out of whatever it overlaps: out of the niche, off the beam, and he fell
  6.6 m onto the arena floor (measured: y 80.25 -> 73.67). Now the hand-back keeps the keyed
  position, snaps feet up to 1 m above a surface onto it (as the teleport's own snap did) and
  lets a body with nothing under it fall (`actor.ts handBackAt`). Checked in the browser: Horace
  stays at (459.74, 80.19, 493.15) after #247 and through the arena's start; again in a run
  with this change, still there and drawn 4 to 10 s after the release. Test:
  `tests/scripted-scenes.test.ts`, which fails with the teleport. The playthrough step
  `1b.horace` checks his place 4 s after the cinematic (`expect.actorAt`).
- **Parameterised message keys** [verified]: a message key with a non-zero parameter is sent as
  an engine message of type 0x12 (SUFFERING.EXE 0x450fe4) instead of the plain link message
  (type 0x0a). Both go out at once through the same post (0x40b260 -> 0x40aa60); the payload is
  {message id, a flag 1, the parameter at +0x0a}. The receiver looks its message map up by the
  payload's message id alone (0x455a70), so the parameter does not change which slot runs. In the
  whole game only one such key carries a GameObject input id: 1a "Gaurd" #114 sends Destroy (12)
  with parameter 6 to its guard at 1.44 s. The GameObject map's Destroy slot (0x100a1c60) calls
  vtable +0x88. For characters that is 0x100e1490 -> 0x100cb870, which ignores the message and
  destroys the object. So the guard is removed at 1.44 s, under the falling rubble, in the original
  as well. The later keys (transforms at 4.99 / 11.46 s, releases, a plain Destroy at 11.60 s)
  then find no object. The port's removal at 1.44 s is therefore right. It also means a player
  has under 1.5 s to see him buried (§11.5 item 5).
- **Death clips of other clip sets**: an actor accepts a clip of another animation set when it
  animates at least 90 % of the rig's bones. Tracks for bones the rig lacks (weapon / prop bones
  of other rigs) no longer disqualify it - the rig's own clips have them too. #218's guard dies
  through Behavior Changer 8a21 (on the STOMP Player's finish) into DeathBehavior 12:793 whose
  only clip is that corpse pose 12:195 (19 of 78 tracks unbound); it was refused and the generic
  death 10:301 (standing start) played, so he stood up and fell again at 28.27 s.
- **Skinned props without flag 0x80**: plain prop classes on a sequence track (Breakable,
  Static Object, Light Housing, TargetableBreakable) are drawn by the presenter whatever
  instance flag 0x80 says - the engine never reads that bit (docs/re/object-model.md §2);
  flag 0x1 / the level logic decide visibility (`sequence/props.ts`). 1a "Guard" #242's "Chain"
  (Breakable 7faa, skinned 12:636, flags 0x1) hangs from the duct grille to the guard's raised
  hand and pulls him in (clips 12:198 / 12:197 against his 12:70 / 12:180); without it the body
  rose into the duct on its own. The same rule shows 1b "StompHatch", the 4b dolls and other
  scripted props in later levels.
- **Skip and screen effects**: Screen Faders / Blurs (insanity system) run on game time; after a
  skip they get the skipped time at once (`EffectDirector.fastForward`), so they show their
  state at the sequence end ("Goose" opens on a black fader holding 3.75 s: skipping early left
  the screen black for seconds).
- **Subtitles while paused**: the subtitle / skip-hint overlay is hidden while the game is paused
  (the pause menu would be drawn under it).
- **Saves**: a save applied before the restored level's first frame keeps the actor's first-frame
  init (its start behaviour and pose); before, the stabbed inmate stood alive in front of his
  bed after loading a save (actor.ts setState).
- **Esc and the pointer lock**: the pointer lock is kept through a cinematic (mouse look is off).
  Esc skips; the lock the browser releases on that Esc (or any lock lost during a cinematic) is
  kept from the menu flow, which would otherwise open the pause menu. A lock lost while the window
  keeps the focus counts as Esc for browsers that do not pass the key on while locked.

### 11.5 Level 1a flow (as run by the world system)

1. Timer `7ca4` (auto) plays the intro (`7509`). On finish, BustedDoor (`5b9e`) at 2.58 s hides
   the player's cell door (`Static Object#5882`, through Visibility Toggler `69ee`) and moves the
   busted door props. The intro's stand-ins (0x08 tracks, §7) are removed at its end, skipped or
   not: the escort guards `8914` / `8915` (last keyed at 38-42 s in the vestibule past the
   death-row door), the door guard `8913` with his chair and magazine, and the CartWheeler `8916`.
2. Detector `5823` (the cell) → Timer `7afb` (4 s) enables Detector `69c1` (corridor) → Visibility
   Message Filter → Relay `8626`: guard scenes `7b08` (`12:230`, the flashlight guard runs to
   the cell-row door) then `5824` (`12:280`, the CartWheeler kills him through the bars; §7
   "Paired scenes"). The opposite cell door
   `Switch#5872` falls and is destroyed, and `Static Object#848d` (the fallen door) is shown.
3. Using the Quest Item Pickup `8368` gives the Shiv (`Ammo Box#5bfb`), and its p27 starts
   Timer `8369` (0.831 s) → Timer `836c` (0.15 s) → BlowUp to the stabbed inmate `7652` (and the
   Sound Effect `7efd`), Timer `83b6` (4 s) → the attack help popup `83b7`, and Timer `8af4`
   (0.1 s) → Disable back to the spot. **Pulling the Shiv kills the inmate** [data chain
   verified, browser-checked]: BlowUp ends him through his instance's own DeathBehavior `12:287`
   (`p2` clip `12:107`, 3.03 s): about 1 s after the use he rears up from the bed, arms
   flailing, and sinks back into the bed pose he started in (the clip's last frame differs from
   its first by 1.5° per bone on average, 34° at most; highest bone 0.74 m above the pose at
   the peak). He then stays dead
   (dead bodies ignore damage, wake and BlowUp, §15.12), and a save restores him dead in the
   clip's last frame (`dieSilently` plays the clip to its end). DeathBehavior's other fields as
   read in its runtime (vtable 0x10157c30; slot roles inferred: start 0x100ec0b0, play
   0x100ec240, update 0x100ec310) [verified reads, meanings inferred]: `p3` a template kept on the character,
   `p5` = 0 plays the clip in mode 3 and sets bit 0 of character +0x26c (`p5` = 1: mode 2, bit
   cleared; only the corpse-pose behaviours like `12:793` use 1), `p6` = 1 hands the body to a
   global list with a count limit (0x100a15a0) [inferred: the corpse clean-up]; `p4` (90 / 270)
   is not read in the start or play code; it is the **death picker's angle bound** [verified, Character
   death 0x100e5d00, picker 0x100e6174..0x100e6392]: the angle (degrees, acos) between the body's +Z
   axis (its back: the third row of its world matrix, times its scale) and the unit direction from
   the blow's attacker (the damage record's source handle) to the body; the first entry of the p72
   list whose `p4` is above it is played, else the first (an empty list sets the "no death
   behaviour" flag). A record with no source (Damage Action Objects build theirs with none,
   0x1008e9e7) keeps the zero vector: 90 degrees exactly; a zero direction counts as straight down
   (90); past +-1 on a scaled body acos is NaN and the first entry is taken. Guards' p72 is 10:250
   (`p4` 90: 10:301 / 10:1470, thrown back) then 10:22 (`p4` 270: 10:156, 5.7 s: he stands, sinks
   to his knees, falls at the end): shot from in front the first, from behind or by a hazard the
   second. `p2`'s clip is a random one (0x100ec168). Port: `actor.ts deathAngle / deathPick`
   (`profile.deaths`, the attacker of the killing blow), tests `tests/electrocution.test.ts`.
   **The bug this fixed**: the Use target took the visible Shiv model itself (Ammo Box `5bfb`,
   nearer the crosshair than the spot, which has no model), so the Shiv was given but `8368`
   never fired p27: the inmate stayed posed and the help popup never came. Now the Shiv routes
   to the spot (§11.3). Checked in headless Brave: crosshair on the Shiv → target `8368`
   "Pick up Shiv", E → dead at 0.98 s, `12:107` played to its end in real time, unchanged
   (≤ 1 mm per bone) after a pause-menu save / load. Tests: `tests/shiv-pull.test.ts`;
   playthrough steps `1a.shiv` (aims at `5bfb`) and `1a.shiv-inmate`.
   The Shiv's outOnPickup2 →
   Relay `836d` enables Detector `5afd` at the cell door. Leaving the cell runs the "Door"
   scene `5e71`: the corridor bar door `Switch#66c9` (locked, scripted) is hidden through
   Visibility Toggler `66cb`, and the hall towards the second door (`Switch#4a5d`, opened by the
   guard scene) is free.
   **The Shiv in the corpse's back** is the Ammo Box `5bfb` itself (model `4:23`, 0.8 m along its
   local −z from the taped grip at the origin), hidden at start and shown with the corpse double
   `7652` by Visibility Toggler `7653`, at its level placement (391.65, 99.18, 496.63; the blade
   points down into the upper back, the grip sticks out about 0.3 m). It is not attached to a bone:
   the double's pose `10:367` is fixed, so the placement matches it. The Quest Item Pickup `8368`
   (no model) is what the player uses: its p33 names `5bfb`, which is picked up (the Shiv given,
   the model hidden and destroyed), and its p27 → Timer `8369` → `836c` kills `7652` (`12:107`). Two port bugs made it look missing: batched pickups were drawn at the level
   origin (fixed in `prop-batch.ts`, `worldMatrixOf`), and its load-time colours were black. It
   precedes its cell's lamp (`5c06`, index 427) and the root Ambient Light (index 3206) in creation
   order (its own index 419), so the creation-order rule gave it no ambient and no light, and only the lamp
   reached it per frame, under the corpse's projected shadow: it drew at about (11, 6, 3). In the
   EXE the load-time pass (0x4ca3a0) runs at an object's first draw [verified]. Scene object
   vtable +0x84 (0x4ca6c0) is called only by the draw functions 0x4930f0 / 0x492950, after the
   frame's gather and once the upload holds a light, and 0x42c6f7 calls +0x98, not +0x84. The
   gather takes the lights that are on then, in the groups that hold the object (renderer.md
   §1.9). An object hidden at start is not drawn (SetVisible clears +8 bit 0, 0x4541a0), so the
   Shiv is lit when it is first drawn after being shown. `world/dynamic.ts loadPassBefore`
   gives objects without instance flag 0x1 every static light that is on at load. [port: the lights
   on at load stand for those on at the reveal; in "Goose" relay `5f1b` turns all lights on in
   the same step that shows the Shiv.] Its cell lamp `5c06` is under "cell 4", like the Shiv,
   so the group rule keeps it. The lamp is switchable, and the port bakes no switchable light
   (renderer.md §1.9: the fallen door `848d` would otherwise stay lit after the lights-out), so
   the lamp reaches the Shiv per frame and only the ambient is in its colours. At 18233af the
   Shiv drew
   grey metal (about 70, 60, 44 on screen; the same with `?nobatch`); now it draws about 0.75 of
   that. Test:
   `tests/static-light.test.ts`.
   **Start-visible objects without .ldu colours** (doors, pickups, map packs, the batteries
   `7822`) keep the lights stored before them. In 1a that is nothing for every cell door and for
   21 start-visible pickups, so they show only their switchable lamps per frame. By the code,
   their first draw happens with every light present. The PC capture of the cell 6 door `587a`
   at 126.7 s of "Goose" contradicts that: the bars reach p95 180 against 255 when lit with
   every light, and their shadow sides are without ambient. The doors and the pickups share
   everything that was checked: the scene object class, the draw path, a ref of 0:0 and similar
   model header flags. So the pickups follow the doors [inferred: the code path that keeps
   these colours dark was not found; renderer.md §1.9]. Test: `tests/static-light.test.ts`.
4. The guard room west of the cells (guards `7acd` / `7ace` / `7acf`, alive and dormant at
   379-383, 527-535) is swapped for its corpses: Message Relay `7ada` relays on **Disable** (5)
   and sends On to Visibility Toggler `7af3` (shows the corpse doubles `7af0`-`7af2` and the
   blood) and to Relay `7af4` (Destroy to the three guards and two Breakables). Disable reaches
   it from Timer `7adb` (4 s after the Security Monitor `68ad` was used, which also runs the three
   Behavior Changers) or from Relay `7b0a` (Detector `7acb` in the hall by the guard office bars,
   or Relay `7a08`). Checked in the browser: the guards are gone and the corpses shown at once.
5. Guard post scenes: "Gaurd" #114 (`6045`, the rubble guard) prefetches #218 (`6206`, started
   by Relay `7796` / Visiblity Message Filter `7ac0`): the guard `609f` runs into the light at the office bars and is killed by CartWheeler `6208`
   (paired clips 12:27 / 12:16, then 12:148 at speed 0.7 / 12:10, then 12:68 / 12:17), keyed
   into the corpse pose 12:195 at 20.09 s and released at 20.10 s; the CartWheeler is destroyed
   at 20.09 s. At the end (28.27 s) the STOMP Player's finish On reaches Behavior Changer `8a21`
   -> DeathBehavior 12:793 (pose 12:195): he dies where he lies. Checked in the browser: head
   bone never above 0.7 m after 20.09 s (3504 frames, 30 s), dead in 12:195 afterwards.
   The ceiling rubble that falls in #114 (skinned Breakables `72b7` / `734d`) has no collision of
   its own; Invisible Static Objects `72c2` / `7658` / `7659` close the corridor (§14.7).
   How a player meets the two scenes before it [verified: data + browser]. Guard `7508` sleeps
   hidden (DormantBehavior 10:329) at the south end of the hall until the player crosses
   Detector `7a3c` (x 430 in the cell corridor), which wakes him. "Gaurd" #86 (`5da5`, 3 s) starts
   through Relay `79ad` (count 1) from Detector `5da4` (crossing z 511.5 into the hall) or from
   Detector `6a85` (the hall's north corner, every tick) through Visiblity Message Filter `6a86`
   at the hall's far end: so when the player at the corner looks down the hall. He runs up from
   z 544.7, calls out to the player (voice line 12:18) at the junction and runs east
   (clip 12:181 carries the body; the key snaps the object to x 451.6 at 2.48 s); he is released
   there idle. The same corner's filter `7ea4` starts the duct scene "Guard" #242 when the player
   looks north instead. "Gaurd" #114 (`6045`) starts through Timer `6046` / Relay `8041` from
   Detector `5bb1` (stepping east into the walkway, x 437.6), Detector `8a1e` (past the junction,
   z 543.1) or Detector `6c7d` (the junction) through filter `6c7c` down the east walkway: so when
   the player in the junction looks east. It keys the guard's object back at the junction, but
   its clip 12:71 (twice its speed, root left in the pose) draws his body 16 m east of the
   origin, where #86 left him, and drops it to the floor (hips y 1.2 -> 0.15) as the ceiling
   comes down: he is buried in front of the player. Bug (user report, "the man buried by the
   rubble does not show up"): with the filters read as half-angles (§11.3) both scenes started
   while the player walked past facing elsewhere - #86 on entering the corner facing east, #114
   on entering the junction facing south - so the guard ran and was buried out of sight. Checked
   in the browser with the screen test: walking east to the corner starts nothing; looking down
   the hall starts #86 with the guard on screen (36 m) and his line; walking down the hall
   starts nothing; looking east starts #114 with his body on screen 16 m away as the rubble falls
   on it.
   **Walked like a player** [verified: browser, A/B]. The report said the scripted route showed
   him and a real player did not. So the hall was walked from the cell corridor with ordinary
   input only: W held, walking or running, the view turned by hand towards where the player goes
   (at most 200°/s, corners rounded), the hall door opened with E, first and third person, along
   eight paths. Paths: down the middle and following him east; cutting the corner towards the
   walkway; down the west side; down the east side; a look north at the duct scene first; standing
   in the junction and turning east; going on south past the junction. Each run was repeated with
   the old half-angle filter swapped back in at run time. The time the guard was drawn on screen
   (shown, not culled, skeleton centre in the view) was measured while each scene ran.
   - Screen filter: #86 shows him for 2.4-2.6 s of 3.0 on every path, his whole run.
   - Screen filter: #114 shows him for 0.8-1.45 s of the 1.44 s before the Destroy key removes him
     (§11.4) on every path that turns towards the walkway.
   - Old filter: walking, #114 started at (435.0, 535.1) facing south as the player stepped into
     the junction (Detector `6c7d`), and showed him for 0.05 s. #86 started at the corridor
     corner facing east, and showed him for 1.4 s of his run.
   - With either filter, no guard is seen by a player who walks on south without ever looking
     east (#114 then starts at `8a1e`), or who steps into the walkway from its south-west corner
     heading south-east (`5bb1` fires at once while the guard is to his left). Both come from the
     level data, and the original does the same.
   The half-angle reading was the root cause. Tests: `tests/scripted-scenes.test.ts` (the screen
   test, and a walk down the hall over the level's own Detector boxes and filters: the screen test
   starts #114 at (436.1, 537.3) with the guard on screen, the half-angle reading at
   (435.0, 535.0) without him). Playthrough step `1a.guard-post` (a `stroll`: the same walk in the
   browser, failing if the guard is on screen for less than 1.5 s of #86 or 0.7 s of #114).
   "Guard" #242 (`7ea6`, the hallway north end): the Chain pulls guard `7f91` up into the duct;
   both are blown up and removed at 8.62 s.
6. Exit to 1b: the locked `Switch#79b2` → player use → `68 On` → Timer `79b3` (0.65 s) → Relay
   `8642` → Level Transition `79b4` (`1b`, "South Spawn"). The exit to 3a (Detector `7a12`) is only
   enabled when 1a is re-entered from 1b.
7. **The gas chamber** [data chain verified; browser-checked in headless Brave]. The tank
   (Static Object `6303`, door Mechanism `5e1a`) holds the inmate `71ec`, a new guard strapped in
   the chair. The player first sees him from the control room west of the tank (lever `74fb`,
   monitors `6d8e` / `6ddf`).
   - **His monologue.** Detector `7555` at the corridor junction past the third checkpoint (36 m
     from the chair) hands him SimpleConversation `7544` (12:26, sound 12:104, a voice line). Its p0 = 0 and p1 = 0 mean no listener, so he talks at once (§15.2).
     Each line's end sends p21 = On to his links. Timer `7545` (2 ± 0.4 s) then enables Behavior
     Changer `7546` (12:27) and Timer `754e`. The chain runs through `754e` / `754f` / `7550` / `7553`
     (12:28..12:31), which Timer `7557` disabled at load.
     **The bug:** the port treated "no listener" as the player and waited for him to come within
     range, so no line ever played. Now 12:104 → 12:105 → 12:106 → 12:107 play while the player
     walks to the control room.
   - **The execution.** Detector `5c1e` (the plane at z 447.5) starts the camera scene "Camera"
     #226 (`7abf`), locks the door `50e7` behind the player (Timer `7559`) and shows the Hermes
     double `7ac3` for the shot.
     At the scene's end Timer `755d` starts "Gaurd_Victim" #212 (`71ea`, 40.43 s: his panic,
     a voice line). The tank gas follows 4 s later (Relay `75aa`: fountains `5c31` / `75a8`).
     At the end of #212, Behavior Changer `8a3c` gives the inmate DeathBehavior 12:794.
   - **The door.** Timer `755f` (39 s after #212 starts) → Relay `7565` (enabled at the camera's
     end by `8aec`) → Timer `7563` (0.5 s) → Relay `755e`. That relay fires Timer `6895` (0 s, On to
     Mechanism `5e1a`: 120° in 1 s) and the gas timers. The door therefore swings open as the
     inmate dies (port: opens at 39.7 s, he dies at 40.4 s).
     **The bug:** the Mechanism motion was misread (§14.3), so the door crept at 1°/s.
   - **The gas** (fx/gas.ts, §14.2 "damage"):
     - **Timing.** From `755e`, Timers `6897` .. `689b` turn on the plume `6882..6884` and the
       floor tiles in waves: `6886` at 5 s, `6885` / `6887` at 7 s, `6888` / `6889` at 13 s,
       `688a..688c` at 15 s. The tiles spread from the tank door towards the window.
     - **The CartWheeler.** Timer `6f6b` (9 s) starts "CartWheeler" #210 (`6e67`, 7.56 s):
       CartWheeler `64f6`, sent to the window by Behavior Changer `75ae`, smashes Real_Glass `6342`
       and comes in. At the end Timer `8454` → Behavior Changer `7629` gives it KillEnemies `762a`
       against the player.
     - **Gas off.** Timer `5c21` (12 s after `6f6b`, so 21 s after the door) turns every fountain
       Off through Timer `689c`.
     - **Damage.** Each lit tile does 13/s of damage type 16 to a body that touches it, through
       the mover's own collision query (§14.2): the player's hit spheres, a character's mover. The
       player takes it in full (Player 2:5 lists no resistance; damage is not scaled by
       difficulty) [verified].
     - **Where the player survives** [verified data; the outcome inferred]. Each tile is one box,
       6 × 0.001 × 6 m, whose bottom face is the floor (both at 181566 / 2048 = 88.6553). The
       eight tiles cover x 411..429, z 445..463. Nothing covers the 1.1 m strip along the north
       wall (z 463..464.1), under the window the CartWheeler breaks in through, and the tiles
       light from the tank door (south row, 5 s) towards it (north row, 15 s). A player who
       waits there takes no gas at any difficulty. A player who stays by the entrance door
       50e7 stands in the first tile from 5 s and on the seam with the next from 7 s (26/s):
       dead 10.2 s after the tank opens on Medium, sooner on Hard (75 health) [port, measured].
     - **Immune.** The inmate resists type 16 (2:839, ×0) but not the tank's own gas (3:112,
       type 0, 10/s, on his 9999 health). Hermes is immune to everything (p5).
     - **The CartWheeler's damage.** It touches a tile with its mover (§14.2), so only while it
       stands on a lit one: it lands on the north row (688b, lit from 15 s) at 6.3 s into #210
       and goes for the player; on the strip under the window it is out of the gas. Its own hit
       spheres would not reach a floor tile (the lowest sit 0.36 m above its feet).
     - **Does it die?** Its health is 60 × Difficulty Modifier 10:238: 27 on Easy, 96 on Medium,
       132 on Hard, 156 on Impossible. A couple of seconds on a lit tile (13–26 damage) does not
       kill it on Medium or harder [inferred from the numbers].
     - **Hit reactions.** The port also plays a hit reaction on each whole point of gas damage,
       which pins it in place while it is in the gas. The original's hit-reaction picker
       (0x100e6480 → 0x1009e650, walking the Part Cap tables 10:973 / 10:108 / 10:953 / 10:954)
       is not decoded, so whether the gas stun-locks it in the original is open.
     - **Browser check, Medium** (before the touch test was decoded: a capsule with a 10 cm
       contact allowance for everyone). It went from 95 to 44 health and then fought the player.
       The player lost 12.8 hp/s on a tile.
     - **The leap in** [inferred]. #210 plays 12:4 then 12:11 with root motion extracted on every
       axis (key flags 0x155); 12:11 takes the root 0.3–0.7 m down for its last 1.2 s, the
       landing inside the room. Moved by that delta alone the creature stood 0.5–0.7 m in the
       floor until its release (the port did this; run 1 caught it at -0.52). The port now stops
       a character the extracted motion takes down on the floor under it, as the engine's mover
       would (the root delta goes to the anim component, 0x478b90 → +0x6c, not to the object
       matrix; its consumer was not followed) (`sequence/clips.ts driveFloorY`).
   - **Hermes `84ff`.**
     - **Wake-up [data chain verified].** He waits switched off (DormantBehavior 10:629, mode 2,
       wakes on On) in the tank. The Horace camera scene `8399` (after the guard is electrocuted)
       enables Detectors `8aad` and `8502` through Relay `8aae`. Detector `8aad` (the corridor
       north of the witness room) → Relay `8acb` → "Hermes" #283 (stands him up, 154 spawns his
       gas) and On (wakes him). Detector `8502` (the witness room door) → Behavior Changer `8500` →
       SimpleConversation `8501` (12:488, a voice line: the guard).
     - **Visibility [verified].** A DormantBehavior that ends in any way (woken or replaced)
       switches the character back on (end 0x100ecc60: vt +0x128(1), and its body-part set is
       shown; Noosemen excepted). The port does the same: in the browser he stands in the tank,
       at 85 %, with his six gas plumes.
     - **Why he is hard to see [verified data, inferred effect].** His skin is texture × 0x4b4b4b
       (0.29) added, at 85 %: about +0.06 on average. From the witness room he is behind the
       window glass Real_Glass (material 7:1885: one untinted additive pass of a white texture
       at alpha 0.5, lit), which adds about +0.4 over the whole pane. The port's additive pass
       (engine-light.ts `additiveEffectColor`, exact over a destination of 0.1) also gives a
       smaller rise over bright backgrounds than a gamma-space sum would. Up close in the lit
       witness room he shows plainly. Behind the window he was close to invisible.
     - **Resolved [verified]** (docs/re/renderer.md §5.1). The engine blends every pass on an
       8-bit back buffer of gamma values, and the port now does the same. Seen through the
       window, Hermes reads as a pale figure in the green tank. From the chamber's north side
       he stays hidden: that face of the tank is the solid, outward-facing panel 9:5350, and
       the tank's glass faces the witness room.
   Test: `tests/gas-chamber.test.ts`.

### 11.6 Level music: Combat Music [strong for triggering, guess for the mode / timing fields]

Music never starts at level load by itself. It comes from **Combat Music** objects (class
`0xcd739b63`, System; one input slot, p11), each a music configuration:

| prop | values seen (all levels) | use in the port |
|---|---|---|
| p0 | music list (category 2, looping) | track to play (first entry) |
| p1 | 1 / 2 | 1 = scripted cue: plays when triggered; 2 = combat music: plays only while hostile creatures hunt the player (guess) |
| p2 | 6-30 | seconds the music lingers after the fighting stops (guess) |
| p4 | 15-65 | minimum play time of a p1 = 1 cue (guess) |
| p7 | 3.5-7 | fade-out seconds (guess) |
| p10 | 0 / 1 | 1 = current from the level start |
| p11 | 1, 2, 153 | trigger message (input slot): whatever its senders send (On, Off, ...) |
| p3, p5, p6, p8, p9, p12, p13 | | not used |

Every level except 1a has exactly one object with p10 = 1 and p1 = 2 (combat music from the
start; nothing links to it). In **1a** all three have p10 = 0, so the intro and the walk out of
the cell have no music:

- `84bd` (p1 1, `7:17`/`7:18`): Detector `8b85` (destroy-after-trigger) sends On when the player
  enters it;
- `8b97` (p1 1, `7:138`): Relay `7a4b` On, fired when the STOMP "Camera" sequence `80d2`
  (`12:262`, started by Detectors `8a37`/`8a38`) finishes;
- `78a4` (p1 2, `7:17`/`7:18`): Off from Ambient Sound `802d` and from Relay `8b4e` (Timer
  `8398`): back to fight-driven music.

The port's earlier audio code started the first music object of the level at load, i.e. 1a's
`78a4` (intense combat tracks `7:17`/`7:18`) during the intro. Now `src/game/world/music.ts`
listens to the dispatcher: the most recently triggered object becomes current; p1 = 1 starts
its track at once, p1 = 2 waits for a fight (a living hostile or provoked actor in chase /
attack within 30 m of the player, not during cinematics). Verified headless: no music-bus sound
during or after "Goose" (108 effect, 11 dialog, 1 GUI plays to 45 s, then skipped); entering
Detector `8b85` starts `7:17` (log: `current (message 1)` → `start`), and Off to `78a4` hands
over to combat mode (fades out with no fight on).

## 12. Lip-sync [strong]

Code: `src/app/lipsync.ts` (jaw setup, envelope sampling, angle mapping, additive driver),
`src/game/actors/lipsync.ts` (game system / `services.lipsync`), `AudioSystem.lipSync()` and
`SoundHandle.position()` in `src/app/audio.ts`.

**Envelope.** Dialog sounds carry a `.sdu` type-5 entry with the sound's id: 25 frames per second
(44100 / 1764), one u16 per frame, 0..0x7fff, scaled per line so its loudest frame is near full
scale (median per-line peak 0.98). Frame *i* describes audio window [i, i+1) / 25 s: over 150 lines
the envelope correlates best with the audio RMS at zero offset (mean r = 0.93; ±1 frame: 0.80 /
0.62).

**Jaw bone.** Name hash `0x30cb6f7d`, a child of the head bone `0x07c159a2`. On the human rigs its
pivot sits just in front of and slightly above the head joint and its skin weights cover the chin,
lower lip and lower teeth (78 vertices on prisoner model 10:20, average weight 0.7). 50 of 190
skinned models have it (NPCs and System packages); the player model 2:9 does not. 883 of 1924 clips
key it (rest poses differ slightly per clip), so lip-sync must be layered on top of animation.

**Template properties** (Suffering.rfl; found from the string "Attempting to update jaw with no
amplitude data!"). The lip-sync helper object is set up from three Character properties, read
with the class's property getter:

| Class | Bone (SignedInt) | Max angle (Float, degrees) | Axis (Bool/enum: 0 X, 1 Y, 2 Z) |
|---|---|---|---|
| every Character class except Player | p118 (0x76) | p119 | p120 |
| Player | p124 (0x7c) | p125 | p126 |

The bone is a skeleton bone **index** (-1 = no lip-sync). Every retail template that sets it
points at the `0x30cb6f7d` bone of its model: human guards / prisoners (Unspeakable NPC) mostly use
index 50, 10 degrees, axis Z (a few 5-8 degrees); creatures with a jaw: Hermes, Horace, Inferna, Killjoy
(5-10 degrees, Z), Mainliner (20 degrees, axis X). Player, Burrower, Fester, Nooseman, Rat, Slayer,
CartWheeler and Torque-as-NPC templates have -1.

**Per frame** (`0x1012cfe0`): elapsed time since the line started (accumulated game time) is turned
into a sample position at 44.1 kHz plus a fixed 2500-sample (57 ms) look-ahead, divided by the
frame step (1764) to get frame and fraction (clamped to the last pair), and the two neighbouring
frames are interpolated linearly. The angle is `raw * 4e-5 * maxAngle * pi/180`, so a full-scale
frame opens the jaw about 1.31 x maxAngle (13.1 degrees for humans). A rotation matrix about the
chosen axis is built from that angle and hooked into the bone's per-bone extra transform (the
bone node's +0x10 pointer), so it is applied in the bone's own frame on top of the animated pose.
When no line plays the matrix is reset to identity.

**Port.** The jaw quaternion becomes `animated * axisAngle(axis, angle)` each frame (positive
angle opens the mouth; checked on guard and prisoner heads). The engine's 57 ms look-ahead stood
in for DirectSound output latency; here the envelope is sampled at the *audible* position of the
sound (`AudioContext.getOutputTimestamp`, else `currentTime - outputLatency`) plus one display
frame, with frame centres as the interpolation points. Who speaks:

- STOMP sound keys: the object of the track holding the key (actor, or the player puppet).
- Clip sound cues: the actor playing the clip.
- Sound Effect objects: the actor in their attach property (p10), else an actor standing within
  1 unit of the sound. Retail dialog Sound Effects (125) are never attached to a Character; most
  are radios / off-screen voices far from any NPC.

The jaw closes when the handle stops, ends or is skipped. Measured in level 1a's intro "Goose"
(headless browser, 60 fps): over 17 lines, the jaw angle and the heard voice-bus RMS line up
within 24 ms (0.6 envelope frames), mostly within 10 ms.

## 13. Insanity, creature form and screen effects

Code: `src/game/insanity/` (`params.ts` template reading, `rules.ts` the renderer-free meter /
form state machine, `classes.ts` level classes, `screen.ts` blur / fader / time-scale runtime,
`effects.ts` the post-processing chain, `creature.ts` the creature body, `system.ts` wiring and
`services.insanity`). Test: `tests/insanity.test.ts`. Method as in §11: factory → constructor →
message map → static initializer for the handlers; Player code read around `0x10032a70-0x10033ae0`,
the input handler at `0x10049850` and the per-frame code at `0x10043b56-0x10043f70`.

### 13.1 Player state [verified unless marked]

Fields of the Player object: meter `+0x458`, kill-combo timer `+0x45c` and count `+0x464`,
points of kills made while transformed `+0x468`, reputation `+0x454`, adrenaline `+0x43c`,
heartbeat timer `+0x444`, breath timer `+0x440`, the active Insanity Screen Flash `+0x4a0`.
States are a bit set at `+0xa4` (`0x101207c0(n)` enters state n, `0x101208d0(mask)` leaves every
state not in the mask): state 20 (`0x100000`) = transformed, state 19 (`0x80000`) = morphing
(entered for both directions). Two flags at `+0x9c` come from Allow Player Insanity Object:
`0x80` = transforming forbidden, `0x100` = meter gain forbidden.

All tuning is read from the Player template (`2:5`); while transformed the engine reads the same
property indices from the creature-form Player template named in `p253` (`2:240`, model `2:124`,
whose own `p253` points back to `2:5`).

| Property | Meaning |
|---|---|
| p258 | meter maximum (100) |
| p70 / p71 | reputation range (-150 / +150) used to weight the next two pairs |
| p80 / p81 | meter-gain scale at the evil / good end (lerp, clamped) |
| p82 / p83 | meter drain per second while transformed, evil / good end |
| p259 | kill-combo window (s); p260 / p261 multiply the 2nd / 3rd+ kill inside it |
| p262 | multiplier applied when an unidentified player flag (`+0x98` bit 0) is clear [not applied by the port] |
| p263 | multiplier for a damage-type-3 kill (read as melee) [meaning inferred] |
| p264 | multiplier while the held item is a Melee Weapon (class `0x22e48520`) |
| p257 | health lost per second while transformed with an empty meter (creature template: 5) |
| p302 | low-meter warning threshold, % of p258 (fires a player event once) |
| p255 | Character Morpher: model, p3 morph clip, p4 duration (human→creature 2.8 s on the creature rig, creature→human 1.2 s on the human rig) |
| p265 / p266 / p267 | Screen Blur, tint Screen Fader, flash Screen Fader used for the transformation [use inferred] |
| p38 / p39 / p40 | adrenaline decay per second, maximum, minimum |
| p60 / p61, p62 / p63, p64 / p65 | heartbeat period (s), volume (%), pitch at adrenaline 0 / 100 |
| p52 / p53, p50 | breathing period at adrenaline 0 / 100, breathing sounds |
| p58 / p59 | heartbeat sounds |
| p270 / p271 | lens values pulsed with the heartbeat (55 / 62) [amplitude handling inferred] |
| p143 | Player Weapon Properties: p13 idle, p18/p19 walk clip + speed, p20/p21 run clip + speed, p23/p25, p28/p30, p33/p35 the 135/225/315 degree sets, p86 attack combo, p89 alternate attacks, p90 jump attack (Attack templates: p0 clip, p3 follow-up, p6 damage scale [inferred]) |
| p276 | Insanity Attack Templates (p0 thresholds 1/200/300/600 compared with `+0x468`) [not used in chapter 1] |

### 13.2 Rules

- **Meter gain** [verified]: when a creature is killed by the player (`0x10033890`, called from the
  NPC death paths with the victim), reputation += the amount the caller passes (victim p166 + its
  attached Action Dialog's p22 when unpaid, §13.2 "Reputation sources"; always), then,
  if transformed, `+0x468` += victim p66 and nothing else; if gain is forbidden nothing; else
  gain = victim p66 × lerp(p80, p81, reputation) × multipliers (p263 melee kill, p264 Melee Weapon
  held, combo: 2nd kill within p259 s × p260, 3rd and later × p261), clamped to p258; the combo
  window restarts at p259. Victim p66 in chapter 1: Rat 2, CartWheeler 17, Slayer 20, human NPC 25
  (some placed guards override it). Damage that does not kill gives nothing; the meter does not
  fill over time.
- **Transforming** [verified]: the Insanity key (action 0x42d) does nothing while the `0x80` flag is
  set; when not transformed it needs meter ≥ p258, takes 1 point off the meter and enters the
  morph state (with a weapon in hand, the put-away animation p256 first). Pressing it again while
  transformed starts the morph back (no meter check). Toggle Player Insanity Object transforms
  without the meter check. In the port Q is the key, the morph lasts the morpher's p4, movement is
  held during the morph [inferred], and the camera goes to third person (creature template p353 is
  0 where the human's is 1) [inferred].
- **While transformed** [verified]: the property set is the creature template's; the meter drains
  lerp(p82, p83, reputation) per second (2.25 evil … 4.25 good, 3.25 neutral: ~30 s from full), not
  during the morph; on crossing p302 % a warning event fires once; at 0 the player loses p257
  health per second until changing back (there is no automatic change back on an empty meter).
  Kills add to `+0x468` instead of the meter. Adrenaline is forced to (1 − meter / p258) × 100.
- **Changing back**: the key [verified], Toggle object p5 (also empties the meter) [verified], and
  the cinematic entry points (`0x10042650`, `0x10043a60` call the change-back routine)
  [strong]; the port also changes back instantly on death and level change [inferred].
- **Creature form in the port**: model 2:124 with anim set 379; locomotion clips and speeds from
  the creature Player Weapon Properties (forward run 9.28 m/s vs the human's 6.64: walk and run
  speeds × 1.40); left mouse = the p86 combo (5 swings), right mouse = the p89 alternates;
  hits and damage as decoded in §13.9. Human weapons are disabled (`services.weapons.setEnabled(false)`
  and a capture-phase mouse listener).
- **Reputation** [verified]: Reputation Points Message Filter passes when p1 < reputation ≤ p2.
  What changes it: "Reputation sources" below. Stored in `services.insanity.reputation`, saved
  with the game (scope 'game') and carried between levels; no clamp (the ±150 of p70 / p71 only
  weights the meter rules).
- **Reputation sources** (`insanity/reputation.ts`, census: `npx tsx tools/reputation-census.ts`,
  test `tests/reputation.test.ts`). The Player's add (0x10041460: += amount, then the skin
  update, §13.6) has five callers in the game code [verified: every call site]:
  1. *Reputation Points Sender* (input p1, 0x1008e510): p0 is the target mode (0 the message's
     sender, 1 the player, 2 each link); the apply (0x1001a7c0) runs once per target found and
     always adds p3 to the player. The port read p0 as an enable flag (p0 0 gave nothing); every
     placed sender has p0 1 and no links, so each applies once [verified, data].
  2. *A Character killed by the player* (Character damage 0x100e7519..0x100e75fa: dead now, not
     before, the damager is the Player): victim p166 + its attached Action Dialog's p22 unless
     paid (0x1008d300), then the victim fires its **output p169** ("killed by the player"). The
     level logic hangs most of the moral choices on p169: an execution or a companion's death
     reaches a Timer / Relay and a Sender (2 308b -> -10, 4a 5b7b -> -15, 8a 281d -> -10, 9's
     three prisoners -> -10, 10's guard 7b8 -> Timer 10d8 -> -10, 1b's CartWheelers 8b46 / 8b47
     -> Sender 8b63 -5 each ...). The port never fired p169, so none of those penalties (nor the
     Count Downs and lines on the same outputs) happened [fixed]. Only two characters carry a p166
     of their own: 1a's guard 609e and 1c's inmate 7569 (-10 each); no template does.
  3. *Action Dialog count* (0x1008e130, run from the same damage code for a player's hit of
     damage > 0 on an NPC whose attached dialog is the NPC's handle +0x5a2): a hit closer than p14
     s to the last counted one is not counted, a gap over p19 s starts the count again, nothing is
     counted while the NPC's AttackedByPlayer behaviour (type 0x7c) runs; at the p18th counted hit
     the dialog pays p22 once (flag 0x40: the kill then adds nothing more) and enters its state 4
     (the update 0x1008dda0 then fires p30 to the links: §15.10 "Scripted protection"). Not
     counted while the NPC bleeds from a cut (0x10040d10 reads +0x536, the Part Cap component's
     bleed rate, §15.16). 11 dialogs pay -5: 1a 827a, 1c 7edc,
     2 1c77 / 1c78, 3a 321b, 5b 2ac3 (p18 999: only the kill), 6b 1574, 8b 1820, 9 e6e (p18 1: the
     first hit) / e6f, 10 94b [data]. The port had none of it [fixed: the reputation part, and the
     warnings and the turn (director.ts dialogWarn / dialogTurn); the port's immediate turn at
     the first hit is gone].
  4. *Ambient Creature killed by the player* (vt +0x90 0x100916f0, the PhysicalObject damage
     code's death call with the killer): += p26, -2 for every one of the 74 placed (the rats,
     crows) [verified; fixed: the port read p166, and built them as decorations that took no
     damage: §15.3 "Ambient Creature"].
  5. *Part Cap* (the Character p16 body-part reactions, 0x10119150): a part cut off by the
     player from a body dead more than the cap's p4 (5) s: += p5 (-2) [verified]. Dismemberment
     is ported (§15.16) [fixed]; browser: 1a's corpse 7b36 (dead from the start) cut by a claw
     blow: −2.
  Two Switches in 10 Docks (13a8 -> Sender 13ad -90, 13aa -> 13b1 +200) set up the endings
  [data: placement not checked]. Everything else is level logic: the census lists per level each
  sender, its amount, what fires it and where the chain starts (an NPC's p169, a Waypoint's
  arrival, a STOMP's output, a Switch, a Detector), the dialogs, the kill rewards, the filters
  and the Part Caps.
- **Adrenaline** [verified]: Adrenaline Template (p0 amount, p1 per second, p2 cap, p3 clamp to the
  cap, p4 floor, p5 clamp to the floor) moves the value towards the cap without crossing it;
  ignored while transformed. Per frame: −p38 per second, clamped to [p40, p39]. Heartbeat every
  lerp(p60, p61, adrenaline %) s at volume lerp(p62, p63) % and pitch lerp(p64, p65); breathing
  every lerp(p52, p53) s. The port only plays them above a small adrenaline level [inferred].

### 13.3 Level classes [verified from the message maps / filter predicates]

| Class | Slots and behaviour |
|---|---|
| Allow Player Insanity Object | p3 clears `0x80` (may transform), p4 clears `0x100` (meter fills), p5 sets both. 1a: the intro Timer forbids both, Timer `89f4` allows both; 1b: Timer `82dc` (level start) forbids both, the basement scene (Relay `7ece`) allows both and shows the transform hint (an <Insanity> control placeholder) |
| Toggle Player Insanity Object | p3 fills the meter (sets p258), p4 transforms if not transformed, p5 changes back and empties the meter. Not placed in chapter 1. |
| Insanity Mode Message Filter | forwards any message when (p1 = 0 and transformed) or (p1 = 1 and not). 1b uses both to continue the basement scene only once the player has transformed. |
| Insanity Meter Message Filter | forwards when meter % ≥ p2 (p1 = 0) or ≤ p2 (p1 ≠ 0). Not placed in chapter 1. |
| Reputation Points Message Filter / Sender | see 13.2. |
| Adrenaline Sender | on p1: applies the Adrenaline Template p3 to the player; p2 destroys. |
| Insanity Screen Flash | p0 = on at start, p7 on, p8 off: registers itself with the player. While registered, the meter is ≥ p1 (99.99 = full), the player is not transformed and no cutscene runs, a timer counts down by dt / (p5 × k) and on expiry spawns one of the p6 Screen Fader templates (shuffled, no repeats): the hallucination images that tell the player the meter is full. k comes from p2…p3 and a random factor within p4 % (partly inferred). |
| Screen Blur | p0 on at start, p12 on, p13 off, p14 destroy. Phases k = 0 in, 1 hold, 2 out with duration p(4k+3) (-1 = until Off) and targets A = p(4k+4), B = p(4k+5) (out: 0) eased linearly; C = p(4k+6) goes to the sound mixer (two bus levels; not applied in the port). A × 0.01 and B × 0.01 go to the engine's screen blur together with the mode p2. At the end destroyed when p1. |
| Screen Fader | p3 on at start, p15 on (the message varies), p14 destroy. On the first active frame it fires its output p17 (that is what starts the slow-motion / blur / adrenaline chains of the visions). Fade-in p0 s to alpha p8, hold p1 s, fade-out p2 s; colour p7, optional full-screen texture p6, sound p9 played at the start (p10 = 0), at the hold (1) or at the fade-out (2); destroyed at the end when p4. |
| Time Scale | p3 on: game clock → p0 % over p1 s; p4 off: back to 1 over p2 s; p5 destroy (resets to 1). |
| Movie Player | p10 plays video p0 (overlay, its soundtrack paired by the cutscene library), p12 stops, fires p13 when it starts and p14 when it ends, destroys itself after when p3. 1a `8182` (12:2), 1b `8b67` (12:5), 1c `8094` (12:4): the flashback visions triggered by Detectors; 1a `8433` has no video and just fires its GUI Launcher. |

### 13.4 Screen effects in the port [renderer side inferred]

The EXE's "HDR ScreenBlur" renderer was not decoded. The port renders the scene into a
half-float target and runs a feedback pass: `comp = mix(scene, previous comp sampled with the uv
zoomed by B, A)`, which gives the smeared, slightly radial trails of the visions and of the
creature form. A present pass adds the untextured fader colour (tint / fades), the textured
fader image, and an edge darkening while transformed. The chain is installed through
`LevelRenderer.postProcess` only while something is visible; Time Scale sets
`LevelRenderer.timeScale`, which scales the dt of the player and every game system.

### 13.5 Key binding

The Insanity action is input id `0x42d`. The RFL's default control tables (records
`{-1.0, 1.0, action, device, code}` at `0x1016752c`, 111 entries, and four 65-entry presets
from `0x10167ddc`) bind it to DirectInput key `0x2E` (C) in the first table and `0x9D` (right
Ctrl) in the presets. The port already uses C for crouch, so Insanity is on **Q**, which is what
the HUD's control table (`src/game/hud/controls.ts`) prints for `<Insanity>` in help popups.

Reputation Points Senders are handled by the insanity system's class handler; the actors
director (`src/game/actors/director.ts`) reports them as well, and
`services.insanity.addReputation(points, fromUid)` ignores calls coming from a sender so the
points are not counted twice.

### 13.6 Reputation and blood skins (Torque's look)

Code: `src/game/actors/reputation-skin.ts` (decoding and rules, no renderer) and
`reputation-skin-system.ts` (applies the textures). Test: `tests/reputation-skin.test.ts`.
RFL code read: the skin component's init `0x1002ffb0`, add `0x10099c00`, update `0x10099f70`,
apply `0x10099cf0`, the Player's reputation hook `0x1002b5e0` and its add / update overrides
`0x1002b2f0` / `0x1002b4b0`, the Item version at `0x1013b960`, Blood Point Generator `0x1000ff50`.

**Two axes** [verified]. Torque's skin depends on his **reputation**, which picks a *suite*, and
on a **blood level**, which picks a *set* inside it. Neither blends: a set's materials are
swapped in whole.

- **Suite** ("Reputation Point Based Blood Texture Set Suite", groups `3003.2`): p0 is the list
  of Blood Texture Sets, p1 the lowest reputation it applies from (f32). The suite's own template
  model (2:9, or 4:15 on every weapon suite) is only an editor placeholder. The suite applies to
  whatever model its owner has.
- **Blood Texture Set** (`5003.2`): p0 is the materials, p1 the lowest blood level it applies
  from. Material *i* replaces material slot *i* of the model. Slots past the end of the list
  keep their own material.
- **Selection** (one loop for both): the last entry whose p1 ≤ value, or entry 0 when none
  matches. The lists are stored sorted ascending, so the bounds are inclusive lower bounds. A
  Reputation Points Message Filter uses `p1 < rep ≤ p2` instead.

**Player** (template 2:5) [verified]:

| Property | Meaning |
|---|---|
| p66 | body suites, one per reputation tier: 2:693 (from −99999), 2:827 (−90), 2:682 (−30), 2:806 (+30), 2:681 (+90) |
| p67 | first-person arm suites: 2:694 five times, so the arms only show blood, not reputation |
| p68 | blood level maximum (50) |
| p69 | blood lost per second (0.5) |

The component keeps two channels: 0 is p66 and 1 is p67. The model swap into first person
(`0x10042400`, model p227 = 2:138) switches to channel 1, and the swap back switches to
channel 0. The body sets have three materials (slot 0 vest, slot 1 trousers, slot 2
head / arms), and their blood thresholds are 0 / 10 / 20 / 30 / 40. The arm sets are
(arms, helper box) at the same thresholds.

- Evil suites are grimy and pale, with scars on the face.
- The good suite has a white vest and a clean face.
- The neutral suite at blood 0 is clean.

**Weapons** (Ranged / Melee Weapon) [verified]: p61 is a one-suite list, p62 the blood maximum
(100) and p63 the loss per second (0.5; 4:251 uses 5). Items have no reputation hook, so a weapon
always uses its suite 0. Its sets start at blood 0 / 10 / 20, and set 0 is the weapon model's own
textures for every weapon. The Player's "add blood" passes every change on to the items in both
hands (handles at Player `+0x3c6` / `+0x3c8`), including the per-frame loss.

**When it changes** [verified]:

- The suite index is worked out again inside every reputation change: `0x10041460` (kills and
  senders), the debug cheats (±50, and set to p70 / p71), and at spawn.
- The update (every frame) loses blood (`-p69 × dt`, clamped to `[0, p68]`) and picks the set.
  It applies the materials when the suite or set index changed, so a change shows on the next
  frame.
- Save and load store the blood level and the suite index (`0x10099ba0` / `0x10099bd0`).
- While the player is morphing or transformed, the human update does nothing: there is no loss
  and no swap. The creature model (2:124) is never reskinned.
- Change-back code also fills the level to the maximum and applies the last set when the level
  was at the maximum (flag `0x20000000`). Modelled since: see §13.7.

**Where blood comes from** [verified]:

- The only source in the code is the **Blood Point Generator** (`0x1000ff50`). When spawned, it
  adds `p0 + (p1 − p0)(1 − d / p2)` to the player if he is closer than p2 model units (×2048 in
  code) and inside its cone of p3 degrees (full angle). The only template, FX 3:2305 = 5 / 10 /
  50 / 360, gives 5 at 50 units, rising to 10 at the generator, in any direction.
- The only template that spawns 3:2305 is Object Generator 3:1608, which also makes two red
  Particle Fountains. Its only placements are 1a #7489 and #7f1b, driven by message tracks of
  STOMP Player #6206.
- Flesh impacts (Missile / Melee Weapon Material Effects) do **not** spawn it. In the shipped
  data Torque gets bloody from those scripted moments and the cheat, not from fighting.
- A cheat switch (`0x10001440`) offers rep −50 / +50, blood full and blood clear.

The §17.3 table's reading of the generator's p0..p3 (drop elevation, spread) was a guess for
the port's spray visuals. The code uses them as above.

**New game** [verified from data]: reputation 0 and blood 0 select the neutral suite 2:682,
set 0: textures 2:112 / 2:122 / 2:117, which is a clean Torque. The model's own materials
(2:708 / 2:707 / 2:706) are the *most evil* suite at blood 10. The port used to draw those, so
Torque started dirty.

**Also reputation-dependent** (done since, §13.7): Player Weapon Properties p14 lists "Reputation
Idle Anim Sets" (p0 idle clips, p1 lowest reputation: −999999 / −50 / +50). Torque's idle
fidgets change with morality as well [data].

**Port** (`reputation-skin-system.ts`):

- Every frame it retextures every instance by setting `material.map` on the existing materials.
  The covered instances are:
  - the body (2:9) and arms (2:138) of `services.actors.playerBody`;
  - the held weapon models under them, matched to `services.weapons.current`;
  - the STOMP puppet (`stomp-player-puppet`);
  - any other 2:9 / 2:138 mesh, such as the creature form's morph-back rig, found by a scene
    scan every 0.5 s.
- Character materials are matched to slots by name (the slot's default texture key). Rigid
  weapon meshes are matched by `readModel` submesh order.
- Blood: an observer at the head of `services.world.fx.spawners` sees Blood Point Generator
  spawns (and lets the fx system draw them). The held weapon gets the same additions and loses
  blood at its own p63 [inferred: the original passes the player's loss on instead].
- Save: provider `repskin` (game scope: blood levels) holds the blood levels. Reputation comes
  from the insanity provider. New Game resets the blood to 0.
- Debug: `window.__repskin` (`state()`, `setBlood(n)`, `addBlood(n)`). Set reputation with
  `__insanity.model.s.reputation = n`.
- **Was a gap**: the port's world fx fired Object Generators that no link points to at level
  load and ignored later On messages to a mode-2 generator, so #7489 / #7f1b (driven only by STOMP
  message tracks) fired once at load, before this observer existed. Placed generators now start
  by p24 (both have 0) and every On starts a run again (p22 0; §14.2 Object Generator), so their
  blood comes with the sequence's On keys [not rechecked in the browser].

### 13.7 Player actions, insanity attacks and related findings (this pass)

- **States** [verified: state table 0x10176488, names at +0x38, id at +0x34; handlers at +4 enter,
  +0x14 per frame, +0x24 leave of entry n for state n]: 1 Move, 2 Aim, 3 Attack, 4 MeleeAttack,
  5 Turn, 6 Idle, 7 IntermittentIdle, 8 Jump, 9 Fall, 10 Pitch, 11 Controlled, 12 Landing,
  13 Jump Attack, 14 Jump Melee Attack, 15 Roll, 16 First Person, 17 Hit Reacting, 18 Reload,
  19 Morph, 20 Insanity, 21 Throw, 22 Interact, 23 View Monitor, 24 Camera Yaw, 25 Equip,
  26 Item Pickup, 27 LadderClimb, 28 Look At, 29 Insanity Attack, 30 Insanity Attack
  Acquisition, 31 Document View, 32 FP Melee Attack, 33 Play Anim, 34 Freak Out.
- **Default PC keys** [verified: RFL table 0x1016752c]: action ids 0x3ff Map (G), 0x400 Documents
  (V), 0x401 Archives (B), 0x409/0x40a forward/back, 0x40f/0x410 strafe, 0x411 run, 0x428 Fire
  (mouse), 0x429 Throw, 0x42a Jump (Space), 0x42b Use (Left Alt / Enter), 0x42c First Person
  (Left Ctrl), 0x42d Insanity (C), 0x425 Reload (R), 0x426 Flashlight (F), 0x427 Flare (T),
  0x432 / 0x433 Roll Left / Right (Q / E), 0x434.. weapons 1..0, 0x43f / 0x440 prev / next
  weapon, 0x42f inventory (I). The port keeps its own key set (bindings.ts) and puts the rolls on
  Z / X; the engine-only "last weapon" X hotkey was dropped for that.
- **Roll** [verified 0x10049760, 0x1003aa00]: Roll Left / Right set +0x9c 0x80000 / 0x100000 and
  enter state 15, which plays the held weapon's Player Weapon Properties p166 / p167 (every set:
  2:95 / 2:106, ~0.9 s, 3.9 m of sideways root motion). Port: src/game/hud/actions.ts.
- **Idle fidgets** [verified 0x100485c0 / 0x100487d0 / 0x10048f70 / 0x1004b730]: entering Idle
  sets a timer of p139 ± p141 s; on expiry, if no live creature is within p241 × 2048 units, state
  7 plays a random clip (never the previous one) of the held weapon's p14 set with the highest p1
  not above the reputation; the timer then restarts at p140 ± p142. Crouched idle not handled by
  the port [inferred]. Port: player-body.ts (`fidgetContext` from the insanity system).
- **Unarmed attack** [strong]: with no weapon the attack uses the Player's p143 (2:409) Attack
  2:376 (strike 2:124, recovery 2:212; first person 2:393 = strike 2:218). Arm markers arm the Melee Weapon attached
  at the hand (0x10073889 -> 0x10095750: only class Melee Weapon); the human has none (Player p231
  empty, the creature has 4:155 / 4:832), so the original's empty-handed swing does no damage.
  The port's punch deals 2 × Attack p6, type 10 [engine addition].
- **Meter gain p262** [strong]: applied when Player +0x98 bit 0 is clear; that bit is cleared by
  the jump / fall code and set by landing (0x1003a8d0), so p262 (1.4) rewards kills in the air.
- **Insanity attacks** [verified 0x100338b3, 0x10033ae0, 0x10033e00, 0x10033ec0, 0x10049e63]:
  points of kills while transformed accumulate in +0x468 (kept across transformations and
  levels); when the next template's p0 is reached, state 30 plays p275 (creature 2:717) and the
  index +0x46c advances (at most 5) and the points reset. Jump while transformed enters state 29:
  the current template's p2 clip; its routine spawns p10 at the player, p4 at each target after a
  p8..p9 s delay; the p3 Object Generator carries the Radius Damage. Port: insanity system, Space
  in creature form; saved in the insanity provider (attackIndex / attackPoints).
- **Creature hits**: the creature's p231 arm weapons 4:155 / 4:832 (Melee Weapon p68 / p69, type
  p70) replace the earlier p54..p55 reading; p51..p57 are breathing values (read with the
  adrenaline at 0x10043737). No creature damage resistance was found: p38..p40 are the
  adrenaline decay / max / min (0x10043e17..0x10043ea6), not resistance.
- **Low meter** [verified 0x10032dcb, 0x10041740]: crossing p302 % fires player event 9: the
  form's p292 + 9 = p301 template, a Help Popup (5:669) shown once per game (+0xa0 bit 9). It is
  a help text, not a voice line.
- **Put away** [verified 0x10049924..0x1004999e]: with a weapon in hand the key takes 1 point,
  enters Play Anim (33) with p256 (2:711, 3.4 s); without one it enters Morph (19) directly.
- **Change back and blood** [verified 0x1002b2f0, 0x10033189, 0x1002b3f0]: blood added while
  transformed only sets +0x98 0x20000000; the change back (or a level already at the maximum)
  fills the level and applies the suite's last set. Port: services.repskin.changedBack().
- **Screen Blur C** [inferred bus choice]: the eased C values scale the effects and music buses
  (lowest of the running blurs).
- **Flashlight** [verified 0x1001460f]: the charge at +0xa4 drains dt / Difficulty Modifier
  (p70) while on; the port's drain uses services.difficulty.flashlightDrainScale().
- **Map** [verified from data]: Map GUI (UIP 18, #200), Map Items with p55 × p56 images in
  128-pixel p58 tiles (p57 0 = note), the level map Level Properties p45 / Map Switcher, the
  Player's p247 island map. Port: hud/map.ts + menu/screens/map.ts (list, wheel zoom to the
  display's p16 %, click to centre). Cell / frame artwork of the original screen not drawn.
- **Inventory 3D icons** [data; brightness reading inferred]: the GUI Inventory Cell's 3d Icon
  templates (#159 focused / #160 normal) spin at p26 = 30 deg/s and differ only in p25 (1 /
  0.5), taken as brightness; the model is the item template's own. Port: hud/icons3d.ts, a
  second small renderer on a canvas over the HUD, drawing only while the strip shows; items
  without a model keep their name.
- **Tests**: tests/insanity.test.ts (p262 in the air, attack unlocks and their persistence,
  put-away before the morph, the one-shot low-meter event), tests/player-actions.test.ts
  (reputation idle-set choice, the unarmed props' sets / attack / roll clips).

### 13.8 Vision creatures (Torque's monster self) [verified unless marked]

The figures of Torque's creature form that run past in 1a and 1b are placed Unspeakable NPCs
(template 10:593, model 2:124: 1a 7a78 / 7aa0 / 7aa8 / 7afe, 1b 7ea7), not STOMP tracks or
movies. A Detector (or monitor 6737's view, through Timer 7b02) fires a Relay that hands the
creature a WaypointBehavior through a Behavior Changer and turns on a Screen Blur (3:2190 /
3:2619: alpha mode, A 60 / 45 % for as long as it runs, B 0.3); the last Waypoint sends Destroy
(p0 = 12) to the creature and, through a Relay, Off to the blur. Every one of their Waypoints
(10:601) has p1 = 1: they **run** (§15.2), on MovementAnimBehavior 10:597's p5, clip 2:137
(0.73 s, 9.3 m/s of root motion). The growl is that clip's own sound cue: a kind-0 event at
t = 0 that draws from the pool 2:227..2:232 (never the same twice in a row) every cycle, not
restarted while one still plays (docs/re/animation.md §7). Port: the gait comes from Waypoint
p1 (it read p2 = 0.7 as a speed factor and walked them at 2.3 m/s), Waypoint runs move at the
run clip's speed, and looping clips now voice their cues (actor.ts `playLoopCues`; before, only
one-shot clips did). They take damage without fighting back (WaypointBehavior p3 = 2, §15.12).

### 13.9 Creature-form melee hits

**The original** [verified unless marked]:

- **Arming.** A strike clip arms the Melee Weapon on a bone at an **Arm** marker (100) and
  disarms it at the next **Disarm** (101). For the player the path is the Arm handler 0x100286f0
  → 0x10027c60 → arm 0x100ca210. Arming clears the weapon's list of targets already hit.
  - Disarm (0x100ca4c0) waits until at least one sweep has run.
  - A clip with no Arm marker deals no damage. The alternate attack 2:370 is one such clip.
- **The sweep** (per frame 0x100cb6c0 → 0x100caff0). The weapon model's sphere nodes are moved
  from their previous position to their current one:
  - two nodes form a segment, and the quad it sweeps is tested;
  - a single node is a sphere of its radius, swept along its path.

  The creature's weapons (Player 2:240 p231 on the p232 bones of rig 2:124):

  | Weapon | Bone | Model | Shape |
  |---|---|---|---|
  | 4:155 | 31 | 4:36 | segment, x −0.023 … 1.177 |
  | 4:832 | 22 | 4:135 | sphere, radius 0.65 |

  The shapes are data. Reading their units as metres is [inferred].
- **What is tested.** Targets are tested by the leaf spheres of their skeleton sphere tree
  (0x100c9680).
  - Each target is hit at most once per Arm window, but one swing can hit several targets.
  - The wielder and anything attached to it are never hit.
  - A ray from the wielder (its x / z, at the hit's height) to the hit point must be clear
    (0x100c9490).
  - Nothing checks facing or a cone.
- **Damage** (0x100ca920) = Melee Weapon **p68** (flat) × the Attack's **p6**. p69 is the
  impact force (× Attack p7), not a maximum. p70 is the damage type.
  - Both creature weapons: p68 = 35, type 8. The combo's p6 values are 1, 1, 1, 1, 1.5, so the
    blows deal 35, 35, 35, 35, 52.5. Alternate 2:366 has p6 = 2.
  - A player's blow on an Unspeakable NPC is also scaled by lerp(Player p78 = 0.75, p79 = 1.25)
    over reputation p70..p71.
  - The earlier reading (the midpoint of p68 / p69, 27.5) was wrong.
- **Who takes damage** (character damage 0x100e7390, NPC 0x10087010):
  - an attacker on the player's team does nothing to a victim on that team;
  - invulnerable characters take nothing;
  - NPC p167 = 2 (Torque's creature-self visions 10:593, 10:1207, 10:1208, 10:1219): while the
    player is transformed, the blow is **reflected onto the player**;
  - NPC p167 = 1 (the human-self vision 10:1129) can be hurt only in creature form.
- **Air.** The creature has no air attack: its PWP p164 is empty, so attacking in the air does
  nothing. Its p90 list is never read, so there is no slam. Jump in creature form is the
  insanity attack (state 29).
- **Sounds** [verified]: Melee Weapon p74 holds the swing sounds and p71 the hit sounds. §4.4
  had them swapped.
- **Melee auto-face:** Player p173 = 350 °/s is the turn rate "while auto-facing the melee
  target with no turn input" (docs/re/player.md §12). How that target is picked was not
  traced.

**The port** (`src/game/insanity/melee.ts`, `creature.ts`, `system.ts`):

- Each strike clip's Arm windows come from its .adu events. Every frame of a window, the weapon
  shape on its bone (the bone's world matrix) is swept against the targets.
- Targets are approximated by the actor's capsule (radius, bottom .. top) instead of skeleton
  spheres [inferred stand-in]; a dead body (struck only while it has Part Caps left, §15.16) is
  tested on its leaf hit spheres.
- The rules above apply: each target once per window, the wall check, p68 × p6 (× the NPC
  reputation scale), type p70, the player's team skipped, and p167 = 2 visions reflecting the
  blow.
- The damage point is the contact on the claw, so head and weak-spot filters see where the
  blow landed.
- At the start of a swing the body turns at p173 = 350 °/s toward the nearest target ahead of
  the view within 3.5 m, or else to the view [inferred target choice].
- **Removed:** the 3 m air slam.

**Why the player's attacks did no damage before:** the hit was a single 2.4 m + body-radius,
70° cone test around the body's facing, at 40 % of the clip. Since the third-person gait
(843cb31) the body can face up to a heading set's offset away from the view. Creatures standing
at about 3 m, or a little to the side, were missed. The original's claw sweep reaches about
1.2 m past the hand bone along the arm's arc.

## 14. World props, effects and interactables (chapter 1)

Code: `src/game/world/props.ts` (PhysicalObject props), `fx.ts` (effects), `lights.ts` (light
changes, sky, fog), `interact.ts` (player interactions), `damage.ts` (`services.damage`), wired
in `world.ts`. Classes run elsewhere: Time Scale, Screen Fader / Blur (insanity system),
Damage Action Object (actors director), Object Grouper (logic.ts). Tags as in §1; "[inferred]"
means the meaning was read off the retail values and the port's behaviour, not off the code.

### 14.1 PhysicalObject: health and breaking

- **Breaking** [verified from the Breakable code at RFL `0x1009b6d0`]: when a Breakable dies it
  spawns the template in **p18** (always an Object Generator in chapter 1, checked for all 676
  Breakables by `tests/world-props.test.ts`) at its own transform; when **p19** is set and the
  attacker is known, the spawn is turned to face away from the attacker. p20 is a second
  template that is only prefetched. A predicate next to it treats Breakable, Mechanism,
  TargetableBreakable and Item-category objects alike.
- The generator holds everything a break looks like: BouncingObject debris (models modelled in
  place around the object's origin), a **Breakable** template for the broken remains (broken
  phone, lamp, monitor, toilet, door), Particle Fountains (dust, glass, sparks), nested
  generators (sparks every few seconds from a broken lamp), **Radius Damage** (explosive props)
  and break sounds (generator p36, one picked at random). No chapter-1 break drops an item.
- p0 health, p1 max health; p7 **Damage Resistance** attachments: p0 damage type, p1 multiplier
  (0 = immune) [strong: structure; the type names are not in the data]. The port maps
  melee 1, bullet 3, explosion 5, fire 6 [guess].
- Messages: p11 BlowUp breaks (with effects), p12 Destroy removes it without effects [guess],
  p13 / p14 invulnerability on / off; p15 is fired on every hit, **p21 when it breaks**
  [strong: instances route p21 to Count Down To Zero (Decrement), lamps' lights (Off), other
  breakables (BlowUp)].
- p17 looks like "blocks movement" (0 for bottles, lamps, phones, wall monitors) [guess; no
  reader found, §14.7]; every prop keeps a collision body anyway (they were part of the static
  collision before, and shots must find them).
- Interactable group p22–p29 (Phone, Toilet, Ladder, Clamber Point, Pushable, Mountable, Switch,
  Security Monitor, Light Housing): p22 unlocked at start, p28 Enable / p29 Disable [strong, same
  as the Switch lock]; p23 usable by the player at all (docs/re/object-model.md; every retail
  Ladder has 0 and is climbed by walking into it, so it does not gate ladders). Port: the lock
  is `WorldEntity.enabled` for Pushable / Phone / Toilet / Mountable / Security Monitor,
  initialised from p22 (it was always on: 2 Cellblocks' barricade bed 18f1, locked until Count
  Down 18f6 sends Enable, could not be locked at all and then could not be grabbed, because the
  use test also asked for p22).
- Radius Damage [inferred]: p0 damage, p3 / 2 radius (m).

Port: props are taken out of the static merge (`PROP_CLASSES` in `dynamic.ts`), get health,
take `services.damage`, spawn their p18 generator, fire p21, and are hidden; the broken remains
are new props (they can be broken again). Debris pieces are BouncingObjects and fly the decoded
launch (§14.2 "Debris"); there is no shrink-away. Broken / damaged state is saved by the `props`
save provider.
- p19 (face away from the attacker) is set by no retail Breakable template, so every break's
  generator gets the Breakable's own matrix and its debris flies along that matrix [data].

### 14.2 Effects

- **Particle Fountain damage** [verified: touch handler vt +0x24 = 0x1011c0a0, the same slot and
  touch record (+0x30 the other object) as the Detector's 0x100a7c30]: while the fountain is On
  (engine object +8 & 0xc, set by the On handler's vt +0xfc(8), cleared by Off), every damageable
  object touching it (0x100a1ff0) gets a damage record of **p18 × frame time** (p18 an integer:
  damage per second), damage type **p19**, impact force p20, the fountain (or its owner) as the
  inflictor, through the target's damage virtual (vt +0x58), so Damage Resistance applies
  (docs/re/properties.md). p21 is a template spawned on the target (the flamethrower fountain 4:869
  burns, 4:1328). 27 retail templates do type 16 in the gas colour 0x819c56 (the 1a gas chamber,
  Hermes' gas). `fx/gas.ts`, `fx/gas-system.ts` (whole points).
  - **Who touches it** [verified]. Nothing scans a fountain's volume. The touch comes from the
    mover's own per-frame collision query, and each contact is handed to both objects (the
    world's listener object, SUFFERING.EXE vtable 0x58c5f0: +0x3c calls +0x40 / +0x44 =
    0x424880 / 0x4248d0, which call the other object's vt +0x24 with the record).
    - The player (Player vt +0x20 0x1004bf90 → 0x1002cb50) queries twice per frame through the
      listener's +0x34 (→ 0x426420): his movement proxy (+0xd0, handle +0xdc) with the solid
      classes, then his own body (+4, flags 0x61) with the class filter 0x1002c340(0): Particle
      Fountain and Fire collide, eleven interactables (0x10150a14) and categories 7 / 10 are
      touch-only, the solid classes off.
    - A character queries through its touch component (+0x1ae; per frame from Character vt +0x20
      0x101156f0, query 0x1009fbc6): the object is the component's mover (+0x34, handle +0xdc,
      0x1002c500), the collide list the static 0x10178c40 (18 classes: the solid ones, Detector,
      Particle Fountain, Fire); for a Particle Fountain or Fire contact the record names the
      component's owner (+0x38) instead of the mover (0x1009fd75).
    - The class filter is a byte per class (listener +0x580 object, vtable 0x58c5a8: +0x24 sets
      bit 1 "collide", +0x30 bit 8 "touch only"; reset +4 keeps bit 4). In the narrow phase
      (0x425a80) a touch-only class only needs to be a candidate; a collide class needs a contact.
  - **The contact** [verified code path]: bounding spheres (engine object +0xa8, 0x4d2a00), world
    boxes (+0x78, 0x4d4d40), then the two collision trees (0x428b30): a static model's boxes
    (40-byte nodes: corner and three axes), a character's skeleton sphere tree (the 24-byte nodes of
    the skeleton trailer, radius +0x10, bone +0x14, posed per frame), tested sphere / sphere
    (0x4d2a00), sphere / box (0x418810) and box / box, with no allowance. Contacts come from leaf
    pairs [inferred from the traversal: a pair that overlaps descends while a node has a first
    child].
  - **What that means for the 1a gas** [verified data]. The room tiles (3:1213, model 3:139) are
    one box each, 6 × 0.001 × 6 m, whose bottom face is the chamber floor. The player is hurt
    while one of his hit spheres reaches into that millimetre: standing on a tile they do (first
    person, the first-person model 2:138 (Player p227) has four r 0.4 spheres stacked on the
    root, the lowest centred 0.25 m up; third person, 2:9's left foot sphere hangs 2.4 cm under
    the soles in the bind pose); 0.4 m beyond a tile's edge nothing does. A character's touch is
    its mover's [inferred: the proxy's shape is its movement volume resting on the floor; port:
    the capsule], so a CartWheeler on a lit tile is hurt; its hit spheres would not be (the lowest
    0.36 m above its feet).
  - **The port before**: every body was a capsule with a 10 cm contact allowance [it was a guess];
    0.45 m from a tile's edge still counted, so a body near a seam took two tiles.
- **Particle Fountain** [verified: p26 is particles per second (accumulated per frame), p22–p24
  pick the emitter's axes from the object matrix, p1 is a speed along the primary axis scaled
  by a random 0.5..1, p8 is an angle in degrees, p29 / p30 are distances (scaled by 2048 like
  positions); the rest inferred]: p3 disc radius, p5 radial speed, p10 emission time (0 = endless),
  p29..p30 level-of-detail range (full rate inside p29, none beyond
  p30), p33 → p34 colour over life, p36 textures, p37..p42 / p43 / p48 see "Particles" below
  [verified], p46 blend (0 additive, 1 alpha,
  3 alpha-tested chunks), p49 spin (deg/s); inputs p50 On, p51 Off, p52 Destroy. Drawn as one
  instanced sprite per texture and blend mode.
  Decoded for the 1a mouth blood (Suffering.rfl; vtable 0x101594a8, map 0x10178e78 whose
  records hand p50 / p51 / p52 to 0x10119ad0 / 0x10119b50 / 0x10119b80) [verified]:
  - **Start state is p14**, not p16 / p17: the init (vtable +0x0c, 0x1011a870) ends by calling
    the On handler when p14 != 0, and the constructor leaves the emitting flag clear. Retail
    data agrees: of 236 placed fountains with p14 = 0, 208 are targets of links or STOMP message
    keys; in 1a every one is (glass bursts, Horace's eye smoke, ceiling debris, the mouth blood)
    except the strays `689e` and `7d4d`. 615 have p14 = 1 and run from the start. The port used
    `p17 && !p16` and then started every placed fountain anyway, so the p14 = 0 ones emitted
    from level load.
  - **p0 = 1 emits from the object's model**: the think (0x1011ab10, at 0x1011b57d) takes the
    particle start as a random point inside a box record of the fountain's own model (corner +
    r1·u + r2·v + r3·w, r in 0..1) transformed by the object's matrix; p0 = 0 uses the object
    position. The port uses the model geometry's bounds as that box [inferred: the retail
    emitter proxies 3:478 / 3:495 / 3:1314 are single boxes] (`fountainEmitPoint`).
  - **Destroy (p52) with p17 set** only stops emission and lets the live particles finish; with
    p17 = 0 the object is deleted at once (0x10119b80).
  - **Particles** [verified: the RFL's system setup 0x10119fc0 hands p39 / p41 / p42 / p43 /
    p44 / p49 to the engine particle system (fields +0x58 / +0x64 / +0x6c / +0x74 / +0x5c /
    +0x78), the emitter passes each particle's p37..p38 value with its position and velocity,
    and SUFFERING.EXE's particle update 0x4ac1e0 uses them]: **p37..p38 = size at birth** in
    engine units (2048 per m, random per particle, x the object scale); **p39 = size change per
    second** (kept >= 0: smoke grows, sparks and blood shrink); **p40 = lifetime (s)**, random
    0..p40 when p48 = 1; **p41 = fade-out** over the last p41 s (a shorter lifetime fades from
    the start); **p42 = fade-in** (alpha over the first p42 s); **p43 = gravity factor**,
    velocity = v0 - up · g · p43 · age (1 = full gravity, negative rises). Across the 604 retail
    templates this gives sizes of 4 cm .. 1 m (median 15 cm). The port read p37..p38 as
    lifetime (ms), p40 -> p41 as size (m), p39 as gravity, p42 as drag and p43 as floor bounce:
    the mouth blood (p37..p38 = 50..100, p39 = -25, p40 = 1, p41 = 0.25, p43 = 0.5) drew as 1 m
    blobs living 75 ms, turned at random, spraying sideways across the face; now 2.4-4.9 cm
    drops of the drip texture 4:1934 fall from the mouth at half gravity for a second and run
    down the shirt, as in the original (checked side by side with frames of the retail game).
    The size is the **half extent** [verified: the billboard build SUFFERING.EXE 0x4ad430 puts
    the corners at the projected centre ± size x focal / depth, 0x4ad5f9]: a 50..100 drop is
    4.9-9.8 cm wide. **Blend** [verified: setup flags 0x20 (p46 = 1), 0x40 (p46 = 2), 0x800000
    (p46 = 3), 0x200 (p47 != 0); the billboard pass 0x4ad698 draws flags & 0x220 with engine
    blend mode 2 (additive), 0x40 with mode 4 (reverse subtract), the rest with mode 1 (alpha)]:
    p46 = 1 or p47 additive (286 retail templates: sparks, glows, steam, Hermes' gas), 0 / 3
    alpha (316: smoke, dust, blood), 2 subtractive (2). The port had p46 as 0 additive / 1
    alpha / 3 alpha-tested, so smoke glowed and sparks drew as orange fog.
    **Additive alpha** [verified: the engine adds source x source alpha, docs/re/renderer.md;
    texture data]: the alpha is the texture's times the particle's fade. The spark and glow
    textures (4:1830, 4:1808, ...) are white, with their shape only in the alpha. The port
    multiplied by the fade alone, so each spark drew its whole 7-10 cm quad as a solid orange
    ball (4:1162 at a door, 4:1146 metal impacts). Now they draw as small glints.
  - **Gravity** [verified: Level Properties p18 (units per metre) and p19 (gravity) go to the
    engine clock object at Suffering.rfl 0x100b23c8. SUFFERING.EXE vtable 0x58ca50 slot +0x4c
    stores p19 x units at +0x90 (0x5c6e58). The particle update (0x4ac39a) and the BouncingObject
    / Missile launch (0x100cfbcb) both read that value.] Every chapter 1 level keeps the template
    values 9.8 x 2175 units/s². At 2048 units per output metre that is **10.41 m/s²**, not the
    9.81 the port assumed (`fx.ts levelGravity`).
  - **p48 = 1, velocity-aligned quads** [verified: setup 0x1011a4b0 sets flag 0x80000. The
    emitter (0x1011b0d3) also gives these particles a random lifetime of 0..p40. The billboard
    build SUFFERING.EXE 0x4ad430 handles the flag at 0x4ad9b8, and the corners are built at
    0x4adbbb.]
    - The build takes n = -velocity / |velocity| in view space, or (1, 0, 0) for a particle at
      rest. u is the screen direction from the projected centre to the projected
      p + n x size, so it points to where the particle came from. f = max(0, 0.99 - |n.z|).
    - Corners are centre ± A ± B in pixels, y down: A = hy (u.x, f u.y) and B = hx (u.y, -f u.x).
      The +A side carries texture v = 1 (the tail); the +B side carries u = 1.
    - **The quad keeps the sprite's own size**, so it is not stretched with speed. The streak
      comes from the texture (4:1808 sparks, 4:1934 blood), turned along the motion. The quad
      is mirrored against the upright sprite. Only the y components carry f, which flattens a
      particle that flies at the camera.
    - 80 retail templates use it: the metal-impact sparks 4:1148 / 3:2437 / 3:2441 / 3:2996,
      the gun and shiv blood 4:1141 / 3:2434 / 3:2435, glass and debris.
    - The 4:1162 / 4:1174 sparks (4:1160..1166) and the door sparks 3:1650 have p48 = 0. They
      are plain glows in the engine too; their "big orange balls" came from the additive-alpha
      bug above.
    - Port: `fx.ts streakFrame` computes the angle and f per particle on the CPU. The pool's
      `StreakSpriteNodeMaterial` mirrors the quad in x, turns it and scales view-space y by f.
      View space matches the engine's screen space up to the perspective divide.
  - **p46 = 3, lit particles** [verified: Suffering.rfl 0x10119e30, called by the emitter think
    at 0x1011b087. It uses the light-set vtable at SUFFERING.EXE 0x595420. The colour is applied
    at 0x1011b1e8 and the particle update 0x4ac4e0.]
    - The system object sets flag +0xc bit 13, so the gather skips the sector-group test, and
      forces a gather of its light set (0x4ca730).
    - It then sums the ambient slots (vt+4), the first directional entry (vt+0xc) and the colour
      (+0x10, bytes / 255) of every other non-directional entry.
    - There is **no distance or angle term**: any light whose cull sphere touches the system
      adds its full colour. Each channel is clamped to 0..1 (0x10119860).
    - Each channel multiplies the matching p33 byte. Every live particle takes that colour
      each frame through flag 0x800000; p34 is not used.
    - Port: `engine-light.ts particleLight` builds the same sum from the rig's uploaded lights,
      and `fx.ts litParticleColor` applies it. Gun blood in a corridor lit only by ambient
      now draws near black.
    - At the stabbed guard's jaw, two cell-row lamps (0.663, 0.737, 0.663 each) plus the ambient
      0x1C1E20 pass 1. The mouth blood therefore keeps its full p33 (grey 0x3F3F3F x the drip
      texture), the colour the port already used.
    - So the redder, brighter blood in our close-ups is not the particles' fault. The port
      lights the guard's face and shirt much darker than the original does (images 11 and 12
      against our 7.47 / 7.62 s frames), and that is a scene-lighting difference.
    - [inferred]: rim lights are left out because the system object is not dynamic (0x4cab22),
      so the first directional entry is the base light of the smallest region holding the
      point.
  - [inferred]: particles are drawn upright unless p49 spins them (drip textures hang down).
    The p33 -> p34 colour of unlit particles runs over the lifetime.
  - **No ground test** [verified]: neither the emitter think (0x1011ab10) nor the engine's
    particle update (SUFFERING.EXE 0x4ac1e0, called from 0x4ad1cb and 0x4ae85f) queries
    collision. A particle moves by its velocity and gravity until its lifetime ends (the update
    returns 1 and the loop frees it), so one that falls through a floor is hidden by the depth
    test. The port used to stop every particle at the first surface straight below the emitter,
    sampled once: 1a's wall-box sparks (Breakable 5d69, 9:2697) lay in mid-air on the box's own
    collision box, 1.26 m above the floor (user report). It happened before the collision-tree
    change as well.
  - Checked in headless Brave, spawned in the 1a cell with before/after strips: the 4:1162
    sparks, the 3:1468 door sparks, the 4:1146 metal impact, the 3:1524 sparks, gun blood
    4:1109 + 4:1125, shiv blood 4:1142 and 3:4658.
- **BouncingObject trail and launch** (1a "Hat Gen" `7047`, Object Generator 3:1480, On at
  7.69 s of #280: the stabbed guard's cap 3:1481, model 3:477).
  - p36 lists Particle Fountains the piece carries [inferred from the data]. The cap carries
    3:2357, blood drops for p10 = 5 s, so it leaves a blood trail as it falls.
  - **Spawn** [verified]. The generator's spawn (0x100b52a0) shapes a velocity only for the
    classes that take one (0x100b5a32). A BouncingObject or Missile (0x100b5be1) gets the
    generator's matrix unchanged.
    - Hat Gen has rotation 0 and no attach or transform key in 12:280 (its track only has the
      On key), so the cap starts at the generator's own placement (409.91, 101.68, 508.02),
      2 cm above the ceiling plane, inside a ceiling grate fixture (part 168,
      409.06..410.5 x 507.25..508.75, 101.2..101.68).
    - No guard bone is involved.
  - **Launch** [verified: 0x100cf8b0].
    - The velocity is -(object matrix row +0x34, the local Z axis) x p1 units/s, or
      p1 + (p2 - p1) x strength when the launch carries a strength (never for a generator).
    - The speed is p1, or (p2 - p1) + p1 = p2 when the launch gets a projectile record (type
      2), which every generator spawn passes (0x100b5be1 -> 0x100282e0) [verified,
      0x100cfa21..0x100cfa40: no strength or random factor is read]. The cap has p1 = p2.
    - Gravity is the world's x (p46 + uniform(-p47, p47)) % (0x100cfb81..0x100cfbd3).
    - The lifetime is p12 s.
    - The cap: 9.77 m/s, falling at 0.75 x 10.41 m/s² ± 5 %, for 25 s.
    - Local Z in output space is column 2 of the port's instance matrix. That holds because
      instanceRotation reproduces the engine's object matrix: positions are 1:1 and models are
      not converted. [inferred, consistent with Detector p3 and the directional lights]
    - For rotation 0 the cap therefore flies towards +x.
  - **Bounce** [verified: vtable +0x54 0x1009a3b0, then 0x1009a8c0].
    - A contact the object moves away from (v . n >= 0) is ignored, and the object moves on.
    - Otherwise v becomes the mirror reflection (v - 2 (v . n) n) x k, with
      k = (1 - surface Game Material Properties p4 %) x (1 - p51 %).
    - p58 > 0 would add a random scatter; the cap has p58 = 0.
    - p49 = 0, so the cap never settles by count.
    - Port: `fx.ts bouncingLaunch / bounceVelocity / bounceKeep`. `fx/system.ts` supplies the
      surface's p4.
  - **Collision: the sweep and its narrow phase** [verified unless marked].
    - The sweep that bounces the object is BouncingObject vt+0x5c (0x100ceff0), not the Missile
      think (vt+0x60, 0x100ce940). The think's own query (0x100c6240) reads only the broad
      phase's region list: floor-layer regions (class vtable 0x594164, heightfield DDA 0x4a6ae0).
    - vt+0x5c takes the segment from the previous to the current position (vt+0x64 / vt+0x68)
      and runs the full query 0x100c6e10 -> 0x100c6630: floor-layer regions plus the objects of
      the spatial structure. It turns its own "no collision" bit (engine `+8` 0x400000) on for the
      query. The narrow phase is 0x100c5c70.
      - Objects go to the collision interface (EXE object 0x5c6330, vtable 0x58c5f0, slot +0x24 =
        0x4283c0). That tests the object's bounding sphere first. An object without engine
        `+0xc` bit 0 is hit on that sphere alone. Otherwise its collision model's box tree is
        walked (0x4276b0 / 0x426750, boxes 0x4d3ac0). A leaf's triangles go to slot +0x2c
        (0x424b20 -> 0x4249f0 -> Möller-Trumbore 0x4dd290).
      - **One-sided**. The back-face flag argument is the caller's 7th argument, and the RFL
        passes 0. So 0x4dd290 keeps det >= eps only. 0x4249f0 hands it each triangle as
        (i0, i2, i1), the port's counter-clockwise order. A triangle is hit only when the
        segment runs against the normal of the face the port draws as front.
      - **Radius**. Each tested triangle is first grown in its plane by the sweep radius (0x4dd540
        pushes its edges out); the centre's segment is then tested. The radius is the object's
        bounds radius: init 0x100cfdd2 stores E vt+0x8c(0)->+0xc in `+0x18`, and vt+0x5c divides
        it by the largest of E `+0x54..+0x5c` and passes it down as the narrow phase's radius
        argument. For the cap that is model 3:477's .mdu type-7 sphere radius, 0.197 [strong:
        the bounds object read as that sphere; the growth is taken as a homothety about the
        incentre, inferred].
      - The hit's normal is the triangle's own. One-sided hits always run against it, so the
        bounce (v . n < 0) always applies.
    - Post filter (vt+0x5c) on object hits: an Invisible Static Object blocks only through its p5
      (0x100bc9d0, §14.7). Objects of engine type 9 need class 0xfd73bab8 with p23 set, and an
      Animating Static (class 0x86a01249) has its own test (0x10093fc0).
    - Characters: skinned objects (engine `+0xec`) take the 0x419b20 -> 0x426750 path, which was
      not traced. Nothing above shows that the hanging guard takes part. **Port: characters are
      left out** [inferred].
    - **Port** (`CollisionWorld.frontSegmentCast`, `fx.ts updateDebris`, `modelBoundsRadius`):
      BouncingObject debris sweeps that segment against front faces of the static and dynamic
      geometry, with triangles grown by the model's bounds radius. Other debris keeps the
      two-sided ray.
    - Result in 1a (#280, frozen frames in the browser): the cap catches the grate fixture it
      starts in (front face, normal about (-0.9, 0.2, 0.4)) and drops. At 8.8 s it is at
      (408.6, 98.1, 509.9). At 9.4 s it is in the air at (409.3, 98.3, 509.3), 0.6 m above the
      floor and bouncing back towards +x. It rests at (410.3, 97.66, 508.4) by 10.9 s, by the
      cell bars in the wide shot.
      - Before this change it bounced out of the wide shot to x 417.
      - The estimate from the user's image 14 (§ above: (411.2 ± 0.5, 98.4, 508.6), 0.7 m up and
        moving towards the camera) matches in height and direction.
      - The path stays chaotic: ±5 % gravity (p47) moves the rest point by about a metre
        (tests/bounce-sweep.test.ts).
  - The floor splat Decoration `7c2e` is shown at 10.94 s by its visibility key. The guard keeps
    his worn cap (10:1726 on bone 54, inside the ceiling by then): no key or clip event removes
    it.
- **Object Generator** (FX spawner; in chapter 1 none spawns a creature) [verified unless
  marked: Suffering.rfl vtable 0x10155710, create 0x100b4ea0, think 0x100b6190, fire 0x100b5ed0,
  run end 0x100b4590; `world/fx.ts Generator`]:
  - p0 templates, p1 / p2 counts, p6 which entries a firing takes (0 one random, 1 the next in
    order, 2 all, else the first: `generatorPicks`), p36 sounds (one random per firing).
  - p21 run time (s; 0 = the run never ends), p22 runs before the generator is destroyed (0 = any
    number), p24 on from creation (create calls Start; the save-state test 0x100b4530 also reads
    p24 as the initial state). Placed generators start by p24, whatever links to them (the port
    used to start every unlinked one).
  - Start (p32, Toggle p34 while off): on, spawn timer 0. With a run time the generator thinks
    every frame (engine state 8, EXE 0x457d40 -> 0x45bdc0) and once at creation; without one it
    goes to state 4 and thinks only in frames the renderer visits it (EXE 0x4a06d0 -> 0x45bf00,
    list cleared each frame 0x45bfd0) [port: within 45 m of the camera]. Stop (p33, Toggle while
    on) sets the run time left to 1e-4 s, so the next think ends the run.
  - Think: run time -= dt (when set; ended at <= 0); timer -= dt; at <= 0 it fires (in the think
    that ends the run only when timer <= run time left): timer = p7 + uniform(-p8, p8) (set
    afresh, no carry-over: at 60 fps a 0.05 s timer fires every 3 or 4 frames), then the entries
    spawn unless p28 > 0 and the player is beyond p28 m (3D; with p29 or p30 set horizontal, and
    only with the player at most p29 m above / p30 m below), then the sound.
  - Run end: off, run time = p21 again; p22 counts down when set and at 0 the generator is
    destroyed. Destroyed with p5 set it destroys what it spawned (0x100b49e0: Particle Fountains
    through their Destroy p52, the rest removed); without p5 its spawns live on.
  - p23 caps what it has alive [verified]: the spawn (0x100b52a0) is refused while p23 > 0 objects
    it made still exist (handle list +0x5a, count +0x62); each think first drops the handles of
    objects gone (0x100b61fa). A spawned Sound Effect with p1 set plays at creation (0x1012cc8c ->
    Play 0x1012c9a0) and lives on (it destroys itself only in play mode 4 or when what it is
    attached to goes), so it keeps its slot. 1a's lobby sparks `81f2` (3:2642: p7 0.1, endless,
    p23 3; started by Detector `5bf8` on the way north to the lobby) keep one hum (Sound Effect
    4:1159, play mode 1: 4:297 looping) and renew the two spark fountains as they burn out.
    **Bug (user report, "the metal detector no longer goes off")**: the port had no cap, so from
    the generator rule above (13b4507) the sparks started a new looping hum every 0.1 s, all 48
    voices were taken within 5 s and every later sound of the same or lower priority was dropped,
    among them the metal detector alarm (Sound Effect `8147`, 3:297, priority 85 like the hum).
    Port: `world/fx.ts` (`Generator.live`, `Fx.spawn` returns whether its object still exists:
    fountains, generators, BouncingObjects, Sound Effects; other spawned classes are not counted).
    Tests: `tests/object-generator.test.ts`; playthrough step `1a.metal-detector` (`expect.heard`).
  - [inferred] Create also refuses a one-run endless generator (p21 0, p22 1) with p28 > 0 while
    the player is beyond p28 (returns -9); what the engine does with that is not traced, so the
    port creates it and lets the range test gate its spawns.
  - 1a's chair room (chapter 7 return): each broken generator spawns 12:715 (p7 1, p21 0.1: one
    firing) -> 12:716 and 12:779 (p6 1, p7 0.05, p21 0.6, p22 1: 9 .. 12 firings, then gone),
    whose entries include 12:773 (p21 0.65: two or three Fires) and the endless 12:775 (p7 1 ±
    0.3, p28 50: one 12:768 burst a second). The port read p28 as a run time and ran every
    spawned generator for good: 6,000 .. 12,700 Fires and 10 .. 13 fps after the five breaks.
  - **What a spawn gets: p9..p20** (0x100b52a0) [verified unless marked]. Port:
    `world/fx.ts generatorSpawn`, used for every spawn of `spawnList`.
    - Velocity V: with p16 = 0, -Z x p9 m/s, turned by p11 deg about world up, p10 deg about the
      local X axis and p12 deg about the local Z axis (right-handed: 0x1000f910 / 0x1000c5b0),
      then V.y += (0.5 + rand) x p14 and V.x, V.z += uniform(-p13, p13). With p16 != 0 a cone:
      -Z turned uniform(p15, p16) deg about local Y, then uniform(0, 2 pi) about local Z, and
      p17 > 0 moves the spawn point p17 units back against it; V = that x p9.
    - Matrix: the generator's own; p20 != 0 turns it about its own axis p19 (0 X, 1 Y, 2 Z) by
      uniform(-p20, p20), which the code uses as radians (no degree conversion: the retail 180
      / 45 are a random turn); p18 with V != 0 replaces the rotation by one facing V: local -Z
      along V, Y from world up (0x1000d070) [roll inferred].
    - Inherited velocity (the caller's argument) is added after p18: the generator's +0x2c and
      +0x38 vectors, filled only from a parent generator's record (0x100b51de); zero for every
      generator a level, a Breakable or a weapon makes.
    - Only an Item (class 0x5a410dde) takes V (0x100b5a32 -> 0x10037b60). A BouncingObject or
      Missile gets the matrix and a projectile record (0x100b5be1) and flies its own launch along
      the matrix's -Z at p2; a Particle Fountain or nested generator gets the matrix. So debris
      direction comes from p18 / p20 only. The port's old cone (p13 x 2.2 m/s, p20 as a cone,
      tilted towards the attacker) was not original.
- **Debris** (BouncingObject from a generator: break pieces, gibs, the cap, casings) [verified
  unless marked]. Port: `world/fx.ts spawnDebris / updateDebris`, `weapons/system.ts
  ejectCasing`.
  - Launch as above: -local Z of the spawn matrix at p2 (break debris 3000 / 5000: 2.44 m/s;
    the corpse gibs 3:3521 -500 / -2000: backwards along +Z at 0.98 m/s), p46 / p47 gravity,
    p12 s of life, spin p3 / p4 / p5 deg/s about x / y / z capped at p6 (0x100cfc0a, 0x100cc400)
    [strong; the axes' frame inferred]. The port read p1..p2 as a lifetime in ms: gibs with
    negative values vanished at once (the dismemberment pass patched them with p12).
  - The swept point is the object's position, or with **p25 = 1** its vt+0x64 point (the current
    position getter 0x100cc1f0, the launch 0x100cf95c, the detonation 0x100d10b2) [strong: the
    bounds centre; the 66 retail objects with p25 = 1 are pieces modelled metres from their
    origin, the crate piece 3:4439 4.0..5.2 m up; with p25 = 0 they sit on it]. Pieces turn
    about that point.
  - Bounce and settle as the cap (front-face sweep grown by the bounds radius, mirror x (1 - p51
    %) x (1 - surface p4 %)); every hit counts, at p49 it settles (p50 any surface, else a
    floor) and goes p54 s later; at the end of its life its p34 generators spawn and it is
    removed (no shrink).
  - A piece whose origin starts on the floor bounces every frame and keeps (1 - p51 %) of its
    whole speed each time, so it stops within a few frames: 1a's chairs (7:2032, p51 50, origin
    at the floor) fall apart in place, their pieces turned by the generator's p20 = 180. Not
    compared with the original's frames yet.
  - Casings: the Ranged Weapon spawns its casing generator (p86) at the bone p88's world matrix
    (0x10127a54..0x10127af9); 4:71 / 4:88 / 4:259 turn nothing, so the casing leaves the bone's
    -Z at 2.44 m/s with 50 +- 10 % gravity [the bone frame as the port's bone matrix: inferred].
    The thrown-object bounce also takes the surface's p4 now.
- **Volumetric Fog** [inferred]: the template's unit cube × instance scale filled with additive
  puffs of texture p0 tinted p1 (p2 density, p11 opacity, p12 puff size, p8 drift), p13 on at
  start; inputs p15 On, p16 Off, p17 Destroy. Most are light shafts under skylights.
- **Billboard** [inferred]: glow sprite (p0 texture), size p2..p3 growing with distance, fading
  past p9.
- **DripMorphingModel / MorphingModel** [inferred]: p3 model frames (a frame naming no model is
  empty: the drip has not formed), p4 frame times (s), p0 on at start, p16 On / p21 Off; a
  Drip (p25) model falls from the tip at the end of each cycle.
- **Instance Rendered Object** [inferred]: p2 copies of the object's model (grass, debris),
  seeded by p1, scale p5..p6, yaw p7..p8, scattered over the object's footprint and dropped
  onto the ground.

### 14.3 Mechanism, Pushable [inferred]

- Mechanism outputs [verified code; at the arrival inferred from the state switch 0x100c84b8]:
  a group coming to rest sends p55 + 2 g (g 0 the translation group, 1 the rotation group), +1
  when it rests at its travel (0x100c81fb..0x100c8254): p55 / p56 the slide at its start /
  travel, p57 / p58 the rotation at its start / travel. Retail links: 8b's gas valves (p58 into
  Count Down 1fa9) and its lamp stands (24a0 / 2509 / 24aa), 2 Cellblocks 1b59 (p55), 10 Docks 32d
  (p55 / p56) (`props.ts mechArrivalOutput`).
- Character output p31 ("ISeeYou") [verified]: KillEnemies' choice (0x100fa1f0) taking the
  player as a new target sends the character event 0x200c (0x100fa30c..0x100fa361), whose handler
  fires p31 (0x100e3fd4 -> 0x100e40ea) (`actor.ts fireSlot31`). Before, only p15 (Damaged) and p28
  (Died) of characters were fired.
- Mechanism: two motion groups of the same layout (p22–p31, p32–p41); the second is the
  rotation every chapter-1 mechanism uses. **Motion [verified: group init 0x100c8fd0, called
  with the group's base index]**: p32 is the *time* one move takes (s), p33 / p34 the speed-up and
  slow-down times (each at least 0.01 s; when they add up to more than p32 they become 0.01 / 0),
  p35 the travel (deg, its sign the direction). Top speed = |p35| / (p32 − (p33 + p34) / 2),
  reached after p33 and lost over p34. The port used to read p32 as deg/s: the 1a gas chamber
  door (1 s, 0.1 / 0.1, 120°) took 2 minutes, the security cameras (5 s for 50°) swept at half
  speed and the fans (5·10⁷ s for 3.6·10⁹°, i.e. 72°/s) spun at millions of degrees a second.
  [inferred]: p35 ≥ 3600 spins forever (fans), p36 axis, p37 runs at start, p38 = 2 sweeps back
  and forth (all security cameras); p79 / p80 start / stop sounds. The first group (p22..p31,
  same layout: p22 time, p23 / p24, p25 travel in metres, p26 axis, p27 runs at start) is a
  **translation**: the mover 0x100c86b0 adds its position along the axis to the placement, the
  second group's angle turns the object [verified]. **Inputs** [verified: map 0x10178878,
  handlers 0x100c8e90..0x100c92a0]: p59 / p60 / p61 / p62 send the translation group back to its
  start / forward to its travel / stop it / toggle it (0x100c7ec0 with 0 or 1; the toggle goes
  forward from the start, else back); p63 / p64 / p65 / p66 do the same for the rotation group.
  The port had read p62 / p64 as forward, p63 back, p61 / p65 stop, p59 reset, p60 reverse, all
  on the rotation group. Port: `world/props.ts mechMotion / mechStep / mechMessage` (a turn the
  other way starts again from rest [inferred]); a mechanism without a model still moves what it
  carries.
- Object Grouper [inferred from its init 0x101173c0, which takes the first link as the leader
  and keeps the others' placements, and from the data]: the objects linked after the first move
  with the first. No message map: it receives nothing (nothing in the retail levels links to
  one). 2 Cellblocks 18cd: the model-less Mechanism 18cc (a 4.2 m drop, translation group) and
  the Ladder 18cb hanging 4 m above the floor; breaking the hidden Breakable 18ce at the
  ladder's foot (system-package template 2:489, health 1) sends Relay 1a0d, which lowers it.
  Port: `props.ts moveGrouped` (followers' pivots), `interact.ts ladderFrame` (placement x pivot),
  `dynamic.ts hiddenTarget` (the system-package Breakable built for its body, meshes hidden).
- Pushable: Use grabs it; it moves along whichever of its x / z axes faces the player at the
  player's pace (p45 speed), stopped by walls (swept against the collision world), falls off
  ledges; p51 scrape sound loops while it moves, p53 / p55 fired on start / stop. The class has no
  think of its own (vtable +0x18 is the empty 0x10128410) [verified]: one nobody has grabbed
  never falls (9's lamp crank 9e1 rests inside the hidden lamp machinery; `props.ts
  pushableMayFall`). Detectors with
  filter 3 detect pushables (logic.ts `hooks.pushables`).

### 14.4 Lights, sky, fog

- Point Light: p0 colour, p4 On / p5 Off inputs, **p6 on at start** [strong: the p6 = 0 lights
  are exactly the ones scripts switch on], p8 radius, p3 Lighting Effect template.
- Light Housing (lamp fixtures) [verified, Suffering.rfl class 0x9aa22111, constructor
  0x10016c20, vtable 0x1014c820; port `world/housing.ts`, applied by `world/props.ts`]:
  - **State.** One word (+0xa8): 0 off, 1 on, 2 broken. Init (vtable +0x0c, 0x100162b0) sets it
    from **p31**, so p31 is "on at start". On (p44, 0x10017050) and Off (p45, 0x10017070) act only
    on a change; vtable +0xe8 (0x10017090) toggles 0 <-> 1; the killed hook (+0x90, 0x10017010)
    sets 2 before the GameObject break (p18 generator, p21, Destroy).
  - **Apply** (0x100166d0, run by the post-load hook +0x1c at 0x10016da0 and by every change):

    | state | material table | spawned at the lamp | linked lights + p34 spawns | p43 objects |
    |---|---|---|---|---|
    | 1 on | p32 | p40 | sent the message in p38 (On) | shown |
    | 0 off | p33 | p41 | sent the message in p39 (Off) | hidden |
    | 2 broken | unchanged | p42 | removed (vtable +0x30), list cleared | removed |

  - **Material tables.** The list replaces the model instance's table slot by slot, and only
    when it has exactly as many entries as the model has materials (0x100168f6). p32 holds
    Advanced Materials whose tint draws unlit (texture x tint, docs/re/renderer.md §3.5), p33 the
    lit Simple ones. A model's own table is often neither: desk lamp 9:2991 carries the cell bulb
    4:1374 where p32 has 9:5751 and p33 the dark cut-out 9:6031.
  - **Spawns.** The previous state's spawns are removed and the new list is created at the
    lamp's transform: p40 / p41 are glow cones (additive, e.g. 7:1884) and ceiling light pools
    (modulate 2x quads, e.g. 9:4319 over the cell lamps); p42 is what a shot lamp leaves, a
    Breakable such as 9:3402 (the cell-block shade without its bulb) or 9:3401 (the fluorescent
    with shattered tubes).
  - **Lights.** The post-load hook collects the links whose category is Light Source (engine
    type 0xe at +0xe4; links through vtable +0x118 / +0x120, the calls the message filters use)
    and the p34 spawns (the fluorescent hum Sound Effect 3:1529). The start state is sent too, so
    it overrides the light's own p6: 105 retail Point Lights with p6 = 1 hang under lamps with p31
    = 0 and start dark (1a: the fluorescent rooms behind light switch 6847; 2 / 3b likewise; 9's
    lighthouse lamps until their relays). 28 linked lights have no On / Off inputs and are
    unaffected. A broken lamp's light is removed, so it stays off.
  - **p43** [strong: vtable +0x128 is the engine object's SetVisible, as for Invisible Static
    Objects §14.7]: uids of placed objects shown with the lamp; the 60 retail ones are light pools
    (Decoration, category Special Effect, e.g. 1a 7c28 under cell lamp 5b9f). They carry no flag
    0x80, which the engine does not read, so the port builds them anyway (dynamic.ts).
  - **The port before:** every lamp started on whatever p31 said (330 of 679 retail lamps start
    off), "on" was an emissive glow added to the lit texture of the submeshes whose texture
    matched the off material (which missed tables like 9:2991's, and lit the whole body of 9:2831
    whose on slot shares the body texture), the linked lights kept their own p6, nothing was
    spawned (no cones, pools or broken remains: a shot lamp simply vanished), and the p43 pools
    were not drawn. `npx tsx tools/fixtures.ts` lists every fixture type per level with the look
    it starts in; tests: `tests/light-housing.test.ts`.
  - **The glass needs the scene glow** [verified, docs/re/renderer.md §3.2]. The "on" tables'
    glass and bulbs (7:1863 frosted glass × 0x8a8a75, 4:1374 bulb × 0xffd67e, the tubes 9:5742,
    the emergency lamp's 9:5745) carry layer flag 4: their pixels are the glow mask of the
    engine's HDR scene glow, which runs every frame by default. It adds them back about 3.4 ×,
    blurred over up to 16 / 256 of the screen: a milky glass dome lit from within, a blown-out
    bulb, a bright rim and a halo. Without it (the port before) the glass was a flat mid grey
    behind the cage: "a cage with no glass" (user report). Port: `app/scene-glow.ts`,
    `tests/scene-glow.test.ts`.
- Lighting Effect [verified, docs/re/renderer.md §1.10]: a clock drives two waveform channels:
  p8 curve lerps the light colour p6 -> p7, p11 curve lerps the Point Light strength p9 -> p10
  (k = (sample + 1) / 2, sampled at fmod(t, duration); p1 = loop). A channel without a curve
  leaves that value alone, so the white p6 / p7 of most templates do nothing. Placed ones drive
  their linked Point / Spot Lights (p0 runs at start, p2 On / p3 Off start and freeze the
  clock, p4 Destroy); a light's p3 template drives that light, and is also stepped by the
  light's own update while it is on (twice the rate when p0 = 1 [inferred]). The 1a alarm
  lights (7:176) pulse their red light between strength 7.9 and 0.1 on a 1 s square wave.
- Point Lights are not baked: the engine evaluates them per vertex at run time, so the port feeds
  every light that is on (with its Lighting Effect values) to the lighting rig (§19). (`?lighting=legacy`
  keeps the old pool of eight lights that rendered only changes against an assumed bake.)
- Sky / Sun: sky layers drawn around the camera (p6 = 1 marks the dome); p4 On / p5 Off. The
  dome's texture is a colour strip the engine rewrites at run time from the Sky Properties
  (RFL 0x1012ad70: p6 × 448 texels of p4, p7 × 448 blending to p5, then p5); the levels
  system colours the dome from it (docs/levels.md §4.8).
- Fog / Sky Switcher [inferred]: On (p3) blends the fog towards Sky Properties p0 (fog colour
  p5 / p4, density from p7) over p2 s.
- Directional / Ambient Light: see §17.7 (a Directional Light carrying a Rim Light template is a
  run-time, camera-relative rim light for dynamic objects; the rest only feed the bake).

### 14.5 Interactions

Use (E) on the object under the crosshair; Space clamber (the level's own help text names
the Space key for clambering).

- Phone: p38 is the ring, played again every p32 (3) s while ringing (0x1001a180; 2:387 is a
  3.2 s one-shot); p34 is what an answered phone plays when no line is armed (0x1001a5f2; 2:386
  is a 1 s looping dial tone, so it runs until the player hangs up) [verified code, roles from
  the sound data]. The port had these two the other way round. Rings on p39, stops on p40 / p44;
  p35 dialog line, p41 arms the dialog [strong]; **p30 the receiver** [verified data,
  inferred spawn]: a Breakable (7:2077 on the desk phones, 7:2076 on the wall phones) whose model
  (7:836 / 7:837) is the handset, modelled in the phone's frame on the cradle (0.18..0.27 m up on
  the desk phone 7:842, whose own top is the bare cradle prongs), breaking on its own into the
  handset pieces of generator 7:2072; the phone body has no break generator. No level places it,
  so the phone does: the port spawns it at the phone's transform as a prop of its own (props.ts
  `initReceiver`, saved as `receivers`). It had been read as a broken-phone template, which left
  every desk phone without its handset.
- Security Monitor [verified: View Monitor start 0x1001b4a0, per frame 0x1001b080, map
  0x101698b8]: p47 is the camera (a Mechanism uid; p54 a second one), p48..p50 offset in its frame,
  p51 the view's lens (set through the view manager, the engine's lens: a vertical angle of the
  4:3 picture). Use looks through it full screen. In front of the eye ride p57 (screen: model
  3:251, the CRT glass Animating Material 3:2560 at 60 fps inside a black bezel) or p58 (model
  3:252, opaque scrolling noise: no signal; shown while the camera is gone or the no-signal flag
  is set), posed p59 = 0.38 m out, and the Warp Effect p55 (3:1658) p56 = 0.38 m out, which bends
  the picture at the screen's rounded edges (docs/re/renderer.md §3.7). p70 / p71 (Disable /
  Enable) set / clear the no-signal flag (0x1001a970 / 0x1001a980): they do not end the view or
  lock the monitor. 1a's scares use them: Horace walks up to monitor 6dec's camera and his last
  Waypoint (7b0d) disables the monitor for 0.5 s while he is destroyed; monitor 66f5 cuts to
  noise every 1.5 +- 0.5 s (Timer 7d01 -> Relay 7d05 -> Disable, Timer 7d06 -> Enable). p62..p63
  a random interval (s) [use not traced], p66 an optional on-screen clock ("%2d:%2d:%2d" of the
  game time, 0x1001a990; none in chapter 1), p72 / p73 fired when the view starts / ends [guess].
  The monitors in the world show only their own Animating Material: the engine never renders a
  camera into a texture (renderer.md §3.7); the port's old live feed is gone.
- Toilet: p32 flush generator, p31 swirl model.
- Ladder: p30 height, p32 bottom / top interaction templates (player 0.85 / 0.5 m off the
  rungs), p33 animation set; W / S climb, the top exits onto the landing.
- Clamber Point: a marker box whose top is the ledge; p30 lists Clamber Interaction Properties,
  one per usable side, the first that passes is used [verified, 0x10011910]: p3 the side (0 +x,
  1 +z, 2 -x, 3 -z of the box), p1 reach (2.5 m) to the anchor, p2 the most (4.5 m) and p7 the
  least (2.5 m) the ledge may be above the feet, p4 / p5 the player's bearing from the side
  normal (±45°), p6 the facing of the anchor (45°); blocked when there is no room on top
  (`world/clamber.ts`). **The anchor** [verified, Clamber Point vt +0x94 0x100114f0] follows
  the player along the ledge: his offset from the box centre projected on the edge axis (the
  horizontal axis that is not the side's), clamped to half the edge length less the Clamber
  Point's own p31 (0.2 m), plus half the box depth + p8 (-0.5) along the side normal, at the box
  top. A long wall top is climbed wherever the player stands below it. The port had the anchor
  at the face centre, which made 2 Cellblocks' 18 m wall top 80b unreachable from the step 3024
  (4.1 m below it, 7 m from its middle): the only way out of the south-west pit to the exit.
  **The box** [verified, 0x10011030 / 0x100114f0]: the object matrix rows (the placement
  rotation) times the object scale (+0x54), over the model box of 2:178 (a unit cube; engine
  vt +0x98 hands it back in model space as a corner and three edges): half an edge is its length
  x scale / 2, the top (corner.y + edge.y) x scale y over the placement. Properties in metres are
  taken x 2048. The rotation counts: 3b's 29fe (yaw 180, side 3) faces -x and its 3 m edge runs
  along z (the port read it unrotated, along x facing -z, and found no floor under any anchor);
  2bfd / 1da5 under 3b's roof likewise. **No floor test**: the clamber is refused only when the
  body has no room on the box top (0x10011b30, "Player blocked from using the Clamber Point": a
  sphere of half the player shape's width swept up at the anchor from top + r + (H - 2r) / 4 to
  top + H - r), and only for the template the selection picked. The clamber clip is scaled to the
  ledge height (0x100119e0: player +0x68 = (top - feet) / the clip's height). Port: `clamber.ts`
  `clamberRoom`, `interact.ts tryClamber` (lands on the floor under the anchor when there is one,
  else on the box top).
- Mountable (1b mounted gun, a skinned model shown in its bind pose): p38 yaw range, p42 / p43
  pitch limits (aim 0x100183e0: at most p38 deg of turn either way from the placement's facing and
  p42 deg of pitch up or down [verified]; 9's searchlight 1376 50 / 55; `interact.ts
  mountedAimLimits`), p40 rate of fire (rpm), p45 damage, p55 / p50 muzzle and casing generators, p62 On /
  p63 Off. Every retail Mountable has p23 = 0, which is "no eye-ray test", not "unusable" (the
  usable family's can-use 0x100bae80 returns 0 at once for p23 = 0) [verified]. The barrel / beam
  runs along the model's **+Z** (gun 7:2918's muzzle hardpoint 3 at z +1.55; searchlight 7:1244's
  lamp hardpoint turned half round) [data]; the player stands at the Mountable Interaction
  Properties' p15..p17 offset (2:438 / 2:833: 1.4 / 1.7 m behind) and the mounted update
  0x10019ae0 rides the camera on hardpoint p45 [slot verified, use inferred].
  **Searchlights** (`world/searchlight.ts`): p49 is an Object Generator (7:2896 / 7:2898: Spot
  Light, Spot Light Cone 7:2902 / 7:2906 with model 3:362, 21 m long and 5.8 m wide, and the lens)
  spawned on hardpoint p51 through its Follower Object (0x10019090). The Mountable is lit or dark
  (0x10019510 spawns p55 at p56 and the p49 generator; 0x100193c0 deletes it and spawns p59 at p60,
  the bare lens); p32 picks the state at creation (1 lit, 2 dark, 0 neither, 0x100196d0) and each
  Fire press while mounted (action 0x428) switches it (0x10019e0c..0x10019e64) [verified]. A
  Detector with filter 4 reacts to the Spot Light Cone (§11.2): 3a's west walkway lights stop the
  CartWheeler cloners (Detectors 13ed / 1b5b) and light the yard pit (13f8), the way to the 4a exit.
  The generator's **Spot Light** 7:2895 (colour p0 0xf7f5f2, p8 start 1 m, p9 length 12 m, p10
  cone radius 45 m; the loader 0x4cf450 reads p8..p10 for every Spot Light, docs/re/renderer.md
  §2) rides the hardpoint with the cone and lights the world while the searchlight is lit
  (port: `engine-light.ts addSpotProvider`, after the flashlight's two spots, nearest first)
  [verified data; its axis along the cone's: inferred]. The lit state is saved with the object
  [verified: Mountable load vt +0x2c 0x10018fc0 restores the +0xc0 handle, the p49 generator's
  objects]; the port saves it and the beam's steering pitch (`searchlight.ts save / load`).
- Interaction Properties templates place the player and name the player clips (rig 328); the
  one-shot uses run through the Interact state (below, `world/use-anim.ts`), ladder rungs and
  push / pull through `actors/interaction-clips.ts`. Clip roles [template slots: data; roles
  inferred from each clip's root motion and the posed rig's hand / head heights]:

  | Object | Slot | Clips (rig 328) |
  |---|---|---|
  | Ladder p32 [bottom, top] Ladder Interaction Properties | p13 mount | 241 (up 0.5 m onto the rungs), 242 (turn, down 1.5 m) |
  | Ladder p33 Ladder Animation Set | p0 / p1 rung up, p2 / p3 rung down (0.5 m, 0.37 s, alternate hands), p4 / p5 hold, p6 step off at the top, p7 step off at the bottom, p8 slide, p9 / p10 let go / jump off | 234 / 243, 236 / 237, 240 / 239, 235, 244, 238, 248 / 85 |
  | Phone p31 Phone Interaction Properties | p22 lift receiver, p23 listen (loop), p24 hang up | desk 2:759: 560, 552, 551; wall 2:763: 555, 557, 556 |
  | Security Monitor p30 Interaction Properties | p13 reach up to the screen | 581 |
  | Pushable p32 Pushable Interaction Properties (one per side) | p22 grab pose, p23 push (1 m / 1.37 s), p24 lean (idle), p25 pull back, p26 strain | 205, 206, 249, 207, 250 |

  Ladder Interaction Properties p3 is the climbing face: 3 the ladder's local -z side, 1 its +z side
  (every retail ladder uses 2:427 / 2:428, both p3 3) [verified data; strong]; the port used the
  side the player stood on, which put him over 9's stairwell at the top of Ladder 11
  (`interact.ts ladderFaceSide`).

  The port plays ladder rungs one per 0.5 m climbed (rate matched to the climb speed) with
  the clip's root translation removed (the ladder code moves the player). Note:
  the player body's locomotion role table (player-body.ts ROLE_IDS) uses some of these ids
  (234 / 236 as jump / land, 206 / 207 / 249 as crouch walk / idle); they are ladder and push
  clips.

#### Use target: what Use goes to [verified unless marked]

Read in Suffering.rfl: the Player touch handler 0x1002bde0 (vtable 0x10150c68 slot +0x24), the
use attempt 0x10036240 (from the frame routine 0x1004c1c0), the Switch can-use 0x10131c30 with
its template choice vt +0xa0 / fit test vt +0x98 0x100bbe20 -> 0x100bb4e0, the anchor vt +0x94
0x100bb4c0, the line of sight 0x100bae80, and the Item touch handler 0x100bda00.

- **Candidates.** Every tick the objects touching the player are listed (Switch, Ladder, Toilet,
  Quest Item Pickup, Pushable, Security Monitor, Mountable, Phone, Light Housing, Clamber Point,
  Unspeakable NPC); the list is cleared each frame. No view ray, cone or camera term.
- **On the key** (Use 0x42b; Jump 0x42a looks at Clamber Points only) each candidate is asked
  can-use; "not usable" (3) drops it, locked (1) and busy (2) stay. The winner is the nearest
  by 3D distance from the player's feet to the approach point of the template it would use
  (p15..p17; a character's origin); strict <, last listed first. No priority field.
- **Switch can-use**: with the object's p23 set, a ray from the eye (player model node p285) to
  the object must be clear (characters, usables, Colliders, Clamber Points ignored) [the target
  point: inferred, the object's position]; then the first template of its list that fits:
  - anchor A = M.translation + R_current x (p7, p8, p9) m, M the saved placement (p0 = 1) or the
    current transform (p0 = 0); the offset always turns with the current rotation;
  - horizontal reach feet -> A <= p1, |dy| <= p2;
  - facing: the body's forward within p6 degrees of the way to A;
  - bearing of the player from the side normal (p3: 0 +x, 1 +z, 2 -x, 3 -z of M, flattened),
    counter-clockwise degrees mod 360, within p4..p5 (negatives + 360; p4 > p5 wraps);
  - p10 != 0 adds an eye ray to A (no door template sets it).
  Doors 2:391 / 2:389: reach 2 m, height 1.75, facing 75, bearing -90..90, anchor (+-0.1, 1.2, -2).
- **Pickups are never used.** An item is taken by touch (0x100bda00, the toucher must be the
  player): within Player p239 / p240 (2 m horizontally / vertically) the pickup starts (or with
  item p28 an Interaction Properties pick-up clip, player state 26, when the item is within p30 m
  and +-p31 degrees of the body facing and holds something new); item p35 asks for a clear line
  of sight, p44 caps what the player may already carry. The 1a flashlight 6978 (Ammo Box 4:220:
  p28 2:538, p30 2 m, p31 90) is taken by walking up to it.

Port (`world.ts pickTarget`, `interact.ts switchReach`, `use-anim.ts switchFit`): the port keeps
its own prompt (the object looked at) and takes items with E [port]. An item offered (looked at
within ~22 degrees and 2.8 m) now comes first, since the original takes it on contact whatever
usable is around; then the other usables (`interact.pick`); a Switch is offered only when one of
its templates fits as above (view yaw for the body's facing: the port's body lags the view
standing still), the nearest approach point first. Before, any door whose box the view ray
crossed within 3 m won over items: in the 1a office the open door 561b (6.4 m from the
flashlight) was offered instead of the flashlight. Not modelled: the eye ray of p23 (the view
ray to the box stands in), the fit test for the other usables. Tests: `tests/use-target.test.ts`.
A Switch with no model (the only one is 6a's truck jack a08, Interaction Properties 2:924) has no
box to look at: it is offered when a template fits and the view passes within 0.6 m of its anchor
(`interact.ts viewOnAnchor`) [inferred: its touch volume is not decoded]. Test:
`tests/woods.test.ts`.

#### Use animations: the Interact state (player state 22) [verified unless marked]

Found in Suffering.rfl: state table 0x10176488 (entry 22 "Interact": enter 0x10035040, per frame
0x100369a0, leave 0x10035580), the use attempt 0x10036240, the Player message map 0x10174af0
(StartInteract 400 -> 0x10034910, EndInteract 401 -> 0x10034a10) and the usable-object vtable
slots (+0x9c approach, +0xa0 pick the template, +0xa4 can-use, +0xb4 locked clip, +0xb8 / +0xbc
the two events, +0xc4 align time, +0xcc clip, +0xd4 current template, +0xe8 arrive, +0xec p27).
Port: `src/game/world/use-anim.ts` (UseAnimator), driven by `interact.ts`.

- **Who gets a clip.** A use runs the state when the object's Interaction Properties name a clip
  (Phone, Quest Item Pickup, Security Monitor, Toilet, Switch: doors, levers, cell sinks, lockers;
  Pushable / Mountable / Ladder have their own states and pose sets). Data (all levels): doors
  2:196 / 2:197 / 2:198 / 2:200 / 2:201 / 2:204 / 2:692 / 2:693, bar doors 2:431, levers 2:208 /
  2:302 / 2:427 / 2:428, sinks 2:426, lockers 2:322 / 2:323 / 2:425, toilets 2:429, monitor 2:581,
  the 1a Shiv spot 2:511, phones above.
- **Template fields** (every Interaction Properties kind shares p0..p21): p13 the clip (a Phone
  reads p22..p24), p14 a Switch's locked-attempt clip (rattle the handle); p15..p17 where the
  feet go, in the object's axes (origin + p15·x + p16·y + p17·z, 0x100ba5b0); p11 / p12 the
  facing: with p12 = 1 along side p11 of the object (0 +x, 1 +z, 2 -x, 3 -z), else towards its
  origin; p18 then turns it (degrees); p0 = 1 measures from the placement saved at load (+0x4a),
  0 from the current transform (a swinging door); p19 (0.2) the seconds to get there; p21 what
  happens to held weapons (0x10037530: 1 holster when the weapon's PWP p171 says so, 2 the
  off-hand gun, 3 both) [reads verified, roles inferred; not modelled]; p1..p6 the shared reach /
  side tests (0x100bb4e0, as for Clamber Points); p20 read by +0xac [role not traced]. The sign of
  p18 [strong]: counter-clockwise from above in the port's frames puts the 2:511 hand 0.22 m from
  the Shiv grip at StartInteract (0.52 m the other way); the phones' 180 cannot tell.
- **Sequence.** Enter: p27 fires at once (+0xec), the view pitch is zeroed, the start transform
  saved, the weapon's idle plays. Align: the player's position is lerped and its rotation
  slerped onto the approach over p19 s; movement input is ignored, the third-person camera may
  orbit (Camera Yaw state 24). Arrive: +0xe8 (a Switch without a clip starts moving; a Quest Item
  Pickup / Phone mark themselves busy), then the clip plays whole-body (0x1004cb20: blend -1,
  rate 1). StartInteract and EndInteract call +0xb8 / +0xbc with the event's bone. The clip's
  end leaves the state (a Security Monitor goes on to View Monitor). Leaving calls +0xdc(0),
  which completes what the events did not (a Quest Item Pickup hands its item over).
- **What the events do.** Switch: StartInteract starts the motion (fires 66 / 67, 0x10130da0).
  Toilet: StartInteract flushes (0x1001cf40, once per p34 s). Quest Item Pickup: EndInteract
  hands the p33 item over (0x10125820). Phone: below. Locked switch: the attempt (68, 27, key
  check in +0xa4) happens at the use; with p14 the player walks up, the rattle sound (IP p23,
  +0xc8) plays on arrival and p14 plays; without p14 only the sound.
- **Message timing.** p27 at the use, before the walk-up: 1a's Timer 8369 -> 836c BlowUp to the
  inmate still comes 0.98 s after the key, while the Shiv itself arrives at the clip's
  EndInteract (0.2 + 0.79 s). Switch 68 also at the use; the switch moves 0.2 s plus the clip's
  StartInteract later (2:200: 0.46 s).
- **First person** (0x1003675f: test of state 16): Switches and Toilets are used at once, with no
  walk-up and no clip (+0xdc(1), +0xb8, +0xdc(0), +0xbc(1) back to back; a Toilet then fires no
  p27; a Switch fires p69 where third person fires p68 - the port keeps 68, §11.1). Every other
  usable enters the Interact state as in third person; the first-person model (2:138, same rig)
  plays the clip, filmed from the eye fixed to the model (1.85 up, 0.44 behind its origin) with
  the pitch at 0. Port: the eye moves to that spot over the walk-up (`PlayerController.eyeOffset`)
  and back after, the arms' neck hold is off (`PlayerBody.holdNeck`), yaw and pitch are held.
- **Phone** (stage code 0x10035ba0, Phone per-frame 0x1001a470). At load the phone spawns its p30
  Breakable at its own placement and the two swap models (0x10015d30: engine +0xb8 = set model):
  the Phone object wears the receiver (7:836 / 7:837) and the spawned Breakable the body
  (7:842 / 7:840). StartInteract in p22 sets the held bit with the event's bone; while held the
  Phone object's matrix is that bone's (0x1001c830). The bone (b_c19ac300, rig 2:9 bone 27) is a
  prop bone whose frame at the event is the phone's own frame (within 3° / 2 cm for the wall
  phone's 2:555, 15° / 16 cm for the desk 2:560), so the receiver leaves the cradle there and
  rides to the ear. After p22 the listen loop p23 plays while the line (or the dial tone p34)
  runs; then (or at once on Use / Jump, 0x42b / 0x42a) p24 plays, and its EndInteract puts the
  receiver back on its saved placement and stops the sound. Port: the separate receiver prop
  (`props.ts` `receiverOf`) takes the bone's matrix between the two events, with collision off.
- **Root motion** [inferred]: the clip is started without extraction flags, but door clips end up
  to 1.2 m from where they began (2:200 / 2:196 end 1.21 m back) and do not return, so the port
  moves the feet by the clip's horizontal root translation.
- **Port only** [inferred]: of a template list the one whose approach is nearest the feet is used
  (the original takes the first that passes 0x100bb4e0); clip events a clip lacks (bar door
  2:431) run when it ends; the feet stay on the floor under the approach (p16 is relative to the
  object); a use is cancelled when a cinematic takes the player or he dies (onDone(true): the
  receiver goes home, a Quest Item Pickup still hands over its item).
- Checked in headless Brave (1a / 1b): the Shiv pull in third and first person (inmate BlowUp
  1.05 s after the key including input latency, the Shiv at EndInteract), a desk phone in both
  views (receiver lifted at 1.2 s, at the ear while the dial tone loops, back on the cradle at
  the hang-up's EndInteract), door 5616 (opens at StartInteract, the player steps back 1.21 m with
  the root motion), cell sink 5a4b, 1b locker 890b (open and close), a cinematic and a death
  during a use. Tests: `tests/use-anim.test.ts`.

### 14.6 Chapter 1 coverage (1a / 1b / 1c instances)

| Class | Count | Port |
|---|---|---|
| Breakable / TargetableBreakable | 225+1 / 409 / 42 | damage, break FX, remains, chains, save |
| Light Housing / Point Light | 148, 258 / 50, 150 / 17, 46 | start state, material tables, glow cones / pools, broken remains, lights, flicker |
| Pushable | 7 / 32 / 0 | push (only those with a drawn model) |
| Mechanism | 19 / 1 / 3 | rotation, sweep, spin |
| Phone, Security Monitor, Toilet | 14, 14, 11 / 3, 0, 0 / 0, 1, 0 | use |
| Ladder, Clamber Point, Mountable | 1, 0, 0 / 2, 5, 1 / 3, 0, 0 | climb, clamber, mounted gun |
| Particle Fountain, Object Generator | 54, 98 / 7, 17 / 0, 8 | particles, spawns |
| Volumetric Fog, Billboard | 13, 6 / 7, 0 / 1, 2 | fog puffs, glows |
| DripMorphingModel, MorphingModel | 19, 1 / 30, 0 / 0, 0 | frame cycling, drops |
| Instance Rendered Object | 20 / 0 / 76 | scattered instances |
| Sky / Sun, Fog / Sky Switcher | 5, 1 / 3, 0 / 10, 2 | camera-centred sky, fog blend |
| Lighting Effect | 3 / 3 / 0 | colour / strength curves (templates on lights too) |
| Map Switcher | 2 / 6 / 2 | current map template (`__world.map()`) |
| Node / Instance Prefetcher, Level Transition Remover, Simple Material | | no-ops |

Not done: the fluorescent hum (Light Housing p34 Sound Effect 3:1529, play mode 1, switched with
the lamp; left out because every lamp would hold a looping voice), skinned Light Housings
(drawn by the sequence presenter, no table swap), Mechanism translation (group p22–p31, unused in chapter 1), phone subtitles,
the mounted gun / clamber / toilet player clips. (The effect templates inside generators -
Muzzle Flash, Camera Shake, Fire, Electric Arc, Water Ripple, blood, decals - are run by the fx
system, §17.)

### 14.7 Collision: Invisible Static Objects and which objects block

**Bug (1a).** After the "Gaurd" #114 scene (`6045`), the corridor east of the guard post is
full of fallen ceiling rubble, but the player walked through it to x 477 and onto a catwalk
outside the level. The rubble is two skinned Breakables, "Celing_Blocks" `72b7` (9:2581) and
"RubbleREC" `734d` (9:2659), posed by the sequence's animation keys and drawn by the sequence
presenter. They had no collision in the port. That is not the original's rule, though: these
models carry no collision data.

**Which models can collide [strong: data].** Every non-skinned model of the 1a package set has
a type-7 entry in its `.mdu`, the bounds / collision record: 3762 of 3762. None of the 164
skinned models (type 8) has one. The only volumes a skinned model carries are the bone spheres
of the skeleton trailer (§7.1), and neither rubble rig has any. So in the original, skinned props
(the rubble, the 1a intro's busted doors, Torque's belongings, the Chain of "Guard" #242) do not
block movement either. The port keeps them that way: the sequence presenter draws them with no
body. The skinned Mountables (mounted guns, searchlights), built by the world system, keep a
body for shots only (`COLLISION_LAYER.projectile`, dynamic.ts): in 2 Cellblocks the gunner 7f4
stood inside the bind-pose triangles of his gun 2dbf and could not leave the nest when his
script sent him out.

**What blocks in the original: Invisible Static Object** (class `0xaa7d6985`; System template
2:312 / 2:412 / 2:413 / 2:623 / 2:624 / 2:658 / 2:840; model 2:171, the unit cube, sized by the
instance scale). Designers close off what the geometry leaves open with these boxes. Three of
them seal the rubble: `72c2` (x 446.75..447.75 across the corridor) and `7658` / `7659` (side
walls at z 535 / 541), all of template 2:312. Code [verified, Suffering.rfl]:

- The constructor (`0x10020110`) calls SetVisible(0) on its engine object (vtable `+0x128`). It
  is never drawn, whatever instance flag 0x1 says.
- Input slots **p7 On / p8 Off** (map `0x10178678`; handlers `0x100bc940` / `0x100bc920`) clear
  or set engine object `+8` bit **0x400000**, the engine's per-object "no collision" bit. The
  bit is saved and restored with the object (`0x100bc960` / `0x100bc980`). The EXE's collision
  gather (`0x425a80`) skips objects that carry it, and an engine setter (`0x453dc0`) applies it
  to an object and its attachments.
- Block test `0x100bc9d0` (asked with the moving object): Off blocks nothing. Otherwise the box
  blocks unless the mover is of a kind whose flag is 0:

| prop | mover | test |
|---|---|---|
| p1 | the Player | class `0xc8bc44e1` (`0x100012f0`) |
| p2 | characters | engine object type (`+0xe4`) 7 (`0x100e1760`) |
| p3 | Pushables | class `0x5febd8e9` (`0x10123890`) |
| p4 | engine object type 10 | [unknown kind] |
| p5 | projectiles | Missile, BouncingObject or Lightning (`0x10028370`) |
| p0, p6 | not read there | |

  Retail filters: 2:312 / 2:840 block everything (p1..p5), 2:624 only the player ("player
  clips"), 2:412 only pushables (1a's lobby statues, 1b), 2:413 characters and projectiles, and
  2:623 / 2:658 nothing.
- Hidden objects [strong]: the gather tests visibility (`+8` bit 0x1). An object that is not
  shown is kept only when the mover's per-class table (mover `+0x588`, indexed by the other
  object's class) has bit 0x4. That is how the always-hidden boxes still block, and why the
  port's rule "hidden = no collision" (dynamic.ts) holds for ordinary objects.
- PhysicalObject **p17**: no read of it was found in the PhysicalObject / Breakable code with the
  usual property-read pattern, so "p17 = blocks movement" (§14.1) stays a guess. Broken remains
  keep using it (props.ts).

**Chapter 1 boxes.** 1a has 48 (`72c2`, `7658`, `7659` at the rubble; `8455` / `8858` 2:312;
`88ea` 2:840, a plate on the floor; 35 player clips 2:624; four
pushable-only 2:412; three that block nothing). 1b has 42 (31 player clips, nine pushable-only,
two 2:413). 1c has 16: 12 player clips; the 2:312 slabs `7b86` / `7c34` (0.5 m thick and tilted)
and boxes `7d48` / `8078` are walkable ramps, with Waypoints `7b8c` / `7b8d` on top; and `80bd`
(7:2704), which blocks nothing. Toggled ones: 1a `897d` (Off from Relays `897f` / `8980`) and `8a22`
(Off from Timer `8a23`); 1b `88af`, `8b2e`, `8b70`, `8b7f` / `8bd3` and `8b80` go Off when a
Breakable next to them breaks (its p21 = Off).

**Port** (`src/game/world/blockers.ts`, `src/app/physics.ts`):

- One dynamic body per box. Its filters become `COLLISION_LAYER` bits (player, character,
  pushable, projectile). A dynamic body has layers, and `CollisionWorld.queryLayers` picks the
  bodies a query sees. It is `solid` by default, so sight, the use ray, shots and decals pass
  through the invisible boxes. `CharacterMotor` widens it for its own step and teleport with
  `MotorConfig.layers`: `player` for the player (player.ts). The push test of Pushables
  (props.ts) adds `pushable`, and thrown objects (weapons/system.ts) add `projectile`. p4 has no
  mover in the port.
- **p2 is not applied: NPC motors ignore the boxes, as before.** What engine object type 7 means
  (`+0xe4`; other RFL code compares it with 4, 7, 10 and 14) was not identified, and the
  data says it is not "every character". 1b's CartWheeler `6501` is placed inside the p2-only
  box `8c2b`. 1a "Gaurd" #86 (`5da5`) keys its guard `7508` from the post to x 451.6, past the
  rubble boxes. He calls out to the player (sound 12:18), is released
  there, and #114 keys him back to x 434.9 (voice line 12:20) before the rubble
  buries him. With p2 on the NPC motors, his release teleport and any AI walk would run into the
  boxes, so p2 stays off and NPC movement is unchanged. Checked in the browser: #86, #114 and #218 (`6206`, guard `609f`
  at the office bars) all play. That holds for the harness route and for a player who follows
  the guard east to the rubble and comes back into Detector `7ac1`. (What starts #86 / #114 for
  a player who walks the hall naturally: §11.5 item 5.) The escort `609e` steps of
  the route pass.
- The playthrough planner (`tools/playthrough-page.js`) plans with the player's layers, so its
  paths avoid player clips.
- p7 / p8 set `s.collisionOff` on the entity, which the world save carries; the bodies follow
  it every frame.
- Checked in the browser: after the scene, walking east along three lanes of the corridor,
  diagonally from both sides and west from the far side, the player stops at x 446.4 / 448.1
  and never gets past the rubble (before the fix: x 477). A plain sweep (sight) still passes.
  Tests: `tests/blockers.test.ts`; playthrough step `1a.rubble`. Other chapter-1 checks: no
  Detector is more than 37 % covered by player clips (1c `7e11`). The only NPC nodes inside
  boxes that would stop characters are the floor plate `88ea` (1a Move Node `8b4f`), 1b `8c2b`
  (above) and the 1c ramps.

**Other scripted objects in chapter 1 (audit)** (script-shown, toggled, grouped or moved by a
sequence, with a static model):

- Static models (doors, the fallen cell door `848d`, bars, crates, corpse props): dynamic.ts
  builds them and gives them a body while they are shown. 1a 166, 1b 47, 1c 14 objects.
  Pickups have no body. Effects and morphs are NON_SOLID.
- Skinned props held by sequences are drawn without collision, as in the original. 1a: the
  rubble `72b7` / `734d`, the busted cell / corridor doors `69ec` / `58b3` / `68a8` / `702e`,
  the flashlight `5ae2`, the shoes / box `7b18` / `7cb3`, Chain `7faa`, `4eb5`, the curtains
  `7f5f` / `8481`. 1b: `829e`, `882b`. 1c: `72c2`, `7337`.
- Animating Statics (skinned corpse doubles and hanging bodies shown by Visibility Togglers;
  1a 14, 1b 10) are drawn by the actors system with no collision. That also matches the missing
  collision data, unless their rigs carry sphere trees (not checked).
- 1c `808d` (a skinned Switch, 6.7 × 3.8 × 2.5 m, hidden at start) is now drawn as a projector
  target (§14.8). Open: 1b's
  Object-Grouper Pushables `79ef`..`8295` and `8286` (flags 0x801, p23 = 0) are not built at
  all (docs/playthrough.md). The first is skinned and so has no collision data. The others
  would need checking against the original.

### 14.8 Skinned objects that only skinned-props.ts draws (audit, every level)

Several paths draw placed models without animating a skeleton:
- the static level geometry (level.ts);
- dynamic objects (dynamic.ts);
- the sequence presenter's props (sequence/props.ts: Breakable / Static Object / Light Housing /
  TargetableBreakable that are STOMP tracks).

The first two skip skinned models. Everything else placed with a skinned model (outside the
System package of editor proxies) was audited over all 18 levels.

| Class | Level instances | Drawn by |
|---|---|---|
| Characters, Animating Static, Ambient Creature | all | actors |
| Mountable | 1b etc. | dynamic.ts, bind pose |
| Breakable / Static Object / Light Housing / TargetableBreakable / Switch, not a presenter prop | 1a 7337 / 734e / 7350 / 68a9 / 6e68 / 8897; 1b 58b3 / 5ae2 / 68a8 / 69ec / 702e / 72c3 / 7337 / 734e / 7350 / 77e0 / 68a9 / 6e68; 1c 58b3 / 5ae2 / 68a8 / 69ec / 702e / 734d / 734e / 808d / 68a9 / 6e68; 5b 1baf..1c3a, 2c4a..2c61 (projector targets); 4b 7829 / 782a; Prelude f85; the 6a / 6b / 8a / 10 lamps; cranes | `levels/skinned-props.ts` |
| Item family (Ranged Weapon 4:15 / 4:26 / 4:88, Ammo Box 4:282 / 4:115) | 1b 88fa / 8c1d, 2, 3a, 3b, 4a, 10 | dynamic.ts, bind pose (was undrawn) |
| Black One | 10 Docks | specials/black-one.ts |
| Projector Effect | the effect object itself | hidden by its init (§15.7.8) |

Rules:
- Visibility. skinned-props.ts used to require flag 0x80 and skipped chapter 1. Flag 0x1 at load
  and the level logic are the visibility; the instance loader never reads 0x80 (object-model.md
  §2) [verified there].
- Pose. Bind pose: no PhysicalObject class names a clip [inferred], and the projector figures'
  anim sets hold a single 2-frame pose.
- Motion. STOMP transform and animation keys reach these Characters (the sequence presenter's
  `skinnedProps.character`). A Switch's door motion is not applied (no retail skinned Switch
  is usable).
- Breaking. The world's props.ts: health, the p18 generator, p21, destroy. A destroyed object is
  hidden.
- Collision. None: skinned models carry no collision record (§14.7).

Check: `tests/skinned-props.test.ts` asserts that every skinned PhysicalObject of 1a / 1b / 1c has
a system that draws it.

### 14.9 The character mover: collision volume and ground

Code: `src/game/actors/mover.ts`, `src/app/physics.ts` (`MotorConfig.groundProbe 'centre'`,
`centreGround`). Tests: `tests/mover.test.ts`.

**Who moves a character** [verified]. The Character constructor (Suffering.rfl `0x100e5030`)
builds two parts that move it. Both get cos(p46), cos(p47) and p48 x 2048:
- the mover component +0x1ae (`0x1009fa60`). It holds an EXE mover (SUFFERING.EXE class vtable
  `0x58eb08`, made by the world's vt+8 `0x423780`) and the collide list `0x10178c40`;
- the ground follower +0x26c (`0x100b6680`). It holds an EXE follower (vtable `0x58eb78`, made by
  the world's vt+0x10).
Each frame (Character think `0x101156f0`) the character's own motion is given to the mover
(vt+0 Move, `0x1009f580`). The mover sweeps and slides it (vt+0x1c `0x41fc30`: sub-steps
`0x41fa30`, contact response `0x41c620`, ground pass `0x41e4b0`). The ground it found goes to the
follower (`0x1009ef60` -> `0x100b6730`), which sets the height. The player's controller uses the
same EXE mover class with the same Move call (Suffering.rfl `0x1002cc6b`); the port keeps the
player's own motor (not changed).

**The volume** [verified data and code path].
- p42 is the template of the character's movement proxy. `0x1009f1a0` stores it and
  `0x1009efb0` creates it on the character. The template is a **Collider** (class `0xfa5951fc`),
  and the mover takes it as its object (vt+0xc).
- The proxy's collision is its model's sphere tree (.mdu type 7, `model-spheres.ts`). Node 0 is
  the bounding sphere; its `first` starts the chain of leaf spheres the mover collides with
  (`0x41ac00` walks them).
- Collider p0 names the **foot sphere** (mover +0x10). It is node 1 in every retail Collider, and
  its centre is the character's origin (the commit `0x41c0b0` places the proxy so).
- Scale: `0x1009efd8` builds the proxy's matrix from 1 / the character's scale, and the sweep
  (`0x41ac00`) multiplies the radii by the proxy's own scale; how the two combine was not traced.
  The data says the spheres scale with the character [inferred]: designers shrink Slayers for
  indoor levels (0.66 in 8a, 0.72 in 1b), and 1b's Slayer 7ffc (0.72) lives in a room about 2.7 m
  high, which an unscaled 3.15 m stack does not fit (with it the port pressed the Slayer 0.43 m
  into the floor). p48 is a distance and does not scale.

Retail Colliders (offsets from the foot sphere's centre, radius r):

| Collider (model) | Characters | spheres (height, r) | p46 / p47 / p48 |
|---|---|---|---|
| 10:77 (10:9) | CartWheeler, Burrower | 0 (foot), 0.791, 1.225, 1.704; r 0.4 | 45 / 60 / 0.4; Burrower 90 / 90 / 2 |
| 10:149 (10:21) | Unspeakable NPCs (people), Hermes, Horace, Killjoy | 0 (foot), 0.865, 1.703; r 0.45 | 45 or 40 / 60 / 0.4 or 0.2 |
| 10:1389 (10:142) | Slayer | 0 (foot), 1.3, 2.5; r 0.65 | 75 / 80 / 0.8 |
| 10:380 (10:85) | Fester | 0 (foot), 1.087, 1.851; r 0.7 | 45 / 60 / 0.2 |
| 10:198 (10:32) | Mainliner | 0 (foot), 0.686; r 0.4 | 45 / 60 / 0.4 |
| 10:1221 (10:126) | Inferna | 0 (foot), 0.865; r 0.4 | 45 / 60 / 1 |
| 10:310 (10:38) | Nooseman | 0 (foot), 0.714; r 0.4 | 65 / 90 / 0.5 |
| 10:521 (10:84) | Rat | 0 (foot, r 0.2), 0.394 (r 0.3) | 75 / 75.1 / 0.2 |
| 10:1429 (10:141) | Unspeakable NPC 10:1424 | -0.5 (foot), 0, 0.5; r 0.25 | 40 / 60 / 0.2 |

**Contacts** (`0x41ee40`, `0x41c620`) [verified].
- Walkable means contact normal . up > cos(p46) (`0x41f6e5`).
- `0x42a440` also accepts the band down to cos(p47) when the mover has flag 8 and the surface is
  more than 0.195 m long along the slope. No character sets flag 8 [inferred: no setter found],
  so p47 does not widen the mover's ground.
- A walkable contact of the foot sphere is a ground candidate (`0x41d300`), not an obstacle.
- A non-walkable contact of the foot sphere is ignored when the collider has other spheres.
- The other spheres ignore walkable contacts (`0x41c7db`) and block on the rest: they are the
  body's walls.

**The ground** (`0x41e4b0`, `0x421500`) [verified].
- Of the candidates, a triangle counts only if the foot sphere's centre lies over it. The test
  projects the centre along up onto the triangle. The test point is first moved 30 units (1.5 cm)
  towards the triangle's centroid, so a seam or a rim within 1.5 cm still counts.
- The triangle's plane under the centre must also be within the foot radius of it: below, or on
  either side while the body moves down. While the body does not move down, a plane above the
  centre counts at any height.
- The highest such triangle is the ground (`0x41b490` records it, mover flag 0x20).
- So **a body whose centre is over a drop has no ground**, however much of the foot sphere rests
  on the rim.

**The follower** (`0x100b6730`, EXE `0x42adf0` / `0x42a570`) [verified].
- It keeps the ground triangle while the feet stay over it or over a walkable neighbour of the
  same object.
- With no mover ground, it falls back to the outdoor Landscape's height under a probe 2 m above
  the feet (`0x100c0520`), else to "none".
- While grounded, ground up to **p48** below the feet is snapped to, and any ground above it.
- Ground deeper than p48 starts the fall (follower flag 2).
- **Step up** is the foot radius [inferred]: a ground candidate is a surface the foot sphere
  touches; the next sphere up blocks anything higher.
- **Sliding** [inferred]: a steep surface is never ground, so a body on one falls, and its spheres
  slide along the slope.

**Port.**
- All sizes are the Collider's times the character's scale.
- The spheres other than the foot become the NPC motor's capsule, their hull: radius r, up to the
  highest sphere's top. It starts at the lowest sphere's bottom, but no lower than the foot radius
  (the lower spheres ignore the walkable contact of a ledge the foot climbs; the Rat's sphere
  reaches down to 0.094 m, its foot climbs 0.2 m) [inferred].
- The foot sphere becomes the motor's centre ground probe. It looks from the foot radius above the
  feet down to p48 below them (the grounded snap). It casts rays at the feet point and 1.5 cm
  around it, and passes steep faces to find the walkable surface under them.
- Before, every NPC had a sphere probe of 0.85 x its capsule radius (`kind.radius`, up to 0.6 m x
  scale). A wide body stood on a ledge rim with its centre over the drop (3a CartWheelers 1b5d /
  1b5e 0.76..1.0 m up, 4a `4a.wake`, 1c). The capsule was the bind-pose height (Slayers 3.8 m),
  so 6a's Slayer 2337 could not get under a leaning log.
- Instance p46 / p48 override the template's (Horace 10:581 in 1a has p48 0.1).
- Kinds with no Collider (decorations) keep the old capsule.

**Which objects a mover collides with** [verified]. Before its sweep, a mover sets the scene's
per-class collision filter (the world's filter object +0x580, SUFFERING.EXE vtable `0x58c5a8`: a
byte per class; +4 `0x424550` clears bit 1 of every class, +0x24 `0x4245a0` sets it for one class;
the gather `0x425e50` keeps an object only when its class has bit 1).
- A character's mover component (per frame `0x1009fb80` -> `0x1009ee20`) clears the filter and
  turns on Detector plus its collide list, which the Character constructor passes in
  (`0x100e5123`: 18 classes at `0x10178c40`): Static Object, Invisible Static Object, Animating
  Static, Mechanism, MorphingModel, Pressure Plate, Switch, Ladder, Breakable,
  TargetableBreakable, Pushable, Detector, Particle Fountain, Fire, Water Volume, Phone, Toilet,
  Collider. Its own proxy is switched off (+8 bit 0x400000) for the gather.
- The player's movement query (`0x1002c340` with 1) turns on Detector and the 20 classes at
  `0x101509c0` (docs/levels.md, Water Volume).
- Neither list names **Decoration** (class `0x10d88bf0`, category 12 "Special Effect"): fog
  planes, cables, papers, posters, light beams never stop a mover. 9's burial ground has four 12 m
  fog quads (Decoration 3:2181, model 3:440, texture 3:267) 0.42..0.48 m over the terrain. The
  port collided with them: an Inferna's capsule (from 0.465 m) met a quad's edge as a wall, or
  rested on it with its probe (from 0.4 m) under it, and where the terrain rose under a quad the
  body stood on it. So c9b / c9c never walked, Count Down ddd never reached zero and the guard's
  escort waited (docs/playthrough.md, row 9-12).
- Port: Decorations' parts are `moveSolid: false` (`blockers.ts decorationUids` ->
  `moverPassObjectProviders` -> `MeshPart.moveSolid`). Their triangles carry
  `COLLISION_LAYER.decor`, which the plain queries (sight, shots, the use ray, decals) see and a
  `CharacterMotor`'s queries (`solid` plus its own layers) do not: neither the player nor NPCs
  collide with them. Since §14.10 the collision world holds only the classes the lists name, so
  Decorations collide with nothing (rays included) [inferred for rays]. The
  other classes of the lists are not applied class by class. Water Volume is in both lists
  (docs/levels.md; the port's NPC motors pass water). The p2 filter of Invisible Static Object
  is "engine object type 7" (`+0xe4`): the class category, 7 = Ground Enemy, every Character
  class (entity-classes.ts) [strong: the category numbers match the filter's type arguments].

**The Landscape fallback (port)**. The follower's fallback above is the ground of a body under
the terrain: 9's Inferna bd5 is placed 0.663 m under it (also 10's Burrower db4 0.55 m, Slayer
f93 0.46 m; 3a's Slayer 28c3 0.48 m; 4a's Burrower 7ac2 0.84 m; 6b's Fester a52 and people;
dozens of Move Nodes). The port's capsule rested on the terrain from below with the probe under
the surface: the body never had ground ("sinking -0.47" in the harness). Port (`physics.ts
landscapeGround`): with no walkable mover ground under the feet point, the highest Landscape
triangle (parts with floor layers, `COLLISION_LAYER.landscape`) under a point 2 m (4096 units,
`0x10155808`) above the feet, down to the snap reach, is the ground, when walkable. With a mover
ground, the original also takes a higher Landscape when it is under the probe point (the
follower's branch after `0x100b6828`); that Landscape lookup goes through the character's
current region object (`[follower+0x50]+0x64`), which the port does not model, and taking it
anywhere would lift bodies in rooms under the terrain (1a node 811a, 3b 1eff, 8b 12a5), so the
port leaves it out [inferred]. `actor.ts groundGap` (the placement check) treats a surface just
above the feet with nothing under them as the floor the feet are sunk in (9's c9c, 0.196 m under
the terrain, was hidden as a drop-in), and passes Decorations as movers do.

### 14.10 Object collision: the collision tree, not the drawn triangles

**Bug (9 Lighthouse).** The guard bc9 stalled at (297.3, 113.7, 244.2) by the burial ground: his
capsule met the alpha-tested leaves of Static Object 884 (template 23:153, model 23:142, texture
23:56) 1.2..4.4 m up, 0.47 m west. Every escort leg from there failed, Waypoint e08 was never
reached and 9 could not be left (docs/playthrough.md rows 9-12..9-15). The port collided with
every drawn triangle of every placed object.

**The collision model** [verified: loader SUFFERING.EXE 0x484020 -> 0x482d10 -> 0x481ea0; every
type-7 entry of the 1a / 3a / 9 / 10 package sets parses to its last byte, test]. The .mdu type-7
record is the model's collision model:
- the bounding sphere and box (as model-spheres.ts read them), then u16 kind at 0x48: 0 sphere
  tree, 1 box tree, 2 bone spheres; u16 node count at 0x4a (0: the record ends there, 76 bytes);
  four u16 (+0xc0..+0xc6); the nodes.
- A box node is u16 first child, u16 next sibling, a box (corner, three edge vectors), u16 n and
  n face indices into the model's faces (54 + 2n bytes). A sphere node is first, next, centre and
  radius (20 bytes). A node with no child is a leaf.
- In 9's packages 1844 of 1847 box trees list no faces: a model collides as a handful of boxes.
  The canopy 23:142 (328 cut-out faces) is one leaf box 2.2 x 5.9 x 14.5 m; its world box is
  x 285.5..300, z 246.8..249, y 113.1..119, north of the guard's leg to node 97 (292.5, 241.75).
  A building like 23:394 (4872 faces) is 87 leaf boxes, a cell door 9:2027 (bars) one slab.

**Which geometry each query uses** [verified unless marked]:

| tree | movers (0x41ee40 / 0x41c340 after the tree-tree narrow phase 0x428b30) | rays (per-object ray 0x4283c0) |
|---|---|---|
| box tree | each leaf box (12 triangles, 0x422ee0 -> 0x421e00); a leaf that lists faces is those faces (0x422f30) when the object's bounding radius is over 200 units (0x41f0ff) | leaf boxes; a leaf with faces is its faces (0x4276b0) |
| sphere tree with nodes | its leaf spheres (0x41c56a -> 0x4220b0) | leaf spheres (0x426b38) |
| sphere tree without nodes | nothing (0x41c52b) | the bounding sphere, then every face of the model (0x42693d -> collision interface +0x2c 0x424b20): the drawn faces |
| box tree without nodes | nothing (0x41f0cf) | not traced |

- Engine object `+0xc` bit 0 is not a collision setting: it is "model bound", set by 0x4582d0 the
  first time vt+0x3c (get model) finds the model loaded. The ray tests the bounding sphere alone
  until then. The movers' gather calls vt+0x3c(1) on what it collects and the renderer on what it
  draws, so in play every object uses its tree.
- **Alpha-tested foliage** has no rule of its own: what collides is what the designers put in
  the tree. No retail tree lists a cut-out face.
- Classes: a mover collides with the classes of its collide list (§14.9). Detector is touch-only,
  Water Volume goes to the water component (docs/levels.md), Fire and Particle Fountain are touch
  volumes, Collider is the mover's own proxy: none blocks. Light Housing, Mountable, Security
  Monitor, Quest Item Pickup and Electric Shield are in the player's list only. Rays [inferred]:
  the ray queries take the scene's class filter as their caller left it (not traced); the port
  lets rays see what either list collides with. Decorations collide with nothing.
- Sight: a character's line of sight (0x100c7270 with flags 0xa00 from 0x100e25ed) runs the scene
  query 0x100c6630, which skips objects whose engine `+8` has bit 0x20000 (0x100c6c13, flag 0x800)
  and Invisible Static Objects with p6 = 0 (flag 0x200). The instance loader (0x45a77f..0x45a7c4)
  sets 0x20000 from template flag bit 10, or with instance flag 0x2000 from instance bit 0x1000000
  [verified]. 1a: 385 Static Objects (pillars, railings, the cell fronts), the cell doors (Switch
  9:2027), lamps; 9: 163 Static Objects with the burial-ground trees. The BouncingObject sweep
  (0x100ceff0) passes 0x110 or 0, never 0x800: thrown things do not pass them [verified]. Bullets
  pass nothing either [inferred: the Missile's own query was not traced]: 3a's gas tank 13c3, which
  the level has the player shoot, carries template bit 10.

**Port** (`src/formats/model-collision.ts`, `src/game/world/object-collision.ts`):
- `parseLevel` with `collisionOf` builds `LevelData.collision`: the floor layers (drawn, and the
  hidden ones below), and
  each placed object of a colliding class as its tree (boxes, listed faces, spheres as an
  80-face polyhedron around the sphere) at its placement and scale. Ray-only geometry (a sphere
  tree without nodes: the drawn faces) has `COLLISION_LAYER.decor`, player-only classes
  `player | decor`. Parts carry `sightPass` (template bit 10). Box triangles take the material of
  the model's largest submesh for footsteps and impacts [inferred].
- The renderer builds `collision` from those parts, and `drawn` from the drawn triangles: decals
  lie on the drawn ones, the actors' draw occlusion looks at them with the old see-through rule
  (WorldService.eyeThrough). WorldService.seeThrough (AI sight) passes `sightPass` parts;
  WorldService.shotThrough (the player's shots, `weapons/system.ts solidHit`, `manager.raycast`)
  passes no collision-tree geometry. NPC shot checks (`actor.ts lineOfFire`) still use the sight
  rule.
- Dynamic objects (dynamic.ts) and the cranes' hung objects (skinned-props.ts) build their bodies
  from the same trees. A placed object without a tree, or of a class no list names, has no body;
  skinned props keep their drawn triangles for shots (§14.7).
- 9: the collision world has 157 000 triangles against 249 000 drawn (most of it the Landscape).
- **The clamber room test** (Clamber Point 0x10011b30) [verified]: its sphere is half the
  "width" of the player's EXE mover (Player +0xd0, vt+0x30 = 0x41b270: the largest radius of its
  spheres), swept from top + r + (H - 2r) / 4 by 3 (H - 2r) / 4 with H the top of the movement
  proxy's world box (engine vt+0x18 = 0x459410) above its origin. The proxy is Player p91 =
  Collider 2:44 (model 2:27): four spheres of r 0.6 (at 0, 0.9, 1.306, 1.639), box -0.455..2.245,
  so r = 0.3 and H = 2.245. The query clears the scene's class filter and turns on Static Object
  alone (0x10011cb6..0x10011ccf). The port had swept its own capsule (r 0.35, 1.8 m) against
  everything; 8b's Clamber Point 1802 (top 98.75) was "Blocked" by the ledge's collision box at
  99.05, 2.5 cm into that capsule; the decoded sphere stays 0.11 m above it (`clamber.ts
  clamberRoomShape`, `interact.ts roomShape`; static triangles of `solid` only, no dynamic body).
- **8a's ford** [verified data]: the "water-level rock" at (462, 84.1, 543.8) the old route stood
  on is the creek's water surface: a Static Object placed at the origin (models 7:545..7:555,
  texture 7:396, alpha blend, the same sheet as 9's sea 7:590) whose collision tree is a sphere
  tree without nodes. Movers pass it in the original as well; rays hit it.
- **Floors under node-less room models: the hidden floor layers** [verified unless marked]. 5b's
  lobby, landing, upper floor and attic are drawn by Static Objects whose trees are sphere trees
  without nodes (28:285, 28:278 the glass, 28:160, 28:236, 28:219, 28:298, 28:309) or box trees
  that list only walls and a ceiling (the corridor pieces 28:246: six leaf boxes, no floor). Their
  floors are floor layers (.lvl type 0x01) that are not drawn: 65 of 5b's 90 layers have no
  material, lie at the drawn floor heights (97.66, 103.16, 108.66; one is named "collision") and
  carry 0x30 on every cell. Re-reading the mover path did not change the table above: the narrow
  phase 0x428b30 stands a node-less tree in for one node (the bounding sphere, or for a box tree
  the model box, 0x428d90 / 0x428ed8), and 0x41c340 then releases a node-less sphere tree with no
  contact (0x41c53f); the box fallback 0x41ef2a -> 0x41e090 (the object's box) is only for a model
  not yet loaded. So these objects are drawn only, and the floor-layer cells hold movers up.
  - Cell word (the first u16 of each 22-byte cell record, copied by the loader 0x4a0500):
    bit 0x1 the diagonal (0x49db80: clear, the split runs (1, 0)-(0, 1) and triangle 0 is
    fx + fz <= 1; set, (0, 0)-(1, 1) and triangle 0 is fx <= fz); 0x40 << t triangle t is a hole,
    skipped by the Landscape lookups (the ray 0x4a6c03, the characters' probe Suffering.rfl
    0x100c01cd); 0x10 << t triangle t is not drawn [strong: the loader ORs 0x30 into a cell whose
    texture ref does not resolve, 0x4a05df]. Hidden is not a hole.
  - Port (`level.ts LAYER_CELL`, `hiddenLayerCollision`): every floor-layer triangle that is not
    drawn and not a hole goes into `LevelData.collision` as collision only (`LevelExtras.layerCollision`,
    `solid | landscape` from the loader). Drawn cells collide as drawn, now split along their own
    diagonal (before, always (1, 0)-(0, 1)). The data agree: of the 83 382 retail cells whose
    corners are more than 0.3 m out of plane, the flag's diagonal joins the corner pair with the
    closer heights in 95.5 % (the editor's short diagonal); the old fixed split drew the long one
    on about half of them, up to 5.3 m off at the cell centre (10's cliffs). Before e170605 the drawn room floors collided and hid
    the gap; with the trees the player stood 1 m under 5b's lobby on the basement's ceiling boxes.
  - Census of the 18 levels (node-less trees of colliding classes with at least 1 m2 of drawn
    floor or 2 m2 of wall; scratch census, not in the repo): the floors that matter are 5b's
    room models (the glass 14b0 4 % -> 100 % of its drawn floor held, 288a 24 % -> 100 %, 1b43
    7 % -> 95 %; the others were already over boxes). Every Move Node, Waypoint and spawn of
    every level keeps its ground; 5b's lobby nodes (51) gain ground and its upper-floor nodes
    (25) rise from the boxes 0.9 m under them to the drawn floor; 6a's Waypoints 1c7e / 2344 /
    2345 and 7's Move Nodes 892 / 138e stand on hidden layers with nothing drawn under them; 8b's
    Waypoint 1956 rises to its drawn floor. The rest pass movers in the original too: water and
    light sheets at the origin (blend 1 / 2), 10's dock buildings 34:36 / 34:37 and the Prelude's
    34:51 (off the walkable area), 2's 20:35, 5b's 28:74, the cut-out bushes 23:133 / 29:751 [inferred
    for the last ones: no node stands on them].
  - Open: a hidden cell's footstep surface (the cell record's texture ref, +2) is not read; the
    port's hidden floors have no material.
- **Copied .ldu refs (5b's upper corridor)** [verified loader, inferred rule]. The .ldu record
  loader (SUFFERING.EXE 0x487610, type-9 resource) reads the record's model ref and drops it: only
  the colours are kept, so the record does not choose an instance's model. The port took the
  record's model. In 5b 48 instances (uids 31xx / 32xx, the theatre door 12ac, the Breakables
  31eb..31ee) carry a ref copied from another instance whose model the record names; the
  Breakables 31ed / 31ee (template model 7:251, a plank) were built as the 20 m gallery pieces
  28:373 / 28:387 of fde / 1155, offset 20 m, and their single leaf boxes closed the upper
  corridor west of door 2ad8 at x < 184. Port (`level.ts staleLduRefs`, used by the static
  geometry and dynamic.ts): a record shared by several instances that names one of their template
  models belongs to that one; the others use their template's model without its colours. No other
  level has such shared records. The other instances whose record names another model than their
  template (about 150 in all levels) still take the record's model: which one the engine draws
  was not traced.
- Tests: `tests/object-collision.test.ts`.

## 15. NPCs, creatures and their behaviours (chapter 1)

Code: `src/game/actors/` — `classes.ts` (registry of every class this system handles, by
class name, with its fidelity), `behaviors.ts` (decoding), `actor.ts` (behaviour runner,
combat, doors, save state), `manager.ts` (placement, profiles, Object Cloner copies,
messages, damage events), `director.ts` (level-logic classes that drive actors), `nav.ts`
(Move Node graph, EdgeToggler switches), `fx.ts` (muzzle flashes, tracers, thrown missiles,
electric arcs), `interaction-clips.ts` (player clips of world interactions, §14.5),
`system.ts` (services, subtitles, save providers). Tags: **[verified]** read from the
Suffering.rfl code, **[data]** follows from how every chapter-1 instance is wired,
**[inferred]** / **[guess]** otherwise. Tests: `tests/actors.test.ts`, `tests/world-props.test.ts`.

### 15.1 Character template slots [data]

All Character classes (Unspeakable NPC, CartWheeler, Slayer, Rat, Nooseman, Mainliner,
Fester, Burrower, Horace, Hermes, Killjoy) share one layout:

| Prop | Meaning |
|---|---|
| p3 | 1 = starts invulnerable (every GameObject: init 0x100a3166 passes p3 == 1 to the setter the p13 / p14 messages use) [verified]. 1c's inmate 7569 until Waypoint 756a sends 91; 1b's Slayer 7ff6 until Relay 89e0; locked doors such as 1b 52b6 / 1c 57e9 cannot be broken, 1b 53c2 (p3 0, 30 health) can |
| p11 / p12 / p13 / p14 | inputs BlowUp, Destroy, invulnerability on / off |
| p15 / p28 | outputs Damaged / Died (instances override p28 with e.g. Decrement for a Count Down To Zero that counts a wave) |
| p26 | input Gib; p136 / p137 Enable / Disable on the NPC classes |
| p52 | weapons (Melee Weapon / Ranged Weapon templates) |
| p68 | initial behaviour: DormantBehavior, JumpBehavior, FallBehavior, RatSpawnBehavior |
| p69 | behaviour once active: IdleBehavior (NPCs), HostilityBehavior (creatures), **DeathBehavior = a corpse placed in its death pose** (32 bodies in 1a), DormantBehavior |
| p76 | the character's Hostility template: what a Hostility behaviour started on it runs (behaviour type 9 -> p76 through vt 46, 0x100e17c0; Resurrection also starts it) [verified]. Not an "on damage" switch (§15.12) |
| p82 | KillEnemiesBehavior: p2 enemy teams, p3 explicit targets (uids: characters, the player, or any GameObject that is not destroyed - the candidate test 0x100f9eb0 takes the GameObject part, 0x100a2010, and reads a team only off a character, 0x100e1760 [strong]; 3a's Slayer 296e shoots the fence Breakables 329c..329e of KillEnemies 3ba8, `actors/actor.ts` `prop` targets), p4 allied teams; sight [verified, init 0x100f7d40, search 0x100fbdd0, test 0x100f39a0]: p7 acquire range (m, a +-p7 box on x / z, then the 3D distance), p9 always-see radius, p11 the FULL view angle (cone cos(p11 / 2); CartWheelers 360), p6 != 0 a line-of-sight ray, p10 keep range (the current target stays selected unseen until farther), p12 + U(0, p13) s between re-evaluations. No vertical limit. MoveTo failing drops the target, idles and retries after the interval; the failed target ranks last for 5 intervals (0x100fbbdf) |
| p88 | ProjectileAttackBehavior: p2 Attack templates (p0 firing clip, p4 aim pose, p23 shots), p3 their weights; p19..p20 read only with p18 set (port: seconds between attacks) |
| p104 | OpenDoorBehavior: p2 / p3 push clips (front / back) |
| p130 | Team template: 2:384 player, 10:120 guards, 10:212 prisoners, 10:119 CartWheelers, 10:178 Mainliner / Fester, 10:234 Nooseman / Slayer, 10:624 rats, 10:1133 Horace / Killjoy / Hermes |
| p166 | reputation for killing it (the insanity system's rules) |
| p183 / p185 | Nooseman: reach, Nooseman Drop Position group |

Guards' KillEnemiesBehavior lists the creature teams as enemies and the player as an ally;
creatures list the player, guards and prisoners. So creatures attack guards, guards shoot
creatures, and anyone attacks whoever hurt it (port: a grudge kept until the attacker is lost).

### 15.2 Root behaviours [data unless marked]

A root behaviour object placed in the level links to the behaviour that follows it; Behavior
Changers hand out the first one. When a chain ends the actor goes back to its p69 behaviour.

| Class | Properties used |
|---|---|
| WaypointBehavior | p2 first Waypoint; p8 escorted objects (the player) [verified, update 0x100f13d0 -> 0x100ea110 / 0x100ea2b0 / 0x100f0210]: each is flagged beyond p9 and beyond p10 (3D); a leg to the next waypoint starts only while all are within p9 and is walked to its end; one beyond p10 is looked up every 0.4..0.7 s (a FindPath to it: a search, no walk), and when the search returns the walker stops its leg (MoveTo and KillEnemies) and beckons it (BeckonBehavior: a LookAt on it over an Idle) until all are within p9 again (0x100ea110, FindPath result 0x100f12ee); it never walks back to it (port, before: it walked to the player, so 1c's companion followed the player into his fight; a found path ending off the walker's route clears the flags, 0x100f1378, not modelled); p3 whether the walker fights [verified, §15.12]: 0 runs a KillEnemies while walking, 1 starts one once attacked, 2 never; p7 0 = a hostile creature leaves the path when it spots an enemy [guess]. **Waypoint** p0 arrival message, p1 = 1 run, p2 x 2048 into the move request, p3 a MoveTo search value (not facing), p4 turn, p5 its time, p6 a behaviour run at the waypoint [verified, message handler 0x100f0f70]: on arrival with p4 != 0 a "Slerp" child (0x10104ad0, init 0x100ed3b0, step 0x100e8840 -> 0x100de0d0) blends the walker's transform to the Waypoint's placement over p5 s (rotation slerped, position moved by (waypoint - walker) x t, Idle playing); only then come p0, p6 or the next Waypoint, or the end of the behaviour. Port: `actor.ts waypointTurn / waypointSlerp` (yaw and x / z; the height is left to the mover). A MoveTo that fails (its code 2, the code KillEnemies also treats as failure at 0x100fbbdf) ends the WaypointBehavior the same way (handler 0x100f0f70 -> 0x100973e0 with 1) and the stack runs the next linked behaviour [verified]; when MoveTo fails is not decoded: the port fails a leg the body can neither walk straight nor path on the Move Node graph (`actor.ts waypointLegFails`), and a leg the body stays stuck on for 4.5 s (6a's Slayer 2337: its 3 m mover under a log 1.5 m up on the edge 1c5d -> c2a, §14.9) [inferred], tested once when the leg's MoveTo is issued (a new Waypoint, or an escort walking on after waiting / beckoning) and not again on the way; rising walkable floor (stairs) between the body and its start node does not count as blocking. Re-testing every second from wherever the body was ended 1a's guard 609e (7524 -> Waypoint 8316) on the stairs down to the gate, so gate 7f48 stayed shut. 3a's wall CartWheelers walk a strip behind the west yard's fence whose Move Nodes (3fdd / 3fde) join nothing; their walk ends at the fence (Waypoint 1fcc ...) and their JumpBehavior (3fd7 ...) leaps it into the yard, where Count Down 4367 waits for their deaths. Before, p5 was read as an arrival radius and nothing turned: 1c's CartWheelers 7e20 / 7e21 leapt (JumpBehavior launch clip 10:1310, 4.9 m forward) along their walking direction and stayed behind the fence |
| Waypoint | p0 message sent to the waypoint's other links on arrival (12 = Destroy makes NPCs walk off and vanish); **p1 the gait** [verified: the go-to-waypoint code 0x100e9f90 turns p1 = 1 into movement mode 3, anything else into mode 1; the rig's locomotion table 0x100940d0 plays mode 1 = MovementAnimBehavior p3 (walk), 2 = p4, 3 = p5 (run)]: 1 runs (485 of the retail waypoints, among them every vision-creature waypoint 10:601), 0 walks; p2 x 2048 goes into the move request as a distance (+0x1c, default 2 m; read as the arrival distance [inferred]), p3 into +0x48; p5 the port's arrival radius [guess]; links: next waypoint. The port used to read p2 as a speed factor: the 1a / 1b vision creatures (p2 = 0.7) crept along at 70 % of the walk instead of sprinting past on the run clip 2:137 (9.3 m/s). A Waypoint run moves at the run clip's own root speed (actor.ts `WAYPOINT_RUN`); chases keep the capped run speed |
| SimpleConversationBehavior | p0 talk to the player, else to the uid in p1 [verified]; p14 Line of Dialog templates said once in order; p16 lines repeated every p19..p20 s afterwards (the chain never completes then); [verified, start 0x10100600, ranges 0x100ff570] the talk starts when the listener is within p11 m (horizontal) and p12 m in height; with p5 the speaker first walks up to the listener however far it is (MoveTo stopping at p11); p9 / p10 range and height of the p8 wait mode; p21 message the NPC sends to **its own links** when done (NPC links are Relays listening for exactly that message); **no listener** (p0 = 0 and nothing at p1) is a monologue: the start finds the listener handle empty and talks at once (state 2, 0x10100a19), and so does the wait state (0x100023d0 → 0x10100c2d) [verified] |
| Line of Dialog | p0 talk clips, p1 pause after the line, p2 sounds (dialog category, subtitle in the sound header), p3 message [guess] |
| RootPlayAnimBehavior | p2 clips, p3 repeats, p5 hold time (s; 0 = clip length), p4 unknown (not "at the behaviour's placement": behaviour objects are parked near their Behavior Changer); root motion of the clip moves the actor |
| IdleBehavior | p2 idle clip, p5 fidget clips |
| DormantBehavior | [verified, §15.8] p2 mode: 0 ends at once, 1 shown playing p5, 2 hidden and inert; p12 the waking message (1 = On everywhere); p6 ≠ 0 also wakes on the attack stimulus (being hit); p7 a clip played on waking. Nothing wakes it by sight |
| FollowBehavior | [verified start / update, §15.10] p2 the leader (1 = the player on every placed instance), keeps within 2 m, p5 / p6 catch-up distances, p7 give-up distance (≤ 0 never) |
| JumpBehavior | [verified, start 0x100edf30, launch 0x100ec710, airborne 0x100f0cd0, finish 0x100efe70] p2 timer (s), p3 object to face and jump towards (0: own facing), p4 launch clip played with its root translation moving the body (10:30: 3.26 m down a wall), then velocity = facing x p7 + up x p8 (m/s) under gravity x p9 with p5 until ground, p6 on landing; an attack stimulus with no attacker (alert) at the earlier of p2 and the end of p6, done at the later; hits do not interrupt it. Object Cloner copies in wall holes (1b 10:175 / 10:640: climb down, drop) and 1c's wall CartWheelers (10:129: 8 m/s out, 3 up, half gravity) |
| KillEnemiesBehavior, HostilityBehavior | fight (see 15.1) |
| JumpAttackBehavior | [verified, §15.7.5] the Slayer's leap (CartWheeler p181); other users: plain hostile combat |
| FleeBehavior | [verified, §15.14] run to the best Flee Position of its group (away from the p42 threat teams, near the p44 ally teams), stand there and choose again every p16..p17 s; leave a spot after hits |
| DeathBehavior | p2 death clips (a random one); p4 the death picker's angle bound: the first p72 entry whose p4 is above the blow's angle [verified, §11.5 item 3]; via a Behavior Changer the NPC dies (1c victim) |
| RatSpawnBehavior | initial behaviour of 1a's cloned rats: p2 emerge clip (10:419) played once, then the active behaviour; p3 (8) unknown [inferred] |
| HoraceKillPlayerBehavior | [verified, §15.7.7] p2 / p3 are message ids (6 Triggered sent to Horace's links, 350 QuestStart received = attack now), p4..p5 / p6..p7 the two cycle delays; no reach or damage |
| MainlinerJumpAttackBehavior, CeilingFloorTransitionBehavior, KilljoyRootBehavior | [verified] §15.7.4 / §15.7.5 / §15.7.8 |

### 15.3 Level-logic classes driving actors

**Behavior Changer** [verified map: p11 change (default On), p12 Disable, p13 Enable, p14
Destroy, p15 Prefetch; verified: p2 uses, decremented per change and disabling at 0; p3 drops
links to dead NPCs ("Removing link to NPC")]. p6 placed root behaviour, else p5 template; p7 /
p8 sub-behaviour templates (OpenDoorBehavior, MovementAnimBehavior, IdleBehavior,
KillProjectileBehavior) replacing the NPC's own [data]. p17 goes to the non-character links
**when the handed-out chain completes** [data: in 1a BC#7521's p17 starts the guard's
voice-line scene, which only makes sense after his walk; in 1c BC#809d → BC#80a8 →
BC#809e form a scripted sequence].

**Object Cloner** — chapter 1's creature spawner. No chapter-1 Object Generator spawns a
creature: walking every template the 123 generators reference (recursively) finds only Special
Effect, Projectile (BouncingObject), System and one MoveToBehavior classes — they are effects
(world system, §14). [verified from the class code] p0 start active, p1 total
copies (0 = endless), p2 most alive at once, p3..p4 seconds between copies, p5 template
characters (flagged inert by the cloner), p6 pick order, p7..p8 player distance band, p9 spawn
point must be off screen, p10 no other creature within this radius; inputs p11 On, p12 Off,
p13 spawn now, p14 Destroy; outputs p15 per copy, p16 last copy made, p17 all copies dead
(without p17 the cloner goes away after its last copy); p18 message for the copy. A dead copy
holds its slot for p4 s. The copy keeps the template's links and objects linking to the
template also reach the copy (1b: CartWheelers jump out of wall holes into the arena and a
Count Down To Zero counts them in with p15 and out with their p28; rats drop from a ceiling
hatch; Mainliners are woken by the cloner's own On).

**Speech Player** [verified, Suffering.rfl: On 0x1008e510, start 0x1012d970, update 0x1012db10,
line 0x1012da40, end 0x1012d820] p0 who speaks: 0 the sender, 1 the player, 2 every linked object
in turn (retail: always 2); only a character (object category 7) or the player is taken, the
last one wins; with none nothing starts. p5 the lines; p4 their order: 0 in order, all of them on
one On, 1 one at random, 2 one at random not yet played this round; p8 goes to the links after
every line, p9 after the round's last; p6 = 1 destroys it after the round's last line, 2 after
any line; p3 what to do when the speaker is busy talking (0 skip, 1 wait, 2 an extra step: port,
the speaker turns to the player [guess]); p1 play (On), p2 Destroy, p7 Prefetch. **A dead
speaker says nothing** (the character's speak 0x100e1b40 returns at once when 0x100a1ad0 "is
dead" holds), but the line counts as played: it ends at once and p8 / p9 / p6 follow on the
next update. A speaker removed from the world stops it without output. Port: `director.ts`
(`speechPick`); 2 Cellblocks' 310f no longer says the dead inmate's 20:202.

**Action Dialog** [verified map] p24 attach to the linked NPC, p25 detach, p26 / p27 mute on /
off, p28 the NPC died (detach, remove), p0 = 1 attaches at start. The lists are situational
barks [guess: p6 on spotting an enemy at p5 % chance, p8 when hurt at p7 %, p9 s apart].

**Damage Action Object** [verified] p4 damage, p3 = 1 per second, p5..p7 damage parameters,
p8 an effect spawned on the target (an Electric Arc Effect crackling over its body); inputs p1
apply, p2 Destroy. p0 picks the targets [data]: 0 the message's sender (Detector → the player:
1a's 200-damage death traps), 2 the links (arcs on Horace, a prisoner, props), 1 both.

**Nooseman Drop Position**: the positions linked to each other form a group (links are made
two-way; Nooseman p185 names one of the group). The Nooseman stays hidden and teleports to a
free position of its group above the player for each drop [verified, §15.7.1]; the earlier
"pull up, move, drop down" guess was wrong.

**Ambient Creature** (rats, crows; 74 placed in 0, 1b, 3a, 4a, 6a, 6b, 8a, 8b) [verified unless
marked: class 0x36e88832, ctor 0x10091420, vtable 0x101544b0, init 0x10091930, update
0x10091c90, map 0x10177be0, death 0x100916f0]. A PhysicalObject, not a Character:
- **Properties.** GameObject p0 health (1 on every placed one), p3 invulnerable (8b's five rats).
  p22: 0 leaves it still and inactive at start (engine state 0; 66 of 74), else it plays p24 and
  runs at once. **p24 is its one animation** (rat 10:789, crow 10:706: the run / flight loop),
  **p25 its speed** (m/s, × 2048 into its mover: rats 3..4, crows 6), **p28 are sounds**, played
  at the creature every p29 + U(0, 1) × (p30 − p29) s while at most p31 ambient sounds of any
  creature still play (0x100910f0, a shared list). The port had read p28 as clips and p29..p30 as
  the speed.
- **Inputs.** p32 On plays p24, makes it active and clears its stop flag; p33 Off sets the stop
  flag; p12 Destroy. Init without a waypoint link: "Not enough waypoints", destroyed. Links →
  Ambient Creature Waypoint network (random onward link); waypoint p1 + p0 clip = stop and play
  it [data / guess]; out of waypoints it disappears [guess].
- **No flee rule.** It runs only when told (On from the level's Detectors near the player); its
  vtable has no attack-stimulus or noise handler.
- **Damage and death.** Damage is the PhysicalObject's (vt +0x58 0x1009b490: nothing once health
  is 0; p15 on a positive blow). Death (vt +0x90 0x100916f0): reputation += p26 (−2 on all 74)
  when the killer is the Player, then the PhysicalObject death 0x1009ba20: the Breakable break
  (0x1009b6d0: the p18 generator at its placement, turned away from the attacker with p19; rats
  3:3731 = gibs 3:2007 / 3:2651 + squeal sounds, crows 3:3494 = feathers), p21 and Destroy. No
  insanity meter (0x10033890 is the Characters'). Port: `system.ts ambientHit`, shots find them
  while shown (`manager.ts raycast`); a killed one is removed and saved removed. Browser (1b,
  the rat pack round the corpse at (404, 84, 406)): a revolver shot at 8a05 kills it, blood, it
  goes, reputation 0 → −2; On to 8a09 / 8a07 / 8a06: they run off at 3 m/s with their run loop.

**EdgeToggler** [verified: ctor 0x100a9b10, init 0x100a9ac0, handlers 0x100a9a30 / 0x100a9a50]:
its two links are the Move Nodes of one nav edge (init fails with fewer); p0 = 1 leaves the
edge usable at start, 0 disables it; input p1 enables, p2 disables, both directions at once.
"Usable" is edge flag 0x80, which every edge is constructed with (0x100d8490). 1a #8498 starts
disabled and a Breakable's BlowUp (p1 = 11) opens it — the crate's debris no longer blocks the
way; others follow Switches / Relays. Port: `NavGraph.setEdge`, A* skips disabled edges.

**Companion Spawn Point** (1c, one property) [verified: no message map, one output slot p4]:
arrival point for followers carried through a Level Transition (§15.10).
**Reputation Points Sender** belongs to the insanity system (§13).

**Aim Controller** (System, 6 in chapter 1, all in 1a, template 10:686) [data; class layout from
the RFL class table: groups `7.2×8 | 13.8.8.8 | 7.1013.7.2×4 | 7.1013.7.2×4 | 11.11.11 | 11.11`,
inputs p27 / p28 / p29]. Not a weapon / aim-assist object: each one turns an **Animating
Static** toward its targets. `p9` = the controlled object's uid (all six are CartWheeler-model
statics 10:635 / model 10:2 in the cells next to Torque's: 7f04, 7adf, 7ae1, 7f03, 7ade, 7add),
`p10..p12` = -1 (pitch / yaw bones and aim origin; -1 = turn the whole object), `p14` = default
target uids (the player 5818), `p1..p4` = 0 (pitch limit, speed, acceleration, deceleration: no
pitch), `p5..p8` = 90 (yaw limit in degrees, yaw speed in deg/s, yaw acceleration and
deceleration in deg/s²), `p18` / `p19` = 30 (acquire / lose cones, degrees; **not** turn rates),
`p20` = 1 and `p25` / `p26` = 30 (spot players within a 30° cone), inputs p27 On (1), p28 Off
(2), p29 Destroy (12); outputs p30 / p31 = 1 / 2 (target acquired / lost). [verified: update
0x10090850, slew 0x1008eb60; docs/re/animation.md §9] Both Message Relays 7f08 / 7f09 switch all
six together. So: caged CartWheelers whose bodies follow the player while enabled - an NPC
presentation behaviour for the actors system, not part of the weapons.
Port (`actors/director.ts`): off until On (p0 = 0 [guess]); while on, the controlled static
turns about its vertical axis toward the nearest p14 target through the original's
second-order slew (`aimSlew`: accelerates at p7, brakes at p8 to stop on the target, top speed
p6 = 90°/s), clamped to ±p5 of its placement; Off stops it where it is, Destroy removes the
controller; on/off is saved ('actors.logic'). The cones, the spotting, the p30 / p31 outputs
and pitch are not applied (pitch is 0 on every instance).

### 15.4 Messages to characters [data]

Besides the slots of 15.1, chapter-1 logic sends **On** to sleeping characters (Detectors,
STOMP Players, Object Cloner p15): the port wakes them. A woken character takes its p69
behaviour unless a Behavior Changer gave it one.

### 15.5 Movement, doors, attacks (port)

- Gameplay clips carry the clip's hips offset like scripted ones (§7; seated / crouched /
  hanging poses).
- **Where a point lies on the graph** [verified, Suffering.rfl; `nav.ts locatesOn`]. The nav code
  keeps edges, not nodes: each edge's area is its two nodes' squares (half the node's size less
  the walker's radius, turned by the node's yaw, 0x100d3da0) and the strip between them
  (0x100d5400 / 0x100d6040) [sizes inferred]. The global search (0x100d87e0) walks the grid cells
  around the point and returns the first edge that passes the walker's filter (0x100d8780 ->
  0x100d5c30: usable, the walker's surface, wide enough, its passage kind and its NPC Exclusion
  Types, 0x100dbf30) and holds the point; the incremental search (0x100d8bd0) and the A*'s goal
  lookup (0x1011e436, with no walker: type 31, so an edge kept to listed types fails there too)
  filter the same way. An edge's types come from its nodes at load (0x100dac90..0x100dadbd): both
  "only" -> the types both list, "only"; one "only" -> its types less the other's excluded ones,
  "only"; neither -> excluded when either node excludes. So a goal beside a room kept to another
  type lands on the walker's own edge: 8b's Waypoint 1ea5 (Jimmy's last walk, WaypointBehavior
  189f) lies 0.4 m from the walkway's node 207f and 1.5 m from 254a of Hermes' room (10:682 only,
  type 0). Port: `NavGraph.nearest` with the walker's type skips the nodes barred to it, and a
  path's goal takes the node whose area holds it (its radius across, 1.5 m up or down [inferred])
  before any sight line is asked (207f / 1e7f lie 1 m under the doorway's floor, where no sight
  line reached them). Before, the goal went to 254a, no path led there, the walk ended at the
  ladder and the room's scene for a missing Jimmy ("Camera" 1ed5) played; now Detector 26b5 sees
  him on the walkway and his "Camera" 1eb1 plays (session, 2026-10-23).
- **Straight walks keep to the ground** [port; `nav.ts groundAlong`]. The original walks a MoveTo
  along the graph's edge areas; the port's shortcuts off it (a straight walk on a clear line, a
  skip to a later path node, the walk to the start node) also need ground under the body's
  width every 0.6 m: no more than 1.5 m under the line and no steeper than 60 degrees. 9's guard
  bc9 walked from the north rim of the inlet south of the lighthouse towards the gate (Waypoint
  c63) along a line that skimmed the rim, slid down it and lay on the shore 28 m down, where no
  Move Node is (runs t9b / d9; in a session from (324, 196): fell before, five walks stayed up
  after).
- Paths: straight line when clear, else A* over Move Nodes. An Edge Passage door on the next
  edge that is closed: an actor with an OpenDoorBehavior walks up, plays the push clip and
  sends the Switch its p61 activate message; locked doors (unless Switch p63) cut the edge.
  A passive walk stuck against a closed door on the edge its goal lies on (within 1 m of it, from
  a quarter of the way to the far node) opens it the same way [port: a goal placed in the doorway
  has its nearest node on the walker's side, so its path crosses no door edge; how the original's
  MoveTo ends there is not decoded]. 1a's second ambush CartWheeler 64f1 (Behavior Changer 8026 ->
  WaypointBehavior 8027 -> Waypoint 8025 inside door 4e48) stood 0.51 m short of the shut leaf
  (Collider radius 0.4), its leg failed, Count Down 73a5 never reached zero and the guard 609e
  never went on to the door controls (`actor.ts doorInTheWay`).
- Ladders on the graph: an Edge Passage may name a Ladder instead of a door (1c 7e4f: Ladder
  7c2f between Move Nodes 7b8a and 7c7f, 6.2 m apart in height). The character's
  LadderClimbBehavior (Character p102; 10:811: p2 / p3 rung up 2:234 / 2:243, p4 / p5 down,
  p6 / p7 holds, p8 / p9 off at the top / bottom, p10 / p11 its NPC Interaction Properties
  mounts) climbs it [data; the RFL has the behaviour, "ladder climb behavior"; its code was not
  read]. Port (`actor.ts tryLadder / updateClimb`): at the foot (or top) of such an edge the
  character takes the rungs, 0.5 m per rung clip (the player's ladder geometry: 0.45 m off the
  ladder's face), then steps onto the far node with p8 / p9 [inferred]. Before, nothing climbed:
  1c's companion stood at the foot of 7c2f for good, so his last Waypoint 7b8c (Relay 808c ->
  Level Transition 7813) was never reached.
- **Who may use a passage edge** [verified, Suffering.rfl]. Edge Passage p0 is the passage type:
  0 a Ladder (p1 cast to class "Ladder"), 1 a door (a Switch) (0x100a9670 / 0x100a96f0 /
  0x100a93a0). The setup (0x100d9520, "Edge passage setup wrong!") finds the edge nodeA -> nodeB
  and its reverse and gives each direction an enable bit and a passage kind (bits 3..6 of the
  edge flags), asked of the object (vt +0xf8): a Ladder answers kind 1 both ways (0x100bee30); a
  Switch 2..8 from its state (0x10130e50); anything else 0. A locked Ladder closes both
  directions; Ladder p34 = 1 closes nodeA -> nodeB, 2 closes nodeB -> nodeA (0x100bf1a0). The
  A* neighbour filter (0x1011e765 -> 0x100d5c30 -> 0x100dbf30) drops an edge whose kind bit is
  missing from the character's passage mask, built by 0x100dc070: bits 0 and 7 always, bit 1 when
  the character has a LadderClimbBehavior (behaviour id 0x59 -> Character p102), bits 2..6 from
  its OpenDoorBehavior (id 0x76 -> p104: p2 -> 4 / 5, p4 -> 2 / 3, p6 = 1 -> 3 / 5 / 6). So a
  ladder edge exists only for characters with a LadderClimbBehavior: CartWheelers (p102 null)
  never path over Ladder 7c2f; the path does not lead them to its foot either. Path following
  (0x1010ee84 -> 0x1010b200) pushes LadderClimb on a kind-1 edge and OpenDoor on kinds 2..6.
  There is no jump edge; a CartWheeler's other way up is a chain of wall / ceiling nodes.
  Port: `nav.ts ladderEdgeOpen`, applied in `system.ts navBlocked` (before, any character took
  the rungs: 1c's walkway CartWheeler climbed 7c2f and hit the player on top).
- **A Switch's passage kind** [verified, 0x10130e50, per direction]: broken (+0xca) or open and
  still: 7 (always passable, mask bit 7); locked: 8 when invulnerable (nobody), 6 when it can be
  damaged (only OpenDoorBehavior p6 = 1, which breaks it); unlocked: 4 / 2 by the side (OpenDoor
  p2 / p4), 5 / 3 when it can be damaged. **A locked door whose Edge Passage has p4 = 1 answers
  the unlocked kinds** (0x100a8d50): characters with an OpenDoorBehavior go through it, whichever
  side they are on. Retail p4 = 1: 1a 4d99 / 8302 / 4e47, 1c 5262 (the companion's way to his
  last waypoint), 2 be4 (the south-yard gunner leaves his nest) / 24b8, 3a 4122. Port:
  `nav.ts lockPassDoors` in `system.ts navBlocked / openDoor` (it replaces the inferred "people
  not against the player open locked doors"); kind 6 (breaking a locked door) is not modelled,
  and a scripted door (Switch p63) still lets characters through [port].
- Melee: Attack clips with hit markers (clip events). Started per Attack template when Attack
  p15 <= horizontal distance - target radius <= p16 (x the size scale when p14) and |dy| <=
  p17 when p17 > 0 (CartWheelers -1: none) [verified, 0x10080180 / 0x10080010]; there is no
  line-of-fire or facing test for melee (KillMelee 0x1007c910). Attack p6 is the damage
  multiplier, not a reach.
- **Melee hit resolution** [verified unless marked; `actors/npc-melee.ts`, `actor.ts sweepMelee`,
  tests `tests/targeting.test.ts`]. NPCs and creatures land blows the way the player's creature
  form does (§13.9): the same Melee Weapon code. Character p52 lists the weapons and p51 the bone
  each rides (bone indices; the weapon model's space is the bone's frame). A Melee Weapon's hit
  shape is its model's type-7 node list (`formats/model-spheres.ts`: node 0 names the first point,
  that node's `next` the second): two points are a blade whose segment sweeps a quad from frame to
  frame, one point a sphere of its radius swept along its path. An attack clip's Arm event (100)
  arms the weapon held on the event's bone (attachment set 0x10095750 -> arm 0x100ca210, which
  clears the victim list) and the next Disarm (101) disarms it; the arming frame only records the
  weapon's place, and the Disarm waits for one sweep (0x100cb6c0). Each frame the swept shape is
  tested against what the collision query returns, characters and the player by the leaf spheres
  of their skeleton sphere tree (0x100caff0 / 0x100c9de0); the wielder and what rides on it are
  left out (0x100c9ca0) and there is no team test, so a blade hurts any character it passes
  through, each once per Arm. The struck leaf (the damage record's +0x20, which the Part Cap test
  reads) is the first leaf in node index order whose posed sphere meets either of the swept quad's
  two triangles (0x100c9de0 -> 0x100c9680; node i at tree +0xbc + 24 i, leaves only) [verified];
  the port had taken the deepest overlap and then the leaf nearest the blade's point. A blocked ray from the wielder (its x / z at the contact's height) to
  the contact cancels the blow (0x100c9490). Damage (0x100ca920): Melee Weapon p68, x the Attack's
  p6 when the victim is the weapon's target handle (+0x100; the attack's target [inferred]) or the
  handle is empty, type p70. The character damage code
  (0x100e7390) ignores a blow only between two members of the player's team (its same-team rule
  for type-2 blows needs vt 0x98, which returns 0 on every character class). Retail [data]:
  CartWheeler 10:24 blades 10:1771 / 10:1776 / 10:1769 / 10:1772 on bones 10 / 15 / 23 / 27 (p68
  7, type 2; 10:1321 / 10:627: 11), its swings arm bones 10 and 15 (10:866 0.46..0.54 s and
  0.51..0.59 s; 10:3 twice per arm) or 23 / 27 (10:23); Attack p6 1.17..2.5. Fester spheres r 0.6
  on bones 23 / 14 (p68 20), Burrower 3.1 m blades on bones 15 / 26 / 37 (p68 3), the 1a creature
  self 4:155 / 4:832 (p68 35). Nooseman and Mainliner attack clips carry no Arm events: their
  grabs and needles are their specials' (§15.7). So the start test is horizontal but the blow is
  not: a creature under a walkway swings at a player standing on it and misses, as in the
  original. Port: the sweep samples the swept quad in 6 slices; a body without a sphere tree is a
  stack of spheres up its capsule [port]; a swing is animated every frame even off screen (the
  AI LOD would skip the 0.08 s windows). Before, the blow landed at the clip's first Arm time on the
  target alone when the bodies overlapped in height within 1.4 m [guess, removed], for p18 / 4
  damage [guess, removed]. Attacks the port takes from a class's own attack behaviours' clips
  (no MeleeAttackBehavior: Mainliner, Nooseman, Horace, Hermes, people templates without p87) also
  hurt only through an armed Melee Weapon now (`clipmap.ts`); before, each landed a guessed 10 at
  45 % of its clip with no damage type, which the Part Caps' type rule (§15.16) could not refuse:
  in run d2a 2's Dallas bled out from a chest cut (Part Cap 10:863, p13 1 with bullets, blades,
  fire and shivs listed, so none of them cuts it) after such a "blow" of Mainliner a60. Test
  `tests/creature-attacks.test.ts`. The CartWheeler's ceiling slash
  (specials/cartwheeler.ts) still uses its reach test. Ranged [data]: a ProjectileAttackBehavior
  (p88; Attack p0 firing / throwing clip, p4 aim pose, p23 shots with p21..p22 s between them,
  §15.11; port: p19..p20 s between attacks) plus something to fire in
  p52 or p55 — a Ranged Weapon (guards 10:1801 / 10:1802, Slayers 10:1746 / 10:1747; Horace
  lists 10:1795 in p55) whose projectile generator (p81 → Object Generator p0) names the
  Missile, or a Missile thrown directly (Mainliner 10:1814 in p55). Damage per shot = Missile
  p28 (flat: p30 = p31) x generator count p2: guard / Slayer bullets 6, Mainliner needle 3,
  Horace 30; speed = Missile p1 / 2048 m/s (bullets 98 m/s hitscan; needles 22 m/s fly visibly
  and hit what is still within 0.9 m of the aim point on arrival). Bullet spread [verified:
  ProjectileAttack fire 0x100fcec0 passes the Attack's p19 to the character's fire 0x100958e0 ->
  Ranged Weapon 0x10128310 (+0xc8), and the weapon's fire 0x10127b30 deflects the shot by
  U(0, p75 x p19) degrees at a random roll]: prisoners' attacks (10:314 / 10:1438 / 10:1439, the
  companion's) have p19 = 0 and do not miss, guards' p19 = 1 (3 degrees with 10:1802), Slayers'
  0 / 0.3. Port: `actor.ts spreadShotHits` (the deflected point inside the body's radius / half
  height); before, a guess (0.9 - 0.02 x d, at least 0.25) let the companion miss half his shots
  at 15 m. Thrown missiles keep that guess. Firing at the clip's marker (else 40 %), muzzle flash + tracer;
  shooters keep their distance.
  **One shot per Fire marker** [verified: Character clip-message handler 0x100e3ab0, message 102
  -> 0x100e3c0a -> the weapon set 0x100958e0 with the marker's bone]: every Fire (102) event of
  the firing clip fires the weapon held on that event's bone once. The Slayer 10:527 holds five
  Ranged Weapons on bones 33 / 36 / 39 / 42 / 45, and both its firing clips carry five Fire
  markers (10:1359 for Attack 10:1506, weight 0.8, 2 clips; 10:1370 for 10:1505, 0.2, 6 clips):
  5 bullets of 3 (Missile 10:1741 p26 x Object Generator 10:1739 / 10:1740 p2 1) a clip, at most
  30 an Attack 10:1506. The port fired once a clip. Damage to the player is not scaled by the
  difficulty (Player damage 0x1002de20 subtracts the amount after resistances; the Player has no
  Damage Resistance attachments); only his health is (p2 2:642: x1 on Medium).
  **The Slayer's kick deals no damage** [verified]: its MeleeAttack 10:1566 -> Attack 10:1568
  plays 10:1554, whose markers are sounds, 201 (vt +0x11c: Character p49[1], the footstep
  material effects 10:809) and 151; there is no Arm (100) and the Slayer holds no Melee Weapon,
  and NPC melee damage comes only from an armed Melee Weapon (npc-melee.ts). The port dealt a
  guessed Attack p18 / 4 (360 / 4, capped at 30) a blow: the "30 a hit" of 3a's fenced-yard
  fight (Slayer 3c0c with CartWheeler 701). Port: `KindAttack.weaponOnly` (every
  MeleeAttackBehavior Attack), `ClipEvents.fireTimes`.
- Damage sources: `services.actors.damage(actor, amount, from?, by?)` — `by` the attacking
  actor, 'player' (default) or a hazard's uid (Damage Action Object). The 'damage' / 'death'
  events carry `source: 'player' | uid` (manager.ts `ActorDamageInfo` / `ActorDeathInfo`);
  `services.damage.apply({ source })` forwards an actor uid / hazard uid / 'player'. Kill
  reputation: when the player kills a character the actors system calls
  `services.insanity.addReputation(victim p166, victimUid)` (Reputation Points Senders are
  handled by the insanity system only).
- Dialog lines play positionally on the voice bus with lip-sync (§12) and subtitles in the
  interface font.
- **Actor draw culling (port).** The engine's own rule for characters is not decoded; the port
  culls them in `manager.ts` (`cull`), separately from the zone culling of everything else
  (§18.4, which leaves skinned meshes alone). The test is centred on the hips bone, not the
  actor's origin: a clip can carry the body metres away (a scripted STOMP body offset, 7 m in
  1a "Gaurd" #280; 1a's ceiling-hung Unspeakables hang 4.5 m above their origin). The bound is
  the larger of 0.8 × the height and 1.3 × the model's bind-pose reach from the hips plus
  0.25 m (the Unspeakables reach 6 m, 1a's Animating Statics 6.4 m), and a body counts as in
  view when that sphere around the hips or around the origin meets the frustum (an animation
  key can move the body between frames).
  - *Cinematic camera* (any frame the sequence system has posed the camera:
    `services.actors.refreshVisibility`): frustum only, with 0.5 m more on the bound. No
    occlusion test and no distance limit. A shot is framed on its characters, and a sight-line
    test cannot be trusted there: lines from the lens to a body converge, so bars or a door post
    close to the lens cover all of them while most of the body shows between the bars. In 1a
    "Goose" (.qdu 12:284, 216.5 s) that hid Muhammad (track 3, uid 0x75a5, the inmate who stands
    up for Torque) in 10 stretches (345 frames: 94.0-94.8 s, 151.9-155.0 s, 207.6 s, ...),
    Floyd (0x76eb) for 2.6 s (123.4-126.0 s, the long-lens shot over Muhammad's shoulder),
    Goose (0x75a7) for 1.7 s, Slick (0x75a6), Ernesto (0x7b19), the CartWheeler (0x8916) and
    background inmates, all while visible. Drawing the in-frustum characters behind walls for
    the length of a cinematic costs about 10 drawn characters instead of 2 in a typical Goose
    shot (their skeletons are animated and their matrices updated: ~0.3 ms more actor CPU per
    frame in headless Brave).
  - *Gameplay*: in view and nearer than where the fog hides everything (`ZoneCuller.fogDistance`,
    62.5 m in 1a; no limit without fog culling: a fixed 55 m popped characters that were still a
    third visible through the fog, seen in the death row sweep at 54 m), then occlusion. A body whose sphere touches no zone the
    zone / portal walk reached (§18.4, `ZoneCuller.objectVisible` for the frame just drawn) is
    hidden at once; otherwise sight lines from the camera through the
    collision world (`src/game/actors/sight.ts`) go to head / chest / knee height on the body's
    axis and on its left and right side as seen from the camera, then to six bones of the pose
    (`spreadPoints` over the skinned bones of the bind pose from the hips: head, hands, feet),
    whose world matrices are brought up to date for the test (a hidden mesh's are skipped by
    the frame pass). Surfaces drawn see-through (blended or cut-out base layer, or a
    material-less texture with alpha; `WorldService.seeThrough`) are looked past. Sampling only
    the axis was the first bug (one cell bar in front of it hid the whole inmate); the pose
    points add arms and legs that reach past the capsule. The test is redone at once after a
    camera cut (>1 m or >30 degrees between passes) and when the body comes into view (a verdict
    from an earlier view is stale), else every 0.2-0.3 s, staggered over the actors. A full
    re-test of 1a's 130 actors from the death row casts 1.6× the rays of the capsule-only test
    (113-375 instead of 78-216, 1.6-5.5 ms instead of 1.0-3.2 ms, spread over 12-18 frames).
  - *When*: in the actors update (it drives the animation LOD), and again right before each
    frame is drawn (`LevelRenderer.onBeforeDraw` → `manager.visibilityPass`): the player moves
    the camera after the game systems ran, so the update's verdict is a frame behind the drawn
    view, and a teleport, a respawn or the hand-back after a cinematic drew one frame with the
    old view's culling. A turn of 2 degrees per frame also outran the bound of a body 54 m away
    (a one-frame pop at the edge of the picture). The pass re-runs the frustum and distance
    tests every frame (about 0.08 ms for 1a's 130 actors) and the sight lines only after a cut
    or for a body coming into view. A sequence camera is likewise re-culled every frame it is
    posed: a cut between two shots can be smaller than a cut by the >1 m / >30 degree measure
    (skipping those left whole rooms of characters a frame late at four of Goose's cuts).
  - *Checks*: `npm run smoke` logs every frame of "Goose" at 3x speed (every character with a
    skinned bone of its true pose in the picture and not hidden by level logic must be rendered
    that frame), then turns the player round at six points of the death row (a character with
    clear sight lines to at least 3 of its on-screen bones, and a quarter of them, must be
    drawn). Characters hidden by level logic (root hidden by a Visibility Toggler or the
    present-at-start flag, dormant creatures) are not dropouts.

### 15.6 Chapter 1 coverage (instances 1a / 1b / 1c)

| Class | Count | Port |
|---|---|---|
| Unspeakable NPC, CartWheeler, Rat, Nooseman, Slayer, Mainliner, Fester, Burrower, Hermes, Horace, Killjoy | 69,24,3,2,0,1,1,0,1,2,0 / 20,30,25,1,3,8,5,1,1,4,1 / 18,10,0,0,3,0,0,0,0,0,1 | placed, corpses, dormancy, behaviours, combat; ranged Slayers / guards / Mainliner needles; registry `classes.ts` |
| Behavior Changer | 83 / 48 / 20 | done |
| Waypoint, WaypointBehavior | 78, 35 / 39, 20 / 34, 13 | done |
| SimpleConversationBehavior, Speech Player, Action Dialog | 27, 17, 1 / 19, 1, 0 / 8, 2, 1 | done (Action Dialog barks guessed) |
| RootPlayAnim, KillEnemies, Hostility, Idle, Jump, JumpAttack, Death, Flee, Dormant behaviours | all placed instances | done |
| Object Cloner | 3 / 10 / 0 | done (save: 'spawners' provider) |
| EdgeToggler | 6 / 1 / 1 | done [verified] |
| Damage Action Object | 31 / 46 / 0 | done |
| Nooseman Drop Position | 7 / 3 / 0 | done |
| Ambient Creature (+ Waypoint) | 0 / 17 (49) / 0 | done |
| Flee Position, Ranged Targeting Position | 45, 29 / 52, 87 / 10, 20 | Flee Positions as §15.14 (groups, p0 height limit); targeting positions not used |
| Companion Spawn Point | 0 / 0 / 1 | arrival of carried companions (§15.10) |
| Object Generator | 98 / 17 / 8 | effects: world system (§14) |
| Reputation Points Sender | 3 / 1 / 1 | insanity system (§13) |
| Clamber Point, Mountable | 0 / 5, 1 / 0 | player interactions: world system (§14) |

Not done: hardpoint-attached NPC weapons (guards hold nothing), the remaining
KillEnemiesBehavior numbers (p5..p40 besides sight / view), RatSpawnBehavior p3. The special
moves (Nooseman grab, Burrower, Fester, Mainliner, Inferna), the bosses (Horace, Killjoy, Black
One), Slayer heads and Ranged Targeting Positions are in §15.7.

### 15.7 Special moves and bosses (src/game/actors/specials)

Code: `src/game/actors/specials/` — `index.ts` (registry by class name, install hook),
`runtime.ts` (shared services: player, damage, effects, sounds, messages, difficulty),
`params.ts` (template decoders, tested in `tests/specials.test.ts`), one file per creature,
`hold.ts` (holding the player), `clip-events.ts` (clip markers), `screen.ts` (grapple tint).
Harness: `node tools/specials-qa.mjs --scenario <name> --out <dir>` (scenarios in
`tools/specials-scenarios.mjs`: state log + screenshot strip per move).

**Hooks into the actors core** (all documented where they sit):
- `Actor.special(dt, env)` runs at the top of the actor's AI update, also while it is
  dormant-hidden; returning true skips the generic AI for that tick. A special takes over only
  while its move runs (grab, charge, fly-by) and leaves perception, chasing, plain melee, hit
  reactions and death to the generic AI; bosses own their actor.
- `Actor.damageFilter(amount, hit, by)` is applied first by `ActorManager.damage`, which now
  receives `hit = { point, type }` from `services.damage.apply` (world/damage.ts) through
  `services.actors.damage(actor, amount, from, by, hit)`: weak spots, heads, immunities.
- `ActorManager.adopt(actor)` manages an actor built outside `populate()` (the Black Ones).
- The actors system calls `specials.update` / `specials.message` / `specials.died` (a boss
  firing its own death outputs instead of Character p28).

How the RFL code was read: behaviour runtime objects come from the factory at 0x10107e00
(jump table 0x101092d4, indexed by the behaviour type that 0x10106d40 maps class ids to);
their vtables share one layout: vt[7] start, vt[8] child finished, vt[9] message (clip markers
arrive as messages), vt[10] update, vt[11] name, vt[19] end. Template properties are read with
`push idx; call [table+8]`, so every property below is tagged by the address that reads it.

#### 15.7.1 Nooseman (nooseman.ts)

[verified: KillObject 0x10082560 / 0x10084a50, GrabAttack 0x10084c30 / 0x10082c60 /
0x10082e60, Grapple 0x100833c0 / 0x10083a20 / 0x100841a0, rope 0x10081650, drop groups
0x10084ed0..0x10085280]

The earlier model (hangs visibly, climbs between positions) was wrong. The Nooseman is hidden
from init until each attack and never walks:

| Prop | Meaning |
|---|---|
| p175 18 | low-point bone (grab test, drop length; the corpse falls from it) |
| p180 / p181 | rope bone / body-attach bone (inverse-scaled so the body keeps its size) |
| p182 5.294 | native rope length (m): rope scale = length / p182 |
| p184 20 / p186 0.15 | longest drop (m) / clearance above the target's feet |
| p185 | one Nooseman Drop Position; its connected group (links made two-way) is used |
| KillObject 10:233 p2 / p3 | grab radius 1 m horizontally / 0.8 m vertically |
| KillObject p4 / p5 | cooldown 3 s after a hold / 0.5 s after a miss |
| GrabAttack 10:1340 p2 / p6 | drop 10 m/s / reel up 4.5 m/s |
| p3 / p13 | rope bounce waveform 10:9 (metres, 2.28 s) / show delay 0.03 s |
| p4 / p5 / p8 / p9 | clips: bottom, drop loop, reel start, reel loop |
| p10 / p11 / p14 / p15 | appear FX, drop sounds, vanish FX, vanish sound |
| Grapple 10:216 p2 / p3 | strangle loop front / back (back = both face the same way) |
| p5 0.25 / p6 0.25 / p7 3 / p8 5 | grace, lift speed, meter cap, longest hold (s) |
| p9..p10 15 | damage per second (meter past the grace) |
| p13 / p14, p11 / p12 | release clips (escape), kill clips (the player dies) |
| p15 / p16 | Screen Fader 10:217 / darkest 85 % |
| p18 / p19 | NPC victim: held 3 s, 30 damage on release |

Attack: every try (0.3 s apart when nothing fits) it predicts where the player will be when
the rope arrives (velocity x drop time + p13), takes the first free position of its group within
0.5 m of that point, with a clear line from just under it, teleports there unseen, shows,
drops, bounces, grabs on contact, else reels up and hides. The grapple fills a meter at 1 /s up
to p7; every struggle press (Player p316 = 1) takes 1 off; an empty meter breaks free; p8 s of
hold ends it. Waking: its DormantBehavior ends only on its p12 message (On) [verified with the
AI work]. Port [inferred]: rope stretched by moving the rope bones along their length; presses
are fresh movement / jump / crouch inputs (the original counts the attack buttons); the tint
is a plain overlay.
Characters [verified: 0x100833c0 non-player branch, update 0x10083a20, end 0x100841a0]: the
KillObject drops on its KillEnemies target, the player or a character. A character's grapple
plays his own p144 / p145 clip, sends him a token hit (1e-4, type p17: the attack stimulus),
holds him p18 (3) s with no meter and no struggle, and its end deals p19 (30), type p17. Port:
while hidden the Nooseman runs the generic target choice (`Actor.sense`) and drops on a character
it picked, else on the player as before; the victim is not lifted and keeps his AI [port]. Before,
characters were never grabbed.

#### 15.7.2 Burrower (burrower.ts)

[verified: think 0x10070b50, underground 0x10070950, surfaced 0x10070aa0, events 0x10071040,
BurrowerKillMelee 0x10071ad0, BurrowerFlyBy 0x100719e0 / 0x10071530 / 0x10071700]

Underground by default: not solid and not targetable. It surfaces for the whole of a melee
attack, a hit reaction and death; the attack clips themselves rise (Emerge marker 455: the
floor material's Burrower Material Effects p15) and sink (Recede 458: the Hole p187 and its
generators). Heavy footsteps raise dirt mounds (p9). p182 rumble sound; p185 its targetability
while surfaced; p186 the clip it pops out with when killed underground (only area damage reaches
it); p188 / p189 kill-player finisher (100 %, 7 s clip). BurrowerKillMelee 10:576: every p11..p12
(10..15) s, p13 (70) % of the time, a fly-by: p17 (3) passes, each to a point p16 (4) m past the
target on a 45-degree line (side random), then back toward him stopping p14..p15 (7.5..10) m
away. Port: underground, a hit with a point does nothing, area damage counts [inferred: the
original lets bullets pass]; default material entry for the trail; finisher not played. The fly-by goes for the KillMelee's target, the player or a character (no
class test in 0x10071ad0 / 0x10071530) [verified]; the port had it after the player only.

#### 15.7.3 Fester (fester.ts)

[verified: KillMelee 0x10075b20 / 0x10076030, ChargeAttack 0x100765d0 / 0x10076810 /
0x10075e20, messages 0x10075900, weak-spot test 0x10075a60]

- Armour: Damage Resistance zeroes types 13, 12 and 1 (bullets) unless the hit lands on the
  bone a clip opened with StartVulnerable (456) and before EndVulnerable (457) [verified caller
  0x100e77c3].
- Rat release (KillMelee 10:364 p13..p16): first p15 (11) s after engaging, then every 11..16 s,
  only with the target beyond p13 (2) m: clip p14 (10:413) whose SpawnRat (460) markers each
  create the p177 Rat (10:381) on the marker's bone; the death clip 10:401 releases six.
- Charge (KillMelee p19..p23, ChargeAttack 10:1535): every 1.5..3.5 s with the target 5..20 m
  away inside +-30 degrees and a clear sweep: wind-up 10:1448, run 10:1447 at its root speed
  (8.4 m/s) steering at the start position until within p6 (3) m; touching the target -> Attack
  p5 (10:1538, blow 20 x 1.5 = 30); the target more than p7 (2) m to the side or blocked -> skid
  10:1449. FesterFinishingMoveBehavior and "Charged Attack" are unused stubs.
- Whose [verified]: KillMelee (0x10075b20 / 0x10076030) has no class test: release and charge
  work on its KillEnemies target, the player or a character (Clem on 6b's beach). The charge's
  contact loop (0x10076880..) strikes on the first mover contact that is the Player or any
  Character (object type 7). The port did both only against the player [fixed: fester.ts].

#### 15.7.4 Mainliner (mainliner.ts)

[verified: KillObject 0x1007dc70 / 0x1007f4a0 / 0x1007ee30, JumpAttack 0x10073b90 / 0x10072c20,
launch 0x100736b0 / 0x100743c0, grapple 0x1007e290 / 0x1007f9f0 / 0x1007f420 / 0x1007f3b0]

KillObject 10:185 p24..p25 (10..15 s, 0 on engaging), p26 1.5 m height, p27..p28 3..9 m band.
MainlinerJumpAttackBehavior 10:203: p3 leap Attack 10:204 (clip 10:198, 3..7.5 m), p6 30-degree
grab cone, p7..p8 height window, p9 miss landing, p4 / p11 front / back stick Attacks (10:228 /
10:237, x1.5), p2 20 damage base, p12 0.2 clock jitter, p13 2 s ride. Riding: the player plays
p304 / p305; from the clip's Unlock marker (0.61 s) the clock runs at dt x (1 +- p12) and each
struggle press takes Player p303 (0.035) off it - the presses of the four input actions Fire,
Throw, Jump and Use (0x428..0x42b, summed each frame at 0x1007fb1f..0x1007fb9d) [verified];
movement keys do not count. About 12 presses a second are needed to outlast the ride (p13) on
the 1.8 s stick clip; past the clip end -> finisher p6 x p2 = 30 and it
jumps off (p178 clips; player p308 / p309); below 0 or p13 s after Unlock -> thrown off (p179;
player p306 / p307) without damage. Placed as a root behaviour (level 2 #870) it leaps at once.
Port [inferred]: the leap's Arm window is applied as one melee blow on contact; the rider
stands at the player's feet.
Characters [verified: jump trigger 0x1007ee30, vt 0x134 0x100870f0, 0x1007e0e0, grapple start
0x1007e290 / update 0x1007f9f0, 0x10087160]: the KillObject leaps at its KillEnemies target, the
player or a character with p143 set (retail: Clem 10:642, Dallas 10:391, both 1); the launch
sticks to the first body it touches that is the player or such a character. A character's
grapple deals him his p141 (front) / p142 (back) incapacitate Attack at once (p6 x p2: 0 for the
retail 10:205, with its p11 effect) and plays its clip p0 (10:228) at rate 1; there is no
struggle. When that clip ends, or he dies, with the ride timer still running: the finisher, the
side's stick Attack p6 x p2 = 30, and the jump off (p178). The timer (p13 s [inferred]) running
out first: thrown off (p179), no damage. Port: the rider keeps its front / back offset on his
feet; his AI goes on [port]. Before, characters were never leapt at or ridden.
Struggle input: `PlayerController.attackOverride` takes Fire / Throw / Use while a creature holds
the player (weapons/system.ts, world.ts), `specials/hold.ts` counts them and Jump; the port had
counted movement and crouch presses instead (the Nooseman's grip uses the same count).

**Thrown needles** [verified unless marked; `actors/missile.ts`, `actor.ts updateMissiles`]. The
needle is Missile 10:1814 in Character p55. Its Attack 10:210 throws clip 10:242, whose one shot
marker is ThrowWeapon (230) at 0.278 s (no Fire), so it leaves through ProjectileAttack's case 230
(0x100fd026) like the molotov, not through a Ranged Weapon: no Ranged Weapon p75 x Attack p19
spread (the aim call gets a spread of 0, 0x100fd165), no lead.
- Aim point: ProjectileAttack keeps one (+0x64), cleared at its start (0x100fee3e), taken at the
  Fire state's entry while unset (0x100fcc31), and taken again at the marker only when the
  behaviour's own p5 is 0 (0x100fd069 -> 0x10097b80, the ProjectileAttackBehavior template).
  10:209 has p5 = 1 (18 of 20 retail behaviours do): the needle goes where the player was when
  the throw clip started.
- Launch: p0 = 1, the ballistic aim (`throw.ts`) with p1 45000 units/s (21.97 m/s), p46 20 % of
  the world's gravity (2.08 m/s²), reach p9 20 m, fallback p10 45 deg; released (0x100ce190), it
  flies p12 = 5 s.
- Contact: the sweep vt+0x5c (shared with BouncingObject): world front faces grown by its bounds
  radius (0.20 m); bodies by their posed leaf hit spheres grown by the same radius (the skinned
  path 0x419b20 is not traced) [inferred for bodies]. Any contact sets it off (touch vt+0x24
  0x100cc120 -> vt+0x4c); the impact (vt+0x54 0x100d1450) deals p26 = 10 of type p32 = 1 to a
  body and p34 (3:3199) spawns there. The thrower's own body is skipped [port].
- The port before: a hit chance of 0.9 - 0.02 x distance (at least 0.25), then damage on
  arrival if the player was within 0.9 m of where he had been.
- Checked in level 2's cell block (`2.clones`, 18 throws): the needles land on the kept aim
  point; 5 of 18 hit the player in the first run, the rest met the walkway, bars or stairs or
  missed a player the harness had moved.

#### 15.7.5 The Slayer: ceilings, transitions and the leap (cartwheeler.ts)

The blade-armed "Slayer" is engine class CartWheeler (vtable 0x10152f88, ctor 0x10071dd0). Code:
`specials/cartwheeler.ts` (controller), `specials/cartwheeler-params.ts` (decoded values),
`variants.ts` (behaviour variants), `nav.ts` (ceiling nodes, edge types). Tests:
`tests/cartwheeler.test.ts`. Tags: [verified] read in the code, [data] from the retail values,
[inferred] otherwise.

**Surfaces [verified].** The engine has two: floor and ceiling. Nothing in the code walks walls;
the "down a wall" clips (10:30 and the wall-hole JumpBehavior 10:1319) move the body through
their root translation. SetOnCeiling (Character vt 55, 0x100e2160) switches the physics
(+0x72 flag 0x10), the animation controller and the up vector (to (0, -1, 0)), and sets condition
bit 0. The ceiling clips hang below the origin, which sits on the ceiling surface: idle 10:31,
walk 10:13, run 10:9, turns 10:91 / 10:92. CartWheeler p180 = 1 starts on the ceiling (init
0x10071eb0). In 1a that is #64f8, over the pit by the booth; Detector 75db wakes it through
Behavior Changer 841a.

**Choosing a surface: nav edges [verified].** The level graph decides; surface normals play no
part.
- Move Node p0 = 1 (template 10:128) is a ceiling node. 1a has 41 of them; each sits on the
  ceiling surface (within 0.1 m in the collision world).
- An edge's type comes from its two nodes, in walking order (0x100da930; reverse edges
  0x100daea0):

  | Type | From | To |
  |---|---|---|
  | 0 | floor | floor |
  | 1 | ceiling | ceiling |
  | 2 | floor | ceiling |
  | 3 | ceiling | floor |

- Transition edges get a crossing point and a length when the level loads (0x100db910).
- FollowPath (0x10110db0) inserts a CeilingFloorTransitionBehavior when its next edge is type 3
  on a ceiling or type 2 on the floor.
- The path cost function (0x1011d8d0) takes two flags that double the cost of ceiling / upward
  edges (types 1 and 2) or of floor / downward edges (types 0 and 3). Who sets them was not
  traced.

Port [inferred]:
- Walkers path over floor nodes only (`NavGraph.path` without `crawler`; before this, a ceiling
  node could be a walker's goal).
- A crawler paths over all nodes, with a transition edge costing its horizontal length.
- On a ceiling the crawler follows its path's ceiling stretch to the first type 3 edge and lets
  go at the crossing point (the middle of the stretch both node areas cover).
- On the floor, every 1.2–1.8 s it checks whether its path climbs within its first two edges; if
  so it walks to the crossing point and leaps up.

**CeilingFloorTransitionBehavior (p178, 10:132) [verified: start 0x1010e2c0, events 0x10110610,
end 0x1010e430].**
- Ceiling to floor: p2 let go (10:30; its root drops 3.26 m), then fall with gravity × p9 (1) from
  p10 (0) m/s looping p3 (10:29), land with p4 (10:28).
- Floor to ceiling: p5 launch (10:98), then SetOnCeiling(1); fly up at p8 (15) m/s with gravity
  off, looping p6 (10:100); catch the ceiling with p7 (10:99).
- Afterwards, p11 (0) s idle.
- In retail it is also placed once (level 2 #2edd, after CartWheeler #2ed0's ceiling waypoints).

Port [inferred]:
- The let-go clip's root lowers the origin before the fall.
- The catch starts with the hands at the ceiling (the feet as far under it as the catching clip's
  first frame).

**Condition bits and behaviour variants [verified: the variant test 0x10101380].** A template's
p105 / p106 lists hold conditional variants. A variant applies when every bit in its p1 is set
in the condition word (+0x74) and every behaviour type in its p0 runs above it. The bits:

| Bit | Meaning | Set by |
|---|---|---|
| 0 | on a ceiling | SetOnCeiling |
| 1 | close stance: within CartWheelerKillMelee p18 (5) m of the target, cleared beyond p19 (7) m | 0x10072330 |
| 2 | head shot off | 0x10072a30, from the damage path's head test |

A change re-evaluates the affected behaviours (0x10098620).

For 10:24:

| Behaviour | Default (bits 0) | Ceiling | Close | Headless |
|---|---|---|---|---|
| MovementAnim | 10:82 (idle 10:1, walk 10:668, run 10:875) | 10:134 (above) | 10:36 (walk 10:6) | 10:1420 (with close), 10:1432 (with ceiling) |
| CartWheelerKillMelee | 10:141 | 10:1880 | — | 10:1418 |

When several variants match, the one with the most conditions wins [inferred].

**Template slots by behaviour type (CartWheeler vt 46, 0x100720c0) [verified].**

| Type | Behaviour | Slot |
|---|---|---|
| 5 | MeleeAttack | p179 on a ceiling (not mid-transition), else Character p87 |
| 36 | JumpAttack | p181 |
| 41 | CeilingFloorTransition | p178 |
| 44 | CartWheelerKillMelee | p182 (KillMelee 77 maps to it) |
| 50 | FleeLight | p183 |

Hit reactions (vt 64–66):
- On a ceiling: p175 (10:451, it stays up); p177 when the blow kills (10:93 drops 3.8 m, then
  10:94, 10:95).
- On the floor: the head's p186 while the head is intact; p184 / p185 in the close stance;
  otherwise Character p70 / p71 / p72.

Port (clipmap.ts): a Character's floor melee is now its p87 slot only. The ceiling slash used to
be mixed into the floor attacks.

**Melee [verified].** The ceiling slash is MeleeAttackBehavior p179 → Attack 10:143: clip 10:8,
started at 0–1.2 m horizontally (scaled), with p17 = 4 m of height at most. Floor attacks are
p87 (10:955 / 10:87 / 10:88 / 10:958). After an attack, KillMelee waits p2..p3 s before the next
(child-finished handler 0x1007cf10):
- 10:141: 0.1–0.5 s;
- ceiling 10:1880: 1–1.3 s;
- headless 10:1418: 0.1–0.3 s.

The wait is the generic KillMelee's (vtable code 0x1007c870..0x1007d080, shared by every
KillMelee kind) [verified]: on its MeleeAttack child finishing it sets +0x30 = p2 + U(0, p3 - p2);
the update (0x1007ce60) counts it down and only at its end tries the next attack (0x1007ce00:
in range and no higher child running, else a MeleeCombatReposition child, type 6, toward the
target); the attack start (0x1007c870) first ends every child. Which KillMelee template a
character runs is its behaviour slot for type 0x4d: Character p85 in the generic slot map
(0x100e17c0, the full table: 0 -> p81, 5 -> p87, 6 -> p83, 8 -> p82, 9 -> p76, 0x30 -> p88,
0x39 -> p98, 0x42 -> p77, 0x4d -> p85, 0x4e -> p86 ...), p182 for CartWheelers. Retail p85:
Unspeakable NPCs 10:578 (0.5..1.5 s; 10:1149 0.4..1, 10:1619 2.5..3.5, 10:1472 0.3..1), Slayers
10:1565 (0 / 0). Port: the profile's `meleePause` from p85 when it is a plain KillMeleeBehavior
(`manager.ts profile`); before, only CartWheelers waited and an armed NPC struck back to back
(the Prelude's three inmates killed Torque in 7 s).

An instance can override a Character's MeleeAttackBehavior slot p87 (retail: the Prelude's three
attackers and one 2 Cellblocks inmate, 10:297 on template 10:392, which has none). The port's
creature kinds were built from the template only, so those fought with guessed clips and a
guessed 10 a blow; a placement with its own p87 now gets a kind of its own (`kinds.ts creature`,
`clipmap.ts resolveCreatureClips` overrides): clips 10:1727 / 10:351, the weapon's 8 a blow.

A blow is the blade Melee Weapon's p68..p69 mean (6.5) × Attack p6 (the ceiling slash: 9.75).

**The leap (CartWheelerKillMelee update hook 0x10074c80; JumpAttack 0x10073b90 / 0x10073e50;
JumpAttackLaunch 0x100736b0 / 0x100743c0; JumpAttackStick 0x10073920) [verified unless marked].**
- Floor only.
- Every p11 (0.15) s it tests: the target p14..p15 (4–6.5) m away in 3D, within ±p16 (30)°
  ahead, a clear sweep to it (p17), then a p13 (70) % roll. A failed roll, or the end of a leap,
  waits p12 (4) s.
- JumpAttack p181 (10:139):
  1. MoveTo until within the launch Attack's reach (10:960: 3–6 m), for up to p5 (2) s.
  2. Face the target.
  3. Launch: clip 10:883, whose root motion carries the body 12.8 m.
  4. A touch while the target is within p7..p8 (−0.5..0.7) m of height (and ±p6°) sticks: the
     stick Attack 10:1292, clip 10:87, which springs back off.
  5. Otherwise p9 (10:880); after a stick, p10 (10:880).
- Port [inferred]: one launch blow on contact, as for the Mainliner.
- Whose [verified]: the hook has no class test, so the leap goes for whatever the KillMelee
  fights, the player or a character (1c's inmate, Dallas). The launch (0x100744f0..0x100745f7)
  sticks to the first body its mover touches that is the Player or a Character whose vt 0x134
  accepts the attacker (0x100870f0: everyone, except that a Mainliner needs the victim's p143);
  the height / cone window is then tested against that body while they touch. Before, the port
  leapt only at the player and its ceiling slash hurt only the player (a character under it
  took nothing); both now take the target, the player or a character [port: cylinder contact].

**Other KillMelee hooks.**
- [verified 0x10073080] Once the head is shot off, it plays AlertInfo p20 (10:1244: 10:1056).
- The flashlight [p21..p25 verified (0x100747a0 / 0x10072f00); light model inferred]: lit by the
  beam above p22 (0.4) and the p23 (100) % roll, it plays the FleeLight AlertInfo (10:1311:
  10:1237 backing off, hiss 10:457). It does not flee again for p24..p25 (1.5–3) s.
  - Port light model: full within 10° of the beam axis, nothing beyond 25°, fading to nothing
    at 10 m.
- Data: 1a's instance overrides of p182 are
  - 10:159 (no close stance);
  - 10:832 (never leaps, 4–6 s between flights);
  - 10:647 (on 10:627).

**Port specifics [inferred].**
- On a ceiling the crawler is held on the ceiling found by rays from under its origin. It stops
  at walls (a swept sphere under the ceiling) and at steps over 0.6 m.
- Its eye is 0.6 of the hanging depth below the origin; from the origin, the ceiling beams hid
  the room.
- With no ceiling route it lets go once the target is in sight within 7 m (the old hanger rule).
- Ceiling waypoint walks go straight to each waypoint.
- Debug: `__specials.runtime.moves.get(actor)` gives `toCeiling()`, `placeOnCeiling()`,
  `letGo()`, `leap()` and `info()`; surface and mode changes are logged in `__specials.events`.

**Checked in headless Brave** (1a, harness `--keep`; strips in the agent's scratch):
- A spawned 10:24 on the ceiling crawls the ceiling nodes over the 88.66 m hall, lets go at the
  transition (fall of 3.8 m), lands, then leaps and sticks.
- Floor-to-ceiling launch and catch at 8118.
- The ceiling slash under 8117 (9.8 damage).
- Death on the ceiling (fall-off sequence).
- Backing off from the flashlight.
- #64f8 woken by Detector 75db crawls from over the pit, drops 1.4 m by the booth and fights.

#### 15.7.6 Inferna (inferna.ts)

[verified: TakeDamage 0x10078400, update 0x10078cf0, StartFlaming 0x1007a730, KillObject
0x1007a550 / 0x1007a620, FlamingKill 0x1007aa00, CircleTargetSteering 0x1007afd0, FlameAttack
0x100799a0, Ash 0x1007adb0]

Modes unlit, igniting, flaming, collapsing, ash, reforming. Only the ash pile can be hurt;
while flaming a hit burns p187 (0.3) s of flame per point. It ignites on p192, on MorphCharacter
(220) while dormant, or with its target within KillObject p2 (20 m) (p184 instances start lit);
the flame lasts p185..p186 (20..40) s. Flaming, it circles at KillObject p5 (4 m; clips p182 /
p183; reverses when blocked) while the target is within p4 (11 m) and every FlamingKill p4..p5
(3..6) s: within 0..5 m a flame burst (clip 10:1383, generator 3:3864 with Radius Damage 20 -> 5
over 10 / 20 m), within 6..30 m a fireball (ProjectileAttack 10:1501 throwing BouncingObject
10:1779 at 12.2 m/s, Radius Damage 10:1782), else it repositions (p10 90 % toward the fireball
band). Burnt out: collapse 10:688, ash pile p190 (its own 40-bone rig, clips 10:692 / 10:729)
with the Ash Attachments, vulnerable for 15..25 s, then reforms (10:730). No teleport is
involved (SimpleTeleport belongs to FollowPath). Port: the flaming model is swapped in when its
rig matches; BurnFX on the player is not applied. Target: the KillObject's, the player or a
character (no class test in 0x1007a550..0x1007afd0) [verified]: ignition range, circling, the
attack choice and the fireball aim. The bursts' Radius Damage hurts every character in reach as
well as the player (the class rule, §8 throwables) [verified]; the Inferna itself is left out
[inferred]. Before, the port aimed at and burnt only the player.

**How it moves** [verified unless marked; behaviour factory 0x10107e00 ids: 1 MoveTo, 0x66
InfernaKillObject, 0x67 InfernaFlamingKill, 0x69 InfernaCircleTarget, 0x6a its steering, 0x6b
InfernaFlameAttack, 0x30 ProjectileAttack; tests `tests/inferna-move.test.ts`].
- *Chase.* The KillObject's start (0x1007a550) pushes a MoveTo to its target with the arrival
  distance p3 x 2048 (8 m; MoveTo request +0x1c, 0x100712f0): a walk on the Move Node graph like
  any MoveTo (§15.5), lit or not; its update ignites the body at p2 (0x1007a620). The MoveTo's
  success (child end 0x10079bd0) starts the FlamingKill (p5 radius, p4 limit); the FlamingKill's
  success starts the MoveTo again while the target lives.
- *Circling.* The FlamingKill's circle (0x10079e50 -> InfernaCircleTarget 0x1007a120) is
  steering only: it pushes InfernaCircleTargetSteering (weight p2 = 1, movement mode 3) and
  MovementAnim; the CharacterAvoidance / ObstacleAvoidance / SeparationSteer / WanderSteer /
  SpotlightAvoidance children (p3 / p4 / p5 / p6 / p7) are pushed only when their weight is above
  0, and 10:845 has them all 0. The wish (0x100796d0): n the unit vector to the target on the
  ground plane, the tangent (n.z, -n.x) or (-n.z, n.x) by a 50 / 50 flag drawn at each start
  (0x1007afd0), k = 1 - d / R inside the radius and R / d - 1 outside it, wish = tangent x
  (1 - |k|) - n x k, at the circle clip's speed; the force (wish - velocity, 0x1007b300) goes to
  the body's steering combiner (+0x60 +0x90, 0x100dd220), whose result (0x100de400) is the
  body's velocity for the physics (0x100ddef0). Nothing on that way asks the graph or the ground
  (ConstrainSteer, the only steering that would, is pushed by Scurry alone, 0x1010c1e4). So the
  circle can leave the graph's areas: a target standing at a drop puts half the circle over it,
  and the body falls where its follower finds no ground within p48 (1 m, §14.9) [strong: from the
  decoded parts; not seen in the original]. The circle ends
  when the target is more than p4 away on the ground plane (0x10079660).
- *Stuck* (0x1007b0f0): over 0.15 s windows the steering keeps a circle round the body's ground
  positions; a window whose circle is under 0.015 x the steering speed (a tenth of the window's
  travel) reverses the direction; a second one running gives the steering up, and the body
  stands in the circle until the next decision [inferred: the circle's child-end handler
  0x10101530 does nothing]; a free window clears it.
- *Decision* (0x1007aa00, on the p4..p5 timer while the circle runs; every circle start draws it
  again): the 3D distance in the flame band gives a flame burst, in the fireball band a fireball;
  no sight test there. In neither, p10 % picks the fireball band (else the flame band), a distance
  is drawn from it and a MoveTo to the target follows: nearer than now it is the arrival distance,
  farther the least distance (request +0x20). Its success (0x1007acb0) with the target in sight
  (0x101263f0) gives the attack of the band drawn, without sight or on a failure the circle; an
  attack's end gives the circle.
- Port (`specials/inferna.ts`): the MoveTos are walked by the generic graph steering
  (`Actor.specialWalk`: path, doors, ladders, ground-checked shortcuts, §15.5); a least-distance
  goal is the point that far out on the line from the target, or the graph node there when the
  line to it has no ground [inferred]; a MoveTo that gets nowhere for 4 s fails [port]. Before,
  the port circled from 11 m, left the chase to the generic combat (which threw fireballs from
  range and kept 14 m off), walked the reposition straight for 4 s and reversed on a stuck frame.
  In a session at the inlet's north rim of 9 (player at (333, 112.8, 206.5)), bd4 / bd5 circled
  over the rim to the shore 28 m down; by the decode above the original's circle does so too.

#### 15.7.7 Horace (horace.ts)

[verified: HoraceKillPlayerBehavior 0x10077e00 / 0x10077f60 / 0x100780a0, stage table vt[45]
0x10077bc0, stage input 0x10077c00]

HoraceKillPlayerBehavior p2 and p3 are message ids, not reach / damage: p4..p5 s into each idle
cycle Horace sends p2 (6 Triggered) to his links unless at his last stage; after p6..p7 (21) s,
or at once on p3 (350 QuestStart), he attacks with ProjectileAttack p175[stage] (10:581: six
templates, clip 10:1396, Fire at 0.95 s, 1.5 s apart, weapon 10:1795), which sends its p16 (350)
to his links. p176 (6) received moves him a stage on. 1a is the only fight: Relay #7a4b starts
it; his 6 -> Relay #83ae (shields up, Breakables invulnerable); his 350 -> Relay #8591 (shields
down); each of the five Breakables -> Relay #8589 (CountDown #8592, Triggered to Horace, BC
restart); then Switch #8588 -> STOMP #8399 -> Relay #839d BlowUp. 1b has no Horace fight:
"Horace#275" / "Horace#276" are cell-vision STOMPs picked by reputation (#83b3 -5..999, #83b2
-999..-5) and run by the sequence system. Port [inferred]: Attack p23 (5, 4, 3, 2, 1, 99) is the
shot count of a volley and p16 is sent as the volley starts (the shields are down while he
shoots; the next cycle's Triggered raises them again); a Behavior Changer re-handing the
behaviour (Relay #8b39 after each break) restarts the cycle.

Monitor scene (1a, monitor 6dec, §14.5): viewing it fires p72 -> Relay 7b0c -> Behavior
Changer 7b13 (WaypointBehavior 7b0f, Waypoint 7b0d: p1 = 1, but Horace's MovementAnimBehavior
10:637 has the same clip 10:567 for walk and run, so he walks) and Damage Action Object 7a65,
whose p8 Electric Arc Effect 3:2230 stays on him for its p0 (999 s): one arc of Electric Arc
3:2231 travelling over his bones and p1 generator 3:2283 (a flickering pale-blue Point Light at
the start bone). The arcs are decoded in §17.3.1 (fx/electric-arc.ts) [verified].

#### 15.7.8 Killjoy and the Projector Effect (killjoy.ts, projector.ts)

[verified: KilljoyRoot 0x1007bd70 / 0x1007bea0, RaiseDead 0x1007c170 / 0x1007c330, Resurrection
0x100e7700 / 0x100eda03, Projector Effect 0x1008c080 / 0x1008c4c0]

Killjoy has no attacks. KilljoyRootBehavior (5b #1508 / #1ba1, p2 = corpse uids) [verified:
start 0x1007bd70, update 0x1007bea0, child done 0x1007c000; the child types come from the class
map 0x10106d40: 0x42 FleeBehavior, 0xb LookAtBehavior, 0x4b KilljoyRaiseDead, 1 MoveTo, 0xc
PlayAnim]:

- **Start**: a FleeBehavior child (his Character p77, 10:568) and a LookAt on the player.
- **Update** (while no RaiseDead runs): p2 is scanned from the last entry. An entry whose object
  is gone, or is no character (0x100e1760), leaves the list (the last entry takes its place);
  the first dead one (0x100a1ad0) stops the Flee and the LookAt and starts a RaiseDead on it.
- **Child done**: when the RaiseDead ends (1 done or 2 failed) the LookAt on the player and a new
  Flee start again.
- **KilljoyRaiseDead** (Character p175, 10:571) [verified: start 0x1007c170, child done
  0x1007bcc0, update 0x1007c330]: a MoveTo the corpse with the MoveTo request's defaults (ctor
  0x100712f0: distance 4096 = 2 m, movement mode 3, a run) and a LookAt on the corpse. When the
  MoveTo ends, arrived or failed, the p2 clip (10:510) plays (PlayAnim). The update waits while
  the MoveTo runs; the corpse gone fails it; while Killjoy plays p2 and it is done (anim flags
  0x201 == 1) the corpse is resurrected (Character vt 22) and it is done; while p2 plays, the
  corpse's broken body parts (its p16 list) come back one by one with the clip's progress
  (0x10118930 / 0x101189e0); without p2 playing and within p3 (1 m, 3D) it starts p2 again.
- Resurrection: CartWheeler p160 % health; the corpses' initial DeathBehavior 10:651 gives the
  pose p2 and the rise clip p3.
- His FleeBehavior 10:568: threat team the player's (2:384), p31 20 m, p32 20 m, p33 4 m; p2,
  p10, p13 and p15 all 0, so it never ends by itself (§15.14).

When the last of his projectors breaks, the Projector Effect deals him 10000 damage. Level
wiring: each break -> Relay #164c (p2 = 1, p3 = 0: one link per message, in order) -> taunt
conversations (each chained back to KilljoyRoot #1508); the fifth -> Relay #1bf8 -> Behavior
Changer #164a (his last line), then Relay #15ac -> Timers #151b (the effect Off) / #15ad
(Destroy, Archives Trigger, Timer #15a9 -> Sound #1641 -> STOMP 28:21 "RebirthMachine Actor").
Port (`actor.ts runKilljoy`, behaviours 'killjoy' / 'raiseDead'): as above; the LookAt turns
the body to the player while the flee stands; a MoveTo that makes no way for 3 s has failed (as
in runFlee); the body parts coming back are not ported. Killjoy Rebirth Effect is a state the
Ring Damage puts on the player (burning hand + grenade supply; docs/re/object-model.md §8). It is
not part of the creature: in 5b the Object Generator #2e3f (by the Switch #2bec) throws the
Ring Damage 3:4555 that gives it.

**Projector Effect** (class 0x04cb8be8, 29 instances in 9 levels; `specials/projector.ts`)
[verified unless marked]. Init is 0x1008c080, the update 0x1008c4c0 and the beam vertex
0x1008b9e0. The input map 0x10177958 gives p13 0x1008be30, p14 0x1008be90, p15 0x1008bf10 and
p16 0x1008b820.

| Property | Meaning |
|---|---|
| p0 | target object |
| p1 | on at start (0 in retail) |
| p2 / p3 | flatten the target's normals on axis p3 (p2 = 0 in retail; not ported) |
| p4 | flicker % |
| p5 / p6 | opacity % with all / none of the projectors standing |
| p7 | strobe period in updates (0 in retail) |
| p8 | chance (%) per update that a standing projector's beam is hidden for one update (0 in retail) |
| p9 | a target bone per projector: its channel hides that projector's beam |
| p10 | projectors (Animating Statics, or placed objects without a model) |
| p11 | the lens bone of each projector (5) |
| p12 | the target vertex of each projector |

- **Init.** It hides the effect's own object and keeps the target. It counts the projectors that
  exist; for each one missing it hides bone p9[i].
- **On** runs both of its inputs:
  - p13 starts the effect's updates. It clears the target's shadow-caster bit (bit 24 of the
    engine object's flags) and sets bit 0x10000000 at +0xc. Object filters 0x425ed4 / 0x4259d4
    test that bit [use inferred: queries skip the figure].
  - p16 arms the strobe counter with 1. The next update therefore calls SetVisible(1) on the
    target (vtable +0x128, the Visibility Toggler's call).
- **Off** runs p14, then p15:
  - p14 stops the updates, gives the shadow back, and shows the target at opacity 1.
  - p15 hides the target and disables the effect.
- **Update**:
  - Strobe: while the counter runs, the target is hidden. When it reaches 0 the target is shown
    and the counter restarts at p7.
  - The effect moves to the target's position.
  - For each projector i (beam 0x1008b9e0; a null handle is skipped):
    - Gone: its beam is hidden (animator request 0x100010 on the channel of target bone p9[i]);
      the tip is not written and stays where it was. f, the share of projectors standing,
      drops by 1 / count.
    - Standing: vertex p12[i] of the target (welded copies included) goes to the lens. The lens
      is bone p11[i] of the projector when it is a skinned instance with that bone (vt +0x94),
      else the projector's own position (+0x44): 1c's #7ef6, 10's #11e4 and 5b's #1560 / #1562
      are Breakables 7:330 without a model. The lens minus the target's position, turned and
      scaled into the target's frame (0x1000ce10), is written into the model-space vertex array
      (skin instance vt +0xa4) at index vt +0xb0 (p12[i]): the .mdu type-22 table (loader
      0x483530, values - 1, negative entries dropped; identity for 10:90's first 2185
      vertices), so p12 indexes the type-3 vertex list [verified]. The point also widens the
      instance's bounds (0x1000a4b0). Then a hidden beam is shown again; a shown one is hidden
      when U(0, 100) < p8.
  - The target's opacity (+0xd0) is clamp(p6 + (p5 - p6) f + U(-1, 1) p4) / 100, recomputed on
    every update.
  - f <= 0 deals the target 10000 damage.
- **1b's projection room.** Killjoy #7eb5 is hidden at start (instance flags 0), and nothing
  else in the level shows him.
  - At 59.09 s of STOMP 12:247, "Turn on Projector & Killjoy" (#80ba) sends On to the projector
    #7eba and to the effect #7edb. The effect shows him and draws him at 0.4 ± 0.5 opacity,
    clamped, per frame.
  - At 6.15 s the scene has sent Off ("Projector OFF", #8713), which keeps him hidden until then.
- **Killjoy's model 10:90** carries five additive light cones in submesh 0 (Advanced 10:781:
  10:256 tinted 0x2d2d2d). Their tips are skeleton vertices 0..4, each at full weight on one of
  bones 86..90.
  - Every Killjoy projector's p12 is [2, 0, 4, 3, 1] (6a / 5b's figures 10:162 / 10:196:
    [3, 1, 2, 4, 0]). Moving the tips to the lens stretches the cones from the projector onto
    him. Each cone is a fan from its tip to his outline in his frontal plane.
  - Material 10:781 has no UV scale or scroll waveform (p9 / p10 0): the beam is a still, dim
    additive texture; its flicker is the object's opacity (p4), which the tinted pass's TFACTOR
    alpha carries (§5.1 of docs/re/renderer.md).
  - Hiding a channel skips mesh partitions: the object draw ORs the LOD word of every hidden
    channel (model +0xc8, the .mdu type-8 channel table) into a mask (0x493698) and skips
    partition k when bit k is set (0x498ee3). Channels 86..90 carry bits 1, 2, 4, 8, 0x10, and
    the cones lie in the face list in tip order 2, 0, 4, 3, 1 = p12: projector i moves and hides
    the same cone i [verified data; partition k = the k-th cone in face order inferred]. The
    same table carries the dismemberment channels' bits on human rigs.
  - The model's header flags are 0x1cc8012: bit 23, so his passes cull back faces like Hermes'
    (docs/re/renderer.md §5.1). Below 0.99 opacity his opaque first pass blends as mode 1 with
    the > 2 / 255 alpha test and still writes depth (0x48fc70 reads the layer's own mode).
    A translucent Killjoy therefore shows his nearer front faces only: neither his back nor the
    far side of his body shows through.
  - His body passes are Layered materials: texture × 0x414141 (unlit), then an additive pass of
    the black 10:428. Translucent at the effect's opacity, he is a dim, flickering figure in
    the projector's light.
- **Port** (`specials/projector.ts`):
  - It runs the inputs, strobe, visibility (through the world's setVisible), opacity (copies of
    the target's materials, opaque passes switched to blending), the damage, and the projectors
    as breakable objects.
  - Each cone tip is placed in bind space so that its bone's skinning lands it on the lens
    (exact under any root motion [port]). A projector without a skeleton is its placement.
  - A hidden beam's triangles (those using vertex p12[i]) are drawn degenerate.
  - Cut-out passes of the figure (2:904 on 10:90 / 10:196's cones) keep their > 200 / 255 alpha
    test in the lit character path and through the projector's material clones (three r186's
    `NodeMaterial.copy` drops `alphaTest`; `glow-mark.ts cloneWithGlowMark`). Without it 6a's
    opaque figure 2135 drew its cone fans black, and an opaque Killjoy (1c's p6 = 100 once his
    projectors break, Off) would too.
  - Checked in the browser (before / after strips of 1b's booth, 5b's basement and theatre, 6a's
    phone vision, 1a's Hermes): the beams now start at the lens of model-less projectors
    (5b #1560) instead of fanning out from his bind tips, his faded body shows its front only
    (face and apron detail instead of a washed-out double layer), the scene glow adds its halo
    over the body (10:428's mark), and Hermes (also bit 23) is unchanged.
  - Characters whose model has header bit 23 are drawn front faces only (`app/character.ts`);
    the fading figure keeps its depth write (`render-data.ts translucentPassState`).
  - Before this, a missing or model-less projector's cone went back to its bind tip, about a
    metre from Killjoy in some fixed direction: beams that came from nowhere (1c, 10, the 5b
    rooms with an invisible projector, every 5b theatre projector once shot). The faded body
    was drawn two-sided without depth, so his back and inner faces showed through.
  - A projected actor casts no projected shadow (fx/system.ts).
  - Before this, nothing showed 1b's Killjoy, the cones stayed folded round him, and his body
    was drawn as an ordinary lit skin.
  - Prop targets: the 1a #8897 and 1c #808d / 5b single-vertex targets (skinned Breakable / Switch
    models 12:624, 7:653..655) are drawn by `levels/skinned-props.ts` (§14.8). The effect takes
    their Character from `services.skinnedProps`.
    - 12:624 is a flat light spot (0.7 x 0.5 m) whose cone tip, vertex 57, is pinned to the
      projector lens.
    - In 1a, picking up "Killjoy's Diagnosis" (Ammo Box 79d8) sends Relay 84f3 its input 12. That
      turns the effect on, and the spot shows on the bed of the cell north of the player's with
      the beam to projector 861b (checked in the browser by toggling it).
    - Their 10000 damage goes through `services.damage` (props.ts breaks a Breakable). A Switch,
      which the world keeps no health for, is sent its p12 Destroy input instead [inferred].
    - Projected figures are still hit by shots.

#### 15.7.9 Slayer heads (head.ts)

[verified: body parts 0x10095d10 / 0x10096400, TargetableBreakable 0x1001d190 (Breakable code),
resistances 0x100a2dc0, break 0x1009ba20, CartWheeler head test 0x100721c0 / decapitation
0x10072960 / final death 0x10072210]

The CartWheeler body has no head; Character p54 / p55 (spawned when p56 is set) put a
TargetableBreakable (3 HP) on bone p187 (18). Blows on it hurt only the head and body blows
never reach it. Damage Resistance (p0 type, p1 multiplier, p2 impact-force factor, p3 / p4 a
distance-scaled delay, p5 a Characters-only template): the head takes bullets (1), shotgun (13),
shiv (10), Black One claws (11), 12 and fire (5) at x1, and nothing else because its p5 makes
unlisted types x0 (global fallback: types 14 and 6 at x0). At 0 HP its p18 generator spawns the
gibs and it goes away. A living Slayer is not killed by it: it staggers once (p186 HitReact,
10:51), drops its attack, keeps its health and can no longer revive (p188..p193 revive logic,
whose reachability is unconfirmed). "Targetable": the crosshair locks onto it like a creature;
aim assist does not. Port: a sphere around the head bone receives hits with a point; the hit
capsule is raised over it; the worn model (weapons/npc.ts) hides via `brokenParts`.

#### 15.7.10 Ranged Targeting Position (ranged-positions.ts)

[verified: ctor 0x10126d10, inputs 0x101263a0 / 0x101263b0, FindTargettingPosition 0x101265c0,
sight 0x101263f0]

p0 cover object (13 of 1188 instances), p1 the disabling message (Off; Died / Disable on some),
p2 the enabling one (On); enabled at start. Users: Characters with a ranged attack and a p98
RangedCombatRepositionBehavior (10:236 most NPCs, 10:544 Slayer, 10:1175 Hermes): every p0..p1 s
an NPC linked to a stand takes its first one; otherwise enabled, unreserved stands not given up
within 7 s, within p2 m, whose distance to the target lies in the attack's range narrowed by p9,
score p4 x (1 - dSelf / p2) + p3 x (1 - 2 |dTarget - mid| / (B - A)) + p5 x cover (the cover
object between stand and target, angle > 135 degrees); with p6 the best one that sees the target
from p8's bone wins and is reserved. A stand it cannot reach is given up for 7 s. The target is
the one the RangedCombatReposition request carries (0x100f74f0 passes its handle to
0x101265c0) [verified]: whoever the KillObject fights, the player or a character. Port
(`ranged-positions.ts standTarget`): the player or a living character target (a follower's
waiting Hostility counts); straight-line walking. Before, only fights against the player used
stands: 2's companion fought Mainliners from wherever he stood.

#### 15.7.11 Black One (black-one.ts)

[verified: ctor 0x1006f6e0, init 0x1006f100, update 0x10070310, heart events 0x1006f260,
teleport 0x1006fa80, attack choice 0x1006fcf0, Teleport Effect 0x1008cf70]

The four Black Ones of 10 Docks (#7f4, #820, #821, #822; Ground Object, skinned model 10:156)
are one boss. Their bodies cannot be hurt (PhysicalObject +0x1e set by the ctor); the only hit
points are a shared heart, the p62 Breakable 10:1563 (60 x Difficulty Modifier 10:1850:
1 / 1.33 / 1.67 / 2.33) riding bone p63 (5) of whichever one is up, tinted p65 + (p64 - p65) x
health (halved). One is up at a time and never moves:

| Prop | Meaning |
|---|---|
| p22 / p23 | weapon bones / Melee Weapons (claws, 20 per blow, type 11) |
| p39..p40 / p41..p42 / p43 | retreat timer while the player is within / beyond p43 (15 m) |
| p44..p45 | wait after the retreat clip before handing over |
| p46 | next stage template: 10:1024 -> 10:1699 -> 10:1700 (shorter timers, faster attacks) |
| p48 / p49 | paired taunt clips (index shared by all four) |
| p50 / p51 / p52 / p53 | appear, retreat, stage change, death clips |
| p54..p59 | Black One Attack lists per slot (p0 clip, p3..p4 speed, p5..p6 range, p7..p8 bearing) |
| p60 / p61 | fireball generator (3 missiles, Radius Damage 40 -> 15 over 15 / 25 m) / teleport missile |
| p66 / p67 / p68 | hurt flash, hurt sound, heart health on entering the stage (100 / 80 / 60 %) |
| p69 On / p72 Enable / p73 Disable | activate / pull-in (slot-5 attack, fires p74) / release |
| p76 / p77 / p78 | Died / appear (Enable) / vanish (Disable) outputs |

Slots: 0 melee (0..6 / 6..12.5 m), 2 three-limb strike (4..20 m, +-10 degrees), 3 three fireballs
(12.5..20 m), 4 a teleport missile (20..100 m) whose Teleport Effect puts the player on the
shooter's Teleport Pad (about 6 m in front of it) and sends it Enable, 5 the pull-in follow-up.
After an attack it taunts or attacks again; on the retreat timer it sinks (p51), waits p44..p45 s
and hands over to a random other one, never the one nearest the player. Breaking the heart moves
every Black One to the next stage (heart back at p68 %); on the last stage the holder plays p53 and
fires p76 Died. Level: Relay #1087 -> #a85 On -> #822 starts it; p77 / p78 switch each one's
invisible blockers; Triggered -> Relay #c78 (blur, fader, shake, slow motion); Died -> Relay #b25
-> Timer #12a8 -> Timer #12c8 -> the reputation's ending relay (b3d / b3c / b3b) -> movie b39 /
b26 / b3a -> STOMP 108d -> boat sequence -> picture -> GUI Launcher 123c Game Finished (docs/
campaign.md §5). Port [inferred]: every hit on the holder counts for the heart (the original only
counts hits on the heart mesh); blows land at the clip's Arm markers when the player is in the
attack's range (+1 m); bounds are a 7 m pillar (the rig's bind pose lies below its origin).

**Saved state** [verified: vtable `0x10152d90`, +0x34 `0x1006e3e0` writes, +0x30 `0x1006e340`
reads]. After the PhysicalObject base (`0x1009b480`) and three components (+0x72, +0xb6, +0x1ac):
u32 +0x4a the chosen attack (-1 none) and +0x4e its template, f32 +0x5a the hand-over wait, +0x5e /
+0x62 the near / far retreat timers, +0x66 the hurt flash, u32 +0x6a the state (0..7) and u32
+0x6e the flags (bit 1 active, set by On; bit 2 pull-in; bit 4). The heart is its own Breakable
(health saved with it); the stage is the object's current template. Port (`BlackOne.save / load`,
'actors.specials'): each one's state, retreat timers, hand-over wait, pull / exclude, and the
shared fight (stage, heart, vulnerable, holder, done); applied on the first frame after the load.
A state in the middle of a clip resumes at its stable point (appear / attack / taunt: the fight
with a new attack; retreat: the hand-over wait; a broken heart: the stage change) [port]. Before,
'actors.specials' had no entry for them and a capture taken after "Camera" 1082 restored the four
asleep: the boss never woke. The level has no checkpoint after Autosave d29, so only a manual save
(or the harness's capture) restores mid-boss.

#### 15.7.12 Hermes: gas body and fades (fx/body-parts.ts, fx/attachments.ts)

Hermes (class Hermes, template 10:628, model 10:92) looks gaseous through three things the data
sets up: gas emitters on his bones, a partial opacity, and fades.

- **Gas on the bones [verified data].** Both placed Hermes (1a #84ff, 1b #7eb4) override the
  body-part pair p54 / p55 with six Object Generators: 3:3309 on bones 35 / 7 / 1 (right
  shoulder, left shoulder, pelvis) and 3:3311 on bones 16 / 44 / 29 (left hand, right hand,
  head). Each generator spawns its two Particle Fountains once (p6 = 2): 3:3308 / 3:3310 (14
  puffs/s, 0.3..0.5 s, 0.15 -> 1 m) and 3:3312 / 3:3313 (9/s, 0.15..0.25 s, 0.15 -> 0.75 m). All
  are alpha-blended (p46 = 1), coloured 0x819c56, use texture 4:1935 (a faint puff, alpha at
  most 42/255), emit from a 1 m disc and have p10 = 0 (they never stop on their own). The
  template's own set is p54 = [35, 7, 1, 0] with fountains 3:2635 x 3 and 3:3272 on bone 0.
- **Who spawns them [verified].** p56 = 0, so the Character constructor (0x100e52c6, set
  0x10095d10) does not spawn this set at creation. The Character message handler (0x100e3ab0,
  reached through the catch-all 0x100e1e20 for anything the behaviour stack does not take)
  does: message 154 SpawnAttachments spawns every p54 / p55 pair (0x10096710); clip event 151
  SpawnItem on bone b spawns the first pair whose index is b (0x10096c00 -> 0x10096870; it tries
  the hand-weapon pair p51 / p52 first, 0x10096be0); 152 DestroyItem destroys what is attached
  at bone b (0x10096b80 -> 0x10096ab0). In 1a the scene STOMP 12:283 (relay #8acb, which also
  sends On) gives Hermes 154 at its start; in 1b the scene STOMP 12:247 sends 154, then 206 /
  207 (fade in) [verified data]. While a Character is hidden its set is hidden too (0x100e1a6c ->
  0x10095260) [verified].
- **Attached gas follows him [verified].** An Object Generator with a Follower Object template
  (p25; 3:2756 here) puts what it spawns on a follower that tracks the generator or its parent
  (0x100b4810); the generator's destructor destroys the fountains it spawned through their p52
  Destroy message (0x100b49e0, under a flag of +0xc not traced). So the puffs keep coming from
  the moving bone until a DestroyItem or his removal takes the generator away.
- **Clip events [verified data].** Only Hermes' animation set (261) carries fade events. The
  disappear clips put gas on him while he fades out and drop the bone-0 item; the appear clips do
  the reverse: 10:1733 (CeilingFloorTransition p5) StartFadeOut 0.17, SpawnItem bone 1 0.19,
  StopFadeOut 0.69, DestroyItem bone 0 1.01; 10:1732 (p4) SpawnItem bone 0 0.00, StartFadeIn 0.42,
  StopFadeIn 0.86, DestroyItem bone 1 1.09; 10:751 / 10:1570 spawn bones 1 / 7 / 35 as he fades out,
  10:970 destroys them after he fades in. With the placed instances' sets, bone 0 holds nothing.
- **Fader [verified].** A Character carries a fader at +0x562 (0x100ac2e0..0x100ac630), stepped by
  dt from the Character update (0x100e5947). Opacity = from + (to - from) x (sin((t - 0.5) pi) +
  1) / 2 with t = elapsed / duration clamped to 0..1, reversed for a fade-out. 206 / 208 set
  fade-in / fade-out and restart it; the duration is the time of the matching 207 / 209 event in
  the clip channel 0 is playing, or that clip's length when it has none [inferred: clip +0x28 is
  the length], minus the clip's current time (0x100ac400). 207 / 209 jump to the end. 206 also
  fires the Character's output p34 (0x100e3d99). The value goes to the engine object's opacity
  (SUFFERING.EXE vt +0x130 = 0x457410: object +0xd0, also passed to its attached objects).
  Default range 0..1, not applied until a fade. Hermes (vt +0xc 0x10076be0) sets from = p180 /
  100, to = p181 / 100 and applies the end of a fade-in (p182 != 0) or fade-out (p182 = 0) at
  creation: 1a's Hermes (p180 0, p181 85, p182 1) is drawn at 85 %, 1b's (p182 0) is invisible
  until the scene fades him in.
- **What opacity does to his skin [verified].** The pass setup (0x48fab0) multiplies a tinted
  layer's TFACTOR alpha by the object's +0xd0 (0x48fcdf). Hermes' passes are tinted additive
  (SRCALPHA, ONE), so 85 % opacity scales the glow he adds to 85 % (§16).
- **Port.** fx/body-parts.ts runs the clip events (main clip, [t0, t1) window, wrapped for loops),
  link / STOMP messages 154 / 206..209 and the fader; the opacity goes to per-actor copies of his
  materials, and additive surface passes scale their premultiplied colour by the material opacity
  (surface-material.ts). fx/attachments.ts `spawnParts` / `removeAt` build the set; spawned
  fountains are owned by it (world/fx.ts `SpawnContext.owner`), follow the bone when the generator
  has p25, pause while he is hidden and stop when he is removed. Scope [port]: Hermes only
  (`BODY_PART_CLASSES`) and effect classes only (Object Generator, Particle Fountain); the hand
  pair p51 / p52 is not tried. Not wired yet, though the same rules decide them: SpawnItem effects
  in Fester (10:401 / 10:408 / 10:413 / 10:904), Mainliner (10:278 / 10:279 / 10:1686 / 10:1687),
  Slayer (10:1390 / 10:1554), Burrower (10:1459, a 154) and Killjoy (10:510) clips, and the p56
  creation sets (the CartWheelers' four gas generators). Whether particles take the carrier's
  opacity is not known; the port leaves them unfaded (1b's gas shows before he fades in)
  [inferred]. Verified in the browser: 1a after the scene relay, six sets with two following
  fountains each; 1b after STOMP 7f41, 154 -> 206 -> 207 and opacity 0 -> 0.85.

#### 15.7.13 Rat: the leap and the single bite (rat.ts)

[verified: Rat behaviour slots 0x100854b0, behaviour factory 0x10107e00 (kinds 0x43 / 0x44),
RatKillObjectBehavior runtime vtable 0x10158768 (start 0x10085f50, update 0x10086000, child events
0x10085dd0), RatJumpAttackBehavior 0x101587c8 (start 0x100863f0, update 0x100869b0, child events
0x100861b0, latch 0x10086500), Rat death vt+0x128 0x10085c80]

- A Rat holds no Melee Weapon and has no MeleeAttackBehavior. Its KillEnemies (10:516, p15 null)
  asks the character for its kill-object behaviour: the Rat answers kind 0x44 with its p182
  (RatKillObjectBehavior 10:518) and kind 0x43 with p181 (RatJumpAttackBehavior 10:519).
- **RatKillObject** starts a MoveTo after the target that stops 0.25 m short (512 engine units).
  Every frame, the target alive and no leap running, it starts the leap when the 3D distance
  between the two positions is at most p2 m (4) and the horizontal way to the target is within
  p3 degrees (20) of the rat's facing (dot >= cos p3). The MoveTo reaching the target also starts
  the leap. The leap's end (child event 0x43) only plays the p178 sound: the MoveTo is not started
  again and the kill object does not complete, so a rat that missed waits where it landed until
  the target is in front of it within p2 again (KillEnemies p12 = -1 never picks again).
- **RatJumpAttack** plays the leap clip p2 (10:420: 0.83 s, its root carries the body 7.3 m forward
  on an arc 1.56 m high). Every frame it walks its mover's contacts (0x10086a20..0x10086b5e).
  A contact that is a live Character (object type 7) or the Player (class 0xc8bc44e1) sets the
  leap's touched flag (+0x70 bit 0x80000). Only a Player contact goes on to the hit-sphere test
  (0x10001330 answers the Player alone): the Player whose hit sphere a rat sphere overlaps is
  latched, a p5 Follower Object on that sphere carries the rat, he takes p4 (10) damage once
  (TakeDamage, vt+0x58) and the chew clip p3 (10:422, 1.2 s) plays. With the flag set and no
  bite, the update ends the behaviour (0x100973e0(1, 0), the same end as a leap clip that ends
  without a touch); the end (vt[19] 0x100862e0) clears the flag. So **a rat never hurts another
  character**: a leap at Clem, the 1c inmate or Dallas stops on his body and the rat waits or
  leaps again as after any miss. When it ends the rat dies (vt+0x128; the player's credit only when he was the killer and
  the p116 / p117 effect [inferred from the call shapes]) and the follower goes. A leap clip that ends without a touch ends the
  behaviour.
- So a rat hurts once, 10, only the player, and only by landing its leap. Before this the port played the leap and
  chew clips as a melee attack repeating 4-damage bites [guess], and a rat that missed chased
  again: the 1b sewer swarm (60 rats, Object Cloners 7ee2 / 7eea / 7ef5 / 7f02, 15 each) killed the player
  in seconds wherever he went; about 30 of them killed Clem on 6b's beach within 10 s of the first
  Fester wave (the guessed bite against characters). Port: the rat works on its KillEnemies
  target, the player or a character (`params.fightTarget`); the touch is the rat's body sphere
  against env.hitSpheres; a mover contact with a character is the two bodies' cylinders meeting
  while the leap moves toward him (bodies only push softly apart in the port, so a body the rat
  already overlapped when it leapt does not count: a swarm overlaps); the latched rat
  keeps its touch offset from the player, turned with him [port]. A player contact without a
  sphere overlap is not modelled. The Rat's clip attacks deal nothing (`kinds.ts`).

### 15.8 Dormancy and the attack stimulus [verified unless marked]

DormantBehavior lives at 0x100ec8f0 (start), 0x100ecb00 (update), 0x100ecdf0 (event handler)
and 0x100ecc60 (end) in Suffering.rfl. Behaviour properties are read through the behaviour's
property table (`call 0x10097b80`, then `[table+8](index, -1)`).

- Start: mode p2 = 0 ends the behaviour at once; 1 plays p5 through the character's animation
  controller and sets "shown"; 2 switches the character off (`vt[0x128](0)`: hidden and inert).
  p3 = 0 also flags the character while it sleeps (cleared again at the end) [what the flag
  does is not read]; p4 ≠ 0 asks the update to call the "appear when there is room" helper
  (0x100e1f50) [unused in chapter 1].
- Event handler: an event whose type equals p12 wakes it; so does event 0x2001 when p6 ≠ 0. No
  test of distance or sight. Waking plays p7 when set (as a sub-behaviour, p9 picks its mode),
  then the behaviour ends and the character takes its next one (p69).
- Event 0x2001 is the attack stimulus: the Character damage code (around 0x100e7840) builds it
  from the damage message (attacker, the attack's InvestigateSound) and sends it to the victim;
  attack behaviours send it too. A switched-off character (mode 2) still receives 0x2001 and
  0x2003 and nothing else (0x100e1e20).

So a dormant character wakes only when the level logic sends its message (Behavior Changer,
Detector, Relay, STOMP message key, Object Cloner) or, with p6 set, when it is attacked. Retail
data: every CartWheeler / Slayer / Mainliner template has p6 = 1; Horace, the Noosemen and the
Killjoy have p6 = 0 (they ignore hits while asleep). The old reading "p6 = 0 wakes on sight"
was the wrong way round; nothing wakes on sight.

Port (`behaviors.ts`, `actor.ts`): `wakeMessage` / `wakeOnAttack` / `wakeClip`; Actor.damage
wakes a p6 sleeper and leaves a p6 = 0 sleeper asleep (it takes the damage but neither wakes
nor fights back); manager.receive wakes on the p12 message. A woken actor waits for the p7
clip before its next behaviour.

**1a, the creature in the crucified inmate's cell.** The creature a player meets in the first
room after the intro is CartWheeler 0x8916 (tpl 10:24, model 10:2, track "Carthweeler" #48 of
the intro "Goose", sequence 12:284, STOMP Player 0x7509). It is placed in the off-map staging
area (272.0, 97.7, 318.6) with the intro's stand-ins (door guard, row guards, chair, shoes);
the sequence moves it through the cells and lands it in Floyd's cell (404.24, 97.68, 520.43) at
190.14 s, the cell whose back wall shows the crucified inmate 0x7b38. Its track has only
transform and clip keys - no control keys, no message key (no On) - and no level object links
to it. Its initial behaviour is DormantBehavior 10:104 (mode 1, clip 10:1, p6 = 1, p12 = 1). The
track carries flag 0x08 (TRACK_REMOVE_AT_END, decoded by the sequence work in
`src/game/world/stomp.ts` from SUFFERING.EXE 0x44f4ed / 0x4512c0): the original removes it when
the intro finishes. Before that flag was honoured the port left it behind in Floyd's cell,
dormant and silent forever - the "motionless first enemy". It is not an enemy of the level:
the first Slayer the player fights is CartWheeler 0x6207 in the "Cartwheeler" scene (12:253,
STOMP Player 0x5dac): control is handed back at 14.50 s and its own On key at 14.51 s wakes it
into HostilityBehavior 10:130; its death unlocks the "Slayer" archive page (Archives Trigger
0x8a01). The 1a Aim Controller statics (§15.3) are the caged creatures that only turn.

### 15.9 AI noise and hearing (InvestigateSound, InvestigateBehavior)

**Noise list [verified].** `0x100e2e60(x, y, z, source, sound)` appends a noise to a global list
(0x1017bdb4, 24 bytes each, life 2); `0x100e2ef0` ages the list once per frame and the getter
`0x100e21e0` only returns entries in their last tick - a noise is heard during one AI tick.
Emitters: footsteps (Material Effects entry p7 at the character's feet, except FootStep_Sneak;
0x100b04a0) and the other `call 0x100e2e60` sites (shots, impacts, explosions) [the latter
inferred from the data below].

**InvestigateSound** (System, 2 properties) [data]: p0 radius (m), p1 level. Retail templates:
2:446 12.5 m / 0 (player footsteps, Player Material Effects p7), 2:443 20 m / 0 (NPC
footsteps), 2:441 27 m / 2 (bullet shots, Missile p16), 2:442 20 m / 1 (bullet impacts, Missile
p14 and Missile Material Effects p2), 2:447 35 m / 2, 2:448 15 m / 1, 2:449 50 m / 3
(explosions), 2:450 30 m / 2, 2:451 20 m / 1; Player Weapon Properties name several.

**Listeners [verified]:** only InvestigateBehavior polls the list (its update 0x100eeec0; the
filter 0x100ed680), and only a ListenBehavior (type 0x2e) starts it (0x100ea9b0). Listen itself is
started by a HostilityBehavior (start 0x100f7880, re-arm 0x100f7950) and by a WaypointBehavior
whose p4 is set (0x100e8790), nothing else: a character fleeing, talking, idling, playing a root
animation, on a KillEnemies root or a WaypointBehavior with p4 = 0 hears nothing; a follower hears
through its waiting Hostility (FollowBehavior p3 = 1) and not while it runs to the leader. A noise is taken when its level ≥ p4 and ≥ the level of the noise already
being followed up, and the squared distance ≤ (radius + p2)²; the event 0x2001 (an attack) is
fed through the same filter (0x100ed860). Characters name their InvestigateBehavior in p97:
the Unspeakable NPC templates (guards, prisoners: 10:171 p2 = 1, p4 = 1, p7 = 10), the Slayer
class (10:528) and the Burrower (10:1251 p2 = 2). CartWheelers, Mainliners, Festers and
Noosemen have none: noises do not draw them (they fight what they see and who hits them).
With p4 = 1 on every retail template, footsteps (level 0) never alert anyone.

Port: `services.actors.noise(at, sound, source)` (an InvestigateSound ref or `{radius, level}`);
the manager keeps the noises of one frame for the next AI tick (`env.noises`, debug
`__actors.manager.noiseLog`). Emitters: `fx/footsteps.ts` (entry p7), `weapons/system.ts` (the
player's Missile p16 at the muzzle, p14 at a wall hit), `actor.ts fire()` (an NPC's Missile
p16), Sound Effect p8 / BouncingObject p64 (never set in retail data; docs/re/object-model.md
§9). A listener that hears a noise and sees no enemy walks to it (runs for level ≥ 2), then
looks around for p7 s [guess on the look-around]; seeing an enemy ends it. Noises from its own
team are ignored [guess]. Only roots with a Listen hear (`behaviors.ts rootListens`); before,
every character with a p97 heard: 1c's companion took up gunshots while on his FleeBehavior
(`investigate:` in a browser probe), which walks him to the noise, that is to the fight.

**Sight and shots through see-through surfaces (port).** NPC sight lines (`perceive`) and the
line-of-fire test of NPC shots use `sight.ts sightBlocked` with `WorldService.seeThrough`: cut-out
bars, grates, chain-link and blended glass are looked and shot through, solid walls are not.
Walking still needs a clear line (a creature that sees the player through cell bars paths
around through the nav graph). The player's bullets pass the same surfaces
(`weapons/system.ts` solid-hit test) and `services.actors.raycast` ignores them when testing
level geometry in front of an actor.

### 15.10 Followers and companions

**FollowBehavior** [verified unless marked: start 0x100ed480, update 0x100f03a0, child events
0x100eeb30, message handler 0x100ed550; the waiting child 0x100ea6c0 / 0x100ea7a0, the path test
0x100ea610 -> 0x1011e350, the step aside 0x100ee710, the re-check delay 0x100e8930]. Its start
(vtable slot +0x18; the slot that takes parameters fails at once, 0x10101520) resolves p2 into the
leader (1 on every placed instance: the player [inferred]) and starts the **waiting child**: p3 =
1 a HostilityBehavior (with the leader as its Listen anchor), p3 = 0 an IdleBehavior. Then:

- **The path check.** At once and then every (rand / 32767 + 1) x 0.5 = 0.5..1 s while it waits,
  a FindPath to the leader. Found: the path's length (its legs summed) is compared with the
  working length W: p5, or p6 while its Hostility has a target (Hostility child event 5 when its
  KillEnemies picks one, 6 when that KillEnemies ends without one; 0x100f7a30). Longer than W:
  it has to run. Not found: a BeckonBehavior (a LookAt on the leader over an Idle, 0x100ea8f0)
  is added beside the waiting child, and the check goes on.
- **The run.** Once it has to run and no attack of its own is under way (0x10097780: a child
  anywhere down the stack whose "busy" word is set; ProjectileAttack sets it at its start,
  0x100fee00), the waiting child stops (so does its fight) and a MoveTo follows the found path
  in movement mode 3 (run) with p4 x 2048 as the request's distance (+0x1c, the field Waypoint p2
  fills; read as the arrival distance [inferred]). Arrived: the waiting child starts
  again and the check is due in 0.5..1 s. The MoveTo failing: Beckon, then the check.
- **Out of the way.** While it waits without a target, with nothing else running and not on a
  ladder: a leader within 2 m (3D) who moves with his line of motion through the follower's
  body (its radius either side of it, the two side points on different sides of the line) and
  towards it makes it stop waiting and step across the line, its radius + 0.5 m, for
  U(0, 0.5) + 2.5 s; the same for the player when the leader is someone else in the same
  zone. Message 0x2015 (GetOutOfWay) does the same.
- **Ending.** The leader gone or dead: done (code 1). Farther than p7 x 2048 (3D, p7 > 0): fails
  (code 2). FollowBehavior itself never fights: 0x2001 goes to the waiting Hostility, whose
  KillEnemies scores the attacker through the damage memory (§15.15).

So a follower hangs back: with 10:288 (p3 1, p4 7, p5 10, p6 20, every level-2 FollowBehavior of
the companion 868) it stands and fights where it is until the way to the player is longer than
10 m (20 m while it has a target), then runs to 7 m from where the player was, not shooting on the
way. Retail: 2 Cellblocks 7 (the inmate 0x868 reaches them from conversations, waypoint walks
and a KillEnemiesBehavior), 6b 1, 9 1; templates 10:288 and 10:1023 (p3 1, p4 4, p5 6.5, p6 20).

Port (`follow.ts`, `actor.ts runFollow / wayLength`): as above; the path length is the straight
distance when the body can walk it, else the Move Node path (none for the walker's type: no
path); a run that comes no closer for 3 s fails [port: when MoveTo fails is not decoded]; while
waiting with a target it fights as any NPC does (`updateCombat`, §15.11); the target choice runs
only while it waits with p3 = 1. Before, the port kept the companion within 2 m of the player
(walking after him, running beyond p5 / 2) and shooting from there, so he stood in the player's
fights; a hit gave him a grudge on the attacker.

**What else keeps a companion alive** (looked for in Suffering.rfl for 1c's 7569 / 2's 868, both
Unspeakable NPC template 10:391):

- **Health** 100, no Difficulty Modifier (GameObject p2 empty): 100 on every difficulty, where the
  creatures get x1.6 on Medium (10:238) [verified: data, 0x100a2a90].
- **Damage taken is not scaled** for allies or by difficulty [verified: Character damage
  0x100e7390, GameObject damage 0x100a31b0, health 0x100e42e0 / 0x100a1e70]. The only factors:
  the Damage Resistances in the attachments (p7: 2:839 / 2:933 / 2:928, gas types), the player's
  own damage multiplier (Player p78 / p79, applied when the attacker is the Player class
  0xc8bc44e1), no damage when the attacker and the victim are both on the player's team (the
  companion is on the prisoners' team 10:212, the player on 2:384), and none from a same-team
  melee blow (type 2).
- **Invulnerability**: GameObject +0x1e (p3 at init, messages p13 / p14 = 90 / 91). 1c's inmate is
  invulnerable only in his cell (Waypoint 756a sends 91); nothing in 1c or 2 sends 90 to him later
  [verified: data]. A second flag (+0xe) keeps health at 1 at least (0x100a1e70); only the
  Player's code sets it (0x1002d590, the god cheat) [verified: its only writers].
- **Regeneration: Character p161** [verified]. Every frame the Character update (`0x100e58d0`)
  calls its vtable +0x90 (`0x100e1410`, in every character class's vtable): while p161 > 0 and
  the character is not dead (`0x100a1ad0`: health above 0, or invulnerable / god), health += p161 x
  the frame time, through the health setter (`0x100a2d00`), which caps it at the maximum. Retail
  p161 > 0 only on the companions' templates, all 4 a second: 10:391 (1c's inmate, 2's Dallas),
  10:1234 (3a / 3b), 10:642 (Clem, 6a / 6b / 7), 10:988 (8a / 8b), 10:1020 (the guard bc9 / 7b8 of
  9 / 10, and copies in 0 / 1a). The Player's p161 (220) is his Move turn rate (another class).
  So a companion at 100 health is back to full 25 s after a fight; the earlier "none found"
  missed this vtable slot. Port: `actor.ts regenerate`, every frame for every placed character
  (asleep or not: the original updates them all), from the manager's loop. This was the missing
  piece of "the companion dies in every run": 9's guard took 11..15 a hit from the Infernas'
  bursts and never healed (docs/playthrough.md row 9-13).
- **When a companion dies anyway** [verified: data]. No class code reacts to a companion's death
  (no game-over or reload rule: the Character death `0x100e2620` only fires p28 / p29). The level
  logic decides: 10 wires 7b8's death into the Count Downs his scenes wait on (Relays 112b -> 882:
  the bus scene's Detectors a68 / 137a; 112d -> 112c: the pipe-yard fires, Relay 924), so parts
  of 10 go on without him (whether all of it does was not checked). 9 does not: bc9's death enables only
  the Autosave Detector 1a61 (Relays 1a63 -> 1a62), and Level Transition ca6 (enabled = 0) is
  enabled only by Relay 19e7 from his Waypoint e08, so with him dead 9 cannot be left, in the
  original as in the port.
- **Creatures' choice**: no preference for the player (§15.15): the companion's GameObject p4 0.5
  and p8 4 equal the player's; the creature KillEnemies templates list prisoners as enemies.
- **Scripted protection**: none. 2's Action Dialogs 1c77 / 1c78 on the companion count the
  player's hits: one counts when it comes p14 (3) s or more after the last one (a gap over p19,
  30 s, starts the count again; not while the warning below runs, 0x1008e1a7) [verified].
  - **A counted hit below p18 is a warning** (the update reads the dialog's flag 1:
    0x1008d4a0) [verified]: a random p16 line and, with a p17 **clip** (an Animation: 10:1575
    "step off" gesture, 2.4 s; 1c78 10:1475, 4.1 s) and the NPC not flagged +0x70 & 0x200, the
    AttackedByPlayer behaviour (type 0x7c, vtable 0x10157020) pushed over his stack: its
    children face the player (type 0xa) and play the clip with the line (type 0x78, vtable
    0x10156fc0; done when both are), then it ends and the stack goes on. Without p17 (6b's
    1574) only the line. It never fights: the earlier "[inferred] KillObject template" reading of
    p17 was wrong (p17 is typed Animation).
  - **The p18th counted hit turns him** (flag 4; update 0x1008dfba) [verified]: the dialog fires
    p30 (On) to its links, sets the NPC's speech level (+0x5c4) to p21, says a random p20 line
    and, with p23 = 1, destroys itself (0x1008daf0). The turn is the level logic's: 1c 7edc ->
    Relay 7ede -> Behavior Changer 7edd -> FleeBehavior 7ee0 (threats include the player
    2:384); 2's 1c77 -> Relay 1c7f -> 1c7b -> FleeBehavior 1c7c, and after Waypoint 903 1c78 ->
    Relay 1c82 -> 1c7d -> HostilityBehavior 1c7e (his KillEnemies 10:214 lists the player's team
    as an ally, so that is the end of the escort, not an attack); 6b's 1574 -> Behavior Changer
    1575 (HostilityBehavior 1576 with KillEnemies 10:213, whose enemies include 2:384: Clem
    attacks) and Relay 1577 (destroys the escort's Behavior Changers).
  - **Nobody on an ally team fights the player back**: a KillEnemies leaves an ally team's
    candidate out (0x100f9eb0), the player included. The port had given every hit NPC a grudge
    on the player even on an ally team ("AttackedByPlayer") and turned companions at the first
    hit (`behaviors.ts attackStartsFight` with an attached dialog) [fixed: `actor.ts damage`
    takes no grudge on an ally player; `director.ts dialogWarn / dialogTurn`].
  - Browser (frame strips in the report): 1c 7569 hit at 113.8 / 117.3 / 120.5 s: two warnings
    (a warning voice line with the gesture), the turn at the third
    (a second voice line, Relay 7ede), FleeBehavior 7ee0, no target, −5. 2's 868 (following):
    the same with 1c77 -> FleeBehavior 1c7c, −5. 6b's 49a (Clem): two warnings (lines only),
    no target until the turn, then HostilityBehavior 1576 with the player as his target.

**Companions carried through transitions** [data]: a Level Transition's p7 lists the carried
objects (1c → 2: the inmate 0x7569; 9 → 10 one). The target level has its own placed copy; the
Player Spawn Point the player arrives at names it in p4 and its Companion Spawn Point in p5
(2 "East Spawn" 0x11a6: p4 = [0x868], p5 = [0x1bf0]); the Companion Spawn Point passes its p0 (1)
to its links when the companion arrives (2: Timer 0x933 → Relay 0x33fe → Behavior Changer 0x86b,
the follower's first scene) [inferred from the wiring]. Port (`companions.ts`): the transition's
input records the carried characters (alive, health) in module scope; the next level moves the
arrival point's p4 copies to the p5 points with that health (a companion that died is removed
from the new level too [inferred]) and sends the spawn point's message once the world is up.
Loading a save never applies a carry. A transition without a spawn name (9 → 10: Level
Transition ca6) arrives at the Player Spawn Point for that level whose name is empty (10's 86d:
p4 [0x7b8], p5 [0x908]); the port used to match only named points, so 10 started without the
guard [verified data, test].

### 15.11 Shooting, and saved deaths

**NPCs stop to shoot** [verified, docs/re/animation.md §9 "NPC ranged attacks"]. An earlier
port played the guards' firing clip 10:35 as an upper-body layer over the walk because the clip
animates only spine and arms; that layering was not the original's. ProjectileAttack stops the
MovementAnim sub-behaviour and plays the Attack's aim pose (p4) and firing clip (p0) on the
whole body (channel 0): the guard stands, holds the aim pose until it faces the target, fires
at rate p1 ± p2, and repeats up to Attack p23 times (guards 6) with p21..p22 s (0.15..0.25) of
aim pose between the shots. Its parent behaviour (RangedCombatReposition / ShootFromPosition)
walks to a firing position first. Only the Mainliner's needle throw (Attack 10:210, p20 = 5)
holds its aim pose on a channel over its locomotion; its throw is whole-body too. Port:
`actor.ts startShoot / updateShoot`.

**Torque's weapon actions** are layered in the original [verified, docs/re/animation.md §9
"Player weapon actions"]: fire, reload, throw and draw play the held weapon's Player Weapon
Properties clips as independent layers on bones the PWP names (revolver: fire on bone 6, the
chest, plus bone 5, the spine; reload, throw, draw on bone 5), choosing the clip by the
locomotion's moving-aim set (p116 + 7k: five headings, each with its own run, aim-hold, fire and
throw clips; first-person and standing variants), and when standing they also play on the
whole body. Port: `PlayerBody.weaponAction` (player-body.ts), called from weapons/system.ts.

**Deaths and removals survive saves.** A save applied before the level's first frame (no
frame environment yet) used to leave a dead character with 0 health but alive, and the
first-frame init then started its behaviour again (a guard a script had killed stood up after
loading): such a character now dies silently in its first frame (`Actor.pendingDeath`).
Placed characters removed by the level logic (Destroy, sequence stand-ins) are listed in the
'actors' save (`removed`) and removed again on load. AI, dormancy and wake code never touch a
dead, removed or hidden character (wake / setBehavior return for the dead; hidden characters
skip the AI; a STOMP hand-back of a dead character keeps the script's last pose).

### 15.12 Damage, death and fighting back [verified unless marked]

Read in Suffering.rfl: the Character damage code 0x100e7390, the default message handler
0x100e3ab0 (vt 70), the attack-stimulus reaction 0x100e72c0 (vt 37) / 0x100e6480 (vt 72), the
behaviour runtimes' message handlers (vt 9, names from vt 11: Waypoint 0x100ea490, Stomp
0x100e9dc0, Dormant 0x100ecdf0, Idle 0x100ede20) and the behaviour type table (factory
0x10107e00, class -> type 0x10106d40: IdleBehavior 0, KillEnemies 8, Hostility 9, Dormant 0x1e,
Waypoint 0x1f, AttackedByPlayer 0x7c).

- **Damage on a character** always runs the GameObject damage (resistance, p15 Damaged when the
  result is positive, health down), also on a dead one. It records the attacker in a damage
  memory (0x100a3800: attacker, amount, type, time) and sends the victim the attack stimulus
  (event 0x2001). Messages go to the behaviour stack first (children before parents, 0x100975f0);
  one not consumed falls to the character's default handler, which for 0x2001 fires output p35
  when the attacker is the player and plays the hit reaction (vt 72). On a **dead** character the
  hit reaction only handles damage types 3 / 8 (explosion, Gonzo) with p117 set (a gib template;
  no chapter-1 NPC sets it); nothing restarts a behaviour. Negative damage on a dead character is
  Killjoy's resurrection (0x100e7700: p76 started). Event 0x2003 is the death (vt 66 = p72).
- **The death outputs** (0x100e2620): p28 is fired as an output, then p29 is sent as a message to
  the character's links (through their vt +0xc). 10 Docks' dark selves a48 / a46 have no p28 and
  end their waves only by p29 (19) into Relays a49 / a8c (`system.ts onDeath`; tests/lighthouse-docks).
- **Who fights back** is up to the root behaviour, because only a running KillEnemies reads the
  damage memory (target choice 0x100f3740 / 0x100fba00; also ShootFromPosition, Flee):
  - HostilityBehavior / KillEnemiesBehavior roots fight already (Hostility restarts a
    KillEnemies child on a timer, 0x100f35a5);
  - WaypointBehavior p3: the start sets the update's timer to 0 for p3 = 0, else -1; the timer
    running out starts a KillEnemies child (0x100f146c), again 0.5 s after one ends with p3 = 0
    (0x100f1054); the message handler starts one on 0x2001 when p3 = 1. So 0 fights while walking,
    1 once attacked, 2 never;
  - Idle (handles only 0x2015, GetOutOfWay), SimpleConversation, RootPlayAnim and Death do not
    handle 0x2001 and start no KillEnemies: an idling guard or prisoner takes the hit, plays the
    hit reaction and goes on idling;
  - DormantBehavior with p6 wakes on 0x2001 (does not consume it) and hands over to the p69
    behaviour the stack was built with (0x100973e0, 0x100e5170), whatever it is;
  - a Stomp root (a sequence holds the character) consumes 0x2001 and 0x2003: no reaction, no
    death while the sequence holds it;
  - an attached Action Dialog pushes AttackedByPlayer (0x1008d4a0 / 0x1008d5a1) on its NPC at a
    counted player's hit below its p18: the p17 clip and a p16 line, no fight (§15.10).
- **Vision figures.** 1a's and 1b's monster selves (Unspeakable NPC tpl 10:593, model 2:124,
  team 10:1133; 1a 7a78 / 7aa0 / 7aa8 / 7afe, 1b 7ea7) have an ordinary combat template
  (KillEnemies 10:1158 lists the player's team, 300 health, no invulnerability, p5 = 0, no
  Damage Resistance): what keeps them from fighting is their behaviour. They sleep in
  DormantBehavior 10:595 / 10:596 (p6 = 1), wake into IdleBehavior 10:594, and the Behavior
  Changers hand them WaypointBehaviors with p3 = 2 (1a 7a7b, 7b01); the last Waypoint's p0 = 12
  destroys them. Shooting one does damage (it can be killed) but never starts a fight.
- **Posed bodies.** Some bodies are NPCs, not corpses: 1a 781c / 782c / 782d / 782e / 788a,
  1b 8521, 1c 7831..7833 (guard tpl 10:3) have p69 = a mode-1 DormantBehavior (10:968 / 970 /
  974, p6 = 1) posing them on the floor, 1a 7f91 / 7cd0 / 78a9 likewise; 1a 8b32 sleeps hidden
  (10:329) with p69 = DeathBehavior 10:173 and is woken when 1a is re-entered from 1b. 1a 781c
  is killed by Breakable 6841's BlowUp when it is smashed.

Port (`behaviors.ts attackStartsFight`, `actor.ts damage / wake / update`, `manager.ts`):

- Fighting back (provoked, a grudge on the attacker) follows the table above. Port choices: hostile
  creature classes keep fighting back from passive roots (their class code, e.g. the Rat's, is
  not decoded) and the kind's plain default (no root behaviour) too. An attached Action Dialog
  no longer makes its NPC fight (§15.10), and no grudge is taken on the player by a character
  whose KillEnemies lists his team as an ally. A follower takes no grudge: its waiting
  Hostility picks the attacker by the target score (§15.10).
  Before, every hit made any actor fight its attacker: the posed guards stood up and shot, the
  vision monster self attacked the player, and an idling prisoner turned on a creature.
- wake() hands over to p69: a mode-1 DormantBehavior p69 poses the body again, a DeathBehavior
  p69 dies (nobody's kill). Before, a woken body with such a p69 got no behaviour at all and stood
  up as a neutral NPC. A p69 mode-2 DormantBehavior is not re-entered (port: Behavior Changers
  without a behaviour use wake()).
- A pose shows no hit reaction [inferred]: a body in its DormantBehavior pose, a DeathBehavior
  root, a character still holding the last pose of a sequence after the hand-back (1a #218).
- A sequence-driven character swallows the attack; one killed meanwhile dies at the hand-back
  and is saved dead.
- A DeathBehavior handed out by a Behavior Changer (or p69) is nobody's kill: kill reputation is
  paid in the damage code only (0x100e7519..0x100e75fa). Before, the port credited the player.
- A p68 DeathBehavior (5b's raisable CartWheelers) is a corpse from the first frame (before, it
  was alive with its p69 HostilityBehavior until its first AI tick).
- Dead actors: ActorManager.damage and Actor.damage return at once, wake / setBehavior / BlowUp
  do nothing, inCombat is false. Not modelled: p15 Damaged / p35 on a corpse (bullets pass through
  dead bodies in the port), gibs from p117, GameObject p5 / Damage Resistance on characters (only
  the specials and the fountain gas, fx/gas.ts, apply resistances).
- Where a blow came from becomes where the target was last seen only when the blow came from
  the current target (or there is none yet) [port]. Before, every gas tick (no attacker) set
  it to the gas tile's centre, so the chase turned back there 13 times a second and the 1a
  gas-chamber CartWheeler shuffled on the spot even without a hit reaction.
- Tests: `tests/actor-damage.test.ts`.

### 15.13 Hit reactions [verified unless marked]

Read in Suffering.rfl: the hit-reaction virtual 0x100e6480 (Character vt 72), the picker
0x1009e650, the list slots vt 64 / 65 / 66 (0x100e1c60 / 70 / 80 return 70 / 71 / 72; the
CartWheeler overrides vt 64 / 65 with 0x100722b0 / 0x10072180), the behaviour stack's answers
to message 0x2008 code 1 (HitReact 0x100efa30, MeleeAttack 0x10080290, Dodge 0x100f9a10,
LadderClimb 0x1010a6a0 / 0x10112490, MorphTransform 0x100f15a0, AttackedByPlayer 0x100ffcb0),
the interrupt tests 0x100e83f0 / 0x100e8430, and the damage record builder 0x10001190.
Code: `src/game/actors/hit-react.ts`, `actor.ts hitReact`; tests `tests/hit-react.test.ts`.

**What reaches the picker.** The damage code sends the attack stimulus (0x2001) for every blow
of 0 or more damage; behaviours that consume it stop everything here: Stomp (a sequence holds
the body), TransitAnim, a JumpBehavior before its launch, a CeilingFloorTransition in transit
(0x1010b060). Otherwise the default handler runs vt 72 with the damage record: the damage type
(+0x40), the attack template (+0x44), the Special Hit Reaction template (+0x48, default -1) and
**the amount the bands compare, which is the blow's impact force (+0x1c), not its damage**
[verified, corrected]: Character damage 0x100e7390 builds the stimulus from a copy of the record
(0x100e779b) whose force it multiplies by the matching Damage Resistance's **p2** (0x100e77e9,
the lookup 0x100a2950 the damage uses; the resistance's p5, when set, becomes the Special Hit
Reaction) or sets to 0 when no resistance matches and GameObject **p6** is set (0x100e7801); the
message 0x2001 carries the record at +0xe, and the hit reaction reads +0x2a = record +0x1c
(0x100e64b1 / 0x100e6536). The stimulus goes out when the damage after resistances is >= 0, so a
blow that does no damage still makes the character react by its force (0x100e776b). Force is
Missile p28..p29 over p30..p31 (revolver 6 -> 0, the shotgun pellet 20 -> 2), Melee Weapon p69 x
Attack p7, Radius Damage p2 at the centre to p3 at its edge, a Damage Action Object's p6. The
global resistance list (2:655 type 14, 2:464 type 6) has p2 = 0. Port (`fx/gas.ts
resistanceForceMultiplier`, `manager.ts damage`, `ActorBlow.react`, `DamageEvent.force` /
`minForce`): the player's bullets, melee and every Radius Damage pass their force; other sources
(NPC blows, hazards) give none and the reaction falls back to the damage as before.
Damage over time is one record per frame: a Particle Fountain's p18 x the frame time, a
Damage Action Object's p4 / 30, so the picker sees the per-frame share, not a sum.

**p11, the reaction's message** [verified: HitReact runtime vtable 0x10157bd0, start vt[7]
0x100ebd80 -> 0x100ebfa0]: a whole-body reaction (the behaviour is pushed, so its start runs)
sends its p11 to the character's links (`[0x1017bf54]->vt[3](handle, msg, 0)`, the send that
SimpleConversation p21 and Horace's p2 use). The only retail user is Hermes' 10:1228 (p4 1,
p11 Triggered): 8b's stove fight (Hermes' resistances 2:779 type 5 / 2:656 type 14 have p1 0 and
p2 1, he has p5 = p6 = 1: nothing hurts him, only fire and wind push him; docs/playthrough.md "8
Bluff"). Port: `HitReactDef.message`, `actor.ts startReaction`.

**Which reaction (0x1009e650).** Two lists of HitReactBehavior templates:

- p71 ("special") is looked at only when the blow carries a Special Hit Reaction or an attack
  template: the first entry whose p3 equals it (or whose p2 lists the attack) wins, whatever the
  amount. Carriers in the data: Radius Damage 4:282 and the grenade 4:280 (2:736, explosions),
  the Damage Action Object 4:415 p7 (2:545, electric arcs; verified: p7 goes into record
  +0x48), melee Attacks' p8 (2:439, 2:430, 2:440), the player's weapon properties 2:111.
- p70 by damage: walked in list order, the **last entry whose p4 <= amount** wins; the walk
  stops at the first p4 above the amount. A blow below the first entry's p4 plays nothing.
  p5 is the band's top (p5 < 0: the next entry's p4) and only scales the reaction:
  scale = (amount - p4) / (top - p4), at most 1.
- On a ceiling the CartWheeler reads p175 (alive) / p177 (dead) instead of p70 and p176
  instead of p71.

Retail tables (first p4 of p70): guards 10:3 2 (all whole-body), CartWheeler 10:24 2 / 4
(partial) then 7 / 10 / 15 (whole-body, 15 a knockdown), Mainliner 4, Nooseman 7, Burrower 12,
Fester 2, Slayer 7, Hermes 1 (immune to most damage anyway); Rat, Killjoy, Horace, Inferna have
no p70 list and never react.

**Who may refuse.** Before playing, message 0x2008 code 1 goes down the behaviour stack:

- a running HitReact by its own p6 mode (0x100e83f0), against the blow's whole points: 0 never
  interrupted, 1 only by a blow above its band's top, 2 by a blow at least its p4, 3 always.
  Down on the floor (knockdown) a blow restarts the down time instead, unless p28 is set and
  the mode lets it through;
- a MeleeAttack while its current Attack's p39 is 0: every retail melee Attack has p39 = 1, so
  attacks are interruptible;
- Dodge (unless the reaction has p22), LadderClimb while climbing, MorphTransform, and
  AttackedByPlayer for a blow below its threshold;
- nothing else: ProjectileAttack (shooting), KillEnemies, MoveTo, Waypoint, Idle and
  RootPlayAnim let reactions through.

**Two kinds of reaction.**

- p12 >= 0, a **partial-body flinch**: the clip plays on the subtree of bone p12 as an
  independent layer (play flag 8) and nothing else changes: no behaviour is pushed, the
  character keeps walking, chasing or attacking. With p13 >= 0 and an attacker, an attacker
  above bone p13 (character space) gets a p7 clip, otherwise p14 (attacker on the -x side) or
  p15 (+x side). A flinch still playing refuses a new one by the same p6 modes, compared with
  the new entry's p4 (0x100e8430). p16..p17 (percent) are stored with the flinch's length; the
  reader was not found [inferred: a slow-down; not modelled].
- p12 < 0, a **whole-body reaction**: the HitReactBehavior is pushed on the stack (vt 73), which
  pauses whatever ran under it. It plays a random p7 clip at a rate drawn from p8..p9; p10 turns
  the character to the attacker. p24 + (p25 - p24) x scale is handed over as the time down; the
  knockdown entries (CartWheeler 10:93, 10:136) fill p18..p23 [inferred roles from the clips:
  air loop, landing, lying pose, getting up, dying down, a twitch when hit while down].

**Damage over time.** None of the retail p70 bands starts below 1, so gas (13 / s, about 0.4 a
frame) and fire never make anyone react: the gas-chamber CartWheeler 64f6 keeps fighting in the
gas. Electricity does, through its Special Hit Reaction: an arc frame (2:545) picks the
CartWheeler's 10:648 (p6 = 0, never interrupted) every time the last one ends, so a CartWheeler
held by an arc is electrocuted for as long as it lasts; guards have no 2:545 entry and only take
the damage.

Port (`hit-react.ts`, `actor.ts hitReact / startFlinch / startReaction / updateReaction`,
`manager.ts profile`, `specials/cartwheeler.ts`):

- The profile carries p70 / p71 (instance values first). A profile without them (synthetic
  tests) keeps the old rule (the kind's hit clips). Before, every blow of any size played a hit
  clip and small hits skipped attacks: continuous damage stun-locked creatures, shooting guards
  could not be staggered, and no reaction ever played on a part of the body.
- `ActorHitInfo.frameAmount` carries the per-frame share of damage over time (the gas system
  deals whole points but passes p18 x dt), `special` the Special Hit Reaction (Damage Action
  Objects pass p7). Explosions and melee attacks do not pass theirs yet.
- Posed bodies, sequence actors, dead bodies: as §15.12 (no reaction). A falling or jumping
  actor takes none (Jump / Fall / CeilingFloorTransition swallow the stimulus [port mapping]).
  The CartWheeler special gates reactions while it lets go of / flies up to a ceiling and during
  its leap [port: the special drives the body there]; a whole-body reaction ends its flee or
  alert act.
- The CartWheeler's ceiling flinch (§15.7.5) picks from p175 / p176 the same way: from 5 damage
  (10:1259), not on every point; it no longer restarts on each blow while playing (mode 1), and
  it may cut the ceiling slash short (its Attack 10:143 has p39 = 1).
- Knockdown sequence [inferred]: p7, then p19, then p20 held for the time down (a blow while
  down plays p23 and starts the time again), then p21. The air loop p18 is skipped (the port
  does not launch the body). A whole-body reaction ends a partial flinch [port choice].

### 15.14 Fleeing: FleeBehavior and Flee Positions [verified unless marked]

Read in Suffering.rfl: the FleeBehavior vtable 0x10157640 (start 0x10111100, child done
0x10111220, update 0x10111340, message handler 0x101115b0), the choice 0x1010f3c0, the
threat / ally lists 0x1010e730, the Flee Position manager's scoring 0x100adaa0 with its threat
part 0x100ad620 and ally part 0x100ad810, the group flood fill 0x100ae480 and the failure stamp
0x100ae310. Code: `src/game/actors/flee.ts` (pure scoring), `actor.ts runFlee / fleePick /
fleeHit`; tests `tests/flee.test.ts`.

**Who counts.** Every living character other than the flee-er (the player included) whose team is
in p42 (or whose uid is in p43) is a threat; one whose team is in p44 is an ally. The 1c
companion's 7e38 / 7e3e (template 10:341): threats are the creature teams, allies the prisoners
and the player.

**Flee Positions.** Linked Flee Positions form a group: at level start the manager adds every
link the other way too (0x100ae370) and floods them (0x100ae480); a spot linked to none is in no
group (-1). 1c has two yard groups, 7e39 / 7e3b / 7e3c / 7e3d and 7e40..7e44, and 8037 alone. p0 > 0 limits the height difference from the character (m). A spot can be stamped
failed; it is left out for 7 s ([0x10154ebc]).

**The choice.** Each spot of the group (p22 set: the group of the first spot chosen), whose nav area matches the
character's (0x100ade21 compares the area ids the engine floods over the Move Node graph; port: a
path for this character must exist, see below) that is no more than p31 m away horizontally gets a score; the highest wins
(ties keep the first):

| Weight | Term |
|---|---|
| p23 | mean of d / p32 over the threats within p32 m of the spot (3D), 1 when none; **a threat closer than p33 m rules the spot out** |
| p24 | mean of 1 - d / p32 over the allies within p32 m of the spot, 0 when none |
| p25 | 1 - (horizontal distance to the spot) / p31 |
| p26 | the smallest 1 - cos² over the threats nearer to the character than the spot, cos taken between the way to the threat and the way to the spot (clamped at 0), 1 when none: running past a threat scores low |
| p27 | the same over allies, but its minimum starts at 0, so it always adds 0 |
| p28 | the spot it stands on (the one last reached) |
| p29 | the spot it was running to (only passed on the timed choice) |
| p34 / p35 / p36, p40 | terms around the object it flees from and the spot's own value (0x100ad9e0) [not decoded: every chapter-1 instance weighs them 0] |

1c's 7e38: p23 1, p24 1, p25 0.5, p26 1, p28 0.25, p31 40 m, p32 20 m, p33 8 m.

**The run.** Start (and every choice): with p2 set, no threat left ends the behaviour; with p10
set, a threat within p11 m after all were farther ends it. The chosen spot is run to (MoveTo,
arrival p12 m). A different spot starts a new run; the same one again (with p15 = 0) does not.
No spot: p13 ends it, else the character stands where it is. A run that fails stamps the spot and
chooses again. On arrival p15 (> 0) counts down and ends it at 0; otherwise the spot becomes the
one stood on and it chooses again at once. Then every p16..p17 s (0.4..0.8 in 1c) while it stands
(no child above Idle running) it chooses again, so a creature coming within p33 of its spot sends
it on. Standing, it also leaves the spot (stamped failed) when it takes p18 hits of p20 or more
within p19 s (the damage memory, 0x100a35a0) or one blow of p21 % of its max health (the attack
stimulus, 0x101115b0; 10 % = 10 health for the companion).

**NPC Exclusion Types on Move Nodes** [verified: mask builder 0x100d9bb0, node flags 0x100db7f5,
node test 0x100dbf30, path request 0x100dc070]. Move Node p2 lists NPC Exclusion Type templates
(their p0 is a bit, 0..30) and p3 says how: 1 = only characters of those types may use the node,
0 = characters of those types may not. A character's type is Character p45 (none: bit 31, so it
passes every p3 = 0 node and no p3 = 1 node). Chapter 1: 1a five p3 = 1 nodes (type 9) and one
p3 = 0 (type 2), 1b four p3 = 0 (type 1), 1c 7b71 / 7b72 (p3 = 1) and 7ee1 / 7ee2 (p3 = 0), all
type 5 = the companion's 10:674. In 1c that keeps him out of the east yard: 7ee1 - 7ee2 is the
way everyone else takes, 7b71 - 7b72 his own, off (EdgeToggler 7ee3 p0 = 0) until Count Down
7b95 (the first yard group dead) turns it on. Port: `nav.ts` (`navNodePasses`, `path(..., {
navType })`), the profile's `navType`; the flee choice leaves out spots he has no path to (the
original's MoveTo would fail there and stamp the spot).

Straight walks [inferred]: a character with a type does not walk straight through the area of a
node barred to it (its scale in metres + 0.3: `NavGraph.crossesExcluded`), nor straight to a goal its type
has no graph path to, nor straight where the graph's own way (types left aside) runs through a node
barred to it (`nav.ts shortcutBarred`); it takes the graph or stays (`actor.ts steer`, rechecked
each second; FollowBehavior's path length the same way). The last rule: following the player
through 2's door 85c, 4 m beside node 9bd, the companion walked into the steam-pipe yard his type
is kept out of (during his talk 312a, whose p5 walks him up to the player) and the yard's
Mainliners a5e / a60 killed him there. 2
Cellblocks bars the companion's 10:674 at both ends of the cell block (9b4, 9bd at the door to the
steam-pipe yard) and in the corridor behind door 3158 (a49): following the player to the switch
809 he walked straight past 9bd, from where no graph path leads back, and stood there for good;
from the other side of the hall his way is the cell e3 that the switch opens.

The port used to send the companion to the Flee Position farthest from the player and keep him
there: 7e3c at (448, 450), right under the wall CartWheelers 6520 / 6517 that drop when the
first group falls; they killed him there in every playthrough run (docs/playthrough.md). With
the flee as decoded but without the exclusion types he ran into the east yard (7e42, the best
score from mid-yard) and woke the second group early.

### 15.15 Target choice (KillEnemies, Hostility) [verified unless marked]

Read in Suffering.rfl: KillEnemies (vtable 0x10159088) init 0x100f7d40, update 0x100fd770 (first
pick 0x100fd670), message handler 0x100f9dd0, search 0x100fbdd0, candidate add 0x100f9eb0, choice
0x100fa1f0, sight test 0x100f39a0, line of sight vt 20 0x100f2570, set target 0x100f3900; the
character perception lists 0x100e0890 / 0x100e0960; the damage memory 0x100a3800 / 0x100a34f0 /
0x100a36c0; KillObject start / end 0x100fe810 / 0x100f3d00 (the attacker count); HostilityBehavior
(vtable 0x101567a0) start 0x100f7880, update 0x100f3520, child events 0x100f7a30, re-arm
0x100f7950. Behaviour types from the class table 0x10106d40 (KillObject 7, KillEnemies 8,
Hostility 9, Listen 0x2e, Flee 0x42). Code: `src/game/actors/targeting.ts` (pure rules),
`actor.ts perceive / chooseTarget / candidateOf`; tests `tests/targeting.test.ts`.

**Candidates.** The search takes every character in a ±p7 box on x / z around the chooser (the
engine keeps characters, the player among them, in lists sorted along x and z), plus the current
target and the p3 targets when they are not characters (a Breakable a KillEnemies lists). A
character that is the current target is not added on its own: outside the box it is dropped at the
next choice. The add step leaves out an ally team (p4), a dead object, a character running a
DormantBehavior, and the chooser itself. What is left must be the current target, a p3 target, of
an enemy team (p2), or targeting the chooser (its GameObject target handle). The sight test (range
p7, always-see radius p9, cone p11, no line of sight) must pass, except for the current target and,
with p5 set, a p3 target.

**Score** (fields set at init: +0x4e p16, +0x4a p17, +0x66 p18, +0x52 p19, +0x56 p20, +0x5a p21,
+0x5e p22, +0x6a p23, +0x62 p24, +0x6e p25, +0x72 p14):

| Term | |
|---|---|
| p23 x n / p8 | n = characters running a KillObject on it, the chooser not counted; its GameObject p8 |
| - 1000 | once n >= p8 (p8 = 4 on the player and every retail character) |
| - 1000 | on the recent-failure list (MoveTo failed; 5 x the re-pick interval) |
| p18 x (1 - d / p7) | d the 3D distance |
| p19 | the current target |
| p20 x (cos + 1) / 2 | cos between the chooser's facing and the way to it |
| p21 x its GameObject p4, p22 x health / max | p4 = 0.5 on the player and characters, 0.1 on rats |
| p24 x its share of the damage taken in the last p14 s | the damage memory; 0 when nothing hurt it |
| p25 | it targets the chooser |
| p16 / p17 | enemy team / p3 target |

**Choice.** Highest score first; the first that is seen through a clear line (sight test, then with
p6 a ray from the eye to a point a quarter up the candidate's bounds), is the current target, or is
a p3 target with p5 set wins. None: no target, and the KillEnemies completes.
Port (`actor.ts perceive`): a KillEnemies a Behavior Changer handed out completes on such a
choice and its chain goes on (6a: the stranger's 142c ends once the propane tank 1432 is gone,
Relay 2330 hands him 225b); the character's own default one keeps searching, as Hostility re-arms
it. The line of sight to an object target counts a hit on the target's own collision as reaching
it (the tank's centre lies inside its body).

**Timing.** The re-pick interval is rolled once per KillEnemies run: p12 > 0 gives max(p12, 0.5) +
U(0, p13) s, p12 = 0 every frame, p12 < 0 only the first pick (the 1a / 1b rats' 10:516 has p12
-1). Every frame the current target is dropped (and the next pick made at once) when it is farther
than p10 (3D), unless it is a p3 target chosen with p5; message 0x200e and message 0x2008 code 6
make it forget the target as well (the sender of the latter was not found). A new target restarts
the KillObject child; the same one keeps it.

**HostilityBehavior** (p69 of every creature template, p76 of every character): it starts its
KillEnemies child after U(0, 1/6) s. When that child completes without a target, it runs its
ListenBehavior child (InvestigateSound reactions) and starts the KillEnemies again after p3 + U(0,
1) x (p4 - p3) s. On its first engagement it installs its p2 sub-behaviour templates (CartWheeler
10:130: a fight MovementAnim 10:36 and MoveTo 10:37). Retail p3..p4: 0.4..0.7 (CartWheeler 10:130,
characters 10:131, Fester 10:372, Slayer 10:539, Burrower 10:271), 0.1..0.3 (Mainliner 10:183),
0.1..0.2 (Hermes 10:1176), 0.01 (Nooseman 10:220, rats 10:515).

**Retail KillEnemies templates** [data, all levels]. p16 10, p17 100, p19 1, p14 10, p5 1 on all;
p12 / p13 2 / 2 unless noted.

| Template | Who | p2 enemies | p4 allies | p18 | p20 | p23 | p24 | Other |
|---|---|---|---|---|---|---|---|---|
| 10:168 | guards | creatures 10:119, 10:178, 10:234, rats 10:624 | player, prisoners, guards, 10:1645 | 0.5 | 0.25 | -0.5 | 0.75 | p10 60 |
| 10:214 | prisoners (the 1c inmate) | the same + 10:1645 | player, guards, prisoners, 10:301 | 0.5 | 0.25 | -0.5 | 0.75 | |
| 10:102, 10:641, 10:1451, 10:153 | CartWheelers | player, guards, prisoners, Mainliner / Fester 10:178, 10:301 | none | 0.75 | 0.5 | -0.8 | 1 | 10:641 no line of sight; 10:153 p7 55 |
| 10:376 | Fester | player, guards, prisoners, CartWheelers, 10:301 | 10:178, rats | 0.75 | 0.5 | -0.8 | 1 | p9 20 |
| 10:190 | Mainliner | the same | none | 0.4 | 0.75 | -0.5 | 0.75 | p7 30 |
| 10:227 | Nooseman | guards, prisoners, player | 10:234, 10:178, 10:119 | 0.75 | 0.5 | -0.8 | 1 | p13 0 |
| 10:538 | Slayer | player, guards, prisoners, 10:301 | none | 0.75 | 0.5 | -0.8 | 1 | p9 7.5 |
| 10:263 | Burrower | player, guards, prisoners, 10:178 | none | 0.75 | 0.5 | -0.8 | 1 | p12 4, p13 1 |
| 10:516 | rats | player, guards, prisoners, CartWheelers, 10:301 | 10:178, rats | 0.75 | 0 | 0 | 0 | p12 -1 |
| 10:1158 | 1a / 1b creature-self visions | player, guards, prisoners, 10:178, 10:119 | none | 0.75 | 0.5 | -0.8 | 1 | p9 45, no LOS |
| 10:1291 | 1a creature-form visions | none | player | 1 | 1 | 1 | 1 | p16 1000, p21 / p22 / p25 1 |

So creature families fight each other (CartWheelers list the Mainliner / Fester team, Festers and
Mainliners list CartWheelers, rats list CartWheelers), and nobody prefers the player as such: the
nearer one, the one in front, the current target (+1, worth 60 m of distance to a CartWheeler) and
whoever hurt it win, and attention spreads because each attacker already on a target costs 0.2
(CartWheelers) and a fifth attacker joins only when nothing else is left. In the 1c yard a CartWheeler between the inmate
5 m away and the player 8 m away goes for the inmate; with two others on him it takes the player.

**Port.** `actor.ts perceive` drops a dead, hidden or out-of-keep-range target every perception
tick (0.15..0.25 s) and runs the choice when one was dropped, at the re-pick interval, and without a
target every Hostility p3..p4 s (other roots 0.5 s, the WaypointBehavior's restart of its
KillEnemies, 0x100f1054). Attackers are counted as the living characters in combat whose target it
is; the damage memory is the actor's own log of blows (player and characters). Port additions: a
passive root that fights back (§15.12, the grudge) counts its attacker as targeting it (never
the player when its KillEnemies lists his team as an ally: §15.10); the player's own target handle is not modelled
(only p25, 0 on every template, and the eligibility of a neutral team read it). Before, the port
picked the nearest candidate in sight and kept it.

### 15.16 Dismemberment: Part Caps [verified unless marked]

Read in Suffering.rfl: the blow 0x10119150 (called by the Character damage 0x100e76e1 and the
Player's 0x1002e036), the cut 0x10118dd0, the subtree walk 0x10118790, the bleed 0x10118680, the
cut by bone 0x10118fc0 (message 451 CapLimb, 0x100e3e19 / 0x1002d99b) and the created-cut list
0x10119690, the regrowth 0x101189e0 (from the resurrection 0x100eda49), the bleed's readers
0x1007ebc0 / 0x100ef7a8 / 0x100fc047 / 0x100415a0, the Player's death clip 0x1002e3f0, the dead
hit reaction 0x100e6480 -> 0x100e5d00 -> 0x100e2f70 (gibs); in SUFFERING.EXE the animator (request
flags 0x100000 / 0x200000 set / clear node flag 0x10, 0x470bc6 / 0x470bd9), the renderer's batch
mask (0x493698, 0x4cd447 -> 0x4914d0 / 0x4914a0 -> 0x4cc640) and the sphere tree (0x4271fd).
Code: `src/game/actors/dismember.ts`, `gibs.ts`; wiring `actors/system.ts`, `manager.ts`
(`partHit`, `corpseHit`, `cuttable`, `capLimb`), `actor.ts` (NPC blow hit points, `throwCorpse`,
the knockdown bleed-out), `player-body.ts` (killer death clips); tests `tests/dismember.test.ts`,
`tests/gibs.test.ts`.

- **Data.** Character p16 lists its **Part Caps** (class 0x627acba2, template-only): p0 cap
  model (a 2-bone skinned stump in the cut bone's frame), p1 the bone it caps, p2 bleed
  (damage / s added to the body), p3 grows back with Killjoy's resurrection (0x100eda49), p4 /
  p5 the corpse rule, p6 smallest blow, p7..p9 the chance, p10 most health %, p11 health
  weight, p12 what happens to a weapon on a capped bone (1 drop, 2 remove), p13 / p14 the
  damage-type rule, p15 attacker classes, p16 the stump's spurt generator (blood
  4:1279 for 15 s through Follower Object 4:1254), p17 the severed-part generator
  (BouncingObjects: the limb 3:590, five head chunks 3:611..615, blood fountains). Users: 29
  NPC templates, 4 CartWheeler, Burrower, Mainliner, Nooseman, Slayer, the Player (166 entries).
  Humans: head 48 (bleed 500, any blow of 3.9, 40..70 %), arms 10 / 12 / 30 / 32 (bleed 20,
  health <= 60 %, 35..70 %), torso 3 / 6 (bleed 500, not bullets 1 / axe 2 / fire 5 / shiv 10 /
  12), pelvis 55 (threshold 1e10, p13 0: never by a blow).
- **Created cut.** With Character p18 = 0 the p17 list is cut when it is created (0x100e1fb3 ->
  0x10119690 -> 0x10118fc0 with flag 0: no spurt, no part; the bleed is added): 108 placed bodies
  in 0 / 1a / 1b / 1c / 2 / 3a / 3b / 4a / 4b / 5a / 5b / 6a / 8a / 8b lie headless, armless or
  halved [data].
- **The blow** (0x10119150, after the health change and the kill reputation; for every blow,
  alive or dead, unless the character's +0x6c & 0x100 or +0x70 & 0x80 forbid it [which
  properties set them: not traced]): the struck hit sphere (damage record +0x20) gives its
  bone's channel (0x10085e50: model node +0x40); the first p16 cap whose p1 is that channel's
  bone is the candidate; the channel must not be cut yet (node flag 0x10, 0x1008b8e0). Then:
  amount > 0 and >= p6; health / max x 100 <= p10; p13 XOR (type in p14) = 1; p15 listed -> the
  attacker (record +0x24) must be a Character whose template's class is the class of one of the
  p15 templates (0x101193d5..0x101194ac compares class hashes; only Torque's caps list any:
  2:625 head [2:923 CartWheeler], 2:675 waist [2:922 Fester]); and rand() / 32767 x 100 below
  (p7 + (p9 - p7) min(amount / p8, 1)) x (p11 + (100 - p11)(p10 - health) / p10) / 100
  (retail p11 = 100: the health term is 1). A revolver round (6) takes a guard's head at 52 %.
- **The cut** (0x10118dd0): for the cut bone and its subtree, weapons on capped bones are
  dropped (p12 1) or removed (p12 2, or the bone was cut already) (0x10118790 -> 0x100e4dd0; no
  retail weapon sits on a capped bone); bleed += p2 (flag 2 cleared at 0); the Part Cap object is
  created at the hit bone's matrix and attached to the bone (world vt +4, character vt +0x18),
  its p16 / p17 generators with it; the animator (vt +0x34, request 0x100010) sets node flag
  0x10 on the bone's node and, walking the subtree (0x470f20), on every node below it, and its
  own state flag 0x4000000.
- **What node flag 0x10 does** (SUFFERING.EXE) [verified]: nothing to the pose (the bone
  matrices 0x4701c0 / 0x46ecd0 never read it). The renderer (draw 0x493698, shadow 0x4cd447),
  while the animator has 0x4000000, ORs for every channel whose bone's node is cut (0x4914d0)
  that channel's LOD word of the channel table's `bits` (0x4914a0) and skips the mesh's draw
  batches whose bit is set (draw 0x498ee3, shadow 0x4cc640: batch i when mask & 1 << i). On every rig with Part Caps
  the channels with a bit are the capped body segments (humans: chest 6 / 7, forearms 12 / 30,
  hands 14 / 32, neck 48, head 49, legs 55 / 60..62; CartWheelers 3 / 5 / 9 / 10 / 13 / 15 / 20
  / 23 / 27), so the cut bone's own segment and every segment below it vanish and the cap stands
  in for them. The hit-sphere tree skips spheres whose bone's node is cut (0x4271fd, 0x42908a,
  0x429264), animation events on a cut node are not dispatched (0x46d96a), and 0x1008b8e0 /
  0x4914d0 ("channel not cut") read it. When the attacker is the Player: flag 2, and on a body dead more than p4 s
  (0x100a1f20: now - death time) reputation += p5 (0x1011961f).
- **The bleed** (0x10118680, every Character update): while the body lives, bleed x frame time
  through its damage virtual, the attacker the Player when flag 2 is set (his kill: p166, p169),
  else the body itself. Every reader of +0x536 / +0x448 [verified: all accesses]: the Action
  Dialog does not count the player's hits meanwhile (0x10040d10); HitReactBehavior
  (0x100ef75c..0x100ef7ef) kills a knocked-down body at once when health <= bleed x the length of
  its get-up clip p21 (it dies on the floor instead of standing up); KillObjectBehavior
  (0x100fc020) starts no Dodge (type 0x38) / ProjectileBlock (0x21) and MainlinerKillObject
  (0x1007ebc0) no evasive move while bleeding; the Player (0x100415a0: alive and not bleeding) for
  two pickup classes. Nothing reads it for speed or anything else.
- **Regrowth** (0x100ed9c0, the resurrection Character vt 22 that Killjoy's RaiseDead ends with):
  health = p160 %, the bleed = 0 and flag 2 cleared (0x100eda37), then for every p16 cap with p3
  != 0 (counted by 0x10118930) 0x101189e0: when its channel is cut, the cap object attached to
  the bone is released and the bone gets request 0x200010 (node flag 0x10 cleared on the
  subtree): the segments show again. Caps with p3 0 stay cut. Retail p3 = 1: 10:94 / 10:973 (13),
  10:108 (9), 10:800 / 10:954 (3), 10:1545 (4), 10:1557 (1), 10:1558 (16), 10:1559 (6): the
  CartWheelers' and the 5b raisables' limbs.
- **CapLimb** (message 451, fixed input of the Character and the Player maps): `[+4] = 1` cuts
  the cap of bone `[+0xa]` (an animation event's bone), otherwise the whole p17 list. The only
  retail clip with the event is Torque's 2:562 (bones 11, 31, 48: his Part Caps 2:766 / 2:765 /
  2:770, whose p6 1e9 no blow reaches), his **death by a Slayer**: the Player's death
  (0x1002e3f0) plays the killer's clip, Mainliner p330 2:598, Slayer p332 2:562, Burrower p335
  2:606, Inferna p337 2:616 (Switch 9:2849 lists Interaction Properties 2:562, a different
  resource). **Creature-form finishers: none.** No
  creature-form clip carries 451; the creature's claws (damage type 8, 35 / 52.5) cut by the
  ordinary test: heads at any health, arms at 60 % or less, torsos too (type 8 is not in their
  p14) [verified: every .adu event list].
- **Torque's caps** (Player p16 = 2:766, 2:625, 2:770, 2:765, 2:675 on the Player's +0x448
  component; his damage 0x1002e036 runs the same blow test after the health change): a
  CartWheeler's blow on his head at 20 % health or less takes it (2:625: p6 1, 100 %, bleed 1000),
  a Fester's type-11 blow on his waist halves him (2:675: p13 0, types [11], 40..70 %, bleed 500);
  the arms and the other head cap only by the Slayer death clip's CapLimb events.
- **Gibs** (`gibs.ts`) [verified unless marked]: the attack stimulus (sent after the health
  change, before the Part Cap test) reaches the hit reaction vt 72 (0x100e6480); for a dead
  character (0x100a1ad0: health <= 0, so the killing blow too) with damage type 8 (Gonzogun, the
  creature's claws) or 3 (explosions) and p117 set it calls the death reaction vt +0x128
  (0x100e5d00) and nothing else. Type 3 with p112 set and the attacker known: the body is
  replaced by p112, a BouncingObject of its own model (guards 10:487, CartWheelers 10:99), its -Z
  from the attacker to the body raised to p114 degrees (30 / 10) when lower; the new object takes
  the body's cuts (request 0x100010 per cut p16 channel) and plays p113; it flies at p1 / 2048 =
  12.2 m/s, lives p12 = 5 s and bursts into p34 at its bone p35 (3:2834 at the guard's chest 6)
  [inferred: the throwables' fuse / detonation fields]. Otherwise (types 7 / 8, or 3 without
  p112) 0x100e30d0 -> 0x100e2f70 spawns p117 at bone p116's matrix (guards 3:2834 at 6,
  prisoners 3:2859 / 3:2845, CartWheelers 3:2966 / 3:2998 at 3). Either way the death outputs
  that have not fired go (p28 output, p29 message: flags +0x70 0x800 / 0x1000), then output p30,
  and the body is removed. 41 Character templates set p117 (the earlier note "no chapter-1 NPC
  sets it" was wrong).
- **Port** [inferred unless marked]: an NPC blade's blow carries the leaf it struck (the first in
  node index order that its sweep meets [verified], §15.5), a thrown missile's the leaf it met
  first; other blows pick the nearest posed leaf hit sphere to their point that is not on a cut
  bone. Companions' Part Caps (10:862 on Dallas, Clem, Jimmy, the 1c inmate) [data, checked
  again]: bone 48 (the rig's only head sphere: model 10:50 has no leaf on bone 49), p6 3.9, p7..p9
  40..70 % at 15, p10 100, p11 100, p13 1 with p14 empty (every damage type cuts), p15 empty
  (every attacker); nothing sets the cut gate's flags on them. In node order the pelvis, chest,
  forearms and hands come before the head, so a blade passing the head and the body strikes the
  body. A bone's channel is itself or the nearest ancestor in the channel table. The
  engine's draw batches are not decoded (they are not the file's material runs), so the port
  gives every triangle a segment (each corner's heaviest bone, up the tree to the nearest bit
  channel; the corners' majority) and drops the cut segments' triangles from the actor's own
  index (the vertex buffers stay shared); a rig without bit channels keeps the older stand-in
  (the cut bone's children scaled to nothing). What rides the cut bone and its subtree goes
  (hats, guns: `weapons/npc.ts` via `brokenParts`); the cap model rides the cut bone; the p17 generator is
  spawned at the cut bone thrown away from the attacker; the p16 spurt follows the bone. Shots
  stop at dead bodies with parts left (`raycast 'cuttable'`), and creature blows are swept
  against a body's leaf hit spheres when it is dead (`melee.ts sweepSpheres`; the living keep
  the standing capsule stand-in, §13.9), so corpses can be cut where a claw reaches them (the
  standing combo passes over a body on the floor: browser, 1a 7b36, five swings, no contact). Posed bodies (a DormantBehavior pose) do not bleed [port:
  their placed pose is kept]. NPC blows carry a hit point: the blade's contact from the sweep
  (`npc-melee.ts`, with the weapon's p70 type), a shot's point where the deflected round passes
  the aim point (`spreadShotPoint`, the same draw as `spreadShotHits`; type Missile p32), the aim
  point for blows without weapon spheres [port]; radius damage still cuts nothing. The thrown
  body is the actor itself (`throwCorpse`: its motor launched, p113 played, its cuts kept); blasts
  now reach corpses that have p117 (`world/damage.ts`), thrown from the blast's centre; the body is
  removed the frame after (outside the actors' loop) and the Part Cap test still sees the blow.
  Type 7 is left out [its users not traced]. The bleed-out on the floor deals the remaining
  health as the bleed (the player's kill when he cut it). Torque's cuts apply to the human body
  only (not while transformed) and are cleared when he is revived; his killer's death clip and
  its CapLimb events (`Dismemberment.schedule`) play through `PlayerBody.die(clip)`. Not ported:
  Dodge / ProjectileBlock and the Mainliner's evasion themselves (so their bleed gates have
  nothing to gate), the cut-node event skip (the port's NPC clip events are not per bone), the
  p12 weapon drop (no retail weapon sits on a capped bone). Cuts and the bleed are saved
  ('actors.parts').
- **Browser** (1a, frame strips in the report): the placed bodies lie cut (78f3 armless at the
  elbow with its stump); the stabbed inmate 7652 shot in the head (20, type 1): head gone, neck
  stump, blood spurt, head chunks, dead from the bleed (500 / s) within a frame; corpse 7b36 struck by a
  claw blow (35, type 8) is cut at the waist (cap 10:860, torso chunks fly) and the corpse rule
  pays −2.

### 15.17 Port option: enemies ignore the player (not in the original)

**What the original has** [verified]: the cheats are one object, Game Cheats (class 0x2b195280,
template 2:935). Its p0..p24 are the 25 typed cheat phrases (string refs), p25..p32 sound lists and
p33..p36 sounds. The dispatcher (Suffering.rfl `0x100013c0`, a 25-entry jump table at
`0x1000187c`) acts on the Player only: reputation -50 / +50 (`0x10041460`) or set to p70 / p71,
blood full (`0x1002b2d0`) and blood clear, health, suicide (a 100000 blow), weapons and items
(`0x100421c0` with 0..8), ammo for the weapon in hand (`0x10037f20`), grenades refilled to 8
(`0x1003a3a0`), two more Player state changes (`0x10042100`, `0x10033270`; insanity by their
cheat names [inferred]), one entry that runs five others, and two screen-effect toggles (Game
Cheats +0xd4 / +0xdc). None of them touches a creature, the KillEnemies candidate test or the
noise list, and neither executable has a debug variable for it (no "notarget"-like strings). So
there is nothing to mirror: the option is the port's own and is labelled so in the menu.

**What it does** (`src/game/port-options.ts`, `ActorEnv.ignorePlayer`, set every frame by
`actors/system.ts`):

- Target choice (§15.15): the player is never a candidate; a player target counts as gone, so a
  creature on him drops him at its next perception tick (0.15..0.25 s) and picks again (a
  companion, an inmate, another team). A grudge on him is forgotten; his hits give none and no
  last-seen point.
- Hearing (§15.9): noises with the player as source (steps, shots, impacts) are skipped.
- Specials: `fightTarget` returns nothing for a player target, so no CartWheeler leap or ceiling
  attack, Mainliner leap, rat leap, Fester charge, Burrower or Inferna attack starts on him.
  `PlayerHold.start` refuses (no Nooseman grab, no Mainliner ride); a Nooseman never drops for him;
  a ride, a strangle or a rat's chew under way lets go when the option comes on. An Inferna that
  loses its target mid-attack aims 5 m ahead of itself (`noTargetAim`), not at him. Horace fires no
  volley and his shots miss; the Black One chooses no attack.
- Unchanged: Detectors, Relays, sequences and every other piece of level logic; companions and
  creatures fight each other as usual; incidental damage still lands on him (a blade swept
  through him, a leap or charge aimed at someone else that touches him, Radius Damage blasts,
  gas, fire, traps). Level logic that waits for a creature to see him (the ISeeYou output p31,
  e.g. 8b's Hermes copies) does not fire while it is on.
- Menu: "Enemies Ignore Player" Off / On on both Gameplay pages (front end and pause menu), saved
  in the settings (`extra.ignorePlayer`), with a help line saying it is a port option and that
  stray damage still applies. The HUD shows "ENEMIES IGNORE PLAYER (port option)" at the top
  while it is on. `?ignorePlayer=1` / `=0` overrides the saved value for a page load;
  `tools/playthrough.mjs --ignore-player` passes it (testing only).

## 16. Materials and surface rendering [verified unless marked]

Materials are engine classes (SUFFERING.EXE, category 20). Each is an ordinary template
(§2.2): word 0 is the surface ("Material Type") template; the rest depend on the class. The
engine turns a material into up to 8 draw passes ("layers", 0x50 bytes each) in the per-class
builders called from 0x490c20; the pass state is computed at 0x48fab0 and the blend factors
are set at 0x49a990. `formats/model.ts readMaterial()` decodes this; `tools/materials.ts`
prints a per-level census.

| Class | Properties used |
|---|---|
| Simple `0xad99e79b` | 1 texture, 2 blend mode |
| Advanced `0x7e3ad512` | 1 texture, 2 blend mode, 3 tint on, 4 tint colour, 5 depth write, 6 UV scale, 7 / 8 U / V offset, 9 UV scale waveform, 10 UV scroll waveform, 11 texture-coordinate input, 12 texgen mode, 13 object-offset factor (modes 7..9), 14 / 17 address modes [guess] (see "Texture coordinates" below) |
| Animating `0xd58d8e2c` | 1 frame list (textures), 2 frames per second, 4 blend mode, 5 tint on, 6 tint colour, 7 depth write |
| Layered `0x03656e9f` | 1 single-pass fallback material (used when the "low detail" option is on), 2 list of layer materials (≤ 8, drawn in order) |
| Landscape `0xb13556e7` | 3 texture, 4 tiling in floor cells, 7 splat fade distance [guess] |
| Preset `0x2d8c5d43` | 1 base texture, 2 blend mode; 4/5/7/9 textures select a preset multi-pass effect [not decoded: no retail package has a Preset template, so nothing draws one] |

**Blend modes** (word 2 of Simple/Advanced, word 4 of Animating):

| Mode | D3D blend (src, dst, op) | Alpha test | Typical use |
|---|---|---|---|
| 0 | ONE, ZERO | off | opaque; any alpha channel is not coverage |
| 1 | SRCALPHA, INVSRCALPHA | > 2/255 | decals, glass, grime |
| 2 | SRCALPHA, ONE | > 2/255 | glows, fire, light shafts (fog colour forced black) |
| 3 | ONE, ZERO | > 2/255 | (unused) |
| 4 | SRCALPHA, ONE, reverse-subtract | > 2/255 | darkening effects (fog black) |
| 5 | ZERO, SRCALPHA | > 2/255 | darken by alpha (fog white) |
| 6 | DESTCOLOR, SRCCOLOR (2·src·dst) | > 2/255 | detail / grime "modulate 2x" (fog grey 0x7f7f7f) |
| 7 | ONE, SRCALPHA (src + dst·a) | off | layer over a reflection base: alpha = how much reflection shows |
| 8 | SRCALPHA, INVSRCALPHA | > 200/255 | mode 1 on a 1-bit-alpha (DXT1a) texture: cutouts (grates, foliage) |

Only an opaque or cut-out first pass writes depth; blended layers never do. The flag decoded
as "depth write" (Advanced p5, Animating p7) is the screen glow's stencil mark, and it raises
an additive pass's alpha test to > 32/255 [verified, docs/re/renderer.md §5.1]. Models are
drawn two-sided unless their header flag word has bit 23. The tint colour is halved into the
texture factor and doubled again by texture stage 1, so the effective tint is the stored
colour.

**Layered materials** in chapter 1 are almost all the same recipe: layer 0 is a small
environment texture with texgen mode 4 (camera-space reflection vector, xvsTextureMatrix_Reflection.vsh,
mapped from [-1, 1] to [0, 1] and scaled by word 6), layer 1 is the real diffuse texture in
mode 7 whose DXT5 alpha masks the reflection, and an optional layer 2 is a tiled detail
texture in mode 6. The fallback is the diffuse texture alone, drawn opaque. Bars, pipes, cell
doors and metal frames use this; drawing the fallback with its alpha as coverage is what
made them streaky and full of holes.

**Texture coordinates** [verified unless marked]. The Advanced builder (0x48ff70) copies p6 to
the pass's scale, p7 / p8 to the U / V offsets, p10 / p9 to two waveform references, p11 / p12 /
p13 as is. Per draw, 0x48e9f0 builds a texture matrix R = M · S · B · D:

- M by texgen mode p12: 0 identity (mesh UVs); 1 / 2 / 3 the object's world matrix (translation
  replaced by a zero vector for inputs 2 / 3, otherwise wrapped every 4096 engine units);
  4 / 5 object matrix × camera matrix (scale removed for inputs 2 / 3); 7 / 8 / 9 identity
  with the object position × p13 as translation.
- S a uniform scale p6, × 1/2048 for input 1 (engine units to model units).
- B the [-1, 1] -> [0, 1] bias (× 0.5 + 0.5) unless input 0.
- D the offsets: p7 on the U column, p8 on the V column.
- Waveforms (0x48e7c0): p10 adds its two channels to the U / V translation (scrolling), p9
  multiplies the U / V columns; both are evaluated at fmod(game time, length) with linear
  interpolation.

The two columns the mode selects (0x48e1a0: modes 1 / 7 x-z, 2 / 8 y-z, 3 / 9 x-y, 0 / 4 / 5
u-v) become the vertex shader's texture planes (xvsTextureMatrix.vsh, `dp4 oT0.x, v%i, c[4]`).
The input p11 picks the register (0x4359xx, flag bit 18 + p11 set at 0x436110): 0 the mesh UVs
(v5), 1 the position (v0), 2 the normal (v3), 3 the reflection vector
(xvsTextureMatrix_Reflection.vsh). ShaderLibrary.bin agrees: its texture-matrix programs read
r3 (reflection, 193), v0 (position, 13) and v5 (UVs, 388). So the planar modes are not position
projections by default: every planar layer in the retail data uses input 3 (a world-space
reflection lookup: sheens, glints and environment photos such as 7:562 / 7:563 / 7:393), apart
from 7:2607 (input 1, a cloud-shadow texture projected per 5 m). Mode 4 layers use input 3
(reflection, 26 materials), 1 (camera-space position, 23, e.g. chapter 1's 7:626 / 7:1080 /
7:761 / 7:547) or 2 (camera-space normal, 4). The port ignores M's translation for input 1 in
mode 4 and p13 [not applied].

**Waveforms** (.wdu, type 0x60): u32 kind, u16 channels, u16 bits (0 or 32 = float; 8 =
rumble levels, src/app/gamepad.ts), u32 samples per second, u32 encoding, u32 byte count, then
the samples. The material ones are kind 3, two float channels; World Common 7:25 / 7:27 scroll U
from 0 to -1 in 0.7 / 1.4 s (a seamless loop), the water caustics 7:33 / 7:36 / 7:41 / 7:51 drift
over 16..106 s. Length = samples / rate [inferred]. 725 Advanced templates: 183 scroll, none use
p9.

**Effects and the framebuffer.** Direct3D 9 blends on the gamma-encoded bytes of an 8-bit back
buffer, saturating after each pass. The port does the same (engine-light.ts
GAMMA_BACK_BUFFER, docs/re/renderer.md §5.1):
- an 8-bit frame target;
- every material's output encoded to gamma before blending;
- no conversion at the end.

Additive and subtractive passes (modes 2 / 4) add or take away the engine's src × alpha and
fade to black with the fog instead of to the fog colour (engine-light.ts additiveEffectColor)
[exact]. Fire cards are drawn this way (FX 3:793 / 3:811 / 3:883: three Animating layers, blend
2, tint 0x3f3f3f, glow mark, so their alpha test is > 32/255 and they write no depth).
`?lighting=legacy` keeps the linear frame buffer.

**Floor splats.** Floor layers (src/formats/level.ts) carry a baked atlas at 4 texels per cell plus, per
block, up to 6 Landscape materials with per-vertex weights (low nibble 0..4). Near the camera the
engine draws each landscape texture over the atlas with alpha = weight/4 × (1 − (depth / fade)²)
("Land Splat" options, xvsLandsplatAlpha.vsh). Landscape word 4 is the tiling: u = worldX / tiling,
v = worldZ / tiling in model units (correlating the baked atlas with the texture at that mapping
gives r = 0.986). The atlas tiles sit on a magenta (255,100,255) fill.

**Textures.** DXT1 punch-through texels decode as black; their colour must be bled from
neighbours or filtering draws dark fringes on cutouts. Thin cutouts need a coverage-preserving
mip chain or they disappear at a distance.

**Characters** draw through the same material passes [verified data]. A census of the
skinned models finds blended and effect passes on several: Hermes (10:92) is two additive passes
(mode 2) tinted 0x4b4b4b, i.e. texture x 0.29 added to what is behind him, a translucent glow;
others carry cutouts (mode 8), reflection layers (mode 4 texgen + mode 7) or tinted additive
overlays (Killjoy 10:90, 7:653..655). The port drew every skin as one opaque lit texture; skins
whose first pass blends (modes 1, 2, 4, 5, 6) or is tinted now use the surface material
(app/character.ts `characterSurfaceBlend`; the skinned loader keeps the decoded material per
submesh). The tint rule is verified (§3.5 of renderer.md: TFACTOR replaces the vertex
lighting). It draws Killjoy 10:90, the Mainliner's 0x666c4f part (10:31), Inferna's 0xffa722
parts (10:99 / 10:100), 10:35 and 21:15 unlit, texture × tint. All passes of these materials
have their textures decoded; Killjoy's second pass 10:428 drew the magenta placeholder when only
the first was. The object
opacity multiplies a tinted pass's alpha (0x48fcdf), so Hermes' fader (§15.7.12) scales that glow
[verified]; the port's additive passes take it from the material opacity. Lit opaque
skins keep the character light set; their reflection layers are still not drawn.

**Baked lighting.** xvsLightPrecomputed.vsh scales the .ldu vertex colour by c[51].w = 2.0, and
the footer halves the sum again; the full equation is in §19 [verified].

## 17. Effects and audio ambience (src/game/fx)

Code: `src/game/fx/` — `system.ts` (wiring, `services.fx`, API at the top), `shake.ts`,
`effects.ts`, `decals.ts`, `surfaces.ts`, `footsteps.ts`, `ambient.ts`, `reverb.ts`,
`flying.ts`, `rim.ts`. Test: `tests/fx.test.ts`. Tags as in §1; **[verified]** = read in
Suffering.rfl / SUFFERING.EXE (addresses given), **[data]** = follows from the retail values,
**[inferred]** = behaviour chosen to fit the values, **[port]** = no counterpart in the original.
The fx system extends the world FX runtime (§14.2) through `Fx.spawners` / `Fx.drawHooks`, so every
generator, weapon and break effect reaches the classes below.

### 17.1 Surfaces (Material Types)

- Every engine material template has a **Game Material Properties** template in word 0; its p0 is
  the **Material Type** [verified: EXE string "Material [0x%0x] refers to Material TYPE instead of
  Material PROPERTY!"; data: all 62 GMP templates]. Material Types (33, System pkg 2) have no
  properties; they are the key of every per-surface table (Player / NPC / Missile / Melee Weapon
  Material Effects, p0). GMP p1..p4 (friction-like floats) are not used. Type names are not in the data.
- Lookup in the port: static triangles → `CollisionWorld.triPart` → `LevelData.parts[i].material`;
  floor layers (no material) → the heaviest landscape splat at the nearest vertex → the Landscape
  Material using that texture; dynamic bodies → the model's first material.
- Table lookup [verified, RFL 0x100b05b0]: the entry whose p0 is the surface's type, else the
  entry without a type (the default).

### 17.2 Camera Shake (0x6506a1ba) [verified unless marked]

On (p6, 0x1009d8f0): time left = p2 s. Think (0x1009d6d0): amplitudes a = p0, b = p1 (model
units; ×2048 in code), faded linearly over the last p3 s, scaled by distance from the camera
(full within p4, none beyond p5, linear between; most templates use 10000), written into the player
object (last writer wins; the port uses the strongest); time left -= dt. The player camera
(0x10003de3) adds, every unpaused frame, rand(±a) along the camera right axis and rand(±b) along
its up axis to the eye **and**, independently, to the look-at point: per-frame jitter of position
and aim. Port: the look-at jitter becomes a rotation at an assumed look distance of 2.5 units
[inferred]; the eye offset is clamped against walls. Sources: 10/1/0 placed instances in 1a/1b/1c,
43 Camera Shake templates inside Object Generators (explosions, breaks) [data]. No data ties a
shake to landing or to the player being hit; the port adds a small jolt for falls faster than
8 m/s and hits over 15 health [port].

### 17.3 Effect templates [see the tags]

| Class | Port |
|---|---|
| Muzzle Flash | p0 card models (one at random), p1 seconds [verified §4.4]; random roll, short pooled light [port] |
| Point Light (spawned) | p0 colour, p8 radius; 0.25 s flash from a pooled light [inferred] |
| Fire (0x1d84210f) | ctor/think read p1, p3..p5, p11, p15, p18 [verified]; model grows from p3..p5 to p6..p8 when lit (rate p12..p14 per s) and shrinks when put out, p1 turns it about the vertical to face the camera, p15 damage / s of type p16 to the player standing in it, p18 BurnFX (not modelled); inputs p19 On, p20 Off, p21 BlowUp (= out) [inferred]; the two nearest burning fires get a flickering pooled light [port]. Lifetime (update 0x100ac6e0, light 0x100acd00, touch 0x100ad320) [verified]: p2 the burn time (0 = until put out), growth over p9 s, shrink over the last p10 s, removed at the end when p19 = 0 (the Inferna footprint fire 3:3598: 2.5 s, 0.25 up, 0.5 down); damage only while lit, when the player's posed hit spheres touch the fire model's bounds box (type-7 record) [box contact inferred] |
| Decal | template model = the quad (texture, blend); p0 seconds, p1..p2 size [inferred]; projected (below) |
| BloodPool | p0 material (4:1095 blood texture), grows from p1 to p3/100·2 units over p2 s, opacity p4 %, stays p6 s [inferred] |
| Blood Point Generator | drops at p0..p1° elevation within p3° around the direction away from the attacker, reaching up to p2 units, each leaving a splat where it lands [inferred] |
| Water Ripple | model scaled from p2 to p1 over p3 s [inferred] |
| Electric Arc / Electric Arc Effect | §17.3.1 [verified]; a bare Electric Arc spawned at a point, and the template-free 'electric' hit (Horace's shots), crackle between the point and a few around it with the arc model [port] |
| Particle Smoke | p0 puffs, p19 flipbook (frame by age), life p4..p5 ms, colour p16, size p13/10 [inferred] |

#### 17.3.1 Electric Arc Effect and Electric Arc (`electric-arc.ts`) [verified unless marked]

Suffering.rfl: Electric Arc Effect (class 0x2d326c65) ctor 0x100aada0, start 0x100ab3d0, arc
spawn 0x100ab180, update 0x100ab590; Electric Arc (0x6c5a0ad6) ctor 0x1001ff80, init
0x100a9bf0, update 0x100a9c40. A Damage Action Object's p8 is spawned on each of its targets.

- **Effect**: p0 seconds it lasts (-1 until removed; 999 on Horace), p1 an Object Generator
  attached at the start endpoint (0x100aa680: the pale-blue Point Light 0x82a7ff with a
  Lighting Effect flicker), p2 the endpoints, p3 arcs, p4 the Electric Arc, p5 = 1 travel, p6
  restart a finished path from the root (0 ends the effect), p7 = 1 direct children only, p8
  damage per second to the target (0x100a9ef0; 0 in retail).
- **Endpoints** form a tree (first child, next sibling). With p2 = 1 they are the target and,
  recursively, the objects it links to (0x100aa380; an object met twice destroys the effect).
  Otherwise they are the bones of the target's skeleton (0x100aa080, bone records +0x44 /
  +0x48). Fewer than two destroy it. The start is the hit bone the message carries, else bone 1
  (p2 = 0) or the target itself.
- **Electric Arc**: the template's model is the bolt, two crossed ribbons 0.4 wide and 1 long
  along -z in 10 (3:447, 3:1150) or 20 (3:578, 3:1054) sections, textured with an additive bolt
  (3:332 / 3:375) whose Advanced Material carries the glow mark. p0 / p1 (m) the distance range
  of its next end, p2 bow scale, p3..p4 % the per-section bow, p5..p6 s how long it keeps its
  ends, p7..p8 % the width scale.
- **Ends.** When an arc's life runs out it takes new ends and a life U(p5, p6). Random (p5 = 0,
  0x100aaf80 / 0x100aa7a0): the old end becomes the start; the new end is a random endpoint in
  (p0, p1) of it, else any endpoint (the start included: a zero-length arc, drawn 0.01 long).
  Travel (p5 = 1, 0x100ab460 / 0x100aa9d0): A <- B <- C, C <- a random descendant of B within
  (p0, p1); nearer than p0 the walk goes deeper, with p1 less that distance. Only arc 0 travels;
  the others copy its ends and life.
- **Every frame** (0x100ab590): width w = U(p7, p8) / 100. Travel runs the arc from
  A + (B - A) k to B + (C - B) k, k = 1 - t / life; with no C it shrinks into B, w x sqrt(1 - k).
  The model is put at the start with its -z to the end, scaled (w, w, length) and rolled by
  U(0, 2 pi) about its axis. Its sections (vertices of one z sorted by z; a vertex at the origin
  is skipped, 0x100c3810) move along the model's y by sin(pi i / n) x U(p3, p4) / 100 x p2 x
  length: a bow to one side with a jagged edge, new every frame (0x100a9c40). Arcs hide with
  their target; the effect goes with it.
- **The 1a electrocution, timed** [data]: the guard's arrival at Waypoint 752d (p0 On) fires
  Relay 8a1b (once) and Relay 75de together. 8a1b -> Timer 81d5 (0.1 s) -> 75dd and 8185 at once
  (200 damage, not per second: his 75 health is gone 0.1 s after he arrives). 75de -> Timer 5bd2
  (0.1 s) -> Relay 7619 (the door and chair-room bolts, the spark generator, the Light Housings),
  Relay 8475 (Horace's own Damage Action Objects 7b0b / 890f, Behavior Changer 8478), Point Light
  6db4, Sound Effect 77a1, and Relay 7a77 -> Timer 8a1c (0.25 s) -> Speech Player 8b33: Horace
  7a47 (unseen, in the chair room) says one of four lines (12:351..12:354), 0.35 s after the
  arrival. The guard says nothing there. What keeps him on his feet is his death clip: the
  Damage Action Object's damage names no attacker, so the death picker takes his second
  DeathBehavior 10:22 (10:156: upright for about 0.5 s, on his knees from 1.5 s to 5 s, down at
  5.7 s), §11.5 item 3 (DeathBehavior p4). The port took the first (10:250: 10:301 down by 0.5 s, or
  10:1470).
- **The 1a electrocution** (Relay 8a1b at the guard's Waypoint 752d): Timer 81d5 fires 75dd
  (3:2898, with light generator 3:2940) and 8185 (3:2941, 200 damage) at guard 609e: one arc
  each travelling over his bones for 15 s (3:2899: 0.5..3 m, bow 60 x 0.3..1 %, 0.5..1 s,
  width 35..55 %), so they keep crawling over the body on the floor. Relay 7619 starts the door
  and chair-room bolts: 816e / 82a4 (3:2893, every 0.5 ± 0.25 s for 4 s) on decoration trees
  from the door frame to the floor in front of it; 818e (3:2909, every 0.35 ± 0.1 s for 4 s)
  ceiling-to-floor bolts in the chair room 5..7 times the model's width (2..2.8 m: the white flare
  through the doorway); 81d2 (3:2893, 8 s) on the chair-room ceiling; generator 816d's light;
  Relay 81bc breaks the two Light Housings.
- **The glow.** The bolt material's glow mark (Advanced Material p5) feeds the engine's HDR
  scene glow (docs/re/renderer.md §3.2, `src/app/scene-glow.ts`: marked pixels blurred over four
  levels and added back, with the Pixel Shaders option). The arcs are drawn with the model's own
  material, so the glow pass picks up their deformed meshes; nothing else adds a glow.
- **Port**: `ElectricArcs` in the fx system (services.fx.arcEffect); the director builds the
  target (an actor's bones; the linked objects' tree) for each Damage Action Object target. The
  generator's Point Light is fed to the engine lighting at the start endpoint for its run time.
  On the player the arcs use his third-person body, which first person does not show.

**Decals** (`decals.ts`): orthographic projection along the surface normal onto the static
collision triangles around the point (`CollisionWorld.trianglesInBox`), clipped to the decal box,
so splats wrap over corners. Covering decals are tinted with the baked vertex light of the parts
they land on (× the static gain), as the level itself is drawn; at most 96 live decals. Level
Properties p38 is a Decal Collection and p39..p41 (10/20/30) are probably the per-kind decal
limits ("Level properties should set max decals to NON-zero value!!!") [guess, not used].

**Blood.** "Reputation Point Based Blood Texture Set Suite" templates (Ranged / Melee Weapon p61,
Player p66/p67) reskin Torque's body, arms and weapons, not walls. The suite is picked by
reputation, and a Blood Texture Set inside it by a blood level (p1 is a blood threshold, not a
reputation threshold); see §13.6 [verified]. Wall / floor blood comes from Blood Point Generators and
BloodPools inside generators: Missile Material Effects p3 / p4 and Melee Weapon Material Effects
p3 of the flesh Material Types point at them [data]. The port's `blood()` splats use the BloodPool
texture [inferred].

**Impacts.** Missile Material Effects: p0 type, p1 sounds, p2 InvestigateSound (AI noise, not
modelled), p3 generator, p4 second generator (flesh types: blood), p5 extra template (water
ripples on 2:879), p6 Decal, p7 float. Melee Weapon Material Effects: p0 type, p1 sounds, p3
generator. `services.fx.impact()` plays the entry for the hit surface [data for the layout].

### 17.4 Ambient Sound and Flying Sound [verified unless marked]

**Ambient Sound** (0xe6ec6c84; ctor 0x10092b00, think 0x10092c20): a zone (unit cube × scale).
p0 = 1 tests the player object, else the camera. Four global ambient channels; channel k has
sound A = p(1+k), B = p(5+k). Inside, t = clamp(0.5 − z_local) (1 at the zone's −z face) and the
channels crossfade equal-power (A: sin t·90°, B: cos t·90°; A = B plays A). One zone is current;
entering another runs the old one's exit. Leaving: the reverb environment changes to p9 (depth
p10 %, fades p11 / p12 s) when leaving on the A side (t ≥ 0.5), else to p14 (p15 %, p16 / p17);
then the channels keep that side's sounds, **p21 (A side) or p22 (B side) goes to the links**, and
p13 / p18 set or clear a flag on the player (bit 8 at +0x9c, meaning unknown, not modelled).
p19 / p20 are inputs (0 on every chapter-1 instance). In 1a, zone 802d sends Off to Combat
Music 78a4 when left on its B side (verified headless: music log "current (message 2)"), and
seven zones switch the Flying Sound 78a6 On / Off. The port fires the output at once instead of
after the reverb fade.

**Flying Sound** (0xbd83621b; init 0x100af460, path 0x100af210, think 0x100af500): p0 thinks at
start, p1 positions relative to the listener (else the object), p2 1 = sounds in list order (else
random, no immediate repeat), p3 sounds, p5 combat music: 0 ignore, 1 no new sound while Combat
Music plays, 2 also stop the current one, p6 ± p7 s between sounds (no overlap), p8 path speed,
p9..p10 ring radius; inputs p11 On, p12 Off, p13 Destroy. The sound moves along a spline from the
origin through either the chain of **Flying Sound Waypoints** (random onward link; at the end the
object destroys itself: a one-shot fly-by) or random points p9..p10 units away in random
horizontal directions. p4 is not read on these paths [unknown]. 1a: 78a6 (ten storm / prison
sounds around the listener every 38 ± 5 s), 8486 / 84b6 (fly-bys started by Detectors).

### 17.5 Environment reverb

Reverb Effect Template (EXE 0xf7bb7912): p1..p13 match the EXE's sound debug menu names in
order and type — Reverb Depth (%), Room (mB), RoomHF (mB), Room Rolloff, Decay Time (s), Decay HF
Ratio, Reflections (mB), Reflections Delay (s), Reverb (mB), Reverb Delay (s), Diffusion (%),
Density (%), HF Reference (Hz): the I3DL2 / EAX 2 listener set [strong]; p0 the preset id,
p14..p17 unknown. Users: Ambient Sound p9 / p14 and **Level Properties p27 / p28** (the level's
environment and depth %; 1a 3:1922 at 42 %) [data]. Port [inferred]: Web Audio has no EAX, so each
environment is a generated stereo impulse response (early taps between the two delays at the
Reflections level; a noise tail decaying 60 dB in Decay Time below HF Reference and Decay Time ×
HF Ratio above, scaled by RoomHF) in a ConvolverNode fed from the sfx and voice buses (music
dry), wet level Room × depth. The audio menu's "Environment FX" row (`x.environmentFx`, choice 1
= Off [guess on the order]) mutes it.

### 17.6 Footsteps [verified unless marked]

Animation markers (kind 1) 200..205 = FootStep Light, Heavy, Scuff, Sneak, Land, BodyFall are
handled by the Player (0x10042cd0) and NPC classes (0x100e4ca0): kind = message − 200; the
surface's entry of the Player p145 / NPC p49 Material Effects list plays one sound of
p(1 + kind) at the character (no immediate repeat, 0x100b04a0), makes an AI noise from p7
(InvestigateSound; not for Sneak; not modelled) and spawns the effect template p(8 + kind) at the
feet (mostly empty; 3:2624 / 3:3689 for some NPC entries). No other code plays footsteps. Of 526
clips with events, 185 carry footstep markers (player set 328: 92; the inmates' set 52: 5);
characters whose current clip has none make no footstep sound. In first person the player steps
on a timer instead: Light every Player p156 = 0.4 s at full stick (docs/re/audio.md §13). The
port's third-person gait cycles fire the markers of the clip they stand for, re-timed onto the
cycle. It also plays Land after a fall of more than 4 m/s when the landing clip did not [port].
Verified headless: the player's run clip (328:28) fires Heavy at 0.168 / 0.527 s; guards walking
in the 1a intro play the NPC lists.

### 17.7 Directional and Ambient Light

A Directional Light (EXE 0x6b110672) whose p9 is a **Rim Light** template thinks every frame
(0x4c76b0, while p6): it turns the Rim Light's p10 / p11 angles (degrees) into a direction relative
to the active camera's orientation and points its light along it — a camera-relative rim light
that only the per-object lighting sees [verified for the direction; which objects it applies to
is not decoded]. Ambient Lights (scaled boxes, p9 a colour) and Directional Lights without a rim
template have no per-frame code: bake only [inferred]. Which objects a light reaches: its parent
group in the sector tree, smallest region first, cut after the first exclusive (p8) light, the
first rim light for dynamic objects only (docs/re/renderer.md §1.4) [verified rule]. Port: every
thinking rim light is a camera-relative rig light (colour = Rim Light p0) in its Directional
Light's region (src/game/fx/rim.ts, engine-light.ts).

## 18. Visibility: sector tree, zones and portals (src/formats/visgraph.ts, src/app/visibility.ts)

The engine culls with **zones joined by portals**. The editor stores two tables in the .lvl; the
Portal objects are ordinary placed objects. `npx tsx tools/visibility.ts [level] [--zones]`
prints the decoded data.

### 18.1 Sector tree (.lvl type 0x26) [verified: all 18 levels parse to the last byte]

A five-u32 header (h0 is 20–40, h1 is the number of group nodes, the other three are unknown),
then records in file order, numbered from 1:

| Field | Meaning |
|---|---|
| `u32 kind` | 0 automatic split ("Node 0, 0 [1B]", quadrant names A–D per depth), 1 named editor group ("Backstage", "1st floor"), 2 placed-object leaf, 3 floor-layer leaf |
| `u32 flags` | 0x18, sometimes with bit 0 set [unknown] |
| `u16 parent, firstChild, nextSibling` | record numbers, 0 = none |
| `f32 max[3], min[3]` | engine-unit bounds of everything below the node |
| `u32 id` | leaf: object uid (kind 2) or floor-layer uid (kind 3); group: editor id |
| `u16 len + name` | kinds 0 and 1 only |

Every renderable object (statics, lights, props, NPCs, detectors, and so on) and every floor
layer is a leaf. Pure logic objects (relays, timers, move nodes, portals) are not. The leaf
boxes can be stale. In several levels they no longer match the placed geometry, and some
boxes are inverted (min > max). The port therefore computes zone extents from the geometry it
builds.

### 18.2 Zone graph (.lvl type 0x27) [verified]

```
u32 zoneCount
zoneCount x { u32 treeNode, u32 n, n x { u32 portalUid, u16 neighbourZone, u16 flags } }
u32 wordCount
zoneCount x { u16 n, n x u16 zone }        visibility list, always includes the zone itself
```

- A **zone** is a named group node of the sector tree (kind 1). An object or floor layer belongs
  to its nearest zone ancestor. Geometry outside every zone (2–20 % in indoor levels, most of
  6a and 9) is always considered.
- Each link names the Portal object between two zones. Every portal is listed by both of its
  zones, once with flag 4 and once without, so flag 4 marks the side.
  `portalUid 0xffffffff` with flag 2 is an **open adjacency**: there is no portal object and the
  boundary is always open. These links join the outdoor zones of 4a, 6a and 8a.
- The trailing lists are precomputed per-zone visibility sets. They follow portals but not
  open adjacencies (in 6a every list is just the zone itself). They also include zones seen
  without passing through a portal, for example a neighbouring cell seen through bars in 1a.
  The engine's debug options name the uses: "Prefetch Visible Nodes + 1", "Display Prefetched
  Vis Graph Zones" and "Disable Never Visible Portals".
- Zone counts: 0, 5a, 6b, 7 and 10 have no zones (the block is 8 bytes). 1a has 83 zones and 95
  portals; 2 has 103 and 127.

### 18.3 Portal object (engine class `0x5b0bad74`, in SUFFERING.EXE) [strong]

The volume is the template's unit cube scaled by the instance scale, like a Detector. A typical
doorway portal is 2–6 wide, 3 high and 0.5–1 deep. The object is 0x14 bytes, with a state word
at +0x10 (bit 0 = **open**) and two zone pointers at +8 and +0xc. Its message table (EXE
`0x5ba3e8`) has three entries: property slot 5 opens it, slot 6 closes it, and engine message
`0x1031` attaches it to a zone while the graph is built.

| Prop | Meaning |
|---|---|
| p0 | starts closed. At init, bit 0 = (p0 == 0). Set on door portals and on the few portals scripts open. |
| p1, p2 | flags read for sound (p1 sets zone flag 8 when attached) [inferred] |
| p3 | Sound Occlusion Template |
| p4 | linked object (the door Switch). When the portal closes, the linked object gets flag 0x40000; opening clears it. |
| p5 / p6 | input messages for open / close (default Enable / Disable) |

Opening or closing also sets or clears bit 0 of a flag word (+0x42) in both zones. Doors send
Enable to their portal when they start to open (Switch output 67) and Disable once they have
shut (65), so the room behind a door is never hidden while the door is visibly ajar.
Messages also come from Message Relays, Timers and Count Down To Zero objects (1a, 3a, 5b, 9).

### 18.4 Port: culling and grouping

- **Grouping.** `parseLevel` buckets the static geometry per material **per zone**. Zones wider
  than 96 units are also split into 48-unit cells, and so is unzoned geometry, by object origin
  or floor-block centre. The renderer keeps **one mesh per material for the whole level** with
  its triangles ordered by chunk (zone × cell). Each frame, after culling, it packs the visible
  chunks' triangles to the front of that mesh's index buffer and draws only that range
  (`compactLevel`). It does this only for meshes whose visible set changed, as a partial
  upload. The draw count therefore stays one per material, as with a plain merge, while hidden
  zones cost no triangles. This replaced a first version with one mesh per (chunk, material).
  That version cut triangles just as well, but it doubled the draw calls in open levels (2:
  334 → 761 per view on average) and cost more CPU time than it saved. Pooling small buckets
  across zones was also measured and rejected. The static level's matrices are computed once;
  the per-frame scene-graph update only recomputes subtrees that changed (§18.6).
- **Camera zones.** The camera is in every zone whose geometry bounds (plus 0.25 of slack, 1
  below and 3 above for eye height) contain it. Overlapping zones are all used. When the
  camera is in no zone, every zone is a candidate.
- **Portal walk.** This is a fixpoint over screen windows. Camera zones start with the full
  screen. A link through an open portal passes on the zone's window clipped to the screen
  rectangle of the portal box. If the box crosses the near plane, the whole window passes. A
  closed portal stops the walk, and an open adjacency passes the window unchanged. Windows are
  rounded outwards to 1/32 of the screen and only grow, so the walk ends however the graph loops.
- **Visibility lists and the near field.** The precomputed lists cover sight lines that no
  portal explains, such as 1a's death-row cells seeing each other through their bars. Every
  zone in a camera zone's list therefore seeds the walk with the whole screen as its window.
  The exception is a zone the walk reaches with every portal open but not with the real states,
  because only a shut door leads there. The lists still miss some window views: 1a's yard
  through the barred windows, 5b's greenhouse looking at the main building, 3b's cell fronts.
  So every zone whose box is within 40 units of the camera is also a seed, even behind a shut
  door. Door culling therefore hides what lies past a shut door outside that radius and
  outside the lists. The portal walk still bounds everything else, which includes all zones
  joined by open adjacencies.
- **Chunks.** A chunk is drawn when its zone was reached and its box overlaps that zone's
  window. Unzoned chunks are always candidates.
- **Other objects.** Rigid meshes outside the level (doors, props, pickups, effect meshes) are
  culled by zone too, every frame, from their current world matrices. The scene's world
  matrices are updated once per frame before culling rather than inside `render()`. A mesh is
  hidden when its bounding sphere (radius under 12, plus 1 of slack) only touches zone boxes
  that are not visible. Meshes in unzoned space and large ones are always drawn. Never culled:
  skinned characters (their bind-pose bounds say nothing about the pose a sequence puts them
  in), morphing, instanced, point and sprite geometry, CPU-rewritten geometry, and meshes their
  owner draws without frustum culling. Hiding sets `layers.mask` to 0, which nothing else in
  the app uses, so each system's own `visible` flags are untouched. Props in a static batch
  (§18.6) get the same test from the batch, per prop. The culler uses the
  camera that is about to render, which is the sequence camera during cinematics. Characters
  are culled by the actors (§15.5 "Actor draw culling": frustum, distance and sight lines in
  gameplay, frustum only under a cinematic camera), right before the draw as well; a hidden
  character's bone matrices are not recomputed until it shows again (`matrix-pass.ts`).
- **Draw distance.** Placed world props (dynamic.ts) are also hidden beyond their draw distance,
  as the engine does (docs/re/object-model.md §2: camera to bounding-sphere centre against
  distance + radius). The distance is the instance's own one (flag 0x10, engine units / 2048),
  else none when template flag 0x10000 is set, else 70.71 × the scaled template bounding radius.
  A template's own distance (template bit 0x20000) is not mapped to a record field yet, and no
  retail template's flag word (record +4) has 0x10000 or 0x20000 set. This applies in levels
  without zones too. `?nodrawdistance` turns it off.
- **Fog distance.** A chunk entirely beyond the fog's fade-out distance (`exp(-(d·density)²) <
  1/512`, so d = 2.5 / density) is skipped. This only happens while the fog colour equals the
  background colour and the level has no Sky / Sun, because the sky is drawn without fog and
  fully fogged geometry would still show as a silhouette against it. The data defines no
  per-object cull distances for statics. The "Cull Distance Multiplier" and "Landscape LOD" engine
  options are runtime debug values (Engine Properties), not level data.
- **Doors.** The visibility game system (src/game/visibility) tracks each portal's p5 / p6
  messages from p0. A portal whose linked door (p4) is open or moving counts as open whatever
  the messages said, which also covers doors restored from a save.
- **Pipelines.** While the loading screen is still up, every pipeline in the scene is compiled
  (`LevelRenderer.precompile`), so new zones never stall. This covers hidden zones, dynamic
  objects, actors and the other passes that draw the scene; see §18.7.
- **Checks.** At 10 sample viewpoints per level, the level geometry is rendered with culling on
  and off, with all portals forced open and dynamic objects hidden, and the screenshots are
  compared pixel by pixel. See the report numbers in §18.5.

### 18.6 Port: per-frame CPU (prop batching, scene graph, shared uniforms)

After zone culling, the frame cost on the CPU was mostly three.js work per object: each draw
updates and uploads its own uniforms and binds its buffers. The scene-graph update also
recomputed every world matrix. These changes cut that cost without changing what is drawn.

- **Static prop batches (src/app/prop-batch.ts).** World props (src/game/world/dynamic.ts) are
  separate meshes because the game systems move, break, hide, re-material and collide them
  one by one. But at any moment almost all of them are at rest. On its first update the world
  system copies every candidate prop mesh into one merged mesh per material. The copy is in
  world space, at the pose the prop has then. Candidates are opaque, depth-writing, frustum-
  culled, render-order-0 meshes with fixed, non-interleaved geometry. Runtime spawns (debris,
  drips), morph frames, transparent glass and sky domes stay separate. Each frame the batch
  compares every member with its snapshot: same world matrix (exact compare), same material
  and geometry, and shown (itself and every ancestor visible, still in the scene).
  - A member that matches is not drawn itself (`layers.mask` 0). Its triangles are packed into
    the merged mesh's index range if its zone is visible and it is within its draw distance.
    These are the same tests the culler applies to other rigid meshes, so culling is unchanged. The packing
    happens only when the set changes, as for the level's compaction.
  - A member that differs (door swinging or open, prop broken or picked up, lamp material table
    swapped, hidden by logic, moved by a sequence) leaves the merged mesh at once. It is drawn
    on its own and zone-culled every frame as before. It merges again once it has matched its
    snapshot for 30 frames. That wait doubles each time it leaves (up to 1,800 frames), so
    flickering lamps or constantly moving mechanisms do not keep repacking the batch.
  - The props keep their meshes, collision bodies, uids, materials and save state. Only drawing
    changes, so damage routing, interaction, sight tests, save/load and material swaps
    (including the reputation skins, which never touch level props) work as before. A
    mirroring world matrix flips the copied triangles' winding, which is what three.js does
    with its front face. Normals go through the normal matrix.
  - The snapshot pose is composed from the local transforms of the prop and its ancestors
    (`worldMatrixOf`), never read through three's `updateWorldMatrix(true, false)`. Placed
    objects only recompute world matrices when flagged (`matrixWorldNeedsUpdate`, matrix
    auto-update off), and that call computes a flagged ancestor but clears its flag without
    updating its other descendants, so the frame's matrix pass skipped them for good. Every
    pickup's root was still flagged when the batch was built (1a: 67, 1b: 227 meshes): their
    meshes kept an identity world matrix, the batch copied them to the level origin and they
    were invisible where they lay, while `?nobatch` showed them. `npm run smoke` now checks in 1a
    and 1b that every shown member's world matrix matches its ancestors' transforms, that a
    merged member's copy matches it, and that each is drawn once (merged: through the batch
    only; otherwise on its own only).
  - The merged mesh's bounds are those of the members it currently draws, so it is still
    frustum-culled as a whole. In levels without zones (0, 5a, 6b, 7, 10) the batches are also
    split on a 64 m grid. Otherwise one batch would span the level and always be drawn, where
    the separate props were frustum-culled. `?nobatch` turns batching off.
  - BatchedMesh / InstancedMesh were not used. Most prop models are unique placements of
    unique geometry, so instancing saves little. BatchedMesh needs a different shader path
    (per-instance matrices from a texture) and per-instance visibility updates every frame.
    The merged-index approach is the one the level already uses and is identical in WebGPU and
    WebGL2.
- **Scene-graph update.** The scene and the level group no longer auto-update their own
  matrices. With `matrixAutoUpdate` on, the scene recomposed its identity matrix every frame,
  and three.js then forced a world-matrix recomputation of the whole graph (about 3,000 prop
  nodes and 7,000–10,000 actor bones in the large levels). The world-dynamic group and the
  prop meshes (identity local matrices) also stopped auto-updating. Every code path that moves
  a prop sets `matrixWorldNeedsUpdate`, so props are recomputed only when they move. Hidden
  characters skip the per-frame pass (src/app/matrix-pass.ts): the actor root when level logic
  hides it, and the skinned mesh with its bones when the actor culler hides it. Their matrices
  are recomputed the first frame they show again. Explicit `updateWorldMatrix` /
  `getWorldPosition` calls (weapons on bones, carrier cameras, lip sync) still update them.
- **Shared light uniforms.** The engine light rig's uniform array (104 vec4: point, spot,
  directional, ambient boxes) and its counters and fog values were in three.js's default
  *object* uniform group. That gave every draw its own copy of the buffer, written every frame.
  They are now in the shared *render* group (src/app/engine-light.ts), written once per
  `render()`.
- **Volumetric fog.** Each fog volume's puffs (up to 48 sprites, one draw each) are one
  instanced sprite draw. Puff positions go into an instance attribute each frame. The blending
  is additive, so the order no longer matters (src/game/world/fx.ts FogVolume).
- **Security monitors.** The monitor feed render left the screen meshes that show the feed in
  the scene. WebGPU rejected the whole pass because it read the texture it drew into. Those
  screens are now hidden during the feed render (src/game/world/interact.ts).

**Measurements.** Measured with headless Brave/WebGPU at 1920×1080 on the Apple-silicon dev
machine, dev servers with HMR off. "Before" is a snapshot of the code from before these
changes. The two builds alternate level by level, and each figure is the better of two rounds.
The machine was shared with other jobs (load average 15–30), so absolute times are high and
noisy; compare within a row. CPU is the whole `frame()`: systems, culling, scene graph and
render. "Spawn" is 2 s at the player start after the intro is skipped, with every system
running. "Views" are 6 of the §18.5 viewpoints, flown to with the systems running. "After" also
includes other work merged during the measurements, mainly projected character shadows
(§19), so a third figure has those shadows off.

| Level | Spawn CPU ms before → after (shadows off) | Spawn draws | View median CPU ms (shadows off) | View draws |
|---|---|---|---|---|
| 0 | 3.9 → 3.9 (3.4) | 249 → 197 | 3.5 → 4.1 (3.0) | 205 → 183 |
| 1a | 14.0 → 9.4 (8.3) | 663 → 421 | 10.9 → 8.1 (8.0) | 381 → 272 |
| 1b | 12.9 → 8.2 (6.7) | 687 → 290 | 8.4 → 6.4 (5.5) | 235 → 143 |
| 1c | 3.4 → 3.5 (2.9) | 120 → 115 | 4.5 → 4.4 (4.0) | 224 → 195 |
| 2 | 14.4 → 9.7 (8.1) | 972 → 475 | 13.3 → 8.8 (7.5) | 675 → 337 |
| 3a | 10.5 → 10.6 (9.4) | 884 → 703 | 7.5 → 7.6 (6.8) | 285 → 382 * |
| 3b | 11.1 → 9.6 (7.5) | 539 → 360 | 11.3 → 9.7 (7.2) | 514 → 302 |
| 4a | 6.7 → 6.6 (5.0) | 390 → 293 | 7.7 → 8.0 (5.5) | 429 → 375 |
| 4b | 9.7 → 8.3 (8.2) | 790 → 553 | 7.6 → 6.7 (6.4) | 350 → 336 |
| 5a | 5.4 → 4.7 (4.1) | 255 → 230 | 7.2 → 6.2 (5.4) | 395 → 327 |
| 5b | 8.2 → 6.4 (6.4) | 975 → 360 | 6.5 → 5.5 (5.5) | 519 → 233 |
| 6a | 12.9 → 6.7 (8.0) | 949 → 395 | 13.0 → 8.4 (8.9) | 926 → 534 |
| 6b | 7.3 → 5.5 (5.2) | 578 → 327 | 6.1 → 4.8 (4.1) | 395 → 225 |
| 7 | 1.8 → 2.0 (1.5) | 89 → 89 | 1.4 → 1.6 (1.6) | 55 → 55 |
| 8a | 6.6 → 4.3 (4.7) | 360 → 219 | 8.7 → 5.9 (5.9) | 581 → 331 |
| 8b | 6.0 → 4.5 (4.6) | 277 → 204 | 5.5 → 4.1 (4.6) | 167 → 114 |
| 9 | 9.7 → 7.3 (6.4) | 613 → 459 | 7.2 → 5.6 (4.8) | 336 → 289 |
| 10 | 14.7 → 12.1 (7.0) | 999 → 683 | 8.3 → 7.0 (5.3) | 346 → 303 |

\* Medians of the per-view counts. Every 3a view draws fewer calls after (161 → 122,
461 → 395, 881 → 702...); the medians come from different views.

- Where the time went before, in level 2: render 9.6–11.8 ms for 972 draws (about 10 µs a
  draw under this load), and the world-matrix update 2.2–3.1 ms. The world-matrix update now
  takes 0.8 ms; most of what remains is actors that are on screen. The game systems take
  1.2–2.3 ms, the culler 0.1–0.3 ms, the batch update 0.1–0.4 ms and the light rig under 0.1 ms.
- What remains is mostly the level's own draws, one per material: 2 has about 426, 6a 639,
  10 about 690, almost all with distinct textures and no lightmaps. Fewer draws there would
  need texture arrays or atlases in the surface materials. The second-largest cost is the
  projected-shadow passes: one extra `render()` per caster per frame, up to 5 ms in 10's
  start area.
- **Identical rendering.** The batch was switched on and off in the same session, with the
  systems frozen, at 6 views per level, and the screenshots compared. This covered 15 levels
  and 90 views; 6b, 8a and 8b were not reached because the disk filled up. 41 views were
  identical. In the others, at most 0.0054 % of the pixels (3a) differ by more than 8/255.
  These are isolated edge pixels: the world-space copy rounds positions slightly differently.
  Five views (0 v0, 2 v2, 1b v5, 3a v2, 6a v2) differ more, but no more than two consecutive
  frames with the batch off: animated materials such as 1b's water caustics. At those frozen
  views the batch alone cuts the draws from 20,296 to 18,800 in total. In play it cuts more:
  level 2's start went from 972 to 546 draws with batching alone, before the draw distances and
  the fog change. Functional
  checks in 2 and 1a, scripted through the game services: a breakable is damaged until it
  breaks; a door opens, then closes and merges back; an ammo box is picked up; a lamp housing
  is switched off and on (glow material swap, merges back); and a save made in that state is
  loaded. Each step checks that every prop is drawn exactly once (merged and hidden itself, or
  separate and not in the batch), and compares screenshots with the batch on and off. All
  steps pass, and the state survives the save/load. An explosive breakable still damages the
  props and actors around it (Radius Damage p0 → p1 over p5 m, type p10).
- **Draw distance.** In 1a, 6a and 10, 230–600 prop meshes per view are beyond their draw
  distance. The nearest of them is 9–50 m away, and 10–70 draws are saved per view. Turning
  draw distances off changes at most 0.006 % of the pixels (1a). In 6a and 10 the change is
  within the frame-to-frame noise of animated materials.

### 18.7 Port: frame-time spikes (hitches)

Average frame rate was never the problem: 1a ran at 60 fps on average while the opening
sequence "Goose" stuttered. The stutter was single long frames, 50 ms to 4 s, mostly from work
that three.js does the first time something is drawn. These are the causes found and how each
was removed.

**How it is measured.** `src/app/frame-probe.ts` (`window.__frames`) keeps a ring buffer of frame
intervals (requestAnimationFrame timestamps) and of the main-thread time spent in `frame()`.
For every frame over 34 ms it records a breakdown: player, matrices, culling, lights, shadows,
render, viewmodel, and each game system by name. A Long Animation Frame observer adds script
attribution when the time was spent outside `frame()`. The QA scripts were the playthrough
harness (`tools/playthrough.mjs --keep`) and a CDP client that runs the V8 sampling profiler over
the same window. Each slow frame was matched to the profile samples inside it. To find which
objects were compiled at run time, the node-builder factory was wrapped
(`renderer._nodes._createNodeBuilder`) to log the object, material and render target. Frames
spent in the harness's own path planning (scripts injected through CDP) are left out of the
figures below.

**Causes and fixes.**

- **Shader builds are per material instance and per pass.** three.js's node builder keys a
  material's shader by the ids of its nodes. Two materials of the same kind with different
  textures therefore each build their own shader, which costs 5–30 ms of main-thread time.
  The GPU pipeline is shared when the generated WGSL is the same. A new WGSL variant also stalls
  the GPU process while Metal compiles it, for 100–450 ms in which the main thread sits idle.
  The build also depends on the render context, which three.js keys by the target's attachments
  (format, type, samples, depth). Every pass that draws the scene into another kind of target
  therefore builds everything again.
- **The precompile ran during the opening.** It used to start on the first game update, which
  is also the first frame of "Goose". For about 6 s the frames came at 100 ms intervals while
  the GPU process compiled in the background, and the first full render then took 1.3–2.6 s.
  The precompile now runs in `startGame` (src/app/main.ts) behind the loading screen. While it
  runs, `LevelRenderer.suspended` stops all drawing. Drawing the new level behind the loading
  screen used to compile the same shaders synchronously, again and in parallel with the
  precompile. Each pass is split into four concurrent lanes by material. Next, the systems' first
  update runs behind the loading screen too, with the audio context suspended. That update
  builds the static prop batch and NPC gear and plays the sequence keys at time 0. Then comes a
  second, incremental precompile, and `settle()` draws one frame and waits for the GPU queue to
  drain. Only then does the loading screen go away. Later calls compile only meshes not compiled
  before (or whose material changed). An in-place checkpoint restart has no loading screen to
  hide behind, so it keeps the top-up on its first update.
- **The other passes.** These are registered in src/app/prewarm.ts and compiled with the scene.
  The insanity screen effects draw the scene into their own target (`warmTargets`). Goose opens
  on a black Screen Fader, so the whole visible scene used to compile again on its first frame.
  The effect quads are drawn once, and the targets are allocated at screen size (`warmHooks`).
  The first-person viewmodel scene is compiled too.
- **Security monitors.** The feed (every 0.12 s while the player is within 8 m) drew the scene
  into a 256×192 RGBA8 target: a third render context, so 839 extra shader builds. When a camera
  first showed a room, 25–300 ms frames followed, and once 970 ms. The target now has the same
  attachments as the renderer's own frame target (half float, 4 samples, depth), so the feed
  reuses the main pass's shaders. It holds linear colour, and the screen samples it that way.
  The target and the screen material are created with the level.
- **three.js's light list.** The engine lighting has its own uniforms (§19), and its materials
  set `lights = false`. The renderer still kept a per-scene light list whose cache key holds the
  id of every visible light. Each change to that list made every visible material rebuild its
  shader: the flashlight toggling (which cinematics now do), a muzzle flash, a new explosion or
  fire PointLight, or a switched level light. Outside `?lighting=legacy`, `renderer.lighting.enabled`
  is now false, so the list is always empty. The two materials that relied on three.js lights
  (brass casings, the player placeholder capsule) are engine-lit now. The precompile no longer
  needs to run with the flashlight both on and off.
- **Objects that appeared later.** The puppet that plays Torque in cinematics is now built
  with the sequence system rather than at the first cinematic. NPC hand weapons and body parts
  are built at weapons-system creation rather than on its first update. Their first draw had
  cost 30–75 ms when a guard came into view. Projected-shadow silhouettes are compiled for
  every actor and the player body (engine-light.ts `precompileShadows`, through an fx-system
  hook). A caster's first shadow had caused a 350 ms GPU stall.
- **Hidden stand-ins** in `warmObjects` / `warmViewmodelObjects` cover materials that are swapped
  in or spawned later:
  - both material tables of every lamp housing (p32 / p33), compiled before a lamp is switched;
  - decals in every blend mode, which had caused a 150 ms stall at the first blood splat;
  - the held models of the weapons in the inventory and the weapon Items of the level, in both
    the viewmodel and the scene pass. Picking up the shiv had caused a 300 ms stall. Particle
    sprites, drips and other later materials still build their shader once, without a new
    pipeline, for about 5–10 ms.
- **Environment reverb.** A zone change generated a stereo impulse response and set a
  ConvolverNode's buffer, which is an FFT setup on the main thread. Together they took 27–44 ms.
  Every environment the level's Ambient Sound zones use is now prepared at load, with one
  convolver each. A change only reconnects the sends (src/game/fx/reverb.ts).
- **Garbage.** At rest in 1b, about 51 MB/s was allocated. Major collections paused for
  50–100 ms on the busy machine. 59 % of it came from `CollisionWorld.sweep` iterating the
  dynamic-body Map's entries, one entry allocated per body per query. The bodies are now also
  kept in a dense array. Detectors gathered their occupants once per detector and frame; that is
  now once per filter and frame. The world lights' engine records are reused each frame.
- **Dialog.** When a sequence begins, its sounds are decoded in key order, one at a time, so a
  line is decoded before its key, not at it.
- **Index uploads every pass.** The level meshes' compacted index buffers (§18.4) and the prop
  batches' were marked `DynamicDrawUsage`. three.js's WebGPU backend uploads such an attribute
  whole on every `render()` that draws it, whether or not it changed: about 200 writes and
  3.7 MB a frame in 1a, and again for every extra pass (security feed, screen effects). This
  was the largest steady cost in the GPU process, and the main reason a busy machine fell to
  30 fps. They now use the default usage. `compactLevel` / the batch repack bump the version
  with an update range, so only the packed range is uploaded, and only when the packing changes.
- **Pushables at rest** check their support with a ray 4 times a second rather than every frame
  (immediately after being let go). 32 crates' rays a frame were the largest garbage source
  left in 1b.

**Measurements.** These were taken in headless Brave/WebGPU at 1280×720 on the Apple-silicon dev machine, while other jobs shared it (load average 11–45). "Before" is the code from before these changes (commits 9451299 and 0089170), measured with the same harness. A frame counts as a hitch when the interval between frames is over 50 ms; frames spent in the harness's own path planning are left out. During the last runs the whole machine's headless compositor dropped to 30 Hz, a fresh blank browser included; the 30 Hz figures are marked.

| Scenario | Before | After |
|---|---|---|
| 1a "Goose", 216 s real time | first frame 4,050 ms; 28 frames > 50 ms (max 583 ms), 31 > 33 ms; p99 16.8 ms | 1 frame > 50 ms (the first after the loading screen, 300–400 ms); 5 > 33 ms; p99 16.8 ms, 59.8 fps |
| guard scenes after it (~20 s) | 2 > 50 ms (max 167 ms, security feed compiles) | 0 > 50 ms; p99 16.8 ms |
| walking 1a (8 route steps, ~95 s) | 5 > 50 ms (max 567 ms: shiv pickup, feed, blood decal) | 1 frame of 50.1 ms; p99 16.8 ms |
| transition 1a → 1b, frames after the load | first frame 1,600 ms, then ~12 frames of 67–133 ms over 2 s | 1 frame of 67 ms (30 Hz) |
| 1b Hermes / Horace scene (~98 s) | 1 frame of 50 ms (reverb swap 27 ms + frame); 41 ms GC | 0–1 frame > 50 ms (one 83 ms GPU wait at 30 Hz; a 115 ms GC pause on the busiest run) |
| time to 1a playable | 17.9 s | 26.5–32.8 s (precompile 12.5–16 s) |

Not changed: mechanisms (security cameras) rebuild their collision BVH 5 times a second. That
costs about 2.5 ms each time and stays under the frame budget. The engine-light rig and its
shadow casters allocate a few MB/s (vectors and candidate records per frame), and NPC weapons
allocate a set per frame. Moving the compile behind the loading screen made loading longer: in
1a, 12.5–17 s of precompile on the shared, busy machine. §18.8 brought that down to 1–2 s.

### 18.8 Port: load time (shared shaders, caches kept across levels)

After §18.7, 1a took 17–33 s to become playable, 13–25 s of it in "Compiling shaders…". These
figures were taken with a scratch CDP harness (outside the repo). It runs headless Brave/WebGPU at
1280×720 with the GPU shader disk cache off and a fresh profile per run. A script injected at
document start counts `GPUDevice.createShaderModule` and `createRenderPipeline(Async)` calls and
wraps three.js's node-builder factory, recording each build's render-object cache key, render
context and material. The phases come from `__frames.load` (src/app/main.ts marks each step of
`openLevel` / `startGame` and each system's start), and a V8 sampling profile covers the load.
macOS keeps its own Metal compiler cache, which no run could clear, so the GPU-side compile
times are warm-cache times.

**What the compile time was.** At HEAD before these changes, one 1a load made 1,886–2,117 node
builds for 1,024 distinct cache keys. It created 566–590 shader modules and about 590 pipelines.
The profile showed the main thread busy for 31 of 33 s, 23 s of it inside three.js's node
builder. The GPU process was not the limit: up to 139 pipelines were in flight at once.
- *Duplicate builds.* three.js stores a material's built shader (its NodeBuilderState) under the
  render object's cache key only once the build has finished. The four precompile lanes, the
  per-caster shadow compiles and the systems' own compiles ran at the same time, so objects with
  the same key built the same shader again, 862 times in one load. The lanes split the work by
  material, not by key, so they added duplicates without adding speed while the main thread was
  the bottleneck.
- *One shader per material.* The key holds the ids of the material's nodes. Every engine-lit
  material (characters, props, held items: `engineLightMaterial`) and every surface material
  (`createSurfaceMaterial`) built a node graph of its own, with its textures and constants as
  nodes in it. So nearly every material had its own key: 1,024 keys for 989 materials. 37
  instances of one character skin were 37 builds. The generated names also differed between
  graphs, so many of those builds also made a shader module and a pipeline of their own.

**Changes.**
- `coalesceNodeBuilds` (src/app/renderer.ts): an async build for a key that is already being
  built waits for that build and then takes the result from the cache.
- Engine-lit materials share one colour node per lighting kind (precomputed or not, light set or
  not). The node reads the drawn material's own `map` and `color` (`materialColor`), so texture
  swaps on a live material still show at once (§19.4).
- Surface materials share their graph by *structure* (surface-material.ts `SurfaceGraph`): layer
  count and blend modes, texture inputs and texgen axes, tinted or lit passes, waveforms,
  animated frame arrays and splat channels. The per-material values are textures, uv scales and
  offsets, tints, and splat tiling and fade. They live in `material.surfaceSlots` and reach the
  shader through material reference nodes, the way three.js reads `map` and `color`. Two
  subclasses keep the slots when a material is cloned (the sky domes clone theirs).
- *Colour space of the shared-context targets.* The security-monitor feed and the screen-effect
  target were made with the frame target's attachments (§18.7) but left their texture colour
  space unset, while the frame target's is linear. three.js shares the render context between
  them, and the context's colour space is part of the pipeline state. So every object drawn in
  both passes changed pipeline at each switch, and because a pipeline nothing uses is released, a
  new one was created every time. That made 2,367 `createRenderPipeline` calls in 40 s of
  "Goose" (28,499 in the full 216 s), against 12 now. Both targets are now linear.
- Precompile no longer compiles the scene again for targets that share the canvas pass's render
  state (`sharesCanvasPass`). Those passes reuse the same render objects, so compiling for them
  again only repeated the canvas pass item by item, yielding after each.
- *Level transitions.* `openLevel` holds three.js's shader caches (node builder states, shader
  modules, pipelines) from before the old level is disposed until the new one has compiled
  (`holdShaderCaches`). Because graphs are shared by structure, the next level's materials hit
  the caches: 1a → 1b made 43 node builds instead of 729. An in-place checkpoint restart holds
  them for 5 s.
- Main-thread work in the "Building meshes" phase:
  - the DXT decoder writes 32-bit texels from a reused palette instead of allocating per block
    and per texel. It is 13× faster over all 5,127 textures of the game data, with byte-identical
    output (checked on every texture; a unit test compares it with a byte-wise reference);
  - `readSkeleton` reads vertex positions once into typed arrays for its nearest-weighted-vertex
    search, which is quadratic. It is 2.7× faster on all 190 skeletons, with identical weights;
  - the sound banks are mounted in parallel, starting while the meshes are built.

The "compile in priority order, then finish in the background" plan was not needed. With these
changes the whole precompile takes 1–2 s and still runs behind the loading screen, so no frame
after it can hitch on a shader.

**Measurements** (1a by deep link, `?difficulty=1`; load average noted per run because other
jobs shared the machine). Before = HEAD dc1d23a, measured with the same harness.

| 1a load | Before | After |
|---|---|---|
| time to playable (navigation → loading screen gone) | 17.4 s (load 31), 22.2 s (10), 33.0 s (15) | 3.6 s (load 12), 5.4 s (15), 5.5 s (27), 7.0 s (19) |
| packages / geometry + texture decode | 0.8 / 0.6 s | 0.5 / 0.5 s |
| meshes, sound banks, systems ("Building meshes…") | 2.3 s (actors 1.5 s, world 0.8 s) | 1.3 s (actors 0.36 s, world 0.35 s; banks overlapped) |
| "Compiling shaders…" (precompile, first update, settle) | 13.6–25.3 s | 1.5–2.0 s |
| node builds / distinct keys | 1,886–2,117 / 1,024 | 158 / 158 |
| shader modules / pipelines | 566–590 / 571–592 | 189 / 149 |

| Scenario | Before | After |
|---|---|---|
| 1a → 1b transition (request → loading screen gone) | 6.9 s (load 23); 729 node builds, 271 pipelines | 2.2 s (load 15), 3.7 s (load 21); 43–45 node builds, 33–34 pipelines |
| frames after the 1b load (15 s) | p99 16.8 ms, 0 > 50 ms | p99 16.8 ms, 0 > 50 ms |
| "Goose", 216 s | 60 fps, p99 16.8 ms, 1 frame > 50 ms (67 ms), CPU p99 13.5 ms | 59.9 fps, p99 16.8 ms, 0 frames > 50 ms (max 50.0 ms), CPU mean 9.1 / p99 18.4 ms (load 21); an earlier run: 0 > 50 ms, max 33.5 ms, CPU mean 7.4 ms, with the compositor at 30 Hz (§18.7) |
| "Goose", first 61 s, `?gputime` | — | 60 fps, p99 16.8 ms, max 33.4 ms, 0 > 50 ms; GPU 3.2 ms mean / 4.4 ms p95 per frame; CPU 10.7 ms mean (load 44) |
| walking 1a (cell, corridor, guards) | 60 fps, p99 16.8 ms, 0 > 50 ms, CPU p99 12.2 ms | 60 fps, p99 16.8 ms, 0 > 50 ms, CPU p99 10.3 ms |
| pipelines created during "Goose" | 28,499 | 14 |

Every level loads faster. The first version of the sharing changes, without the later
transition, decoder and skeleton work, was measured on all 18 levels, one fresh page each:
10 Docks 20.2 → 5.5 s, 6a Woods 13.2 → 6.7 s, 2 Cellblocks 14.2 → 5.8 s, 1a 22.2 → 4.8 s, and
node builds 2–10× fewer everywhere (6a: 1,960 → 261). The look is unchanged. Screenshots of four
fixed views per level, with game time frozen and characters and particles hidden, match the old
code within its own run-to-run noise (flashlight sway, light flicker phase).

**Precompile lanes.** On WebGPU the lanes do overlap: `compileAsync` waits for each pipeline
before its next object, but the pipelines of different lanes (and of the per-caster shadow
compiles) are created concurrently, 27–34 at a time. With the builds coalesced, 1a's precompile
took 2.7 s with one lane, 2.0–2.3 s with four and 2.3 s with eight (two runs each, load 25), so
four stay.

**Frame cost of the per-object character lights and projected shadows** (§19, docs/re/renderer.md
§4), measured with `?gputime`: 60 s of "Goose" and the walk in 1a, everything else equal (load
13–42, 60 Hz in every run). The variants were made only for the measurement: shadow renders off
(`shadowMode` 0), the receiver term removed from the shaders as well, and characters lit per
vertex as before 9056853 instead of by their light set.

| Variant | Goose: CPU mean / GPU mean, p95 (ms) | Walk: CPU mean / GPU mean, p95 (ms) |
|---|---|---|
| as shipped (light sets, shadows) | 8.1 / 2.97, 4.3 | 8.8 / 3.8, 5.9 |
| no shadow renders | 6.8 / 2.91, 4.3 | 9.0 / 3.7, 6.1 |
| no shadow renders, no receiver term | 7.8 (load 21) / 2.22, 3.1 | 11.4 (load 32) / 3.2, 6.4 |
| characters lit per vertex (no light sets) | 9.9 (load 42) / 3.58, 6.3 | 9.9 (load 34) / 4.3, 6.4 |

The light sets cost nothing. They make characters cheaper on the GPU: five chosen lights per
vertex instead of a ranked loop over up to 32. The shadows cost about 1.4 ms of CPU a frame while
casters are in view (one extra render() per caster, at most four) and about 0.7 ms of GPU (the
receiver term samples four silhouettes on every lit fragment). A frame stays far inside the
16.7 ms budget, so neither was changed. Lowering the shadow update rate would make the shadows
lag their characters, which changes the look. If the GPU time ever matters, the receiver term
can be skipped behind a uniform branch when no shadow is active.

`?gputime` (src/app/renderer.ts) turns on WebGPU timestamp queries. Each frame's GPU time then
goes into `__frames.stats()` (`gpuMean`, `gpuP50`, `gpuP95`). It is off by default because the
queries cost a little.

## 19. Lighting, brightness and fog (src/app/engine-light.ts)

Sources: the vertex shader fragments in `xvsh/*.vsh` (the engine concatenates them per lighting
setup; `xvsh/ShaderLibrary.bin` holds 989 assembled vs_1_1 programs built from them, and a
disassembly of those matches the sources instruction for instruction), and SUFFERING.EXE (Direct3D 9).
**[verified]** = read in the shaders or the EXE (addresses given), **[data]** = follows from the
retail values, **[inferred]** = chosen to fit, **[port]** = no counterpart in the original.

### 19.1 The equation

Lighting is per vertex, accumulated in a register `r2` in "light units" where 1.0 means the
texture as is (after the footer's halving and texture stage 1's doubling, steps 5–6):

1. Start value [verified, xvsLightHeader / xvsLightPrecomputed / xvsLightUniform]:
   - geometry with baked colours (the level, props with .ldu colours): `r2 = 2 × vertex colour`
     (`mul r2, v10, c51.wwwx`, c51 = [1, 0.5, 0, 2] uploaded at 0x435510);
   - everything else (characters, held items, props without a bake): `r2 = c80`, the object's
     ambient colour (bytes / 255, 0x4367a1).
2. Directional lights (xvsLightDir; "only for objects without precomputed lighting"):
   `+ colour × max(N·L, 0)`. In practice these are the camera-relative rim lights (§17.7).
3. Point lights (xvsLightPoint): `+ colour × min(I / d², 2) × max(N·L̂, 0)`. The light stores
   p8 × 2048² at +0x54 (0x4c60b0), copied to the shader constant at 0x4d0609, and d is in engine
   units, so in metres the level is p8 / d²: p8 is a strength, not a radius to square [verified;
   the .ldu bake agrees, docs/re/renderer.md §1.2]. There is no fall-off to zero; the CPU picks which lights an
   object gets ("Light Radius Cutoff Factor", "Approximate Point Lights" engine properties; not
   decoded). Hemisphere lights (xvsLightPointHemiXtra): p9 = 1 lights only what is above the
   light, p9 = 2 only what is below (shader constant w = −1 / +1, 0x4d06e4) [verified].
4. Spot lights (xvsLightSpot): with `l` the distance along the axis and `r` the distance from
   it, `+ colour × max(1 − l²/L², 0) × I·l²/r² × (N·(−axis)·s + b) × (l ≥ start)`. `I` is
   0.2 × a² / L² (0x4369c8), `s, b` = (1, 0) or (0.5, 0.5) per object (c30, 0x436ad4). The
   Spot Light's p8 / p9 / p10 (× 2048) are the three lengths; the port reads them as start / cone
   radius at the range / range [inferred]. The beam is brightest on its axis and has no hard edge.
5. Footer (xvsLightFooter): `oD0.rgb = 0.5 × min(r2, 400/255)` (c82 = 1.5686, 0x43554d).
6. Texture stage 0 is `MODULATE` (texture × diffuse; 0x49aa60, 0x49acc0), and while the world is
   drawn texture stage 1 is `ADD` of CURRENT and CURRENT (0x48c4d7), which doubles it back:
   `pixel = saturate(2 × texture × oD0)` [verified, docs/re/renderer.md §1.8]. All of this
   happens on gamma-encoded values: Direct3D 9 fixed function, no sRGB conversion, no tone
   mapping.

So a baked surface with no lights near it shows `texture × 2 × vertex colour` (a bake byte of
128 is the texture as is), light level 1 shows the texture as is, and the 400/255 clamp lets a
strong light reach 1.57 × the texture before the output saturates.

**Static Point Lights are in the bake, switchable ones are not** [verified code + data,
docs/re/renderer.md §1.6]. Geometry with .ldu colours receives only switchable Point Lights at run
time (render-data.ts pointLightSwitchable); the static ones (on at start, no inputs) are part of
its colours. In 1a, vertices lit only by switchable lights keep the flat 13/255 fill however
close the lamp, while vertices near static lights are brighter. The cell-block lamps are
switchable (180 of 1a's 254 created Point Lights), so lighting the level from the bake alone, as
the port once did, left the rooms black; adding every light on top of the bake, as it did next,
counted the static ones twice. Geometry without .ldu colours is lit by a CPU pass when it loads
(static-light.ts).

Light properties [verified, 0x4c5fd0 / 0x4c60b0]: p0 colour / 255, negated when p1 is set
(negative lights), p8 radius, p9 hemisphere mode. Ambient Light p0 is the colour; it applies within
its parent group of the sector tree, the root group's one everywhere else (docs/re/renderer.md
§1.4) [strong].

### 19.2 Fog

Vertex fog (xvsHeaderFog): `oFog = 1 − (z − start) × c50.z` with c50 = [start, ?, 1 / (end − start),
start / (end − start) + 1] (0x437630), i.e. linear fog in view depth, blended towards the fog
colour by the fixed-function pipeline on gamma-encoded values. The port reads the level's Sky
Properties as end = p2 m, start = p3 × p2, colour p4 [inferred] for every level, chapter 1
included (src/game/levels/atmosphere.ts; Fog / Sky Switchers blend between them).

### 19.3 Gamma

The Graphics page's "Gamma Value" builds a hardware gamma ramp `ramp[i] = (i / 255)^(1 / g)`
(0x4b24f0, only when > 0 and the device supports full-screen gamma). The default 1.0 is the
identity; nothing else brightens the image.

### 19.4 Port

`engine-light.ts` evaluates steps 1–5 per vertex (a varying) in world space and does step 6 and the
fog in sRGB space, with no tone mapping, so the output matches the engine's arithmetic. A rig
uploads, each frame, the 32 point lights nearest the camera (level Point Lights that are on, with
Lighting Effect flicker, plus the three.js point lights of effects: muzzle flashes, fires,
explosions [port mapping: colour × intensity / 12, strength (reach / 2)²]), the flashlight as two
spots (Flashlight item Spot Light templates 4:123 beam and 4:669 spill, dimmed with the battery),
the Directional Light and rim lights and the Ambient Light regions (smallest first, docs/re/renderer.md §1.4). On merged level geometry, point lights fade out over
the last 30 % past their cull radius [port: stands in for the per-object light choice]. Precomputed materials loop over the
switchable lights only (uploaded first); placed models, floor layers and world-built props
without .ldu colours get colours from a load-time pass over the lights created before them and
are then drawn as precomputed (formats/static-light.ts, docs/re/renderer.md §1.9); spawned models
are lit like dynamic objects. Layered materials' modulate-2x detail layers
are composited on gamma values too (50 % grey is neutral). `?lighting=legacy` restores the
previous look (bake × 3 as emissive in linear space, three.js lights, ACES) for comparison.

Characters, held weapons and props take their texture from three.js's material colour node,
which samples the material's **current** `map`, not a copy made when the material was built.
Texture swaps on a live material, such as the reputation / blood skins
(reputation-skin-system.ts), therefore show at once. This was checked in the browser: setting
blood to the maximum changed the arms map from 2:70 to 2:71, and the blood appeared on screen.

### 18.5 Port: measurements

The harness lives outside the repo. At 10 viewpoints per level (Move Node positions, eye
height, random yaw), it runs headless Brave/WebGPU at 1920×1080 on an Apple-silicon dev
machine. Game systems are frozen while a view is captured. The level is rendered with culling
on and then off, and the screenshots are compared.

- **No missing geometry.** With the final rules, 0 of 180 views differ in level-only renders
  (all portals forced open, other objects hidden). 1 of 180 differs in full-scene renders
  (real door states, all objects). That one is 1b view 5, where an animated water-caustic
  material changes between the two captures, so it is not a culling difference. Before the
  visibility-list and near-field rules were added, the same test found the cases listed in
  §18.4.
- **Per view, same session, culling off → on (averages over the 10 views):** triangles drop by
  20–70 % in zoned levels (1a 290k → 101k, 1b 291k → 95k, 2 338k → 169k, 8b 260k → 82k) and by
  20–40 % in open levels through frustum and cell culling (0, 9, 10). Draw calls drop or stay
  equal (1a 586 → 448, 1b 477 → 284, 8b 234 → 164). Frame CPU time is equal or lower (1a 9.6 →
  8.3 ms, 1b 7.6 → 6.1 ms). The culler costs 0.1–0.4 ms a frame.
- **Remaining frame cost.** Most of the CPU time is three.js per-draw work, and most draw calls
  are world-dynamic props: about 1,100 meshes in level 2, one draw each, against about 330 for
  the whole merged level. The game systems together take roughly 10 % of a frame.
- **Load time.** Median time to playable went from 8.5 s to 4.8 s over all 18 levels. Both
  are production builds with game data from the dev-server middleware; "before" is a snapshot
  of the code taken before these changes. Measured on a busy machine, the same build varied by
  2–3×. The
  changes: packages are read in parallel, and the previous level's packages are reused on a
  transition. Textures decode on worker threads. Sound-bank headers (about 2,000 small reads per
  level) go to the dev server as batched ranges. All pipelines are precompiled after load.
