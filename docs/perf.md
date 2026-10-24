# Performance

Frame-rate work on the reference machine class: MacBook Pro 16" (M1 Pro, 16-core GPU, 32 GB), built-in
display 3456 x 2234 at device pixel ratio 2, Brave / Chromium with WebGPU. Each area has its own
section (Perf A: resolution and pacing; Perf B: CPU per frame; Perf C: GPU shading, compiles,
streaming). Numbers are headless Brave on the development Mac (the same model), which runs other
agents' browsers at the same time: expect ±5 fps between runs.

## Perf A: resolution, pixel cost, frame pacing

### Measured causes

- **Pixels.** Earlier fps figures were taken at 1280 x 720, DPR 1 (0.9 Mpx). A full-screen window
  on the reference display is 1728 x 1117 CSS px at DPR 2: a 3456 x 2234 drawing buffer, 7.7 Mpx,
  8.4 times as many [verified: `canvas.width` in the harness]. The renderer took
  `min(devicePixelRatio, 2)` as its pixel ratio and every target followed it: the Enhanced
  scene pass, GTAO (0.5 of that), volumetrics (0.5), bloom (0.5), TRAA's history and resolve,
  the grade, FXAA, and the canvas itself with 4x MSAA.
- **Enhanced is fill-bound there, Original is not.** Original holds 60 fps at native resolution
  (its frame is a few cheap passes; 3a's yard was CPU-bound at 22 ms of main-thread time).
  Enhanced Medium at 1a's cell row: 32 fps at native, 60 with only the scene pass at half
  resolution (post still at native), 60 at DPR 1.4 [verified, `scratchpad/perfA/ex1`]. With the
  frame rate unlimited (`--disable-gpu-vsync --disable-frame-rate-limit`), Medium ran 82 fps at
  1.9 Mpx, 79 at 2.8, 68 at 3.8, 34 at 7.7; High 74-84 at 1.9, 73 at 2.3, 43-57 at 2.8, 23 at
  7.7; Ultra 40 at 1.9; Low was CPU-bound (87 fps) at 3.8 [verified, `ex4`, `ex5`].
- **A GPU-bound frame queues up.** Chromium kept handing WebGPU frames to the GPU while it fell
  behind: with Medium at native, a frame completed 150-170 ms after its task ended (about five
  frames in flight) [verified: `onSubmittedWorkDone()` against the end of the frame's task]. All of
  that is input lag on top of the low rate: the lag that was reported.
- **GPU timing on Apple GPUs.** WebGPU timestamp queries (three.js `trackTimestamp`, `?gputime`)
  summed 60-90 ms per frame for frames presented at 60 fps: on Apple's tile-based GPUs the
  passes overlap, so per-pass intervals do not add up to frame time [verified]. And Chromium
  resolves `onSubmittedWorkDone()` about one display frame late even when the GPU is idle
  (16-19 ms at 35 % scale as at 60 %) [verified], so neither gives the GPU's headroom.
- **HUD canvas.** The 2D HUD canvas (full window, DPR 2) was cleared every frame while hidden
  (cinematics, menus): a 7.7 Mpx canvas commit per frame for nothing.

### Fixes (src/app/render-scale.ts, renderer.ts, enhanced/sharpen.ts)

- **Render scale.** The drawing buffer is the internal resolution: CSS size x min(DPR, 2) x
  scale. Everything sized from the drawing buffer follows it (Original's frame and scene-glow
  targets, the insanity screen-effect targets, the whole Enhanced pipeline), and the browser's
  compositor scales the canvas to its CSS size (bilinear). Graphics **Resolution** row (now
  `x.renderScale`): **Auto** (default) / 50 / 67 / 75 / 85 / 100 % of native; `?scale=auto|50|0.75|85%`
  overrides it for the page (until the row is changed). The row's old key (`x.resolution`,
  default 100 %) is no longer read, so saved settings start on Auto.
- **Auto: a pixel budget per mode / tier**, then dynamic resolution under it (`PIXEL_BUDGET`):
  Original 8.3 Mpx (native up to 4K: identical to before on the reference display), Enhanced Low
  4.2, Medium 3.0, High 2.2, Ultra 1.9 Mpx. On 3456 x 2234 that is 100 / 70 / 60 / 50 / 45 %; on
  a 1080p DPR 1 display Medium and High are native.
- **Dynamic resolution** (`DynamicResolution`, Auto only, WebGPU only). Half-second windows.
  Down when two windows in a row are GPU-bound: under 93 % of the target rate, the main thread
  under 80 % of the frame, and the GPU behind (completions more than 1.6 frames after the task, or
  frames held back for the backlog); the step is proportional to the rate (a GPU-bound rate is
  the GPU's), 5 % at least, 30 % at most. Up by one 5 % step as a probe after 3 s on target with
  no backlog; a level that has to be left within 5 s is banned for 20 s, doubling to 160 s. A
  1.2 s cooldown after each change (one hitch frame per resize: 2 frames over 33 ms in 4 s of
  switching every second, `ex7`), while loading, and 2 s after the tab is shown again. The floor
  is 40 % or 1280 x 720 pixels, whichever is larger; the cap is the budget. Target: the frame
  cap, else 60 (or the display's rate below 60). A CPU-bound frame never lowers the resolution.
  Enhanced Auto quality's tier governor now waits for it: a tier down only at the floor, up only
  at the cap.
- **Sharpening.** Enhanced ends its chain with FSR 1's RCAS (contrast-adaptive sharpening, written
  in TSL from the published formula) at strength `min(0.8, 2 (1 - scale))`: 0 at native (the
  frame unchanged), so a scale change never rebuilds the pipeline. Original is upscaled by the
  compositor only (bilinear); at 100 % its frame path is unchanged.
- **Effect resolution per tier.** GTAO (`aoScale`), volumetrics (`volumetricScale`) and now bloom
  (`bloomScale`: Low 0.35, the rest 0.5) are fractions of the drawing buffer, i.e. of the
  internal resolution. Original's scene glow keeps the engine's fixed 256 / 128 / 64 / 32 levels
  (resolution independent); shadow-map sizes stay per tier (screen independent).
- **Frames in flight** (renderer.ts `MAX_IN_FLIGHT` = 3, `?inflight=0` turns it off): a display
  frame is not drawn while three frames are still on the GPU (never for more than 100 ms). Medium
  at native: completion lag 131-141 ms instead of 218-237 at the same rate (`ex7`, `ex8`), and the
  main thread no longer stalls inside WebGPU calls (CPU per frame 11 ms instead of 16-43 ms at
  High with the rate unlimited, `ex5`).
- **Pacing on fast displays** (`FramePacer`): with the frame-rate limit Off on a display above 75
  Hz (ProMotion: 120 Hz rAF), when over 20 % of a second's frames miss the display interval the
  game renders on every other display frame (a steady 60 instead of a 120 / 60 judder), and goes
  back after 3 s of frames under 70 % of the interval (backing off 5 .. 120 s when a return
  fails). Headless runs at 60 Hz, so this part has unit tests only.
- **HUD**: cleared once when it hides, not every frame.
- Debug overlay (F1 / dev viewer): `fps · 2073 x 1340 (60 %, auto)`; `__view.scaler` (setting,
  scale, cap, floor, `dyn.log`, `gpu.trace`) and `__view.pacer` for QA.

### Results at 3456 x 2234 (DPR 2)

Headless Brave, window 1728 x 1117 CSS px at `--force-device-scale-factor=2` (a 3456 x 2234
drawing buffer at 100 %), fly camera at the evidence poses of tools/enhanced-compare.ts; "cine"
is 1a's opening "Goose" sequence playing (not skipped). fps over 4 s; frame-time percentiles in
ms; tiers switched live in one load per level. Headless runs at 60 Hz (vsync), so 60 is the
ceiling. `scratchpad/perfA/before.json`, `after1.json`, `after2.json`, `cmp-*.json`.

Back to back, same load (load average 10-12), Enhanced at native without the in-flight limit
(`?scale=1&inflight=0`, the old behaviour) against the default Auto:

| Scene | Tier | Native: fps (p50 / p95 ms) | completion lag | Auto: fps (p50 / p95) | lag | internal |
|---|---|---|---|---|---|---|
| 1a cine | Medium | 20.5 (50 / 50) | 227 ms | 57.3 (16.7 / 16.8) | 34 ms | 2073 x 1340 (60 %) |
| 1a cine | High | 11.2 (83 / 83) | 363 ms | 57.0 (16.7 / 16.8) | 17 ms | 1728 x 1117 (50 %) |
| 1a cell row | Medium | 21.4 (50 / 50) | 221 ms | 60.0 (16.7 / 16.7) | 18 ms | 1900 x 1228 (55 %) |
| 1a cell row | High | 14.7 (67 / 83) | 333 ms | 59.8 (16.7 / 16.8) | 18 ms | 1382 x 893 (40 %) |
| 1a guard | Medium | 21.3 (50 / 50) | 222 ms | 58.5 (16.7 / 16.7) | 19 ms | 2073 x 1340 (60 %) |
| 1a guard | High | 14.1 (67 / 83) | 341 ms | 59.8 (16.7 / 16.8) | 18 ms | 1728 x 1117 (50 %) |
| 3a yard | Medium | 27.6 (33 / 50) | 172 ms | 60.0 (16.7 / 16.8) | 17 ms | 2073 x 1340 (60 %) |
| 3a yard | High | 19.8 (50 / 67) | 240 ms | 60.0 (16.7 / 16.8) | 18 ms | 1728 x 1117 (50 %) |

Every mode and tier, before (HEAD at the start, load average 3) and after (default Auto, two
runs, load averages 5-8 and 9-13); fps (p95 ms). "stall" = no frame drawn in the 4 s window
after a live tier switch (the compile stall under Open, in both):

| Scene | Original | Low | Medium | High | Ultra |
|---|---|---|---|---|---|
| 1a cine, before | 60 (16.8) | 60 (16.7) | 28.2 (50) | stall | stall |
| 1a cine, after | 60 / 60 (16.7) | 60 / 60 (16.8) | 58.2 / 57.0 (16.8 / 33.2) | 59.3 / stall | 27.0 / stall |
| 1a cell row, before | 60 (16.8) | stall | 9.1 (150) | stall | 4.4 (317) |
| 1a cell row, after | 60 / 60 (16.8) | 60 / 59 (16.8) | 60 / 57.2 (16.8) | 60 / 54.9 (16.7 / 33.3) | 35.6 / 40.6 (33.4) |
| 1a guard, before | 59.5 (16.8) | 50.6 (33.4) | 14.2 (83) | 8.9 (133) | 4.0 (267) |
| 1a guard, after | 60 / 60 (16.7) | 60 / 60 (16.8) | 59.8 / 56.3 (16.7 / 33.3) | 56.5 / 49.0 (33.3 / 33.4) | 31.3 / 34.5 (33.5) |
| 3a yard, before | 44.3 (33.4) | 49.3 (33.4) | 20.1 (67) | stall | 9.5 (117) |
| 3a yard, after | 60 / 60 (16.8) | 60 / 60 (16.8) | 60 / 60 (16.8) | 58.5 / 57.4 (16.8) | 43.4 / 60 (33.4 / 16.8) |
| 6a woods, before | 59.8 (16.8) | 60 (16.8) | 18.4 (83) | 18.4 (67) | 6.1 (183) |
| 6a woods, after | 60 / 60 (16.7) | 60 / 60 (16.7) | 60 / 60 (16.8) | 60 / 59.7 (16.7 / 16.8) | 37.4 / 56.0 (33.4 / 33.3) |

Auto's internal sizes in these runs: Original 3456 x 2234 (100 %, the unchanged frame), Low
2419 x 1563 (70 %), Medium 1728-2073 wide (50-60 %), High 1382-1728 (40-50 %), Ultra 1382-1555
(40-45 %, at the floor: Ultra stays fill-bound on this GPU). Original's 3a gain is not from
this work (its frame was CPU-bound; main-thread time fell from 22 to 9-14 ms between the runs).
Within the 4 s windows the misses at Medium / High are dynamic resolution's down-steps and probes.

### Open (other areas)

- **Tier switches stall for seconds** at run time (High / Ultra: no frame for over 6 s after
  `setTier` in a loaded run, before and after this work): the rebuilt post chain compiles its
  pipelines on first use. Auto quality's governor switches tiers in play. (Perf C.)
- **Enhanced still renders its canvas with 4x MSAA** (`antialias: true`) although it only draws
  full-screen quads there. `antialias: !ENHANCED` saved that buffer but the load-time precompile
  then failed (`createRenderPipelineAsync`: depthStencil format missing) and the level never
  showed; reverted. (Perf C.)
- **Main thread**: 10-14 ms per frame in Enhanced at these poses, 8-15 ms in Original (Perf B);
  above 8.3 ms a 120 Hz display is paced to 60.
- Measuring: `scratchpad/perfA/bench.mjs` (fps / percentiles / completion lag per scene and
  tier at a given window size and DPR; `--steps` for one-pose experiments, `--unlimited` for
  uncapped rates, `--menu` for the Graphics page).

## Perf B: CPU and JavaScript per frame

### How it was measured

`scratchpad/perfB/prof.mjs`: headless Brave, `--window-size=1728,1117 --force-device-scale-factor=2`,
the developer deep link per level (`?level=...&gfx=original`, or `gfx=enhanced&tier=high`), the
player invulnerable. Per scene it records the frame probe's laps summed per frame (`player`,
`matrices`, `cull`, `lights`, `shadows`, `render` and every game system by name), draw calls per
frame (`renderer.info`), a V8 CPU profile (250 µs sampling), the GC events of a trace, and with
`--alloc` the sampling heap profiler. Scenes: 1a's opening "Goose" (8 s in), 1a's cell row after
the opening, the gas chamber (player at its window, the CartWheelers loose), 3a's yard (59
burning barrels in view), 9 outside the lighthouse base (153 swaying trees in view), 10 on the
dock with the Black Ones up (Detector 83b entered by a teleport). `?level` shows the developer
sidebar, so the canvas there is 2896 x 1960.

"CPU" is the main-thread time inside the frame (`__frames.stats().cpuMean`): everything the game
does in a frame, three.js included. Headless runs at 60 Hz and Original reaches 60 in all of
these scenes before and after, so the gain is headroom: a 120 Hz display (8.3 ms), a busier
scene, Enhanced's own passes. Enhanced Medium / High on the reference display are GPU-bound (the
main thread idle 60 % of the time in "Goose" at Medium), which is Perf A's and C's part.

### Where the time went

- **three.js's per-draw cost is the frame.** `render` is 55-70 % of the main thread in every
  scene. Inside it nearly all of the time is per object: the scene-graph walk (about 5,000 of 1a's
  11,000 nodes), then for each draw the render-object lookup, the node uniforms (every material
  here has nodes, so three.js refreshes each object fully on every draw), bind groups, attribute
  checks and the WebGPU encode. One `render()` of the gas chamber took 6.5 ms for about 620
  draws, spread evenly over those stages (objects 0.8, geometry 0.7, nodes 1.3, bindings 1.5,
  pipelines 0.6, encode 1.5 ms): about 10 µs a draw, with no single hot spot to patch. Fewer draws
  is the lever.
- **What the draws were.** 3a's yard drew 929 a frame. Its 59 fires are three additive flame
  cards each, and each card was drawn three times: three.js's back-face pass and front-face pass
  (it splits every transparent double-sided material in two) and the scene glow's mark pass (the
  cards carry the glow flag): 531 of the 929. In the gas chamber after the fight its 96 blood and
  bullet decals were 192 draws, the level's 280 materials 313. 9's 153 trees (Animating Statics,
  three materials each) are 439 skinned draws.
- **The scene glow walked the scene twice more.** Its mark pass found the marked meshes with a
  `traverseVisible` of the whole graph, then drew them with a second full `render()` of the scene on
  the glow layer: a walk as long as the main pass's for 6-8 meshes in 1a, and 177 single draws
  for 3a's fire cards.
- **Allocation** ran at 38-57 MB/s (minor GCs of 1-2.5 ms, one to three a second). The largest
  single source was the per-object light choice (`objectLightSet`: an array and a record per
  light per dynamic object per frame, 3-10 MB/s). The fires asked for the player's posed hit
  spheres once per burning fire per frame, recomputing the player model's world matrices each
  time (3a: 74 times a frame). The shadow-caster list was rebuilt with new vectors every frame.
- **Enhanced: dynamic vertex buffers uploaded on every draw.** three.js r186 writes a
  `DynamicDrawUsage` attribute to the GPU every time it is drawn, and the whole array once the
  first write of a frame has used up its update ranges. Enhanced's blood films (two 32,768-vertex
  ring buffers, five attributes) went up 2.9 MB a frame with no blood on screen: 70 ms per second
  in `writeBuffer` in the gas chamber at High.
- **Not hot:** actors (AI, culling, animation: 0.4-0.6 ms, 1.3-1.8 in 9 and 10 with 300 and 526
  actors, most of it the hips lookups of the culling), the scene-graph update (1.0-1.4 ms, mostly
  visible characters' bones; three.js has no dirty tracking below the scene), zone culling with the
  static prop batch (0.25 ms together), lights (0.1), shadows (0.2-0.5), audio, HUD, the sequence
  presenter (under 0.1 each). Skinning runs on the GPU (three.js's skinning node); the CPU part is
  each visible skeleton's bone matrices, once per frame. Animation LOD already exists (manager.ts:
  hidden idle actors freeze, half rate past 18 m).

### Fixes

- **One draw for order-free double-sided blends** (`src/app/single-pass.ts`, called from
  surface-material.ts; fx/decals.ts). A transparent, non-depth-writing, double-sided material whose
  blend is a pure sum (add or reverse-subtract, destination factor one, a source factor that does
  not read the destination: the engine's additive and subtractive modes) gets `forceSinglePass`:
  one draw with culling off instead of three.js's back-then-front pair. The order of a sum does not
  change it. Decals get it in every blend mode: their triangles lie on the surfaces they were
  projected on and are depth-tested against them, so a back- and a front-facing triangle of one
  decal only meet on a visible pixel where one surface was painted twice (the same texel twice).
  The engine draws two-sided surfaces in one pass too (D3D9 CULL_NONE). Checked: 3a's yard and the
  gas chamber with 96 decals rendered both ways with time frozen: 0 differing channels.
- **Scene glow mark pass** (scene-glow.ts):
  - the marked meshes come from three.js's render list of the frame's own scene pass (exactly the
    meshes it drew) instead of a `traverseVisible`; a mark outside the frustum drew nothing before
    either;
  - the mark `render()` walks only the marked meshes' branches: for its duration the other
    children of their ancestors are hidden (lights excepted);
  - small marked meshes (up to 64 vertices: fire cards, bulbs) are merged per mark material into
    one world-space buffer each frame (`MarkBatches`) and drawn once. Every mark writes the same
    value (alpha 1, colour kept, no depth), so their order cannot matter; the merged geometry keeps
    the members' attribute layout and draws with their pipeline.
  Checked: the mark draws were the same set draw for draw with the first two changes, and the
  frame target's mark alpha with all three was the same as before in 3a's yard with time frozen
  (0 of 2,449 marked pixels differ).
- **Dynamic vertex buffers are uploaded when they change** (`src/app/dynamic-uploads.ts`,
  installed in `LevelRenderer.create`): a `DynamicDrawUsage` vertex or index attribute is written
  only when its version moved. Every writer in the port sets `needsUpdate` after writing (particle
  pools, rain, Enhanced blood films and droplets, the glow mark batches), with update ranges where
  it knows them, so the GPU gets the same contents. Storage and indirect buffers keep three.js's
  rule. Checked: Enhanced High gas chamber with new blood added in the frame, rendered through the
  stock and the patched path: identical.
- **Allocation-free light choice** (engine-light.ts `objectLightSet`): each light's cull radius
  once per upload; the best five kept by insertion after equals (the order of the stable sort it
  replaced); no per-light arrays or records. Test: `tests/object-light-set.test.ts` (40 objects
  against the previous ranking, ties included).
- **Fire contact** (fx/effects.ts): the player's posed hit spheres once per update for all fires;
  a fire whose drawn box cannot reach them is rejected before its box is built (`FireObj.reach`:
  the box's farthest corner times the matrix's Frobenius norm, which bounds its stretch). Test:
  `tests/fire-reach.test.ts`.
- **Shadow casters** (fx/system.ts): one record per character root, rewritten each frame.

### Results

Back to back, same machine and session, `before` a copy of the tree taken when this work started
(it includes Perf A's edits of that moment), `after` the tree with these changes (and Perf A's
later ones, which change the GPU side). 12 s per scene, no profiler attached, load average 11-14.
Single runs are noisy by about ±1 ms; 10's boss fight is not the same fight twice.

Original:

| Scene | CPU ms | render ms | matrices | cull | actors | other systems | draws | GC (ms/s, longest) |
|---|---|---|---|---|---|---|---|---|
| 1a "Goose" | 8.9 → 8.5 | 4.9 → 4.3 | 1.1 → 1.3 | 0.6 → 0.6 | 0.6 → 0.6 | 1.2 → 1.2 | 317 → 308 | 1.2, 1.3 → 1.1, 1.1 |
| 1a cell row | 9.0 → 9.2 | 5.3 → 5.1 | 1.1 → 1.3 | 0.6 → 0.7 | 0.4 → 0.4 | 1.1 → 1.0 | 401 → 377 | 1.1, 1.0 → 1.2, 1.2 |
| 1a gas chamber | 11.5 → 11.0 | 6.9 → 6.4 | 1.3 → 1.3 | 0.7 → 0.7 | 0.5 → 0.5 | 1.3 → 1.3 | 701 → 624 | 2.4, 2.1 → 1.8, 1.4 |
| 3a yard | 11.2 → 9.1 | 6.4 → 5.2 | 1.3 → 1.1 | 0.5 → 0.5 | 0.6 → 0.6 | 1.7 → 1.0 | 929 → 551 | 2.5, 1.9 → 2.0, 1.2 |
| 9 lighthouse | 17.5 → 12.5 | 12.7 → 8.3 | 1.3 → 1.4 | 0.3 → 0.3 | 1.7 → 1.4 | 1.0 → 0.7 | 811 → 794 | 3.8, 4.2 → 2.2, 3.4 |
| 10 docks, boss | 14.9 → 9.6 | 9.0 → 5.3 | 2.0 → 1.4 | 0.2 → 0.2 | 1.8 → 1.3 | 1.3 → 1.0 | 641 → 474 | 4.0, 1.9 → 3.4, 1.6 |

Frame intervals were 16.7 / 16.8 ms at p50 / p95 / p99 in every Original scene after (9 before:
p95 33.3, p99 33.4).

Enhanced High (frame intervals p95 / p99):

| Scene | CPU ms | render ms | draws | p95 / p99 ms |
|---|---|---|---|---|
| 1a "Goose" | 13.4 → 11.0 | 8.8 → 6.8 | 424 → 416 | 16.8 / 33.3 → 16.8 / 16.8 |
| 1a gas chamber | 16.5 → 15.8 | 11.5 → 10.7 | 669 → 652 | 33.4 / 33.4 → 33.4 / 33.4 |
| 3a yard | 14.8 → 12.9 | 10.4 → 8.9 | 814 → 636 | 16.8 / 33.4 → 16.7 / 16.8 |
| 10 docks, boss | 15.9 → 16.7 | 11.5 → 11.0 | 773 → 710 | 16.8 / 33.3 → 33.4 / 33.4 |

A second round, after first and before second (load average 9-11), CPU / render ms and draws:

| Scene | CPU ms | render ms | draws |
|---|---|---|---|
| 1a "Goose", Original | 8.7 → 8.8 | 4.7 → 4.5 | 318 → 307 |
| 1a gas chamber, Original | 13.6 → 12.8 | 8.7 → 7.6 | 705 → 626 |
| 3a yard, Original | 12.4 → 9.9 | 7.5 → 5.7 | 925 → 553 |
| 1a gas chamber, Enhanced High | 14.2 → 14.3 | 9.7 → 9.8 | 602 → 597 |

Read together: the draw counts are exact and the CPU times move with the machine's load (about
±1 ms between runs of the same tree). 3a's yard gains 2-2.5 ms a frame in Original and 2 ms at
High, the gas chamber 0.5-1 ms, 9 and 10 3-5 ms in the one round they were in (10's fight is
never the same twice). 1a's "Goose" and cell row barely change: they had few double-sided blends
and few marks to lose. GC time fell by 15-40 % where it was highest. Enhanced High's gas chamber
uploads 3 KB of vertex data a frame instead of 2.9 MB; its main-thread time does not measurably
change (the copies were queued work, the GPU side is the saving).

### The original's animation update rate [verified in part]

SUFFERING.EXE sorts every animated object into one of four update buckets each frame (0x474c50,
called from 0x45aeb5 / 0x45c071): bucket 0 when its current clip has type-1 flag bit 1 (21 clips,
docs/re/animation.md §7) or its model is flagged, otherwise by the distance from the camera
against the skeleton's three LOD distances (the trailer's `f32[3]`, §8) divided by a per-object
scale (+0x54): the highest threshold it reaches. How often each bucket is then stepped was not
found (the reader of the lists at scene +0xb0..+0xf4 was not located). The port's own rule is
unchanged.

### Open

- **9's trees:** 153 Animating Statics x 3 materials = 439 skinned draws, about 4 ms of three.js
  time. Merging the trees of one model into one skinned mesh with a joint skeleton would make it
  about 15; that touches actor culling, the matrix pass, shadows and dismemberment.
- **Level materials:** the gas chamber draws 280 level materials (already one mesh per
  material); fewer would need texture arrays per shader structure.
- **Fire cards still draw one by one** in the main pass: merged, they would change their sort
  position against other transparent surfaces.
- **Enhanced lamp shadows** (enhanced/shadows.ts `scan`, High and Ultra): a `traverseVisible` of
  the scene every frame while a lamp shadow is active, about 0.9 ms in the gas chamber.
- **Actor culling** looks up each actor's hips bone with `getWorldPosition` twice a frame (the
  update and the pass before the draw), which recomputes the bone's ancestors each time: most of
  9's and 10's actor time.
