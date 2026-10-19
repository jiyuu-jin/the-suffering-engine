# Class properties named from the code (Suffering.rfl)

The editor class file with the real property names (`Classes\Unspeakable.rcdx`) did not ship, and
neither binary holds property-name strings (checked: ASCII and UTF-16 in `Suffering.rfl`,
`SUFFERING.EXE`, `RERES.dll`, and the package `.db` files). The names below come from the code
that reads each property, so they are descriptive names chosen here, not the original
identifiers. They are in `src/formats/property-names.ts`, which `entities.ts` merges into the
class table (`npx tsx tools/entities.ts`, `ClassDef.propNames`). Tests:
`tests/re-properties.test.ts`, `tests/weapons.test.ts`.

Tags:
- **[verified]**: read in the code.
- **[strong]**: the code plus all the retail data agree.
- **[inferred]**: a reading that fits the code shape and the data. The code was not read to the end.

Addresses are VAs in `Suffering.rfl` (image base 0x10000000).

## 0. How properties are read

- **Object properties.** An object's template property container is `[obj+4]+0xf0`. A read is
  `container->vt[2](index, -1)`, which returns a pointer to the word. In the disassembly this
  shows as `push -1; push index; call [reg+8]`. A list item is read with `(index, k)`. Its count
  is the `u16` at `+2` of the word that `(index, -1)` returns.
- **Behaviour properties.** A behaviour gets its own container through `call 0x10097b80` and then
  reads with the same `vt[2]`.
- **Finding the code.** For each class, the object factory `0x100202c0` (`cmp ecx, classId`)
  allocates the object and calls its constructor. The constructor stores the class vtable.
  Behaviour classes are mapped to a type index by `0x10106d40`. Their vtables are in `.rdata`,
  just before the behaviour's short name (for example "RootPlayAnim").
- **Data-only classes.** Attack, Damage Resistance, Line of Dialog and Radius Damage, among
  others, have no logic of their own. They are read by the code that holds them.
- **Units.** Distances are in model units (m). The code multiplies them by 2048 (engine units),
  using the float `2048.0` at `0x1014b6e8`. Percentages are multiplied by `0.01` (`0x1014b6d8`).

## 1. Damage record and damage types [verified]

Every damage source fills the same 0x4c-byte record through constructor `0x10001190` (13 stack
arguments). GameObject damage `0x100a31b0` takes **`+0x14` as the damage amount**:

- If the object resists, it calls `0x100a2dc0`.
- If the result is positive, it fires output `p15` (Damaged).
- It then calls `vt[0x8c](amount, attacker)` to subtract health.

| Field | Argument | Meaning | Source values |
|---|---|---|---|
| `+0x14` | 1 | **damage** | Missile `p26`; Melee `p68` × Attack `p6`; Radius Damage `p0`→`p1`; Damage Action Object `p4` |
| `+0x24` / `+0x26` | 2 / 3 | attacker / inflicting object (handles) | |
| `+0x1c` | 4 | **impact force** | Missile `p28`→`p29` falloff; Melee `p69` × Attack `p7`; Radius Damage `p2`→`p3`; Damage Action Object `p6` |
| `+0x40` | 5 | **damage type** | Missile `p32`, Melee `p70`, Radius Damage `p10`, Damage Action Object `p5` |
| `+0x00`, `+0x18`, `+0x0c`, `+0x10` | 6–9 | Attack `p35`, `p34`, `p36` × 2048, `p37` (melee only; 1/0/0/0 otherwise) | [unknown use] |
| `+0x48` | 13 | attack stimulus template (InvestigateSound) | Radius Damage `p4`, Damage Action Object `p7` |

**Resistance** (`0x100a2dc0` with lookup `0x100a2950`):

1. The multiplier starts at 1, or at 0 when GameObject **p5** is set (`immuneToUnlisted`).
2. The first Damage Resistance in the object's attachments (`p7`) whose `p0` equals the damage
   type replaces the multiplier with its **p1**.
3. If no attachment matches, a global default list is searched. That list is `p46` of the
   template at `[0x1017bf40]+0xa4`.

**Damage-type numbers.** The names are not in the binaries. The numbers below are what the code
or the data ties them to. The "Code" column is read code [verified]; the role of each number is
[inferred]:

| Type | Used by | Code |
|---|---|---|
| 1 | bullets (revolver, tommy gun, NPC guns, needles) | |
| 2 | fire axe, creature claws | Character damage `0x100e7453`: no damage from a teammate of the same team |
| 3 | TNT, Shrapnel, explosive props | passed as "explosive kill" to the kill-reputation code at `0x100e75cd`; a dying character in the "dying" state still takes it (`0x100e774f`) |
| 5 | Molotov, fireballs | |
| 6 | — | sets the character's burning flag (`0x40000`) and stores the hit position (`0x100e767d`) |
| 8 | Gonzogun, Hermes | |
| 9 | Horace bolts, Burrower | |
| 10 | shiv, unarmed | |
| 11, 16 | creature specials | |
| 13 | shotgun pellets | |
| 17 | Fire effect | |
| 19 | Flash/Bang | |

The port's `DAMAGE_TYPE` (bullet 1, explosion 3, fire 5, melee 10) in `world/damage.ts` matches.

## 2. Weapons

### Missile and BouncingObject (shared base, properties 0–48)

Code: launch `0x100cf8b0`, impact `0x100d1450`.

| p | Name | Meaning | Tag |
|---|---|---|---|
| 1 | `speed` | launch speed (units/s) | verified |
| 2 | `speedMax` | upper speed when the launch carries a strength, `p1 + (p2 − p1) × strength` | verified (`0x100cfa33`) |
| 12 | `lifetime` | seconds before it expires or detonates (the grenade fuse, the flare's 20 s) | verified (`0x100cf8e9`) |
| 14 / 16 | `impactNoise` / `fireNoise` | InvestigateSound (see game-logic §15.9) | data |
| **26** | `damage` | **damage per projectile, flat**. Previously documented as "impact force". | verified (`0x100d1921`) |
| 28 / 29 | `forceNear` / `forceFar` | impact force within `p30` m / beyond `p31` m, linear between. Previously documented as the damage. | verified (`0x100d17a0`) |
| 30 / 31 | `forceNearDist` / `forceFarDist` | m | verified |
| 32 | `damageType` | see §1 | verified |
| 34 | `impactGenerators` | spawned on impact or detonation | verified (`0x1009a230`) |
| 40 / 41 | `tracer` / `materialEffects` | | code (game-logic §4.4) |
| 46 / 47 | `gravityPct` / `gravityRandomPct` | gravity, as a percentage of the world's (`[0x1017bf40]+0x90`), ± a random amount | verified (`0x100cfb81`) |

Retail damage per projectile:

| Projectile | Damage | Damage × pellets | Force |
|---|---|---|---|
| revolver `4:6` | 6 | | 6 |
| tommy gun `4:256` | 4.5 | | 5 |
| shotgun pellet `4:85` | 4 | ×6 = 24 | 20 → 2 over 4–20 m |
| Gonzogun `4:828` | **200** | | 30 |
| guard pistol `10:1741` | 3 | | |
| Slayer bullets `10:1797` / `10:1798` | 5 / 10 | | |
| Mainliner needle `10:1814` | 10 | | |
| Horace bolt `10:1793` | 35 | | |

The flat `p28` the port used before matches `p26` only for the revolver.

**BouncingObject only.** Code: collision `0x1009a8c0`, settle `0x1009a470`.

| p | Name | Meaning | Tag |
|---|---|---|---|
| 49 | `settleBounces` | bounces after which it stops and settles (0 = never) | verified |
| 50 | `anySurfaceBounces` | 1 = any hit counts as a bounce; 0 = only hits whose normal faces up | verified |
| 51 | `bounceSpeedLossPct` | % of speed lost per bounce, multiplied by the surface Material Type's `p4` % | verified |
| 54 | `settleFuse` | after settling it goes off `p54` s later, by shortening the remaining lifetime | verified |
| 57 | | orientation mode on settling (0 none, 1 align to the floor, ...) | inferred |
| 59 | | 1 on the Flash/Bang and the flare | unknown |
| 60 / 61 | `detonateOnCharacter` / – | goes off at once when it hits a character (TNT, Shrapnel); `p61` takes the same branch | verified |

Retail throwables:

| Throwable | `p49` | `p51` | `p54` | `p60` | Result |
|---|---|---|---|---|---|
| Molotov `4:245` | 1 | 50 | 0 | 0 | goes off on its first impact |
| Flash/Bang `4:280` | 1 | 50 | 0 | 0 | goes off on its first impact |
| Shrapnel `4:621` | 2 | 75 | 0 | 1 | goes off on its second bounce, or at the 2 s fuse |
| TNT `4:81` | 3 | 70 | 0 | 1 | goes off on its third bounce, or at the 2 s fuse |
| flare `4:452` | 4 | 70 | 2 | 0 | settles after 4 floor bounces (`p50 = 0`); its detonation generator is its burn |

The thrown launch speed is `p1` = 70000 units/s (34 m/s). The world gravity that `p46` scales
is Level Properties p19 x p18 units/s² [verified]: in every chapter 1 level that is
9.8 x 2175 units/s², or 10.41 m/s² at 2048 units per output metre (game-logic.md §14.2). The
throw code that sets the launch direction was not decoded, and the port keeps its 40 % launch
factor. A BouncingObject that a generator spawns flies along -local Z at p1 (`world/fx.ts
bouncingLaunch`). A bounce reflects the velocity and scales it by (1 - GMP p4 %) x (1 - p51 %)
[verified: 0x1009a3b0 / 0x1009adae].

### Radius Damage

Code: `0x10125c70`, called on the vtable at `0x1014d804` [verified].

1. Objects are queried within `p5` m.
2. For each object, `f = max(0, 1 − d / p5)`.
3. Damage = `p1 + (p0 − p1) × f`. Force = `p3 + (p2 − p3) × f`. Type = `p10`.

| p | Name | Meaning |
|---|---|---|
| 0 / 1 | `damageCentre` / `damageEdge` | damage at the centre / at the edge |
| 2 / 3 | `forceCentre` / `forceEdge` | **impact force**. Previously documented as the outer and inner radius. |
| 4 | `stimulus` | attack-stimulus template, stored in record `+0x48` (Flash/Bang `2:736`) |
| 5 | `radius` | m |
| 6 | | when 0, the player is skipped while his state flags `+0xa4` bit 8 or 9 are set |
| 7 | `hurtsOwner` | the object that caused it is damaged too |
| 8 | `needsLineOfSight` | two rays (`0x100c6e90`, mask `0x802`); a target is skipped when both are blocked |
| 9 | `victimEffect` | effect spawned on each victim (`0x100725e0`), e.g. Molotov `4:1332` |
| 10 | `damageType` | |

Retail values:

| Explosive | Damage | Radius | Force | Type |
|---|---|---|---|---|
| TNT `4:215` | 40 → 10 | 13 m | 20 → 8 | 3 |
| Shrapnel `4:622` | 65 → 15 | 18 m | 24 → 12 | 3 |
| Molotov `4:248` | 10 → 6 | **4 m** | 20 → 13 | 5 |
| Flash/Bang `4:282` | 4 → 1 | 13 m | 30 → 16 | 19 |

### Melee Weapon

Code: hit `0x100ca920` [verified].

| p | Name | Meaning |
|---|---|---|
| 68 | `damage` | flat, no random range. Shiv 8, fire axe 15, Gonzo melee 35, creature claws 7–100. |
| 69 | `force` | impact force. Previously documented as the "damage max". |
| 70 | `damageType` | |
| 71 / 74 / 77 | `swingSounds` / `hitSounds` / `materialEffects` | data, game-logic §4.4 |

**Attack** (the current attack, at weapon `+0xfc`):

- `p6` `damageMult` multiplies `p68`. It applies only to the attack's first target or to the
  target it was aimed at (`+0x100`).
- `p7` `forceMult` multiplies `p69`. **p7 was "unknown".**
- `p34`–`p37` go into the damage record (see §1).
- Retail `p6` = 999 on grab and finishing attacks (an instant kill). `p6` = 0 on two creature
  grabs (no damage).

### Ranged Weapon

The fire-routine fields are in game-logic §4.4. New reads:

| p | Meaning | Tag |
|---|---|---|
| 72 | sound played at the weapon by the player code `0x10029830`; returns −6 when unset | verified, role not read |
| 73 / 74 | weapon-model clips: `p73` is started on the weapon's rig by `vt[49]`, and `vt[8]` stops it while `p73` or `p74` plays (tommy gun 4:16, flamethrower 4:33) | inferred: a firing loop |
| 84 | read by `0x10127010`; 1 only on the flamethrower | unknown |

Weapon base 55–63 is read only by the shared Item/Weapon code (`0x1013b6d0`–`0x1013bc20`). It was
not named.

### Flashlight

Code: update `0x100142b0`, constructor `0x100141b0`, switch on `0x10013dd0`, switch off
`0x10013ce0`, new battery `0x10013f30`, set charge `0x100139a0`. Automatic battery use is in the
player update at `0x10044035` [verified].

| p | Name | Meaning |
|---|---|---|
| 55 / 56 | `spotLight` / `spotLight2` | |
| 60 | `decoration` | |
| 61 | `deadBatteryLevel` | the beam's level once the charge is gone (0.25). **The lamp stays on.** |
| 62 | `adaptedBrightnessPct` | scene brightness % reached while the lamp is on (60) |
| 63 | `switchOnBrightnessPct` | scene brightness % at the moment it is switched on (100) |
| 64 | `switchOnFlashPct` | a second renderer value set at switch-on (8 %) |
| 65 / 66 | `adaptOnSeconds` / `adaptOffSeconds` | brightness adaptation time after switching on (2.9 s) / off (5 s) |
| 67 | `fullChargeSeconds` | **105** s of full light per battery |
| 68 | `dimSeconds` | the beam then fades over 3 s down to `p61` |
| 69 | `batteryItem` | `4:203`. While the lamp is on and dimming or dead, a battery is used automatically if the player has one: the charge resets to `p67` + `p68`. |
| 70 | `difficultyModifier` | the drain is `dt / modifier` |

Nothing recharges while the lamp is off. The port's old reading had a 60 s charge, flickering
below 25 % and recharging at 3/s while off. All three were wrong.

## 3. Characters and behaviours

**RootPlayAnimBehavior** [verified]. Code: start `0x100e8c10`, update `0x100e8c50`, clip
finished `0x100e8d80`.

| p | Name | Meaning |
|---|---|---|
| 2 | `clips` | |
| 3 | `inOrder` | 1 = in order; 0 = a random clip each time |
| 4 | `playCount` | the behaviour completes after `p4` clips (0 = no limit) |
| 5 | `timeLimit` | the behaviour completes after `p5` s (0 = none) |

With both limits 0, it plays until a Behavior Changer replaces it. Retail confirms this: every
placed instance with `p4` = `p5` = 0 has no follow-up link (a looping pose). Every instance that
links on to another behaviour has `p4` = 1 or a `p5`.

**HoraceKillPlayerBehavior** [verified]. Code: `0x10077e00` / `0x100780a0` / `0x10077f60`.

| p | Name | Meaning |
|---|---|---|
| 2 | `triggerMessage` | Horace sends it to himself after a random `p4`..`p5` s, unless he is at his last stage (6 Triggered) |
| 3 | `endMessage` | ends the behaviour early (350 QuestStart) |
| 4 / 5 | `triggerDelayMin` / `triggerDelayMax` | 0.01..0.5 s |
| 6 / 7 | `durationMin` / `durationMax` | 21..21 s, after which the attack sub-behaviour starts on the player |

The old reading of "p2 reach, p3 damage 350" was wrong. `specials/horace.ts` already follows the
code.

**RatSpawnBehavior**: `p3` (type `0x11`, value 8) was not reached. The behaviour's vtable functions
(`0x10086970`, `0x10086d60`) read `p2`–`p4` of a different template. Still open.

**WaypointBehavior p3, FleeBehavior choice, Line of Dialog p3, Action Dialog barks, Character
groups 25+**: not decoded in this pass. Their readers are behaviour sub-objects whose vtables
could not be tied to the template class quickly. The candidates are listed in the scratch notes.

## 4. Level logic

**Combat Music** [verified]. Code: activation `0x100a0670`, tick `0x100a0740` (called once a second
by the player at `0x10042790`), start `0x100a0260`, stop `0x100a0050`, count `0x100a0550`.

| p | Name | Meaning |
|---|---|---|
| 0 | `tracks` | one is picked at random |
| 1 | `startEnemies` | start when at least `p1` enemies are near... |
| 2 | `startRadius` | ...within `p2` m of the player |
| 3 | `keepEnemies` | keep going while more than `p3` enemies are near... |
| 4 | `keepRadius` | ...within `p4` m |
| 5 | `lingerSeconds` | ...and for `p5` s after that, then stop |
| 6 | `fadeInSeconds` | |
| 7 | `fadeOutSeconds` | |
| 8 | `replaceFadeSeconds` | used with `p12` |
| 9 | | not read |
| 10 | `activeAtStart` | |
| 11 | `inMakeCurrent` | input |
| 12 | `replacePlaying` | on trigger, fade the playing music out over `p8` s and start this one |
| 13 | | template read at start; role not read |

An "enemy" (`0x100e4a50`) is a living character that is in combat (`vt[0x9c]`) and visible
(flags `0xc`), not on the player's team, that has the player among its targets, and is within the
radius. When the Combat Music object has links, only the linked characters count. **p1 is a
count, not a mode.** The port's "1 = scripted cue that plays at once" was wrong: 1a's cues
(`84bd`: 1 enemy within 25 m; `8b97`: 1 within 15 m) still wait for a creature.

**Message Relay** [verified]. Code: relay `0x100cbc50`, init `0x100cb9c0`.

- `p1` `count`: ≤ 0 means unlimited.
- **`p2` `pickCount`**: 0 sends `p8` to every link. Otherwise the relay sends to `p2` links.
- **`p3` `pickMode`** chooses those links:
  - 0: the next link in order;
  - 1: a random link;
  - 2: a random link not used yet.

  Modes 0 and 2 refill the pool from the links once it is empty.

Retail: 19 relays use it. They pick one random Speech Player from a set, which gives
non-repeating barks. In 1a, the eight Speech Players of `83a2` speak in order, and the lights of
`846e` switch one after another.

**Damage Action Object** [verified]. Code: `0x1008e910`.

| p | Name | Meaning |
|---|---|---|
| 0 | `targetMode` | which objects are damaged: 0 the message sender, 2 the links, 1 both (data, game-logic §15.3) |
| 3 | `perSecond` | 1 = `p4` is per second |
| 4 | `damage` | |
| 5 | `damageType` | |
| 6 | `force` | |
| 7 | `stimulus` | stored in record `+0x48` |
| 8 | `targetEffect` | `0x2d326c65` (Electric Arc Effect) is special-cased |

**GameObject p5** `immuneToUnlisted` [verified]: see §1. **GameObject p2** `difficultyModifier`
[strong] (game-logic §4.4).

**Breakable p17** was not reached. The Breakable vtable reads only `p18`–`p20` and `p46` of the
global resistances.

**Level Transition p4/p5/p8/p9** were not reached. Only the constructor reads `p6`.

## 5. Port changes made with these findings

| File | Change |
|---|---|
| `src/game/weapons/data.ts` | Missile damage = `p26` (flat). Force falloff `p28`–`p31` (`projectileForce`). Melee damage `p68` flat and force `p69`. Attack `forceMult` `p7`. Radius Damage decoder `radiusDamageDef` (`p5` radius, `p0`/`p1` damage, `p2`/`p3` force, `p7`–`p10`). Thrown bounce fields (`p49`/`p50`/`p51`/`p54`/`p60`). |
| `src/game/weapons/system.ts` | Explosions use `p5` with the falloff from the centre. Self-damage needs `p7`. Throwables bounce with `1 − p51 %` and settle or detonate by `p49`/`p54`/`p60` (the old "Molotov type 5 breaks" guess is gone). Flashlight: 105 s full, 3 s dimming to 25 %, no recharge, automatic battery. |
| `src/game/actors/manager.ts` | NPC shot damage = Missile `p26` × generator count (guards 3, Slayers 5/10, needles 10, Horace 35). |
| `src/game/actors/specials/params.ts`, `src/game/insanity/system.ts` | Radius Damage radius = `p5`, inner 0. |
| `src/game/actors/behaviors.ts`, `actor.ts` | RootPlayAnimBehavior `p3`/`p4`/`p5` as above. HoraceKillPlayerBehavior comment. |
| `src/game/actors/director.ts` | Damage Action Object passes damage type `p5`. |
| `src/game/world/music.ts` | Combat Music counts as above, ticked once a second. |
| `src/game/world/logic.ts` | Message Relay `p2`/`p3`. |

Not applied, because the file belongs to another workstream: `src/game/world/props.ts` handles
the Radius Damage spawned by breaking props as `p3 / 2` radius and `p0` flat. It should be
radius `num(v[5])`, `amount: num(v[0])`, `minAmount: num(v[1])`, `innerRadius: 0` and
`kind: num(v[10])`.
