# Animation system and STOMP animation keys (SUFFERING.EXE / Suffering.rfl)

How the engine plays skeletal clips: channels and layers, cross-fades, root motion, clip
headers, transition blends and events, the skeleton trailer, and the STOMP keys and flags
that drive all of this in sequences. Read from `SUFFERING.EXE` (base 0x400000; the animation
system lives at 0x469000..0x47c000) and `Suffering.rfl` (base 0x10000000). Addresses are VAs.

Tags:
- **[verified]**: read in the code.
- **[strong]**: the code plus the data or the names agree.
- **[inferred]**: a reading that fits.

Code: `src/formats/animation.ts` (clips, links, events), `src/formats/skeleton.ts`
(`readSkeletonTrailer`), `src/game/world/stomp.ts` (key flags), `src/app/character.ts`
(blending, layers, root-motion modes, pose hooks), `src/game/sequence/` (presenter),
`src/game/actors/player-body.ts` (weapon actions). Tests: `tests/re-animation.test.ts`.

## 1. Objects

- **Animator** (`object +0xec`, vtable `0x591588`, constructor `0x46cf40`, pooled). Holds the
  model (`+0xfc`), state flags (`+8`, with a copy at `+0xc`), the bone → channel-node table
  (`+0x104`, one s16 per bone), the channel nodes (`+0x11c`, 0x80 bytes each), two "release
  later" clip slots (`+0x1e8`, `+0x1ec`) and the event queue (`+0x1f0`).
- **Play request** (built at `0x4500c0`, filled by setters `0x44fc90..0x44fce0`):

  | Offset | Field | Request flag |
  |---|---|---|
  | +0 | flags | |
  | +4 | clip ref | |
  | +8 | queued follow-up clip ref (node `+0x78`) | 0x100 |
  | +0xc | speed | 0x02 (absent: the clip's rate) |
  | +0x10 | start time | 0x04 |
  | +0x14 | blend time | 0x40 (absent: see §3) |
  | +0x18 | follow-up threshold (node `+0x7c`, 0..1) | 0x200 |
  | +0x1c | values of the boolean fields below | |

  Other request flags: 0x08 = independent layer, 0x80 = release the clip later (§6),
  0x800 = set by STOMP on every key (not followed), 0x10 = force over independent layers,
  0x100000 / 0x200000 = set / clear node flag 0x10. Root-motion fields: 0x1000 / 0x2000 /
  0x4000 (per-axis "extract"), 0x10000 / 0x20000 / 0x40000 (per-axis "lock"), 0x8000
  (rotation extract), 0x80000 (rotation lock); `0x46f620` copies them into the animator flags
  0x10 / 0x20 / 0x40, 0x100 / 0x200 / 0x400, 0x800, 0x1000.
- **Play** is animator vtable `+0x34` (`0x471020`, arguments: bone, request). Resources that
  are not loaded yet queue the request (`0x472ad0`). The root-motion setters (vtable
  `+0x64..+0x88`, `0x478910..0x478b50`) are thin wrappers that send a request with bone 0, no
  clip and only the field mask.

## 2. Channels and layers [verified]

A **channel** is a row of the model's channel table (§8): `{bone, bits}`. STOMP attach keys use
it as a hardpoint (`docs/game-logic.md` §7.1), and STOMP animation keys use it as the bone a
clip plays on.

- The STOMP animation key handler (`0x4507a0`) looks up `table[channel].bone`
  (`model +0xc8`, 16-byte records) and calls play(bone, request). Channel 0 is bone 0, the
  root, so the clip plays on the whole body.
- `vtable +0xb8` (`0x46d6c0`) returns the bone's **channel node**. When the node the bone maps
  to is owned by another bone, it creates a new one:
  - the new node copies the old one, including its clip and time, so the subtree blends from
    the pose it already shows;
  - it clears flags 0x618;
  - the node's owner is set to the bone;
  - the bone's subtree is reassigned to the node, stopping at descendants that own nodes
    themselves (`0x46b330`).
- After the bone's own node, play walks the descendants (`0x470f20`). Each node owned by a
  descendant gets the same request, which means a whole-body clip **takes the layers over**
  again. Two exceptions:
  - a node with flag 0x400 (an **independent** layer, request flag 0x08) stops the walk below
    it;
  - request flag 0x10 forces past it.

  Nodes are never merged back. A layer that is taken over just plays the new clip.
- The data uses this 11 times, all in 1 PrisonDeathRow:

  | Track | Channel | Bone | Subtree | Clip |
  |---|---|---|---|---|
  | Ernesto (rig 10:110) | 5 | 5 (spine) | 50 bones | 12:48, 11.9 s, plays once |
  | Cash (10:43) | 20 | 48 (neck) | 7 bones | 12:166 |
  | Gaurd #280 (10:46) | 21 | 49 (head) | — | 0.07 s pose 12:94 |
  | Gaurd #217 | 17 | 32 (an arm) | — | 0.07 s pose 12:94 |

  - Ernesto's clip plays over legs that keep looping clip 106.
  - Gaurd #280's pose comes at 6.82 s, after the blade has gone through the head.
  - In #272 / #282 / #284, Ernesto's first channel-5 key has a channel-0 key at the same time
    stored after it, so the engine takes that layer over at once. Only the second channel-5
    key (11 s later) shows.

  No key sets the independent flag (0x200).
- **Port** (`Character.playLayer` / `stopLayer` / `releaseLayers`, `layerBoneForClip`):
  - a layer plays the clip restricted to the subtree's tracks, on the same mixer;
  - its weight against the whole-body actions is `m / (1 - m)` for a mix `m`, nested layers
    against everything under them;
  - a channel-0 STOMP key calls `releaseLayers(blend)`.

  Torque's weapon actions (player-body.ts `weaponAction`, §9 "Player weapon actions") and the
  Mainliner's channel aim pose (actor.ts, §9 "NPC ranged attacks") use the same API, as
  independent layers on the bones the data names. NPC firing clips are never layered.

## 3. Cross-fades and timing [verified]

- **Blend curve** (`0x470130`):
  - `x = (now - start) / blendTime`;
  - weight of the new clip `w = 2x²` for x ≤ ½, `1 - 2(1-x)²` above (quadratic ease-in-out);
  - the old clip gets `1 - w` (node `+0x74`);
  - time is the game clock (`0x5c6e8c`).

  Port: `engineBlendWeight`, used by every `Character` fade.
- **One previous clip** per node:
  - the node keeps `+0x5c` (clip), `+0x6c` (time) and `+0x70` (rate) while blending;
  - a new clip during a blend marks the node 0x100;
  - re-requesting the clip it blends from (same speed sign) reverses the blend (`0x46f8d0`).
- **Blend time when the request has none:**
  - the new clip's type-4 entry for the clip it replaces;
  - otherwise the new clip's header `blendTime` (`0x473b60`, called at `0x4715b6`);
  - `0x470d18`'s 0.2 s is only a fallback.

  STOMP always passes the key's blend minus the time already elapsed since the key. Port:
  `blendInto(clip, from)` is the default of `Character.play`.
- **Speed:**
  - request speed × clip rate (`0x4713b7`);
  - a request with speed 0 freezes the clip;
  - a re-keyed same clip only sets its time (no cross-fade).
- **Start time:** wrapped (fmod) for looping clips, clamped for once-clips (`0x4713e5`).
- **Clip end:**
  - a once-clip clamps at its end and sets the node's "ended" flag;
  - a looping clip wraps, and the clip's root displacement is subtracted so root motion stays
    continuous (`0x470921..0x470a5f`).

## 4. Root motion [verified code path; strong with the data]

STOMP key flags bits 0..7 hold four 2-bit modes: x, y, z translation of the root bone, then
its rotation. `0x44fd70` turns them into animator flags, for channel-0 keys only:

| Mode | Translation axis | Rotation |
|---|---|---|
| 0 | stays in the pose: the mesh moves away from the object origin | stays in the pose |
| 1 | "extract": zeroed in the pose, and the per-frame delta (scaled by the object scale) moves the object (`0x478c07..0x478dc3`) | extracted to the object (reference captured at the start, flag 0x10000) |
| 2 (3) | "lock": zeroed in the pose, nothing moves | held at the reference (flag 0x1000, `0x478eea`) |

- A start time > 0 with any extracted axis resets the reference (animator flag 0x80), so the
  delta does not jump.
- The extracted delta is scaled per axis in model space by animator +0x64 / +0x68 / +0x6c
  (x, y, z; 1 by default) before the model's matrix turns it, and is added to the object's
  pending matrix (object vtable +0xf0, `0x4546d0`), the same one the player's gait moves.
  Gameplay writers: the player's melee strike (+0x6c = PWP p85 without a target), the
  third-person jump (+0x68 = the power, +0x6c = (1 + power) / 2 x max(stick, 0.3); Jump enter
  0x1003af56..0x1003af87) and the clamber's ledge height (+0x68). `docs/game-logic.md` §14.1
  "Player melee: root motion", "Third-person jump and landing".
- Player states that extract (the +0x70 sites): Hit Reacting (17) enter and per frame (the
  knockdown 2:128 three metres back, its floor clip 2:130 through Landing), Jump (8) enter (the
  clip's root is the whole trajectory, y included), Landing (12) through Fall's leave (2:89,
  0.4 m forward), LadderClimb (27) enter (each rung clip 0.5 m up or down at speed 1). Fall (9)
  enter turns extraction off and the lock on: a body knocked off a ledge drops straight down.
  Port: `src/game/actors/player-states.ts` (RootClip: per-axis scaled root deltas into
  `PlayerController.rootMove`, y through `MotorInput.moveY` with `fly`), `world/interact.ts`
  (rungs).
- Data:
  - 1240 of 1433 keys use 0000;
  - walk / run clips driven by transform keys use `0020` (forward axis z locked, sway and bob
    kept);
  - clips that should move their object use `1110`: the rock thrown in 6 Woods #9 (40 m of
    root motion, no transform keys), CartWheeler leaps, the Mainliner in 3 YardCellBlock #15,
    the 1a Door #71.
- Port:
  - `RootAxes` in `buildAnimationClip` zeroes axes in modes 1 / 2 and holds the start rotation
    for rotation mode 2;
  - the sequence presenter moves the object by the mode-1 delta while no transform key poses it
    (`applyDrives`);
  - rotation mode 1 is extracted like the original (`0x478ec2..0x478f35`: at the key the root
    bone's and the object's matrices are saved; each frame the object becomes the saved object
    matrix times the root's rotation relative to the saved root, and the pose keeps the saved
    root rotation). Port: the clip holds the start rotation (as for mode 2) and `applyDrives`
    sets the object to `base · root(t) · root(from)⁻¹`; translation deltas are turned by the
    object's rotation at the key (`base`), so the root bone moves exactly as it does in the
    pose. Data: 8 keys (1a "CartWheeler#210" 12:4 / 12:11, a 10° pitch over the two clips; 1b
    #267 Guard 12:33 and 1c #270 bed / apparatus, no root rotation; 3 YardCellBlock carts; the
    6 Woods truck). `tools/stomp-audit.ts` expects the same pose.
  - Gameplay: NPC behaviours request rotation extraction (PlayAnim mode `0x42`: translation
    and rotation) only in LadderClimb (`0x10109b5d`) and OpenDoor (`0x10112168`); the retail
    push clips (OpenDoorBehavior p2 / p3) have no root motion, and no chapter-1 NPC climbs, so
    the port's gameplay clips are unchanged. The NPC animation driver (`0x10094860`) maps the
    mode bits: 0x02 extract x / y / z, 0x40 extract rotation, 0x10 / 0x04 lock x / z.

## 5. STOMP animation and camera keys [verified]

**Key flags** (see the table in §1):
- **0x100**: request flag 0x80. On a whole-body play the animator stores the clip in one of
  two slots (`+0x1e8` / `+0x1ec`). `0x46fd30` releases it from the clip cache (`0x463450`)
  once no node plays it, blends from it or queues it. This is memory management only
  (477 keys in 1 PrisonDeathRow, 517 overall). The port ignores it.
- **0x200**: request flag 0x08, an independent layer (§2). It never occurs.
- **0x4 | 0x800 | 0x40** are always added by the key handler. Clip time is
  `offset + (now - keyTime) × speed`.
- A key whose next key on the same channel is already past is skipped when a sequence resumes
  (`0x44dd10` / `0x450800`). The port's skip applies the last channel-0 key and then the last
  key of every channel keyed after it.

**Camera keys** (`0x44e2a0`, for every track with camera keys, cinematic or not):
- **Time scale:** the clock rate is `base × (prev.ts + (next.ts - prev.ts) × u)` with the
  next key's easing `u` (step: 0 until the key). `base` is the rate saved at the start (run
  `+0x28`); it is set once when both keys are equal, and restored at the end.
  - Data: three 4 Quarry crane sequences (#22, #37, #38) step to 0.25 for 1.05 s of sequence
    time, so about 4 s real.
  - Port: the presenter composes it with `view.timeScale` through an accessor (the insanity
    system sets the base every frame).
- **FOV** interpolates the same way, but only when both keys are non-zero. The value goes to
  the same lens call as the level lens: view manager `+0x28` = `0x4b0d90` (`0x44e4cf`), and
  Level Properties p16 at rfl `0x100b2364`. It is therefore a **vertical** angle of the 4:3
  picture. The port (`lensFov`) keeps the 4:3 horizontal angle on wider screens; the old
  port read it as horizontal.

## 6. Sequence and track flags

Header flags (sequence data `+0x20`; the loader `0x44c06e` clears 0x40 and 0x02 when 0x01 is
set, and clears 0x100):

| Flag | Meaning |
|---|---|
| 0x40 | cinematic [verified, existing] |
| 0x01 | "strict": the key walk aborts when an object is missing instead of skipping it (`0x45114b`); on resume, keys are re-sought (`0x44f187`). 4 sequences. [verified path, purpose inferred] |
| 0x04 | **letterbox**: a control key on the player turns the view manager's bars on (take) / off (release) (`0x450ea6`, vtable `0x594940 +0x18`); destroying the run turns them off (`0x44fa55`). The bars (`0x4b0b30`, drawn at frame end from `0x48c729`) are two rectangles of `ftol(height × size × 0.01)` at the top and bottom in the colour at `+0x3c`. The setter (`+0x14`, `0x4b1480`) is called by Suffering.rfl at level start (`0x100b239f`, through the interface pointer `[0x1017bf30]`) with Level Properties p36 (size %, 10 in System 2:9) and p37 (colour, 0 = black), next to the lens (p16). No fade. So retail cinematics have 10 % black bars, as in captures of the PC version. Port: `src/game/sequence/cinema.ts`, `system.ts`. [verified] |
| 0x08 | at a normal end of a run that held the player: a global service's vtable `+0x70` with argument -1, and the game clock's input state reset (`0x409270(1,1)`) (`0x45130c`). [code read, meaning not identified] |
| 0x02 | the getter `0x44d560` has no callers; not found. 58 sequences, mostly non-cinematic in-world scenes. |

Track flags: 0x08 removes the object at the end (existing, §7); 0x10 is on every track;
0x01 (3 tracks) and 0x02 (1 Camera track) have no reader in the STOMP code paths read.

## 7. Clips (.adu) [verified; exact on all 18 files]

The clip resource type is 4. The manager (`0x5c5ef0`, vtable `0x58c2b0`) has get `0x4750f0`,
blend `0x475250`, duration, rate, displacement and velocity accessors. Each clip object
(vtable `0x591650`) registers one handler per entry type: `0x473ba0` header, `0x473500`
tracks, `0x473c50` links, `0x473d00` events. After load, every translation is multiplied by
2048 (`0x4736c0`), and the first track's displacement, extrapolated to the duration, is kept
at `+0x3c`.

- **Track translations** [verified: sampler `0x46a180` (two keys) / `0x46a290` (one key);
  accessors `0x469a10` / `0x469a20` / `0x469a50`]. A track record in memory is 0x18 bytes: hash,
  key offset, `u16` key count, `u16` format (`0x8000` keys with translations, `0xc000`
  rotation-only), and an `f32[3]` constant translation (scaled by 2048 at load like the keys,
  `0x4737d0`). The bone's translation is the interpolated key translation for `0x8000`, **the
  track's constant for `0xc000`**, and the bind translation of the skeleton node (`+0x7c`) for a
  bone the clip does not animate. Tracks bind to bones by hash, whatever rig plays the clip
  (bone → track table `0x4793b0`: the first track whose hash equals the bone's hash at bone
  `+0x8c`; index -1 = no track: bind rotation `+0x4c` and translation `+0x7c`) [verified]. The
  root-motion modes clear the extracted / locked axes on the root's sampled matrix
  (`0x478c13..0x478c39`), so a rotation-only root loses its constant on those axes too
  [verified].
  - Port: every `Character` follows the rule (`buildAnimationClip`, default `constantTranslations:
    'animation'`): NPCs, creatures, the third-person player body, the first-person arms, STOMP
    puppets, skinned props. The old port used the bind translation ('bind', kept only for
    comparisons) plus two partial fixes, the hips' body offset for NPC / scripted clips and the
    attach points for scripted clips; both are now just the rule.
  - Audit (`tools/clip-constants.ts`, chapters 0-3: 3429 model / clip pairs the levels play,
    from the templates' Animation properties and STOMP keys) [verified on the data]: no constant is mis-scaled (none
    over 50 m), no track has hash 0, and against bind + hips offset 231 pairs move a skinning
    bone by 10 cm or more. Most of those come from the traversal pairing a model with clips
    another character plays (Torque's grab clips on the Mainliner, rat clips on Fester, the
    creature's clips on the human). The real changes are:
    - the third-person body's posed clips get their body offset: knockdown `2:129` used to float
      at standing height and now lies on the floor;
    - the insanity creature's morph `2:163` starts at the human lengths (forearm 0.32 instead
      of 0.55);
    - Slayer attack `10:1358` / scene `10:1369` stretch the blade arms (0.4-0.8 m);
    - the 1a breaking window `9:3532` / `9:24` is posed by its constants.
    Human NPCs, faces and shoulders move by 2-3 cm at most, and every cinematic of 1a "Goose"
    (0-214 s) gives the same frames.
  - The Nooseman's rope stays as the port stretches it (`nooseman.ts` sets the rope bones' x
    each frame). The original scales the posed rope bones instead (Suffering.rfl `0x10081650`:
    a matrix hook on bones p180 / p181). At death it removes that scale and moves the object to
    the low bone (`0x10081860`). The death clips `10:263` / `10:295` collapse the rope bones to
    0. So in the original the corpse lies at the object, which was just moved to the low bone
    [verified code; outcome inferred]. The port's dead state keeps the bind rope and drops the
    object instead.

- **Type 1** (28 bytes):
  - `f32 duration, u32 flags, u32 trackCount, f32 blendTime, f32 rate, f32, f32`;
  - the two trailing floats are never read;
  - flag bit 0 = plays once (clamp / hold): 1530 clips;
  - bit 1 (21 clips) puts the object in the full-rate animation update bucket (`0x474d43`),
    exempting it from distance LOD [inferred].
- **Type 4** (35 clips): transition blends, `u16 count, count × {u16 id, u16 pkg, f32 blend}`.
  The blend applies when this clip replaces that one. The old decoder read 4-byte records;
  fixed.
- **Type 5** (526 clips): events.
  - Layout: `u32 n, n × {u32 kind, f32 time, u32 boneHash, [u32 param if kind ≤ 1]}`, then
    `u32 m, m × sound ref` (a pool).
  - Only kinds 0 and 1 occur: 478 and 1065.
  - **Firing:** an event fires in the window `[t0, t1)` (it wraps for loops, and nothing fires
    at speed 0), only on the channel that owns its bone (`0x470500`, `0x4703f0`). Fired events
    are queued and handled once per frame (`0x46d870`).
  - **Kind 0, sound:**
    - param is a sound ref `pkg << 16 | id`;
    - param 0 picks from the pool at random, never the same entry twice in a row;
    - the sound plays on the object;
    - it is not restarted while it plays;
    - the animation's sounds fade when the clip changes.
  - **Kind 1, message:** message `param` is sent to the owner with the bone index and the clip
    (`0x40b260`). Names come from the RFL table `0x10174658`; see `ANIM_MESSAGES`.
    - Footsteps 200..205 only count while the clip is channel 0's current clip.
    - Arm / Disarm (100 / 101) open and close melee hit windows on that limb.
    - Other messages: Fire, AmmoEject, Equip, Spawn / Drop / DestroyItem, ThrowWeapon (230),
      Start / StopFadeIn / Out, SpawnEffect, StartInteract / EndInteract, and others.
  - Port: `readAnimEvents`, `eventsInWindow`. The footstep and actor code already consume
    kinds 0 / 1. Actors voice the sound cues of looping clips too (actor.ts `playLoopCues`, the
    window test `loopEventCrossed`): the vision creatures' run 2:137 growls from its pool every
    cycle unless the last growl still plays; before, only one-shot clips were voiced.

## 8. Skeleton trailer (.mdu type 8) [verified; exact on all 190 rigs]

After the bone records (`readSkeletonTrailer`):

1. LOD records (existing).
2. `u32`, kept at model `+0x104`. Its low half is small and its high half is
   0x0002..0x0037; meaning unknown.
3. The channel table: `u16 n, n × {u32 bone, u16 k, k × u32 bits}` (`0x47b2be..0x47b416`).
   - Records are kept at `+0xc8`, and each bone gets its channel index at `+0x40`.
   - `bits` has one word per LOD. On 25+ rigs a subset of channels carries one distinct bit
     each, in channel order. On the human rigs these are spine, arms, neck, head and pelvis
     (the layer roots). No reader was found.
4. `f32[3]` LOD distances (`+0xf8..+0x100`).
5. A bounding-sphere tree (`0x482d10`):
   - `u16 count`; when non-zero, `u16 × 4` (0, count, ...), then count × 24-byte nodes
     `{u16 childA, u16 childB, f32 x, y, z, r, u32 bone}`;
   - model units (×2048 at load);
   - out-of-range child indices are reset to 0;
   - node 0 bounds the whole body.

## 9. Procedural bones

**Hooks [verified].** Each channel node can carry two per-bone 3x3 hooks, applied by
`0x46f930` (from `0x4701c0`) after the bone's model matrix is built, so children follow:

- **`node +0xc` (model space).** The new matrix is `Sᵀ·M`: a rotation in model space about
  the bone's own pivot, on top of the animated pose. Node flag 0x800 makes it absolute.
  Port: `Character.rotateBoneModel`.
- **`node +0x10` (bone-local).** The new matrix is `M·P`: lip-sync and turrets use it.

The rotation builder is rfl `0x1000e0b0` (right-handed `R(axis, angle)`). Model space is the
port's mesh space (the character faces −Z).

Port detail: three.js only writes an animated property when its value changed, so
`rotateBoneModel` remembers the animated rotation and `Character.update` restores it before
the mixer runs. Otherwise the hooks would compound.

**Player bend** (`0x10030030` hooks; per frame at `0x1004c6b1..0x1004c7cc`; clamps at
`0x1003f930` / `0x1003ed40`) [verified]:

- **Bones** (template properties, Player 2:5): p109 spine 5, p110 neck 48, p111 / p112
  shoulders 9 / 29. The creature form 2:240 uses 5 / −1 / 31 / 22.
- **Pitch** is positive looking down and clamped to ±50° in third person (first person:
  65° up, 75° down).
- **Spine:** gets p194 = 50 % of the pitch.
- **Neck:** pitch minus the spine's part (plus a look-state machine, p196).
- **Shoulders:** pitch minus the spine's part, but only when aiming (first person or the Aim
  state). Otherwise they ease back to 0.
- **Rates:** each angle moves linearly toward its target at p193 (spine, 20°/s) or p195
  (neck, shoulders, 20°/s). p192 = 160°/s applies when every target goes to 0; first person
  snaps.
- **Rotations:** spine `R(Y, yaw)·R(V, pitch)` with V the lateral axis; at yaw 0 every bone
  turns about model X by −angle.
- **Other details:**
  - p123 locks bone 4 to its bind orientation in some states;
  - the spine yaw unwinds into the object's yaw;
  - Look At (state 28) turns the neck toward a target (p129 / p130 limits, p132 rate).
- **Port** (`player-body.ts`): the spine, neck and shoulder bend of the third-person body with
  these rates, with "aiming" taken as "a weapon stance is set". The first-person arms keep
  their rigid eye pivot.

**NPC facing channel** (ProjectileAttackBehavior p21..p25; tracker `0x100304d0`, tick
`0x100b41f0`, single bone `0x100b3d70`) [verified]:

- The direction from bone p21 to the target, in object space, is clamped into a cone of p22°
  around forward and ±p23° of elevation.
- It is slewed along the great circle at p24 °/s, then turned into a look rotation applied as
  a model-space hook.
- It is eased in and out over p25 s with a sine curve. "Aligned" means a dot product ≥ 0.97.
- Values:
  - guards 10:22: bone 5, 45°, yaw only, 90°/s, 0.25 s;
  - Slayers 10:137: bone 30, 180°, ±14°, 210°/s, 0.5 s.
- Port: `LookAtBone`, wired in actor.ts while an actor shoots.

**NPC aim bones** (the Aim sub-behaviour, type 0x31; ProjectileAttackBehavior p7..p13; start
`0x100eb780`, update `0x100e94f0`) [verified]:

- The elevation of the target from the p13 bone is clamped to [p7, p8] and slewed at NPC p39 ×
  360°/s (180°/s).
- Each p11 bone is pitched up by elevation / p12 in model space.
- Guards: shoulders 9 / 29, origin 28, ±45°.
- These are the "independent channels" of the error strings. They are bones bent toward the
  target, **not** an animation layer.
- Port: `AimBones`.

**NPC ranged attacks** (ProjectileAttack, behaviour type 0x30, vtable `0x101569a0`; start
`0x100fee00`, update `0x100fef80`, child-finished `0x100ff1b0`, animation-message handler
`0x100fcec0`) [verified]:

- The behaviour picks an Attack of ProjectileAttackBehavior p2 by the p3 weights (`0x100faf80`).
- **Aim** (state 1, `0x100fabe0`): stops the Aim (0x31), PlayAnim (0x0c) and MovementAnim (2)
  sub-behaviours, plays Attack p4 (the aim pose) through PlayAnim (`0x100f9230`) and starts
  Aim (the aim bones above). With Attack p20 set, the pose plays on that channel (PlayAnim mode
  6) and MovementAnim is started too, so the legs keep their locomotion animation; with p20 =
  -1 it plays on the whole body. Every retail Attack has p20 = -1 except the Mainliner's needle
  throw 10:210 (channel 5).
- **Fire** (state 4, `0x100fcbc0`) when Aim completes (facing dot ≥ 0.99 and the elevation
  settled, `0x100e967e`): Aim, PlayAnim and MovementAnim are stopped again and Attack p0 plays
  through PlayAnim with no channel, i.e. on the **whole body**, at speed `p1 + p2·(2u − 1)`
  (guards 1 ± 0.15). The projectile leaves on the clip's Fire message (102), handled by
  `0x100fcf06` through the character's weapon set (`+0x31c`, `0x100958e0`).
- **Burst** (`0x100ff3bc..0x100ff4f2`): when the firing clip ends the shot counter rises; below
  Attack p23 (guards 6), with a clear line when p30 = 1 and the target alive, the behaviour
  waits `rand(p21, p22)` s (guards 0.15..0.25) in the aim pose (state 5) and aims again;
  otherwise it ends.
- ProjectileAttack never moves the character: it runs under RangedCombatReposition (0x39,
  KillProjectileBehavior p5 = 0) or ShootFromPosition (0x3a, p5 ≠ 0), which walk to a firing
  position first and then start it (`0x100f6619`, `0x100fd57a`). So NPCs **stop to shoot**.
  ProjectileAttackBehavior p19..p20 are read only when p18 is set (`0x100f2cc0`).
- The old port's "shoot while walking" upper-body layer was not original; the guards' 10:35
  only animates spine and arms because its legs hold the aim pose's stance.
- Port (actor.ts `startShoot` / `updateShoot`, manager.ts `ranged`): the attack picked by
  weight, the aim pose until the actor faces the target within acos(0.99), the whole-body
  firing clip at the sampled rate, p23 shots with the p21..p22 pauses, the p30 line check;
  the Mainliner's aim pose as a layer on its channel-5 bone. The pause between attacks stays
  p19..p20 (the parent behaviours' timing is not modelled).
- **Thrown weapons** [verified]: the handler's case 230 (ThrowWeapon, `0x100fd026`; 102 Fire
  goes to the weapon set's `0x100958e0`, which fires only a Ranged Weapon, class `0x9710d816`)
  takes the weapon of the marker's index (`0x10096ab0`) as a Missile / BouncingObject
  (`0x10028420`) and the target's aim point (`0x1009e0f0`), then by the object's p0: 0 launches it
  along the weapon's -Z at its speed, 1 aims it ballistically (`0x100ccee0` -> `0x100cc590`), 2 a
  third aim (`0x100ccb20`, unused by NPC weapons [data]); `0x100ce190` releases it. The point
  aimed at is the object's p48 (0 position, 1 vt +0x64, 2 the aim point). The ballistic aim
  scales the offset down to p9 m when its horizontal part is longer, solves the parabola for the
  object's speed and gravity, keeps the elevations whose flight passes within 2 m of the point's
  height at its distance and takes the lowest; none: p10 degrees. 6a / 6b's stranger, Clem
  (10:642), throws molotovs (BouncingObject 10:1863: p0 1, p48 2, p9 25 m, p10 45). Port:
  `actors/throw.ts`, `actor.ts fire`, the weapons service's `throwObject` (the object then
  flies, bounces and goes off like the player's throwables).

**Player weapon actions** [verified]. Fire, reload, throw and draw play the held weapon's
Player Weapon Properties clips through `0x1004cb20(clip, bone, blend, start, speed,
independent)` on a bone the PWP names, with the **independent** flag (play flag 0x08: whole-body
locomotion changes do not take them over):

| Action | Code | Bone | Clip |
|---|---|---|---|
| fire | Attack state enter `0x10029990`, per frame `0x10028830` | p1 (revolver 6, the chest: arms, neck, head); p2 (5, the spine) | p120 + 7k on p1, p121 + 7k on p2 |
| reload | state 18 `0x10027d40`, per frame `0x10027e60` | p3 (5; −1 = the whole body) | p98 + k |
| throw | `0x10027b40` | p4 (5; −1 = no throw) | p122 + 7k |
| draw | state 25 `0x10038230` / `0x100392f0` | p6 (5) | p174 + j (`0x100371e0`) |

- **Heading set k** (`0x10042390` → `0x100411e0`): −2 in first person; otherwise the index
  0..4 of the moving-aim set whose clips (p117 run clip, p119, p120, p121 + 7k) include the
  current channel-0 clip, else −1. The sets p116 + 7k are (heading 45 / 120 / 180 / 240 /
  315°, run clip, speed, hold, fire, fire 2, throw); revolver set 0 runs with the armed run
  2:28 and fires 2:278 on the upper body. So k = −2 picks the first-person clips (hold p105, fire
  p106, fire 2 p107, reload p96, throw p108, draw p172), −1 the standing ones (p112..p115, p97,
  p173). p102 / p103 belong to the reload list and to the entry clip p104, so the k = −2 "set"
  only has p105..p108.
- **First-person locomotion** [verified]: the stance helper `0x100456e0` adds 48 to the PWP
  index while the first-person flag (+0xa4 bit 16) is set, so locomotion plays the p61 hold and
  the p65..p84 walk / run sets (and the empty p62 fidget list) instead of p13 / p17..p36 / p14;
  the aim-state sets are skipped (`0x10045e6c`). Entering first person (`0x10042400`) snaps to
  p13 and blends into p104. Melee picks the strike list p86 + 5·(first person) + class
  (`0x1002a1a7`). Hit reactions are not played in first person (`0x1003a548`). Per-weapon clip
  table: docs/game-logic.md §4.5 "First-person clips". (An earlier note said the first-person
  arms play the body's clips and that there are no first-person clips; that was wrong.)
- **Standing** (k = −1 for the old and new clip, no throw heading): the fire clip p121 + 7k
  (= p114) and the reload clip also play on the whole body (`0x10029e72`, `0x10027e34`, not
  while jumping or falling); the throw clip plays on the whole body unless jumping or landing
  (`0x10027c11`).
- **Heading changes** during the action swap the layer clips for the new set's at the node's
  current time (start = node `+0x58`): fire (both bones get p120 + 7k), reload.
- After the fire clip `0x1004cb60` puts p119 + 7k (the set's aim hold, revolver 2:283) on
  bone p1.
- **Blend times** (the request's argument 3): fire on p1, reload and the post-shot hold blend
  in at once (0); fire on p2, throw, draw and the heading swaps use the engine default (the
  clip's type-4 entry, else its header blend).
- Port: `PlayerBody.weaponAction(kind, pwp)` (the four call sites in weapons/system.ts),
  `headingSet`; the whole-body copy only while the body stands still (the port has no
  throw heading state); the first-person arms play the same layers by bone hash. First-person
  locomotion: `PlayerBody.setFirstPerson` and the first-person branch of `chooseLocomotion`.

**Third-person locomotion** (Move per-frame `0x10045d70`; sector pick `0x10045290`, sector
width `0x10045200`, body turn `0x10045550`) [verified code; speeds = data]:

- **Clips.** Standing plays the stance idle p13 (2:27 in every retail set; p110 in the Aim
  state). Moving uses the four heading sets p17 + 5s = {bound, walk clip, walk speed, run
  clip, run speed}; in the Aim state the five sets p116 + 7k with their run clip only. The
  stance helper `0x100456e0` adds 48 in first person and 24 while wounded (`0x1002d490`:
  health below a share between Player p72 / p73 = 15..40 % of the maximum), which selects
  p37..p60: idle 2:178, limp 2:161 at 0.896, hunched run 2:172 at 5, back 2:175.
- **Sector.** The stick angle relative to the body (clockwise, 0 = forward) is in set s when
  it lies in [bound(s−1), bound(s)) — bounds 45 / 135 / 225 / 315 give forward / right /
  back / left. The set already playing keeps 10 % of its width extra on both sides, so a
  stick on a bound does not flicker. Unarmed / shiv / revolver / shotgun / tommy gun sets:
  forward walk 2:30 at 1.626, run 2:28 (shiv 2:408, shotgun 2:413) at 6.637; right 2:379 /
  run 2:329 (shiv 2:410) at 1.626 / 5.110; back 2:29 at 4.109 for both; left 2:380 / 2:328
  (shiv 2:409) at 1.626 / 5.110.
- **Body facing.** The routine also returns the stick's deviation from the set's centre; the
  body turns toward the stick direction rotated by it at width / Player p154 = 90 / 0.35 =
  257°/s. Diagonal input therefore plays the forward (or strafe) clip with the body turned up
  to 45° into the movement; the clip direction always matches the movement. The offset to the
  view is kept at `+0x5ae` and the next frame's stick is read relative to it.
- **Speed.** Run when the stick magnitude (1 − Run/Walk on keys) is above Player p144 = 0.7
  (not in the Aim state). The target speed is the set's walk or run speed; the current speed
  `+0x146` moves toward it linearly at p146 / p147 = 9 m/s² (p148..p151 = 30 in some cases,
  p152 / p153 = 1000 in first person), and the position advances by speed × the stick
  direction each frame. No root motion is used: every gait clip is in place (zero root
  translation), and the speed slot is the speed its feet are animated for (2:30's planted
  ankle moves back at ~1.55 m/s for 1.626).
- **Playback.** `0x1004cb20(clip, bone 0, blend −1 = the clip's default, start, speed 1.0)`:
  rate 1 always (times the clip's own rate, 0.95 for the runs); a new clip starts at the old
  one's time when the state flag allows (`0x10046c7e..0x10046ca6`).

Port (`src/game/actors/gait.ts`, `PlayerBody.setThirdPerson` / `chooseGait` / `gaitCycle`,
`PlayerController.gait`): the same sets, sector rule and hysteresis, idle p13, and the body
offset turned at the set's rate (faster for a large gap, e.g. after the camera orbited while
standing). Sets are picked relative to the view instead of the body (the same in steady state);
starting exactly on a bound (keyboard diagonals) takes the forward / back set rather than the
strafe. Ground speed per set: run = the set's run speed (strafe 5.11, back 4.11), walk = the
set's walk speed or the port's walk speed if faster (the back set stays 4.11). Each gait clip is
rebuilt as one loop starting at the right ankle's lowest point, so clips switch at the same
phase; for speeds between a set's walk and run speed (the port's 3 m/s default walk) the walk
and run poses are blended at that phase (α = (v − walk) / (run − walk), cycle length keeping the
blended stride). Rate 1 at full speed, down to 0.5 while accelerating or blocked. Not modelled:
the wounded stance, the Aim-state sets, the original's acceleration (the motor's own is kept),
turn-in-place clips p15 / p16. `headingSet` maps a gait cycle back to the retail clip it is
mostly made of.

Before (measured in 1a, third person): the in-place gait clips have no root motion, so the
rate rule `speed / root speed` fell back to `speed / 1` clamped at 2: the 3 m/s walk played 2:30
at 2×, the run 2:408 / 2:28 at 1.9×, and walking sideways played the strafe *run* 2:410 at 1.9×
(planted-foot slide 10.7 m/s). Unarmed, the port's own role table played 2:167 and the wounded
run 2:172 instead of the PWP sets, diagonals played the forward clip 45° off the movement
(slide 3.2 m/s), and the third-person idle was the first-person weapon hold p61 (shiv 2:217,
arm held straight out).

**Aim Controller** (class 0x53748f71; constructor `0x1008fbc0`, update `0x10090850`) is a
turret driver:

- **Limits and speeds:** p1 pitch limit, p2 pitch speed, p3 / p4 pitch accel / decel; p5 yaw
  limit (≥ 180 wraps), p6 yaw speed, p7 / p8 yaw accel / decel.
- **Bones:** p10 / p11 pitch / yaw bones (≤ 0 = the whole object), p12 aim origin.
- **Targets:**
  - p14 default targets, p15 order, p16 / p17 dwell;
  - p18 / p19 acquire / lose cones;
  - p20..p26 spotting (players, cone p25, line of sight).
- **Motion:** a second-order slew (`0x1008eb60`), applied through `node +0x10` hooks.
- **Yaw slew** (`0x10090b4e..0x10090d96`, `0x1008eb60`, degrees): within 0.001° of the target,
  moving away from it, or once the stopping distance v² / (2·p8) reaches what is left, the speed
  falls by p8 per second (never past 0); otherwise it grows by p7 per second toward the target.
  The speed is then clamped to ±p6 and integrated; the yaw is clamped to ±p5 (p5 ≥ 180 wraps
  it to ±180, `0x10090d79`).
- **Cones**: p18 is the acquire cone (`0x100905ab`: the target counts as acquired when the
  direction to it is within p18 of the current aim), p25 the spotting cone for players
  (`0x1008fe81`). Changing targets fires output p30 (got one) or p31 (lost) (`0x1009092d`).
- `docs/game-logic.md` §15.3 used to read p18 as the turn speed; it is the acquire cone, and the
  turn speed is p6. Port (director.ts `aimSlew`): the yaw slew with p5..p8; the cones, the
  spotting and the outputs are not modelled.

## 10. Port summary

- `Character`:
  - engine-curve cross-fades (`crossFadeTo`, `fadeAction`; `play()` uses them, with
    `blendInto` as the default blend);
  - layers (`playLayer`, `stopLayer`, `releaseLayers`, `isLayerAction`, `layerBoneForClip`);
  - `poseHooks` that run after each pose;
  - `RootAxes` root-motion modes when clips are built.
- Sequence presenter:
  - secondary channels as layers;
  - root-motion modes per key, with mode-1 drive (translation and rotation);
  - the camera time scale;
  - skip end states per channel;
  - cranes animated through `ctx.services.skinnedProps`.
- Actors: ProjectileAttack's aim / fire / burst cycle on the whole body (the Mainliner's channel
  aim pose through `Character.playLayer`).
- Player body: `weaponAction` for fire, reload, throw and draw (independent layers on the PWP
  bones, heading-set clips, whole body while standing); the pitch bend
  of spine, neck and shoulders.
- Actors: `LookAtBone` (facing channel) and `AimBones` (shoulders) while shooting.
- `tools/stomp-audit.ts`: expected positions include mode-1 root motion (held segments).
