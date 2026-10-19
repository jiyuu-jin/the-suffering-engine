# Levels outside chapter 1: status, QA harness, level-specific classes

Chapter 1 (1a / 1b / 1c) is documented in `docs/game-logic.md`. This page covers the other 15
levels: 0 Prelude Docks, 2 Cellblocks, 3a / 3b YardCellBlock, 4a / 4b Quarry, 5a / 5b Asylum,
6a / 6b Woods, 7 ReturnToPrison, 8a / 8b Bluff, 9 Lighthouse and 10 Docks. Confidence tags
are the ones from `docs/game-logic.md` (**[verified]**, **[strong]**, **[inferred]**, **[guess]**).

Code: `src/game/levels/` (the levels game system, registered in `src/game/systems.ts` after the
sequence presenter), `tools/levelqa.ts` (QA harness).

## 1. QA harness (`tools/levelqa.ts`)

```
npx tsx tools/levelqa.ts                      every level outside chapter 1: static + browser
npx tsx tools/levelqa.ts --static             static checks only (no browser, ~25 s)
npx tsx tools/levelqa.ts --levels "0 prelude,10 docks"   substring filter on the .lvl path
npx tsx tools/levelqa.ts --all                also chapter 1
npx tsx tools/levelqa.ts --out <dir>          screenshots + levelqa.json (default $TMPDIR/levelqa)
npx tsx tools/levelqa.ts --doc                rewrite the status table below
npx tsx tools/levelqa.ts --reuse --doc        same, browser results from <out>/levelqa.json
npx tsx tools/levelqa.ts --url <dev server>   use a running server instead of its own
```

- **Static** (node): header packages that do not resolve, texture keys missing from every
  `.tdu`, placed classes not referenced by engine code (the `tools/coverage.ts` heuristic, per
  level; editor-only classes such as Static Object / Move Node Object / Directional and Ambient
  Light are not counted), spawn validity (a ray down from the Player object and every Player
  Spawn Point against the static geometry: drop to the ground, headroom), and every Level
  Transition: target `.lvl` resolves and the target has a Player Spawn Point with the requested
  name coming from this level (for transitions without spawn names: one whose `fromLevel` is
  this level).
- **Browser** (headless Brave / Chrome; `$SMOKE_BROWSER` overrides): its own Vite server with
  HMR and file watching off (edits elsewhere in the tree must not reload the page mid-level),
  `/?level=<path>`; console errors / exceptions (deduplicated with counts) and warnings,
  backend, a start screenshot, then every running cutscene is skipped and the gameplay start is
  judged: fps, draw calls, triangles, on-ground after 3 s and how far the player fell; a spawn
  screenshot and an overview from above (fog and zone culling off). Every CDP call times out
  after 30 s, so a stalled page is reported instead of hanging the run.
- Screenshots and `levelqa.json` go to `--out`, never into the repo (they show game assets).

## 2. Status

Status: **loads** = loads, no errors, the player starts on the ground, every transition
resolves; **issues** = loads with errors, a bad spawn or an unresolved transition; **broken** =
does not load. "Unreferenced classes" counts placements whose class name no engine code
mentions (an upper bound on what is missing; classes handled by name elsewhere drop out).

<!-- levelqa:begin -->
| Level | Title | Status | Entities | Missing tex | Spawn drop | On ground (fell) | Errors | fps / draws | Transitions | Unreferenced classes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 Prelude Docks | 0 Prelude Docks | loads | 946 | 0/179 | -0.03 m | yes (0 m) | 0 | 60.2 / 439 | 1a PrisonDeathRow | Crane 1 |
| 2 Cellblocks | 2 Cellblocks | loads | 5615 | 0/403 | 0 m | yes (0 m) | 0 | 60.1 / 822 | 1c PrisonDeathRow, 3a YardCellBlock | Portal 128, FollowBehavior 7, MainlinerJumpAttackBehavior 1, CeilingFloorTransitionBehavior 1 |
| 3a YardCellBlock | 3a YardCellBlock | loads | 4042 | 0/232 | -0.01 m | yes (0 m) | 0 | 60 / 1219 | 2 Cellblocks, 3b YardCellBlock, 4a Quarry, 3b YardCellBlock, 8a Bluff, 1a PrisonDeathRow | - |
| 3b YardCellBlock | 3b YardCellBlock | loads | 4260 | 0/362 | 0 m | yes (0 m) | 0 | 60.1 / 618 | 3a YardCellBlock, 3a YardCellBlock | - |
| 4a Quarry | Quarry East | loads | 2866 | 0/250 | 0 m | yes (0 m) | 0 | 59.9 / 719 | 4b Quarry, 3a YardCellBlock | - |
| 4b Quarry | Quarry West | loads | 2423 | 0/253 | 0 m | yes (0 m) | 0 | 60.1 / 1080 | 4a Quarry, 5a Asylum | - |
| 5a Asylum | 5a Asylum Backyard | loads | 1733 | 0/178 | 0.27 m | yes (0 m) | 0 | 59.3 / 356 | 5b Asylum, 4b Quarry | - |
| 5b Asylum | 5b Asylum Interior | loads | 3102 | 0/276 | 0 m | yes (0 m) | 0 | 60.2 / 988 | 5a Asylum, 6a Woods | Portal 62, KilljoyRootBehavior 2 |
| 6a Woods | The Woods | loads | 3309 | 0/243 | -0.02 m | yes (0 m) | 0 | 57.4 / 1505 | 6b Woods | - |
| 6b Woods | The Beach | loads | 1956 | 0/192 | 0 m | yes (0 m) | 0 | 60.2 / 726 | 1b PrisonDeathRow, 6a Woods | - |
| 7 ReturnToPrison | Return to Prison Test | loads | 151 | 0/61 | -0.01 m | yes (0 m) | 0 | 60 / 120 | 1b PrisonDeathRow | - |
| 8a Bluff | Bluff | loads | 2668 | 0/294 | -0.02 m | yes (0 m) | 0 | 60.1 / 805 | 8b Bluff, 3a YardCellBlock | Portal 7, Inferna 3 |
| 8b Bluff | Caves to Lighthouse | loads | 2734 | 0/256 | 0.06 m | yes (0 m) | 0 | 60.3 / 345 | 8a Bluff, 9 Lighthouse | Portal 70, Inferna 2 |
| 9 Lighthouse | Lighthouse | loads | 2367 | 0/310 | 0 m | yes (0 m) | 0 | 60 / 957 | 8b Bluff, 10 Docks | Inferna 20, Portal 15, FollowBehavior 1 |
| 10 Docks | 10 Docks | loads | 3228 | 0/335 | 0 m | yes (0 m) | 0 | 53.7 / 1915 | 9 Lighthouse | Inferna 16, Black One 4, Crane 1, Sky Properties 1 |
<!-- levelqa:end -->

### Before this work (first harness run, same machine, headless Brave, WebGPU)

| Level | Load | fps / draws | Errors | Missing tex | On ground | Unreferenced classes (top) |
|---|---|---|---|---|---|---|
| 0 Prelude Docks | 9.5 s | 30 / 75 (in the intro) | 0 | 0/179 | yes | Water Volume 79, Teleport Pad 4, Health Threshold Trigger 4, Crane, Camera Shake, Archives Trigger, Flying Sound, Attachment, EdgeToggler |
| 2 Cellblocks | 18.4 s | 30 / 1048 | 0 | 0/403 | yes | Portal 128, CartWheeler 49, Mainliner 45, Ambient Sound 24, FollowBehavior 7, ... |
| 3a YardCellBlock | 11.3 s | 30 / 619 | 0 | 0/232 | yes | Portal 78, CartWheeler 50, Volumetric Rain 22, Slayer 19, Ambient Sound 14, Aim Controller 11, ... |
| 3b YardCellBlock | 11.6 s | 30 / 518 | 0 | 0/362 | yes | Portal 113, CartWheeler 29, Mainliner 25, ... |
| 4a Quarry | 9.9 s | 30 / 413 | 0 | 0/250 | yes | Portal 25, Water Volume 25, CartWheeler 14, ..., Volumetric Rain 6, Inferna 4, Crane |
| 4b Quarry | 17.8 s | 30 / 845 | 0 | 0/253 | yes | Portal 22, Burrower 13, ..., Inferna 6, Crane 3 |
| 5a Asylum | 9.6 s | 30 / 267 | 0 | 0/178 | yes | Water Volume 8, Burrower 5, Volumetric Rain 4, ... |
| 5b Asylum | 15.3 s | 30 / 1040 | 0 | 0/276 | yes | Portal 62, Volumetric Rain 14, Killjoy 6, KilljoyRootBehavior 2, Water Volume, ... |
| 6a Woods | 20.1 s | 30 / 981 | 0 | 0/243 | yes | Burrower 22, Water Volume 11, Inferna 2, Inventory Add Remove, ... |
| 6b Woods | 11.6 s | 30 / 545 | 0 | 0/192 | yes | Water Volume 39, Fester 16, FollowBehavior, ... |
| 7 ReturnToPrison | 6.0 s | 30 / 91 | 0 | 0/61 | yes | Fester 2, Flying Sound, Ambient Sound |
| 8a Bluff | 9.9 s | 30 / 388 | 0 | 0/294 | yes | Slayer 53, Water Volume 26, CartWheeler 21, EdgeToggler 14, ... |
| 8b Bluff | 13.5 s | 30 / 451 | 0 | 0/256 | yes | Portal 70, Slayer 31, Water Volume 10, ... |
| 9 Lighthouse | 16.6 s | 30 / 629 | 0 | 0/310 | yes (the intro had moved the player 13.9 m up) | Water Volume 31, Inferna 20, ... |
| 10 Docks | 18.5 s | 18.5 / 300 | 0 | 0/335 | yes | Water Volume 97, Inferna 16, Black One 4, Volumetric Rain 4, Teleport Pad 4, Sky Properties, Crane, ... |

(fps was capped at 30 by the shared machine then; the first run measured inside running
intros because it did not skip cutscenes yet.)

All 15 levels already loaded in the dev viewer without console errors, with 0 missing textures
and every Level Transition resolving. What was wrong was invisible to that check: the Prelude
intro camera sat at the boat's origin looking at planks for 19 s, water was a solid floor
(the player walked on the sea), the 53 rain volumes, the four Health Threshold Triggers and
the Inventory Add Remove objects did nothing, every level started with the renderer's generic
near-black fog, and transitions without target spawn names (4a <-> 4b, 8a <-> 8b, 8b <-> 9,
9 <-> 10, 8a -> 3a, 7 -> 1b) arrived at the target's new-game start instead of the matching
spawn point (and not as an arrival: no Level Transition Msg Handler delivery).

## 3. Per-level notes

| Level | Notes |
|---|---|
| 0 Prelude Docks | Intro "Camera#1" (41.7 s): the camera rides PoliceBoat hardpoints 12 / 13 / 14 (§4.1); inmates / guards / Torque ride hardpoints 3..11 through the presenter's attach keys. 79 Water Volumes (sea, ~5.6 m deep). 4 Health Threshold Triggers on the Player (§4.4). 4 Teleport Pads (unused leftovers of 10 Docks' layout). Crane `11d` (the skinned jib on the static tower) is drawn by `skinned-props.ts` (§4.6). Sky: 7:2541 (horizon 0x251210 -> sky 0x362f46), fog 240 m. |
| 2 Cellblocks | Interior, played end to end from the 1c arrival by the playthrough route (`2.*` steps, docs/playthrough.md "2 Cellblocks"). The companion Dallas (the 1c inmate, 868) follows the player through a scripted chain of 25 Behavior Changers (talks, waypoints, FollowBehavior, KillEnemies); Mainliners (45, leap and ride), CartWheelers (49), Horace in a cage, Killjoy (projector), a camera scene in the cell block (1a61) and one in the south yard (2e01, 34 s), Witness / Hanging Prisoner / Mainliner / Dallas scenes; checkpoints 1c74, 334c (or 3361), 1c75, 334e, 3350; exit c0c -> 3a. The table's "unreferenced" column predates the actors work: FollowBehavior (game-logic §15.10), MainlinerJumpAttackBehavior (§15.7.4) and CeilingFloorTransitionBehavior (§15.7.5) are run by the actors system, Portal (engine class) by the visibility system. Fixed for it: message filters' p0 (destroy once passed, not "enabled": the inmate's Instance Message Filters were shut), the usable-object lock (barricade bed 18f1), Mechanism translation group and inputs, Object Grouper, hidden system-package Breakables (the ladder catch 18ce), the Mainliner ride's struggle input, NPC exclusion types on straight walks, one subtitle box, the clamber anchor along the ledge (the pit -> 3024 -> 80b climb to the exit floor), locked doors with Edge Passage p4 = 1 (the gunner 7f4 leaves his nest through be4), no movement collision for skinned Mountables, in-world sequences with flag 0x40 but no Camera track ("Mainliner" 847), a dead speaker's Speech Player lines. The gate c36 opens from the lever 1356 (Dallas's or the player's). Open: the inmate rarely survives the steam-pipe yard and the middle block (docs/playthrough.md). |
| 3a / 3b YardCellBlock | Outdoor yard in the rain: 22 + 2 Volumetric Rain (the camera-following one is switched by Ambient Sound zones). 3a is the campaign hub (6 transitions). Inventory Add Remove x2 (notes). **Played end to end** on the first visit by the playthrough routes (`3a.*` from the 2 arrival, the 3b excursion `3b.*`, back to 3a and out to 4a; docs/playthrough.md "3 YardCellBlock"). Fixed for it: KillEnemies p3 level-object targets (the Slayer that shoots the yard fence), Fires as dynamic objects (one baked into the fence gap was solid), Mountable p23 (an eye-ray test, not "usable at all"), searchlights (`world/searchlight.ts`: lit / dark, Fire toggles, beam on Detectors with filter 4), ladders picked from the top, a WaypointBehavior ending when its MoveTo fails (the west yard's wall CartWheelers leap the fence). Portal is handled by the visibility system (the "unreferenced" column now counts class ids). Open: the searchlight's own Spot Light is not in the light rig and its lit state is not saved; the shotgun's Breakable 1b53 has no model and cannot be shot down; a few creatures stuck or sinking (docs/playthrough.md). |
| 4a / 4b Quarry | 25 Water Volumes (ponds 1.3..7.5 m) in 4a; 6 rain volumes in 4a. 4a <-> 4b transitions carry no spawn names (fixed, §4.7). **Played end to end** from the 3a arrival to the 5a transition by the playthrough routes (`4a.*`, `4b.*`; docs/playthrough.md "4 Quarry"). Cranes (1 in 4a, 3 in 4b) are run from their decoded class code (§4.6): the hoist, the boulder hung on the hook, Detector filter 5 and the crane controls (Mountables whose p30 names a Crane). 4b needs them: the boulder dropped into the inmates' pit ("Boulder" 7ef0) bridges the ditch on the way, and the second crane frees Pedro ("Pedro" 7e6d, +15 reputation). The Infernas of both levels are scripted walk-bys (WaypointBehaviors whose last Waypoint destroys them, p0 = 12) and two figures in the 4b ending scene; Inferna is run by `actors/specials/inferna.ts` (§5, docs/game-logic.md §15.7.6). The third crane's pallet, lowered and swung to the end of its slew, is the way onto 4b's ending platform: two running jumps (§4.6). |
| 5a / 5b Asylum | 5a backyard: water, storm rain (500 drops, 20 m/s). 5b interior: 13 small rain volumes under roof holes (3:1009 unit box), Killjoy x6 (+ KilljoyRootBehavior x2: §5). **Played end to end** from the 4b arrival to the 6a transition by the playthrough routes (`5a.*`, `5b.*`; docs/playthrough.md "5 Asylum"). 5a: the garden wall's rotated Clamber Points, Carmen's vision and Burrowers, the courtyard fight, the crate pulled off the front door (Detector filter 3 by shape). 5b: three projectors before the theatre (Count Down 12ab), the basement, attic and west-wing puzzles (crates, rope hoist, chain, caged projector), Killjoy's theatre (five projectors; KilljoyRootBehavior / KilljoyRaiseDeadBehavior decoded, docs/game-logic.md §15.7.8), the Rebirth beam and grenade, the window leap. Fixed for it: modelless Clamber Point rotation, blend-7 (glass) surfaces collide, Burrowers are not ceiling hangers, Pushables touch Detectors by their box, moving Mechanisms keep their place, Animating Statics with health and a p21 output break, GameObject p5 (immune to unlisted damage types). Open: RaiseDead does not restore body parts; Autosave 2abf never fires (its input is Off, its Relay sends On) [data]. |
| 6a / 6b Woods | Streams (11) and the Beach surf (39, mostly 1.5 m deep: wading). 6b -> 1b is the "return to prison" (chapter 5:619): Detector 1e54 posts 12:0 to Level Transition Msg Handler 1e55, Detector d50 fires d51 ("North Spawn", the 1b sewer). The campaign does not use level 7.  **Played end to end** by the playthrough routes, from the 5b arrival to the 1b arrival (`6a.*`, `6b.*`; docs/playthrough.md "6 Woods"). The unreferenced classes of the first table are run now: Inferna (6a's two maze Infernas are a scripted walk-by that vanishes at Waypoints 2162 / 2163) and FollowBehavior (Clem's end of chain, 138f). Fixed for it: a Switch with no model is used by its anchor (6a's truck jack a08, the way across the creek), NPC thrown weapons with the decoded ballistic aim (Clem, the stranger: molotovs 10:1863), a KillEnemies that a Behavior Changer handed out completes when its search finds no target (the stranger's chain), and an object target's own collision no longer hides it. Sky 0x15151a / 0x161618 with 40..45 m fog [data]. Open: the black triangles of Killjoy's projected figure in the phone vision, Clem dying to the Festers' rats, a Slayer stuck under a log (docs/playthrough.md). |
| 7 ReturnToPrison | "Return to Prison Test": an unused 151-object test map. No chapter files and no `_level.ldu`: its packages all come from the `.lvl` header (World Common / Common), so it loads with the median-grey unlit colour. Its one transition goes to 1b without a spawn name; 1b has a nameless Player Spawn Point from level 7, which the empty-name fix (§4.7) now picks. Nothing in the campaign leads here. It is a cut-down copy of 6b's way out with the same uids [verified data]: the rock (Clamber Point 6b4), Detector 1481 -> Level Transition Msg Handler 1482 (12:0), Detector d50 -> Level Transition d51; its 1b spawn 82da sits 0.7 m from 6b's 7ca3, so it tests the return to prison. Clem's scene (STOMP 6b8 behind Detector 6b7, enabled only through Waypoint a49 / Relay 139e) and the Fester cloner a54 (no input) never start; the Player object's 22 start pickups float 10 m over the beach. **Played end to end** by the route `7.*` into the chapter 7 revisits `r1b.*` / `r1a.*` (docs/playthrough.md "7 Return to Prison"). |
| 8a / 8b Bluff | Sea cliffs: 26 + 10 Water Volumes (3.4 / 5.5 m). Slayer 53 + 31 (actors system). All transitions without spawn names (fixed, §4.7). **Played end to end** from the 3a revisit's exit to the arrival in 9 Lighthouse by the playthrough routes (`8a.*`, `8b.*`; docs/playthrough.md "8 Bluff"). 8a: the paddy wagon's engine box 1b80 (a hidden system-package hit target) is shot to send the wagon through the yard gate ("PaddyWagon" 1b7c), over the wagon, the truck scene ("Camera" 1d0e, 45 s), the creek crossed at its south ford and along the east bank's water-level ledge to the rocks (§4.2: water holds nobody up, deeper than 2 m drowns) and up Clamber Points 25b1 / 2a3e, the vision of the hanged men (Screen Fader 1dac) and the Slayer waves, the cave mouth (Detector 1b70). 8b: up two ledges, the telephone room through the hole in its floor, the store room's barricade 1d5e and its horde, Jimmy's stove room (the explosive crate 2598 pushed into Detector 180a and shot: "Cavern Rubble"), east and up Ladder d05, Hermes' gas room ("Camera" 1ed5), the four gas valves (their Mechanisms' arrival output p58, `props.ts mechArrivalOutput`), the stove fight, the hatch (Detector 1f2f). Fixed for them: hidden hit targets are never see-through (shots reach 1b80), Mechanism arrival outputs p55..p58, the character output p31 ("ISeeYou"). Open: what passes Relay 1f0d (Triggered) in the Hermes stove fight; the yard ambush kills the harness on Medium; Jimmy (1738, carried to 9 by Level Transition 1798) dies before the end (docs/playthrough.md). |
| 9 Lighthouse | 31 Water Volumes, Inferna x20 (§5), Companion Spawn Point. Played by the playthrough route `9.*` (docs/playthrough.md "9 Lighthouse") from the 8b arrival to 10: the Infernas outside the base, the guard bc9's escorts (the burial ground, the truck, the generator yard), the searchlight 1376 turned onto the fuel tank (the barrels burn the fence away), the generator Switch 1429, the lighthouse lamp (three wedges shot, the crank Pushable 9e1 pushed, the lamp-room vision chosen by reputation), the guard's "Horace" scene at the gate and Level Transition ca6 (it carries him to 10). Fixed for it: Object Generator pick modes, the Fire class's lifetime and contact, Mountable aim limits from the placement, Pushables nobody moved never fall, the ladder's climbing face from Ladder Interaction Properties p3, thrown explosives credited to their thrower. Fixed for it later: movers pass Decorations (the burial ground's fog quads), the ground follower's Landscape fallback (Infernas placed under the terrain), companion regeneration (Character p161). Open: the guard's escorts stall at the foliage of Static Object 884 by the burial ground (docs/playthrough.md); with the guard dead nothing enables ca6 [data]. |
| 10 Docks | Finale: 97 Water Volumes, Black One x4 boss pillars + 4 Teleport Pads (§5), Inferna x16, endings "Camera#44 / #52 / #53" ride the Boat (a skinned Light Housing, 34:82) with the camera on its hardpoints 5 / 7 / 10 (§4.1), Crane Arm / Re-Birth Machine sequence. Sky Properties placed once (a Fog / Sky Switcher target). Played by the route `10.*` (docs/playthrough.md "10 Docks") to the end of the game: the guard's escorts along the road, the pipe yard (the crate into Detector 32e, the valves shot, the water raised), the bus across the gap, the burning gate, Killjoy, the dock (the two dark selves, the visions by Detectors b43 / b47 as a human looking at filters b45 / b49), the Black Ones, the reputation's movie / boat sequence / picture, Game Finished and the credits. The ending is chosen at the gate (Detector 121e -> Relay a87 enables the Reputation Points Message Filters a86 / a88 / a89: above 70 good, -90..70 neutral, -90 and below evil). Fixed for it: the companion carried by a transition without spawn names, actors near an awake ally think, the Character death message p29, the credits after Game Finished. |

## 4. Classes and special cases implemented here (`src/game/levels/`)

### 4.1 Camera riding a carrier hardpoint (`carrier-camera.ts`) [strong]

STOMP attach keys can hang the **Camera** track on a hardpoint of a skinned carrier. The Prelude
intro does it for its three opening shots (0.03 / 9.32 / 14.72 s, hardpoints 12 / 13 / 14 of
the PoliceBoat, model 55:1); the 10 Docks endings do it with the Boat (hardpoints 5, 7, 10).
While attached, the engine places the attached object in the bone's frame with no offset
(EXE 0x450c10, §7.1 of game-logic.md), and the boat clips (55:2..55:5) animate those bones —
in shot 1 the camera bone stays on the water while the boat passes it, in shots 2 and 3 it
rides the deck. The Camera track's own transform keys only take over after it is detached
(19.10 s). The sequence presenter poses the camera from the keys; the levels system runs after
it in the same frame and replaces the pose with the bone's world matrix (camera model space =
bone frame; verified by screenshots: the identity orientation shows the seated inmates and
guards, the 90 / 180 / 270 degree alternatives look at the hull or the sky).

Checked in the browser: 10 Docks "Camera#44" (started with its STOMP Player `1089`) shows the
boat deck, Bart at the helm and the boat leaving the dock from hardpoints 5 / 7 / 10.

### 4.2 Water Volume (`water.ts`) [verified data and code]

327 placed (10 levels). Each places a flat water-surface model (7:565.., 25:111.., 28:194,
34:31..) with a layered water material (7:836..7:840: base texture + additive layers 7:393 /
7:394). Four bool properties: p1 = 1 on every sea volume (Prelude, Docks, Beach, Bluff,
Lighthouse, one in 5b) and 0 on ponds / streams; p0, p2 always 0; p3 unknown. No code of
Suffering.rfl reads p0..p3: the factory (0x10020451) makes a 12-byte data holder with the default
virtuals (vtable 0x1014e5c0) [verified]; what p1 is for was not found [unknown]. Suffering.rfl
tests "is a Water Volume" by class id in the bullet impact routine (0x100d1687), the
BouncingObject touch code (0x1009a956: water is not a bounce), the player's and the characters'
contact loops (0x1002cee9, 0x101150fe) and a scene trace that turns Detectors and Water Volumes
off (0x100c9548).

**Water holds nobody up** [verified]. The player queries the scene twice a frame (Player
per-frame 0x1002cb50). Before the movement-proxy query (0x1002cca1) the class filter
0x1002c340(1) sets the "collide" bit (a real contact needed in the narrow phase) for the 20
classes at 0x101509c0, Water Volume among them, and the touch-only bit for Detectors. In the
contact loop a contact whose object is a Water Volume goes to his water-effects component
(+0x66: 0x1002cefb -> 0x1013b330) and the loop moves straight to the next contact (jmp
0x1002d1b0). Every other contact is dispatched through the listener (+0x3c / +0x44) to both
objects' touch virtual; the Player's (vt+0x24 = 0x1002bde0) hands contacts with the 20 classes to
the EXE mover (proxy vt+0x18 = 0x41ee40), which is how they block. A water contact never gets
there. Characters do the same (0x10115070: water -> the component, out; only then the mover
component 0x1009f480 with the collide list 0x10178c40, which also lists Water Volume): they sink,
and 10 Docks kills Ground Enemies on its sea bed (Detector 130c, filter 1 -> Damage Action Object
130b, 666; y 84.5..87.5 over a bed at 84.47 under a surface at 90.06). The earlier reading (the
class in the filter list = a floor, commit b220869) was wrong.

**The water-effects component** (vtable 0x10150c28 on the Player, 0x10150c4c on Characters;
owner properties p19..p24, the Player adds p25..p31; Player 2:5 values in brackets) [verified]:

| Rule | Code |
|---|---|
| In water: a water contact whose surface (a ray from 100 m above the owner down the water model, 0x1013ab60) is above the feet; depth = surface - feet. No water contact in a frame clears it, the depth and the timer. The proxy (Player p91 = Collider 2:44: foot sphere r 0.6, top 2.239 m) must cross the surface. | 0x1013b330, 0x1002d321 |
| Entering: the water Material Effects entry's p19 (4:1305, an Object Generator with the splash sounds 2:129..132) at the surface, scale max(1, min(p24 [1], abs(v) p22 [0.4] (1 + p23 [10] %)^depth)) - always 1 for the Player | 0x1013aea0 |
| Per frame: shallower than p21 [0.5 m] while running, nothing; else a timer: running, every p19 [0.03 s] the entry's p16 (4:1288, the wake); otherwise every (1 + rand) p20 [0.5 s] its p15 (4:1294, ripples); at the surface | 0x1013b050, running = Player +0x98 bit 31 (0x10031cd0) |
| Footsteps: shallower than p21 the step is the water surface's own (the entry's p1..p13 at the surface); deeper only the sound p17 (2:337..341, to p25 [1.5 m]) or p18 (2:318..321, deeper) at the feet | 0x10042cd0, 0x10120be0 |
| Deeper than p25: no running | 0x10046230 |
| Deeper than p28 [2 m]: drowned - damage of the maximum health (vt+0x8c, so nothing while invulnerable), the death clip p29 (System clip 325, 3.5 s) instead of the collapse 164, the view pitch eased to p31 [15 deg] at p31 / p30 [0.5 s] deg/s | 0x10120a50 (every frame), 0x1002e5c3 |
| In water deeper than p21: the BurnFX attachments get vt+0x30 (put out [inferred]); shallower their +0x1c is cleared [not traced]; not ported | 0x10043a30 -> 0x10043950 |
| A landing in water: fall damage x (1 - p27 [10] %)^depth | 0x1002dbc4 (docs/re/player.md §5.3) |

There is no swim state and no underwater rendering (no such string or renderer path)
[inferred]. With the eyes at 1.6 m, water between 1.6 and 2 m covers the view without drowning.

**Where the levels need it.** 8a's creek is 3..3.5 m deep everywhere: it is crossed at its
south ford, not through the water. Both banks carry ledges at the water level (84.0..84.74) under
their overhangs; at z 540 they are 2 m apart over the channel (a jump; Detector 2b2c, filter
Player, spans the ford at the water level and moves Waypoints 2b24 / 2b2a's Slayers). The east
ledge runs dry north under the overhang to the rocks at (480..497, 581..617), where Clamber
Points 19f8 / 19fa and 25b1 / 2a3e climb the far bank. 10 Docks' player clips 12f2..1302 (2:624,
9 x 9 x 3 m) are not a ring round the dock: they stand two by two in front of the four Black Ones
(822 west, 7f4 east, 820 / 821 in the middle), Timer 1224 turns all eight Off 0.1 s after the
start, each Black One's appear / vanish messages (p77 Enable / p78 Disable) turn its two On / Off
through Relays 12f6..12fd, and its death message (19) turns 12f2..12f5 On (Relay 12fe) [data].
So nothing stops a player walking off the dock's ends before the boss, as in the original; a
player in the sea (5.6 m) drowns.

Port: the surfaces stay in the merged static geometry but not in its collision
(`nonSolidObjectProviders` in `src/app/loader.ts` -> `LevelExtras.nonSolidUids` ->
`MeshPart.solid = false`): everyone, sight, shots and the use ray pass them. `WaterRuntime` runs
the Player's component from his template (`readPlayerWaterRules`): the contact is a vertical ray
at his position [port: the original tests the proxy's spheres]; entry splash, ripples and wake,
`PlayerController.canRun`, drowning (`services.combat.damagePlayer(max)`, `PlayerBody.drowning()`
for clip 325, the pitch ease); footsteps read the thresholds from `waterSurfaces.wade`
(`fx/footsteps.ts`), fall damage the depth from `services.water.player` (`fx/system.ts`).
`services.water.player` = { inWater, depth, underwater, drowned }. Grouped surfaces move: an
Object Grouper's members follow its first link (`props.ts moveGrouped`), so they are dynamic
objects (`dynamic.ts dynamicObjectUids`; Water Volume is non-solid there too), and the water
world holds them as bodies that follow them (`water.ts MovingWater`, `groupedWaterUids`). 10's
pipe-yard surfaces 11aa / 11ab ride Mechanisms 32d / 341 (Groupers 11ac / 11ad) and rise 0.211 m
(p25) when the valves are shot and the crate is in Detector 32e; 5b's 3280 rides 2d44.
Before, merged into the static level, they stayed put. NPCs keep the surface
footsteps only (their component's other rules are not ported).

Surface look: the water materials (e.g. 7:1582: base 7:744, additive 7:393 glint, additive
7:394 caustics twice) are drawn with the decoded texture matrix (game-logic.md §16 "Texture
coordinates"): the 7:393 layer is a world-space reflection lookup (mode 1, input 3, scale 2,
V offset 0.5), not a position projection, which removes the dotted pattern the 1 m tiling made;
the caustic layers scroll with World Common waveforms 7:33 / 7:36 / 7:41 / 7:51.

Wading [port of the per-surface tables]: a point under a water surface reports the water's
Material Type (2:879, from the water material's Game Material Properties) at the water level
(`fx/surfaces.ts waterSurfaces`), so footsteps of the player (shallower than 0.5 m) and of NPCs
pick their "Player / NPC Water Material Effects" entry: splash steps 2:15..2:19 and the splash
generator 4:1312 at the surface.

### 4.3 Volumetric Rain (`rain.ts`) [data verified, meanings inferred]

53 placed. Model 3:400 = a 12 m cube (x / z -6..6, y 0..12; 3:1009 = unit cube) scaled by the
instance = the volume. p0 streak texture 3:313, p1 colour (0x505050 / 0x727272), p2 drops,
p6 streak length, p11 fall speed (7.5 / 20 m/s), p12 speed variation, p13 on at start, p14 the
volume follows the camera (the yard-wide rain; Ambient Sound zones send it Off / On through their
p21 / p22 links when the player goes in / out), p15 / p16 On / Off input messages (instances that
start off swap them), p17 Destroy [guess], p18..p20 fall direction (wind slant). Not read: p3 p4
p5 p7 p8 p9 p10 p21..p23 (p3 = 1, p5 = 20, p21..p23 = 0 / 10 / 10 may be splash settings).
Port: additive line streaks per volume, CPU-simulated, wrapping in the volume (around the camera
for p14). Each drop stops at the first solid surface on its fall path (one ray along the fall
direction per drop and fall), so rain no longer falls through roofs, awnings or ceilings inside
a fixed volume; where it stops a small additive ring grows and fades over 0.22 s. Drops of the
camera-following volume whose start point has a surface within 30 m above it fall hidden (rain
does not appear indoors even where no Ambient Sound zone switches it off). Fixed volumes more than
70 m from the camera are not simulated. The streak texture 3:313 is still not used [port].

### 4.4 Small logic classes (`logic.ts`)

- **Health Threshold Trigger** [verified: Suffering.rfl vtable 0x1014c620, handler
  0x10015019] — on every health change of the linked object (the Prelude's Player links to all
  four, they link back): previous health and new health on different sides of p0 -> fire p3 if
  p1 = 0 and the new health is below p0 (p1 = 1: above); p2 = destroy itself after firing.
  The previous health starts at 0, so thresholds above the starting health (170 / 120 with the
  Medium health of 100) never fire. Port: polled per frame on `services.combat`.
- **Inventory Add Remove** [inferred from all 4 instances] — p1 input applies, p2 input
  Destroy; p0 = 1 removes the p4 item templates (each instance hangs off an "Urgent Note /
  Tickertape" pickup and removes the previous note), 0 adds them [guess, unused].
- **Attachment** (Prelude "Hat!!") — p2 On / p3 Off: visibility; the STOMP attach keys move it.
- **Teleport Pad** — no properties; markers linked one-to-one from the Black Ones (§5).

### 4.5 Level atmosphere (`atmosphere.ts`) [verified link, verified fog, inferred names]

Level Properties p10 is every level's initial **Sky Properties** (the class Fog / Sky Switchers
blend to). Sky Properties: p2 fog distance (35..90 m, 240 in the Prelude), p3 fog start
fraction, p4 horizon / fog colour, p5 sky colour, p6 / p7 the sky dome's horizon band and
gradient (§4.8), p8 a float, p9 its Sky / Sun layers. The levels system sets the linear fog
(end p2, start p3 × p2) and the far plane at level start; the fog colour is p4 moved towards p5
by p8 (0.4 in three templates, else 0) [verified: Suffering.rfl 0x1012ad70, the sky writer].

### 4.6 Skinned scenery (`skinned-props.ts`)

Placed, visible (flag 0x80) skinned Light Housings / Breakables / Static Objects that are not
STOMP tracks fell between every renderer (static geometry, dynamic.ts and the presenter all
skip them). They are shown at their placement in the bind pose and follow the level logic's
visibility. Chapter 1's are left to its owners.

**Cranes** (class `0xf67a582e` "Crane", PhysicalObject family, 55 properties): Prelude `11d`
(Outdoor Common 23:649), 4b `7a26` / `7a2f` / `7a37` (23:630) and the 4a one: an 18 m tower
with a 17 m jib on a 5-bone rig (anim set 140); in the Prelude the skinned part is the jib on a
static tower. Every placement has instance flags 0x1, never 0x80, so the flag-0x80 rule of the
three renderers (and of the presenter for STOMP tracks) hid them. Port: drawn whatever their
flags, posed with p41 (p41..p43 name the same pose clip of set 140: 23:57 / 23:58) [inferred],
and moved by the STOMP transform keys the world system reports for objects nothing else renders
(`onStompTransform`); their STOMP attach keys hang the cab (Breakable 23:933, 4b 7a24 / 7a2e /
7a36) on hardpoint 1 through the presenter.

The hoist and the controls are decoded from the class code (`crane.ts`, Suffering.rfl: vtable
0x1014c478, init 0x10012270, update 0x10012730, control 0x10012b90 on the interface at +0xc,
input clamp 0x100125d0, motor sounds 0x100122e0, save / load 0x10012110 / 0x100120d0) [verified
unless marked]:

- The cable runs from bone p26 to bone p27. Its posed length L (9.6 m on 23:630) is the unit:
  min p28 / L, max p29 / L, start p30 / L (4b: 1 / 2 / 1 m, 4a: 5 m). Bone p26 gets a uniform
  scale of the ratio and p27 its inverse (0x10012180), so the cable stretches and the hook keeps
  its size.
- One object of each p36 template hangs on the bone of the same index in p35: the boulder
  23:856 on bone 3. Its p31 / p32 speeds (2.5 down, 1.5 up m/s, over L) move the ratio to the
  target; stopping replays the pose clip p41; the motor plays p44 / p45 (loop) / p46.
- Inputs p37 Increment / p38 Decrement both call the control with hoist -1: the hook goes up to
  the minimum. Crane's map has no parent, so Destroy / BlowUp do nothing.
- A Mountable whose p30 names a Crane drives it (Mountable init 0x10017730 sets the crane flag
  0x80 in +0x46; aim 0x100183e0). The look input splits in two: horizontal turns the crane's bone
  p22 (1) about +Y at the Mountable's p40 deg/s, within +-p38 deg (4b: 8 / 25, 10 / 35, 8 / 33),
  p36 inverting it; vertical is the hoist: up raises the hook to p28, down lowers it to p29 or to
  what lies under bone p39 (a sweep of radius p40). Only the larger input counts (0x100125d0).
  The camera rides the Crane's p24 hardpoint instead of the Mountable's p45 (0x100182f3): -1 on
  every 4b crane, so the player keeps his own view [port: turned to the crane, inferred].
- Detector filter 5 is "Crane": the Detector asks the crane for the object on bone p39 and tests
  that object's collision against its volume (0x100a7e40 -> 0x100121c0). The port samples the
  hung boulder's box on a 3 x 3 x 3 grid (logic.ts occupants, `WorldHooks.cranes`). 4b: 7da5
  ("Boulder"), 7e6e ("Pedro"), 78af ("WaterTower", also reached by shooting its base 78ad once
  the ending scene takes its invulnerability off).

- **Collision.** The Crane's model is skinned (23:630) and has no type-7 collision record, so
  the tower and the jib block nothing [verified on the data]. The hung objects are ordinary
  engine objects: the update creates each one from its template through the object manager
  (`[0x1017bf68]` vt +4 = EXE 0x45a0e0, called at 0x10012951), attaches it to its bone (the
  rig's engine object vt +0x18) and activates it (engine object vt +0x140 = 0x457550, which sets
  +0xc bit 0x40000 on it and its attachments). Nothing sets the no-collision bit (+8 0x400000),
  and the collision gather (0x425a80) takes every shown object with a collision model (+0x64)
  without that bit [verified]. The "Crane Palette" Breakable 23:856 (the name its track has in
  the "Crane" sequences) has the static model 23:580 with a type-7 record, so it blocks and
  bears the player like any placed prop [strong: the gather's per-class mover table was not
  read for this pair]. Port: one dynamic body per hung object from its model's triangles
  (`COLLISION_LAYER.solid`), rebuilt when the bone moves it, off while the crane is hidden.
  When lowering, the control first asks the rig for the object on bone p39 and its bounds
  (0x10012e40) before its sweep. The port's ray therefore starts under the hung object, with the
  crane's own bodies left out of the query [strong].
- **Saves.** The Crane writes its current and target ratios (+0x28 / +0x2c, save 0x10012110 /
  load 0x100120d0). The slew belongs to the driving Mountable: its yaw matrix +0xce, and the
  pitch matrix +0xf2, are part of its own save (load 0x10018fc0) [verified]. The port keeps
  both for each crane (save key `cranes`).
- **4b: the way onto the ending platform.** The pallet on Crane 7a2f is the bridge from the
  crane platform (controls 7c1d) to the ending platform across the 12 m gap between them. Two
  details of the data point to this [verified on the data, the reading inferred]. First, p29 =
  4.1 m lowers the pallet's top to the platforms' height: 105.07 at its rim and 105.3 in the
  middle, against 105.1 for both decks. Second, the slew's end at -35 deg (Mountable p38) hangs
  it 1.9 m off the ending platform's edge, as the +35 deg end puts it in Pedro's Detector 7e6e.
  The edges facing the gap are wooden stubs with tilted player clips (8463 / 834e on the crane
  side, rising to 105.9 at the lip; 8464 / 8465 on the ending side). The ending scene's Detector
  682d is a 20 m line across the platform that a player coming off the pallet's side crosses.
  From the lip a running first-person jump (4.7 m) lands on the pallet and a second one reaches
  the ending platform (checked in the port with the original's jump values: p215 10, p214 24.4,
  run 6.64 m/s).

Port: `levels/crane.ts` (CraneHoist), `skinned-props.ts` (rig, slew, hung objects and their
collision, detector points, saves), `world/interact.ts` (mounting crane controls), tests
`tests/crane.test.ts`.

### 4.7 Generic fixes

- **Transitions without spawn names** (`src/game/world/logic.ts`, `world.ts`, `src/app/main.ts`):
  a Level Transition with an empty `targetSpawnNames` list now requests the level with spawn
  name `''` instead of `undefined`; the target treats `''` as an arrival (Level Transition Msg
  Handlers, the save system's transition entry) and picks the Player Spawn Point whose
  `fromLevel` is the level left. 10 of the 30 transitions outside chapter 1 have no names.
  Checked in the browser: 4a's transition `6cb1` arrives at 4b's spawn from 4a (357.0, 87.4,
  716.1) as a transition (checkpoint "level transition"), not at 4b's new-game start.
- **Non-solid static parts** (`src/formats/level.ts` `nonSolidUids`, `src/formats/types.ts`
  `MeshPart.solid`, `src/app/physics.ts`, `src/app/loader.ts` `nonSolidObjectProviders`).

### 4.8 Sky dome (`sky.ts`) [writer verified, dome mapping inferred]

The dome is the Sky / Sun layer with p6 = 1 (World Common 7:1, a 5-unit sphere around the
camera; 10 Docks places two, and the second used to show the placeholder texture as white
panels across the sky). Its texture is a placeholder: the engine rewrites it from the Sky Properties
(Suffering.rfl 0x1012ad70): round(p6 × 448) texels of p4, then p7 × 448 texels blending p4 to
p5, then p5 up to texel 448 (all p4 when p4 = p5), and a second run of p4 halfway through the
texture. So p4 is the horizon (and fog) colour and p5 the sky colour. Port: the strip runs from
the horizon (0) to the zenith (1) by height on the dome, below the horizon p4; colours are
gamma bytes. A Fog / Sky Switcher's On (p3) blends the dome to its Sky Properties (p0) over p2
s, like the fog. lights.ts keeps the Sky / Sun objects centred on the camera and skips its old
night gradient while `SKY_DOME.levels` (atmosphere.ts) is set. Not decoded: where in the
texture the strip lies and the dome's V mapping (upper hemisphere V 0..0.09, lower 0.5..0.6,
varying with azimuth).

## 5. Specs for the actors / enemies owners (not implemented here)

Now implemented and decoded from the class code in docs/game-logic.md §15.7
(`src/game/actors/specials`): Inferna (§15.7.6), Black One (§15.7.11: the guesses below about
its properties and Teleport Pads were partly wrong - the pads are where the player lands),
KilljoyRootBehavior (§15.7.8), CeilingFloorTransitionBehavior (§15.7.5) and
MainlinerJumpAttackBehavior (§15.7.4). The notes below are the original data survey.

- **Inferna** (`0xec6354a8`, Character, 201 properties; 53 placed: 4a 4, 4b 6, 6a 2, 8a 3,
  8b 2, 9 20, 10 16). Same Character slots as §15.1 of game-logic.md; health 20, team 10:234
  (Nooseman / Slayer), p68 DormantBehavior 10:824, p69 HostilityBehavior 10:855, p76 the same,
  p82 KillEnemiesBehavior 10:849 (enemies 2:384 player, 10:120 guards, 10:212 prisoners),
  p86 KillProjectileBehavior 10:1500, p88 ProjectileAttackBehavior 10:1501 (fireballs: Attack
  10:1499), p91 10:42, p92 MovementAnimBehavior 10:826, p93 MoveToBehavior 10:830, p73
  FallBehavior 10:828, p49 NPC Material Effects 10:1845, p7 Damage Resistance 2:632 (type 5 =
  fire: immune). Own behaviour classes (none placed): InfernaAshBehavior,
  InfernaCircleTargetBehavior, InfernaFlamingKillBehavior, InfernaKillObjectBehavior,
  InfernaStartFlamingBehavior, plus Inferna Ash Attachments. Today the actors system runs it
  generically ("not in the class registry"); 9 Lighthouse "Inferna 1#19" / 10 Docks
  "Inferna1#20" are STOMP introductions.
- **Black One** (`0xffaeb496`, Ground Object, PhysicalObject family, 79 properties; 4 in 10
  Docks, skinned model 10:156 (99 bones), instance scale 0.8, flag 0x80 clear so nothing draws
  it today). Health 60 with Difficulty Modifier 10:1850 (1 / 1.33 / 1.67 / 2.33). Own slots:
  p22 [37 34 31 16] and p23 four Melee Weapon templates (10:1761 x3, 10:1760) — bones / weapons
  per limb [guess]; p25 / p26 bone list and Object Generators (3:3295.. FX); p46 a Black One
  template (10:1699), p47 IdleBehavior 10:907, p48 / p49 Object Generators (appear / vanish FX
  [guess]), p50 Part Cap 10:906, p54 Black One Attack templates (10:1847: clip 10:924, range
  6, arc -90..90), p60 / p61 Object Generators, p62 Breakable 10:1563 (remains), p64 colour
  0xff0000. Outputs p76 Died, p77 Enable, p78 Disable go to its Teleport Pad and relays; inputs
  On (Relay a85 -> #822) and Disable (Relay c7c -> all). Each Black One links exactly one Teleport
  Pad: it teleports between / guards those pads [guess].
- **FollowBehavior** (8 properties; 2 Cellblocks 7, 6b 1, 9 1) — an escorted / following NPC;
  it is what Companion Spawn Point (one property) receives across a Level Transition (2 and 9
  have both). Decoded and run by the actors system: game-logic.md §15.10.
- **KilljoyRootBehavior** (5b x2), **CeilingFloorTransitionBehavior** (2 x1),
  **MainlinerJumpAttackBehavior** (2 x1): root behaviours of the new creatures (decoded since:
  docs/game-logic.md §15.7).

## 6. Remaining issues

- Water: no water fog for NPCs, bullets do not stop at the surface (the engine flags water
  hits); the roles of the player water entry's p15..p19 are guessed; NPCs get splash steps but
  no in / out splashes.
- Rain: line streaks without the 3:313 texture; the splash look is the port's.
- Sky: the dome strip's placement in the texture is inferred (§4.8).
- Materials: mode-4 input 1 drops the object-origin translation, p13 (modes 7..9) is not
  applied, additive effects assume a 0.1 gamma destination (game-logic.md §16).
- Shadows stay off (docs/frontend.md): three r186's WebGPU backend destroys buffers that the
  shadow pass still submits when skinned casters come and go. Not retried here (no safe test
  window on the shared machine). Likely workaround to try: defer `dispose()` of skinned
  casters' geometry / skeleton by two frames (after the queue has run the frame's shadow pass)
  and turn a light's shadow off by skipping its shadow-map update instead of clearing
  `castShadow`.
- Skinned props: cranes run from their class code (§4.6), with their hung objects' collision and
  saves (the Black Ones are drawn and run by `actors/specials/black-one.ts`).
  The visible skinned Light Housings / Breakables that are not STOMP tracks (23:170 in
  8a / 10, 25:4 in 7, 9:3117 in 3b, 34:86 in the Prelude) are drawn by `skinned-props.ts` in
  their bind pose, without breaking or light switching (the 6a / 6b ones carry instance flag
  0x8 and are never created — campaign/difficulty.ts).
- Level 7 is not reachable in the campaign; it is a test map of 6b's exit and plays through to 1b (docs/playthrough.md "7 Return to Prison").
