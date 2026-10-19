# The Suffering: front-end (menus, loading screens, HUD) reference

This document describes how the retail game defines its user interface: boot movies, title and
main menu, difficulty selection, pause menu, options pages, loading screens and the HUD. The code
is `src/formats/gui.ts` (decoder and typed model) and `tools/gui.ts` (CLI and layout renderer).

Confidence tags follow `docs/game-logic.md`: **[verified]** (checked in data and class code),
**[strong]** (consistent data plus partial code evidence), **[guess]**. Addresses are virtual
addresses in `Suffering.rfl` (image base 0x10000000) where the behaviour was read.

---

## 1. Where the front end is defined

The UI is **data driven**. Nothing about layout, labels, videos or sounds is hard-coded in
`SUFFERING.EXE`. **[verified]**

- Every screen and widget is an **object template** (`.odu` type 2) in
  `COMMON/Interface/Interface.odu` (package id 5). Its class is one of the GUI classes in
  `Suffering.rfl`, category 18 "GUI" or 15 "HUD", for example "Main Menu", "Simple Text GUI",
  "HUD Texture" or "Screen Background". The class table is in `entity-classes.ts`.
- The single root is the **User Interface Properties** template (class `0xa3165141`,
  Interface.odu **#1**). The RFL looks it up by class in the package
  `/Common/Interface/Interface` (0x100bbe50) and reads it through one accessor (0x100bbf70).
  Its 84 properties name the default font, the boot movies, every screen, the UI sounds, the
  confirmation strings and the loading screens (§3).
- The C++ classes add only behaviour: which property is which button, and what activating it
  does. That mapping was read from the class code and is encoded in `gui.ts` as property-index
  tables (`readMainMenu`, `readPauseMenu`, `readOptionsMenu`, `PAGE_SPECS`).
- Labels are `.xdu` **string refs**. Pictures are `.tdu` textures, mostly atlases. Videos are
  `.vdu`, and their soundtracks are separate `.sdu` sounds. Fonts are `.fdu`. All of these are
  in package 5 unless noted.
- GUI templates are never placed in levels. Two level-side classes refer to them:
  - **GUI Launcher** (category System) opens UI screens from the level message graph (§11).
  - **Level Transition** `p3` names the loading screen (§9).

Census of Interface.odu (558 templates): 241 Simple Text GUI, 49 HUD Texture, 33 Archive Page,
31 Help Popup, 29 Screen Background, 28 Progress GUI, 25 HUD Meter, 21 Chapter Properties,
16 Simple Radio GUI, 10 HUD Ammo Meter, plus one template each for most screen classes.

## 2. Widget model

### 2.1 Base properties 0–14 (every GUI class) [verified: 0x1004ecb0, 0x1004ee30, 0x1004f190, 0x1004f9f0]

| Prop | Type | Meaning |
|---|---|---|
| 0 | enum | Horizontal anchor: 0 screen (absolute), 1 start (offset from the parent's left), 2 centre in the parent (x is an offset), 3 end (right-aligned in the parent) |
| 1 | f32 | x, **percent of screen width** |
| 2 | enum | Vertical anchor, same values, relative to the parent's top |
| 3 | f32 | y, percent of screen height |
| 4, 5 | f32 | Width and height, percent of the **screen**, not of the parent. 0,0,100,100 means full screen. |
| 6 | bool | Copied to a member; meaning unknown (always 1) |
| 7 | bool | Sets an engine flag; always 1. Probably "enabled" [guess]. |
| 8, 9, 10 | colour | Background panel colour for state Normal, Disabled (3) and Focused (5) |
| 11 | texture | Optional background texture, stretched over the rect |
| 12 | f32 | Background **transparency %**. The panel is drawn only when this is below 99.9, with alpha (1 − p12/100) × the widget's opacity. 100 = no panel; pause menu 15 = 85 % black dim; in-game options 20; alert boxes 0 (opaque) |
| 13 | template | Optional "GUI Border" (Interface.odu #148: 9-slice from texture 5:222) |
| 14 | f32 | Always 1; meaning unknown |

Pixel rect (`resolveRect`): `w = screenW·p4/100` and `x0 = screenW·p1/100`, likewise for the
height. The anchor then places the rect inside the parent's rect:

- 0: `x = x0`
- 1: `x = parent.x + x0`
- 2: `x = parent.x + (parent.w − w)/2 + x0`
- 3: `x = parent.x + parent.w − w + x0`

Top-level screens are full screen, so for their children "parent" means the screen.

**Virtual resolution.** Positions are resolution independent. Text and glyph pixel sizes are
authored for **640×480**: at UI init the engine stores `screenW/640` and `screenH/480` as the
glyph scale (0x1004d2c0).

**States** (virtual SetState): 1 pressed (transient), 2 normal, 3 disabled, 4 hidden,
5 focused. The base constructor starts widgets at state 4. Moving the focus sets the old item to
4 or 2 and the new one to 5, and plays the navigate sound (0x1004e4c0). **[verified]**

### 2.2 Simple Text GUI (`0x9b31ae5d`) [verified: 0x1006b1a0, 0x1006a620]

| Prop | Meaning |
|---|---|
| 15 | Label (string ref). Empty means the text is supplied at runtime (key hints, save names, prompts). |
| 16 | Font. Null means the UI default font (UIP p0 = 5:2). |
| 17 | Text Renderer (#448). Null means the UIP p1 default. |
| 18 | int, always 1. A text mode, probably word wrap [guess]. |
| 19 | Horizontal text alignment in the rect: 0 left, 1 centre, 2 right |
| 20 | Vertical text alignment in the rect: 0 top, 1 middle, 2 bottom |
| 21, 22 | Glyph scale x and y (main menu 1.4, pause and options 1.25), on top of the 640×480 scale |
| 23, 24 | int, unknown |
| 25–28 | Inner margins in percent of the screen: top, bottom, left, right [strong on the pairs] |
| 29 / 30 / 31 | Text colour for Normal (also Hidden and Pressed) / Disabled (state 3) / Focused (state 5) |

The alpha byte of every colour is 0 in the data. Opacity comes from the widget's fade value,
multiplied by 255.

- Main menu items: normal `#5a5a5a`, disabled `#1e1e1e`, focused `#a0a0a0`.
- Options items: `#404040` / `#808080` / `#808080`.
- Some labels end with a line break (5:349, the graphics item). Trim it, or the label renders one line
  too high.

**Simple Radio GUI** (`0xcb52fb94`) is a Simple Text GUI plus `p32`/`p33`, the HUD Texture
markers for on and off (texture 5:222). The option-page code places it next to its value texts.

### 2.3 Other widget classes

- **HUD Texture** (`0x1265cb3f`): `p23` texture, `p24..27` source rect in texels (x, y, w, h).
  A 0×0 rect means the whole texture. `p15..22` is a shared HUD block (fade and flash) that is
  not decoded. Menu headings are rects of atlas 5:333 (the options, gameplay, difficulty, pause, demo and
  brightness plates), 5:238 (audio, load/save and DVD headings) and 5:1120 (graphics and
  keyboard headings). The logo is the two
  halves 5:231 and 5:230.
- **Screen Background** (`0x7a97bf69`): six 256×256 textures `p0..p5`, laid out as a 3 × 2
  grid stretched over the whole screen. Each tile is a third of the width and half the height
  (0x100505a0). Used for the copyright screen, loading screens and the brightness test card.
- **HUD Meter** (`0xe35e393f`): a bar with fill colours `p23..28` and frame and fill pieces
  from texture 5:222 (`p32..44`). It is used for sliders (volume, sensitivity, gamma), for
  loading progress and for the HUD gauges.
- **Listbox Control**, **Horizontal Box / Rule**, **GUI Border**, and **GUI Effects** (#203, a
  44-float glow/flicker effect attached to the focused item) are decoded generically
  (`GuiNode`).

### 2.4 Fonts

Interface.fdu has font **2**, the UI font: hints, body text and the copyright line. Font **3**
is decorative and is used by every menu item and option label. Text uses UIP p0 (5:2) when a
widget's font is null.

## 3. User Interface Properties (#1) slots

| Slot | Value | Role |
|---|---|---|
| 0 | font 5:2 | Default font (the engine logs a design error if it is missing) [verified] |
| 1 | 5:448 | Default Text Renderer [verified] |
| 2 | tex 5:232 | 32×32 white texture for solid fills [strong] |
| 3 | str 5:3 | Path of the level-1 package; meaning unknown |
| 5 | [5:697, 5:696] | **Opening movies** (one picked at random) [verified 0x100b2080] |
| 6 | 5:643 | **Copyright** screen [verified] |
| 7 | 5:139 | **Main Menu** [verified 0x100b2b90] |
| 8 | 5:99 | Level Selection Screen. A dev fallback when the new-game level string is empty [verified 0x10062340] |
| 9 | 5:151 | **Pause Game Menu** |
| 10 / 11 / 12 | 5:145 / 5:244 / 5:694 | Load/Save GUI: load from the front end (opaque), load in game (bg 15), save game (bg 15) [strong] |
| 13 / 14 | 5:895 / 5:896 | **Options**: front end, in game (bg 20, no Credits) |
| 15 | 5:535 | Credits (video 5:32 + soundtrack 5:72, scrolling text) |
| 16 | 5:463 | Archives (two Archive Sets of unlockable pages) |
| 17 | 5:514 | DVD Extra (console extras; references other packages' videos) |
| 18 | 5:200 | Map GUI |
| 19 | 5:698 | Game Finished screen |
| 20–25 | 5:485/229/228 | Alert boxes (Yes/No and OK variants) |
| 26 | 5:172 | Game message list (HUD pickup log) |
| 27 | 5:317 | Subtitles text box (y 85.2 %, 71 % wide) |
| 28 | 5:426 | Checkpoint notice (HUD text) |
| 29, 30 | 5:235, 5:239 | Save-device select and format progress (console) |
| 31 | str 5:170 | Quit-game confirmation (pause menu) |
| 32, 33 | str 5:169 | Controller removed (console) |
| 34 | tex 5:1122 | Mouse pointer |
| 35–38 | 4, 2, 10, 10 | Unknown |
| 39 | 5:206 | **Default loading screen** (Progress GUI) |
| 40 | 5:580 | **New-game loading screen** (= chapter 0's) |
| 41 | 5:178 | Small saving/loading indicator (tex 5:213, top left) |
| 42 | [674, 680, 676, 678] | Generic loading backgrounds (island artwork with a quote note) [strong] |
| 43 | 12 | Unknown |
| 44–46 | str 5:20–22 | Three movie quotes; role unknown (46 is shown by a message call at 0x100a09e7) |
| 47 | snd 5:2 | **Navigate** (focus change) [verified 0x1004e537] |
| 48 | snd 5:71 | **Value change** (radio/slider) [strong 0x1006a2b9] |
| 49 | snd 5:1 | **Select** (activate) [verified 0x1004f15c] |
| 50 | snd 5:3 | **Cancel/back** [verified 0x10061c42] |
| 51 | snd 5:8 | 83 s looping interface ambience, the same sound as the main menu's ambient bed. Probably menu music [guess]. |
| 52–56 | ints | Unknown |
| 57–82 | strings | Memory card and save device texts (console), save names |
| 61 | str 5:326 | Checkpoint save prompt |
| 83 | 21 templates | **Chapter list** (§9) |

## 4. Boot sequence [verified unless noted]

1. **Opening movies** (UIP 5). The engine picks **one** of the listed GUI Opening Movies
   templates at random (0x1002d380). A template plays its `p15` video list in order, each with
   the matching `p16` soundtrack:
   - #697 plays video 5:31 with sound 5:74.
   - #696 plays video 5:30 with sound 5:73.

   Both are ~15 s logo reels. Skipping is allowed after 5 s when engine flag 0x200 is set
   (0x10064500) [strong; the flag probably means "not the first run"].
2. **Copyright** (UIP 6, #643). Screen Background #97 (title logo, publisher and developer logos and the legal notice) is shown for `p16` = **5 s** while the packages in `p17` load
   (`/Common/System/System`, `/Common/Resources/Resources`).
3. **Main menu** (UIP 7). The retail data has **no "press start" title screen**. The copyright
   screen leads straight into the main menu. Atlas 5:333 contains a demo-mode plate, but no class
   uses it on PC.
4. **Intro movie** 5:16 (115 s) with soundtrack 5:24 is the main menu's **attract** movie. It
   plays after `idleSeconds` = **30 s** without input on the main menu, not as a boot step
   (§5.3) [strong].

## 5. Main Menu (#139, class `0x079152d1`)

### 5.1 Items [verified: creation 0x100627b0, activation 0x10063610, dispatch 0x10063e3f]

All items are Simple Text GUI with font 5:3 at ×1.4, centred, each 10 % high:

| Order | y % | Prop | String | Action | Transition video |
|---|---|---|---|---|---|
| 1 | 27 | 20 | 5:4 | Show the difficulty sub-menu (cross-fade `p37` = 0.5 s) | no |
| 2 | 37 | 22 | 5:5 | Continue: load the newest save (scans the save list for the latest time stamp, 0x10062530) | yes |
| 3 | 47 | 23 | 5:6 | Load Game: open UIP 10 | yes |
| 4 | 57 | 21 | 5:7 | Options: open UIP 13 | no |
| 5 | 67 | 24 | 5:176 | Archives: open UIP 16 | yes |
| 6 | 77 | 29 | 5:162 | Quit: Yes/No alert with `p26` (5:495), then exit | no |

Notes on the items:

- `p25` (#897) is an empty placeholder.
- `p27`/`p28` (#430/#431, a second new-game/options pair at y 30/45) are never created by
  the PC class.
- `p15` is the logo: two HUD Textures at x 10 % and 50 %, 40×30 %, textures 5:231 and 5:230
  with source rect (0, 64, 256, 128).
- `p52` is Screen Background #97 (the copyright picture), probably a fallback.
- `p36` is the focus effect (#203).

"Transition video" (table at 0x1017730c) means that activating the item first plays a
transition video, and the action runs when the video ends.

### 5.2 Difficulty sub-menu (same template)

| Item | y % | Prop | String |
|---|---|---|---|
| Easy | 32 | 31 | 5:16 |
| Medium | 42 | 32 | 5:18 |
| Hard | 52 | 33 | 5:17 |
| Impossible | 62 | 34 | 5:19 |

- Heading `p16`: HUD Texture 5:333, rect (0, 75, 256, 36), at y 8 %.
- Footer `p35`: the Esc-to-cancel hint (5:201, font 2).
- `p30` = 1 is the default focus (Medium).
- Esc cross-fades back to the main items and plays the cancel sound.
- Picking difficulty *d* stores *d* in the game settings (0x1006380d). After the transition
  video it starts a new game (0x10063830 → 0x10062340).

### 5.3 What "New Game" does [verified 0x10062340]

The level path is a **string**:

- `p17` = 5:26: the path of level 1a (PrisonDeathRow).
- `p18` = 5:316: the path of the Prelude Docks level. This path is used instead
  when engine flag 0x400 is set.

The **Game Finished** class sets flag 0x400 in its constructor (0x100562c0). Its notice (5:325) says that
finishing the game unlocks archive pages and a prelude level. So a new game after completion
starts in the Prelude Docks. The engine sends a "load level" event with the path; there is no
spawn name, so the level's own Player object is the start (`docs/game-logic.md` §4.2).

- If the string is empty, the Level Selection screen (UIP 8) opens instead. That is a
  developer path.
- `p19` (#894, Screen Adjust / brightness) is referenced by the start path, but nothing showed
  that it is displayed on PC.

### 5.4 Background videos, transitions and attract mode [strong]

| Prop | Videos | Use |
|---|---|---|
| 38 | 15,15,6,6,7,7,8,8,12,12,9,10,13,5 | **Looping backgrounds**. The first entry (5:15) plays at menu creation, looped (0x100628c8). Later picks are random from the list (0x10060fe0); duplicates act as weights. |
| 39 | 20,20,20,20,19 | **Transition** played before the deferred actions above (random pick) |
| 40 | 22 | Third video state, likely the return transition [guess] |
| 48 + 49 | 16 + snd 24 | **Attract**: after `p50` = 30 s idle (countdown 0x10063d91) the intro movie plays with its soundtrack. Input returns to the menu. |

Videos are 512×512 WMV2 and are shown stretched to the screen. The browser engine plays them
from H.264 MP4 conversions made once by `npm run bake` (game/converted, never in the repo); see
src/formats/converted.ts and src/app/cutscene.ts. Sub-screens opened from the main
menu (Options, Load, Archives) have no background panel (`p12` = 100) and draw over the
still-running menu video.

### 5.5 Menu ambience [verified 0x10061d90, 0x10061f70]

- `p41` (snd 5:8, 83 s loop): played positionally around the listener.
- `p42` (14 one-shots, 5:9..5:22): one random sound every `p43` = **12 s**. It moves along a
  random curve of 4 control points, each at a random angle and a radius between `p45` = 2.5 and
  `p46` = 20 model units. One curve segment takes `p44` = 4.8 s.
- `p47` = 1 s fade-out when the menu closes.
- `p51` is the load-failed message.

## 6. Pause menu (#151, class `0x2ace3c6a`) [verified 0x10065a56]

- Full screen with `p12` = 15, which dims the game view by 85 %.
- Heading `p15`: the pause plate, texture 5:333 rect (66, 108, 123, 37), at y 8 %.
- Items use font 3 at ×1.25:

| y % | Prop | String | Action |
|---|---|---|---|
| 24 | 17 | 5:210 | Resume |
| 33 | 18 | 5:9 | Save Game (UIP 12). Created **disabled** when the player cannot save at this point (0x10065da7). |
| 42 | 19 | 5:8 | Load Game (UIP 11) |
| 51 | 20 | 5:187 | Revert to last checkpoint (confirm `p25` = 5:188) |
| 60 | 21 | 5:12 | Options (UIP 14) |
| 69 | 23 | 5:177 | Archives |
| 78 | 22 | 5:10 | Quit Game (confirm UIP 31 = 5:170, then back to the main menu) |

`p16` is a footer text filled at runtime. `p26`/`p27` (snd 5:1 / 5:2) are the pause open and
close sounds [guess].

## 7. Options

### 7.1 Options menu (#895 front end, #896 in game; class `0x2a387296`) [verified 0x10064630]

The PC class creates these items (font 3 ×1.25, centred):

| y % | Prop | String | Opens |
|---|---|---|---|
| 25 | 17 | 5:347 | Keyboard (#906) |
| 35 | 18 | 5:346 | Gameplay (#761 front end, #762 in game) |
| 45 | 19 | 5:349 | Graphics (#888) |
| 55 | 21 | 5:345 | Audio (#724 front end, #725 in game) |
| 65 | 24 | 5:496 | Credits. Only when `p24` is set, so front end only. |
| 84 | 25 | 5:342 | Back (×1.0) |

- Heading: texture 5:333 rect (30, 0, 196, 37).
- `p20` Brightness (y 45), `p22` Load Settings (58) and `p23` Save Settings (66) overlap the
  PC items. They belong to the console builds and the PC class does not create them.
- `p30` (#894 Screen Adjust), `p32` and `p33` (settings load/save progress) are their pages.
  `p33` save settings is used when leaving [guess].

### 7.2 Option pages

Each page has:

- **Accept** at (33 %, 84 %) and **Cancel** at (53 %, 84 %), each 14×9 % (5:340 / 5:341);
- a heading texture;
- a footer filled at runtime.

Labels are font 3 ×1.0, left-aligned. Values are radio choices at x 60–68 %, or HUD Meter
sliders about 33 % wide.

**Audio** (`0xc09c0276`)

| y % | Row | Label | Value |
|---|---|---|---|
| 27 | Effects volume | 5:329 | meter #713 |
| 36 | Dialog volume | 5:330 | meter #711 |
| 45 | Music volume | 5:331 | meter #712 |
| 54 | Subtitles | 5:337 | On/Off (5:338 / 5:339) |
| 63 | Environment FX | 5:491 | On/Off |
| 63 | Speaker Setup (console) | 5:333 | Mono/Stereo/Surround |

- Heading: texture 5:238 rect (0, 3, 256, 36).
- Sounds `p37..39` (5:69 / 5:67 / 5:68) are test sounds for the effects, dialog and music
  volumes [guess].
- Which of the two y-63 rows the PC shows is a guess: Environment FX is the EAX option.

**Gameplay** (`0x599cd937`)

| y % | Row | Label | Value |
|---|---|---|---|
| 25 | Turn sensitivity | 5:350 | meter |
| 33 | Pitch sensitivity | 5:364 | meter |
| 42 | Invert pitch | 5:359 | Yes/No |
| 50 | In-game help text | 5:351 | On/Off |
| 58 | Checkpoints | 5:365 | Off/Prompt/On |

- Heading: texture 5:333 rect (16, 37, 224, 37).
- The auto-pitch-correction (y 42) and auto-targeting (y 50) rows overlap two of the rows. They are
  console-only [guess].

**Graphics** (`0x91edb1ea`)

| y % | Row | Label | Values |
|---|---|---|---|
| 25 | Vertical Sync | 5:415 | Yes/No |
| 33 | Resolution | 5:432 | Value text filled at runtime |
| 41 | Pixel Shaders | 5:426 | Yes/No |
| 49 | Gamma | 5:421 | meter |
| 57 | Shadows | 5:417 | All characters / Player only / Off |
| 65 | Texture Filtering | 5:410 | Off / Bilinear / Trilinear |
| 73 | Use Defaults | 5:428 | button |

- Each row has a help text at y 85 % (font 2 ×0.75), shown for the focused row.
- Heading: texture 5:1120 rect (0, 42, 256, 28).

**What the port applies** (`src/app/menu/graphics.ts`, settings `x.<row id>`; Use Defaults
restores the engine defaults): Resolution = render scale of the window (50 / 67 / 75 / 100 %,
the value text shows the render size); Pixel Shaders = post effects (insanity screen effects)
on / off; Gamma = an sRGB gamma ramp over the game view and the menus; Texture Filtering =
point / bilinear / trilinear + anisotropy on the level textures; an engine-added Frame Rate
Limit row (off / 30 / 60). Vertical Sync is stored only (browsers always sync to the display).
Shadows are stored only: flashlight shadows of skinned characters break three r186's WebGPU
backend (destroyed buffers when casters are created / disposed or a shadow is turned off).
Gameplay: turn and pitch sensitivity multipliers, Invert Pitch (`PlayerController.invertY`),
help text and checkpoints (read by the HUD and the save system). Auto Targeting / Auto Pitch
are console rows (not created on PC); the port shows them on its Controller page (§13).

**Keyboard** (Control Settings GUI `0x42d3905a`)

- Listbox #904 at (10, 22.5) %, 80×60 %, 85 % transparent, scroll arrows `p20` / `p21`
  (texture 5:214).
- `p30` is the list of **40 action-name strings**, in binding order (5:444 … 5:499): map,
  documents, archives, forward, backward, turn left / right, strafe left / right, run/walk,
  look up / down, fire, throw, jump, use, first person, health, insanity, reload, flashlight,
  flare, roll left / right, seven weapons (shiv … flamethrower), four throwables, previous /
  next weapon, previous / next thrown, inventory. There is no crouch action.
- `p29` = 2 key columns. Row: Horizontal Box #905 (60 × 5 %), action name #898 (27.5 %),
  key text #899 (17.5 %).
- Strings: reset confirmation `p24`, press-a-key prompt `p27`, reserved-key message `p28`.
- Accept `p25` (33 %, 84 %), Cancel `p22` (53 %), reset-to-defaults `p23` (77 %); `p26` (#907)
  is the prompt line.
- Port: `src/app/menu/screens/keyboard.ts` over `src/game/hud/bindings.ts` (two key / mouse
  slots per action plus an engine-added gamepad column; persisted; retail default keys are not
  in the data, the engine picks its own). The port adds a 41st row, Crouch (engine label; C /
  Ctrl were hard-wired), so that crouching can sit on a pad button. The gamepad column draws the
  connected controller's glyphs (§13.5); Y clears a cell from the pad.

**Brightness** (Screen Adjust)

- Heading: the brightness plate.
- Two texts.
- Screen Background #893 test card.

## 8. Other screens

- **Load/Save** (LoadSave GUI): heading per mode, listbox #144 at y 25 %, row templates, key
  hints (load, cancel, delete), progress overlays (saving, deleting) and status strings
  `p42..55`.
  Decoded for the port (`gui-adapter.ts` `saveListSpec`, drawn by `frontend.ts` `drawSaves`):
  `p15`/`p16` load/save headings; `p17` load hints (Return, Esc), `p18[2]` Delete hint, `p21`
  save hint; `p20` Listbox Control (80×37 % at y 25 %, opaque black, GUI Border #148 = nine-slice
  of texture 5:222 rect (155, 115, 94, 67) with 5-px edges; scroll arrows `p20`/`p21` of texture
  5:214); `p26` row Horizontal Box (focused background `#7f7f7f`); `p28` "new save" row text,
  `p31` save name (52 %), `p35` date column (24 %, right-aligned), `p29` centred text, `p32`
  damaged-save text; strings `p43` saved, `p44` load failed, `p45` save failed, `p46` no saves,
  `p47` load confirmation, `p48` overwrite confirmation, `p49` delete confirmation. `p23`/`p24`/
  `p25` are the loading/saving/deleting progress screens (not shown: browser storage is
  instant). The port adds a thumbnail per row. The checkpoint notice is UIP `p28` (#426: Simple
  Text HUD at y 25 %, string 5:107).
- **Credits** (#535, `0xbb1a596f`, types `10.5.12|3003.1001|2.2.2`): `p15` video 5:32 (looped
  behind the text; its music bed 5:72 is paired by the cutscene library), `p16` soundtrack,
  `p17` the credits **text**: Interface.wdu entry 2 (type 0x60) is not a waveform but a
  UTF-16LE text (5 × u32 header, the last its byte length, then a BOM) of tab-separated rows
  with quoted cells in four columns: company, department, title, names. The first row names
  the columns; empty rows are spacing; a title row carries the first name, later names follow
  alone. `p18` four Simple Text styles, one per column (scales 1.8 / 1.6 / 1.2 / 1.0, heights
  25 / 20 / 12.5 / 6 %, bottom-aligned: the engine port uses the height as the line pitch
  [guess]). `p19` = [1, 1, 1, 3], `p20` = 50 (scroll speed, virtual px / s [guess]), `p21` =
  −200, `p22` = 200 (unknown). Port: `src/app/menu/screens/credits.ts`.
- **Archives** (#463, `0xb346e18b`, docs below in §8.1).
- **Game Finished** (#698, `0x23774d5c`): `p16` notice text (5:325), `p17` / `p18` the save /
  don't-save buttons (5:320 / 5:319), `p19` the GUI Save Settings page (its own status
  strings and a Progress GUI), `p20` focus effect, `p21` the don't-save confirmation. The
  constructor sets engine flag 0x400 (prelude unlocked, §5.3). Port: Save keeps the unlocks in
  the profile (`src/app/menu/profile.ts`), Don't Save asks `p21` and drops them [the original
  only kept them in the settings file it wrote].
- **Alert Box** (`0xaccfdfca`, types `…|100a.1.7|2003.2003`): `p15` button strings, `p16`
  default button, `p17` (bool), `p18` message text, `p19` button text. #228 has Yes/No
  (5:31 / 5:32, default No), #229 and #247 OK (5:33), #485 none. All are 50 × 50 % centred,
  opaque black (`p12` = 0) with GUI Border #148. Their children are sized relative to the box
  (message 87.5 × 40 % at the top, buttons 30 × 10 % at the bottom) [guess, unlike
  screen-level widgets]. The port draws every confirmation with this layout (`AlertSpec`).

### 8.1 Archives (#463) [verified data; behaviour strong]

| Class | Types | Properties |
|---|---|---|
| GUI Archives `0xb346e18b` | `3003.3003\|3003\|1005.1005` | `p15` (empty), `p16` footer text (#662, Esc hint 5:273), `p17` the two Archive Sets, `p18` (empty), `p19` sound 5:31 |
| Archive Set `0x6b43e4a9` | `1010.2003.2003\|3003\|2.1005.1005.1005` | `p0` 6 videos, `p1` title text, `p2` "page locked" text, `p3` Archive Pages, `p4` 1.0, `p5` 4 sounds, `p6` / `p7` one sound each |
| Archive Page `0x0f86449a` | `100e.100e\|5` | `p0` 6 textures, `p1` 6 textures, `p2` sound |

- Set #464 (title 5:178) has 15 pages, set #472 (title 5:181) 18.
- **An entry is a picture plus a narration.** `p0` is the blank page (shown while locked, with
  the set's `p2` text), `p1` the written page, both 6 tiles of 256 × 256. The tiles are drawn
  at native size in the 640 × 480 space, row-major 3 × 2 (2.5 × 1.875 tiles visible: the art
  leaves the cut-off parts black), unlike a Screen Background which stretches them.
  `p2` is the page's narration (Interface .sdu). There are no text, video or sound-only
  entries.
- Set `p0`: 0.4 s clips (5:28 × 5 + 5:25 for the first set, 5:29 × 5 + 5:27 for the second)
  played when a page turns, random pick with duplicates as weights [guess]. `p5` page-turn
  sounds 5:27..5:30, `p6` / `p7` one sound each (open / close [guess]).
- **Unlocks** come from **Archives Trigger** level objects (`0x2fb36366`, category System,
  types `2003.3003|2003.a|11|5`): `p0` the set, `p1` the pages to unlock, `p2` the notice text
  template (Simple Text HUD 5:660: left-aligned at x 5 %, y 15 %, ×0.75), `p3` the notice
  string (level text), `p4` the input message, `p5` a sound (2:405). Chapter 1 has six
  (five in 1a, one in 1b). Finishing the game unlocks pages too (#698 notice).
- Port: `src/app/menu/screens/archives.ts` (Left / Right turn pages, Up / Down switch sets,
  Enter replays the narration); unlocked page refs persist in the profile store across games
  and travel inside saves (game-scope provider 'archives'). The Archives Trigger / GUI
  Launcher objects themselves are run by `src/game/campaign/launcher.ts`.
- **Alerts** (#228 Yes/No, #229 and #485 OK): a 50×50 % centred box with a border, message text
  #242 and button #240.

## 9. Loading screens [verified data; selection strong]

A loading screen is a **Progress GUI** (`0x7325fff4`):

- `p18`: Screen Background (full screen).
- `p16`: HUD Meter #207, the progress bar, centred at y 88.5 %, 32.8×7.8 %.
- `p15`: optional status text.

Which screen is used:

- Default: UIP 39 (#206).
- New game: UIP 40 (#580).
- **Level transitions** name a **Chapter Properties** template in their `p3` (for example 1a →
  1b uses 5:587 and the Prelude → 1a uses 5:585). A chapter is `p0` title string plus `p1`
  Progress GUI.
- UIP 83 lists all 21 chapters (`FrontEnd.loading.chapters`; match by `template`).
- UIP 42 holds four generic backgrounds, used when nothing more specific applies [guess].

Port: `MenuFlow.travel()` shows the current chapter's tiles (`campaign.chapter`), New Game its
own screen, the rest the default.

There are **no tip texts**. The chapter backgrounds carry the narrative quote in the artwork.

## 10. HUD (for later)

The HUD is configured on the **Player template** (System.odu 2:5, class `0xc8bc44e1`).
Position and colour give the roles [strong]:

| Player prop | Template | Element | Position |
|---|---|---|---|
| 277 | HUD Meter #135 | Health (red `#ff2700`) | x 5 %, y 74.5 %, 3.6×23.2 % |
| 278 | HUD Meter #136 | Insanity (yellow) | x 7.85 %, y 84.5 % |
| 279 | HUD Texture #543 | Insanity frame (5:222 rect 53, 110, 26, 58) | |
| 281 | HUD Meter #524 | Flashlight battery (cyan) | right edge, x 92.25 % |
| 282 | HUD Ammo Meter #457 | Ammo | x 89.4 %, y 70.5 %: meter #458 plus count text #211 |
| 284 | Simple Text HUD #460 | Pickup message | x 46 %, y 58 % |
| 246 | GUI Inventory #157 | Inventory | rows and cells with 3D icons |

Weapons and items carry their own pieces:

- Ranged Weapon `p89`: ammo meter (#102, #112, #118, #164, #513).
- Missile Item `p56`: thrown-count meter.
- Player Weapon Properties `p7..9`: crosshair textures #202, #130, #442.

The message list (UIP 26), subtitles (UIP 27) and the checkpoint notice (UIP 28) are also
HUD-level. `readHud()` returns all of these as generic nodes.

**GUI Inventory** (#157, `0xaf7d9c53`, types `…|3003|2003.2.2.2|2003|5.5.5`): `p16` row
template, `p17` / `p18` (0.2 / 0.5: fade in / out [guess]), `p19` 10 (display seconds
[guess]), `p20` item name text (x 5 %, y 2 %, ×0.75). **GUI Inventory Row** #450 (`p15` cell,
`p16` 0.2, `p17` 2.5 / `p18` 5: cell spacing and left margin in % [guess], `p19` sound).
**GUI Inventory Cell** #158 (11 × 12.5 %): `p15` / `p16` focused panel colour `#bf0005` at
50 % transparency, `p19` / `p20` normal `#121207` at 50 %, `p17` / `p21` focused / normal
**3d Icon** (rotating item model), `p18` focused scale 1.25, `p22` count text (bottom right),
`p24` corner markers (5:222 rect 0, 0, 5, 5). Port (`src/game/hud/inventory.ts`): rows of
weapons, throwables and other items; the focused cell is the equipped weapon / throwable; the
Inventory key toggles it and selection changes show it briefly. 3D icons are not rendered
(the item name stands in).

**Input bindings** (`src/game/hud/bindings.ts`): the keyboard page's 40 actions → two key /
mouse codes + one gamepad button each, persisted. A capture-phase translation layer rewrites
rebound input into the codes the existing game listeners use, so they need no changes;
actions without a listener (weapon selection, inventory, archives, turn / look keys) are
handled through `input.onPress` / `input.isDown`. The HUD publishes the labels as
`services.input.bindings` for help-text placeholders. Gamepads: §13.

## 11. GUI Launcher (level object, class `0x2ab838a7`) [verified 0x10014930]

Placed in levels and triggered by message (inputs 5/6). `p0` selects what it opens:

| `p0` | Opens |
|---|---|
| 0, 1 | Message box with text `p4` |
| 2 | Credits (UIP 15) |
| 3 | Engine event 11 |
| 4 | Alert box `p1` with text `p4` |
| 5 | Overlay template `p3` |
| 6 | **Game Finished** (UIP 19) |

## 12. `src/formats/gui.ts` API

```ts
readFrontEnd(packages: EntityPackageSet, opts?: { interfacePkg?: number; systemPkg?: number }): FrontEnd
readGuiNode(packages, ref): GuiNode          // generic decoder for any template (recursive)
findUiPropertiesTemplate(packages, pkg = 5)
readMainMenu / readPauseMenu / readOptionsMenu(node) // typed screen views
readHud(packages, systemPkg = 2)
textWidget / imageWidget / screenBackground(node)
resolveRect(layout, parentRect, screen = 640x480): Rect
guiPixelScale(screen): [sx, sy]              // screen / 640x480
textColor(widget, state)                     // GuiState.Normal|Disabled|Focused...
```

`packages` needs package 5's `.odu`, which is only 86 KB. Package 2's `.odu` adds the HUD. The
`.xdu` is not needed: labels are `RefKey` strings (`"5:4"`) for `StringDb.lookup`. Texture, font,
video and sound refs use the same `"pkg:id"` form. Sound keys match `soundKey()` in `sound.ts`.

`FrontEnd` contains:

- `boot` (`BootStep[]`);
- `mainMenu` (`MainMenuDef`: items with actions, logo, difficulty sub-menu, new-game level
  refs, video lists, attract and ambience);
- `pause`;
- `options.{frontEnd,inGame}`;
- `optionPages.{keyboard,gameplay,gameplayInGame,graphics,audio,audioInGame,brightness}` (rows
  of slider, choice and button);
- `loading`, `sounds`, `strings`, `alerts`, `screens` (raw nodes by UIP slot name), and `hud`.

`tools/gui.ts <game app dir>` prints the tree with resolved labels. Other flags:

- `--json`: dump the model;
- `--node <id>`: print one raw template tree;
- `--png <dir>`: render every screen at 640×480 (boxes, labels in the game fonts, images, and
  the main menu over a frame of video 5:15).

## 13. Controllers (gamepads) — port

Everything here is engine work; the data only contributes the console strings, the console
Controller Settings template (#855 / #858), the rumble curves and the weapons' aim-assist cone.

### 13.1 The data

- **Console Controller Settings GUI** (#855 front end, #858 in game; class "GUI Controller
  Settings"): heading plate 5:238 uv (0, 75, 256, 36) "Controller Settings", Accept / Cancel
  (p15 / p16), an Invert Pitch Axis radio (p21, 5:375, Yes 5:374 / No 5:376), the **Controller
  Setting** radio (p24, 5:405) with five layouts and Custom (p25..p30: 5:400 "Double Stick
  (Default)", 5:401 "Throw/Jump Swap", 5:402 "Single Stick", 5:403 "Double Stick+Flashlight",
  5:404 "Jump On Top", 5:406 "Custom"), a controller picture in two halves (p17 / p19 / p20:
  textures 5:340 / 5:341, other pictures 5:889 / 5:890 for some layouts), p31..p53 the action
  names (5:377..5:399: Pause, Map, Move Forward ... Move, Turn/Pitch, Move/Turn) and p54..p130
  runtime-filled labels placed around the picture. The per-layout button tables are not in the
  template; they were not found.
- **Gameplay page console rows**: Auto Pitch Correction 5:362 (On 5:363 / Off 5:361), Auto
  Targeting 5:355 (On 5:354 / Off 5:356); Controller Vibration 5:370 (On 5:371 / Off 5:369).
- **Strings**: 5:169 (the controller-removed notice, with %d and <GUISelect>
  placeholders) (UIP 32 / 33), 5:196 (no pad),
  System 46..74 the PS2 button names ("START button", "L1 button", "left analog stick up &
  down"...).
- **Rumble curves**: `.wdu` type 0x60 entries whose header kind (u32 at +0) is 0: u16 motors (2),
  u16 bits, u32 rate (10 / 15 / 20 / 30 Hz), u32 0, u32 n, then n bytes of interleaved motor
  levels. Only `COMMON/Resources/Resources.wdu` (package 4) holds them: 68 curves (2 more are
  empty; its 7 other 0x60 entries are other curve kinds, as are all the 0x60 entries of the
  other packages). Levels stay in 0..127 except one trailing 255, so they read as signed 8-bit,
  127 = full [inferred]; two entries claim 16 bits but their sizes only fit 8-bit pairs. Motor 0
  is taken as the large / low-frequency one [inferred, console convention].
- **Who references them**: only sound headers (+0x28; 127 sounds, all pointing into package 4).
  By the templates that use those sounds: ranged weapon fire (Ranged Weapon p79: revolver 4:198
  and tommy gun 4:119 -> curve 4:97, shotgun 4:41 -> 4:104), melee swings and hits (Melee Weapon
  p71, Melee Weapon Material Effects p1), detonation / fire generators (Object Generator p36,
  BurnFX p2), level Sound Effects and Mechanisms, creature attacks (Burrower, CartWheeler...),
  and System.sdu sounds 2:148..175. No class property points at a rumble curve directly: the
  waveform-typed properties (Player p280 -> Interface curve 3, Character Morpher, Nooseman grab,
  Lighting Effect, Advanced Material...) all reference animation curves of other kinds.
- **Aim assist** [code, Suffering.rfl 0x10127fed..0x10128083 in the Ranged Weapon fire routine
  0x10127b30]: when the weapon has a tracked target (a handle at +0xda of the weapon object),
  the routine computes the unit direction from the muzzle / eye to it, takes cos(p76 degrees)
  (p76 = 45 on every retail gun) and fires along that direction when its dot product with the
  aim direction is at least that cosine; otherwise along the aim. How the console build chooses
  the tracked target and what Auto Pitch Correction does were not traced.

### 13.2 Supported controllers and mappings

`src/app/gamepad.ts` (`pads`) is the only module that calls `navigator.getGamepads()`; it
normalises the active pad to the W3C standard layout (17 buttons, LX / LY / RX / RY).

| Controller (Bluetooth on macOS) | Chrome / Brave / Edge | Safari | Firefox | Labels |
|---|---|---|---|---|
| Xbox Wireless (One S, Series X/S, Elite 2) `045e` | standard mapping | standard (GameController) | standard (its remapper) | Xbox |
| DualShock 4 `054c:05c4 / 09cc` | standard | standard | standard | PlayStation |
| DualSense `054c:0ce6` (Edge `0df2`) | standard | standard | standard | PlayStation |
| Switch Pro `057e:2009` | standard | standard (recent macOS) | standard | Nintendo |
| 8BitDo (X-input / Switch modes) | as Xbox / Switch Pro | as Xbox / Switch Pro | idem | Xbox / Nintendo |
| 8BitDo D-input `2dc8:*`, other HID pads | often non-standard | non-standard | depends | Nintendo / generic |

"Standard" above is what the browsers' own mapping layers are documented to do (Chromium
`gamepad_standard_mappings_mac`, WebKit's GameController provider, Firefox
`GamepadRemapping.cpp`); only the standard path was exercised in this repo (with a scripted pad,
§13.8), not on real hardware. When a pad arrives unmapped (`mapping !== 'standard'`), the
remap tables (`REMAPS`, keyed by the vendor / product parsed from `gamepad.id`) cover the raw
HID layouts of the DualShock 4 / DualSense (buttons Square, Cross, Circle, Triangle, L1, R1,
L2 / R2 as axes 3 / 4, hat on axis 9, right stick Y on axis 5), the Switch Pro simple-HID mode,
the Xbox Bluetooth LE descriptor (A 0, B 1, X 3, Y 4, LB 6, RB 7 ...), the older Xbox One S
(`02e0`) descriptor and 8BitDo D-input; they come from SDL's GameControllerDB and the HID report
layouts, not from hardware tests. Anything else falls back to a generic guess (buttons as they
come, first four axes as sticks). Id formats parsed: Chromium "Name (STANDARD GAMEPAD Vendor:
054c Product: 0ce6)" / "Name (Vendor: 2dc8 Product: 6101)", Firefox "54c-ce6-Name" (no zero
padding), Safari the bare product name (family from the name).

Hats reported as one axis decode as up = -1, clockwise in steps of 2/7, centred outside
[-1.1, 1.1]. Triggers count as pressed at the Controller page threshold (default 0.3) and
release at 70 % of it.

**Calibration** (Controller page -> Calibrate Controller, `screens/controller.ts`): "press each
button" for the 17 standard buttons, then push each stick right and down; it records the raw
button / axis (with its rest value, for triggers) / hat direction and stores the mapping per
`gamepad.id` in localStorage (`suffering.padmaps.v1`). A calibration wins over every other
mapping. Keyboard: Space skips a step (e.g. no Home button), Esc cancels, Delete removes the
pad's calibration.

**Hot-plug**: connects and disconnects come from the events and from polling. The active pad
is the most recently used one (a press or a stick past half way), so a Bluetooth pad that comes
back at another index takes over on its first press. When the pad in use drops out during play
the game pauses and shows string 5:169 (port = index + 1, `<GUISelect>` = the pad's accept
button); connecting shows a short toast. **Last-used device**: trusted key / mouse button /
wheel / mouse movement (> 6 px) switch to keyboard, pad activity to pad; this switches labels
and glyphs and sets `html.pad-active` (no cursor, no "click to look around" hint). Browsers do
not treat pad buttons as a user gesture: pointer lock and starting audio still need one click
or key press (a toast says so when the game was started from a pad); pad play itself needs
neither (the weapons and creature attacks accept pad input without pointer lock,
`padPlaying()` in bindings.ts).

### 13.3 Default layout and the Controller Setting layouts

| Button (standard index) | Double Stick (Default) | Variants |
|---|---|---|
| Left stick | move; walk speed scales with deflection, run past 88 % | Single Stick: forward / back + turn |
| Right stick | look (turn / pitch) | Single Stick: strafe + pitch |
| RT (7) | Fire | |
| LT (6) | Throw | Throw/Jump Swap: Jump |
| A / Cross (0) | Jump | Throw/Jump Swap: Throw; Jump On Top: Reload |
| B / Circle (1) | Crouch (hold) | |
| X / Square (2) | Use | |
| Y / Triangle (3) | Reload | Jump On Top: Jump |
| LB / L1 (4) | Insanity | Double Stick+Flashlight: Flashlight |
| RB / R1 (5) | Next weapon | |
| View / Share / Minus (8) | Archives | |
| Start / Options / Plus (9) | Pause (reserved; skips a cinematic) | |
| L3 (10) | Run (hold) | |
| R3 (11) | First / third person | |
| D-pad up (12) | Flashlight | Double Stick+Flashlight: Insanity |
| D-pad down (13) | Health (Xombium) | |
| D-pad left (14) | Next throwable | |
| D-pad right (15) | Inventory | |

The console's own tables are unknown (§13.1); these are the engine's, console style, named
after the console layouts. Every pad cell is rebindable on the keyboard page; editing one
switches the layout to Custom (the player's column is kept and comes back with Custom). Mouse
and keyboard keep their own two columns.

### 13.4 Controller page (Options -> Controller)

An engine page in the style of #855 (its heading plate, Accept / Cancel, row and value text
styles; rows at x 10 %, values centred on 52..88 %, 6 % apart from y 20 %), listed in both
Options menus under Audio (the front end's Credits moves down 9 %). Settings live in
`Settings.extra` (`x.pad*`, applied by `applyPadSettings` in settings.ts); Accept keeps,
Cancel / B restores.

| Row | Label | Values (default) |
|---|---|---|
| Look Sensitivity | engine | 0.25..3 (1): multiplies the original's 220 °/s turn / 84 °/s pitch (× the Gameplay Turn / Pitch sensitivity) |
| Stick Dead Zone | engine | 0.05..0.4 (0.15), radial, both sticks; outer edge 0.95 = full |
| Look Response | engine | Linear / Smooth / Precise (Linear, as the original's binding records): magnitude^1 / ^1.8 / ^2.6 |
| Trigger Threshold | engine | 0.1..0.9 (0.3) |
| Invert Pitch Axis | 5:375 | Yes / No (shared with the Gameplay page's Invert Pitch) |
| Controller Vibration | 5:370 | On / Off (On) |
| Auto Targeting | 5:355 | On / Off (Off, the original's default) |
| Auto Pitch Correction | 5:362 | On / Off (Off, the original's default) |
| Controller Setting | 5:405 | the five layouts + Custom (Double Stick) |
| Calibrate Controller | engine | opens the calibration screen |

Under the rows a status line names the connected pad, its label family and how it is mapped
(browser mapping, built-in remap, calibrated or generic). The Gameplay page's Turn and Pitch
sensitivity and Invert Pitch apply to the pad as they do to every turn input in the original
(docs/re/player.md §12). There is no turn boost: the original has no ramp.

### 13.5 Labels and glyphs

`input.labelMap()` (help-text placeholders, `<Use>`) and `input.label()` give pad button names
while a pad is in use: Xbox A / B / X / Y, LB / RB / LT / RT, View / Menu; PlayStation Cross /
Circle / Square / Triangle, L1 / R1 / L2 / R2, Share / Options; Nintendo B / A / Y / X
(positional: the bottom button is B), L / R / ZL / ZR, Minus / Plus; LadderMove reads "Left
Stick"; GUISelect / GUICancel are the accept / back buttons. Help texts keep the game font, so
they show the names. Drawn glyphs (`src/app/glyphs.ts`, plain shapes and system-font letters
made in code) appear in the interaction prompt, the death prompt (Use / Fire glyphs before the
Revert label), the keyboard page's pad column, the save-list hints ("Return / Esc / Delete -
..." become the accept / back / Y glyphs) and the calibration screen.

### 13.6 Gameplay input

`src/game/hud/bindings.ts` polls `pads` every frame (from the menu flow). Pad buttons go
through the same translation layer as keys (synthetic canonical key / mouse events for the
legacy listeners, `onPress` for native actions); buttons held when a menu closes do not count.
The left stick drives `PlayerController.setAnalogInput()` (added to the keys; scripted
`setVirtualInput()` freezes still win); the right stick changes yaw / pitch directly with the
dead zone, curve, sensitivity, turn boost and aim assist. Start pauses; during a cinematic
Start / A / B skip it instead (the sequence system's `uiBridge.skipCutscene`), and full-screen
movies (menus and the Movie Player) skip on A / B / Start inside `CutscenePlayer`, which also
suspends gameplay input while it plays. Ladders, pushing and mounted guns read the same analog
movement and the Fire button.

### 13.7 Aim assist and rumble

**Aim assist** (`src/game/weapons/aim-assist.ts`; pad play only, with Auto Targeting on; off
by default as in the original): the console rules of docs/re/player.md §3. The target is picked
in a 5° × 3° pyramid out to the held gun's range. Near a target, the stick turn is slowed to
0.125 when standing and 0.55 → 0.10 when moving, and pitch to 0.5 / 0.7. Without stick input
the view tracks the target. Shots snap to a target within 1°. Auto Pitch Correction (pad, off
by default) levels the view at 42 °/s after 2.2 s of third-person movement. Mouse play never
gets either.

**Rumble** (`attachAudioRumble` + `pads.updateRumble`): when a sound with a rumble reference
starts (`AudioSystem.onPlay`), its curve is loaded from the `.wdu` next to the package's `.sdu`
and mixed in (per-motor maximum of all running curves, scaled by distance for positional sounds:
full within the sound's near distance, nothing past 60 % of its max distance). The mix is
streamed to `vibrationActuator.playEffect('dual-rumble')` as ~120 ms effects refreshed when it
changes (fallback `hapticActuators[0].pulse()`), only in game, not paused, with Controller
Vibration on and a pad in use. Where neither API exists (Safari versions without haptics,
Firefox without `dom.gamepad.haptic_feedback.enabled`) nothing happens.

### 13.8 Tests

- `tests/gamepad.test.ts`: id parsing and families, remap tables (DualShock 4 raw HID through
  the table), hat decoding, dead zone / response curve / walk-run math, rumble-curve decoding,
  sampling, mixing and conversion to dual-rumble effects, the retail curves and the sounds
  referencing them (skips without the game), aim-assist selection / slowdown / magnetism / p76
  cone, pad layouts and device-dependent labels, calibration detection.
- `tools/gamepad-e2e.mjs` (`npm run e2e:gamepad`): headless Chromium-family browser with
  `navigator.getGamepads` replaced by a scripted pad (and a logging vibration actuator); boots
  through the start gate and the logo movie, navigates the menus (Options, Controller page,
  keyboard page), starts a New Game, skips the opening cinematic with Start, walks and runs,
  measures the look rates against the original's (220 °/s turn, 84 °/s pitch, linear half
  deflection, no boost, Turn / Pitch sensitivity and Invert Pitch), drinks a Xombium bottle with
  D-pad down, fires a revolver (rumble from its fire sound), Use / Jump, pauses and resumes, pulls the
  pad mid-game (pause + 5:169 notice) and plugs it back, checks the help-text names and a raw
  DualShock 4 through the remap table. `--family playstation` uses a DualSense id; `--shots
  <dir>` saves screenshots.

## 14. Open questions

1. Which of the overlapping option rows (Speaker Setup or Environment FX; Auto Targeting and
   Auto Pitch, or Help Text and Invert Pitch) the PC build shows. The Audio and Gameplay
   classes were not traced.
2. The roles of UIP 3, 35–38, 43–46 and 52–56, Main Menu `p40` (back video), and Text `p18`,
   `p23` and `p24`.
3. GUI Effects (#203) parameters for the focus glow and flicker.
4. Exactly when the main menu switches to a new random background (after each loop or on an
   event).
5. Whether Main Menu `p19` (brightness screen) is shown before the first new game on PC.
6. The console's per-layout button tables (Controller Settings #855 only names the layouts and
   positions runtime labels around the controller picture), how its auto-targeting picks the
   tracked target (the weapon handle at +0xda), and what Auto Pitch Correction does; the port's
   versions are in §13.3 and §13.7.
