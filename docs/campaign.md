# The Suffering: campaign flow (New Game to the ending)

Code: `src/game/campaign/` (campaign game system, difficulty, chapters, transition mailbox,
GUI Launcher glue, level graph). Tools: `npx tsx tools/campaign.ts` (prints the chain, the
mailbox and the difficulty census from the user's install), `node tools/campaign-test.mjs`
(headless browser harness). Tests: `tests/campaign.test.ts`. Confidence tags as in
`docs/game-logic.md`; addresses are `Suffering.rfl` (0x10…) or `SUFFERING.EXE` (0x4…/0x5…).

## 1. Level Transition [verified]

| Prop | Meaning |
|---|---|
| p0 | target level path (string) |
| p1 | target spawn names (string list; empty = the target picks its point by the level left) |
| p2 | template (null on every retail instance) |
| p3 | Chapter Properties (Interface pkg 5) the transition advances to (§3) |
| p6 | 1 = enabled at start (ctor 0x100c2e70 stores `p6 == 1`) |
| p7 | objects carried over (companions; see §7) |
| p10 | input: transition (message map 0x101787b8 → 0x100c2770) |
| p11 | input: enable (0x100c2430) |
| p12 | input: disable (0x1012eaa0) |

Four transitions start disabled (1c → 2, 2 → 1c, 9 → 10, 10 → 9); the level logic enables
the forward ones (1c: Relays 808c / 80b2 / 80db send Enable; 9: Relays 19e6 / 19e7). Port:
`src/game/world/logic.ts` (`initEntity`, `input`, `transition`).

**Spawn choice.** A Player Spawn Point has p0 "from level", p1 name, p2 active, p4 / p5
companion links. The arrival point is the one naming the level left and one of the target
spawn names; transitions without names arrive at the point naming the level left
(`src/game/world/world.ts`; the same rule is `resolveSpawn` in `src/game/campaign/graph.ts`).
All 37 transitions of the 18 levels resolve to exactly one point (36 exact; the unused test
level 7's exit has no named point in 1b).

### 1.1 The chain

The route is the chapter list: every hop is the one transition naming the next chapter of
User Interface Properties p83 in its p3. 20 hops, verified in the browser (§8):

| # | From | Transition | To | Spawn name | Arrival point | Chapter | Trigger |
|---|---|---|---|---|---|---|---|
| 1 | 0 Prelude Docks | 1172 | 1a | West Spawn | 894e | 5:585 | Behavior Changer / Timer |
| 2 | 1a | 79b4 | 1b | South Spawn | 79c0 | 5:587 | locked door → Timer → Relay |
| 3 | 1b | 79c3 | 1c | West Spawn | 79b6 | 5:590 | Timer / Relay |
| 4 | 1c | 7813 (off at start) | 2 Cellblocks | East Spawn | 11a6 | 5:593 | Timer / Relays (Enable first) |
| 5 | 2 | 11aa | 3a | NorthEast Spawn | 17e2 | 5:596 | Timer / Relay |
| 6 | 3a | 18dc | 3b | West Spawn | 17e2 | 5:599 | Timer / Relay |
| 7 | 3b | 19db | 3a | East Spawn | 18de | 5:622 | Detector |
| 8 | 3a | 18e3 | 4a Quarry | SouthWest Spawn | 6888 | 5:601 | Timer / Relay |
| 9 | 4a | 6cb1 | 4b | (none) | 6888 | 5:604 | Detector |
| 10 | 4b | 78b5 | 5a Asylum | East Spawn | 1683 | 5:607 | Detector |
| 11 | 5a | 167f | 5b | North Spawn | 1372 | 5:610 | Timer / Relay |
| 12 | 5b | 13c1 | 6a Woods | West Spawn | 1419 | 5:613 | Detector |
| 13 | 6a | 1a88 | 6b | NorthEast Spawn | 137c | 5:616 | Detector |
| 14 | 6b | d51 | 1b | North Spawn | 7ca3 | 5:619 | Detector |
| 15 | 1b | 8b7a | 1a | South Spawn | 79b5 | 5:625 | Timer / Relay |
| 16 | 1a | 7a13 | 3a | North Spawn | 366a | 5:628 | Detector (enabled via the mailbox, §2) |
| 17 | 3a | 2e93 | 8a Bluff | SouthEast Spawn | 1aa2 | 5:631 | Timer / Relay |
| 18 | 8a | 1d60 | 8b | (none) | 1795 | 5:634 | Detector |
| 19 | 8b | 1798 | 9 Lighthouse | (none) | ca5 | 5:637 | Detector |
| 20 | 9 | ca6 (off at start) | 10 Docks | (none) | 86d | 5:640 | Detector (Enable first) |

The other 17 transitions lead back (1b → 1a, 3a → 2, 4b → 4a, …) and carry no chapter.
New Game starts 1a (Main Menu p17); after finishing, the Prelude (p18; §5.3 of
`docs/frontend.md`, implemented by the menu flow).

## 2. Level Transition Msg Handler: the cross-level mailbox [verified]

Two properties; key = `p0 << 16 | p1`. By convention p0 names the level a message is for
(11 = 1a, 12 = 1b, 13 = 1c, 2 = Cellblocks, 31 = 3a, 10 = Docks) and p1 is a channel.

- **Receive** (vt[10] 0x101369b0): any message sent to a handler is stored in a global list
  under its key (an entry with the same key is replaced). The list is part of the game state
  (save 0x10136940 / load 0x10136cc0).
- **Deliver** (0x10136af0, called by the transition code at 0x100c2df1 after the new level
  loaded): every handler of the new level that has links and whose key is in the list re-sends
  the stored message to its links; the entry is removed. Only on arrival through a transition.

Retail pairs (sender → reader): 6b `1e55` 12:0 → 1b `8933` (return to prison: STOMP 8283,
Remover, Relay 7ca5) → 1b `7ca9` 11:0 → 1a `7a0c` (Relay 79e0: enables the exit Detector to 3a)
→ 1a `8660` 31:0 → 3a `3737` (13 relays: the yard on the second visit); 1c `80b0` 2:1 → 2 `3337`;
2 `3400` 13:1 → 1c `80ca`; 2 `333b` 31:2 (Map Pack pickup) → 3a `427d`; 3b `2f8a` 31:1 → 3a `42f3`;
9 `19ea` 10:1 → 10 `1245`. Port: `mailbox.ts`, delivered by `system.ts` on the first frame of
an arrival; saved in the 'campaign' provider (scope game).

Superseded: `docs/game-logic.md` §11.3 treated the handlers as "fire on any transition
arrival" (that enabled 1a's exit to 3a on the first 1b → 1a backtrack).

## 3. Chapters [verified]

User Interface Properties p83 lists 21 Chapter Properties (`p0` title string, `p1` Progress GUI
= loading screen, its `p18` Screen Background = the picture with the chapter title and quote).
Index 0 (5:579) is the Prelude's; 1a is index 1 (5:585) … 10 Docks index 20 (5:640). The engine
keeps the current chapter as an index (0x10178660):

- New Game sets −1 (0x10062274); a level starting with −1 takes its Level Properties p23.
- A Level Transition's p3 replaces it only when it comes later in the list (0x100bc5f0): the
  index never goes back when the player backtracks.
- The transition's loading screen is the current chapter's Progress GUI (0x100c2849).
- **No chapter title is shown on entering a chapter.** Chapter Properties p0 is read only by the
  Load / Save GUI for save names (0x1005f364); the loading picture carries the title.

Port: `chapters.ts`, `system.ts` (forward-only index, mirrored into `saves.session.chapter`).
`ctx.services.campaign.chapter` / `window.__campaign.state.chapter` gives the chapter whose
loading screen the next transition shows (`tiles`: the six Screen Background textures). The
menu flow's `travel()` still shows the default loading screen: hooking the chapter picture in
is front-end work.

## 4. Level Transition Remover [verified]

p0 level paths, p1 input (On). Calls the engine (`vt[0xfc](8)`), which deletes the stored
transition saves of those levels ("Deleted transition: %s"), so a later visit starts them
fresh. Port: deletes `saves.session.levels[path]` (`system.ts`).

## 5. Endings

### 5.1 Selection [verified from data; played in the browser]

10 Docks decides by reputation (`services.insanity.reputation`) through Reputation Points
Message Filters (pass when p1 < reputation ≤ p2): **good > 70, neutral −90 < r ≤ 70,
evil ≤ −90** (filters a86 / a88 / a89; 9 Lighthouse uses the same bounds for its boss).
Relay a87 (reached at the docks) sends Enable through the three filters, which enables only
that reputation's relays; every later reputation-specific step goes through those:

| | Good | Neutral | Evil |
|---|---|---|---|
| ending movie (Movie Player) | b39 → 34:3 | b26 → 34:1 | b3a → 34:2 |
| boat sequence (STOMP, after 34:39 "Camera") | 1089 → 34:44 | 108a → 34:52 | 108b → 34:53 |
| ending picture (GUI Launcher mode 5) | 123b → 34:162 | 123e → 34:163 | 123f → 34:164 |
| archive page (Archives Trigger) | 1310 (5:576) | 1314 (5:575) | 1315 (5:577) |

Chain: Timer 12c8 → enabled relay → Movie Player → STOMP 108d (34:39) + Timer → Archives
Trigger; 34:39's "Part2" track → Relay 12a9 → enabled relay → boat STOMP; its message keys
launch the picture (~35 s) and close it (~42 s); the closed launcher sends On (p7) to Relay
1242 → Timer 1241 (3 s) → Relay 13b3 → GUI Launcher 123c (**mode 6, Game Finished**).
On **Impossible** Relay 13b3 does not exist and Movie Player 13b2 (34:5, a bonus video) plays
first, then Timer 13b6 → 123c (instance difficulty masks, §6).

### 5.2 GUI Launcher [verified: ctor 0x10014ca0, map 0x10169588, modes 0x10014b78]

p0 mode: 0 / 1 message box (text p4), 2 Credits (UIP p15), 3 engine event 11, 4 alert box
p1 with text p4, 5 overlay template p3 (fades out on "close", 0x10069510), 6 Game Finished
(UIP p19). Inputs p5 launch, p6 close. When the screen closes the launcher sends p7 to its
links (0x10014d30). Port: `launcher.ts`; modes 0/1/4, 2 and 6 go to the front end through
`src/game/hud/ui-bridge.ts` (`alert`, `credits`, `gameFinished`), mode 5 is drawn by the
campaign (`PictureOverlay`: HUD Multi Texture p23 textures in p24 × p25 tiles, fade p27 s
[guess]). Archives Trigger (p4 input): unlocks p1 pages in `src/app/menu/profile.ts` and
shows p3 in the game message list.

### 5.3 Game Finished and credits [strong]

GUI Game Finished (#698) sets engine flag 0x400 in its constructor (New Game → Prelude).
Its update (0x10056300) is a small state machine: the unlock notice with Save Settings /
Don't Save Settings; Don't Save asks for confirmation (p21); then it opens **GUI Credits**
(UIP p15, 0x100563d9) and closes itself. So the original rolls the credits after the Game
Finished screen. The credits text is `.wdu` entry 2 of the Interface package (type 0x60:
20-byte header, then a UTF-16 tab-separated table with a header row and four columns that
use the four GUI Credits text styles p18), over video 5:32 with sound 5:72. The screens
are the menu flow's (`openGameFinished`, `CreditsScreen`); the campaign records the ending
(`campaign.ending`, from the reputation at Game Finished).

## 6. Difficulty [verified]

The menu stores d = 0 Easy, 1 Medium, 2 Hard, 3 Impossible (engine settings +0xd0). Uses:

1. **Placed objects.** A level instance is not created when its flags hold
   `(0x10000 << d) | 0x8` (EXE 0x45a63f; bit 0x8 = never). Port: `setPlacedObjectFilter`
   (`src/formats/entities.ts`, installed by `difficulty.ts`) and a loader provider that keeps
   those objects out of the static geometry. Retail use (Easy / Medium / Hard / Impossible):
   1a 2 / 2 / 7 / 7 objects removed (two CartWheelers only from Medium; extra Ammo Boxes and
   a Xombium only on Easy or up to Medium), 1b 4 / 0 / 4 / 4, 4b 2 / 0 / 0 / 0 (a Slayer and
   its cloner from Medium), 8b one Damage Action Object variant per difficulty (a damage
   volume at 3.5 / 5 / 7.5 / 10 per second), the Prelude one Health Threshold Trigger variant
   per difficulty (170 / 120 / 70 / 40, matching the player's scaled health), 10 Docks the
   bonus movie (Impossible only).
2. **Health.** GameObject health and max health = p0 / p1 × the Difficulty Modifier template
   in p2 (four floats; 0x100a2a90, 0x100a3174). Player 2:642: ×2 / 1 / 0.75 / 0.6 (200 … 60 HP);
   creatures 10:238: ×0.45 / 1.6 / 2.2 / 2.6; the final boss 10:1850: ×1 / 1.33 / 1.67 / 2.33.
   Objects without p2: ×1. The HUD meter is scaled back to the template health (0x10031657).
3. **Healing.** Health Bonus Item heals p55 × the modifier in its p56 (2:642; 0x100b6d1d).
4. **Flashlight.** The battery drains dt / Flashlight p70 modifier (4:1414: 2 / 1 / 0.85 /
   0.58; 0x1001460f).

Nothing else reads the difficulty: weapon damage, ammo amounts, enemy speed / accuracy and the
insanity meter are the same on every setting.

Port: `difficulty` (module) = `ctx.services.difficulty`: `level`, `healthScale(entity)`,
`playerMaxHealth()`, `healScale(item)`, `flashlightDrainScale()`, `excludeMask`. Call sites:
`src/game/actors/actor.ts` (actor health), `src/game/actors/combat.ts` (player health),
`src/game/world/world.ts` (Xombium heal); the flashlight battery has no drain yet in the port
(weapons / HUD: use `flashlightDrainScale()`). The difficulty comes from
`saves.session.difficulty` (New Game, loaded saves; `main.ts` sets it before a save's level
is parsed); `?difficulty=0..3` overrides it in the developer viewer.

## 7. Not done

- Companions carried through transitions (Level Transition p7, Player Spawn Point p4 / p5,
  Companion Spawn Point; 1c → 2 and 9 → 10 carry one) are placed by the actors system
  (`src/game/actors/companions.ts`, game-logic.md §15.10); a carry is not kept in saves.
- The chapter loading screen in the menu flow's `travel()` (data and API are here, §3).
- Level Transition p2 / p4 / p5 / p8 / p9 (constant on every retail instance).

## 8. Harness

`node tools/campaign-test.mjs` starts its own Vite server and a headless browser, walks the
20 hops (teleports to each transition's Detector and lets it fire, else fires the transition
through `services.campaign.fireTransition`, forcing the two that start disabled), and checks
each arrival (spawn point resolved by name + level left, the world system placed the player
within 0.5 m of it and the player is still within 4 m 2 s later, floor under the feet, no fall,
chapter index advanced), and records the mailbox traffic (it posts the mail a level's exit
Detector would post: 6b → 1b 12:0, 1c → 2 2:1, 9 → 10 10:1; 3b → 3a fires its own). Cinematics
are skipped before leaving a level, the player is invulnerable, and its Vite server runs
without file watching (edits elsewhere in the tree would reload the page). Then it loads 10 Docks per reputation
(120 / 0 / −120), runs the ending with cutscenes and movies skipped and checks the movie, the
boat sequence, the picture, the recorded ending, the Impossible bonus movie and that the Game
Finished launcher opened. Options: `--from/--to` (hops), `--difficulty`, `--endings`,
`--no-chain`, `--shots <dir>`, `--out report.json`.
