# Chapter 1 playthrough QA (1a → 1b → 1c → 2)

Tool: `tools/playthrough.mjs` (driver) + `tools/playthrough-page.js` (page-side helpers).
Regression tests: `tests/playthrough.test.ts`, `tests/playthrough-ai.test.ts`, `tests/flee.test.ts`,
`tests/use-target.test.ts`.

```
node tools/playthrough.mjs --tmp <scratch dir> --shots <dir> --out report.json [--keep]
     [--from <step>] [--to <step>] [--level 1b] [--invulnerable] [--watch <s>] [--difficulty 0..3]

--level starts that level through the developer deep link (logged; the shiv is given, logged).
A level entered through a transition (`ARRIVALS`: 2 from 1c, 3a from 2, 3b from 3a) starts in the
level before and fires its exit at once (logged), so the arrival (spawn point, Level Transition
Msg Handlers, the carried companion) is the game's own; its `kit` gives what a player carries by
then (logged). --direct starts the level itself.
--difficulty picks the New Game difficulty with the arrow keys (default 1, Medium), or passes it
to the deep link.
--cine-strip <s> (with --shots) saves a frame of every cinematic each <s> seconds (8 at most).
--save <file> restores a state captured with the control server's GET /capture?name= (exploring a
later part of a level; logged). POST /run with a step object (JSON) tries a step not yet in ROUTE.
```

The run boots the front end like a player (start gate click, logo movie skipped with Esc, main
menu Enter, difficulty Medium Enter), then follows `ROUTE` in the tool: one step per objective,
derived from each level's message graph (`tools/entities.ts --graph`), its Detectors, Switch
outputs, STOMP Players and Level Transitions, and checked in the browser.

## How the harness plays

- **Walking**: the page plans a path over a 0.4 m grid probed from the collision world (ground
  queries, a step-lifted capsule, stairs as two half steps, a half-step-shifted grid retried for
  narrow gaps); closed doors the player can open count as passable. The page turns the view
  along the path each frame; the harness holds the real move key (W) through CDP key events and
  presses E at doors in the way. Stuck: jump (Space), replan, then give up.
- **Running**: the Gameplay option "Always Run" is on (`PlayerController.alwaysRun`; the
  default is walking with Shift to run), so holding W runs as in the original's default.
- **Using / picking up**: walk to a spot the object can be used from, look at it (the view's own
  pick test must hit it), press E. A door is looked at by its handle: the anchor of its
  Interaction Properties fit test (`__pt.useAim`), which the original's Use requires the player
  to face (docs/game-logic.md §14.5 "Use target"); doors met on a walk or a stroll likewise.
- **Pushing**: grab with E, hold W (push) or S (pull) until the object is in place, let go
  with E; a creature attacking meanwhile is fought first, then the push is tried again.
- **Climbing**: `clamber` walks to the foot of a ledge, looks at it and presses Space (the
  clamber key) per Clamber Point; `ladder` walks into the ladder facing it and holds W to the
  top; `route` steers along hand-laid points the grid planner does not take (drops of a few
  metres, a mound taken with a jump), pressing Space when stuck.
- **Following**: `follow` keeps within 3 m of an NPC; with `fight` it fights creatures that
  hunt nearby, and goes for the creatures around while the NPC stands waiting (not while it
  waits to talk: a SimpleConversation starts only with the listener close). Swings and shots
  are held while an ally stands in front within 3 m.
- **Fighting**: keep the view on the nearest creature hunting the player and swing; drink a
  Xombium bottle below 40 health. Arena steps keep fighting until the level logic moves on,
  going after copies that do not come down, transforming when the insanity meter is full and
  changing back when it runs dry (the original keeps the creature form at an empty meter,
  draining health, until Insanity is pressed again; 1b's arena ends only once the player is
  human again inside Detector 7ed4); a
  timeout falls back to the logic's own next message (logged).
- **Shortcuts, always logged in the report**: the mouse look is set directly (yaw / pitch) and
  the weapon fires through `services.weapons.fire`, the Xombium bottle through
  `useHealthPack`, the creature attack through `__insanity.body.attack` and the transformation
  through `__insanity.transform`, because headless Chrome grants no pointer lock and those
  inputs require it. Steps whose walking route is not scripted (`goto`) fall back to a logged
  teleport; a death is retried from the last checkpoint step with invulnerability (logged and
  kept on from there).
- **Walked like a player** (`stroll` steps): no path planner and no look-at. W is held with the
  gait a player uses (`gait: 'walk'` or run), and the view turns towards each point of `via` at
  a mouse-like rate (`turn`, rad/s), so corners are rounded and the view sweeps as it would by
  hand. A door that stops the player is opened with E where he stands. `watchScenes` measures how
  long an actor is drawn on screen while a sequence runs: shown, not culled, and the centre of its
  skeleton inside the view (clips can carry a body metres from its origin). `__pt.watchScene` /
  `__pt.onScreen` do the measuring, and `expect.scenes` sets the minimum. With `--shots`, six
  frames per scene are saved as a strip. The 1a guard post hall is walked this way (bug 28).
- **Where a character is** (`expect.actorAt`: uid, position, tolerance): 1b's Horace after his
  cinematic (bug 29).
- **Checked after every step**: console errors / exceptions, player alive / health / position,
  the objective (`expect`: sequences played, objects destroyed / open / taken, a checkpoint
  taken, the level), cinematics seen, checkpoints, music (`__music`) and ambience (Ambient Sound
  zone beds, looping level emitters in earshot and Flying Sounds switched on), fps / draw calls / triangles, actors near the player floating / sunk / stuck
  (away from their authored placement), and a screenshot for the key steps.
- **Items placed during play** (`pickNear`, the electrocuted guard's revolver): looked at from where
  the player stands first; `__pt.itemView` reports the mesh built, in the scene, shown, on screen
  and the brightest of its load-time colours (0 fails the step: drawn black, bug 30), with a
  frame `<step>-seen`; then taken with E like any pickup.
- **Dying and restoring** (`--deaths`, row 49): `<step>.die` records. A death after the step,
  then the game's own checkpoint restore. Differences in what the level logic, actors and player
  run on fail the record (`restoreDiff` in the report keeps them all). Clocks are compared as
  clocks, and corpses of spawned creatures are left out (not kept by the port's saves). The steps
  after the checkpoint then run again as a player.
- **Save / load** (mid-1a, start of 1b, mid-1c): Esc → pause menu → Save Game → new slot with
  the arrow keys and Enter, walk on, Esc → Load Game → that save → confirm; then doors, items,
  STOMP Players played, Detectors, actors (alive, health, position), player health,
  reputation / insanity, weapons and inventory are compared with the state before saving.

## Bug log

| # | Where | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 1 | 1a lobby / sally port | The three lobby statues (Pushable 9:3359) did not exist: the statue the player pushes into the corridor to start the booth CartWheeler scene (Detector 8b3d, pushables only), and the one that jams the sally port's south gate open, were missing, so the route north (and the third checkpoint) could not be reached. | `dynamicObjectUids` built non-switch, non-pickup objects only with instance flag 0x80; these Pushables have flags 0x801. | Pushables the player can grab (p23 ≠ 0) are built without 0x80 (`src/game/world/dynamic.ts`). Scripted ones (p23 = 0: 1b's untextured 9:3561 / 9:5416 sheets across a corridor) stay out. | fixed, tests |
| 2 | 1a booth | After the CartWheeler bursts out of the booth, its door (Switch 512a) stood there again, visible and solid: the booth button was unreachable. | Sequence 5db4 destroys 512a and hides it through Visibility Toggler 68aa at 0 s; the toggler's Show at 5.5 s brought the destroyed door (mesh and collision) back. `World.setVisible` showed destroyed objects. | A destroyed object is not shown again (`src/game/world/logic.ts`). | fixed, test |
| 3 | 1a escort | The guard who leads the player (609e) walked into the gate leaf the lever had just swung open (7f48) and stayed there for good. | Stuck recovery replans from the nearest Move Node "in a straight line": a thin ray slipped between the gate's bars to the node behind the leaf, and the skip-ahead test (`clearWide`, three rays) did the same. | Replans start from a node the body can reach (`NavGraph.nearest` with the body radius); `clearWide` also sweeps a sphere (`src/game/actors/nav.ts`, `actor.ts`). | fixed, tests |
| 4 | 1b arrival | The arrival room's exit (Switch 6433, starts open) stayed shut: no way to the Horace scene. | Its motion is 95° at speed 0; `switchMotion` treated speed 0 as no motion, so the start-open pose was never applied. | Speed 0 with a travel is an instant move (`switchMotion`, `src/game/world/logic.ts`). Census: the only such switch in the 18 levels. | fixed, test |
| 5 | pushing | Pulling a grabbed object (walking backwards) moved it a few centimetres, then let go. | The crate follows at its push speed (1.2 m/s); the player outran it and the grab let go at 3 m. | The player is held at the grab distance both ways (`src/game/world/props.ts`). | fixed, test |
| 6 | 1b arena | The arena never started after the Horace scene: Hermes' lines never played, so no CartWheeler waves, no transformation, no way on. | Hermes has instance flag 0x1 clear (hidden from the start); `Actor.update` returns for hidden actors, so his SimpleConversationBehavior never ran and its end (p17 → Relay 7ecc) never fired. | A hidden actor still runs a `talk` behaviour (`src/game/actors/actor.ts`). | fixed, verified in the browser |
| 7 | save / load | After a death in the 1b arena the checkpoint (taken as the Horace scene ends) came back with Hermes idle: the arena stalled for good. | A save applied before the level's first frame has no behaviour library at hand, so an actor's placed behaviour (`b`) was dropped and the template default ran; and the Behavior Changer chain callback (its p17 when the chain completes) is a closure that no save kept. | `Actor.restoredPlaced` is started by `ActorManager.init`; the director saves running chains (`chains: [actor, Behavior Changer]`) and re-attaches the callback after the actors are restored (`src/game/actors/actor.ts`, `manager.ts`, `director.ts`). | fixed, verified in the browser (death → restore → Hermes talks, chain re-attached) |
| 8 | 1c companion | The inmate behind the barred door (7569) talked, then walked into the door for good; the checkpoint behind it and the way on were cut off. | His only waypoint (756a) is on the player's side of Switch 5262, which is locked and never unlocked by any message; the AI only opened locked doors with p63 (scripted). | People not against the player (Unspeakable NPC, not hostile, with an OpenDoorBehavior) open locked doors on their path (`src/game/actors/system.ts`, world service `openDoor`) [inferred]. | fixed, verified in the browser |
| 9 | 1b / 1c arrival | Arriving through a Level Transition, the player walked over a start kit lying on the floor (1b: 6 pickups; 1c: 17, a Tommy Gun and a revolver among them) and carried an early revolver into 1c (auto-equipped, empty). | Pickups linked from the level's own Player object (its direct-start position) were placed as world items whatever the way in. | Entered through a transition (or a save of such a visit: `GameContext.startKind` / `savedSpawnName`), those pickups are left out (`src/game/world/world.ts`, `runtime.ts`, `main.ts`) [inferred: a direct start keeps them as the level-select kit]. | fixed, verified in the browser |
| 10 | save / load | (found by `tests/save.test.ts` after fix 2) Loading a save onto a played level left a picked-up item hidden. | The world provider restored visibility before un-destroying, and fix 2 makes `setVisible(true)` ignore destroyed objects. | Destroyed state first, then visibility (`src/game/save/providers.ts`). | fixed, test |
| 11 | 1b arena / 1c yard | Wall creatures never came down: the 1b wall-hole copies (JumpBehavior 10:175 / 10:640) stayed on the wall top at 82.8 m, the 1c yard CartWheelers (10:129) dropped straight down. | JumpBehavior was a plain fall: no launch clip root motion, no launch velocity, no gravity scale, no timer, no alert on landing. | Decoded (RFL 0x100edf30 / 0x100ec710 / 0x100f0cd0 / 0x100efe70): the launch clip's root translation moves the body (3.26 m down the wall), then velocity = facing × p7 + up × p8 (m/s) under gravity × p9, p5 / p6 airborne / landing clips, an attack stimulus at the earlier of p2 and the landing, done at the later (`actors/actor.ts`, `behaviors.ts` `jumpParams`). | fixed, tests, verified in the browser |
| 12 | sight | Copies on ledges and holes never noticed a player on the arena floor; creatures with their back turned did not see the player 3 m behind. | `perceive` rejected targets more than 5 m above or below, read KillEnemiesBehavior p7 (45) as a view half-angle and p10 as the range. | Decoded (0x100f7d40 / 0x100fbdd0 / 0x100f39a0): p7 acquire range (a box on x / z, then 3D), p11 the FULL view angle (CartWheelers 360), p9 always-see radius, p6 a line-of-sight ray, p10 the keep range (the current target stays selected unseen); no vertical limit (`behaviors.ts` `sightRules`, `actor.ts` `perceive`). | fixed, tests |
| 13 | melee | A CartWheeler could start an attack from 2.5 m × its size; it would not start one at the foot of a ledge the player stood on; a creature "attacking" the player through a shelf was refused its blows by a wall test. | The reach was max(Attack p6, p16), but p6 is the damage multiplier; the port added height, facing and clear-line tests. | Decoded (0x10080180 / 0x10080010, KillMelee 0x1007c910): p15 ≤ horizontal distance − target radius ≤ p16 (× the size scale with p14), \|dy\| ≤ p17 when p17 > 0; no line of fire (`clipmap.ts`, `actor.ts` `pickAttack` / `canHit`). | fixed, test |
| 14 | 1b arena | Placed and copied CartWheelers "chased" for minutes without moving (671a / 671f in the last run). | The route started by skipping to the second node "already between the first two" without checking the body could walk there: the sloped light shaft of fix 20 stood in between; the stuck recovery planned the same route again forever. | The skip needs a clear wide line; a move that stays stuck on the graph makes the actor give up its target like the original (KillEnemies 0x100fbbdf: stop, idle, forget the target, re-evaluate after p12 + U(p13) s; the failed target ranks last for 5 intervals but is still picked when alone) (`actor.ts` `giveUpTarget`). | fixed, verified in the browser |
| 15 | 1b / 1c | The scripted Slayer 7ff6 (1b) could be killed before its scene; the locked exit doors 52b6 / 57e9 could be smashed. | GameObject p3 (1 = starts invulnerable) was not read; the port only had the p13 / p14 messages. | Init 0x100a3166 passes p3 == 1 to the invulnerability setter: actors and props start invulnerable with p3 = 1, saved when changed (`actor.ts`, `world/props.ts`). 1c's inmate is invulnerable in his cell until Waypoint 756a sends 91. | fixed, test |
| 16 | 1b ledges | The ledge 7f85 (3.5 m above the 8004 ledge) could not be climbed: no way to checkpoint 833b on foot. | Clamber Interaction Properties p7 (2.5) was read as the maximum height; only the first template (one side) was tried; the box's nearest point stood in for the anchor. | Decoded (0x10011910 / 0x10011030 / 0x100bb4e0): the first p30 template that passes; p3 side, p1 reach, p7 the minimum and p2 the maximum height, p4 / p5 bearing, p6 facing, p8 anchor offset (`world/clamber.ts`). | fixed, test, verified with the Space key |
| 17 | harness, 1b | The route teleported to "checkpoints" 8bec / 8bea, the sewer and its end scene 8283. | Those are the revisit from 6b: Detector 8282 has flag 0x8 (never created), 8283 is started by the arrival handler 8933, the sewer autosaves sit past a gate (6548) whose lever 7b5b is on the far side. | The chapter-1 way: clamber the two ledges, checkpoint 833b, Horace's scene, smash the locked door 53c2 (30 health), the vision room, pull the crate 7fde out of Detector 7fe9 (which keeps door 653a locked), the ladder 82e2, then try the locked exit 52b6 (its use fires p68 → Timer 79c2 → Level Transition 79c3). New step kinds `clamber` and `ladder`. | route fixed |
| 18 | harness, 1c | The yard group was not cleared and the inmate never reached Waypoint 7b8c. | The yard creatures stay on the walls until the inmate leads into the yard (Waypoint 7581 / Detector 7ded → 6520 jumps; 6517 / 6516 follow when 6520 or the Slayer 7def dies); the route fought before following him. His last walk (to 7b8c, which enables 7813) starts only when the second group (Count Down 7e2a: two Slayers, six CartWheelers) is dead. He is vulnerable after his cell and creatures hunt him (team 10:212). | The route follows him and fights what hunts nearby (`follow` with `fight`), then goes for the creatures around while he waits. | route fixed |
| 20 | 1b arena | Copies coming for the player on the arena floor stopped at x 463.8 and "chased" or "attacked" there for minutes (the case first logged as attacking behind a slatted shelf); the player's shiv could not reach them either. | A sloped light shaft (level geometry with Advanced Material 9:5841: additive, no depth write) collided like a wall; the Move Node edges 727b / 7280 → 727c run straight through it. | Surfaces whose every layer only adds light (additive, no depth write) are not solid (`app/physics.ts` `lightOnly`); 22 parts / 12 k triangles in 1b. | fixed, test, verified in the browser (all seven copies of a wave reach the player) |
| 21 | 1b arena | The arena never ended: after the transformation the last wave came and went, but the scene 80a6 that opens the arena door never played. | Detector 7ed4 sends On every tick while the player stands in the arena; transformed, that reaches Timer 8b9a (6.5 s, one of the two Decrements Count Down 80a5 needs) on every tick, and the port's Timer restarted its countdown on each Start, so it fired only after the player left the arena. | Decoded (RFL 0x10133a30 / 0x10133a90 / 0x10133b50): Start only lets the countdown run (and keeps the sender); the countdown is drawn at init and after each firing; Stop pauses (`world/logic.ts`). | fixed, test |
| 22 | 1a escort (user report) | After teaming up, the guard 609e did not come along when the player went on to the gate he has to open: he stood at the meeting point for good. | The port's WaypointBehavior escort waited while the player was farther than p10 (20 m, horizontal) and never moved towards him. | Decoded: a leg starts only while the escorted objects are within p9 (3D); one beyond p10 is fetched (the NPC paths to it); a leg under way is walked to its end (`actors/actor.ts` `runWaypoints`). Route steps `1a.ahead` / `1a.guard-comes` play it on foot. | fixed, verified in the browser |
| 23 | talks | A speaker set to walk up to the listener (SimpleConversationBehavior p5) did nothing when the player was more than 30 m away, and started talking at p10 m. | The approach had a 30 m cap and used p10; p9 / p10 were read as the start range. | Decoded: the talk starts within p11 m (and p12 m in height); with p5 the speaker walks up to the listener however far it is (`behaviors.ts`, `actor.ts` `runTalk`). | fixed |
| 24 | 1c yard | The inmate 7569 stood for good facing a bench on his walk to the yard gate. | The "can I walk straight there" test was a thin ray at 0.8 m: it passed under the bench seat / between the rails, so he walked into the bench instead of taking his Move Node route. | The test sweeps a sphere of the body's radius at hip and chest height (`actors/actor.ts` `clearLineCached`). | fixed, verified in the browser |
| 25 | 1a guard (user reports) | The electrocuted guard 609e kept his revolver; then (first fix) the posed corpses on the way to him dropped revolvers when hit. | Weapons were never dropped; the first fix dropped every character's p52 weapon. | Decoded (Character death 0x100e5d00 -> 0x100e12f0, body-part sets 0x10095d10 / 0x10096400, item drop 0x10096c20 -> 0x100be330 -> 0x100bd300): a character holds its p52 weapons only when p53 is set (else only a SpawnWeapons clip event gives it them); at death p109 1 drops them, 2 destroys them; a dropped Item with a p27 template becomes that pickup (10:1801 -> Ammo Box 4:1404, the Revolver 4:5). In 1a only 609e, the gas chamber guards 782b / 7831..7833 and the office guards a script destroys have p53 = 1; every corpse before the electrocution has 0 (`actors/drops.ts`, `system.ts`, world service `dropItem`, `weapons/npc.ts`). Saves list the dropped pickups and a load places them again (`world.ts` 'drops' provider). | fixed, test |
| 26 | 1a guard (user report) | The electrocution looked thin: the arcs over the guard stopped the moment he died. | The Electric Arc Effect on a character ended with its life, but the same shock kills him (Damage Action Objects 75dd / 8185 fire together). | The effect lasts its p0 (15 s) on the body, the bolts running along a body on the floor (`actors/director.ts`). The rest of the scene is level data the port already plays: Relay 7619's looping Damage Actions arcing over the door's Decorations (816e / 81d2 / 818e / 82a4), the spark generator 816d and the two Light Housings blown by Relay 81bc; each bolt flickers a blue light. | fixed, verified in the browser |
| 27 | harness | The escort guard was hit by the harness's own swings at a CartWheeler next to him, turned on the player and was killed. | The harness swung whatever stood in front. | It holds the swing / shot while an ally (not hostile, not after the player) is within 3 m in front. | fixed |
| 28 | 1a guard post (user report) | "The man that gets buried by the earthquake rubble does not show up": walking the hall like a player, the guard of "Gaurd" #86 / #114 (7508) was never seen; the harness route happened to show him. | Both scenes start through Visiblity Message Filters (6a86 at the hall's far end, 6c7c down the east walkway). The port read their p2 / p3 (90 / 90) as half-angles, so they passed for anything in front: #86 started the moment the player reached the hall's corner facing east (with the duct scene #242 behind him at the same time), #114 the moment he entered the junction facing south, and the guard ran and was buried out of sight. | Decoded the filter test (Suffering.rfl 0x10136db0): p4 range from the camera, p5 always within that distance of the player, then the object must be in front and inside the centred p2 % x p3 % of the screen, then (p1 >= 0) a clear ray. Uses the drawn camera (`logic.ts visibilityFilterPasses`, `WorldHooks.view` in `world.ts`). Reproduced by walking the hall like a player (W, walking and running, view turned by hand, first and third person, 8 paths), A/B against the old reading swapped in at run time: walking down the hall, the old reading started #114 at the junction facing south and showed the guard for 0.05 s of the 1.44 s before the scene's Destroy key removes him; the screen test shows him for 0.8-1.45 s on every path that turns towards the walkway, and #86 for 2.4-2.6 s of 3 (docs/game-logic.md §11.5 item 5). Route step `1a.guard-post` (a `stroll`) walks the hall the same way and fails under 1.5 s / 0.7 s on screen. | fixed [verified], tests, verified in the browser |
| 29 | 1b Horace (user report) | "The electric guy falls down from his spot after the cutscene": Horace (7eb2), standing in his electrified cabinet over the arena, dropped onto the arena floor when "Camera" #247 released him (y 80.25 -> 73.67). | The hand-back re-placed the body with the motor's teleport, which first pushes the capsule out of what it overlaps: his niche is narrower than his 0.49 m radius, so he was pushed off the 20 cm beam he stands on. | The hand-back keeps the keyed position and stands the body on what is under its feet (snap up to 1 m, else it falls) without pushing it out of the geometry (`actor.ts handBackAt`), for every sequence-released actor. Step `1b.horace` checks him in place 4 s after the cinematic (`expect.actorAt`). | fixed [inferred rule], test, verified in the browser |
| 30 | 1a guard (user report) | "When the cop dies from the electricity he doesn't drop his gun": checked on the current tree from the player's view, the revolver (Ammo Box 4:1404, uid 7d000000) is dropped, drawn (in the scene, not culled, not batched: runtime pickups are built after the static batch), lies on the floor (y 88.71, floor 88.66) clear of the door and the arcs, survives them (still there 150 s later with Relay 7619's arcs running), shows "E - Pick up Revolver" from 1.3 m and is taken with E. But it was drawn black: every vertex colour 0, lit only by the flashlight and the arcs' flicker, a dark shape on the dark uniform it lies across. | The drop is a level object with index -1 and flag 0x1; `loadPassBefore` took -1 as its creation order, so the load-time pass saw no light at all (no ambient, no directional). | An object created during play (index < 0) gets every load-time light, as the pass at its first draw does (`world/dynamic.ts loadPassBefore`): ambient 0.11-0.125 plus the room's directional, as the placed pickups around it. Placement unchanged (0.5 m ahead of the body at death; the original drops it from the hand and lets it fall, not decoded): the body's death clip lays his chest over it. | fixed, test, verified in the browser (`1a.guard-gun` records it drawn, lit and on screen, frame `1a.guard-gun-seen`) |
| 31 | harness | Optional pickups the route cannot reach yet (1a Xombium 6ff5 behind a door the guard opens later) took 470 s, the flashlight 247 s. | A failed plan expands up to 80 k grid nodes (~0.5 ms each on a busy page) on four grids (three half-step shifts), and `walk` re-planned it up to 7 times "for moving obstacles". | Plans have a time budget (20 s, 3 s for the shifted grids, `timedOut` reported); `walk` stops re-planning when a failure repeats with the same shortfall. 6ff5: 119 s. | fixed |
| 32 | harness | "No checkpoint taken" at `1a.cp3`, `1b.cp2`, `1b.cp3` although all were taken (8397, 8339, 833b in the log). | The objective was checked the moment the walk reached the Autosave's Detector; the save system takes the checkpoint two settle frames later, not while a cinematic runs, after its capture: the line came a moment after the check. | `expect.checkpoint` takes the Autosave uid and waits up to 10 s for it (`true` still means one during the step). | fixed |
| 33 | harness | Save / load at the start of 1b reported the battery 0.95 -> 0.9, in the next run 0.037 -> 0.994. | Both charges were rounded to 0.05 before comparing (the drain crossed a step); at 0.037 (3.9 s left, dimming) the lamp used a spare battery (4:203) by itself after the load, as designed. | Charge + spare batteries, compared apart within 0.06. | fixed |
| 34 | harness, 1c | The inmate 7569 died in the yard: his FleeBehavior 7e38 took him 30 m off (448, 450) where the creatures killed him while the harness fought by the gate; Level Transition 7813 then stays disabled (open observation). | `follow` with `fight` fought only what hunted near the player. | When the followed NPC loses health more than 5 m away, the player goes to it and fights there. | fixed (harness) |
| 35 | harness, 1b exit | Using the 1b exit door 52b6 "did nothing" (no transition in 30 s, the transition fired as a shortcut); the previous full run had the same. | Using it starts Timer 79c2 (0.65 s) -> Level Transition 79c3, over within the step's 1.5 s pause; the harness read "the level before" after that pause (already 1c), saw no change and pressed E again, on 1c's own door 52b6 by its arrival point, which leads back to 1b: the run bounced 1b -> 1c -> 1b. | The level is read before the first use. Verified: 1c reached on the first use, no shortcut. | fixed |
| 36 | harness | A death during a `wait` step (the 1a gas trap) went unnoticed: the game restored checkpoint 8397 by itself, the trap's scenes read "not played" and every step after it failed from the wrong place. | `wait` steps and `then.until` polled their condition only. | They watch for the death too (`waitAlive`): retried from the checkpoint step like a death anywhere else. | fixed |
| 37 | 1c companion | The inmate 7569 died in every run: his FleeBehavior 7e38 took him from the yard gate to (448, 450) and stood him there while the wall CartWheelers 6516 / 6517 (and 6520 before them) hit him, 8.8 and 15 a blow, until dead (logged by attacker: no creature was after the player then). With him dead Level Transition 7813 stays disabled. | The port's FleeBehavior was a guess: run to the Flee Position farthest from the player and stay; 7e3c (448, 450) is right under the CartWheelers' drop. Neither the team lists (creatures target prisoners in the original too: KillEnemies scores him like the player, docs/game-logic.md §15.15), his resistances (gas types 16, 18, 19 only) nor the hit reactions keep him alive in the original: his flee does. | Decoded (Suffering.rfl FleeBehavior 0x10157640, choice 0x1010f3c0 -> 0x100adaa0, §15.14): spots of the group, away from the threat teams p42 (a threat within 8 m rules a spot out), near the allies p44 (the player), not past a threat; re-chosen every 0.4..0.8 s while standing; a spot is left after 3 hits of 5+ in 5 s or one of 10 % health (`actors/flee.ts`, `actor.ts runFlee`). | fixed [verified], tests, verified in the browser |
| 38 | 1c companion | With the flee fixed he ran from the first yard into the east yard (Flee Position 7e42) and the second group's Slayers shot him. | Move Node NPC Exclusion Types were not read: 7ee1 / 7ee2 (p3 = 0) keep his type out, 7b71 / 7b72 (p3 = 1) are his own way in, off (EdgeToggler 7ee3) until the first group is dead. | Decoded (0x100d9bb0 / 0x100dbf30 / 0x100dc070): Move Node p2 types, p3 only-these / not-these; a character's type is Character p45 (`nav.ts navNodePasses`, `path(..., { navType })`); the flee leaves out spots he has no path to (§15.14). | fixed [verified], test, verified in the browser |
| 39 | 1c companion | His last walk (WaypointBehavior 7b8f, to Waypoint 7b8c, which enables 7813 through Relay 808c) ended at the foot of Ladder 7c2f for good; the player could not get past him onto the ladder. | Nothing but the player climbed ladders: Edge Passage 7e4f names Ladder 7c2f on the edge 7b8a - 7c7f. | NPCs climb a Ladder on their nav edge with their LadderClimbBehavior clips (Character p102), 0.5 m a rung clip, and step onto the far node (`actor.ts tryLadder / updateClimb`) [inferred geometry, §15.5]. | fixed, test, verified in the browser |
| 40 | 1a office (use target) | An open door's box beat an item at the centre of the view: door 561b was offered instead of the flashlight 6978. | `pickTarget` tried switches by the view ray first and returned any hit before looking at items. The original never ranks pickups against usables (they are taken by touch) and offers a Switch only from where its Interaction Properties fit (reach 2 m to the anchor, facing, side; docs/game-logic.md §14.5 "Use target"). | Items come first; a Switch must pass the decoded fit test (`use-anim.ts switchFit`, `interact.ts switchReach`) and the nearest approach point wins (`world.ts pickTarget`). From every spot 1-2 m from the flashlight looking at it the door does not fit (closed or open either way). | fixed [verified], tests |
| 41 | harness, 1c | With the companion fleeing out of the way, nobody crossed Detector 7e13: the east yard's last CartWheelers (Relay 8017) never came and Count Down 7e2a stayed at 6. | The route only followed him. | Step `1c.east`: the player walks into the east yard across 7e13 and fights there. With row 40 the harness also looks at a door by its handle (`__pt.useAim`, the fit anchor; then the middle, then higher) and does not press E on a crate that takes the view's pick (1a: Pushable 80ed in front of door 4ed6 was grabbed and the run stuck at `1a.cp2`). | route fixed |
| 42 | 1a gas chamber | The gas killed the player in runs 2, 3 and 4 before the window scene: 93.5 health gone in 4.5 s (not 1.9 / s over 48 s: the first tile lit 44.6 s after #212 started), standing by the entrance door. | Two things. The harness stood where the gas starts: the tiles light from the tank door (south row at 5 s) towards the window (north row at 15 s), and the player waited by the entrance door 50e7 in the first one (13 / s) and within reach of the next (26 / s from 7 s). And the touch test was a guess: every body a capsule with a 10 cm contact allowance. | Decoded (docs/game-logic.md §14.2): the touch comes from the mover's own collision query, the player's body (Player vt +0x20 -> 0x1002cb50, filter 0x1002c340(0) makes Particle Fountain collide) and a character's mover (touch component +0x1ae, collide list 0x10178c40). The contact is geometric with no allowance; for the player, his skeleton's hit spheres (2:138 in first person, 2:9 in third) against the tile, a 1 mm box on the floor. Standing on a tile still hurts at 13 / s (no resistance, no difficulty scaling) [verified]; the 1.1 m strip under the window has no tile, and a player who waits there takes nothing at any difficulty [data; the outcome inferred]. Port: `fx/gas.ts` (sphere / box test, tree leaves), `fx/gas-system.ts` (posed spheres for the player, the capsule strictly for characters). The trap step waits there (row 44). | fixed [verified code path], tests, verified in the browser |
| 43 | 1a gas chamber | The window CartWheeler 64f6 stood 0.5-0.7 m in the floor at the end of its scene (run 1: -0.52, state `act`). | "CartWheeler" #210 plays 12:4 and 12:11 with root motion extracted on every axis (key flags 0x155). 12:11's root goes 0.3-0.7 m down for its last 1.2 s, the landing inside the room, and the presenter moved the object by that delta with nothing under it. Not the crawler hang offset (d6c5ae6) and not the hand-back (246c225): the hand-back stood it up again at its release. | A character the extracted motion takes down stops on the floor under it (`sequence/clips.ts driveFloorY`, `sequence/system.ts applyDrives`) [inferred: the engine hands the delta to the character's mover, 0x478b90 -> anim component +0x6c]. Measured: never below its floor while scripted (was -0.69). | fixed [inferred], test, verified in the browser |
| 44 | harness, 1a | The gas trap step waited for the window scene where the gas starts, and fought the CartWheeler by walking into it over lit tiles. | The step was written as a wait. | `1a.gas-trap` walks to the strip under the window (420.5, 463.75), waits for #210 to end, then fights without stepping off it while any room tile is lit (`fight(..., stay)`); `--difficulty` runs Hard. | fixed |
| 45 | checkpoint restore | After a death during a held, locked body clip, the restored player could not move: W did nothing. The locked clips are the transformation's put-away, a Nooseman's grip and a Mainliner's ride. Reproduced: lock a clip, die, let the game restore the checkpoint. `motionOverride` was still the old body's lock, and the player stayed where he was. | The player controller outlives the level's systems: a restore restarts them in place (`main.ts restartLevel`). What the old systems had handed it stayed on it: the old body's motion lock, ladder / clamber / use-animation locomotion, a facing lock, virtual input, a disabled player. | The save system is the first system of every level start. It now releases the controller (`releasePlayerControl`, `save/providers.ts`). The original rebuilds the Player object from the checkpoint (docs/re/saves.md §4.1) [verified: revert = full rebuild]. After the same death the player walks 4.8 m in 1.5 s. | fixed, test, verified in the browser |
| 46 | checkpoint restore | On a restore, behaviours started over. A WaypointBehavior went back to its first waypoint, sending each waypoint's arrival message again. A conversation began again at its first line, firing its line messages again. | `ActorSaveState` kept only which behaviour ran. | Decoded: behaviours save and load their own state (behaviour vtable +0x44 / +0x48, e.g. FleeBehavior 0x1010b420 / 0x1010b4b0) [verified]. The actor record now keeps the progress (`bp`: phase, line, waypoint, time left) of WaypointBehavior, SimpleConversationBehavior and Horace's zap. The restored behaviour goes on from there (`Actor.resumeSaved`, `ActorManager.init`). | fixed, test |
| 47 | checkpoint restore | Speech Players and Action Dialogs came back reset. A line playing at the checkpoint never sent its end messages (p8 / p9) after the restore. The in-order index started over (1b 889c 1 → 0, 1c 7e3a 1 → 0). A removed Speech Player could play again. | The director saved none of it. | `DirectorSave.speech / speechGone / dialogs / dialogsGone` (`actors/director.ts`): the index, the time left of the line playing (its end still comes; the line is not replayed), attached / muted dialogs. | fixed (found by the restore check) |
| 48 | checkpoint restore | After a restore, a CartWheeler that started on the ceiling (template p180) and had since come down hung on the ceiling again. | Its surface lived only in the special move, and a new move starts on the ceiling. | Special moves can save their own state (`SpecialMove.save / load`, provider `actors.specials` after `actors`). The CartWheeler keeps the surface it is on, and a transition under way counts as done. One that had climbed up was already hung again by its update. | fixed, test |
| 50 | checkpoint restore | A restore dropped the bodies of dead Object Cloner copies. Their Object Cloner then had a free slot it did not have when the checkpoint was taken (1b 7eb1: 1 copy counted → 0), so it could send a copy early. | Dead spawned creatures were left out of the save. | Dead Object Cloner copies are saved and come back as bodies (`actorsSaveProvider`). The cloner keeps them for the rest of their p4 hold (`Director.setSpawnerState`). The original keeps the body as an object of the level. | fixed (found by the restore check) |
| 49 | harness | Deaths were only retried, never checked: after a restore nothing compared the level with the checkpoint. The retry also turned invulnerability on for the rest of the run. | - | `--deaths <steps> \| ch1`: after those steps the player is killed (logged), and the game restores its own checkpoint. A fingerprint taken in the frame the checkpoint was captured is compared with one taken right after the restore (`tools/playthrough-restore.js`). The fingerprint covers entities, actors, dynamic objects and collision, props, insanity, weapons and the player controller. The route then replays the steps after that checkpoint without invulnerability. `ch1` dies after `1a.flashlight`, `1a.gas`, `1b.ledges`, `1b.crate`, `1c.yard` and `1c.east`. Final runs, each level on its own: 1a was 45 / 46, with one flag, Breakable 7b16 (open observation). 1b from `1b.cp2` was 14 / 14 with no other death. In 1c both restore checks were clean; the run was 18 / 21, the misses being `1c.lead`'s 300 s wait, a floating CartWheeler and one death in a fight. Every step replayed after a restore passed except `1c.lead`. | added |
| 19 | harness | Runs left a `chrome_crashpad_handler` behind each time. | Brave's crash reporter outlives the browser. | The harness kills the crash reporters it started. | fixed |
| 51 | 1c ladder (AI) | A walkway CartWheeler walked to Ladder 7c2f, climbed it and hit the player on top. | `actor.ts tryLadder` let any character take a ladder edge; the CartWheeler templates have no LadderClimbBehavior (p102 null). | Decoded (docs/game-logic.md §15.5 "Who may use a passage edge"): Edge Passage p0 = 0 is a Ladder passage; the A* filter drops a ladder edge for a character without a LadderClimbBehavior (passage mask bit 1, 0x100dc070), also a locked Ladder and the closed direction of Ladder p34. Such a character gets no path over the ladder at all (`nav.ts ladderEdgeOpen` in `system.ts navBlocked`). | fixed [verified], tests |
| 52 | 1c east yard (AI) | The last CartWheelers 7e20 / 7e21 stayed behind the fence by the gate mound, one of them in `act` 2.25 m above the ground (the "floating CartWheeler" of the restore runs: a crawler on the fence), out of the player's reach and he out of theirs, so Count Down 7e2a never reached 0: `1c.lead` waited 300 s for the inmate's last walk and 7813 came a step later, when the player crossed Detector 80d9 on the way to the ladder (Relay 80d5 -> Behavior Changer 80cf, the level's other way to send the inmate). | Each walks a WaypointBehavior to Waypoint 7e22 / 7e26 behind the fence, then a JumpBehavior whose launch clip (10:1310) carries it 4.9 m forward. The port arrived facing its walking direction; the waypoints' p4 / p5 were not applied (p5 read as an arrival radius). | Decoded (docs/game-logic.md §15 WaypointBehavior row): with Waypoint p4 != 0 the walker blends to the Waypoint's placement over p5 s (Slerp) before p0 / p6 / the next waypoint or the end of the behaviour (`actor.ts waypointTurn / waypointSlerp`). Browser: both turn to the waypoints' facing, leap over the fence into the yard (z 402.8 / 402.4) and fight the player. The inmate's jump off the ladder landing (Waypoint 7b8d, p4 = 1) turns the same way. | fixed [verified], tests, verified in the browser |
| 53 | 1b arena (harness) | The arena did not finish in 600 s (two runs, relay 7ed2 forced): one copy (the last one of 7eb1, or the first after a restore) attacked an invulnerable player for the rest of the step and was never hit. | `__pt.engage` sets aside a creature that takes no damage for 8 s for 30 s; when the 30 s were up the old start time had run out too, so it was set aside again at once, for good. With the player invulnerable nothing else ended it. The level logic was fine: Count Down 7f6e (live copies, held up while a cloner runs), the dialogue chain 7ebb -> 7ec1 -> 7ebf -> 7ece, Detector 7ed4 / filters 7ed5 / 8ba4, Count Downs 80a5 / 8c03 and Timers 8b9a / 8c2c. | A creature set aside gets a fresh 8 s try when its 30 s are over (`tools/playthrough-page.js`). Browser (`--level 1b`, invulnerable, the same copy): it was killed at once, the Killjoy wave followed, the transformation and change back, scene 80a6 by the level logic, no relay forced. | fixed (harness) |
| 54 | 1a Dumbell (restore) | At checkpoint 8393 Breakable 7b16 (the "Dumbell") is in Goose's hand at the off-map staging area (258.2, 98.4, 319.0); a restore drew it at its one key from "Goose" (150.12 s, the cell floor). | The STOMP attach link (Goose hp 19 from 40.15 s, never cleared) lived only in the attach service; the save kept the object's last key. | Decoded (docs/game-logic.md §7 attach keys): a key on an attached object is overwritten by the bone the same frame, and the end of a sequence (finished or skipped) detaches nothing, so live play and a skipped opening are right. The links still in place are saved (provider `sequence.attach`, `sequence/system.ts`) and hung again on a restore. `--deaths 1a.flashlight`: the restore check is clean. | fixed [verified], test |
| 55 | actors (mover) | Creatures floated on ledge rims (1c's fence CartWheeler, 3a 1b5d / 1b5e, 4a) and the 6a Slayer 2337 could not pass under a leaning log. | NPC motors had a guessed capsule (bind-pose height, radius from the mesh x scale) and a sphere ground probe. | The character mover decoded and implemented (docs/game-logic.md §14.9, `actors/mover.ts`, physics.ts `groundProbe: 'centre'`): Collider spheres (Character p42), ground only under the feet point, p48 step down, p46 slope. The spheres scale with the character [inferred]: unscaled, 1b's Slayer 7ffc (scale 0.72, a 3.15 m stack) under a 2.72 m ceiling was pressed 0.43 m into the floor (the probe's "sinking 7ffc -0.39 / -0.43" in two chapter 1 runs; the same -0.430 in a test room). The floating / sinking probe measures NPC ground the way the mover does (rays at the feet point, not a 15 cm sphere that also touches a step's rim beside the feet) and leaves out a crawler in a ceiling / wall transit or a leap (4a's wall CartWheeler 82d5 read "floating +3.96 / +5.99" at `4a.wake`). | fixed [verified rules; scale inferred], tests |
| 56 | 1a escort (route) | `1a.guard-comes` waited 150 s for nothing (also with the committed code, an A/B run): the guard 609e stood at the west end beckoning. | Whether he comes depends on his chain when the player goes ahead: SimpleConversation 7522 walks him to the listener, but once WaypointBehavior 7524 runs, a player beyond 20 m is only beckoned (the decoded escort rule). | The step goes back to the guard and keeps by him until he opens the gate (`follow`), as a player answering the beckon does. | fixed (route) |
| 57 | 1a metal detector (user report) | Walking through the lobby's metal detector gates (Detectors 8956 / 8957 -> Relay 813e -> Sound Effect 8147, 3:297) no longer sounded the alarm. | The logic ran (8147 asked to play, its light on), but the mixer dropped the voice: 48 of 48 voices were the looping hum 4:297 at (404.7, 92.7, 489.3), the lobby sparks generator 81f2 spawning its Sound Effect 4:1159 (play mode 1) every 0.1 s since the decoded generator rule (13b4507), and a new sound of priority 85 finds none of strictly lower priority to steal. | Object Generator p23 decoded (docs/game-logic.md §14.2): no spawn while p23 objects it made still exist; 81f2 (p23 3) keeps one hum (`world/fx.ts`). A spawned Sound Effect plays at creation only with p1 and loops in play mode 1. | fixed [verified], tests; step `1a.metal-detector` (`expect.heard`: a voice of 3:297 started during the step) |
| 58 | 1a "Gaurd" #218 (user report, not reproduced) | "The second guard after the earthquake is already dead; the scene where he gets bashed doesn't play." | Not reproduced. Walked like a player from a capture before the hall (stroll), and back from the walkway after #114 in three ways (straight back through the junction, waiting east of Detector 7ac1 until #114 ended, back at once): #218 started each time as a cinematic with guard 609f alive (health 50, DormantBehavior 10:147 at the off-map staging area until then), on screen 24.6 s of 28.3, killed in the scene. The full opening watched (216 s) leaves him and CartWheeler 6208 dormant and unhurt. The other candidate, the crawling guard 7fdf of "Cartwheeler" #253, is placed dead by the data (p68 none, p69 DeathBehavior 10:933, pose 10:1663) in the room north of the west corridor, out of sight; #253 keys him alive, crawling, and his tripwire Detector 642a spans the corridor. | Check added: `expect.aliveAtStart` (the characters a sequence finds alive when it starts, recorded by wrapping the world's sequence observer); `1a.gaurd` fails if 609f is dead when #218 starts. | open (needs the reporter's path or a save) |
| 59 | 1a gas chamber (collision) | Playtest: the window glass did not stop the player before CartWheeler 64f6 broke in. | The glass Real_Glass 6342 (Static Object, model 9:2089) is drawn with additive faces (blend 2), which the drawn-triangle collision treated as light-only. | Objects collide as their collision trees (docs/game-logic.md §14.10): 6342 is one 0.09 x 3.9 x 11.3 m box and stops movers. "CartWheeler" #210 sends it away at 2.26 s, and its body goes with it. The shards it leaves (Breakable 702f, 9:2551) are a sphere tree without nodes: rays hit their faces, movers pass. Checked in the browser: the player is stopped on both sides of the pane before the scene and walks through after it. | fixed [verified], test |
| 60 | 1a escort (route; deployed build) | `1a.guard-dies` could not be played: after the gate ambush the guard 609e stood in his HostilityBehavior by the gate for good (A/B: a `--level 1a` run of the committed tree). Earlier reports of him "looping in his conversation" (SimpleConversation 7520 act / idle every 5..8 s) were runs whose `1a.flashlight` step failed. | (1) The ambush's Count Down 73a5 needs both CartWheelers; the second, 64f1, walks WaypointBehavior 8027 to Waypoint 8025 inside door 4e48. That goal's nearest Move Node is on its side, so its path crosses no door edge and nothing opened the door: the body (Collider radius 0.4, ffaf3d3) stopped 0.51 m short of 8025 (reach 0.45), and the stuck-leg rule (e170605) ended the WaypointBehavior; it idled behind the shut door, nobody saw it, 73a5 stayed at 1 and Timer 7532 -> Behavior Changer 7527 (the guard's talk 7528, then his walk to Waypoint 752d) never came. (2) 7520 is a chatter with repeating lines: it ends only through Detector 7523 at the west end, which taking the flashlight 6978 enables (Relay 8aba), the level's own rule. | A passive walk stuck against a closed door on the Move Node edge its goal lies on opens it (`actor.ts doorInTheWay / goalOnEdge`; the decoded escort rules, the once-per-MoveTo leg test and the stuck-leg rule are unchanged). The route's escort steps (`1a.escort` .. `1a.guard-dies`) print a `why:` when they fail (`ESCORT_1A_DIAG`: the guard's behaviour, the flashlight / Detector 7523, Count Down 73a5 with both CartWheelers and door 4e48). | fixed, tests (`tests/electrocution.test.ts`), verified on the real route (`CartWheeler #64f1 opens door #4e48`, 73a5 at zero, 7528, the walk to 752d) |
| 61 | 1a electrocution (user report) | The guard fell at once at the electrified door; in the original he stays up amid the bolts while Horace's line plays, then falls. | Decoded the scene: his arrival at Waypoint 752d fires Relay 8a1b -> Timer 81d5 (0.1 s) -> Damage Action Objects 75dd (0) and 8185 (200 at once) and Relay 75de -> Timer 5bd2 (0.1 s) -> the bolts (7619) and Relay 7a77 -> Timer 8a1c (0.25 s) -> Speech Player 8b33, Horace's random line 0.35 s after the arrival; the guard has no line there. The death is at 0.1 s in the original too; what differs is the clip. The Character death picker (0x100e5d00) chooses among the p72 DeathBehaviors by the angle between the body's back axis and the attacker's direction (DeathBehavior p4 the bound); a Damage Action Object's damage record has no attacker (0x1008e9e7): 90 degrees, so the guard takes his second entry 10:22 (clip 10:156: upright ~0.5 s, kneeling 1.5..5 s, down at 5.7 s). The port always took the first (10:250: 10:301 down by 0.5 s, or 10:1470). | `actor.ts deathAngle / deathPick / deathFor` with the killing blow's attacker (`profile.deaths`, DeathBehavior `angle`); docs/game-logic.md §11.5 item 3, §17.3. | fixed, tests, verified on the real route (10:156 played; Horace's line 0.35 s after the arrival; a frame strip from the reference framing: upright amid the bolts with the line on screen to 1 s, on his knees 1.5..5 s, down at 5.5 s; `1a.guard-dies` and `1a.guard-gun` pass) |
| 62 | 5a / 5b (deployed build 1c6b915) | Chapter 5 threw `material.customProgramCacheKey is not a function` from the renderer every frame (5a); 5b drew nothing. | The scene glow kept each surface's mark material in `material.userData.glowMark`. `Material.clone` / `copy` deep-copies userData through JSON, so a clone carried the mark as `Material.toJSON` output, a plain object, and the glow pass swapped that object in as the mesh's material. The clones were the sky objects (lights.ts) and security monitors (monitor-view.ts) of chapter 5, whose materials are flagged. | The mark is a non-enumerable userData property (`app/glow-mark.ts`): JSON skips it, so a plain clone has no mark. Only a real material counts as a mark. `cloneWithGlowMark` keeps it for the sky, the monitors and Killjoy's projector targets. Smoke now loads 5a, 3a and 5a in Enhanced mode. `tools/levelqa.ts --query` runs the QA in Enhanced mode. | fixed, test (`tests/scene-glow.test.ts`), smoke, levelqa: all 18 levels load with 0 errors in both modes |

## Open observations

- **Melee from below**: decoded and fixed (docs/game-logic.md §15.5, `actors/npc-melee.ts`). The
  start test stays horizontal (p17 -1), but a blow lands only where an armed blade (Melee Weapon
  on its p51 bone, armed by the clip's Arm / Disarm events) sweeps through the victim's hit
  spheres. Browser (1c, ladder landing 7c2f at y 84.7 over the yard floor at 79.1): a CartWheeler
  spawned below swung at the player for 32 s and dealt 0; on the open yard floor its blades
  landed 17.5 and 2 x 9.1 per swing (p68 7 x Attack p6 2.5 / 1.3; both arms), the 1a west
  corridor CartWheeler 17.5 and 8.2. Seen on the way: a CartWheeler climbed Ladder 7c2f to the player on top; fixed (row 51).
- **1c inmate**: the yard creatures hunt him by the decoded KillEnemies score (docs/game-logic.md
  §15.15): in the browser CartWheeler 6520 and Slayer 7def took the inmate (nearer), the wall
  CartWheelers 6517 / 6516 took the player, and the Slayer switched to the player once he shot it
  (damage memory). He stays alive by fleeing (bug 37). After his ladder Waypoint 7b8d (p4 = 1)
  now turns him to its placement first (row 52), and his JumpBehavior 80d0 carries him 7 m off
  the landing onto the ground behind the fence (530.4, 405.5 -> 530.1, 412.5); before, he
  barely left the landing (0.6 m) and stood 2.7 m above the ground. Deaths to the yards'
  CartWheelers and Slayers: fixed (companion survival, rows C-2 / C-3: he went after gunshots
  while fleeing and walked back to a far player into the fight).
- **Use target**: fixed (bug 40). The port keeps a prompt and E for items; the original takes
  items on contact and has no prompt [inferred]. Usables other than Switches keep the port's
  view-ray test (their fit tests are not applied).
- **Dropped revolver placement**: it is placed 0.5 m ahead of the guard's feet at his death; his
  death clip then lays his chest over it (drawn and offered all the same). The original drops
  the Item from the hand and lets it fall (0x10096c20, the fall not decoded).
- **1a electric chair room**: the camera sequence 80d2 / the chair (Timer 8398, Horace 7a47)
  and the door 5127 belong to the revisit set-up (Relay 79e0, started by nothing in a first
  visit); the first visit leaves 1a through the basement door 79b2 without entering the room.
  Played on the chapter 7 return (`r1a.*`, "7 Return to Prison" below).
- **Flashlight**: the battery runs out after 105 s of use and nothing recharges it (as decoded);
  a run that skips the battery pickups plays on with the lamp dead.
- **Ambience**: Ambient Sound beds are rare in chapter 1 by design: of 1a's 23 zones only 7841
  (B side) and 78a8 (A side) carry a bed (1b: 4 of 5, 1c: 2 of 4); the others set the reverb and
  send messages (zone 802d turns the combat music off, seven zones switch the storm / prison
  Flying Sound 78a6 on and off). Free-standing loops: 1a's Sound Effects 838f (6 m) and 86be
  (20 m). So 0 bed loops at most 1a steps is the data, not a bug; the harness now counts zone
  beds, looping emitters in earshot and Flying Sounds switched on.

## Results (last full run: Medium, headless Brave / WebGPU, 1280×720)

With the character mover (rows 55, 56), run c8 of 2026-10-15: `--to 1c.exit` from the main menu
to **2 Cellblocks** in 1624 s, 65 of 66 records clean. One death in the 1a gas chamber fight
(CartWheeler 64f3), retried with invulnerability. No floating, sinking or stuck actor. Earlier
runs of the day missed `1a.guard-comes` (row 56), `1b.ledges` (the clamber retries now fight
first: an arena copy at the second ledge), `1a.statue-booth` once (the statue moved 0 m), and
`1c.lead` twice (the inmate killed at his flee spot, as in runs before the mover). Run c9, after
the stuck-leg rule (chapter 6 open items): 65 of 67, to 2 Cellblocks; the misses a death in the 1b
arena and `1c.lead` (the inmate fleeing the yard's creatures for 300 s, FleeBehavior 7e3e).


Four full runs this session (New Game from the main menu, screenshots on). The table and figures
are from the last one (run 4, with every harness fix above; the one change since only counts a
step that ends in a death as failed, as the count below does). Runs 1-3 are kept for the
failures they found.

New Game to the arrival in **2 Cellblocks** in 29 min (1727 s); 63 of 66 step records clean
(the 1a gas trap death and the two 1c steps the dead inmate cuts off); one death (the 1a gas
chamber's gas), retried from checkpoint 8397 with invulnerability.

| Level | Route on foot | Shortcuts (logged) |
|---|---|---|
| 1a | the whole level: opening, guard scenes, shiv, the guard post hall walked like a player (both "Gaurd" scenes seen on screen), Gaurd scene, lever, wall, CartWheeler fight, Xombium bottle, flashlight, the guard's escort and his gate, the ambush, the electrocution and **his revolver taken with E** (drawn lit, on screen, frame `1a.guard-gun-seen`), crates, lobby statues, the booth CartWheeler, the sally port puzzle, the gas chamber and its window, the basement door | invulnerability after the gas death |
| 1b | the whole level: arrival, Horace / Hermes scene, the arena to its end **by the level logic** (225 s: waves, transformation, change back, scene 80a6; no relay forced), the arena door checkpoint, both clambers, the locked door, the vision, the crate, the ladder, the exit door (1c on the first use) | the transformation and change back through `__insanity` (Q needs pointer lock) |
| 1c | guard room, the map, smashing the monitor, the inmate's door, both checkpoints, the yard and its first group, the ladder, the drop behind the fence, the mound, the exit door | Level Transition 7813 fired (the inmate died, so nothing enables it) |

Checkpoints taken: 1a level start, 8393, 8395, 8397; 1b arrival, 8337, 8339, 833b; 1c arrival,
8000, 7ffe; 2 arrival. Cinematics seen: Goose (skipped as a player would), Gaurd 13.0 s, Gaurd
28.3 s, Cartwheeler 14.5 s, CartWheeler 5.5 s (booth), Camera 4.4 s (1a gas chamber, again after
the retry), Camera 86.6 s (1b Horace), Camera 10.8 s (1b arena end), Camera 44.8 s (1b hall).
Music: 1a's combat cue 84bd at the gate ambush, combat music 78a4 in the 1c yard. No console
errors or exceptions.

**Save / load**: mid-1a (after checkpoint 8393), start of 1b (after the Horace scene) and mid-1c
(after checkpoint 8000) restored doors, items, STOMP Players, Detectors, actors, health,
reputation / insanity, weapons and inventory exactly in run 4 (the flashlight as charge + spare
batteries within 0.06, row 33). Runs 1-3 had only the harness's own battery false positives.

**Performance** (fps / draw calls sampled after every step, run 4, nothing else on the GPU):

| Level | fps min / avg | draw calls avg / max | triangles max |
|---|---|---|---|
| 1a | 60 / 60 | 267 / 703 (the gas chamber) | 208 k |
| 1b | 60 / 60 | 158 / 271 | 174 k |
| 1c | 60 / 60 | 123 / 267 | 110 k |
| 2 (arrival) | 60 | 432 | 237 k |

Run 1 shared the GPU with two other agents' headless browsers: 22-30 fps in 1a and 1b then; the
route's timings there are not comparable.

**Screenshots** (`--shots`, about 35 per run, kept out of the repository): the key frames were
looked at by hand: the revolver by the electrocuted guard (before the fix black but for the
flashlight and the arcs, after it lit like the room, with the arcs still on the body and the
prompt "E - Pick up Revolver" from 1.3 m), the gas chamber window scene, the smashed 1c monitor,
the arena, the 2 Cellblocks arrival. Nothing out of place beyond the failures below.

Failures left, by the area that owns them:

- **Gas chamber**: fixed (rows 42-44). Re-run to `1a.window` on HEAD plus those changes alone
  (the parallel 1c / use-target work left out): Medium twice, 39 / 39 steps clean, no death
  (health 58 and 36.75 after the CartWheeler fight); Hard twice, each with one death to a
  CartWheeler's blades, not the gas (run h1 to 64f3 / 64f4 in the corridor before the chamber;
  run h3 to 64f6 in the trap, entering it at 24 health with no Xombium bottle; 11.3 per hit).
  Probes (`--keep --ctl`, the chamber steps from the door): Medium and Hard each took no gas at
  all under the window (health 100 -> 85, 75 -> 70, one blade hit each); the CartWheeler took
  15 from tile 688b while it landed on it and was killed by the player; the inmate took 85 from
  the tank gas (type 0) before his DeathBehavior. Standing by the entrance door instead still
  kills the player (dead 10.2 s after the tank opens on Medium), as the decoded gas does.
- **Actor AI (the 1c inmate)**: fixed (rows 37-39, 41). Before, the inmate 7569 died in every
  run (runs 1 and 2 in the first yard group, run 4 in the second) and Level Transition 7813
  needed the logged shortcut. Re-run with those changes: a full run from the main menu (2162 s, 58
  of 67 step records clean; the one death was the 1b arena fight, retried from its checkpoint
  with invulnerability kept on, so 1c ran with it) and three `--level 1c --invulnerable` runs. The
  inmate lived through all of them (lowest 41 health): he fled between the first yard's Flee
  Positions, stayed out of the east yard until the first group was dead, climbed Ladder 7c2f and
  reached Waypoint 7b8c, which enabled 7813 (trace `7b8c>808c`, `7b8c>7813`). The exit door then
  took the run to 2 Cellblocks with no shortcut. Not clean in that full run:
  - `1c.lead` waits up to 300 s for 7813, and the last CartWheeler (7e20) kept the player busy
    past that; 7813 came during `1c.ladder`.
  - After the arena death the second 1b clamber did not start, and the 1b steps after it failed
    one after another (1b.exit teleported). Investigated (rows 45-49):
    - Reproduced in a restored 1b: Horace checkpoint, arena, arena door, ledges. The clamber
      itself works under attack (6 of 6 `tryClamber` calls from the ledge with CartWheelers
      hitting the player).
    - What stopped the step was the ledge ambush. Detectors 6727 / 76d6 on the way from the
      arena door wake CartWheelers 6725 / 6726, which attack at the foot of the ledges. Without
      invulnerability the player was beaten off the ledge and killed twice. With them dead, both
      clambers went at once. The same ambush happens without a restore. The step does not fight
      before climbing.
    - A death during a locked body clip froze the restored player (row 45). The arena's
      transformation put-away is such a clip, and so are the Nooseman's and Mainliner's holds.
      That is the likeliest cause of the chain of failures in that run [inferred: that run's
      death was not traced].
    - The `clamber` step now fights what hunts the player at the foot of the ledge before
      climbing.
- **CartWheeler AI**: run 1's death was a plain fight (64f4 in the gas chamber, 56 health); on
  Hard the corridor CartWheelers 64f3 / 64f4 and the window one leave the player at 24-54 health
  or kill him (above). The window CartWheeler's sinking is fixed (row 43).
- **World (use targeting)**: fixed (row 40). In the full run above the flashlight was offered
  and taken at the first look (`1a.flashlight`, no "view targets" note). A probe then stood the
  player at 55 spots 1 to 2.5 m from it, with door 561b held open, looking at it each time: the
  flashlight was offered from 53 spots, nothing from 2 (both 2.5 m away), the door from none.
- **Harness, not reproduced**: run 1 stalled 10 m short of the west corridor's CartWheeler scene
  at (416.3, 543.6) (no door there; the next step recovered, it played on the way); run 2 pulled
  the 1b crate 7fde 8.0 m, short of its mark (z < 411.5) but out of the door's Detector (the
  ladder step went on). Both ran clean in the other runs.
- Fixed this session: the dropped revolver drawn black (row 30), and the harness's slow failed
  plans, checkpoint timing, battery comparison, exit bounce, NPC defence and death-in-wait (rows
  31-36).

## 0 Prelude (route `0.*`)

**How it is reached** [verified]: the Prelude is a bonus level, New Game's level once the game was
finished. Main Menu p17 holds 1a's path, p18 the Prelude's (5:316); New Game uses p18 while
engine flag 0x400 is set, and GUI Game Finished sets the flag in its constructor (its notice 5:325
mentions the archive pages and the Prelude). The port had this wired already: Game Finished
calls `profile.setGameFinished()` (`src/app/menu/profile.ts`, kept in localStorage and in saves)
and `flow.ts resolveNewGameLevel` picks the Prelude while `profile.preludeUnlocked`. No debug path
is needed. Its one transition, Level Transition 1172 ("West Spawn", chapter 5:585), leads into
1a's Player Spawn Point 894e, 0.3 m from 1a's Player object, so the Prelude ends where a plain
New Game starts and 1a's opening plays the same way.

`node tools/playthrough.mjs --level 0 --to 0.1a --shots <dir>` boots through the menus with the
profile's prelude unlock set (logged: as after Game Finished), New Game, Medium; `--direct`
deep-links the level instead. The route [verified, read from the level's message graph]:

- **The boat.** Timer 11c3 starts "Camera" 10e9 (41.7 s, the camera on the PoliceBoat's hardpoints,
  docs/levels.md §4.1) and forbids the insanity (Allow Player Insanity Object 1143 p5). Its end
  (Relay 1114) starts the dock scene: Torque locked in the holding pen (x 451..460, z 218..232;
  gates 1185 / 1186 locked) with five inmates, ddd / de0 / de3 (an instance team 10:301) and dcb /
  dda (prisoners), the guards 10e4..10e7 outside the west fence. Archive page "The Island"
  (Archives Trigger 11fa), the move and first-person hints (Help Popups 11f7 / 12c9).
- **"Hat!!"** (`0.hat`). Timers 12d9 / 12dc open Detector 12da (a 1 m box at the pen's
  south-east corner) for 4 s while a gull comes over (Ambient Creature 12d3): a player standing
  there sees "Hat!!" 12ea knock an inmate's hat off (Attachment 12e8), and the talk goes on at once
  (Sound 12db -> Relay 12e6) instead of after Timer 10ea. The route takes it.
- **The beating** (`0.talk`, `0.beating`). The inmates' talk (Timers 129e..12ad) ends in Behavior
  Changers 112f / 1131 / 1133: de3, de0, ddd draw their weapons (SpawnWeapons 153 in clip 2:219,
  Melee Weapon 4:766, 8 a blow) and go for Torque (KillEnemies dd8 / de2 / 12a9, the player's
  team among their enemies); dcb / dda flee to the pen's corners (FleeBehaviors ddf / de5, Flee
  Positions 11b8..11bb); Relay 1235 fills the meter (Toggle Player Insanity 1141 p3) and starts
  Timer 119b (17 s). On Medium nothing else transforms him (the Health Threshold Triggers, one per
  difficulty, below): Timer 119b -> Relay 1173 -> Screen Fader 1174 -> Timer 12c2 -> Toggle 1141
  On, "Shoe Left" 12c4 and "Hat!!" 12e9, the attack hints (Help Popups 11fb / 11fc). A Torque who
  stands still dies just before it (13 blows in 15 s with the KillMelee wait, row 0-1), so the
  route keeps away from them round the pen (new step kind `evade`): 100 -> 20..76 health.
- **The fight** (`0.fight`). As the creature, the three attackers die (Count Down de6). Killing
  dcb / dda would be a kill by the player (their p169 QuestStart 350: Reputation Points Sender
  11e1 -10 each, Relays 11e3 / 11e4 destroyed); the route spares them (`spare`, new arena option):
  +10 each when the vision comes. Count Down 1138 (Timer 1137 5 s after de6, or both fleeing
  inmates dead) enables Detector df6 (the pen, Relay df8) and starts Timer 12eb (20 s).
- **The vision** (`0.vision`, `0.vision-end`). In df6 (it sends On every tick while he is inside)
  the Visiblity Message Filter in view (60 % x 30 % of the screen) picks the vision: east df7,
  south 1007, north 100f (Relays 115e / 1162 / 1160 show their Animating Statics, a giant creature
  climbing the dock and Torque's family; Timer 12eb picks the east one after 20 s). Relay df9 runs
  it (Screen Fader e00, Time Scale e01, Screen Blur 1157, Camera Shake e02, Adrenaline Sender 1159),
  changes him back (Toggle 1141 Off, "Shoe Left" 12c5) and pays the spared inmates (+10 +10).
- **Out** (`0.exit`, `0.1a`). The vision's sounds end (Timer e05: statics destroyed, Screen Fader
  e08), Relay 127c starts the guards' last lines (Behavior Changers 114f..1155: voice
  lines) and Timer 12f0 (17 s) -> Screen Fader 1171 -> Timer 12ef (3 s) -> Level
  Transition 1172 (Behavior Changer 1155 also fires it when its talk ends). 1a loads with chapter
  1's loading screen, the player at 894e (398.8, 97.7, 516.7) with the Prelude's health and
  reputation (+20), "Goose" 7509 plays (watched, skipped as in `1a.intro`), the cell door gives way.

The crane (Crane 11d, a skinned jib on a static tower, `levels/crane.ts`, docs/levels.md §4.6) and
its controls (Mountable 875, p30 = 0x11d) stand on the lower dock outside the locked pen: no play
reaches them. Checked in the session by teleport (logged): mounted with E, the look input slews the
jib (-0.126 rad) and works the hoist (cable 1 -> 5.05 m and back up to the 1 m minimum; p29 12.95 m
is its maximum, nothing hung: p36 empty). The 4 Teleport Pads and the Switches / Mechanisms /
Clamber Points on the lower dock are 10 Docks' layout left in the copy [data].

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 0-1 | actors (melee) | The three inmates beat Torque to death in 7 s, long before the scripted transformation (Timer 119b, 17 s). | The generic KillMelee's wait between attacks was not run: only CartWheelers had one (their p182). | Decoded (0x1007cf10 child finished, 0x1007ce60 update, 0x1007ce00 / 0x1007c870 attack): after each MeleeAttack the KillMelee waits p2 + U(0, p3 - p2) and only then attacks again. Its template is the Character's slot for behaviour type 0x4d, p85 (the slot table 0x100e17c0, docs/game-logic.md "Melee"): Unspeakable NPCs 10:578, 0.5..1.5 s (`manager.ts profile` `meleePause`). | fixed [verified], tests |
| 0-2 | actors (melee) | The attackers swung idle clips for a guessed 10 a blow with no weapon. | Their MeleeAttackBehavior is an instance override (p87 = 10:297 on template 10:392, which has none); creature kinds were built from the template only. Retail: these three and one inmate in 2 Cellblocks. | A placement with its own p87 gets a kind of its own (`kinds.ts creature(template, melee)`, `clipmap.ts resolveCreatureClips` overrides): clips 10:1727 / 10:351 arm Melee Weapon 4:766 (8 a blow). | fixed [verified], tests |
| 0-3 | levels (Health Threshold Trigger) | The port armed every threshold below the starting health on the first frame (Hard: 70 under 75 fired on the first blow). | The polled starting health counted as a health event. | Previous health 0 (constructor 0x10015150) and only health changes are events: Easy 170 fires, Impossible 40 fires, Medium 120 and Hard 70 never (Timer 119b instead) (`levels/logic.ts`, docs/levels.md §4.4). | fixed [verified], test |
| 0-4 | harness | `changeBack` pressed Insanity during the scripted creature form (the key is forbidden, flag 0x80) and waited 8 s at the start of every step. | | It does nothing while transforming is forbidden. | fixed (harness) |
| 0-5 | harness | Boots timed out on a loaded machine (front end, gate, dev server, browser, New Game level). | Fixed 20..180 s waits. | 90..420 s; a run that dies before its report prints the page's last errors. | fixed (harness) |

New harness pieces: `--level 0` (menu boot with the prelude unlock), step kind `evade`, the arena's
`spare` list (`window.__ptSpare`, read by `__pt.engage`), `noCineWait` (a step that ends in the next
level's opening leaves it to the next step).

### Results (Medium, headless Brave / WebGPU, 1280x720)

- **r1** (before 0-1 / 0-2): the beating killed the harness standing still; the vision step's
  condition matched the Prefetch to Screen Fader e00 that Count Down de6 sends, so the creature
  form ran on until the meter's health drain killed him (Player p257 at an empty meter); retried
  invulnerable, through to 1a.
- **r3 / r4 / r6** (2026-10-19, all fixes): every step played, no death, 0 Prelude to 1a's
  opening in 252..344 s. r6: the hat, the beating (9 legs round the pen, health down to 76), the
  fight (3 swings as the creature), the east vision (frames `0.vision-end-f01..05`: the giant
  creature, Torque's family, gone), the guards' lines, the fade, 1a's loading screen
  (`0.exit-f*`), 1a at West Spawn with health 76 and reputation 20, "Goose" skipped, "BustedDoor"
  5b9e. 7 / 9 steps clean; the two flagged are below.

### Open (by owning area)

- **Actors (mover): the guard 10e5's pacing leg.** WaypointBehavior 11b3 walks him round
  Waypoints 11ac / 11a9 / 11ad outside the pen's west fence. From (448.4, 225.7) the straight leg
  to 11ac (450.0, 231.0) passes 0.5 m from a post at (449.3, 230.3); his capsule (r 0.43) stops
  on it, the leg fails after the port's stuck rule and the next Behavior Changer moves him on
  ("stuck actors: 10e5 move 16..18 s" in `0.hat`). Whether the original slides round it is not
  decoded (docs/playthrough.md 9 Lighthouse, the foliage of 884, is the same question).
- **Dismemberment (in progress elsewhere):** blows on the player raise `TypeError: Cannot read
  properties of undefined (reading 'skinned')` in `actors/system.ts partSpheres` (called with the
  player from `Dismemberment.hit` via `playerBlow`); the damage still lands. Seen in `0.talk` /
  `0.beating`.
- **Insanity:** the placed Player overrides p82 / p83 (meter drain) with 0, but while transformed
  the engine reads the creature template 2:240 (docs/game-logic.md §13.1), so the meter drains at
  2.25..4.25 a second and the low-meter hint (a Help Popup with an <Insanity> control placeholder) shows
  although the key is forbidden. Matches the decoded rule; not checked against the original.
- **Spawn point p6** (a Map Item: 1a's 894e names 4:668, the level's own map; 79b5 / 83a0 name
  4:673, the first floor) looks like the map shown on arrival [inferred from data]; the port
  shows Level Properties p45 only (the same map for this hand-off).

## 2 Cellblocks (route `2.*`)

`node tools/playthrough.mjs --level 2 --to 2.exit --shots <dir> --cine-strip 3` starts in 1c and
fires its exit 7813 at once (logged): the player arrives at "East Spawn" with the 1c inmate carried
over as Dallas (868, placed at Companion Spawn Point 1bf0, whose Timer 933 starts his first talk),
with the `chapter 2` kit (the 1a revolver and 12 rounds, the shiv, the flashlight and a battery, a
Xombium bottle; logged). The steps were derived from the level's message graph
(`tools/entities.ts --graph`), its 25 Behavior Changers on Dallas, its Detectors, Count Downs,
Object Cloners, STOMP Players and its exit, and checked in the browser:

| Step | What happens (level logic) |
|---|---|
| `2.arrive` | Dallas talks (20:2) and follows (WaypointBehavior 86c -> FollowBehavior 902) |
| `2.junk`, `2.bed` | the barricade: five junk Breakables count Count Down 18f6 down, which unlocks the bed 18f1 (Enable = p28); pushed out of Detector 32ae it opens the nav edge 18fc - 18fb (EdgeToggler 3087); pushed on to the far wall it leaves Dallas's way (Move Nodes 18f9 -> 7e8) |
| `2.north` | Dallas walks into Detector 904: Instance Message Filter 905 -> his talk 20:4 |
| `2.mainliner`, `2.mainliner-watch` | through doors 818 / 843: Detector 848 plays "Mainliner" 847 (flag 0x40, no Camera track: in the world, the player keeps his view and control and watches it from the walkway); Dallas's 20:5 through filter 932 |
| `2.hall` | down into the cell block: Count Down 3383 needs the player in Detector 3382 and Dallas at Waypoint 86a (after filter 90d -> Behavior Changer 90e); "Camera" 1a61, then Mainliner 867 leaps (MainlinerJumpAttackBehavior 870); checkpoint 1c74 |
| `2.clones` | Object Cloner 91b's Mainliners until its p17 (Relay 91d -> Timer 12a7 -> Dallas's 20:12) |
| `2.switch` | switch 809 opens the scripted doors 84c / 3158 / e3 and Dallas's 20:119 |
| `2.yard` | through door 85c into the steam-pipe yard (five vents x four Mainliners, Object Cloners 2e95.., Count Downs of 4), on to the east wing: checkpoint 334c |
| `2.dallas` | Dallas comes round (his type 10:674 is barred from the yard door, Move Node 9bd) |
| `2.middle`, `2.talk`, `2.inmates` | Detectors f9c / 1067 drop CartWheelers f80 / f81 by three inmates; Dallas in Detector 2f90 (filter f9e) talks with them (Behavior Changers f89 ...), then they turn on him and the player (KillEnemies f98 p3 [868, player]) |
| `2.catch`, `2.ladder` | the hidden catch 18ce at the foot of the raised ladder: broken, Relay 1a0d drops Mechanism 18cc 4.2 m and Object Grouper 18cd takes Ladder 18cb down with it |
| `2.horace` | Detector 257a: Horace talks in his cage; Behavior Changer 2572's p17 (2) switches the power aee off |
| `2.upper` | south through door aed: checkpoint 1c75 |
| `2.witness`, `2.camera` | "Witness" fd0, "Hanging Prisoner 01" 30cc, then Detector fd2 -> "Camera" 2e01 (34 s: Hargrave) |
| `2.revolver`, `2.gunner` | the revolver in the yard (Ammo Box 160e); five hits on the gunner 7f4 at the window of his nest (Count Down 2e11 counts Damaged) -> Relay 2e07: WaypointBehavior 2e0b takes him out through the locked door be4 (Edge Passage 2e0f p4 = 1), the alarm stops, fdc wakes (Behavior Changer 3419) |
| `2.riot` | six inmates (Count Down fe0), among them the gunner 7f4 |
| `2.gate` | the lever 1356 by the nest opens the gate c36 (p64 On / p65 Off); Count Down fe0 sends Dallas to pull it (WaypointBehavior 314c -> Waypoint 314b -> Timer 314e), and the lever is the player's too: skipped when Dallas did it |
| `2.climb` | out of the south-west pit: the step 3024 (2.1 m, template 2:641 p7 1 m), then the wall top 80b (4.1 m up, its anchor where the player stands along the 18 m edge) onto the exit floor (y 100.7) |
| `2.exit` | walked to: the locked door c0c: trying it starts Timer 11ac -> Level Transition 11aa (3a, "NorthEast Spawn") |

Harness additions for it: a struggle reflex all run long (while a creature holds the player, Fire
and Jump about 14 times a second: the Mainliner's ride); `loot: <m>` steps (lockers within reach
opened, items walked to and taken); shots from range when a gun has rounds and a clear line
(`__pt.canShoot`); a companion in the line of fire is stepped round (`break`) and a gun counts only
when he is on its line (`allyInFront`); no transformation with a companion within 12 m (the
creature's blows hit him: 70 of Dallas's damage in one run); `walk` with `run: true` (no stopping
to fight); `expect.actorAlive`; `wait` steps with `force`; `break` in three rounds with `aim`; a
death retries the step that took the restored checkpoint; damage to allies logged
(`__pt.allyDmg`).

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 2-1 | world (logic) | Dallas never talked at Detector 904 (and later filters f9e / fcd / 12ab): his scenes stopped there. | Message filters' p0 was read as "enabled"; it is "destroy once a message passed". Filters have no message map. | Decoded the filter catch-all 0x100cb7a0 and the Instance Message Filter test 0x100b8b10 (sender listed == p2) [verified] (`World.filterPass`, `instanceFilterPasses`, `filterSpent`; the insanity filters too). Also fixes two Visiblity and two Insanity Mode filters in 10 Docks and the 4b Reputation filters. | fixed [verified], tests |
| 2-2 | world (props) | The barricade bed 18f1 could not be grabbed after its junk was smashed. | The usable-object lock (p22, p28 / p29) was not one flag: `enabled` started on and the use test also asked for p22. | The lock is `enabled`, initialised from p22 (Pushable, Phone, Toilet, Mountable, Security Monitor); p23 "usable at all" gates them (docs/re/object-model.md). | fixed, test |
| 2-3 | actors (Mainliner) | Every ride ended in the 30 finisher: struggling did nothing. | The port counted movement / crouch presses; the ride sums Fire, Throw, Jump and Use presses (input actions 0x428..0x42b) [verified]. | `PlayerController.attackOverride` takes Fire / Throw / Use while held (weapons, world Use), `hold.ts` counts them and Jump. About 12 presses a second outlast the ride; the run's reflex is thrown off with 16..68 presses. | fixed [verified], test |
| 2-4 | actors (nav) | Dallas followed the player past the cell block's east door and stood there for good, with no graph path back. | Straight walks ignored NPC Exclusion Types (Move Nodes 9b4 / 9bd / a49 bar his type 10:674). | No straight walk through a barred node's area or to a goal his type cannot reach on the graph (`NavGraph.crossesExcluded`, `actor.ts steer`) [inferred]. | fixed, test |
| 2-5 | world (props) | The raised ladder 18cb never came down: no way onto the east walkway (Horace, door aed, the south). | The catch 18ce is a system-package Breakable (not built), its Mechanism 18cc has no model, the Mechanism's translation group and inputs were not implemented (p59..p66 read as reset / reverse / forward on the rotation group), and Object Groupers did nothing. | Decoded the Mechanism inputs (map 0x10178878) and the mover (translation group p22..p31) [verified]; Object Grouper followers [inferred]; hidden targets built for their body; ladders use placement x pivot. | fixed, tests, verified in the browser |
| 2-6 | sequence / HUD | Two subtitle lines drawn over each other (Dallas's Speech Player during the cell block camera scene). | Three overlays (sequence, speech, HUD) each drew their own line. | One box: a line shown by one overlay clears the others (`sequence/subtitles.ts`). | fixed, verified in the browser |
| 2-7 | harness | Dallas stood at the player's shoulder: no shot at the barricade; ammo-less revolver kept the shiv in hand though 120 rounds were in reserve; a run idled through Mainliner rides. | Ally test was a 3 m cone; the gun choice only fell back; no struggle. | See the harness additions above. | fixed |
| 2-8 | world (clamber) | No way from the south-west pit to the exit floor: `2.exit` teleported to c0c. | The clamber anchor was the side face's centre; the original's (Clamber Point vt +0x94 0x100114f0) follows the player along the edge, clamped to half its length less the point's p31. 80b is an 18 m wall top 4.1 m above the step 3024 but 7 m from its middle. | Decoded anchor (`world/clamber.ts`), the generic facing test towards it [verified]. The route climbs 3024 (2.1 m, p7 1 m) then 80b. | fixed [verified], tests, verified in the browser |
| 2-9 | actors (nav) | The south-yard gunner 7f4, sent out of his nest after five hits (Count Down 2e11 -> WaypointBehavior 2e0b), stayed in it; fdc stayed dormant until then. | Two port rules: locked doors only for characters "not against the player" [inferred]; skinned Mountables collided with their bind-pose triangles, and the gunner stands inside his gun's. | A Switch's passage kind (0x10130e50): a locked door whose Edge Passage has p4 = 1 is passed as unlocked (0x100a8d50) [verified] (`nav.ts lockPassDoors`; also 1c's 5262). Skinned models have no collision record (§14.7): Mountables keep a body for shots only. | fixed [verified], tests, verified in the browser |
| 2-10 | route | `2.riot` killed the last two after 300 s; nothing hit the gunner. | The run reached the riot without rounds; the route never shot the gunner (the window is clear: only his gun was on the line). | `2.revolver` (Ammo Box 160e in the yard), `2.gunner` (new step kind `shoot`). The riot then ends by itself in about a minute. | fixed |
| 2-11 | world (logic) | `2.gate` opened c36 by its own Activate message when Dallas was dead. | The gate is opened by the lever 1356 by the nest (p64 On), which Dallas's script pulls (Timer 314e) and which the player can use. | `2.gate` uses the lever (skipped when Dallas did; new step field `unless`). | fixed (fallback decoded: the player's lever) |
| 2-12 | sequence | "Mainliner" 847 (0x40, no Camera track) held the run still; the scene played out of view. | The port treated header flag 0x40 as a camera cinematic. In the EXE only a track on the Camera object takes the view and input (run flag 0x200, 0x44f497 / 0x4bccf1); 0x40 is only "is a cinematic playing" (0x44c6e0). | `World.takesCamera`: `activeCutscenes` / Enter skip only those; the route watches 847 from the walkway in the player's view. Eight retail sequences are in-world (game-logic.md). | fixed [verified], test, verified in the browser |
| 2-13 | actors (speech) | Speech Player 310f played Dallas's line 20:202 after his death ("by nobody"). | The port played a line with no live speaker at the Speech Player. Original: a dead character's speak returns at once (0x100e1b40 / 0x100a1ad0); the line still counts (p8 / p9 / p6 follow). Also decoded: p0 speaker source, p4 order, p6 destroy, p9 only after the round's last line. | `director.ts speakLine / speechPick` [verified]. | fixed [verified], tests |

### Companion survival (1c's inmate 7569, 2's Dallas 868)

What keeps a companion alive was decoded from Suffering.rfl (docs/game-logic.md §15.10): 100
health on every difficulty (no Difficulty Modifier, where creatures get x1.6 on Medium), damage
taken not scaled for allies or by difficulty, no regeneration, no scripted invulnerability after
1c's cell, no creature preference for the player, and his Action Dialogs only react to the
player hitting him. So he lives by his behaviours: the FollowBehavior, the flee, the escort walk,
and what the player does. These port rules had him walk into fights or fight badly:

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| C-1 | actors (follow) | Dallas stood at the player's shoulder in every fight, shooting from there, and was hit with him. | FollowBehavior's update was a guess: within 2 m of the player, a run beyond p5 / 2, shots on the way; a hit gave him a grudge. | Decoded (start 0x100ed480, update 0x100f03a0, child events 0x100eeb30): he waits (p3 = 1: his Hostility fights from there) until the way to the player is longer than p5 (10 m; p6 20 m while he has a target), then runs, not fighting, to p4 (7 m) short of where the player was; no way: he beckons; the leader walking into him: he steps aside. His Hostility picks attackers by the target score (`follow.ts`, `actor.ts runFollow / wayLength`). | fixed [verified], tests |
| C-2 | actors (hearing) | 1c's inmate took up gunshots while on his FleeBehavior (`investigate:` in a probe), which walks him to the noise; Dallas the same while following. | Every character with an InvestigateBehavior (p97) heard noises. | Only a ListenBehavior starts it, and only Hostility (0x100f7880 / 0x100f7950) and WaypointBehavior p4 (0x100e8790) start Listen (`behaviors.ts rootListens`). | fixed [verified], test |
| C-3 | actors (escort) | 1c's inmate walked back towards a player more than 20 m off, into the east yard's fight. | The port's escort "fetch" walked to the escort. | Beyond p10 he stops and beckons (FindPath is a search only; 0x100ea110, 0x100f12ee) until the player is within p9. | fixed [verified], test |
| C-4 | actors (nav) | Following the player through door 85c (4 m beside node 9bd) Dallas walked into the steam-pipe yard his type is kept out of; the yard's Mainliners a5e / a60 killed him there (talk 312a walks him up to the player). | Straight walks were barred only within 1.1 m of a barred node. | A straight walk is not taken where the graph's own way there (types left aside) runs through a node barred to the walker (`nav.ts shortcutBarred`). | fixed [inferred], test |
| C-5 | actors (stands) | Dallas fought Mainliners from wherever he stood. | Ranged Targeting Positions served fights against the player only. | The stand search takes the fight's target, whoever it is (0x100f74f0 -> 0x101265c0) (`ranged-positions.ts standTarget`). | fixed [verified], test |
| C-7 | actors (shots) | Dallas missed about half his shots at 15 m, so the Mainliners on him lived longer. | NPC hit chance was a guess (0.9 - 0.02 x d, at least 0.25). | Decoded: a cone of Ranged Weapon p75 x Attack p19 degrees (0x100fcec0 -> 0x100958e0 -> 0x10127b30); prisoners' attacks have p19 = 0, guards' 1, Slayers' 0 / 0.3 (`actor.ts spreadShotHits`). | fixed [verified], test |
| C-6 | harness | `2.north` / `2.talk` waited where Dallas, hanging back, never reached Detectors 904 / 2f90; the creature form killed him (35, run n2a); the inmates and creatures on him were fought only when they turned on the player; his own way on runs through the steam-pipe yard (the cell e3, nodes 1ccd .. 9ed; only the yard door 9bd is barred to him), where the vents' Mainliners the run had left alive killed him. | The steps assumed a follower at the player's shoulder; the ally check for the transformation was 12 m; `engage` skipped characters hostile only to a companion; `2.yard` runs through. | The player walks on past the Detectors; no transformation with a companion within 30 m; `engage` takes whoever is after a companion first (`playthrough-page.js`); `2.cover` goes back into the yard and fights until he has come up, `2.east` leads him on. | fixed |

Runs (Medium, headless Brave; the companion's damage from `__pt.allyDmg`):

- **1c** (`--level 1c --to 1c.exit`, `--invulnerable` where marked): before C-2 / C-3 the inmate
  died in 5 of 6 runs (to the first yard's CartWheelers 6516 / 6517 / 6520, four blade hits of
  8.2..9.1 a swing, or in the east yard to 7e16 / 7e1a on his walk 75c0); with them he lived
  through 5 of 5 (three invulnerable, two not, each of those with one player death and the
  restore), taking 3..39 damage, and in four of them reached Waypoint 7b8c himself (7813 enabled by
  the level; in the fifth the second group was not dead within `1c.lead`'s 300 s).
- **2** (`--level 2 --to 2.gate`): before, Dallas died in every run by t 210..340 s, in the
  steam-pipe yard or the middle block. With C-1 .. C-6 (eight runs; `2.cover` in the last six, C-7
  in the last two; three with an invulnerable player) he still dies in every run, but later: in the last four he came through the yard each time and died at the three
  inmates (entering with 4 health), at the riot (fdf, t 1508), to the middle block's CartWheeler
  3358 and in the east wing (a route stall kept the player there). His losses, all decoded rules:
  10 a needle from the cell block's and the yard's Mainliners (20..60), 17.5 + 2 x 9.1 a swing
  from CartWheelers 1464 / 3358, 10 a blow from the three inmates, 5 from the riot's; 100 health
  and nothing heals him. The level plans for his death (Relay 1293; the gate c36 is also the
  lever 1356's, bug 2-11), so a playthrough losing him is within the decoded rules; keeping him
  needs a player who kills what is on him at once, which the harness does only roughly.

### Results (last run, Medium, headless Brave / WebGPU, 1280x720)

`--level 2 --to 2.exit`: arrival to **3a YardCellBlock** in 25 min (1489 s), 20 of 23 step records
clean; one death (Mainliner 1029 in the steam-pipe yard, retried from checkpoint 334c with
invulnerability, kept on); checkpoints 1c74, 334c, 1c75, 334e; cinematics "Mainliner" 13.8 s, "Camera"
9.5 s (cell block), "Camera" 33.7 s (south yard); fps 60 throughout (472 draw calls at most; 3a
arrival 696). No console errors.

Failures left, by owning area:

- **Companion AI / combat (actors)**: decoded and fixed (the companion survival section above:
  FollowBehavior, hearing, escort, typed straight walks, stands; the harness covers him). What
  is left is the fights' own attrition under the decoded rules: 100 health against needles of 10
  (Mainliner Missile p26) and blade sweeps of 8..17.5 a hit, no regeneration. With him dead the
  level copes (Relay 1293 on his death), and the gate c36 is the lever 1356's (bug 2-11).
- Fixed since (bugs 2-8 .. 2-13; run of 2026-10-14 with them: `--level 2 --to 2.exit`, 29 of 30
  step records clean, 1196 s, one death (Mainliners a5e / a60 / a61 in the steam-pipe yard
  during `2.inmates`, retried with invulnerability), no logic shortcut and no teleport: the
  in-world "Mainliner" 847 watched from the walkway in the player's own view; `2.gunner` 78 s
  (the gunner leaves through be4), `2.riot` over by itself in 30 s, the lever 1356 pulled by the
  player (Dallas elsewhere), `2.climb` 94.66 -> 96.82 -> 100.90, c0c walked to and 3a reached; fps
  53..60, 491 draw calls at most. Earlier runs of the same day lost the route to the harness
  (no rounds left for the hidden catch 18ce; the riot arena chased creatures out of the south
  block: `preyR` now keeps it in the yard).
- **Harness, not the game**: the arena / shoot steps still depend on rounds picked up on the way;
  `2.gunner` stands at the nest's window under the other inmates' fire (one run died there).

## 3 YardCellBlock (routes `3a.*`, `3b.*`)

`node tools/playthrough.mjs --level 3a --shots <dir>` starts in 2 and fires its exit 11aa at once
(logged): the player arrives at 3a's "NorthEast Spawn" (17e2) with the `chapter 3` kit (the
revolver and 24 rounds, the shiv, the flashlight and a battery, two Xombium bottles; logged).
`--level 3b` starts in 3a and fires 18dc the same way ("West Spawn"). The first visit, read from
the transitions' enable logic and checked in the browser [verified]:

- **3a, first part.** The yard's prisoners scene ("Prisoner 1", 28d5) on the way down from the
  arrival walkway; checkpoint 3184; the fence gate 3a9b and the yard fight; Slayer 296e shoots
  the fence boards 329c..329e (its KillEnemiesBehavior 3ba8 lists them in p3) and "Fence" (32a0) plays;
  west to the cell house, "Gaurd1" (968); Switch 16c1 -> Timer 18dd -> Level Transition 18dc.
- **3b.** The guard booth button 1f7c; checkpoint 2d74; the inmate's talk; the phone 2d15 (the
  inmate turns into a Slayer; "Static Door" 2d03 waits on Timer 2e00, up to 120 s);
  checkpoint 2d75; the south block, the desk button 208d, the barricade 2f94; checkpoint 2d77; the
  cell lever 13d5; through the hole in cell 1ee into the basement; button 2177; checkpoint 2d7c;
  the tunnel and three ledges up; the stairs; the clamber onto the roof (Clamber Points 2bfd /
  1da5); Detector 19da -> Level Transition 19db -> 3a "East Spawn" (18de), mail 31:1 (2f8a ->
  42f3 -> Relay 42f5: the burnt walkway).
- **3a, the return.** The shotgun 2192 (optional pick); past the burnt gate 3ab0 (its hole is
  drawn only: the gate collides as one box, row 3-18); doors ba2 and 381f; checkpoint 3187; door 3806 onto the west walkway, where Object Cloners 13c9 /
  1b5a keep sending CartWheelers until the searchlights cc2 / 348e light Detectors 13ed / 1b5b;
  the searchlight cc3 lights the pit (Detector 13f8: Count Down 1b7a); down the manhole ladder
  157b; a gas tank in the store room (Relay 3e4e blows the door 3abb); the west yard: Detector
  3eec with 1b7a at zero counts 4372 down -> Relays 4009 / 400a -> the wall CartWheelers (Object
  Cloners 3fdc ...) leap the fence and fight; their deaths count 4367 down -> Object Cloner 4366
  (eight Slayers, three at a time) -> Relay 4233 -> Timer 42cd -> "Slayer" 42c7, which breaks the
  gate 3aa4; checkpoint 318a; over the roofs into the strip behind the fences (the guard
  shack's ladder 1593, a running jump onto the exit building's awning, row 3-12); Switch 3633 -> Timer 431d -> Level Transition 18e3 -> 4a.

New step kinds: `searchlight` (mount, light it with Fire, aim the beam at a point, wait for the
Detector, dismount), `ladderDown` (E at the top, S until the foot); `clamber` takes `settle`
(seconds to rest on a narrow ledge) and `nudge` (a short W tap instead of a planned walk) and
tries a second time when nothing happened; `route` takes `jumpAt` [x, z, r] (one running jump
there, W held); a `ladder` step presses E when walking into the ladder does not mount it; `arena` takes `preyDy` / `preyR` (prey kept to the
stand's floor and surroundings) and `hold` (the fight kept within that many metres of the stand).

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 3-1 | actors | After waking, the Slayer 8d0 threw an exception every frame. | The wake-up path dropped its clip (-1) but kept the action, and `actionDone` read the missing clip. | Guarded (`actor.ts actionDone`). | fixed |
| 3-2 | actors (targeting) | The yard fence never fell: Slayer 296e idled and "Fence" (32a0) never played. | KillEnemiesBehavior p3 can name any GameObject; 3ba8 names the fence Breakables. Only characters were targets. | Level objects are targets (`prop` targets: position, size, priority, damage through the damage service; a ray that reaches the target's own body counts as clear) [verified p3 semantics, docs/game-logic.md p82 row]. | fixed, test |
| 3-3 | world (static) | The gap the Slayer opens stayed blocked. | An unlit Fire card (3762) was baked into the static level: drawn and solid. | Fires are dynamic objects (`dynamic.ts`), never solid. | fixed, test |
| 3-4 | world (use) | Searchlights, the phone and several Security Monitors could not be used. | p23 was read as "usable at all"; it asks for an eye-ray test, and 0 means usable without one (0x100bae80) [verified]. | No p23 gate in the picker (`interact.ts usable`); docs/re/object-model.md corrected. | fixed |
| 3-5 | world (new) | Searchlights did nothing: no beam, no Detector filter 4. | Not implemented. | `world/searchlight.ts`: the p49 Object Generator's Spot Light Cone at hardpoint p51, beam along the model's +Z, lit or dark from p32, Fire toggles it while mounted, the camera at hardpoint p45, the cone sampled for Detectors with filter 4 (Spot Light Cones) [verified, see the file header]. | fixed, tests, verified in the browser (frames `3a.*-beam`) |
| 3-6 | world (ladder) | The manhole ladder 157b could not be taken from the top. | The pick measured to the ladder's origin (its foot), not its box. | Box distance (`interact.ts`). | fixed |
| 3-7 | actors (WaypointBehavior) | The west yard never finished: the four wall CartWheelers stood behind the fence, Count Down 4367 stayed at 4, "Slayer" 42c7 never played and the gate 3aa4 stayed shut. | Their strip's Move Nodes (3fdd / 3fde) join nothing and their next Waypoint (3fd9) is in the yard. The original ends the WaypointBehavior when MoveTo fails and runs the next behaviour, their JumpBehavior (3fd7 ...) [verified: 0x100f0f70 -> 0x100973e0]; the port waited for ever. | `actor.ts waypointLegFails`: a leg with neither a straight walk for the body nor a graph path ends the walk [when MoveTo fails is inferred]. They leap the fence (launch clip 10:1310) and fight. | fixed, tests, verified in the browser |
| 3-10 | world (Detectors) / actors | The west yard did not finish in the run: the Object Cloner 4366's Slayers that fell into the pit (13 m deep) lived on at its bottom, out of reach, so the cloner never ran out and "Slayer" 42c7 never played. | Detectors saw every copy under its template's uid, so the pit's Detector 1b7c (filter 2) sent its Damage Action Object 1b7d (p0 = 0: the sender, 200) the template, which takes no damage; cloner templates also counted as occupants. | The world hook passes each copy's own uid and leaves templates out (`world.ts actors()`) [inferred]: the copies that fall in die, as the pit's Detector intends. | fixed, test |
| 3-8 | tools (levelqa) | Portal listed as "unreferenced" in every level. | Classes handled by their class id (hex) in `src/formats` were not counted. | `levelqa.ts` matches class ids too. | fixed |
| 3-9 | harness | Walks fell off walkways (3a's arrival walkway: 58 hp), stopped under stairs, pressed levers back, picked the wrong side of a door, hit pointer-lock errors on the searchlight. | `walkable()` accepted a straight line whose samples stayed on the walkway over a point on the floor below; the door helper took levers for doors; no switch approach points. | `walkable()` must end at the goal's height; door helper door-sized only, sphere cast when stuck; `standFor` tries the switch's approach points first; Fire on a mounted light as a window mousedown (logged). Also: the view aimed 1 m over a creature's feet, over 3a's rats (0.46 m; they held the walk to the cell house for 400 s), now at its middle; arena fights keep to the stand (`hold`: no chasing across the west yard's fence or into its pit); a clamber that does not start is tried again; `window.__insanity` in harness evals (a level load made them throw). | fixed |
| 3-11 | world (clamber) | 3b's second ledge (Clamber Point 29fe) could not be climbed: every anchor within reach had no floor over it; `3b.climb2` teleported to the landing. | The modelless Clamber Point's box was read unrotated (the edge along x, facing -z) while 29fe (yaw 180, side 3) faces -x with its 3 m edge along z; and the port asked for a floor under the anchor, which the original never does. | Decoded the box and the test (0x10011030 / 0x100114f0 / 0x10011b30): matrix rows x object scale over model 2:178, only room for the body on the box top (a swept sphere), for the template picked (`clamber.ts clamberRoom`, `interact.ts tryClamber`). 29fe is climbed from its west foot, 2bfd / 1da5 under the roof from the west too; level 2's 3024 / 80b (yaw 90: identity) and 1b's ledges are unchanged (checked by script). | fixed [verified], tests, no teleport |
| 3-12 | route / world (exit strip) | No way on foot into the strip behind the rail fences (door 3633); `3a.exit` teleported the last 5 m. | The fences are solid (their collision record is one 0.4 x 4.3 m box); the way is over the roofs. The guard shack's ladder 1593 is there in chapter 3 (Relay 2424, which destroys it, fires only from mail 31:0 or Detector 1dff by the 1a spawn), but its foot is 1.2 m over the shack floor and the port mounted ladders by walking into them only from -0.3..0.6 m. | Ladders take the bottom Ladder Interaction Properties' fit window (2:427: anchor 0.4 m under the base, p2 1 m; `use-anim.ts ladderFootWindow`) [verified]. Route: shack door 3595, ladder 1593 through the roof hatch, a running first-person jump (p215 10 m/s) west off the shack roof (104) over the fence onto the exit building's awning (103), off its south edge (5.6 m, under the 6.5 m of fall damage), the porch, door 3633 (new `route` option `jumpAt`). | fixed [verified in the browser], test |
| 3-13 | actors (Slayer) | The fenced-yard fight killed the harness on Medium: Slayer 3c0c "30 a hit". | The 30 was a guessed melee blow (Attack p18 / 4, capped) of the Slayer's kick 10:1554, which has no Arm marker, and the Slayer holds no Melee Weapon: no damage in the original. Its gun fire was under-counted: one shot per clip, where each Fire (102) marker fires the weapon on its bone (five guns). | Melee Attacks hurt only through an armed Melee Weapon (`KindAttack.weaponOnly`); one shot per Fire marker (`ClipEvents.fireTimes`) [verified]. Checked against the original: 3 a bullet (Missile 10:1741 p26 x generator count 1), no difficulty scaling of damage to the player (only his health: x1 on Medium), spread p75 3 x Attack p19 (0 for 10:1506: no misses, 0.3 for 10:1505; decoded with the companion work, aa3aed9), 2 or 6 clips an Attack, pauses p21..p22. Up to 30 an Attack 10:1506 at 100 health: the fight stays deadly by data. Between Attacks: the port's p19..p20 (the parent behaviours' timing is not decoded). | fixed [verified], tests, game-logic §15 |
| 3-14 | world (searchlights) | Only the cone was drawn; a checkpoint forgot which lights were lit. | The generator's Spot Light 7:2895 was not given to the light rig; the lit state was not saved. | The Spot Light (p8 start 1 m, p9 length 12 m, p10 radius 45 m, colour 0xf7f5f2) goes to the engine rig's spot slots after the flashlight's (`engine-light.ts addSpotProvider`); the lit state (Mountable load 0x10018fc0 restores the generator handle +0xc0) [verified] and the beam's pitch are saved (`searchlight.ts save / load`, save key `searchlights`). | fixed, test |
| 3-15 | actors (MoveTo) | CartWheeler copies 15d7 / 1b5e (and Mainliner 2b83 in earlier runs) stood "chasing" for minutes under a player on a walkway or ledge above them. | With no graph path the chaser walked straight at the player and stayed there; the give-up on a failed MoveTo applied only to a stuck graph walk. | A hunter with no way on the graph to a target out of straight reach gives the target up (idles, picks again after its interval, the failed target last: KillEnemies 0x100fbbdf) [inferred: a FindPath without a result is a failed MoveTo]; a stuck walk gives up whether or not it had a path. | fixed [inferred] |
| 3-16 | actors (CartWheeler) | CartWheeler 2cc5 paced under its first Waypoint in 3b's south corridor for good (stuck-actor note). | Its Waypoints 2cc8 / 2dfd / 2d00 hang on the ceiling (102.6 m, 4.4 m over the floor); the floor walker never counted them reached (within 2 m in height) and never went up. | A Waypoint walk to a Waypoint over 2 m above takes the crawler path up (`cartwheeler.ts routeCheck`) or leaps up under it, then crawls the rest (`ceilingWaypoints`) [inferred]. | fixed [inferred] |
| 3-17 | harness | Hermes 429b "sinking"; the run left the west walkway chasing a creature down the stairs and lost the searchlights. | The sanity probe counted a sequence-held body ("Hermes" #42 flies it through the burnt walkway's floor by its keys); walkway fights chased. | Sequence-held actors are left out of the floating / sinking / stuck probe; the walkway fights hold the player's place (`stay`); a ladder step presses E when walking into the ladder does not mount it. | fixed |
| 3-18 | route / world (collision) | With objects colliding as their collision trees (docs/game-logic.md §14.10, row 9-15) the 3b barricade still closed the doorway after `3b.barricade` broke crate 2f94, and the drop through the cell-floor hole ended on top of the rubble at 95.7, from where the planner found no way to the basement button. | The barrel 2f93 lying on crates 2f92 / 2f95 overhangs the gap 2f94 leaves at head height as its 0.7 x 1.5 m box (the drawn barrel left room); the rubble 2d56 / 2d57 (23:703) is two 2.5 m boxes from z 304.5. | The step breaks 2f94 and 2f95 (2f95's p21 message 11 brings 2f92 and 2f93 down); the hole route lands south of the rubble and `3b.basement` may drop 2.5 m. The manhole ladder 157b is now a box (x 287.7..287.8) between the ladder's foot and the old `3a.tanks` stand: the walk round it faced the ladder and remounted it, and the tank 13c3 was never hit; the stand is on the side the ladder leaves him (287.55, 384.1). The decoded clamber room test (docs/game-logic.md §14.10: the proxy's sphere swept to 2.245 m) blocks 3b's first ledge (Clamber Point 2a00) under the ceiling box 29c0 that covers its east half (2.18 m above the top): `3b.climb1` stands at x 408.6 (a scan of all 229 retail Clamber Points finds no other that lost room). Checked in the browser: the doorway is clear, `3b.hole` .. `3b.roof` and `3a.manhole` .. `3a.store-out` pass. The burnt gate 3ab0's hole is drawn only (one 0.3 x 2.7 x 2 m box): `3a.gap` is gone, the walk goes by the door ba2. The gas tank 13c3 took no bullet: its template has bit 10 (AI sight passes it), which the shots had shared with sight; shots now pass no collision-tree geometry (`WorldService.shotThrough`, docs/game-logic.md §14.10) [inferred], and the shotgun breaks it. | fixed (route, weapons) |

### Results (last run, Medium, headless Brave / WebGPU, 1280x720)

With the character mover, run y3 of 2026-10-15: `--level 3a --to 3a.exit`, 58 of 59 records
clean, 4a reached in 934 s. One death (the fenced yard's Slayer fire). No floating, sinking or
stuck actor in 3a or 3b.

`--level 3a --to 3a.exit` (run of 2026-10-14, r3, with rows 3-11 .. 3-17): from the 3a arrival
through 3b and back to the arrival in **4a Quarry** through door 3633 in 16 min (953 s); 56 of 58
step records clean, no teleport and no logic shortcut. One death: the fenced yard (Slayer a10's
bullets, 3 each, five a clip; row 3-13), retried from checkpoint 3184 with invulnerability, kept
on. The other record: the awning drop ended 1.6 m from its point (the end point is moved since).
No stuck, floating or sinking actor note anywhere in 3a or 3b. Clambers: 3b's 29fe 88.87 ->
91.16, 2bfd / 1da5 104.16 -> 106.48 -> 110.16. The west yard finished by its own logic in 61 s;
the exit: shack door 3595, ladder 1593 walked into, the leap off the shack roof (jump at x 312.9,
landed on the awning at 103.3), the strip, door 3633. Searchlights cc2 / 348e / cc3 lit, their
Spot Lights on the walkway and the pit (frames `3a.*-beam`). fps 59..60 (3a 1287 draw calls at
most, in the store room). No console errors. Earlier runs of the day lost the route on the west
walkway (r1: two CartWheeler copies standing under the player blocked the manhole walk, row 3-15;
r2: a fight chased one down the stairs, row 3-17).

Shortcuts (logged): the deep link and kit; three Fire presses on the searchlights (window
mousedown); the transformation and change back (Q needs pointer lock); two Xombium bottles; the
struggle reflex.

Frames: `<shots>/r3/` (one per step with `shot`, `*-beam` for the searchlights).

- **a3j** (2026-10-22, `--level 3a --to 3a.exit`, after the collision trees and row 3-18): 55 of
  57 steps, 4a reached in 964 s. One death on Medium (the fenced yard's Slayer fire), retried. The
  other miss: the probe's "1e93 sinking -0.36" at the arrival (a scripted body 0.2 m under the drawn
  floor; the collision box there is 0.16 m higher still). Chapter 1 (`--to 1c.exit`, run c2, the
  same build before the clamber room shape): 67 of 68, one death in a fight.

### Open (by owning area)

- **Actors: perching on edges (fixed, row 55 of chapter 1).** A CartWheeler copy that fell off the
  west walkway stood 1 m over the yard floor on a ledge rim under it (`1b5d +1.00`, run r2; 1b5e
  +0.76 in earlier runs). The original's ground test is decoded (docs/game-logic.md §14.9): a
  character stands only on ground under its feet point, so a body with its centre over the drop
  falls.
- **Actors: not reproduced.** CartWheeler 2c84 sinking 0.6 m in 3b's south block (sequence 53,
  "Slayer 1..3", keys it 0.53 m over the floor with root mode 0; in the runs since it stood on the
  floor) and Mainliner 2b83 by the ledges (covered by row 3-15 if it was a pathless chase).
- **Fenced yard (data).** The Slayers' fire is as decoded (row 3-13); the harness, which fights in
  the open, dies there on Medium. Not decoded: the time between Attacks (the parent
  RangedCombatReposition / KillProjectile timing; the port uses ProjectileAttack p19..p20).
- **Props: the Gaurd1 shotgun.** Breakable 1b53 ("Invisible Bounding Box" in "Gaurd1" #50, which
  moves it to (343.0, 105.45, 393.8) by the dropped shotgun a78) has no model and no bounds: a
  modelless engine object's bounding sphere is its position with radius 0 (SUFFERING.EXE
  0x459601), and a bullet sweeps a sphere of 0.014 m (model 4:3), so shots practically never meet
  it in the original either [verified sphere; that nothing else breaks it: inferred, Radius Damage
  victim selection not decoded]. Relay 43e3 at the scene's end destroys a78 0.1 s later (Timer
  44b4 -> Relay 1b55), so nothing of that shotgun stays to see. The chapter's shotgun is 2192 on
  the burnt walkway (shown by the return mail 31:1). The port behaves the same; not changed.
- **Level data, not bugs.** 3b's "Static Door" (2d03) waits on Timer 2e00 (up to 120 s) unless
  2cc5 is hurt (its Damaged -> Relay 2dfe -> Timer 2ccc); the tower guards in 3a shoot the player
  by data (KillEnemies 3c90 / 3ece); 3b's Security Monitors are usable (p23 = 0) and lead to
  optional scenes. The guard shack's ladder 1593 / 4174 is destroyed on later visits (Relay 2424
  from mail 31:0 / Detector 1dff), leaving its top 3f86 and the fallen plank 4143.
- **Level 2 note (reported, not changed).** Row 2-2 above says p23 is "usable at all"; it is the
  eye-ray test (row 3-4, docs/re/object-model.md).

## 4 Quarry (routes `4a.*`, `4b.*`)

`node tools/playthrough.mjs --level 4a --to 4b.exit --shots <dir> --cine-strip 3` starts in 3a and
fires its exit 18e3 at once (logged): the player arrives at 4a's "SouthWest Spawn" (6888) with the
`chapter 4` kit (the revolver and 48 rounds, 3a's shotgun and 28 shells, the shiv, the flashlight
and two batteries, two Xombium bottles). The kit is now given in the level before, before its
transition fires, so it is carried over and is in the arrival checkpoint (row 4-1). `--level 4b`
starts in 4a and fires 6cb1 the same way. The routes were read from the levels' message graphs and
checked in the browser [verified]:

- **4a Quarry East** (east to west). The arrival room: Detector 82d9 wakes the Nooseman 8439 and
  Object Cloner 82d7 (wall CartWheelers, then Cloner 84c9's Mainliners). Up the ladder 8273; the
  upper floor's way north is stacked crates (Breakables 851e, 8520 + 851f, 8522 + 8521: a broken
  lower crate blows the upper one) in front of the door 827b, which opens onto a ledge over the yard;
  down into the yard (Detector 8495 shuts and locks the door behind: Relay 84ae, Timer 84ac). The
  vision of the hanged men by the fence (Detector 790f / 8203, or a look through Visiblity Message
  Filter 799c -> Relay 7904; it ends at Detector 7910 or a look through 7d54 -> Screen Fader 79a6).
  The three chained inmates (5b22..5b24) turn on the player (Detectors 65dd / 65de / 65f4 -> Relay
  65df) while Timers 65ff / 6600 drop four CartWheelers off the rocks; the Burrower 6b7a; checkpoint
  77dd. The Infernas 75c2 / 75c4 (Detector 75d6) and 7996 (79c3) run off along their waypoints and
  are destroyed at the last one (Waypoint p0 = 12); the Slayers 5976..5978 (Detectors 5bad / 7715).
  The pit under the crane 7c6e: down the rock steps (hand-laid), Detector 7a6c starts Object Cloner
  7ab4's four Mainliners, Count Down 7f76 then the CartWheeler cloners 7f74 / 7f78; the Burrower 7ac2
  is destroyed by the level when the player leaves (Timer 7ae4, Detector 7bd6). Ladder 7aea into the
  west tunnel: checkpoint 77de (Detector 84a0 -> Timer 8528); CartWheelers 5974 / 5975 (Detector
  5b79). The guard 5b7b in the cave: in Detector 660a within Timer 660b's 10 s, "Guard" 64cb (else
  660c); either ends with his death, +10 reputation and the Burrower 64ce. Out of the cave by
  Clamber Point 8190 (template 2:454 / p30 2:455, side -local z, which the placement turns to face
  +x); Detector 8021's blast; the Inferna 7a00 runs off ahead; Detector 6caf -> Level Transition
  6cb1.
- **4b Quarry West**. The ravine: Detector 636b (Burrowers 7fcd / 636a, Cloner 8384's CartWheelers);
  the Infernas 6c1c / 6c1d; Cloner 67f5's Mainliners and the Nooseman 7f94 at the ravine head. The
  lever 7d7c starts locked (its lock, Breakable 7efe, sends Unlock when broken); pulled, it blows
  the rocks 7d90 / 7d8c / 7d8e off the ledge (Relay 7eff) and plays "Boulder" 7efd. Up the rock face
  (Clamber Points 7d71, 6aaa, 7f00): checkpoint 8461. Detector 6da5: Cloner 84ed's Slayers and Relay
  84eb, which takes the invulnerability off the crate stack 8504.. in the passage south (three
  broken: Count Down 7fcc -> Slayer 84f8, Cloner 84fd). South past Detector 7d1e (the Infernas 7b6a /
  7b6b, Level Transition Remover 82ef: no way back to 4a); checkpoint 6da2; the gate's locks 82c1 /
  83e6. Over the inmates' pit (Cloner 64dc's CartWheelers, Detector 64dd) the crane controls 7bd9
  drive the crane 7a26: its boulder swung into Detector 7da5 (filter 5) plays "Boulder" 7ef0, which
  drops the boulder (Static Object 7d9f) into the ditch that cuts the pit's east part off (Relay
  7e8d disables the invisible wall 7e8a and the push-back Detector 7e8b). Across it and out by
  Clamber Point 74f3; off the ledge to the detonator 7507 (Relay 7b96: "EXPL1" 7bdc, the Breakables
  6885.. blown, Relay 637d enables Detector 6389): checkpoint 6f60. North-east, the hanged inmates'
  vision (Detectors 6c72 / 7d5a, filter 6f8a), the ridge (the Burrower 64ca), west to the crane
  platform (Detector 82ec: Pedro talks, he calls out to the player). The crane controls 7c1d drive the
  crane 7a2f: its boulder lowered and swung into Detector 7e6e plays "Pedro" 7e6d (he walks off, +15
  reputation, Reputation Points Sender 7f10). The same crane's pallet, lowered and swung to the
  other end of its slew (-35 deg), hangs in the gap by the ending platform: a running jump from
  the crane platform's lip lands on it, a second one on the ending platform (docs/levels.md
  §4.6). The ending platform: Detector 682d -> Relay 82ff ->
  Reputation Points Message Filters 8300 / 8301 / 8302 pick "Camera" 8303 / 78b9 / 8304 (39 s); each
  ends in Relay 8305 (the Infernas 7877 / 7879 destroyed; Relay 82fc takes the invulnerability off
  the water tower's base 78ad, which shot plays "WaterTower" 7869). Detector 78b3 -> Level
  Transition 78b5 -> 5a "East Spawn".

New step kinds: `crane` (mount crane controls with E, turn the view at a steady rate per phase:
horizontal swings the crane, vertical raises / lowers the hook, until a condition; E leaves) and
`walk` with `drop` (the deepest drop the planner may take).

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 4-1 | harness | After a death before the first 4a checkpoint the restored player had no weapons. | The arrival kit was given after the arrival, so the "level transition" checkpoint was taken without it. | The kit is given in the level before the transition fires (carried over like a player's); given again only if not carried. | fixed (verified: the retried 4a ran with the kit) |
| 4-2 | levels (Crane) | Cranes stood in their bind pose: the cable at its 9.6 m bind length, no hook load. | The class was only drawn. | Decoded the hoist (docs/levels.md §4.6): bone p26 / p27 cable scaled by p30 / L, min / max p28 / p29, speeds p31 / p32, p36 objects hung on p35 bones (the boulder 23:856 on bone 3), Increment / Decrement raise the hook, motor sounds p44..p46 (`levels/crane.ts`, `skinned-props.ts`) [verified]. | fixed, tests |
| 4-3 | world (Detectors) | "Boulder" 7ef0, "Pedro" 7e6e and the crane's "WaterTower" trigger never fired. | Detector filter 5 (Crane) had no occupants. | The Detector tests the object hung on the crane's bone p39 (0x100a7e40 -> 0x100121c0) [verified]; the port samples the boulder's box on a grid (`WorldHooks.cranes`, logic.ts). | fixed, tests |
| 4-4 | world (Mountable) | The crane controls 7bd9 / 7c1d / 7c2f mounted as a gun. | Mountable p30 (the object it drives) was not read. | Decoded (Mountable init 0x10017730, aim 0x100183e0, Crane input clamp 0x100125d0, control 0x10012b90): horizontal look slews the crane's bone p22 at the Mountable's p40 deg/s within +-p38 deg (p36 inverts), vertical look hoists; the camera rides the Crane's p24 (-1 in 4b) [verified; which look axis feeds which input inferred]. `interact.ts` (prompt "Use crane"), `skinned-props.ts driveCrane`. | fixed, verified in the browser (7ef0 and 7e6d played) |
| 4-5 | harness, 4a pit | The pit fight chased a creature into the cloners' niche in the pit's south-west corner and the player could not get out (the run lost the rest of 4a); the planner's way down once ended on a tree trunk at the rim. It happened again with `hold`. | Arena prey search across the whole pit; planner drops. Then: the arena's walk back to its stand fought what attacked on the way with no area (`walk` -> `fight(40)`, 14 m around the player), and a fight inside the area followed its creature past the edge. | The fight keeps to the pit floor (`hold` 9, `preyR` 10); the way down is hand-laid; the step ends when the Mainliners and CartWheelers are dead (the Burrower is the level's to destroy). The walk back to the stand keeps its fights to the area (`walk(.., { area })`), and a fight that has taken the player 3 m past the area's edge ends (the arena walks back). | fixed (browser: the fight stayed on the pit floor, ended at (477.7, 85.5, 666.1)) |
| 4-6 | harness, 4b | Smashing the crate stack 8504.. took 280 s and failed: the shiv swung from 3 m. | `break` from too far for a blade. | Stand at 1.2 m. | fixed |
| 4-7 | levels (Crane) | The hung pallet had no collision: the player and shots passed through it. | The hung objects were drawn only. | The Crane's model is skinned without a collision record, so the tower and jib block nothing. The hung objects are created from their templates as ordinary engine objects, attached to their bone and never given the no-collision bit, and the collision gather takes every shown object with a collision model (object manager create 0x45a0e0, engine vt +0x140 = 0x457550, gather 0x425a80) [verified]. The pallet 23:856 (static model 23:580) collides. One dynamic body per hung object follows its bone (`skinned-props.ts`). The lowering sweep starts under the hung object without its own body (0x10012e40) [strong]. | fixed, tests |
| 4-8 | levels (Crane) | A save or checkpoint restore put every crane back to its start: the hoist at p30, no slew. | Not saved. | The Crane's save writes its current and target ratios (+0x28 / +0x2c, 0x10012110 / 0x100120d0) and the slew is the driving Mountable's yaw matrix (+0xce, in its save, load 0x10018fc0) [verified]. Port save key `cranes`: the ratios and the slew of each crane. | fixed, tests |
| 4-9 | route, 4b | No way onto the ending platform: `4b.ending-platform` teleported. | The pallet on Crane 7a2f, the way across, had no collision (4-7). | Lowered to p29 = 4.1 m, the pallet's top is at the decks' height (105.1..105.3), and the slew's end at -35 deg hangs it 1.9 m off the ending platform's edge [verified on the data]. Route: `4b.bridge` (lower, swing to -35 deg), `4b.gap-edge`, then two running first-person jumps: 4.7 m from the crane platform's lip onto the pallet and on to the ending platform (`route` takes a list of `jumpAt`) [inferred design, verified in the browser]. | fixed, no teleport |
| 4-10 | actors (mover) | Creatures stood on ledge rims with their centre over the drop: a CartWheeler 2.4 m over the arrival room's floor (`4a.wake`), the wall CartWheelers 82cf.. on the rim of the upper floor. | The NPC motor's ground probe was a sphere of 0.85 x the body radius, so any rim it touched held the body. | The character mover decoded (docs/game-logic.md §14.9): the Collider spheres of Character p42, ground only under the feet point, p48 the step down. The wall CartWheelers now drop onto the upper floor (they hang on the wall over it at 111.9) and come at the player there. | fixed [verified], tests |
| 4-11 | route, 4a | With 4-10 the upper floor's CartWheelers fight the player at the top of the ladder; `4a.ladder`'s fight chased one along the narrow floor and over its edge, back into the arrival room, and the route was lost (no path back up to the crates). | The fight after the ladder moved with its target. | `4a.ladder` holds the player's place while it fights (`stay`), as the 3a walkway fights do. | fixed (browser: the crates, door and yard followed) |
| 4-12 | harness, 4b | `4b.climb3` sometimes did not start the clamber ("feet 99.97 -> 99.11", both tries). | Not an engine issue as far as checked: pressed from the ground at the foot, Clamber Point 7f00 (templates 2:638..2:641, reach 2.5 m, minimum height p7 1 m) started every time (four stands around the foot, the route's own step, and `tryClamber` directly). The failing run read the feet 0.86 m above the ledge: the walk to the foot ended in the air (its stuck recovery jumps against the third ledge's rock face) [inferred]. | The clamber step waits for the player to be on the ground and at rest before reading the feet and before each press, and logs where a failed press came from. The same check found `4b.climb1` failing from its stand: Clamber Point 7d71 (template 2:455) allows at most p2 = 4.5 m from the feet to the ledge top (95.25), and the stand on a sloping rock left the feet at 90.70..90.83; from 90.75 up it starts every time. The stand is now the rock's flat top (267.0, 90.84, 645.9, `tol` 0.15). | fixed (harness / route; not an engine issue) |
| 4-13 | route, 4a pit | The way down into the pit ended 16.8 m short, the player caught in a gap between the rocks at (492.5, 96.4, 668.2) that six jumps did not get him out of. | `4a.pit-edge`'s fight had chased down onto the rock steps to (492.0, 97.9, 668.6); from there the hand-laid route slid him into the gap (1 of 3 starts in a probe; from the edge it went down every time). | The fight at the edge holds the player's place (`stay`). The gap itself is open (world / collision): a player can walk into it. | fixed (route) |

### Results (last run, Medium, headless Brave / WebGPU, 1280x720)

With the character mover (rows 4-10..4-13), run a7 of 2026-10-15: `--level 4a --to 4b.exit`
reached **5a Asylum** in 1114 s, 67 of 70 records clean. One death (the chained inmates, 5b22),
retried with invulnerability. The others: `4a.vision-end` 0.9 m and `4a.pit-edge` 1.2 m short.
No floating, sinking or stuck actor anywhere; the pit fight stayed on the pit floor; every clamber
started at the first press (4a's cave 85.16 -> 87.91; 4b 90.81 -> 95.22 -> 99.11 -> 101.17, the
crane ledge 95.09 -> 99.26). The runs before it were the reason for 4-11..4-13 and the harness
changes (4-5, 4-12). Earlier result:

`--level 4a --to 4b.exit`: from the 4a arrival to the arrival in **5a Asylum** in 19 min (1120 s);
66 of 70 step records clean, all of 4b among them. One death: the chained inmates' fight (5b25's
leap and 5b26's blows), retried from the arrival checkpoint with invulnerability, kept on. The
other misses are in 4a: a CartWheeler floating 2.4 m in the arrival room (`4a.wake`), `4a.yard`
3.8 m short after a fight, and `4a.pit-edge` 1.4 m short (the hand-laid way down went on from
there). Checkpoints 77dd, 77de, 4b arrival, 8461, 6da2, 6f60, 5a arrival; cinematics "Guard"
14.6 s and "Camera" 39 s (the 4b ending); in-world scenes "Boulder" 7efd / 7ef0, "EXPL1",
"Pedro", "WaterTower". The crossing: `4b.bridge` left the pallet at slew -0.611 rad with a 4.1 m
cable; the jumps went off at (406.4, 468.8) and (398.3, 465.4); landed at (388.9, 105.1, 462.5).
fps 59..61 throughout (4a 492 draw calls at most, 4b 617). No console errors. A second run lost
4a in the pit: the fight chased into the south-west corner again (bug 4-5) and `4a.ladder2`
never reached the ladder. A third run lost 4b at `4b.boulder` under heavy machine load (fps 44..49,
five harness runs at once): E at the controls 7bd9 targeted nothing (it mounted in two retries
from a capture). A fourth crossed again (jumps at (406.4, 468.8) and (398.0, 465.3), landed at
(388.9, 105.1, 462.5)) and was stopped during the ending scene by a pause. A fifth (with other
agents' uncommitted `world/interact.ts` changes in the tree) lost 4b at `4b.climb3`: the clamber
onto the upper path did not start, where runs 1 and 4 climbed it.

Shortcuts (logged): the deep link and kit; the transformation and change back (Q needs pointer
lock); Xombium bottles; the struggle reflex; the look input of the crane controls as a per-frame
view turn. **No teleport.**

Frames: `<shots>/` one per key step, `*-crane` from the crane controls, `*-cine-*` strips of
"Guard" and the 4b ending.

### Open (by owning area)

- **Crane (levels).** Which look axis maps to hoist and which to slew, and the controls' view,
  are inferred. The lowering sweep is a ray from under the hung object, where the original sweeps
  a radius-p40 shape.
- **Combat.** The chained inmates (bats, 10 a hit) with the four CartWheelers killed the harness
  once on Medium.
- **Level data.** The Infernas of 4a / 4b never fight: they are scripted walk-bys destroyed at their
  last Waypoint, and two figures in the 4b ending scene; the Inferna's fight (inferna.ts) was not
  met in these levels.

## 5 Asylum (routes `5a.*`, `5b.*`)

`node tools/playthrough.mjs --level 5a --to 5b.exit --shots <dir> --cine-strip 4` starts in 4b and
fires its exit 78b5 at once (logged): the player arrives at 5a's "East Spawn" with the `chapter 5`
kit, which is 5a's own level-select kit (the pickups linked from its Player object: two
revolvers and 48 rounds, the shotgun and 28 shells, the Tommy Gun and 192 rounds, the flashlight
and two batteries, four TNT sticks, four Flash/Bangs, four flares) plus the shiv and two Xombium
bottles [data]. `--level 5b` starts in 5a and
fires 167f the same way ("North Spawn"). The routes were read from the levels' message graphs,
cross-checked against a published walkthrough's order of tasks, and played in the browser
[verified]:

- **5a Asylum Backyard** (no Autosave: the arrival checkpoint is the transition's). North from the
  foot of the hill to the garden wall, climbed by its rubble (Clamber Points 209c, then 203c on the
  wall top: modelless markers turned 19 / 110 degrees, row 5-1). The gazebo: Detectors round it
  count Count Down 1dfb down, and at zero Behavior Changers give Carmen (1dea) her four lines; the
  last enables the look-at Detector 22d7 and starts a 20 s Timer. Walking up to her ends the vision
  (Relay 1e06): she is gone and the Burrowers 1e1c / 1e1e come up. South into the front courtyard:
  Detector 21bb -> Relay 17db, the CartWheelers 1b28..1b2a break out of the windows and Object
  Cloner 21bd sends four Burrowers. The front door ed9 is barred by a crate (Pushable 2303) among
  junk Breakables; Detectors 231c / 231e / 231f (filter 3) blow up the junk the crate is pressed into
  (row 5-4). Pulled north, the crate breaks 230e and frees the door; using the locked door ed9
  (p69 Triggered) runs Timer 1a85 / Relay 2345 -> Level Transition 167f -> 5b.
- **5b Asylum Interior, to the theatre doors.** The lobby (a glass floor over the basement, row
  5-2): "Camera" 258a, which shuts and locks the doors behind and wakes the lobby CartWheelers. The
  lobby projector 140e (Breakable 313b round it) shot down unlocks the north door 10de. Upstairs,
  Detector 2bee plays "Camera" 2bed: Torque drops to the theatre doors 12ac / 12ad, which stay
  shut until Count Down 12ab has had three projectors broken (their p21, row 5-7):
  - 2c4f in the corridor, hittable once Detector 2a82 takes its invulnerability off;
  - 2c4e in the basement (down the hole at (180, 169)), hittable after "Camera" 2942;
  - 2c50 seen from the attic, hittable after "Camera" 2945.
- **The basement and the west wing.** Junk 13c7 / 13c8 shot out of the way, the crate 29b8 pushed
  into the shelves (Detectors 14fb / 13cc, filter 3: the shelves topple, STOMPs 14fa / 14e7)
  unlocks the door f31. The boiler room's Detector 29f6 makes the boards over door 321e breakable;
  three broken unlock it. Up and west through 10dc / 10dd (checkpoint 2ac0) to the stage room,
  "Camera" 1296. The hoist rope 2b3f shot through lowers the crate on Mechanism 2b42 (row 5-5) and
  unlocks the door bac; the planks over bad shot off unlock it.
- **The attic.** The cage crate 29ba from the cell behind 1115 dragged and pushed under the attic
  hatch at (153.5, 206.4); a jump onto it and a clamber up (checkpoint 2ac1). The generator chain
  31ef pulled ("ReBirthActor" 2c6a) enables Detector 2bc2: "Camera" 2945, Slayers and Mainliners,
  and the projector 2c50 can be hit. The way back down is covered by a projected trap door (ISO
  2308, from the caged projector 31f3); its cage crate 32f6 dragged east into Detector 32fc turns
  the beam off, and the player drops through the hatch.
- **The theatre and the end.** Detector 12d4: "Camera" 1ba4, checkpoint 2ac2. Through d3e
  (Detector 12cf) the five projectors that show Killjoy can be hit: 1503 / 1506 / 1502 by their
  fuses 30c5 / 30c4 / 30c3, 1505 by the fuse box 2b0b, the caged 2b0a by its rope 2b2e. Meanwhile
  Killjoy flees the player and raises his dead CartWheelers (KilljoyRootBehavior, row 5-8). The
  last projector gone, Killjoy takes 10000 damage and leaves; Sound 1641 starts "RebirthMachine
  Actor" 2d4d. The yellow button 2bec, then the purple beam of Object Generator 2e3f (Ring Damage
  3:4555: the Killjoy Rebirth Effect, eight rebirth grenades). A rebirth grenade thrown at the
  insanity creature 2c3b (row 5-9) plays "Instanity Creature" 2d53, then "Rail" 2e55, and the
  window's Breakable 302d is gone. A running jump out of the west window crosses Detector 13c2 ->
  Level Transition 13c1 -> 6a Woods "West Spawn".

New step kinds and options: `throw` (throw the held throwable at an object through
`services.weapons.throw`, logged), `leap` (a running first-person jump from a point toward
another, W held, Space after `after` s); `break` takes `weapon` (equip first, logged) and `until`,
and walks back to `from` after a fight knocked the player off; `walk` takes `relocates` (a
cinematic on the way moves the player, so arriving is not checked); `push` takes `rel` (the
stand as an offset from where the object is now) and `skipDone` (nothing to do when `until`
already holds); new expectations `gone`, `awake`, `unlocked` and `dead`.

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 5-1 | world (clamber) | 5a's garden wall could not be climbed: no anchor on Clamber Point 209c from the rubble. | The modelless point's box was read unrotated; 209c / 203c are turned 19 / 110 degrees. The rule is the one of row 3-11. | `interact.ts clamberMatrix` (placement matrix x scale) for modelless points; the ch3 work added the room test on top [verified]. | fixed, test |
| 5-2 | app (collision) | The player fell through 5b's lobby floor into the basement. | Collision dropped every surface whose material layers all blend; the lobby's glass 29:571 is blend 7 (src + dst x srcAlpha), an opaque-ish surface, not light. | Only additive layers without depth write (blend 2) count as light-only (`physics.ts lightOnly`) [inferred from the blend modes; checked on the lobby floor in the browser]. | fixed, test |
| 5-3 | actors (placement) | The Burrowers 1e1c / 1e1e and 5a's cloner copies fell through the floor when woken. | The dormancy clip keeps a Burrower's joints under its origin (it lives underground), which the ceiling-hanger heuristic took for a body hanging from a ceiling. | The heuristic leaves Burrowers out (`manager.ts applyDormancy`) [data]. | fixed |
| 5-4 | world (Detectors) | The crate 2303 never broke the junk 230e: the front door stayed barred. | Filter 3 (Pushables) tested the crate's centre point; the original tests its shape: the crate's top reaches 6 cm into Detector 231f beside its centre. | Pushables moved off their place report their box; the Detector tests an oriented box against it (`logic.ts boxTouchesBounds`, `props.ts pushablePositions`) [inferred: a shape contact, as filter 5 tests the hung object's shape; the original's exact test not decoded]. | fixed, test |
| 5-5 | world (Mechanism) | The stage room's hoist crate flew to the world origin when the rope was shot. | `poseMech` refreshed the root's matrix from a position that the Mechanism's motion does not write. | Use the root's own matrix (`props.ts poseMech`). | fixed |
| 5-6 | fx | A shot that hit the debris of a broken crate threw every frame. | The impact lookup read the model of a spawned object without a model ref. | Fall back to the object's own model (`surfaces.ts atHit`). | fixed |
| 5-7 | world (projectors) | The three projectors 2c4e / 2c4f / 2c50 could not be broken: Count Down 12ab never counted, the theatre stayed shut. | They are Animating Statics with health (p0 15) whose p21 (Off) the level listens to; the port made only Breakables breakable. | Every Animating Static with health and a p21 output is breakable (`projector.ts`) [data: the three in 5b are exactly the ones wired]. | fixed, test |
| 5-8 | actors (Killjoy) | Killjoy stood still; his dead CartWheelers stayed dead. | KilljoyRootBehavior / KilljoyRaiseDeadBehavior were not run. | Decoded (docs/game-logic.md §15.7.8): Flee (p77) plus LookAt; the corpse list scanned from its end; a dead one is run to (MoveTo, 2 m), RaiseDead's clip (p175: 10:510) plays and the corpse is resurrected (`actor.ts runKilljoy`, behaviours `killjoy` / `raiseDead`) [verified]. | fixed, tests |
| 5-9 | actors (damage) | A stray bullet into the insanity creature 2c3b started the asylum's ending in the middle of the fight. | GameObject p5 "immune to unlisted" was ignored: 2c3b lists only type 17 (the rebirth grenade's Radius Damage) in its Damage Resistance. | The actors' damage applies the resistance multiplier when p5 is set (`manager.ts damage`, `gas.ts resistanceMultiplier`) [verified]. | fixed, test |
| 5-10 | harness | Breaks missed thin targets; the projector counted as an ally in the line of fire; uses aimed at nothing while the autopilot turned the view; Burrowers were set aside as unreachable. | Aim and Fire in one frame met the revolver's recoil; `allyInFront` took projector figures and decor for allies; the autopilot's follow overrode the use aim; a burrowed Burrower is not a target until it attacks. | Fire one frame after aiming; the revolver for thin targets; allies skip decor, the `projector` team and Animating Statics; the autopilot is stopped before a use; `engage` keeps Burrowers, `canShoot` only when they are up. | fixed |
| 5-11 | harness | `5b.cell` left the cell door shut; `5a.exit` threw after a slow level change; a Mainliner copy "chasing" in place 4.6 m off in the attic held every walk for minutes. | The walk to the door's stand opened it (door helper) and the use's E shut it again; the transition wait (6 s) was shorter than 5b's load, and the retry reached for the old level's door; the walk's set-aside of creatures that take no damage applied within 3 m only. | A use that expects the door open does not press E on an open door; the save manager's "level transition" / "no level" state counts as a change under way; a chaser that has not moved and taken no damage for 8 s is set aside for 30 s at any range. | fixed |

### Results (last run, Medium, headless Brave / WebGPU, 1280x720)

`--level 5a --to 5b.exit` (run of 2026-10-14, `final`): from the 5a arrival to the arrival in
**6a Woods** in 27 min (1637 s), on a machine shared with four other runs; 60 of 65 step records
clean, no teleport and no logic shortcut. One death: the 5a courtyard (CartWheeler 1b28's blows
after the Burrowers had taken the player to 24 hp), retried from the arrival checkpoint with
invulnerability, kept on; on the retry the courtyard cleared by itself in 54 s. The other
records:

- `5a.exit`: the level change into 5b took longer than the step's 6 s wait, and the step's second
  use reached for the old level's door. The harness now counts the save manager's "level
  transition" state as a change under way.
- `5b.stage-room`: the walk stopped 0.6 m off the thin Detector 129c, so "Camera" 1296 played at
  the start of the next step. The walk now ends on the Detector's middle.
- `5b.cell`: the step's walk to the door opened it (the door helper), and the use's E then shut
  it again. A use that expects a door open no longer presses E on an open door (row 5-11).
- `5b.cage-1`: the grab missed once; `5b.cage-2` finished the drag and the beam went off.

The fixes since `final` were checked from captures:
- v2 (the basement capture to `5b.crate-1`): "Camera" 1296 played within `5b.stage-room`, and the
  cell door was "already open" and stayed open.
- v3 (from `5b.cell` to `5b.attic`): all 7 steps clean, with the new `5b.crate-1b` and `rel`
  stands.

Three later full runs did not finish:
- final2 lost the attic: a Mainliner copy "chased" in place 4.6 m off for 5 minutes. Its walks
  stopped to fight it, and the harness could not hurt it. The fix is the set-aside rule in row
  5-11.
- final3 pulled the cell crate 1.7 m past its mark. The push east then met the wall beside the
  door, and the attic was not reached. The fix is `5b.crate-1b` plus stands relative to the
  crate (`rel`).
- final4 stalled at "Camera" 2bed: no output for 35 minutes, with the machine at a load of
  300..400 from other runs. It was stopped there.
- final5 ran clean through every fix above: no death in 5a, the cell door "already open",
  `5b.crate-1b` "already in place", the attic and the cage, and "Camera" 1ba4. The only record
  before the theatre was `5b.junk` (13c7 not destroyed, though the crate push behind it worked).
  During `5b.proj-1503`, while fighting the raised CartWheelers 1511 / 1512, the player ended up
  at (204.8, 97.7, 184.4) by the 5b arrival, with full health and no death. The theatre doors
  stay locked from there, so the remaining projectors could not be reached and the run was
  stopped. The player's fall-out rule fits this: more than 30 m under the level's bounds, he is
  put back at the spawn point (`player.ts onFellOut`). So he went through the theatre floor
  during the fight [inferred; not caught]. A probe from the theatre capture with a trail logger
  ran `5b.proj-1503` .. `1502` with no fall.

The last end-to-end run to 6a is still `final`.

Checkpoints: the 5a and 5b arrivals, 2ac0, 2ac1, 2ac2. Cinematics: "Camera" 258a (33 s), 2bed,
2942, 1296 (30 s), 2945 (16 s), 1ba4 (40 s). In-world scenes: "ReBirthActor", "RebirthMachine
Actor" 2d4d, "Instanity Creature" 2d53, "Rail" 2e55. Killjoy raised CartWheelers 1510 / 1511
during the theatre fight, and they attacked the harness (`5b.proj-1503`, `5b.proj-1502`). The
five projectors went in 33 s. The rebirth grenade hit 2c3b. The window leap crossed 13c2, and the
player arrived in 6a at (222.1, 98.0, 689.3). fps: 5a 29 at the lowest (avg 56, 1192 draw calls
at most, in the courtyard fight), 5b 50 at the lowest (avg 60, 420 draw calls at most). No console
errors.

Earlier runs of the day:
- r1 died in the courtyard and timed out in `5a.court-fight` (300 s).
- full1 lost the route at the boiler room: the shelves' STOMPs were still playing when the step
  started, and the step now waits 5 s for them.
- p2 started from a basement capture and reached 6a with every 5b step but `5b.boiler` and
  `5b.cell`.

Shortcuts (logged): the deep link and kit; the revolver equipped through the API (number keys
need pointer lock); two Xombium bottles; the struggle reflex; the rebirth grenade thrown through
`services.weapons.throw` (the right mouse button needs pointer lock).

Frames: `<shots>/final/` has one frame per step that takes a shot. `*-cine-*` are strips of
258a, 2bed, 2942, 1296, 2945 and 1ba4.

### Open (by owning area)

- **Level data, not a bug.** The Autosave 2abf never fires: its input is Off while the Relay that
  feeds it (31e2) sends On [data]. The other three checkpoints (2ac0..2ac2) fire.
- **Actors (Killjoy).** RaiseDead also brings the corpse's broken body parts back with the clip's
  progress (§15.7.8); not ported: a raised CartWheeler comes back whole at once.
- **World / actors (player collision in the theatre fight).** Twice the player was stuck in the
  geometry at (139.6, 97.3, 149.0) by the theatre's west window after a fight. Once (final5) he
  fell through the level during the fight with the raised CartWheelers and was put back at the
  spawn. Not root-caused. A candidate is `manager.ts pushPlayer`: it moved the player out of
  overlapping actors after a single waist-high ray against the world, not a sweep of his body.
  Made collision-safe: the push now goes through the player's motor (`CharacterMotor.shove`, his
  capsule swept and slid like a step, the summed push of all overlapping bodies once a frame,
  height kept), so a sill or low wall under the ray stops it (test: tests/mover.test.ts). The
  original's player / character contact is not decoded (the movers' sphere contacts, §14.9, are
  the likely rule). Not re-run in the browser: the fall was never reproduced.
- **Combat.** The 5a courtyard fight (three CartWheelers, four Burrowers) killed the harness on
  Medium in three of the full runs. In r1 and final4, `5a.court-fight` ran out its 300 s while a
  Burrower copy was still counted as hunting.
- **Actors (Mainliner).** In final2 a copy from Object Cloner 12b2 (template 12b4, placed at
  (165, 108.7, 193.8) in the attic) stood "chasing" 4.6 m from the player for over 5 minutes.
  It never closed in, and shots did not hurt it. Not reproduced from the capture, so not
  root-caused. Bug 3-15's give-up (no graph path) did not end it.
- **Rendering (shadows), reported for the 6a Projector Effect item in "6 Woods".** Checked: the
  projector's opacity override keeps the alpha test. three.js r186 discards after the opacity
  multiply, on both the alpha-to-coverage path and the plain one, so the override cannot make
  texels with alpha 0 visible. 6a's effect 2136 lists the figure 2135 itself (an Animating
  Static, so a decoration actor) as its five "projectors", with lens bone 5. The cone's tips
  therefore go to the figure's own bone, as the data asks. A likely cause outside the
  projector: the projected-shadow pass (`engine-light.ts silhouetteOf`)
  keeps a caster's alpha test only when the material has a `map`. Layered surface materials hold
  their texture in `surfaceSlots`, so a cut-out part casts its whole triangles as black shadow.
  The figure also casts a shadow whenever the effect is not running (`noShadow` is set only
  then). This is not verified in the browser.

## 6 Woods (routes `6a.*`, `6b.*`)

`node tools/playthrough.mjs --level 6a --to 6a.exit --shots <dir> --cine-strip 3` starts in 5b and
fires its exit 13c1 at once (logged): the player arrives at 6a's "West Spawn" (1419) with the
`chapter 6` kit (the chapter 5 kit: two revolvers and 48 rounds, the shotgun and 28 shells, the
Tommy Gun and 192 rounds, the flashlight and two batteries, TNT, Flash/Bangs, flares, the shiv,
two Xombium bottles). `--level 6b --to 6b.exit` starts in 6a and fires 1a88 ("NorthEast Spawn"
137c). 6b has two exits: Level Transition d51 to 1b "North Spawn" is the story's, the return to
the prison that opens 1b's revisit (the arrival plays 1b's sewer "Camera" 8283, 67 s); 137e only
leads back to 6a. The routes were read from the levels' message graphs and checked in the browser
[verified]:

- **6a The Woods** (north to south).
  - Out of the walled lane: Detectors 15fb / 1be7 / 1d04. Burrowers run past on their waypoints
    and are destroyed at the end. Two crows fly off (Ambient Creatures 1c22 / 1c29), and the rain
    starts (22c0).
  - The hedge maze west of the lane. Detector 240c prefetches; Detector 2088 at the gazebo starts
    the two Infernas 207f / 2080 behind the hedge the player came through. They run to Waypoints
    2160 / 2161, taunt (RootPlayAnim 10:691, 1 s) and run off to 2162 / 2163, where Relay 2411
    destroys them. Their laughter (25:88) turns the player back. Detector 2167, enabled by 2087,
    fades them out at the hedge's gap if he gets there first. That is all the Infernas do in 6a:
    two scripted figures.
  - Checkpoint 2328. The ringing phone 22af: from Detector 2126, Visiblity Message Filter 2127
    plays the vision of the bus prisoners (Screen Fader 212c, Time Scale 20 %, Killjoy's figure
    2135 under Projector Effect 2136) until the sound 25:90 ends.
  - The road south past the Festers (Detector 1795: Burrowers, then Object Cloners 1794 -> 179d ->
    17a6). Checkpoint 2329.
  - The clearing: Detectors 8b8.. send the Slayers a09 / 1c2f, Cloner 1c4e's CartWheelers and
    then the Slayer 2337 (Count Down 2336).
  - The burnt ruin east: filter 1d1b (or the pickup 1d1d) plays the electric chair vision. The
    ruin burns (Relay 19ae), and Cloner 1d09 and the Burrowers follow (Count Downs 1d64 / 1d65).
  - The gully west of the ruin: Detectors 6f3 / 1519 / 151a -> Relay 1518.
    - The stranger on the ledge (54b, the 10:642 template that is Clem in 6b) throws a molotov at
      the propane tank 1432 (KillEnemies 142c).
    - The blast fells the birch across the gully ("Birch01" 140d) and lights the barrels (Relay
      16d7).
    - His next KillEnemies 225b takes the tank 1429. Then he walks to Waypoint 232d, which
      destroys him.
    - Detectors 2402 / 2403 fire 225c for a player who walks on before he throws.
  - East along the gully to its end under the truck: the molotovs (1cc1..1cc3, or Detector 23f2)
    -> Relay 2158. The stranger's second self (1cc4) walks to the truck's jack and speaks (25:92),
    and the Mainliners of Cloner 1daf and the Nooseman 1db3 come. The gully's end is closed to the
    truck side by the player-only box 1a47, so the way on is back west.
  - Up the stranger's ledge (Clamber Points 1bd4, 1bd5; climbing destroys 54b, Relay 241a).
    Checkpoint 16c9.
  - The cliffs: Relay 13ee drops the CartWheelers 522..525. Then the road (the Slayer 1cd2).
  - The jack: Switch a08, a Switch with no model (row 6-1) -> "Truck" a9b / 6aa. The truck falls
    into the creek, and its box 1be5 turns solid.
  - West along the creek: checkpoint 232b. The cave by the pond: Detector 1ddf with filter 20d3
    shows Torque's children (1af3 / 1af4, a voice line). They walk off and vanish. The cave
    fight: Burrower 20e2, Cloner 21d5's CartWheelers, the Slayer 21da, and Cloner 1dde's
    Mainliners (Detector 1de0).
  - Back east: a jump onto the fallen truck (1.7 m), Clamber Point 5b5 up the bank, and Detector
    1a87 -> 1a88 to 6b.
- **6b The Beach**.
  - Horace behind the power station fence: filter 159f -> Reputation Points Message Filters ->
    "Horace" 1e5f / 1e5d / 1598, in the world (a voice line).
  - Detector a25 sends CartWheelers a28 / a23 / a22 at Clem (49a), who fights them with molotovs.
    Their deaths (Count Down a36) start his talk and his escort. They also remove Relay 2087,
    which would otherwise destroy him once the player reaches the beach first.
  - Following him: checkpoint 20e6, then Detector 897 plays "camera" 147e (41 s, the beach).
  - The Fester waves along the shore (Cloners 894, 87f, a54, 1fe1) and Clem's chain of Behavior
    Changers (843, a45, a4a, a4c, ending in FollowBehavior 138f).
  - The door under the pier: Relay 205c enables Detectors 203a / 2059, and a Fester bursts through
    ("Door" 2035).
  - Inside the pier: Clamber Point 1d49, a plank, then the beams north across Detectors 139a /
    139b (Relay 20e7 makes the oil drum platform's Breakable 136b vulnerable). On the way, the
    drowned men's vision (filter 1f37 -> Screen Fader 1603).
  - The oil drums shot: "OilDrumPlat" 136a, then Relay 13a4 makes the gas tanks breakable. One tank
    shot -> Relay 1393: the platform burns and every Fester and cloner is destroyed (Relay 136c).
  - Back up through the hatch onto the deck, over the plank walk to the cliff top. With Clem alive,
    Detectors 6b7 / 202d play his farewell "Clem" 6b8.
  - East to the hut: Detector d50 -> Level Transition d51 to 1b.

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 6-1 | world (use) | 6a's truck jack could not be used: no way across the creek, so the level could not be finished. | Switch a08 (Interaction Properties 2:924) is the only Switch in the 18 levels without a model, and only Switches with a dynamic object (a box to look at) were offered. | The original lists usables by touch and the fit test, not by the view (§14.5). A modelless Switch is offered when a template fits and the view passes within 0.6 m of its anchor (`interact.ts viewOnAnchor`, `world.ts pickTarget`) [inferred]. | fixed, tests, verified in the browser |
| 6-2 | actors (ranged) | The stranger on 6a's ledge never shot the propane tank; in 6b Clem ran into the Festers to fight them hand to hand. | His weapon (Character p55) is a BouncingObject (10:1863, a molotov). The port read only Ranged Weapons and Missiles, so he had no ranged attack, failed his MoveTo to the tank 9 m below and gave the target up. | Decoded the ThrowWeapon (230) case of ProjectileAttack's animation messages (0x100fd026) and the ballistic aim (0x100ccee0 -> 0x100cc590): p9 reach, the lowest elevation that passes within 2 m, otherwise p10 degrees (docs/re/animation.md §9) [verified]. `actors/throw.ts`, `manager.ranged` (`thrown`), `clipmap` throw marks, `actor.fire`, the weapons service's `throwObject`. | fixed, tests, verified in the browser (the tank blows, the birch falls) |
| 6-3 | actors (KillEnemies) | After the tank the stranger stood on his ledge for good. The second tank and his walk off never came. | A KillEnemies that a Behavior Changer handed out never completed, so the chain's p17 (Relay 2330) never fired. | A choice with no target completes it (§15.15, already decoded) [verified]. A handed-out one ends and its chain goes on; a character's own default one keeps searching (`actor.ts perceive`). | fixed, test, verified in the browser |
| 6-4 | actors (sight) | Target choice could not see an object target whose centre lies inside its own collision (the tank seen from above). | The choice's line of sight did not count a hit on the target's own body, though the shot's line already did. | The same rule in the choice (`seeThroughFor`). | fixed, test |
| 6-5 | route | `6a.molotovs` ran into the gully's end from the road and was trapped against the player-only box 1a47. | The gully's end is reached along the gully from the tanks, not from the road. | Route reordered: tanks, molotovs and ambush, back west, the ledge. | fixed |

Harness additions: Ambient Creatures are left out of the floating / sinking / stuck probe (the
crows fly to their last waypoint and vanish). Clem (49a) is a companion, though the port marks
him hostile (his default behaviour is a KillEnemies): left out of `engage` and `hostiles`, kept
in the ally line of fire and in `allyDmg`, and no transformation near him. Festers are fought
with the blade, since their armour zeroes bullets (§15.7.3).

### Results (Medium, headless Brave / WebGPU, 1280x720)

- **6a** (`--level 6a --to 6a.exit`, run r7): 28 of 33 step records clean, 738 s, 6b reached by
  play with no teleport.
  - One death: the clearing's Slayers 1c2f / a09, 3 a bullet, after the Fester fights left the
    player at 40 health. Retried from checkpoint 2329 with invulnerability, kept on.
  - The other records: a floating Rat (a Fester's, 1.09 m up) during the clearing; Slayer 2337
    stuck (below); `6a.creek` stopping 1.08 m short (its tolerance was raised since).
  - Checkpoints 2328, 2329, 16c9, 232b. Visions: the bus prisoners (frame `6a.vision`), the
    electric chair (`6a.ruin-vision`), the children.
  - fps 37..61 (57 on average), 999 draw calls at most (the phone vision).
- **6b** (`--level 6b --to 6b.exit`, run b2): 17 of 20 step records clean, 428 s, 1b reached by
  play.
  - One death: Fester rats on the beach (10 a leap). Retried with invulnerability.
  - The other records: the plank route ending 2.1 m short (the next step climbs from there), and a
    floating rat (4d2).
  - Cinematics: "camera" 147e 41 s; 1b's "Camera" 8283 67 s on arrival. In-world: "Horace"
    (reputation), "Door", "OilDrumPlat".
  - fps 59..60, 434 draw calls at most.
- No console errors in either level.

Shortcuts (logged): the deep link and kit, the transformation and change back (Q needs pointer
lock), Xombium bottles, the struggle reflex. No teleport, and no logic forced.

Frames: `<shots>/r7/` and `<shots>/b2/` hold one frame per key step, plus `*-cine-*` strips of
the beach cinematic and 1b's arrival scene.

Outdoor rendering, checked against the data:
- Both levels' Sky Properties (7:1689, 7:1702 / 7:1750) give a near-black sky and horizon
  (0x15151a / 0x161618) with linear fog from 54..60 % of 40..45 m. The frames show that: dark
  woods under a black sky, birches and hedges to the fog.
- Rain falls from the lane on, and the creek carries Volumetric Fog.
- The beach's sea and sand are drawn with the layered water material. 6b's Fog / Sky Switchers
  2002 / 2006 / 2007 swap 7:1750 and 7:1702 (the difference: the Sky / Sun layer 7:1706) when the
  sea is looked at from the pier.

### Open (by owning area)

- **Projector (rendering), owner: chapter 5. Fixed.** In the phone vision, Killjoy's figure 2135
  (model 10:196) showed as large black stretched triangles: its cone fans (submesh 0, 2:904,
  cut-out, texture alpha 0), pinned to its own bone 5, drawn opaque. Two causes: the lit
  character path took its alpha test from the texture header (none for 2:164) instead of the
  pass's mode 8 (`character.ts characterAlphaTest`: > 200 / 255), and three r186's
  `NodeMaterial.copy` drops `alphaTest`, so the projector's material clones lost even that
  (`glow-mark.ts cloneWithGlowMark` restores it). Checked in the browser: the figure stands
  whole and opaque (p5 = 100) with no black shapes. `fx/body-parts.ts` clones with a plain
  `clone()` and loses its alpha tests the same way.
- **Companion (Clem).** Clem died in both 6b runs within about 10 s of the first Fester wave on
  the beach: about 30 rats from the Festers' rat release, 4 a bite (the port's guess for rats
  biting a character), plus 40 from Fester blows and 8.7 from the harness's shotgun.
  - Fixed (rats): decoded from RatJumpAttack's update, a rat bites only the Player; a leap that
    touches any other character just ends (docs/game-logic.md §15.7.13) [verified]. The other
    creature moves now take the fight's target too (Fester charge / release, Slayer leap and
    ceiling slash, Mainliner leap and ride, Burrower fly-by, Inferna, Nooseman; §15.7.1..15.7.6).
  - Runs after the fix (`--level 6b --to 6b.exit`, three runs): Clem took no rat damage. He lived
    through the beach in two runs (125 health). In the third, Fester 147d charged him (30, the
    decoded charge contact with any character) and its blows (26, 40, 40) killed him in 14 s.
  - Open (harness): with Clem alive, `6b.shore` waits 600 s and gives up. The pier door's
    Detectors (Relay 205c) come from his death (a42), from the last wave's Count Down 1d89 (Cloner
    1fe1's four clones dead, which also sends Clem on: Timer 20ae -> Behavior Changer a4c), or
    60 s after the player enters Detector 20a2 (x 426, Timer 20a3). The harness stays by Clem and
    does neither. His farewell 6b8 needs him at Waypoint a49 (it enables Relay 139e; the gas tank's
    Relay 1393 then enables Detectors 6b7 / 202d), so it was not reached in these runs.
- **Actors (mover volume, fixed).** The Slayer 2337 stayed stuck in 6a's clearing under a leaning
  log on its Move Node edge 1c5d -> c2a. Its capsule was the bind-pose height (3.8 m). The mover is
  decoded (docs/game-logic.md §14.9): a Slayer's Collider 10:1389 is three r 0.65 spheres, 3.15 m
  tall (2.99 m at 2337's scale 0.95). That does not fit either: the log is static level geometry
  1.5 m above the ground there (measured in the browser), so no Slayer passes under it [inferred:
  nor the original's]. Its WaypointBehavior #2338 walked into the log for good (run w4: "stuck
  2337 move 53 s"). Now a Waypoint leg the body stays stuck on for 4.5 s fails the MoveTo, which
  ends the WaypointBehavior as decoded (actor.ts; test in tests/yard.test.ts) [inferred]. Runs:
  w5 (all of it) 31 of 33 records to 6b in 860 s, no stuck, floating or sinking actor; w3
  (unscaled volume) 30 of 33, no stuck actor; w4 (scaled, before the leg rule) the stuck note;
  the other misses a death in the clearing (Slayer a09 / 1c2f), `6a.road` 29 m short once after
  the cliffs fight left the player on a ledge at 94.9 m (the planner's drop limit), and
  `6a.creek` 1.2..1.5 m short.
- **Combat.** The 6a clearing (two Slayers, 15 a second together, after the Festers) and the 6b
  beach (Festers' 30 charge, rats) each killed the harness once on Medium.

## 7 Return to Prison (routes `7.*`, `r1b.*`, `r1a.*`)

The story's return to prison is not level 7. Read from the transitions, their enable logic and the
mailbox [verified data, docs/campaign.md §1.1 / §2]:

- **6b -> 1b** (hop 14, chapter 5:619): 6b's way out passes Detector 1e54 (posts 12:0 to Level
  Transition Msg Handler 1e55), then Detector d50 fires Level Transition d51 ("North Spawn" 7ca3,
  1b's sewer).
- **1b -> 1a** (hop 15, 5:625): in 1b the mail 12:0 reaches handler 8933 (the scene "Camera" 8283,
  Level Transition Remover 8934 for 6a / 6b, Relay 7ca5: the revisit set-up, which also posts 11:0
  through handler 7ca9). The way out is the arrival room's locked door 79b2, whose use now runs
  Timer 8b79 / Relay 8c0c -> Level Transition 8b7a ("South Spawn" 79b5).
- **1a -> 3a** (hop 16, 5:628): in 1a the mail 11:0 reaches handler 7a0c -> Relay 79e0 (the 1a
  set-up; it stores 31:0 for 3a through handler 8660 and enables Detector 7a12 -> Level Transition
  7a13, "North Spawn"). 3a's handler 3737 takes 31:0 on arrival (the yard's second visit).
- **1c** is not on the way: 2's Level Transition Remover 3084 has forgotten it, nothing in the
  return leads there, and 1c's only reader (80ca, 13:1) is fed by 2 [data].
- **Revisits keep chapter 1's state.** Nothing removes 1a or 1b before the return (1a's Remover
  865d forgets 1b at the chair scene's end; 8a's 29ca forgets 1a / 1b / 3a later), so the engine
  loads both as the player left them (docs/re/saves.md §3.4). The set-ups are written for either
  state: they blow up chapter 1's creatures and destroy its Detectors themselves (1b Relays 8280 /
  8281, 1a 7a07), and the 1b way back (64e1, Horace's gate 6134) does not use chapter 1's doors;
  both routes were walked with the visited state and fresh (level 7 without `--visited`).
- **Level 7** "Return to Prison Test" is a cut-down copy of 6b's way out (the same uids d50 / d51 /
  1481 / 1482; its 1b spawn 82da lies 0.7 m from 7ca3): a test map of the return that nothing in
  the campaign reaches.

```
node tools/playthrough.mjs --level r1b --visited <capture> --to r1a.exit   # from 6b, the story
node tools/playthrough.mjs --level 7 --visited <capture> --to r1a.exit     # the test map
node tools/playthrough.mjs --level r1a --visited <capture>                 # 1a's return only
```

Harness additions: ARRIVALS entries take `level` (the level arrived in when the id is not one:
r1b / r1a), `mail` ([handler, message, sender] posted in the level before, as its way out would)
and, without `from`, a `kit` for a level started on its own (level 7's start pickups, which float
10 m over the beach). `--visited <capture>` puts the levels of a control server `/capture` into the
session before the transition (logged), as a player's earlier visits; the capture used here is 1a
and 1b as `--level 1a --to 1b.exit` left them (1c dropped: 2 forgets it). The `chapter 7` kit is
the chapter 6 one with the Fire Axe and eight Molotovs. `ladder` takes `run: true` (no stopping
to fight on the way to the foot).

| Step | What happens (level logic) |
|---|---|
| `7.arrive`, `7.climb`, `7.exit` | the test map: up the rock (Clamber Point 6b4), Detector 1481 (12:0), Detector d50 -> d51 to 1b (spawn 82da) |
| `r1b.arrive` | the sewer: "Camera" 8283 (67 s), the set-up (Relay 7ca5) |
| `r1b.sewer` | run north and up the ladder 7a43: Timer 8936 / Detector 7ee9 drop Object Cloner 7ee2's rats from the pipe, Detectors 7f03 / 7f04 open the grates 7ea0..7ea3 (Cloners 7eea, 7ef5, 7f02); 15 rats each |
| `r1b.cp1` | Detector 7e19: Autosave 8bea, the Fester 7e18; the flashback Movie Player 8b67 |
| `r1b.festers` | Detector 7e0c: the Festers 7e08 / 7e0d (Behavior Changers 7e09, Timer 7e11 -> 7e0e) |
| `r1b.burrower`, `r1b.boards` | Detector 7e2b sends the Burrower 7e1a to Waypoint 7e25, whose Timer 7e29 -> 7e28 blows the barricade 7e1b..; killed first, a hit on the boards 7e20 does it (Breakable 8be8 -> 7e28); its death starts Cloner 8bd9 (Mainliners) |
| `r1b.mainliners` | Detector 8be6: Cloner 8be2 (three Mainliners) |
| `r1b.corridor`, `r1b.cp2` | Detector 8beb: Autosave 8bec (skipped while the player was hurt recently, save/rules.ts, and the Detector fires once: the fight is ended short of it) |
| `r1b.lever` | the lever 7b5b opens the gate 6548; past it the insanity vision (Detectors 83d5 / 89f0 / 8c2d, enabled by 7ca5) |
| `r1b.door` | the corridor's east door 64e1 is locked (10 health): smashed |
| `r1b.walkway`, `r1b.horace` | inside Detector 83c0 (enabled by 7ca5) the Visiblity Message Filter 83c1 passes with Horace's spot on screen -> Relay 83bc -> "Horace" 89f4 (12:274, in the world): he zaps the locked gate 6134 open (its transform keys) and is removed |
| `r1b.exit` | the arrival room door 79b2: Level Transition 8b7a to 1a |
| `r1a.arrive` | the basement; the set-up (Relay 79e0): fires and their damage Detectors, the gas chamber door 50e7 opened, 5125 and the chair room's north door 4e47 shut and locked, chapter 1's creatures blown up, Detector 7a12 enabled |
| `r1a.chair` | Detector 79e6 -> Relay 80d3: "Camera" 80d2 (12:262, 28 s); Horace in the chair (HoraceKillPlayerBehavior: shields and the generators' invulnerability follow his charge, Relays 83ae / 8591), the corpses 7a3e.. get up |
| `r1a.gen-*` | the five generators 8570 .. 8576 count Count Down 8592 down; at zero Relays 8596 / 8649 unlock the chair switch 8588 |
| `r1a.switch` | the switch closed (p65) starts Timer 8398 -> "Camera" 8399 (12:251, 9 s): Horace burns, 5127 opens, Remover 865d forgets 1b |
| `r1a.cp` | Detector 8b07 (enabled by Relay 8aae): Autosave 8b08; Detector 8aad: Hermes ("Hermes" 8ac9) |
| `r1a.gas`, `r1a.lobby`, `r1a.exit` | out the way chapter 1 came in, backwards: the broken window, the gas chamber, the sally port, the lobby, the lower west corridor, Detector 7a12 -> Level Transition 7a13 (3a) |

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 7-1 | actors (Rat) | The 1b sewer's rats killed the player in 3 to 8 s wherever he stood or ran: 25 bites of 4, then (first fix) ten of 10 in under a second at the ladder. | The rat attack was a guess: the leap and chew clips played as a melee attack repeating 4-damage bites, and a rat that missed chased again. | Decoded RatKillObjectBehavior / RatJumpAttackBehavior (docs/game-logic.md §15.7.13): a leap within p2 m (4) and p3 degrees (20); the first touch latches the rat on, bites p4 (10) once, and it dies after its chew clip; a rat that missed waits where it landed until the player is in front of it again (`actors/specials/rat.ts`) [verified]. | fixed [verified], tests |
| 7-2 | harness | Revisits started fresh, mail never posted, level 7 had no kit. | No way to arrive with earlier visits or a level's own way-out messages. | ARRIVALS `level` / `mail`, `--visited`, direct-start `kit` (above). | fixed |
| 7-3 | harness | The run stopped at the sewer ladder's foot while the rats caught up. | `ladder` walked to the foot with fights. | `ladder` with `run: true`. | fixed |
| 7-4 | actors (Rat) | Rats that missed and stood still hung in the air (the probe's "floating" rats). | The waiting rat skipped the motor. | It stands under gravity; leaping and latched rats count as airborne (`fall`). | fixed |
| 7-5 | harness | `checkpoint: true` failed after a transition with an arrival cinematic. | The transition checkpoint comes two settle frames after the cinematic, after the check. | Waits up to 10 s, as the numbered form does. | fixed |

### Results (Medium, headless Brave / WebGPU, 1280x720, a GPU shared with other agents' runs)

- **The story, 6b -> 1b -> 1a -> 3a** (`--level r1b --visited <1a / 1b of a chapter 1 run>`, run 2):
  to the arrival in **3a YardCellBlock** ("North Spawn", mail 31:0 delivered to 3737) in 17 min (997
  s), no teleport and no logic shortcut; 21 of 27 step records clean. One death: the Festers 7e0d
  (charge 30) and their released rats, retried from checkpoint 8bea with invulnerability, kept on.
  The other records: the floating rats (7-4), checkpoint 8bec skipped while hurt (split since) and
  `r1a.chair` stopping short of Detector 79e6's plane (moved since). Checkpoints: the arrival, 8bea,
  8bec, the 1a arrival, 8b08, the 3a arrival. Cinematics: "Camera" 8283 (67 s), "Camera" 80d2 (28
  s), "Camera" 8399 (9 s); in the world: "Horace" 89f4. Mailbox: 12:0 -> 8933, 11:0 -> 7a0c, 31:0
  -> 3737; Remover 8934 (6a / 6b) and 865d (1b) ran. fps 60 in 1b and 3a; 1a below (open).
- **Level 7** (`--level 7`, invulnerable, fresh 1b / 1a): `7.*` and every `r1b.*` step without a
  teleport (the 1b way back works on a fresh 1b too), `r1a` to the chair switch; with a fresh 1a
  the planner finds no way from the gas chamber down to the lobby and the lower corridor (chapter
  1's start state), so the test map's 1a leg needs 1a's chapter 1 state, as the story has it.
- Fixes since run 2 were checked in their own runs: `r1a.chair` (the scene played, frames
  `r1a.chair-cine-*`), the rats under gravity (no floating note), the Horace gate (strip below).

Frames (`--shots`, kept out of the repository): one per key step; `r1a.chair-cine-*` (the chair room
through the observation window, Horace's lines); a strip of `r1b.horace` from the walkway: the
gate 6134 shut, then swung open by the sequence's keys.

### Open (by owning area)

- **fx (Object Generator): the chair room's fire flood** — fixed (decoded, docs/game-logic.md
  §14.2 Object Generator; `tests/object-generator.test.ts`). Each broken generator spawns 12:715
  (Breakable 12:716 and the Object Generator 12:779: p6 1, p7 0.05 s, p21 0.6, p22 1), and the
  port ran 12:779 and the generators it spawns for good (it read p28, a player range, as the run
  time): 6000 .. 12700 spawned "fire:0" objects, 2700 .. 3500 draw calls, 10 .. 13 fps. p21 is the
  run time and p22 the runs before the generator is destroyed: 12:779 fires 9 .. 12 times in its
  0.6 s and is gone, leaving one endless 12:775 (a 12:768 burst a second within 50 m) and at most
  three Fires per break. A spawned Fire's own life is still not decoded.
- **actors (Mainliner ride) / world: player inside a static heap.** In two of four runs that died
  and were restored before the Mainliner room, a ride ending in the finisher left the player
  inside the junk heap at (330.2 .. 333.4, 73.2, 398.1 .. 400) (a static part; reach 1 cell, every
  direction blocked), and the route stopped there. Not seen without a ride's finisher.
- **actors (CartWheeler special) / saves**: `--deaths r1b.boards`: the restored level differs by
  "650f.crawler false -> true" (chapter 1's CartWheeler, blown up by Relay 8280).
- **Combat (data)**: the Festers (40 a blow, 30 a charge, bullets only at their weak spots) and
  their rats kill the harness on Medium; each rat bites once (7-1).
- **sequence / actors: Horace behind the gate.** In the `r1b.horace` frames Horace (83b8) is not
  made out behind the bars while his lines play (dark or not drawn; not measured).
- **Chapter 1 escort (1a guard 609e)** — fixed. A `--level 1a --to 1c.exit` run stopped at the
  escort: 609e stood on WaypointBehavior 7524 at (384.8, 545.9), `1a.guard-comes` / `1a.follow`
  timed out and the gate 7f48 stayed shut. Two things met [verified in the browser]: (1) when the
  guard's conversation 854b ends before the player passes the west end (it depends on when the
  player stepped into Detector 8270 after the CartWheeler fight: route timing, not code), 7522 is
  said up there and 7524 starts with the player already walking to the gate, beyond p9 (10 m),
  so the guard waits and beckons (the decoded escort rule, aa3aed9; the earlier passing run had
  the other order, 7522 walking him down to the player); (2) once the player came back, the
  port's MoveTo-failure stand-in (`waypointLegFails`, 91ef3de / 840088b), re-run every second
  from wherever the body was, failed on the stairs (the body sphere met the stair floor rising to
  Move Node 7517) and ended 7524 short of Waypoint 8316, so nobody opened the gate. A leg is now
  tested once, when its MoveTo is issued, and rising walkable floor does not count; the route's
  `1a.guard-comes` goes back to the guard. Run of 2026-10-14 (late): the guard walked 7524 from
  the top of the stairs through the door to 8316 and the gate opened.
- **Harness**: `--save` of a capture taken in another level killed the player on restore (not
  used by the route; `--visited` covers it).
- **1a chair room behind the electrified door (deep link)**: reported black in a `--level 1a`
  session. On the real route it is drawn (chairs, walls, the witness room behind the glass); from
  the same spot (429.2, 538.5, flashlight off, after the scene) the witness room measured a mean
  luminance of 22 on the route against 10 in a deep-linked session, the corridor walls 11.7
  against 12.4. So a deep-link artefact of level state the route sets up on the way (which light
  state differs is not traced). Both are darker than the original's frames of the scene.

## 8 Bluff (routes `8a.*`, `8b.*`)

`node tools/playthrough.mjs --level 8a --to 8b.exit --shots <dir> --cine-strip 4` starts in 3a and
fires its revisit exit 2e93 at once (logged): the player arrives at 8a's "SouthEast Spawn" (1aa2)
in the prison's admissions yard with the `chapter 8` kit: 8a's own level-select kit (the pickups
its Player object links: two revolvers and 72 rounds, the shotgun and 30 shells, the Tommy Gun
and 144 rounds, the shiv, the Fire Axe, the flashlight and two batteries, four TNT sticks, two
Flash/Bangs, three flares, two Molotovs) plus two Xombium bottles, given in 3a before the
transition. `--level 8b` starts in 8a and fires 1d60 the same way. The routes were read from the
levels' message graphs and checked in the browser [verified]:

- **8a Bluff.** The dying guard 281d by the paddy wagon talks (Detector 1bbe / 2b0a -> Relay
  2823: Speech 2821, 40:132); the script blows him up when the player comes on (Detector 2d3d /
  1cb0 -> Relay 2d3b -> Timer 2d07). Detector 2914 starts the yard ambush: Object Cloner 274d
  (six Slayers, two at a time), Cloner 27ed and the pit's CartWheelers (Behavior Changers 27ee /
  27f0, switched by a grid of yard Detectors through Relays 27f2 / 27f3). The refuge the yard is
  built round is the guard house roof (103.6, 6 m over the yard): Clamber Point 2288 is its east
  edge over the alley (a box 8 m along z; the entity dump's yaw is not the matrix's) and 2d2c its
  south edge, both 6 m up, past a clamber's 4.5 m. The way up is the crate 193a (Pushable 7:457,
  2 m tall) in the corner south of the alley: pulled west in line with the guard house, pushed
  north up the alley under 2288, jumped onto (the first-person jump: Player p215 10 m/s under p214
  24.4, 2.05 m) and clambered from (4 m). On the roof Detector 27fc (the top of 2288) -> Relay
  27f3 enables Behavior Changer 27ee (FleeBehavior 27ef) and disables 27f0 (KillEnemies 27f1, the
  player its p3 target): the pit's CartWheelers flee (Timer 29e7 -> Relay 2806 hands it out; the
  yard grid does the reverse). The Slayers still shoot up at him. Detector 28fd (on the roof) and
  28fc (by the wagon) take the
  invulnerability off the paddy wagon's engine box 1b80 (a hidden 20-health target) and its fuel
  can 25b3; the engine is shot from the roof's north edge (25 m) and plays "PaddyWagon" 1b7c (4.7 s): the wagon rolls north and smashes
  the yard gate (Door1 / Door2 25e4 / 25ef), its collision box SwitchBus 2a15 lands in the
  gateway, Relay 1da0 enables the wagon's Clamber Points 26e0 / 26e1 / 26e3 and Relay 28df turns
  the ambush cloners Off. Over the wagon (26e0, its east side) and off its north end: Detector
  2cf6 -> Timer 2d06 -> Autosave 1e08. East along the road, Detector 1d10 / 2a19 plays "Camera"
  1d0e (45.5 s): the prison truck with Hermes and a prisoner plunges into the creek. Detector
  2cf8: the Infernas 2534 / 2545 / 254d, the Burrowers 2cda / 1d50, the fires (Relay 1d4e) and
  the Slayers 1d4a / 1d4c (Relay 2d01). The creek (3..3.5 m: deeper than 2 m drowns, row 8-2): a
  running jump from the west bank top (87.5) at the south ford (z 539.5, Detector 2b2c) over the
  channel onto the east ledge (84.7; the cave wall behind it stops the jump; row 8-12), north
  along the east ledge under the overhang to the rocks, up
  Clamber Points 25b1 and 2a3e onto the far bank's terraces. Crossing the bank's planes
  (Detectors 2712..2715) sends the CartWheeler 2813 (10 000 health) off the cliff to Jimmy (26fb)
  by the gate 19b4, who kills it and walks off east (Relay 2709, Speech 2707). Detector 1e1e: the
  Slayers 1e1c / 1e1a and three CartWheelers; Detector 1d48 -> Autosave 1e0a; the Burrowers
  2d08..2d0b (Relays 2341 / 2345). The clearing: Detectors 271a / 271b (or a look through
  Visiblity Message Filter 1d02) -> Relay 22cc -> Screen Fader 1dac, the vision of the hanged
  men (Time Scale, blur; the hanged men 1d18.. shown, the bodies 1d12.. hidden); Timer 1da8 ends
  it -> Relay 2716 -> Relay 2cae: the Slayers 2caf..2cb2, first of a Count Down chain of about 25
  Slayers in waves on Ranged Targeting Positions (2c90 -> 2c01 -> ... -> 2c8c). The exit is never
  gated by them: east to the cave mouth under the rock arch, a 3 m drop into Detector 1b70 ->
  Level Transition 1d60.
- **8b Bluff ("Caves to Lighthouse").** Detector 170b: Jimmy (16fe) talks and walks off; the
  Festers 1709 / 1b4d on their waypoints. Up two ledges (Clamber Points cf9, 1802): Detector 25f7
  -> Autosave 25f8; the Fester 1783 and two CartWheelers (Detector 1787). Up through the hole in
  the telephone room's floor (Clamber Points 11e4..11e6; the room's vision of the man on the
  phone: Sound 18ac -> Detector 1714 -> Visiblity Message Filter 18ae -> Screen Fader 187b), down
  its stairs into the store room (on the way Detector 26b3 shuts the door 122e to the stove side
  for good: Timer 26b2 Off; the way east is the store room's barricade). The
  store room's Tommy Gun rounds, then the crate 1d5e that bars the way east: broken, Relay 18bf
  opens Portal 1196 and starts a horde (the Slayer 18bb, Object Cloner 2698's Mainliners, the
  Slayer chain 2631.. and Cloner 2660's eleven). Jimmy's stove room: the cave wall is held by the
  hidden targets 181f (explosions only, Damage Resistance 2:662; vulnerable while a Pushable
  stands in Detector 180a, filter 3) and 1929; the explosive crate 2598 (breakSpawn 7:2494) is
  moved into 180a along its diagonals (it stands at 135 deg) and shot: Relay 174e -> "Cavern
  Rubble" 1d86. East: Detector 11fd -> Autosave 1898; Burrowers and CartWheelers; the ravine
  (Detector 1793 -> Relay 1794); Ladder d05 to the walkway: Detector 25f9 -> Autosave 25fa.
  Jimmy, freed by the blast (Relay 174e -> 1751 -> Behavior Changer 174f), is an escort:
  SimpleConversation 1752 (40:20) -> WaypointBehavior 1753 (p8 the Player, a leg only while he is
  within p9 10 m, beckoning beyond p10 20 m) east through the broken wall -> SimpleConversation
  1758 -> WaypointBehavior 1759 round the caves and into the ravine to 175c by Ladder d05 ->
  SimpleConversation 1760 (40:312) -> WaypointBehavior 189f straight to Waypoint 1ea5 in Hermes'
  room (up the ladder; p3 2: he never fights on it). On the walkway Detector 26b5 (filter 1) ->
  Instance Message Filter 26b6 (sender Jimmy) -> Relay 1ea3 -> 24e9: Relay 1edf off, 24e8 on, so
  the room's scene is his "Camera" 1eb1 (76 s), not 1ed5 (48 s); its end hands him a DeathBehavior
  (Behavior Changer 25d5 -> 10:350): Hermes kills him. Level Transition 1798 lists him (p7), but
  9's arrival from 8b (Player Spawn Point ca5) names no companion (p4 / p5 empty): nobody is
  carried to 9, in the original as in the port.
  Hermes' gas room: Detector 1eaf -> "Camera" 1ed5 or 1eb1; its end turns the gas on (one Damage
  Action Object per difficulty, 3.5 / 5 / 7.5 / 10 a second) and makes the room's hanging lamps
  breakable (Relay 25c4). The four valves (Switches 2159 / 2157 / 21cf / 213d -> Disarm ->
  Mechanisms 272a / 2729 / 2725 / 2728 turn 160 deg -> p58 Off -> Count Down 1fa9): the gas stops
  and the Hermes phase starts. Six spots, each a gas jet (Object Generator 3:3251), a lamp stand
  and an Object Cloner of a Hermes copy; Relay 2413 picks the spot of the next copy at random among
  the live jet Relays (2415, 2418 the stove, 241c, 2420, 2532); every 10 s a copy spends at the
  spots (Timer 2429, paused while none is in their Detectors) Behavior Changer 242d makes them all
  vanish (RootPlayAnim 10:1735) and Timer 2443 clones again. The player blocks jets: the crate
  2404 onto Detector 2458 (filter 3), the hanging lamps 2510 / 24be / 250b shot down (Mechanisms
  2509 / 24ae / 24a0); each block destroys its Relay and sends Relay 2718 -> 2716 -> Behavior
  Changer 20c5: every copy walks to Waypoint 20c3 at the stove. A copy at the stove (Detector 2565)
  enables Relay 1f0d. Hermes takes no damage at all (p5, Damage Resistances 2:779 type 5 / 2:656
  type 14 at x0), but their p2 = 1 passes the impact force of fire and wind, and the hit reaction is
  picked by force (row 8-8): a Molotov's blast makes him react and his HitReactBehavior 10:1228
  sends its p11, Triggered, to his links: 1f0d -> 2496 -> "Hermes" 1f0f (the gas into the stove)
  -> Count Down 1f15 (2 -> 1), Timer 1f13 (8 s: he gets out, the door opens). Closing the stove
  door 1e37 (p36: starts open; p65 Decrement) takes 1f15 to zero -> Relay 26ae -> "Camera" 24e7
  (the door shut too early also disables Relay 2496, inDisable 9: nothing goes in until it is
  opened again, p64 Increment),
  Timers 251c / 25da -> "Door" 24ff. Up the ladder 1ec7 through the hatch: Detector 1f2f -> Level
  Transition 1798 (9 Lighthouse).

No new step kinds (walk / clamber / ladder / use / push with `rel` / break / arena / wait /
follow / throw / route). New options: `clamber` `here: true` (press from where the player stands:
on top of 8a's crate, a spot the planner cannot walk to); `route` `relTo: uid` (points and
`jumpAt` as offsets from that object's centre where it is now); `throw` `select` (the
throwable), `cls` + `near: [x, y, z, r]` (whichever character of that class stands there: cloned
Hermes copies have no level uid), `ready` (a further condition), `aimY`, `max`. The deep link
waits up to 600 s for the first level (a loaded machine took over 180 s).
Harness fixes: a walk into a Level Transition's Detector ends cleanly in the next level
(the loop's evaluation used to throw `__actors is not defined` while the level was torn down); a
plan whose start cell has no free neighbour (pressed against a shelf in a fight) starts from a
free spot up to 0.8 m away.

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 8-1 | world (shots) | The paddy wagon never rolled: shots at its engine box 1b80 (20 health, made vulnerable by Detector 28fc) did nothing, so the yard gate stayed shut and the ambush cloners ran on. | 1b80 is a hidden system-package hit target (model 2:180, built for its body only); its texture 2:164 is cut-out, so the port's see-through rule (bullets fly through bars and chain-link) let every bullet through it. | A hidden hit target is never see-through (`dynamic.ts partSeeThrough`) [inferred: the level places it as the wagon's hit target, its fire on it]. | fixed, tests, verified in the browser |
| 8-2 | levels (water) | 8a's creek could not be crossed: its rock lips and the cave floor sit at the water level (84.0), the bed 3.4 m down, and the player sank to the bed and drowned after 1.5 s. | The port made water surfaces non-solid and added drowning, both guesses. A first fix (b220869) made the surfaces a floor for the player, read from the class filter 0x1002c340(1) listing Water Volume - also a guess: the contact loop sends a water contact to the water-effects component and never on to the mover (docs/levels.md §4.2), and the component drowns him deeper than Player p28 = 2 m. The creek is 3..3.5 m deep everywhere; the route was never through the water. | Water holds nobody up again; `WaterRuntime` runs the decoded component (entry splash p19, ripples p15 / wake p16, wading steps p17 / p18, no running deeper than 1.5 m, drowning deeper than 2 m with clip 325, fall damage x 0.9^depth). The route crosses at the south ford: west ledge, a running jump over the 3 m channel at z 540 (Detector 2b2c), north along the east ledge under the overhang to the rocks (`8a.creek` / `8a.ford` / `8a.ledge`). The planner treats water over 1.9 m as no floor. | fixed [verified], tests, verified in the browser |
| 8-3 | world (Mechanism) | 8b's four gas valves turned but the gas never stopped (Count Down 1fa9 stayed at 4): no Hermes phase, no way on. | Mechanism outputs p55..p58 were never sent. | Decoded (0x100c81fb..0x100c8254): a motion group at rest sends p55 + 2 g, +1 at its travel (`props.ts mechArrivalOutput`); the valves' Mechanisms send p58 Off -> Relays 1fa7.. -> 1fa9 (docs/game-logic.md §14.3). | fixed [verified code; arrival inferred], tests, verified in the browser |
| 8-4 | actors (outputs) | Character output p31 ("ISeeYou") was never sent (8a's Slayers, the guard 281d, 8b's Hermes copies and Jimmy link it). | Only p15 / p28 were fired. | Decoded: KillEnemies' choice taking the player as a new target -> event 0x200c -> p31 (0x100fa30c, 0x100e40ea) (`actor.ts fireSlot31`). | fixed [verified], test |
| 8-5 | harness | A walk into a Level Transition's Detector (8a's exit 1b70) failed with `__actors is not defined` (the level is torn down under the loop). | `walk` evaluated page state every 80 ms. | A failed evaluation during a level change ends the walk (`left ... on the way`). | fixed |
| 8-6 | harness | The planner could not start from a body pressed against a shelf in a fight (8b's store room): every walk and fight stalled for minutes. | The start cell had no free neighbour. | `plan` starts from a free spot up to 0.8 m away. | fixed |
| 8-7 | route | Pushing 8b's explosive crate 2598 failed ("could not grab"). | It stands at 135 deg; the grab takes the crate axis that points at it and lets go when the player is more than 1.4 m off that axis. | Stands on the crate's diagonals, relative to where it is (`rel`). | fixed |
| 8-8 | actors (hit reactions) | 8b: Hermes never sent Triggered (6) to the stove Relay 1f0d; the route sent On to Relay 26ae after 120 s (logged). | Two decodes missing. The hit reaction's amount is the blow's impact force (damage record +0x1c, Missile p28..p31, Melee p69 x Attack p7, Radius Damage p2..p3) times the matching Damage Resistance's p2 (0 with GameObject p6 and no match), and it is sent for blows of 0 damage; the port compared the damage after resistances and dropped zero-damage blows. And a whole-body HitReactBehavior sends its p11 to the character's links as it starts (Hermes' 10:1228: p11 6). | Decoded (Character damage 0x100e7390: 0x100e779b / 0x100e77e9 / 0x100e7801 / 0x100e776b, hit reaction 0x100e6480 reads message +0x2a; HitReact start 0x100ebfa0; docs/game-logic.md §15.13): `fx/gas.ts resistanceForceMultiplier`, `manager.ts damage`, `ActorBlow.react`, `HitReactDef.message`, `actor.ts startReaction`; the player's bullets, melee and every Radius Damage pass `force` / `minForce` (world/damage.ts). Hermes takes no damage but fire (2:779) and wind (2:656) push him: a Molotov makes him react. | fixed [verified], tests |
| 8-9 | world (Message Relay) | 8b: after a few jets were blocked the Hermes copies stopped coming back. | Relay 2413 picks one random link among the jets' Relays; blocking a jet destroys its Relay, and the port still picked destroyed links (the message went nowhere and the clone cycle ended). | A destroyed link leaves the pool and the pick is made again; the refill takes the live links only (0x100cbdc3 -> 0x100a9e90, the counter taken back at 0x100cbdd7; 0x100cb8f0) [verified] (`logic.ts relay`). | fixed [verified], test |
| 8-10 | route | 8a: the yard ambush killed the harness in every run (row "8a yard ambush" of the open list). | No way up to the guard house roof was found: its walls are 6 m, a clamber 4.5 m at most. | The crate 193a pulled and pushed under Clamber Point 2288, the first-person jump onto it (2.05 m), the clamber (4 m); the CartWheelers flee from the roof (27fc). Harness: `clamber here`, `route relTo`. | fixed (route) |
| 8-11 | route | 8b: Jimmy's scene "Camera" 1eb1 never played and nothing of him reached 9. | The route ran ahead of his escort (WaypointBehavior 1753 walks a leg only while the player is within 10 m). Being carried to 9 was a misreading: 9's arrival point ca5 has no p4 / p5, and his scene kills him. | `follow` steps after him, the ravine cleared ahead of him (`8b.ravine`); the carry stays empty by data. | route (he still dies in the ravine: open) |
| 8-12 | route (after the collision trees) | 8a: the ford's running jump fell into the channel; the walk down the west bank stopped on its edge. | Since the collision trees (docs/game-logic.md §14.10) the west bank's water-level rock (84.1), the ledge the old route stood on, is a model whose tree has no nodes: its drawn faces are for rays only, movers pass it [verified decode, not a port bug]. | The jump is made from the bank top (87.5) straight onto the east ledge (84.7, 3.8 m across, 2.7 m down; FP jump p215 / p214), the cave wall behind the ledge stopping it; `8a.ledge` ends where the east ledge does for the planner. | route |

### Results (Medium, headless Brave / WebGPU, 1280x720, a GPU shared with other agents' runs)

- **After rows 8-8 .. 8-12** (2026-10-22, e170605 plus this work):
  - **8a** (`--level 8a --to 8b.exit`, run full2): from the 3a arrival to the arrival in 8b with
    no teleport and no logic shortcut. The refuge: the crate 193a pulled and pushed (1.9 / 10.3
    m), the jump onto it, the clamber 99.66 -> 103.63, "PaddyWagon" shot from the roof's north
    edge, down and over the wagon (checkpoint 1e08), the truck scene, the new ford jump (from the
    bank top, landing on the east ledge at 84.74), the rocks 84.74 -> 87.73 -> 89.72, checkpoint
    1e0a, the vision, the Slayer wave, Detector 1b70. One death: on the roof after the wagon shot,
    the Slayer 2752's bullets (3 each), retried with invulnerability. A 1b80 shot from the roof
    in the separate run a4 (the roof steps clean, the same death on the way down in its first try).
  - **8b, Hermes' room** (exploration session: teleported to the walkway, logged, the route's own
    steps from `8b.hermes` on): the valves, the crate 2404 on its jet, the three lamps, a Molotov
    at the copy by the stove: Hermes reacts (type 5, force 18.7, no damage) and sends Triggered ->
    1f0d -> 2496 -> "Hermes" 1f0f; the stove door closed (1e37) -> Count Down 1f15 at zero ->
    Relay 26ae -> "Camera" 24e7 (8.9 s) -> "Door" 24ff; up the ladder 1ec7: Detector 1f2f ->
    **9 Lighthouse**. No logic shortcut (the forced Relay 26ae step is gone).
  - **8b, Jimmy**: freed, he talks and walks his escort (1752 -> 1753 -> 1758 -> 1759); in two
    runs the ravine's Burrower 16f5 and Slayer 16f4 (Detector 1793) killed him on 1759's legs
    (the harness, ahead in the ravine, could not kill the Burrower in 240 s), so 1ed5 played, as
    the level has it for a dead Jimmy. His scene 1eb1 by play is still to be seen.
  - The full chapter run stops at `8b.climb` (open: the clamber room after the collision trees);
    the 8b runs above went past that ledge by a teleport (logged).

- **8a** (`--level 8a --to 8b.exit`, run f1 of 2026-10-14, with rows 8-1, 8-2, 8-5): from the
  3a arrival to the arrival in **8b** on foot in 19 steps, no teleport and no logic shortcut. One
  death, in every run: the yard ambush (the CartWheelers 1bce / 1bd0, 17.5 a blade hit, and the
  Slayers' 3 a bullet) while the harness runs for the wagon; retried from the arrival checkpoint
  with invulnerability, kept on. "PaddyWagon" played (frame `*-8a.wagon`), the climb over it 94.66
  -> 98.35, checkpoints 1e08 / 1e0a, "Camera" 1d0e 45.5 s (`8a.truck-cine-*`), the creek on the
  water (player at 84.2 over the bed at 80.6) and up the rocks 84.19 -> 87.22 -> 89.72, the vision
  (Timer 1da8 fired), the first Slayer wave (Count Down 2c90) in 62 s, Detector 1b70 into 8b.
  Misses: the wagon spot reached 1.6 m short (the shot went in), a Slayer (1d4c) "stuck" on its
  waypoint at the creek bank.
- **8a, the ford** (`--level 8a --to 8a.cp2`, row 8-2 second fix, invulnerable): 13 of 14 steps
  (the known `8a.ambush` 1.8 m short); `8a.creek` to the west ledge (84.1), `8a.ford` jumped at
  (462.96, 543.31) onto the east ledge (84.7), `8a.ledge` to the rocks (84.2), up 84.19 -> 87.22
  -> 89.72, the far bank, checkpoint 1e0a. In the creek by hand: 0.32 m deep the surface at the
  ankles, 0.99 m at the waist, 1.74 m the eyes under it and no running, wading steps 2:339 /
  2:318 (p17 / p18), ripples; walked on to 2.1 m: drowned (clip 325, the death screen).
- **8b** (`--level 8b --to 8b.exit`, run f2, with rows 8-3, 8-4, 8-6, 8-7): 28 of 30 step records
  clean to the arrival in **9 Lighthouse** (the misses: a death and the Hermes wait), 1227 s to
  the valves; one death (the Fester 1b4d, 26 a
  blow, on the first ledge), retried with invulnerability. Checkpoints 25f8, 1898, 25fa; the
  crate 2598 moved on its diagonals into Detector 180a and shot: "Cavern Rubble", Jimmy freed
  (frame `*-8b.blast`); "Camera" 1ed5 48.3 s (`8b.hermes-cine-*`); the four valves end the gas by
  the logic (Count Down 1fa9 at zero, row 8-3); **one logged logic shortcut**: Relay 26ae sent On
  after 120 s at the stove (the Hermes stove fight, open below), then "Camera" 24e7 8.9 s,
  "Door" 24ff, the ladder 1ec7 and Detector 1f2f -> 9.
- fps 53..61 when the GPU was free (30 while other agents' runs shared it); 8a 544 draw calls at
  most (the yard), 8b 243. No console errors.

Shortcuts (logged): the deep link and kit; the transformation and change back (Q needs pointer
lock); Xombium bottles; the struggle reflex; the one logic message above.

Frames: `<shots>/f1/` and `<shots>/f2/` (one per key step, `*-cine-*` strips of the truck scene,
Hermes' room and its end).

### Open (by owning area)

- **8a yard on Medium (combat).** On the roof the CartWheelers flee but the Slayers (Cloner 274d,
  two at a time, and 2756 by the alley) shoot up at the player; a run died there before the wagon
  shot. The crate push needs latency to spare: under a loaded machine the pull overshot the guard
  house's line or the grab failed after a checkpoint restore.
- **8b first ledges (world, clamber room; after the collision trees).** Clamber Point 1802's box
  top is 98.75 but the ledge behind it is now the rock's collision box at 99.05: the room test's
  sphere (half the player shape's width, from top + r + (H - 2r) / 4) overlaps it by 2.5 cm with
  the port's 0.35 m radius and the clamber is refused ("Blocked"); `8b.climb` fails in every run
  since e170605. The player shape's width is not decoded (a 0.3 m radius would just pass). The
  exploration runs of 8b went past it by a teleport (not in the route).
- **8b Jimmy in the ravine (combat / route).** On WaypointBehavior 1759's legs the ravine's
  Burrower 16f5 and Slayer 16f4 (Detector 1793) kill him; the harness going ahead to clear the
  ravine (`8b.ravine`, an arena) did not kill the Burrower in 240 s. With him dead the level plays
  1ed5 as designed; "Camera" 1eb1 by play and the walkway Detector 26b5 are still to be seen.
- **8b fifth jet (world, Pushable).** The crate 1f8d stands on a table; pushed off it, it lands
  0.4 m into the floor and cannot be grabbed again. The route leaves that jet open (the picks then
  alternate between it and the stove).
- **Water (levels, other chapters).** Row 8-2 (second fix): water holds nobody up; the player
  drowns deeper than 2 m. Every route point of 4a, 4b, 5a, 6a, 6b, 8b, 9 and 10 was checked
  against the water: none lies in water deeper than 1.6 m (5a's Burrower fight 1.57 m, 6a's creek
  and pond 0.03..0.24 m); the planner now refuses water over 1.9 m.

## 9 Lighthouse (route `9.*`)

`node tools/playthrough.mjs --level 9 --to 9.exit --shots <dir> --cine-strip 4` starts in 8b and
fires its exit 1798 at once (logged): the player arrives at 9's Player Spawn Point ca5 in the
lighthouse base with the `chapter 9` kit (the chapter 8 kit, given in 8b). The route was read from
the level's message graph and checked in the browser [verified]:

- **Out of the base.** West out of the base: three Infernas circle the player and taunt, then
  ignite (Count Down c59, their Damaged / Died / ISeeYou). At zero Relay 174a -> Behavior Changer
  c5a: the guard bc9 (an Unspeakable NPC, the companion of this chapter and the next) comes from
  the gate to the south, talks (SimpleConversations dc6 / dc7) and starts his escort (WaypointBehavior
  dc8).
- **The escort.** Behind him north, then west into the burial ground (Detector c9e / e8e -> Relay
  c9f: Behavior Changers e1b / e22 / e29 wake three more Infernas, Count Down ddd), on west to the
  wrecked truck (Detector 173d -> Relay ddc; Count Down dde: three Infernas from the truck), and
  north-west into the generator yard, where the pit's CartWheelers come (Object Cloners 158a /
  1b62).
- **The searchlight.** The yard's gate is held by a fence; up the searchlight tower (Ladder 1378),
  mount the searchlight (Mountable 1376), turn it onto the fuel tank: Relay 13a8 lights the
  barrels' Fires 13a9..13ab and the fence burns away. Down the ladder; the generator Switch 1429
  (Relay 1744, Mechanism 186b, an Autosave).
- **East and back.** Out of the yard after the guard: STOMP "Inferna 1" bc2 wakes four Infernas
  (Count Down c9a: Object Generator c87, Relay e77). The guard's escorts dec (south, Waypoint def)
  and e00 (back to the lighthouse, Waypoint e02).
- **The lamp.** In the base, the door 15bf to the ladder room, Ladder 11 up, the stairs to the
  lamp machinery. The lamp's three wedges 1919 / 191a / 191b are shot (Count Down 1043 -> 1044
  Unlock on the crank) and the crank Pushable 9e1 pushed: its p55 output -> Relay 1027 turns the
  lamp (Mechanisms 9e6 / 9e5 / 9e7 / 9db), enables Detector cab and the lamp-room Ladder 9da. Up
  into the lamp room: the vision chosen by reputation (Reputation Points Message Filters; the
  bodies 131c.. removed by Relay 132c). Down again to the guard.
- **The gate.** His last escort to Waypoint e08 enables Level Transition ca6 (Relay 19e7);
  Detector cab plays "Horace" cad (he blows the gate) and posts the mail 10:1 (Level Transition
  Msg Handler 19ea). Through the gate: Detector ca7 -> Level Transition ca6 (10 Docks; it carries
  bc9).

New step kinds: `searchlight` (mount a Mountable, aim it at a point and hold until a condition),
`ladderDown` (climb down a ladder whose top the player stands at, then turn away from it),
`boss` and `finish` (10, below). Harness: GET `/abort` on the control server ends the running
step's loops; the Inferna fight keeps its distance from a burning Inferna while the player has a
gun. (`--npc-sphere-probe`, the workaround runs r2 / r4 / r5 used for the buried Infernas, is
gone: rows 9-12 / 9-13.)

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 9-1 | world (Object Generator) | The harness burnt to death in the first Inferna fight: every step of a burning Inferna left six fires. | The Infernas' footstep generator (NPC Material Effects 10:1845 -> Object Generator 3:2624) lists six Fire templates with pick mode p6 = 0; the port spawned every entry. | Decoded (0x100b5ed0): p6 0 one random entry, 1 the next in order (a counter), 2 all, other the first; the count is p1[i] when p1 lists counts, else p2, none below 1 (`fx.ts generatorPicks`). | fixed [verified], tests |
| 9-2 | fx (Fire) | Spawned fires burnt 6 s (a guess) and hurt anyone within a radius. | The Fire class's own lifetime was not read. | Decoded (update 0x100ac6e0, light 0x100acd00, touch 0x100ad320): p2 the burn time (0 = until put out), growth over p9 s, shrink over the last p10 s, removed at the end when p19 = 0; the footprint fire 3:3598 burns 2.5 s. Damage only while lit, when the player's posed hit spheres touch the fire model's bounds box (the model's type-7 record, `model-spheres.ts readModelBoundsBox`) [verified class; box contact inferred from the touch handler] (`effects.ts FireObj`). | fixed, tests |
| 9-3 | world (Mountable) | The searchlight 1376 could not be turned onto the fuel tank. | The port limited a Mountable to +-25 deg of turn and -p43..p42 of pitch around the current view. | Decoded (0x100183e0): +-p38 deg of turn from the placement, +-p42 deg of pitch (`interact.ts mountedAimLimits`; 1376: 50 / 55). | fixed [verified], test |
| 9-4 | world (Pushable) | The lamp crank 9e1 fell 33 m at load (it rests inside the hidden lamp machinery), so the lamp could not be turned. | The port ran gravity on every Pushable. | The Pushable class has no think of its own (vtable +0x18 is the empty 0x10128410): one nobody has grabbed never falls (`props.ts pushableMayFall`). | fixed [verified], test |
| 9-5 | world (Ladder) | Climbing down the lighthouse ladder 11 left the player over the stairwell, falling. | The port took the climbing face from the side the player stood on. | The face is the Ladder Interaction Properties side p3 (3 the local -z face, 1 +z; every retail ladder uses 2:427 / 2:428, p3 3) (`interact.ts ladderFaceSide`). | fixed [verified data; rule strong], test |
| 9-6 | weapons | A thrown explosive was credited to the player whoever threw it (found while reading what hurt the guard bc9). | The detonation passed the thrower object as the damage source; the damage service turns any source that is not a uid into the player. | The source is the thrower's uid (`weapons/system.ts thrownSource`). | fixed [verified code] |
| 9-7 | harness | Exploration evaluations that hung the page could not be stopped. | No way to end a running step. | GET `/abort`. | fixed (harness) |
| 9-8 | harness | The Inferna fights walked into the fires of a burning Inferna. | `fight` closed in for every target. | With a gun the harness keeps its distance from a burning Inferna. | fixed (harness) |
| 9-9 | harness | `9.door` failed with `to.map is not a function` when no stand by the door was free. | `__pt.standFor(uid, d, true)` returned a single point instead of a list when it found no free spot. | It returns a one-point list. | fixed (harness) |
| 9-10 | route | `9.generator` reported "no checkpoint taken". | The generator enables Detector 19a1, whose Autosave 199e is taken on the way east out of the yard. | The expectation moved to `9.east` (checkpoint 199e). | fixed (route) |
| 9-11 | harness | The harness's shotgun hit the guard bc9 (three pellets of 4) while he stood near the line of fire. | Its friendly-fire check spared an ally within 0.55 m of the view ray, not the pellets' spread. | The spared corridor widens with distance (0.55 m + 0.09 m per m). | fixed (harness) |
| 9-12 | world (collision) / actors (mover) | The burial ground's Infernas c9b / c9c / c9d stood 0.47..0.48 m "under the terrain" with the decoded centre ground probe: c9b / c9c never walked, Count Down ddd never reached zero and the guard's escort waited. | Four 12 m fog quads (Decoration 3:2181, model 3:440, texture 3:267, alpha blend) lie 0.42..0.48 m over the burial ground and were in the movers' collision: an Inferna's capsule (from 0.465 m) met a quad's edge as a wall or rested on it, its probe (from the foot radius, 0.4 m) under it; where the terrain rose under a quad, a body stood on it. | Decoded: a mover's query turns on only the classes of its collide list (character: 18 classes at 0x10178c40 via 0x1009ee20; player: 0x1002c340, 20 classes at 0x101509c0); neither names Decoration. Decorations' parts are `moveSolid: false` (`blockers.ts decorationUids`, `COLLISION_LAYER.decor`): sight and shots see them, movers (NPCs and the player) do not (docs/game-logic.md §14.9). | fixed [verified], tests |
| 9-13 | actors (mover) | bd5 (outside the base, Count Down c59) is placed 0.663 m under the terrain and walked held under it, "sinking -0.47". | The port's capsule rested on the terrain from below; the follower's Landscape fallback (0x100b6730 -> 0x100c0520: the Landscape under a point 2 m above the feet) was not modelled. c9c (0.196 m under) read as a drop-in with no ground and was hidden until woken. | With no walkable mover ground, the walkable Landscape under a point 2 m above the feet is the ground (`physics.ts landscapeGround`); `groundGap` takes a surface just above sunk feet with nothing under them as their floor. | fixed [verified probe; port limits inferred], tests |
| 9-14 | actors (companion) | The guard bc9 died in every whole-chapter run (r2 / r4 / r5) and with him the way out of 9. | Character p161 is health regained per second (0x100e1410, called every frame from 0x100e58d0; capped at the maximum by 0x100a2d00); every companion template has 4. The port had no regeneration (§15.10 said "none found"). | `actor.ts regenerate`, every frame for every character (docs/game-logic.md §15.10). No class rule reacts to a companion's death (no game over); 9's level logic has no exit without him [data]. | fixed [verified], test |
| 9-15 | world (collision) | The guard bc9 stalled at (297.3, 113.7, 244.2) by the burial ground from `9.escort3` on (run r1 of 2026-10-15): every escort leg failed there, Waypoint e08 was never reached and 9 could not be left. | The port collided with every drawn triangle; his capsule met the alpha-tested leaves of Static Object 884 (model 23:142) 1.2..4.4 m up. The original collides with the model's type-7 collision tree: 884 is one leaf box (2.2 x 5.9 x 14.5 m) north of his leg; 1844 of 1847 box trees in 9's packages list no faces at all. | Decoded the tree, which geometry movers and rays take from it, the classes and the AI sight flag (docs/game-logic.md §14.10): `formats/model-collision.ts`, `world/object-collision.ts`, `LevelData.collision`, dynamic bodies and crane loads from the tree; decals and draw occlusion on the drawn triangles. Runs r1 / r2 (2026-10-18): `9.escort3` and every escort after it passed. | fixed [verified], tests |
| 9-16 | route / world (collision) | With the collision trees (row 9-15) `9.crank` could not grab the crank 9e1 (runs r2 / r5: "could not grab" three times, the lamp never turned and the gate stayed shut). | The lamp housing 9dc (39:29) has a leaf box 2.8 x 4.3 x 2.6 m round the machinery; the view ray from the old stand (350.4, 216.25) to the crank met it first, and the port's use prompt takes the object looked at (docs/game-logic.md §14.5: the original lists what touches the player, no view ray). | The stand moved south of the housing box (350.6, 215.6): the grab takes, the crank moves 0.37 m and its p55 output turns the lamp (Detector cab enabled). | fixed (route), verified in the browser |
| 9-17 | route | After `9.ladder-down`, `9.base-door` sometimes ended on the floor above (118.1; runs r2 / r7, one in three in a session): the walk's first leg from the ladder's foot led into the ladder (its collision box now, row 9-15), which mounted it, and W climbed it. | The planner's path round the ladder box. | Step `9.ladder-off`: a straight route 1.5 m south-west off the foot first. Session: five of five clean. | fixed (route) |
| 9-18 | route | `9.horace` timed out in runs r7 / r9: "Horace" cad never played and the gate stayed shut. | Detector cab (filter 0, the player; an 18 x 1 m slab across the road at the gate, 3.2 m from Waypoint e08) plays it; `9.gate` follows the guard and can end 6 m north of the slab, and `9.horace` only waited. | Step `9.cab` walks into the slab first. Run r10: "Horace" played (36.7 s) and the exit to 10 followed. | fixed (route) |

### Results (Medium, headless Brave / WebGPU, 1280x720, a GPU shared with other agents' runs)

Every step of the route was played in the browser in an exploration session (deep link, kit, one
step at a time, captures after the truck, the yard, the generator, "Inferna 1", the escort south,
the lamp, the lamp room and the exit), from the arrival to Detector ca7 and the arrival in **10**
with the guard carried (row 10-1). Whole-chapter runs (`--level 9 --to 10.finish`, 2026-10-15):

- **r3** (no workaround): the burial ground's Infernas c9b / c9c stayed 0.48 m under the terrain
  and never moved ("stuck ... 1518 s"); Count Down ddd never reached zero, the escort waited and
  the run ground on (open, actors / mover). Stopped at `9.back`.
- **r2 / r4 / r5** (`--npc-sphere-probe`, logged): the arrival, the Infernas outside the base
  (c59), the meeting, the escorts north and into the burial ground, its Infernas (ddd), the truck
  (dde), the yard's CartWheelers, the searchlight tower (frame `*-9.searchlight-beam`: the barrels
  burn, the fence goes), the generator, "Inferna 1". One death each in the first fights on Medium
  (Inferna radius fire), retried invulnerable. In all three the guard bc9 died before the
  lighthouse (r2 and r4 in "Inferna 1", after three of the harness's shotgun pellets in r4: row
  9-11; r5 to a Burrower in the yard), and with him dead the run cannot leave 9 (open).
- **r7** (`--level 9 --save <capture after the guard's escort south> --from 9.back --to 10.ending`,
  the capture's fallen crank entry removed: it was taken before row 9-4, logged): 16 of 17 records
  clean to the arrival in **10** with the guard: back to the lighthouse, the ladder room, the
  wedges and the crank (the lamp turns), the lamp-room vision (the neutral one, 131f), down, the
  guard to the gate, "Horace" cad (36.7 s), Detector ca7 -> 10 Docks. The miss: `9.base` 3 m
  short of the arrival spot (the door 15c0), the next step opened it. Run r6 (the same capture
  with the fallen crank) could not grab the crank, so the lamp never turned and the gate stayed
  shut.

- **r1** (2026-10-15, `--level 9 --to 10.finish`, no workaround flags; rows 9-12..9-14): the
  arrival, `9.out`, the Infernas outside the base (c59, bd5 on the terrain), the meeting, the
  escorts north and into the burial ground, and its Infernas: Count Down ddd reached zero in 42 s
  (c9b / c9c walk now). One death on Medium in the burial-ground fight (Inferna fire), retried from
  the arrival invulnerable. On: the truck, the yard and its CartWheelers (not finished in 120 s,
  the next step went on), the searchlight, the generator, "Inferna 1" (c9a), the base, the ladder,
  the wedges, the crank, the lamp room's vision, down and out: all clean. **The guard lived through
  the whole chapter** (regeneration). But from `9.escort3` on he stood at (297.3, 113.7, 244.2) by
  the burial ground (Open: the foliage of 884), so `9.south`, `9.back` and `9.gate` timed out,
  Waypoint e08 was never reached, ca6 stayed disabled and the run could not leave 9.

### Open (by owning area)

- **Fixed since: Infernas buried at their placement** (rows 9-12 / 9-13: the fog quads were
  Decorations, which no mover collides with; bd5 is placed under the terrain and the follower's
  Landscape fallback lifts it) and **the guard's deaths** (row 9-14: companions regain p161 = 4
  health a second). No class rule reacts to a companion's death; 9's data has no way out without
  him (docs/game-logic.md §15.10).
- **Fixed since: the guard's escorts stalled at the burial ground** (row 9-15: objects collide
  with their collision trees, not their drawn triangles; docs/game-logic.md §14.10).
- **Combat.** The first Inferna fight (c59) killed the harness on Medium in r2, r3 and r4 (radius
  fire 11..18 a hit, three Infernas); retried invulnerable.

## 10 Docks (route `10.*`)

`--level 10` starts in 9 and fires its exit ca6 with the mail 10:1 (Level Transition Msg Handler
19ea) at once (logged), with the `chapter 9` kit. The guard bc9 arrives with the player only when
he was carried (a real 9 -> 10 transition, or a state restored with `--save`). The route [verified]:

- **The road.** The player arrives at Player Spawn Point 86d, the guard (his 10 copy 7b8) at the
  Companion Spawn Point 908 (Timer 1244 -> Behavior Changer 7b9: his escort 7ba; the mail makes
  Relay 1246 remove the start without him). Detector 94e -> "Inferna 1" a29: two Infernas (Count
  Down 90b), then his escort east along the road (Detector 7ec: Slayers, a Burrower; d31: Object
  Cloners dbe / dc5) to Waypoint 7cf -> Count Down 112c -> Relay 924: the Infernas 7da / 7dd
  ignite and the fires at both ends of the pipe yard are lit (Count Down 929).
- **The pipe yard.** Trapped between the fires: over the rail onto the pump housing (Clamber
  Point 110b) and down into the pump room, the crate 318 pushed west and south into Detector 32e
  (filter 3) and the two valves 357 / 35a (hidden Breakables) shot; Count Down 394 at zero ->
  Mechanism 32d raises the water, its arrival output (p56) -> Relay 92e: the fires out, Object
  Cloner cf8's Mainliners, the guard's escort north. Out by Clamber Point 38f.
- **The broken road.** Waypoint 934 -> Relay b5d: "StompTruck" c80 (a truck burns) and its
  Infernas (Count Down 1137); Timer 1132 enables Detectors a68 / 137a: "Camera" 883 and "Bus" 884
  (the bus falls across the gap, Clamber Point 13a0 enabled). Over the bus; Detector 62a: four
  Slayers. The guard's "Ernesto" scene (STOMP 1153) and his escort east to Waypoint 947: the
  burning gate, five Infernas (Count Down 1256) -> Behavior Changer 1255: his farewell and walk
  back (Waypoint 948, Timer 10dd: +20 reputation; Relay 10e2 removes him).
- **The dock.** North-east round the fire: Detector 13e1 -> Autosave d29; Detector b01 -> "Crane
  Arm" b00; Detector b20 -> "Camera" b7d (Killjoy), whose end opens the gate c2a. Through it
  Detector 121e -> Relay a87 sends Enable to the three Reputation Points Message Filters a86 /
  a88 / a89: only the relays of that reputation pass from here on (the ending is chosen here).
  Detector 83b -> Relay a8a -> Timer a8b -> Relay a47 -> the reputation's "Camera" (a6f / a70 /
  a71), whose end plays "Camera" 1084: the dark self a48 wakes with Object Cloner b32's
  Mainliners (Count Down 12b5). a48's death sends its p29 message (19) to Relay a49 (row 10-3);
  Count Down 12b5 -> Timer 12a5 enables Detectors b43 / 1419: standing in one as a human
  (Insanity Mode Message Filter b44, p1 1) and looking at Visiblity Message Filter b45 -> Relay
  12b1 -> a76: the reputation's next scene, then "Camera" 1083: the dark self a46 with Object
  Cloner b2d's CartWheelers (Count Down 12b7). The same again (Detectors b47 / 141a, filters b48 /
  b49 -> Relay 12b0 -> a7e): the last scene, "Camera" 1082 (34:38), which sends On to the Black
  One 822.
- **The Black Ones** (`specials/black-one.ts`, docs/game-logic.md §15.7.8): four bodies, one boss;
  one is up at a time, its shared heart (p62) is the only hit point, three stages. The last
  stage's death -> p76 Died -> Relay b25 (blur, slow time) -> Timer 12a8 (4 s) -> Timer 12c8 ->
  the one enabled ending relay b3d / b3c / b3b -> Movie Player b39 / b26 / b3a -> STOMP 108d ->
  the boat sequence 1089 / 108a / 108b (the Boat with the camera on its hardpoints, docs/levels.md §4.1) -> the
  reputation's picture (GUI Launcher 123b / 123e / 123f) -> Relay 1242 -> Timer 1241 (3 s) ->
  Relay 13b3 -> GUI Launcher 123c (p0 6: Game Finished; on Impossible the bonus movie 13b2 first)
  -> the front end's Game Finished screen (save the settings) and the credits.

**The endings [verified data, test].** Chosen once, at the gate (Detector 121e, again by Relay
a8a and Timer 13ac), by the player's reputation: above 70 good (a86: p1 70 < rep <= p2 999), -90
< rep <= 70 neutral (a88), -90 and below evil (a89: -999 < rep <= -90). Each filter enables its
own relays in front of the dock scenes (a72 / a7a / a82 .. a74 / a7c / a84), the movie (b3d /
b3c / b3b), the boat sequence (12aa / 12ab / 12ac) and the prefetches, and disables the others'
(Relays 120f / 1210 / 1211). The good / neutral / evil movies are b39 / b26 / b3a; the port's
`campaign.state.ending` names the same choice at Game Finished (`campaign/system.ts endingFor`
reads the three filters' bounds). In 9 the lamp-room vision uses the same three bounds (1323 /
1324 / 1325).

New step kinds: `boss` (aim at the heart of the Black One that is up, fire, drink Xombium below
40) and `finish` (wait for the front end's Game Finished screen, choose it, wait for the credits,
four frames). `--save <capture>` without `--level` restores the capture in a menu session (New
Game, then the capture; logged), so the front end's own screens follow the ending.

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| 10-1 | actors (companions) | The guard did not arrive in 10: the 10 copy 7b8 started without him (Timer 1243). | 9's Level Transition ca6 names no spawn; `applyCarry` only matched a Companion Spawn Point by its spawn name. | A point with the arrival's level and an empty spawn name takes a transition without a name (`companions.ts applyCarry`): 7b8 at 908 with bc9's health. | fixed [verified data], test |
| 10-2 | actors (manager) | 10's Infernas on the road never ignited; the guard's escort stalled at Count Down 90b. | Actors far from the player do not think; the Infernas fight the guard 30 m ahead. | Actors within 40 m of an awake ally (a non-hostile, non-scripted character) think too (`manager.ts`) [inferred: the original updates all awake actors; the port's sleep is a performance rule]. | fixed, verified in the browser |
| 10-3 | actors (death) | The dark self a48's death did not end the first dock wave (Relay a49 never passed). | a48 has no Died output (p28 0); its links take its p29 message. | Decoded (0x100e2620): a Character's death sends p28 as an output, then p29 as a message to its links (`system.ts onDeath`). | fixed [verified], test |
| 10-4 | harness | No step could fight the Black Ones or follow the ending to the credits. | | Step kinds `boss` and `finish`, `--save` in a menu session. | fixed (harness) |
| 10-5 | menu | After Game Finished (Save Settings) the credits never rolled: the screen stayed on Game Finished. | `finishGame` opened the credits as an in-game overlay, which refuses once the level is left (Game Finished leaves it first). | The credits are pushed over the main menu, which closing them returns to (`menu/flow.ts finishGame`). | fixed, verified in the browser |
| 10-6 | harness | The steps after the ending waited 120 s twice for "level systems" (the level is gone on the Game Finished screen); a `--save` restore in the menu session read 1a's world, so the first step saw a dead player. | | End screens skip the page re-injection and level probes; the restore waits for the capture's level. | fixed (harness) |
| 10-7 | harness | A death in 10 before its first Autosave sent the run back to 9's steps (`9.east`, the last step that expects a checkpoint): 9's ladder steps were walked in 10. | The retry took the last checkpoint step of the whole route. | The retry never goes back past the current level's first step. | fixed (harness) |
| 10-8 | harness | The boss step swung the shiv for minutes once the rounds ran out (316 / 431 "shots", the heart untouched), and the dock fights left the player in the sea. | No ammo rule; the planner treated the sea surface (it holds the player, row 8-2) as floor. | Out of rounds, the boss step takes the dock's ammo boxes; dock steps plan with `noWater` (the water surface is no floor) and `drop: 4`; `10.sea1` / `10.sea2` put a player knocked into the sea back on the dock (logged). | fixed (harness) |
| 10-9 | actors (Black Ones) / save | A capture taken after "Camera" 1082 restored the Black Ones asleep (run e5): the boss never woke. | 'actors.specials' had no state for them. | Decoded their save / load (vtable 0x10152d90 +0x34 / +0x30: attack, timers, flash, state, flags); `BlackOne.save / load` keeps each one's state, timers, pull / exclude and the fight (stage, heart, holder), resumed on the first frame (docs/game-logic.md §15.7.11). | fixed [verified layout], test |
| 10-10 | harness | `10.valves` failed in a run (#35a never broke), so `10.climb-out` and everything after failed too. | The step shot from a fixed spot; where the pushed crate 318 comes to rest varies with the push, and it (or the pipe 149 beside it) can stand on the line to the valve. The crate push and the valve (10 health, its Breakable) are fine: from a spot with a line the valves break and Count Down 394 reaches zero. | `break` checks the line of fire to each target first (`__pt.lineTo`: nothing before it, or its own body) and, blocked, walks to a nearby stand that has one (`__pt.lineStand`, rings out to 3 m; logged). | fixed (harness) |
| 10-11 | world (Object Grouper) / water | The pipe yard's rising water did not move: Water Volumes 11aa / 11ab are grouped with Mechanisms 32d / 341 (Groupers 11ac / 11ad), but only dynamic objects follow a group, and the water runtime's surfaces were fixed at load. | Grouper members were dynamic only by other rules; the water world was built once from the placements. | Every Object Grouper member is a dynamic object (Water Volume non-solid there); the grouped surfaces are bodies of the water world that follow their objects (`water.ts MovingWater`). Checked in the browser: both surfaces rise 98.387 -> 98.598 with the Mechanisms, then the fire 124c goes out. | fixed, tests |
| 10-10 | harness | The boss step held its fire at the holder for minutes (9 shots in 400 s with 24 rounds, run x1). | The Black Ones are not hostile characters (the special drives them), so `allyInFront` took the holder on the line of fire for an ally to spare. | Black Ones are never allies (`playthrough-page.js`). The good boss then fell in 31 s (14 shots). | fixed (harness) |
| 10-11 | harness | The dock fights spent the rounds the hearts need (e10, v2: out of rounds at the second stage, the dock's reachable ammo boxes too few). | Guns before blades in every fight. | `saveRounds` on the dock steps: their fights take the heaviest blade (the Fire Axe); guns only for a creature in the sea and for the hearts. | fixed (harness) |
| 10-12 | harness | The first wave's arena could time out silently with a Mainliner left (e17): Count Down 12b5 never reached 0, Timer 12a5 never enabled Detector b43, and the one-shot `look` at the vision filter missed. | An arena timeout without `force` was no problem; the vision was a single look. | An arena that times out is a problem; step kind `vision`: waits for the Detector to be enabled, keeps the player on the spot as a human (walks back when moved, changes back) and keeps looking until the scene plays. | fixed (harness) |
| 10-13 | harness | Knocked into the sea or carried off the dock mid-fight, the player stayed there for the rest of the arena (e10, e14, e15, e17: at (470, 90.1, 270); v3: at (515, 84.5, 260)), and a fight could walk him off the edge after a creature in the water. | The planner has no way back up; fights closed on any target. | `sea` [y, point] on the dock steps: a fight does not close on a creature below y (the arena shoots it from the edge instead), and a player below y, or stranded with no path back, is put back on the dock (logged). | fixed (harness) |
| 10-14 | harness | Every step on the Game Finished / credits screens waited 240 s for a "cinematic"; the bonus-movie check read a message sent to 13b2 as played (13b2 is not placed below Impossible). | The left level's player reads as disabled; Timer 1241 sends On to 13b2 whether it exists or not. | `cinematic()` is false on the end screens; `finish` checks each ending's objects (`endings`: movie, boat sequence, picture reached, none of the other endings') and the bonus movie by its own end output. `--reputation <n>` and `--expect-ending` (logged). | fixed (harness) |
| 10-15 | route | `10.climb-out` failed in run r12 (three presses, the player shut in the pump room) after passing in r10. | Clamber Point 38f's template 2:850 allows 3.5 m of height (p2) and its top is 4.4 m over the pump room floor: it can never take from inside. Only 110b (template 2:455, p2 4.5) does, and the old stand at x 260 passed its side test by centimetres. | The step stands at (260.8, 285.3) facing north: 110b takes. Checked in the browser. | fixed (route) |
| 10-16 | harness | Run r10: the Slayer fight past the bus followed a Slayer down into the gap (bed 84.5) and the player was stranded there for the rest of the run. | A fight closes on any target. | `10.slayers` carries `sea` (y 95): creatures below are shot from the edge, a stranded player is put back (logged). | fixed (harness) |

### Results (Medium, headless Brave / WebGPU, 1280x720, a GPU shared with other agents' runs)

- **r8** (the same start as 9's r7, into 10 by play with the guard carried): `10.arrive`,
  "Inferna 1" and its two Infernas (Count Down 90b). One death on the road on Medium (the Burrower
  db4, 9 a blow, at 40 health from the capture), retried from 10's start invulnerable (row 10-7);
  the guard 7b8 died on the road the second time. Then the pipe yard by play: its Infernas (929),
  over the rail into the pump room, the crate 318 into Detector 32e, the valves, back out by
  Clamber Point 38f, the water up and the fire out (124c), the Mainliners (1372). The run ended
  there: the arena's chase of a Mainliner left the player in the sea at (272, 90.1, 306) (open),
  and without the guard "StompTruck" (his Waypoint 934) does not start.
- **Exploration** (deep link from 9 with the guard): every step from `10.arrive` to `10.boss` by
  play, with captures after each (the guard's escorts, the pipe yard with the crate and valves,
  the bus, the Slayers, the burning gate and his farewell, Killjoy, the dock's two dark selves and
  visions, "Camera" 1082); the Black Ones beaten by gunfire on the holder's heart (three stages);
  the neutral ending's movie (34:1) and boat sequence "Camera#52" (108a), `__campaign.state.ending`
  "neutral" (reputation 20: his farewell's +20).
- **e9** (menu session, `--save` of the capture before "Camera" 1082, reputation 20, logged;
  `--invulnerable`: a death after a `--save` restore has no checkpoint of that level to go back
  to): `10.dark2`, `10.vision2` ("Camera" 1082, 18.9 s), `10.boss` beaten in 388 s (31 shots: 822
  41 heart hits, 7f4 6), then by the level logic Timer 12a8 -> the movie, STOMP 108d (10.3 s), the
  boat "Camera" (48.6 s), GUI Launcher 123e (the neutral picture), GUI Launcher 123c: "game
  finished: reputation 20 -> neutral ending (Medium)", the **Game Finished** screen (frame
  `10.finish-game-finished`), Save Settings, and the **credits** rolling over the main menu
  (`10.finish-credits-1..4`, row 10-5). 5 of 6 records clean (the miss: the probe's "822 sinking").
- **Good, neutral (Impossible) and evil endings by play** (menu session, `--save` of the capture
  before the gate (cap10-m, Medium), `--reputation` set and logged, `--invulnerable`; every step
  from `10.gate` to `10.finish`; reports and frames in the agent's scratch `endings/`):
  - **g3, reputation 100**: through the gate (filter a86 enables the good relays), both waves and
    visions, the boss in 31 s (14 shots: 7f4 12, 820 5, 822 20 heart hits), Movie Player **b39**
    (34:3; its end output to STOMP 108d and Archives Trigger 1310), boat sequence **1089**, picture
    **123b**, GUI Launcher 123c: "game finished: reputation 100 -> good ending (Medium)", Game
    Finished, Save Settings, the credits. None of the neutral / evil objects reached; 13b2 not
    played. 11 of 13 records clean (the probe's "822 sinking"; the old bonus check, row 10-14).
  - **n2, reputation 20, the capture's difficulty set to Impossible** (edited copy, logged): 13b2
    placed and Relay 13b3 absent; the boss in 49 s (21 shots), Movie Player **b26**, boat **108a**,
    picture **123e**, then the bonus movie **13b2** (34:5) from Timer 1241 and its end (15.5 s) ->
    Timer 13b6 -> 123c Game Finished, the credits.
  - **v4, reputation -100**: filter a89, both waves and visions, out of rounds at the boss (5 of
    10 ammo boxes in reach), beaten in 132 s (35 shots), Movie Player **b3a** (34:2), boat
    **108b**, picture **123f**, "game finished: reputation -100 -> evil ending (Medium)", Game
    Finished, the credits; the movie, boat and picture are in the frame strip `10.ending-f01..14`.
  - **Final full runs, unattended** (the same start, all fixes): **g4** (reputation 100) 12 of 13
    records clean, one sea put-back (logged), the boss in 72 shots, b39 / 1089 / 123b, the good
    ending's movie, boat and picture in the strip `10.ending-f01..17`, Game Finished, the credits;
    **v5** (reputation -100) 12 of 13, no put-back, the boss in 18 shots, b3a / 108b / 123f, Game
    Finished, the credits. The miss in both: the probe's "822 sinking". 13b2 not played (Medium).
  - Earlier attempts (e10 / e12..e17, v1..v3, n1) failed on the harness rows 10-10..10-13.
- fps 48..61 (the boss and the dock scenes 48..55 with other agents' runs on the GPU), at most 1258
  draw calls (the dock during the boss).

- **r2** (2026-10-15, `--level 10 --to 10.finish`, the guard carried from 9; rows 10-9..10-11;
  water now holds no one up, 7d1d93b): the arrival, "Inferna 1", the road (one death to the Burrower
  dbd on Medium, retried invulnerable), the pipe yard: over the rail, the crate into Detector 32e,
  both valves shot, the water raised (the surfaces 11aa / 11ab rise with Mechanisms 32d / 341; the
  fire 124c out), back out by Clamber Point 38f, the truck's Infernas. Not finished: the pipe
  yard's Infernas (929) and Mainliners (1372) arenas ran out; the guard's escort north was not
  followed; at the bus the clamber onto it (13a0) did not start with the player's feet at 90.1 in
  the gap, and from there every walk failed, the player ending on the sea bed (84.5, invulnerable)
  south of the burning gate. Stopped at `10.dark1`.
- **Black One save** (exploration, deep link): 822 activated (On), the heart hit to 50, captured
  (`/capture`), restored in a new session (`--save`): 822 up and holding the heart at 50, its
  retreat timers kept; it retreated, waited and handed over to 7f4, which taunted and fought
  (frame `boss-restored`). Before (run e5) the four restored asleep.

- **r14** (2026-10-22, `--level 9 --to 10.finish`, no workaround flags; the collision trees,
  docs/game-logic.md §14.10, rows 9-15..9-18, 10-15 / 10-16, 3-18): 67 of 81 steps, from the arrival
  in 9 to the credits by play. One death on Medium in the first Inferna fight (c59), retried
  invulnerable from the arrival checkpoint. The guard lived through 9: the burial ground, the
  escorts, the lamp (crank, vision), `9.cab` and "Horace" (36.7 s), the gate and 10 with him. In 10
  the bus clamber took (97.17 -> 99.50, `10.across` clean), the dock's two waves and visions, the
  Black Ones (39 shots), the neutral ending's movie, boat scene and picture, Game Finished and the
  credits. One logged put-back off the dock (row 10-13). The misses: arenas over time (the yard's
  CartWheelers, the pipe-yard Infernas, the Mainliners, the gate Infernas), the guard's later
  escorts in 10 (he fell behind or died on the road), `10.cp`'s autosave d29, `10.killjoy` 1.4 m
  short, and the probe's "822 sinking". Earlier runs of the same build: r4..r13 stopped on single
  failures fixed since (rows 9-16..9-18, 10-15, 10-16) or on a guard death in a fight (r11).

### Open (by owning area)

- **Actors (companion) and levels (sea).** The guard's 10 copy 7b8 died on the road in r8
  (Burrowers / Slayers of Detector 7ec), after which his waypoints (7cf, 934, 947) start nothing:
  the pipe yard has other ways in (Detector 3dc / Timer 112f to Count Down 112c), the broken road
  does not. The sea around the pipe yard and the dock (5.6 m) drowns the player (row 8-2, second fix);
  the dock is ringed by player clips 12f2..1302 [data]. Water Volume p1 (1 on the sea) is read by
  no code of Suffering.rfl.
- **Fixed since: Black One save state** (row 10-9). The level has no checkpoint after Autosave
  d29, so a real game never restores mid-boss; only a manual save does.
- **Harness / water: the bus gap.** The clamber itself works: in a session with the bus fallen
  (STOMP 884: the bus is Breakable 245, 23:171, whose collision tree is three boxes), `10.bus-climb`
  went 97.17 -> 99.50 and `10.across` passed. In the r2 run of 2026-10-15 the player was already on
  the 90.11 ledge in the gap when `10.bus` ended. "Camera" 883's hand-back moved him from
  (244, 176.4) to (237.96, 178.66) in the session, and the falling bus sweeps that strip of road on
  its way down; a body moved onto the player is the likely push, not confirmed. Once in the gap
  there is no way out (the sea holds no one up). See the 9 -> 10 results below.
- **Probe: 822 "sinking -0.33".** The Black One 822 reads 0.33 m under the dock while up; the
  bodies never move (§15.7.8), so this is the probe reading the model's root, not a fall
  [inferred].
- **Harness: the dock fights leave the dock.** In `10.dark1` the harness once ended 6 m up on the
  road by the gate (433, 97.7, 210) and the planner had no way back down (the dock is reached by a
  4 m drop): the dock steps now walk with `drop: 4`.
- **Harness: the dock fights.** A Mainliner's hold still carries the player off the dock now and
  then (to the sea at (449, 90.1, 236) or (515, 84.5, 260)): the runs put him back (row 10-13,
  logged). Whether the original's player clips 12f2..1302 keep him on the dock is the water /
  levels owner's.

## Reputation (all levels)

The reputation rules are decoded in docs/game-logic.md §13.2 "Reputation sources"
(`insanity/reputation.ts`, `tests/reputation.test.ts`). `npx tsx tools/reputation-census.ts
[game/app] [--level <id>] [--json]` lists, per level, every Reputation Points Sender with its
amount, the message that fires it, what sends it and where that chain starts (an NPC's p169
"killed by the player", a Waypoint's arrival, a STOMP output, a Switch, a Detector), the kill
rewards (p166 / Ambient Creature p26 / the attached Action Dialog's p22), the dialogs, the
Reputation Points Message Filters with what they gate, and the Part Caps. Census of the retail
data: 46 senders (each applied once: p0 1, no links), +455 / −318 in all; two characters with a
p166 of their own (1a's guard 609e, 1c's inmate 7569, −10 each); 11 Action Dialogs at −5; 74
Ambient Creatures at −2; Part Caps −2 per part cut from a corpse dead over 5 s; the filters of 1a,
1b, 2, 3a, 3b, 4b, 6a, 6b, 8b, 9 and 10 (the endings).

### Bugs found and fixed

| # | Area | Issue | Cause | Fix | Status |
|---|---|---|---|---|---|
| R-1 | actors (death) | Executions and companions' deaths cost no reputation: 2's 308b (−10), 3a's prisoners, 4a's 5b7b (−15), 8a's 281d, 9's three prisoners, 10's guard 7b8 (Timer 10d8 −10), 1b's CartWheelers 8b46 / 8b47 (−5 each) ... Also the Count Downs, relays and lines hung on the same outputs never ran. | A Character killed by the player fires its output p169 (0x100e75fa, after the kill reputation); the port never fired it. | `actors/system.ts`: p169 on a kill by the player (not by anyone else). | fixed [verified], browser: 1b 8b46 by the player -> 350 -> Sender 8b63, −5; 8b47 by a hazard: nothing |
| R-2 | actors / insanity | Hurting or killing a companion with an Action Dialog cost nothing (1a 609e, 1c 7569, 2's Dallas 868, 3a 95c, 5b 1295, 6b 49a, 8b 1738, 9 / 10's guard bc9 / 7b8). | Not decoded: the dialog counts the player's hits (p14 / p18 / p19) and pays p22 once, at the p18th counted hit or with the kill (0x1008e130, 0x1008d300). | `insanity/reputation.ts` rules; the director keeps each attached dialog's count (saved with 'actors.logic'); the kill adds p166 + the unpaid p22. | fixed [verified], test, browser: 1c 7569 — invulnerable in his cell: no count; hits at 106, 107, 110.3 and 113.6 s: the second too soon (p14 3 s), −5 on the fourth; the kill −10 (p166) and Timer 801a -> Sender 8098 −10: −25 in all |
| R-3 | insanity | A Reputation Points Sender with p0 0 would add nothing, one with p0 2 once. | p0 read as an enable flag; it is the target mode (0 sender, 1 player, 2 each link: once per target, 0x1008e510). | `senderApplications`. No retail sender is affected (all p0 1). | fixed [verified], test |
| R-4 | actors | An Ambient Creature (rat, crow) killed by the player costs 2 (p26, 0x100916f0); the port read p166, and built them as decorations that took no damage (1b 8218 kept its 1 health). | Not decoded: a PhysicalObject with p0 health 1, PhysicalObject damage / death (docs/game-logic.md §15.3 "Ambient Creature"). | `killReputation` reads p26; `system.ts ambientHit`: health, p15, p26 by the player's kill, the p18 break, p21, removed (saved); shots find them while shown. | fixed [verified], browser: 1b rat 8a05 shot with the revolver: blood, gone, reputation 0 -> −2 (strip-rat) |
| R-5 | actors (Ambient Creature) | Rats and crows played their sounds as clips and ran at the sound interval's numbers; the 66 placed with p22 = 0 were animated before anything started them. | p24 is the one animation, p25 the speed, p28 sounds every p29..p30 s (at most p31 at once), p22 0 = still until On (0x10091930, 0x10091070, 0x100910f0). | `manager.ts` builds them on p24; `director.ts` speed p25, sounds, p22. | fixed [verified], browser: On to 1b 8a09 / 8a07 / 8a06: 3.7 m in 1.2 s with the run loop; test |
| R-6 | actors (companions) | A player's first hit turned a companion on the player (`attackStartsFight` with an attached dialog, and a grudge on the player even when his team is an ally). | The dialog warns at each counted hit below p18 (AttackedByPlayer: face, p17 clip, p16 line, 0x1008d4a0) and at the p18th fires p30 to the level logic (0x1008dda0); KillEnemies never takes an ally team's player (0x100f9eb0). | `director.ts dialogWarn / dialogTurn`, `behaviors.ts attackStartsFight`, `actor.ts damage` (no grudge on an ally player). | fixed [verified], browser: 1c 7569 -> FleeBehavior 7ee0 at the third counted hit; 2's 868 -> FleeBehavior 1c7c; 6b's 49a no target until the turn, then HostilityBehavior 1576 on the player (strip-inmate / strip-dallas / strip-clem); tests |
| R-7 | actors | No dismemberment: placed bodies whole, heads and limbs never cut, and the corpse rule (−2 per part cut from a body dead over 5 s) unreachable. | Part Caps decoded (docs/game-logic.md §15.16). | `actors/dismember.ts` (rules, cut, bleed, created-cut bodies, save), `manager.ts` (blows on corpses), weapons / creature melee strike corpses with parts left. | fixed [verified rules; renderer side inferred], browser: 1a's 26 bodies created cut (78f3 armless at the elbow), a head shot on 7652, a claw on corpse 7b36 (−2) (strip-live / strip-corpse / strip-arm); tests |

Checked in the browser as well: 1b's Horace cell vision by reputation (−10: STOMP 89f3 "Horace#276",
filter 83b2; 0: 89f2, filter 83b3, frames `horace-evil` / `horace-good`), and Torque's skin by
reputation (`__repskin.state()` body suite 0 / 1 / 2 / 3 / 4 from −99999 / −90 / −30 / 30 / 90;
third-person frames at −100 and +100: the evil suite's grey, rotting skin and the good suite's
clean one).

### Open (by owning area)

- **Data: 10 Docks Switches 13a8 (−90) / 13aa (+200)** at (463, 94.3, 75): placed reputation
  switches, not on the route [placement not checked in the browser].
- **Actors: dismemberment leftovers** (docs/game-logic.md §15.16): decoded and ported: node flag
  0x10 (the renderer skips the cut segments' draw batches; the sphere tree skips cut bones), the
  bleed's readers (knockdown bleed-out; Dodge / ProjectileBlock / Mainliner evasion gates, whose
  behaviours the port lacks), the p3 regrowth on Killjoy's resurrection, Torque's Part Caps and
  his killer death clips (the Slayer's 2:562 CapLimb), p117 / p112 corpse gibs and throws, NPC
  blow hit points. Still open: which properties set the Character flags that forbid cuts (+0x6c &
  0x100, +0x70 & 0x80); damage type 7's users; the engine's batch building (the port groups
  triangles by segment). Browser frame strips not taken: the machine stayed at load ~200 and the
  harness could not bring a level up (see the agent report).
