# Original player rules (Suffering.rfl)

Movement, jumping and falling, fall damage, the console auto-aim and Auto Pitch Correction,
the option flags, and the PC key tables. Read from the Player class code in `Suffering.rfl`
(base 0x10000000) and the System package templates. Addresses are VAs.

Tags:
- **[verified]**: read in the code.
- **[strong]**: the code plus the data or the names agree.
- **[inferred]**: a reading that fits.

**Units.** Template distances are in model units. The code multiplies them by 2048 to get
engine units, which is how engine positions are stored. The port uses 1 model unit = 1 m
(`ENGINE_UNITS = 2048` in `src/game/weapons/data.ts`), so every distance below is also in port
metres. Speeds are in model units per second, and angles are in degrees unless stated.
The frame time is the float at `[0x1017bf40]+4`. Player properties are read through
`[obj+4]+0xf0`, the template property container; vtable `+8` takes `(index, -1)`.

Templates:
- Player `2:5` (the creature form is `2:240`);
- the current Player Weapon Properties ("PWP"; revolver `2:436`, unarmed `2:409`), held at
  Player `+0x3ec`;
- the level Camera `2:6`.

Code:
- `src/app/player-rules.ts`: constants and pure helpers;
- `tests/re-player.test.ts`: tests.

## 1. Player states (corrected table layout) [verified]

The table at `0x10176488` is filled by the static initializer `0x10145e50`. Its entries are
0x3c bytes long.

**Layout correction.** The handlers of state *n* are in entry *n* (`+4` enter, `+0x14` per
frame, `+0x24` leave). The state's name pointer `+0x38` and id `+0x34`, however, are stored at
the end of entry *n−1*. Reading name and handlers from the same entry shifts every state by
one.

The states this file uses:

| State | Enter | Per frame | Leave |
|---|---|---|---|
| 1 Move | 0x10045500 | 0x10045d70 | 0x10045770 |
| 2 Aim | 0x10047630 | 0x10045830 | 0x10045890 |
| 3 Attack | 0x10029990 | 0x10028830 | 0x10029000 |
| 5 Turn | 0x10045540 | 0x10046dc0 | – |
| 6 Idle | 0x100485c0 | 0x100487d0 | 0x100486c0 |
| 8 Jump | 0x1003adf0 | 0x1003b210 | 0x1003b520 |
| 9 Fall | 0x1003b6c0 | 0x1003ab30 | 0x1003be80 |
| 10 Pitch | 0x1003ed40 | 0x1003f930 | 0x1003eb40 |
| 12 Landing | 0x1003b990 | 0x1003bce0 | 0x1003bfc0 |
| 15 Roll | 0x1003aa00 | 0x1003b690 | – |
| 16 First Person | 0x10042400 | 0x10042ef0 | 0x100433b0 |

A state's bit is `1 << n` in `+0xa4`. For example, `+0xa6` bit 0 is state 16, First Person.

The main per-frame routine is `0x1004c1c0`. In order, it:

1. runs the auto-target search `0x1004ba30`;
2. if the search found a target, requests state 5 (Turn), so the turn handler can track it;
3. requests state 10 (Pitch) every frame, through the input handler at `0x10049844`.

## 2. Option flags (settings object `0x1017ac3c`, flag word `+0x30` = `0x1017ac6c`) [strong]

The defaults routine is `0x10007400`, and `0x10007530` copies the settings in from the
settings file.

| Bit | Meaning | Default | Read at |
|---|---|---|---|
| 0x10 | Invert pitch | off | 0x1003f967 (pitch input × −1), 0x10035a99, 0x10012606 |
| 0x20 | Controller vibration | on | 0x100b1b22, 0x100b2856 |
| **0x40** | **Auto Targeting** | **off** | 0x1004baa3 (auto-target search), 0x100284e6 (shot aim), 0x1001920c (mounted gun aim) |
| **0x80** | **Auto Pitch Correction** | **off** | 0x1003fc6f (Pitch per-frame, the auto-level branch) |

Other fields of the settings object: `+0x1c` turn sensitivity (1.0) and `+0x20` pitch
sensitivity (1.0).

How the two console bits were identified: the PC options pages never create these two rows.
Bit 0x40 gates the target search and the shot snap. Bit 0x80 gates the pitch auto-level and
nothing else. Both are off in the PC defaults. **On PC neither feature runs unless the
settings file sets the bit.** The port enables them for gamepad play only (§9).

## 3. Console auto-aim

### 3.1 Target search `0x1004ba30` [verified]

The search runs every frame and writes the handle at Player `+0x664`. It requires:
- the held item is a **Ranged Weapon** (class `0x9710d816`; checked at `+0x3c6`);
- option bit 0x40 is set;
- Player `+0x9c` bit 0x400 is clear.

The search volume is a pyramid built from the camera matrix (`[0x1017bf68]+0x138`):
- **Apex:** the camera position in first person or state 22; the player's eye (`0x100458e0`)
  otherwise.
- **Axis:** the camera's −Z.
- **Length:** the current PWP **p10** × 2048. That is 45 for the revolver, shotgun and tommy
  gun, 0.01 unarmed, and 2.5–6 on the melee sets.
- **Half-widths at the far end:** sin(p176 = 3°) × length on one camera axis, and
  sin(p177 = 5°) / sin(p178 = 5°) × length on the other.
- **Axis mapping [inferred]:** the camera's X row is taken as horizontal, so the cone is ±5°
  horizontal and ±3° vertical.

The pyramid is passed to the selection routine `0x1004a250(frustum, 0)`. If the result
differs from the old target, `0x1004c170` is called, which stores the target's position for
tracking (§3.3).

### 3.2 Selection `0x1004a250` [verified]

The routine loops over all characters (type 7; list `0x1017bfa8`, count `0x1017bfb0`). A
candidate must pass these tests in order:

1. **Priority:** character `+0x5c4` ≥ the current best priority, which starts at Player
   **p219 = 5**. `+0x5c4` is the character template's **p128**, read at 0x10070990 and
   0x100e5400. Behaviours write −1 to it at 0x10081801 and 0x10081b89, and later restore it.
2. **Alive / attackable:** `0x100e4a50`.
3. **In front:** the dot product of the direction with the eye-to-target vector is > 0.
4. **In range:** distance < the pyramid length. The target point is `0x1009e0f0`, its aim
   point.
5. **In the pyramid:** at least one of the character's hit spheres (`+0x1e2` → list
   `+0x12e`) intersects the pyramid (`0x1000d860`).
6. **Line of sight:** a ray from the eye to the target passes (`0x100c7270`). The target is
   flagged `+8 |= 0x400000` during the test so it does not block its own ray.
7. **Score:**

   score = p224 · √(nx² + ny²) + p225 · d / range

   with:
   - nx = x / (d · sin p220) and ny = y / (d · sin p221 or p222), where x and y are the
     offsets along the camera's X and Y rows and d is the distance along the axis (p221 is
     used when the target is above the axis, p222 when below);
   - p220 = p221 = p222 = 1°, p224 = 1, p225 = 0.1.

   nx and ny are therefore about the angular offset in degrees.

A candidate replaces the best one when its **score is lower or its priority is higher**. The
best score starts at p224 + p225 = 1.1.

**Net effect:**
- the highest priority wins, and among equal priorities the best-centred one wins;
- a candidate of priority exactly 5 must be within about 1° to be picked;
- there is no hysteresis: the search runs again from scratch every frame.

Chapter 1 p128 values [data, template dump]:

| Characters | p128 |
|---|---|
| CartWheeler, Slayer, Rat, Nooseman, Mainliner, Fester | 10 (some variants 5) |
| Human NPCs (Unspeakable NPC) | 1 |
| Horace, Killjoy | 0 |

**Only creatures are ever auto-targeted.**

### 3.3 What the target does [verified]

- **Yaw (Turn per-frame `0x10046dc0`):** with a target and turn input, the turn input is
  scaled:
  - standing (`+0x146` = 0): × p182 = **0.125**;
  - moving: × lerp(p184 = **0.55**, p185 = **0.10**, t), with t = clamp((d − p180·2048) /
    ((p181 − p180)·2048)), where p180 = 2 and p181 = 35 model units.

  With a target and no turn input, the yaw is set to keep the target centred. The required
  angle is converted into a rate and is not clamped, so the correction completes in one frame.
  This happens only when all of these hold:
  - the relative motion is non-zero: the player's frame displacement plus the target's
    displacement, from `0x1003f170`;
  - the target is farther than p188 = 3;
  - the target is a character whose p129 ≠ 0.
- **Pitch (Pitch per-frame `0x1003f930`):** the same tracking, using p189 = 3 as the
  near-distance cut-off. Pitch input is scaled by p186 = **0.5** when standing and p187 =
  **0.7** when moving. Every frame with a target, the auto-pitch timer `+0x60c` is reset to
  p197.
- **Shots (`0x10028490`, called when a Ranged Weapon fires):**
  1. The crosshair pick `0x1004ad20` casts a ray from the eye along the camera's forward
     vector, 100000 engine units long. The object hit is stored at Player `+0x3ce`.
  2. If the ray hits a character (or a special object, `0x1009b9e0`), the shot target is
     cleared. Otherwise a narrow pyramid is built (p220/p221/p222 = 1°, range PWP p10), and
     `0x1004a250` stores its pick as the shot target (vtable `+0x70`, read back from Player
     `+0xc`).
  3. **Only when bit 0x40 is set**, `+0xc` is used: the weapon aims at that target's aim
     point (`0x101273a0` writes weapon `+0xd8` = target and `+0xcc` = point). Otherwise the
     weapon aims at the crosshair point.
  4. The weapon's **`+0xda` is always the crosshair-ray hit object** (Player `+0x3ce`), not
     the auto-target.
- **Ranged Weapon p76 (45°) [verified, `0x10127fb8..0x10128083`]:** the fire routine always
  shoots from the muzzle toward the aim point.
  - p76 checks the **muzzle bone's forward axis** against that shot direction. If the dot
    product is below cos(p76), **no projectile is spawned** (the code jumps to the tail at
    `0x101282af`).
  - The check is skipped when the `+0xda` object passes `0x100a2010` with its `+0x1e` and
    `+0xe` fields both 0, or when the aim vector is degenerate.
  - So p76 is a "the barrel must roughly face the target" sanity check. It is **not** an
    aim-assist cone. The earlier reading in `docs/frontend.md` §13.1 is wrong on this point.

### 3.4 Auto Pitch Correction (Pitch per-frame `0x1003fc40..0x1003fcfa`) [verified code; trigger strong]

A timer at Player `+0x60c`:
- is set to **p197 = 2.2 s** when Move leaves (the player stops, `0x100457d0`), when Attack is
  entered (`0x100299c8`), when Pitch is entered with pitch input (`0x1003edbb`), and every
  frame a target exists (`0x1003fc3a`);
- counts down by the frame time.

When the timer is ≤ 0, Player `+0x9c` bit 0 is set, and option 0x80 is on, the frame's pitch
input is **replaced** by a move toward level at the pitch rate (p190 / p191 = **42°/s**, third /
first person). The step is clamped so it never overshoots 0.

`+0x9c` bit 0 is set by the Move per-frame `0x100460e4` only while the move vector is
non-zero **and not in first person**, and is cleared by Move leave.

Net effect: in third person, after 2.2 s of continuous movement the view eases back to level.

The normal pitch rate is p190 (third person) / p191 (first person) × the axis value × pitch
sensitivity × 2. The clamps are p198 / p199 = 50 / 50 in third person and p200 / p201 = 75 / 65
in first person. Half of the pitch (p194 = 50 %) goes to the spine, as described in
`game-logic.md` §4.5.

## 4. Player `+0x98` bit 0 = on the ground [verified]

| | Sites |
|---|---|
| Set | the landing helper 0x1003a91b (`0x1003a8d0`); Landing enter 0x1003b9ad; Move per-frame while moving 0x10046188; Idle per-frame 0x100489fd; View Monitor leave 0x10034870 |
| Cleared | Jump enter 0x1003b015; Fall enter 0x1003b7bd; Fall per-frame 0x1003abb2; Jump Attack 0x1003b59a / 0x1003b653; Jump Melee Attack 0x1003a96b |
| Read | the meter gain 0x10033947: **p262 (1.4) applies when the bit is clear, so kills made in the air are worth 1.4×** |

The port already passes `airborne: !player.onGround` (`src/game/insanity/system.ts`), which
matches.

## 5. Jump, fall, landing and fall damage

### 5.1 Jump [verified]

**Third person (Jump enter `0x1003adf0`).** The stick direction relative to the facing picks
the clip:
- stick below 0.2: standing jump (PWP p151, revolver set 2:87);
- otherwise, within PWP p168 = 45° of the facing: forward jump (p152, 2:86);
- within PWP p169 = 135°: the third jump clip (p153, 2:85).

The trajectory is the clip's root motion; there is no velocity constant. The jump "power"
`0x1003a590`:
1. clamps the Jump action's analog value to [p209 0.4, p210 0.8] (pressure buttons);
2. maps that range linearly onto [p211, 100] %, with **p211 = 100 → always 1.0**.

The power scales the root motion and the playback rate (1 + (1 − power)/2 = 1).

**First person (input handler `0x100497e2..0x1004983f`).** Jump enters Fall directly with an
upward velocity of **p215 = 10** (× 2048). It sets `+0x98 |= 0x800` (FP jump), which enables
air control (§5.2) and moves the fall-damage reference up by 2764.8 units = **1.35**
(0x1003b927). This happens only when not already in Fall.

### 5.2 Fall per-frame `0x1003ab30` [verified]

- **Gravity:** vy −= **p214 = 24.4** × dt (× 2048). The gravity factor is 1, or PWP p170
  (0.5 armed, 0.3 unarmed) while Player `+0xac` bit 13 is set [condition unknown].
- **Velocity on entering Fall:** the motion keeps the velocity it had on entering Fall. If
  that velocity is zero, it takes the current clip's root velocity. Walking off a ledge clamps
  vy ≤ 0 (`0x1003b768`).
- **FP-jump air control (`0x1003a6e0`):** the stick input × **p216 = 7.5**/s, added to the
  displacement.
  - Third-person air-steer values: p205 = 1, p206 = 7, p207 = 3, p208 = 3, chosen by the jump
    type `+0x684` [inferred mapping].
  - In the Fall code the air-control helper is gated by the FP-jump flag.
- **Falling clip:** after dropping p217 = 0.6 below the start point, the falling clip starts
  (`0x1003a430`).
- **Long-fall clip:** after dropping more than **p213 = 7.7** below the start point, the
  long-fall clip PWP p157 plays. This happens only in third person and not while hit-reacting.

### 5.3 Fall damage `0x1002db30` [verified formula; gate inferred]

Called from Landing enter (`0x1003b9c8`) and from the first-person landing (`0x1003a914`).
Both calls run only when Player `+0xac` bit 9 is set. That flag's source was not traced; it is
presumably set during normal play.

| Term | Value |
|---|---|
| h | `+0x166` − current Y |
| `+0x166` | the Y on entering Fall (0x1003b6cc); + 1.35 for a first-person jump |
| f | clamp((h − **p212 6.5**) / (**p213 7.7** − 6.5), 0, 1); nothing below 6.5 |
| water | f × (1 − p27 %)^(x / 2048) when the player is in water (p27 = 10): `+0x66` is his water-effects component (fed by contacts with Water Volumes, 0x1002cefb -> 0x1013b330), `+0x6a` its in-water flag, x its depth (0x1013ab10) [verified; docs/levels.md §4.2]. Ported: `fallDamage(..., water)` with `services.water.player` (fx/system.ts) |
| damage | max(maxHealth · f, health · f): **lethal from 7.7 up**, linear from 6.5 |
| damage type | **7** (damage record built at 0x1002dcd2, applied by `0x100a31b0`) |

There is no fall-velocity threshold; only height counts.

### 5.4 NPCs

FallBehavior / JumpBehavior are clip-driven (`game-logic.md` §15.2). This pass did not decode
any fall-damage rule for NPCs.

## 6. Movement [verified unless marked]

**Clip-driven locomotion.** Move per-frame `0x10045d70` picks a heading set from the stick
direction relative to the facing (`0x10045200` / `0x10045290`). The sets are five-property
groups of the current PWP: {heading°, walk clip, walk speed, run clip, run speed}, starting
at p17.

For the revolver and unarmed sets, forward is p17 = 45° with:
- walk clip 2:30 at **1.63**/s;
- run clip 2:28 at **6.64**/s.

The speed slot is read next to the clip (0x100462be / 0x100462da). The gait clips have no root
motion: the position advances by the current speed × the stick direction (0x100467dd..0x10046872),
and the speed slot is the speed the clip's feet are animated for [verified]. Sectors, body turn
and playback: docs/re/animation.md §9 "Third-person locomotion".

**Walk or run.** The analog magnitude is compared with a threshold at `+0x156`. When the
Run/Walk action (0x411) is held on a digital device, magnitude = 1 − its value
(0x10045def..0x10045e13). So **running is the default** and holding Run/Walk (Left Shift)
walks [strong].

| Movement constant | Value |
|---|---|
| Creature form (PWP of 2:240) | run 9.28/s (× 1.40), see `game-logic.md` §13.2 |
| Move while aiming | requires the stick magnitude to be ≥ p144 = 0.7 (`0x10046119`) |
| Crouch | no PC action; Crouch is an engine addition |
| Acceleration | linear toward the set speed: p146 / p147 = 9 m/s², p148..p151 = 30, first person p152 / p153 = 1000 (0x100465db..0x100467d7) |

**Turn rate (Turn per-frame `0x10046dc0`).** Rate = turn axis × turn sensitivity × one of
these properties, chosen by state:

| Property | Value (°/s) | When |
|---|---|---|
| p158 | 220 | standing |
| p161 | 220 | in Move |
| p164 | 220 | Aim |
| p167 | 220 | first person |
| p170 | 220 | airborne: Jump, Fall, Landing, Jump Attack, Jump Melee Attack |
| p173 | 350 | melee, while auto-facing the melee target with no turn input |

The applied speed is `+0x17a`. `+0x17e` approaches it at the rate in `+0x182`, set to 1e6, so
in effect instantly. The second and third values of each triple (250, 3000) are read
elsewhere [unknown].

## 7. Camera

- **First person:** see `game-logic.md` §4.5 (p106..p108 offset, p109..p112 bones). In short:
  - [verified] The camera copies the player's matrix, moves to (p106, p107, −p108) = (0, 1.85,
    0.44) in it (0.44 behind the origin), then turns about its right axis by the spine's share of
    the pitch around the posed bone p109 and by the rest around the posed bone p112
    (0x10042ffa..0x10043393). The model bends the same bones by the same angles, so the right
    arm is fixed in the view at every pitch.
  - [verified] The arms are the player's own model swapped for 2:138 (0x10042514), drawn by the
    world camera: no separate viewmodel projection, depth range or field of view (lens Level
    Properties p16 = 53° vertical at 4:3, near plane 32 engine units).
  - [verified] The arm pose depends on each 0xc0 clip track's constant translation, which the
    engine uses (SUFFERING.EXE 0x46a180 / 0x46a290). The first-person sets move the collar bones
    with it so that the shoulders, where the 2:138 mesh is cut open, sit behind or beside the eye.
    The port ignored those constants until the fix that `tests/fp-arms.test.ts` covers, and showed
    the cut ends.
  - [verified] The flashlight hangs on chest bone p117 = 50 and changes no arm pose.
- **Third-person follow camera: not located.** No RFL or EXE function was found that reads
  the Camera class's properties (`0x6bb9d081`, template **2:6**; class table entry at
  `0x10173020`, 14 properties). Raw data:

  | p0 | p3 | p4 | p6 | p7 | p8 | p9 | p10 | p11 | p12 | p13 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | 3 | 20000 | 0.08 | 1000 | 300 | −0.05 | −0.12 | 4000 | 4 | 6 | 0.5 |

  Large values in engine units [inferred]: p3 = 9.77, p6 = 0.49, p7 = 0.15, p10 = 1.95. The
  meanings are unknown.
- **Player p353 (1 human, 0 creature) [verified read 0x1003cb45; meaning inferred]:** gates a
  routine (`0x1003cb20`, called at 0x1003d231) that runs only when the active camera is a
  Camera object not under cinematic control. It reads System properties p48..p54 and the
  lens tangent, and draws with 0xff colours. It is most likely the near-camera fade of the
  human body, not a third-person / first-person switch.
- **FOV:** no default lens constant was found. Only the heartbeat lens pulse p270 / p271 =
  55 / 62 exists, already in `game-logic.md` §13.1.

### 7.1 External views: monitor feeds and cinematics

**The original [verified, Suffering.rfl]:**
- First Person is player state 16, and the other states can end it. The player's states are a
  table at 0x10176488. Each entry is 0x3c bytes: an id, a name, then the enter, per-frame and
  leave handlers. Entering a state goes through 0x101207c0.
- That function checks a 35 x 35 table of words at 0x10175150, indexed [new state][current
  state]. A 0 refuses the new state. A 2 ends the current state first, through 0x10120710.
- The row for each of these states holds 2 in the First Person column: View Monitor (23),
  Controlled (11, a sequence takes the player), Interact (22), Play Anim (33), Document View
  (31) and Morph (19). Entering any of them ends first person.
- The First Person row holds 0 for View Monitor and Controlled, so first person cannot come
  back while one of those runs.
- Leaving First Person (0x100433b0) puts the full body model back. That model was saved at
  +0x6b0 when first person swapped in the arms-only model 2:138.
- In first person, using a monitor goes through Interact. The use code (0x1003675f) only keeps
  first person for switches and pushables. The Interact state then enters View Monitor
  (0x10036e5d).
- View Monitor's enter handler (0x100347f0) plays the stance idle p13. With first person ended,
  that is the third-person idle.
- So whatever camera looks (the monitor's feed, the film camera), it shows Torque's whole body
  and never the arms.
- Afterwards first person comes back on its own. Bit 0x8000 of +0x98 stays set because only
  the First Person key clears it, and the per-frame check at 0x100499c8 re-enters state 16.

**Port** (`PlayerController.setExternalView(reason, on)`):
- The security monitor view (`world/interact.ts`) and STOMP cinematics (`sequence/system.ts`)
  turn it on while their camera is in use.
- While it is on, the body (`player.root`) is drawn whatever the view mode. `PlayerBody` hides
  the first-person arms. Because no player frames arrive in that time, `PlayerBody.tick`
  switches the body to the third-person idle.
- The next player frame after the view ends brings back first person and its hold clip.
- A cinematic with a Player track still draws the sequence's puppet instead of the body.
- A cinematic without a Player track now shows the player's own body where he stands. It used
  to be hidden.
- Before this, monitor feeds in first person showed no Torque, so the 1a monitor 6dec scare
  (Horace walking up behind him) lost its point. The arms stayed shown.
- Not ported: Interact, Play Anim, Document View and Morph do not switch the port's own camera
  out of first person.

## 8. Health

- Player p0 = 100 is the health and p1 = 100 the maximum. The port uses p1 × the p2
  Difficulty Modifier [inferred].
- **No regeneration** [inferred]. No per-frame health increase exists in the Player per-frame
  paths. Health changes only through damage (vtable `+0x8c`, which also drives the transformed
  empty-meter drain p257, 0x10032e80) and items.

### 8.1 The Health action 0x430 [verified]

The Player input handler (`0x100492b0`) checks the Health action in the block
`0x10049a28..0x10049aed`. It drinks one bottle per press when **all** of these hold:

1. the action was pressed this frame (input vtable `+0xac` with flag 1) [strong: the flag's
   meaning was not read in the engine];
2. the player is alive (`0x100a1ad0`);
3. neither Morph nor Insanity (states 19 / 20, `+0xa4 & 0x180000`) is active;
4. the player is not under script control (`0x10043600`, `+0x9c` bit 1) and not in state 11
   (Controlled);
5. a Health Bonus Item (class `0x19f64171`) is in the inventory (`0x1004d230`);
6. more than one point of health is missing: `max − health > 1.0`.

Nothing else is checked. Drinking works in first person, in the air, and while reloading,
throwing or attacking. No state is entered and no clip plays: the heal is immediate and nothing
is locked.

**The bottle and the use routine (`0x100b6cd0`):**
- The first Health Bonus record in inventory order is used.
- Health added = **p55 × DM × R**, clamped to the maximum by SetHealth (`0x1002daa0`), which
  also fires the HealthChange event 0x2006. Here:
  - DM is the item's p56 Difficulty Modifier (2:642), or 1 when p56 is empty;
  - R is a reputation factor (`0x1002d5d0` → `0x10041f30`): Player p76 = 0.5 at the evil end of
    p70..p71 (−150..150), rising linearly to p77 = 1.5 at the good end, clamped. R = 1 at neutral.
- p57 is added to the insanity meter (0 for Xombium).
- The sound is Item **p46** (4:260), attached to the player. p48 is the pickup sound.
- The count drops by one (`0x1004ced0`); the HUD count shows the first remaining record.

**Pickup** (Item CanPickUp `0x100be240`):
- It needs the Player, not transformed (state 20), alive, and item flags `+0x46` without 0x8 or
  0x40.
- At the carry cap (Item p44 = 9) the bottle stays where it is and the item's p24 message shows
  ("Xombium Full", 4:14). It is **not** drunk on the spot. CanPickUp returns 0 with its "full"
  flag set.
- The pickup touch 0x100bda00 (within Player p239 horizontally and p240 vertically, both 2 m)
  then shows p24 in the pickup text widget (0x100bc260, the same call that shows the p22 name on
  a pickup). It skips that when the item is in the player's list of recently touched items.
- The list holds (item, time) pairs. Every touch adds one (0x10037730), and each update keeps
  only the pairs younger than Player p250 = 3 s (0x100377c0, double-buffered at +0x740 / +0x74c,
  searched by 0x100372a0). So the message shows on stepping up to the item, and again after 3 s
  away.
- Port: `World.pickupRefused` and `WorldHooks.canPickUp` / `pickupText` (`atCarryCap`; Items and
  Health Bonus Items), `tests/pickup-full.test.ts`. Checked in the browser with 9 bottles
  carried: 1a's 6ff5 stays and "Xombium Full" shows.

**Xombium hint (player event 6 = Player p298, Help Popup 5:503, once per game):** shown on
picking up a bottle below 50 % health (`0x10039e0e`), or on taking damage below 80 % while
carrying a bottle (`0x1002dfb4`).

**Bindings:** Tab and mouse button 5 in the main table; H in the four unused presets. The PC
build has no controller binding. The port puts Health on H and D-pad down.

## 9. PC key tables [verified]

**Record layout.** `{u32 action, u32 device, u32 code, f32 −1, f32 1}`, 20 bytes; device 0 =
keyboard (DirectInput code), device 1 = mouse. **The main table starts at `0x10167520`**
(`0x1016752c` is +0xc inside its first record). It has 110 records and ends with a terminator
whose action is `0xffffffff`.

**Who uses it.** `0x100070c0` applies it (the reset to defaults). `0x100070d0` applies the
user table, at `[0x1017ac74]` = settings `+0x38`. `0x10006c80` builds the list from it,
skipping the reserved interface actions listed at `0x1014bce0`.

**The four presets.** A pointer array at `0x10176e68` lists the main table and four 64-record
presets: `0x10167dd0`, `0x101682e8`, `0x10168800`, `0x10168d18`. No code references the
presets.
- They hold the same records as the main table minus the weapon and inventory hotkeys.
- Their differences from the main table are the same in all four: Map M, Jump Right Shift,
  First Person Home, Health H, Insanity Right Ctrl, 0x42e I.
- The first preset puts Use on Left Alt; the other three use Enter.
- These are probably keyboard stand-ins for the five console Controller Settings layouts
  [inferred]. **The PC default is the main table.**

Gameplay records of the main table, in keyboard-page order. The mouse codes are 0/1 = mouse
up/down, 2/3 = left/right, 4/5 = wheel up/down, 6/7/8 = left/right/middle button, 9/10 =
buttons 4/5.

| Action (id) | Keys | Action (id) | Keys |
|---|---|---|---|
| Map 0x3ff | G | Health 0x430 | Tab, Mouse 5 |
| Documents 0x400 | V | Insanity 0x42d | C |
| Archives 0x401 | B | Reload 0x425 | R |
| Forward 0x409 | Up, W | Flashlight 0x426 | F |
| Backward 0x40a | Down, S | Flare 0x427 | T |
| Turn Left 0x40b | mouse left, Num 4 | Roll Left 0x432 | Q |
| Turn Right 0x40c | mouse right, Num 6 | Roll Right 0x433 | E |
| Left 0x40f | Left, A | weapons 0x434..0x43d | 1..0 (Shiv, Fire Axe, Pistol, Dual Pistols, Shotgun, Tommy Gun, Flamethrower, Flash/Bang, Shrapnel, TNT) |
| Right 0x410 | Right, D | Molotov 0x43e | ` |
| Run/Walk 0x411 | Left Shift | Prev / Next Weapon 0x43f / 0x440 | [ / Num 7, ] / Num 9 |
| Look Up / Down 0x41c / 0x41d | mouse up / down, Num 8 / Num 2 | Prev / Next Thrown 0x441 / 0x442 | Num 1 / . , Num 3 / , |
| Fire 0x428 | left mouse, Num 0 | Inventory 0x42f | I |
| Throw 0x429 | right mouse, Num + | Inventory (alt) 0x42e | middle mouse, wheel up / down |
| Jump 0x42a | Space | Use 0x42b | Left Alt, Mouse 4, Enter |
| First Person 0x42c | Left Ctrl | | |

Records outside the keyboard page:

| Ids | Bindings | Meaning |
|---|---|---|
| 0x3ea | Esc | pause |
| 0x402 | Space / Enter | interface accept |
| 0x403 | Esc | interface back |
| 0x3ec..0x3f9 | arrows, wheel, Home / End, numpad | interface navigation |
| 0x3fc | Enter | interface |
| 0x3fd | Delete, Num Del | interface |
| 0x3fe | Home | interface |
| 0x404..0x408 | mouse buttons and axes | interface pointer |
| 0x412..0x41b | arrows, mouse axes, wheel, Right Shift / Right Ctrl | the map / document viewer (read at 0x100ae981) [inferred] |
| 0x420..0x423 | arrows plus middle mouse / wheel | unknown |
| 0x40d / 0x40e | wheel up / down | unknown |
| 0x431 | left mouse | unknown |
| 0x443 | Space | unknown (read at 0x1012eb50) |

## 10. Constants (`src/app/player-rules.ts`)

| Name | Value | Source |
|---|---|---|
| `PLAYER_GRAVITY` | 24.4 | p214 [verified] |
| `FP_JUMP_SPEED` | 10 | p215 [verified] |
| `TP_JUMP_SPEED` | 6.05 | port value: the third-person jump is clip root motion; this keeps the old 0.75 apex under the new gravity |
| `FP_AIR_CONTROL` | 7.5 | p216 [verified] |
| `WALK_SPEED` / `RUN_SPEED` | 1.63 / 6.64 | PWP p19 / p21 [strong] |
| `FALL_DAMAGE_MIN` / `FALL_DAMAGE_MAX` | 6.5 / 7.7 | p212 / p213 [verified] |
| `FALL_DAMAGE_TYPE` | 7 | [verified] |
| `FP_JUMP_FALL_BONUS` | 1.35 | [verified] |
| `TURN_RATE_DEG` | 220 | p158 [verified] |
| `PITCH_RATE_DEG` | 42 | p190 / p191 [verified] |
| `AUTO_PITCH_DELAY` | 2.2 | p197 [verified] |
| Auto-aim cone | ±5° horizontal, ±3° vertical | p177 / p178, p176 |
| Auto-aim range | PWP p10 = 45 | [verified] |
| Minimum priority | 5 | p219 |
| Score weights | angle 1, distance 0.1 | p224 / p225 |
| Turn slowdown | 0.125 standing; moving 0.55 → 0.10 over 2..35 | p182..p185, p180 / p181 |
| Pitch slowdown | 0.5 / 0.7 | p186 / p187 |
| Tracking minimum distance | 3 | p188 / p189 |
| Shot snap cone | 1° | p220..p222 |
| `RETAIL_PC_KEYS` | the §9 table as browser `KeyboardEvent.code` / `Mouse<n>` | |

## 11. Port changes

Implemented in this pass:

1. **`src/app/player.ts`.** The player motor now uses `PLAYER_GRAVITY`, the first-person /
   third-person jump speeds, and the retail walk and run speeds.
   - **Running is the default** and the Run key walks. A pad still runs past 88 % deflection,
     and scripted input keeps its own run flag.
   - First-person air control follows the stick at up to 7.5 (FP jumps only).
   - Landing reports `PlayerFrame.fall`: the drop height, measured from the highest point
     reached while airborne. This approximates the original's fall-start height, plus 1.35
     for a first-person jump.
2. **`src/game/fx/system.ts`.** On a landing with `fall` > 6.5, the player takes
   `fallDamage(h, maxHealth, health)` through `services.combat.damagePlayer`. The original's
   `+0xac` bit 9 gate is not modelled.
3. **`src/game/weapons/aim-assist.ts`.** The original selection and assist rules:
   - the selection pyramid, the priority rule and the score;
   - the slowdown factors;
   - tracking with no stick input while moving or while the target moves, beyond 3 m;
   - Auto Pitch after 2.2 s of third-person movement at 42°/s;
   - `shotTarget()` = the 1° snap.

   `withinWeaponCone` is kept as the p76 sanity check, using the angle between the aim and
   the shot direction.
4. **`src/game/weapons/system.ts`.** Candidates now carry the template priority (character
   p128; instance overrides are not applied). The range is the held weapon's PWP p10. The
   auto-target exists only while a Ranged Weapon is held, and shots snap only within the 1°
   cone.
5. **`src/game/hud/bindings.ts`.** The pad look uses the new assist. The comment on the
   default keys is corrected: the table address is 0x10167520 and Health is Tab.

   The port's own defaults are kept, and the differences are deliberate:
   - Insanity is on Q because C crouches;
   - Use is on E and the rolls on Z / X;
   - Health is on H because Tab opens the inventory;
   - the turn and look actions have no numpad keys.

Not changed:
- third-person camera distance and collision (no decoded source);
- crouch (an engine addition);
- acceleration (the original follows the clips);
- the numpad duplicates of the retail table.

## 12. Look input, sensitivity and controllers

### 12.1 The original [verified unless marked]

- **No controller on PC.** SUFFERING.EXE creates only a keyboard device and a mouse device
  through DirectInput 8. The joystick GUID is present but never referenced. There is no XInput,
  and nothing sets a dead zone or an axis range. The engine's device table has two slots, so the
  key table's device ids are only 0 and 1. The console Controller Settings tables are not in the
  PC build. The vibration flag (0x20) reaches the input layer but drives nothing on PC [strong].
- **Analog value of an action** (input vtable `+0x98`, EXE 0x40d1a0): for each binding record,
  v = 0 up to the record's `lo`, then (raw − lo) / (1 − lo), raised to the record's exponent. The
  value is the maximum over the action's bindings, not their sum. Each retail record is
  `{…, −1, 1}`. The −1 is a sentinel replaced by the device's rest value, 0 for keyboard and mouse,
  so retail inputs have no dead zone and a linear response, with no clamp to 1.
  - An axis is the difference of two actions (vtable `+0xa0`): Turn = Left − Right, Pitch =
    Look Down − Look Up.
  - A key is 0 or 1. A mouse direction is counts per second ÷ 1536, over a frame time capped at
    0.1 s.
- **Turn** (Turn per-frame 0x10046dc0): yaw rate = axis × Turn sensitivity (settings `+0x1c`)
  × 220 °/s. The 220 comes from p167 in first person, p170 airborne, p164 Aim, p161 Move or p158
  otherwise. p173 = 350 °/s applies while auto-facing a melee target with no turn input (in
  first person p167 still wins; the pick and the turn: game-logic.md §14.1 "Player melee").
  - There is no ramp: the applied rate snaps to the requested one every frame (`+0x182` = 1e6).
  - p159 / p160 (250 / 3000) and p174 / p175 are not read [strong].
  - p157 = 60 °/s only picks the turn-in-place clip.
- **Pitch** (Pitch per-frame 0x1003f930): pitch rate = axis × Pitch sensitivity (`+0x20`) × 2 ×
  42 °/s (p190 third person / p191 first person), so 84 °/s at full input. Invert Pitch (flag
  0x10) negates it. There is no ramp. The clamps are ±50° in third person and −65°..+75° in first
  person (p198..p201).
- **Mouse** [strong]: the mouse is only a binding, so it goes through the same rates.
  - 1 count turns 220 / 1536 = 0.143° × Turn sensitivity;
  - 1 count pitches 84 / 1536 = 0.055° × Pitch sensitivity.
- **Sliders** (Gameplay page, 0x10056d70): sensitivity = 2^(4s − 2) for the slider position s
  in 0..1, clamped to 0.25..4. The default 1 is the middle of the slider.
- **Re-centring:** only Auto Pitch Correction (§3.4). There is no yaw auto-centre.
  - State 24 "Camera Yaw" (0x1003ee50) offsets the camera by up to ±p202 = 80° at p203 =
    90 °/s while turning. It is entered from mounted-gun code; its exact trigger was not traced.

### 12.2 The port (`src/app/player-rules.ts` `lookRates`, `src/game/hud/bindings.ts`)

- The right stick is the Turn / Look axis pair: yaw at 220 °/s and pitch at 84 °/s at full
  deflection. The Gameplay page's Turn sensitivity (`PlayerController.turnScale`) and Pitch
  sensitivity (`pitchScale`) and Invert Pitch apply, as they do in the original for every turn
  input. The turn / look keys use the same rates.
- The stick has a dead zone, which the original never needed. Past the dead zone the response is
  linear, as in the binding records. The Controller page's Look Response (Smooth / Precise) and
  Look Sensitivity remain engine options; the defaults are Linear and 1.
- **Removed:** the port's turn boost (1.6× after 0.35 s at full deflection). The original has no
  ramp.
- Auto Targeting and Auto Pitch Correction now default to **off**, as the original's settings
  defaults have them. Both remain on the Controller page.
- The Gameplay sliders' range is now the original's 0.25..4. The port's slider is linear, not
  exponential.
- Mouse look keeps the port's own scale (0.0022 rad per pixel for both axes).

Before this pass, the pad turned at 172 °/s, ramping to 275 °/s, and pitched at 109 °/s on a
magnitude^1.8 curve. That made half deflection about 4× slower than linear and full deflection
faster than the original. The pad also ignored the Gameplay Turn sensitivity.
