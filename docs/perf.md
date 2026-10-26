# Performance

Frame-rate work on the reference machine class: MacBook Pro 16" (M1 Pro, 16-core GPU, 32 GB), built-in
display 3456 x 2234 at device pixel ratio 2, Brave / Chromium with WebGPU. Each area has its own
section (Perf A: resolution and pacing; Perf B: CPU per frame; Perf C: GPU shading, compiles,
streaming; Perf D: Auto budgets, lamp halos, merged trees, actor culling, regressions; Perf E:
what limits a late frame, dynamic resolution's classifier). Numbers are headless Brave on the development Mac (the same model), which runs other
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
  a 1080p DPR 1 display Medium and High are native. (Perf D raised Medium to 3.4 Mpx, 65 %, and
  High to 2.5, 55 %.)
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
  (Perf E replaced the "main thread under 80 %" test with a window classifier and a trial step down.)
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
  Hz (ProMotion: 120 Hz rAF), when over 5 % (`PACE_LATE_SHARE`; 20 % until the third-person
  jitter report below) of a second's frames miss the display interval the game renders on every
  other display frame (a steady 60 instead of a 120 / 60 judder), and goes back after 3 s of
  frames under 70 % of the interval (backing off 5 .. 120 s when a return fails). Headless runs at
  60 Hz, so this part has unit tests and a simulated 120 Hz loop only.
- **Pacing judder band (third-person jitter report).** With the 20 % threshold, a GPU that keeps
  up with 120 Hz most of the time but not always never got paced: the frames-in-flight limit
  skipped one display frame every 6..20 (one late frame in 5..19 drawn: 5..19 %), and the game
  ran an uneven 100..115 fps, 8.3 ms frames with a 16.7 ms one every few, for as long as the load
  lasted [verified: `FramePacer` fed a 120 Hz rAF with every 10th display frame skipped stayed
  uncapped at 20 % and paces to 60 at 5 %; `tests/render-scale.test.ts`]. A few hitches a second
  (GC, a resize) stay under 5 % and keep 120 Hz. Simulated in the browser (Enhanced Medium, two
  `frame()` calls per 60 Hz rAF at T - 8.33 and T, every 10th display frame given a full GPU
  backlog): 180 drawn frames in 360 callbacks, every interval 16.5..16.8 ms. Whether the reference
  machine sat in that band is [inferred] (no 120 Hz display here); the jitter they saw in the
  hand was the held weapon's one-frame lag (docs/game-logic.md §4.5 "Held weapon placement"),
  which does not depend on the display. Perf A's gains are unchanged: the cap only engages where
  120 Hz was already being missed.
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
  about 15; that touches actor culling, the matrix pass, shadows and dismemberment. (Perf D:
  merged in Enhanced; Original keeps them, see there.)
- **Level materials:** the gas chamber draws 280 level materials (already one mesh per
  material); fewer would need texture arrays per shader structure.
- **Fire cards still draw one by one** in the main pass: merged, they would change their sort
  position against other transparent surfaces.
- **Enhanced lamp shadows** (enhanced/shadows.ts `scan`, High and Ultra): a `traverseVisible` of
  the scene every frame while a lamp shadow is active, about 0.9 ms in the gas chamber.
- **Actor culling** looks up each actor's hips bone with `getWorldPosition` twice a frame (the
  update and the pass before the draw), which recomputes the bone's ancestors each time: most of
  9's and 10's actor time. (Perf D: done.)

## Perf C: GPU cost per pixel, compiles, tier switches

### How it was measured

- **GPU time per pass** (`scratchpad/perfC/bench.mjs`): `?gputime` (WebGPU timestamp queries) with
  Brave at `--enable-dawn-features=allow_unsafe_apis` (unquantised timestamps); each render pass
  is labelled by its target (`enhanced-volumetric`, `GTAONode.AO`, `output` = the scene pass, `rt`
  = full-resolution post passes, `canvas`). Apple's GPUs overlap passes, so the raw intervals sum
  to several times the frame [verified, as Perf A found]; here every pass is credited only with the
  time no earlier-starting pass covers (sorted by start: end − max(start, latest end so far)), and
  "busy" is the union of the intervals. Those add up to the frame and track it: Medium at native
  went from 47 fps with 21 ms busy to 60 fps with 15 ms [verified].
- Window 1728 x 1117 at DPR 2. The dev page has a sidebar, so "native" here is 2896 x 1960
  (5.7 Mpx); the game page is 3456 x 2234 (7.7 Mpx). `?scale=1` for the per-pass tables (fixed
  pixels), the default Auto for the cinematic (what a player gets).
- Before = a copy of HEAD 639b64d, after = the tree with these changes, both served by their own
  dev server, back to back, one browser at a time; load average 4-16 (other agents running).

### Where the GPU time went (before)

Medium at native, 1a cell row: busy 21.6 ms, of which volumetrics 8.1, GTAO 5.0, the scene pass
3.9, the full-resolution post passes 2.5 (grade, FXAA, HDR copy), bloom 1.3 in all, the canvas
copy with its 4x MSAA 1.0. High: busy 34 ms, volumetrics 15.1 (24 steps, 6 lamps), GTAO 6.1, scene
6.2, TRAA 1.4. Original: 7-9 ms, almost all the MSAA frame pass: it was never the problem.

Inside the volumetric march (Medium, by removing one part at a time) [verified]: the dust noise
(three.js's MaterialX Perlin noise, `mx_noise_float`, evaluated at every step) 3.6 of 7.7 ms; the
lamp halos (4 lamps × 16 steps) 2.4 ms; the rest (flashlight beam, shadow lookups) 1.7 ms. GTAO's
cost was cache misses: its taps read the full-resolution depth (23 MB) and its 0.6 m kernel spans
much of the screen near the camera; halving the radius (only to test) took it from 5.0 to 3.1 ms.

The surface shaders (dumped WGSL of a level surface) evaluated the flashlight radiance with its
PCF loop twice per fragment (once for the light factor, once for the specular), and each lamp cube
shadow's 5 taps twice too: the two Enhanced hooks built them as separate calls.

### Fixes

| Change | Where | Effect (Medium / High, native, 1a) |
|---|---|---|
| Dust noise baked once into a 64³ R8 tiling texture: MaterialX's own Perlin noise (same hash, gradients, fade, scale), lattice wrapped every 16 cells (36 m), 4 texels per cell; one trilinear fetch per step | `enhanced/dust-noise.ts` (new), `volumetric.ts` | volumetrics 8.1 → 3.9 / 15.1 → 7.6 ms |
| Volumetric flashlight beam: its shadow lookup and phase only where the beam reaches (cone × range × start > 0); moonlight block only with a moonlight map (uniform branch); the phase function without `pow` | `volumetric.ts` | included above; exact (zero terms skipped) |
| Surface shading: the flashlight radiance and both lamp-cube lookups built once per graph and shared by the light factor and the specular (`fragmentTerms`); PCF taps only inside the shadow frustum and where the beam is non-zero; lamp specular skipped for lamps behind the surface (GGX carries N·L) | `enhanced/shading.ts` | scene pass 6.2 → 4.7 ms at High; exact |
| GTAO reads a copy of the depth at its own (half) resolution: a depth-only quad pass writes the nearest full-resolution depth at each half-resolution texel centre into a depth texture | `enhanced/half-depth.ts` (new), `post.ts` | GTAO 5.0 → 3.0 / 6.1 → 3.3 ms |
| Enhanced canvas without MSAA (`antialias: !ENHANCED`): it only receives full-screen quads after TRAA / FXAA. The precompile failure Perf A hit was the scene being compiled for the insanity effects' target (4x MSAA, no longer sharing the canvas's state), into which Enhanced never draws the scene: with own passes those targets are skipped | `renderer.ts` | MSAA canvas pass 0.6 → 0 ms; Original keeps `antialias: true` |
| Tier switches: the scene pass has the same attachments (colour + velocity) at every tier and the scene / viewmodel passes keep one render context whatever their nesting depth (below) | `post.ts` | no scene shader rebuilt on a switch |

Busy GPU time and frame times at native (`?scale=1`), before → after
(`scratchpad/perfC/before-native.json`, `after2-native.json`); ms per frame:

| Scene | Tier | GPU busy | scene pass | volumetrics | GTAO | fps | p50 / p95 / p99 |
|---|---|---|---|---|---|---|---|
| 1a Goose cine | Medium | 22.9 → 16.5 | 3.8 → 3.3 | 8.1 → 3.8 | 6.2 → 5.3 | 43.5 → 59.4 | 16.7/33.4/33.4 → 16.7/16.8/33.2 |
| 1a cell row | Medium | 21.6 → 14.9 | 3.9 → 4.1 | 8.1 → 3.9 | 5.0 → 3.0 | 46.3 → 60 | 16.7/33.4/33.4 → 16.7/16.8/16.8 |
| 1a guard | Medium | 21.4 → 15.3 | 3.4 → 3.8 | 8.3 → 3.8 | 5.8 → 4.6 | 46.9 → 60 | 16.7/33.4/33.4 → 16.7/16.8/16.8 |
| 1a gas chamber | Medium | 21.0 → 13.6 | 3.4 → 3.2 | 8.6 → 3.9 | 5.3 → 3.4 | 47.5 → 60 | 16.7/33.4/33.4 → 16.7/16.8/16.8 |
| 3a yard | Medium | 18.5 → 12.6 | 3.6 → 4.1 | 6.9 → 2.8 | 3.6 → 2.0 | 53 → 60 | 16.7/33.4/33.5 → 16.7/16.7/16.8 |
| 6a woods | Medium | 18.0 → 12.4 | 2.4 → 2.5 | 6.9 → 2.8 | 4.5 → 3.5 | 55.6 → 60 | 16.7/33.3/33.4 → 16.7/16.7/16.8 |
| 1a Goose cine | High | 36.3 → 24.5 | 6.1 → 4.5 | 15.6 → 8.0 | 8.4 → 6.7 | 27.3 → 40.6 | 33.4/50/50.1 → 16.7/33.4/33.4 |
| 1a cell row | High | 33.9 → 21.0 | 6.2 → 4.7 | 15.1 → 7.6 | 6.1 → 3.3 | 29.5 → 47.3 | 33.3/50/50.1 → 16.7/33.4/33.4 |
| 1a guard | High | 35.4 → 22.8 | 6.0 → 4.5 | 16.0 → 8.1 | 7.7 → 5.5 | 28.3 → 43.7 | 33.3/50/50.1 → 16.7/33.4/33.4 |
| 1a gas chamber | High | 32.6 → 20.6 | 5.1 → 3.9 | 15.6 → 8.2 | 6.6 → 3.9 | 30.7 → 48.6 | 33.3/33.4/33.5 → 16.7/33.3/33.4 |
| 3a yard | High | 27.0 → 17.1 | 6.3 → 5.1 | 11.2 → 5.0 | 4.0 → 2.1 | 36.9 → 58.3 | 33.3/33.4/33.4 → 16.7/16.8/33.3 |
| 6a woods | High | 25.7 → 16.8 | 3.5 → 2.8 | 10.9 → 4.9 | 5.5 → 4.2 | 38.9 → 59.3 | 33.2/33.4/33.4 → 16.7/16.8/33.3 |
| 1a (4 poses), 3a, 6a | Low | 8.4-13.3 → 8.0-10.5 | | 2.4-2.7 → 1.0-1.5 | off | 60 → 60 | 16.7/16.8/16.8 both |
| 1a, 3a, 6a | Original | 7.5-9.6 → 6.9-9.3 | | | | 60 → 60 | 16.7/16.8/16.8 both |

(The scene pass at Medium gained about 0.4 ms from writing the velocity attachment, see tier
switches; at High it lost 1.3-1.5 ms to the shared terms. Original's code paths are unchanged;
its spread is run-to-run noise.)

The opening cinematic at the default Auto resolution, fresh browser per tier (no shader cache;
25 s from the first frame after the loading screen), before → after
(`cold-before-*.json`, `cold-after2-*.json`):

| Tier | Internal size (Auto) | fps | p50 / p95 / p99 / max ms | frames > 33 ms |
|---|---|---|---|---|
| Original | 2896 x 1960 → same | 60 → 60 | 16.7/16.7/16.8/16.8 → 16.7/16.8/16.8/16.8 | 0 → 0 |
| Medium | 2027 x 1372 → same (at Perf A's 3.0 Mpx cap) | 59.6 → 60 | 16.7/16.8/16.8/33.4 → 16.7/16.7/16.8/33.4 | 4 → 1 |
| High | 1303 x 882 (45 %) → 1737 x 1176 (60 %) | 57.2 → 60 | 16.7/16.8/33.4/33.4 → 16.7/16.8/16.8/16.8 | 18 → 0 |

At High, Auto's dynamic resolution now settles at 1.78 times the pixels and holds 60 with p99 =
p50. Medium sits at its pixel budget (Perf A's `PIXEL_BUDGET`); with this work Medium runs 60 fps
at full native resolution in the bench above, so that budget could be raised (Open).

### Stutter (shader compiles, uploads)

- **The cinematic and first sight**: with a cold browser the opening cinematic had no frame over
  33 ms at Original and Medium before or after (the load-time precompile covers its characters,
  props and effects); no long animation frame (over 50 ms) was recorded in any cinematic window.
  The worst frame in the first 1.5 s at each fresh pose (cell row, guard post, gas chamber, 3a,
  6a), before → after: Original 16.8-33.5 → 16.8 ms, Low 16.8-33.4 → 16.8, Medium 33.4-50 →
  16.8-33.3, High 50-167 → 33.4-50 [verified, `first` in the bench JSON]. Those were GPU-bound
  frames, not compiles (no node builds, no long tasks), and fell with the GPU work. Texture
  uploads, audio decoding and GC did not show up as frames over 33 ms in these runs; texture
  enhancement decodes with `createImageBitmap` and three.js generates the mipmaps on the GPU, so
  nothing was changed there (its pixel read-back for cut-out mip chains is main-thread work, worth
  watching if a level's first sight hitches).
- **Tier switches** (Perf A's open item). Two causes [verified, by logging every node build that
  missed three.js's cache during a switch]: (1) the scene pass made its velocity attachment only
  on the TRAA tiers (a PassNode creates an MRT texture only for an output someone reads), and
  three.js keys every object's shader state by its render context, which counts attachments; (2)
  contexts are also keyed by the render-call depth, which TRAA changes for the viewmodel pass. A
  switch into or out of a TRAA tier rebuilt the shaders of everything in view: 54-58 node builds,
  a 600-680 ms main-thread frame, each time (`newNodeBuilds` in `sw*.js` runs). Now the scene pass
  always has colour + velocity with one MRT node for every tier's chain, and the scene and viewmodel
  passes are pinned to one context (`RenderContexts.get` with depth 0 for their own MRT nodes, which
  no other render uses). A switch now rebuilds only the post chain (10-13 pipelines, no scene node
  builds): medium → high, medium, ultra, low, high: worst frames 50 / 50 / 83 / 67 / 33 ms instead of
  683 / 50 / 667 / 33 / 667 ms. In the bench's sequence (`?scale=1`, no timestamps): high 292
  frames in 6 s, worst 33 ms (before 170 frames, worst 633 ms); ultra 113 frames, worst 67 ms (83,
  583 ms). Ultra is slow at native resolution regardless.
- **`?gputime` itself can stall the GPU**: with timestamp queries on, a High / Ultra frame's many
  passes (lamp cube faces) overflow three.js's query pool and the GPU process stopped presenting
  for seconds after a switch (0-2 frames in 6 s, reproducible); without the queries the same
  sequence has no stall. Perf A's "over 6 s" switch stalls may have been this. QA only: measure
  switches without `?gputime`.

### Visuals

Frames at fixed poses (`?scale=1`, flashlight on), before against after, mean absolute
difference of display luma on an 1/8-resolution grid (`scratchpad/perfC/shots/*.json`): Original
0.00-0.8 levels of 255 (cell row and close-up floor 0.00; the rest is animated content: alarm, rain),
Enhanced Medium 0.16-0.62, High 0.16-1.9 (1a gas 1.3, guard 1.9: the animated alarm and fog
noise). Mean luma, near-black and clipped shares per pose change by at most 1 level / 1.5 points.
The dust pattern is the same noise function, now sampled from a texture; it drifts as before.

### Not changed (measured, kept)

- Bloom: 1.0-1.3 ms in all at native (5 mips from half resolution); PCF taps (4 / 9 / 16) are
  now half the work they were; AO samples and volumetric steps per tier unchanged (they set the
  look; their per-sample cost is what fell).
- Texture bandwidth: Medium has no upscaled albedo (High / Ultra only), every enhanced texture
  has mipmaps, anisotropy 8 (Medium) / 16 (High). The scene pass is 3-5 ms at native, so texture
  sampling is not where the time goes.

### Open

- Perf A's Auto pixel budgets were set before this work: Enhanced Medium (3.0 Mpx) and High
  (2.2 Mpx) could rise; High at native now runs 41-59 fps in the bench above (it was 27-39).
  (Perf D: 3.4 and 2.5.)
- High's volumetrics are still the largest pass (7.6-8.2 ms at native in 1a: 24 steps × 6 lamps);
  the lamp halo loop is the next candidate (an analytic in-scatter per unshadowed lamp would
  remove the per-step lamp loop but loses the dust modulation on the halos). (Perf D: the loop
  reordered, a third cheaper, same sum.)
- A tier switch still compiles the post chain (10-13 pipelines, up to 83 ms).

## Perf D: Auto budgets, lamp halos, 9's trees, actor culling, new per-frame costs

### How it was measured

`scratchpad/perf2/bench.mjs`: headless Brave, window 1728 x 1254 at `--force-device-scale-factor=2`
with the developer sidebar hidden, so the canvas is the user's 3456 x 2234 drawing buffer at 100 %
(the headless window's chrome takes 137 px of height: 1117 gave 980 CSS px). Developer deep link
per level, player invulnerable, Perf B's scenes (1a's "Goose" 8 s in, the cell row, the gas
chamber, 3a's yard, 9 outside the lighthouse base, 10 on the dock) plus 6a's woods (player at
Perf C's pose). Per scene: fps and frame-time percentiles over 8 s, main-thread time and the frame
probe's sections, draws per frame, the internal size; with `--gpu`, Perf C's overlap-corrected
GPU time per pass. `--sweep` sets fixed scales in one load, `--budgets` runs the default Auto
(dynamic resolution) with candidate pixel budgets. `before` = a copy of the tree when this work
started (HEAD 4ce8320 plus the other agents' edits of that moment), `base` = the Perf C commit
c3eb08b, `after` = the tree with these changes.

**The GPU was shared.** One to three other agents' headless Brave sessions ran playthroughs
throughout (load average 8-25). GPU timestamps measure wall time on the GPU, so every GPU figure here
includes the other session's work: Medium at native was 25-33 ms busy, where Perf C measured
12.4-16.5 ms at 5.7 Mpx (1.35 times fewer pixels) on a quieter machine, about 1.5 times what the
pixels alone explain. Comparisons were made back to back or alternating within one page load; the
budget choice below keeps that factor as part of its margin.

### Auto pixel budgets (render-scale.ts `PIXEL_BUDGET`)

Fixed scales after this work, Medium and High in one load per scene; fps / p95 ms / GPU busy ms
(`sweep1.json`; the 65 % and second 55 % columns from `sweep2.json`, a later load):

| Scene | Medium 60 % (2.78 Mpx) | Medium 65 % (3.26) | Medium 70 % (3.78) | Medium 80 % (4.94) | High 50 % (1.93) | High 55 % (2.33) | High 55 %, again | High 60 % (2.78) |
|---|---|---|---|---|---|---|---|---|
| 1a "Goose" | 60 / 16.7 / 8.2 | – | 60 / 16.7 / 11.3 | 55.5 / 33.3 / 16.4 | 59 / 16.7 / 11.6 | 60 / 16.8 / 10.2 | – | 60 / 16.8 / 10.6 |
| 1a cell row | 60 / 16.8 / 11.4 | 60 / 16.7 / 12.3 | 60 / 16.8 / 15.1 | 47.1 / 33.4 / 19.9 | 60 / 16.7 / 14.1 | 60 / 16.8 / 15.4 | 60 / 16.7 / 12.3 | 60 / 16.8 / 15.4 |
| 1a gas chamber | 60 / 16.7 / 10.8 | 59.5 / 16.8 / 11.1 | 59.8 / 16.7 / 16.1 | 46 / 33.4 / 20.3 | 60 / 16.8 / 9.1 | 59.5 / 16.8 / 12.1 | 59.8 / 16.7 / 10.5 | 57 / 16.8 / 16.0 |
| 3a yard | 59.5 / 16.8 / 11.0 | 60 / 16.8 / 13.4 | 55 / 33.3 / 17.6 | 46.9 / 33.4 / 21.4 | 60 / 16.7 / 10.5 | 60 / 16.8 / 11.5 | 60 / 16.8 / 13.8 | 59.8 / 16.7 / 16.1 |
| 6a woods | 60 / 16.8 / 13.3 | 60 / 16.8 / 11.9 | 60 / 16.7 / 15.0 | 56.7 / 33.3 / 17.5 | 60 / 16.7 / 11.7 | 60 / 16.7 / 12.5 | 60 / 16.7 / 13.4 | 60 / 16.8 / 14.1 |
| 9 lighthouse | 60 / 16.8 / 9.4 | – | 36.5 / 33.3 / 12.7 | 50.9 / 33.4 / 18.9 | 60 / 16.8 / 9.5 | 60 / 16.7 / 10.5 | – | 57.8 / 16.8 / 14.7 |

The default Auto (dynamic resolution under the cap) with candidate budgets, 7 s to adapt, then
6 s measured (`auto1.json`); fps (p95 / p99 ms). Dynamic resolution stayed at the cap in every
window:

| Scene | Medium 3.0 (60 %) | 3.4 (65 %) | 3.8 (70 %) | High 2.2 (50 %) | 2.5 (55 %) | 2.8 (60 %) |
|---|---|---|---|---|---|---|
| 1a "Goose" | 59.8 (16.8 / 16.8) | 59.2 (16.8 / 33.3) | 60 (16.7 / 16.8) | 60 (16.8 / 16.8) | 60 (16.7 / 16.8) | 60 (16.8 / 16.8) |
| 1a cell row | 60 (16.7 / 16.8) | 60 (16.8 / 16.8) | 60 (16.7 / 16.8) | 60 (16.8 / 16.8) | 60 (16.8 / 16.8) | 60 (16.7 / 16.8) |
| 1a gas chamber | 60 (16.7 / 16.8) | 60 (16.8 / 16.8) | 60 (16.7 / 16.8) | 59.5 (16.7 / 16.8) | 59 (16.8 / 33.3) | 57.3 (16.8 / 33.4) |
| 3a yard | 60 (16.8 / 16.8) | 60 (16.7 / 16.8) | 60 (16.8 / 16.8) | 60 (16.7 / 16.8) | 60 (16.7 / 16.8) | 59.8 (16.8 / 16.8) |
| 6a woods | 60 (16.7 / 16.8) | 60 (16.7 / 16.8) | 58.2 (16.7 / 16.8) | 60 (16.7 / 16.8) | 60 (16.7 / 16.8) | 55.2 (16.8 / 83.3) |
| 9 lighthouse | 56.3 (33.3 / 33.4) | 57.8 (16.8 / 33.4) | 59.8 (16.8 / 16.8) | 59.7 (16.7 / 16.8) | 60 (16.8 / 16.8) | 55.5 (33.3 / 33.4) |

(Budgets are quantised to the 5 % ladder: on 3456 x 2234, 4.2 Mpx is also 70 % and 3.1 also
60 %.) 9's misses at the lower Medium budgets are main-thread frames of its fight (14 ms in those
windows), not resolution.

New budgets: **Medium 3.0 → 3.4 Mpx** (60 → 65 % on the reference display, 1.17 times the pixels)
and **High 2.2 → 2.5 Mpx** (50 → 55 %, 1.21 times). At those scales every heaviest scene held
60 fps with p95 ≤ 16.8 ms (one 16.8 ms interval is an on-time frame at 60 Hz) and kept the GPU
busy 10.2-15.4 ms, most of them 11-13.8, on a GPU that was also running other sessions. One step
more is where frames went: Medium 70 % reached 15-17.6 ms busy (3a's yard 55 fps in one load) and
High 60 % 14-17.5 ms (the cell row, gas chamber and 9 under 60). Dynamic resolution only steps
down after late frames, and not at all while the main thread looks busy (a GPU backlog shows up as
main-thread time in WebGPU calls; the gas chamber at High runs 13.6-20 ms of main thread under
this machine's load), so the cap itself keeps the margin. Low (4.2) and Ultra (1.9) unchanged.

### High volumetrics: the lamp halo loop (enhanced/volumetric.ts)

Where the volumetric pass went at High, 1a's cell row, 3456 x 2234 native (`?scale=1`; its target
1728 x 1117), by turning parts off in one loaded page (`vol-ab.js`, alternating runs, ms):

| Variant | volumetric pass |
|---|---|
| as before (lamp loop inside each of the 24 steps, 6 lamps, 1 cube-shadowed) | 15.2-16.6 |
| no lamps | 4.1-5.1 |
| no lamps, no flashlight beam work | 2.9-3.4 |
| lamps after the march, scalar (below) | 10.4-12.3 |
| the same without the cube-shadow lookup (only to measure) | 10.6-11.0 |

The lamps were 11-12 ms of it: arithmetic (6 × 24 lamp-steps per pixel, each with a vector
distance, a normalize, the phase's square root and division, and five vector multiplies), plus
about 2.5 ms of cube-shadow lookups for the one shadowed lamp (about 1 ms after the change). Per-tile or screen-extent culling
does not help here: a lamp's halo is I / d² with no range, and in the cell row all six lamps are
3-11 m away with I ≈ 4, so every pixel gets a visible share of each.

Fix: the same sum, reordered. The march keeps each step's weight (dust density × fog
transmittance × step length) in a 24-entry array; the lamps are summed after it, one lamp at a
time: its offset from the eye is taken once (c0 = |eye − lamp|², c1 = (eye − lamp)·dir), so a step
is |v|² = c0 + t (2 c1 + t), one inverse square root for the distance and the angle, one for the
Henyey-Greenstein term (x^-1.5), and a scalar multiply-add; the colour, the scatter gain and the
phase constant multiply the lamp's sum once; the shadowed / plain choice is made per lamp, not per
step. Same steps, same jitter, same terms. **Volumetric pass 16.6 → 11.3 ms** at native High
(alternating in one page; the frame's GPU busy time 43-44 → 38-41 ms there), Medium's 4 × 16 lamp loop the same way. The
array costs about 2 ms of that (measured by replacing it with a constant), a lamp loop inside
the step loop with the scalar arithmetic (no array) was slower (13.9-14.2 ms), and unrolled over
the six lamps the same as the array version.

Image check: the volumetric buffer read back with the jitter fixed and time frozen, before vs
after: mean absolute difference 6 × 10⁻⁶ (linear), below the variation between two renders of the
unchanged shader (7.6 × 10⁻⁵: the frame's own flicker), against a mean of 9 × 10⁻⁴.

### 9's trees (actors/decor-batch.ts, Enhanced)

9 places 248 skinned Animating Statics of 6 tree models (4-5 bones, 25-685 vertices, two or three
opaque / cut-out materials each); 153 are drawn from the lighthouse base: 439 draws, and at
Medium / High 1108 draws a frame with the shadow passes, 18 ms of main thread (48 fps).

Per tree model, one SkinnedMesh at the origin draws every member: the model's vertices repeated
per member, skin indices moved into one skeleton made of the members' own bones and bone
inverses (the trees keep their Actor, Character, mixer and place in the scene graph; culling,
level logic and animation work on them as before). A member is drawn while its own mesh would be
(it and its ancestors visible: the actor culling and level logic decide); the others get zero
bone matrices for the frame, which collapses their triangles. The members' own meshes go to
`BATCHED_LAYER` (engine-light.ts), which only the projected-shadow silhouette cameras see, so each
tree still casts its own projected shadow. Lighting stays per tree: each member's light set
(objectLightSet, chosen on its own bounds as for its own draw) is packed every frame into a
uniform array the merged materials read per vertex (`lightSlot` attribute; engine-light.ts
`ObjectSetNodes`, a new `objectSet` option of the light-set graph). A member whose mesh changes
material, geometry or skeleton leaves the merged draw and is drawn on its own again; the merged
materials follow the sources' map and blend state (texture enhancement). Trees do not dismember
or take wounds (decorations take no damage); the merged mesh has no raycast (hit tests use the
members' collision as before).

**Original keeps one draw per tree.** Merged, Original's 9 at a frozen time (`?decorbatch`, timer
stopped, fly camera) differed from the per-tree draws in 0.67 % of the pixels, by 1.25 levels on
average (up to 40 on edges): three.js draws a skinned mesh through its own world matrix and back
(bind matrix inverse, then the model and model-view matrices, in float32) where the merged draw
goes straight to world space, so positions and normals differ in their last bits. Matching that
bit for bit would mean re-implementing three.js's skinning, model-view and fog-depth chain per
member. So the merge is Enhanced only (`DECOR_BATCH`; `?decorbatch` turns it on in Original for
comparisons, `?nodecorbatch` off): there Original's 12.9 ms (60 fps) stays as it was, and merging
it would give 8.4 ms (draws 778 → 355) at that cost.

9 at Medium: 1108 → 472 draws, 17.4 → 13.8 ms of main thread, 52.7 → 59.5 fps; at High 1109 → 473,
16.1 → 12.0 ms, 54.2 → 59.9 fps (Results). The merge also applies to the smaller groups of
decorations elsewhere (3a 638 → 588 draws at High, 6a 259 → 241). The
merged and per-tree frames at a frozen time differ less than two consecutive frames of either
(TRAA and dither: 83 % of pixels by 2.6 levels on average against 97 % by 3.5); shadows of the
trees on the ground and in the moonlight shafts are drawn by the merged meshes.

Spot check: `node tools/playthrough.mjs --level 9 --to 9.infernas --query 'gfx=enhanced&tier=high'
--window 1728,1117,2 --invulnerable`: 3 / 3 steps ok (arrival, out of the lighthouse base, the three
Infernas fought down), fps min 60, draws at most 632 (the trees drawn; `scratchpad/perf2/pt/shots`).

### Actor culling (actors/manager.ts `hipsWorldPosition`)

The culling found each actor's hips with `getWorldPosition` in the update and again in the
visibility pass before the draw. That recomposes and multiplies the matrices of the hips and
its four ancestors (and writes them) each time: in 9 (300 actors, Original) 48.5 ms per second
of `getWorldPosition` in the CPU profile, 0.8 ms a frame, half of the actors' 1.6 ms. Now the hips
position is carried up the chain as a vector (scale, rotate, translate per ancestor) without
writing any matrix, following three.js's rules for nodes whose world matrix it would keep (the
scene: no matrixWorldAutoUpdate; no matrixAutoUpdate and no matrixWorldNeedsUpdate). Test:
`tests/hips-world.test.ts` (200 random chains against getWorldPosition, matrices unchanged).
Original, the actors' section of the frame probe before → after (default Auto, `before-auto.json` /
`after-auto.json`): cell row 0.50 → 0.39 ms, gas chamber 0.57 → 0.49, 3a 0.80 → 0.63, 6a 1.25 → 1.06,
9 1.56 → 1.31, 10 1.98 → 1.47.

### New per-frame costs of the last two days (regressions against Perf B / C)

Perf C's commit (c3eb08b, `base`) against the tree at the start of this work (`before`): the
Original and High CPU tables below, and GPU per pass at native (`?scale=1`) for Original and
Medium in the cell row, gas chamber and 3a, twice each, alternating trees (`gpu-*.json`):

| Scene | Original busy ms base / before | Medium busy | Medium scene pass | Medium volumetrics | Medium GTAO |
|---|---|---|---|---|---|
| 1a cell row | 10.4, 9.2 / 13.1, 8.4 | 30.3, 30.8 / 29.1, 29.4 | 6.9, 5.9 / 5.9, 6.8 | 7.1, 7.5 / 7.1, 7.0 | 5.2, 6.5 / 5.7, 5.3 |
| 1a gas chamber | 10.5, 9.7 / 9.8, 9.2 | 31.9, 35.1 / 28.7, 31.3 | 7.1, 7.8 / 6.5, 7.0 | 8.3, 7.5 / 6.6, 7.5 | 6.9, 7.6 / 6.3, 7.0 |
| 3a yard | 11.5, 9.2 / 13.3, 11.3 | 25.0, 23.8 / 22.5, 24.7 | 5.2, 4.7 / 4.6, 4.5 | 5.5, 4.9 / 4.8, 5.5 | 3.9, 3.8 / 3.7, 4.2 |

No GPU regression: the engine-light Fn hoist (221ad54) takes the position and normal into
variables in the vertex stage, which costs nothing per pixel; the vertex-alpha graphs (8340318)
apply only to the few .ldu objects with vertex alpha. Main thread: the frame-probe sections moved
together with the machine's load (every section of a run up or down by the same share), not one
system; the hit-reaction states (`player` 0.13-0.25 ms), weapons (0.3-0.45 ms, including the
melee auto-face, which picks only during a strike's states), save / projector state (`save`
0.02 ms) and speech are all within noise. Draw counts rose by 8-12 in 1a and 3a (383 vs 374 in
the cell row): new objects drawn, not a per-frame cost of note (about 0.1 ms). 10's draws vary
with where the fight takes the player (402-1011 in these runs), as in Perf B.

### Results

Original, default Auto (100 %), before → after back to back (load average 8-15; `before-auto.json`,
`after-auto.json`):

| Scene | Mode | fps | p95 ms | main thread ms | actors ms | draws | internal |
|---|---|---|---|---|---|---|---|
| 1a "Goose" | original | 60 → 60 | 16.7 → 16.8 | 8.03 → 8.94 | 0.55 → 0.60 | 304 → 304 | 100 → 100 % (7.72 → 7.72 Mpx) |
| 1a cell row | original | 60 → 60 | 16.8 → 16.7 | 10.77 → 9.81 | 0.50 → 0.39 | 383 → 384 | 100 → 100 % (7.72 → 7.72 Mpx) |
| 1a gas chamber | original | 59.9 → 60 | 16.8 → 16.8 | 13.47 → 12.46 | 0.57 → 0.49 | 617 → 616 | 100 → 100 % (7.72 → 7.72 Mpx) |
| 3a yard | original | 60 → 59.6 | 16.8 → 16.8 | 12.22 → 10.91 | 0.80 → 0.63 | 556 → 553 | 100 → 100 % (7.72 → 7.72 Mpx) |
| 6a woods | original | 60 → 60 | 16.7 → 16.7 | 7.23 → 6.52 | 1.25 → 1.06 | 129 → 127 | 100 → 100 % (7.72 → 7.72 Mpx) |
| 9 lighthouse | original | 60 → 60 | 16.7 → 16.7 | 12.91 → 13.35 | 1.56 → 1.31 | 778 → 778 | 100 → 100 % (7.72 → 7.72 Mpx) |
| 10 docks | original | 50.8 → 59.9 | 33.3 → 16.7 | 19.02 → 12.87 | 1.98 → 1.47 | 1011 → 573 | 100 → 100 % (7.72 → 7.72 Mpx) |

Enhanced Medium and High, default Auto, alternating trees per tier (before Medium, after Medium,
before High, after High; load average 12-25 with three other browser sessions; `final-*.json`).
After includes the new budgets (65 % / 55 %); 6a's Medium window had dynamic resolution step down
to 55 % after late frames; 10's fight puts the player somewhere else each run (its draws are where
the camera looks):

| Scene | Mode | fps | p95 ms | main thread ms | actors ms | draws | internal |
|---|---|---|---|---|---|---|---|
| 1a "Goose" | medium | 59.3 → 59.9 | 16.7 → 16.8 | 13.13 → 12.26 | 0.86 → 0.71 | 303 → 304 | 60 → 65 % (2.78 → 3.26 Mpx) |
| 1a cell row | medium | 59.9 → 59.5 | 16.7 → 16.8 | 14.01 → 14.52 | 0.55 → 0.51 | 369 → 370 | 60 → 65 % (2.78 → 3.26 Mpx) |
| 1a gas chamber | medium | 49.1 → 56.8 | 33.4 → 33.3 | 18.75 → 15.25 | 0.67 → 0.52 | 570 → 569 | 60 → 65 % (2.78 → 3.26 Mpx) |
| 3a yard | medium | 60 → 58.9 | 16.8 → 16.8 | 13.08 → 13.26 | 0.67 → 0.67 | 600 → 587 | 60 → 65 % (2.78 → 3.26 Mpx) |
| 6a woods | medium | 59.9 → 57.9 | 16.7 → 16.8 | 8.15 → 10.21 | 1.08 → 1.19 | 222 → 204 | 60 → 55 % (2.78 → 2.33 Mpx) |
| 9 lighthouse | medium | 52.7 → 59.5 | 33.3 → 16.8 | 17.38 → 13.76 | 1.59 → 1.54 | 1108 → 472 | 60 → 65 % (2.78 → 3.26 Mpx) |
| 10 docks | medium | 57.6 → 48.7 | 16.7 → 33.4 | 12.43 → 19.04 | 1.79 → 2.00 | 445 → 703 | 60 → 65 % (2.78 → 3.26 Mpx) |
| 1a "Goose" | high | 59.1 → 59.9 | 16.8 → 16.7 | 12.69 → 10.91 | 0.71 → 0.55 | 400 → 401 | 50 → 55 % (1.93 → 2.33 Mpx) |
| 1a cell row | high | 60 → 60 | 16.7 → 16.7 | 11.92 → 11.41 | 0.48 → 0.39 | 375 → 375 | 50 → 55 % (1.93 → 2.33 Mpx) |
| 1a gas chamber | high | 55 → 57.5 | 33.3 → 16.8 | 15.49 → 14.81 | 0.58 → 0.51 | 586 → 586 | 50 → 55 % (1.93 → 2.33 Mpx) |
| 3a yard | high | 55.5 → 60 | 16.8 → 16.8 | 14.56 → 11.88 | 0.93 → 0.58 | 638 → 588 | 50 → 55 % (1.93 → 2.33 Mpx) |
| 6a woods | high | 60 → 60 | 16.7 → 16.8 | 8.99 → 8.25 | 1.43 → 1.05 | 259 → 241 | 50 → 55 % (1.93 → 2.33 Mpx) |
| 9 lighthouse | high | 54.2 → 59.9 | 33.3 → 16.8 | 16.12 → 11.99 | 1.41 → 1.34 | 1109 → 473 | 50 → 55 % (1.93 → 2.33 Mpx) |
| 10 docks | high | 38.8 → 34.3 | 66.6 → 66.7 | 23.76 → 27.44 | 2.34 → 3.53 | 679 → 543 | 50 → 55 % (1.93 → 2.33 Mpx) |

Original's frame is unchanged in what it draws: its shaders (WGSL from `renderer.debug.getShaderAsync`)
of 60 static and 26 skinned objects in 9 are the same text before and after these changes except
the uniform-buffer ids three.js numbers its bone buffers with (`wgsl-*.json`, `wsk-*.json`, compared
on a copy of `before` with only these changes applied, since the other agents' edits of the same
hours change static surfaces' alpha); the decorations are not merged there, and the culling's hips
position is the same value (test above). Its main thread is 0.2-0.5 ms lower where actors are many
(the hips), and the same elsewhere within the run-to-run spread.

### Open

- Original's 9 still draws its trees one by one (12.9 ms main thread, 60 fps; a 120 Hz display is
  paced to 60 there): merging them exactly needs per-member model / model-view / normal matrices
  in the vertex stage (three.js's skinned path re-implemented), or accepting the last-bit
  differences above.
- The volumetric weight array costs about 2 ms at native High; a march that keeps the weights in
  registers (unrolled at build time) would save part of it at a larger shader.
- Budgets were measured on a shared GPU; a quiet M1 Pro may take Medium 70 % / High 60 %, which
  dynamic resolution cannot find on its own (it probes only below the cap).
- Dynamic resolution treats a frame whose main thread is over 80 % of the interval as CPU-bound and
  never lowers the scale for it; when the GPU is behind, WebGPU calls block and that time counts as
  main thread (the gas chamber at High: 13.6-20 ms), so a GPU-bound frame can pass for a CPU-bound
  one. (Perf E: the calls do not block; the main-thread time is real JS, and the rule compared it
  with the target interval instead of asking whether frames waited for the GPU. Fixed there.)

## Perf E: what limits a late frame (dynamic resolution's classifier)

Perf D left open that dynamic resolution never stepped down while the main thread looked busy:
the gas chamber at Enhanced High showed 13.6-20 ms of main thread and stayed at its cap while
GPU-bound. The idea was that a GPU backlog shows up as main-thread time inside WebGPU calls.

### Trace (how it was measured)

`scratchpad/dynres/bench.mjs` (Perf D's bench) with a per-frame trace hook (`trace-hook.js`): every
frame the scaler sees, its interval, main-thread time and the frame probe's sections, the time
spent inside WebGPU calls (the `GPUQueue`, `GPUCanvasContext.getCurrentTexture`, command-encoder
and device entry points wrapped on their prototypes, and with `--full` every render and compute
pass-encoder call too, `setPipeline` / `setBindGroup` / `draw*` included), how much of that was in
calls over 0.25 ms, the frames in flight (`GpuBusy.pending`), display frames held back for the
in-flight limit, the completion lag and every scale decision. Headless Brave, window 1728 x 1254
at device scale 2 with the developer sidebar hidden: the 1728 x 1117 CSS canvas of a full-screen
window on the reference display (3456 x 2234 drawing buffer). (The playthrough harness's `--window
1728,1117,2` gives a 1728 x 980 canvas: the headless window's chrome takes 137 px.) Old and new
rules were compared in the same page load, alternately (`old-rule.js` puts the previous `sample`
on the page's controller), because the GPU was shared with two other agents' headless sessions
the whole time (their GPU work shows up as held frames and lag here, minute to minute).

### Findings

- **The main thread does not block in WebGPU calls** [verified]. Gas chamber, Enhanced High, every
  WebGPU call timed (`--full`): 2.0-2.5 ms a frame in all of them together (about 1500 calls,
  the timing itself included), and **no call over 0.25 ms** in any frame, at 40 % and 55 %, with
  the GPU 3 frames behind and 70 ms of completion lag. Without the pass-encoder calls: 0.8-1.1 ms.
  The 15-17 ms of main thread is real JS: three.js's render (10-12 ms: render lists, uniforms,
  encoding) and the game. Chromium's WebGPU client only serialises commands; the in-flight limit
  (Perf A) keeps the queue from backing up into the renderer.
- **What the old rule got wrong** [verified]: it called a window GPU-bound only when the main
  thread was under 80 % of the *target* interval (13.3 ms at 60 fps). The gas chamber at High
  ran 31-40 fps with 16-17 ms of main thread, frames 25-33 ms apart, 10-13 display frames per
  half second held back because three frames were still on the GPU, and completions 40-77 ms
  late. The main thread was idle a third to a half of each interval: the GPU set the rate. The old
  rule took it for CPU-bound and held 55 % at 31 fps for as long as the load lasted.
- **A mild backlog never counted as late.** At 55 % with less contention, windows ran 54-58 fps
  with 1-3 frames held and 26-33 ms of lag: a dropped frame every few (p95 33 ms), just above the
  93 % threshold.
- **CPU-bound frames look different**: Original's 3a yard with 12 ms of extra JS per frame (a
  busy loop in a frame listener, so the frame is 20-23 ms of JS: Perf A's 22 ms) runs 43-48 fps
  with no frame held and completions about one display frame late (19-25 ms), except when
  another session loads the GPU (40-47 ms of lag, still no frame held).
- `onSubmittedWorkDone` lag and frames in flight move together (2.0-2.3 in flight and 17-22 ms
  when the GPU keeps up, 2.9-3.0 and 30-77 ms when it does not); the in-flight count adds nothing
  over the held frames, which are the in-flight count at its limit.

So of the options: "JS excluding the render call" would have counted three.js's 10-12 ms of CPU
work as GPU time; "time blocked in submit / present" is zero here (kept as a safety net, below).
What separates the cases is whether the main thread waited for the GPU (held frames, lag)
and how much rate the main thread itself leaves; where that is close, a trial step down.

### The classifier (render-scale.ts `classifyWindow`, `DynamicResolution`)

Each half-second window: fps, mean interval, main-thread time, time blocked in WebGPU, lag,
held frames.

- **ok**: on target, 93 % of the rate, or 97 % while two or more frames a window are held with
  the lag over 1.6 frames (the mild backlog above).
- **cpu**: late without a backlog (no frame held, lag within 1.6 frames). Never a step down.
- **gpu**: late with a backlog, and fewer pixels would help: the JS (main thread minus time
  blocked in WebGPU) under 80 % of the target interval (the old rule), or frames held while
  the JS allows at least 8 % more than this rate (min(target, 1000 / JS) >= 1.08 fps) and takes
  under 85 % of the actual interval. Two in a row: a step down in proportion to the rate against
  what the main thread allows, sqrt(fps / min(target, 1000 / JS)) x 0.97, 5 % to 30 %. (The old
  step aimed for the target rate; with 17 ms of JS no step can go past 59 fps.)
- **mixed**: late with a backlog, but the JS is close to the rate. Three late windows with a
  backlog (not two `gpu` ones): **a trial step down**, one step. The two windows after the 1.2 s
  cooldown are compared with the three before: kept at 5 % more fps (or on target), else
  reverted, and no trial from that scale for 20 s, doubling up to 160 s (reset once a ban has been
  over for a minute). A CPU-bound frame with a lag spike costs one step for about 2 s.
- **Up** (as before: one step after 3 s with headroom, a level left within 5 s banned 20 s
  doubling to 160 s), and now also from windows that are late only because of the main thread
  (no backlog, JS over 80 % of the interval): with the GPU keeping up, pixels cost no rate, so a
  scene stepped down during a GPU spike climbs back even when it cannot reach 60.
- **Blocked time** (`GpuBusy`): `queue.submit` is timed on the device (one wrapper, a few calls
  a frame), and the part of a call over 1 ms counts as GPU time. It is 0 on this machine (above);
  it is there for a backend where submits do wait for the GPU process.

Tests (`tests/render-scale.test.ts`, "Perf E"): the classes of the traced windows (the gas
chamber, the CPU-bound yard, the mild backlog, blocked time); the gas chamber stepping 55 -> 40 %
in 1.2 s with 17 ms of main thread; a trial kept when the rate improves; a trial reverted and
banned 20 s then 40 s; a CPU-bound frame never losing resolution for good (and with a lag spike, one
trial reverted within 3 s); main-thread-bound windows probing up, vsync-rounded ones not.

### Before / after traces

Half-second windows, same page load, old rule then new (`ab2-gas.log`, `ab-gas.log`,
`ab-3a-cpu.log`, `ab-3a-enh.log`):

Gas chamber, Enhanced High, Auto (cap 55 %), one page load, old rule then new (`ab2-gas.log`;
"held": display frames per half second not drawn because three frames were on the GPU):

| rule | t | fps | main thread ms | in WebGPU calls ms | in flight | held | lag ms | scale |
|---|---|---|---|---|---|---|---|---|
| old | 0.0 s | 32.9 | 15.9 | 0.8 | 2.9 / 3 | 11 | 67 | 55 % |
| old | 1.0 s | 29.0 | 15.4 | 0.7 | 3.0 / 3 | 10 | 87 | 55 % |
| old | 3.1 s | 30.0 | 15.4 | 0.8 | 3.0 / 3 | 10 | 83 | 55 % (all 14 s: 30.7 fps, p95 50 ms) |
| new | 1.0 s | 40.7 | 15.9 | 0.8 | 2.9 / 3 | 10 | 46 | 55 % |
| new | 1.6 s | 32.9 | 15.8 | 0.9 | 3.0 / 3 | 12 | 74 | **55 -> 40 %** (two `gpu` windows after the 1.2 s hold) |
| new | 2.6 s | 48.4 | 15.9 | 0.8 | 2.7 / 3 | 6 | 30 | 40 % |
| new | 4.1 s | 50.0 | 16.1 | 0.9 | 2.6 / 3 | 5 | 31 | 40 % (all 14 s: 45.7 fps, p95 33 ms) |

There the GPU (shared with two other agents' sessions at that moment) was still behind at the
floor: 40 % is as low as it goes (1280 x 720 or 40 %). With less contention (`ab-gas.log`, second
pair) the old rule sat at 55 % with 54-58 fps and 1-5 held frames a window (p95 33 ms); the new
one stepped 55 -> 45 % on a dip to 26-50 fps and then ran 60 fps with no frame held (lag 17-19 ms)
for most of the rest. 9 at High in the table run (`tab-enh.log`): old 42.7 fps at 55 % with 17
held / s; new 55 -> 40 % after 2 s, then 58-60 fps, 0-1 held, lag 17-21 ms. In a third pair
(`ab3-gas.log`) the old rule happened to get a quiet minute (58.7 fps at 55 %) and the new one a
busy one (48 fps at 40 %, still 12 held / s at the floor): the GPU's other users decide more
than the rule there.

CPU-bound: Original's 3a yard with 12 ms of extra JS per frame (`ab-3a-cpu.log`): old rule 45.5 fps
at 100 %; new rule twice, 48.2 and 43.3 fps, 100 % at the end of both. In the second a lag spike
from another session (40-47 ms, no frame held) made three `mixed` windows: a trial 100 -> 95 %, the
rate 42.9 -> 43.3 fps, reverted 2.1 s later, and no trial for 20 s.

### Results: the six heaviest scenes on Auto

Perf A / D's scenes, default Auto, Medium and High in one Enhanced load per scene and Original in
another, rules alternating (old, new) within the load, 12 s each from the cap; fps and p95 over
the last 6 s (`tab-enh.json`, `tab-orig.json`, `table.mjs`). Two other agents' headless sessions
used the GPU throughout (load average 8-14), so each pair is minutes apart at most but not under
the same load; the held frames say how much the GPU was behind.

| Scene | Tier | old: fps / p95 ms | held / s | scale | new: fps / p95 ms | held / s | scale |
|---|---|---|---|---|---|---|---|
| 1a "Goose" | Medium | 60.0 / 16.8 | 0 | 60 % | 59.8 / 16.7 | 0.2 | 55 % |
| 1a "Goose" | High | 56.8 / 33.3 | 3.2 | 40 % | 54.5 / 33.3 | 4.8 | 40 % |
| 1a cell row | Medium | 58.5 / 16.8 | 1.5 | 50 % | 58.8 / 16.8 | 1.2 | 50 % |
| 1a cell row | High | 38.0 / 33.4 | 21.0 | 55 % | **57.2 / 16.8** | 2.8 | 40 % |
| 1a gas chamber | Medium | 34.3 / 33.4 | 23.2 | 65 % | **51.9 / 33.4** | 7.7 | 40 % |
| 1a gas chamber | High | 30.1 / 50.0 | 20.3 | 55 % | **39.8 / 33.5** | 18.5 | 40 % |
| 3a yard | Medium | 58.5 / 16.8 | 1.5 | 50 % | 59.3 / 16.7 | 0.7 | 60 % |
| 3a yard | High | 60.0 / 16.7 | 0 | 55 % | 60.0 / 16.7 | 0 | 55 % |
| 6a woods | Medium | 58.2 / 16.8 | 1.8 | 65 % | 60.0 / 16.7 | 0 | 65 % |
| 6a woods | High | 59.5 / 16.8 | 0.5 | 55 % | 60.0 / 16.8 | 0 | 50 % |
| 9 lighthouse | Medium | 43.8 / 33.3 | 4.0 | 60 % | **51.5 / 16.8** | 1.3 | 50 % |
| 9 lighthouse | High | 42.7 / 33.4 | 17.3 | 55 % | **59.3 / 16.8** | 0.7 | 40 % |
| 1a "Goose" | Original | 60.0 / 16.8 | 0 | 100 % | 60.0 / 16.8 | 0 | 100 % |
| 1a cell row | Original | 59.0 / 16.7 | 1.0 | 85 % | 59.0 / 16.8 | 1.0 | 90 % |
| 1a gas chamber | Original | 52.0 / 33.3 | 8.0 | 100 % | 56.8 / 33.3 | 3.2 | 85 % |
| 3a yard | Original | 58.0 / 16.8 | 2.0 | 90 % | 57.7 / 16.8 | 2.3 | 75 % |
| 6a woods | Original | 60.0 / 16.7 | 0 | 100 % | 58.5 / 16.8 | 1.5 | 90 % |
| 9 lighthouse | Original | 43.5 / 33.4 | 16.0 | 100 % | **59.5 / 16.8** | 0.5 | 75 % |

Every window the old rule held at its cap with frames held back had 14-18 ms of main thread
(the cell row, gas chamber and 9 at High, the gas chamber at Medium, Original's gas chamber and
9): exactly the frames it took for CPU-bound. The new rule stepped down in each, within 1.5-2.5 s,
and the main thread stayed where it was (it does not depend on the scale). Where both rules
moved (3a, 6a, the cell row in Original, the Goose), the GPU's other users made the frames late in
either; the new rule's extra steps there came back up with the probe. Original stepping below
100 % is the shared GPU: with other sessions idle it held native in Perf D. Compared with Perf D's
results the Enhanced scenes are heavier on the GPU in this tree (the gas chamber at High needed
40 % here and still had a backlog under this contention; the GPU-timestamp busy time at 40 % was
15.6 ms against 13.5 at 55 %, so a large part of it does not scale with pixels or is the other
sessions' work).

### Open

- The gas chamber at High did not reach 60 fps at the floor (40 %) while two other sessions used
  the GPU; whether it holds 60 on the user's unshared GPU is [inferred] from the quieter pair above
  (60 fps at 45 %) and Perf D (60 fps at 50 %, 9.1 ms busy). If it does not, the floor or the tier
  (Auto quality's governor steps the tier down only at the floor) is the next lever.
- The GPU-timestamp busy time in the gas chamber at High barely falls with the scale (15.6 ms at
  40 %, 13.5 at 55 %, one load): a pixel-independent cost (shadow maps, the new light volumes) or the
  other sessions' work; worth a per-pass look on a quiet GPU.
- On a real 120 Hz ProMotion display (not available headless) held frames come in 8.3 ms display
  frames, twice as many per window for the same backlog, so the 97 % rule (two or more held) is
  more sensitive there; the target stays 60. Not measured there.
- Blocked time in `queue.submit` is 0 here; a backend where submits wait would show it, but none
  was seen.
